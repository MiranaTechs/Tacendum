import {
  AppState,
  DeviceEventEmitter,
  NativeModules,
  Platform,
} from 'react-native';
import { previewFor } from './envelope';
import { setWsWakeScheduler, type WsWake, type WsWakeScheduler } from './ws';

/**
 * Background delivery on Android.
 *
 * **The shape of the problem, because it inverts the iOS one.** iOS closes the
 * socket when the app leaves the foreground, deliberately: a frozen process
 * leaves its TCP connection standing, the server posts into a buffer nobody
 * reads, marks the message delivered, and sends no push — so `messaging.pause`
 * exists to make the server take the push branch. Android has no push branch
 * in this build. The websocket IS the delivery path, so the socket must
 * stay up while the app is away, which is what a foreground service is for
 * (`MessagingForegroundService`, the class the suite asserts by name).
 *
 * So this module owns four things, and each is one half of a contract whose
 * other half is Kotlin:
 *
 *  1. THE SERVICE'S LIFETIME. Started when a real session opens and stopped
 *     when it closes, so an ongoing "Connected" notification never outlives
 *     the socket it describes.
 *  2. THE DOZE PAUSE POLICY (the contract, stated as an assertion the
 *     tests can make): under device idle the socket is PAUSED and nothing is
 *     delivered; delivery resumes on exit from idle. The signal is Kotlin's —
 *     only the platform knows when it entered idle — and the decision is
 *     here, which is why app/__tests__/doze.android.test.ts can pin both
 *     branches without a device. The device leg cannot: Doze suspends an
 *     app's network access on its own, so the OS produces exactly the same
 *     silence from an app that never pauses anything, and the end-to-end leg
 *     can prove the CONTRACT but never the ATTRIBUTION.
 *  3. THE BANNER. A message that arrives while the app is away has nothing
 *     else to announce it — there is no notification-service extension on this
 *     platform, and no push for one to rewrite. `announceIncoming` hands the
 *     already-computed preview line to the in-process handler, which applies
 *     the same gates the extension applies on iOS (previews-armed lease,
 *     preview-level, blocked-peers) before deciding what it may say.
 *  4. THE RECONNECT CLOCK. Keeping a socket alive turned out to be half the
 *     job: this platform's React Native timers stop with the Activity, so the
 *     app could HOLD a socket in a pocket but not DIAL one there. The service
 *     owns a thread the Choreographer does not touch, and `ws.ts` arms its
 *     backoff through it. See WAKE_EVENT below for the measurement.
 *
 * Every export is a no-op off Android. Nothing here is imported conditionally:
 * the platform check lives inside each function, so the call sites in
 * messaging.ts stay a single line with no platform branch of their own.
 */

/** The verdicts the native handler returns. They name a RULE, never a value:
 * `blocked` — the sender is in the block mirror, nothing was posted;
 * `generic` — the lease or the level refused a preview; `sender` / `full` —
 * what the level allowed. */
export type NotifyVerdict = 'blocked' | 'generic' | 'sender' | 'full' | 'skipped';

interface TacendumMessagingNative {
  start(): Promise<void>;
  stop(): Promise<void>;
  notifyMessage(payload: {
    from: string;
    msgId: string;
    roomId: string;
    preview: string;
    structured: boolean;
  }): Promise<string>;
  captureNavIntent(): Promise<boolean>;
  deviceIdle(): Promise<boolean>;
  serviceRunning(): Promise<boolean>;
  /**
   * Ask the service's own thread to poke JS back in `delayMs`, whatever the
   * Activity's lifecycle is doing. Optional in the TYPE and checked at the
   * call site: during development the JS bundle Metro serves is routinely
   * newer than the installed APK, and an app whose native half predates this
   * pair must fall back to `setTimeout` rather than arm a wake nothing will
   * ever deliver.
   */
  scheduleWake?(id: number, delayMs: number): void;
  cancelWake?(id: number): void;
}

/**
 * The native module, or null.
 *
 * Null is a NORMAL answer, on two different platforms and for two different
 * reasons: iOS has an extension instead and never registers this, and an
 * Android build whose interop layer has not yet published the module answers
 * null for the moment between the two. Every caller treats null as "there is
 * no background delivery here" and carries on, because none of this is
 * load-bearing for a message arriving — only for announcing that it did.
 */
function native(): TacendumMessagingNative | null {
  if (Platform.OS !== 'android') return null;
  const mod = (NativeModules as Record<string, unknown>).TacendumMessaging;
  return (mod as TacendumMessagingNative | undefined) ?? null;
}

