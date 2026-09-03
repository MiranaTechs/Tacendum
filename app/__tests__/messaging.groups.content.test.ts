/**
 * ROOMS — every content kind a 1:1 carries, through the SAME send functions
 * (proved end to end).
 *
 * What this file proves, and against what:
 *
 *  - COMPOSE-ONCE-UPLOAD-ONCE: a photo, a document and a voice
 *    note into an 11-member room cost ONE blobEncrypt, ONE attachmentCreate
 *    and ONE uploadBlob — never a per-recipient loop, which 429s at the 11th
 *    member under attachmentCreate's 10/min — and every member's leg carries
 *    the SAME attachment id and the SAME key inside its own ratchet.
 *  - THE BLOCK GATE SITS ABOVE THE UPLOAD (sendImage's own comment):
 *    a room holding a blocked member refuses BEFORE any blob exists in the
 *    shared store, because the blob is itself a beacon to anyone watching
 *    that store. Asserted as "the upload was never called", not merely as a
 *    throw.
 *  - DURESS: each kind writes one decoy row and puts NOTHING on the
 *    wire, NOTHING in the blob store, and never even reads the room anchor.
 *  - Reply, edit, retract and react ride the same room-aware functions the
 *    1:1 composer dials, addressed by the row key, carriers inheriting
 *    notify:false through isCarrierEnvelope's grp.msg recursion —
 *    never a second implementation (the absence-of-duplication scan).
 *
 * Assertions here are about CALLS (what was uploaded, what reached the
 * enqueue, what was refused), so `../src/db` is module-mocked — the harness
 * argument in messaging.fanout.test.ts, whose mocks this file copies.
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
    start(_token: string) {
      calls.start(_token);
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
  apiDeleteAccount: jest.fn(),
  apiGetPrekeyBundle: jest.fn(),
  apiCreateAttachment: jest.fn(),
  apiGetAttachmentUrl: jest.fn(),
  uploadBlob: jest.fn(),
  downloadBlob: jest.fn(),
  apiWsTicket: jest.fn(),
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
  // reads
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
  // rooms
  getGroup: jest.fn(),
  listGroupMemberSlots: jest.fn(),
  listGroupSettingsSlots: jest.fn(),
  // The marker-OR-record agent set fanOut prunes non-mention legs by.
  listMachinePeers: jest.fn(),
  listRoomAgentAuthorIds: jest.fn(),
  reserveGroupSeq: jest.fn(),
  enqueueOutgoingFanout: jest.fn(),
  aggregateFanoutStatus: jest.fn(),
  markLegFailed: jest.fn(),
  fanoutDeliveryState: jest.fn(),
  // writes
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

import type { FanoutLeg, MessageRow, OutboxRow } from '../src/db';
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
    __ws: {
      handlers: { frame?: (f: unknown) => void; state?: (s: string) => void };
      calls: { start: jest.Mock; stop: jest.Mock; send: jest.Mock };
      state: { open: boolean };
    };
  }
).__ws;

const ME = '01ME00000000000000000000AA';
const ROOM = '01R88MZ3NDEKTSV4RRFFQ69G5A';
/** Valid Crockford ULIDs (no I, L, O, U) for the other eleven seats. */
function member(i: number): string {
  return `01MBR${String(i).padStart(3, '0')}${'0'.repeat(18)}`;
}
const MEMBERS = Array.from({ length: 11 }, (_, i) => member(i));

/** The capability id + key the ONE upload mints — what every leg must share. */
const ATT_ID = 'ATTCAP43CHARSRANDOMBLOBIDXXXXXXXXXXXXXXXX01';
const KEY_B64 = 'S0VZS0VZS0VZS0VZS0VZS0VZS0VZS0VZS0VZS0VZS0U=';

/** Long enough for the send chain (fold → gates → upload → encrypt ×11). */
async function flush(turns = 80): Promise<void> {
  for (let i = 0; i < turns; i++) await Promise.resolve();
}

function sendFrames(): Array<{ type: string; msgId: string; to: string }> {
  return ws.calls.send.mock.calls
    .map(c => c[0] as { type: string; msgId: string; to: string })
    .filter(f => f.type === 'send');
}

function rosterSlots(ids: string[]) {
  return ids.map((memberId, i) => ({
    memberId,
    writerId: ME,
    seq: i + 1,
    state: 'in' as const,
  }));
}

function enqueuedFanouts(): Array<
  [MessageRow & { authorId: string; sq: number }, FanoutLeg[]]
> {
  return db.enqueueOutgoingFanout!.mock.calls as never;
}

