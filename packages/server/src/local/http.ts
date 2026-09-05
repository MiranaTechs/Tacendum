import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes, randomInt } from 'node:crypto';
import { ulid } from 'ulid';
import { makeDocClient } from '../db/client.js';
import { makeDataLayer } from '../db/data.js';
import { log } from '../log.js';
import { makeRateLimiter } from '../ratelimit.js';
import { deleteAccountRoute } from '../handlers/account.js';
import { clientPolicyHandler } from '../handlers/client-policy.js';
import { createReportHandler } from '../handlers/report.js';
import { requireAuth } from '../handlers/auth.js';
import { turnCredentialsHandler } from '../handlers/turn.js';
import { wsTicketHandler } from '../handlers/ws-ticket.js';
import {
  deletePushTokenHandler,
  registerPushTokenHandler,
} from '../handlers/push.js';
import {
  authChallengeHandler,
  authHandler,
  SOURCE_OFFER_ROUTES,
  sourceOfferUrl,
  withSourceOffer,
} from '../handlers/auth-account.js';
import { crewAdoptHandler } from '../handlers/crew.js';
import {
  accountsRefusal,
  isAccountsCollapsedRoute,
  linkOfferInitRoute,
} from '../handlers/devices.js';
import {
  deviceRevokeRoute,
  deviceUnlinkRoute,
  linkAcceptRoute,
  linkOfferSubmitRoute,
} from '../handlers/devices-signed.js';
import {
  emailRequestCodeRoute,
  emailUnlinkRoute,
  emailVerifyRoute,
  phoneRequestCodeRoute,
  phoneUnlinkRoute,
  phoneVerifyRoute,
  recoveryCancelRoute,
  recoveryRequestCodeRoute,
  recoveryVerifyRoute,
} from '../handlers/identifiers.js';
import {
  discoveryLookupRoute,
  setDiscoverableRoute,
  setPhoneDiscoverableRoute,
  setUsernameDiscoverableRoute,
} from '../handlers/discovery.js';
import {
  usernameClaimRoute,
  usernameRenameRoute,
  usernameUnlinkRoute,
} from '../handlers/username.js';
import { recoveryCompleteRoute } from '../handlers/recovery-signed.js';
import { consentDeleteHandler, consentWriteHandler } from '../handlers/consent.js';
import { integrationBindHandler, integrationRevokeHandler } from '../handlers/integrations.js';
import { deleteOtherSessionsHandler, deleteSessionHandler } from '../handlers/session.js';
import { getPrekeyBundleHandler, uploadKeysHandler } from '../handlers/keys.js';
import { createAttachmentHandler, getAttachmentHandler } from '../handlers/attachments.js';
import { callMetricsHandler } from '../handlers/call-metrics.js';
import { makeMemoryCallMetricStore } from '../call-metrics.js';
import { makeS3Attachments, makeS3Client, readS3Config } from '../storage.js';
import { makeFcmPushSender, readFcmCredentialsFromPath } from '../push/fcm-sender.js';
import { makePlatformPushSender } from '../push/route.js';
import {
  type Deps,
  type Handler,
  type HttpEvent,
  type HttpResult,
  json,
  MAX_BODY_BYTES,
} from '../handlers/http.js';
import { normalizeOrigin } from '@tacendum/shared';

/**
 * Local HTTP adapter: builds Lambda-shaped HttpEvents from Node's
 * http server and dispatches to the pure handlers. The handlers never import
 * anything from this file — the dependency arrow points only inward.
 */

let localCallMetricStore = makeMemoryCallMetricStore();
const localCallMetricPublisher = { publish: async (): Promise<void> => {} };

/** Reset the module-local call-metric dedupe state between local adapter tests. */
export function resetLocalCallMetricsForTests(): void {
  localCallMetricStore = makeMemoryCallMetricStore();
}

/** Construct the real dependencies. Token/code randomness uses the platform
 * RNG (node:crypto), which Rule 1 explicitly permits. */
