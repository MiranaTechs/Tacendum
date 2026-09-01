import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';
import type { EventEmitter } from 'react-native/Libraries/Types/CodegenTypes';

/**
 * TurboModule spec for calling — codegen input.
 *
 * Everything media lives behind this boundary: the peer connection, the codec
 * configuration, CallKit, PushKit and the audio session. Above it sits a pure
 * reducer (`callReducer` in `@tacendum/shared`) that has no idea any of this
 * exists — which is why the whole call protocol is testable without a device,
 * and why an eventual Android port is an adapter rewrite rather than a
 * redesign.
 *
 * **The security boundary is the SDP, and specifically its `a=fingerprint`
 * line.** Media is DTLS-SRTP keyed by the two devices; the fingerprint that
 * binds those keys travels inside the ratcheted envelope, so a server that
 * swapped it would have to break the Double Ratchet first. Nothing in
 * this module may rewrite that line — see `trimSdpCodecs` in Swift, and the
 * test that asserts the four security-relevant lines survive byte-for-byte.
 *
 * Structured values cross as JSON strings, matching the crypto module's
 * convention: codegen's supported types are narrow, and a JSON string that
 * zod validates on the JS side beats a hand-maintained parallel type.
 */
export interface Spec extends TurboModule {
  // --- lifecycle ---

  /**
   * Install the ICE server list and the relay-only policy. Called before any
   * call and again whenever credentials are refreshed; the servers come from
   * `/v1/turn-credentials` and expire, so this is not one-time setup.
   *
   * `relayOnly` is the always-relay mode: it sets `iceTransportPolicy` to
   * `relay`, so no host candidate is ever offered and the peer never learns
   * the device's IP address.
   */
  configure(iceServersJson: string, relayOnly: boolean): Promise<void>;

  /** Create the peer connection and return a trimmed SDP offer. */
  createOffer(cid: string, withVideo: boolean): Promise<string>;

  /** Apply a remote offer and return a trimmed SDP answer. */
  createAnswer(cid: string, remoteOfferSdp: string, withVideo: boolean): Promise<string>;

  setRemoteAnswer(cid: string, sdp: string): Promise<void>;

  /** `candidatesJson` is the `c` array of a `call.ice` envelope. */
  addIceCandidates(cid: string, candidatesJson: string): Promise<void>;

  /** ICE restart after a network change. Fresh offer, same cid. */
  restartIce(cid: string): Promise<string>;

  close(cid: string): Promise<void>;

  // --- media control ---

  /**
   * Enable or disable a local track, resolving THE APPLIED VERDICT: whether
   * this cid had a live connection whose track was actually changed.
   *
   * `false` — no connection for that cid, or no track on it — is what
   * the all-or-close-the-leg rule acts on: a leg the microphone
   * cannot be silenced toward is closed rather than left open behind a muted
   * button. Declared here, so the generated protocol requires it in BOTH
   * build configurations (the rule `runSharedCaptureSpike` documents below).
   */
  setAudioEnabled(cid: string, on: boolean): Promise<boolean>;
  setVideoEnabled(cid: string, on: boolean): Promise<boolean>;
  switchCamera(cid: string): Promise<void>;
  setSpeaker(cid: string, on: boolean): Promise<void>;

  /**
   * Local quality indicator only.
   *
   * **Rule:** this output must never be serialized into an envelope or
   * a log line. It contains candidate addresses — which is to say the other
   * person's IP — and the entire point of the relay design is that nothing
   * outside the two devices learns it.
   */
  getStats(cid: string): Promise<string>;

  // --- CallKit ---

