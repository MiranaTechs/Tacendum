import { z } from 'zod';
import {
  ChallengeB64,
  IdentityKeyB64,
  SignatureB64,
  UploadKyberPrekey,
  UploadSignedPrekey,
  normalizeOrigin,
  signedBytesBase64Decode,
  signedBytesUtf8,
} from './dto.js';
import { Ulid } from './frames.js';

/**
 * THE PAPER RECOVERY KIT — preimages, constants and wire shapes.
 * §3, as amended 2026-09-03.
 *
 * WHY THIS IS ITS OWN FILE, AND WHY EVERY NAME IN IT IS PREFIXED. There are
 * TWO recovery verbs in this system and conflating them is the one thing
 * this file's own coexistence note forbids:
 *
 *  1. IDENTIFIER recovery — SHIPPED. A linked email or
 *     phone plus a 72 h delay recovers the account GROUPING, the username and
 *     discoverability. It never returns keys, history, sessions, or a peer's
 *     pinned trust, and it mints a NEW member ULID. It already owns
 *     `/v1/recovery/*`, `handlers/recovery-signed.ts`, `LIMITS.recoveryComplete`,
 *     and every `RECOVERY_*` / `Recovery*` symbol in `./dto.ts`.
 *  2. KIT REBIND — this file. A 160-bit secret printed on paper rebinds the
 *     SAME member ULID to a NEW identity keypair. It needs no identifier at
 *     all and works for an ungrouped solo account. It owns `/v1/kit/*`,
 *     `/v1/rebind/*`, and the `Kit*` / `Rebind*` / `KIT_` / `REBIND_` names
 *     below — and it must never borrow one of verb 1's.
 *
 * Non-conflation is enforced by the identifiers rather than by prose, because
 * the identifiers are the only place it can be enforced at three in the
 * morning. `packages/shared/test/recovery.test.ts` fails the build if a bare
 * `RECOVERY_*` or `Recovery*` name reappears here.
 *
 * NOTHING HERE IS REACHABLE FROM THE WIRE as of 2026-09-03. This is shared
 * types and pure functions only: no route, no handler, no server import, no
 * `identityKeyPub` ever written. The doctrine comment in `./dto.ts` is
 * amended ahead of the code on purpose.
 *
 * NO NEW CRYPTOGRAPHY LIVES HERE (rule 1). This module builds byte
 * strings and validates shapes. Every signature over those bytes is made and
 * checked by libsignal; the verifier digest is a SHA-256 the server takes with
 * `node:crypto`; the secret is platform CSPRNG bytes. Nothing is invented.
 */

// --- Domain tags -----------------------------------------------------------

/**
 * Domain separation for the ENROLMENT signature — made by the account's
 * CURRENT identity key, over the challenge and the material being enrolled.
 *
 * Hardcoded as a string literal on both sides exactly as `AUTH_CHALLENGE_DOMAIN`
 * is, and versioned in the tag: bump `-v1` if the signed bytes ever change
 * shape, never redefine them under the same tag.
 *
 * Renamed from the draft's `tacendum-recovery-enroll-v1`. No
 * signature over the old tag was ever minted, so the rename costs nothing
 * today and would be impossible after the first kit ships.
 */
export const KIT_ENROLL_DOMAIN = 'tacendum-kit-enroll-v1';

/**
 * Domain separation for the DISENROL signature — its OWN tag, not the enrol
 * tag over zeroed material.
 *
 * THE DRAFT SPELLED DISENROLMENT AS `kitEnrollSignedBytes(origin, challenge,
 * zeros, zeros)` (§3), and that made a disenrol signature a
 * BYTE-IDENTICAL, valid enrolment signature for an all-zero verifier over the
 * same nonce. Both verbs draw their nonces from ONE namespace (`echal#`, minted
 * by `POST /v1/kit/challenge` for both `PUT /v1/kit` and `DELETE /v1/kit`), so
 * a single unspent nonce plus one signature was redeemable at EITHER route,
 * and the signed bytes said nothing about which the signer meant — the exact
 * ambiguity the tags exist to remove. Anything that could steer one disenrol
 * to `PUT /v1/kit` would have enrolled a kit whose verifier is 32 bytes
 * everybody knows, and the 160 bits of secret would have bought nothing.
 *
 * A third tag is minted instead. It costs nothing
 * today — no signature over any kit tag has ever been made — and it would be
 * impossible after the first kit ships, the same argument used for the
 * rename. The one-signer-per-platform convenience the zeroed form bought is
 * kept by `kitDisenrollSignedBytes` being a named function, exactly as before.
 */
