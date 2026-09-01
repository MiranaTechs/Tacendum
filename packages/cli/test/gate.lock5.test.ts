import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * ONE FAILED PROBE MUST NOT POISON EVERY LATER TOKEN.
 *
 * `myIncarnation()` cached its own FAILURE. The line was
 *
 *     ownIncarnation ??= processIncarnation(process.pid) ?? UNKNOWN_INCARNATION;
 *
 * and the right-hand side is never nullish, so `?` was memoised exactly like a
 * real reading. One EAGAIN at a fork limit, or one moment at the descriptor
 * ceiling where both `/proc/self/stat` and the `ps` spawn fail — the correlated
 * condition lock.ts's own header documents as reached — stamped `?` into every
 * token that process wrote for the rest of its life.
 *
 * That is a mutual-exclusion defect, not a cosmetic one. `holderIsAlive` reads
 * a recorded `?` as dead, so `doorBlocks`' "young OR alive" collapses to
 * age-only, and a LIVE claimant's doorway stops blocking once it is older than
 * DOOR_MAX_MS. The gate measured two processes concurrently inside the critical
 * section for 509ms, in 4 of 4 trials, with a stall injected between the queue
 * read and the ticket link. A `listen` daemon is both the longest-lived process
 * here and the one most exposed to the trigger.
 *
 * THIS FILE IS SEPARATE FROM gate.lock4 ON PURPOSE. `ownIncarnation` is module
 * state, so any earlier acquisition in the same file caches a real reading and
 * the injection can never be observed — the test would pass against the bug.
 * Nothing here may take the lock before the first case runs.
 */

const ctl = vi.hoisted(() => ({ failProbesOnce: false, psCalls: 0 }));

vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>();
  const execFileSync: typeof real.execFileSync = ((file: string, args?: unknown, opts?: unknown) => {
    if (file === 'ps') {
      ctl.psCalls += 1;
      if (ctl.failProbesOnce) {
        ctl.failProbesOnce = false;
        const err = new Error('EAGAIN: resource temporarily unavailable') as NodeJS.ErrnoException;
        err.code = 'EAGAIN';
        throw err;
      }
    }
    return real.execFileSync(file, args as never, opts as never);
  }) as typeof real.execFileSync;
  return { ...real, execFileSync };
});

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  // Only the Linux probe path, so the injection is the same on both platforms:
  // on macOS this already throws ENOENT, on Linux it is what would have
  // answered. Every other read — the lock entries, the tokens — is untouched.
  const readFileSync: typeof real.readFileSync = ((path: unknown, opts?: unknown) => {
    if (typeof path === 'string' && path.startsWith('/proc/')) {
      const err = new Error('EMFILE: too many open files') as NodeJS.ErrnoException;
      err.code = 'EMFILE';
      throw err;
    }
    return real.readFileSync(path as never, opts as never);
  }) as typeof real.readFileSync;
  return { ...real, readFileSync };
});

const { withFileLock } = await import('../src/lock.js');

const ENTRY_RE = /^\d{12}\.[0-9a-f]{32}$/;

/** The token of whatever entry is holding the lock right now. */
function heldToken(lockPath: string): string {
  const held = readdirSync(lockPath).filter((n) => ENTRY_RE.test(n));
  expect(held, 'no holder entry while inside the critical section').toHaveLength(1);
  return readFileSync(join(lockPath, held[0] as string), 'utf8');
}

/** The middle field of `pid:incarnation:random`. */
function incarnationOf(token: string): string {
  const parts = token.split(':');
  expect(parts, `token is not the three-part form: ${parts.length} fields`).toHaveLength(3);
  return parts[1] as string;
}

let dir: string;
let lockPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tacendum-lock5-'));
  lockPath = join(dir, 'ratchet.lock');
});
afterEach(() => {
  ctl.failProbesOnce = false;
  rmSync(dir, { recursive: true, force: true });
});

describe('a transient incarnation probe failure', () => {
  it('is not remembered — the next token carries a real reading', () => {
    ctl.failProbesOnce = true;

    let first = '';
    withFileLock(lockPath, () => {
      first = heldToken(lockPath);
    });

    let second = '';
    withFileLock(lockPath, () => {
      second = heldToken(lockPath);
    });

    // The injection really fired: without this the case proves nothing, because
    // a probe that never failed would trivially satisfy the assertion below.
    expect(
      incarnationOf(first),
      'the probe did not actually fail — the injection missed and this case is vacuous',
    ).toBe('?');
    // And it was not remembered. THIS is the property: a token whose
    // incarnation is `?` is read as dead by holderIsAlive for as long as the
    // process lives.
    expect(
      incarnationOf(second),
      'a single failed probe poisoned a later token — every door and entry this ' +
        'process writes now reads as dead',
    ).not.toBe('?');
    // Whatever the platform answered, it must be the shape holderIsAlive
    // compares against a fresh probe, not empty and not the unknown marker.
    expect(incarnationOf(second).length).toBeGreaterThan(0);
  }, 30_000);

  it('is re-asked rather than assumed, so a healthy process stays verifiable', () => {
    // The complement: with no injection at all the very first token must
    // already carry a real reading. If this ever goes `?` on a machine where
    // `ps` works, the probe itself has broken and every liveness decision in
    // lock.ts silently degrades to the age window.
    let only = '';
    withFileLock(lockPath, () => {
      only = heldToken(lockPath);
    });
    expect(incarnationOf(only)).not.toBe('?');
  }, 30_000);
});
