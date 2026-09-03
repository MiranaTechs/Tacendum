/**
 * THE SIBLING TRANSCRIPT'S PURGE KEY, proved on Node's REAL SQLite engine
 * bound under the recorded op-sqlite mock (the db.seen.test.ts harness),
 * because every claim here is SQL behaviour.
 *
 * A device fan-out's sibling extra — the `x.acct.sync` transcript copy to
 * my own other device — used to be queued with `localMsgId` NULL and a
 * random wire id: nothing tied it to the message it copied, so a message
 * that expired (or was retracted) before the flush still transmitted its
 * transcript. The extra now carries the message's `msgId` in `localMsgId`
 * with `ledger = 0`, so the EXISTING sweepExpired / deleteMessage
 * predicates reach it — while every reader of the delivery ledger
 * (`ledger = 1`) keeps counting peer legs only. */
import * as db from '../src/db';

type Row = Record<string, unknown>;
interface Engine {
  prepare(sql: string): { all(...args: unknown[]): Row[]; run(...args: unknown[]): unknown };
  exec(sql: string): void;
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

function bindRealEngine(): void {
  engine = new DatabaseSync(':memory:');
  const instance = sqlite.open({ name: 'tacendum.sqlite' });
  instance.execute.mockImplementation(async (sql: unknown, params?: unknown[]) => {
    const args = (params ?? []).map(p => (p === undefined ? null : p));
    const rows = engine.prepare(String(sql)).all(...args);
    const changes = engine.prepare('SELECT changes() AS c').all()[0]!.c as number;
    return { rows, rowsAffected: changes };
  });
}

function q(sql: string, ...args: unknown[]): Row[] {
  return engine.prepare(sql).all(...args);
}

const FRIEND = '01HQAAAA00000000000000000A';
const FRIEND_TABLET = '01HQBBBB00000000000000000B';
const MY_TABLET = '01HQTTTT00000000000000000T';
const MSG = '01HQMMMM00000000000000000M';
/** Random-looking wire ids, the shape every extra leg rides. */
const SIBLING_WIRE = '7SIBLINGWIRE0000000000000S';
const PEER_WIRE = '7PEERWIRE00000000000000000P';
const AT = 1_756_000_000_000;

beforeEach(async () => {
  await db.close();
  sqlite.__sqlite.reset();
  db.setWorkspace('real');
  bindRealEngine();
  await db.initDb();
});

afterEach(async () => {
  await db.close();
  engine.close();
});

async function enqueueWithSibling(expiresAt: number | null): Promise<void> {
  await db.upsertChat(FRIEND);
  await db.enqueueOutgoingDeviceFanout(
    { msgId: MSG, peerId: FRIEND, direction: 'out', body: 'hello', ts: AT, status: 'pending', expiresAt },
    { msgType: 'ciphertext', payload: 'UFJJTUFSWQ==', to: FRIEND },
    [
      // The peer's other device: a DELIVERY leg, counted in the ledger.
      { to: FRIEND_TABLET, msgId: PEER_WIRE, msgType: 'ciphertext', payload: 'UEVFUg==', ledger: true },
      // My own other device: the transcript copy, transport only.
      { to: MY_TABLET, msgId: SIBLING_WIRE, msgType: 'ciphertext', payload: 'U0lC', ledger: false },
    ],
  );
}

describe('the outbox row shapes', () => {
  test('every extra carries the message id as its purge key; only the peer leg is in the ledger', async () => {
    await enqueueWithSibling(null);
    const rows = q(`SELECT msgId, peerId, localMsgId, ledger FROM outbox ORDER BY seq`);
    expect(rows).toEqual([
      { msgId: MSG, peerId: FRIEND, localMsgId: null, ledger: 1 },
      { msgId: PEER_WIRE, peerId: FRIEND_TABLET, localMsgId: MSG, ledger: 1 },
      { msgId: SIBLING_WIRE, peerId: MY_TABLET, localMsgId: MSG, ledger: 0 },
    ]);
    // The flush reads the flag off the row.
    const listed = await db.listOutbox();
    expect(listed.find(r => r.msgId === SIBLING_WIRE)?.ledger).toBe(0);
    expect(listed.find(r => r.msgId === PEER_WIRE)?.ledger).toBe(1);
  });

  test('the column is added to an outbox that predates it, defaulting every existing row INTO the ledger', async () => {
    // A file from before the outbox exists without `ledger`, with a room
    // leg already queued. initSchema must migrate it, and the old leg must
    // keep counting.
    await db.close();
    engine.close();
    engine = new DatabaseSync(':memory:');
    engine.exec(`CREATE TABLE outbox (
      msgId TEXT PRIMARY KEY, peerId TEXT NOT NULL, msgType TEXT NOT NULL,
      payload TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
      priority INTEGER NOT NULL DEFAULT 0, urgent INTEGER NOT NULL DEFAULT 0,
      notify INTEGER NOT NULL DEFAULT 1, localMsgId TEXT, seq INTEGER)`);
    engine.prepare(
      `INSERT INTO outbox (msgId, peerId, msgType, payload, localMsgId, seq) VALUES (?, ?, ?, ?, ?, 1)`,
    ).run(PEER_WIRE, FRIEND_TABLET, 'ciphertext', 'UEVFUg==', MSG);
    const instance = sqlite.open({ name: 'tacendum.sqlite' });
    instance.execute.mockImplementation(async (sql: unknown, params?: unknown[]) => {
      const args = (params ?? []).map(p => (p === undefined ? null : p));
      const rows = engine.prepare(String(sql)).all(...args);
      const changes = engine.prepare('SELECT changes() AS c').all()[0]!.c as number;
      return { rows, rowsAffected: changes };
    });
    db.setWorkspace('real');
    await db.initDb();

    const columns = q(`PRAGMA table_info(outbox)`).map(r => r.name);
    expect(columns).toContain('ledger');
    expect(q(`SELECT ledger FROM outbox WHERE msgId = ?`, PEER_WIRE)).toEqual([{ ledger: 1 }]);
  });
});

describe('the ledger never counts the transcript copy', () => {
  test('fanoutDeliveryState and a receipt on the sibling wire id leave the peer ledger alone', async () => {
    await enqueueWithSibling(null);
    expect(await db.fanoutDeliveryState(MSG)).toEqual({
      total: 1,
      queued: 1,
      sent: 0,
      delivered: 0,
      failed: 0,
      failedPeerIds: [],
    });

    // The sibling's receipt is an ordinary envelope receipt: the row is not
    // settled into the ledger, and the follow-up delete removes it.
    await db.applyReceipt(SIBLING_WIRE, 'delivered');
    expect(q(`SELECT attempts, payload FROM outbox WHERE msgId = ?`, SIBLING_WIRE)).toEqual([
      { attempts: 0, payload: 'U0lC' },
    ]);
    await db.deleteOutboxEnvelope(SIBLING_WIRE);
    expect(q(`SELECT msgId FROM outbox WHERE msgId = ?`, SIBLING_WIRE)).toHaveLength(0);
    expect((await db.fanoutDeliveryState(MSG)).total).toBe(1);

    // markLegFailed on the transcript copy is a no-op: it is not a leg.
    await enqueueWithSibling(null).catch(() => undefined);
    await db.markLegFailed(SIBLING_WIRE);
    expect((await db.fanoutDeliveryState(MSG)).failed).toBe(0);
  });
});

describe('the purge reaches the transcript copy', () => {
  test('an expired-before-flush message sends no transcript: the sweep takes the sibling extra with the row', async () => {
    await enqueueWithSibling(AT + 60_000);
    expect(q(`SELECT COUNT(*) AS n FROM outbox`)[0]!.n).toBe(3);

    // Not yet due: everything stays queued.
    expect(await db.sweepExpired(AT + 59_999)).toBe(0);
    expect(q(`SELECT COUNT(*) AS n FROM outbox`)[0]!.n).toBe(3);

    // Due: the row, the peer leg AND the sibling copy all go.
    expect(await db.sweepExpired(AT + 60_000)).toBe(1);
    expect(q(`SELECT msgId FROM outbox`)).toEqual([]);
    expect(q(`SELECT msgId FROM messages WHERE msgId = ?`, MSG)).toEqual([]);
  });

  test('a message retracted before the flush takes its un-sent transcript with it', async () => {
    await enqueueWithSibling(null);
    await db.deleteMessage(MSG, 'out');
    expect(q(`SELECT msgId FROM outbox`)).toEqual([]);
  });
});