/** The grp.msg wrapper each member's ratchet was handed, keyed by member. */
function wrappersByMember(): Map<string, { b: string; g: string; m: string }> {
  const out = new Map<string, { b: string; g: string; m: string }>();
  for (const call of crypto.encryptText!.mock.calls) {
    const [, peer, plaintext] = call as [string, string, string];
    try {
      const parsed = JSON.parse(plaintext) as { tcm?: string; b: string; g: string; m: string };
      if (parsed.tcm === 'grp.msg') out.set(peer, parsed);
    } catch {
      /* profile cards etc. */
    }
  }
  return out;
}

function resetDb(): void {
  const reads: Array<[string, unknown]> = [
    ['getChat', null],
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
    ['applyEdit', true],
    ['tombstoneMessage', true],
    ['saveMyProfileCard', null],
    ['getGroup', { groupId: ROOM, ownerId: ME, name: 'Kitchen' }],
    ['listGroupMemberSlots', rosterSlots([ME, ...MEMBERS])],
    // No agents in this room by default, so fanOut prunes nobody and
    // the compose-once-fan-out-N properties below read the full roster.
    ['listMachinePeers', []],
    ['listRoomAgentAuthorIds', []],
    ['listGroupSettingsSlots', []],
    ['reserveGroupSeq', 7],
    ['fanoutDeliveryState', {
      total: 0, queued: 0, sent: 0, delivered: 0, failed: 0, failedPeerIds: [],
    }],
  ];
  const writes = [
    'insertMessage',
    'enqueueOutgoing',
    'enqueueOutgoingFanout',
    'aggregateFanoutStatus',
    'markLegFailed',
    'touchChat',
    'upsertChat',
    'setChatPreview',
    'markSeen',
    'applyReceipt',
    'bumpOutboxAttempt',
    'deleteOutboxEnvelope',
    'markOutgoingError',
    'putAttachment',
    'setReaction',
    'holdRevision',
    'dropHeldRevision',
    'applyPeerProfile',
    'setPeerAvatar',
    'markMyProfileSent',
    'setIdentityChanged',
    'setSafetyChecked',
    'setSafetyMismatch',
    'blockPeer',
    'unblockPeer',
  ];
  for (const [name, value] of reads) {
    db[name]!.mockReset();
    db[name]!.mockResolvedValue(value);
  }
  for (const name of writes) {
    db[name]!.mockReset();
    db[name]!.mockResolvedValue(undefined);
  }
}

beforeEach(async () => {
  messaging.stop();
  session.setMode('real');
  resetDb();
  ws.state.open = true;
  ws.calls.send.mockReset();
  ws.calls.send.mockImplementation((_frame: unknown) => true);
  ws.calls.start.mockClear();
  ws.calls.stop.mockClear();
  for (const name of Object.keys(api)) api[name]!.mockReset();
  api.apiGetPrekeyBundle!.mockResolvedValue({});
  api.apiCreateAttachment!.mockResolvedValue({
    attachmentId: ATT_ID,
    uploadUrl: 'https://blobs.example/put',
  });
  api.uploadBlob!.mockResolvedValue(undefined);
  crypto.encryptText!.mockReset().mockResolvedValue({
    msgType: 'ciphertext',
    payload: 'Q0lQSEVS',
  });
  crypto.blobEncrypt!.mockReset().mockResolvedValue({
    keyB64: KEY_B64,
    blobB64: 'Q0lQSEVSQkxPQg==',
  });
  crypto.processPreKeyBundle!.mockReset().mockResolvedValue(undefined);
  crypto.hasSession!.mockReset().mockResolvedValue(true);
  crypto.isIdentityChangeError!.mockReset().mockReturnValue(false);
  crypto.randomBytes!.mockReset().mockImplementation(async (n: number) => {
    const bytes = (
      require('crypto') as { randomBytes: (c: number) => Uint8Array }
    ).randomBytes(n);
    return Uint8Array.from(bytes);
  });
  crypto.__keychain.clear();
  crypto.__keychain.set('authToken', 'tok');
});

afterEach(() => {
  messaging.stop();
  session.setMode('real');
});

async function startMessaging(): Promise<void> {
  await messaging.start(ME);
  await flush();
  ws.calls.send.mockClear();
  db.listOutbox!.mockClear();
  db.touchChat!.mockClear();
}

// ---------------------------------------------------------------------------

