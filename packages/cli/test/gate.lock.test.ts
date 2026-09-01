import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LOCK_TIMINGS, tryFileLockAsync, withFileLock, withFileLockAsync } from '../src/lock.js';
import { CliError } from '../src/exit.js';

/**
 * the cross-process ratchet lock.
 *
 * Two of these use REAL child processes, because the property under test is
 * mutual exclusion between processes and an in-process test of it would prove
 * nothing: a single Node process serializes itself anyway.
 *
 * `lockPath` is a DIRECTORY. A holder is a single-use entry inside it, named
 * `<12-digit seq>.<32-hex nonce>`; the dot-prefixed staging file is not one.
 * So "the lock is held" stopped being "the path exists" — the directory is
 * the waiting room and outlives every holder by design — and became "a holder
 * entry is present", which is what `holderEntries` reports. Assertions that
 * used to say `existsSync(lockPath)` say that instead; an `existsSync` here
 * now distinguishes nothing and would be a test that tests nothing.
 */

/** The implementation's own holder-name shape. Duplicated rather than
 * imported because a test that reads the rule off the code under test cannot
 * catch the code changing the rule. */
const ENTRY_RE = /^\d{12}\.[0-9a-f]{32}$/;

/** The lock's holder entries, in queue order. */
function holderEntries(lockPath: string): string[] {
  try {
    return readdirSync(lockPath)
      .filter((name) => ENTRY_RE.test(name))
      .sort();
  } catch {
    return []; // no directory: nobody holds it
  }
}

/**
 * Put a holder in the queue by hand — the stand-in for another process's
 * claim. `ageMs` backdates the entry's mtime, which is how the implementation
 * separates a holder it merely cannot inspect from an abandoned one. Returns
 * the entry's name.
 */
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

/** Comfortably past LOCK_STALE_MS, whatever it currently is. */
const HOUR_MS = 3_600_000;

