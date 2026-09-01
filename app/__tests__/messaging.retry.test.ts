/**
 * SEND RETRY — the exponential backoff (messaging.ts flushPending).
 *
 * The policy under test: a row that has made N sends without a receipt waits
 * min(15 s * 2^(N-1), 120 s) before it may be sent again, and the tenth
 * unanswered send is the last — the row is marked failed, its ciphertext is
 * deleted, and the retry timer dies. The 15 s scheduleRetry tick is unchanged;
 * a row deeper in its backoff simply skips ticks until its own delay is up.
 *
 * Harness follows messaging.blocking.test.ts: `./db` is mocked outright
 * because every assertion here is about calls ("bumpOutboxAttempt was not
 * called", "no further listOutbox polls"), not about SQL. Modern fake timers
 * fake Date.now too, so one advanceTimersByTimeAsync moves both the tick and
 * the `Date.now() - sentAt` comparison in lockstep — always followed by
 * flush(), because the flush the timer fires is async.
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
  clearPeerPairSafety: jest.fn(),
  blockPeer: jest.fn(),
  unblockPeer: jest.fn(),
}));

import type { OutboxRow } from '../src/db';
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

const ME = 'me-user';
const FRIEND = '01FRIENDZ3NDEKTSV4RRFFQ69G';
const ROW = '01STUCKROWZ3NDEKTSV4RRFFQ6';

const TICK = 15_000; // RECEIPT_TIMEOUT_MS — the scheduleRetry cadence
const MAX_DELAY = 120_000; // MAX_RETRY_DELAY_MS — the backoff ceiling

/** Long enough for the send chain (list → gate → send → bump → schedule). */
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

function sendFrames(): unknown[] {
  return ws.calls.send.mock.calls
    .map(c => c[0])
    .filter(f => (f as { type: string }).type === 'send');
}

/** Wire sends of one outbox row — the count every schedule test watches. */
function framesFor(msgId: string): unknown[] {
  return sendFrames().filter(f => (f as { msgId: string }).msgId === msgId);
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
    ['saveMyProfileCard', null],
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
    'clearPeerPairSafety',
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
  crypto.encryptText!.mockReset().mockResolvedValue({
    msgType: 'ciphertext',
    payload: 'Q0lQSEVS',
  });
  crypto.processPreKeyBundle!.mockReset().mockResolvedValue(undefined);
  crypto.hasSession!.mockReset().mockResolvedValue(false);
  crypto.isIdentityChangeError!.mockReset().mockReturnValue(false);
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
}

/**
 * Put one outbox row in flight: listOutbox serves it with the given attempt
 * count, and a sendText triggers the flush that sends it and arms the retry
 * timer. The mocked bumpOutboxAttempt writes nothing, so `attempts` here is
 * the value the NEXT flush re-lists — i.e. sends already made, which is
 * exactly what the gate reads.
 */
async function primeRow(attempts: number): Promise<void> {
  db.listOutbox!.mockResolvedValue([{ ...outboxRow(ROW, FRIEND), attempts }]);
  await messaging.sendText(FRIEND, 'anyone there?');
  await flush();
}

// ---------------------------------------------------------------------------
// The schedule: delay(attempts) = min(15 s * 2^(attempts-1), 120 s).
// ---------------------------------------------------------------------------

