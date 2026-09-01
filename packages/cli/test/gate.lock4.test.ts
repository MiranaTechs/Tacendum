import { randomBytes } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withFileLock } from '../src/lock.js';

/**
 * An earlier review — the three ways this lock let a second writer in, or wedged
 * the account, when a syscall failed instead of a process dying.
 *
 * Every earlier round tightened the verdict the lock forms about OTHER
 * processes. These three are about what the lock does when it cannot see:
 *
 *  L1 a doorway was judged "young AND alive", with age as an early return, so
 *     a door older than DOOR_MAX_MS was walked past and DELETED however alive
 *     its writer was — reinstating verbatim the two-process ticket race the
 *     doorway was added to close.
 *  L2 `readdirSync` failing (EMFILE at the descriptor ceiling, EACCES on a
 *     directory an operator chmod'ed) was reported as an EMPTY directory, and
 *     "empty" is licence to proceed. It is also correlated: at the fd ceiling
 *     the liveness probe's readFileSync and its `ps` spawn fail too, so every
 *     guard fails toward "enter" at the same instant.
 *  L3 `release` opened its own entry to re-verify it and returned WITHOUT
 *     unlinking on any error — but openSync throws EMFILE, not ENOENT, at the
 *     descriptor ceiling, so a long-lived daemon left its own live-pid entry
 *     behind and then blocked on it for the rest of its life.
 *
 * The failures are injected through the fs seam because a real descriptor
 * ceiling is not conjurable in a unit test, and because a permission flip
 * races the assertion. The INJECTION is coupled to the syscalls acquisition
 * makes; the ASSERTIONS are outcomes — did a second holder get in, was the
 * account left wedged, was a live door respected.
 */

const ctl = vi.hoisted(() => ({
  /** Fail the next `readdirSync` once, as EMFILE does at the fd ceiling. */
  failReaddirOnce: false,
  /** Fail every `readdirSync` until this wall-clock instant — the sustained
   * form: an fd ceiling a fan-out sits at for a while, or a directory an
   * operator chmod'ed and then put back. */
  failReaddirUntil: 0,
  /** Fail every `openSync(_, 'r')`, as EMFILE does. Staging ('wx') is left
   * alone so acquisition still gets far enough to have something to release. */
  failReadOpens: false,
  /** Unlink this path from inside the next `readdirSync` taken at or after
   * `unblockAt`. The lock's wait loop blocks the thread with Atomics.wait, so
   * a JS timer can never fire during acquisition — the fs seam is the only
   * clock the test can act on. */
  unblockPath: null as string | null,
  unblockAt: 0,
  /** Fired with the name of each HOLDER ENTRY as it is published. */
  afterEntryLink: null as ((name: string) => void) | null,
  /** Run ONCE, immediately after the first `readdirSync` that can already see
   * a published holder entry — i.e. after the FIRST of the two reads the
   * decision loop makes. The read that triggers it returns the directory as it
   * was; only the read after it sees whatever this planted. That is the whole
   * apparatus for L4, which is about which of those two reads happens first. */
  afterFirstDecisionRead: null as (() => void) | null,
}));

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  const entryRe = /^\d{12}\.[0-9a-f]{32}$/;
  const readdirSync: typeof real.readdirSync = ((path: string, opts?: unknown) => {
    if (ctl.unblockPath !== null && Date.now() >= ctl.unblockAt) {
      real.rmSync(ctl.unblockPath, { force: true });
      ctl.unblockPath = null;
    }
    if (ctl.failReaddirOnce || Date.now() < ctl.failReaddirUntil) {
      ctl.failReaddirOnce = false;
      const err = new Error('EMFILE: too many open files') as NodeJS.ErrnoException;
      err.code = 'EMFILE';
      throw err;
    }
    const out = real.readdirSync(path, opts as never);
    if (
      ctl.afterFirstDecisionRead !== null &&
      (out as unknown as string[]).some((n) => entryRe.test(String(n)))
    ) {
      const fire = ctl.afterFirstDecisionRead;
      ctl.afterFirstDecisionRead = null;
      fire(); // the CALLER still gets `out`, taken before this ran
    }
    return out;
  }) as typeof real.readdirSync;
  const openSync: typeof real.openSync = ((path: string, flags: unknown, mode?: unknown) => {
    if (ctl.failReadOpens && flags === 'r') {
      const err = new Error('EMFILE: too many open files') as NodeJS.ErrnoException;
      err.code = 'EMFILE';
      throw err;
    }
    return real.openSync(path, flags as never, mode as never);
  }) as typeof real.openSync;
  const linkSync: typeof real.linkSync = (src, dst) => {
    real.linkSync(src, dst);
    const name = String(dst).split('/').pop() ?? '';
    if (entryRe.test(name)) ctl.afterEntryLink?.(name);
  };
  return { ...real, readdirSync, openSync, linkSync };
});

