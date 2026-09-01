import * as db from '../src/db';

/**
 * Migration v3. Two things ship here: the call log
 * (which the thread renders inline alongside messages) and an outbox priority
 * column, so call signalling never queues behind a 10 MB photo.
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

function sqlOf(name = 'tacendum.sqlite'): string[] {
  return (sqlite.instances.get(name)?.execute.mock.calls ?? []).map(c =>
    String(c[0]),
  );
}
function callsMatching(re: RegExp, name = 'tacendum.sqlite') {
  return (sqlite.instances.get(name)?.execute.mock.calls ?? []).filter(c =>
    re.test(String(c[0])),
  );
}

beforeEach(async () => {
  await db.close();
  db.setWorkspace('real');
  sqlite.reset();
});

describe('migration v3 — schema', () => {
  it('creates the call log and an index for per-peer history', async () => {
    await db.initDb();
    const sql = sqlOf().join('\n');
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS call_log/);
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS .*call_log/);
  });

  it('constrains the columns a bad write could corrupt', async () => {
    await db.initDb();
    const create = sqlOf().find(s => s.includes('CREATE TABLE IF NOT EXISTS call_log'))!;
    expect(create).toMatch(/cid TEXT PRIMARY KEY/);
    expect(create).toMatch(/direction TEXT NOT NULL CHECK \(direction IN \('in','out'\)\)/);
    expect(create).toMatch(/kind TEXT NOT NULL CHECK \(kind IN \('audio','video'\)\)/);
    expect(create).toMatch(/state TEXT NOT NULL CHECK \(state IN \('active','ended'\)\)/);
    // Nullable on purpose: "never connected" and "connected for 0:00" are
    // different facts and the UI must be able to tell them apart.
    expect(create).toMatch(/connectedAt INTEGER(?!\s+NOT NULL)/);
    expect(create).toMatch(/endedAt INTEGER(?!\s+NOT NULL)/);
  });

  it('adds the outbox priority column to a database that predates it', async () => {
    // The mock reports no existing columns, i.e. an older schema on disk.
    await db.initDb();
    const altered = sqlOf().filter(s => /ALTER TABLE outbox ADD COLUMN/.test(s));
    expect(altered.join('\n')).toMatch(/priority/);
  });
});

describe('outbox priority', () => {
  it('flushes call signalling ahead of a queued photo, still ULID-ordered within a priority', async () => {
    await db.initDb();
    await db.listOutbox();
    const select = sqlOf().find(s => s.includes('FROM outbox'))!;
    // COALESCE(seq, 0) joined the order for rooms: rows
    // without a seq all tie at 0 and keep the exact ULID order they had, so
    // the call-first property this test pins is unchanged.
    expect(select).toMatch(
      /ORDER BY priority DESC, COALESCE\(seq, 0\) ASC, msgId ASC/,
    );
  });

  it('defaults to normal priority and records an explicit one', async () => {
    await db.initDb();
    await db.enqueueOutgoing(
      { msgId: '01A', peerId: 'p', direction: 'out', body: 'hi', ts: 1, status: 'pending' },
      { msgType: 'ciphertext', payload: 'AAAA' },
    );
    const normal = callsMatching(/INSERT OR IGNORE INTO outbox/)[0];
    expect(normal[1]).toContain(0);

    await db.enqueueOutgoing(
      { msgId: '01B', peerId: 'p', direction: 'out', body: '{}', ts: 2, status: 'pending' },
      { msgType: 'ciphertext', payload: 'BBBB', priority: 1 },
    );
    const urgent = callsMatching(/INSERT OR IGNORE INTO outbox/)[1];
    expect(urgent[1]).toContain(1);
  });
});

describe('call history is local state like any other', () => {
  it('is wiped by a sign-out — call history must not outlive the account', async () => {
    await db.initDb();
    await db.clearLocalState();
    const deleted = sqlOf().filter(s => s.startsWith('DELETE FROM'));
    expect(deleted.join('\n')).toMatch(/DELETE FROM call_log/);
  });

  it('is wiped from the decoy workspace too', async () => {
    await db.clearDecoyState();
    const deleted = sqlOf('tacendum-decoy.sqlite').filter(s =>
      s.startsWith('DELETE FROM'),
    );
    expect(deleted.join('\n')).toMatch(/DELETE FROM call_log/);
  });
});

describe('call log rows', () => {
  const row = {
    cid: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    peerId: '01PEERZ3NDEKTSV4RRFFQ69G5F',
    direction: 'out' as const,
    kind: 'video' as const,
    startedAt: 1_700_000_000_000,
  };

  it('opens a call as active and closes it with a reason and duration', async () => {
    await db.initDb();
    await db.startCallLog(row);
    expect(callsMatching(/INTO call_log/)).toHaveLength(1);

    await db.endCallLog(row.cid, {
      reason: 'hangup',
      connectedAt: row.startedAt + 1_000,
      endedAt: row.startedAt + 61_000,
      missed: false,
    });
    const ended = callsMatching(/UPDATE call_log/)[0];
    expect(String(ended[0])).toMatch(/state = 'ended'/);
    expect(ended[1]).toContain('hangup');
  });

  it('reconciles calls left active by a crash, using the last heartbeat as the end', async () => {
    // The design: an app killed mid-call leaves an 'active' row; the next launch
    // must close it honestly rather than showing a call that never ended.
    await db.initDb();
    await db.reconcileActiveCalls(1_700_000_100_000);
    const sql = callsMatching(/UPDATE call_log/).map(c => String(c[0])).join('\n');
    expect(sql).toMatch(/state = 'ended'/);
    expect(sql).toMatch(/failed_media/);
    expect(sql).toMatch(/WHERE state = 'active'/);
    // Duration must come from the heartbeat, not from "now" — otherwise a
    // phone that was off for a day reports a day-long call.
    expect(sql).toMatch(/endedAt = lastSeenAt/);
  });

  it('lists the calls with one peer, newest first', async () => {
    await db.initDb();
    await db.listCallLog(row.peerId);
    const select = sqlOf().find(s => s.includes('FROM call_log'))!;
    expect(select).toMatch(/WHERE peerId = \?/);
    expect(select).toMatch(/ORDER BY startedAt DESC/);
  });

  it('keeps the heartbeat fresh so a crash can be dated', async () => {
    await db.initDb();
    await db.touchCallLog(row.cid, 1_700_000_050_000);
    const sql = callsMatching(/UPDATE call_log/).map(c => String(c[0])).join('\n');
    expect(sql).toMatch(/lastSeenAt = \?/);
  });
});

/**
 * The ringing offer — the one row that lets a phone killed while
 * ringing still answer from the lock screen.
 *
 * It holds an SDP, so it is the most sensitive thing in the call schema: a
 * DTLS fingerprint plus, unless always-relay is on, candidate addresses. The
 * tests below are as much about it not surviving than about it surviving.
 */