export const KIT_DISENROLL_DOMAIN = 'tacendum-kit-disenroll-v1';

/**
 * Domain separation for the REBIND proof — made by the NEW identity key, over
 * the challenge alone. Proof of possession of the key being bound, bound in
 * turn to one server-issued nonce and one audience.
 *
 * A DIFFERENT tag from enrolment is the whole point: the same account's key
 * signs auth challenges, link ops, enrolments and rebinds, and one signature
 * must never be replayable as another. Renamed from `tacendum-recovery-v1`
 * later.
 */
export const KIT_REBIND_DOMAIN = 'tacendum-kit-rebind-v1';

// --- Fixed widths ----------------------------------------------------------

/**
 * The printed secret: 160 bits from the platform CSPRNG (§2
 * inv. 2), rendered as eight Crockford base32 groups of four. Not a
 * passphrase, not a PIN, and never user-chosen — the whole design rests on
 * the secret being unguessable, so there is nothing here for a rate limiter
 * to protect that entropy has not already protected.
 */
export const KIT_SECRET_BYTES = 20;

/** Per-account salt for the verifier derivation. 32 bytes, and the decoy salt
 * served for an unenrolled or unknown account is the same width for exactly
 * one reason: a width difference would be the enrolment oracle the uniform
 * 403 exists to close (§3 inv. 7).
 *
 * Equal width closes the oracle WITHIN one response. It does not close it
 * across time — the deterministic decoy is constant per account and flips at
 * enrolment and disenrolment, which a poller holding the public ULID can see.
 * That residual is stated on `RebindChallengeResponse` and is open until
 * the per-(IP, ULID) mint limit lands. */
export const KIT_SALT_BYTES = 32;

/** The client-derived verifier the server stores a digest of. 32 bytes. The
 * server never sees the secret (§2 inv. 1). */
export const KIT_VERIFIER_BYTES = 32;

/** Server-minted single-use nonce, both for enrolment (`echal#`) and for
 * rebind (`rchal#`). 32 bytes, matching the auth challenge. */
export const KIT_CHALLENGE_BYTES = 32;

/**
 * How long an issued kit challenge stays usable. The same 120 s
 * `AUTH_CHALLENGE_TTL_SECONDS` allows, for the same reasons: long enough for
 * a slow device to run a signature, short enough that a captured nonce is
 * already dead — and it is only a nonce.
 */
export const KIT_CHALLENGE_TTL_SECONDS = 120;

/**
 * WRONG PROOFS ALLOWED PER ACCOUNT PER WINDOW, and the window.
 *
 * Spelled here so the server's limiter entry and any client-side copy read
 * the same two numbers. The server's bucket is
 * `{ capacity: KIT_REBIND_ATTEMPT_LIMIT, refillPerSec: KIT_REBIND_ATTEMPT_LIMIT
 * / KIT_REBIND_ATTEMPT_WINDOW_SECONDS }` — a 24 h fixed window by construction
 * under the house token bucket.
 *
 * DEBITED ONLY BY A WRONG PROOF, post-check, never at handler entry. That is
 * not an optimisation, it is the fix for §0.4: a limiter debited by any caller
 * lets a stranger who knows only a bare ULID — which is public, it is what a
 * QR code carries — spend the true owner's daily attempts and lock them out
 * of their own recovery forever. Junk calls, malformed calls and challenge
 * mints debit nothing; per-IP limiting is the primary control and runs first.
 */
export const KIT_REBIND_ATTEMPT_LIMIT = 10;
/** See `KIT_REBIND_ATTEMPT_LIMIT`. 24 hours. */
export const KIT_REBIND_ATTEMPT_WINDOW_SECONDS = 86400;

// --- Field schemas ---------------------------------------------------------

/**
 * Base64 of exactly 32 bytes, in its one canonical spelling.
 *
 * Written as an exact-width regex rather than reusing `./dto.ts`'s general
 * `CanonicalBase64`, because the width is load-bearing here and a width check
 * bolted on afterwards can be forgotten: 32 bytes is 43 base64 characters plus
 * one `=`, and the 43rd character carries two real bits, so it must come from
 * the class whose four unused low bits are zero. Anything else is a second
 * spelling of the same bytes, and these values are compared as raw strings and
 * concatenated into fixed-width signed bytes.
 */
