/**
 * An earlier review — four release-blockers in the prekey/durability subsystem, three of them
 * defects in fixes from earlier rounds.
 *
 *  1. Pruning trusted LOCAL generation count as evidence about the SERVER
 *     pool: a rotation that fails before `PUT /v1/keys` advances local
 *     generations while the server's pool is unchanged, so the id window
 *     walked past keys the server was advertising and deleted their private
 *     halves — a valid message then decrypt-fails and is acked away.
 *  2. `savePreKey`'s crash-consistent shortcut left uploaded batches
 *     non-durable: a power cut could keep the durable high-water mark and
 *     the server upload while dropping the private files, poisoning every
 *     bundle the server hands out.
 *  3. Syncing identity.json and its immediate directory did not persist the
 *     entries for the freshly `mkdir -p`'d chain above it, and quirk errnos
 *     from the directory fsync were swallowed — an unverified identity
 *     commit reported success, and a lost identity key is a permanently
 *     bricked account.
 *  4. An fsync failure inside a store callback surfaces from libsignal
 *     wrapped in LibSignalErrorBase, which the inbound path classified as
 *     tamper — acking away the server's copy of a valid message because OUR
 *     disk hiccuped.
 *
 * A test cannot pull the power cord, so — like gate.stores-durability —
 * `node:fs` and `node:fs/promises` are WRAPPED (never replaced; every call
 * still reaches the real filesystem) and the assertions are about what the
 * production code asked the kernel to persist, and about what it refuses to
 * report success on.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { IdentityKeyPair, PreKeyRecord, PrivateKey } from '@signalapp/libsignal-client';
import { FileStores, writeFileAtomic } from '../src/stores.js';
import { loadOrGenerateKeys, signAuthChallenge } from '../src/messaging.js';

const state = vi.hoisted(() => ({
  /** fd → path, recorded at open and resolved AT FSYNC TIME (fd numbers are
   * reused the moment one closes). */
  fdPaths: new Map<number, string>(),
  /** Synchronous fsyncs the production code asked for, in order. */
  events: [] as { op: 'fsync'; path: string }[],
  /** Paths whose FileHandle.sync() (fs/promises) was awaited. */
  syncedPaths: [] as string[],
  /** When set, fsync of a DIRECTORY fd throws this errno instead of running. */
  dirFsyncError: undefined as string | undefined,
  /** When set, fsync of a FILE fd throws this errno instead of running. */
  fileFsyncError: undefined as string | undefined,
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
      const isDir = actual.fstatSync(fd).isDirectory();
      if (state.dirFsyncError !== undefined && isDir) {
        throw Object.assign(new Error(`${state.dirFsyncError}: simulated, fsync`), {
          code: state.dirFsyncError,
        });
      }
      if (state.fileFsyncError !== undefined && !isDir) {
        throw Object.assign(new Error(`${state.fileFsyncError}: simulated, fsync`), {
          code: state.fileFsyncError,
        });
      }
      actual.fsyncSync(fd);
    }),
  };
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: (async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const path = String(args[0]);
      const realSync = handle.sync.bind(handle);
      handle.sync = async () => {
        await realSync(); // real fsync FIRST — only a completed one is recorded
        state.syncedPaths.push(path);
      };
      return handle;
    }) as typeof actual.open,
  };
});

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'tacendum-pkdur-'));
  process.env.TACENDUM_HOME = home;
  state.fdPaths.clear();
  state.events.length = 0;
  state.syncedPaths.length = 0;
  state.dirFsyncError = undefined;
  state.fileFsyncError = undefined;
});
afterEach(() => {
  delete process.env.TACENDUM_HOME;
  rmSync(home, { recursive: true, force: true });
});

describe('local rotations never license deleting older private halves', () => {
  it('keys survive three failed-upload rotations plus a fourth', async () => {
    // The killer step in the finding: a registration can rotate LOCALLY and
    // fail before `PUT /v1/keys`, leaving the server advertising generation
    // 1. Locally that is indistinguishable from three successful uploads —
    // which is exactly why generation counting was not evidence. Under the
    // old window (3 generations kept), the fourth rotation set keepFrom past
    // generation 1 and unlinked ids the server was handing out that moment.
    const stores = new FileStores('bot');
    const first = await loadOrGenerateKeys(stores);
    for (let run = 0; run < 3; run++) await loadOrGenerateKeys(new FileStores('bot'));

    const held = new FileStores('bot').prekeys.ids();
    for (const p of first.oneTimePrekeys) expect(held).toContain(p.keyId);
  });
});