describe('compose once, upload once, fan out N times', () => {
  it('a room photo: ONE blobEncrypt + ONE attachmentCreate + ONE upload for 11 members; every leg carries the SAME att and key; preview "Photo"; the attachment row lands after the one-transaction commit', async () => {
    await startMessaging();
    await messaging.sendImage(ROOM, 'aW1nQjY0', 4, 6);

    // THE the design PROPERTY: 11 recipients, one blob. A per-recipient loop
    // reads 11: 11: 11 here and 429s at the 11th member in production.
    expect(crypto.blobEncrypt).toHaveBeenCalledTimes(1);
    expect(api.apiCreateAttachment).toHaveBeenCalledTimes(1);
    expect(api.uploadBlob).toHaveBeenCalledTimes(1);

    // Every member's leg wraps the SAME pointer: one capability id, one key.
    const wrappers = wrappersByMember();
    expect(new Set(wrappers.keys())).toEqual(new Set(MEMBERS));
    for (const wrapper of wrappers.values()) {
      const inner = JSON.parse(wrapper.b) as Record<string, unknown>;
      expect(inner.tcm).toBe('image');
      expect(inner.att).toBe(ATT_ID);
      expect(inner.key).toBe(KEY_B64);
      expect(inner.w).toBe(4);
      expect(inner.h).toBe(6);
    }
    // Composed ONCE: the wrapper string is byte-identical on every leg.
    const texts = new Set(
      crypto.encryptText!.mock.calls.map(c => c[2] as string),
    );
    expect(texts.size).toBe(1);

    // One row + 11 legs in the one fan-out transaction; the row's body IS
    // the image envelope, so the thread renders a photo.
    expect(db.enqueueOutgoingFanout).toHaveBeenCalledTimes(1);
    const [row, legs] = enqueuedFanouts()[0];
    expect(legs).toHaveLength(11);
    expect((JSON.parse(row.body) as { tcm: string }).tcm).toBe('image');
    for (const leg of legs) expect(leg.notify).toBe(true);

    // The kind's own word in the chat list.
    expect(db.touchChat).toHaveBeenCalledWith(ROOM, 'Photo', expect.any(Number));
    // The sender's plain bytes land via onEnqueued — AFTER the commit
    // (encryptAndEnqueue's contract, kept by fanOut), keyed by the room row.
    expect(db.putAttachment).toHaveBeenCalledWith(
      row.msgId, 'out', 'ready', 'aW1nQjY0', 4, 6,
    );
    expect(db.putAttachment!.mock.invocationCallOrder[0]).toBeGreaterThan(
      db.enqueueOutgoingFanout!.mock.invocationCallOrder[0],
    );
    // And the upload preceded the commit: the pointer must exist to compose.
    expect(api.uploadBlob!.mock.invocationCallOrder[0]).toBeLessThan(
      db.enqueueOutgoingFanout!.mock.invocationCallOrder[0],
    );
  });

  it('a room document: one upload, same att+key on all 11 legs, name/size/mime inside the ratchet, preview "Document"', async () => {
    await startMessaging();
    await messaging.sendFile(ROOM, 'ZG9jQjY0', 'notes.pdf', 1234, 'application/pdf');

    expect(crypto.blobEncrypt).toHaveBeenCalledTimes(1);
    expect(api.apiCreateAttachment).toHaveBeenCalledTimes(1);
    expect(api.uploadBlob).toHaveBeenCalledTimes(1);

    const wrappers = wrappersByMember();
    expect(new Set(wrappers.keys())).toEqual(new Set(MEMBERS));
    for (const wrapper of wrappers.values()) {
      const inner = JSON.parse(wrapper.b) as Record<string, unknown>;
      expect(inner.tcm).toBe('file');
      expect(inner.att).toBe(ATT_ID);
      expect(inner.key).toBe(KEY_B64);
      expect(inner.name).toBe('notes.pdf');
      expect(inner.size).toBe(1234);
      expect(inner.mime).toBe('application/pdf');
    }
    const [row, legs] = enqueuedFanouts()[0];
    expect(legs).toHaveLength(11);
    expect((JSON.parse(row.body) as { tcm: string }).tcm).toBe('file');
    expect(db.touchChat).toHaveBeenCalledWith(ROOM, 'Document', expect.any(Number));
    expect(db.putAttachment).toHaveBeenCalledWith(
      row.msgId, 'out', 'ready', 'ZG9jQjY0', null, null,
    );
  });

  it('a room voice note: one upload, same att+key on all 11 legs, the clamped duration, preview "Voice message"', async () => {
    await startMessaging();
    await messaging.sendVoice(ROOM, 'dm9pY2U=', 9.4);

    expect(crypto.blobEncrypt).toHaveBeenCalledTimes(1);
    expect(api.apiCreateAttachment).toHaveBeenCalledTimes(1);
    expect(api.uploadBlob).toHaveBeenCalledTimes(1);

    const wrappers = wrappersByMember();
    expect(new Set(wrappers.keys())).toEqual(new Set(MEMBERS));
    for (const wrapper of wrappers.values()) {
      const inner = JSON.parse(wrapper.b) as Record<string, unknown>;
      expect(inner.tcm).toBe('voice');
      expect(inner.att).toBe(ATT_ID);
      expect(inner.key).toBe(KEY_B64);
      expect(inner.dur).toBe(9);
    }
    const [row, legs] = enqueuedFanouts()[0];
    expect(legs).toHaveLength(11);
    expect((JSON.parse(row.body) as { tcm: string }).tcm).toBe('voice');
    expect(db.touchChat).toHaveBeenCalledWith(
      ROOM, 'Voice message', expect.any(Number),
    );
    expect(db.putAttachment).toHaveBeenCalledWith(
      row.msgId, 'out', 'ready', 'dm9pY2U=', null, null,
    );
  });

  it('a room voice note that commits and then fails its attachment write reports err.enqueued — the caller must not hand the take back as a duplicate send', async () => {
    await startMessaging();
    db.putAttachment!.mockRejectedValue(new Error('disk full'));
    let caught: unknown;
    try {
      await messaging.sendVoice(ROOM, 'dm9pY2U=', 5);
    } catch (err) {
      caught = err;
    }
    // Precondition: the failure really came from AFTER the commit.
    expect(db.enqueueOutgoingFanout).toHaveBeenCalledTimes(1);
    expect((caught as { enqueued?: boolean } | undefined)?.enqueued).toBe(true);
  });

  it('a room location: NO blob path at all — coordinates ride inside each ratchet; preview "Location"', async () => {
    await startMessaging();
    await messaging.sendLocation(ROOM, 51.5074, -0.1278);

    // No shared-store artefact exists for a location, in a room as in a 1:1.
    expect(crypto.blobEncrypt).not.toHaveBeenCalled();
    expect(api.apiCreateAttachment).not.toHaveBeenCalled();
    expect(api.uploadBlob).not.toHaveBeenCalled();

    const wrappers = wrappersByMember();
    expect(new Set(wrappers.keys())).toEqual(new Set(MEMBERS));
    for (const wrapper of wrappers.values()) {
      const inner = JSON.parse(wrapper.b) as Record<string, unknown>;
      expect(inner.tcm).toBe('loc');
      expect(inner.lat).toBe(51.5074);
      expect(inner.lng).toBe(-0.1278);
    }
    const [row, legs] = enqueuedFanouts()[0];
    expect(legs).toHaveLength(11);
    expect((JSON.parse(row.body) as { tcm: string }).tcm).toBe('loc');
    expect(db.touchChat).toHaveBeenCalledWith(ROOM, 'Location', expect.any(Number));
  });
});

