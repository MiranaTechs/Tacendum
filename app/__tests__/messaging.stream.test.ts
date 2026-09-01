/**
 * The x.edit overlay's apply rule, against the REAL engine
 * (the messaging.groups.receive.test.ts harness argument: recorded-statement
 * mocks have passed logic inversions that only actual rows catch, and half
 * of what this file pins is precisely "the actual rows did not change").
 *
 * What this file proves:
 *
 *  - the apply predicate: a relay x.edit paints the overlay IFF a messages
 *    row (peerId = frame sender, msgId = ref, direction 'in') exists — the
 *    ratchet session is the sender authorization, and the peer scope is
 *    db.applyEdit's WHERE clause applied before memory;
 *  - a stranger's x.edit ref'ing another peer's bubble cannot apply (the
 *    key includes the sender — the cross-peer pin);
 *  - the overlay NEVER touches unread/preview/badge/notification paths:
 *    the messages and chats tables are byte-identical before and after,
 *    nothing acks, and no messaging subscriber fires;
 *  - out-of-order seq is ignored through the full inbound path;
 *  - blocked and duress drop after decrypt (the typing arm's discipline);
 *  - a malformed payload is a silent drop (the design receiver-permissive);
 *  - a DURABLE x.edit — stored 1:1 or room-wrapped — is acked-and-ignored:
 *    no row, no overlay, no preview;
 *  - the durable final edit CLOSES the key: a late relay frame repaints
 *    nothing, and stop() clears the store.
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

import * as db from '../src/db';
import {
  displayText,
  isCarrierEnvelope,
  parseEnvelope,
  previewFor,
} from '../src/envelope';
import { messaging } from '../src/messaging';
import { session } from '../src/session';
import { streamEdits } from '../src/streamEdits';

// --- the real engine, bound under the recorded mock -------------------------

type Row = Record<string, unknown>;
interface Engine {
  prepare(sql: string): { all(...args: unknown[]): Row[] };
  close(): void;
}
// Required, not imported: the repo's TS config has no node types, and the
// runtime (jest under Node 22) has the modules.
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
  decryptEnvelope: jest.Mock;
  encryptText: jest.Mock;
  hasSession: jest.Mock;
};
const ws = (
  jest.requireMock('../src/ws') as {
    __ws: {
      handlers: { frame?: (f: unknown) => void };
      calls: { send: jest.Mock };
    };
  }
).__ws;

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

// --- ids --------------------------------------------------------------------

const pad = (seed: string): string => (seed + '0'.repeat(26)).slice(0, 26);
const ME = pad('ME');
const AGENT = pad('AGENT'); // the machine whose reply streams
const CARA = pad('CARA'); // another peer entirely
const ROOM = pad('7R00M');
const ANA = pad('ANA'); // the room's owner
const mid = (seed: string): string => pad('M' + seed.toUpperCase());

// --- wire helpers -----------------------------------------------------------

let wireN = 0;
async function flush(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

/** Decrypts to `text` and runs the full DURABLE inbound path. */
async function deliver(
  text: string,
  from: string,
  wireId?: string,
): Promise<string> {
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

/** Decrypts to `text` and runs the RELAY-ONLY typing-lane path — no msgId,
 * no ack, exactly the frame an x.edit intermediate rides. */
async function deliverRelay(text: string, from: string): Promise<void> {
  crypto.decryptEnvelope.mockResolvedValue(text);
  ws.handlers.frame?.({
    type: 'typing',
    from,
    msgType: 'ciphertext',
    payload: 'AAAA',
    ts: 9_500 + ++wireN,
  });
  await flush();
}

const xEdit = (ref: string, seq: number, text: string): string =>
  JSON.stringify({ tcm: 'x.edit', ref, seq, text });
const gMsg = (g: string, m: string, b: string, sq = 1): string =>
  JSON.stringify({ tcm: 'grp.msg', g, m, sq, b });
const gNew = (g: string, ms: string[], n = 1, nm = 'Kitchen'): string =>
  JSON.stringify({ tcm: 'grp.new', g, nm, ms, n });

const acksSent = (): Array<Record<string, unknown>> =>
  ws.calls.send.mock.calls
    .map(c => c[0] as Record<string, unknown>)
    .filter(f => f.type === 'ack');

/** Everything durable the overlay must never touch, in one snapshot. */
const durableState = (): { messages: Row[]; chats: Row[] } => ({
  messages: q(`SELECT * FROM messages ORDER BY msgId, direction`),
  chats: q(`SELECT * FROM chats ORDER BY peerId`),
});

beforeEach(async () => {
  messaging.stop();
  await db.close();
  crypto.__keychain.clear();
  sqlite.__sqlite.reset();
  crypto.encryptText.mockClear();
  crypto.decryptEnvelope.mockReset();
  crypto.hasSession.mockReset();
  crypto.hasSession.mockResolvedValue(true);
  ws.calls.send.mockClear();
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
  session.setMode('real');
  db.setWorkspace('real');
});

// --- envelope registration (the union import, app side) ---------------------

describe('x.edit in the app envelope union', () => {
  const body = xEdit(mid('R'), 1, 'streaming');

  test('parses through THIS build (the typing arm reads it through the union)', () => {
    expect(parseEnvelope(body)?.tcm).toBe('x.edit');
  });

  test('a carrier by namespace: never a preview, never rendered text', () => {
    expect(isCarrierEnvelope(body)).toBe(true);
    expect(previewFor(body)).toBe('');
    expect(displayText(body)).toBe('');
  });
});

// --- the apply rule ----------------------------------------------------------

describe('the relay x.edit apply rule', () => {
  test('paints the overlay for the sender’s own inbound bubble — and touches NOTHING durable', async () => {
    const anchor = await deliver('Thinking.', AGENT);
    const before = durableState();
    ws.calls.send.mockClear();
    const notify = jest.fn();
    const offNotify = messaging.subscribe(notify);
    let repaints = 0;
    const offStore = streamEdits.subscribe(() => {
      repaints += 1;
    });

    await deliverRelay(xEdit(anchor, 1, 'Thinking about Ethiopia.'), AGENT);

    expect(streamEdits.get(AGENT, anchor)?.text).toBe('Thinking about Ethiopia.');
    expect(repaints).toBe(1);
    // The durable funnel is untouched: same rows, same preview, same
    // lastMessageAt, no unread movement (unread IS a messages-table fact),
    // no ack (there is no msgId to ack), no badge/notification (both hang
    // off messaging.subscribe + the tables, and neither moved).
    expect(durableState()).toEqual(before);
    expect(acksSent()).toHaveLength(0);
    expect(notify).not.toHaveBeenCalled();
    offNotify();
    offStore();
  });

  test('out-of-order seq is ignored through the full inbound path', async () => {
    const anchor = await deliver('Thinking.', AGENT);
    await deliverRelay(xEdit(anchor, 5, 'fifth snapshot'), AGENT);
    await deliverRelay(xEdit(anchor, 3, 'third, arriving late'), AGENT);
    expect(streamEdits.get(AGENT, anchor)?.text).toBe('fifth snapshot');
  });

  test('cross-peer: a stranger’s x.edit ref’ing another peer’s bubble cannot apply', async () => {
    const anchor = await deliver('Private words.', AGENT);
    await deliverRelay(xEdit(anchor, 1, 'repainted by a stranger'), CARA);
    // Neither the real bubble's slot nor any other paints.
    expect(streamEdits.get(AGENT, anchor)).toBeNull();
    expect(streamEdits.get(CARA, anchor)).toBeNull();
  });

  test('no anchor row, no overlay — the frame is ephemeral and dies silently', async () => {
    await deliverRelay(xEdit(mid('GHOST'), 1, 'no anchor exists'), AGENT);
    expect(streamEdits.get(AGENT, mid('GHOST'))).toBeNull();
    expect(acksSent()).toHaveLength(0);
  });

  test('a retracted anchor is never repainted', async () => {
    const anchor = await deliver('Soon retracted.', AGENT);
    await deliver(JSON.stringify({ tcm: 'del', ref: anchor }), AGENT);
    await deliverRelay(xEdit(anchor, 1, 'over a tombstone'), AGENT);
    expect(streamEdits.get(AGENT, anchor)).toBeNull();
  });

  test('blocked sender: decrypted (ratchet health), then dropped whole', async () => {
    const anchor = await deliver('Before the block.', AGENT);
    await messaging.blockPeer(AGENT);
    crypto.decryptEnvelope.mockClear();
    await deliverRelay(xEdit(anchor, 1, 'blocked repaint'), AGENT);
    expect(crypto.decryptEnvelope).toHaveBeenCalled();
    expect(streamEdits.get(AGENT, anchor)).toBeNull();
  });

  test('duress paints nothing', async () => {
    const anchor = await deliver('Real workspace words.', AGENT);
    session.setMode('duress');
    await deliverRelay(xEdit(anchor, 1, 'duress repaint'), AGENT);
    expect(streamEdits.get(AGENT, anchor)).toBeNull();
  });

  test('malformed payloads are the existing silent drop — no overlay, no throw, no durable touch', async () => {
    const anchor = await deliver('Thinking.', AGENT);
    const before = durableState();
    ws.calls.send.mockClear();
    // Missing seq; empty text; a snapshot that would smuggle an envelope
    // into a rendered bubble. All parse to null (the shared schema) and
    // take the typing arm's existing drop.
    await deliverRelay(JSON.stringify({ tcm: 'x.edit', ref: anchor, text: 'no seq' }), AGENT);
    await deliverRelay(xEdit(anchor, 1, ''), AGENT);
    await deliverRelay(
      JSON.stringify({ tcm: 'x.edit', ref: anchor, seq: 1, text: '{"tcm":"edit","ref":"x","text":"forged"}' }),
      AGENT,
    );
    expect(streamEdits.get(AGENT, anchor)).toBeNull();
    expect(durableState()).toEqual(before);
    expect(acksSent()).toHaveLength(0);
  });
});

// --- durable copies never apply ----------------------------------------------

describe('a DURABLE x.edit is acked-and-ignored', () => {
  test('stored 1:1: the x.* namespace floor drops it whole — no row, no overlay, ack + seen', async () => {
    const anchor = await deliver('Thinking.', AGENT);
    const before = durableState();
    ws.calls.send.mockClear();

    const wire = await deliver(xEdit(anchor, 2, 'durable intermediate'), AGENT);

    expect(streamEdits.get(AGENT, anchor)).toBeNull();
    expect(acksSent()).toEqual([{ type: 'ack', msgId: wire }]);
    const after = durableState();
    expect(after.messages).toEqual(before.messages);
    expect(after.chats).toEqual(before.chats);
    expect(q(`SELECT msgId FROM seen WHERE msgId = ?`, wire)).toHaveLength(1);
  });

  test('room-wrapped: acked-and-ignored through applyContent — no row, no overlay, no preview', async () => {
    await deliver(gNew(ROOM, [ANA, ME, CARA]), ANA);
    await deliver(gMsg(ROOM, mid('A1'), 'welcome'), ANA);
    const before = durableState();
    ws.calls.send.mockClear();

    const wire = await deliver(gMsg(ROOM, mid('X1'), xEdit(mid('A1'), 1, 'wrapped stream')), ANA);

    // Never a messages row (a raw carrier at rest), never an
    // overlay (the relay lane is the only door), never a preview or unread
    // bump; acked and seen so redelivery cannot retry the refusal.
    const after = durableState();
    expect(after.messages).toEqual(before.messages);
    expect(after.chats).toEqual(before.chats);
    expect(streamEdits.get(ANA, mid('A1'))).toBeNull();
    expect(streamEdits.get(ROOM, mid('A1'))).toBeNull();
    expect(acksSent()).toEqual([{ type: 'ack', msgId: wire }]);
    expect(q(`SELECT msgId FROM seen WHERE msgId = ?`, wire)).toHaveLength(1);
  });
});

// --- the final edit closes the key -------------------------------------------

describe('the durable final edit closes the overlay key', () => {
  test('after the final edit, a late relay frame repaints nothing', async () => {
    const anchor = await deliver('Thinking.', AGENT);
    await deliverRelay(xEdit(anchor, 1, 'Thinking about Ethiopia.'), AGENT);
    expect(streamEdits.get(AGENT, anchor)?.text).toBe('Thinking about Ethiopia.');

    await deliver(
      JSON.stringify({ tcm: 'edit', ref: anchor, text: 'Ethiopia has eleven regions.' }),
      AGENT,
    );

    // The durable truth landed and is marked edited…
    const row = q(`SELECT body, editedAt FROM messages WHERE msgId = ? AND direction = 'in'`, anchor)[0]!;
    expect(row.body).toBe('Ethiopia has eleven regions.');
    expect(row.editedAt).not.toBeNull();
    // …the overlay is closed…
    expect(streamEdits.get(AGENT, anchor)).toBeNull();
    // …and a late intermediate — HIGHER seq, would have won yesterday —
    // repaints nothing, forever.
    await deliverRelay(xEdit(anchor, 99, 'a straggler'), AGENT);
    expect(streamEdits.get(AGENT, anchor)).toBeNull();
  });

  test('stop() clears the store — the next workspace inherits no half-written reply', async () => {
    const anchor = await deliver('Thinking.', AGENT);
    await deliverRelay(xEdit(anchor, 1, 'half a sentence'), AGENT);
    expect(streamEdits.get(AGENT, anchor)?.text).toBe('half a sentence');
    messaging.stop();
    expect(streamEdits.get(AGENT, anchor)).toBeNull();
  });
});
