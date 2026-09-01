import React, {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  AccessibilityInfo,
  AppState,
  ActivityIndicator,
  Clipboard,
  findNodeHandle,
  FlatList,
  Image,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { BLOCK_COPY as BLOCK, disappearLabel } from '../blocking';
import { CallLogRow } from '../components/CallLogRow';
import {
  CameraGlyph,
  CloseGlyph,
  DocumentGlyph,
  LocationGlyph,
  MicGlyph,
  PauseGlyph,
  PhotoGlyph,
  PlayGlyph,
} from '../ui/AttachGlyph';
import {
  currentLocation,
  pickDocument,
  previewFile,
  type PickedDocument,
} from 'tacendum-attach';
import {
  cancelRecording,
  onLevel,
  onPlaybackFinished,
  onPlaybackProgress,
  onRecordingFinished,
  startPlayback,
  startRecording,
  stopPlayback,
  stopRecording,
  type RecordingResult,
} from 'tacendum-audio';
import { useCallState } from '../call';
import * as db from '../db';
import { DEVICE_NOUN } from '../deviceNoun';
import {
  clearFocusedConversation,
  setFocusedConversation,
} from '../messageSound';
import { MENTION_MARK,
  VOICE_MAX_SECONDS,
  displayText,
  encodeEnvelope,
  isCarrierEnvelope,
  // The ordinal mapping and its flattener are envelope.ts's, stated ONCE
  // (two copies of a switch arm drifting is a defect this codebase has
  // shipped before): this screen only styles the segments and injects the
  // resolver — it never re-counts marks.
  mentionSegments,
  parseEnvelope,
  previewFor,
  renderMentionText,
  type Envelope,
} from '../envelope';
import {
  MESSAGE_PHOTO,
  PickCancelled,
  PickDenied,
  PickUnavailable,
  pickImage,
  type PickedImage,
  type PickSource,
} from '../media';
import { useKeyboardInset } from '../keyboardInset';
import { groupDeliveryNotice, messaging } from '../messaging';
import { personName, personRef, sanitizeDisplayName, shortId } from '../person';
import {
  STREAM_EXPIRY_MS,
  streamEdits,
  type StreamEditOverlay,
} from '../streamEdits';
import { createTypingSignaler, TYPING_EXPIRY_MS } from '../typing';
import {
  SAFETY_COPY,
  SAFETY_EXPLAINER,
  SAFETY_STATUS,
  safetyDate,
  safetyGroups,
  safetyStateFor,
  spokenSafetyNumber,
  type SafetyState,
} from '../safety';
import { clockLabel, dayLabel, sameDay } from '../time';
import { useTheme, type Theme } from '../theme';
import { useReduceMotion } from '../useReduceMotion';
import { usePaneWidth } from '../windowClass';
import { Avatar } from '../ui/Avatar';
import { PhoneGlyph, VideoGlyph } from '../ui/CallGlyph';
// `tickLabel` is deliberately NOT imported: this screen announces delivery
// state through STATUS_WORD, which is folded into the whole bubble's
// accessibility label, and the glyph itself is hidden from VoiceOver so the
// state is not read out twice. Two mappings for one fact is one too many.
import { ReplyGlyph } from '../ui/ReplyGlyph';
import { TickGlyph, type TickStatus } from '../ui/TickGlyph';
import {
  InlineError,
  InlineNotice,
  RuledLabel,
  ScreenHeader,
} from '../ui/primitives';
import { QuietRoom } from '../ui/QuietRoom';
import { RoomMark } from '../ui/RoomMark';
// The membership fold: the header's people count folds
// the same authenticated roster slots the send path folds — never a payload
// field, never a guess. GROUP_MAX_MEMBERS bounds what the mention picker can
// put on the wire, matching the MentionEnvelope schema's own cap on `who`.
import { foldRoster, GROUP_MAX_MEMBERS } from '@tacendum/shared/group-fold';
// The call ceiling. Asked of the shared module, never
// re-derived here: a room's call button and the module that would refuse the
// call must agree about the same number, including the audio/video split.
import { smallGroupCallParticipantCap } from '@tacendum/shared';
import { CallPicker } from '../ui/CallPicker';
import { CALL_CAP_COPY } from './GroupCallScreen';
// The approval card: derived at render time from the
// `approvals` table exactly as call chips derive from call_log — never a
// messages row. The deadline helper is shared so the screen's answer path
// and the card's grey-out read one clock arithmetic.
import { ApprovalCard, approvalDeadline } from '../ui/ApprovalCard';
import { AgentBadge } from '../ui/AgentBadge';
import { AGENT_COPY } from '../machine';

interface Props {
  peerId: string;
  onBack: () => void;
  onOpenPeerProfile: () => void;
  onOpenPhoto: (msgId: string, direction: 'in' | 'out') => void;
  /**
   * Place a call to this peer. Optional so the thread renders unchanged
   * wherever calling is not wired yet — the button simply is not offered,
   * which is better than one that does nothing.
   */
  onStartCall?: (kind: 'audio' | 'video') => void;
  /**
   * Open the room's profile when `peerId` names a room.
   * Optional on onStartCall's argument: absent, the header is inert rather
   * than opening a two-person profile over a twelve-person roster.
   */
  onOpenGroupProfile?: () => void;
  /**
   * Place a SMALL-GROUP call to a room. `others`
   * excludes this device; the caller hands it to `startGroupCall`, which is
   * where every session decision lives — this screen chooses WHO and nothing
   * else. Optional for the same reason `onStartCall` is: absent, the room
   * header offers no call button rather than one that does nothing.
   */
  onStartRoomCall?: (others: readonly string[], kind: 'audio' | 'video') => void;
}

/** Tapback choices, with the words VoiceOver should say for each. */
const REACTIONS: { emoji: string; label: string }[] = [
  { emoji: '❤️', label: 'React with heart' },
  { emoji: '👍', label: 'React with thumbs up' },
  { emoji: '😂', label: 'React with laughing face' },
  { emoji: '😮', label: 'React with surprised face' },
  { emoji: '😢', label: 'React with sad face' },
  { emoji: '🔥', label: 'React with fire' },
];

/**
 * The same six as words, for a reaction ALREADY on a message. A peer can send
 * any string up to 16 characters, so anything outside the six falls back to
 * reading the character itself.
 */
const REACTION_WORD: Record<string, string> = {
  '❤️': 'heart',
  '👍': 'thumbs up',
  '😂': 'laughing face',
  '😮': 'surprised face',
  '😢': 'sad face',
  '🔥': 'fire',
};

/** Composer emoji drawer: eight, scannable, not a wrapped buffet. */
const QUICK_EMOJI = ['😀', '😂', '❤️', '👍', '🙏', '🎉', '😢', '✨'];

/** Consecutive same-direction messages inside this window render as a group. */
const GROUP_WINDOW_MS = 5 * 60 * 1000;

/** Scrolling this far dismisses an open reaction rail. */
const RAIL_DISMISS_SCROLL = 24;

/**
 * How close to the end still counts as "reading the newest message". Auto
 * scrolling is conditioned on this: an unconditional scroll-to-end makes
 * history unreadable and closes the reaction rail the instant it opens.
 */
const BOTTOM_SLACK = 24;

/** Trailing debounce on draft writes — one row per pause, not per keystroke. */
const DRAFT_SAVE_MS = 400;

/** A burst of downloads or receipts must coalesce into one requery. */
const REFRESH_DEBOUNCE_MS = 80;

/** How long the message strip confirms a copy before returning to detail. */
const COPIED_MS = 2000;

/** Character counts at which the composer starts, then escalates, a warning. */
const COUNTER_WARN = 3500;
const COUNTER_DANGER = 4500;

/** Longer than this, a name in the placeholder wraps the composer to two lines. */
const PLACEHOLDER_NAME_MAX = 18;

/**
 * Longest @-query the picker chases before deciding the '@' was prose.
 * Names may contain spaces, so the query is not stopped at the first one —
 * the picker simply closes when nothing matches any more.
 */
const MENTION_QUERY_MAX = 32;

/**
 * The mention picker scrolls inside this height rather than growing past it:
 * it sits over a keyboard, and at accessibility text sizes the rows GROW —
 * fewer are visible and the list scrolls, which is the no-clipping posture
 * the emoji drawer and the safety panel already take.
 */
const MENTION_PICKER_MAX_HEIGHT = 216;

/** People-facing copy. A raw exception must never reach the screen. */
const COPY = {
  sendFailed: 'Your message wasn’t sent. Check your connection and try again.',
  tooLong: 'That message is too long to send.',
  photoUnreadable: 'Tacendum couldn’t read that photo. Choose another one.',
  photoTooLarge: 'That photo is too large to send.',
  photoFailed: 'The photo wasn’t sent. Check your connection and try again.',
  fileFailed: 'The document wasn’t sent. Check your connection and try again.',
  voiceFailed:
    'The voice message wasn’t sent. Check your connection and try again.',
  micDenied:
    'Microphone access is off. Turn it on in Settings to record a voice message.',
  micBusyCall: 'You can’t record while you’re on a call.',
  fileTooLarge: 'That document is too large to send. The limit is about 7 MB.',
  locationFailed: 'Your location couldn’t be shared. Try again.',
  locationDenied:
    'Location access is off. Turn it on in Settings to share where you are.',
  reactionFailed: 'Your reaction wasn’t sent. Try again.',
  // Mirrors SAFETY_COPY.changed.blocked. Restated rather than unwrapped because
  // the copy deck types that field nullable.
  safetyBlocked: 'Nothing will send until you review this change.',
  noAccount:
    'Nobody is using that ID yet. Check it with them — or they may not have finished setting up Tacendum.',
  cameraDenied:
    'Tacendum doesn’t have access to your camera. You can turn it on in Settings.',
  libraryDenied:
    'Tacendum doesn’t have access to your photos. You can turn it on in Settings.',
  // The device is named in the
  // platform's own words via the token, here and in the strings below.
  cameraUnavailable: `This ${DEVICE_NOUN} doesn’t have a camera available.`,
  // The message is still in the thread, so it cannot claim to have been
  // removed; and asking for a resend is the only real recovery, because
  // messaging acks and drops a frame that will not decrypt.
  corrupt: (ref: string) =>
    `This message couldn’t be opened. Ask ${ref} to send it again.`,
  // The person's own words are on screen directly above, so the sentence no
  // longer has to describe what it replaced.
  outgoingFailed: 'Not sent.',
  // Spoken, never shown. A Try again tap deletes the failed row and a fresh
  // pending one appears at the bottom of the thread — the control VoiceOver
  // was standing on is gone, and on iOS nothing says so unless it is said.
  retryingAnnounce: 'Sending your message again.',
  offline: `Offline. Your messages are saved on this ${DEVICE_NOUN} and will send when you’re back on.`,
  mismatch: 'These safety numbers didn’t match when you compared them.',
  // Discovery provenance: the server resolved this person, so no
  // friend's hand-off vouches for the account — the comparison does. One
  // line, until this phone records a match.
  serverIntroduced:
    'You found this account through the server. Verify the safety number in person to be sure.',
  // Screenshot notices are events in the room, not speech. iOS cannot block a
  // screenshot; it can only be disclosed — so the disclosure is plain and
  // symmetrical: both sides see the same sentence.
  shotOut: 'You took a screenshot.',
  shotIn: (ref: string) => `${ref} took a screenshot.`,
  // A timer change is announced, never silent — both Signal and WhatsApp do
  // this, and for the same reason: the setting decides what happens to words a
  // person has not typed yet, so changing it behind their back is the one way
  // this feature can actually hurt someone. Shipped without a render branch
  // once, and the thread showed the sender a bubble of {"tcm":"timer"...}
  // while the recipient got nothing at all — asymmetric AND unreadable.
  // "set ... to 1 hour" rather than "on", because the DURATION is the part a
  // person needs to weigh; "turned ... off" gets its own sentence because "set
  // to off" is not English.
  timerOut: (label: string) => `You set disappearing messages to ${label}.`,
  timerIn: (ref: string, label: string) =>
    `${ref} set disappearing messages to ${label}.`,
  timerOffOut: 'You turned disappearing messages off.',
  timerOffIn: (ref: string) => `${ref} turned disappearing messages off.`,
  // Shared Room Vault. Announced on both sides for the same
  // reason a timer change is: either person can change what the other keeps
  // coming back to read, so a silent overwrite of a door code is a trust
  // problem, not a convenience.
  //
  // THE TITLE, NEVER THE VALUE. The row's body is the whole envelope, secret
  // included, and this sentence is the only thing drawn from it — the value
  // lives in vault_items and is shown behind a tap, on one screen, never in a
  // thread that scrolls past a shoulder.
  vaultSetOut: (title: string) => `You saved “${title}” to the vault.`,
  vaultSetIn: (ref: string, title: string) =>
    `${ref} saved “${title}” to the vault.`,
  // A retraction carries no title on the wire — deliberately, so that deleting
  // a credential cannot re-transmit it — so neither sentence can name the item.
  vaultDelOut: 'You removed an item from the vault.',
  vaultDelIn: (ref: string) => `${ref} removed an item from the vault.`,
  // Retracted messages keep their place. Who retracted it matters — "deleted"
  // with no subject reads like the app lost it.
  goneOut: 'You deleted this message.',
  goneIn: (ref: string) => `${ref} deleted this message.`,
  // An edit is never silent: the marker is the whole reason editing is safe
  // to offer at all.
  edited: 'Edited',
  /** The quoted message isn't on this device — deleted here, or it predates
   * this install. Say so rather than showing an empty quote. */
  quoteMissing: 'Original message',
  editFailed: 'Your change wasn’t sent. Try again.',
  deleteFailed: 'That message wasn’t deleted. Try again.',
  // Rooms. The read-only sentence is the honest
  // one: a room containing someone you blocked is read-only for you, because
  // sending around them silently is itself the tell blocking exists to
  // prevent.
  roomBlocked: `Someone in this room is blocked on this ${DEVICE_NOUN}. You can read, but nothing sends until you unblock them or leave.`,
  roomNotIn: 'You aren’t in this room any more, so nothing sends here.',
  /** The outsider tag: a message from someone the roster says is out
   * renders visibly tagged and attributed — never as a member's bubble,
   * never silently dropped. Some of these are honest words from someone who
   * has not yet seen their removal. */
  outsiderTag: (name: string) => `${name} isn’t in this room.`,
  /** The second-hand tag (history sharing). Says WHO is making the claim,
   * because that is the only party the ratchet actually authenticated. */
  sharedTag: (relayer: string, author: string) =>
    `${relayer} shared this. ${author} wrote it, if ${relayer}’s copy is right.`,
  /** The loud skip: named, persistent, and the room does NOT pause. */
  roomSkip: (names: string) =>
    `${names} isn’t receiving messages in this room until you review their safety number change.`,
  roomSkipMany: (names: string) =>
    `${names} aren’t receiving messages in this room until you review their safety number changes.`,
  /** one sentence louder for the owner: their identity governs the
   * roster, so their roster changes also sit unreviewed. */
  roomSkipOwner:
    'They run this room, so changes to who’s in it also wait until you review.',
  /**
   * THE PRE-CONSENT TEACHING LINE. The consent refusal gates DELIVERY, server-side, which
   * is exactly right — and invisible: a runtime test showed a second human
   * staring at unanswered @mentions of an agent that never heard them, with
   * no hint why. This one quiet LOCAL line (no envelope, no announcement —
   * consent announcements stay decision-time) says what this device knows and
   * points at the choice. Undecided and refused get their own sentence,
   * because "you haven't chosen" and "you chose not to" are different
   * truths.
   *
   * HEDGED, deliberately: the line reads this
   * client's LOCAL record, which the code knowingly lets drift —
   * setRoomConsent writes the server edge FIRST and swallows a failed local
   * write ("the edge stands; only this client's local record is poorer"),
   * and another device of this account keeps its own record. So 'undecided'
   * here can coexist with a live edge, and there is no route to ask the
   * server. The copy therefore claims likelihood, never verified
   * non-delivery.
   */
  roomConsentUndecided: (name: string) =>
    `${name} likely can’t hear you here — you haven’t chosen whether to share with it on this ${DEVICE_NOUN}. The choice is in this room’s settings.`,
  roomConsentRefused: (name: string) =>
    `${name} shouldn’t be able to hear you here — you chose not to share with it. You can change that in this room’s settings.`,
  /**
   * Mentions inside a reply are OUT OF SCOPE, deliberately (the mentions
   * contract): ReplyEnvelope also carries `text`, and composing the two
   * badly now is worse than composing them later. The refusal is loud and
   * at compose — the alternative is silently sending my private name for
   * someone as literal text, which is the one thing a mention must never do.
   */
  mentionReply:
    'A reply can’t carry an @-mention yet. Remove the mention, or send it as its own message.',
};

/**
 * The sentence for one room event row.
 *
 * EVERY subject here derives from the AUTHENTICATED author — `row.authorId`
 * for an inbound row, this phone for an outbound one — never from a payload
 * field and never from bubble position. Counted versus declined is decided
 * the same way the receive path decided it: against the anchor's owner, a
 * constant, so the classification is deterministic forever. The one payload
 * field a sentence may name is the OBJECT (`m`, the member acted on), which
 * is the write's content, not its authorship.
 */
export function roomEventSentence(args: {
  envelope: Envelope;
  out: boolean;
  authorId: string | null | undefined;
  ownerId: string | null;
  selfId: string | null;
  nameFor: (id: string) => string;
  /** Whether an id is a recorded machine — grp.roster sentences name
   * an agent WITH its attribution ("Claude — your AI agent"), because the
   * agent's join is the group-visible Art. 50 roster event. Derived from the
   * machine record like every badge; the sentence's SUBJECT still comes from
   * the authenticated author and its OBJECT from `m`, unchanged. */
  isAgentId?: (id: string) => boolean;
}): string | null {
  const { envelope, out, ownerId, selfId, nameFor } = args;
  const isAgent = args.isAgentId ?? (() => false);
  const writer = out ? selfId : (args.authorId ?? null);
  const subject = out ? 'You' : writer ? nameFor(writer) : 'Someone';
  const ownerName = ownerId
    ? ownerId === selfId
      ? 'you'
      : nameFor(ownerId)
    : 'the person who runs this room';
  if (envelope.tcm === 'grp.new') {
    return `${subject} started this room.`;
  }
  if (envelope.tcm === 'grp.roster') {
    const object =
      envelope.m === selfId
        ? 'you'
        : isAgent(envelope.m)
          ? AGENT_COPY.attributed(nameFor(envelope.m))
          : nameFor(envelope.m);
    if (writer !== null && writer === envelope.m) {
      // The sovereign self lane: nobody can write it but them.
      // An agent's own join/leave carries the attribution mid-sentence:
      // "Claude — your AI agent — joined."
      const self =
        !out && isAgent(writer) ? `${AGENT_COPY.attributed(subject)} —` : subject;
      return envelope.s === 'out'
        ? `${self} left.`
        : `${self} joined.`;
    }
    if (writer !== null && ownerId !== null && writer === ownerId) {
      return envelope.s === 'in'
        ? `${subject} added ${object}.`
        : `${subject} removed ${object}.`;
    }
    // Declined, attributed, never silent: dead the moment it arrived.
    return envelope.s === 'in'
      ? `${subject} tried to add ${object}. Only ${ownerName} can change who’s in this room.`
      : `${subject} tried to remove ${object}. Only ${ownerName} can change who’s in this room.`;
  }
  if (envelope.tcm === 'grp.consent') {
    // The member-consent announcement. The SUBJECT is
    // the authenticated writer (a member narrating their OWN stance — there
    // is no subject on the wire to forge); the OBJECT is the one agent the
    // payload names, a room co-member. The agent wears its attribution only
    // where the machine record names it (the agent's own owner); a second
    // human, whose record does not, sees the plain name — honest, because it
    // is not their agent. The refusal is the load-bearing line ("Bob isn't
    // sharing with Claude"): a member the agent cannot hear is a fact every
    // author deserves before typing.
    const agent = isAgent(envelope.a)
      ? AGENT_COPY.attributed(nameFor(envelope.a))
      : nameFor(envelope.a);
    return envelope.s === 'share'
      ? out
        ? `You’re sharing with ${agent}.`
        : `${subject} is sharing with ${agent}.`
      : out
        ? `You’re not sharing with ${agent}.`
        : `${subject} isn’t sharing with ${agent}.`;
  }
  if (envelope.tcm === 'grp.hist') {
    // Rule 3 of the history-share decision, rendered. The authors could not
    // consent — their words were already sent — so the one thing they get is
    // being told, by name and by extent. Counted versus declined is derived
    // here exactly as the roster's is, from the writer against the anchor's
    // owner, which is a constant.
    const object = envelope.to === selfId ? 'you' : nameFor(envelope.to);
    const count =
      envelope.c === 1 ? '1 earlier message' : `${envelope.c} earlier messages`;
    if (writer !== null && ownerId !== null && writer === ownerId) {
      return `${subject} shared ${count} with ${object}.`;
    }
    return `${subject} tried to share ${count} with ${object}. Only ${ownerName} can share this room’s history.`;
  }
  if (envelope.tcm === 'grp.set') {
    const label = disappearLabel(envelope.s);
    // `0` asserts no constraint — it never drags the room to "off",
    // so the sentence claims only the writer's own slot.
    return label === null
      ? `${subject} turned their disappearing-message timer off.`
      : `${subject} set disappearing messages to ${label}.`;
  }
  if (envelope.tcm === 'grp.del') {
    // Only a DECLINED grp.del ever persists as a row — a counted one purges
    // the room it would have announced into.
    return `${subject} tried to delete this room for everyone. Only ${ownerName} can do that.`;
  }
  return null;
}

// --- @-mentions: the compose-side model (the mentions contract) ---------
//
// THE INVARIANT THIS BLOCK EXISTS TO HOLD: the wire's `text` marks and its
// `who` ids are NEVER produced separately. `mentionWire` derives both in one
// left-to-right walk over one array of chips, so the Nth mark and the Nth id
// come from the same chip by construction — the UI cannot produce the
// mismatch that compose refuses, because there is no second bookkeeping to
// fall out of step.
//
// A chip records the exact characters it stands behind (`@` + the name this
// phone showed at pick time). It is only ever BELIEVED after re-validation
// against the draft (`liveMentionChips`), so every programmatic draft write —
// the post-send clear, the saved-draft load, an edit borrowing the composer —
// degrades stale chips to plain visible text instead of silently mentioning
// whoever used to be at that offset. Person-made edits go through
// `shiftMentionChips`, which keeps chips the edit did not touch and drops any
// chip the edit cut into: what survives is exactly what the person can see.

/** One live mention in the composer: WHO, and the exact span of draft text
 * (`@` + the name this phone showed) standing in for them. */
export interface MentionChip {
  id: string;
  /** The name as shown at pick time — matching text, never wire content. */
  name: string;
  /** Index of the '@' in the draft. */
  start: number;
  /** Exclusive end of the token (start + 1 + name.length). */
  end: number;
}

/** The one contiguous span an edit changed: common prefix `p`, common suffix
 * `s`, computed so they never overlap. One text event is one contiguous
 * replacement — typing, deletion, paste and autocorrect all fit it. */
function editSpan(prev: string, next: string): { p: number; s: number } {
  const max = Math.min(prev.length, next.length);
  let p = 0;
  while (p < max && prev[p] === next[p]) p += 1;
  let s = 0;
  while (
    s < max - p &&
    prev[prev.length - 1 - s] === next[next.length - 1 - s]
  ) {
    s += 1;
  }
  return { p, s };
}

/** Where the caret lands after an edit: the end of what was just inserted.
 * Lets the picker follow typing on the keystroke itself, before the input's
 * own selection event confirms it. */
export function caretAfterEdit(prev: string, next: string): number {
  return next.length - editSpan(prev, next).s;
}

/**
 * Carry chips across one text edit. A chip wholly before the change keeps its
 * place; wholly after, it shifts by the edit's delta; a chip the edit CUT
 * INTO stops being a mention — its surviving characters stay in the draft as
 * the plain text the person just made of them, visibly no longer a chip.
 */
export function shiftMentionChips(
  prev: string,
  next: string,
  chips: MentionChip[],
): MentionChip[] {
  if (prev === next) return chips;
  const { p, s } = editSpan(prev, next);
  const changedEnd = prev.length - s;
  const delta = next.length - prev.length;
  const out: MentionChip[] = [];
  for (const chip of chips) {
    if (chip.end <= p) {
      out.push(chip);
    } else if (chip.start >= changedEnd) {
      out.push({ ...chip, start: chip.start + delta, end: chip.end + delta });
    }
    // else: the edit reached into the token — no longer a mention.
  }
  return out;
}

/**
 * The chips the draft still actually carries: each span must read exactly
 * `@name`, in order. THE GATE every consumer goes through — the strip, the
 * picker's arithmetic and the send path all see only what survives this, so
 * a draft rewritten around the chips can degrade a mention to plain text but
 * can never mention someone the visible text does not name.
 */
export function liveMentionChips(
  draft: string,
  chips: MentionChip[],
): MentionChip[] {
  return chips
    .filter(
      chip =>
        chip.start >= 0 &&
        chip.end <= draft.length &&
        draft.slice(chip.start, chip.end) === `@${chip.name}`,
    )
    .sort((a, b) => a.start - b.start);
}

/**
 * The active @-query at the caret, or null when the caret is not completing
 * one. An '@' triggers only on a word boundary — `a@b` is an address, not a
 * summons — and never from inside an already-settled chip, so the picker
 * does not reopen over a mention that is finished.
 */
export function mentionQueryAt(
  draft: string,
  caret: number | null,
  chips: MentionChip[],
): { at: number; query: string } | null {
  if (caret === null) return null;
  const end = Math.max(0, Math.min(caret, draft.length));
  for (let i = end - 1; i >= 0 && end - i <= MENTION_QUERY_MAX + 1; i -= 1) {
    const ch = draft[i]!;
    if (ch === '\n') return null;
    if (ch !== '@') continue;
    if (i > 0 && !/\s/.test(draft[i - 1]!)) return null;
    if (chips.some(chip => i >= chip.start && i < chip.end)) return null;
    return { at: i, query: draft.slice(i + 1, end) };
  }
  return null;
}

/**
 * The wire form: one MENTION_MARK where each chip stood, `who` in the SAME
 * order, both from ONE walk (the invariant above). Literal U+FFFC characters
 * a person pasted into the plain text are stripped — a mark the walk did not
 * put there is the one way marks could outnumber ids, and compose refusing
 * that mismatch is only safe because this function makes it unreachable.
 */
export function mentionWire(
  draft: string,
  chips: MentionChip[],
): { text: string; who: string[] } {
  const who: string[] = [];
  let text = '';
  let pos = 0;
  for (const chip of liveMentionChips(draft, chips)) {
    text += draft.slice(pos, chip.start).split(MENTION_MARK).join('');
    text += MENTION_MARK;
    who.push(chip.id);
    pos = chip.end;
  }
  text += draft.slice(pos).split(MENTION_MARK).join('');
  return { text: text.trim(), who };
}

/** 'you' / 'you and Ana' / 'Ana, Ben and you' — the label clause's list. */
function namesInSentence(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

interface SendError {
  message: string;
  /** True when the sentence names Settings, so an action can be offered. */
  settings: boolean;
  /** Bumped per failure so an identical repeat is announced again. */
  seq: number;
}

/** Map a thrown error onto fixed copy; never surface the original text. */
/**
 * A peer-controlled filename, made safe to DRAW.
 *
 * Two attacks, both classic and both cheap to close: bidirectional control
 * characters reverse the visible extension (U+202E turns "photo\u202Egnp.exe"
 * into something that reads as "photo.png"), and control characters or
 * newlines break out of the row's shape. Stripped, not escaped — there is no
 * legitimate filename that needs them, and the sanitised name is what the
 * QuickLook title shows too.
 */
function safeFileName(name: string): string {
  const stripped = name
    // Bidi overrides/embeddings/isolates, zero-width, and C0/C1 controls.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g, '')
    .trim();
  return stripped.length > 0 ? stripped : 'Document';
}

/** '3.2 MB' / '412 KB' — one decimal above a megabyte, none below. */
function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

/**
 * A document bubble: name, size, state. The bytes never render — tapping a
 * READY row hands them to QuickLook, whose temp file dies with the preview.
 */
function FileContent({
  theme: t,
  msgId,
  direction,
  name,
  size,
  attachment,
  out,
  onRetry,
}: {
  theme: Theme;
  msgId: string;
  direction: 'in' | 'out';
  name: string;
  size: number;
  attachment?: AttachmentMeta;
  out: boolean;
  onRetry(): void;
}): React.JSX.Element {
  const state = attachment?.state ?? 'pending';
  const shownName = safeFileName(name);
  // TRUTH OVER CLAIM. `size` is the sender's word; once the bytes are here,
  // their length is a fact. base64 carries 3 bytes per 4 characters, so this
  // is exact to within the padding (at most 2 bytes) — and it is the only
  // number that cannot be a lie.
  const shownSize =
    state === 'ready' && attachment?.b64len
      ? Math.floor((attachment.b64len * 3) / 4)
      : size;
  const ink = out ? t.color.onBubbleOut : t.color.inkStrong;
  const sub = out ? t.color.onBubbleOut : t.color.inkMuted;
  const open = () => {
    if (state === 'failed') return onRetry();
    if (state !== 'ready') return;
    // Bytes loaded ON TAP, not held in list state — a thread of documents
    // must not keep every document in memory to scroll.
    void (async () => {
      const row = await db.getAttachment(msgId, direction).catch(() => null);
      if (row?.dataB64) {
        await previewFile(row.dataB64, shownName).catch(() => undefined);
      }
    })();
  };
  return (
    <Pressable
      onPress={open}
      accessibilityRole="button"
      accessibilityLabel={`Document, ${shownName}, ${formatBytes(shownSize)}${
        state === 'ready' ? '' : state === 'failed' ? ', tap to retry' : ', downloading'
      }`}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 10, minWidth: 0 }}
    >
      <DocumentGlyph size={26} color={ink} />
      <View style={{ flexShrink: 1, minWidth: 0 }}>
        <Text numberOfLines={2} style={[t.type.message, { color: ink }]}>
          {shownName}
        </Text>
        <Text style={[t.type.compactBody, { color: sub }]}>
          {state === 'ready'
            ? formatBytes(shownSize)
            : state === 'failed'
              ? 'Tap to retry'
              : 'Downloading…'}
        </Text>
      </View>
    </Pressable>
  );
}

/** m:ss for a duration in seconds. */
function clockDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * A voice note: one control, the duration, and nothing else.
 *
 * The bytes are loaded ON TAP and handed straight to the native player,
 * which decodes them from memory — a received voice note never becomes a
 * file. Holding them in list state instead would keep every note in a long
 * thread resident just to scroll past it.
 */
