import React from 'react';
import Svg, { Path } from 'react-native-svg';

/**
 * The reply arrow: a chevron turning back toward what is being answered,
 * with the tail sweeping out of the turn — the shape every messenger has
 * taught for this verb, drawn to `CallGlyph`'s rules: outlined line art in
 * a 24×24 box, `stroke` and never `fill`, so it takes its colour from the
 * caller exactly as a `Text` does.
 *
 * Hidden from VoiceOver — the button around it carries a label naming the
 * message it replies to, and announcing the shape would read the control
 * twice.
 */

interface Props {
  /** Rendered size in points. The art is authored in a 24×24 box. */
  size?: number;
  color: string;
}

const STROKE = 1.9;

export function ReplyGlyph({ size = 22, color }: Props): React.JSX.Element {
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {/* The head: pointing back at the message being answered. */}
      <Path
        d="M10.1 5.4 3.4 11l6.7 5.6"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      {/* The tail: out of the turn and away. */}
      <Path
        d="M3.4 11h9.35a7.85 7.85 0 0 1 7.85 7.85v.35"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </Svg>
  );
}
