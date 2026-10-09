import {
  ApiError,
  AuthChallengeResponse,
  AuthResponse,
  ClientPolicyResponse,
  CreateAttachmentResponse,
  GetAttachmentResponse,
  CreateReportRequest,
  CreateReportResponse,
  DiscoveryLookupResponse,
  IdentifierStateResponse,
  LinkOfferInitResponse,
  PrekeyBundle,
  RecoveryVerifyResponse,
  RevokedKeysHint,
  type DeviceClass,
  type DeviceRosterMutationRequest,
  type LinkOfferInitRequest,
  type UploadKeysRequest,
  TurnCredentialsResponse,
  UsernameEligibilityResponse,
  WsTicketResponse,
  type CallMetricReport,
} from '@tacendum/shared';
import { MAX_ATTACHMENT_BYTES } from '@tacendum/shared';
import { API_BASE } from './config';
import { currentToken, reauthenticate } from './reauth';
import { session } from './session';
import { accountRequestGeneration, accountRequestsSuspended } from './accountLifecycle';
// TYPE ONLY, and it has to stay that way: `updateGate` imports this module,
// so a value import here would be a runtime cycle. The gate owns the
// vocabulary of why a check is happening; this module owns what that costs
// on the wire (see `apiClientPolicy`).
import type { CheckReason } from './updateGate';

/** Thin REST client for the endpoints (mirrors the CLI's). */

/**
 * EVERY FETCH HAS A DEADLINE.
 *
 * `fetch` in React Native has no timeout of its own — `ws.ts` measured that
 * on the device and gave the ticket mint a watchdog; every other request in
 * the app was unbounded. The costs were concrete: a first message to a new
 * contact blocked in the prekey fetch forever on a stalled link (the
 * composer saw neither success nor error), and two hung blob downloads held
 * both `MAX_CONCURRENT_DOWNLOADS` slots for the rest of the session, every
 * later photo and avatar stuck 'pending' behind them.
 *
 * REST calls get a fixed deadline: a healthy round trip is tens to a few
 * thousand milliseconds, so twenty seconds aborts nothing that was going to
 * succeed and bounds the one failure mode with no other exit. Blob
 * transfers get a size-scaled one — base plus a per-MiB allowance — because
 * a 10 MiB photo over a bad cell link legitimately takes longer than any
 * fixed REST budget. */
export const REQUEST_TIMEOUT_MS = 20_000;
const BLOB_TIMEOUT_BASE_MS = 30_000;
const BLOB_TIMEOUT_PER_MIB_MS = 10_000;
/** The base64 text of a maximum-size blob: what `downloadBlob` budgets for
 * when the caller cannot say how big the object is (a pointer carries no
 * size — messaging.ts, `noteAutoFetched`). */
const MAX_BLOB_B64_LENGTH = Math.ceil((MAX_ATTACHMENT_BYTES * 4) / 3);

/** Deadline for one blob transfer of `bytes` (base64 characters count as
 * bytes: they are what actually crosses the network). */
export function blobTimeoutMs(bytes: number): number {
  const mib = Math.ceil(Math.max(0, bytes) / (1024 * 1024));
  return BLOB_TIMEOUT_BASE_MS + BLOB_TIMEOUT_PER_MIB_MS * mib;
}

/**
 * A request that reached its deadline. Its own class rather than RN's
 * `TypeError('Network request failed')` so a caller CAN tell "no answer in
 * time" from "no network at all" — and deliberately not an `ApiRequestError`,
 * which carries an HTTP status this never had (`apiProbeSession` turns those
 * into a verdict about the credential; a timeout is no verdict).
 */
export class ApiTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`request timed out after ${timeoutMs} ms`);
    this.name = 'ApiTimeoutError';
  }
}

/**
 * Run `work` with an AbortSignal that fires at the deadline; the timer is
 * cleared the moment the work settles, so a request that answers leaves no
 * handle behind. Abort surfaces as `ApiTimeoutError` whatever the platform's
 * own abort error looks like (RN throws a DOMException-shaped `AbortError`;
 * the whatwg polyfill under jest throws a plain Error).
 */
