import { z } from 'zod';
import {
  SMALL_GROUP_CALL_MAX_PARTICIPANTS,
  SMALL_GROUP_CALL_MAX_VIDEO_PARTICIPANTS,
} from './call.js';
import { Ulid } from './frames.js';

/**
 * REST request/response schemas. Validated with zod on both the
 * server (handlers) and, later, the React Native client. One source of truth.
 */

// NOTHING HERE REGISTERS A PHONE NUMBER any more, and nothing should.
//
// `RegisterRequest`, `VerifyRequest`/`VerifyResponse` and the registration-lock
// DTOs were deleted with the SMS path. The account
// model is the identity keypair; see the challenge/response section below.
//
// The registration lock went with them because it existed for exactly one
// threat — a SIM swap letting whoever receives the SMS take the account over —
// and that threat cannot exist without an SMS. Its replacement is stronger and
// needs no PIN: the identity key is immutable per account (§2.1), so even a
// stolen bearer token cannot rebind the account to a new key. The DEVICE-side
// PIN derivation (`pinVerifier`) survives in the app, reserved for encrypted
// backups, which is a different problem with a different
// failure mode — losing the PIN loses the backup, not the account.
//
// AMENDED 2026-09-03 (§3). "Immutable per
// account" now has exactly ONE exception, and naming it here is the point:
// a paper recovery kit, enrolled in advance under a signature from the
// CURRENT identity key, lets its holder rebind the SAME account ULID to a
// NEW identity keypair. Nothing else may ever SET `identityKeyPub` after
// birth — not a bearer token, not a session, not `storeKeys`, not any role.
// The exception's preimages and constants live in `./recovery.ts`, its
// transaction in `packages/server/src/db/data.ts` (`rebindUserIdentity`),
// and the rule it bends is §2.1. The immutability enforcement points that
// read this sentence as licence are enumerated in the design record; if this
// comment and that record ever disagree, the record is the audit and this is
// only the pointer.
//
// Nothing in `./recovery.ts` is reachable from the wire as of 2026-09-03:
// there is no route, no handler and no server import. The doctrine is
// amended ahead of the code deliberately, so that the first SET of
// `identityKeyPub` cannot land against a comment that forbids it.

// --- Key distribution ---

export const CallMetricScope = z.enum(['direct', 'group']);
export const CallMetricMedia = z.enum(['audio', 'video']);
export const CallMetricOutcome = z.enum([
  'completed',
  'declined',
  'busy',
  'unanswered',
  'connection_failed',
  'media_failed',
  'blocked',
  'unsupported',
]);

export const CallMetricReport = z
  .object({
    reportId: Ulid,
    occurredAt: z.number().int().nonnegative(),
    scope: CallMetricScope,
    media: CallMetricMedia,
    answered: z.boolean(),
    connected: z.boolean(),
    outcome: CallMetricOutcome,
    setupMs: z.number().int().min(0).max(120_000).optional(),
    durationSeconds: z.number().finite().min(0).max(86_400).optional(),
    groupPeakParticipants: z
      .number()
      .int()
      .min(2)
      .max(SMALL_GROUP_CALL_MAX_PARTICIPANTS)
      .optional(),
  })
  .strict()
  .superRefine((report, ctx) => {
    const issue = (path: string, message: string): void => {
      ctx.addIssue({ code: 'custom', path: [path], message });
    };
    if (report.connected && !report.answered) issue('connected', 'connected requires answered');
    if (report.outcome === 'completed' && !report.connected)
      issue('outcome', 'completed requires connected');
    if (report.connected !== (report.setupMs !== undefined))
      issue('setupMs', 'setupMs is required exactly when connected');
    if (report.connected !== (report.durationSeconds !== undefined))
      issue('durationSeconds', 'durationSeconds is required exactly when connected');
    if (report.scope === 'direct' && report.groupPeakParticipants !== undefined)
      issue('groupPeakParticipants', 'direct calls cannot have a group peak');
    if (report.scope === 'group' && report.connected && report.groupPeakParticipants === undefined)
      issue('groupPeakParticipants', 'connected group calls require a peak');
    if (report.scope === 'group' && !report.connected && report.groupPeakParticipants !== undefined)
      issue('groupPeakParticipants', 'unconnected group calls cannot have a peak');
    if (
      report.media === 'video' &&
      report.groupPeakParticipants !== undefined &&
      report.groupPeakParticipants > SMALL_GROUP_CALL_MAX_VIDEO_PARTICIPANTS
    ) {
      issue('groupPeakParticipants', 'video group peak exceeds the shipped cap');
    }
  });

export type CallMetricReport = z.infer<typeof CallMetricReport>;

/** Standard base64 (Signal public keys/signatures are base64-encoded bytes). */
const Base64 = z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/, 'must be base64');

/**
 * base64url — the URL-safe alphabet, `-` and `_` in place of `+` and `/`.
 *
 * A SEPARATE schema rather than a loosening of `Base64`, because the two are
 * used for opposite reasons and must not drift into each other. `Base64` values
 * are Signal key material that is compared and used as a partition key, where
 * accepting a second spelling of the same bytes would be a correctness bug.
 * These values live in URLs, where `+` and `/` require percent-encoding and
 * survive a round trip only if every intermediary agrees on it.
 *
 * This exists because it was missing: the WebSocket ticket is minted with
 * `randomBytes(32).toString('base64url')` and validated against `Base64`, so
 * 73.5% of real tickets — measured, not estimated — failed the client's own
 * parse and silently fell back to putting the 30-day bearer in the socket URL,
 * which is the exact defect the ticket was introduced to remove.
 */
const Base64Url = z.string().regex(/^[A-Za-z0-9_-]+$/, 'must be base64url');

/**
 * Base64 in its ONE canonical spelling: decoding and re-encoding must give the
 * string back.
 *
 * Only applied to the identity key, and for a specific reason. The key is not
 * merely transported — it becomes a DynamoDB partition key (`idkey#<b64>`) and
 * the value `storeKeys` compares against to enforce immutability, both by raw
 * string equality. The plain `Base64` regex above admits several encodings of
 * the same 33 bytes (missing padding, stray '='), so a client that spelled the
 * key one way to POST /v1/auth and another way to PUT /v1/keys would create its
 * account under one string and then be refused key upload against the other —
 * an unrecoverable lockout with a 4xx nobody could diagnose, because the two
 * keys ARE the same key.
 *
 * Rejected at the door rather than normalized on the way in: a 400 naming the
 * problem is diagnosable, and normalizing would leave two spellings quietly
 * working, which is how the bug would come back the next time someone adds a
 * third endpoint that takes a key. No attacker gain either way — identity keys
 * are free to mint — so this is a correctness fix, not a control.
 *
 * Real clients are unaffected: `Buffer.toString('base64')` and Swift's
 * `base64EncodedString()` both emit canonical form, and a 33-byte key encodes
 * to 44 characters with no padding at all.
 *
 * Expressed as a regex, not as decode-then-re-encode, so this module stays
 * platform-free — the React Native app imports it and has no `Buffer`. The two
 * character classes are the ones whose base64 value has the unused low bits
 * zero: index % 4 == 0 before a single '=', index % 16 == 0 before '=='. That
 * is what rules out the "same bytes, different string" forms.
 */
const CANONICAL_BASE64_RE =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}[AEIMQUYcgkosw048]=|[A-Za-z0-9+/][AQgw]==)?$/;
const CanonicalBase64 = Base64.regex(
  CANONICAL_BASE64_RE,
  'must be canonical base64 (correct padding, no unused trailing bits)',
);

export const SignedPrekey = z.object({
  keyId: z.number().int().nonnegative(),
  pub: Base64,
  sig: Base64,
});
export type SignedPrekey = z.infer<typeof SignedPrekey>;

export const OneTimePrekey = z.object({
  keyId: z.number().int().nonnegative(),
  pub: Base64,
});
export type OneTimePrekey = z.infer<typeof OneTimePrekey>;

/**
 * Signed last-resort Kyber prekey (PQXDH). Current libsignal requires a Kyber
 * prekey in every bundle — X3DH-only bundles are no longer constructible.
 * Same shape as SignedPrekey but the key is a KEM (ML-KEM/Kyber) public key.
 */
export const KyberPrekey = z.object({
  keyId: z.number().int().nonnegative(),
  pub: Base64,
  sig: Base64,
});
export type KyberPrekey = z.infer<typeof KyberPrekey>;

/**
 * Byte lengths of the key material every shipped client uploads, pinned at
 * the UPLOAD schema only. libsignal is deliberately off the HTTP function,
 * so the server cannot verify a signed prekey's signature at the door — but
 * it can refuse material of the wrong SIZE, which closes the cheapest
 * poisoning: a stolen bearer publishing garbage under the victim's identity
 * key so every peer's bundle processing fails until a re-upload. A
 * Curve25519 public key serializes with its type byte (33), a signature is
 * 64 bytes, an ML-KEM-1024 public key serializes with its type byte (1569)
 * — iOS and Android libsignal, the CLI, and the Android device gate
 * (the Android verify pass) all agree. The RESPONSE shapes
 * (`PrekeyBundle`) are untouched: the app parses those strictly, and a
 * served bundle only ever carries what this accepted. */
export const CURVE_PUBLIC_KEY_BYTES = 33;
export const SIGNATURE_BYTES = 64;
export const KYBER_PUBLIC_KEY_BYTES = 1569;

/** Decoded length of a base64 string, padded or not. Arithmetic, not
 * decode-then-measure, so this module stays platform-free (no Buffer). */
function base64ByteLength(s: string): number {
  const unpadded = s.replace(/=+$/, '').length;
  return Math.floor((unpadded * 3) / 4);
}
const base64OfBytes = (bytes: number) =>
  Base64.refine((s) => base64ByteLength(s) === bytes, `must encode exactly ${bytes} bytes`);

/** The upload-side twins of the three prekey shapes: same fields, byte
 * lengths pinned. Request-side only — see the note above. */
export const UploadSignedPrekey = SignedPrekey.extend({
  pub: base64OfBytes(CURVE_PUBLIC_KEY_BYTES),
  sig: base64OfBytes(SIGNATURE_BYTES),
});
export const UploadOneTimePrekey = OneTimePrekey.extend({
  pub: base64OfBytes(CURVE_PUBLIC_KEY_BYTES),
});
export const UploadKyberPrekey = KyberPrekey.extend({
  pub: base64OfBytes(KYBER_PUBLIC_KEY_BYTES),
  sig: base64OfBytes(SIGNATURE_BYTES),
});

// PUT /v1/keys  ->  204
export const UploadKeysRequest = z.object({
  registrationId: z.number().int().nonnegative(),
  // CANONICAL, matching POST /v1/auth. `storeKeys` compares this against the
  // key the account was created under by raw string equality, so the two
  // endpoints must agree on one spelling or an account can be locked out of
  // its own key upload. See CanonicalBase64 above.
  identityKey: CanonicalBase64.max(128),
  signedPrekey: UploadSignedPrekey,
  kyberPrekey: UploadKyberPrekey,
  oneTimePrekeys: z.array(UploadOneTimePrekey).max(1000),
});
export type UploadKeysRequest = z.infer<typeof UploadKeysRequest>;

// --- Keypair-only accounts ---
//
// Replaces phone + SMS: the identity keypair IS the account. The client asks
// for a nonce, signs it with its libsignal identity private key, and the
// server verifies the signature with libsignal. No phone number, no code, no
// carrier.
//
// LENGTH BOUNDS ARE NOT COSMETIC. `identityKey` becomes part of a DynamoDB
// partition key (`idkey#<b64>`, 2048-byte limit), so an unbounded string is a
// way to push a megabyte through MAX_BODY_BYTES and 500 the table. Same reason
// `bearerToken` caps at 512. Real sizes: a libsignal public key is 33 bytes
// (44 b64 chars), a signature 64 bytes (88), a challenge 32 bytes (44); the
// caps below are loose enough to survive a format change and tight enough to
// keep the key a key.
// CANONICAL for the identity key specifically — it is the account's primary
// key material and is compared as a raw string (see CanonicalBase64 above).
// The signature and the challenge are consumed as bytes and never compared as
// strings against anything a different endpoint produced, so the looser form
// is harmless there and tightening it would only reject clients for no gain.
const IdentityKeyB64 = CanonicalBase64.max(128);
const SignatureB64 = Base64.max(256);
const ChallengeB64 = Base64.max(128);

