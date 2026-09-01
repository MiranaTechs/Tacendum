/**
 * A disappearing-message timer change renders as an event in the room — a
 * full-width quiet ruled line, on BOTH sides — never as a speech bubble, and
 * never as raw envelope JSON.
 *
 * THE DEFECT THIS FILE EXISTS FOR. `timer` is not in `isCarrierEnvelope`, so
 * the thread filter kept its row; nothing rendered it, so it fell through to
 * the ordinary bubble path and the person who had just turned disappearing
 * messages on was shown `{"tcm":"timer","s":3600,"v":1785...}` in their own
 * conversation. The recipient, meanwhile, saw nothing at all: the inbound
 * branch returned before inserting a row. Asymmetric AND unreadable.
 *
 * The load-bearing assertion is the negative one — no rendered string may ever
 * contain `"tcm"`. It is asserted over every Text node rather than over the
 * timer rows specifically, because the failure mode was a row nobody had
 * thought about reaching a renderer nobody had checked.
 *
 * Harness copied from ChatThread.shot.test.tsx: same fake sqlite, same
 * mocked message list.
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

/** A version stamp; the renderer never reads `v`, only `s`. */
const V = T0;

const TEXT_IN = {
  msgId: '01TEXTIN',
  peerId: 'peer-1',
  direction: 'in',
  body: 'see the garden',
  ts: T0,
  status: 'received',
};
/** Their change, 10s after a message of theirs — the exact adjacency that made
 * the neighbour's clock vanish before shot rows became group-transparent. */
const TIMER_IN = {
  msgId: '01TIMERIN',
  peerId: 'peer-1',
  direction: 'in',
  body: JSON.stringify({ tcm: 'timer', s: 3600, v: V }),
  ts: T0 + 10_000,
  status: 'received',
};
/** Mine, and the row the sender used to be shown as raw JSON. */
const TIMER_OUT = {
  msgId: '01TIMEROUT',
  peerId: 'peer-1',
  direction: 'out',
  body: JSON.stringify({ tcm: 'timer', s: 7 * 24 * 60 * 60, v: V + 1 }),
  ts: T0 + 60_000,
  status: 'sent',
};
/** Turning it off is a different sentence, not "set to off". */
const TIMER_OFF_OUT = {
  msgId: '01TIMEROFF',
  peerId: 'peer-1',
  direction: 'out',
  body: JSON.stringify({ tcm: 'timer', s: 0, v: V + 2 }),
  ts: T0 + 120_000,
  status: 'sent',
};
/** Never receipted. The failed-bubble path prints `previewFor(body) || body`,
 * which is how this row would put the envelope on screen next to a Try again
 * button — so the notice branch has to be checked ahead of the error branch. */
const TIMER_ERR = {
  msgId: '01TIMERERR',
  peerId: 'peer-1',
  direction: 'out',
  body: JSON.stringify({ tcm: 'timer', s: 24 * 60 * 60, v: V + 3 }),
  ts: T0 + 180_000,
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
      return {
        rows: [TEXT_IN, TIMER_IN, TIMER_OUT, TIMER_OFF_OUT, TIMER_ERR],
      };
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

test('no rendered row ever contains the envelope sentinel', async () => {
  // THE REGRESSION GUARD. Deliberately not scoped to timer rows: the bug was
  // that a body nobody had claimed reached the generic bubble, so the
  // assertion has to cover everything on screen.
  const tree = await renderThread();
  const leaked = renderedText(tree).filter(s => s.includes('"tcm"'));
  expect(leaked).toEqual([]);
  await ReactTestRenderer.act(() => {
    tree.unmount();
  });
});

test('a timer change renders as a system row on both sides, never a bubble', async () => {
  const tree = await renderThread();

  for (const id of ['01TIMERIN', '01TIMEROUT', '01TIMEROFF']) {
    expect(
      tree.root.findAll(n => n.props.testID === `timer-${id}`).length,
    ).toBeGreaterThan(0);
    expect(tree.root.findAll(n => n.props.testID === `msg-${id}`).length).toBe(
      0,
    );
  }

  const texts = renderedText(tree);
  // Mine speaks in the first person; theirs names them. An unnamed peer's ref
  // is the pronoun 'them', which cannot hold a sentence-initial subject slot.
  expect(texts).toContain('You set disappearing messages to 1 week.');
  expect(texts).toContain('They set disappearing messages to 1 hour.');
  expect(texts).toContain('You turned disappearing messages off.');
  // The duration is the part a person weighs, so it must be spelled the way
  // the peer profile's chips spell it — never as bare seconds.
  expect(texts.some(s => s.includes('3600'))).toBe(false);

  await ReactTestRenderer.act(() => {
    tree.unmount();
  });
});

test('an errored timer notice still renders the quiet row — no JSON, no retry', async () => {
  const tree = await renderThread();
  expect(
    tree.root.findAll(n => n.props.testID === 'timer-01TIMERERR').length,
  ).toBeGreaterThan(0);
  expect(
    tree.root.findAll(n => n.props.testID === 'error-01TIMERERR').length,
  ).toBe(0);
  expect(
    tree.root.findAll(n => n.props.testID === 'retry-01TIMERERR').length,
  ).toBe(0);
  // The setting applied locally at compose time, so the sentence is true here
  // whatever the wire did.
  expect(renderedText(tree)).toContain('You set disappearing messages to 1 day.');
  await ReactTestRenderer.act(() => {
    tree.unmount();
  });
});

test('a timer row is transparent to grouping: the neighbour keeps its clock', async () => {
  const tree = await renderThread();
  // TEXT_IN is followed 10s later by a same-direction timer row; a system row
  // prints no clock, so it must never suppress the neighbour's.
  expect(renderedText(tree).some(s => s.includes(clockLabel(T0)))).toBe(true);
  await ReactTestRenderer.act(() => {
    tree.unmount();
  });
});

test('a timer notice can be removed like any other row', async () => {
  const tree = await renderThread();
  const remove = tree.root.findAll(
    n => n.props.testID === 'remove-01TIMERIN' && !!n.props.onPress,
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
