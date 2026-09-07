import { useEffect, useState } from 'react';
import type { CallState } from '@tacendum/shared';
import { idleState, OFFER_TTL_MS } from '@tacendum/shared';
import * as native from 'tacendum-call';
import { getSecret, setSecret } from 'tacendum-crypto';
import { AppState, Platform, type AppStateStatus } from 'react-native';
import {
  apiDeletePushToken,
  onApiAuthRenewed,
  apiRegisterFcmToken,
  apiRegisterPushToken,
  apiTurnCredentials,
} from '../api';
import * as db from '../db';
import { AUTH_TOKEN_KEY, messaging } from '../messaging';
import { pushTokensAllowed, setPushTokensAllowed } from '../pushConsent';
import { personName, sanitizeDisplayName } from '../person';
import { session } from '../session';
import { nextMsgId } from '../msgid';
import { CallController } from './controller';
// The refusal type, re-exported so the shell can name it. `placeCall` throws
// it, App.tsx has to tell "you blocked them" from "their safety number
// changed" to say why a Call button did nothing, and it imports the call
// module from this barrel — so the alternative was App.tsx becoming the first
// production module outside `src/call/` to reach into `controller.ts`. One
// line here keeps that boundary where it is.
export { CallRefusedError } from './controller';
import { callMetricDrain, callMetricLifecycle } from './metrics';
import {
  GroupCallCoordinator,
  type GroupCallKitSessionEvidence,
  type GroupCallView,
  type LegFanOutcome,
} from './group';
import { foldRoster } from '@tacendum/shared/group-fold';
import {
  decidePressure,
  decideRing,
  relayForPeer,
  type PressureInputs,
} from './policy';
import {
  measuredCallQuality,
  UNKNOWN_CALL_QUALITY,
  type CallQuality,
  type CallQualityStatus,
} from './quality';

/**
 * The app's single call controller, wired to the real everything.
 *
 * Kept out of `App.tsx` deliberately. Constructing this needs messaging, the
 * native module, the database, the API client and the Keychain, and threading
 * all of that through a component tree would put five imports into a file
 * whose job is routing. `App.tsx` needs only to render the screens and call
 * `startCalling()`.
 */

let controller: CallController | null = null;
let subscribers = new Set<(state: CallState) => void>();
let metricDisposers: Array<() => void> = [];

/** Install callbacks only for the presently adopted real-workspace generation. */
function armCallMetricDrainNudges(): void {
  disarmCallMetricDrainNudges();
  const nudge = callMetricDrain.captureNudge();
  metricDisposers = [
    callMetricLifecycle.onQueued(nudge),
    onApiAuthRenewed(nudge),
    messaging.onTransportOpen(nudge),
  ];
}

/**
 * Establish one metric-drain ownership boundary for a real workspace. The
 * drain increments/activates first, this captures that exact generation, and
 * only then does recovery begin. Keeping this sequence together prevents a
 * finalization from falling between the first due snapshot and its wakeup.
 */
export function activateCallMetricDrainForWorkspace(): Promise<void> {
  disarmCallMetricDrainNudges();
  return callMetricDrain.activate(armCallMetricDrainNudges);
}

/** Capture before the transport await; an old resume may not wake a new world. */
export function resumeCallMetricDrainAfterTransportResume(): void {
  const nudge = callMetricDrain.captureNudge();
  void messaging.resume().then(nudge);
}

/** Old auth/socket callbacks must lose their authority before a workspace changes. */
export function disarmCallMetricDrainNudges(): void {
  for (const dispose of metricDisposers) dispose();
  metricDisposers = [];
}

/**
 * Revoke every call-metric authority owned by the workspace being torn down.
 * Synchronous by design: callers run this before SQLite closes or clears, so
 * no retained wake, retry timer, or lifecycle heartbeat can cross that seam.
 */
export function quiesceCallMetrics(): void {
  disarmCallMetricDrainNudges();
  callMetricDrain.deactivate();
  callMetricLifecycle.deactivate();
}

let current: CallState = idleState();
/** Mirrors the local track state the UI shows. The reducer does not model
 * mute — muting is a device fact, not a protocol one, and the peer learns
 * about it through `call.media` rather than through the state machine. */
let localMedia = {
  muted: false,
  videoEnabled: false,
  speakerOn: false,
  /** Capture starts on the front camera (`startCapture` in Swift). Tracked
   * here because mirroring is a JS prop and the native flip cannot reach it:
   * `switchCamera` swaps the capture DEVICE behind the same `RTCVideoTrack`,
   * so the registry has nothing new to announce and the view is never told. */
  frontCamera: true,
  /** The design in-call notice — "Reduced quality", "Video paused to cool down",
   * "Low Power Mode" — or null, which is the ordinary case. */
  pressureNotice: null as string | null,
  /** The design: the phone is nearly flat. The UI OFFERS voice; nothing switches. */
  offerVoice: false,
  /** The design: tapping the notice would lift the cap (Low Power Mode only — a tap
   * cannot cool a phone down). Drives whether the notice is pressable. */
  pressureRestorable: false,
  /** The design: the tap happened. A fact about THIS call — reset with the rest of
   * this object when the next cid starts, so a phone still in Low Power Mode
   * starts its next call capped again. */
  pressureRestored: false,
  /** `-1` until native has a packet-backed measurement; only 1–3 draw bars. */
  quality: UNKNOWN_CALL_QUALITY as CallQuality,
  qualityStatus: 'checking' as CallQualityStatus,
};

/** Quality polling, live only while a call is connected. */
let qualityTimer: ReturnType<typeof setInterval> | null = null;
let qualityFreshnessTimer: ReturnType<typeof setTimeout> | null = null;
let qualityGeneration = 0;
let qualityAttemptSerial = 0;
type QualityAttempt = {
  generation: number;
  attempt: number;
  cid: string;
  acceptResult: boolean;
  timeout: ReturnType<typeof setTimeout> | null;
};
/** One native getStats request per peer connection at a time. A UI timeout
 * invalidates its answer but does not pretend the native work stopped. */
const qualityInFlight = new Map<string, QualityAttempt>();

/**
 * Sample the connection quality every few seconds while connected.
 *
 * Polled rather than pushed because the indicator is the only consumer and a
 * native timer would keep sampling through a backgrounded call for a view
 * nobody is looking at.
 *
 * The native side returns a LEVEL, never the stats: `getStats` output carries
 * candidate addresses — the other person's IP — and the design forbids that leaving
 * the device. An integer cannot leak one.
 */
const QUALITY_INTERVAL_MS = 3_000;
// A stuck native stats callback makes the display unavailable. It remains the
// sole request for that cid until it actually settles, so getStats calls never
// overlap and mutate native cumulative baselines out of order.
const QUALITY_SAMPLE_TIMEOUT_MS = 5_000;
const QUALITY_INITIAL_WAIT_MS = QUALITY_INTERVAL_MS + QUALITY_SAMPLE_TIMEOUT_MS;
// A once-good measurement is not a permanent statement about the call.
const QUALITY_STALE_MS = 9_000;

function clearQualityFreshnessTimer(): void {
  if (qualityFreshnessTimer) clearTimeout(qualityFreshnessTimer);
  qualityFreshnessTimer = null;
}

function setQualityUnknown(status: Exclude<CallQualityStatus, 'measured'>): void {
  if (
    localMedia.quality === UNKNOWN_CALL_QUALITY &&
    localMedia.qualityStatus === status
  ) {
    return;
  }
  localMedia = {
    ...localMedia,
    quality: UNKNOWN_CALL_QUALITY,
    qualityStatus: status,
  };
  notifyMedia();
}

function armQualityDisplayDeadline(
  generation: number,
  cid: string,
  delay: number,
): void {
  clearQualityFreshnessTimer();
  qualityFreshnessTimer = setTimeout(() => {
    if (
      qualityGeneration !== generation ||
      current.name !== 'connected' ||
      current.call?.cid !== cid
    ) {
      return;
    }
    // The native request still owns this cid until it settles. Only its UI
    // authority expires here, preventing a late answer from reviving stale
    // bars while also preventing overlapping getStats calls.
    const pending = qualityInFlight.get(cid);
    if (pending?.generation === generation) pending.acceptResult = false;
    qualityFreshnessTimer = null;
    setQualityUnknown('unavailable');
  }, delay);
}

function stopQualityPolling(): void {
  if (qualityTimer) clearInterval(qualityTimer);
  qualityTimer = null;
  clearQualityFreshnessTimer();
  qualityGeneration += 1;
}

function retireQualityAttempt(cid: string): void {
  const attempt = qualityInFlight.get(cid);
  if (!attempt) return;
  if (attempt.timeout) clearTimeout(attempt.timeout);
  qualityInFlight.delete(cid);
}

function startQualityPolling(cid: string): void {
  stopQualityPolling();
  const generation = qualityGeneration;
  localMedia = {
    ...localMedia,
    quality: UNKNOWN_CALL_QUALITY,
    qualityStatus: 'checking',
  };
  // This also bounds reconnects waiting behind an older same-cid native
  // request. The request remains serialized, but "Checking" does not remain
  // on screen indefinitely when native never calls back.
  armQualityDisplayDeadline(generation, cid, QUALITY_INITIAL_WAIT_MS);

  const sample = () => {
    if (
      qualityInFlight.has(cid) ||
      qualityGeneration !== generation ||
      current.name !== 'connected' ||
      current.call?.cid !== cid
    ) {
      return;
    }

    const attempt = ++qualityAttemptSerial;
    const request: QualityAttempt = {
      generation,
      attempt,
      cid,
      acceptResult: true,
      timeout: null,
    };
    qualityInFlight.set(cid, request);
    request.timeout = setTimeout(() => {
      if (
        qualityInFlight.get(cid) !== request ||
        request.generation !== generation ||
        request.attempt !== attempt
      ) {
        return;
      }
      request.acceptResult = false;
      request.timeout = null;
      if (
        qualityGeneration !== generation ||
        current.name !== 'connected' ||
        current.call?.cid !== cid
      ) {
        return;
      }
      clearQualityFreshnessTimer();
      setQualityUnknown('unavailable');
    }, QUALITY_SAMPLE_TIMEOUT_MS);

    let nativeSample: Promise<number>;
    try {
      nativeSample = native.sampleQuality(cid);
    } catch (error) {
      nativeSample = Promise.reject(error);
    }
    void nativeSample
      .then(value => {
        if (qualityInFlight.get(cid) !== request) return;
        qualityInFlight.delete(cid);
        if (request.timeout) clearTimeout(request.timeout);
        request.timeout = null;
        if (
          !request.acceptResult ||
          qualityGeneration !== generation ||
          current.name !== 'connected' ||
          current.call?.cid !== cid
        ) {
          return;
        }
        const level = measuredCallQuality(value);
        if (level === null) {
          clearQualityFreshnessTimer();
          setQualityUnknown('unavailable');
          return;
        }

        if (
          level !== localMedia.quality ||
          localMedia.qualityStatus !== 'measured'
        ) {
          localMedia = { ...localMedia, quality: level, qualityStatus: 'measured' };
          notifyMedia();
        }

        armQualityDisplayDeadline(generation, cid, QUALITY_STALE_MS);
      })
      .catch(() => {
        if (qualityInFlight.get(cid) !== request) return;
        qualityInFlight.delete(cid);
        if (request.timeout) clearTimeout(request.timeout);
        request.timeout = null;
        if (
          qualityGeneration !== generation ||
          current.name !== 'connected' ||
          current.call?.cid !== cid
        ) {
          return;
        }
        clearQualityFreshnessTimer();
        setQualityUnknown('unavailable');
      });
  };

  qualityTimer = setInterval(sample, QUALITY_INTERVAL_MS);
}

/**
 * The last thing the device told us about its own headroom.
 *
 * Held outside `localMedia` because it is a fact about the phone rather than
 * about this call: it must survive one call ending and the next beginning, so
 * a call placed on an already-hot device starts capped instead of waiting for
 * a state CHANGE that may never come.
 */
let pressure: PressureInputs = {
  thermal: 'nominal',
  lowPower: false,
  battery: null,
  video: false,
};

