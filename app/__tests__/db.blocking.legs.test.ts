/**
 * BLOCKING × ROOMS — `blockPeer` is leg-aware.
 *
 * `blockPeer` used to run `DELETE FROM outbox WHERE peerId = ?`, and a room
 * fan-out leg's `peerId` IS a member id — so blocking a member with queued
 * room legs hard-deleted those legs. Two consequences, both the failure the design
 * exists to forbid: "Not delivered to N of M" silently lost that member (the
 * denominator shrank), and when it was the last live leg the bubble sat on
 * "Sending…" for ever because nothing recomputed the aggregate.
 *
 * These tests run on Node's REAL SQLite engine, bound under the recorded
 * op-sqlite mock exactly as messaging.groups.send.test.ts does, because the
 * defect and the fix are both SQL behaviour the recording mock cannot see.
 * Every fixture asserts its own precondition before the rule — a leg that
 * never existed proves nothing about not deleting it.
 */
import * as db from '../src/db';

// --- the real engine, bound under the recorded mock -------------------------

type Row = Record<string, unknown>;
interface Engine {
  prepare(sql: string): { all(...args: unknown[]): Row[] };
  close(): void;
}
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (p: string) => Engine;
};

interface FakeDb {
  name: string;
  execute: jest.Mock;
  close: jest.Mock;
}
const sqlite = jest.requireMock('@op-engineering/op-sqlite') as {
  open: (o: { name: string }) => FakeDb;
  __sqlite: { instances: Map<string, FakeDb>; reset: () => void };
};

let engine: Engine;
/** A fault the atomicity test injects: statements matching `on` throw before
 * they reach the engine, exactly like an I/O error mid-transaction. */
const fault = { on: null as RegExp | null };

function bindRealEngine(): void {
  engine = new DatabaseSync(':memory:');
  const instance = sqlite.open({ name: 'tacendum.sqlite' });
  instance.execute.mockImplementation(
    async (sql: unknown, params?: unknown[]) => {
      const s = String(sql);
      if (fault.on?.test(s)) throw new Error('SQLITE_IOERR (injected)');
      const args = (params ?? []).map(p => (p === undefined ? null : p));
      const rows = engine.prepare(s).all(...args);
      const changes = engine.prepare('SELECT changes() AS c').all()[0]!
        .c as number;
      return { rows, rowsAffected: changes };
    },
  );
}

const q = (sql: string, ...args: unknown[]): Row[] =>
  engine.prepare(sql).all(...args);

// --- ids and seeds ----------------------------------------------------------

const pad = (seed: string): string => (seed + '0'.repeat(26)).slice(0, 26);
const ME = pad('ME');
const BEN = pad('BEN'); // the member who gets blocked
const CARA = pad('CARA'); // another member of the same room
const FRAN = pad('FRAN'); // a 1:1 correspondent, never in any room
const ROOM = pad('7R00M');
const AT = 1_700_000_000_000;

let sq = 0;
/** One room fan-out through the REAL enqueueOutgoingFanout: one 'pending'
 * message row parented in the room, one live leg per member. */
async function seedFanout(
  localMsgId: string,
  legs: { msgId: string; peerId: string }[],
): Promise<void> {
  sq += 1;
  await db.enqueueOutgoingFanout(
    {
      msgId: localMsgId,
      peerId: ROOM,
      direction: 'out',
      body: 'hello room',
      ts: 1_000 + sq,
      status: 'pending',
      authorId: ME,
      sq,
    },
    legs.map(l => ({
      msgId: l.msgId,
      peerId: l.peerId,
      msgType: 'ciphertext',
      payload: 'AAAA',
    })),
  );
}

/** One ordinary 1:1 message + envelope through the REAL enqueueOutgoing. */
async function seedOneToOne(msgId: string, peerId: string): Promise<void> {
  await db.enqueueOutgoing(
    { msgId, peerId, direction: 'out', body: 'hi', ts: 500, status: 'pending' },
    { msgType: 'ciphertext', payload: 'BBBB' },
  );
}

const legRow = (msgId: string): Row | undefined =>
  q(
    `SELECT msgId, peerId, payload, attempts, localMsgId FROM outbox
     WHERE msgId = ?`,
    msgId,
  )[0];

const msgStatus = (msgId: string): unknown =>
  q(`SELECT status FROM messages WHERE msgId = ? AND direction = 'out'`, msgId)[0]
    ?.status;

beforeEach(async () => {
  await db.close();
  sqlite.__sqlite.reset();
  fault.on = null;
  sq = 0;
  db.setWorkspace('real');
  bindRealEngine();
  await db.initDb();
});

