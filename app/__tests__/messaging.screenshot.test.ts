/**
 * Screenshot notices: a captured conversation says so on both sides. The
 * notice is an ordinary (non-carrier) envelope row, so it must obey the same
 * seams as any send — duress composes locally, failures
 * never interrupt the person, and the incoming side lands as a normal row
 * with a named preview, never raw envelope JSON.
 */

jest.mock('../src/ws', () => {
  const handlers: {
    frame?: (f: unknown) => void;
    state?: (s: string) => void;
  } = {};
  const calls = {
    start: jest.fn(),
    stop: jest.fn(),
    send: jest.fn((_frame: unknown) => true),
  };
  class WsClient {
    onFrame(cb: (f: unknown) => void) {
      handlers.frame = cb;
    }
    onState(cb: (s: string) => void) {
      handlers.state = cb;
    }
    start(token: string) {
      calls.start(token);
    }
    stop() {
      calls.stop();
    }
    send(frame: unknown) {
      return calls.send(frame) as boolean;
    }
    get isOpen() {
      return false;
    }
  }
  return { WsClient, __ws: { handlers, calls } };
});

jest.mock('../src/api', () => ({
  apiUploadKeys: jest.fn().mockRejectedValue(new Error('network in test')),
  apiGetPrekeyBundle: jest.fn().mockRejectedValue(new Error('network in test')),
  apiCreateAttachment: jest
    .fn()
    .mockRejectedValue(new Error('network in test')),
  apiGetAttachmentUrl: jest
    .fn()
    .mockRejectedValue(new Error('network in test')),
  uploadBlob: jest.fn().mockRejectedValue(new Error('network in test')),
  downloadBlob: jest.fn().mockRejectedValue(new Error('network in test')),
}));

import * as db from '../src/db';
import { messaging } from '../src/messaging';
import { session } from '../src/session';

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
const crypto = jest.requireMock('tacendum-crypto') as {
  __keychain: Map<string, string>;
  encryptText: jest.Mock;
  decryptEnvelope: jest.Mock;
  hasSession: jest.Mock;
};
const ws = (
  jest.requireMock('../src/ws') as {
    __ws: {
      handlers: { frame?: (f: unknown) => void };
      calls: { start: jest.Mock; send: jest.Mock };
    };
  }
).__ws;

const SHOT_BODY = '{"tcm":"shot"}';

function callsOf(instance: FakeDb | undefined, fragment: string): unknown[][] {
  return (instance?.execute.mock.calls ?? []).filter(c =>
    String(c[0]).includes(fragment),
  );
}

