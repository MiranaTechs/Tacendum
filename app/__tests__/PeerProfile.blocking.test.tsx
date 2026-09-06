/**
 * Blocking on the peer profile — where the full explanation lives, and where
 * the feature's worst bug would be: `messaging.isPeerBlocked()` already means
 * "sending is paused by an unaccepted identity change" and feeds
 * `safetyStateFor({ blocked })` -> 'changed'. If a block ever reached that
 * input, blocking somebody would paint a red safety alarm over a conversation
 * where nothing about the keys happened. The regression test below is the one
 * that has to keep passing.
 *
 * Harness follows ChatList.blocking.test.tsx: the fake op-sqlite from
 * jest.setup.js answers by SQL fragment, so the screen exercises the real db
 * module rather than a stubbed one.
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { AccessibilityInfo, Text } from 'react-native';
import { BLOCK_COPY as BLOCK, BLOCK_EXPLAINER } from '../src/blocking';
import * as db from '../src/db';
import { messaging } from '../src/messaging';
import { SAFETY_COPY } from '../src/safety';
import { PeerProfileScreen } from '../src/screens/PeerProfileScreen';

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
const PEER = '01SAMZ3NDEKTSV4RRFFQ69G5FA';
/** Twelve five-digit groups, so the safety section has a real state to hold. */
const SAFETY = '4'.repeat(60);

const ME: db.ProfileRow = {
  userId: '01KYDBSSDJSPC9J0E5N2AWMJ5Y',
  registrationId: 7,
  displayName: 'Nat',
  about: '',
  avatarB64: '',
  profileVersion: 1,
};

