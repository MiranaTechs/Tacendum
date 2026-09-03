jest.mock('../src/ws', () => {
  // FAITHFUL to the real client's teardown semantics, because the previous
  // mock hid a critical bug: real `stop()` CLEARS the frame/state handlers
  // and real `suspend()` keeps them, while the mock's stop preserved
  // everything — so a pause/resume cycle that left the socket deaf in
  // production passed every test here.
  const handlers: {
    frame?: (f: unknown) => void;
    state?: (s: string) => void;
  } = {};
  const state = { open: false };
  const calls = {
    start: jest.fn(),
    stop: jest.fn(),
    suspend: jest.fn(),
    send: jest.fn((_frame: unknown) => state.open),
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
      handlers.frame = undefined;
      handlers.state = undefined;
    }
    suspend() {
      calls.suspend();
      // Transport dies, wiring survives — the whole point of the method.
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

import * as db from '../src/db';
import { messaging } from '../src/messaging';
import { session } from '../src/session';

/**
 * Importing what the notification-service extension decrypted.
 *
 * These messages are unlike every other kind the app handles: the extension
 * CONSUMED their ratchet message keys, so the copy the server still holds can
 * never be decrypted again, by anyone. If the app fails to import one, it is
 * gone — not delayed, gone. And the server, which never received an ack, will
 * redeliver that undecryptable ciphertext the moment the socket opens.
 *
 * So the two properties worth pinning are: the import happens BEFORE the
 * socket opens, and it does not attempt a second decryption.
 */

interface FakeDb {
  name: string;
  execute: jest.Mock;
  close: jest.Mock;
}
const sqlite = (
  jest.requireMock('@op-engineering/op-sqlite') as {
    __sqlite: { instances: Map<string, FakeDb>; reset: () => void };
  }
).__sqlite;

const crypto = jest.requireMock('tacendum-crypto') as {
  __keychain: Map<string, string>;
  __sharedState: Map<string, string>;
  __inbox: Map<string, unknown>;
  decryptEnvelope: jest.Mock;
  readInbox: jest.Mock;
  clearInboxEntry: jest.Mock;
  hasSession: jest.Mock;
};

const ws = (
  jest.requireMock('../src/ws') as {
    __ws: {
      handlers: { frame?: (f: unknown) => void };
      calls: { start: jest.Mock; send: jest.Mock; stop: jest.Mock; suspend: jest.Mock };
      state: { open: boolean };
    };
  }
).__ws;

const ME = '01MEZ3NDEKTSV4RRFFQ69G5FAV';
const PEER = '01PEERZ3NDEKTSV4RRFFQ69G5F';
const MSG = '01ARZ3NDEKTSV4RRFFQ69G5FAW';

/** Records the order of the two things whose ordering is the point. */
let order: string[] = [];

/**
 * A real `seen` set, because the drain now depends on it.
 *
 * op-sqlite is mocked and every read returns no rows, so `hasSeen` would
 * always answer false and `markSeen` would vanish — which makes the guard
 * being tested here ("clear only when something proved it was processed")
 * untestable and, worse, silently vacuous. These two spies are the smallest
 * faithful model of the one table that matters.
 */
let seen: Set<string>;

async function settle(turns = 60): Promise<void> {
  for (let i = 0; i < turns; i++) await Promise.resolve();
}

beforeEach(async () => {
  messaging.stop();
  session.setMode('real');
  sqlite.reset();
  // A WORKSPACE HAS TO BE OPENED ON PURPOSE NOW. `closedLatch` in src/db.ts
  // initializes to TRUE, so `conn()` refuses to lazily open a file for a
  // caller that never asked for one — the guard that stops anything opening
  // the real workspace before the lock screen has a verdict. This suite drains
  // the spool through the real `db` module, so it has to say which world it is
  // draining into; without this line every db call here throws "database is
  // closed" and the drain silently does nothing.
  await db.close();
  db.setWorkspace('real');
  await db.initDb();
  crypto.__keychain.clear();
  crypto.__sharedState.clear();
  crypto.__inbox.clear();
  jest.clearAllMocks();
  order = [];

  seen = new Set();
  jest.spyOn(db, 'hasSeen').mockImplementation(async id => seen.has(id));
  jest.spyOn(db, 'markSeen').mockImplementation(async id => {
    seen.add(id);
  });

  crypto.__keychain.set('authToken', 'tok');
  crypto.hasSession.mockResolvedValue(true);
  crypto.readInbox.mockImplementation(async () => {
    order.push('readInbox');
    return [...crypto.__inbox.values()];
  });
  crypto.clearInboxEntry.mockImplementation(async (msgId: string) => {
    order.push(`clear:${msgId}`);
    crypto.__inbox.delete(msgId);
  });
  ws.state.open = false;
  ws.calls.start.mockImplementation(() => {
    order.push('ws.start');
  });
});

afterEach(() => {
  messaging.stop();
});

test('the spool is drained BEFORE the socket opens', async () => {
  // Not a preference. The server never saw an ack for these, so it redelivers
  // the moment the socket comes up — and that redelivery can only fail, since
  // its ratchet key is spent. Importing first means the redelivery finds the
  // msgId already seen and is simply acked.
  crypto.__inbox.set(MSG, {
    msgId: MSG,
    from: PEER,
    ts: 1_700_000_000_000,
    body: 'hello from the extension',
  });

  await messaging.start(ME);
  await settle();

  expect(order.indexOf('readInbox')).toBeGreaterThanOrEqual(0);
  expect(order.indexOf('ws.start')).toBeGreaterThanOrEqual(0);
  expect(order.indexOf('readInbox')).toBeLessThan(order.indexOf('ws.start'));
});

test('a spooled message is NOT decrypted a second time', async () => {
  // The extension already spent the message key. A second attempt throws
  // DuplicatedMessage, lands in the catch, and writes a visible error row into
  // the conversation for a message that arrived perfectly well.
  crypto.__inbox.set(MSG, {
    msgId: MSG,
    from: PEER,
    ts: 1_700_000_000_000,
    body: 'hello from the extension',
  });

  await messaging.start(ME);
  await settle();

  expect(crypto.decryptEnvelope).not.toHaveBeenCalled();
});

test('the entry is cleared only AFTER it is imported', async () => {
  crypto.__inbox.set(MSG, {
    msgId: MSG,
    from: PEER,
    ts: 1_700_000_000_000,
    body: 'hello',
  });

  await messaging.start(ME);
  await settle();

  // A crash between the two loses nothing: the entry is still in the spool
  // and the next launch tries again.
  expect(order).toContain(`clear:${MSG}`);
  expect(crypto.__inbox.size).toBe(0);
});

test('an entry that fails to import is LEFT in the spool', async () => {
  // These cannot be re-fetched, so discarding one on error would destroy it.
  crypto.__inbox.set(MSG, {
    msgId: MSG,
    from: PEER,
    ts: 1_700_000_000_000,
    body: 'hello',
  });
  jest.spyOn(db, 'hasSeen').mockRejectedValue(new Error('database is closed'));

  await messaging.start(ME);
  await settle();

  expect(crypto.clearInboxEntry).not.toHaveBeenCalled();
  expect(crypto.__inbox.size).toBe(1);
});

test('the blocked mirror is refreshed on BLOCK, not only at start', async () => {
  // The extension reads a FILE — it has neither the Set nor the database. A
  // block that never reaches the file is a block that fails in the one place
  // it is most conspicuous: a banner on the lock screen, from the person the
  // owner just blocked.
  await messaging.start(ME);
  await settle();
  const before = crypto.__sharedState.get('blocked-peers');

  await messaging.blockPeer(PEER);
  await settle();

  expect(crypto.__sharedState.get('blocked-peers')).toContain(PEER);
  expect(crypto.__sharedState.get('blocked-peers')).not.toBe(before);
});

test('the blocked mirror is refreshed on UNBLOCK too', async () => {
  // The other direction, and the one a grow-only mirror would get wrong:
  // without this the extension keeps swallowing notifications from someone
  // who has been let back in, which reads as "their messages never arrive".
  await messaging.start(ME);
  await settle();
  await messaging.blockPeer(PEER);
  await settle();
  expect(crypto.__sharedState.get('blocked-peers')).toContain(PEER);

  await messaging.unblockPeer(PEER);
  await settle();

  expect(crypto.__sharedState.get('blocked-peers') ?? '').not.toContain(PEER);
});

test('the self id is published so the extension has a local address', async () => {
  // libsignal needs it and the push does not carry it. Without this the
  // extension cannot decrypt at all.
  await messaging.start(ME);
  await settle();

  expect(crypto.__sharedState.get('self-user-id')).toBe(ME);
});

test('a relock mid-drain does NOT delete plaintext it never imported', async () => {
  // THE DEFECT REVIEW FOUND. `handleIncoming` resolves without persisting when
  // its generation goes stale — which is what a relock causes — and clearing
  // on "the call returned" deleted the only copy of a plaintext whose
  // ciphertext is already spent. Modelled here as a handler that completes
  // without ever marking the message seen.
  crypto.__inbox.set(MSG, {
    msgId: MSG,
    from: PEER,
    ts: 1_700_000_000_000,
    body: 'hello',
  });
  // The relock lands between the row write and the seen mark — the
  // generation goes stale, the handler returns early, and nothing after the
  // insert (markSeen included) runs. Modelled at the exact seam: a relock
  // inside the persist, which is where a real `messaging.stop()` from the
  // lock screen interleaves. (This used to be modelled as a no-op markSeen;
  // the drain's proof is now its own witness of the write, so the early
  // return has to be a real one.)
  // Restored at the end: `clearAllMocks` in beforeEach keeps implementations,
  // and a persist that relocks would poison every drain that follows.
  const relocking = jest.spyOn(db, 'insertMessage').mockImplementation(async () => {
    messaging.stop();
  });
  try {
    await messaging.start(ME);
    await settle();

    expect(crypto.clearInboxEntry).not.toHaveBeenCalled();
    expect(crypto.__inbox.size).toBe(1);
  } finally {
    relocking.mockRestore();
  }
});

test('the spool entry is cleared on the IMPORT itself, even when `seen` has already evicted the row', async () => {
  // The drain used to read `seen` back as its proof of import, and
  // `markSeen`'s prune could evict the row it had just written (5000 CSPRNG
  // wire ids sort above every ULID) — so a perfectly imported message was
  // never cleared and was re-imported on every launch: the chat line
  // regressed to the old preview, a ready photo flipped back to 'pending'
  // and re-downloaded. The proof is now the handler's own witness of the
  // write, which no prune can take back.
  crypto.__inbox.set(MSG, {
    msgId: MSG,
    from: PEER,
    ts: 1_700_000_000_000,
    body: 'hello',
  });
  // The row is written (the witness fires) and then reads as gone.
  jest.spyOn(db, 'hasSeen').mockResolvedValue(false);

  await messaging.start(ME);
  await settle();

  expect(order).toContain(`clear:${MSG}`);
  expect(crypto.__inbox.size).toBe(0);
});

test('an entry imported on an EARLIER launch, still spooled, is cleared', async () => {
  // The witness is in-memory, so it only ever proves an import that happened during THIS
  // drain. An entry whose import finished on a previous launch but whose
  // `clearInboxEntry` never landed — the app was killed, the workspace
  // relocked, the clear threw — has no witness on any later launch, so a
  // witness-only test left it in the spool forever. That is not a leak: once
  // 5000 newer rows prune the id out of `seen`, the drain re-imports the
  // spooled plaintext and the duplicate-import symptom comes back (the chat line
  // regresses to the old preview, a ready attachment flips to 'pending', a
  // deleted message is resurrected). A durable `seen` row IS proof the
  // import already happened, so it clears too.
  crypto.__inbox.set(MSG, {
    msgId: MSG,
    from: PEER,
    ts: 1_700_000_000_000,
    body: 'hello',
  });
  // Imported on a previous launch: the row survives in `seen`, and the
  // handler will short-circuit on it without writing anything new.
  seen.add(MSG);
  const insertSpy = jest.spyOn(db, 'insertMessage');

  await messaging.start(ME);
  await settle();

  expect(order).toContain(`clear:${MSG}`);
  expect(crypto.__inbox.size).toBe(0);
  // And nothing was re-imported on the way to clearing it.
  expect(insertSpy).not.toHaveBeenCalled();
});

test('a redelivery whose key the extension spent is rescued from the spool', async () => {
  // THE RACE THE SERVER ITSELF SCHEDULES. The push fires precisely when no
  // socket is connected — so the extension can finish decrypting AFTER the
  // app's launch-time drain and BEFORE the socket's redelivery arrives. The
  // redelivered ciphertext then throws DuplicatedMessage, and before this
  // rescue existed that meant: visible error row, marked seen, acked — and
  // the next drain DELETED the spooled plaintext because seen said it was
  // handled. A successfully decrypted message, permanently lost.
  const insertSpy = jest.spyOn(db, 'insertMessage').mockResolvedValue(undefined);
  await messaging.start(ME);
  await settle();

  // The extension decrypts while the app is already up...
  crypto.__inbox.set(MSG, {
    msgId: MSG,
    from: PEER,
    ts: 1_700_000_000_000,
    body: 'the rescued words',
  });
  // ...and the socket redelivers the now-undecryptable ciphertext.
  crypto.decryptEnvelope.mockRejectedValue(
    Object.assign(new Error('DuplicatedMessage'), { code: 'crypto_error' }),
  );
  ws.handlers.frame?.({
    type: 'msg',
    from: PEER,
    msgId: MSG,
    msgType: 'ciphertext',
    payload: 'QUJD',
    ts: 1_700_000_000_000,
  });
  await settle();

  // The plaintext landed as a real message — not an error row.
  const rows = insertSpy.mock.calls.map(c => c[0] as { body: string; status: string });
  expect(rows.some(r => r.body === 'the rescued words' && r.status !== 'error')).toBe(true);
  expect(rows.some(r => r.status === 'error')).toBe(false);
  // Seen, acked, and the spool entry is gone.
  expect(seen.has(MSG)).toBe(true);
  expect(crypto.__inbox.size).toBe(0);
});

test('a busy store lock is retried via redelivery, never poisoned', async () => {
  // The lock's only other holder is the notification extension, which lives
  // for seconds — transient by construction. Before this, a five-second wait
  // became: error row, seen, acked. The ciphertext was acked away over a
  // lock that would have been free moments later.
  const insertSpy = jest.spyOn(db, 'insertMessage').mockResolvedValue(undefined);
  await messaging.start(ME);
  await settle();

  crypto.decryptEnvelope.mockRejectedValue(
    Object.assign(new Error('store_busy: timed out waiting for the store lock'), {
      code: 'store_busy',
    }),
  );
  (crypto as unknown as { isStoreBusyError: jest.Mock }).isStoreBusyError
    .mockImplementation((err: { code?: string }) => err?.code === 'store_busy');
  ws.handlers.frame?.({
    type: 'msg',
    from: PEER,
    msgId: MSG,
    msgType: 'ciphertext',
    payload: 'QUJD',
    ts: 1_700_000_000_000,
  });
  await settle();

  // Nothing at all: no row, no seen, no ack. The server redelivers.
  expect(insertSpy).not.toHaveBeenCalled();
  expect(seen.has(MSG)).toBe(false);
  const acks = ws.calls.send.mock.calls
    .map(c => c[0] as { type: string; msgId?: string })
    .filter(f => f.type === 'ack' && f.msgId === MSG);
  expect(acks).toHaveLength(0);
});

test('a busy lock is retried LOCALLY — a call offer cannot wait for the next reconnect', async () => {
  // The server's drain is one-shot: an unacked frame is not redelivered until
  // the NEXT reconnect, and for a call offer that reconnect can land after
  // the ring is dead. The lock's other holder is the extension, which lives
  // for seconds — so the frame is re-attempted in place once the hold clears.
  jest.useFakeTimers();
  try {
    const insertSpy = jest.spyOn(db, 'insertMessage').mockResolvedValue(undefined);
    await messaging.start(ME);
    await settle();

    (crypto as unknown as { isStoreBusyError: jest.Mock }).isStoreBusyError
      .mockImplementation((err: { code?: string }) => err?.code === 'store_busy');
    let holds = 2;
    crypto.decryptEnvelope.mockImplementation(async () => {
      if (holds > 0) {
        holds -= 1;
        throw Object.assign(new Error('store_busy: timed out'), { code: 'store_busy' });
      }
      return 'freed at last';
    });
    ws.handlers.frame?.({
      type: 'msg',
      from: PEER,
      msgId: MSG,
      msgType: 'ciphertext',
      payload: 'QUJD',
      ts: 1_700_000_000_000,
    });
    await settle();
    expect(insertSpy).not.toHaveBeenCalled();

    // First retry finds the lock still held; the second finds it free.
    jest.advanceTimersByTime(1_500);
    await settle();
    expect(insertSpy).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1_500);
    await settle();

    const rows = insertSpy.mock.calls.map(c => c[0] as { body: string; status: string });
    expect(rows.some(r => r.body === 'freed at last' && r.status !== 'error')).toBe(true);
    expect(seen.has(MSG)).toBe(true);
  } finally {
    jest.useRealTimers();
  }
});

test('a relock CANCELS the pending busy retry — nothing pokes the next workspace', async () => {
  jest.useFakeTimers();
  try {
    await messaging.start(ME);
    await settle();
    (crypto as unknown as { isStoreBusyError: jest.Mock }).isStoreBusyError
      .mockImplementation((err: { code?: string }) => err?.code === 'store_busy');
    crypto.decryptEnvelope.mockRejectedValue(
      Object.assign(new Error('store_busy: held'), { code: 'store_busy' }),
    );
    ws.handlers.frame?.({
      type: 'msg',
      from: PEER,
      msgId: MSG,
      msgType: 'ciphertext',
      payload: 'QUJD',
      ts: 1_700_000_000_000,
    });
    await settle();
    const attempts = crypto.decryptEnvelope.mock.calls.length;

    messaging.stop();
    jest.advanceTimersByTime(30_000);
    await settle();

    expect(crypto.decryptEnvelope.mock.calls.length).toBe(attempts);
  } finally {
    jest.useRealTimers();
  }
});

test('the SAME frame arriving twice CONCURRENTLY is handled once — the handover race', async () => {
  // The server's failed-post handover posts the frame to the fresh socket at
  // the same moment that socket's own $connect drain redelivers the queued
  // row. Both copies passed hasSeen (neither had finished); both decrypted;
  // one consumed the ratchet key, the other threw DuplicatedMessage — and
  // when the ERROR row's insert landed first, the real plaintext's INSERT OR
  // IGNORE was the copy that got ignored. Permanent loss. The door now
  // collapses concurrent duplicates before the first await.
  const insertSpy = jest.spyOn(db, 'insertMessage').mockResolvedValue(undefined);
  await messaging.start(ME);
  await settle();

  let resolveDecrypt!: (v: string) => void;
  crypto.decryptEnvelope.mockImplementation(
    () => new Promise<string>(r => (resolveDecrypt = r)),
  );
  const frame = {
    type: 'msg',
    from: PEER,
    msgId: MSG,
    msgType: 'ciphertext',
    payload: 'QUJD',
    ts: 1_700_000_000_000,
  };
  // Both copies arrive before either finishes.
  ws.handlers.frame?.(frame);
  ws.handlers.frame?.(frame);
  await settle();
  // Only ONE decrypt started: the second copy was dropped at the door.
  expect(crypto.decryptEnvelope).toHaveBeenCalledTimes(1);

  resolveDecrypt('the only copy');
  await settle();

  const rows = insertSpy.mock.calls.map(c => c[0] as { body: string; status: string });
  expect(rows.filter(r => r.body === 'the only copy')).toHaveLength(1);
  expect(rows.some(r => r.status === 'error')).toBe(false);
});

test('a parked duplicate is the retry when the first copy dies unacked', async () => {
  // The door used to DISCARD the concurrent duplicate. If the in-flight copy
  // then crashed before its main handling (a db read rejecting), nothing was
  // acked and nothing retried — and the server's drain is one-shot, so the
  // frame waited for the next reconnect. The duplicate is parked now and
  // re-enters once the first settles.
  const insertSpy = jest.spyOn(db, 'insertMessage').mockResolvedValue(undefined);
  await messaging.start(ME);
  await settle();

  // First copy crashes at the hasSeen read; the re-entry's read works.
  (db.hasSeen as jest.Mock)
    .mockRejectedValueOnce(new Error('db closed briefly'))
    .mockImplementation(async id => seen.has(id));
  crypto.decryptEnvelope.mockResolvedValue('rescued by the duplicate');
  const frame = {
    type: 'msg',
    from: PEER,
    msgId: MSG,
    msgType: 'ciphertext',
    payload: 'QUJD',
    ts: 1_700_000_000_000,
  };
  ws.handlers.frame?.(frame);
  ws.handlers.frame?.(frame);
  await settle();

  const rows = insertSpy.mock.calls.map(c => c[0] as { body: string; status: string });
  expect(rows.filter(r => r.body === 'rescued by the duplicate')).toHaveLength(1);
  expect(seen.has(MSG)).toBe(true);
});

test('a relock beats an in-flight publishNames to the mirror', async () => {
  // The nse.ts mode gate covers DURESS; a plain relock keeps mode 'real', so
  // an in-flight fire-and-forget publishNames could land after retractSelfId
  // and recreate the contact list on the locked route. The generation check
  // is what closes that: stop() bumps it before the relock retracts. The
  // lease is deliberately ARMED here — nse.ts now carries its own lease gate
  // for the db.ts publishers, and leaving it disarmed would let that gate
  // pass this test with the generation check deleted (vacuity).
  const { armedMarker, PREVIEWS_ARMED_FILE } = jest.requireActual<
    typeof import('../src/previews')
  >('../src/previews');
  crypto.__sharedState.set(PREVIEWS_ARMED_FILE, armedMarker(Date.now()));
  // The publisher reads listPeerNames — the kind-filtered projection, so a
  // renamed room can never reach the peer file through this path.
  jest
    .spyOn(db, 'listPeerNames')
    .mockResolvedValue([{ peerId: PEER, name: 'Ayana' }]);
  await messaging.start(ME);
  await settle();

  // Precondition, so the race below cannot pass vacuously: this exact
  // publish in this exact state DOES write.
  await (messaging as unknown as {
    publishNames(): Promise<void>;
  }).publishNames();
  expect(crypto.__sharedState.has('peer-names')).toBe(true);
  crypto.__sharedState.delete('peer-names');

  // A publish begins (reads the names)… and the relock lands before its write.
  const publish = (messaging as unknown as {
    publishNames(): Promise<void>;
  }).publishNames();
  messaging.stop();
  await publish;
  await settle();

  expect(crypto.__sharedState.has('peer-names')).toBe(false);
});

test('pause closes the socket; resume drains BEFORE redialling', async () => {
  // The notification bug in one test. iOS freezes a backgrounded app but
  // leaves its TCP connection standing — so a socket left open makes the
  // server deliver into the frozen buffer, mark it delivered, and push
  // nothing. pause() is what makes $disconnect fire; and resume() drains the
  // spool first because the redial triggers redelivery of exactly the
  // ciphertexts whose keys the extension already spent.
  await messaging.start(ME);
  await settle();
  order = [];

  messaging.pause();
  expect(ws.calls.suspend).toHaveBeenCalled();
  // NEVER stop: stop clears the frame handlers, and a resume that redials
  // without them is a connected socket the app cannot hear.
  expect(ws.calls.stop).not.toHaveBeenCalled();

  // The extension decrypts while the app is in the pocket…
  crypto.__inbox.set(MSG, {
    msgId: MSG,
    from: PEER,
    ts: 1_700_000_000_000,
    body: 'arrived while backgrounded',
  });

  await messaging.resume();
  await settle();

  expect(order.indexOf('readInbox')).toBeGreaterThanOrEqual(0);
  expect(order.indexOf('ws.start')).toBeGreaterThanOrEqual(0);
  expect(order.indexOf('readInbox')).toBeLessThan(order.indexOf('ws.start'));
  expect(seen.has(MSG)).toBe(true);
});

test('the socket still HEARS after a pause/resume cycle', async () => {
  // The regression the approval gate caught. pause() used stop(), which
  // clears the handler sets; resume() redialled with none installed. The
  // server then saw a live connection — so no push — while the app ignored
  // every frame and acked nothing: the original incident, one layer down.
  await messaging.start(ME);
  await settle();
  messaging.pause();
  await messaging.resume();
  await settle();

  expect(ws.handlers.frame).toBeDefined();

  // And a frame actually processes end to end: seen + ack.
  crypto.decryptEnvelope.mockResolvedValue('hello again');
  ws.state.open = true;
  ws.handlers.frame?.({
    type: 'msg',
    from: PEER,
    msgId: MSG,
    msgType: 'ciphertext',
    payload: 'QUJD',
    ts: 1_700_000_000_000,
  });
  await settle();

  expect(seen.has(MSG)).toBe(true);
});

test('resume without a pause does NOT dial a second socket', async () => {
  // iOS fires inactive→active for Control Center and the notification shade
  // with no 'background' in between; an unguarded resume dialled a duplicate
  // socket over the live one.
  await messaging.start(ME);
  await settle();
  ws.calls.start.mockClear();

  await messaging.resume();
  await settle();

  expect(ws.calls.start).not.toHaveBeenCalled();
});

test('a failed import inside a RESCUE does not recurse', async () => {
  // The rescue feeds the spooled plaintext back through handleIncoming; a
  // database failure in THAT pass lands in the same catch, and re-entering
  // the rescue would find the same entry and loop without bound. The
  // pre-decrypted pass must fall through instead, leaving the entry spooled.
  await messaging.start(ME);
  await settle();
  crypto.__inbox.set(MSG, {
    msgId: MSG,
    from: PEER,
    ts: 1_700_000_000_000,
    body: 'rescued once',
  });
  crypto.decryptEnvelope.mockRejectedValue(new Error('DuplicatedMessage'));
  // Every insert fails: the rescue's own import will throw too.
  jest.spyOn(db, 'insertMessage').mockRejectedValue(new Error('db closed'));
  (db.markSeen as jest.Mock).mockRejectedValue(new Error('db closed'));

  ws.handlers.frame?.({
    type: 'msg',
    from: PEER,
    msgId: MSG,
    msgType: 'ciphertext',
    payload: 'QUJD',
    ts: 1_700_000_000_000,
  });
  // If this recursed unboundedly, settle would never drain the queue.
  await settle(200);

  // Bounded: exactly one rescue attempt read the spool, entry retained.
  expect(crypto.__inbox.size).toBe(1);
});

test('pause and resume are no-ops when messaging never started', async () => {
  // Landing, register, a duress session: none of them have a socket to
  // close or a token to dial with, and the AppState listener calls these
  // unconditionally on routes like those.
  messaging.pause();
  await expect(messaging.resume()).resolves.toBeUndefined();

  expect(ws.calls.stop).not.toHaveBeenCalled();
  expect(ws.calls.start).not.toHaveBeenCalled();
});

test('an empty spool starts the socket normally', async () => {
  await messaging.start(ME);
  await settle();

  expect(ws.calls.start).toHaveBeenCalled();
  expect(crypto.clearInboxEntry).not.toHaveBeenCalled();
});

test('a spool that cannot be read does not stop the app starting', async () => {
  // This runs on the launch path. A container problem must cost notifications,
  // never the ability to open the app.
  crypto.readInbox.mockRejectedValue(new Error('container unavailable'));

  await expect(messaging.start(ME)).resolves.toBeUndefined();
  await settle();

  expect(ws.calls.start).toHaveBeenCalled();
});

/**
 * PER-SENDER ORDER UNDER A STORE-BUSY RETRY.
 *
 * The hazard: a `prekey` message — the one that ESTABLISHES the session —
 * hits the extension's transient store lock and waits 1.5 s for its retry;
 * the `ciphertext` right behind it, from the same sender, used to be handled
 * concurrently, decrypt against a session that did not exist yet, and land
 * in the generic tamper branch: error row, seen, ACKED. Permanent loss of a
 * message that would have decrypted a moment later. Frames from one sender
 * now run in arrival order, and the retry waits IN PLACE so the wait is
 * part of the first frame's handling; other senders are not held. */
describe('a sender\'s frames wait behind its store-busy retry', () => {
  const PREKEY = '01ARZ3NDEKTSV4RRFFQ69G5FA1';
  const CIPHER = '01ARZ3NDEKTSV4RRFFQ69G5FA2';
  const OTHER_PEER = '01OTHERZ3NDEKTSV4RRFFQ69G5';
  const OTHER = '01ARZ3NDEKTSV4RRFFQ69G5FA3';
  const BUSY = 'store busy (test)';

  function acks(): string[] {
    return ws.calls.send.mock.calls
      .map(c => c[0] as { type: string; msgId?: string })
      .filter(f => f.type === 'ack')
      .map(f => f.msgId!);
  }

  function msg(msgId: string, from: string, msgType: 'prekey' | 'ciphertext', ts: number): void {
    ws.handlers.frame?.({ type: 'msg', from, msgId, msgType, payload: 'AAAA', ts });
  }

  test('a ciphertext behind a busy-delayed prekey message decrypts after the retry: no error row, no premature ack, both imported in order', async () => {
    const busyMock = (crypto as unknown as { isStoreBusyError: jest.Mock }).isStoreBusyError;
    // A pass-through spy on the REAL insert. An earlier test in this file
    // leaves `insertMessage` rejecting ('db closed') and `clearAllMocks`
    // keeps implementations, so the leaked spy is restored first.
    jest.spyOn(db, 'insertMessage').mockRestore();
    const inserted = jest.spyOn(db, 'insertMessage');
    try {
      busyMock.mockImplementation((e: unknown) => e instanceof Error && e.message === BUSY);
      // The native store as the hazard sees it: PEER's session exists only
      // once the prekey message has been processed; OTHER_PEER's already does.
      let sessionEstablished = false;
      let prekeyAttempts = 0;
      crypto.decryptEnvelope.mockImplementation(
        async (_self: string, from: string, msgType: string) => {
          if (from !== PEER) return 'from someone else';
          if (msgType === 'prekey') {
            prekeyAttempts += 1;
            if (prekeyAttempts === 1) throw new Error(BUSY);
            sessionEstablished = true;
            return 'hello (prekey)';
          }
          if (!sessionEstablished) throw new Error('SessionNotFound');
          return 'hello again';
        },
      );

      await messaging.start(ME);
      await settle(400);
      ws.state.open = true;
      ws.calls.send.mockClear();

      msg(PREKEY, PEER, 'prekey', 1_700_000_000_000);
      await settle(400);
      msg(CIPHER, PEER, 'ciphertext', 1_700_000_000_001);
      await settle(400);
      // Inside the wait: the ciphertext has NOT been tried against a session
      // that is not there yet, and nothing is acked.
      expect(prekeyAttempts).toBe(1);
      expect(crypto.decryptEnvelope).toHaveBeenCalledTimes(1);
      expect(acks()).toEqual([]);
      expect(inserted).not.toHaveBeenCalled();

      // Another sender is not held behind PEER's wait.
      msg(OTHER, OTHER_PEER, 'ciphertext', 1_700_000_000_002);
      await settle(400);
      expect(acks()).toEqual([OTHER]);

      // The retry lands the prekey message, and only then the ciphertext.
      await new Promise<void>(resolve => setTimeout(resolve, 1_600));
      await settle(400);
      expect(prekeyAttempts).toBe(2);
      const rows = inserted.mock.calls
        .map(c => c[0] as { msgId: string; body: string; status: string })
        .filter(r => r.msgId === PREKEY || r.msgId === CIPHER);
      expect(rows.map(r => r.status)).not.toContain('error');
      expect(rows.map(r => r.body)).toEqual(['hello (prekey)', 'hello again']);
      expect(acks()).toEqual([OTHER, PREKEY, CIPHER]);
    } finally {
      inserted.mockRestore();
      crypto.decryptEnvelope.mockReset();
      busyMock.mockReset();
      busyMock.mockReturnValue(false);
    }
  });

  test('a relock during the wait releases the parked handler: nothing is written or acked afterwards', async () => {
    const busyMock = (crypto as unknown as { isStoreBusyError: jest.Mock }).isStoreBusyError;
    // A pass-through spy on the REAL insert. An earlier test in this file
    // leaves `insertMessage` rejecting ('db closed') and `clearAllMocks`
    // keeps implementations, so the leaked spy is restored first.
    jest.spyOn(db, 'insertMessage').mockRestore();
    const inserted = jest.spyOn(db, 'insertMessage');
    try {
      busyMock.mockImplementation((e: unknown) => e instanceof Error && e.message === BUSY);
      crypto.decryptEnvelope.mockRejectedValueOnce(new Error(BUSY));
      await messaging.start(ME);
      await settle(400);
      ws.state.open = true;
      ws.calls.send.mockClear();
      msg(PREKEY, PEER, 'prekey', 1_700_000_000_000);
      await settle(400);
      expect(crypto.decryptEnvelope).toHaveBeenCalledTimes(1);

      messaging.stop();
      await new Promise<void>(resolve => setTimeout(resolve, 1_700));
      await settle(400);
      // The wait was woken with "no": no second decrypt, no row, no ack.
      expect(crypto.decryptEnvelope).toHaveBeenCalledTimes(1);
      expect(inserted).not.toHaveBeenCalled();
      expect(acks()).toEqual([]);
    } finally {
      inserted.mockRestore();
      crypto.decryptEnvelope.mockReset();
      busyMock.mockReset();
      busyMock.mockReturnValue(false);
    }
  });
});
