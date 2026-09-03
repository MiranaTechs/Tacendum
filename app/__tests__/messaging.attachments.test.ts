/**
 * WHAT A TIMED-OUT TRANSFER DOES TO THE SERVICE.
 *
 * The deadlines themselves are proved in api.timeout.test.ts; this file
 * pins what messaging does when one fires — its two consequences:
 *
 *  - a download that times out lands its row on 'failed' (visible, "tap to
 *    retry") and RELEASES its slot, so the next photo is not stuck behind a
 *    dead transfer for the rest of the session;
 *  - a first message whose prekey fetch times out REJECTS the send instead
 *    of hanging the composer with neither success nor error, and leaves no
 *    half-written row behind.
 *
 * Harness follows messaging.downloads.test.ts (db and api mocked outright:
 * the assertions are about calls and states, not SQL). */

jest.mock('../src/ws', () => {
  const handlers: { frame?: (f: unknown) => void; state?: (s: string) => void } = {};
  const calls = { start: jest.fn(), stop: jest.fn(), send: jest.fn((_frame: unknown) => true) };
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
      return true;
    }
  }
  return { WsClient, __ws: { handlers, calls } };
});

jest.mock('../src/api', () => ({
  apiUploadKeys: jest.fn(),
  apiGetPrekeyBundle: jest.fn().mockResolvedValue({}),
  apiCreateAttachment: jest.fn(),
  apiGetAttachmentUrl: jest.fn(),
  uploadBlob: jest.fn(),
  downloadBlob: jest.fn(),
}));

jest.mock('../src/decoy', () => ({
  syncDecoyProfile: jest.fn(async () => undefined),
}));

jest.mock('../src/db', () => ({
  listLinkedDevices: jest.fn(async () => []),
  listPeerDevices: jest.fn(async () => []),
  getPeerDevice: jest.fn(async () => null),
  upsertPeerDevice: jest.fn(async () => undefined),
  markChatOpened: jest.fn(async () => undefined),
  setLocalName: jest.fn(async () => undefined),
  replaceSiblingMachinePeers: jest.fn(async () => undefined),
  getChat: jest.fn(),
  getGroup: jest.fn(),
  hasSeen: jest.fn(),
  getMessage: jest.fn(),
  listOutbox: jest.fn(),
  listChats: jest.fn(),
  listMessages: jest.fn(),
  listAttachments: jest.fn(),
  listAttachmentMeta: jest.fn(),
  listRecentMessages: jest.fn(),
  listHeldRevisions: jest.fn(),
  takeHeldRevision: jest.fn(),
  listIdentityChanged: jest.fn(),
  listBlockedPeers: jest.fn(),
  getBlockedAt: jest.fn(),
  getBlockedMirrorDirty: jest.fn(),
  loadProfile: jest.fn(),
  chatsMissingMyProfile: jest.fn(),
  peerHasMyProfile: jest.fn(),
  insertMessage: jest.fn(),
  enqueueOutgoing: jest.fn(),
  enqueueOutgoingDeviceFanout: jest.fn(),
  touchChat: jest.fn(),
  upsertChat: jest.fn(),
  setChatPreview: jest.fn(),
  markSeen: jest.fn(),
  applyReceipt: jest.fn(),
  bumpOutboxAttempt: jest.fn(),
  deleteOutboxEnvelope: jest.fn(),
  markOutgoingError: jest.fn(),
  putAttachment: jest.fn(),
  sumAttachmentBytes: jest.fn(),
  sumAvatarBytes: jest.fn(),
  setReaction: jest.fn(),
  applyEdit: jest.fn(),
  tombstoneMessage: jest.fn(),
  holdRevision: jest.fn(),
  dropHeldRevision: jest.fn(),
  applyPeerProfile: jest.fn(),
  setPeerAvatar: jest.fn(),
  markMyProfileSent: jest.fn(),
  saveMyProfileCard: jest.fn(),
  setIdentityChanged: jest.fn(),
  setSafetyChecked: jest.fn(),
  setSafetyMismatch: jest.fn(),
  blockPeer: jest.fn(),
  unblockPeer: jest.fn(),
}));

import { messaging } from '../src/messaging';
import { session } from '../src/session';

type Mocks = Record<string, jest.Mock>;

const db = jest.requireMock('../src/db') as Mocks;
const api = jest.requireMock('../src/api') as Mocks;
const crypto = jest.requireMock('tacendum-crypto') as Mocks & {
  __keychain: Map<string, string>;
};
const ws = (
  jest.requireMock('../src/ws') as {
    __ws: { handlers: { frame?: (f: unknown) => void } };
  }
).__ws;

const ME = 'me-user';
const FRIEND = '01FRIENDZ3NDEKTSV4RRFFQ69G';

