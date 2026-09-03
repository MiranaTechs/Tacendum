/**
 * The frame-verdict hook (`onFrameVerdict`).
 *
 * A VoIP push rings a CallKit placeholder BEFORE anything can decrypt (the report is a PushKit obligation), so the ring's legitimacy is only ever
 * decided by the frames that drain behind it. `messaging` knows nothing about
 * calls — deliberately — but it is the only layer that knows when a frame has
 * RESOLVED as something that can never ring: garbage ciphertext, or a payload
 * that decrypted fine and is not call signalling. This hook states that fact
 * to whoever subscribed (the call controller), exactly as `onEnvelope` states
 * the call-signalling fact, and states nothing else.
 *
 * The property under test is precision: every terminal non-call resolution
 * emits exactly one verdict, and NO call-signalling frame ever emits one —
 * a verdict for the pending caller is what ends their placeholder, so a
 * false positive here is a dropped ring.
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
  // Device-set defaults: the reads every send
  // and receive now consults — an EMPTY world here, so suites predating
  // multi-device keep exercising the single-leg wire byte-for-byte. A suite
  // that defines its own version below wins (later keys override).
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
const crypto = jest.requireMock('tacendum-crypto') as Mocks & {
  __keychain: Map<string, string>;
};
const ws = (
  jest.requireMock('../src/ws') as {
    __ws: {
      handlers: { frame?: (f: unknown) => void };
      calls: { send: jest.Mock };
    };
  }
).__ws;

const ME = 'me-user';
const PEER = '01PEERZ3NDEKTSV4RRFFQ69G5F';
const CID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const SID = '01SESSN00000000000000000ZA';

async function flush(turns = 60): Promise<void> {
  for (let i = 0; i < turns; i++) await Promise.resolve();
}

let msgSeq = 0;
async function deliver(body: string, from = PEER): Promise<void> {
  crypto.decryptEnvelope!.mockResolvedValueOnce(body);
  ws.handlers.frame?.({
    type: 'msg',
    from,
    msgId: `01VERDICT${String(msgSeq++).padStart(4, '0')}`,
    msgType: 'ciphertext',
    payload: 'AAAA',
    ts: 1_700_000_000_000,
  });
  await flush();
}

async function deliverUndecryptable(err: Error, from = PEER): Promise<void> {
  crypto.decryptEnvelope!.mockRejectedValueOnce(err);
  ws.handlers.frame?.({
    type: 'msg',
    from,
    msgId: `01VERDICT${String(msgSeq++).padStart(4, '0')}`,
    msgType: 'ciphertext',
    payload: 'AAAA',
    ts: 1_700_000_000_000,
  });
  await flush();
}

function resetDb(): void {
  const reads: Array<[string, unknown]> = [
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
    ['loadProfile', null],
    ['chatsMissingMyProfile', []],
    ['peerHasMyProfile', false],
  ];
  for (const [name, value] of reads) {
    db[name]!.mockReset();
    db[name]!.mockResolvedValue(value);
  }
  for (const name of Object.keys(db)) {
    if (!reads.some(([n]) => n === name)) {
      db[name]!.mockReset();
      db[name]!.mockResolvedValue(undefined);
    }
  }
  db.applyEdit!.mockResolvedValue(true);
  db.tombstoneMessage!.mockResolvedValue(true);
}

const verdicts: Array<{ peerId: string; verdict: string }> = [];
let unsubscribe: (() => void) | null = null;

beforeEach(async () => {
  messaging.stop();
  session.setMode('real');
  resetDb();
  verdicts.length = 0;
  crypto.decryptEnvelope!.mockReset();
  crypto.encryptText!.mockReset().mockResolvedValue({
    msgType: 'ciphertext',
    payload: 'Q0lQSEVS',
  });
  crypto.hasSession!.mockReset().mockResolvedValue(true);
  crypto.isIdentityChangeError!.mockReset().mockReturnValue(false);
  crypto.__keychain.clear();
  crypto.__keychain.set('authToken', 'tok');
  await messaging.start(ME);
  await flush();
  unsubscribe = messaging.onFrameVerdict((peerId, verdict) => {
    verdicts.push({ peerId, verdict });
  });
});

afterEach(() => {
  unsubscribe?.();
  unsubscribe = null;
  messaging.stop();
  session.setMode('real');
});

describe('terminal non-call resolutions emit a verdict', () => {
  test('a decrypted PLAIN TEXT message — the cheapest fake-urgent payload', async () => {
    await deliver('hello there');
    expect(verdicts).toEqual([{ peerId: PEER, verdict: 'not_call' }]);
  });

  test('a decrypted carrier (profile card) — urgent is a client-set bit on ANY frame', async () => {
    await deliver(
      JSON.stringify({ tcm: 'profile', n: 'Mallory', a: '', v: 1_700_000_000_000 }),
    );
    expect(verdicts).toEqual([{ peerId: PEER, verdict: 'not_call' }]);
  });

  test('GARBAGE CIPHERTEXT — decrypt fails, the tamper branch resolves it', async () => {
    await deliverUndecryptable(new Error('decrypt failed'));
    expect(verdicts).toEqual([{ peerId: PEER, verdict: 'undecryptable' }]);
  });

  test('an IDENTITY-CHANGE decrypt failure — the offer behind it could never decrypt either', async () => {
    crypto.isIdentityChangeError!.mockReturnValueOnce(true);
    await deliverUndecryptable(new Error('identity changed'));
    expect(verdicts).toEqual([{ peerId: PEER, verdict: 'undecryptable' }]);
  });

  test('a MALFORMED call.g* frame — call-shaped, but nothing this build can ring', async () => {
    await deliver(JSON.stringify({ tcm: 'call.gjoin', sid: 'not-a-ulid', m: 1 }));
    expect(verdicts).toEqual([{ peerId: PEER, verdict: 'not_call' }]);
  });

  test('a BLOCKED sender’s decrypted frame — dropped, and its ring must drop with it', async () => {
    // The native mirror usually ends a blocked caller's push at report time
    // (CallKitCenter), but the mirror is unreadable before first unlock —
    // this verdict is the JS belt to that Swift braces.
    await messaging.blockPeer(PEER);
    await deliver('anything at all');
    expect(verdicts).toEqual([{ peerId: PEER, verdict: 'not_call' }]);
  });
});

describe('call signalling NEVER emits a verdict — a false positive is a dropped ring', () => {
  test('a valid call.offer', async () => {
    await deliver(
      JSON.stringify({
        tcm: 'call.offer',
        cid: CID,
        sdp: 'v=0\r\na=fingerprint:sha-256 AA',
        vid: false,
        exp: 4_000_000_000_000,
      }),
    );
    expect(verdicts).toEqual([]);
  });

  test('a valid call.end — the cancel is urgent too, and it dismisses its own way', async () => {
    await deliver(JSON.stringify({ tcm: 'call.end', cid: CID, r: 'hangup' }));
    expect(verdicts).toEqual([]);
  });

  test('a valid small-group invite', async () => {
    await deliver(
      JSON.stringify({
        tcm: 'call.ginvite',
        sid: SID,
        cid: CID,
        r: [PEER, '01MEZ3NDEKTSV4RRFFQ69G5FAV'],
        sdp: 'v=0\r\na=fingerprint:sha-256 AA',
        vid: false,
        exp: 4_000_000_000_000,
      }),
    );
    expect(verdicts).toEqual([]);
  });
});

describe('a REDELIVERED already-seen frame is TERMINAL for the ring', () => {
  // The msgId was fully processed once, so THIS delivery can never produce
  // call signalling — its ciphertext will not be re-decrypted (the ratchet
  // key is spent) and no envelope will be emitted for it. A VoIP push whose
  // drain carries only an already-seen msgId (trivially replayable: `urgent`
  // is a client-set bit and the server redelivers by msgId) used to get
  // NOTHING here, and the placeholder rang to the native 75-second watchdog.
  // Saying nothing IS a change when a ring is waiting on the answer.
  test('re-acks, re-processes nothing — and still emits the verdict', async () => {
    ws.calls.send.mockClear();
    db.hasSeen!.mockResolvedValue(true);
    await deliver('hello again');
    // The verdict the ring was waiting on: terminal, and honestly non-call
    // FOR THIS DELIVERY — same family as the blocked drop and the malformed
    // call.g* frame, which may also have been "a call" in some other sense
    // but can never ring from here.
    expect(verdicts).toEqual([{ peerId: PEER, verdict: 'not_call' }]);
    // Idempotence holds exactly as before: the ack goes again, nothing is
    // re-decrypted, no ratchet advance, no row, no re-mark.
    const acks = ws.calls.send.mock.calls.filter(
      ([f]) => (f as { type?: string }).type === 'ack',
    );
    expect(acks).toHaveLength(1);
    expect(crypto.decryptEnvelope).not.toHaveBeenCalled();
    expect(db.insertMessage).not.toHaveBeenCalled();
    expect(db.markSeen).not.toHaveBeenCalled();
    expect(db.upsertChat).not.toHaveBeenCalled();
  });

  test('the verdict is per-delivery: a second replay says it again', async () => {
    // Each replayed copy may be draining behind its own fresh push, and a
    // fresh push is a fresh placeholder — the fact must be restated for it.
    // (The controller's own `ringProofFuses.has` gate dedupes arming.)
    db.hasSeen!.mockResolvedValue(true);
    await deliver('hello again');
    await deliver('hello again');
    expect(verdicts).toEqual([
      { peerId: PEER, verdict: 'not_call' },
      { peerId: PEER, verdict: 'not_call' },
    ]);
  });
});
