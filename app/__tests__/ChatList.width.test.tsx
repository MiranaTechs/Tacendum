/**
 * Two small clips on the chat list.
 *
 * - THE FAB GLYPH. The `+` is `fontSize: 30` inside a fixed 56pt disc with
 * neither `allowFontScaling={false}` nor a cap, while every sibling glyph
 * in this file has one. At 3.1× it scales to roughly 93pt in a 56pt
 * circle. The label beside it carries the meaning, exactly as the other
 * glyphs' do, so freezing it costs nothing.
 * - THE READING COLUMN. `ChatListScreen` had zero occurrences of `maxWidth`
 * or `contentMax`, while `CallsScreen`, `StartChatScreen` and
 * `SettingsScreen` all clamp — so on a medium window (600–839 dp: iPad
 * portrait, Split View, most Android tablets in portrait, the class that
 * gets no pane projection at all) the Chats tab painted 72pt rows across
 * the whole glass while Calls snapped the same rows into a 520pt column.
 * Width only: at 520 the cap never engages on a phone, so nothing about
 * a phone changes.
 *
 * And the rule that keeps the two apart: the FAB is positioned against the
 * WINDOW, not the column, or it drifts inward on a tablet and stops being
 * where a thumb goes. `ChatList.header.test.tsx` pins its clearance; this
 * file pins where it hangs.
 */

import React from 'react';
import { FlatList, StyleSheet } from 'react-native';
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

const theme = themeTokens();
const T0 = new Date('2026-09-01T09:00:00').getTime();
const SAM = '01SAMZ3NDEKTSV4RRFFQ69G5FA';

const PROFILE: db.ProfileRow = {
  userId: '01WIDDBSSDJSPC9J0E5N2AWMJ5',
  registrationId: 7,
  displayName: 'Nat',
  about: '',
  avatarB64: '',
  profileVersion: 1,
};

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
    if (s.includes('FROM chats ORDER BY')) {
      return {
        rows: [
          {
            peerId: SAM,
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
            pinnedAt: null,
          },
        ],
      };
    }
    return base(s, params);
  });
});

afterEach(async () => {
  keychain.clear();
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

test('the + glyph does not scale: a 93pt plus in a 56pt disc is a clip', async () => {
  const tree = await renderList();
  const fab = tree.root.find(
    n => n.props.testID === 'new-chat-fab' && typeof n.props.onPress === 'function',
  );
  // The label is what carries the meaning at any text size — the rule every
  // other frozen glyph in this file follows.
  expect(fab.props.accessibilityLabel).toBe('Open a room');

  const glyph = fab.findAllByProps({ allowFontScaling: false });
  expect(glyph.length).toBeGreaterThan(0);

  await ReactTestRenderer.act(() => tree.unmount());
});

test('the list reads in a column, and the + still hangs off the window', async () => {
  const tree = await renderList();

  const list = tree.root.findByType(FlatList);
  const style = StyleSheet.flatten(list.props.style) as {
    maxWidth?: number;
    width?: number | string;
    alignSelf?: string;
  };
  // The same clamp CallsScreen uses, so a tab switch changes the word and
  // not the measure.
  expect(style.maxWidth).toBe(theme.layout.contentMax);
  expect(style.width).toBe('100%');
  expect(style.alignSelf).toBe('center');
  // Width only: no height, no flex change smuggled in beside it.
  expect((style as { height?: number }).height).toBeUndefined();

  // The FAB is a sibling of the list, not inside the column: on a tablet a
  // column-anchored + drifts into the middle of the glass.
  const fab = tree.root.find(
    n => n.props.testID === 'new-chat-fab' && typeof n.props.onPress === 'function',
  );
  expect(fab.findAllByType(FlatList).length).toBe(0);
  expect(list.findAll(n => n.props.testID === 'new-chat-fab').length).toBe(0);
  const fabStyle = StyleSheet.flatten(
    fab.props.style({ pressed: false }),
  ) as { position?: string; right?: number; bottom?: number };
  expect(fabStyle.position).toBe('absolute');
  expect(fabStyle.right).toBe(theme.layout.gutter);

  await ReactTestRenderer.act(() => tree.unmount());
});
