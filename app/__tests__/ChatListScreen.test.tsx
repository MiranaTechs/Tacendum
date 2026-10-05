/**
 * The chat list's refresh ordering and its row-action discoverability.
 *
 *  - `refresh` is N async reads with no sequence guard, called
 *    directly after a delete/block and from the 80 ms notify window. Two
 *    overlapping refreshes could commit out of order, so an OLDER snapshot
 *    landed after a newer one — a just-deleted row flickering back until the
 *    next notify. The guard is CallsScreen's own `refreshSeq`.
 *  - Block/Delete lived only behind a 320 ms long-press and the
 *    VoiceOver rotor action, and nothing on screen said so. Every row now
 *    carries a trailing "…" target that opens the same drawer, and the empty
 *    state says where the actions live. The long press and the rotor action
 *    stay exactly as they were.
 *
 * Harness follows ChatList.blocking.test.tsx: the fake op-sqlite from
 * jest.setup.js answers by SQL fragment, so the screen exercises the real db
 * module rather than a stubbed one. The `listChats` read alone can be HELD,
 * so two refreshes can be made to answer in the wrong order on purpose. */

/**
 * The row's avatar, counted: a plain function, never memoised, so its call
 * count is the row's render count. The screen's own `ConversationRow` is not
 * exported, and a memo that works leaves an untouched row's avatar uncalled
 * when a neighbour's drawer opens. */
jest.mock('../src/ui/Avatar', () => ({
  Avatar: jest.fn(() => null),
}));

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { StyleSheet, Text } from 'react-native';
import * as db from '../src/db';
import { messaging } from '../src/messaging';
import { spellId } from '../src/person';
import { ChatListScreen } from '../src/screens/ChatListScreen';
import { themeTokens } from '../src/theme';

const AvatarMock = (
  jest.requireMock('../src/ui/Avatar') as { Avatar: jest.Mock }
).Avatar;
/** The Keychain the lock and the lock nudge both live in (jest.setup.js). */
const keychain = (
  jest.requireMock('tacendum-crypto') as { __keychain: Map<string, string> }
).__keychain;

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

const theme = themeTokens();
const T0 = new Date('2026-09-01T09:00:00').getTime();

const PROFILE: db.ProfileRow = {
  userId: '01KYDBSSDJSPC9J0E5N2AWMJ5Y',
  registrationId: 7,
  displayName: 'Nat',
  about: '',
  avatarB64: '',
  profileVersion: 1,
};

const SAM = '01SAMZ3NDEKTSV4RRFFQ69G5FA';

function chatRow(
  peerId: string,
  /** Null is a real row: a peer who has never shared a card. */
  name: string | null,
  lastMessageAt: number | null,
) {
  return {
    peerId,
    displayName: name,
    lastMessageAt,
    lastMessageText: lastMessageAt === null ? null : 'see you',
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
interface HeldRead {
  resolve: (rows: ChatRows) => void;
}

/** What the fake `chats` table answers with on an unheld read. */
const chatRows: { rows: ChatRows } = { rows: [] };
/** When set, every `listChats` read is parked here in call order and
 * answers only when the test says so — the one lever that makes two
 * refreshes commit out of order. */
const hold: { on: boolean; reads: HeldRead[] } = { on: false, reads: [] };
/** What `unreadCounts` answers with. Its statement is the only one in the
 * module carrying `COUNT(*) AS n`, so the match cannot catch a neighbour. */
const unreadRows: { rows: { peerId: string; n: number }[] } = { rows: [] };

beforeEach(async () => {
  await db.close();
  sqlite.reset();
  db.setWorkspace('real');
  await db.initDb();
  chatRows.rows = [chatRow(SAM, 'Sam', T0)];
  hold.on = false;
  hold.reads = [];
  unreadRows.rows = [];

  const instance = sqlite.instances.get('tacendum.sqlite')!;
  const base = instance.execute.getMockImplementation()!;
  instance.execute.mockImplementation(async (sql: string, params?: unknown) => {
    const s = String(sql);
    // `listChats` alone carries this ORDER BY; getChat and the rest of the
    // chats-table reads keep answering through the stock fake.
    if (s.includes('FROM chats ORDER BY')) {
      if (!hold.on) return { rows: chatRows.rows };
      return new Promise<{ rows: ChatRows }>(resolve => {
        hold.reads.push({ resolve: rows => resolve({ rows }) });
      });
    }
    if (s.includes('COUNT(*) AS n')) return { rows: unreadRows.rows };
    return base(s, params);
  });
});

afterEach(async () => {
  jest.useRealTimers();
  jest.restoreAllMocks();
  await db.close();
});

async function renderList(): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <ChatListScreen
        profile={PROFILE}
        onOpenChat={jest.fn()}
        onOpenProfile={jest.fn()}
        onStartChat={jest.fn()}
        onStartRoom={jest.fn()}
      />,
    );
  });
  await ReactTestRenderer.act(async () => {});
  return tree;
}