/** The event the foreground service's idle receiver publishes. One literal,
 * restated from TacendumMessagingModule.EVENT_DEVICE_IDLE. */
export const DEVICE_IDLE_EVENT = 'TacendumMessagingDeviceIdle';

/** The event the service's wake thread publishes, carrying the id of the wake
 * that came due. One literal, restated from
 * TacendumMessagingModule.EVENT_WAKE. */
export const WAKE_EVENT = 'TacendumMessagingWake';

/**
 * THE ANDROID RECONNECT CLOCK (the repair for a defect found on the device matrix).
 *
 * The measurement, from a device verification run: React Native's Android timers
 * are Choreographer-driven and `onHostPause` removes the frame callback, so a
 * 5-second `setTimeout` chain fired 0 times in 100 seconds backgrounded — with
 * MessagingForegroundService running the whole time — and then 3 times within
 * 12 seconds of the app being foregrounded. `ws.ts` armed every reconnect with
 * `setTimeout`, so a socket that DROPPED in a pocket could not dial again
 * until the person opened the app. Steady-state delivery was never affected:
 * an open socket's own callbacks are native, which is why the leg's first
 * four probes always passed.
 *
 * The fix keeps the schedule where the Choreographer cannot reach it. The
 * service already owns a process that is allowed to be awake while the app is
 * away; it now also owns a plain `Handler` thread that counts the delay down
 * and pokes JS when it comes due. Nothing about WHEN a reconnect should happen
 * moves to Kotlin — the backoff, the auth probe, the terminal `gone` latch all
 * stay in `ws.ts`, which is where they can be reasoned about and tested. The
 * only thing that crosses is "wake me in N milliseconds".
 *
 * BOTH CLOCKS ARE ARMED, and that is deliberate rather than belt-and-braces
 * for its own sake. The `setTimeout` is kept alongside the native wake and
 * whichever comes first wins, once, through a shared latch. Foregrounded, the
 * timer fires exactly as it always did and the native wake is cancelled; away,
 * the timer is parked and the service's thread is the one that arrives. So
 * this change can only ever make a re-dial happen SOONER — an APK whose native
 * half is missing, a service the platform refused to start, a JS reload that
 * left a stale listener behind all degrade to precisely today's behaviour
 * rather than to a socket that never dials at all.
 */
let wakeSeq = 0;
const pendingWakes = new Map<number, () => void>();

/** The service's thread says a wake came due. Popped before it is run: a
 * duplicate event (a reinstalled listener, a republished id) must not dial
 * twice. */
function fireWake(id: number): void {
  const run = pendingWakes.get(id);
  if (run === undefined) return;
  run();
}

function nativeWakeScheduler(mod: TacendumMessagingNative): WsWakeScheduler {
  return {
    schedule(delayMs: number, fire: () => void): WsWake {
      const id = ++wakeSeq;
      let spent = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const settle = (): boolean => {
        if (spent) return false;
        spent = true;
        pendingWakes.delete(id);
        if (timer !== null) clearTimeout(timer);
        try {
          mod.cancelWake?.(id);
        } catch {
          // The native half went away (a reload, a teardown). The wake it
          // would have delivered went with it, and the latch above has
          // already made this one unrepeatable.
        }
        return true;
      };
      pendingWakes.set(id, () => {
        if (settle()) fire();
      });
      timer = setTimeout(() => {
        if (settle()) fire();
      }, delayMs);
      try {
        mod.scheduleWake?.(id, delayMs);
      } catch {
        // Fall through: the `setTimeout` above is still armed, so this
        // degrades to exactly the behaviour that shipped before this seam.
      }
      return { cancel: () => void settle() };
    },
  };
}