async function withDeadline<T>(
  timeoutMs: number,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // A deadline must never be what keeps a process alive: on Node (jest)
  // `setTimeout` returns a handle that holds the event loop open, and a
  // request some test abandoned mid-flight would then hold the whole run
  // open for the length of its deadline (the "Jest did not exit" tail).
  // React Native's timers are plain numbers — no `unref` — so this is a
  // no-op on the device, where the deadline fires exactly as before.
  (timer as unknown as { unref?: () => void }).unref?.();
  try {
    return await work(controller.signal);
  } catch (err) {
    if (controller.signal.aborted) throw new ApiTimeoutError(timeoutMs);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * THE SERVER IS AHEAD OF THIS BUILD.
 *
 * The app `.parse()`s every response DTO strictly and ships with no OTA
 * path, so the day a server removes, renames or retypes a field a shipped
 * client requires, every one of those clients fails — and used to fail
 * OPAQUELY: a zod error from `apiGetPrekeyBundle` read as "could not send",
 * one from `apiWsTicket` as a failed dial, retried on the backoff schedule
 * forever. Neither is a network problem and neither heals by retrying; the
 * only fix is an update. So a DTO that no longer parses is its own error,
 * named so every catch on the send path and the socket can tell it apart,
 * carrying WHICH shape failed and the field paths — never the values: an
 * error string is logged, rendered and sometimes copied, and a bundle
 * carries key material.
 *
 * Only the RESPONSE parse is wrapped. A malformed error body, a 5xx, a
 * timeout and no network keep their own shapes; "update Tacendum" is the
 * wrong advice for all of them. */
export class ServerAheadError extends Error {
  constructor(
    /** The DTO that failed to parse, by its schema name. */
    readonly dto: string,
    /** The field paths zod refused, e.g. `['expiresAt']`. */
    readonly fields: string[],
  ) {
    super(
      `update Tacendum: the server answered ${dto} in a shape this version cannot read` +
        (fields.length > 0 ? ` (${fields.join(', ')})` : ''),
    );
    this.name = 'ServerAheadError';
  }
}

/** Structural, not instanceof: zod's error class may be a different copy
 * from the one @tacendum/shared built the schema with. */
function isZodError(err: unknown): err is { issues: Array<{ path: PropertyKey[] }> } {
  return (
    err instanceof Error &&
    err.name === 'ZodError' &&
    Array.isArray((err as { issues?: unknown }).issues)
  );
}

/** Parse a response body against its DTO; a refusal is a ServerAheadError. */
function parseDto<T>(
  schema: { parse(input: unknown): T },
  dto: string,
  body: unknown,
): T {
  try {
    return schema.parse(body);
  } catch (err) {
    if (isZodError(err)) {
      const fields = [
        ...new Set(err.issues.map(i => i.path.map(String).join('.')).filter(Boolean)),
      ];
      throw new ServerAheadError(dto, fields);
    }
    throw err;
  }
}

export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    /** The server's `Retry-After` in whole seconds, when a 429 carried one
     * (the gate pass, 2026-10-08): the per-device burst window answers
     * with seconds, the per-account DAILY allowance with hours — the two
     * the request step must tell apart to say the right sentence. Null
     * when absent or unreadable. Self-keyed answers only: no address-shaped
     * refusal ever carries it. */
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

const apiAuthRenewedListeners = new Set<() => void>();

/** Subscribe to successful REST-side bearer renewal without coupling reauth to callers. */
export function onApiAuthRenewed(listener: () => void): () => void {
  apiAuthRenewedListeners.add(listener);
  let subscribed = true;
  return () => {
    if (!subscribed) return;
    subscribed = false;
    apiAuthRenewedListeners.delete(listener);
  };
}

function notifyApiAuthRenewed(listeners: readonly (() => void)[]): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch (error) {
      console.warn(`[api] auth renewal listener failed: ${error instanceof Error ? error.name : 'unknown'}`);
    }
  }
}

async function request(
  method: string,
  path: string,
  opts: { body?: unknown; token?: string; allowStatus?: number[] } = {},
): Promise<Response> {
  // The bearer this attempt presents. Starts as the caller's token and is
  // replaced — once — by a freshly minted one.
  let bearer = opts.token;
  // This request belongs to the workspace that initiated it, not whichever
  // one is active after its fetch/reauth awaits. The callback itself is also
  // generation-captured by call wiring; snapshotting here keeps an old REST
  // completion from reaching a newly armed replacement callback at all.
  const authRenewedSnapshot = [...apiAuthRenewedListeners];
  const accountGeneration = accountRequestGeneration();
  const assertAccountCurrent = () => {
    // Deletion must still reach its own route. Every other authenticated
    // request belongs to the identity that began it, including a delayed
    // 200 or a 401 arriving after a NEW identity has already registered.
    if (session.mode === 'duress' || (opts.token !== undefined && (
      accountGeneration !== accountRequestGeneration() ||
      (accountRequestsSuspended() && path !== '/v1/account')
    ))) throw new TypeError('Network request failed');
  };
  // ONE retry, never a loop. A second 401 on a token minted seconds ago is a
  // server-side truth (revoked, deleted, clock skew), not a token problem, and
  // looping on it turns a dead session into a self-inflicted DoS on our own
  // auth route. Everything above this function — messaging, screens — stays
  // unchanged and inherits the renewal without knowing the word.
  for (let attempt = 0; ; attempt++) {
    assertAccountCurrent();
    // The duress rule, at the transport boundary: "Duress sessions are
    // network-silent. No socket, no REST call, no push registration."
    //
    // Every caller has its own guard, and every one of them is a guard someone
    // has to remember. Two did not: `uploadPushTokens` and the TURN fetch are
    // mounted for the app's whole lifetime and reach this function without ever
    // consulting `session.mode`, so a coerced phone emitted `PUT /v1/push-token`
    // on startup and on every APNs rotation. This is the one place all ten
    // callers pass through, so it is the only place the rule can be enforced
    // rather than repeated.
    //
    // Inside the loop, not above it: the mode can change during the await, and
    // a retry after a relock must be refused as surely as the first attempt.
    //
    // The error shape is load-bearing. A `TypeError('Network request failed')`
    // is exactly what RN's fetch throws with no network, so nothing downstream
    // can tell a guarded session from a genuinely offline one — which is the
    // whole cover story. It must NOT be an `ApiRequestError`: `apiProbeSession`
    // below converts one of those into a status, and the socket would then read
    // a coerced session as proof of a LIVE credential.
    if (session.mode === 'duress') {
      throw new TypeError('Network request failed');
    }

    const res = await withDeadline(REQUEST_TIMEOUT_MS, signal =>
      fetch(`${API_BASE}${path}`, {
        method,
        headers: {
          ...(opts.body !== undefined
            ? { 'content-type': 'application/json' }
            : {}),
          ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        },
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
        signal,
      }),
    );
    assertAccountCurrent();

    if (
      res.status === 401 &&
      // Only authenticated routes. `POST /v1/auth` and `/v1/auth/challenge`
      // carry no token, so re-auth can never recurse into itself through here.
      opts.token !== undefined &&
      attempt === 0 &&
      // A caller that explicitly asked to SEE a 401 is diagnosing the
      // credential (the WS probe does exactly that); healing it underneath
      // them would hand back a 200 while the socket still holds the dead token.
      !opts.allowStatus?.includes(401)
    ) {
      // The bearer that ACTUALLY FAILED, not "the current token" — the whole
      // stale-bearer check turns on that distinction (reauth.ts).
      const outcome = await reauthenticate(bearer ?? null);
      assertAccountCurrent();
      if (outcome === 'ok') {
        const fresh = await currentToken();
        if (fresh) {
          bearer = fresh;
          notifyApiAuthRenewed(authRenewedSnapshot);
          continue;
        }
      }
      // 'gone', 'silent', 'error', or a Keychain that came back empty: fall
      // through and surface the 401 as it is. A duress session in particular
      // must not be told anything different from "this did not work".
    }

    if (!res.ok && !opts.allowStatus?.includes(res.status)) {
      let detail = `${res.status}`;
      let code: string | undefined;
      try {
        const parsed = ApiError.safeParse(await res.json());
        if (parsed.success) {
          code = parsed.data.error.code;
          detail = `${parsed.data.error.detail}`;
        }
      } catch {
        // non-JSON error body; status alone will do
      }
      const retryRaw =
        typeof res.headers?.get === 'function' ? res.headers.get('retry-after') : null;
      const retry = retryRaw === null ? Number.NaN : Number(retryRaw);
      throw new ApiRequestError(
        detail,
        res.status,
        code,
        Number.isFinite(retry) && retry >= 0 ? retry : null,
      );
    }
    // Fetch can resolve at headers while its JSON body is still arriving.
    // Keep the same account fence through the reader every DTO wrapper uses.
    const readJson = res.json.bind(res);
    res.json = async () => {
      const body: unknown = await readJson();
      assertAccountCurrent();
      return body;
    };
    return res;
  }
}

