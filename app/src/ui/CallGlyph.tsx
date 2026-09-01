import React from 'react';
import Svg, { Path } from 'react-native-svg';

/**
 * The two call icons: outlined line art, in the theme's ink.
 *
 * They started as typographic marks (`▣`, `☏`) and then as filled shapes built
 * from Views, the way `BrandMark` is. Neither worked. At 15pt a square inside a
 * square reads as "stop", and a filled slab reads as a blob — an icon that has
 * to be explained is not an icon.
 *
 * Outlined art is what the rest of the platform uses and what people actually
 * recognise, and it cannot be drawn with Views: a handset is a curve, and a
 * View can only be a rectangle with rounded corners. So this is the one place
 * the app takes a vector renderer.
 *
 * **Stroke, not fill.** `stroke={color}` with `fill="none"` means the glyph
 * takes its colour from the caller exactly like a `Text` does, so a disabled
 * button greys the icon and its label together with no second state to keep in
 * sync. `strokeWidth` is in the 24-unit viewBox, so it scales with `size`
 * rather than getting heavier as the icon grows.
 *
 * Hidden from VoiceOver: the button that contains one already carries the
 * label, and announcing the shape would make the control read twice.
 */

interface Props {
  /** Rendered size in points. The art is authored in a 24×24 box. */
  size?: number;
  color: string;
}

const STROKE = 1.9;

/** A camcorder: rounded body, lens horn on the right. */
export function VideoGlyph({ size = 20, color }: Props): React.JSX.Element {
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Path
        d="M3.75 7.5h9a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2Z"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinejoin="round"
        fill="none"
      />
      <Path
        d="M15.25 11.25 21 8.25v7.5l-5.75-3v-1.5Z"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinejoin="round"
        fill="none"
      />
    </Svg>
  );
}

/**
 * A handset.
 *
 * One continuous stroke — the ear piece, the curve of the body, and the mouth
 * piece — which is the shape every platform draws and the reason this needed a
 * path rather than three rectangles.
 */
export function PhoneGlyph({ size = 20, color }: Props): React.JSX.Element {
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Path
        d="M7.4 3.6c.6-.35 1.36-.17 1.74.41l1.72 2.6c.36.55.23 1.29-.3 1.68l-1.2.9a.9.9 0 0 0-.28 1.1 11.2 11.2 0 0 0 4.63 4.63.9.9 0 0 0 1.1-.28l.9-1.2c.39-.53 1.13-.66 1.68-.3l2.6 1.72c.58.38.76 1.14.41 1.74l-1 1.73a2.6 2.6 0 0 1-2.9 1.22C11.6 19.9 4.1 12.4 2.45 5.5a2.6 2.6 0 0 1 1.22-2.9l1.73-1Z"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinejoin="round"
        fill="none"
      />
    </Svg>
  );
}