describe('the backoff schedule', () => {
  test('attempts=1 waits the base window: no resend at 14 s, resend at 15 s', async () => {
    jest.useFakeTimers();
    try {
      await startMessaging();
      await primeRow(1);
      expect(framesFor(ROW)).toHaveLength(1);

      // 14 s in, the retry tick has not fired — so drive a flush through
      // unrelated traffic. The row must still be skipped: the per-row gate,
      // not the tick, is what holds it back.
      await jest.advanceTimersByTimeAsync(TICK - 1_000);
      await messaging.sendText(FRIEND, 'unrelated words');
      await flush();
      expect(framesFor(ROW)).toHaveLength(1);

      // 15 s total: the base window has elapsed and the tick resends it.
      await jest.advanceTimersByTimeAsync(1_000);
      await flush();
      expect(framesFor(ROW)).toHaveLength(2);
    } finally {
      jest.useRealTimers();
    }
  });

  test('attempts=3 waits 60 s: three ticks skip it, the fourth resends it', async () => {
    jest.useFakeTimers();
    try {
      await startMessaging();
      await primeRow(3);
      expect(framesFor(ROW)).toHaveLength(1);

      // Ticks at 15 s, 30 s and 45 s all fire; the row skips every one.
      // (Remove the retryDelayMs gate and the very first tick resends —
      // this is the assertion that proves the backoff exists.)
      await jest.advanceTimersByTimeAsync(TICK * 3);
      await flush();
      expect(framesFor(ROW)).toHaveLength(1);

      await jest.advanceTimersByTimeAsync(TICK);
      await flush();
      expect(framesFor(ROW)).toHaveLength(2);
    } finally {
      jest.useRealTimers();
    }
  });

  test('the delay caps at 120 s: attempts=5 would double to 240 s uncapped', async () => {
    jest.useFakeTimers();
    try {
      await startMessaging();
      await primeRow(5); // 15 * 2^4 = 240 s uncapped; the cap says 120 s
      expect(framesFor(ROW)).toHaveLength(1);

      // Seven ticks inside the capped window: still held back…
      await jest.advanceTimersByTimeAsync(TICK * 7);
      await flush();
      expect(framesFor(ROW)).toHaveLength(1);

      // …and the 120 s tick resends — not the 240 s one.
      await jest.advanceTimersByTimeAsync(TICK);
      await flush();
      expect(framesFor(ROW)).toHaveLength(2);
    } finally {
      jest.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// Exhaustion at MAX_SEND_ATTEMPTS = 10.
// ---------------------------------------------------------------------------

describe('exhaustion', () => {
  test('the tenth send is the last: error marked, ciphertext deleted, timer dead, thread repainted', async () => {
    jest.useFakeTimers();
    try {
      await startMessaging();
      const repaint = jest.fn();
      const off = messaging.subscribe(repaint);

      // Nine sends behind it: still under the cap, so it IS sent again.
      await primeRow(9);
      expect(framesFor(ROW)).toHaveLength(1);
      expect(db.markOutgoingError).not.toHaveBeenCalled();

      // That tenth send bumped the durable row to 10; every later list sees
      // it exhausted. Its own receipt window (120 s at the cap) still has to
      // pass unanswered first — the last send gets the same patience as the
      // others.
      db.listOutbox!.mockResolvedValue([
        { ...outboxRow(ROW, FRIEND), attempts: 10 },
      ]);
      repaint.mockClear();
      await jest.advanceTimersByTimeAsync(MAX_DELAY);
      await flush();

      expect(framesFor(ROW)).toHaveLength(1); // never an eleventh frame
      expect(db.markOutgoingError).toHaveBeenCalledWith(ROW);
      expect(db.deleteOutboxEnvelope).toHaveBeenCalledWith(ROW);
      // The exhaustion fired from the silent timer path — the UI must hear
      // about it now, not on the next unrelated send.
      expect(repaint).toHaveBeenCalled();

      // inflight was cleared, so the retry timer must die rather than re-arm:
      // whole periods pass and the outbox is never polled again.
      db.listOutbox!.mockClear();
      await jest.advanceTimersByTimeAsync(TICK * 6);
      await flush();
      expect(db.listOutbox!.mock.calls.length).toBe(0);
      off();
    } finally {
      jest.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// Attempts burn only while the socket claims open.
// ---------------------------------------------------------------------------

describe('a closed socket burns nothing', () => {
  test('no sends, no attempt bumps and no exhaustion while the socket is closed', async () => {
    jest.useFakeTimers();
    try {
      await startMessaging();
      await primeRow(1);
      expect(framesFor(ROW)).toHaveLength(1);
      const bumps = db.bumpOutboxAttempt!.mock.calls.length;

      ws.state.open = false;
      // Five dead minutes — enough fixed-cadence periods to have exhausted
      // the row many times over if attempts burned while closed.
      await jest.advanceTimersByTimeAsync(TICK * 20);
      await flush();

      expect(framesFor(ROW)).toHaveLength(1);
      expect(db.bumpOutboxAttempt!.mock.calls.length).toBe(bumps);
      expect(db.markOutgoingError).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  test('a frame the socket refuses burns no attempt either', async () => {
    await startMessaging();
    ws.calls.send.mockImplementation((_frame: unknown) => false);
    db.listOutbox!.mockResolvedValue([outboxRow(ROW, FRIEND)]);

    await messaging.sendText(FRIEND, 'anyone there?');
    await flush();

    // ws.send returned false: the loop breaks before the bump, so the row
    // keeps its attempt for a socket that can actually carry it.
    expect(db.bumpOutboxAttempt).not.toHaveBeenCalled();
    expect(db.markOutgoingError).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Reconnect resets the delay clock (existing property, now load-bearing).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Manual retry (Try again): a fresh send, never a replay — behind the same
// gates as any fresh send.
// ---------------------------------------------------------------------------

describe('manual retry is a fresh send', () => {
  test('re-encrypts the words under a new msgId; the dead ciphertext is never replayed', async () => {
    await startMessaging();
    // Each enqueue becomes the whole outbox: by the time a person can tap
    // Try again, the exhaustion path has already deleted the old row's
    // ciphertext (deleteOutboxEnvelope), so only the fresh row exists.
    db.enqueueOutgoing!.mockImplementation(
      async (
        msg: { msgId: string; peerId: string },
        env: { msgType: string; payload: string },
      ) => {
        db.listOutbox!.mockResolvedValue([
          {
            msgId: msg.msgId,
            peerId: msg.peerId,
            msgType: env.msgType,
            payload: env.payload,
            attempts: 0,
            priority: 0,
            urgent: 0,
          },
        ]);
      },
    );

    await messaging.sendText(FRIEND, 'on my way');
    await flush();
    const frames1 = sendFrames();
    const first = frames1[frames1.length - 1] as {
      msgId: string;
      payload: string;
    };

    // The tap re-encrypts the plaintext kept in the message row. The ratchet
    // has advanced, so the ciphertext is new — nothing about the dead send
    // is reused.
    crypto.encryptText!.mockResolvedValue({
      msgType: 'ciphertext',
      payload: 'TkVXQ0lQSEVS',
    });
    await messaging.sendText(FRIEND, 'on my way');
    await flush();
    const frames2 = sendFrames();
    const second = frames2[frames2.length - 1] as {
      msgId: string;
      payload: string;
    };

    expect(frames2).toHaveLength(2);
    expect(second.msgId).not.toBe(first.msgId); // a NEW message, as Signal does
    expect(second.payload).toBe('TkVXQ0lQSEVS'); // fresh ratchet output
    expect(crypto.encryptText).toHaveBeenCalledTimes(2);
    const bodies = db.enqueueOutgoing!.mock.calls.map(
      c => (c[0] as { body: string }).body,
    );
    expect(bodies).toEqual(['on my way', 'on my way']); // same words, new send
  });

  test('a blocked peer refuses the retry outright: no encrypt, no row, no frame', async () => {
    await startMessaging();
    await messaging.blockPeer(FRIEND);
    ws.calls.send.mockClear();

    await expect(
      messaging.sendText(FRIEND, 'on my way'),
    ).rejects.toMatchObject({ name: 'BlockedPeerError' });

    expect(crypto.encryptText).not.toHaveBeenCalled();
    expect(db.enqueueOutgoing).not.toHaveBeenCalled();
    expect(sendFrames()).toHaveLength(0);
  });

  test('an unaccepted identity change gates the retry exactly like a fresh sendText', async () => {
    db.listIdentityChanged!.mockResolvedValue([FRIEND]);
    await startMessaging();

    await expect(messaging.sendText(FRIEND, 'on my way')).rejects.toThrow(
      'safety number changed',
    );

    // The choke point refused before any crypto ran: the ratchet did not
    // advance and nothing reached the outbox or the wire.
    expect(crypto.encryptText).not.toHaveBeenCalled();
    expect(db.enqueueOutgoing).not.toHaveBeenCalled();
    expect(sendFrames()).toHaveLength(0);

    // The identityChanged Set survives stop() by design (a warning must not
    // lapse on relock) — accept it so this test cannot leak into the next.
    await messaging.acceptIdentityChange(FRIEND);
  });
});

// ---------------------------------------------------------------------------
// A send racing the running flush: a row committed while a pass is between
// awaits postdates that pass's listOutbox snapshot, and must not be stranded
// 'pending' on an open socket until some unrelated event flushes again.
// ---------------------------------------------------------------------------

describe('a send racing the running flush', () => {
  test('a row committed mid-pass is sent by a latched re-run, without a reconnect', async () => {
    const ROW2 = '01SECONDROWZ3NDEKTSV4RRFF6';
    await startMessaging();

    // First pass: one row, and the flush suspends inside bumpOutboxAttempt
    // right after its ws.send — one of the multi-await windows the retry
    // tick leaves open.
    db.listOutbox!.mockResolvedValue([outboxRow(ROW, FRIEND)]);
    let release!: () => void;
    const held = new Promise<void>(resolve => {
      release = resolve;
    });
    db.bumpOutboxAttempt!.mockImplementationOnce(() => held);

    const first = messaging.sendText(FRIEND, 'first words');
    await flush();
    expect(framesFor(ROW)).toHaveLength(1);

    // While the pass is suspended, a second send commits its outbox row and
    // calls flushPending — which must latch a re-run, because the running
    // pass's snapshot predates this row.
    db.enqueueOutgoing!.mockImplementation(async () => {
      db.listOutbox!.mockResolvedValue([outboxRow(ROW2, FRIEND)]);
    });
    await messaging.sendText(FRIEND, 'second words');
    await flush();
    expect(framesFor(ROW2)).toHaveLength(0); // pass still mid-flight

    // The suspended pass resumes, finishes its own snapshot, and the latch
    // makes it re-list: the second row reaches the wire with no reconnect
    // and no further user action.
    release();
    await first;
    await flush();
    expect(framesFor(ROW2)).toHaveLength(1);
  });
});

describe('reconnect', () => {
  test('a fresh socket re-sends immediately, whatever the accumulated backoff', async () => {
    await startMessaging();
    await primeRow(5); // mid-backoff: 120 s of waiting ahead on this socket
    expect(framesFor(ROW)).toHaveLength(1);

    // Drop + reopen: inflight is cleared, so the delay clock is gone and the
    // whole outbox re-flushes at once. The attempts count still caps at ten
    // across connections — only the waiting is per-socket.
    ws.handlers.state?.('open');
    await flush();

    expect(framesFor(ROW)).toHaveLength(2);
  }, 10_000);
});
