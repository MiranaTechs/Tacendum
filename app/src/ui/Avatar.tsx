import React, { useEffect, useState } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import { monogram } from '../person';
import { themeTokens, useTheme } from '../theme';

/**
 * The face of a person or a room with no photo (2026-10-05, superseding
 * the earlier white disc in a gray ring): the brand forest
 * at full strength with white letters, in BOTH appearances. White on #0E6B45
 * measures 6.55:1.
 *
 * Taken by value from the light palette, the way QrPanel fixes its ink: the
 * dark palette lifts `pine` to a text colour and turns `onPine` charcoal, so
 * the live theme's pair would draw a different face in dark. One pair for
 * every monogram the app draws — Avatar, RoomMark and the group-call tile —
 * so no surface can disagree about what a face looks like.
 */
export const MONOGRAM_FACE = {
  fill: themeTokens('light').color.pine,
  ink: themeTokens('light').color.onPine,
} as const;

interface Props {
  peerId: string;
  displayName?: string | null;
  photoB64?: string | null;
  size: number;
  /** Monogram size; defaults to a readable fraction of the disc. */
  monogramSize?: number;
  /**
   * Letters to draw instead of the derived ones.
   *
   * The call surfaces refuse `personName`'s id fallback BY VALUE (`tileName`)
   * and letter such a peer `?`. They cannot express that through
   * `displayName`: the sentinel would letter as its own initials, and `null`
   * would fall through to two characters of the id. Those are precisely the
   * two outcomes the refusal exists to prevent.
   */
  monogramOverride?: string;
  /**
   * Set only where the disc is the whole element (a profile hero). Left unset,
   * the avatar is hidden from VoiceOver so a conversation row does not
   * announce its monogram letters before the person's name.
   */
  accessibilityLabel?: string;
  /**
   * 'media' on a surface that carries or awaits video, which is black in
   * both appearances: the disc is drawn with the media palette (the wash,
   * a media hairline, white letters), the same in light and dark, so the
   * person looks the same before the call connects as after. Default 'app':
   * the forest disc with white letters (MONOGRAM_FACE), the same in both
   * appearances; a photo keeps its hairline ring on the sheet.
   */
  tone?: 'app' | 'media';
}

/**
 * A person, at any size: their shared photo if they sent one, else initials
 * in white on a solid forest disc (on a video surface, the media disc). There
 * is no directory, so a face only exists when that person chose to share it —
 * the monogram is the normal case, not an error.
 */
export function Avatar({
  peerId,
  displayName,
  photoB64,
  size,
  monogramSize,
  monogramOverride,
  accessibilityLabel,
  tone = 'app',
}: Props) {
  const t = useTheme();
  // A peer blob can be truncated or not actually JPEG; without this the disc
  // renders empty on every screen at once instead of falling back.
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [photoB64]);

  const media = tone === 'media';
  // A photo sits on the sheet inside its hairline ring, as it always has:
  // the 2026-10-05 ruling recolours monograms and leaves photos alone. On a
  // video surface the photo and the monogram share the media disc.
  const disc = {
    width: size,
    height: size,
    borderRadius: t.radius.circle,
    borderWidth: 1,
    borderColor: media ? t.color.mediaLine : t.color.lineStrong,
    backgroundColor: media ? t.color.mediaWash : t.color.paperSheet,
  };
  // The monogram on an app surface: solid forest, and its 1pt edge is the
  // same forest, so the disc keeps the photo's geometry with no gray ring.
  const monogramDisc = media
    ? disc
    : {
        ...disc,
        borderColor: MONOGRAM_FACE.fill,
        backgroundColor: MONOGRAM_FACE.fill,
      };

  const face =
    photoB64 && !failed ? (
      <Image
        source={{ uri: `data:image/jpeg;base64,${photoB64}` }}
        style={disc}
        resizeMode="cover"
        onError={() => setFailed(true)}
      />
    ) : (
      <View style={[styles.center, monogramDisc]}>
        <Text
          style={[
            t.type.rowTitle,
            {
              color: media ? t.color.mediaInk : MONOGRAM_FACE.ink,
              fontSize: monogramSize ?? Math.round(size * 0.34),
              lineHeight: Math.round((monogramSize ?? size * 0.34) * 1.25),
            },
          ]}
          allowFontScaling={false}
        >
          {monogramOverride ?? monogram(peerId, displayName)}
        </Text>
      </View>
    );

  // The wrapper carries no style, so the disc keeps its exact geometry inside
  // the Quiet Room's absolutely positioned 32pt places and the 104pt hero.
  return accessibilityLabel ? (
    <View accessible accessibilityLabel={accessibilityLabel}>
      {face}
    </View>
  ) : (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {face}
    </View>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center' },
});
