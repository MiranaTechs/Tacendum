/**
 * TWO LIVE PANES, ONE COALESCED REQUERY WINDOW.
 *
 * Under the wide shell the chat list and an open thread are mounted
 * TOGETHER, and messaging.notify() fires on every receipt, inbound frame,
 * socket transition and attachment tick. Before the wide shell the list requeried on
 * EVERY notify (listChats + a getGroup per row + unread/mention/blocked
 * reads) while the thread coalesced its own requery into an 80ms window —
 * so a draining backlog would have cost N full list requeries beside one
 * thread requery: two live panes doubling per-notify SQLite work is exactly
 * the risk this file pins.
 *
 * This file asserts the contract, against the real App with both panes
 * mounted on an expanded window: a burst of notifies costs ONE list requery
 * and ONE thread requery, both landing after the shared 80ms window — and a
 * SECOND burst costs exactly one more of each (a window, not a one-shot).
 *
 * Real timers, on purpose: the coalescing is timer arithmetic, and a frozen
 * clock beside advancing timers is the shape that has hidden release
 * blockers before (the frozen-clock rule).
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
  onApiAuthRenewed: jest.fn(() => () => undefined),
  apiAuthChallenge: jest.fn().mockRejectedValue(new Error('network in test')),
  apiAuth: jest.fn().mockRejectedValue(new Error('network in test')),
  apiUploadKeys: jest.fn().mockRejectedValue(new Error('network in test')),
  apiGetPrekeyBundle: jest.fn().mockRejectedValue(new Error('network in test')),
  apiDeleteAccount: jest.fn().mockRejectedValue(new Error('network in test')),
  apiCreateAttachment: jest.fn().mockRejectedValue(new Error('network in test')),
  apiGetAttachmentUrl: jest.fn().mockRejectedValue(new Error('network in test')),
  apiTurnCredentials: jest.fn().mockRejectedValue(new Error('network in test')),
  apiRegisterPushToken: jest.fn().mockRejectedValue(new Error('network in test')),
  uploadBlob: jest.fn().mockRejectedValue(new Error('network in test')),
  downloadBlob: jest.fn().mockRejectedValue(new Error('network in test')),
  apiWsTicket: jest.fn().mockRejectedValue(new Error('network in test')),
}));

jest.mock('../src/decoy', () => ({
  syncDecoyProfile: jest.fn(async () => undefined),
  refreshDecoyTimestamps: jest.fn(async () => undefined),
}));

import React from 'react';
import { Dimensions } from 'react-native';
import ReactTestRenderer from 'react-test-renderer';
import App from '../App';
import * as calling from '../src/call';
import * as db from '../src/db';
import { AUTH_TOKEN_KEY, messaging } from '../src/messaging';
import { ChatListScreen } from '../src/screens/ChatListScreen';
import { ChatThreadScreen } from '../src/screens/ChatThreadScreen';
import { session } from '../src/session';

jest.setTimeout(120_000);

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
  hasIdentity: jest.Mock;
};

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

// --- fixture ----------------------------------------------------------------

const pad = (seed: string): string => (seed + '0'.repeat(26)).slice(0, 26);
const ME = pad('ME');
const PEER = pad('SAM');

const PROFILE: db.ProfileRow = {
  userId: ME,
  registrationId: 7,
  displayName: 'Avery',
  about: '',
  avatarB64: '',
  profileVersion: 0,
};

function setWindow(width: number, height: number) {
  Dimensions.set({ window: { width, height, scale: 2, fontScale: 2 } });
}
const initialDimensions = {
  window: { ...Dimensions.get('window') },
  screen: { ...Dimensions.get('screen') },
};

type Nav = (route: { name: string; [key: string]: unknown }) => void;
const devNav = () =>
  (globalThis as unknown as Record<string, unknown>).TacendumDevNav as Nav;

async function flush(): Promise<void> {
  for (let i = 0; i < 60; i++) await Promise.resolve();
}

/** The messaging change signal, exactly as a receipt or an inbound frame
 * raises it. Private on the class; the storm is the point of this file. */
const notify = () =>
  (messaging as unknown as { notify: () => void }).notify();

const mounted: ReactTestRenderer.ReactTestRenderer[] = [];

beforeEach(async () => {
  calling.resetCallingForTests();
  messaging.stop();
  await db.close();
  db.setWorkspace('real');
  session.setMode('real');
  crypto.__keychain.clear();
  crypto.hasIdentity.mockResolvedValue(true);
  sqlite.__sqlite.reset();
  bindRealEngine();
  crypto.__keychain.set(AUTH_TOKEN_KEY, 'token-1');
  await db.initDb();
  await db.saveProfile(PROFILE);
  await db.upsertChat(PEER, 'Sam');
  await db.close();
});

afterEach(async () => {
  await ReactTestRenderer.act(async () => {
    while (mounted.length) mounted.pop()!.unmount();
  });
  calling.resetCallingForTests();
  jest.restoreAllMocks();
  crypto.hasIdentity.mockResolvedValue(false);
  messaging.stop();
  await db.close();
  engine.close();
  Dimensions.set(initialDimensions);
});

test('a notify storm over two live panes costs ONE coalesced requery window per pane, per burst', async () => {
  setWindow(1024, 768);
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(React.createElement(App));
  });
  mounted.push(tree);
  await ReactTestRenderer.act(async () => {
    await flush();
  });
  await ReactTestRenderer.act(async () => {
    devNav()({ name: 'thread', peerId: PEER });
  });
  // Let both panes' mount-time refreshes settle before counting.
  await ReactTestRenderer.act(async () => {
    await new Promise<void>(resolve => setTimeout(() => resolve(), 200));
  });

  // BOTH panes are live: the two-pane premise, not an assumption.
  expect(tree.root.findAllByType(ChatListScreen).length).toBe(1);
  expect(tree.root.findAllByType(ChatThreadScreen).length).toBe(1);

  // The requery markers: the list's one listChats per refresh, the thread's
  // one listMessages per refresh. Spies count; behavior stays real.
  const listRequery = jest.spyOn(db, 'listChats');
  const threadRequery = jest.spyOn(db, 'listMessages');
  listRequery.mockClear();
  threadRequery.mockClear();

  // THE STORM: a draining backlog's worth of notifies, back to back.
  await ReactTestRenderer.act(async () => {
    for (let i = 0; i < 12; i++) notify();
  });
  // Inside the window nothing has requeried yet — the burst scheduled ONE
  // window per pane, it did not run twelve requeries.
  expect(listRequery).toHaveBeenCalledTimes(0);
  expect(threadRequery).toHaveBeenCalledTimes(0);

  // The window closes: one requery per pane. Not twelve, not two per pane.
  await ReactTestRenderer.act(async () => {
    await new Promise<void>(resolve => setTimeout(() => resolve(), 250));
  });
  expect(listRequery).toHaveBeenCalledTimes(1);
  expect(threadRequery).toHaveBeenCalledTimes(1);

  // A SECOND burst opens a second window — coalescing is per burst, not a
  // one-shot: the panes still repaint when the next drain arrives.
  listRequery.mockClear();
  threadRequery.mockClear();
  await ReactTestRenderer.act(async () => {
    for (let i = 0; i < 12; i++) notify();
  });
  await ReactTestRenderer.act(async () => {
    await new Promise<void>(resolve => setTimeout(() => resolve(), 250));
  });
  expect(listRequery).toHaveBeenCalledTimes(1);
  expect(threadRequery).toHaveBeenCalledTimes(1);
});
