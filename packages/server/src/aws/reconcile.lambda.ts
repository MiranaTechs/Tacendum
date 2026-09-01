import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import {
  makeDataLayer,
  type DataLayer,
  type LedgerReconcileRequest,
  type LedgerReconcileTarget,
} from '../db/data.js';
import { makeDocClient } from '../db/client.js';
import { log } from '../log.js';

/** One client, cached across warm invocations, for the self-invoke that
 * continues a repair past its per-invocation slice budget — the WsDrainFn
 * idiom (aws/ws-drain.lambda.ts), reused for the same structural reason. */
const lambda = new LambdaClient({});

/** The data layer, cached like the client. Built DIRECTLY (doc client +
 * makeDataLayer), not via makeAwsDeps: this worker holds no S3, push, TURN or
 * origin configuration, and the shared factory fails fast on their absence.
 * It needs exactly one capability — the messages-table slice — and its role
 * is granted exactly that (the deployment stack). */
let cachedDb: DataLayer | undefined;
function dbFor(): DataLayer {
  cachedDb ??= makeDataLayer(makeDocClient());
  return cachedDb;
}

/**
 * Quota-ledger reconcile worker (the defect it repairs:
 * quota repair was an unawaited promise on the refusal path's event loop,
 * which Lambda freezes the moment the 429 returns — so a ledger drifted HIGH
 * over TTL-reaped rows could stay drifted forever, refusing a legitimate
 * sender indefinitely).
 *
 * The WebSocket adapter now async (Event) invokes THIS function before the
 * refusal returns; Lambda's internal async queue survives the caller's
 * container, and a handler error here rides the pinned async-invoke retry
 * (retryAttempts: 2 in infra). Each invocation runs ONE leased, budgeted
 * slice via db.reconcileQueueLedger — every safety property lives in the
 * data layer, shared verbatim with the local adapter's in-process slice:
 * single-flight per ledger row, page/wall-clock budgeted, resumable under an
 * unchanged (qGen, qVer), and NEVER lowering a ledger from an incomplete
 * scan (a partial count is a lower bound; resetting to it would be a free
 * eviction primitive, strictly worse than the drift being healed).
 *
 * When a slice ends with work remaining ('continue'), the worker SELF-INVOKES
 * to run the next slice, so the repair completes without waiting for further
 * refusals to drive it. The chain is hop-capped: the cursor persists on the
 * ledger row across chains, so a capped-out repair resumes — not restarts —
 * when the next refusal schedules a fresh chain.
 *
 * This function authenticates nothing and the event carries no key, filter,
 * or payload — only ids and a discriminator; the data layer derives the
 * ledger row and recount filter from the same constants the enqueue stamps.
 * Re-running a slice (the async retry, a duplicate event) is safe by
 * construction: the lease stands duplicates down and no reset can land twice.
 */
export interface LedgerReconcileEvent extends LedgerReconcileRequest {
  /** Continuation depth of this chain; absent on the refusal's schedule. */
  hop?: number;
}

/**
 * Chain bound. 32 slices × RECONCILE_MAX_PAGES pages ≈ 128 evaluated pages
 * per scheduled repair, which covers any partition a capped queue can
 * legitimately hold; a pathological one stops here and RESUMES from the
 * persisted cursor when the next refusal schedules again. A bound, not a
 * retry loop: without one, a ledger whose (qGen, qVer) keeps moving (acks
 * releasing under the scan) could void scans indefinitely and turn one
 * refusal into an unbounded invoke chain.
 */
export const RECONCILE_MAX_HOPS = 32;

function validTarget(target: unknown): target is LedgerReconcileTarget {
  if (typeof target !== 'object' || target === null) return false;
  const t = target as { kind?: unknown; senderId?: unknown };
  if (t.kind === 'stranger') return true;
  return t.kind === 'pair' && typeof t.senderId === 'string' && t.senderId.length > 0;
}

export async function handler(event: LedgerReconcileEvent): Promise<void> {
  const { recipientId, target } = event ?? {};
  if (typeof recipientId !== 'string' || recipientId.length === 0 || !validTarget(target)) {
    // Never invoked this way by our adapter; drop rather than retry.
    log.error('ledger_reconcile_bad_event', {});
    return;
  }
  // Throws propagate: this is an async (Event) invocation, so a failed slice
  // (a throttle, a transient) fails the invocation and the platform retry
  // re-runs it — which the lease and the never-lower rule make safe. The
  // opposite posture from the push worker (whose retry can ring a phone
  // twice); a reconcile retried twice heals once.
  const outcome = await dbFor().reconcileQueueLedger(recipientId, target);
  if (outcome !== 'continue') return;
  // CLAMPED, not merely type-checked. `typeof === 'number'` accepted a
  // negative or a fraction verbatim, so `hop: -1e9` would need a billion
  // continuations to reach the bound below and a fraction never lands on it
  // exactly. Hardening rather than a live fix: the only two principals that
  // can invoke this function are the WS execution role (whose payload carries
  // no `hop` at all) and this function itself (which always computes an
  // integer), and JSON cannot transport NaN or Infinity. Cheap enough to make
  // the bound hold by construction instead of by trust.
  const prior = Number.isInteger(event.hop) ? Math.max(0, event.hop as number) : 0;
  const hop = prior + 1;
  if (hop >= RECONCILE_MAX_HOPS) {
    // Loud, not fatal: the persisted cursor survives on the ledger row, and
    // the next refusal's schedule resumes from it. Metadata only —
    // never the recipient or sender id.
    log.error('ledger_reconcile_hops_exhausted', { hops: hop });
    return;
  }
  await scheduleContinuation({ recipientId, target, hop });
}

/**
 * Self-invoke this same function for the next slice — the WsDrainFn
 * continuation contract, including its fail-loud posture: LOUD (error, with
 * the error class and nothing else) and then RETHROWN, so a failed
 * continuation fails this async invocation, engaging both the Errors metric
 * and the platform retry, instead of a swallowed log stalling the repair.
 */
async function scheduleContinuation(payload: LedgerReconcileEvent): Promise<void> {
  const functionName = process.env.AWS_LAMBDA_FUNCTION_NAME;
  // Outside Lambda (a direct test caller): nothing to self-invoke, and NOT a
  // scheduling failure — silently returned, distinct from the loud catch.
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
    log.error('ledger_reconcile_continuation_failed', {
      error: err instanceof Error ? err.name : 'unknown',
    });
    throw err;
  }
}
