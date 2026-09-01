/**
 * ROOMS — the send path's SQL half, plus the two
 * DORMANT DEFECTS the group fan-out makes live: sweepExpired and deleteMessage purged the
 * outbox by matching `outbox.msgId` against `messages.msgId`, and a fan-out
 * leg's wire msgId is random — so once `outbox.localMsgId` is written, those
 * joins missed every leg and an expired or deleted group message left legs
 * that still transmitted.
 *
 * The op-sqlite mock RECORDS statements; it does not execute them. So this
 * file pins the WIRING — which statements run, with which clauses, in which
 * transaction, with which params — and every behavioural claim (rows really
 * gone, rollback really atomic, the ledger really counting) was proved
 * separately against Node's real SQLite engine. A clause deleted from db.ts
 * must fail HERE on its own.
 */
import * as db from '../src/db';

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
const ROOM = '01R88MZ3NDEKTSV4RRFFQ69G5A';
const LOCAL = '01ME00000000000000000000AA.01GM0000000000000000000000';
const AT = 1_700_000_000_000;

function calls(name = REAL): unknown[][] {
  return sqlite.instances.get(name)?.execute.mock.calls ?? [];
}
function statements(name = REAL): string[] {
  return calls(name).map(c => String(c[0]));
}
function since(name = REAL): () => string[] {
  const mark = statements(name).length;
  return () => statements(name).slice(mark);
}
function callsSince(name = REAL): () => unknown[][] {
  const mark = calls(name).length;
  return () => calls(name).slice(mark);
}

const message = {
  msgId: LOCAL,
  peerId: ROOM,
  direction: 'out' as const,
  body: 'hello room',
  ts: AT,
  status: 'pending' as const,
  expiresAt: null,
  authorId: '01ME00000000000000000000AA',
  sq: 3,
};
const legs: db.FanoutLeg[] = [
  { msgId: '01LEGAAAAAAAAAAAAAAAAAAAAA', peerId: '01MBR001000000000000000000', msgType: 'ciphertext', payload: 'QQQQ' },
  { msgId: '01LEGBBBBBBBBBBBBBBBBBBBBB', peerId: '01MBR002000000000000000000', msgType: 'ciphertext', payload: 'RRRR', notify: false },
  { msgId: '01LEGCCCCCCCCCCCCCCCCCCCCC', peerId: '01MBR003000000000000000000', msgType: 'ciphertext', payload: 'SSSS', failed: true },
];

beforeEach(async () => {
  sqlite.reset();
  await db.close();
  await db.initDb();
});

describe('enqueueOutgoingFanout: one transaction, one row, N legs', () => {
  it('writes the message row and every leg between ONE BEGIN and ONE COMMIT, nothing else between them', async () => {
    const later = since();
    const argsLater = callsSince();
    await db.enqueueOutgoingFanout(message, legs);
    const sql = later().filter(s => !s.trim().startsWith('SELECT'));
    expect(sql[0]).toBe('BEGIN IMMEDIATE');
    expect(sql[1]).toContain('INSERT INTO messages');
    expect(sql[1]).toContain('authorId');
    expect(sql[1]).toContain('sq');
    expect(sql[2]).toContain('INSERT INTO outbox');
    expect(sql[3]).toContain('INSERT INTO outbox');
    expect(sql[4]).toContain('INSERT INTO outbox');
    expect(sql[5]).toBe('COMMIT');
    expect(sql).toHaveLength(6);
    expect(sql.filter(s => s === 'ROLLBACK')).toHaveLength(0);
    // Params: the row carries authorId and sq; every leg points back through
    // localMsgId and takes consecutive seq in the caller's (shuffled) order.
    const all = argsLater();
    const rowParams = all.find(c => String(c[0]).includes('INSERT INTO messages'))![1] as unknown[];
    expect(rowParams).toContain(message.authorId);
    expect(rowParams).toContain(3);
    const legParams = all
      .filter(c => String(c[0]).includes('INSERT INTO outbox'))
      .map(c => c[1] as unknown[]);
    expect(legParams).toHaveLength(3);
    for (let i = 0; i < legParams.length; i++) {
      expect(legParams[i]).toContain(legs[i].msgId);
      expect(legParams[i]).toContain(LOCAL); // localMsgId
      expect(legParams[i]).toContain(i + 1); // seq: MAX(seq)=empty → 1,2,3
    }
    // A pre-failed leg (counted, never silently omitted) lands as a
    // settled LEG_FAILED ledger row with nothing transmittable in it.
    expect(legParams[2]).toContain(db.LEG_FAILED);
    expect(legParams[2]).toContain('');
    // The INSERTs are plain, not OR IGNORE: a collision must roll everything
    // back rather than leave a bubble with half its legs.
    expect(sql[1]).not.toContain('OR IGNORE');
    expect(sql[2]).not.toContain('OR IGNORE');
  });

  it('CRASH INJECTION: a failure on a leg INSERT rolls the whole write back — the message row cannot outlive its legs', async () => {
    const instance = sqlite.instances.get(REAL)!;
    const original = instance.execute.getMockImplementation()!;
    let outboxInserts = 0;
    instance.execute.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (String(sql).includes('INSERT INTO outbox')) {
        outboxInserts += 1;
        if (outboxInserts === 2) throw new Error('injected crash');
      }
      return original(sql, params);
    });
    const later = since();
    await expect(db.enqueueOutgoingFanout(message, legs)).rejects.toThrow(
      'injected crash',
    );
    instance.execute.mockImplementation(original);
    const sql = later();
    expect(sql).toContain('ROLLBACK');
    expect(sql).not.toContain('COMMIT');
  });
});

