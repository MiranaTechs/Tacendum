/**
 * The unread divider — "N new messages" above the first message that
 * arrived since this thread was last open, and the thread opening THERE.
 *
 * The rules pinned here:
 *  - the divider stands immediately above the first inbound row that
 *    arrived after the chat's previous `lastOpenedAt`, and counts every
 *    such row — by THIS phone's arrival clock, never the sender's `ts`;
 *  - the stamp it is measured against is read ONCE, before the thread
 *    overwrites it: a requery after opening (a receipt, a reaction) must
 *    not make the divider vanish;
 *  - the first layout scrolls to the divider instead of the end, and the
 *    jump bar then offers the newest messages;
 *  - with nothing new the thread lands at the end exactly as before.
 *
 * Harness: ChatThread.scrollpin.test.tsx's (layout events delivered by
 * hand; a captured change listener to requery on demand). */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { FlatList } from 'react-native';
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
const MIN = 60_000;

type Row = Record<string, unknown>;
const row = (r: Row): Row => ({
  peerId: 'peer-1',
  direction: 'in',
  status: 'received',
  editedAt: null,
  deletedAt: null,
  ...r,
});

/** Read before the thread was last opened. */
const OLD_IN = row({
  msgId: '01OLDIN',
  body: 'see the garden',
  ts: T0 - 5 * MIN,
  arrivedAt: T0 - 10 * MIN,
});
const OLD_OUT = row({
  msgId: '01OLDOUT',
  direction: 'out',
  status: 'sent',
  body: 'which garden?',
  ts: T0 - 4 * MIN,
});
const NEW_IN_1 = row({
  msgId: '01NEWIN1',
  body: 'the one by the river',
  ts: T0 + 1 * MIN,
  arrivedAt: T0 + 1 * MIN,
});
const NEW_IN_2 = row({
  msgId: '01NEWIN2',
  body: 'bring the dog',
  ts: T0 + 2 * MIN,
  arrivedAt: T0 + 2 * MIN,
});
/** A sender whose clock runs AHEAD: stamped after the last open, but it
 * ARRIVED before it — read already. A divider keyed on `ts` would count it;
 * one keyed on arrival must not. Sorts last, by its own stamp. */
const AHEAD_IN = row({
  msgId: '01AHEADIN',
  body: 'from tomorrow',
  ts: T0 + 3 * MIN,
  arrivedAt: T0 - 1 * MIN,
});

let rows: Row[] = [];
/** The chat row's `lastOpenedAt` as the store would answer it NOW. */
let lastOpenedAt: number | null = T0;
let changeListeners: Array<() => void> = [];
let scrollToEnd: jest.SpyInstance;
let scrollToIndex: jest.SpyInstance;

