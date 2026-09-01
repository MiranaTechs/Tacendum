import type { APIGatewayAuthorizerResult, APIGatewayRequestAuthorizerEvent } from 'aws-lambda';
import type { WsTicketRole } from '@tacendum/shared';
import { makeAwsDeps } from './deps.js';

/**
 * WebSocket $connect authorizer. Spends the single-use `?ticket=`
 * minted over HTTPS — the ONLY credential this route takes.
 * WebSocket APIs support only REQUEST authorizers with the IAM-policy response
 * shape (the `isAuthorized` simple response is HTTP-API-only and would 500
 * every $connect), so the decision is returned as an Allow/Deny policy for
 * this connect ARN. On Allow, API Gateway caches `context.userId` for the
 * connection's lifetime and attaches it to every route
 * ($connect/$default/$disconnect) as `requestContext.authorizer.userId`, so
 * the pure WS handlers receive `senderUserId` without a per-message DB lookup.
 *
 * THERE IS NO `?token=` BRANCH ANY MORE, and one must never come back. The
 * transitional bearer-in-the-URL path existed for exactly one deploy so a
 * running client would not be disconnected by the server updating first
 * no released client exists — v1.0 has not shipped, and
 * both clients dial ticket-first — so what remained was a 30-day credential
 * accepted from the one place proxies, access logs and crash reporters write
 * down. A dial presenting `?token=` now gets the same Deny as one presenting
 * nothing, because that is what it is: unauthenticated.
 */

function decision(
  effect: 'Allow' | 'Deny',
  resource: string,
  userId?: string,
  // The ticket's role, carried in the authorizer context for the same reason
  // userId is: this stage SPENDS the ticket, so $connect cannot look the row up
  // again, and the role must not be re-declared in the socket URL where nothing
  // could check it agreed with the one the client authenticated for.
  role?: WsTicketRole,
  // The digest of the session that opened this socket cached in the same
  // context alongside userId and role. API Gateway attaches it to every route,
  // so $connect writes it onto the connection row and $default matches its
  // per-frame recheck against it — neither costing a DB read to obtain it.
  sessionDigest?: string,
): APIGatewayAuthorizerResult {
  return {
    principalId: userId ?? 'unauthorized',
    policyDocument: {
      Version: '2012-10-17',
      Statement: [{ Action: 'execute-api:Invoke', Effect: effect, Resource: resource }],
    },
    ...(userId !== undefined
      ? {
          context: {
            userId,
            ...(role !== undefined ? { role } : {}),
            ...(sessionDigest !== undefined ? { sessionDigest } : {}),
          },
        }
      : {}),
  };
}

export async function handler(
  event: APIGatewayRequestAuthorizerEvent,
): Promise<APIGatewayAuthorizerResult> {
  const deps = makeAwsDeps();

  // THE single-use ticket minted over HTTPS. Spending it here
  // is what makes a captured URL worthless — by the time anyone reads it out
  // of a log the ticket is gone, and it never authorised anything else. An
  // absent or empty ticket is a Deny: there is nothing to fall through to.
  const ticket = event.queryStringParameters?.ticket;
  if (!ticket) return decision('Deny', event.methodArn);
  const spent = await deps.db.consumeWsTicket(ticket, Math.floor(deps.now() / 1000));
  // The scheme, never the ticket (log hygiene makes no exception for a value that
  // lives sixty seconds). One scheme now, still logged: it keeps the connect
  // metric continuous across the removal, and a `token` line reappearing in
  // this log is the alarm that the deleted branch has somehow come back. The
  // role rides along because this is the only place that knows it.
  if (spent) deps.log('ws_connect_auth', { scheme: 'ticket', role: spent.role });
  // A spent ticket with NO bound session digest is refused (digestless
  // fail-closed). v1.0 has not shipped and every mint binds the caller's
  // session, so a digestless ticket is not a legacy client — it would open a
  // socket that session revocation can never match, drain-refuse, or hang up.
  // The ticket is already spent either way (single-use above all).
  if (spent && spent.sessionDigest === undefined) {
    deps.log('ws_connect_refused_digestless');
    return decision('Deny', event.methodArn);
  }
  return spent
    ? decision('Allow', event.methodArn, spent.userId, spent.role, spent.sessionDigest)
    : decision('Deny', event.methodArn);
}
