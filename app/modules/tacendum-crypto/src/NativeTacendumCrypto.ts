import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

/**
 * TurboModule spec for the Tacendum crypto module (codegen input).
 *
 * Every cryptographic operation is a libsignal call executed in Swift;
 * protocol state (identity, prekeys, sessions) never
 * crosses the bridge. Binary values are base64 strings; structured values
 * are JSON strings validated with zod on the JS side.
 */
export interface Spec extends TurboModule {
  // --- key management (registration) ---

  /**
   * Generate identity + signed prekey + kyber prekey + one-time prekeys,
   * persist private halves natively, return the public halves as a JSON
   * UploadKeysRequest (the PUT /v1/keys shape).
   */
  generateAndStoreKeys(): Promise<string>;

  /**
   * The full key bundle for an identity that already exists, rebuilt from the
   * stored records. What lets registration keep an identity instead of
   * destroying it — PUT /v1/keys upserts for the same identity key, so
   * re-uploading is idempotent. Throws when there is no identity.
   */
  existingKeysForUpload(): Promise<string>;

  /** True once generateAndStoreKeys has run on this install. */
  hasIdentity(): Promise<boolean>;

  // --- account authentication ---

  /**
   * Sign a server-issued challenge with the identity private key.
   *
   * Signs `tacendum-auth-v2` ‖ uint16be(len(origin)) ‖ origin ‖ RAW DECODED
   * challenge bytes — NOT the base64 text. The server verifies exactly those
   * bytes; a mismatch here compiles, passes unit tests on both sides, and
   * makes login impossible for everyone.
   *
   * `apiOrigin` is the audience and is what stops a
   * signature minted against one endpoint being redeemed at another. It is
   * passed in rather than read natively so there is exactly one place — TS —
   * that decides which server this install talks to.
   */
  signAuthChallenge(challengeB64: string, apiOrigin: string): Promise<string>;

  /** The account's identity public key (base64), or '' if none exists yet.
   * Needed to re-authenticate an install whose keys were generated earlier. */
  identityPublicKey(): Promise<string>;

  // --- device linking ---

  /**
   * Sign one op-framed link-op preimage with the identity private key:
   *
   *   "tacendum-link-v1" ‖ op ‖ groupId ‖ offererUlid ‖ acceptorUlid ‖
   *   subjectIdentityPubKey ‖ class ‖ rosterEpoch ‖ offerNonce ‖ expiresAt
   *
   * — EVERY field after the domain uint16be-length-prefixed, the
   * `linkOpSignedBytes()` discipline (packages/shared/src/dto.ts is the
   * authority; `packages/shared/linkvectors.json` pins the bytes and
   * `linkvectors-swift.json` pins the device-run agreement).
   *
   * `subjectIdentityPubKeyB64` decodes to the RAW serialized key bytes before
   * prefixing — the key IS bytes; signing its base64 spelling would make the
   * signature depend on a transport encoding. `rosterEpoch` and `expiresAt`
   * arrive as ASCII-decimal STRINGS (`String(n)` in the facade): exactly one
   * place — TS — decides integer formatting, the same split that keeps origin
   * normalization out of the native signer.
   *
   * Same primitive as `signAuthChallenge` (libsignal identity-key signature
   * — no new cryptography); the domain tag is hardcoded
   * natively exactly as `tacendum-auth-v2` is, so no caller
   * can re-aim the identity key at a different preimage family.
   */
  signLinkOp(
    op: string,
    groupId: string,
    offererUserId: string,
    acceptorUserId: string,
    subjectIdentityPubKeyB64: string,
    deviceClass: string,
    rosterEpoch: string,
    offerNonce: string,
    expiresAt: string,
  ): Promise<string>;