/**
 * The WebSocket's disambiguation probe.
 *
 * Returns the raw status instead of throwing, because "401" is the ANSWER here
 * rather than a failure: the caller is asking whether this bearer is still
 * alive, and `allowStatus` keeps `request`'s own 401 healing out of the way so
 * the answer is about the token the socket is actually holding.
 *
 * `GET /v1/me` is the cheapest authenticated route there is — it exists to
 * exercise the bearer middleware end to end and returns the auth context — and
 * it is deployed on both hosts (local router and the AWS HTTP function).
 */
/**
 * Mint a single-use ticket for one WebSocket dial.
 *
 * The bearer travels in the Authorization header here, where headers are
 * private, and only the ticket goes in the socket URL — because a URL is
 * written into proxy logs, access logs and crash reporters, and the bearer is
 * good for thirty days on every route.
 */
export async function apiWsTicket(token: string): Promise<string> {
  const res = await request('POST', '/v1/ws-ticket', { token });
  return parseDto(WsTicketResponse, 'WsTicketResponse', await res.json()).ticket;
}

export async function apiProbeSession(token: string): Promise<number> {
  try {
    const res = await request('GET', '/v1/me', { token, allowStatus: [401] });
    return res.status;
  } catch (err) {
    // ANY http answer is an answer. A 403 from a WAF, a 429 from our own rate
    // limiter, a 502 from a cold gateway — none of them say this bearer is
    // dead, but all of them prove the server was reached, and that is the
    // question the caller is asking. Letting them throw would classify a
    // rate-limiting server as "unreachable", which refunds the socket's probe
    // and turns a bad minute into a probe-per-retry hammer against the route
    // that is already struggling. Only a transport failure — no response at
    // all — is genuinely unanswered, and that one still propagates.
    if (err instanceof ApiRequestError) return err.status;
    throw err;
  }
}

export async function apiPostCallMetric(
  token: string,
  body: CallMetricReport,
): Promise<{ status: number; retryAfterSeconds: number | null }> {
  try {
    const response = await request('POST', '/v1/call-metrics', {
      token,
      body,
      // A 401 is deliberately absent: request() gets one bounded renewal.
      allowStatus: [400, 403, 404, 408, 409, 422, 429, 500, 502, 503, 504],
    });
    const raw = response.headers.get('retry-after');
    const retry = raw === null ? Number.NaN : Number(raw);
    return {
      status: response.status,
      retryAfterSeconds: Number.isFinite(retry) && retry >= 0 ? retry : null,
    };
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 401) {
      return { status: 401, retryAfterSeconds: null };
    }
    throw error;
  }
}

/*
 * `apiRegister`, `apiVerify` and `RegistrationLockedError` are gone with the
 * phone number: `/v1/register` and `/v1/verify` are
 * deleted in K6, and a shipped build must not still be calling them. The same
 * goes for the two registration-lock routes that lived just below — the
 * Account PIN section they drove is off the Settings screen. `registrationLock.ts`
 * keeps its PIN *derivation* helpers, which are reserved for encrypted
 * backups (a reserved future feature) and touch the network not at all.
 */

/**
 * Keypair-only account auth: ask for a nonce, then
 * present it signed. Two calls rather than one because the nonce has to come
 * from the server for a signature over it to prove anything.
 */
export async function apiAuthChallenge(identityKey: string): Promise<AuthChallengeResponse> {
  const res = await request('POST', '/v1/auth/challenge', { body: { identityKey } });
  return parseDto(AuthChallengeResponse, 'AuthChallengeResponse', await res.json());
}

export async function apiAuth(
  identityKey: string,
  challenge: string,
  signature: string,
  expectedUserId?: string,
): Promise<AuthResponse> {
  const res = await request('POST', '/v1/auth', {
    body: { identityKey, challenge, signature, ...(expectedUserId ? { expectedUserId } : {}) },
  });
  return parseDto(AuthResponse, 'AuthResponse', await res.json());
}

export async function apiUploadKeys(
  token: string,
  keys: UploadKeysRequest,
): Promise<void> {
  await request('PUT', '/v1/keys', { body: keys, token });
}

/**
 * Mint short-lived relay credentials.
 *
 * They expire, so this is not one-time setup — CallController refreshes at 80%
 * of the TTL. A 503 `turn_unavailable` is a normal answer, not an error: it
 * means no relay is configured, and a call can still be placed directly. The
 * caller must be able to tell those apart, which is why the error is not
 * swallowed here.
 */