/** Domain separation for the account-challenge signature.
 *
 * The same identity key also signs signed prekeys, so every distinct thing it
 * is ever asked to sign must be unambiguously tagged. Today's two messages
 * could not be confused anyway — a challenge is 32 server-chosen random bytes
 * and a prekey is 33 bytes starting 0x05 — but that is an accident of the
 * current formats, not a property anyone should rely on. This prefix makes it
 * a rule, so a future third message type cannot turn one signature into
 * another. Bump the version if the signed bytes ever change shape.
 *
 * **v2.** v1 signed only the tag and the challenge, which
 * named no audience — so a signature was valid at ANY verifier. A hostile
 * endpoint could fetch a real challenge from the true server, have the client
 * sign it, and redeem the signature for a genuine session token. The origin is
 * now inside the signed bytes, so a client that was redirected signs for the
 * wrong audience and the real server refuses it. */
export const AUTH_CHALLENGE_DOMAIN = 'tacendum-auth-v2';

/**
 * The API origin, in the one form every implementation must agree on.
 *
 * Scheme and host and port, lowercased, no path, no trailing slash, and the
 * default port for the scheme removed — so `https://API.Tacendum.com:443/v1/`
 * and `https://api.tacendum.com` are the same audience, because they are.
 * Anything that cannot be parsed as an absolute URL throws rather than
 * defaulting: a silently wrong audience is an auth outage nobody can diagnose,
 * and an audience that silently becomes the empty string is the hole this
 * whole change exists to close.
 */
export function normalizeOrigin(url: string): string {
  const parsed = new URL(url);
  const scheme = parsed.protocol.toLowerCase();
  const host = parsed.hostname.toLowerCase();
  const isDefaultPort =
    (scheme === 'https:' && parsed.port === '443') ||
    (scheme === 'http:' && parsed.port === '80');
  const port = parsed.port && !isDefaultPort ? `:${parsed.port}` : '';
  return `${scheme}//${host}${port}`;
}

/**
 * The exact bytes a client signs to authenticate:
 *
 *     "tacendum-auth-v2" ‖ uint16be(len(origin)) ‖ origin ‖ raw_challenge
 *
 * ONE definition, exported, because this format has four implementations — the
 * server, the CLI, the iOS bridge and the Swift signer — and four copies of a
 * wire format is precisely where drift lives. `packages/shared/authvectors.json`
 * pins it with known inputs so the Swift side, which cannot run here, can be
 * checked by hand on device.
 *
 * The length prefix is not ceremony. Without it, origin `https://a.com` with
 * challenge `X` and origin `https://a.comX` with an empty challenge produce
 * identical bytes — one field's end being another's beginning is the oldest
 * concatenation bug there is. The challenge happens to be fixed-width today,
 * which makes this unexploitable and is exactly the kind of accident the
 * domain tag's own comment warns against relying on.
 */
export function authSignedBytes(origin: string, challengeB64: string): Uint8Array {
  const domain = utf8Bytes(AUTH_CHALLENGE_DOMAIN);
  const originBytes = utf8Bytes(normalizeOrigin(origin));
  if (originBytes.length > 0xffff) {
    throw new Error('origin too long to length-prefix');
  }
  const challenge = base64ToBytes(challengeB64);
  const out = new Uint8Array(domain.length + 2 + originBytes.length + challenge.length);
  let at = 0;
  out.set(domain, at);
  at += domain.length;
  out[at++] = (originBytes.length >> 8) & 0xff;
  out[at++] = originBytes.length & 0xff;
  out.set(originBytes, at);
  at += originBytes.length;
  out.set(challenge, at);
  return out;
}

/*
 * The two encoders below are written out by hand rather than reaching for
 * `TextEncoder`, `atob` or `Buffer`. This module is imported by the React
 * Native app, by Node on the server, and by the CLI, and each of those three
 * disagrees about which of those globals exists — Hermes has no `Buffer`, the
 * app's tsconfig ships no DOM lib, and a runtime `typeof` probe would make the
 * signed bytes depend on which branch happened to be taken. A wire format that
 * varies by host is not a wire format.
 */

/** UTF-8 encode. Handles the astral plane via surrogate pairs, because an
 * origin is a hostname today and there is no reason to make that a rule. */
function utf8Bytes(text: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    let code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const low = text.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        code = (code - 0xd800) * 0x400 + (low - 0xdc00) + 0x10000;
        i++;
      }
    }
    if (code < 0x80) out.push(code);
    else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    else if (code < 0x10000)
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    else
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
  }
  return Uint8Array.from(out);
}

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Standard base64 → bytes. Throws on a character outside the alphabet rather
 * than skipping it: silently dropping a byte from a challenge would produce a
 * signature that fails to verify with no clue why. */
function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/=+$/, '');
  const out = new Uint8Array(Math.floor((clean.length * 6) / 8));
  let bits = 0;
  let acc = 0;
  let at = 0;
  for (let i = 0; i < clean.length; i++) {
    const value = B64_ALPHABET.indexOf(clean[i]!);
    if (value < 0) throw new Error('challenge is not standard base64');
    acc = (acc << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[at++] = (acc >> bits) & 0xff;
    }
  }
  return out;
}

/**
 * How long a WebSocket ticket stays usable.
 *
 * A ticket exists to cross the gap between an HTTPS response and a socket
 * dial — a round trip, not a session. Sixty seconds is generous for a phone on
 * a slow network and short enough that a value captured from a log is already
 * dead. Anything longer and it becomes a credential again, which is the thing
 * being removed.
 */
export const WS_TICKET_TTL_SECONDS = 60;

/**
 * What the socket dialled with this ticket is FOR.
 *
 * CONSTRAINT: the connections table holds exactly ONE routing row per account,
 * so anything that dials must either want that row or be kept out of the
 * competition for it. A one-shot `tacendum send` never wanted it — it opens a
 * socket to push one frame and collect one receipt, and both of those post to
 * its own connectionId, which needs no row. Competing anyway is what produced
 * the outage this enum removes: the one-shot's $connect won the row, its
 * $disconnect deleted it moments later, and the account's long-lived listener
 * was left holding a healthy socket nothing pointed at while every message
 * queued toward the 30-day TTL.
 *
 *  - 'listen' — competes for the routing row, owns it, is probed by other
 *    listeners, and can be displaced by one. What every client did before this
 *    existed, and the default for exactly that reason.
 *  - 'send'  — never claims the row, is never probed, is never displaced, and
 *    its $disconnect can never remove anyone's row. It still gets its queue
 *    drain (`send --drain`, `sync`), because the drain posts to the dialling
 *    connection, not to whatever the row names.
 *
 * DECLARED BY THE CLIENT, AND THAT NEEDS NO AUTHORIZATION MECHANISM. Both roles
 * belong to the same already-authenticated user. A client that lies and claims
 * 'listen' recreates precisely the behaviour every client had before roles
 * existed; a client that lies and claims 'send' only stops receiving its own
 * routed messages. Neither reaches another account, so there is nothing here
 * for an authorization check to protect.
 */
export const WsTicketRole = z.enum(['listen', 'send']);
export type WsTicketRole = z.infer<typeof WsTicketRole>;

/**
 * The request body of `POST /v1/ws-ticket`.
 *
 * `role` is optional and absence means 'listen': a client built before roles
 * existed sends no body at all, and it must keep exactly today's behaviour
 * rather than silently becoming a socket that receives nothing.
 */
export const WsTicketRequest = z.object({ role: WsTicketRole.optional() });
export type WsTicketRequest = z.infer<typeof WsTicketRequest>;

/** The response to `POST /v1/ws-ticket`. */
export const WsTicketResponse = z.object({
  /**
   * Opaque, single-use, and the ONLY thing that may appear in a socket URL.
   *
   * base64url because that is what it is minted as, and because it goes in a
   * query string: the standard alphabet's `+` and `/` need percent-encoding to
   * survive one.
   */
  ticket: Base64Url.max(128),
  /** Unix seconds. OPTIONAL on the wire:
   * the server always emits it, but no shipped client reads it, and a
   * required field the client never uses is pure breakage surface — with no
   * OTA path, a response that ever dropped it would stop every installed
   * build from dialling. The app's strict parse tolerates its absence now;
   * the server-side tests keep pinning its presence. */
  expiresAt: z.number().int().positive().optional(),
});
export type WsTicketResponse = z.infer<typeof WsTicketResponse>;

/**
 * What one platform must be running.
 *
 * `minBuild` is the FLOOR: a client whose own build is below it stops opening
 * its workspace until the store hands the owner a newer one. It is the one
 * required field, and it is required for the reason the others are not: a
 * response the client cannot read is treated as "no answer" and allows, so an
 * absent floor parsed as zero would be a gate nobody wrote.
 *
 * `latestBuild` and `url` are OPTIONAL under the MSG-W1 rule recorded on
 * `WsTicketResponse` above: the app `.parse()`s this strictly and there is no
 * OTA path, so any field a server might one day stop emitting must already
 * tolerate absence in every installed build. Without `url` the screen simply
 * carries no store button, which is why it can be missing at all.
 */
export const ClientPolicyPlatform = z.object({
  minBuild: z.number().int().nonnegative(),
  latestBuild: z.number().int().nonnegative().optional(),
  // HTTP(S) ONLY, and that is not decoration. This value is handed straight
  // to the client's `Linking.openURL`, and a bare url check admits
  // `javascript:alert(1)` and `ftp://...`, both verified, exactly as
  // `linkSafeSourceUrl` found for the AGPL §13 offer. A store link that is
  // not fetchable over the web is not a store link, and a scheme the OS
  // hands to something other than a browser is a hole in a row an operator
  // types by hand.
  url: z.url({ protocol: /^https?$/ }).max(200).optional(),
});
export type ClientPolicyPlatform = z.infer<typeof ClientPolicyPlatform>;

/**
 * The response to `GET /v1/client-policy`: the same bytes for every caller.
 *
 * BOTH platforms are always present so one shape serves both stores and the
 * client never has to decide what a missing platform means. `message` is the
 * operator's one line of extra explanation, bounded so a row can never turn
 * the update screen into a billboard.
 */
export const ClientPolicyResponse = z.object({
  ios: ClientPolicyPlatform,
  android: ClientPolicyPlatform,
  message: z.string().max(200).optional(),
});
export type ClientPolicyResponse = z.infer<typeof ClientPolicyResponse>;

/** How long an issued challenge stays usable. Long enough for a slow device to
 * run a signature, short enough that a captured nonce is worthless — and it is
 * only a nonce: reading one gains nothing without the private key. */
export const AUTH_CHALLENGE_TTL_SECONDS = 120;

/** Sessions last 30 days.
 *
 * Lives here rather than in a handler, which is where it started: it began in
 * `handlers/verify.ts`, that file is gone with the phone number, and the
 * constant outlived it. POST /v1/auth is now the only issuer. */
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

// POST /v1/auth/challenge  ->  { challenge, expiresAt }
export const AuthChallengeRequest = z.object({
  identityKey: IdentityKeyB64,
});
export type AuthChallengeRequest = z.infer<typeof AuthChallengeRequest>;

/**
 * Where this deployment's Corresponding Source lives (AGPL §13: source
 * offers, prominent and version-exact).
 *
 * §13 reaches every REMOTE user of the auth service — unauthenticated callers,
 * App Review, CLI users, automated integration accounts — and the API Gateway
 * boundary changes nothing about that. A hidden `/v1/source` route would be a
 * weak offer, so the offer instead rides in the only two responses nobody can
 * reach this service without seeing.
 *
 * The DEPLOYED value should name the exact release tag serving that caller,
 * never a moving branch, which is why the server takes it from configuration
 * (`TACENDUM_SOURCE_URL`). This constant is only the fallback: the repo root is
 * honest before any tag exists and stays a valid offer once one does.
 */
export const AGPL_SOURCE_URL_DEFAULT = 'https://github.com/MiranaTechs/Tacendum';

