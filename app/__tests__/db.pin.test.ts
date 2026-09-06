import * as db from '../src/db';

/**
 * Pin a conversation, and mark one unread.
 *
 * WHAT THIS FILE MAY AND MAY NOT ASSERT. jest.setup.js mocks op-sqlite with a
 * recorder that returns empty rows WITHOUT EXECUTING anything, so nothing here
 * can say what an ORDER BY orders or what an UPDATE writes. This file pins the
 * emitted statement and its bound parameters. Actual ordering and unread
 * counting require separate verification against a real SQLite engine.
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
const PEER = '01PEER0000000000000000000A';

function calls() {
  return sqlite.instances.get(REAL)?.execute.mock.calls ?? [];
}
function statements(): string[] {
  return calls().map(c => String(c[0]));
}
function since(): () => [string, unknown[] | undefined][] {
  const at = calls().length;
  return () =>
    calls()
      .slice(at)
      .map(c => [String(c[0]), c[1] as unknown[] | undefined]);
}

beforeEach(async () => {
  await db.close();
  db.setWorkspace('real');
  sqlite.reset();
});

describe('the pinnedAt column', () => {
  it('is added by the additive idiom to a file that predates it', async () => {
    // The mock reports no existing columns, i.e. an older schema on disk.
    await db.initDb();
    const altered = statements().filter(s =>
      /ALTER TABLE chats ADD COLUMN/.test(s),
    );
    expect(altered.join('\n')).toMatch(/pinnedAt INTEGER/);
  });

  it('is NAMED in the projection every reader uses', async () => {
    // db.ts's own warning above CHAT_COLUMNS: a column added to the table is
    // invisible to every reader until it is named there. The disappearing
    // pair was added and forgotten once, and the UI showed Off while the rows
    // on disk were correct.
    await db.initDb();
    await db.listChats();
    await db.getChat(PEER);
    // The CHAT_COLUMNS projection specifically — not every read of the table
    // (the extension's name mirror has a projection of its own).
    const reads = statements().filter(s =>
      /^SELECT peerId, displayName,[\s\S]*FROM chats/.test(s),
    );
    expect(reads).toHaveLength(2);
    for (const sql of reads) expect(sql).toMatch(/\bpinnedAt\b/);
  });
});

describe('listChats order', () => {
  it('puts pinned rows on top, newest pin first, and leaves the rest as they were', async () => {
    await db.initDb();
    const later = since();
    await db.listChats();
    const select = later().map(([s]) => s).find(s => /FROM chats/.test(s))!;
    expect(select).toMatch(/ORDER BY \(pinnedAt IS NULL\), pinnedAt DESC/);
    // Unchanged tail: a chat you just started has no lastMessageAt, and its
    // creation moment stands in until it speaks.
    expect(select).toMatch(
      /COALESCE\(lastMessageAt, createdAt, 0\) DESC, peerId/,
    );
    expect(select).not.toMatch(/SELECT \*/);
  });
});

describe('setPinned', () => {
  it('writes the pin moment, and clears it with null', async () => {
    await db.initDb();
    let later = since();
    await db.setPinned(PEER, 1730000000000);
    expect(later()).toEqual([
      ['UPDATE chats SET pinnedAt = ? WHERE peerId = ?', [1730000000000, PEER]],
    ]);

    later = since();
    await db.setPinned(PEER, null);
    expect(later()).toEqual([
      ['UPDATE chats SET pinnedAt = ? WHERE peerId = ?', [null, PEER]],
    ]);
  });
});

describe('markChatUnread', () => {
  it('rolls lastOpenedAt back with the SAME predicate unreadCounts reads', async () => {
    await db.initDb();
    const later = since();
    await db.markChatUnread(PEER);
    const written = later();
    expect(written).toHaveLength(1);
    const [sql, params] = written[0];
    expect(sql).toMatch(/^UPDATE chats SET lastOpenedAt =/);
    expect(params).toEqual([PEER]);
    // The 1:1 window: this phone's own clock, falling back to seen.ts only
    // for rows predating the arrivedAt column.
    expect(sql).toMatch(/COALESCE\(m\.arrivedAt, s\.ts\)/);
    // The room window: arrival, and never a relayed history row — a newcomer
    // handed 200 rows must not be able to mark 200 unread.
    expect(sql).toMatch(/m\.sharedBy IS NULL/);
    expect(sql).toMatch(/m\.direction = 'in'/);
    // One millisecond before the newest arrival, so the mark that appears is
    // the mark that screen would have counted.
    expect(sql).toMatch(/- 1/);
  });

  it('is a no-op with nothing inbound — the value falls back to itself', async () => {
    await db.initDb();
    const later = since();
    await db.markChatUnread(PEER);
    // COALESCE(<the roll-back>, lastOpenedAt): a chat with no inbound row has
    // no newest arrival, MAX over nothing is NULL, and MIN of anything with
    // NULL is NULL — so the column keeps what it held. You cannot mark unread
    // what never arrived.
    expect(later()[0][0]).toMatch(/COALESCE\(\s*MIN\(/);
    expect(later()[0][0]).toMatch(/lastOpenedAt\s*\)\s*WHERE peerId = \?/);
  });

  it('only ever moves the clock BACK — the write is monotonic', async () => {
    await db.initDb();
    const later = since();
    await db.markChatUnread(PEER);
    const sql = later()[0][0];
    // The defect this pins: assigning (newest arrival - 1) unconditionally is
    // a move FORWARD on a conversation that is already unread, which reads
    // every unread message but the newest. MIN over the current value is what
    // makes a second mark harmless, and the floor is the same COALESCE(...,0)
    // unreadCounts applies to a never-opened row.
    expect(sql).toMatch(/MIN\(\s*COALESCE\(lastOpenedAt, 0\)/);
    // The order matters: the current value is the FIRST argument, so the
    // subselect can only pull the clock down.
    expect(sql.indexOf('COALESCE(lastOpenedAt, 0)')).toBeLessThan(
      sql.indexOf('(SELECT'),
    );
  });

  it('never touches seen — the prune is not this function’s business', async () => {
    await db.initDb();
    const later = since();
    await db.markChatUnread(PEER);
    expect(later().filter(([s]) => /DELETE|INSERT/.test(s))).toEqual([]);
  });
});