describe('a batch is durable before its public halves can be advertised', () => {
  it('registration fsyncs every minted private half, and the directory once', async () => {
    const stores = new FileStores('bot');
    const keys = await loadOrGenerateKeys(stores);

    // Every id in the payload the upload will publish had its private half's
    // DATA flushed before `loadOrGenerateKeys` resolved (the upload runs
    // strictly after it, under the same register.lock)...
    const dir = join(stores.root, 'prekeys');
    for (const p of keys.oneTimePrekeys) {
      expect(state.syncedPaths).toContain(join(dir, `${p.keyId}.bin`));
    }
    // ...and the directory entries that NAME them survived too —
    // `savePreKey`'s shortcut skips the per-file rename fsync, so the one
    // batch-level directory fsync is what makes the files findable after a
    // crash.
    expect(state.events).toContainEqual({ op: 'fsync', path: dir });
  });

  it('a returning rotation flushes its fresh batch the same way', async () => {
    const first = new FileStores('bot');
    await loadOrGenerateKeys(first);
    state.syncedPaths.length = 0;

    const stores = new FileStores('bot');
    const keys = await loadOrGenerateKeys(stores);
    const dir = join(stores.root, 'prekeys');
    for (const p of keys.oneTimePrekeys) {
      expect(state.syncedPaths).toContain(join(dir, `${p.keyId}.bin`));
    }
  });

  it('refuses to vouch for a batch file that is not on disk', async () => {
    // The flush doubles as verification: if a private half cannot be opened
    // and fsynced, registration must fail BEFORE the upload advertises its
    // id — an advertised key with no private half is the acked-away-message
    // loss this exists to prevent.
    const stores = new FileStores('bot');
    await expect(stores.prekeys.persistBatch([424242])).rejects.toThrow();
  });
});

describe('the identity commit is verified all the way up the tree', () => {
  it('fsyncs every ancestor directory up to the filesystem root', () => {
    // Registration `mkdir -p`s `$TACENDUM_HOME/<name>/`. identity.json's own
    // directory fsync does not persist the ENTRY for that new directory in
    // $TACENDUM_HOME, nor any recursively created ancestor's — a power cut
    // could drop the whole tree around a durable file. The walk is
    // unconditional because the dirs may have been created by an earlier
    // PROCESS whose writeback has not happened yet.
    const stores = new FileStores('bot');
    state.events.length = 0;
    stores.identity.initialize(IdentityKeyPair.generate(), 1234);

    const synced = state.events.map((e) => e.path);
    for (let dir = stores.root; ; dir = dirname(dir)) {
      expect(synced).toContain(dir);
      if (dir === dirname(dir)) break; // filesystem root
    }
  });

  it('a swallowed directory-fsync quirk no longer reports success', () => {
    // EINVAL is the quirk errno the old code treated as benign for EVERY
    // write. For identity.json that converted an UNVERIFIABLE commit into a
    // reported success — and the identity key is immutable server-side, so
    // the loss it gambles is a permanently bricked account. Strict now:
    // refuse loudly on a filesystem that cannot verify.
    state.dirFsyncError = 'EINVAL';
    const stores = new FileStores('bot');
    expect(() => stores.identity.initialize(IdentityKeyPair.generate(), 1234)).toThrow(/EINVAL/);

    // And the refused commit must not linger: `exists()` gates registration,
    // so a leftover file would make the RETRY silently adopt the very commit
    // this attempt refused to vouch for.
    expect(stores.identity.exists()).toBe(false);
  });

  it('ordinary durable writes keep the lenient quirk policy', () => {
    // The strictness is scoped to the one unrecoverable write. Failing every
    // seen.json write over a filesystem quirk would turn the durability
    // upgrade into a receive-path outage (gate.stores-durability pins the
    // same policy from the other side).
    state.dirFsyncError = 'EINVAL';
    expect(() => writeFileAtomic(join(home, 'probe.json'), 'x')).not.toThrow();
  });
});

