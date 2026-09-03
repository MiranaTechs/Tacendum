import { beforeEach, describe, expect, it } from 'vitest';
import { monotonicFactory } from 'ulid';
import { wsDefaultHandler, type WsDeps } from '../src/handlers/ws.js';
import { deliverPushWake } from '../src/handlers/push-worker.js';
import { LIMITS } from '../src/ratelimit.js';
import type { TestOnlyDataLayer } from '../src/db/data.js';
import { makeMemoryDb, makeTestDeps, type TestDeps } from './helpers.js';

/**
 * S3 — the RIGHT to ring is gated on relationship, not only on rate.
 *
 * `urgent: true` is the CallKit ring capability: the recipient's phone rings
 * on arbitrary attacker ciphertext before anything can decrypt it. The
 * per-SENDER bound stops one hostile caller — and accounts are free to
 * mint, so a Sybil fleet was N fresh full budgets aimed at one phone.
 *
 * The bound deliberately REJECTED here is a blanket recipient-keyed call
 * bucket: ratelimit.ts already weighed it — an attacker exhausts the victim's
 * bucket and REAL calls stop arriving, a denial-of-RING primitive. Instead:
 *
 * - a sender the recipient has itself written to (any frame, within the
 * trailing message-TTL window) rings at the existing per-sender rate and
 * NEVER touches the shared budget;
 * - a sender with no such reverse correspondence draws on one small
 * per-recipient budget shared by ALL unknown senders, so the fleet holds
 * one allowance and cannot crowd out people the victim actually knows.
 *
 * The relationship signal is the quota ledger S1 already maintains (the
 * reverse pair-counter row) — no new server-side social graph is stored.
 */

const ulid = monotonicFactory();
const VICTIM = '0000000000000000000VCTM005';

let db: TestOnlyDataLayer;
let deps: TestDeps;
let wsDeps: WsDeps;

async function createSender(userId: string): Promise<void> {
  await db.createUser({ userId, createdAt: deps.now() });
}

