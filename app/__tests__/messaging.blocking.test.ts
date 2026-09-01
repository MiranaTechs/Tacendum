/**
 * BLOCKING — the enforcement half (blocking.ts is the policy half).
 *
 * The feature's only real property is a negative: while someone is blocked,
 * NOTHING goes to them and NOTHING is fetched on their behalf. So almost every
 * test here asserts that something did not happen. A test that merely asserts
 * a boolean got set proves nothing at all — the boolean is not the feature,
 * the silence is.
 *
 * `./db` is mocked outright rather than driven through the fake sqlite: the
 * assertions this file needs are "db.setReaction was never called", "no row was
 * inserted", "markSeen was called and then acked", and those are statements
 * about the call, not about the SQL.
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
  apiDeleteAccount: jest.fn(),
  apiGetPrekeyBundle: jest.fn(),
  apiCreateAttachment: jest.fn(),
  apiGetAttachmentUrl: jest.fn(),
  uploadBlob: jest.fn(),
  downloadBlob: jest.fn(),
}));

// The decoy workspace has its own blocked_peers rows and its own session; this
// file is about the real one, and syncDecoyProfile would only open a second
// database behind the mocked `./db`.
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
  // Read on the send path to stamp a disappearing-message expiry; undefined
  // means no timer, which is what every test here assumes.
  getChat: jest.fn(),
  // Read on every kind-send path to detect a room; null —
  // the definite "not a room" — is what every 1:1 test here assumes.
  getGroup: jest.fn(),
  listGroupMemberSlots: jest.fn(),
  // reads
  hasSeen: jest.fn(),
  getMessage: jest.fn(),
  listOutbox: jest.fn(),
  listChats: jest.fn(),
  listMessages: jest.fn(),
  listAttachments: jest.fn(),
  listRecentMessages: jest.fn(),
  listHeldRevisions: jest.fn(),
  takeHeldRevision: jest.fn(),
  listIdentityChanged: jest.fn(),
  listBlockedPeers: jest.fn(),
  getBlockedAt: jest.fn(),
  loadProfile: jest.fn(),
  chatsMissingMyProfile: jest.fn(),
  peerHasMyProfile: jest.fn(),
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
  getBlockedMirrorDirty: jest.fn(),
  setBlockedMirrorDirty: jest.fn(),
}));

import type { CallEnvelope, GroupCallEnvelope } from '@tacendum/shared';
import type { AttachmentRow, MessageRow, OutboxRow, ProfileRow } from '../src/db';
import { BlockedPeerError, messaging } from '../src/messaging';
import { BLOCKED_FILE } from '../src/nse';
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

const ME = 'me-user';
const BLOCKED = '01BLOCKEDZ3NDEKTSV4RRFFQ69';
const FRIEND = '01FRIENDZ3NDEKTSV4RRFFQ69G';
const CID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

const OFFER: CallEnvelope = {
  tcm: 'call.offer',
  cid: CID,
  sdp: 'v=0\r\na=fingerprint:sha-256 AA',
  vid: true,
  exp: 4_000_000_000_000,
};
/** A small-group invite: the leg offer plus the session binding. */
const GINVITE: GroupCallEnvelope = {
  tcm: 'call.ginvite',
  sid: '01SESSION0000000000000000',
  cid: CID,
  r: [CID, BLOCKED],
  sdp: 'v=0\r\na=fingerprint:sha-256 AA',
  vid: true,
  exp: 4_000_000_000_000,
};
const ICE: CallEnvelope = {
  tcm: 'call.ice',
  cid: CID,
  c: [{ cand: 'candidate:1 1 udp 1 1.2.3.4 1 typ host', mid: '0', idx: 0 }],
};
const END: CallEnvelope = { tcm: 'call.end', cid: CID, r: 'hangup' };

const MY_PROFILE: ProfileRow = {
  userId: ME,
  registrationId: 1,
  displayName: 'Me',
  about: 'here',
  avatarB64: '',
  profileVersion: 7,
};

/** Long enough for the inbound chain (decrypt → drop → markSeen → ack) and for
 * the download pump, which re-enters itself through .finally(). */
async function flush(turns = 60): Promise<void> {
  for (let i = 0; i < turns; i++) await Promise.resolve();
}

function outboxRow(msgId: string, peerId: string): OutboxRow {
  return {
    msgId,
    peerId,
    msgType: 'ciphertext',
    payload: 'Q0lQSEVS',
    attempts: 0,
    priority: 0,
    urgent: 0,
    notify: 1,
  };
}

function imageBody(att: string): string {
  return JSON.stringify({ tcm: 'image', att, key: 'a2V5', w: 10, h: 20 });
}

function sendFrames(): unknown[] {
  // 'typing' counts as wire the same as 'send': a relay-only frame is still
  // a liveness beacon, and the whole point of this file is that a blocked
  // peer never receives one.
  return ws.calls.send.mock.calls
    .map(c => c[0])
    .filter(f => {
      const t = (f as { type: string }).type;
      return t === 'send' || t === 'typing';
    });
}

function ackedMsgIds(): string[] {
  return ws.calls.send.mock.calls
    .map(c => c[0] as { type: string; msgId: string })
    .filter(f => f.type === 'ack')
    .map(f => f.msgId);
}

/**
 * THE SHARED ASSERTION. Every suppressed path is checked against this: nothing
 * on the wire, no ratchet advance, no prekey of theirs consumed, no outbox row,
 * no blob written to or read from the shared store.
 */
function expectNothingSent(): void {
  expect(sendFrames()).toHaveLength(0);
  expect(crypto.encryptText).not.toHaveBeenCalled();
  expect(api.apiGetPrekeyBundle).not.toHaveBeenCalled();
  expect(crypto.processPreKeyBundle).not.toHaveBeenCalled();
  expect(db.enqueueOutgoing).not.toHaveBeenCalled();
  expect(api.apiCreateAttachment).not.toHaveBeenCalled();
  expect(api.uploadBlob).not.toHaveBeenCalled();
  expect(api.apiGetAttachmentUrl).not.toHaveBeenCalled();
  expect(api.downloadBlob).not.toHaveBeenCalled();
}

