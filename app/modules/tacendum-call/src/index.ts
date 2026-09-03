import { z } from 'zod';
import type { IceCandidate, IceServer } from '@tacendum/shared';
import NativeTacendumCall from './NativeTacendumCall';
export { default as TacendumVideoView } from './TacendumVideoViewNativeComponent';

/**
 * Typed JS surface over the calling module.
 *
 * This file only validates JSON crossing the bridge. It performs no media
 * work, holds no call state, and makes no decisions — the reducer decides and
 * `CallService` executes. Keeping it this thin is what lets the state machine
 * be tested without a simulator.
 *
 * Every payload is parsed rather than cast. A native event is untrusted input
 * in the ordinary engineering sense: it crosses a language boundary, it can
 * arrive after teardown, and a malformed one should surface as a rejected
 * parse at the seam rather than as `undefined` three frames later.
 */

// --- event payloads ---------------------------------------------------------

const CidEvent = z.object({ cid: z.string().min(1) });

const IceStateEvent = z.object({
  cid: z.string().min(1),
  state: z.enum(['new', 'checking', 'connected', 'completed', 'disconnected', 'failed', 'closed']),
});
export type IceStateEvent = z.infer<typeof IceStateEvent>;

const IceCandidateEvent = z.object({
  cid: z.string().min(1),
  cand: z.string().min(1),
  mid: z.string(),
  idx: z.number().int().nonnegative(),
});
export type IceCandidateEvent = z.infer<typeof IceCandidateEvent>;

const ConnectionStateEvent = z.object({
  cid: z.string().min(1),
  state: z.enum(['new', 'connecting', 'connected', 'disconnected', 'failed', 'closed']),
});
export type ConnectionStateEvent = z.infer<typeof ConnectionStateEvent>;

const TrackEvent = z.object({
  cid: z.string().min(1),
  kind: z.enum(['audio', 'video']),
});
export type TrackEvent = z.infer<typeof TrackEvent>;

const CallKitEndEvent = z.object({
  cid: z.string().min(1),
  /** CallKit's own reason, mapped to a CallEndReason by the caller. */
  reason: z.string(),
});
export type CallKitEndEvent = z.infer<typeof CallKitEndEvent>;

const CallKitMuteEvent = z.object({ cid: z.string().min(1), muted: z.boolean() });
export type CallKitMuteEvent = z.infer<typeof CallKitMuteEvent>;

const VoipPushEvent = z.object({
  cid: z.string().min(1),
  from: z.string().min(1),
  /**
   * The cid of the placeholder actually ringing for `from`, `''` when none is.
   *
   * `.default('')` IS the backward safety for a JS build running ahead of the
   * binary: an older native omits the key entirely and the event still parses.
   * `.min(1)` here would drop every push from such a build — a phone that
   * stops ringing, which is the worst failure this file has.
   */
  ringCid: z.string().default(''),
});
export type VoipPushEvent = z.infer<typeof VoipPushEvent>;

const AudioRouteEvent = z.object({ route: z.string(), speaker: z.boolean() });
export type AudioRouteEvent = z.infer<typeof AudioRouteEvent>;

/**
 * Pressure state. `battery` is nullable and that distinction matters: a device that
 * declines to report a level (the Simulator, chiefly) must not be read as a
 * device at 0%, which would offer to drop every call to voice.
 */
const DevicePressureEvent = z.object({
  state: z.enum(['nominal', 'fair', 'serious', 'critical']),
  lowPower: z.boolean(),
  battery: z.number().min(0).max(1).nullable(),
});
export type DevicePressureEvent = z.infer<typeof DevicePressureEvent>;

// --- lifecycle --------------------------------------------------------------

export function configure(iceServers: IceServer[], relayOnly: boolean): Promise<void> {
  return NativeTacendumCall.configure(JSON.stringify(iceServers), relayOnly);
}

export function createOffer(cid: string, withVideo: boolean): Promise<string> {
  return NativeTacendumCall.createOffer(cid, withVideo);
}