async function sendUrgent(senderUserId: string): Promise<number> {
  const result = await wsDefaultHandler(
    {
      routeKey: '$default',
      connectionId: `conn-${senderUserId}`,
      senderUserId,
      body: JSON.stringify({
        type: 'send',
        to: VICTIM,
        msgId: ulid(),
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

beforeEach(async () => {
  db = makeMemoryDb();
  deps = makeTestDeps(db);
  wsDeps = {
    ...deps,
    sender: {
      async post(): Promise<boolean> {
        return true;
      },
    },
    scheduleDrain: async () => {},
    // Inline worker, exactly as the local adapter runs it, every parameter
    // named (see ws.urgent.test.ts for why the narrow fake hid a bug).
    schedulePush: async (recipientId, senderUserId, kind, message) => {
      await deliverPushWake(
        {
          recipientId,
          senderUserId,
          ...(kind ? { kind } : {}),
          ...(message ? { message } : {}),
        },
        wsDeps,
      );
    },
  };
  await db.createUser({ userId: VICTIM, createdAt: deps.now() });
  await db.putPushToken({
    userId: VICTIM,
    voipToken: 'a'.repeat(64),
    env: 'sandbox',
    bundleId: 'com.miranatechnologies.tacendum',
    updatedAt: deps.now(),
    expiresAt: Math.floor(deps.now() / 1000) + 86_400,
  });
});

describe('S3 — a Sybil fleet shares one small ring allowance', () => {
  it('N fresh accounts ring the victim at most the shared unknown-sender budget', async () => {
    // Eight fresh accounts, each with its own untouched per-sender call
    // budget. At HEAD each of them rang: eight rings from eight free
    // registrations, and nothing bounded the fleet's size.
    for (let i = 0; i < 8; i++) {
      const sybil = `sybil-${i}`;
      await createSender(sybil);
      expect(await sendUrgent(sybil)).toBe(200);
    }

    // Eight fresh accounts must not produce eight rings: the fleet's total is
    // bounded by ONE shared allowance, not by the number of registrations.
    expect(deps.pushesSent.length).toBeLessThanOrEqual(5);
    expect(deps.pushesSent.length).toBeGreaterThan(0);
    // The pinned size of the shared budget (5 burst, 5/hour): generous for
    // real first-contact calls, useless for a fleet.
    expect(LIMITS.pushCallUnknown).toMatchObject({ capacity: 5 });
  });

  it('the ciphertext still queues when the ring is suppressed — delivery is never gated', async () => {
    for (let i = 0; i < 8; i++) {
      const sybil = `sybil-${i}`;
      await createSender(sybil);
      await sendUrgent(sybil);
    }
    // Every send was durably enqueued whether or not it rang.
    let queued = 0;
    for await (const page of db.listQueuedMessages(VICTIM)) queued += page.length;
    expect(queued).toBe(8);
  });
});

describe('S3 — no denial-of-RING: established callers never draw the shared budget', () => {
  it('a caller the victim has written to still rings after the fleet drained the stranger budget', async () => {
    // The victim wrote to `friend` earlier — a reply, a read receipt, any
    // frame. That reverse correspondence is the one thing the fleet cannot
    // mint, and it is the whole basis of the ring right.
    const friend = '0000000000000000000FREND06';
    await createSender(friend);
    await db.enqueueMessage({
      recipientId: friend,
      msgId: ulid(),
      senderId: VICTIM,
      type: 'ciphertext',
      payload: 'QUJD',
      ts: deps.now(),
      expiresAt: Math.floor(deps.now() / 1000) + 3600,
    });

    // The fleet exhausts the shared unknown-sender budget completely.
    for (let i = 0; i < 8; i++) {
      const sybil = `sybil-${i}`;
      await createSender(sybil);
      await sendUrgent(sybil);
    }
    const ringsBefore = deps.pushesSent.length;

    // The friend's call MUST ring: it rides the per-sender bound alone.
    expect(await sendUrgent(friend)).toBe(200);
    expect(deps.pushesSent.length).toBe(ringsBefore + 1);
    expect(deps.pushesSent.at(-1)).toEqual({ userId: VICTIM, fromUserId: friend });
  });

  it('an established caller is still bounded by its own per-sender rate', async () => {
    const friend = '0000000000000000000FREND06';
    await createSender(friend);
    await db.enqueueMessage({
      recipientId: friend,
      msgId: ulid(),
      senderId: VICTIM,
      type: 'ciphertext',
      payload: 'QUJD',
      ts: deps.now(),
      expiresAt: Math.floor(deps.now() / 1000) + 3600,
    });

    // Twenty urgent frames from the SAME established caller: the
    // ring-bomb bound still applies unchanged (10 burst).
    for (let i = 0; i < 20; i++) {
      expect(await sendUrgent(friend)).toBe(200);
    }
    expect(deps.pushesSent.length).toBeLessThanOrEqual(LIMITS.pushSend.capacity);
    expect(deps.pushesSent.length).toBeGreaterThan(0);
  });
});

describe('#7 — an automatic carrier the victim EMITS must not mint an established correspondent', () => {
  // The attack: while VICTIM is in a call, an attacker's offer makes VICTIM's
  // own device auto-send call.end/busy (urgent) back to the attacker. That
  // INVOLUNTARY outbound carrier is "VICTIM wrote to attacker", and under the
  // existence-only signal it granted the attacker established status —
  // bypassing the ring budget (and the stranger queue cap) for ~30 days,
  // without the victim ever choosing to correspond. Read receipts / profile
  // syncs (notify:false) are the same class. Only USER-AUTHORED correspondence
  // (no `urgent`, not `notify:false`) may confer the relationship.
  async function victimEmits(to: string, extra: { urgent?: boolean; notify?: boolean }): Promise<void> {
    await wsDefaultHandler(
      {
        routeKey: '$default',
        connectionId: 'conn-victim',
        senderUserId: VICTIM,
        body: JSON.stringify({
          type: 'send',
          to,
          msgId: ulid(),
          msgType: 'ciphertext',
          payload: 'QUJD',
          ...extra,
        }),
      },
      wsDeps,
    );
  }
  const victimRingsFrom = (from: string): number =>
    deps.pushesSent.filter((p) => p.userId === VICTIM && p.fromUserId === from).length;

  async function drainSharedBudget(): Promise<void> {
    for (let i = 0; i < 8; i++) {
      const sybil = `sybil-${i}`;
      await createSender(sybil);
      await sendUrgent(sybil);
    }
  }

  it('a call.end (urgent) the victim auto-emits does NOT exempt the stranger from the ring budget', async () => {
    const attacker = '0000000000000000000ATTACK7';
    await createSender(attacker);
    // VICTIM's device auto-sends call.end (urgent) to the attacker.
    await victimEmits(attacker, { urgent: true });
    // Exhaust the shared unknown-sender budget with an unrelated fleet.
    await drainSharedBudget();
    expect(victimRingsFrom(attacker)).toBe(0);
    // If the auto-carrier had established the attacker this would ride the
    // per-sender bound and ring; it must be treated as UNKNOWN and suppressed.
    await sendUrgent(attacker);
    expect(victimRingsFrom(attacker)).toBe(0);
  });

  it('a read receipt (notify:false) the victim emits does NOT establish the sender', async () => {
    const attacker = '0000000000000000000ATTACK8';
    await createSender(attacker);
    await victimEmits(attacker, { notify: false });
    await drainSharedBudget();
    await sendUrgent(attacker);
    expect(victimRingsFrom(attacker)).toBe(0);
  });

  it('a genuine user-authored reply the victim sends DOES still confer the ring right', async () => {
    // Control: the fix must not break real correspondence. A plain message
    // (no urgent, not notify:false) is user-authored and establishes.
    const friend = '0000000000000000000REA1FRD';
    await createSender(friend);
    await victimEmits(friend, {});
    await drainSharedBudget();
    const before = victimRingsFrom(friend);
    expect(await sendUrgent(friend)).toBe(200);
    expect(victimRingsFrom(friend)).toBe(before + 1);
  });
});

describe('S3 — first contact still works', () => {
  it("a stranger's FIRST call rings — the budget exists to stop fleets, not introductions", async () => {
    await createSender('stranger-1');
    expect(await sendUrgent('stranger-1')).toBe(200);
    expect(deps.pushesSent).toEqual([{ userId: VICTIM, fromUserId: 'stranger-1' }]);
  });

  it('the suppressed ring is invisible to the sender — no relationship oracle', async () => {
    // Exhaust the shared budget with a fleet, then observe the refused
    // stranger's view of the world: an ordinary 200, exactly like a ring.
    for (let i = 0; i < 8; i++) {
      const sybil = `sybil-${i}`;
      await createSender(sybil);
      const status = await sendUrgent(sybil);
      expect(status).toBe(200);
    }
    const frames = deps.logs.filter((l) => l.event.startsWith('push_suppressed'));
    for (const entry of frames) {
      // Routing metadata only — never who is established with whom.
      expect(JSON.stringify(entry.fields)).not.toMatch(/sybil|victim|user-|VCTM005/);
    }
  });
});
