/**
 * The Calls tab: every finished call, newest first, named and pictured from
 * the chats table at render time — and each row can redial or open the room.
 */

jest.mock('../src/db', () => ({
  listAllCalls: jest.fn(),
  listChats: jest.fn(),
}));

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import * as db from '../src/db';
import { CallsScreen } from '../src/screens/CallsScreen';

const listAllCalls = db.listAllCalls as jest.MockedFunction<typeof db.listAllCalls>;
const listChats = db.listChats as jest.MockedFunction<typeof db.listChats>;

const T0 = new Date('2026-07-25T12:00:00').getTime();

const CALL_A = {
  cid: '01CALLA0000000000000000001',
  peerId: 'peer-1',
  direction: 'in' as const,
  kind: 'audio' as const,
  state: 'ended' as const,
  reason: 'timeout',
  startedAt: T0 + 60_000,
  connectedAt: null,
  endedAt: T0 + 120_000,
  lastSeenAt: T0 + 120_000,
  missed: 1,
};
const CALL_B = {
  cid: '01CALLB0000000000000000002',
  peerId: 'peer-2',
  direction: 'out' as const,
  kind: 'video' as const,
  state: 'ended' as const,
  reason: 'hangup',
  startedAt: T0,
  connectedAt: T0 + 4_000,
  endedAt: T0 + 34_000,
  lastSeenAt: T0 + 34_000,
  missed: 0,
};

beforeEach(() => {
  jest.clearAllMocks();
  listAllCalls.mockResolvedValue([CALL_A, CALL_B]);
  listChats.mockResolvedValue([
    { peerId: 'peer-1', displayName: 'Ayana', localName: '', avatarB64: null },
    { peerId: 'peer-2', displayName: '', localName: 'Dawit', avatarB64: 'QUJD' },
  ] as never);
});

async function renderCalls(over: {
  onOpenChat?: jest.Mock;
  onCall?: jest.Mock;
} = {}): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <CallsScreen
        onOpenChat={over.onOpenChat ?? jest.fn()}
        onCall={over.onCall ?? jest.fn()}
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
        ? n.props.children.join('')
        : String(n.props.children ?? ''),
    )
    .join('\n');
}

test('rows carry the NAME, the label, and the duration — never a raw id', async () => {
  const tree = await renderCalls();
  const text = renderedText(tree);

  expect(text).toContain('Ayana');
  expect(text).toContain('Dawit');
  expect(text).toContain('Missed audio call');
  expect(text).toContain('Outgoing video call');
  expect(text).toContain('0:30');
  expect(text).not.toContain('peer-1');
  expect(text).not.toContain('01CALLA');
});

test('the row opens the room; the trailing button redials the same kind', async () => {
  const onOpenChat = jest.fn();
  const onCall = jest.fn();
  const tree = await renderCalls({ onOpenChat, onCall });

  const redial = tree.root
    .findAllByProps({ accessibilityRole: 'button' })
    .find(n => n.props.accessibilityLabel === 'Video call Dawit');
  expect(redial).toBeDefined();
  await ReactTestRenderer.act(async () => {
    redial!.props.onPress();
  });
  expect(onCall).toHaveBeenCalledWith('peer-2', 'video');

  const row = tree.root
    .findAllByProps({ accessibilityRole: 'button' })
    .find(n => String(n.props.accessibilityLabel ?? '').startsWith('Ayana,'));
  expect(row).toBeDefined();
  await ReactTestRenderer.act(async () => {
    row!.props.onPress();
  });
  expect(onOpenChat).toHaveBeenCalledWith('peer-1');
});

test('an empty log says so instead of rendering nothing', async () => {
  listAllCalls.mockResolvedValue([]);
  const tree = await renderCalls();
  expect(renderedText(tree)).toContain('No calls yet');
});

test("the disc gets the RAW stored name — a nameless caller's monogram comes from the id tail, not from '…'", async () => {
  // personName's resolved label is for the Text line; fed to the Avatar it
  // made monogram() slice "…KX7A9QZ2" into "…K". The disc's documented
  // nameless fallback is the id TAIL (person.ts), which needs a null name.
  const { Avatar } = require('../src/ui/Avatar') as typeof import('../src/ui/Avatar');
  listChats.mockResolvedValue([
    { peerId: 'peer-1', displayName: 'Ayana', localName: '', avatarB64: null },
    // peer-2: no chat row at all — a caller this phone never named.
  ] as never);

  const tree = await renderCalls();
  const discs = tree.root.findAllByType(Avatar);
  const byPeer = new Map(discs.map(d => [d.props.peerId as string, d.props]));

  // Named: the raw stored name, not the resolved label (same string here,
  // but the nameless case below is what tells them apart).
  expect(byPeer.get('peer-1')?.displayName).toBe('Ayana');
  // Nameless: NULL, so monogram() takes its documented id-tail path — never
  // the resolved "…"-prefixed label.
  expect(byPeer.get('peer-2')?.displayName ?? null).toBeNull();
});

test('opening the tab clears the missed-call notices for every peer', async () => {
  // The rows on this screen are what the notices pointed at; showing them
  // answers them.
  const facade = require('../src/call') as { clearMissedCallNotices(peerId: string | null): Promise<void> };
  const spy = jest.spyOn(facade, 'clearMissedCallNotices').mockResolvedValue(undefined);
  try {
    await renderCalls();
    expect(spy).toHaveBeenCalledWith(null);
  } finally {
    spy.mockRestore();
  }
});

// ---------------------------------------------------------------------------
// The frame and the rows.
// ---------------------------------------------------------------------------

