import { randomBytes } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withFileLock } from '../src/lock.js';
import { CliError } from '../src/exit.js';

/**
 * the two lock-file wedges.
 *
 * Both had the same terminal state: an account where every ratchet, auth and
 * message-log operation waits 10 seconds and refuses, indefinitely, because
 * the stale check recognised a pid that no longer means what the token meant.
 * (1) pid reuse: a dead holder's pid recycled by a live unrelated process
 * passed kill(pid, 0) for that stranger's whole lifetime. (2) a torn token
 * write: acquisition "succeeded" with only a pid prefix on disk, release
 * could not match the fragment, and the fragment then named the writer's own
 * very-alive pid.
 *
 * Since an earlier review the lock is a DIRECTORY and a holder is a single-use
 * entry inside it, so the abandoned holder each of these recovers from is now
 * planted as an ENTRY (`plantEntry`) rather than written at `lockPath`, and
 * "the wedge is gone" is "the lock directory is empty again" rather than
 * "the file is gone" — the directory itself is the queue and is meant to
 * survive.
 *
 * The fs mock below exists because a genuine short write needs a quota or
 * device boundary that a unit test cannot conjure; everything else uses the
 * real filesystem.
 */

const ctl = vi.hoisted(() => ({ chunk: false, failWrites: false }));

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  const writeSync: typeof real.writeSync = ((
    fd: number,
    data: string | NodeJS.ArrayBufferView,
    a?: unknown,
    b?: unknown,
    c?: unknown,
  ): number => {
    if (ctl.failWrites) {
      const err = new Error('ENOSPC: fake quota boundary') as NodeJS.ErrnoException;
      err.code = 'ENOSPC';
      throw err;
    }
    if (!ctl.chunk) {
      // Passthrough: both call shapes node supports for our callers.
      return typeof data === 'string'
        ? real.writeSync(fd, data)
        : real.writeSync(fd, data, a as number, b as number, c as number | null);
    }
    // Short-write emulation: land exactly ONE byte per call, as a quota
    // boundary would, and report it honestly in the return value.
    if (typeof data === 'string') {
      return real.writeSync(fd, data.slice(0, 1));
    }
    const view = data as Uint8Array;
    const off = (a as number | undefined) ?? 0;
    const len = Math.min(1, (b as number | undefined) ?? view.byteLength - off);
    return real.writeSync(fd, view, off, len);
  }) as typeof real.writeSync;
  return { ...real, writeSync };
});

/** The implementation's own holder-name shape. Duplicated rather than
 * imported: a test that reads the rule off the code under test cannot catch
 * the code changing the rule. */
const ENTRY_RE = /^\d{12}\.[0-9a-f]{32}$/;

/** The lock's holder entries, in queue order. The dot-prefixed staging file
 * is not a holder and never appears here. */
function holderEntries(lockPath: string): string[] {
  try {
    return readdirSync(lockPath)
      .filter((name) => ENTRY_RE.test(name))
      .sort();
  } catch {
    return [];
  }
}

/** Plant another process's claim: a holder entry carrying `token`, aged
 * `ageMs` so the stale check sees what a real corpse would look like.
 * Returns the entry's name. */
function plantEntry(
  lockPath: string,
  opts: { token: string; ageMs?: number; seq?: number },
): string {
  mkdirSync(lockPath, { recursive: true, mode: 0o700 });
  const name = `${String(opts.seq ?? 1).padStart(12, '0')}.${randomBytes(16).toString('hex')}`;
  writeFileSync(join(lockPath, name), opts.token, { mode: 0o600 });
  if (opts.ageMs !== undefined) {
    const then = (Date.now() - opts.ageMs) / 1000;
    utimesSync(join(lockPath, name), then, then);
  }
  return name;
}

/** Comfortably past LOCK_STALE_MS, which is 30 seconds. */
const HOUR_MS = 3_600_000;

let dir: string;
let lockPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tacendum-lock2-'));
  lockPath = join(dir, 'ratchet.lock');
});
afterEach(() => {
  ctl.chunk = false;
  ctl.failWrites = false;
  rmSync(dir, { recursive: true, force: true });
});

function backdate(path: string): void {
  const hourAgoSec = Date.now() / 1000 - 3600;
  utimesSync(path, hourAgoSec, hourAgoSec);
}

