/**
 * THE MESSAGE-ARRIVAL CHIME ("notification sound when
 * text comes in — we have one for when call comes in").
 *
 * Two halves:
 *
 *  1. THE RULE, pure (`chimeVerdict`): every gate in the order the module
 *     states it, each pinned by the one fact that trips it, plus the
 *     complement law with background.ts — an arrival is announced OR chimed,
 *     never both, never neither, for every app state.
 *
 *  2. THE CONTRACT, against the REAL engine (the messaging.groups.receive
 *     harness verbatim: the mocked op-sqlite connection is rebound to Node's
 *     real SQLite so the real db.ts SQL runs under the real messaging.ts):
 *     a 1:1 text and a room message reach `playMessageTone` from the ONE
 *     content switch; the open chat, a call, the switch off, a backgrounded
 *     app, a spooled import, the reconnect backlog, a burst, transport
 *     frames, and a stopped (relocked) service do not.
 *
 * No frozen clock anywhere (a frozen clock hides timing bugs): the burst and
 * reconnect windows are driven by real `Date.now()` deltas through the
 * module's own clock seams, never by pinning `now()` beside advancing timers.
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
    suspend() {}
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
  apiUploadKeys: jest.fn().mockRejectedValue(new Error('network in test')),
  apiGetPrekeyBundle: jest.fn().mockRejectedValue(new Error('network in test')),
  apiDeleteAccount: jest.fn().mockRejectedValue(new Error('network in test')),
  apiCreateAttachment: jest.fn().mockRejectedValue(new Error('network in test')),
  apiGetAttachmentUrl: jest.fn().mockRejectedValue(new Error('network in test')),
  uploadBlob: jest.fn().mockRejectedValue(new Error('network in test')),
  downloadBlob: jest.fn().mockRejectedValue(new Error('network in test')),
  apiWsTicket: jest.fn().mockRejectedValue(new Error('network in test')),
}));

jest.mock('../src/decoy', () => ({
  syncDecoyProfile: jest.fn(async () => undefined),
}));

import { AppState } from 'react-native';
import * as audio from 'tacendum-audio';
import * as db from '../src/db';
import {
  CHIME_BURST_MS,
  CHIME_QUIET_AFTER_OPEN_MS,
  MESSAGE_SOUND_FILE,
  chimeForArrival,
  chimeVerdict,
  clearFocusedConversation,
  noteTransportOpen,
  resetMessageSoundForTests,
  setFocusedConversation,
  setInCallProbe,
  setMessageSound,
  type ChimeFacts,
} from '../src/messageSound';
import { messaging } from '../src/messaging';
import { session } from '../src/session';

type Row = Record<string, unknown>;
interface Engine {
  prepare(sql: string): { all(...args: unknown[]): Row[] };
  close(): void;
}
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (p: string) => Engine;
};

interface FakeDb {
  name: string;
  execute: jest.Mock;
  close: jest.Mock;
}
const sqlite = jest.requireMock('@op-engineering/op-sqlite') as {
  open: (o: { name: string }) => FakeDb;
  __sqlite: { instances: Map<string, FakeDb>; reset: () => void };
};
const crypto = jest.requireMock('tacendum-crypto') as {
  __keychain: Map<string, string>;
  __sharedState: Map<string, string>;
  __inbox: Map<string, { msgId: string; from: string; ts: number; body: string }>;
  decryptEnvelope: jest.Mock;
  encryptText: jest.Mock;
  hasSession: jest.Mock;
};
const ws = (
  jest.requireMock('../src/ws') as {
    __ws: {
      handlers: { frame?: (f: unknown) => void; state?: (s: string) => void };
      calls: { send: jest.Mock };
    };
  }
).__ws;
const tone = (audio as unknown as { playMessageTone: jest.Mock }).playMessageTone;
const wait = (ms: number): Promise<void> =>
  new Promise<void>(resolve => {
    setTimeout(() => resolve(), ms);
  });
/** The preset's AppState mock is a plain object: its `currentState` is
 * assignable, which is how each case states where the person is. */
const appState = AppState as unknown as { currentState: unknown };

let engine: Engine;