  /**
   * `video` is what CallKit records for the call AND what the audio session is
   * configured for. It was not passed at all, so an outgoing video call was
   * reported as a voice call and its session came up without
   * `.defaultToSpeaker` — audio out of the earpiece on a call you are holding
   * at arm's length.
   */
  reportOutgoingCall(cid: string, handle: string, video: boolean): Promise<void>;
  reportOutgoingConnected(cid: string): Promise<void>;
  /**
   * `peerId` is the CORRELATION KEY for the VoIP-push rebind. The push rings
   * under a synthetic cid (the real one is inside the ciphertext); when the
   * decrypted offer reports here, the native side matches on the caller and
   * re-keys the already-ringing CallKit call instead of ringing a second one
   * — which is what put a header banner over the full-screen ring, and why
   * the name correction used to miss entirely.
   */
  reportIncomingCall(
    cid: string,
    peerId: string,
    handle: string,
    displayName: string,
    hasVideo: boolean,
  ): Promise<void>;
  /** Replace the placeholder name once the offer has decrypted. */
  updateIncomingCallDisplay(cid: string, displayName: string): Promise<void>;
  /**
   * End the placeholder a VoIP push rang, when the decrypted truth says it
   * must not ring: a blocked or silenced caller (the push rang before
   * anything could decrypt), or a frame that turned out to be a
   * cancellation. reason: 'declined' | 'cancelled' | 'expired' | 'not_call' |
   * 'invalid' — only 'cancelled' maps to .remoteEnded, everything else to
   * .unanswered. No-op when nothing is pending.
   *
   * `cid` NAMES THE PLACEHOLDER THE CALLER DECIDED ABOUT. Native fires only
   * while `pendingPush` still holds that exact cid for that peer, so a verdict
   * that lands after the ring was replaced cannot end the replacement. `''`
   * matches whatever is pending for the peer — the behaviour this shipped
   * with. REQUIRED, not optional: a TurboModule spec admits no optionals, and
   * the codegen argument count is compiled into the binary.
   */
  dismissPendingIncomingCall(peerId: string, reason: string, cid: string): Promise<void>;
  endCall(cid: string, reason: string): Promise<void>;

  // --- PushKit ---

  /** '' until the registry has produced one. */
  getVoipToken(): Promise<string>;
  registerForVoipPush(): Promise<void>;

  // --- message notifications ---

  /**
   * Ask to show notifications, and register for remote ones if allowed.
   *
   * Resolves 'granted' | 'denied'. Refusal is an answer, not an error.
   * Registration happens only after a grant, so the server never holds a token
   * that produces a push nothing can display.
   */
  requestNotificationPermission(): Promise<string>;

  /** The APNs ALERT token — a different token from the VoIP one. '' until iOS
   * has issued it. */
  getAlertToken(): Promise<string>;

  /**
   * Set the number on the app icon. 0 removes it.
   *
   * The server puts a count on each push, but only the device can clear one:
   * a badge set by a notification stays until something says otherwise, and
   * the server never learns that anyone opened the app. So the rule is that
   * the server raises it and the app lowers it.
   *
   * Never rejects. A badge is decoration; a failure to draw one must not
   * become an error on a path that is otherwise about delivering messages.
   */
  setBadgeCount(count: number): Promise<void>;

  /**
   * This binary's bundle identifier, from `Bundle.main`.
   *
   * Read rather than hardcoded because a constant that drifts from the binary
   * is a constant nobody notices — and this value is sent to the server with
   * every push registration, where the schema requires it.
   */
  bundleId(): Promise<string>;

  // --- device pressure ---

  /**
   * Begin watching thermal state, Low Power Mode and battery level.
   *
   * Started per call rather than at launch: battery monitoring is not free,
   * and a phone that is not in a call has no video to reduce. Emits
   * `onThermalStateChanged` immediately so a call placed on an already-hot
   * phone starts capped instead of waiting for a state CHANGE.
   */
  startMonitoringPressure(): Promise<void>;
  stopMonitoringPressure(): Promise<void>;

  /**
   * Cap the encoder. `maxLongEdge`/`maxFps` of 0 means no cap.
   *
   * Applied as a scale on the sender, not a capture restart — a restart drops
   * about a second of video, and it would happen exactly when the phone is
   * already in trouble.
   */
  applyVideoCap(cid: string, maxLongEdge: number, maxFps: number): Promise<void>;

  /**
   * 0–3 bars for the in-call quality indicator.
   *
   * Returns the LEVEL, not the stats. `getStats` output must never leave the
   * device; reducing to an integer natively means no stats payload
   * crosses the bridge at all, which is a stronger guarantee than stripping
   * the payload and hoping the stripping stays correct.
   */
  sampleQuality(cid: string): Promise<number>;

  // --- event readiness ---

  /**
   * Announce that JS listeners are attached, releasing anything CallKit
   * raised first.
   *
   * Answering from the lock screen on a cold launch delivers the answer
   * before the React runtime exists. Until this is called, native buffers
   * rather than emits, because an event with no listener is discarded
   * silently at two separate layers.
   */
  flushPendingEvents(): Promise<void>;

  // --- permissions ---

  cameraPermission(): Promise<string>;
  micPermission(): Promise<string>;
  /** JSON `{camera, mic}` after prompting. */
  requestPermissions(video: boolean): Promise<string>;

  // --- dev only ---

