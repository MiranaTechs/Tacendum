import React, { useMemo } from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import { useTheme } from '../theme';

/**
 * A call, rendered inline in the thread.
 *
 * **These rows are LOCAL.** Each side derives its own from its own state
 * machine and the two never exchange log data, so a peer cannot write into
 * your call history — they cannot forge a call you never received, and they
 * cannot delete one you did. That is why a missed call here is trustworthy in
 * a way a server-rendered history would not be.
 */

export interface CallLogRowData {
  cid: string;
  direction: 'in' | 'out';
  kind: 'audio' | 'video';
  reason: string | null;
  connectedAt: number | null;
  endedAt: number | null;
  missed: boolean;
}

export interface CallLogRowProps {
  row: CallLogRowData;
  /** Tapping places a new call of the same kind to the same peer. */
  onRedial(kind: 'audio' | 'video'): void;
}

/**
 * What the row says.
 *
 * The distinctions matter to a person in a way the reason codes do not:
 * "Missed" and "Declined" are different events, and a call that never
 * connected is not a zero-second call. `connectedAt === null` is the fact that
 * separates them, so it decides the label rather than the duration.
 */
export function callLabel(row: CallLogRowData): string {
  const kind = row.kind === 'video' ? 'Video call' : 'Audio call';
  if (row.missed) return row.direction === 'in' ? `Missed ${kind.toLowerCase()}` : `${kind}, no answer`;
  switch (row.reason) {
    case 'decline':
      return row.direction === 'in' ? `${kind} declined` : `${kind} declined`;
    case 'busy':
      return `${kind}, busy`;
    case 'failed_ice':
    case 'failed_media':
      return `${kind} failed to connect`;
    case 'blocked':
    case 'unsupported':
      return `${kind} could not be placed`;
    default:
      return row.direction === 'in' ? `Incoming ${kind.toLowerCase()}` : `Outgoing ${kind.toLowerCase()}`;
  }
}

/** `null` when the call never connected — deliberately not "0:00", which
 * would assert that a call took place. */
export function callDuration(row: CallLogRowData): string | null {
  if (row.connectedAt === null || row.endedAt === null) return null;
  const total = Math.max(0, Math.floor((row.endedAt - row.connectedAt) / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  const hours = Math.floor(minutes / 60);
  const mm = hours > 0 ? String(minutes % 60).padStart(2, '0') : String(minutes);
  return hours > 0
    ? `${hours}:${mm}:${String(seconds).padStart(2, '0')}`
    : `${mm}:${String(seconds).padStart(2, '0')}`;
}

/** Arrow direction, or a distinct mark for missed. Paired with a colour, never
 * carried by colour alone. */
export function callGlyph(row: CallLogRowData): string {
  if (row.missed) return '⤫';
  return row.direction === 'out' ? '↗' : '↙';
}

export function CallLogRow({ row, onRedial }: CallLogRowProps): React.JSX.Element {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);

  const label = callLabel(row);
  const duration = callDuration(row);
  // Missed rows are `danger`; everything else is subdued. Colour is a second
  // signal — the glyph and the words already carry it, so a person who cannot
  // distinguish the colours loses nothing.
  const tone = row.missed ? theme.color.danger : theme.color.inkMuted;

  return (
    <Pressable
      onPress={() => onRedial(row.kind)}
      accessibilityRole="button"
      accessibilityLabel={duration ? `${label}, ${duration}. Call back.` : `${label}. Call back.`}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: theme.color.pineWashFaint }]}
    >
      <Text style={[styles.glyph, { color: tone }]} accessibilityElementsHidden importantForAccessibility="no">
        {callGlyph(row)}
      </Text>
      <Text style={[styles.label, { color: tone }]} numberOfLines={1}>
        {label}
      </Text>
      {duration !== null && <Text style={styles.duration}>{duration}</Text>}
    </Pressable>
  );
}

function makeStyles(theme: ReturnType<typeof useTheme>) {
  return StyleSheet.create({
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      alignSelf: 'center',
      paddingVertical: 8,
      paddingHorizontal: 14,
      marginVertical: 4,
      borderRadius: 999,
      minHeight: 44,
      backgroundColor: theme.color.paperLayer,
    },
    glyph: { fontSize: 14 },
    label: { fontSize: 13 },
    duration: { fontSize: 13, color: theme.color.inkMuted, fontVariant: ['tabular-nums'] },
  });
}