function VoiceContent({
  theme: t,
  msgId,
  direction,
  seconds,
  attachment,
  out,
  playing,
  elapsed,
  onToggle,
  onRetry,
}: {
  theme: Theme;
  msgId: string;
  direction: 'in' | 'out';
  seconds: number;
  attachment?: AttachmentMeta;
  out: boolean;
  playing: boolean;
  /** Play head in seconds while this note is the one playing, else 0. */
  elapsed: number;
  onToggle(): void;
  onRetry(): void;
}): React.JSX.Element {
  const state = attachment?.state ?? 'pending';
  const ink = out ? t.color.onBubbleOut : t.color.inkStrong;
  const sub = out ? t.color.onBubbleOut : t.color.inkMuted;
  const Glyph = playing ? PauseGlyph : PlayGlyph;
  return (
    <Pressable
      onPress={state === 'failed' ? onRetry : onToggle}
      disabled={state === 'pending'}
      accessibilityRole="button"
      accessibilityLabel={`Voice message, ${clockDuration(seconds)}${
        state === 'ready'
          ? playing
            ? `, playing, ${clockDuration(elapsed)} in`
            : ''
          : state === 'failed'
            ? ', tap to retry'
            : ', downloading'
      }`}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}
      testID={`voice-${msgId}-${direction}`}
    >
      {state === 'ready' ? (
        <Glyph size={24} color={ink} />
      ) : (
        <MicGlyph size={24} color={sub} />
      )}
      <View style={{ flex: 1, minWidth: 132, gap: 4 }}>
        {/* The track fills as the note plays, and stands empty when it is
            not playing — so the row says "how far in am I" at a glance,
            which a bare duration never could. Identical on both sides;
            only the ink differs, because a bubble's own colours do. */}
        <View
          style={[
            styles.voiceTrack,
            {
              backgroundColor: out ? t.color.bubbleOutLine : t.color.pineWashFaint,
            },
          ]}
        >
          <View
            style={[
              styles.voiceTrackFill,
              {
                backgroundColor: ink,
                width: `${
                  playing && seconds > 0
                    ? Math.round(Math.max(0, Math.min(1, elapsed / seconds)) * 100)
                    : 0
                }%`,
              },
            ]}
          />
        </View>
        <View style={styles.voiceMetaRow}>
          {/* Counting UP while playing, total when idle — the WhatsApp
              reading: the number always means "the part you have heard". */}
          <Text style={[t.type.compactStrong, { color: ink }]}>
            {clockDuration(playing ? elapsed : seconds)}
          </Text>
          <Text style={[t.type.compactBody, { color: sub }]}>
            {state === 'ready'
              ? playing
                ? clockDuration(seconds)
                : 'Voice message'
              : state === 'failed'
                ? 'Tap to retry'
                : 'Downloading…'}
          </Text>
        </View>
      </View>
    </Pressable>
  );
}

/**
 * A place, as a CARD — no map tile is ever fetched to draw this bubble,
 * because a tile request would tell a map server where your contact is. The
 * map is the platform's own, opened deliberately by a tap: Apple Maps via URL
 * on iOS, whatever handles a `geo:` URI on Android (a deliberate platform
 * divergence — a maps.apple.com URL on Android would open a BROWSER, and
 * the request would tell Apple's server where your contact is).
 */
function LocationContent({
  theme: t,
  lat,
  lng,
  out,
}: {
  theme: Theme;
  lat: number;
  lng: number;
  out: boolean;
}): React.JSX.Element {
  const ink = out ? t.color.onBubbleOut : t.color.inkStrong;
  const sub = out ? t.color.onBubbleOut : t.color.inkMuted;
  return (
    <Pressable
      onPress={() =>
        void Linking.openURL(
          Platform.OS === 'android'
            ? `geo:${lat.toFixed(6)},${lng.toFixed(6)}?q=${lat.toFixed(6)},${lng.toFixed(6)}(Shared%20location)`
            : `https://maps.apple.com/?ll=${lat.toFixed(6)},${lng.toFixed(6)}&q=Shared%20location`,
        ).catch(() => undefined)
      }
      accessibilityRole="button"
      accessibilityLabel="Shared location, opens in Maps"
      style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}
    >
      <LocationGlyph size={26} color={ink} />
      <View>
        <Text style={[t.type.message, { color: ink }]}>Location</Text>
        <Text style={[t.type.compactBody, { color: sub }]}>Open in Maps</Text>
      </View>
    </Pressable>
  );
}

function sendErrorFor(
  err: unknown,
  kind:
    | 'text'
    | 'photo'
    | 'file'
    | 'voice'
    | 'location'
    | 'reaction'
    | 'edit'
    | 'delete',
): Omit<SendError, 'seq'> {
  // Classes before strings: a first-ever permission denial used to be reported
  // as a connection problem, which sends the person nowhere they can fix it.
  if (err instanceof PickDenied) {
    return {
      message: err.source === 'camera' ? COPY.cameraDenied : COPY.libraryDenied,
      settings: true,
    };
  }
  if (err instanceof PickUnavailable) {
    return { message: COPY.cameraUnavailable, settings: false };
  }
  const raw = err instanceof Error ? err.message : '';
  // Native rejections carry the reason in `code` — a TurboModule reject()
  // puts the human sentence in `message`, so matching only on message read
  // "file is 8388608 bytes" as an unclassified failure and showed the
  // generic connection error for a size problem the person can act on.
  const code =
    typeof (err as { code?: unknown })?.code === 'string'
      ? (err as { code: string }).code
      : '';
  const plain = (message: string) => ({ message, settings: false });
  if (raw.includes('safety number changed')) return plain(COPY.safetyBlocked);
  if (raw.includes('no account for this id')) return plain(COPY.noAccount);
  if (code === 'too_large' || raw.includes('too large to send')) {
    if (kind === 'file') return plain(COPY.fileTooLarge);
    return plain(kind === 'photo' ? COPY.photoTooLarge : COPY.tooLong);
  }
  if (code === 'denied' && kind === 'voice') {
    return { message: COPY.micDenied, settings: true };
  }
  if (code === 'call_active') return plain(COPY.micBusyCall);
  if (code === 'denied' && kind === 'location') {
    return { message: COPY.locationDenied, settings: true };
  }
  if (raw.includes('photo unreadable')) return plain(COPY.photoUnreadable);
  if (kind === 'photo') return plain(COPY.photoFailed);
  if (kind === 'file') return plain(COPY.fileFailed);
  if (kind === 'voice') return plain(COPY.voiceFailed);
  if (kind === 'location') return plain(COPY.locationFailed);
  if (kind === 'reaction') return plain(COPY.reactionFailed);
  if (kind === 'edit') return plain(COPY.editFailed);
  if (kind === 'delete') return plain(COPY.deleteFailed);
  return plain(COPY.sendFailed);
}

/**
 * Fire-and-forget database work.
 *
 * A relock closes the connection BEFORE the route changes,
 * so a debounced requery, a draft flush or an opened-at stamp can legitimately
 * arrive after the latch is on. The latch has already guaranteed the work went
 * nowhere — swallowing the rejection only stops a screen that is being torn
 * down from red-boxing on its way out.
 */
function quiet<T>(work: Promise<T>, then?: (value: T) => void): void {
  work.then(value => then?.(value)).catch(() => {});
}

/** What VoiceOver says for a delivery state — never punctuation names. */
const STATUS_WORD: Record<string, string> = {
  pending: 'Sending',
  sent: 'Sent',
  delivered: 'Delivered',
  // The only status that came from the other PERSON rather than from the
  // server, and the only one they can switch off.
  read: 'Read',
  received: 'Received',
};

/** Attachment row without its bytes — all the thread needs to lay a photo out. */
type AttachmentMeta = Omit<db.AttachmentRow, 'dataB64'> & {
  /** Length of the stored base64, computed in SQL — see listAttachmentMeta. */
  b64len?: number | null;
};

/** The thread-side face of a call row: adapts the db shape and keeps the
 * CallLogRow component ignorant of sqlite's 0/1 booleans. */
function CallLogChip({
  call,
  onRedial,
}: {
  call: db.CallLogRow;
  onRedial(kind: 'audio' | 'video'): void;
}): React.JSX.Element {
  return (
    <CallLogRow
      row={{
        cid: call.cid,
        direction: call.direction,
        kind: call.kind,
        reason: call.reason,
        connectedAt: call.connectedAt,
        endedAt: call.endedAt,
        missed: call.missed === 1,
      }}
      onRedial={onRedial}
    />
  );
}

interface ThreadItem {
  row: db.MessageRow;
  /** Present when this item is a CALL, rendered as a full-width chip. The
   * `row` is then a synthetic placeholder (msgId = cid) that exists only so
   * key extraction and neighbour arithmetic need no second shape — it is
   * never rendered and never written to the database (the design stands: call
   * signalling never becomes a message row; these are derived at render
   * time from call_log). */
  call?: db.CallLogRow;
  /** Present when this item is an APPROVAL, rendered as the card — the same
   * synthetic-row scheme as calls, derived at render time from the
   * `approvals` table (an approval never becomes a
   * message row — the body would hold a command line at rest). */
  approval?: db.ApprovalRow;
  firstInGroup: boolean;
  lastInGroup: boolean;
  newDay: boolean;
  /** Last in group AND the next message shows a different clock label. */
  showClock: boolean;
}

/** The placeholder behind a call item. Empty body: every envelope parse on it
 * yields null, so message-only code paths fall through harmlessly. */
function callPlaceholderRow(c: db.CallLogRow): db.MessageRow {
  return {
    msgId: c.cid,
    peerId: c.peerId,
    direction: c.direction,
    body: '',
    ts: c.startedAt,
    status: 'sent' as db.MessageStatus,
    deletedAt: null,
  };
}

/** The placeholder behind an approval card — callPlaceholderRow's scheme:
 * empty body, so message-only code paths fall through harmlessly. */
function approvalPlaceholderRow(a: db.ApprovalRow): db.MessageRow {
  return {
    msgId: `approval:${a.q}`,
    peerId: a.peerId,
    direction: 'in',
    body: '',
    ts: a.ts,
    status: 'received' as db.MessageStatus,
    deletedAt: null,
  };
}

function buildItems(
  rows: db.MessageRow[],
  callAt: (db.CallLogRow | undefined)[],
  approvalAt: (db.ApprovalRow | undefined)[],
): ThreadItem[] {
    // Screenshot notices render as full-width system rows that ignore every
    // grouping flag — so they must be transparent to direction runs, like the
    // date divider: a bubble next to one keeps its own clock and margins.
    // Rows that render as full-width system lines print no clock and ignore
    // every grouping flag, so they must be transparent to direction runs —
    // otherwise a neighbour loses the timestamp this one never shows.
    const system = rows.map((r, i) => {
      if (callAt[i]) return true;
      // An approval card is full-width and prints no clock, so it must be
      // grouping-transparent — the same defect class the vault line above
      // records: missing from this list, the symptom shows on the NEIGHBOUR.
      if (approvalAt[i]) return true;
      if (r.deletedAt) return true;
      // An outsider row renders full-width and tagged,
      // so it is grouping-transparent for the same reason the notices are.
      if (r.outsider) return true;
      // A relayed history row is deliberately NOT here: this list is about
      // rows that render through the full-width ruled line below, and a
      // relayed row renders as an ordinary bubble with a provenance line
      // above it.
      //
      // Adding it would not suppress its clock — I asserted that in an
      // earlier version of this comment and a mutation proved it false. The
      // flag governs GROUPING, so listing it would only make it transparent
      // to direction runs. Left out because the claim it makes would be
      // untrue, not because the alternative breaks anything.
      const tcm = parseEnvelope(r.body)?.tcm;
      // All of these render through the full-width ruled line below, so all
      // of them must be listed here. A timer notice missing from this list
      // would have swallowed a neighbouring bubble's clock label — the same
      // defect shot rows were fixed for, and the reason that fix left a test
      // behind. A vault notice is the third of the same shape, and it is the
      // easiest step in the whole feature to forget because the symptom shows
      // up on the NEIGHBOUR, not on the row you added. The four room kinds
      // (grp.new, grp.roster, grp.set, plus the declined
      // grp.del row) are four more chances at exactly that defect.
      return (
        tcm === 'shot' ||
        tcm === 'timer' ||
        tcm === 'vault' ||
        tcm === 'grp.new' ||
        tcm === 'grp.roster' ||
        tcm === 'grp.set' ||
        tcm === 'grp.del' ||
        tcm === 'grp.hist' ||
        // The consent announcement renders through the same full-width
        // ruled line, so it must be grouping-transparent too, or a neighbour
        // bubble loses the clock this row never prints.
        tcm === 'grp.consent'
      );
    });
    return rows.map((row, i) => {
      const prev = rows[i - 1];
      const next = rows[i + 1];
      // A non-negative delta is required as well as a small one: two devices
      // with skewed clocks can produce a negative gap, which passes any
      // upper bound and groups messages that are minutes apart.
      const before = prev ? row.ts - prev.ts : -1;
      const after = next ? next.ts - row.ts : -1;
      const groupedBefore =
        !!prev &&
        !system[i] &&
        !system[i - 1] &&
        prev.direction === row.direction &&
        // In a room, direction alone lies: two inbound neighbours can be two
        // different PEOPLE, and grouping them would hide the second author's
        // label. authorId is null on every 1:1 row, so this clause is inert
        // outside rooms.
        (prev.authorId ?? null) === (row.authorId ?? null) &&
        before >= 0 &&
        before < GROUP_WINDOW_MS &&
        sameDay(prev.ts, row.ts);
      const groupedAfter =
        !!next &&
        !system[i] &&
        !system[i + 1] &&
        next.direction === row.direction &&
        (next.authorId ?? null) === (row.authorId ?? null) &&
        after >= 0 &&
        after < GROUP_WINDOW_MS &&
        sameDay(next.ts, row.ts);
      const lastInGroup = !groupedAfter;
      return {
        row,
        call: callAt[i],
        approval: approvalAt[i],
        firstInGroup: !groupedBefore,
        lastInGroup,
        newDay: !prev || !sameDay(prev.ts, row.ts),
        // Groups end at every direction change, so a quick exchange inside
        // one minute otherwise prints the same clock label four times. A
        // system row prints no clock, so it never suppresses a neighbor's.
        showClock:
          lastInGroup &&
          (!next ||
            system[i + 1] ||
            clockLabel(next.ts) !== clockLabel(row.ts)),
      };
    });
  }

type Drawer = 'none' | 'attach' | 'emoji';

/**
 * What the composer is doing besides writing something new. Both states hold
 * the row they act on, so the composer can name it and the send path knows
 * which verb to use.
 */
type Pending =
  | { kind: 'reply'; row: db.MessageRow }
  | { kind: 'edit'; row: db.MessageRow };

/** What a rail was opened to do, so VoiceOver's Delete reaches the confirm. */
type RailIntent = 'react' | 'delete';

/**
 * One conversation. Everything that could have been a floating overlay is
 * attached to the thing it belongs to instead: the reaction rail sits under
 * its message, photo and emoji choices are drawers seamed to the composer,
 * and the safety panel expands under the header.
 */
