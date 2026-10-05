import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Avatar } from './Avatar';
import { useTheme } from '../theme';

interface Occupant {
  peerId: string;
  displayName?: string | null;
  photoB64?: string | null;
}

interface Props {
  /** With people, the two places are filled; without, they are quiet dots. */
  you?: Occupant;
  them?: Occupant;
  /** Caption under the room. Pass null to omit it. */
  caption?: string | null;
  /** Set for data-bearing instances; decorative ones stay out of VoiceOver. */
  accessibilityLabel?: string;
}

/**
 * THE SIGNATURE. A room seen from above: four walls, one open threshold, and
 * exactly two places inside. There is no third place — the product's whole
 * thesis drawn in primitives (no SVG, no images, no animation).
 *
 * Used in exactly five places: the landing hero, the empty chat list, an
 * empty thread, the peer-profile hero, and the wide shell's empty detail
 * pane (this room is that surface's
 * seed). It is never a loading state and never decoration on a card.
 */
export function QuietRoom({
  you,
  them,
  caption = 'Just you two',
  accessibilityLabel,
}: Props) {
  const t = useTheme();
  const wall = { backgroundColor: t.color.pineLine };
  const decorative = accessibilityLabel === undefined;

  return (
    <View
      style={styles.root}
      accessible={!decorative}
      {...(accessibilityLabel ? { accessibilityLabel } : {})}
      {...(decorative
        ? {
            accessibilityElementsHidden: true,
            importantForAccessibility: 'no-hide-descendants' as const,
          }
        : {})}
    >
      <View style={styles.room}>
        {/* walls: the threshold is the 64pt gap in the top wall */}
        <View style={[styles.wallLeft, wall]} />
        <View style={[styles.wallRight, wall]} />
        <View style={[styles.wallBottom, wall]} />
        <View style={[styles.wallTopLeft, wall]} />
        <View style={[styles.wallTopRight, wall]} />

        <View style={[styles.place, styles.placeLeft]}>
          {you ? (
            <Avatar
              peerId={you.peerId}
              displayName={you.displayName}
              photoB64={you.photoB64}
              size={32}
              monogramSize={11}
            />
          ) : (
            <EmptyPlace />
          )}
        </View>
        <View style={[styles.place, styles.placeRight]}>
          {them ? (
            <Avatar
              peerId={them.peerId}
              displayName={them.displayName}
              photoB64={them.photoB64}
              size={32}
              monogramSize={11}
            />
          ) : (
            <EmptyPlace />
          )}
        </View>
      </View>

      {caption ? (
        <Text
          style={[
            styles.caption,
            t.type.utilityLabel,
            { color: t.color.inkMuted },
          ]}
          maxFontSizeMultiplier={2}
        >
          {caption}
        </Text>
      ) : null}
    </View>
  );
}

function EmptyPlace() {
  const t = useTheme();
  return (
    <View
      style={[
        styles.emptyPlace,
        { borderColor: t.color.pineLine, backgroundColor: 'transparent' },
      ]}
    >
      <View style={[styles.emptyDot, { backgroundColor: t.color.pine }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  // The caption flows after the room rather than being pinned into an 18pt
  // slot, so it grows instead of clipping. 64 room + 9 + 15 line box = the
  // specified 88, so none of the four call sites move.
  root: { width: 176, alignItems: 'center' },
  room: { width: 176, height: 64 },
  wallLeft: { position: 'absolute', left: 0, top: 0, width: 1, height: 64 },
  wallRight: { position: 'absolute', left: 175, top: 0, width: 1, height: 64 },
  wallBottom: { position: 'absolute', left: 0, top: 63, width: 176, height: 1 },
  wallTopLeft: { position: 'absolute', left: 0, top: 0, width: 56, height: 1 },
  wallTopRight: {
    position: 'absolute',
    left: 120,
    top: 0,
    width: 56,
    height: 1,
  },
  place: { position: 'absolute', top: 18, width: 32, height: 32 },
  placeLeft: { left: 22 },
  placeRight: { left: 122 },
  emptyPlace: {
    width: 32,
    height: 32,
    borderRadius: 999,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyDot: { width: 8, height: 8, borderRadius: 4 },
  caption: { marginTop: 9, width: 176, textAlign: 'center' },
});