describe('stored call offers', () => {
  const OFFER = {
    cid: '01J0000000000000000000000M',
    peerId: 'P1',
    sdp: 'v=0\r\na=fingerprint:sha-256 AA:BB',
    video: true,
    exp: 1_700_000_060_000,
    serverTs: 1_700_000_000_000,
  };

  it('creates the table', async () => {
    await db.initDb();
    expect(sqlOf().join('\n')).toMatch(/CREATE TABLE IF NOT EXISTS call_offers/);
  });

  it('is wiped with the rest of local state — a decoy must never inherit one', async () => {
    await db.initDb();
    await db.clearLocalState();
    expect(callsMatching(/DELETE FROM call_offers$/)).toHaveLength(1);
  });

  it('takes destructively: the row is gone once it has been read', async () => {
    await db.initDb();
    const inst = sqlite.instances.get('tacendum.sqlite')!;
    inst.execute.mockImplementationOnce(async () => ({
      rows: [{ ...OFFER, video: 1 }],
    }));

    const got = await db.takeCallOffer(OFFER.cid);
    expect(got).toEqual(OFFER);
    // A second answer for the same cid must not be able to rebuild a call
    // that has already been answered.
    expect(callsMatching(/DELETE FROM call_offers WHERE cid/)).toHaveLength(1);
  });

  it('deletes nothing when there is no offer to take', async () => {
    await db.initDb();
    expect(await db.takeCallOffer(OFFER.cid)).toBeNull();
    expect(callsMatching(/DELETE FROM call_offers WHERE cid/)).toHaveLength(0);
  });

  it('prunes by the offer’s own expiry, not by a policy of ours', async () => {
    await db.initDb();
    await db.pruneCallOffers(1_700_000_030_000);
    const [sql, args] = callsMatching(/DELETE FROM call_offers WHERE exp/)[0];
    expect(String(sql)).toMatch(/exp <= \?/);
    expect(args).toEqual([1_700_000_030_000]);
  });
});
