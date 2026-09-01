import type { z } from 'zod';
import type { ApiErrorCode } from '@tacendum/shared';
import type { DataLayer, PushTokenRecord } from '../db/data.js';
import type { AlertPayload } from '../push/apns.js';
import type { LogFields } from '../log.js';
import type { RateLimiter } from '../ratelimit.js';
import type { CallMetricPublisher, CallMetricStore } from '../call-metrics.js';

/**
 * Normalized HTTP event/result. Handlers are pure functions of (event, deps)
 * (invariant) — no imports from src/local/. The local adapter builds
 * these from Node's http request; the Lambda entry maps
 * APIGatewayProxyEventV2 -> HttpEvent with the same handlers unchanged.
 */
export interface HttpEvent {
  method: string;
  path: string;
  headers: Record<string, string | undefined>;
  pathParameters?: Record<string, string | undefined>;
  body?: string | null;
  /** Client source IP (API GW requestContext.http.sourceIp; the local adapter
   * fills it from the socket). Used for per-IP rate limiting. */
  sourceIp?: string;
}

export interface HttpResult {
  statusCode: number;
  headers?: Record<string, string>;
  body?: string;
}

/** Request-body ceiling every HTTP host must enforce with a 413 before
 * dispatch (resource caps): the local adapter guards the stream, the
 * Lambda adapter guards the decoded event body. Lives here so the two hosts
 * cannot drift. */
export const MAX_BODY_BYTES = 1024 * 1024;

/**
 * The K_id set as one read sees it: the ACTIVE keys — or, on the first
 * reads a fresh AWS container serves, the Secrets Manager fetch still in
 * flight, which the identifier lane AWAITS and re-reads
 * (identifiers.ts `hmacKeys`) rather than refuses on. Refusing on it was an
 * earlier defect: the first "Claim this name" on a fresh container was the
 * frozen 403, the retry seconds later a 200. Local and test hosts hand over
 * `{ keys }` directly and never see the second shape.
 */
export type IdentifierHmacState =
  | { keys: ReadonlyArray<{ version: number; key: string }> }
  | { pending: Promise<void> };

/** Injected dependencies. Clock and generators are injected so handlers are
 * deterministic under test. `log` must never receive message payloads. */
