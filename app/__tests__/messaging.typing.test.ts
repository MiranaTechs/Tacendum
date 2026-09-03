jest.mock('../src/ws', () => {
  const handlers: {
    frame?: (f: unknown) => void;
    state?: (s: string) => void;
  } = {};
  const state = { open: true };
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
      return state.open;
    }
  }
  return { WsClient, __ws: { handlers, calls, state } };
});

jest.mock('../src/api', () => ({
  apiUploadKeys: jest.fn(),
  apiGetPrekeyBundle: jest.fn().mockResolvedValue({}),
  apiCreateAttachment: jest.fn(),
  apiGetAttachmentUrl: jest.fn(),
  uploadBlob: jest.fn(),
  downloadBlob: jest.fn(),
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
  unreadInboundIds: jest.fn(),
  markReadSent: jest.fn(),
  getGroup: jest.fn(),
  listGroupMemberSlots: jest.fn(),
  // The room audience seam roomContentAudience reads:
  // typing now passes through it so agents are dropped.
  listMachinePeers: jest.fn(),
  listRoomAgentAuthorIds: jest.fn(),
}));

import type { TypingEnvelope } from '../src/envelope';
import { messaging } from '../src/messaging';
import { session } from '../src/session';
import { setTypingIndicators } from '../src/typingIndicators';

type Mocks = Record<string, jest.Mock>;

const db = jest.requireMock('../src/db') as Mocks;
const api = jest.requireMock('../src/api') as Mocks;
const crypto = jest.requireMock('tacendum-crypto') as Mocks & {
  __keychain: Map<string, string>;
};
const ws = (
  jest.requireMock('../src/ws') as {
    __ws: {
      handlers: { frame?: (f: unknown) => void; state?: (s: string) => void };
      calls: { start: jest.Mock; stop: jest.Mock; send: jest.Mock };
      state: { open: boolean };
    };
  }
).__ws;

const ME = 'me-user';
const FRIEND = '01FRIENDZ3NDEKTSV4RRFFQ69G';

async function settle(turns = 60): Promise<void> {
  for (let i = 0; i < turns; i++) await Promise.resolve();
}

beforeEach(async () => {
  messaging.stop();
  session.setMode('real');
  for (const name of Object.keys(db)) {
    db[name]!.mockReset();
    db[name]!.mockResolvedValue(undefined);
  }
  db.listOutbox!.mockResolvedValue([]);
  db.listChats!.mockResolvedValue([]);
  db.listMessages!.mockResolvedValue([]);
  db.listAttachments!.mockResolvedValue([]);
  db.listAttachmentMeta!.mockResolvedValue([]);
  db.listRecentMessages!.mockResolvedValue([]);
  db.listHeldRevisions!.mockResolvedValue([]);
  db.listIdentityChanged!.mockResolvedValue([]);
  db.listBlockedPeers!.mockResolvedValue([]);
  // Device-set reads: an EMPTY world, so the
  // single-leg wire this suite pins stays byte-for-byte what it was.
  db.listPeerDevices!.mockResolvedValue([]);
  db.listLinkedDevices!.mockResolvedValue([]);
  db.getPeerDevice!.mockResolvedValue(null);
  db.chatsMissingMyProfile!.mockResolvedValue([]);
  db.hasSeen!.mockResolvedValue(false);
  db.getMessage!.mockResolvedValue(null);
  db.listMachinePeers!.mockResolvedValue([]);
  db.listRoomAgentAuthorIds!.mockResolvedValue([]);
  db.loadProfile!.mockResolvedValue(null);
  db.peerHasMyProfile!.mockResolvedValue(true);
  // The room anchor's DEFINITE "not a room" — `undefined` (the loop's
  // default above) reads as "unknown", which the receipt seam treats as a
  // room and suppresses.
  db.getGroup!.mockResolvedValue(null);

  ws.state.open = true;
  ws.calls.send.mockReset().mockImplementation(() => true);
  for (const name of Object.keys(api)) api[name]!.mockReset();
  api.apiGetPrekeyBundle!.mockResolvedValue({});
  crypto.encryptText!.mockReset().mockResolvedValue({
    msgType: 'ciphertext',
    payload: 'Q0lQSEVS',
  });
  crypto.processPreKeyBundle!.mockReset().mockResolvedValue(undefined);
  crypto.hasSession!.mockReset().mockResolvedValue(true);
  crypto.isIdentityChangeError!.mockReset().mockReturnValue(false);
  crypto.__keychain.clear();
  crypto.__keychain.set('authToken', 'tok');

  await messaging.start(ME);
  await settle();
  ws.calls.send.mockClear();
});

afterEach(() => {
  messaging.stop();
  session.setMode('real');
});

const TYPING_BODY = '{"tcm":"x.typing","state":"start"}';

function injectTypingFrame(over: Record<string, unknown> = {}): void {
  ws.handlers.frame?.({
    type: 'typing',
    from: FRIEND,
    msgType: 'ciphertext',
    payload: 'Q0lQSEVS',
    ts: 5,
    ...over,
  });
}