describe('a blocked member makes the room read-only BEFORE the upload', () => {
  it.each([
    ['photo', () => messaging.sendImage(ROOM, 'aW1n', 4, 4)],
    ['document', () => messaging.sendFile(ROOM, 'ZG9j', 'a.pdf', 9, 'application/pdf')],
    ['voice note', () => messaging.sendVoice(ROOM, 'dm9pY2U=', 5)],
  ] as const)(
    'a %s throws BlockedPeerError with the upload NEVER called — no blobEncrypt, no attachmentCreate, no uploadBlob, no beacon in the shared store',
    async (_kind, send) => {
      await startMessaging();
      await messaging.blockPeer(member(4));
      crypto.blobEncrypt!.mockClear();
      api.apiCreateAttachment!.mockClear();
      api.uploadBlob!.mockClear();

      await expect(send()).rejects.toMatchObject({ name: 'BlockedPeerError' });

      // THE ORDERING ASSERTION, not merely the throw: the gate sat ABOVE
      // the upload, so nothing was encrypted, minted or uploaded — a blob
      // in the store is a beacon even when no envelope ever points at it.
      expect(crypto.blobEncrypt).not.toHaveBeenCalled();
      expect(api.apiCreateAttachment).not.toHaveBeenCalled();
      expect(api.uploadBlob).not.toHaveBeenCalled();
      expect(db.enqueueOutgoingFanout).not.toHaveBeenCalled();
      expect(db.putAttachment).not.toHaveBeenCalled();
      expect(sendFrames()).toHaveLength(0);
    },
  );

  it('a location to a room holding a blocked member is refused with nothing enqueued', async () => {
    await startMessaging();
    await messaging.blockPeer(member(4));
    await expect(
      messaging.sendLocation(ROOM, 1, 2),
    ).rejects.toMatchObject({ name: 'BlockedPeerError' });
    expect(db.enqueueOutgoingFanout).not.toHaveBeenCalled();
    expect(sendFrames()).toHaveLength(0);
  });
});