function bindRealEngine(): void {
  engine = new DatabaseSync(':memory:');
  const instance = sqlite.open({ name: 'tacendum.sqlite' });
  instance.execute.mockImplementation(
    async (sql: unknown, params?: unknown[]) => {
      const args = (params ?? []).map(p => (p === undefined ? null : p));
      const rows = engine.prepare(String(sql)).all(...args);
      const changes = engine.prepare('SELECT changes() AS c').all()[0]!
        .c as number;
      return { rows, rowsAffected: changes };
    },
  );
}

const q = (sql: string, ...args: unknown[]): Row[] =>
  engine.prepare(sql).all(...args);

const pad = (seed: string): string => (seed + '0'.repeat(26)).slice(0, 26);
const ME = pad('ME');
const ANA = pad('ANA');
const BEN = pad('BEN');
const ROOM = pad('7R00M');
const mid = (seed: string): string => pad('M' + seed.toUpperCase());

let wireN = 0;
async function flush(): Promise<void> {
  for (let i = 0; i < 60; i++) await Promise.resolve();
}

async function deliver(text: string, from: string, wireId?: string): Promise<string> {
  const msgId = wireId ?? `01WIRE${String(++wireN).padStart(20, '0')}`;
  crypto.decryptEnvelope.mockResolvedValue(text);
  ws.handlers.frame?.({
    type: 'msg',
    from,
    msgId,
    msgType: 'ciphertext',
    payload: 'AAAA',
    ts: 9_000 + wireN,
  });
  await flush();
  return msgId;
}

const gNew = (g: string, ms: string[], n = 1, nm = 'Kitchen'): string =>
  JSON.stringify({ tcm: 'grp.new', g, nm, ms, n });
const gMsg = (g: string, m: string, b: string): string =>
  JSON.stringify({ tcm: 'grp.msg', g, m, sq: 1, b });

/** The facts of an ordinary live arrival: everything says "chime". */
const live: ChimeFacts = {
  enabled: true,
  mode: 'real',
  appState: 'active',
  spooled: false,
  focused: false,
  inCall: false,
  sinceOpenMs: CHIME_QUIET_AFTER_OPEN_MS * 10,
  sinceLastChimeMs: CHIME_BURST_MS * 10,
};

describe('the rule', () => {
  test('a live arrival chimes', () => {
    expect(chimeVerdict(live)).toBe('chime');
  });

  test.each<[string, Partial<ChimeFacts>, ReturnType<typeof chimeVerdict>]>([
    ['the switch is off', { enabled: false }, 'off'],
    ['a duress session', { mode: 'duress' }, 'duress'],
    ['the app is backgrounded', { appState: 'background' }, 'not_active'],
    ['the app is inactive (a pull-down, the switcher)', { appState: 'inactive' }, 'not_active'],
    ['the extension already announced it (spooled)', { spooled: true }, 'spooled'],
    ['the socket just opened — the drain is backlog', { sinceOpenMs: CHIME_QUIET_AFTER_OPEN_MS - 1 }, 'reconnect_backlog'],
    ['the conversation is on screen', { focused: true }, 'focused'],
    ['a call is up', { inCall: true }, 'in_call'],
    ['a chime just played — the burst rule', { sinceLastChimeMs: CHIME_BURST_MS - 1 }, 'burst'],
  ])('stays quiet when %s', (_, facts, verdict) => {
    expect(chimeVerdict({ ...live, ...facts })).toBe(verdict);
  });

  test('an unknown or absent app state reads as active — the background.ts convention', () => {
    // `undefined` is a test environment with no AppState; 'unknown' is the
    // transient the platform reports before the first transition. Both are
    // "here", exactly as announceIncoming reads them as "not away".
    expect(chimeVerdict({ ...live, appState: undefined })).toBe('chime');
    expect(chimeVerdict({ ...live, appState: 'unknown' })).toBe('chime');
  });

  test('the complement law: for every app state, announced XOR chimed', () => {
    // announceIncoming's own predicate, restated: away is exactly
    // 'background' or 'inactive'.
    const announced = (s: string | undefined): boolean =>
      s === 'background' || s === 'inactive';
    for (const s of ['active', 'background', 'inactive', 'unknown', 'extension', undefined] as const) {
      const chimed = chimeVerdict({ ...live, appState: s }) === 'chime';
      expect(chimed).toBe(!announced(s));
    }
  });

  test('the gates are ordered as the doctrine states them: the switch first, duress second, the screen last but one', () => {
    // All quiet reasons at once: the switch wins, because a person who
    // turned the sound off is owed silence before any other question.
    const everything: ChimeFacts = {
      enabled: false,
      mode: 'duress',
      appState: 'background',
      spooled: true,
      focused: true,
      inCall: true,
      sinceOpenMs: 0,
      sinceLastChimeMs: 0,
    };
    expect(chimeVerdict(everything)).toBe('off');
    expect(chimeVerdict({ ...everything, enabled: true })).toBe('duress');
    expect(chimeVerdict({ ...everything, enabled: true, mode: 'real' })).toBe('not_active');
  });
});

