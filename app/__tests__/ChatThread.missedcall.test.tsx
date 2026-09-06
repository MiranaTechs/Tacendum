/**
 * A missed call stops nagging when you open the conversation.
 *
 * The defect this pins: `clearMissedCallNotices` shipped with exactly one
 * caller — `CallsScreen.tsx:117`, passing `null` — so a notice raised for
 * one person came down only by visiting the Calls tab. Opening their
 * conversation and reading the missed-call row left it standing.
 *
 * What is pinned here:
 * - opening a thread clears THAT peer's notices, named, and nobody else's;
 * - switching to another conversation clears the new peer's;
 * - coming back to the foreground clears again, because a notice can be
 * raised while the thread is open and pocketed — and nothing is asked
 * while the phone is away, the same gate the read receipt keeps;
 * - a bridge that refuses costs the notice, never the screen.
 *
 * The bridge, not the module: `import * as native` is a per-importer copy
 * under the RN babel preset, so a method planted on the `tacendum-call` mock
 * from here would never reach `call/index.ts`. `missedCallBridge` is that
 * file's own documented seam and is what a test may spy on.
 *
 * Harness copied from ChatThread.read.test.tsx (the AppState note there).
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { AppState } from 'react-native';
import * as db from '../src/db';
import { missedCallBridge } from '../src/call';
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

const T0 = new Date('2026-09-05T12:00:00').getTime();

const TEXT_IN = {
  msgId: '01TEXTIN',
  peerId: 'peer-1',
  direction: 'in',
  body: 'are you there?',
  ts: T0,
  status: 'received',
  editedAt: null,
  deletedAt: null,
};

let appStateListeners: Array<(next: string) => void> = [];
let priorState: unknown;
let clear: jest.SpyInstance;

beforeEach(async () => {
  // RN's jest mock leaves AppState.currentState as a mock FUNCTION, which
  // the screen's foreground guard reads as "not active".
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
  clear = jest.spyOn(missedCallBridge, 'clear').mockResolvedValue(undefined);
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

async function renderThread(
  peerId = 'peer-1',
): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <ChatThreadScreen
        peerId={peerId}
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

test('opening a conversation clears that peer’s notices, and names the peer', async () => {
  const tree = await renderThread();
  expect(clear).toHaveBeenCalledWith('peer-1');
  // Never the blanket clear: this thread answers for one person, and the
  // Calls tab is the surface that answers for everybody.
  expect(clear).not.toHaveBeenCalledWith('');
  await ReactTestRenderer.act(() => {
    tree.unmount();
  });
});

test('switching conversations clears the new peer’s notices', async () => {
  const tree = await renderThread();
  clear.mockClear();

  await ReactTestRenderer.act(async () => {
    tree.update(
      <ChatThreadScreen
        peerId="peer-2"
        onBack={jest.fn()}
        onOpenPeerProfile={jest.fn()}
        onOpenPhoto={jest.fn()}
      />,
    );
  });
  await ReactTestRenderer.act(async () => {});

  expect(clear).toHaveBeenCalledWith('peer-2');
  await ReactTestRenderer.act(() => {
    tree.unmount();
  });
});

test('nothing is cleared while the phone is pocketed, and it clears again on return', async () => {
  const tree = await renderThread();
  clear.mockClear();

  await transition('background');
  expect(clear).not.toHaveBeenCalled();

  await transition('active');
  expect(clear).toHaveBeenCalledWith('peer-1');
  await ReactTestRenderer.act(() => {
    tree.unmount();
  });
});

test('a bridge that refuses costs the notice, never the screen', async () => {
  clear.mockImplementation(() => {
    throw new TypeError('native.clearMissedCall is not a function');
  });
  const tree = await renderThread();
  // The thread rendered anyway: an older binary under a newer bundle has no
  // such method, and that must cost the notice and nothing else.
  expect(
    tree.root.findAll(n => n.props.testID === 'thread-back').length,
  ).toBeGreaterThan(0);
  await ReactTestRenderer.act(() => {
    tree.unmount();
  });
});

test('the tacendum-call mock answers the three missed-call methods', () => {
  // The debt the audit named as the reason nobody could test this: the mock
  // lacked `postMissedCall`, `clearMissedCall` and `answerReportedCall`, so
  // every path through them threw a TypeError that the callers swallowed.
  const native = jest.requireMock('tacendum-call') as Record<string, unknown>;
  expect(typeof native.postMissedCall).toBe('function');
  expect(typeof native.clearMissedCall).toBe('function');
  expect(typeof native.answerReportedCall).toBe('function');
});