/**
 * THE OTHER PARKED CLOCK — and the reason re-dialling from a pocket needed two
 * repairs rather than one.
 *
 * The wake scheduler above moved the reconnect SCHEDULE off `setTimeout`. It
 * was not enough, and the measurement says why: the first thing a scheduled
 * dial does is mint a ticket, the mint is a `fetch`, and
 * **every `fetch` in this app settles through `setTimeout(…, 0)`** —
 * whatwg-fetch, which React Native installs as the global `fetch`, wraps each
 * of `resolve`, `reject`, the timeout and the abort in one (node_modules/
 * whatwg-fetch/dist/fetch.umd.js). So `ws.ts` woke on the service's thread,
 * asked for a ticket, the request went out, the server issued it, the response
 * came back — and the promise that would have handed it to `openSocket` sat
 * parked until somebody opened the app.
 *
 * Measured on Pixel_7_API_35, app backgrounded:
 *
 *   `setTimeout(fn, 0)`  parked      `setImmediate(fn)`   fires at 0 ms
 *   `setTimeout(fn, 1)`  parked      `queueMicrotask(fn)` fires at 0 ms
 *   `setTimeout(fn, 50)` parked      `Promise.then`       fires at 0 ms
 *   `setTimeout(fn, 3000)` parked    `XMLHttpRequest`     completes in 6 ms
 *
 *   `fetch()`            NEVER SETTLED — the same request through the XHR
 *                        underneath it completed in 6 ms, and the fetch
 *                        promise resolved 64 SECONDS later, at the instant the
 *                        app was foregrounded.
 *
 * The adapter's own log shows the shape of it from the far end: a ticket every
 * 50 seconds — the dial watchdog's 20 s plus the backoff's 30 s ceiling — and
 * not one `$connect` between them.
 *
 * SO ZERO-DELAY TIMEOUTS ARE RUN AS IMMEDIATES WHILE THE APP IS AWAY. A
 * `setTimeout(fn, 0)` means "as soon as possible", `setImmediate` is exactly
 * that on this platform, and it is not Choreographer-gated. Three things keep
 * that narrow:
 *
 *  - only zero (or absent) delays are touched. A real delay is a scheduling
 *    DECISION and stays with the platform's clock, where the Doze policy and
 *    the wake scheduler can reason about it;
 *  - only while the app is not `active`. Foregrounded, the platform's own
 *    timer wheel is working and nothing here should be in its way;
 *  - both clocks are armed and the first to arrive wins once — the same shape
 *    as the wake scheduler above — so `clearTimeout` keeps working on the
 *    handle it is given, and an environment with no `setImmediate` degrades to
 *    exactly today's behaviour rather than to a timer that never fires.
 *
 * `clearTimeout` is wrapped for the one thing the shared latch cannot do by
 * itself: cancelling the handle cancels the platform timer, and the immediate
 * has to be told. Verified on the device — `clearTimeout` does NOT cancel a
 * `setImmediate` handle, which is why the handle returned here stays the
 * platform's own.
 */
