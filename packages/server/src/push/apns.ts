import { createSign } from 'node:crypto';
import http2 from 'node:http2';

/**
 * APNs VoIP push client.
 *
 * Why VoIP push specifically: a standard alert push cannot launch a
 * terminated app and is subject to throttling. PushKit can, which is why
 * Apple restricts it to calls and enforces the CallKit contract in
 *
 * **Crypto-inventory note.** The ES256 JWT here is Apple's authentication scheme for
 * their own API, signed with a key Apple issued. It protects no user content
 * the media is DTLS-SRTP keyed on the devices, and the call offer is inside
 * the Double Ratchet. Same category as the coturn HMAC.
 *
 * **What Apple learns, stated plainly.** A push was sent to this device token
 * at time T, from the opaque userId in `from`. That last field is a real
 * disclosure — it hands Apple a social graph in opaque ids — and it is here
 * only because makes it unavoidable: iOS requires the app to report an
 * incoming call to CallKit *before the push handler returns*, and a ring
 * screen with no name is a worse product than one with a name. The recipient's
 * LOCAL database maps `from` to a display name; nothing legible ships.
 */

export interface ApnsCredentials {
  /** The .p8 key id from the Apple Developer portal. */
  keyId: string;
  teamId: string;
  /** The app's bundle id; the VoIP topic is this + '.voip'. */
  bundleId: string;
  /** The .p8 private key, PEM-encoded. */
  privateKeyP8: string;
}

export interface ApnsClientOptions {
  credentials: ApnsCredentials;
  env?: 'sandbox' | 'production';
  now?: () => number;
  /** Overrides the Apple host. Tests point this at a local HTTP/2 server. */
  origin?: string;
}

/**
 * `token_invalid` is the only outcome the caller must act on: it means the row
 * should be deleted, because that device will never receive another push.
 */
export type ApnsOutcome = 'sent' | 'token_invalid' | 'failed';

export interface ApnsResult {
  outcome: ApnsOutcome;
  /** HTTP status of the attempt that decided the outcome, when one exists. */
  status?: number;
  /** Apple's `reason` string, verbatim. Carries no token and no payload —
   * it is the ONLY diagnostic APNs offers, and swallowing it reduces a failure
   * to a bare "failed" with nothing to act on. */
  reason?: string;
}

/** Metadata-minimal payload. Deliberately NO cid: the server cannot
 * know one — it is inside the ciphertext — and the offer itself always
 * arrives over the encrypted WebSocket queue. */
export interface VoipPayload {
  from: string;
  ts: number;
}

/**
 * An alert push for an ordinary message.
 *
 * Carries the CIPHERTEXT so the device's notification-service extension can
 * decrypt it and render a preview without a network round trip. The server
 * cannot read any of it — the payload is the same bytes it queued.
 *
 * `mutable-content: 1` is what permits the extension to run at all; without
 * it iOS shows `alert.body` verbatim and never gives the app a chance. The
 * body it ships is therefore the DEGRADED case on purpose: if the extension
 * is killed for time or memory, or the device has no key for this sender,
 * what the person sees is "New message" and never a stray string that leaks
 * more than the preference allows.
 *
 * How much the notification actually reveals is decided ON THE DEVICE, by the
 * extension, from a preference stored there. It is not a field here and could
 * not be: honouring "show the sender's name" server-side would require the
 * server to know the name.
 */
export interface AlertPayload {
  from: string;
  ts: number;
  msgId: string;
  msgType: string;
  /** base64 ciphertext, exactly as queued. */
  payload: string;
}

/**
 * THERE IS DELIBERATELY NO `badge` FIELD, and the reason is worth keeping.
 *
 * The obvious source for one is the depth of this recipient's delivery queue:
 * the server queued those frames because the device was not connected, so it
 * already knows the number and learns nothing new by counting them.
 *
 * But that number is not unread mail. Read receipts, reactions, profile-card
 * syncs, edits and deletions all travel as ordinary encrypted frames through
 * exactly the same queue, and on arrival every one of them is a CARRIER — it
 * rewrites an existing row and never becomes a message
 * (`isCarrierEnvelope` in app/src/envelope.ts). A queue-depth badge counts
 * them all, and the worst case inverts the meaning of the feature: somebody
 * READING your messages sends a receipt, which queues, which raises YOUR
 * badge by one.
 *
 * The server cannot separate them, and that is not an oversight to be fixed
 * here. The distinction lives inside the ciphertext, and a flag on the frame
 * saying "this one is only transport" would hand the server precisely the
 * metadata this design refuses it — read receipts are how you learn when
 * somebody opened a conversation.
 *
 * So the badge belongs where the plaintext is. The app owns it whenever it is
 * running (app/src/badge.ts), and the notification-service extension will own
 * it when the app is not: the extension decrypts, so it can tell a carrier
 * from a message and set the count itself. Until that lands, a phone that has
 * not been opened shows no number — which is a smaller lie than a wrong one.
 */