function notify(state: CallState): void {
  const previousCid = current.call?.cid ?? null;
  const previousName = current.name;
  const previousVideo = current.call?.video ?? false;
  current = state;
  // A new call starts from a known media state. Without this, a mute toggled
  // in one call was still SHOWN in the next one against a fresh, unmuted
  // track — the UI asserting something about the microphone that was false.
  //
  // Keyed on the CID rather than on leaving idle, because glare
  // replaces one call with another WITHOUT passing through idle: the losing
  // outgoing call is abandoned and the peer's incoming call is adopted in a
  // single transition. On the old test the adopted call inherited the
  // abandoned one's flags, so answering an incoming VIDEO call through glare
  // showed the camera as off — the same false claim, one call later.
  const nextCid = state.call?.cid ?? null;
  if (previousCid !== null && previousCid !== nextCid) {
    // A reconnect keeps the same cid and therefore keeps its native getStats
    // serialization lock. A terminal exit or glare replacement cannot ever
    // use the old peer connection again, so retaining a hung request would
    // leak one map entry per ended call.
    retireQualityAttempt(previousCid);
  }
  if (nextCid !== null && nextCid !== previousCid) {
    const video = state.call?.video === true;
    localMedia = {
      muted: false,
      videoEnabled: video,
      // A video call belongs on the speaker — you are holding the phone away
      // from your face to be seen. This was set as a flag and never acted on,
      // so the UI showed speaker ON while the audio came out of the earpiece.
      speakerOn: video,
      frontCamera: true,
      // Cleared per call: last call's "Video paused to cool down" must not
      // greet the next one. `applyPressure` below re-derives it from the
      // device state, which is deliberately NOT cleared. The restore tap is
      // cleared WITH the notice: it answered for the call it was tapped in.
      pressureNotice: null,
      offerVoice: false,
      pressureRestorable: false,
      pressureRestored: false,
      quality: UNKNOWN_CALL_QUALITY,
      qualityStatus: 'checking',
    };
    if (video && nextCid) {
      // AND THE FLAG ABOVE FOLLOWS THE ROUTE, not the intent. `.catch(() =>
      // undefined)` swallowed a refused bridge call and left `speakerOn: true`
      // standing over an earpiece — a lit button asserting something about
      // the device that was false, which is how the whole class of defect
      // here reaches a person. The group arm already refuses to do this
      // (`setSpeakerEnabled` in group.ts); this is the same rule on this arm.
      //
      // Guarded on the cid for that arm's other reason: a bridge call outlives
      // a hangup, and an unconditional write would darken the NEXT call's
      // button over a route that call took perfectly.
      void native.setSpeaker(nextCid, true).catch(() => {
        if (current.call?.cid !== nextCid) return;
        localMedia = { ...localMedia, speakerOn: false };
        notifyMedia();
      });
    }
    // A call placed on an ALREADY hot or low-power phone must start capped.
    // Waiting for the next thermal notification would mean the one call most
    // likely to overheat the device is the one that runs uncapped.
    if (video) void applyPressure();
  } else if (
    nextCid !== null &&
    previousVideo &&
    state.call?.video === false &&
    localMedia.videoEnabled
  ) {
    // "ANSWER WITHOUT VIDEO" — the same cid, narrowed from a video invite to
    // an audio answer (`acceptIncoming`, §10.3). The reset above is keyed on
    // the cid, so this edge left the mirror saying the camera was ON for a
    // call whose answer never started it: "Turn camera off" over a black
    // preview, Flip camera enabled, and a tap into the audio-call camera
    // toggle. Re-derived here from the call's own video flag; the speaker
    // follows the route, as `switchToVoice` does it — the flag darkens only
    // once the earpiece has actually been asked for and taken.
    localMedia = { ...localMedia, videoEnabled: false };
    void native
      .setSpeaker(nextCid, false)
      .then(() => {
        if (current.call?.cid !== nextCid) return;
        localMedia = { ...localMedia, speakerOn: false };
        notifyMedia();
      })
      .catch(() => undefined);
  }
  // Battery monitoring is not free, so it runs only while a call does. Keyed
  // on entering/leaving idle rather than on the cid, so a glare swap does not
  // stop and restart it.
  if (previousCid === null && nextCid !== null) {
    void native.startMonitoringPressure().catch(() => undefined);
  } else if (previousCid !== null && nextCid === null) {
    void native.stopMonitoringPressure().catch(() => undefined);
  }
  // Sampling starts when media is actually flowing and stops the moment it is
  // not: before `connected` there is nothing to measure, and a timer that
  // outlived the call would poll a peer connection that no longer exists.
  if (state.name === 'connected' && nextCid) {
    if (!qualityTimer) startQualityPolling(nextCid);
    // Re-land the cap now that the peer connection PROVABLY exists. The
    // start-of-call dispatch above fires while the cid is only a reducer
    // fact — the native side builds the connection later, inside the
    // createOffer/createAnswer effect, and a cap arriving before that lands
    // in its silent no-op guard. For an incoming call the whole ring happens
    // in that window, so without this a Low Power phone ANSWERED a video
    // call uncapped and stayed that way. Idempotent, so re-entering
    // connected after a reconnect re-asserting it is fine.
    if (state.call?.video && previousName !== 'connected') void applyPressure();
  } else {
    const hadLiveQualityPolling = qualityTimer !== null;
    stopQualityPolling();
    if (hadLiveQualityPolling) {
      localMedia = {
        ...localMedia,
        quality: UNKNOWN_CALL_QUALITY,
        qualityStatus: 'unavailable',
      };
    }
  }
  for (const s of subscribers) s(state);
}

/**
 * Re-render after a LOCAL media change.
 *
 * `localMedia` lives outside the reducer — mute is a device fact, not a
 * protocol one — so a toggle leaves `CallState` untouched. Handing
 * subscribers the identical object meant `setState` saw the same reference
 * and React bailed out of the render entirely: the mute button, the camera
 * button and the speaker button all changed the tracks and none of them
 * changed the screen. A fresh object is the whole fix.
 */
function notifyMedia(): void {
  const state: CallState =
    current.name === 'idle'
      ? { name: 'idle', call: null }
      : { name: current.name, call: current.call };
  current = state;
  for (const s of subscribers) s(state);
}

export function callController(): CallController {
  if (controller) return controller;
  controller = new CallController({
    messaging,
    native: nativeForController,
    fetchTurnCredentials: async () => {
      const token = await getSecret(AUTH_TOKEN_KEY);
      if (!token) throw new Error('not signed in');
      const { iceServers, ttlSeconds } = await apiTurnCredentials(token);
      return { iceServers, ttlSeconds };
    },
    writeLog: async row => {
      // Two writes, not one: the row is OPENED when the call starts so a crash
      // mid-call still leaves evidence it happened, and closed here.
      // `startCallLog` is a no-op on conflict, so replaying a terminal effect
      // cannot duplicate a row.
      try {
        await db.startCallLog({
          cid: row.cid,
          peerId: row.peerId,
          direction: row.direction,
          kind: row.kind,
          startedAt: row.startedAt,
        });
        await db.endCallLog(row.cid, {
          reason: row.reason,
          connectedAt: row.connectedAt,
          endedAt: row.endedAt,
          missed: row.missed,
        });
      } finally {
        // A missed call on a locked phone used to leave NOTHING: CallKit ends
        // the ring as .unanswered but is excluded from Recents, and the app
        // posted no notification — the person learned of the call only by
        // opening the Calls tab. The row IS the fact; this is its notice —
        // and it is posted WHETHER OR NOT the row could be written, because
        // the phone most likely to miss a call is the locked one, whose
        // workspace refuses the write. The name goes along only when this
        // device actually knows one; '' lets native fall back to the name
        // mirror the ring itself paints from. …and NEVER for a row the
        // controller wrote on a silenced caller's behalf (§10.6, `silenced`):
        // the notice is audible and on the lock screen, so keyed on `missed`
        // alone it let a stranger chime the phone the policy keeps quiet,
        // once per offer.
        if (row.missed && row.direction === 'in' && !row.silenced) {
          const known = await db
            .getChat(row.peerId)
            .then(
              chat =>
                sanitizeDisplayName(chat?.localName) ||
                sanitizeDisplayName(chat?.displayName) ||
                '',
            )
            .catch(() => '');
          void postMissedCallNotice(row.peerId, known);
        }
      }
    },
    // The name CallKit shows on the lock screen.
    //
    // This used to be `personName(peerId)` with no names passed, so it always
    // fell through to `shortId` — every incoming call announced a fragment of
    // a ULID instead of a person. The lock screen is also the ONE place a
    // stranger holding the phone sees it, which makes a raw id the worst of
    // both worlds: unreadable to the owner and an identifier to anyone else.
    //
    // Same precedence as everywhere else (`personName`): the label I gave them
    // here outranks the name they shared, which outranks the short id.
    displayNameFor: async peerId => {
      const chat = await db.getChat(peerId).catch(() => null);
      return personName(peerId, chat?.displayName, chat?.localName);
    },
    mayRing: async peerId => {
      // "Has history" is the existence of a chat row with a message in it —
      // a peer you have actually exchanged something with, not merely one
      // whose id you happen to hold. A row created by an inbound call would
      // otherwise let the second call through on the strength of the first.
      const chat = await db.getChat(peerId).catch(() => null);
      const hasHistory = chat?.lastMessageAt != null;
      return decideRing({
        silenceUnknownCallers,
        hasHistory,
        blocked: messaging.isBlockedLocally(peerId),
      });
    },
    // checked before the camera. Note the naming, which is a trap this
    // codebase sets deliberately (blocking.ts): `isPeerBlocked` means THEIR
    // safety number changed, `isBlockedLocally` means WE blocked them. They
    // need different copy and lead to different places, so they are reported
    // as different reasons rather than collapsed into "refused".
    mayCall: async peerId => {
      if (messaging.isBlockedLocally(peerId)) {
        return { allowed: false, reason: 'blocked' };
      }
      if (messaging.isPeerBlocked(peerId)) {
        return { allowed: false, reason: 'identity_changed' };
      }
      return { allowed: true };
    },
    // Read per call rather than captured, so toggling the setting takes effect
    // on the next call instead of the next app launch.
    relayOnly: () => alwaysRelay,
    // the per-person half — and the reason the app can say "the first
    // call with someone new is relayed" and mean it. `relayForPeer` is pure
    // and was already tested; everything below is the facts it needs, read
    // from the state that already exists rather than from a table invented to
    // hold them.
    //
    // `hasCalledBefore` is a CONNECTED call in the log, never merely a row —
    // see `hasConnectedCallWith`, where the difference is a stranger's
    // unanswered ring being able to downgrade the next call to direct.
    //
    // Both reads fail toward relaying: an unreadable log reads as "never
    // called" and an unreadable memory as "nothing remembered", which lands on
    // the first-call default. Failing the other way would mean a database
    // hiccup quietly discloses an address.
    relayForPeer: async peerId => {
      const [remembered, hasCalledBefore] = await Promise.all([
        db.getPeerRelayPref(peerId).catch(() => null),
        db.hasConnectedCallWith(peerId).catch(() => false),
      ]);
      return relayForPeer({ global: alwaysRelay, remembered, hasCalledBefore });
    },
    now: () => Date.now(),
    // The live track state, for the restart answer that speaks for a camera it
    // has no news of (see `localMedia` in CallControllerDeps). Read per frame,
    // never captured: `localMedia` is REPLACED on every toggle, so a captured
    // value would be the same staleness this exists to correct, one layer
    // down. It is the object `localMediaState()` publishes.
    localMedia: () => localMedia,
    mintReportId: () => nextMsgId(),
    metrics: callMetricLifecycle,
    onStateChange: notify,
    // The durable ringing offer. Straight through to SQLite: the
    // controller stays testable without a database, and the database stays
    // ignorant of call state.
    saveOffer: offer => db.saveCallOffer(offer),
    takeOffer: cid => db.takeCallOffer(cid),
    dropOffer: cid => db.deleteCallOffer(cid),
    // The small-group seam. ONE subscription point, so envelope
    // ordering survives: the coordinator is consulted from inside the
    // controller's serialization queue rather than subscribing on its own.
    groupRouter: groupCall(),
  });
  return controller;
}

