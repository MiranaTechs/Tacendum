/**
 * THE ANDROID RECONNECT CLOCK — the pin for a defect the device found and no
 * test could have (the background-redial defect).
 *
 * WHAT WAS BROKEN, measured on the emulator rather than reasoned about: React
 * Native's Android timers are driven by a Choreographer frame callback that
 * `onHostPause` removes, so `setTimeout` is DEFERRED — parked, not fired late —
 * for as long as the Activity is paused. A self-rescheduling 5-second chain
 * fired 0 times in 100 seconds backgrounded, with MessagingForegroundService
 * running the whole time, and then 3 times within 12 seconds of the app being
 * foregrounded. Every reconnect in `ws.ts` was armed with `setTimeout`, so a
 * socket that DROPPED in a pocket could not dial again until the person opened
 * the app — on a platform whose whole delivery path is that socket.
 *
 * WHY A TEST CAN HOLD THIS DOWN AT ALL, given that jest has no Choreographer:
 * the repair is not "make timers work", it is "stop putting the reconnect
 * schedule somewhere the Activity's lifecycle can park it". That is a seam —
 * `WsWakeScheduler` — and a seam is exactly what a test can pin. So the first
 * group below drives the socket with the JS timer wheel PARKED and asserts
 * that the only thing which dials is the injected clock; the second group
 * drives the real Android wiring in `background.ts` against a stand-in native
 * module and asserts the two clocks settle exactly one dial between them.
 *
 * WHAT STAYS THE DEVICE'S TO PROVE: that the service's thread runs while the
 * Activity is paused. `LEG: background-redial` in the device-verification harness
 * is that claim, and it fails against the code this file's first test describes.
 */

import { DeviceEventEmitter, Platform } from 'react-native';
import {
  WsClient,
  setWsWakeScheduler,
  type WsWake,
  type WsWakeScheduler,
} from '../src/ws';
import {
  WAKE_EVENT,
  startBackgroundDelivery,
  stopBackgroundDelivery,
} from '../src/background';

type Handler = (event?: unknown) => void;