export function makeDeps(): Deps {
  const db = makeDataLayer(makeDocClient());
  const s3Config = readS3Config();
  return {
    db,
    now: () => Date.now(),
    newUserId: () => ulid(),
    newAuthToken: () => randomBytes(32).toString('base64url'),
    // Standard base64, not base64url: the shared DTO validates the challenge
    // against the same alphabet Signal keys use, where '-'/'_' are invalid.
    newChallenge: () => randomBytes(32).toString('base64'),
    // The origin clients sign for. It is configuration
    // rather than a request header for the same reason it is in AWS: a caller
    // must never get to name the audience it is checked against.
    // Derived from HTTP_PORT because the port is part of the origin, and the
    // e2e harness runs on 18080 while the default is 8080. A fixed default here
    // meant the client signed for one audience and the server checked another,
    // which surfaces as `invalid_signature` on registration — a message that
    // points at the crypto and not at the port. Caught by scripts/e2e.sh, which
    // is exactly the class of mistake it exists to catch.
    apiOrigin: normalizeOrigin(
      process.env.API_ORIGIN ?? `http://localhost:${process.env.HTTP_PORT ?? 8080}`,
    ),
    rateLimit: makeRateLimiter(),
    callMetrics: { store: localCallMetricStore, publisher: localCallMetricPublisher },
    log: (event, fields) => log.info(event, fields),
    newAttachmentId: () => randomBytes(32).toString('base64url'),
    // 6-digit email code: platform CSPRNG —
    // an id-shaped secret, not key material.
    newEmailCode: () => String(randomInt(0, 1_000_000)).padStart(6, '0'),
    newReportId: () => ulid(),
    attachments: makeS3Attachments(makeS3Client(s3Config), s3Config.bucket),
    // Local relay config, if one is provided. Unset by default: calls then run
    // direct-only, which is the right local default because two simulators on
    // one Mac never need a relay.
    turn: readLocalTurnConfig(),
    // The keyed-pseudonymization salt (opaque-ref.ts), readable WITHOUT the
    // rest of the TURN config: a dev machine testing lifecycle log refs or
    // activity keying should not need a relay to exist. Same value the AWS
    // path fetches from Secrets Manager. Unset by default: log refs then
    // read `unavailable` and activity writes are skipped with a counter.
    ...(process.env.TURN_USER_SALT ? { userRefSalt: process.env.TURN_USER_SALT } : {}),
    // K_id for the identifier-claim HMAC: plaintext
    // env locally (a dev machine has no Secrets Manager — the TURN split),
    // Secrets Manager by ARN in AWS. Absent = the identifier routes refuse
    // with the collapsed error (fail closed; opaque-ref.ts computes, this
    // file only carries). Version 1 is the local default; rotation is a
    // deployed-lane concern.
    ...(process.env.IDENTIFIER_HMAC_KEY
      ? { identifierHmac: { keys: [{ version: 1, key: process.env.IDENTIFIER_HMAC_KEY }] } }
      : {}),
    // Email delivery, local stub: the CODE and the opaque ref are printed —
    // the ADDRESS never reaches a log line, not even here (the field-free log rule's spirit;
    // the dev completes the flow from this line exactly as the old console
    // SMS worked). SES rides the AWS deps seam.
    email: {
      sendCode: async ({ code, ref, purpose }) => {
        console.log(`EMAIL code ${code} (${purpose}) ref ${ref}`);
        return 'sent';
      },
    },
    // SMS delivery, local stub: the CODE and the opaque ref only —
    // the NUMBER never reaches a log line, not even here (the field-free log rule's spirit;
    // the dev completes the flow from this line). EUM rides the AWS deps
    // seam.
    sms: {
      sendCode: async ({ code, ref, purpose }) => {
        console.log(`SMS code ${code} (${purpose}) ref ${ref}`);
        return 'sent';
      },
    },
    // One router, two local lanes (push/route.ts) — the same shape AWS wires,
    // so a platform-routing bug is reachable from a dev machine.
    push: makePlatformPushSender({
      // Stubbed VoIP push: a greppable console line so the e2e can assert a
      // wake happened without APNs (which does not work in the simulator at
      // all). These two lines are load-bearing verbatim: the e2e and
      // log-hygiene greps pin them.
      apns: {
        wake: async (token, fromUserId) => {
          console.log(`VOIP push to ${token.userId} from ${fromUserId}`);
          return 'sent';
        },
        // Same greppable-stub treatment for message notifications. msgId only —
        // the ciphertext payload never reaches a log line.
        notify: async (token, message) => {
          console.log(`ALERT push to ${token.userId} msg ${message.msgId}`);
          return 'sent';
        },
      },
      fcm: makeLocalFcmSender(),
    }),
  };
}

