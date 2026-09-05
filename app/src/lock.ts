import { deleteSecret, getSecret, setSecret } from 'tacendum-crypto';
import { session } from './session';

/**
 * App-lock core: passcode verdicts, failure cooldown, and
 * Keychain-backed state. The reversed passcode selects the duress workspace;
 * it is never stored — derived by reversal at comparison time. No crypto:
 * the Keychain IS the at-rest protection, and comparison happens in
 * the same process that just received the digits either way.
 *
 * All state lives in the Keychain so a relaunch can neither reset a cooldown
 * nor forget the lock. Every mutation is a silent no-op in a duress session: a coerced "change the passcode" must appear to work.
 */

export type LockVerdict =
  | { verdict: 'real' }
  | { verdict: 'duress' }
  | { verdict: 'fail'; attemptsLeft: number }
  | { verdict: 'cooldown'; retryInMs: number };

export interface LockStatus {
  enabled: boolean;
  autolockSec: number;
}

const KEY_CODE = 'lock.passcode';
const KEY_ENABLED = 'lock.enabled';
const KEY_AUTOLOCK = 'lock.autolockSec';
const KEY_FAILS = 'lock.failCount';
const KEY_LOCKED_UNTIL = 'lock.lockedUntil';
/**
 * Everything `clearAll` wipes AFTER the gate. `lock.enabled` is deliberately
 * NOT in this list — it is deleted first and on its own, see `clearAll`.
 */
const POST_GATE_KEYS = [
  KEY_CODE,
  KEY_AUTOLOCK,
  KEY_FAILS,
  KEY_LOCKED_UNTIL,
];

const FREE_ATTEMPTS = 5;
const BASE_COOLDOWN_MS = 30_000;
const MAX_COOLDOWN_MS = 15 * 60_000;

/**
 * The in-process half of the cooldown deadline, on the MONOTONIC clock.
 * `lock.lockedUntil` is wall-clock so a relaunch resumes the cooldown, but a
 * wall clock can be moved: a forward jump — a network time correction, a
 * manual change — would end the cooldown early. Inside one process the
 * monotonic clock cannot be moved, so the cooldown holds for its full length
 * on whichever of the two is later. The shadow is bound to the exact
 * Keychain deadline it was minted for: a deadline that was rewritten, reset
 * or cleared invalidates it, so the Keychain stays the one source a relaunch
 * reads (that a relaunch trusts the wall clock is the platform's limit — no
 * monotonic clock survives a process — not a choice). A backward jump needs
 * no help: it only ever lengthens the wall-clock hold, which is the
 * fail-closed direction. */
let cooldownShadow: { wallUntil: number; monoUntil: number } | null = null;

function monotonicNow(): number | null {
  const perf = (globalThis as { performance?: { now?: () => number } }).performance;
  return typeof perf?.now === 'function' ? perf.now() : null;
}

/** How long the cooldown bound to `wallUntil` still has on the monotonic
 * clock — 0 when no shadow is bound to it, or this runtime has no such clock. */
function shadowRemainingMs(wallUntil: number): number {
  if (cooldownShadow === null || cooldownShadow.wallUntil !== wallUntil) return 0;
  const mono = monotonicNow();
  return mono === null ? 0 : Math.max(0, cooldownShadow.monoUntil - mono);
}

function bindCooldownShadow(wallUntil: number, cooldownMs: number): void {
  const mono = monotonicNow();
  cooldownShadow = mono === null ? null : { wallUntil, monoUntil: mono + cooldownMs };
}

export const COPY = {
  badLength: 'Use 4 to 10 digits.',
  palindrome: "This code reads the same backwards — pick one that doesn't.",
} as const;

function reverse(code: string): string {
  return [...code].reverse().join('');
}

/** Setup-time validation; returns user-facing copy, or null when valid. */
export function validateCode(code: string): string | null {
  if (!/^\d{4,10}$/.test(code)) return COPY.badLength;
  // A palindromic code (incl. all-same-digit) makes duress == real.
  if (code === reverse(code)) return COPY.palindrome;
  return null;
}

export async function status(): Promise<LockStatus> {
  const enabled = (await getSecret(KEY_ENABLED)) === '1';
  const autolockSec = Number((await getSecret(KEY_AUTOLOCK)) ?? '0');
  return { enabled, autolockSec: Number.isFinite(autolockSec) ? autolockSec : 0 };
}

