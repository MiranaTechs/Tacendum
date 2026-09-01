/**
 * THE PARKED FETCH — the pin for the half of the background-redial defect that
 * had nothing to do with the socket (the background-redial defect).
 *
 * WHAT WAS BROKEN, measured rather than reasoned about. The repair moved the reconnect
 * SCHEDULE off `setTimeout`, because React Native's Android timers are
 * Choreographer-driven and `onHostPause` removes the frame callback. That was
 * necessary and it was not sufficient: the first thing a scheduled dial does is
 * mint a ticket, the mint is a `fetch`, and whatwg-fetch — which React Native
 * installs as the global `fetch` — resolves and rejects EVERY request through
 * `setTimeout(…, 0)`. So the wake fired on the service's thread, the request
 * went out, the server issued the ticket, the response came back, and the
 * promise that would have handed it to the socket sat parked.
 *
 * Measured on Pixel_7_API_35, with the app backgrounded: the same
 * request completed through `XMLHttpRequest` in 6 ms and the `fetch` twin of it
 * settled 64 SECONDS later, at the instant the app was foregrounded. Every
 * `setTimeout` — 0 ms, 1 ms, 50 ms, 3000 ms — was parked; `setImmediate`,
 * `queueMicrotask` and promise continuations all ran at 0 ms.
 *
 * WHAT A TEST CAN HOLD DOWN, given that jest has no Choreographer: not that the
 * platform parks timers, but that a zero-delay timeout is handed to the clock
 * which is not parked — and only while the app is away, only for zero delays,
 * and only until the session ends. Those four rules are the whole shim.
 */

import { AppState, Platform } from 'react-native';
import { startBackgroundDelivery, stopBackgroundDelivery } from '../src/background';

function setPlatform(os: 'android' | 'ios'): void {
  Object.defineProperty(Platform, 'OS', { value: os, configurable: true });
}
const REAL_OS = Platform.OS as 'android' | 'ios';

function setAppState(state: 'active' | 'background'): void {
  Object.defineProperty(AppState, 'currentState', { value: state, configurable: true });
}
const REAL_STATE = AppState.currentState;

function setNative(mod: unknown | null): void {
  const rn = require('react-native') as { NativeModules: Record<string, unknown> };
  if (mod === null) delete rn.NativeModules.TacendumMessaging;
  else rn.NativeModules.TacendumMessaging = mod;
}

function baseNative(): Record<string, unknown> {
  return {
    start: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn().mockResolvedValue(undefined),
    captureNavIntent: jest.fn().mockResolvedValue(false),
    scheduleWake: jest.fn(),
    cancelWake: jest.fn(),
  };
}

type Global = {
  setTimeout: (fn: (...a: unknown[]) => void, ms?: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  setImmediate?: (fn: (...a: unknown[]) => void) => unknown;
};
const g = globalThis as unknown as Global;

/** The clock the Activity's lifecycle does not touch, recorded rather than run:
 * this is how the test tells "handed to the immediate" apart from "fired by the
 * timer wheel", which in jest would look identical. */
let immediates: (() => void)[] = [];
let realImmediate: Global['setImmediate'];
let realTimeout: Global['setTimeout'];
let realClear: Global['clearTimeout'];

beforeEach(() => {
  jest.useFakeTimers();
  immediates = [];
  realTimeout = g.setTimeout;
  realClear = g.clearTimeout;
  realImmediate = g.setImmediate;
  g.setImmediate = ((fn: () => void) => {
    immediates.push(fn);
    return 0;
  }) as Global['setImmediate'];
  setPlatform('android');
  setNative(baseNative());
});

afterEach(() => {
  stopBackgroundDelivery();
  setNative(null);
  setPlatform(REAL_OS);
  setAppState(REAL_STATE as 'active');
  g.setImmediate = realImmediate;
  g.setTimeout = realTimeout;
  g.clearTimeout = realClear;
  jest.useRealTimers();
});

test('while the app is away a zero-delay timeout goes to the clock that is not parked', () => {
  setAppState('background');
  startBackgroundDelivery();

  const ran: string[] = [];
  setTimeout(() => ran.push('zero'), 0);

  // Handed to the immediate, and nothing has run yet — an immediate is still a
  // macrotask, so this is a scheduling claim and not a synchronous call.
  expect(immediates).toHaveLength(1);
  expect(ran).toEqual([]);

  immediates[0]!();
  expect(ran).toEqual(['zero']);

  // ...and ONCE. The platform timer is armed beside it, exactly as the wake
  // scheduler arms both clocks, and the first to arrive wins.
  jest.advanceTimersByTime(1000);
  expect(ran).toEqual(['zero']);
});

test('clearTimeout still cancels a timeout the shim redirected', () => {
  setAppState('background');
  startBackgroundDelivery();

  const ran: string[] = [];
  const handle = setTimeout(() => ran.push('cancelled'), 0);
  clearTimeout(handle);

  // Verified on the device: `clearTimeout` does NOT cancel a `setImmediate`
  // handle, which is why the shim keeps the platform's handle and marks the
  // latch itself. Both arms have to stay quiet.
  expect(immediates).toHaveLength(1);
  immediates[0]!();
  jest.advanceTimersByTime(1000);
  expect(ran).toEqual([]);
});

test('a real delay is a scheduling decision and stays with the platform clock', () => {
  setAppState('background');
  startBackgroundDelivery();

  const ran: string[] = [];
  setTimeout(() => ran.push('later'), 50);

  expect(immediates).toHaveLength(0);
  expect(ran).toEqual([]);
  jest.advanceTimersByTime(50);
  expect(ran).toEqual(['later']);
});

test('foregrounded, the platform keeps its own timers', () => {
  setAppState('active');
  startBackgroundDelivery();

  const ran: string[] = [];
  setTimeout(() => ran.push('zero'), 0);

  expect(immediates).toHaveLength(0);
  jest.advanceTimersByTime(0);
  expect(ran).toEqual(['zero']);
});

test('the session ends and the platform gets its timers back', () => {
  setAppState('background');
  const before = g.setTimeout;
  startBackgroundDelivery();
  expect(g.setTimeout).not.toBe(before);

  stopBackgroundDelivery();
  expect(g.setTimeout).toBe(before);

  const ran: string[] = [];
  setTimeout(() => ran.push('zero'), 0);
  expect(immediates).toHaveLength(0);
});

test('nothing is installed off Android', () => {
  setPlatform('ios');
  setAppState('background');
  const before = g.setTimeout;
  startBackgroundDelivery();
  expect(g.setTimeout).toBe(before);
});
