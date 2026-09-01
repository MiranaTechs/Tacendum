/**
 * Attachment-blob cipher — THE ONLY FILE in this repository permitted to call
 * `crypto.createCipheriv` / `crypto.createDecipheriv`.
 * `scripts/audit-attachment-cipher.sh` fails the release gate if either name
 * appears anywhere else under packages/ or app/.
 *
 * Scope: AES-256-GCM over ATTACHMENT BLOBS and nothing else. Never message
 * text, envelopes, journals, or anything on disk. The framing is libsignal's
 * own `Aes256GcmEncryptedData.concatenate()` layout, byte for byte:
 *
 *     nonce(12) ‖ ciphertext ‖ tag(16)     AAD empty, key 32 bytes, min 28.
 *
 * NO version byte inside the blob, ever: an in-band discriminator would sit
 * outside the AEAD, be mutable by anyone with write access to the blob store,
 * and create two length arithmetics over one buffer (C5). Any future version
 * goes in the message envelope, which rides the ratchet.
 *
 * FORBIDDEN VARIANTS, BY NAME (C3 makes this header part of the permission):
 * no STREAMING decrypt, no CHUNKED decrypt, no PIPED decrypt — no exported
 * cipher/decipher object, no Transform/pipeline wrapper, no incremental
 * `update()` API, no partial-output form. Measured on node v22.21.1: on a
 * tampered ciphertext `update()` returns readable tampered plaintext BEFORE
 * `final()` throws, and this CLI hands decrypted bytes to an agent that acts
 * on what it reads. Decrypt is exactly ONE function whose intermediate
 * buffers never escape.
 *
 * Also mandatory here, each closing a footgun measured on node v22.21.1:
 *  - `{ authTagLength: 16 }` on BOTH cipher and decipher (C1) — without it,
 *    a 4-byte tag verifies: a 2^-32 forgery.
 *  - key/nonce lengths asserted in code on every path (C2) — createCipheriv
 *    silently accepts 8/16/32-byte IVs.
 *  - encrypt-then-verify before any upload (C4) — decrypt what was just
 *    produced and compare, bounded by MAX_ATTACHMENT_BYTES.
 *  - errors name lengths and carry NO key, nonce, plaintext or ciphertext
 *    bytes.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { MAX_ATTACHMENT_BYTES } from '@tacendum/shared';

export const BLOB_KEY_BYTES = 32;
export const BLOB_NONCE_BYTES = 12;
export const BLOB_TAG_BYTES = 16;
/** nonce + tag: what an empty plaintext seals to. Anything shorter is torn. */
export const BLOB_MIN_BYTES = BLOB_NONCE_BYTES + BLOB_TAG_BYTES;

/** Which guard rejected — the vector suite asserts on THIS, not on prose. */
export type BlobCipherCheck =
  | 'key-length'
  | 'nonce-length'
  | 'blob-length'
  | 'auth'
  | 'verify-mismatch'
  | 'too-large';

/**
 * Every refusal names lengths and contains no bytes. The `check`
 * discriminant exists so tests prove WHICH guard fired rather than matching
 * message prose.
 */
export class BlobCipherError extends Error {
  constructor(
    readonly check: BlobCipherCheck,
    message: string,
  ) {
    super(message);
    this.name = 'BlobCipherError';
  }
}

function assertKeyNonce(key: Uint8Array, nonce: Uint8Array): void {
  // C2 — in code, on every path, not only in vectors: createCipheriv
  // silently accepted 8-, 16- and 32-byte IVs on node v22.21.1.
  if (key.length !== BLOB_KEY_BYTES) {
    throw new BlobCipherError(
      'key-length',
      `attachment key must be ${BLOB_KEY_BYTES} bytes; got ${key.length}`,
    );
  }
  if (nonce.length !== BLOB_NONCE_BYTES) {
    throw new BlobCipherError(
      'nonce-length',
      `attachment nonce must be ${BLOB_NONCE_BYTES} bytes; got ${nonce.length}`,
    );
  }
}

/** The 10 MB cap is on the base64 TEXT of the blob — that is what the server
 * signs into the presigned PUT (dto.ts MAX_ATTACHMENT_BYTES, storage.ts). */
function b64Length(rawBytes: number): number {
  return 4 * Math.ceil(rawBytes / 3);
}

// The one place both real paths and the C1 probes build their cipher objects,
// so removing `authTagLength` anywhere turns the probe tests red.
function newCipher(key: Uint8Array, nonce: Uint8Array) {
  assertKeyNonce(key, nonce);
  return createCipheriv('aes-256-gcm', key, nonce, { authTagLength: BLOB_TAG_BYTES });
}
function newDecipher(key: Uint8Array, nonce: Uint8Array) {
  assertKeyNonce(key, nonce);
  return createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: BLOB_TAG_BYTES });
}

