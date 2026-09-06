/**
 * The list comes back where you left it.
 *
 * The router keeps no stack, so this screen unmounts on every navigation
 * into a conversation and mounts afresh on the way back — and the FlatList
 * had no `initialScrollIndex`, no offset ref and nothing that persisted one.
 * Opening the thirtieth conversation and backing out put you at the top,
 * every time, all day.
 *
 * The three things this file pins, because each one is a way to get it
 * wrong:
 * - the offset SURVIVES the unmount (it is module scope, not state);
 * - it is put back EXACTLY ONCE, not on every requery — a restore per
 * refresh would fight the person's own scrolling for as long as a
 * backlog takes to drain, which is exactly when they are scrolling;
 * - it is FORGOTTEN when the screen mounts under a different account, so
 * a number from one workspace's session never lands in another's.
 *
 * `scrollToOffset` is spied on the FlatList prototype rather than reached
 * through a host ref: the assertion is about what this screen ASKS the list
 * to do, and react-test-renderer has no scroll view to ask.
 *
 * AND THE ORDER IT ASKS IN, which is the half jest can still decide. An
 * offset set before the list has measured is clamped to a zero content size
 * and lands at the top, so the restore waits for `onContentSizeChange` to
 * report a real height. Every case below therefore reports one; the case
 * that does not report one asserts the screen stays put.
 */

import React from 'react';
import { FlatList } from 'react-native';
import ReactTestRenderer from 'react-test-renderer';
import * as db from '../src/db';
import { messaging } from '../src/messaging';
import { ChatListScreen } from '../src/screens/ChatListScreen';
import { session } from '../src/session';

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
/** Two accounts, because forgetting on a change of account is the point. */
const ME = '01MEZDBSSDJSPC9J0E5N2AWMJ5';
const OTHER = '01OTHERBSSDJSPC9J0E5N2AWMJ';

const profileFor = (userId: string): db.ProfileRow => ({
  userId,
  registrationId: 7,
  displayName: 'Nat',
  about: '',
  avatarB64: '',
  profileVersion: 1,
});

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

let scrollToOffset: jest.SpyInstance;

beforeEach(async () => {
  await db.close();
  sqlite.reset();
  db.setWorkspace('real');
  await db.initDb();
  keychain.set('lockNudge.dismissed', '1');

  const instance = sqlite.instances.get('tacendum.sqlite')!;
  const base = instance.execute.getMockImplementation()!;
  instance.execute.mockImplementation(async (sql: string, params?: unknown) => {
    const s = String(sql);
    if (s.includes('FROM chats ORDER BY')) return { rows: [chatRow(SAM)] };
    return base(s, params);
  });

  scrollToOffset = jest
    .spyOn(
      FlatList.prototype as unknown as { scrollToOffset: () => void },
      'scrollToOffset',
    )
    .mockImplementation(() => undefined);
});

afterEach(async () => {
  jest.useRealTimers();
  keychain.clear();
  jest.restoreAllMocks();
  session.setMode('real');
  await db.close();
});

async function mount(
  userId: string,
): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <ChatListScreen
        profile={profileFor(userId)}
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

async function unmount(tree: ReactTestRenderer.ReactTestRenderer) {
  await ReactTestRenderer.act(() => tree.unmount());
}

/** The list finishing its measure, the way the platform reports it. */
async function reportContentSize(
  tree: ReactTestRenderer.ReactTestRenderer,
  height: number,
): Promise<void> {
  const list = tree.root.findByType(FlatList);
  await ReactTestRenderer.act(async () => {
    list.props.onContentSizeChange(320, height);
  });
}

/** Scroll the list to `y`, the way the platform reports it. */
async function scrollTo(
  tree: ReactTestRenderer.ReactTestRenderer,
  y: number,
): Promise<void> {
  const list = tree.root.findByType(FlatList);
  await ReactTestRenderer.act(async () => {
    list.props.onScroll({ nativeEvent: { contentOffset: { x: 0, y } } });
  });
}