const Base64Of32Bytes = z
  .string()
  .regex(
    /^(?:[A-Za-z0-9+/]{4}){10}[A-Za-z0-9+/]{2}[AEIMQUYcgkosw048]=$/,
    'must be canonical base64 of exactly 32 bytes',
  );

/** The per-account salt on the wire. See `KIT_SALT_BYTES`. */
export const KitSaltB64 = Base64Of32Bytes;
/** The client-derived verifier on the wire. See `KIT_VERIFIER_BYTES`. */
export const KitVerifierB64 = Base64Of32Bytes;
/**
 * The nonce on the wire, in REQUESTS only.
 *
 * Exact-width, deliberately unlike `./dto.ts`'s loose `ChallengeB64`
 * (`Base64.max(128)`): the builders below THROW on a challenge that is not
 * exactly 32 bytes, so a loose request schema turns a well-formed-but-short
 * nonce into an unhandled throw — a 500 — where the honest answer is a 400 at
 * the door. Responses keep the loose shape for forward compatibility; a client
 * that is handed a width it cannot use simply fails its own build step.
 */
export const KitChallengeB64 = Base64Of32Bytes;

/**
 * Base64 of 32 zero bytes — the ONE value the enrolment shapes and the store
 * both refuse, so no kit can ever be armed with material everybody knows.
 *
 * It is not part of any preimage any more (see `KIT_DISENROLL_DOMAIN`). It
 * survives as a sentinel because the refusal is cheap and because a zero
 * verifier is the single value an attacker gets for free; `setKitEnrollment`
 * in `packages/server/src/db/data.ts` refuses it too, so the guard holds
 * against a caller that never went through this schema.
 */
export const KIT_ZERO_MATERIAL_B64 = `${'A'.repeat(43)}=`;

/** Refuse all-zero kit material wherever it appears on the wire. See
 * `KIT_ZERO_MATERIAL_B64`. */
const notZeroMaterial = (value: string): boolean => value !== KIT_ZERO_MATERIAL_B64;
const ZERO_MATERIAL_MESSAGE = 'kit material must not be all zero bytes';

// --- Signed bytes ----------------------------------------------------------

/**
 * Prefix common to both builders: `domain ‖ uint16be(len(origin)) ‖ origin`.
 *
 * The origin is inside the signed bytes because a signature that names no
 * audience is valid at ANY verifier — a hostile endpoint could fetch a real
 * challenge from the true server, have the client sign it, and redeem the
 * signature (the v2 note on `AUTH_CHALLENGE_DOMAIN`). The
 * length prefix is not ceremony either: without it, one field's end is
 * another's beginning, which is the oldest concatenation bug there is.
 *
 * Throws rather than truncating on an origin that will not fit the prefix. A
 * silently wrong audience is an outage nobody can diagnose.
 */
function originPrefix(domain: string, origin: string): Uint8Array[] {
  const domainBytes = signedBytesUtf8(domain);
  const originBytes = signedBytesUtf8(normalizeOrigin(origin));
  if (originBytes.length > 0xffff) {
    throw new Error('origin too long to length-prefix');
  }
  const len = Uint8Array.from([(originBytes.length >> 8) & 0xff, originBytes.length & 0xff]);
  return [domainBytes, len, originBytes];
}

/** Concatenate. Written out rather than reaching for a helper so the byte
 * layout of a signed preimage is readable in one place. */
function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** Decode and assert an exact width. FAILS CLOSED, and it has to: the fixed
 * widths below are what let three adjacent fields go unprefixed, so a
 * short salt would let one field's bytes be read as another's. */
function fixedWidth(b64: string, bytes: number, field: string): Uint8Array {
  const decoded = signedBytesBase64Decode(b64);
  if (decoded.length !== bytes) {
    throw new Error(`kit ${field} must be exactly ${bytes} bytes`);
  }
  return decoded;
}