afterEach(async () => {
  await db.close();
  engine.close();
});

// ---------------------------------------------------------------------------

describe('the harness itself', () => {
  test('the real engine executes the real schema (not a recorded no-op)', () => {
    const tables = q(
      `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`,
    ).map(r => r.name);
    for (const t of ['outbox', 'messages', 'blocked_peers']) {
      expect(tables).toContain(t);
    }
  });
});

describe('blocking a member with queued room legs', () => {
  test('settles the legs as LEG_FAILED — payload cleared, row KEPT — and never deletes them', async () => {
    await seedFanout(`${ME}.01`, [
      { msgId: pad('LEGBEN1'), peerId: BEN },
      { msgId: pad('LEGCARA1'), peerId: CARA },
    ]);
    // Precondition, or the fixture cannot fail: the leg exists, is live, and
    // is a ROOM leg (localMsgId set) addressed to the member being blocked.
    const before = legRow(pad('LEGBEN1'));
    expect(before).toMatchObject({
      peerId: BEN,
      payload: 'AAAA',
      attempts: 0,
      localMsgId: `${ME}.01`,
    });

    await db.blockPeer(BEN, AT);

    const after = legRow(pad('LEGBEN1'));
    expect(after).toBeDefined(); // the row is the ledger — deletion IS the defect
    expect(after!.attempts).toBe(db.LEG_FAILED);
    expect(after!.payload).toBe(''); // a settled leg must never transmit
    expect(await db.getBlockedAt(BEN)).toBe(AT);
    // Blocking BEN must not touch CARA's leg in any way.
    expect(legRow(pad('LEGCARA1'))).toMatchObject({
      peerId: CARA,
      payload: 'AAAA',
      attempts: 0,
    });
  });

  test('the denominator does not shrink: the ledger still names the blocked member', async () => {
    await seedFanout(`${ME}.01`, [
      { msgId: pad('LEGBEN1'), peerId: BEN },
      { msgId: pad('LEGCARA1'), peerId: CARA },
    ]);
    const before = await db.fanoutDeliveryState(`${ME}.01`);
    expect(before).toMatchObject({ total: 2, queued: 2, failed: 0 });

    await db.blockPeer(BEN, AT);

    const state = await db.fanoutDeliveryState(`${ME}.01`);
    // total 2, not 1: "Not delivered to N of M" keeps its M, and the member
    // it was not delivered to is named, not silently omitted.
    expect(state.total).toBe(2);
    expect(state.failed).toBe(1);
    expect(state.failedPeerIds).toContain(BEN);
    expect(state.queued).toBe(1); // CARA's leg is still live
  });

  test("a fan-out whose LAST live leg was the blocked member's reaches 'error', never a permanent 'pending'", async () => {
    // A two-person room: the only leg is BEN's.
    await seedFanout(`${ME}.02`, [{ msgId: pad('LEGBEN2'), peerId: BEN }]);
    expect(msgStatus(`${ME}.02`)).toBe('pending');
    expect(legRow(pad('LEGBEN2'))!.attempts).toBe(0);

    await db.blockPeer(BEN, AT);

    // Nothing will ever settle this fan-out again — the recompute has to
    // happen INSIDE blockPeer, or the bubble reads "Sending…" for ever.
    expect(msgStatus(`${ME}.02`)).toBe('error');
    expect(legRow(pad('LEGBEN2'))).toBeDefined();
  });

  test("a fan-out whose OTHER leg already delivered folds to 'sent' — the failure is carried by the ledger, not a red bubble", async () => {
    await seedFanout(`${ME}.03`, [
      { msgId: pad('LEGBEN3'), peerId: BEN },
      { msgId: pad('LEGCARA3'), peerId: CARA },
    ]);
    await db.applyReceipt(pad('LEGCARA3'), 'delivered');
    expect(legRow(pad('LEGCARA3'))!.attempts).toBe(db.LEG_DELIVERED);
    expect(msgStatus(`${ME}.03`)).toBe('pending'); // BEN's leg still live

    await db.blockPeer(BEN, AT);

    expect(msgStatus(`${ME}.03`)).toBe('sent');
    const state = await db.fanoutDeliveryState(`${ME}.03`);
    expect(state).toMatchObject({ total: 2, delivered: 1, failed: 1 });
    expect(state.failedPeerIds).toEqual([pad('BEN')]);
  });

  test('a fan-out with ANOTHER live leg stays pending — settling one leg must not fabricate an outcome', async () => {
    await seedFanout(`${ME}.04`, [
      { msgId: pad('LEGBEN4'), peerId: BEN },
      { msgId: pad('LEGCARA4'), peerId: CARA },
    ]);
    await db.blockPeer(BEN, AT);
    expect(msgStatus(`${ME}.04`)).toBe('pending');
    expect(legRow(pad('LEGCARA4'))!.attempts).toBe(0);
  });

  test('a leg a receipt already settled is left alone — failure never downgrades an outcome', async () => {
    await seedFanout(`${ME}.05`, [
      { msgId: pad('LEGBEN5'), peerId: BEN },
      { msgId: pad('LEGCARA5'), peerId: CARA },
    ]);
    await db.applyReceipt(pad('LEGBEN5'), 'delivered');
    expect(legRow(pad('LEGBEN5'))!.attempts).toBe(db.LEG_DELIVERED);

    await db.blockPeer(BEN, AT);

    expect(legRow(pad('LEGBEN5'))!.attempts).toBe(db.LEG_DELIVERED);
    const state = await db.fanoutDeliveryState(`${ME}.05`);
    expect(state.failedPeerIds).not.toContain(BEN);
  });
});