/**
 * The local FCM lane. Unlike APNs — which cannot reach a simulator at all —
 * FCM reaches a real Android device from a dev machine fine, and on-device
 * testing needs exactly that: local server, real device, real wake. So when FCM_SERVICE_ACCOUNT_KEY_PATH names a key file the lane is
 * the REAL sender (the key VALUE from a local path, the same
 * secrets-locally-ARNs-in-AWS split readLocalTurnConfig documents); unset,
 * it is the same greppable-stub treatment the APNs lane gets. A set-but-bad
 * path throws at boot (fcm-sender.ts) — half-configured is worse than none.
 */
function makeLocalFcmSender(): Deps['push'] {
  const credentials = readFcmCredentialsFromPath();
  if (credentials) {
    return makeFcmPushSender({
      credentials,
      log: (event, fields) => log.info(event, fields),
    });
  }
  return {
    // The same two verbatim lines as the APNs stub above, on purpose: those
    // exact bytes are what the log-hygiene allowlist and the
    // e2e greps pin, and which lane fired is already told by the platform of
    // the token that registered — not by the log line. A novel "FCM push to"
    // prefix would be an unvetted id-bearing log site, which the log
    // discipline rejects.
    wake: async (token, fromUserId) => {
      console.log(`VOIP push to ${token.userId} from ${fromUserId}`);
      return 'sent';
    },
    // msgId only — the ciphertext payload never reaches a log line.
    notify: async (token, message) => {
      console.log(`ALERT push to ${token.userId} msg ${message.msgId}`);
      return 'sent';
    },
  };
}

/**
 * TURN for local development, from the environment. Absent by default —
 * two simulators on one Mac reach each other over host candidates, so a relay
 * is only wired up when someone is deliberately testing the relayed path
 * against a local coturn container.
 *
 * The env var names DIFFER from the AWS path on purpose: this reads the
 * secret VALUES (TURN_AUTH_SECRET / TURN_USER_SALT) because a dev machine has
 * no Secrets Manager, while aws/deps.ts reads ARNs (TURN_AUTH_SECRET_ARN /
 * TURN_USER_SALT_ARN) and fetches at runtime — a deploy-time-resolved value
 * sat in plaintext on the function configuration. The drift
 * guard is downstream of here: both paths must produce the same TurnConfig,
 * consumed by the same turnCredentialsHandler, so only the transport of the
 * secret may differ — never its meaning.
 */
function readLocalTurnConfig(env: NodeJS.ProcessEnv = process.env): Deps['turn'] {
  const urls = env.TURN_URLS?.split(',').map(u => u.trim()).filter(Boolean);
  if (!urls || urls.length === 0) return null;
  const authSecret = env.TURN_AUTH_SECRET;
  const userSalt = env.TURN_USER_SALT;
  if (!authSecret || !userSalt) {
    // Fail loudly rather than minting credentials coturn will reject: a
    // half-configured relay is worse than none, because every call would try
    // it and time out instead of going direct.
    throw new Error('TURN_URLS is set but TURN_AUTH_SECRET/TURN_USER_SALT are not');
  }
  return { urls, authSecret, userSalt };
}

