/**
 * AUTO-SCROLL DISCIPLINE (device demo, build 9) — red-first.
 *
 * Reported from the phone: long-press a bubble to copy or reply and the
 * screen yanks to the end mid-press — the context menu never opens. The
 * chain: the approval countdown tick (once a second while a card is
 * pending) or a stream-overlay repaint re-renders the thread; the repaint
 * changes the content height by a point (a countdown label re-wrapping, the
 * overlay growing the bubble), `onContentSizeChange` fires, and — pinned or
 * still anchored — the screen called `scrollToEnd`, cancelling the gesture.
 *
 * The rule, standard chat UX, pinned here:
 *  1. a TICK-born resize never scrolls — pinned, anchored, or scrolled up;
 *  2. a GENUINELY NEW ROW while pinned still scrolls (no over-suppression);
 *  3. a tick never changes the list's data identity or its keys — rows are
 *     repainted at most, never remounted (the memo/key pin).
 *
 * The native layer never fires layout callbacks under the test renderer, so
 * every resize below is delivered by hand through the list's own props —
 * which is exactly the seam the screen's handler owns.
 *
 * Harness: ChatThread.approval.test.tsx's fake sqlite + moving fake clock
 * (the frozen-clock rule), plus ChatThread.stream.test.tsx's overlay
 * store.
 */
import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { FlatList } from 'react-native';
import * as db from '../src/db';
import { messaging } from '../src/messaging';
import { ChatThreadScreen } from '../src/screens/ChatThreadScreen';
import { streamEdits } from '../src/streamEdits';

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

const ulid = (tag: string) => (tag + '0'.repeat(26)).slice(0, 26);
const ME = ulid('ME1');
const PEER = ulid('PEER1');
const ANCHOR = ulid('ANCH0R');
const Q = '01J8MEAPPR0VAQ4X2C6TKN9RFV';

function messageRow(over: Record<string, unknown> = {}) {
  return {
    msgId: ANCHOR,
    peerId: PEER,
    direction: 'in',
    body: 'I will create demo.txt with the demo line.',
    ts: 1_000,
    status: 'received',
    editedAt: null,
    deletedAt: null,
    expiresAt: null,
    authorId: null,
    sq: null,
    outsider: null,
    sharedBy: null,
    ...over,
  };
}

function approvalRow(): Record<string, string | number | null> {
  return {
    peerId: PEER,
    q: Q,
    wireMsgId: '01APPROVALWIRE000000000001',
    kind: 'file',
    payload: 'write demo.txt',
    payloadBytes: 14,
    ttlSec: 600,
    sessionTag: null,
    verbs: '["approve","deny"]',
    ts: Date.now(),
    arrivedAt: Date.now(),
    state: 'pending',
    answerVerb: null,
    settledAt: null,
  };
}

/** Mutable fixtures: tests grow `rows` mid-flight and requery. */
let rows: Array<Record<string, unknown>> = [];
let approvals: Array<Record<string, string | number | null>> = [];

function installDb() {
  const instance = sqlite.instances.get('tacendum.sqlite')!;
  const base = instance.execute.getMockImplementation()!;
  instance.execute.mockImplementation((sql: string, params?: unknown[]) => {
    const s = String(sql).replace(/\s+/g, ' ').trim();
    if (s.startsWith('SELECT') && s.includes('FROM approvals')) {
      return { rows: approvals };
    }
    if (s.includes('FROM messages')) return { rows };
    if (s.includes('SELECT groupId, ownerId, name FROM groups')) {
      return { rows: [] };
    }
    if (s.includes('FROM group_members')) return { rows: [] };
    if (s.includes('FROM chats') && s.includes('ORDER BY')) {
      return { rows: [{ peerId: PEER, displayName: 'Dawit', localName: null }] };
    }
    if (s.includes('FROM profile')) {
      return {
        rows: [
          { key: 'userId', value: ME },
          { key: 'registrationId', value: '7' },
        ],
      };
    }
    return base(sql, params);
  });
}

/** The screen's change listener, captured so a test can requery on demand. */
let changeListeners: Array<() => void> = [];

let scrollToEnd: jest.SpyInstance;

beforeEach(async () => {
  jest.useFakeTimers();
  rows = [messageRow()];
  approvals = [approvalRow()];
  changeListeners = [];
  jest.spyOn(messaging, 'subscribe').mockImplementation(cb => {
    changeListeners.push(cb);
    return () => {};
  });
  scrollToEnd = jest
    .spyOn(FlatList.prototype, 'scrollToEnd')
    .mockImplementation(() => {});
  await db.close();
  sqlite.reset();
  db.setWorkspace('real');
  await db.initDb();
  installDb();
  streamEdits.clear();
});

afterEach(async () => {
  jest.restoreAllMocks();
  streamEdits.clear();
  await db.close();
  jest.useRealTimers();
});

