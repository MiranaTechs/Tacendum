/** Draft migration and deletion behavior on a private in-memory SQLite engine. */
import * as db from '../src/db';

type Row = Record<string, unknown>;
interface Engine {
  prepare(sql: string): { all(...args: unknown[]): Row[] };
  exec(sql: string): void;
  close(): void;
}
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (path: string) => Engine;
};
interface FakeDb { name: string; execute: jest.Mock; close: jest.Mock }
const sqlite = jest.requireMock('@op-engineering/op-sqlite') as {
  open: (options: { name: string }) => FakeDb;
  __sqlite: { reset: () => void };
};
let engine: Engine;

beforeEach(async () => {
  await db.close();
  sqlite.__sqlite.reset();
  db.setWorkspace('real');
  engine = new DatabaseSync(':memory:');
  // A phone upgrading from the text-only draft schema.
  engine.exec(`CREATE TABLE drafts (peerId TEXT PRIMARY KEY, text TEXT NOT NULL, updatedAt INTEGER NOT NULL);
    INSERT INTO drafts VALUES ('old-peer', 'old words', 1);`);
  const instance = sqlite.open({ name: 'tacendum.sqlite' });
  instance.execute.mockImplementation(async (sql: unknown, params?: unknown[]) => {
    const rows = engine.prepare(String(sql)).all(...(params ?? []));
    const changes = engine.prepare('SELECT changes() AS c').all()[0]!.c;
    return { rows, rowsAffected: changes };
  });
  await db.initDb();
});

afterEach(async () => {
  await db.close();
  engine.close();
});

test('upgrading preserves old words as plain text and adds a single nullable metadata column', async () => {
  expect(await db.getDraft('old-peer')).toBe('old words');
  expect(await db.getComposerDraft('old-peer')).toEqual({ text: 'old words', mentionState: null });
  expect(engine.prepare('PRAGMA table_info(drafts)').all().filter(row => row.name === 'mentionState')).toHaveLength(1);
});

test('one stored row binds words and metadata; plain replacement and empty deletion clear recipient intent', async () => {
  await db.setDraft('room', 'Hi @Ana', '{"bound":"local"}');
  expect(await db.getComposerDraft('room')).toEqual({ text: 'Hi @Ana', mentionState: '{"bound":"local"}' });
  expect(await db.listDrafts()).toEqual({ 'old-peer': 'old words', room: 'Hi @Ana' });
  await db.setDraft('room', 'Hi @Ana');
  expect(await db.getComposerDraft('room')).toEqual({ text: 'Hi @Ana', mentionState: null });
  await db.setDraft('room', 'Hi @Ana', 'another binding');
  await db.setDraft('room', '  ');
  expect(engine.prepare("SELECT * FROM drafts WHERE peerId = 'room'").all()).toEqual([]);
});

test('deleting the conversation deletes its complete draft row without disturbing another draft', async () => {
  await db.setDraft('room', 'Hi @Ana', 'binding');
  await db.deleteChat('room');
  expect(await db.getComposerDraft('room')).toEqual({ text: '', mentionState: null });
  expect(await db.getDraft('old-peer')).toBe('old words');
});