test('the Calls header is the same HomeHeader as Chats, with the profile door when the shell hands one over', async () => {
  const { HomeHeader } = require('../src/ui/primitives') as typeof import('../src/ui/primitives');
  const theme = (require('../src/theme') as typeof import('../src/theme')).themeTokens();
  const { StyleSheet, Text } = require('react-native') as typeof import('react-native');
  const onOpenProfile = jest.fn();
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <CallsScreen
        onOpenChat={jest.fn()}
        onCall={jest.fn()}
        profile={{ userId: 'me', displayName: 'Nat', avatarB64: '' }}
        onOpenProfile={onOpenProfile}
      />,
    );
  });
  await ReactTestRenderer.act(async () => {});

  const header = tree.root.findByType(HomeHeader);
  expect(header.props.title).toBe('Calls');
  // No bespoke 28/700 title any more: the one header role, screenTitle size.
  const title = header.findAll(
    n => n.props.accessibilityRole === 'header' && n.props.children === 'Calls',
  )[0]!;
  expect(StyleSheet.flatten(title.props.style).fontSize).toBe(theme.type.screenTitle.fontSize);
  for (const node of tree.root.findAllByType(Text)) {
    expect(StyleSheet.flatten(node.props.style)?.fontSize).not.toBe(28);
  }
  const door = tree.root.find(
    n => n.props.testID === 'home-profile-door' && typeof n.props.onPress === 'function',
  );
  await ReactTestRenderer.act(async () => {
    door.props.onPress();
  });
  expect(onOpenProfile).toHaveBeenCalledTimes(1);
});

test('rows take the glyph kit, the row disc and a 44pt redial — no typographic stand-ins', async () => {
  const { Avatar } = require('../src/ui/Avatar') as typeof import('../src/ui/Avatar');
  const { PhoneGlyph, VideoGlyph } = require('../src/ui/CallGlyph') as typeof import('../src/ui/CallGlyph');
  const theme = (require('../src/theme') as typeof import('../src/theme')).themeTokens();
  const { StyleSheet, Text } = require('react-native') as typeof import('react-native');
  const tree = await renderCalls();

  // The audio row redials with the handset, the video row with the camera.
  expect(tree.root.findAllByType(PhoneGlyph).length).toBe(1);
  expect(tree.root.findAllByType(VideoGlyph).length).toBe(1);
  expect(renderedText(tree)).not.toMatch(/[⧉✆]/);

  // The disc is the list row size, not a one-off 44.
  for (const disc of tree.root.findAllByType(Avatar)) {
    expect(disc.props.size).toBe(theme.layout.avatar.row);
  }

  // The redial disc is a full touch target.
  const redial = tree.root.find(
    n => n.props.accessibilityLabel === 'Video call Dawit' && typeof n.props.onPress === 'function',
  );
  const host = redial.findAll(
    n => typeof n.type === 'string' && typeof n.props.style !== 'function',
  )[0]!;
  const style = StyleSheet.flatten(host.props.style) as { width?: number; height?: number };
  expect(style.width).toBe(theme.layout.touchTarget);
  expect(style.height).toBe(theme.layout.touchTarget);

  // Type comes off the scale: the name is rowTitle, the time is timeStatus.
  const name = tree.root.findAll(
    n => n.type === Text && n.props.children === 'Dawit',
  )[0]!;
  expect(StyleSheet.flatten(name.props.style).fontSize).toBe(theme.type.rowTitle.fontSize);
});

test('the redial is a white disc with a hairline edge and a forest glyph; a press moves it to the gray fill', async () => {
  // The white palette (2026-10-04): no forest wash behind the row's one
  // action. The disc is white like the row, so its hairline is its edge, and
  // the forest glyph is what says it acts. FALSIFYING CASE: the old resting
  // wash and the forest-outline press fail the first and last assertions.
  const { PhoneGlyph, VideoGlyph } = require('../src/ui/CallGlyph') as typeof import('../src/ui/CallGlyph');
  const theme = (require('../src/theme') as typeof import('../src/theme')).themeTokens();
  const { StyleSheet } = require('react-native') as typeof import('react-native');
  const tree = await renderCalls();
  const redial = tree.root.find(
    n => n.props.accessibilityLabel === 'Video call Dawit' && typeof n.props.style === 'function',
  );
  expect(StyleSheet.flatten(redial.props.style({ pressed: false }))).toMatchObject({
    backgroundColor: theme.color.paperSheet,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.lineSoft,
  });
  expect(redial.findAllByType(VideoGlyph)[0]!.props.color).toBe(theme.color.pine);
  expect(tree.root.findAllByType(PhoneGlyph)[0]!.props.color).toBe(theme.color.pine);
  expect(
    StyleSheet.flatten(redial.props.style({ pressed: true })).backgroundColor,
  ).toBe(theme.color.paperInset);
});

test('the time sits on one line and never gives up width to the name', async () => {
  // The redial moving out of the row made the time a THIRD
  // flex child of `styles.row`, beside a name column that is `flex: 1`. A
  // flex child measured against the space left over wraps when there is not
  // much of it, which at large Dynamic Type is the ordinary case — so the
  // row grows a second line for a timestamp.
  const { StyleSheet, Text } = require('react-native') as typeof import('react-native');
  const theme = (require('../src/theme') as typeof import('../src/theme')).themeTokens();
  const tree = await renderCalls();

  const times = tree.root.findAll(
    n =>
      n.type === Text &&
      StyleSheet.flatten(n.props.style)?.fontSize === theme.type.timeStatus.fontSize &&
      typeof n.props.children === 'string',
  );
  expect(times).not.toHaveLength(0);
  for (const time of times) {
    expect(time.props.numberOfLines).toBe(1);
    expect(StyleSheet.flatten(time.props.style).flexShrink).toBe(0);
  }
});
