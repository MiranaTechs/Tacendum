import React, { useEffect, useMemo, useState } from 'react';
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
import { useSafeAreaFrame, useSafeAreaInsets } from 'react-native-safe-area-context';
import type { CallState } from '@tacendum/shared';
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
// The draggable corner preview's geometry and wiring, lifted out
// so the minimized call window drags through the SAME gesture. The names
// are re-exported below so every existing import of them from this screen —
// the suite's included — keeps meaning what it meant.
import {
  PIP_ACCESSIBILITY_ACTIONS,
  PIP_HEIGHT,
  PIP_WIDTH,
  pipCornerForAction,
  usePipDrag,
} from '../ui/pipDrag';
import { useOutgoingRingback } from '../ui/ringback';
import { useTheme } from '../theme';
import { useReduceMotion } from '../useReduceMotion';

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
  /** 0–3 bars from local getStats. Never leaves the device. */
  quality?: number;
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
  onToggleMute(): void;
  onToggleVideo(): void;
  onFlipCamera(): void;
  onToggleSpeaker(): void;
  onHangup(): void;
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
}: {
  peerId: string;
  peerName: string;
  photoB64?: string | null;
  size: number;
  styles: ReturnType<typeof makeStyles>;
  labelled?: boolean;
}): React.JSX.Element {
  return (
    <View style={styles.avatarWrap} pointerEvents="none">
      <Avatar
        peerId={peerId}
        displayName={peerName}
        photoB64={photoB64}
        size={size}
        {...(labelled ? { accessibilityLabel: `${peerName}'s picture` } : {})}
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
    quality = 0,
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
  const [swapped, setSwapped] = useState(false);

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
  const pip = usePipDrag({
    frame: { width: frame.width, height: frame.height },
    insets: { top: insets.top, bottom: insets.bottom, left: insets.left, right: insets.right },
    reduceMotion,
    motion: theme.motion,
  });

  const call = state.call;
  const isVideo = call?.video === true || call?.peerVideo === true;
  /**
   * Whether the surface carrying the REMOTE track can have anything in it.
   *
   * A `TacendumVideoView` with no track is an opaque black rectangle — the
   * native host paints `.black` behind an empty `RTCMTLVideoView`, which is
   * the honest thing for a surface to do and the wrong thing for a SCREEN to
   * stop at. That rectangle covered the whole display for every second of
   * ringing and connecting, and for every second the far end's camera was
   * off: "person B is all dark screen" (hardware).
   *
   * TWO FACTS, BOTH ALREADY KNOWN HERE, and neither of them a guess:
   *  - `connected` is the machine's word for media actually flowing. Before
   *    it there is no remote track at all — the answer has not been applied —
   *    so there is nothing a renderer could be showing.
   *  - `peerVideo` is the far end's own report of its camera: the answer's
   *    `vid`, then every `call.media` after it. False means they are sending
   *    no video, not that we are waiting for some.
   *
   * Deliberately NOT "has a frame arrived" — nothing publishes that. The
   * remaining gap is the moment between `connected` and the first decoded
   * keyframe, where this still shows black; closing it needs a first-frame
   * event out of the host, and the codegen spec that would carry it belongs
   * to another lane.
   */
  const remoteVideoLive = state.name === 'connected' && call?.peerVideo === true;

  // One timer, once per second, only while there is something to count.
  useEffect(() => {
    if (!call?.connectedAt) return undefined;
    const id = setInterval(() => setTick(now()), 1000);
    return () => clearInterval(id);
  }, [call?.connectedAt, now]);

  const duration = useMemo(() => durationLabel(state, tick), [state, tick]);
  const announcement = useMemo(() => durationAnnouncement(state, tick), [state, tick]);
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
      pressureRestorable ? `${pressureNotice} · Tap to restore` : pressureNotice,
    );
  }, [pressureNotice, pressureRestorable]);

  if (state.name === 'idle' || !call) return null;

  return (
    <View style={styles.root} accessibilityViewIsModal accessibilityLabel="Call">
      <StatusBar barStyle="light-content" />

      {/* The remote video fills the screen. It renders nothing until a track
          arrives — which is normal, since this screen is up while the call is
          still connecting — so the surface is opaque black rather than a hole
          showing whatever is behind it, and the face below covers it for as
          long as that is all it has to show. */}
      {isVideo && (
        <Pressable
          style={styles.remoteVideo}
          onPress={() => setSwapped(v => !v)}
          accessibilityRole="button"
          accessibilityLabel={
            swapped ? 'Your video, full screen' : `${peerName}'s video, full screen`
          }
          accessibilityHint="Tap to swap the two videos"
        >
          <TacendumVideoView
            style={styles.fill}
            cid={call.cid}
            track={swapped ? 'local' : 'remote'}
            mirror={swapped ? frontCamera : false}
            objectFit="cover"
          />
          {/* Over the surface, not behind it: the surface is opaque, so
              anything underneath is invisible by definition. A child of the
              Pressable rather than a sibling, so tap-to-swap still works
              through it. */}
          {!swapped && !remoteVideoLive && (
            <PeerBackdrop
              peerId={call.peerId}
              peerName={peerName}
              photoB64={peerAvatarB64}
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
              transform: pip.shift.getTranslateTransform(),
            },
          ]}
          {...pip.panHandlers}
        >
          <Pressable
            style={styles.pipPress}
            onPress={() => setSwapped(v => !v)}
            accessibilityRole="button"
            accessibilityLabel={
              swapped ? `${peerName}'s video, small` : 'Your video, small'
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
              style={styles.pipVideo}
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
                photoB64={peerAvatarB64}
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

      <View style={[styles.header, { paddingTop: insets.top + 12 }]}>
        {/* Minimize: put the call away, keep it
            going. At the head of the header, where every messaging app keeps
            it, and only when App.tsx offers it — a connected or reconnecting
            call; a ringing one stays full screen because the ringback lives
            on this screen. The hint says what happens, because "minimize" on
            a call screen could be read as ending it. */}
        {onMinimize && (
          <Pressable
            style={({ pressed }) => [styles.minimize, pressed && styles.minimizePressed]}
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
          {peerName}
        </Text>
        <View style={styles.statusRow}>
          <Text
            style={styles.status}
            // The pulse is a static state when Reduce Motion is on; the label
            // still changes, so nothing is lost, only the animation.
            accessibilityLiveRegion={reduceMotion ? 'none' : 'polite'}
          >
            {statusLabel(state)}
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
        {state.name === 'connected' && <QualityBars level={quality} theme={theme} />}

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
                AccessibilityInfo.announceForAccessibility('Restoring full video quality');
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
            <Text style={styles.switchVoiceLabel}>Low battery · Switch to voice</Text>
          </Pressable>
        )}
      </View>

      <View style={[styles.controls, { paddingBottom: insets.bottom + 20 }]}>
        <ControlButton
          label={muted ? 'Unmute' : 'Mute'}
          glyph={muted ? 'mic-muted' : 'mic'}
          active={muted}
          onPress={onToggleMute}
          theme={theme}
        />
        <ControlButton
          label={videoEnabled ? 'Turn camera off' : 'Turn camera on'}
          glyph="camera"
          active={!videoEnabled}
          onPress={onToggleVideo}
          theme={theme}
        />
        <ControlButton
          label="Flip camera"
          glyph="camera-flip"
          active={false}
          disabled={!videoEnabled}
          onPress={onFlipCamera}
          theme={theme}
        />
        {/* Offered only where an earpiece exists to route away from
. On an iPad every route lands on the
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
    header: { paddingHorizontal: 20 },
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
    statusRow: { flexDirection: 'row', alignItems: 'baseline', gap: 10, marginTop: 4 },
    status: { color: theme.color.mediaInkMuted, fontSize: 15 },
    duration: { color: theme.color.mediaInkMuted, fontSize: 15, fontVariant: ['tabular-nums'] },
    // Quiet, not alarming: the phone being warm is normal and the call is
    // still working. A red banner would read as a failure.
    fill: { width: '100%', height: '100%' },
    notice: {
      color: theme.color.mediaInkMuted,
      fontSize: 13,
      marginTop: 6,
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
    // The person-at-surface-size styles (backdrop, backdropPhoto, the two
    // monogram sizes) moved to ../ui/PeerBackdrop.tsx with the component.
  });
}