/**
 * The exact bytes the CURRENT identity key signs to enrol (or replace, or
 * disenrol) a recovery kit:
 *
 *     "tacendum-kit-enroll-v1" ‖ uint16be(len(origin)) ‖ origin ‖
 *         challenge(32) ‖ salt(32) ‖ verifier(32)
 *
 * The three trailing fields are UNPREFIXED because all three are fixed-width
 * and checked to be so above — the same licence `authSignedBytes` takes for
 * its single trailing challenge, made explicit rather than left as an accident
 * of the current formats (which is precisely what `linkOpSignedBytes` refuses
 * to rely on, and why every one of ITS nine variable-width fields carries a
 * length). If a later version needs a variable-width field here, it gets a
 * length prefix and a `-v2` tag; it does not get appended.
 *
 * The challenge is in the preimage so that a captured enrolment signature
 * cannot enrol DIFFERENT material, and a replayed one cannot resurrect a
 * revoked kit: the nonce is single-use server-side.
 *
 * ONE definition, exported, because this preimage will have four
 * implementations (server verify, the app's Swift signer, the app's Kotlin
 * signer, the CLI) — `packages/shared/test/recovery.test.ts` byte-pins it, and
 * the cross-platform vector file is minted on the `authvectors.json` /
 * `linkvectors.json` precedent.
 */
export function kitEnrollSignedBytes(
  origin: string,
  challengeB64: string,
  saltB64: string,
  verifierB64: string,
): Uint8Array {
  return concatBytes([
    ...originPrefix(KIT_ENROLL_DOMAIN, origin),
    fixedWidth(challengeB64, KIT_CHALLENGE_BYTES, 'challenge'),
    fixedWidth(saltB64, KIT_SALT_BYTES, 'salt'),
    fixedWidth(verifierB64, KIT_VERIFIER_BYTES, 'verifier'),
  ]);
}

/**
 * The exact bytes the CURRENT identity key signs to REVOKE a kit:
 *
 *     "tacendum-kit-disenroll-v1" ‖ uint16be(len(origin)) ‖ origin ‖
 *         challenge(32)
 *
 * ITS OWN TAG. The draft signed the enrol preimage over
 * zeroed material, which made one signature valid at both routes off one
 * nonce — see `KIT_DISENROLL_DOMAIN` for why that is now a different tag
 * instead of a documented hazard.
 *
 * Idempotent server-side — revoking a kit that is not there is a 204, because
 * a user tearing up a piece of paper should not have to learn whether the
 * server agreed with them about its existence.
 */
export function kitDisenrollSignedBytes(origin: string, challengeB64: string): Uint8Array {
  return concatBytes([
    ...originPrefix(KIT_DISENROLL_DOMAIN, origin),
    fixedWidth(challengeB64, KIT_CHALLENGE_BYTES, 'challenge'),
  ]);
}

/**
 * The exact bytes the NEW identity key signs to prove possession during a
 * rebind:
 *
 *     "tacendum-kit-rebind-v1" ‖ uint16be(len(origin)) ‖ origin ‖
 *         challenge(32) ‖ uint16be(len(identityKey)) ‖ identityKey
 *
 * THE IDENTITY KEY IS IN THE PREIMAGE. Without it the proof
 * committed to nothing but the nonce, so account binding rested entirely on
 * the server-side `rchal#` row and key binding on nothing at all: a party that
 * could modify a rebind in flight could keep the victim's identity key,
 * signature and verifier and substitute its own prekeys, and neither
 * `storeKeys` nor `uploadKeysHandler` verifies a prekey signature server-side
 * — peers would then reject every bundle, a durable denial of session
 * establishment a third party could impose. Committing to the key is free
 * while `-v1` is unminted and impossible after the first kit ships.
 *
 * The challenge stays UNPREFIXED because it is fixed-width and checked to be
 * so; the identity key is variable-width by shape, so it carries a length like
 * every one of `linkOpSignedBytes`'s nine fields.
 *
 * The remaining prekey fields of `RebindRequest` are deliberately NOT covered:
 * committing to them would need the same canonical encoding of a nested object
 * on four platforms, and the handler closes the gap the honest way instead, by
 * verifying `signedPrekey.sig` and `kyberPrekey.sig` under the presented
 * identity key (`handlers/identity-verify.ts`) before it calls
 * `rebindUserIdentity`. That obligation is recorded in §0
 * written down here, not left to a reader of this comment.
 *
 * The kit secret is NOT in this preimage and must never be: the secret is
 * proved by the verifier comparison, which the server does against a stored
 * digest, and putting it in a signature would put it in every log, crash dump
 * and packet capture that ever holds a signed blob (rule 4).
 */
