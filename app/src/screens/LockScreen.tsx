import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  Animated,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as lock from '../lock';
import { useTheme } from '../theme';
import { BrandMark } from '../ui/BrandMark';
import { PinPad } from '../ui/PinPad';
import { useReduceMotion } from '../useReduceMotion';

/**
 * The passcode gate. The verdict decides which workspace
 * the app opens; this screen neither knows nor shows which one it was —
 * a real unlock and a duress unlock are pixel-identical here.
 */

const COPY = {
  prompt: 'Enter your code',
  wrong: 'Wrong code',
  cooldown: (mmss: string) => `Try again in ${mmss}`,
} as const;

/** Bar height of the standalone mark when it carries a whole surface. */
const MARK_HERO = 20;

interface Props {
  onUnlocked: (verdict: 'real' | 'duress') => void;
}

export function LockScreen({ onUnlocked }: Props) {
  const t = useTheme();
  const reduceMotion = useReduceMotion();
  const { height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [value, setValue] = useState('');
  const [wrong, setWrong] = useState(false);
  const [cooldownMs, setCooldownMs] = useState(0);
  const [busy, setBusy] = useState(false);
  /** Synchronous submit latch: a double-tap lands before the busy STATE has
   * re-rendered, and two concurrent unlocks nearly wiped real data (review
   * finding). Stays latched after a successful verdict until unmount. */
  const busyRef = useRef(false);
  /** Absolute cooldown deadline — the countdown is wall-clock, so a
   * backgrounded app resumes with the true remaining time, not a frozen one. */
  const deadline = useRef(0);
  const shake = useRef(new Animated.Value(0)).current;

  // A relaunch mid-cooldown resumes the countdown (state is in the Keychain).
  useEffect(() => {
    void lock.cooldownRemainingMs().then(ms => {
      if (ms > 0) {
        deadline.current = Date.now() + ms;
        setCooldownMs(ms);
      }
    });
  }, []);

  useEffect(() => {
    if (cooldownMs <= 0) return;
    const timer = setTimeout(() => {
      setCooldownMs(Math.max(0, deadline.current - Date.now()));
    }, 500);
    return () => clearTimeout(timer);
  }, [cooldownMs]);

  const runShake = useCallback(() => {
    if (reduceMotion) return;
    shake.setValue(0);
    // Each step states its easing. React Native builds its DEFAULT easing with
    // a lazy require on the first tick, which fails if that tick lands after a
    // Jest environment has been torn down — failing a run whose suites passed.
    const step = (toValue: number) =>
      Animated.timing(shake, {
        toValue,
        duration: 60,
        easing: t.motion.easing,
        useNativeDriver: true,
      });
    Animated.sequence([step(1), step(-1), step(0.6), step(0)]).start();
  }, [reduceMotion, shake, t.motion.easing]);

  const submit = useCallback(async () => {
    if (busyRef.current || value.length < 4) return;
    busyRef.current = true;
    setBusy(true);
    let unlocked = false;
    try {
      const result = await lock.verify(value);
      if (result.verdict === 'real' || result.verdict === 'duress') {
        unlocked = true; // pad stays latched until the route unmounts us
        onUnlocked(result.verdict);
        return;
      }
      setValue('');
      if (result.verdict === 'cooldown') {
        setWrong(false);
        deadline.current = Date.now() + result.retryInMs;
        setCooldownMs(result.retryInMs);
        AccessibilityInfo.announceForAccessibility(
          COPY.cooldown(formatMmSs(result.retryInMs)),
        );
      } else {
        setWrong(true);
        runShake();
        AccessibilityInfo.announceForAccessibility(COPY.wrong);
      }
    } finally {
      if (!unlocked) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  }, [value, onUnlocked, runShake]);

  const inCooldown = cooldownMs > 0;
  const hint = inCooldown
    ? COPY.cooldown(formatMmSs(cooldownMs))
    : wrong
      ? COPY.wrong
      : COPY.prompt;

  return (
    <View
      testID="lock-screen"
      style={[styles.container, { backgroundColor: t.color.paperGround }]}
    >
      {/* The mark stands at the quarter line of the SCREEN — the safe-area
          inset the container already consumed comes off the spacer — and it
          is the same place every cover holds it, so waking the app never
          makes the brand jump. The pad keeps the lower half, where thumbs
          are. */}
      <View style={{ height: Math.max(0, height * 0.25 - insets.top) }} />
      <View
        accessible
        accessibilityRole="header"
        accessibilityLabel="Tacendum"
        style={styles.brand}
      >
        <BrandMark size={MARK_HERO} />
      </View>
      <Text
        style={[
          inCooldown ? t.type.timeStatus : t.type.body,
          styles.hint,
          { color: wrong && !inCooldown ? t.color.danger : t.color.inkMuted },
        ]}
        testID="lock-hint"
      >
        {hint}
      </Text>
      <Animated.View
        style={[
          styles.padArea,
          {
            transform: [
              {
                translateX: shake.interpolate({
                  inputRange: [-1, 1],
                  outputRange: [-8, 8],
                }),
              },
            ],
          },
        ]}
      >
        <PinPad
          value={value}
          onChange={next => {
            setWrong(false);
            setValue(next);
          }}
          onSubmit={() => void submit()}
          disabled={busy || inCooldown}
        />
      </Animated.View>
    </View>
  );
}

function formatMmSs(ms: number): string {
  const total = Math.ceil(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    paddingHorizontal: 24,
  },
  /** The mark gets a full breath before the prompt: hero, not list item. */
  brand: { marginBottom: 40 },
  hint: { textAlign: 'center' },
  /** Centres the pad in whatever the quarter line and the hint leave over. */
  padArea: { flex: 1, justifyContent: 'center', paddingBottom: 24 },
});
