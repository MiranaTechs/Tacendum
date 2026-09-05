// The shared drag, called through — real behaviour, and a record of the box
// each render handed it (the keyboard test reads that record).
jest.mock('../src/ui/pipDrag', () => {
  const actual = jest.requireActual('../src/ui/pipDrag');
  return { ...actual, usePipDrag: jest.fn(actual.usePipDrag) };
});

import React from 'react';
import { AccessibilityInfo, Dimensions, Keyboard, StyleSheet } from 'react-native';
import ReactTestRenderer from 'react-test-renderer';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import type { CallState } from '@tacendum/shared';
import {
  CallOverlay,
  OVERLAY_AUDIO_BOX,
  OVERLAY_BOTTOM_CLEARANCE,
  OVERLAY_TOP_CLEARANCE,
  OVERLAY_VIDEO_BOX,
  overlayAccessibilityLabel,
  overlayBox,
  overlayLine,
} from '../src/screens/CallOverlay';
import { keyboardPaneInset } from '../src/keyboardInset';
import {
  PIP_ACCESSIBILITY_ACTIONS,
  PIP_MARGIN,
  PIP_WIDTH,
  pipAnchor,
  usePipDrag,
  type PipBox,
} from '../src/ui/pipDrag';
import { Avatar } from '../src/ui/Avatar';

/**
 * The minimized 1:1 call window ("go back to
 * the chat from a video call while the video call is on — minimized on the
 * top right corner and moveable, similar to whatsapp").
 *
 * It renders `CallState` and calls back — no state of its own, no native
 * module — so every shape below renders without a device. What is pinned:
 * which shape a call gets (video window vs audio pill), whose face and name
 * are on it (and that an id never is), that a tap restores and a drag is
 * wired through the shared pip gesture, that it is NOT a modal for
 * VoiceOver (the app underneath must stay usable), and where it parks.
 *
 * Time is a fixed `now` and a fixed fixture — no advancing timers beside a
 * frozen clock (the frozen-clock landmine); the tick is exercised by the
 * pure `overlayLine` with explicit numbers.
 */

const T = 1_800_000_000_000;

function state(
  over: Partial<NonNullable<CallState['call']>> & { name?: CallState['name'] } = {},
): CallState {
  const { name = 'connected', ...call } = over;
  if (name === 'idle') return { name: 'idle', call: null };
  return {
    name,
    call: {
      cid: '01J0000000000000000000000A',
      peerId: 'P1',
      direction: 'out',
      video: false,
      peerAudio: true,
      peerVideo: false,
      startedAt: T - 60_000,
      connectedAt: T - 65_000,
      remoteOfferSdp: '',
      pendingIce: [],
      remoteReady: true,
      ...call,
    },
  } as CallState;
}

const mounted: ReactTestRenderer.ReactTestRenderer[] = [];
afterEach(() => {
  ReactTestRenderer.act(() => {
    for (const t of mounted.splice(0)) t.unmount();
  });
});

function render(over: Partial<React.ComponentProps<typeof CallOverlay>> = {}) {
  const props = {
    state: state(),
    peerName: 'Dana',
    onRestore: jest.fn(),
    onHangup: jest.fn(),
    now: () => T,
    ...over,
  };
  let tree!: ReactTestRenderer.ReactTestRenderer;
  ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <SafeAreaProvider
        initialMetrics={{
          frame: { x: 0, y: 0, width: 390, height: 844 },
          insets: { top: 47, left: 0, right: 0, bottom: 34 },
        }}
      >
        <CallOverlay {...props} />
      </SafeAreaProvider>,
    );
  });
  mounted.push(tree);
  const byTestID = (testID: string) =>
    tree.root.findAll(n => n.props.testID === testID && typeof n.type !== 'string')[0];
  const texts = () =>
    tree.root
      .findAll(n => String(n.type) === 'Text')
      .map(n => [n.props.children].flat().join(''));
  const videoViews = () =>
    tree.root.findAll(n => (n.type as unknown as string) === 'TacendumVideoView');
  /** The draggable wrapper: the HOST view the panHandlers landed on. */
  const wrapper = () =>
    tree.root.findAll(
      n => typeof n.type === 'string' && typeof n.props.onMoveShouldSetResponder === 'function',
    )[0];
  return { tree, props, byTestID, texts, videoViews, wrapper };
}