// --- small-group calls ---------------------------------

let coordinator: GroupCallCoordinator | null = null;
let groupSubscribers = new Set<(view: GroupCallView | null) => void>();
let groupView: GroupCallView | null = null;

export function groupCall(): GroupCallCoordinator {
  if (coordinator) return coordinator;
  coordinator = new GroupCallCoordinator({
    selfId: () => selfAccountId,
    native: {
      ...native,
      // THE APPLIED VERDICT, passed through rather than
      // manufactured. `setAudioEnabled`/`setVideoEnabled` now answer whether
      // the cid had a live connection whose track was actually changed —
      // `call(cid)` missing is `false` — and the all-or-close-the-leg turns
      // on exactly that answer. The adapter used to convert every resolved
      // promise into `true`, including the shipped silent no-op, so the
      // guarantee existed only in the fake test native: production could
      // report the session muted while one leg's microphone was untouched.
      // A REJECTION is still false: an unreachable bridge has applied nothing.
      setAudioEnabled: (cid, on) =>
        native.setAudioEnabled(cid, on).then(
          applied => applied === true,
          () => false,
        ),
      setVideoEnabled: (cid, on) =>
        native.setVideoEnabled(cid, on).then(
          applied => applied === true,
          () => false,
        ),
      // The in-app Answer's CallKit half for a SESSION (the CXCall is keyed
      // by sid, departure 8): a CXAnswerCallAction against it, so the audio
      // session activates and the WebRTC unit starts under §7.4's manual
      // rule. Total for the same reason `postMissedCallNotice` is.
      answerReportedCall: sid =>
        Promise.resolve()
          .then(() => native.answerReportedCall(sid))
          .catch(() => undefined),
    },
    transport: {
      sendCallEnvelope: (peerId, envelope, opts) =>
        messaging.sendCallEnvelope(peerId, envelope, { urgent: opts.urgent }),
      sendGroupCallEnvelope: (peerId, envelope, opts) =>
        messaging.sendGroupCallEnvelope(peerId, envelope, { urgent: opts.urgent }),
    },
    store: {
      saveSession: row => db.saveCallSession(row),
      loadSession: () => db.loadCallSession(),
      deleteSession: sid => db.deleteCallSession(sid),
      saveOffer: offer => db.saveCallOffer(offer),
      takeOffersForSession: sid => db.takeCallOffersForSession(sid),
      deleteOffersForSession: sid => db.deleteCallOffersForSession(sid),
      writeLog: async row => {
        // Two writes, exactly as the 1:1 path does it: the row is OPENED so a
        // crash mid-call leaves evidence, and closed here. The sessionId is
        // what makes N per-leg rows one call in the room thread.
        await db.startCallLog({
          cid: row.cid,
          peerId: row.peerId,
          direction: row.direction,
          kind: row.kind,
          startedAt: row.startedAt,
          sessionId: row.sessionId,
          roomId: row.roomId,
        });
        await db.endCallLog(row.cid, {
          reason: row.reason,
          connectedAt: row.connectedAt,
          endedAt: row.endedAt,
          missed: row.missed,
        });
      },
    },
    displayNameFor: async peerId => {
      const chat = await db.getChat(peerId).catch(() => null);
      return personName(peerId, chat?.displayName, chat?.localName);
    },
    // The thread header's room-name rule: my rename, else the creator's
    // anchor, trimmed at each step — and refused outright when the stored
    // name is the room's id in disguise, exactly as GroupCallScreen refuses
    // it the header.
    roomNameFor: async roomId => {
      const [chat, group] = await Promise.all([
        db.getChat(roomId).catch(() => null),
        db.getGroup(roomId).catch(() => null),
      ]);
      // The system call UI paints this name: sanitized per layer,
      // the same chokepoint every screen's room label goes through.
      const name =
        sanitizeDisplayName(chat?.localName) || sanitizeDisplayName(group?.name);
      return name === roomId ? '' : name;
    },
    mayCall: async peerId => {
      if (messaging.isBlockedLocally(peerId)) return { allowed: false, reason: 'blocked' };
      if (messaging.isPeerBlocked(peerId)) return { allowed: false, reason: 'identity_changed' };
      return { allowed: true };
    },
    isBlockedLocally: peerId => messaging.isBlockedLocally(peerId),
    // The fold, performed at Add time rather than trusted from a picker
    // that folded once when the call started. The same two reads and the same
    // fold the room thread and the send path act on (`App.tsx`'s candidate
    // list, `messaging.ts`'s fan-out), so the coordinator can never disagree
    // with the room about who is in it — and a room this device cannot read
    // answers null, which the coordinator refuses on.
    roomMembers: async roomId => {
      const group = await db.getGroup(roomId).catch(() => null);
      if (!group) return null;
      const slots = await db.listGroupMemberSlots(roomId).catch(() => null);
      if (!slots) return null;
      return [...foldRoster(group.ownerId, slots).members];
    },
    inDuress: () => session.mode === 'duress',
    // The push placeholder's tombstone lives on the 1:1 controller because a
    // VoIP wake carries a peer and not a session. Without this consult
    // a declined placeholder was followed, seconds later, by the session
    // ringing for the same call.
    takePushDecline: peerId => callController().takePushDecline(peerId),
    // WHICH placeholder a group refusal is ending, for the reason above: the
    // ring is 1:1-shaped even when the call behind it is a session, so the
    // controller is the one owner of the fact.
    ringCidFor: peerId => callController().ringCidFor(peerId),
    // A cancellation no live session claimed. Routed to the controller's
    // decided-cancellation path so a cancelled group ring is filed as
    // .remoteEnded ("they hung up") and not .unanswered ("you ignored them").
    noteRingCancelled: peerId => callController().noteRingCancelled(peerId),
    // asked of the INVITER before a session invite is allowed to ring.
    // Through the controller for the same reason the tombstone above is: the
    // rule is about this device, so one wiring answers both call shapes and
    // there is no second copy of "what counts as known" to drift.
    mayRing: peerId => callController().mayRing(peerId),
    // The two call shapes are one microphone.
    oneToOneBusy: () => callController().state.name !== 'idle',
    ensureCredentials: () => callController().ensureCredentials(),
    // asked of a session's PARTICIPANTS before any of its legs gathers a
    // candidate. Through the controller for the reason `mayRing` above is: the
    // rule is about a person, so one wiring answers both call shapes and there
    // is no second copy of "have I called them before" to drift. The session's
    // answer is the OR over the people on it and it only ratchets up, because
    // `configure` is one knob for N legs — the argument is in `controller.ts`.
    applyRelayPolicy: peerIds => callController().relayForSession(peerIds),
    releaseRelayPolicy: () => callController().releaseSessionRelay(),
    mintId: () => nextMsgId(),
    mintReportId: () => nextMsgId(),
    metrics: callMetricLifecycle,
    now: () => Date.now(),
    delay: ms => new Promise(resolve => setTimeout(resolve, ms)),
    onChange: view => {
      groupView = view;
      for (const s of groupSubscribers) s(view);
    },
  });
  return coordinator;
}

/** This device's account id, set at boot. The coordinator refuses to start a
 * session without one — a roster that omits this device is a loud throw in
 * the pure module, and an empty selfId would produce exactly that. */
let selfAccountId: string | null = null;

export function setSelfAccountId(id: string | null): void {
  selfAccountId = id;
}

/**
 * Re-read who this device is, from the profile row.
 *
 * `startCalling` runs once per process, on a component that never remounts,
 * and on the launch where somebody CREATES an account it runs while there is
 * no profile at all — so the id it read was permanently null. A device in
 * that state could never start a small-group call (`not_registered`), and
 * every inbound `ginvite` returned before admission or dismissal, which is a
 * phone that silently cannot be called into a room.
 *
 * So registration says so, exactly as it already tells the push registration
 * (`uploadPushTokens`) and messaging (`messaging.start`) — three live modules
 * that each learned the account exists at the same moment, by being told.
 * Exported and idempotent; a real unlock calls it too, because the database
 * is closed behind the lock screen and the boot read can only fail there.
 */
export async function refreshSelfAccountId(): Promise<string | null> {
  const profile = await db.loadProfile().catch(() => null);
  setSelfAccountId(profile?.userId ?? null);
  return selfAccountId;
}

/**
 * The same question, asked from the one place that has to ask it BEFORE a
 * verdict exists — and asked no wider than that place needs.
 *
 * WHY IT CANNOT WAIT FOR THE UNLOCK. `restoreLocked` returns at
 * `if (!selfId)`: without this string the coordinator cannot tell which member
 * of the persisted roster is this phone, refuses to rebuild, and the press
 * falls through to the 1:1 controller — which looks for a `call_offers` row
 * keyed by the SID, finds none (legs carry their own cids) and releases the
 * CXCall as `failed_media`. That is the whole small-group cold-answer feature
 * dying silently, on the arm it exists for, so this read is part of the ring
 * path and not part of the workspace phase.
 *
 * NARROW IN THREE WAYS, because the leak it is next door to is real:
 *
 *  - It is reached only from `callKitNamesSession`, and only once a persisted
 *    session row has already MATCHED the cid the press names. No press, or a
 *    press for anything else, and nothing is read.
 *  - It reads one column of one row (`loadSelfAccountIdForRing`), not the
 *    profile projection, which stays behind the latch.
 *  - It does not overwrite an id a verdict already established.
 *
 * AND IT DOES NOT OUTLIVE THE VERDICT. `selfAccountId` is a process-lifetime
 * latch, so a real owner's ULID learned here would otherwise survive into a
 * coerced session; `adoptWorkspaceForCalling` runs on BOTH unlock arms and
 * re-reads it from whichever workspace was actually chosen, which is what
 * makes that safe rather than merely unlikely.
 */
async function learnSelfIdForRingService(): Promise<void> {
  if (selfAccountId) return;
  setSelfAccountId(await db.loadSelfAccountIdForRing().catch(() => null));
}

/**
 * Release the small-group coordinator: the roster, the leg services, the
 * armed re-offer timers and the paced send chain.
 *
 * The quiesce seams call this beside `messaging.stop()` — relock, account
 * deletion, and the teardown `startCalling` returns. Without it a session
 * survived a workspace switch: a re-offer timer could fire after a duress
 * unlock and reach native media creation ahead of the transport's refusal,
 * and a later real account inherited stale busy state and pending signalling.
 *
 * The 1:1 half of the same rule is `endCallOnQuiesce` below — see there for
 * why the two halves act differently (the session is DEMOLISHED, the 1:1 call
 * is HUNG UP) and why that difference is the whole design.
 */
export function disposeGroupCall(): void {
  coordinator?.dispose();
}

