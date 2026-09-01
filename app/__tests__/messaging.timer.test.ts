/**
 * DISAPPEARING MESSAGES.
 *
 * A shared, versioned timer carried inside the ratchet — no server change,
 * because the server already TTLs queued ciphertext and never holds plaintext.
 * The properties worth testing are the ones a careless implementation gets
 * wrong: a timer frame is a SETTING (no row, no unread), an older frame can
 * never undo a newer one, an inbound message starts its clock when it is READ
 * rather than when it arrives, and a blocked peer gets no timer frame at all.
 *
 * Harness copied from messaging.blocking.test.ts — same mocked ./db and ./ws.
 *
 * ORIGINAL HEADER of the harness follows:
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
  // disappearing messages
  setDisappearTimer: jest.fn(async () => true),
  armExpiry: jest.fn(),
  sweepExpired: jest.fn(async () => 0),
  getChat: jest.fn(async () => undefined),
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
}));

import type { ProfileRow } from '../src/db';
import { BlockedPeerError, messaging } from '../src/messaging';
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





/**
 * THE SHARED ASSERTION. Every suppressed path is checked against this: nothing
 * on the wire, no ratchet advance, no prekey of theirs consumed, no outbox row,
 * no blob written to or read from the shared store.
 */

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
    ['loadProfile', null],
    ['chatsMissingMyProfile', []],
    ['peerHasMyProfile', false],
    ['applyEdit', true],
    ['tombstoneMessage', true],
    ['saveMyProfileCard', MY_PROFILE],
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

// ---------------------------------------------------------------------------
// 1. THE EXHAUSTIVE SWEEP — this single test IS the feature.
// ---------------------------------------------------------------------------

/** A version stamp just behind now: the handler refuses anything dated far
 * ahead (a frame from the future would win forever), so a fixed far-future
 * constant here would be testing the guard, not the path. */
const V = Date.now() - 60_000;

/** The timer envelope as a peer would send it. */
function timerFrame(seconds: number, version: number): string {
  return JSON.stringify({ tcm: 'timer', s: seconds, v: version });
}

async function start(): Promise<void> {
  db.listBlockedPeers!.mockResolvedValue([]);
  // Device-set reads: an EMPTY world, so the
  // single-leg wire this suite pins stays byte-for-byte what it was.
  db.listPeerDevices!.mockResolvedValue([]);
  db.listLinkedDevices!.mockResolvedValue([]);
  db.getPeerDevice!.mockResolvedValue(null);
  await messaging.start(ME);
  await flush();
  ws.calls.send.mockClear();
  db.insertMessage!.mockClear();
  db.touchChat!.mockClear();
  db.setDisappearTimer!.mockClear();
  db.armExpiry!.mockClear();
  crypto.encryptText!.mockClear();
}

