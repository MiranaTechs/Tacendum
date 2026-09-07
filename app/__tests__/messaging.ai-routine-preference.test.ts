/**
 * Owner-selected AI notification posture, through the real messaging producer
 * and the real SQLite statements. The control request must be durable before
 * it can reach the wire, must stay quiet on every device leg, and must not
 * depend on publishing a human profile or uploading its avatar.
 */

jest.mock('../src/ws', () => {
  const handlers: {
    frame?: (frame: unknown) => void;
    state?: (state: string) => void;
  } = {};
  const state = { open: false };
  const calls = {
    start: jest.fn(),
    stop: jest.fn(),
    send: jest.fn((_frame: unknown) => true),
  };
  class WsClient {
    onFrame(cb: (frame: unknown) => void) {
      handlers.frame = cb;
    }
    onState(cb: (state: string) => void) {
      handlers.state = cb;
    }
    start(...args: unknown[]) {
      calls.start(...args);
    }
    stop() {
      calls.stop();
    }
    send(frame: unknown) {
      return calls.send(frame) as boolean;
    }
    get isOpen() {
      return state.open;
    }
    adoptToken() {}
  }
  return { WsClient, __ws: { handlers, calls, state } };
});

jest.mock('../src/api', () => ({
  apiUploadKeys: jest.fn(),
  apiDeleteAccount: jest.fn(),
  apiGetPrekeyBundle: jest.fn(),
  apiCreateAttachment: jest.fn(),
  apiGetAttachmentUrl: jest.fn(),
  apiWsTicket: jest.fn(),
  uploadBlob: jest.fn(),
  downloadBlob: jest.fn(),
}));

jest.mock('../src/decoy', () => ({
  syncDecoyProfile: jest.fn(async () => undefined),
}));

import * as db from '../src/db';
import { messaging } from '../src/messaging';
import { session } from '../src/session';

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
  open(options: { name: string }): FakeDb;
  __sqlite: { reset(): void };
};
const crypto = jest.requireMock('tacendum-crypto') as {
  __keychain: Map<string, string>;
  encryptText: jest.Mock;
  hasSession: jest.Mock;
};
const api = jest.requireMock('../src/api') as Record<string, jest.Mock>;
const ws = (
  jest.requireMock('../src/ws') as {
    __ws: {
      calls: { send: jest.Mock };
      state: { open: boolean };
    };
  }
).__ws;

const pad = (seed: string): string => (seed + '0'.repeat(26)).slice(0, 26);
const ME = pad('ME');
const AGENT = pad('AGENT');
const AGENT_TABLET = pad('AGENTTABLET');
const RETRY_Q = '01J8MEAPPR0VAQ4X2C6TKN9RFW';
const NEWER_Q = '01J8MEAPPR0VAQ4X2C6TKN9RFX';

let engine: Engine;

function bindRealEngine(): void {
  engine = new DatabaseSync(':memory:');
  const instance = sqlite.open({ name: 'tacendum.sqlite' });
  instance.execute.mockImplementation(
    async (sql: unknown, params?: unknown[]) => {
      const rows = engine
        .prepare(String(sql))
        .all(...(params ?? []).map(value => (value === undefined ? null : value)));
      const changes = engine.prepare('SELECT changes() AS c').all()[0]!
        .c as number;
      return { rows, rowsAffected: changes };
    },
  );
}

const query = (sql: string, ...args: unknown[]): Row[] =>
  engine.prepare(sql).all(...args);

async function settle(turns = 60): Promise<void> {
  for (let i = 0; i < turns; i++) await Promise.resolve();
}

async function waitForPending(): Promise<db.AiNotifyPreferenceRow> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const row = await db.getAiNotifyPreference(AGENT);
    if (row.pendingQ !== null) return row;
    await Promise.resolve();
  }
  throw new Error('preference request did not become pending');
}

beforeEach(async () => {
  messaging.stop();
  await db.close();
  sqlite.__sqlite.reset();
  session.setMode('real');
  db.setWorkspace('real');
  bindRealEngine();
  crypto.__keychain.clear();
  crypto.__keychain.set('authToken', 'test-token');
  crypto.hasSession.mockReset().mockResolvedValue(true);
  crypto.encryptText.mockReset().mockImplementation(
    async (_self: string, _to: string) => ({
      msgType: 'ciphertext',
      payload: 'QUFBQQ==',
    }),
  );
  for (const fn of Object.values(api)) fn.mockReset();
  ws.state.open = false;
  ws.calls.send.mockReset().mockImplementation(() => true);

  await db.initDb();
  await db.saveProfile({
    userId: ME,
    registrationId: 1,
    displayName: '',
    about: '',
    avatarB64: 'private-avatar-bytes',
    profileVersion: 0,
  });
  await db.upsertChat(AGENT, 'Claude Code');
  const now = Date.now();
  await db.recordAiWork(AGENT, 'profile-capability', now, {
    provider: 'claude',
    updatedAt: now,
    capabilities: { notifications: true, approvals: false, tasks: false },
  });
  await db.upsertPeerDevice({
    userId: AGENT,
    anchorId: AGENT,
    class: 'phone',
    state: 'linked',
    identityKeyPub: 'agent-key',
    certsJson: '',
    updatedAt: now,
  });
  await db.upsertPeerDevice({
    userId: AGENT_TABLET,
    anchorId: AGENT,
    class: 'tablet',
    state: 'linked',
    identityKeyPub: 'agent-tablet-key',
    certsJson: '',
    updatedAt: now,
  });

  await messaging.start(ME);
  await settle();
  ws.calls.send.mockClear();
});

