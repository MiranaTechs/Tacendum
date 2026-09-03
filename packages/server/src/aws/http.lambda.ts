import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { deleteAccountRoute } from '../handlers/account.js';
import { createReportHandler } from '../handlers/report.js';
import { requireAuth } from '../handlers/auth.js';
import { turnCredentialsHandler } from '../handlers/turn.js';
import { wsTicketHandler } from '../handlers/ws-ticket.js';
import {
  deletePushTokenHandler,
  registerPushTokenHandler,
} from '../handlers/push.js';
import {
  deleteOtherSessionsHandler,
  deleteSessionHandler,
} from '../handlers/session.js';
import { crewAdoptHandler } from '../handlers/crew.js';
import { consentDeleteHandler, consentWriteHandler } from '../handlers/consent.js';
import { integrationBindHandler, integrationRevokeHandler } from '../handlers/integrations.js';
import { getPrekeyBundleHandler, uploadKeysHandler } from '../handlers/keys.js';
import { createAttachmentHandler, getAttachmentHandler } from '../handlers/attachments.js';
import {
  accountsRefusal,
  isAccountsCollapsedRoute,
  linkOfferInitRoute,
} from '../handlers/devices.js';
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
import { callMetricsHandler } from '../handlers/call-metrics.js';
import { json, MAX_BODY_BYTES, type Handler, type HttpEvent } from '../handlers/http.js';
import { log } from '../log.js';
import { makeAwsDeps } from './deps.js';
import { makeAwsCallMetrics } from './call-metrics.js';

/**
 * AWS Lambda entrypoint for the REST endpoints. Maps an API Gateway
 * HTTP API (payload format 2.0) event to the same `HttpEvent` the local adapter
 * builds, dispatches to the SAME pure handlers, and maps `HttpResult` back.
 * The handlers are unchanged (invariant).
 *
 * Routing uses API Gateway's `routeKey` ("PUT /v1/keys"), so the route table
 * lives in the CDK stack, not here — and the two must agree exactly, because a
 * mismatch is a 404 at runtime with a green build on both sides.
 *
 * EVERY route here is authenticated, with two named exceptions the security
 * suite pins: GET /health (a constant, reads nothing) and the accounts
 * program's INIT leg, whose `accountsRoute` wrapper checks the default-OFF
 * `feature#accounts` flag BEFORE performing its own bearer auth — an
 * anonymous caller buys one flag read and one collapsed 403, nothing else. The two truly unauthenticated
 * data-touching routes — the account challenge and its response — live on
 * AuthFn (aws/auth.lambda.ts). `POST /v1/register` and `POST /v1/verify`
 * were the other two, and they are gone with phone-number registration.
 * */

