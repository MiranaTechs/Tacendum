import React, { useEffect, useMemo, useState } from 'react';
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native';
import {
  useSafeAreaFrame,
  useSafeAreaInsets,
} from 'react-native-safe-area-context';
import type { CallState } from '@tacendum/shared';
import { TacendumVideoView } from 'tacendum-call';
import {
  durationAnnouncementFrom,
  durationFrom,
  PressShade,
} from '../components/CallControls';
import { Avatar } from '../ui/Avatar';
import { EndCallGlyph } from '../ui/CallControlGlyphs';
import { tileName } from '../ui/CallTile';
import { PeerBackdrop } from '../ui/PeerBackdrop';
import {
  PIP_ACCESSIBILITY_ACTIONS,
  PIP_HEIGHT,
  PIP_WIDTH,
  pipCornerForAction,
  usePipDrag,
  type PipBox,
} from '../ui/pipDrag';
import { useKeyboardInset } from '../keyboardInset';
import { useTheme } from '../theme';
import { useReduceMotion } from '../useReduceMotion';
import { statusLabel } from './CallScreen';
import { useVideoReadiness } from '../ui/videoReadiness';

/**
 * The MINIMIZED 1:1 call ("i should be able to
 * go back to the chat from a video call — while the video call is on,
 * minimized on the top right corner and moveable as well, similar to
 * whatsapp").
 *
 * What replaces the full-screen `CallScreen` while the person uses the rest
 * of the app with the call still going: a small window that floats over the
 * routes, parked top-right, draggable to any corner through the SAME drag
 * the self-view uses (`usePipDrag` — one gesture, two surfaces), and a tap
 * brings the full call screen back.
 *
 * Two shapes, one component:
 *  - a VIDEO call is the peer's video in a 110pt 16:9 restore window — the
 *    same box the self-view has always been, so the two pictures read as one
 *    family — with their face standing in whenever their video is not
 *    flowing, and an independent End target beside it;
 *  - an AUDIO call is a compact pill on the app's own surface: their
 *    picture, their name, the running time, and an End control. The app's
 *    surface, not the media black: this window sits over the chat, and a
 *    black rectangle on the white page would read as a hole in it. The full
 *    screen of an audio call is an app screen for the same reason.
 *
 * It renders `CallState` and calls back; it holds no call state of its own,
 * and it is never on glass without the call it shows: App.tsx mounts it in
 * the exact slot `CallScreen` occupies, under the same non-idle condition,
 * so relock, `endCallOnQuiesce`, the peer hanging up and every other
 * terminal path dismiss it exactly as they dismiss the full screen. App.tsx
 * additionally refuses it on every non-workspace route and in a duress
 * session — the full screen is the surface proven over the lock (and it is
 * what a call over the lock still gets); this one belongs to the workspace.
 *
 * NOT `accessibilityViewIsModal`, unlike the two full-screen call surfaces:
 * the whole point is that the app underneath stays usable, and a modal flag
 * here would trap VoiceOver on a 110pt window.
 */

/** The band at the top a minimized call keeps clear of: the thread header
 * (`layout.headerHeight` = 56) plus 8pt of air, so the window never sits on
 * the Back chevron or the call button. */
export const OVERLAY_TOP_CLEARANCE = 64;
/** And at the bottom: the composer band. The same 96 the self-view keeps
 * above the control row — the composer drawer is 64 plus its padding, and
 * the tab rail is 52, so 96 clears both with air. */
export const OVERLAY_BOTTOM_CLEARANCE = 96;

/** The video itself remains the self-view's 110pt box; its independent End
 * target and an 8pt gutter are part of the DRAG geometry so neither can be
 * parked outside the safe area. */
export const OVERLAY_VIDEO_CONTROL_GAP = 8;
export const OVERLAY_VIDEO_END_SIZE = 44;
export const OVERLAY_VIDEO_BOX: PipBox = {
  width: PIP_WIDTH + OVERLAY_VIDEO_CONTROL_GAP + OVERLAY_VIDEO_END_SIZE,
  height: PIP_HEIGHT,
  topClearance: OVERLAY_TOP_CLEARANCE,
  bottomClearance: OVERLAY_BOTTOM_CLEARANCE,
};
/** The audio pill: 6 padding + 32 picture + 8 gap + name/time + a 44pt End
 * target + 6 padding, 56 tall — the HIG minimum touch height with 6pt of air
 * either side of the 44pt disc. */
