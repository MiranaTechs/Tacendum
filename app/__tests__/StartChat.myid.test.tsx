/**
 * MY ID IS ONE TAP (Start a chat, build 33).
 *
 * Your own ID and your QR code used to sit behind two nested toggles inside
 * the reach-someone page. Now they are one section under a hairline, "My ID",
 * collapsed on every visit: one tap shows the ID in large mono type, Copy ID,
 * Share ID and the QR code — and only then is the QR encoded.
 *
 * Never "code" for your own identifier: shipped copy uses "your code" for
 * the App Lock passcode and the duress code, and "share your code" is the
 * classic social-engineering line. Share sends the ID as a message only,
 * never as a link (the bare-ID guardrail).
 */

import React from 'react';
import {
  AccessibilityInfo,
  Clipboard,
  Dimensions,
  ScrollView,
  Share,
  StyleSheet,
} from 'react-native';
import ReactTestRenderer, { type ReactTestInstance } from 'react-test-renderer';
import * as db from '../src/db';
import { shareIdMessage } from '../src/peerId';
import { spellId } from '../src/person';
import { StartChatScreen } from '../src/screens/StartChatScreen';
import { themeTokens } from '../src/theme';

jest.mock('react-native-image-picker', () => ({
  launchImageLibrary: jest.fn(),
  launchCamera: jest.fn(),
}));

const nativeQr = jest.requireMock('tacendum-qr') as {
  encodePng: jest.Mock;
  clearSharePng: jest.Mock;
  __qr: { reset: () => void };
};

const sqlite = (
  jest.requireMock('@op-engineering/op-sqlite') as {
    __sqlite: { reset: () => void };
  }
).__sqlite;

const theme = themeTokens();

const PROFILE: db.ProfileRow = {
  userId: '01KYDBSSDJSPC9J0E5N2AWMJ5Y',
  registrationId: 7,
  displayName: '',
  about: '',
  avatarB64: '',
  profileVersion: 0,
};
const SELF = PROFILE.userId;

/** The preset's own window, restored after any test that resizes text. */
const PRESET_WINDOW = { width: 750, height: 1334, scale: 2, fontScale: 2 };

type Tree = ReactTestRenderer.ReactTestRenderer;

beforeEach(async () => {
  await db.close();
  sqlite.reset();
  db.setWorkspace('real');
  await db.initDb();
  nativeQr.__qr.reset();
  nativeQr.encodePng.mockClear();
  nativeQr.clearSharePng.mockClear();
});

afterEach(async () => {
  jest.useRealTimers();
  Dimensions.set({ window: PRESET_WINDOW, screen: PRESET_WINDOW });
  jest.restoreAllMocks();
  await db.close();
});

async function render(): Promise<Tree> {
  let tree!: Tree;
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(
      <StartChatScreen
        profile={PROFILE}
        onBack={jest.fn()}
        onOpenChat={jest.fn()}
        onOpenAccountEmail={jest.fn()}
      />,
    );
  });
  await ReactTestRenderer.act(async () => {});
  return tree;
}

function hosts(tree: Tree, id: string): ReactTestInstance[] {
  return tree.root.findAll(n => n.props.testID === id && typeof n.type === 'string');
}

function has(tree: Tree, id: string): boolean {
  return hosts(tree, id).length > 0;
}

function control(tree: Tree, id: string): ReactTestInstance {
  const node = tree.root.findAll(
    n => n.props.testID === id && typeof n.props.onPress === 'function',
  )[0];
  if (!node) throw new Error(`no control with testID ${id}`);
  return node;
}

async function press(tree: Tree, id: string): Promise<void> {
  await ReactTestRenderer.act(async () => {
    control(tree, id).props.onPress();
  });
}

/** Let the next frame run (the scroll-to waits for one). */
async function nextFrame(): Promise<void> {
  await ReactTestRenderer.act(async () => {
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  });
}

/** Stand in a layout for the section, as the native layout pass would. */
async function layOut(tree: Tree, y: number): Promise<void> {
  const section = tree.root.findAll(
    n => n.props.testID === 'my-id-section' && typeof n.props.onLayout === 'function',
  )[0]!;
  await ReactTestRenderer.act(async () => {
    section.props.onLayout({ nativeEvent: { layout: { x: 0, y, width: 358, height: 72 } } });
  });
}

function scrollSpy(tree: Tree): jest.Mock {
  const scroll = tree.root.findByType(ScrollView);
  const spy = jest.fn();
  (scroll.instance as unknown as { scrollTo: unknown }).scrollTo = spy;
  return spy;
}

describe('collapsed on every visit', () => {
  test('no ID and no QR in the tree, nothing encoded, and My ID is a heading', async () => {
    const tree = await render();

    expect(has(tree, 'self-user-id')).toBe(false);
    expect(has(tree, 'self-qr-image')).toBe(false);
    expect(nativeQr.encodePng).not.toHaveBeenCalled();
    expect(hosts(tree, 'my-id-title')[0]!.props.accessibilityRole).toBe('header');
    expect(control(tree, 'show-self-id').props.accessibilityState.expanded).toBe(false);
    expect(control(tree, 'show-self-id').props.accessibilityLabel).toBe('Show my ID');
  });
});

