import {
  WS_TICKET_TTL_SECONDS,
  WsTicketRequest,
  type WsTicketResponse,
  type WsTicketRole,
} from '@tacendum/shared';
import { LIMITS } from '../ratelimit.js';
import { sessionTokenDigest } from '../db/data.js';
import { bearerToken, errorResult, json, rateLimitedResult, type AuthedHandler, type HttpEvent } from './http.js';

/**
 * The role this dial is for, from the request body.
 *
 * Hand-rolled rather than `parseJson`, for one reason: an EMPTY body must mean
 * 'listen'. Every client shipped before roles existed POSTs this route with no
 * body at all, and `parseJson` answers 400 to `JSON.parse('')` — so using it
 * would refuse a ticket to the iOS app on somebody's phone, which updates when
 * its owner decides to and not when we deploy.
 *
 * A body that IS present and names something that is not a role gets a 400
 * rather than a silent demotion to 'listen'. A client that believes it asked
 * for a send-only socket and quietly got a listening one would displace its own
 * account's listener on every send, which is the defect roles exist to remove —
 * and it would do it invisibly. Wrong at develop time beats wrong at incident
 * time.
 */
function roleFrom(event: HttpEvent): { ok: true; role: WsTicketRole } | { ok: false; result: ReturnType<typeof errorResult> } {
  const body = event.body?.trim();
  if (!body) return { ok: true, role: 'listen' };
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return { ok: false, result: errorResult(400, 'invalid_request', 'body must be valid JSON') };
  }
  const parsed = WsTicketRequest.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, result: errorResult(400, 'invalid_request', 'role must be "listen" or "send"') };
  }
  return { ok: true, role: parsed.data.role ?? 'listen' };
}

/**
 * `POST /v1/ws-ticket` — mint a single-use ticket for one WebSocket dial
 * *
 * WHY THIS ROUTE EXISTS. The socket URL used to carry the caller's 30-day
 * bearer as `?token=`, and a URL is not a private place: query strings are
 * written to proxy logs, load-balancer and CloudWatch access logs, crash
 * reporters, and anything else that records what it forwarded. A month-long
 * credential in one of those is a slow leak with no expiry to stop it.
 *
 * A header would have been simpler and does not work where it matters: API
 * Gateway REQUEST authorizers can read headers, and the CLI's `ws` library can
 * set them, but the browser and React Native `WebSocket` constructors accept no
 * custom headers at all. A header scheme would have secured the CLI and left
 * the iOS app — the product — exactly where it started.
 *
 * So the credential stays in the `Authorization` header on THIS request, where
 * it belongs, and only the ticket goes in the URL. What ends up in a log is a
 * value that is already spent, was valid for a minute, and authorises nothing
 * anywhere else.
 *
 * Rate limited because it is a mint. Reusing the auth limiter's budget: this is
 * cheap, but an unbounded mint is an unbounded write.
 */
export const wsTicketHandler: AuthedHandler = async (event, deps, auth) => {
  const retry = await deps.rateLimit.take(`wsticket:${auth.userId}`, LIMITS.auth);
  if (retry > 0) return rateLimitedResult(retry);

  // The ROLE is decided here and stored on the ticket row, so `$connect` reads
  // it from server-held state. On AWS the authorizer spends the ticket before
  // $connect runs, so the role has to survive as part of the authorizer's
  // verdict; a role re-declared in the socket URL would be a second,
  // unauthenticated place the same fact is asserted, with no way to check that
  // the two agree.
  const role = roleFrom(event);
  if (!role.ok) return role.result;

  const ticket = deps.newAuthToken();
  const expiresAt = Math.floor(deps.now() / 1000) + WS_TICKET_TTL_SECONDS;
  // Bind the ticket — and so the socket it opens — to the SESSION making this
  // request. This runs under requireAuth, so a bearer is present by
  // construction; its digest is what revocation later matches on. Never the
  // token itself: the digest is all a match needs, and all this row or
  // the connection row is allowed to hold.
  const token = bearerToken(event);
  await deps.db.putWsTicket({
    ticket,
    userId: auth.userId,
    expiresAt,
    role: role.role,
    ...(token ? { sessionDigest: sessionTokenDigest(token) } : {}),
  });

  // No userId in the log line, and above all no ticket: it is a credential for
  // the sixty seconds it lives, and log hygiene does not make an exception for short
  // ones. The role IS logged — it is routing metadata, not a credential, and it
  // is the only way to see whether the one-shot clients have actually stopped
  // competing for the routing row after this ships.
  deps.log('ws_ticket_issued', { role: role.role });

  const body: WsTicketResponse = { ticket, expiresAt };
  return json(200, body);
};
