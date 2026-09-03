/**
 * THE `seen` PRUNE — proved on Node's REAL SQLite engine bound under the
 * recorded op-sqlite mock (the db.consent.test.ts harness), because the
 * defect is SQL behaviour the recording mock cannot see.
 *
 * `markSeen` keeps the table bounded by deleting everything outside the
 * newest 5000 rows. "Newest" used to mean `ORDER BY msgId DESC`, and that is
 * wrong for one reason the shipping wire makes unavoidable: room legs,
 * device fan-out extras and every `x.acct.*` carrier ride pure-CSPRNG ids
 * (`randomMsgId`: first char '0'–'7', the rest uniform Crockford), ~99 % of
 * which sort ABOVE any time-ordered 2026 ULID (`01K…`). Once 5000 random ids
 * exist, an id-ordered prune evicts every ULID-keyed row — including the row
 * `markSeen` just inserted — so 1:1 redelivery dedup switches off and the
 * NSE spool is re-imported on every launch.
 *
 * The prune now orders by `ts`, which every caller stamps with THIS device's
 * clock at processing time — so the row just written is always the newest,
 * whatever its id looks like. */
import { randomMsgId } from '@tacendum/shared/msgid';
import * as db from '../src/db';

// The app's tsconfig carries no Node types; the engine and the CSPRNG are
// pulled in the way the db.consent harness pulls node:sqlite.
const { randomBytes: nodeRandomBytes } = require('node:crypto') as {
  randomBytes: (n: number) => Uint8Array;
};

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

/** A genuine 2026-shaped ULID — the id every 1:1 frame carries. */
const ULID = '01KYDBSSDJSPC9J0E5N2AWMJ5Y';
const AT = 1_756_000_000_000;

const csprng = async (n: number): Promise<Uint8Array> => new Uint8Array(nodeRandomBytes(n));

function seenCount(): number {
  return engine.prepare('SELECT COUNT(*) AS n FROM seen').all()[0]!.n as number;
}

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

describe('markSeen prunes by insertion time, never by id order', () => {
  test('a ULID marked after 5000 CSPRNG ids survives its own markSeen — and the next one', async () => {
    // 5000 random wire ids, all seen BEFORE the ULID (older ts). Seeded
    // straight into the engine: 5000 round trips through the prune would
    // prove the same thing at a hundred times the cost.
    const insert = engine.prepare('INSERT OR IGNORE INTO seen (msgId, ts) VALUES (?, ?)');
    let above = 0;
    for (let i = 0; i < 5000; i++) {
      const id = await randomMsgId(csprng);
      if (id > ULID) above += 1;
      insert.run(id, AT - 5000 + i);
    }
    // PRECONDITION, stated so the test cannot pass vacuously: the random ids
    // really do sort above the ULID (the property the old prune tripped on).
    expect(above).toBeGreaterThan(4900);
    expect(seenCount()).toBe(5000);

    await db.markSeen(ULID, AT);
    expect(await db.hasSeen(ULID)).toBe(true);
    expect(seenCount()).toBe(5000);

    // One more random id, newer still: the ULID is the SECOND newest row and
    // must survive again; what leaves is the OLDEST row, by ts.
    const later = await randomMsgId(csprng);
    await db.markSeen(later, AT + 1);
    expect(await db.hasSeen(ULID)).toBe(true);
    expect(await db.hasSeen(later)).toBe(true);
    expect(seenCount()).toBe(5000);
    const oldest = engine
      .prepare('SELECT MIN(ts) AS t FROM seen')
      .all()[0]!.t as number;
    // The two oldest seeded rows (ts AT-5000, AT-4999) are the two evicted.
    expect(oldest).toBe(AT - 4998);
  });

  test('the table carries an index on ts so the prune is not a full sort per frame', async () => {
    const indexes = engine
      .prepare(`SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'seen'`)
      .all()
      .map(r => String(r.sql ?? ''));
    expect(indexes.some(sql => /\(\s*ts\b/.test(sql))).toBe(true);
  });
});
