/**
 * CONTACT PROVENANCE: `chats.introducedBy`
 * records HOW a conversation came to exist on this phone — a QR the other
 * person handed over, an id typed by hand, or a server-resolved discovery
 * lookup — so a discovery-introduced chat can carry its own reminder until
 * the safety number is verified.
 *
 * What these pin:
 *  - the column is an ADDITIVE, nullable TEXT migration with no backfill:
 *    NULL means "predates provenance" and reads as non-discovery, so an
 *    existing install wakes up with every chat unbannered;
 *  - the explicit reader column list names it (the disappearing-message
 *    pair was once added to the ALTER list and forgotten here);
 *  - `upsertChat` stamps provenance on INSERT and never rewrites a recorded
 *    one on conflict — the first introduction is the one that happened;
 *  - `serverIntroduced` is the ONE predicate the banner asks, and it is
 *    designed open: 'discovery-username' is a server introduction
 *    without any change here.
 *
 * Harness follows db.pairsafety.test.ts: the fake op-sqlite records
 * statements; assertions read the SQL and its parameters by position.
 */
import * as db from '../src/db';

interface FakeDb {
  name: string;
  execute: jest.Mock;
  close: jest.Mock;
}
const sqlite = (
  jest.requireMock('@op-engineering/op-sqlite') as {
    __sqlite: { instances: Map<string, FakeDb>; reset: () => void };
  }
).__sqlite;

const REAL = 'tacendum.sqlite';
const PEER = '01BX5ZZKBKACTAV9WEVGEMMVRZ';

function calls(name = REAL): Array<[string, unknown[]]> {
  return (sqlite.instances.get(name)?.execute.mock.calls ?? []).map(c => [
    String(c[0]),
    (c[1] ?? []) as unknown[],
  ]);
}
/** Statements issued from this point on. */
function since(name = REAL): () => Array<[string, unknown[]]> {
  const mark = calls(name).length;
  return () => calls(name).slice(mark);
}

beforeEach(async () => {
  await db.close();
  sqlite.reset();
  db.setWorkspace('real');
  await db.initDb();
});

afterEach(async () => {
  await db.close();
});

describe('the migration', () => {
  it('adds introducedBy as a plain nullable TEXT column — no DEFAULT, no CHECK', () => {
    const alters = calls()
      .map(([sql]) => sql)
      .filter(sql => /ALTER TABLE chats ADD COLUMN introducedBy/.test(sql));
    expect(alters).toHaveLength(1);
    expect(alters[0]).toMatch(/introducedBy TEXT\s*$/);
    expect(alters[0]).not.toMatch(/DEFAULT|CHECK/i);
  });

  it('writes NO provenance onto existing rows: nothing during init spells a discovery kind', () => {
    for (const [sql, params] of calls()) {
      expect(sql).not.toMatch(/discovery/);
      expect(JSON.stringify(params)).not.toMatch(/discovery/);
    }
  });

  it('is named in the explicit reader column list', async () => {
    const after = since();
    await db.getChat(PEER);
    await db.listChats();
    const selects = after().map(([sql]) => sql);
    expect(selects).toHaveLength(2);
    for (const sql of selects) expect(sql).toMatch(/\bintroducedBy\b/);
  });
});

describe('upsertChat', () => {
  it('stamps the provenance on INSERT, as the last parameter', async () => {
    const after = since();
    await db.upsertChat(PEER, undefined, 'discovery');
    const [[sql, params]] = after();
    expect(sql).toMatch(/INSERT INTO chats \(peerId, displayName, createdAt, introducedBy\)/);
    expect(params[0]).toBe(PEER);
    expect(params).toHaveLength(4);
    expect(params[3]).toBe('discovery');
  });

  it('records NULL when the caller says nothing — the inbound-message path never claims a provenance', async () => {
    const after = since();
    await db.upsertChat(PEER);
    const [[, params]] = after();
    expect(params).toHaveLength(4);
    expect(params[3]).toBeNull();
  });

  it('keeps the FIRST recorded provenance on conflict — a later introduction cannot rewrite how a chat began', async () => {
    const after = since();
    await db.upsertChat(PEER, undefined, 'qr');
    const [[sql]] = after();
    expect(sql).toMatch(
      /introducedBy = COALESCE\(chats\.introducedBy, excluded\.introducedBy\)/,
    );
  });
});

describe('serverIntroduced — the one predicate the banner asks', () => {
  it('is true for the shipped discovery classes', () => {
    expect(db.serverIntroduced('discovery')).toBe(true);
  });

  it('is designed open: the username kind is a server introduction with no change here', () => {
    expect(db.serverIntroduced('discovery-username')).toBe(true);
  });

  it('is false for a hand-off, a typed id, and a row that predates provenance', () => {
    expect(db.serverIntroduced('qr')).toBe(false);
    expect(db.serverIntroduced('manual')).toBe(false);
    expect(db.serverIntroduced(null)).toBe(false);
    expect(db.serverIntroduced(undefined)).toBe(false);
  });
});
