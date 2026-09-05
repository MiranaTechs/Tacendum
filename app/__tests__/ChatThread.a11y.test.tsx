/**
 * The composer chip is announced to a screen reader (the "composer chip is
 * not announced to VoiceOver" residual, now closed).
 *
 * THE DEFECT THIS FILE EXISTS FOR. Tapping Reply or Edit put a chip above
 * the composer — "Replying to Dawit · dinner at eight?" — and said nothing:
 * a VoiceOver user who chose Reply from the rail heard focus land back on
 * the input and had no way to know the next message would answer another
 * one. The chip now announces itself when it appears or changes, and its
 * container is a polite live region for TalkBack.
 *
 * Harness copied from ChatThread.revise.test.tsx, with a named peer so the
 * announcement can be checked word for word. */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { AccessibilityInfo } from 'react-native';
import * as db from '../src/db';
import { ROUND_COPY } from '../src/rounds';
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

const THEIRS = {
  msgId: '01THEIRS',
  peerId: 'peer-1',
  direction: 'in',
  body: 'dinner at eight?',
  ts: T0,
  status: 'received',
  editedAt: null,
  deletedAt: null,
};
const MINE = {
  msgId: '01MINE',
  peerId: 'peer-1',
  direction: 'out',
  body: 'make it nine',
  ts: T0 + 60_000,
  status: 'sent',
  editedAt: null,
  deletedAt: null,
};

/** A round answer (§3.1): brief + detail, one message. */
const DETAILED = {
  msgId: '01DETAIL',
  peerId: 'peer-1',
  direction: 'in',
  body: JSON.stringify({
    tcm: 'reply',
    ref: '01MINE',
    ofs: false,
    text: 'Two findings.',
    d: 'The first is the cursor guard.',
  }),
  ts: T0 + 90_000,
  status: 'received',
  editedAt: null,
  deletedAt: null,
  ai: 1,
};

let announce: jest.SpyInstance;

beforeEach(async () => {
  announce = jest
    .spyOn(AccessibilityInfo, 'announceForAccessibilityWithOptions')
    .mockImplementation(() => {});
  await db.close();
  sqlite.reset();
  db.setWorkspace('real');
  await db.initDb();
  const instance = sqlite.instances.get('tacendum.sqlite')!;
  const base = instance.execute.getMockImplementation()!;
  instance.execute.mockImplementation(async (sql: string, params?: unknown) => {
    const s = String(sql);
    if (s.includes('FROM messages')) return { rows: [THEIRS, MINE, DETAILED] };
    if (s.includes('FROM chats')) {
      return {
        rows: [
          {
            peerId: 'peer-1',
            displayName: 'Dawit',
            localName: null,
            lastOpenedAt: T0 + 120_000,
          },
        ],
      };
    }
    return base(sql, params);
  });
});

