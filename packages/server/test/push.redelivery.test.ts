import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deliverPushWake } from '../src/handlers/push-worker.js';
import type { TestOnlyDataLayer } from '../src/db/data.js';
import { makeMemoryDb, makeTestDeps, type TestDeps } from './helpers.js';

/**
 * PLATFORM REDELIVERY OF THE VoIP WAKE — the one duplicate source the code
 * does not own.
 *
 * The double-ring invariant is this codebase's own, and it is enforced
 * everywhere the code controls the retry: `push.lambda.ts` never throws
 * (a thrown async Lambda is retried by the platform), its credential wait is
 * BOUNDED for the same reason, and the APNs sender's 5xx retry is bounded at
 * one. All of that is defence against a retry the process can see.
 *
 * The invocation itself cannot be. Lambda's async queue is at-least-once, the
 * push function carries the default `retryAttempts`, and a TIMED-OUT
 * invocation is redelivered by the platform with no code path able to observe
 * it — `push.lambda.ts` says so in as many words. The worker then re-runs from
 * the top on IDENTICAL event bytes.
 *
 * What made that a second ring rather than a no-op: the event carried no wake
 * identifier at all, and the only prior state `deliverPushWake` consulted was
 * the `verify` ack probe — which is attached ONLY when a live connection took
 * the bytes (ws.ts). The DOMINANT ring case is the opposite one: a locked
 * phone with no connection row takes the BARE wake branch, which carries no
 * msgId and no probe, so a redelivered event went straight to APNs with
 * nothing re-read. The device cannot absorb it either: the VoIP payload is
 * `{from, ts}` with no identifier, and a delivered push IS a native ring by
 * construction (the PushKit report has already fired).
 *
 * THE KEY IS NOT `msgId`, deliberately. `msgId` is client-chosen, and
 * ws.ts protects "a legitimate retry of a call offer (client resend after a
 * dropped ack, a crash between enqueue and wake)" — that retry reuses the
 * msgId and MUST still ring. A msgId-keyed dedup would silence it: the
 * rejected denial-of-RING remedy wearing an idempotency costume. The server
 * mints a fresh id per SCHEDULE instead, so one scheduling decision rings at
 * most once and every scheduling decision rings.
 *
 * Every assertion below that is not (a) exists to hold the fix open: the fix
 * must fail toward RINGING in every direction it can fail.
 *
 * WHAT THIS FILE DOES NOT SHOW, so nobody reads it as more than it is:
 *
 *  - The guard NARROWS the platform double-ring; it does not close it. The
 *    claim is written only after APNs accepts, and the window before that
 *    holds a token read plus the whole APNs exchange — up to two 5s attempts
 *    (push/apns.ts `ATTEMPT_TIMEOUT_MS`). A redelivery landing inside it
 *    finds no claim and rings again, which is most likely for the very
 *    trigger the guard was built for: a timed-out invocation.
 *  - An APNs attempt that THROWS is ambiguous — `sendVoip` reports 'failed'
 *    and refuses to retry because the request may have been accepted and only
 *    the response lost. No claim is written for it, so a redelivery of that
 *    wake can double-ring in exactly the case apns.ts declines to retry.
 *    Deliberate: both layers fail toward RINGING.
 *  - Neither suppressed verdict is visible in operations. `redelivered` and
 *    `acked` are published on the VoipWake Outcome dimension and no panel or
 *    alarm selects them (see the note on `PushWakeOutcome`), so how often
 *    this guard fires in production is currently unknown.
 *
 *  - The mint itself is NOT exercised here: every case below hand-writes its
 *    wakeId and calls the worker directly. The rule that makes those ids
 *    meaningful — fresh per schedule, never derived from the frame — is
 *    pinned in push.wakeid.mint.test.ts.
 */

const ALICE = 'user-alice';
const SENDER = 'user-sender';
const VOIP = 'v'.repeat(64);
const MSG = '01JBQ0000000000000000000AA';

let db: TestOnlyDataLayer;
let deps: TestDeps;

beforeEach(async () => {
  db = makeMemoryDb();
  deps = makeTestDeps(db);
  await db.createUser({ userId: ALICE, createdAt: deps.now() });
  await db.putPushToken({
    userId: ALICE,
    voipToken: VOIP,
    env: 'sandbox',
    bundleId: 'com.miranatechnologies.tacendum',
    updatedAt: deps.now(),
    expiresAt: Math.floor(deps.now() / 1000) + 86_400,
  });
});

