/**
 * Calls take their place IN the conversation — as full-width chips derived at
 * render time from call_log, never as message rows (the design stands: nothing here
 * writes to `messages`). The chips are grouping-transparent, exactly like
 * screenshot and timer notices: a bubble next to one keeps its own clock.
 *
 * Harness copied from ChatThread.vault.test.tsx.
 */

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
    __sqlite: {
      instances: Map<string, FakeDb>;
      reset: () => void;
    };
  }
).__sqlite;

const T0 = new Date('2026-07-25T12:00:00').getTime();

const TEXT_IN = {
  msgId: '01TEXTIN',
  peerId: 'peer-1',
  direction: 'in',
  body: 'shall we talk instead?',
  ts: T0,
  status: 'received',
};

/** A connected video call between the two texts. */
const CALL_OK = {
  cid: '01CALLOK00000000000000000A',
  peerId: 'peer-1',
  direction: 'out',
  kind: 'video',
  state: 'ended',
  reason: 'hangup',
  startedAt: T0 + 30_000,
  connectedAt: T0 + 35_000,
  endedAt: T0 + 95_000,
  lastSeenAt: T0 + 95_000,
  missed: 0,
};

/** A missed audio call after the last text. */
const CALL_MISSED = {
  cid: '01CALLMISS000000000000000B',
  peerId: 'peer-1',
  direction: 'in',
  kind: 'audio',
  state: 'ended',
  reason: 'timeout',
  startedAt: T0 + 200_000,
  connectedAt: null,
  endedAt: T0 + 260_000,
  lastSeenAt: T0 + 260_000,
  missed: 1,
};

const TEXT_AFTER = {
  msgId: '01TEXTAFTER',
  peerId: 'peer-1',
  direction: 'out',
  body: 'sorry, missed you',
  ts: T0 + 300_000,
  status: 'sent',
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
      return { rows: [TEXT_IN, TEXT_AFTER] };
    }
    if (String(sql).includes('FROM call_log')) {
      return { rows: [CALL_MISSED, CALL_OK] }; // newest first, as the query orders
    }
    return base(sql, params);
  });
});

afterEach(async () => {
  await db.close();
});

async function renderThread(
  onStartCall?: (kind: 'audio' | 'video') => void,
): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <ChatThreadScreen
        peerId="peer-1"
        onBack={jest.fn()}
        onOpenPeerProfile={jest.fn()}
        onOpenPhoto={jest.fn()}
        onStartCall={onStartCall}
      />,
    );
  });
  await ReactTestRenderer.act(async () => {});
  return tree;
}

function renderedText(tree: ReactTestRenderer.ReactTestRenderer): string[] {
  return tree.root
    .findAllByType(require('react-native').Text)
    .map(n =>
      Array.isArray(n.props.children)
        ? n.props.children.join('')
        : String(n.props.children ?? ''),
    );
}

test('calls render as labelled chips in timeline position', async () => {
  const tree = await renderThread();
  const text = renderedText(tree).join('\n');

  // The connected call shows what it was and how long it lasted…
  expect(text).toContain('Outgoing video call');
  expect(text).toContain('1:00');
  // …and the missed call says MISSED, not a zero-second call.
  expect(text).toContain('Missed audio call');
  expect(text).not.toContain('0:00');

  // The messages around them still render.
  expect(text).toContain('shall we talk instead?');
  expect(text).toContain('sorry, missed you');
});

test('a chip redials the same kind', async () => {
  const onStartCall = jest.fn();
  const tree = await renderThread(onStartCall);

  const buttons = tree.root
    .findAllByProps({ accessibilityRole: 'button' })
    .filter(n => {
      const label = n.props.accessibilityLabel as string | undefined;
      return label !== undefined && /call/i.test(label);
    });
  expect(buttons.length).toBeGreaterThan(0);

  await ReactTestRenderer.act(async () => {
    buttons[0]!.props.onPress();
  });
  expect(onStartCall).toHaveBeenCalledWith(expect.stringMatching(/^(audio|video)$/));
});

test('a peer reusing a cid as their msgId cannot collide two list keys', async () => {
  // The peer controls their own msgIds. Before the chip namespace, a message
  // whose msgId equals a call's cid produced two identical FlatList keys —
  // React then reuses or drops a cell. Both must render.
  const sqliteInstance = sqlite.instances.get('tacendum.sqlite')!;
  const base = sqliteInstance.execute.getMockImplementation()!;
  sqliteInstance.execute.mockImplementation(async (sql: string, params?: unknown) => {
    if (String(sql).includes('FROM messages')) {
      return {
        rows: [
          TEXT_IN,
          {
            ...TEXT_AFTER,
            msgId: CALL_OK.cid, // the collision
            direction: 'in',
            body: 'colliding message',
          },
        ],
      };
    }
    if (String(sql).includes('FROM call_log')) {
      return { rows: [CALL_OK] };
    }
    return base(sql, params);
  });

  const tree = await renderThread();
  const text = renderedText(tree).join('\n');
  expect(text).toContain('colliding message');
  expect(text).toContain('Outgoing video call');
});

test('no chip ever reaches the message renderer', async () => {
  // The placeholder rows behind chips have empty bodies; if one leaked into
  // the bubble path the screen would show an empty bubble with a clock. No
  // rendered string may be the raw cid either.
  const tree = await renderThread();
  const text = renderedText(tree).join('\n');
  expect(text).not.toContain('01CALLOK');
  expect(text).not.toContain('01CALLMISS');
});
