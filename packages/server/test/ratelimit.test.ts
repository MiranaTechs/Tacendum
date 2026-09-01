import { describe, expect, it } from 'vitest';
import { GROUP_MAX_MEMBERS } from '@tacendum/shared/group-fold';
import { LIMITS, makeRateLimiter } from '../src/ratelimit.js';

describe('token-bucket rate limiter', () => {
  it('allows a burst up to capacity, then limits', async () => {
    const t = 0;
    const rl = makeRateLimiter(() => t);
    const opts = { capacity: 3, refillPerSec: 1 };
    expect(await rl.take('a', opts)).toBe(0);
    expect(await rl.take('a', opts)).toBe(0);
    expect(await rl.take('a', opts)).toBe(0);
    // Bucket empty -> limited with a positive retry-after (whole seconds).
    const retry = await rl.take('a', opts);
    expect(retry).toBeGreaterThan(0);
  });

  it('refills over time', async () => {
    let t = 0;
    const rl = makeRateLimiter(() => t);
    const opts = { capacity: 2, refillPerSec: 1 };
    await rl.take('a', opts);
    await rl.take('a', opts);
    expect(await rl.take('a', opts)).toBeGreaterThan(0); // empty
    t += 1000; // one second -> one token
    expect(await rl.take('a', opts)).toBe(0);
    expect(await rl.take('a', opts)).toBeGreaterThan(0); // empty again
  });

  it('never exceeds capacity even after a long idle', async () => {
    let t = 0;
    const rl = makeRateLimiter(() => t);
    const opts = { capacity: 2, refillPerSec: 1 };
    t += 60_000; // idle a minute
    expect(await rl.take('a', opts)).toBe(0);
    expect(await rl.take('a', opts)).toBe(0);
    expect(await rl.take('a', opts)).toBeGreaterThan(0); // capped at 2, not 60
  });

  it('isolates buckets by key', async () => {
    const t = 0;
    const rl = makeRateLimiter(() => t);
    const opts = { capacity: 1, refillPerSec: 1 };
    expect(await rl.take('a', opts)).toBe(0);
    expect(await rl.take('a', opts)).toBeGreaterThan(0); // a is empty
    expect(await rl.take('b', opts)).toBe(0); // b is independent
  });
});

/**
 * The recipient wake ceiling tracks the ROOM CAP, not a literal (raised
 * 10 -> 12 by the product owner's decision, after a rate measurement
 * rather than a guess).
 *
 * Ten was derived for crew, whose cap is 8: eight senders fit under ten with
 * room to spare. Rooms shipped with a cap of 12 and nobody re-derived it, so
 * a member of a full room could not be woken by all eleven of the others.
 *
 * These assert the RELATIONSHIP rather than the number, because the failure
 * mode is not that today's value is wrong — it is that the two drift apart
 * again, silently, the next time one of them moves.
 */
describe('the recipient wake ceiling tracks the room cap', () => {
  it('admits one wake from every other member of a full room', () => {
    expect(LIMITS.pushMessageRecipient.capacity).toBeGreaterThanOrEqual(
      GROUP_MAX_MEMBERS - 1,
    );
  });

  it('is exactly the room cap, so raising one raises the other', () => {
    expect(LIMITS.pushMessageRecipient.capacity).toBe(GROUP_MAX_MEMBERS);
    // Sustained rate matches the burst: a full room's worth per minute.
    expect(LIMITS.pushMessageRecipient.refillPerSec).toBeCloseTo(
      GROUP_MAX_MEMBERS / 60,
      10,
    );
  });

  it('still bounds a flood — one sender cannot spend the whole ceiling', () => {
    // The property the ceiling exists for has to survive the raise: the
    // per-pair share stays strictly smaller, so no single sender can drain it
    // and silence everyone else reaching the same person.
    expect(LIMITS.pushMessagePair.capacity).toBeLessThan(
      LIMITS.pushMessageRecipient.capacity,
    );
  });
});