describe('the chat list remembers where it was', () => {
  test('a fresh account starts at the top, and the list is wired to report its offset', async () => {
    const tree = await mount(ME);
    const list = tree.root.findByType(FlatList);
    expect(typeof list.props.onScroll).toBe('function');
    // Throttled, not per frame: the number is a convenience, not telemetry.
    expect(list.props.scrollEventThrottle).toBe(100);
    // Nothing to restore yet.
    expect(scrollToOffset).not.toHaveBeenCalled();
    await unmount(tree);
  });

  test('the offset survives the unmount and is put back once', async () => {
    const first = await mount(ME);
    await scrollTo(first, 420);
    await unmount(first);

    // This is the return from a conversation: a whole new mount.
    const again = await mount(ME);
    await reportContentSize(again, 1200);
    expect(scrollToOffset).toHaveBeenCalledTimes(1);
    expect(scrollToOffset).toHaveBeenCalledWith({
      offset: 420,
      // Never animated: the list should already be where it was, not be
      // seen travelling there.
      animated: false,
    });
    await unmount(again);
  });

  test('a requery does not scroll the person again while they are reading', async () => {
    // The remembered offset is module state and outlives the test above, so
    // this first mount legitimately restores it. Cleared here rather than
    // reset, because the ONLY sanctioned way to forget it is a change of
    // account — which the last case proves.
    const first = await mount(ME);
    await reportContentSize(first, 1200);
    scrollToOffset.mockClear();
    await scrollTo(first, 300);
    await unmount(first);

    const again = await mount(ME);
    await reportContentSize(again, 1200);
    expect(scrollToOffset).toHaveBeenCalledTimes(1);

    // A draining backlog: notify after notify, each one a refresh — and
    // each one growing the content, which reports its size again.
    jest.useFakeTimers();
    for (let i = 0; i < 3; i++) {
      await ReactTestRenderer.act(async () => {
        (messaging as unknown as { notify: () => void }).notify();
        jest.advanceTimersByTime(80);
      });
      await reportContentSize(again, 1200 + i);
    }
    expect(scrollToOffset).toHaveBeenCalledTimes(1);

    // And the person's own scrolling still updates what is remembered.
    jest.useRealTimers();
    await scrollTo(again, 900);
    await unmount(again);
    const third = await mount(ME);
    await reportContentSize(third, 1200);
    expect(scrollToOffset).toHaveBeenLastCalledWith({
      offset: 900,
      animated: false,
    });
    await unmount(third);
  });

  test('the restore waits for the list to measure', async () => {
    // ME's offset is 900 by now, so this mount HAS something to put back.
    const tree = await mount(ME);
    // Nothing yet: the list has not said how tall its content is, and an
    // offset set against a zero content size lands at the top — the exact
    // silent failure this ordering exists to stop.
    expect(scrollToOffset).not.toHaveBeenCalled();
    // A measure that reports nothing is not a measure.
    await reportContentSize(tree, 0);
    expect(scrollToOffset).not.toHaveBeenCalled();
    // The first real height fires it, once.
    await reportContentSize(tree, 1200);
    expect(scrollToOffset).toHaveBeenCalledTimes(1);
    expect(scrollToOffset).toHaveBeenCalledWith({
      offset: 900,
      animated: false,
    });
    // And a list that keeps growing does not keep re-scrolling.
    await reportContentSize(tree, 2400);
    expect(scrollToOffset).toHaveBeenCalledTimes(1);
    await unmount(tree);
  });

  test('a coerced session inherits nothing, under the same account id', async () => {
    // THE SEPARATION THAT ACTUALLY MATTERS. The decoy workspace copies the
    // real account's own `userId` into its profile (decoy.ts's profile
    // sync), so an account-only owner check does not fire between these two
    // mounts — and the number written while the owner was scrolling their
    // real list would be put back under the decoy.
    const real = await mount(ME);
    await scrollTo(real, 640);
    await unmount(real);

    session.setMode('duress');
    const decoy = await mount(ME);
    await reportContentSize(decoy, 1200);
    expect(scrollToOffset).not.toHaveBeenCalled();
    // And the decoy's own scrolling does not travel back either.
    await scrollTo(decoy, 210);
    await unmount(decoy);

    session.setMode('real');
    const back = await mount(ME);
    await reportContentSize(back, 1200);
    expect(scrollToOffset).not.toHaveBeenCalled();
    await unmount(back);
  });

  test('a different account inherits nothing', async () => {
    // A second account opens its own list, and it must land at the top of
    // it — even after being handed a real content height, which is the only
    // thing that would fire a restore at all.
    const other = await mount(OTHER);
    await reportContentSize(other, 1200);
    expect(scrollToOffset).not.toHaveBeenCalled();
    await unmount(other);

    // And the forgetting is real, not a suppression: coming back to ME
    // after that does not resurrect the old number either.
    const mine = await mount(ME);
    await reportContentSize(mine, 1200);
    expect(scrollToOffset).not.toHaveBeenCalled();
    await unmount(mine);
  });
});