async function renderThread(): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <ChatThreadScreen
        peerId={PEER}
        onBack={jest.fn()}
        onOpenPeerProfile={jest.fn()}
        onOpenPhoto={jest.fn()}
      />,
    );
  });
  await ReactTestRenderer.act(async () => {});
  return tree;
}

async function unmount(tree: ReactTestRenderer.ReactTestRenderer): Promise<void> {
  await ReactTestRenderer.act(() => {
    tree.unmount();
  });
}

function list(tree: ReactTestRenderer.ReactTestRenderer) {
  return tree.root.findAll(
    n =>
      n.props.testID === 'thread-list' &&
      typeof n.props.onContentSizeChange === 'function',
  )[0]!;
}

/** The native resize event, delivered by hand (no layout engine here). */
async function resize(tree: ReactTestRenderer.ReactTestRenderer): Promise<void> {
  await ReactTestRenderer.act(async () => {
    list(tree).props.onContentSizeChange(390, 2000);
  });
}

/** One second of the approval countdown — a moving clock, tick and Date.now()
 * together (the frozen-clock rule). */
async function countdownTick(tree: ReactTestRenderer.ReactTestRenderer): Promise<void> {
  void tree;
  await ReactTestRenderer.act(() => {
    jest.advanceTimersByTime(1000);
  });
}

/** The person takes hold of the list and leaves the bottom. */
async function scrollUp(tree: ReactTestRenderer.ReactTestRenderer): Promise<void> {
  await ReactTestRenderer.act(async () => {
    const l = list(tree);
    l.props.onScrollBeginDrag();
    l.props.onScroll({
      nativeEvent: {
        contentOffset: { y: 100 },
        contentSize: { height: 2000 },
        layoutMeasurement: { height: 600 },
      },
    });
    l.props.onScrollEndDrag();
  });
}

describe('a tick is never a reason to move the list', () => {
  test('the approval countdown tick while PINNED does not scroll — the long-press survives (red before the fix)', async () => {
    const tree = await renderThread();
    scrollToEnd.mockClear();

    // The demo timeline: pinned at the bottom (never dragged — still
    // anchored), a card counting down, a finger settling into a long-press.
    await countdownTick(tree);
    // The tick re-wrapped the countdown label; the native side reports the
    // content size change. Before the fix this scrolled (anchored ⇒
    // scrollToEnd) and cancelled the gesture.
    await resize(tree);

    expect(scrollToEnd).not.toHaveBeenCalled();
    await unmount(tree);
  });

  test('the countdown tick after the person scrolled UP does not scroll either', async () => {
    const tree = await renderThread();
    await scrollUp(tree);
    scrollToEnd.mockClear();

    await countdownTick(tree);
    await resize(tree);

    expect(scrollToEnd).not.toHaveBeenCalled();
    await unmount(tree);
  });

  test('a stream-overlay repaint while pinned does not scroll (red before the fix)', async () => {
    const tree = await renderThread();
    scrollToEnd.mockClear();

    // The streamed reply grows the anchor bubble — a repaint of an existing
    // row, not new content.
    await ReactTestRenderer.act(async () => {
      streamEdits.apply(PEER, ANCHOR, 1, 'I will create demo.txt — writing it now, one moment');
    });
    await resize(tree);

    expect(scrollToEnd).not.toHaveBeenCalled();
    await unmount(tree);
  });
});

describe('genuinely new content still follows (no over-suppression)', () => {
  test('a NEW row while pinned scrolls to the end exactly as before', async () => {
    const tree = await renderThread();
    scrollToEnd.mockClear();

    rows = [
      ...rows,
      messageRow({ msgId: ulid('NEWR0W'), body: 'Created demo.txt with the demo line.', ts: 2_000 }),
    ];
    await ReactTestRenderer.act(async () => {
      for (const cb of changeListeners) cb();
      jest.advanceTimersByTime(200); // past REFRESH_DEBOUNCE_MS
    });
    await ReactTestRenderer.act(async () => {});
    await resize(tree);

    expect(scrollToEnd).toHaveBeenCalled();
    await unmount(tree);
  });

  test('a new row scrolls even when a tick rode the same commit — content wins a mixed render', async () => {
    const tree = await renderThread();
    scrollToEnd.mockClear();

    rows = [
      ...rows,
      messageRow({ msgId: ulid('NEWR0W'), body: 'Created demo.txt.', ts: 2_000 }),
    ];
    await ReactTestRenderer.act(async () => {
      for (const cb of changeListeners) cb();
      // 1000ms advances BOTH the refresh debounce and the countdown tick:
      // the requery and the clock land in the same window.
      jest.advanceTimersByTime(1000);
    });
    await ReactTestRenderer.act(async () => {});
    await resize(tree);

    expect(scrollToEnd).toHaveBeenCalled();
    await unmount(tree);
  });
});

