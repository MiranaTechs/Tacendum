import { z } from 'zod';
import {
  UploadKeysRequest,
  MsgType,
  normalizeOrigin,
  type PrekeyBundle,
} from '@tacendum/shared';
import NativeTacendumCrypto from './NativeTacendumCrypto';

/**
 * Typed JS surface over the native module. This file only parses/validates
 * JSON crossing the bridge — no cryptography.
 */

const EncryptResult = z.object({
  msgType: MsgType,
  payload: z.string(),
});
export type EncryptResult = z.infer<typeof EncryptResult>;

/** The upload payload for the identity already on disk. See the native doc. */
export async function existingKeysForUpload(): Promise<UploadKeysRequest> {
  return UploadKeysRequest.parse(
    JSON.parse(await NativeTacendumCrypto.existingKeysForUpload()),
  );
}

export async function generateAndStoreKeys(): Promise<UploadKeysRequest> {
  const json = await NativeTacendumCrypto.generateAndStoreKeys();
  return UploadKeysRequest.parse(JSON.parse(json));
}

export function hasIdentity(): Promise<boolean> {
  return NativeTacendumCrypto.hasIdentity();
}

export function processPreKeyBundle(
  bundle: PrekeyBundle,
  selfUserId: string,
): Promise<void> {
  return NativeTacendumCrypto.processPreKeyBundle(
    JSON.stringify(bundle),
    selfUserId,
  );
}

export function hasSession(peerUserId: string): Promise<boolean> {
  return NativeTacendumCrypto.hasSession(peerUserId);
}

/** Displayable safety number for (self, peer), or null if not yet pinned. */
export async function safetyNumber(
  selfUserId: string,
  peerUserId: string,
): Promise<string | null> {
  const value = await NativeTacendumCrypto.safetyNumber(selfUserId, peerUserId);
  return value === '' ? null : value;
}

/** Accept a peer's changed identity (re-pins on the next message). */
export function resetPeer(peerUserId: string): Promise<void> {
  return NativeTacendumCrypto.resetPeer(peerUserId);
}

/**
 * True when a native rejection means the store lock timed out.
 *
 * The lock's only other holder is the notification extension, which lives for
 * seconds — so this is transient by construction. The caller must NOT treat it
 * as tamper: no error row, no `seen`, no ack. Left un-acked, the server
 * redelivers and the next attempt finds the lock free.
 */
export function isStoreBusyError(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | null;
  return (
    e?.code === 'store_busy' ||
    String(e?.message ?? '').includes('store_busy')
  );
}

/** True when a native crypto rejection is a peer identity change. */
export function isIdentityChangeError(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | null;
  return (
    e?.code === 'identity_changed' ||
    String(e?.message ?? '').includes('identity_changed')
  );
}

export async function encryptText(
  selfUserId: string,
  peerUserId: string,
  plaintext: string,
): Promise<EncryptResult> {
  const json = await NativeTacendumCrypto.encryptText(
    selfUserId,
    peerUserId,
    plaintext,
  );
  return EncryptResult.parse(JSON.parse(json));
}

/** Rejects loudly on tamper/corruption — callers must handle and never render. */
export function decryptEnvelope(
  selfUserId: string,
  senderUserId: string,
  msgType: MsgType,
  payloadB64: string,
): Promise<string> {
  return NativeTacendumCrypto.decryptEnvelope(
    selfUserId,
    senderUserId,
    msgType,
    payloadB64,
  );
}

const BlobEncryptResult = z.object({ keyB64: z.string(), blobB64: z.string() });
export type BlobEncryptResult = z.infer<typeof BlobEncryptResult>;

/** Encrypt an attachment blob (fresh random key, libsignal AES-256-GCM). */
export async function blobEncrypt(
  plaintextB64: string,
): Promise<BlobEncryptResult> {
  const json = await NativeTacendumCrypto.blobEncrypt(plaintextB64);
  return BlobEncryptResult.parse(JSON.parse(json));
}

/** Decrypt a downloaded blob; rejects loudly on tamper — never render then. */
export function blobDecrypt(keyB64: string, blobB64: string): Promise<string> {
  return NativeTacendumCrypto.blobDecrypt(keyB64, blobB64);
}

/**
 * Argon2-harden a registration PIN into the verifier the server checks.
 * `saltB64` must decode to 32 bytes.
 *
 * Deliberately slow — that slowness is the only thing standing between a
 * four-digit PIN and an offline grind of a leaked users table, so do not
 * call it on a render path.
 */
/**
 * Sign an account challenge. The private key never
 * crosses the bridge; only the resulting signature comes back.
 */