describe('a redelivered wake', () => {
  it('rings once when the platform delivers the same event bytes twice', async () => {
    // The bare wake: nobody was listening, so there is no probe and no
    // msgId — the asleep-phone ring, i.e. the common case. Identical bytes,
    // because that is exactly what an at-least-once queue redelivers.
    const event = { recipientId: ALICE, senderUserId: SENDER, wakeId: 'wake-1' };

    expect(await deliverPushWake(event, deps)).toBe('sent');
    expect(await deliverPushWake(event, deps)).toBe('redelivered');

    expect(deps.pushesSent).toHaveLength(1);
  });

  it('rings once for a verify wake the recipient never acked', async () => {
    // The frozen-callee case the probe exists for: the row SURVIVES the ack
    // grace, so the probe says ring — and it must still ring only once.
    await db.enqueueMessage({
      recipientId: ALICE,
      msgId: MSG,
      senderId: SENDER,
      type: 'ciphertext',
      payload: 'QUJD',
      ts: deps.now(),
      expiresAt: Math.floor(deps.now() / 1000) + 3600,
    });
    const event = {
      recipientId: ALICE,
      senderUserId: SENDER,
      kind: 'call' as const,
      wakeId: 'wake-2',
      verify: { msgId: MSG, ackGraceMs: 1 },
    };

    expect(await deliverPushWake(event, deps)).toBe('sent');
    expect(await deliverPushWake(event, deps)).toBe('redelivered');

    expect(deps.pushesSent).toHaveLength(1);
  });
});

describe('the denial-of-RING guard', () => {
  it('rings TWICE for two scheduling decisions that reuse one msgId', async () => {
    // THE ASSERTION THAT MUST BE GREEN BEFORE AND AFTER. A client resend of a
    // call offer after a dropped ack reuses the msgId; ws.ts refuses to gate
    // the ring on that row's existence for exactly this reason. Two separate
    // trips through `wakeRecipient` are two separate rings, and a wake id
    // minted per SCHEDULE is what keeps them distinguishable from one
    // schedule delivered twice.
    const base = { recipientId: ALICE, senderUserId: SENDER, kind: 'call' as const };

    expect(await deliverPushWake({ ...base, wakeId: 'wake-a' }, deps)).toBe('sent');
    expect(await deliverPushWake({ ...base, wakeId: 'wake-b' }, deps)).toBe('sent');

    expect(deps.pushesSent).toHaveLength(2);
  });

  it('rings on redelivery when the first attempt never reached the device', async () => {
    // The claim is written only AFTER a successful send, never before. A
    // pre-send claim would permanently silence the redelivery of an
    // invocation that timed out BEFORE reaching APNs — denial-of-RING, built
    // by the fix meant to prevent a double ring.
    const failing: TestDeps = {
      ...deps,
      push: { ...deps.push, wake: async () => 'failed' as const },
    };
    const event = { recipientId: ALICE, senderUserId: SENDER, wakeId: 'wake-3' };

    expect(await deliverPushWake(event, failing)).toBe('failed');
    expect(await deliverPushWake(event, deps)).toBe('sent');

    expect(deps.pushesSent).toHaveLength(1);
  });

  it('rings on redelivery when the first attempt threw before the send', async () => {
    // Same posture one layer earlier: a token read that throws returns
    // 'failed' out of the catch-all, having rung nothing. The redelivery is
    // the call's last chance and must take it.
    const throwing: TestDeps = {
      ...deps,
      db: {
        ...deps.db,
        getPushToken: async () => {
          throw new Error('database unavailable');
        },
      },
    };
    const event = { recipientId: ALICE, senderUserId: SENDER, wakeId: 'wake-4' };

    expect(await deliverPushWake(event, throwing)).toBe('failed');
    expect(await deliverPushWake(event, deps)).toBe('sent');

    expect(deps.pushesSent).toHaveLength(1);
  });

  it('rings when the dedup store itself is unavailable, and says nothing new', async () => {
    // FAIL-OPEN IN EVERY DIRECTION. Both calls must swallow their own
    // failures inside the data layer: a throw escaping into
    // `deliverPushWake`'s catch would return 'failed' and skip the ring,
    // converting a DynamoDB blip into a MISSED CALL — strictly worse than
    // the duplicate this exists to prevent.
    const denied: TestDeps = {
      ...deps,
      db: {
        ...deps.db,
        wakeAlreadyRang: async () => {
          throw Object.assign(new Error('User is not authorized'), {
            name: 'AccessDeniedException',
          });
        },
        markWakeRang: async () => {
          throw Object.assign(new Error('User is not authorized'), {
            name: 'AccessDeniedException',
          });
        },
      } as TestOnlyDataLayer,
    };
    const event = { recipientId: ALICE, senderUserId: SENDER, wakeId: 'wake-5' };

    expect(await deliverPushWake(event, denied)).toBe('sent');
    expect(await deliverPushWake(event, denied)).toBe('sent');

    expect(deps.pushesSent).toHaveLength(2);
  });

  it('rings on every delivery of an event minted before the deploy', async () => {
    // An event already on the async queue when this deploy lands has no
    // `wakeId` at all. Absence keeps the pre-deploy meaning — ring, no dedup
    // — the same posture `kind` takes for the same reason.
    const event = { recipientId: ALICE, senderUserId: SENDER };

    expect(await deliverPushWake(event, deps)).toBe('sent');
    expect(await deliverPushWake(event, deps)).toBe('sent');

    expect(deps.pushesSent).toHaveLength(2);
  });
});

