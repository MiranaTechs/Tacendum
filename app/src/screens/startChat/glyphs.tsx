import React from 'react';
import Svg, { Circle, Path, Rect } from 'react-native-svg';

/**
 * Open a room's line icons, drawn to the AttachGlyph rules: 24×24 line art,
 * stroke and never fill, so each takes its colour from the caller exactly as
 * a Text does (a disabled control greys icon and label together), and hidden
 * from screen readers, because the control or label beside each one already
 * says what it means.
 */

interface Props {
  /** Rendered size in points. The art is authored in a 24×24 box. */
  size?: number;
  color: string;
}

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

/** The four corners of a viewfinder around a QR code's squares. */
export function ScanGlyph({ size = 22, color }: Props): React.JSX.Element {
  const line = {
    stroke: color,
    strokeWidth: 1.9,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    fill: 'none',
  };
  return (
    <Frame size={size}>
      <Path d="M4 9V6.5A2.5 2.5 0 0 1 6.5 4H9" {...line} />
      <Path d="M15 4h2.5A2.5 2.5 0 0 1 20 6.5V9" {...line} />
      <Path d="M20 15v2.5a2.5 2.5 0 0 1-2.5 2.5H15" {...line} />
      <Path d="M9 20H6.5A2.5 2.5 0 0 1 4 17.5V15" {...line} />
      <Rect x="8" y="8" width="3" height="3" rx="0.6" {...line} />
      <Rect x="13" y="8" width="3" height="3" rx="0.6" {...line} />
      <Rect x="8" y="13" width="3" height="3" rx="0.6" {...line} />
      <Path d="M13.5 13.5h2.5v2.5" {...line} />
    </Frame>
  );
}

/** A card with a face and two lines: a Tacendum ID. */
export function IdGlyph({ size = 16, color }: Props): React.JSX.Element {
  const line = {
    stroke: color,
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    fill: 'none',
  };
  return (
    <Frame size={size}>
      <Rect x="3" y="5.5" width="18" height="13" rx="2.2" {...line} />
      <Circle cx="8.6" cy="11" r="1.9" {...line} />
      <Path d="M5.8 15.6c.6-1.3 1.6-2 2.8-2s2.2.7 2.8 2" {...line} />
      <Path d="M14 10h4.2M14 13.4h3" {...line} />
    </Frame>
  );
}

/** A head and shoulders: a person found by name, or you. */
export function PersonGlyph({ size = 16, color }: Props): React.JSX.Element {
  const line = {
    stroke: color,
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    fill: 'none',
  };
  return (
    <Frame size={size}>
      <Circle cx="12" cy="8.3" r="3.6" {...line} />
      <Path d="M5 19.6a7 7 0 0 1 14 0" {...line} />
    </Frame>
  );
}

/** An envelope: an email address. */
export function MailGlyph({ size = 16, color }: Props): React.JSX.Element {
  const line = {
    stroke: color,
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    fill: 'none',
  };
  return (
    <Frame size={size}>
      <Rect x="3" y="5.5" width="18" height="13" rx="2.2" {...line} />
      <Path d="M4 7.2l8 6 8-6" {...line} />
    </Frame>
  );
}

/** A tick: all 26 characters are in. */
export function CheckGlyph({ size = 14, color }: Props): React.JSX.Element {
  return (
    <Frame size={size}>
      <Path
        d="M5 12.5l4.2 4.2L19 7"
        stroke={color}
        strokeWidth={2.4}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </Frame>
  );
}

/** A cross in a circle: empty the field. */
export function ClearGlyph({ size = 20, color }: Props): React.JSX.Element {
  const line = {
    stroke: color,
    strokeWidth: 1.7,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    fill: 'none',
  };
  return (
    <Frame size={size}>
      <Circle cx="12" cy="12" r="8.6" {...line} />
      <Path d="M9.2 9.2l5.6 5.6M14.8 9.2l-5.6 5.6" {...line} />
    </Frame>
  );
}

/** A chevron: down while closed, up while open. */
export function ChevronGlyph({
  size = 22,
  color,
  up = false,
}: Props & { up?: boolean }): React.JSX.Element {
  return (
    <Frame size={size}>
      <Path
        d={up ? 'M6 15l6-6 6 6' : 'M6 9l6 6 6-6'}
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </Frame>
  );
}

/** Two overlapping sheets: copy. */
export function CopyGlyph({ size = 20, color }: Props): React.JSX.Element {
  const line = {
    stroke: color,
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    fill: 'none',
  };
  return (
    <Frame size={size}>
      <Rect x="8.5" y="8.5" width="11.5" height="11.5" rx="2" {...line} />
      <Path d="M15.5 8.5V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7.5a2 2 0 0 0 2 2h2.5" {...line} />
    </Frame>
  );
}

/** An arrow out of a tray: share. */
export function ShareGlyph({ size = 20, color }: Props): React.JSX.Element {
  const line = {
    stroke: color,
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    fill: 'none',
  };
  return (
    <Frame size={size}>
      <Path d="M12 3.5v11" {...line} />
      <Path d="M8 7.5l4-4 4 4" {...line} />
      <Path
        d="M6 11.5H5.5A1.5 1.5 0 0 0 4 13v6a1.5 1.5 0 0 0 1.5 1.5h13A1.5 1.5 0 0 0 20 19v-6a1.5 1.5 0 0 0-1.5-1.5H18"
        {...line}
      />
    </Frame>
  );
}
