import { useEffect, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import type { CallState } from '@tacendum/shared';
import * as audio from 'tacendum-audio';

/**
 * The outgoing ringback — the tone the CALLER hears while the far phone
 * rings (a device report: "ringing doesn't have any sound").
 *
 * OUTGOING ONLY. An incoming call is CallKit's to ring: the system ringtone,
 * on the lock screen, at the ringer volume — a second sound from the app
 * would double it. The predicate is therefore exactly `outgoing_ringing`,
 * the machine's word for "the callee's device confirmed it is ringing":
 *
 *  - not `outgoing_connecting` before it — playing a ring before the far
 *    phone rings would claim a fact that is not yet true (a real phone is
 *    silent until the network says "alerting" for the same reason);
 *  - not `outgoing_connecting` after it either — the machine returns there
 *    when the ANSWER arrives (call-machine.ts, answerReceived), so leaving
 *    `outgoing_ringing` IS the instant the ring must end, whichever way it
 *    ended: answer, decline, cancel, timeout, failure.
 *
 * Playback itself is native (tacendum-audio): a synthesized loop played
 * INTO the call session CallKit activated, never configuring it — the
 * session doctrine is CallKitCenter.swift the design's, and this module's half of
 * it lives in TacendumAudioImpl.startRingback. This hook only decides WHEN.
 *
 * Foreground-only by decision: the screen drives the tone, so the tone plays
 * while the screen does. Backgrounding mid-ring stops it; returning while
 * still ringing resumes it (`shouldPlay` recomputes and the effect re-runs).
 */

// Resolved through the namespace and tolerated when absent: the jest-global
// tacendum-audio mock (jest.setup.js) mirrors the voice-note surface and
// predates the ringback, so a suite that mounts a ringing CallScreen under it
// must get a silent no-op, not a crash. The app's real module always has both.
const { startRingback, stopRingback } = audio as Partial<typeof audio>;

/**
 * Exactly when the caller should be hearing the ring.
 *
 * The app-state axis is "not backgrounded" rather than "provably active":
 * 'inactive' is the transient iOS state a notification pull-down or the app
 * switcher passes through, and a real phone keeps ringing across those. Only
 * 'background' — the state named by the requirement — silences the tone.
 * (It also keeps the predicate honest where `currentState` is briefly
 * undefined: a screen the person is looking at is foreground by definition.)
 */
export function ringbackShouldPlay(
  state: CallState,
  appState: AppStateStatus | undefined,
): boolean {
  return (
    state.name === 'outgoing_ringing' &&
    state.call.direction === 'out' &&
    appState !== 'background'
  );
}

/**
 * Start/stop the ringback from the call state this screen already receives.
 *
 * One boolean dependency, on purpose: the effect re-runs only when the
 * answer to "should the caller be hearing the ring" changes, so re-renders
 * of the same ringing call never restart the loop, and every transition off
 * it — including unmount — runs the cleanup that stops it. The rejections
 * are swallowed: 'no_call' (the call ended before the start landed) means
 * the tone has nothing to play over, which is the outcome we wanted anyway.
 */
export function useOutgoingRingback(state: CallState): void {
  const [appState, setAppState] = useState<AppStateStatus | undefined>(
    AppState.currentState,
  );
  useEffect(() => {
    const sub = AppState.addEventListener('change', setAppState);
    return () => sub.remove();
  }, []);

  const shouldPlay = ringbackShouldPlay(state, appState);
  useEffect(() => {
    if (!shouldPlay) return undefined;
    startRingback?.().catch(() => {});
    return () => {
      stopRingback?.().catch(() => {});
    };
  }, [shouldPlay]);
}
