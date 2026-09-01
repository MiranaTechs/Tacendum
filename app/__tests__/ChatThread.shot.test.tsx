/**
 * A screenshot notice renders as an event in the room — a full-width quiet
 * ruled line — never as a speech bubble, and never as raw envelope JSON.
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import * as db from '../src/db';
import { ChatThreadScreen } from '../src/screens/ChatThreadScreen';
import { clockLabel } from '../src/time';

interface FakeDb {
  name: string;
  execute: jest.Mock;
  close: jest.Mock;
}
const sqlite = (
  jest.requireMock('@op-engineering/op-sqlite') as {
    __sqlite: {
      instances: Map<string, FakeDb>;
      reset: () => void;
    };
  }
).__sqlite;

// Realistic wall-clock times: grouping and clock labels depend on them.
const T0 = new Date('2026-07-25T12:00:00').getTime();

const TEXT_IN = {
  msgId: '01TEXTIN',
  peerId: 'peer-1',
  direction: 'in',
  body: 'see the garden',
  ts: T0,
  status: 'received',
};
const SHOT_IN = {
  msgId: '01SHOTIN',
  peerId: 'peer-1',
  direction: 'in',
  body: '{"tcm":"shot"}',
  // Same clock minute and direction as TEXT_IN: the exact shape that made
  // the neighbor's clock vanish before shot rows became group-transparent.
  ts: T0 + 10_000,
  status: 'received',
};
const SHOT_OUT = {
  msgId: '01SHOTOUT',
  peerId: 'peer-1',
  direction: 'out',
  body: '{"tcm":"shot"}',
  ts: T0 + 60_000,
  status: 'sent',
};
const SHOT_ERR = {
  msgId: '01SHOTERR',
  peerId: 'peer-1',
  direction: 'out',
  body: '{"tcm":"shot"}',
  ts: T0 + 120_000,
  status: 'error',
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
      return { rows: [TEXT_IN, SHOT_IN, SHOT_OUT, SHOT_ERR] };
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

test('screenshot notices render as system rows, not bubbles, and never leak JSON', async () => {
  const tree = await renderThread();

  expect(
    tree.root.findAll(n => n.props.testID === 'shot-01SHOTIN').length,
  ).toBeGreaterThan(0);
  expect(
    tree.root.findAll(n => n.props.testID === 'shot-01SHOTOUT').length,
  ).toBeGreaterThan(0);
  expect(tree.root.findAll(n => n.props.testID === 'msg-01SHOTIN').length).toBe(
    0,
  );
  expect(
    tree.root.findAll(n => n.props.testID === 'msg-01SHOTOUT').length,
  ).toBe(0);

  const allText = tree.root
    .findAllByType(require('react-native').Text)
    .map(n =>

      (Array.isArray(n.props.children)
        ? n.props.children.join('')
        : String(n.props.children ?? '')) as string,
    );
  expect(allText.some(s => s.includes('{"tcm"'))).toBe(false);
  expect(allText.some(s => s === 'You took a screenshot.')).toBe(true);
  // An unnamed peer's ref is the pronoun 'them' — sentence-initial it must
  // become 'They', never 'them took a screenshot.'
  expect(allText.some(s => s === 'They took a screenshot.')).toBe(true);

  await ReactTestRenderer.act(() => {
    tree.unmount();
  });
});

test('an errored outgoing notice still renders the quiet row — no JSON, no retry', async () => {
  const tree = await renderThread();
  expect(
    tree.root.findAll(n => n.props.testID === 'shot-01SHOTERR').length,
  ).toBeGreaterThan(0);
  expect(
    tree.root.findAll(n => n.props.testID === 'error-01SHOTERR').length,
  ).toBe(0);
  expect(
    tree.root.findAll(n => n.props.testID === 'retry-01SHOTERR').length,
  ).toBe(0);
  await ReactTestRenderer.act(() => {
    tree.unmount();
  });
});

test('a shot row is transparent to grouping: the neighbor keeps its clock', async () => {
  const tree = await renderThread();
  const texts = tree.root
    .findAllByType(require('react-native').Text)
    .map(n =>
      Array.isArray(n.props.children)
        ? n.props.children.join('')
        : String(n.props.children ?? ''),
    );
  // TEXT_IN is followed 10s later by a same-direction shot row; its own
  // clock label must still print.
  expect(texts.some(s => s.includes(clockLabel(T0)))).toBe(true);
  await ReactTestRenderer.act(() => {
    tree.unmount();
  });
});

test('a notice can be removed like any other row', async () => {
  const tree = await renderThread();
  const remove = tree.root.findAll(
    n => n.props.testID === 'remove-01SHOTIN' && !!n.props.onPress,
  )[0];
  expect(remove).toBeTruthy();
  await ReactTestRenderer.act(async () => {
    remove.props.onPress();
  });
  const instance = sqlite.instances.get('tacendum.sqlite')!;
  const deletes = instance.execute.mock.calls.filter(c =>
    String(c[0]).includes('DELETE FROM messages'),
  );
  expect(deletes.length).toBeGreaterThan(0);
  await ReactTestRenderer.act(() => {
    tree.unmount();
  });
});
