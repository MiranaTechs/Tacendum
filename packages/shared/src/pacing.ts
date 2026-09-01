/**
 * Client-side pacing token bucket.
 *
 * `flushPending` has no pacing and the client cannot see rate-limit
 * rejections (§3.6), so a fan-out must be paced BELOW whatever the server
 * allows this client's account class — the client never trips the server
 * rather than recovering from it. The sizing rule belongs to the CALLER, the
 * algorithm to this module (§4.1): a human account sits under `wsSend`
 * (`packages/server/src/ratelimit.ts:95`) and paces at 24 per 6-second
 * window; a non-human caller sits under `integrationSend` (`ratelimit.ts:132`,
 * 10 burst / 30 per minute) — an order of magnitude tighter. A governor
 * carrying the human constant would trip the server on every integration
 * fan-out while believing it was pacing, which is why this module takes
 * `(capacity, refillPerSec)` as parameters, hard-codes neither, and
 * DELIBERATELY EXPORTS NO DEFAULT PAIR a caller could inherit by accident.
 *
 * Pure: the bucket owns no timers and never reads `Date.now()` — every
 * operation takes the clock as an input, so it is testable without fake
 * timers and cannot drift from whatever clock the caller schedules by.
 */

export interface PacingBucket {
  /**
   * Consume `tokens` (default 1) if the bucket holds them at `nowMs`.
   * Returns true and debits on admit; returns false and debits nothing on
   * refuse — §7.4's admission control queues the fan-out rather than
   * starting it.
   */
  tryTake(nowMs: number, tokens?: number): boolean;
  /** Tokens available at `nowMs` (fractional while refilling). */
  availableTokens(nowMs: number): number;
  /**
   * Milliseconds after `nowMs` until `tokens` (default 1) will be available,
   * assuming nothing else is taken meanwhile. 0 when available now.
   */
  msUntilAvailable(nowMs: number, tokens?: number): number;
}

/**
 * One 2^-32 of a token. Stepwise accrual sums many `elapsed/1000 * rate`
 * terms, and the float error can leave the balance a few ULPs short of a
 * whole token at exactly the instant `msUntilAvailable` promised — a caller
 * that waits the promised wait then gets refused (~1% of random stepwise
 * schedules). Availability is therefore compared through this epsilon: the
 * promised instant admits, and the pacing cost of admitting 2^-32 of a
 * token early is sub-nanosecond at any real refill rate.
 */
const TOKEN_EPSILON = 2 ** -32;

/**
 * Create a bucket that admits `capacity` immediately (burst) and refills
 * continuously at `refillPerSec` up to `capacity` — the same shape as the
 * server's `makeRateLimiter`, sized by the caller strictly below it.
 *
 * A request for more than `capacity` tokens in one take throws rather than
 * returning false forever: a caller asking the bucket to fit what it can
 * never fit has a sizing bug, and a silent forever-refusal wedges the outbox.
 *
 * `initialTokens` (default: full) exists because the bucket's birth is not
 * the server window's birth: after a process restart the server-side window
 * may still be depleted by the previous run, and a fresh full local bucket
 * would trip exactly the limiter it exists to stay under. The CALLER decides
 * what level survives a restart — persistence is G4's job, not this
 * module's; this is only the injection point.
 */
export function createPacingBucket(
  capacity: number,
  refillPerSec: number,
  initialTokens: number = capacity,
): PacingBucket {
  if (!Number.isFinite(capacity) || !Number.isInteger(capacity) || capacity < 1) {
    throw new Error(`createPacingBucket: capacity must be a positive integer, got ${capacity}`);
  }
  if (!Number.isFinite(refillPerSec) || refillPerSec <= 0) {
    throw new Error(`createPacingBucket: refillPerSec must be a positive finite number, got ${refillPerSec}`);
  }
  if (!Number.isFinite(initialTokens) || initialTokens < 0 || initialTokens > capacity) {
    throw new Error(
      `createPacingBucket: initialTokens must be between 0 and capacity (${capacity}), got ${initialTokens}`,
    );
  }

  let tokens = initialTokens; // Caller-set start; full by default (burst now).
  let lastMs: number | null = null; // First observation anchors the clock.

  function checkNow(nowMs: number): void {
    if (!Number.isFinite(nowMs)) {
      throw new Error(`pacing bucket: nowMs must be finite, got ${nowMs}`);
    }
  }

  function checkTokens(n: number): void {
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
      throw new Error(`pacing bucket: tokens must be a positive integer, got ${n}`);
    }
    if (n > capacity) {
      throw new Error(
        `pacing bucket: ${n} tokens can never fit a capacity of ${capacity} — split the batch`,
      );
    }
  }

  /** Accrue refill for the time elapsed since the last observation. A clock
   * that jumps backwards accrues nothing (never refund, never throw) and the
   * anchor keeps its high-water mark, so a rewound clock cannot mint tokens. */
  function refill(nowMs: number): void {
    checkNow(nowMs);
    if (lastMs === null) {
      lastMs = nowMs;
      return;
    }
    const elapsedMs = nowMs - lastMs;
    if (elapsedMs <= 0) return;
    tokens = Math.min(capacity, tokens + (elapsedMs / 1000) * refillPerSec);
    lastMs = nowMs;
  }

  return {
    tryTake(nowMs, take = 1) {
      checkTokens(take);
      refill(nowMs);
      // Epsilon-compare, and clamp the debit: a balance an ULP short of
      // `take` admits (msUntilAvailable's promise must hold), and the debit
      // must not leave a -1e-16 balance behind.
      if (take - tokens > TOKEN_EPSILON) return false;
      tokens = Math.max(0, tokens - take);
      return true;
    },
    availableTokens(nowMs) {
      refill(nowMs);
      return tokens;
    },
    msUntilAvailable(nowMs, take = 1) {
      checkTokens(take);
      refill(nowMs);
      // The same epsilon as tryTake, so "0 ms" and "admits now" never split.
      if (take - tokens <= TOKEN_EPSILON) return 0;
      return Math.ceil(((take - tokens) * 1000) / refillPerSec);
    },
  };
}