export function signAuthChallenge(
  challengeB64: string,
  apiOrigin: string,
): Promise<string> {
  // Normalised HERE, so the native side never has to. The server verifies
  // against `normalizeOrigin(its own origin)`, and the Swift signer appends the
  // string it is handed verbatim — so an un-normalised origin crossing this
  // bridge signs a different payload than the server checks, and login fails
  // for everyone with `invalid_signature`, an error that points at the
  // cryptography and not at a trailing slash.
  //
  // Not hypothetical: a standalone transcription of the Swift construction run
  // against `packages/shared/authvectors.json` matches on every normalised
  // input and diverges on `https://API.Tacendum.com:443/v1/`. Today's API_BASE
  // happens to be normalised already, which is exactly what would have let this
  // sit until someone added a trailing slash.
  //
  // One normalisation, in the one place all three callers pass through, rather
  // than a fourth copy of the rule in Swift.
  return NativeTacendumCrypto.signAuthChallenge(challengeB64, normalizeOrigin(apiOrigin));
}

/** Identity public key (base64), or null when this install has no identity. */
export async function identityPublicKey(): Promise<string | null> {
  const key = await NativeTacendumCrypto.identityPublicKey();
  return key === '' ? null : key;
}

/** The five link ops the `tacendum-link-v1` domain frames —
 * pinned here so the facade refuses a sixth before the bridge. */
export const LINK_OPS = ['offer', 'accept', 'unlink', 'revoke', 'dissolve'] as const;
export type LinkOp = (typeof LINK_OPS)[number];

/** The full link-op tuple the native signer covers — every
 * preimage field except the op, which frames it. */
export interface LinkOpTuple {
  groupId: string;
  offererUserId: string;
  acceptorUserId: string;
  /** The OTHER party's registered identity public key, standard base64 of
   * the serialized key (the offer names the acceptor's, the acceptance the
   * offerer's, a mutation the target's). */
  subjectIdentityPubKey: string;
  class: 'phone' | 'tablet' | 'desktop';
  rosterEpoch: number;
  offerNonce: string;
  expiresAt: number;
}

/**
 * Sign one link-op preimage with the identity private key.
 * The private key never crosses the bridge; only the
 * signature comes back. The preimage is assembled NATIVELY under the
 * hardcoded `tacendum-link-v1` domain — this facade only validates and
 * formats, exactly as `signAuthChallenge` normalizes the origin: the two
 * integers cross the bridge as `String(n)` so exactly one place decides
 * decimal formatting, and a non-integer here is a caller bug refused before
 * anything is signed.
 */
export function signLinkOp(op: LinkOp, tuple: LinkOpTuple): Promise<string> {
  if (!LINK_OPS.includes(op)) {
    return Promise.reject(new Error('unknown link op'));
  }
  if (
    !Number.isInteger(tuple.rosterEpoch) ||
    tuple.rosterEpoch < 0 ||
    !Number.isInteger(tuple.expiresAt) ||
    tuple.expiresAt < 0
  ) {
    return Promise.reject(new Error('link-op integers must be nonnegative integers'));
  }
  return NativeTacendumCrypto.signLinkOp(
    op,
    tuple.groupId,
    tuple.offererUserId,
    tuple.acceptorUserId,
    tuple.subjectIdentityPubKey,
    tuple.class,
    String(tuple.rosterEpoch),
    tuple.offerNonce,
    String(tuple.expiresAt),
  );
}

/**
 * Verify one link-op identity signature against a caller-supplied identity
 * public key — the client-side verify entry
 * point. The facade applies exactly the signer's guards — same ops, same
 * integer discipline, same `String(n)` formatting authority — so sign and
 * verify can never disagree about what a well-formed tuple is. Answers
 * FALSE for a malformed key or signature (the server-verify contract);
 * rejects only on a malformed tuple, which is a caller bug.
 */
export function verifyLinkOp(
  identityPubKeyB64: string,
  op: LinkOp,
  tuple: LinkOpTuple,
  signatureB64: string,
): Promise<boolean> {
  if (!LINK_OPS.includes(op)) {
    return Promise.reject(new Error('unknown link op'));
  }
  if (
    !Number.isInteger(tuple.rosterEpoch) ||
    tuple.rosterEpoch < 0 ||
    !Number.isInteger(tuple.expiresAt) ||
    tuple.expiresAt < 0
  ) {
    return Promise.reject(new Error('link-op integers must be nonnegative integers'));
  }
  return NativeTacendumCrypto.verifyLinkOp(
    identityPubKeyB64,
    op,
    tuple.groupId,
    tuple.offererUserId,
    tuple.acceptorUserId,
    tuple.subjectIdentityPubKey,
    tuple.class,
    String(tuple.rosterEpoch),
    tuple.offerNonce,
    String(tuple.expiresAt),
    signatureB64,
  );
}

export function pinVerifier(pin: string, saltB64: string): Promise<string> {
  return NativeTacendumCrypto.pinVerifier(pin, saltB64);
}

/** Platform RNG (SecRandomCopyBytes) as raw bytes. */
export async function randomBytes(count: number): Promise<Uint8Array> {
  const b64 = await NativeTacendumCrypto.randomBytes(count);
  return b64Decode(b64);
}

/**
 * SHA-256 of `data` via CryptoKit, the platform's digest.
 * Bytes in, the full 32-byte digest out — this file only carries
 * them across the bridge as base64; the hashing is native and the
 * truncate-to-8-and-encode step belongs to `rosterDigest` in
 * `@tacendum/shared`, where the CLI shares the same copy of it.
 *
 * Sanctioned solely for the group roster digest (`rd`). Hashing anything
 * else through this function is a stop-and-flag, not a convenience.
 */
