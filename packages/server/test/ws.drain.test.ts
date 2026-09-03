import { describe, expect, it } from 'vitest';
import { monotonicFactory } from 'ulid';
import type { ServerFrame } from '@tacendum/shared';
import {
  DRAIN_RECEIPT_LOOKUP_CAP,
  DRAIN_SLICE_BUDGET,
  DRAIN_URGENT_LANE,
  drainQueuedMessages,
} from '../src/handlers/ws.js';
import type { TestOnlyDataLayer, QueuedMessage } from '../src/db/data.js';
import { makeMemoryDb, makeTestDeps } from './helpers.js';

/**
 * Two drain behaviours the reconnect replay lacked.
 *
 * The urgent lane: the queue was walked strictly in msgId order
 * at ~10 ms a post, 2 000 posts a slice. A callee reconnecting behind a large
 * backlog got the VoIP push, CallKit showed the placeholder, the app connected
 * — and the `call.offer` arrived after the backlog, past the CallKit watchdog
 * and past `offerIsRingable`: a "missed call" placeholder while the caller sat
 * in "Calling…". The row never recorded `urgent`, so the drain could not even
 * find the offer. Now a fresh drain posts the partition's urgent rows FIRST (a
 * bounded lane), then the ordered walk, skipping what the lane already posted.
 *
 * The delivery receipt: the server posted exactly one receipt per send — `sent`
 * when the recipient was offline — and nothing at drain, so a message queued
 * while the peer was away stayed `sent` on the sender's screen forever (and
 * the client's read-receipt path, gated on `delivered`, discarded the peer's
 * read). The drain now posts the `delivered` receipt `handleSend` would have
 * posted, to the sender's live socket, best-effort. */

/** Monotonic so msgIds minted in the same millisecond still sort in order. */
const ulid = monotonicFactory();
const B64 = 'Y2lwaGVydGV4dA=='; // "ciphertext"
const RECIPIENT = 'user-drain-recipient';
const CONN = 'conn-recipient';

/** Wide enough for a 3 000-row backlog from ONE sender: the default stranger
 * caps (500 per unknown pair) are the quota suite's concern, not this one's. */
const WIDE_QUOTA = {
  items: 10_000,
  bytes: 64 * 1024 * 1024,
  unknownItems: 10_000,
  unknownBytes: 64 * 1024 * 1024,
  unknownTotalItems: 10_000,
  unknownTotalBytes: 64 * 1024 * 1024,
};

type Posted = { connectionId: string; frame: ServerFrame };
const idOf = (p: Posted): string => ('msgId' in p.frame ? p.frame.msgId : '');

/** A transport that records every post in order. `dead` sockets answer
 * false (Gone); `faulting` sockets throw a management-API throttle. */
function collector() {
  const posted: Posted[] = [];
  const attempts: string[] = [];
  const dead = new Set<string>();
  const faulting = new Set<string>();
  return {
    posted,
    attempts,
    dead,
    faulting,
    sender: {
      async post(connectionId: string, frame: ServerFrame): Promise<boolean> {
        attempts.push(connectionId);
        if (faulting.has(connectionId)) {
          throw Object.assign(new Error('rate exceeded'), { name: 'LimitExceededException' });
        }
        if (dead.has(connectionId)) return false;
        posted.push({ connectionId, frame });
        return true;
      },
    },
  };
}

function setup() {
  const db: TestOnlyDataLayer = makeMemoryDb(WIDE_QUOTA);
  const deps = makeTestDeps(db);
  const nowSec = () => Math.floor(deps.now() / 1000);
  async function seed(
    senderId: string,
    opts: { urgent?: true; expiresAt?: number; type?: QueuedMessage['type'] } = {},
  ): Promise<QueuedMessage> {
    const msg: QueuedMessage = {
      recipientId: RECIPIENT,
      msgId: ulid(),
      senderId,
      type: opts.type ?? 'ciphertext',
      payload: B64,
      ts: deps.now(),
      expiresAt: opts.expiresAt ?? nowSec() + 3600,
      ...(opts.urgent ? { urgent: true as const } : {}),
    };
    await db.enqueueMessage(msg, opts.type === 'accounts' ? { serverMinted: true } : undefined);
    return msg;
  }
  async function online(userId: string, connectionId: string, sessionDigest?: string) {
    await db.putConnection({
      userId,
      connectionId,
      connectedAt: deps.now(),
      ...(sessionDigest !== undefined ? { sessionDigest } : {}),
    });
  }
  const drainDeps = (sender: ReturnType<typeof collector>['sender']) => ({
    db,
    sender,
    now: deps.now,
    log: deps.log,
  });
  return { db, deps, nowSec, seed, online, drainDeps };
}

