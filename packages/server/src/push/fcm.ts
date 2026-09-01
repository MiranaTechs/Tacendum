import { createSign } from 'node:crypto';
import type { VoipPayload } from './apns.js';

/**
 * FCM push client — the Android analogue of apns.ts, and
 * deliberately shaped like it: one client, two send lanes (call wake vs
 * message wake), the same outcome vocabulary, the same never-log-the-payload
 * discipline.
 *
 * **Crypto-inventory note.** The RS256 service-account JWT minted here is
 * Google's authentication scheme for their own API, signed with a key Google
 * issued. Google exchanges it at the key file's `token_uri` for a short-lived
 * OAuth2 access token — one HTTPS hop Apple's flow does not have — and that
 * access token is what the FCM v1 send carries. It protects no user content;
 * it authenticates us to Google. The signing is Node's `createSign`, the
 * same API used for the APNs ES256 JWT, with RSA in place of EC.
 *
 * **What Google learns, stated plainly** (the mirror of the apns.ts
 * disclosure): a push was sent to this registration token at time T, whether
 * it is a call or a message (`kind`), and the opaque sender id in `fromUser`
 * the recipient-side pseudonymous contact graph, the same class of fact
 * disclosed for Apple in apns.ts. The ids are opaque ULIDs; nothing
 * legible ships. (`fromUser`, not `from`: `from` is one of FCM's RESERVED
 * data keys and Google refuses the send outright — 400 INVALID_ARGUMENT,
 * "Invalid data payload key: from", measured against the live API at
 * activation. The payload types keep their `from` field; only
 * the wire key differs, renamed at the one place the wire shape is built.)
 *
 * **What the payload deliberately does NOT carry: the ciphertext.** The APNs
 * alert arm ships the queued ciphertext so the notification service
 * extension can decrypt a preview; Android has no NSE — the woken app plays
 * that role in-process and drains the queue over its own socket. So the FCM message is data-only routing facts, which also keeps
 * every wake safely under FCM's 4 KB data-message cap regardless of message
 * size.
 */

export interface FcmCredentials {
  /** The Firebase project id — names the `/v1/projects/{id}/messages:send` path. */
  projectId: string;
  /** The service account's email; the JWT's `iss`. */
  clientEmail: string;
  /** The service-account RSA private key, PEM-encoded. */
  privateKeyPem: string;
  /** The OAuth2 token endpoint from the key file
   * (`https://oauth2.googleapis.com/token` in every real one). Taken from
   * the credentials rather than hardcoded so tests can stand up a local
   * endpoint the same way apns.test.ts stands up a local APNs. */
  tokenUri: string;
}

export interface FcmClientOptions {
  credentials: FcmCredentials;
  now?: () => number;
  /** Overrides the FCM host. Tests point this at a local HTTP server. */
  origin?: string;
}

/** Same contract as ApnsOutcome: `token_invalid` is the only outcome the
 * caller must act on — the row's token should be dropped, because that
 * device will never receive another push through it. */
export type FcmOutcome = 'sent' | 'token_invalid' | 'failed';

export interface FcmResult {
  outcome: FcmOutcome;
  status?: number;
  /** Google's error code (`UNREGISTERED`, `QUOTA_EXCEEDED`, ...) or RPC
   * status, verbatim. Carries no token and no payload — the same one-line
   * diagnostic discipline ApnsResult.reason exists for. */
  reason?: string;
}

/** The message-wake routing facts — AlertPayload MINUS the ciphertext. The
 * narrowing is done by this type at the module boundary, so the ciphertext
 * cannot reach an FCM request by construction: nothing in this file ever
 * receives it. */
export interface FcmMessageWakePayload {
  from: string;
  ts: number;
  msgId: string;
  msgType: string;
}

const FCM_HOST = 'https://fcm.googleapis.com';

const OAUTH_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

/** Google access tokens live 3600 s; refresh with the same room to spare the
 * APNs JWT keeps (apns.ts TOKEN_REFRESH_MS). */
const TOKEN_REFRESH_MS = 50 * 60_000;

const JWT_LIFETIME_SECONDS = 3600;

