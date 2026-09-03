/**
 * Blocking inside the thread. The thread is where every outbound beacon
 * originates — a reply, a reaction, a retry, a screenshot notice — so the
 * assertions here are almost all about absence: the composer is gone, the rail
 * will not open, the retry control is not in the tree.
 *
 * The precedence test is the one with teeth. A block outranks an unreviewed
 * identity change, because the identity banner's whole purpose is to invite
 * Accept-then-send, and sending is exactly what a block forbids.
 *
 * Harness follows ChatThread.revise.test.tsx.
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { AccessibilityInfo, Text } from 'react-native';
import { BLOCK_COPY as BLOCK } from '../src/blocking';
import * as db from '../src/db';
import { messaging } from '../src/messaging';
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

/**
 * The live module object, not a wildcard import: `import * as` compiles to a
 * COPY of the namespace here, and a spy installed on the copy is not the
 * binding the screen calls.
 */
const RN: typeof import('react-native') = require('react-native');

const T0 = new Date('2026-07-25T12:00:00').getTime();
const PEER = 'peer-1';

const THEIRS = {
  msgId: '01THEIRS',
  peerId: PEER,
  direction: 'in',
  body: 'dinner at eight?',
  ts: T0,
  status: 'received',
  editedAt: null,
  deletedAt: null,
};
/** A send that failed, so the retry control has a reason to exist. */
const MINE_FAILED = {
  msgId: '01MINE',
  peerId: PEER,
  direction: 'out',
  body: 'on my way',
  ts: T0 + 60_000,
  status: 'error',
  editedAt: null,
  deletedAt: null,
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
    if (s.includes('FROM messages')) return { rows: [THEIRS, MINE_FAILED] };
    return base(s, params);
  });

  jest.spyOn(messaging, 'isPeerBlocked').mockReturnValue(false);
  jest.spyOn(messaging, 'getSafetyNumber').mockResolvedValue(null);
});

afterEach(async () => {
  await db.close();
  jest.restoreAllMocks();
});

async function renderThread(): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <ChatThreadScreen
        peerId={PEER}
        onBack={jest.fn()}
        onOpenPeerProfile={jest.fn()}
        onOpenPhoto={jest.fn()}
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

function texts(tree: ReactTestRenderer.ReactTestRenderer): string[] {
  return tree.root.findAllByType(Text).map(n => {
    const kids = n.props.children;
    return Array.isArray(kids) ? kids.join('') : String(kids ?? '');
  });
}