describe('duress: one decoy row, ZERO frames, ZERO uploads', () => {
  it.each([
    [
      'photo',
      () => messaging.sendImage(ROOM, 'aW1n', 4, 4),
      (body: string) => {
        const env = JSON.parse(body) as Record<string, unknown>;
        expect(env.tcm).toBe('image');
        // The decoy pointer: parse-safe, never fetched (att 'decoy').
        expect(env.att).toBe('decoy');
      },
    ],
    [
      'document',
      () => messaging.sendFile(ROOM, 'ZG9j', 'a.pdf', 9, 'application/pdf'),
      (body: string) => {
        expect((JSON.parse(body) as { tcm: string }).tcm).toBe('file');
      },
    ],
    [
      'voice note',
      () => messaging.sendVoice(ROOM, 'dm9pY2U=', 5),
      (body: string) => {
        expect((JSON.parse(body) as { tcm: string }).tcm).toBe('voice');
      },
    ],
    [
      'location',
      () => messaging.sendLocation(ROOM, 1, 2),
      (body: string) => {
        expect((JSON.parse(body) as { tcm: string }).tcm).toBe('loc');
      },
    ],
  ] as const)(
    'a duress %s writes ONE decoy row and touches neither the wire, nor the blob store, nor the room anchor',
    async (_kind, send, checkBody) => {
      session.setMode('duress');
      await send();

      // ONE local row, already 'sent', in whichever thread peerId names.
      expect(db.insertMessage).toHaveBeenCalledTimes(1);
      const echoed = db.insertMessage!.mock.calls[0][0] as MessageRow;
      expect(echoed.peerId).toBe(ROOM);
      expect(echoed.status).toBe('sent');
      checkBody(echoed.body);

      // ZERO frames, ZERO uploads, ZERO crypto — and the anchor was never
      // read: a duress session must not consult room state to fake a send.
      expect(ws.calls.send).not.toHaveBeenCalled();
      expect(crypto.blobEncrypt).not.toHaveBeenCalled();
      expect(api.apiCreateAttachment).not.toHaveBeenCalled();
      expect(api.uploadBlob).not.toHaveBeenCalled();
      expect(crypto.encryptText).not.toHaveBeenCalled();
      expect(db.enqueueOutgoingFanout).not.toHaveBeenCalled();
      expect(db.getGroup).not.toHaveBeenCalled();
    },
  );

  it('a duress photo still gets its decoy attachment row, written "ready" so nothing ever tries to download it', async () => {
    session.setMode('duress');
    await messaging.sendImage(ROOM, 'aW1n', 4, 4);
    const echoedId = (db.insertMessage!.mock.calls[0][0] as MessageRow).msgId;
    expect(db.putAttachment).toHaveBeenCalledWith(
      echoedId, 'out', 'ready', 'aW1n', 4, 4,
    );
  });
});