export function createAnswer(
  cid: string,
  remoteOfferSdp: string,
  withVideo: boolean,
): Promise<string> {
  return NativeTacendumCall.createAnswer(cid, remoteOfferSdp, withVideo);
}

export function setRemoteAnswer(cid: string, sdp: string): Promise<void> {
  return NativeTacendumCall.setRemoteAnswer(cid, sdp);
}

export function addIceCandidates(cid: string, candidates: IceCandidate[]): Promise<void> {
  return NativeTacendumCall.addIceCandidates(cid, JSON.stringify(candidates));
}

export function restartIce(cid: string): Promise<string> {
  return NativeTacendumCall.restartIce(cid);
}

export function close(cid: string): Promise<void> {
  return NativeTacendumCall.close(cid);
}

// --- media ------------------------------------------------------------------

/** Resolves whether the track was actually changed — see the spec. A cid with
 * no live connection resolves `false` rather than succeeding silently. */
export function setAudioEnabled(cid: string, on: boolean): Promise<boolean> {
  return NativeTacendumCall.setAudioEnabled(cid, on);
}

export function setVideoEnabled(cid: string, on: boolean): Promise<boolean> {
  return NativeTacendumCall.setVideoEnabled(cid, on);
}

export function switchCamera(cid: string): Promise<void> {
  return NativeTacendumCall.switchCamera(cid);
}

export function setSpeaker(cid: string, on: boolean): Promise<void> {
  return NativeTacendumCall.setSpeaker(cid, on);
}

/**
 * Local quality indicator ONLY.
 *
 * The returned JSON contains ICE candidate addresses — the other person's IP.
 * It must never be put in an envelope, a log line, or a metric dimension. The
 * relay design exists so that nothing outside the two devices learns that.
 */
export function getStats(cid: string): Promise<string> {
  return NativeTacendumCall.getStats(cid);
}

// --- CallKit ----------------------------------------------------------------

export function reportOutgoingCall(
  cid: string,
  handle: string,
  video: boolean,
): Promise<void> {
  return NativeTacendumCall.reportOutgoingCall(cid, handle, video);
}

export function reportOutgoingConnected(cid: string): Promise<void> {
  return NativeTacendumCall.reportOutgoingConnected(cid);
}

/** `cid` names the placeholder being dismissed; `''` matches whatever is
 * pending for the peer, which is the pre-cid behaviour. Defaulted so a caller
 * that has nothing to name still compiles and still degrades correctly. */
export function dismissPendingIncomingCall(
  peerId: string,
  reason: string,
  cid = '',
): Promise<void> {
  return NativeTacendumCall.dismissPendingIncomingCall(peerId, reason, cid);
}

export function reportIncomingCall(
  cid: string,
  peerId: string,
  handle: string,
  displayName: string,
  hasVideo: boolean,
): Promise<void> {
  return NativeTacendumCall.reportIncomingCall(cid, peerId, handle, displayName, hasVideo);
}

export function updateIncomingCallDisplay(cid: string, displayName: string): Promise<void> {
  return NativeTacendumCall.updateIncomingCallDisplay(cid, displayName);
}

export function endCall(cid: string, reason: string): Promise<void> {
  return NativeTacendumCall.endCall(cid, reason);
}

/** Answer a reported incoming call from the app's own UI — see the spec. A
 * session passes its sid, which is what its one CXCall is keyed by. */
export function answerReportedCall(cid: string): Promise<void> {
  return NativeTacendumCall.answerReportedCall(cid);
}

// --- missed-call notifications -----------------------------------------------

export function postMissedCall(peerId: string, displayName: string): Promise<void> {
  return NativeTacendumCall.postMissedCall(peerId, displayName);
}

/** `peerId` empty clears every missed-call notice. */
export function clearMissedCall(peerId: string): Promise<void> {
  return NativeTacendumCall.clearMissedCall(peerId);
}

// --- PushKit ----------------------------------------------------------------

export function getVoipToken(): Promise<string> {
  return NativeTacendumCall.getVoipToken();
}

export function registerForVoipPush(): Promise<void> {
  return NativeTacendumCall.registerForVoipPush();
}

