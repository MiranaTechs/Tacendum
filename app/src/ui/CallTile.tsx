import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { LegPhase } from '@tacendum/shared/call-session';
import { monogram, shortId } from '../person';
// The app's ONE answer to "what does this person look like": the same
// component the chat list, the thread header and the peer profile draw, so a
// tile and the thread beside it cannot disagree about a face.
import { Avatar } from './Avatar';
import { useTheme, type Theme } from '../theme';

/**
 * One participant's tile in a small-group call.
 *
 * The tile is a pure function of a leg's SUMMARY — its phase and whether this
 * device refused to open it at all — plus the name this phone holds for that
 * person. It reads nothing, subscribes to nothing and decides nothing; the
 * coordinator owns the session and the screen owns the layout.
 *
 * Two rules do the real work here, and both are asserted rather than trusted:
 *
 *  1. A TILE IS NEVER BLANK. Every `LegPhase` maps to a named string, so a
 *     participant is always in a state a person can read. The mapping is a
 *     total `Record<LegPhase, string>` rather than a `switch` with a default,
 *     which is what makes a new phase a compile error instead of an empty
 *     line on someone's screen.
 *  2. A TILE NEVER SHOWS AN ID. `personName` falls back to an id fragment,
 *     which is fine in a chat list and wrong here — this surface is the one a
 *     stranger holding the phone sees, and the rule is the placeholder, never
 *     a raw id. `tileName` catches both forms the fallback can take.
 *
 * NO VIDEO SURFACE YET, and that is deliberate rather than missing: The design keys
 * each remote tile to `TacendumVideoView(cid: legCid)`, and the group layer's
 * `GroupLegView` publishes a peer and a phase but not the leg's cid. Mesh
 * video comes later, gated on a hardware measurement — so until a cid
 * reaches the view, every tile is the avatar-on-pineWash treatment the design names
 * for the audio and camera-off cases, and there is no place a black rectangle
 * could claim a picture that is not arriving.
 *
 * WHICH MAKES THE FACE THE WHOLE OF WHAT A PARTICIPANT LOOKS LIKE — and it
 * was a monogram even for people whose photo the thread beside it was already
 * drawing (hardware: "that goes the same for room call"). The
 * picture arrives as a prop, out of the same `chats.avatarB64` the thread
 * reads, for the same reason the name does.
 */

/** What a tile says for each leg phase. Total by type, so the compiler — not
 * a reviewer — is what notices a new phase with no copy. */
const PHASE_COPY: Record<LegPhase, string> = {
  inviting: 'Calling…',
  ringing: 'Ringing…',
  // "Couldn't reach" and "May be offline" are DIFFERENT FACTS and the design keeps
  // them apart. This one is knowledge: the push mirror was empty when we
  // sent, so this device knows the invite could not wake their phone.
  unreachable: 'Couldn’t reach',
  connecting: 'Connecting…',
  connected: 'Connected',
  reconnecting: 'Reconnecting…',
  failed: 'Couldn’t connect',
  declined: 'Declined',
  left: 'Left',
  // A leg torn down and removable. Distinct from `left`, which is a person's
  // act — this is the leg's own end, including the one glare discards.
  gone: 'Ended',
};

/** The other half of the pair above: an invite that went out and produced no
 * ring at all. Ignorance, not knowledge — hence "may". */
export const MAY_BE_OFFLINE = 'May be offline';

/**
 * How long an unanswered invite stays "Calling…" before it becomes "May be
 * offline". Not a timeout and not a state change: nothing is given up on
 * at eight seconds, and the leg's phase is untouched. It is the point at which
 * the honest thing to show stops being "we are dialling" and starts being "we
 * have heard nothing back".
 */
export const MAY_BE_OFFLINE_MS = 8_000;

/** Legs this device declined to open at all (the safety gates). Held on the
 * view rather than in the session because it is a fact about this phone's
 * relationship with a peer, and it outranks the phase — a blocked peer whose
 * leg never existed must not read as "Calling…". */
const SKIPPED_COPY: Record<'blocked' | 'identity_changed', string> = {
  blocked: 'Not called — you blocked them',
  identity_changed: 'Not called — their safety number changed',
};

/** Phases that will not change again on their own; their tiles go quiet. */
const SETTLED: ReadonlySet<LegPhase> = new Set<LegPhase>([
  'unreachable',
  'failed',
  'declined',
  'left',
  'gone',
]);

/** The placeholder for someone who has never shared a name — the "honest
 * placeholder, never a raw id". */
export const UNNAMED = 'Someone';

export interface TileLeg {
  peerId: string;
  phase: LegPhase;
  skipped: 'blocked' | 'identity_changed' | null;
}

/**
 * The tile's status line.
 *
 * `silentMs` is how long this device has been waiting on this leg with
 * nothing back. It is a CLOCK READING, not a timer that invents state: the
 * screen ticks once a second and hands the elapsed time down, and every other
 * word on the tile still comes from the phase the session reduced. Remove the
 * tick and the tile stays truthful, just less specific — which is the test
 * for whether a view is deriving or guessing.
 */
export function legStatusLabel(leg: TileLeg, silentMs = 0): string {
  if (leg.skipped) return SKIPPED_COPY[leg.skipped];
  if (leg.phase === 'inviting' && silentMs >= MAY_BE_OFFLINE_MS) {
    return MAY_BE_OFFLINE;
  }
  return PHASE_COPY[leg.phase];
}

