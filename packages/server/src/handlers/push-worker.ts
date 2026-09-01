import type { Deps, PushOutcome } from './http.js';

/**
 * The VoIP wake, off the message path.
 *
 * Why this is a separate unit of work rather than an inline await: the message
 * handler must never wait on Apple. A push is an optimisation — the ciphertext
 * is already durably queued before this runs, and the caller's UI degrades on
 * its own timer if the callee never rings. Awaiting APNs inline made message
 * delivery depend on a third party's availability, which is the one thing this
 * design promises it does not.
 *
 * Exactly like `drainQueuedMessages`, this is the SINGLE implementation with
 * two schedulers: the AWS WebSocket adapter async-invokes it as its own
 * Lambda, and the local adapter awaits it inline because it has no such
 * constraint.
 *
 * The event carries routing facts — two userIds — and, for a verified call
 * wake, ONE msgId. That last is a deliberate widening of what this comment
 * used to promise ("no msgId, nothing from inside the ciphertext"): the msgId
 * is the queue row's key, minted by the server's own enqueue — a routing fact,
 * not a byte of anyone's ciphertext — and the ack-liveness probe below cannot
 * ask "did the recipient ack THIS frame" without naming the frame. Still no
 * token, still nothing from inside the ciphertext.
 */
export interface PushWakeEvent {
  recipientId: string;
  senderUserId: string;
  /**
   * What to send. Absent means 'call', so an event already in flight across a
   * deploy keeps its old meaning rather than silently becoming a message.
   *
   * A message carries `message`; a call does not. They are different pushes to
   * different tokens on different topics, and the only thing they share is
   * this scheduling hop.
   */
  kind?: 'call' | 'message';
  /** The queued row, for a message push. Ciphertext only — the same bytes the
   * server stored, which it cannot read. */
  message?: {
    msgId: string;
    msgType: string;
    payload: string;
    ts: number;
  };
  /**
   * THE ACK-LIVENESS PROBE. Present only when the urgent frame was handed to a
   * connection row that TOOK the bytes. `post()` resolving true means API
   * Gateway accepted them for a socket it still believes is open — which is
   * exactly what a half-open TCP into a SUSPENDED iOS process looks like
   * (hardware testing: end a locked-phone call, redial inside a
   * few seconds, and the offer is "delivered" into a socket nobody is
   * reading; no push, no ring, the caller stares at "Calling…"). So the
   * row's existence alone cannot decide whether a ring is needed.
   *
   * The recipient's own ack can. It deletes the queued row, it is sent
   * immediately BEFORE the call envelope is dispatched (app/src/messaging.ts —
   * `markSeen`, then `ws.send({type:'ack'})`, then `emitEnvelope`), and a
   * frozen process never sends one. Wait out `ackGraceMs`, re-read the row,
   * ring only if it survived.
   *
   * ABSENT means nobody was listening: ring at once, no probe, no delay. The
   * probe fails toward RINGING — an ack that is merely slow costs one
   * redundant push, never a missed call.
   */
  verify?: { msgId: string; ackGraceMs: number };
  /**
   * THE PLATFORM-REDELIVERY KEY. Minted per SCHEDULE by `wakeRecipient`, so
   * one scheduling decision carries one id no matter how many times Lambda's
   * async queue hands this event over.
   *
   * It exists because the duplicate this worker could not see is the one the
   * platform owns. Everything else here is already defended: `push.lambda.ts`
   * never throws, its credential wait is bounded, the APNs 5xx retry is
   * bounded at one. But the async invoke is at-least-once, the function
   * carries the default retry count, and a TIMED-OUT invocation is
   * redelivered with nothing left running to notice — the event bytes come
   * back identical. The device cannot absorb it either: the VoIP payload is
   * `{from, ts}` with no identifier, and a delivered push IS a native ring by
   * construction, so a duplicate rings until the client's 75-second watchdog.
   *
   * NOT derived from `msgId`, deliberately. A msgId is client-chosen and a
   * legitimate call-offer resend reuses it (ws.ts refuses to gate the ring on
   * that row for exactly this reason) — keying on it would silence a call
   * that genuinely needs to ring. Enforced nowhere but at the mint, so it is
   * pinned there: push.wakeid.mint.test.ts sends one identical offer twice
   * and requires two ids and two rings.
   *
   * Absent means the pre-deploy meaning — ring, no dedup — the same posture
   * `kind` takes above, so an event already on the queue when this deploy
   * lands keeps ringing.
   */
  wakeId?: string;
}

