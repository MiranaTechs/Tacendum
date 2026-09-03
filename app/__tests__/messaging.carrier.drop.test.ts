/**
 * The generic unknown-`x.*` durable-drop branch.
 *
 * An `x.*` kind this build cannot use, arriving as a DURABLE msg frame, must
 * cost nothing durable and show nothing: no messages row (the row would hold
 * the raw carrier JSON at rest — and its `arrivedAt` stamp is what
 * the unread query counts, while ChatThreadScreen filters the row invisible,
 * so the unread could never be cleared), no preview touch (previewFor yields
 * '' for carriers, so the touch BLANKS the chat's preview line), no notify.
 * Just markSeen + one ack, byte-identical to the grp. null-drop.
 *
 * Harness modelled on messaging.typing.test.ts (mocked decryptEnvelope,
 * ws.handlers.frame, db spies). The subsumption proof — the durable x.typing
 * frame still dropped whole — stays in that suite, unchanged.
 */
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
}));

import { messaging } from '../src/messaging';
import { session } from '../src/session';

type Mocks = Record<string, jest.Mock>;

const db = jest.requireMock('../src/db') as Mocks;
const api = jest.requireMock('../src/api') as Mocks;
const crypto = jest.requireMock('tacendum-crypto') as Mocks & {
  __keychain: Map<string, string>;
  __inbox: Map<string, unknown>;
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
  db.loadProfile!.mockResolvedValue(null);
  db.peerHasMyProfile!.mockResolvedValue(true);
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
  crypto.__inbox.clear();

  await messaging.start(ME);
  await settle();
  ws.calls.send.mockClear();
});

afterEach(() => {
  messaging.stop();
  session.setMode('real');
});

function acksFor(msgId: string): unknown[] {
  return ws.calls.send.mock.calls
    .map(c => c[0] as { type?: string; msgId?: string })
    .filter(f => f.type === 'ack' && f.msgId === msgId);
}

async function injectDurable(body: string, msgId: string): Promise<void> {
  crypto.decryptEnvelope!.mockResolvedValue(body);
  ws.handlers.frame?.({
    type: 'msg',
    from: FRIEND,
    msgId,
    msgType: 'ciphertext',
    payload: 'Q0lQSEVS',
    ts: 5,
  });
  await settle();
}

/** The full no-durable-cost contract, asserted identically per case. */
function expectDroppedWhole(msgId: string): void {
  expect(db.markSeen!).toHaveBeenCalledWith(msgId, expect.any(Number));
  expect(acksFor(msgId)).toHaveLength(1);
  // No row is ALSO the unread assertion: the unread query counts messages
  // rows by their arrivedAt stamp, so a row that is never inserted is an
  // unread that never phantom-increments.
  expect(db.insertMessage!).not.toHaveBeenCalled();
  // No preview touch: previewFor yields '' for carriers, so a touch here
  // would BLANK the chat's preview line, and the bump would reorder chats.
  expect(db.touchChat!).not.toHaveBeenCalled();
  expect(db.setChatPreview!).not.toHaveBeenCalled();
  expect(db.upsertChat!).not.toHaveBeenCalled();
}

describe('unknown x.* durable frames — the generic carrier drop', () => {
  test('an unknown x.zzz durable frame is acked and dropped whole — no row, no unread, no preview touch, no notify', async () => {
    const listener = jest.fn();
    const off = messaging.subscribe(listener);

    await injectDurable(
      '{"tcm":"x.zzz","q":"01ARZ3NDEKTSV4RRFFQ69G5FAV"}',
      '01CARRIERDROP00000000000A1',
    );
    off();

    expectDroppedWhole('01CARRIERDROP00000000000A1');
    // No notify: a re-render for a frame that changed nothing would be the
    // observable difference.
    expect(listener).not.toHaveBeenCalled();
  });

  test('a parsed-but-unhandled x.typing shape gets the same drop — the branch keys on the prefix, not the parse', async () => {
    // (a) VALID x.typing plus extra members. zod's strip mode parses this
    // (extra keys are dropped), so it exercises the parsed side of the
    // branch: a condition guarded on `envelope === null` — the wire-form
    // doc's sketch — would miss it the day the literal branch is removed.
    await injectDurable(
      '{"tcm":"x.typing","state":"start","extra":true}',
      '01CARRIERDROP00000000000B1',
    );
    expectDroppedWhole('01CARRIERDROP00000000000B1');

    // (b) DECLARES the x.typing literal but fails its schema (state outside
    // the enum), so parseEnvelope returns null. The parsed-LITERAL condition
    // (`envelope?.tcm === 'x.typing'`) can never match a null parse — this
    // is the case that goes red if the branch regresses to the literal.
    await injectDurable(
      '{"tcm":"x.typing","state":"bogus"}',
      '01CARRIERDROP00000000000B2',
    );
    expectDroppedWhole('01CARRIERDROP00000000000B2');
  });

  test('kind-name breadth — digits, hyphens, underscores and dotted names all drop', async () => {
    // The same four names envelope.groups.test.ts pins for the render-side
    // reservation: the declared-tcm pattern once only matched
    // lowercase-and-dots, and the first x.ack2 in the field would have been
    // noisy on every shipped build.
    const kinds = ['x.ack2', 'x.task-handoff', 'x.e2e_probe', 'x.v2.ack'];
    for (let i = 0; i < kinds.length; i++) {
      const msgId = `01CARRIERDROP0000000000C${i}Z`;
      await injectDurable(`{"tcm":"${kinds[i]}","whatever":1}`, msgId);
      expectDroppedWhole(msgId);
    }
  });

  test('the NSE-spool drain re-enters the same branch — a spooled unknown x.* costs no row either', async () => {
    // The drain hands the spooled PLAINTEXT straight back through
    // handleIncoming (payload empty, decrypt skipped), so the one branch
    // covers both entry points. Seed the spool, restart, and the drop
    // contract must hold identically.
    messaging.stop();
    const msgId = '01CARRIERDROP00000000000D1';
    crypto.__inbox.set(msgId, {
      from: FRIEND,
      msgId,
      ts: 7,
      body: '{"tcm":"x.zzz","q":"01ARZ3NDEKTSV4RRFFQ69G5FAV"}',
    });
    db.insertMessage!.mockClear();
    db.touchChat!.mockClear();
    db.setChatPreview!.mockClear();
    db.upsertChat!.mockClear();
    ws.calls.send.mockClear();

    await messaging.start(ME);
    await settle();

    expectDroppedWhole(msgId);
  });
});
