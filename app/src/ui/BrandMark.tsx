import React, { useEffect, useRef } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../theme';
import { useReduceMotion } from '../useReduceMotion';

/**
 * Two turns of a conversation: the outlined incoming bar opens at upper
 * left, then the solid reply answers at lower right. This matches the
 * source brand asset and app icon (build 28 correction).
 */
const R = {
  openingWidth: 375 / 127,
  replyWidth: 396 / 127,
  replyHeight: 168 / 127,
  replyStroke: 42 / 127,
  /** Vertical space between the two bars. */
  gap: 8 / 127,
  /** How far the reply sits to the right of the first bar. */
  offset: 175 / 127,
} as const;

/** The beat between the two turns. A conversation is the pause, not the pair. */
const BEAT_MS = 420;

interface Props {
  /** Bar height; everything else is derived from it. */
  size?: number;
  /** Play the arrival once on mount. */
  animate?: boolean;
}

export function BrandMark({ size = 30, animate = false }: Props) {
  const t = useTheme();
  const reduceMotion = useReduceMotion();
  // Start visible unless we are actually going to animate, so the mark can
  // never be left invisible by a setting change or an interrupted mount.
  // Incoming first, then your reply.
  const them = useRef(new Animated.Value(animate ? 0 : 1)).current;
  const you = useRef(new Animated.Value(animate ? 0 : 1)).current;

  useEffect(() => {
    if (!animate || reduceMotion) {
      you.setValue(1);
      them.setValue(1);
      return;
    }
    const arrive = Animated.stagger(BEAT_MS, [
      Animated.timing(them, {
        toValue: 1,
        duration: t.motion.surface,
        easing: t.motion.easing,
        useNativeDriver: true,
      }),
      Animated.timing(you, {
        toValue: 1,
        duration: t.motion.surface,
        easing: t.motion.easing,
        useNativeDriver: true,
      }),
    ]);
    arrive.start();
    // A running timing keeps its own timer and reads the easing every frame;
    // left alive past this screen it ticks against a torn-down tree.
    return () => arrive.stop();
  }, [animate, reduceMotion, you, them, t.motion]);

  const rise = (v: Animated.Value) => ({
    opacity: v,
    transform: [
      {
        translateY: v.interpolate({ inputRange: [0, 1], outputRange: [6, 0] }),
      },
    ],
  });

  return (
    <View
      style={{
        width: (R.offset + R.replyWidth) * size,
        height: (1 + R.replyHeight + R.gap) * size,
      }}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Animated.View
        style={[
          styles.bar,
          rise(them),
          {
            width: R.openingWidth * size,
            height: size,
            borderRadius: size / 2,
            borderWidth: R.replyStroke * size,
            borderColor: t.color.pine,
          },
        ]}
      />
      <Animated.View
        style={[
          styles.bar,
          rise(you),
          {
            width: R.replyWidth * size,
            height: R.replyHeight * size,
            marginLeft: R.offset * size,
            marginTop: R.gap * size,
            borderRadius: (R.replyHeight * size) / 2,
            backgroundColor: t.color.pine,
          },
        ]}
      />
    </View>
  );
}

/**
 * The in-app horizontal lockup: the mark, then the
 * wordmark. Because it carries the name, a screen showing this must not also
 * show a separate wordmark — that is the whole point of a lockup.
 *
 * The mark arrives first, then the name, so the brand assembles the same way
 * a conversation does.
 */
/**
 * In brand/tacendum-lockup.svg the mark stands about 1.4x the wordmark's cap
 * height — small enough to sit beside the name rather than tower over it.
 * Menlo's caps are ~0.58 of its point size, so the bar height that reproduces
 * that relationship is 0.36 x the wordmark size.
 */
const BAR_PER_POINT = 0.36;

export function BrandLockup({
  size = 30,
  animate = false,
}: {
  /** Wordmark point size; the mark is derived from it. */
  size?: number;
  animate?: boolean;
}) {
  const t = useTheme();
  const reduceMotion = useReduceMotion();
  const word = useRef(new Animated.Value(animate ? 0 : 1)).current;

  useEffect(() => {
    if (!animate || reduceMotion) {
      word.setValue(1);
      return;
    }
    // Lands after the mark's own two turns (a beat plus its arrival).
    const name = Animated.timing(word, {
      toValue: 1,
      delay: BEAT_MS + t.motion.surface,
      duration: t.motion.surface,
      easing: t.motion.easing,
      useNativeDriver: true,
    });
    name.start();
    return () => name.stop();
  }, [animate, reduceMotion, word, t.motion]);

  return (
    <View
      style={styles.lockup}
      accessible
      accessibilityRole="header"
      accessibilityLabel="Tacendum"
    >
      <BrandMark size={size * BAR_PER_POINT} animate={animate} />
      <Animated.View style={[styles.lockupWord, { opacity: word }]}>
        <Text
          // A fixed logo drawing, named by the accessible parent. Body copy
          // still follows Dynamic Type; scaling this wordmark would clip it.
          allowFontScaling={false}
          style={[
            t.type.brandHero,
            {
              fontSize: size,
              lineHeight: size * 1.2,
              color: t.color.inkStrong,
            },
          ]}
        >
          TACENDUM
        </Text>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { overflow: 'hidden' },
  lockup: { flexDirection: 'row', alignItems: 'center' },
  lockupWord: { flexDirection: 'row', alignItems: 'center', marginLeft: 14 },
});
