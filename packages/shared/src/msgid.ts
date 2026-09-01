/**
 * randomMsgId — the wire msgId for group fan-out legs.
 *
 * A naive fan-out mints N monotonic ULIDs in one loop and hands the server N
 * consecutive base-32 integers under one senderId, written into N recipient
 * partitions it holds for 30 days — a free, exact, durable, retroactive join
 * key over room membership. Dropping only the monotonic increment is not
 * enough: `ulid(Date.now(), prng)` still stamps every leg of one fan-out with
 * an identical 10-character millisecond prefix. The fix is that the wire
 * msgId carries NO timestamp at all:
 * 26 characters of pure CSPRNG output over the Crockford alphabet, first
 * character constrained to `0`–`7` so the string stays decodable as a 128-bit
 * ULID under any decoder that assumes the 48-bit-time shape (the constraint
 * costs 2 bits of a 130-bit space). Ids mint at enqueue, like every id today
 * — there is no timestamp for flush timing to spread, so there is no jitter
 * and no clamp. Matches `frames.ts`'s `Ulid` regex.
 *
 * THE CSPRNG IS INJECTED, NOT IMPORTED. This module is written for two
 * clients with incompatible entropy bindings. The app's binding is shipped:
 * the SecRandomCopyBytes-backed pool in `app/src/msgid.ts` (react-native
 * TurboModule, async refill). The CLI's is not — the CLI has no group
 * fan-out today and calls nothing here; `node:crypto`'s `randomBytes` is the
 * intended binding when it does, and is what the test suite already binds
 * (an earlier version of this comment described that CLI binding as existing
 * code). Importing either source here would make the module unusable by the
 * other client (§4.1), so the byte source arrives as a parameter. There is NO fallback
 * source: a byte source that fails, or returns the wrong shape, throws —
 * never degrade to `Math.random`.
 */

/**
 * The injected byte source. May return synchronously (`crypto.randomBytes`
 * under Node) or as a promise (the app's pool draw, whose refill awaits the
 * native RNG) — both bindings are natural because the caller is awaited
 * either way.
 *
 * Contract: return EXACTLY `byteCount` bytes of platform-CSPRNG output, or
 * throw/reject. Anything else is a hard error here, not a degraded path.
 */
export type Csprng = (byteCount: number) => Uint8Array | Promise<Uint8Array>;

/** Crockford base 32 — the ULID alphabet, matching `frames.ts:9`'s regex
 * `[0-9A-HJKMNP-TV-Z]` (no I, L, O, U). Index i encodes the value i. */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const MSGID_LENGTH = 26;

/**
 * Mint one wire msgId: 26 characters of pure CSPRNG output, first character
 * `0`–`7`, no timestamp, no counter, no relationship to any id before it.
 *
 * Why the byte→symbol mapping is unbiased: one uniform byte feeds each
 * character, and both reductions are power-of-two masks of a power-of-two
 * range. 256 = 8 × 32, so `byte & 31` sends exactly 8 of the 256 byte values
 * to each of the 32 symbols; 256 = 32 × 8, so `byte & 7` sends exactly 32
 * byte values to each of the 8 first-position symbols. Every symbol's
 * preimage class has identical size, so there is no modulo bias and no
 * rejection sampling — unlike a non-power-of-two alphabet (e.g. 10 symbols),
 * where 256 % 10 ≠ 0 makes plain `%` skew low symbols. The tempting shortcut
 * for the first character — draw a full 32-range symbol and clamp into 0–7 —
 * IS biased (a clamp piles 25/32 of the mass onto `7`); the mask is not.
 */
export async function randomMsgId(csprng: Csprng): Promise<string> {
  // Any throw or rejection from the injected source propagates as-is:
  // an id from a weaker source is worse than no id.
  const bytes = await csprng(MSGID_LENGTH);
  if (!(bytes instanceof Uint8Array) || bytes.length !== MSGID_LENGTH) {
    throw new Error(
      `randomMsgId: injected CSPRNG returned ${
        bytes instanceof Uint8Array ? `${bytes.length} bytes` : 'a non-Uint8Array'
      }, expected exactly ${MSGID_LENGTH} — refusing to degrade`,
    );
  }
  return Array.from(bytes, (byte, i) =>
    CROCKFORD.charAt(i === 0 ? byte & 0x07 : byte & 0x1f),
  ).join('');
}