async function flush(): Promise<void> {
  // The incoming pipeline is a long await chain (decrypt → persist → touch →
  // markSeen → ack); give it enough microtask turns to reach the ack.
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

beforeEach(async () => {
  messaging.stop();
  await db.close();
  crypto.__keychain.clear();
  sqlite.reset();
  crypto.encryptText.mockClear();
  crypto.decryptEnvelope.mockReset();
  crypto.hasSession.mockReset();
  crypto.hasSession.mockResolvedValue(false);
  ws.calls.start.mockClear();
  ws.calls.send.mockClear();
  session.setMode('real');
  db.setWorkspace('real');
});

afterEach(async () => {
  messaging.stop();
  await db.close();
  session.setMode('real');
  db.setWorkspace('real');
});

describe('duress session (rule 15)', () => {
  beforeEach(async () => {
    session.setMode('duress');
    db.setWorkspace('decoy');
    await db.initDb();
  });

  test('sendScreenshotNotice writes a local decoy row and never touches crypto or the wire', async () => {
    await messaging.sendScreenshotNotice('decoy-peer');
    const decoy = sqlite.instances.get('tacendum-decoy.sqlite');
    const inserts = callsOf(decoy, 'INSERT OR IGNORE INTO messages');
    expect(inserts.length).toBe(1);
    expect(inserts[0][1]).toContain(SHOT_BODY);
    expect(inserts[0][1]).toContain('sent');
    const touches = callsOf(
      decoy,
      'lastMessageText = excluded.lastMessageText',
    );
    expect(touches.length).toBe(1);
    expect(touches[0][1]).toContain('Screenshot');
    expect(crypto.encryptText).not.toHaveBeenCalled();
    expect(ws.calls.send).not.toHaveBeenCalled();
    expect(sqlite.instances.has('tacendum.sqlite')).toBe(false);
  });

  test('a duress notice whose local write fails still fails silently', async () => {
    const decoy = sqlite.instances.get('tacendum-decoy.sqlite')!;
    const base = decoy.execute.getMockImplementation()!;
    decoy.execute.mockImplementation(async (sql: string, params?: unknown) => {
      if (String(sql).includes('INSERT OR IGNORE INTO messages')) {
        throw new Error('disk sad');
      }
      return base(sql, params);
    });
    await expect(
      messaging.sendScreenshotNotice('decoy-peer'),
    ).resolves.toBeUndefined();
  });
});

describe('real session', () => {
  beforeEach(async () => {
    crypto.__keychain.set('authToken', 'token-1');
    await db.initDb();
    await messaging.start('me-user');
    await flush();
  });

  test('sendScreenshotNotice encrypts the envelope and enqueues it with a named preview', async () => {
    crypto.hasSession.mockResolvedValue(true);
    await messaging.sendScreenshotNotice('peer-1');

    expect(crypto.encryptText).toHaveBeenCalledWith(
      'me-user',
      'peer-1',
      SHOT_BODY,
    );
    const real = sqlite.instances.get('tacendum.sqlite');
    const inserts = callsOf(real, 'INSERT OR IGNORE INTO messages');
    expect(inserts.length).toBe(1);
    expect(inserts[0][1]).toContain(SHOT_BODY);
    expect(inserts[0][1]).toContain('pending');
    expect(callsOf(real, 'INSERT OR IGNORE INTO outbox').length).toBe(1);
    const touches = callsOf(real, 'lastMessageText = excluded.lastMessageText');
    expect(touches.length).toBe(1);
    expect(touches[0][1]).toContain('Screenshot');
  });

  test('a notice that cannot be sent fails silently and writes nothing', async () => {
    // hasSession is false and the prekey fetch rejects: the send path cannot
    // bootstrap. A screenshot must never surface an error or crash the app.
    await expect(
      messaging.sendScreenshotNotice('peer-1'),
    ).resolves.toBeUndefined();
    const real = sqlite.instances.get('tacendum.sqlite');
    expect(callsOf(real, 'INSERT OR IGNORE INTO messages').length).toBe(0);
    expect(ws.calls.send).not.toHaveBeenCalled();
  });

  test('a notice that fails after encryption still fails silently', async () => {
    crypto.hasSession.mockResolvedValue(true);
    crypto.encryptText.mockRejectedValueOnce(new Error('ratchet sad'));
    await expect(
      messaging.sendScreenshotNotice('peer-1'),
    ).resolves.toBeUndefined();
    const real = sqlite.instances.get('tacendum.sqlite');
    expect(callsOf(real, 'INSERT OR IGNORE INTO messages').length).toBe(0);
    expect(ws.calls.send).not.toHaveBeenCalled();
  });

  test('an incoming notice lands as a normal row with the named preview and is acked', async () => {
    crypto.decryptEnvelope.mockResolvedValue(SHOT_BODY);
    ws.handlers.frame?.({
      type: 'msg',
      from: 'peer-1',
      msgId: '01SHOT',
      msgType: 'ciphertext',
      payload: 'AAAA',
      ts: 5,
    });
    await flush();

    const real = sqlite.instances.get('tacendum.sqlite');
    const inserts = callsOf(real, 'INSERT OR IGNORE INTO messages');
    expect(inserts.length).toBe(1);
    expect(inserts[0][1]).toContain(SHOT_BODY);
    expect(inserts[0][1]).toContain('received');
    const touches = callsOf(real, 'lastMessageText = excluded.lastMessageText');
    expect(touches.length).toBe(1);
    expect(touches[0][1]).toContain('Screenshot');
    expect(ws.calls.send).toHaveBeenCalledWith({
      type: 'ack',
      msgId: '01SHOT',
    });
  });
});
