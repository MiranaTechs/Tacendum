import { describe, expect, it } from 'vitest';
import * as pacing from '../src/pacing.js';
import { createPacingBucket } from '../src/pacing.js';

/**
 * The client-side pacing bucket, sized by the CALLER
 * strictly below the server's ceiling for that caller's account class. The
 * two production sizings exercised here are the design's own: a human account
 * paces at 24 per 6-second window (below wsSend's 30 burst / 5 per sec,
 * ratelimit.ts:95); an integration account paces under integrationSend's
 * 10 burst / 30 per minute (ratelimit.ts:132). The algorithm must hard-code
 * NEITHER — a governor carrying the human constant trips the server on every
 * integration fan-out while believing it is pacing.
 */

// The two account-class sizings, as the CALLERS would pass them. Deliberately
// defined here, not exported from the module under test — §7.4 forbids a
// default pair.
const HUMAN = { capacity: 24, refillPerSec: 24 / 6 } as const;
const INTEGRATION = { capacity: 10, refillPerSec: 30 / 60 } as const;

/** mulberry32 — tiny seeded PRNG so a property failure replays exactly. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('createPacingBucket — burst and refill', () => {
  it('admits exactly capacity immediately, then refuses', () => {
    for (const { capacity, refillPerSec } of [HUMAN, INTEGRATION]) {
      const bucket = createPacingBucket(capacity, refillPerSec);
      for (let i = 0; i < capacity; i++) {
        expect(bucket.tryTake(0), `take ${i + 1} of ${capacity}`).toBe(true);
      }
      expect(bucket.tryTake(0), `take ${capacity + 1} must refuse`).toBe(false);
    }
  });

  it('refills at the stated rate — not a millisecond sooner', () => {
    // 24 per 6 s = one token per 250 ms.
    const bucket = createPacingBucket(HUMAN.capacity, HUMAN.refillPerSec);
    for (let i = 0; i < HUMAN.capacity; i++) bucket.tryTake(0);
    expect(bucket.tryTake(249)).toBe(false);
    expect(bucket.tryTake(250)).toBe(true);
    expect(bucket.tryTake(250)).toBe(false); // the refill bought exactly one
    // A drained bucket recovers its full window budget after the window.
    const drainedAt = 250;
    for (let i = 0; i < HUMAN.capacity; i++) {
      expect(bucket.tryTake(drainedAt + 6_000), `refilled take ${i + 1}`).toBe(true);
    }
    expect(bucket.tryTake(drainedAt + 6_000)).toBe(false);
  });

  it('never accrues past capacity, however long the idle', () => {
    const bucket = createPacingBucket(INTEGRATION.capacity, INTEGRATION.refillPerSec);
    expect(bucket.tryTake(0)).toBe(true); // 9 left
    expect(bucket.availableTokens(100_000_000)).toBe(INTEGRATION.capacity);
    for (let i = 0; i < INTEGRATION.capacity; i++) {
      expect(bucket.tryTake(100_000_000)).toBe(true);
    }
    expect(bucket.tryTake(100_000_000)).toBe(false);
  });

  it('a refused take debits nothing', () => {
    const bucket = createPacingBucket(1, 1);
    expect(bucket.tryTake(0)).toBe(true);
    // Hammering an empty bucket must not push recovery further out.
    expect(bucket.tryTake(0)).toBe(false);
    expect(bucket.tryTake(500)).toBe(false);
    expect(bucket.tryTake(999)).toBe(false);
    expect(bucket.tryTake(1_000)).toBe(true);
  });
});

describe('createPacingBucket — no built-in account class', () => {
  it('an integration-class bucket is provably tighter than a human-class bucket under an identical call sequence', () => {
    const human = createPacingBucket(HUMAN.capacity, HUMAN.refillPerSec);
    const integration = createPacingBucket(INTEGRATION.capacity, INTEGRATION.refillPerSec);

    // A 12-leg fan-out at t=0: the human class absorbs it whole; the
    // integration class must refuse the last two legs (10 burst).
    let humanLegs = 0;
    let integrationLegs = 0;
    for (let leg = 0; leg < 12; leg++) {
      if (human.tryTake(0)) humanLegs++;
      if (integration.tryTake(0)) integrationLegs++;
    }
    expect(humanLegs).toBe(12);
    expect(integrationLegs).toBe(INTEGRATION.capacity);

    // Sixty seconds of pressure, one attempt per 100 ms, identical sequence
    // to both buckets. Ceilings: human ≤ 24 + 4/s·60 s; integration ≤
    // 10 + 0.5/s·60 s — an order of magnitude apart, as §7.4 says.
    let humanAdmitted = 0;
    let integrationAdmitted = 0;
    for (let t = 100; t <= 60_000; t += 100) {
      if (human.tryTake(t)) humanAdmitted++;
      if (integration.tryTake(t)) integrationAdmitted++;
    }
    expect(integrationAdmitted).toBeLessThan(humanAdmitted);
    expect(integrationAdmitted + integrationLegs).toBeLessThanOrEqual(10 + 30);
    expect(humanAdmitted + humanLegs).toBeGreaterThan(200);
  });

  it('two differently-parameterised buckets diverge under an identical call sequence', () => {
    // The minimal pair: if the algorithm carried any built-in constant,
    // these would behave identically.
    const one = createPacingBucket(1, 1);
    const two = createPacingBucket(2, 1);
    expect(one.tryTake(0)).toBe(true);
    expect(two.tryTake(0)).toBe(true);
    expect(one.tryTake(0)).toBe(false);
    expect(two.tryTake(0)).toBe(true);

    const slow = createPacingBucket(1, 0.1);
    const fast = createPacingBucket(1, 10);
    slow.tryTake(0);
    fast.tryTake(0);
    expect(slow.tryTake(1_000)).toBe(false); // 0.1/s: needs 10 s
    expect(fast.tryTake(1_000)).toBe(true); // 10/s: needed 100 ms
  });

  it('exports no default (capacity, refill) pair a caller could inherit', () => {
    // §7.4: the sizing rule belongs to the caller. The module's entire
    // runtime surface is the factory — no constant to inherit by accident.
    expect(Object.keys(pacing).sort()).toEqual(['createPacingBucket']);
  });
});

describe('createPacingBucket — pure over an injected clock', () => {
  it('never reads Date.now', () => {
    const realNow = Date.now;
    Date.now = () => {
      throw new Error('Date.now reached from the pacing bucket');
    };
    try {
      const bucket = createPacingBucket(2, 1);
      expect(bucket.tryTake(5)).toBe(true);
      expect(bucket.tryTake(5)).toBe(true);
      expect(bucket.tryTake(5)).toBe(false);
      expect(bucket.availableTokens(1_005)).toBe(1);
      expect(bucket.msUntilAvailable(1_005, 2)).toBe(1_000);
    } finally {
      Date.now = realNow;
    }
  });

  it('a rewound clock mints nothing — and cannot mint later by moving the anchor back', () => {
    const bucket = createPacingBucket(5, 1);
    for (let i = 0; i < 5; i++) expect(bucket.tryTake(10_000)).toBe(true);
    // Clock jumps back 10 s: no refund, no negative balance.
    expect(bucket.availableTokens(0)).toBe(0);
    // And the anchor must not have moved to t=0: half a second after the
    // real drain there is still no whole token.
    expect(bucket.tryTake(10_500)).toBe(false);
    expect(bucket.tryTake(11_000)).toBe(true);
  });

  it('msUntilAvailable names the exact wait, and the wait is sufficient', () => {
    const bucket = createPacingBucket(2, 1);
    bucket.tryTake(0);
    bucket.tryTake(0);
    expect(bucket.msUntilAvailable(0)).toBe(1_000);
    expect(bucket.msUntilAvailable(0, 2)).toBe(2_000);
    expect(bucket.msUntilAvailable(500)).toBe(500);
    expect(bucket.tryTake(1_000)).toBe(true);
    expect(bucket.msUntilAvailable(1_000)).toBe(1_000);

    // A non-divisible rate must round the wait UP: the promised instant
    // admits, the millisecond before it refuses.
    const thirds = createPacingBucket(2, 3);
    thirds.tryTake(0, 2);
    const wait = thirds.msUntilAvailable(0);
    expect(wait).toBe(334); // ceil(1000/3)
    expect(thirds.tryTake(wait - 1)).toBe(false);
    expect(thirds.tryTake(wait)).toBe(true);
  });
});

describe('createPacingBucket — the promised instant admits (float-ULP regression)', () => {
  it("msUntilAvailable's promise holds under ragged stepwise accrual, 200 seeded schedules", () => {
    // Stepwise observation accrues the refill as many small float additions,
    // and the balance can read 0.9999999999999999 at exactly the instant
    // msUntilAvailable promised — before the epsilon-compare, tryTake then
    // refused on ~5% of these seeded schedules (a reproduced defect).
    // A caller that waits the promised wait must be admitted, always.
    for (let seed = 0; seed < 200; seed++) {
      const rnd = mulberry32(seed);
      const bucket = createPacingBucket(HUMAN.capacity, HUMAN.refillPerSec);
      let t = 0;
      for (let i = 0; i < HUMAN.capacity; i++) bucket.tryTake(t);
      for (let cycle = 0; cycle < 40; cycle++) {
        const steps = 1 + Math.floor(rnd() * 7);
        for (let s = 0; s < steps; s++) {
          t += Math.floor(rnd() * 40) + 1;
          bucket.availableTokens(t); // each observation is a refill step
        }
        const wait = bucket.msUntilAvailable(t);
        t += wait;
        expect(
          bucket.tryTake(t),
          `seed ${seed} cycle ${cycle}: refused at the promised instant t=${t}`,
        ).toBe(true);
      }
    }
  });

  it('the epsilon stays far below scheduling granularity: one millisecond early still refuses', () => {
    const bucket = createPacingBucket(HUMAN.capacity, HUMAN.refillPerSec);
    for (let i = 0; i < HUMAN.capacity; i++) bucket.tryTake(0);
    expect(bucket.tryTake(249)).toBe(false); // 0.996 of a token is not one
    expect(bucket.tryTake(250)).toBe(true);
  });
});

describe('createPacingBucket — a caller-supplied initial level (§7.4, restart honesty)', () => {
  it('starts at the supplied level instead of full, and refills from there', () => {
    // After a restart the SERVER's window may still be depleted by the
    // previous run; a fresh full local bucket would trip exactly the
    // limiter it exists to stay under. The caller injects what survived —
    // persistence itself is G4's job, not this module's.
    const empty = createPacingBucket(10, 1, 0);
    expect(empty.availableTokens(0)).toBe(0);
    expect(empty.tryTake(0)).toBe(false);
    expect(empty.msUntilAvailable(0)).toBe(1_000);
    expect(empty.tryTake(1_000)).toBe(true);

    const partial = createPacingBucket(10, 1, 2.5); // a snapshot may be fractional
    expect(partial.tryTake(0, 2)).toBe(true);
    expect(partial.tryTake(0)).toBe(false); // 0.5 left is not a token
    expect(partial.tryTake(500)).toBe(true);
  });

  it('defaults to full: existing callers keep the immediate burst', () => {
    const bucket = createPacingBucket(3, 1);
    for (let i = 0; i < 3; i++) expect(bucket.tryTake(0)).toBe(true);
    expect(bucket.tryTake(0)).toBe(false);
  });

  it('rejects an initial level outside [0, capacity]', () => {
    expect(() => createPacingBucket(10, 1, -1)).toThrow(/initialTokens/);
    expect(() => createPacingBucket(10, 1, 10.5)).toThrow(/initialTokens/);
    expect(() => createPacingBucket(10, 1, Number.NaN)).toThrow(/initialTokens/);
    expect(createPacingBucket(10, 1, 10).availableTokens(0)).toBe(10);
  });
});

describe('createPacingBucket — refuses nonsense loudly', () => {
  it('rejects a take that can never fit, instead of refusing forever', () => {
    const bucket = createPacingBucket(INTEGRATION.capacity, INTEGRATION.refillPerSec);
    expect(() => bucket.tryTake(0, 11)).toThrow(/never fit/);
    expect(() => bucket.msUntilAvailable(0, 11)).toThrow(/never fit/);
    expect(bucket.tryTake(0, 10)).toBe(true); // exactly capacity is fine
  });

  it('rejects invalid parameters and clocks', () => {
    expect(() => createPacingBucket(0, 1)).toThrow(/capacity/);
    expect(() => createPacingBucket(-1, 1)).toThrow(/capacity/);
    expect(() => createPacingBucket(2.5, 1)).toThrow(/capacity/);
    expect(() => createPacingBucket(Number.NaN, 1)).toThrow(/capacity/);
    expect(() => createPacingBucket(10, 0)).toThrow(/refillPerSec/);
    expect(() => createPacingBucket(10, -3)).toThrow(/refillPerSec/);
    expect(() => createPacingBucket(10, Number.NaN)).toThrow(/refillPerSec/);
    const bucket = createPacingBucket(1, 1);
    expect(() => bucket.tryTake(Number.NaN)).toThrow(/nowMs/);
    expect(() => bucket.tryTake(0, 0)).toThrow(/tokens/);
    expect(() => bucket.tryTake(0, 1.5)).toThrow(/tokens/);
  });
});