describe('the two dormant defects, fixed because group fan-out makes them live', () => {
  it('sweepExpired purges legs through localMsgId as well as msgId, still direction-guarded, still ONE statement', async () => {
    const instance = sqlite.instances.get(REAL)!;
    const original = instance.execute.getMockImplementation()!;
    instance.execute.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (String(sql).startsWith('SELECT msgId FROM messages WHERE expiresAt')) {
        return { rows: [{ msgId: '01GONE' }] };
      }
      return original(sql, params);
    });
    const later = since();
    await db.sweepExpired(AT);
    instance.execute.mockImplementation(original);
    const outboxSweeps = later().filter(s => s.includes('DELETE FROM outbox'));
    expect(outboxSweeps).toHaveLength(1);
    // The original key, kept…
    expect(outboxSweeps[0]).toContain('msgId IN');
    // …and THE FIX: without this clause, every leg of an expired group
    // message stayed queued and transmitted after its own timer said gone.
    expect(outboxSweeps[0]).toContain('localMsgId IN');
    // Both subqueries stay scoped to my own sends: a peer's colliding msgId
    // must not delete my queued envelope.
    expect(outboxSweeps[0].match(/direction = 'out'/g)).toHaveLength(2);
  });

  it('deleteMessage(out) takes the legs with the bubble: msgId OR localMsgId, one statement, both params', async () => {
    const later = callsSince();
    await db.deleteMessage(LOCAL, 'out');
    const drops = later().filter(c =>
      String(c[0]).includes('DELETE FROM outbox'),
    );
    expect(drops).toHaveLength(1);
    expect(String(drops[0][0])).toContain('msgId = ? OR localMsgId = ?');
    expect(drops[0][1]).toEqual([LOCAL, LOCAL]);
  });

  it('deleteMessage(in) still never touches the outbox — a peer-chosen id must not reach my queue', async () => {
    const later = since();
    await db.deleteMessage(LOCAL, 'in');
    expect(later().filter(s => s.includes('DELETE FROM outbox'))).toHaveLength(0);
  });

  it('deleteChat spares room legs queued to that member — the third instance of the same defect class, found while fixing the two', async () => {
    const later = callsSince();
    await db.deleteChat('01MBR001000000000000000000');
    const drops = later().filter(c =>
      String(c[0]).includes('DELETE FROM outbox'),
    );
    expect(drops).toHaveLength(1);
    // Deleting my 1:1 thread with Ana says nothing about the room: her legs
    // stay (they die with the room, the message, or the expiry). Without
    // this guard the room message would silently skip her — the silent-omission tell.
    expect(String(drops[0][0])).toContain('localMsgId IS NULL');
    expect(drops[0][1]).toEqual(['01MBR001000000000000000000']);
  });
});