// EXPORTED for exactly one consumer: the route-parity test in
// infra/test/tacendum-stack.test.ts, which pins this table against the CDK
// stack's httpRoutes in both directions. The two
// tables describe ONE deployed surface from two sides — CDK decides what API
// Gateway forwards, this decides what the function answers — and the crew
// adopt route shipped in one but not the other: every local test green, the
// deployed route a 404. The parity test is what makes that class of bug
// impossible to reintroduce silently.
export const routes: Record<string, Handler> = {
  'PUT /v1/keys': requireAuth(uploadKeysHandler),
  'GET /v1/keys/{userId}': requireAuth(getPrekeyBundleHandler),
  'POST /v1/attachments': requireAuth(createAttachmentHandler),
  'GET /v1/attachments/{attachmentId}': requireAuth(getAttachmentHandler),
  'POST /v1/turn-credentials': requireAuth(turnCredentialsHandler),
  // The socket's credential, minted over HTTPS so it never rides in a URL
  'POST /v1/ws-ticket': requireAuth(wsTicketHandler),
  'PUT /v1/push-token': requireAuth(registerPushTokenHandler),
  'DELETE /v1/push-token': requireAuth(deletePushTokenHandler),
  'GET /v1/me': requireAuth(async (_e, _d, auth) => json(200, auth)),
  // The deletion route's own wrapper: the ONE entry that admits a session
  // whose user row is already gone, so a sweep that crashed after its row
  // delete can be retried (handlers/account.ts).
  'DELETE /v1/account': deleteAccountRoute,
  'POST /v1/reports': requireAuth(createReportHandler),
  'POST /v1/call-metrics': requireAuth(callMetricsHandler),
  'DELETE /v1/session': requireAuth(deleteSessionHandler),
  'DELETE /v1/sessions/others': requireAuth(deleteOtherSessionsHandler),
  // Integration accounts: the write-once owner bind
  // (called by the integration) and the owner's revoke (tombstones the key).
  'POST /v1/integrations/bind': requireAuth(integrationBindHandler),
  'DELETE /v1/integrations/{userId}': requireAuth(integrationRevokeHandler),
  // Crew adoption: OWNER-called — an integration (an
  // injectable node) can never be an admission authority. Missing from this
  // table at first ship while present in CDK's, which is exactly the 404 the
  // parity test above now pins away.
  'POST /v1/crew/adopt': requireAuth(crewAdoptHandler),
  // Consent edges: the human's write + delete on
  // the directed (self -> agent) edge the ws predicate enforces. There is NO
  // read route, deliberately and permanently: nobody lists who
  // consented to what, the machine.ts enumeration-refusal stance extended.
  'POST /v1/consent': requireAuth(consentWriteHandler),
  'DELETE /v1/consent/{agentId}': requireAuth(consentDeleteHandler),
  // Device linking, INIT leg only (route
  // placement — the signature decides the Lambda). This leg verifies NO libsignal signature, so it rides
  // the token path; the four signed legs live on AuthFn (auth.lambda.ts).
  // NOT wrapped in requireAuth here: `accountsRoute` checks the default-OFF
  // `feature#accounts` flag FIRST — before auth, before parsing — so every
  // probe of a dark deploy gets ONE collapsed byte-stream, then performs
  // its own bearer auth. The anonymous-surface
  // pin in the deployment's security tests names this route and asserts exactly
  // that: an anonymous caller buys one flag read and the collapsed 403.
  'POST /v1/devices/link-offer': linkOfferInitRoute,
  // Email linking + recovery, the six token-path legs (route placement — none of these verifies a libsignal signature,
  // so all six stay off AuthFn; the signature-verifying completion is
  // auth.lambda.ts's). Every one wraps itself in `accountsRoute`: the
  // default-OFF `feature#accounts` flag is checked FIRST and a dark probe
  // buys one flag read and the collapsed 403 — the anonymous-surface pin in
  // the deployment's security tests names each of these routes.
  'POST /v1/identifiers/email/request-code': emailRequestCodeRoute,
  'POST /v1/identifiers/email/verify': emailVerifyRoute,
  'POST /v1/identifiers/email/unlink': emailUnlinkRoute,
  // Phone linking, the four token-path legs (route
  // placement — none verifies a libsignal signature). Each wraps itself in
  // `accountsPhoneRoute`: `feature#accounts` AND `feature#accounts-phone`,
  // both checked FIRST, either absent = the same collapsed 403 — the phone
  // train is dark inside a LIVE email-v1 deploy, and the sub-flag is the
  // class kill switch (one operator delete).
  'POST /v1/identifiers/phone/request-code': phoneRequestCodeRoute,
  'POST /v1/identifiers/phone/verify': phoneVerifyRoute,
  'POST /v1/identifiers/phone/unlink': phoneUnlinkRoute,
  'POST /v1/identifiers/phone/discoverable': setPhoneDiscoverableRoute,
  // Username claims, the four token-path legs
  // (route placement — none verifies a libsignal signature). Each wraps
  // itself in `accountsUsernameRoute`: `feature#accounts` AND
  // `feature#accounts-username`, both checked FIRST, either absent = the
  // same collapsed 403 — the class is dark inside a LIVE deploy, the
  // sub-flag is the class kill switch AND the K_id rotation-window brake.
  // `/claim` and `/rename` are one verb.
  'POST /v1/identifiers/username/claim': usernameClaimRoute,
  'POST /v1/identifiers/username/rename': usernameRenameRoute,
  'POST /v1/identifiers/username/unlink': usernameUnlinkRoute,
  'POST /v1/identifiers/username/discoverable': setUsernameDiscoverableRoute,
  'POST /v1/recovery/request-code': recoveryRequestCodeRoute,
  'POST /v1/recovery/verify': recoveryVerifyRoute,
  'POST /v1/recovery/cancel': recoveryCancelRoute,
  // Contact discovery (route placement — neither
  // leg verifies a libsignal signature, so both stay off AuthFn). Each
  // wraps itself in `accountsRoute`: the default-OFF `feature#accounts`
  // flag is checked FIRST — its read doubles as the kill switch — and a
  // dark probe buys one flag read and the collapsed 403; the
  // anonymous-surface pin in the deployment's security tests names both routes.
  'POST /v1/discovery/lookup': discoveryLookupRoute,
  'POST /v1/identifiers/email/discoverable': setDiscoverableRoute,
  // Reachability, unauthenticated on purpose: `tacendum doctor` must be able
  // to prove the network path with DEAD credentials. Both adapters answer
  // it, so the route the CLI documents can never 404. No handler indirection —
  // a health check that can fail for a reason of its own is not one.
  'GET /health': async () => ({
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: '{"ok":true}',
  }),
};

