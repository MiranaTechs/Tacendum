/**
 * The home screen stops flashing "Nobody else is here yet".
 *
 * `chats` initialised to `[]` with no loading gate, and the router is
 * deliberately not keep-alive, so
 * every return from a thread remounted this screen and painted the Quiet
 * Room — the empty title, the numbered first-run steps — at a person with
 * forty conversations, until `db.listChats()` answered. It is the
 * highest-frequency friction in the app: it happens on every navigation, to
 * everyone.
 *
 * The fix is the one the thread already ships: a `loaded` flag set on the first `listChats` resolve, with
 * `ListEmptyComponent` rendering nothing until then. No skeleton, no shimmer,
 * no spinner.
 *
 * Harness: ChatListScreen.test.tsx's. The `listChats` read alone is parked,
 * so "before the list answers" is a state this file can actually hold.
 */

import React from 'react';
import { Text, StyleSheet } from 'react-native';
import ReactTestRenderer from 'react-test-renderer';
import * as db from '../src/db';
import { ChatListScreen } from '../src/screens/ChatListScreen';
import { themeTokens } from '../src/theme';

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
const keychain = (
  jest.requireMock('tacendum-crypto') as { __keychain: Map<string, string> }
).__keychain;

const T0 = new Date('2026-09-01T09:00:00').getTime();
const SAM = '01SAMZ3NDEKTSV4RRFFQ69G5FA';

const PROFILE: db.ProfileRow = {
  userId: '01LOADDBSSDJSPC9J0E5N2AWMJ',
  registrationId: 7,
  displayName: 'Nat',
  about: '',
  avatarB64: '',
  profileVersion: 1,
};

function chatRow(peerId: string) {
  return {
    peerId,
    displayName: 'Sam',
    lastMessageAt: T0,
    lastMessageText: 'see you',
    about: null,
    avatarB64: null,
    profileVersion: null,
    safetyCheckedAt: null,
    localName: null,
    createdAt: T0,
    lastOpenedAt: null,
    identityChangedAt: null,
    safetyMismatchAt: null,
  };
}
type ChatRows = ReturnType<typeof chatRow>[];

/** Every `listChats` read, parked until the test answers it — either way. */
const reads: {
  resolve: (rows: ChatRows) => void;
  reject: (reason: Error) => void;
}[] = [];

beforeEach(async () => {
  await db.close();
  sqlite.reset();
  db.setWorkspace('real');
  await db.initDb();
  reads.length = 0;
  // The lock nudge would otherwise mount its own card in the empty state and
  // muddy "nothing is painted yet".
  keychain.set('lockNudge.dismissed', '1');

  const instance = sqlite.instances.get('tacendum.sqlite')!;
  const base = instance.execute.getMockImplementation()!;
  instance.execute.mockImplementation(async (sql: string, params?: unknown) => {
    const s = String(sql);
    if (s.includes('FROM chats ORDER BY')) {
      return new Promise<{ rows: ChatRows }>((resolve, reject) => {
        reads.push({ resolve: rows => resolve({ rows }), reject });
      });
    }
    return base(s, params);
  });
});

afterEach(async () => {
  // Answer whatever is still parked BEFORE closing. The harness cuts every
  // in-flight statement on close, and a rejection nobody owns takes the
  // worker down rather than failing a test.
  for (const read of reads) read.resolve([]);
  reads.length = 0;
  await new Promise<void>(resolve => setTimeout(() => resolve(), 0));
  keychain.clear();
  jest.restoreAllMocks();
  await db.close();
});

async function mount(
  onOpenAttention?: () => void,
): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <ChatListScreen
        profile={PROFILE}
        onOpenChat={jest.fn()}
        onOpenProfile={jest.fn()}
        onStartChat={jest.fn()}
        onStartRoom={jest.fn()}
        onOpenAttention={onOpenAttention}
      />,
    );
  });
  await ReactTestRenderer.act(async () => {});
  return tree;
}

function has(tree: ReactTestRenderer.ReactTestRenderer, id: string): boolean {
  return tree.root.findAll(n => n.props.testID === id).length > 0;
}

function texts(tree: ReactTestRenderer.ReactTestRenderer): string {
  return tree.root
    .findAllByType(Text)
    .map(n => {
      const kids = n.props.children;
      return Array.isArray(kids) ? kids.join('') : String(kids ?? '');
    })
    .join('\n');
}