describe('the urgent lane (server)', () => {
  it('an urgent row behind 3 000 ordinary rows posts FIRST, inside the first slice', async () => {
    const { seed, drainDeps } = setup();
    const ordered: string[] = [];
    for (let i = 0; i < 3000; i++) ordered.push((await seed('sender-a')).msgId);
    const offer = await seed('caller', { urgent: true });
    const { posted, sender } = collector();

    const result = await drainQueuedMessages(RECIPIENT, CONN, drainDeps(sender), DRAIN_SLICE_BUDGET);

    expect(idOf(posted[0]!)).toBe(offer.msgId);
    // The lane's post counts toward the slice's item budget: one urgent row
    // plus 1 999 ordered rows, and the cursor is the last ORDERED post.
    expect(posted).toHaveLength(DRAIN_SLICE_BUDGET.maxItems);
    expect(posted.slice(1).map(idOf)).toEqual(ordered.slice(0, DRAIN_SLICE_BUDGET.maxItems - 1));
    expect(result).toEqual({
      outcome: 'budget_exhausted',
      cursor: ordered[DRAIN_SLICE_BUDGET.maxItems - 2],
      postedItems: DRAIN_SLICE_BUDGET.maxItems,
      postedBytes: DRAIN_SLICE_BUDGET.maxItems * B64.length,
    });
  });

  it('a continuation runs no lane — the fresh slice already posted the urgent rows', async () => {
    const { db, seed, drainDeps } = setup();
    const first = await seed('sender-a');
    await seed('caller', { urgent: true });
    let laneQueries = 0;
    const original = db.listUrgentQueuedMessages.bind(db);
    db.listUrgentQueuedMessages = (recipientId, maxScanned) => {
      laneQueries += 1;
      return original(recipientId, maxScanned);
    };
    const { sender } = collector();

    await drainQueuedMessages(RECIPIENT, CONN, drainDeps(sender), DRAIN_SLICE_BUDGET, first.msgId);
    expect(laneQueries).toBe(0);
    await drainQueuedMessages(RECIPIENT, CONN, drainDeps(sender), DRAIN_SLICE_BUDGET);
    expect(laneQueries).toBe(1);
  });

  it('never posts a lane row twice in one slice, and the cursor still passes it', async () => {
    const { seed, drainDeps } = setup();
    const u1 = await seed('caller', { urgent: true });
    const n1 = await seed('sender-a');
    const n2 = await seed('sender-a');
    const n3 = await seed('sender-a');
    const budget = { maxItems: 2, maxBytes: 1024 * 1024 };
    const { posted, sender } = collector();

    const slice1 = await drainQueuedMessages(RECIPIENT, CONN, drainDeps(sender), budget);
    expect(posted.map(idOf)).toEqual([u1.msgId, n1.msgId]);
    expect(slice1).toMatchObject({ outcome: 'budget_exhausted', cursor: n1.msgId, postedItems: 2 });

    const slice2 = await drainQueuedMessages(RECIPIENT, CONN, drainDeps(sender), budget, n1.msgId);
    expect(posted.map(idOf)).toEqual([u1.msgId, n1.msgId, n2.msgId, n3.msgId]);
    expect(slice2).toMatchObject({ outcome: 'complete', postedItems: 2 });
  });

  it('skips an expired urgent row — expired ciphertext is never replayed, lane or walk', async () => {
    const { seed, nowSec, drainDeps } = setup();
    await seed('caller', { urgent: true, expiresAt: nowSec() });
    const live = await seed('sender-a');
    const { posted, sender } = collector();

    const result = await drainQueuedMessages(RECIPIENT, CONN, drainDeps(sender), DRAIN_SLICE_BUDGET);
    expect(posted.map(idOf)).toEqual([live.msgId]);
    expect(result).toMatchObject({ outcome: 'complete', postedItems: 1 });
  });

  it('caps the lane at DRAIN_URGENT_LANE.maxItems and hands the rest to the ordered walk', async () => {
    const { seed, drainDeps } = setup();
    const n0 = await seed('sender-a');
    const urgent: string[] = [];
    for (let i = 0; i < DRAIN_URGENT_LANE.maxItems + 3; i++) {
      urgent.push((await seed('caller', { urgent: true })).msgId);
    }
    const { posted, sender } = collector();

    const result = await drainQueuedMessages(RECIPIENT, CONN, drainDeps(sender), DRAIN_SLICE_BUDGET);
    expect(posted.map(idOf)).toEqual([
      ...urgent.slice(0, DRAIN_URGENT_LANE.maxItems),
      n0.msgId,
      ...urgent.slice(DRAIN_URGENT_LANE.maxItems),
    ]);
    expect(result).toMatchObject({ outcome: 'complete', postedItems: urgent.length + 1 });
  });

  it('a dead socket mid-lane reports socket_gone like the walk does', async () => {
    const { seed, drainDeps } = setup();
    await seed('caller', { urgent: true });
    await seed('sender-a');
    const { sender, dead } = collector();
    dead.add(CONN);
    const result = await drainQueuedMessages(RECIPIENT, CONN, drainDeps(sender), DRAIN_SLICE_BUDGET);
    expect(result).toEqual({ outcome: 'socket_gone', postedItems: 0, postedBytes: 0 });
  });
});

