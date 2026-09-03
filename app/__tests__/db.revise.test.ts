/**
 * Editing and retracting an existing row. Both mutations are peer-SCOPED and
 * guarded: msgIds are sender-chosen, so without the peer in the WHERE clause a
 * malicious peer could rewrite or erase a message in somebody else's
 * conversation by quoting its id.
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
      instances: Map<string, FakeDb>;
      reset: () => void;
    };
  }
).__sqlite;

function callsOf(fragment: string): unknown[][] {
  const instance = sqlite.instances.get('tacendum.sqlite');
  return (instance?.execute.mock.calls ?? []).filter(c =>
    String(c[0]).includes(fragment),
  );
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

describe('schema', () => {
  test('messages carries editedAt and deletedAt', async () => {
    const alters = callsOf('ALTER TABLE messages').map(c => String(c[0]));
    expect(alters.some(s => s.includes('editedAt'))).toBe(true);
    expect(alters.some(s => s.includes('deletedAt'))).toBe(true);
  });
});

describe('applyEdit', () => {
  test('is scoped to the conversation and the exact row', async () => {
    await db.applyEdit('peer-1', '01TARGET', 'in', 'meant tomorrow', 5000);
    const [call] = callsOf('UPDATE messages SET body');
    expect(call).toBeDefined();
    const sql = String(call[0]);
    const params = call[1] as unknown[];
    // The peer scope is the whole defence: without it any id is editable.
    expect(sql).toContain('peerId = ?');
    expect(sql).toContain('direction = ?');
    // By POSITION, not membership: these values are interchangeable strings,
    // so `toContain` would still pass with the peerId bound to the direction
    // placeholder — exactly the mistake the scope exists to prevent.
    expect(params).toEqual([
      'meant tomorrow',
      5000,
      // The Art. 50 claim, raise-only and defaulted false: an
      // edit with no claim binds 0, which the CASE leaves the column alone
      // for — asserted here so the claim can never drift into a WHERE slot.
      0,
      '01TARGET',
      'in',
      'peer-1',
      5000,
    ]);
  });

  test('never resurrects a retracted message, and never goes backwards', async () => {
    await db.applyEdit('peer-1', '01TARGET', 'in', 'later text', 5000);
    const sql = String(callsOf('UPDATE messages SET body')[0][0]);
    // A tombstone is final: an edit arriving after a delete must not undo it.
    expect(sql).toContain('deletedAt IS NULL');
    // Redelivery and clock skew must not let an older edit win.
    expect(sql).toMatch(/editedAt IS NULL OR editedAt <=? \?/);
  });
});

describe('tombstoneMessage', () => {
  test('clears the words, stamps the tombstone, and keeps the row', async () => {
    await db.tombstoneMessage('peer-1', '01TARGET', 'in', 7000);
    const [call] = callsOf('UPDATE messages SET body');
    const sql = String(call[0]);
    const params = call[1] as unknown[];
    expect(sql).toContain('deletedAt = ?');
    expect(sql).toContain('peerId = ?');
    // Position again: msgId, direction and peerId are all strings.
    expect(params).toEqual([7000, '01TARGET', 'in', 'peer-1']);
    // The row survives — a message that vanishes is indistinguishable from
    // one that never arrived.
    expect(callsOf('DELETE FROM messages').length).toBe(0);
  });

  test('takes the photo bytes and the reactions with it', async () => {
    await db.tombstoneMessage('peer-1', '01TARGET', 'in', 7000);
    // Retracting must actually erase: the blob and any chips go too.
    expect(callsOf('DELETE FROM attachments').length).toBeGreaterThan(0);
    expect(callsOf('DELETE FROM reactions').length).toBeGreaterThan(0);
  });

  test('the cascade is scoped to the conversation, like the row itself', async () => {
    await db.tombstoneMessage('peer-1', '01TARGET', 'in', 7000);
    // Without the peer in these WHERE clauses, a msgId quoted from another
    // thread would let any peer destroy a photo or a reaction over there —
    // the messages UPDATE is scoped, so these must be too.
    for (const fragment of ['DELETE FROM attachments', 'DELETE FROM reactions']) {
      const [call] = callsOf(fragment);
      expect(String(call[0])).toContain('peerId');
      expect(call[1] as unknown[]).toContain('peer-1');
    }
  });

  test('is idempotent — a redelivered retraction changes nothing', async () => {
    await db.tombstoneMessage('peer-1', '01TARGET', 'in', 7000);
    const sql = String(callsOf('UPDATE messages SET body')[0][0]);
    expect(sql).toContain('deletedAt IS NULL');
  });
});

// ---------------------------------------------------------------------------
// PEER-WRITABLE GROWTH. A held revision is one row
// per (target, writer) that a peer can park at will — `edit`/`del` naming a
// ref that never arrives — and until now only deleteChat and the target's
// own expiry reaped it. The wiring is pinned here over the recording mock;
// the behaviour is proved below on Node's REAL SQLite engine (the
// db.sibling.purge.test.ts harness), because every claim is SQL behaviour.
// ---------------------------------------------------------------------------

describe('holdRevision carries its per-conversation cap', () => {
  test('the INSERT is guarded by the peer’s held count, with the same-slot exemption, params by position', async () => {
    await db.holdRevision({
      peerId: 'peer-1',
      targetMsgId: '01TARGET',
      targetDirection: 'in',
      writerId: 'peer-1',
      kind: 'edit',
      text: 'later',
      ts: 5000,
    });
    const [call] = callsOf('INSERT INTO pending_revisions');
    expect(call).toBeDefined();
    const sql = String(call[0]);
    // The bound, IN the statement (a read beside it would let a burst of
    // concurrent frames overshoot it), with the cap read off the constant.
    expect(sql).toContain(
      `(SELECT COUNT(*) FROM pending_revisions WHERE peerId = ?) < ${db.HELD_REVISIONS_PER_PEER_CAP}`,
    );
    // A slot that already exists is always eligible for its newest-wins
    // update: the cap is on creation, not on revising one's own claim.
    expect(sql).toMatch(
      /OR EXISTS \(SELECT 1 FROM pending_revisions\s+WHERE targetMsgId = \? AND targetDirection = \? AND writerId = \?\)/,
    );
    // The upsert's own arbitration is untouched.
    expect(sql).toContain('ON CONFLICT(targetMsgId, targetDirection, writerId) DO UPDATE SET');
    expect(sql).toContain('WHERE excluded.ts > pending_revisions.ts');
    expect(call[1]).toEqual([
      'peer-1', '01TARGET', 'in', 'peer-1', 'edit', 'later', 5000,
      // the count's peer, then the exemption's slot
      'peer-1', '01TARGET', 'in', 'peer-1',
    ]);
  });
});

describe('peer-writable growth on the real engine', () => {
  type Row = Record<string, unknown>;
  interface Engine {
    prepare(sql: string): { all(...args: unknown[]): Row[] };
    close(): void;
  }
  const { DatabaseSync } = require('node:sqlite') as {
    DatabaseSync: new (p: string) => Engine;
  };
  let engine: Engine;
  const q = (sql: string, ...args: unknown[]) => engine.prepare(sql).all(...args);

  beforeEach(async () => {
    await db.close();
    engine = new DatabaseSync(':memory:');
    const instance = sqlite.instances.get('tacendum.sqlite')!;
    instance.execute.mockImplementation(async (sql: unknown, params?: unknown[]) => {
      const args = (params ?? []).map(p => (p === undefined ? null : p));
      const rows = engine.prepare(String(sql)).all(...args);
      const changes = engine.prepare('SELECT changes() AS c').all()[0]!.c as number;
      return { rows, rowsAffected: changes };
    });
    await db.initDb();
  });

  afterEach(async () => {
    await db.close();
    engine.close();
  });

  const PEER = '01PEERAAAAAAAAAAAAAAAAAAAA';
  const OTHER = '01PEERBBBBBBBBBBBBBBBBBBBB';
  const AT = 1_756_000_000_000;
  const target = (n: number) => `01TGT${String(n).padStart(21, '0')}`;
  const hold = (peerId: string, n: number, ts = AT, text = `edit ${n}`) =>
    db.holdRevision({
      peerId,
      targetMsgId: target(n),
      targetDirection: 'in',
      writerId: peerId,
      kind: 'edit',
      text,
      ts,
    });
  const heldFor = (peerId: string) =>
    q(`SELECT COUNT(*) AS n FROM pending_revisions WHERE peerId = ?`, peerId)[0]!.n;

  test('the 201st distinct hold for one conversation is refused; an existing slot still takes the newest-wins update; another conversation is untouched', async () => {
    for (let n = 1; n <= db.HELD_REVISIONS_PER_PEER_CAP; n++) {
      expect(await hold(PEER, n)).toBe(true);
    }
    expect(heldFor(PEER)).toBe(db.HELD_REVISIONS_PER_PEER_CAP);
    // One more NEW slot: refused, false back, nothing stored.
    expect(await hold(PEER, db.HELD_REVISIONS_PER_PEER_CAP + 1)).toBe(false);
    expect(heldFor(PEER)).toBe(db.HELD_REVISIONS_PER_PEER_CAP);
    // The peer's own existing slot still arbitrates newest-wins at the cap…
    expect(await hold(PEER, 1, AT + 1, 'newer')).toBe(true);
    expect(await db.takeHeldRevision(PEER, target(1), 'in', PEER)).toMatchObject({ text: 'newer', ts: AT + 1 });
    // …and an OLDER claim on it still loses, exactly as before the cap.
    expect(await hold(PEER, 1, AT, 'stale')).toBe(false);
    expect(await db.takeHeldRevision(PEER, target(1), 'in', PEER)).toMatchObject({ text: 'newer' });
    // The cap is per conversation.
    expect(await hold(OTHER, 1)).toBe(true);
  });

  test('the sweep reaps a held revision older than the queue TTL and keeps a younger one — with no message due', async () => {
    await hold(PEER, 1, AT);
    await hold(PEER, 2, AT + 1);
    expect(await db.sweepExpired(AT + db.HELD_REVISION_TTL_MS - 1)).toBe(0);
    expect(heldFor(PEER)).toBe(2);
    expect(await db.sweepExpired(AT + db.HELD_REVISION_TTL_MS)).toBe(0);
    expect(q(`SELECT targetMsgId FROM pending_revisions`)).toEqual([{ targetMsgId: target(2) }]);
  });

  test('the sweep reaps an ORPHAN reaction past the TTL, and keeps both a young orphan and an old reaction whose target is here', async () => {
    await db.insertMessage({ msgId: target(1), peerId: PEER, direction: 'in', body: 'hi', ts: AT, status: 'received' });
    await db.setReaction(target(1), 'in', 'in', '👍', AT); // target present, old: stays
    await db.setReaction(target(2), 'in', 'in', '👍', AT); // orphan, old: reaped
    await db.setReaction(target(3), 'in', 'in', '👍', AT + 1); // orphan, young: stays
    expect(await db.sweepExpired(AT + db.HELD_REVISION_TTL_MS)).toBe(0);
    expect(q(`SELECT targetMsgId FROM reactions ORDER BY targetMsgId`)).toEqual([
      { targetMsgId: target(1) },
      { targetMsgId: target(3) },
    ]);
  });

  test('a vault writer’s 501st slot is refused by the guarded merge; an existing slot still converges', async () => {
    const id = (n: number) => `01ITM${String(n).padStart(21, '0')}`;
    const slot = (n: number, seq = 1, body = `b${n}`) => ({
      peerId: PEER, id: id(n), writerId: PEER, seq, ackSeq: 0, title: `t${n}`, body, updatedAt: AT, deleted: 0,
    });
    for (let n = 1; n <= db.VAULT_SLOTS_PER_WRITER_CAP; n++) {
      expect(await db.mergeVaultSlot(slot(n))).toBe(true);
    }
    expect(await db.mergeVaultSlot(slot(db.VAULT_SLOTS_PER_WRITER_CAP + 1))).toBe(false);
    expect(q(`SELECT COUNT(*) AS n FROM vault_items WHERE peerId = ?`, PEER)[0]!.n).toBe(db.VAULT_SLOTS_PER_WRITER_CAP);
    expect(await db.mergeVaultSlot(slot(1, 2, 'rotated'))).toBe(true);
    expect(q(`SELECT body FROM vault_items WHERE peerId = ? AND id = ?`, PEER, id(1))).toEqual([{ body: 'rotated' }]);
    expect(await db.mergeVaultSlot(slot(1, 1, 'replayed'))).toBe(false);
    // MY slots in the same conversation are a different writer's.
    expect(await db.mergeVaultSlot({ ...slot(db.VAULT_SLOTS_PER_WRITER_CAP + 1), writerId: OTHER })).toBe(true);
  });

  test('the 101st live pending approval is refused by the guarded insert; lapsed-in-fact asks stop counting', async () => {
    const ask = (n: number, arrivedAt = AT) => ({
      peerId: PEER, q: `01Q${String(n).padStart(23, '0')}`, wireMsgId: target(n), kind: 'exec' as const,
      payload: 'ls', ttlSec: 600, sessionTag: null, verbs: ['approve', 'deny'], ts: arrivedAt, arrivedAt,
    });
    for (let n = 1; n <= db.PENDING_APPROVALS_PER_PEER_CAP; n++) {
      expect(await db.insertApproval(ask(n))).toBe(true);
    }
    expect(await db.insertApproval(ask(999))).toBe(false);
    expect(q(`SELECT COUNT(*) AS n FROM approvals`)[0]!.n).toBe(db.PENDING_APPROVALS_PER_PEER_CAP);
    // Past every deadline, with nobody having opened the thread: live again.
    expect(await db.insertApproval(ask(999, AT + 600_001))).toBe(true);
  });
});
