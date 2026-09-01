import React from 'react';
import { View } from 'react-native';
import ReactTestRenderer from 'react-test-renderer';
import {
  clampPip,
  DEFAULT_PIP_BOX,
  nearestPipCorner,
  PIP_ACCESSIBILITY_ACTIONS,
  PIP_BOTTOM_CLEARANCE,
  PIP_HEIGHT,
  PIP_MARGIN,
  PIP_TOP_CLEARANCE,
  PIP_WIDTH,
  pipAnchor,
  pipCornerForAction,
  pipDragClaims,
  usePipDrag,
  type PipBox,
  type PipDrag,
} from '../src/ui/pipDrag';
import * as fromCallScreen from '../src/screens/CallScreen';
import {
  OVERLAY_AUDIO_BOX,
  OVERLAY_BOTTOM_CLEARANCE,
  OVERLAY_TOP_CLEARANCE,
  OVERLAY_VIDEO_BOX,
} from '../src/screens/CallOverlay';

/**
 * The shared drag geometry (lifted out of CallScreen.tsx for
 * the minimized call window). Pure functions of plain numbers, no clock,
 * no renderer: CallScreen.test.tsx keeps pinning the self-view's numbers
 * through the screen's re-exports; this file pins what the lift ADDED — the
 * box parameter — and that the re-exports are the same functions, not
 * copies that could drift.
 */

const FRAME = { width: 390, height: 844 };
const INSETS = { top: 47, bottom: 34, left: 0, right: 0 };

describe('the lift changed nothing for the self-view', () => {
  it('re-exports the SAME functions and constants through CallScreen', () => {
    // Identity, not equality: two implementations that agree today are the
    // codebase's signature way of disagreeing tomorrow.
    expect(fromCallScreen.pipAnchor).toBe(pipAnchor);
    expect(fromCallScreen.clampPip).toBe(clampPip);
    expect(fromCallScreen.nearestPipCorner).toBe(nearestPipCorner);
    expect(fromCallScreen.pipDragClaims).toBe(pipDragClaims);
    expect(fromCallScreen.pipCornerForAction).toBe(pipCornerForAction);
    expect(fromCallScreen.PIP_ACCESSIBILITY_ACTIONS).toBe(PIP_ACCESSIBILITY_ACTIONS);
    expect(fromCallScreen.PIP_WIDTH).toBe(PIP_WIDTH);
    expect(fromCallScreen.PIP_HEIGHT).toBe(PIP_HEIGHT);
    expect(fromCallScreen.PIP_MARGIN).toBe(PIP_MARGIN);
    expect(fromCallScreen.PIP_TOP_CLEARANCE).toBe(PIP_TOP_CLEARANCE);
    expect(fromCallScreen.PIP_BOTTOM_CLEARANCE).toBe(PIP_BOTTOM_CLEARANCE);
  });

  it('the default box IS the self-view: three-argument calls mean what they meant', () => {
    expect(DEFAULT_PIP_BOX).toEqual({
      width: 110,
      height: 110 * (16 / 9),
      topClearance: 96,
      bottomClearance: 96,
    });
    // The numbers CallScreen.test.tsx has always pinned, reached with and
    // without the fourth argument.
    expect(pipAnchor('top-right', FRAME, INSETS)).toEqual({ x: 264, y: 143 });
    expect(pipAnchor('top-right', FRAME, INSETS, DEFAULT_PIP_BOX)).toEqual({ x: 264, y: 143 });
    expect(clampPip(-40, -200, FRAME, INSETS)).toEqual(clampPip(-40, -200, FRAME, INSETS, DEFAULT_PIP_BOX));
    expect(nearestPipCorner(260, 500, FRAME, INSETS)).toBe(
      nearestPipCorner(260, 500, FRAME, INSETS, DEFAULT_PIP_BOX),
    );
  });
});