export async function apiTurnCredentials(
  token: string,
): Promise<TurnCredentialsResponse> {
  // `.json()` on the answer — this used to hand the Response OBJECT to the
  // schema, which can never parse (found while wrapping the DTO parses;
  // the callers mock this function whole, so no test had ever reached the
  // line).
  const res = await request('POST', '/v1/turn-credentials', { body: {}, token });
  return parseDto(TurnCredentialsResponse, 'TurnCredentialsResponse', await res.json());
}

/**
 * What build the server will still talk to.
 *
 * TOKEN-FREE, and that is the whole design of the route: the answer is the
 * same bytes for everyone on a platform, the request carries no identifier,
 * and a phone that cannot sign in — a fresh install standing on the landing
 * screen — is exactly the phone most likely to be too old. Passing no token
 * also means `request` never enters its 401 renewal arm for this call.
 *
 * The duress guard inside `request` covers it for free, and the gate reads
 * the resulting offline-shaped `TypeError` as "unknown" rather than as an
 * answer (updateGate.ts) — a coerced phone must look like an ordinary
 * offline one.
 *
 * WHY THE REASON CHANGES THE URL. The route answers with `Cache-Control:
 * max-age=300`, which is right for the two checks nobody is standing in
 * front of and wrong for the two they are. Someone who taps "Check again" on
 * the wall, or "Get started" on the landing screen, is asking BECAUSE the
 * last answer refused them; being handed that same refusal back out of a
 * cache for five minutes makes the wall's only control look dead, and can
 * hold a phone behind a floor the operator has already lowered. Those two
 * reasons therefore ask on a URL no cache has seen — `?r=<reason>&t=<ms>` —
 * and the boot and foreground checks keep the cacheable one, because they
 * are exactly the traffic the header exists to absorb.
 *
 * Inert on the far side: API Gateway route keys match method and path only,
 * the local host routes on `new URL(...).pathname`, and the handler never
 * reads the path at all (packages/server/test/client-policy.test.ts pins
 * that a query-bearing path answers the same status, headers and bytes, and
 * spends the same per-IP bucket).
 */
export async function apiClientPolicy(
  reason?: CheckReason,
): Promise<ClientPolicyResponse> {
  const res = await request('GET', clientPolicyPath(reason));
  return parseDto(ClientPolicyResponse, 'ClientPolicyResponse', await res.json());
}

/** The two reasons a person is waiting on the answer, and so the two that
 * must not be served from a cache. Everything else keeps the cacheable URL. */
const UNCACHED_REASONS: ReadonlySet<CheckReason> = new Set<CheckReason>([
  'getStarted',
  'recheck',
]);

function clientPolicyPath(reason: CheckReason | undefined): string {
  if (!reason || !UNCACHED_REASONS.has(reason)) return '/v1/client-policy';
  // `r` is for us reading a log or a proxy trace; `t` is what actually makes
  // the key unique. Both are constants of our own making — no identifier, no
  // counter, nothing derived from the device.
  return `/v1/client-policy?r=${reason}&t=${Date.now()}`;
}

/**
 * Register this device's VoIP token (§9.2).
 *
 * Without this the server has no way to wake the device, so a call to a
 * backgrounded, locked, or terminated phone never rings — the PushKit
 * registry produces a token and nothing ever tells the server about it.
 *
 * `env` must match the APNs host the token belongs to. Since Apple's
 * 2025-02-16 change a key carries an explicit environment, and a mismatch
 * sends every push to the wrong host where it fails silently: the call simply
 * does not ring and nothing reports an error.
 */
export async function apiRegisterPushToken(
  token: string,
  bundleId: string,
  voipToken?: string,
  env: 'sandbox' | 'production' = 'production',
  alertToken?: string,
): Promise<void> {
  await request('PUT', '/v1/push-token', {
    // BOTH omitted rather than sent empty when absent: '' fails the hex
    // pattern and would reject the whole registration, taking the token this
    // device DOES have down with the one it does not. The server requires at
    // least one, so a call with neither fails loudly here rather than writing
    // a row that can never be pushed to.
    //
    // `bundleId` IS REQUIRED BY THE SCHEMA and was never sent. Every
    // registration this app has ever made was rejected 400 by `parseJson`
    // before it reached the handler, and the client swallows the failure by
    // design — which is why the token table was empty and why nothing,
    // anywhere, reported a problem. It is second in the parameter list rather
    // than last precisely so it cannot be forgotten again: omitting it is now
    // a type error rather than a runtime 400 nobody sees.
    body: {
      ...(voipToken ? { voipToken } : {}),
      env,
      ...(alertToken ? { alertToken } : {}),
      bundleId,
    },
    token,
  });
}

/**
 * The ANDROID registration — `PUT /v1/push-token`, the FCM branch of the same
 * route.
 *
 * A separate function rather than more optional parameters on
 * `apiRegisterPushToken`, because the wire shapes genuinely differ and the
 * server validates them as a DISCRIMINATED UNION: this body carries
 * `platform: 'android'` (required — it is what keeps the branch unreachable
 * by every shipped iOS client), ONE `fcmToken` (firebase issues one
 * token per app instance and it serves both the call-wake and message-wake
 * lanes), and NO `env` — FCM has no sandbox/production host split, and
 * inventing a value would store a lie the sender then appears to route on.
 *
 * INTEGRATION POINT: this literal mirrors `FcmPushRegistration` in
 * packages/shared/src/dto.ts as landed by the server-side FCM track
 * (the server-side FCM commit) — verified against
 * that commit, and pinned by push.registration.test.ts the same way the iOS
 * body is: change either side and the test names the drift. Registration is
 * whole-row replace on the server, so a device that switches platforms
 * replaces its row entirely in either direction.
 */
export async function apiRegisterFcmToken(
  token: string,
  bundleId: string,
  fcmToken: string,
): Promise<void> {
  await request('PUT', '/v1/push-token', {
    body: {
      platform: 'android',
      fcmToken,
      bundleId,
    },
    token,
  });
}