describe('the line under the name', () => {
  it('is the running time once media flows, from connectedAt', () => {
    expect(overlayLine(state({ connectedAt: T - 65_000 }), T)).toBe('1:05');
    expect(overlayLine(state({ connectedAt: T - 3_725_000 }), T)).toBe('1:02:05');
  });

  it('is the state’s own word while reconnecting or ending — never a frozen time', () => {
    expect(overlayLine(state({ name: 'reconnecting' }), T)).toBe('Reconnecting…');
    expect(overlayLine(state({ name: 'ending' }), T)).toBe('Ending…');
  });

  it('speaks the person then the state, at minute granularity', () => {
    expect(overlayAccessibilityLabel(state({ connectedAt: T - 30_000 }), 'Dana', T)).toBe(
      'Dana, Connected',
    );
    expect(overlayAccessibilityLabel(state({ connectedAt: T - 185_000 }), 'Dana', T)).toBe(
      'Dana, 3 minutes',
    );
    expect(overlayAccessibilityLabel(state({ name: 'reconnecting' }), 'Dana', T)).toBe(
      'Dana, Reconnecting',
    );
    // The id-refusal rule: a "name" that is the peer's id speaks as the
    // placeholder, never as id characters.
    expect(overlayAccessibilityLabel(state(), 'P1', T)).toBe('Someone, 1 minute');
  });
});

describe('an audio call is a pill', () => {
  it('shows their picture, their name and the time; no video surface', () => {
    const { texts, videoViews, tree } = render();
    expect(videoViews()).toHaveLength(0);
    const faces = tree.root.findAllByType(Avatar);
    expect(faces).toHaveLength(1);
    expect(faces[0]!.props.peerId).toBe('P1');
    expect(faces[0]!.props.displayName).toBe('Dana');
    expect(texts()).toContain('Dana');
    expect(texts()).toContain('1:05');
  });

  it('is the paper surface, not the media black — it floats over the chat', () => {
    const { wrapper } = render();
    const flat = StyleSheet.flatten(wrapper()!.props.style);
    expect(flat.backgroundColor).toBe('#FAFCF7');
    expect(flat.width).toBe(OVERLAY_AUDIO_BOX.width);
    expect(flat.height).toBe(OVERLAY_AUDIO_BOX.height);
  });

  it('carries an End control as a SIBLING of the restore surface, 44pt', () => {
    // Inside an accessible Pressable it would be unreachable to VoiceOver.
    const { byTestID, props } = render();
    const end = byTestID('call-overlay-end');
    expect(end.props.accessibilityLabel).toBe('End call');
    const restore = byTestID('call-overlay');
    expect(restore.findAll(n => n.props.testID === 'call-overlay-end')).toHaveLength(0);
    const flat = StyleSheet.flatten(
      typeof end.props.style === 'function' ? end.props.style({ pressed: false }) : end.props.style,
    );
    expect(flat.width).toBe(44);
    expect(flat.height).toBe(44);
    ReactTestRenderer.act(() => end.props.onPress());
    expect(props.onHangup).toHaveBeenCalledTimes(1);
    expect(props.onRestore).not.toHaveBeenCalled();
  });

  it('has no End control when none is offered', () => {
    const { byTestID } = render({ onHangup: undefined });
    expect(byTestID('call-overlay-end')).toBeUndefined();
  });

  it('never letters itself with id characters', () => {
    const { texts } = render({ peerName: 'P1' });
    expect(texts()).toContain('Someone');
    expect(texts()).not.toContain('P1');
  });
});