describe('reply, edit, retract and react — the same branches as 1:1', () => {
  const AUTHOR = member(3);
  const THEIR_ROW = `${AUTHOR}.01TGT0000000000000000000AA`;
  const MY_ROW = `${ME}.01TGT0000000000000000000AB`;

  it('a room reply is sendReply: the reply envelope rides grp.msg with the ref, one row + 11 legs, previewed by its words', async () => {
    await startMessaging();
    await messaging.sendReply(ROOM, THEIR_ROW, 'in', 'me too');

    const wrappers = wrappersByMember();
    expect(new Set(wrappers.keys())).toEqual(new Set(MEMBERS));
    for (const wrapper of wrappers.values()) {
      const inner = JSON.parse(wrapper.b) as Record<string, unknown>;
      expect(inner.tcm).toBe('reply');
      expect(inner.ref).toBe(THEIR_ROW);
      expect(inner.text).toBe('me too');
    }
    const [row, legs] = enqueuedFanouts()[0];
    expect(legs).toHaveLength(11);
    expect((JSON.parse(row.body) as { tcm: string }).tcm).toBe('reply');
    // A reply is conversation, not a carrier: it notifies and previews.
    for (const leg of legs) expect(leg.notify).toBe(true);
    expect(db.touchChat).toHaveBeenCalledWith(ROOM, 'me too', expect.any(Number));
    // Never the 1:1 write path.
    expect(db.enqueueOutgoing).not.toHaveBeenCalled();
  });

  it('a room edit is sendEdit: the edit carrier fans with my own row as ref, notify:false via grp.msg recursion, applied locally after the commit, no preview bump', async () => {
    await startMessaging();
    await messaging.sendEdit(ROOM, MY_ROW, 'better words');

    const wrappers = wrappersByMember();
    expect(new Set(wrappers.keys())).toEqual(new Set(MEMBERS));
    for (const wrapper of wrappers.values()) {
      const inner = JSON.parse(wrapper.b) as Record<string, unknown>;
      expect(inner.tcm).toBe('edit');
      expect(inner.ref).toBe(MY_ROW);
      expect(inner.text).toBe('better words');
    }
    const [, legs] = enqueuedFanouts()[0];
    expect(legs).toHaveLength(11);
    // The design: isCarrierEnvelope recurses through grp.msg, so an edit inherits
    // notify:false with no caller remembering a flag — the choke-point rule.
    for (const leg of legs) expect(leg.notify).toBe(false);
    // My own copy rewrote through the SAME editRow branch as a 1:1 edit —
    // with NO ai claim: my own compose path is a person typing.
    expect(db.applyEdit).toHaveBeenCalledWith(
      ROOM, MY_ROW, 'out', 'better words', expect.any(Number), false,
    );
    // A carrier never bumps the chat's timestamp (the preview is recomputed
    // separately by refreshPreview → setChatPreview).
    expect(db.touchChat).not.toHaveBeenCalled();
    expect(db.setChatPreview).toHaveBeenCalled();
  });

  it('a room retraction is sendDelete: the del carrier fans, the target tombstones locally, and the ORIGINAL’s queued legs are dropped by wire id — msgId alone misses every leg (the fan-out lesson)', async () => {
    await startMessaging();
    const legOf = (msgId: string, localMsgId: string | null): OutboxRow => ({
      msgId,
      peerId: member(1),
      msgType: 'ciphertext',
      payload: 'Q0lQSEVS',
      attempts: 0,
      priority: 0,
      urgent: 0,
      notify: 1,
      localMsgId,
    });
    db.listOutbox!.mockResolvedValue([
      legOf('01LEGA0000000000000000000A', MY_ROW),
      legOf('01LEGB0000000000000000000B', MY_ROW),
      legOf('01LEGC0000000000000000000C', `${ME}.01OTHER00000000000000000A`),
      legOf('01ONET00000000000000000000', null),
    ]);

    await messaging.sendDelete(ROOM, MY_ROW);

    // The original's own legs died — and ONLY the original's.
    const dropped = db.deleteOutboxEnvelope!.mock.calls.map(c => c[0]);
    expect(dropped).toContain('01LEGA0000000000000000000A');
    expect(dropped).toContain('01LEGB0000000000000000000B');
    expect(dropped).not.toContain('01LEGC0000000000000000000C');
    expect(dropped).not.toContain('01ONET00000000000000000000');

    const wrappers = wrappersByMember();
    expect(new Set(wrappers.keys())).toEqual(new Set(MEMBERS));
    for (const wrapper of wrappers.values()) {
      const inner = JSON.parse(wrapper.b) as Record<string, unknown>;
      expect(inner.tcm).toBe('del');
      expect(inner.ref).toBe(MY_ROW);
    }
    const [, legs] = enqueuedFanouts()[0];
    expect(legs).toHaveLength(11);
    for (const leg of legs) expect(leg.notify).toBe(false);
    // The SAME tombstone branch as a 1:1 retraction, keyed by the room row.
    expect(db.tombstoneMessage).toHaveBeenCalledWith(
      ROOM, MY_ROW, 'out', expect.any(Number),
    );
  });

  it('a room reaction is sendReaction: the react carrier fans with the row key as ref, the chip lands via the SAME setReaction branch, notify:false, no preview', async () => {
    await startMessaging();
    await messaging.sendReaction(ROOM, THEIR_ROW, 'in', '❤️');

    const wrappers = wrappersByMember();
    expect(new Set(wrappers.keys())).toEqual(new Set(MEMBERS));
    for (const wrapper of wrappers.values()) {
      const inner = JSON.parse(wrapper.b) as Record<string, unknown>;
      expect(inner.tcm).toBe('react');
      expect(inner.ref).toBe(THEIR_ROW);
      expect(inner.emoji).toBe('❤️');
    }
    const [, legs] = enqueuedFanouts()[0];
    expect(legs).toHaveLength(11);
    for (const leg of legs) expect(leg.notify).toBe(false);
    expect(db.setReaction).toHaveBeenCalledWith(
      THEIR_ROW, 'in', 'out', '❤️', expect.any(Number),
    );
    expect(db.touchChat).not.toHaveBeenCalled();
    expect(db.enqueueOutgoing).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------

/**
 * A room CONTENT message reaches an AGENT member only when it
 * @mentions that agent. The sender excludes the
 * unmentioned agent's leg BY DEFAULT — a clean non-send, never a failed leg —
 * while a HUMAN leg always sends. Membership events still fan to the whole
 * roster except for the ruled `grp.consent/hold`: that courtesy event
 * reaches humans after revocation and intentionally omits its subject agent.
 * `share` still reaches the whole roster. The mutation that reverts the
 * content exclusion turns each of the first three red.
 */
describe('a room message reaches an agent only when it names the agent', () => {
  const HUMAN = member(0);
  const AGENT = member(1);

  /** A structured mention envelope: one U+FFFC mark per named id, exactly the
   * shape envelope.ts refuses unless mentionMarkCount === who.length. */
  function mention(words: string, ids: string[]): string {
    return JSON.stringify({
      tcm: 'mention',
      text: '￼'.repeat(ids.length) + ' ' + words,
      who: ids,
    });
  }

  /** The member ids a given wire kind's legs were sealed for. */
  function recipientsOfKind(tcm: string): Set<string> {
    const ids = new Set<string>();
    for (const call of crypto.encryptText!.mock.calls) {
      const [, peer, plaintext] = call as [string, string, string];
      try {
        if ((JSON.parse(plaintext) as { tcm?: string }).tcm === tcm) ids.add(peer);
      } catch {
        /* profile cards etc. */
      }
    }
    return ids;
  }

  beforeEach(() => {
    // A three-seat room: the owner (ME), one human, one of the owner's agents.
    db.listGroupMemberSlots!.mockResolvedValue(rosterSlots([ME, HUMAN, AGENT]));
    // The owner's own client knows its agent from the adopted-machine record,
    // before the agent has even spoken (the app's marker-OR-record set).
    db.listMachinePeers!.mockResolvedValue([AGENT]);
    db.listRoomAgentAuthorIds!.mockResolvedValue([]);
  });

  it('a NON-mention grp.msg excludes the agent leg, keeps the human, and marks NO leg failed', async () => {
    await startMessaging();
    await messaging.fanOut(ROOM, 'anyone around?');

    const seen = recipientsOfKind('grp.msg');
    expect(seen.has(HUMAN)).toBe(true);
    expect(seen.has(AGENT)).toBe(false);

    // Clean exclusion, NOT the consent-refused leg: the agent is absent from the
    // enqueued legs entirely (not a failed entry), and nothing was marked
    // failed. The two cases are kept distinct.
    const [, legs] = enqueuedFanouts()[0];
    expect(legs.map(l => l.peerId)).toEqual([HUMAN]);
    expect(legs.some(l => l.failed === true)).toBe(false);
    expect(db.markLegFailed).not.toHaveBeenCalled();
  });

  it('a grp.msg that @mentions the agent DELIVERS to it (and to the human)', async () => {
    await startMessaging();
    await messaging.fanOut(ROOM, mention('ping', [AGENT]));

    const seen = recipientsOfKind('grp.msg');
    expect(seen.has(AGENT)).toBe(true);
    expect(seen.has(HUMAN)).toBe(true);
  });

  it('the marker-record path excludes an agent a co-member has only HEARD (no machine_peers)', async () => {
    // A non-owner co-member holds no machine record; its ONLY agent signal is
    // the AI-marked author it has heard in the room. Same exclusion result.
    db.listMachinePeers!.mockResolvedValue([]);
    db.listRoomAgentAuthorIds!.mockResolvedValue([AGENT]);
    await startMessaging();
    await messaging.fanOut(ROOM, 'anyone around?');

    const seen = recipientsOfKind('grp.msg');
    expect(seen.has(AGENT)).toBe(false);
    expect(seen.has(HUMAN)).toBe(true);
  });

  it('the ROSTER-CLASS path excludes an agent the owner’s write classed — before it has EVER spoken', async () => {
    // The stranger's phone: no machine record, no ai rows — the ONLY agent
    // signal is the class on the owner's authoritative roster slot. The
    // exclusion no longer waits for the agent to have spoken (and a human,
    // never classed, is never touched).
    db.listMachinePeers!.mockResolvedValue([]);
    db.listRoomAgentAuthorIds!.mockResolvedValue([]);
    db.listGroupMemberSlots!.mockResolvedValue([
      ...rosterSlots([ME, HUMAN]),
      { memberId: AGENT, writerId: ME, seq: 3, state: 'in' as const, class: 'integration' as const },
    ]);
    await startMessaging();
    await messaging.fanOut(ROOM, 'anyone around?');

    const seen = recipientsOfKind('grp.msg');
    expect(seen.has(AGENT)).toBe(false);
    expect(seen.has(HUMAN)).toBe(true);

    // …and an @mention still reaches it: the class informs, it never silences.
    crypto.encryptText!.mockClear();
    await messaging.fanOut(ROOM, mention('ping', [AGENT]));
    const mentioned = recipientsOfKind('grp.msg');
    expect(mentioned.has(AGENT)).toBe(true);
    expect(mentioned.has(HUMAN)).toBe(true);
  });

  it('grp.consent is direction-aware: hold tells humans only; share still tells the full roster including the agent', async () => {
    await startMessaging();
    // A revoked subject learns from its next
    // server-refused frame, not a courtesy leg through the closed channel.
    await messaging.fanOutMembership(ROOM, {
      tcm: 'grp.consent',
      g: ROOM,
      a: AGENT,
      s: 'hold',
      n: 9,
    });

    const holdRecipients = recipientsOfKind('grp.consent');
    expect(holdRecipients.has(AGENT)).toBe(false);
    expect(holdRecipients.has(HUMAN)).toBe(true);

    // Share is unchanged: the freshly written edge admits the agent's own
    // stance leg, and all other members receive it too.
    crypto.encryptText!.mockClear();
    await messaging.fanOutMembership(ROOM, {
      tcm: 'grp.consent',
      g: ROOM,
      a: AGENT,
      s: 'share',
      n: 10,
    });
    const shareRecipients = recipientsOfKind('grp.consent');
    expect(shareRecipients.has(AGENT)).toBe(true);
    expect(shareRecipients.has(HUMAN)).toBe(true);
  });

  // -- The "addressed-or-owned" rule ---------------------
  // The pure @mention test was TOO NARROW. An agent ALSO keeps its content
  // leg on a REPLY-TO-CONTINUE (a reply to a row IT authored) and on a
  // LIFECYCLE carrier (edit/del/react) whose TARGET it already received.
  // Ordinary non-mention chatter is still excluded; a human never is.
  const AGENT_ROW = `${AGENT}.01TGT0000000000000000000AA`;
  const HUMAN_ROW = `${HUMAN}.01TGT0000000000000000000AA`;
  const MY_ROW = `${ME}.01MINE000000000000000000AA`;

  it('reply-to-continue: a reply to the AGENT’s own row reaches the agent (the demo-critical leg) and the human — no @mention anywhere', async () => {
    await startMessaging();
    await messaging.sendReply(ROOM, AGENT_ROW, 'in', 'keep going');

    const seen = recipientsOfKind('grp.msg');
    expect(seen.has(AGENT)).toBe(true); // reddens if the reply branch reverts
    expect(seen.has(HUMAN)).toBe(true);
  });

  it('reply-to-continue does NOT reach an agent when the reply targets a HUMAN’s row', async () => {
    await startMessaging();
    await messaging.sendReply(ROOM, HUMAN_ROW, 'in', 'ok');

    const seen = recipientsOfKind('grp.msg');
    expect(seen.has(AGENT)).toBe(false);
    expect(seen.has(HUMAN)).toBe(true);
  });

  it('edit of a row that MENTIONED the agent reaches it (lifecycle #3)', async () => {
    // The target — my own earlier row — mentioned the agent, so the agent
    // received it and must receive the rewrite.
    db.getMessage!.mockResolvedValue({ body: mention('ping', [AGENT]), authorId: ME });
    await startMessaging();
    await messaging.sendEdit(ROOM, MY_ROW, 'better ping');

    const seen = recipientsOfKind('grp.msg');
    expect(seen.has(AGENT)).toBe(true);
    expect(seen.has(HUMAN)).toBe(true);
  });

  it('delete of a row that MENTIONED the agent reaches it (lifecycle #3)', async () => {
    db.getMessage!.mockResolvedValue({ body: mention('ping', [AGENT]), authorId: ME });
    await startMessaging();
    await messaging.sendDelete(ROOM, MY_ROW);

    const seen = recipientsOfKind('grp.msg');
    expect(seen.has(AGENT)).toBe(true);
    expect(seen.has(HUMAN)).toBe(true);
  });

  it('EDIT whose target the agent never received stays EXCLUDED — the NEW body never leaks', async () => {
    // Target not in this phone's store (getMessage → null). An edit carries a
    // new body, so the undeterminable default MUST exclude the agent.
    db.getMessage!.mockResolvedValue(null);
    await startMessaging();
    await messaging.sendEdit(ROOM, MY_ROW, 'secret new words');

    const seen = recipientsOfKind('grp.msg');
    expect(seen.has(AGENT)).toBe(false); // reddens if edit default-includes
    expect(seen.has(HUMAN)).toBe(true);
  });

  it('DELETE whose target the agent never received still INCLUDES the agent — a tombstone carries no body (the safe-default asymmetry vs edit)', async () => {
    db.getMessage!.mockResolvedValue(null);
    await startMessaging();
    await messaging.sendDelete(ROOM, MY_ROW);

    const seen = recipientsOfKind('grp.msg');
    expect(seen.has(AGENT)).toBe(true);
    expect(seen.has(HUMAN)).toBe(true);
  });

  it('REACTION to the agent’s OWN row reaches it; a reaction with an unresolvable target does not', async () => {
    // Authored-by-agent target: included even with no mention.
    db.getMessage!.mockResolvedValue({ body: 'plain words', authorId: AGENT });
    await startMessaging();
    await messaging.sendReaction(ROOM, AGENT_ROW, 'in', '❤️');
    expect(recipientsOfKind('grp.msg').has(AGENT)).toBe(true);

    // Undeterminable target (null): EXCLUDE.
    db.getMessage!.mockResolvedValue(null);
    crypto.encryptText!.mockClear();
    await messaging.sendReaction(ROOM, HUMAN_ROW, 'in', '❤️');
    expect(recipientsOfKind('grp.msg').has(AGENT)).toBe(false);
  });
});
