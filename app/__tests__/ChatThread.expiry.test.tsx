/**
 * A disappearing message disappears WHILE the thread is open.
 *
 * THE DEFECT THIS FILE EXISTS FOR. The expiry sweep ran once, when the thread
 * mounted, and never again: a message whose timer ran out while the person
 * was looking at it stayed on glass until they left and came back. The thread
 * now arms one timer at the soonest `expiresAt` among its rows — the
 * typists-expiry pattern — and sweeps again when the app comes forward.
 *
 * Modern fake timers with the system clock advanced in lock-step: the timer
 * and every Date.now() it is compared against move together (the frozen-clock
 * ruling).
 *
 * Harness copied from ChatThread.timer.test.tsx; the sweep itself is
 * messaging's and is stood in for here — this file pins the thread's wiring
 * to it, not the store's DELETE. */

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
const EXPIRES_IN_MS = 5_000;

function fixtures() {
  return [
    {
      msgId: '01EXPIRING',
      peerId: 'peer-1',
      direction: 'in',
      body: 'gone in five seconds',
      ts: T0 - 60_000,
      status: 'received',
      expiresAt: T0 + EXPIRES_IN_MS,
    },
    {
      msgId: '01KEEPS',
      peerId: 'peer-1',
      direction: 'in',
      body: 'stays',
      ts: T0 - 30_000,
      status: 'received',
      expiresAt: null,
    },
  ];
}

/** What the store currently holds; the stand-in sweep removes from it. */
let live: ReturnType<typeof fixtures> = [];
let sweep: jest.SpyInstance;
let appStateListeners: Array<(next: string) => void> = [];

beforeEach(async () => {
  jest.useFakeTimers();
  jest.setSystemTime(T0);
  live = fixtures();
  appStateListeners = [];
  jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation(((_type: string, fn: (next: string) => void) => {
      appStateListeners.push(fn);
      return { remove: jest.fn() };
    }) as unknown as typeof AppState.addEventListener);
  sweep = jest.spyOn(messaging, 'sweepDisappearing').mockImplementation(async () => {
    const now = Date.now();
    live = live.filter(r => r.expiresAt === null || r.expiresAt > now);
  });
  await db.close();
  sqlite.reset();
  db.setWorkspace('real');
  await db.initDb();
  const instance = sqlite.instances.get('tacendum.sqlite')!;
  const base = instance.execute.getMockImplementation()!;
  instance.execute.mockImplementation(async (sql: string, params?: unknown) => {
    if (String(sql).includes('FROM messages')) {
      return { rows: live.map(r => ({ ...r })) };
    }
    return base(sql, params);
  });
});

afterEach(async () => {
  jest.restoreAllMocks();
  await db.close();
  jest.useRealTimers();
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

/** Move the clock and the timers together, then let the requery settle. */
async function elapse(ms: number): Promise<void> {
  await ReactTestRenderer.act(async () => {
    jest.setSystemTime(Date.now() + ms);
    jest.advanceTimersByTime(ms);
  });
  await ReactTestRenderer.act(async () => {});
  await ReactTestRenderer.act(async () => {});
}

const onGlass = (tree: ReactTestRenderer.ReactTestRenderer, msgId: string) =>
  tree.root.findAllByProps({ testID: `msg-${msgId}` }).length > 0;

test('a row past its expiresAt leaves the glass without a remount', async () => {
  const tree = await renderThread();
  expect(onGlass(tree, '01EXPIRING')).toBe(true);
  expect(onGlass(tree, '01KEEPS')).toBe(true);
  // The mount sweep (already there before this fix) is not the one under
  // test: count from here.
  sweep.mockClear();

  // Just short of the deadline: still there, and no sweep has fired.
  await elapse(EXPIRES_IN_MS - 500);
  expect(onGlass(tree, '01EXPIRING')).toBe(true);
  expect(sweep).not.toHaveBeenCalled();

  // Past it: the thread's own timer sweeps and requeries.
  await elapse(1_000);
  expect(sweep).toHaveBeenCalledWith('peer-1');
  expect(onGlass(tree, '01EXPIRING')).toBe(false);
  expect(onGlass(tree, '01KEEPS')).toBe(true);

  await ReactTestRenderer.act(() => {
    tree.unmount();
  });
});

test('coming to the foreground sweeps again — a pocketed phone missed its timer', async () => {
  const tree = await renderThread();
  sweep.mockClear();

  // Backgrounded: the JS timer may never fire while the app is suspended,
  // so the clock moves past the deadline without it.
  await ReactTestRenderer.act(async () => {
    for (const listener of [...appStateListeners]) listener('background');
  });
  await ReactTestRenderer.act(async () => {
    jest.setSystemTime(Date.now() + EXPIRES_IN_MS + 60_000);
  });
  expect(onGlass(tree, '01EXPIRING')).toBe(true);

  await ReactTestRenderer.act(async () => {
    for (const listener of [...appStateListeners]) listener('active');
  });
  await ReactTestRenderer.act(async () => {});
  await ReactTestRenderer.act(async () => {});
  expect(sweep).toHaveBeenCalledWith('peer-1');
  expect(onGlass(tree, '01EXPIRING')).toBe(false);
  expect(onGlass(tree, '01KEEPS')).toBe(true);

  await ReactTestRenderer.act(() => {
    tree.unmount();
  });
});
