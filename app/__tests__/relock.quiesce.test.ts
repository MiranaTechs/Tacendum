/**
 * Async work already in flight
 * when a relock happens must not write into whichever workspace opens NEXT.
 * These stage the exact sequence: work suspends mid-await → relock (stop +
 * close) → duress unlock (setWorkspace decoy + initDb) → work resumes.
 */

jest.mock('../src/ws', () => {
  const handlers: { frame?: (f: unknown) => void } = {};
  class WsClient {
    onFrame(cb: (f: unknown) => void) {
      handlers.frame = cb;
    }
    onState(_cb: (s: string) => void) {}
    start(_token: string) {}
    stop() {}
    send(_frame: unknown) {
      return true;
    }
    get isOpen() {
      return false;
    }
  }
  return { WsClient, __ws: { handlers } };
});

jest.mock('../src/api', () => ({
  apiUploadKeys: jest.fn(),
  apiGetPrekeyBundle: jest.fn(),
  apiCreateAttachment: jest.fn(),
  apiGetAttachmentUrl: jest.fn(),
  uploadBlob: jest.fn(),
  downloadBlob: jest.fn(),
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
  decryptEnvelope: jest.Mock;
  blobDecrypt: jest.Mock;
};
const api = jest.requireMock('../src/api') as {
  apiGetAttachmentUrl: jest.Mock;
  downloadBlob: jest.Mock;
};
const ws = (
  jest.requireMock('../src/ws') as {
    __ws: { handlers: { frame?: (f: unknown) => void } };
  }
).__ws;

async function flush(): Promise<void> {
  // 40 ticks (was 20): the inbound gate (peer-device hold) and the send-path device-set read each add awaits ahead of the
  // moments this suite parks on — the op-sqlite mock's own precedent for
  // raising a fixed tick budget when the path legitimately deepens.
  for (let i = 0; i < 40; i++) await Promise.resolve();
}

function mutations(instance: FakeDb | undefined): string[] {
  return (instance?.execute.mock.calls ?? [])
    .map(c => String(c[0]))
    .filter(s => /INSERT|UPDATE|DELETE/i.test(s));
}

async function relockThenDuressUnlock(): Promise<void> {
  messaging.stop();
  await db.close();
  session.setMode('duress');
  db.setWorkspace('decoy');
  await db.initDb();
}

beforeEach(async () => {
  messaging.stop();
  await db.close();
  session.setMode('real');
  db.setWorkspace('real');
  crypto.__keychain.clear();
  crypto.__keychain.set('authToken', 'tok');
  sqlite.reset();
  crypto.decryptEnvelope.mockReset();
  api.apiGetAttachmentUrl.mockReset();
  api.downloadBlob.mockReset();
});

afterEach(async () => {
  messaging.stop();
  await db.close();
  session.setMode('real');
  db.setWorkspace('real');
});

test('a decrypt in flight across a relock writes nothing into the decoy world', async () => {
  let releaseDecrypt!: (text: string) => void;
  crypto.decryptEnvelope.mockImplementation(
    () => new Promise<string>(resolve => (releaseDecrypt = resolve)),
  );
  await db.initDb();
  await messaging.start('me-user');
  await flush();

  ws.handlers.frame?.({
    type: 'msg',
    from: 'real-peer',
    msgId: '01INFLIGHT',
    msgType: 'ciphertext',
    payload: 'AAAA',
    ts: 9,
  });
  await flush(); // handleIncoming is now suspended inside decryptEnvelope

  await relockThenDuressUnlock();
  const decoy = sqlite.instances.get('tacendum-decoy.sqlite')!;
  const before = mutations(decoy).length;

  releaseDecrypt('REAL SECRET PLAINTEXT');
  await flush();

  expect(mutations(decoy).slice(before)).toEqual([]);
});

test('an attachment download in flight across a relock writes nothing into the decoy world', async () => {
  crypto.decryptEnvelope.mockResolvedValue(
    JSON.stringify({ tcm: 'image', att: 'AT1', key: 'K1', w: 10, h: 10 }),
  );
  let releaseUrl!: (v: { downloadUrl: string }) => void;
  api.apiGetAttachmentUrl.mockImplementation(
    () => new Promise(resolve => (releaseUrl = resolve)),
  );
  api.downloadBlob.mockResolvedValue('Y2lwaGVy');
  crypto.blobDecrypt.mockResolvedValue('UkVBTF9JTUFHRQ==');

  await db.initDb();
  await messaging.start('me-user');
  await flush();

  ws.handlers.frame?.({
    type: 'msg',
    from: 'real-peer',
    msgId: '01PHOTO',
    msgType: 'ciphertext',
    payload: 'AAAA',
    ts: 9,
  });
  await flush(); // message persisted (real); download now awaiting the URL

  await relockThenDuressUnlock();
  const decoy = sqlite.instances.get('tacendum-decoy.sqlite')!;
  const before = mutations(decoy).length;

  releaseUrl({ downloadUrl: 'https://blob' });
  await flush();

  expect(mutations(decoy).slice(before)).toEqual([]);
});
