import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import type { ServerFrame } from '@tacendum/shared';
import type { Deps } from '../handlers/http.js';
import { deliverPushWake } from '../handlers/push-worker.js';
import { makeSessionGuard } from '../handlers/session-guard.js';
import { log } from '../log.js';
import {
  DRAIN_SLICE_BUDGET,
  drainQueuedMessages,
  wsConnectHandler,
  wsDefaultHandler,
  wsDisconnectHandler,
  type WsDeps,
  type WsSender,
} from '../handlers/ws.js';

/**
 * Local WebSocket adapter: terminates `ws` sockets and translates
 * socket lifecycle into Lambda-shaped $connect/$disconnect/$default calls.
 * The handlers never import this file. In AWS this whole file is replaced by
 * API Gateway WebSocket + a management-API-backed WsSender.
 */
/** Frame ceiling aligned with API Gateway's 32 KB WebSocket frame cap, so the
 * local adapter refuses exactly what the cloud transport would. The schema's
 * 30 000-char base64 payload cap keeps every legal envelope inside this. */
const WS_MAX_PAYLOAD_BYTES = 32 * 1024;

export function startWsServer(port: number, baseDeps: Deps): Server {
  const httpServer = createServer();
  const wss = new WebSocketServer({
    server: httpServer,
    path: '/ws',
    maxPayload: WS_MAX_PAYLOAD_BYTES,
  });

  // connectionId -> live socket (the local stand-in for the management API).
  const sockets = new Map<string, WebSocket>();
  // connectionId -> authenticated userId (API GW authorizer context stand-in).
  const users = new Map<string, string>();
  // connectionId -> the digest of the session that opened it. The AWS host
  // re-reads this from the cached authorizer context each frame; this adapter
  // has no such context, so it remembers what $connect resolved and attaches it
  // to the socket's $default frames itself.
  const digests = new Map<string, string>();
  // connectionId -> the drain `$connect` asked for, PARKED until that connect
  // has finished arbitrating the connection row. See `scheduleDrain` below for
  // the message-loss window that running it any earlier opens on this host.
  const pendingDrains = new Map<string, () => Promise<void>>();

  const sender: WsSender = {
    async post(connectionId, frame: ServerFrame) {
      const socket = sockets.get(connectionId);
      if (!socket || socket.readyState !== WebSocket.OPEN) return false;
      return new Promise<boolean>((resolve) => {
        socket.send(JSON.stringify(frame), (err) => resolve(!err));
      });
    },
  };

  // Best-effort transport disconnect: the local twin of API Gateway
  // DeleteConnection. Installed onto the SHARED deps object so the HTTP
  // adapter's session/account-revoke handlers — which run in this same process
  // over the same deps — can hang up a live socket the moment they revoke it.
  // 4001 'unauthorized', because a revoked session's remedy is to sign in
  // again, which is exactly what that close code routes both clients to.
  baseDeps.disconnectSocket = async (connectionId: string) => {
    sockets.get(connectionId)?.close(4001, 'session revoked');
  };

  // The per-frame session guard over this process's own DataLayer.
  // Hoisted out of the deps literal because the drain loop below passes it
  // into each slice too — the guard never caches a positive verdict, so both
  // uses observe a revoke as soon as it commits (session-guard.ts).
  const sessionGuard = makeSessionGuard(baseDeps.db);

  /**
   * The whole queue, sliced to completion, into one live socket.
   *
   * Sliced through the same budgeted machinery the AWS drain Lambda runs
   * (S2b), resumed by cursor until complete — this host has no invocation
   * timeout, so completion is preserved exactly (the CLI's `send --drain`
   * and `sync` consume their whole queue over one connect), while every
   * local e2e run exercises the budget-and-cursor path production relies
   * on. The stall guard is paranoia: a budget_exhausted result always
   * carries a cursor past at least one newly posted message.
   *
   * The socket's bound session rides into every slice, so a local
   * drain re-validates it at each slice entry and on the in-slice cadence —
   * the mirror of the AWS drain Lambda's head check and continuations. A
   * session_revoked outcome falls out of the loop with the queue intact.
   *
   * A dead-socket result needs no cleanup here: the socket's own close event
   * runs $disconnect, which removes the row.
   */
  const runDrain = async (
    userId: string,
    connectionId: string,
    sessionDigest: string | undefined,
  ): Promise<void> => {
    let afterMsgId: string | undefined;
    for (;;) {
      const result = await drainQueuedMessages(
        userId,
        connectionId,
        { db: baseDeps.db, sender, now: baseDeps.now, log: baseDeps.log },
        DRAIN_SLICE_BUDGET,
        afterMsgId,
        sessionDigest !== undefined ? { guard: sessionGuard, digest: sessionDigest } : undefined,
      );
      if (result.outcome !== 'budget_exhausted' || result.cursor === afterMsgId) return;
      afterMsgId = result.cursor;
    }
  };

  const deps: WsDeps = {
    ...baseDeps,
    sender,
    sessionGuard,
    // SCHEDULE, DO NOT DRAIN — and on this host that distinction is a whole
    // class of lost message.
    // `wsConnectHandler` calls this BEFORE it arbitrates the connection row,
    // deliberately (see the contract on WsDeps.scheduleDrain). On AWS that is
    // free: the call only enqueues an async Lambda, and the drain that Lambda
    // eventually runs first polls the management API until the handshake
    // completes — which cannot happen until $connect has returned, which
    // cannot happen until the row is written. The queue snapshot is therefore
    // taken strictly AFTER the row is visible to the send path, and every
    // message is delivered by exactly one of the two paths.
    // This adapter used to run the whole drain inline right here, which
    // INVERTED that order: the snapshot was taken before the row existed. A
    // message enqueued in the gap — from the drain's last page to
    // `claimConnection` committing, which on a real store is several round
    // trips (read the incumbent, probe it, claim, consistent re-read) — was
    // delivered by NEITHER path. The send path read no connection row, so it
    // queued the frame and told the sender 'sent'; the drain had already
    // walked past the queue's tail and never ran again, because nothing
    // re-drains without another $connect. The frame then sat in the recipient's
    // queue for its full 30-day TTL behind a 'sent' receipt. Measured once at a
    // 15 ms gap against DynamoDB Local; the CLI's own connect is the peer that
    // hit it.
    // So the drain is PARKED here and run by the connect path below, once the
    // row it was racing has been claimed and the connect has answered 200.
    // Ordering after that is safe in both directions: anything enqueued before
    // the claim is in the queue the drain then reads, and anything enqueued
    // after it routes live to this connectionId. A frame that lands in both is
    // posted twice, which is the case the protocol is already built for — a
    // drained row is deleted only by the client's ack so clients
    // dedupe by msgId and every reconnect replays an unacked prefix anyway.
    scheduleDrain: async (userId, connectionId, sessionDigest) => {
      pendingDrains.set(connectionId, () => runDrain(userId, connectionId, sessionDigest));
    },
    // Same reasoning as the drain: a local process has no execution
    // environment that can freeze mid-flight, so the single shared worker
    // runs inline. In AWS this is an async Lambda invoke instead.
    // Every parameter named, for the reason spelled out on `pushSchedulerFor`
    // in the AWS adapter: a narrower arrow typechecks here and silently
    // discards `kind` and `message`, which turns every message notification
    // into a VoIP call wake.
    schedulePush: async (recipientId, senderUserId, kind, message, verify, wakeId) => {
      const event = {
        recipientId,
        senderUserId,
        ...(kind ? { kind } : {}),
        ...(message ? { message } : {}),
        ...(verify ? { verify } : {}),
        // This host cannot duplicate a wake — it awaits the worker inline,
        // exactly once — so nothing here needs the id. It carries it anyway:
        // a field present on one arm of a deliberate twin and absent on the
        // other is how the arms drift, and the next change built on "both
        // schedulers carry X" is then wrong on one host.
        ...(wakeId ? { wakeId } : {}),
      };
      if (verify) {
        // A verify wake SLEEPS out the ack grace inside the worker. Awaiting
        // it here would stall the send path for the whole grace — the one
        // thing says this path must never do. Detached instead: a local
        // process has no execution environment that can freeze mid-flight,
        // which was the only reason the other wakes are awaited.
        void deliverPushWake(event, baseDeps);
        return;
      }
      await deliverPushWake(event, baseDeps);
    },
  };

  wss.on('connection', (socket, request) => {
    const connectionId = randomUUID();
    sockets.set(connectionId, socket);

    socket.on('error', (err) => {
      // A transport fault (e.g. an over-maxPayload frame) must not crash the
      // process; `ws` closes the socket itself (1009 for too-big) after this
      // fires. Only the error message is logged — never frame contents.
      baseDeps.log('ws_socket_error', { error: err.message });
    });

    const url = new URL(request.url ?? '/', 'http://localhost');
    // ONLY the ticket is forwarded. The transitional
    // `?token=` used to ride alongside it and is deleted on every host at
    // once, so this adapter and API Gateway keep accepting exactly the same
    // requests — an adapter that authenticated differently from production
    // would make the e2e gates prove something about a protocol nobody runs.
    const ticket = url.searchParams.get('ticket') ?? undefined;

    // Mirror API Gateway semantics: $connect completes before any $default is
    // routed. `connected` resolves to the authenticated userId (or null), and
    // both message handling and close cleanup await it so nothing races the
    // connection row that $connect writes.
    const connected: Promise<string | null> = (async () => {
      try {
        const result = await wsConnectHandler(
          {
            routeKey: '$connect',
            connectionId,
            queryStringParameters: {
              ...(ticket !== undefined ? { ticket } : {}),
            },
          },
          deps,
        );
        if (result.statusCode !== 200 || !result.userId) {
          // A refused connect drains nothing, which is also what AWS does with
          // one: API Gateway never establishes the socket, so the drain Lambda
          // it scheduled polls, finds the connection Gone, and returns having
          // posted nothing (ws-drain.lambda.ts). Posting into a socket this
          // adapter is about to close would be the divergence, not the parity.
          pendingDrains.delete(connectionId);
          // TWO DIFFERENT REFUSALS, and collapsing them was a real cost.
          //
          // API Gateway refuses the UPGRADE on any non-200 from $connect, so a
          // client there can tell 401 from 503 by status. This host has already
          // completed the upgrade by the time $connect runs, so the only channel
          // left is the close code — and every non-200 used to be delivered as
          // close(4001, 'unauthorized'). A 503 (the routing row is held by
          // another live connection; redial) then reached the CLI as a
          // credential rejection and bought a full re-authentication, and
          // reached the app as the one close code it spends its single auth
          // probe on. 1013 is RFC 6455's "Try Again Later", which is exactly
          // what a refused row claim means, and it routes both clients to a
          // plain backoff redial instead.
          socket.close(
            result.statusCode === 503 ? 1013 : 4001,
            result.statusCode === 503 ? 'try again later' : 'unauthorized',
          );
          return null;
        }
        users.set(connectionId, result.userId);
        // Remember the session that opened this socket so its later
        // $default frames carry the digest the recheck matches on.
        if (result.sessionDigest !== undefined) digests.set(connectionId, result.sessionDigest);
        // THE DRAIN, HERE — after $connect owns the connection row and answered
        // 200, never before it (see `scheduleDrain` above for the message this
        // ordering used to lose). Still inside the `connected` promise, so it
        // still completes before any queued $default work, exactly as the
        // inline drain did.
        const drain = pendingDrains.get(connectionId);
        pendingDrains.delete(connectionId);
        if (drain !== undefined) {
          try {
            await drain();
          } catch (err) {
            // A drain fault must not be answered by leaving a live socket
            // parked on an undrained queue: nothing re-drains without another
            // $connect, so the client has to be told to make one. Close, and
            // return the userId anyway so the close handler's $disconnect
            // still tears down the row this connect claimed — a refusal that
            // orphaned the row would deny the account its next dial.
            baseDeps.log('ws_drain_error', {
              error: err instanceof Error ? err.message : 'unknown',
            });
            socket.close(1011, 'internal error');
          }
        }
        return result.userId;
      } catch (err) {
        pendingDrains.delete(connectionId);
        baseDeps.log('ws_connect_error', { error: err instanceof Error ? err.message : 'unknown' });
        socket.close(1011, 'internal error');
        return null;
      }
    })();

    let chain: Promise<unknown> = connected;
    socket.on('message', (data) => {
      const body = data.toString();
      chain = chain.then(async () => {
        const senderUserId = users.get(connectionId);
        if (!senderUserId) return; // auth failed; socket is closing
        const sessionDigest = digests.get(connectionId);
        try {
          await wsDefaultHandler(
            {
              routeKey: '$default',
              connectionId,
              senderUserId,
              body,
              ...(sessionDigest !== undefined ? { sessionDigest } : {}),
            },
            deps,
          );
        } catch (err) {
          baseDeps.log('ws_default_error', { error: err instanceof Error ? err.message : 'unknown' });
        }
      });
    });

    socket.on('close', () => {
      // Run cleanup after connect settles (and after any queued frames drain),
      // so a close that races an in-flight $connect still tears down the row
      // that putConnection wrote — no orphaned connection, no leaked map entry.
      chain = chain.then(async () => {
        const senderUserId = await connected;
        sockets.delete(connectionId);
        users.delete(connectionId);
        digests.delete(connectionId);
        // Already gone on every path the connect above takes; deleted here too
        // so the map cannot outlive the socket if a future edit adds a fourth.
        pendingDrains.delete(connectionId);
        if (senderUserId) {
          try {
            await wsDisconnectHandler(
              { routeKey: '$disconnect', connectionId, senderUserId },
              deps,
            );
          } catch (err) {
            baseDeps.log('ws_disconnect_error', { error: err instanceof Error ? err.message : 'unknown' });
          }
        }
      });
    });
  });

  httpServer.listen(port, () => {
    const addr = httpServer.address();
    const bound = typeof addr === 'object' && addr ? addr.port : port;
    log.info('ws_listening', { port: bound });
  });
  return httpServer;
}
