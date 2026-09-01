/**
 * Atomic writes were not DURABLE, and the identity path made
 * that a brick. Registration wrote identity.json (temp + rename), uploaded the
 * public half, and reported success with the private key still in the page
 * cache and the rename only in in-memory directory metadata. A power cut in
 * that window erases the only copy of a key the server now holds immutably:
 * the account exists and nothing can ever prove
 * it again.
 *
 * A test cannot pull the power cord, so this one asserts the syscalls that
 * close the window: fsync of the temp file's DATA before the rename publishes
 * it, and fsync of the DIRECTORY after, because a rename lives in directory
 * metadata. `node:fs` is wrapped (not replaced — every call still hits the
 * real filesystem) so the assertions are about what the production code
 * actually asked the kernel to persist, in the order it asked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IdentityKeyPair, PreKeyRecord, PrivateKey } from '@signalapp/libsignal-client';
import { FileStores, writeFileAtomic } from '../src/stores.js';

const state = vi.hoisted(() => ({
  /** fd → path, recorded at open. Resolved AT FSYNC TIME, never after the
   * fact: the kernel reuses fd numbers the moment one closes, and the temp
   * file's fd is closed before the directory is opened, so a post-hoc lookup
   * reports every fsync as the directory. */
  fdPaths: new Map<number, string>(),
  /** What the production code asked the kernel to persist, in order. */
  events: [] as { op: 'fsync' | 'rename'; path: string }[],
  /** When set, fsync of a DIRECTORY fd throws this errno instead of running. */
  dirFsyncError: undefined as string | undefined,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    openSync: vi.fn((...args: Parameters<typeof actual.openSync>) => {
      const fd = actual.openSync(...args);
      state.fdPaths.set(fd, String(args[0]));
      return fd;
    }),
    fsyncSync: vi.fn((fd: number) => {
      state.events.push({ op: 'fsync', path: state.fdPaths.get(fd) ?? '<unknown fd>' });
      if (state.dirFsyncError !== undefined && actual.fstatSync(fd).isDirectory()) {
        throw Object.assign(new Error(`${state.dirFsyncError}: simulated, fsync`), {
          code: state.dirFsyncError,
        });
      }
      actual.fsyncSync(fd);
    }),
    renameSync: vi.fn((...args: Parameters<typeof actual.renameSync>) => {
      state.events.push({ op: 'rename', path: String(args[1]) });
      actual.renameSync(...args);
    }),
  };
});

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'tacendum-durability-'));
  process.env.TACENDUM_HOME = home;
  state.fdPaths.clear();
  state.events.length = 0;
  state.dirFsyncError = undefined;
});
afterEach(() => {
  delete process.env.TACENDUM_HOME;
  rmSync(home, { recursive: true, force: true });
});