/**
 * Tell native that JS listeners are attached; anything CallKit raised first
 * is delivered now.
 *
 * Must be called AFTER every `events.*` subscription, and it is the reason a
 * lock-screen answer survives a cold launch: iOS reports the answer before
 * the React runtime exists, and an event with no listener is dropped without
 * a trace at both the Swift emitter and the codegen one.
 */
export function flushPendingEvents(): Promise<void> {
  return NativeTacendumCall.flushPendingEvents();
}

// --- message notifications ---------------------------------------------------

const NotificationPermission = z.enum(['granted', 'denied']);
export type NotificationPermission = z.infer<typeof NotificationPermission>;

export async function requestNotificationPermission(): Promise<NotificationPermission> {
  return NotificationPermission.parse(
    await NativeTacendumCall.requestNotificationPermission(),
  );
}

/** '' until iOS has issued one. Not the VoIP token. */
export function getAlertToken(): Promise<string> {
  return NativeTacendumCall.getAlertToken();
}

/** Set or clear the number on the app icon. 0 removes it. */
export function setBadgeCount(count: number): Promise<void> {
  return NativeTacendumCall.setBadgeCount(count);
}

/** This binary's bundle identifier, read from Bundle.main. */
export function bundleId(): Promise<string> {
  return NativeTacendumCall.bundleId();
}

// --- device pressure -------------------------------------------------

export function startMonitoringPressure(): Promise<void> {
  return NativeTacendumCall.startMonitoringPressure();
}

export function stopMonitoringPressure(): Promise<void> {
  return NativeTacendumCall.stopMonitoringPressure();
}

/** 0–3 bars. Reduced natively, so no stats payload crosses the bridge. */
export function sampleQuality(cid: string): Promise<number> {
  return NativeTacendumCall.sampleQuality(cid);
}

/** Cap the encoder; 0 for either bound means no cap. */
export function applyVideoCap(
  cid: string,
  maxLongEdge: number,
  maxFps: number,
): Promise<void> {
  return NativeTacendumCall.applyVideoCap(cid, maxLongEdge, maxFps);
}

// --- permissions ------------------------------------------------------------

const PermissionState = z.enum(['granted', 'denied', 'undetermined']);
export type PermissionState = z.infer<typeof PermissionState>;

const PermissionResult = z.object({ camera: PermissionState, mic: PermissionState });
export type PermissionResult = z.infer<typeof PermissionResult>;

export async function cameraPermission(): Promise<PermissionState> {
  return PermissionState.parse(await NativeTacendumCall.cameraPermission());
}

export async function micPermission(): Promise<PermissionState> {
  return PermissionState.parse(await NativeTacendumCall.micPermission());
}

export async function requestPermissions(video: boolean): Promise<PermissionResult> {
  return PermissionResult.parse(JSON.parse(await NativeTacendumCall.requestPermissions(video)));
}

/** DEBUG builds only; a no-op in Release. */
export function enableSyntheticVideo(on: boolean): Promise<void> {
  return NativeTacendumCall.enableSyntheticVideo(on);
}

/** Fault injector. Send a wrong fingerprint; the call MUST fail. DEBUG only. */
export function enableFingerprintFault(on: boolean): Promise<void> {
  return NativeTacendumCall.enableFingerprintFault(on);
}

/**
 * The shared-capture spike. Returns a JSON measurement.
 *
 * It wants ten minutes on a physical device, with the app backgrounded
 * at some point during the run — backgrounding is one of its Verify items and
 * cannot be triggered from inside the process. On the Simulator this exercises
 * the synthetic-capture arm, which is a Verify item in its own right.
 *
 * DEBUG only; Release resolves an explanatory error rather than measuring
 * nothing and looking like it worked.
 */
export function runSharedCaptureSpike(
  legs: number,
  seconds: number,
): Promise<string> {
  return NativeTacendumCall.runSharedCaptureSpike(legs, seconds);
}

// --- events -----------------------------------------------------------------

/** Unsubscribe handle, matching the shape codegen's EventEmitter returns. */
export interface Subscription {
  remove(): void;
}