function seal(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array): Uint8Array {
  const c = newCipher(key, nonce);
  // AAD stays empty (C5): no setAAD call exists in this file.
  const body = Buffer.concat([c.update(plaintext), c.final()]);
  const tag = c.getAuthTag();
  return new Uint8Array(Buffer.concat([nonce, body, tag]));
}

/**
 * Decrypt an attachment blob. ONE function, no streaming form (C3): the
 * intermediate `update()` output never leaves this frame, so tampered input
 * yields an error and ZERO plaintext — structurally, not by caller courtesy.
 */
export function decryptBlob(key: Uint8Array, blob: Uint8Array): Uint8Array {
  if (key.length !== BLOB_KEY_BYTES) {
    throw new BlobCipherError(
      'key-length',
      `attachment key must be ${BLOB_KEY_BYTES} bytes; got ${key.length}`,
    );
  }
  if (blob.length < BLOB_MIN_BYTES) {
    throw new BlobCipherError(
      'blob-length',
      `attachment blob must be at least ${BLOB_MIN_BYTES} bytes (nonce ${BLOB_NONCE_BYTES} + tag ${BLOB_TAG_BYTES}); got ${blob.length}`,
    );
  }
  const nonce = blob.subarray(0, BLOB_NONCE_BYTES);
  const ciphertext = blob.subarray(BLOB_NONCE_BYTES, blob.length - BLOB_TAG_BYTES);
  const tag = blob.subarray(blob.length - BLOB_TAG_BYTES);
  const d = newDecipher(key, nonce);
  d.setAuthTag(tag);
  try {
    return new Uint8Array(Buffer.concat([d.update(ciphertext), d.final()]));
  } catch {
    // The tag did not verify. The caught error and the buffers stay here;
    // nothing about the bytes reaches the message.
    throw new BlobCipherError('auth', 'attachment blob failed authentication');
  }
}

/**
 * Encrypt an attachment blob for upload: fresh 32-byte key and fresh
 * 12-byte nonce from the platform CSPRNG, used exactly once — a key is never
 * reused across two encryptions (item 13 stop-and-flag). Then ENCRYPT-THEN-
 * VERIFY (C4): the blob just produced is decrypted and compared before it is
 * allowed anywhere near an upload — the only check that covers nonce,
 * framing and truncation on the real path rather than the vector path.
 */
export function encryptBlob(plaintext: Uint8Array): { key: Uint8Array; blob: Uint8Array } {
  const cipherB64 = b64Length(plaintext.length + BLOB_MIN_BYTES);
  if (cipherB64 > MAX_ATTACHMENT_BYTES) {
    throw new BlobCipherError(
      'too-large',
      `attachment of ${plaintext.length} bytes would upload as ${cipherB64} base64 characters, over the ${MAX_ATTACHMENT_BYTES} cap`,
    );
  }
  const key = new Uint8Array(randomBytes(BLOB_KEY_BYTES));
  const nonce = new Uint8Array(randomBytes(BLOB_NONCE_BYTES));
  const blob = seal(key, nonce, plaintext);
  const readBack = decryptBlob(key, blob);
  if (Buffer.compare(readBack, plaintext) !== 0) {
    throw new BlobCipherError(
      'verify-mismatch',
      'encrypt-then-verify failed: the blob just produced did not decrypt back to its plaintext',
    );
  }
  return { key, blob };
}

/**
 * FOR THE BYTE-PARITY VECTOR SUITE ONLY (B-3): seal with a caller-supplied
 * nonce so the app-generated fixture (which pins the nonce in its blob bytes)
 * can check the ENCRYPT direction byte-exactly. Production code must never
 * call this — a caller-chosen nonce plus a reused key is the one failure
 * AES-GCM cannot survive. The real path is `encryptBlob`, which mints both.
 */
export function sealForParityVectors(
  key: Uint8Array,
  nonce: Uint8Array,
  plaintext: Uint8Array,
): Uint8Array {
  return seal(key, nonce, plaintext);
}

/**
 * C1 probes — the only way a unit test can SEE that `authTagLength: 16` is
 * live on the real construction path (the blob framing always slices a
 * 16-byte tag, so no well-formed input exercises it; that is exactly why the
 * measured 4-byte-tag forgery was invisible to the vector gate). They build
 * through the same `newCipher`/`newDecipher` the real paths use and expose
 * no decrypt capability.
 */
export function probeCipherTagLength(): number {
  const c = newCipher(new Uint8Array(BLOB_KEY_BYTES), new Uint8Array(BLOB_NONCE_BYTES));
  c.update(new Uint8Array(1));
  c.final();
  return c.getAuthTag().length;
}
export function probeDecipherRejectsShortTag(tagBytes: number): boolean {
  const d = newDecipher(new Uint8Array(BLOB_KEY_BYTES), new Uint8Array(BLOB_NONCE_BYTES));
  try {
    d.setAuthTag(new Uint8Array(tagBytes));
    return false; // accepted — C1 is not live
  } catch {
    return true; // rejected, as {authTagLength:16} mandates
  }
}