describe('the box parameter (what the minimized window needs)', () => {
  const PILL: PipBox = { width: 200, height: 56, topClearance: 64, bottomClearance: 96 };

  it('anchors a different box in the same four corners, clear of its own bands', () => {
    const tr = pipAnchor('top-right', FRAME, INSETS, PILL);
    // Right edge 16 in, whatever the width.
    expect(tr.x + PILL.width).toBe(390 - PIP_MARGIN);
    // Below THIS surface's top band — the thread header — not the call
    // screen's 96.
    expect(tr.y).toBe(47 + 64);
    const bl = pipAnchor('bottom-left', FRAME, INSETS, PILL);
    expect(bl.x).toBe(16);
    expect(bl.y + PILL.height).toBe(844 - 34 - 96);
  });

  it('clamps and snaps against the box it was given', () => {
    const far = clampPip(9999, 9999, FRAME, INSETS, PILL);
    expect(far).toEqual(pipAnchor('bottom-right', FRAME, INSETS, PILL));
    const near = clampPip(-9999, -9999, FRAME, INSETS, PILL);
    expect(near).toEqual(pipAnchor('top-left', FRAME, INSETS, PILL));
    // The midpoint moves with the box: a wide pill's band is narrower than
    // the 110pt picture's, so the same drop can land on a different side.
    const midX = (pipAnchor('top-left', FRAME, INSETS, PILL).x + far.x) / 2;
    expect(nearestPipCorner(midX + 1, 200, FRAME, INSETS, PILL)).toBe('top-right');
    expect(nearestPipCorner(midX - 1, 200, FRAME, INSETS, PILL)).toBe('top-left');
  });

  it('splits a degenerate window symmetrically for any box', () => {
    // A window too short for the pill and its bands: both corners collapse
    // to the midpoint between the band edges, intruding half into each.
    const SLIVER = { width: 320, height: 200 };
    const top = 47 + PILL.topClearance;
    const bottom = 200 - 34 - PILL.bottomClearance - PILL.height;
    expect(bottom).toBeLessThan(top);
    const y = pipAnchor('bottom-left', SLIVER, INSETS, PILL).y;
    expect(y).toBeCloseTo((top + bottom) / 2);
    expect(pipAnchor('top-right', SLIVER, INSETS, PILL).y).toBeCloseTo(y);
  });

  it('the window’s two boxes: the self-view’s picture, and the pill, in the app’s bands', () => {
    // The video window is the SAME 110pt 16:9 picture the self-view is — one
    // family — with the clearances of the surface it floats over: the thread
    // header (56) plus air at the top, the composer band at the bottom.
    expect(OVERLAY_VIDEO_BOX.width).toBe(PIP_WIDTH);
    expect(OVERLAY_VIDEO_BOX.height).toBe(PIP_HEIGHT);
    expect(OVERLAY_TOP_CLEARANCE).toBeGreaterThanOrEqual(56 + 8);
    expect(OVERLAY_VIDEO_BOX.topClearance).toBe(OVERLAY_TOP_CLEARANCE);
    expect(OVERLAY_VIDEO_BOX.bottomClearance).toBe(OVERLAY_BOTTOM_CLEARANCE);
    // The pill: tall enough for a 44pt End target with air, and the same bands.
    expect(OVERLAY_AUDIO_BOX.height).toBeGreaterThanOrEqual(44 + 12);
    expect(OVERLAY_AUDIO_BOX.topClearance).toBe(OVERLAY_TOP_CLEARANCE);
    expect(OVERLAY_AUDIO_BOX.bottomClearance).toBe(OVERLAY_BOTTOM_CLEARANCE);
    // Parked top-right by default, 16 in from the edge and under the header.
    const home = pipAnchor('top-right', FRAME, INSETS, OVERLAY_VIDEO_BOX);
    expect(home.x).toBe(390 - PIP_MARGIN - PIP_WIDTH);
    expect(home.y).toBe(47 + OVERLAY_TOP_CLEARANCE);
  });
});

/**
 * The hook under a finger (review). PanResponder's view-level
 * handlers parse touch histories, so the gesture is driven with the shape
 * they parse: one active touch, its previous and current page point, a
 * timestamp later than the last one accounted for.
 */