export interface Deps {
  db: DataLayer;
  now(): number; // unix milliseconds
  newUserId(): string; // ULID
  newAuthToken(): string; // random 32 bytes, base64url
  /**
   * Account-challenge nonce: 32 random bytes, STANDARD base64
   * Not base64url — the shared DTO validates
   * against the same base64 alphabet Signal keys use, and '-'/'_' fail it.
   */
  newChallenge(): string;
  /**
   * This server's own API origin, e.g. `https://api.tacendum.com`
   * It goes inside the bytes a client signs, so a
   * signature minted for a different endpoint cannot be redeemed here.
   *
   * It comes from CONFIGURATION and must never be derived from the request.
   * `Host` and `X-Forwarded-Host` are attacker-controlled: reading either would
   * let the caller declare the audience it is being checked against, which
   * rebuilds the exact hole this field closes.
   */
  apiOrigin: string;
  rateLimit: RateLimiter;
  /** Optional: only hosts that expose aggregate call analytics inject this. */
  callMetrics?: {
    store: CallMetricStore;
    publisher: CallMetricPublisher;
  };
  /** Structured operational log. NEVER pass message payloads/plaintext/tokens
   * — only non-sensitive metadata. */
  log(event: string, fields?: LogFields): void;
  // The invariant that survives phone linking:
  // ACCOUNTS are still proved by a signature over a server nonce
  // no out-of-band channel is ever REQUIRED to
  // hold an account. The `email`/`sms` seams below serve the OPTIONAL
  // identifier-linking program only and the codes they
  // carry prove identifier possession, never account identity.
  /** Server-generated attachment id: 32 random bytes, base64url (unguessable —
   * possession of the id is the read capability, mirroring Signal's CDN model;
   * the blob is E2EE ciphertext either way). */
  newAttachmentId(): string;
  /** The 6-digit email verification code: platform
   * CSPRNG (`randomInt` — an id-shaped secret), zero-padded. Injected so
   * suites can name the code they expect; the code itself is deliberately NOT
   * hashed at rest (the shipped precedent). */
  newEmailCode(): string;
  /** Abuse-report id: a ULID, opaque and unrelated to either party
   * It is the only thing the creation log line carries,
   * precisely so the log never records who reported whom. */
  newReportId(): string;
  /** Presigned blob storage for E2EE attachments (MinIO locally, S3 in AWS).
   * The handlers never touch object bytes — clients PUT/GET ciphertext
   * directly against these URLs. */
  attachments: {
    /** Presigned PUT valid for exactly `contentLength` bytes (signed
     * Content-Length header — the store rejects any other size). */
    uploadUrl(attachmentId: string, contentLength: number): Promise<string>;
    downloadUrl(attachmentId: string): Promise<string>;
  };
  /** Relay configuration for calls or null when no TURN is
   * provisioned — calls then run direct-only rather than failing. */
  turn: TurnConfig | null;
  /**
   * The keyed-pseudonymization salt (opaque-ref.ts) — the SAME secret as
   * `turn.userSalt` (Secrets Manager `CoturnUserSalt` / local
   * `TURN_USER_SALT`), surfaced as its own field because two functions need
   * it that must not hold the full TURN config: the lifecycle log events
   * (`userRef` fields) and the activity actor key
   * (activity.ts) both pseudonymize with it, and the WebSocket adapter — the
   * dominant activity writer — deliberately never receives the coturn auth
   * secret. Optional and honestly degraded when absent (cold-start fetch in
   * flight, or TURN not provisioned): log refs read `unavailable` and
   * activity writes are skipped with a counter — the raw id is never the
   * fallback. NOTE the coupling this buys: a deployment without the turn
   * context has no salt and therefore no activity metrics.
   *
   * `| undefined` is spelled out for exactOptionalPropertyTypes: the AWS
   * factory exposes this as a live getter (like `turn`), which necessarily
   * yields undefined while the Secrets Manager fetch is in flight.
   */
  userRefSalt?: string | undefined;
  /** VoIP push channel. Wakes a sleeping device for an incoming call; a
   * no-op logger locally, APNs in AWS. Never carries
   * message content — only the ids the recipient could already derive. */
  push: PushSender;
  /**
   * The identifier-HMAC key set — `K_id` (the
   * derived-subkey construction, computed ONLY in opaque-ref.ts).
   * In AWS the value is fetched at runtime from Secrets Manager by ARN
   * (`IDENTIFIER_HMAC_KEY_ARN` — the TURN-salt posture: never a deploy-time
   * dynamic reference, never on the function configuration); locally a
   * plaintext `IDENTIFIER_HMAC_KEY` env; in suites an injected test key.
   * ≤2 entries — the rotation window (claim keys are versioned so the key
   * can actually rotate); resolution walks every entry, attach writes under
   * the newest. Absent (unprovisioned, or the cold-start fetch in flight):
   * the identifier routes refuse with the collapsed error — fail closed,
   * never a raw-identifier fallback.
   *
   * `| undefined` spelled out for exactOptionalPropertyTypes: the AWS
   * factory exposes this as a live getter (the `turn` pattern).
   */
  identifierHmac?: IdentifierHmacState | undefined;
  /**
   * Email delivery — Amazon SES through the deps
   * seam, exactly as push rides it: handlers never touch a transport SDK.
   * The ADDRESS exists in SES transit at send time and in no retained
   * Tacendum log (the seam's `ref` is the opaque HMAC ref, the ONLY
   * identifier-shaped value allowed near a log line). Absent = the routes
   * refuse with the collapsed error (fail closed).
   */
  email?: EmailSender;
  /**
   * SMS delivery — AWS End User Messaging
   * `SendTextMessage` on the SMS-Voice v2 API through the deps seam, exactly
   * as `email` rides SES: handlers never touch a transport SDK. The NUMBER
   * exists in EUM transit at send time and in no retained Tacendum log (the
   * seam's `ref` is the opaque HMAC ref — the only identifier-shaped value
   * allowed near a log line). The vendor's SYNCHRONOUS accept/refuse is the
   * ONLY delivery outcome v1 consumes — NO DLR/event pipe of any kind (at full strength). Absent = the phone routes refuse with the
   * collapsed error (fail closed).
   */
  sms?: SmsSender;
  /**
   * Best-effort transport disconnect of a live WebSocket by connectionId (session/account revocation). Deleting the connection row already stops
   * INBOUND routing to a revoked socket immediately; this additionally hangs
   * the socket up so it cannot keep SENDING before the WS `$default` recheck
   * fires. In AWS it is API Gateway `DeleteConnection`; the local adapter
   * closes the socket in its live-socket map.
   *
   * Optional — but NOT silently so. The security guarantee does not rest on
   * it: the connection-row delete plus the per-frame session guard are the
   * enforcement (a revoked socket's next frame and next delivery are refused
   * session-guard.ts states the exact residual), and this removes the
   * lingering open socket itself. The HTTP/Auth functions reach the WS API
   * only when infra grants them `execute-api:ManageConnections` (DELETE) on
   * it and sets `WS_API_DOMAIN` + `WS_API_STAGE`; a production deployment
   * additionally sets `WS_DISCONNECT_REQUIRED=1`, under which a missing pair
   * REFUSES to run at cold start (aws/deps.ts). A revoke that needed the
   * hang-up on a host without one logs `ws_disconnector_unwired`
   * (session-revoke.ts) — the absence is legitimate only in local dev and
   * unit harnesses. Deployment contract: SECURITY.md "Session revocation".
   */
  disconnectSocket?(connectionId: string): Promise<void>;
}

