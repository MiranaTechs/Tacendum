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