/**
 * End a live 1:1 call because the app is quiescing — relock, account
 * deletion. The 1:1 twin of `disposeGroupCall`, and the callers are the same
 * seams; every `messaging.stop();` must have this in front of it (the scan in
 * `App.relockcall.test.tsx`, the `disposeGroupCall` scan's sibling).
 *
 * THE DECISION THIS ENCODES (settling the incoherence the
 * previous revision of this file documented as open): a relock ENDS a live
 * 1:1 call rather than trying to carry it across the lock. Three reasons, in
 * order of force:
 *
 *  1. RELOCK KILLS THE SIGNALLING PATH, UNCONDITIONALLY. The relock order is
 *     `messaging.stop() → db.close() → LockScreen`, and its quiesce is
 *     what makes the next verdict — which may open the DECOY — safe. A call
 *     without signalling cannot be hung up in a way its peer will hear,
 *     cannot ICE-restart (the restart frame is FATAL_TO_SEND, so the first
 *     network wobble ends the call anyway, 30 s late), and cannot hear the
 *     peer's own end — the person talks to nobody until a timeout. Keeping
 *     the call up would mean keeping a REAL session's socket alive behind
 *     the lock screen, which rule 14 exists to forbid.
 *  2. DURESS. The lock screen's next verdict can be a coerced unlock (rules
 *     15/16). A surviving call is a live microphone transmitting to a real
 *     peer while the decoy is open, and a CXCall in the system UI naming a
 *     REAL contact over a workspace that claims none exists. Ending the call
 *     at relock is what PRESERVES duress semantics; any keep-alive weakens
 *     them.
 *  3. THE TWIN ALREADY DECIDED. The group session dies at every quiesce seam
 *     (repeatedly reviewed), and the standing doctrine is "the
 *     two shapes are one microphone". One rule, both shapes.
 *
 * HUNG UP, NOT DISPOSED — the asymmetry with `disposeGroupCall` is the
 * point. The session's abrupt seam demolishes because its danger is work
 * that starts NEW media after the lock (armed re-offer timers) and its
 * announce would be an unawaitable N-peer paced fan-out. A 1:1 call has one
 * peer and a reducer whose terminal funnel already does everything the seam
 * needs: announce `call.end`, cancel timers, close the peer connection,
 * release the CXCall, write the log row. Dispatching `localHangup` through
 * the controller runs exactly that, which is why the caller must run this
 * BEFORE `messaging.stop()` (the announce must be composed while the
 * transport still accepts it — the socket is even still open, because the
 * background path deliberately kept it up for the call) and before
 * `db.close()` (the log row). If the flush loses the race with the stop, the
 * frame is already in the outbox and goes out on the next real unlock; the
 * peer's own reconnect timeout bounds their wait either way, because the
 * peer connection closes here and now.
 *
 * The known sharp edge, accepted eyes-open: a call answered from the lock
 * screen and still live when the person next opens the app past their
 * autolock is ended by that relock. Today that call became a zombie instead
 * (live media, dead signalling); a clean end the person can immediately
 * redial is the honest version, and deferring the relock to spare the call
 * would let anyone who can keep a call alive keep the workspace unlocked.
 *
 * Reads the module-level `controller` rather than calling `callController()`:
 * a quiesce seam must never CONSTRUCT the machinery it exists to stop. Total:
 * a hangup that fails must not stop the relock behind it.
 */
export async function endCallOnQuiesce(): Promise<void> {
  if (!controller || controller.state.name === 'idle') return;
  await controller.hangup().catch(() => undefined);
}

/**
 * Start a small-group call. `others` excludes this device; the cap is
 * `call.ts`'s to enforce and is asked, never re-derived here.
 */
export async function startGroupCall(
  others: readonly string[],
  video: boolean,
  roomId: string | null = null,
): Promise<string> {
  return groupCall().startGroupCall(others, video, roomId);
}

/** Subscribe a component to the live session. */
export function useGroupCallState(): GroupCallView | null {
  const [state, setState] = useState<GroupCallView | null>(groupView);
  useEffect(() => {
    groupSubscribers.add(setState);
    setState(groupView);
    return () => {
      groupSubscribers.delete(setState);
    };
  }, []);
  return state;
}

export function groupCallView(): GroupCallView | null {
  return groupView;
}

/** Whether a CallKit round trip names the live session. A session reports
 * itself under its `sid`; a 1:1 call under its cid. There is no overlap and
 * no native mapping change (departure 8). */
function groupCallAddresses(id: string): boolean {
  return groupView?.sid === id;
}

/**
 * HOW a CallKit round trip names a session — live in memory, or persisted by
 * a process this answer is about to replace.
 *
 * THE COLD LAUNCH IS THE WHOLE POINT. Answering from the lock screen after
 * iOS killed the app starts the process, so `groupView` is null and the
 * in-memory check above cannot be true — which sent every cold session answer
 * to the 1:1 controller, where it looked for a `call_offers` row keyed by the
 * sid, found none (legs use their own cids) and released the CXCall as
 * `failed_media`. The coordinator's whole tested restore path was unreachable
 * in production, and the one situation it exists for was the one situation
 * that could not reach it.
 *
 * Asked of SQLite, which is where a killed process leaves a session, and only
 * when memory does not already know: one row read, on a path that already
 * awaits several.
 *
 * A BOOLEAN WAS NOT ENOUGH. A persisted match names the cold session whose
 * button was pressed; the live re-check may instead name a usurper installed
 * under the same remotely reusable sid while SQLite was pending. The handler
 * needs that distinction to drop A's stale press without releasing B's native
 * aggregate through the ordinary 1:1 cleanup path.
 *
 * AND WHATEVER THIS ANSWERS IS A SNAPSHOT. It is read here and used one or
 * more awaits later, by which time the live session it saw may have torn down
 * — leaving a press with nothing group-shaped behind it at all. So this
 * answers only whether the coordinator is worth asking; it is not ownership,
 * and nothing downstream may release a native call on the strength of it
 * alone (`onCallKitAnswer`/`onCallKitEnd` re-prove that where they use it).
 */
async function callKitNamesSession(
  id: string,
): Promise<GroupCallKitSessionEvidence | null> {
  if (groupCallAddresses(id)) return 'live';
  // NEWEST-THEN-COMPARE, AND THAT IS THE WIDEST POINT OF THE PRE-VERDICT DOOR.
  // This line runs for every CallKit press there is — answers, declines, 1:1
  // cids, synthetic push placeholders — so a press about a different call
  // still pulls the newest session's roomId, starterId and full ROSTER into
  // the process before any verdict exists. A `WHERE sid = ?` read would make a
  // press that names no session of ours read nothing, and it is the right
  // shape; it is not applied here because `call.group.test.ts` gates its
  // classification-suspension harness on this statement's literal text, and
  // that file is not this lane's to move. Written down rather than left
  // implied — the boundary comment on `conn` states this width out loud.
  const row = await db.loadCallSession().catch(() => null);
  if (row?.sid === id) {
    await learnSelfIdForRingService();
    return 'persisted';
  }
  // RE-CHECK AFTER SQLITE. A cold lookup can honestly find no row while a
  // fresh same-sid ring installs in memory. The ticket below still decides
  // whether that identity is the one whose button was pressed.
  return groupCallAddresses(id) ? 'live' : null;
}

/**
 * Mute/camera across every leg — all-or-close-the-leg.
 *
 * RETURNS THE PER-LEG OUTCOME, because the screen has to say which people a
 * toggle dropped and inferring that from the live set shrinking blames any
 * hangup or ICE failure that lands in the same window. Empty when there is no
 * session: nothing was fanned, so nothing was dropped.
 */
export async function toggleGroupMute(): Promise<LegFanOutcome[]> {
  const view = groupView;
  if (!view) return [];
  return groupCall().setMuted(!view.muted);
}

/**
 * The device's output route for the session — NOT a fan (`setSpeakerEnabled`).
 *
 * Returns nothing per leg because it drops nobody: the speaker is one route
 * for the whole device, so there is no leg a failure could be about and no
 * `LegFanOutcome[]` that would not be a fiction.
 */
export async function toggleGroupSpeaker(): Promise<void> {
  const view = groupView;
  if (!view) return;
  await groupCall().setSpeakerEnabled(!view.speakerOn);
}

/** The design. Persisted by the settings surface; defaulted off here so a missing
 * preference never silently forces every call through the relay. */
let alwaysRelay = false;

/**
 * Where the app-wide switch is written down.
 *
 * The Keychain, like read receipts, push consent and screen security, and NOT
 * the database — for the same two reasons those give: it must survive a
 * workspace wipe, and it must not live in the decoy file where a duress
 * session could read or change it. The per-PEER memory goes the other way
 * (`call_relay_prefs` in db.ts) precisely because it names people.
 *
 * Kept in this module rather than a `relayPolicy.ts` beside `readReceipts.ts`
 * because the value alone is not the setting: turning it on has to reach the
 * native module NOW (`applyRelayPolicy`), and that lives here.
 */
const ALWAYS_RELAY_KEY = 'tacendum.alwaysRelay';

/** Synchronous, because the settings row renders from it and the controller
 * consults it on the path of a call. */
export function alwaysRelayEnabled(): boolean {
  return alwaysRelay;
}

/**
 * Re-read the persisted choice. Called at init and on every REAL unlock, the
 * `loadReadReceipts` rule: a duress session's value must never bleed into a
 * real one.
 *
 * A failed read fails to OFF, which is the opposite of how read receipts and
 * push consent fail, and deliberately: those default on and a storage hiccup
 * leaving them on costs nothing, while a hiccup silently forcing every call
 * through the relay would degrade every call on the phone with no visible
 * cause. The first-call default still protects the case that matters — this
 * only decides what happens to calls with people already spoken to.
 */
export async function loadAlwaysRelay(): Promise<void> {
  try {
    alwaysRelay = (await getSecret(ALWAYS_RELAY_KEY)) === '1';
  } catch {
    alwaysRelay = false;
  }
}

/**
 * A duress session shows the DEFAULT, not the owner's real choice — the
 * `resetReadReceiptsForDuress` rule.
 *
 * It costs nothing under duress: the decoy workspace has no call history, so
 * every peer reads as never-called and the first-call default relays anyway.
 */
export function resetAlwaysRelayForDuress(): void {
  alwaysRelay = false;
}

export async function setAlwaysRelay(on: boolean): Promise<void> {
  alwaysRelay = on;
  // A COERCED TAP MOVES THE ROW AND NOTHING ELSE — the `setReadReceipts`
  // rule, placed above the native apply as well as the write because neither
  // is a thing a session opened with the reversed code may do to the owner's
  // phone. The in-memory value moved first, so the chip is indistinguishable
  // from a real session's (rule 16), and `loadAlwaysRelay` re-reads the
  // Keychain on every REAL unlock.
  if (session.mode === 'duress') return;
  // Applied NOW, not at the next credential refresh — which could be hours
  // away, during which the setting would be on and doing nothing.
  void callController().applyRelayPolicy();
  // Written AFTER the in-memory value and the native apply, so a Keychain
  // failure cannot leave the switch looking on while the calls go direct.
  // The reverse — a live setting that fails to persist — costs the person the
  // preference at next launch and nothing while they are using the app.
  await setSecret(ALWAYS_RELAY_KEY, on ? '1' : '0');
}

/**
 * default ON.
 *
 * Defaulted here rather than read lazily, so a failure to load the setting
 * leaves the phone QUIETER than intended rather than louder. Getting this
 * fallback backwards would mean a storage error silently opens the phone to
 * anyone holding the id.
 */
let silenceUnknownCallers = true;

/**
 * Where the setting is written down — the Keychain, for the three reasons
 * `ALWAYS_RELAY_KEY` gives: it must survive a workspace wipe, it must not sit
 * in the decoy file where a coerced session could read or change it, and it is
 * a fact about this phone rather than about any person, so it names nobody.
 */
const SILENCE_UNKNOWN_KEY = 'tacendum.silenceUnknownCallers';

/** Synchronous, because the settings row renders from it and `mayRing`
 * consults it on the path of an incoming call. */
export function silenceUnknownCallersEnabled(): boolean {
  return silenceUnknownCallers;
}

/**
 * Re-read the persisted choice: at init and on every REAL unlock, the
 * `loadAlwaysRelay` rule, so a duress session's value never bleeds into a real
 * one.
 *
 * **A FAILED READ FAILS TO ON — the opposite of `loadAlwaysRelay`, and the
 * asymmetry is the whole point.** Note the test: `!== '0'`, not `=== '1'`.
 * Only an explicit stored "off" turns this off; an absent value, an
 * unreadable Keychain, a locked device, a truncated string and a garbage
 * string all land on ON.
 *
 * The relay switch fails to OFF because a storage hiccup silently forcing
 * every call through a relay would degrade every call on the phone with no
 * visible cause, and the first-call default still guards the address. This one
 * has no such backstop and its two failures are not comparable, which
 * `decideRing` argues at length: silencing wrongly leaves a missed-call row
 * the person can see and return at a time they choose, while ringing wrongly
 * is a stranger who holds your id making the phone go off at 3am. One costs a
 * delayed call back; the other cannot be taken back. When the storage layer
 * cannot say what was chosen, the phone stays quiet.
 */
export async function loadSilenceUnknownCallers(): Promise<void> {
  try {
    silenceUnknownCallers = (await getSecret(SILENCE_UNKNOWN_KEY)) !== '0';
  } catch {
    silenceUnknownCallers = true;
  }
}

/**
 * A duress session shows the DEFAULT, never the owner's real choice — the
 * `resetAlwaysRelayForDuress` rule.
 *
 * The default is also the quiet one, so this costs nothing under coercion: a
 * decoy workspace has no message history, every caller in it is therefore
 * unknown, and a phone that does not ring during a coerced unlock reveals
 * nothing about who might have been calling.
 */