export const OVERLAY_AUDIO_BOX: PipBox = {
  width: 200,
  height: 56,
  topClearance: OVERLAY_TOP_CLEARANCE,
  bottomClearance: OVERLAY_BOTTOM_CLEARANCE,
};

/**
 * The box the drag is given right now: the shape's box, its bottom band
 * grown by whatever the keyboard covers. The composer's docked keyboard
 * would otherwise sit on a pill parked in a bottom corner — End control
 * included — so the band it keeps clear of grows with the keyboard, and
 * `usePipDrag` re-derives the parked corner the moment the box changes
 * (a window parked at the top does not move; one at the bottom lifts).
 * `useKeyboardInset` is the app's one keyboard truth: the docked strip
 * only, zero for a floating palette, zero on Android where the window itself
 * resizes and the frame already follows.
 */
export function overlayBox(
  shape: 'video' | 'audio',
  keyboardInset: number,
): PipBox {
  const base = shape === 'video' ? OVERLAY_VIDEO_BOX : OVERLAY_AUDIO_BOX;
  if (keyboardInset <= 0) return base;
  return { ...base, bottomClearance: base.bottomClearance + keyboardInset };
}

export interface CallOverlayProps {
  state: CallState;
  peerName: string;
  /** The peer's profile picture, when the database holds one. */
  peerAvatarB64?: string | null;
  /** Tap: bring the full call screen back. */
  onRestore(): void;
  /** The independent End control. Optional: without it the surface restores only. */
  onHangup?(): void;
  /** Test seam: a fixed clock keeps the duration deterministic. */
  now?: () => number;
}

/** What the window says under the name: the running time once media flows,
 * the state's own word before that and while it reconnects. */
export function overlayLine(state: CallState, now: number): string {
  if (state.name === 'connected') {
    return durationFrom(state.call.connectedAt, now) ?? statusLabel(state);
  }
  return statusLabel(state);
}

/** What VoiceOver says for the whole window: the person, then the state —
 * at MINUTE granularity for a connected call, the way the full screen's
 * duration announces, so the label does not churn every second. */
export function overlayAccessibilityLabel(
  state: CallState,
  peerName: string,
  now: number,
): string {
  const shown = state.call ? tileName(state.call.peerId, peerName) : peerName;
  const spoken =
    state.name === 'connected'
      ? durationAnnouncementFrom(state.call.connectedAt, now) ||
        statusLabel(state)
      : statusLabel(state).replace(/…$/, '');
  return `${shown}, ${spoken}`;
}

