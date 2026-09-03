/**
 * The @ badge in the chat list (the mentions contract): a room that mentioned
 * YOU says so — WhatsApp's @ — without opening the thread.
 *
 * Real-engine harness (ChatList.rooms.test.tsx's): the recorded op-sqlite
 * mock is rebound to Node's real SQLite, so `db.unreadRoomBodies`' actual
 * SQL — the joins, the tombstone filter, the lastOpenedAt window — is what
 * these assertions exercise, not a pattern-matched fake.
 *
 * What this file proves:
 *  - a room with an unread inbound mention of ME wears the badge, and the
 *    row's LABEL says "you were mentioned" — the mark is visual only;
 *  - a mention of someone ELSE lights nothing (the badge asserts a fact
 *    about me, checked against the parsed envelope's `who`);
 *  - a 1:1 never wears the badge, even fed a mention naming me — rooms
 *    only, a 1:1 has exactly one possible addressee;
 *  - a body that merely WEARS the mention shape (unparseable, or an empty
 *    `who`) cannot light it — the screen re-parses, it never trusts a
 *    prefix;
 *  - opening the room puts the badge down; a tombstoned mention does not
 *    keep summoning.
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

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import * as db from '../src/db';
import { MENTION_MARK } from '../src/envelope';
import { messaging } from '../src/messaging';
import { ChatListScreen } from '../src/screens/ChatListScreen';
import { createRoom } from '../src/screens/GroupCreateScreen';
import { session } from '../src/session';

// --- the real engine, bound under the recorded mock -------------------------

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
  encryptText: jest.Mock;
  hasSession: jest.Mock;
  randomBytes: jest.Mock;
};
const ws = (
  jest.requireMock('../src/ws') as {
    __ws: { calls: { send: jest.Mock }; state: { open: boolean } };
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

// --- ids and fixtures -------------------------------------------------------

const pad = (seed: string): string => (seed + '0'.repeat(26)).slice(0, 26);
const ME = pad('ME');
const BEN = pad('BEN');
const CARA = pad('CARA');

const PROFILE: db.ProfileRow = {
  userId: ME,
  registrationId: 7,
  displayName: '',
  about: '',
  avatarB64: '',
  profileVersion: 0,
};

async function flush(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

async function render(
  element: React.ReactElement,
): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(element);
  });
  await ReactTestRenderer.act(async () => {
    await flush();
  });
  return tree;
}

function byId(tree: ReactTestRenderer.ReactTestRenderer, id: string) {
  return tree.root.findAll(n => n.props.testID === id);
}

function listScreen() {
  return (
    <ChatListScreen
      profile={PROFILE}
      onOpenChat={jest.fn()}
      onOpenProfile={jest.fn()}
      onStartChat={jest.fn()}
      onStartRoom={jest.fn()}
    />
  );
}

/** A mention body exactly as the receive path stores it: unwrapped. */
const mention = (text: string, who: string[]): string =>
  JSON.stringify({ tcm: 'mention', text, who });

/** An inbound room message row, straight into the engine — the shape the
 * receive path writes (row id `${author}.${m}`; `seen` records the WIRE id,
 * which is exactly why the badge query must not join seen). */
function insertInbound(
  peerId: string,
  msgId: string,
  body: string,
  extra: { ts?: number; deletedAt?: number | null } = {},
): void {
  q(
    `INSERT INTO messages (msgId, peerId, direction, body, ts, status, deletedAt)
     VALUES (?, ?, 'in', ?, ?, 'received', ?)`,
    msgId,
    peerId,
    body,
    extra.ts ?? Date.now(),
    extra.deletedAt ?? null,
  );
}

async function roomWithMembers(): Promise<string> {
  await db.upsertChat(BEN, 'Ben');
  await db.upsertChat(CARA, 'Cara');
  const { groupId } = await createRoom(ME, 'Kitchen', [BEN, CARA]);
  await flush();
  return groupId;
}