  /**
   * Verify one op-framed link-op identity signature — the client-side
   * VERIFY entry point:
   * the SAME preimage assembly as `signLinkOp` above (one native builder,
   * shared — the linkvectors fixtures pin its bytes), checked with
   * libsignal's `PublicKey.verifySignature` against a caller-supplied
   * identity public key. This is what lets a client verify a peer's link
   * CERTIFICATE against a key it already pinned — server storage stays
   * availability, never authority — and a signed
   * unlink/revoke/dissolve notice against the acting member's pinned key.
   *
   * Same primitive family as the server's `verifyIdentitySignature`
   * (libsignal identity sign/VERIFY — no new
   * cryptography, no key derivation). Malformed key or signature bytes
   * answer FALSE, exactly as the server's verify does: a bad certificate is
   * indistinguishable from a wrong one, and neither may throw past the
   * caller's refusal path. A malformed TUPLE (unknown op, empty field,
   * non-decimal integer) still rejects — that is a caller bug, mirroring
   * the signer's guards.
   */
  verifyLinkOp(
    identityPubKeyB64: string,
    op: string,
    groupId: string,
    offererUserId: string,
    acceptorUserId: string,
    subjectIdentityPubKeyB64: string,
    deviceClass: string,
    rosterEpoch: string,
    offerNonce: string,
    expiresAt: string,
    signatureB64: string,
  ): Promise<boolean>;

  // --- sessions / messaging ---

  /** X3DH/PQXDH bootstrap from a fetched prekey-bundle JSON (GET /v1/keys). */
  processPreKeyBundle(bundleJson: string, selfUserId: string): Promise<void>;

  hasSession(peerUserId: string): Promise<boolean>;

  /** Displayable safety number for (self, peer); '' if the peer isn't pinned. */
  safetyNumber(selfUserId: string, peerUserId: string): Promise<string>;

  /** Accept a peer's changed identity: forget the pin + session (re-pin next). */
  resetPeer(peerUserId: string): Promise<void>;

  /** Returns JSON {"msgType":"prekey"|"ciphertext","payload":"<b64>"}. */
  encryptText(
    selfUserId: string,
    peerUserId: string,
    plaintext: string,
  ): Promise<string>;

  /** Returns UTF-8 plaintext; rejects loudly on tamper/corruption. */
  decryptEnvelope(
    selfUserId: string,
    senderUserId: string,
    msgType: string,
    payloadB64: string,
  ): Promise<string>;

  // --- attachment blob crypto (libsignal AES-256-GCM) ---

  /**
   * Encrypt an attachment blob under a fresh random 32-byte key. Returns JSON
   * {"keyB64":"<b64 key>","blobB64":"<b64 nonce+ciphertext+tag>"}; the key is
   * shipped to the recipient only inside the Signal-encrypted message.
   */
  blobEncrypt(plaintextB64: string): Promise<string>;

  /** Decrypt a downloaded blob; rejects loudly on tamper (GCM tag). */
  blobDecrypt(keyB64: string, blobB64: string): Promise<string>;

  // --- registration lock ---

  /**
   * Argon2-harden a registration PIN into the 32-byte verifier the server
   * stores a digest of. `saltB64` must decode to exactly 32 bytes.
   *
   * libsignal's PinHash — the same primitive Signal uses for PINs:
   * no hand-rolled KDF and no CommonCrypto. Slow by design; call it off
   * any path where a person is waiting on a frame.
   */
  pinVerifier(pin: string, saltB64: string): Promise<string>;

  // --- platform RNG + Keychain ---

  /** count bytes from SecRandomCopyBytes, base64-encoded. */
  randomBytes(count: number): Promise<string>;

  /**
   * SHA-256 of the decoded bytes, base64-encoded — CryptoKit.SHA256, the
   * platform's digest.
   *
   * Sanctioned SOLELY for the group roster digest (`rd`): it hashes a
   * list of user ids the client already holds in the
   * clear, performs no key agreement, no encryption and no signature, and a
   * mismatch is disclosure to a human, never an authorization decision. Any
   * other caller — and any other primitive — is a stop-and-flag.
   */
  sha256(dataB64: string): Promise<string>;

  /** Keychain get; resolves to '' when the key is absent. */
  getSecret(key: string): Promise<string>;