class FakeSocket {
  static OPEN = 1;
  static instances: FakeSocket[] = [];
  onopen: Handler | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: Handler | null = null;
  onclose: Handler | null = null;
  readyState = FakeSocket.OPEN;
  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }
  close() {
    this.readyState = 3;
  }
  send(_data: string) {}
}
(globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeSocket;

/** The socket the client most recently dialled. */
function live(): FakeSocket {
  const socket = FakeSocket.instances[FakeSocket.instances.length - 1];
  if (!socket) throw new Error('no socket was dialled');
  return socket;
}

/** A refused dial. 1006 with `onopen` never called is how RN reports an
 * upgrade that failed; 1006 AFTER an open is an ordinary drop, which is the
 * case this whole file is about. */
function drop(): void {
  live().onclose?.({ code: 1006 });
}

/** `Platform.OS` is a plain property on RN's Platform object. */
function setPlatform(os: 'android' | 'ios'): void {
  Object.defineProperty(Platform, 'OS', { value: os, configurable: true });
}
const REAL_OS = Platform.OS as 'android' | 'ios';

interface NativeStub {
  start: jest.Mock;
  stop: jest.Mock;
  captureNavIntent: jest.Mock;
  scheduleWake?: jest.Mock;
  cancelWake?: jest.Mock;
}

function setNative(mod: NativeStub | null): void {
  const rn = require('react-native') as { NativeModules: Record<string, unknown> };
  if (mod === null) delete rn.NativeModules.TacendumMessaging;
  else rn.NativeModules.TacendumMessaging = mod;
}

function baseNative(): NativeStub {
  return {
    start: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn().mockResolvedValue(undefined),
    captureNavIntent: jest.fn().mockResolvedValue(false),
  };
}

beforeEach(() => {
  jest.useFakeTimers();
  FakeSocket.instances.length = 0;
});

afterEach(() => {
  stopBackgroundDelivery();
  setWsWakeScheduler(null);
  setNative(null);
  setPlatform(REAL_OS);
  jest.useRealTimers();
});

// ---------------------------------------------------------------------------
// The seam itself, with no platform in sight.
// ---------------------------------------------------------------------------

/**
 * The dial watchdog's delay (`DIAL_TIMEOUT_MS` in ws.ts). Restated rather than
 * exported: a test that imported the constant would agree with the code by
 * construction, and this number is here to be told apart from a backoff.
 */
const WATCHDOG_MS = 20_000;

/** A clock the test holds the hands of. Nothing fires until `armed[i].fire()`
 * is called, which is the point: it stands in for a thread the Activity's
 * lifecycle does not touch.
 *
 * TWO KINDS OF WAKE come through here and they must not be confused: the
 * reconnect backoff, which is what this file is about, and the per-dial
 * watchdog, which every dial arms and which has its own test at the bottom.
 * `armed` is everything; `redials` is the backoff alone.
 */
function recordingScheduler(): {
  scheduler: WsWakeScheduler;
  armed: { delayMs: number; fire: () => void; cancelled: boolean }[];
  redials: () => { delayMs: number; fire: () => void; cancelled: boolean }[];
} {
  const armed: { delayMs: number; fire: () => void; cancelled: boolean }[] = [];
  const scheduler: WsWakeScheduler = {
    schedule(delayMs: number, fire: () => void): WsWake {
      const record = { delayMs, fire, cancelled: false };
      armed.push(record);
      return {
        cancel: () => {
          record.cancelled = true;
        },
      };
    },
  };
  return { scheduler, armed, redials: () => armed.filter(a => a.delayMs !== WATCHDOG_MS) };
}

test('every reconnect is armed through the installed clock, and the JS timer wheel alone dials nothing', () => {
  const { scheduler, redials } = recordingScheduler();
  setWsWakeScheduler(scheduler);

  const client = new WsClient();
  client.start('tok');
  expect(FakeSocket.instances).toHaveLength(1);
  drop();

  expect(redials()).toHaveLength(1);
  expect(redials()[0]!.delayMs).toBe(1000);

  // THE DEFECT, STATED AS AN ASSERTION. This is the paused Activity: the frame
  // callback is gone, so the timer wheel is parked. Sixty seconds of it must
  // produce no dial at all — if `scheduleReconnect` still reached `setTimeout`
  // this line would pass for the wrong reason and the next one would fail.
  jest.advanceTimersByTime(60_000);
  expect(FakeSocket.instances).toHaveLength(1);

  // And the clock that IS running re-dials.
  redials()[0]!.fire();
  expect(FakeSocket.instances).toHaveLength(2);

  client.stop();
});

test('the backoff still climbs, one wake at a time', () => {
  const { scheduler, redials } = recordingScheduler();
  setWsWakeScheduler(scheduler);

  const client = new WsClient();
  client.start('tok');
  for (let i = 0; i < 3; i++) {
    drop();
    redials()[redials().length - 1]!.fire();
  }
  // 1s, 2s, 4s — the same exponential the setTimeout path always had. Moving
  // the clock must not move the policy.
  expect(redials().map(a => a.delayMs)).toEqual([1000, 2000, 4000]);
  // ...and never two wakes for one drop.
  expect(FakeSocket.instances).toHaveLength(4);

  client.stop();
});

test('suspend cancels the armed wake — the fix restores re-dialling only where the Doze policy allows it', () => {
  const { scheduler, redials } = recordingScheduler();
  setWsWakeScheduler(scheduler);

  const client = new WsClient();
  client.start('tok');
  drop();
  expect(redials()).toHaveLength(1);

  // `pauseForIdle` routes here. The device is going to sleep and the socket is
  // deliberately down; a wake armed a moment ago must not survive that
  // decision and dial into it.
  client.suspend();
  expect(redials()[0]!.cancelled).toBe(true);

  // Belt as well as braces: even a wake that won the race against `cancel`
  // reaches a client that refuses to dial.
  redials()[0]!.fire();
  expect(FakeSocket.instances).toHaveLength(1);
});

test('stop cancels the armed wake too', () => {
  const { scheduler, redials } = recordingScheduler();
  setWsWakeScheduler(scheduler);

  const client = new WsClient();
  client.start('tok');
  drop();
  client.stop();

  expect(redials()[0]!.cancelled).toBe(true);
  redials()[0]!.fire();
  expect(FakeSocket.instances).toHaveLength(1);
});

test('a connection that LASTED resets the backoff even though the healthy timer never ran', () => {
  const { scheduler, redials } = recordingScheduler();
  setWsWakeScheduler(scheduler);

  const client = new WsClient();
  client.start('tok');
  // Two refused dials, so the backoff has climbed off its base.
  drop();
  redials()[0]!.fire();
  drop();
  redials()[1]!.fire();
  expect(redials().map(a => a.delayMs)).toEqual([1000, 2000]);

  // The third dial works, and the app goes in a pocket. `armHealthy` is a
  // `setTimeout` — it is one of the timers the Activity parks — so the wall
  // clock moves and the timer wheel does not.
  live().onopen?.();
  jest.setSystemTime(Date.now() + 6_000);

  // Now it drops. The connection LASTED, which is the same evidence of health
  // `probed`/`minted` are refunded on, so the next dial deserves the base
  // delay rather than the ceiling an outage six seconds ago had climbed to.
  drop();
  expect(redials()[2]!.delayMs).toBe(1000);

  client.stop();
});

test('...and a connection that did NOT last leaves the backoff climbing', () => {
  const { scheduler, redials } = recordingScheduler();
  setWsWakeScheduler(scheduler);

  const client = new WsClient();
  client.start('tok');
  drop();
  redials()[0]!.fire();

  // Open, and gone again well inside HEALTHY_MS. That is not evidence of
  // anything, and the refusal loop it belongs to must keep backing off.
  live().onopen?.();
  jest.setSystemTime(Date.now() + 500);
  drop();
  expect(redials().map(a => a.delayMs)).toEqual([1000, 2000]);

  client.stop();
});

test('null puts setTimeout back, which is what iOS and every other test run on', () => {
  const { scheduler, armed } = recordingScheduler();
  setWsWakeScheduler(scheduler);
  setWsWakeScheduler(null);

  const client = new WsClient();
  client.start('tok');
  drop();

  expect(armed).toHaveLength(0);
  jest.advanceTimersByTime(1000);
  expect(FakeSocket.instances).toHaveLength(2);

  client.stop();
});

// ---------------------------------------------------------------------------
// The Android wiring: two clocks, one dial.
// ---------------------------------------------------------------------------

test('the service is asked for the wake, and the parked timer cannot dial a second socket for it', () => {
  const wakes: { id: number; delayMs: number }[] = [];
  const cancelled: number[] = [];
  const mod = baseNative();
  mod.scheduleWake = jest.fn((id: number, delayMs: number) => {
    // The watchdog rides the same seam; this test is about the backoff.
    if (delayMs !== WATCHDOG_MS) wakes.push({ id, delayMs });
  });
  mod.cancelWake = jest.fn((id: number) => {
    cancelled.push(id);
  });
  setPlatform('android');
  setNative(mod);
  startBackgroundDelivery();

  const client = new WsClient();
  client.start('tok');
  drop();

  expect(wakes).toHaveLength(1);
  expect(wakes[0]!.delayMs).toBe(1000);
  expect(FakeSocket.instances).toHaveLength(1);

  // The Activity is paused, so this event — the same `emitDeviceEvent` route
  // RN's own WebSocket module delivers frames on — is the only clock left.
  DeviceEventEmitter.emit(WAKE_EVENT, wakes[0]!.id);
  expect(FakeSocket.instances).toHaveLength(2);
  // The service is told to forget it, so its thread holds nothing that has
  // already been spent. (The new dial's watchdog is armed by then, so the
  // reconnect's id is asserted by membership rather than by equality.)
  expect(cancelled).toContain(wakes[0]!.id);

  // The Choreographer comes back — the person opened the app — and the
  // `setTimeout` armed beside the wake finally runs. It must dial NOTHING: the
  // two clocks settle exactly one reconnect between them. (The window stops
  // short of the new dial's 20 s watchdog, which would legitimately write that
  // dial off and queue another — a different mechanism, with its own test.)
  jest.advanceTimersByTime(19_000);
  expect(FakeSocket.instances).toHaveLength(2);

  client.stop();
});

test('foregrounded, the ordinary timer still wins, and the service is told the wake is spent', () => {
  const cancelled: number[] = [];
  const ids: number[] = [];
  const mod = baseNative();
  mod.scheduleWake = jest.fn((id: number, delayMs: number) => {
    if (delayMs !== WATCHDOG_MS) ids.push(id);
  });
  mod.cancelWake = jest.fn((id: number) => {
    cancelled.push(id);
  });
  setPlatform('android');
  setNative(mod);
  startBackgroundDelivery();

  const client = new WsClient();
  client.start('tok');
  drop();

  // Stated separately so this test cannot pass by the clock never having been
  // installed at all — which is the shape the whole file exists to refuse.
  expect(ids).toHaveLength(1);

  jest.advanceTimersByTime(1000);
  expect(FakeSocket.instances).toHaveLength(2);
  expect(cancelled).toContain(ids[0]);

  // A wake that arrives after the timer already dialled is a duplicate, not a
  // second reconnect.
  DeviceEventEmitter.emit(WAKE_EVENT, ids[0]!);
  expect(FakeSocket.instances).toHaveLength(2);

  client.stop();
});

test('an APK whose native half predates the clock degrades to setTimeout, never to silence', () => {
  // Metro serves a bundle newer than the installed APK all day long. The
  // fallback is what keeps that from turning a defect repair into a socket
  // that never dials at all.
  setPlatform('android');
  setNative(baseNative());
  startBackgroundDelivery();

  const client = new WsClient();
  client.start('tok');
  drop();
  jest.advanceTimersByTime(1000);
  expect(FakeSocket.instances).toHaveLength(2);

  client.stop();
});

test('the clock is uninstalled with the session', () => {
  const mod = baseNative();
  mod.scheduleWake = jest.fn();
  mod.cancelWake = jest.fn();
  setPlatform('android');
  setNative(mod);
  startBackgroundDelivery();
  stopBackgroundDelivery();

  const client = new WsClient();
  client.start('tok');
  drop();

  // A relock ended the session and the service was stopped with it. Nothing
  // may still be arming wakes on a thread that has been told to forget them.
  expect(mod.scheduleWake).not.toHaveBeenCalled();
  jest.advanceTimersByTime(1000);
  expect(FakeSocket.instances).toHaveLength(2);

  client.stop();
});

test('off Android nothing is installed at all — the iOS path is untouched', () => {
  setPlatform('ios');
  setNative(null);
  startBackgroundDelivery();

  const client = new WsClient();
  client.start('tok');
  drop();
  jest.advanceTimersByTime(1000);
  expect(FakeSocket.instances).toHaveLength(2);

  client.stop();
});

// ---------------------------------------------------------------------------
// The dial watchdog — the second thing the device found.
// ---------------------------------------------------------------------------

test('a dial that neither opens nor closes is written off, and the socket goes back to the queue', () => {
  // MEASURED, not imagined (`LEG: background-redial`). With the app
  // backgrounded and the server restarted under it, the client minted its
  // tickets, one upgrade completed on the server — and the app then sat at
  // `connecting` for five minutes with nothing armed, recovering only when it
  // was foregrounded. Every reconnect guarantee in ws.ts hangs off `onopen` or
  // `onclose`, so a dial that produces neither schedules nothing at all: the
  // socket is stranded with no error, no state change and no timer.
  const { scheduler, armed, redials } = recordingScheduler();
  setWsWakeScheduler(scheduler);

  const states: string[] = [];
  const client = new WsClient();
  client.onState(s => states.push(s));
  client.start('tok');
  expect(FakeSocket.instances).toHaveLength(1);
  expect(states).toEqual(['connecting']);

  // The dial's deadline, armed with the dial and by nothing else.
  const watchdogs = armed.filter(a => a.delayMs === WATCHDOG_MS);
  expect(watchdogs).toHaveLength(1);
  // Nothing else is pending: this is precisely the stranded state.
  expect(redials()).toHaveLength(0);

  // The transport says nothing, ever. The deadline is the only thing left.
  watchdogs[0]!.fire();

  // Written off exactly as a refusal would be: `closed` reported to the app,
  // and back to the queue at the base delay.
  expect(states).toEqual(['connecting', 'closed']);
  expect(redials()).toHaveLength(1);
  expect(redials()[0]!.delayMs).toBe(1000);

  redials()[0]!.fire();
  expect(FakeSocket.instances).toHaveLength(2);

  client.stop();
});

test('a dial that opens spends its watchdog, so a live socket is never torn down by it', () => {
  const { scheduler, armed, redials } = recordingScheduler();
  setWsWakeScheduler(scheduler);

  const states: string[] = [];
  const client = new WsClient();
  client.onState(s => states.push(s));
  client.start('tok');
  const watchdog = armed.find(a => a.delayMs === WATCHDOG_MS)!;
  live().onopen?.();
  expect(watchdog.cancelled).toBe(true);

  // ...and a late fire of it, having lost the race, must not close the socket
  // the app is happily using.
  watchdog.fire();
  expect(states).toEqual(['connecting', 'open']);
  expect(redials()).toHaveLength(0);

  client.stop();
});

test('a renewal landing mid-dial never leaves the client with nothing armed (the wedge, pinned)', () => {
  // THE REGRESSION THIS PINS, and it was shipped to the device before it was
  // caught. The first attempt at de-duplicating dials made `connect()` REFUSE
  // while one was outstanding. `adoptToken` revokes the queued reconnect and
  // then dials — so with the refusal in place it revoked the timer and got
  // nothing back, and the client sat with no socket, no dial and no timer until
  // somebody opened the app. Measured on two runs: `wsState` stuck at `closed`
  // for the whole 130 s window with the foreground service healthy.
  //
  // The rule that came out of it: `connect()` must always end in a dial.
  // Supersede the outstanding one, never decline the new one.
  const { scheduler, armed, redials } = recordingScheduler();
  setWsWakeScheduler(scheduler);

  // A mint that never settles leaves a dial outstanding with no socket yet —
  // the only window in which adoptToken reaches its cancel-then-dial path.
  const client = new WsClient();
  client.start('tok', undefined, () => new Promise<string | null>(() => {}));
  expect(FakeSocket.instances).toHaveLength(0);

  client.adoptToken('a-freshly-renewed-bearer');

  // Whatever else is true: exactly one deadline is live. The superseded dial's
  // was spent with it, and the new dial's is armed.
  const watchdogs = armed.filter(a => a.delayMs === WATCHDOG_MS);
  expect(watchdogs).toHaveLength(2);
  expect(watchdogs[0]!.cancelled).toBe(true);
  expect(watchdogs[1]!.cancelled).toBe(false);

  // ...and when it expires the socket goes back to the queue, which is the
  // property the wedge destroyed.
  watchdogs[1]!.fire();
  expect(redials()).toHaveLength(1);
  expect(redials()[0]!.delayMs).toBe(1000);

  client.stop();
});

test('a superseded dial ending cannot disarm the outstanding dial (the wedge, pinned)', () => {
  // THE REGRESSION THIS EXISTS FOR, measured on the device. The
  // first version of the watchdog kept ONE handle on the client, so any dial
  // that ended cancelled whatever deadline was armed — including one belonging
  // to a different, still-outstanding dial. The client then held a stalled
  // socket with nothing watching it and nothing queued: `closed`, no timer, no
  // recovery until the app was foregrounded. Every dial now owns its deadline.
  const { scheduler, armed, redials } = recordingScheduler();
  setWsWakeScheduler(scheduler);

  const client = new WsClient();
  client.start('tok');
  const first = live();

  // Dial one ends, the backoff queues dial two.
  first.onclose?.({ code: 1006 });
  redials()[0]!.fire();
  const second = live();
  expect(second).not.toBe(first);

  const watchdogs = armed.filter(a => a.delayMs === WATCHDOG_MS);
  // One per dial, and the second one is the live claim.
  expect(watchdogs).toHaveLength(2);
  expect(watchdogs[1]!.cancelled).toBe(false);

  // The OS delivers a late duplicate close for the socket that is already
  // finished — the exact shape ws.test.ts's teardown cases are about. It must
  // not spend the deadline that belongs to the dial still in flight.
  first.onclose?.({ code: 1006 });
  expect(watchdogs[1]!.cancelled).toBe(false);

  // ...and that deadline still works: the second dial stalls, is written off,
  // and the socket goes back to the queue rather than sitting there forever.
  watchdogs[1]!.fire();
  expect(redials()).toHaveLength(2);

  client.stop();
});

test('an auth probe that never answers cannot latch the client off the air', async () => {
  // THE THIRD AND WORST OF THE STRANDING PATHS, and the one the device
  // actually died of. `authPending` suppresses both `connect` and
  // `scheduleReconnect`, and it is cleared in exactly one place: after the
  // check answers. A check whose request never settles — the normal shape of a
  // fetch issued into a network that is coming back, since React Native's
  // `fetch` has no timeout — therefore latches the socket off the air with no
  // backoff behind it and no state change to see. The server log for that run
  // contains not one further ticket from the app across five and a half
  // minutes, with the foreground service healthy the whole time.
  const { scheduler, armed, redials } = recordingScheduler();
  setWsWakeScheduler(scheduler);

  const client = new WsClient();
  // A check that never answers, and a refused upgrade to trigger it.
  client.start('tok', () => new Promise<never>(() => {}));
  live().onclose?.({ code: 1006 }); // never opened -> refused -> probe

  // The probe is in flight, so nothing is queued — that much is by design.
  expect(redials()).toHaveLength(0);

  // Its deadline, though, is armed. Before this existed there was nothing here
  // at all, and that empty set was the strand.
  const deadlines = armed.filter(a => a.delayMs === WATCHDOG_MS && !a.cancelled);
  expect(deadlines.length).toBeGreaterThan(0);

  deadlines[deadlines.length - 1]!.fire();
  // `runAuthCheck` awaits the verdict, so the queueing lands a microtask later.
  for (let i = 0; i < 8; i++) await Promise.resolve();

  // A question nobody answered is inconclusive, so the socket goes back to the
  // queue rather than off the air.
  expect(redials()).toHaveLength(1);

  client.stop();
});