/** `PushOutcome` belongs to the APNs sender and says nothing about acks;
 * only the WAKE gains the suppressed verdicts — `acked` (the recipient's own
 * ack proved it is awake) and `redelivered` (the platform handed us a wake
 * that already rang).
 *
 * Both are PUBLISHED as the Outcome dimension of the VoipWake metric
 * (aws/push.lambda.ts), and both are now SERIES on the operations dashboard's
 * "Offline VoIP wake outcomes" panel — `redelivered` above all, because it is
 * the only number that would show this guard eating rings that were owed.
 *
 * THE UNION BELOW IS THE SOURCE OF THAT PANEL, not a parallel copy of it.
 * infra/test/tacendum-grafana-dashboard.test.ts parses this declaration and
 * requires the panel to RENDER exactly these members, so a seventh verdict
 * added here goes red until the dashboard shows it. That test used to hold a
 * second hand-written list of four instead, which is precisely how `acked`
 * and `redelivered` stayed dark: the pin only ever asked whether the original
 * four were still present, and both new verdicts were invisible under green.
 *
 * DO NOT RESTATE THE UNION IN THIS COMMENT. The parse anchors on the
 * `export type` line at column zero and refuses to run if that pattern
 * matches twice, because prose is a valid match for one that is neither: a
 * single line above restating the shape used to become the derivation, and
 * the next verdict added below it would have been dark again under green.
 * Describe the members here in words, as above; the machine reads the
 * declaration.
 *
 * NO ALARM selects this metric, deliberately. A platform redelivery is an
 * ordinary event and a threshold on it would page on healthy traffic; the
 * panel is somewhere to look when rings are reported missing, not something
 * that pages. */
export type PushWakeOutcome = PushOutcome | 'acked' | 'redelivered';

/**
 * How long a ring claim outlives the wake that wrote it: Lambda's default
 * maximum event age (6h) plus 15 minutes of slack, so no redelivery the
 * platform is still willing to make can outlive its claim.
 */
const WAKE_CLAIM_TTL_SECONDS = 6 * 60 * 60 + 900;

/**
 * The redelivery guard's two store calls, each pinned to its safe direction
 * HERE as well as inside the data layer.
 *
 * Belt and braces on purpose. `deliverPushWake`'s outer catch returns
 * 'failed' and SKIPS THE RING — so any throw reaching it from this path turns
 * a store blip, a throttle or a missing grant into a MISSED CALL, which is
 * strictly worse than the duplicate ring the guard exists to prevent. The
 * DynamoDB layer already swallows its own errors; this makes fail-open a
 * local, provable property of the worker instead of a contract held in
 * another file by a different implementation of the same interface.
 */
async function alreadyRang(deps: Pick<Deps, 'db'>, wakeId: string): Promise<boolean> {
  try {
    return await deps.db.wakeAlreadyRang(wakeId);
  } catch {
    return false; // Unknown means RING.
  }
}

async function claimRang(deps: Pick<Deps, 'db'>, wakeId: string): Promise<void> {
  try {
    await deps.db.markWakeRang(
      wakeId,
      Math.floor(Date.now() / 1000) + WAKE_CLAIM_TTL_SECONDS,
    );
  } catch {
    // An unclaimed wake rings again if the platform ever redelivers it. That
    // is the safe direction, and the only one.
  }
}

/**
 * Look up the recipient's device, wake it, and prune the row if Apple says the
 * device is gone. Never throws: every failure mode here ends with a call that
 * does not ring early, which is a strictly better outcome than anything that
 * could propagate back toward message delivery.
 */