/** A ring that arrives after the caller gave up is noise — the same 45 s the
 * VoIP arm gives Apple (apns.ts VOIP_EXPIRY_SECONDS). FCM's default is four
 * WEEKS, so leaving this unset would ring a phone that comes out of a
 * pocket days after the call ended. */
const CALL_TTL_SECONDS = 45;

/** A message wake is worth delivering late; a ring is not. One day, matching
 * the APNs alert arm's reasoning verbatim (apns.ts ALERT_EXPIRY_SECONDS):
 * the ciphertext survives thirty days in the queue either way. */
const MESSAGE_TTL_SECONDS = 86_400;

/** Hard deadline per HTTP request (token mint and send alike), for the same
 * reason apns.ts bounds its attempts: this path must never hold a Lambda to
 * its platform timeout. */
const ATTEMPT_TIMEOUT_MS = 5_000;

/**
 * Error codes that mean "this token is dead", whatever the HTTP status.
 * UNREGISTERED (404) is Google's Unregistered; SENDER_ID_MISMATCH (403)
 * means the token belongs to a different Firebase project and will never be
 * deliverable from ours — the same permanence as DeviceTokenNotForTopic on
 * the Apple side, and treated the same way.
 */
const DEAD_TOKEN_CODES = new Set(['UNREGISTERED', 'SENDER_ID_MISMATCH']);

/**
 * RS256 (RSASSA-PKCS1-v1_5, SHA-256) over the JWS signing input. Unlike the
 * ES256 arm there is no `dsaEncoding` subtlety: RSA signatures have exactly
 * one encoding, and Node's default is it.
 */
function signJwt(credentials: FcmCredentials, nowMs: number): string {
  const header = { alg: 'RS256', typ: 'JWT' };
  const iat = Math.floor(nowMs / 1000);
  const claims = {
    iss: credentials.clientEmail,
    scope: OAUTH_SCOPE,
    aud: credentials.tokenUri,
    iat,
    exp: iat + JWT_LIFETIME_SECONDS,
  };
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  const signingInput = `${encode(header)}.${encode(claims)}`;
  const signature = createSign('RSA-SHA256')
    .update(signingInput)
    .sign(credentials.privateKeyPem)
    .toString('base64url');
  return `${signingInput}.${signature}`;
}

export interface FcmClient {
  readonly origin: string;
  sendCallWake(deviceToken: string, payload: VoipPayload): Promise<FcmResult>;
  sendMessageWake(
    deviceToken: string,
    payload: FcmMessageWakePayload,
  ): Promise<FcmResult>;
}