describe('retiring the unpublished-batch marker is verified durable', () => {
  it('is verified without fsyncing a directory', async () => {
    // ADDED at an earlier revision. The retirement is the ONE write standing between a
    // power cut and a resurrected marker, and a resurrected marker tells the
    // next rotation to re-offer ids the server is handing out that very
    // moment — two senders, one one-time prekey, and the loser's message is
    // acked away as tamper. It used to ask `writeFileAtomic(..., 'durable')`
    // for that guarantee, i.e. a rename whose directory fsync `fsyncDir`
    // SWALLOWS on EINVAL/EPERM/ENOTSUP/EISDIR — so on such a filesystem the
    // retirement was accepted unverified.
    //
    // 'durable-verified' would have refused every auth, renewals included, on
    // those filesystems. So the rename is gone instead: the marker's content
    // is overwritten IN PLACE and the FILE is fsynced, which needs nothing
    // from the directory and cannot be swallowed.
    const marker = join(new FileStores('bot').root, 'prekeys-unpublished.json');
    await loadOrGenerateKeys(new FileStores('bot')); // first run: generate
    await loadOrGenerateKeys(new FileStores('bot')); // returning: rotate, writes the marker

    state.dirFsyncError = 'EINVAL';
    state.events.length = 0;
    state.syncedPaths.length = 0;
    await signAuthChallenge(
      new FileStores('bot'),
      Buffer.from('r7').toString('base64'),
      'https://api.test',
    );

    // A quirk filesystem cannot make this fail, because nothing was asked of
    // the directory...
    expect(state.events).toContainEqual({ op: 'fsync', path: marker });
    expect(state.events.filter((e) => e.path === dirname(marker))).toEqual([]);
    // ...and the retirement really landed.
    expect(readFileSync(marker, 'utf8')).toBe('[]');
  });

  it('a marker fsync that fails refuses the signature — fail-closed before apiAuth', async () => {
    // The other half: an unverifiable retirement must not be reported as one.
    // A throw here aborts the attempt BEFORE `POST /v1/auth`, so no token
    // exists and the still-marked batch cannot have been uploaded.
    await loadOrGenerateKeys(new FileStores('bot'));
    await loadOrGenerateKeys(new FileStores('bot'));

    state.fileFsyncError = 'EIO';
    await expect(
      signAuthChallenge(
        new FileStores('bot'),
        Buffer.from('r7').toString('base64'),
        'https://api.test',
      ),
    ).rejects.toThrow(/EIO/);
  });
});

describe('a persistence failure is distinguishable from tamper', () => {
  it('records an fsync EIO and hands it over exactly once', () => {
    // libsignal wraps a store callback's throw in LibSignalErrorBase, so the
    // inbound path cannot see WHAT failed — `err instanceof CliError` is
    // false and the tamper branch acks away the server's only copy. The
    // sentinel is the side channel: consumed before a decrypt (discarding
    // stale state), checked after a failed one.
    const stores = new FileStores('bot');
    state.fileFsyncError = 'EIO';
    stores.takePersistenceFailure(); // discard anything stale

    expect(() => writeFileAtomic(join(stores.root, 'probe.bin'), 'x')).toThrow(/EIO/);

    const failure = stores.takePersistenceFailure();
    expect(failure).toBeInstanceOf(Error);
    expect((failure as NodeJS.ErrnoException).code).toBe('EIO');
    // Consumed: a later REAL tamper must not inherit this record.
    expect(stores.takePersistenceFailure()).toBeNull();
  });

  it('a clean write records nothing', () => {
    const stores = new FileStores('bot');
    stores.takePersistenceFailure();
    writeFileAtomic(join(stores.root, 'probe.bin'), 'x');
    expect(stores.takePersistenceFailure()).toBeNull();
  });

  it('an unlink failure during prekey consumption is recorded too', async () => {
    // libsignal deletes the used one-time prekey INSIDE a prekey decrypt; an
    // EPERM there wraps into LibSignalErrorBase exactly like the fsync case.
    if (process.getuid?.() === 0) return; // root ignores directory modes
    const stores = new FileStores('bot');
    const priv = PrivateKey.generate();
    await stores.prekeys.savePreKey(9, PreKeyRecord.new(9, priv.getPublicKey(), priv));

    const dir = join(stores.root, 'prekeys');
    chmodSync(dir, 0o500); // unlink needs write permission on the directory
    try {
      stores.takePersistenceFailure();
      await expect(stores.prekeys.removePreKey(9)).rejects.toThrow();
      expect(stores.takePersistenceFailure()).toBeInstanceOf(Error);
    } finally {
      chmodSync(dir, 0o700);
    }
  });
});
