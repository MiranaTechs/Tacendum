import { useEffect, useRef, useState } from 'react';
import { Animated, PanResponder, type GestureResponderHandlers } from 'react-native';

/**
 * The draggable, corner-snapping picture-in-picture (lifted out of
 * CallScreen.tsx for the minimized-call window).
 *
 * "i need to move the video window around of mine when am in a video call" —
 * WhatsApp's gesture: the corner picture follows the finger, and a release
 * settles it on the nearest of the four corners. Core PanResponder + Animated
 * only, the house gesture idiom (PhotoViewerScreen: "no gesture library and
 * no new pod").
 *
 * TWO SURFACES, ONE GESTURE. The in-call self-view (CallScreen) and the
 * minimized call window that floats over the app (CallOverlay) are the same
 * drag: the same four anchors, the same clamp, the same nearest-corner snap,
 * the same tap-vs-drag threshold and the same VoiceOver corner actions. They
 * differ only in the BOX — its size, and the bands it must keep clear of at
 * the top and bottom of the window — so the box is a parameter with the
 * self-view's numbers as its default, and every three-argument call the
 * self-view has always made means exactly what it meant.
 *
 * The geometry is pure and exported because that is the testable half of a
 * gesture: jest cannot synthesise the touch histories PanResponder's
 * view-level handlers parse, but every question that decides where the pip
 * ends up — the anchors, the clamp, the nearest corner, tap-vs-drag — is a
 * function of plain numbers, pinned in the suite with no clock at all.
 */

/** The corner picture: 110pt wide, 16:9 tall. */
export const PIP_WIDTH = 110;
export const PIP_HEIGHT = PIP_WIDTH * (16 / 9);
/** The gap the pip has always kept from the screen edge. */
export const PIP_MARGIN = 16;
/** The band the pip may not enter at the top: exactly the `insets.top + 96`
 * the static pip sat at, so the default corner IS the position the call
 * screen has always used, not something near it. The header lives in that
 * band. */
export const PIP_TOP_CLEARANCE = 96;
/** And at the bottom: the control row is 16 padding + 44pt buttons + 20
 * padding = 80 above the home indicator. 96 gives the buttons the same 16pt
 * of air the sides get, so a dropped pip can never sit on the controls. */
export const PIP_BOTTOM_CLEARANCE = 96;
/** At or under this, the gesture is a tap and the Pressable keeps it, so
 * tap-to-swap still works; past it, the pan claims the responder. The same
 * 12pt PhotoViewer's dismiss drag uses to coexist with its taps. */
export const PIP_DRAG_THRESHOLD = 12;

export type PipCorner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
export interface PipFrame {
  width: number;
  height: number;
}
export interface PipInsets {
  top: number;
  bottom: number;
  left: number;
  right: number;
}
/**
 * The thing being dragged: its size, and the bands at the top and bottom of
 * the window it must stay clear of (a header, a control row, a composer).
 * Left and right keep `PIP_MARGIN` on every surface.
 */
export interface PipBox {
  width: number;
  height: number;
  topClearance: number;
  bottomClearance: number;
}

/** The self-view's box — the numbers the call screen has always used. */
export const DEFAULT_PIP_BOX: PipBox = {
  width: PIP_WIDTH,
  height: PIP_HEIGHT,
  topClearance: PIP_TOP_CLEARANCE,
  bottomClearance: PIP_BOTTOM_CLEARANCE,
};

/**
 * Where the pip's top-left point parks for a corner, inside the safe area and
 * clear of both bands. A DEGENERATE window — a Split View sliver with less
 * room on an axis than the pip and its clearances need — has no position
 * clear of both bands on that axis, so the shortfall is SPLIT: every corner
 * collapses to the axis midpoint between the band edges, intruding half into
 * each band. The old clamp (`Math.max`) parked bottom anchors at the TOP band
 * edge, which dropped the WHOLE shortfall on the control row — a pip sitting
 * on the hang-up button. Split, the 16pt of air each band carries is spent
 * first and symmetrically, and the controls stay usable in any window a call
 * can actually appear in.
 */
export function pipAnchor(
  corner: PipCorner,
  frame: PipFrame,
  insets: PipInsets,
  box: PipBox = DEFAULT_PIP_BOX,
): {
  x: number;
  y: number;
} {
  const left = insets.left + PIP_MARGIN;
  const right = frame.width - insets.right - PIP_MARGIN - box.width;
  const top = insets.top + box.topClearance;
  const bottom = frame.height - insets.bottom - box.bottomClearance - box.height;
  return {
    x:
      right >= left
        ? corner === 'top-left' || corner === 'bottom-left'
          ? left
          : right
        : (left + right) / 2,
    y:
      bottom >= top
        ? corner === 'top-left' || corner === 'top-right'
          ? top
          : bottom
        : (top + bottom) / 2,
  };
}