let cachedHttpDeps: ReturnType<typeof makeAwsDeps> | undefined;

function makeHttpDeps(): ReturnType<typeof makeAwsDeps> {
  return (cachedHttpDeps ??= Object.assign(Object.create(makeAwsDeps()), {
    callMetrics: makeAwsCallMetrics(),
  }));
}

function toHttpEvent(event: APIGatewayProxyEventV2): HttpEvent {
  const { http } = event.requestContext;
  return {
    method: http.method,
    path: http.path,
    headers: event.headers ?? {},
    pathParameters: event.pathParameters ?? {},
    body:
      event.isBase64Encoded && event.body
        ? Buffer.from(event.body, 'base64').toString('utf8')
        : (event.body ?? null),
    sourceIp: http.sourceIp,
  };
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const deps = makeHttpDeps();
  const route = routes[event.routeKey];
  if (!route) {
    return {
      statusCode: 404,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ error: { code: 'not_found', detail: event.routeKey } }),
    };
  }

  const httpEvent = toHttpEvent(event);
  // Same ceiling the local host enforces on the stream: without it a
  // multi-megabyte body sails through API Gateway, passes the unbounded-string
  // zod fields, and dies at DynamoDB's item limit as a 500 instead of a 413.
  if (httpEvent.body && Buffer.byteLength(httpEvent.body, 'utf8') > MAX_BODY_BYTES) {
    // An accounts-program route answers even THIS probe with the collapsed
    // refusal: the pre-dispatch 413 was a
    // flag-independent "this accounts route is wired" discriminator on a
    // dark deploy. The handler is still never invoked — only the refusal's
    // shape joins the collapse; non-accounts routes keep the diagnosable 413.
    if (isAccountsCollapsedRoute(route)) {
      const refusal = accountsRefusal();
      return {
        statusCode: refusal.statusCode,
        headers: refusal.headers ?? {},
        body: refusal.body ?? '',
      };
    }
    return {
      statusCode: 413,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        error: { code: 'invalid_request', detail: 'request body too large' },
      }),
    };
  }

  try {
    const result = await route(httpEvent, deps);
    return {
      statusCode: result.statusCode,
      headers: result.headers ?? {},
      body: result.body ?? '',
    };
  } catch (err) {
    // Never leak request bodies / payloads in error output — only
    // the route and the error class name (the aws/deps.ts pattern), so a
    // least-privilege AccessDenied or DynamoDB validation failure stays
    // diagnosable from the log line alone.
    // log.error, not deps.log: `Deps.log` is the handlers' seam and is wired to
    // log.info, so routing a 500 through it put every REST failure on stdout at
    // level "info" while the WebSocket adapters used level "error". An operator
    // filtering on level=error saw none of them. Adapter-owned error paths log
    // directly, exactly as ws.lambda.ts and the local host already do.
    log.error('handler_error', {
      route: event.routeKey,
      error: err instanceof Error ? err.name : 'unknown',
    });
    return {
      statusCode: 500,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ error: { code: 'internal', detail: 'internal error' } }),
    };
  }
}