type TimeoutFn = (handler: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => unknown;
type ClearFn = (handle: unknown) => void;

let restoreTimers: (() => void) | null = null;

function installImmediateTimeouts(): void {
  if (restoreTimers !== null) return;
  const g = globalThis as unknown as {
    setTimeout: TimeoutFn;
    clearTimeout: ClearFn;
    setImmediate?: (handler: (...args: unknown[]) => void, ...args: unknown[]) => unknown;
  };
  const timeout = g.setTimeout;
  const clear = g.clearTimeout;
  const immediate = g.setImmediate;
  // No `setImmediate` is not a failure state: it is every platform but this
  // one, and there the timer wheel was never parked in the first place.
  if (typeof immediate !== 'function') return;

  /** Zero-delay timeouts armed on both clocks, by handle. */
  const shared = new Map<unknown, { spent: boolean }>();

  g.setTimeout = ((handler, ms, ...args) => {
    if (
      typeof handler !== 'function' ||
      (typeof ms === 'number' && ms > 0) ||
      AppState.currentState === 'active'
    ) {
      return timeout(handler, ms, ...args);
    }
    const latch = { spent: false };
    const handle = timeout(() => {
      if (latch.spent) return;
      latch.spent = true;
      shared.delete(handle);
      handler(...args);
    }, 0);
    shared.set(handle, latch);
    immediate(() => {
      if (latch.spent) return;
      latch.spent = true;
      shared.delete(handle);
      // The platform timer is still armed and would run this a second time on
      // the next foreground edge; it is spent, so take it off the wheel.
      clear(handle);
      handler(...args);
    });
    return handle;
  }) as TimeoutFn;

  g.clearTimeout = ((handle: unknown) => {
    const latch = shared.get(handle);
    if (latch) {
      latch.spent = true;
      shared.delete(handle);
    }
    return clear(handle);
  }) as ClearFn;

  restoreTimers = () => {
    g.setTimeout = timeout;
    g.clearTimeout = clear;
    shared.clear();
    restoreTimers = null;
  };
}

function restoreImmediateTimeouts(): void {
  restoreTimers?.();
}

/**
 * Does the socket survive the app leaving the foreground?
 *
 * On iOS it must NOT: a frozen process leaves its connection standing, the
 * server posts into a buffer nobody reads and sends no push, and the recipient
 * learns nothing until they open the app — which is exactly a messenger with
 * no notifications. `messaging.pause` closes it so the push branch is taken.
 *
 * On Android there is no push branch — the foreground service exists to
 * keep precisely this socket alive, and closing it on backgrounding would make
 * background delivery impossible — the same defect, arrived at from the
 * opposite direction. The one thing that DOES pause the socket here is device
 * idle, which is a different signal with its own policy above.
 *
 * A function rather than a constant so the platform is read at call time, and
 * so this file stays the only place in the app that knows which way it goes.
 */
export function socketSurvivesBackground(): boolean {
  return Platform.OS === 'android';
}

/**
 * Which push truth THIS BINARY embodies.
 *
 * `'fcm'` exactly when the installed Android build was compiled against a
 * google-services.json — the native module exports it as a CONSTANT from
 * `BuildConfig.TACENDUM_FCM`, the same file-presence check that gated every
 * other piece of Firebase wiring, so the answer describes the running binary
 * and can never describe an intention. `'socket'` everywhere else: on iOS (which
 * has APNs and no use for this), on the websocket-only Android build, in
 * tests, and in the moment before the interop layer publishes the module —
 * every degraded reading lands on the claim that promises LESS.
 *
 * Synchronous on purpose: its consumer is consent-grade Settings copy, which
 * is a string literal chosen at render time, not a state machine.
 */
export function pushTransport(): 'fcm' | 'socket' {
  const mod = native() as (TacendumMessagingNative & { pushTransport?: string }) | null;
  return mod?.pushTransport === 'fcm' ? 'fcm' : 'socket';
}

/**
 * What the policy pauses. `messaging` implements it; the interface exists so
 * the policy can be driven in a test without the whole messaging module, and
 * so this file never imports messaging.ts (which imports this one).
 */
export interface DeliveryTransport {
  /** Suspend the socket because the device went idle. */
  pauseForIdle(): void;
  /** Reopen it because the device woke. */
  resumeFromIdle(): void;
}

let transport: DeliveryTransport | null = null;
let idle = false;
let subscriptions: { remove(): void }[] = [];

/** Installed by `messaging.start`, cleared by `messaging.stop`: a policy that
 * outlived its session would pause a socket belonging to another one. */
export function setDeliveryTransport(next: DeliveryTransport | null): void {
  transport = next;
  if (next === null) idle = false;
}

/** True while the policy believes the device is idle. Read by the dev hook and
 * the tests; nothing branches on it inside the app. */
export function deviceIsIdle(): boolean {
  return idle;
}

/**
 * THE DOZE PAUSE POLICY.
 *
 * Idle: the socket is told to pause, and nothing is delivered while it stays
 * that way. Wake: it is told to resume. Both edges are guarded — the platform
 * republishes the current state whenever the service starts, and a second
 * "idle" must not re-suspend a socket that is already suspended, while a
 * "wake" for an idle this policy never applied must not dial a socket the app
 * deliberately has down (a locked workspace, a session that never started).
 *
 * Exported so the pin can call it directly: the test is the attribution layer
 * the device leg cannot be.
 */
export function applyDeviceIdle(next: boolean): void {
  if (next === idle) return;
  idle = next;
  const t = transport;
  if (t === null) return;
  if (next) {
    t.pauseForIdle();
  } else {
    t.resumeFromIdle();
  }
}

/**
 * Start the foreground service and subscribe to what it publishes.
 *
 * Called from `messaging.start`, after the socket is dialled: the service is
 * the permission to KEEP a socket, not the thing that opens one, and starting
 * it earlier would show "Connected" over a session that has not connected.
 */
export function startBackgroundDelivery(): void {
  const mod = native();
  if (mod === null) return;
  stopSubscriptions();
  // `DeviceEventEmitter` is what a legacy module's `emitDeviceEvent` reaches,
  // which is why the native side emits rather than exposing an emitter of its
  // own: one subscription, no per-module emitter contract to keep in step.
  subscriptions.push(
    DeviceEventEmitter.addListener(DEVICE_IDLE_EVENT, value => {
      applyDeviceIdle(value === true);
    }),
  );
  // The other half of the banner's life: a tap that arrived while the app was
  // away leaves a thread key on the launch intent, and the app has to pick it
  // up before `consumePendingNav` runs. The native side also watches
  // `onNewIntent` for the warm case; this covers the cold one, where the
  // process started because of the tap.
  subscriptions.push(
    AppState.addEventListener('change', state => {
      if (state !== 'active') return;
      void mod.captureNavIntent().catch(() => undefined);
    }),
  );
  // The reconnect clock (see WAKE_EVENT above). The listener goes up before
  // the scheduler is installed, so no wake can be armed with nothing on this
  // side to receive it, and both are torn down together below.
  subscriptions.push(
    DeviceEventEmitter.addListener(WAKE_EVENT, value => {
      const id = Number(value);
      if (Number.isFinite(id)) fireWake(id);
    }),
  );
  if (typeof mod.scheduleWake === 'function' && typeof mod.cancelWake === 'function') {
    setWsWakeScheduler(nativeWakeScheduler(mod));
  }
  // The reconnect clock's other half (see the block above `setTimeout` is
  // parked for): a wake that dials is worth nothing if the dial's first `await`
  // is parked behind the same Choreographer.
  installImmediateTimeouts();
  void mod.start().catch(() => undefined);
}

/** Stop it. Called from `messaging.stop` — a relock, a sign-out, a workspace
 * switch — because a socket that is not running must not be advertised as
 * one. */
export function stopBackgroundDelivery(): void {
  stopSubscriptions();
  const mod = native();
  // The platform check stays ahead of the scheduler teardown, so this function
  // reaches nothing at all off Android — the same rule every other export here
  // follows, and the one that keeps a scheduler that was never installed from
  // being uninstalled on a platform that has no such seam.
  if (mod === null) return;
  // Back to `setTimeout` before the service goes, in that order: a scheduler
  // pointing at a stopped service would arm wakes on a thread that has been
  // told to forget them. `ws.stop()` has already run by the time messaging
  // calls this and cancelled its own pending wake, so what the map is cleared
  // of here is nothing — which is the state that has to be true, not a
  // convenience.
  setWsWakeScheduler(null);
  pendingWakes.clear();
  // ...and the timer shim with it, in the same order and for the same reason:
  // this session is over, and nothing installed for it should outlive it.
  restoreImmediateTimeouts();
  void mod.stop().catch(() => undefined);
}

function stopSubscriptions(): void {
  for (const s of subscriptions) {
    try {
      s.remove();
    } catch {
      // A subscription that is already gone is the state we wanted.
    }
  }
  subscriptions = [];
}

/**
 * `{"tcm":` — envelope.ts's own sentinel, restated because it is not exported
 * and because this is the same one-directional rule NotificationService.swift
 * applies: a body that announces itself as STRUCTURE may only ever show a
 * fixed constant, never its own words. `previewFor` returns exactly that
 * constant for every kind it knows, so the flag and the line travel together.
 */
const ENVELOPE_SENTINEL = '{"tcm":';

/**
 * Announce one delivered message, if this platform announces anything.
 *
 * Called from the single content switch in messaging.ts, after the row is
 * durably stored and acked — never before, because a banner for a message
 * that failed to persist would be a promise the thread cannot keep.
 *
 * Never throws and never rejects: it is called with `void` from a delivery
 * path, and a notification is not worth failing one over.
 */
export async function announceIncoming(entry: {
  from: string;
  msgId: string;
  roomId: string | null;
  body: string;
}): Promise<NotifyVerdict> {
  const mod = native();
  if (mod === null) return 'skipped';
  // Nothing is announced while the person is looking at the app — the same
  // rule iOS gets for free, where a foreground app's push raises no banner.
  // `undefined` (a test environment with no AppState) reads as active, the
  // quiet direction.
  const state = AppState.currentState;
  if (state !== 'background' && state !== 'inactive') return 'skipped';
  try {
    const verdict = await mod.notifyMessage({
      from: entry.from,
      msgId: entry.msgId,
      roomId: entry.roomId ?? '',
      // The app's own preview line — the one that writes
      // `chats.lastMessageText`, whose comments record that it must never
      // carry a vault title, a filename, or coordinates. The native side
      // decides whether it may be SHOWN; this decides only what the candidate
      // is, and it is never a raw body for a structured message.
      preview: previewFor(entry.body),
      structured: entry.body.startsWith(ENVELOPE_SENTINEL),
    });
    return (verdict as NotifyVerdict) ?? 'generic';
  } catch {
    return 'skipped';
  }
}
