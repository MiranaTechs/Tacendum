import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { randomMsgId, type Csprng } from '../src/msgid.js';
import { Ulid } from '../src/frames.js';

/**
 * The wire msgId of a fan-out leg is 26
 * characters of pure CSPRNG output — no timestamp, no monotonic increment —
 * because either one, written into N recipient partitions under one senderId
 * and held for 30 days, turns room membership into a database query. The
 * §11.3 regression here asserts BOTH negatives (shared prefix AND base-32
 * adjacency): the original test asserted only adjacency, which is how a
 * timestamp-prefix leak could once pass it undetected.
 *
 * All entropy in these tests flows through a SEEDED deterministic generator
 * injected via the Csprng seam — never Math.random, whose failures would be
 * unreproducible (and whose use rule 1 forbids even in tests of this module)
 * — with ONE deliberate exception: the real-binding block at the bottom runs
 * against `crypto.randomBytes` itself, because the
 * regression must pass against BOTH bindings, and a regression that only
 * covers the stand-in passes while the production minter regresses.
 */

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** mulberry32 — tiny seeded PRNG for reproducible property tests. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
}

/** A deterministic stand-in for the platform CSPRNG, bound through the seam
 * exactly as the real ones are. */
function seededCsprng(seed: number): Csprng {
  const next = mulberry32(seed);
  return (byteCount) => {
    const out = new Uint8Array(byteCount);
    for (let i = 0; i < byteCount; i++) out[i] = next() & 0xff;
    return out;
  };
}

/** Leading characters two ids share. */
function sharedPrefixLength(a: string, b: string): number {
  let n = 0;
  while (n < a.length && a.charAt(n) === b.charAt(n)) n++;
  return n;
}

/** The base-32 successor of an id over the Crockford alphabet (increment
 * with carry from the last character). */
function base32Successor(id: string): string {
  const chars = id.split('');
  for (let i = chars.length - 1; i >= 0; i--) {
    const value = CROCKFORD.indexOf(chars[i] ?? '');
    if (value < 31) {
      chars[i] = CROCKFORD.charAt(value + 1);
      return chars.join('');
    }
    chars[i] = '0';
  }
  return chars.join('');
}

function areAdjacent(a: string, b: string): boolean {
  return base32Successor(a) === b || base32Successor(b) === a;
}

const FANOUTS = 1_000;
const LEGS = 12;

async function mintFanouts(seed: number): Promise<string[][]> {
  const csprng = seededCsprng(seed);
  const fanouts: string[][] = [];
  for (let f = 0; f < FANOUTS; f++) {
    const legs: string[] = [];
    for (let l = 0; l < LEGS; l++) legs.push(await randomMsgId(csprng));
    fanouts.push(legs);
  }
  return fanouts;
}

describe('randomMsgId — §11.3 regression (the join key must stay dead)', () => {
  it('no two ids of one fan-out share more than 6 leading characters, over 1000 fan-outs', async () => {
    // The prefix half is the one the original test missed: a minter that
    // encodes the mint millisecond stamps every leg of a fan-out with an
    // identical 10-character prefix even after the monotonic increment is
    // gone. Under pure-random ids a 7-character share is ≈2^-33 per fan-out,
    // ≈1e-5 over the whole run — satisfiable, and deterministic under seed.
    const fanouts = await mintFanouts(0x54414331);
    for (const legs of fanouts) {
      for (let i = 0; i < legs.length; i++) {
        for (let j = i + 1; j < legs.length; j++) {
          const a = legs[i] ?? '';
          const b = legs[j] ?? '';
          const shared = sharedPrefixLength(a, b);
          expect(shared, `${a} and ${b} share a ${shared}-char prefix`).toBeLessThanOrEqual(6);
        }
      }
    }
  });

  it('no two ids of one fan-out are adjacent under base-32 successor, over 1000 fan-outs', async () => {
    // The consecutive-suffix half: ulid.monotonicFactory returns the previous
    // id plus one when called twice in a millisecond — exactly what a naive
    // fan-out loop does N times.
    const fanouts = await mintFanouts(0x54414332);
    for (const legs of fanouts) {
      for (let i = 0; i < legs.length; i++) {
        for (let j = i + 1; j < legs.length; j++) {
          const a = legs[i] ?? '';
          const b = legs[j] ?? '';
          expect(areAdjacent(a, b), `${a} and ${b} are base-32 adjacent`).toBe(false);
        }
      }
    }
  });
});