/**
 * The name a tile may show.
 *
 * `personName`'s fallback is `shortId`, an id fragment — legitimate in a chat
 * list, forbidden here. Both forms it can take are refused BY VALUE rather
 * than by pattern: a name that merely resembles an id is still a name, and a
 * heuristic that ate "Cara" because four of its letters appear in a ULID
 * would be its own kind of lie.
 */
export function tileName(peerId: string, label: string | null | undefined): string {
  const trimmed = (label ?? '').trim();
  if (!trimmed) return UNNAMED;
  if (trimmed === peerId || trimmed === shortId(peerId)) return UNNAMED;
  return trimmed;
}

/** What VoiceOver says for a tile: the name and the state, in one string
 * ("Ana, ringing"). A state only a sighted person can see is not a state
 * the app has communicated. */
export function tileAccessibilityLabel(name: string, status: string): string {
  const spoken = status.replace(/…$/, '');
  return `${name}, ${spoken.charAt(0).toLowerCase()}${spoken.slice(1)}`;
}

export function CallTile({
  leg,
  name,
  photoB64,
  silentMs = 0,
  testID,
}: {
  leg: TileLeg;
  /** The name THIS phone holds. Passed in, never looked up: the tile has no
   * database and the caller already folded the room's names once. */
  name: string | null | undefined;
  /**
   * The picture that person shared, `chats.avatarB64` — the same column the
   * thread reads. Passed in for exactly the reason `name` is: this tile reads
   * nothing and subscribes to nothing, and a database call growing inside a
   * view is how two surfaces start disagreeing about one person.
   *
   * Optional, and absent is the ordinary case: there is no directory, so a
   * face only exists when that person chose to share one.
   */
  photoB64?: string | null;
  silentMs?: number;
  testID?: string;
}): React.JSX.Element {
  const t = useTheme();
  const shown = tileName(leg.peerId, name);
  const status = legStatusLabel(leg, silentMs);
  const settled = leg.skipped !== null || SETTLED.has(leg.phase);
  const styles = makeStyles(t);
  return (
    <View
      // ONE accessibility node per tile. Without `accessible`, VoiceOver reads
      // the name and the status as two unrelated stops and the pairing — which
      // is the entire content of a tile — is lost.
      accessible
      accessibilityLabel={tileAccessibilityLabel(shown, status)}
      {...(testID ? { testID } : {})}
      style={[styles.tile, settled && styles.settled]}
    >
      {/* THE PHOTO WHEN THERE IS ONE, THE MONOGRAM WHEN THERE IS NOT — and
          the two branches are not interchangeable. `Avatar`'s own no-photo
          fallback ends at `monogram`, whose no-name branch is TWO CHARACTERS
          OF THE ULID: correct in a chat list, and the one thing rule 2 above
          forbids on this surface. So the photo branch delegates to the shared
          component and the empty branch keeps the placeholder, rather than
          handing `Avatar` a name it does not have and letting it reach for an
          id. */}
      {photoB64 ? (
        <Avatar
          peerId={leg.peerId}
          displayName={shown}
          photoB64={photoB64}
          size={64}
        />
      ) : (
        <View style={styles.disc}>
          <Text
            // Decoration inside a fixed disc: it must not scale into its own
            // clipping at Dynamic Type XXL, and the tile's own label already
            // carries the name for VoiceOver.
            allowFontScaling={false}
            accessibilityElementsHidden
            importantForAccessibility="no"
            style={styles.monogram}
          >
            {shown === UNNAMED ? '?' : monogram(leg.peerId, shown)}
          </Text>
        </View>
      )}
      {/* No fixed heights below this point. The labels grow with Dynamic
          Type and the tile grows with them; a boxed status line clips at XXL
          and the state a person needs is the thing that disappears. */}
      <Text numberOfLines={1} style={styles.name}>
        {shown}
      </Text>
      <Text style={styles.status}>{status}</Text>
    </View>
  );
}

function makeStyles(t: Theme) {
  return StyleSheet.create({
    tile: {
      flexGrow: 1,
      flexShrink: 1,
      alignItems: 'center',
      justifyContent: 'center',
      paddingVertical: t.space.s6,
      paddingHorizontal: t.space.s5,
      gap: t.space.s3,
      borderRadius: t.radius.button,
      borderWidth: 1,
      borderColor: t.color.mediaLine,
      backgroundColor: t.color.mediaBlack,
    },
    /** A leg that will not change again reads quieter than a live one. The
     * distinction is never colour alone — the status line says the word. */
    settled: { opacity: 0.66 },
    disc: {
      width: 64,
      height: 64,
      borderRadius: 32,
      backgroundColor: t.color.pineWash,
      borderWidth: 1,
      borderColor: t.color.pineLine,
      alignItems: 'center',
      justifyContent: 'center',
    },
    monogram: { color: t.color.mediaInk, fontSize: 22, fontWeight: '600' },
    name: { color: t.color.mediaInk, fontSize: 15, fontWeight: '600', textAlign: 'center' },
    status: { color: t.color.mediaInkMuted, fontSize: 13, textAlign: 'center' },
  });
}