/** Enable the lock (or change the code). Fresh start for the fail counters. */
export async function setup(code: string): Promise<void> {
  if (session.mode === 'duress') return;
  const invalid = validateCode(code);
  if (invalid) throw new Error(invalid);
  await setSecret(KEY_CODE, code);
  await setSecret(KEY_ENABLED, '1');
  await deleteSecret(KEY_FAILS);
  await deleteSecret(KEY_LOCKED_UNTIL);
  cooldownShadow = null;
}

export async function setAutolock(sec: number): Promise<void> {
  if (session.mode === 'duress') return;
  await setSecret(KEY_AUTOLOCK, String(sec));
}

export async function disable(): Promise<void> {
  if (session.mode === 'duress') return;
  await clearAll();
}

/**
 * Unconditional wipe of lock state — the real sign-out path only.
 *
 * The wipe is ordered, and the order is the safety property (AD-1,
 * 2026-09-03). It used to be one unguarded loop over a key list that put
 * `lock.passcode` BEFORE `lock.enabled`, so a single rejecting delete —
 * SecretStore.kt throws `secret delete failed` on a failed unlink, and the
 * iOS store throws on any Keychain status but success/notFound — aborted the
 * loop having removed the code and left the flag. `verify` answers that
 * half-state `{ verdict: 'real' }` for ANY input (see the branch below, which
 * is the never-brick-the-user net and stays exactly as it is): the fix is to
 * make its precondition unreachable from here.
 *
 * So: `lock.enabled` is a GATE. It goes first, alone, and a rejection there
 * propagates before anything else is touched — nothing was deleted, the lock
 * still works, and the caller's "nothing was changed" is true. Past the gate
 * the lock already reads as off, so the remaining keys are swept
 * best-effort — every one attempted, no early abort — and a key the store
 * refuses to drop is left as inert residue (`status` reads disabled, the next
 * `setup` overwrites the code) rather than turned into a failure the UI would
 * have to describe. Reporting one there would make the disable flow claim
 * "nothing was changed" over a lock that IS off and leave its toggle reading
 * on, which is a worse lie than the residue.
 *
 * Rule 4: nothing here names a key or a value in an error.
 */
export async function clearAll(): Promise<void> {
  await deleteSecret(KEY_ENABLED);
  for (const key of POST_GATE_KEYS) {
    try {
      await deleteSecret(key);
    } catch {
      // Inert residue behind a lock that is already off; see above.
    }
  }
  cooldownShadow = null;
}

export async function verify(entered: string): Promise<LockVerdict> {
  const now = Date.now();
  const lockedUntil = Number((await getSecret(KEY_LOCKED_UNTIL)) ?? '0');
  // The later of the two clocks holds: the Keychain's wall-clock deadline,
  // or its monotonic shadow when the wall clock jumped past it.
  const retryInMs = Math.max(lockedUntil - now, shadowRemainingMs(lockedUntil));
  if (retryInMs > 0) {
    return { verdict: 'cooldown', retryInMs };
  }
  const stored = await getSecret(KEY_CODE);
  // Enabled-with-no-code is a corrupt half-state; never brick the user.
  if (!stored) return { verdict: 'real' };

  // Real and duress unlocks are deliberately identical in every observable
  // except the workspace the caller selects.
  if (entered === stored) {
    await resetFailures();
    return { verdict: 'real' };
  }
  if (entered === reverse(stored)) {
    await resetFailures();
    return { verdict: 'duress' };
  }

  const fails = Number((await getSecret(KEY_FAILS)) ?? '0') + 1;
  await setSecret(KEY_FAILS, String(fails));
  if (fails >= FREE_ATTEMPTS) {
    const cooldown = Math.min(
      BASE_COOLDOWN_MS * 2 ** (fails - FREE_ATTEMPTS),
      MAX_COOLDOWN_MS,
    );
    const wallUntil = now + cooldown;
    await setSecret(KEY_LOCKED_UNTIL, String(wallUntil));
    bindCooldownShadow(wallUntil, cooldown);
    return { verdict: 'cooldown', retryInMs: cooldown };
  }
  return { verdict: 'fail', attemptsLeft: FREE_ATTEMPTS - fails };
}

async function resetFailures(): Promise<void> {
  await deleteSecret(KEY_FAILS);
  await deleteSecret(KEY_LOCKED_UNTIL);
  cooldownShadow = null;
}

/** Active cooldown remaining, without consuming an attempt (lock-screen
 * countdown on mount/relaunch). The later of the two clocks, as `verify`. */
export async function cooldownRemainingMs(): Promise<number> {
  const lockedUntil = Number((await getSecret(KEY_LOCKED_UNTIL)) ?? '0');
  return Math.max(0, lockedUntil - Date.now(), shadowRemainingMs(lockedUntil));
}