export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const digest = await NativeTacendumCrypto.sha256(b64Encode(data));
  return b64Decode(digest);
}

const B64_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_LOOKUP = new Map([...B64_ALPHABET].map((c, i) => [c, i] as const));

/** Pure-TS base64 encode (an encoding transform, not cryptography). */
function b64Encode(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : undefined;
    const c = i + 2 < bytes.length ? bytes[i + 2] : undefined;
    out += B64_ALPHABET[a >> 2];
    out += B64_ALPHABET[((a & 0x03) << 4) | ((b ?? 0) >> 4)];
    out += b === undefined ? '=' : B64_ALPHABET[((b & 0x0f) << 2) | ((c ?? 0) >> 6)];
    out += c === undefined ? '=' : B64_ALPHABET[c & 0x3f];
  }
  return out;
}

/** Pure-TS base64 decode (an encoding transform, not cryptography). */
function b64Decode(b64: string): Uint8Array {
  const clean = b64.replace(/=+$/, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let buffer = 0;
  let bits = 0;
  let index = 0;
  for (const char of clean) {
    const value = B64_LOOKUP.get(char);
    if (value === undefined)
      throw new Error('invalid base64 from native module');
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[index++] = (buffer >> bits) & 0xff;
    }
  }
  return out;
}

/** Keychain-backed secret storage. Returns null when absent. */
export async function getSecret(key: string): Promise<string | null> {
  const value = await NativeTacendumCrypto.getSecret(key);
  return value === '' ? null : value;
}

export function setSecret(key: string, value: string): Promise<void> {
  return NativeTacendumCrypto.setSecret(key, value);
}

export function deleteSecret(key: string): Promise<void> {
  return NativeTacendumCrypto.deleteSecret(key);
}

/**
 * File-backed state the notification-service extension will read.
 *
 * Deliberately NOT the Keychain: an extension reaches Keychain items only
 * through a shared access group, and adding one rewrites the access group of
 * items that already exist — the lock passcode verifier among them. A settings
 * change must not be able to lock someone out of their own app.
 *
 * `null` when absent, matching `getSecret`. Absence is a real state here and
 * every caller has a safe default for it, which is what makes "delete the file
 * to disarm" work: nothing to read means the safe answer.
 */
export async function readSharedState(name: string): Promise<string | null> {
  const value = await NativeTacendumCrypto.readSharedState(name);
  return value === '' ? null : value;
}

export function writeSharedState(name: string, value: string): Promise<void> {
  return NativeTacendumCrypto.writeSharedState(name, value);
}

export function deleteSharedState(name: string): Promise<void> {
  return NativeTacendumCrypto.deleteSharedState(name);
}

/** Where the SQLite databases live, and whether the backup-exclusion flag is
 * actually on that directory. */
export interface DatabaseDirectory {
  /** Absolute path of the excluded directory; pass to op-sqlite `location`. */
  location: string;
  /** False when the exclusion attribute could not be set. The database still
   * opens — the flag is hardening, not correctness — but the caller must make
   * the failure visible instead of swallowing it, which is how the old
   * per-file design shipped broken for months. */
  excluded: boolean;
}

/**
 * Prepare the backup-excluded directory the databases live in (running the
 * one-time migration from the old Library-root location) and say where to
 * open `fileName`. Synchronous, because it must complete before op-sqlite's
 * `open()` — see the spec for the whole argument.
 *
 * Throws when the directory itself cannot be prepared: opening the database
 * anywhere else would either recreate the un-excluded layout or mint a fresh
 * empty file, so the caller must fail loudly instead.
 */
export function prepareDatabaseDirectory(fileName: string): DatabaseDirectory {
  const raw = NativeTacendumCrypto.prepareDatabaseDirectory(fileName);
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  const record =
    parsed !== null && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : null;
  if (record && typeof record.location === 'string' && record.location !== '') {
    return { location: record.location, excluded: record.excluded === true };
  }
  throw new Error(
    record && typeof record.error === 'string' && record.error !== ''
      ? record.error
      : 'database directory unavailable',
  );
}

/** One message the notification extension decrypted before the app saw it. */
export interface InboxEntry {
  msgId: string;
  from: string;
  ts: number;
  body: string;
}

/**
 * What the extension decrypted while the app was not running.
 *
 * Returns [] rather than throwing on a malformed spool: these are read on the
 * launch path, and a single bad file must not stop the app opening.
 */
export async function readInbox(): Promise<InboxEntry[]> {
  try {
    const parsed: unknown = JSON.parse(await NativeTacendumCrypto.readInbox());
    return Array.isArray(parsed) ? (parsed as InboxEntry[]) : [];
  } catch {
    return [];
  }
}

export function clearInboxEntry(msgId: string): Promise<void> {
  return NativeTacendumCrypto.clearInboxEntry(msgId);
}

export function resetProtocolState(): Promise<void> {
  return NativeTacendumCrypto.resetProtocolState();
}