function byId(tree: ReactTestRenderer.ReactTestRenderer, id: string) {
  return tree.root.findAll(n => n.props.testID === id);
}

/** A testID reaches several nodes of one element; presence is the question. */
function has(tree: ReactTestRenderer.ReactTestRenderer, id: string): boolean {
  return byId(tree, id).length > 0;
}

/** The control itself: a Pressable's host View carries no `onPress`. */
function control(tree: ReactTestRenderer.ReactTestRenderer, id: string) {
  return tree.root.find(
    n => n.props.testID === id && typeof n.props.onPress === 'function',
  );
}

async function press(
  tree: ReactTestRenderer.ReactTestRenderer,
  id: string,
): Promise<void> {
  await ReactTestRenderer.act(async () => {
    control(tree, id).props.onPress();
  });
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

/** What every receipt, frame and socket transition does to subscribers. */
function notify(): void {
  (messaging as unknown as { notify: () => void }).notify();
}

async function unmount(tree: ReactTestRenderer.ReactTestRenderer) {
  await ReactTestRenderer.act(() => {
    tree.unmount();
  });
}

describe('chat list — refresh ordering', () => {
  test('an older refresh snapshot never lands after a newer one', async () => {
    hold.on = true;
    // Mount is refresh #1: its listChats read is parked.
    const tree = await renderList();
    expect(hold.reads.length).toBe(1);

    // A notify opens the 80 ms window; the window's refresh is #2, and its
    // read is parked behind the first.
    jest.useFakeTimers();
    await ReactTestRenderer.act(async () => {
      notify();
      jest.advanceTimersByTime(80);
    });
    expect(hold.reads.length).toBe(2);

    // The NEWER read answers first: Sam's conversation is gone.
    await ReactTestRenderer.act(async () => {
      hold.reads[1]!.resolve([]);
    });
    expect(has(tree, `chat-${SAM}`)).toBe(false);

    // The OLDER read answers last, still carrying Sam. It describes a
    // moment the list has already moved past, so it must not repaint him.
    await ReactTestRenderer.act(async () => {
      hold.reads[0]!.resolve([chatRow(SAM, 'Sam', T0)]);
    });
    expect(has(tree, `chat-${SAM}`)).toBe(false);

    await unmount(tree);
  });

  test('the newest refresh still lands when it is the last to answer', async () => {
    hold.on = true;
    const tree = await renderList();
    jest.useFakeTimers();
    await ReactTestRenderer.act(async () => {
      notify();
      jest.advanceTimersByTime(80);
    });
    expect(hold.reads.length).toBe(2);

    // In order this time: the guard drops only what has been superseded.
    await ReactTestRenderer.act(async () => {
      hold.reads[0]!.resolve([]);
    });
    expect(has(tree, `chat-${SAM}`)).toBe(false);
    await ReactTestRenderer.act(async () => {
      hold.reads[1]!.resolve([chatRow(SAM, 'Sam', T0)]);
    });
    expect(has(tree, `chat-${SAM}`)).toBe(true);

    await unmount(tree);
  });
});

describe('chat list — row actions are discoverable', () => {
  test('each row carries a trailing … target that opens and closes the actions drawer', async () => {
    const tree = await renderList();
    expect(has(tree, `chat-${SAM}`)).toBe(true); // the fixture reached the list
    expect(has(tree, `chat-delete-${SAM}`)).toBe(false);

    await press(tree, `chat-more-${SAM}`);
    expect(has(tree, `chat-block-${SAM}`)).toBe(true);
    expect(has(tree, `chat-delete-${SAM}`)).toBe(true);

    // The same control closes what it opened — the long press's own toggle.
    await press(tree, `chat-more-${SAM}`);
    expect(has(tree, `chat-delete-${SAM}`)).toBe(false);

    await unmount(tree);
  });

  test('the … target is a 44pt control; the long press and the rotor action stay', async () => {
    const tree = await renderList();
    const more = control(tree, `chat-more-${SAM}`);
    const style = StyleSheet.flatten(more.props.style({ pressed: false })) as {
      width?: number;
      minHeight?: number;
    };
    expect(style.width).toBe(theme.layout.touchTarget);
    expect(style.minHeight).toBe(theme.layout.touchTarget);
    // Visual only: the row is one VoiceOver element whose rotor action reaches
    // the same drawer, so the glyph must not be read out as "ellipsis" after
    // every preview.
    expect(more.props.accessibilityElementsHidden).toBe(true);
    expect(more.props.importantForAccessibility).toBe('no-hide-descendants');

    const row = byId(tree, `chat-${SAM}`)[0]!;
    expect(typeof row.props.onLongPress).toBe('function');
    expect(row.props.accessibilityActions).toEqual([
      { name: 'actions', label: 'Room actions' },
    ]);
    // The rotor action still opens the drawer.
    await ReactTestRenderer.act(async () => {
      row.props.onAccessibilityAction({ nativeEvent: { actionName: 'actions' } });
    });
    expect(has(tree, `chat-delete-${SAM}`)).toBe(true);

    await unmount(tree);
  });

  test('the empty state says where a conversation’s actions live', async () => {
    chatRows.rows = [];
    const tree = await renderList();
    expect(has(tree, 'empty-actions-hint')).toBe(true);
    expect(texts(tree)).toContain('… beside a room');

    await unmount(tree);
  });
});

const KIM = '01KIMZ3NDEKTSV4RRFFQ69G5FB';

describe('chat list — rows are memoised', () => {
  test('opening one row’s drawer does not re-render the others', async () => {
    chatRows.rows = [chatRow(SAM, 'Sam', T0), chatRow(KIM, 'Kim', T0 - 1)];
    const tree = await renderList();
    expect(has(tree, `chat-${SAM}`)).toBe(true);
    expect(has(tree, `chat-${KIM}`)).toBe(true);

    const rendersOf = (peerId: string) =>
      AvatarMock.mock.calls.filter(
        c => (c[0] as { peerId?: string }).peerId === peerId,
      ).length;
    const kimBefore = rendersOf(KIM);
    const samBefore = rendersOf(SAM);
    expect(kimBefore).toBeGreaterThan(0);

    // Sam's drawer opens: the list re-renders with a new `menu`, Sam's row
    // legitimately draws again — Kim's props are unchanged and her row must
    // not.
    await press(tree, `chat-more-${SAM}`);
    expect(has(tree, `chat-delete-${SAM}`)).toBe(true);
    expect(rendersOf(SAM)).toBeGreaterThan(samBefore);
    expect(rendersOf(KIM)).toBe(kimBefore);

    await unmount(tree);
  });
});

/**
 * The delete confirmation describes everything removed.
 *
 * deleteChat now purges the conversation's 1:1 call log with it,
 * because a chatless person degraded to a bare id fragment in Calls and
 * stayed one tap from redial. The confirmation has to admit what it takes.
 *
 * The existing confirmation sentence stays unchanged; the additional fact
 * uses a second line that names no device.
 */
describe('the delete confirmation admits the calls', () => {
  test('a second line under the existing sentence, which is unchanged', async () => {
    const tree = await renderList();
    await press(tree, `chat-more-${SAM}`);
    await press(tree, `chat-delete-${SAM}`);

    const shown = texts(tree);
    // The anchored sentence, still exactly itself.
    expect(shown).toContain('Tacendum has no copy to restore.');
    // And the new one, by identity.
    expect(shown).toContain('Your calls with them go too.');
    // It is its own line, not a rewrite of the first.
    expect(has(tree, `chat-delete-calls-${SAM}`)).toBe(true);
    // No device noun rides in on it.
    const line = tree.root.find(
      n => n.props.testID === `chat-delete-calls-${SAM}`,
    ).props.children as string;
    expect(line).not.toMatch(/phone|device|iphone|tablet/i);

    await unmount(tree);
  });

  test('the line belongs to the confirmation, not the row', async () => {
    const tree = await renderList();
    expect(has(tree, `chat-delete-calls-${SAM}`)).toBe(false);
    await press(tree, `chat-more-${SAM}`);
    // The drawer alone does not claim it either — only the confirm step.
    expect(has(tree, `chat-delete-calls-${SAM}`)).toBe(false);
    await unmount(tree);
  });
});

/**
 * A stranger who has never shared a name is their id, and a
 * screen reader said those eight ULID characters as invented words. The
 * row's SPOKEN label now spells the tail; the visible text is untouched, so
 * the two channels still name the same person.
 */
describe('chat list — an unnamed peer is spoken as an id', () => {
  const NOBODY = '01N0B0DYZ3NDEKTSV4RRFFQ69G';

  test('the unread row spells the id tail while its visible text is unchanged', async () => {
    chatRows.rows = [chatRow(NOBODY, null, T0)];
    unreadRows.rows = [{ peerId: NOBODY, n: 1 }];
    const tree = await renderList();

    const row = byId(tree, `chat-${NOBODY}`)[0]!;
    const spoken = String(row.props.accessibilityLabel);
    // Said: "ID ending 6 9 G 5" — the tail, spaced for a voice.
    expect(spoken).toContain('ID ending');
    expect(spoken).toContain(spellId(NOBODY.slice(-8)));
    // Not said: the run-together tail a screen reader turns into a word.
    expect(spoken).not.toContain(NOBODY.slice(-8));
    // The falsifier for "the label just became the visible string": it did
    // not — the ellipsis abbreviation is a visual mark and never spoken.
    expect(spoken).not.toContain('…');

    // Shown, unchanged: the same eight characters under the ellipsis.
    expect(texts(tree)).toContain(`…${NOBODY.slice(-8)}`);

    await unmount(tree);
  });

  test('a named peer is spoken by name, exactly as before', async () => {
    unreadRows.rows = [{ peerId: SAM, n: 1 }];
    const tree = await renderList();
    const spoken = String(byId(tree, `chat-${SAM}`)[0]!.props.accessibilityLabel);
    expect(spoken).toContain('Sam');
    expect(spoken).not.toContain('ID ending');
    await unmount(tree);
  });
});

/**
 * The one-time App Lock nudge. After the naming moment nothing ever said
 * the app can be locked: the lock lives three taps away in Settings, and a
 * person who never opens Settings never learns their chats are only as
 * private as the phone's own lock. The chat list says it once — a quiet
 * card in the naming nudge's own slot, never an alert — and either control
 * settles it durably, in the Keychain the lock itself lives in. Never while
 * the lock is on; never after the naming nudge has been shown but not
 * answered (one nudge at a time, naming first). */
describe('chat list — the App Lock nudge', () => {
  const LOCK_ENABLED = 'lock.enabled';
  const DISMISSED = 'lockNudge.dismissed';
  const NAMELESS: db.ProfileRow = { ...PROFILE, displayName: '', profileVersion: 0 };

  beforeEach(() => {
    keychain.clear();
  });

  async function renderWith(
    props: { profile?: db.ProfileRow; onOpenAppLock?: () => void } = {},
  ): Promise<ReactTestRenderer.ReactTestRenderer> {
    let tree!: ReactTestRenderer.ReactTestRenderer;
    await ReactTestRenderer.act(() => {
      tree = ReactTestRenderer.create(
        <ChatListScreen
          profile={props.profile ?? PROFILE}
          onOpenChat={jest.fn()}
          onOpenProfile={jest.fn()}
          onStartChat={jest.fn()}
          onStartRoom={jest.fn()}
          {...(props.onOpenAppLock ? { onOpenAppLock: props.onOpenAppLock } : {})}
        />,
      );
    });
    await ReactTestRenderer.act(async () => {});
    return tree;
  }

  test('with the lock off and nothing answered, the list asks once — teaching copy behind the ⓘ', async () => {
    const tree = await renderWith();
    expect(has(tree, 'lock-nudge')).toBe(true);
    expect(texts(tree)).toContain('Add a lock code');
    expect(texts(tree)).toContain('only as private as');
    expect(has(tree, 'lock-nudge-info')).toBe(true);
    expect(has(tree, 'lock-nudge-skip')).toBe(true);
    // No route into Settings was handed in: no action claims one. The body
    // still says where the lock lives.
    expect(has(tree, 'lock-nudge-open')).toBe(false);
    expect(texts(tree)).toContain('Settings');
    await unmount(tree);
  });

  test('the empty state carries it too', async () => {
    chatRows.rows = [];
    const tree = await renderWith();
    expect(has(tree, 'chat-' + SAM)).toBe(false);
    expect(has(tree, 'lock-nudge')).toBe(true);
    await unmount(tree);
  });

  test('Not now settles it durably: gone now, gone on the next mount', async () => {
    const tree = await renderWith();
    await press(tree, 'lock-nudge-skip');
    expect(has(tree, 'lock-nudge')).toBe(false);
    expect(keychain.get(DISMISSED)).toBe('1');
    await unmount(tree);

    const again = await renderWith();
    expect(has(again, 'lock-nudge')).toBe(false);
    await unmount(again);
  });

  test('Open Settings is the route in when one is wired, and counts as the one showing', async () => {
    const onOpenAppLock = jest.fn();
    const tree = await renderWith({ onOpenAppLock });
    expect(has(tree, 'lock-nudge-open')).toBe(true);
    await press(tree, 'lock-nudge-open');
    expect(onOpenAppLock).toHaveBeenCalledTimes(1);
    expect(has(tree, 'lock-nudge')).toBe(false);
    expect(keychain.get(DISMISSED)).toBe('1');
    await unmount(tree);
  });

  test('never while App Lock is on', async () => {
    keychain.set(LOCK_ENABLED, '1');
    const tree = await renderWith();
    expect(has(tree, 'lock-nudge')).toBe(false);
    expect(keychain.get(DISMISSED)).toBeUndefined();
    await unmount(tree);
  });

  test('never a second time once dismissed, even with the lock still off', async () => {
    keychain.set(DISMISSED, '1');
    const tree = await renderWith();
    expect(has(tree, 'lock-nudge')).toBe(false);
    await unmount(tree);
  });

  test('the naming nudge goes first; the lock nudge follows its answer', async () => {
    const tree = await renderWith({ profile: NAMELESS });
    expect(has(tree, 'naming-nudge')).toBe(true);
    expect(has(tree, 'lock-nudge')).toBe(false);

    await press(tree, 'naming-nudge-skip');
    expect(has(tree, 'naming-nudge')).toBe(false);
    expect(has(tree, 'lock-nudge')).toBe(true);
    await unmount(tree);
  });
});


test('opening a conversation leaves the prior unread stamp for the thread to capture', async () => {
  const mark = jest.spyOn(db, 'markChatOpened').mockResolvedValue();
  const sync = jest.spyOn(messaging, 'syncThreadRead').mockResolvedValue();
  const tree = await renderList();
  await press(tree, `chat-${SAM}`);
  expect(mark).not.toHaveBeenCalled();
  expect(sync).not.toHaveBeenCalled();
  await unmount(tree);
});
