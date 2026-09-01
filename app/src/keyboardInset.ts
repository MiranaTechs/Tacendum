import { useEffect, useState } from 'react';
import { Keyboard, Platform, useWindowDimensions } from 'react-native';
import type { KeyboardEvent } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { usePaneWidth } from './windowClass';

/**
 * THE keyboard mechanism — one truth for every screen.
 *
 * `KeyboardAvoidingView` is not it, anywhere in this app: KAV works by
 * measuring its own frame through `onLayout` and comparing it to the
 * keyboard's position in window coordinates, and every routed screen renders
 * inside `RouteTransition` — an `Animated.View` carrying a `translateX`. A
 * transformed ancestor makes that measurement unreliable, so the padding KAV
 * computed was wrong in the thread (found live) and silently wrong in the
 * screens that still carried one. The thread's replacement was the
 * hand-rolled `height - screenY` inset; this module generalizes that one mechanism to
 * KEYBOARD-FRAME ∩ PANE and every screen consumes it from here.
 *
 * Why the intersection and not the subtraction: `height - screenY` reads the
 * strip below the keyboard's TOP edge as covered. For the docked keyboard a
 * phone ever shows, that is exact. For an iPad's floating palette or an
 * undocked/split keyboard, the frame HOVERS — there is glass below it — and
 * the subtraction measures the gap under the palette as though it were a
 * keyboard inset (the probe row's construction-level fact).
 * The intersection math answers instead: a keyboard only insets a pane when
 * it actually sits on the pane's bottom edge and spans it — otherwise it is
 * floating over content the way iPadOS intends, and the pane holds still,
 * which is exactly what the platform's own apps do under a floating palette.
 * The hardware floating/split geometry pass rides the iPad hardware test rows.
 */

/**
 * The keyboard's end frame, as RN's `keyboardWillChangeFrame` reports it.
 * Every field but `screenY` is optional with a DOCKED default: a real iOS
 * event always carries the full frame, and a partial frame (older harnesses,
 * defensive paths) must resolve to the phone-shaped answer the thread has
 * always computed — compact is sacred.
 */
export interface KeyboardFrame {
  screenY: number;
  screenX?: number;
  width?: number;
  height?: number;
}

/** The pane the inset serves. Panes span the window's full height under
 * this shell (App.tsx's projection), so `height` is the window's. */
export interface PaneRect {
  width: number;
  height: number;
}

/** How far above the pane's bottom edge a frame may stop and still count as
 * docked. Sub-point layout rounding, not a design allowance: a floating
 * palette's gap below is tens of points by construction. */
const DOCK_TOLERANCE = 2;

/** How much of the pane's width the (clipped) frame must cover to count as
 * docked. A docked keyboard spans its window edge to edge; a floating
 * palette is ~320pt over panes that start at 320 and grow. */
const DOCK_COVERAGE = 0.6;

/**
 * Keyboard-frame ∩ pane, as a bottom inset in dp. Pure — the tests pin
 * it as a table. Zero unless the keyboard is DOCKED against this pane:
 * reaching the pane's bottom edge (within DOCK_TOLERANCE) and spanning it
 * (DOCK_COVERAGE of the pane's width after clipping). When docked, the
 * inset is the covered strip's height, minus `bottomInset` because the
 * app's `SafeAreaView` has already reserved that strip — padding by the
 * full keyboard height would lift a composer a home-indicator's worth too
 * far.
 */
export function keyboardPaneInset(
  frame: KeyboardFrame | null | undefined,
  pane: PaneRect,
  bottomInset: number,
): number {
  if (!frame || typeof frame.screenY !== 'number') return 0;
  const paneBottom = pane.height;
  // Docked defaults for missing fields: left edge at 0, full pane width,
  // extending to the pane's bottom — the shape every docked keyboard has,
  // and the arithmetic the thread shipped for partial frames.
  const frameLeft = frame.screenX ?? 0;
  const frameWidth = frame.width ?? Math.max(0, pane.width - frameLeft);
  const frameBottom =
    frame.height === undefined ? paneBottom : frame.screenY + frame.height;
  // The intersection, clipped to the pane.
  const overlapWidth =
    Math.min(frameLeft + frameWidth, pane.width) - Math.max(frameLeft, 0);
  const coveredTop = Math.max(frame.screenY, 0);
  if (overlapWidth <= 0 || coveredTop >= paneBottom) return 0;
  // Floating/undocked (a palette, a split keyboard riding high): glass below
  // the frame means it hovers OVER content rather than insetting it.
  if (frameBottom < paneBottom - DOCK_TOLERANCE) return 0;
  if (overlapWidth < pane.width * DOCK_COVERAGE) return 0;
  return Math.max(0, paneBottom - coveredTop - bottomInset);
}

/**
 * How much of this pane the keyboard is covering, live. The drop-in for
 * both the thread's hand-rolled listener pair and the KAVs it replaces:
 * apply it as `paddingBottom` on the screen's root.
 *
 * ANDROID: always 0. The manifest ships
 * `windowSoftInputMode="adjustResize"`, so the window itself shrinks to
 * clear the keyboard — padding on top of that is double compensation. The
 * large-screen/edge-to-edge revisit of that gate is future work, on its own
 * evidence.
 */
export function useKeyboardInset(): number {
  const paneWidth = usePaneWidth();
  const { height: windowHeight } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [inset, setInset] = useState(0);
  useEffect(() => {
    if (Platform.OS !== 'ios') return;
    // `WillChangeFrame` so the lift runs with the keyboard's own animation
    // rather than snapping after it; `WillHide` because a hide is also a
    // frame change to "nothing covered".
    const subs = [
      Keyboard.addListener('keyboardWillChangeFrame', (event: KeyboardEvent) =>
        setInset(
          keyboardPaneInset(
            event?.endCoordinates,
            { width: paneWidth, height: windowHeight },
            insets.bottom,
          ),
        ),
      ),
      Keyboard.addListener('keyboardWillHide', () => setInset(0)),
    ];
    return () => subs.forEach(sub => sub.remove());
  }, [paneWidth, windowHeight, insets.bottom]);
  return inset;
}
