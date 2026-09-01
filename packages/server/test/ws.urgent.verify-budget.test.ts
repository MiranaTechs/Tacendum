import { beforeEach, describe, expect, it } from 'vitest';
import { monotonicFactory } from 'ulid';
import type { ServerFrame } from '@tacendum/shared';
import { wsDefaultHandler, type WsDeps } from '../src/handlers/ws.js';
import { deliverPushWake } from '../src/handlers/push-worker.js';
import { LIMITS } from '../src/ratelimit.js';
import type { DataLayer } from '../src/db/data.js';
import { makeMemoryDb, makeTestDeps, type TestDeps } from './helpers.js';

/**
 * THE VERIFY-WAKE ACCOUNTING SPLIT — a probe is not a ring, and
 * must not be billed as one.
 *
 * A recent fix made a wake on the DELIVERED urgent path conditional on the
 * recipient's own ack: the worker waits out a grace, re-reads the queued row
 * (acks delete it), and rings only if it survived. Right behaviour, wrong
 * accounting: `wakeRecipient` debited the RING buckets (`pushcall`,
 * `pushcall-unknown`) synchronously at schedule time, the ack then silenced
 * the probe, and nothing refunded the tokens. `call.offer` and `call.end` are
 * both urgent, so ~3 healthy ANSWERED calls from a not-yet-established caller
 * spent 6 tokens of a 5-capacity, 5-per-HOUR recipient-shared budget — and a
 * later GENUINE first ring, from a DIFFERENT stranger to an OFFLINE
 * recipient, was dropped as push_suppressed_unknown_sender. Denial-of-RING —
 * on this project's explicitly rejected-remedies list — reintroduced by the
 * accounting of a fix built to PREVENT a missed ring. The sting: call
 * carriers never establish correspondence so answering calls forever
 * does not exempt the caller; only user-authored messages do.
 *
 * The invariant these tests pin: a wake that does NOT result in a ring must
 * not consume the budget genuine rings depend on — while the probe path stays
 * bounded on budgets of its OWN (a delivered urgent frame is
 * attacker-triggerable over a live socket, so an unbounded probe path is a
 * worker-invocation amplifier and a DynamoDB cost sink).
 */

const ulid = monotonicFactory();
const VICTIM = '0000000000000000000VCTM005';
const CALLER = '0000000000000000000CA11ER0';

let db: DataLayer;
let deps: TestDeps;
let wsDeps: WsDeps;
/** What handleSend asked the scheduler for, per wake. */
let scheduled: { kind: 'call' | 'message'; verify?: { msgId: string; ackGraceMs: number } }[];

async function createSender(userId: string): Promise<void> {
  await db.createUser({ userId, createdAt: deps.now() });
}

/** One urgent call carrier (`notify: false`, like real call signalling — it
 * must never mint establishment). Returns the handler's status code. */
async function sendUrgent(senderUserId: string, msgId = ulid()): Promise<number> {
  const result = await wsDefaultHandler(
    {
      routeKey: '$default',
      connectionId: `conn-${senderUserId}`,
      senderUserId,
      body: JSON.stringify({
        type: 'send',
        to: VICTIM,
        msgId,
        msgType: 'ciphertext',
        payload: 'QUJD',
        urgent: true,
        notify: false,
      }),
    },
    wsDeps,
  );
  return result.statusCode;
}

/** A healthy, ANSWERED leg: the frame lands on the victim's live socket, and
 * the victim's ack (which deletes the queued row) beats the probe's grace —
 * exactly what app/src/messaging.ts does on every frame it dispatches. */
async function deliveredAndAcked(senderUserId: string): Promise<void> {
  const msgId = ulid();
  const inFlight = sendUrgent(senderUserId, msgId);
  // The row must exist before an ack can delete it; `sendUrgent` is still
  // enqueuing. Wait like a real ack does (it follows delivery), then delete.
  while (!(await db.getQueuedMessage(VICTIM, msgId))) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  await db.deleteQueuedMessage(VICTIM, msgId);
  await inFlight;
}

/** Reverse correspondence: the victim once WROTE to this sender (a real,
 * user-authored message — the only thing that establishes). */
async function victimWroteTo(userId: string): Promise<void> {
  await db.enqueueMessage(
    {
      recipientId: userId,
      msgId: ulid(),
      senderId: VICTIM,
      type: 'ciphertext',
      payload: 'QUJD',
      ts: deps.now(),
      expiresAt: Math.floor(deps.now() / 1000) + 3600,
    },
    { establishesCorrespondence: true },
  );
}