export function resetSilenceUnknownCallersForDuress(): void {
  silenceUnknownCallers = true;
}

export async function setSilenceUnknownCallers(on: boolean): Promise<void> {
  // In memory first, Keychain second, `setAlwaysRelay`'s ordering: a failed
  // write costs the preference at the next launch and nothing while the app is
  // open, where the reverse would leave the row showing a setting that is not
  // the one deciding whether the phone rings.
  silenceUnknownCallers = on;
  // A COERCED TAP MOVES THE ROW AND WRITES NOTHING — the `setAlwaysRelay`
  // rule. Turning this off is the one of the six that opens the owner's phone
  // to anyone holding their id, and it would hold until they noticed.
  if (session.mode === 'duress') return;
  await setSecret(SILENCE_UNKNOWN_KEY, on ? '1' : '0');
}

/**
 * Start calling: subscribe to envelopes, register for VoIP wakes, and route
 * native events into the controller.
 *
 * Safe to call more than once — `start()` is idempotent and the native
 * subscriptions are torn down first.
 */
export async function startCalling(): Promise<() => void> {
  const c = callController();
  const subs = [
    // Routed by cid: a session leg's candidates belong to that leg's service,
    // which owns its own batching window and its own 40-candidate budget. The
    // coordinator answers whether it claimed the event; everything it did not
    // claim reaches the 1:1 controller exactly as it always has.
    native.events.iceCandidate(e => {
      const candidate = { cand: e.cand, mid: e.mid, idx: e.idx };
      if (groupCall().onLocalIceCandidate(e.cid, candidate)) return;
      // WITH ITS CID. A candidate a dead group leg gathers late is not
      // claimed above and must not be queued under whatever 1:1 call is
      // live; the controller drops anything not naming its own call.
      c.onLocalIceCandidate(candidate, e.cid);
    }),
    native.events.iceState(e =>
      void groupCall()
        .onIceStateChanged(e.cid, e.state)
        .then(claimed => (claimed ? undefined : c.onIceStateChanged(e.cid, e.state))),
    ),
    // The cid is forwarded, not dropped: CallKit can hold a call this reducer
    // knows nothing about, and answering or ending blindly would act on
    // whichever unrelated call happens to be live.
    // The CXCall is keyed by `sid` for a session (departure 8), so the answer
    // comes back carrying it and the coordinator claims it; a 1:1 cid does not
    // match any session and falls through unchanged.
    native.events.callKitAnswer(e => {
      const cid = e.cid;
      // SYNCHRONOUSLY, BEFORE SQLITE. A cold lookup can wait while a fresh
      // ring reuses the dead one's remotely minted sid; reading the ring after
      // that await attributes the old green button to the new microphone.
      // Keep the issuing coordinator too: a ticket is meaningful only to the
      // private ledger that made it.
      const group = cid ? groupCall() : null;
      const ticket = group?.captureCallKitPress() ?? null;
      void (async () => {
        if (cid && group && ticket) {
          const evidence = await callKitNamesSession(cid);
          if (evidence !== null) {
            const result = await group.onCallKitAnswer(cid, ticket, evidence);
            // A claimed press already acted, and a stale press belongs to the
            // group sheet that disappeared. Only a captured non-owner may open
            // an ordinary 1:1 microphone.
            if (result !== 'not-ours') return;
          }
        }
        await c.onCallKitAnswer(cid);
      })();
    }),
    native.events.callKitEnd(e => {
      const cid = e.cid;
      // The red button is the same press-identity question. Without this
      // snapshot, A's End can be classified after B's same-sid ring went up
      // and tear B down before anybody has touched its controls.
      const group = cid ? groupCall() : null;
      const ticket = group?.captureCallKitPress() ?? null;
      void (async () => {
        if (cid && group && ticket) {
          const evidence = await callKitNamesSession(cid);
          if (evidence !== null) {
            const result = await group.onCallKitEnd(cid, ticket, evidence);
            // A claimed press already acted, and a stale press belongs to the
            // dead group sheet. Only a captured non-owner may release a 1:1 call.
            if (result !== 'not-ours') return;
          }
        }
        await c.onCallKitEnd(cid);
      })();
    }),
    // The system mute button. Emitted since V5 and subscribed by nothing, so
    // the lock screen and dynamic island showed MUTED while the audio track
    // kept transmitting — the user believing their microphone was off is the
    // worst version of this bug, which is why it is a privacy fix and not a
    // UI one.
    native.events.callKitMute(e => {
      // A SESSION's CXCall is keyed by its sid (departure 8), which is not a
      // leg cid and never will be: handing it to `setAudioEnabled` muted
      // nothing at all while CallKit, the dynamic island and this module's
      // own state all showed muted — every leg still transmitting. The
      // session mutes through its own fan-out, where all-or-close-the-leg
      // decides what to do with a leg that cannot be silenced.
      if (e.cid && groupCallAddresses(e.cid)) {
        void groupCall().setMuted(e.muted);
        return;
      }
      void applyMute(e.muted);
    }),
    // THE ROUTE, RE-ASSERTED AT THE FIRST MOMENT IT CAN MEAN ANYTHING.
    // The speaker is asked for when the call first gets a cid — during the
    // ring, long before CallKit activates a session — and the native side
    // stores that desire and applies it inside `didActivate`. This event IS
    // that activation reaching JS (it had no subscriber here before), so a
    // lit speaker button is re-asserted against the now-active session: a
    // request lost between the cid-mint and activation (a refused bridge
    // call, a module still warming) gets one more honest chance. In the
    // ORDINARY case — the desire arrived and `didActivate` just applied it —
    // the native side swallows this repeat without touching the session
    // (`setSpeaker`'s carries-route guard), because a route write landing in
    // the same instant the audio unit starts is the multi-writer race the
    // activation ordering exists to remove; a wedged unit's recovery belongs
    // to the native start-failure re-kick, not to this call. The event
    // carries no cid (one audio session per device, not per call — see the
    // module's event table), so a stale activation outliving a hangup is
    // attributed to the CURRENT call: harmless, since a video call wants
    // the very route this re-asserts and a voice call skips it below. Only
    // when the button claims the LOUDSPEAKER: a voice call's earpiece is
    // the category default and asks for nothing
    // (`call.audio.route.test.ts`, "asks for nothing at all on a voice
    // call"), and a session call keeps its own arm (`group.ts`'s
    // `setSpeakerEnabled`) — `current.call` is null there. The refusal rule
    // is `toggleSpeaker`'s: the flag follows the ROUTE, so a refused
    // re-assert darkens the button rather than letting it stand over an
    // earpiece.
    native.events.callKitAudioActivated(() => {
      const cid = current.call?.cid ?? null;
      if (!cid || !localMedia.speakerOn) return;
      void native.setSpeaker(cid, true).catch(() => {
        if (current.call?.cid !== cid) return;
        localMedia = { ...localMedia, speakerOn: false };
        notifyMedia();
      });
    }),
    // A VoIP wake means an envelope is on its way over the socket; CallKit is
    // already ringing by the time this fires, so there is nothing to
    // do but make sure credentials are warm before the offer lands.
    // The design. Declared in the spec since V5 and emitted by nothing until now, so
    // the whole thermal table was unreachable: a phone could cook itself
    // through a 720p call and the app would never notice.
    native.events.devicePressure(e => {
      // Low Power Mode coming back ON is the owner asking AGAIN, and the new
      // request outranks a restore tap that answered the previous episode —
      // otherwise one tap disables the design for the rest of the call no matter
      // how many times the owner re-asserts the mode.
      if (e.lowPower && !pressure.lowPower && localMedia.pressureRestored) {
        localMedia = { ...localMedia, pressureRestored: false };
      }
      pressure = { ...pressure, thermal: e.state, lowPower: e.lowPower, battery: e.battery };
      void applyPressure();
    }),
    native.events.voipPush(e => {
      // The controller must know WHICH synthetic cid rang for WHOM, or a
      // decline of the placeholder cannot be matched to the offer that
      // decrypts behind it.
      // …and WHICH placeholder is actually ringing (`ringCid`), which on a
      // second push for a peer already ringing is the FIRST ring's cid and not
      // `e.cid`. A dismissal tagged with the throwaway would match nothing.
      c.notePushRing(e.cid, e.from, e.ringCid);
      void c.ensureCredentials();
      // THE LINE THAT MAKES EVERY COLD-RING FIX REAL. Backgrounding pauses
      // the socket — that is what makes pushes exist at all — and a VoIP
      // wake runs entirely in the background, where the AppState 'active'
      // resume never fires. Without this, the offer that carries the name,
      // the video flag and the real cid NEVER DECRYPTS while the phone
      // rings: the rebind, the name correction, the video upgrade and the
      // cancel-dismiss were all dead code in the field. resume() no-ops
      // unless a real session paused it, so a push cannot un-silence duress
      // or a never-started session.
      void messaging.resume();
    }),
    // The token the server wakes this device with. Registering for pushes
    // produces it; without SENDING it, a call to a backgrounded, locked or
    // terminated phone never rings — the whole PushKit path is inert, and
    // nothing reports an error because nothing is wrong locally.
    native.events.voipTokenUpdated(() => void uploadPushTokens()),
    // The alert token can arrive after the VoIP one, so a change re-registers
    // the pair rather than waiting for the next launch. Without this, message
    // notifications would not work until the app was opened twice.
    native.events.alertTokenUpdated(() => void uploadPushTokens()),
  ];
  // NOTHING BELOW THIS LINE MAY TOUCH SQLITE OR OUR SERVER, and the reason is
  // the whole point of `adoptWorkspaceForCalling` (below).
  //
  // This function runs from a mount effect in App.tsx that is declared — and
  // therefore runs — BEFORE the effect that reads the lock verdict, and it
  // runs synchronously up to its first await. So on a cold start behind the
  // lock screen, every line here executes while no verdict exists. The db
  // module's `closedLatch` is false in a fresh process and its workspace
  // defaults to 'real', so a single db call was enough to LAZILY OPEN
  // `tacendum.sqlite` and write to it: the reconcile and the two prunes did
  // exactly that, the profile read latched the real owner's ULID into
  // `selfAccountId` for the life of the process (surviving into a duress
  // session, which then identified this device as the real owner), and
  // `uploadPushTokens` put the real account's bearer token on the wire —
  // before anyone had proved they were that person, and on the duress arm
  // before the decoy file was so much as opened.
  //
  // What stays here is the RING PATH, and it stays deliberately: the
  // subscriptions above, `c.start()` (which registers for VoIP wakes), the
  // pending-event flush and the notification prompt. None of them opens a
  // workspace or calls us, and gating any of them behind an unlock would be a
  // denial of ring — a call to a locked, backgrounded or terminated phone
  // would stop arriving at all.
  //
  // THE TWO TOKEN LISTENERS ABOVE ARE THE EXCEPTION THAT PROVES IT. They DO
  // call us, and they fire from right here: `c.start()` sets PushKit's
  // `desiredPushTypes`, and iOS answers `didUpdatePushCredentials`
  // immediately — from cache, on a phone that has had a token for months — so
  // `voipTokenUpdated` lands during this very function on every launch, duress
  // launches included. They are not delayed or removed (either would be a
  // denial of ring); `uploadPushTokens` itself refuses until a verdict has
  // said which world this is, and `adoptPushRegistration` replays whatever
  // arrived in the meantime. See the guard at the top of `uploadPushTokens`.

  // §6.6: BACKGROUNDING A VIDEO CALL TELLS THE PEER. iOS interrupts the
  // capture session in the background; the encoder stops and the far decoder
  // holds the last frame, so without this the other person watched a still
  // image under "Connected" with no camera-off cue. The track is disabled
  // (so the peer's own view gets the muted-track signal too), the peer is
  // told, and the camera comes back on return — only if it was on when the
  // app left, and only for the SAME call.
  const appState = AppState.addEventListener('change', next => {
    void onAppStateForCall(next);
  });
  await c.start();
  // AFTER every subscription above and after `start()`, because this releases
  // whatever CallKit raised before JS existed — and on a cold launch from a
  // lock-screen answer, that includes the answer itself. Flushing earlier
  // would emit into listeners that are not attached yet, which is the drop
  // this call exists to prevent.
  await native.flushPendingEvents().catch(() => undefined);

  // Ask before registering for remote notifications: the registration yields a
  // token whether or not the person agreed, and a token with no permission
  // produces a push that arrives and shows nothing. A refusal is fine —
  // messages still arrive over the socket while the app is open, which is
  // exactly the behaviour before any of this existed.
  await native.requestNotificationPermission().catch(() => 'denied');
  return () => {
    clearAlertRetry();
    // The metric heartbeat is a 30-second `setInterval` that WRITES SQLITE, so
    // it has to die with the session that armed it: a timer outliving its
    // teardown reaches whatever workspace the next verdict declares.
    quiesceCallMetrics();
    for (const s of subs) s.remove();
    appState.remove();
    videoPausedForBackground = null;
    const stoppedCid = current.call?.cid ?? null;
    stopQualityPolling();
    if (stoppedCid) retireQualityAttempt(stoppedCid);
    localMedia = {
      ...localMedia,
      quality: UNKNOWN_CALL_QUALITY,
      qualityStatus: 'unavailable',
    };
    c.stop();
    // The session goes with the controller. `c.stop()` disposes the 1:1
    // service; a coordinator left holding N leg services, a live roster and
    // armed re-offer timers after its subscriptions are gone is a call
    // nothing can drive and nothing can end.
    disposeGroupCall();
  };
}