export const AuthChallengeResponse = z.object({
  challenge: ChallengeB64,
  /** Unix seconds. The client should not bother signing a stale one.
   * OPTIONAL on the wire: always emitted, never read by a shipped client
   * — see `WsTicketResponse`. */
  expiresAt: z.number().int().nonnegative().optional(),
  /**
   * The §13 source offer — see `AGPL_SOURCE_URL_DEFAULT`. Mirrored by a
   * `Link: <url>; rel="source https://tacendum.com/rel/source"` header on the
   * same response (`SOURCE_LINK_REL` in the server's auth-account handler),
   * because a program reading headers and a person reading JSON are both
   * remote users.
   *
   * Optional in the SCHEMA and it must stay so: both clients parse this with a
   * plain `.parse` against a non-strict object, so a server that predates the
   * field must keep parsing here. That is a statement about clients, never a
   * licence for the server to omit it.
   */
  source: z.string().optional(),
});
export type AuthChallengeResponse = z.infer<typeof AuthChallengeResponse>;

// POST /v1/auth  ->  { userId, authToken }
export const AuthRequest = z.object({
  identityKey: IdentityKeyB64,
  challenge: ChallengeB64,
  /** Signature over AUTH_CHALLENGE_DOMAIN || <raw challenge bytes>. */
  signature: SignatureB64,
  /** Renewal must never create an account after this device's ID was deleted. */
  expectedUserId: Ulid.optional(),
  /**
   * Declared ONCE, at account creation, by clients that are integrations —
   * CLI notifiers, CI bots. Honored only when this auth
   * MINTS the account; on every later sign-in the stored row is the
   * authority, so a class can never be acquired, shed, or spoofed after
   * birth. Optional so every existing client remains valid unchanged.
   */
  accountClass: z.literal('integration').optional(),
});
// NO `keys` payload here, deliberately. An earlier draft folded the first key
// upload into this call to save a round trip; it was dropped for two reasons.
// (1) IAM: persisting keys would need the auth function to hold UpdateItem on
// users and write access to the prekeys table, widening the one endpoint that
// must be reachable before anyone has an account. (2) It is unnecessary — the
// account row carries `identityKeyPub` from birth (written in the same
// transaction as the claim), so the ordinary `PUT /v1/keys` path is already
// pinned to the key that proved the account and cannot introduce a split
// state. Keys go up on their own route, as they always did.
export type AuthRequest = z.infer<typeof AuthRequest>;

/** The only sign-in response there is: `{ userId, authToken }`, the same shape
 * the deleted verify response had, so the client's session handling did not
 * have to change when the phone path went away. */
export const AuthResponse = z.object({
  userId: z.string(),
  authToken: z.string(),
  /**
   * What this account IS, as the server holds it. Absent means an ordinary human account.
   *
   * Reported rather than left to the client to infer, because the client
   * cannot: it does not know whether its own `POST /v1/auth` created the
   * account or resolved an existing one, and guessing from local state was
   * wrong in both directions — a first registration that failed after the
   * keys were written left the next run recording "human" over a
   * server-side integration, which no later command could repair. The row
   * is the authority; this is the row speaking.
   */
  accountClass: z.literal('integration').optional(),
  /**
   * The AGPL §13 source offer, on the sign-in response for the same reason it
   * is on the challenge — see `AGPL_SOURCE_URL_DEFAULT` and the note on
   * `AuthChallengeResponse.source`. Optional for client compatibility only.
   */
  source: z.string().optional(),
});
export type AuthResponse = z.infer<typeof AuthResponse>;

/**
 * POST /v1/integrations/bind — an integration account names its owner, once.
 * The owner is the ULID the human read off their own
 * my-code screen and handed to the CLI (`tacendum pair <code>`); a bare id,
 * never a URL or scheme (the standing QR guardrail). Write-once server-side:
 * re-binding to a different owner is a 409.
 */
export const IntegrationBindRequest = z.object({
  owner: Ulid,
});
export type IntegrationBindRequest = z.infer<typeof IntegrationBindRequest>;

// --- Optional account grouping ---

/**
 * Domain separation for every link-op identity signature. Pinned HERE, single source, exactly as `AUTH_CHALLENGE_DOMAIN`
 * is: the same identity key signs auth challenges and link ops, so every
 * distinct thing it signs must be unambiguously tagged.
 *
 * The preimage this domain tags is op-FRAMED and length-prefixed per the
 * signed-bytes discipline `authSignedBytes` established above:
 *
 *   "tacendum-link-v1" ‖ op ‖ groupId ‖ offererUlid ‖ acceptorUlid ‖
 *   subjectIdentityPubKey ‖ class ‖ rosterEpoch ‖ offerNonce ‖ expiresAt
 *
 * The byte-stream builder and its per-op fixture vectors land with the first
 * signature producer/verifier — this constant
 * lands first so there is exactly one spelling for it to build on. The op
 * frame is what keeps an acceptance from ever reading as a trust certificate
 * or any other op.
 */
export const LINK_DOMAIN = 'tacendum-link-v1';

/** The five link ops the domain frames — pinned; a sixth op is a plan
 * amendment. */
export const LINK_OPS = ['offer', 'accept', 'unlink', 'revoke', 'dissolve'] as const;
export type LinkOp = (typeof LINK_OPS)[number];

/**
 * Device-slot taxonomy: exactly one member per class per
 * group. An ACCOUNT-slot concept, not a UI concept — the app's rendering
 * model stays width-class-driven and never reads this enum.
 *
 * `desktop` is deliberately IN the schema while no desktop client ships: the
 * slot is a schema reservation, refused at the link transaction until
 * a follow-on decision activates it — so activation is a
 * condition-lift, not a migration. The SCHEMA accepting the value and the
 * TRANSACTION refusing it are both load-bearing.
 */
export const DEVICE_CLASSES = ['phone', 'tablet', 'desktop'] as const;
export type DeviceClass = (typeof DEVICE_CLASSES)[number];
export const DeviceClassSchema = z.enum(DEVICE_CLASSES);

/** ≤3 members per group — one per class, by construction. Named for ACCOUNT grouping: `GROUP_MAX_MEMBERS` in group-fold
 * is the unrelated chat-group cap. */
export const ACCOUNT_GROUP_MAX_MEMBERS = DEVICE_CLASSES.length;

/** Link offers: TTL 10 min, single-use, explicit expiry checked at accept —
 * a release pin. The number itself, never a test-config shadow. */
export const LINK_OFFER_TTL_SECONDS = 10 * 60;

/**
 * The full link-op tuple — every preimage field except the op,
 * which frames it. `subjectIdentityPubKey` is the OTHER party's REGISTERED
 * identity public key (standard base64 of the serialized key): the offer
 * names the acceptor's, the acceptance names the offerer's, and a roster
 * mutation names the TARGET's — so a signature proves WHICH key was approved
 * (or removed) even against a lying server.
 */
export interface LinkOpTuple {
  groupId: string;
  offererUserId: string;
  acceptorUserId: string;
  subjectIdentityPubKey: string;
  class: DeviceClass;
  rosterEpoch: number;
  offerNonce: string;
  expiresAt: number;
}

/**
 * The exact bytes a link-op identity signature covers:
 *
 *   "tacendum-link-v1" ‖ op ‖ groupId ‖ offererUlid ‖ acceptorUlid ‖
 *   subjectIdentityPubKey ‖ class ‖ rosterEpoch ‖ offerNonce ‖ expiresAt
 *
 * EVERY field after the domain is uint16be-length-prefixed — the
 * `authSignedBytes` discipline, applied to all nine fields because none of
 * them is fixed-width: one field's end being another's beginning is the
 * oldest concatenation bug there is, and here two ULIDs sit adjacent.
 *
 * Encodings, pinned: the op, ids, class, and nonce are UTF-8;
 * `subjectIdentityPubKey` is the RAW serialized key bytes (base64-decoded —
 * the key IS bytes; signing its base64 spelling would make the signature
 * depend on a transport encoding); the two integers are ASCII decimal
 * (`String(n)`) — JS-safe for every value this program mints, and
 * byte-unambiguous under the length prefix.
 *
 * ONE definition for four implementations (server verify, app signer via
 * `signLinkOp`, CLI, Swift) — the fixture vectors are the drift
 * detector, exactly as `authvectors.json` is for the auth preimage.
 */
export function linkOpSignedBytes(op: LinkOp, tuple: LinkOpTuple): Uint8Array {
  // The authority carries every guard its copies do: the
  // Swift and Kotlin builders refuse an unknown op, a non-integer, and an
  // empty field — an empty field verifies against nothing anyone meant to
  // say — and the laxest copy must not be this one. Unreachable from the
  // wire (zod pins every field non-empty), load-bearing for direct callers.
  if (!(LINK_OPS as readonly string[]).includes(op)) {
    throw new Error('unknown link op');
  }
  if (
    !Number.isInteger(tuple.rosterEpoch) ||
    tuple.rosterEpoch < 0 ||
    !Number.isInteger(tuple.expiresAt) ||
    tuple.expiresAt < 0
  ) {
    throw new Error('link-op integers must be nonnegative integers');
  }
  const fields: Uint8Array[] = [
    utf8Bytes(op),
    utf8Bytes(tuple.groupId),
    utf8Bytes(tuple.offererUserId),
    utf8Bytes(tuple.acceptorUserId),
    base64ToBytes(tuple.subjectIdentityPubKey),
    utf8Bytes(tuple.class),
    utf8Bytes(String(tuple.rosterEpoch)),
    utf8Bytes(tuple.offerNonce),
    utf8Bytes(String(tuple.expiresAt)),
  ];
  const domain = utf8Bytes(LINK_DOMAIN);
  let total = domain.length;
  for (const f of fields) {
    if (f.length === 0) throw new Error('link-op field must be non-empty');
    if (f.length > 0xffff) throw new Error('link-op field too long to length-prefix');
    total += 2 + f.length;
  }
  const out = new Uint8Array(total);
  out.set(domain, 0);
  let at = domain.length;
  for (const f of fields) {
    out[at++] = (f.length >> 8) & 0xff;
    out[at++] = f.length & 0xff;
    out.set(f, at);
    at += f.length;
  }
  return out;
}

// --- Device-linking routes ---

/** Server-minted single-use offer nonce (a ULID today; bounded, opaque). */
const OfferNonce = z.string().min(1).max(128);

/**
 * POST /v1/devices/link-offer — the INIT leg (token path, authenticated, no
 * signature; §2.2 step 4). ULID_A declares who it scanned and which slot the
 * joiner takes; the server mints/returns the tuple A must sign. A solo
 * offerer also declares its OWN class (`offererClass`) because the first
 * link births the group row with both members; a grouped offerer must omit
 * it — the roster already knows.
 */
export const LinkOfferInitRequest = z.object({
  acceptorUserId: Ulid,
  acceptorClass: DeviceClassSchema,
  offererClass: DeviceClassSchema.optional(),
});
export type LinkOfferInitRequest = z.infer<typeof LinkOfferInitRequest>;

/** The tuple to sign, recorded server-side in the TTL'd init row keyed to
 * the offerer — a client-chosen groupId or epoch matches no init row and is
 * refused at submit. */
export const LinkOfferInitResponse = z.object({
  groupId: Ulid,
  rosterEpoch: z.number().int().nonnegative(),
  offerNonce: OfferNonce,
  /** Unix seconds — the offer's explicit expiry, inside the preimage. */
  expiresAt: z.number().int().nonnegative(),
});
export type LinkOfferInitResponse = z.infer<typeof LinkOfferInitResponse>;

/**
 * POST /v1/devices/link-offer/submit — the SUBMIT leg (auth Lambda; §2.2
 * step 4). Carries ONLY the nonce and A's op="offer" identity signature: the
 * server rebuilds the preimage from its OWN recorded init row and the
 * acceptor's REGISTERED identity key, so there are no other parameters to
 * lie about — a signature over a tuple the init row did not record simply
 * fails to verify.
 */
export const LinkOfferSubmitRequest = z.object({
  offerNonce: OfferNonce,
  /** A's identity signature over the op="offer" preimage. */
  signature: SignatureB64,
});
export type LinkOfferSubmitRequest = z.infer<typeof LinkOfferSubmitRequest>;

/** POST /v1/devices/link-accept (auth Lambda; §2.2 step 6): ULID_B's
 * op="accept" signature over the same tuple, subject = the OFFERER's
 * registered key. */
export const LinkAcceptRequest = z.object({
  offerNonce: OfferNonce,
  signature: SignatureB64,
});
export type LinkAcceptRequest = z.infer<typeof LinkAcceptRequest>;