/**
 * Adopt a paired machine into this account's crew — `POST /v1/crew/adopt`.
 *
 * OWNER-called, and this app is the owner: adoption is an admission decision,
 * and the server refuses it from any integration however prompted (an
 * injectable node can never be an admission authority — handlers/crew.ts).
 * 204 covers adopted AND already-adopted, indistinguishably; the collapsed
 * `not_integration_owner` refusal covers not-a-machine, someone-else's, and
 * someone-else's-crew, also indistinguishably — the route refuses to be an
 * ownership oracle and the screen must not pretend otherwise.
 */
export async function apiCrewAdopt(token: string, member: string): Promise<void> {
  await request('POST', '/v1/crew/adopt', { body: { member }, token });
}

/**
 * Write the directed consent edge (caller → agent) — `POST /v1/consent`. The human's own act of choosing to
 * share with one agent; the server's send/inbox/typing predicates enforce it.
 *
 * THE 204 IS UNIFORM and this client must claim no more than it says:
 * the same 204 answers a stored edge, an already-stored one, an id that names
 * nothing, a non-integration id, and an over-cap write that was SILENTLY
 * DROPPED. Success and over-cap are indistinguishable on the wire — by rule
 * — so the caller records its own decision locally (the only place it knows
 * it tried) and NEVER treats the 204 as proof the agent can now hear it. The
 * app must never probe the route to learn otherwise: there is no read route,
 * deliberately.
 */
export async function apiConsentWrite(token: string, agent: string): Promise<void> {
  await request('POST', '/v1/consent', { body: { agent }, token });
}

/**
 * Delete the edge — `DELETE /v1/consent/{agentId}`. Revocation IS deletion:
 * the agent's next frame to this human, and this human's next to it, are
 * refused. The same uniform 204 whether or not an edge existed,
 * so "refusing writes nothing" is honest — the app records 'refused' locally
 * and asks the server nothing.
 */
export async function apiConsentDelete(token: string, agent: string): Promise<void> {
  await request('DELETE', `/v1/consent/${encodeURIComponent(agent)}`, { token });
}

/**
 * Revoke a machine this account paired — `DELETE /v1/integrations/{userId}`.
 * Retires the machine's key permanently (its identity can never sign in
 * again); the same collapsed 403 as adoption for anything that is not a
 * machine this account owns.
 */
export async function apiIntegrationRevoke(token: string, userId: string): Promise<void> {
  await request('DELETE', `/v1/integrations/${userId}`, { token });
}

/** Retire the account: user row, identity-key claim, prekeys, queued
 * ciphertext and the calling token all go. The caller wipes local state only
 * AFTER this resolves — the app's "your ID stops working" promise depends on
 * the order. */
export async function apiDeleteAccount(token: string): Promise<void> {
  await request('DELETE', '/v1/account', { token });
}

/**
 * Withdraw this device's push tokens.
 *
 * The counterpart to `apiRegisterPushToken`, and the reason it exists is a
 * consent gap rather than a feature request: iOS issues a PushKit token
 * without asking, independently of the notification prompt, so a VoIP token
 * was uploaded even by someone who declined notifications — and until this
 * call there was no way for them to take it back short of deleting the
 * account. App Store 5.1.1(ii) asks for an understandable way to withdraw
 * from collection, and this is it.
 *
 * Deleting the row costs calls their early ring; the Settings copy says so
 * before the switch is thrown.
 */
export async function apiDeletePushToken(token: string): Promise<void> {
  await request('DELETE', '/v1/push-token', { token });
}

/**
 * File an abuse report.
 *
 * The only call in this client that can carry plaintext, and it does so only
 * when the caller passes `excerpts` — which happens only when a person tapped
 * specific messages and confirmed. Every other path here sends ciphertext or
 * identifiers, and that asymmetry is the reason this function is written out
 * separately rather than folded into a generic poster: it should be greppable.
 */
export async function apiCreateReport(
  token: string,
  body: CreateReportRequest,
): Promise<CreateReportResponse> {
  const res = await request('POST', '/v1/reports', { token, body });
  return parseDto(CreateReportResponse, 'CreateReportResponse', await res.json());
}

/*
 * Device linking. Five routes, one refusal
 * shape: every refused case — dark flag, forged signature, consumed offer,
 * occupied slot, stale epoch, membership probe — answers the ONE collapsed
 * 403 `accounts_refused` byte-stream, deliberately. These
 * clients therefore learn nothing from a refusal beyond "not available",
 * and the screens must not pretend otherwise.
 */

/** The INIT leg: the server mints/returns the tuple A must
 * sign, recorded in a TTL'd init row keyed to A. Authenticated, unsigned —
 * nothing is committed by this call. */
export async function apiLinkOfferInit(
  token: string,
  body: LinkOfferInitRequest,
): Promise<LinkOfferInitResponse> {
  const res = await request('POST', '/v1/devices/link-offer', { body, token });
  return parseDto(LinkOfferInitResponse, 'LinkOfferInitResponse', await res.json());
}

/** The SUBMIT leg: only the nonce and A's op="offer" identity
 * signature — the server rebuilds the preimage from its OWN init row, so
 * there is nothing else to lie about. */
export async function apiLinkOfferSubmit(
  token: string,
  offerNonce: string,
  signature: string,
): Promise<void> {
  await request('POST', '/v1/devices/link-offer/submit', {
    body: { offerNonce, signature },
    token,
  });
}

/** The acceptance: B's op="accept" signature over the same
 * tuple; the link TransactWrite's conditions are the authorization. */
export async function apiLinkAccept(
  token: string,
  offerNonce: string,
  signature: string,
): Promise<void> {
  await request('POST', '/v1/devices/link-accept', {
    body: { offerNonce, signature },
    token,
  });
}

