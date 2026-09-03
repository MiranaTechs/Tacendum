/**
 * BOOT-TIME RECONCILE READS ATTACHMENT META, NEVER THE BYTES.
 *
 * `reconcileLocalState` runs on every `start()` — every unlock — over every
 * chat, and only ever reads an attachment row's `.state` to decide whether
 * a download needs resuming. It used to call `db.listAttachments`, which
 * SELECTs `dataB64` for every attachment in the chat: with the storage
 * ceiling at 4 GiB that is every photo in every conversation materialised
 * as base64 JS strings at boot, repeated per unlock — an OOM for a large
 * history. `listAttachmentMeta` is the same rows without the bytes.
 *
 * Harness follows messaging.downloads.test.ts: `../src/db` mocked outright,
 * because the assertion is about WHICH read runs, not about SQL. */

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

import type { MessageRow } from '../src/db';
import { messaging } from '../src/messaging';
import { session } from '../src/session';

type Mocks = Record<string, jest.Mock>;

const db = jest.requireMock('../src/db') as Mocks;
const api = jest.requireMock('../src/api') as Mocks;
const crypto = jest.requireMock('tacendum-crypto') as Mocks & {
  __keychain: Map<string, string>;
};

const ME = 'me-user';
const FRIEND = '01FRIENDZ3NDEKTSV4RRFFQ69G';

async function flush(turns = 80): Promise<void> {
  for (let i = 0; i < turns; i++) await Promise.resolve();
}

function imageBody(att: string): string {
  return JSON.stringify({ tcm: 'image', att, key: 'a2V5', w: 10, h: 20 });
}

beforeEach(() => {
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
  api.apiGetAttachmentUrl!.mockResolvedValue({ downloadUrl: 'https://blobs/get' });
  api.downloadBlob!.mockResolvedValue('Y2lwaGVy');
  crypto.blobDecrypt!.mockReset().mockResolvedValue('cGxhaW4=');
  crypto.hasSession!.mockReset().mockResolvedValue(true);
  crypto.__keychain.clear();
  crypto.__keychain.set('authToken', 'tok');
});

afterEach(() => {
  messaging.stop();
  session.setMode('real');
});

test('reconcile consults attachment META at boot and never selects the bytes', async () => {
  db.listChats!.mockResolvedValue([{ peerId: FRIEND, lastMessageAt: 1 }]);
  db.listMessages!.mockResolvedValue([
    {
      msgId: '01READY',
      peerId: FRIEND,
      direction: 'in',
      body: imageBody('att-ready'),
      ts: 1,
      status: 'received',
    } satisfies MessageRow,
    {
      msgId: '01STUCK',
      peerId: FRIEND,
      direction: 'in',
      body: imageBody('att-stuck'),
      ts: 2,
      status: 'received',
    } satisfies MessageRow,
  ]);
  // The meta variant is what the decision is made from: a ready row is left
  // alone, a pending one is resumed — exactly as before, minus the bytes.
  db.listAttachmentMeta!.mockResolvedValue([
    { msgId: '01READY', direction: 'in', state: 'ready', w: 10, h: 20, b64len: 8 },
    { msgId: '01STUCK', direction: 'in', state: 'pending', w: 10, h: 20, b64len: null },
  ]);

  await messaging.start(ME);
  await flush();

  expect(db.listAttachmentMeta).toHaveBeenCalledWith(FRIEND);
  expect(db.listAttachments).not.toHaveBeenCalled();
  const fetched = api.apiGetAttachmentUrl!.mock.calls.map(c => c[1]);
  expect(fetched).toEqual(['att-stuck']);
});