afterEach(async () => {
  messaging.stop();
  await db.close();
  engine.close();
  session.setMode('real');
  db.setWorkspace('real');
});

test('profileVersion 0 emits one inert quiet carrier to every peer device and persists before encryption', async () => {
  const observedDuringEncryption: db.AiNotifyPreferenceRow[] = [];
  crypto.encryptText.mockImplementation(
    async (_self: string, _to: string, plaintext: string) => {
      observedDuringEncryption.push(await db.getAiNotifyPreference(AGENT));
      return {
        msgType: 'ciphertext',
        payload: 'QUFBQQ==',
      };
    },
  );

  const q = await messaging.setAiRoutinePreference(AGENT, 'quiet');

  expect(observedDuringEncryption).toHaveLength(2);
  expect(observedDuringEncryption).toEqual([
    expect.objectContaining({
      effectiveRoutine: 'all',
      pendingQ: q,
      requestedRoutine: 'quiet',
    }),
    expect.objectContaining({
      effectiveRoutine: 'all',
      pendingQ: q,
      requestedRoutine: 'quiet',
    }),
  ]);
  const plaintexts = crypto.encryptText.mock.calls.map(call => call[2] as string);
  expect(plaintexts).toEqual([
    JSON.stringify({
      tcm: 'profile',
      n: '',
      a: '',
      v: 0,
      notifyPref: { q, routine: 'quiet' },
    }),
    JSON.stringify({
      tcm: 'profile',
      n: '',
      a: '',
      v: 0,
      notifyPref: { q, routine: 'quiet' },
    }),
  ]);
  expect(api.apiCreateAttachment).not.toHaveBeenCalled();
  expect(api.uploadBlob).not.toHaveBeenCalled();
  expect(query(`SELECT peerId, notify FROM outbox ORDER BY seq`)).toEqual([
    { peerId: AGENT, notify: 0 },
    { peerId: AGENT_TABLET, notify: 0 },
  ]);
  expect(query(`SELECT lastMessageText FROM chats WHERE peerId = ?`, AGENT)).toEqual([
    { lastMessageText: null },
  ]);
  expect(ws.calls.send).not.toHaveBeenCalled();
});

test('retry reuses the exact pending q and mode in an inert offline carrier', async () => {
  await db.beginAiNotifyPreference(AGENT, RETRY_Q, 'quiet', Date.now());

  await expect(messaging.retryAiRoutinePreference(AGENT)).resolves.toBe(RETRY_Q);

  const plaintexts = crypto.encryptText.mock.calls.map(call =>
    JSON.parse(call[2] as string),
  );
  expect(plaintexts).toEqual([
    {
      tcm: 'profile',
      n: '',
      a: '',
      v: 0,
      notifyPref: { q: RETRY_Q, routine: 'quiet' },
    },
    {
      tcm: 'profile',
      n: '',
      a: '',
      v: 0,
      notifyPref: { q: RETRY_Q, routine: 'quiet' },
    },
  ]);
  await expect(db.getAiNotifyPreference(AGENT)).resolves.toMatchObject({
    effectiveRoutine: 'all',
    pendingQ: RETRY_Q,
    requestedRoutine: 'quiet',
  });
  expect(query(`SELECT notify FROM outbox ORDER BY seq`)).toEqual([
    { notify: 0 },
    { notify: 0 },
  ]);
});

test('a post-commit transport failure keeps the request and quiet outbox durable', async () => {
  ws.state.open = true;
  ws.calls.send.mockImplementationOnce(() => {
    throw new Error('dead transport');
  });

  const q = await messaging.setAiRoutinePreference(AGENT, 'quiet');

  await expect(db.getAiNotifyPreference(AGENT)).resolves.toMatchObject({
    pendingQ: q,
    requestedRoutine: 'quiet',
  });
  expect(query(`SELECT notify FROM outbox ORDER BY seq`)).toEqual([
    { notify: 0 },
    { notify: 0 },
  ]);
});

test('a pre-commit compose failure clears only its own q, preserving a newer owner choice', async () => {
  let rejectEncryption: ((error: Error) => void) | undefined;
  crypto.encryptText.mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        rejectEncryption = reject;
      }),
  );

  const changing = messaging.setAiRoutinePreference(AGENT, 'quiet');
  const first = await waitForPending();
  for (let attempt = 0; rejectEncryption === undefined && attempt < 50; attempt++) {
    await Promise.resolve();
  }
  if (rejectEncryption === undefined) {
    throw new Error('preference carrier did not reach encryption');
  }
  await db.beginAiNotifyPreference(AGENT, NEWER_Q, 'all', Date.now() + 1);
  rejectEncryption(new Error('compose failed'));

  await expect(changing).rejects.toThrow('compose failed');
  expect(first.pendingQ).not.toBe(NEWER_Q);
  await expect(db.getAiNotifyPreference(AGENT)).resolves.toMatchObject({
    pendingQ: NEWER_Q,
    requestedRoutine: 'all',
  });
  expect(query(`SELECT * FROM outbox`)).toEqual([]);
});