beforeEach(async () => {
  jest.useFakeTimers();
  jest.setSystemTime(T0 + 30 * MIN);
  rows = [OLD_IN, OLD_OUT, NEW_IN_1, NEW_IN_2, AHEAD_IN];
  lastOpenedAt = T0;
  changeListeners = [];
  jest.spyOn(messaging, 'subscribe').mockImplementation(cb => {
    changeListeners.push(cb);
    return () => {};
  });
  scrollToEnd = jest
    .spyOn(FlatList.prototype, 'scrollToEnd')
    .mockImplementation(() => {});
  scrollToIndex = jest
    .spyOn(FlatList.prototype, 'scrollToIndex')
    .mockImplementation(() => {});
  await db.close();
  sqlite.reset();
  db.setWorkspace('real');
  await db.initDb();
  const instance = sqlite.instances.get('tacendum.sqlite')!;
  const base = instance.execute.getMockImplementation()!;
  instance.execute.mockImplementation(async (sql: string, params?: unknown) => {
    const s = String(sql).replace(/\s+/g, ' ');
    if (s.includes('FROM messages')) return { rows };
    if (s.includes('FROM chats')) {
      return {
        rows: [
          { peerId: 'peer-1', displayName: 'Dawit', localName: null, lastOpenedAt },
        ],
      };
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

function list(tree: ReactTestRenderer.ReactTestRenderer) {
  return tree.root.findAll(
    n =>
      n.props.testID === 'thread-list' &&
      typeof n.props.onContentSizeChange === 'function',
  )[0]!;
}

/** The list's keys, in order — the divider is a key like any row. */
function keys(tree: ReactTestRenderer.ReactTestRenderer): string[] {
  const l = list(tree);
  return (l.props.data as unknown[]).map((item, i) =>
    (l.props.keyExtractor as (it: unknown, ix: number) => string)(item, i),
  );
}

async function resize(tree: ReactTestRenderer.ReactTestRenderer): Promise<void> {
  await ReactTestRenderer.act(async () => {
    list(tree).props.onContentSizeChange(390, 2000);
  });
}

async function requery(): Promise<void> {
  await ReactTestRenderer.act(async () => {
    for (const cb of changeListeners) cb();
    jest.advanceTimersByTime(200); // past REFRESH_DEBOUNCE_MS
  });
  await ReactTestRenderer.act(async () => {});
}

/** What each divider on glass says — host nodes only, one per divider. */
function dividerLabels(tree: ReactTestRenderer.ReactTestRenderer): string[] {
  return tree.root
    .findAll(n => n.props.testID === 'unread-divider' && typeof n.type === 'string')
    .map(n => n.props.accessibilityLabel as string);
}

async function unmount(tree: ReactTestRenderer.ReactTestRenderer): Promise<void> {
  await ReactTestRenderer.act(() => {
    tree.unmount();
  });
}

test('the divider stands above the first row that ARRIVED after the last open, and counts by arrival', async () => {
  const tree = await renderThread();
  expect(keys(tree)).toEqual([
    '01OLDIN:in',
    '01OLDOUT:out',
    'unread-divider',
    '01NEWIN1:in',
    '01NEWIN2:in',
    '01AHEADIN:in',
  ]);
  // Two, not three: the row stamped "tomorrow" arrived before the last open.
  expect(dividerLabels(tree)).toEqual(['2 new messages']);
  await unmount(tree);
});

test('one new message reads in the singular', async () => {
  rows = [OLD_IN, OLD_OUT, NEW_IN_2];
  const tree = await renderThread();
  expect(dividerLabels(tree)).toEqual(['1 new message']);
  await unmount(tree);
});

test('the stamp is read once: a requery after opening keeps the divider where it was', async () => {
  const tree = await renderThread();
  expect(keys(tree)).toContain('unread-divider');
  // The thread has now written its own opened stamp; every later read of
  // the chat row answers with it. Without a once-only read the divider
  // would vanish on the first receipt.
  lastOpenedAt = T0 + 30 * MIN;
  await requery();
  expect(keys(tree)).toEqual([
    '01OLDIN:in',
    '01OLDOUT:out',
    'unread-divider',
    '01NEWIN1:in',
    '01NEWIN2:in',
    '01AHEADIN:in',
  ]);
  await unmount(tree);
});

test('the first layout scrolls to the divider, not the end, and the jump bar offers the newest', async () => {
  const tree = await renderThread();
  scrollToEnd.mockClear();
  scrollToIndex.mockClear();

  await resize(tree);

  expect(scrollToIndex).toHaveBeenCalledWith(
    expect.objectContaining({ index: 2, viewPosition: 0, animated: false }),
  );
  expect(scrollToEnd).not.toHaveBeenCalled();
  const jump = tree.root.findAll(
    n => typeof n.props.children === 'string' && n.props.children === 'New messages',
  );
  expect(jump.length).toBeGreaterThan(0);

  // Later stages of loading (attachment metadata resizing rows) must not
  // yank the view to the end from under the divider.
  await resize(tree);
  expect(scrollToEnd).not.toHaveBeenCalled();
  expect(scrollToIndex).toHaveBeenCalledTimes(1);
  await unmount(tree);
});

test('nothing new: no divider, and the thread lands at the end as before', async () => {
  lastOpenedAt = T0 + 10 * MIN;
  const tree = await renderThread();
  expect(keys(tree)).not.toContain('unread-divider');
  scrollToEnd.mockClear();
  await resize(tree);
  expect(scrollToEnd).toHaveBeenCalled();
  expect(scrollToIndex).not.toHaveBeenCalled();
  await unmount(tree);
});

test('a never-opened chat counts every inbound message as new', async () => {
  lastOpenedAt = null;
  const tree = await renderThread();
  expect(keys(tree)[0]).toBe('unread-divider');
  expect(dividerLabels(tree)).toEqual(['4 new messages']);
  await unmount(tree);
});

test('my own sends, relayed history and retracted rows are never "new"', async () => {
  rows = [
    OLD_IN,
    row({ msgId: '01MINE', direction: 'out', status: 'sent', body: 'later', ts: T0 + MIN, arrivedAt: null }),
    row({ msgId: '01SHARED', body: 'catch-up', ts: T0 + 2 * MIN, arrivedAt: T0 + 2 * MIN, sharedBy: 'someone' }),
    row({ msgId: '01GONE', body: '', ts: T0 + 3 * MIN, arrivedAt: T0 + 3 * MIN, deletedAt: T0 + 4 * MIN }),
  ];
  const tree = await renderThread();
  expect(keys(tree)).not.toContain('unread-divider');
  await unmount(tree);
});

/**
 * THE GATE'S DEFECT. The divider was recomputed from the CURRENT rows on
 * every requery against a stamp with no upper bound, so a message arriving
 * WHILE the thread was open — the person sitting at the bottom, reading —
 * counted as unread. It grew a "N new messages" line, and the landing block
 * then handed the anchor over and scrolled to the divider instead of the
 * end, putting "New messages" on glass for a message being looked at. From
 * there nothing auto-scrolled again. The divider marks what was unread AT
 * OPEN, and only that. */
test('a message arriving while the thread is open is not "new": no divider, and the list still follows it', async () => {
  rows = [OLD_IN, OLD_OUT];
  const tree = await renderThread();
  expect(keys(tree)).not.toContain('unread-divider');
  await resize(tree);
  expect(scrollToEnd).toHaveBeenCalled();
  scrollToEnd.mockClear();
  scrollToIndex.mockClear();

  // Ten minutes later, still at the bottom, a message lands. The clock and
  // the row's arrival stamp move together — this phone's clock is the one
  // the divider is measured against.
  jest.setSystemTime(T0 + 40 * MIN);
  rows = [
    OLD_IN,
    OLD_OUT,
    row({
      msgId: '01LIVEIN',
      body: 'still there?',
      ts: T0 + 40 * MIN,
      arrivedAt: T0 + 40 * MIN,
    }),
  ];
  await requery();

  expect(keys(tree)).toEqual(['01OLDIN:in', '01OLDOUT:out', '01LIVEIN:in']);
  expect(dividerLabels(tree)).toEqual([]);

  await resize(tree);
  expect(scrollToEnd).toHaveBeenCalled();
  expect(scrollToIndex).not.toHaveBeenCalled();
  expect(
    tree.root.findAll(
      n =>
        typeof n.props.children === 'string' &&
        n.props.children === 'New messages',
    ),
  ).toHaveLength(0);
  await unmount(tree);
});

test('an arrival while the thread is open never grows the divider it opened with', async () => {
  const tree = await renderThread();
  expect(dividerLabels(tree)).toEqual(['2 new messages']);

  jest.setSystemTime(T0 + 40 * MIN);
  rows = [
    ...rows,
    row({
      msgId: '01LIVEIN',
      body: 'and the dog',
      ts: T0 + 40 * MIN,
      arrivedAt: T0 + 40 * MIN,
    }),
  ];
  await requery();

  // Still two: the divider counts what was unread at open, not what has
  // landed since.
  expect(dividerLabels(tree)).toEqual(['2 new messages']);
  expect(keys(tree)).toEqual([
    '01OLDIN:in',
    '01OLDOUT:out',
    'unread-divider',
    '01NEWIN1:in',
    '01NEWIN2:in',
    '01AHEADIN:in',
    '01LIVEIN:in',
  ]);
  await unmount(tree);
});