/**
 * POST /v1/devices/unlink and /v1/devices/revoke (auth Lambda; §2.3): a
 * fresh identity signature by the ACTING member (the authenticated caller)
 * over the op-framed preimage — offererUlid = the actor, acceptorUlid = the
 * target, subject = the TARGET's registered identity key (server-resolved),
 * class = the target's slot, plus a fresh nonce and the mutation's own
 * explicit expiry. The epoch condition inside the transaction is the
 * authorization; the signature is what makes a stolen bearer token unable to
 * mutate a roster at all.
 *
 * `targetClass` is in the request because the preimage binds it and the
 * ROSTER is not always available to resolve it from: the idempotent
 * completion of a committed-but-not-torn-down revoke
 * re-verifies the signature after the target has already left the roster.
 * When the target IS in the roster, the server refuses a class that
 * disagrees with it.
 *
 * `boundAgents` (revoke only): the victim's integration-class accounts,
 * named by the CALLER because the server deliberately cannot enumerate them
 * (no owner→integrations index, ever) while the sibling-synced client roster
 * can (§5). Each named agent is verified to be an integration OWNED BY the
 * target before its identity key is tombstoned in the same transaction as
 * the roster removal — naming anything else is the collapsed refusal.
 */
export const DeviceRosterMutationRequest = z.object({
  groupId: Ulid,
  targetUserId: Ulid,
  targetClass: DeviceClassSchema,
  rosterEpoch: z.number().int().nonnegative(),
  offerNonce: OfferNonce,
  /** Unix seconds — the mutation signature's own expiry, checked at
   * verification (TTL-style reaping never enforces anything here). */
  expiresAt: z.number().int().nonnegative(),
  signature: SignatureB64,
  boundAgents: z.array(Ulid).max(8).optional(),
});
export type DeviceRosterMutationRequest = z.infer<typeof DeviceRosterMutationRequest>;

/**
 * The two §2.2 ceremony signatures, stored on a member entry as its link
 * certificates: the offer IS the offerer's certification of the joiner (it
 * binds the joiner's identity public key under the offerer's key) and the
 * acceptance IS the joiner's certification of the offerer. Availability
 * copies, never authority — peers verify them CLIENT-side against identity
 * keys they already pinned (§2.2 step 8).
 *
 * A signature nobody can re-derive the preimage for is not a certificate:
 * the offer row that held the signed tuple
 * is CONSUMED by the link transaction, so the certificate carries its own
 * tuple context — every preimage field EXCEPT
 * `subjectIdentityPubKey`, which a verifier must supply from its OWN pins /
 * the served bundle (the offer preimage names the acceptor's key, the
 * acceptance names the offerer's). Deliberately so: storing the subject key
 * here would invite verifying the server's copy against the server's copy;
 * omitting it forces the verification to bind the keys the peer actually
 * trusts, which is what "a certificate proves WHICH key was approved even
 * against a lying server" means.
 */
export const GroupMemberCerts = z.object({
  offerSig: Base64.max(256),
  acceptSig: Base64.max(256),
  /** The ceremony's groupId — inside both preimages (never rendered in UI). */
  groupId: Ulid,
  /** ULID_A: the existing member whose op="offer" signature certified the
   * joiner. */
  offererUserId: Ulid,
  /** ULID_B: the joining device whose op="accept" signature certified the
   * offerer. */
  acceptorUserId: Ulid,
  /** The tuple's class field = the JOINING device's slot — not
   * necessarily the class of the member entry this cert sits on (a first
   * link stores the same ceremony on both member entries). */
  class: DeviceClassSchema,
  /** The roster epoch both signatures bound (0 for a first link). */
  rosterEpoch: z.number().int().nonnegative(),
  /** The single-use offer nonce inside both preimages. */
  offerNonce: z.string().min(1).max(128),
  /** The offer's explicit expiry (unix seconds) inside both preimages. A
   * verifier checks the SIGNATURE against these bytes; the expiry gated the
   * ceremony at accept time and is not re-checked at verify time. */
  expiresAt: z.number().int().nonnegative(),
});
export type GroupMemberCerts = z.infer<typeof GroupMemberCerts>;

/** One sibling device in a grouped peer's roster, as the bundle response
 * serves it (§2.5): device ULID + class + the link certificates.
 *
 * `certs` is OPTIONAL, honestly rather than forged: two member
 * classes exist that no §2.2 ceremony ever ran for — the founding member of
 * a solo group lazily created by an identifier attach (§3: the attach call
 * declares a class, not a co-signer), and a recovery-attached device (§3:
 * recovery restores GROUPING only; peers owe it the full TOFU ceremony).
 * Fabricating certificate bytes for either would be forging signatures; an
 * absent cert is the truth, and the client's standing rule already covers
 * it: a sibling without a verifiable cross-signature is block-and-warn
 * (§2.5) — exactly the posture a ceremony-less member deserves. */
export const GroupSibling = z.object({
  userId: Ulid,
  class: DeviceClassSchema,
  certs: GroupMemberCerts.optional(),
});
export type GroupSibling = z.infer<typeof GroupSibling>;

/**
 * The server-minted notice a ceremony or roster mutation fans to a member's
 * queue. Rides the ordinary
 * durable queue as a row of type 'accounts' and drains as an
 * `AccountsNoticeFrame`; the payload is base64 of this JSON. Server-visible
 * plaintext by construction — it carries only facts the server already
 * holds (ULIDs, classes, epoch, the ceremony signatures), never message
 * content.
 */
export const AccountsNotice = z.discriminatedUnion('kind', [
  z.object({
    /** Delivered to the ACCEPTOR: the pending offer to display and confirm
     * (§2.2 step 5). `offerSig` lets the client verify A's offer against the
     * identity key it fetches for A — client-verified truth, as ever. */
    kind: z.literal('linkOffer'),
    groupId: Ulid,
    offererUserId: Ulid,
    acceptorUserId: Ulid,
    acceptorClass: DeviceClassSchema,
    rosterEpoch: z.number().int().nonnegative(),
    offerNonce: OfferNonce,
    expiresAt: z.number().int().nonnegative(),
    offerSig: SignatureB64,
  }),
  z.object({
    /** Fanned to every EXISTING member when a link commits (§2.2 step 7).
     * SIGNED/VERIFIABLE: the
     * notice carries the ceremony's own §2.2 certificates plus the joiner's
     * registered identity key — the offer preimage's subject — so a member
     * verifies the offerer's signature against the offerer's key it ALREADY
     * holds before its local roster moves. A replayed or forged
     * memberLinked can therefore never resurrect a revoked device even on
     * a fresh install with no local epoch: the certificate names WHICH key
     * was approved, and a tombstoned key's ULID re-appearing under any
     * other key verifies against nothing. */
    kind: z.literal('memberLinked'),
    groupId: Ulid,
    userId: Ulid,
    class: DeviceClassSchema,
    rosterEpoch: z.number().int().nonnegative(),
    /** The joiner's REGISTERED identity public key (the offer preimage's
     * subject) — what the certificate is verified to bind. */
    identityKeyPub: IdentityKeyB64,
    /** The §2.2 ceremony certificates, tuple context included. */
    certs: GroupMemberCerts,
  }),
  z.object({
    /** SIGNED/VERIFIABLE: the acting member's
     * op-framed identity signature rides the notice with the full preimage
     * context, so a sibling verifies it against the acting member's key it
     * already holds — a self-named wipe or a replayed removal on server
     * word alone verifies against nothing. */
    kind: z.literal('memberUnlinked'),
    groupId: Ulid,
    userId: Ulid,
    class: DeviceClassSchema,
    rosterEpoch: z.number().int().nonnegative(),
    /** The ACTING member (the preimage's offererUlid). */
    actingUserId: Ulid,
    /** The TARGET's registered identity key — the preimage's subject: the
     * mutation names WHICH key it removes. */
    subjectIdentityPubKey: IdentityKeyB64,
    /** The mutation's fresh nonce (inside the preimage). */
    offerNonce: OfferNonce,
    /** The mutation signature's own explicit expiry (inside the preimage). */
    expiresAt: z.number().int().nonnegative(),
    /** The epoch the acting member SIGNED (the preimage's rosterEpoch —
     * the pre-commit epoch; `rosterEpoch` above stays the post-commit
     * roster version, so monotonicity semantics are unchanged). */
    signedRosterEpoch: z.number().int().nonnegative(),
    /** The acting member's identity signature over the op="unlink"
     * preimage, reconstructible from the fields above. */
    signature: SignatureB64,
  }),
  z.object({
    /** Same wire shape as memberUnlinked, op="revoke" (§12 row 24b). */
    kind: z.literal('memberRevoked'),
    groupId: Ulid,
    userId: Ulid,
    class: DeviceClassSchema,
    rosterEpoch: z.number().int().nonnegative(),
    actingUserId: Ulid,
    subjectIdentityPubKey: IdentityKeyB64,
    offerNonce: OfferNonce,
    expiresAt: z.number().int().nonnegative(),
    signedRosterEpoch: z.number().int().nonnegative(),
    signature: SignatureB64,
  }),
  // --- Recovery notices. Server-word by necessity,
  // and honestly so: the recovering device's key is pinned by NOBODY yet, so
  // there is no signature a sibling could verify these against. They are
  // LOUDNESS (the §3 mandatory notification), never authorization — the
  // authorization is the 72 h delay + the member cancel + the completion
  // transaction's conditions, all server-enforced, and the recovered device
  // itself arrives at peers as an un-cross-signed new key (block-and-warn).
  z.object({
    /** Fanned to EVERY member the moment a recovery is requested: each can
     * cancel inside the delay window, and the cancel WINS (§3). */
    kind: z.literal('recoveryRequested'),
    groupId: Ulid,
    /** The declared slot the recovering device will take (the incumbent case
     * is the normal case — §3). */
    class: DeviceClassSchema,
    /** Unix seconds: the earliest moment completion can commit. */
    completesAt: z.number().int().nonnegative(),
  }),
  z.object({
    /** Fanned to the surviving members when the delay expired uncancelled and
     * the attach transaction committed. */
    kind: z.literal('recoveryCompleted'),
    groupId: Ulid,
    /** The NEW device's ULID (a brand-new keypair account — never a prior
     * member's ULID, §3). */
    userId: Ulid,
    class: DeviceClassSchema,
    rosterEpoch: z.number().int().nonnegative(),
  }),
  z.object({
    /** Fanned to every member when a surviving member cancelled the pending
     * recovery — the loud confirmation that the cancel won. */
    kind: z.literal('recoveryCancelled'),
    groupId: Ulid,
  }),
  // --- Username revocation. The
  // operator lane detached the holder's NAME (impersonation or namespace-
  // blocking); every member of the holder's group learns it here. KIND
  // ONLY, reasonless on the wire BY DESIGN: the reason class is recorded
  // operator-side, never in a payload, and the notice carries no
  // groupId either — the name is the group's one username slot, so there
  // is nothing to disambiguate and nothing a stray delivery could name.
  // Server-word by necessity (no member acted); it is loudness, never
  // authorization — the tombstone is the enforcement.
  z.object({
    kind: z.literal('usernameRevoked'),
  }),
]);
export type AccountsNotice = z.infer<typeof AccountsNotice>;

/** Every kind the union above knows, derived from it (never a second
 * spelling): the tolerant parser's "known" set. */
export const ACCOUNTS_NOTICE_KINDS: ReadonlySet<string> = new Set(
  AccountsNotice.options.map((member) => member.shape.kind.value),
);

/**
 * THE TOLERANT-UNKNOWN-KIND FALLBACK.
 * `AccountsNotice` is hard-parsed by the app with no OTA, so a kind minted
 * after a build ships would be a parse FAILURE on every such client — and a
 * parse failure is indistinguishable from a malformed frame. This parser
 * separates the two: a well-formed notice of a kind this build does not
 * know is `unknown` (the client acks it and moves on — tolerated, never
 * poison, never applied), while a KNOWN kind with a malformed body stays
 * `malformed` exactly as before (a `recoveryRequested` missing its horizon
 * is a broken frame, not a future one). Unknown kinds are detected by the
 * kind alone: a rider field on a known kind is the union's own business.
 */
export type AccountsNoticeParse =
  | { outcome: 'notice'; notice: AccountsNotice }
  | { outcome: 'unknown'; kind: string }
  | { outcome: 'malformed' };