/** Deliver one inbound frame whose plaintext is `body`. */
async function deliver(
  from: string,
  msgId: string,
  body: string,
): Promise<void> {
  crypto.decryptEnvelope.mockResolvedValueOnce(body);
  ws.handlers.frame?.({
    type: 'msg',
    from,
    msgId,
    msgType: 'ciphertext',
    payload: 'AAAA',
    ts: 1_700_000_000_000,
  });
  await flush();
}

/** Deliver a frame whose decrypt REJECTS, for the two catch-branch tests. */
async function deliverUndecryptable(
  from: string,
  msgId: string,
  err: Error,
): Promise<void> {
  crypto.decryptEnvelope.mockRejectedValueOnce(err);
  ws.handlers.frame?.({
    type: 'msg',
    from,
    msgId,
    msgType: 'ciphertext',
    payload: 'AAAA',
    ts: 1_700_000_000_000,
  });
  await flush();
}

/** Default db behaviour: an empty phone that accepts every write. */
function resetDb(): void {
  const reads: Array<[string, unknown]> = [
    ['hasSeen', false],
    ['getMessage', null],
    ['listOutbox', []],
    ['listChats', []],
    ['listMessages', []],
    ['listAttachments', []],
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
    ['applyEdit', true],
    ['tombstoneMessage', true],
    ['saveMyProfileCard', MY_PROFILE],
    ['getGroup', null],
  ];
  const writes = [
    'insertMessage',
    'enqueueOutgoing',
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
    'setBlockedMirrorDirty',
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
  ws.calls.send.mockClear();
  ws.calls.start.mockClear();
  ws.calls.stop.mockClear();
  for (const name of Object.keys(api)) api[name]!.mockReset();
  api.apiGetPrekeyBundle!.mockResolvedValue({});
  api.apiCreateAttachment!.mockResolvedValue({
    attachmentId: 'att-new',
    uploadUrl: 'https://blobs/put',
  });
  api.apiGetAttachmentUrl!.mockResolvedValue({
    downloadUrl: 'https://blobs/get',
  });
  api.uploadBlob!.mockResolvedValue(undefined);
  api.downloadBlob!.mockResolvedValue('Y2lwaGVy');
  crypto.encryptText!.mockReset().mockResolvedValue({
    msgType: 'ciphertext',
    payload: 'Q0lQSEVS',
  });
  crypto.decryptEnvelope!.mockReset();
  crypto.processPreKeyBundle!.mockReset().mockResolvedValue(undefined);
  // No session yet, deliberately: with one already pinned, encryptAndEnqueue
  // would skip the prekey fetch anyway and expectNothingSent's "none of their
  // one-time prekeys were consumed" would be vacuous.
  crypto.hasSession!.mockReset().mockResolvedValue(false);
  crypto.blobEncrypt!.mockReset().mockResolvedValue({
    keyB64: 'a2V5',
    blobB64: 'YmxvYg==',
  });
  crypto.blobDecrypt!.mockReset().mockResolvedValue('cGxhaW4=');
  crypto.isIdentityChangeError!.mockReset().mockReturnValue(false);
  crypto.__keychain.clear();
  crypto.__keychain.set('authToken', 'tok');
});

afterEach(() => {
  messaging.stop();
  session.setMode('real');
});

/** Start messaging with `blocked` already on disk, exactly as a relaunch would
 * find it, then forget the setup traffic. */
async function startWithBlocked(blocked: string[] = [BLOCKED]): Promise<void> {
  db.listBlockedPeers!.mockResolvedValue(blocked);
  await messaging.start(ME);
  await flush();
  ws.calls.send.mockClear();
  crypto.encryptText!.mockClear();
  api.apiGetPrekeyBundle!.mockClear();
  api.apiGetAttachmentUrl!.mockClear();
  api.downloadBlob!.mockClear();
  crypto.processPreKeyBundle!.mockClear();
  db.enqueueOutgoing!.mockClear();
  db.markSeen!.mockClear();
  db.putAttachment!.mockClear();
}

// ---------------------------------------------------------------------------
// 1. THE EXHAUSTIVE SWEEP — this single test IS the feature.
// ---------------------------------------------------------------------------

