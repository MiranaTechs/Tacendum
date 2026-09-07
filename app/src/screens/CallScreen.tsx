import React, {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  AccessibilityInfo,
  Animated,
  Platform,
  Pressable,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {
  useSafeAreaFrame,
  useSafeAreaInsets,
} from 'react-native-safe-area-context';
import { RINGING_ACK_GRACE_MS, type CallState } from '@tacendum/shared';
import { TacendumVideoView } from 'tacendum-call';
import { EARPIECE_KNOWN_ABSENT } from '../audioRoute';
// Moved out so the small-group screen reuses them rather than growing
// a second mute button. Refactor-only: the components are
// unchanged and this screen's rendered tree is byte-identical.
import {
  ControlButton,
  durationAnnouncementFrom,
  durationFrom,
  QualityBars,
} from '../components/CallControls';
import { Avatar } from '../ui/Avatar';
import { MinimizeGlyph } from '../ui/CallControlGlyphs';
// The person covering the surface their video would cover. Moved out
// so the minimized call window shows them the same way;
// unchanged, and this screen's rendered tree is byte-identical.
import { PeerBackdrop } from '../ui/PeerBackdrop';
// The id-refusal rule this screen shares with the group tiles: a surface a
// stranger holding the phone sees never letters itself with id characters.
import { tileName, UNNAMED } from '../ui/CallTile';
// The draggable corner preview's geometry and wiring, lifted out (2026-08-28)
// so the minimized call window drags through the SAME gesture. The names
// are re-exported below so every existing import of them from this screen —
// the suite's included — keeps meaning what it meant.
import {
  PIP_ACCESSIBILITY_ACTIONS,
  PIP_BOTTOM_CLEARANCE,
  PIP_HEIGHT,
  PIP_MARGIN,
  PIP_TOP_CLEARANCE,
  PIP_WIDTH,
  pipCornerForAction,
  type PipCorner,
  usePipDrag,
} from '../ui/pipDrag';
import { useOutgoingRingback } from '../ui/ringback';
import { useVideoReadiness } from '../ui/videoReadiness';
import { useTheme } from '../theme';
import { useReduceMotion } from '../useReduceMotion';
import type { CallMediaControlResult } from '../call';
import type { CallQualityStatus } from '../call/quality';

export {
  PIP_ACCESSIBILITY_ACTIONS,
  PIP_BOTTOM_CLEARANCE,
  PIP_DRAG_THRESHOLD,
  PIP_HEIGHT,
  PIP_MARGIN,
  PIP_TOP_CLEARANCE,
  PIP_WIDTH,
  clampPip,
  nearestPipCorner,
  pipAnchor,
  pipCornerForAction,
  pipDragClaims,
} from '../ui/pipDrag';
export type { PipCorner } from '../ui/pipDrag';

/**
 * The in-call screen.
 *
 * A sibling overlay rather than a route in App.tsx's union, so a call survives
 * navigation: answering one and then opening a different chat must not end it.
 *
 * It renders `CallState` and calls back; it holds no call state of its own.
 * Everything it shows is derived from the reducer, which is why every state
 * below — including "reconnecting" and "the call never connected" — can be
 * rendered in a test without a device. Its one side effect is the OUTGOING
 * ringback (useOutgoingRingback): the tone the caller hears while the far
 * phone rings, driven from the same `CallState` prop, because this screen is
 * exactly the surface that exists for the duration of that state.
 */

export interface CallScreenProps {
  state: CallState;
  peerName: string;
  /** The peer's profile picture, when the database holds one. */
  peerAvatarB64?: string | null;
  /** Local track state, mirrored from the controller. */
  muted: boolean;
  videoEnabled: boolean;
  speakerOn: boolean;
  /** Which camera is capturing. Drives mirroring, and only that: a front
   * preview should behave like a mirror and a REAR one must not, or the
   * person sees the world reversed and text backwards.
   *
   * Defaults to the camera capture actually starts on (`startCapture` in
   * Swift picks `.front`), so a caller that has not wired the flip through
   * still gets the correct preview until the first flip. */
  frontCamera?: boolean;
  /** `-1` until local getStats has a measured 1–3 level. Never leaves the
   * device. */
  quality?: number;
  qualityStatus?: CallQualityStatus;
  /**
   * The design device-pressure notice — "Reduced quality", "Low Power Mode",
   * "Video paused to cool down" — or absent, which is the ordinary case.
   *
   * Shown because a video call that silently drops to 360p, or stops sending
   * video entirely, otherwise reads as the app or the network failing. Naming
   * the cause is the difference between "this is broken" and "my phone is
   * hot".
   */
  pressureNotice?: string | null;
  /** The design: tapping the notice lifts the cap. True only for Low Power Mode —
   * a tap cannot cool a phone down, so a thermal notice is never pressable. */
  pressureRestorable?: boolean;
  onRestoreQuality?(): void;
  /** The design: battery is nearly out. OFFERS voice; never switches on its own —
   * ending someone's video call to save power is their decision. */
  offerVoice?: boolean;
  onSwitchToVoice?(): void;
  onToggleMute():
    | void
    | CallMediaControlResult
    | Promise<void | CallMediaControlResult>;
  onToggleVideo():
    | void
    | CallMediaControlResult
    | Promise<void | CallMediaControlResult>;
  onFlipCamera(): void;
  onToggleSpeaker(): void;
  onHangup(): void;
  /** Presentation-only state retained by App for this call's remount. */
  initialSwapped?: boolean;
  initialPipCorner?: PipCorner;
  onSwappedChange?(swapped: boolean): void;
  onPipCornerChange?(corner: PipCorner): void;
  /**
   * Put the call away and keep it going ("go
   * back to the chat from a video call while the video call is on"). When
   * present, a minimize control sits at the head of the header; App.tsx
   * offers it only for a connected or reconnecting call — the states this
   * screen can be replaced by the small `CallOverlay` window without losing
   * anything it owns (the outgoing ringback lives here, so a ringing call
   * stays full screen). Absent, the header is exactly what it always was.
   */
  onMinimize?(): void;
  /** Test seam: a fixed clock keeps the duration deterministic. */
  now?: () => number;
}

/** What the header says. Distinct from the state name because "outgoing_ringing"
 * is a protocol fact and "Ringing…" is what a person needs. */
export function statusLabel(state: CallState): string {
  switch (state.name) {
    case 'outgoing_connecting':
      // `remoteReady` flips when the ANSWER arrives (call-machine.ts, on
      // answerReceived) — the machine deliberately returns to
      // outgoing_connecting because "ringing" was only ever a UI state, and
      // rendering that literally made the header REGRESS: Ringing… back to
      // Calling… at the exact moment the other person picked up (Phase H
      // hardware). The machine already knows the difference;
      // this is the label catching up, not a new state.
      return state.call.remoteReady ? 'Connecting…' : 'Calling…';
    case 'outgoing_ringing':
      return 'Ringing…';
    case 'incoming_ringing':
      return 'Incoming call';
    case 'incoming_answering':
      return 'Connecting…';
    case 'connected':
      return 'Connected';
    case 'reconnecting':
      return 'Reconnecting…';
    case 'ending':
      return 'Ending…';
    default:
      return '';
  }
}

/** A local-clock qualification for an offer nobody has acknowledged yet. */
export function statusLabelAt(state: CallState, now: number): string {
  if (
    state.name === 'outgoing_connecting' &&
    state.call.direction === 'out' &&
    !state.call.remoteReady &&
    now >= state.call.startedAt + RINGING_ACK_GRACE_MS
  ) {
    return 'Calling… They may be offline.';
  }
  return statusLabel(state);
}

function spokenStatusLabel(visible: string): string {
  return visible.replace('… ', '. ').replace(/…$/, '');
}

/**
 * Duration, from the moment media actually flowed.
 *
 * `connectedAt` is null until ICE connects, and "never connected" is a
 * different fact from "a zero-second call" — so a call that rang and
 * failed shows no timer at all rather than 0:00, which would claim it happened.
 */
export function durationLabel(state: CallState, now: number): string | null {
  return durationFrom(state.call?.connectedAt, now);
}

/** VoiceOver announces at MINUTE granularity: a live region that changes every
 * second makes a call unusable with a screen reader. */
export function durationAnnouncement(state: CallState, now: number): string {
  return durationAnnouncementFrom(state.call?.connectedAt, now);
}

/* ---------------------------------------------------------------------------
 * The draggable corner preview lives in
 * ../ui/pipDrag.ts: constants, pure geometry and the
 * `usePipDrag` hook, shared with the minimized call window. Re-exported at
 * the top of this file under their original names.
 */

/**
 * The person, when there is no video of them to show.
 *
 * ONE implementation of "what someone looks like", shared with every other
 * surface in the app. `Avatar` is what the chat list, the thread header, the
 * peer profile and the Calls tab draw, and it already owns both halves of the
 * answer: the photo that person shared, else the monogram the fallback
 * asks for. This screen used to own a second half-answer — `peerName.slice(0,
 * 1)` — so "Maya Ruiz" was `M` on a call and `MR` everywhere else, and a
 * video call had no answer at all.
 *
 * `peerId` is passed rather than `''` so the monogram is derived from the
 * same two inputs the chat derives it from; with an empty id, a peer who has
 * never shared a name fell through `monogram`'s id branch to a literal `?`
 * while their thread showed two letters.
 *
 * `pointerEvents="none"` because it sits INSIDE a Pressable it must not eat:
 * the tap that swaps the two surfaces has to reach the surface, and a face
 * covering the middle of the screen is exactly where a thumb lands.
 *
 * The label is carried only where the face is the whole element (an audio
 * call). Inside a video surface the Pressable already announces whose video
 * it is, and a second accessible node inside it would say the name twice.
 */
function PeerFace({
  peerId,
  peerName,
  photoB64,
  size,
  styles,
  labelled = false,
  ground = false,
}: {
  peerId: string;
  peerName: string;
  photoB64?: string | null;
  size: number;
  styles: ReturnType<typeof makeStyles>;
  labelled?: boolean;
  /**
   * Set where the face stands INSIDE a video surface, which paints itself
   * opaque black when it has no track. Without the pine ground under it the
   * disc floats in that black, which is the state the hardware report
   * (2026-08-13) named: "person B is all dark screen".
   */
  ground?: boolean;
}): React.JSX.Element {
  // The id-refusal rule the backdrop and the group tiles already keep, kept
  // HERE rather than at each call site so the disc cannot be handed a name it
  // must not letter with. `tileName` answers with a sentinel, not with
  // letters, so the sentinel is mapped explicitly: passed through as a
  // display name it letters `SO`, and dropped for `null` it letters two
  // characters of the id. The same person wore `SO` on the pre-connect disc
  // and `?` the instant the call connected, seconds apart.
  const shown = tileName(peerId, peerName);
  const unnamed = shown === UNNAMED;
  return (
    <View
      style={ground ? styles.avatarGround : styles.avatarWrap}
      pointerEvents="none"
    >
      <Avatar
        peerId={peerId}
        displayName={shown}
        {...(unnamed ? { monogramOverride: '?' } : {})}
        photoB64={photoB64}
        size={size}
        {...(labelled ? { accessibilityLabel: `${shown}'s picture` } : {})}
      />
    </View>
  );
}

export function CallScreen(props: CallScreenProps): React.JSX.Element | null {
  const {
    state,
    peerName,
    peerAvatarB64,
    muted,
    videoEnabled,
    speakerOn,
    frontCamera = true,
    quality = -1,
    qualityStatus =
      quality === 1 || quality === 2 || quality === 3
        ? 'measured'
        : 'checking',
    pressureNotice = null,
    pressureRestorable = false,
    onRestoreQuality,
    offerVoice = false,
    onSwitchToVoice,
    onToggleMute,
    onToggleVideo,
    onFlipCamera,
    onToggleSpeaker,
    onHangup,
    initialSwapped = false,
    initialPipCorner = 'top-right',
    onSwappedChange,
    onPipCornerChange,
    onMinimize,
    now = Date.now,
  } = props;

  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const reduceMotion = useReduceMotion();
  // The caller's ring, from the state this screen already receives. Runs
  // above the idle early-return like every other hook here.
  useOutgoingRingback(state);
  const [tick, setTick] = useState(() => now());
  type PendingMediaControl = 'mute' | 'video';
  const pendingMediaRef = useRef(new Set<PendingMediaControl>());
  const mediaOperationRef = useRef(
    new Map<PendingMediaControl, { generation: number; operation: number }>(),
  );
  const mediaOperationSerialRef = useRef(0);
  const controlGenerationRef = useRef(0);
  const [pendingMedia, setPendingMedia] = useState<ReadonlySet<PendingMediaControl>>(
    () => new Set(),
  );
  const [controlFailure, setControlFailure] = useState<{
    control: PendingMediaControl;
    message: string;
  } | null>(null);
  const [headerHeight, setHeaderHeight] = useState(0);
  const controlLifetime = `${state.call?.cid ?? ''}:${state.name}`;
  const controlsMountedRef = useRef(false);

  // A bridge promise can finish after reconnect, hangup, glare, or a new
  // call. Its feedback belongs only to the exact lifecycle that started it.
  useLayoutEffect(() => {
    const mediaOperations = mediaOperationRef.current;
    const pendingControls = pendingMediaRef.current;
    controlsMountedRef.current = true;
    controlGenerationRef.current += 1;
    mediaOperations.clear();
    pendingControls.clear();
    setPendingMedia(new Set());
    setControlFailure(null);
    return () => {
      controlsMountedRef.current = false;
      controlGenerationRef.current += 1;
      mediaOperations.clear();
      pendingControls.clear();
    };
  }, [controlLifetime]);

  // Clear a refusal once another path actually changes the corresponding
  // applied state (CallKit, device pressure, or a later successful tap).
  useEffect(() => {
    setControlFailure(previous =>
      previous?.control === 'mute' ? null : previous,
    );
  }, [muted]);
  useEffect(() => {
    setControlFailure(previous =>
      previous?.control === 'video' ? null : previous,
    );
  }, [videoEnabled]);

  const runMediaControl = async (
    control: PendingMediaControl,
    action: () =>
      | void
      | CallMediaControlResult
      | Promise<void | CallMediaControlResult>,
    refusalMessage: string,
  ): Promise<void> => {
    if (pendingMediaRef.current.has(control)) return;
    const owner = {
      generation: controlGenerationRef.current,
      operation: ++mediaOperationSerialRef.current,
    };
    mediaOperationRef.current.set(control, owner);
    pendingMediaRef.current.add(control);
    setPendingMedia(new Set(pendingMediaRef.current));
    setControlFailure(null);

    let result: void | CallMediaControlResult;
    try {
      result = await action();
    } catch {
      result = 'refused';
    }

    if (
      !controlsMountedRef.current ||
      controlGenerationRef.current !== owner.generation ||
      mediaOperationRef.current.get(control) !== owner
    ) {
      return;
    }
    if (result === 'refused') {
      setControlFailure({ control, message: refusalMessage });
    } else if (result === 'applied') {
      setControlFailure(null);
    }
    mediaOperationRef.current.delete(control);
    pendingMediaRef.current.delete(control);
    setPendingMedia(new Set(pendingMediaRef.current));
  };

  const runMuteControl = () =>
    runMediaControl(
      'mute',
      onToggleMute,
      muted
        ? 'Couldn’t unmute the microphone. Try again.'
        : 'Couldn’t mute the microphone. Try again.',
    );
  const runVideoControl = () =>
    runMediaControl(
      'video',
      onToggleVideo,
      videoEnabled
        ? 'Couldn’t turn the camera off. Try again.'
        : 'Couldn’t turn the camera on. Try again.',
    );
  /**
   * Which stream fills the screen.
   *
   * FaceTime's gesture: tap either surface to swap them. People do this to
   * check what they are actually sending — framing, lighting, whether the
   * camera is pointed at the ceiling — and without it the only view of
   * yourself is a thumbnail.
   *
   * Local state, not global: it is a preference about this screen right now,
   * and it should not survive the call it belongs to.
   */
  const [swapped, setSwapped] = useState(initialSwapped);

  /**
   * Where the corner preview is parked (the
   * geometry and the wiring are `usePipDrag` in ../ui/pipDrag.ts, shared
   * with the minimized call window). Per-call state exactly as `swapped`
   * is: App.tsx unmounts this screen when the call ends, so the next call
   * starts at 'top-right' — the position this screen has always used.
   * Screen-level, not pip-level, so turning the camera off and on (which
   * unmounts the pip) brings it back to the corner it was left in.
   *
   * The stored FACT is the corner; coordinates are re-derived from it, which
   * is what lets an iPad rotation or Split View resize land the pip somewhere
   * valid instead of somewhere remembered.
   *
   * `useSafeAreaFrame` rather than `useWindowDimensions`: this screen is an
   * absolute-fill overlay inside the root SafeAreaProvider, so the provider's
   * frame IS the window — and it is the same coordinate system the insets
   * describe, where Dimensions' window need not be (and is not, under jest's
   * mocks). The default box — 110pt, 16:9, clear of this screen's header and
   * control bands — is the hook's own default.
   */
  const frame = useSafeAreaFrame();
  // Reconnect guidance and a media-control failure can both wrap under
  // Dynamic Type. The preview's historical fixed top band only accounted
  // for the ordinary status header, so the live camera covered the new copy
  // and action. Reserve the height React Native actually laid out, plus the
  // same edge margin the preview keeps everywhere else.
  const pipTopClearance = Math.max(
    PIP_TOP_CLEARANCE,
    headerHeight + PIP_MARGIN - insets.top,
  );
  const pipAvailableHeight = Math.max(
    0,
    frame.height -
      insets.bottom -
      PIP_BOTTOM_CLEARANCE -
      (insets.top + pipTopClearance),
  );
  // `pipAnchor` deliberately centres an over-large box when its top and
  // bottom bands cross. That is a sound general fallback, but here it would
  // put the preview back over the very guidance we measured. Keep the
  // ordinary 110pt preview whenever it fits; only a constrained Dynamic
  // Type layout scales the same live surface down to the space that remains.
  const pipScale =
    frame.height > 0 ? Math.min(1, pipAvailableHeight / PIP_HEIGHT) : 1;
  const pipWidth = PIP_WIDTH * pipScale;
  const pipHeight = PIP_HEIGHT * pipScale;
  const pip = usePipDrag({
    frame: { width: frame.width, height: frame.height },
    insets: {
      top: insets.top,
      bottom: insets.bottom,
      left: insets.left,
      right: insets.right,
    },
    box: {
      width: pipWidth,
      height: pipHeight,
      topClearance: pipTopClearance,
      bottomClearance: PIP_BOTTOM_CLEARANCE,
    },
    reduceMotion,
    motion: theme.motion,
    initialCorner: initialPipCorner,
    onCornerChange: onPipCornerChange,
  });

  const call = state.call;
  const isVideo = call?.video === true || call?.peerVideo === true;
  const remoteExpected = state.name === 'connected' && call?.peerVideo === true;
  const fullVideo = useVideoReadiness(call?.cid ?? '', swapped ? 'local' : 'remote', swapped ? videoEnabled : remoteExpected);
  const previewVideo = useVideoReadiness(call?.cid ?? '', swapped ? 'remote' : 'local', swapped ? remoteExpected : videoEnabled);
  const remoteVideoLive = swapped ? previewVideo.ready : fullVideo.ready;

  /**
   * Whether there is a remote track for the peer's PHOTO to stand in for.
   *
   * The backdrop covers the remote surface with the peer's photo, cover
   * cropped to it exactly as their video would be. That is the honest fill
   * for a connected call whose far camera is off, and a lie before the call
   * connects: a full-bleed face where the remote camera goes is what a live
   * remote camera looks like, so the screen read as connected video while
   * the header still said "Ringing…".
   *
   * `reconnecting` belongs with `connected`: the call HAS connected, the
   * track exists, and the photo is standing in for media that stopped
   * flowing — the case the backdrop was built for.
   *
   * So does `ending`, which is why the test is `connectedAt` rather than a
   * list of phase names: the fact the surface needs is whether this call ever
   * had remote media, and the context already carries it. Named phases alone
   * swapped the full-bleed peer for a 128pt disc for the whole of a hangup,
   * while a call cancelled before it connected (`ending` with no
   * `connectedAt`) correctly stays on the disc.
   *
   * Before either, the person is drawn the way an audio call draws them: one
   * centred disc over the pine ground. No scrim
   * and no blur is added to the connected case instead; theme.ts rules
   * scrims out of the product outright.
   */
  const mediaEstablished =
    state.name === 'connected' ||
    state.name === 'reconnecting' ||
    call?.connectedAt != null;

  // One timer, once per second, only while there is something to count.
  useEffect(() => {
    if (!call?.connectedAt) return undefined;
    const id = setInterval(() => setTick(now()), 1000);
    return () => clearInterval(id);
  }, [call?.connectedAt, now]);

  // The caller gets one qualified hint when an offer has produced neither a
  // ringing acknowledgement nor an answer. This is presentation time only:
  // no reducer state, signaling frame or delivery fact is manufactured.
  useEffect(() => {
    if (
      state.name !== 'outgoing_connecting' ||
      call?.direction !== 'out' ||
      call.remoteReady
    ) {
      return undefined;
    }
    const remaining = call.startedAt + RINGING_ACK_GRACE_MS - now();
    if (remaining <= 0) {
      setTick(now());
      return undefined;
    }
    const id = setTimeout(() => setTick(now()), remaining);
    return () => clearTimeout(id);
  }, [
    state.name,
    call?.cid,
    call?.direction,
    call?.remoteReady,
    call?.startedAt,
    now,
  ]);

  const duration = useMemo(() => durationLabel(state, tick), [state, tick]);
  const announcement = useMemo(
    () => durationAnnouncement(state, tick),
    [state, tick],
  );
  const visibleStatus = useMemo(
    () => statusLabelAt(state, tick),
    [state, tick],
  );
  const styles = useMemo(() => makeStyles(theme), [theme]);

  // The notice, spoken. `accessibilityLiveRegion` is an ANDROID prop —
  // iOS has no live-region support in React Native — so without this a
  // VoiceOver user gets no signal at all when the video quietly drops to
  // "Reduced quality": the exact silence the notice exists to prevent.
  // Announces the visible text, suffix included, so what is heard is what a
  // sighted user would read. Android keeps the live region and skips this,
  // or every change would be spoken twice.
  useEffect(() => {
    if (Platform.OS !== 'ios' || pressureNotice === null) return;
    AccessibilityInfo.announceForAccessibility(
      pressureRestorable
        ? `${pressureNotice} · Tap to restore`
        : pressureNotice,
    );
  }, [pressureNotice, pressureRestorable]);

  useEffect(() => {
    if (Platform.OS !== 'ios' || controlFailure === null) return;
    AccessibilityInfo.announceForAccessibility(controlFailure.message);
  }, [controlFailure]);

  if (state.name === 'idle' || !call) return null;

  // Apply the id-refusal rule used by PeerFace and PeerBackdrop to the three
  // places that spell or SPEAK the name: the header line and the two video
  // labels. App.tsx's fallback for a peer who has never shared a name is
  // `personName(peerId)` — the shortId fragment — so an unnamed caller was
  // read out as characters of their account id on the one surface a stranger
  // holding the phone sees.
  const shownName = tileName(call.peerId, peerName);

  return (
    <View style={styles.root} accessibilityViewIsModal>
      <StatusBar barStyle="light-content" />

      {/* The remote video fills the screen. It renders nothing until a track
          arrives — which is normal, since this screen is up while the call is
          still connecting — so the surface is opaque black rather than a hole
          showing whatever is behind it, and the face below covers it for as
          long as that is all it has to show. */}
      {isVideo && (
        <Pressable
          style={styles.remoteVideo}
          onPress={() => {
            const next = !swapped;
            setSwapped(next);
            onSwappedChange?.(next);
          }}
          accessibilityRole="button"
          accessibilityLabel={
            swapped
              ? 'Your video, full screen'
              : `${shownName}'s video, full screen`
          }
          accessibilityHint="Tap to swap the two videos"
        >
          <TacendumVideoView
            key={fullVideo.surfaceId}
            style={styles.fill}
            surfaceId={fullVideo.surfaceId}
            onFrameReady={fullVideo.onFrameReady}
            cid={call.cid}
            track={swapped ? 'local' : 'remote'}
            mirror={swapped ? frontCamera : false}
            objectFit="cover"
          />
          {/* Over the surface, not behind it: the surface is opaque, so
              anything underneath is invisible by definition. A child of the
              Pressable rather than a sibling, so tap-to-swap still works
              through it. */}
          {!swapped && mediaEstablished && !remoteVideoLive && (
            <PeerBackdrop
              peerId={call.peerId}
              peerName={peerName}
              photoB64={peerAvatarB64}
            />
          )}
          {/* Before the call connects: the audio layout's disc, over the pine
              ground, so the surface is neither black nor mistakable for the
              far camera. `PeerFace` also refuses account IDs, so a
              "name" that is really the peer's id cannot letter this surface
              and the raw name goes down. */}
          {!swapped && !mediaEstablished && (
            <PeerFace
              peerId={call.peerId}
              peerName={peerName}
              photoB64={peerAvatarB64}
              size={128}
              styles={styles}
              ground
            />
          )}
        </Pressable>
      )}

      {/* Local preview, mirrored for the FRONT camera only: people expect
          their own image to behave like a mirror, and expect neither the
          remote image nor the rear camera to. `mirror` was hard-coded, so
          flipping to the rear camera left the world reversed. */}
      {/* `videoEnabled` is a fact about THIS device's camera, and it only
          governs the corner while the corner is showing this device. Once
          swapped the corner carries the OTHER person, so gating it on the
          local camera deleted the only surface the peer had: swap with your
          camera off and they vanished from the call entirely. */}
      {/* Draggable: the wrapper owns the pip's
          position — the top-right home anchor plus an animated shift — and
          carries the pan; the Pressable inside keeps tap-to-swap and its
          VoiceOver contract untouched. PhotoViewer's parent-steals
          arrangement: the Pressable takes the touch, and the wrapper's
          onMoveShouldSetResponder takes it away only once it is clearly a
          drag, so a tap never becomes a 1px drag and a drag never swaps.
          The wrapper is exactly pip-sized and clamped clear of the header
          and control bands, so it cannot sit over — or swallow touches
          meant for — the call controls. */}
      {isVideo && (videoEnabled || swapped) && (
        <Animated.View
          style={[
            styles.pip,
            {
              left: pip.home.x,
              top: pip.home.y,
              width: pipWidth,
              height: pipHeight,
              transform: pip.shift.getTranslateTransform(),
            },
          ]}
          {...pip.panHandlers}
        >
          <Pressable
            style={styles.pipPress}
            onPress={() => {
              const next = !swapped;
              setSwapped(next);
              onSwappedChange?.(next);
            }}
            accessibilityRole="button"
            accessibilityLabel={
              swapped ? `${shownName}'s video, small` : 'Your video, small'
            }
            accessibilityHint="Tap to swap the two videos"
            // The drag, for someone who cannot drag: VoiceOver consumes the
            // one-finger pan for navigation, so repositioning is ALSO four
            // rotor actions, snapping through the same settle a release uses.
            accessibilityActions={PIP_ACCESSIBILITY_ACTIONS}
            onAccessibilityAction={e => {
              const corner = pipCornerForAction(e.nativeEvent.actionName);
              if (corner !== null) pip.snapTo(corner);
            }}
          >
            <TacendumVideoView
              key={previewVideo.surfaceId}
              style={styles.pipVideo}
              surfaceId={previewVideo.surfaceId}
              onFrameReady={previewVideo.onFrameReady}
              cid={call.cid}
              track={swapped ? 'remote' : 'local'}
              mirror={swapped ? false : frontCamera}
              objectFit="cover"
            />
            {/* The peer's picture travels with the peer's TRACK, not with a
                fixed corner: swapped, this small surface is where they are. */}
            {swapped && !remoteVideoLive && (
              <PeerBackdrop
                peerId={call.peerId}
                peerName={peerName}
                // The photo is withheld until there is media for it to stand
                // in for, exactly as on the full surface: a cover-cropped
                // face in the corner reads as the far camera just as
                // readily. The pine ground and the monogram stay, so the
                // corner is never bare black.
                photoB64={mediaEstablished ? peerAvatarB64 : null}
                compact
              />
            )}
          </Pressable>
        </Animated.View>
      )}

      {/* Audio-only shows the person, not a black rectangle. The same
          face the video call falls back to, at the size the whole screen is
          for it. */}
      {!isVideo && (
        <PeerFace
          peerId={call.peerId}
          peerName={peerName}
          photoB64={peerAvatarB64}
          size={128}
          styles={styles}
          labelled
        />
      )}

      <View
        testID="call-header"
        style={[styles.header, { paddingTop: insets.top + 12 }]}
        onLayout={event => {
          const measured = event.nativeEvent.layout.height;
          setHeaderHeight(previous =>
            previous === measured ? previous : measured,
          );
        }}
      >
        {/* Minimize: put the call away, keep it
            going. At the head of the header, where every messaging app keeps
            it, and only when App.tsx offers it — a connected or reconnecting
            call; a ringing one stays full screen because the ringback lives
            on this screen. The hint says what happens, because "minimize" on
            a call screen could be read as ending it. */}
        {onMinimize && (
          <Pressable
            style={({ pressed }) => [
              styles.minimize,
              pressed && styles.minimizePressed,
            ]}
            onPress={onMinimize}
            accessibilityRole="button"
            accessibilityLabel="Minimize call"
            accessibilityHint="Keeps the call going while you use the app"
            testID="call-minimize"
          >
            <MinimizeGlyph size={22} color={theme.color.mediaInk} />
          </Pressable>
        )}
        <Text style={styles.peer} numberOfLines={1}>
          {shownName}
        </Text>
        <View style={styles.statusRow}>
          <Text
            style={styles.status}
            // NOTHING HERE ANIMATES, AND A LIVE REGION IS NOT MOTION
            //. This used to read `reduceMotion ? 'none' :
            // 'polite'`, explained as "the pulse is a static state when
            // Reduce Motion is on" — there is no pulse, and there never was.
            // The branch meant that a person who asked for less animation
            // stopped being told when their call went Ringing → Connected →
            // Reconnecting, which is the one thing this line exists to say.
            accessibilityLiveRegion="polite"
            accessibilityLabel={`${isVideo ? 'Video call' : 'Call'}, ${spokenStatusLabel(visibleStatus)}`}
          >
            {visibleStatus}
          </Text>
          {duration !== null && (
            <Text
              style={styles.duration}
              accessibilityLiveRegion="polite"
              accessibilityLabel={announcement}
            >
              {duration}
            </Text>
          )}
        </View>
        {remoteExpected && !remoteVideoLive && (
          <Text style={styles.status} accessibilityLiveRegion="polite">Video starting…</Text>
        )}
        {state.name === 'connected' && (
          <QualityBars level={quality} status={qualityStatus} theme={theme} />
        )}

        {state.name === 'reconnecting' && (
          <View style={styles.reconnectNotice}>
            <Text
              style={styles.notice}
              accessibilityLiveRegion="polite"
            >
              {state.call.video
                ? 'Connection interrupted. Audio and video may pause while Tacendum reconnects.'
                : 'Connection interrupted. Audio may pause while Tacendum reconnects.'}
            </Text>
            {state.call.video && videoEnabled && (
              <Pressable
                testID="call-reconnect-camera-off"
                style={styles.reconnectAction}
                onPress={runVideoControl}
                disabled={pendingMedia.has('video')}
                accessibilityRole="button"
                accessibilityLabel="Turn camera off while reconnecting"
                accessibilityState={{
                  disabled: pendingMedia.has('video'),
                  busy: pendingMedia.has('video'),
                }}
              >
                <Text style={styles.switchVoiceLabel}>
                  Turn camera off while reconnecting
                </Text>
              </Pressable>
            )}
          </View>
        )}

        {controlFailure !== null && (
          <Text style={styles.controlFailure} accessibilityLiveRegion="polite">
            {controlFailure.message}
          </Text>
        )}

        {/* The design. The video changing under you without explanation is the
            thing this exists to prevent, and a screen reader user gets no
            other signal at all — spoken by the live region on Android and
            by the announceForAccessibility effect above on iOS, where the
            live-region prop does nothing. Tappable only when the tap would
            DO something (Low Power Mode) — a dead button teaches people the
            live one is dead too. ONE Text in both shapes, not a Pressable
            wrapper appearing and vanishing: replacing the node would
            remount the Android live region mid-call, and a replacement's
            first text is not a "change", so the announcement would never
            fire there. The label repeats the visible text so Voice Control
            users can say what they see; the battery cost rides in the
            hint, where this screen already puts its teaching. */}
        {pressureNotice !== null &&
          (pressureRestorable && onRestoreQuality ? (
            <Text
              style={[styles.notice, styles.noticeTappable]}
              accessibilityLiveRegion="polite"
              accessibilityRole="button"
              accessibilityLabel={`${pressureNotice} · Tap to restore`}
              accessibilityHint="Restores full video quality for this call. Uses more battery."
              onPress={() => {
                // The tap's only visible result is this text disappearing —
                // silence, to someone not looking at the screen. Say so.
                AccessibilityInfo.announceForAccessibility(
                  'Restoring full video quality',
                );
                onRestoreQuality();
              }}
            >
              {pressureNotice} · Tap to restore
            </Text>
          ) : (
            <Text style={styles.notice} accessibilityLiveRegion="polite">
              {pressureNotice}
            </Text>
          ))}

        {offerVoice && onSwitchToVoice && (
          <Pressable
            onPress={onSwitchToVoice}
            accessibilityRole="button"
            accessibilityLabel="Switch to voice to save battery"
            style={styles.switchVoice}
          >
            <Text style={styles.switchVoiceLabel}>
              Low battery · Switch to voice
            </Text>
          </Pressable>
        )}
      </View>

      <View style={[styles.controls, { paddingBottom: insets.bottom + 20 }]}>
        <ControlButton
          label={muted ? 'Unmute' : 'Mute'}
          glyph={muted ? 'mic-muted' : 'mic'}
          active={muted}
          disabled={pendingMedia.has('mute')}
          busy={pendingMedia.has('mute')}
          onPress={runMuteControl}
          theme={theme}
        />
        {/* Offered only on a call that NEGOTIATED video (`call.video`): an
            audio call — placed as one, or answered without video — has no
            video m-line and no local video track, and there is no mid-call
            renegotiation path to add one. The toggle on such a call lied
            twice: a black preview here and `call.media{v:true}` to a peer
            whose screen then went full black. No transceiver, no control. */}
        {state.call?.video !== false && (
          <>
            <ControlButton
              label={videoEnabled ? 'Turn camera off' : 'Turn camera on'}
              glyph="camera"
              active={!videoEnabled}
              disabled={pendingMedia.has('video')}
              busy={pendingMedia.has('video')}
              onPress={runVideoControl}
              theme={theme}
            />
            <ControlButton
              label="Flip camera"
              glyph="camera-flip"
              active={false}
              disabled={!videoEnabled || pendingMedia.has('video')}
              onPress={onFlipCamera}
              theme={theme}
            />
          </>
        )}
        {/* Offered only where an earpiece exists to route away from.
            On an iPad every route lands on the
            loudspeaker — `.none` and `.defaultToSpeaker` alike — so the
            toggle would claim a distinction the hardware does not have:
            "Speaker off" over audio still playing out loud is the exact
            route-vs-UI lie the lit-button rule exists to prevent. No
            control, no claim. */}
        {!EARPIECE_KNOWN_ABSENT && (
          <ControlButton
            label={speakerOn ? 'Speaker off' : 'Speaker on'}
            glyph="speaker"
            active={speakerOn}
            onPress={onToggleSpeaker}
            theme={theme}
          />
        )}
        <ControlButton
          label="End call"
          glyph="end-call"
          active={false}
          danger
          onPress={onHangup}
          theme={theme}
        />
      </View>
    </View>
  );
}

function makeStyles(theme: ReturnType<typeof useTheme>) {
  return StyleSheet.create({
    root: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: theme.color.mediaBlack,
      justifyContent: 'space-between',
    },
    header: {
      paddingHorizontal: 20,
      paddingBottom: 12,
      backgroundColor: theme.color.mediaHud,
    },
    /** 44×44 (HIG minimum), pulled 11pt into the gutter so the 22pt glyph's
     * left edge lines up with the name under it. */
    minimize: {
      width: 44,
      height: 44,
      marginLeft: -11,
      marginBottom: 4,
      borderRadius: 22,
      alignItems: 'center',
      justifyContent: 'center',
    },
    minimizePressed: { backgroundColor: theme.color.mediaLine },
    peer: { color: theme.color.mediaInk, fontSize: 22, fontWeight: '600' },
    statusRow: {
      flexDirection: 'row',
      alignItems: 'baseline',
      gap: 10,
      marginTop: 4,
    },
    status: { color: theme.color.mediaInkMuted, fontSize: 15 },
    duration: {
      color: theme.color.mediaInkMuted,
      fontSize: 15,
      fontVariant: ['tabular-nums'],
    },
    // Quiet, not alarming: the phone being warm is normal and the call is
    // still working. A red banner would read as a failure.
    fill: { width: '100%', height: '100%' },
    notice: {
      color: theme.color.mediaInkMuted,
      fontSize: 13,
      marginTop: 6,
      textAlign: 'center',
    },
    reconnectNotice: {
      alignItems: 'center',
      marginTop: 2,
    },
    reconnectAction: {
      minHeight: 44,
      justifyContent: 'center',
      marginTop: 4,
      paddingHorizontal: 14,
      borderRadius: 999,
      borderWidth: 1,
      borderColor: theme.color.mediaLine,
    },
    controlFailure: {
      color: theme.color.mediaInk,
      fontSize: 13,
      marginTop: 8,
      textAlign: 'center',
    },
    /** The tappable shape: padding brings the target to ~45pt (HIG minimum
     * 44), and hugging the text instead of spanning the header keeps a
     * thumb reaching for the video from restoring quality by accident. */
    noticeTappable: {
      alignSelf: 'center',
      paddingHorizontal: 16,
      paddingVertical: 16,
      marginTop: 0,
    },
    switchVoice: {
      marginTop: 10,
      alignSelf: 'center',
      paddingVertical: 8,
      paddingHorizontal: 14,
      borderRadius: 999,
      borderWidth: 1,
      borderColor: theme.color.mediaLine,
    },
    switchVoiceLabel: { color: theme.color.mediaInk, fontSize: 13 },
    controls: {
      flexDirection: 'row',
      justifyContent: 'space-around',
      alignItems: 'center',
      paddingHorizontal: 16,
      paddingTop: 16,
      backgroundColor: theme.color.mediaHud,
    },
    remoteVideo: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
    },
    /** Position (left/top from the corner anchor, plus the drag's translate)
     * rides inline on the wrapper; the box itself is the constants the drag
     * maths above measures with. */
    pip: {
      position: 'absolute',
      // The preview remains above the header's contrast backing.
      zIndex: 1,
      width: PIP_WIDTH,
      // 16:9.
      height: PIP_HEIGHT,
      borderRadius: 12,
      overflow: 'hidden',
      borderWidth: 1,
      borderColor: theme.color.mediaLine,
      backgroundColor: theme.color.mediaBlack,
    },
    /** The tap surface fills the draggable wrapper exactly. */
    pipPress: { flex: 1 },
    pipVideo: { flex: 1 },
    /** Centred over the whole screen for an AUDIO call, where the disc is
     * The designed treatment. Video surfaces use `backdrop` instead. */
    avatarWrap: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      alignItems: 'center',
      justifyContent: 'center',
    },
    /** The same centring, plus the ground: the pine wash the app puts behind
     * every photo-less person on the media surface (`PeerBackdrop`'s own
     * fill). Used where the disc stands inside a video surface, which is
     * opaque black with no track in it. */
    avatarGround: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: theme.color.pineWash,
    },
    // The person-at-surface-size styles (backdrop, backdropPhoto, the two
    // monogram sizes) moved to ../ui/PeerBackdrop.tsx with the component.
  });
}
