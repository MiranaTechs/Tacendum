/**
 * The stream-edit overlay, render half: the thread bubble shows the overlay's
 * snapshot with the live cursor while the stream is fresh, reverts to the
 * durable row on fade (a MOVING clock — modern fake timers advance
 * Date.now() and the fade timeout in lockstep, per the frozen-clock
 * rule) and on close, and after the final edit the standard Edited chip
 * stands on durable truth. All in-memory: the fixtures below are the only
 * rows, and no assertion ever finds the overlay in them.
 */
import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import * as db from '../src/db';
import { messaging } from '../src/messaging';
import { ChatThreadScreen } from '../src/screens/ChatThreadScreen';
import { STREAM_EXPIRY_MS, streamEdits } from '../src/streamEdits';

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

/** Valid Crockford ULIDs (no I, L, O, U), 26 chars, distinct tails. */
const ulid = (tag: string) => (tag + '0'.repeat(26)).slice(0, 26);
const ME = ulid('ME1');
const PEER = ulid('PEER1');
const ANCHOR = ulid('ANCH0R');
const OUTBOUND = ulid('M1NE');

const DURABLE = 'Thinking.';
const OVERLAY = 'The eleven regions of Ethiopia are';
const FINAL = 'Ethiopia has eleven regions.';

function messageRow(over: Record<string, unknown> = {}) {
  return {
    msgId: ANCHOR,
    peerId: PEER,
    direction: 'in',
    body: DURABLE,
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

function install1to1Db(rows: Array<Record<string, unknown>>) {
  const instance = sqlite.instances.get('tacendum.sqlite')!;
  const base = instance.execute.getMockImplementation()!;
  instance.execute.mockImplementation(
    async (sql: string, params?: unknown[]) => {
      const s = String(sql);
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
    },
  );
}

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

function renderedText(tree: ReactTestRenderer.ReactTestRenderer): string {
  return tree.root
    .findAllByType(require('react-native').Text)
    .map(n =>
      Array.isArray(n.props.children)
        ? n.props.children
            .map((c: unknown) => (typeof c === 'string' ? c : ''))
            .join('')
        : String(n.props.children ?? ''),
    )
    .join('\n');
}

const cursors = (tree: ReactTestRenderer.ReactTestRenderer) =>
  // Host elements only (`type` is a string): the composite Text and its
  // host node both carry the testID, and counting both would double every
  // cursor.
  tree.root.findAll(
    n =>
      typeof n.type === 'string' &&
      typeof n.props.testID === 'string' &&
      n.props.testID.startsWith('stream-cursor-'),
  );

beforeEach(async () => {
  await db.close();
  sqlite.reset();
  db.setWorkspace('real');
  await db.initDb();
  // The screen subscribes to the real singletons; the store carries state
  // between tests unless someone clears it, and messaging.stop() is that
  // someone in the app — here we call it directly.
  streamEdits.clear();
  jest.spyOn(messaging, 'sendTypingState').mockResolvedValue(undefined);
  jest.spyOn(messaging, 'sendRoomTypingState').mockResolvedValue(undefined);
});

afterEach(async () => {
  jest.restoreAllMocks();
  streamEdits.clear();
  await db.close();
});

describe('the stream overlay on a 1:1 bubble', () => {
  test('a fresh overlay paints its snapshot with the live cursor; the durable body steps back', async () => {
    install1to1Db([messageRow()]);
    const tree = await renderThread();
    expect(renderedText(tree)).toContain(DURABLE);
    expect(cursors(tree)).toHaveLength(0);

    await ReactTestRenderer.act(async () => {
      streamEdits.apply(PEER, ANCHOR, 1, OVERLAY);
    });

    const text = renderedText(tree);
    expect(text).toContain(OVERLAY);
    expect(text).not.toContain(DURABLE);
    expect(cursors(tree)).toHaveLength(1);
    expect(cursors(tree)[0]!.props.testID).toBe(`stream-cursor-${ANCHOR}`);
  });

  test('a later snapshot replaces the whole bubble; an older seq repaints nothing', async () => {
    install1to1Db([messageRow()]);
    const tree = await renderThread();
    await ReactTestRenderer.act(async () => {
      streamEdits.apply(PEER, ANCHOR, 2, OVERLAY);
    });
    await ReactTestRenderer.act(async () => {
      streamEdits.apply(PEER, ANCHOR, 1, 'a stale snapshot');
    });
    const text = renderedText(tree);
    expect(text).toContain(OVERLAY);
    expect(text).not.toContain('a stale snapshot');
  });

  test('the overlay fades at STREAM_EXPIRY_MS on a MOVING clock and the durable body returns', async () => {
    install1to1Db([messageRow()]);
    // Mount under real timers (the boot path settles on promises); fake
    // timers go on BEFORE the overlay applies, so the frame's `at`, the
    // fade timeout, and every Date.now() they compare advance together —
    // the frozen-clock rule, kept.
    const tree = await renderThread();
    jest.useFakeTimers();
    try {
      await ReactTestRenderer.act(async () => {
        streamEdits.apply(PEER, ANCHOR, 1, OVERLAY);
      });
      expect(renderedText(tree)).toContain(OVERLAY);

      await ReactTestRenderer.act(async () => {
        await jest.advanceTimersByTimeAsync(STREAM_EXPIRY_MS + 100);
      });

      const text = renderedText(tree);
      expect(text).not.toContain(OVERLAY);
      expect(text).toContain(DURABLE);
      expect(cursors(tree)).toHaveLength(0);
    } finally {
      jest.useRealTimers();
    }
  });

  test('close reverts to durable truth at once — the final edit’s hook, seen from the render side', async () => {
    install1to1Db([messageRow()]);
    const tree = await renderThread();
    await ReactTestRenderer.act(async () => {
      streamEdits.apply(PEER, ANCHOR, 1, OVERLAY);
    });
    expect(renderedText(tree)).toContain(OVERLAY);

    await ReactTestRenderer.act(async () => {
      streamEdits.close(PEER, ANCHOR);
    });

    const text = renderedText(tree);
    expect(text).not.toContain(OVERLAY);
    expect(text).toContain(DURABLE);
    expect(cursors(tree)).toHaveLength(0);
  });

  test('after the final edit the standard Edited chip stands, and a closed key stays dark', async () => {
    // The end state: the durable edit applied (body rewritten, editedAt
    // stamped, key closed by messaging.editRow). The chip is the shipped
    // editedAt render; the overlay must not resurrect over it.
    install1to1Db([messageRow({ body: FINAL, editedAt: 2_000 })]);
    streamEdits.close(PEER, ANCHOR);
    const tree = await renderThread();

    await ReactTestRenderer.act(async () => {
      streamEdits.apply(PEER, ANCHOR, 99, 'a straggler frame');
    });

    const text = renderedText(tree);
    expect(text).toContain(FINAL);
    expect(text).not.toContain('a straggler frame');
    expect(tree.root.findAllByProps({ testID: `edited-${ANCHOR}` }).length).toBeGreaterThan(0);
    expect(cursors(tree)).toHaveLength(0);
  });

  test('an overlay never paints an OUTBOUND bubble, whatever the store holds', async () => {
    install1to1Db([
      messageRow(),
      messageRow({ msgId: OUTBOUND, direction: 'out', body: 'my own words', status: 'sent' }),
    ]);
    const tree = await renderThread();
    await ReactTestRenderer.act(async () => {
      // A hostile peer cannot reach this state through messaging (the
      // apply predicate requires direction 'in'), but the render must not
      // trust that alone: the screen derives overlays for inbound rows
      // only.
      streamEdits.apply(PEER, OUTBOUND, 1, 'repainting your words');
    });
    const text = renderedText(tree);
    expect(text).toContain('my own words');
    expect(text).not.toContain('repainting your words');
  });
});
