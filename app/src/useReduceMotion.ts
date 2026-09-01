import { useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

/**
 * Whether the person has asked the system to reduce motion. Subscribed, not
 * just read once: it can be toggled from Control Centre while the app is open,
 * and every animation in the app is expected to honour it immediately.
 */
export function useReduceMotion(): boolean {
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    let live = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then(enabled => {
        if (live) setReduceMotion(enabled);
      })
      .catch(() => {});
    const sub = AccessibilityInfo.addEventListener(
      'reduceMotionChanged',
      setReduceMotion,
    );
    return () => {
      live = false;
      sub.remove();
    };
  }, []);

  return reduceMotion;
}
