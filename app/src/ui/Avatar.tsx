import React, { useEffect, useState } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import { monogram } from '../person';
import { useTheme } from '../theme';

interface Props {
  peerId: string;
  displayName?: string | null;
  photoB64?: string | null;
  size: number;
  /** Monogram size; defaults to a readable fraction of the disc. */
  monogramSize?: number;
  /**
   * Set only where the disc is the whole element (a profile hero). Left unset,
   * the avatar is hidden from VoiceOver so a conversation row does not
   * announce its monogram letters before the person's name.
   */
  accessibilityLabel?: string;
}

/**
 * A person, at any size: their shared photo if they sent one, else initials
 * on a pine wash. There is no directory, so a face only exists when that
 * person chose to share it — the monogram is the normal case, not an error.
 */
export function Avatar({
  peerId,
  displayName,
  photoB64,
  size,
  monogramSize,
  accessibilityLabel,
}: Props) {
  const t = useTheme();
  // A peer blob can be truncated or not actually JPEG; without this the disc
  // renders empty on every screen at once instead of falling back.
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [photoB64]);

  const disc = {
    width: size,
    height: size,
    borderRadius: t.radius.circle,
    borderWidth: 1,
    borderColor: t.color.pineLine,
    backgroundColor: t.color.paperSheet,
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
      <View
        style={[styles.center, disc, { backgroundColor: t.color.pineWash }]}
      >
        <Text
          style={[
            t.type.rowTitle,
            {
              color: t.color.pine,
              fontSize: monogramSize ?? Math.round(size * 0.34),
              lineHeight: Math.round((monogramSize ?? size * 0.34) * 1.25),
            },
          ]}
          allowFontScaling={false}
        >
          {monogram(peerId, displayName)}
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