const HOSTS = {
  sandbox: 'https://api.sandbox.push.apple.com',
  production: 'https://api.push.apple.com',
} as const;

/** Apple rejects a JWT older than 60 minutes; refresh with room to spare. */
const TOKEN_REFRESH_MS = 50 * 60_000;

/** A ring that arrives after the caller gave up is noise. Apple drops the
 * push instead of delivering it late. */
const VOIP_EXPIRY_SECONDS = 45;

/**
 * A message notification is worth delivering late; a ring is not.
 *
 * These shared one constant, and 45 seconds is a ring deadline. Applied to an
 * alert it means a phone that is switched off, in airplane mode, or out of
 * coverage for longer than that loses the notification permanently — APNs
 * discards it rather than holding it. The ciphertext still survives thirty
 * days and drains when the socket reconnects, so the message itself was never
 * at risk; what vanished was any sign that it had arrived, which is precisely
 * what someone who was out of coverage needs.
 *
 * A day, and only one: APNs keeps the most recent notification per token, so a
 * longer window buys nothing but a staler banner.
 */
const ALERT_EXPIRY_SECONDS = 86_400;

/**
 * Hard deadline per attempt. Without one, a silently stalled HTTP/2 session
 * holds the caller — which is the MESSAGE path — until the Lambda times out,
 * making message delivery depend on push. It must not. Five seconds is well
 * past a healthy APNs round trip and far short of any handler budget.
 */
const ATTEMPT_TIMEOUT_MS = 5_000;

/** Reasons that mean "this token is dead", whatever the status code. */
const DEAD_TOKEN_REASONS = new Set([
  'Unregistered',
  'BadDeviceToken',
  'DeviceTokenNotForTopic',
]);

/**
 * ES256 for APNs must be raw R||S (JOSE), not the DER encoding Node produces
 * by default — `dsaEncoding: 'ieee-p1363'` is what makes the difference
 * between a working push and an opaque 403.
 */
function signJwt(credentials: ApnsCredentials, nowMs: number): string {
  const header = { alg: 'ES256', kid: credentials.keyId };
  const payload = { iss: credentials.teamId, iat: Math.floor(nowMs / 1000) };
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  const signingInput = `${encode(header)}.${encode(payload)}`;
  const signature = createSign('SHA256')
    .update(signingInput)
    .sign({ key: credentials.privateKeyP8, dsaEncoding: 'ieee-p1363' })
    .toString('base64url');
  return `${signingInput}.${signature}`;
}

export interface ApnsClient {
  readonly origin: string;
  sendVoip(deviceToken: string, payload: VoipPayload): Promise<ApnsResult>;
  sendAlert(deviceToken: string, payload: AlertPayload): Promise<ApnsResult>;
  close(): Promise<void>;
}