/**
 * Everything the TURN credential handler needs. The secret and the salt are
 * separate values on purpose: the salt anonymizes userIds in relay logs and
 * rotating it breaks correlation, while the auth secret is what coturn
 * verifies. Compromising one must not compromise the other.
 */
export interface TurnConfig {
  /** Advertised in ICE order; TLS/443 last so it is used only when UDP fails. */
  urls: string[];
  authSecret: string;
  userSalt: string;
  ttlSeconds?: number;
}

/** What became of a verification-code send.
 * `suppressed` = the provider refused the address as suppressed (bounce/
 * complaint history) — the caller records OUR suppression shadow keyed by
 * the HMAC ref, never the address. Every outcome is uniform to the remote
 * caller: a failed or suppressed send still answers the same bytes. */
export type EmailSendOutcome = 'sent' | 'suppressed' | 'failed';

export interface EmailSender {
  /** Send one 6-digit verification code to `address`. `ref` is the opaque
   * HMAC ref (log/metric key — the address itself must never reach a log).
   * Best-effort by contract: a failure costs the user a resend, never an
   * error shape that would break the route's uniform answer. */
  sendCode(input: {
    address: string;
    code: string;
    ref: string;
    purpose: 'attach' | 'recovery';
  }): Promise<EmailSendOutcome>;
}

/** What became of an SMS code send. `suppressed`
 * = the vendor SYNCHRONOUSLY refused the destination as opted out (the STOP
 * list) — the caller records OUR `phonesupp#` shadow keyed by the HMAC ref,
 * never the number; the vendor's own list stays authoritative. Synchronous
 * acceptance is NOT delivery — a carrier-side failure is invisible to us,
 * the named accepted cost: bounded by the 60 s resend + 3/day
 * per-number budgets (the user's retry IS the detection), the 50%
 * fleet-send alarm, and the live probe. Every outcome is uniform to the
 * remote caller. */