export function CallOverlay(props: CallOverlayProps): React.JSX.Element | null {
  const {
    state,
    peerName,
    peerAvatarB64,
    onRestore,
    onHangup,
    now = Date.now,
  } = props;
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const frame = useSafeAreaFrame();
  const reduceMotion = useReduceMotion();
  const keyboardInset = useKeyboardInset();
  const [tick, setTick] = useState(() => now());
  const call = state.call;
  const isVideo = call?.video === true || call?.peerVideo === true;
  /** The full screen's gate, unchanged: `connected` is the machine's word for
   * media flowing, `peerVideo` the far end's own report of its camera. */
  const remoteExpected = state.name === 'connected' && call?.peerVideo === true;
  const video = useVideoReadiness(call?.cid ?? '', 'remote', remoteExpected);
  const remoteVideoLive = video.ready;
  /** The full screen's second gate, unchanged too: whether there is a remote
   * track for the peer's PHOTO to stand in for. Before the call connects
   * there is none, and a cover-cropped face where the remote camera goes is
   * what a live remote camera looks like.
   * `reconnecting` counts as connected: the track exists and stopped
   * flowing, which is the case the backdrop was built for. So does `ending`,
   * which is why the test is `connectedAt` rather than a list of phase names:
   * the fact wanted is whether this call ever had remote media, and the
   * context already carries it. A call cancelled before it connected has no
   * `connectedAt`, so it still ends on the letters. */
  const mediaEstablished =
    state.name === 'connected' ||
    state.name === 'reconnecting' ||
    call?.connectedAt != null;

  // The drag, above the idle early-return like every other hook here. The
  // box follows the call's shape and the keyboard: the peer's camera coming
  // on mid-call turns the pill into the video window, the composer's
  // keyboard grows the bottom band, and the hook re-derives the parked
  // corner for the new box either way.
  const pip = usePipDrag({
    frame: { width: frame.width, height: frame.height },
    insets: {
      top: insets.top,
      bottom: insets.bottom,
      left: insets.left,
      right: insets.right,
    },
    box: overlayBox(isVideo ? 'video' : 'audio', keyboardInset),
    reduceMotion,
    motion: theme.motion,
  });

  // One timer, once per second, only while there is something to count.
  useEffect(() => {
    if (!call?.connectedAt) return undefined;
    const id = setInterval(() => setTick(now()), 1000);
    return () => clearInterval(id);
  }, [call?.connectedAt, now]);

  const styles = useMemo(() => makeStyles(theme), [theme]);
  const line = useMemo(() => overlayLine(state, tick), [state, tick]);
  const label = useMemo(
    () => overlayAccessibilityLabel(state, peerName, tick),
    [state, peerName, tick],
  );

  if (state.name === 'idle' || !call) return null;
  const shown = tileName(call.peerId, peerName);

  const a11y = {
    accessibilityRole: 'button' as const,
    accessibilityLabel: label,
    accessibilityHint: 'Returns to the call',
    // The drag, for someone who cannot drag: VoiceOver consumes the
    // one-finger pan for navigation, so repositioning is ALSO four rotor
    // actions, snapping through the same settle a release uses.
    accessibilityActions: PIP_ACCESSIBILITY_ACTIONS,
    onAccessibilityAction: (e: { nativeEvent: { actionName: string } }) => {
      const corner = pipCornerForAction(e.nativeEvent.actionName);
      if (corner !== null) pip.snapTo(corner);
    },
  };

  const position = {
    left: pip.home.x,
    top: pip.home.y,
    transform: pip.shift.getTranslateTransform(),
  };

  if (isVideo) {
    return (
      <Animated.View
        style={[styles.videoRow, position]}
        testID="call-overlay-window"
        {...pip.panHandlers}
      >
        {/* The wrapper owns the position and the pan; the Pressable inside
            keeps the tap. PhotoViewer's parent-steals arrangement, exactly as
            the self-view: the pan claims only past the 12pt threshold, so a
            tap never becomes a 1px drag and a drag never restores. */}
        <Pressable
          style={styles.videoBody}
          onPress={onRestore}
          testID="call-overlay"
          {...a11y}
        >
          <TacendumVideoView
            key={video.surfaceId}
            style={styles.fill}
            surfaceId={video.surfaceId}
            onFrameReady={video.onFrameReady}
            cid={call.cid}
            track="remote"
            objectFit="cover"
          />
          {!remoteVideoLive && (
            <PeerBackdrop
              peerId={call.peerId}
              peerName={peerName}
              // Withheld until there is media for it to stand in for; the
              // wash ground and the monogram stay either way, so the window
              // is never the bare black of a track-less surface.
              photoB64={mediaEstablished ? peerAvatarB64 : null}
              compact
            />
          )}
          {/* Over the video with nothing between them — the full screen's
              header does the same, and theme.ts rules scrims out. */}
          <Text
            style={styles.videoLine}
            numberOfLines={1}
            allowFontScaling={false}
          >
            {line}
          </Text>
        </Pressable>
        {onHangup && (
          <Pressable
            style={styles.videoEnd}
            onPress={onHangup}
            accessibilityRole="button"
            accessibilityLabel="End call"
            testID="call-overlay-end"
          >
            {({ pressed }) => (
              <>
                {/* The disc sits on the chat, not on the video: a press
                    darkens it rather than letting the page through. */}
                {pressed ? (
                  <PressShade radius={OVERLAY_VIDEO_END_SIZE / 2} theme={theme} />
                ) : null}
                <EndCallGlyph size={18} color={theme.color.mediaInk} />
              </>
            )}
          </Pressable>
        )}
      </Animated.View>
    );
  }

  return (
    <Animated.View
      style={[styles.pill, position]}
      testID="call-overlay-window"
      {...pip.panHandlers}
    >
      <Pressable
        style={styles.pillBody}
        onPress={onRestore}
        testID="call-overlay"
        {...a11y}
      >
        <Avatar
          peerId={call.peerId}
          displayName={shown}
          photoB64={peerAvatarB64}
          size={32}
        />
        <View style={styles.pillText}>
          <Text style={styles.pillName} numberOfLines={1}>
            {shown}
          </Text>
          <Text style={styles.pillLine} numberOfLines={1}>
            {line}
          </Text>
        </View>
      </Pressable>
      {/* A SIBLING of the restore surface, not a child: a Pressable inside an
          accessible Pressable is unreachable to VoiceOver. Its own 44pt
          target, and the same drag discipline — past 12pt of movement the
          wrapper takes the touch and the press is cancelled, so a drag that
          starts on End never ends the call. */}
      {onHangup && (
        <Pressable
          style={styles.pillEnd}
          onPress={onHangup}
          accessibilityRole="button"
          accessibilityLabel="End call"
          testID="call-overlay-end"
        >
          {({ pressed }) => (
            <>
              {pressed ? <PressShade radius={22} theme={theme} /> : null}
              <EndCallGlyph size={18} color={theme.color.mediaInk} />
            </>
          )}
        </Pressable>
      )}
    </Animated.View>
  );
}

