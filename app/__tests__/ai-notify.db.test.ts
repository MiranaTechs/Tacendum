import * as db from '../src/db';

type Row = Record<string, unknown>;
interface Engine {
  prepare(sql: string): { all(...args: unknown[]): Row[] };
  close(): void;
}
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (path: string) => Engine;
};

interface FakeDb {
  execute: jest.Mock;
}
const sqlite = jest.requireMock('@op-engineering/op-sqlite') as {
  open: (options: { name: string }) => FakeDb;
  __sqlite: { reset: () => void };
};

const PEER = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const OTHER = '01BX5ZZKBKACTAV9WEVGEMMVRZ';
const Q1 = '01J8MEAPPR0VAQ4X2C6TKN9RFW';
const Q2 = '01J8MEAPPR0VAQ4X2C6TKN9RFX';
const NOW = 1_800_000_000_000;
let engine: Engine;

beforeEach(async () => {
  await db.close();
  sqlite.__sqlite.reset();
  db.setWorkspace('real');
  engine = new DatabaseSync(':memory:');
  const instance = sqlite.open({ name: 'tacendum.sqlite' });
  instance.execute.mockImplementation(
    async (sql: unknown, params?: unknown[]) => {
      const rows = engine
        .prepare(String(sql))
        .all(...(params ?? []).map(value => (value === undefined ? null : value)));
      const changes = engine.prepare('SELECT changes() AS c').all()[0]!.c;
      return { rows, rowsAffected: changes };
    },
  );
  await db.initDb();
  await db.upsertChat(PEER, 'Codex');
  await db.upsertChat(OTHER, 'Claude');
});

afterEach(async () => {
  await db.close();
  engine.close();
});

test('defaults to all and changes effective mode only on exact peer q and value ack', async () => {
  await expect(db.getAiNotifyPreference(PEER)).resolves.toEqual({
    peerId: PEER,
    effectiveRoutine: 'all',
    pendingQ: null,
    requestedRoutine: null,
    requestedAt: null,
    acknowledgedAt: null,
  });
  await expect(
    db.beginAiNotifyPreference(PEER, Q1, 'quiet', NOW),
  ).resolves.toBe(true);
  await expect(db.getAiNotifyPreference(PEER)).resolves.toMatchObject({
    effectiveRoutine: 'all',
    pendingQ: Q1,
    requestedRoutine: 'quiet',
  });

  await expect(
    db.applyAiNotifyPreferenceAck(OTHER, Q1, 'quiet', NOW + 1),
  ).resolves.toBe(false);
  await expect(
    db.applyAiNotifyPreferenceAck(PEER, Q2, 'quiet', NOW + 1),
  ).resolves.toBe(false);
  await expect(
    db.applyAiNotifyPreferenceAck(PEER, Q1, 'all', NOW + 1),
  ).resolves.toBe(false);
  await expect(db.getAiNotifyPreference(PEER)).resolves.toMatchObject({
    effectiveRoutine: 'all',
    pendingQ: Q1,
  });

  await expect(
    db.applyAiNotifyPreferenceAck(PEER, Q1, 'quiet', NOW + 2),
  ).resolves.toBe(true);
  await expect(db.getAiNotifyPreference(PEER)).resolves.toMatchObject({
    effectiveRoutine: 'quiet',
    pendingQ: null,
    requestedRoutine: null,
    requestedAt: null,
    acknowledgedAt: NOW + 2,
  });
});

test('a newer owner choice makes an older acknowledgement harmless', async () => {
  await db.beginAiNotifyPreference(PEER, Q1, 'quiet', NOW);
  await db.beginAiNotifyPreference(PEER, Q2, 'all', NOW + 1);

  await expect(
    db.applyAiNotifyPreferenceAck(PEER, Q1, 'quiet', NOW + 2),
  ).resolves.toBe(false);
  await expect(db.getAiNotifyPreference(PEER)).resolves.toMatchObject({
    effectiveRoutine: 'all',
    pendingQ: Q2,
    requestedRoutine: 'all',
  });
  await expect(
    db.applyAiNotifyPreferenceAck(PEER, Q2, 'all', NOW + 3),
  ).resolves.toBe(true);
});

test('duplicate acknowledgement does not refresh its applied time', async () => {
  await db.beginAiNotifyPreference(PEER, Q1, 'quiet', NOW);
  await db.applyAiNotifyPreferenceAck(PEER, Q1, 'quiet', NOW + 1);
  await expect(
    db.applyAiNotifyPreferenceAck(PEER, Q1, 'quiet', NOW + 9),
  ).resolves.toBe(false);
  await expect(db.getAiNotifyPreference(PEER)).resolves.toMatchObject({
    effectiveRoutine: 'quiet',
    acknowledgedAt: NOW + 1,
  });
});

test('clearing a failed carrier cannot erase a newer pending choice', async () => {
  await db.beginAiNotifyPreference(PEER, Q1, 'quiet', NOW);
  await db.beginAiNotifyPreference(PEER, Q2, 'all', NOW + 1);
  await db.clearAiNotifyPreferenceRequest(PEER, Q1);
  await expect(db.getAiNotifyPreference(PEER)).resolves.toMatchObject({
    pendingQ: Q2,
    requestedRoutine: 'all',
  });
});

test('delete, block and successful revocation burn preference state', async () => {
  await db.beginAiNotifyPreference(PEER, Q1, 'quiet', NOW);
  await db.deleteChat(PEER);
  await expect(db.getAiNotifyPreference(PEER)).resolves.toMatchObject({
    effectiveRoutine: 'all',
    pendingQ: null,
  });

  await db.upsertChat(PEER, 'Codex again');
  await db.beginAiNotifyPreference(PEER, Q1, 'quiet', NOW + 1);
  await db.blockPeer(PEER, NOW + 2);
  await expect(db.getAiNotifyPreference(PEER)).resolves.toMatchObject({
    effectiveRoutine: 'all',
    pendingQ: null,
  });

  await db.unblockPeer(PEER);
  await db.beginAiNotifyPreference(PEER, Q2, 'quiet', NOW + 3);
  await db.recordMachineRevoked(PEER, NOW + 4);
  await expect(db.getAiNotifyPreference(PEER)).resolves.toMatchObject({
    effectiveRoutine: 'all',
    pendingQ: null,
  });
  await expect(
    db.beginAiNotifyPreference(PEER, Q1, 'quiet', NOW + 5),
  ).resolves.toBe(false);
});