/** The drag, clamped to the band the anchors span: mid-gesture the pip can
 * already not be pushed under the notch, the header, the control row or the
 * home indicator — "inside the safe area" is true while the finger is down,
 * not only after the snap. */
export function clampPip(
  x: number,
  y: number,
  frame: PipFrame,
  insets: PipInsets,
  box: PipBox = DEFAULT_PIP_BOX,
): {
  x: number;
  y: number;
} {
  const tl = pipAnchor('top-left', frame, insets, box);
  const br = pipAnchor('bottom-right', frame, insets, box);
  return {
    x: Math.min(Math.max(x, tl.x), br.x),
    y: Math.min(Math.max(y, tl.y), br.y),
  };
}

/** Which corner a release at (x, y) settles on: whichever side of the band's
 * midpoint the pip was dropped — equivalent to comparing centres, since the
 * pip is constant-sized. */
export function nearestPipCorner(
  x: number,
  y: number,
  frame: PipFrame,
  insets: PipInsets,
  box: PipBox = DEFAULT_PIP_BOX,
): PipCorner {
  const tl = pipAnchor('top-left', frame, insets, box);
  const br = pipAnchor('bottom-right', frame, insets, box);
  const vert = y <= (tl.y + br.y) / 2 ? 'top' : 'bottom';
  const horiz = x <= (tl.x + br.x) / 2 ? 'left' : 'right';
  return `${vert}-${horiz}` as PipCorner;
}

/** Whether a move is a DRAG rather than a wobbly tap. Manhattan distance,
 * PhotoViewer's threshold shape. */
export function pipDragClaims(dx: number, dy: number): boolean {
  return Math.abs(dx) + Math.abs(dy) > PIP_DRAG_THRESHOLD;
}

/**
 * VoiceOver's path to the drag. A one-finger pan is exactly the gesture
 * VoiceOver consumes for navigation, so with the drag alone a screen-reader
 * user could never move the pip at all: four rotor actions, one per corner,
 * are the accessible equivalent — same destinations, same snap.
 */
export const PIP_ACCESSIBILITY_ACTIONS = [
  { name: 'move-top-left', label: 'Move to top left' },
  { name: 'move-top-right', label: 'Move to top right' },
  { name: 'move-bottom-left', label: 'Move to bottom left' },
  { name: 'move-bottom-right', label: 'Move to bottom right' },
];

/** The corner a rotor action names, null for an action that is not ours
 * (the system passes activate/magicTap and friends through the same prop). */
export function pipCornerForAction(name: string): PipCorner | null {
  switch (name) {
    case 'move-top-left':
      return 'top-left';
    case 'move-top-right':
      return 'top-right';
    case 'move-bottom-left':
      return 'bottom-left';
    case 'move-bottom-right':
      return 'bottom-right';
    default:
      return null;
  }
}

/** What a surface needs to render and drive the drag. */
export interface PipDrag {
  /** The HOME anchor (the initial corner) the shift is measured from: the
   * wrapper's `left`/`top`. The base never moves — only the translation
   * does — so a snap needs no re-anchor handoff to flicker on. */
  home: { x: number; y: number };
  /** The animated translation from home: `transform: shift.getTranslateTransform()`. */
  shift: Animated.ValueXY;
  /** Spread onto the draggable wrapper. */
  panHandlers: GestureResponderHandlers;
  /** Park at a corner — the settle a released drag shares with a VoiceOver
   * corner action. */
  snapTo(corner: PipCorner): void;
  /** The corner the pip is parked at (or settling towards). */
  corner: PipCorner;
}

/**
 * The wiring behind the drag, as it was written inline in CallScreen and
 * proven on hardware: ONE responder for the life of the surface, geometry
 * and motion preferences reaching its handlers through refs at TOUCH time.
 *
 * `frame` is the provider's frame (`useSafeAreaFrame`), not
 * `useWindowDimensions`: both surfaces are absolute-fill overlays inside the
 * root SafeAreaProvider, so the provider's frame IS the window — and it is
 * the same coordinate system the insets describe.
 *
 * The stored FACT is the corner; coordinates are re-derived from it, which
 * is what lets an iPad rotation, a Split View resize or a change of box
 * (an audio pill becoming a video window when the peer's camera comes on)
 * land the pip somewhere valid instead of somewhere remembered.
 */