/**
 * Subscribe with parsing.
 *
 * A payload that does not parse is DROPPED and reported, never delivered.
 * Late events are normal here — a track can be removed while a call is being
 * torn down — so a malformed one must not be able to reach the reducer, which
 * is written against a validated event union.
 */
function subscribe<T>(
  emitter: { (listener: (value: string) => void): Subscription },
  schema: z.ZodType<T>,
  handler: (value: T) => void,
  label: string,
): Subscription {
  return emitter((raw: string) => {
    const parsed = schema.safeParse(typeof raw === 'string' ? safeJson(raw) : raw);
    if (!parsed.success) {
      console.warn(`[call] dropped malformed ${label} event`);
      return;
    }
    handler(parsed.data);
  });
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export const events = {
  iceState: (h: (e: IceStateEvent) => void): Subscription =>
    subscribe(NativeTacendumCall.onIceState, IceStateEvent, h, 'iceState'),
  iceCandidate: (h: (e: IceCandidateEvent) => void): Subscription =>
    subscribe(NativeTacendumCall.onIceCandidate, IceCandidateEvent, h, 'iceCandidate'),
  connectionState: (h: (e: ConnectionStateEvent) => void): Subscription =>
    subscribe(NativeTacendumCall.onConnectionState, ConnectionStateEvent, h, 'connectionState'),
  remoteTrackAdded: (h: (e: TrackEvent) => void): Subscription =>
    subscribe(NativeTacendumCall.onRemoteTrackAdded, TrackEvent, h, 'remoteTrackAdded'),
  remoteTrackRemoved: (h: (e: TrackEvent) => void): Subscription =>
    subscribe(NativeTacendumCall.onRemoteTrackRemoved, TrackEvent, h, 'remoteTrackRemoved'),
  callKitAnswer: (h: (e: { cid: string }) => void): Subscription =>
    subscribe(NativeTacendumCall.onCallKitAnswer, CidEvent, h, 'callKitAnswer'),
  callKitEnd: (h: (e: CallKitEndEvent) => void): Subscription =>
    subscribe(NativeTacendumCall.onCallKitEnd, CallKitEndEvent, h, 'callKitEnd'),
  callKitMute: (h: (e: CallKitMuteEvent) => void): Subscription =>
    subscribe(NativeTacendumCall.onCallKitMute, CallKitMuteEvent, h, 'callKitMute'),
  // No cid: CallKit activates ONE audio session for the device, not one per
  // call. Requiring a cid here would drop every activation as malformed, and
  // since the WebRTC audio unit starts on nothing else, the symptom would be a
  // connected call with no sound — precisely the failure the handshake exists to stop.
  callKitAudioActivated: (h: () => void): Subscription =>
    NativeTacendumCall.onCallKitAudioActivated(() => h()),
  callKitAudioDeactivated: (h: () => void): Subscription =>
    NativeTacendumCall.onCallKitAudioDeactivated(() => h()),
  voipPush: (h: (e: VoipPushEvent) => void): Subscription =>
    subscribe(NativeTacendumCall.onVoipPush, VoipPushEvent, h, 'voipPush'),
  voipTokenUpdated: (h: (token: string) => void): Subscription =>
    NativeTacendumCall.onVoipTokenUpdated((token: string) => h(token)),
  alertTokenUpdated: (h: (e: { token: string }) => void): Subscription =>
    subscribe(
      NativeTacendumCall.onAlertTokenUpdated,
      z.object({ token: z.string() }),
      h,
      'alertTokenUpdated',
    ),
  audioRouteChanged: (h: (e: AudioRouteEvent) => void): Subscription =>
    subscribe(NativeTacendumCall.onAudioRouteChanged, AudioRouteEvent, h, 'audioRouteChanged'),
  /** Pressure events. Declared before anything emitted them — the whole
   * thermal table was unreachable because no signal ever arrived. */
  devicePressure: (h: (e: DevicePressureEvent) => void): Subscription =>
    subscribe(
      NativeTacendumCall.onThermalStateChanged,
      DevicePressureEvent,
      h,
      'devicePressure',
    ),
};