describe('the delivered receipt at drain', () => {
  it('each drained message earns its sender a delivered receipt on the sender’s live socket, after the recipient’s copy', async () => {
    const { seed, online, drainDeps } = setup();
    await online('sender-a', 'conn-a');
    const m1 = await seed('sender-a');
    const m2 = await seed('sender-a');
    const { posted, sender } = collector();

    const result = await drainQueuedMessages(RECIPIENT, CONN, drainDeps(sender), DRAIN_SLICE_BUDGET);

    expect(posted).toEqual([
      { connectionId: CONN, frame: expect.objectContaining({ type: 'msg', msgId: m1.msgId }) },
      { connectionId: 'conn-a', frame: { type: 'receipt', msgId: m1.msgId, state: 'delivered' } },
      { connectionId: CONN, frame: expect.objectContaining({ type: 'msg', msgId: m2.msgId }) },
      { connectionId: 'conn-a', frame: { type: 'receipt', msgId: m2.msgId, state: 'delivered' } },
    ]);
    // Receipts are not delivery: the slice's own accounting counts messages.
    expect(result).toEqual({ outcome: 'complete', postedItems: 2, postedBytes: 2 * B64.length });
  });

  it('the lane’s urgent post earns its sender a receipt too', async () => {
    const { seed, online, drainDeps } = setup();
    await online('caller', 'conn-caller');
    await seed('sender-a');
    const offer = await seed('caller', { urgent: true });
    const { posted, sender } = collector();

    await drainQueuedMessages(RECIPIENT, CONN, drainDeps(sender), DRAIN_SLICE_BUDGET);
    expect(posted[0]).toEqual({
      connectionId: CONN,
      frame: expect.objectContaining({ type: 'msg', msgId: offer.msgId }),
    });
    expect(posted[1]).toEqual({
      connectionId: 'conn-caller',
      frame: { type: 'receipt', msgId: offer.msgId, state: 'delivered' },
    });
  });

  it('an offline sender gets nothing; the drain neither fails nor deletes', async () => {
    const { db, seed, drainDeps } = setup();
    const m1 = await seed('sender-a');
    const { posted, sender } = collector();

    const result = await drainQueuedMessages(RECIPIENT, CONN, drainDeps(sender), DRAIN_SLICE_BUDGET);
    expect(posted.map((p) => p.connectionId)).toEqual([CONN]);
    expect(result).toMatchObject({ outcome: 'complete', postedItems: 1 });
    expect(await db.getQueuedMessage(RECIPIENT, m1.msgId)).toBeDefined();
  });

  it('looks a sender’s socket up ONCE per distinct sender per slice', async () => {
    const { db, seed, online, drainDeps } = setup();
    await online('sender-a', 'conn-a');
    await online('sender-b', 'conn-b');
    for (let i = 0; i < 10; i++) await seed(i % 2 === 0 ? 'sender-a' : 'sender-b');
    const lookups: string[] = [];
    const original = db.getConnection.bind(db);
    db.getConnection = async (userId) => {
      lookups.push(userId);
      return original(userId);
    };
    const { posted, sender } = collector();

    await drainQueuedMessages(RECIPIENT, CONN, drainDeps(sender), DRAIN_SLICE_BUDGET);
    expect(lookups.sort()).toEqual(['sender-a', 'sender-b']);
    expect(posted.filter((p) => p.frame.type === 'receipt')).toHaveLength(10);
  });

  it('a Gone sender socket: one attempt, no receipt, NO reap, and the drain completes', async () => {
    const { db, seed, online, drainDeps } = setup();
    await online('sender-a', 'conn-a');
    await seed('sender-a');
    await seed('sender-a');
    const { posted, attempts, dead, sender } = collector();
    dead.add('conn-a');

    const result = await drainQueuedMessages(RECIPIENT, CONN, drainDeps(sender), DRAIN_SLICE_BUDGET);
    expect(result).toMatchObject({ outcome: 'complete', postedItems: 2 });
    expect(posted.map((p) => p.connectionId)).toEqual([CONN, CONN]);
    expect(attempts.filter((c) => c === 'conn-a')).toHaveLength(1);
    // The drain deletes nothing — connection rows included; a real send's
    // Gone post reaps the row under the grace rule, this path does not.
    expect((await db.getConnection('sender-a'))?.connectionId).toBe('conn-a');
  });

  it('a faulting receipt post is logged by error class only and never fails the drain', async () => {
    const { deps, seed, online, drainDeps } = setup();
    await online('sender-a', 'conn-a');
    const m1 = await seed('sender-a');
    await seed('sender-a');
    const { posted, attempts, faulting, sender } = collector();
    faulting.add('conn-a');

    const result = await drainQueuedMessages(RECIPIENT, CONN, drainDeps(sender), DRAIN_SLICE_BUDGET);
    expect(result).toMatchObject({ outcome: 'complete', postedItems: 2 });
    expect(posted.map((p) => p.connectionId)).toEqual([CONN, CONN]);
    // One fault silences that sender for the slice.
    expect(attempts.filter((c) => c === 'conn-a')).toHaveLength(1);
    const faults = deps.logs.filter((l) => l.event === 'ws_drain_receipt_post_failed');
    expect(faults).toEqual([
      { event: 'ws_drain_receipt_post_failed', fields: { error: 'LimitExceededException' } },
    ]);
    expect(JSON.stringify(deps.logs)).not.toContain(m1.msgId);
    expect(JSON.stringify(deps.logs)).not.toContain(B64);
  });

  it('a faulting connection lookup is swallowed the same way', async () => {
    const { db, deps, seed, drainDeps } = setup();
    await seed('sender-a');
    db.getConnection = async () => {
      throw Object.assign(new Error('unavailable'), { name: 'ProvisionedThroughputExceededException' });
    };
    const { posted, sender } = collector();

    const result = await drainQueuedMessages(RECIPIENT, CONN, drainDeps(sender), DRAIN_SLICE_BUDGET);
    expect(result).toMatchObject({ outcome: 'complete', postedItems: 1 });
    expect(posted.map((p) => p.connectionId)).toEqual([CONN]);
    expect(deps.logs.filter((l) => l.event === 'ws_drain_receipt_lookup_failed')).toEqual([
      {
        event: 'ws_drain_receipt_lookup_failed',
        fields: { error: 'ProvisionedThroughputExceededException' },
      },
    ]);
  });

  it('a server-minted accounts notice earns no receipt', async () => {
    const { seed, online, drainDeps } = setup();
    await online('revoked-member', 'conn-m');
    await seed('revoked-member', { type: 'accounts' });
    const { posted, sender } = collector();

    await drainQueuedMessages(RECIPIENT, CONN, drainDeps(sender), DRAIN_SLICE_BUDGET);
    expect(posted.map((p) => [p.connectionId, p.frame.type])).toEqual([[CONN, 'accounts']]);
  });

  it('on a session-enforcing host a digestless or revoked sender socket gets no receipt', async () => {
    const { seed, online, drainDeps } = setup();
    await online('sender-live', 'conn-live', 'digest-live');
    await online('sender-revoked', 'conn-revoked', 'digest-revoked');
    await online('sender-digestless', 'conn-digestless');
    await seed('sender-live');
    await seed('sender-revoked');
    await seed('sender-digestless');
    const guard = { active: async (digest: string) => digest === 'digest-live' || digest === 'me' };
    const { posted, sender } = collector();

    const result = await drainQueuedMessages(
      RECIPIENT,
      CONN,
      drainDeps(sender),
      DRAIN_SLICE_BUDGET,
      undefined,
      { guard, digest: 'me' },
    );
    expect(result).toMatchObject({ outcome: 'complete', postedItems: 3 });
    expect(posted.filter((p) => p.frame.type === 'receipt').map((p) => p.connectionId)).toEqual([
      'conn-live',
    ]);
  });

  it('bounds the socket lookups per slice at DRAIN_RECEIPT_LOOKUP_CAP', async () => {
    const { db, seed, online, drainDeps } = setup();
    const senders: string[] = [];
    for (let i = 0; i < DRAIN_RECEIPT_LOOKUP_CAP + 1; i++) {
      const id = `sender-${String(i).padStart(3, '0')}`;
      senders.push(id);
      await online(id, `conn-${id}`);
      await seed(id);
    }
    let lookups = 0;
    const original = db.getConnection.bind(db);
    db.getConnection = async (userId) => {
      lookups += 1;
      return original(userId);
    };
    const { posted, sender } = collector();

    const result = await drainQueuedMessages(RECIPIENT, CONN, drainDeps(sender), DRAIN_SLICE_BUDGET);
    expect(result).toMatchObject({ outcome: 'complete', postedItems: senders.length });
    expect(lookups).toBe(DRAIN_RECEIPT_LOOKUP_CAP);
    // Every message drained; the sender past the cap simply gets no receipt
    // this slice.
    expect(posted.filter((p) => p.frame.type === 'msg')).toHaveLength(senders.length);
    expect(posted.filter((p) => p.frame.type === 'receipt')).toHaveLength(DRAIN_RECEIPT_LOOKUP_CAP);
  });
});
