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
}));

import type { OutboxRow } from '../src/db';
import { messaging } from '../src/messaging';
import { session } from '../src/session';

/**
 * What the flush actually puts on the wire.
 *
 * The server decides whether to ring a phone, banner it, or stay silent from
 * two optional bits on the send frame, and BOTH of them were missing from the
 * frame this function builds.
 *
 * `urgent` was written to the outbox in V1 with a comment saying the transport
 * would read it in V2. V2 never added it here, so the server saw
 * `urgent === undefined` on every frame this app had ever sent — call offers
 * included. Nothing noticed, because the push schedulers were independently
 * dropping `kind`, which pushed everything down the VoIP branch by accident
 * and made calls ring anyway. Fixing the schedulers without this would have
 * turned every call into a "New message" banner.
 *
 * `notify` is the new one, and its absence is what makes a read receipt
 * announce itself as new mail to the person whose message was read.
 *
 * Every test above this one asserts on the outbox ROW. This is the only place
 * that asserts on the FRAME, which is where both bugs lived.
 */

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
const ROW = '01WIREROWZ3NDEKTSV4RRFFQ69';

async function settle(turns = 60): Promise<void> {
  for (let i = 0; i < turns; i++) await Promise.resolve();
}

function row(over: Partial<OutboxRow> = {}): OutboxRow {
  return {
    msgId: ROW,
    peerId: FRIEND,
    msgType: 'ciphertext',
    payload: 'Q0lQSEVS',
    attempts: 0,
    priority: 0,
    urgent: 0,
    notify: 1,
    ...over,
  };
}

