/**
 * SIBLING TRANSCRIPTS CARRY THE DISAPPEARING TIMER.
 *
 * A message sent from device A to a peer with a disappearing timer is written
 * on A with `expiresAt = ts + timer`; the `x.acct.sync` transcript to own
 * device B used to be materialised with NO expiry, and B's `armExpiry`
 * touches inbound rows only — so the copy on B never expired. Two halves,
 * proved here against the real messaging core with `../src/db` mocked
 * outright (the assertions are about what is enqueued and what is inserted,
 * not about SQL):
 *
 *  - the SENDER stamps the row's deadline on the transcript envelope, and
 *    hands the sibling extra the row's purge key (`ledger: false`, so it is
 *    transport, not a delivery leg — db.sibling.purge.test.ts proves the
 *    sweep reaches it through that key on the real engine);
 *  - the RECEIVING sibling stamps that deadline on the row it materialises.
 */

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

import { encodeEnvelope, parseEnvelope } from '../src/envelope';
import { messaging } from '../src/messaging';
import { session } from '../src/session';
import { buildTranscriptSync } from '../src/sync';

type Mocks = Record<string, jest.Mock>;

const db = jest.requireMock('../src/db') as Mocks;
const api = jest.requireMock('../src/api') as Mocks;
const crypto = jest.requireMock('tacendum-crypto') as Mocks & {
  __keychain: Map<string, string>;
};
const ws = (
  jest.requireMock('../src/ws') as {
    __ws: { handlers: { frame?: (f: unknown) => void }; calls: { send: jest.Mock } };
  }
).__ws;

const ME = '01HQSSSS00000000000000000S';
const MY_TABLET = '01HQTTTT00000000000000000T';
const FRIEND = '01HQAAAA00000000000000000A';
const NOW = 1_756_000_000_000;

async function flush(turns = 120): Promise<void> {
  for (let i = 0; i < turns; i++) await Promise.resolve();
}

function linkedTablet(): unknown[] {
  return [
    { userId: MY_TABLET, class: 'tablet', state: 'linked', updatedAt: NOW, certsJson: '', identityKeyPub: 'S0VZ' },
  ];
}

beforeEach(async () => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
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
    ['listLinkedDevices', []],
    ['listPeerDevices', []],
    ['getPeerDevice', null],
  ] as Array<[string, unknown]>) {
    db[name]!.mockResolvedValue(value);
  }
  for (const name of Object.keys(api)) api[name]!.mockReset();
  api.apiGetPrekeyBundle!.mockResolvedValue({});
  crypto.hasSession!.mockReset().mockResolvedValue(true);
  crypto.decryptEnvelope!.mockReset();
  crypto.encryptText!.mockReset().mockImplementation(async (_self: string, to: string, plaintext: string) => ({
    msgType: 'ciphertext',
    payload: `sealed(${to})#${encodeURIComponent(plaintext)}`,
  }));
  crypto.isIdentityChangeError!.mockReset().mockReturnValue(false);
  crypto.__keychain.clear();
  crypto.__keychain.set('authToken', 'tok');
  await messaging.start(ME);
  await flush();
  ws.calls.send.mockClear();
});

afterEach(() => {
  messaging.stop();
  session.setMode('real');
  jest.useRealTimers();
});

/** The plaintext each leg was sealed from, by address. */
function sealedFor(to: string): string {
  const call = crypto.encryptText!.mock.calls.find(c => c[1] === to);
  if (!call) throw new Error(`no leg sealed for ${to}`);
  return String(call[2]);
}

