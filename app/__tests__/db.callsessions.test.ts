import * as db from '../src/db';

/**
 * SMALL-GROUP CALL SCHEMA.
 *
 * Three claims, and the third is the reason this file exists at all:
 *
 *  1. The migration is ADDITIVE — a file already holding real call history
 *     gains `call_sessions` and two `call_log` columns and loses nothing. No
 *     DROP, no DELETE, no PK rebuild.
 *  2. The row is written before the ring and taken by SESSION
 *     (the cid-keyed take was the bug).
 *  3. **`call_sessions` JOINS `DB_TABLES`.** The original design said calls
 *     needed no decoy work. That was true of `call_log` and `call_offers` and
 *     is NOT true of this table: a session row is a real room's call ROSTER —
 *     who was on a call with whom — and a table outside `DB_TABLES` survives
 *     sign-out into the decoy workspace, handing a coerced unlock exactly the
 *     membership the decoy exists to hide.
 *
 * Harness follows db.calllog.test.ts: the mock records the SQL each call
 * actually issued, so stripping a clause from db.ts changes what these
 * assertions see rather than passing silently.
 */

interface FakeDb {
  name: string;
  execute: jest.Mock;
  close: jest.Mock;
}
const sqlite = (
  jest.requireMock('@op-engineering/op-sqlite') as {
    __sqlite: {
      opened: string[];
      instances: Map<string, FakeDb>;
      reset: () => void;
    };
  }
).__sqlite;

const REAL = 'tacendum.sqlite';
const DECOY = 'tacendum-decoy.sqlite';

function sqlOf(name = REAL): string[] {
  return (sqlite.instances.get(name)?.execute.mock.calls ?? []).map(c => String(c[0]));
}
function callsMatching(re: RegExp, name = REAL): unknown[][] {
  return (sqlite.instances.get(name)?.execute.mock.calls ?? []).filter(c =>
    re.test(String(c[0])),
  );
}
/** Statements issued from this point on. */
function since(name = REAL): () => string[] {
  const mark = sqlOf(name).length;
  return () => sqlOf(name).slice(mark);
}

const SID = '01SESSION0000000000000000A';
const STARTER = '01STARTER0000000000000000A';
const B = '01BBBBBBB0000000000000000A';
const AT = 1_800_000_000_000;

beforeEach(async () => {
  await db.close();
  db.setWorkspace('real');
  sqlite.reset();
});

describe('the schema', () => {
  it('creates call_sessions with the roster and the epoch it must survive on', async () => {
    await db.initDb();
    const create = sqlOf().find(s => s.includes('CREATE TABLE IF NOT EXISTS call_sessions'));
    expect(create).toBeDefined();
    expect(create!).toMatch(/sid\s+TEXT PRIMARY KEY/);
    // frame.from of the accepted ginvite, never a payload field — the same
    // rule `groups.ownerId` carries, and NOT NULL because a session with no
    // starter has no roster authority at all.
    expect(create!).toMatch(/starterId TEXT NOT NULL/);
    expect(create!).toMatch(/roster\s+TEXT NOT NULL/);
    expect(create!).toMatch(/se\s+INTEGER NOT NULL/);
    // Nullable: an ad-hoc picker call belongs to no room.
    expect(create!).toMatch(/roomId\s+TEXT(?!\s+NOT NULL)/);
  });

  it('adds the sid and sessionId columns additively — no DROP, no DELETE', async () => {
    await db.initDb();
    const sql = sqlOf();
    expect(sql.some(s => /ALTER TABLE call_offers ADD COLUMN sid/.test(s))).toBe(true);
    expect(sql.some(s => /ALTER TABLE call_log ADD COLUMN sessionId/.test(s))).toBe(true);
    expect(sql.some(s => /ALTER TABLE call_log ADD COLUMN roomId/.test(s))).toBe(true);
    expect(sql.filter(s => /^\s*(DROP TABLE|DELETE FROM)/m.test(s))).toEqual([]);
  });

  it('every ALTER is behind a PRAGMA guard — the messages idiom, not a blind ALTER', async () => {
    // A blind `ALTER TABLE … ADD COLUMN` throws on the second boot and takes
    // the whole schema pass with it, so the guard is the migration. What the
    // mock can honestly answer is that the guard is CONSULTED before the
    // ALTER; that the guard's verdict is obeyed is proved on the real engine.
    await db.initDb();
    const sql = sqlOf();
    for (const [table, column] of [
      ['call_log', 'sessionId'],
      ['call_log', 'roomId'],
      ['call_offers', 'sid'],
    ] as const) {
      const pragma = sql.findIndex(s => s.includes(`PRAGMA table_info(${table})`));
      const alter = sql.findIndex(s =>
        new RegExp(`ALTER TABLE ${table} ADD COLUMN ${column}`).test(s),
      );
      expect(pragma).toBeGreaterThanOrEqual(0);
      expect(alter).toBeGreaterThan(pragma);
    }
  });
});