describe('identity state is durable before registration can succeed', () => {
  it("fsyncs identity.json's data and its directory, bracketing the rename", () => {
    const stores = new FileStores('bot');
    state.events.length = 0;

    stores.identity.initialize(IdentityKeyPair.generate(), 1234);

    const identityPath = join(stores.root, 'identity.json');
    // The staging name carries a RANDOM suffix (gate.atomic-write-plant), so
    // the temp is matched by prefix and .tmp, never reconstructed.
    const isTmpOf = (target: string, p: string): boolean =>
      p.startsWith(`${target}.`) && p.endsWith('.tmp');
    // The private key's BYTES reached the disk...
    const dataAt = state.events.findIndex((e) => e.op === 'fsync' && isTmpOf(identityPath, e.path));
    expect(dataAt).toBeGreaterThanOrEqual(0);
    // ...and so did the directory entry that makes them identity.json.
    const dirAt = state.events.findIndex((e) => e.op === 'fsync' && e.path === stores.root);
    expect(dirAt).toBeGreaterThanOrEqual(0);

    // Order is the fix: data before the rename publishes it (a rename of an
    // unsynced temp can survive a crash as a ZERO-LENGTH identity.json, which
    // `exists()` then treats as an account, refusing ever to re-register),
    // and the directory after, so the rename itself is what's persisted.
    const renameAt = state.events.findIndex((e) => e.op === 'rename' && e.path === identityPath);
    expect(renameAt).toBeGreaterThanOrEqual(0);
    expect(dataAt).toBeLessThan(renameAt);
    expect(dirAt).toBeGreaterThan(renameAt);
  });

  it('keeps the atomic-rename contract intact: content, mode, no temp debris', () => {
    const stores = new FileStores('bot');
    stores.identity.initialize(IdentityKeyPair.generate(), 1234);

    const identityPath = join(stores.root, 'identity.json');
    const record = JSON.parse(readFileSync(identityPath, 'utf8')) as { registrationId: number };
    expect(record.registrationId).toBe(1234);
    // Owner-only, set on the temp so no post-rename chmod window exists.
    expect(statSync(identityPath).mode & 0o777).toBe(0o600);
    expect(readdirSync(stores.root).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });
});

describe('the prekey batch durability contract', () => {
  it('the high-water mark is durable — its rollback reissues consumed ids', () => {
    // `savePreKey` leans on this write NOT taking its crash-consistent
    // shortcut: a rolled-back mark hands a consumed id out again under a new
    // key (an earlier review, F1), and unlike a lost prekey file that never
    // heals — the allocator trusts the mark forever.
    const stores = new FileStores('bot');
    state.events.length = 0;

    stores.prekeys.advanceTo(101);

    const dir = join(stores.root, 'prekeys');
    const markPath = join(dir, 'next-id.json');
    // Random staging suffix: match the temp by prefix, not by reconstruction.
    expect(
      state.events.some(
        (e) => e.op === 'fsync' && e.path.startsWith(`${markPath}.`) && e.path.endsWith('.tmp'),
      ),
    ).toBe(true);
    expect(state.events).toContainEqual({ op: 'fsync', path: dir });
  });

  it('savePreKey stays atomic but takes the argued crash-consistent shortcut', async () => {
    // The absence assertion is deliberate. Registration mints 100 of these,
    // a durable write costs 10-40ms of F_FULLFSYNC, and flipping this back
    // to durable does not fail anything loudly — it resurfaces as 70-second
    // stores-heavy suites flaking against the 15s testTimeout and a starved
    // worker RPC, on someone else's screen. This makes that change
    // deliberate instead of incidental; the argument lives on `savePreKey`.
    const stores = new FileStores('bot');
    state.events.length = 0;

    const priv = PrivateKey.generate();
    await stores.prekeys.savePreKey(7, PreKeyRecord.new(7, priv.getPublicKey(), priv));

    const target = join(stores.root, 'prekeys', '7.bin');
    // Atomic contract intact: published by rename, no temp debris...
    expect(state.events).toContainEqual({ op: 'rename', path: target });
    expect(readdirSync(join(stores.root, 'prekeys')).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    // ...and no fsync of the key file or its directory.
    expect(state.events.filter((e) => e.op === 'fsync')).toEqual([]);
  });
});

describe('directory fsync failure handling', () => {
  it('EINVAL from a filesystem that cannot fsync directories is not a write failure', () => {
    // Some filesystems refuse directory fsync outright; the data fsync already
    // succeeded, so failing the write here would trade durability for an
    // outage on those mounts.
    state.dirFsyncError = 'EINVAL';
    const target = join(home, 'probe.json');
    expect(() => writeFileAtomic(target, '{"ok":true}')).not.toThrow();
    expect(readFileSync(target, 'utf8')).toBe('{"ok":true}');
  });

  it('EIO from the directory fsync propagates — the rename may not have survived', () => {
    state.dirFsyncError = 'EIO';
    expect(() => writeFileAtomic(join(home, 'probe.json'), 'x')).toThrow(/EIO/);
  });
});