describe('a timer arriving from the peer', () => {
  it('applies the setting AND announces it, because a silent change is the bug', async () => {
    // This test used to assert the opposite — "no row, no preview bump" — and
    // that reading of "carrier" is exactly what shipped the defect: the sender
    // got a row (encryptAndEnqueue stores every plaintext it sends) and the
    // recipient got nothing, so one phone showed the change and the other did
    // not. The design asks for a system row on both sides
    // precisely because a silently shortened timer is a trust problem.
    await start();
    await deliver(FRIEND, '01TIMER', timerFrame(3600, V));

    expect(db.setDisappearTimer).toHaveBeenCalledWith(FRIEND, 3600, V);
    const row = db.insertMessage!.mock.calls.at(-1)?.[0] as {
      msgId: string;
      direction: string;
      body: string;
      expiresAt?: number | null;
    };
    expect(row).toMatchObject({
      msgId: '01TIMER',
      peerId: FRIEND,
      direction: 'in',
      body: timerFrame(3600, V),
    });
    // The preview says words, never the envelope.
    expect(db.touchChat).toHaveBeenCalledWith(
      FRIEND,
      'Disappearing messages on',
      expect.any(Number),
    );
    expect(db.touchChat!.mock.calls.at(-1)?.[1]).not.toContain('{"tcm"');
  });

  it('announces OFF with its own preview line', async () => {
    await start();
    await deliver(FRIEND, '01TIMEROFF', timerFrame(0, V));

    expect(db.touchChat).toHaveBeenCalledWith(
      FRIEND,
      'Disappearing messages off',
      expect.any(Number),
    );
  });

  it('inserts the notice UNARMED, so a short timer cannot delete its own notice', async () => {
    // armExpiry stamps every inbound row with no expiry yet. Insert before it
    // and the announcement starts its clock at ARRIVAL — a peer setting a
    // short timer while this phone was off would then have set it invisibly.
    // The row must land after, and be armed at READ by the thread-open sweep.
    await start();
    const order: string[] = [];
    db.armExpiry!.mockImplementation(async () => {
      order.push('armExpiry');
    });
    db.insertMessage!.mockImplementation(async () => {
      order.push('insertMessage');
    });

    await deliver(FRIEND, '01TIMER', timerFrame(60, V));

    expect(order).toEqual(['armExpiry', 'insertMessage']);
    const row = db.insertMessage!.mock.calls.at(-1)?.[0] as {
      expiresAt?: number | null;
    };
    expect(row.expiresAt ?? null).toBeNull();
  });

  it('a superseded frame announces nothing — no row, no preview', async () => {
    // Otherwise one replayed envelope becomes an endless stream of
    // "they set disappearing messages to ..." lines.
    await start();
    db.setDisappearTimer!.mockResolvedValueOnce(false);
    await deliver(FRIEND, '01OLD', timerFrame(86400, V - 1000));

    expect(db.insertMessage).not.toHaveBeenCalled();
    expect(db.touchChat).not.toHaveBeenCalled();
  });

  it('a frame dated far in the future announces nothing either', async () => {
    await start();
    await deliver(
      FRIEND,
      '01FUTURE2',
      timerFrame(60, Date.now() + 30 * 24 * 60 * 60 * 1000),
    );

    expect(db.insertMessage).not.toHaveBeenCalled();
    expect(db.touchChat).not.toHaveBeenCalled();
  });

  it('is acked like anything else, so the queue drains', async () => {
    await start();
    await deliver(FRIEND, '01TIMER', timerFrame(60, V));

    expect(db.markSeen).toHaveBeenCalledWith('01TIMER', expect.any(Number));
    expect(ws.calls.send).toHaveBeenCalledWith({ type: 'ack', msgId: '01TIMER' });
  });

  it('starts the clock on the backlog already on this phone', async () => {
    // Turning it on has to mean something for what is already here, or the
    // person who just enabled it is looking at messages that never expire.
    await start();
    await deliver(FRIEND, '01TIMER', timerFrame(300, V));

    expect(db.armExpiry).toHaveBeenCalledWith(FRIEND, 300, expect.any(Number));
  });

  it('turning it OFF arms nothing', async () => {
    await start();
    await deliver(FRIEND, '01TIMER', timerFrame(0, V));

    expect(db.setDisappearTimer).toHaveBeenCalledWith(FRIEND, 0, V);
    expect(db.armExpiry).not.toHaveBeenCalled();
  });

  it('a superseded frame changes nothing — db refuses and no re-render follows', async () => {
    // Replaying an old envelope must not lengthen (or shorten) the timer.
    await start();
    db.setDisappearTimer!.mockResolvedValueOnce(false);
    await deliver(FRIEND, '01OLD', timerFrame(86400, V - 1000));

    expect(db.armExpiry).not.toHaveBeenCalled();
  });

  it('a frame dated far in the future is refused, so it cannot win forever', async () => {
    await start();
    await deliver(FRIEND, '01FUTURE', timerFrame(60, Date.now() + 30 * 24 * 60 * 60 * 1000));

    expect(db.setDisappearTimer).not.toHaveBeenCalled();
    // Still acked: an unacked frame is a growing backlog and a behavioural tell.
    expect(ws.calls.send).toHaveBeenCalledWith({ type: 'ack', msgId: '01FUTURE' });
  });
});