  setSecret(key: string, value: string): Promise<void>;

  deleteSecret(key: string): Promise<void>;

  // --- shared state ---

  /**
   * Small files in a directory the notification-service extension will be able
   * to read, once it shares a container with the app.
   *
   * NOT the Keychain, which an extension can only reach through a
   * `keychain-access-groups` entitlement — and adding one changes the access
   * group of items that already exist, including the lock passcode verifier.
   * NOT SQLite, which is a JSI HostObject and would boot Hermes inside a
   * process with ~24 MB of dirty memory to spend.
   *
   * `name` must be lowercase letters, digits and hyphens: it becomes a path,
   * and the protocol store is the sibling directory.
   */
  writeSharedState(name: string, value: string): Promise<void>;

  /** '' when the file does not exist. Absence is a state, not an error. */
  readSharedState(name: string): Promise<string>;

  deleteSharedState(name: string): Promise<void>;

  /**
   * Prepare the backup-excluded DIRECTORY the SQLite databases live in, and
   * return where to open the named database: a JSON string, either
   * `{"location":"<absolute dir>","excluded":true|false}` or
   * `{"error":"<generic reason>"}`.
   *
   * EXISTS BECAUSE THE MESSAGE DATABASE WAS IN PEOPLE'S BACKUPS. It is plain
   * SQLite by design — at-rest protection is iOS Data Protection, not app-side
   * crypto — and Data Protection says nothing about the backup service. Only
   * the key store and a QR scratch directory were ever excluded, so an iCloud
   * backup, which is on by default, contained the full plaintext history and
   * every image in it, while the site said there was no backup at all.
   *
   * A DIRECTORY, not a list of files, because these databases run SQLite's
   * default DELETE journal mode: the sidecar that actually exists next to
   * them is `<db>-journal` — plaintext page pre-images, created during every
   * write transaction and persisting after a crash as a hot journal — and a
   * per-file flag can only reach files that exist at the moment it runs. iOS
   * backups skip an excluded directory's entire subtree, so everything SQLite
   * ever creates in the directory is covered from birth. See
   * `DatabaseDirectory.swift` for the full argument and the one-time
   * migration from the old Library-root location.
   *
   * The KEYS stay excluded, which is what keeps "lose the phone and the
   * account is gone" true. This makes the message text match that promise.
   *
   * SYNCHRONOUS (non-Promise, a TurboModule sync method) because the caller
   * (`db.ts` `conn()`) is synchronous and the migration must complete before
   * op-sqlite's `open()` touches the new path — an open that ran first would
   * mint a fresh empty database there, and the migration would then refuse to
   * overwrite it, leaving every existing install looking wiped.
   *
   * Takes a file NAME rather than a path because the caller owns the
   * filenames and there are two of them — the real workspace and the decoy —
   * and a decoy database left in a backup would defeat the point of having
   * one. `excluded:false` (attribute write failed — hardening, not
   * correctness; the caller warns and opens anyway) is distinct from `error`
   * (the directory itself cannot be prepared; the caller must fail the open
   * loudly rather than open somewhere else). Error strings are generic and
   * name no files (a message naming the decoy would
   * prove the decoy is armed).
   */
  prepareDatabaseDirectory(fileName: string): string;

  // --- inbox spool ---

  /**
   * JSON array of everything the notification extension decrypted and the app
   * has not yet taken: `{ msgId, from, ts, body }`.
   *
   * These cannot be re-fetched. The extension consumed their ratchet keys, so
   * the server's copy of the ciphertext is already undecryptable — which is
   * why they are read here and deleted one at a time, after each is committed.
   */
  readInbox(): Promise<string>;

  /** Drop one entry, once it is durably stored. */
  clearInboxEntry(msgId: string): Promise<void>;

  // --- dev/testing ---

  /** Wipe all protocol state + secrets (fresh-install simulation). */
  resetProtocolState(): Promise<void>;
}

export default TurboModuleRegistry.getEnforcing<Spec>('TacendumCrypto');
