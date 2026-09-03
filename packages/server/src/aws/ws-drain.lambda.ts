import { GetConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { DRAIN_SLICE_BUDGET, drainQueuedMessages } from '../handlers/ws.js';
import { makeSessionGuard, type SessionGuard } from '../handlers/session-guard.js';
import { log } from '../log.js';
import { makeAwsDeps } from './deps.js';
import { disconnectorFor, managementClientFor, senderFor } from './gateway.js';

/** One client, cached across warm invocations, for the self-invoke that
 * continues a drain past its per-invocation budget (S2b/#5). */
const lambda = new LambdaClient({});

/** The session guard, module-scoped like the clients so its negative
 * cache spans warm invocations: a revoked socket's continuations are refused
 * without re-reading. Positives are never cached (session-guard.ts), so the
 * head check and the in-slice cadence both observe a committed revoke. */
let cachedSessionGuard: SessionGuard | undefined;
function sessionGuardFor(db: ReturnType<typeof makeAwsDeps>['db']): SessionGuard {
  cachedSessionGuard ??= makeSessionGuard(db);
  return cachedSessionGuard;
}

/**
 * Post-connect queue drain. API Gateway does not establish a
 * WebSocket connection until the $connect integration completes, so the
 * $connect Lambda must never call PostToConnection — it async-invokes this
 * child instead (ws.lambda.ts). This function can therefore start BEFORE the
 * handshake finishes: it polls GetConnection with bounded backoff until the
 * connection exists, then replays the queue with the same drainQueuedMessages
 * logic the local adapter uses.
 *
 * The event carries only non-secret routing facts — never the bearer token;
 * this Lambda authenticates nothing and acts only on the already-authorized
 * connection recorded by $connect.
 */
export interface WsDrainEvent {
  userId: string;
  connectionId: string;
  domainName: string;
  stage: string;
  /**
   * Resume cursor (S2b/#5): the last msgId the previous slice POSTED. A drain
   * that exhausts its per-invocation budget self-invokes with this set so the
   * next slice starts exactly after it, instead of the tail waiting on a
   * reconnect that a healthy long-lived socket never makes. Absent on the
   * first invocation ($connect's schedule) — the drain starts at the head.
   */
  afterMsgId?: string;
  /**
   * The digest of the session that opened this socket, carried from
   * $connect so the drain — which otherwise holds NO auth material — can refuse
   * to keep feeding a socket whose session was revoked or expired. A passive
   * socket that never sends never trips the $default recheck, so without this
   * the drain (and its self-scheduled continuations) would deliver to it
   * forever. Absent on a legacy dial, which stays unvalidated.
   */
  sessionDigest?: string;
}

/** Backoff before each GetConnection retry; ~4.7 s worst case leaves most of
 * the timeout for the drain itself. Bounded: a client that never completes the
 * handshake keeps its queue intact for the next $connect to reschedule. */
export const CONNECT_RETRY_DELAYS_MS = [150, 300, 600, 1200, 2400];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** True once API Gateway reports the connection; false while it is still (or
 * again) Gone. Non-Gone failures throw — the async-invoke retry handles them. */
async function connectionEstablished(
  client: ReturnType<typeof managementClientFor>,
  connectionId: string,
): Promise<boolean> {
  try {
    await client.send(new GetConnectionCommand({ ConnectionId: connectionId }));
    return true;
  } catch (err) {
    if (err instanceof Error && err.name === 'GoneException') return false;
    throw err;
  }
}

/** Kept ahead of the deadline so the last post and this function's own exit
 * finish inside the invocation instead of being killed mid-flight. */
const DRAIN_DEADLINE_SAFETY_MS = 2_000;

export async function handler(
  event: WsDrainEvent,
  // The Lambda context. Optional and structurally typed so nothing here
  // depends on aws-lambda types and existing direct callers stay valid; when
  // present, the remaining-time clock becomes the drain's hard deadline.
  context?: { getRemainingTimeInMillis?: () => number },
): Promise<void> {
  const { userId, connectionId, domainName, stage, afterMsgId, sessionDigest } = event;
  if (!userId || !connectionId || !domainName || !stage) {
    // Never invoked this way by our $connect adapter; drop rather than retry.
    log.error('ws_drain_bad_event', {});
    return;
  }

  const { db, now } = makeAwsDeps();

  // #4 — the drain carries the socket's bound session and validates it BEFORE
  // delivering anything (and on every self-scheduled continuation, since each
  // continuation re-enters here). If that session is gone or expired the socket
  // is revoked: stop, deliver nothing, schedule no continuation, and tear the
  // socket down. A passive socket that never sends never fires the $default
  // recheck, so this — plus the in-slice cadence below — is what stops the
  // drain from feeding a revoked socket its backlog. An event with NO digest
  // fails CLOSED the same way: v1.0 has not shipped, every dial binds a
  // session, so a digestless drain is not a legacy socket to protect — it is
  // a socket the session machinery cannot revoke, and it must not be fed.
  const guard = sessionGuardFor(db);
  if (sessionDigest === undefined || !(await guard.active(sessionDigest, now()))) {
    // Routing metadata only — never the digest, the user, or the connection.
    log.info(
      sessionDigest === undefined ? 'ws_drain_refused_digestless' : 'ws_drain_session_revoked',
      {},
    );
    // Belt to the revoke's braces: drop the routing row (conditional on this
    // connectionId, so a fresh reconnect's row survives) and hang the socket
    // up — the proactive disconnect may be in-flight, throttled, or unwired.
    await db.deleteConnection(userId, connectionId);
    try {
      await disconnectorFor(domainName, stage)(connectionId);
    } catch {
      log.info('ws_disconnect_on_revoke_failed', {});
    }
    return;
  }

  const client = managementClientFor(domainName, stage);
  let established = await connectionEstablished(client, connectionId);
  for (const delayMs of CONNECT_RETRY_DELAYS_MS) {
    if (established) break;
    await sleep(delayMs);
    established = await connectionEstablished(client, connectionId);
  }
  if (!established) {
    // Handshake never completed within the probe budget — or the client
    // already left. Not an error: the queue is untouched and the next
    // $connect schedules a fresh drain. The connection row is deliberately
    // NOT deleted: a slow handshake can still establish after the budget, and
    // deleting the row then would blackhole a live socket. A truly dead row
    // costs nothing — the table keeps one row per user, the next reconnect
    // overwrites it, and a failed post reaps it once it is older than
    // CONNECTION_REAP_GRACE_MS.
    log.info('ws_drain_connection_gone', {});
    return;
  }

  // One budgeted slice per invocation (S2b): item and byte ceilings from
  // DRAIN_SLICE_BUDGET, and — when the host provides its clock — a hard
  // deadline safely inside the Lambda timeout, so a huge backlog ends this
  // invocation CLEANLY with a delivered prefix instead of being killed
  // mid-post and repeating at full length. The slice resumes from `afterMsgId`:
  // the previous invocation's cursor, so a continuation picks up
  // exactly where its budget stopped.
  const remainingMs = context?.getRemainingTimeInMillis?.();
  // Forward progress: this invocation is ALREADY inside its safety margin: its
  // deadline would compute to now (or the past), yet drainQueuedMessages still
  // queries the first page and posts its first live row UNCONDITIONALLY — the
  // forward-progress contract binds the ITEM budget, not the clock, and the
  // per-row deadline check is disabled until one row has been examined. A
  // handler with no time must post NOTHING: hand the whole slice — the
  // UNCHANGED afterMsgId, no progress claimed — to a fresh invocation with a
  // full clock, exactly as a mid-slice budget exhaustion hands off its cursor.
  // A cold async invoke enters with ~the full timeout, so this only fires for a
  // continuation scheduled so late it lands past the margin, and it cannot spin
  // — the fresh invoke it schedules is not itself inside the margin. Runs after
  // the session check (a revoked socket already returned) and after the
  // handshake wait (an unestablished socket already returned), so a bounce here
  // means only "the socket is up and I have no time left to feed it".
  if (remainingMs !== undefined && remainingMs <= DRAIN_DEADLINE_SAFETY_MS) {
    await scheduleContinuation({
      userId,
      connectionId,
      domainName,
      stage,
      ...(afterMsgId !== undefined ? { afterMsgId } : {}),
      ...(sessionDigest !== undefined ? { sessionDigest } : {}),
    });
    log.info('ws_drain_deadline_at_entry', {});
    return;
  }
  const budget = {
    ...DRAIN_SLICE_BUDGET,
    ...(remainingMs !== undefined
      ? { deadlineMs: now() + Math.max(0, remainingMs - DRAIN_DEADLINE_SAFETY_MS) }
      : {}),
  };
  const drained = await drainQueuedMessages(
    userId,
    connectionId,
    // `log` carries the drain's own best-effort events (a delivered receipt
    // the sender's socket refused) — routing metadata only, rule 4.
    { db, sender: senderFor(domainName, stage), now, log: (event, fields) => log.info(event, fields) },
    budget,
    afterMsgId,
    sessionDigest !== undefined ? { guard, digest: sessionDigest } : undefined,
  );
  if (drained.outcome === 'socket_gone') {
    // A post hit a Gone socket mid-drain: same stale-row cleanup, same
    // conditional guard. The undelivered queue waits for the next reconnect.
    await db.deleteConnection(userId, connectionId);
    return;
  }
  if (drained.outcome === 'session_revoked') {
    // The in-slice cadence observed a mid-drain revoke: stop feeding
    // the socket, tear its row down (conditional, sparing a reconnect) and
    // hang it up. No continuation — the queue waits for a re-authenticated
    // login. Bounded at ~DRAIN_SESSION_RECHECK_MS of extra receiving.
    await db.deleteConnection(userId, connectionId);
    try {
      await disconnectorFor(domainName, stage)(connectionId);
    } catch {
      log.info('ws_disconnect_on_revoke_failed', {});
    }
    log.info('ws_drain_session_revoked', {});
    return;
  }
  if (drained.outcome === 'budget_exhausted') {
    // #5 — the queue has more than one slice, and a bounded prefix must not be
    // able to hide the tail. The previous design carried NO cursor and leaned
    // on the client acking the prefix and RECONNECTING to continue — but a
    // healthy long-lived socket never reconnects, so 2000 decoy frames ahead of
    // a real message left that message undelivered indefinitely. Self-schedule
    // the next slice from the cursor, carrying the same validated session so it
    // is re-checked, until the queue completes or the socket is gone.
    //
    // The delivered-prefix telemetry is emitted BEFORE the continuation attempt
    // (counts only — never ids, never payload), so a continuation that
    // fails and now RETHROWS still leaves this slice's record.
    log.info('ws_drain_budget_exhausted', {
      postedItems: drained.postedItems,
      postedBytes: drained.postedBytes,
    });
    await scheduleContinuation({
      userId,
      connectionId,
      domainName,
      stage,
      // A cursor-less exhaustion (the budget bound before any
      // row of a fresh drain) hands the WHOLE queue on, exactly as the
      // deadline-at-entry bounce above does.
      ...(drained.cursor !== undefined ? { afterMsgId: drained.cursor } : {}),
      ...(sessionDigest !== undefined ? { sessionDigest } : {}),
    });
  }
}

/**
 * Self-invoke this same drain Lambda to continue past a per-invocation budget.
 * Async (Event) invoke under this function's OWN name — set by the
 * Lambda runtime as AWS_LAMBDA_FUNCTION_NAME, so no config wiring is needed —
 * carrying the resume cursor and the validated session digest.
 *
 * LOUD, and then RETHROWN. An earlier fix logged the failure
 * loudly and SWALLOWED it — but `log.error` is `console.error` (src/log.ts),
 * and the only alarm on this function watches the Lambda `Errors` metric
 * (the deployment stack). A swallowed continuation therefore stalled a HEALTHY
 * long-lived socket's queue tail (which never reconnects to trigger a fresh
 * drain) while raising NO alarm — the loud log went to a channel nothing
 * watched. So the failure is now logged LOUDLY (error, not info) and
 * DISTINGUISHABLY (the error class) and then RETHROWN, which fails this async
 * (Event) invocation: AWS's async-invoke retry re-attempts the continuation and
 * the failure increments the `Errors` metric the alarm fires on. Re-running the
 * slice re-posts a prefix clients already dedupe by msgId — cheap next to a
 * silently stalled tail. The drain role holds lambda:InvokeFunction on its own
 * ARN (infra), so an AccessDenied here is a broken deployment; a throttle is a
 * transient the retry rides out.
 */
async function scheduleContinuation(payload: WsDrainEvent): Promise<void> {
  const functionName = process.env.AWS_LAMBDA_FUNCTION_NAME;
  // No function name means running outside Lambda (a direct test caller):
  // nothing to self-invoke, and NOT a scheduling failure — silently returned,
  // distinct from the loud catch below.
  if (!functionName) return;
  try {
    await lambda.send(
      new InvokeCommand({
        FunctionName: functionName,
        InvocationType: 'Event',
        Payload: Buffer.from(JSON.stringify(payload)),
      }),
    );
  } catch (err) {
    // LOUD, DISTINGUISHABLE, and then RETHROWN. The error CLASS
    // only (never an id or the digest). AccessDeniedException => the
    // drain role lost lambda:InvokeFunction on itself; a throttle or other
    // transient rides out the async-invoke retry the rethrow engages. Rethrown
    // rather than swallowed because `log.error` alone is `console.error`, which
    // the Lambda-`Errors` alarm never sees — failing the invocation is what
    // engages both that alarm and the retry that re-schedules the tail.
    log.error('ws_drain_continuation_failed', {
      error: err instanceof Error ? err.name : 'unknown',
    });
    throw err;
  }
}