/**
 * The half of calling startup that needs a WORKSPACE, run once a verdict has
 * chosen which one.
 *
 * WHY THIS IS A SEPARATE PHASE. `startCalling` runs from a mount effect, which
 * is to say before the lock screen has been answered — before the app knows
 * whether this is the owner or somebody standing over them. Everything here
 * reads or writes a database file, and none of it can be done honestly without
 * that answer. Left in `startCalling` it was done anyway, against
 * `tacendum.sqlite`: the reconcile and the two prunes wrote to the real
 * workspace behind the lock screen, and the profile read latched the real
 * owner's ULID into `selfAccountId` for the life of the process.
 *
 * NO `real` FLAG, and its absence is the design. Every step here belongs to
 * WHICHEVER workspace opened:
 *
 *  - The reconcile and the two prunes. A decoy that never reconciles its own
 *    crashed call rows would show a call still in progress that ended days
 *    ago — the exact bug these calls exist to fix, reintroduced on the arm
 *    nobody looks at.
 *  - `refreshSelfAccountId`, so a duress session re-reads the DECOY's id.
 *    `selfAccountId` is a process-lifetime latch with no production reset
 *    path, and the ring path can set it BEFORE any verdict
 *    (`learnSelfIdForRingService`); this line is what stops the real owner's
 *    ULID outliving the verdict and naming this device to a coerced session's
 *    coordinator.
 *
 * The one genuinely real-arm-only act — telling our server this device's push
 * tokens — is NOT here. It has no workspace to wait for and it must survive
 * everything in this function failing, so it lives in `adoptPushRegistration`
 * and is called earlier and separately; see there.
 *
 * Never throws: every step swallows its own failure. A workspace that cannot
 * be tidied is a degraded session, not a failed unlock, and this runs inside
 * unlock paths whose catch blocks mean something else entirely.
 */
export async function adoptWorkspaceForCalling(): Promise<void> {
  // Close out any call left `active` by a crash or a force-quit. The
  // row was opened when the call started precisely so evidence survives, but
  // nothing had ever closed those rows: `reconcileActiveCalls` existed and was
  // called only by its own test, so a crashed call stayed "active" forever and
  // the thread showed a call still in progress that had ended days ago.
  //
  // Dated from `lastSeenAt` rather than now, so the duration is honest about
  // when the device was last known to be in the call.
  await db.reconcileActiveCalls(Date.now()).catch(() => undefined);
  // Offers whose call can no longer be answered. Not merely tidiness: the row
  // holds an SDP, so an expired one is a DTLS fingerprint and a set of
  // candidate addresses kept for no reason.
  await db.pruneCallOffers(Date.now()).catch(() => undefined);
  // Small-group calls: `pruneCallOffers`'s sibling. A
  // session row names who was on a call with whom, and nothing else would
  // ever remove one left by a crash. Bounded by the ring TTL rather than by a
  // policy of ours: a row younger than that could still belong to a ring the
  // system is showing right now and a lock-screen answer is about to restore,
  // and anything older is residue by definition.
  await db.pruneCallSessions(Date.now() - OFFER_TTL_MS).catch(() => undefined);
  // WHO THIS DEVICE IS. The coordinator refuses to start or join a session
  // without it — a roster that omits this device is a loud throw in the pure
  // module — and it is read here rather than captured at import time because
  // registration can complete after the module is first evaluated. It can also
  // complete AFTER this line, on the launch that creates the account, which
  // is why `refreshSelfAccountId` is exported and called again from there.
  await refreshSelfAccountId();
}

/**
 * THE VERDICT, TOLD TO THE PUSH PATH — and the only gate `uploadPushTokens`
 * has that can tell a real session from a launch that has not answered the
 * lock screen yet.
 *
 * WHY A LATCH AND NOT `session.mode`. `session.mode` initializes to 'real'
 * (src/session.ts), so before a verdict it is indistinguishable from a real
 * one and `api.ts`'s duress refusal — the one place all ten REST callers pass
 * through — cannot fire. `pushTokensAllowed()` is likewise an in-memory
 * default of true, and the bearer token comes from the KEYCHAIN, which no
 * workspace latch touches. So on every launch, including a duress launch, the
 * real account's bearer went out from a mount effect before anybody had
 * proved anything: `c.start()` sets `desiredPushTypes` and PushKit answers
 * `didUpdatePushCredentials` immediately, including out of its cache, which
 * fires `voipTokenUpdated` and with it `uploadPushTokens`. This latch starts
 * false and is the only thing that turns it on.
 *
 * CALLED EARLY, FROM BOTH ARMS, AND OUT OF THE WAY OF EVERY FALLIBLE STEP.
 * `enterRealWorkspace` runs eight or so awaited Keychain and file steps before
 * it opens a workspace, and any throw among them lands in a catch that heals
 * accounts. Hanging the registration off the far side of those meant a single
 * unrelated failure left the device with NO push token for the entire launch —
 * a phone that silently stops ringing, which is a denial of ring at one
 * remove. So this runs as soon as the verdict is known, and the workspace
 * phase can fail without taking the ring with it.
 *
 * AFTER `loadPushConsent()`, THOUGH, AND THAT ORDER IS LOAD-BEARING: consent
 * defaults to allowed in memory, so registering before the persisted choice is
 * re-read would silently re-upload a row the owner had withdrawn — a
 * withdrawal that undoes itself is worse than none.
 */
let pushRegistrationAdopted = false;

export function adoptPushRegistration(opts: { real: boolean }): void {
  pushRegistrationAdopted = opts.real;
  if (!opts.real) return;
  // Six polls, five seconds apart, armed fresh per session: far past any APNs
  // round trip, bounded so a denied permission does not poll forever.
  alertRetriesLeft = ALERT_RETRY_BUDGET;
  // The registry may already hold a token from a previous launch, in which
  // case `voipTokenUpdated` never fires again and waiting for it would mean
  // the device is only reachable after iOS happens to rotate it. So whichever
  // tokens exist by now go up — including the ones whose events arrived while
  // this latch was still false, which is the ordinary case on every launch.
  void uploadPushTokens();
}

/**
 * Send this device's push tokens to the server.
 *
 * EXPORTED, and called from two places, because one is not enough. It runs
 * from `adoptPushRegistration`, which happens once per real verdict — and on
 * the launch where someone CREATES an account,
 * the auth token does not exist yet at that moment. The notification prompt is
 * modal, so it is necessarily answered before "Get started" is reachable, and
 * both tokens land within a second of it; the auth token is written later, by
 * registration. So every attempt on that launch returns at `if (!auth)`,
 * nothing re-triggers, and a brand-new account has no push registration until
 * the app is force-quit and relaunched.
 *
 * That is exactly the state two fresh installs are in, which is to say exactly
 * the state this was being tested from.
 *
 * `env` must match the APNs host the token belongs to. A DEBUG build talks to
 * the sandbox host; a Release build talks to production. Getting this wrong
 * sends every push to the wrong host, where it fails silently — the phone
 * simply does not ring and no error is raised anywhere.
 *
 * Failures are swallowed on purpose: an unreachable server means this device
 * cannot be woken, which is a degraded state, not a reason to break a session
 * that otherwise works. It retries on the next launch and on any token
 * rotation.
 */
/**
 * Retry while the ALERT token has not arrived yet.
 *
 * `requestNotificationPermission` resolves the moment the person answers the
 * prompt, but the token itself needs a round trip to APNs and lands a second
 * or two later. The first registration therefore routinely goes up with the
 * VoIP token alone — which is a row that can ring calls and banner nothing.
 * The `alertTokenUpdated` event is supposed to close that gap, and polling is
 * the belt over it: the DynamoDB rows from the device run showed voip-yes
 * alert-NO on both phones, which is exactly what a missed event leaves
 * behind, permanently, because every launch replays the same race.
 */
let alertRetryTimer: ReturnType<typeof setTimeout> | null = null;
/** Named so session init and `restorePushTokens` cannot drift apart. */
const ALERT_RETRY_BUDGET = 6;
let alertRetriesLeft = 0;

function armAlertRetry(): void {
  if (alertRetryTimer) return;
  if (alertRetriesLeft <= 0) return;
  alertRetryTimer = setTimeout(() => {
    alertRetryTimer = null;
    alertRetriesLeft -= 1;
    void uploadPushTokens();
  }, 5_000);
}

/**
 * A fresh, small retry budget for a fresh moment — foregrounding.
 *
 * The launch-time budget exists for the token race; this exists for the
 * NETWORK. The first device run showed the exact sequence: token issued,
 * polling picked it up, and the PUT died because the phone was falling off
 * Wi-Fi onto weak LTE mid-launch — after which nothing retried until the
 * next launch. Foregrounding is the natural moment to try again: the person
 * is looking at the phone, which usually means the network is back.
 */
export function nudgePushRegistration(): void {
  alertRetriesLeft = Math.max(alertRetriesLeft, 2);
  void uploadPushTokens();
}

/**
 * Cleared when calling stops, so a test render cannot leak a live timer.
 *
 * THE BUDGET GOES WITH THE TIMER, and dropping only the timer was a hole.
 * Every call site of `uploadPushTokens` is `void uploadPushTokens()`, so a PUT
 * is routinely still on the wire when the session that started it ends — a
 * relock, an unmount, a fresh verdict. Its catch calls `armAlertRetry`, which
 * is gated on `alertRetriesLeft` alone; with the budget left at six, a
 * teardown that had just cleared the pending timer got a NEW one armed
 * underneath it moments later, and five more behind that: thirty seconds of
 * registrations carrying the ended session's bearer token, into whatever
 * workspace the next verdict had since declared. It also outlived a jest
 * environment, where the resumed upload reads `Platform.OS` through
 * react-native's lazy index getter and throws an unhandled "import after
 * teardown" — a red CI check with no failing test in it.
 *
 * Zeroing here is not permanent: every legitimate re-arm restores the budget
 * before it uploads — `adoptPushRegistration` (a fresh real verdict) and
 * `restorePushTokens` (consent restored) to the full six,
 * `nudgePushRegistration` (foregrounding) to at least two.
 */
function clearAlertRetry(): void {
  alertRetriesLeft = 0;
  if (alertRetryTimer) {
    clearTimeout(alertRetryTimer);
    alertRetryTimer = null;
  }
}

