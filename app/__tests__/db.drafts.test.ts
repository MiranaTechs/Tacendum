import * as db from '../src/db';

/**
 * Every unsent draft in one read.
 *
 * The drafts table has shipped since the thread learned not to lose what you
 * typed, and `getDraft` has had exactly two callers — itself and the thread.
 * The list has never read it, so a conversation with an unsent message looked
 * identical to one without.
 *
 * WHAT THIS FILE MAY AND MAY NOT ASSERT. jest.setup.js mocks op-sqlite with a
 * recorder that returns empty rows without executing anything, so nothing here
 * can say which rows the WHERE clause keeps. This file pins the emitted
 * statement, and the mapping of whatever rows come back — a stub, not a query
 * result.
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

function calls() {
  return sqlite.instances.get(REAL)?.execute.mock.calls ?? [];
}
function since(): () => [string, unknown[] | undefined][] {
  const at = calls().length;
  return () =>
    calls()
      .slice(at)
      .map(c => [String(c[0]), c[1] as unknown[] | undefined]);
}
/** Answer the next statement matching `re` with these rows; everything else
 * gets the empty answer the recorder gives by default. */
function answer(re: RegExp, rows: unknown[]) {
  const instance = sqlite.instances.get(REAL)!;
  instance.execute.mockImplementation((sql: string) =>
    re.test(String(sql)) ? { rows } : { rows: [] },
  );
}

beforeEach(async () => {
  await db.close();
  db.setWorkspace('real');
  sqlite.reset();
});

describe('listDrafts', () => {
  it('is ONE whole-table read, never one per row', async () => {
    await db.initDb();
    const later = since();
    await db.listDrafts();
    const written = later();
    // The chat list already runs N+4 reads in an 80 ms window. A draft read
    // per row would make it N+5 per row; this is one statement, no parameters.
    expect(written).toHaveLength(1);
    expect(written[0][0]).toBe(
      `SELECT peerId, text FROM drafts WHERE text <> ''`,
    );
    expect(written[0][1]).toBeUndefined();
  });

  it('keys the answer by peerId, in the unreadCounts shape', async () => {
    await db.initDb();
    answer(/FROM drafts/, [
      { peerId: '01A', text: 'half a sentence' },
      { peerId: '01B', text: 'ok' },
    ]);
    await expect(db.listDrafts()).resolves.toEqual({
      '01A': 'half a sentence',
      '01B': 'ok',
    });
  });

  it('answers with an empty record when there is nothing unsent', async () => {
    await db.initDb();
    await expect(db.listDrafts()).resolves.toEqual({});
  });
});

describe('composer draft metadata', () => {
  it('reads the text and locally bound mention intent in one statement', async () => {
    await db.initDb();
    const mentionState = JSON.stringify({ v: 1, peerId: '01ROOM' });
    answer(/SELECT text, mentionState FROM drafts/, [
      { text: 'hello @Ana', mentionState },
    ]);

    await expect(db.getComposerDraft('01ROOM')).resolves.toEqual({
      text: 'hello @Ana',
      mentionState,
    });
  });

  it('keeps old text-only rows compatible', async () => {
    await db.initDb();
    answer(/SELECT text, mentionState FROM drafts/, [
      { text: 'old words', mentionState: null },
    ]);
    await expect(db.getComposerDraft('01ROOM')).resolves.toEqual({
      text: 'old words',
      mentionState: null,
    });
  });

  it('writes text and mention intent atomically, then clears both with the row', async () => {
    await db.initDb();
    const mentionState = '{"v":1}';
    const later = since();
    await db.setDraft('01ROOM', 'hello @Ana', mentionState);
    await db.setDraft('01ROOM', '');

    const written = later();
    expect(written[0]).toEqual([
      `INSERT OR REPLACE INTO drafts (peerId, text, mentionState, updatedAt) VALUES (?, ?, ?, ?)`,
      ['01ROOM', 'hello @Ana', mentionState, expect.any(Number)],
    ]);
    expect(written[1]).toEqual([
      `DELETE FROM drafts WHERE peerId = ?`,
      ['01ROOM'],
    ]);
  });
});