describe('randomMsgId — shape', () => {
  it('every output matches frames.ts Ulid regex, first character 0-7', async () => {
    const csprng = seededCsprng(0xdecafbad);
    for (let i = 0; i < 2_000; i++) {
      const id = await randomMsgId(csprng);
      expect(Ulid.safeParse(id).success, `${id} must match the Ulid regex`).toBe(true);
      // 0-7 keeps the 48-bit timestamp field of a structural ULID from
      // overflowing under any decoder that assumes the time shape.
      expect(id).toMatch(/^[0-7]/);
    }
  });

  it('is unbiased across the alphabet (tail) and across 0-7 (first character)', async () => {
    const csprng = seededCsprng(0x0badf00d);
    const SAMPLE = 4_000;
    const tailCounts = new Map<string, number>();
    const firstCounts = new Map<string, number>();
    for (let i = 0; i < SAMPLE; i++) {
      const id = await randomMsgId(csprng);
      firstCounts.set(id.charAt(0), (firstCounts.get(id.charAt(0)) ?? 0) + 1);
      for (const ch of id.slice(1)) tailCounts.set(ch, (tailCounts.get(ch) ?? 0) + 1);
    }
    // Tail: 100 000 draws over 32 symbols — expected 3125 each, sd ≈ 55.
    // ±10% is ≈5.7σ: loose enough to be stable, tight enough to catch any
    // modulo bias (a `% 31` never emits Z at all; a clamp piles onto one
    // symbol). Deterministic under the seed either way.
    const tailExpected = (SAMPLE * 25) / 32;
    for (const symbol of CROCKFORD) {
      const count = tailCounts.get(symbol) ?? 0;
      expect(count, `tail symbol ${symbol}`).toBeGreaterThan(tailExpected * 0.9);
      expect(count, `tail symbol ${symbol}`).toBeLessThan(tailExpected * 1.1);
    }
    expect(tailCounts.size).toBe(32);
    // First char: 4000 draws over 8 symbols — expected 500 each, sd ≈ 21.
    const firstExpected = SAMPLE / 8;
    for (const symbol of '01234567') {
      const count = firstCounts.get(symbol) ?? 0;
      expect(count, `first symbol ${symbol}`).toBeGreaterThan(firstExpected * 0.8);
      expect(count, `first symbol ${symbol}`).toBeLessThan(firstExpected * 1.2);
    }
    expect(firstCounts.size).toBe(8);
  });
});

describe('randomMsgId — the injected seam is the only entropy source', () => {
  it('consumes exactly 26 bytes per mint, all through the seam, and the id is a pure function of them', async () => {
    const inner = seededCsprng(0x5eed);
    const calls: { requested: number; returned: Uint8Array }[] = [];
    const recording: Csprng = (byteCount) => {
      const bytes = inner(byteCount) as Uint8Array;
      calls.push({ requested: byteCount, returned: bytes.slice() });
      return bytes;
    };
    const MINTS = 50;
    const ids: string[] = [];
    for (let i = 0; i < MINTS; i++) ids.push(await randomMsgId(recording));

    expect(calls).toHaveLength(MINTS);
    for (const call of calls) expect(call.requested).toBe(26);
    // Independent re-derivation: if any character drew on anything but the
    // recorded seam bytes (a clock, Math.random, module state), it diverges.
    ids.forEach((id, i) => {
      const bytes = calls[i]?.returned ?? new Uint8Array(0);
      const expected = Array.from(bytes, (byte, pos) =>
        CROCKFORD.charAt(pos === 0 ? byte % 8 : byte % 32),
      ).join('');
      expect(id).toBe(expected);
    });
  });

  it('mints known vectors byte-for-byte', async () => {
    const fixed = (bytes: number[]): Csprng => () => Uint8Array.from(bytes);
    expect(await randomMsgId(fixed(new Array(26).fill(0)))).toBe('0'.repeat(26));
    // 0xff & 7 = 7; 0xff & 31 = 31 → Z.
    expect(await randomMsgId(fixed(new Array(26).fill(0xff)))).toBe('7' + 'Z'.repeat(25));
    // 9 & 7 = 1; tail bytes 0..24 index the alphabet directly.
    const ascending = [9, ...Array.from({ length: 25 }, (_, i) => i)];
    expect(await randomMsgId(fixed(ascending))).toBe('1' + CROCKFORD.slice(0, 25));
  });

  it('never touches Math.random or Date.now', async () => {
    const realRandom = Math.random;
    const realNow = Date.now;
    Math.random = () => {
      throw new Error('Math.random reached from randomMsgId');
    };
    Date.now = () => {
      throw new Error('Date.now reached from randomMsgId');
    };
    try {
      const id = await randomMsgId(seededCsprng(0xa11ce));
      expect(Ulid.safeParse(id).success).toBe(true);
    } finally {
      Math.random = realRandom;
      Date.now = realNow;
    }
  });

  it('the app\'s async pool-refill binding shape is expressible through the seam', async () => {
    // Shaped like app/src/msgid.ts: an entropy pool refilled asynchronously,
    // drawn synchronously, throwing (never degrading) on exhaustion.
    const next = mulberry32(0x9001);
    let pool = new Uint8Array(0);
    let offset = 0;
    const refillPool = async (): Promise<void> => {
      await Promise.resolve(); // a real native-module hop is async
      pool = new Uint8Array(64);
      for (let i = 0; i < pool.length; i++) pool[i] = next() & 0xff;
      offset = 0;
    };
    const poolCsprng: Csprng = async (byteCount) => {
      if (pool.length - offset < byteCount) await refillPool();
      if (pool.length - offset < byteCount) throw new Error('entropy pool exhausted');
      const bytes = pool.slice(offset, offset + byteCount);
      offset += byteCount;
      return bytes;
    };
    const ids = new Set<string>();
    for (let i = 0; i < 20; i++) ids.add(await randomMsgId(poolCsprng));
    expect(ids.size).toBe(20);
    for (const id of ids) expect(Ulid.safeParse(id).success).toBe(true);
  });
});

