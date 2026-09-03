/**
 * The read receipt is sent again when the app comes forward with the thread
 * open.
 *
 * THE DEFECT THIS FILE EXISTS FOR. The receipt effect early-returned on
 * `AppState.currentState !== 'active'` but subscribed to nothing, so a
 * message that arrived while the phone was in a pocket — correctly NOT
 * receipted then — was never receipted when the person brought the thread
 * back up, because nothing re-ran the effect. Foreground state is now React
 * state fed by an AppState listener, and the effect keys on it.
 *
 * `sendReadReceipt` itself is stood in for: its five gates (the setting,
 * blocking, duress, rooms, nothing new) are messaging's and are pinned in
 * messaging.read.test.ts. This file pins WHEN the thread asks.
 *
 * Harness copied from ChatThread.room.test.tsx (the AppState note there).
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { AppState } from 'react-native';
import * as db from '../src/db';
import { messaging } from '../src/messaging';
import { ChatThreadScreen } from '../src/screens/ChatThreadScreen';

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

const T0 = new Date('2026-09-02T12:00:00').getTime();

const TEXT_IN = {
  msgId: '01TEXTIN',
  peerId: 'peer-1',
  direction: 'in',
  body: 'see the garden',
  ts: T0,
  status: 'received',
};

let appStateListeners: Array<(next: string) => void> = [];
let priorState: unknown;

beforeEach(async () => {
  // RN's jest mock leaves AppState.currentState as a mock FUNCTION, which
  // the screen's foreground guard reads as "not active" — so without this
  // the receipt is suppressed by the wrong gate.
  priorState = AppState.currentState;
  Object.defineProperty(AppState, 'currentState', {
    value: 'active',
    configurable: true,
    writable: true,
  });
  appStateListeners = [];
  jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation(((_type: string, fn: (next: string) => void) => {
      appStateListeners.push(fn);
      return { remove: jest.fn() };
    }) as unknown as typeof AppState.addEventListener);
  await db.close();
  sqlite.reset();
  db.setWorkspace('real');
  await db.initDb();
  const instance = sqlite.instances.get('tacendum.sqlite')!;
  const base = instance.execute.getMockImplementation()!;
  instance.execute.mockImplementation(async (sql: string, params?: unknown) => {
    if (String(sql).includes('FROM messages')) {
      return { rows: [TEXT_IN] };
    }
    return base(sql, params);
  });
});

afterEach(async () => {
  jest.restoreAllMocks();
  Object.defineProperty(AppState, 'currentState', {
    value: priorState,
    configurable: true,
    writable: true,
  });
  await db.close();
});

async function renderThread(): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <ChatThreadScreen
        peerId="peer-1"
        onBack={jest.fn()}
        onOpenPeerProfile={jest.fn()}
        onOpenPhoto={jest.fn()}
      />,
    );
  });
  await ReactTestRenderer.act(async () => {});
  await ReactTestRenderer.act(async () => {});
  return tree;
}

async function transition(state: 'background' | 'active'): Promise<void> {
  await ReactTestRenderer.act(async () => {
    for (const listener of [...appStateListeners]) listener(state);
  });
  await ReactTestRenderer.act(async () => {});
}

test('the receipt goes on open, and again when the app returns to the foreground', async () => {
  const receipt = jest.spyOn(messaging, 'sendReadReceipt').mockResolvedValue();
  const tree = await renderThread();
  expect(receipt).toHaveBeenCalledWith('peer-1');

  receipt.mockClear();
  await transition('background');
  // Nothing while pocketed: a message nobody is looking at is not read.
  expect(receipt).not.toHaveBeenCalled();

  await transition('active');
  expect(receipt).toHaveBeenCalledWith('peer-1');

  await ReactTestRenderer.act(() => {
    tree.unmount();
  });
});

test('a thread opened in the background sends nothing until the app is forward', async () => {
  Object.defineProperty(AppState, 'currentState', {
    value: 'background',
    configurable: true,
    writable: true,
  });
  const receipt = jest.spyOn(messaging, 'sendReadReceipt').mockResolvedValue();
  const tree = await renderThread();
  expect(receipt).not.toHaveBeenCalled();

  await transition('active');
  expect(receipt).toHaveBeenCalledWith('peer-1');

  await ReactTestRenderer.act(() => {
    tree.unmount();
  });
});