describe('DB_TABLES — the privacy net (departure 9)', () => {
  it('names call_sessions', () => {
    // THE assertion. Forgetting this one line means sign-out, account
    // deletion and inconsistent-boot recovery all leave a real call roster in
    // plaintext SQLite, and a decoy rebuild inherits it.
    expect(db.DB_TABLES).toContain('call_sessions');
  });

  it('sign-out actually issues the DELETE against the active workspace', async () => {
    await db.initDb();
    const later = since();
    await db.clearLocalState();
    expect(later().some(s => /DELETE FROM call_sessions/.test(s))).toBe(true);
  });

  it('a DURESS sign-out clears the decoy file’s sessions, not the real one’s', async () => {
    // The wipe runs against whatever workspace is open, which in a duress
    // session is the decoy — so a session fabricated under duress goes with
    // the rest of that world.
    db.setWorkspace('decoy');
    await db.initDb();
    await db.clearLocalState();
    expect(callsMatching(/DELETE FROM call_sessions/, DECOY).length).toBe(1);
  });

  it('FALSIFIER: the completeness test is what catches a forgotten line', async () => {
    // db.groups.test.ts holds "every CREATE TABLE in initSchema is in
    // DB_TABLES". Run at authoring time by deleting 'call_sessions' from the
    // list in db.ts: that test failed with call_sessions in the created set
    // and not in the list, and the two assertions above failed too. Restored.
    // Kept here as the standing shape of the invariant.
    await db.initDb();
    const created = sqlOf()
      .map(s => /CREATE TABLE IF NOT EXISTS (\w+)/.exec(s)?.[1])
      .filter((t): t is string => t !== undefined);
    expect(created).toContain('call_sessions');
    expect(new Set(created)).toEqual(new Set(db.DB_TABLES));
  });
});