export type SmsSendOutcome = 'sent' | 'suppressed' | 'failed';

export interface SmsSender {
  /** Send one 6-digit verification code to `number` (normalized strict
   * E.164). `ref` is the opaque HMAC ref — the number itself must never
   * reach a log. Best-effort by contract, exactly as EmailSender. */
  sendCode(input: {
    number: string;
    code: string;
    ref: string;
    purpose: 'attach' | 'recovery';
  }): Promise<SmsSendOutcome>;
}

/** What became of a wake attempt. Only `token_invalid` obliges the caller to
 * act: that device will never receive another push, so its row must go. */
export type PushOutcome = 'sent' | 'token_invalid' | 'no_token' | 'failed';

export interface PushSender {
  /**
   * Wake a device for a call from `fromUserId`. Takes the token row the
   * caller already read, rather than a userId, so the transport never needs
   * its own database access — and so it cannot read a row for anyone else.
   *
   * Best-effort by contract: a failed push is never an error to the sender
   * because the caller's UI already degrades to "they may be offline".
   */
  wake(token: PushTokenRecord, fromUserId: string): Promise<PushOutcome>;

  /**
   * Notify a device of a MESSAGE. Same best-effort contract as `wake`.
   *
   * Carries the ciphertext so the device can render a preview without asking
   * the server for anything — and so the server, which cannot read it, is
   * never the thing that decides how much a notification reveals.
   */
  notify(token: PushTokenRecord, message: AlertPayload): Promise<PushOutcome>;
}

export type Handler = (event: HttpEvent, deps: Deps) => Promise<HttpResult>;

export interface AuthContext {
  userId: string;
}
export type AuthedHandler = (
  event: HttpEvent,
  deps: Deps,
  auth: AuthContext,
) => Promise<HttpResult>;

/** FROZEN because it is SHARED: `json` hands this same object to every
 * caller, so a single `result.headers['x'] = ...` anywhere would land on every
 * JSON response in the process. That is not hypothetical — the AGPL offer
 * (handlers/auth-account.ts) is exactly the kind of per-response header whose
 * obvious implementation is a mutation, and it would have grown a Link header
 * on all twenty routes instead of the two that owe one. Frozen, that mistake
 * throws at the mutation instead of shipping. Every current caller only reads. */
const JSON_HEADERS = Object.freeze({ 'content-type': 'application/json' });

export function json(statusCode: number, body: unknown): HttpResult {
  return { statusCode, headers: JSON_HEADERS, body: JSON.stringify(body) };
}

export function errorResult(statusCode: number, code: ApiErrorCode, detail: string): HttpResult {
  return json(statusCode, { error: { code, detail } });
}

/** 429 with a Retry-After header (whole seconds). */
export function rateLimitedResult(retryAfterSeconds: number): HttpResult {
  return {
    statusCode: 429,
    headers: { 'content-type': 'application/json', 'retry-after': String(retryAfterSeconds) },
    body: JSON.stringify({
      error: { code: 'rate_limited', detail: 'too many requests; slow down' },
    }),
  };
}

/** Parse + validate a JSON body against a zod schema. */
export function parseJson<S extends z.ZodType>(
  event: HttpEvent,
  schema: S,
): { ok: true; data: z.infer<S> } | { ok: false; result: HttpResult } {
  let raw: unknown;
  try {
    raw = JSON.parse(event.body ?? '');
  } catch {
    return { ok: false, result: errorResult(400, 'invalid_request', 'body must be valid JSON') };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => i.message).join('; ');
    return { ok: false, result: errorResult(400, 'invalid_request', detail) };
  }
  return { ok: true, data: parsed.data };
}

/** Extract a bearer token from the Authorization header (case-insensitive). */
export function bearerToken(event: HttpEvent): string | undefined {
  const header = event.headers['authorization'] ?? event.headers['Authorization'];
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1];
}