describe('a tick never remounts rows (the memo/key pin)', () => {
  test('countdown and overlay ticks leave the list data identity and every key unchanged', async () => {
    const tree = await renderThread();
    const l = list(tree);
    const dataBefore = l.props.data as unknown[];
    const keysBefore = dataBefore.map((item, i) =>
      (l.props.keyExtractor as (it: unknown, ix: number) => string)(item, i),
    );
    expect(keysBefore.length).toBeGreaterThan(0);

    await countdownTick(tree);
    await ReactTestRenderer.act(async () => {
      streamEdits.apply(PEER, ANCHOR, 1, 'still writing');
    });

    const after = list(tree);
    // Identity, not equality: the items memo must not name a clock among
    // its dependencies, or every tick would rebuild — and remount — the
    // thread's rows.
    expect(after.props.data).toBe(dataBefore);
    const keysAfter = (after.props.data as unknown[]).map((item, i) =>
      (after.props.keyExtractor as (it: unknown, ix: number) => string)(item, i),
    );
    expect(keysAfter).toEqual(keysBefore);
    await unmount(tree);
  });
});

describe('"New messages" is a newest-arrival compare, not a row count', () => {
  /** What the jump bar says, or null while it is not on glass. */
  function jumpLabel(tree: ReactTestRenderer.ReactTestRenderer): string | null {
    const found = tree.root.findAll(
      n =>
        typeof n.props.children === 'string' &&
        (n.props.children === 'New messages' || n.props.children === 'Latest messages'),
    );
    return found.length > 0 ? (found[0]!.props.children as string) : null;
  }

  async function requery(): Promise<void> {
    await ReactTestRenderer.act(async () => {
      for (const cb of changeListeners) cb();
      jest.advanceTimersByTime(200); // past REFRESH_DEBOUNCE_MS
    });
    await ReactTestRenderer.act(async () => {});
  }

  test('a row deleted and a row arrived inside one requery still raises "New messages" (red before the fix)', async () => {
    rows = [
      messageRow(),
      messageRow({ msgId: ulid('SEC0ND'), body: 'second', ts: 2_000 }),
    ];
    const tree = await renderThread();
    await scrollUp(tree);
    expect(jumpLabel(tree)).toBe('Latest messages');

    // Both land in one debounce window: the second row is deleted for me
    // and a newer one arrives. The inbound COUNT is unchanged — two before,
    // two after — which is exactly what the old register compared.
    rows = [
      messageRow(),
      messageRow({ msgId: ulid('THIRD'), body: 'third', ts: 3_000 }),
    ];
    await requery();

    expect(jumpLabel(tree)).toBe('New messages');
    await unmount(tree);
  });

  /**
   * THE GATE'S DEFECT. The identity register kept `null` for BOTH "the
   * list has not answered yet" and "it answered and there were no inbound
   * rows", so the FIRST arrival into a thread of only my own sends — or a
   * fresh room — was swallowed: `priorNewest !== null` was false, and
   * nothing raised the bar. The count-based code this replaced did raise
   * it (1 inbound > 0 seen). */
  test('the first inbound row into an outbound-only thread raises "New messages" (red before the fix)', async () => {
    rows = [
      messageRow({
        msgId: ulid('MINE1'),
        direction: 'out',
        status: 'sent',
        body: 'are you around?',
        ts: 1_000,
      }),
      messageRow({
        msgId: ulid('MINE2'),
        direction: 'out',
        status: 'sent',
        body: 'no rush',
        ts: 2_000,
      }),
    ];
    const tree = await renderThread();
    await scrollUp(tree);
    expect(jumpLabel(tree)).toBe('Latest messages');

    rows = [
      ...rows,
      messageRow({ msgId: ulid('THEIRS'), body: 'just got in', ts: 3_000 }),
    ];
    await requery();

    expect(jumpLabel(tree)).toBe('New messages');
    await unmount(tree);
  });

  test('a deletion alone never claims new messages', async () => {
    rows = [
      messageRow(),
      messageRow({ msgId: ulid('SEC0ND'), body: 'second', ts: 2_000 }),
    ];
    const tree = await renderThread();
    await scrollUp(tree);

    rows = [messageRow()];
    await requery();

    expect(jumpLabel(tree)).toBe('Latest messages');
    await unmount(tree);
  });

  test('a repaint of the same rows (a receipt, a reaction) never claims new messages', async () => {
    rows = [
      messageRow(),
      messageRow({ msgId: ulid('SEC0ND'), body: 'second', ts: 2_000 }),
    ];
    const tree = await renderThread();
    await scrollUp(tree);

    rows = rows.map(r => ({ ...r }));
    await requery();

    expect(jumpLabel(tree)).toBe('Latest messages');
    await unmount(tree);
  });
});
