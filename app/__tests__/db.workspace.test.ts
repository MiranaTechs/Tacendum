/**
 * The lock program's verify: the real/decoy workspace switch and the
 * quiesce invariant's db half — switching requires a closed connection, and
 * close() drains the transaction chain first.
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

beforeEach(async () => {
  await (db as { close?: () => Promise<void> }).close?.();
  (db as { setWorkspace?: (w: string) => void }).setWorkspace?.('real');
  sqlite.reset();
});

test('queries run against tacendum.sqlite by default', async () => {
  await db.initDb();
  expect(sqlite.opened).toEqual(['tacendum.sqlite']);
});

test('setWorkspace(decoy) routes every subsequent query to the decoy file', async () => {
  db.setWorkspace('decoy');
  await db.initDb();
  await db.insertMessage({
    msgId: '01TEST',
    peerId: 'peer1',
    direction: 'out',
    body: 'garble',
    ts: 1,
    status: 'sent',
  });
  expect(sqlite.opened).toEqual(['tacendum-decoy.sqlite']);
  const decoy = sqlite.instances.get('tacendum-decoy.sqlite')!;
  const statements = decoy.execute.mock.calls.map(c => String(c[0]));
  expect(statements.some(s => s.includes('INSERT OR IGNORE INTO messages'))).toBe(
    true,
  );
  expect(sqlite.instances.has('tacendum.sqlite')).toBe(false);
});

test('switching back to real reaches the real file again', async () => {
  db.setWorkspace('decoy');
  await db.initDb();
  await db.close();
  db.setWorkspace('real');
  await db.initDb();
  expect(sqlite.opened[sqlite.opened.length - 1]).toBe('tacendum.sqlite');
});

test('setWorkspace with an open connection throws (rule 14)', async () => {
  await db.initDb();
  expect(() => db.setWorkspace('decoy')).toThrow(/close/i);
});

test('close() waits for a pending transaction before releasing the handle', async () => {
  await db.initDb();
  const real = sqlite.instances.get('tacendum.sqlite')!;
  let releaseBegin!: () => void;
  const gate = new Promise<void>(resolve => {
    releaseBegin = resolve;
  });
  real.execute.mockImplementation(async (sql: string) => {
    if (String(sql) === 'BEGIN IMMEDIATE') await gate;
    return { rows: [] };
  });

  const pending = db.enqueueOutgoing(
    {
      msgId: '01TX',
      peerId: 'peer1',
      direction: 'out',
      body: 'x',
      ts: 1,
      status: 'pending',
    },
    { msgType: 'ciphertext', payload: 'AAAA' },
  );

  let closed = false;
  const closing = db.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);

  releaseBegin();
  await pending;
  await closing;
  expect(closed).toBe(true);
  expect(real.close).toHaveBeenCalled();
});