/** A roster mutation — op 'unlink' (amicable) or 'revoke'
 * (lost/stolen: tombstones the target's identity key). The body carries the
 * ACTING member's fresh identity signature over the op-framed preimage; a
 * bearer session alone never mutates a roster. */
export async function apiDeviceRosterMutation(
  token: string,
  op: 'unlink' | 'revoke',
  body: DeviceRosterMutationRequest,
): Promise<void> {
  await request('POST', op === 'unlink' ? '/v1/devices/unlink' : '/v1/devices/revoke', {
    body,
    token,
  });
}

/** The forwarding hint, carried on the refusal: a REVOKED target's 404 names the SURVIVING roster, so the caller can
 * re-target instead of reducing the answer to a dead end. */
export class RecipientRevokedError extends ApiRequestError {
  constructor(
    detail: string,
    readonly hint: RevokedKeysHint | null,
  ) {
    super(detail, 404, 'recipient_revoked');
    this.name = 'RecipientRevokedError';
  }
}

/*
 * Identifier attach + discovery + recovery, token-path. The refusal shapes are the wire's, not
 * this client's to soften: every refused case answers the ONE collapsed 403
 * `accounts_refused` byte-stream (dark flag, wrong code, spent budget,
 * unresolvable address alike), the code-send routes answer a UNIFORM 200
 * whether or not anything was sent, the consent toggle answers a UNIFORM
 * 204 whether or not a claim exists, and the discovery lookup answers the
 * SAME collapsed refusal for a miss, a non-consented hit, a cool-down, and
 * an exhausted budget — BY DESIGN. These clients therefore learn nothing
 * from a refusal beyond "not available", and the screens must say so
 * instead of pretending otherwise.
 */

/** POST /v1/identifiers/email/request-code — ask for an attach code. The
 * 200 is uniform: it proves the ask was accepted, never that mail moved. */
export async function apiEmailRequestCode(
  token: string,
  email: string,
  deviceClass: DeviceClass,
): Promise<void> {
  await request('POST', '/v1/identifiers/email/request-code', {
    body: { email, class: deviceClass },
    token,
  });
}

/** POST /v1/identifiers/email/verify — the attach itself. Every attempt,
 * right or wrong, spends one of the code row's capped attempts. */
export async function apiEmailVerify(
  token: string,
  email: string,
  code: string,
): Promise<void> {
  await request('POST', '/v1/identifiers/email/verify', {
    body: { email, code },
    token,
  });
}

/** POST /v1/identifiers/email/unlink — delete the claim + its consent. */
export async function apiEmailUnlink(token: string): Promise<void> {
  await request('POST', '/v1/identifiers/email/unlink', { body: {}, token });
}

/*
 * The PHONE twins (called by the dark phone
 * surfaces): same refusal collapses, same uniform answers. The ROUTE is
 * the identifier class on the attach family; the recovery and lookup legs
 * carry PARALLEL fields ({phone} beside the optional {email}, exactly one
 * populated — never a discriminant field; `class` keeps its landed
 * device-slot meaning). The number on these wires is always the NORMALIZED
 * E.164 spelling: refused, never repaired, and this client never
 * guesses a country.
 */

/** POST /v1/identifiers/phone/request-code — ask for an attach code by
 * text message. The 200 is uniform: it proves the ask was accepted, never
 * that a message moved (and the vendor's synchronous answer is the only
 * delivery outcome the system consumes). */
export async function apiRequestPhoneCode(
  token: string,
  phone: string,
  deviceClass: DeviceClass,
): Promise<void> {
  await request('POST', '/v1/identifiers/phone/request-code', {
    body: { phone, class: deviceClass },
    token,
  });
}

/** POST /v1/identifiers/phone/verify — the phone attach itself. */
export async function apiVerifyPhone(
  token: string,
  phone: string,
  code: string,
): Promise<void> {
  await request('POST', '/v1/identifiers/phone/verify', {
    body: { phone, code },
    token,
  });
}

/** POST /v1/identifiers/phone/unlink — delete the phone claim + its
 * consent; the email class survives by construction (per-class unlink). */
export async function apiUnlinkPhone(token: string): Promise<void> {
  await request('POST', '/v1/identifiers/phone/unlink', { body: {}, token });
}

/** POST /v1/identifiers/phone/discoverable — the PHONE class's own the design
 * consent toggle (never implied by the email one). Uniform 204. */
export async function apiSetPhoneDiscoverable(
  token: string,
  discoverable: boolean,
): Promise<void> {
  await request('POST', '/v1/identifiers/phone/discoverable', {
    body: { discoverable },
    token,
  });
}

/** POST /v1/discovery/lookup with the {phone} field — the same route, the
 * same collapsed refusal for every refused case. */
export async function apiDiscoveryLookupPhone(
  token: string,
  phone: string,
): Promise<DiscoveryLookupResponse> {
  const res = await request('POST', '/v1/discovery/lookup', {
    body: { phone },
    token,
  });
  return parseDto(DiscoveryLookupResponse, 'DiscoveryLookupResponse', await res.json());
}

/*
 * The USERNAME class (called
 * by the dark accountsUsername.ts module only; every surface behind
 * USERNAME_UI_ENABLED). The ROUTE is the class on the lifecycle family;
 * the lookup leg carries the third PARALLEL field ({username} beside
 * {email}/{phone}, exactly one populated — never a discriminant). The name
 * on these wires is the NORMALIZED handle (trim + case-fold), which the
 * server re-normalizes and refuses outside USERNAME_STRICT (refused,
 * never repaired). The claim verb's answers are the ONE place this client
 * reads a status: the frozen 409 `taken` (USERNAME_TAKEN_STATUS) surfaces as
 * an ApiRequestError with that status; every other refusal — including the
 * fleet ceiling — is the frozen 403, and the module maps it to a generic
 * retry, distinguishable from `taken` by status alone.
 */