describe('chat thread — blocking', () => {
  test('the banner replaces the composer, and says what actually happens', async () => {
    blockedAt.at = T0;
    const tree = await renderThread();

    expect(has(tree, 'blocked-banner')).toBe(true);
    expect(has(tree, 'composer-input')).toBe(false);

    const shown = texts(tree);
    expect(shown).toContain(BLOCK.blockedTitle);
    expect(shown).toContain(BLOCK.blockedBody);
    expect(shown).toContain(BLOCK.blockedQuiet);
    // Never implies they were stopped: their messages arrive and are dropped.
    expect(BLOCK.blockedBody).toContain('arrive here and are discarded');

    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('PRECEDENCE: a block outranks an unreviewed identity change', async () => {
    blockedAt.at = T0;
    (messaging.isPeerBlocked as jest.Mock).mockReturnValue(true);
    const tree = await renderThread();

    expect(has(tree, 'blocked-banner')).toBe(true);
    // Accept-then-send is an action the app has already decided to refuse.
    expect(has(tree, 'identity-banner')).toBe(false);
    expect(has(tree, 'banner-accept')).toBe(false);

    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('the banner takes VoiceOver focus and says the composer is gone', async () => {
    const announce = jest
      .spyOn(AccessibilityInfo, 'announceForAccessibilityWithOptions')
      .mockImplementation(() => {});
    const focus = jest
      .spyOn(AccessibilityInfo, 'setAccessibilityFocus')
      .mockImplementation(() => {});
    // The test renderer has no native views, so the real findNodeHandle always
    // answers null and the focus call would never be reached. Standing in a tag
    // is what lets this assert the transfer rather than the null check.
    // react-native exports it as a getter, so the stand-in is installed the
    // same way and the original descriptor is put back afterwards.
    const handle = jest.fn(() => 42);
    const original = Object.getOwnPropertyDescriptor(RN, 'findNodeHandle')!;
    Object.defineProperty(RN, 'findNodeHandle', {
      configurable: true,
      get: () => handle,
    });

    try {
      blockedAt.at = T0;
      const tree = await renderThread();

      // On iOS nothing announces a control disappearing out from under a
      // finger.
      expect(announce).toHaveBeenCalledWith(BLOCK.bannerAnnounce, {
        queue: true,
      });
      expect(handle).toHaveBeenCalled();
      expect(focus).toHaveBeenCalledWith(42);

      await ReactTestRenderer.act(() => tree.unmount());
    } finally {
      Object.defineProperty(RN, 'findNodeHandle', original);
    }
  });

  test('no long press, no rail, no rotor action: a reaction is outbound', async () => {
    /** The bubbles' own pressables — the ones carrying a long-press delay. */
    const bubbles = (tree: ReactTestRenderer.ReactTestRenderer) =>
      tree.root.findAll(n => typeof n.props.delayLongPress === 'number');

    const open = await renderThread();
    const live = bubbles(open);
    // The control exists to be withdrawn: without this the assertion below
    // would pass just as well on an empty list.
    expect(live.length).toBeGreaterThan(0);
    expect(live.some(n => typeof n.props.onLongPress === 'function')).toBe(
      true,
    );
    expect(live.some(n => Array.isArray(n.props.accessibilityActions))).toBe(
      true,
    );
    await ReactTestRenderer.act(() => open.unmount());

    blockedAt.at = T0;
    const tree = await renderThread();
    const shut = bubbles(tree);
    expect(shut.length).toBe(live.length);
    // Every way into the rail is gone: the long press, and the rotor action
    // VoiceOver offers in its place.
    for (const node of shut) {
      expect(node.props.onLongPress).toBeUndefined();
      expect(node.props.accessibilityActions).toBeUndefined();
    }
    expect(has(tree, `react-${'❤️'}`)).toBe(false);

    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('a failed message keeps its mark but loses Try again', async () => {
    const tree = await renderThread();
    // It is there when the conversation is two-way…
    expect(has(tree, `retry-${MINE_FAILED.msgId}`)).toBe(true);

    await ReactTestRenderer.act(() => tree.unmount());

    blockedAt.at = T0;
    const blockedTree = await renderThread();
    // …and gone once nothing may be sent. Resending is the beacon, not the mark.
    expect(has(blockedTree, `retry-${MINE_FAILED.msgId}`)).toBe(false);
    expect(texts(blockedTree)).toContain('Not sent.');

    await ReactTestRenderer.act(() => blockedTree.unmount());
  });

  test('retrySend refuses even when it is called behind the withdrawn control', async () => {
    // Defence in depth: the button is gone, so this reaches past it and calls
    // the handler directly. The guard consults BOTH predicates, which mean
    // different things and must each stop a resend on their own.
    jest.spyOn(messaging, 'isBlockedLocally').mockReturnValue(true);
    const sendText = jest
      .spyOn(messaging, 'sendText')
      .mockResolvedValue(undefined as never);
    const remove = jest.spyOn(db, 'deleteMessage');

    blockedAt.at = T0;
    const tree = await renderThread();
    expect(has(tree, `retry-${MINE_FAILED.msgId}`)).toBe(false);

    const row = tree.root.findAll(
      n => typeof n.props.onRetrySend === 'function',
    )[0];
    await ReactTestRenderer.act(async () => {
      row.props.onRetrySend(MINE_FAILED);
    });

    expect(sendText).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();

    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('Unblock restores the composer and calls messaging once', async () => {
    blockedAt.at = T0;
    const unblock = jest
      .spyOn(messaging, 'unblockPeer')
      .mockImplementation(async () => {
        blockedAt.at = null;
        return true;
      });
    const announce = jest
      .spyOn(AccessibilityInfo, 'announceForAccessibilityWithOptions')
      .mockImplementation(() => {});

    const tree = await renderThread();
    await ReactTestRenderer.act(async () => {
      byId(tree, 'banner-unblock')[0].props.onPress();
    });
    await ReactTestRenderer.act(async () => {});

    expect(unblock).toHaveBeenCalledTimes(1);
    expect(unblock).toHaveBeenCalledWith(PEER);
    expect(announce).toHaveBeenCalledWith(BLOCK.unblockedAnnounce, {
      queue: true,
    });
    expect(has(tree, 'blocked-banner')).toBe(false);
    expect(has(tree, 'composer-input')).toBe(true);

    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('the safety panel is untouched by a block', async () => {
    // The route to the profile and the safety control both stay live: a
    // comparison is local, and the profile is where the full explanation is.
    (messaging.getSafetyNumber as jest.Mock).mockResolvedValue('4'.repeat(60));
    const tree = await renderThread();
    const before = texts(tree);

    await ReactTestRenderer.act(() => tree.unmount());

    blockedAt.at = T0;
    const blockedTree = await renderThread();
    const after = texts(blockedTree);
    // safetyStateFor never sees peerBlocked, so no safety sentence appears or
    // disappears because somebody blocked a person.
    expect(after).not.toContain('Needs review');
    expect(after.join(' ')).not.toContain('safety number changed');
    expect(before.includes('Needs review')).toBe(false);

    await ReactTestRenderer.act(() => blockedTree.unmount());
  });

  // The thread is a block/unblock entry point too, and a
  // person who just unblocked from its banner is exactly the one the stale
  // mirror lies to: the banner leaves, the composer returns, and nothing
  // visible said their calls may stay silenced on the lock screen.
  test('a stale notification mirror renders a visible warning in the thread', async () => {
    jest
      .spyOn(messaging, 'isBlockNotificationMirrorStale')
      .mockReturnValue(true);

    const tree = await renderThread();

    expect(has(tree, 'thread-block-mirror-stale')).toBe(true);
    expect(texts(tree)).toContain(BLOCK.mirrorStale);

    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('an unblock that could not reach the lock screen announces the truth here too', async () => {
    blockedAt.at = T0;
    jest.spyOn(messaging, 'unblockPeer').mockImplementation(async () => {
      blockedAt.at = null;
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

    const tree = await renderThread();
    await ReactTestRenderer.act(async () => {
      byId(tree, 'banner-unblock')[0].props.onPress();
    });
    await ReactTestRenderer.act(async () => {});

    expect(announce).toHaveBeenCalledWith(BLOCK.partialUnblockMirror, {
      queue: true,
    });
    expect(announce).not.toHaveBeenCalledWith(BLOCK.unblockedAnnounce, {
      queue: true,
    });
    expect(has(tree, 'thread-block-mirror-stale')).toBe(true);

    await ReactTestRenderer.act(() => tree.unmount());
  });
});

/**
 * The Call button.
 *
 * The design says a blocked peer, and one whose safety number has changed, cannot be
 * called. That was enforced only at the transport seam, and by then the
 * reducer had already started the camera and put a call on the lock screen.
 * The controller now refuses first — but a button that still looks live and
 * silently does nothing is its own bug, so the header has to say so.
 *
 * Rendered with `onStartCall` supplied, because the button does not exist
 * without it and a test that forgot would assert against an empty tree.
 */
describe('chat thread — the Call button obeys the outbound gate', () => {
  async function renderWithCall(): Promise<{
    tree: ReactTestRenderer.ReactTestRenderer;
    onStartCall: jest.Mock;
  }> {
    const onStartCall = jest.fn();
    let tree!: ReactTestRenderer.ReactTestRenderer;
    await ReactTestRenderer.act(() => {
      tree = ReactTestRenderer.create(
        <ChatThreadScreen
          peerId={PEER}
          onBack={jest.fn()}
          onOpenPeerProfile={jest.fn()}
          onOpenPhoto={jest.fn()}
          onStartCall={onStartCall}
        />,
      );
    });
    await ReactTestRenderer.act(async () => {});
    return { tree, onStartCall };
  }

  /** The Pressable itself — the node that carries `disabled`. */
  function callButton(tree: ReactTestRenderer.ReactTestRenderer) {
    return byId(tree, 'start-call').find(n => typeof n.type !== 'string')!;
  }

  test('offers video and audio as two visible buttons', async () => {
    // They used to be one button where a long-press meant audio. A long-press
    // that is the only route to a feature is one most people never discover,
    // and "Call" did not say which kind it would place.
    const { tree, onStartCall } = await renderWithCall();

    const video = callButton(tree);
    expect(video.props.disabled).toBeFalsy();
    await ReactTestRenderer.act(async () => video.props.onPress());
    expect(onStartCall).toHaveBeenCalledWith('video');

    const audio = byId(tree, 'start-call-audio').find(n => typeof n.type !== 'string')!;
    expect(audio.props.disabled).toBeFalsy();
    await ReactTestRenderer.act(async () => audio.props.onPress());
    expect(onStartCall).toHaveBeenCalledWith('audio');

    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('audio sits before video, and the glyphs are the larger pair', async () => {
    // Asked for from a device. Order is the array's order in the header, so
    // it is one line away from silently flipping back — nothing else in the
    // file would notice, which is why it is pinned here rather than left to
    // whoever next reads the JSX.
    const { tree } = await renderWithCall();

    // Render order IS left-to-right order for a row, so the audio button must
    // appear first in a walk of the tree.
    // First occurrence of each id, in tree order: a Pressable shows up as
    // several nested nodes, so the raw walk names each button more than once.
    const seen: string[] = [];
    for (const node of tree.root.findAll(
      n => n.props.testID === 'start-call' || n.props.testID === 'start-call-audio',
    )) {
      const id = node.props.testID as string;
      if (!seen.includes(id)) seen.push(id);
    }
    expect(seen).toEqual(['start-call-audio', 'start-call']);

    // And the glyphs grew: a control at exactly the 44pt floor crowded a
    // 24pt mark against its own edges.
    for (const id of ['start-call-audio', 'start-call']) {
      const button = byId(tree, id).find(n => typeof n.type !== 'string')!;
      const glyph = button.findAll(n => typeof n.props.size === 'number')[0];
      expect(glyph?.props.size).toBe(24);
    }

    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('disables BOTH buttons for a blocked peer, not just the video one', async () => {
    // The audio button is a second door to the same refusal; leaving it live
    // would have made the design depend on which one the person happened to tap.
    blockedAt.at = T0;
    const { tree } = await renderWithCall();

    for (const id of ['start-call', 'start-call-audio']) {
      const b = byId(tree, id).find(n => typeof n.type !== 'string')!;
      expect(b.props.disabled).toBe(true);
      expect(String(b.props.accessibilityLabel)).toMatch(/blocked this person/i);
    }

    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('no longer carries its own Safety button — the peer profile owns that', async () => {
    // Two doors to one room, and this was the smaller, less discoverable one.
    // Tapping the name opens the peer profile, which has a full Safety number
    // section. The panel itself stays: the identity-change banner opens it.
    const { tree } = await renderWithCall();
    expect(has(tree, 'verify-safety')).toBe(false);
    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('is disabled, and says why, for a peer this iPhone blocked', async () => {
    blockedAt.at = T0;
    const { tree } = await renderWithCall();
    const button = callButton(tree);

    expect(button.props.disabled).toBe(true);
    // Announced, not merely greyed: a screen reader gets no other signal that
    // the control it just found will do nothing.
    expect(button.props.accessibilityState).toMatchObject({ disabled: true });
    expect(String(button.props.accessibilityLabel)).toMatch(/blocked this person/i);
    expect(String(button.props.accessibilityHint)).toMatch(/unblock/i);

    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('is disabled, with different words, when the safety number changed', async () => {
    // Two different causes leading to two different places: one is undone by
    // unblocking, the other by verifying an identity. Collapsing them into
    // "unavailable" would send people to the wrong banner.
    (messaging.isPeerBlocked as jest.Mock).mockReturnValue(true);
    const { tree } = await renderWithCall();
    const button = callButton(tree);

    expect(button.props.disabled).toBe(true);
    expect(String(button.props.accessibilityLabel)).toMatch(/safety number changed/i);
    expect(String(button.props.accessibilityHint)).toMatch(/review/i);

    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('a block outranks an unreviewed identity change here too', async () => {
    // Same precedence the banners already use: blocking is the stronger
    // statement, and its way out is Unblock rather than Accept.
    blockedAt.at = T0;
    (messaging.isPeerBlocked as jest.Mock).mockReturnValue(true);
    const { tree } = await renderWithCall();

    expect(String(callButton(tree).props.accessibilityLabel)).toMatch(
      /blocked this person/i,
    );

    await ReactTestRenderer.act(() => tree.unmount());
  });
});

/**
 * The keyboard must not cover what you are typing.
 *
 * `KeyboardAvoidingView` was already here and did nothing: it measures its own
 * frame via onLayout and compares it to the keyboard in window coordinates,
 * and this screen renders inside `RouteTransition`, an Animated.View carrying
 * a translateX. A transformed ancestor makes that measurement unreliable.
 *
 * The keyboard's own frame needs no measuring, so these assert the arithmetic
 * rather than the layout — the part that was wrong.
 */
describe('the composer clears the keyboard', () => {
  const RN: typeof import('react-native') = require('react-native');

  function emit(event: string, screenY: number) {
    const calls = (RN.Keyboard.addListener as unknown as jest.Mock).mock.calls;
    for (const [name, handler] of calls) {
      if (name === event) {
        ReactTestRenderer.act(() => handler({ endCoordinates: { screenY } }));
      }
    }
  }

  /** The root View's paddingBottom, whatever the harness's metrics are. */
  function lift(tree: ReactTestRenderer.ReactTestRenderer): number | undefined {
    for (const node of tree.root.findAll(
      n => typeof n.type === 'string' && Array.isArray(n.props?.style),
    )) {
      for (const entry of node.props.style as unknown[]) {
        if (entry && typeof entry === 'object' && 'paddingBottom' in entry) {
          return (entry as { paddingBottom: number }).paddingBottom;
        }
      }
    }
    return undefined;
  }

  test('lifts when the keyboard appears and drops back when it goes', async () => {
    jest.spyOn(RN.Keyboard, 'addListener');
    const tree = await renderThread();
    const { height } = RN.Dimensions.get('window');

    // A keyboard whose top edge is halfway up covers half the screen.
    emit('keyboardWillChangeFrame', height / 2);
    expect(lift(tree)).toBe(height / 2);

    emit('keyboardWillHide', height);
    expect(lift(tree)).toBe(0);

    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('lifts FURTHER for a taller keyboard', async () => {
    // The direction is the whole point: a keyboard that covers more has to
    // move the composer more. A constant would satisfy the test above.
    jest.spyOn(RN.Keyboard, 'addListener');
    const tree = await renderThread();
    const { height } = RN.Dimensions.get('window');

    emit('keyboardWillChangeFrame', height - 200);
    const shorter = lift(tree);
    emit('keyboardWillChangeFrame', height - 350);
    const taller = lift(tree);

    expect(shorter).toBe(200);
    expect(taller).toBe(350);

    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('never lifts by a negative amount', async () => {
    // A hidden keyboard reports its top edge at (or below) the bottom of the
    // screen. Without the clamp that is a negative padding, which RN applies
    // as a layout error rather than ignoring.
    jest.spyOn(RN.Keyboard, 'addListener');
    const tree = await renderThread();
    const { height } = RN.Dimensions.get('window');

    emit('keyboardWillChangeFrame', height + 40);
    expect(lift(tree)).toBe(0);

    await ReactTestRenderer.act(() => tree.unmount());
  });
});