const UnknownKindNotice = z.object({ kind: z.string().min(1) }).loose();

export function parseAccountsNoticeTolerant(raw: unknown): AccountsNoticeParse {
  const known = AccountsNotice.safeParse(raw);
  if (known.success) return { outcome: 'notice', notice: known.data };
  const shaped = UnknownKindNotice.safeParse(raw);
  if (shaped.success && !ACCOUNTS_NOTICE_KINDS.has(shaped.data.kind)) {
    return { outcome: 'unknown', kind: shaped.data.kind };
  }
  return { outcome: 'malformed' };
}

// --- Optional identifiers ---

/** The identifier classes. Email shipped first; phone and username joined
 * later. Username is a FINDING label, not a possession-proof class:
 * holding one qualifies its owner to BE FOUND, never to search, and it is
 * excluded from recovery absolutely (§4.8). */
export const IDENTIFIER_KINDS = ['email', 'phone', 'username'] as const;
export type IdentifierKind = (typeof IDENTIFIER_KINDS)[number];

/** Exactly ONE verified identifier PER CLASS per group: one email + one phone
 * may coexist, so `identifierRefs` grows to ≤2, still a GetItem walk. There
 * is no alias-hoarding surface to defend because no class has a second slot.
 * The group cap auto-grows to 3 with the username class. */
export const MAX_VERIFIED_IDENTIFIERS_PER_CLASS = 1;
export const MAX_VERIFIED_IDENTIFIERS_PER_GROUP = IDENTIFIER_KINDS.length;

/**
 * The ONE email normalization every HMAC claim key is derived from:
 * trim, then case-fold.
 *
 * Pinned in shared code because the app (attach/verify UX), the server
 * (claim-row derivation), and any future CLI surface must byte-agree —
 * a claim row written under one spelling and looked up under another is an
 * account that silently stopped being discoverable. `toLowerCase()` is the
 * fold: it is identical across JS engines for the ASCII local parts and IDN
 * hostnames real addresses carry, and the fixture vectors in
 * `test/accounts-dto.test.ts` are the drift detector. Deliberately NO
 * Unicode normalization (NFKC) and no provider-specific rewriting (dots,
 * plus-tags): the user's address is the identifier, not our guess at their
 * mailbox. Changing ANY of this orphans every existing claim row — it is a
 * plan amendment, not a tune.
 */
