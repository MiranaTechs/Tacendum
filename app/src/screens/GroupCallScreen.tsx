import React, {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { StatusBar, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
// The ceilings, asked for rather than transcribed (4 with video by
// default, 5 the hard video cap, 6 audio-only). `smallGroupCallParticipantCap`
// is the one place the audio/video split is decided, so this screen cannot
// disagree with the module that refuses the call.
import { smallGroupCallParticipantCap } from '@tacendum/shared';
import type { LegPhase } from '@tacendum/shared/call-session';
import { EARPIECE_KNOWN_ABSENT } from '../audioRoute';
import type { GroupCallView, LegFanOutcome } from '../call/group';
import {
  ControlButton,
  durationAnnouncementFrom,
  durationFrom,
} from '../components/CallControls';
import { CallTile, tileName } from '../ui/CallTile';
import { useTheme, type Theme } from '../theme';
import { useReduceMotion } from '../useReduceMotion';

/**
 * The small-group call screen.
 *
 * The same product as `CallScreen`, with more tiles: the `mediaBlack` ground,
 * the pine disc, the same control glyphs from the same components. There is
 * no second design language here and no new colour.
 *
 * IT HOLDS NO SESSION LOGIC. Everything it shows is a function of one
 * `GroupCallView` — the coordinator's published summary — and every control is
 * a callback. That is what lets a five-way call in any combination of failure
 * states be rendered in a test with no device, no clock and no coordinator.
 *
 * THE ONE RULE THAT IS NOT COSMETIC: mute renders from `view.muted`, which the
 * coordinator sets AFTER its fan-out has finished (`setMuted`), never from an
 * optimistic local flag. The all-or-close-the-leg means a leg that could not
 * be silenced is CLOSED — so every leg still on screen when `view.muted` is
 * true is genuinely silent, and the ones that are not are visibly gone. An
 * optimistic toggle would break exactly that: a muted icon over a live
 * microphone, which is the worst bug this product can ship.
 */

/** The copy, still a literal rather than a readout — kept word for word
 * so a copy edit stays a conscious act, and the number
 * is a PROMISE ("nothing in this design enables more") rather than a reading
 * of a constant that might drift.
 *
 * SIX NOW, and it used to be five. The five was a deliberate
 * under-promise written while video was in scope: the video ceiling was five,
 * the audio ceiling six, and saying the smaller number kept one sentence true
 * of both. Group video was then cut for v1 ("v1 scope, cut to
 * the launch date"), so every group call is audio and the only ceiling that
 * exists is six — at which point "five" stopped being a safe under-promise
 * and became the app contradicting itself. `atCap` is computed from
 * `smallGroupCallParticipantCap(false)`, so the Add control stays live for a
 * sixth person while this sentence said five; the published pages say six as
 * well. Under-promising is only safe when the product cannot exceed the
 * promise. */
export const CALL_CAP_COPY = 'Calls hold six people. For more, use the room.';

/**
 * Tile columns for a roster of N: 2 people is the 1:1 layout — one tile,
 * full bleed, which is exactly what the last-departure degradation collapses into — 3-4 is
 * a 2×2 grid and 5-6 a 2×3.
 *
 * Counts PARTICIPANTS, not tiles, because that is the number the layout rule
 * is written in and the number the caps are written in; the tile count is
 * always one less (this device has no tile of its own).
 */
export function gridColumns(participants: number): number {
  return participants <= 2 ? 1 : 2;
}

/** Rows the grid needs, for the same reason `gridColumns` exists: 2×2 and 2×3
 * are different shapes and the tile's height comes from this. */
export function gridRows(participants: number): number {
  if (participants <= 2) return 1;
  return Math.ceil((participants - 1) / gridColumns(participants));
}

/**
 * Who the call is with, in words, from LOCAL names only (the ring rule
 * applied to every surface: nothing sender-controlled titles anything).
 * "Ana", "Ana and Ben", "Ana and 2 others".
 */
export function rosterSubtitle(names: readonly string[]): string {
  if (names.length === 0) return 'No one else';
  if (names.length === 1) return names[0]!;
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names[0]} and ${names.length - 1} others`;
}

/**
 * The session's own status line, folded from the legs.
 *
 * One connected leg is a connected call — the aggregate is one CXCall for
 * N legs, and the header answers the same question the lock screen does. The
 * per-participant truth lives on the tiles, which is where the design puts it.
 */
export function sessionStatusLabel(view: GroupCallView): string {
  if (view.phase === 'ringing') return 'Incoming call';
  const phases = new Set<LegPhase>(view.legs.map(l => l.phase));
  if (phases.has('connected')) return 'Connected';
  if (phases.has('reconnecting')) return 'Reconnecting…';
  if (phases.has('connecting')) return 'Connecting…';
  if (phases.has('ringing')) return 'Ringing…';
  if (phases.has('inviting')) return 'Calling…';
  return 'Ending…';
}

export interface GroupCallScreenProps {
  view: GroupCallView;
  /** The name THIS phone holds for a roster member, or null/empty when it
   * holds none. Passed in rather than looked up: the screen has no database,
   * and `tileName` refuses the id fallback either way. */
  nameFor(peerId: string): string | null | undefined;
  /**
   * The picture THIS phone holds for a roster member — `chats.avatarB64`, the
   * same column the thread draws them from — or null/undefined when it holds
   * none, which is the ordinary case.
   *
   * The sibling of `nameFor`, and passed for the same reason: a tile reads
   * nothing and subscribes to nothing, so the caller folds the room's people
   * once and hands both facts down. Optional because a caller that has not
   * adopted it must get exactly the screen it had — a monogram, never a
   * broken image.
   */
  avatarFor?(peerId: string): string | null | undefined;
  /** The room's local name when this call belongs to one (the CallKit handle
   * rule, applied to the header). Never an id. */
  roomName?: string | null;
  /**
   * Whether this device's camera is on. Mirrored by the caller, exactly as
   * `CallScreen`'s `videoEnabled` is: the coordinator fans the toggle across
   * legs but publishes no local track state, because a local track is a
   * device fact rather than a session one.
   */
  cameraOn?: boolean;
  /**
   * Awaited, and its RESOLVED VALUE is what names the people a partial
   * fan-out dropped. The coordinator already knows — it decided, per leg,
   * whether the change applied and closed the ones that did not — so the
   * screen is told rather than left to infer it from the roster shrinking.
   * A `void` resolution means "nothing to report", never "watch and guess".
   */
  onToggleMute(): void | Promise<readonly LegFanOutcome[] | void>;
  /**
   * The device's output route. REQUIRED, unlike the camera: group calls ship
   * audio only, so every session this screen renders has a loudspeaker
   * decision to make wherever the hardware offers one. The prop stays
   * required even though the CONTROL is idiom-gated — on an iPad there is no
   * earpiece and the button is not rendered, but the
   * caller's wiring is one shape on every device. It reports no outcomes
   * because it fans nothing (the coordinator's `setSpeakerEnabled` explains
   * why one route is not N legs).
   */
  onToggleSpeaker(): void;
  onToggleCamera?(): void | Promise<readonly LegFanOutcome[] | void>;
  /** Starter-only growth. Absent for everyone else, because a control
   * that looks live and refuses on press teaches the wrong thing — the
   * onStartCall doctrine, one screen over. */
  onAdd?(): void;
  onEnd(): void;
  /** Present only while the session is ringing at THIS device. */
  onAnswer?(): void;
  onDecline?(): void;
  /** Test seam: a fixed clock keeps the duration and the eight-second
   * "May be offline" threshold deterministic. */
  now?: () => number;
}

export function GroupCallScreen(props: GroupCallScreenProps): React.JSX.Element {
  const {
    view,
    nameFor,
    avatarFor,
    roomName = null,
    cameraOn = false,
    onToggleMute,
    onToggleSpeaker,
    onToggleCamera,
    onAdd,
    onEnd,
    onAnswer,
    onDecline,
    now = Date.now,
  } = props;

  const t = useTheme();
  const insets = useSafeAreaInsets();
  const reduceMotion = useReduceMotion();
  const [tick, setTick] = useState(() => now());
  const styles = useMemo(() => makeStyles(t), [t]);

  /**
   * One second, for as long as anything on this screen is counting.
   *
   * Two things count: a connected call's duration and an unanswered invite's
   * eight seconds. Neither is state — the tick only re-reads the clock — so
   * stopping it early degrades the screen's precision and never its truth.
   */
  const counting =
    view.connectedAt !== null || view.legs.some(l => l.phase === 'inviting');
  useEffect(() => {
    if (!counting) return undefined;
    const id = setInterval(() => setTick(now()), 1000);
    return () => clearInterval(id);
  }, [counting, now]);

  /**
   * WHO THIS FAN-OUT DROPPED, so a partial failure is reported rather than
   * silently absorbed — and NOBODY ELSE.
   *
   * CAUSALITY BY DATA, NOT BY TIME WINDOW. This used to be inferred: arm a
   * flag on press, watch the live set shrink, blame whoever left before the
   * promise settled. That reads a coincidence as a cause — an independent
   * hangup or an ICE failure landing during a toggle was reported as "their
   * leg couldn't be changed", which is a sentence about somebody's microphone
   * that was simply not true. The latch made it worse: a ref set after the
   * coordinator's last view stayed armed until some unrelated later update.
   *
   * The coordinator decides per leg and now says so, so the answer is READ
   * off the resolved promise. There is no flag, no previous-roster snapshot,
   * and no window in which an unrelated failure can be mistaken for this one.
   */
  const [dropped, setDropped] = useState<string[]>([]);

  /**
   * THE OUTCOMES BELONG TO THE SESSION WHOSE FAN PRODUCED THEM.
   *
   * A glare swap installs a new session without an unmount: this screen is
   * rendered for as long as there is any session at all, so session B arrives
   * as a changed view on the same component and every piece of state the
   * screen owns survives it. A banner that outlives its session is reporting
   * that somebody dropped from a call they might be happily inside.
   *
   * Cleared AT RENDER rather than in an effect, the `resolvedPeer` lesson:
   * effects run after the commit, so a reset-in-effect still paints one frame
   * of the previous session's casualties over the new session's roster.
   *
   * AND THE COMPARISON IS THE SESSION KEY, NEVER THE SID. The sid is
   * the one identity the coordinator's own fence calls forgeable — this device
   * does not mint an inbound session's sid, the remote starter does — so a
   * re-ring or a replay wearing a dead call's name read as "same session" here
   * and reset nothing at all. `sessionKey` is the coordinator's incarnation
   * counter, which moves on every identity transition and cannot repeat.
   * Nothing about it is rendered: no screen shows a session id, and this one
   * now holds no sid to show.
   */
  // State keeps the identity change in the same work-in-progress tree as the
  // banner reset. If that render suspends, neither survives to make the retry
  // believe a reset committed when it did not.
  const [previousSessionKey, setPreviousSessionKey] = useState(view.sessionKey);
  if (previousSessionKey !== view.sessionKey) {
    setPreviousSessionKey(view.sessionKey);
    if (dropped.length > 0) setDropped([]);
  }

  // Promise verdicts need the session that actually COMMITTED, not the value
  // captured when their fan was asked and not an identity from an abandoned
  // render. The layout phase publishes B before any late A microtask can paint.
  const committedSessionKey = useRef(view.sessionKey);
  useLayoutEffect(() => {
    committedSessionKey.current = view.sessionKey;
  }, [view.sessionKey]);

  /**
   * WHICH PRESS A VERDICT BELONGS TO.
   *
   * The session check below orders SESSIONS and not presses, and two fans
   * inside one session both pass it: a slow mute fan resolving after a later
   * camera fan painted its own casualties overwrote them — the older answer
   * winning because it was late. That contradicts the rule one line down (a
   * new fan forgets the last fan's dead) and names people the person's most
   * recent press has nothing to do with. So each fan carries an ordinal and
   * only the latest one may write.
   */
  const fanSeq = useRef(0);

  const fan = (act: () => void | Promise<readonly LegFanOutcome[] | void>) => {
    // The session that was ASKED is the only session that may be told: a fan
    // still in flight when the swap lands would otherwise deliver session A's
    // verdict into session B, which the render-time reset above cannot undo
    // because it happens afterwards.
    const asked = view.sessionKey;
    const seq = ++fanSeq.current;
    setDropped([]);
    void Promise.resolve(act())
      .then(outcomes => {
        if (committedSessionKey.current !== asked) return;
        if (fanSeq.current !== seq) return;
        setDropped((outcomes ?? []).filter(o => o.closed).map(o => o.peerId));
      })
      .catch(() => undefined);
  };

  const others = view.legs.map(l => tileName(l.peerId, nameFor(l.peerId)));
  // A room's name outranks the roster listing, and is refused the header if
  // it is an id in disguise — no screen renders a room's id.
  const title =
    roomName && roomName.trim() && roomName.trim() !== view.roomId
      ? roomName.trim()
      : rosterSubtitle(others);

  const status = sessionStatusLabel(view);
  const duration = durationFrom(view.connectedAt, tick);
  const announcement = durationAnnouncementFrom(view.connectedAt, tick);

  const participants = view.roster.length;
  const cap = smallGroupCallParticipantCap(view.video);
  const atCap = participants >= cap;
  const isStarter = view.starterId === view.selfId;
  const columns = gridColumns(participants);

  const droppedNames = dropped.map(peerId => tileName(peerId, nameFor(peerId)));
  const ringing = view.phase === 'ringing' && onAnswer !== undefined;

  return (
    <View style={styles.root} accessibilityViewIsModal accessibilityLabel="Group call">
      <StatusBar barStyle="light-content" />

      <View style={[styles.header, { paddingTop: insets.top + 12 }]}>
        <Text style={styles.title} numberOfLines={1}>
          {title}
        </Text>
        <View style={styles.statusRow}>
          <Text
            style={styles.status}
            accessibilityLiveRegion={reduceMotion ? 'none' : 'polite'}
          >
            {status}
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

        {/* THE MUTE STATE, ANNOUNCED. The button reports `selected` to
            VoiceOver, but a state you have to go and inspect a control to
            learn is not a state the app has told you about — and the person
            most likely to lose track of their own microphone is the one who
            cannot see the glyph. */}
        {view.muted && (
          <Text
            testID="group-call-muted"
            style={styles.notice}
            accessibilityLiveRegion="polite"
          >
            Muted
          </Text>
        )}

        {/* said out loud. A leg that could not be silenced was ended, and
            the person who pressed mute is owed that sentence — the alternative
            is a call that quietly got smaller. */}
        {droppedNames.length > 0 && (
          <Text
            testID="group-call-fan-failure"
            style={styles.failure}
            accessibilityLiveRegion="assertive"
          >
            {droppedNames.length === 1
              ? `${droppedNames[0]} was dropped — their leg couldn’t be changed.`
              : `${droppedNames.join(', ')} were dropped — their legs couldn’t be changed.`}
          </Text>
        )}
      </View>

      {/* The grid. `flexWrap` with a per-tile basis rather than a fixed cell
          size: tiles grow with Dynamic Type instead of clipping their status
          lines, which are the words that make a tile worth having. */}
      <View style={styles.grid} testID="group-call-grid">
        {view.legs.map(leg => {
          // THE COORDINATOR'S ANCHOR, not a screen-owned one. The tick below
          // still re-reads the clock — that is what makes the sentence change
          // without a session input — but the moment it is measured FROM is a
          // session fact, so unmounting and remounting this screen mid-invite
          // cannot reset somebody's "May be offline" to "Calling…".
          const since = leg.invitedAt;
          return (
            <View
              key={leg.peerId}
              style={{ flexBasis: `${100 / columns}%`, padding: t.space.s2 }}
            >
              <CallTile
                leg={leg}
                name={nameFor(leg.peerId)}
                photoB64={avatarFor?.(leg.peerId)}
                silentMs={since === null ? 0 : Math.max(0, tick - since)}
                testID={`group-call-tile-${leg.peerId}`}
              />
            </View>
          );
        })}
      </View>

      <View style={[styles.footer, { paddingBottom: insets.bottom + 20 }]}>
        {/* The cap, stated word for word, at the moment it bites. Shown as text
            and not only as a disabled button: a control that greys out without
            saying why reads as a bug. */}
        {isStarter && onAdd && atCap && (
          <Text testID="group-call-cap" style={styles.cap}>
            {CALL_CAP_COPY}
          </Text>
        )}
        <View style={styles.controls}>
          {ringing ? (
            <>
              <ControlButton
                label="Decline"
                glyph="end-call"
                active={false}
                danger
                onPress={() => onDecline?.()}
                theme={t}
                testID="group-call-decline"
              />
              <ControlButton
                label="Answer"
                glyph="phone"
                active
                onPress={() => onAnswer?.()}
                theme={t}
                testID="group-call-answer"
              />
            </>
          ) : (
            <>
              <ControlButton
                label={view.muted ? 'Unmute' : 'Mute'}
                glyph={view.muted ? 'mic-muted' : 'mic'}
                // FROM THE VIEW. See the file header: the coordinator sets this
                // after the fan-out, so it can never claim a mute it did not
                // achieve on every remaining leg.
                active={view.muted}
                onPress={() => fan(onToggleMute)}
                theme={t}
                testID="group-call-mute"
              />
              {/* The loudspeaker, in the same words as the 1:1 screen because
                  it is the same control. Offered wherever an earpiece exists:
                  group calls are audio only ("v1 scope"), so this
                  is the difference between a five-person call and holding the
                  phone to your ear. On the pad idiom it is NOT rendered
: an iPad has no earpiece, every
                  route lands on the loudspeaker, and a toggle would claim a
                  distinction the hardware does not have — the route-vs-UI lie
                  the lit-button rule exists to prevent.

                  NOT routed through `fan()`, and that is not an oversight. The
                  coordinator does not fan this — one device has one output
                  route — so there are no outcomes to read, and passing it
                  through would clear the "…was dropped" banner on a press that
                  dropped nobody, erasing a sentence about somebody's call that
                  the person is still owed.

                  FROM THE VIEW, like mute: the coordinator writes `speakerOn`
                  only after the bridge call it made resolves, so this cannot
                  light over a route the device did not take. */}
              {!EARPIECE_KNOWN_ABSENT && (
                <ControlButton
                  label={view.speakerOn ? 'Speaker off' : 'Speaker on'}
                  glyph="speaker"
                  active={view.speakerOn}
                  onPress={onToggleSpeaker}
                  theme={t}
                  testID="group-call-speaker"
                />
              )}
              {/* Offered only in a video session. An audio call has no camera,
                  and a button that turns one on would be offering a different
                  call than the one everyone answered. */}
              {view.video && onToggleCamera && (
                <ControlButton
                  label={cameraOn ? 'Turn camera off' : 'Turn camera on'}
                  glyph="camera"
                  active={!cameraOn}
                  onPress={() => fan(onToggleCamera)}
                  theme={t}
                  testID="group-call-camera"
                />
              )}
              {isStarter && onAdd && (
                <ControlButton
                  label="Add someone"
                  glyph="add-person"
                  active={false}
                  disabled={atCap}
                  accessibilityHint={atCap ? CALL_CAP_COPY : undefined}
                  onPress={onAdd}
                  theme={t}
                  testID="group-call-add"
                />
              )}
              <ControlButton
                // Leaving is what a non-starter does, and it is a
                // different act from ending everyone's call.
                label={isStarter ? 'End call' : 'Leave call'}
                glyph="end-call"
                active={false}
                danger
                onPress={onEnd}
                theme={t}
                testID="group-call-end"
              />
            </>
          )}
        </View>
      </View>
    </View>
  );
}

function makeStyles(t: Theme) {
  return StyleSheet.create({
    root: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: t.color.mediaBlack,
      justifyContent: 'space-between',
    },
    header: { paddingHorizontal: 20 },
    title: { color: t.color.mediaInk, fontSize: 22, fontWeight: '600' },
    statusRow: { flexDirection: 'row', alignItems: 'baseline', gap: 10, marginTop: 4 },
    status: { color: t.color.mediaInkMuted, fontSize: 15 },
    duration: {
      color: t.color.mediaInkMuted,
      fontSize: 15,
      fontVariant: ['tabular-nums'],
    },
    notice: { color: t.color.mediaInkMuted, fontSize: 13, marginTop: 6 },
    failure: { color: t.color.dangerOnMedia, fontSize: 13, marginTop: 6 },
    grid: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      alignItems: 'stretch',
      justifyContent: 'center',
      paddingHorizontal: 12,
    },
    /** Controls and the cap line are ONE bottom block, so the sentence that
     * explains a disabled button sits with the button and the safe-area inset
     * is applied once rather than to each of them. */
    footer: { paddingTop: 8 },
    controls: {
      flexDirection: 'row',
      justifyContent: 'space-around',
      alignItems: 'center',
      paddingHorizontal: 16,
      paddingTop: 16,
    },
    cap: {
      color: t.color.mediaInkMuted,
      fontSize: 13,
      textAlign: 'center',
      paddingHorizontal: 24,
    },
  });
}