export function makeApnsClient(options: ApnsClientOptions): ApnsClient {
  const now = options.now ?? (() => Date.now());
  const origin = options.origin ?? HOSTS[options.env ?? 'production'];
  const { credentials } = options;

  // The JWT is reused across sends — Apple explicitly asks callers not to mint
  // one per request, and a fresh token per push is a good way to get throttled.
  let cachedJwt: { token: string; mintedAt: number } | null = null;
  function authToken(): string {
    const at = now();
    if (!cachedJwt || at - cachedJwt.mintedAt >= TOKEN_REFRESH_MS) {
      cachedJwt = { token: signJwt(credentials, at), mintedAt: at };
    }
    return cachedJwt.token;
  }

  // One HTTP/2 session, reused. Reconnected lazily if it dies; a dead session
  // must not become a permanently broken push path for the whole container.
  let session: http2.ClientHttp2Session | null = null;
  function connect(): http2.ClientHttp2Session {
    if (session && !session.closed && !session.destroyed) return session;
    session = http2.connect(origin);
    // Without a listener, a transport error becomes an unhandled 'error'
    // event and takes the process down.
    session.on('error', () => {
      session = null;
    });
    return session;
  }

  /**
   * One APNs request. The push KIND changes three headers and the body; the
   * http2 plumbing, the deadline and the classification are identical, so the
   * kind is a parameter rather than a second copy of all of it.
   *
   * The topics differ and are not interchangeable: a VoIP push goes to
   * `<bundle>.voip` with the PushKit token, an alert to `<bundle>` with the
   * UNUserNotificationCenter token. Crossing them fails silently, which is
   * the failure mode this parameterisation exists to make impossible.
   */
  async function attempt(
    deviceToken: string,
    payload: VoipPayload | AlertPayload,
    kind: 'voip' | 'alert' = 'voip',
  ): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify(
        kind === 'voip'
          ? payload
          : {
              // The visible fallback. iOS shows this verbatim if the
              // extension never runs — killed for time or memory, or the
              // device has no key for this sender — so it says the least that
              // is still useful.
              aps: {
                alert: { title: 'Tacendum', body: 'New message' },
                sound: 'default',
                'mutable-content': 1,
                'thread-id': (payload as AlertPayload).from,
              },
              // What the extension decrypts. Outside `aps` because Apple
              // reserves that key and drops anything unrecognised inside it.
              t: payload,
            },
      );
      const stream = connect().request({
        ':method': 'POST',
        ':path': `/3/device/${deviceToken}`,
        authorization: `bearer ${authToken()}`,
        'apns-push-type': kind,
        'apns-topic':
          kind === 'voip' ? `${credentials.bundleId}.voip` : credentials.bundleId,
        'apns-priority': '10',
        'apns-expiration': String(
          Math.floor(now() / 1000) +
            (kind === 'voip' ? VOIP_EXPIRY_SECONDS : ALERT_EXPIRY_SECONDS),
        ),
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        // Banner coalescing: on
        // the ALERT arm, undelivered-or-showing banners with the same
        // collapse id fold into one on the device, and the notification
        // extension — the only party with plaintext — renders the survivor
        // honestly. The key is the SENDER: the exact routing fact the body
        // already hands Apple as `thread-id`, so this is one fact in two
        // headers and no new disclosure (the cross-context residual of a
        // source-only key is accepted). The value is a 26-char ULID —
        // 26 ASCII bytes, well under Apple's 64-byte cap on this header.
        // NEVER on the voip arm: a collapse id there would let a second
        // call's push REPLACE an unanswered ring — a ring must never
        // replace a ring (the wakeid mint test's two-rings pin, one layer
        // down). Presentation only: wake emission, timing, and every LIMITS
        // number are unchanged.
        ...(kind === 'alert'
          ? { 'apns-collapse-id': (payload as AlertPayload).from }
          : {}),
      });
      let status = 0;
      let received = '';
      // Bound the attempt. `stream.close()` sends RST_STREAM and frees the
      // stream; without this a stalled response never settles the promise.
      const deadline = setTimeout(() => {
        stream.close(http2.constants.NGHTTP2_CANCEL);
        reject(new Error('apns attempt timed out'));
      }, ATTEMPT_TIMEOUT_MS);
      const settle = <T>(fn: (value: T) => void) => (value: T) => {
        clearTimeout(deadline);
        fn(value);
      };
      stream.setEncoding('utf8');
      stream.on('response', headers => {
        status = Number(headers[':status'] ?? 0);
      });
      stream.on('data', chunk => (received += chunk));
      stream.on('end', settle(() => resolve({ status, body: received })));
      stream.on('error', settle(reject));
      stream.end(body);
    });
  }

  function classify(status: number, body: string): ApnsResult {
    if (status === 200) return { outcome: 'sent', status };
    let reason = '';
    try {
      reason = String((JSON.parse(body) as { reason?: string }).reason ?? '');
    } catch {
      // A body we cannot parse tells us nothing; fall back to the status.
    }
    // A dead token must be recognised however Apple phrases it: 410 always
    // means gone, and a 400 carrying BadDeviceToken means the same thing.
    if (status === 410 || DEAD_TOKEN_REASONS.has(reason)) {
      return { outcome: 'token_invalid', status, reason };
    }
    return { outcome: 'failed', status, reason };
  }

  return {
    origin,

    /**
     * A message notification.
     *
     * Retries the same narrow case `sendVoip` does — a 5xx, which is a
     * response and therefore proof the request was processed and not
     * delivered. A duplicate alert is a duplicate banner, which is worse than
     * a missing one for something the WebSocket will deliver again anyway on
     * the next connect.
     */
    async sendAlert(deviceToken, payload) {
      let first: { status: number; body: string };
      try {
        first = await attempt(deviceToken, payload, 'alert');
      } catch {
        return { outcome: 'failed' };
      }
      const result = classify(first.status, first.body);
      if (!(result.outcome === 'failed' && first.status >= 500)) return result;
      try {
        const second = await attempt(deviceToken, payload, 'alert');
        return classify(second.status, second.body);
      } catch {
        return { outcome: 'failed' };
      }
    },

    async sendVoip(deviceToken, payload) {
      let first: { status: number; body: string };
      try {
        first = await attempt(deviceToken, payload);
      } catch {
        // AMBIGUOUS: the request may have been accepted and only the response
        // lost. Retrying could ring the callee twice for one call, so this
        // reports failure instead. The message is durably queued either way,
        // and the caller's UI degrades on its own timer.
        return { outcome: 'failed' };
      }

      const result = classify(first.status, first.body);
      // Retry only what a retry could fix AND what we KNOW was processed: a
      // 5xx is a response, so the request definitely reached Apple and was
      // definitely not delivered. Never a 429 (a backed-off retry lands after
      // the call is over) and never a dead token (it will not come back).
      if (!(result.outcome === 'failed' && first.status >= 500)) return result;

      try {
        const second = await attempt(deviceToken, payload);
        return classify(second.status, second.body);
      } catch {
        return { outcome: 'failed' };
      }
    },

    async close() {
      const current = session;
      session = null;
      if (current && !current.destroyed) {
        await new Promise<void>(resolve => current.close(() => resolve()));
      }
    },
  };
}