describe('the leg ledger (receipt aggregation through outbox.localMsgId)', () => {
  it('applyReceipt resolves wire msgId → localMsgId → settles the leg and recomputes the aggregate', async () => {
    const instance = sqlite.instances.get(REAL)!;
    const original = instance.execute.getMockImplementation()!;
    instance.execute.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (String(sql).includes('SELECT localMsgId FROM outbox')) {
        return { rows: [{ localMsgId: LOCAL }] };
      }
      return original(sql, params);
    });
    const later = callsSince();
    await db.applyReceipt('01LEGAAAAAAAAAAAAAAAAAAAAA', 'delivered');
    instance.execute.mockImplementation(original);
    const all = later();
    const settle = all.find(c =>
      String(c[0]).includes(`UPDATE outbox SET payload = ''`),
    );
    expect(settle).toBeDefined();
    // Monotonic: delivered is terminal, everything else becomes at least
    // sent — and the payload dies in the same statement.
    expect(String(settle![0])).toContain(`${db.LEG_DELIVERED}`);
    expect(settle![1]).toEqual(['delivered', '01LEGAAAAAAAAAAAAAAAAAAAAA']);
    // The aggregate re-read keyed by the resolved LOCAL id, not the wire id.
    const agg = all.find(c =>
      String(c[0]).includes('FROM outbox WHERE localMsgId = ?'),
    );
    expect(agg).toBeDefined();
    expect(agg![1]).toEqual([LOCAL]);
  });

  it('applyReceipt for a 1:1 msgId touches no leg machinery', async () => {
    const later = since();
    await db.applyReceipt('01ORDINARY1TO1AAAAAAAAAAAA', 'sent');
    const sql = later();
    expect(sql.some(s => s.includes('UPDATE messages SET status'))).toBe(true);
    expect(sql.some(s => s.includes(`UPDATE outbox SET payload = ''`))).toBe(false);
  });

  it('markLegFailed never downgrades a settled leg (attempts >= 0 guard)', async () => {
    const instance = sqlite.instances.get(REAL)!;
    const original = instance.execute.getMockImplementation()!;
    instance.execute.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (String(sql).includes('SELECT localMsgId FROM outbox')) {
        return { rows: [{ localMsgId: LOCAL }] };
      }
      return original(sql, params);
    });
    const later = since();
    await db.markLegFailed('01LEGAAAAAAAAAAAAAAAAAAAAA');
    instance.execute.mockImplementation(original);
    const fail = later().find(s => s.includes(`attempts = ${db.LEG_FAILED}`))!;
    expect(fail).toBeDefined();
    expect(fail).toContain('attempts >= 0');
  });

  it('deleteOutboxEnvelope spares settled ledger rows — the receipt path must not erase the denominator of "Not delivered to N of M"', async () => {
    const later = since();
    await db.deleteOutboxEnvelope('01LEGAAAAAAAAAAAAAAAAAAAAA');
    const drop = later().find(s => s.includes('DELETE FROM outbox'))!;
    expect(drop).toContain('attempts >= 0');
  });

  it('listOutbox keeps its pinned SELECT shape, reads localMsgId, and filters settled ledger rows out of the flush', async () => {
    const instance = sqlite.instances.get(REAL)!;
    const original = instance.execute.getMockImplementation()!;
    instance.execute.mockImplementation(async (sql: string, params?: unknown[]) => {
      const s = String(sql);
      if (/FROM outbox\s+ORDER BY/.test(s)) {
        // The SELECT list must carry localMsgId or the flush cannot route a
        // leg through the pacing bucket and the ledger.
        expect(s).toContain('localMsgId');
        expect(s).toMatch(/ORDER BY priority DESC, COALESCE\(seq, 0\) ASC, msgId ASC/);
        return {
          rows: [
            { msgId: 'LIVE', attempts: 0, payload: 'AAAA' },
            { msgId: 'FAILED', attempts: db.LEG_FAILED, payload: '' },
            { msgId: 'SENT', attempts: db.LEG_SENT, payload: '' },
            { msgId: 'DELIVERED', attempts: db.LEG_DELIVERED, payload: '' },
          ],
        };
      }
      return original(sql, params);
    });
    const rows = await db.listOutbox();
    instance.execute.mockImplementation(original);
    expect(rows.map(r => r.msgId)).toEqual(['LIVE']);
  });
});