export async function deliverPushWake(
  event: PushWakeEvent,
  deps: Pick<Deps, 'db' | 'push' | 'log'>,
): Promise<PushWakeOutcome> {
  try {
    if (event.kind !== 'message' && event.verify) {
      const { msgId, ackGraceMs } = event.verify;
      await new Promise<void>(resolve => setTimeout(resolve, ackGraceMs));
      if (!(await deps.db.getQueuedMessage(event.recipientId, msgId))) {
        // Acked: the recipient decrypted this frame and dispatched it, so its
        // own CallKit report is already up — or the frame was a call.end it
        // has already applied. Ringing now would report a SECOND call that no
        // later frame will ever arrive to dismiss.
        deps.log('push_suppressed_acked');
        return 'acked';
      }
    }
    // THE PLATFORM-REDELIVERY GUARD, taken after the ack probe (a wake the
    // recipient acked is `acked`, the more informative verdict) and before
    // anything with a side effect. Fail-open in both directions — see
    // `alreadyRang`. The ordering is pinned in push.redelivery.test.ts, on a
    // wake that is BOTH claimed and acked — the only state in which the two
    // verdicts differ, and the reason that test writes a claim first.
    //
    // WHAT THIS GUARD ACTUALLY COVERS, stated plainly because the earlier
    // wording ("a millisecond-wide window remains") was wrong by three to
    // four orders of magnitude. The claim is not written until line ~215,
    // and everything between here and there is UNCLAIMED: `getPushToken`
    // plus the entire APNs exchange, which is bounded at
    // `ATTEMPT_TIMEOUT_MS` (5s, push/apns.ts) times up to two attempts —
    // call it ten seconds, not one millisecond. A redelivery that arrives
    // while the first invocation is still inside that window finds no claim
    // and rings again.
    //
    // That matters most for the trigger this guard was built for. The
    // headline case is a TIMED-OUT invocation against the push function's
    // 20s budget (credential wait <=4s + verify sleep 3s + <=10s of APNs),
    // so the timeout frequently lands INSIDE the unclaimed window — where
    // the redelivery double-rings exactly as it did before this guard
    // existed. What the guard covers RELIABLY is the tail after the claim
    // commits, plus genuine at-least-once duplicates of an invocation that
    // ran to completion. It narrows the double ring; it does not close it,
    // and the remaining width is seconds.
    if (event.wakeId && (await alreadyRang(deps, event.wakeId))) {
      deps.log('push_suppressed_redelivery');
      return 'redelivered';
    }
    const token = await deps.db.getPushToken(event.recipientId);
    // No token is the ordinary case for someone who has never opened the app
    // on a device that supports push. Not an error, not worth a log line.
    if (!token) return 'no_token';

    const outcome =
      event.kind === 'message' && event.message
        ? await deps.push.notify(token, {
            from: event.senderUserId,
            ts: event.message.ts,
            msgId: event.message.msgId,
            msgType: event.message.msgType,
            payload: event.message.payload,
          })
        : await deps.push.wake(token, event.senderUserId);

    if (outcome === 'token_invalid') {
      // The push network says THIS token is gone — and only this token goes.
      // The prune used to delete the whole row keyed on the VoIP token, on
      // the theory that a dead device is dead for both; the
      // counterexample is a half-rotated row (fresh VoIP, stale alert) where
      // the stale alert's 410 erased the fresh VoIP registration and
      // silenced calls entirely. Field-level, conditional on the exact
      // failed value so a rotation that landed mid-flight keeps its token,
      // and the row itself is removed only once no token remains.
      // On Android there is nothing field-level to preserve: ONE FCM token
      // serves both lanes so whichever lane Google refused with
      // UNREGISTERED, the dead value is that one token — same conditional
      // discipline, so a re-registration that landed mid-flight survives.
      const failed =
        token.platform === 'android'
          ? ({ field: 'fcmToken', value: token.fcmToken } as const)
          : event.kind === 'message'
            ? ({ field: 'alertToken', value: token.alertToken } as const)
            : ({ field: 'voipToken', value: token.voipToken } as const);
      if (failed.value) {
        await deps.db.removePushTokenField(
          event.recipientId,
          failed.field,
          failed.value,
        );
      }
      deps.log('push_token_pruned', { field: failed.field });
      return 'token_invalid';
    }
    // CLAIMED ONLY ONCE APPLE HAS IT, never before. A pre-send claim would
    // permanently silence the redelivery of an invocation that timed out on
    // the way to APNs — denial-of-RING, built by the fix meant to prevent a
    // double ring. Anything short of 'sent' rang nothing, so it claims
    // nothing and the redelivery is the call's next chance.
    //
    // WITH ONE KNOWN EXCEPTION, accepted deliberately. `sendVoip` returns
    // 'failed' when the attempt THROWS (push/apns.ts) — a timeout or a torn
    // HTTP/2 session — and it refuses to retry there precisely because "the
    // request may have been accepted and only the response lost. Retrying
    // could ring the callee twice for one call." That verdict is not 'sent',
    // so no claim is written; if the request HAD landed, a platform
    // redelivery of this wake rings the callee a second time — the very case
    // apns.ts declines to retry for. Both layers fail the same way on
    // purpose: TOWARD RINGING. A duplicate ring is a bad minute and the
    // client's 75-second watchdog ends it; an unrung offer is a missed call.
    // So this is a residual, not an oversight — and it is why the guard
    // cannot be described as closing the double-ring window against the
    // platform, only as narrowing it.
    if (event.wakeId && outcome === 'sent') await claimRang(deps, event.wakeId);
    // `env` exists only on iOS rows (an Android row has no APNs host to
    // name), so the field appears exactly when the fact does.
    deps.log('push_completed', {
      platform: token.platform ?? 'ios',
      ...(token.env ? { env: token.env } : {}),
      outcome,
    });
    return outcome;
  } catch {
    // Nothing here may escape: the message is already queued, and this whole
    // path exists only to make a phone ring sooner.
    deps.log('push_failed');
    return 'failed';
  }
}
