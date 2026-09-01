/**
 * Editing, retracting and replying. Edits and retractions are carriers that
 * mutate an existing row; a reply is an ordinary message. All three obey the
 * same seams as every other send: duress is local-only,
 * and an incoming mutation is scoped to the sender's own conversation.
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
  apiDeleteAccount: jest.fn().mockRejectedValue(new Error('network in test')),
  apiCreateAttachment: jest.fn().mockRejectedValue(new Error('network in test')),
  apiGetAttachmentUrl: jest.fn().mockRejectedValue(new Error('network in test')),
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

const TARGET = '01TARGET';

function callsOf(file: string, fragment: string): unknown[][] {
  const instance = sqlite.instances.get(file);
  return (instance?.execute.mock.calls ?? []).filter(c =>
    String(c[0]).includes(fragment),
  );
}

async function flush(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

async function deliver(text: string, from = 'peer-1'): Promise<void> {
  crypto.decryptEnvelope.mockResolvedValue(text);
  ws.handlers.frame?.({
    type: 'msg',
    from,
    msgId: `01IN${Math.floor(Math.random() * 1e6)}`,
    msgType: 'ciphertext',
    payload: 'AAAA',
    ts: 9000,
  });
  await flush();
}

beforeEach(async () => {
  messaging.stop();
  await db.close();
  crypto.__keychain.clear();
  sqlite.reset();
  crypto.encryptText.mockClear();
  crypto.decryptEnvelope.mockReset();
  crypto.hasSession.mockReset();
  crypto.hasSession.mockResolvedValue(true);
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

describe('duress (rule 15)', () => {
  beforeEach(async () => {
    session.setMode('duress');
    db.setWorkspace('decoy');
    await db.initDb();
  });

  test('an edit rewrites the decoy row only — no crypto, no wire', async () => {
    await messaging.sendEdit('decoy-peer', TARGET, 'rewritten');
    expect(
      callsOf('tacendum-decoy.sqlite', 'UPDATE messages SET body').length,
    ).toBeGreaterThan(0);
    expect(crypto.encryptText).not.toHaveBeenCalled();
    expect(ws.calls.send).not.toHaveBeenCalled();
    expect(sqlite.instances.has('tacendum.sqlite')).toBe(false);
  });

  test('a retraction tombstones the decoy row only', async () => {
    await messaging.sendDelete('decoy-peer', TARGET);
    expect(
      callsOf('tacendum-decoy.sqlite', 'deletedAt = ?').length,
    ).toBeGreaterThan(0);
    expect(crypto.encryptText).not.toHaveBeenCalled();
    expect(ws.calls.send).not.toHaveBeenCalled();
  });

  test('a reply writes a local decoy row only', async () => {
    await messaging.sendReply('decoy-peer', TARGET, 'in', 'answering');
    const inserts = callsOf(
      'tacendum-decoy.sqlite',
      'INSERT OR IGNORE INTO messages',
    );
    expect(inserts.length).toBe(1);
    expect(String(inserts[0][1])).toContain('"tcm":"reply"');
    expect(crypto.encryptText).not.toHaveBeenCalled();
    expect(ws.calls.send).not.toHaveBeenCalled();
  });
});

describe('sending', () => {
  beforeEach(async () => {
    crypto.__keychain.set('authToken', 'token-1');
    await db.initDb();
    await messaging.start('me-user');
    await flush();
  });

  test('an edit ships the envelope and rewrites my own row at once', async () => {
    await messaging.sendEdit('peer-1', TARGET, 'meant tomorrow');
    expect(crypto.encryptText).toHaveBeenCalledWith(
      'me-user',
      'peer-1',
      '{"tcm":"edit","ref":"01TARGET","text":"meant tomorrow"}',
    );
    // My copy changes immediately — the row I edited is 'out' on this device.
    const [update] = callsOf('tacendum.sqlite', 'UPDATE messages SET body');
    expect(update[1]).toContain('out');
    expect(update[1]).toContain('meant tomorrow');
    expect(update[1]).toContain('peer-1');
  });

  test('a retraction ships the envelope and tombstones my own row', async () => {
    await messaging.sendDelete('peer-1', TARGET);
    expect(crypto.encryptText).toHaveBeenCalledWith(
      'me-user',
      'peer-1',
      '{"tcm":"del","ref":"01TARGET"}',
    );
    const [tomb] = callsOf('tacendum.sqlite', 'deletedAt = ?');
    expect(tomb[1]).toContain('out');
    expect(tomb[1]).toContain('peer-1');
  });

  test('retracting a message that never left stops it from being sent', async () => {
    await messaging.sendDelete('peer-1', TARGET);
    // The queued ciphertext is the message. Leaving it in the outbox means a
    // reconnect delivers words the sender has already taken back.
    const dropped = callsOf('tacendum.sqlite', 'DELETE FROM outbox');
    expect(dropped.length).toBeGreaterThan(0);
    expect(dropped[0][1]).toContain(TARGET);
  });

  test('a reply is an ordinary message row, previewed by its own words', async () => {
    await messaging.sendReply('peer-1', TARGET, 'in', 'yes, that one');
    expect(crypto.encryptText).toHaveBeenCalledWith(
      'me-user',
      'peer-1',
      // ofs is false: the message being answered is theirs, not mine.
      '{"tcm":"reply","ref":"01TARGET","ofs":false,"text":"yes, that one"}',
    );
    const inserts = callsOf('tacendum.sqlite', 'INSERT OR IGNORE INTO messages');
    expect(inserts.length).toBe(1);
    const touches = callsOf(
      'tacendum.sqlite',
      'lastMessageText = excluded.lastMessageText',
    );
    expect(String(touches[0][1])).toContain('yes, that one');
  });

  test('replying to my own message sets the authorship bit', async () => {
    await messaging.sendReply('peer-1', TARGET, 'out', 'still true');
    expect(crypto.encryptText).toHaveBeenCalledWith(
      'me-user',
      'peer-1',
      '{"tcm":"reply","ref":"01TARGET","ofs":true,"text":"still true"}',
    );
  });
});

describe('receiving', () => {
  beforeEach(async () => {
    crypto.__keychain.set('authToken', 'token-1');
    await db.initDb();
    await messaging.start('me-user');
    await flush();
    ws.calls.send.mockClear();
  });

  test('an incoming edit rewrites their row in THIS conversation only', async () => {
    await deliver('{"tcm":"edit","ref":"01TARGET","text":"actually Friday"}');

    const [update] = callsOf('tacendum.sqlite', 'UPDATE messages SET body');
    expect(update).toBeDefined();
    const params = update[1] as unknown[];
    // Scoped to the sender: their id is in the WHERE clause, and the row is
    // the one they authored — 'in' from here.
    expect(params).toContain('peer-1');
    expect(params).toContain('in');
    expect(params).toContain('actually Friday');
    // A carrier adds no row and no unread.
    expect(callsOf('tacendum.sqlite', 'INSERT OR IGNORE INTO messages').length).toBe(0);
    expect(ws.calls.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'ack' }),
    );
  });

  test('a zero frame timestamp cannot erase the Edited marker or the tombstone', async () => {
    // frame.ts is relayed, not proven. Stamping it verbatim would let a peer
    // send ts:0 and get a rewrite whose `editedAt` is falsy — an edit with no
    // marker, and a retraction the thread would render as an ordinary row.
    crypto.decryptEnvelope.mockResolvedValue(
      '{"tcm":"edit","ref":"01TARGET","text":"quietly changed"}',
    );
    ws.handlers.frame?.({
      type: 'msg',
      from: 'peer-1',
      msgId: '01ZEROTS',
      msgType: 'ciphertext',
      payload: 'AAAA',
      ts: 0,
    });
    await flush();

    const [update] = callsOf('tacendum.sqlite', 'UPDATE messages SET body');
    const stamp = (update[1] as unknown[])[1];
    expect(typeof stamp).toBe('number');
    expect(stamp as number).toBeGreaterThan(0);
  });

  test('an incoming retraction tombstones their row and acks', async () => {
    await deliver('{"tcm":"del","ref":"01TARGET"}');

    const [tomb] = callsOf('tacendum.sqlite', 'deletedAt = ?');
    expect(tomb).toBeDefined();
    const params = tomb[1] as unknown[];
    expect(params).toContain('peer-1');
    expect(params).toContain('in');
    expect(callsOf('tacendum.sqlite', 'INSERT OR IGNORE INTO messages').length).toBe(0);
    expect(ws.calls.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'ack' }),
    );
  });

  test('a retraction that arrives before its message still lands when the message does', async () => {
    // Frames are handled concurrently and drained in queue order, so a cheap
    // 'del' can finish decrypting before the expensive 'prekey' original. The
    // ack purges the server's copy, so if the revision were dropped here it
    // would be gone forever — the sender's UI would say retracted while the
    // peer kept the words.
    await deliver('{"tcm":"del","ref":"01LATER"}');
    expect(
      callsOf('tacendum.sqlite', 'INTO pending_revisions').length,
    ).toBeGreaterThan(0);
    expect(ws.calls.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'ack' }),
    );

    // Now the message itself arrives. The fake db does not persist, so the
    // parked row is fed back the way SQLite would return it.
    const real = sqlite.instances.get('tacendum.sqlite')!;
    const base = real.execute.getMockImplementation()!;
    real.execute.mockImplementation(async (sql: string, params?: unknown) => {
      if (String(sql).includes('FROM pending_revisions')) {
        return { rows: [{ kind: 'del', text: '', ts: 9000 }] };
      }
      return base(sql, params);
    });
    const before = callsOf('tacendum.sqlite', 'deletedAt = ?').length;
    crypto.decryptEnvelope.mockResolvedValue('the words');
    ws.handlers.frame?.({
      type: 'msg',
      from: 'peer-1',
      msgId: '01LATER',
      msgType: 'prekey',
      payload: 'AAAA',
      ts: 9500,
    });
    await flush();
    expect(
      callsOf('tacendum.sqlite', 'deletedAt = ?').length,
    ).toBeGreaterThan(before);
  });

  test('an incoming reply lands as a real row with its own words as preview', async () => {
    await deliver(
      '{"tcm":"reply","ref":"01TARGET","ofs":false,"text":"on my way"}',
    );

    const inserts = callsOf('tacendum.sqlite', 'INSERT OR IGNORE INTO messages');
    expect(inserts.length).toBe(1);
    expect(String(inserts[0][1])).toContain('"tcm":"reply"');
    const touches = callsOf(
      'tacendum.sqlite',
      'lastMessageText = excluded.lastMessageText',
    );
    expect(String(touches[0][1])).toContain('on my way');
  });
});