let dir: string;
let lockPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tacendum-lock-'));
  lockPath = join(dir, 'ratchet.lock');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('withFileLock', () => {
  it('releases on success and on throw', () => {
    // The directory is the queue and is meant to persist; the HOLDER ENTRY is
    // the claim, and no claim may outlive the call that made it.
    withFileLock(lockPath, () => 'ok');
    expect(holderEntries(lockPath)).toEqual([]);

    expect(() =>
      withFileLock(lockPath, () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(holderEntries(lockPath)).toEqual([]);
  });

  it('refuses rather than corrupting when a LIVE holder never lets go', () => {
    // A fresh entry nobody releases, written by a process that certainly
    // EXISTS: the waiter must give up with a message naming the lock, not
    // proceed into an unserialized read-modify-write.
    //
    // THE TOKEN USED TO BE `999999` — a pid nothing wears — which made this a
    // test of a CORPSE, and it passed only because the waiter's 10-second
    // budget expired before the 30-second staleness threshold it was waiting
    // for. That is the unreachable-orphan-recovery bug, asserted as the
    // desired behaviour: with the budget now longer than the threshold, a dead
    // holder is correctly recovered and only a LIVE one still refuses. Our own
    // pid is the most certainly-alive one there is.
    plantEntry(lockPath, { token: `${process.pid}:deadbeef` });
    let err: unknown;
    try {
      withFileLock(lockPath, () => 'never runs');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).message).toContain(lockPath);
  }, 30_000);

  it('does NOT steal a stale-looking lock whose owner is still alive', () => {
    // A slept laptop, a breakpoint, or a loaded machine can hold the lock past
    // the threshold while very much alive. Stealing then puts two processes
    // inside the same ratchet read-modify-write — the corruption the lock
    // exists to prevent. Our OWN pid is the most certainly-alive one there is.
    const alive = plantEntry(lockPath, {
      token: `${process.pid}:deadbeef`,
      ageMs: HOUR_MS,
    });
    let err: unknown;
    try {
      withFileLock(lockPath, () => 'must not run');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CliError);
    // Not merely refused — left alone. The winner garbage-collects the
    // entries it judged abandoned, and this one is not among them.
    expect(existsSync(join(lockPath, alive))).toBe(true);
  }, 30_000);

  /**
   * THE WAIT MUST OUTLAST THE STALENESS THRESHOLD, OR A CORPSE WINS.
   *
   * An entry is breakable only once it is past `LOCK_STALE_MS` AND
   * unprobeable, and its mtime is stamped at publication and never refreshed.
   * So a waiter arriving when the corpse is `a` old recovers it iff it is
   * still waiting at the threshold: `a + LOCK_WAIT_MS > LOCK_STALE_MS`. The
   * shipped pair was 10s against 30s, which failed for every `a` below 20
   * seconds — a process that died holding the lock refused every waiter that
   * arrived in the first 20 seconds of its corpse's life, each after a full
   * pointless wait.
   *
   * `a = 0` is the worst case and the one asserted here: a waiter arriving the
   * instant the corpse published. Against the shipped pair it refuses (10 < 30
   * — it gives up at age 10s, twenty seconds before the entry could be broken);
   * against any pair satisfying the invariant it waits the threshold out and
   * enters.
   */
  it('waits out a FRESHLY orphaned lock instead of refusing forever', () => {
    const orphan = plantEntry(lockPath, { token: '999999' });
    let ran = false;
    let err: unknown;
    try {
      withFileLock(lockPath, () => {
        ran = true;
      });
    } catch (e) {
      err = e;
    }
    expect(
      err,
      'a freshly orphaned lock must be waited out, not refused: LOCK_WAIT_MS ' +
        'must exceed LOCK_STALE_MS or the waiter always gives up first',
    ).toBeUndefined();
    expect(ran).toBe(true);
    expect(existsSync(join(lockPath, orphan))).toBe(false);
  }, 30_000);

  it('the constants keep the relationship that makes orphan recovery reachable', () => {
    // A property of the PAIR, so no behavioural test of either alone pins it,
    // and re-inverting them is a two-character edit whose only symptom is an
    // intermittent multi-second failure somewhere else entirely.
    expect(
      LOCK_TIMINGS.waitMs,
      'a waiter that gives up before a lock can go stale can never recover an orphan',
    ).toBeGreaterThan(LOCK_TIMINGS.staleMs);
  });

  it('steals a stale lock instead of waiting forever', () => {
    // Backdated well past the stale threshold, with a pid nothing wears: a
    // process died holding it. Such an entry blocks nobody, and the winner
    // collects it on the way in — safe, because the name is single-use and
    // so can never come back to life as somebody's live claim.
    const stale = plantEntry(lockPath, { token: '999999', ageMs: HOUR_MS });
    expect(withFileLock(lockPath, () => 'ran')).toBe('ran');
    expect(existsSync(join(lockPath, stale))).toBe(false);
    expect(holderEntries(lockPath)).toEqual([]);
  });
});

describe('a lock FILE left by a pre-redesign build', () => {
  it('refuses while the old-style lock still blocks', () => {
    // A plain file at this path predates the single-use-pathname design. The
    // two schemes contend on different paths and so cannot exclude each
    // other, which leaves refusal as the only safe reading of one that still
    // blocks: replacing it with the directory would run beside its holder.
    writeFileSync(lockPath, `${process.pid}:deadbeef`);
    let err: unknown;
    try {
      withFileLock(lockPath, () => 'must not run');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CliError);
    expect(statSync(lockPath).isFile()).toBe(true);
  }, 20_000);

  it('clears an abandoned one and takes the directory in its place', () => {
    // The other half: only a provably abandoned file goes. Without this a
    // developer's working tree wedges across the upgrade forever, which is
    // the single thing the shim exists to prevent.
    writeFileSync(lockPath, '999999');
    const hourAgoSec = Date.now() / 1000 - 3600;
    utimesSync(lockPath, hourAgoSec, hourAgoSec);
    expect(withFileLock(lockPath, () => 'ran')).toBe('ran');
    expect(statSync(lockPath).isDirectory()).toBe(true);
    expect(holderEntries(lockPath)).toEqual([]);
  });
});

describe('withFileLockAsync holds across the await', () => {
  it('does not release before the awaited work finishes', async () => {
    // The bug this pins: `withFileLock(path, () => fn())` returns the promise
    // to a synchronous finally, releasing the lock immediately and leaving
    // the real work unprotected — a lock that reports success and guards
    // nothing.
    let heldDuringWork: string[] = [];
    await withFileLockAsync(lockPath, async () => {
      await new Promise((r) => setTimeout(r, 30));
      heldDuringWork = holderEntries(lockPath);
    });
    expect(heldDuringWork).toHaveLength(1);
    expect(holderEntries(lockPath)).toEqual([]);
  });
});

describe('tryFileLockAsync declines instead of throwing', () => {
  it('runs the work when free, and reports `held: false` when somebody has it', async () => {
    const free = await tryFileLockAsync(lockPath, async () => 'ran', 200);
    expect(free).toEqual({ held: true, value: 'ran' });
    expect(holderEntries(lockPath)).toEqual([]);

    plantEntry(lockPath, { token: `${process.pid}:deadbeef` });
    let entered = false;
    const busy = await tryFileLockAsync(
      lockPath,
      async () => {
        entered = true;
        return 'must not run';
      },
      200,
    );
    expect(busy).toEqual({ held: false });
    expect(entered, 'the work must not run when the lock was not taken').toBe(false);
  }, 30_000);

  it('a zero budget still makes one honest attempt', async () => {
    // The deadline check sits at the top of the acquisition loop, so a zero
    // budget is already spent when the loop opens: without a first-iteration
    // guard this reports the lock held before anything has looked at it, and
    // attend's second pass would decline every turn including the ones nobody
    // else was running.
    const got = await tryFileLockAsync(lockPath, async () => 'ran', 0);
    expect(got).toEqual({ held: true, value: 'ran' });
  });

  it('releases on throw, like the blocking wrappers', async () => {
    await expect(
      tryFileLockAsync(lockPath, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(holderEntries(lockPath)).toEqual([]);
  });

  it('does not leave its ticket behind when it declines', async () => {
    // A ticket abandoned by a decliner blocks the next contender for
    // LOCK_STALE_MS for nothing. `return` does not run the catch that cleans
    // up on the throwing path, so the deadline branch cleans up itself.
    const planted = plantEntry(lockPath, { token: `${process.pid}:deadbeef` });
    expect(await tryFileLockAsync(lockPath, async () => 'x', 200)).toEqual({ held: false });
    expect(holderEntries(lockPath)).toEqual([planted]);
  }, 30_000);
});

describe('mutual exclusion between real processes', () => {
  it('serializes two concurrent holders — no interleaving', async () => {
    // Each child appends ENTER, holds, appends EXIT. The children must run
    // CONCURRENTLY for this to prove anything, so they are spawned async —
    // an execFileSync version would run them one after the other and pass
    // with no lock at all, which is a test that tests nothing.
    const trace = join(dir, 'trace.txt');
    writeFileSync(trace, '');
    const lockModule = join(process.cwd(), 'packages/cli/src/lock.ts');
    const script = join(dir, 'child.mjs');
    writeFileSync(
      script,
      `import { appendFileSync } from 'node:fs';
       import { withFileLock } from ${JSON.stringify(lockModule)};
       withFileLock(${JSON.stringify(lockPath)}, () => {
         appendFileSync(${JSON.stringify(trace)}, 'ENTER\\n');
         Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
         appendFileSync(${JSON.stringify(trace)}, 'EXIT\\n');
       });`,
    );

    const run = (): Promise<number> =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['--import', 'tsx', script], { stdio: 'pipe' });
        let stderr = '';
        child.stderr.on('data', (d) => (stderr += String(d)));
        child.on('error', reject);
        child.on('close', (code) =>
          code === 0 ? resolve(code) : reject(new Error(`child exited ${code}: ${stderr}`)),
        );
      });

    await Promise.all([run(), run()]);

    const lines = readFileSync(trace, 'utf8').trim().split('\n');
    // The property: never two ENTERs in a row. Without the lock the 300 ms
    // hold guarantees the interleaved ENTER ENTER EXIT EXIT.
    expect(lines).toEqual(['ENTER', 'EXIT', 'ENTER', 'EXIT']);
  }, 60_000);
});
