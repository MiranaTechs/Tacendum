import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import {
  authChallengeHandler,
  authHandler,
  sourceOfferUrl,
  withSourceOffer,
} from '../handlers/auth-account.js';
import {
  deviceRevokeRoute,
  deviceUnlinkRoute,
  linkAcceptRoute,
  linkOfferSubmitRoute,
} from '../handlers/devices-signed.js';
import { accountsRefusal, isAccountsCollapsedRoute } from '../handlers/devices.js';
import { recoveryCompleteRoute } from '../handlers/recovery-signed.js';
import { MAX_BODY_BYTES, type Handler, type HttpEvent, type HttpResult } from '../handlers/http.js';
import { log } from '../log.js';
import { makeAuthDeps } from './deps.js';

/**
 * AWS Lambda entrypoint for account authentication
 * *
 * WHY THIS IS A SEPARATE FUNCTION FROM `http.lambda.ts`.
 * Verifying an account challenge means calling libsignal server-side, and
 * `@signalapp/libsignal-client` carries a 21 MB native binary
 * (`prebuilds/linux-arm64/`, resolved at runtime by node-gyp-build — the
 * Lambdas are already arm64, so nothing is compiled). Putting that in the
 * shared HTTP function would tax the cold start of every route including the
 * hot message path. Auth is low-frequency; it pays for its own weight.
 *
 * The four SIGNED device-linking routes live here for the
 * same reason in the other direction: each one verifies a libsignal identity
 * signature, so "the signature decides the Lambda" (route
 * placement) puts them beside the binary rather than pulling the binary onto
 * the hot path. They are as low-frequency as auth itself — link ceremonies
 * and roster mutations, rate-bucketed from day one.
 *
 * permits this: it is libsignal performing a libsignal
 * primitive, not a re-implementation. The rule text was amended to say so
 * explicitly rather than leaving it to inference.
 *
 * Route keys below MUST match `authRoutes` in the deployment stack
 * exactly — API Gateway dispatches on the string, so a mismatch is a 404 that
 * no type checker will catch. Since the signed device routes landed, that
 * agreement is pinned mechanically by the AuthFn route-parity assertion in
 * the deployment stack's tests (both directions), not by care.
 *
 * Deps come from `makeAuthDeps`, NOT `makeAwsDeps`: the latter reads the
 * attachment-bucket configuration and fails fast without it, and this function
 * is deliberately not given it.
 */

// EXPORTED for exactly one consumer: the route-parity test in
// the deployment stack's tests, which pins this table against the CDK
// stack's authRoutes in both directions — the same route-parity
// discipline http.lambda.ts's table already carries, extended here when the
// signed device routes landed (a route wired locally but missing from the
// deployed stack would otherwise go unnoticed).
export const routes: Record<string, Handler> = {
  'POST /v1/auth/challenge': authChallengeHandler,
  'POST /v1/auth': authHandler,
  // Device linking, the four SIGNED legs (route
  // placement — the signature decides the Lambda): each verifies a libsignal
  // identity signature with the same `verifyIdentitySignature` the auth path
  // uses, so each rides beside the 21 MB libsignal binary that already lives
  // here. The signature-free INIT leg rides HttpFn (http.lambda.ts). Every
  // route is wrapped by `accountsRoute`: the default-OFF `feature#accounts`
  // flag is checked FIRST and OFF is the ONE collapsed byte-stream
  // (the dark deploy is dark by construction).
  'POST /v1/devices/link-offer/submit': linkOfferSubmitRoute,
  'POST /v1/devices/link-accept': linkAcceptRoute,
  'POST /v1/devices/unlink': deviceUnlinkRoute,
  'POST /v1/devices/revoke': deviceRevokeRoute,
  // Recovery completion: the ONE recovery leg that
  // verifies a libsignal identity signature — the recovering device's fresh
  // possession proof over the v2 audience-bound challenge preimage — so it
  // rides here beside the binary (route placement). The six
  // signature-free identifier/recovery legs ride HttpFn.
  'POST /v1/recovery/complete': recoveryCompleteRoute,
};

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

/**
 * The AGPL boundary for this host.
 *
 * EVERY response AuthFn returns goes through here, which is the whole point of
 * putting it at the adapter instead of at the handlers' exits. is owed to a
 * remote user of the service, and the caller who is rate limited, refused for a
 * bad signature, or handed a 500 is a remote user of it — so the 429, the 401,
 * the 404 for an unknown routeKey, the 413 for an oversized body and the 500
 * for a thrown handler all carry the offer, and no future exit added to
 * `auth-account.ts` can miss it by being forgotten.
 *
 * Safe to apply to everything this function returns. When AuthFn hosted only
 * the two routes, the function boundary and the obligation's boundary
 * were the same line; the signed device routes widened the
 * function without weakening either property: every route here serves a
 * remote user of the service (so the offer is owed, not merely harmless), and
 * because the wrapper rides EVERY response from this function uniformly —
 * 200s, 404s, 429s, and the accounts program's collapsed 403 alike — it can
 * never become a byte-level discriminator between refused cases (the
 * one-byte-stream discipline holds per host).
 */
function offered(result: HttpResult): APIGatewayProxyResultV2 {
  const withOffer = withSourceOffer(result, sourceOfferUrl());
  return {
    statusCode: withOffer.statusCode,
    headers: withOffer.headers ?? {},
    body: withOffer.body ?? '',
  };
}

function jsonError(statusCode: number, code: string, detail: string): APIGatewayProxyResultV2 {
  return offered({
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ error: { code, detail } }),
  });
}

export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  const route = routes[event.routeKey];
  if (!route) return jsonError(404, 'not_found', event.routeKey);

  const httpEvent = toHttpEvent(event);
  // Same ceiling the other hosts enforce: without it a multi-megabyte
  // body sails through API Gateway and dies deeper as a 500 instead of a 413.
  if (httpEvent.body && Buffer.byteLength(httpEvent.body, 'utf8') > MAX_BODY_BYTES) {
    // An accounts-program route answers even THIS probe with the collapsed
    // refusal: the pre-dispatch 413 was a
    // flag-independent "this accounts route is wired" discriminator on a dark
    // deploy — a dark deploy promises ONE byte-stream to every probe,
    // well-formed or garbage, and an oversized body is a probe. The handler
    // is still never invoked, so the size ceiling protects the route exactly
    // as before; only the refusal's shape joins the collapse. Non-accounts
    // routes keep the diagnosable 413.
    if (isAccountsCollapsedRoute(route)) return offered(accountsRefusal());
    return jsonError(413, 'invalid_request', 'request body too large');
  }

  try {
    const result = await route(httpEvent, makeAuthDeps());
    return offered(result);
  } catch (err) {
    // Route and error class only — never bodies, keys, or signatures.
    // log.error rather than deps.log for the same reason http.lambda.ts does:
    // Deps.log is wired to info, and adapter-owned failures belong at error.
    log.error('auth_handler_error', {
      route: event.routeKey,
      error: err instanceof Error ? err.name : 'unknown',
    });
    return jsonError(500, 'internal', 'internal error');
  }
}
