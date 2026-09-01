import React from 'react';
import { View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { PhoneGlyph } from './CallGlyph';

/**
 * The in-call control icons, drawn to `CallGlyph`'s rules: outlined line art
 * in a 24×24 box, `stroke` and never `fill`, so each takes its colour from
 * the caller exactly as a `Text` does and a disabled button greys icon and
 * label together.
 *
 * These replace the typographic stand-ins the control bar shipped with
 * (`M̸`, `♪`, `▣`, `⇄`, `＋`) — the same lesson `CallGlyph` already recorded:
 * a mark that has to be explained is not an icon, and a combining-slash
 * sequence renders differently in every font it meets.
 *
 * STATE IS SHAPE, NOT COLOUR. The muted microphone is a different drawing —
 * broken strokes with a slash through them — not the same drawing tinted, so
 * the mute state survives any palette and any kind of colour vision. The
 * button's fill still inverts on `active`; the icon swap is the signal that
 * does not depend on it.
 *
 * Hidden from VoiceOver, every one: the button around an icon carries the
 * label, and announcing the shape would read the control twice.
 */

interface Props {
  /** Rendered size in points. The art is authored in a 24×24 box. */
  size?: number;
  color: string;
}

const STROKE = 1.9;

const svgProps = (size: number) =>
  ({
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    accessibilityElementsHidden: true,
    importantForAccessibility: 'no-hide-descendants',
  }) as const;

const strokeProps = (color: string) =>
  ({
    stroke: color,
    strokeWidth: STROKE,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    fill: 'none',
  }) as const;

/** A microphone: capsule, cradle bowl, stem. */
export function MicGlyph({ size = 22, color }: Props): React.JSX.Element {
  return (
    <Svg {...svgProps(size)}>
      <Path
        d="M12 2.8a2.9 2.9 0 0 0-2.9 2.9v6.4a2.9 2.9 0 0 0 5.8 0V5.7A2.9 2.9 0 0 0 12 2.8Z"
        {...strokeProps(color)}
      />
      <Path d="M18.6 10.9v1.2a6.6 6.6 0 0 1-13.2 0v-1.2" {...strokeProps(color)} />
      <Path d="M12 18.7v2.7" {...strokeProps(color)} />
    </Svg>
  );
}

/**
 * The same microphone, muted: the capsule and bowl are drawn BROKEN, with a
 * gap along the slash, rather than a slash painted over an intact mic —
 * overlapping strokes at 22pt read as a scribble, and the gap is what makes
 * the slash legible as a slash.
 */
export function MicMutedGlyph({ size = 22, color }: Props): React.JSX.Element {
  return (
    <Svg {...svgProps(size)}>
      {/* Capsule, upper-right piece and lower-left piece. */}
      <Path d="M14.9 9.4V5.7a2.9 2.9 0 0 0-5.5-1.29" {...strokeProps(color)} />
      <Path d="M9.1 9.1v3a2.9 2.9 0 0 0 4.95 2.05" {...strokeProps(color)} />
      {/* Bowl, either side of the slash. */}
      <Path d="M18.6 10.9v1.2a6.6 6.6 0 0 1-.88 3.3" {...strokeProps(color)} />
      <Path d="M5.4 10.9v1.2a6.6 6.6 0 0 0 10.06 5.62" {...strokeProps(color)} />
      <Path d="M12 18.7v2.7" {...strokeProps(color)} />
      <Path d="M4.2 4.2 19.8 19.8" {...strokeProps(color)} />
    </Svg>
  );
}

/** Two arrows chasing a circle: rotate what the camera sees. Drawn as the
 * cycle alone — a camera with arrows inside it is mud at this size. */
export function FlipCameraGlyph({ size = 22, color }: Props): React.JSX.Element {
  return (
    <Svg {...svgProps(size)}>
      <Path d="M3.9 12a8.1 8.1 0 0 1 13.5-6.03L20.1 8.4" {...strokeProps(color)} />
      <Path d="M20.1 3.9v4.5h-4.5" {...strokeProps(color)} />
      <Path d="M20.1 12a8.1 8.1 0 0 1-13.5 6.03L3.9 15.6" {...strokeProps(color)} />
      <Path d="M3.9 20.1v-4.5h4.5" {...strokeProps(color)} />
    </Svg>
  );
}

/** A loudspeaker: cone at the left, two waves leaving it. */
export function SpeakerGlyph({ size = 22, color }: Props): React.JSX.Element {
  return (
    <Svg {...svgProps(size)}>
      <Path d="M4.8 9.6v4.8h3.4l4.6 3.9V5.7L8.2 9.6Z" {...strokeProps(color)} />
      <Path d="M15.8 9.3a4.3 4.3 0 0 1 0 5.4" {...strokeProps(color)} />
      <Path d="M18.3 7.2a7.6 7.6 0 0 1 0 9.6" {...strokeProps(color)} />
    </Svg>
  );
}

/** A person with a plus beside them: bring someone into the call. */
export function AddPersonGlyph({ size = 22, color }: Props): React.JSX.Element {
  return (
    <Svg {...svgProps(size)}>
      <Path d="M9 3.7a3.7 3.7 0 1 1 0 7.4 3.7 3.7 0 1 1 0-7.4Z" {...strokeProps(color)} />
      <Path d="M16 20.8v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" {...strokeProps(color)} />
      <Path d="M18.9 7.4v6" {...strokeProps(color)} />
      <Path d="M15.9 10.4h6" {...strokeProps(color)} />
    </Svg>
  );
}

/**
 * A chevron pointing down, with the line it settles onto: "put this call
 * away, keep it going". The minimize control on the call screen ("go back
 * to the chat from a video call while the video
 * call is on"). A chevron rather than an X — an X on a call screen reads as
 * hang up, and this does the opposite.
 */
export function MinimizeGlyph({ size = 22, color }: Props): React.JSX.Element {
  return (
    <Svg {...svgProps(size)}>
      <Path d="M6.2 8.4 12 14.2l5.8-5.8" {...strokeProps(color)} />
      <Path d="M6.2 19h11.6" {...strokeProps(color)} />
    </Svg>
  );
}

/**
 * The handset, put down: `PhoneGlyph` rotated 135°, which is the relationship
 * every platform's end-call icon has to its call icon. Reusing the component
 * rather than copying its path keeps one handset in the product — a hang-up
 * that drifted from the call icon would be teaching a second shape for the
 * same object.
 */
export function EndCallGlyph({ size = 22, color }: Props): React.JSX.Element {
  return (
    <View style={{ transform: [{ rotate: '135deg' }] }}>
      <PhoneGlyph size={size} color={color} />
    </View>
  );
}