async function answer(rows: ChatRows): Promise<void> {
  await ReactTestRenderer.act(async () => {
    reads[reads.length - 1]!.resolve(rows);
  });
}

describe('the chat list before its first answer', () => {
  test('the attention door remains discoverable even with no chat row to render', async () => {
    const onOpen = jest.fn();
    const tree = await mount(onOpen);

    const door = tree.root.findByProps({ testID: 'open-attention' });
    await ReactTestRenderer.act(async () => door.props.onPress());
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  test('nothing is painted where the empty state goes — no title, no steps', async () => {
    const tree = await mount();
    expect(reads.length).toBe(1); // the read is genuinely still in flight

    expect(texts(tree)).not.toContain('Nobody else is here yet');
    expect(texts(tree)).not.toContain('Send someone your ID.');
    expect(has(tree, 'empty-actions-hint')).toBe(false);
    expect(has(tree, 'empty-copy-id')).toBe(false);
    // And no substitute was invented in its place (app-spec cut list).
    expect(has(tree, 'chat-list-skeleton')).toBe(false);
    expect(has(tree, 'chat-list-spinner')).toBe(false);
    // The header is furniture and still paints: the gate is about the LIST.
    expect(
      tree.root.findAll(n => /^ws-/.test(String(n.props.testID ?? ''))).length,
    ).toBeGreaterThan(0);

    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('an answer of zero rows is what raises the empty state, once', async () => {
    const tree = await mount();
    expect(texts(tree)).not.toContain('Nobody else is here yet');

    await answer([]);
    expect(texts(tree)).toContain('Nobody else is here yet');
    expect(has(tree, 'empty-actions-hint')).toBe(true);

    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('an answer with rows paints rows and never the empty state', async () => {
    const tree = await mount();
    await answer([chatRow(SAM)]);
    expect(has(tree, `chat-${SAM}`)).toBe(true);
    expect(texts(tree)).not.toContain('Nobody else is here yet');

    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('a read that FAILS opens the gate too, rather than a blank screen forever', async () => {
    // A closed connection during a workspace switch or a relock is the
    // realistic case. `loaded` exists to stop the empty state flashing
    // before the answer, not to withhold the screen forever: with no
    // rejection arm the gate never lifted, and the person was left with a
    // header, a + and nothing else, with no way back but a remount. The
    // empty state is the WRONG answer here, but it is a screen that offers a
    // way out of itself.
    const tree = await mount();
    await ReactTestRenderer.act(async () => {
      reads[reads.length - 1]!.reject(new Error('connection closed'));
    });

    expect(texts(tree)).toContain('Nobody else is here yet');
    expect(has(tree, 'empty-copy-id')).toBe(true);

    await ReactTestRenderer.act(() => tree.unmount());
  });

  // Added for build 33: the step numerals are ordinal marks, not an
  // action, so they are gray; forest stays for what can be pressed.
  test('the empty state numbers its steps in gray, never forest', async () => {
    const tree = await mount();
    await answer([]);
    const numerals = tree.root.findAll(
      n => typeof n.type === 'string' && (n.props.children === '1.' || n.props.children === '2.'),
    );
    expect(numerals).toHaveLength(2);
    for (const numeral of numerals) {
      expect(StyleSheet.flatten(numeral.props.style).color).toBe(themeTokens().color.inkMuted);
    }
    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('a remount is a fresh gate: the return from a thread paints nothing either', async () => {
    // The router is not keep-alive, so this IS what coming back from a
    // conversation does. It was the whole defect.
    const first = await mount();
    await answer([chatRow(SAM)]);
    await ReactTestRenderer.act(() => first.unmount());

    const again = await mount();
    expect(texts(again)).not.toContain('Nobody else is here yet');
    await answer([chatRow(SAM)]);
    expect(has(again, `chat-${SAM}`)).toBe(true);

    await ReactTestRenderer.act(() => again.unmount());
  });
});


test('zero pending requests keeps a compact AI entry without an empty attention card', async () => {
  jest.spyOn(db, 'listPendingApprovalSummaries').mockResolvedValue([]);
  const tree = await mount(jest.fn());
  const door = tree.root.findByProps({ testID: 'open-attention' });
  expect(door.props.accessibilityLabel).toBe('AI activity and setup');
  expect(texts(tree)).toContain('AI activity and setup');
  expect(texts(tree)).not.toContain('Needs attention');
  expect(StyleSheet.flatten(door.props.style({ pressed: false })).minHeight).toBe(44);
  await ReactTestRenderer.act(() => tree.unmount());
});