/** POST /v1/identifiers/username/claim — the claim, with the consent
 * bit EXPLICIT on the wire (the row's structural default stays OFF). */
export async function apiClaimUsername(
  token: string,
  username: string,
  discoverable: boolean,
): Promise<void> {
  await request('POST', '/v1/identifiers/username/claim', {
    body: { username, discoverable },
    token,
  });
}

/** POST /v1/identifiers/username/rename — the SAME server verb spelled for
 * the client's intent (the group's state decides; the route carries
 * no discriminant). Same body, same answers. */
export async function apiRenameUsername(
  token: string,
  username: string,
  discoverable: boolean,
): Promise<void> {
  await request('POST', '/v1/identifiers/username/rename', {
    body: { username, discoverable },
    token,
  });
}

/** POST /v1/identifiers/username/unlink — tombstone the name (the former
 * owner's 30-day reclaim right); email/phone survive by construction.
 * The pinned empty body (UsernameUnlinkRequest). */
export async function apiUnlinkUsername(token: string): Promise<void> {
  await request('POST', '/v1/identifiers/username/unlink', { body: {}, token });
}

/** POST /v1/identifiers/username/discoverable — the USERNAME class's own
 * consent toggle (never implied by the email or phone one). */
export async function apiSetUsernameDiscoverable(
  token: string,
  discoverable: boolean,
): Promise<void> {
  await request('POST', '/v1/identifiers/username/discoverable', {
    body: { discoverable },
    token,
  });
}

/** GET /v1/identifiers/username/eligibility — caller-owned possession-
 * proof readiness for claim and username lookup. The response deliberately
 * carries one boolean and no identifier, target, age, or refusal reason. */
export async function apiUsernameEligibility(token: string): Promise<UsernameEligibilityResponse> {
  const res = await request('GET', '/v1/identifiers/username/eligibility', { token });
  return parseDto(
    UsernameEligibilityResponse,
    'UsernameEligibilityResponse',
    await res.json(),
  );
}

/** What one `GET /v1/identifiers/state` attempt resolved to. The ONE DTO
 * wrapper that reports its own outcome instead of throwing, because the
 * route's ABSENCE is a legitimate answer this build must handle: today's
 * production server (fef7a0dc) has no such route, API Gateway answers the
 * routeKey miss with a 404, and the caller then falls back to the
 * eligibility read. 'refused' is every other http-level answer (the frozen
 * 403 above all — never a connection problem); 'failed' is a transport
 * failure (no network, the deadline, the duress chokepoint). A 200 whose
 * body fails the strict parse still throws ServerAheadError, like every
 * other DTO wrapper. */
export type IdentifierStateRead =
  | { kind: 'state'; value: IdentifierStateResponse }
  | { kind: 'absent' }
  | { kind: 'refused' }
  | { kind: 'failed' };

/** GET /v1/identifiers/state — the caller's OWN account-group facts
 * (fix/username-discovery, 2026-10-08): the possession proof, the email and
 * phone classes linked, a username held, the §4.8 cool-down's end. No name,
 * no identifier, no target, no reason — nothing about another party.
 * Authenticated exactly like the eligibility read, no body. The eligibility
 * read stays byte-identical (builds 31-33 parse it .strict() with no OTA),
 * which is why this is a NEW route rather than a wider one. */
export async function apiIdentifierState(token: string): Promise<IdentifierStateRead> {
  let res: Response;
  try {
    res = await request('GET', '/v1/identifiers/state', { token, allowStatus: [404] });
  } catch (error) {
    return error instanceof ApiRequestError ? { kind: 'refused' } : { kind: 'failed' };
  }
  if (res.status === 404) return { kind: 'absent' };
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    // The account fence (a delayed body reaching a new identity) or a body
    // that is not JSON at all: nothing readable arrived.
    return { kind: 'failed' };
  }
  return {
    kind: 'state',
    value: parseDto(IdentifierStateResponse, 'IdentifierStateResponse', body),
  };
}

/** POST /v1/discovery/lookup with the {username} field — the same route,
 * the same collapsed refusal for every refused case, the response bytes
 * unchanged (no echo, no new field). */
export async function apiDiscoveryLookupUsername(
  token: string,
  username: string,
): Promise<DiscoveryLookupResponse> {
  const res = await request('POST', '/v1/discovery/lookup', {
    body: { username },
    token,
  });
  return parseDto(DiscoveryLookupResponse, 'DiscoveryLookupResponse', await res.json());
}

/** POST /v1/recovery/request-code with the {phone} field. Uniform 200 —
 * only the receiving number knows. */
export async function apiRecoveryRequestCodePhone(
  token: string,
  phone: string,
): Promise<void> {
  await request('POST', '/v1/recovery/request-code', { body: { phone }, token });
}

/** POST /v1/recovery/verify with the {phone} field — the pending row is
 * born recording its identifier class server-side (claim-prefix-derived,
 * never client-asserted). */
export async function apiRecoveryVerifyPhone(
  token: string,
  phone: string,
  code: string,
  deviceClass: DeviceClass,
): Promise<RecoveryVerifyResponse> {
  const res = await request('POST', '/v1/recovery/verify', {
    body: { phone, code, class: deviceClass },
    token,
  });
  return parseDto(RecoveryVerifyResponse, 'RecoveryVerifyResponse', await res.json());
}

/** POST /v1/identifiers/email/discoverable — the consent toggle. THE 204
 * IS UNIFORM (the consent-write shape): the same answer covers
 * a stored write and a claimless caller's silently-lossy one, so the caller
 * records its own decision locally and never treats the 204 as proof. */
export async function apiSetDiscoverable(
  token: string,
  discoverable: boolean,
): Promise<void> {
  await request('POST', '/v1/identifiers/email/discoverable', {
    body: { discoverable },
    token,
  });
}

