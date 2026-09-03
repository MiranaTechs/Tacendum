/**
 * An open reaction rail is never left hidden behind the keyboard.
 *
 * THE DEFECT THIS FILE EXISTS FOR. The rail is revealed by scrolling its row
 * to the BOTTOM of the viewport; the keyboard then shrinks the list from
 * that same edge, and the re-anchor that would have brought the row back is
 * deliberately skipped while a rail is open. Focusing the composer closed
 * the drawers but not the rail — so the rail sat open, off glass, under the
 * keyboard. The composer's focus now closes the rail as well: the person has
 * moved on to typing, and a selection they cannot see is not a selection.
 *
 * What the keyboard actually covers is a device fact; this pins the screen's
 * side of it.
 *
 * Harness copied from ChatThread.voice.test.tsx. */

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

beforeEach(async () => {
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

const railOpen = (tree: ReactTestRenderer.ReactTestRenderer) =>
  tree.root.findAllByProps({ testID: 'react-❤️' }).length > 0;

test('focusing the composer closes an open rail', async () => {
  const tree = await renderThread();
  const bubble = tree.root
    .findAllByProps({ testID: 'msg-01TEXTIN' })
    .find(n => n.props.onLongPress);
  await ReactTestRenderer.act(async () => {
    bubble!.props.onLongPress();
  });
  expect(railOpen(tree)).toBe(true);

  const input = tree.root
    .findAllByProps({ testID: 'composer-input' })
    .find(n => n.props.onFocus);
  await ReactTestRenderer.act(async () => {
    input!.props.onFocus();
  });
  expect(railOpen(tree)).toBe(false);

  await ReactTestRenderer.act(() => {
    tree.unmount();
  });
});

test('pressing into an already-focused composer closes it too', async () => {
  // Pressing into a focused field fires no onFocus, so the press-in path
  // must close the rail on the same terms.
  const tree = await renderThread();
  const bubble = tree.root
    .findAllByProps({ testID: 'msg-01TEXTIN' })
    .find(n => n.props.onLongPress);
  await ReactTestRenderer.act(async () => {
    bubble!.props.onLongPress();
  });
  expect(railOpen(tree)).toBe(true);

  const input = tree.root
    .findAllByProps({ testID: 'composer-input' })
    .find(n => n.props.onPressIn);
  await ReactTestRenderer.act(async () => {
    input!.props.onPressIn();
  });
  expect(railOpen(tree)).toBe(false);

  await ReactTestRenderer.act(() => {
    tree.unmount();
  });
});
