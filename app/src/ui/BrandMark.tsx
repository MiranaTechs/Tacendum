import React, { useEffect, useRef } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../theme';
import { useReduceMotion } from '../useReduceMotion';

/**
 * The Tacendum mark: two turns of a conversation. The SOLID bar opens (you,
 * upper left) and the OUTLINED bar replies (them, lower right), offset the
 * way a reply sits under a message — the order the site's hero and favicon
 * draw (web/site/index.html `.hmark`), the brand's ruled
 * front door. Re-ordered here deliberately
 * ("the launch screen shows the old logo"); this supersedes the earlier
 * outlined-first order. NOTE: brand/tacendum-mark.svg and the AppIcon
 * rasters still carry the earlier order — regenerating them is a
 * separate rule, flagged, not silently taken here.
 *
 * Every dimension is a ratio of the bar height, matching the site hero's
 * ratios exactly, so the app and the website cannot drift apart.
 */
const R = {
  solidWidth: 2.955,
  replyWidth: 2.795,
  replyStroke: 0.33,
  /** Vertical space between the two bars. */
  gap: 0.227,
  /** How far the reply sits to the right of the first bar. */
  offset: 1.545,
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
  // Arrival order IS the conversation: you open, they answer — the same
  // beat the site hero plays (.you at .08s, .them at .5s).
  const them = useRef(new Animated.Value(animate ? 0 : 1)).current;
  const you = useRef(new Animated.Value(animate ? 0 : 1)).current;

  useEffect(() => {
    if (!animate || reduceMotion) {
      you.setValue(1);
      them.setValue(1);
      return;
    }
    const arrive = Animated.stagger(BEAT_MS, [
      Animated.timing(you, {
        toValue: 1,
        duration: t.motion.surface,
        easing: t.motion.easing,
        useNativeDriver: true,
      }),
      Animated.timing(them, {
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
        height: (2 + R.gap) * size,
      }}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Animated.View
        style={[
          styles.bar,
          rise(you),
          {
            width: R.solidWidth * size,
            height: size,
            borderRadius: size / 2,
            backgroundColor: t.color.pine,
          },
        ]}
      />
      <Animated.View
        style={[
          styles.bar,
          rise(them),
          {
            width: R.replyWidth * size,
            height: size,
            marginLeft: R.offset * size,
            marginTop: R.gap * size,
            borderRadius: size / 2,
            borderWidth: R.replyStroke * size,
            borderColor: t.color.pine,
          },
        ]}
      />
    </View>
  );
}

/**
 * The horizontal lockup from brand/tacendum-lockup.svg: the mark, then the
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
  const cursor = useRef(new Animated.Value(1)).current;

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

  useEffect(() => {
    // Reduce Motion keeps the cursor lit: it is part of the wordmark, not an
    // indicator of anything.
    if (reduceMotion) {
      cursor.setValue(1);
      return;
    }
    const blink = Animated.loop(
      Animated.sequence([
        Animated.timing(cursor, {
          toValue: 0,
          duration: 0,
          delay: 550,
          easing: t.motion.easing,
          useNativeDriver: true,
        }),
        Animated.timing(cursor, {
          toValue: 1,
          duration: 0,
          delay: 550,
          easing: t.motion.easing,
          useNativeDriver: true,
        }),
      ]),
    );
    blink.start();
    return () => blink.stop();
  }, [cursor, reduceMotion, t.motion.easing]);

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
        <Animated.Text
          style={[
            t.type.brandHero,
            {
              fontSize: size,
              lineHeight: size * 1.2,
              color: t.color.pine,
              opacity: cursor,
            },
          ]}
        >
          ▌
        </Animated.Text>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { overflow: 'hidden' },
  lockup: { flexDirection: 'row', alignItems: 'center' },
  lockupWord: { flexDirection: 'row', alignItems: 'center', marginLeft: 14 },
});