describe('reading and writing a session', () => {
  it('upserts on sid: the roster and the epoch move, the start time does not', async () => {
    await db.initDb();
    await db.saveCallSession({
      sid: SID,
      roomId: null,
      starterId: STARTER,
      roster: [STARTER, B],
      se: 0,
      video: false,
      startedAt: AT,
    });
    const [sql, args] = callsMatching(/INSERT INTO call_sessions/)[0] as [string, unknown[]];
    // ORDER IS DATA: the offer rule decides who offers by roster INDEX, so the roster is
    // stored as the ordered JSON array it is and never as a set.
    expect(args[3]).toBe(JSON.stringify([STARTER, B]));
    expect(sql).toMatch(/ON CONFLICT\(sid\) DO UPDATE SET/);
    expect(sql).toMatch(/roster = excluded\.roster/);
    expect(sql).toMatch(/se = excluded\.se/);
    // startedAt is deliberately absent from the update: a refreshed row must
    // not restart the call's own clock.
    expect(sql).not.toMatch(/startedAt = excluded\.startedAt/);
  });

  it('a roster this build cannot read collapses to empty rather than throwing the restore away', async () => {
    await db.initDb();
    const instance = sqlite.instances.get(REAL)!;
    instance.execute.mockImplementation(async (sql: string) => {
      if (/FROM call_sessions/.test(sql)) {
        return {
          rows: [
            {
              sid: SID,
              roomId: null,
              starterId: STARTER,
              roster: 'not json at all',
              se: 0,
              video: 0,
              startedAt: AT,
            },
          ],
        };
      }
      return { rows: [] };
    });
    const row = await db.loadCallSession();
    // Parse-permissive, the roster doctrine: an empty roster dials NOBODY,
    // which is the safe direction to fail.
    expect(row?.roster).toEqual([]);
    expect(row?.starterId).toBe(STARTER);
  });

  it('takes offers BY SESSION and deletes them all — the cid-keyed take was the bug', async () => {
    await db.initDb();
    const instance = sqlite.instances.get(REAL)!;
    instance.execute.mockImplementation(async (sql: string) => {
      if (/SELECT .* FROM call_offers\s+WHERE sid/s.test(sql)) {
        return {
          rows: [
            { cid: 'c1', peerId: STARTER, sdp: 's', video: 0, exp: AT, serverTs: AT, sid: SID },
            { cid: 'c2', peerId: B, sdp: 's', video: 1, exp: AT, serverTs: AT, sid: SID },
          ],
        };
      }
      return { rows: [] };
    });
    const offers = await db.takeCallOffersForSession(SID);
    expect(offers.map(o => o.cid)).toEqual(['c1', 'c2']);
    expect(offers[1].video).toBe(true);
    // Destructive, exactly as the 1:1 take is: an offer that has served its
    // one answer must not rebuild a call that has already ended.
    expect(callsMatching(/DELETE FROM call_offers WHERE sid/)).toHaveLength(1);
  });

  it('takes nothing, and deletes nothing, for a session with no stored offers', async () => {
    await db.initDb();
    const offers = await db.takeCallOffersForSession(SID);
    expect(offers).toEqual([]);
    expect(callsMatching(/DELETE FROM call_offers WHERE sid/)).toHaveLength(0);
  });

  it('terminal cleanup deletes the session\'s offers, not only its row', async () => {
    // The ordinary end of a session — answered, declined, hung up — used to
    // leave one `call_offers` row per invite behind: peer id, DTLS
    // fingerprint, candidate addresses, waiting for a boot prune that only
    // runs when the app is force-quit and relaunched. The 1:1 path has always
    // dropped its offer the moment the machine went idle.
    await db.initDb();
    await db.deleteCallOffersForSession(SID);
    const [sql, args] = callsMatching(/DELETE FROM call_offers WHERE sid/)[0] as [
      string,
      unknown[],
    ];
    expect(sql).toMatch(/WHERE sid = \?/);
    expect(args[0]).toBe(SID);
  });

  it('the boot sweep removes residue, bounded by the ring TTL', async () => {
    await db.initDb();
    await db.pruneCallSessions(AT);
    const [sql, args] = callsMatching(/DELETE FROM call_sessions WHERE startedAt/)[0] as [
      string,
      unknown[],
    ];
    expect(sql).toMatch(/startedAt <= \?/);
    expect(args[0]).toBe(AT);
  });
});

describe('call_log gains a session, and loses nothing', () => {
  it('writes sessionId and roomId when a leg belongs to a session', async () => {
    await db.initDb();
    await db.startCallLog({
      cid: 'c1',
      peerId: B,
      direction: 'out',
      kind: 'audio',
      startedAt: AT,
      sessionId: SID,
      roomId: 'room1',
    });
    const [, args] = callsMatching(/INSERT INTO call_log/)[0] as [string, unknown[]];
    expect(args).toContain(SID);
    expect(args).toContain('room1');
  });

  it('an ordinary 1:1 row carries NULL in both — every existing query is unchanged', async () => {
    await db.initDb();
    await db.startCallLog({
      cid: 'c2',
      peerId: B,
      direction: 'in',
      kind: 'video',
      startedAt: AT,
    });
    const [, args] = callsMatching(/INSERT INTO call_log/)[0] as [string, unknown[]];
    expect(args[args.length - 2]).toBeNull();
    expect(args[args.length - 1]).toBeNull();
  });
});
