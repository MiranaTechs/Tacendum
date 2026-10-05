import React, { useEffect, useMemo, useState } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
// The id-refusal rule this fill shares with the group tiles: a surface a
// stranger holding the phone sees never letters itself with id characters.
import { tileName, UNNAMED } from './CallTile';
import { monogram } from '../person';
import { useTheme } from '../theme';

/**
 * The person, COVERING the surface their video would cover.
 *
 * Hardware testing: the first fix put a 160pt `PeerFace` in the
 * middle of the remote surface — about 6% of a 390×844 display — so "person B
 * is all dark screen" stayed ~94% true. "Fully on the screen" means the
 * surface reads as that person: the photo cover-crops to the surface exactly
 * as the live video it stands in for does (`objectFit="cover"` on the
 * `TacendumVideoView` beneath it). No scrim over it — the header already sits
 * over LIVE video with nothing between them, and theme.ts rules scrims out of
 * the product outright.
 *
 * With NO photo, the fill is mediaWash behind every photo-less person on a
 * video surface, carrying the chat's monogram — via `tileName`, so a "name"
 * that is really `personName`'s id fallback letters as `?`, never as id
 * characters (rule 2 of the group tiles, kept here for the same reason).
 * Either way the surface is never bare black. This is a VIDEO surface's
 * fill only: a voice call is an app screen and draws the person with the
 * app's own face instead.
 *
 * Pointer-transparent and hidden from accessibility: the Pressable it sits
 * inside already announces whose video this is, and the tap on that surface
 * (swap on the call screen, restore on the minimized window) must pass
 * through it.
 *
 * MOVED out of CallScreen.tsx so the minimized call window
 * shows the same person the same way — the styles are the values the call
 * screen carried, byte for byte; only where they are built changed.
 */
export function PeerBackdrop({
  peerId,
  peerName,
  photoB64,
  compact = false,
}: {
  peerId: string;
  peerName: string;
  photoB64?: string | null;
  /** True in the 110pt corner, where surface-sized letters would clip. */
  compact?: boolean;
}): React.JSX.Element {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  // The same guard `Avatar` keeps: a truncated or non-JPEG blob falls back to
  // the monogram fill rather than rendering an empty surface.
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [photoB64]);
  const shown = tileName(peerId, peerName);
  return (
    <View
      style={styles.backdrop}
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {photoB64 && !failed ? (
        <Image
          source={{ uri: `data:image/jpeg;base64,${photoB64}` }}
          style={styles.backdropPhoto}
          resizeMode="cover"
          onError={() => setFailed(true)}
        />
      ) : (
        <Text
          style={compact ? styles.backdropMonogramSmall : styles.backdropMonogram}
          allowFontScaling={false}
        >
          {shown === UNNAMED ? '?' : monogram(peerId, shown)}
        </Text>
      )}
    </View>
  );
}

function makeStyles(theme: ReturnType<typeof useTheme>) {
  return StyleSheet.create({
    /** The person at SURFACE size. The wrapper carries the no-photo ground —
     * mediaWash behind every photo-less person on a video surface — so no
     * state of the backdrop leaves bare black behind it. Edge-pinned to its
     * surface, full screen or 110pt corner alike. */
    backdrop: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: theme.color.mediaWash,
      alignItems: 'center',
      justifyContent: 'center',
    },
    /** Edge-pinned, never sized: a fixed width is exactly how a face ends up
     * floating in black on a surface of a different shape. */
    backdropPhoto: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
    },
    backdropMonogram: {
      color: theme.color.mediaInk,
      fontSize: 96,
      fontWeight: '600',
    },
    /** The corner is 110pt wide; the surface-sized letters would clip it. */
    backdropMonogramSmall: {
      color: theme.color.mediaInk,
      fontSize: 32,
      fontWeight: '600',
    },
  });
}
