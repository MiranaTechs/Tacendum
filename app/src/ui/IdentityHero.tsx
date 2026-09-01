import React, { useEffect, useRef } from 'react';
import { Animated, StyleSheet, View } from 'react-native';
import Svg, { Circle, Path, Rect } from 'react-native-svg';
import { useTheme } from '../theme';

/**
 * The key forming inside a phone outline — the register screen's hero
 * (identity-redesign mockup, screen 1). Drawn in app tokens: the phone is a
 * raised paperSheet slab with a lineStrong outline, the key and its glints
 * are pine, the halo is pineWash. No shadows, no gradients — depth is
 * surface color and outline, as everywhere.
 *
 * Motion, per the designer notes: the arrival plays ONCE — phone hairline
 * fades up, the key rises 6px and fades in a brand beat later, the three
 * glints tick in last. The only loop in the whole app is the halo breathing
 * 5%→10% over ~6s (a 10%-wash circle at 50%→100% opacity). Under Reduce
 * Motion everything stills: full opacity, no rise, no loop.
 */

/** The brand's beat between arrivals — the BrandMark pause. */
const BEAT_MS = 420;

/** The mockup's drawing space; every coordinate below is verbatim from it. */
const VIEW_W = 342;
const VIEW_H = 208;

export function IdentityHero({ reduceMotion }: { reduceMotion: boolean }) {
  const t = useTheme();
  // Start visible unless the arrival is actually going to play, the BrandMark
  // rule: a setting change or interrupted mount may never leave the hero
  // invisible.
  const phone = useRef(new Animated.Value(0)).current;
  const key = useRef(new Animated.Value(0)).current;
  const glints = useRef(new Animated.Value(0)).current;
  /** 0 = resting (50% of the wash), 1 = full breath (100%). */
  const halo = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (reduceMotion) {
      phone.setValue(1);
      key.setValue(1);
      glints.setValue(1);
      return;
    }
    const arrive = Animated.stagger(BEAT_MS, [
      Animated.timing(phone, {
        toValue: 1,
        duration: t.motion.surface,
        easing: t.motion.easing,
        useNativeDriver: true,
      }),
      Animated.timing(key, {
        toValue: 1,
        duration: t.motion.surface,
        easing: t.motion.easing,
        useNativeDriver: true,
      }),
      Animated.timing(glints, {
        toValue: 1,
        duration: t.motion.micro,
        easing: t.motion.easing,
        useNativeDriver: true,
      }),
    ]);
    arrive.start();
    return () => arrive.stop();
  }, [reduceMotion, phone, key, glints, t.motion]);

  useEffect(() => {
    if (reduceMotion) return;
    const breathe = Animated.loop(
      Animated.sequence([
        Animated.timing(halo, {
          toValue: 1,
          duration: 3000,
          easing: t.motion.easing,
          useNativeDriver: true,
        }),
        Animated.timing(halo, {
          toValue: 0,
          duration: 3000,
          easing: t.motion.easing,
          useNativeDriver: true,
        }),
      ]),
    );
    breathe.start();
    // A loop left alive past this screen ticks against a torn-down tree.
    return () => breathe.stop();
  }, [reduceMotion, halo, t.motion]);

  // A literal 1 under Reduce Motion, not a parked Animated.Value: the halo is
  // genuinely static then, and the style says so.
  const haloStyle = reduceMotion
    ? { opacity: 1 }
    : {
        opacity: halo.interpolate({
          inputRange: [0, 1],
          outputRange: [0.5, 1],
        }),
      };

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
      style={styles.canvas}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {/* Halo ground: always-on faint wash. */}
      <Svg
        style={StyleSheet.absoluteFill}
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      >
        <Circle cx={171} cy={105} r={95} fill={t.color.pineWashFaint} />
      </Svg>

      {/* The one loop in the app. */}
      <Animated.View
        testID="register-hero-halo"
        style={[StyleSheet.absoluteFill, haloStyle]}
      >
        <Svg
          style={StyleSheet.absoluteFill}
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        >
          <Circle cx={171} cy={105} r={66} fill={t.color.pineWash} />
        </Svg>
      </Animated.View>

      {/* Phone outline, first to arrive. */}
      <Animated.View style={[StyleSheet.absoluteFill, { opacity: phone }]}>
        <Svg
          style={StyleSheet.absoluteFill}
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        >
          <Rect
            x={126}
            y={22}
            width={90}
            height={166}
            rx={22}
            fill={t.color.paperSheet}
            stroke={t.color.lineStrong}
            strokeWidth={2}
          />
          <Rect
            x={156}
            y={32}
            width={30}
            height={6}
            rx={3}
            fill={t.color.lineSoft}
          />
        </Svg>
      </Animated.View>

      {/* The key rises into place a beat later. */}
      <Animated.View style={[StyleSheet.absoluteFill, rise(key)]}>
        <Svg
          style={StyleSheet.absoluteFill}
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        >
          <Circle
            cx={171}
            cy={88}
            r={15}
            fill="none"
            stroke={t.color.pine}
            strokeWidth={8}
          />
          <Path
            d="M171 103 L171 152"
            stroke={t.color.pine}
            strokeWidth={8}
            strokeLinecap="round"
          />
          <Path
            d="M171 134 L185 134"
            stroke={t.color.pine}
            strokeWidth={8}
            strokeLinecap="round"
          />
          <Path
            d="M171 148 L182 148"
            stroke={t.color.pine}
            strokeWidth={8}
            strokeLinecap="round"
          />
        </Svg>
      </Animated.View>

      {/* Glints — the "just made" tick — land last. */}
      <Animated.View style={[StyleSheet.absoluteFill, { opacity: glints }]}>
        <Svg
          style={StyleSheet.absoluteFill}
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        >
          <Path
            d="M150 56 L142 47"
            stroke={t.color.pine}
            strokeWidth={3.5}
            strokeLinecap="round"
          />
          <Path
            d="M163 50 L160 39"
            stroke={t.color.pine}
            strokeWidth={3.5}
            strokeLinecap="round"
          />
          <Path
            d="M178 52 L184 43"
            stroke={t.color.pine}
            strokeWidth={3.5}
            strokeLinecap="round"
          />
        </Svg>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  canvas: { width: '100%', aspectRatio: VIEW_W / VIEW_H, marginTop: 4 },
});