describe("the claim's lifetime", () => {
  /**
   * Lambda's DEFAULT maximum event age for an async invoke, and the default is
   * what applies: PushFn declares no `configureAsyncInvoke` (infra/lib/
   * tacendum-stack.ts — unlike wsDrainFn and reconcileFn, which both do), so
   * the platform will keep handing this event back for six hours after it was
   * enqueued.
   *
   * That number is the whole reason the claim carries a TTL at all. A claim
   * that dies first is not a guard: the redelivery arrives, finds nothing, and
   * rings a second time — which is the exact defect this file exists to
   * prevent. Before this test the TTL constant was unpinned, and setting it to
   * ONE SECOND left all 687 tests in this package green, because every other
   * case here delivers its wake twice inside the same second.
   */
  const LAMBDA_MAX_EVENT_AGE_SECONDS = 6 * 60 * 60;

  /** `deliverPushWake` under a db that records the TTL the claim was written
   * with. Wrapping rather than replacing: the underlying twin still stores the
   * claim, so suppression keeps working through the spy. */
  function watchingClaims(): { deps: TestDeps; claimedAt: () => number | undefined } {
    let expires: number | undefined;
    return {
      claimedAt: () => expires,
      deps: {
        ...deps,
        db: {
          ...deps.db,
          markWakeRang: async (wakeId: string, expiresAt: number) => {
            expires = expiresAt;
            await deps.db.markWakeRang(wakeId, expiresAt);
          },
        } as TestOnlyDataLayer,
      },
    };
  }

  // NOT HOUSEKEEPING. Fake timers persist for the rest of the FILE, and the
  // ack-probe case below awaits a real `setTimeout(ackGraceMs)` inside
  // `deliverPushWake`. Delete this and that test does not fail on its
  // assertion, it hangs to the 15s cap — verified, not assumed.
  afterEach(() => {
    vi.useRealTimers();
  });

  it('outlives every redelivery the platform is still willing to make', async () => {
    const { deps: watching, claimedAt } = watchingClaims();
    const before = Math.floor(Date.now() / 1000);

    const event = { recipientId: ALICE, senderUserId: SENDER, wakeId: 'wake-7' };
    expect(await deliverPushWake(event, watching)).toBe('sent');

    // STRICTLY past the window, not merely up to it. `>=` is what the
    // arithmetic requires — the claim is written no earlier than the event was
    // enqueued, so a TTL equal to the maximum event age already covers the
    // last redelivery. The code takes visible slack on top so that clock skew
    // between this Lambda's wall clock and the platform's own event-age
    // accounting cannot eat the margin, and this assertion is what stops that
    // slack from being quietly optimised to zero.
    // `?? 0` rather than a separate `toBeDefined()`: a claim that was never
    // written fails this same assertion, so one line carries both facts
    // instead of one line carrying nothing.
    expect(claimedAt() ?? 0).toBeGreaterThan(before + LAMBDA_MAX_EVENT_AGE_SECONDS);
  });

  it('stops suppressing once it has expired, so no wake id is silenced forever', async () => {
    // THE OTHER DIRECTION, and it is not decoration. A claim is the only thing
    // in this path that can refuse a ring, so "when does it stop refusing" is
    // a ring-safety question, not a housekeeping one — and the twin's expiry
    // branch had no caller at all before this test, which is a mirror arm
    // written and never exercised.
    const { deps: watching, claimedAt } = watchingClaims();
    const event = { recipientId: ALICE, senderUserId: SENDER, wakeId: 'wake-8' };

    expect(await deliverPushWake(event, watching)).toBe('sent');
    expect(await deliverPushWake(event, deps)).toBe('redelivered');
    const expiresAt = claimedAt() ?? 0;

    // The wall clock, moved for real rather than a `now()` stubbed on one
    // function: `claimRang` and the twin's expiry check both read `Date.now()`
    // (the TestOnlyDataLayer carries no clock — DynamoDB reaps server-side), so
    // anything narrower would move one of them and not the other.
    vi.useFakeTimers();

    // One second short of the TTL the claim was actually written with: still
    // claimed, still suppressed. Without this the twin could expire early and
    // the case below would not notice.
    vi.setSystemTime((expiresAt - 1) * 1000);
    expect(await deliverPushWake(event, deps)).toBe('redelivered');

    // AT the TTL — `<=`, the same boundary the store's TTL semantics take.
    // The id is free again and the wake rings.
    vi.setSystemTime(expiresAt * 1000);
    expect(await deliverPushWake(event, deps)).toBe('sent');

    expect(deps.pushesSent).toHaveLength(2);

    // WHAT THIS DOES NOT SHOW, because the twin and the store diverge here and
    // the divergence is stated in helpers.ts: DynamoDB reaps TTL rows LAZILY,
    // so production may keep answering `true` for a while after `expiresAt`.
    // That direction is harmless — by then the wake is older than Lambda's
    // maximum event age and no redelivery of it can still exist. The property
    // that is production-true, and the one the case above pins, is the
    // earliest moment suppression may end: not before `expiresAt`.
  });
});