function sentFrame(): Record<string, unknown> | undefined {
  return ws.calls.send.mock.calls
    .map(c => c[0] as Record<string, unknown>)
    .find(f => f.type === 'send' && f.msgId === ROW);
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

/** Serve one outbox row, then drive a flush with unrelated traffic. */
async function flushRow(over: Partial<OutboxRow>): Promise<void> {
  db.listOutbox!.mockResolvedValue([row(over)]);
  await messaging.sendText(FRIEND, 'kick the flush');
  await settle();
}

/** The envelope options `encryptAndEnqueue` handed to the outbox. */
function enqueuedEnvelope(): Record<string, unknown> | undefined {
  const call = db.enqueueOutgoing!.mock.calls.at(-1);
  return call?.[1] as Record<string, unknown> | undefined;
}

describe('who decides a frame is a carrier', () => {
  // DERIVED at the one choke point every send passes through, not passed in by
  // callers. A flag that six call sites have to remember is a flag one of them
  // eventually forgets — which is exactly how the push registration shipped
  // without its `bundleId`. These pin the derivation itself; the frame tests
  // below inject a row and so cannot see it.

  it('an ordinary text notifies', async () => {
    await messaging.sendText(FRIEND, 'hello');
    await settle();

    expect(enqueuedEnvelope()?.notify).toBe(true);
  });

  it('a read receipt does NOT', async () => {
    // The case that inverts the feature: without this, reading someone's
    // message tells THEM they have a new one.
    db.unreadInboundIds!.mockResolvedValue(['01INBOUNDZ3NDEKTSV4RRFFQ69']);

    await messaging.sendReadReceipt(FRIEND);
    await settle();

    expect(enqueuedEnvelope()?.notify).toBe(false);
  });

  it('call signalling does NOT — it rings, it does not banner', async () => {
    await messaging.sendCallEnvelope(
      FRIEND,
      {
        tcm: 'call.offer',
        cid: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
        sdp: 'v=0',
        vid: false,
        exp: 2_000_000_000_000,
      },
      { urgent: true },
    );
    await settle();

    const env = enqueuedEnvelope();
    expect(env?.notify).toBe(false);
    expect(env?.urgent).toBe(true);
  });
});

describe('the send frame', () => {
  it('carries urgent:true for a ring', async () => {
    // The bit that was persisted for a whole phase and never sent. Without it
    // the server classifies a call offer as an ordinary message and banners
    // instead of ringing.
    await flushRow({ urgent: 1, notify: 0 });

    expect(sentFrame()?.urgent).toBe(true);
  });

  it('carries notify:false for a carrier', async () => {
    await flushRow({ urgent: 0, notify: 0 });

    expect(sentFrame()?.notify).toBe(false);
  });

  it('OMITS both for an ordinary message rather than sending false', async () => {
    // Absence is the safe default for each — no ring, and do notify — so an
    // ordinary message says nothing and gets both. Sending `urgent: false`
    // and `notify: true` explicitly would work, but it puts two bits on every
    // frame that the server would read identically to their absence.
    await flushRow({ urgent: 0, notify: 1 });

    const frame = sentFrame();
    expect(frame).toBeDefined();
    expect('urgent' in frame!).toBe(false);
    expect('notify' in frame!).toBe(false);
  });

  it('keeps the two independent — a call offer is urgent AND silent', async () => {
    await flushRow({ urgent: 1, notify: 0 });

    const frame = sentFrame();
    expect(frame?.urgent).toBe(true);
    expect(frame?.notify).toBe(false);
  });
});

describe('rooms send no read receipts', () => {
  // The one test in the suite where the outbox is REAL plumbing rather than
  // an injected row: enqueueOutgoing feeds listOutbox, so what ws.send sees
  // is exactly what the receipt path committed. The zero below is therefore
  // a transport fact, not an inference from a mock that was never wired up.
  function wireOutboxThrough(): void {
    const queue: OutboxRow[] = [];
    db.enqueueOutgoing!.mockImplementation(
      async (message: unknown, envelope: unknown) => {
        const m = message as { msgId: string; peerId: string };
        const e = envelope as {
          msgType: OutboxRow['msgType'];
          payload: string;
          priority?: number;
          urgent?: boolean;
          notify?: boolean;
        };
        queue.push({
          msgId: m.msgId,
          peerId: m.peerId,
          msgType: e.msgType,
          payload: e.payload,
          attempts: 0,
          priority: e.priority ?? 0,
          urgent: e.urgent ? 1 : 0,
          notify: e.notify === false ? 0 : 1,
        });
      },
    );
    db.listOutbox!.mockImplementation(async () => [...queue]);
  }

  function framesOnWire(): Record<string, unknown>[] {
    return ws.calls.send.mock.calls
      .map(c => c[0] as Record<string, unknown>)
      .filter(f => f.type === 'send');
  }

  it('a room read puts ZERO frames on the wire — proved by the same fixture sending for a 1:1', async () => {
    wireOutboxThrough();
    db.unreadInboundIds!.mockResolvedValue(['01INBOUNDZ3NDEKTSV4RRFFQ69']);

    // THE PRECONDITION, asserted so the fixture cannot pass vacuously
    // (the decoy-seed lesson): setting on, not blocked, not duress, unread
    // rows pending — with the anchor answering "not a room", this exact
    // read reaches the transport.
    await messaging.sendReadReceipt(FRIEND);
    await settle();
    const before = framesOnWire();
    expect(before).toHaveLength(1);
    expect(before[0]!.to).toBe(FRIEND);

    // Now the ONLY change is the anchor's answer.
    ws.calls.send.mockClear();
    db.enqueueOutgoing!.mockClear();
    db.markReadSent!.mockClear();
    db.getGroup!.mockResolvedValue({
      groupId: FRIEND,
      ownerId: '01QWNERZ3NDEKTSV4RRFFQ69G5',
      name: 'Kitchen',
    });

    await messaging.sendReadReceipt(FRIEND);
    await settle();

    // The gate that suppressed it was the ROOM gate, not an earlier one.
    expect(db.getGroup).toHaveBeenCalledWith(FRIEND);
    // Nothing durable, nothing on the wire, nothing burned: an id the
    // anchor calls a room never reaches SendFrame.to, and the
    // rows stay unacknowledged in case the anchor's answer ever changes.
    expect(db.enqueueOutgoing).not.toHaveBeenCalled();
    expect(db.markReadSent).not.toHaveBeenCalled();
    expect(framesOnWire()).toHaveLength(0);
  });
});