interface Route {
  method: string;
  /** Path template; segments starting with ':' are captured as path params. */
  pattern: string;
  handler: Handler;
}

const routes: Route[] = [
  // Keypair-only accounts — the ONLY way in, and the
  // only two unauthenticated routes. In AWS these live on their own function
  // because of libsignal's native binary; the local host runs one process and
  // does not care. `POST /v1/register` and `POST /v1/verify` stood here until
  // deleted the phone number.
  { method: 'POST', pattern: '/v1/auth/challenge', handler: authChallengeHandler },
  { method: 'POST', pattern: '/v1/auth', handler: authHandler },
  { method: 'PUT', pattern: '/v1/keys', handler: requireAuth(uploadKeysHandler) },
  { method: 'GET', pattern: '/v1/keys/:userId', handler: requireAuth(getPrekeyBundleHandler) },
  // The deletion route's own wrapper (admits an absent-row session so a sweep
  // that crashed after its row delete can be retried).
  { method: 'DELETE', pattern: '/v1/account', handler: deleteAccountRoute },
  { method: 'POST', pattern: '/v1/reports', handler: requireAuth(createReportHandler) },
  { method: 'POST', pattern: '/v1/call-metrics', handler: requireAuth(callMetricsHandler) },
  { method: 'DELETE', pattern: '/v1/session', handler: requireAuth(deleteSessionHandler) },
  // Above no wildcard route, and distinct from /v1/session: matchPattern is
  // exact-segment, so these two cannot collide.
  {
    method: 'DELETE',
    pattern: '/v1/sessions/others',
    handler: requireAuth(deleteOtherSessionsHandler),
  },
  { method: 'POST', pattern: '/v1/attachments', handler: requireAuth(createAttachmentHandler) },
  { method: 'POST', pattern: '/v1/turn-credentials', handler: requireAuth(turnCredentialsHandler) },
  // The socket's credential, minted over HTTPS so it never rides in a URL
  { method: 'POST', pattern: '/v1/ws-ticket', handler: requireAuth(wsTicketHandler) },
  // Integration accounts: the write-once owner bind
  // (called by the integration) and the owner's revoke (tombstones the key).
  { method: 'POST', pattern: '/v1/integrations/bind', handler: requireAuth(integrationBindHandler) },
  {
    method: 'DELETE',
    pattern: '/v1/integrations/:userId',
    handler: requireAuth(integrationRevokeHandler),
  },
  // Crew adoption: OWNER-called — adoption is an admission
  // decision, and an integration (an injectable node) can never be an
  // admission authority, so the one write that grows a crew belongs to a human.
  { method: 'POST', pattern: '/v1/crew/adopt', handler: requireAuth(crewAdoptHandler) },
  // Device linking. NOT requireAuth-wrapped:
  // each route wraps itself (accountsRoute) so the `feature#accounts` flag
  // is checked FIRST and the dark deploy answers one collapsed byte-stream
  // to every probe, bearer or no bearer. In AWS the
  // init leg rides the ordinary HTTP Lambda and the four signature-verifying
  // legs ride the auth Lambda (the signature decides the Lambda — route
  // placement); the local host runs one process and does not care.
  { method: 'POST', pattern: '/v1/devices/link-offer', handler: linkOfferInitRoute },
  { method: 'POST', pattern: '/v1/devices/link-offer/submit', handler: linkOfferSubmitRoute },
  { method: 'POST', pattern: '/v1/devices/link-accept', handler: linkAcceptRoute },
  { method: 'POST', pattern: '/v1/devices/unlink', handler: deviceUnlinkRoute },
  { method: 'POST', pattern: '/v1/devices/revoke', handler: deviceRevokeRoute },
  // Email linking + recovery. Same wrapper
  // discipline as the device routes above: the flag is checked first and a
  // dark probe buys one collapsed byte-stream. In AWS the six token-path
  // legs ride the ordinary HTTP Lambda and the signature-verifying
  // completion rides the auth Lambda (route placement).
  { method: 'POST', pattern: '/v1/identifiers/email/request-code', handler: emailRequestCodeRoute },
  { method: 'POST', pattern: '/v1/identifiers/email/verify', handler: emailVerifyRoute },
  { method: 'POST', pattern: '/v1/identifiers/email/unlink', handler: emailUnlinkRoute },
  // Phone linking, the four token-path legs (master AND phone flag,
  // both checked first — accountsPhoneRoute).
  { method: 'POST', pattern: '/v1/identifiers/phone/request-code', handler: phoneRequestCodeRoute },
  { method: 'POST', pattern: '/v1/identifiers/phone/verify', handler: phoneVerifyRoute },
  { method: 'POST', pattern: '/v1/identifiers/phone/unlink', handler: phoneUnlinkRoute },
  { method: 'POST', pattern: '/v1/identifiers/phone/discoverable', handler: setPhoneDiscoverableRoute },
  // Username claims, the four token-path legs (master AND `feature#accounts-username`, both checked first —
  // accountsUsernameRoute). `/claim` and `/rename` are one verb.
  { method: 'POST', pattern: '/v1/identifiers/username/claim', handler: usernameClaimRoute },
  { method: 'POST', pattern: '/v1/identifiers/username/rename', handler: usernameRenameRoute },
  { method: 'POST', pattern: '/v1/identifiers/username/unlink', handler: usernameUnlinkRoute },
  { method: 'POST', pattern: '/v1/identifiers/username/discoverable', handler: setUsernameDiscoverableRoute },
  { method: 'POST', pattern: '/v1/recovery/request-code', handler: recoveryRequestCodeRoute },
  { method: 'POST', pattern: '/v1/recovery/verify', handler: recoveryVerifyRoute },
  { method: 'POST', pattern: '/v1/recovery/cancel', handler: recoveryCancelRoute },
  { method: 'POST', pattern: '/v1/recovery/complete', handler: recoveryCompleteRoute },
  // Contact discovery. Same wrapper discipline:
  // the flag is checked first (its read doubles as the kill switch) and a
  // dark probe buys one collapsed byte-stream. Both legs are signature-free,
  // so in AWS both ride the ordinary HTTP Lambda (route placement).
  { method: 'POST', pattern: '/v1/discovery/lookup', handler: discoveryLookupRoute },
  { method: 'POST', pattern: '/v1/identifiers/email/discoverable', handler: setDiscoverableRoute },
  // Consent edges: write + delete, HUMAN-called.
  // No read route exists or ever will (consent enumeration refused).
  { method: 'POST', pattern: '/v1/consent', handler: requireAuth(consentWriteHandler) },
  { method: 'DELETE', pattern: '/v1/consent/:agentId', handler: requireAuth(consentDeleteHandler) },
  { method: 'PUT', pattern: '/v1/push-token', handler: requireAuth(registerPushTokenHandler) },
  { method: 'DELETE', pattern: '/v1/push-token', handler: requireAuth(deletePushTokenHandler) },
  {
    method: 'GET',
    pattern: '/v1/attachments/:attachmentId',
    handler: requireAuth(getAttachmentHandler),
  },
  // Exercises the bearer-token middleware end to end.
  {
    method: 'GET',
    pattern: '/v1/me',
    handler: requireAuth(async (_e, _d, auth) => json(200, auth)),
  },
  // The update gate's read side, unauthenticated on
  // both hosts: the landing screen asks it before there is an account. A REAL
  // TABLE ENTRY, unlike the `/health` special case matched inline in `handle`
  // below. This one reads a row and holds a rate-limit bucket, so it must go
  // through the same dispatch, body cap and error handling every other route
  // does rather than short-circuiting ahead of them.
  { method: 'GET', pattern: '/v1/client-policy', handler: clientPolicyHandler },
];

