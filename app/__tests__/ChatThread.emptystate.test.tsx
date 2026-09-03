/**
 * The empty room is announced only once the thread KNOWS it is empty.
 *
 * THE DEFECT THIS FILE EXISTS FOR. `rows` starts as `` and the QuietRoom
 * plus its "This room is ready." header rendered whenever `rows.length === 0`
 * — so every open of a populated conversation flashed the empty state for
 * the frames before the list query landed, and VoiceOver announced a header
 * for a room that was not empty. The header now waits for the first answer.
 *
 * Harness copied from ChatThread.timer.test.tsx, with the list query held
 * open so the test decides when it answers. */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import * as db from '../src/db';
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

const READY = 'This room is ready.';

/** Every pending answer to the thread's list query. The screen asks more
 * than once on mount (its refresh runs for the mount and for the call state),
 * so each ask is parked and all are answered together. */
let pendingLists: Array<(rows: unknown[]) => void> = [];

beforeEach(async () => {
  await db.close();
  sqlite.reset();
  db.setWorkspace('real');
  await db.initDb();
  pendingLists = [];
  const instance = sqlite.instances.get('tacendum.sqlite')!;
  const base = instance.execute.getMockImplementation()!;
  instance.execute.mockImplementation(async (sql: string, params?: unknown) => {
    const s = String(sql);
    if (s.includes('FROM messages') && s.includes('ORDER BY ts, msgId')) {
      return new Promise(resolve => {
        pendingLists.push(rows => resolve({ rows }));
      });
    }
    return base(sql, params);
  });
});

afterEach(async () => {
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
  return tree;
}

async function answerLists(rows: unknown[]): Promise<void> {
  await ReactTestRenderer.act(async () => {
    for (const answer of pendingLists.splice(0)) answer(rows);
  });
  await ReactTestRenderer.act(async () => {});
}

/** Every string this screen actually draws. */
function renderedText(tree: ReactTestRenderer.ReactTestRenderer): string[] {
  return tree.root
    .findAllByType(require('react-native').Text)
    .map(n =>
      Array.isArray(n.props.children)
        ? n.props.children.join('')
        : String(n.props.children ?? ''),
    );
}

function readyHeaders(tree: ReactTestRenderer.ReactTestRenderer) {
  return tree.root.findAll(
    n => n.props.accessibilityRole === 'header' && n.props.children === READY,
  );
}

test('nothing is announced before the list answers; an empty answer shows the ready room', async () => {
  const tree = await renderThread();
  // The query is in flight: the screen has been asked and has not heard.
  expect(pendingLists.length).toBeGreaterThan(0);
  expect(readyHeaders(tree)).toHaveLength(0);
  expect(renderedText(tree)).not.toContain(READY);

  await answerLists([]);
  // Presence, not a count: the test renderer reports a composite AND a host
  // node for the one <Text>.
  expect(readyHeaders(tree).length).toBeGreaterThan(0);
  expect(renderedText(tree)).toContain(READY);

  await ReactTestRenderer.act(() => {
    tree.unmount();
  });
});

test('a populated conversation never flashes the empty state', async () => {
  const tree = await renderThread();
  expect(readyHeaders(tree)).toHaveLength(0);

  await answerLists([TEXT_IN]);
  expect(readyHeaders(tree)).toHaveLength(0);
  expect(renderedText(tree)).not.toContain(READY);
  expect(tree.root.findAllByProps({ testID: 'msg-01TEXTIN' }).length).toBeGreaterThan(0);

  await ReactTestRenderer.act(() => {
    tree.unmount();
  });
});