describe('randomMsgId — against the real node:crypto binding', () => {
  // The CLI's production binding, through the same seam it will use. Not
  // seeded, deliberately: this block proves the BINDING, the seeded blocks
  // above prove the mapping. A false failure here is the §11.3 number —
  // ≈1e-5 for the prefix bound across 1000 fan-outs, effectively 0 for
  // adjacency — i.e. satisfiable, unlike the phrasing §11.3 replaced.
  const nodeCsprng: Csprng = (byteCount) => new Uint8Array(randomBytes(byteCount));

  it('mints Ulid-shaped ids, first character 0-7', async () => {
    for (let i = 0; i < 500; i++) {
      const id = await randomMsgId(nodeCsprng);
      expect(Ulid.safeParse(id).success, `${id} must match the Ulid regex`).toBe(true);
      expect(id).toMatch(/^[0-7]/);
    }
  });

  it('passes the §11.3 regression: ≤6 shared leading characters and no base-32 adjacency, over 1000 fan-outs', async () => {
    for (let f = 0; f < FANOUTS; f++) {
      const legs: string[] = [];
      for (let l = 0; l < LEGS; l++) legs.push(await randomMsgId(nodeCsprng));
      for (let i = 0; i < legs.length; i++) {
        for (let j = i + 1; j < legs.length; j++) {
          const a = legs[i] ?? '';
          const b = legs[j] ?? '';
          const shared = sharedPrefixLength(a, b);
          expect(shared, `${a} and ${b} share a ${shared}-char prefix`).toBeLessThanOrEqual(6);
          expect(areAdjacent(a, b), `${a} and ${b} are base-32 adjacent`).toBe(false);
        }
      }
    }
  });
});

describe('randomMsgId — failure is failure, never degradation', () => {
  it('propagates a throwing CSPRNG', async () => {
    const dead: Csprng = () => {
      throw new Error('rng offline');
    };
    await expect(randomMsgId(dead)).rejects.toThrow('rng offline');
  });

  it('propagates a rejecting CSPRNG', async () => {
    const dead: Csprng = () => Promise.reject(new Error('native rng unavailable'));
    await expect(randomMsgId(dead)).rejects.toThrow('native rng unavailable');
  });

  it('rejects a short read instead of padding', async () => {
    const short: Csprng = () => new Uint8Array(16);
    await expect(randomMsgId(short)).rejects.toThrow(/expected exactly 26/);
  });

  it('rejects a non-Uint8Array return instead of coercing', async () => {
    const wrong = (() => [1, 2, 3]) as unknown as Csprng;
    await expect(randomMsgId(wrong)).rejects.toThrow(/non-Uint8Array/);
  });
});