export async function uploadPushTokens(): Promise<void> {
  // NO VERDICT, NO REGISTRATION — checked HERE rather than at the two token
  // listeners, for the reason `api.ts` gives about its own duress guard: this
  // is the one place every caller passes through, and a rule repeated at each
  // caller is a rule someone eventually forgets. There are six callers, two of
  // which fire from a mount effect before the lock screen has been answered.
  //
  // FIRST, before the token reads, so a pre-verdict attempt cannot spend the
  // alert-retry budget that a real session is about to need.
  //
  // Nothing is lost by refusing: `adoptPushRegistration` re-reads whatever
  // tokens exist the moment a real verdict lands, so the ordinary launch
  // registers exactly as before — one PUT, a few hundred milliseconds later.
  if (!pushRegistrationAdopted) {
    if (
      typeof jest === 'undefined' &&
      typeof __DEV__ !== 'undefined' &&
      __DEV__
    ) {
      console.log('[push] withheld — no unlock verdict yet');
    }
    return;
  }
  // BOTH tokens are read here, and EITHER is enough to register.
  //
  // This used to take the VoIP token as an argument and return early when it
  // was empty — which made the alert token hostage to it. PushKit and
  // UNUserNotificationCenter issue independently and either can be missing:
  // decline the notification prompt and there is no alert token, and a
  // registry that has not produced VoIP credentials yet gives no VoIP one.
  // With the old guard, a device that had an alert token and no VoIP token
  // registered NOTHING, so message notifications could never arrive. That is
  // exactly what the empty push-token table showed.
  const [voipToken, alertToken, bundleId] = await Promise.all([
    native.getVoipToken().catch(() => ''),
    native.getAlertToken().catch(() => ''),
    native.bundleId().catch(() => ''),
  ]);
  // Presence only, never the values: a device token is the capability to push
  // to that phone, and a console log is not a place to put one. Dev-only,
  // because on a device build this is the ONLY visible evidence of a path
  // where every single failure is swallowed by design — the registration
  // catch below, `registerForVoipPush().catch()`, and
  // `didFailToRegisterForRemoteNotificationsWithError`, which sets an empty
  // token and says nothing. Debugging that from the outside means reading an
  // empty DynamoDB table and guessing which of the three it was.
  const trace = (stage: string, extra = '') => {
    // Silent under jest: the upload settles asynchronously and a console.log
    // that lands after a test's teardown fails the whole suite. The device
    // diagnostics this exists for have no test to fail.
    if (typeof jest !== 'undefined') return;
    if (typeof __DEV__ !== 'undefined' && __DEV__) {
      console.log(
        `[push] ${stage} voip=${voipToken ? 'yes' : 'NO'} alert=${alertToken ? 'yes' : 'NO'}${extra}`,
      );
    }
  };

  if (!alertToken) {
    // Arm the poll BEFORE any early return below: the whole point is to run
    // again once APNs has answered, whatever this attempt manages.
    armAlertRetry();
  }
  if (!voipToken && !alertToken) {
    trace('nothing to register');
    return;
  }
  // Withdrawn consent. Checked HERE, after the tokens are
  // read but before anything is sent, and deliberately not earlier: the trace
  // above is the only diagnostic this path has on a device, and losing it
  // would make "withdrawn" indistinguishable from "APNs never answered".
  //
  // This is the guard that makes withdrawal stick. Without it the next
  // launch, the next foreground nudge, or the armed alert retry would
  // silently re-upload the row the person just deleted — a withdrawal that
  // undoes itself is worse than none, because they would believe it held.
  if (!pushTokensAllowed()) {
    trace('withheld — push tokens turned off');
    return;
  }

  try {
    const auth = await getSecret(AUTH_TOKEN_KEY);
    if (!auth) {
      trace('no auth token');
      return;
    }
    if (Platform.OS === 'android') {
      // Android has ONE token — the FCM registration
      // token, which `getVoipToken` and `getAlertToken` both answer with
      // (`PushTokenStore`), so `voipToken || alertToken` is the same string
      // read twice, not a preference between two. The wire shape is the
      // union's Android branch: `platform: 'android'`, one `fcmToken`, no
      // `env` (FCM has no sandbox/production split — see
      // `apiRegisterFcmToken`, the integration point). Everything that
      // GUARDS this line — the `pushRegistrationAdopted` latch above, the
      // consent check, the retry arming — is shared with iOS untouched: the
      // latch neither knows nor cares which transport the token names. On a
      // build without Firebase wired the getters answer `''` forever, so
      // this line is unreachable there and no registration is ever sent —
      // pre-FCM truth, preserved by construction.
      await apiRegisterFcmToken(auth, bundleId, voipToken || alertToken);
      trace('registered', ' platform=android');
    } else {
      const env: 'sandbox' | 'production' =
        typeof __DEV__ !== 'undefined' && __DEV__ ? 'sandbox' : 'production';
      await apiRegisterPushToken(auth, bundleId, voipToken, env, alertToken);
      trace('registered', ` env=${env}`);
    }
  } catch (err) {
    // Degraded, not broken — but RETRIED. This used to re-arm only when the
    // alert token was missing, so the worst case slipped through: token in
    // hand, upload dead on a flapping network, and nothing tried again until
    // the next launch. A failed registration is exactly as unregistered as a
    // missing token.
    armAlertRetry();
    trace(
      'registration failed',
      ` err=${err instanceof Error ? err.message : 'unknown'}`,
    );
  }
}

/**
 * Withdraw this device's push tokens from the server.
 *
 * Three things in one act, and the order matters:
 *
 * 1. **Record the choice first.** If the delete fails, the person has still
 *    withdrawn — the next upload is suppressed either way, and the row lapses
 *    on its own TTL. Doing this last would leave a failed delete looking like
 *    a successful one that silently re-uploaded on the next launch.
 * 2. **Cancel any armed retry.** `armAlertRetry` may already be holding a
 *    timer that would call `uploadPushTokens` in five seconds. The guard
 *    inside that function would now refuse, but cancelling is cheaper and
 *    leaves no timer running for a decision already made.
 * 3. **Delete the row.** Throws on failure, so the caller can say the token
 *    is still there rather than claiming a withdrawal that did not happen.
 */
export async function withdrawPushTokens(): Promise<void> {
  await setPushTokensAllowed(false);
  // A COERCED TAP STOPS HERE, and this is the sharpest of the six duress
  // guards. The line above moved a session-scoped shadow and nothing else
  // (pushConsent.ts), so what remains below is the part that would reach the
  // owner: the delete carries their bearer token, and `api.ts` refuses every
  // duress request with a network error — which is what made this row a
  // one-tap discriminator. A real session's tap succeeds silently; a coerced
  // one raised `COPY.pushFailed` every single time. Returning before the
  // network is what makes the two renders the same.
  if (session.mode === 'duress') return;
  if (alertRetryTimer) {
    clearTimeout(alertRetryTimer);
    alertRetryTimer = null;
  }
  alertRetriesLeft = 0;

  const auth = await getSecret(AUTH_TOKEN_KEY);
  // No session, nothing on the server to delete that we could name. The
  // preference is written regardless, which is the part that must hold.
  if (!auth) return;
  await apiDeletePushToken(auth);
}

/**
 * Re-allow push tokens and register immediately, so the switch takes effect
 * while the person is still looking at it rather than at next launch.
 */
export async function restorePushTokens(): Promise<void> {
  await setPushTokensAllowed(true);
  // The other half of the guard in `withdrawPushTokens`, and belt over
  // braces: `uploadPushTokens` already refuses without a real verdict, but on
  // a RELOCK into duress that latch is still true from the real session that
  // just ended — the window `adoptPushRegistration({ real: false })` exists
  // to close. Refusing here as well means a coerced tap cannot spend the
  // retry budget or put the owner's bearer on the wire under either reading.
  if (session.mode === 'duress') return;
  alertRetriesLeft = ALERT_RETRY_BUDGET;
  await uploadPushTokens();
}

/**
 * The missed-call notification, and its clearing (§10.4's "the person
 * learns of the call" half). Threaded by peer so the thread and the Calls
 * tab can clear exactly the notices they answer. Total: a module without the
 * method (an older binary under a newer JS bundle) or a refused post costs
 * the notice, never the row or the call.
 */
function postMissedCallNotice(peerId: string, name: string): Promise<void> {
  return Promise.resolve()
    .then(() => missedCallBridge.post(peerId, name))
    .catch(() => undefined);
}

export function clearMissedCallNotices(peerId: string | null): Promise<void> {
  return Promise.resolve()
    .then(() => missedCallBridge.clear(peerId ?? ''))
    .catch(() => undefined);
}

/**
 * The two module calls behind the notices, behind one object — a test seam
 * in the `subscribeForTests` family. `import * as native` is a per-importer
 * copy under the RN babel preset, so a method planted on the mock from a
 * test never reaches this file; a spy on this object's properties does.
 */
export const missedCallBridge = {
  post: (peerId: string, displayName: string): Promise<void> =>
    native.postMissedCall(peerId, displayName),
  clear: (peerId: string): Promise<void> => native.clearMissedCall(peerId),
};

/** Local track state, mirrored for the UI. */
export function localMediaState(): typeof localMedia {
  return localMedia;
}

/**
 * Tell the peer which of our tracks are live (the design `call.media`).
 *
 * Their UI is written against `peerAudio`/`peerVideo` and nothing was ever
 * sending this, so those two flags never moved: turning your camera off left
 * the other person watching a frozen last frame with no indication you had
 * stopped, and muting showed them nothing at all.
 *
 * Not urgent, and failure is swallowed: it is a courtesy about track state,
 * not part of the call's liveness, and a call must not end because one of
 * these did not go out.
 */
/**
 * Apply the decision to the live call.
 *
 * Called whenever the device reports new pressure AND whenever a call starts,
 * because the two orders are equally likely: a phone can get hot mid-call, or
 * a call can be placed on a phone that is already hot.
 *
 * The video track is only forced OFF, never back on. Restoring it would undo
 * a user who turned their own camera off while the phone happened to be warm.
 * When the thermal state recovers the cap lifts and the person can turn the
 * camera back on themselves — which is also what "never auto-restore without
 * a user tap" asks for.
 */
async function applyPressure(): Promise<void> {
  const call = current.call;
  if (!call) return;
  const decision = decidePressure({
    ...pressure,
    video: call.video,
    restored: localMedia.pressureRestored,
  });

  await native
    .applyVideoCap(call.cid, decision.maxLongEdge ?? 0, decision.maxFps ?? 0)
    .catch(() => undefined);

  // The await above suspends across the bridge, and the call this decision
  // was made FOR can end there — glare swaps A for B without passing through
  // idle. The continuation below writes to the CURRENT call's media state,
  // so a stale decision must stop here or call A's "critical" turns call B's
  // camera off. Same guard the quality sampler uses on its cid.
  if (current.call?.cid !== call.cid) return;

  if (!decision.videoAllowed) {
    // Level-triggered against the native track, NOT edge-triggered on
    // localMedia. The ring-time disable lands on a peer connection that
    // does not exist yet (createOffer/createAnswer builds it later), and
    // the answer then starts the camera ENABLED — so if the flag going
    // false could satisfy this branch once and forever, the connected
    // re-apply would skip the disable and the camera would transmit behind
    // a UI, a notice, and a peer-facing call.media that all say video is
    // off. Re-issuing against a live, already-disabled track is a no-op.
    const firstDisable = localMedia.videoEnabled;
    localMedia = { ...localMedia, videoEnabled: false };
    await native.setVideoEnabled(call.cid, false).catch(() => undefined);
    // Suspended again — re-check the call is still the one decided for.
    if (current.call?.cid !== call.cid) return;
    // The peer is told ONCE, on the edge, or they watch a frozen frame and
    // conclude the call has broken rather than that a phone got hot.
    if (firstDisable) announceMedia();
  }

  if (
    decision.notice !== localMedia.pressureNotice ||
    decision.offerVoice !== localMedia.offerVoice ||
    decision.restorable !== localMedia.pressureRestorable
  ) {
    localMedia = {
      ...localMedia,
      pressureNotice: decision.notice,
      offerVoice: decision.offerVoice,
      pressureRestorable: decision.restorable,
    };
  }
  notifyMedia();
}

/**
 * The restore tap: lift the Low Power cap for the rest of THIS call.
 *
 * Routed back through `applyPressure` rather than uncapping directly, so the
 * decision stays where the rest of the design lives — a phone that is ALSO hot
 * stays capped, because the policy ranks heat above the tap.
 */