/** Match a path against a template, returning captured params or null. */
function matchPattern(pattern: string, path: string): Record<string, string> | null {
  const pSegs = pattern.split('/');
  const aSegs = path.split('/');
  if (pSegs.length !== aSegs.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pSegs.length; i++) {
    const p = pSegs[i]!;
    const a = aSegs[i]!;
    if (p.startsWith(':')) {
      params[p.slice(1)] = decodeURIComponent(a);
    } else if (p !== a) {
      return null;
    }
  }
  return params;
}

class BodyTooLargeError extends Error {}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (c: Buffer) => {
      total += c.length;
      if (total > MAX_BODY_BYTES) {
        reject(new BodyTooLargeError());
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function headersToRecord(req: IncomingMessage): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    out[k] = Array.isArray(v) ? v.join(',') : v;
  }
  return out;
}

export function createHttpServer(deps: Deps): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    // Last-resort guard: a malformed request must never reject an unhandled
    // promise and crash the process. Every error path lands on a JSON response.
    handle(req, res, deps).catch((err) => {
      log.error('request_unhandled_error', {
        error: err instanceof Error ? err.message : String(err),
      });
      if (!res.headersSent) {
        sendError(res, 500, 'internal', 'internal error');
      } else {
        res.end();
      }
    });
  });
}

