import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { monogram } from '../person';
import { useTheme } from '../theme';

interface Props {
  roomId: string;
  /** The room's shown name — my rename outranking the creator's. The
   * monogram falls back to the id's TAIL characters when there is none
   * (the design blesses exactly that); the full id never renders. */
  name?: string | null;
  size: number;
  /** Monogram size; defaults to the same readable fraction Avatar uses. */
  monogramSize?: number;
  /**
   * Set only where the mark is the whole element. Left unset, the mark is
   * hidden from VoiceOver so a conversation row does not announce its
   * monogram letters before the room's name — Avatar's exact posture.
   */
  accessibilityLabel?: string;
  testID?: string;
}

/**
 * A room, at any size: the Quiet Room's own geometry — four walls and an
 * open threshold — scaled to sit exactly where a person's disc sits. A
 * person is a circle; a room is a walled square with a doorway. Same paper,
 * same pine, same monogram mechanism: the distinction is FORM, never a new
 * colour, because the palette is closed.
 *
 * This is THE room signal, repeated wherever an identity mark appears (the
 * chat list row, the thread header), so a list mixing rooms and people reads
 * at a glance: circles are people, walled squares are places. It is visual
 * only — every surface that shows it also says "room" in its accessibility
 * label, because a distinction that exists only visually is not a
 * distinction for everyone.
 */
export function RoomMark({
  roomId,
  name,
  size,
  monogramSize,
  accessibilityLabel,
  testID,
}: Props) {
  const t = useTheme();
  // The doorway keeps the Quiet Room's proportion (a 64pt opening in its
  // 176pt top wall), centred; whole pixels so the jambs stay crisp. The
  // opening is real — the fill sits inside the walls, so the row's own
  // paper shows through the threshold.
  const jamb = Math.round((size - Math.round(size * (64 / 176))) / 2);
  const wall = { backgroundColor: t.color.pineLine };
  const glyph = monogramSize ?? Math.round(size * 0.34);

  const mark = (
    <View style={[styles.center, { width: size, height: size }]} {...(testID ? { testID } : {})}>
      <View style={[styles.fill, { backgroundColor: t.color.pineWash }]} />
      <View style={[styles.wall, wall, { left: 0, top: 0, width: 1, height: size }]} />
      <View style={[styles.wall, wall, { right: 0, top: 0, width: 1, height: size }]} />
      <View style={[styles.wall, wall, { left: 0, bottom: 0, width: size, height: 1 }]} />
      <View style={[styles.wall, wall, { left: 0, top: 0, width: jamb, height: 1 }]} />
      <View style={[styles.wall, wall, { right: 0, top: 0, width: jamb, height: 1 }]} />
      <Text
        style={[
          t.type.rowTitle,
          {
            color: t.color.pine,
            fontSize: glyph,
            lineHeight: Math.round(glyph * 1.25),
          },
        ]}
        // A fixed box: scaling the letters would clip them against the
        // walls at accessibility sizes. Room-ness reaches VoiceOver as the
        // WORD in the host surface's label, never as these letters.
        allowFontScaling={false}
      >
        {monogram(roomId, name)}
      </Text>
    </View>
  );

  // The wrapper carries no style, so the mark keeps its exact geometry in
  // every slot the Avatar disc occupies.
  return accessibilityLabel ? (
    <View accessible accessibilityLabel={accessibilityLabel}>
      {mark}
    </View>
  ) : (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {mark}
    </View>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center' },
  fill: { position: 'absolute', left: 1, top: 1, right: 1, bottom: 1 },
  wall: { position: 'absolute' },
});