describe('a video call is the peer’s video in the self-view’s box', () => {
  const PHOTO = '/9j/4AAQSkZJRgABAQAAAQABAAD==';

  it('renders the REMOTE track, cover-cropped, in the 110pt 16:9 window', () => {
    const { videoViews, wrapper } = render({
      state: state({ video: true, peerVideo: true }),
    });
    const views = videoViews();
    expect(views).toHaveLength(1);
    expect(views[0]!.props.track).toBe('remote');
    expect(views[0]!.props.cid).toBe('01J0000000000000000000000A');
    expect(views[0]!.props.objectFit).toBe('cover');
    // Never the local track: the window is the other person, not a mirror.
    expect(views[0]!.props.mirror).toBeFalsy();
    const flat = StyleSheet.flatten(wrapper()!.props.style);
    expect(flat.width).toBe(OVERLAY_VIDEO_BOX.width);
    expect(flat.height).toBe(OVERLAY_VIDEO_BOX.height);
    expect(flat.overflow).toBe('hidden');
  });

  it('shows their face while their video is not flowing, and gets out of the way when it is', () => {
    const photoUri = `data:image/jpeg;base64,${PHOTO}`;
    const photos = (tree: ReactTestRenderer.ReactTestRenderer) =>
      tree.root.findAll(n => typeof n.type === 'string' && n.props?.source?.uri === photoUri);
    // Camera off at the far end: the same PeerBackdrop the full screen uses.
    const off = render({
      state: state({ video: true, peerVideo: false }),
      peerAvatarB64: PHOTO,
    });
    expect(photos(off.tree)).toHaveLength(1);
    expect(photos(off.tree)[0]!.props.resizeMode).toBe('cover');
    // Live: nothing covers the video.
    const live = render({
      state: state({ video: true, peerVideo: true }),
      peerAvatarB64: PHOTO,
    });
    expect(photos(live.tree)).toHaveLength(0);
    // Reconnecting: their video is not flowing, so the face is back.
    const re = render({
      state: state({ name: 'reconnecting', video: true, peerVideo: true }),
      peerAvatarB64: PHOTO,
    });
    expect(photos(re.tree)).toHaveLength(1);
  });

  it('does NOT paint their photo over the window before the call connects', () => {
    // The full screen's rule, on the small window: a cover-cropped face
    // where the remote camera goes is what
    // a live remote camera looks like, and before the call connects there is
    // no remote track for it to stand in for. The pine ground and the
    // letters stay, so the window is never bare black either.
    const photoUri = `data:image/jpeg;base64,${PHOTO}`;
    const photos = (tree: ReactTestRenderer.ReactTestRenderer) =>
      tree.root.findAll(n => typeof n.type === 'string' && n.props?.source?.uri === photoUri);
    const ringing = render({
      state: state({
        name: 'outgoing_ringing',
        video: true,
        peerVideo: true,
        connectedAt: null,
      }),
      peerAvatarB64: PHOTO,
    });
    expect(photos(ringing.tree)).toHaveLength(0);
    expect(ringing.texts()).toContain('DA');
    expect(ringing.texts()).toContain('Ringing…');
    // Once connected, the photo is the honest stand-in again.
    const connected = render({
      state: state({ name: 'connected', video: true, peerVideo: false }),
      peerAvatarB64: PHOTO,
    });
    expect(photos(connected.tree)).toHaveLength(1);
  });

  it('keeps their photo through the teardown of a call that CONNECTED', () => {
    // `ending` is post-connect for any call that reached it. Naming only
    // `connected` and `reconnecting` dropped the peer's photo for monogram
    // letters for the whole of the hangup, in the one window whose entire job
    // is to keep showing who is on the call.
    const photoUri = `data:image/jpeg;base64,${PHOTO}`;
    const photos = (tree: ReactTestRenderer.ReactTestRenderer) =>
      tree.root.findAll(n => typeof n.type === 'string' && n.props?.source?.uri === photoUri);
    const ending = render({
      state: state({
        name: 'ending',
        video: true,
        peerVideo: false,
        connectedAt: T - 65_000,
      }),
      peerAvatarB64: PHOTO,
    });
    expect(photos(ending.tree)).toHaveLength(1);
    // And a call cancelled before it connected still ends on the letters:
    // there was never remote media for the photo to stand in for.
    const cancelled = render({
      state: state({
        name: 'ending',
        video: true,
        peerVideo: true,
        connectedAt: null,
      }),
      peerAvatarB64: PHOTO,
    });
    expect(photos(cancelled.tree)).toHaveLength(0);
    expect(cancelled.texts()).toContain('DA');
  });

  it('letters a photo-less peer from their name at the corner size, never the id', () => {
    const { tree, texts } = render({ state: state({ video: true }), peerName: 'P1' });
    expect(texts()).toContain('?');
    expect(texts()).not.toContain('P1');
    const named = render({ state: state({ video: true }), peerName: 'Dana' });
    const letters = named.tree.root.findAll(
      n => String(n.type) === 'Text' && [n.props.children].flat().join('') === 'DA',
    )[0]!;
    expect(StyleSheet.flatten(letters.props.style).fontSize).toBe(32);
    expect(tree).toBeTruthy();
  });

  it('is a video window the moment EITHER side has video', () => {
    // The peer's camera on with mine off is still their video to show.
    expect(render({ state: state({ video: false, peerVideo: true }) }).videoViews()).toHaveLength(1);
    expect(render({ state: state({ video: true, peerVideo: false }) }).videoViews()).toHaveLength(1);
  });
});