describe('the ack probe', () => {
  it('still wins over the dedup check on a wake the recipient acked', async () => {
    // AN ORDERING TEST MUST BE ABLE TO SEE ITS ORDERING. An earlier draft of
    // this case called the worker ONCE on a wake whose claim had never been
    // written, so `alreadyRang` returned false whichever side of the probe it
    // was taken on — hoisting the redelivery guard above the probe left the
    // whole suite green. The two verdicts only differ when BOTH are true at
    // once, so both must be true here.
    //
    // Built through the real path rather than hand-written: the first wake
    // finds the row alive, rings, and WRITES the claim. Then the recipient
    // acks — an ack deletes the queued row — and the platform redelivers the
    // same event bytes.
    await db.enqueueMessage({
      recipientId: ALICE,
      msgId: MSG,
      senderId: SENDER,
      type: 'ciphertext',
      payload: 'QUJD',
      ts: deps.now(),
      expiresAt: Math.floor(deps.now() / 1000) + 3600,
    });
    const event = {
      recipientId: ALICE,
      senderUserId: SENDER,
      kind: 'call' as const,
      wakeId: 'wake-6',
      verify: { msgId: MSG, ackGraceMs: 1 },
    };
    expect(await deliverPushWake(event, deps)).toBe('sent');
    expect(await db.wakeAlreadyRang('wake-6')).toBe(true);

    // The ack.
    await db.deleteQueuedMessage(ALICE, MSG);

    // Both suppress the ring — that is not what is under test. WHICH verdict
    // comes back is: 'acked' is the informative one (the recipient's own
    // CallKit report is already up), and it is only reachable while the probe
    // runs FIRST. With the guard hoisted above it, this reads 'redelivered'.
    expect(await deliverPushWake(event, deps)).toBe('acked');
    expect(deps.pushesSent).toHaveLength(1);
  });
});