describe('pid reuse must not authenticate a dead holder', () => {
  it('recovers a stale lock whose pid was recycled by a live process', () => {
    // Our own pid is the most certainly-alive pid there is, and the recorded
    // incarnation can never be this process's real one — exactly the state a
    // recycled pid leaves behind. Before the incarnation field, kill(pid, 0)
    // succeeding here wedged every acquisition until the stranger exited.
    plantEntry(lockPath, {
      token: `${process.pid}:not-the-writers-incarnation:${'ab'.repeat(8)}`,
      ageMs: HOUR_MS,
    });
    expect(withFileLock(lockPath, () => 'recovered')).toBe('recovered');
    // Empty, not absent: the abandoned entry was collected, ours was
    // released, and the staging file was swept. The directory stays.
    expect(readdirSync(lockPath)).toEqual([]);
  }, 20_000);

  it('treats an unverifiable recorded incarnation as dead once stale', () => {
    // A writer that could not read its own start time records '?'. Once the
    // lock is 30s past a threshold sized for millisecond holds, presuming
    // death costs at worst one steal; presuming life reintroduces the
    // unbounded wedge.
    plantEntry(lockPath, { token: `${process.pid}:?:${'cd'.repeat(8)}`, ageMs: HOUR_MS });
    expect(withFileLock(lockPath, () => 'recovered')).toBe('recovered');
    expect(readdirSync(lockPath)).toEqual([]);
  }, 20_000);

  it('still refuses to steal from the ORIGINAL live writer past the threshold', () => {
    // The overcorrection guard, and the probe-symmetry proof: a token written
    // by the real acquire, backdated while its writer (this process) lives,
    // must be honoured to the deadline. If the writer's own recording and the
    // checker's later probe ever disagree in format, this steals and fails.
    //
    // The backdating must land on the holder ENTRY. Ageing `lockPath` itself
    // says nothing now — the directory's mtime is not consulted by anything —
    // so a test that aged it would prove only that a young entry blocks.
    let err: unknown;
    try {
      withFileLock(lockPath, () => {
        const held = holderEntries(lockPath);
        expect(held).toHaveLength(1);
        backdate(join(lockPath, held[0] as string));
        withFileLock(lockPath, () => {
          throw new Error('stole the lock from a live holder');
        });
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CliError);
    expect((err as Error).message).toContain('another tacendum process');
  }, 20_000);
});

describe('a torn token write must not wedge the account', () => {
  it('recovers a stale lock holding only a pid fragment', () => {
    // The persistent form of the short-write defect: a fragment that is a
    // bare pid prefix. The old liveness check parsed the fragment's digits,
    // found a live pid, and refused recovery indefinitely.
    plantEntry(lockPath, { token: String(process.pid), ageMs: HOUR_MS });
    expect(withFileLock(lockPath, () => 'recovered')).toBe('recovered');
    expect(readdirSync(lockPath)).toEqual([]);
  }, 20_000);

  it('writes the whole token even when writeSync returns short counts', () => {
    // One byte per writeSync call, as at a quota boundary. The single
    // unlooped write left only the first byte, which release then could not
    // match — so the entry survived its own holder.
    ctl.chunk = true;
    let held: string[] = [];
    let onDisk = '';
    withFileLock(lockPath, () => {
      held = holderEntries(lockPath);
      if (held.length === 1) onDisk = readFileSync(join(lockPath, held[0] as string), 'utf8');
    });
    ctl.chunk = false;
    expect(held).toHaveLength(1);
    // Complete three-field token: pid, incarnation, 8 random bytes as hex.
    expect(onDisk).toMatch(/^\d+:[^:]+:[0-9a-f]{16}$/);
    expect(Number(onDisk.split(':')[0])).toBe(process.pid);
    // Release recognised its own token and removed the entry.
    expect(readdirSync(lockPath)).toEqual([]);
  });

  it('a failed token write surfaces as an error and leaves NO file behind', () => {
    // If the write dies the acquisition must die WITH it — the old path
    // reported "cannot take the account lock" but left the just-created file
    // sitting there as a fresh-mtime, unmatchable wedge for the next caller.
    // Nothing may remain inside the lock directory: not a holder entry, and
    // not the private staging file the doomed write was using.
    ctl.failWrites = true;
    let err: unknown;
    try {
      withFileLock(lockPath, () => 'must not run');
    } catch (e) {
      err = e;
    }
    ctl.failWrites = false;
    expect(err).toBeInstanceOf(CliError);
    expect(readdirSync(lockPath)).toEqual([]);
  });
});
