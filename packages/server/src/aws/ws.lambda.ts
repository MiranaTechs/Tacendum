import type { APIGatewayProxyWebsocketEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import type { WsTicketRole } from '@tacendum/shared';
import {
  wsConnectHandler,
  wsDefaultHandler,
  wsDisconnectHandler,
  type WsDeps,
} from '../handlers/ws.js';
import type { PushWakeEvent } from '../handlers/push-worker.js';
import { makeSessionGuard, type SessionGuard } from '../handlers/session-guard.js';
import { log } from '../log.js';
import { makeAwsDeps } from './deps.js';
import { disconnectorFor, senderFor } from './gateway.js';
import type { WsDrainEvent } from './ws-drain.lambda.js';

/**
 * AWS Lambda entrypoint for the WebSocket API. Maps API Gateway
 * WebSocket route events ($connect/$disconnect/$default) to the SAME pure WS
 * handlers, with a `WsSender` backed by the API Gateway Management API — the
 * cloud equivalent of the local adapter's live-socket map. Handlers unchanged.
 *
 * The authenticated userId comes from the $connect Lambda authorizer's context
 * (`requestContext.authorizer.userId`), cached by API Gateway for the whole
 * connection and attached to every route.
 *
 * $connect must never post: API Gateway establishes the connection only after
 * the $connect integration completes, so PostToConnection from this route 410s
 * on every reconnect. The queue drain is instead delegated to the ws-drain
 * Lambda via an async (Event) invoke carrying only non-secret routing facts —
 * the bearer token stays on the connect event and is never forwarded.
 */

const lambda = new LambdaClient({});

/**
 * The session-recheck cache module-scoped so its per-minute window
 * actually spans warm invocations rather than resetting every call — the same
 * reason the management clients and rate limiter are cached. Built lazily off
 * the shared deps' DataLayer.
 */
let cachedSessionGuard: SessionGuard | undefined;
function sessionGuardFor(): SessionGuard {
  cachedSessionGuard ??= makeSessionGuard(makeAwsDeps().db);
  return cachedSessionGuard;
}

function drainSchedulerFor(
  domainName: string,
  stage: string,
): (userId: string, connectionId: string, sessionDigest?: string) => Promise<void> {
  return async (userId, connectionId, sessionDigest) => {
    const functionName = process.env.WS_DRAIN_FUNCTION_NAME;
    // Fail the $connect loudly instead of leaving the queue silently undrained.
    if (!functionName) throw new Error('WS_DRAIN_FUNCTION_NAME is not set');
    // Carry the socket's bound session digest so the drain can refuse a
    // revoked socket, and so its self-scheduled continuations (S2b/#5) re-check
    // it. Omitted for a legacy dial with no digest.
    const payload: WsDrainEvent = {
      userId,
      connectionId,
      domainName,
      stage,
      ...(sessionDigest !== undefined ? { sessionDigest } : {}),
    };
    // Awaited: the Event invoke returns as soon as Lambda queues it, and the
    // execution environment can freeze right after our response otherwise.
    await lambda.send(
      new InvokeCommand({
        FunctionName: functionName,
        InvocationType: 'Event',
        Payload: Buffer.from(JSON.stringify(payload)),
      }),
    );
  };
}

/**
 * Async-invoke the push worker. Mirrors drainSchedulerFor exactly, with one
 * deliberate difference: a missing function name here does NOT throw. The
 * drain guards a promise about message DELIVERY, so failing loudly is right;
 * this guards only whether a call rings early, and taking down the message
 * path over it would invert the priority the whole design rests on.
 */
/**
 * TYPED AS THE FULL SIGNATURE ON PURPOSE.
 *
 * This used to return a two-parameter arrow, and TypeScript accepts a function
 * that ignores trailing parameters wherever a wider one is expected — so it
 * typechecked, and every `kind` and `message` the handler passed was dropped
 * on the floor. `deliverPushWake` then saw `kind === undefined`, which means
 * 'call' for backward compatibility, and took the VoIP branch for ordinary
 * text messages. The visible result: no message notification was EVER sent in
 * production, the notification-service extension never launched because
 * `mutable-content` only exists on the alert branch, and a device that held a
 * VoIP token rang CallKit — a full incoming-call screen — for a text message.
 *
 * Naming every parameter is what makes the compiler able to notice next time.
 */
function pushSchedulerFor(): (
  recipientId: string,
  senderUserId: string,
  kind?: PushWakeEvent['kind'],
  message?: PushWakeEvent['message'],
  verify?: PushWakeEvent['verify'],
  wakeId?: PushWakeEvent['wakeId'],
) => Promise<void> {
  return async (recipientId, senderUserId, kind, message, verify, wakeId) => {
    const functionName = process.env.PUSH_FUNCTION_NAME;
    if (!functionName) return;
    const payload: PushWakeEvent = {
      recipientId,
      senderUserId,
      ...(kind ? { kind } : {}),
      ...(message ? { message } : {}),
      ...(verify ? { verify } : {}),
      // Dropping this one would not ring CallKit for a text message — it
      // would quietly revert the worker to its pre-fix behaviour, because
      // absence means "ring, no dedup" by design. Silent regressions are why
      // every parameter here is named, and why the wire bytes are pinned.
      ...(wakeId ? { wakeId } : {}),
    };
    // Awaited: the Event invoke returns as soon as Lambda queues the work, and
    // the execution environment can freeze right after our response otherwise.
    await lambda.send(
      new InvokeCommand({
        FunctionName: functionName,
        InvocationType: 'Event',
        Payload: Buffer.from(JSON.stringify(payload)),
      }),
    );
  };
}

function authorizerContext(
  event: APIGatewayProxyWebsocketEventV2,
): { userId?: string; role?: string; sessionDigest?: string } | undefined {
  return (
    event.requestContext as {
      authorizer?: { userId?: string; role?: string; sessionDigest?: string };
    }
  ).authorizer;
}

function userIdFrom(event: APIGatewayProxyWebsocketEventV2): string | undefined {
  return authorizerContext(event)?.userId || undefined;
}

/** The session digest API Gateway cached in the authorizer context,
 * attached to every route for the connection's life — the socket→session bind
 * $connect writes and $default rechecks against, with no DB read to obtain. */
function sessionDigestFrom(event: APIGatewayProxyWebsocketEventV2): string | undefined {
  return authorizerContext(event)?.sessionDigest || undefined;
}

/**
 * The ticket role the authorizer resolved, cached by API Gateway for the whole
 * connection alongside the principal.
 *
 * Anything that is not exactly 'send' is 'listen' — the behaviour every client
 * had before roles existed. That covers the bearer path (no ticket, so no role
 * in the context) and a connection authorized by the previous deploy's
 * authorizer, and it fails in the direction that keeps a listener listening
 * rather than one that silently stops routing to it.
 */
function roleFrom(event: APIGatewayProxyWebsocketEventV2): WsTicketRole {
  return authorizerContext(event)?.role === 'send' ? 'send' : 'listen';
}

export async function handler(
  event: APIGatewayProxyWebsocketEventV2,
): Promise<APIGatewayProxyResultV2> {
  const { routeKey, connectionId, stage } = event.requestContext;

  // The MANAGEMENT host, which is not necessarily the host the client dialled.
  //
  // `requestContext.domainName` is whatever the client connected to — and this
  // API is fronted by the custom domain `ws.tacendum.com`, mapped at the ROOT
  // with no stage in its path. Building the management endpoint from it gives
  // `https://ws.tacendum.com/prod`, so every call goes to `/prod/@connections/…`
  // and IAM evaluates the resource as `<api>/prod/POST/prod/@connections/*` —
  // the stage twice. The grant says `<api>/prod/POST/@connections/*`, so every
  // post and every GetConnection was denied.
  //
  // Nothing failed loudly. The drain Lambda's AccessDeniedException is caught
  // as a drain failure, the queue is left intact for "the next reconnect", and
  // the sender's messages simply never arrive. It survived every test because
  // the local adapter has no API Gateway and the CLI e2e never uses one; it
  // took two real phones to see it.
  //
  // The execute-api host is unambiguous and independent of any custom-domain
  // mapping, so it is what the management client is built from.
  const region = process.env.AWS_REGION ?? 'us-east-1';
  const managementDomain = `${event.requestContext.apiId}.execute-api.${region}.amazonaws.com`;

  const deps: WsDeps = {
    ...makeAwsDeps(),
    sender: senderFor(managementDomain, stage),
    scheduleDrain: drainSchedulerFor(managementDomain, stage),
    schedulePush: pushSchedulerFor(),
    // The per-frame session recheck and the socket hang-up it triggers.
    // Both are built from THIS api's management endpoint — the same one that
    // already holds the ManageConnections grant (which covers DeleteConnection)
    // so the WS function needs no new infra to enforce revocation on a
    // surviving socket.
    sessionGuard: sessionGuardFor(),
    disconnectSocket: disconnectorFor(managementDomain, stage),
  };

  try {
    switch (routeKey) {
      case '$connect': {
        // The authorizer has ALREADY authenticated this connect — API Gateway
        // will not reach this integration otherwise — and in doing so it spent
        // the single-use ticket. So the principal is carried across rather than
        // recomputed: looking the ticket up again here would find the row the
        // authorizer just deleted and refuse a connection API Gateway had
        // already allowed, making every ticket good for zero connections.
        //
        // The same `authorizer.userId` that $default and $disconnect read; this
        // route simply used to ignore it and re-derive the answer from the URL.
        const authorizedUserId = userIdFrom(event);
        if (!authorizedUserId) return { statusCode: 401 };
        const authorizedSessionDigest = sessionDigestFrom(event);
        const result = await wsConnectHandler(
          {
            routeKey: '$connect',
            connectionId,
            authorizedUserId,
            authorizedRole: roleFrom(event),
            ...(authorizedSessionDigest !== undefined ? { authorizedSessionDigest } : {}),
          },
          deps,
        );
        return { statusCode: result.statusCode };
      }
      case '$disconnect': {
        const senderUserId = userIdFrom(event);
        if (senderUserId) {
          await wsDisconnectHandler({ routeKey: '$disconnect', connectionId, senderUserId }, deps);
        }
        return { statusCode: 200 };
      }
      default: {
        const senderUserId = userIdFrom(event);
        if (!senderUserId) return { statusCode: 401 };
        const frameSessionDigest = sessionDigestFrom(event);
        const result = await wsDefaultHandler(
          {
            routeKey: '$default',
            connectionId,
            senderUserId,
            body: event.body ?? '',
            ...(frameSessionDigest !== undefined ? { sessionDigest: frameSessionDigest } : {}),
          },
          deps,
        );
        return { statusCode: result.statusCode };
      }
    }
  } catch (err) {
    // Never log frame bodies / payloads — only the route + error name.
    log.error('ws_lambda_error', {
      routeKey,
      error: err instanceof Error ? err.name : 'unknown',
    });
    return { statusCode: 500 };
  }
}