beforeEach(async () => {
  messaging.stop();
  await db.close();
  crypto.__keychain.clear();
  sqlite.__sqlite.reset();
  crypto.encryptText.mockReset();
  crypto.encryptText.mockResolvedValue({ msgType: 'ciphertext', payload: 'AAAA' });
  crypto.hasSession.mockReset();
  crypto.hasSession.mockResolvedValue(true);
  let entropyCounter = 0;
  crypto.randomBytes.mockImplementation(async (count: number) => {
    const out = new Uint8Array(count);
    for (let i = 0; i < count; i++) out[i] = entropyCounter++ * 37 % 251;
    return out;
  });
  ws.calls.send.mockClear();
  ws.state.open = true;
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

// ---------------------------------------------------------------------------

test('a room that mentioned YOU wears the @ badge, and the row’s label says so in words', async () => {
  const groupId = await roomWithMembers();
  insertInbound(
    groupId,
    `${CARA}.M1`,
    mention(`${MENTION_MARK} soup?`, [ME]),
  );

  const tree = await render(listScreen());

  // Fixture sanity: the row is on screen at all.
  expect(byId(tree, `chat-${groupId}`).length).toBeGreaterThan(0);
  // The badge, and the WORD — the @ mark is visual only, so the fact
  // travels in the label (the room word's own rule).
  expect(byId(tree, `mention-badge-${groupId}`).length).toBeGreaterThan(0);
  const label = byId(tree, `chat-${groupId}`)[0]!.props
    .accessibilityLabel as string;
  expect(label).toContain('Kitchen, room');
  expect(label).toContain('you were mentioned');

  await ReactTestRenderer.act(() => {
    tree.unmount();
  });
});

test('a mention of someone ELSE lights nothing — `who` is checked against MY id, never taken on claim', async () => {
  const groupId = await roomWithMembers();
  insertInbound(
    groupId,
    `${CARA}.M1`,
    mention(`${MENTION_MARK} soup?`, [BEN]),
  );

  const tree = await render(listScreen());
  expect(byId(tree, `chat-${groupId}`).length).toBeGreaterThan(0);
  expect(byId(tree, `mention-badge-${groupId}`).length).toBe(0);
  expect(
    String(byId(tree, `chat-${groupId}`)[0]!.props.accessibilityLabel ?? ''),
  ).not.toContain('you were mentioned');

  await ReactTestRenderer.act(() => {
    tree.unmount();
  });
});

test('a 1:1 never wears the badge, even fed a mention naming me — rooms only', async () => {
  await db.upsertChat(BEN, 'Ben');
  insertInbound(BEN, 'W1', mention(`${MENTION_MARK} hey`, [ME]));

  const tree = await render(listScreen());
  expect(byId(tree, `chat-${BEN}`).length).toBeGreaterThan(0);
  expect(byId(tree, `mention-badge-${BEN}`).length).toBe(0);

  await ReactTestRenderer.act(() => {
    tree.unmount();
  });
});

test('a body that merely wears the mention shape cannot light the badge — the screen re-parses, it never trusts a prefix', async () => {
  const groupId = await roomWithMembers();
  // Truncated JSON that declares the kind, and a parseable envelope whose
  // `who` is empty (the schema refuses it): two ways to WEAR the shape.
  insertInbound(groupId, `${CARA}.M1`, `{"tcm":"mention","text":"hi ${ME}`);
  insertInbound(
    groupId,
    `${CARA}.M2`,
    JSON.stringify({ tcm: 'mention', text: `hi ${ME}`, who: [] }),
  );

  const tree = await render(listScreen());
  expect(byId(tree, `chat-${groupId}`).length).toBeGreaterThan(0);
  expect(byId(tree, `mention-badge-${groupId}`).length).toBe(0);

  await ReactTestRenderer.act(() => {
    tree.unmount();
  });
});

test('opening the room puts the badge down, and a tombstoned mention does not keep summoning', async () => {
  const groupId = await roomWithMembers();
  const said = Date.now();
  insertInbound(groupId, `${CARA}.M1`, mention(`${MENTION_MARK} soup?`, [ME]), {
    ts: said,
  });

  // Read: the thread stamps lastOpenedAt past the message.
  await db.markChatOpened(groupId, said + 1);
  const opened = await render(listScreen());
  expect(byId(opened, `chat-${groupId}`).length).toBeGreaterThan(0);
  expect(byId(opened, `mention-badge-${groupId}`).length).toBe(0);
  await ReactTestRenderer.act(() => {
    opened.unmount();
  });

  // A NEW mention relights it… unless it was retracted: a tombstone keeps
  // its place in the thread, but a deleted summons must not keep calling.
  insertInbound(
    groupId,
    `${CARA}.M2`,
    mention(`${MENTION_MARK} still there?`, [ME]),
    { ts: said + 10, deletedAt: said + 20 },
  );
  const after = await render(listScreen());
  expect(byId(after, `mention-badge-${groupId}`).length).toBe(0);
  await ReactTestRenderer.act(() => {
    after.unmount();
  });
});