export function ChatThreadScreen({
  peerId,
  onBack,
  onOpenPeerProfile,
  onOpenPhoto,
  onStartCall,
  onOpenGroupProfile,
  onStartRoomCall,
}: Props) {
  const t = useTheme();
  // The window's HEIGHT is still the right vertical bound for the panels'
  // maxHeight caps below: every pane spans the window's full height under
  // this shell, so "a banner may take a third of the glass" is a fact about
  // the window on every projection.
  const { height } = useWindowDimensions();
  /**
   * The PANE's width, never the window's. Under the
   * wide shell this thread renders in a pane narrower than its window, and
   * the bubbles, photo sizing, and rails all flow from `viewportWidth` —
   * fed the window's width on a 2560px tablet, they railed to opposite
   * edges of the glass (the stretched-layout probe row). In compact the
   * pane and the window coincide by construction (usePaneWidth's fallback).
   */
  const paneWidth = usePaneWidth();

  /**
   * How much of this screen the keyboard is covering — THE keyboard
   * mechanism, shared by every screen that lifts for typing. The reasoning — why not KeyboardAvoidingView under a
   * transformed RouteTransition, why keyboard-frame ∩ pane instead of
   * `height - screenY`, why Android answers 0 — lives with the
   * mechanism in keyboardInset.ts.
   */
  const keyboardInset = useKeyboardInset();
  const [chat, setChat] = useState<db.ChatRow | null>(null);
  const [me, setMe] = useState<db.ProfileRow | null>(null);
  const [rows, setRows] = useState<db.MessageRow[]>([]);
  /**
   * The room's anchor when `peerId` names a room, null for a 1:1 — and
   * `groupKnown` says whether that question has been ANSWERED yet, because
   * the answer gates the read-receipt path and "not answered" must
   * not be read as "not a room".
   */
  const [group, setGroup] = useState<db.GroupRow | null>(null);
  const [groupKnown, setGroupKnown] = useState(false);
  /** Who is typing here right now: id → wall-clock expiry. In memory only —
   * typing state must never touch the database. */
  const [typists, setTypists] = useState<Map<string, number>>(new Map());
  /** Repaint counter for the stream overlay: bumped by the store's
   * signal and by the fade timer below. The overlays themselves live in
   * streamEdits — memory only, like typists; never the database. */
  const [streamTick, setStreamTick] = useState(0);
  const groupRef = useRef<db.GroupRow | null>(null);
  const groupKnownRef = useRef(false);
  /** How many people the folded roster says are in this room (me included),
   * for the header's "Room · N people". Null for a 1:1 and while unknown —
   * the header then says the bare word rather than a guessed number. */
  const [memberCount, setMemberCount] = useState<number | null>(null);
  /** id -> the names this phone holds for that person, for author labels.
   * Loaded only for rooms; a 1:1 needs no map to name its one peer. */
  const [names, setNames] = useState<
    Map<string, { displayName: string | null; localName: string | null }>
  >(new Map());
  /** The machine record: ids the SERVER confirmed as this account's
   * machines, for the AI badge. Loaded on refresh, identity-preserved so the
   * rows' memo survives the requery storm. Never fed by message content —
   * see machine.ts for the rule. */
  const [machinePeers, setMachinePeers] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  /** Members whose legs fan-out is skipping over an unaccepted identity
   * change — the loud, named, non-pausing banner. */
  const [roomSkipped, setRoomSkipped] = useState<string[]>([]);
  /** The pre-consent teaching line's subject: one agent
   * member this account has NOT consented to, with its state — or null when
   * every nameable non-owned agent is consented (or none exists). */
  const [consentHint, setConsentHint] = useState<{
    agentId: string;
    state: 'undecided' | 'refused';
  } | null>(null);
  /** The FOLDED members of this room (me included), for the mention picker —
   * the same fold the header count and the send path act on, never a
   * slot count and never a guess. Empty for a 1:1. */
  const [roomMembers, setRoomMembers] = useState<string[]>([]);
  /** Mentions the composer is carrying, validated against the draft before
   * every use (see liveMentionChips — the model's own doctrine). */
  const [mentionChips, setMentionChips] = useState<MentionChip[]>([]);
  /** Collapsed caret position, for the @-query; null while a range is
   * selected or nothing is known yet. State rather than the selection ref
   * because the PICKER renders from it — but it never feeds a `selection`
   * prop back, so it cannot fight the person's cursor. */
  const [mentionCaret, setMentionCaret] = useState<number | null>(null);
  const [attachments, setAttachments] = useState<Map<string, AttachmentMeta>>(
    new Map(),
  );
  const [reactions, setReactions] = useState<Map<string, db.ReactionRow[]>>(
    new Map(),
  );
  /**
   * The thread's failed fan-outs, keyed by the out-row's own msgId (a
   * device-retest finding). Loaded as ONE batched read per refresh
   * (`db.listFanoutFailures`) — never a per-row `fanoutDeliveryState` query —
   * and refreshed by the same debounced notify that carries every leg settle
   * (receipts, `markLegFailed`, the retry cap). Rows only where something
   * failed; identity-preserved like the name map so MessageRow's memo holds.
   */
  const [fanoutFailures, setFanoutFailures] = useState<
    Map<string, { failed: number; total: number }>
  >(new Map());
  const [draft, setDraft] = useState('');
  const [sendError, setSendError] = useState<SendError | null>(null);
  const [sendingPhoto, setSendingPhoto] = useState(false);
  /** Retained bytes of a photo that failed to send, so retry is one tap. */
  const [failedPhoto, setFailedPhoto] = useState<PickedImage | null>(null);
  /**
   * An UNACCEPTED IDENTITY CHANGE. Nothing to do with `peerBlocked` below, and
   * the only one of the two that may reach `safetyStateFor`.
   */
  const [blocked, setBlocked] = useState(messaging.isPeerBlocked(peerId));
  /** This device blocks this person — their own settled decision. */
  const [peerBlocked, setPeerBlocked] = useState(false);
  /** The lock-screen mirror is out of step with the block list. Durable-seeded, re-read on every notify, and rendered VISIBLY —
   * the thread is a block/unblock entry point, and its person is exactly the
   * one a stale mirror lies about. */
  const [mirrorStale, setMirrorStale] = useState(
    messaging.isBlockNotificationMirrorStale(),
  );
  const [wsState, setWsState] = useState(messaging.wsState);
  const [safetyOpen, setSafetyOpen] = useState(false);
  /** The kind of small-group call being assembled, when this room is bigger
   * than a call can be. Null the rest of the time — a room that fits
   * dials straight through and never sees a picker. */
  const [callPicker, setCallPicker] = useState<'audio' | 'video' | null>(null);
  const [safety, setSafety] = useState<string | null>(null);
  const [drawer, setDrawer] = useState<Drawer>('none');
  const [railFor, setRailFor] = useState<db.MessageRow | null>(null);
  const [railIntent, setRailIntent] = useState<RailIntent>('react');
  /** Replying to, or rewriting, an existing message. Null while composing
   * something new. */
  const [pending, setPending] = useState<Pending | null>(null);
  /** Shown after accepting an identity change: accepting is not verifying. */
  const [acceptedNotice, setAcceptedNotice] = useState(false);
  /** Mirrors `atBottom` for rendering — a ref cannot drive the jump control. */
  const [showJump, setShowJump] = useState(false);
  const [hasNew, setHasNew] = useState(false);
  const reduceMotion = useReduceMotion();
  const listRef = useRef<FlatList<ThreadItem>>(null);
  const [calls, setCalls] = useState<db.CallLogRow[]>([]);
  // Approvals, derived into the timeline like calls.
  // `approvalNow` is the once-a-second clock READING the cards render their
  // countdown from — a reading, never state: remove the tick and every card
  // stays truthful, just less specific (the CallTile silentMs discipline).
  const [approvals, setApprovals] = useState<db.ApprovalRow[]>([]);
  const [approvalNow, setApprovalNow] = useState(() => Date.now());
  /** Which approval's answer is in flight (busy buttons), by `q`. */
  const [approvalBusy, setApprovalBusy] = useState<string | null>(null);
  /** The SYNCHRONOUS double-tap guard: a second tap must find the first
   * already holding the id, before any await yields. The store's
   * conditional settle is the second defence; the CLI spine's burned id is
   * the third — the card relies on neither. */
  const inFlightApprovals = useRef<Set<string>>(new Set());
  const peerIdRef = useRef(peerId);
  peerIdRef.current = peerId;
  // The previous peer's chips must not survive even one frame of a switch.
  useEffect(() => setCalls([]), [peerId]);
  useEffect(() => setApprovals([]), [peerId]);
  // A call that just ended belongs at the bottom of this very thread.
  const liveCall = useCallState();
  const scrollOffset = useRef(0);
  /** Scroll position when the rail opened — dismissal is relative to it, not
   * to the top of the thread. */
  const railScrollOrigin = useRef(0);
  /** Within BOTTOM_SLACK of the end, so new content may pull the view along. */
  const atBottom = useRef(true);
  /** A finger is on the list. Only a finger may dismiss the rail; the
   * programmatic scroll that reveals it must not close it. */
  const dragging = useRef(false);
  const railOpenRef = useRef(false);
  const railForRef = useRef<db.MessageRow | null>(null);
  /**
   * Whether the thread is still ANCHORED to its newest message.
   *
   * It was a one-shot "did the first scroll happen" flag, and that is the
   * bug: a thread arrives in stages — messages, then call chips, then
   * attachment metadata that resizes rows — so the single scroll landed at
   * the bottom of a PARTIAL list and everything loading afterwards pushed
   * the newest message back out of view. Opening a conversation then showed
   * the middle of it behind a "Latest messages" button.
   *
   * Anchored stays true until the person DRAGS, so every stage of loading
   * re-pins. Their first drag is the only thing that hands control over.
   */
  const anchoredToEnd = useRef(true);
  const reactionsRef = useRef<Map<string, db.ReactionRow[]>>(new Map());
  const seenInboundCount = useRef(0);
  /** Failed outgoing rows VoiceOver has already been told about. Null until
   * the first requery answers: what was already failed when the thread opened
   * is seeded silently — those bubbles are read in place — and only a row seen
   * to BECOME failed is announced, exactly once. */
  const announcedFailed = useRef<Set<string> | null>(null);
  const errorSeq = useRef(0);
  const draftRef = useRef('');
  /** What was in the composer before an edit borrowed it. */
  const shelvedDraft = useRef('');
  /** The shelved draft's mention chips, restored with its words. */
  const shelvedChips = useRef<MentionChip[]>([]);
  /** Read by callbacks that must not re-arm whenever `pending` changes. */
  const pendingRef = useRef<Pending | null>(null);
  const draftLoaded = useRef(false);
  /** Read by the pick/remove callbacks, which must not re-arm per keystroke. */
  const mentionChipsRef = useRef<MentionChip[]>([]);
  const mentionCaretRef = useRef<number | null>(null);

  draftRef.current = draft;
  pendingRef.current = pending;
  mentionChipsRef.current = mentionChips;
  mentionCaretRef.current = mentionCaret;

  useEffect(() => {
    railForRef.current = railFor;
    railOpenRef.current = railFor !== null;
  }, [railFor]);

  /**
   * Tell them their messages have been read (the filled second tick).
   *
   * Keyed on `rows` so it fires on open AND when something new arrives while
   * the thread is already up — those are both "read" — but gated on the app
   * being FOREGROUNDED. This screen stays mounted when the phone goes into a
   * pocket, and a message that arrives then has not been read by anyone.
   *
   * Everything else that could make this the wrong thing to send — the
   * setting, blocking, duress, nothing new to acknowledge — is decided in
   * `messaging.sendReadReceipt`, which is where those gates belong. It never
   * throws, so there is nothing to catch here.
   */
  useEffect(() => {
    if (AppState.currentState !== 'active') return;
    // Rooms send no read receipts. The RULE lives in
    // `sendReadReceipt` itself — the seam consults the same anchor and
    // refuses a room id no matter who calls it — so this gate is
    // the first line, not the last: it keeps an active room from dialling
    // the receipt path (and its anchor query) on every arriving row, using
    // the answer this screen already holds. "Don't know yet" is treated as
    // a room, the same safe default the seam falls to when the anchor
    // cannot answer. Unread counts and the blue-dot are markChatOpened's,
    // which runs for rooms unchanged.
    if (!groupKnown || group !== null) return;
    void messaging.sendReadReceipt(peerId);
  }, [peerId, rows, groupKnown, group]);

  const liveCallName = liveCall.name;
  useEffect(() => {
    if (liveCallName === 'idle') refresh();
    // refresh is stable per peerId; the dep below is the trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveCallName]);

  const refresh = useCallback(() => {
    quiet(db.getChat(peerId), setChat);
    // ONE profile read per refresh — the room branch below reuses this same
    // promise for its selfId (a remediation: it used to issue a
    // second db.loadProfile on every debounced refresh).
    const profile = db.loadProfile();
    quiet(profile, setMe);
    // Room or 1:1 is the anchor's answer, not a guess from the id's shape.
    // The name map rides the same read so a refresh costs rooms one extra
    // query and a 1:1 none. Guarded by the peer the query was asked about,
    // like the call log below.
    quiet(
      db.getGroup(peerId).then(async g => {
        const slots = g ? await db.listGroupMemberSlots(peerId) : null;
        const fold = g && slots ? foldRoster(g.ownerId, slots) : null;
        // The pre-consent teaching line: the same
        // choice-set the consent surface computes — (roster class ∨ marker) ∧
        // not mine ∧ not me — read against this account's own decision
        // record. LOCAL reads only; nothing is ever asked of the server.
        let hint: { agentId: string; state: 'undecided' | 'refused' } | null =
          null;
        if (g && fold) {
          const selfId = (await profile)?.userId;
          const machines = new Set(await db.listMachinePeers().catch(() => []));
          const markers = new Set(
            await db.listRoomAgentAuthorIds(peerId).catch(() => []),
          );
          const candidates = fold.members.filter(
            id =>
              id !== selfId &&
              !machines.has(id) &&
              (fold.classes[id] === 'integration' || markers.has(id)),
          );
          let refused: string | null = null;
          for (const id of candidates) {
            const state = await db
              .getAgentConsent(id)
              .catch(() => 'undecided' as const);
            if (state === 'undecided') {
              // The actionable state wins the slot: an unmade choice.
              hint = { agentId: id, state: 'undecided' };
              break;
            }
            if (state === 'refused' && refused === null) refused = id;
          }
          if (hint === null && refused !== null) {
            hint = { agentId: refused, state: 'refused' };
          }
        }
        return {
          g,
          chats: g ? await db.listChats() : null,
          // The header's people count rides the same read: the folded
          // roster, the one answer the send path also acts on.
          fold,
          hint,
        };
      }),
      ({ g, chats, fold, hint }) => {
        if (peerIdRef.current !== peerId) return;
        setGroup(g);
        setGroupKnown(true);
        // One fold feeds both the header count and the mention picker, so
        // the two can never disagree about who is in this room.
        setMemberCount(fold ? fold.members.length : null);
        setRoomMembers(fold ? [...fold.members] : []);
        setRoomSkipped(g ? messaging.skippedInRoom(peerId) : []);
        setConsentHint(hint);
        if (chats) {
          const next = new Map(
            chats.map(c => [
              c.peerId,
              { displayName: c.displayName, localName: c.localName },
            ]),
          );
          // Same-valued maps keep their identity, so MessageRow's memo
          // survives the requery storm a photo thread lives under.
          setNames(prev => {
            if (prev.size === next.size) {
              let same = true;
              for (const [id, v] of next) {
                const p = prev.get(id);
                if (
                  !p ||
                  p.displayName !== v.displayName ||
                  p.localName !== v.localName
                ) {
                  same = false;
                  break;
                }
              }
              if (same) return prev;
            }
            return next;
          });
        }
      },
    );
    // Oldest-first for the merge; the query returns newest-first. Guarded
    // by the peer the query was ASKED about: a slow read racing a thread
    // switch must neither paint A's calls into B's room nor overwrite B's
    // result after the fact.
    quiet(db.listCallLog(peerId), log => {
      if (peerIdRef.current !== peerId) return;
      setCalls(log.filter(c => c.state === 'ended').reverse());
    });
    // Guarded by the peer the query was asked about, like the call log. The
    // read is also the store's maintenance pass (local lapse, redaction,
    // retention) — `Date.now()` here is the moving clock every deadline
    // comparison shares. The cards' countdown base moves with it so a
    // thread reopened after a night in a pocket wakes on the present.
    quiet(db.listApprovals(peerId, Date.now()), list => {
      if (peerIdRef.current !== peerId) return;
      setApprovals(list);
      setApprovalNow(Date.now());
    });
    // The machine record, for the AI badge. Same-valued sets keep
    // their identity, exactly like the name map above, so `isAgentId` stays
    // stable across the requery storm and MessageRow's memo holds.
    quiet(db.listMachinePeers(), ids => {
      setMachinePeers(prev => {
        if (prev.size === ids.length && ids.every(id => prev.has(id))) {
          return prev;
        }
        return new Set(ids);
      });
    });
    quiet(db.listMessages(peerId), all => {
      // Reaction and profile carriers are transport, not conversation.
      const visible = all.filter(r => !isCarrierEnvelope(r.body));
      const inbound = visible.reduce(
        (n, r) => (r.direction === 'in' ? n + 1 : n),
        0,
      );
      if (inbound > seenInboundCount.current && !atBottom.current) {
        setHasNew(true);
      }
      seenInboundCount.current = inbound;
      setRows(visible);
      // Exhaustion fires from messaging's silent retry timer: the row
      // repaints as failed, and on iOS a repaint says nothing. One
      // announcement per message that newly failed — every later requery
      // (receipts, reactions, downloads) finds the id already seen and
      // stays quiet.
      const failed = new Set(
        visible
          .filter(r => r.direction === 'out' && r.status === 'error')
          .map(r => r.msgId),
      );
      const prior = announcedFailed.current;
      announcedFailed.current = failed;
      if (prior !== null && [...failed].some(id => !prior.has(id))) {
        AccessibilityInfo.announceForAccessibilityWithOptions(COPY.sendFailed, {
          queue: true,
        });
      }
    });
    // Metadata only: reading every base64 blob in the conversation on every
    // notification is tens of megabytes of JS strings per receipt. Each bubble
    // loads its own bytes while it is mounted.
    quiet(db.listAttachmentMeta(peerId), list => {
      // Keyed by the message composite identity: ids are sender-chosen, so
      // msgId alone can collide across directions.
      setAttachments(new Map(list.map(a => [`${a.msgId}:${a.direction}`, a])));
    });
    quiet(db.listReactions(peerId), list => {
      const byTarget = new Map<string, db.ReactionRow[]>();
      for (const r of list) {
        const key = `${r.targetMsgId}:${r.targetDirection}`;
        byTarget.set(key, [...(byTarget.get(key) ?? []), r]);
      }
      reactionsRef.current = byTarget;
      setReactions(byTarget);
    });
    // The failed fan-outs, one batched read (see the state's doc comment).
    // Guarded by the peer the query was asked about, like the call log — a
    // slow read racing a thread switch must not paint A's failures into B's
    // thread. Same-valued maps keep their identity, exactly as `names` does.
    quiet(db.listFanoutFailures(peerId), list => {
      if (peerIdRef.current !== peerId) return;
      const next = new Map(
        list.map(f => [f.localMsgId, { failed: f.failed, total: f.total }]),
      );
      setFanoutFailures(prev => {
        if (prev.size === next.size) {
          let same = true;
          for (const [id, v] of next) {
            const p = prev.get(id);
            if (!p || p.failed !== v.failed || p.total !== v.total) {
              same = false;
              break;
            }
          }
          if (same) return prev;
        }
        return next;
      });
    });
    const nowBlocked = messaging.isPeerBlocked(peerId);
    setBlocked(nowBlocked);
    // A conversation with sending paused offers nothing to react to.
    if (nowBlocked) setRailFor(null);
    // The database, not messaging's Set: the Set is enforcement-only and is
    // empty in a duress session, where the decoy workspace's own rows are the
    // truth this screen must render.
    quiet(db.getBlockedAt(peerId), at => {
      setPeerBlocked(at != null);
      // And now the same line for an actual block. A reaction is outbound, and
      // nothing outbound reaches someone this device blocks.
      if (at != null) setRailFor(null);
    });
    setWsState(messaging.wsState);
    setMirrorStale(messaging.isBlockNotificationMirrorStale());
  }, [peerId]);

  // Opening the thread is the moment these messages become visible, so it is
  // the moment inbound rows start their clock — and the moment anything
  // already past its time should be gone before it is drawn.
  useEffect(() => {
    void messaging.sweepDisappearing(peerId);
  }, [peerId]);

  useEffect(() => {
    refresh();
    // A burst of attachment downloads, receipts and reactions must cost one
    // requery, not one per event.
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = messaging.subscribe(() => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        refresh();
      }, REFRESH_DEBOUNCE_MS);
    });
    return () => {
      if (timer) clearTimeout(timer);
      off();
    };
  }, [refresh]);

  useEffect(() => {
    groupRef.current = group;
    groupKnownRef.current = groupKnown;
  }, [group, groupKnown]);

  useEffect(() => {
    // Reset on thread switch: a typist from the last thread must not haunt
    // this one.
    setTypists(new Map());
    const off = messaging.onTyping((from, envelope, _ts) => {
      const room = groupRef.current !== null;
      const relevant = room
        ? envelope.room === peerId
        : envelope.room === undefined && from === peerId;
      if (!relevant) return;
      setTypists(prev => {
        const next = new Map(prev);
        if (envelope.state === 'stop') next.delete(from);
        else next.set(from, Date.now() + TYPING_EXPIRY_MS);
        return next;
      });
    });
    return off;
  }, [peerId]);

  useEffect(() => {
    if (typists.size === 0) return;
    const soonest = Math.min(...typists.values());
    const timer = setTimeout(
      () => {
        setTypists(prev => {
          const now = Date.now();
          const next = new Map([...prev].filter(([, exp]) => exp > now));
          return next.size === prev.size ? prev : next;
        });
      },
      Math.max(0, soonest - Date.now()) + 50,
    );
    return () => clearTimeout(timer);
  }, [typists]);

  useEffect(() => {
    // A real message from a typist clears their indicator at once — the
    // words arrived; the promise of words is stale.
    const last = rows[rows.length - 1];
    if (!last || last.direction !== 'in') return;
    const author = groupRef.current ? last.authorId : peerId;
    if (!author) return;
    setTypists(prev => {
      if (!prev.has(author)) return prev;
      const next = new Map(prev);
      next.delete(author);
      return next;
    });
  }, [rows, peerId]);

  // The stream overlay: repaint whenever the store changes. The store
  // outlives this screen (messaging writes it whether or not a thread is
  // open), so the subscription is the whole wiring — no per-thread reset is
  // needed because `overlays` below is derived, never accumulated.
  useEffect(() => streamEdits.subscribe(() => setStreamTick(tick => tick + 1)), []);

  /** msgId → the snapshot currently painted over that inbound bubble.
   * Derived fresh from the store on every requery and on every store
   * signal; rooms get none by design (v1 is 1:1 only, and messaging's
   * apply predicate already refuses room rows — the empty map here is the
   * render-side statement of the same fact). */
  const overlays = useMemo(() => {
    void streamTick; // the store's change signal; the map reads the store
    const map = new Map<string, StreamEditOverlay>();
    if (group !== null) return map;
    for (const row of rows) {
      if (row.direction !== 'in' || row.deletedAt) continue;
      const overlay = streamEdits.get(peerId, row.msgId);
      if (overlay) map.set(row.msgId, overlay);
    }
    return map;
  }, [rows, peerId, group, streamTick]);

  useEffect(() => {
    // The fade, on the typists-expiry pattern: one timer aimed at the
    // soonest overlay's STREAM_EXPIRY_MS mark, bumping the tick so the
    // bubble reverts to durable truth on its own — a dead stream must not
    // freeze a half-sentence on screen.
    if (overlays.size === 0) return;
    let soonest = Infinity;
    for (const overlay of overlays.values()) {
      soonest = Math.min(soonest, overlay.at + STREAM_EXPIRY_MS);
    }
    const timer = setTimeout(
      () => setStreamTick(tick => tick + 1),
      Math.max(0, soonest - Date.now()) + 50,
    );
    return () => clearTimeout(timer);
  }, [overlays]);

  // A different conversation is a different scroll position and a different
  // draft: nothing about the last one may leak into this one.
  useEffect(() => {
    anchoredToEnd.current = true;
    atBottom.current = true;
    seenInboundCount.current = 0;
    // Back to "not seeded": the other conversation's failures must neither be
    // announced here nor suppress this one's.
    announcedFailed.current = null;
    setShowJump(false);
    setHasNew(false);
    // Back to "not answered": the previous thread's roomness must not gate —
    // or ungate — this one's receipts for even one render.
    setGroup(null);
    setGroupKnown(false);
    setMemberCount(null);
    setRoomSkipped([]);
    // The previous room's people must not be offerable in this one, and its
    // chips must not survive into a draft they no longer describe.
    setRoomMembers([]);
    setMentionChips([]);
    setMentionCaret(null);
    // A half-assembled call belongs to the room it was opened in. Left up, its
    // rows would restock from the NEXT room's fold while the panel still
    // believed it was choosing people for the last one.
    setCallPicker(null);
  }, [peerId]);

  // What is new in the chat list is measured against this stamp; the thread is
  // the only place that can honestly write it.
  useEffect(() => {
    quiet(db.markChatOpened(peerId, Date.now()));
    // Sibling sync 'read': siblings clear their badge for this thread too —
    // once per open, not on unmount (the close writes the stamp for THIS
    // device's list; the account-level fact is "it was read", already sent).
    void messaging.syncThreadRead(peerId);
    // The message chime's "on screen" register (messageSound.ts): a message
    // for THIS conversation makes no sound while it is open — reading it is
    // the announcement. The same mount that writes the opened stamp, because
    // that is the one honest statement of "this thread is up"; `peerId` is
    // the group id for a room, which is the key the chime compares.
    setFocusedConversation(peerId);
    return () => {
      clearFocusedConversation(peerId);
      quiet(db.markChatOpened(peerId, Date.now()));
    };
  }, [peerId]);

  useEffect(() => {
    draftLoaded.current = false;
    quiet(db.getDraft(peerId), saved => {
      // Never clobber something typed while the read was in flight.
      setDraft(current => (current === '' ? saved : current));
      draftLoaded.current = true;
    });
  }, [peerId]);

  useEffect(() => {
    // While an edit holds the composer its contents are somebody's already
    // sent message, not a draft. Persisting it would bring those words back
    // on the next visit looking like something half-written.
    if (pending?.kind === 'edit') return;
    if (!draftLoaded.current && draft === '') return;
    const timer = setTimeout(() => {
      quiet(db.setDraft(peerId, draft));
    }, DRAFT_SAVE_MS);
    return () => clearTimeout(timer);
  }, [peerId, draft, pending]);

  // Separate from the debounce so leaving the screen mid-pause still saves,
  // without writing a row on every keystroke.
  useEffect(
    () => () => {
      // Same rule on the way out — but the shelved draft IS a real draft, so
      // leaving mid-edit saves what the edit borrowed the composer from.
      const text =
        pendingRef.current?.kind === 'edit'
          ? shelvedDraft.current
          : draftRef.current;
      if (!draftLoaded.current && text === '') return;
      quiet(db.setDraft(peerId, text));
    },
    [peerId],
  );

  const name = personName(peerId, chat?.displayName, chat?.localName);
  /** How to refer to them in a sentence: `them` when nobody shared a name. */
  const peerRef = personRef(peerId, chat?.displayName, chat?.localName);
  // Agrees with `name` above: a card that sanitizes to nothing is
  // not a name, so the header falls to the id face exactly as personName
  // falls to the id.
  const named =
    (sanitizeDisplayName(chat?.localName) ||
      sanitizeDisplayName(chat?.displayName)) !== '';

  const isRoom = group !== null;
  /**
   * The room's shown name: my rename, else the creator's, else a plain noun.
   * NEVER personName(peerId, ...) here — its fallback is an id fragment, and
   * no screen renders a room's id. The anchor's name
   * is peer-chosen free text like a card, so it meets the same sanitizer.
   */
  const roomName = isRoom
    ? sanitizeDisplayName(chat?.localName) ||
      sanitizeDisplayName(group.name) ||
      'This room'
    : null;
  /**
   * The folded head count as words ("3 people"), or null while the roster
   * read is in flight. The header says "Room" alone rather than a number it
   * has not folded — a guessed count over a roster would be the tell.
   */
  const roomPeople =
    isRoom && memberCount !== null
      ? `${memberCount} ${memberCount === 1 ? 'person' : 'people'}`
      : null;
  /**
   * The label for an AUTHENTICATED author id: my names
   * for people, from my own chats — never a payload field, never bubble
   * position. Two labels are refused the subject slot: a person self-named
   * "You" would forge my own voice over an incoming bubble, and "them" is
   * personRef's mid-sentence fallback — both fall back to the id fragment,
   * which is at least honestly nobody's name.
   */
  const nameFor = useCallback(
    (id: string): string => {
      if (id === me?.userId) return 'You';
      const entry = names.get(id);
      const label = personName(id, entry?.displayName, entry?.localName);
      return /^(you|them)$/i.test(label.trim()) ? shortId(id) : label;
    },
    [names, me?.userId],
  );

  /**
   * Whether an AUTHENTICATED id is a recorded machine. The one
   * question the AI badge asks — of `row.authorId` in rooms, of the thread's
   * peer in a 1:1, and never of anything a message carries. Stable while the
   * record is same-valued (the set's identity is preserved in refresh), so
   * it can sit in sameRowProps like nameFor does.
   */
  const isAgentId = useCallback(
    (id: string): boolean => machinePeers.has(id),
    [machinePeers],
  );
  /** A 1:1 with a recorded machine: every inbound row is the machine
   * speaking — the sender is the thread's peer, authenticated by the
   * session, so the badge needs no per-row author id there. */
  const peerIsAgent = !isRoom && machinePeers.has(peerId);

  /** The subtitle's typing narration, null when nobody relevant is typing.
   * Names come from nameFor — my names for people, never a payload field. */
  const typingLabel = (() => {
    const ids = [...typists.keys()];
    if (ids.length === 0) return null;
    if (!isRoom) return 'typing…';
    if (ids.length === 1) return `${nameFor(ids[0]!)} is typing…`;
    if (ids.length === 2) return `${nameFor(ids[0]!)} and ${nameFor(ids[1]!)} are typing…`;
    return 'Several people are typing…';
  })();

  // --- small-group calls from a room ---------------

  /**
   * Who a room call would dial: the FOLDED roster minus this device.
   *
   * The same fold the header count and the send path act on — a call
   * placed against a slot list rather than a fold would ring somebody who
   * has left. Empty while the fold is still in flight, which is what keeps
   * the button from dialling a room it has not read yet.
   */
  const roomOthers = useMemo(
    () => (isRoom ? roomMembers.filter(id => id !== me?.userId) : []),
    [isRoom, roomMembers, me?.userId],
  );

  /**
   * Start a room's call, or open the picker when the room is bigger than a
   * call.
   *
   * THE CAP IS ASKED, NOT ASSUMED, and it is asked per KIND: video holds five
   * and audio six, so the same twelve-person room answers this question twice
   * with different numbers. Over the cap the answer is never "dial the first
   * five" — a call that silently chose who was in it would be the worst
   * possible reading of a room.
   */
  const startRoomCall = useCallback(
    (kind: 'audio' | 'video') => {
      if (!onStartRoomCall || roomOthers.length === 0) return;
      const cap = smallGroupCallParticipantCap(kind === 'video');
      // +1 for this device: the cap counts everyone on the call.
      if (roomOthers.length + 1 <= cap) {
        onStartRoomCall(roomOthers, kind);
        return;
      }
      setCallPicker(kind);
    },
    [onStartRoomCall, roomOthers],
  );

  /** Whether the room header offers call buttons at all: a wired callback and
   * a roster this phone has actually folded. */
  const roomCallOffered = isRoom && !!onStartRoomCall && roomOthers.length > 0;

  // --- @-mentions: composing (the mentions contract) --------------------

  const sendTyping = useCallback(
    (state: 'start' | 'stop') => {
      // Room-ness is the anchor's ANSWER; while unanswered, say nothing —
      // the read-receipt rule, for the same reason.
      if (!groupKnownRef.current) return;
      if (groupRef.current) void messaging.sendRoomTypingState(peerId, state);
      else void messaging.sendTypingState(peerId, state);
    },
    [peerId],
  );
  const typingSignaler = useMemo(() => createTypingSignaler(sendTyping), [sendTyping]);

  /** Every draft write a PERSON makes comes through here, so chips ride the
   * edit (`shiftMentionChips`) and the picker follows the caret on the same
   * keystroke. Programmatic writes still call setDraft directly — their stale
   * chips are degraded by validation, never believed (liveMentionChips). */
  const changeDraft = useCallback(
    (next: string) => {
      const prev = draftRef.current;
      setMentionChips(chips => shiftMentionChips(prev, next, chips));
      setMentionCaret(caretAfterEdit(prev, next));
      setDraft(next);
      typingSignaler.onDraftChange(next.trim().length > 0);
    },
    [typingSignaler],
  );

  /** The input's own selection events refine the inferred caret — a tap into
   * the middle of the draft moves the @-query without any text changing. */
  const changeSelection = useCallback(
    (sel: { start: number; end: number }) => {
      setMentionCaret(sel.start === sel.end ? sel.start : null);
    },
    [],
  );

  /** The chips the draft still carries — the ONLY chips anything consumes. */
  const liveChips = useMemo(
    () => liveMentionChips(draft, mentionChips),
    [draft, mentionChips],
  );

  /**
   * Who the picker offers for the active @-query. ROOMS ONLY (a 1:1 has one
   * possible recipient, so '@' there is prose), and only while composing
   * something NEW — mentions inside a reply or an edit are out of scope, so
   * the picker never arms while a chip holds the composer. Matching runs
   * against the name THIS phone shows (nameFor) — that is the name the
   * person is reading, so matching anything else would feel broken.
   */
  const mentionChoices = useMemo(() => {
    if (!isRoom || pending !== null) return [];
    // The schema caps `who`; the picker stops offering at the same line so
    // compose-strict refusal stays unreachable from this UI.
    if (liveChips.length >= GROUP_MAX_MEMBERS) return [];
    const at = mentionQueryAt(draft, mentionCaret, liveChips);
    if (at === null) return [];
    const needle = at.query.toLowerCase();
    return roomMembers
      .filter(id => id !== me?.userId)
      .map(id => {
        // The disc gets the raw stored name, not nameFor's resolved label:
        // a monogram sliced from the label's id-fragment fallback reads
        // "…K" where the disc's documented nameless fallback is the id tail.
        const entry = names.get(id);
        return {
          id,
          name: nameFor(id),
          rawName:
            sanitizeDisplayName(entry?.localName) ||
            sanitizeDisplayName(entry?.displayName) ||
            null,
        };
      })
      .filter(m => needle === '' || m.name.toLowerCase().includes(needle))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [
    isRoom,
    pending,
    liveChips,
    draft,
    mentionCaret,
    roomMembers,
    me?.userId,
    names,
    nameFor,
  ]);

  /** Choosing someone replaces the @-query with `@Name ` and records the
   * chip over exactly that span — the text and the id enter TOGETHER, which
   * is the compose half of the marks-and-ids invariant. */
  const pickMention = useCallback(
    (id: string) => {
      const prev = draftRef.current;
      const live = liveMentionChips(prev, mentionChipsRef.current);
      const at = mentionQueryAt(prev, mentionCaretRef.current, live);
      if (at === null) return;
      const caret = Math.min(mentionCaretRef.current ?? prev.length, prev.length);
      const name = nameFor(id);
      const token = `@${name} `;
      const delta = token.length - (caret - at.at);
      const shifted = live.map(chip =>
        chip.start >= caret
          ? { ...chip, start: chip.start + delta, end: chip.end + delta }
          : chip,
      );
      setMentionChips([
        ...shifted,
        { id, name, start: at.at, end: at.at + 1 + name.length },
      ]);
      setDraft(prev.slice(0, at.at) + token + prev.slice(caret));
      setMentionCaret(at.at + token.length);
    },
    [nameFor],
  );

  /** The chip's ✕: the token leaves the draft WITH its id — text and id
   * removed together, exactly as they were inserted together. */
  const removeMention = useCallback((chip: MentionChip) => {
    const prev = draftRef.current;
    const live = liveMentionChips(prev, mentionChipsRef.current);
    if (!live.some(c => c.start === chip.start && c.id === chip.id)) return;
    // Take the trailing space the insert added, when it is still there.
    const end = prev[chip.end] === ' ' ? chip.end + 1 : chip.end;
    const delta = -(end - chip.start);
    setMentionChips(
      live
        .filter(c => c.start !== chip.start)
        .map(c =>
          c.start > chip.start
            ? { ...c, start: c.start + delta, end: c.end + delta }
            : c,
        ),
    );
    setDraft(prev.slice(0, chip.start) + prev.slice(end));
    setMentionCaret(chip.start);
  }, []);

  /**
   * The fingerprint is thousands of iterations of native work, so it must not
   * run on every incoming message — but it does not exist until a session
   * does, so "are there any messages yet" is part of the identity of the
   * answer, alongside the peer and whether an identity change is pending.
   */
  const hasSession = rows.length > 0;
  useEffect(() => {
    let live = true;
    quiet(messaging.getSafetyNumber(peerId), value => {
      if (live) setSafety(value);
    });
    return () => {
      live = false;
    };
  }, [peerId, blocked, hasSession]);

  // `peerBlocked` is deliberately absent from this object and must stay absent.
  // `blocked` here means an unaccepted identity change and nothing else;
  // feeding a block in would paint "Needs review" over a conversation where
  // nothing about the keys has happened.
  const safetyState: SafetyState = safetyStateFor({
    blocked,
    safety,
    checkedAt: chat?.safetyCheckedAt ?? null,
    mismatchAt: chat?.safetyMismatchAt ?? null,
  });

  // Accepting is not verifying, but a recorded match makes the reminder moot.
  useEffect(() => {
    if (chat?.safetyCheckedAt != null) setAcceptedNotice(false);
  }, [chat?.safetyCheckedAt]);

  const hasPendingOut = useMemo(
    () => rows.some(r => r.direction === 'out' && r.status === 'pending'),
    [rows],
  );

  /**
   * Resolve what a reply answers. Keyed by (msgId, direction) because msgIds
   * are sender-chosen: the `ofs` bit on the envelope says whose message was
   * quoted, and without it a peer could point at one of my rows and have my
   * own words rendered as the thing they replied to.
   */
  const byKey = useMemo(() => {
    const map = new Map<string, db.MessageRow>();
    for (const row of rows) map.set(`${row.msgId}:${row.direction}`, row);
    return map;
  }, [rows]);

  const quotedFor = useCallback(
    (row: db.MessageRow): db.MessageRow | undefined => {
      const envelope = parseEnvelope(row.body);
      if (envelope?.tcm !== 'reply') return undefined;
      // `ofs` is the REPLIER's authorship claim: what they wrote is my 'in'
      // row when the reply came from them, and my 'out' row when it is mine.
      const authoredByMe = envelope.ofs === (row.direction === 'out');
      return byKey.get(`${envelope.ref}:${authoredByMe ? 'out' : 'in'}`);
    },
    [byKey],
  );

  // The chip must show what the row says NOW: the peer can retract or rewrite
  // the message being answered while the composer holds it. Dropping a
  // retracted target also stops a reply that would quote nothing.
  useEffect(() => {
    if (!pending) return;
    const live = byKey.get(`${pending.row.msgId}:${pending.row.direction}`);
    if (!live) return;
    if (live.deletedAt) {
      // Same restore as cancelling by hand: an edit borrowed the composer.
      if (pendingRef.current?.kind === 'edit') {
        setDraft(shelvedDraft.current);
        setMentionChips(shelvedChips.current);
        shelvedDraft.current = '';
        shelvedChips.current = [];
      }
      setPending(null);
    } else if (live.body !== pending.row.body) {
      setPending(current => (current ? { ...current, row: live } : current));
    }
  }, [pending, byKey]);

  const items = useMemo<ThreadItem[]>(() => {
    // Calls take their place in the timeline by start time. They are SYSTEM
    // rows in the grouping sense — full-width, no clock, transparent to
    // direction runs — exactly like screenshot and timer notices below.
    // Approvals ride the identical scheme, placed by their frame's ts.
    const merged: {
      m?: db.MessageRow;
      c?: db.CallLogRow;
      a?: db.ApprovalRow;
      ts: number;
    }[] = [
      ...rows.map(m => ({ m, ts: m.ts })),
      ...calls.map(c => ({ c, ts: c.startedAt })),
      ...approvals.map(a => ({ a, ts: a.ts })),
    ].sort((x, y) => x.ts - y.ts);
    const mergedRows = merged.map(
      e => e.m ?? (e.c ? callPlaceholderRow(e.c) : approvalPlaceholderRow(e.a!)),
    );
    return buildItems(
      mergedRows,
      merged.map(e => e.c),
      merged.map(e => e.a),
    );
  }, [rows, calls, approvals]);

  // The countdown tick: once a second, only while a stored-pending approval
  // is on screen. The tick updates a CLOCK READING the cards derive from —
  // stopping it never wedges a card in "pending", because the store's
  // read-time maintenance and the answer path check the same arithmetic.
  const anyPendingApproval = approvals.some(a => a.state === 'pending');
  useEffect(() => {
    if (!anyPendingApproval) return;
    const tick = setInterval(() => setApprovalNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [anyPendingApproval]);

  /**
   * AUTO-SCROLL ATTRIBUTION (device demo, build 9): what caused the render
   * that is about to resize the list?
   *
   * Reported from the phone: long-press a bubble to copy or reply and the
   * screen yanks to the end mid-press — the context menu never opens. The
   * chain: the approval countdown tick (`approvalNow`, once a second while a
   * card is pending) or a stream-overlay repaint (`streamTick`, every
   * snapshot while a reply streams) re-renders the thread; when the repaint
   * changes the content height by even a point (a countdown label re-wrapping
   * the card header, the overlay's snapshot growing the bubble),
   * `onContentSizeChange` fires and — pinned or still `anchoredToEnd` —
   * called `scrollToEnd`, which cancels the in-progress gesture.
   *
   * Standard chat UX, stated as the rule the handler below enforces: a TICK
   * is never a reason to move the list. Auto-scroll follows CONTENT — new
   * rows, attachment metadata resizing a bubble, reactions — and only while
   * the person is pinned at (or anchored to) the bottom. So each render is
   * attributed here, synchronously, before its commit can fire the resize
   * callback: a render that changed a clock reading but no content marks the
   * next resize as tick-born, and the handler refuses to scroll on it. The
   * flag self-heals on the next content render, and `jumpToLatest` /
   * `onLayout` re-pinning are untouched — this suppresses exactly one thing,
   * the scroll nobody asked for.
   *
   * A ref written during render, deliberately: an effect would run AFTER
   * paint, losing the race against the very `onContentSizeChange` it exists
   * to attribute.
   */
  const tickOnlyRepaint = useRef(false);
  const scrollAttribution = useRef<{
    items: ThreadItem[] | null;
    attachments: unknown;
    reactions: unknown;
    approvalNow: number;
    streamTick: number;
  }>({ items: null, attachments: null, reactions: null, approvalNow: 0, streamTick: 0 });
  {
    const prev = scrollAttribution.current;
    const contentChanged =
      prev.items !== items ||
      prev.attachments !== attachments ||
      prev.reactions !== reactions;
    const tickChanged =
      prev.approvalNow !== approvalNow || prev.streamTick !== streamTick;
    // Content wins a mixed render: a genuinely new row while pinned scrolls
    // even when a tick rode the same commit.
    tickOnlyRepaint.current = tickChanged && !contentChanged;
    scrollAttribution.current = { items, attachments, reactions, approvalNow, streamTick };
  }



  const showError = useCallback(
    (
      err: unknown,
      kind:
        | 'text'
        | 'photo'
        | 'file'
        | 'voice'
        | 'location'
        | 'reaction'
        | 'edit'
        | 'delete',
    ) => {
      errorSeq.current += 1;
      // The room refusal keeps its own honest sentence on EVERY kind:
      // a photo or a reaction refused because the room holds someone you
      // blocked is a state to explain, not a connection problem. By `name`,
      // not instanceof — the blocking module's own doctrine.
      if (isRoom && (err as Error | null)?.name === 'BlockedPeerError') {
        setSendError({
          message: COPY.roomBlocked,
          settings: false,
          seq: errorSeq.current,
        });
        return;
      }
      setSendError({ ...sendErrorFor(err, kind), seq: errorSeq.current });
    },
    [isRoom],
  );

  /** Re-read the approvals slice alone — an answer must repaint its card
   * without waiting on the debounced full refresh. */
  const reloadApprovals = useCallback(() => {
    quiet(db.listApprovals(peerId, Date.now()), list => {
      if (peerIdRef.current !== peerId) return;
      setApprovals(list);
      setApprovalNow(Date.now());
    });
  }, [peerId]);

  /**
   * Answer one approval: the answer is an
   * ORDINARY reply — `ref` = the request's wire msgId, text = the verb —
   * through the existing send path. Zero new crypto call sites, zero new
   * wire kinds; the CLI consumes it on its already-tested channel.
   *
   * Ordering is the contract: the card flips to `answered` only AFTER the
   * outbox row exists (sendReply resolves), and the store's settle is
   * conditional on pending-and-inside-the-deadline, so neither a double-tap
   * nor a race can produce a second answer. A tap that finds the deadline
   * already passed is refused LOCALLY — the lapse is recorded and nothing
   * reaches the wire; the machine's own deny-by-timeout is the record of
   * what settled there.
   */
  const answerApproval = useCallback(
    async (a: db.ApprovalRow, verb: string) => {
      // Synchronous, before any await: the double-tap's second landing.
      if (inFlightApprovals.current.has(a.q)) return;
      if (a.state !== 'pending') return;
      if (Date.now() >= approvalDeadline(a)) {
        await db.lapseApproval(peerId, a.q).catch(() => false);
        reloadApprovals();
        return;
      }
      inFlightApprovals.current.add(a.q);
      setApprovalBusy(a.q);
      try {
        await messaging.sendReply(peerId, a.wireMsgId, 'in', verb);
        // Only now does the stored state move: the outbox row exists.
        await db.settleApproval(peerId, a.q, verb, Date.now());
      } catch (err) {
        showError(err, 'text');
      } finally {
        inFlightApprovals.current.delete(a.q);
        setApprovalBusy(current => (current === a.q ? null : current));
      }
      reloadApprovals();
    },
    [peerId, reloadApprovals, showError],
  );

  const jumpToLatest = useCallback(() => {
    setHasNew(false);
    // Re-anchor: asking for the newest message means asking to STAY there,
    // so anything still loading keeps the view pinned rather than sliding
    // out from under the person who just tapped this.
    anchoredToEnd.current = true;
    setShowJump(false);
    listRef.current?.scrollToEnd({ animated: !reduceMotion });
  }, [reduceMotion]);

  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    scrollOffset.current = contentOffset.y;
    const nearBottom =
      contentSize.height - (contentOffset.y + layoutMeasurement.height) <=
      BOTTOM_SLACK;
    // While anchored, a mid-load measurement says nothing about intent — the
    // list is still growing under a scroll the app itself performed. Reading
    // it as "the person scrolled away" is what put the jump control on
    // screen the moment a conversation opened.
    if (anchoredToEnd.current) {
      atBottom.current = true;
      if (showJump) setShowJump(false);
      return;
    }
    atBottom.current = nearBottom;
    if (showJump === nearBottom) setShowJump(!nearBottom);
    if (nearBottom && hasNew) setHasNew(false);
    if (
      dragging.current &&
      railFor &&
      Math.abs(contentOffset.y - railScrollOrigin.current) > RAIL_DISMISS_SCROLL
    ) {
      setRailFor(null);
    }
  };

  const onContentSizeChange = () => {
    // An open rail is 92pt of content the person is reading: growing the list
    // must not yank it out from under them.
    if (railOpenRef.current) return;
    // A resize born of a CLOCK — the approval countdown tick, a stream
    // overlay repaint — never scrolls, pinned or not: a tick mid-long-press
    // was cancelling the gesture (the attribution block above holds the
    // whole story). Content renders reset the flag, so the next genuine row
    // or bubble resize scrolls exactly as before.
    if (tickOnlyRepaint.current) return;
    // Anchored OR already at the bottom. The first clause is what makes
    // opening a conversation land on its newest message however many stages
    // the content arrives in.
    if (anchoredToEnd.current || atBottom.current) {
      listRef.current?.scrollToEnd({ animated: false });
    }
  };

  const send = async () => {
    // Composing ends the moment the person taps send, success or failure —
    // before any await, so the stop precedes the message on the wire.
    typingSignaler.stop();
    const text = draft.trim();
    if (!text) return;
    // The chips this send will honour — validated against the draft NOW, so
    // a token the person edited into plain text sends as the plain text they
    // can see, never as a mention of whoever used to stand there.
    const chips = isRoom ? liveMentionChips(draft, mentionChipsRef.current) : [];
    if (chips.length > 0 && pending !== null) {
      // Out of scope, refused LOUDLY at compose (the mentions contract): a
      // reply/edit body cannot carry `who`, and the silent alternative —
      // flattening the chips into literal text — would put my private name
      // for someone on every phone in the room.
      errorSeq.current += 1;
      setSendError({
        message: COPY.mentionReply,
        settings: false,
        seq: errorSeq.current,
      });
      return;
    }
    // Your own message is always worth following to.
    anchoredToEnd.current = true;
    // Captured before the composer is cleared: an edit that resolves after
    // the person has started typing something new must not act on the wrong
    // message, and the restore-on-failure path needs the original intent.
    const action = pending;
    const rawDraft = draft;
    setDraft('');
    setMentionChips([]);
    quiet(db.setDraft(peerId, ''));
    setSendError(null);
    setDrawer('none');
    setPending(null);
    try {
      if (action?.kind === 'edit') {
        // An edit that changes nothing is not worth a wire round trip — but
        // it must still clear the composer, which it already has. sendEdit
        // is room-aware: in a room it fans the same carrier to every member
        // (one branch, not two).
        if (text !== displayText(action.row.body)) {
          await messaging.sendEdit(peerId, action.row.msgId, text);
        }
      } else if (action?.kind === 'reply') {
        // Room-aware for the same reason: the ref is the row's own msgId,
        // which in a room is already the key every member shares.
        await messaging.sendReply(
          peerId,
          action.row.msgId,
          action.row.direction,
          text,
        );
      } else if (isRoom && chips.length > 0) {
        // A mention travels as IDS, never as text (the contract's one
        // constraint): marks in `text`, members in `who`, both derived by
        // mentionWire's single walk so they cannot disagree. The preview is
        // the words as THIS phone typed them — names resolved — because
        // that string reaches only this phone's own chat list.
        const wire = mentionWire(rawDraft, chips);
        await messaging.fanOut(
          peerId,
          encodeEnvelope({ tcm: 'mention', text: wire.text, who: wire.who }),
          { preview: text },
        );
      } else if (isRoom) {
        // One composed message, N legs, one transaction.
        await messaging.fanOut(peerId, text);
      } else {
        await messaging.sendText(peerId, text);
      }
      setAcceptedNotice(false);
      refresh();
    } catch (err) {
      // Restore only when nothing new has been typed since: "that message is
      // too long to send" is unactionable if the message is already gone.
      setDraft(current => (current === '' ? text : current));
      // The chips ride back with their words; validation re-drops any the
      // trim above displaced rather than believing a stale offset.
      setMentionChips(current => (current.length === 0 ? chips : current));
      setPending(current => current ?? action);
      // The two room refusals have their own honest sentences:
      // a read-only room is a state to explain, not a connection problem.
      const raw = err instanceof Error ? err.message : '';
      // By `name`, not instanceof — the blocking module's own doctrine: a
      // jest mock omitting the class must not turn this check into its own
      // TypeError inside a catch block.
      if (isRoom && (err as Error | null)?.name === 'BlockedPeerError') {
        errorSeq.current += 1;
        setSendError({
          message: COPY.roomBlocked,
          settings: false,
          seq: errorSeq.current,
        });
      } else if (isRoom && raw.includes('not in this room')) {
        errorSeq.current += 1;
        setSendError({
          message: COPY.roomNotIn,
          settings: false,
          seq: errorSeq.current,
        });
      } else {
        showError(err, action?.kind === 'edit' ? 'edit' : 'text');
      }
    }
  };

  const attachPhoto = async (source: PickSource) => {
    setDrawer('none');
    setSendError(null);
    setFailedPhoto(null);
    let picked: PickedImage;
    try {
      picked = await pickImage(source, MESSAGE_PHOTO);
    } catch (err) {
      if (err instanceof PickCancelled) return;
      // Deliberately not retained: a denied permission or an unreadable file
      // is not something retrying the same bytes could fix.
      showError(err, 'photo');
      return;
    }
    setSendingPhoto(true);
    try {
      await messaging.sendImage(
        peerId,
        picked.base64,
        picked.width,
        picked.height,
      );
    } catch (err) {
      setFailedPhoto(picked);
      showError(err, 'photo');
    } finally {
      setSendingPhoto(false);
    }
  };


  const attachDocument = async () => {
    setDrawer('none');
    setSendError(null);
    let doc: PickedDocument | null;
    try {
      // The cap is enforced NATIVELY, before the bytes reach JS; minus
      // headroom for base64 + GCM growth against MAX_ATTACHMENT_BYTES.
      doc = await pickDocument(7 * 1024 * 1024);
    } catch (err) {
      showError(err, 'file');
      return;
    }
    if (!doc) return; // cancelled — an answer, not an error
    try {
      await messaging.sendFile(peerId, doc.dataB64, doc.name, doc.size, doc.mime);
      refresh();
    } catch (err) {
      showError(err, 'file');
    }
  };

  const attachLocation = async () => {
    setDrawer('none');
    setSendError(null);
    try {
      const loc = await currentLocation(15_000);
      await messaging.sendLocation(peerId, loc.lat, loc.lng);
      refresh();
    } catch (err) {
      showError(err, 'location');
    }
  };

  const retryPhoto = async () => {
    const picked = failedPhoto;
    if (!picked) return;
    setSendError(null);
    setSendingPhoto(true);
    try {
      await messaging.sendImage(
        peerId,
        picked.base64,
        picked.width,
        picked.height,
      );
      setFailedPhoto(null);
    } catch (err) {
      showError(err, 'photo');
    } finally {
      setSendingPhoto(false);
    }
  };

  const onReact = useCallback(
    (target: db.MessageRow, emoji: string) => {
      setRailFor(null);
      const mine = reactionsRef.current
        .get(`${target.msgId}:${target.direction}`)
        ?.find(r => r.direction === 'out');
      // Choosing the reaction you already left removes it.
      void messaging
        .sendReaction(
          peerId,
          target.msgId,
          target.direction,
          mine?.emoji === emoji ? '' : emoji,
        )
        .catch(err => showError(err, 'reaction'));
    },
    [peerId, showError],
  );

  const toggleRail = useCallback(
    (row: db.MessageRow, index: number, intent: RailIntent = 'react') => {
      railScrollOrigin.current = scrollOffset.current;
      const current = railForRef.current;
      const same =
        current?.msgId === row.msgId && current?.direction === row.direction;
      // Only the plain (long-press / React) entry toggles. An explicit intent
      // has somewhere to arrive at, so it must never close what it asked for.
      const closing = same && intent === 'react';
      setRailIntent(intent);
      setRailFor(closing ? null : row);
      if (closing) return;
      // The rail plus its action strip is 92pt below a bubble that may be at
      // the bottom edge; bring the whole block into view. dragging.current is
      // false here, so this scroll cannot dismiss what it was called to show.
      requestAnimationFrame(() =>
        listRef.current?.scrollToIndex({
          index,
          viewPosition: 1,
          animated: !reduceMotion,
        }),
      );
    },
    [reduceMotion],
  );

  const openPhoto = useCallback(
    (row: db.MessageRow) => onOpenPhoto(row.msgId, row.direction),
    [onOpenPhoto],
  );

  const retryPhotoDownload = useCallback((row: db.MessageRow) => {
    quiet(messaging.retryAttachment(row.msgId, row.direction, row.body));
  }, []);

  const removeRow = useCallback(
    (row: db.MessageRow) => {
      setRailFor(null);
      quiet(db.deleteMessage(row.msgId, row.direction), refresh);
    },
    [refresh],
  );

  /** Retract on both phones. Mine only — their words are theirs. */
  const removeEverywhere = useCallback(
    (row: db.MessageRow) => {
      setRailFor(null);
      if (row.direction !== 'out') return;
      // If the message being retracted is the one the composer is holding,
      // that pending action no longer has a subject.
      setPending(current =>
        current?.row.msgId === row.msgId ? null : current,
      );
      void (async () => {
        try {
          await messaging.sendDelete(peerId, row.msgId);
        } catch (err) {
          showError(err, 'delete');
        }
        refresh();
      })();
    },
    [peerId, refresh, showError],
  );

  const startReply = useCallback((row: db.MessageRow) => {
    setRailFor(null);
    setPending({ kind: 'reply', row });
  }, []);

  /** Rewriting starts from the words that are already there — an edit that
   * makes you retype the message is a delete with extra steps. */
  const startEdit = useCallback((row: db.MessageRow) => {
    setRailFor(null);
    if (row.direction !== 'out') return;
    // Re-entering an edit must not overwrite the shelf with the previous
    // edit's text; only a genuine compose draft is worth keeping.
    if (!pendingRef.current) {
      shelvedDraft.current = draftRef.current;
      shelvedChips.current = mentionChipsRef.current;
    }
    setPending({ kind: 'edit', row });
    // A reply's body is its envelope; rewriting starts from the words, and
    // messaging puts the quote back around them.
    setDraft(displayText(row.body));
    // Chips belong to the shelved draft, not to somebody's sent words: kept,
    // they could coincidentally validate against the edit text and spring
    // the mention-in-reply refusal on a message that mentions nobody. They
    // return with the shelf in cancelPending.
    setMentionChips([]);
  }, []);

  const cancelPending = useCallback(() => {
    // Read the ref rather than a state updater: an updater may be invoked
    // more than once, and the second pass would restore an already-emptied
    // shelf over the words it just gave back.
    if (pendingRef.current?.kind === 'edit') {
      setDraft(shelvedDraft.current);
      // The chips return WITH their words; liveMentionChips re-validates
      // them against the restored text before anything believes them.
      setMentionChips(shelvedChips.current);
      shelvedDraft.current = '';
      shelvedChips.current = [];
    }
    setPending(null);
  }, []);

  /** Rows whose retry is currently in flight. The control stays mounted for
   * the whole multi-await send window (prekey fetch, encrypt, enqueue — a
   * photo adds a full blobEncrypt and upload), so without this a double-tap
   * would run two independent fresh sends and the peer would get the words
   * twice. Claimed synchronously, before the first await, so a second tap
   * cannot interleave. */
  const retrying = useRef(new Set<string>());

  const retrySend = useCallback(
    async (row: db.MessageRow) => {
      // The only place this screen consults messaging's enforcement Set, as
      // defence in depth behind a control that is already hidden: the two
      // conditions are distinct and both must stop a resend.
      if (
        messaging.isPeerBlocked(peerId) ||
        messaging.isBlockedLocally(peerId)
      ) {
        return;
      }
      const key = `${row.msgId}:out`;
      if (retrying.current.has(key)) return;
      retrying.current.add(key);
      try {
        setSendError(null);
        const envelope = parseEnvelope(row.body);
        try {
          if (envelope?.tcm === 'image') {
            const att = await db.getAttachment(row.msgId, 'out');
            if (!att?.dataB64) throw new Error('photo unreadable');
            await messaging.sendImage(
              peerId,
              att.dataB64,
              envelope.w,
              envelope.h,
            );
          } else if (envelope?.tcm === 'file') {
            // NOT sendText: the else branch below resends the raw envelope
            // JSON as ordinary words — the exact shape of the vault retry
            // bug. The stored bytes and the pointer's own facts rebuild the
            // send properly (a fresh blob upload, a fresh envelope).
            const att = await db.getAttachment(row.msgId, 'out');
            if (!att?.dataB64) throw new Error('document unreadable');
            await messaging.sendFile(
              peerId,
              att.dataB64,
              envelope.name,
              envelope.size,
              envelope.mime,
            );
          } else if (envelope?.tcm === 'voice') {
            // NOT sendText: the else branch resends the raw envelope JSON as
            // ordinary words. Same shape as the vault bug, and as the file
            // and location branches above.
            const att = await db.getAttachment(row.msgId, 'out');
            if (!att?.dataB64) throw new Error('voice message unreadable');
            await messaging.sendVoice(peerId, att.dataB64, envelope.dur);
          } else if (envelope?.tcm === 'loc') {
            await messaging.sendLocation(peerId, envelope.lat, envelope.lng);
          } else if (envelope?.tcm === 'mention') {
            // NOT sendText: the else branch resends the raw envelope JSON as
            // ordinary words — the vault retry bug's exact shape, and for a
            // mention it would also render MY names for people on every
            // phone in the room. The stored body is already the composed
            // envelope; fanOut wraps it exactly as the original send did.
            await messaging.fanOut(peerId, row.body);
          } else {
            await messaging.sendText(peerId, row.body);
          }
        } catch (err) {
          // Only the send itself may claim the send failed.
          showError(
            err,
            envelope?.tcm === 'image'
              ? 'photo'
              : envelope?.tcm === 'voice'
                ? 'voice'
                : envelope?.tcm === 'file'
                  ? 'file'
                  : envelope?.tcm === 'loc'
                    ? 'location'
                    : 'text',
          );
          return;
        }
        // Only once the replacement exists: a second failure must never cost
        // the person the words they were trying to send. And cleanup is its
        // own failure domain — the message is already on its way, so a db
        // hiccup here (a relock closing the connection mid-tap) must not
        // report 'wasn't sent' about a message that was.
        try {
          await db.deleteMessage(row.msgId, 'out');
        } catch {
          // The stale failed row is residue for the next requery or restart.
        }
        refresh();
        // Said once, at the moment it happens. The requery that repaints the
        // replacement announces nothing, so this cannot repeat.
        AccessibilityInfo.announceForAccessibilityWithOptions(
          COPY.retryingAnnounce,
          { queue: true },
        );
      } finally {
        retrying.current.delete(key);
      }
    },
    [peerId, refresh, showError],
  );

  // --- voice recording ----------------------------------------------------
  // Three states, and the middle one is the point: a recording becomes a
  // PREVIEW, never a send. Nothing leaves this phone until the person taps
  // send on something they have had the chance to hear.
  const [recording, setRecording] = useState(false);
  /** True from the tap, through the permission dialog, until the take ends —
   * the window the backgrounding listener must cover. */
  const [recordingIntent, setRecordingIntent] = useState(false);
  const [recordLevel, setRecordLevel] = useState(0);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const [voiceDraft, setVoiceDraft] = useState<RecordingResult | null>(null);

  useEffect(() => {
    const level = onLevel(v => setRecordLevel(v));
    // The cap auto-stops, and an interruption (a call arriving) finalizes
    // rather than losing the take — both arrive here as a finished result.
    const finished = onRecordingFinished(r => {
      setRecording(false);
      setRecordingIntent(false);
      setRecordLevel(0);
      setVoiceDraft(r);
    });
    return () => {
      level.remove();
      finished.remove();
    };
  }, []);

  useEffect(() => {
    if (!recording) return;
    setRecordSeconds(0);
    const started = Date.now();
    const id = setInterval(
      () => setRecordSeconds(Math.floor((Date.now() - started) / 1000)),
      500,
    );
    return () => clearInterval(id);
  }, [recording]);

  // Backgrounding STOPS the take and keeps it as a preview — it never
  // auto-sends, and it never keeps the microphone hot behind another app.
  // Armed on `recordingIntent`, not on `recording`: the listener used to be
  // installed only after startRecording RESOLVED, so backgrounding during
  // the permission dialog — the slowest part — was unobserved (found by
  // review).
  useEffect(() => {
    if (!recordingIntent) return;
    const sub = AppState.addEventListener('change', next => {
      if (next !== 'active') {
        void (async () => {
          try {
            const r = await stopRecording();
            setVoiceDraft(r);
          } catch {
            await cancelRecording().catch(() => undefined);
          } finally {
            setRecording(false);
            setRecordingIntent(false);
            setRecordLevel(0);
          }
        })();
      }
    });
    return () => sub.remove();
  }, [recordingIntent]);

  const startVoice = useCallback(() => {
    void (async () => {
      setSendError(null);
      // A playing note yields to the recorder; the native side does this too.
      if (playingVoiceRef.current) {
        setPlayingVoice(null);
        await stopPlayback().catch(() => undefined);
      }
      setRecordingIntent(true);
      try {
        await startRecording(VOICE_MAX_SECONDS);
        setRecording(true);
      } catch (err) {
        setRecordingIntent(false);
        showError(err, 'voice');
      }
    })();
  }, [showError]);

  const finishVoice = useCallback(() => {
    void (async () => {
      try {
        const r = await stopRecording();
        setVoiceDraft(r);
      } catch (err) {
        showError(err, 'voice');
      } finally {
        setRecording(false);
        setRecordingIntent(false);
        setRecordLevel(0);
      }
    })();
  }, [showError]);

  const discardVoice = useCallback(() => {
    void (async () => {
      setRecording(false);
      setRecordingIntent(false);
      setRecordLevel(0);
      setVoiceDraft(null);
      // Cancel deletes the bytes natively — they never reach JS.
      await cancelRecording().catch(() => undefined);
      await stopPlayback().catch(() => undefined);
    })();
  }, []);

  const previewVoiceDraft = useCallback(() => {
    const take = voiceDraft;
    if (!take) return;
    void (async () => {
      if (playingVoiceRef.current === 'draft') {
        setPlayingVoice(null);
        setVoiceElapsed(0);
        await stopPlayback().catch(() => undefined);
        return;
      }
      try {
        await startPlayback(take.dataB64);
        // 'draft' is a real key in the same single-player namespace, so a
        // bubble and the unsent take can never both claim to be playing.
        setPlayingVoice('draft');
      } catch (err) {
        setPlayingVoice(null);
        showError(err, 'voice');
      }
    })();
  }, [showError, voiceDraft]);

  const sendingVoice = useRef(false);
  const sendVoiceDraft = useCallback(() => {
    const take = voiceDraft;
    if (!take) return;
    // Synchronous guard, matching retrySend's: two taps inside one frame
    // otherwise start two sends of the same take.
    if (sendingVoice.current) return;
    sendingVoice.current = true;
    void (async () => {
      setVoiceDraft(null);
      await stopPlayback().catch(() => undefined);
      try {
        await messaging.sendVoice(peerId, take.dataB64, take.durationSec);
        refresh();
      } catch (err) {
        // THE TAKE COMES BACK ONLY IF NOTHING WAS ENQUEUED. Past the outbox
        // commit the message is already on its way, and handing the take
        // back would let Retry send a SECOND copy of the same note (the
        // review's point-of-no-return finding). `enqueued` is set by
        // sendVoice's own onEnqueued callback, so it is the honest signal
        // for which side of the commit the failure landed on.
        if (!(err as { enqueued?: boolean })?.enqueued) {
          setVoiceDraft(take);
        }
        showError(err, 'voice');
      } finally {
        sendingVoice.current = false;
      }
    })();
  }, [peerId, refresh, showError, voiceDraft]);

  // --- voice playback -----------------------------------------------------
  // One note plays at a time — the native module enforces it too, and this
  // is the UI's mirror of that fact so two bubbles cannot both show pause.
  const [playingVoice, setPlayingVoice] = useState<string | null>(null);
  const playingVoiceRef = useRef<string | null>(null);
  playingVoiceRef.current = playingVoice;
  /**
   * `${msgId}:${direction}` → the DECODED length, once this device has
   * played the note and learned it. The envelope's `dur` is a sender claim
   * and a peer can lie about it (found by review); the moment the decoder
   * disagrees, the bubble shows the decoder.
   */
  const [trueDurations, setTrueDurations] = useState<Map<string, number>>(
    () => new Map(),
  );
  const [voiceElapsed, setVoiceElapsed] = useState(0);
  useEffect(() => {
    const done = onPlaybackFinished(() => {
      setPlayingVoice(null);
      setVoiceElapsed(0);
    });
    const tick = onPlaybackProgress(sec => setVoiceElapsed(sec));
    return () => {
      done.remove();
      tick.remove();
    };
  }, []);
  // Leaving the room stops EVERYTHING audio, not just playback.
  //
  // The defect: only playback was torn down, so a recording begun
  // in room A kept running invisibly after navigating to B — and the take it
  // produced would then be sent to B, because sendVoiceDraft closes over the
  // CURRENT peerId. A voice note delivered to the wrong person is the worst
  // outcome this screen can produce, and it was one navigation away.
  useEffect(() => {
    return () => {
      setPlayingVoice(null);
      setVoiceElapsed(0);
      setRecording(false);
      setRecordingIntent(false);
      setRecordLevel(0);
      setVoiceDraft(null);
      void stopPlayback().catch(() => undefined);
      // Cancel, not stop: an abandoned take's bytes are deleted natively
      // and never reach JS at all.
      void cancelRecording().catch(() => undefined);
    };
  }, [peerId]);

  const onToggleVoice = useCallback(
    (row: db.MessageRow) => {
      const key = `${row.msgId}:${row.direction}`;
      void (async () => {
        if (playingVoice === key) {
          setPlayingVoice(null);
          setVoiceElapsed(0);
          await stopPlayback().catch(() => undefined);
          return;
        }
        try {
          // Loaded on tap, never held in list state (see VoiceContent).
          const att = await db.getAttachment(row.msgId, row.direction);
          if (!att?.dataB64) return;
          const decoded = await startPlayback(att.dataB64);
          setVoiceElapsed(0);
          setPlayingVoice(key);
          if (Number.isFinite(decoded) && decoded > 0) {
            setTrueDurations(prev => {
              const next = new Map(prev);
              next.set(key, Math.round(decoded));
              return next;
            });
          }
        } catch (err) {
          setPlayingVoice(null);
          showError(err, 'voice');
        }
      })();
    },
    [playingVoice, showError],
  );

  const onRetrySend = useCallback(
    (row: db.MessageRow) => void retrySend(row),
    [retrySend],
  );

  const toggleSafety = useCallback(() => {
    // Opening the panel IS following the accepted notice's instruction, so the
    // reminder has done its job and must stop occupying the composer's space.
    setAcceptedNotice(false);
    setSafetyOpen(open => !open);
  }, []);

  /**
   * The panel renders the database, so a failed write simply leaves the state
   * as it was — which is still the truth. There is no honest copy for "we
   * could not remember what you just told us".
   */
  const recordSafety = async (work: () => Promise<void>) => {
    try {
      await work();
    } catch {
      // Swallowed on purpose — see above.
    }
    refresh();
  };

  const recordMatch = () =>
    recordSafety(async () => {
      // The newer, better answer must win outright: leaving a stale mismatch
      // behind would outrank this match forever.
      await db.setSafetyChecked(peerId, Date.now());
      await db.setSafetyMismatch(peerId, null);
    });

  const recordMismatch = () =>
    recordSafety(async () => {
      await db.setSafetyMismatch(peerId, Date.now());
      await db.setSafetyChecked(peerId, null);
    });

  const compareAgain = () => {
    setSafetyOpen(true);
    return recordSafety(async () => {
      // Back to "not checked": a fresh comparison is about to happen, and the
      // old outcome — match or mismatch — is no longer the current answer.
      await db.setSafetyChecked(peerId, null);
      await db.setSafetyMismatch(peerId, null);
    });
  };

  const acceptIdentityChange = async () => {
    // The stale match is cleared inside acceptIdentityChange, so both screens
    // get the ordering from one place instead of each re-deriving it.
    try {
      await messaging.acceptIdentityChange(peerId);
    } catch {
      // Re-pinning failed, so sending is still blocked and the banner is still
      // the truth. There is nothing to add that it is not already saying.
      refresh();
      return;
    }
    setSafetyOpen(false);
    setSendError(null);
    setAcceptedNotice(true);
    refresh();
  };

  const openDrawer = useCallback((next: Drawer) => {
    setDrawer(current => (current === next ? 'none' : next));
  }, []);

  /**
   * Through messaging, so the enforcement Set, the chat list and this thread
   * agree. A failure leaves the banner up, which is still the truth — there is
   * no half-unblocked state to describe.
   */
  const unblockPerson = useCallback(async () => {
    try {
      await messaging.unblockPeer(peerId);
    } catch {
      refresh();
      return;
    }
    setPeerBlocked(false);
    // unblockPeer awaits its mirror reconcile, so this
    // read is settled — an unblock the lock screen has not heard about is
    // announced as exactly that, and the standing warning below renders it.
    const partial = messaging.isBlockNotificationMirrorStale();
    setMirrorStale(partial);
    AccessibilityInfo.announceForAccessibilityWithOptions(
      partial ? BLOCK.partialUnblockMirror : BLOCK.unblockedAnnounce,
      { queue: true },
    );
    refresh();
  }, [peerId, refresh]);

  const renderItem = useCallback(
    ({ item, index }: { item: ThreadItem; index: number }) => (
      <View>
        {item.newDay ? (
          <RuledLabel
            label={dayLabel(item.row.ts)}
            role="timeStatus"
            marginTop={16}
            marginBottom={8}
          />
        ) : null}
        {item.approval ? (
          // Ahead of every bubble path, like the call chip: an approval row
          // must never reach MessageRow, whose fallback prints row.body.
          <ApprovalCard
            approval={item.approval}
            now={approvalNow}
            busy={approvalBusy === item.approval.q}
            onAnswer={verb => void answerApproval(item.approval!, verb)}
            testID={`approval-${item.approval.q}`}
          />
        ) : item.call ? (
          <CallLogChip
            call={item.call}
            onRedial={kind => onStartCall?.(kind)}
          />
        ) : (
        <MessageRow
          item={item}
          index={index}
          theme={t}
          viewportWidth={paneWidth}
          reduceMotion={reduceMotion}
          peerRef={peerRef}
          room={group}
          nameFor={nameFor}
          isAgentId={isAgentId}
          peerIsAgent={peerIsAgent}
          selfId={me?.userId ?? null}
          // The one place the two are joined, on purpose and in the open.
          // `blocked` is an unaccepted identity change: sending is paused until
          // it is reviewed. `peerBlocked` is this device's own block: nothing
          // goes to them at all. Different reasons, different copy, same
          // consequence for a bubble — every control here is outbound.
          interactionsOff={blocked || peerBlocked}
          attachment={attachments.get(
            `${item.row.msgId}:${item.row.direction}`,
          )}
          reactions={reactions.get(`${item.row.msgId}:${item.row.direction}`)}
          // A ROOM surface only: 1:1 rows carry their own delivery states
          // (the error bubble and "Not sent."), so the gate is the room
          // anchor, never the map's silence. Derived to the SENTENCE here so
          // the memo comparator is one string compare.
          deliveryNotice={
            group && item.row.direction === 'out'
              ? groupDeliveryNotice(
                  fanoutFailures.get(item.row.msgId) ?? {
                    failed: 0,
                    total: 0,
                  },
                )
              : null
          }
          railOpen={
            railFor?.msgId === item.row.msgId &&
            railFor?.direction === item.row.direction
          }
          railIntent={railIntent}
          onLongPress={toggleRail}
          onReact={onReact}
          onOpenPhoto={openPhoto}
          onRetryPhoto={retryPhotoDownload}
          playingVoice={playingVoice}
          trueDurations={trueDurations}
          voiceElapsed={voiceElapsed}
          onToggleVoice={onToggleVoice}
          onRetrySend={onRetrySend}
          onRemove={removeRow}
          onRemoveEverywhere={removeEverywhere}
          onReply={startReply}
          onEdit={startEdit}
          quoted={quotedFor(item.row)}
          overlay={overlays.get(item.row.msgId)}
        />
        )}
      </View>
    ),
    [
      t,
      paneWidth,
      reduceMotion,
      peerRef,
      group,
      nameFor,
      isAgentId,
      peerIsAgent,
      me?.userId,
      blocked,
      peerBlocked,
      attachments,
      reactions,
      fanoutFailures,
      railFor,
      onStartCall,
      approvalNow,
      approvalBusy,
      answerApproval,
      railIntent,
      toggleRail,
      onReact,
      openPhoto,
      retryPhotoDownload,
      // Without these the callback keeps a stale closure and a playing note
      // never repaints — the props are passed, but from the wrong render.
      playingVoice,
      trueDurations,
      voiceElapsed,
      onToggleVoice,
      onRetrySend,
      removeRow,
      removeEverywhere,
      startReply,
      startEdit,
      quotedFor,
      overlays,
    ],
  );

  return (
    <View
      style={[
        styles.root,
        { backgroundColor: t.color.paperGround, paddingBottom: keyboardInset },
      ]}
    >
      <ScreenHeader
        onBack={onBack}
        backLabel="Back to chats"
        testIDBack="thread-back"
        title={
          <Pressable
            // A room's header opens the roster surface, never a two-person
            // profile. Absent the route, inert — the onStartCall doctrine.
            onPress={
              isRoom
                ? (onOpenGroupProfile ?? undefined)
                : onOpenPeerProfile
            }
            disabled={isRoom && !onOpenGroupProfile}
            accessibilityRole="button"
            // A room's label carries what the header SHOWS — the name, the
            // word, the head count — because an explicit label silences the
            // Text children for VoiceOver; the action moves to the hint. The
            // 1:1 label is unchanged.
            accessibilityLabel={
              isRoom
                ? `${roomName}, room${roomPeople ? `, ${roomPeople}` : ''}`
                : named
                  ? `Open ${name}’s profile`
                  : 'Open their profile'
            }
            {...(isRoom ? { accessibilityHint: 'Opens room details' } : {})}
            testID={isRoom ? 'thread-room-header' : 'thread-peer-header'}
            style={({ pressed }) => [
              styles.peerControl,
              { borderRadius: t.radius.button },
              pressed && { backgroundColor: t.color.pineWash },
            ]}
          >
            {/* A person is a circle; a room is the walled square with a
                doorway — the same signal the chat list row carries, in the
                same slot. Its monogram derives from the room's NAME, with
                the ULID-tail fallback the design blesses for a nameless room. */}
            {isRoom ? (
              <RoomMark
                roomId={peerId}
                name={roomName}
                size={t.layout.avatar.header}
                testID="room-mark-header"
              />
            ) : (
              <Avatar
                peerId={peerId}
                displayName={
                  sanitizeDisplayName(chat?.localName) ||
                  sanitizeDisplayName(chat?.displayName)
                }
                photoB64={chat?.avatarB64}
                size={t.layout.avatar.header}
              />
            )}
            <View style={styles.peerText}>
              <Text
                numberOfLines={1}
                style={[
                  // An id fragment is data, not a name — the chat list shows
                  // it the same way. A room always has a name-shaped label.
                  isRoom || named ? t.type.rowTitle : t.type.utilityData,
                  { color: t.color.inkStrong },
                ]}
              >
                {isRoom ? roomName : name}
              </Text>
              <Text style={[t.type.timeStatus, { color: t.color.inkMuted }]}>
                {/* "Just you two" is a two-seat commitment in the product's
                    own words and may not appear over a roster; the
                    room says how many seats its fold actually holds, in the
                    idiom the calls tab already uses (" · "). While someone
                    is typing, the narration takes the slot and gives it
                    back. */}
                {typingLabel ??
                  (isRoom
                    ? roomPeople
                      ? `Room · ${roomPeople}`
                      : 'Room'
                    : 'Just you two')}
              </Text>
            </View>
          </Pressable>
        }
        right={
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            {/* Two buttons, not one with a hidden long-press. A long-press
                that is the ONLY way to reach audio is a feature most people
                never find, and "Call" did not say which kind it would place.
                The glyphs match the in-call controls (CallScreen), so the
                camera symbol means the same thing in both places.

                Safety moved OUT of this header: tapping the name opens the
                peer profile, which already carries a full "Safety number"
                section. Two doors to one room, and the one here was the
                smaller and less discoverable of them. `toggleSafety` and the
                panel stay — the identity-change banner still opens it. */}
            {/* A ROOM CALLS TOO. The old gate
                here was `onStartCall && !isRoom`, written when a room had no
                call to place; a small-group call dials the folded roster's
                LEGS, never the room id, so there is nothing left to 404. A
                room over the cap opens the picker instead of dialling — a
                refusal to choose people on someone's behalf, not a
                degradation.

                Both shapes keep the onStartCall doctrine: an unwired callback
                or an unfolded roster offers no button at all. */}
            {(isRoom ? roomCallOffered : !!onStartCall)
              ? ([
                  // Audio first, video second. The order is the ORDER ON
                  // SCREEN, left to right — there is no separate layout to
                  // keep in step, so this array is the single place it is
                  // decided.
                  { kind: 'audio' as const, Glyph: PhoneGlyph, verb: 'Call' },
                  { kind: 'video' as const, Glyph: VideoGlyph, verb: 'Video call' },
                ]
                  // A ROOM OFFERS AUDIO ONLY. Group calls ship audio-only at
                  // v1 ("v1 scope, cut to the launch
                  // date"): the mesh video surface is cut to 1.1, so a
                  // video button here would connect an AUDIO call behind a
                  // camera glyph — a capability claim made in a button rather
                  // than a sentence. The audio-only clause
                  // says the video affordance never appears above 2
                  // participants. The 1:1 thread keeps both buttons: 1:1
                  // video is real.
                  .filter(({ kind }) => !isRoom || kind === 'audio')
                  .map(({ kind, Glyph, verb }) => {
                  // A room's roster is bigger than a call can be: the button
                  // still works, and says what it will do instead of dialling.
                  const overCap =
                    isRoom &&
                    roomOthers.length + 1 >
                      smallGroupCallParticipantCap(kind === 'video');
                  // The design gates a PERSON, not a room — a room's per-member
                  // safety skips are the coordinator's to report per leg, and they already surface in the banner below.
                  const stopped = !isRoom && (blocked || peerBlocked);
                  return (
                  <Pressable
                    key={kind}
                    onPress={() =>
                      isRoom ? startRoomCall(kind) : onStartCall?.(kind)
                    }
                    accessibilityRole="button"
                    // No call to a blocked peer, and none to
                    // one whose safety number changed. Disabled rather than
                    // refused on press — `placeCall` does refuse, before the
                    // camera, but a button that looks live and then silently
                    // does nothing leaves the person guessing whether the call
                    // failed or the app is broken.
                    disabled={stopped}
                    accessibilityState={{ disabled: stopped }}
                    accessibilityLabel={
                      isRoom
                        ? `${verb} ${roomName}`
                        : peerBlocked
                          ? `${verb} unavailable. You blocked this person.`
                          : blocked
                            ? `${verb} unavailable. Their safety number changed.`
                            : `${verb} ${named ? name : 'them'}`
                    }
                    accessibilityHint={
                      isRoom
                        ? overCap
                          ? CALL_CAP_COPY
                          : undefined
                        : peerBlocked
                          ? 'Unblock them below to call.'
                          : blocked
                            ? 'Review the safety number below to call.'
                            : undefined
                    }
                    testID={kind === 'video' ? 'start-call' : 'start-call-audio'}
                    style={({ pressed }) => [
                      styles.safetyControl,
                      { borderRadius: t.radius.circle },
                      pressed && { backgroundColor: t.color.pineWash },
                    ]}
                  >
                    <Glyph
                      size={24}
                      color={stopped ? t.color.inkMuted : t.color.pine}
                    />
                  </Pressable>
                  );
                }))
              : null}
          </View>
        }
      />

      {/* The picker, attached under the header exactly as the safety panel
          is. Its candidates are the folded roster, labelled with the SAME
          author-label rule the thread's bubbles use — one naming rule per
          screen, so a person cannot be "Ana" in a message and something else
          in the list of who to call. `nameFor` degrades to an id FRAGMENT,
          which is honest in a bubble and forbidden on a call surface; the
          picker refuses it itself, so this hands over what it has. */}
      {callPicker !== null && onStartRoomCall ? (
        <CallPicker
          candidates={roomOthers.map(id => ({ peerId: id, name: nameFor(id) }))}
          cap={smallGroupCallParticipantCap(callPicker === 'video')}
          maxHeight={Math.round(height * 0.4)}
          onCancel={() => setCallPicker(null)}
          onStart={others => {
            const kind = callPicker;
            setCallPicker(null);
            onStartRoomCall(others, kind);
          }}
        />
      ) : null}

      {safetyOpen ? (
        <SafetyPanel
          theme={t}
          peerRef={peerRef}
          state={safetyState}
          safety={safety}
          checkedAt={chat?.safetyCheckedAt ?? null}
          maxHeight={Math.round(height * 0.5)}
          onClose={() => setSafetyOpen(false)}
          onCompareAgain={() => void compareAgain()}
          onMatch={() => void recordMatch()}
          onMismatch={() => void recordMismatch()}
        />
      ) : null}

      <FlatList
        ref={listRef}
        testID="thread-list"
        data={items}
        keyExtractor={item =>
          // Distinct namespace for chips: a peer controls their own msgIds
          // and could reuse a cid (or a q) as one, colliding two list keys.
          item.approval
            ? `approval:${item.approval.q}`
            : item.call
              ? `call:${item.call.cid}`
              : `${item.row.msgId}:${item.row.direction}`
        }
        onScroll={onScroll}
        onScrollBeginDrag={() => {
          // The person taking hold of the list is the ONLY thing that hands
          // control over. Everything before this — staged content loads, a
          // keyboard opening, the app's own scrollToEnd — leaves the thread
          // anchored to its newest message.
          anchoredToEnd.current = false;
          dragging.current = true;
        }}
        onScrollEndDrag={() => {
          dragging.current = false;
        }}
        onMomentumScrollEnd={() => {
          dragging.current = false;
        }}
        scrollEventThrottle={16}
        // Without this the first tap on any message with the keyboard up is
        // swallowed by the dismissal; interactive restores the standard iOS
        // drag-down-to-dismiss the thread had no way to do at all.
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        // scrollToIndex has no getItemLayout to work from, so a far-offscreen
        // index can fail. Harmless: the rail is on a cell just pressed.
        onScrollToIndexFailed={() => {}}
        initialNumToRender={20}
        maxToRenderPerBatch={12}
        updateCellsBatchingPeriod={50}
        windowSize={9}
        ListHeaderComponent={
          <View>
            <RuledLabel
              label="End-to-end encrypted"
              minHeight={31}
              marginTop={8}
              marginBottom={12}
            />
            {rows.length === 0 ? (
              <View style={styles.emptyThread}>
                <QuietRoom
                  {...(me
                    ? {
                        you: {
                          peerId: me.userId,
                          displayName: me.displayName,
                          photoB64: me.avatarB64,
                        },
                      }
                    : {})}
                  them={{
                    peerId,
                    displayName:
                      sanitizeDisplayName(chat?.localName) ||
                      sanitizeDisplayName(chat?.displayName),
                    photoB64: chat?.avatarB64,
                  }}
                  accessibilityLabel={`A private chat between you and ${peerRef}`}
                />
                <Text
                  accessibilityRole="header"
                  style={[
                    t.type.sectionTitle,
                    styles.emptyTitle,
                    { color: t.color.inkStrong },
                  ]}
                >
                  This room is ready.
                </Text>
                <Text
                  style={[
                    t.type.compactBody,
                    styles.emptyBody,
                    { color: t.color.inkMuted },
                  ]}
                >
                  {named
                    ? `Write the first message to ${name}.`
                    : 'Write the first message.'}
                </Text>
              </View>
            ) : null}
          </View>
        }
        renderItem={renderItem}
        contentContainerStyle={styles.listContent}
        onContentSizeChange={onContentSizeChange}
        // The keyboard, the error strip and the jump bar all change the list's
        // height; re-anchor instead of pushing the newest message out of view.
        onLayout={() => {
          if (atBottom.current && !railOpenRef.current) {
            listRef.current?.scrollToEnd({ animated: false });
          }
        }}
      />

      {/* The jump bar stands down while a message is selected.
       *
       * Reported from a device: long-press a message near the bottom and this
       * bar sits on top of the rail's Reply / Copy / Delete, and the only way
       * to see past it — scrolling — is exactly what dismisses the rail. So
       * those actions were not merely awkward to reach, they were unreachable:
       * every way of uncovering them destroyed the thing being uncovered.
       *
       * Hidden rather than restyled or re-stacked. Raising the rail above it
       * would leave a control the person cannot use sitting under their
       * thumb, and "jump to the newest message" is meaningless while they are
       * deliberately acting on an older one. It returns the moment the
       * selection ends, and `showJump` is untouched underneath — this only
       * decides whether to render it, so nothing about the scroll position
       * has to be recomputed when the rail closes. */}
      {showJump && railFor === null ? (
        <Pressable
          onPress={jumpToLatest}
          accessibilityRole="button"
          accessibilityLabel="Jump to the newest message"
          testID="jump-latest"
          style={({ pressed }) => [
            styles.jumpRow,
            {
              backgroundColor: pressed ? t.color.pineWash : t.color.paperLayer,
              borderTopWidth: t.hairline,
              borderTopColor: t.color.lineSoft,
              paddingHorizontal: t.layout.gutter,
            },
          ]}
        >
          <Text
            allowFontScaling={false}
            style={[t.type.iconGlyph, { color: t.color.pine }]}
          >
            ↓
          </Text>
          <Text style={[t.type.compactStrong, { color: t.color.pine }]}>
            {hasNew ? 'New messages' : 'Latest messages'}
          </Text>
        </Pressable>
      ) : null}

      {acceptedNotice && !blocked && !peerBlocked ? (
        <InlineNotice
          message="After accepting, send a message and compare the new safety number."
          tone="pine"
          marginTop={0}
          paddingHorizontal={t.layout.gutter}
          action={{ label: 'Compare now', onPress: toggleSafety }}
          testID="accepted-notice"
        />
      ) : null}

      {safetyState === 'mismatched' ? (
        <View
          testID="safety-mismatch-row"
          style={[
            styles.mismatchRow,
            {
              borderTopColor: t.color.danger,
              borderBottomColor: t.color.danger,
              paddingHorizontal: t.layout.gutter,
            },
          ]}
        >
          <Text style={[t.type.compactBody, { color: t.color.danger }]}>
            {COPY.mismatch}
          </Text>
          <Pressable
            onPress={() => void compareAgain()}
            accessibilityRole="button"
            testID="mismatch-compare"
            style={({ pressed }) => [
              styles.textAction,
              { borderRadius: t.radius.button },
              pressed && { backgroundColor: t.color.pineWash },
            ]}
          >
            <Text style={[t.type.compactStrong, { color: t.color.pine }]}>
              Compare again
            </Text>
          </Pressable>
        </View>
      ) : null}

      {/* The mismatch row above stays under a block: it is a safety fact, and
          its action is a local comparison, not something sent. These two are
          about sending, so they go. */}
      {sendError && !blocked && !peerBlocked ? (
        <View>
          <InlineError
            message={sendError.message}
            testID="send-error"
            seq={sendError.seq}
            marginTop={0}
            paddingHorizontal={t.layout.gutter}
          />
          {sendError.settings || failedPhoto ? (
            <View
              style={[
                styles.errorActions,
                {
                  backgroundColor: t.color.dangerWash,
                  borderLeftColor: t.color.danger,
                  paddingHorizontal: t.layout.gutter,
                },
              ]}
            >
              {sendError.settings ? (
                <Pressable
                  onPress={() => quiet(Linking.openSettings())}
                  accessibilityRole="button"
                  testID="open-settings"
                  style={({ pressed }) => [
                    styles.textAction,
                    { borderRadius: t.radius.button },
                    pressed && { backgroundColor: t.color.pineWash },
                  ]}
                >
                  <Text style={[t.type.buttonCompact, { color: t.color.pine }]}>
                    Open Settings
                  </Text>
                </Pressable>
              ) : null}
              {failedPhoto ? (
                <Pressable
                  onPress={() => void retryPhoto()}
                  accessibilityRole="button"
                  testID="photo-retry-send"
                  style={({ pressed }) => [
                    styles.textAction,
                    { borderRadius: t.radius.button },
                    pressed && { backgroundColor: t.color.pineWash },
                  ]}
                >
                  <Text style={[t.type.compactStrong, { color: t.color.pine }]}>
                    Try again
                  </Text>
                </Pressable>
              ) : null}
            </View>
          ) : null}
        </View>
      ) : null}

      {sendingPhoto ? (
        <View
          style={[
            styles.progressRow,
            {
              backgroundColor: t.color.paperLayer,
              paddingHorizontal: t.layout.gutter,
            },
          ]}
        >
          {reduceMotion ? null : (
            <ActivityIndicator size="small" color={t.color.pine} />
          )}
          <Text style={[t.type.compactBody, { color: t.color.inkBody }]}>
            Preparing photo…
          </Text>
        </View>
      ) : null}

      {/* Gated on `closed` only: a normal reconnect must not flash a warning. */}
      {wsState === 'closed' && hasPendingOut ? (
        <View
          testID={`thread-ws-${wsState}`}
          style={[
            styles.offlineRow,
            {
              backgroundColor: t.color.paperLayer,
              borderTopColor: t.color.lineSoft,
              borderBottomColor: t.color.lineSoft,
              paddingHorizontal: t.layout.gutter,
            },
          ]}
        >
          <View
            style={[
              styles.offlineMark,
              {
                backgroundColor: t.color.warningMark,
                borderRadius: t.radius.tail,
              },
            ]}
          />
          <Text
            style={[
              t.type.compactBody,
              styles.offlineText,
              { color: t.color.inkBody },
            ]}
          >
            {COPY.offline}
          </Text>
        </View>
      ) : null}

      {/* The loud skip, deliberately NOT the 1:1 hard pause: one changed
          key must not hand any member a denial of service over everyone
          else's conversation. The legs skip, the banner names who, and the
          room keeps talking. For the owner it is one sentence louder: their identity governs the roster. */}
      {isRoom && roomSkipped.length > 0 ? (
        <View
          testID="room-skip-banner"
          accessibilityRole="alert"
          style={[
            styles.offlineRow,
            {
              backgroundColor: t.color.paperLayer,
              borderTopColor: t.color.warningMark,
              borderBottomColor: t.color.lineSoft,
              paddingHorizontal: t.layout.gutter,
            },
          ]}
        >
          <View
            style={[
              styles.offlineMark,
              {
                backgroundColor: t.color.warningMark,
                borderRadius: t.radius.tail,
              },
            ]}
          />
          <Text
            style={[
              t.type.compactBody,
              styles.offlineText,
              { color: t.color.warningInk },
            ]}
          >
            {(roomSkipped.length === 1
              ? COPY.roomSkip(nameFor(roomSkipped[0]!))
              : COPY.roomSkipMany(
                  roomSkipped.map(nameFor).join(' and '),
                )) +
              (group && roomSkipped.includes(group.ownerId)
                ? ` ${COPY.roomSkipOwner}`
                : '')}
          </Text>
        </View>
      ) : null}

      {/* THE PRE-CONSENT TEACHING LINE: quiet, local,
          system-style — the room-skip banner's shape without its alarm tone.
          Renders while an agent this account has not consented to sits in
          the roster (undecided OR refused), so the agent's silence — the
          server's correct consent refusal — is no longer inexplicable; disappears
          the moment consent is given. LOCAL render only: no envelope, no
          announcement, nothing on any wire. */}
      {isRoom && consentHint !== null ? (
        <View
          testID="room-consent-hint"
          style={[
            styles.offlineRow,
            {
              backgroundColor: t.color.paperLayer,
              borderTopColor: t.color.lineSoft,
              borderBottomColor: t.color.lineSoft,
              paddingHorizontal: t.layout.gutter,
            },
          ]}
        >
          <Text
            style={[
              t.type.compactBody,
              styles.offlineText,
              { color: t.color.inkBody },
            ]}
          >
            {consentHint.state === 'undecided'
              ? COPY.roomConsentUndecided(nameFor(consentHint.agentId))
              : COPY.roomConsentRefused(nameFor(consentHint.agentId))}
          </Text>
        </View>
      ) : null}

      {/* THE DISCOVERY PROVENANCE LINE:
          the consent hint's quiet shape, for a 1:1 the SERVER introduced — a
          discovery lookup resolved this person, so no friend's hand-off
          vouches for the account. Persistent until this phone records a
          safety-number match (the row's `safetyCheckedAt`), which is the one
          act that makes the introducer beside the point. Read from the
          row's own `introducedBy`; a row that predates the column, a QR
          hand-off and a typed id all say no. Local only — nothing on any
          wire — and never for a room, which nobody "found". */}
      {!isRoom &&
      db.serverIntroduced(chat?.introducedBy) &&
      chat?.safetyCheckedAt == null ? (
        <View
          testID="provenance-notice"
          style={[
            styles.offlineRow,
            {
              backgroundColor: t.color.paperLayer,
              borderTopColor: t.color.lineSoft,
              borderBottomColor: t.color.lineSoft,
              paddingHorizontal: t.layout.gutter,
            },
          ]}
        >
          <Text
            style={[
              t.type.compactBody,
              styles.offlineText,
              { color: t.color.inkBody },
            ]}
          >
            {COPY.serverIntroduced}
          </Text>
          <Pressable
            onPress={toggleSafety}
            accessibilityRole="button"
            testID="provenance-compare"
            style={({ pressed }) => [
              styles.textAction,
              { borderRadius: t.radius.button },
              pressed && { backgroundColor: t.color.pineWash },
            ]}
          >
            <Text style={[t.type.compactStrong, { color: t.color.pine }]}>
              Compare now
            </Text>
          </Pressable>
        </View>
      ) : null}

      {/* The standing, VISIBLE partial-mirror warning at
          this entry point. The unblock announcement above speaks once, to
          VoiceOver; this stays for everyone until a reconcile rewrites the
          file, and it renders in BOTH directions — over the blocked banner
          and over the composer an unblock just restored. */}
      {mirrorStale ? (
        <View style={{ paddingHorizontal: t.layout.gutter }}>
          <InlineError
            message={BLOCK.mirrorStale}
            testID="thread-block-mirror-stale"
          />
        </View>
      ) : null}

      {/* A block outranks an unreviewed identity change here. The identity
          banner's whole purpose is to invite Accept-then-send, and sending is
          exactly what a block forbids — showing it would offer an action the
          app has already decided to refuse. */}
      {peerBlocked ? (
        <BlockedBanner
          theme={t}
          maxHeight={Math.round(height * 0.35)}
          onUnblock={() => void unblockPerson()}
        />
      ) : blocked ? (
        <IdentityBanner
          theme={t}
          peerRef={peerRef}
          maxHeight={Math.round(height * 0.35)}
          onReview={toggleSafety}
          onAccept={() => void acceptIdentityChange()}
        />
      ) : (
        <Composer
          theme={t}
          name={
            isRoom
              ? roomName && roomName.length <= PLACEHOLDER_NAME_MAX
                ? roomName
                : null
              : named && name.length <= PLACEHOLDER_NAME_MAX
                ? name
                : null
          }
          draft={draft}
          drawer={drawer}
          onChangeDraft={changeDraft}
          onSelectionChange={changeSelection}
          mention={{
            choices: mentionChoices,
            chips: liveChips,
            onPick: pickMention,
            onRemoveChip: removeMention,
          }}
          onOpenDrawer={openDrawer}
          onSend={() => void send()}
          onAttach={source => void attachPhoto(source)}
          onAttachDocument={() => void attachDocument()}
          onAttachLocation={() => void attachLocation()}
          voice={{
            recording,
            level: recordLevel,
            seconds: recordSeconds,
            hasDraft: voiceDraft !== null,
            draftSeconds: voiceDraft?.durationSec ?? 0,
            elapsed: voiceElapsed,
            previewing: playingVoice === 'draft',
            onStart: startVoice,
            onFinish: finishVoice,
            onDiscard: discardVoice,
            onSend: sendVoiceDraft,
            onPreview: previewVoiceDraft,
          }}
          chip={
            pending
              ? {
                  kind: pending.kind,
                  label:
                    pending.kind === 'edit'
                      ? 'Editing your message'
                      : `Replying to ${
                          pending.row.direction === 'out'
                            ? 'yourself'
                            : // In a room the subject is the AUTHENTICATED
                              // author — never the room's own ref.
                              isRoom && pending.row.authorId
                              ? nameFor(pending.row.authorId)
                              : peerRef
                        }`,
                  // WITH the resolver, like the quote box this chip
                  // previews for: replying to a mention must read
                  // "@Sis lunch? @you", never the words with the marks
                  // dropped. Self pre-empts nameFor exactly as the bubble's
                  // mentionLabelFor does — lowercase 'you', every surface.
                  text: previewFor(pending.row.body, id =>
                    id === me?.userId ? 'you' : nameFor(id),
                  ),
                }
              : null
          }
          onCancelChip={cancelPending}
        />
      )}
    </View>
  );
}

/** Safety number, expanded inline under the header — never a floating card. */
function SafetyPanel({
  theme: t,
  peerRef,
  state,
  safety,
  checkedAt,
  maxHeight,
  onClose,
  onCompareAgain,
  onMatch,
  onMismatch,
}: {
  theme: Theme;
  peerRef: string;
  state: SafetyState;
  safety: string | null;
  checkedAt: number | null;
  maxHeight: number;
  onClose: () => void;
  onCompareAgain: () => void;
  onMatch: () => void;
  onMismatch: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [explaining, setExplaining] = useState(false);
  const copy = SAFETY_COPY[state];
  // Token keys resolved against the live theme — safety.ts names colours,
  // theme.ts owns their values.
  const tone = SAFETY_STATUS[state];
  const status = { rule: t.color[tone.rule], ink: t.color[tone.ink] };
  // Suppressed while an identity change is unreviewed: the digits on screen
  // belong to a key that has already been superseded, so showing sixty
  // authoritative green numerals under "Needs review" actively misleads.
  const showNumber = !!safety && state !== 'changed';

  return (
    <View
      style={[
        styles.safetyPanel,
        {
          backgroundColor: t.color.paperLayer,
          borderBottomColor: t.color.lineSoft,
          paddingHorizontal: t.layout.gutter,
        },
      ]}
    >
      <View style={styles.safetyTop}>
        <Text
          accessibilityRole="header"
          style={[t.type.rowTitle, { color: t.color.inkStrong }]}
        >
          Safety number
        </Text>
        <Pressable
          onPress={onClose}
          accessibilityRole="button"
          style={({ pressed }) => [
            styles.safetyClose,
            { borderRadius: t.radius.button },
            pressed && { backgroundColor: t.color.pineWash },
          ]}
        >
          <Text style={[t.type.buttonCompact, { color: t.color.pine }]}>
            Close
          </Text>
        </Pressable>
      </View>

      {/* Bounded so large text cannot push the composer off screen while the
          title row — and therefore Close — stays put. */}
      <ScrollView style={{ maxHeight }}>
        <View style={styles.safetyStatusRow}>
          <View
            style={[styles.safetyStatusRule, { backgroundColor: status.rule }]}
          />
          <Text style={[t.type.utilityLabel, { color: status.ink }]}>
            {copy.label}
          </Text>
        </View>

        {showNumber && safety ? (
          <View
            testID="safety-number"
            accessible
            accessibilityLabel={spokenSafetyNumber(safety)}
            accessibilityHint="Read these aloud and check every group matches on the other device"
            style={styles.safetyGrid}
          >
            {/* Count-driven, not wrapped: two people reading digits to each
                other need the same grid on both phones at any width and any
                text size. Twelve groups, three per row, four rows. */}
            {safetyGroups(safety).map((group, i) => (
              <Text
                key={i}
                importantForAccessibility="no-hide-descendants"
                style={[
                  t.type.safetyNumber,
                  styles.safetyCell,
                  { color: t.color.pine },
                ]}
                // No adjustsFontSizeToFit: shrinking digits to fit a fixed
                // cell is the wrong trade for the one number in the app two
                // people read aloud to each other. The cell wraps instead.
              >
                {group}
              </Text>
            ))}
          </View>
        ) : null}

        <Text
          style={[
            t.type.compactBody,
            styles.safetyHint,
            { color: t.color.inkBody },
          ]}
        >
          {copy.body(
            peerRef,
            checkedAt != null ? safetyDate(checkedAt) : undefined,
          )}
        </Text>

        {copy.disclosure ? (
          <Text
            style={[
              t.type.compactBody,
              styles.safetyHint,
              { color: t.color.inkMuted },
            ]}
          >
            {copy.disclosure(peerRef)}
          </Text>
        ) : null}

        {confirming ? (
          <View>
            <Text
              style={[
                t.type.compactBody,
                styles.safetyHint,
                { color: t.color.inkBody },
              ]}
            >
              Did every group match?
            </Text>
            <View style={styles.safetyActions}>
              <Pressable
                onPress={() => {
                  setConfirming(false);
                  onMatch();
                }}
                accessibilityRole="button"
                testID="safety-match"
                style={({ pressed }) => [
                  styles.textAction,
                  { borderRadius: t.radius.button },
                  pressed && { backgroundColor: t.color.pineWash },
                ]}
              >
                <Text style={[t.type.compactStrong, { color: t.color.pine }]}>
                  They match
                </Text>
              </Pressable>
              <Pressable
                onPress={() => {
                  setConfirming(false);
                  onMismatch();
                }}
                accessibilityRole="button"
                testID="safety-no-match"
                style={({ pressed }) => [
                  styles.textAction,
                  { borderRadius: t.radius.button },
                  pressed && { backgroundColor: t.color.dangerWash },
                ]}
              >
                <Text style={[t.type.compactStrong, { color: t.color.danger }]}>
                  They don’t match
                </Text>
              </Pressable>
            </View>
          </View>
        ) : (
          <View style={styles.safetyActions}>
            {state === 'unchecked' ? (
              <Pressable
                onPress={() => setConfirming(true)}
                accessibilityRole="button"
                testID="safety-primary"
                style={({ pressed }) => [
                  styles.textAction,
                  { borderRadius: t.radius.button },
                  pressed && { backgroundColor: t.color.pineWash },
                ]}
              >
                <Text style={[t.type.compactStrong, { color: t.color.pine }]}>
                  {copy.action}
                </Text>
              </Pressable>
            ) : null}
            {state === 'matched' || state === 'mismatched' ? (
              // Not "Check again": the old control stamped a fresh
              // verification that never happened. This clears the record so
              // the next comparison is the one on the screen.
              <Pressable
                onPress={onCompareAgain}
                accessibilityRole="button"
                testID="safety-primary"
                style={({ pressed }) => [
                  styles.textAction,
                  { borderRadius: t.radius.button },
                  pressed && { backgroundColor: t.color.pineWash },
                ]}
              >
                <Text style={[t.type.compactStrong, { color: t.color.pine }]}>
                  {copy.action}
                </Text>
              </Pressable>
            ) : null}
            <Pressable
              onPress={() => setExplaining(v => !v)}
              accessibilityRole="button"
              accessibilityState={{ expanded: explaining }}
              testID="safety-explain"
              style={({ pressed }) => [
                styles.textAction,
                { borderRadius: t.radius.button },
                pressed && { backgroundColor: t.color.pineWash },
              ]}
            >
              <Text style={[t.type.buttonCompact, { color: t.color.pine }]}>
                What this is
              </Text>
            </Pressable>
          </View>
        )}

        {explaining
          ? SAFETY_EXPLAINER.map(line => (
              <Text
                key={line}
                style={[
                  t.type.compactBody,
                  styles.safetyHint,
                  { color: t.color.inkMuted },
                ]}
              >
                {line}
              </Text>
            ))
          : null}
      </ScrollView>
    </View>
  );
}

/**
 * Replaces the composer while this device blocks the person. Same anatomy as
 * IdentityBanner, in the block's own tone: paper and a slate rule rather than
 * the danger wash, and no alert glyph — this is a setting the person chose,
 * not a warning about something that went wrong.
 */
function BlockedBanner({
  theme: t,
  maxHeight,
  onUnblock,
}: {
  theme: Theme;
  maxHeight: number;
  onUnblock: () => void;
}) {
  const rootRef = useRef<View>(null);

  // The composer a person was about to type into has just disappeared. On iOS
  // nothing announces that, and VoiceOver focus is left on a view that is gone.
  useEffect(() => {
    AccessibilityInfo.announceForAccessibilityWithOptions(
      BLOCK.bannerAnnounce,
      { queue: true },
    );
    const tag = findNodeHandle(rootRef.current);
    if (tag != null) AccessibilityInfo.setAccessibilityFocus(tag);
  }, []);

  return (
    <View
      ref={rootRef}
      testID="blocked-banner"
      accessibilityRole="alert"
      style={[
        styles.banner,
        {
          backgroundColor: t.color.paperLayer,
          borderTopColor: t.color.warningMark,
          borderLeftColor: t.color.warningMark,
          paddingHorizontal: t.layout.gutter,
        },
      ]}
    >
      {/* Bounded, so the three sentences cannot push the unblock control off
          the bottom of the screen at accessibility text sizes. */}
      <ScrollView style={{ maxHeight }}>
        <View style={styles.bannerTitleRow}>
          <Text
            style={[
              t.type.bodyStrong,
              styles.bannerTitle,
              { color: t.color.inkStrong },
            ]}
          >
            {BLOCK.blockedTitle}
          </Text>
        </View>
        {/* Says what actually happens — their messages arrive and are thrown
            away — rather than implying they were stopped from sending. */}
        <Text
          style={[
            t.type.compactBody,
            styles.bannerBody,
            { color: t.color.inkBody },
          ]}
        >
          {BLOCK.blockedBody}
        </Text>
        <Text
          style={[
            t.type.compactStrong,
            styles.bannerBody,
            { color: t.color.warningInk },
          ]}
        >
          {BLOCK.blockedQuiet}
        </Text>
      </ScrollView>
      <View style={styles.bannerActions}>
        <Pressable
          onPress={onUnblock}
          testID="banner-unblock"
          accessibilityRole="button"
          accessibilityLabel={BLOCK.unblock}
          style={({ pressed }) => [
            styles.bannerButton,
            {
              borderColor: t.color.pineLine,
              borderRadius: t.radius.button,
              backgroundColor: pressed ? t.color.pineWash : 'transparent',
            },
          ]}
        >
          <Text style={[t.type.compactStrong, { color: t.color.pine }]}>
            {BLOCK.unblock}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

/** Replaces the composer while an identity change is unreviewed. */
function IdentityBanner({
  theme: t,
  peerRef,
  maxHeight,
  onReview,
  onAccept,
}: {
  theme: Theme;
  peerRef: string;
  maxHeight: number;
  onReview: () => void;
  onAccept: () => void;
}) {
  const rootRef = useRef<View>(null);

  // The composer a person was about to type into has just disappeared. On iOS
  // nothing announces that, and VoiceOver focus is left on a view that is gone.
  useEffect(() => {
    AccessibilityInfo.announceForAccessibilityWithOptions(
      `Sending is paused. ${peerRef}’s safety number changed on this ${DEVICE_NOUN}.`,
      { queue: true },
    );
    const tag = findNodeHandle(rootRef.current);
    if (tag != null) AccessibilityInfo.setAccessibilityFocus(tag);
  }, [peerRef]);

  return (
    <View
      ref={rootRef}
      testID="identity-banner"
      accessibilityRole="alert"
      style={[
        styles.banner,
        {
          backgroundColor: t.color.dangerWash,
          borderTopColor: t.color.danger,
          borderLeftColor: t.color.danger,
          paddingHorizontal: t.layout.gutter,
        },
      ]}
    >
      <ScrollView style={{ maxHeight }}>
        <View style={styles.bannerTitleRow}>
          <View
            style={[styles.alertSquare, { borderColor: t.color.danger }]}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          >
            <Text
              allowFontScaling={false}
              style={[t.type.utilityLabel, { color: t.color.danger }]}
            >
              !
            </Text>
          </View>
          <Text
            style={[
              t.type.bodyStrong,
              styles.bannerTitle,
              { color: t.color.inkStrong },
            ]}
          >
            {SAFETY_COPY.changed.title?.(peerRef)}
          </Text>
        </View>
        {/* Both readings, not only the reassuring one: copy that offers just
            the innocent explanation makes Accept the obvious move and the
            warning does no work at all. */}
        <Text
          style={[
            t.type.compactBody,
            styles.bannerBody,
            { color: t.color.inkBody },
          ]}
        >
          {SAFETY_COPY.changed.body(peerRef)}
        </Text>
        <Text
          style={[
            t.type.compactStrong,
            styles.bannerBody,
            { color: t.color.danger },
          ]}
        >
          {COPY.safetyBlocked}
        </Text>
      </ScrollView>
      <View style={styles.bannerActions}>
        <Pressable
          onPress={onReview}
          testID="banner-verify"
          accessibilityRole="button"
          style={({ pressed }) => [
            styles.bannerButton,
            {
              borderColor: t.color.pineLine,
              borderRadius: t.radius.button,
              backgroundColor: pressed ? t.color.pineWash : 'transparent',
            },
          ]}
        >
          <Text style={[t.type.compactStrong, { color: t.color.pine }]}>
            Review change
          </Text>
        </Pressable>
        <Pressable
          onPress={onAccept}
          testID="banner-accept"
          accessibilityRole="button"
          style={({ pressed }) => [
            styles.bannerButton,
            {
              borderColor: t.color.danger,
              borderRadius: t.radius.button,
              backgroundColor: pressed ? t.color.dangerWash : 'transparent',
            },
          ]}
        >
          <Text style={[t.type.compactStrong, { color: t.color.danger }]}>
            Accept change
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

/** Composer plus its attached drawers. The drawers share the composer's seam. */
function Composer({
  theme: t,
  name,
  draft,
  drawer,
  onChangeDraft,
  onSelectionChange,
  mention,
  onOpenDrawer,
  onSend,
  onAttach,
  onAttachDocument,
  onAttachLocation,
  voice,
  chip,
  onCancelChip,
}: {
  theme: Theme;
  /** null when nobody has shared a name, or the name is too long to fit.
   * A room's composer carries the full set — photos, camera, documents,
   * locations, the mic — because every send path underneath is room-aware: the same composer, dialling fanOut. */
  name: string | null;
  draft: string;
  drawer: Drawer;
  onChangeDraft: (v: string) => void;
  /** The caret, for the @-query — the picker must follow a tap into the
   * middle of the draft, not only typing. */
  onSelectionChange: (sel: { start: number; end: number }) => void;
  /** @-mentions (rooms only; the parent hands a 1:1 empty lists). The
   * picker and the chip strip are drawers seamed to the composer, exactly
   * like the attach grid — never a floating overlay. */
  mention: {
    /** Who the active @-query matches; empty = no picker. */
    choices: { id: string; name: string; rawName: string | null }[];
    /** The mentions the draft is carrying, already validated. */
    chips: MentionChip[];
    onPick: (id: string) => void;
    onRemoveChip: (chip: MentionChip) => void;
  };
  onOpenDrawer: (d: Drawer) => void;
  onSend: () => void;
  onAttach: (source: PickSource) => void;
  onAttachDocument: () => void | Promise<void>;
  onAttachLocation: () => void | Promise<void>;
  /** Voice: the mic takes the send position only when there is nothing to
   * send and nothing being answered or rewritten. */
  voice: {
    recording: boolean;
    level: number;
    seconds: number;
    hasDraft: boolean;
    /** Length of the unsent take, and the play head while previewing it. */
    draftSeconds: number;
    elapsed: number;
    onStart: () => void;
    onFinish: () => void;
    onDiscard: () => void;
    onSend: () => void;
    onPreview: () => void;
    previewing: boolean;
  };
  /** What this composer is answering or rewriting, already named. */
  chip: { kind: 'reply' | 'edit'; label: string; text: string } | null;
  onCancelChip: () => void;
}) {
  const canSend = draft.trim().length > 0;
  // The chip is attached to the composer exactly like a drawer, so it flattens
  // the same seam: two stacked slabs with rounded corners between them would
  // read as floating cards. The mention PICKER is such a slab and joins it;
  // the mention chip strip is bare pills on the ground, so it does not — a
  // squared corner under nothing solid reads as a glitch.
  const open =
    drawer !== 'none' || chip !== null || mention.choices.length > 0;
  // A ref, not state: the input stays uncontrolled with respect to selection,
  // so a programmatic cursor can never fight the person typing.
  const selection = useRef({ start: 0, end: 0 });

  const insertEmoji = (emoji: string) => {
    const start = Math.min(selection.current.start, draft.length);
    const end = Math.min(Math.max(selection.current.end, start), draft.length);
    onChangeDraft(draft.slice(0, start) + emoji + draft.slice(end));
    const after = start + emoji.length;
    selection.current = { start: after, end: after };
    onOpenDrawer('none');
  };

  return (
    <View
      style={[
        styles.composerWrap,
        {
          backgroundColor: t.color.paperGround,
          borderTopColor: t.color.lineSoft,
        },
      ]}
    >
      {/* What this message is about to do to another one, attached to the
          composer so the answer and the thing answered stay together. */}
      {chip ? (
        <View
          testID="composer-chip"
          style={[
            styles.chip,
            {
              backgroundColor: t.color.paperLayer,
              borderColor: t.color.lineSoft,
              borderTopLeftRadius: t.radius.drawer,
              borderTopRightRadius: t.radius.drawer,
            },
          ]}
        >
          <View style={[styles.chipBar, { backgroundColor: t.color.pine }]} />
          <View style={styles.chipBody}>
            <Text style={[t.type.utilityLabel, { color: t.color.pine }]}>
              {chip.label}
            </Text>
            <Text
              numberOfLines={1}
              style={[
                t.type.compactBody,
                styles.chipText,
                { color: t.color.inkMuted },
              ]}
            >
              {chip.text}
            </Text>
          </View>
          <Pressable
            onPress={onCancelChip}
            accessibilityRole="button"
            accessibilityLabel="Cancel"
            testID="composer-chip-cancel"
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            style={({ pressed }) => [
              styles.chipCancel,
              {
                borderRadius: t.radius.circle,
                backgroundColor: pressed ? t.color.pineWash : 'transparent',
              },
            ]}
          >
            <Text style={[t.type.iconGlyph, { color: t.color.inkMuted }]}>
              ✕
            </Text>
          </Pressable>
        </View>
      ) : null}
      {/* A warning, not a block: the honest limit depends on ratchet state, so
          "That message is too long to send." remains the backstop. */}
      {draft.length > COUNTER_WARN ? (
        <Text
          accessibilityLabel={`${draft.length} characters`}
          style={[
            t.type.counter,
            styles.counter,
            {
              color:
                draft.length > COUNTER_DANGER
                  ? t.color.danger
                  : t.color.inkMuted,
            },
          ]}
        >
          {draft.length}
        </Text>
      ) : null}

      {drawer === 'attach' ? (
        <View
          style={[
            styles.drawer,
            {
              backgroundColor: t.color.paperLayer,
              borderColor: t.color.lineStrong,
              borderTopLeftRadius: t.radius.drawer,
              borderTopRightRadius: t.radius.drawer,
            },
          ]}
        >
          <View style={styles.drawerGrid}>
            <DrawerAction
              theme={t}
              label="Photos"
              hint={`From this ${DEVICE_NOUN}`}
              icon={PhotoGlyph}
              onPress={() => onAttach('library')}
              testID="attach-library"
            />
            <DrawerAction
              theme={t}
              label="Camera"
              hint="Not saved to your Photos"
              icon={CameraGlyph}
              onPress={() => onAttach('camera')}
              testID="attach-camera"
            />
            <DrawerAction
              theme={t}
              label="Document"
              hint="Up to 7 megabytes, encrypted like everything else"
              icon={DocumentGlyph}
              onPress={() => void onAttachDocument()}
              testID="attach-document"
            />
            <DrawerAction
              theme={t}
              label="Location"
              hint="Read once, only when you tap this"
              icon={LocationGlyph}
              onPress={() => void onAttachLocation()}
              testID="attach-location"
            />
          </View>
          {/* The one promise the icons could be read as making and the app
              does not keep: a photo taken here never reaches the camera roll.
              Said once, under the grid, rather than four times inside it. */}
          <Text
            style={[
              t.type.utilityLabel,
              styles.drawerFootnote,
              { color: t.color.inkMuted },
            ]}
          >
            Photos you take here aren’t saved to your Photos.
          </Text>
        </View>
      ) : null}

      {drawer === 'emoji' ? (
        <View
          style={[
            styles.drawer,
            {
              minHeight: t.layout.emojiDrawerHeight,
              backgroundColor: t.color.paperLayer,
              borderColor: t.color.lineStrong,
              borderTopLeftRadius: t.radius.drawer,
              borderTopRightRadius: t.radius.drawer,
            },
          ]}
        >
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.emojiRow}
          >
            {QUICK_EMOJI.map(emoji => (
              <Pressable
                key={emoji}
                onPress={() => insertEmoji(emoji)}
                accessibilityRole="button"
                accessibilityLabel={`Add ${emoji}`}
                style={({ pressed }) => [
                  styles.emojiChoice,
                  { borderRadius: t.radius.button },
                  pressed && { backgroundColor: t.color.pineWash },
                ]}
              >
                <Text style={t.type.emojiChoice}>{emoji}</Text>
              </Pressable>
            ))}
          </ScrollView>
        </View>
      ) : null}

      {voice.recording || voice.hasDraft ? (
        <View style={styles.voiceBar}>
          {voice.recording ? (
            <>
              <Pressable
                onPress={voice.onDiscard}
                accessibilityRole="button"
                accessibilityLabel="Discard this recording"
                testID="voice-discard"
                style={styles.composerIcon}
              >
                <CloseGlyph size={20} color={t.color.danger} />
              </Pressable>
              {/* The level is a fact about the microphone, so it is drawn
                  rather than described: a bar that does not move is how a
                  person learns the mic is not hearing them. */}
              <View style={[styles.voiceLevelTrack, { backgroundColor: t.color.pineWashFaint }]}>
                <View
                  style={[
                    styles.voiceLevelFill,
                    {
                      backgroundColor: t.color.pine,
                      width: `${Math.round(Math.max(0, Math.min(1, voice.level)) * 100)}%`,
                    },
                  ]}
                />
              </View>
              <Text style={[t.type.compactStrong, { color: t.color.inkBody }]}>
                {clockDuration(voice.seconds)}
              </Text>
              <Pressable
                onPress={voice.onFinish}
                accessibilityRole="button"
                accessibilityLabel="Stop recording"
                testID="voice-stop"
                style={styles.composerIcon}
              >
                <PauseGlyph size={20} color={t.color.pine} />
              </Pressable>
            </>
          ) : (
            <>
              <Pressable
                onPress={voice.onDiscard}
                accessibilityRole="button"
                accessibilityLabel="Discard this voice message"
                testID="voice-discard"
                style={styles.composerIcon}
              >
                <CloseGlyph size={20} color={t.color.danger} />
              </Pressable>
              <Pressable
                onPress={voice.onPreview}
                accessibilityRole="button"
                accessibilityLabel={
                  voice.previewing ? 'Stop playing' : 'Play this voice message'
                }
                testID="voice-preview"
                style={styles.composerIcon}
              >
                {voice.previewing ? (
                  <PauseGlyph size={20} color={t.color.pine} />
                ) : (
                  <PlayGlyph size={20} color={t.color.pine} />
                )}
              </Pressable>
              {/* Said plainly, because the whole point of this state is that
                  nothing has been sent yet — and while it plays back, the
                  same counting clock the bubbles use. */}
              <Text style={[t.type.compactBody, { color: t.color.inkMuted, flex: 1 }]}>
                {voice.previewing
                  ? `${clockDuration(voice.elapsed)} / ${clockDuration(voice.draftSeconds)}`
                  : 'Ready to send'}
              </Text>
              <Pressable
                onPress={voice.onSend}
                accessibilityRole="button"
                accessibilityLabel="Send this voice message"
                testID="voice-send"
                style={styles.composerIcon}
              >
                <View
                  style={[
                    styles.sendDisc,
                    {
                      width: t.layout.sendDisc,
                      height: t.layout.sendDisc,
                      borderRadius: t.layout.sendDisc / 2,
                      borderColor: t.color.pineLine,
                    },
                  ]}
                >
                  <Text
                    allowFontScaling={false}
                    style={[t.type.iconGlyph, { color: t.color.pine }]}
                  >
                    ↑
                  </Text>
                </View>
              </Pressable>
            </>
          )}
        </View>
      ) : null}

      {/* The member picker for an active @-query (rooms only — the parent
          hands a 1:1 an empty list). A drawer seamed to the composer like
          the attach grid; it scrolls inside a ceiling because it sits over
          a keyboard, and at accessibility sizes the rows GROW — scrolling,
          never clipping. Each row is a PERSON, so it wears the circle. */}
      {mention.choices.length > 0 ? (
        <View
          testID="mention-picker"
          style={[
            styles.drawer,
            styles.mentionDrawer,
            {
              backgroundColor: t.color.paperLayer,
              borderColor: t.color.lineStrong,
              borderTopLeftRadius: t.radius.drawer,
              borderTopRightRadius: t.radius.drawer,
            },
          ]}
        >
          <ScrollView
            style={{ maxHeight: MENTION_PICKER_MAX_HEIGHT }}
            keyboardShouldPersistTaps="always"
          >
            {mention.choices.map(m => (
              <Pressable
                key={m.id}
                onPress={() => mention.onPick(m.id)}
                accessibilityRole="button"
                accessibilityLabel={`Mention ${m.name}`}
                testID={`mention-pick-${m.id}`}
                style={({ pressed }) => [
                  styles.mentionRow,
                  { minHeight: t.layout.touchTarget },
                  pressed && { backgroundColor: t.color.pineWash },
                ]}
              >
                <Avatar
                  peerId={m.id}
                  displayName={m.rawName}
                  size={t.layout.avatar.room}
                />
                <Text
                  numberOfLines={1}
                  style={[
                    t.type.compactStrong,
                    styles.mentionName,
                    { color: t.color.inkStrong },
                  ]}
                >
                  {m.name}
                </Text>
              </Pressable>
            ))}
          </ScrollView>
        </View>
      ) : null}

      {/* Who this message will summon — the chips' visible body, attached to
          the composer like the reply chip. The strip is what makes an
          inserted mention DISTINCT from typed text (and gives it its ✕):
          when a person edits the token into plain words, its pill leaves
          this strip, which is the honest signal it will send as words. */}
      {mention.chips.length > 0 ? (
        <View testID="mention-chips" style={styles.mentionChipRow}>
          {mention.chips.map(chipItem => (
            <View
              key={`${chipItem.start}:${chipItem.id}`}
              style={[
                styles.mentionChip,
                {
                  backgroundColor: t.color.pineWash,
                  borderColor: t.color.pineLine,
                  borderRadius: t.radius.button,
                },
              ]}
            >
              <Text
                style={[t.type.compactStrong, { color: t.color.pine }]}
              >
                @{chipItem.name}
              </Text>
              <Pressable
                onPress={() => mention.onRemoveChip(chipItem)}
                accessibilityRole="button"
                accessibilityLabel={`Remove the mention of ${chipItem.name}`}
                testID={`mention-chip-remove-${chipItem.start}`}
                hitSlop={{ top: 8, bottom: 8, left: 4, right: 8 }}
                style={styles.mentionChipCancel}
              >
                <Text style={[t.type.iconGlyph, { color: t.color.inkMuted }]}>
                  ✕
                </Text>
              </Pressable>
            </View>
          ))}
        </View>
      ) : null}
      <View
        style={[
          styles.composer,
          {
            backgroundColor: t.color.paperSheet,
            borderColor: t.color.lineStrong,
            borderRadius: t.radius.composer,
            borderTopLeftRadius: open ? 0 : t.radius.composer,
            borderTopRightRadius: open ? 0 : t.radius.composer,
          },
        ]}
      >
        <Pressable
          onPress={() => onOpenDrawer('attach')}
          accessibilityRole="button"
          accessibilityLabel="Add a photo"
          accessibilityState={{ expanded: drawer === 'attach' }}
          testID="composer-attach"
          style={({ pressed }) => [
            styles.composerIcon,
            { borderRadius: t.radius.circle },
            pressed && { backgroundColor: t.color.pineWash },
          ]}
        >
          <Text
            allowFontScaling={false}
            style={[t.type.iconGlyph, { color: t.color.pine }]}
          >
            +
          </Text>
        </Pressable>

        <TextInput
          style={[
            t.type.input,
            styles.composerInput,
            { color: t.color.inkStrong },
          ]}
          placeholder={name ? `Message ${name}` : 'Message'}
          placeholderTextColor={t.color.inkMuted}
          value={draft}
          onChangeText={onChangeDraft}
          onSelectionChange={e => {
            selection.current = e.nativeEvent.selection;
            onSelectionChange(e.nativeEvent.selection);
          }}
          onFocus={() => onOpenDrawer('none')}
          // Pressing into an already-focused field fires no onFocus, so a
          // drawer would sit open occupying the keyboard's place.
          onPressIn={() => onOpenDrawer('none')}
          multiline
          testID="composer-input"
        />

        <Pressable
          onPress={() => onOpenDrawer('emoji')}
          accessibilityRole="button"
          accessibilityLabel="Add an emoji"
          accessibilityState={{ expanded: drawer === 'emoji' }}
          testID="composer-emoji"
          style={({ pressed }) => [
            styles.composerIcon,
            { borderRadius: t.radius.circle },
            pressed && { backgroundColor: t.color.pineWash },
          ]}
        >
          <Text
            allowFontScaling={false}
            style={[t.type.iconGlyph, { color: t.color.pine }]}
          >
            ☺
          </Text>
        </Pressable>

        {/* The mic takes this slot only when the send control would be
            disabled anyway AND nothing is being answered or rewritten —
            a reply chip means the person is mid-sentence, not mid-thought. */}
        {!canSend && !chip ? (
          <Pressable
            onPress={voice.onStart}
            accessibilityRole="button"
            accessibilityLabel="Record a voice message"
            testID="composer-mic"
            style={styles.composerIcon}
          >
            {({ pressed }) => (
              <View
                style={[
                  styles.sendDisc,
                  {
                    width: t.layout.sendDisc,
                    height: t.layout.sendDisc,
                    borderRadius: t.layout.sendDisc / 2,
                    backgroundColor: pressed ? t.color.pineWash : 'transparent',
                    borderColor: t.color.pineLine,
                  },
                ]}
              >
                <MicGlyph size={20} color={t.color.pine} />
              </View>
            )}
          </Pressable>
        ) : (
        <Pressable
          onPress={onSend}
          disabled={!canSend}
          accessibilityRole="button"
          accessibilityLabel="Send message"
          accessibilityState={{ disabled: !canSend }}
          testID="composer-send"
          style={styles.composerIcon}
        >
          {/* An outlined ring with a green arrow, not a filled disc — the
              send control matches the site's phone and relay views in both
              palettes, and disabled recedes to a soft line. */}
          {({ pressed }) => (
            <View
              style={[
                styles.sendDisc,
                {
                  width: t.layout.sendDisc,
                  height: t.layout.sendDisc,
                  borderRadius: t.layout.sendDisc / 2,
                  backgroundColor: !canSend
                    ? 'transparent'
                    : pressed
                      ? t.color.pineWash
                      : 'transparent',
                  borderColor: !canSend ? t.color.lineSoft : t.color.pineLine,
                },
              ]}
            >
              <Text
                allowFontScaling={false}
                style={[
                  t.type.iconGlyph,
                  { color: canSend ? t.color.pine : t.color.inkMuted },
                ]}
              >
                ↑
              </Text>
            </View>
          )}
        </Pressable>
        )}
      </View>
    </View>
  );
}

/**
 * One attach choice: a disc of line art with its name underneath.
 *
 * The description each row used to carry moved to `accessibilityHint`, not
 * to nothing — a screen reader still hears "Not saved to your Photos", and
 * the sighted version of the one disclosure that matters sits under the grid
 * where it is said once instead of four times.
 */
function DrawerAction({
  theme: t,
  label,
  hint,
  icon: Icon,
  onPress,
  testID,
}: {
  theme: Theme;
  label: string;
  hint: string;
  icon: (props: { size?: number; color: string }) => React.JSX.Element;
  onPress: () => void;
  testID: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      testID={testID}
      style={styles.drawerAction}
    >
      {({ pressed }) => (
        <>
          <View
            style={[
              styles.drawerDisc,
              {
                backgroundColor: pressed ? t.color.pineLine : t.color.pineWash,
                borderColor: t.color.pineLine,
              },
            ]}
          >
            <Icon size={22} color={t.color.pine} />
          </View>
          <Text
            numberOfLines={1}
            style={[t.type.utilityLabel, styles.drawerLabel, { color: t.color.inkBody }]}
          >
            {label}
          </Text>
        </>
      )}
    </Pressable>
  );
}

interface MessageRowProps {
  item: ThreadItem;
  index: number;
  theme: Theme;
  viewportWidth: number;
  reduceMotion: boolean;
  /** How to name the peer inside a sentence. */
  peerRef: string;
  /** The room's anchor, null in a 1:1. Owner is the declined/counted line. */
  room: db.GroupRow | null;
  /** Label for an authenticated author id — authorId in, names out. */
  nameFor: (id: string) => string;
  /** Whether an authenticated id is a recorded machine — the AI
   * badge's one question. Memoised on the machine record like nameFor is on
   * the name map, for the same comparator. */
  isAgentId: (id: string) => boolean;
  /** A 1:1 whose peer is a recorded machine: inbound rows carry no authorId
   * there, and the authenticated sender is the thread's peer. */
  peerIsAgent: boolean;
  /** My own account id, so a roster row can say "you" about me. */
  selfId: string | null;
  /**
   * Everything a long press would reach is withdrawn: the rail, the rotor
   * actions, the reaction chips, the retry control. Named for what it DOES
   * rather than for either reason it can be true — the two reasons (an
   * unreviewed identity change, and a block) are joined once, explicitly, at
   * the single call site in renderItem.
   */
  interactionsOff: boolean;
  attachment: AttachmentMeta | undefined;
  reactions: db.ReactionRow[] | undefined;
  /** The room's honest failure line for MY fan-out — null in a 1:1, for inbound rows, and while
   * nothing has failed. Derived at the call site from the thread's batched
   * ledger read, so this component never queries. */
  deliveryNotice: string | null;
  railOpen: boolean;
  railIntent: RailIntent;
  onLongPress: (row: db.MessageRow, index: number, intent?: RailIntent) => void;
  onReact: (row: db.MessageRow, emoji: string) => void;
  onOpenPhoto: (row: db.MessageRow) => void;
  onRetryPhoto: (row: db.MessageRow) => void;
  /** `${msgId}:${direction}` of the note currently playing, or null. */
  playingVoice: string | null;
  /** Decoded lengths that disagreed with a sender's claim. */
  trueDurations: Map<string, number>;
  /** Play head of whichever note is playing, in seconds. */
  voiceElapsed: number;
  onToggleVoice: (row: db.MessageRow) => void;
  onRetrySend: (row: db.MessageRow) => void;
  onRemove: (row: db.MessageRow) => void;
  onRemoveEverywhere: (row: db.MessageRow) => void;
  onReply: (row: db.MessageRow) => void;
  onEdit: (row: db.MessageRow) => void;
  /** The message this one answers, already resolved — undefined when it is
   * not on this device (deleted here, or older than this install). */
  quoted: db.MessageRow | undefined;
  /** The stream snapshot painted over this inbound bubble while the
   * reply is still being written — undefined when the bubble shows durable
   * truth (no stream, faded, or closed by the final edit). */
  overlay: StreamEditOverlay | undefined;
}

/**
 * Every field that reaches the screen, compared explicitly. The rows and the
 * attachment metadata are fresh objects on every requery, so identity equality
 * alone would make React.memo decorative — and a thread with photos requeries
 * on every receipt, reaction and download tick.
 */
function sameRowProps(a: MessageRowProps, b: MessageRowProps): boolean {
  if (
    a.index !== b.index ||
    a.theme !== b.theme ||
    a.viewportWidth !== b.viewportWidth ||
    a.reduceMotion !== b.reduceMotion ||
    a.peerRef !== b.peerRef ||
    a.interactionsOff !== b.interactionsOff ||
    a.deliveryNotice !== b.deliveryNotice ||
    a.railOpen !== b.railOpen ||
    a.railIntent !== b.railIntent
  ) {
    return false;
  }
  // The anchor is re-read on every requery, so compare its three constants
  // rather than its identity; `nameFor` is memoised on the name map, which
  // keeps ITS identity across same-valued reloads for exactly this line.
  if (
    a.room?.groupId !== b.room?.groupId ||
    a.room?.ownerId !== b.room?.ownerId ||
    a.room?.name !== b.room?.name ||
    a.nameFor !== b.nameFor ||
    // Same discipline as nameFor: isAgentId keeps its identity while the
    // machine record is same-valued, so this line repaints rows exactly when
    // the record actually changes.
    a.isAgentId !== b.isAgentId ||
    a.peerIsAgent !== b.peerIsAgent ||
    a.selfId !== b.selfId
  ) {
    return false;
  }
  if (
    a.onLongPress !== b.onLongPress ||
    a.onReact !== b.onReact ||
    a.onOpenPhoto !== b.onOpenPhoto ||
    a.onRetryPhoto !== b.onRetryPhoto ||
    a.onRetrySend !== b.onRetrySend ||
    a.onRemove !== b.onRemove ||
    a.onRemoveEverywhere !== b.onRemoveEverywhere ||
    a.onReply !== b.onReply ||
    a.onEdit !== b.onEdit ||
    a.playingVoice !== b.playingVoice ||
    a.trueDurations !== b.trueDurations ||
    a.voiceElapsed !== b.voiceElapsed ||
    a.onToggleVoice !== b.onToggleVoice
  ) {
    return false;
  }
  // A quote is rendered from the referenced row, so a change to THAT row's
  // words has to repaint this one.
  if (
    a.quoted?.msgId !== b.quoted?.msgId ||
    a.quoted?.body !== b.quoted?.body ||
    a.quoted?.deletedAt !== b.quoted?.deletedAt
  ) {
    return false;
  }
  // The stream overlay is a fresh object per derivation, so it is compared
  // by value like the rows are — text for the words on screen, `at` because
  // the fade timer's revert changes nothing else about the props.
  if (a.overlay?.text !== b.overlay?.text || a.overlay?.at !== b.overlay?.at) {
    return false;
  }
  const x = a.item;
  const y = b.item;
  if (
    x.firstInGroup !== y.firstInGroup ||
    x.lastInGroup !== y.lastInGroup ||
    x.newDay !== y.newDay ||
    x.showClock !== y.showClock ||
    x.row.msgId !== y.row.msgId ||
    x.row.direction !== y.row.direction ||
    x.row.body !== y.row.body ||
    x.row.ts !== y.row.ts ||
    x.row.status !== y.row.status ||
    // Carriers mutate these in place; without them an edit or a retraction
    // would not repaint the bubble it changed.
    x.row.editedAt !== y.row.editedAt ||
    x.row.deletedAt !== y.row.deletedAt
  ) {
    return false;
  }
  if (
    a.attachment?.state !== b.attachment?.state ||
    a.attachment?.w !== b.attachment?.w ||
    a.attachment?.h !== b.attachment?.h
  ) {
    return false;
  }
  const p = a.reactions ?? [];
  const q = b.reactions ?? [];
  if (p.length !== q.length) return false;
  for (let i = 0; i < p.length; i++) {
    if (p[i].direction !== q[i].direction || p[i].emoji !== q[i].emoji) {
      return false;
    }
  }
  return true;
}

/**
 * A row, plus the provenance line when it did not arrive first-hand.
 *
 * The tag sits ABOVE the ordinary content rather than replacing it, and that
 * ordering is the whole design. An earlier version rendered relayed rows as a
 * self-contained full-width block on the outsider row's pattern, which read
 * well for text and was quietly terrible for everything else: the block showed
 * `displayText(body) || previewFor(body)`, so a relayed photo, file, voice
 * note or location rendered as **"Unsupported message — update Tacendum"**.
 * A newcomer handed a room's history would have been told to update their app
 * once per photo. Found by probing the renderer, not by reading it.
 *
 * So the content goes through the SAME branches as any other message — image,
 * file, voice, location, reply, reaction all work, which is the property
 * rooms already rely on — and provenance is stated above it. The relay does
 * not degrade the message; it annotates it.
 */
const MessageRow = memo(function MessageRow(props: MessageRowProps) {
  const { row } = props.item;
  const inner = <MessageRowInner {...props} />;
  // Outgoing rows are never relayed to me: `sharedBy` marks what SOMEONE ELSE
  // handed me, and my own sends are first-hand by construction.
  if (!row.sharedBy || row.direction === 'out') return inner;
  const t = props.theme;
  const relayer = props.nameFor(row.sharedBy);
  const author = row.authorId ? props.nameFor(row.authorId) : 'Someone';
  return (
    <View testID={`shared-${row.msgId}`}>
      <Text
        testID={`shared-tag-${row.msgId}`}
        // The claim reaches VoiceOver as its own utterance, before the
        // message: a provenance warning that arrives after the content has
        // already been read out is a warning that came too late.
        accessible
        accessibilityRole="text"
        accessibilityLabel={COPY.sharedTag(relayer, author)}
        style={[
          t.type.utilityLabel,
          styles.sharedTag,
          { color: t.color.warningInk },
        ]}
      >
        {COPY.sharedTag(relayer, author)}
      </Text>
      {inner}
    </View>
  );
}, sameRowProps);

function MessageRowInner({
  item,
  index,
  theme: t,
  viewportWidth,
  reduceMotion,
  peerRef,
  room,
  nameFor,
  isAgentId,
  peerIsAgent,
  selfId,
  interactionsOff,
  attachment,
  reactions,
  deliveryNotice,
  railOpen,
  railIntent,
  onLongPress,
  onReact,
  onOpenPhoto,
  onRetryPhoto,
  playingVoice,
  trueDurations,
  voiceElapsed,
  onToggleVoice,
  onRetrySend,
  onRemove,
  onRemoveEverywhere,
  onReply,
  onEdit,
  quoted,
  overlay,
}: MessageRowProps) {
  const { row } = item;
  const out = row.direction === 'out';
  const envelope = parseEnvelope(row.body);
  const inRoom = room !== null;
  /**
   * The AI marker: marker-OR-record (the Art. 50
   * in-conversation half). Two sources, and ONLY these two:
   *
   *  - the machine record: the AUTHENTICATED sender — in a room the
   *    row's authorId, in a 1:1 the thread's peer — looked up in
   *    machine_peers, the app's memory of the server's own adopt/revoke
   *    answers. It KEEPS the badge against a lying client that omits the
   *    marker: a class is never shed by silence.
   *  - the row's `ai` column: the sender-claimed in-envelope marker, recorded AT ARRIVAL like `outsider`. It GAINS
   *    the badge on a phone with no record — the paired-never-adopted 1:1,
   *    and a stranger's phone in a shared room — honest as sender-claimed,
   *    which is the most this wire can say.
   *
   * Never the words, never a shared name, never a render-time body parse —
   * a body that merely LOOKS marked cannot badge a row that arrived
   * unmarked. Inbound only: my own sends are a person typing on this phone.
   *
   * Derived ABOVE every early return (a remediation): the
   * outsider branch returns before the bubble, and a marked agent row whose
   * sender the local fold said was OUT — fold lag on a newly added agent,
   * no adversary required — used to lose both the badge and the spoken
   * attribution with it.
   */
  const aiSender =
    !out &&
    (row.ai === 1 ||
      (inRoom ? row.authorId != null && isAgentId(row.authorId) : peerIsAgent));

  if (row.deletedAt) {
    // Retracted, but not erased from the conversation: a hole where a message
    // was is indistinguishable from one that never arrived. Checked first —
    // a tombstone outranks whatever the body used to be, and offers no rail,
    // because there is nothing left to copy, quote, or rewrite.
    // 'them' is personRef's mid-sentence fallback and 'You' is a name a peer
    // could choose to forge my own voice; neither may hold the subject slot.
    const subject = /^(you|them)$/i.test(peerRef) ? 'They' : peerRef;
    const sentence = out ? COPY.goneOut : COPY.goneIn(subject);
    return (
      <View
        style={{
          marginTop: item.newDay ? 0 : item.firstInGroup ? 14 : 3,
          alignItems: out ? 'flex-end' : 'flex-start',
        }}
      >
        <View
          testID={`tombstone-${row.msgId}`}
          accessible
          accessibilityRole="text"
          accessibilityLabel={sentence}
          style={[
            styles.bubble,
            styles.tombstone,
            {
              maxWidth: Math.min(
                t.layout.bubbleMaxWidth,
                viewportWidth * t.layout.bubbleMaxRatio,
              ),
              borderRadius: t.radius.bubble,
              borderColor: t.color.lineSoft,
            },
          ]}
        >
          <Text
            style={[
              t.type.message,
              styles.tombstoneText,
              { color: t.color.inkMuted },
            ]}
          >
            {sentence}
          </Text>
        </View>
      </View>
    );
  }

  if (
    envelope?.tcm === 'grp.new' ||
    envelope?.tcm === 'grp.roster' ||
    envelope?.tcm === 'grp.set' ||
    envelope?.tcm === 'grp.del' ||
    envelope?.tcm === 'grp.hist' ||
    // The consent announcement rides the same full-width event geometry: a sharing change is an event in the room, not speech.
    envelope?.tcm === 'grp.consent'
  ) {
    // A membership event is an event in the room, not speech: the notices' full-width ruled geometry, no clock, no
    // rail. BEFORE the error branch for the same reason shot/timer/vault
    // are — a row of this kind must never print its envelope JSON in a
    // failed bubble with a retry. The whole sentence derives from
    // `row.authorId` (authenticated) against the anchor's owner (constant);
    // the payload contributes only the member acted ON.
    const sentence = roomEventSentence({
      envelope,
      out,
      authorId: row.authorId,
      ownerId: room?.ownerId ?? null,
      selfId,
      nameFor,
      isAgentId,
    });
    return (
      <View
        testID={`room-event-${row.msgId}`}
        style={[
          styles.corruptRow,
          {
            borderTopColor: t.color.lineSoft,
            borderBottomColor: t.color.lineSoft,
          },
        ]}
      >
        <Text
          accessible
          accessibilityRole="text"
          accessibilityLabel={sentence ?? ''}
          style={[t.type.compactBody, { color: t.color.inkMuted }]}
        >
          {sentence}
        </Text>
        {deliveryNotice ? (
          // The failure line's EVENT-ROW variant: these
          // rows return before the bubble's notice
          // block, so a failed leg behind an announcement — the hold
          // defect's one visible surface — rendered NOWHERE while
          // renderItem computed the sentence and this branch discarded it.
          // Same testID family and danger meta type as the bubble variant;
          // compact, under the sentence, quiet like the row it annotates.
          <Text
            testID={`fanout-notice-${row.msgId}`}
            style={[
              t.type.timeStatus,
              styles.eventNotice,
              { color: t.color.danger },
            ]}
          >
            {deliveryNotice}
          </Text>
        ) : null}
        {/* Removable like every other persistent row. Local only: clearing
            the announcement never touches the roster, which lives in the
            slot store. */}
        <Pressable
          onPress={() => onRemove(row)}
          accessibilityRole="button"
          accessibilityLabel="Remove this notice"
          testID={`remove-${row.msgId}`}
          style={({ pressed }) => [
            styles.textAction,
            styles.corruptAction,
            { borderRadius: t.radius.button },
            pressed && { backgroundColor: t.color.paperInset },
          ]}
        >
          <Text style={[t.type.compactStrong, { color: t.color.inkMuted }]}>
            Remove
          </Text>
        </Pressable>
      </View>
    );
  }

  if (!out && row.outsider) {
    // A message from someone the roster said was OUT at arrival: visibly tagged, attributed, full width — never
    // mistakable for a member's bubble, and never silently dropped, because
    // removal is not simultaneous and silent omission is itself the
    // tell the design exists to prevent. The mark was made by the RECEIVE PATH at
    // arrival and is read off the row; this view derives no membership of
    // its own. Slate, not red: this can be honest words from someone who
    // does not yet know — a sender you never want to hear again is what
    // block is for.
    const subject = row.authorId ? nameFor(row.authorId) : 'Someone';
    // An outsider can still summon: the injected resolver renders their
    // mention with THIS phone's names too, never as bare marks — the tag
    // already carries the doubt.
    const words =
      displayText(row.body, id => (id === selfId ? 'you' : nameFor(id))) ||
      previewFor(row.body);
    return (
      <View
        testID={`outsider-${row.msgId}`}
        accessible
        accessibilityRole="text"
        // The AI attribution rides BEFORE the words here exactly as it does
        // on a bubble: a disclosure spoken after the content came too
        // late, and an outsider row is the one place both marks are true at
        // once — say both, doubt first.
        accessibilityLabel={`${COPY.outsiderTag(subject)}${
          aiSender ? ` From ${AGENT_COPY.spokenClause}.` : ''
        } They said: ${words}`}
        style={[
          styles.outsiderRow,
          {
            backgroundColor: t.color.paperLayer,
            borderLeftColor: t.color.warningMark,
          },
        ]}
      >
        <Text
          testID={`outsider-tag-${row.msgId}`}
          style={[t.type.utilityLabel, { color: t.color.warningInk }]}
        >
          {COPY.outsiderTag(subject)}
        </Text>
        {aiSender ? (
          // The same badge every marked row wears (marker-OR-record — the
          // derivation above): leaving the fold's verdict on and the AI
          // disclosure off was a disclosure that lapsed exactly when doubt
          // was highest. Visual-only, like the author-line badge: the row's
          // own label above carries the spoken attribution.
          <AgentBadge label={AGENT_COPY.badge} testID={`ai-badge-${row.msgId}`} />
        ) : null}
        <Text
          style={[t.type.message, styles.outsiderText, { color: t.color.inkBody }]}
        >
          {words}
        </Text>
      </View>
    );
  }

  if (envelope?.tcm === 'shot') {
    // The corrupt row's full-width ruled geometry, without the danger: a
    // notice is information, not an accusation. No rail — but Remove, like
    // every other persistent row. Checked BEFORE the error branch: a notice
    // whose wire send never receipted is still true ('You took a
    // screenshot.'), and must never render its envelope JSON in a failed
    // bubble with a retry.
    // Two refs can't hold the subject slot: 'them' (the unnamed fallback,
    // built for mid-sentence) breaks sentence-initial grammar, and a peer
    // self-named 'You' would forge the outgoing sentence. Both become 'They'.
    // In a room the sentence must name WHO, and the
    // subject is the AUTHENTICATED author — row.authorId through nameFor,
    // the same discipline as every bubble label and room event, with the
    // same guard (nameFor degrades a self-chosen "You"/"them" to the id
    // fragment). Never peerRef — that is the room, not a person — and never
    // a payload field: the shot envelope carries no name, and parseEnvelope
    // already dropped anything smuggled beside its tcm.
    const subject =
      room !== null
        ? row.authorId
          ? nameFor(row.authorId)
          : 'Someone'
        : /^(you|them)$/i.test(peerRef)
          ? 'They'
          : peerRef;
    const sentence = out ? COPY.shotOut : COPY.shotIn(subject);
    return (
      <View
        testID={`shot-${row.msgId}`}
        style={[
          styles.corruptRow,
          {
            borderTopColor: t.color.lineSoft,
            borderBottomColor: t.color.lineSoft,
          },
        ]}
      >
        <Text
          accessible
          accessibilityRole="text"
          accessibilityLabel={sentence}
          style={[t.type.compactBody, { color: t.color.inkMuted }]}
        >
          {sentence}
        </Text>
        <Pressable
          onPress={() => onRemove(row)}
          accessibilityRole="button"
          accessibilityLabel="Remove this notice"
          testID={`remove-${row.msgId}`}
          style={({ pressed }) => [
            styles.textAction,
            styles.corruptAction,
            { borderRadius: t.radius.button },
            pressed && { backgroundColor: t.color.paperInset },
          ]}
        >
          <Text style={[t.type.compactStrong, { color: t.color.inkMuted }]}>
            Remove
          </Text>
        </Pressable>
      </View>
    );
  }

  if (envelope?.tcm === 'timer') {
    // The screenshot notice's geometry, for the same reason: a change to the
    // room's rules is an event in the room, not speech by either person.
    //
    // BEFORE the error branch, and that placement is the whole bug fix. An
    // outbound timer row that never receipted still has status 'error', and
    // the failed-bubble path below prints `previewFor(row.body) || row.body` —
    // which, before previewFor learned about timers, was literally the
    // envelope JSON in a bubble with a Try again button next to it. The local
    // setting applied at compose time regardless of what the wire did, so the
    // sentence is true on this phone either way.
    // RESIDUAL, deliberate and shared with the peer-profile status line: a
    // frame that never arrived leaves the two phones disagreeing about the
    // timer while this row says otherwise. The outbox retries hard before it
    // gives up, and softening the sentence here would not fix the divergence —
    // reconciling the setting itself is a separate change.
    //
    // Same subject-slot guard the shot and tombstone rows use: 'them' is
    // personRef's mid-sentence fallback and reads wrong sentence-initially,
    // and a peer who names themself 'You' would otherwise forge my own voice.
    const subject = /^(you|them)$/i.test(peerRef) ? 'They' : peerRef;
    // disappearLabel is the same function the peer profile's chips and status
    // line use, so the thread can never name a duration the settings screen
    // spells differently. It returns null for 0 — that is the OFF sentence.
    const label = disappearLabel(envelope.s);
    const sentence =
      label === null
        ? out
          ? COPY.timerOffOut
          : COPY.timerOffIn(subject)
        : out
          ? COPY.timerOut(label)
          : COPY.timerIn(subject, label);
    return (
      <View
        testID={`timer-${row.msgId}`}
        style={[
          styles.corruptRow,
          {
            borderTopColor: t.color.lineSoft,
            borderBottomColor: t.color.lineSoft,
          },
        ]}
      >
        <Text
          accessible
          accessibilityRole="text"
          accessibilityLabel={sentence}
          style={[t.type.compactBody, { color: t.color.inkMuted }]}
        >
          {sentence}
        </Text>
        {/* Removable like every other persistent row. Local only: clearing the
            notice never touches the setting, which lives on the chat row. */}
        <Pressable
          onPress={() => onRemove(row)}
          accessibilityRole="button"
          accessibilityLabel="Remove this notice"
          testID={`remove-${row.msgId}`}
          style={({ pressed }) => [
            styles.textAction,
            styles.corruptAction,
            { borderRadius: t.radius.button },
            pressed && { backgroundColor: t.color.paperInset },
          ]}
        >
          <Text style={[t.type.compactStrong, { color: t.color.inkMuted }]}>
            Remove
          </Text>
        </Pressable>
      </View>
    );
  }

  if (envelope?.tcm === 'vault') {
    // The timer notice's geometry, for the same reason: a change to what the
    // Room keeps is an event in the room, not speech by either person.
    //
    // THE ONE THING THIS BRANCH MUST NEVER DO is read `envelope.body`. The
    // message row's body is the whole envelope, credential included — that is
    // how the state reaches the other phone — and this row is the only place
    // that body meets a renderer. Only the title is drawn. (`displayText`
    // returns '' for it, so the clipboard and the VoiceOver bubble label are
    // already safe; `previewFor` words it without even the title, because the
    // chat list and a notification sit outside the Room.)
    //
    // BEFORE the error branch, exactly like shot and timer, and for the reason
    // the timer's comment records: the failed-bubble path below prints
    // `previewFor(row.body) || row.body`, so a notice whose send never
    // receipted would otherwise put the envelope — SECRET AND ALL — on screen
    // next to a Try again button, and the retry path would hand that same
    // string to sendText as ordinary words.
    //
    // Same subject-slot guard the shot, timer and tombstone rows use: 'them' is
    // personRef's mid-sentence fallback and reads wrong sentence-initially, and
    // a peer who names themself 'You' would otherwise forge my own voice.
    const subject = /^(you|them)$/i.test(peerRef) ? 'They' : peerRef;
    const sentence =
      envelope.op === 'del'
        ? out
          ? COPY.vaultDelOut
          : COPY.vaultDelIn(subject)
        : out
          ? COPY.vaultSetOut(envelope.title ?? '')
          : COPY.vaultSetIn(subject, envelope.title ?? '');
    return (
      <View
        testID={`vault-${row.msgId}`}
        style={[
          styles.corruptRow,
          {
            borderTopColor: t.color.lineSoft,
            borderBottomColor: t.color.lineSoft,
          },
        ]}
      >
        <Text
          accessible
          accessibilityRole="text"
          accessibilityLabel={sentence}
          style={[t.type.compactBody, { color: t.color.inkMuted }]}
        >
          {sentence}
        </Text>
        {/* Removable like every other persistent row. Local only: clearing the
            notice never touches the item, which lives in vault_items. */}
        <Pressable
          onPress={() => onRemove(row)}
          accessibilityRole="button"
          accessibilityLabel="Remove this notice"
          testID={`remove-${row.msgId}`}
          style={({ pressed }) => [
            styles.textAction,
            styles.corruptAction,
            { borderRadius: t.radius.button },
            pressed && { backgroundColor: t.color.paperInset },
          ]}
        >
          <Text style={[t.type.compactStrong, { color: t.color.inkMuted }]}>
            Remove
          </Text>
        </Pressable>
      </View>
    );
  }

  if (row.status === 'error') {
    // Two different failures share this status: an inbound message that would
    // not decrypt (never render its payload) and an outbound one that could
    // not be delivered. They are not the same event, so they don't share copy.
    if (out) {
      // A photo is re-sent from its plain bytes in the attachments row — the
      // ciphertext and its upload died with the outbox row, so retry runs the
      // whole pipeline again. No bytes (removed with the message, or never
      // stored), no control: a Try again that cannot work teaches a person
      // not to trust the button.
      const retryable =
        envelope?.tcm !== 'image' || attachment?.state === 'ready';
      return (
        <View testID={`error-${row.msgId}`} style={styles.failedOut}>
          {/* Normal bubble geometry with the words still visible, but on paper
              behind a danger outline: a failed message must not look
              delivered, so it never takes the pine fill. */}
          <View
            style={[
              styles.bubble,
              styles.failedBubble,
              {
                maxWidth: Math.min(
                  t.layout.bubbleMaxWidth,
                  viewportWidth * t.layout.bubbleMaxRatio,
                ),
                minWidth: t.layout.bubbleMinWidth,
                paddingHorizontal: 12,
                paddingVertical: 9,
                borderRadius: t.radius.bubble,
                borderBottomRightRadius: t.radius.tail,
                backgroundColor: t.color.paperSheet,
                borderColor: t.color.danger,
              },
            ]}
          >
            <Text
              style={[
                t.type.message,
                styles.messageText,
                { color: t.color.inkStrong },
              ]}
            >
              {/* A failed mention shows its words with the names THIS phone
                  holds resolved in place — never previewFor's direction-free
                  line, and never raw marks. */}
              {envelope?.tcm === 'mention'
                ? renderMentionText(envelope.text, envelope.who, id =>
                    id === selfId ? 'you' : nameFor(id),
                  )
                : previewFor(row.body) || row.body}
            </Text>
          </View>
          <Text
            style={[
              t.type.timeStatus,
              styles.metaRight,
              { color: t.color.danger },
            ]}
          >
            {COPY.outgoingFailed}
          </Text>
          <View style={styles.failedActions}>
            {interactionsOff || !retryable ? null : (
              <Pressable
                onPress={() => onRetrySend(row)}
                accessibilityRole="button"
                testID={`retry-${row.msgId}`}
                style={({ pressed }) => [
                  styles.textAction,
                  { borderRadius: t.radius.button },
                  pressed && { backgroundColor: t.color.pineWash },
                ]}
              >
                <Text style={[t.type.compactStrong, { color: t.color.pine }]}>
                  Try again
                </Text>
              </Pressable>
            )}
            <Pressable
              onPress={() => onRemove(row)}
              accessibilityRole="button"
              accessibilityLabel="Remove this message"
              testID={`remove-${row.msgId}`}
              style={({ pressed }) => [
                styles.textAction,
                { borderRadius: t.radius.button },
                pressed && { backgroundColor: t.color.dangerWash },
              ]}
            >
              <Text style={[t.type.compactStrong, { color: t.color.danger }]}>
                Remove
              </Text>
            </Pressable>
          </View>
        </View>
      );
    }
    return (
      <View
        testID={`error-${row.msgId}`}
        style={[
          styles.corruptRow,
          { borderTopColor: t.color.danger, borderBottomColor: t.color.danger },
        ]}
      >
        <Text style={[t.type.compactBody, { color: t.color.danger }]}>
          {COPY.corrupt(peerRef)}
        </Text>
        {/* The `seen` row deliberately survives the delete, so a redelivery of
            the same poison frame cannot bring this back. */}
        <Pressable
          onPress={() => onRemove(row)}
          accessibilityRole="button"
          accessibilityLabel="Remove this message"
          testID={`remove-${row.msgId}`}
          style={({ pressed }) => [
            styles.textAction,
            styles.corruptAction,
            { borderRadius: t.radius.button },
            pressed && { backgroundColor: t.color.dangerWash },
          ]}
        >
          <Text style={[t.type.compactStrong, { color: t.color.danger }]}>
            Remove
          </Text>
        </Pressable>
      </View>
    );
  }

  const isPhoto = envelope?.tcm === 'image';
  // A row whose content is a THING, not words: nothing to rewrite, nothing
  // to copy. Editing one used to replace the whole structured envelope with
  // typed text on both phones — leaving the file's attachment row behind,
  // pointing at nothing.
  const isStructured =
    envelope?.tcm === 'image' ||
    envelope?.tcm === 'file' ||
    envelope?.tcm === 'loc' ||
    envelope?.tcm === 'voice';
  const bubbleMax = Math.min(
    t.layout.bubbleMaxWidth,
    viewportWidth * t.layout.bubbleMaxRatio,
  );

  // Corner logic: the corner nearest this bubble's own screen edge tightens
  // where the group continues, so a run reads as one block of speech.
  const near = item.firstInGroup ? t.radius.bubble : t.radius.tail;
  const corners = out
    ? {
        borderTopLeftRadius: t.radius.bubble,
        borderBottomLeftRadius: t.radius.bubble,
        borderTopRightRadius: near,
        borderBottomRightRadius: t.radius.tail,
      }
    : {
        borderTopRightRadius: t.radius.bubble,
        borderBottomRightRadius: t.radius.bubble,
        borderTopLeftRadius: near,
        borderBottomLeftRadius: t.radius.tail,
      };
  // The photo mat is 3pt of padding plus a 1pt border, so the inner radius has
  // to follow the bubble's own varying corners or the mat looks thicker on the
  // tail corner than on the other three.
  const inset = (v: number) => Math.max(2, v - 4);
  const inner = {
    borderTopLeftRadius: inset(corners.borderTopLeftRadius),
    borderTopRightRadius: inset(corners.borderTopRightRadius),
    borderBottomLeftRadius: inset(corners.borderBottomLeftRadius),
    borderBottomRightRadius: inset(corners.borderBottomRightRadius),
  };

  const clock = clockLabel(row.ts);
  // In a room the speaker is the AUTHENTICATED author, never the room's own
  // ref and never anything a payload could carry.
  // (`inRoom` and `aiSender` are derived at the TOP of this component, above
  // the early returns — the outsider row needs them too.)
  const speaker =
    inRoom && row.authorId ? nameFor(row.authorId) : peerRef;
  /**
   * @-mentions (the mentions contract). The wire carries IDS; every
   * phone renders its OWN name for each — `@you` when the id is mine,
   * because being addressed is the entire point and it must be unmissable.
   * `nameFor` resolves the rest exactly as author labels do, so an id this
   * phone has no name for degrades to the same short fragment every other
   * surface shows — never the raw 26-character ULID, and never a name a
   * payload could smuggle.
   */
  const mentionEnvelope = envelope?.tcm === 'mention' ? envelope : null;
  const mentionLabelFor = (id: string): string =>
    id === selfId ? 'you' : nameFor(id);
  /** The message's words as VoiceOver and the clipboard should get them —
   * names resolved in place, exactly as drawn (displayText carries the
   * injected resolver through mention and grp.msg alike). */
  const spokenWords = displayText(row.body, mentionLabelFor);
  /** Who was mentioned, spoken OUTRIGHT in the label: a distinction carried
   * only by colour is not a distinction for everyone, and this one is the
   * difference between noticing you were addressed and missing it. */
  const mentionClause = mentionEnvelope
    ? (() => {
        const named: string[] = [];
        for (const segment of mentionSegments(
          mentionEnvelope.text,
          mentionEnvelope.who,
        )) {
          if (segment.kind !== 'mention') continue;
          const label = mentionLabelFor(segment.id);
          if (!named.includes(label)) named.push(label);
        }
        return named.length > 0 ? `, mentions ${namesInSentence(named)}` : '';
      })()
    : '';
  // The AI attribution rides RIGHT AFTER the speaker, before the words — a
  // disclosure spoken after the content has been read out came too late (the
  // sharedTag's own rule).
  const bubbleLabel = `${out ? 'You' : speaker}${
    aiSender ? `, ${AGENT_COPY.spokenClause}` : ''
  }, said: ${spokenWords}${mentionClause}, ${clock}${
    out ? `, ${STATUS_WORD[row.status] ?? ''}` : ''
  }`;
  const photoLabel = `Photo from ${out ? 'you' : speaker}, ${clock}`;
  /** The per-author label over the first bubble of an inbound run. */
  const showAuthor = inRoom && !out && item.firstInGroup && !!row.authorId;

  /**
   * The visible reply shortcut: an arrow beside every inbound CONTENT row,
   * the WhatsApp affordance. It calls the SAME `onReply` the rail's Reply
   * button calls, so the two routes can never diverge in what they compose —
   * the arrow is a faster way to reach the rail's action, not a second one.
   *
   * Inbound only: replying to yourself is the rail's edge case, not a thing
   * to advertise on every send. Withdrawn with everything else when
   * interactions are off — the arrow arms the same composer the rail does,
   * and the rail is withdrawn. And CONTENT only, structurally: tombstones,
   * room events, the outsider row, shot/timer/vault notices and the error
   * rows all returned above this line, so none of them can grow an arrow —
   * those are events in the conversation, not things you answer.
   */
  const replyAffordance = !out && !interactionsOff;
  /**
   * Spoken like the bubble's own label: who, then what. A structured row has
   * no words (`displayText` yields ''), so it borrows `previewFor`'s noun —
   * "Photo", "Voice message", "Document", "Location" — never raw JSON.
   */
  const replyArrowLabel = `Reply to ${speaker}: ${
    spokenWords || previewFor(row.body)
  }`;

  const a11yActions = interactionsOff
    ? undefined
    : [
        // React works in rooms too: sendReaction fans the same carrier to
        // every member, addressed by the row's own the design key.
        { name: 'react', label: 'React' },
        ...(isStructured ? [] : [{ name: 'copy', label: 'Copy' }]),
        { name: 'delete', label: 'Delete for me' },
      ];
  const onA11yAction = (name: string) => {
    if (name === 'react') onLongPress(row, index);
    if (name === 'copy') {
      // spokenWords, not displayText: a copied mention should read as the
      // names this phone shows, never as bare U+FFFC marks.
      Clipboard.setString(spokenWords);
      AccessibilityInfo.announceForAccessibilityWithOptions(
        'Copied to the clipboard.',
        { queue: true },
      );
    }
    // Never deletes directly: the rail opens on its confirm step, because a
    // delete is irreversible and there is no server copy to restore from.
    if (name === 'delete') onLongPress(row, index, 'delete');
  };

  return (
    <View
      style={{
        // The date divider already contributes its own 8pt below itself, so a
        // group opening right under one must not add the 14pt as well.
        marginTop: item.newDay ? 0 : item.firstInGroup ? 14 : 3,
      }}
    >
      {(showAuthor && row.authorId) || aiSender ? (
        // The line above the bubble: the author label (rooms, first of a
        // run), and the AI marker (EVERY agent message, room and 1:1 alike —
        // disclosure is per message, not per run). Both derive from the
        // authenticated sender and nothing else; both are hidden from
        // VoiceOver because the bubble's own label opens with the speaker
        // and, for an agent, the spoken attribution.
        <View style={styles.authorLine}>
          {showAuthor && row.authorId ? (
            // Derived from row.authorId and NOTHING else — buildItems already
            // breaks grouping on author change, so every speaker's first
            // bubble carries their name.
            <Text
              testID={`author-${row.msgId}`}
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
              numberOfLines={1}
              style={[t.type.utilityLabel, styles.authorLabel, { color: t.color.pine }]}
            >
              {nameFor(row.authorId)}
            </Text>
          ) : null}
          {aiSender ? (
            <AgentBadge label={AGENT_COPY.badge} testID={`ai-badge-${row.msgId}`} />
          ) : null}
        </View>
      ) : null}
      {/* Inert for rows without the arrow (no style, so the column passes
          straight through); for inbound content rows it lays the bubble and
          its reply arrow on one line. */}
      <View style={replyAffordance ? styles.replyRow : null}>
      <Pressable
        onPress={railOpen ? () => onLongPress(row, index) : undefined}
        onLongPress={
          interactionsOff ? undefined : () => onLongPress(row, index)
        }
        delayLongPress={t.motion.longPress}
        // A Pressable is one accessibility element on iOS: leaving it
        // accessible over a photo removes the image button and the retry
        // control from the tree entirely.
        accessible={!isStructured}
        accessibilityRole="text"
        accessibilityLabel={isStructured ? undefined : bubbleLabel}
        {...(a11yActions
          ? {
              accessibilityActions: a11yActions,
              onAccessibilityAction: (e: {
                nativeEvent: { actionName: string };
              }) => onA11yAction(e.nativeEvent.actionName),
            }
          : {})}
        testID={`msg-${row.msgId}`}
        style={({ pressed }) => [
          styles.bubble,
          corners,
          // Beside the arrow the bubble must be the one that yields: the
          // arrow is a fixed box, so at Dynamic Type XXL the words reflow
          // to a narrower measure rather than pushing the arrow off-screen.
          replyAffordance && styles.bubbleShrink,
          {
            maxWidth: bubbleMax,
            minWidth: t.layout.bubbleMinWidth,
            alignSelf: out ? 'flex-end' : 'flex-start',
            paddingHorizontal: isPhoto ? 3 : 12,
            paddingVertical: isPhoto ? 3 : 9,
            // A photo is the same object whichever way it travelled: direction
            // is already carried by alignment, corners and the status glyph,
            // so it does not also need a green slab — which was also what made
            // the loading and failed states unreadable.
            backgroundColor: isPhoto
              ? pressed
                ? t.color.paperInset
                : t.color.paperSheet
              : out
                ? pressed
                  ? t.color.bubbleOutPressed
                  : t.color.bubbleOut
                : pressed
                  ? t.color.paperInset
                  : t.color.paperSheet,
            borderColor: isPhoto
              ? out
                ? t.color.pineLine
                : pressed
                  ? t.color.lineStrong
                  : t.color.lineSoft
              : out
                ? pressed
                  ? t.color.bubbleOutLinePressed
                  : t.color.bubbleOutLine
                : pressed
                  ? t.color.lineStrong
                  : t.color.lineSoft,
          },
        ]}
      >
        {isPhoto && envelope?.tcm === 'image' ? (
          <PhotoContent
            theme={t}
            msgId={row.msgId}
            direction={row.direction}
            attachment={attachment}
            // The envelope already carries the true size, so the placeholder
            // is pixel-identical to the photo that replaces it instead of
            // twitching the thread from a 4:3 box to the real height.
            dims={{ w: envelope.w, h: envelope.h }}
            inner={inner}
            viewportWidth={viewportWidth}
            reduceMotion={reduceMotion}
            a11yLabel={photoLabel}
            {...(a11yActions ? { a11yActions, onA11yAction } : {})}
            onLongPress={
              interactionsOff ? undefined : () => onLongPress(row, index)
            }
            longPressDelay={t.motion.longPress}
            onOpen={() => onOpenPhoto(row)}
            onRetry={() => onRetryPhoto(row)}
          />
        ) : envelope?.tcm === 'voice' ? (
          <VoiceContent
            theme={t}
            msgId={row.msgId}
            direction={row.direction}
            seconds={
              trueDurations.get(`${row.msgId}:${row.direction}`) ?? envelope.dur
            }
            attachment={attachment}
            out={out}
            playing={playingVoice === `${row.msgId}:${row.direction}`}
            elapsed={voiceElapsed}
            onToggle={() => onToggleVoice(row)}
            onRetry={() => onRetryPhoto(row)}
          />
        ) : envelope?.tcm === 'file' ? (
          <FileContent
            theme={t}
            msgId={row.msgId}
            direction={row.direction}
            name={envelope.name}
            size={envelope.size}
            attachment={attachment}
            out={out}
            onRetry={() => onRetryPhoto(row)}
          />
        ) : envelope?.tcm === 'loc' ? (
          <LocationContent theme={t} lat={envelope.lat} lng={envelope.lng} out={out} />
        ) : (
          // flexShrink: Yoga defaults to 0 (unlike CSS), so a wrapped message
          // measures at the full bubble width and lays the delivery tick out
          // past the border onto the paper beside it. The bubble itself is a
          // row (the tick sits beside the last line), so a quote and its
          // answer need this column of their own.
          <View style={styles.bubbleBody}>
            {envelope?.tcm === 'reply' ? (
              <View
                testID={`quote-${row.msgId}`}
                style={[
                  styles.quote,
                  {
                    borderRadius: t.radius.tail,
                    backgroundColor: out
                      ? t.color.bubbleOutPressed
                      : t.color.paperInset,
                    borderLeftColor: out ? t.color.onBubbleOut : t.color.pine,
                  },
                ]}
              >
                <Text
                  numberOfLines={2}
                  style={[
                    t.type.compactBody,
                    styles.quoteText,
                    { color: out ? t.color.onBubbleOut : t.color.inkMuted },
                  ]}
                >
                  {/* WITH the resolver, like every sibling surface (the
                      failed bubble, mentionLabelFor itself): a quoted
                      mention must read "@Sis lunch? @you", never the words
                      with the marks silently dropped. */}
                  {quoted
                    ? quoted.deletedAt
                      ? COPY.quoteMissing
                      : previewFor(quoted.body, mentionLabelFor)
                    : COPY.quoteMissing}
                </Text>
              </View>
            ) : null}
            <Text
              style={[
                t.type.message,
                styles.messageText,
                { color: out ? t.color.onBubbleOut : t.color.inkStrong },
              ]}
            >
              {/* THE LAST RENDERER, so it must be the safest one. Every
                  branch above is keyed on `parseEnvelope` SUCCEEDING — shot,
                  timer, vault, photo all test `envelope?.tcm` — so a body that
                  DECLARES structure this build cannot parse matches none of
                  them and lands here. That is not hypothetical: VAULT_BODY_MAX
                  was raised 2048 -> 8192 precisely because real values are that
                  big, so a peer on the older build receiving a 3 KB item, or a
                  hostile peer sending 8193 bytes, produces exactly such a row —
                  and printing `row.body` put the whole envelope, CREDENTIAL
                  INCLUDED, in a bubble. `displayText` is the same function the
                  clipboard (3037/3485) and the VoiceOver label (3022) already
                  go through: raw text passes unchanged, a reply yields its
                  words, and declared-but-unreadable structure yields
                  UNSUPPORTED_TEXT instead of JSON.

                  A MENTION renders its runs instead: each mark becomes
                  `@<the name this phone uses>` — `@you` for me — set apart
                  by weight and (inbound) pine, never by colour alone: the
                  `@` glyph and the spoken label both carry the distinction.
                  Parse-permissive per mentionRuns: a mark with no id draws
                  nothing, an id with no mark is ignored, and no branch of
                  this can ever print a raw ULID. */}
              {mentionEnvelope
                ? mentionSegments(
                    mentionEnvelope.text,
                    mentionEnvelope.who,
                  ).map((segment, i) =>
                    segment.kind === 'text' ? (
                      segment.text
                    ) : (
                      <Text
                        key={`m-${i}`}
                        testID={`mention-${row.msgId}-${i}`}
                        style={[
                          styles.mentionSpan,
                          {
                            color: out ? t.color.onBubbleOut : t.color.pine,
                          },
                          segment.id === selfId && {
                            backgroundColor: out
                              ? t.color.bubbleOutPressed
                              : t.color.pineWash,
                          },
                        ]}
                      >
                        @{mentionLabelFor(segment.id)}
                      </Text>
                    ),
                  )
                : overlay
                  ? // The stream overlay: the reply as of its latest
                    // sealed snapshot, with a live cursor standing where
                    // the next words will land. Memory painted over the
                    // durable row — reverts on fade/close, and the store's
                    // schema already refused any snapshot that could smuggle
                    // structure into this Text. Only while fresh: `overlay`
                    // is derived through the store's expiry, so a bubble is
                    // never frozen mid-sentence longer than the fade.
                    [
                      overlay.text,
                      <Text
                        key="cursor"
                        testID={`stream-cursor-${row.msgId}`}
                        style={{ color: t.color.inkMuted }}
                      >
                        {'▍'}
                      </Text>,
                    ]
                  : displayText(row.body)}
            </Text>
            {row.editedAt ? (
              // Never silent: an edit that leaves no trace is a rewrite of
              // history. Inside the bubble, not on the group's clock line —
              // that line only prints for the last message in a run.
              <Text
                testID={`edited-${row.msgId}`}
                style={[
                  t.type.timeStatus,
                  styles.editedMark,
                  { color: out ? t.color.onBubbleOut : t.color.inkMuted },
                ]}
              >
                {COPY.edited}
              </Text>
            ) : null}
          </View>
        )}

        {out && !isPhoto ? (
          <View
            testID={`status-${row.msgId}-${row.status}`}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={styles.statusGlyph}
          >
            {/* On a pine bubble the accent cannot be pine — it would vanish.
                Read is the BRIGHT ink and the other states are the muted one,
                which is the same "this one is different" the light-bubble
                convention gets from turning blue. */}
            <TickGlyph
              status={row.status as TickStatus}
              color={t.color.onBubbleOut}
              readColor={t.color.onPine}
              size={13}
            />
          </View>
        ) : null}
      </Pressable>
      {replyAffordance ? (
        <Pressable
          onPress={() => onReply(row)}
          accessibilityRole="button"
          accessibilityLabel={replyArrowLabel}
          testID={`reply-arrow-${row.msgId}`}
          // 44×44 effective without enlarging the 32×32 box — the reaction
          // chips' discipline, and the box plus 6 of slop is exactly 44.
          hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
          style={({ pressed }) => [
            styles.replyArrow,
            { borderRadius: t.radius.small },
            pressed && { backgroundColor: t.color.pineWash },
          ]}
        >
          <ReplyGlyph size={17} color={t.color.pine} />
        </Pressable>
      ) : null}
      </View>

      {/* A photo used to be the ONLY message with a status, and it drew one
          with text glyphs (`✓`, `✓✓`). Same drawn tick as everything else
          now — one indicator, one meaning, whatever the message carries. */}
      {out && isPhoto ? (
        <View
          testID={`status-${row.msgId}-${row.status}`}
          accessibilityLabel={STATUS_WORD[row.status] ?? ''}
          style={styles.photoStatus}
        >
          <TickGlyph
            status={row.status as TickStatus}
            color={t.color.inkMuted}
            readColor={t.color.pine}
          />
        </View>
      ) : null}

      {deliveryNotice ? (
        // The room's honest failure line: an aggregate
        // sentence under the bubble, never a red bubble — in a room a red
        // bubble would say "nobody got it" when nine of eleven people did.
        // The 1:1 failed line's own meta styling (timeStatus + metaRight +
        // danger ink), because the two are the same statement at two scales.
        <Text
          testID={`fanout-notice-${row.msgId}`}
          style={[
            t.type.timeStatus,
            styles.metaRight,
            { color: t.color.danger },
          ]}
        >
          {deliveryNotice}
        </Text>
      ) : null}

      {reactions?.length ? (
        <View
          style={[
            styles.reactionRow,
            { alignSelf: out ? 'flex-end' : 'flex-start' },
          ]}
        >
          {reactions.map(r => {
            const word = REACTION_WORD[r.emoji];
            const mine = r.direction === 'out';
            // The reactor is `reactorId` (authenticated) in a room, and the
            // one possible peer in a 1:1 — never the bubble's author.
            const reactor =
              inRoom && r.reactorId ? nameFor(r.reactorId) : peerRef;
            const label = word
              ? mine
                ? `You reacted with ${word}`
                : `${reactor} reacted with ${word}`
              : `Reacted with ${r.emoji}`;
            return (
              <Pressable
                // Two members reacting to one message are two rows sharing a
                // direction — the reactor completes the key.
                key={`${r.direction}:${r.reactorId ?? ''}`}
                // Re-choosing your own reaction retracts it; theirs opens the
                // rail so you can answer it — in a room exactly as in a 1:1,
                // through the same room-aware sendReaction.
                onPress={
                  interactionsOff
                    ? undefined
                    : mine
                      ? () => onReact(row, r.emoji)
                      : () => onLongPress(row, index)
                }
                disabled={interactionsOff}
                accessibilityRole="button"
                accessibilityLabel={label}
                // 44 x 44 effective without enlarging the 26 x 30 visual.
                hitSlop={{ top: 9, bottom: 9, left: 7, right: 7 }}
                style={[
                  styles.reactionChip,
                  {
                    borderRadius: t.radius.small,
                    // Ownership cannot rest on a 1.65:1-vs-1.33:1 border alone.
                    backgroundColor: mine
                      ? t.color.pineWash
                      : t.color.paperSheet,
                    borderColor: mine ? t.color.pineLine : t.color.lineSoft,
                  },
                ]}
              >
                <Text style={t.type.compactBody}>{r.emoji}</Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}

      {railOpen ? (
        <View style={{ alignSelf: out ? 'flex-end' : 'flex-start' }}>
          {/* The same rail in a room as in a 1:1: the
              reaction fans through room-aware sendReaction, addressed by
              this row's own key. */}
          <View
            style={[
              styles.rail,
              {
                width: t.layout.railWidth,
                minHeight: t.layout.railHeight,
                backgroundColor: t.color.paperLayer,
                borderTopColor: t.color.lineSoft,
              },
            ]}
          >
            {REACTIONS.map(choice => {
              const chosen = reactions?.some(
                r => r.direction === 'out' && r.emoji === choice.emoji,
              );
              return (
                <Pressable
                  key={choice.emoji}
                  onPress={() => onReact(row, choice.emoji)}
                  accessibilityRole="button"
                  accessibilityLabel={choice.label}
                  accessibilityState={{ selected: !!chosen }}
                  testID={`react-${choice.emoji}`}
                  style={({ pressed }) => [
                    styles.railChoice,
                    chosen && {
                      backgroundColor: t.color.pineWash,
                      borderBottomWidth: 2,
                      borderBottomColor: t.color.pine,
                    },
                    pressed && { backgroundColor: t.color.pineWash },
                  ]}
                >
                  <Text style={t.type.emojiChoice}>{choice.emoji}</Text>
                </Pressable>
              );
            })}
          </View>
          {/* Attached below the rail, sharing its bottom hairline, so the two
              read as one block rather than two floating slabs. */}
          <MessageActions
            key={railIntent}
            theme={t}
            row={row}
            isStructured={isStructured}
            isMention={mentionEnvelope !== null}
            copyText={spokenWords}
            startConfirm={railIntent === 'delete'}
            onRemove={() => onRemove(row)}
            onRemoveEverywhere={() => onRemoveEverywhere(row)}
            onReply={() => onReply(row)}
            onEdit={() => onEdit(row)}
          />
        </View>
      ) : null}

      {item.showClock ? (
        <Text
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={[
            t.type.timeStatus,
            out ? styles.metaRight : styles.metaLeft,
            { color: t.color.inkMuted },
          ]}
        >
          {clock}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * What you can do to a message besides react to it. Until now the answer was
 * nothing: the body was a bare Text, so an address or a wifi password had to
 * be retyped by hand.
 */
function MessageActions({
  theme: t,
  row,
  isStructured,
  isMention,
  copyText,
  startConfirm,
  onRemove,
  onRemoveEverywhere,
  onReply,
  onEdit,
}: {
  theme: Theme;
  row: db.MessageRow;
  /** Content that is a THING, not words: photo, document, location. */
  isStructured: boolean;
  /** An @-mention row: its words copy fine, but Edit is withheld — an edit
   * carries only text, so rewriting would strip `who` and turn the marks
   * into stray characters on every phone. Mentions-in-an-edit are the same
   * deferred question as mentions-in-a-reply (the contract's out-of-scope
   * note), and until it is answered the control is not offered. */
  isMention: boolean;
  /** What Copy puts on the clipboard — the caller resolves a mention's
   * names in place, so a copied mention never carries bare U+FFFC marks. */
  copyText: string;
  /** Rooms offer the full strip: Reply, Edit and "For
   * everyone" ride the same send functions as a 1:1, which are room-aware
   * underneath — the control cannot take the wrong path because there is
   * only one path. */
  startConfirm: boolean;
  onRemove: () => void;
  onRemoveEverywhere: () => void;
  onReply: () => void;
  onEdit: () => void;
}) {
  const [confirming, setConfirming] = useState(startConfirm);
  const [copied, setCopied] = useState(false);
  /** Only my own message can be rewritten or taken off the other phone. */
  const mine = row.direction === 'out';

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  const word =
    row.direction === 'out' ? (STATUS_WORD[row.status] ?? 'Sent') : 'Received';
  const stamp = sameDay(row.ts, Date.now())
    ? clockLabel(row.ts)
    : new Date(row.ts).toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      });

  return (
    <View
      style={[
        styles.actionStrip,
        {
          width: t.layout.railWidth,
          backgroundColor: t.color.paperLayer,
          borderBottomColor: t.color.lineSoft,
        },
      ]}
    >
      <Text
        numberOfLines={1}
        style={[
          t.type.timeStatus,
          styles.actionDetail,
          { color: copied ? t.color.pine : t.color.inkMuted },
        ]}
      >
        {confirming
          ? mine
            ? 'Delete this message?'
            : 'Delete for me?'
          : copied
            ? 'Copied to the clipboard.'
            : `${word} ${stamp}`}
      </Text>

      {confirming ? (
        <View style={styles.actionButtons}>
          <Pressable
            onPress={onRemove}
            accessibilityRole="button"
            accessibilityLabel="Delete for me"
            testID={`delete-mine-${row.msgId}`}
            hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
          >
            <Text style={[t.type.compactStrong, { color: t.color.danger }]}>
              For me
            </Text>
          </Pressable>
          {/* Only my own words can be taken off their phone. Theirs are
              theirs — this app cannot reach into someone else's history. */}
          {mine ? (
            <Pressable
              onPress={onRemoveEverywhere}
              accessibilityRole="button"
              accessibilityLabel="Delete for everyone"
              testID={`delete-everyone-${row.msgId}`}
              hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
            >
              <Text style={[t.type.compactStrong, { color: t.color.danger }]}>
                For everyone
              </Text>
            </Pressable>
          ) : null}
          <Pressable
            onPress={() => setConfirming(false)}
            accessibilityRole="button"
            testID={`delete-keep-${row.msgId}`}
            hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
          >
            <Text style={[t.type.compactStrong, { color: t.color.pine }]}>
              Keep
            </Text>
          </Pressable>
        </View>
      ) : (
        <View style={styles.actionButtons}>
          <Pressable
            onPress={onReply}
            accessibilityRole="button"
            testID={`reply-${row.msgId}`}
            hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
          >
            <Text style={[t.type.compactStrong, { color: t.color.pine }]}>
              Reply
            </Text>
          </Pressable>
          {isStructured ? null : (
            <Pressable
              onPress={() => {
                Clipboard.setString(copyText);
                setCopied(true);
              }}
              accessibilityRole="button"
              testID={`copy-${row.msgId}`}
              hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
            >
              <Text style={[t.type.compactStrong, { color: t.color.pine }]}>
                Copy
              </Text>
            </Pressable>
          )}
          {/* Rewriting is for my own words, and only words: a photo, a
              document and a location have nothing to rewrite — and an edit
              would replace the whole structured envelope with typed text on
              both phones, orphaning the attachment row behind it. A mention
              is words but withheld too — see the isMention prop. */}
          {mine && !isStructured && !isMention ? (
            <Pressable
              onPress={onEdit}
              accessibilityRole="button"
              testID={`edit-${row.msgId}`}
              hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
            >
              <Text style={[t.type.compactStrong, { color: t.color.pine }]}>
                Edit
              </Text>
            </Pressable>
          ) : null}
          <Pressable
            onPress={() => setConfirming(true)}
            accessibilityRole="button"
            accessibilityLabel="Delete"
            testID={`delete-${row.msgId}`}
            hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
          >
            <Text style={[t.type.compactStrong, { color: t.color.danger }]}>
              Delete
            </Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

interface Corners {
  borderTopLeftRadius: number;
  borderTopRightRadius: number;
  borderBottomLeftRadius: number;
  borderBottomRightRadius: number;
}

function PhotoContent({
  theme: t,
  msgId,
  direction,
  attachment,
  dims,
  inner,
  viewportWidth,
  reduceMotion,
  a11yLabel,
  a11yActions,
  onA11yAction,
  onLongPress,
  longPressDelay,
  onOpen,
  onRetry,
}: {
  theme: Theme;
  msgId: string;
  direction: 'in' | 'out';
  attachment: AttachmentMeta | undefined;
  /** Envelope dimensions, known before the blob lands. */
  dims: { w: number; h: number } | undefined;
  inner: Corners;
  viewportWidth: number;
  reduceMotion: boolean;
  a11yLabel: string;
  a11yActions?: { name: string; label: string }[];
  onA11yAction?: (name: string) => void;
  onLongPress?: (() => void) | undefined;
  longPressDelay: number;
  onOpen: () => void;
  onRetry: () => void;
}) {
  const [data, setData] = useState<string | null>(null);

  // The bytes live here, for as long as this bubble is mounted, instead of in
  // a screen-level Map that is rebuilt in full on every notification.
  useEffect(() => {
    if (attachment?.state !== 'ready') {
      setData(null);
      return;
    }
    let live = true;
    quiet(db.getAttachment(msgId, direction), r => {
      if (live) setData(r?.dataB64 ?? null);
    });
    return () => {
      live = false;
    };
  }, [msgId, direction, attachment?.state]);

  // The same floor on both axes: below it a photo bubble is smaller than a
  // touch target.
  const minEdge = t.layout.photoMinHeight;
  const naturalW = attachment?.w ?? dims?.w ?? 0;
  const naturalH = attachment?.h ?? dims?.h ?? 0;
  // Never upscale: a 96pt sticker or a QR code blown up 2.6x is unreadable.
  const width = Math.max(
    minEdge,
    Math.min(
      t.layout.photoMaxWidth,
      viewportWidth * t.layout.photoRatio,
      naturalW || t.layout.photoMaxWidth,
    ),
  );
  // w/h are peer-controlled positive ints with no upper bound in the schema,
  // so a hostile 1 x 100000 must still land inside the clamp.
  const ratio = naturalW > 0 && naturalH > 0 ? naturalH / naturalW : 3 / 4;
  const height = Math.max(
    minEdge,
    Math.min(t.layout.photoMaxHeight, Math.round(width * ratio)),
  );
  // The top-anchored image is laid out at its natural height, which the ratio
  // above does not bound — a hostile 1 x 100000 asks for a view eleven million
  // points tall. Bounded here: every real portrait and stitched screenshot is
  // far inside this, and past it the crop simply re-centres rather than
  // demanding a layer no device can raster.
  const anchored = Math.min(
    Math.round(width * ratio),
    t.layout.photoMaxHeight * 6,
  );

  if (attachment?.state === 'ready' && data) {
    const source = { uri: `data:image/jpeg;base64,${data}` };
    return (
      <Pressable
        onPress={onOpen}
        {...(onLongPress ? { onLongPress } : {})}
        delayLongPress={longPressDelay}
        accessibilityRole="imagebutton"
        accessibilityLabel={a11yLabel}
        {...(a11yActions && onA11yAction
          ? {
              accessibilityActions: a11yActions,
              onAccessibilityAction: (e: {
                nativeEvent: { actionName: string };
              }) => onA11yAction(e.nativeEvent.actionName),
            }
          : {})}
        style={({ pressed }) => [
          pressed && { backgroundColor: t.color.pineWash },
        ]}
      >
        {anchored > height ? (
          // Top-anchored: `cover` on a clamped tall crop shows the middle band
          // of a screenshot and the chest of a portrait. The frame stays the
          // tap target because the Pressable wraps the clipping View.
          <View style={[{ width, height, overflow: 'hidden' }, inner]}>
            <Image
              source={source}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width,
                height: anchored,
              }}
              resizeMode="cover"
            />
          </View>
        ) : (
          <Image
            source={source}
            style={[{ width, height }, inner]}
            resizeMode="cover"
          />
        )}
      </Pressable>
    );
  }

  if (attachment?.state === 'failed') {
    return (
      <View
        style={[
          styles.photoFallback,
          inner,
          // minHeight: the block is all scaling text plus a 24pt square, so a
          // fixed 120 clips the retry action at large text sizes.
          { width, minHeight: 120, backgroundColor: t.color.dangerWash },
        ]}
      >
        <View
          style={[styles.alertSquare, { borderColor: t.color.danger }]}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          <Text
            allowFontScaling={false}
            style={[t.type.utilityLabel, { color: t.color.danger }]}
          >
            !
          </Text>
        </View>
        <Text
          accessible
          accessibilityLabel="Photo couldn’t load"
          style={[
            t.type.compactBody,
            styles.photoFallbackText,
            { color: t.color.danger },
          ]}
        >
          Photo couldn’t load.
        </Text>
        <Pressable
          onPress={onRetry}
          accessibilityRole="button"
          style={({ pressed }) => [
            styles.photoRetry,
            { borderRadius: t.radius.button },
            pressed && { backgroundColor: t.color.pineWash },
          ]}
        >
          <Text style={[t.type.compactStrong, { color: t.color.pine }]}>
            Try again
          </Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel="Photo, loading"
      style={[
        styles.photoFallback,
        inner,
        { width, height, backgroundColor: t.color.pineWashFaint },
      ]}
    >
      {reduceMotion ? (
        <Text style={[t.type.utilityData, { color: t.color.inkMuted }]}>
          Loading photo…
        </Text>
      ) : (
        <ActivityIndicator size="small" color={t.color.pine} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  peerControl: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    minHeight: 44,
    flex: 1,
  },
  peerText: { flex: 1 },
  safetyControl: {
    width: 60,
    // 48 rather than the 44pt floor: the glyphs grew to 24, and a control
    // sized exactly at the minimum leaves a larger mark crowding its own
    // edges. Still a floor, not a fixed height, so Dynamic Type can push it
    // taller without clipping.
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
  safetyPanel: { paddingVertical: 14, borderBottomWidth: 1 },
  safetyTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  safetyClose: {
    minWidth: 44,
    minHeight: 44,
    alignItems: 'flex-end',
    justifyContent: 'center',
  },
  safetyStatusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 10,
  },
  safetyStatusRule: {
    width: 3,
    alignSelf: 'stretch',
    minHeight: 15,
    marginRight: 12,
  },
  safetyGrid: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 8 },
  // A third of the row at default size; the group text is free to wrap
  // within it rather than being shrunk to fit.
  safetyCell: { width: '33.333%' },
  safetyHint: { marginTop: 8 },
  safetyActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 16,
  },
  textAction: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: 8,
    marginHorizontal: -8,
  },
  listContent: { paddingHorizontal: 16, paddingBottom: 20 },
  emptyThread: { alignItems: 'center', marginTop: 20, marginBottom: 24 },
  emptyTitle: { marginTop: 20, textAlign: 'center' },
  emptyBody: { marginTop: 8, textAlign: 'center', maxWidth: 280 },
  bubble: {
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'center',
    gap: 6,
  },
  messageText: { flexShrink: 1 },
  /** An inbound content row: the bubble and its reply arrow on one line.
   * `alignItems: 'flex-end'` seats the arrow by the bubble's tail corner,
   * where the eye already reads "this message ends here". */
  replyRow: { flexDirection: 'row', alignItems: 'flex-end' },
  /** The bubble yields, the arrow never does: Yoga's flexShrink defaults to
   * 0, so without this a maximal bubble would push the fixed arrow box
   * toward the edge instead of letting its own text reflow. */
  bubbleShrink: { flexShrink: 1 },
  replyArrow: {
    width: 32,
    height: 32,
    marginLeft: 6,
    marginBottom: 1,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  /** The bubble is a row so the delivery tick sits beside the last line; a
   * quote, its answer and the edited mark stack inside this column. */
  bubbleBody: { flexShrink: 1 },
  quote: {
    borderLeftWidth: 2,
    paddingHorizontal: 8,
    paddingVertical: 5,
    marginBottom: 5,
  },
  /** Secondary text on a pine fill: onPine dimmed, so the palette owns the
   * colour and this owns only the emphasis. */
  quoteText: { opacity: 0.75 },
  editedMark: { marginTop: 2, opacity: 0.75 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: 0,
    paddingLeft: 0,
    paddingRight: 4,
    paddingVertical: 8,
    overflow: 'hidden',
  },
  chipBar: { width: 3, alignSelf: 'stretch', marginRight: 10 },
  chipBody: { flex: 1, flexShrink: 1 },
  chipText: { marginTop: 1 },
  chipCancel: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tombstone: {
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  tombstoneText: { flexShrink: 1, fontStyle: 'italic' },
  failedOut: { marginTop: 14 },
  failedBubble: { alignSelf: 'flex-end' },
  failedActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: 16,
  },
  statusGlyph: { marginBottom: 1 },
  photoStatus: { alignSelf: 'flex-end', marginTop: 3, marginRight: 4 },
  metaLeft: { alignSelf: 'flex-start', marginTop: 3, marginLeft: 4 },
  metaRight: { alignSelf: 'flex-end', marginTop: 3, marginRight: 4 },
  photoFallback: { alignItems: 'center', justifyContent: 'center' },
  photoFallbackText: { marginTop: 8 },
  photoRetry: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  reactionRow: { flexDirection: 'row', gap: 4, marginTop: 6 },
  reactionChip: {
    minHeight: 26,
    minWidth: 30,
    borderWidth: 1,
    paddingHorizontal: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rail: {
    marginTop: 6,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  railChoice: {
    width: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionStrip: {
    minHeight: 40,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  actionDetail: { flexShrink: 1, marginRight: 8 },
  actionButtons: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 16,
  },
  corruptRow: {
    marginVertical: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
  },
  corruptAction: { alignSelf: 'flex-end' },
  /** The event-row delivery notice: a breath under the event
   * sentence, centered with it by the corruptRow container. */
  eventNotice: { marginTop: 3 },
  /** The provenance line above a relayed row. Indented to the bubble it
   * annotates, so it reads as belonging to that message and not as a
   * standalone system notice. */
  sharedTag: { marginTop: 8, marginBottom: 2, marginHorizontal: 16 },
  /** An outsider's message: full width with a slate
   * accent bar — deliberately NOT the bubble shape, so it cannot be read as
   * a member speaking even with the tag line cropped. */
  outsiderRow: {
    marginVertical: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderLeftWidth: 3,
    alignSelf: 'stretch',
  },
  outsiderText: { marginTop: 4 },
  /** The authenticated author over an inbound run's first bubble. */
  /** The line above a bubble: author label and/or the AI marker. A row so
   * the badge sits beside the name when both render; flex-start so an
   * unlabelled agent bubble's lone badge hugs the bubble's edge. */
  authorLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    alignSelf: 'flex-start',
    marginBottom: 2,
  },
  authorLabel: { marginLeft: 4, flexShrink: 1 },
  mismatchRow: {
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    alignItems: 'flex-start',
  },
  jumpRow: {
    minHeight: 40,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  errorActions: {
    borderLeftWidth: 2,
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: 16,
  },
  progressRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 8,
  },
  offlineRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  offlineMark: { width: 6, height: 6 },
  offlineText: { flex: 1 },
  banner: {
    borderTopWidth: 2,
    borderLeftWidth: 3,
    paddingVertical: 12,
  },
  bannerTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  bannerTitle: { flex: 1 },
  bannerBody: { marginTop: 6 },
  bannerActions: { flexDirection: 'row', gap: 12, marginTop: 10 },
  bannerButton: {
    minHeight: 44,
    borderWidth: 1,
    paddingHorizontal: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  alertSquare: {
    width: 24,
    height: 24,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  composerWrap: {
    paddingTop: 8,
    paddingHorizontal: 12,
    paddingBottom: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  counter: { textAlign: 'right', marginBottom: 4, marginRight: 4 },
  drawer: {
    borderWidth: 1,
    borderBottomWidth: 0,
    overflow: 'hidden',
    paddingTop: 14,
    paddingBottom: 10,
  },
  drawerSeam: { width: StyleSheet.hairlineWidth, height: '100%' },
  drawerGrid: { flexDirection: 'row', paddingHorizontal: 8 },
  drawerAction: { flex: 1, alignItems: 'center', paddingVertical: 2, gap: 6 },
  drawerDisc: {
    width: 46,
    height: 46,
    borderRadius: 23,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  drawerLabel: { textAlign: 'center' },
  drawerFootnote: { textAlign: 'center', marginTop: 10, paddingHorizontal: 16 },
  voiceBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 10,
    paddingBottom: 6,
  },
  voiceLevelTrack: { flex: 1, height: 4, borderRadius: 2, overflow: 'hidden' },
  voiceTrack: { height: 3, borderRadius: 2, overflow: 'hidden' },
  voiceTrackFill: { height: 3, borderRadius: 2 },
  voiceMetaRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: 8,
  },
  voiceLevelFill: { height: 4, borderRadius: 2 },
  emojiRow: { paddingHorizontal: 8, alignItems: 'center' },
  emojiChoice: {
    width: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  /** The member picker: list padding replaces the drawer's grid padding. */
  mentionDrawer: { paddingTop: 6, paddingBottom: 4 },
  /** One person: a circle and a name. minHeight (never height) so scaled
   * text grows the row — the no-clipping rule the room header tests pin. */
  mentionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 4,
  },
  mentionName: { flexShrink: 1 },
  mentionChipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    paddingHorizontal: 4,
    paddingBottom: 6,
  },
  mentionChip: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    paddingLeft: 10,
    minHeight: 32,
  },
  mentionChipCancel: {
    minWidth: 32,
    minHeight: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  /** A mention in a bubble: weight beside the '@' glyph — the ink is the
   * theme's, applied inline, and never the only signal. */
  mentionSpan: { fontWeight: '600' },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    borderWidth: 1,
    minHeight: 52,
    paddingHorizontal: 4,
  },
  composerIcon: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  composerInput: {
    flex: 1,
    minHeight: 44,
    maxHeight: 110,
    paddingVertical: 11,
  },
  sendDisc: {
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
