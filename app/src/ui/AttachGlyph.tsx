import React from 'react';
import Svg, { Circle, Path } from 'react-native-svg';

/**
 * The four attach icons, drawn to the same rules as `CallGlyph`: outlined
 * line art in a 24×24 box, `stroke` and never `fill`, so each takes its
 * colour from the caller exactly as a `Text` does and a disabled control
 * greys icon and label together.
 *
 * Hidden from VoiceOver — the button around each one already carries the
 * label, and announcing the shape would make the control read twice.
 */

interface Props {
  /** Rendered size in points. The art is authored in a 24×24 box. */
  size?: number;
  color: string;
}

const STROKE = 1.9;

function Frame({
  size,
  children,
}: {
  size: number;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {children}
    </Svg>
  );
}

/** A picture: frame, horizon, sun. The library. */
export function PhotoGlyph({ size = 22, color }: Props): React.JSX.Element {
  return (
    <Frame size={size}>
      <Path
        d="M4 4.75h16a1.25 1.25 0 0 1 1.25 1.25v12a1.25 1.25 0 0 1-1.25 1.25H4A1.25 1.25 0 0 1 2.75 18V6A1.25 1.25 0 0 1 4 4.75Z"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinejoin="round"
        fill="none"
      />
      <Path
        d="m2.75 15.5 4.6-4.1a1.5 1.5 0 0 1 2 0l4.4 3.9m-2.1-1.85 2.4-2.1a1.5 1.5 0 0 1 2 0l3.2 2.8"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      <Circle cx="8.6" cy="8.9" r="1.4" stroke={color} strokeWidth={STROKE} fill="none" />
    </Frame>
  );
}

/** A camera: body, hump over the lens, lens. */
export function CameraGlyph({ size = 22, color }: Props): React.JSX.Element {
  return (
    <Frame size={size}>
      <Path
        d="M3.75 7.25h3.1l1.3-2.1a1 1 0 0 1 .85-.48h5.9a1 1 0 0 1 .85.48l1.3 2.1h3.2A1.25 1.25 0 0 1 21.5 8.5v9.25a1.25 1.25 0 0 1-1.25 1.25H3.75A1.25 1.25 0 0 1 2.5 17.75V8.5a1.25 1.25 0 0 1 1.25-1.25Z"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinejoin="round"
        fill="none"
      />
      <Circle cx="12" cy="13.1" r="3.35" stroke={color} strokeWidth={STROKE} fill="none" />
    </Frame>
  );
}

/** A sheet of paper with a folded corner, and two lines of writing. */
export function DocumentGlyph({ size = 22, color }: Props): React.JSX.Element {
  return (
    <Frame size={size}>
      <Path
        d="M6.25 2.75h7.1L19.25 8.6v12.4a1.25 1.25 0 0 1-1.25 1.25H6.25A1.25 1.25 0 0 1 5 21V4a1.25 1.25 0 0 1 1.25-1.25Z"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinejoin="round"
        fill="none"
      />
      <Path
        d="M13.25 2.9V8.5h5.6"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      <Path
        d="M8.4 13.1h7.2m-7.2 3.5h7.2"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinecap="round"
        fill="none"
      />
    </Frame>
  );
}

/** A map pin. */
export function LocationGlyph({ size = 22, color }: Props): React.JSX.Element {
  return (
    <Frame size={size}>
      <Path
        d="M12 21.5s7-6.05 7-11.05a7 7 0 1 0-14 0c0 5 7 11.05 7 11.05Z"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinejoin="round"
        fill="none"
      />
      <Circle cx="12" cy="10.1" r="2.6" stroke={color} strokeWidth={STROKE} fill="none" />
    </Frame>
  );
}

/** A microphone: capsule, cradle, stem. */
export function MicGlyph({ size = 22, color }: Props): React.JSX.Element {
  return (
    <Frame size={size}>
      <Path
        d="M12 2.75a3.1 3.1 0 0 1 3.1 3.1v6a3.1 3.1 0 0 1-6.2 0v-6A3.1 3.1 0 0 1 12 2.75Z"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinejoin="round"
        fill="none"
      />
      <Path
        d="M5.75 10.9v1.1a6.25 6.25 0 0 0 12.5 0v-1.1M12 18.25v3"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinecap="round"
        fill="none"
      />
    </Frame>
  );
}

/** A right-pointing triangle. */
export function PlayGlyph({ size = 22, color }: Props): React.JSX.Element {
  return (
    <Frame size={size}>
      <Path
        d="M8.25 5.4 18 12l-9.75 6.6V5.4Z"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinejoin="round"
        fill="none"
      />
    </Frame>
  );
}

/** Two bars. */
export function PauseGlyph({ size = 22, color }: Props): React.JSX.Element {
  return (
    <Frame size={size}>
      <Path
        d="M9 5.25v13.5M15 5.25v13.5"
        stroke={color}
        strokeWidth={STROKE + 0.5}
        strokeLinecap="round"
        fill="none"
      />
    </Frame>
  );
}

/** A cross, for abandoning a recording. */
export function CloseGlyph({ size = 22, color }: Props): React.JSX.Element {
  return (
    <Frame size={size}>
      <Path
        d="M6.25 6.25l11.5 11.5M17.75 6.25 6.25 17.75"
        stroke={color}
        strokeWidth={STROKE}
        strokeLinecap="round"
        fill="none"
      />
    </Frame>
  );
}