/** The implementation's own name shapes, duplicated rather than imported: a
 * test that reads the rule off the code under test cannot catch the code
 * changing the rule. */
const ENTRY_RE = /^\d{12}\.[0-9a-f]{32}$/;
const DOOR_RE = /^\.door\.[0-9a-f]{32}$/;

function holderEntries(lockPath: string): string[] {
  try {
    return readdirSync(lockPath).filter((n) => ENTRY_RE.test(n)).sort();
  } catch {
    return [];
  }
}
function doors(lockPath: string): string[] {
  try {
    return readdirSync(lockPath).filter((n) => DOOR_RE.test(n));
  } catch {
    return [];
  }
}

/** Plant another process's claim by hand. */
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

/** A door belonging to a process that is unquestionably alive: this one. The
 * two-part `pid:hex` form is the legacy token lock.ts still honours, which
 * keeps the test independent of how an incarnation is spelled on this host. */
function plantDoor(lockPath: string, ageMs: number): string {
  mkdirSync(lockPath, { recursive: true, mode: 0o700 });
  const name = `.door.${randomBytes(16).toString('hex')}`;
  writeFileSync(join(lockPath, name), `${process.pid}:deadbeef`, { mode: 0o600 });
  const then = (Date.now() - ageMs) / 1000;
  utimesSync(join(lockPath, name), then, then);
  return name;
}

let dir: string;
let lockPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tacendum-lock4-'));
  lockPath = join(dir, 'ratchet.lock');
});
afterEach(() => {
  ctl.failReaddirOnce = false;
  ctl.failReaddirUntil = 0;
  ctl.failReadOpens = false;
  ctl.unblockPath = null;
  ctl.unblockAt = 0;
  ctl.afterEntryLink = null;
  ctl.afterFirstDecisionRead = null;
  rmSync(dir, { recursive: true, force: true });
});

describe('L1 — a doorway held by a LIVE process is not walked past', () => {
  it('waits for a live door that is older than the door window', () => {
    // The door window bounds a CORPSE, not a live claimant. A door six
    // seconds old whose writer is alive means a claimant that has read the
    // queue and not yet published — enter now and both of you take the same
    // ticket, which is the ~6%-of-trials two-writer race the doorway exists
    // to close. Before the fix the age test was an early return, so this
    // door was walked past in about a millisecond and then deleted.
    mkdirSync(lockPath, { recursive: true, mode: 0o700 });
    const door = plantDoor(lockPath, 6_000);
    ctl.unblockPath = join(lockPath, door);
    ctl.unblockAt = Date.now() + 250;
    const started = Date.now();
    expect(withFileLock(lockPath, () => 'ran')).toBe('ran');
    const waited = Date.now() - started;
    expect(waited, 'entered while a live claimant was still inside its doorway').toBeGreaterThanOrEqual(200);
    expect(readdirSync(lockPath)).toEqual([]);
  }, 20_000);
});