export async function restoreVideoQuality(): Promise<void> {
  if (!current.call) return;
  localMedia = { ...localMedia, pressureRestored: true };
  await applyPressure();
}

function announceMedia(): void {
  const call = current.call;
  if (!call) return;
  void callController()
    .sendMedia(call.peerId, call.cid, !localMedia.muted, localMedia.videoEnabled)
    .catch(() => undefined);
}

export type CallMediaControlResult = 'applied' | 'refused' | 'stale';

let muteOperation = 0;
let videoOperation = 0;

export function toggleMute(): Promise<CallMediaControlResult> {
  return applyMute(!localMedia.muted);
}

/**
 * Mute or unmute the live 1:1 call, HONOURING THE NATIVE VERDICT.
 *
 * `setAudioEnabled` answers whether a track was actually changed, and this
 * used to ignore it: the flag flipped, `call.media{a:false}` went out, the
 * lock screen and the button said muted — and a microphone that had no track
 * yet (the CallKit Mute tapped right after answering a video call, inside
 * the camera-enumeration window before `addLocalMedia` finishes) kept
 * transmitting the moment the track was installed — the worst failure a
 * call can have.
 *
 * Two outcomes for a `false`:
 *  - the call is CONNECTED, so a track exists and the change genuinely
 *    failed: nothing is claimed — the flag stays where it was and no
 *    announce goes out.
 *  - the call is not connected yet: the track is not born. The INTENT is
 *    kept (so CallKit and the button agree with what the person asked) and
 *    `reapplyMediaIntent` lands it on the track the moment `createOffer` /
 *    `createAnswer` resolves — the wrapped native below is what makes that
 *    moment observable here.
 */
async function applyMute(muted: boolean): Promise<CallMediaControlResult> {
  const cid = current.call?.cid;
  if (!cid) return 'stale';
  const operation = ++muteOperation;
  const applied = await native.setAudioEnabled(cid, !muted).catch(() => false);
  if (current.call?.cid !== cid || operation !== muteOperation) return 'stale';
  // Once this call has ever connected, its audio track has been born.
  // Reconnecting is therefore not the pre-track intent window: a false
  // verdict there means mute was not applied to the live track and must not
  // be presented or announced as though it were.
  if (!applied && current.call.connectedAt != null) return 'refused';
  localMedia = { ...localMedia, muted };
  announceMedia();
  notifyMedia();
  return 'applied';
}

export async function toggleVideo(): Promise<CallMediaControlResult> {
  const cid = current.call?.cid;
  if (!cid) return 'stale';
  const operation = ++videoOperation;
  const next = !localMedia.videoEnabled;
  // THE VERDICT, HONOURED (the group arm already does). An audio call
  // negotiated no video m-line and has no local video track; `false` here
  // means nothing changed, and claiming otherwise showed an opaque black
  // preview locally and sent `call.media{v:true}` — which turned the PEER's
  // whole screen into a black video surface with no track behind it.
  const applied = await native.setVideoEnabled(cid, next).catch(() => false);
  if (current.call?.cid !== cid || operation !== videoOperation) return 'stale';
  if (!applied) return 'refused';
  localMedia = { ...localMedia, videoEnabled: next };
  announceMedia();
  notifyMedia();
  return 'applied';
}

/**
 * Land the stored mute / camera intent on a track that has just been born.
 *
 * Called by the wrapped native's `createOffer` / `createAnswer` once they
 * resolve — the first moment `addLocalMedia` has run. Level-triggered
 * against the native track (the `applyPressure` rule): re-issuing against a
 * track already in that state is a no-op, so this is safe to call for every
 * offer and answer, restarts included.
 */
function reapplyMediaIntent(cid: string): void {
  if (current.call?.cid !== cid) return;
  if (localMedia.muted) {
    void native.setAudioEnabled(cid, false).catch(() => undefined);
  }
  if (current.call.video && !localMedia.videoEnabled) {
    void native.setVideoEnabled(cid, false).catch(() => undefined);
  }
}

/**
 * The call's media surface, as the controller sees it: the module, with the
 * two calls that BIRTH a track wrapped so `reapplyMediaIntent` runs the
 * moment they resolve. Nothing else is changed — every other method is the
 * module's own, by reference.
 */
const nativeForController: typeof native = {
  ...native,
  createOffer: async (cid, withVideo) => {
    const sdp = await native.createOffer(cid, withVideo);
    reapplyMediaIntent(cid);
    return sdp;
  },
  createAnswer: async (cid, remoteOfferSdp, withVideo) => {
    const sdp = await native.createAnswer(cid, remoteOfferSdp, withVideo);
    reapplyMediaIntent(cid);
    return sdp;
  },
};

/** What the camera was doing when the app left the foreground, for the
 * call it was doing it in — or null. */
let videoPausedForBackground: { cid: string } | null = null;

async function onAppStateForCall(next: AppStateStatus): Promise<void> {
  const call = current.call;
  if (next === 'background' || next === 'inactive') {
    if (!call || !localMedia.videoEnabled || videoPausedForBackground) return;
    videoPausedForBackground = { cid: call.cid };
    localMedia = { ...localMedia, videoEnabled: false };
    await native.setVideoEnabled(call.cid, false).catch(() => undefined);
    if (current.call?.cid !== call.cid) return;
    announceMedia();
    notifyMedia();
    return;
  }
  if (next !== 'active') return;
  const paused = videoPausedForBackground;
  videoPausedForBackground = null;
  // Restored only for the call that was paused, and only if it is still
  // live: a call that ended in the background has nothing to restore, and
  // the NEXT call starts from its own reset.
  if (!paused || !call || call.cid !== paused.cid) return;
  const applied = await native.setVideoEnabled(call.cid, true).catch(() => false);
  if (!applied || current.call?.cid !== call.cid) return;
  localMedia = { ...localMedia, videoEnabled: true };
  announceMedia();
  notifyMedia();
}

/**
 * The device's output route — AFTER the bridge has taken it, never before.
 *
 * `flipCamera`'s ordering, and `setSpeakerEnabled`'s rule in group.ts: the
 * flag was flipped first and the bridge call awaited afterwards, so a refused
 * route left the button lit over an earpiece. `App.tsx` calls this as
 * `void toggleSpeaker()`, which means the rejection reached nobody either —
 * the button saying what the device is actually doing is the whole remedy
 * available at this layer.
 */
export async function toggleSpeaker(): Promise<void> {
  const cid = current.call?.cid;
  if (!cid) return;
  const next = !localMedia.speakerOn;
  try {
    await native.setSpeaker(cid, next);
  } catch {
    return;
  }
  // A bridge call outlives a hangup; the next call chose its own route.
  if (current.call?.cid !== cid) return;
  localMedia = { ...localMedia, speakerOn: next };
  // No announce: which SPEAKER this device plays through is nobody else's
  // business and is not part of `call.media`.
  notifyMedia();
}

/**
 * Drop a video call to voice (the low-battery offer).
 *
 * Turns off the local camera and tells the peer; it does NOT renegotiate the
 * m-line away. A voice call that keeps a negotiated but idle video track costs
 * nothing measurable, and renegotiating mid-call to save a few milliwatts
 * risks the connection this is trying to preserve.
 */
export async function switchToVoice(): Promise<void> {
  const cid = current.call?.cid;
  if (!cid || !localMedia.videoEnabled) return;
  localMedia = { ...localMedia, videoEnabled: false };
  await native.setVideoEnabled(cid, false).catch(() => undefined);
  // `speakerOn` follows the route here too: dropping to voice ASKS for the
  // earpiece, and a refused ask must leave the button saying loudspeaker,
  // because that is where the call is still coming out of.
  const earpiece = await native
    .setSpeaker(cid, false)
    .then(() => true)
    .catch(() => false);
  if (earpiece && current.call?.cid === cid) {
    localMedia = { ...localMedia, speakerOn: false };
  }
  announceMedia();
  notifyMedia();
}

export async function flipCamera(): Promise<void> {
  const cid = current.call?.cid;
  if (!cid) return;
  await native.switchCamera(cid);
  if (current.call?.cid !== cid) return;
  // After the native call, so a failed flip does not leave the preview
  // mirrored the wrong way round for a camera that never changed.
  localMedia = { ...localMedia, frontCamera: !localMedia.frontCamera };
  notifyMedia();
}

/**
 * Answer the ringing 1:1 call, asking for permissions FIRST (§7.5).
 *
 * The outgoing paths have always asked at the moment of the call; the accept
 * handlers called `accept()` directly, so a first-ever call that was incoming
 * put the system mic/camera prompts over the connecting screen — after
 * `didActivate` had fired, whose audio-unit start then failed under the
 * prompt. A denied camera degrades to an audio answer, exactly as a denied
 * camera degrades a dial; a denied microphone cannot proceed, and the honest
 * answer to the caller is a decline rather than a silent call.
 */
export async function acceptIncomingCall(
  withVideo: boolean,
): Promise<{ ok: boolean; video: boolean; reason?: string }> {
  const c = callController();
  const permission = await ensurePermissions(withVideo);
  // The ring can end under the prompt — the caller cancels, the ring times
  // out. Nothing to accept then, and nothing to decline either.
  if (c.state.name !== 'incoming_ringing') return permission;
  if (!permission.ok) {
    await c.decline().catch(() => undefined);
    return permission;
  }
  await c.accept(permission.video ? undefined : { video: false });
  return permission;
}

/**
 * Whether a video answer can be offered right now: the camera has not been
 * REFUSED. "Undetermined" still counts — `acceptIncomingCall` asks at the
 * tap, exactly as a dial does. An unavailable status read keeps the audio
 * answer available without advertising an unknown video capability.
 */
export async function cameraAvailableForAnswer(): Promise<boolean> {
  return native
    .cameraPermission()
    .then(state => state !== 'denied')
    .catch(() => false);
}

/**
 * Ask for permissions at the moment of the call, never at launch.
 *
 * A denied camera downgrades to audio rather than refusing: an audio call is
 * still a call. A denied microphone genuinely cannot proceed, and the caller
 * is told which one is missing rather than "permission denied".
 */
export async function ensurePermissions(video: boolean): Promise<{ ok: boolean; video: boolean; reason?: string }> {
  const result = await native.requestPermissions(video);
  if (result.mic !== 'granted') {
    return { ok: false, video: false, reason: 'Microphone access is off. Turn it on in Settings to make calls.' };
  }
  return { ok: true, video: video && result.camera === 'granted' };
}

/** Subscribe a component to call state. */
export function useCallState(): CallState {
  const [state, setState] = useState<CallState>(current);
  useEffect(() => {
    subscribers.add(setState);
    setState(current);
    return () => {
      subscribers.delete(setState);
    };
  }, []);
  return state;
}

/** Test seam: subscribe without a React tree. Returns an unsubscribe. */
export function subscribeForTests(fn: (state: CallState) => void): () => void {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}

/** Test seam: the object subscribers were last handed, for identity checks. */
export function currentStateForTests(): CallState {
  return current;
}

/** Test seam: drop the singleton so a suite can build a fresh one. */
export function resetCallingForTests(): void {
  clearAlertRetry();
  controller?.stop();
  controller = null;
  subscribers = new Set();
  current = idleState();
  stopQualityPolling();
  for (const attempt of qualityInFlight.values()) {
    if (attempt.timeout) clearTimeout(attempt.timeout);
  }
  qualityInFlight.clear();
  coordinator?.dispose();
  coordinator = null;
  groupSubscribers = new Set();
  groupView = null;
  selfAccountId = null;
  // Back to what a launched process holds: no verdict yet, so no registration.
  // A suite that leaked this from a previous case would be asserting about a
  // gate that was already open, which is the state this whole latch exists to
  // stop production being in.
  pushRegistrationAdopted = false;
  videoPausedForBackground = null;
  localMedia = {
    muted: false,
    videoEnabled: false,
    speakerOn: false,
    frontCamera: true,
    pressureNotice: null,
    offerVoice: false,
    pressureRestorable: false,
    pressureRestored: false,
    quality: UNKNOWN_CALL_QUALITY,
    qualityStatus: 'checking',
  };
  pressure = { thermal: 'nominal', lowPower: false, battery: null, video: false };
  alwaysRelay = false;
  silenceUnknownCallers = true;
}