export function kitRebindSignedBytes(
  origin: string,
  challengeB64: string,
  identityKeyB64: string,
): Uint8Array {
  const identityKey = signedBytesBase64Decode(identityKeyB64);
  if (identityKey.length === 0 || identityKey.length > 0xffff) {
    throw new Error('kit identityKey must be length-prefixable and non-empty');
  }
  const len = Uint8Array.from([(identityKey.length >> 8) & 0xff, identityKey.length & 0xff]);
  return concatBytes([
    ...originPrefix(KIT_REBIND_DOMAIN, origin),
    fixedWidth(challengeB64, KIT_CHALLENGE_BYTES, 'challenge'),
    len,
    identityKey,
  ]);
}

// --- Wire shapes -----------------------------------------------------------
//
// Five verbs (§3, as amended):
//
//   POST   /v1/kit/challenge     authenticated, no body  -> KitChallengeResponse
//   PUT    /v1/kit               authenticated, KitEnrollRequest      -> 204
//   DELETE /v1/kit               authenticated, KitDisenrollRequest   -> 204
//   POST   /v1/rebind/challenge  anonymous, RebindChallengeRequest
//                                                    -> RebindChallengeResponse
//   POST   /v1/rebind            anonymous, RebindRequest -> RebindResponse
//
// NEW ROUTES, so these shapes are free to be exactly what they should be —
// the no-required-field-on-an-existing-response rule constrains changes to
// SHIPPED shapes, and none of these is shipped. Response fields that a client
// can live without are still optional, on the MSG-W1 precedent
// (`WsTicketResponse.expiresAt`): the server always emits them.

/** `POST /v1/kit/challenge` -> the nonce an enrolment or disenrolment signs
 * over. Authenticated; no request body — the caller is the bearer. */
export const KitChallengeResponse = z.object({
  challenge: ChallengeB64,
  /** Unix seconds. Optional on the wire (MSG-W1): always emitted, and a
   * client that ignores it merely retries on a 403. */
  expiresAt: z.number().int().nonnegative().optional(),
});
export type KitChallengeResponse = z.infer<typeof KitChallengeResponse>;

/**
 * `PUT /v1/kit` — enrol, or replace, a kit. 204.
 *
 * A BEARER TOKEN IS NOT ENOUGH and the signature field is why (§0.1, the
 * takeover): if enrolment were bearer-only, a stolen token would let an
 * attacker enrol THEIR kit and then rebind the account to their own key at
 * leisure — turning a 30-day session theft into a permanent account seizure.
 * Enrolment is signed by the current identity key, which a stolen token does
 * not carry.
 *
 * Replacing a kit needs no OLD kit: the identity key is the factor, and a
 * user who still holds their key has already proved everything the old paper
 * could prove.
 */
export const KitEnrollRequest = z.object({
  /** From `POST /v1/kit/challenge`. Single-use, 120 s. Exact-width: see
   * `KitChallengeB64`. */
  challenge: KitChallengeB64,
  salt: KitSaltB64.refine(notZeroMaterial, ZERO_MATERIAL_MESSAGE),
  /** The CLIENT-derived verifier. The server stores only a digest of it and
   * never sees the secret it came from (§2 inv. 1). All-zero is refused here
   * AND in `setKitEnrollment`: a kit whose verifier is a value everybody knows
   * is not a kit (see `KIT_ZERO_MATERIAL_B64`). */
  verifier: KitVerifierB64.refine(notZeroMaterial, ZERO_MATERIAL_MESSAGE),
  /** Identity-key signature over `kitEnrollSignedBytes`. */
  signature: SignatureB64,
});
export type KitEnrollRequest = z.infer<typeof KitEnrollRequest>;

/** `DELETE /v1/kit` — revoke the kit. 204, idempotent. Signed for the same
 * reason enrolment is: a stolen bearer must not be able to strip the owner's
 * recovery, which is a denial of service against exactly the person having
 * the bad day. */
export const KitDisenrollRequest = z.object({
  challenge: KitChallengeB64,
  /** Identity-key signature over `kitDisenrollSignedBytes` — its OWN domain
   * tag, so it can never be redeemed as an enrolment. */
  signature: SignatureB64,
});
export type KitDisenrollRequest = z.infer<typeof KitDisenrollRequest>;