describe('tap restores, drag moves, VoiceOver can do both', () => {
  it('a tap on the window brings the full call back', () => {
    const { byTestID, props } = render({ state: state({ video: true, peerVideo: true }) });
    const surface = byTestID('call-overlay');
    expect(surface.props.accessibilityRole).toBe('button');
    expect(surface.props.accessibilityLabel).toBe('Dana, 1 minute');
    expect(surface.props.accessibilityHint).toBe('Returns to the call');
    ReactTestRenderer.act(() => surface.props.onPress());
    expect(props.onRestore).toHaveBeenCalledTimes(1);
  });

  it('wires the shared pan onto the wrapper, tap contract intact, for BOTH shapes', () => {
    for (const s of [state(), state({ video: true, peerVideo: true })]) {
      const { wrapper, byTestID } = render({ state: s });
      const w = wrapper()!;
      expect(w).toBeTruthy();
      // The restore surface lives inside the draggable wrapper.
      expect(w.findAll(n => n.props?.testID === 'call-overlay').length).toBeGreaterThan(0);
      // Never claims on touch DOWN — a tap must reach the Pressable — and
      // does not surrender mid-drag. (Safe to drive directly: neither
      // handler reads touch history.)
      expect(w.props.onStartShouldSetResponder()).toBe(false);
      expect(w.props.onResponderTerminationRequest()).toBe(false);
      expect(typeof byTestID('call-overlay').props.onPress).toBe('function');
    }
  });

  it('parks top-right by default: 16 in from the edge, under the thread header', () => {
    const { wrapper } = render({ state: state({ video: true, peerVideo: true }) });
    const flat = StyleSheet.flatten(wrapper()!.props.style);
    expect(flat.position).toBe('absolute');
    expect(flat.left).toBe(390 - PIP_MARGIN - PIP_WIDTH);
    expect(flat.top).toBe(47 + OVERLAY_TOP_CLEARANCE);
    // The drag rides an animated translation, not a re-render per move.
    expect(flat.transform).toHaveLength(2);
    // And the pill parks against the same right edge with its own width.
    const pill = StyleSheet.flatten(render().wrapper()!.props.style);
    expect(pill.left).toBe(390 - PIP_MARGIN - OVERLAY_AUDIO_BOX.width);
    expect(pill.top).toBe(47 + OVERLAY_TOP_CLEARANCE);
  });

  it('offers the four corner actions and settles through them', async () => {
    // Reduce Motion on, so the settle is a jump the tree shows at once
    // rather than a timing the test would have to wait out.
    const original = AccessibilityInfo.isReduceMotionEnabled;
    AccessibilityInfo.isReduceMotionEnabled = jest.fn(async () => true);
    try {
      const { byTestID, wrapper } = render();
      await ReactTestRenderer.act(async () => {});
      const surface = byTestID('call-overlay');
      expect(surface.props.accessibilityActions).toBe(PIP_ACCESSIBILITY_ACTIONS);
      const FRAME = { width: 390, height: 844 };
      const INSETS = { top: 47, bottom: 34, left: 0, right: 0 };
      const home = pipAnchor('top-right', FRAME, INSETS, OVERLAY_AUDIO_BOX);
      const translate = () => {
        const t = StyleSheet.flatten(wrapper()!.props.style).transform as Array<
          Record<string, number>
        >;
        return { x: t[0]!.translateX, y: t[1]!.translateY };
      };
      expect(translate()).toEqual({ x: 0, y: 0 });

      ReactTestRenderer.act(() => {
        surface.props.onAccessibilityAction({ nativeEvent: { actionName: 'move-bottom-left' } });
      });
      // Parked bottom-left: the base stays home, the translation carries it.
      const bl = pipAnchor('bottom-left', FRAME, INSETS, OVERLAY_AUDIO_BOX);
      const flat = StyleSheet.flatten(wrapper()!.props.style);
      expect(flat.left).toBe(home.x);
      expect(flat.top).toBe(home.y);
      expect(translate().x).toBeCloseTo(bl.x - home.x);
      expect(translate().y).toBeCloseTo(bl.y - home.y);

      // A system action it does not own is ignored, not a teleport.
      ReactTestRenderer.act(() => {
        surface.props.onAccessibilityAction({ nativeEvent: { actionName: 'magicTap' } });
      });
      expect(translate().x).toBeCloseTo(bl.x - home.x);
      expect(translate().y).toBeCloseTo(bl.y - home.y);
    } finally {
      AccessibilityInfo.isReduceMotionEnabled = original;
    }
  });

  it('is NOT a modal: the app underneath must stay usable with VoiceOver', () => {
    const { tree } = render();
    expect(tree.root.findAll(n => n.props.accessibilityViewIsModal === true)).toHaveLength(0);
  });
});