export function makeFcmClient(options: FcmClientOptions): FcmClient {
  const now = options.now ?? (() => Date.now());
  const origin = options.origin ?? FCM_HOST;
  const { credentials } = options;

  // The access token is reused across sends, exactly as the APNs JWT is: a
  // token-endpoint round trip per push would double every wake's latency and
  // hand Google a needless request stream. Concurrent first sends share ONE
  // in-flight mint; a FAILED mint is not cached, so the next send retries.
  let cached: { token: string; mintedAt: number } | null = null;
  let minting: Promise<string> | null = null;
  function accessToken(): Promise<string> {
    const at = now();
    if (cached && at - cached.mintedAt < TOKEN_REFRESH_MS) {
      return Promise.resolve(cached.token);
    }
    if (!minting) {
      minting = mintAccessToken(at)
        .then(token => {
          cached = { token, mintedAt: at };
          return token;
        })
        .finally(() => {
          minting = null;
        });
    }
    return minting;
  }

  async function mintAccessToken(nowMs: number): Promise<string> {
    const assertion = signJwt(credentials, nowMs);
    const res = await fetch(credentials.tokenUri, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body:
        `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}` +
        `&assertion=${assertion}`,
      signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
    });
    if (!res.ok) {
      // Status only — the body of an OAuth error can echo the assertion.
      throw new Error(`oauth token endpoint answered ${res.status}`);
    }
    const body = (await res.json()) as { access_token?: unknown };
    if (typeof body.access_token !== 'string' || !body.access_token) {
      throw new Error('oauth token response held no access_token');
    }
    return body.access_token;
  }

  /**
   * One FCM v1 send. Data-only on BOTH lanes — a `notification` block would
   * hand rendering to the system tray with none of the app's preview-level
   * gates consulted — and always high priority: the entire point of the push
   * is to wake a Doze-idle process.
   *
   * NO collapse key, on either lane, deliberately. On the call lane the APNs
   * rule holds verbatim — a ring must never replace a ring. On the message
   * lane the iOS collapse id exists to coalesce BANNERS, and on Android the
   * banner is drawn by the app after it decrypts, not by this push — a
   * collapse key here could fold two distinct wakes into one for nothing.
   */
  async function attempt(
    deviceToken: string,
    data: Record<string, string>,
    kind: 'call' | 'message',
  ): Promise<{ status: number; body: string }> {
    const bearer = await accessToken();
    const res = await fetch(
      `${origin}/v1/projects/${credentials.projectId}/messages:send`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${bearer}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          message: {
            token: deviceToken,
            data,
            android: {
              priority: 'HIGH',
              ttl: `${kind === 'call' ? CALL_TTL_SECONDS : MESSAGE_TTL_SECONDS}s`,
            },
          },
        }),
        signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
      },
    );
    return { status: res.status, body: await res.text() };
  }

  function classify(status: number, body: string): FcmResult {
    if (status === 200) return { outcome: 'sent', status };
    let reason = '';
    try {
      const parsed = JSON.parse(body) as {
        error?: { status?: string; details?: Array<{ errorCode?: string }> };
      };
      // The FcmError detail's errorCode is the precise verdict
      // (UNREGISTERED vs INVALID_ARGUMENT both arrive under generic RPC
      // statuses); the RPC status is the fallback when no detail names one.
      const errorCode =
        parsed.error?.details?.map(d => d.errorCode).find(Boolean) ?? '';
      reason = errorCode || String(parsed.error?.status ?? '');
    } catch {
      // A body we cannot parse tells us nothing; fall back to the status.
    }
    // A dead token must be recognised however Google phrases it: 404 always
    // means this token is gone, and the named codes mean it whatever the
    // status.
    if (status === 404 || DEAD_TOKEN_CODES.has(reason)) {
      return { outcome: 'token_invalid', status, reason };
    }
    return { outcome: 'failed', status, reason };
  }

  /**
   * Both lanes share one retry discipline, the APNs one verbatim: retry only
   * a 5xx — a response, so the request was definitely processed and
   * definitely not delivered — exactly once. Never a 429 (a backed-off retry
   * of a ring lands after the call is over; a message wake redelivers itself
   * on the next connect), and never a dead token. A THROW (timeout, torn
   * connection, failed token mint) reports `failed` without retrying, for
   * the same reason sendVoip's does: the send may have been accepted with
   * only the response lost, and a duplicate ring is the one outcome this
   * path must never manufacture.
   */
  async function send(
    deviceToken: string,
    data: Record<string, string>,
    kind: 'call' | 'message',
  ): Promise<FcmResult> {
    let first: { status: number; body: string };
    try {
      first = await attempt(deviceToken, data, kind);
    } catch {
      return { outcome: 'failed' };
    }
    const result = classify(first.status, first.body);
    if (!(result.outcome === 'failed' && first.status >= 500)) return result;
    try {
      const second = await attempt(deviceToken, data, kind);
      return classify(second.status, second.body);
    } catch {
      return { outcome: 'failed' };
    }
  }

  return {
    origin,

    // FCM data values must be strings; `ts` is stringified here and nowhere
    // upstream, so the wire shape is pinned in one place.
    async sendCallWake(deviceToken, payload) {
      return send(
        deviceToken,
        { kind: 'call', fromUser: payload.from, ts: String(payload.ts) },
        'call',
      );
    },

    async sendMessageWake(deviceToken, payload) {
      return send(
        deviceToken,
        {
          kind: 'message',
          fromUser: payload.from,
          ts: String(payload.ts),
          msgId: payload.msgId,
          msgType: payload.msgType,
        },
        'message',
      );
    },
  };
}