describe('typing receive path', () => {
  test('a relayed typing frame decrypts, parses, and reaches onTyping — and touches NOTHING durable', async () => {
    crypto.decryptEnvelope!.mockResolvedValue(TYPING_BODY);
    const events: Array<{ peerId: string; envelope: TypingEnvelope; ts: number }> = [];
    const off = messaging.onTyping((peerId, envelope, ts) => {
      events.push({ peerId, envelope, ts });
    });

    injectTypingFrame();
    await settle();
    off();

    expect(events).toEqual([
      { peerId: FRIEND, envelope: { tcm: 'x.typing', state: 'start' }, ts: 5 },
    ]);
    expect(db.insertMessage!).not.toHaveBeenCalled();
    expect(db.enqueueOutgoing!).not.toHaveBeenCalled();
    expect(db.markSeen!).not.toHaveBeenCalled();
    expect(db.touchChat!).not.toHaveBeenCalled();
    expect(db.setChatPreview!).not.toHaveBeenCalled();
    // No ack — there is no msgId to ack.
    expect(
      ws.calls.send.mock.calls.filter(c => (c[0] as { type?: string }).type === 'ack'),
    ).toHaveLength(0);
  });

  test('unsubscribe works', async () => {
    crypto.decryptEnvelope!.mockResolvedValue(TYPING_BODY);
    const listener = jest.fn();
    messaging.onTyping(listener)();

    injectTypingFrame();
    await settle();

    expect(listener).not.toHaveBeenCalled();
  });

  test('a blocked sender is decrypted (ratchet health) but never emitted', async () => {
    messaging.stop();
    db.listBlockedPeers!.mockResolvedValue([FRIEND]);
    await messaging.start(ME);
    await settle();
    crypto.decryptEnvelope!.mockResolvedValue(TYPING_BODY);
    const listener = jest.fn();
    messaging.onTyping(listener);

    injectTypingFrame();
    await settle();

    expect(crypto.decryptEnvelope!).toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
  });

  test('duress emits nothing', async () => {
    crypto.decryptEnvelope!.mockResolvedValue(TYPING_BODY);
    const listener = jest.fn();
    messaging.onTyping(listener);
    session.setMode('duress');

    injectTypingFrame();
    await settle();

    expect(listener).not.toHaveBeenCalled();
  });

  test('a non-typing envelope inside a typing frame is dropped', async () => {
    crypto.decryptEnvelope!.mockResolvedValue(
      '{"tcm":"read","ids":["01ARZ3NDEKTSV4RRFFQ69G5FAV"]}',
    );
    const listener = jest.fn();
    messaging.onTyping(listener);

    injectTypingFrame();
    await settle();

    expect(listener).not.toHaveBeenCalled();
  });

  test('a failed decrypt is swallowed', async () => {
    crypto.decryptEnvelope!.mockRejectedValue(new Error('tamper'));
    const listener = jest.fn();
    messaging.onTyping(listener);

    injectTypingFrame();
    await settle();

    expect(listener).not.toHaveBeenCalled();
  });

  test('x.typing arriving as a durable msg frame is acked and dropped whole — no row, no emit', async () => {
    crypto.decryptEnvelope!.mockResolvedValue(TYPING_BODY);
    const listener = jest.fn();
    messaging.onTyping(listener);

    ws.handlers.frame?.({
      type: 'msg',
      from: FRIEND,
      msgId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      msgType: 'ciphertext',
      payload: 'Q0lQSEVS',
      ts: 5,
    });
    await settle();

    expect(db.markSeen!).toHaveBeenCalled();
    expect(
      ws.calls.send.mock.calls.filter(c => (c[0] as { type?: string }).type === 'ack'),
    ).toHaveLength(1);
    expect(db.insertMessage!).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
  });
});

function typingFramesSent(): Array<Record<string, unknown>> {
  return ws.calls.send.mock.calls
    .map(c => c[0] as Record<string, unknown>)
    .filter(f => f.type === 'typing');
}

