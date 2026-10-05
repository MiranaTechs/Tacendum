import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { monogram } from '../person';
import { useTheme } from '../theme';
import { MONOGRAM_FACE } from './Avatar';

/** How far down the doorway reaches, as a share of the mark: deep enough to
 * read as an open door on the solid face at every size it is drawn. */
export const DOOR_DEPTH = 0.12;

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
 * person is a circle; a room is a solid square with a doorway cut into its
 * top wall. Same forest, same white letters (MONOGRAM_FACE, 2026-10-05),
 * same monogram mechanism: the distinction is FORM, never a new colour,
 * because the palette is closed.
 *
 * This is THE room signal, repeated wherever an identity mark appears (the
 * chat list row, the thread header), so a list mixing rooms and people reads
 * at a glance: circles are people, walled squares are places. It is visual
 * only — every surface that shows it also says "group" in its accessibility
 * label (the list row "Kitchen, group, …", the thread header "Kitchen,
 * group, 3 people"), because a distinction that exists only visually is not
 * a distinction for everyone.
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
  // 176pt top wall), centred; whole pixels so its edges stay crisp. On a
  // solid face a 1pt gap in a 1pt wall reads as a nick, not a door, so the
  // opening has depth: the two side pieces are the walls with their jambs,
  // full height, and the floor under the doorway starts DOOR_DEPTH of the
  // mark down (6pt in a 48pt row, 4pt in a 36pt header, 12pt on the 104pt
  // hero). The row's own ground shows through the threshold, the way the
  // Rooms tab draws its door as a clear gap. One forest, the same in both
  // appearances.
  const jamb = Math.round((size - Math.round(size * (64 / 176))) / 2);
  const depth = Math.max(2, Math.round(size * DOOR_DEPTH));
  const face = { backgroundColor: MONOGRAM_FACE.fill };
  const glyph = monogramSize ?? Math.round(size * 0.34);

  const mark = (
    <View style={[styles.center, { width: size, height: size }]} {...(testID ? { testID } : {})}>
      <View style={[styles.piece, face, { left: 0, top: 0, width: jamb, height: size }]} />
      <View style={[styles.piece, face, { right: 0, top: 0, width: jamb, height: size }]} />
      <View
        style={[
          styles.piece,
          face,
          { left: jamb, top: depth, width: size - 2 * jamb, height: size - depth },
        ]}
      />
      <Text
        style={[
          t.type.rowTitle,
          {
            color: MONOGRAM_FACE.ink,
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
  piece: { position: 'absolute' },
});