describe('one tap opens it all', () => {
  test('the ID in groups with a break after the fourth, spelled for VoiceOver, and one encode of the QR', async () => {
    const tree = await render();
    await press(tree, 'show-self-id');

    const id = hosts(tree, 'self-user-id')[0]!;
    expect(id.props.children).toBe('01KY DBSS DJSP C9J0\nE5N2 AWMJ 5Y');
    expect(id.props.accessibilityLabel).toBe(spellId(SELF));
    expect(id.props.selectable).toBe(true);
    expect(id.props.maxFontSizeMultiplier).toBe(2);
    expect(has(tree, 'self-qr-image')).toBe(true);
    expect(nativeQr.encodePng).toHaveBeenCalledTimes(1);
    expect(control(tree, 'show-self-id').props.accessibilityState.expanded).toBe(true);
    expect(control(tree, 'show-self-id').props.accessibilityLabel).toBe('Hide my ID');
    // The buttons say what they carry.
    expect(control(tree, 'copy-self-id').props.label).toBe('Copy ID');
    expect(control(tree, 'share-self-id').props.label).toBe('Share ID');
  });

  test('Copy ID copies the bare ID and says so for three seconds', async () => {
    jest.useFakeTimers();
    const write = jest.spyOn(Clipboard, 'setString').mockImplementation(() => {});
    write.mockClear();
    const tree = await render();
    await press(tree, 'show-self-id');
    await press(tree, 'copy-self-id');

    expect(write).toHaveBeenCalledWith(SELF);
    expect(has(tree, 'self-id-copied')).toBe(true);
    await ReactTestRenderer.act(async () => {
      jest.advanceTimersByTime(2999);
    });
    expect(has(tree, 'self-id-copied')).toBe(true);
    await ReactTestRenderer.act(async () => {
      jest.advanceTimersByTime(1);
    });
    expect(has(tree, 'self-id-copied')).toBe(false);
  });

  test('Share ID shares the ID as a message only, never a link', async () => {
    const share = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' } as never);
    const tree = await render();
    await press(tree, 'show-self-id');
    await press(tree, 'share-self-id');

    const content = share.mock.calls[0]![0] as { message?: string; url?: string };
    expect(content).toEqual({ message: shareIdMessage(SELF) });
    expect(content.url).toBeUndefined();
  });

  test('closing takes the QR away and clears its share file', async () => {
    const tree = await render();
    await press(tree, 'show-self-id');
    expect(has(tree, 'self-qr-image')).toBe(true);
    await press(tree, 'show-self-id');

    expect(has(tree, 'self-qr-image')).toBe(false);
    expect(has(tree, 'self-user-id')).toBe(false);
    expect(nativeQr.clearSharePng).toHaveBeenCalled();
  });
});

describe('it fits large text and small targets', () => {
  test('Copy ID and Share ID stack once text is larger than 1.35x, and share a row below that', async () => {
    const big = { width: 390, height: 844, scale: 3, fontScale: 1.5 };
    Dimensions.set({ window: big, screen: big });
    const stacked = await render();
    await press(stacked, 'show-self-id');
    expect(StyleSheet.flatten(hosts(stacked, 'my-id-actions')[0]!.props.style).flexDirection).toBe(
      'column',
    );
    await ReactTestRenderer.act(async () => {
      stacked.unmount();
    });

    const normal = { width: 390, height: 844, scale: 3, fontScale: 1 };
    Dimensions.set({ window: normal, screen: normal });
    const row = await render();
    await press(row, 'show-self-id');
    expect(StyleSheet.flatten(hosts(row, 'my-id-actions')[0]!.props.style).flexDirection).toBe(
      'row',
    );
  });

  test('the chevron is at least 44 points both ways; the header row adds no screen-reader stop of its own', async () => {
    const tree = await render();
    const chevron = control(tree, 'show-self-id');
    const style = StyleSheet.flatten(
      typeof chevron.props.style === 'function'
        ? chevron.props.style({ pressed: false })
        : chevron.props.style,
    ) as { minWidth?: number; minHeight?: number };
    expect(style.minWidth).toBeGreaterThanOrEqual(theme.layout.touchTarget);
    expect(style.minHeight).toBeGreaterThanOrEqual(theme.layout.touchTarget);

    const row = tree.root.findAll(
      n => n.props.testID === 'my-id-row' && typeof n.props.onPress === 'function',
    )[0]!;
    expect(row.props.accessible).toBe(false);
    expect(row.props.focusable).toBe(false);
    expect(row.props.importantForAccessibility).toBe('no');
  });
});

describe('every opening scrolls the section into view', () => {
  test('the chevron scrolls to the section top less 16, animated', async () => {
    const tree = await render();
    await layOut(tree, 640);
    const scroll = scrollSpy(tree);
    await press(tree, 'show-self-id');
    await nextFrame();

    expect(scroll).toHaveBeenCalledWith({ y: 624, animated: true });
  });

  test('Show my ID in the self notice does the same, and not animated under Reduce Motion', async () => {
    // Replaced and put back by hand: the preset ships this as a mock with a
    // default answer, so a spy has no original to restore.
    const original = AccessibilityInfo.isReduceMotionEnabled;
    AccessibilityInfo.isReduceMotionEnabled = jest.fn(async () => true);
    try {
      const tree = await render();
      await layOut(tree, 700);
      const scroll = scrollSpy(tree);
      await ReactTestRenderer.act(async () => {
        hosts(tree, 'new-peer-input')[0]!.props.onChangeText(SELF);
      });
      await press(tree, 'start-chat-show-my-id');
      await nextFrame();

      expect(scroll).toHaveBeenCalledWith({ y: 684, animated: false });
      expect(has(tree, 'self-user-id')).toBe(true);
    } finally {
      AccessibilityInfo.isReduceMotionEnabled = original;
    }
  });
});
