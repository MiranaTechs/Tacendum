import {
  CiphertextMessageType,
  ErrorCode,
  Fingerprint,
  IdentityKeyPair,
  KEMKeyPair,
  KyberPreKeyRecord,
  LibSignalErrorBase,
  PreKeyBundle,
  PreKeyRecord,
  PreKeySignalMessage,
  PrivateKey,
  ProtocolAddress,
  PublicKey,
  KEMPublicKey,
  SignalMessage,
  SignedPreKeyRecord,
  processPreKeyBundle,
  signalDecrypt,
  signalDecryptPreKey,
  signalEncrypt,
} from '@signalapp/libsignal-client';
import { randomInt } from 'node:crypto';
import { closeSync, fsyncSync, ftruncateSync, openSync, readFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { authSignedBytes } from '@tacendum/shared';
import type { MsgType, UploadKeysRequest, PrekeyBundle as BundleDto } from '@tacendum/shared';
import { writeFileAtomic, type FileStores } from './stores.js';
import { b64ToBytes, bytesToB64, bytesToUtf8, utf8ToBytes } from './bytes.js';
import { API_BASE } from './config.js';

/**
 * All Signal-protocol operations for the CLI. Every call that touches key
 * material or content is a libsignal call; this file only
 * sequences them and moves base64 bytes.
 *
 * The one exception, and it used to be an untrue "every cryptographic call is
 * a libsignal call": `randomInt` below draws the libsignal registration id
 * from the platform CSPRNG. That is entropy for an
 * identifier, not a primitive this file implements — and the sentence before
 * it once named the wrong thing.
 */

export const DEVICE_ID = 1;
const SIGNED_PREKEY_ID = 1;
const KYBER_PREKEY_ID = 1;
const ONE_TIME_PREKEY_COUNT = 100;

/** Safety-number parameters. MUST match the native app (TacendumCryptoImpl)
 * so the same pair shows the same number on the CLI and in the app. */
const SAFETY_ITERATIONS = 5200;
const SAFETY_VERSION = 0;

export function address(userId: string): ProtocolAddress {
  return ProtocolAddress.new(userId, DEVICE_ID);
}

/** True when a libsignal call refused a peer whose identity key changed
 * (safety number changed) — the block half of block-and-warn. */
export function isIdentityChange(err: unknown): boolean {
  return err instanceof LibSignalErrorBase && err.code === ErrorCode.UntrustedIdentity;
}

/**
 * The displayable safety number for (self, peer) — the same 60-digit value on
 * both ends of a healthy session. Returns null if the peer's identity is not
 * yet pinned (no session established). Pure libsignal.
 */
export async function computeSafetyNumber(
  stores: FileStores,
  selfUserId: string,
  peerUserId: string,
): Promise<string | null> {
  const peerKey = await stores.identity.getIdentity(address(peerUserId));
  if (!peerKey) return null;
  const selfKey = stores.identity.getPublicIdentityKey();
  const fingerprint = Fingerprint.new(
    SAFETY_ITERATIONS,
    SAFETY_VERSION,
    utf8ToBytes(selfUserId),
    selfKey,
    utf8ToBytes(peerUserId),
    peerKey,
  );
  return fingerprint.displayableFingerprint().toString();
}

/** Accept a changed identity: forget the pinned peer identity + session so the
 * next contact re-pins (TOFU) and rebuilds the ratchet. */
export function acceptPeerIdentityChange(stores: FileStores, peerUserId: string): void {
  stores.identity.clearPeer(address(peerUserId));
  stores.sessions.clear(address(peerUserId));
}

/**
 * Generate a fresh identity + prekeys at registration, persist private halves
 * to the stores, and return the public halves in upload shape.
 */
export async function generateAndStoreKeys(stores: FileStores): Promise<UploadKeysRequest> {
  const identity = IdentityKeyPair.generate();
  // 14-bit registration id, matching Signal convention.
  const registrationId = randomInt(1, 16384);
  stores.identity.initialize(identity, registrationId);

  const now = Date.now();

  // Signed (EC) prekey: signature over the serialized public key.
  const spkPriv = PrivateKey.generate();
  const spkSig = identity.privateKey.sign(spkPriv.getPublicKey().serialize());
  const spkRecord = SignedPreKeyRecord.new(
    SIGNED_PREKEY_ID,
    now,
    spkPriv.getPublicKey(),
    spkPriv,
    spkSig,
  );
  await stores.signedPrekeys.saveSignedPreKey(SIGNED_PREKEY_ID, spkRecord);

  // Signed last-resort Kyber prekey (PQXDH).
  const kyberPair = KEMKeyPair.generate();
  const kyberSig = identity.privateKey.sign(kyberPair.getPublicKey().serialize());
  const kyberRecord = KyberPreKeyRecord.new(KYBER_PREKEY_ID, now, kyberPair, kyberSig);
  await stores.kyberPrekeys.saveKyberPreKey(KYBER_PREKEY_ID, kyberRecord);

  // One-time (EC) prekeys.
  const oneTimePrekeys: { keyId: number; pub: string }[] = [];
  for (let id = 1; id <= ONE_TIME_PREKEY_COUNT; id++) {
    const priv = PrivateKey.generate();
    await stores.prekeys.savePreKey(id, PreKeyRecord.new(id, priv.getPublicKey(), priv));
    oneTimePrekeys.push({ keyId: id, pub: bytesToB64(priv.getPublicKey().serialize()) });
  }
  // `savePreKey` is deliberately not durable per-write; durability is owed
  // BEFORE the upload advertises these ids, and this payload feeds that
  // upload — so the batch is flushed here, while a failure can still refuse
  // registration instead of publishing keys that are not on disk.
  await stores.prekeys.persistBatch(oneTimePrekeys.map((p) => p.keyId));
  // The high-water mark starts here, not at the next rotation: if the highest
  // of these is consumed (and its file deleted) before the first re-register,
  // an id derived from the directory alone would hand it out a second time.
  stores.prekeys.advanceTo(ONE_TIME_PREKEY_COUNT + 1);

  return {
    registrationId,
    identityKey: bytesToB64(identity.publicKey.serialize()),
    signedPrekey: {
      keyId: SIGNED_PREKEY_ID,
      pub: bytesToB64(spkPriv.getPublicKey().serialize()),
      sig: bytesToB64(spkSig),
    },
    kyberPrekey: {
      keyId: KYBER_PREKEY_ID,
      pub: bytesToB64(kyberPair.getPublicKey().serialize()),
      sig: bytesToB64(kyberSig),
    },
    oneTimePrekeys,
  };
}

/**
 * Prekey ids are a 24-bit space by Signal convention. Rotation only ever
 * allocates upward, so this is the point at which a client has re-registered
 * ~167,000 times and something is wrong; refusing beats silently reissuing an
 * id whose private half is still on disk under a different key.
 */
const MAX_PREKEY_ID = 0xffffff;

/**
 * Marker naming the ids of the most recently minted one-time prekey batch,
 * alive only while that batch is PROVABLY unpublished. Its whole job is to let
 * the next rotation RE-OFFER the previous attempt's batch instead of minting
 * another one: without it, every registration that failed before
 * `PUT /v1/keys` left 100 orphaned private-key files and burned 100 ids, and a
 * cron-retried register against a dead endpoint grew both without bound (found
 * across two review passes — the first fix pruned the batch and then
 * allocated a FRESH one, which bounded the file count but still burned 100 ids
 * a minute, exhausting the 24-bit space in ~116 days and refusing registration
 * from then on even after the endpoint recovered).
 *
 * The proof the marker carries: publication happens ONLY via the one
 * `apiUploadKeys` call in cmdRegister, which runs under register.lock in the
 * fixed order rotate -> signAuthChallenge -> upload. `signAuthChallenge`
 * durably retires this marker, so a marker that still exists means no auth
 * signature — and therefore no token, and therefore no upload — has followed
 * that batch's mint. The server never saw those ids, so no sender can hold
 * one, so re-offering them cannot collide with a bundle already handed out.
 *
 * REUSE, NOT RECLAIM, is what the marker now licenses, and the direction
 * matters if the marker is ever wrong: deleting a batch the server DID publish
 * loses every message queued against all 100 ids, while re-offering it can
 * only lose the ones the server both handed out already and hands out a second
 * time. Fewer keys are staked on the same evidence, and no id is consumed.
 */
function unpublishedBatchPath(stores: FileStores): string {
  return join(stores.root, 'prekeys-unpublished.json');
}

/**
 * A retired marker's bytes. Deliberately SHORTER than any live marker, so a
 * retirement torn by a crash leaves `[]` followed by the tail of the old
 * array — text that fails `JSON.parse` and therefore proves nothing, which is
 * the safe reading.
 */
const RETIRED_MARKER = '[]';

/**
 * Ids the marker licenses re-offering. Missing and corrupt both mean "prove
 * nothing": a leaked batch costs bytes and 100 ids once, a wrongly re-offered
 * published key costs a message permanently. Ids at or above the current
 * high-water mark are refused too — every legitimately minted batch was
 * covered by a durable `advanceTo` BEFORE its marker was written, so an id >=
 * the mark can only come from corruption or a rolled-back store, and in both
 * cases acting on its say-so is the unsafe direction.
 *
 * Deduplicated because the ids leave here as an upload payload: a repeated
 * keyId in one `PUT /v1/keys` is a duplicate row for the server to collapse
 * and a false "published twice" for the concurrency harness to trip on.
 */
function readUnpublishedBatch(stores: FileStores, belowId: number): number[] {
  try {
    const raw = JSON.parse(readFileSync(unpublishedBatchPath(stores), 'utf8')) as unknown;
    if (!Array.isArray(raw)) return [];
    const ids = raw.filter((id): id is number => Number.isInteger(id) && id > 0 && id < belowId);
    return [...new Set(ids)];
  } catch {
    return [];
  }
}

/**
 * The marked batch, rebuilt as an upload payload, or null when the marker
 * proves nothing about it.
 *
 * EVERY named id must still have a readable private half. A batch with a hole
 * in it is not the batch the marker described — a lost `persistBatch`
 * directory entry, a half-restored backup, a stray `rm` — and re-offering the
 * survivors of an unexplained partial batch stakes messages on a file set
 * nothing accounts for. Minting fresh in that case costs 100 ids; it cannot
 * cost a message.
 *
 * The public half is derived from `privateKey()`, NEVER read off the record's
 * own `publicKey()`. A `PreKeyRecord` stores the two halves it was handed and
 * checks nothing between them, so a record holding private A under public B
 * would publish B while this client can only answer A — every sender who
 * encrypted to B produces ciphertext that never opens and is then acked away
 * as tamper. Deriving is what makes "published" and "answerable" the same set.
 */
async function reusableUnpublishedBatch(
  stores: FileStores,
  belowId: number,
): Promise<{ keyId: number; pub: string }[] | null> {
  const ids = readUnpublishedBatch(stores, belowId);
  if (ids.length === 0) return null;
  const batch: { keyId: number; pub: string }[] = [];
  for (const id of ids) {
    let record: PreKeyRecord;
    try {
      record = await stores.prekeys.getPreKey(id);
    } catch {
      return null;
    }
    batch.push({ keyId: id, pub: bytesToB64(record.privateKey().getPublicKey().serialize()) });
  }
  return batch;
}

/**
 * Retire the marker — the batch it names is about to become publishable, so
 * from here on "unpublished" can no longer be proven.
 *
 * CONSTRAINT: this retirement must be VERIFIED durable before the function
 * returns, and verification must not depend on fsyncing a directory.
 *
 * The failure it prevents is a resurrection. Retire the marker, let auth and
 * `PUT /v1/keys` succeed, lose power before writeback — and the reborn marker
 * names a batch the server is advertising that very moment, so the next
 * rotation re-offers ids the server has already handed out (and, before this
 * round, deleted their private halves outright). Peers holding those bundles
 * can never be decrypted, and the inbound path acks the failures away as
 * tamper, destroying the server's only copy.
 *
 * The previous shape asked `writeFileAtomic(..., 'durable')` for that
 * guarantee and did not get it: a rename is only durable once the DIRECTORY
 * entry is, and `fsyncDir` swallows EINVAL/EPERM/ENOTSUP/EISDIR — the errnos
 * a filesystem that cannot fsync a directory answers with. On those the
 * retirement was accepted unverified, which is exactly the window above. The
 * available answers were 'durable-verified' (strict, and it fails EVERY auth
 * including session renewals on such a filesystem) or not renaming at all.
 *
 * So: no rename. The directory entry already exists and does not change; the
 * marker's CONTENT is overwritten in place and the FILE is fsynced, which
 * covers its data and size and needs nothing from the directory. Regular-file
 * fsync has no benign-errno list here — any failure throws.
 *
 * Every partial outcome reads as "prove nothing", which is safe:
 *   - crash after the write, before the truncate -> `[]` + old tail -> corrupt;
 *   - crash before anything persisted -> the old marker, but no signature has
 *     been returned yet, so no token and no upload can have followed it;
 *   - the marker file's own creation rename lost -> the name resolves to an
 *     older marker inode, whose content is either an already-retired `[]` or a
 *     batch that was itself never reused (see the note on not rewriting the
 *     marker in `rotateOneTimePrekeys`).
 *
 * A throw here is fail-closed by construction: it aborts the attempt BEFORE
 * `apiAuth`, so no token exists with which the still-marked batch could have
 * been uploaded.
 *
 * CONTRACT FOR CALLERS: idempotent, and it must run before any code path that
 * can reach `PUT /v1/keys`. Exported so the token-mint sites (cmdRegister's
 * auth lock, `AuthSession.mint()`) can call it at the moment a token actually
 * exists — the point at which an upload first becomes possible. Until BOTH do,
 * `signAuthChallenge` keeps calling it, because a retirement that is merely
 * later is a retirement that can be skipped, and a skipped one loses messages.
 */
export function retireUnpublishedPrekeyBatch(stores: FileStores): void {
  let fd: number;
  try {
    fd = openSync(unpublishedBatchPath(stores), 'r+');
  } catch (err) {
    // No marker is the steady state (retired batches leave `[]` behind, and a
    // fresh account has none). Anything else — EACCES, EIO — must refuse.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  try {
    writeSync(fd, RETIRED_MARKER, 0, 'utf8');
    ftruncateSync(fd, Buffer.byteLength(RETIRED_MARKER));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * The one-time prekey batch to advertise: the still-unpublished one this
 * client is already holding, or — failing that — a fresh batch allocated above
 * every id it has ever used.
 *
 * The rule this enforces is NOT "every payload has ids no payload had before".
 * That was the earlier reading, and it is a proxy: what actually destroyed
 * messages is the server being able to hand ONE one-time
 * prekey to TWO senders. `PUT /v1/keys` REPLACES the server's pool, so
 * re-advertising a batch the server has been serving puts its already-allocated
 * ids back into circulation; the first message to arrive consumes the private
 * half (libsignal deletes a used one-time prekey) and the second can never
 * decrypt, after which the inbound path acks it away as tamper and the server's
 * only copy is gone.
 *
 * The real invariant, and what this function keeps:
 *   1. an id is never advertised under two different public keys, and
 *   2. a batch the server MAY have served is never advertised again.
 * A fresh allocation satisfies both by construction. Re-offering a batch the
 * unpublished-batch marker still names satisfies both as well — same ids, the
 * same key files, and a server that never received them — while allocating
 * nothing, which is the only thing that actually bounds a failing retry loop.
 * Either way nothing a sender could hold is replaced, so ciphertext already
 * queued against an older prekey still opens.
 */
async function rotateOneTimePrekeys(stores: FileStores): Promise<{ keyId: number; pub: string }[]> {
  // A persisted high-water mark, NOT max(ids)+1: libsignal deletes a one-time
  // prekey as soon as it is used, so the highest id on disk walks backwards
  // and `max+1` would reissue an id whose old key a peer may still hold.
  const first = stores.prekeys.nextId();

  // NOTHING IS EVER DELETED HERE. Pruning was added twice and removed twice
  // because every local signal it consulted — key count, generation count —
  // is silent about what the SERVER is advertising: a rotation that fails
  // before `PUT /v1/keys` advances the local mark while the server's pool is
  // UNCHANGED, so the window walked past ids being handed out that very
  // moment, and a valid message for a deleted private half decrypt-fails and
  // is acked away as poison. An earlier revision added a third prune, narrowed to the
  // unpublished-batch marker; it was sound but pointless, because it deleted
  // the batch and then allocated 100 FRESH ids in its place. The premise —
  // that a rotation must always allocate — is what was wrong.
  //
  // A batch the marker still names never reached the server, so no sender can
  // hold one of its ids, so RE-OFFERING it is indistinguishable to every peer
  // from offering it for the first time. Doing that costs zero ids and zero
  // files, which is what actually bounds a cron-retried register against a
  // dead endpoint: the earlier shape still burned 100 ids a minute and
  // exhausted the 24-bit space in ~116 days, after which registration was
  // refused forever.
  //
  // The reuse check runs BEFORE the exhaustion refusal below on purpose: it
  // allocates nothing, so an account that has already burned its id space can
  // still re-offer the batch it is holding rather than being bricked by a
  // ceiling it is not approaching.
  //
  // A batch whose attempt got PAST the signature — token minted, upload
  // failed — is deliberately NOT reused: a timed-out PUT may have been
  // applied server-side, so those ~100 files are kept as the price of the
  // message they might still open. Closing that residual leak needs evidence
  // only main.ts / session.ts can provide; see `signAuthChallenge`.
  const reusable = await reusableUnpublishedBatch(stores, first);
  if (reusable) return reusable;

  const highest = first - 1;
  if (highest + ONE_TIME_PREKEY_COUNT > MAX_PREKEY_ID) {
    throw new Error(
      'one-time prekey ids exhausted for this account — register a new client name',
    );
  }

  const oneTimePrekeys: { keyId: number; pub: string }[] = [];
  for (let n = 1; n <= ONE_TIME_PREKEY_COUNT; n++) {
    const id = highest + n;
    const priv = PrivateKey.generate();
    await stores.prekeys.savePreKey(id, PreKeyRecord.new(id, priv.getPublicKey(), priv));
    oneTimePrekeys.push({ keyId: id, pub: bytesToB64(priv.getPublicKey().serialize()) });
  }
  // Durable BEFORE the upload this payload feeds can advertise the ids — the
  // per-write shortcut in `savePreKey` is only safe because of this flush
  // (see `persistBatch` for the measured argument).
  await stores.prekeys.persistBatch(oneTimePrekeys.map((p) => p.keyId));
  stores.prekeys.advanceTo(highest + ONE_TIME_PREKEY_COUNT + 1);
  // The marker is written LAST, so its existence implies the batch files and
  // the high-water mark are already durable. It is written ONLY on this path —
  // a reuse above deliberately leaves the file untouched, and that is a
  // correctness requirement, not tidiness: retirement overwrites the marker IN
  // PLACE (see `retireUnpublishedPrekeyBatch`), so if a fresh marker's rename
  // were lost to a power cut the name would resolve back to the PREVIOUS
  // marker's inode. Re-offering a batch means the marker already names it, so
  // there is no older inode to roll back to; minting a fresh one means the
  // previous batch was not reusable, so the stale content it would resurrect
  // cannot license anything either (its ids either fail the present-on-disk
  // check that rejected them, or read as the retired `[]`).
  //
  // Durable now rather than crash-consistent: the marker is what saves 100 ids
  // and 100 files on the next attempt, and one ~4-40ms fsync alongside
  // `persistBatch`'s ~210ms is not measurable. Losing it is still SAFE — an
  // unproven batch is simply leaked — so the directory fsync stays lenient;
  // the durability correctness depends on is the RETIREMENT, not this write.
  writeFileAtomic(
    unpublishedBatchPath(stores),
    JSON.stringify(oneTimePrekeys.map((p) => p.keyId)),
    undefined,
    'durable',
  );
  return oneTimePrekeys;
}

/**
 * Rebuild the upload payload for an account that already exists on disk.
 *
 * The identity, signed and kyber keys are re-advertised verbatim — the
 * identity key IS the account and is immutable server-side, and the
 * other two are long-lived by design. Only the one-time prekeys are rotated,
 * for the reason spelled out on `rotateOneTimePrekeys`.
 */
async function existingKeysForUpload(stores: FileStores): Promise<UploadKeysRequest> {
  const registrationId = await stores.identity.getLocalRegistrationId();
  const spkRecord = await stores.signedPrekeys.getSignedPreKey(SIGNED_PREKEY_ID);
  const kyberRecord = await stores.kyberPrekeys.getKyberPreKey(KYBER_PREKEY_ID);

  const oneTimePrekeys = await rotateOneTimePrekeys(stores);

  return {
    registrationId,
    identityKey: bytesToB64(stores.identity.getPublicIdentityKey().serialize()),
    signedPrekey: {
      keyId: spkRecord.id(),
      pub: bytesToB64(spkRecord.publicKey().serialize()),
      sig: bytesToB64(spkRecord.signature()),
    },
    kyberPrekey: {
      keyId: kyberRecord.id(),
      pub: bytesToB64(kyberRecord.publicKey().serialize()),
      sig: bytesToB64(kyberRecord.signature()),
    },
    oneTimePrekeys,
  };
}

/**
 * The keys this client should present to the server: generated on a first run,
 * loaded verbatim on every later one.
 *
 * This is the whole reason `cli register` is idempotent now. Under keypair-only
 * accounts there is no phone number to re-claim an account with — the private
 * key in `identity.json` is the only thing that can prove ownership of a
 * `userId`. Losing it is losing the account, so a re-run must never quietly
 * mint a fresh keypair.
 */
export async function loadOrGenerateKeys(stores: FileStores): Promise<UploadKeysRequest> {
  return stores.identity.exists() ? existingKeysForUpload(stores) : generateAndStoreKeys(stores);
}

/**
 * Sign an auth challenge with the identity private key. Pure libsignal — `PrivateKey.sign`, the same primitive that signs the
 * signed prekey above.
 *
 * THE MESSAGE MUST MATCH THE SERVER BYTE FOR BYTE. It is the UTF-8 domain tag
 * followed by the RAW DECODED challenge bytes — NOT the base64 text. Signing
 * the base64 string instead produces a signature that verifies against nothing
 * and fails with the same generic 401 as a wrong key, so the mistake looks
 * exactly like a legitimate rejection. That is why it is spelled out here
 * rather than left to the reader.
 *
 * The construction is no longer duplicated here. `authSignedBytes()` in
 * packages/shared/src/dto.ts is the ONE definition, imported by this function
 * and by the server's verifier; only the Swift signer still mirrors it by hand,
 * under a "MUST equal" comment and against the vectors in
 * packages/shared/authvectors.json. Three hand-written copies of a wire format
 * was how the audience came to be missing from one of them.
 *
 * The ORIGIN is in those bytes: a signature is now valid
 * only at the endpoint it was minted for, so a redirected client — which is
 * exactly what an agent that can set TACENDUM_API can produce — signs for the
 * wrong audience and the real server refuses it.
 *
 * The tag is not decoration: this key also signs prekeys, and tagging every
 * message it is asked to sign is what stops a future message type from being
 * turned into an auth signature by a signing oracle.
 */
export async function signAuthChallenge(
  stores: FileStores,
  challengeB64: string,
  apiOrigin: string = API_BASE,
): Promise<string> {
  // The unpublished-batch marker dies before the signature is born. This
  // signature is what a token — and with it the `PUT /v1/keys` that publishes
  // the marked batch — is minted from, so the moment it exists, "that batch
  // never reached the server" stops being provable, and a marker that outlived
  // it could later tell a rotation to re-offer ids the server is handing out.
  // Retiring it here, on EVERY caller (registration's own sign and session.ts
  // token renewals alike) keeps the rule auditable without knowing who is
  // asking: a renewal's retirement merely forfeits one batch's reuse — 100
  // ids and 100 files — where a missed retirement costs a message,
  // permanently. See `retireUnpublishedPrekeyBatch` for why a throw here is
  // fail-closed.
  //
  // THIS IS EARLIER THAN IT SHOULD BE, and the cost is known: a challenge that succeeds followed by a `POST /v1/auth` that 500s
  // mints no token, so no upload could have happened, yet the batch has
  // already lost its proof and the next attempt allocates 100 more. The sound
  // retirement point is immediately AFTER a token is minted and before the
  // upload that token enables — inside cmdRegister's auth lock and inside
  // `AuthSession.mint()`. Neither is reachable from here, and nothing this
  // module can observe distinguishes "signed" from "authenticated": the
  // profile's inode or mtime would be a guess, and the gate suite already
  // refuses (gate.prekey-growth "ANY auth signature...") to key this on which
  // caller asked, because a renewal's token can upload keys too. Moving the
  // call is a two-site change — add `retireUnpublishedPrekeyBatch(stores)`
  // after `apiAuth` resolves in BOTH mint sites, then drop this line. Doing
  // half of it re-opens F1, so it stays here until both exist.
  retireUnpublishedPrekeyBatch(stores);
  const bytes = authSignedBytes(apiOrigin, challengeB64);
  // Re-homed over a real ArrayBuffer: libsignal's typings want
  // `Uint8Array<ArrayBuffer>`, which an arbitrary view does not satisfy.
  const message = new Uint8Array(new ArrayBuffer(bytes.length));
  message.set(bytes, 0);

  const privateKey = await stores.identity.getIdentityKey();
  return bytesToB64(privateKey.sign(message));
}

/**
 * X3DH/PQXDH session bootstrap from a fetched prekey bundle.
 *
 * RAISING AN IDENTITY CHANGE AND RECORDING ONE ARE THE SAME EVENT, so they
 * happen in the same place. `tacendum trust` refuses unless
 * `stores.hasIdentityChange(peer)` is set, which means any site that lets
 * libsignal raise UntrustedIdentity without recording it leaves the operator
 * with no way to clear the pin: every later message from that peer stays
 * undecryptable and queued, and at the 30-day server TTL they are all dropped.
 *
 * That rule used to live at the CALL SITES, and it diverged exactly as a
 * duplicated rule does. `cmdSend` recorded it; `CallSession.sendEncrypted`,
 * which is the same bootstrap for a calls-only daemon, did not — it printed
 * nothing, recorded nothing, and exited with the wrong code. Recording here makes a fifth call
 * site impossible to get wrong, and `markIdentityChange` is idempotent, so a
 * caller that also records is harmless.
 */
export async function establishSession(
  stores: FileStores,
  selfUserId: string,
  bundle: BundleDto,
): Promise<void> {
  const kyberPub = KEMPublicKey.deserialize(b64ToBytes(bundle.kyberPrekey.pub));
  const libBundle = PreKeyBundle.new(
    bundle.registrationId,
    DEVICE_ID,
    bundle.oneTimePrekey ? bundle.oneTimePrekey.keyId : null,
    bundle.oneTimePrekey ? PublicKey.deserialize(b64ToBytes(bundle.oneTimePrekey.pub)) : null,
    bundle.signedPrekey.keyId,
    PublicKey.deserialize(b64ToBytes(bundle.signedPrekey.pub)),
    b64ToBytes(bundle.signedPrekey.sig),
    PublicKey.deserialize(b64ToBytes(bundle.identityKey)),
    bundle.kyberPrekey.keyId,
    kyberPub,
    b64ToBytes(bundle.kyberPrekey.sig),
  );
  try {
    await processPreKeyBundle(
      libBundle,
      address(bundle.userId),
      address(selfUserId),
      stores.sessions,
      stores.identity,
    );
  } catch (err) {
    // Record, then rethrow unchanged: the caller still owns the refusal and
    // the exit code, this only guarantees `tacendum trust` has something to
    // accept. A failure to record must not mask the safety error itself.
    if (isIdentityChange(err)) {
      try {
        stores.markIdentityChange(bundle.userId);
      } catch {
        // Nothing better to do here, and the safety refusal below matters more.
      }
    }
    throw err;
  }
}

export async function hasSession(stores: FileStores, peerUserId: string): Promise<boolean> {
  return (await stores.sessions.getSession(address(peerUserId))) !== null;
}

/** Encrypt plaintext for a peer; returns the wire envelope pieces. */
export async function encryptText(
  stores: FileStores,
  selfUserId: string,
  peerUserId: string,
  text: string,
): Promise<{ msgType: MsgType; payload: string }> {
  const ciphertext = await signalEncrypt(
    utf8ToBytes(text),
    address(peerUserId),
    address(selfUserId),
    stores.sessions,
    stores.identity,
  );
  const msgType: MsgType =
    ciphertext.type() === CiphertextMessageType.PreKey ? 'prekey' : 'ciphertext';
  return { msgType, payload: bytesToB64(ciphertext.serialize()) };
}

/** Decrypt an inbound envelope. Throws (loudly) on tamper/corruption. */
export async function decryptEnvelope(
  stores: FileStores,
  selfUserId: string,
  senderUserId: string,
  msgType: MsgType,
  payloadB64: string,
): Promise<string> {
  const bytes = b64ToBytes(payloadB64);
  const senderAddr = address(senderUserId);
  const selfAddr = address(selfUserId);

  if (msgType === 'prekey') {
    const message = PreKeySignalMessage.deserialize(bytes);
    const plaintext = await signalDecryptPreKey(
      message,
      senderAddr,
      selfAddr,
      stores.sessions,
      stores.identity,
      stores.prekeys,
      stores.signedPrekeys,
      stores.kyberPrekeys,
    );
    return bytesToUtf8(plaintext);
  }

  const message = SignalMessage.deserialize(bytes);
  const plaintext = await signalDecrypt(
    message,
    senderAddr,
    selfAddr,
    stores.sessions,
    stores.identity,
  );
  return bytesToUtf8(plaintext);
}