describe('the contract, against the real engine', () => {
  beforeEach(async () => {
    messaging.stop();
    await db.close();
    crypto.__keychain.clear();
    crypto.__sharedState.clear();
    crypto.__inbox.clear();
    sqlite.__sqlite.reset();
    crypto.encryptText.mockClear();
    crypto.decryptEnvelope.mockReset();
    crypto.hasSession.mockReset();
    crypto.hasSession.mockResolvedValue(true);
    ws.calls.send.mockClear();
    tone.mockClear();
    resetMessageSoundForTests();
    appState.currentState = 'active';
    session.setMode('real');
    db.setWorkspace('real');
    bindRealEngine();
    crypto.__keychain.set('authToken', 'token-1');
    await db.initDb();
    await messaging.start(ME);
    await flush();
    ws.calls.send.mockClear();
  });

  afterEach(async () => {
    messaging.stop();
    await db.close();
    engine.close();
    resetMessageSoundForTests();
    appState.currentState = 'active';
    session.setMode('real');
    db.setWorkspace('real');
  });

  test('a 1:1 text arriving while the app is open chimes once — after the row is stored', async () => {
    await deliver('hello', ANA);
    expect(tone).toHaveBeenCalledTimes(1);
    expect(q(`SELECT body FROM messages WHERE peerId = ?`, ANA)).toEqual([{ body: 'hello' }]);
  });

  test('a room message chimes through the same switch, keyed on the room', async () => {
    await deliver(gNew(ROOM, [ANA, ME]), ANA);
    tone.mockClear(); // the announcement row is an event, not a message
    await wait(CHIME_BURST_MS + 20);
    await deliver(gMsg(ROOM, mid('R1'), 'lunch?'), ANA);
    expect(tone).toHaveBeenCalledTimes(1);
  });

  test('the conversation on screen makes no sound; another one still does', async () => {
    setFocusedConversation(ANA);
    await deliver('reading this', ANA);
    expect(tone).not.toHaveBeenCalled();
    await deliver('but not this', BEN);
    expect(tone).toHaveBeenCalledTimes(1);
    // The thread closed: ANA chimes again (the burst window elapsed first).
    clearFocusedConversation(ANA);
    await wait(CHIME_BURST_MS + 20);
    await deliver('later', ANA);
    expect(tone).toHaveBeenCalledTimes(2);
  });

  test('a stale unmount cannot blank a newer thread’s focus', async () => {
    setFocusedConversation(ANA);
    setFocusedConversation(BEN); // the newer mount
    clearFocusedConversation(ANA); // the older unmount, arriving late
    await deliver('for ben', BEN);
    expect(tone).not.toHaveBeenCalled();
  });

  test('the injected call belt: a probe saying "call up" silences; a throwing probe reads as no call (native alone decides in prod until the call lane wires it)', async () => {
    // This pins the SEAM, not production: nothing injects the probe yet, so
    // in the app the native gate is the whole rule — CXCallObserver on iOS
    // (every CallKit-reported call), the audio mode on Android (answered
    // Telecom calls only). The call module's one line closes the rest.
    setInCallProbe(() => true);
    await deliver('ring ring', ANA);
    expect(tone).not.toHaveBeenCalled();
    // A probe that throws reads as "no call" — the native gate still holds.
    setInCallProbe(() => {
      throw new Error('probe');
    });
    await deliver('after', BEN);
    expect(tone).toHaveBeenCalledTimes(1);
  });

  test('the switch off: no sound, and the message still lands', async () => {
    await setMessageSound(false);
    expect(crypto.__sharedState.get(MESSAGE_SOUND_FILE)).toBe('0');
    await deliver('quiet', ANA);
    expect(tone).not.toHaveBeenCalled();
    expect(q(`SELECT body FROM messages WHERE peerId = ?`, ANA)).toEqual([{ body: 'quiet' }]);
  });

  test('the preference is loaded by messaging.start() — a relaunch honours the file', async () => {
    crypto.__sharedState.set(MESSAGE_SOUND_FILE, '0');
    messaging.stop();
    resetMessageSoundForTests(); // the process ends
    await messaging.start(ME);
    await flush();
    await deliver('after relaunch', ANA);
    expect(tone).not.toHaveBeenCalled();
  });

  test('backgrounded or inactive: the push/banner owns it — no chime', async () => {
    appState.currentState = 'background';
    await deliver('in a pocket', ANA);
    appState.currentState = 'inactive';
    await deliver('under the shade', BEN);
    expect(tone).not.toHaveBeenCalled();
  });

  test('a spooled import (the extension already announced it) is silent — the launch drain', async () => {
    messaging.stop();
    crypto.__inbox.set('01SPOOL00000000000000000001', {
      msgId: '01SPOOL00000000000000000001',
      from: ANA,
      ts: 8_000,
      body: 'decrypted while you were away',
    });
    await messaging.start(ME);
    await flush();
    expect(tone).not.toHaveBeenCalled();
    expect(q(`SELECT body FROM messages WHERE peerId = ?`, ANA)).toEqual([
      { body: 'decrypted while you were away' },
    ]);
  });

  test('the reconnect backlog is silent: arrivals right after a socket open do not chime', async () => {
    ws.handlers.state?.('open');
    await deliver('queued while away', ANA);
    expect(tone).not.toHaveBeenCalled();
    // The window is measured from the open, by the wall clock: an open
    // long enough ago no longer quiets anything.
    noteTransportOpen(Date.now() - CHIME_QUIET_AFTER_OPEN_MS - 1);
    await deliver('live again', BEN);
    expect(tone).toHaveBeenCalledTimes(1);
  });

  test('a burst chimes once', async () => {
    await deliver('one', ANA);
    await deliver('two', ANA);
    await deliver('three', BEN);
    expect(tone).toHaveBeenCalledTimes(1);
    expect(q(`SELECT COUNT(*) AS n FROM messages`)).toEqual([{ n: 3 }]);
  });

  test('transport never chimes: a reaction, a read receipt, an edit of nothing', async () => {
    // Well-shaped carriers (envelope.ts's schemas): a malformed one would
    // parse as TEXT and land — and chime — which is the honest reading of
    // bytes that announce no structure the app can name.
    await deliver(JSON.stringify({ tcm: 'react', ref: mid('X'), ofs: false, emoji: '👍' }), ANA);
    await deliver(JSON.stringify({ tcm: 'read', ids: [mid('X')] }), ANA);
    await deliver(JSON.stringify({ tcm: 'edit', ref: mid('X'), text: 'x' }), ANA);
    expect(tone).not.toHaveBeenCalled();
    expect(q(`SELECT COUNT(*) AS n FROM messages`)).toEqual([{ n: 0 }]);
  });

  test('a stopped service (relock) delivers nothing and chimes nothing — the lock gains no signal', async () => {
    messaging.stop();
    await deliver('behind the lock', ANA);
    expect(tone).not.toHaveBeenCalled();
    expect(q(`SELECT COUNT(*) AS n FROM messages`)).toEqual([{ n: 0 }]);
  });

  test('a duress session cannot even start the service — the decoy gains no signal', async () => {
    messaging.stop();
    session.setMode('duress');
    await expect(messaging.start(ME)).rejects.toThrow('messaging unavailable');
    expect(await chimeForArrival({ convId: ANA, spooled: false })).toBe('duress');
    expect(tone).not.toHaveBeenCalled();
  });

  test('the tone rejecting never fails a delivery', async () => {
    tone.mockRejectedValueOnce(new Error('AudioServices said no'));
    await deliver('still lands', ANA);
    expect(q(`SELECT body FROM messages WHERE peerId = ?`, ANA)).toEqual([{ body: 'still lands' }]);
    expect(ws.calls.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'ack' }));
  });
});