describe('nothing this app can put on the wire reaches a blocked peer', () => {
  /** Every public method that can reach the wire, in one list, so a new
   * outbound path shows up here as an omission rather than as a leak. */
  const WIRE_CAPABLE: Array<{ name: string; run: () => Promise<unknown> }> = [
    { name: 'sendText', run: () => messaging.sendText(BLOCKED, 'hello?') },
    {
      name: 'sendReply',
      run: () => messaging.sendReply(BLOCKED, '01TARGET', 'in', 'hello?'),
    },
    { name: 'sendImage', run: () => messaging.sendImage(BLOCKED, 'aW1n', 4, 4) },
    {
      name: 'sendVoice',
      run: () => messaging.sendVoice(BLOCKED, 'YXVkaW8=', 5),
    },
    {
      name: 'sendFile',
      run: () =>
        messaging.sendFile(BLOCKED, 'ZG9j', 'notes.pdf', 3, 'application/pdf'),
    },
    {
      // Coordinates are the most sensitive payload the app can carry; a
      // blocked peer learning WHERE you are from being ignored would be the
      // worst possible version of the receipt leak below.
      name: 'sendLocation',
      run: () => messaging.sendLocation(BLOCKED, 37.1, -122.2),
    },
    {
      name: 'sendReaction',
      run: () => messaging.sendReaction(BLOCKED, '01TARGET', 'in', '👍'),
    },
    {
      name: 'sendEdit',
      run: () => messaging.sendEdit(BLOCKED, '01TARGET', 'new words'),
    },
    { name: 'sendDelete', run: () => messaging.sendDelete(BLOCKED, '01TARGET') },
    {
      name: 'sendScreenshotNotice',
      run: () => messaging.sendScreenshotNotice(BLOCKED),
    },
    {
      name: 'sendCallEnvelope',
      run: () => messaging.sendCallEnvelope(BLOCKED, OFFER, { urgent: true }),
    },
    {
      // Small-group calls. Its OWN gate, not the 1:1
      // one: `call.g*` is a separate union with a separate encoder and a
      // separate send method, so the block check had to be repeated — and a
      // repeated check is a check that can be forgotten. This case is what
      // notices. A ginvite is an OFFER: reaching a blocked peer with one
      // would open a media session to someone this phone was told to be
      // silent towards.
      name: 'sendGroupCallEnvelope',
      run: () => messaging.sendGroupCallEnvelope(BLOCKED, GINVITE, { urgent: true }),
    },
    {
      // A receipt proves the device is live, in use, and that someone opened
      // the thread — which is more than a blocked person should learn from
      // being ignored.
      name: 'sendReadReceipt',
      run: () => messaging.sendReadReceipt(BLOCKED),
    },
    {
      // Typing is the sharpest liveness beacon of all: it proves the phone
      // is unlocked, in this conversation, composing, right now. The typingState gate refuses; surfaceless return.
      name: 'sendTypingState',
      run: () => messaging.sendTypingState(BLOCKED, 'start'),
    },
    {
      // The room form: a roster holding the blocked peer makes the room
      // read-only (roomComposeGates), and typing must be exactly as
      // permissive as a room message — every leg refused, not just theirs.
      name: 'sendRoomTypingState',
      run: () => {
        db.getGroup!.mockResolvedValue({
          groupId: CID,
          ownerId: ME,
          name: 'Kitchen',
        });
        db.listGroupMemberSlots!.mockResolvedValue([
          { memberId: ME, writerId: ME, seq: 1, state: 'in' },
          { memberId: BLOCKED, writerId: ME, seq: 2, state: 'in' },
          { memberId: FRIEND, writerId: ME, seq: 3, state: 'in' },
        ]);
        return messaging.sendRoomTypingState(CID, 'start');
      },
    },
    {
      // The typed-carrier path (sync + peer notices): gated at its own
      // top, BEFORE any prekey fetch — the roster-keyed auto-extension
      // means individual device ULIDs are blockable too.
      name: 'sendBareCarrier',
      run: () =>
        (
          messaging as unknown as {
            sendBareCarrier(
              to: string,
              plaintext: string,
              opts: { sibling: boolean },
            ): Promise<void>;
          }
        ).sendBareCarrier(BLOCKED, '{"tcm":"x.acct.sync","k":"read","d":{}}', {
          sibling: false,
        }),
    },
    {
      // The sibling fan-of-one: a BLOCKED id sitting in the own-device
      // roster (hostile state, but the gate must not care why) still gets
      // nothing — every leg rides sendBareCarrier's choke point.
      name: 'sendSyncToSiblings',
      run: async () => {
        // Scoped, then RESTORED: the hostile roster belongs to THIS case
        // alone — a leaked implementation would silently re-route every
        // later test's sends through the device fan-out.
        db.listLinkedDevices!.mockImplementation(async () => [
          {
            userId: BLOCKED,
            class: 'tablet',
            state: 'linked',
            updatedAt: 1,
            certsJson: '',
          },
        ]);
        try {
          await messaging.syncThreadRead(FRIEND);
        } finally {
          db.listLinkedDevices!.mockImplementation(async () => []);
        }
      },
    },
    {
      name: 'saveProfile (broadcast)',
      run: () =>
        messaging.saveProfile({
          displayName: 'Me',
          about: 'here',
          avatarB64: 'YXZhdGFy',
        }),
    },
  ];

  test.each(WIRE_CAPABLE.map(c => [c.name, c] as const))(
    '%s sends a blocked peer nothing at all',
    async (_name, entry) => {
      db.loadProfile!.mockResolvedValue(MY_PROFILE);
      db.chatsMissingMyProfile!.mockResolvedValue([BLOCKED]);
      await startWithBlocked();

      await entry.run().catch((err: unknown) => {
        // The composed-message paths throw; the surfaceless ones return. Both
        // are acceptable here — what is not acceptable is a frame.
        expect((err as Error).name).toBe('BlockedPeerError');
      });
      await flush();

      expectNothingSent();
    },
  );

  test('the sweep covers every wire-capable method on the service', () => {
    // A new send* method that nobody added to WIRE_CAPABLE fails here, which is
    // the point: the list above is only exhaustive if something says so.
    const onWire = Object.getOwnPropertyNames(
      Object.getPrototypeOf(messaging) as object,
    ).filter(n => /^send[A-Z]/.test(n) || n === 'saveProfile');
    const covered = new Set([
      'sendText',
      'sendReply',
      'sendImage',
      'sendVoice',
      'sendFile',
      'sendLocation',
      'sendReaction',
      'sendEdit',
      'sendDelete',
      'sendScreenshotNotice',
      'sendReadReceipt',
      'sendTypingState',
      'sendRoomTypingState',
      'sendCallEnvelope',
      'sendGroupCallEnvelope',
      'sendBareCarrier',
      'sendSyncToSiblings',
      'saveProfile',
    ]);
    expect(onWire.filter(n => !covered.has(n))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2-11. Outbound, one path at a time.
// ---------------------------------------------------------------------------

describe('outbound suppression, path by path', () => {
  beforeEach(async () => {
    await startWithBlocked();
  });

  test('sendText rejects with BlockedPeerError and writes no message row', async () => {
    await expect(messaging.sendText(BLOCKED, 'are you there')).rejects.toThrow(
      BlockedPeerError,
    );
    expect(db.insertMessage).not.toHaveBeenCalled();
    expect(db.touchChat).not.toHaveBeenCalled();
    expectNothingSent();
  });

  test('sendText to a blocked peer never produces the identity-change error', async () => {
    // Block outranks identity-changed everywhere: a blocked peer must never be
    // able to make this app say "safety number changed", which is a sentence
    // about THEIR key and an invitation to accept and send.
    const thrown: unknown = await messaging.sendText(BLOCKED, 'hi').then(
      () => null,
      (e: unknown) => e,
    );
    expect((thrown as Error).name).toBe('BlockedPeerError');
    expect((thrown as Error).message).not.toMatch(/safety number/i);
  });

  test('sendReply rejects and writes no row', async () => {
    await expect(
      messaging.sendReply(BLOCKED, '01TARGET', 'in', 'about that'),
    ).rejects.toThrow(BlockedPeerError);
    expect(db.insertMessage).not.toHaveBeenCalled();
    expectNothingSent();
  });

  test('sendImage rejects BEFORE the blob is encrypted or uploaded', async () => {
    // The gate has to be the first statement: blobEncrypt + apiCreateAttachment
    // + uploadBlob all run before the envelope exists, and a ciphertext blob
    // sitting in the shared store is itself the beacon.
    await expect(messaging.sendImage(BLOCKED, 'aW1n', 8, 8)).rejects.toThrow(
      BlockedPeerError,
    );
    expect(crypto.blobEncrypt).not.toHaveBeenCalled();
    expect(api.apiCreateAttachment).not.toHaveBeenCalled();
    expect(api.uploadBlob).not.toHaveBeenCalled();
    expect(db.putAttachment).not.toHaveBeenCalled();
    expectNothingSent();
  });

  test('sendReaction resolves silently and writes no chip', async () => {
    await expect(
      messaging.sendReaction(BLOCKED, '01TARGET', 'in', '👍'),
    ).resolves.toBeUndefined();
    expect(db.setReaction).not.toHaveBeenCalled();
    expectNothingSent();
  });

  test('sendEdit resolves silently — no carrier and no local rewrite', async () => {
    await expect(
      messaging.sendEdit(BLOCKED, '01TARGET', 'new words'),
    ).resolves.toBeUndefined();
    expect(db.applyEdit).not.toHaveBeenCalled();
    expect(db.getMessage).not.toHaveBeenCalled();
    expectNothingSent();
  });

  test('sendDelete resolves silently — no carrier, no tombstone, no outbox touch', async () => {
    await expect(
      messaging.sendDelete(BLOCKED, '01TARGET'),
    ).resolves.toBeUndefined();
    expect(db.tombstoneMessage).not.toHaveBeenCalled();
    expect(db.deleteOutboxEnvelope).not.toHaveBeenCalled();
    expectNothingSent();
  });

  test('sendScreenshotNotice sends nothing and writes no local row', async () => {
    // App.tsx calls this unconditionally from the screenshot listener, so this
    // gate cannot live in the UI. Screenshotting a harasser's thread to gather
    // evidence is exactly the act that would otherwise transmit liveness.
    await expect(
      messaging.sendScreenshotNotice(BLOCKED),
    ).resolves.toBeUndefined();
    expect(db.insertMessage).not.toHaveBeenCalled();
    expectNothingSent();
  });

  test('sendScreenshotNotice is equally silent in a duress session', async () => {
    // The duress branch writes a local decoy row; the gate is above it, so a
    // block recorded in the decoy workspace suppresses that too.
    messaging.stop();
    db.listBlockedPeers!.mockResolvedValue([BLOCKED]);
    await messaging.start(ME);
    await flush();
    session.setMode('duress');
    await expect(
      messaging.sendScreenshotNotice(BLOCKED),
    ).resolves.toBeUndefined();
    expect(db.insertMessage).not.toHaveBeenCalled();
    expect(sendFrames()).toHaveLength(0);
  });

  test.each([
    ['offer', OFFER],
    ['ice', ICE],
    ['end', END],
  ])(
    'sendCallEnvelope rejects a call %s and puts no frame on the wire',
    async (_kind, envelope) => {
      // A blocked person must never be able to make this phone ring, and this
      // phone must never ring theirs by accident.
      await expect(
        messaging.sendCallEnvelope(BLOCKED, envelope as CallEnvelope, {
          urgent: true,
        }),
      ).rejects.toThrow(BlockedPeerError);
      expectNothingSent();
    },
  );

  test('saveProfile shares the card with the unblocked peer only', async () => {
    db.loadProfile!.mockResolvedValue(MY_PROFILE);
    db.chatsMissingMyProfile!.mockResolvedValue([BLOCKED, FRIEND]);

    await messaging.saveProfile({
      displayName: 'Me',
      about: 'here',
      avatarB64: '',
    });
    await flush();

    expect(db.enqueueOutgoing).toHaveBeenCalledTimes(1);
    expect(
      (db.enqueueOutgoing!.mock.calls[0]![0] as MessageRow).peerId,
    ).toBe(FRIEND);
    // Never recorded as holding this version: a false record would mean they
    // never receive it after an unblock either.
    expect(db.markMyProfileSent).not.toHaveBeenCalledWith(
      BLOCKED,
      expect.anything(),
    );
    expect(db.markMyProfileSent).toHaveBeenCalledWith(
      FRIEND,
      MY_PROFILE.profileVersion,
    );
  });

  test('THE CHOKE POINT: a block taken mid-upload still stops the envelope', async () => {
    // The entry gates are checked once, at entry — and sendImage then awaits
    // blobEncrypt, apiCreateAttachment and uploadBlob before the envelope
    // exists. A block that lands inside that window has to be caught by
    // encryptAndEnqueue itself, which is why the guard is its first statement
    // rather than something the callers are trusted to have done.
    messaging.stop();
    await startWithBlocked([]);
    let release: (() => void) | null = null;
    api.uploadBlob!.mockImplementation(
      async () =>
        new Promise<void>(resolve => {
          release = resolve;
        }),
    );

    const sending = messaging.sendImage(FRIEND, 'aW1n', 4, 4);
    await flush();
    expect(release).not.toBeNull();

    await messaging.blockPeer(FRIEND);
    release!();

    await expect(sending).rejects.toThrow(BlockedPeerError);
    // The blob was already in the store before the block existed — that is
    // accepted. What must not happen is the pointer envelope reaching them.
    expect(crypto.encryptText).not.toHaveBeenCalled();
    expect(db.enqueueOutgoing).not.toHaveBeenCalled();
    expect(db.touchChat).not.toHaveBeenCalled();
    expect(sendFrames()).toHaveLength(0);
  });

  test('CONTROL: blocking one person does not mute the app', async () => {
    // Without this, every assertion above could be satisfied by an app that
    // simply stopped sending.
    db.listOutbox!.mockResolvedValue([outboxRow('01OUT', FRIEND)]);
    await messaging.sendText(FRIEND, 'still here');
    await flush();

    expect(crypto.encryptText).toHaveBeenCalledWith(ME, FRIEND, 'still here');
    expect(db.enqueueOutgoing).toHaveBeenCalled();
    expect(sendFrames()).toEqual([
      expect.objectContaining({ type: 'send', to: FRIEND }),
    ]);
  });
});

// ---------------------------------------------------------------------------
// 12. The outbox.
// ---------------------------------------------------------------------------

describe('the outbox never flushes to a blocked peer', () => {
  test('a queued envelope for a blocked peer is dropped, not parked, while a friend’s is sent', async () => {
    await startWithBlocked();
    db.listOutbox!.mockResolvedValue([
      outboxRow('01BLOCKEDROW', BLOCKED),
      outboxRow('01FRIENDROW', FRIEND),
    ]);

    ws.handlers.state?.('open');
    await flush();

    // Dropped rather than parked: parking means unblocking delivers a burst of
    // stale messages, which is a tell of its own.
    expect(sendFrames()).toEqual([
      expect.objectContaining({ type: 'send', msgId: '01FRIENDROW' }),
    ]);
    expect(db.markOutgoingError).toHaveBeenCalledWith('01BLOCKEDROW');
    expect(db.deleteOutboxEnvelope).toHaveBeenCalledWith('01BLOCKEDROW');
    expect(db.markOutgoingError).not.toHaveBeenCalledWith('01FRIENDROW');
  });
});

// ---------------------------------------------------------------------------
// 13-19. Inbound: decrypt, then drop.
// ---------------------------------------------------------------------------

describe('inbound from a blocked peer is decrypted, then dropped', () => {
  beforeEach(async () => {
    await startWithBlocked();
  });

  test('the ratchet still advances, nothing is persisted, and the frame is acked', async () => {
    const seen = jest.fn();
    const off = messaging.subscribe(seen);

    await deliver(BLOCKED, '01IN1', 'are you ignoring me');

    // POSITIVE assertion: refusing to decrypt would desync the Double Ratchet
    // and leave the session broken if they are ever unblocked.
    expect(crypto.decryptEnvelope).toHaveBeenCalledTimes(1);
    expect(db.insertMessage).not.toHaveBeenCalled();
    expect(db.upsertChat).not.toHaveBeenCalled();
    expect(db.touchChat).not.toHaveBeenCalled();
    // A re-render is a behavioural difference too — and would resurface the row.
    expect(seen).not.toHaveBeenCalled();
    expect(db.markSeen).toHaveBeenCalledWith('01IN1', expect.any(Number));
    // The ack goes to the SERVER, never to them; not acking would be the
    // observable difference (and a growing backlog).
    expect(ackedMsgIds()).toEqual(['01IN1']);
    off();
  });

  test('REQUIREMENT 4: an image from a blocked peer is never fetched', async () => {
    await deliver(BLOCKED, '01IN2', imageBody('att-theirs'));

    // A blob fetch is a read receipt through a side channel: it proves to
    // anyone watching the blob store that this phone parsed their message.
    expect(api.apiGetAttachmentUrl).not.toHaveBeenCalled();
    expect(api.downloadBlob).not.toHaveBeenCalled();
    expect(db.putAttachment).not.toHaveBeenCalled();
    expect(ackedMsgIds()).toEqual(['01IN2']);
  });

  test('a profile card from a blocked peer is not applied and its avatar is not fetched', async () => {
    await deliver(
      BLOCKED,
      '01IN3',
      JSON.stringify({
        tcm: 'profile',
        n: 'New Name',
        a: 'about',
        att: 'att-avatar',
        key: 'a2V5',
        v: Date.now(),
      }),
    );

    expect(db.applyPeerProfile).not.toHaveBeenCalled();
    expect(db.setPeerAvatar).not.toHaveBeenCalled();
    expect(api.apiGetAttachmentUrl).not.toHaveBeenCalled();
    expect(api.downloadBlob).not.toHaveBeenCalled();
    expect(ackedMsgIds()).toEqual(['01IN3']);
  });

  test('a blocked peer cannot rewrite, retract or react to what is already here', async () => {
    // A genuine security property, not a side effect of dropping their traffic.
    await deliver(
      BLOCKED,
      '01IN4',
      JSON.stringify({ tcm: 'edit', ref: '01TARGET', text: 'no I did not' }),
    );
    await deliver(
      BLOCKED,
      '01IN5',
      JSON.stringify({ tcm: 'del', ref: '01TARGET' }),
    );
    await deliver(
      BLOCKED,
      '01IN6',
      JSON.stringify({ tcm: 'react', ref: '01TARGET', ofs: false, emoji: '👍' }),
    );

    expect(db.applyEdit).not.toHaveBeenCalled();
    expect(db.tombstoneMessage).not.toHaveBeenCalled();
    expect(db.setReaction).not.toHaveBeenCalled();
    expect(db.holdRevision).not.toHaveBeenCalled();
    expect(ackedMsgIds()).toEqual(['01IN4', '01IN5', '01IN6']);
  });

  test('a call from a blocked peer never reaches a subscriber — the phone does not ring', async () => {
    const heard = jest.fn();
    const off = messaging.onEnvelope(heard);

    await deliver(BLOCKED, '01IN7', JSON.stringify(OFFER));

    expect(heard).not.toHaveBeenCalled();
    expect(ackedMsgIds()).toEqual(['01IN7']);
    off();
  });

  test('an identity change from a blocked peer paints no banner and still acks', async () => {
    const seen = jest.fn();
    const off = messaging.subscribe(seen);
    crypto.isIdentityChangeError!.mockReturnValue(true);

    await deliverUndecryptable(BLOCKED, '01IN8', new Error('identity_changed'));

    // Otherwise blocking someone whose key changed resurrects their row with a
    // red banner on it — and leaves their ciphertext queued on the server
    // forever, which is a growing, externally visible backlog.
    expect(db.setIdentityChanged).not.toHaveBeenCalled();
    expect(db.upsertChat).not.toHaveBeenCalled();
    expect(seen).not.toHaveBeenCalled();
    expect(messaging.isPeerBlocked(BLOCKED)).toBe(false);
    expect(ackedMsgIds()).toEqual(['01IN8']);
    off();
  });

  test('a tampered frame from a blocked peer inserts no error row and still acks', async () => {
    await deliverUndecryptable(BLOCKED, '01IN9', new Error('bad mac'));

    expect(db.insertMessage).not.toHaveBeenCalled();
    expect(db.upsertChat).not.toHaveBeenCalled();
    expect(ackedMsgIds()).toEqual(['01IN9']);
  });

  test('CONTROL: the same traffic from an unblocked peer lands normally', async () => {
    await deliver(FRIEND, '01IN10', 'hello');
    expect(db.insertMessage).toHaveBeenCalledTimes(1);
    expect(db.touchChat).toHaveBeenCalled();
    expect(ackedMsgIds()).toEqual(['01IN10']);
  });
});

// ---------------------------------------------------------------------------
// 20-22. Fetches that are not triggered by a live frame.
// ---------------------------------------------------------------------------

describe('no fetch a blocked peer can trigger, however delayed', () => {
  test('retryAttachment performs no fetch for a blocked peer', async () => {
    // Reached from PhotoViewerScreen, which this feature may not edit — so the
    // gate has to live in messaging.
    await startWithBlocked();
    db.getMessage!.mockResolvedValue({
      msgId: '01PHOTO',
      peerId: BLOCKED,
      direction: 'in',
      body: imageBody('att-theirs'),
      ts: 1,
      status: 'received',
    } satisfies MessageRow);

    await messaging.retryAttachment('01PHOTO', 'in', imageBody('att-theirs'));
    await flush();

    expect(api.apiGetAttachmentUrl).not.toHaveBeenCalled();
    expect(api.downloadBlob).not.toHaveBeenCalled();
    expect(db.putAttachment).not.toHaveBeenCalled();
  });

  test('retryAttachment still works for an unblocked peer', async () => {
    await startWithBlocked();
    db.getMessage!.mockResolvedValue({
      msgId: '01PHOTO',
      peerId: FRIEND,
      direction: 'in',
      body: imageBody('att-friend'),
      ts: 1,
      status: 'received',
    } satisfies MessageRow);

    await messaging.retryAttachment('01PHOTO', 'in', imageBody('att-friend'));
    await flush();

    expect(api.apiGetAttachmentUrl).toHaveBeenCalledWith('tok', 'att-friend');
  });

  test('boot-time reconcile re-downloads for a friend and never for a blocked peer', async () => {
    // The sneakiest fetch of all: a photo pointer from before the block would
    // otherwise hit the blob store on every single launch, forever.
    db.listChats!.mockResolvedValue([
      { peerId: BLOCKED },
      { peerId: FRIEND },
    ] as never);
    db.listMessages!.mockImplementation(async (peerId: string) => [
      {
        msgId: peerId === BLOCKED ? '01OLDB' : '01OLDF',
        peerId,
        direction: 'in',
        body: imageBody(peerId === BLOCKED ? 'att-blocked' : 'att-friend'),
        ts: 1,
        status: 'received',
      } satisfies MessageRow,
    ]);
    db.listAttachments!.mockResolvedValue([] as AttachmentRow[]);

    db.listBlockedPeers!.mockResolvedValue([BLOCKED]);
    await messaging.start(ME);
    await flush();

    const fetched = api.apiGetAttachmentUrl!.mock.calls.map(c => c[1]);
    expect(fetched).toContain('att-friend');
    expect(fetched).not.toContain('att-blocked');
  });

  test('a download already queued when the block lands never reaches the network', async () => {
    // THE ASYNC-CONTINUATION CASE. A check at function entry does not hold
    // across an await, and pumpDownloads drains this queue long after the frame
    // that filled it was handled — so fetchAttachment re-checks before its
    // first network call, exactly like the stale(gen) re-checks in that file.
    await startWithBlocked([]);
    const held: Array<() => void> = [];
    api.apiGetAttachmentUrl!.mockImplementation(
      async (_token: string, att: string) => {
        if (att !== 'att-third') {
          await new Promise<void>(resolve => held.push(resolve));
        }
        return { downloadUrl: 'https://blobs/get' };
      },
    );

    // Two saturate MAX_CONCURRENT_DOWNLOADS; the third waits in the queue.
    await deliver(FRIEND, '01Q1', imageBody('att-first'));
    await deliver(FRIEND, '01Q2', imageBody('att-second'));
    await deliver(FRIEND, '01Q3', imageBody('att-third'));
    expect(api.apiGetAttachmentUrl).toHaveBeenCalledTimes(2);

    await messaging.blockPeer(FRIEND);
    for (const release of held) release();
    await flush(120);

    expect(api.apiGetAttachmentUrl!.mock.calls.map(c => c[1])).not.toContain(
      'att-third',
    );
    // Left 'pending', never moved to 'failed': a state change is a visible
    // difference, and unblocking re-runs reconcile to resume it.
    expect(db.putAttachment).not.toHaveBeenCalledWith(
      '01Q3',
      'in',
      'failed',
    );
  });

  test('an avatar download already queued when the block lands never reaches the network', async () => {
    // The same continuation problem for the other blob kind, and the only
    // route by which a blocked peer's avatar job can exist at all: they send a
    // card, then they are blocked before the bounded queue gets to it.
    await startWithBlocked([]);
    const held: Array<() => void> = [];
    api.apiGetAttachmentUrl!.mockImplementation(
      async (_token: string, att: string) => {
        if (att !== 'att-avatar') {
          await new Promise<void>(resolve => held.push(resolve));
        }
        return { downloadUrl: 'https://blobs/get' };
      },
    );

    await deliver(FRIEND, '01V1', imageBody('att-hold-1'));
    await deliver(FRIEND, '01V2', imageBody('att-hold-2'));
    await deliver(
      FRIEND,
      '01V3',
      JSON.stringify({
        tcm: 'profile',
        n: 'Their Name',
        a: 'about',
        att: 'att-avatar',
        key: 'a2V5',
        v: Date.now(),
      }),
    );
    expect(api.apiGetAttachmentUrl).toHaveBeenCalledTimes(2);

    await messaging.blockPeer(FRIEND);
    for (const release of held) release();
    await flush(120);

    expect(api.apiGetAttachmentUrl!.mock.calls.map(c => c[1])).not.toContain(
      'att-avatar',
    );
    expect(db.setPeerAvatar).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 23-25. Lifecycle: seeding, failure, unblock.
// ---------------------------------------------------------------------------

describe('lifecycle', () => {
  test('start() seeds the block set from disk BEFORE the socket opens', async () => {
    // The window between opening the socket and reading the table is a window
    // in which a beacon slips out.
    db.listBlockedPeers!.mockResolvedValue([BLOCKED]);
    await messaging.start(ME);
    await flush();

    expect(db.listBlockedPeers).toHaveBeenCalled();
    expect(ws.calls.start).toHaveBeenCalled();
    expect(db.listBlockedPeers!.mock.invocationCallOrder[0]!).toBeLessThan(
      ws.calls.start.mock.invocationCallOrder[0]!,
    );
    expect(messaging.isBlockedLocally(BLOCKED)).toBe(true);
  });

  test('a pre-migration database that cannot list blocks does not fail boot', async () => {
    db.listBlockedPeers!.mockRejectedValue(new Error('no such table'));
    await expect(messaging.start(ME)).resolves.toBeUndefined();
    expect(ws.calls.start).toHaveBeenCalled();
  });

  test('a failing listIdentityChanged does not skip the block seed', async () => {
    // Separate try/catch blocks: a failure in the less serious feature must not
    // silently disable this one.
    db.listIdentityChanged!.mockRejectedValue(new Error('no such table'));
    db.listBlockedPeers!.mockResolvedValue([BLOCKED]);
    await messaging.start(ME);
    expect(messaging.isBlockedLocally(BLOCKED)).toBe(true);
  });

  test('a block whose durable write fails is not enforced in memory either', async () => {
    // The UI says "Tacendum couldn’t save that", and that has to be true: a
    // block that looks enforced for this launch and lapses on the next one is
    // worse than a visible failure.
    await startWithBlocked([]);
    db.blockPeer!.mockRejectedValue(new Error('disk full'));

    await expect(messaging.blockPeer(FRIEND)).rejects.toThrow('disk full');
    expect(messaging.isBlockedLocally(FRIEND)).toBe(false);
    await expect(messaging.sendText(FRIEND, 'hi')).resolves.toBeUndefined();
  });

  test('blockPeer records the block and stops the very next send', async () => {
    await startWithBlocked([]);
    await messaging.blockPeer(FRIEND);

    expect(db.blockPeer).toHaveBeenCalledWith(FRIEND, expect.any(Number));
    expect(messaging.isBlockedLocally(FRIEND)).toBe(true);
    // isPeerBlocked is the identity-change flag and must be untouched by this.
    expect(messaging.isPeerBlocked(FRIEND)).toBe(false);
    await expect(messaging.sendText(FRIEND, 'hi')).rejects.toThrow(
      BlockedPeerError,
    );
  });

  // Blocking committed the DB and fire-and-forgot the mirror the
  // notification extension reads, swallowing every write failure. Both native
  // readers fail OPEN on a missing/stale mirror, so a shared-container or
  // disk-full failure left a peer blocked in-app but still able to ring the
  // lock screen and raise banners — while the UI reported plain success.
  describe('a block whose NOTIFICATION MIRROR cannot be written', () => {
    // The shared jest.fn is process-wide within this file; restore a
    // non-throwing default after each case so a throwing impl never leaks.
    afterEach(() => {
      crypto.writeSharedState!.mockReset().mockImplementation(async () => undefined);
    });

    test('is enforced in-app, is surfaced as partial, and persists a dirty marker', async () => {
      await startWithBlocked([]);
      // The App Group container is unwritable; the app-private DB is not.
      crypto.writeSharedState!.mockImplementation(async (name: string) => {
        if (name === BLOCKED_FILE) throw new Error('shared container full');
      });

      await messaging.blockPeer(FRIEND);

      // Surfaced, not swallowed: the UI can read that suppression has not yet
      // reached the extension.
      expect(messaging.isBlockNotificationMirrorStale()).toBe(true);
      // A durable marker, written to the app-private DB — never the shared
      // container that just failed — so partial enforcement survives relaunch.
      expect(db.setBlockedMirrorDirty).toHaveBeenCalledWith(true);
      // The DB block is NEVER rolled back: it IS enforced in-app.
      expect(messaging.isBlockedLocally(FRIEND)).toBe(true);
      await expect(messaging.sendText(FRIEND, 'hi')).rejects.toThrow(
        BlockedPeerError,
      );
    });

    test('a mirror that DOES commit reports full suppression and never marks dirty', async () => {
      await startWithBlocked([]);
      crypto.writeSharedState!.mockImplementation(async () => undefined);
      db.setBlockedMirrorDirty!.mockClear();

      await messaging.blockPeer(FRIEND);

      expect(messaging.isBlockNotificationMirrorStale()).toBe(false);
      // Already clean, still clean — nothing to persist (a healthy block must
      // not thrash the marker).
      expect(db.setBlockedMirrorDirty).not.toHaveBeenCalledWith(true);
    });

    test('a later session whose container recovers clears the dirty marker', async () => {
      await startWithBlocked([]);
      crypto.writeSharedState!.mockImplementation(async (name: string) => {
        if (name === BLOCKED_FILE) throw new Error('shared container full');
      });
      await messaging.blockPeer(FRIEND);
      expect(db.setBlockedMirrorDirty).toHaveBeenCalledWith(true);

      // The container recovers; the next session seeds the persisted dirty
      // marker, re-publishes from the DB truth (listBlockedPeers), and clears
      // it once the write lands.
      messaging.stop();
      crypto.writeSharedState!.mockReset().mockImplementation(async () => undefined);
      db.setBlockedMirrorDirty!.mockClear();
      db.getBlockedMirrorDirty!.mockResolvedValue(true);
      db.listBlockedPeers!.mockResolvedValue([FRIEND]);
      await messaging.start(ME);
      await flush();

      expect(db.setBlockedMirrorDirty).toHaveBeenCalledWith(false);
      expect(messaging.isBlockNotificationMirrorStale()).toBe(false);
    });

    // The UNBLOCK direction. blockPeer awaits the
    // reconcile; unblockPeer fired it and forgot, so the promise resolved
    // while the extension's mirror still SUPPRESSED the person's calls and
    // banners, every screen read a clean flag and announced ordinary success,
    // and only a later relaunch would have told the truth.
    test('an UNBLOCK whose mirror cannot be written resolves already knowing it', async () => {
      await startWithBlocked([FRIEND]);
      crypto.writeSharedState!.mockImplementation(async (name: string) => {
        if (name === BLOCKED_FILE) throw new Error('shared container full');
      });
      db.setBlockedMirrorDirty!.mockClear();

      await messaging.unblockPeer(FRIEND);

      // The resolve is the read point every screen uses; it must already hold.
      expect(messaging.isBlockNotificationMirrorStale()).toBe(true);
      // Durable, so the warning survives a relaunch exactly as a block's does.
      expect(db.setBlockedMirrorDirty).toHaveBeenCalledWith(true);
      // The DB unblock is NEVER rolled back: in-app delivery is restored.
      expect(messaging.isBlockedLocally(FRIEND)).toBe(false);
    });

    test('the flip is published to subscribers, not merely readable', async () => {
      // A screen renders what notify() tells it to re-read. A reconcile that
      // flips the flag after every notify already fired leaves an open screen
      // announcing a mirror state the flag no longer holds.
      await startWithBlocked([FRIEND]);
      crypto.writeSharedState!.mockImplementation(async (name: string) => {
        if (name === BLOCKED_FILE) throw new Error('shared container full');
      });

      const seen: boolean[] = [];
      const off = messaging.subscribe(() =>
        seen.push(messaging.isBlockNotificationMirrorStale()),
      );
      await messaging.unblockPeer(FRIEND);
      off();

      expect(seen).toContain(true);
    });

    test('the boot-time retry that CLEARS the flag is published too', async () => {
      // The recovery direction: a session opens onto a dirty marker, the
      // container has healed, start()'s re-publish clears the flag — and the
      // chat list already on screen must lose its warning without waiting for
      // an unrelated message to poke it. The mirror write is HELD OPEN until
      // every other boot notify has fired, so the only notify that can carry
      // the cleared flag is the reconcile's own — the publish under test,
      // not a neighbour's coincidence.
      db.getBlockedMirrorDirty!.mockResolvedValue(true);
      db.listBlockedPeers!.mockResolvedValue([FRIEND]);
      let releaseWrite!: () => void;
      const held = new Promise<void>(r => {
        releaseWrite = r;
      });
      crypto.writeSharedState!.mockImplementation(async (name: string) => {
        if (name === BLOCKED_FILE) await held;
      });

      const seen: boolean[] = [];
      const off = messaging.subscribe(() =>
        seen.push(messaging.isBlockNotificationMirrorStale()),
      );
      await messaging.start(ME);
      await flush();
      // Everything else start() will ever notify for has notified; the flag
      // still reads dirty everywhere.
      expect(seen).not.toContain(false);

      releaseWrite();
      await flush();
      off();

      expect(seen).toContain(false);
    });
  });

  test('blocking mid-flight prunes inflight, so the retry timer dies instead of re-arming forever', async () => {
    // db.blockPeer purges the peer's outbox rows by peerId, but `inflight` is
    // keyed by msgId — before pruneInflight, the stranded entry kept
    // scheduleRetry re-arming a do-nothing flush every RECEIPT_TIMEOUT_MS for
    // the rest of the socket's life.
    jest.useFakeTimers();
    try {
      await startWithBlocked([]);
      db.listOutbox!.mockResolvedValue([outboxRow('01STUCK', FRIEND)]);
      await messaging.sendText(FRIEND, 'anyone home?');
      await flush(); // sent; the receipt never arrives, so 01STUCK stays in flight

      // The block's transaction erases the row; only the map entry remains.
      db.listOutbox!.mockResolvedValue([]);
      await messaging.blockPeer(FRIEND);
      await flush();

      // The timer armed before the block is allowed its one last firing…
      db.listOutbox!.mockClear();
      await jest.advanceTimersByTimeAsync(15_000); // RECEIPT_TIMEOUT_MS
      await flush();
      const afterFirstFiring = db.listOutbox!.mock.calls.length;

      // …but with inflight pruned it must not re-arm: more periods, no polls.
      await jest.advanceTimersByTimeAsync(15_000 * 5);
      await flush();
      expect(db.listOutbox!.mock.calls.length).toBe(afterFirstFiring);
    } finally {
      jest.useRealTimers();
    }
  });

  test('UNBLOCK RESTORES: sending works again, and what arrived while blocked is gone', async () => {
    await startWithBlocked();
    await deliver(BLOCKED, '01GONE', 'you will never see this');
    expect(db.insertMessage).not.toHaveBeenCalled();

    await messaging.unblockPeer(BLOCKED);
    await flush();
    expect(db.unblockPeer).toHaveBeenCalledWith(BLOCKED);
    expect(messaging.isBlockedLocally(BLOCKED)).toBe(false);

    db.listOutbox!.mockResolvedValue([outboxRow('01AFTER', BLOCKED)]);
    await messaging.sendText(BLOCKED, 'ok, talking again');
    await flush();

    expect(crypto.encryptText).toHaveBeenCalledWith(
      ME,
      BLOCKED,
      'ok, talking again',
    );
    expect(sendFrames()).toEqual([
      expect.objectContaining({ type: 'send', to: BLOCKED }),
    ]);
    // The dropped message was never queued locally, so nothing brings it back.
    expect(
      db.insertMessage!.mock.calls.filter(
        c => (c[0] as MessageRow).msgId === '01GONE',
      ),
    ).toHaveLength(0);
  });

  test('stop() clears the set so the next workspace re-seeds its own', async () => {
    // A duress session must never inherit the real session's list, and vice
    // versa.
    await startWithBlocked();
    expect(messaging.isBlockedLocally(BLOCKED)).toBe(true);
    messaging.stop();
    expect(messaging.isBlockedLocally(BLOCKED)).toBe(false);
  });
});