describe('the keyboard', () => {
  it('overlayBox grows the bottom band by the keyboard, and only then', () => {
    expect(overlayBox('video', 0)).toBe(OVERLAY_VIDEO_BOX);
    expect(overlayBox('audio', 0)).toBe(OVERLAY_AUDIO_BOX);
    expect(overlayBox('audio', -5)).toBe(OVERLAY_AUDIO_BOX);
    expect(overlayBox('audio', 302)).toEqual({
      ...OVERLAY_AUDIO_BOX,
      bottomClearance: OVERLAY_BOTTOM_CLEARANCE + 302,
    });
    expect(overlayBox('video', 302).bottomClearance).toBe(OVERLAY_BOTTOM_CLEARANCE + 302);
    expect(overlayBox('video', 302).width).toBe(PIP_WIDTH);
  });

  it('a docked keyboard lifts the bottom band the pill must clear — End is never under the keys', () => {
    // The thread composer's keyboard covers the strip a bottom-parked pill
    // (End control included) would sit in; the drag's box carries the
    // inset, so the hook re-derives the parked corner above the keys.
    const addListener = jest.spyOn(Keyboard, 'addListener');
    try {
      render();
      const boxes = (usePipDrag as jest.Mock).mock.calls as Array<[{ box: PipBox }]>;
      expect(boxes[boxes.length - 1]![0].box.bottomClearance).toBe(OVERLAY_BOTTOM_CLEARANCE);

      const { width, height } = Dimensions.get('window');
      const cover = 336;
      const frame = { screenX: 0, screenY: height - cover, width, height: cover };
      ReactTestRenderer.act(() => {
        for (const [name, handler] of addListener.mock.calls) {
          if (name === 'keyboardWillChangeFrame') {
            (handler as (e: unknown) => void)({ endCoordinates: frame });
          }
        }
      });
      // The app's one keyboard truth, minus the home-indicator strip the
      // safe area already reserves (insets.bottom = 34 here).
      const inset = keyboardPaneInset(frame, { width, height }, 34);
      expect(inset).toBe(cover - 34);
      expect(boxes[boxes.length - 1]![0].box.bottomClearance).toBe(
        OVERLAY_BOTTOM_CLEARANCE + inset,
      );
      // And the top band did not move: a window parked top-right stays put.
      expect(boxes[boxes.length - 1]![0].box.topClearance).toBe(OVERLAY_TOP_CLEARANCE);

      ReactTestRenderer.act(() => {
        for (const [name, handler] of addListener.mock.calls) {
          if (name === 'keyboardWillHide') (handler as () => void)();
        }
      });
      expect(boxes[boxes.length - 1]![0].box.bottomClearance).toBe(OVERLAY_BOTTOM_CLEARANCE);
    } finally {
      addListener.mockRestore();
    }
  });
});

describe('lifecycle', () => {
  it('renders nothing at all when idle', () => {
    const { tree } = render({ state: { name: 'idle', call: null } });
    expect(tree.root.findAll(n => n.props.testID === 'call-overlay')).toHaveLength(0);
  });
});