  /**
   * Swap the camera for a synthetic animated test pattern.
   *
   * The iOS Simulator has no camera, so without this the entire media
   * pipeline — capture, encode, DTLS-SRTP, decode, render — is untestable
   * anywhere except on two physical phones. Compiled out of Release builds.
   */
  enableSyntheticVideo(on: boolean): Promise<void>;

  /**
   * Send a deliberately WRONG `a=fingerprint` on the next offer or
   * answer.
   *
   * The point is to falsify the no-MITM claim: that the server cannot
   * man-in-the-middle the media because the fingerprint binds the DTLS keys
   * and travels inside the ratchet. `SdpTrimmer` is tested to leave the line
   * byte-for-byte intact — but nothing demonstrated that a wrong one is
   * actually REJECTED, and a peer connection with certificate verification
   * accidentally disabled would connect happily to an attacker while every
   * other test still passed.
   *
   * With this on, the call must fail to connect and end `failed_media`.
   * Compiled out of Release builds.
   */
  enableFingerprintFault(on: boolean): Promise<void>;

  /**
   * The shared-capture spike, run on this device.
   *
   * Answers the one question group calls are gated on: can ONE camera capture
   * and ONE video source feed `legs` tracks across `legs` peer connections, at
   * a thermal and battery cost worth paying? Returns a JSON measurement to be
   * recorded by hand — deliberately data rather than a typed result,
   * because nothing should be built against this.
   *
   * It wants ten minutes on physical hardware, and a human to background
   * the app mid-run (backgrounding is a Verify item and cannot be triggered
   * from inside). Short runs on the Simulator exercise the synthetic-capture
   * arm, which is a separate Verify item of its own.
   *
   * Compiled out of Release builds: the body is DEBUG-only and Release
   * resolves an explanatory error instead.
   */
  runSharedCaptureSpike(legs: number, seconds: number): Promise<string>;

  // --- events ---

  /** JSON `{cid, state}` where state is an RTCIceConnectionState. */
  readonly onIceState: EventEmitter<string>;
  /** JSON `{cid, cand, mid, idx}` — one gathered local candidate. */
  readonly onIceCandidate: EventEmitter<string>;
  /** JSON `{cid, state}` — RTCPeerConnectionState. */
  readonly onConnectionState: EventEmitter<string>;
  /** JSON `{cid, kind}` — 'audio' | 'video'. */
  readonly onRemoteTrackAdded: EventEmitter<string>;
  readonly onRemoteTrackRemoved: EventEmitter<string>;

  /** JSON `{cid}` — the user accepted from the CallKit UI or lock screen. */
  readonly onCallKitAnswer: EventEmitter<string>;
  /** JSON `{cid, reason}`. */
  readonly onCallKitEnd: EventEmitter<string>;
  /** JSON `{cid, muted}`. */
  readonly onCallKitMute: EventEmitter<string>;
  /**
   * CallKit activated the audio session. The WebRTC audio unit starts HERE and
   * nowhere else — starting it on our own timing is the single most
   * common cause of "the call connects but there is no sound".
   *
   * Carries no cid: there is one audio session per DEVICE, not per call.
   */
  readonly onCallKitAudioActivated: EventEmitter<string>;
  readonly onCallKitAudioDeactivated: EventEmitter<string>;

  /**
   * JSON `{cid, from, ringCid}` — a VoIP wake arrived; the envelope follows
   * over WS.
   *
   * `ringCid` is the cid of the placeholder ACTUALLY RINGING for this caller,
   * `''` when none is. It is not always `cid`: `alreadyRinging` deliberately
   * leaves `pendingPush` on the FIRST ring while still emitting this event for
   * the second push, so from push #2 onward `cid` names a throwaway that no
   * dismissal could ever match.
   */
  readonly onVoipPush: EventEmitter<string>;
  /** The hex token, or '' if the registry invalidated it. */
  readonly onVoipTokenUpdated: EventEmitter<string>;
  /** JSON `{token}` — the APNs ALERT token, '' when registration failed. */
  readonly onAlertTokenUpdated: EventEmitter<string>;

  /** JSON `{route, speaker}`. */
  readonly onAudioRouteChanged: EventEmitter<string>;
  /** JSON `{state, lowPower, battery}`. `state` is a
   * `ProcessInfo.thermalState`; `battery` is 0–1, or null when the device
   * declines to report it. */
  readonly onThermalStateChanged: EventEmitter<string>;
  /** JSON stats sample for the local quality indicator. Never leaves the device. */
  readonly onStatsSample: EventEmitter<string>;
}

export default TurboModuleRegistry.getEnforcing<Spec>('TacendumCall');
