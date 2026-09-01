import * as libsignal from '@signalapp/libsignal-client';

/**
 * THE server-side identity-signature verify and its byte helpers — moved
 * out of `auth-account.ts` which re-exports
 * `verifyIdentitySignature` so every existing consumer (the auth path,
 * devices-signed.ts, the test suites) keeps the one symbol they all
 * point at. A LEAF module on purpose: its
 * only dependency is libsignal itself, so the app's cross-language vector
 * suite (app/__tests__/link-vectors.test.ts) can run the server's genuine
 * verify without dragging the server's DynamoDB/limits graph into a React
 * Native jest runtime. ONE adaptation beside the move, behavior-preserving:
 * the two `Buffer.from(..., 'base64')` decodes became the pure
 * `bytesFromBase64` below (an encoding transform, not cryptography), so the
 * app's RN typecheck can follow this import without Node's globals —
 * malformed base64 still lands in the same catch → false paths.
 */

const B64_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_LOOKUP = new Map([...B64_ALPHABET].map((c, i) => [c, i] as const));

/** Standard base64 → bytes. Throws on any non-alphabet character — the two
 * call sites both treat a throw as "not a key" / "not a signature", exactly
 * where Buffer's silent tolerance also ended up: `false`, never a 500. */
function bytesFromBase64(b64: string): Uint8Array {
  const clean = b64.replace(/=+$/, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let buffer = 0;
  let bits = 0;
  let index = 0;
  for (const char of clean) {
    const value = B64_LOOKUP.get(char);
    if (value === undefined) throw new Error('invalid base64');
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[index++] = (buffer >> bits) & 0xff;
    }
  }
  return out;
}

/** libsignal public key, or undefined if the bytes are not one.
 *
 * Never let a malformed key reach the database: a challenge stored against a
 * string that can never verify is a row nobody can ever consume. */
export function publicKeyOf(identityKeyB64: string): libsignal.PublicKey | undefined {
  try {
    return libsignal.PublicKey.deserialize(concatBytes(bytesFromBase64(identityKeyB64)));
  } catch {
    return undefined;
  }
}

/**
 * Concatenate into a Uint8Array backed by a real ArrayBuffer.
 *
 * libsignal's signatures require `Uint8Array<ArrayBuffer>`, while Node's
 * Buffer is typed over `ArrayBufferLike` — which also admits SharedArrayBuffer
 * and so will not satisfy it. Allocating the buffer explicitly is the honest
 * fix; a cast here would silence a real distinction.
 */
export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const total = parts.reduce((n, part) => n + part.length, 0);
  const out = new Uint8Array(new ArrayBuffer(total));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * THE server-side identity-signature verify ('s server carve-in): libsignal `PublicKey.verify`
 * over caller-supplied bytes, false for anything malformed — a bad key, bad
 * signature bytes, or a wrong signature are indistinguishable to the caller
 * and none of them may 500.
 *
 * EXPORTED as one function on purpose: the device-linking routes (devices-signed.ts) verify their op-framed `tacendum-link-v1` preimages through this
 * exact call, so "the same server verify the auth path uses" is a fact about
 * one symbol rather than a claim about two copies. No new primitive, no new
 * library, no key derivation.
 */
export function verifyIdentitySignature(
  identityKeyB64: string,
  message: Uint8Array,
  signatureB64: string,
): boolean {
  const publicKey = publicKeyOf(identityKeyB64);
  if (!publicKey) return false;
  try {
    return publicKey.verify(
      concatBytes(message),
      concatBytes(bytesFromBase64(signatureB64)),
    );
  } catch {
    // Malformed signature bytes: indistinguishable from a wrong signature as
    // far as the caller is concerned, and it must not 500.
    return false;
  }
}