function makeStyles(theme: ReturnType<typeof useTheme>) {
  return StyleSheet.create({
    fill: { flex: 1 },
    /** The video window: the self-view's box and treatment (12pt radius, a
     * media hairline, black under the surface). */
    videoRow: {
      position: 'absolute',
      width: OVERLAY_VIDEO_BOX.width,
      height: OVERLAY_VIDEO_BOX.height,
      flexDirection: 'row',
      alignItems: 'center',
      gap: OVERLAY_VIDEO_CONTROL_GAP,
    },
    videoBody: {
      width: PIP_WIDTH,
      height: PIP_HEIGHT,
      borderRadius: 12,
      overflow: 'hidden',
      borderWidth: 1,
      borderColor: theme.color.mediaLine,
      backgroundColor: theme.color.mediaBlack,
    },
    /** The end disc every call surface uses: one red under a white glyph,
     * in both appearances. */
    videoEnd: {
      width: OVERLAY_VIDEO_END_SIZE,
      height: OVERLAY_VIDEO_END_SIZE,
      borderRadius: OVERLAY_VIDEO_END_SIZE / 2,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: theme.color.mediaDanger,
    },
    videoLine: {
      position: 'absolute',
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: theme.color.mediaHud,
      paddingHorizontal: 8,
      paddingVertical: 6,
      color: theme.color.mediaInk,
      fontSize: 12,
      fontWeight: '600',
      fontVariant: ['tabular-nums'],
    },
    /** The audio pill: the app's own sheet, over the chat it floats on. In
     * light the sheet is the page's own white, so its outline is its only
     * edge: the solid forest, never a tint of it. */
    pill: {
      position: 'absolute',
      width: OVERLAY_AUDIO_BOX.width,
      height: OVERLAY_AUDIO_BOX.height,
      borderRadius: theme.radius.circle,
      borderWidth: 1,
      borderColor: theme.color.pine,
      backgroundColor: theme.color.paperSheet,
      flexDirection: 'row',
      alignItems: 'center',
      paddingLeft: 6,
      paddingRight: 6,
      gap: 8,
    },
    pillBody: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      // The pill is 56 tall; the whole body is the restore target.
      alignSelf: 'stretch',
    },
    pillText: { flex: 1 },
    pillName: {
      color: theme.color.inkStrong,
      fontSize: 13,
      fontWeight: '600',
    },
    pillLine: {
      color: theme.color.pine,
      fontSize: 12,
      fontVariant: ['tabular-nums'],
    },
    pillEnd: {
      width: 44,
      height: 44,
      borderRadius: 22,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: theme.color.mediaDanger,
    },
  });
}
