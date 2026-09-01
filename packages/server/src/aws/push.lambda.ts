import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { deliverPushWake, type PushWakeEvent } from '../handlers/push-worker.js';
import { log } from '../log.js';
import { apnsCredentialsSettled } from '../push/sender.js';
import { fcmCredentialsSettled } from '../push/fcm-sender.js';
import { makeAwsDeps } from './deps.js';

const cloudwatch = new CloudWatchClient({ maxAttempts: 1 });

/**
 * VoIP wake worker async-invoked by the WebSocket adapter.
 *
 * It exists for the same reason `ws-drain.lambda.ts` does: something slow and
 * externally-dependent must not run on a path a user is waiting on. There the
 * constraint was API Gateway's handshake; here it is Apple's availability.
 * Message delivery completes and receipts before this ever starts.
 *
 * This function authenticates nothing. It acts only on a wake the WebSocket
 * adapter already authorized and rate-limited.
 *
 * WHAT THE EVENT CARRIES. It is the comment a reviewer reads to answer "what does the push worker
 * see?", so it says the current answer: the two userIds, `kind`, the queued
 * row for a message push — whose `payload` IS the ciphertext, the same opaque
 * bytes the server stored and cannot read — the ack probe's `verify.msgId`,
 * and the server-minted `wakeId`.
 *
 * Still no bearer token, still no device token, still nothing the server can
 * decrypt. And still no CALL identifier: `wakeId` names one scheduling
 * decision by `wakeRecipient`, is minted fresh per schedule and never derived
 * from the frame, and correlates to nothing outside this hop.
 *
 * `PushWakeEvent` (handlers/push-worker.ts) is the authority on every field.
 * This is a summary, and it is only worth reading if it is re-checked against
 * that type whenever the type changes.
 */
export async function handler(event: PushWakeEvent): Promise<void> {
  // Never throws: an Event-invoked Lambda that throws is retried by Lambda,
  // and a retried push can ring a phone twice for one call. deliverPushWake
  // swallows its own failures for exactly this reason; this is belt and braces.
  try {
    // Deps first — constructing them kicks the credential fetch on a cold
    // container — THEN wait for that fetch, then deliver. Without the wait,
    // the first invocation of every cold container answered "unconfigured"
    // and dropped its push; push traffic is sparse, so the cold container is
    // the common case, not the corner.
    const deps = makeAwsDeps();
    // BOUNDED. The function's 20s budget already carries two 5s APNs
    // attempts; an unbounded wait on a wedged Secrets Manager fetch would
    // hit the platform timeout instead — and a TIMED-OUT async Lambda is
    // RETRIED by the platform, which is exactly the double-ring this
    // handler's never-throw contract exists to prevent. Four seconds is an
    // eternity for a same-region secret fetch; past it, the push degrades to
    // the pre-wait behaviour (unconfigured, logged) rather than ringing
    // twice.
    // BOTH lanes' keys, under the one bound: the router picks APNs or FCM
    // per token row, this handler cannot know which before the lookup, and
    // the two fetches run concurrently anyway — so waiting on both costs the
    // slower fetch, not the sum. Each settled() resolves immediately when
    // its ARN is not configured.
    await Promise.race([
      Promise.all([apnsCredentialsSettled(), fcmCredentialsSettled()]).then(
        () => undefined,
      ),
      new Promise<void>((resolve) => setTimeout(resolve, 4_000).unref?.()),
    ]);
    const outcome = await deliverPushWake(event, deps);
    if ((event.kind ?? 'call') === 'call') {
      try {
        await cloudwatch.send(
          new PutMetricDataCommand({
            Namespace: 'Tacendum',
            MetricData: [
              {
                MetricName: 'VoipWake',
                Value: 1,
                Unit: 'Count',
                Dimensions: [{ Name: 'Outcome', Value: outcome }],
              },
            ],
          }),
          { abortSignal: AbortSignal.timeout(2_000) },
        );
      } catch {
        log.error('voip_metric_publish_failed');
      }
    }
  } catch (err) {
    // The one line of context a production outage did not have: every
    // invocation logged `push_worker_failed` and nothing else, and the cause
    // had to be dug out of the deployed bundle.
    log.error('push_worker_failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