export function usePipDrag(opts: {
  frame: PipFrame;
  insets: PipInsets;
  box?: PipBox;
  reduceMotion: boolean;
  motion: { surface: number; easing: (t: number) => number };
  initialCorner?: PipCorner;
}): PipDrag {
  const { frame, insets, reduceMotion, motion, initialCorner = 'top-right' } = opts;
  const box = opts.box ?? DEFAULT_PIP_BOX;
  const { width: frameW, height: frameH } = frame;
  const { top: insTop, bottom: insBottom, left: insLeft, right: insRight } = insets;
  const {
    width: boxW,
    height: boxH,
    topClearance: boxTop,
    bottomClearance: boxBottom,
  } = box;
  const [corner, setCorner] = useState<PipCorner>(initialCorner);
  /** Offset from the HOME anchor. The base never moves — only this
   * translation does — so a snap needs no re-anchor handoff to flicker on. */
  const shift = useRef(new Animated.ValueXY({ x: 0, y: 0 })).current;
  /** The offset the current drag started from (set by grant, below). */
  const grab = useRef({ x: 0, y: 0 });
  const cornerRef = useRef(corner);
  cornerRef.current = corner;
  const homeCornerRef = useRef(initialCorner);
  /** The live window and box, readable from inside the ONE PanResponder
   * below without rebuilding it: RN keeps the in-flight gesture on the
   * responder object that claimed it, so a responder rebuilt on rotation
   * mid-drag would leave the old handlers owning the touch while the tree
   * carries new ones — moves mixing pre-resize touch history with
   * post-resize geometry. Refreshed every render; the handlers read it at
   * touch time. */
  const geomRef = useRef({
    f: { width: frameW, height: frameH },
    ins: { top: insTop, bottom: insBottom, left: insLeft, right: insRight },
    box: { width: boxW, height: boxH, topClearance: boxTop, bottomClearance: boxBottom },
  });
  geomRef.current = {
    f: { width: frameW, height: frameH },
    ins: { top: insTop, bottom: insBottom, left: insLeft, right: insRight },
    box: { width: boxW, height: boxH, topClearance: boxTop, bottomClearance: boxBottom },
  };
  const reduceMotionRef = useRef(reduceMotion);
  reduceMotionRef.current = reduceMotion;
  const motionRef = useRef(motion);
  motionRef.current = motion;
  /** Whether a finger owns the pip right now (grant → release/terminate). */
  const dragging = useRef(false);
  /**
   * The home the CURRENT drag is measured against, frozen at grant and
   * released at settle — ref for the handlers, state so the render agrees.
   * The live home below follows the geometry every render, and the resize
   * effect that would rebase the shift to match is (rightly) skipped while
   * a finger holds the pip; without this freeze a box or frame change
   * mid-drag — the peer's camera coming on turning a 200pt pill into a
   * 110pt window, the keyboard lifting the bottom band — moved the base
   * under a shift still measured from the old one, and the pip jumped under
   * the finger by exactly the difference (review). Frozen, the
   * finger's position is the finger's position until release; the clamp
   * still reads the LIVE geometry, so the pip stays inside the window that
   * exists now, and the settle rebases everything onto the live home.
   */
  const [dragHome, setDragHome] = useState<{ x: number; y: number } | null>(null);
  const dragHomeRef = useRef<{ x: number; y: number } | null>(null);

  const liveHome = pipAnchor(
    initialCorner,
    { width: frameW, height: frameH },
    { top: insTop, bottom: insBottom, left: insLeft, right: insRight },
    { width: boxW, height: boxH, topClearance: boxTop, bottomClearance: boxBottom },
  );
  const home = dragHome ?? liveHome;

  /** Park the pip at a corner: the settle every path shares — a released
   * drag, a VoiceOver corner action. Reads refs only, so the one stable
   * responder below can call it without going stale. */
  const snapTo = (next: PipCorner) => {
    const { f, ins, box: b } = geomRef.current;
    const h = pipAnchor(homeCornerRef.current, f, ins, b);
    const a = pipAnchor(next, f, ins, b);
    const to = { x: a.x - h.x, y: a.y - h.y };
    setCorner(next);
    grab.current = to;
    shift.stopAnimation();
    if (reduceMotionRef.current) {
      // The gate PhotoViewer's settle honours: the position changes, the
      // motion does not.
      shift.setValue(to);
      return;
    }
    Animated.timing(shift, {
      toValue: to,
      duration: motionRef.current.surface,
      easing: motionRef.current.easing,
      // House precedent (PhotoViewer): JS-driven, one value the gesture,
      // the snap and the resize effect all read and write.
      useNativeDriver: false,
    }).start();
  };
  const snapToRef = useRef(snapTo);
  snapToRef.current = snapTo;

  // Rotation / Split View resize / a change of box: re-derive the stored
  // corner in the new window. A jump, not an animation — the whole screen
  // just re-laid out around it, and Reduce Motion would forbid animating it
  // anyway.
  // NOT while a finger holds the pip: resetting the shift mid-gesture threw
  // away the live drag position and teleported the pip to the settled
  // corner under the finger. The handlers read the new geometry on the next
  // move — every move re-clamps into the new window — and the release
  // settles on a corner of the window that actually exists.
  useEffect(() => {
    if (dragging.current) return;
    const f = { width: frameW, height: frameH };
    const ins = { top: insTop, bottom: insBottom, left: insLeft, right: insRight };
    const b = { width: boxW, height: boxH, topClearance: boxTop, bottomClearance: boxBottom };
    const h = pipAnchor(homeCornerRef.current, f, ins, b);
    const a = pipAnchor(cornerRef.current, f, ins, b);
    const to = { x: a.x - h.x, y: a.y - h.y };
    shift.stopAnimation();
    shift.setValue(to);
    grab.current = to;
  }, [
    frameW,
    frameH,
    insTop,
    insBottom,
    insLeft,
    insRight,
    boxW,
    boxH,
    boxTop,
    boxBottom,
    shift,
  ]);

  /** ONE responder for the life of the surface (lazy ref — RN's documented
   * shape for a responder that must survive re-renders): geometry, Reduce
   * Motion and the motion tokens reach the handlers through refs at TOUCH
   * time, so a rotation or Split View resize mid-gesture changes the
   * numbers without swapping the object that owns the in-flight touch. */
  const panRef = useRef<ReturnType<typeof PanResponder.create> | null>(null);
  if (panRef.current === null) {
    /** The home this drag is measured against: the frozen one while a
     * finger holds the pip, the live one otherwise. */
    const dragBase = () => {
      const { f, ins, box: b } = geomRef.current;
      return dragHomeRef.current ?? pipAnchor(homeCornerRef.current, f, ins, b);
    };
    /** Finger → position clamped into the LIVE window, expressed as a shift
     * from the drag's base. */
    const shiftFor = (dx: number, dy: number) => {
      const { f, ins, box: b } = geomRef.current;
      const h = dragBase();
      const p = clampPip(h.x + grab.current.x + dx, h.y + grab.current.y + dy, f, ins, b);
      return { x: p.x - h.x, y: p.y - h.y };
    };
    const settle = (dx: number, dy: number) => {
      const { f, ins, box: b } = geomRef.current;
      // Where the pip IS, against the base the drag was measured from…
      const h = dragBase();
      const at = shiftFor(dx, dy);
      // …then the drag is over: the base is live again, and the snap that
      // follows writes a shift measured from it.
      dragging.current = false;
      dragHomeRef.current = null;
      setDragHome(null);
      snapToRef.current(nearestPipCorner(h.x + at.x, h.y + at.y, f, ins, b));
    };
    panRef.current = PanResponder.create({
      // A tap stays the Pressable's: the pan claims the responder only once
      // the finger has MOVED past the threshold — how a tap (swap, restore,
      // end) and the drag coexist on one surface.
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: (_, g) => pipDragClaims(g.dx, g.dy),
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => {
        dragging.current = true;
        // Freeze the base for the life of this drag (see `dragHome`).
        const { f, ins, box: b } = geomRef.current;
        const h = pipAnchor(homeCornerRef.current, f, ins, b);
        dragHomeRef.current = h;
        setDragHome(h);
        // A grab can catch the pip mid-snap. stopAnimation reports where it
        // actually is — the drag starts there, not where it was parked.
        shift.stopAnimation(v => {
          grab.current = v;
        });
      },
      onPanResponderMove: (_, g) => {
        shift.setValue(shiftFor(g.dx, g.dy));
      },
      onPanResponderRelease: (_, g) => settle(g.dx, g.dy),
      // Terminated (something above took the touch): settle from wherever
      // the drag reached, same as a release.
      onPanResponderTerminate: (_, g) => settle(g.dx, g.dy),
    });
  }

  return {
    home,
    shift,
    panHandlers: panRef.current.panHandlers,
    snapTo,
    corner,
  };
}
