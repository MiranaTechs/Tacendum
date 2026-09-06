import * as db from '../src/db';

/**
 * Every room anchor in one read.
 *
 * The chat list resolved rooms with Promise.all over db.getGroup — one
 * single-row SELECT per row, on the screen a person spends most of their time
 * looking at, refreshed on every receipt, frame, socket transition and
 * attachment tick. There was no bulk read to reach for; this is it.
 *
 * WHAT THIS FILE MAY AND MAY NOT ASSERT. The op-sqlite mock records without
 * executing, so nothing here can say which rows come back. This file pins the
 * emitted statement and the shape it hands the caller.
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
const ROOM = '01ROOM0000000000000000000A';

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

describe('listGroups', () => {
  it('is one unparameterised read of the anchor table', async () => {
    await db.initDb();
    const later = since();
    await db.listGroups();
    const written = later();
    expect(written).toHaveLength(1);
    expect(written[0][0]).toBe(`SELECT groupId, ownerId, name FROM groups`);
    expect(written[0][1]).toBeUndefined();
  });

  it('reads the SAME three columns getGroup does — one anchor shape, not two', async () => {
    await db.initDb();
    let later = since();
    await db.getGroup(ROOM);
    const single = later()[0][0];
    later = since();
    await db.listGroups();
    const bulk = later()[0][0];
    expect(single.replace(' WHERE groupId = ?', '')).toBe(bulk);
  });

  it('hands back the anchor rows as they came', async () => {
    await db.initDb();
    answer(/FROM groups/, [
      { groupId: '01G1', ownerId: '01OWNER', name: 'kelno vash' },
      { groupId: '01G2', ownerId: '01OTHER', name: null },
    ]);
    await expect(db.listGroups()).resolves.toEqual([
      { groupId: '01G1', ownerId: '01OWNER', name: 'kelno vash' },
      { groupId: '01G2', ownerId: '01OTHER', name: null },
    ]);
  });

  it('answers with an empty list when this device holds no rooms', async () => {
    await db.initDb();
    await expect(db.listGroups()).resolves.toEqual([]);
  });
});
