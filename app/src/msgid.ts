import { monotonicFactory } from 'ulid';
import { randomBytes } from 'tacendum-crypto';

/**
 * ULID msgIds fed exclusively by the platform RNG (SecRandomCopyBytes via the
 * native module). No Math.random, no JS crypto — ULIDs are
 * identifiers, but there is no reason to use a weaker source.
 */

const POOL_SIZE = 1024;
let pool: Uint8Array = new Uint8Array(0);
let poolOffset = 0;
let refill: Promise<void> | null = null;

async function refillPool(): Promise<void> {
  pool = await randomBytes(POOL_SIZE);
  poolOffset = 0;
}

/** Synchronous PRNG over the pre-fetched entropy pool (ulid's contract). */
function prng(): number {
  if (poolOffset >= pool.length) {
    // Callers guarantee the pool via ensureEntropy(); this is a hard bug trap,
    // not a fallback — never degrade to Math.random.
    throw new Error('entropy pool exhausted — call nextMsgId(), not the factory directly');
  }
  return pool[poolOffset++] / 256;
}

const factory = monotonicFactory(prng);

/** Generate the next outgoing msgId (time-ordered, monotonic per device). */
export async function nextMsgId(): Promise<string> {
  // 16 prng draws per ulid; refill when fewer than 64 bytes remain.
  if (pool.length - poolOffset < 64) {
    refill = refill ?? refillPool();
    try {
      await refill;
    } finally {
      // Always clear the slot — otherwise a rejected refill (transient native
      // RNG error) would be cached forever and wedge every future send.
      refill = null;
    }
  }
  return factory(Date.now());
}