describe('1:1 behaviour is unchanged', () => {
  test("an ordinary queued envelope is still deleted and its message marked 'error'; a bystander's is untouched", async () => {
    await seedOneToOne(pad('01MSGBEN'), BEN);
    await seedOneToOne(pad('01MSGFRAN'), FRAN);
    // Precondition: both envelopes are queued, and neither is a room leg.
    expect(legRow(pad('01MSGBEN'))).toMatchObject({
      peerId: BEN,
      localMsgId: null,
    });
    expect(legRow(pad('01MSGFRAN'))).toBeDefined();

    await db.blockPeer(BEN, AT);

    // Deleted, not settled: parking a 1:1 envelope would make unblocking
    // fire a burst of stale messages, which is itself a tell.
    expect(legRow(pad('01MSGBEN'))).toBeUndefined();
    expect(msgStatus(pad('01MSGBEN'))).toBe('error');
    expect(legRow(pad('01MSGFRAN'))).toMatchObject({ payload: 'BBBB' });
    expect(msgStatus(pad('01MSGFRAN'))).toBe('pending');
  });

  test('blocking someone with NO room legs behaves exactly as before', async () => {
    await seedOneToOne(pad('01MSGBEN'), BEN);
    await seedFanout(`${ME}.06`, [{ msgId: pad('LEGCARA6'), peerId: CARA }]);

    await db.blockPeer(BEN, AT);

    expect(await db.getBlockedAt(BEN)).toBe(AT);
    expect(legRow(pad('01MSGBEN'))).toBeUndefined();
    expect(msgStatus(pad('01MSGBEN'))).toBe('error');
    // No stray settle anywhere: no outbox row moved to a sentinel state, and
    // the unrelated fan-out is exactly as it was.
    expect(q(`SELECT COUNT(*) AS c FROM outbox WHERE attempts < 0`)[0]!.c).toBe(0);
    expect(legRow(pad('LEGCARA6'))).toMatchObject({ payload: 'AAAA', attempts: 0 });
    expect(msgStatus(`${ME}.06`)).toBe('pending');
  });
});

describe('one transaction (a half-applied block would be worse than the defect)', () => {
  test('a failure part-way leaves NEITHER the block, NOR the settle, NOR the purge', async () => {
    await seedFanout(`${ME}.07`, [{ msgId: pad('LEGBEN7'), peerId: BEN }]);
    await seedOneToOne(pad('01MSGBEN'), BEN);
    expect(legRow(pad('LEGBEN7'))!.attempts).toBe(0);
    expect(legRow(pad('01MSGBEN'))).toBeDefined();

    // Fail the LAST statement of the transaction — the 1:1 'error' rewrite —
    // so everything before it (block row, purge, settle, aggregate) has
    // already applied and must be rolled back by the real engine.
    fault.on = /AND status = 'pending'/;
    await expect(db.blockPeer(BEN, AT)).rejects.toThrow(/SQLITE_IOERR/);
    fault.on = null;

    expect(await db.getBlockedAt(BEN)).toBeNull();
    expect(q(`SELECT COUNT(*) AS c FROM blocked_peers`)[0]!.c).toBe(0);
    // The leg is live again — payload intact, no LEG_FAILED sentinel…
    expect(legRow(pad('LEGBEN7'))).toMatchObject({ payload: 'AAAA', attempts: 0 });
    // …the 1:1 envelope is back…
    expect(legRow(pad('01MSGBEN'))).toMatchObject({ payload: 'BBBB' });
    // …and no message row moved.
    expect(msgStatus(`${ME}.07`)).toBe('pending');
    expect(msgStatus(pad('01MSGBEN'))).toBe('pending');
  });
});