/**
 * The four SIGNED device routes, exactly as AuthFn's dispatch table mounts
 * them (aws/auth.lambda.ts `routes`; route placement — the signature
 * decides the Lambda). Named here so the local host can apply the AGPL
 * source offer to precisely the routes whose DEPLOYED host applies it to
 * everything — per-route byte parity of the collapsed refusal across hosts.
 * Drift against the AuthFn table is
 * caught by the cross-host parity assertions in accounts-routes.aws.test.ts.
 */
const AUTH_HOSTED_DEVICE_ROUTES: ReadonlySet<string> = new Set([
  'POST /v1/devices/link-offer/submit',
  'POST /v1/devices/link-accept',
  'POST /v1/devices/unlink',
  'POST /v1/devices/revoke',
  // The one recovery leg that verifies an identity signature (route
  // placement) — AuthFn-hosted when deployed, so its refusals carry the
  // offer here too (per-route cross-host byte parity).
  'POST /v1/recovery/complete',
]);

function sendError(res: ServerResponse, statusCode: number, code: string, detail: string): void {
  send(res, {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ error: { code, detail } }),
  });
}

async function handle(req: IncomingMessage, res: ServerResponse, deps: Deps): Promise<void> {
  const method = req.method ?? 'GET';

  // Parse + match the URL defensively: a malformed URL (bad percent-encoding,
  // etc.) is a 400, not a crash.
  let path: string;
  let matched: { route: Route; params: Record<string, string> } | undefined;
  try {
    path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (method === 'GET' && path === '/health') {
      return send(res, {
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        body: '{"ok":true}',
      });
    }
    for (const route of routes) {
      if (route.method !== method) continue;
      const params = matchPattern(route.pattern, path);
      if (params) {
        matched = { route, params };
        break;
      }
    }
  } catch {
    return sendError(res, 400, 'invalid_request', 'malformed request URL');
  }

  /*
   * AGPL rides EVERY response for the two auth paths, not only the two
   * successes (the offer itself lives in
   * handlers/auth-account.ts). A caller who is rate limited, refused, or handed
   * a 500 is no less a remote user of this service, so the offer is applied
   * here — once, at the host boundary — rather than at each handler exit, where
   * the next exit added would silently miss it.
   *
   * SCOPED BY ROUTE, unlike the AWS auth host, and that asymmetry is not an
   * inconsistency: AuthFn applies the offer at its function boundary because
   * every route it hosts owes one; this process hosts all the routes of every
   * deployed function, and says nothing about the rest, so a Link header
   * on them would be an offer nobody made. The scope here is therefore the
   * union of AuthFn's route table: the two auth routes (`SOURCE_OFFER_ROUTES`,
   * the one -named list) plus the four SIGNED device routes that ride
   * AuthFn when deployed (`AUTH_HOSTED_DEVICE_ROUTES` below). Matched on
   * METHOD AND PATH exactly as routing is — keyed on path alone, `GET
   * /v1/auth` got an offer on its 404.
   *
   * The four device routes are included
   * for BOTH reasons at once: they serve remote users of the service (so the
   * offer is owed there in its own right — the auth.lambda.ts argument), and
   * without them the same collapsed accounts refusal carried a Link header
   * from the deployed host and none from this one — refusal BYTES diverging
   * between hosts on routes whose whole refusal discipline is one pinned
   * byte-stream (body, status, AND headers). The INIT
   * leg deliberately stays outside: deployed, it rides HttpFn, which adds no
   * offer — parity is per route, per its deployed host. The cross-host
   * equality is asserted in accounts-routes.aws.test.ts.
   *
   * The 400 above is deliberately outside this: an unparseable URL has no path
   * to test, so there is nothing to decide it is an auth response by. Same for
   * the last-resort catch in `createHttpServer`, which runs with the response
   * possibly already begun and is the wrong place to start adding headers.
   */
  const offerSource =
    SOURCE_OFFER_ROUTES.has(`${method} ${path}`) ||
    AUTH_HOSTED_DEVICE_ROUTES.has(`${method} ${path}`);
  const respond = (result: HttpResult): void =>
    send(res, offerSource ? withSourceOffer(result, sourceOfferUrl()) : result);
  const respondError = (statusCode: number, code: string, detail: string): void =>
    respond({
      statusCode,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ error: { code, detail } }),
    });

  if (!matched) {
    return respondError(404, 'not_found', `${method} ${path}`);
  }

  // An accounts-program route answers even an oversized probe with the
  // collapsed refusal: the pre-dispatch
  // 413 was a flag-independent "this accounts route is wired" discriminator
  // on a dark deploy. The response bytes join the collapse (through
  // `respond`, so the signed routes carry the same offer their deployed
  // host puts on every response); the connection still tears down without
  // reading the body, exactly as the 413 path does — the size ceiling holds.
  const routeHandler = matched.route.handler;
  const oversized = (): void => {
    if (isAccountsCollapsedRoute(routeHandler)) respond(accountsRefusal());
    else respondError(413, 'invalid_request', 'request body too large');
    // Tear the connection down AFTER the refusal flushes: destroying
    // immediately discards the buffered response bytes, so the caller saw a
    // reset instead of the refusal (and for an accounts route the refusal
    // BYTES are the point — the collapse must be readable). The oversized
    // body itself is still never read.
    res.once('finish', () => req.destroy());
  };

  // Fast path: reject an oversized body by its declared length before reading.
  const declaredLength = Number(req.headers['content-length'] ?? '0');
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return oversized();
  }

  let body: string;
  try {
    body = await readBody(req);
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      return oversized();
    }
    throw err;
  }

  const event: HttpEvent = {
    method,
    path,
    headers: headersToRecord(req),
    pathParameters: matched.params,
    body,
    ...(req.socket.remoteAddress ? { sourceIp: req.socket.remoteAddress } : {}),
  };

  try {
    const result = await matched.route.handler(event, deps);
    respond(result);
  } catch (err) {
    // Never include request bodies / payloads in error output.
    log.error('handler_error', { error: err instanceof Error ? err.message : String(err) });
    respondError(500, 'internal', 'internal error');
  }
}

function send(
  res: ServerResponse,
  result: { statusCode: number; headers?: Record<string, string>; body?: string },
): void {
  res.writeHead(result.statusCode, result.headers ?? {});
  res.end(result.body ?? '');
}

export function startHttpServer(port: number, deps: Deps = makeDeps()): Server {
  const server = createHttpServer(deps);
  server.listen(port, () => {
    log.info('http_listening', { port });
  });
  return server;
}
