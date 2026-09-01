import React from 'react';
import Svg, { Path } from 'react-native-svg';

/**
 * Delivery status on an outgoing message: one tick sent, two delivered, two
 * in pine once read.
 *
 * The three states are not the same KIND of claim, and the colour change is
 * where that shows. `sent` and `delivered` are things the server observed
 * because it routed the bytes. `read` came from the other person's device,
 * through the ratchet — it is the only one that reports on a human, and the
 * only one they can switch off. Making it the one that changes colour rather
 * than adding a third tick keeps the difference legible at a glance without
 * teaching anyone a new vocabulary.
 *
 * Nothing is drawn while a message is still pending. A tick that appears
 * before the message has left the device would be the one lie this indicator
 * must not tell.
 */

export type TickStatus = 'pending' | 'sent' | 'delivered' | 'read';

interface Props {
  status: TickStatus;
  /** Muted ink for sent/delivered. */
  color: string;
  /** Accent for read. */
  readColor: string;
  size?: number;
}

const STROKE = 2.1;

export function TickGlyph({
  status,
  color,
  readColor,
  size = 14,
}: Props): React.JSX.Element | null {
  if (status === 'pending') return null;

  const double = status !== 'sent';
  const stroke = status === 'read' ? readColor : color;

  return (
    <Svg
      width={double ? size * 1.35 : size}
      height={size}
      viewBox={double ? '0 0 22 16' : '0 0 16 16'}
      // The row's accessibility label already says the status in words; a
      // screen reader should not also hear the shape.
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Path
        d="M1.5 8.5 5 12l6.5-8"
        stroke={stroke}
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      {double ? (
        <Path
          // Offset rather than a second copy of the same path: overlapping
          // ticks read as one thick mark at this size.
          d="M9.5 12 16 4"
          stroke={stroke}
          strokeWidth={STROKE}
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
      ) : null}
    </Svg>
  );
}

/** What VoiceOver says instead of the shape. */
export function tickLabel(status: TickStatus): string {
  switch (status) {
    case 'sent':
      return 'Sent';
    case 'delivered':
      return 'Delivered';
    case 'read':
      return 'Read';
    default:
      return 'Sending';
  }
}