describe('setting a timer myself', () => {
  it('applies locally first, then goes on the wire', async () => {
    await start();
    await messaging.setDisappearTimer(FRIEND, 3600);
    await flush();

    expect(db.setDisappearTimer).toHaveBeenCalledWith(FRIEND, 3600, expect.any(Number));
    const sent = crypto.encryptText!.mock.calls.at(-1)?.[2] as string;
    expect(JSON.parse(sent)).toMatchObject({ tcm: 'timer', s: 3600 });
  });

  it('previews as words and stamps its own notice with the timer it announces', async () => {
    // db.setDisappearTimer lands BEFORE encryptAndEnqueue reads disappearSec,
    // so the "You set disappearing messages to 1 hour" row expires with the
    // conversation it belongs to. A thread that empties itself must not keep a
    // permanent ledger of when the shredder was switched on.
    await start();
    db.getChat!.mockResolvedValue({ peerId: FRIEND, disappearSec: 3600 });

    await messaging.setDisappearTimer(FRIEND, 3600);
    await flush();

    const row = db.enqueueOutgoing!.mock.calls.at(-1)?.[0] as {
      body: string;
      expiresAt: number | null;
    };
    // The row body IS the envelope (same as the screenshot notice) — what must
    // never carry JSON is anything a person reads.
    expect(row.body).toContain('"tcm":"timer"');
    expect(row.expiresAt).toBeGreaterThan(Date.now());
    expect(db.touchChat).toHaveBeenCalledWith(
      FRIEND,
      'Disappearing messages on',
      expect.any(Number),
    );
  });

  it('turning it OFF leaves a notice that never expires', async () => {
    // Nothing in the thread expires from here on, so the notice that revoked
    // the setting has to outlive it.
    await start();
    db.getChat!.mockResolvedValue({ peerId: FRIEND, disappearSec: 0 });

    await messaging.setDisappearTimer(FRIEND, 0);
    await flush();

    const row = db.enqueueOutgoing!.mock.calls.at(-1)?.[0] as {
      expiresAt: number | null;
    };
    expect(row.expiresAt).toBeNull();
    expect(db.touchChat).toHaveBeenCalledWith(
      FRIEND,
      'Disappearing messages off',
      expect.any(Number),
    );
  });

  it('sends NOTHING to a blocked peer', async () => {
    // Same rule as every other outbound path: a timer frame is a liveness
    // beacon, and blocking must stay undetectable.
    db.listBlockedPeers!.mockResolvedValue([BLOCKED]);
    await messaging.start(ME);
    await flush();
    crypto.encryptText!.mockClear();
    db.setDisappearTimer!.mockClear();

    await expect(messaging.setDisappearTimer(BLOCKED, 60)).rejects.toBeInstanceOf(
      BlockedPeerError,
    );
    expect(crypto.encryptText).not.toHaveBeenCalled();
    expect(db.setDisappearTimer).not.toHaveBeenCalled();
  });
});

describe('sending while a timer is set', () => {
  it('stamps my own message with its expiry at SEND time', async () => {
    // Not at next-open: something I sent and never looked at again would
    // otherwise outlive the copy on their phone.
    await start();
    db.getChat!.mockResolvedValue({ peerId: FRIEND, disappearSec: 120 });

    await messaging.sendText(FRIEND, 'this one goes away');
    await flush();

    const row = db.enqueueOutgoing!.mock.calls.at(-1)?.[0] as { expiresAt: number | null };
    expect(row.expiresAt).toBeGreaterThan(Date.now());
  });

  it('leaves expiry null when no timer is set', async () => {
    await start();
    db.getChat!.mockResolvedValue({ peerId: FRIEND, disappearSec: 0 });

    await messaging.sendText(FRIEND, 'this one keeps');
    await flush();

    const row = db.enqueueOutgoing!.mock.calls.at(-1)?.[0] as { expiresAt: number | null };
    expect(row.expiresAt).toBeNull();
  });
});

describe('the sweep', () => {
  it('arms what is visible, then removes what is past its time', async () => {
    await start();
    db.getChat!.mockResolvedValue({ peerId: FRIEND, disappearSec: 90 });
    db.sweepExpired!.mockResolvedValue(2);

    await messaging.sweepDisappearing(FRIEND);

    expect(db.armExpiry).toHaveBeenCalledWith(FRIEND, 90, expect.any(Number));
    expect(db.sweepExpired).toHaveBeenCalledWith(expect.any(Number));
  });

  it('arms nothing for a conversation with no timer', async () => {
    await start();
    db.getChat!.mockResolvedValue({ peerId: FRIEND, disappearSec: 0 });

    await messaging.sweepDisappearing(FRIEND);

    expect(db.armExpiry).not.toHaveBeenCalled();
    // The sweep itself still runs: another conversation's rows may be due.
    expect(db.sweepExpired).toHaveBeenCalled();
  });

  it('sweeps every conversation when called with no peer', async () => {
    await start();
    await messaging.sweepDisappearing();

    expect(db.armExpiry).not.toHaveBeenCalled();
    expect(db.sweepExpired).toHaveBeenCalledWith(expect.any(Number));
  });
});