afterEach(async () => {
  jest.restoreAllMocks();
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
  await ReactTestRenderer.act(async () => {});
  return tree;
}

function byId(tree: ReactTestRenderer.ReactTestRenderer, id: string) {
  return tree.root.findAll(n => n.props.testID === id);
}

async function press(
  tree: ReactTestRenderer.ReactTestRenderer,
  id: string,
): Promise<void> {
  await ReactTestRenderer.act(async () => {
    byId(tree, id)[0]!.props.onPress();
  });
}

async function openRail(
  tree: ReactTestRenderer.ReactTestRenderer,
  msgId: string,
): Promise<void> {
  await ReactTestRenderer.act(async () => {
    byId(tree, `msg-${msgId}`)[0]!.props.onLongPress();
  });
}

/** Every announcement made so far, in order. */
function announced(): string[] {
  return announce.mock.calls.map(([text]) => String(text));
}

test('choosing Reply announces who is being answered and what they said', async () => {
  const tree = await renderThread();
  announce.mockClear();

  await openRail(tree, '01THEIRS');
  await press(tree, 'reply-01THEIRS');

  expect(byId(tree, 'composer-chip').length).toBeGreaterThan(0);
  expect(announced()).toContain('Replying to Dawit. dinner at eight?');
  await ReactTestRenderer.act(() => tree.unmount());
});

test('choosing Edit announces the rewrite; a keystroke does not announce again', async () => {
  const tree = await renderThread();
  announce.mockClear();

  await openRail(tree, '01MINE');
  await press(tree, 'edit-01MINE');
  expect(announced()).toContain('Editing your message. make it nine');

  const before = announce.mock.calls.length;
  await ReactTestRenderer.act(async () => {
    byId(tree, 'composer-input')[0]!.props.onChangeText('make it nine thirty');
  });
  // The chip did not change — typing must not re-read it on every key.
  expect(announce.mock.calls.length).toBe(before);
  await ReactTestRenderer.act(() => tree.unmount());
});

test('the chip is a polite live region, so TalkBack reads a change in place', async () => {
  const tree = await renderThread();
  await openRail(tree, '01THEIRS');
  await press(tree, 'reply-01THEIRS');

  const chip = byId(tree, 'composer-chip').find(
    n => n.props.accessibilityLiveRegion !== undefined,
  );
  expect(chip?.props.accessibilityLiveRegion).toBe('polite');
  await ReactTestRenderer.act(() => tree.unmount());
});

/**
 * ROUNDS (§3.9 step 5). A bubble is ONE accessibility
 * element on iOS, which flattens a nested control out of the tree entirely —
 * so a tap-to-expand inside the bubble is invisible to VoiceOver unless the
 * bubble ALSO offers it as a rotor action. That is the `reveal` / `link:i`
 * precedent, and the disclosure needs it for the same reason.
 */
test('the full answer is reachable from the bubble as a rotor action, labelled from the deck', async () => {
  const tree = await renderThread();
  const bubble = byId(tree, 'msg-01DETAIL').find(
    n => Array.isArray(n.props.accessibilityActions),
  )!;
  const actions = bubble.props.accessibilityActions as {
    name: string;
    label: string;
  }[];
  expect(actions.map(a => a.name)).toContain('detail');
  expect(actions.find(a => a.name === 'detail')?.label).toBe(
    ROUND_COPY.showDetail,
  );

  await ReactTestRenderer.act(async () => {
    bubble.props.onAccessibilityAction({
      nativeEvent: { actionName: 'detail' },
    });
  });

  // The action's own label now says which way the next one goes.
  const after = byId(tree, 'msg-01DETAIL').find(
    n => Array.isArray(n.props.accessibilityActions),
  )!;
  expect(
    (after.props.accessibilityActions as { name: string; label: string }[]).find(
      a => a.name === 'detail',
    )?.label,
  ).toBe(ROUND_COPY.hideDetail);
  await ReactTestRenderer.act(() => tree.unmount());
});

test('the toggle carries accessibilityState.expanded, both ways', async () => {
  const tree = await renderThread();
  const toggle = () =>
    tree.root.findAll(
      n => typeof n.type === 'string' && n.props.testID === 'detail-01DETAIL',
    )[0]!;
  expect(toggle().props.accessibilityRole).toBe('button');
  expect(toggle().props.accessibilityState).toEqual({ expanded: false });
  await ReactTestRenderer.act(async () => {
    byId(tree, 'detail-01DETAIL')[0]!.props.onPress();
  });
  expect(toggle().props.accessibilityState).toEqual({ expanded: true });
  expect(toggle().props.accessibilityLabel).toBe(ROUND_COPY.hideDetail);
  await ReactTestRenderer.act(() => tree.unmount());
});

test('a bubble with no detail offers no such action', async () => {
  const tree = await renderThread();
  const bubble = byId(tree, 'msg-01THEIRS').find(
    n => Array.isArray(n.props.accessibilityActions),
  )!;
  expect(
    (bubble.props.accessibilityActions as { name: string }[]).map(a => a.name),
  ).not.toContain('detail');
  await ReactTestRenderer.act(() => tree.unmount());
});