export function normalizeEmailIdentifier(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * The ONE phone normalization every `phonehash#` claim key is derived from:
 * strip human
 * formatting — spaces, hyphens, dots, parentheses — and NOTHING else. What
 * remains either IS a strict-E.164 string (`+`, then 2–15 digits, first
 * digit nonzero — `PHONE_E164_STRICT` below) or it is REFUSED by the wire
 * shape, never repaired: no extension parsing, no letter-to-digit mapping,
 * no `00`→`+` rewriting, and above all NO COUNTRY-CODE GUESSING — a guessed
 * country writes a claim row for a number the user does not own.
 *
 * BYTE-LOCKED once shipped, exactly as the email normalizer above is:
 * changing ANY of this orphans every existing phone claim row — it is a plan
 * amendment, not a tune. The fixture vectors in the suites are the
 * drift detector.
 *
 * The disjointness this spelling buys is LOAD-BEARING: a
 * normalized phone matches `^\+[1-9][0-9]{1,14}$` and can never contain
 * `@`, while a normalized email always carries exactly one — so the two
 * classes share the item-4(c) HMAC subkey with no constructible cross-class
 * collision, and the suite asserts the disjointness rather than
 * assuming it.
 */
export function normalizePhoneIdentifier(raw: string): string {
  return raw.replace(/[\s\-.()]/g, '');
}

/** Strict E.164: `+`, then 2–15 digits, first digit nonzero. The
 * ONLY shape a normalized phone identifier may take — anything else is
 * refused, never repaired. */
export const PHONE_E164_STRICT = /^\+[1-9][0-9]{1,14}$/;

// --- Username identifier. Everything here is BYTE-LOCKED once
// shipped, exactly as the email and phone normalizers above are: changing
// any of it orphans every usernamehash#/nameskel# claim row — a plan
// amendment, not a tune. The username-dto.test.ts fixture vectors are the
// drift detector.

/** The ONLY shape a normalized username may take (§4.3): 3–32 chars, starts
 * with a letter, lowercase ASCII letters/digits/underscore only — anything
 * else is refused, never repaired. Lowercase-ASCII-only kills the entire
 * Unicode homoglyph class structurally; the ASCII confusables that remain
 * are the skeleton row's job (`usernameSkeleton` below). */
export const USERNAME_STRICT = /^[a-z][a-z0-9_]{2,31}$/;

/**
 * The ONE username normalization every `usernamehash#` claim key is derived
 * from: trim, then case-fold — the email normalizer's
 * exact moves, with the REFUSAL living in the wire shape exactly as phone's
 * does: what this returns either matches `USERNAME_STRICT` or the schema
 * refuses it, never repairs it. No NFKC, no transliteration: Unicode that
 * case-folds INTO the ASCII set (e.g. U+212A Kelvin sign → 'k') collapses
 * into the canonical name — same claim bytes, same row, uniqueness-
 * preserving and harmless; everything else fails the regex and refuses.
 */
export function normalizeUsernameIdentifier(raw: string): string {
  return raw.trim().toLowerCase();
}

/** The §4.3 per-character confusable map, step 1 of the skeleton. Digit 1
 * confuses with BOTH l and i, so folding i→l collapses all three onto one
 * spelling. Extending this map is a plan amendment and does NOT
 * retro-protect existing rows (§7 residual 1, recorded honestly). */
const USERNAME_SKELETON_CHAR_MAP: Readonly<Record<string, string>> = {
  '0': 'o',
  '1': 'l',
  i: 'l',
  '2': 'z',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '6': 'b',
  '7': 't',
  '8': 'b',
  '9': 'g',
};

/**
 * The pinned confusable skeleton — the SECOND claim row
 * (`nameskel#`) is derived from this, so `a1ice`, `al1ce`, `adm1n` and
 * `rnirana` are unclaimable while their targets stand. Applying the steps IN
 * THIS ORDER is part of the pin:
 *
 *   1. the per-character map above (so 1→l can mint a `cl` for step 2);
 *   2. the string folds rn→m, then vv→w, then cl→d (multi-character
 *      confusables, one left-to-right pass each);
 *   3. strip `_` (last, so the folds never see through an underscore).
 *
 * Deterministic ASCII approximation, not a proof — the residual is a
 * documented limit, not a claim of completeness. Input is the NORMALIZED username; the output
 * space is a subset of the username charset minus '_', so the §4.2
 * disjointness argument is undisturbed (the row class lives at the
 * `nameskel#` prefix).
 */
export function usernameSkeleton(normalized: string): string {
  let folded = '';
  for (const ch of normalized) {
    folded += USERNAME_SKELETON_CHAR_MAP[ch] ?? ch;
  }
  return folded
    .replaceAll('rn', 'm')
    .replaceAll('vv', 'w')
    .replaceAll('cl', 'd')
    .replaceAll('_', '');
}

/**
 * The compiled-in reserved denylist: checked server-side on the in-transit normalized plaintext
 * AND skeleton-vs-skeleton, before hashing; refusal answers the same
 * `taken` bytes as occupancy (the §4.5 one-bit rule). Public by nature, so
 * shared placement lets the client pre-check for UX at zero wire cost.
 * Additions are code deploys.
 */
export const RESERVED_USERNAMES = [
  'tacendum',
  'mirana',
  'admin',
  'administrator',
  'support',
  'help',
  'security',
  'official',
  'staff',
  'team',
  'moderator',
  'mod',
  'root',
  'system',
  'abuse',
  'billing',
  'info',
  'contact',
  'verify',
  'verified',
] as const;

/** The build-time skeletonized twin (§4.3): the reserved names are
 * themselves skeletonized and the candidate is matched exact-vs-exact AND
 * skeleton-vs-SKELETON — a plain skeleton-vs-name check would be broken by
 * the i→l fold (`m0derator` must still hit `moderator`; `adm1n` skeletonizes
 * to `admln`, which no un-skeletonized list contains). */
export const RESERVED_USERNAME_SKELETONS: ReadonlySet<string> = new Set(
  RESERVED_USERNAMES.map(usernameSkeleton),
);

/**
 * THE AFFIX RULE: the operator/brand subset of the denylist, refused as the
 * FIRST or LAST `_`-separated segment of a name as well as whole —
 * `tacendum_support`, `mirana_official`, `admin_alice`, `security_team` were
 * all claimable under the exact/skeleton check alone. Each end segment is
 * matched exact AND skeleton-vs-skeleton (`adm1n_bob`, `rnirana_help`), so
 * the §4.3 fold reaches the affixes too. Deliberately affix-shaped, not
 * substring-shaped (`teamster`, `adminsky` and `alice_team_x` stay
 * claimable), and deliberately small: the list is pinned by test, and
 * additions are code deploys like the denylist's. Squatting stays bounded
 * rather than eliminated — this tightens the bound.
 */
export const RESERVED_USERNAME_AFFIXES = [
  'tacendum',
  'mirana',
  'admin',
  'support',
  'security',
  'official',
  'staff',
  'team',
] as const;

const RESERVED_USERNAME_AFFIX_SKELETONS: ReadonlySet<string> = new Set(
  RESERVED_USERNAME_AFFIXES.map(usernameSkeleton),
);

/** Does a NORMALIZED username start or end with a reserved affix (with `_`
 * separators)? Exact or by skeleton, per end segment. */
export function hasReservedUsernameAffix(normalized: string): boolean {
  const segments = normalized.split('_').filter((segment) => segment.length > 0);
  if (segments.length < 2) return false;
  return [segments[0]!, segments[segments.length - 1]!].some(
    (segment) =>
      (RESERVED_USERNAME_AFFIXES as readonly string[]).includes(segment) ||
      RESERVED_USERNAME_AFFIX_SKELETONS.has(usernameSkeleton(segment)),
  );
}

/**
 * The username TOMBSTONE window:
 * a renamed, unlinked, deleted, or revoked name's claim rows are overwritten
 * with `{tombstoned, formerGroupId?, freesAt: now + this}` and re-claimable
 * by the FORMER owner at once, by anyone once `freesAt` passes — enforced as
 * the tombstone-aware claim condition at EVERY key version, never a reaper
 * (the users table has no TTL attribute; the lookup-facing read reaps an
 * elapsed tombstone exactly as the suppression shadows are reaped). A
 * revocation tombstone carries NO `formerGroupId`: nobody reclaims early.
 */
export const USERNAME_TOMBSTONE_TTL_SECONDS = 30 * 86400;
/**
 * The rename cool-down (1 name change per 30 days) — a stored
 * fact on the group row (`usernameRenamedAt`), stamped by a SUCCESSFUL
 * rename and by a successful unlink (an unlink followed by a claim of another
 * name is a rename in two verbs — the hoarding fix), condition-
 * checked inside the five-item rename transaction AND the claim transaction
 * (except the former owner's reclaim of its own live tombstone), and consumed
 * on SUCCESS only: a failed rename or claim burns budget, never the
 * cool-down. Equal to the tombstone window by design, not by accident — the
 * two bound the same churn from both sides.
 */
export const USERNAME_RENAME_COOLDOWN_SECONDS = 30 * 86400;
/**
 * Claim attempts per CLAIMING GROUP per day: the same 10/day pin as the attach budget but its OWN bucket
 * (`unameclaim:<group>`), deliberately NOT the shared `emailattach:` window —
 * a username claim sends nothing, so the SMS-spend rationale does
 * not transfer, and sharing would let the design's own "taken, pick
 * another" loops exhaust the group's email/phone attach budget for the
 * day. Charged per ATTEMPT (claim and rename alike, refused or not): the
 * taken-oracle's retail price is ≤10 occupancy bits per account per day.
 */
export const USERNAME_CLAIMS_PER_ACCOUNT_PER_DAY = 10;
/**
 * The fleet-wide daily claim ceiling (§4.5), alarm twin at 50% — derived
 * from claim economics (~2 conditional DDB writes per attempt) and matched
 * to the lookup lane's fleet shape, NOT borrowed from the SMS lane's
 * spend-bound 200/day.
 */
export const USERNAME_CLAIM_FLEET_DAILY_CEILING = 2000;

// --- Email linking + recovery ---
//
// Every number below is a release pin: RELEASE values, asserted as
// themselves by the suites (never a test-config shadow), and loosening
// any of them is a plan amendment, not a tune.

/** Verification codes: TTL 5 min — the established code-row precedent — with
 * the EXPLICIT `expiresAt` checked at validation (TTL reaping is asynchronous
 * cleanup, never the enforcement). */
export const EMAIL_CODE_TTL_SECONDS = 5 * 60;
/** Attempt cap per code row: every validation attempt (right or wrong)
 * consumes one; past the cap the row is dead. */
export const EMAIL_CODE_ATTEMPT_CAP = 5;
/** Resend cool-down, keyed by the identifier HMAC (never the plaintext). */
export const EMAIL_CODE_RESEND_COOLDOWN_SECONDS = 60;
/** Identifier sends: ≤5/day per recipient ADDRESS (HMAC-keyed). */
export const IDENTIFIER_SENDS_PER_RECIPIENT_PER_DAY = 5;
/** Attach attempts: ≤10/day per group (per requesting account pre-group). */
export const IDENTIFIER_ATTACH_ATTEMPTS_PER_DAY = 10;
/** Fleet-wide daily send ceiling, with the alarm pinned at 50% of it. */
export const IDENTIFIER_SEND_FLEET_DAILY_CEILING = 1000;
/** Recovery: the mandatory delay — a surviving member's cancel wins at ANY
 * point inside it (§3). */
export const RECOVERY_DELAY_SECONDS = 72 * 3600;
/** Recovery: the discovery cool-down, enforced as the read-time
 * `discoverableAfter` rule on the claim row (§6) — no cron, no scheduler. */
export const RECOVERY_DISCOVERY_COOLDOWN_SECONDS = 7 * 24 * 3600;
/** Suppression shadows (`emailsupp#…`, §3): the explicit expiry stamped at
 * write and enforced at the reading walk. The shadow is a CACHE of SES's
 * synchronous suppression answer — SES account-level suppression is the
 * durable authority — so expiry costs at most one SES RPC per window, and an
 * address SES still suppresses re-writes the shadow at that send. 90 days,
 * the push-token liveness shape: state not re-confirmed by the provider in a
 * quarter belongs to the provider, not to a Tacendum row. */
export const EMAIL_SUPPRESSION_TTL_SECONDS = 90 * 86400;

// --- Phone linking + recovery. Every number below is a pinned RELEASE value the
// suites assert verbatim; loosening any is a plan amendment. Where a
// value is "unchanged" from email, the EMAIL_* constant above is reused
// directly (code TTL 5 min, attempt cap 5, resend cool-down 60 s — nothing
// about SMS changes the code row's threat shape).

/** OTP sends per recipient NUMBER per day (HMAC-keyed, charged uniformly hit
 * and miss — the anti-probing budget). Tighter than email's 5 because each
 * SMS spends OUR money to an attacker-chosen number. */
export const PHONE_SENDS_PER_RECIPIENT_PER_DAY = 3;
/** Fleet-wide SMS send burst. Charged on VENDOR SENDS
 * only. */
export const PHONE_SEND_FLEET_BURST_PER_MINUTE = 5;
/** Fleet-wide daily SMS send ceiling, alarm at 50% (the SES shape; email's
 * 1,000 scaled down). Charged on VENDOR SENDS only.
 *
 * RECONCILED WITH THE US$25 MONTHLY WALL, honestly: this message-count ceiling is NOT
 * the spend bound. 200/day at the pinned MaxPrice US$0.05/part admits up to
 * ~US$310/30 days (~US$47-68 at realistic US toll-free list price); the
 * BINDING spend bound is the account-level US$25/month wall
 * (SMS_MONTHLY_SPEND_LIMIT_USD, a deploy-lane human step), which sustained
 * ceiling-level traffic reaches around day 12 — after which EUM refuses
 * every send for the rest of the month ('failed', uniform bytes to
 * callers): a silent phone-verification outage. That failure mode is the
 * recorded availability residual, paged by the SmsSendFailedAlarm on the
 * `sms_code_send_failed` counter and preceded by
 * the US$12.50 spend alarm (~6 days' notice at the ceiling). Moving either
 * pin is a plan amendment. */
export const PHONE_SEND_FLEET_DAILY_CEILING = 200;
/** The phonesupp# vendor-refusal shadow rides the SAME 90-day pin as email's
 * (EMAIL_SUPPRESSION_TTL_SECONDS above — one liveness rule, two classes). */
export const PHONE_SUPPRESSION_TTL_SECONDS = EMAIL_SUPPRESSION_TTL_SECONDS;

/**
 * The identifier as the wire carries it. Deliberately a LIGHT shape check
 * (bounded length, one '@', no whitespace) rather than an RFC gauntlet: the
 * user's address is the identifier (§3 — no provider rewriting, no guessing),
 * `normalizeEmailIdentifier` is the ONE canonicalization, and a stricter
 * validator here would refuse addresses real mail servers accept. 320 is the
 * RFC 5321 ceiling.
 */
export const EmailIdentifier = z
  .string()
  .min(3)
  .max(320)
  .refine((v) => {
    const at = v.indexOf('@');
    return at > 0 && at === v.lastIndexOf('@') && at < v.length - 1 && !/\s/.test(v);
  }, 'not an email address');

/** The 6-digit verification code, as minted.
 * ONE shape for both identifier classes — the phone wire reuses it verbatim. */
export const EmailCode = z.string().regex(/^[0-9]{6}$/);

/**
 * The phone identifier as the wire carries it: human
 * formatting is stripped by `normalizePhoneIdentifier`, and what remains
 * must be strict E.164 — refused, never repaired. 32 bounds the RAW input
 * (16 normalized chars + formatting headroom); the claim bytes are always
 * the NORMALIZED spelling.
 */
export const PhoneIdentifier = z
  .string()
  .min(2)
  .max(32)
  .refine((v) => PHONE_E164_STRICT.test(normalizePhoneIdentifier(v)), 'not an E.164 phone number');

/** POST /v1/identifiers/email/request-code (token path; §3): ask for a code
 * to the address the caller wants to ATTACH. Carries the caller's
 * self-declared device class because the verify leg may lazily create a solo
 * group and there is no classless member state (§3). */
export const EmailCodeRequest = z.object({
  email: EmailIdentifier,
  class: DeviceClassSchema,
});
export type EmailCodeRequest = z.infer<typeof EmailCodeRequest>;

/** POST /v1/identifiers/email/verify (token path; §3): the attach itself —
 * code proven, claim row written, solo group lazily created if needed. */
export const EmailVerifyRequest = z.object({
  email: EmailIdentifier,
  code: EmailCode,
});
export type EmailVerifyRequest = z.infer<typeof EmailVerifyRequest>;

/** POST /v1/identifiers/phone/request-code (token path): the
 * phone attach twin of EmailCodeRequest. The ROUTE is the identifier class —
 * no discriminant field exists — and
 * `class` keeps its landed DEVICE-SLOT meaning, exactly as on the email
 * wire. */
export const PhoneCodeRequest = z.object({
  phone: PhoneIdentifier,
  class: DeviceClassSchema,
});
export type PhoneCodeRequest = z.infer<typeof PhoneCodeRequest>;

/** POST /v1/identifiers/phone/verify (token path): the phone
 * attach itself — EmailVerifyRequest's twin, same 6-digit code shape. */
export const PhoneVerifyRequest = z.object({
  phone: PhoneIdentifier,
  code: EmailCode,
});
export type PhoneVerifyRequest = z.infer<typeof PhoneVerifyRequest>;

/**
 * The username identifier as the wire carries it. The phone posture verbatim: the ONE
 * normalization is applied and what remains must match `USERNAME_STRICT` —
 * refused, never repaired. 64 bounds the RAW input (32 normalized chars +
 * trim headroom); the claim bytes are always the NORMALIZED spelling.
 */
export const UsernameIdentifier = z
  .string()
  .min(3)
  .max(64)
  .refine((v) => USERNAME_STRICT.test(normalizeUsernameIdentifier(v)), 'not a username');

/**
 * POST /v1/identifiers/username/claim (token path; ships dark until the
 * username feature flag arms). The ROUTE is the identifier
 * class — no discriminant field (the phone route-shape precedent)
 * — and the same verb IS rename when the caller already holds a name
 * (§4.8). `discoverable` is the EXPLICIT consent-at-claim bit (§4.6): the
 * wire always carries it, the claim row's structural default stays OFF
 * (absent attribute = OFF), and an unchecked claim is legal — name held but
 * unfindable. `.strict()`: a rider field is malformed and collapses, never
 * stripped.
 */
export const UsernameClaimRequest = z
  .object({
    username: UsernameIdentifier,
    discoverable: z.boolean(),
  })
  .strict();
export type UsernameClaimRequest = z.infer<typeof UsernameClaimRequest>;

/**
 * GET /v1/identifiers/username/eligibility — the authenticated caller's
 * own possession-proof state. No identifier, name, age, target, or refusal
 * reason travels on this caller-owned read.
 */
export const UsernameEligibilityResponse = z
  .object({ hasVerifiedIdentifier: z.boolean() })
  .strict();
export type UsernameEligibilityResponse = z.infer<typeof UsernameEligibilityResponse>;

/**
 * POST /v1/identifiers/username/unlink (token path):
 * the per-class twin of the email/phone unlink, whose routes carry no body —
 * this schema PINS that emptiness (`.strict()` on the empty object: any key
 * at all is malformed), so nothing ever rides along on the unlink verb.
 */
export const UsernameUnlinkRequest = z.object({}).strict();
export type UsernameUnlinkRequest = z.infer<typeof UsernameUnlinkRequest>;

/**
 * The taken-409 answer: the username CLAIM verb — and only it — answers `taken`
 * distinguishably, because in this class uniqueness is the product. What it
 * discloses is namespace occupancy of a self-chosen public label — never
 * linkage — and ONLY as the priced side effect of an authenticated,
 * identifier-verified, budget-charged WRITE attempt. Reserved names,
 * skeleton conflicts, and live tombstones answer these SAME bytes, so the
 * one distinguishable answer stays one bit. Deliberately NOT the
 * accountsRefusal bytes: `taken` must be distinguishable BY DESIGN, and
 * reusing the frozen-403 bytes would poison that refusal stream's meaning.
 */
export const USERNAME_TAKEN_STATUS = 409;
/** The frozen body, byte-pinned — the server serves these exact bytes. */
export const USERNAME_TAKEN_BODY = '{"error":"taken"}';
export const UsernameTakenResponse = z.object({ error: z.literal('taken') }).strict();
export type UsernameTakenResponse = z.infer<typeof UsernameTakenResponse>;

/** The parallel-field refinement,
 * generalized to ONE-OF-THREE: exactly ONE of {email,
 * phone, username} populated — the identifier class IS the populated field;
 * no field named `class` ever carries it (`class` is the landed device
 * slot). Two-or-more populated and none populated are malformed and
 * collapse. The recovery wires below share this refinement but never carry
 * `username`: their `.strict()` rejects the key BEFORE the refinement runs
 * (a handle possesses nothing — pinned forever), so for them
 * one-of-three is exactly the landed one-of-two. */
const IDENTIFIER_WIRE_FIELDS = ['email', 'phone', 'username'] as const;
const exactlyOneIdentifier = (v: {
  email?: unknown;
  phone?: unknown;
  username?: unknown;
}): boolean => IDENTIFIER_WIRE_FIELDS.filter((field) => v[field] !== undefined).length === 1;

/** POST /v1/recovery/request-code (token path): the
 * RECOVERING device — a fresh, pristine keypair account — asks for a code to
 * the identifier it claims. PARALLEL identifier fields, never a discriminant:
 * `email` went optional and `phone` joined beside it,
 * `.strict()` + exactly-one-of, and the landed `{email}` wire parses to the
 * identical object (the captured replay fixture pins that). Uniform
 * answer whether or not the identifier resolves (rule 2) — and class-blind:
 * a phone-shaped miss and an email-shaped miss are byte-identical. */
export const RecoveryCodeRequest = z
  .object({
    email: EmailIdentifier.optional(),
    phone: PhoneIdentifier.optional(),
  })
  .strict()
  .refine(exactlyOneIdentifier, 'exactly one of email or phone');
export type RecoveryCodeRequest = z.infer<typeof RecoveryCodeRequest>;

/** POST /v1/recovery/verify (token path): code proven — the
 * pending recovery row is born (recording its identifier class, derived from
 * the claim-key PREFIX that proved the code — never client-asserted) and
 * every member is notified. `class` KEEPS its landed device-slot meaning
 * beside the parallel identifier fields: it is the declared slot
 * (the incumbent case is the normal case), not an identifier discriminant. */
export const RecoveryVerifyRequest = z
  .object({
    email: EmailIdentifier.optional(),
    phone: PhoneIdentifier.optional(),
    code: EmailCode,
    class: DeviceClassSchema,
  })
  .strict()
  .refine(exactlyOneIdentifier, 'exactly one of email or phone');
export type RecoveryVerifyRequest = z.infer<typeof RecoveryVerifyRequest>;

/** The one fact the recovering device needs back: when it may complete, and
 * the groupId it must name at completion (an API fact, never rendered — the
 * groupId-never-peer-visible rule is about UI). */
export const RecoveryVerifyResponse = z.object({
  groupId: Ulid,
  completesAt: z.number().int().nonnegative(),
});
export type RecoveryVerifyResponse = z.infer<typeof RecoveryVerifyResponse>;

/**
 * POST /v1/recovery/complete (AUTH Lambda; §3, §6 route placement — this is
 * the one recovery leg that verifies a libsignal identity signature). The
 * recovering device proves LIVE possession of its registered identity key by
 * signing a fresh v2 audience-bound auth challenge — the EXISTING preimage
 * domain and the exact machinery registration and link-acceptance already
 * ride. A stolen bearer alone can
 * therefore never complete a recovery — the keypair-account guarantee,
 * kept.
 */
export const RecoveryCompleteRequest = z.object({
  groupId: Ulid,
  /** A fresh challenge minted by POST /v1/auth/challenge for the CALLER's
   * registered identity key. */
  challenge: Base64.max(128),
  /** The caller's identity signature over `authSignedBytes(origin, challenge)`
   * — the same bytes a sign-in signs. */
  signature: SignatureB64,
});
export type RecoveryCompleteRequest = z.infer<typeof RecoveryCompleteRequest>;

// --- Contact discovery ---
//
// Every number below is a release pin: RELEASE values, asserted as
// themselves by the suites (never a test-config shadow), and loosening
// any of them is a plan amendment, not a tune.

/** Per-account daily lookup budget (20/day). */
export const DISCOVERY_LOOKUPS_PER_ACCOUNT_PER_DAY = 20;
/** Per-account lookup burst (5/min). */
export const DISCOVERY_LOOKUP_BURST_PER_MINUTE = 5;
/** The fleet-wide global lookup ceiling (2,000/day — beyond it,
 * uniform refusals + the scrape alarm). */
export const DISCOVERY_LOOKUP_FLEET_DAILY_CEILING = 2000;
/** The email/phone discovery anti-Sybil age gate. Username lookup and
 * claim accept fresh accounts once they hold a verified possession proof;
 * their separate caller and fleet budgets remain enforced. Numerically the
 * recovery delay, but its OWN pin — these values answer different threats. */
export const DISCOVERY_MIN_ACCOUNT_AGE_SECONDS = 72 * 3600;
/** Per-TARGET aggregate one-time-prekey budget across ALL requesters
 * (30 fetches/day, then signed-prekey-only degrade — the
 * anti-Sybil drain floor). */
export const PREKEY_TARGET_DAILY_FETCH_BUDGET = 30;
/** THE TIMING BOUND: over an
 * interleaved 200-sample run, the median latency delta between the miss and
 * non-consented-hit branches of the lookup must stay at or under this many
 * milliseconds. The structural single-exit assertion is the sharp edge; this
 * is the empirical failing mode (one skipped-or-added DB round trip on one
 * branch shifts the median past it). */
export const DISCOVERY_TIMING_MEDIAN_BOUND_MS = 5;

/** POST /v1/discovery/lookup (token path): the
 * typed-SINGLE-identifier lookup — one address the caller typed, never a
 * batch, never an address book. PARALLEL identifier fields, never a
 * discriminant (no field named `class`
 * ever carries the identifier class on any of these wires): `email` went
 * optional and `phone` joined beside it, `.strict()` +
 * exactly-one-of, and the landed `{email}` wire parses to the identical
 * object (the captured replay fixture pins that). `.strict()` also still
 * ENFORCES typed-single: a batch-shaped payload
 * ({email, emails:[…]}) is malformed and collapses, rather than Zod
 * stripping the extra keys and quietly executing the one — and so are the
 * both-fields and neither-field shapes (the refinement).
 *
 * `username` joined as the THIRD parallel field —
 * server-first, the same rule: the class IS the populated field,
 * the refinement is one-of-three, the landed `{email}` and `{phone}` wires
 * parse to the identical objects (the captured replay fixture pins that,
 * re-cut deliberately), and the RESPONSE shape below is untouched — no
 * echo, no new field, so shipped clients parse a username-resolved hit
 * exactly as they parse an email-resolved one. */
export const DiscoveryLookupRequest = z
  .object({
    email: EmailIdentifier.optional(),
    phone: PhoneIdentifier.optional(),
    username: UsernameIdentifier.optional(),
  })
  .strict()
  .refine(exactlyOneIdentifier, 'exactly one of email, phone, or username');
export type DiscoveryLookupRequest = z.infer<typeof DiscoveryLookupRequest>;

/** POST /v1/identifiers/email/discoverable (token path; §4): the owner's
 * consent toggle — an owner-written attribute on the identifier claim row,
 * default OFF, answered with the uniform 204. */
export const SetDiscoverableRequest = z.object({
  discoverable: z.boolean(),
});
export type SetDiscoverableRequest = z.infer<typeof SetDiscoverableRequest>;

/** One member as the positive lookup answer carries it: ULID (+ an
 * OPTIONAL class), NOTHING else — no certs (the bundle route serves those),
 * no names, no linkedAt.
 *
 * `class` went optional at build 19: per-member
 * device classes are a disclosure the lookup has no business making. The
 * deployed server currently sends the CONSTANT literal 'phone' for every
 * member (build-18 clients .parse() the field as required, and there is no
 * OTA), so build 19 must accept BOTH the still-sending server and the
 * future one that drops the field entirely. Anchor choice no longer leans
 * on the field carrying information (see app pickDiscoveryAnchor). */
export const DiscoveryLookupMember = z.object({
  userId: Ulid,
  class: DeviceClassSchema.optional(),
});
export type DiscoveryLookupMember = z.infer<typeof DiscoveryLookupMember>;

/** The §4 minimal disclosure, exactly: member ULIDs + classes + roster
 * version. NO identifier echo and NO groupId — the client fetches each
 * member's bundle via the EXISTING per-user route and pins keys TOFU. */
export const DiscoveryLookupResponse = z.object({
  members: z.array(DiscoveryLookupMember).min(1).max(3),
  /** OPTIONAL on the wire: the server always emits it; the app reads only
   * `members` (pickDiscoveryAnchor), so a required-but-unread field only
   * widened the strict-parse blast radius. The server-side discovery tests
   * keep pinning its presence. */
  rosterVersion: z.number().int().nonnegative().optional(),
});
export type DiscoveryLookupResponse = z.infer<typeof DiscoveryLookupResponse>;

// GET /v1/keys/{userId}  ->  prekey bundle; consumes one one-time prekey.
//
// `rosterVersion` + `siblings` are the device-group dimension:
// ADDITIVE and optional, served only when the target is grouped AND the
// `feature#accounts` flag is ON — a solo target's bundle stays
// byte-identical to the pre-accounts response, so old clients see nothing new.
export const PrekeyBundle = z.object({
  userId: z.string(),
  registrationId: z.number().int().nonnegative(),
  identityKey: Base64,
  signedPrekey: SignedPrekey,
  kyberPrekey: KyberPrekey,
  oneTimePrekey: OneTimePrekey.optional(),
  lowPrekeyCount: z.boolean().optional(),
  /** The target group's roster epoch at serve time — the client's staleness
   * signal (§2.4): a mismatch against in-band notices triggers a re-fetch. */
  rosterVersion: z.number().int().nonnegative().optional(),
  /** The target's OTHER devices, certs included. Server-attested hint,
   * client-verified truth: an un-cross-signed sibling is block-and-warn. */
  siblings: z.array(GroupSibling).optional(),
});
export type PrekeyBundle = z.infer<typeof PrekeyBundle>;

/**
 * GET /v1/keys/{userId} for a REVOKED (tombstoned) device while the
 * `feature#accounts` flag is ON — §2.3's forwarding hint: status 404,
 * no bundle (the device is dead and must never gain new inbound sessions),
 * but the SURVIVING roster + certificates ride along so a peer holding ONLY
 * the dead ULID — the offline friend during a phone loss — re-targets after
 * verifying the certs against its own pins. Deliberately ApiError-shaped: an
 * old client parses it as the plain 404 error it also is, while a newer
 * client re-parses with this schema. Flag OFF serves the plain legacy
 * `not_found` 404 instead — the hint is DISCLOSURE and is flag-gated; refusing the bundle itself is ENFORCEMENT and never is.
 * Discloses only what the prekey route already disclosed to any ULID-holder.
 */
export const RevokedKeysHint = z.object({
  error: z.object({ code: z.literal('recipient_revoked'), detail: z.string() }),
  /** The surviving group's roster epoch at serve time. */
  rosterVersion: z.number().int().nonnegative(),
  /** Every SURVIVING member (the dead ULID was removed by the revoke
   * transaction and can never appear here). */
  siblings: z.array(GroupSibling),
});
export type RevokedKeysHint = z.infer<typeof RevokedKeysHint>;

/** Prekey pool is considered low below this many remaining one-time prekeys. */
export const LOW_PREKEY_THRESHOLD = 10;

// --- Attachments ---

/**
 * Ciphertext blob ceiling. Attachments are encrypted client-side (the server
 * only ever stores ciphertext), so this caps the ciphertext the presigned PUT
 * will accept — the signed Content-Length makes S3 enforce it.
 */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

// POST /v1/attachments  ->  { attachmentId, uploadUrl }
export const CreateAttachmentRequest = z.object({
  contentLength: z
    .number()
    .int()
    .positive()
    .max(MAX_ATTACHMENT_BYTES, `attachment exceeds ${MAX_ATTACHMENT_BYTES} bytes`),
});
export type CreateAttachmentRequest = z.infer<typeof CreateAttachmentRequest>;

export const CreateAttachmentResponse = z.object({
  attachmentId: z.string(),
  uploadUrl: z.string(),
});
export type CreateAttachmentResponse = z.infer<typeof CreateAttachmentResponse>;

// GET /v1/attachments/{attachmentId}  ->  { downloadUrl }
export const GetAttachmentResponse = z.object({
  downloadUrl: z.string(),
});
export type GetAttachmentResponse = z.infer<typeof GetAttachmentResponse>;

// --- calling: TURN + push ---------------------------

/**
 * An APNs device token is 32 bytes of hex (64 chars) today, but Apple has
 * lengthened it before and the value is opaque to us. Accept a generous hex
 * range rather than pinning 64 exactly, and bound it so a hostile client
 * cannot store an unbounded string on its own row.
 */
export const MAX_VOIP_TOKEN_LENGTH = 200;

/**
 * An FCM registration token is opaque too, longer than an APNs token
 * (~140–200 chars today), and NOT hex: it carries `:`, `-` and `_`. Same
 * posture as the APNs bound above — generous, because Google has changed the
 * format before, and bounded, because a hostile client must not store an
 * unbounded string on its own row.
 */
export const MAX_FCM_TOKEN_LENGTH = 512;

/**
 * The iOS registration — byte-for-byte the shape every shipped client already
 * sends. `platform` is OPTIONAL and admits only `'ios'`: no deployed build
 * sends the field at all, and "absent means iOS" is the compatibility rule
 * that keeps every one of them validating unchanged, forever. A new iOS build
 * may say it explicitly; nothing requires it to.
 */
const ApnsPushRegistration = z.object({
  platform: z.literal('ios').optional(),
  /**
   * The PushKit token that rings the phone for a call.
   *
   * OPTIONAL, like `alertToken`: a device may legitimately have one and not
   * the other — PushKit and UNUserNotificationCenter issue independently, and
   * declining the notification prompt leaves no alert token while a registry
   * that has not produced credentials yet leaves no VoIP one. Requiring this
   * meant an alert-only device could not register at all, so message
   * notifications could never reach it. At least one is still required; see
   * the refinement below.
   */
  voipToken: z
    .string()
    .min(32)
    .max(MAX_VOIP_TOKEN_LENGTH)
    .regex(/^[0-9a-fA-F]+$/, 'voipToken must be hex')
    .optional(),
  /** Which APNs host the token belongs to. A typo here would silently send
   * every push to the wrong environment and every call would fail to ring,
   * so the enum is closed. */
  /**
   * The APNs ALERT token, which is a different token from the VoIP one — a
   * device gets one from PushKit and another from
   * UNUserNotificationCenter, and sending an alert to the VoIP token fails
   * silently. Optional so a client that predates message notifications still
   * registers successfully; without it the server simply never sends one.
   */
  alertToken: z
    .string()
    .min(32)
    .max(MAX_VOIP_TOKEN_LENGTH)
    .regex(/^[0-9a-fA-F]+$/, 'alertToken must be hex')
    .optional(),
  env: z.enum(['sandbox', 'production']),
  bundleId: z.string().min(1).max(255),
})
  // A row with neither token can never be used for anything, so it is a
  // request to store nothing. Rejected here rather than written and skipped.
  .refine(v => Boolean(v.voipToken || v.alertToken), {
    message: 'at least one of voipToken or alertToken is required',
  });

/**
 * The Android registration, platform-honest rather than
 * shoehorned: ONE FCM token serves both the call-wake and message-wake lanes
 * (firebase-messaging issues one registration token per app instance,
 * and it feeds both `voipTokenUpdated` and `alertTokenUpdated` on the
 * device), so there is exactly one required token field. And there is
 * deliberately NO `env`: FCM has no sandbox/production host split — the APNs
 * enum names which of two Apple hosts to dial, a fact with no Google
 * analogue, and requiring a made-up value here would store a lie the sender
 * then appears to route on. `platform` is the REQUIRED discriminator, which
 * is also what keeps this branch unreachable by every existing iOS client.
 */
const FcmPushRegistration = z.object({
  platform: z.literal('android'),
  fcmToken: z
    .string()
    .min(32)
    .max(MAX_FCM_TOKEN_LENGTH)
    .regex(/^[A-Za-z0-9:_-]+$/, 'fcmToken must be an FCM registration token'),
  /** The applicationId — the same string iOS sends (`bundleId()` returns
   * the applicationId), under the same key so the row shape stays one shape. */
  bundleId: z.string().min(1).max(255),
});

// PUT /v1/push-token  ->  204
//
// A union, ordered iOS-first so the legacy shape is tried exactly as it
// always was. The branches cannot shadow each other: the Android branch
// REQUIRES `platform: 'android'` (which the iOS branch's `'ios'`-only literal
// rejects), and the iOS branch requires `env` plus at least one hex token
// (which an Android registration does not carry).
export const RegisterPushTokenRequest = z.union([
  ApnsPushRegistration,
  FcmPushRegistration,
]);
export type RegisterPushTokenRequest = z.infer<typeof RegisterPushTokenRequest>;

/**
 * POST /v1/turn-credentials -> ephemeral relay credentials.
 *
 * A POST rather than a GET because it MINTS a credential: it is not
 * idempotent and must not be cached by any intermediary.
 */
export const IceServer = z.object({
  urls: z.array(z.string().min(1)).min(1),
  username: z.string().optional(),
  credential: z.string().optional(),
});
export type IceServer = z.infer<typeof IceServer>;

export const TurnCredentialsResponse = z.object({
  iceServers: z.array(IceServer).min(1),
  ttlSeconds: z.number().int().positive(),
});
export type TurnCredentialsResponse = z.infer<typeof TurnCredentialsResponse>;

/** Stable machine-readable error codes returned in `{ error: { code, detail } }`. */
export const ApiErrorCode = z.enum([
  'invalid_request',
  // No 'invalid_phone' / 'invalid_code' / 'code_expired': there is no number to
  // malform and no code to mistype. The keypair
  // equivalents are the three challenge/signature codes at the bottom.
  'unauthorized',
  'rate_limited',
  'not_found',
  'internal',
  /** No relay is configured or reachable — the client falls back to a direct
   * call rather than failing outright. */
  'turn_unavailable',
  'push_token_invalid',
  // --- Keypair-only accounts ---
  /** The presented challenge is unknown, already spent, or was issued for a
   * different identity key. Deliberately one code for all three: distinguishing
   * them would tell a caller which keys have a challenge outstanding. */
  'invalid_challenge',
  /** The challenge was issued but has aged out. Distinct from the above
   * because an honest slow client needs to know to ask for a fresh one, and
   * unlike a guessable code there is nothing an attacker learns from the
   * distinction: a nonce is worthless without the private key. */
  'challenge_expired',
  /** The signature does not verify under the presented identity key. */
  'invalid_signature',
  /** An attempt to bind a different identity key to an existing account.
   * Rotation is not a supported operation — a new key is a new account. */
  'identity_key_immutable',
  /** A claim row resolves but its user row is gone — only reachable after a
   * partially-failed deletion. The client retries as a new account rather than
   * the server silently minting a second account for one key. */
  'account_conflict',
  'account_gone',
  // --- Integration accounts ---
  /** The identity key was revoked by its integration's owner. Terminal: the
   * signature verified, the KEY is dead — never retried as fresh auth. */
  'identity_tombstoned',
  /** Caller is not an integration account (integration-only route). */
  'not_integration',
  /** Caller does not own this integration (owner-only route). */
  'not_integration_owner',
  /** The integration is already bound to a different owner; bindings are
   * write-once. */
  'owner_conflict',
  /** The owner userId presented at bind does not resolve to an account. */
  'unknown_owner',
  /** The route is closed to integration-class accounts (push tokens). */
  'integration_forbidden',
  // --- Crews ---
  // handlers/crew.ts predicted "they join ApiErrorCode when a client-lane
  // change needs to parse them"; the app's machine section is that change.
  // Its strict ApiError parse dropped both codes on the floor, so the
  // crew-is-full remedy could never render.
  /** The owner's crew is at CREW_MAX_MEMBERS; revoke a member to free a slot. */
  'cap_reached',
  /** Transient contention on the crew's scope row — the identical call
   * against quiet state succeeds; retryable, never terminal. */
  'crew_contended',
  // --- Optional account grouping ---
  /** THE collapsed refusal for every accounts-program route: one code, one byte-stream — body, status, and headers identical
   * for the dark flag, a forged or missing signature, an expired or consumed
   * offer, an occupied slot, a stale epoch, a non-pristine joiner, and every
   * membership probe in between. Distinguishing any of them would answer a
   * question the caller has no consented right to ask (rule 2). */
  'accounts_refused',
  /** A send addressed to a ULID revoked-with-tombstone (§2.4): the row is
   * dead — deliberately DISTINCT, so a peer holding only the dead ULID knows
   * to re-resolve the surviving roster and re-target (§2.3's forwarding
   * hint) instead of retrying forever. Discloses only what the prekey route
   * already disclosed to any ULID-holder. */
  'recipient_revoked',
  // --- Recovery-kit rebind (§3 as amended 2026-09-03) ---
  // APPENDED, never edited: adding a code to a union the client parses is
  // safe (an installed build simply never sees it); changing or removing one
  // breaks every shipped parse, and there is no OTA.
  /** THE collapsed refusal for `POST /v1/rebind`: wrong proof, unenrolled
   * account, and unknown ULID answer one byte-identical 403. Distinguishing
   * them would turn the route into an enrolment oracle over bare ULIDs
   * (§2 inv. 7). */
  'kit_rebind_failed',
  /** The NEW identity key presented for a rebind is already claimed by a
   * DIFFERENT account. Deliberately distinct from the refusal above: it says
   * nothing about the target account, only about a key the caller just minted
   * and can freely mint again — the client regenerates and retries. */
  'identity_key_in_use',
]);
export type ApiErrorCode = z.infer<typeof ApiErrorCode>;

export const ApiError = z.object({
  error: z.object({
    code: ApiErrorCode,
    detail: z.string(),
  }),
});
export type ApiError = z.infer<typeof ApiError>;

// --- Abuse reports ---

/**
 * Why someone is being reported. A closed set, because free-text categories
 * are unsortable and invite the reporter to type things that did not need to
 * leave their phone.
 */
export const ReportReason = z.enum([
  'spam',
  'harassment',
  'impersonation',
  'child_safety',
  'other',
]);
export type ReportReason = z.infer<typeof ReportReason>;

/**
 * A single message the reporter CHOSE to attach, in the clear.
 *
 * This is the only plaintext that ever reaches the server, and it exists
 * solely because App Store guideline 1.2 requires a reporting mechanism that
 * a human can act on. Read the constraints as privacy machinery, not
 * validation:
 *
 * - It is optional at every level. A report with no excerpts is a complete,
 *   actionable report — account plus category — and that is the DEFAULT.
 * - It carries no msgId and no ciphertext. Sending an id would let the server
 *   correlate the report to the queued envelope it already relayed, which is
 *   exactly the linkage the product is built to prevent; a copy of the
 *   ciphertext would be useless anyway, since the server holds no key.
 * - `sentAt` is coarse (the client rounds to the hour) for the same reason.
 */
export const ReportExcerpt = z.object({
  /** Plaintext the reporting user explicitly selected. Bounded so a report
   * cannot become a bulk transcript upload. */
  body: z.string().min(1).max(2_000),
  /** Whether the reporter sent it or received it — the difference between
   * evidence and self-incrimination, and a reviewer needs to know which. */
  direction: z.enum(['in', 'out']),
  /** Unix ms, rounded by the client to the hour. */
  sentAt: z.number().int().nonnegative(),
});
export type ReportExcerpt = z.infer<typeof ReportExcerpt>;

export const CreateReportRequest = z.object({
  /** The account being reported. The reporter is the authenticated caller and
   * is never supplied by the client. */
  // A ULID: a report names an account, and an account id has exactly one
  // shape. Request-side tightening only — every shipped client already sends
  // the peer's ULID.
  reportedUserId: Ulid,
  reason: ReportReason,
  /**
   * At most five, and only what the reporter picked one by one. The cap is
   * the point: an unbounded array would turn "report" into "upload this
   * conversation", which is a different feature with a different consent
   * conversation attached to it.
   */
  excerpts: z.array(ReportExcerpt).max(5).optional(),
});
export type CreateReportRequest = z.infer<typeof CreateReportRequest>;

export const CreateReportResponse = z.object({
  /** Opaque id, so a follow-up email can name the report without the reporter
   * quoting its contents back. */
  reportId: z.string(),
});
export type CreateReportResponse = z.infer<typeof CreateReportResponse>;

/*
 * RE-EXPORTS FOR `./recovery.ts` (2026-09-03).
 *
 * The kit/rebind signed-bytes builders live in their own module because the
 * whole point of the split is that the kit verb never shares a namespace
 * with the shipped identifier-recovery verb. They still have to produce
 * bytes the same way `authSignedBytes` does, and a second hand-rolled UTF-8
 * encoder or base64 decoder in a sibling file is exactly the drift the two
 * encoders' own comment above warns about — a wire format that varies by
 * which copy you called is not a wire format.
 *
 * So the encoders and the three field schemas are re-exported under names
 * that say where they belong, rather than being copied. Appended at the end
 * of the file so no existing line moves.
 */
export {
  /** UTF-8 encode, for signed-bytes builders only. See `utf8Bytes` above. */
  utf8Bytes as signedBytesUtf8,
  /** Standard base64 → bytes, for signed-bytes builders only. Throws on a
   * character outside the alphabet. See `base64ToBytes` above. */
  base64ToBytes as signedBytesBase64Decode,
  /** Canonical base64, capped — the ONE spelling of an identity key. */
  IdentityKeyB64,
  /** Loose base64, capped — signatures are consumed as bytes, never compared
   * as strings against another endpoint's spelling. */
  SignatureB64,
  /** Loose base64, capped — same reasoning as `SignatureB64`. */
  ChallengeB64,
};