describe('the sender (device A)', () => {
  test('a chat with a timer: the row and the sibling transcript carry the same deadline, and the sibling extra rides the purge key', async () => {
    db.listLinkedDevices!.mockResolvedValue(linkedTablet());
    db.getChat!.mockResolvedValue({ peerId: FRIEND, disappearSec: 60, lastMessageAt: NOW });

    await messaging.sendText(FRIEND, 'gone in a minute');
    await flush();

    expect(db.enqueueOutgoingDeviceFanout).toHaveBeenCalledTimes(1);
    const [row, primary, extras] = db.enqueueOutgoingDeviceFanout!.mock.calls[0]! as [
      { msgId: string; expiresAt: number | null; ts: number },
      { to: string },
      Array<{ to: string; ledger?: boolean }>,
    ];
    expect(row.expiresAt).toBe(row.ts + 60_000);
    expect(primary.to).toBe(FRIEND);
    // The sibling copy is transport, not a delivery leg: `ledger: false`
    // (db.enqueueOutgoingDeviceFanout stores the purge key with ledger = 0).
    expect(extras).toEqual([expect.objectContaining({ to: MY_TABLET, ledger: false })]);

    const transcript = parseEnvelope(sealedFor(MY_TABLET));
    expect(transcript?.tcm).toBe('x.acct.sync');
    if (transcript?.tcm !== 'x.acct.sync') throw new Error('unreachable');
    expect(transcript.k).toBe('transcript');
    expect(transcript.d).toEqual({
      peerId: FRIEND,
      msgId: row.msgId,
      body: 'gone in a minute',
      ts: row.ts,
      expiresAt: row.ts + 60_000,
    });
  });

  test('a chat without a timer: no deadline on the row, and none on the transcript', async () => {
    db.listLinkedDevices!.mockResolvedValue(linkedTablet());
    db.getChat!.mockResolvedValue({ peerId: FRIEND, disappearSec: 0, lastMessageAt: NOW });

    await messaging.sendText(FRIEND, 'keeps');
    await flush();

    const [row] = db.enqueueOutgoingDeviceFanout!.mock.calls[0]! as [{ expiresAt: number | null }];
    expect(row.expiresAt).toBeNull();
    const transcript = parseEnvelope(sealedFor(MY_TABLET));
    if (transcript?.tcm !== 'x.acct.sync') throw new Error('expected a sync envelope');
    expect(transcript.d).not.toHaveProperty('expiresAt');
  });
});

describe('the receiving sibling (device B)', () => {
  function transcriptFrame(d: Parameters<typeof buildTranscriptSync>[0]): void {
    crypto.decryptEnvelope!.mockResolvedValueOnce(encodeEnvelope(buildTranscriptSync(d)));
    ws.handlers.frame?.({
      type: 'msg',
      from: MY_TABLET,
      msgId: '01HQWWWW00000000000000000W',
      msgType: 'ciphertext',
      payload: 'AAAA',
      ts: NOW,
    });
  }

  test('a transcript carrying a deadline is materialised with it, so the sweep reaches the copy', async () => {
    db.listLinkedDevices!.mockResolvedValue(linkedTablet());
    transcriptFrame({
      peerId: FRIEND,
      msgId: '01HQMMMM00000000000000000M',
      body: 'sent from my tablet',
      ts: NOW - 5_000,
      expiresAt: NOW + 55_000,
    });
    await flush();

    expect(db.insertMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        msgId: '01HQMMMM00000000000000000M',
        peerId: FRIEND,
        direction: 'out',
        body: 'sent from my tablet',
        status: 'sent',
        expiresAt: NOW + 55_000,
      }),
    );
    // Applied, seen, acked — the ordinary sync outcome.
    expect(ws.calls.send).toHaveBeenCalledWith({ type: 'ack', msgId: '01HQWWWW00000000000000000W' });
  });

  test('a transcript without one (an older sibling) is materialised as before: no expiry', async () => {
    db.listLinkedDevices!.mockResolvedValue(linkedTablet());
    transcriptFrame({
      peerId: FRIEND,
      msgId: '01HQMMMM00000000000000000N',
      body: 'plain',
      ts: NOW - 5_000,
    });
    await flush();

    expect(db.insertMessage).toHaveBeenCalledWith(
      expect.objectContaining({ msgId: '01HQMMMM00000000000000000N', expiresAt: null }),
    );
  });
});
