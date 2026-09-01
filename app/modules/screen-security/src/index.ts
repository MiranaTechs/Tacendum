import type { EventSubscription } from 'react-native';
import NativeScreenSecurity from './NativeScreenSecurity';

/**
 * Typed JS surface over the native screen-security module. Nothing here
 * prevents anything — see NativeScreenSecurity.ts: iOS only lets an app
 * observe capture and cover itself while inactive. Policy (what to blank,
 * what to disclose) lives in app code, not in this module.
 */

/** Begin forwarding capture/screenshot events; idempotent. */
export function start(): void {
  NativeScreenSecurity.start();
}

/** Current capture state (screen recording, AirPlay, mirroring). */
export function getIsCaptured(): Promise<boolean> {
  return NativeScreenSecurity.getIsCaptured();
}

/** Subscribe to capture-state changes; returns the subscription. */
export function onCapturedChanged(
  listener: (captured: boolean) => void,
): EventSubscription {
  return NativeScreenSecurity.onCapturedChanged(listener);
}

/** Subscribe to after-the-fact screenshot events; returns the subscription. */
export function onScreenshot(listener: () => void): EventSubscription {
  return NativeScreenSecurity.onScreenshot(listener);
}