describe('typing send path — 1:1', () => {
  beforeEach(async () => {
    await setTypingIndicators(true);
    ws.calls.send.mockClear();
  });

  test('seals {"tcm":"x.typing","state":"start"} and sends a typing frame with no msgId', async () => {
    await messaging.sendTypingState(FRIEND, 'start');

    expect(crypto.encryptText!).toHaveBeenCalledWith(
      ME,
      FRIEND,
      '{"tcm":"x.typing","state":"start"}',
    );
    const frames = typingFramesSent();
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual({
      type: 'typing',
      to: FRIEND,
      msgType: 'ciphertext',
      payload: 'Q0lQSEVS',
    });
    expect(db.enqueueOutgoing!).not.toHaveBeenCalled();
  });

  test('gate: toggle off sends nothing', async () => {
    await setTypingIndicators(false);
    await messaging.sendTypingState(FRIEND, 'start');
    expect(crypto.encryptText!).not.toHaveBeenCalled();
    expect(typingFramesSent()).toHaveLength(0);
  });

  test('gate: duress sends nothing', async () => {
    session.setMode('duress');
    await messaging.sendTypingState(FRIEND, 'start');
    expect(typingFramesSent()).toHaveLength(0);
  });

  test('gate: a blocked peer gets no liveness beacon', async () => {
    messaging.stop();
    db.listBlockedPeers!.mockResolvedValue([FRIEND]);
    await messaging.start(ME);
    await settle();
    ws.calls.send.mockClear();

    await messaging.sendTypingState(FRIEND, 'start');

    expect(crypto.encryptText!).not.toHaveBeenCalled();
    expect(typingFramesSent()).toHaveLength(0);
  });

  test('gate: no session means no send AND no prekey fetch — typing never bootstraps X3DH', async () => {
    crypto.hasSession!.mockResolvedValue(false);
    await messaging.sendTypingState(FRIEND, 'start');
    expect(api.apiGetPrekeyBundle!).not.toHaveBeenCalled();
    expect(typingFramesSent()).toHaveLength(0);
  });

  test('gate: a closed socket drops rather than queues', async () => {
    ws.state.open = false;
    await messaging.sendTypingState(FRIEND, 'start');
    expect(typingFramesSent()).toHaveLength(0);
    expect(db.enqueueOutgoing!).not.toHaveBeenCalled();
    ws.state.open = true;
  });

  test('the pacer drops the 13th rapid signal (capacity 12), never queues it', async () => {
    // Real clock: 13 microtask-paced sends complete in well under the ~833 ms
    // one refill token costs, so exactly 12 must land.
    for (let i = 0; i < 13; i++) {
      await messaging.sendTypingState(FRIEND, 'start');
    }
    expect(typingFramesSent()).toHaveLength(12);
    expect(db.enqueueOutgoing!).not.toHaveBeenCalled();
  });

  test('a ratchet refusal is swallowed', async () => {
    crypto.encryptText!.mockRejectedValue(new Error('ratchet refused'));
    await expect(messaging.sendTypingState(FRIEND, 'start')).resolves.toBeUndefined();
    expect(typingFramesSent()).toHaveLength(0);
  });
});

describe('typing send path — rooms', () => {
  const ROOM = '01R00MZ3NDEKTSV4RRFFQ69G5F';
  const BEN = '01BENZZ3NDEKTSV4RRFFQ69G5F';
  const CARA = '01CARAZ3NDEKTSV4RRFFQ69G5F';

  beforeEach(async () => {
    await setTypingIndicators(true);
    db.getGroup!.mockImplementation(async (id: string) =>
      id === ROOM ? { groupId: ROOM, ownerId: ME, name: 'Kitchen' } : null,
    );
    db.listGroupMemberSlots!.mockResolvedValue([
      { memberId: ME, writerId: ME, seq: 1, state: 'in' },
      { memberId: BEN, writerId: ME, seq: 2, state: 'in' },
      { memberId: CARA, writerId: ME, seq: 3, state: 'in' },
    ]);
    ws.calls.send.mockClear();
  });

  test('fans one sealed frame to every member but me, with the room inside the ciphertext', async () => {
    await messaging.sendRoomTypingState(ROOM, 'start');

    const frames = typingFramesSent();
    expect(frames.map(f => f.to).sort()).toEqual([BEN, CARA].sort());
    // Every leg sealed the SAME room-scoped body, per member.
    const bodies = crypto.encryptText!.mock.calls.map(c => c[2] as string);
    expect(bodies).toHaveLength(2);
    for (const body of bodies) {
      expect(JSON.parse(body)).toEqual({ tcm: 'x.typing', state: 'start', room: ROOM });
    }
    expect(db.enqueueOutgoing!).not.toHaveBeenCalled();
  });

  test('an unknown room sends nothing and swallows the refusal', async () => {
    await expect(
      messaging.sendRoomTypingState('01N0R00MNDEKTSV4RRFFQ69G5F', 'start'),
    ).resolves.toBeUndefined();
    expect(typingFramesSent()).toHaveLength(0);
  });

  test('a member without a session is skipped; the rest still get legs', async () => {
    crypto.hasSession!.mockImplementation(async (peer: string) => peer !== BEN);

    await messaging.sendRoomTypingState(ROOM, 'start');

    expect(typingFramesSent().map(f => f.to)).toEqual([CARA]);
    expect(api.apiGetPrekeyBundle!).not.toHaveBeenCalled();
  });

  test('gate: toggle off fans nothing', async () => {
    await setTypingIndicators(false);
    await messaging.sendRoomTypingState(ROOM, 'start');
    expect(typingFramesSent()).toHaveLength(0);
  });

  test('an AGENT member gets NO typing frame — a typing signal addresses no one, so the content audience drops it; the human still gets one', async () => {
    // Claim-hygiene: typing carries no `who` and no ref,
    // so it reaches every human but no agent — the same seam content legs pass
    // through. Reddens the moment sendRoomTypingState stops filtering.
    db.listMachinePeers!.mockResolvedValue([CARA]); // CARA is the owner's agent
    await messaging.sendRoomTypingState(ROOM, 'start');

    const to = typingFramesSent().map(f => f.to);
    expect(to).toContain(BEN); // the human
    expect(to).not.toContain(CARA); // the agent, dropped
  });
});