/**
 * `POST /v1/rebind/challenge` — ANONYMOUS. The caller has a piece of paper and
 * no account; there is nothing to authenticate with yet.
 */
export const RebindChallengeRequest = z.object({
  /** The ULID printed on the kit. Public by construction — it is what a QR
   * code carries — so nothing here may be treated as a secret. */
  userId: Ulid,
});
export type RebindChallengeRequest = z.infer<typeof RebindChallengeRequest>;

/**
 * Always a 200 for a well-formed ULID, enrolled or not.
 *
 * An unenrolled or unknown account gets a DETERMINISTIC decoy salt —
 * `SHA-256(userId ‖ pepper)`, the same 32 bytes every time — because a fresh
 * random salt per call would itself be the oracle (two calls, two salts, "not
 * enrolled"), and a 404 would be a plainer one. The pepper is fetched at
 * runtime from Secrets Manager and never appears in Lambda env configuration
 * (§0.8).
 *
 * THE RESIDUAL, STATED PLAINLY (§2 inv. 7). A SINGLE
 * response is indistinguishable: one salt of one width, real or decoy. A
 * CHANGE in the served salt is not. The value is constant per account and
 * flips exactly when that account first enrols, re-enrols, or disenrols, so
 * anyone holding the public ULID — which is what a QR code carries — can poll
 * this route and observe every enrolment-state transition, and after one
 * observed flip knows the account has a kit. The per-IP mint limit does not
 * bound polling one ULID from many addresses; a per-(IP, ULID) mint limit is
 * still owed, and until it lands the residual is open, not closed.
 */
export const RebindChallengeResponse = z.object({
  challenge: ChallengeB64,
  /** Real or decoy — one response is indistinguishable; a CHANGE in the value
   * served for a ULID is observable to a poller. See above. */
  salt: KitSaltB64,
  /** Unix seconds. Optional on the wire (MSG-W1). */
  expiresAt: z.number().int().nonnegative().optional(),
});
export type RebindChallengeResponse = z.infer<typeof RebindChallengeResponse>;

/**
 * `POST /v1/rebind` — ANONYMOUS. Rebinds the SAME account ULID to a NEW
 * identity keypair, on proof of the printed secret plus possession of the new
 * key. The one exception to identity-key immutability in this system.
 *
 * Answers, and nothing else: 200 `RebindResponse`; 403 `kit_rebind_failed`
 * (wrong proof, unenrolled, unknown — byte-identical, one shape); 409
 * `identity_key_in_use`; 429 in the house rate-limit shape with `retry-after`
 * (the draft's `lapsesAt` body field is forbidden, it would
 * add a field to an error shape shipped clients parse strictly).
 *
 * ONE-TIME PREKEYS ARE DELIBERATELY ABSENT from this payload. After the 200
 * the client holds a token and the row holds the new key, so the ordinary
 * `PUT /v1/keys` accepts the batch under an UNCHANGED immutability check —
 * which is worth more than a saved round trip, because it means the rebind
 * does not weaken the one condition that keeps every other account safe.
 */
export const RebindRequest = z.object({
  userId: Ulid,
  /** From `POST /v1/rebind/challenge`. Single-use, per-request, 120 s.
   * Exact-width: see `KitChallengeB64`. */
  challenge: KitChallengeB64,
  /** Derived on the device from the printed secret and the salt just served.
   * The secret itself never leaves the device (§2 inv. 1). All-zero is refused
   * for the same reason it is at enrolment. */
  verifier: KitVerifierB64.refine(notZeroMaterial, ZERO_MATERIAL_MESSAGE),
  /** The NEW identity key. Canonical base64 — it becomes a DynamoDB partition
   * key and is compared by raw string equality. */
  identityKey: IdentityKeyB64,
  /** Signature by the NEW identity key over `kitRebindSignedBytes`. */
  signature: SignatureB64,
  registrationId: z.number().int().nonnegative(),
  signedPrekey: UploadSignedPrekey,
  kyberPrekey: UploadKyberPrekey,
});
export type RebindRequest = z.infer<typeof RebindRequest>;

/** The same `{ userId, authToken }` every sign-in answers, so the client's
 * session handling does not fork for this path. The ULID is the one the
 * caller already presented — echoed, not discovered. */
export const RebindResponse = z.object({
  userId: z.string(),
  authToken: z.string(),
});
export type RebindResponse = z.infer<typeof RebindResponse>;