/** The shape `api.ts` throws at a deadline; only the name is load-bearing. */
function timedOut(): Error {
  return Object.assign(new Error('request timed out after 20000 ms'), {
    name: 'ApiTimeoutError',
  });
}

async function flush(turns = 80): Promise<void> {
  for (let i = 0; i < turns; i++) await Promise.resolve();
}

function imageBody(att: string): string {
  return JSON.stringify({ tcm: 'image', att, key: 'a2V5', w: 10, h: 20 });
}

function msgIdFor(i: number): string {
  return `01T0MSG${String(i).padStart(5, '0')}`;
}

async function deliverImage(i: number): Promise<void> {
  crypto.decryptEnvelope!.mockResolvedValueOnce(imageBody(`att-${i}`));
  ws.handlers.frame?.({
    type: 'msg',
    from: FRIEND,
    msgId: msgIdFor(i),
    msgType: 'ciphertext',
    payload: 'AAAA',
    ts: 1_700_000_000_000,
  });
  await flush();
}

function attachmentStates(msgId: string): string[] {
  return db
    .putAttachment!.mock.calls.filter(c => c[0] === msgId)
    .map(c => String(c[2]));
}

beforeEach(async () => {
  messaging.stop();
  session.setMode('real');
  for (const name of Object.keys(db)) {
    db[name]!.mockReset();
    db[name]!.mockResolvedValue(undefined);
  }
  for (const [name, value] of [
    ['getChat', undefined],
    ['getGroup', null],
    ['hasSeen', false],
    ['getMessage', null],
    ['listOutbox', []],
    ['listChats', []],
    ['listMessages', []],
    ['listAttachments', []],
    ['listAttachmentMeta', []],
    ['listRecentMessages', []],
    ['listHeldRevisions', []],
    ['takeHeldRevision', null],
    ['listIdentityChanged', []],
    ['listBlockedPeers', []],
    ['getBlockedAt', null],
    ['getBlockedMirrorDirty', false],
    ['loadProfile', null],
    ['chatsMissingMyProfile', []],
    ['peerHasMyProfile', false],
  ] as Array<[string, unknown]>) {
    db[name]!.mockResolvedValue(value);
  }
  for (const name of Object.keys(api)) api[name]!.mockReset();
  api.apiGetPrekeyBundle!.mockResolvedValue({});
  api.apiGetAttachmentUrl!.mockResolvedValue({ downloadUrl: 'https://blobs/get' });
  api.downloadBlob!.mockResolvedValue('Y2lwaGVy');
  crypto.decryptEnvelope!.mockReset();
  crypto.encryptText!.mockReset().mockResolvedValue({ msgType: 'ciphertext', payload: 'Q0lQSEVS' });
  crypto.hasSession!.mockReset().mockResolvedValue(true);
  crypto.blobDecrypt!.mockReset().mockResolvedValue('cGxhaW4=');
  crypto.isIdentityChangeError!.mockReset().mockReturnValue(false);
  crypto.__keychain.clear();
  crypto.__keychain.set('authToken', 'tok');
  await messaging.start(ME);
  await flush();
  db.putAttachment!.mockClear();
  api.downloadBlob!.mockClear();
});

afterEach(() => {
  messaging.stop();
  session.setMode('real');
});

test('two downloads that time out land failed and free both slots for the next photo', async () => {
  // MAX_CONCURRENT_DOWNLOADS is 2: before the deadline existed, two stalled
  // transfers held both slots for the rest of the session and every later
  // photo sat 'pending' behind them. Now they end, visibly, and the third
  // photo goes through.
  api.downloadBlob!
    .mockRejectedValueOnce(timedOut())
    .mockRejectedValueOnce(timedOut())
    .mockResolvedValueOnce('Y2lwaGVy');

  await deliverImage(1);
  await deliverImage(2);
  await deliverImage(3);

  expect(attachmentStates(msgIdFor(1))).toContain('failed');
  expect(attachmentStates(msgIdFor(2))).toContain('failed');
  expect(attachmentStates(msgIdFor(3))).toContain('ready');
  expect(api.downloadBlob).toHaveBeenCalledTimes(3);
});

test('a first message whose prekey fetch times out rejects the send and writes no row', async () => {
  crypto.hasSession!.mockResolvedValue(false);
  api.apiGetPrekeyBundle!.mockRejectedValue(timedOut());

  await expect(messaging.sendText(FRIEND, 'hello?')).rejects.toMatchObject({
    name: 'ApiTimeoutError',
  });
  expect(db.enqueueOutgoing).not.toHaveBeenCalled();
  expect(db.enqueueOutgoingDeviceFanout).not.toHaveBeenCalled();
  expect(db.insertMessage).not.toHaveBeenCalled();
});