describe('a box change mid-drag does not move the pip under the finger', () => {
  const PILL: PipBox = { width: 200, height: 56, topClearance: 64, bottomClearance: 96 };
  const VIDEO: PipBox = {
    width: PIP_WIDTH,
    height: PIP_HEIGHT,
    topClearance: 64,
    bottomClearance: 96,
  };

  function touch(prev: [number, number], cur: [number, number], t: number) {
    return {
      touchHistory: {
        numberActiveTouches: 1,
        indexOfSingleActiveTouch: 0,
        mostRecentTimeStamp: t,
        touchBank: [
          {
            touchActive: true,
            startPageX: prev[0],
            startPageY: prev[1],
            startTimeStamp: 1,
            currentPageX: cur[0],
            currentPageY: cur[1],
            currentTimeStamp: t,
            previousPageX: prev[0],
            previousPageY: prev[1],
            previousTimeStamp: t - 1,
          },
        ],
      },
    };
  }

  let latest: PipDrag | null = null;
  function Probe({ box }: { box: PipBox }) {
    const pip = usePipDrag({
      frame: FRAME,
      insets: INSETS,
      box,
      reduceMotion: true,
      motion: { surface: 0, easing: (t: number) => t },
    });
    latest = pip;
    return React.createElement(View, {
      testID: 'probe',
      style: { left: pip.home.x, top: pip.home.y },
      ...pip.panHandlers,
    });
  }

  /** Where the pip IS: the rendered base plus the animated shift. */
  function position(tree: ReactTestRenderer.ReactTestRenderer) {
    const host = tree.root.findAll(
      n => typeof n.type === 'string' && n.props.testID === 'probe',
    )[0]!;
    let shift = { x: 0, y: 0 };
    latest!.shift.stopAnimation((v: { x: number; y: number }) => {
      shift = v;
    });
    return {
      base: { x: host.props.style.left as number, y: host.props.style.top as number },
      at: { x: host.props.style.left + shift.x, y: host.props.style.top + shift.y },
    };
  }

  it('freezes the base at grant, clamps into the live window, and rebases on release', () => {
    let tree!: ReactTestRenderer.ReactTestRenderer;
    ReactTestRenderer.act(() => {
      tree = ReactTestRenderer.create(React.createElement(Probe, { box: PILL }));
    });
    const handlers = () =>
      tree.root.findAll(n => typeof n.type === 'string' && n.props.testID === 'probe')[0]!
        .props;
    const pillHome = pipAnchor('top-right', FRAME, INSETS, PILL);
    const videoHome = pipAnchor('top-right', FRAME, INSETS, VIDEO);
    expect(pillHome).not.toEqual(videoHome);
    expect(position(tree).base).toEqual(pillHome);

    // Finger down on the parked pill, then 50 left and 300 down.
    ReactTestRenderer.act(() => {
      handlers().onResponderGrant(touch([300, 200], [300, 200], 2));
    });
    ReactTestRenderer.act(() => {
      handlers().onResponderMove(touch([300, 200], [250, 500], 3));
    });
    const held = position(tree);
    expect(held.at).toEqual({ x: pillHome.x - 50, y: pillHome.y + 300 });

    // The peer's camera comes on: the pill is now the video window. The
    // pip does NOT jump: same base, same place under the finger.
    ReactTestRenderer.act(() => {
      tree.update(React.createElement(Probe, { box: VIDEO }));
    });
    expect(position(tree).base).toEqual(pillHome);
    expect(position(tree).at).toEqual(held.at);

    // The next move clamps into the window that exists NOW — the video
    // box's right edge, not the pill's.
    ReactTestRenderer.act(() => {
      handlers().onResponderMove(touch([250, 500], [9999, 500], 4));
    });
    const videoRight = pipAnchor('top-right', FRAME, INSETS, VIDEO).x;
    expect(position(tree).at.x).toBe(videoRight);

    // Release: the base is live again and the shift is measured from it —
    // the pip sits exactly on a corner of the video box.
    ReactTestRenderer.act(() => {
      handlers().onResponderRelease(touch([9999, 500], [9999, 500], 5));
    });
    const settled = position(tree);
    expect(settled.base).toEqual(videoHome);
    const corner = latest!.corner;
    const anchor = pipAnchor(corner, FRAME, INSETS, VIDEO);
    expect(settled.at.x).toBeCloseTo(anchor.x);
    expect(settled.at.y).toBeCloseTo(anchor.y);
    expect(corner).toBe('bottom-right');

    ReactTestRenderer.act(() => tree.unmount());
  });

  it('a drag with no box change is exactly what it was: base never moves, release snaps nearest', () => {
    let tree!: ReactTestRenderer.ReactTestRenderer;
    ReactTestRenderer.act(() => {
      tree = ReactTestRenderer.create(React.createElement(Probe, { box: PILL }));
    });
    const handlers = () =>
      tree.root.findAll(n => typeof n.type === 'string' && n.props.testID === 'probe')[0]!
        .props;
    const home = pipAnchor('top-right', FRAME, INSETS, PILL);
    ReactTestRenderer.act(() => {
      handlers().onResponderGrant(touch([300, 200], [300, 200], 2));
    });
    ReactTestRenderer.act(() => {
      handlers().onResponderMove(touch([300, 200], [100, 220], 3));
    });
    expect(position(tree).base).toEqual(home);
    ReactTestRenderer.act(() => {
      handlers().onResponderRelease(touch([100, 220], [100, 220], 4));
    });
    expect(position(tree).base).toEqual(home);
    expect(latest!.corner).toBe('top-left');
    const tl = pipAnchor('top-left', FRAME, INSETS, PILL);
    expect(position(tree).at).toEqual(tl);
    ReactTestRenderer.act(() => tree.unmount());
  });
});

describe('tap-vs-drag and the VoiceOver corners are one vocabulary', () => {
  it('12pt Manhattan: at or under it a tap, past it a drag', () => {
    expect(pipDragClaims(6, 6)).toBe(false);
    expect(pipDragClaims(7, 6)).toBe(true);
  });

  it('every rotor action names a corner the snap understands, and nothing else does', () => {
    for (const a of PIP_ACCESSIBILITY_ACTIONS) {
      expect(pipCornerForAction(a.name)).not.toBeNull();
      expect(a.label).toBeTruthy();
    }
    expect(pipCornerForAction('activate')).toBeNull();
    expect(pipCornerForAction('magicTap')).toBeNull();
  });
});