beforeEach(async () => {
  scheduled = [];
  db = makeMemoryDb();
  deps = makeTestDeps(db);
  wsDeps = {
    ...deps,
    sender: {
      // Every post succeeds: a live-looking socket that takes the bytes is
      // the exact state the verify probe exists for.
      async post(_connectionId: string, _frame: ServerFrame): Promise<boolean> {
        return true;
      },
    },
    scheduleDrain: async () => {},
    // Inline worker, exactly as the local adapter runs it, EVERY parameter
    // named (ws.urgent.test.ts records why a narrower fake hid a bug). The
    // grace is clamped to keep the suite fast; the shipped constant is pinned
    // by its own test in ws.urgent.test.ts.
    schedulePush: async (recipientId, senderUserId, kind, message, verify) => {
      scheduled.push({ kind: kind ?? 'call', ...(verify ? { verify } : {}) });
      await deliverPushWake(
        {
          recipientId,
          senderUserId,
          ...(kind ? { kind } : {}),
          ...(message ? { message } : {}),
          ...(verify ? { verify: { ...verify, ackGraceMs: Math.min(verify.ackGraceMs, 40) } } : {}),
        },
        wsDeps,
      );
    },
  };
  await db.createUser({ userId: VICTIM, createdAt: deps.now() });
  await createSender(CALLER);
  await db.putPushToken({
    userId: VICTIM,
    voipToken: 'a'.repeat(64),
    env: 'sandbox',
    bundleId: 'com.miranatechnologies.tacendum',
    updatedAt: deps.now(),
    expiresAt: Math.floor(deps.now() / 1000) + 86_400,
  });
});

describe('acked verify probes must not drain the PER-SENDER ring budget', () => {
  it('an established caller whose answered calls were all acked still rings the victim once the victim is offline', async () => {
    // Established, so the stranger bucket is out of play and this test sees
    // only `pushcall:{CALLER}`.
    await victimWroteTo(CALLER);
    await db.putConnection({
      userId: VICTIM,
      connectionId: 'conn-victim',
      connectedAt: deps.now(),
    });

    // Twelve delivered, ACKED urgent carriers — the offer+end traffic of ~6
    // healthy answered calls (both directions of a hangup are urgent). Every
    // probe is silenced by the ack: not one push may fire, and — the point —
    // not one RING token may be spent.
    for (let i = 0; i < 12; i++) {
      await deliveredAndAcked(CALLER);
    }
    expect(deps.pushesSent).toHaveLength(0);

    // The victim's socket dies (a backgrounded phone, a reaped row). The next
    // call takes the offline path: its ring depends entirely on the
    // per-sender bucket the acked probes must not have touched.
    await db.deleteConnection(VICTIM, 'conn-victim');
    expect(await sendUrgent(CALLER)).toBe(200);
    expect(deps.pushesSent).toEqual([{ userId: VICTIM, fromUserId: CALLER }]);
  });
});

describe('acked verify probes must not drain the recipient-shared STRANGER ring budget', () => {
  it("a DIFFERENT stranger's genuine first ring to the OFFLINE victim survives other strangers' answered calls", async () => {
    await db.putConnection({
      userId: VICTIM,
      connectionId: 'conn-victim',
      connectedAt: deps.now(),
    });

    // Six strangers each place one call that the victim ANSWERS (delivered,
    // acked). Six acked probes; zero rings; and — the defect — at HEAD each
    // one debited the 5-capacity, 5-per-HOUR `pushcall-unknown:{VICTIM}`
    // budget every stranger's first ring shares.
    for (let i = 0; i < 6; i++) {
      const stranger = `stranger-${i}`;
      await createSender(stranger);
      await deliveredAndAcked(stranger);
    }
    expect(deps.pushesSent).toHaveLength(0);

    // Now the victim is offline and a SEVENTH stranger — someone the victim
    // has never heard from, a genuine QR-scan introduction — calls. This is
    // the ring the shared budget exists to allow.
    await db.deleteConnection(VICTIM, 'conn-victim');
    await createSender('stranger-genuine');
    expect(await sendUrgent('stranger-genuine')).toBe(200);
    expect(deps.pushesSent).toEqual([{ userId: VICTIM, fromUserId: 'stranger-genuine' }]);
    // The refusal HEAD emitted for exactly this ring must be gone.
    expect(
      deps.logs.filter((l) => l.event === 'push_suppressed_unknown_sender'),
    ).toHaveLength(0);
  });
});

describe('the probe path stays BOUNDED — on budgets of its own', () => {
  it('probe budgets exist and are sized exactly like the ring bounds they shadow', () => {
    // A probe that SURVIVES is a ring, so the probe capacity is the ceiling
    // on delivered-path rings one hostile caller can aim at one victim —
    // resizing either side of this pair resizes the ring-bomb bound for
    // frozen callees one-for-one. Drift is a conscious decision, made red
    // here first.
    expect(LIMITS.pushVerify).toEqual(LIMITS.pushSend);
    expect(LIMITS.pushVerifyUnknown).toEqual(LIMITS.pushCallUnknown);
  });

  it('a flood of delivered-but-never-acked urgent frames rings at most the probe capacity', async () => {
    // The half-open-socket state (a suspended phone that stopped acking) is
    // the one where verify probes DO ring — and where a hostile caller would
    // aim a ring-bomb. Fifteen delivered frames, nobody acks: the rings must
    // stay bounded by one bucket's burst, and so must the scheduled probes
    // (each probe is a worker invocation sleeping the grace plus a
    // strongly-consistent read — the amplification this bound exists for).
    await victimWroteTo(CALLER);
    await db.putConnection({
      userId: VICTIM,
      connectionId: 'conn-victim',
      connectedAt: deps.now(),
    });
    for (let i = 0; i < 15; i++) {
      expect(await sendUrgent(CALLER)).toBe(200);
    }
    expect(scheduled.length).toBeLessThanOrEqual(10);
    expect(deps.pushesSent.length).toBeLessThanOrEqual(10);
    expect(deps.pushesSent.length).toBeGreaterThan(0);
  });
});
