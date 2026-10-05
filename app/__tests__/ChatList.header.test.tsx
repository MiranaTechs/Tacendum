/**
 * The chat list's frame.
 *
 *  - the home header is the SHARED `HomeHeader` primitive — the
 *    same one the Calls tab renders — at `layout.headerHeight`, with the
 *    title in the screenTitle role and the profile door as a 44pt target.
 *    Before, this screen drew its own 64pt header and Calls drew a third.
 *  - the list's content clears the + button. The FAB floats at
 *    24pt from the bottom and is 56pt tall, so without bottom padding the
 *    last row's right half — and its long-press Block/Delete drawer — sat
 *    under it, and the Delete confirm for the last row was partly
 *    unreachable. The scroll indicator is inset by the same amount.
 *
 * Harness follows ChatList.blocking.test.tsx: the fake op-sqlite answers by
 * SQL fragment, so the real db module runs under the screen. */

import React from 'react';
import { FlatList, StyleSheet } from 'react-native';
import ReactTestRenderer from 'react-test-renderer';
import * as db from '../src/db';
import { ChatListScreen } from '../src/screens/ChatListScreen';
import { themeTokens } from '../src/theme';

const theme = themeTokens();
import { HomeHeader } from '../src/ui/primitives';

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

const T0 = new Date('2026-07-23T09:00:00').getTime();

const PROFILE: db.ProfileRow = {
  userId: '01KYDBSSDJSPC9J0E5N2AWMJ5Y',
  registrationId: 7,
  displayName: 'Nat',
  about: '',
  avatarB64: '',
  profileVersion: 0,
};

const SAM = '01SAMZ3NDEKTSV4RRFFQ69G5FA';

function chatRow(peerId: string, name: string, lastMessageAt: number | null) {
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

beforeEach(async () => {
  await db.close();
  sqlite.reset();
  db.setWorkspace('real');
  await db.initDb();

  const instance = sqlite.instances.get('tacendum.sqlite')!;
  const base = instance.execute.getMockImplementation()!;
  instance.execute.mockImplementation(async (sql: string, params?: unknown) => {
    const s = String(sql);
    if (s.includes('FROM blocked_peers')) return { rows: [] };
    if (s.includes('FROM chats')) return { rows: [chatRow(SAM, 'Sam', T0)] };
    return base(s, params);
  });
});

afterEach(async () => {
  await db.close();
  jest.restoreAllMocks();
});

async function renderList(
  onOpenProfile: jest.Mock = jest.fn(),
): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <ChatListScreen
        profile={PROFILE}
        onOpenChat={jest.fn()}
        onOpenProfile={onOpenProfile}
        onStartChat={jest.fn()}
        onStartRoom={jest.fn()}
      />,
    );
  });
  await ReactTestRenderer.act(async () => {});
  return tree;
}

/** The resolved style of a host node: a Pressable's own style is a function;
 * the View beneath holds what the screen actually gets. */
function hostStyle(node: ReactTestRenderer.ReactTestInstance) {
  const host = node.findAll(
    n => typeof n.type === 'string' && typeof n.props.style !== 'function',
  )[0]!;
  return StyleSheet.flatten(host.props.style) as Record<string, unknown>;
}

test('the header is the shared HomeHeader: screenTitle role, headerHeight, and a 44pt profile door', async () => {
  const onOpenProfile = jest.fn();
  const tree = await renderList(onOpenProfile);

  const header = tree.root.findByType(HomeHeader);
  expect(header.props.title).toBe('Rooms');
  // The frame itself is the token height — not the bespoke 64 it used to be.
  expect(hostStyle(header).minHeight).toBe(theme.layout.headerHeight);

  // The title carries the header role in the screenTitle size.
  const title = header.findAll(
    n =>
      n.props.accessibilityRole === 'header' && n.props.children === 'Rooms',
  )[0]!;
  expect(StyleSheet.flatten(title.props.style).fontSize).toBe(
    theme.type.screenTitle.fontSize,
  );

  // The door: labelled, a 44pt target, and it opens the profile.
  const door = tree.root.find(
    n =>
      n.props.testID === 'home-profile-door' &&
      typeof n.props.onPress === 'function',
  );
  expect(door.props.accessibilityLabel).toBe('Open your profile');
  expect(hostStyle(door).width).toBe(theme.layout.touchTarget);
  await ReactTestRenderer.act(async () => {
    door.props.onPress();
  });
  expect(onOpenProfile).toHaveBeenCalledTimes(1);

  // The connection line still rides under the title, inside the header. It
  // is keyed by the live socket state (`ws-<state>`) — 'closed' here, since
  // nothing started the messaging session — so the prefix is the invariant.
  expect(
    header.findAll(n => /^ws-/.test(String(n.props.testID ?? ''))).length,
  ).toBeGreaterThan(0);
});

test('the list content and the scroll indicator clear the + button', async () => {
  const tree = await renderList();
  const list = tree.root.findByType(FlatList);
  // 24pt from the bottom + 56pt tall, plus one s6 of breathing room: the
  // last row and its action drawer must sit ABOVE the FAB, not under it.
  const clearance = 24 + 56 + theme.space.s6;
  const content = StyleSheet.flatten(list.props.contentContainerStyle) as {
    paddingBottom?: number;
  };
  expect(content.paddingBottom).toBeGreaterThanOrEqual(clearance);
  expect(list.props.scrollIndicatorInsets?.bottom).toBeGreaterThanOrEqual(
    clearance,
  );
});