const CHAT = {
  peerId: PEER,
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

/** When the fake `blocked_peers` table says this iPhone blocked them. */
const blockedAt: { at: number | null } = { at: null };

beforeEach(async () => {
  await db.close();
  sqlite.reset();
  db.setWorkspace('real');
  await db.initDb();
  blockedAt.at = null;

  const instance = sqlite.instances.get('tacendum.sqlite')!;
  const base = instance.execute.getMockImplementation()!;
  instance.execute.mockImplementation(async (sql: string, params?: unknown) => {
    const s = String(sql);
    if (s.includes('FROM blocked_peers')) {
      return {
        rows:
          blockedAt.at === null
            ? []
            : [{ peerId: PEER, blockedAt: blockedAt.at }],
      };
    }
    if (s.includes('FROM chats')) return { rows: [CHAT] };
    return base(s, params);
  });

  jest.spyOn(messaging, 'getSafetyNumber').mockResolvedValue(SAFETY);
  jest.spyOn(messaging, 'isPeerBlocked').mockReturnValue(false);
});

afterEach(async () => {
  await db.close();
  jest.restoreAllMocks();
});

async function renderProfile(): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <PeerProfileScreen peerId={PEER} me={ME} onBack={jest.fn()} />,
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

async function press(
  tree: ReactTestRenderer.ReactTestRenderer,
  id: string,
): Promise<void> {
  await ReactTestRenderer.act(async () => {
    byId(tree, id)[0].props.onPress();
  });
}

function texts(tree: ReactTestRenderer.ReactTestRenderer): string[] {
  return tree.root.findAllByType(Text).map(n => {
    const kids = n.props.children;
    return Array.isArray(kids) ? kids.join('') : String(kids ?? '');
  });
}

describe('peer profile — blocking', () => {
  test('the section is a header, and it says what a block does and does not do', async () => {
    const tree = await renderProfile();

    const headers = tree.root
      .findAllByType(Text)
      .filter(n => n.props.accessibilityRole === 'header')
      .map(n => String(n.props.children ?? ''));
    expect(headers).toContain(BLOCK.title);

    const shown = texts(tree);
    expect(shown).toContain(BLOCK.notBlockedLabel);
    for (const line of BLOCK_EXPLAINER) expect(shown).toContain(line);
    // The honest sentence, on screen before anybody taps anything.
    expect(shown.join(' ')).toContain('It does not stop them sending.');

    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('THE COLLISION: blocking leaves the safety state byte-identical', async () => {
    const tree = await renderProfile();
    const before = texts(tree);
    expect(before).toContain(SAFETY_COPY.unchecked.label);

    jest.spyOn(messaging, 'blockPeer').mockImplementation(async () => {
      blockedAt.at = T0;
    });
    await press(tree, 'peer-block');
    await press(tree, 'peer-block-confirm');

    const after = texts(tree);
    // The block landed…
    expect(after).toContain(BLOCK.statusLabel);
    // …and the safety section did not move a character.
    expect(after).toContain(SAFETY_COPY.unchecked.label);
    expect(after).not.toContain(SAFETY_COPY.changed.label);
    expect(after.join(' ')).not.toContain('safety number changed');
    expect(after.join(' ')).not.toContain(
      'Nothing will send until you review this change.',
    );

    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('blocking is two steps, and the question has three answers', async () => {
    const block = jest
      .spyOn(messaging, 'blockPeer')
      .mockResolvedValue(undefined);
    const tree = await renderProfile();

    // Step one offers no commit control at all.
    expect(has(tree, 'peer-block')).toBe(true);
    expect(has(tree, 'peer-block-confirm')).toBe(false);

    await press(tree, 'peer-block');
    expect(texts(tree)).toContain(BLOCK.confirmQuestion);
    expect(texts(tree)).toContain(BLOCK.confirmBody);
    // Three controls, never two: a question with only two answers and no exit
    // is a trap for somebody who opened it to read what it said.
    expect(has(tree, 'peer-block-confirm')).toBe(true);
    expect(has(tree, 'peer-block-cancel')).toBe(true);
    expect(has(tree, 'peer-block')).toBe(false);

    await press(tree, 'peer-block-cancel');
    expect(block).not.toHaveBeenCalled();
    expect(has(tree, 'peer-block')).toBe(true);

    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('confirming blocks once and announces it', async () => {
    const block = jest
      .spyOn(messaging, 'blockPeer')
      .mockResolvedValue(undefined);
    const announce = jest
      .spyOn(AccessibilityInfo, 'announceForAccessibilityWithOptions')
      .mockImplementation(() => {});

    const tree = await renderProfile();
    await press(tree, 'peer-block');
    await press(tree, 'peer-block-confirm');

    expect(block).toHaveBeenCalledTimes(1);
    expect(block).toHaveBeenCalledWith(PEER);
    expect(announce).toHaveBeenCalledWith(BLOCK.blockedAnnounce, {
      queue: true,
    });

    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('while blocked the panel states the data loss, and unblock is one tap', async () => {
    blockedAt.at = T0;
    const unblock = jest
      .spyOn(messaging, 'unblockPeer')
      .mockResolvedValue(true);
    const announce = jest
      .spyOn(AccessibilityInfo, 'announceForAccessibilityWithOptions')
      .mockImplementation(() => {});

    const tree = await renderProfile();
    const shown = texts(tree);
    expect(shown).toContain(BLOCK.statusLabel);
    expect(shown).toContain(BLOCK.blockedTitle);
    expect(shown).toContain(BLOCK.blockedBody);
    expect(shown).toContain(BLOCK.blockedQuiet);
    // The explainer and the block action belong to the un-blocked state only.
    expect(has(tree, 'peer-block')).toBe(false);

    // One tap: the sentence naming what is lost is read directly above it.
    await press(tree, 'peer-unblock');
    expect(unblock).toHaveBeenCalledTimes(1);
    expect(unblock).toHaveBeenCalledWith(PEER);
    expect(announce).toHaveBeenCalledWith(BLOCK.unblockedAnnounce, {
      queue: true,
    });

    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('a failed write says so instead of pretending it saved', async () => {
    jest
      .spyOn(messaging, 'blockPeer')
      .mockRejectedValue(new Error('disk is full'));

    const tree = await renderProfile();
    await press(tree, 'peer-block');
    await press(tree, 'peer-block-confirm');

    expect(has(tree, 'peer-block-error')).toBe(true);
    expect(texts(tree)).toContain(BLOCK.failed);
    // Still not blocked, and the screen says exactly that.
    expect(texts(tree)).toContain(BLOCK.notBlockedLabel);
    expect(texts(tree)).not.toContain(BLOCK.statusLabel);

    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('every control carries a role, its own label, and a disabled state', async () => {
    /** The one node under this testID that is actually the button. */
    const button = (tree: ReactTestRenderer.ReactTestRenderer, id: string) => {
      const node = byId(tree, id).find(
        n => n.props.accessibilityRole === 'button',
      );
      expect(node).toBeDefined();
      return node!;
    };

    const tree = await renderProfile();
    expect(button(tree, 'peer-block').props.accessibilityLabel).toBe(
      BLOCK.action,
    );

    await press(tree, 'peer-block');
    for (const [id, label] of [
      ['peer-block-confirm', BLOCK.confirm],
      ['peer-block-cancel', BLOCK.cancel],
    ] as const) {
      const node = button(tree, id);
      // The label a person reads and the label VoiceOver speaks are the same
      // string, and busy is reported rather than merely obeyed.
      expect(node.props.accessibilityLabel).toBe(label);
      expect(node.props.accessibilityState).toEqual({ disabled: false });
    }

    blockedAt.at = T0;
    jest.spyOn(messaging, 'blockPeer').mockResolvedValue(undefined);
    await press(tree, 'peer-block-confirm');
    const unblock = button(tree, 'peer-unblock');
    expect(unblock.props.accessibilityLabel).toBe(BLOCK.unblock);
    expect(unblock.props.accessibilityState).toMatchObject({ disabled: false });

    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('the status rule is a theme token, never a raw colour from this module', async () => {
    // blockStatusTone names KEYS; the screen resolves them. A hex leaking into
    // the copy deck would be a second palette.
    const tree = await renderProfile();
    const status = byId(tree, 'peer-block-status')[0];
    expect(String(status.props.children)).toBe(BLOCK.notBlockedLabel);
    for (const value of Object.values(BLOCK)) {
      if (typeof value !== 'string') continue;
      expect(value).not.toMatch(/#[0-9a-f]{3,8}|rgba?\(/i);
    }

    await ReactTestRenderer.act(() => tree.unmount());
  });

  // The stale-mirror warning must come from the durable
  // flag, not from this mount's own action: a person who blocked, saw the
  // partial warning, and relaunched used to land on a screen that said
  // nothing at all while the lock screen still disagreed with them.
  test('a stale mirror renders its visible warning on a fresh mount, unprompted', async () => {
    jest
      .spyOn(messaging, 'isBlockNotificationMirrorStale')
      .mockReturnValue(true);

    const tree = await renderProfile();

    expect(has(tree, 'peer-block-partial')).toBe(true);
    expect(texts(tree)).toContain(BLOCK.mirrorStale);

    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('an unblock that could not reach the lock screen announces the truth', async () => {
    blockedAt.at = T0;
    jest.spyOn(messaging, 'unblockPeer').mockImplementation(async () => {
      jest
        .spyOn(messaging, 'isBlockNotificationMirrorStale')
        .mockReturnValue(true);
      return false;
    });
    const announce = jest
      .spyOn(AccessibilityInfo, 'announceForAccessibilityWithOptions')
      .mockImplementation(() => {});
    // The preset already mocks this method, so spyOn hands back one shared
    // mock whose calls ACCUMULATE across tests — an earlier success
    // announcement would defeat the not-called assertion below.
    announce.mockClear();

    const tree = await renderProfile();
    await press(tree, 'peer-unblock');

    expect(announce).toHaveBeenCalledWith(BLOCK.partialUnblockMirror, {
      queue: true,
    });
    expect(announce).not.toHaveBeenCalledWith(BLOCK.unblockedAnnounce, {
      queue: true,
    });
    // Visible, standing, and not tied to the announcement's moment.
    expect(has(tree, 'peer-block-partial')).toBe(true);

    await ReactTestRenderer.act(() => tree.unmount());
  });
});

// ---------------------------------------------------------------------------
// a blocked person's timer chips are off — for VoiceOver, for the eye, and
// with one line saying why.
// ---------------------------------------------------------------------------

/** The chip element itself — the composite carrying accessibilityState. */
function chip(tree: ReactTestRenderer.ReactTestRenderer, testID: string) {
  return tree.root.findAll(
    n => n.props?.testID === testID && n.props?.accessibilityState !== undefined,
  )[0]!;
}

describe('peer profile — the timer while blocked', () => {
  test('blocked: every chip is disabled in its accessibilityState, drawn recessed and muted, and the reason is on screen', async () => {
    blockedAt.at = T0;
    const { StyleSheet } = jest.requireActual<typeof import('react-native')>(
      'react-native',
    );
    const { themeTokens } = jest.requireActual<typeof import('../src/theme')>(
      '../src/theme',
    );
    const { DISAPPEAR_OPTIONS_PEER } = jest.requireActual<
      typeof import('../src/blocking')
    >('../src/blocking');
    const theme = themeTokens();
    const tree = await renderProfile();
    expect(has(tree, 'peer-unblock')).toBe(true); // the fixture reached "blocked"

    for (const option of DISAPPEAR_OPTIONS_PEER) {
      const c = chip(tree, `peer-disappear-${option.seconds}`);
      expect(c.props.disabled).toBe(true);
      expect(c.props.accessibilityState.disabled).toBe(true);
      const style = StyleSheet.flatten(c.props.style({ pressed: false }));
      expect(style.backgroundColor).toBe(theme.color.paperInset);
      expect(style.borderColor).toBe(theme.color.lineSoft);
      const label = c.findByType(Text);
      expect(StyleSheet.flatten(label.props.style).color).toBe(
        theme.color.inkMuted,
      );
    }
    expect(has(tree, 'peer-disappear-locked')).toBe(true);
    expect(texts(tree).join('\n')).toContain(
      'Nothing is sent to them while they’re blocked, so the timer can’t change. Unblock them first.',
    );
    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('not blocked: the chips are live and the reason line is absent', async () => {
    const tree = await renderProfile();
    const c = chip(tree, 'peer-disappear-0');
    expect(c.props.disabled).toBe(false);
    expect(c.props.accessibilityState).toEqual({ selected: true, disabled: false });
    expect(has(tree, 'peer-disappear-locked')).toBe(false);
    await ReactTestRenderer.act(() => tree.unmount());
  });

  // -------------------------------------------------------------------------
  // Build 27: the 1:1 list grew to six. The layout claim is a CONTRACT, not a
  // hope — a wrapping row cannot clip at any type size, which is the whole
  // reason a sixth chip is affordable without a device in hand.
  // -------------------------------------------------------------------------

  test('six chips on the 1:1 surface, in a row that wraps', async () => {
    const { StyleSheet } = jest.requireActual<typeof import('react-native')>(
      'react-native',
    );
    const { DISAPPEAR_OPTIONS_PEER } = jest.requireActual<
      typeof import('../src/blocking')
    >('../src/blocking');
    const tree = await renderProfile();

    expect(DISAPPEAR_OPTIONS_PEER).toHaveLength(6);
    for (const option of DISAPPEAR_OPTIONS_PEER) {
      expect(chip(tree, `peer-disappear-${option.seconds}`)).toBeDefined();
    }
    // Four weeks is the 1:1's own far end; the room never renders it.
    expect(chip(tree, 'peer-disappear-2419200')).toBeDefined();

    const row = tree.root.find(
      n => n.props?.testID === 'peer-disappear-row' && typeof n.type === 'string',
    );
    const style = StyleSheet.flatten(row.props.style);
    expect(style.flexDirection).toBe('row');
    // THE CONTRACT: without this a sixth chip clips off the right edge at
    // Dynamic Type XXL, on the screen where the timer is set.
    expect(style.flexWrap).toBe('wrap');

    await ReactTestRenderer.act(() => tree.unmount());
  });
});