describe('L2 — an unreadable directory is not an empty one', () => {
  it('does not enter beside a live holder when the queue read fails', () => {
    // The fd-ceiling repro. H holds ticket 5 and is young, so it blocks. C's
    // first queue read fails; reading that as "empty" made C take ticket 1,
    // which sorts BELOW H — so nothing was ahead of C and C entered beside
    // the holder. Two processes inside one Double Ratchet read-modify-write.
    const holder = plantEntry(lockPath, { token: `${process.pid}:deadbeef`, seq: 5 });
    ctl.unblockPath = join(lockPath, holder);
    ctl.unblockAt = Date.now() + 250;
    ctl.failReaddirOnce = true;
    let besideMe: string[] = [];
    withFileLock(lockPath, () => {
      besideMe = holderEntries(lockPath).filter((n) => n !== holder);
    });
    expect(ctl.failReaddirOnce, 'the read failure was never injected').toBe(false);
    // The holder was gone before we entered: we waited it out rather than
    // stepping past it on the strength of a read that failed.
    expect(holderEntries(lockPath)).toEqual([]);
    expect(besideMe, 'entered the critical section beside a live holder').toHaveLength(1);
    expect(readdirSync(lockPath)).toEqual([]);
  }, 20_000);

  it('re-queues under a FRESH name, so a stale verdict cannot follow it', () => {
    // A ticket name is single-use precisely so that a verdict formed about it
    // ("that entry is abandoned, collect it") can never be applied to a
    // different file. Re-queueing under the ORIGINAL nonce breaks that: the
    // process that judged our first entry dead unlinks the name, and the name
    // is now our live re-queued entry. Injected here as a collector that goes
    // on applying its stale verdict — with a reused nonce the claimant is
    // deleted every round and never acquires; with a fresh one the stale
    // unlink hits nothing.
    let first = '';
    ctl.afterEntryLink = (name) => {
      if (first === '') {
        first = name;
        rmSync(join(lockPath, name), { force: true }); // collected as abandoned
        return;
      }
      rmSync(join(lockPath, first), { force: true }); // the same verdict, re-applied
    };
    expect(withFileLock(lockPath, () => 'ran')).toBe('ran');
    expect(first, 'the collector never fired').not.toBe('');
    expect(readdirSync(lockPath)).toEqual([]);
  }, 20_000);

  it('leaves no door and no ticket behind when reads fail throughout', () => {
    // The leak this pins was measured at 197 `.door.*` files from a single
    // acquisition: two `continue` paths re-entered the ticket branch and
    // overwrote `doorName` without closing the door. Harmless while a dead
    // door blocked nobody — and an account-lifetime wedge the moment a LIVE
    // door blocks, because every one of those doors belongs to a live process.
    //
    // The same window pins the orphan: reading [] made the claimant publish
    // ticket 1, lose sight of it, and re-queue under the SAME nonce against
    // its own still-present file — EEXIST forever — leaving an entry carrying
    // its own live token behind when it finally refused.
    ctl.failReaddirUntil = Date.now() + 300;
    expect(withFileLock(lockPath, () => 'ran')).toBe('ran');
    expect(doors(lockPath), 'doors leaked by a re-queue').toEqual([]);
    expect(readdirSync(lockPath)).toEqual([]);
  }, 20_000);
});

describe('L3 — release unlinks its entry even when nothing can be opened', () => {
  it('does not strand its own live-pid entry at the descriptor ceiling', () => {
    // openSync throws EMFILE, not ENOENT, when a `listen` daemon hits its
    // descriptor ceiling. Release read that as "not provably ours, leave it",
    // and the entry it left carried the daemon's own live pid and matching
    // incarnation — so every later acquisition, its own included, blocked on
    // it for the life of the process. Only `rm -rf` cleared it.
    ctl.failReadOpens = true;
    expect(withFileLock(lockPath, () => 'ran')).toBe('ran');
    ctl.failReadOpens = false;
    expect(readdirSync(lockPath), 'release stranded its own entry').toEqual([]);
  });
});

describe('L4 — the doors are read BEFORE the queue', () => {
  it('does not enter when a claimant ahead of it publishes between the two reads', () => {
    // Lamport checks `choosing[]` BEFORE comparing tickets, and this loop had
    // it the other way round. The window is real but unhittable by luck: a
    // racer must publish and close its door strictly between our queue read
    // and our doors read, which on this machine never once happened across
    // hundreds of two-process trials. So the interleaving is constructed
    // instead, through the fs seam — the only clock available, since the wait
    // loop blocks the thread with Atomics.wait.
    //
    // `afterFirstDecisionRead` fires just after the FIRST of the loop's two
    // reads and plants a claimant that is ahead of us (the all-zero nonce
    // sorts below any real one) and alive. That models T having published and
    // closed its door in the gap.
    //
    //   doors-first (correct): read 1 is doors -> none open; read 2 is the
    //     queue -> T is there, ahead, and live -> we wait, then refuse.
    //   queue-first (the bug): read 1 is the queue -> T not there yet, nothing
    //     ahead; read 2 is doors -> T is an ENTRY, not a door, so none open
    //     -> we enter beside T.
    //
    // The assertion is therefore "refuses" — entering at all is the defect.
    mkdirSync(lockPath, { recursive: true, mode: 0o700 });
    let planted = '';
    ctl.afterFirstDecisionRead = () => {
      planted = `${'0'.repeat(12 - 1)}1.${'0'.repeat(32)}`;
      writeFileSync(join(lockPath, planted), `${process.pid}:deadbeef`, { mode: 0o600 });
    };

    let entered = false;
    expect(() =>
      withFileLock(lockPath, () => {
        entered = true;
      }),
    ).toThrow(/is held/);

    expect(planted, 'the seam never fired — this test proved nothing').not.toBe('');
    expect(
      entered,
      'entered the critical section beside a claimant that published between the two reads',
    ).toBe(false);
    // And it must not have collected the live claimant on its way out.
    expect(holderEntries(lockPath)).toContain(planted);
  }, 30_000);
});