/** POST /v1/discovery/lookup — the typed-SINGLE-identifier lookup.
 * ONE email the person typed, never a batch, never an address book.
 * A positive answer is the minimal disclosure; every refusal — miss,
 * not-discoverable, cool-down, budget — is the same collapsed 403. */
export async function apiDiscoveryLookup(
  token: string,
  email: string,
): Promise<DiscoveryLookupResponse> {
  const res = await request('POST', '/v1/discovery/lookup', {
    body: { email },
    token,
  });
  return parseDto(DiscoveryLookupResponse, 'DiscoveryLookupResponse', await res.json());
}

/** POST /v1/recovery/request-code — the recovering device asks for a code.
 * Uniform 200 whether or not the address resolves: only the inbox
 * knows. */
export async function apiRecoveryRequestCode(
  token: string,
  email: string,
): Promise<void> {
  await request('POST', '/v1/recovery/request-code', { body: { email }, token });
}

/** POST /v1/recovery/verify — code proven; the 72 h pending row is born and
 * every surviving member is notified with the cancel capability. */
export async function apiRecoveryVerify(
  token: string,
  email: string,
  code: string,
  deviceClass: DeviceClass,
): Promise<RecoveryVerifyResponse> {
  const res = await request('POST', '/v1/recovery/verify', {
    body: { email, code, class: deviceClass },
    token,
  });
  return parseDto(RecoveryVerifyResponse, 'RecoveryVerifyResponse', await res.json());
}

/** POST /v1/recovery/cancel — a surviving member kills the pending recovery.
 * Bearer-authorized deliberately: cancel is the refusal verb and must not
 * lose a race to a thief who has the phone but not the passcode. */
export async function apiRecoveryCancel(token: string): Promise<void> {
  await request('POST', '/v1/recovery/cancel', { body: {}, token });
}

/** POST /v1/recovery/complete — the one signed recovery leg: the caller
 * proves LIVE possession of its registered identity key over a fresh auth
 * challenge (the existing v2 preimage domain — no new crypto surface). */
export async function apiRecoveryComplete(
  token: string,
  groupId: string,
  challenge: string,
  signature: string,
): Promise<void> {
  await request('POST', '/v1/recovery/complete', {
    body: { groupId, challenge, signature },
    token,
  });
}

export async function apiGetPrekeyBundle(
  token: string,
  userId: string,
): Promise<PrekeyBundle> {
  const res = await request('GET', `/v1/keys/${encodeURIComponent(userId)}`, {
    token,
    allowStatus: [404],
  });
  if (res.status === 404) {
    // The forwarding hint rides the refusal body (RevokedKeysHint):
    // parse it rather than discarding the survivor roster. A
    // plain not_found — or a legacy hint-free 404 — surfaces exactly as
    // `request` would have thrown it.
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      // non-JSON error body; fall through to the plain refusal below
    }
    const hint = RevokedKeysHint.safeParse(body);
    if (hint.success) {
      throw new RecipientRevokedError(hint.data.error.detail, hint.data);
    }
    const parsed = ApiError.safeParse(body);
    throw new ApiRequestError(
      parsed.success ? parsed.data.error.detail : '404',
      404,
      parsed.success ? parsed.data.error.code : undefined,
    );
  }
  const bundle = parseDto(PrekeyBundle, 'PrekeyBundle', await res.json());
  // The bundle must name the account it was asked for: a bundle served for ULID_X carrying a different `userId`
  // would pin the served key under the WRONG address — the native store
  // pins by the bundle's own userId — while every caller signs or derives
  // against the served key. Fail closed for all callers, here.
  if (bundle.userId !== userId) {
    throw new ApiRequestError('prekey bundle names the wrong account', res.status, 'bundle_mismatch');
  }
  return bundle;
}

export async function apiCreateAttachment(
  token: string,
  contentLength: number,
): Promise<CreateAttachmentResponse> {
  const res = await request('POST', '/v1/attachments', {
    body: { contentLength },
    token,
  });
  return parseDto(CreateAttachmentResponse, 'CreateAttachmentResponse', await res.json());
}

export async function apiGetAttachmentUrl(
  token: string,
  attachmentId: string,
): Promise<GetAttachmentResponse> {
  const res = await request(
    'GET',
    `/v1/attachments/${encodeURIComponent(attachmentId)}`,
    {
      token,
    },
  );
  return parseDto(GetAttachmentResponse, 'GetAttachmentResponse', await res.json());
}

/**
 * Blob transfer against presigned URLs (NOT the API origin — no bearer token;
 * the URL itself is the credential). The body is the base64 TEXT of the
 * encrypted blob: RN's fetch can only carry strings losslessly, so the object
 * content is base64 ciphertext.
 */
export async function uploadBlob(url: string, bodyB64: string): Promise<void> {
  // Size-scaled (see REQUEST_TIMEOUT_MS): the body is in hand, so the
  // deadline is exact for what is being pushed.
  const res = await withDeadline(blobTimeoutMs(bodyB64.length), signal =>
    fetch(url, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: bodyB64,
      signal,
    }),
  );
  if (!res.ok)
    throw new ApiRequestError(`blob upload failed (${res.status})`, res.status);
}

/**
 * `expectedBytes` scales the deadline when the caller knows the object's
 * size; without it the budget is a maximum-size blob's, which is generous
 * but still finite — the point is that a stalled transfer ENDS. The body
 * read sits inside the deadline too: for a blob the bytes ARE the request,
 * and a stall after the headers is the common shape of a dying link.
 */
export async function downloadBlob(
  url: string,
  expectedBytes: number = MAX_BLOB_B64_LENGTH,
): Promise<string> {
  return withDeadline(blobTimeoutMs(expectedBytes), async signal => {
    const res = await fetch(url, { signal });
    if (!res.ok)
      throw new ApiRequestError(
        `blob download failed (${res.status})`,
        res.status,
      );
    return res.text();
  });
}
