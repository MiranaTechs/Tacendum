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
  BackHandler,
  Clipboard,
  findNodeHandle,
  FlatList,
  Image,
  Keyboard,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  useWindowDimensions,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ViewToken,
} from 'react-native';
import { BLOCK_COPY as BLOCK, disappearLabel } from '../blocking';
import { AI_WRITING_INPUT_MAX, type AiWritingAction, type AiWritingResult } from '../aiWriting';
import { generateWriting, getWritingRevision } from '../aiWritingService';
import { maskWritingMentions, sameWritingDraft, type WritingDraftSnapshot } from '../aiWritingDraft';
import { WritingAssistant } from '../ui/WritingAssistant';
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
import { clearMissedCallNotices, useCallState } from '../call';
import * as db from '../db';
import { DEVICE_NOUN } from '../deviceNoun';
import {
  clearFocusedConversation,
  setFocusedConversation,
} from '../messageSound';
import {
  VOICE_MAX_SECONDS,
  // THE detail reader , envelope.ts's own: the round pass
  // and the disclosure both ask IT what a body's full answer is, and this
  // screen never re-parses rendered text for one.
  detailText,
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
  pickImage,
  type PickedImage,
  type PickSource,
} from '../media';
import { useKeyboardInset } from '../keyboardInset';
import { linkRuns } from '../linkRuns';
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
import { InfoDisclosure } from '../ui/InfoDisclosure';
// `tickLabel` is deliberately NOT imported: this screen announces delivery
// state through STATUS_WORD, which is folded into the whole bubble's
// accessibility label, and the glyph itself is hidden from VoiceOver so the
// state is not read out twice. Two mappings for one fact is one too many.
import { ReplyGlyph } from '../ui/ReplyGlyph';
import { TickGlyph } from '../ui/TickGlyph';
import {
  InlineError,
  InlineNotice,
  RuledLabel,
  ScreenHeader,
  TextAction,
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
import {
  APPROVAL_KIND_COPY,
  ApprovalCard,
  approvalDeadline,
} from '../ui/ApprovalCard';
import { AgentBadge } from '../ui/AgentBadge';
import { tileName } from '../ui/CallTile';
import { DetailDisclosure } from '../ui/DetailDisclosure';
import {
  ReactionDetails,
} from '../ui/ReactionDetails';
import { AGENT_COPY } from '../machine';
import {
  buildSecondOpinionDraft,
  eligibleSecondOpinionTargetIds,
  selectedSecondOpinionTargetsAreCurrent,
  type SecondOpinionAgentFact,
} from '../secondOpinion';
// ROUNDS : the join is a PURE function over the built list
// plus a resolver, so the whole priority order is testable without a screen.
import {
  ROUND_COPY,
  roomAnchorKey,
  roundHeaderTestID,
  rowKey,
} from '../rounds';
// The thread's own modules : the stylesheet
// and the pure algebra this screen reads but no longer holds. The direction
// is one-way — styles ← constants ← format ← items — and nothing under
// `../thread/` imports back from this screen.
import {
  ATTACH_ABOUT,
  BOTTOM_SLACK,
  COPIED_MS,
  COUNTER_DANGER,
  COUNTER_WARN,
  DRAFT_SAVE_MS,
  MENTION_PICKER_MAX_HEIGHT,
  PLACEHOLDER_NAME_MAX,
  QUICK_EMOJI,
  QUOTE_FLASH_MS,
  RAIL_DISMISS_SCROLL,
  REACTION_WORD,
  REACTIONS,
  REFRESH_DEBOUNCE_MS,
  STATUS_WORD,
} from '../thread/constants';
import {
  type Drawer,
  type Pending,
  type RailIntent,
} from '../thread/types';
import {
  aiSenderOf,
  approvalPlaceholderRow,
  buildItems,
  callPlaceholderRow,
  threadKey,
  type ThreadItem,
  type UnreadWindow,
} from '../thread/items';
import {
  clockDuration,
  formatBytes,
  isEmojiOnly,
  laterArrival,
  newestInboundOf,
  quiet,
  safeFileName,
  tickStatusOf,
  type InboundMark,
} from '../thread/format';
import { sendErrorFor, type SendError } from '../thread/errors';
import {
  caretAfterEdit,
  encodeMentionDraft,
  liveMentionChips,
  mentionQueryAt,
  mentionWire,
  namesInSentence,
  restoreMentionDraft,
  shiftMentionChips,
  type MentionChip,
} from '../thread/mentions';
import { roomEventSentence } from '../thread/roomEvents';
import { groupReactions } from '../thread/reactions';
import { stylesFor } from '../thread/styles';
import { FindBar, FindGlyph } from '../thread/FindBar';
import {
  FIND_DEBOUNCE_MS,
  FIND_LIMIT,
  findQueryReady,
  refineFindRows,
  stepFindCursor,
} from '../thread/find';
import {
  discardReview,
  discardUnlessSending,
  NO_PHOTO_REVIEW,
  offersRetake,
  PHOTO_REVIEW_MAX_HEIGHT,
  photoAspect,
  photoKilobytes,
  reviewPicked,
  reviewSending,
  type PhotoReview,
} from '../thread/photoReview';

// The room-event sentence now lives in `../thread/roomEvents`. It is
// re-exported under its own name here because ChatThread.agentbadge.test.tsx
// imports it from this screen, and the whole split is held to zero test
// edits .
export { roomEventSentence };

/** Quote context never carries request bytes or work metadata into a memo. */
type ApprovalQuote = Pick<db.ApprovalRow, 'peerId' | 'q' | 'kind'>;

interface Props {
  peerId: string;
  /** A route from the attention inbox lands on this exact durable request. */
  focusedApprovalQ?: string;
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

/** People-facing copy. A raw exception must never reach the screen. */
const COPY = {
  /** The composer's "+" opens photos, the camera, documents and location —
   * it is not a photo button. */
  attach: 'Attach',
  attachHint: 'Photos, camera, a file, or your location',
  /** The unread divider. */
  newMessages: (n: number) => `${n} new ${n === 1 ? 'message' : 'messages'}`,
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
  secondOpinionUnavailable:
    'The selected agent is no longer available for this room. Review the room’s agent access before sending.',
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
  /**
   * Picking a photo opens a review panel; sending requires a separate
   * confirmation. Show the encoded size because the picker re-encodes the
   * source and this is the size that will actually be sent.
   */
  photoReview: 'Send this photo?',
  photoSend: 'Send',
  photoDiscard: 'Discard',
  photoRetake: 'Take another',
  photoSize: (kb: number) => `About ${kb} KB`,
  /** What VoiceOver reads for the panel's largest element. */
  photoReviewImage: 'The photo you picked',
  /**
   * FIND, NEVER SEARCH . The chat list's field says *Filter*
   * because it makes no lookup; this makes none either — it reads rows
   * already on this device — and the ⓘ says exactly that, because the
   * no-directory story is worth more than the familiar verb. "No message
   * *here*" is the honest scope. No device noun in any of these.
   */
  find: 'Find in this conversation',
  findPlaceholder: 'Find a message',
  findClose: 'Close find',
  findNext: 'Next match',
  findPrevious: 'Previous match',
  findCount: (i: number, n: number) => `${i} of ${n}`,
  findNone: 'No message here matches that.',
  findTooShort: 'Type two or more letters.',
  findAboutLabel: 'What this looks at',
  findAbout: [
    'Only the messages already here.',
    'Nothing is sent anywhere to find them.',
  ],
};

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
  const styles = stylesFor(t);
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

/**
 * A message's words with every declared web address made tappable.
 * Plain words come back as the string itself, so a bubble without an
 * address renders exactly as before; an address becomes a nested link —
 * underlined AND coloured, never colour alone — that opens through
 * Linking when tapped. Nothing is fetched or previewed: the address
 * leaves this phone only on that tap. */
function linkedText(
  text: string,
  linkColor: string,
  keyPrefix: string,
  theme: Theme,
): React.ReactNode {
  const runs = linkRuns(text);
  if (!runs.some(run => run.kind === 'link')) return text;
  const styles = stylesFor(theme);
  return runs.map((run, i) =>
    run.kind === 'text' ? (
      run.text
    ) : (
      <Text
        key={`${keyPrefix}-${i}`}
        accessibilityRole="link"
        onPress={() => {
          // A scheme this device cannot open rejects; that is not an error
          // the person can act on from a bubble.
          void Linking.openURL(run.url).catch(() => undefined);
        }}
        style={[styles.linkSpan, { color: linkColor }]}
      >
        {run.text}
      </Text>
    ),
  );
}

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

/** Facts that can enable a second-opinion target. This deliberately starts
 * from current structured AI state; machine_peers contributes ownership and
 * room attribution only after that intersection, because it is historical. */
async function secondOpinionFactsForFold(
  fold: ReturnType<typeof foldRoster>,
  selfId: string,
  machines: ReadonlySet<string>,
  markers: ReadonlySet<string>,
  knownConsents?: ReadonlyMap<string, db.AgentConsentState>,
): Promise<SecondOpinionAgentFact[]> {
  // The ordinary room send path is read-only when ANY folded member is
  // blocked or has an unaccepted identity change. Do not invite a review the
  // same path is guaranteed to refuse.
  if (
    fold.members.some(
      id =>
        id !== selfId &&
        (messaging.isPeerBlocked(id) || messaging.isBlockedLocally(id)),
    )
  ) {
    return [];
  }
  const current = new Map(
    (await db.listAiAgentStates(Date.now())).map(state => [state.peerId, state]),
  );
  const possible = fold.members.filter(id => id !== selfId && current.has(id));
  return Promise.all(
    possible.map(async peerId => ({
      peerId,
      inRoom: true,
      recognizedInRoom:
        fold.classes[peerId] === 'integration' ||
        machines.has(peerId) ||
        markers.has(peerId),
      tasksConfigured: current.get(peerId)?.capabilities?.tasks === true,
      owned: machines.has(peerId),
      consent: machines.has(peerId)
        ? ('undecided' as const)
        : (knownConsents?.get(peerId) ??
          (await db
            .getAgentConsent(peerId)
            .catch(() => 'undecided' as const))),
    })),
  );
}

async function currentSecondOpinionTargetIds(
  roomId: string,
  sourceAuthorId: string,
): Promise<string[]> {
  const [group, profile] = await Promise.all([db.getGroup(roomId), db.loadProfile()]);
  if (!group || !profile) return [];
  const slots = await db.listGroupMemberSlots(roomId);
  const fold = foldRoster(group.ownerId, slots);
  if (!fold.members.includes(profile.userId)) return [];
  const [machineIds, markerIds] = await Promise.all([
    db.listMachinePeers(),
    db.listRoomAgentAuthorIds(roomId),
  ]);
  const facts = await secondOpinionFactsForFold(
    fold,
    profile.userId,
    new Set(machineIds),
    new Set(markerIds),
  );
  return eligibleSecondOpinionTargetIds(sourceAuthorId, facts);
}

interface SecondOpinionReviewState {
  peerId: string;
  sourceMsgId: string;
  sourceAuthorId: string;
}

/**
 * One conversation. Everything that could have been a floating overlay is
 * attached to the thing it belongs to instead: the reaction rail sits under
 * its message, photo and emoji choices are drawers seamed to the composer,
 * and the safety panel expands under the header.
 */
export function ChatThreadScreen({
  peerId,
  focusedApprovalQ,
  onBack,
  onOpenPeerProfile,
  onOpenPhoto,
  onStartCall,
  onOpenGroupProfile,
  onStartRoomCall,
}: Props) {
  const t = useTheme();
  const styles = stylesFor(t);
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
  /** Whether the list query has answered at least once for THIS peer. The
   * empty room is drawn only once the thread knows it is empty — before the
   * first answer `rows` is `` for every conversation, and drawing the
   * QuietRoom then flashed it (and announced its header) on every open of a
   * populated thread. */
  const [rowsLoaded, setRowsLoaded] = useState(false);
  /** The window the unread divider stands against: the chat's `lastOpenedAt`
   * as it stood BEFORE this open — read once, ahead of the stamp this thread
   * writes — up to the moment of this open. Null until the read answers, or
   * when there is no chat row. */
  const [unreadWindow, setUnreadWindow] = useState<UnreadWindow | null>(null);
  const [dividerVisible, setDividerVisible] = useState(true);
  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 1 }).current;
  /** `${msgId}:${direction}` of the row a tapped quote just revealed, held
   * for QUOTE_FLASH_MS so its bubble washes pine. */
  const [flashKey, setFlashKey] = useState<string | null>(null);
  /** Foreground, as STATE fed by an AppState listener rather than a one-time
   * read, so the effects that must not act on a pocketed phone re-run when
   * it comes forward. */
  const [appActive, setAppActive] = useState(
    () => AppState.currentState === 'active',
  );
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
  /** Current, source-backed agent facts for the second-opinion composer.
   * Empty until the room fold, capability snapshots and consent reads agree. */
  const [secondOpinionFacts, setSecondOpinionFacts] = useState<
    SecondOpinionAgentFact[]
  >([]);
  /** A prepared request remains local/editable until the ordinary Send tap. */
  const [secondOpinionReview, setSecondOpinionReview] =
    useState<SecondOpinionReviewState | null>(null);
  /** Mentions the composer is carrying, validated against the draft before
   * every use (see liveMentionChips — the model's own doctrine). */
  const [mentionChips, setMentionChips] = useState<MentionChip[]>([]);
  /** Mention metadata just read with a saved draft. It stays opaque until
   * this room's current folded roster and local names have both answered. */
  const [savedMentionBinding, setSavedMentionBinding] = useState<{
    peerId: string;
    text: string;
    encoded: string;
  } | null>(null);
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
  /** The one reaction group whose people are open, bound to the message's
   * composite identity so colliding sender ids cannot retarget the panel. */
  const [reactionDetail, setReactionDetail] = useState<{
    msgId: string;
    direction: 'in' | 'out';
    emoji: string;
  } | null>(null);
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
  const writingRevision = useRef(0);
  const writingAbort = useRef<AbortController | null>(null);
  const writingCandidate = useRef<{
    source: WritingDraftSnapshot;
    result: { text: string; chips: MentionChip[] };
  } | null>(null);
  const [writingUndo, setWritingUndo] = useState<{
    before: WritingDraftSnapshot;
    after: WritingDraftSnapshot;
  } | null>(null);
  const retireWriting = useCallback(() => {
    writingRevision.current += 1;
    writingAbort.current?.abort();
    writingAbort.current = null;
    writingCandidate.current = null;
    setWritingUndo(null);
  }, []);
  const [draft, setDraftValue] = useState('');
  const setDraft = useCallback((next: React.SetStateAction<string>) => {
    retireWriting();
    setDraftValue(next);
  }, [retireWriting]);
  const [sendError, setSendError] = useState<SendError | null>(null);
  const [sendingPhoto, setSendingPhoto] = useState(false);
  /** Retained bytes of a photo that failed to send, so retry is one tap. */
  const [failedPhoto, setFailedPhoto] = useState<PickedImage | null>(null);
  /** A photo picked and not yet sent. The bytes ride inside the state,
   * so discarding is one assignment and leaves no copy behind; the machine
   * itself is `../thread/photoReview`. */
  const [photoReview, setPhotoReview] =
    useState<PhotoReview>(NO_PHOTO_REVIEW);
  /** FIND. Open swaps the whole header for the bar; the query is
   * debounced into `db.findMessages` and refined in JS. `findCursor` indexes
   * `findMatches`, which arrive newest first. */
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [findMatches, setFindMatches] = useState<db.MessageRow[]>([]);
  const [findCursor, setFindCursor] = useState(0);
  /** WHICH QUERY THE MATCHES ANSWER FOR — '' while nothing has answered.
   * Without it the bar says "No message here matches that." for the first
   * 400 ms of every query, and answers a refined one with the old count. */
  const [findAnswered, setFindAnswered] = useState('');
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
  const [drawer, setDrawerValue] = useState<Drawer>('none');
  const setDrawer = useCallback((next: React.SetStateAction<Drawer>) => {
    const value = typeof next === 'function' ? next(drawerRef.current) : next;
    if (value !== drawerRef.current) retireWriting();
    drawerRef.current = value;
    setDrawerValue(value);
  }, [retireWriting]);
  const [railFor, setRailFor] = useState<db.MessageRow | null>(null);
  const [railIntent, setRailIntent] = useState<RailIntent>('react');
  /** Replying to, or rewriting, an existing message. Null while composing
   * something new. */
  const [pending, setPendingValue] = useState<Pending | null>(null);
  const setPending = useCallback((next: React.SetStateAction<Pending | null>) => {
    retireWriting();
    const value = typeof next === 'function' ? next(pendingRef.current) : next;
    pendingRef.current = value;
    setPendingValue(value);
  }, [retireWriting]);
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
  const [approvalsLoaded, setApprovalsLoaded] = useState(false);
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
  useEffect(() => {
    setApprovals([]);
    setApprovalsLoaded(false);
  }, [peerId]);
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
  /** Whether this open has already landed on the unread divider — once per
   * peer, on the first resize that has it on glass. */
  const dividerScrolled = useRef(false);
  /** The divider's list index, mirrored for the resize handler; -1 for none. */
  const dividerIndexRef = useRef(-1);
  /** Where the last programmatic scroll wanted to land, for the one retry
   * a far-off, unmeasured index needs (onScrollToIndexFailed). */
  const scrollWant = useRef<{ index: number; viewPosition: number; key: string } | null>(
    null,
  );
  /** The index that retry already ran for, so a row the list cannot measure
   * never loops. */
  const scrollRetried = useRef<number | null>(null);
  const scrollRetryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The attention route is a one-shot landing, even when a db notification
   * requeries the same rows while the person is reading the card. */
  const focusedApprovalSpent = useRef<string | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reactionsRef = useRef<Map<string, db.ReactionRow[]>>(new Map());
  const rowsRef = useRef<db.MessageRow[]>([]);
  /** The newest inbound row the last requery saw. A COUNT stood here, and a
   * row deleted and a row arrived inside one debounce window left the count
   * unchanged — so the arrival never raised "New messages". Null until the
   * first answer for this peer. */
  const seenNewestInbound = useRef<InboundMark | null>(null);
  /** Whether the list query has ANSWERED for this peer. `seenNewestInbound`
   * cannot say: an answer with no inbound rows stores the same `null` that
   * means "not answered yet", and that swallowed the FIRST arrival into a
   * thread of only my own sends, or a fresh room. Reset per peer
   * beside the mark itself. */
  const inboundAnswered = useRef(false);
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
  const savedMentionBindingRef = useRef(savedMentionBinding);
  const shelvedMentionBinding = useRef<typeof savedMentionBinding>(null);
  const reactionDetailRef = useRef(reactionDetail);
  /** Read by callbacks that must not re-arm whenever `pending` changes. */
  const pendingRef = useRef<Pending | null>(null);
  const draftLoaded = useRef(false);
  /** Read by the pick/remove callbacks, which must not re-arm per keystroke. */
  const mentionChipsRef = useRef<MentionChip[]>([]);
  const mentionCaretRef = useRef<number | null>(null);
  const secondOpinionReviewRef = useRef<SecondOpinionReviewState | null>(null);
  /** Prevent two same-frame Send taps from passing the async revalidation. */
  const secondOpinionSending = useRef(false);
  /** Invalidates a delayed room/capability/consent read on switch or unmount. */
  const secondOpinionGeneration = useRef(0);
  const screenLive = useRef(true);
  /** Read by the system-back handler, which is registered once and must see
   * what is open at the moment of the press, not at subscription. */
  const callPickerRef = useRef<'audio' | 'video' | null>(null);
  const safetyOpenRef = useRef(false);
  const drawerRef = useRef<Drawer>('none');
  const findOpenRef = useRef(false);
  /** Read by the find read's own callback, which resolves long after the
   * keystroke that issued it. */
  const findQueryRef = useRef('');
  const photoReviewRef = useRef<PhotoReview>(NO_PHOTO_REVIEW);

  draftRef.current = draft;
  savedMentionBindingRef.current = savedMentionBinding;
  reactionDetailRef.current = reactionDetail;
  pendingRef.current = pending;
  mentionChipsRef.current = mentionChips;
  mentionCaretRef.current = mentionCaret;
  secondOpinionReviewRef.current = secondOpinionReview;
  callPickerRef.current = callPicker;
  safetyOpenRef.current = safetyOpen;
  drawerRef.current = drawer;
  findOpenRef.current = findOpen;
  findQueryRef.current = findQuery;
  photoReviewRef.current = photoReview;
  rowsRef.current = rows;

  useEffect(() => {
    screenLive.current = true;
    secondOpinionGeneration.current += 1;
    return () => {
      screenLive.current = false;
      secondOpinionGeneration.current += 1;
    };
  }, [peerId]);

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
    if (!appActive) return;
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
  }, [peerId, rows, groupKnown, group, appActive]);

  const liveCallName = liveCall.name;
  useEffect(() => {
    if (liveCallName === 'idle') refresh();
    // refresh is stable per peerId; the dep below is the trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveCallName]);

  const refresh = useCallback(() => {
    // Guarded by the peer the query was asked about, like every per-peer
    // read below (five of these callbacks had no guard, so a slow read
    // racing a thread switch could paint the previous conversation into
    // this one).
    quiet(db.getChat(peerId), row => {
      if (peerIdRef.current !== peerId) return;
      setChat(row);
    });
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
        let opinionFacts: SecondOpinionAgentFact[] = [];
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
          const consents = new Map<string, db.AgentConsentState>();
          await Promise.all(
            candidates.map(async id => {
              consents.set(
                id,
                await db
                  .getAgentConsent(id)
                  .catch(() => 'undecided' as const),
              );
            }),
          );
          let refused: string | null = null;
          for (const id of candidates) {
            const state = consents.get(id) ?? 'undecided';
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
          if (selfId) {
            opinionFacts = await secondOpinionFactsForFold(
              fold,
              selfId,
              machines,
              markers,
              consents,
            );
          }
        }
        return {
          g,
          chats: g ? await db.listChats() : null,
          // The header's people count rides the same read: the folded
          // roster, the one answer the send path also acts on.
          fold,
          hint,
          opinionFacts,
        };
      }),
      ({ g, chats, fold, hint, opinionFacts }) => {
        if (peerIdRef.current !== peerId) return;
        setGroup(g);
        setGroupKnown(true);
        // One fold feeds both the header count and the mention picker, so
        // the two can never disagree about who is in this room.
        setMemberCount(fold ? fold.members.length : null);
        setRoomMembers(fold ? [...fold.members] : []);
        setRoomSkipped(g ? messaging.skippedInRoom(peerId) : []);
        setConsentHint(hint);
        setSecondOpinionFacts(opinionFacts);
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
      setApprovalsLoaded(true);
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
      if (peerIdRef.current !== peerId) return;
      // Reaction and profile carriers are transport, not conversation.
      const visible = all.filter(r => !isCarrierEnvelope(r.body));
      // An ARRIVAL is a newer newest-inbound row than the last answer had —
      // a deletion moves the mark back and claims nothing, and a repaint of
      // the same rows leaves it where it was.
      const newest = newestInboundOf(visible);
      const priorNewest = seenNewestInbound.current;
      const answered = inboundAnswered.current;
      inboundAnswered.current = true;
      if (
        answered &&
        newest !== null &&
        // No inbound row before this answer is still an arrival — it is the
        // FIRST one, and the thread was answered, so the two nulls are told
        // apart by `answered`, never by the mark.
        (priorNewest === null || laterArrival(newest, priorNewest)) &&
        !atBottom.current
      ) {
        setHasNew(true);
      }
      seenNewestInbound.current = newest;
      setRows(visible);
      setRowsLoaded(true);
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
      if (peerIdRef.current !== peerId) return;
      // Keyed by the message composite identity: ids are sender-chosen, so
      // msgId alone can collide across directions.
      setAttachments(new Map(list.map(a => [`${a.msgId}:${a.direction}`, a])));
    });
    quiet(db.listReactions(peerId), list => {
      if (peerIdRef.current !== peerId) return;
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
      if (peerIdRef.current !== peerId) return;
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

  // Opening a conversation clears that peer's missed-call notices.
  // Repeat when the app becomes active: a call can be missed while this
  // thread remains open in the background. This handles 1:1 calls only;
  // the coordinator does not post missed-call notices for room sessions.
  useEffect(() => {
    if (!appActive) return;
    void clearMissedCallNotices(peerId);
  }, [peerId, appActive]);

  // Foreground as state: the read-receipt effect above keys
  // on `appActive`, so a message that arrived while the phone was pocketed —
  // correctly not receipted then — is receipted when the thread comes back
  // on glass. Coming forward is also the other moment a person is actually
  // looking, so it sweeps the disappearing rows again: the
  // timer below may never fire while the app is suspended.
  useEffect(() => {
    const sub = AppState.addEventListener('change', next => {
      const active = next === 'active';
      setAppActive(active);
      // A photo waiting for a decision does not wait behind another app
      //, and the bytes go with it: an unsent photo is the one thing on
      // this screen that is not already in the database.
      if (!active) setPhotoReview(discardReview());
      if (!active) return;
      quiet(
        messaging.sweepDisappearing(peerId).then(() => {
          if (peerIdRef.current === peerId) refresh();
        }),
      );
    });
    return () => sub.remove();
  }, [peerId, refresh]);

  /** The soonest expiry among the rows on glass, or Infinity for none. A
   * number, so an unchanged deadline across a requery is not a new one. */
  const nextExpiry = useMemo(() => {
    let soonest = Infinity;
    for (const row of rows) {
      if (row.expiresAt != null && row.expiresAt < soonest) {
        soonest = row.expiresAt;
      }
    }
    return soonest;
  }, [rows]);

  useEffect(() => {
    // A disappearing message disappears WHILE the thread is open: one timer
    // at the soonest deadline — the typists-expiry pattern — runs the same
    // sweep the mount runs and requeries, so the row leaves the glass
    // without a remount. The sweep keeps its own predicates (messaging's
    // sibling purge relies on them); this only decides WHEN it runs. A sweep that
    // removes nothing does not re-arm: `nextExpiry` is the same number after
    // the requery.
    if (!Number.isFinite(nextExpiry)) return;
    const timer = setTimeout(
      () => {
        quiet(
          messaging.sweepDisappearing(peerId).then(() => {
            if (peerIdRef.current === peerId) refresh();
          }),
        );
      },
      Math.max(0, nextExpiry - Date.now()) + 50,
    );
    return () => clearTimeout(timer);
  }, [nextExpiry, peerId, refresh]);

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
    seenNewestInbound.current = null;
    inboundAnswered.current = false;
    // Back to "not seeded": the other conversation's failures must neither be
    // announced here nor suppress this one's.
    announcedFailed.current = null;
    setShowJump(false);
    setHasNew(false);
    // Back to "not answered": this conversation's emptiness is not known
    // until its own list query lands.
    setRowsLoaded(false);
    // And its unread window: the previous thread's stamp says nothing about
    // this one, and this one's divider has not been landed on yet.
    setUnreadWindow(null);
    setDividerVisible(true);
    dividerScrolled.current = false;
    scrollWant.current = null;
    scrollRetried.current = null;
    if (scrollRetryTimer.current) clearTimeout(scrollRetryTimer.current);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    setFlashKey(null);
    // And every open full answer: the keys are `${msgId}:${direction}` and
    // msgIds are PEER-CHOSEN, so a key carried across a peer switch could
    // open a different conversation's bubble on arrival.
    setExpandedDetails(new Set());
    // Back to "not answered": the previous thread's roomness must not gate —
    // or ungate — this one's receipts for even one render.
    setGroup(null);
    setGroupKnown(false);
    setMemberCount(null);
    setRoomSkipped([]);
    // The previous room's people must not be offerable in this one, and its
    // chips must not survive into a draft they no longer describe.
    setRoomMembers([]);
    setSecondOpinionFacts([]);
    setSecondOpinionReview(null);
    secondOpinionReviewRef.current = null;
    secondOpinionSending.current = false;
    setMentionChips([]);
    setSavedMentionBinding(null);
    setMentionCaret(null);
    setReactionDetail(null);
    // A half-assembled call belongs to the room it was opened in. Left up, its
    // rows would restock from the NEXT room's fold while the panel still
    // believed it was choosing people for the last one.
    setCallPicker(null);
    // A photo chosen for one person is not a photo for the next, and its
    // bytes must not outlive the conversation it was picked in. Same
    // for a failed one: Try again aims at whoever is on screen now.
    setPhotoReview(discardReview());
    setFailedPhoto(null);
    // Find belongs to the conversation it was opened in, for the same
    // reason: one thread's query, its count and its rows must never stand
    // over another's messages. (`closeFind` cannot be called here — it is
    // declared below, and this effect's dependency array is read first.)
    setFindOpen(false);
    setFindQuery('');
    setFindMatches([]);
    setFindAnswered('');
    setFindCursor(0);
  }, [peerId]);

  // What is new in the chat list is measured against this stamp; the thread is
  // the only place that can honestly write it.
  useEffect(() => {
    // The stamp this open OVERWRITES is read first, once: the unread divider
    // stands against it, and every later read of the chat row — the
    // debounced refresh on each receipt — answers with this open's own
    // stamp, which would make the divider vanish on the first tick. Chained,
    // so the read is issued before the write. One reading of the clock for
    // both halves of the same fact: what this open stamps on the chat is
    // exactly the divider's upper bound, so a message that arrives a moment
    // later is on the far side of the line.
    const openedAt = Date.now();
    let closed = false;
    quiet(
      db.getChat(peerId).then(chatRow => {
        if (closed) return;
        if (peerIdRef.current === peerId) {
          setUnreadWindow(
            chatRow
              ? { since: chatRow.lastOpenedAt ?? 0, until: openedAt }
              : null,
          );
        }
        return db.markChatOpened(peerId, openedAt);
      }),
    );
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
      closed = true;
      clearFocusedConversation(peerId);
      quiet(db.markChatOpened(peerId, Date.now()));
    };
  }, [peerId]);

  useEffect(() => {
    draftLoaded.current = false;
    let cancelled = false;
    quiet(db.getComposerDraft(peerId), saved => {
      if (cancelled || peerIdRef.current !== peerId) return;
      // Never clobber something typed while the read was in flight.
      setDraft(current => (current === '' ? saved.text : current));
      if (draftRef.current === '' && saved.mentionState) {
        setSavedMentionBinding({
          peerId,
          text: saved.text,
          encoded: saved.mentionState,
        });
      }
      draftLoaded.current = true;
    });
    return () => { cancelled = true; };
  }, [setDraft, peerId]);

  useEffect(() => {
    // While an edit holds the composer its contents are somebody's already
    // sent message, not a draft. Persisting it would bring those words back
    // on the next visit looking like something half-written.
    if (pending?.kind === 'edit') return;
    if (!draftLoaded.current && draft === '') return;
    const timer = setTimeout(() => {
      const carried =
        savedMentionBinding?.peerId === peerId &&
        savedMentionBinding.text === draft
          ? savedMentionBinding.encoded
          : encodeMentionDraft(peerId, draft, mentionChipsRef.current);
      quiet(db.setDraft(peerId, draft, carried));
    }, DRAFT_SAVE_MS);
    return () => clearTimeout(timer);
  }, [peerId, draft, mentionChips, pending, savedMentionBinding]);

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
      const chips =
        pendingRef.current?.kind === 'edit'
          ? shelvedChips.current
          : mentionChipsRef.current;
      const saved = pendingRef.current?.kind === 'edit'
        ? shelvedMentionBinding.current
        : savedMentionBindingRef.current;
      const encoded = saved?.peerId === peerId && saved.text === text
        ? saved.encoded
        : encodeMentionDraft(peerId, text, chips);
      quiet(db.setDraft(peerId, text, encoded));
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

  /** Reaction details may say only a name this phone actually knows for an
   * authenticated current participant. A missing/former room member is the
   * plain noun “Someone”; a raw or shortened account id is never copy. */
  const reactionNameFor = useCallback(
    (reaction: db.ReactionRow): string => {
      if (reaction.direction === 'out') return 'You';
      if (isRoom && (!reaction.reactorId || !roomMembers.includes(reaction.reactorId))) {
        return 'Someone';
      }
      const id = isRoom ? reaction.reactorId : peerId;
      const entry = isRoom ? names.get(id) : { localName: chat?.localName, displayName: chat?.displayName };
      const label = tileName(id,
        sanitizeDisplayName(entry?.localName) || sanitizeDisplayName(entry?.displayName),
      );
      // Match nameFor's subject rule: only the local reaction may say You.
      return /^(you|them)$/i.test(label.trim()) ? 'Someone' : label;
    },
    [isRoom, peerId, chat?.localName, chat?.displayName, roomMembers, names],
  );

  /** Current room identities paired with the exact labels this composer
   * would draw. Saved mention intent is accepted only against this map. */
  const eligibleMentionNames = useMemo(
    () =>
      new Map(
        isRoom
          ? roomMembers
              .filter(id => id !== me?.userId)
              .map(id => [id, nameFor(id)] as const)
          : [],
      ),
    [isRoom, roomMembers, me?.userId, nameFor],
  );
  const writingMentionNames = useRef(eligibleMentionNames);
  writingMentionNames.current = eligibleMentionNames;

  useEffect(() => {
    const saved = savedMentionBinding;
    if (saved === null || !groupKnown || !me?.userId) return;
    // A person may have typed or picked a fresh mention while the roster read
    // was in flight. Their live input wins; stale storage never overwrites it.
    if (mentionChipsRef.current.length === 0) {
      setMentionChips(
        isRoom
          ? restoreMentionDraft(
              peerId,
              draft,
              saved.encoded,
              eligibleMentionNames,
            )
          : [],
      );
    }
    setSavedMentionBinding(null);
  }, [
    draft,
    eligibleMentionNames,
    groupKnown,
    isRoom,
    peerId,
    savedMentionBinding,
    me?.userId,
  ]);

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
      if (drawerRef.current === 'writing') setDrawer('none');
      setSavedMentionBinding(null);
      setMentionChips(chips => shiftMentionChips(prev, next, chips));
      setMentionCaret(caretAfterEdit(prev, next));
      setDraft(next);
      typingSignaler.onDraftChange(next.trim().length > 0);
    },
    [typingSignaler, setDraft, setDrawer],
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
    const reviewTargets = secondOpinionReview
      ? new Set(
          eligibleSecondOpinionTargetIds(
            secondOpinionReview.sourceAuthorId,
            secondOpinionFacts,
          ),
        )
      : null;
    return roomMembers
      .filter(
        id =>
          id !== me?.userId &&
          (reviewTargets === null || reviewTargets.has(id)),
      )
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
    secondOpinionReview,
    secondOpinionFacts,
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
      const picked = nameFor(id);
      setSavedMentionBinding(null);
      const token = `@${picked} `;
      const delta = token.length - (caret - at.at);
      const shifted = live.map(chip =>
        chip.start >= caret
          ? { ...chip, start: chip.start + delta, end: chip.end + delta }
          : chip,
      );
      setMentionChips([
        ...shifted,
        { id, name: picked, start: at.at, end: at.at + 1 + picked.length },
      ]);
      setDraft(prev.slice(0, at.at) + token + prev.slice(caret));
      setMentionCaret(at.at + token.length);
    },
    [setDraft, nameFor],
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
  }, [setDraft]);

  /** Current targets for one agent answer. The source is removed in the
   * model, so an agent can never be asked to trigger itself. */
  const secondOpinionTargetsFor = useCallback(
    (sourceAuthorId: string): string[] =>
      eligibleSecondOpinionTargetIds(sourceAuthorId, secondOpinionFacts),
    [secondOpinionFacts],
  );

  /** Turn an existing agent answer into a local, editable mention draft.
   * This performs no send; the ordinary composer Send remains confirmation. */
  const startSecondOpinion = useCallback(
    (row: db.MessageRow) => {
      const sourceAuthorId = row.authorId;
      if (
        !isRoom ||
        sourceAuthorId == null ||
        row.direction !== 'in' ||
        row.deletedAt != null ||
        row.sharedBy != null ||
        row.outsider === 1 ||
        !roomMembers.includes(sourceAuthorId) ||
        (row.ai !== 1 && !machinePeers.has(sourceAuthorId)) ||
        draftRef.current.trim() !== '' ||
        pendingRef.current !== null ||
        secondOpinionReviewRef.current !== null ||
        photoReviewRef.current.kind !== 'none'
      ) {
        return;
      }
      const ids = secondOpinionTargetsFor(sourceAuthorId);
      const built = buildSecondOpinionDraft(
        ids.map(id => ({ peerId: id, name: nameFor(id) })),
        row.body,
      );
      if (built === null) return;
      const review: SecondOpinionReviewState = {
        peerId,
        sourceMsgId: row.msgId,
        sourceAuthorId,
      };
      // Refs move with the state in the same tick, closing rapid-tap seams.
      secondOpinionReviewRef.current = review;
      draftRef.current = built.draft;
      mentionChipsRef.current = built.chips;
      setSecondOpinionReview(review);
      setDraft(built.draft);
      setMentionChips(built.chips);
      setMentionCaret(built.draft.length);
      setRailFor(null);
      setDrawer('none');
      setSendError(null);
    },
    [setDraft, setDrawer,
      isRoom,
      roomMembers,
      machinePeers,
      secondOpinionTargetsFor,
      nameFor,
      peerId,
    ],
  );

  const cancelSecondOpinion = useCallback(() => {
    const review = secondOpinionReviewRef.current;
    if (
      review === null ||
      review.peerId !== peerIdRef.current ||
      secondOpinionSending.current
    ) {
      return;
    }
    typingSignaler.stop();
    secondOpinionReviewRef.current = null;
    draftRef.current = '';
    mentionChipsRef.current = [];
    setSecondOpinionReview(null);
    setDraft('');
    setMentionChips([]);
    setMentionCaret(null);
    setSendError(null);
    quiet(db.setDraft(peerId, ''));
  }, [setDraft, peerId, typingSignaler]);

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

  // Approval requests live outside messages. Resolve only this peer's
  // inbound requests, and keep them out of message/round author algebra.
  const approvalsByWire = useMemo(() => {
    const map = new Map<string, ApprovalQuote>();
    if (group === null) {
      for (const approval of approvals) {
        if (approval.peerId === peerId) {
          // A memoized answer may outlive payload redaction on the request.
          // Give it only the fixed context and navigation identity it needs.
          map.set(approval.wireMsgId, {
            peerId: approval.peerId,
            q: approval.q,
            kind: approval.kind,
          });
        }
      }
    }
    return map;
  }, [approvals, group, peerId]);

  const quotedFor = useCallback(
    // Narrower than ThreadItem on purpose: the round pass asks the SAME
    // resolver about a row it has not built an item for yet, and a second
    // copy of this arithmetic could drift from the shared calculation.
    ({ row, envelope }: Pick<ThreadItem, 'row' | 'envelope'>):
      | db.MessageRow
      | undefined => {
      if (envelope?.tcm !== 'reply') return undefined;
      // `ofs` is the REPLIER's authorship claim: what they wrote is my 'in'
      // row when the reply came from them, and my 'out' row when it is mine.
      const authoredByMe = envelope.ofs === (row.direction === 'out');
      return byKey.get(`${envelope.ref}:${authoredByMe ? 'out' : 'in'}`);
    },
    [byKey],
  );

  /**
   * THE ROUND'S REF ARM : which stored row an answer
   * answers, as a list key — or null when it answers nothing this phone
   * holds.
   *
   * The ref is MATCHED AGAINST ROWS, never trusted as a label, which is what
   * makes the round key authenticated rather than sender-chosen: the row it
   * resolves to has a sender the ratchet already vouched for.
   *
   * TWO ARMS, because a room ref and a 1:1 ref are different things. A ROOM
   * ref names its author outright (`${authorId}.${m}`), so the side comes from
   * the author — `rounds.ts:roomAnchorKey`. Resolving a room ref through
   * `ofs` instead looks right on the OWNER's phone, where the human turn is an
   * out row, and silently misses on every other member's, where the same turn
   * is inbound; the arm then degrades to the window arm with every owner-side
   * test still green. A 1:1 ref carries no author, so it keeps `quotedFor` —
   * the same resolver the quote box uses, asked once.
   */
  const roundAnchorKey = useCallback(
    (row: db.MessageRow, envelope: Envelope | null): string | null => {
      if (envelope?.tcm !== 'reply') return null;
      if (group !== null) {
        const key = roomAnchorKey(envelope.ref, me?.userId ?? null);
        return key !== null && byKey.has(key) ? key : null;
      }
      const anchor = quotedFor({ row, envelope });
      return anchor ? rowKey(anchor.msgId, anchor.direction) : null;
    },
    [group, me?.userId, byKey, quotedFor],
  );

  /** Membership in a round, asked of the same rule the badge asks . */
  const roundAiSender = useCallback(
    (row: db.MessageRow): boolean =>
      aiSenderOf(row, { inRoom: group !== null, isAgentId, peerIsAgent }),
    [group, isAgentId, peerIsAgent],
  );

  /**
   * Which rows have their FULL ANSWER open, by `${msgId}:${direction}`
   * . Held on the SCREEN, not inside the disclosure:
   * a thread requeries on every receipt, reaction and download tick, and
   * state inside the row would close every open detail each time one landed.
   * A Set, so the memo comparator is one `has` per row.
   */
  const [expandedDetails, setExpandedDetails] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const onToggleDetail = useCallback((row: db.MessageRow) => {
    const key = rowKey(row.msgId, row.direction);
    setExpandedDetails(current => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }, []);

  // The chip must show what the row says NOW: the peer can retract or rewrite
  // the message being answered while the composer holds it. Dropping a
  // retracted target also stops a reply that would quote nothing.
  useEffect(() => {
    if (!pending) return;
    const live = byKey.get(`${pending.row.msgId}:${pending.row.direction}`);
    if (!live || live.deletedAt || (live.expiresAt != null && live.expiresAt <= Date.now())) {
      // Same restore as cancelling by hand: an edit borrowed the composer.
      if (pendingRef.current?.kind === 'edit') {
        setDraft(shelvedDraft.current);
        setMentionChips(shelvedChips.current);
        setSavedMentionBinding(shelvedMentionBinding.current);
        shelvedMentionBinding.current = null;
        shelvedDraft.current = '';
        shelvedChips.current = [];
      }
      setPending(null);
    } else if (live.body !== pending.row.body) {
      setPending(current => (current ? { ...current, row: live } : current));
    }
  }, [setDraft, setPending, pending, byKey]);

  // A details surface never outlives its exact message, emoji, or ability to
  // act. Requeries from deletion, expiry, block and retraction all converge
  // here, including while the panel itself is already open.
  useEffect(() => {
    if (reactionDetail === null) return;
    const key = `${reactionDetail.msgId}:${reactionDetail.direction}`;
    const target = byKey.get(key);
    const groupExists = groupReactions(reactions.get(key) ?? []).some(
      entry => entry.emoji === reactionDetail.emoji,
    );
    if (
      !target ||
      target.deletedAt != null ||
      (target.expiresAt != null && target.expiresAt <= Date.now()) ||
      !groupExists ||
      blocked ||
      peerBlocked
    ) {
      setReactionDetail(null);
    }
  }, [reactionDetail, byKey, reactions, blocked, peerBlocked]);

  /** (msgId:direction) → the body it was parsed from and the result; see the
   * parse-once note inside `items`. */
  const envelopeCache = useRef<
    Map<string, { body: string; envelope: Envelope | null }>
  >(new Map());

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
    // Parse ONCE per row per data change. Keyed by the row's identity and
    // checked against its body: a requery returns fresh row objects with
    // the same words, and those are not parsed again. Rebuilt from the
    // current rows on every pass, so it holds nothing for rows that have
    // gone.
    const prior = envelopeCache.current;
    const next = new Map<string, { body: string; envelope: Envelope | null }>();
    const envelopes = mergedRows.map(row => {
      const key = `${row.msgId}:${row.direction}`;
      const hit = next.get(key) ?? prior.get(key);
      if (hit && hit.body === row.body) {
        next.set(key, hit);
        return hit.envelope;
      }
      const envelope = parseEnvelope(row.body);
      next.set(key, { body: row.body, envelope });
      return envelope;
    });
    envelopeCache.current = next;
    return buildItems(
      mergedRows,
      merged.map(e => e.c),
      merged.map(e => e.a),
      envelopes,
      unreadWindow,
      { aiSender: roundAiSender, anchorKey: roundAnchorKey },
    );
    // The two round callbacks are memoised on what they read (the room
    // anchor, my id, the row map, the machine record), so a requery that
    // changes none of those leaves this memo's identity alone — which is
    // what keeps a tick from remounting every row (ChatThread.scrollpin).
  }, [rows, calls, approvals, unreadWindow, roundAiSender, roundAnchorKey]);

  /** The items as of this render, for handlers that must not re-identify on
   * every requery (a tapped quote resolves its index at tap time). */
  const itemsRef = useRef<ThreadItem[]>([]);
  itemsRef.current = items;
  dividerIndexRef.current = useMemo(
    () => items.findIndex(it => it.divider != null),
    [items],
  );

  const onViewableItemsChanged = useCallback(({ viewableItems }: { viewableItems: ViewToken<ThreadItem>[] }) => {
    const divider = itemsRef.current[dividerIndexRef.current];
    if (!divider) return;
    const key = threadKey(divider);
    setDividerVisible(viewableItems.some(token => token.isViewable && token.key === key));
  }, []);

  // The landing is a ONE-SHOT for the state the thread opened in. Once the
  // unread window is known and the list has answered, "no divider" is the
  // final answer for this open — spend the flag, so nothing arriving later
  // can take the anchor away from someone reading at the end.
  useEffect(() => {
    if (dividerScrolled.current) return;
    if (unreadWindow === null || !rowsLoaded) return;
    if (dividerIndexRef.current < 0) dividerScrolled.current = true;
  }, [unreadWindow, rowsLoaded, items]);

  useEffect(
    () => () => {
      if (flashTimer.current) clearTimeout(flashTimer.current);
      if (scrollRetryTimer.current) clearTimeout(scrollRetryTimer.current);
    },
    [],
  );

  /** A programmatic scroll to a row, remembered so a far-off index the list
   * has not measured can be retried once from onScrollToIndexFailed. */
  const scrollToRow = useCallback(
    (index: number, viewPosition: number, animated: boolean) => {
      const item = itemsRef.current[index];
      if (!item) return;
      if (scrollRetryTimer.current) clearTimeout(scrollRetryTimer.current);
      scrollWant.current = { index, viewPosition, key: threadKey(item) };
      scrollRetried.current = null;
      listRef.current?.scrollToIndex({ index, viewPosition, animated });
    },
    [],
  );

  useEffect(() => {
    if (!focusedApprovalQ) {
      focusedApprovalSpent.current = null;
      return;
    }
    const focusKey = `${peerId}\u0000${focusedApprovalQ}`;
    if (focusedApprovalSpent.current === focusKey) return;
    const index = items.findIndex(
      item =>
        item.approval?.peerId === peerId &&
        item.approval.q === focusedApprovalQ,
    );
    // The approvals query answers asynchronously. Leave the request unspent
    // until its exact row exists so the next render can land on it.
    if (index < 0) return;
    focusedApprovalSpent.current = focusKey;
    // Explicit navigation outranks both ordinary bottom anchoring and the
    // unread-divider landing; neither may move the requested card away on
    // the next content-size callback.
    dividerScrolled.current = true;
    anchoredToEnd.current = false;
    atBottom.current = false;
    setShowJump(true);
    scrollToRow(index, 0.5, !reduceMotion);
  }, [focusedApprovalQ, items, peerId, reduceMotion, scrollToRow]);

  /**
   * A tapped quote goes to the message it quotes: scroll it to the middle of
   * the view and wash it pine for a moment. Resolved by the row's composite
   * key, so a peer's reply pointing at MY row lands on my row and never on
   * an inbound row sharing the id. */
  const revealQuoted = useCallback(
    (target: db.MessageRow) => {
      const key = `${target.msgId}:${target.direction}`;
      const index = itemsRef.current.findIndex(
        it =>
          it.divider == null &&
          // A round header is a synthetic item too, and its placeholder's
          // msgId is built from a peer-chosen one — so it is excluded by
          // KIND here, exactly as the other placeholders are.
          it.round == null &&
          !it.call &&
          !it.approval &&
          it.row.msgId === target.msgId &&
          it.row.direction === target.direction,
      );
      if (index < 0) return;
      // Going back up the thread is leaving the end: the anchor must not
      // pull the view straight back down on the next resize.
      anchoredToEnd.current = false;
      scrollToRow(index, 0.5, !reduceMotion);
      setFlashKey(key);
      if (flashTimer.current) clearTimeout(flashTimer.current);
      flashTimer.current = setTimeout(() => {
        flashTimer.current = null;
        setFlashKey(current => (current === key ? null : current));
      }, QUOTE_FLASH_MS);
    },
    [reduceMotion, scrollToRow],
  );

  const revealQuotedApproval = useCallback(
    (target: ApprovalQuote) => {
      const index = itemsRef.current.findIndex(
        item =>
          item.approval?.peerId === target.peerId &&
          item.approval.q === target.q,
      );
      if (index < 0) return;
      dividerScrolled.current = true;
      anchoredToEnd.current = false;
      atBottom.current = false;
      setShowJump(true);
      scrollToRow(index, 0.5, !reduceMotion);
    },
    [reduceMotion, scrollToRow],
  );

  /** FIND opens. Everything anchored to something else closes with it:
   * the rail is fixed to one row and find is about to move the list out from
   * under it, and the picker and the safety panel hang UNDER the header —
   * which find is replacing, leaving them attached to nothing. */
  const openFind = useCallback(() => {
    setFindOpen(true);
    setReactionDetail(null);
    setRailFor(null);
    setDrawer('none');
    setCallPicker(null);
    setSafetyOpen(false);
  }, [setDrawer]);

  /** And closes, WITHOUT moving the list: jumping back to the end would
   * throw away the thing just found. `revealQuoted` already released the
   * bottom anchor, so the view stays where the last match left it. */
  const closeFind = useCallback(() => {
    setFindOpen(false);
    setFindQuery('');
    setFindMatches([]);
    setFindAnswered('');
    setFindCursor(0);
  }, []);

  /**
   * The query, debounced, prefiltered in SQL and REFINED here.
   *
   * The refinement is not optional: a stored body is sometimes an envelope,
   * so `body LIKE '%door%'` matches inside a photo's base64 key material.
   * `refineFindRows` re-reads every row through `displayText`, with this
   * thread's own author resolver so a mention matches the NAME this phone
   * shows. Deleted rows are excluded in SQL; expired rows never reach it.
   * Reading your own history is not a send, so this runs under a block,
   * under an identity change, and in a duress session — on the decoy's rows.
   */
  useEffect(() => {
    if (!findOpen) return;
    const query = findQuery.trim();
    if (!findQueryReady(query)) {
      setFindMatches([]);
      setFindAnswered('');
      setFindCursor(0);
      return;
    }
    const timer = setTimeout(() => {
      quiet(db.findMessages(peerId, query, FIND_LIMIT), found => {
        // A STALE ANSWER IS DROPPED, never rendered. The cleanup above can
        // cancel a timer but not a read already issued, so two are in
        // flight whenever one outlives the 400 ms to the next — and the
        // older one resolving last would answer for a query the field no
        // longer holds, or repopulate a bar that has since closed.
        if (peerIdRef.current !== peerId) return;
        if (!findOpenRef.current) return;
        if (findQueryRef.current.trim() !== query) return;
        setFindMatches(refineFindRows(found, query, nameFor));
        setFindAnswered(query);
        setFindCursor(0);
      });
    }, FIND_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [findOpen, findQuery, peerId, nameFor]);

  /** Every step, and the first result, go through the SAME function a
   * tapped quote does: it already releases the bottom anchor, scrolls to
   * mid-view and washes the row pine. Nothing else in the scroll machine
   * is touched. */
  useEffect(() => {
    if (!findOpen) return;
    const target = findMatches[findCursor];
    if (!target) return;
    revealQuoted(target);
  }, [findOpen, findMatches, findCursor, revealQuoted]);

  /**
   * Without getItemLayout the list cannot reach a row it has not measured in
   * one step — a quoted message far up, the unread divider in a long
   * thread. Land near it by the average row height, then ask once more when
   * that region has rendered; once only, so an index the list can never
   * measure does not loop. The rail's own scroll is to a cell just pressed,
   * so it never arrives here.
   */
  const onScrollToIndexFailed = useCallback(
    (info: { index: number; averageItemLength: number }) => {
      if (scrollRetried.current === info.index) return;
      const want = scrollWant.current;
      if (!want || want.index !== info.index) return;
      scrollRetried.current = info.index;
      const requestedPeer = peerIdRef.current;
      listRef.current?.scrollToOffset({
        offset: Math.max(0, info.averageItemLength * info.index),
        animated: false,
      });
      if (scrollRetryTimer.current) clearTimeout(scrollRetryTimer.current);
      scrollRetryTimer.current = setTimeout(() => {
        scrollRetryTimer.current = null;
        if (scrollWant.current !== want || peerIdRef.current !== requestedPeer) return;
        const index = itemsRef.current.findIndex(item => threadKey(item) === want.key);
        if (index < 0) return;
        listRef.current?.scrollToIndex({ index, viewPosition: want.viewPosition, animated: false });
      }, 100);
    },
    [],
  );

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
   * AUTO-SCROLL ATTRIBUTION: what caused the render
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
    expandedDetails: ReadonlySet<string> | null;
  }>({
    items: null,
    attachments: null,
    reactions: null,
    approvalNow: 0,
    streamTick: 0,
    expandedDetails: null,
  });
  {
    const prev = scrollAttribution.current;
    const contentChanged =
      prev.items !== items ||
      prev.attachments !== attachments ||
      prev.reactions !== reactions;
    const tickChanged =
      prev.approvalNow !== approvalNow ||
      prev.streamTick !== streamTick ||
      // OPENING A FULL ANSWER is the same class as a tick, and the sharpest
      // case of it : the disclosure grows the bubble by
      // hundreds of points, fires this resize, and — pinned — would scroll
      // the list to the end away from the very words the person just asked
      // to read. Nothing arrived; a row already on glass got taller.
      (prev.expandedDetails !== null &&
        prev.expandedDetails !== expandedDetails);
    // Content wins a mixed render: a genuinely new row while pinned scrolls
    // even when a tick rode the same commit.
    tickOnlyRepaint.current = tickChanged && !contentChanged;
    scrollAttribution.current = {
      items,
      attachments,
      reactions,
      approvalNow,
      streamTick,
      expandedDetails,
    };
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
      setSendError({ ...sendErrorFor(err, kind, COPY), seq: errorSeq.current });
    },
    [isRoom],
  );

  /** Re-read the approvals slice alone — an answer must repaint its card
   * without waiting on the debounced full refresh. */
  const reloadApprovals = useCallback(() => {
    quiet(db.listApprovals(peerId, Date.now()), list => {
      if (peerIdRef.current !== peerId) return;
      setApprovals(list);
      setApprovalsLoaded(true);
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

  const jumpToFirstNew = useCallback(() => {
    const index = dividerIndexRef.current;
    if (index < 0) return;
    anchoredToEnd.current = false;
    atBottom.current = false;
    dividerScrolled.current = true;
    setShowJump(true);
    scrollToRow(index, 0, !reduceMotion);
  }, [reduceMotion, scrollToRow]);

  const jumpToLatest = useCallback(() => {
    scrollWant.current = null;
    if (scrollRetryTimer.current) clearTimeout(scrollRetryTimer.current);
    dividerScrolled.current = true;
    setHasNew(false);
    // Re-anchor: asking for the newest message means asking to STAY there,
    // so anything still loading keeps the view pinned rather than sliding
    // out from under the person who just tapped this.
    anchoredToEnd.current = true;
    setShowJump(false);
    listRef.current?.scrollToEnd({ animated: !reduceMotion });
  }, [reduceMotion]);

  // The list's handlers hold their identity across keystrokes and ticks:
  // VirtualizedList is a PureComponent, and an inline handler was a new
  // prop on every render of this screen — every character typed
  // re-rendered the whole list. These read refs, and `onScroll`
  // re-identifies only when the two states it reads change.
  const onScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
      scrollOffset.current = contentOffset.y;
      const nearBottom =
        contentSize.height - (contentOffset.y + layoutMeasurement.height) <=
        BOTTOM_SLACK;
      // While anchored, a mid-load measurement says nothing about intent —
      // the list is still growing under a scroll the app itself performed.
      // Reading it as "the person scrolled away" is what put the jump
      // control on screen the moment a conversation opened.
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
        railForRef.current &&
        Math.abs(contentOffset.y - railScrollOrigin.current) >
          RAIL_DISMISS_SCROLL
      ) {
        setRailFor(null);
      }
    },
    [showJump, hasNew],
  );

  const onScrollBeginDrag = useCallback(() => {
    scrollWant.current = null;
    if (scrollRetryTimer.current) clearTimeout(scrollRetryTimer.current);
    // The person taking hold of the list is the ONLY thing that hands
    // control over. Everything before this — staged content loads, a
    // keyboard opening, the app's own scrollToEnd — leaves the thread
    // anchored to its newest message.
    anchoredToEnd.current = false;
    dragging.current = true;
  }, []);

  const onDragEnd = useCallback(() => {
    dragging.current = false;
  }, []);

  // The keyboard, the error strip and the jump bar all change the list's
  // height; re-anchor instead of pushing the newest message out of view.
  const onListLayout = useCallback(() => {
    if (atBottom.current && !railOpenRef.current && reactionDetailRef.current === null) {
      listRef.current?.scrollToEnd({ animated: false });
    }
  }, []);

  const onContentSizeChange = useCallback(() => {
    // An open rail is 92pt of content the person is reading: growing the list
    // must not yank it out from under them.
    if (railOpenRef.current || reactionDetailRef.current !== null) return;
    // The unread divider's one landing: the first resize that has it on
    // glass opens the thread THERE rather than at the end, and hands the
    // anchor over — from here the person reads down, and the jump bar offers
    // the newest. Skipped, and spent, if they already took hold of the list
    // before the divider arrived: their scroll wins.
    const divider = dividerIndexRef.current;
    if (divider >= 0 && !dividerScrolled.current) {
      dividerScrolled.current = true;
      if (anchoredToEnd.current) {
        anchoredToEnd.current = false;
        atBottom.current = false;
        setShowJump(true);
        setHasNew(true);
        scrollToRow(divider, 0, false);
        return;
      }
    }
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
  }, [scrollToRow]);

  const send = async () => {
    const review = secondOpinionReviewRef.current;
    if (review !== null) {
      if (secondOpinionSending.current) return;
      secondOpinionSending.current = true;
    }
    const releaseSecondOpinionSend = (): void => {
      if (review !== null) secondOpinionSending.current = false;
    };
    // Composing ends the moment the person taps send, success or failure —
    // before any await, so the stop precedes the message on the wire.
    typingSignaler.stop();
    const text = draft.trim();
    if (!text) {
      releaseSecondOpinionSend();
      return;
    }
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
      releaseSecondOpinionSend();
      return;
    }
    if (review !== null) {
      const selected = [...new Set(chips.map(chip => chip.id))];
      const generation = secondOpinionGeneration.current;
      let source: db.MessageRow | null = null;
      let eligible: string[] = [];
      try {
        [source, eligible] = await Promise.all([
          db.getMessage(review.sourceMsgId, 'in'),
          currentSecondOpinionTargetIds(peerId, review.sourceAuthorId),
        ]);
      } catch {
        // The same truthful result as a changed capability/consent fact: this
        // phone could not confirm the reviewed target, so nothing sends.
      }
      const stillHere =
        screenLive.current &&
        secondOpinionGeneration.current === generation &&
        peerIdRef.current === peerId &&
        secondOpinionReviewRef.current === review;
      if (!stillHere) {
        releaseSecondOpinionSend();
        return;
      }
      const now = Date.now();
      const sourceStillHere =
        source !== null &&
        source.peerId === peerId &&
        source.authorId === review.sourceAuthorId &&
        source.deletedAt == null &&
        (source.expiresAt == null || source.expiresAt > now) &&
        source.sharedBy == null;
      if (
        !sourceStillHere ||
        !selectedSecondOpinionTargetsAreCurrent(selected, eligible)
      ) {
        errorSeq.current += 1;
        setSendError({
          message: COPY.secondOpinionUnavailable,
          settings: false,
          seq: errorSeq.current,
        });
        releaseSecondOpinionSend();
        return;
      }
    }
    // Your own message is always worth following to.
    anchoredToEnd.current = true;
    // Captured before the composer is cleared: an edit that resolves after
    // the person has started typing something new must not act on the wrong
    // message, and the restore-on-failure path needs the original intent.
    const action = pending;
    if (action && !rowsRef.current.some(row =>
      row.msgId === action.row.msgId && row.direction === action.row.direction &&
      row.deletedAt == null && (row.expiresAt == null || row.expiresAt > Date.now())
    )) {
      cancelPending();
      releaseSecondOpinionSend();
      return;
    }
    setSavedMentionBinding(null);
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
      if (review !== null) {
        secondOpinionReviewRef.current = null;
        setSecondOpinionReview(null);
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
    } finally {
      releaseSecondOpinionSend();
    }
  };

  /** PICK IS NO LONGER SEND: the picker's result goes into the review
   * panel and nothing leaves this device until the person says so. A
   * cancelled pick leaves whatever was under review where it was. */
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
    setPhotoReview(reviewPicked(picked, source));
  };

  /** The decision to send. The failure path is the one that already
   * shipped: the bytes move to `failedPhoto`, where Try again finds them,
   * and the panel goes — two Sends for one photo is not a choice. */
  const sendReviewedPhoto = async () => {
    if (photoReview.kind !== 'review') return;
    const { picked } = photoReview;
    setPhotoReview(reviewSending(photoReview));
    setSendError(null);
    setSendingPhoto(true);
    try {
      await messaging.sendImage(
        peerId,
        picked.base64,
        picked.width,
        picked.height,
      );
      setPhotoReview(discardReview());
    } catch (err) {
      setPhotoReview(discardReview());
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
      const live = rowsRef.current.find(
        row =>
          row.msgId === target.msgId &&
          row.direction === target.direction &&
          row.deletedAt == null &&
          (row.expiresAt == null || row.expiresAt > Date.now()),
      );
      if (!live || blocked || peerBlocked || peerIdRef.current !== peerId) {
        setReactionDetail(null);
        return;
      }
      setRailFor(null);
      setReactionDetail(null);
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
    [peerId, blocked, peerBlocked, showError],
  );

  const toggleRail = useCallback(
    (row: db.MessageRow, index: number, intent: RailIntent = 'react') => {
      setReactionDetail(null);
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

  const openReactionDetail = useCallback(
    (row: db.MessageRow, emoji: string) => {
      if (blocked || peerBlocked) return;
      const live = rowsRef.current.some(
        current =>
          current.msgId === row.msgId &&
          current.direction === row.direction &&
          current.deletedAt == null &&
          (current.expiresAt == null || current.expiresAt > Date.now()),
      );
      if (!live) return;
      setRailFor(null);
      anchoredToEnd.current = false;
      atBottom.current = false;
      setReactionDetail({
        msgId: row.msgId,
        direction: row.direction,
        emoji,
      });
    },
    [blocked, peerBlocked],
  );
  const closeReactionDetail = useCallback(() => setReactionDetail(null), []);

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
      // Through messaging, not straight to the store: `refresh` repaints THIS
      // thread, and under the wide shell the chat list is live beside it and
      // repaints on messaging.notify() alone. A bare db.deleteMessage left
      // that row previewing the deleted words.
      quiet(messaging.deleteForMe(row.msgId, row.direction), refresh);
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
    [setPending, peerId, refresh, showError],
  );

  const startReply = useCallback((row: db.MessageRow) => {
    setRailFor(null);
    setPending({ kind: 'reply', row });
  }, [setPending]);

  /** Rewriting starts from the words that are already there — an edit that
   * makes you retype the message is a delete with extra steps. */
  const startEdit = useCallback((row: db.MessageRow) => {
    setRailFor(null);
    if (row.direction !== 'out') return;
    // Re-entering an edit must not overwrite the shelf with the previous
    // edit's text; only a genuine compose draft is worth keeping.
    if (pendingRef.current?.kind !== 'edit') {
      shelvedMentionBinding.current = savedMentionBindingRef.current;
      shelvedDraft.current = draftRef.current;
      shelvedChips.current = mentionChipsRef.current;
    }
    setSavedMentionBinding(null);
    setPending({ kind: 'edit', row });
    // A reply's body is its envelope; rewriting starts from the words, and
    // messaging puts the quote back around them.
    setDraft(displayText(row.body));
    // Chips belong to the shelved draft, not to somebody's sent words: kept,
    // they could coincidentally validate against the edit text and spring
    // the mention-in-reply refusal on a message that mentions nobody. They
    // return with the shelf in cancelPending.
    setMentionChips([]);
  }, [setDraft, setPending]);

  const cancelPending = useCallback(() => {
    // Read the ref rather than a state updater: an updater may be invoked
    // more than once, and the second pass would restore an already-emptied
    // shelf over the words it just gave back.
    if (pendingRef.current?.kind === 'edit') {
      setDraft(shelvedDraft.current);
      // The chips return WITH their words; liveMentionChips re-validates
      // them against the restored text before anything believes them.
      setMentionChips(shelvedChips.current);
      setSavedMentionBinding(shelvedMentionBinding.current);
      shelvedMentionBinding.current = null;
      shelvedDraft.current = '';
      shelvedChips.current = [];
    }
    setPending(null);
  }, [setDraft, setPending]);

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
          // Same funnel as Delete for me: the failed row leaving changes the
          // chat's line, and the live list hears about it only through
          // notify().
          await messaging.deleteForMe(row.msgId, 'out');
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
  /** The recorder is spoken for — a take in progress, one waiting to be sent,
   * or the permission dialog up. SYNCHRONOUS: re-derived on every render and
   * set eagerly by the tap itself, so a second tap inside one frame, or a mic
   * that outlived its gate, can never start a take over the one already
   * there. */
  const voiceBusyRef = useRef(false);
  voiceBusyRef.current = recording || recordingIntent || voiceDraft !== null;

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
  // the permission dialog — the slowest part — was unobserved.
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
    // A finished take is never overwritten, and a take never starts twice.
    if (voiceBusyRef.current) return;
    voiceBusyRef.current = true;
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
        // back would let Retry send a SECOND copy of the same note.
        // `enqueued` is set by
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
   * and a peer can lie about it ; the moment the decoder
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

  const writingEligible = appActive && draft.trim().length > 0 && draft.length <= AI_WRITING_INPUT_MAX &&
    pending?.kind !== 'edit' && !secondOpinionReview && photoReview.kind === 'none' &&
    !recording && !recordingIntent && voiceDraft === null;
  const writingEligibleRef = useRef(writingEligible);
  writingEligibleRef.current = writingEligible;
  const writingSnapshot = useCallback((): WritingDraftSnapshot => ({
    peerId: peerIdRef.current,
    text: draftRef.current,
    chips: liveMentionChips(draftRef.current, mentionChipsRef.current).map(chip => ({ ...chip })),
    pending: pendingRef.current
      ? `${pendingRef.current.kind}:${pendingRef.current.row.msgId}:${pendingRef.current.row.direction}`
      : null,
    revision: writingRevision.current,
    providerRevision: getWritingRevision(),
  }), []);
  const writingSourceCurrent = useCallback((source: WritingDraftSnapshot) =>
    screenLive.current && AppState.currentState === 'active' &&
    sameWritingDraft(source, writingSnapshot()) &&
    source.chips.every(chip => writingMentionNames.current.get(chip.id) === chip.name),
  [writingSnapshot]);
  const requestWriting = useCallback(async (
    action: AiWritingAction, signal: AbortSignal,
  ): Promise<AiWritingResult> => {
    if (!writingEligibleRef.current || drawerRef.current !== 'writing') {
      return { status: 'failed', reason: 'stale' };
    }
    writingAbort.current?.abort();
    writingCandidate.current = null;
    const controller = new AbortController();
    writingAbort.current = controller;
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort);
    if (signal.aborted) controller.abort();
    const source = writingSnapshot();
    const masked = maskWritingMentions(source.text, source.chips);
    try {
      if (!masked || !writingSourceCurrent(source)) return { status: 'failed', reason: 'stale' };
      const result = await generateWriting({ draft: masked.draft, action }, controller.signal);
      if (controller.signal.aborted || !writingSourceCurrent(source) || drawerRef.current !== 'writing') {
        return { status: 'failed', reason: 'stale' };
      }
      if (result.status === 'failed') return result;
      // A handoff prompt belongs on the clipboard/provider side of the UI. It
      // is never a candidate draft and can only return through the explicit
      // pasted-reply validation path below.
      if (result.status === 'handoff') return result;
      const restored = masked.restore(result.text);
      if (!restored) return { status: 'failed', reason: 'invalid_response' };
      writingCandidate.current = { source, result: restored };
      return { status: 'completed', text: restored.text };
    } finally {
      signal.removeEventListener('abort', abort);
      if (writingAbort.current === controller) writingAbort.current = null;
    }
  }, [writingSnapshot, writingSourceCurrent]);
  const reviewPastedWriting = useCallback((text: string): AiWritingResult => {
    if (!writingEligibleRef.current || drawerRef.current !== 'writing') {
      return { status: 'failed', reason: 'stale' };
    }
    writingCandidate.current = null;
    const source = writingSnapshot();
    const masked = maskWritingMentions(source.text, source.chips);
    if (!masked || !writingSourceCurrent(source)) {
      return { status: 'failed', reason: 'stale' };
    }
    const restored = masked.restore(text);
    if (!restored) return { status: 'failed', reason: 'invalid_response' };
    if (!writingSourceCurrent(source) || drawerRef.current !== 'writing') {
      return { status: 'failed', reason: 'stale' };
    }
    writingCandidate.current = { source, result: restored };
    return { status: 'completed', text: restored.text };
  }, [writingSnapshot, writingSourceCurrent]);
  const replaceWritingDraft = useCallback((text: string, chips: MentionChip[]) => {
    setDraft(text);
    draftRef.current = text;
    setMentionChips(chips);
    mentionChipsRef.current = chips;
    setSavedMentionBinding(null);
    setMentionCaret(null);
  }, [setDraft]);
  const useWriting = useCallback((text: string): boolean => {
    const candidate = writingCandidate.current;
    if (!candidate || !writingEligibleRef.current || candidate.result.text !== text || drawerRef.current !== 'writing' ||
      !writingSourceCurrent(candidate.source)) return false;
    replaceWritingDraft(text, candidate.result.chips);
    setDrawer('none');
    setWritingUndo({ before: candidate.source, after: writingSnapshot() });
    return true;
  }, [replaceWritingDraft, setDrawer, writingSnapshot, writingSourceCurrent]);
  const undoWriting = useCallback(() => {
    if (!writingUndo || !writingSourceCurrent(writingUndo.after)) {
      setWritingUndo(null);
      return;
    }
    replaceWritingDraft(writingUndo.before.text, writingUndo.before.chips);
  }, [writingUndo, writingSourceCurrent, replaceWritingDraft]);
  // Previews and Undo belong to this foreground visit, never to a later chat.
  useEffect(() => {
    retireWriting();
    const sub = AppState.addEventListener('change', next => {
      if (next !== 'active') {
        retireWriting();
        if (drawerRef.current === 'writing') setDrawer('none');
      }
    });
    return () => {
      sub.remove();
      writingAbort.current?.abort();
      writingCandidate.current = null;
    };
  }, [peerId, retireWriting, setDrawer]);

  const openDrawer = useCallback((next: Drawer) => {
    if (next === 'writing') {
      if (!writingEligibleRef.current) return;
      Keyboard.dismiss();
      setMentionCaret(null);
    }
    setDrawer(current => (current === next ? 'none' : next));
  }, [setDrawer]);

  /** The composer taking focus: the drawers close (the keyboard takes their
   * place) and so does an open reaction rail. The rail is revealed at the
   * BOTTOM of the viewport — exactly the edge the keyboard then covers — and
   * the re-anchor is deliberately skipped while a rail is open, so it sat
   * open off glass. The person has moved on to typing; a selection they
   * cannot see is not a selection. */
  const focusComposer = useCallback(() => {
    setDrawer('none');
    setRailFor(null);
  }, [setDrawer]);

  useEffect(() => {
    // ANDROID SYSTEM BACK closes what is open before it leaves the thread.
    // The router's handler (App.tsx) pops through `backDestination` on
    // every press; with nothing here to answer first, a person who had just
    // opened the call picker, the safety panel, a rail, a drawer or a reply
    // chip and pressed Back — the
    // reflex that dismisses an overlay in every Android app — was thrown
    // out of the conversation instead. RN asks the most recent subscriber
    // first and stops at the first `true`. The router subscribed ONCE, at
    // app mount (`goBack` has no dependencies, so its effect never re-runs);
    // this thread mounts in a later commit, so it is the newer subscriber
    // and is asked first. That is the whole ordering guarantee — a
    // dependency added to the router's `goBack` would re-subscribe it after
    // the thread and silently win every press again. Outermost first: the
    // picker and the panel hang under the header, the rail sits on a row,
    // the drawers and the chip are seamed to the composer. One thing per
    // press, the way each one's own ✕ works — the chip through
    // `cancelPending`, so an edit hands the shelved draft back. With
    // nothing open it yields (`false`) and the router pops as it always
    // did; the thread never navigates itself. Refs, not state: the handler
    // is registered once, and a press can land before a state has flushed.
    // On iOS `BackHandler` is inert (RegisterScreen's precedent).
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      // FIND IS THE OUTERMOST THING: it is not a panel under the header,
      // it IS the header while it is open. One case here rather than a
      // second handler, which would be asked first and win every press.
      if (findOpenRef.current) {
        closeFind();
        return true;
      }
      if (callPickerRef.current !== null) {
        setCallPicker(null);
        return true;
      }
      if (safetyOpenRef.current) {
        setSafetyOpen(false);
        return true;
      }
      if (reactionDetailRef.current !== null) {
        setReactionDetail(null);
        return true;
      }
      if (railForRef.current !== null) {
        setRailFor(null);
        return true;
      }
      // The photo waiting for a decision is the composer's own panel, so it
      // sits with the composer-seamed cases. Only while it is WAITING: once
      // the bytes are going, Back can no more call them back than the ✕
      // can, and hiding the panel would say otherwise — so that press falls
      // through to the router, exactly as it did before this panel existed.
      if (photoReviewRef.current.kind === 'review') {
        setPhotoReview(discardReview());
        return true;
      }
      if (drawerRef.current !== 'none') {
        setDrawer('none');
        return true;
      }
      if (pendingRef.current !== null) {
        cancelPending();
        return true;
      }
      return false;
    });
    return () => subscription.remove();
    // closeFind has no dependencies, so this stays a ONE-TIME registration:
    // the ordering guarantee above is that the thread subscribes after the
    // router and is asked first, and a re-subscription would lose it.
  }, [setDrawer, cancelPending, closeFind]);

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

  /** The list's header: one element identity per change of what it shows,
   * so a keystroke in the composer does not hand the list a new header to
   * reconcile. */
  const threadEmpty =
    rowsLoaded && approvalsLoaded && rows.length === 0 && approvals.length === 0;
  const meUserId = me?.userId;
  const meDisplayName = me?.displayName;
  const meAvatar = me?.avatarB64;
  const listHeader = useMemo(
    () => (
      <View>
        <RuledLabel
          label="End-to-end encrypted"
          minHeight={31}
          marginTop={8}
          marginBottom={12}
        />
        {threadEmpty ? (
          <View style={styles.emptyThread}>
            <QuietRoom
              {...(meUserId
                ? {
                    you: {
                      peerId: meUserId,
                      displayName: meDisplayName,
                      photoB64: meAvatar,
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
    ),
    [
      threadEmpty,
      meUserId,
      meDisplayName,
      meAvatar,
      peerId,
      chat?.localName,
      chat?.displayName,
      chat?.avatarB64,
      peerRef,
      named,
      name,
      t,
      styles,
    ],
  );

  const renderItem = useCallback(
    ({ item, index }: { item: ThreadItem; index: number }) => {
      const quoted = quotedFor(item);
      // The same `ofs` authorship boundary as quotedFor: an approval arrived
      // from the peer, so a ref claiming an outgoing message cannot use it.
      // A real message (including a tombstone) always retains precedence.
      const quotedApproval =
        !quoted &&
        item.envelope?.tcm === 'reply' &&
        item.envelope.ofs !== (item.row.direction === 'out')
          ? approvalsByWire.get(item.envelope.ref)
          : undefined;
      // "You", or my name for them: the quoted ROW's authorship, resolved as
      // every author label is — in a room the authenticated author, in a 1:1
      // the thread's peer — never anything the reply's envelope says.
      const quotedAuthor = quoted
        ? quoted.direction === 'out'
          ? 'You'
          : quoted.authorId
            ? nameFor(quoted.authorId)
            : name
        : quotedApproval
          ? name
          : undefined;
      const sourceAuthorId = item.row.authorId ?? null;
      const secondOpinionTargets = sourceAuthorId
        ? secondOpinionTargetsFor(sourceAuthorId)
        : [];
      const offerSecondOpinion =
        group !== null &&
        sourceAuthorId !== null &&
        roomMembers.includes(sourceAuthorId) &&
        item.row.direction === 'in' &&
        item.row.deletedAt == null &&
        item.row.sharedBy == null &&
        item.row.outsider !== 1 &&
        (item.row.ai === 1 || machinePeers.has(sourceAuthorId)) &&
        item.lastInGroup &&
        displayText(item.row.body).trim().length > 0 &&
        secondOpinionTargets.length > 0 &&
        secondOpinionReview === null &&
        draft.trim().length === 0 &&
        pending === null &&
        drawer === 'none' &&
        photoReview.kind === 'none' &&
        voiceDraft === null &&
        !recording &&
        !recordingIntent;
      return (
      <View>
        {item.newDay ? (
          <RuledLabel
            label={dayLabel(item.row.ts)}
            role="timeStatus"
            marginTop={16}
            marginBottom={8}
          />
        ) : null}
        {item.divider != null ? (
          // The unread divider: the date divider's ruled line, spoken as
          // one header so a screen reader can jump to where the new
          // messages start.
          <View
            testID="unread-divider"
            accessible
            accessibilityRole="header"
            accessibilityLabel={COPY.newMessages(item.divider)}
          >
            <RuledLabel
              label={COPY.newMessages(item.divider)}
              minHeight={31}
              marginTop={8}
              marginBottom={8}
            />
          </View>
        ) : item.round ? (
          // THE ROUND HEADER , on the unread divider's
          // ruled geometry and ahead of every bubble path for the approval
          // card's reason: a synthetic item must never reach MessageRow.
          // It says only how many agents answered — never that the relay
          // ordered, attributed or coordinated anything, because it did not.
          <View
            testID={roundHeaderTestID(item.round.anchorKey)}
            accessible
            accessibilityRole="header"
            accessibilityLabel={ROUND_COPY.header(item.round.n)}
          >
            <RuledLabel
              label={ROUND_COPY.header(item.round.n)}
              minHeight={31}
              marginTop={8}
              marginBottom={8}
            />
          </View>
        ) : item.approval ? (
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
        <>
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
          onOpenReaction={openReactionDetail}
          onOpenPhoto={openPhoto}
          onRetryPhoto={retryPhotoDownload}
          playingVoice={playingVoice}
          trueDurations={trueDurations}
          // The play head reaches ONLY the row whose note is playing; every
          // other row sees a constant 0 and its memo holds, so a 4 Hz
          // progress tick repaints one bubble, not every bubble on glass.
          voiceElapsed={
            playingVoice === `${item.row.msgId}:${item.row.direction}`
              ? voiceElapsed
              : 0
          }
          onToggleVoice={onToggleVoice}
          onRetrySend={onRetrySend}
          onRemove={removeRow}
          onRemoveEverywhere={removeEverywhere}
          onReply={startReply}
          onEdit={startEdit}
          quoted={quoted}
          quotedApproval={quotedApproval}
          quotedAuthor={quotedAuthor}
          // The full answer's open/closed state lives on the SCREEN, so it
          // survives this row's re-memo and the thread's next requery.
          expanded={expandedDetails.has(
            `${item.row.msgId}:${item.row.direction}`,
          )}
          onToggleDetail={onToggleDetail}
          onReveal={revealQuoted}
          onRevealApproval={revealQuotedApproval}
          flashed={flashKey === `${item.row.msgId}:${item.row.direction}`}
          overlay={overlays.get(item.row.msgId)}
        />
        {reactionDetail?.msgId === item.row.msgId &&
        reactionDetail.direction === item.row.direction &&
        !blocked && !peerBlocked && item.row.deletedAt == null &&
        (item.row.expiresAt == null || item.row.expiresAt > Date.now()) ? (() => {
          const selected = groupReactions(reactions.get(`${item.row.msgId}:${item.row.direction}`) ?? [])
            .find(entry => entry.emoji === reactionDetail.emoji);
          if (!selected) return null;
          return (
            <View style={{ alignItems: item.row.direction === 'out' ? 'flex-end' : 'flex-start' }}>
              <ReactionDetails
                msgId={item.row.msgId}
                emoji={selected.emoji}
                people={selected.reactions.map(reaction => ({
                  key: `${reaction.direction}:${reaction.reactorId}`,
                  label: reactionNameFor(reaction),
                }))}
                includesMine={selected.includesMine}
                disabled={blocked || peerBlocked}
                onClose={closeReactionDetail}
                onChange={() => toggleRail(item.row, index)}
                onRemove={() => {
                  const own = reactionsRef.current.get(`${item.row.msgId}:${item.row.direction}`)
                    ?.find(reaction => reaction.direction === 'out');
                  if (own?.emoji === selected.emoji) onReact(item.row, own.emoji);
                  else closeReactionDetail();
                }}
              />
            </View>
          );
        })() : null}

        {offerSecondOpinion ? (
          <View style={{ alignItems: 'flex-start', paddingLeft: t.space.s4 }}>
            <Pressable
              onPress={() => startSecondOpinion(item.row)}
              accessibilityRole="button"
              accessibilityLabel="Ask another agent for a second opinion on this answer"
              testID={`second-opinion-${item.row.msgId}`}
              style={({ pressed }) => [
                styles.textAction,
                { borderRadius: t.radius.button },
                pressed && { backgroundColor: t.color.pineWash },
              ]}
            >
              <Text style={[t.type.compactStrong, { color: t.color.pine }]}>
                Ask for a second opinion
              </Text>
            </Pressable>
          </View>
        ) : null}
        </>
        )}
      </View>
      );
    },
    [
      t,
      styles.textAction,
      name,
      revealQuoted,
      revealQuotedApproval,
      approvalsByWire,
      flashKey,
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
      reactionDetail,
      reactionNameFor,
      openReactionDetail,
      closeReactionDetail,
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
      expandedDetails,
      onToggleDetail,
      secondOpinionTargetsFor,
      roomMembers,
      machinePeers,
      secondOpinionReview,
      draft,
      pending,
      drawer,
      photoReview.kind,
      voiceDraft,
      recording,
      recordingIntent,
      startSecondOpinion,
    ],
  );

  return (
    <View
      style={[
        styles.root,
        { backgroundColor: t.color.paperGround, paddingBottom: keyboardInset },
      ]}
    >
      {/* FIND REPLACES THE HEADER, it does not stack under it: a second row
          of chrome over a back chevron, a name and three trailing targets is
          how a narrow window at an accessibility text size runs out of
          room. One thing at a time, so one row of chrome. */}
      {findOpen ? (
        <FindBar
          copy={COPY}
          value={findQuery}
          onChange={setFindQuery}
          onClose={closeFind}
          onNext={() =>
            setFindCursor(c => stepFindCursor(c, findMatches.length, 1))
          }
          onPrevious={() =>
            setFindCursor(c => stepFindCursor(c, findMatches.length, -1))
          }
          cursor={findCursor}
          total={findMatches.length}
          ready={findQueryReady(findQuery)}
          settled={findAnswered === findQuery.trim()}
        />
      ) : (
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
            {/* FIND COMES FIRST, before the call glyphs: the call buttons
                keep the outermost corner they have always had, so nothing a
                person already knows moves. The glyph does not scale (the
                back chevron's reason: scaling an icon only breaks its 44pt
                target), which is what keeps three trailing targets from
                clipping — the title compresses, the controls do not. */}
            <Pressable
              onPress={openFind}
              accessibilityRole="button"
              accessibilityLabel={COPY.find}
              testID="thread-find"
              style={({ pressed }) => [
                styles.safetyControl,
                { borderRadius: t.radius.circle },
                pressed && { backgroundColor: t.color.pineWash },
              ]}
            >
              <FindGlyph color={t.color.pine} />
            </Pressable>
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
                  // A ROOM OFFERS AUDIO ONLY. Group calls support audio, so a
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
      )}

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
        keyExtractor={threadKey}
        onScroll={onScroll}
        onViewableItemsChanged={onViewableItemsChanged}
        viewabilityConfig={viewabilityConfig}
        onScrollBeginDrag={onScrollBeginDrag}
        onScrollEndDrag={onDragEnd}
        onMomentumScrollEnd={onDragEnd}
        scrollEventThrottle={16}
        // Without this the first tap on any message with the keyboard up is
        // swallowed by the dismissal; interactive restores the standard iOS
        // drag-down-to-dismiss the thread had no way to do at all.
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        onScrollToIndexFailed={onScrollToIndexFailed}
        initialNumToRender={20}
        maxToRenderPerBatch={12}
        updateCellsBatchingPeriod={50}
        windowSize={9}
        ListHeaderComponent={listHeader}
        renderItem={renderItem}
        contentContainerStyle={styles.listContent}
        onContentSizeChange={onContentSizeChange}
        onLayout={onListLayout}
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
      <View style={{ flexDirection: 'row' }}>
      {dividerIndexRef.current >= 0 && !dividerVisible && railFor === null && reactionDetail === null ? (
        <Pressable
          onPress={jumpToFirstNew}
          accessibilityRole="button"
          accessibilityLabel="Return to the first new message"
          testID="jump-first-new"
          style={({ pressed }) => [styles.jumpRow, {
            flex: 1,
            backgroundColor: pressed ? t.color.pineWash : t.color.paperLayer,
            borderTopWidth: t.hairline,
            borderTopColor: t.color.lineSoft,
            paddingHorizontal: t.layout.gutter,
          }]}
        >
          <Text style={[t.type.compactStrong, { color: t.color.pine }]}>First new</Text>
        </Pressable>
      ) : null}
      {showJump && railFor === null && reactionDetail === null ? (
        <Pressable
          onPress={jumpToLatest}
          accessibilityRole="button"
          accessibilityLabel="Jump to the newest message"
          testID="jump-latest"
          style={({ pressed }) => [
            styles.jumpRow,
            {
              flex: 1,
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
      </View>

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
      ) : photoReview.kind !== 'none' ? (
        /* Review a picked photo in the composer's place, alongside the existing
           voice-draft interaction. Keep the decision in the conversation
           rather than opening a modal. */
        <View
          testID="photo-review"
          style={[
            styles.voiceBar,
            { flexDirection: 'column', alignItems: 'stretch', gap: t.space.s4 },
          ]}
        >
          <Image
            source={{
              uri: `data:image/jpeg;base64,${photoReview.picked.base64}`,
            }}
            // A CEILING, not a height: the photo's own shape decides how
            // tall it draws under it, so a wide, short picture gives the
            // space back to the size line and the two controls — which is
            // why 200 was chosen over the bubble's 320 in the first place.
            style={{
              width: '100%',
              maxHeight: PHOTO_REVIEW_MAX_HEIGHT,
              aspectRatio: photoAspect(photoReview.picked),
              borderRadius: t.radius.bubble,
              backgroundColor: t.color.paperSheet,
            }}
            // `contain`, not `cover`: this is the picture being checked, so
            // it must not be cropped to fit the frame doing the checking.
            resizeMode="contain"
            accessible
            accessibilityRole="image"
            accessibilityLabel={COPY.photoReviewImage}
            testID="photo-review-image"
          />
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: t.space.s5,
            }}
          >
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={[t.type.compactStrong, { color: t.color.inkStrong }]}>
                {COPY.photoReview}
              </Text>
              {/* The size it will ARRIVE at: the picker re-encoded the
                  original, so the base64 on hand is the honest number. */}
              <Text style={[t.type.timeStatus, { color: t.color.inkMuted }]}>
                {COPY.photoSize(photoKilobytes(photoReview.picked.base64))}
              </Text>
            </View>
            {/* Guarded like Send, and for a stronger reason: a send already
                in flight cannot be called back, so a ✕ that dropped the
                panel would stop nothing and the photo would arrive anyway.
                The refusal is in the state machine as well as the control. */}
            <Pressable
              onPress={() => setPhotoReview(discardUnlessSending)}
              disabled={photoReview.kind === 'sending'}
              accessibilityRole="button"
              accessibilityLabel={COPY.photoDiscard}
              accessibilityState={{ disabled: photoReview.kind === 'sending' }}
              testID="photo-review-discard"
              style={styles.composerIcon}
            >
              <CloseGlyph
                size={20}
                color={
                  photoReview.kind === 'sending'
                    ? t.color.inkMuted
                    : t.color.danger
                }
              />
            </Pressable>
            {offersRetake(photoReview) ? (
              <TextAction
                label={COPY.photoRetake}
                onPress={() => void attachPhoto('camera')}
                testID="photo-review-retake"
              />
            ) : null}
            {/* A send already under way is not started twice; the state
                machine refuses it too, and the control says so. */}
            <TextAction
              label={COPY.photoSend}
              onPress={() => void sendReviewedPhoto()}
              disabled={photoReview.kind === 'sending'}
              testID="photo-review-send"
            />
          </View>
        </View>
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
          writing={{
            offered: writingEligible,
            undo: writingUndo && sameWritingDraft(writingUndo.after, writingSnapshot()) ? undoWriting : null,
            panel: drawer === 'writing' && writingEligible ? (
              <WritingAssistant
                sourceKey={JSON.stringify([peerId, writingRevision.current, draft, liveChips, pending?.kind, pending?.row.msgId])}
                onRequest={requestWriting}
                onReview={reviewPastedWriting}
                onUse={useWriting}
                onClose={() => setDrawer('none')}
              />
            ) : null,
          }}
          onChangeDraft={changeDraft}
          onSelectionChange={changeSelection}
          mention={{
            choices: mentionChoices,
            chips: liveChips,
            onPick: pickMention,
            onRemoveChip: removeMention,
          }}
          secondOpinion={
            secondOpinionReview
              ? {
                  room: roomName ?? 'This room',
                  agents: liveChips.map(chip => chip.name),
                  onCancel: cancelSecondOpinion,
                }
              : null
          }
          onOpenDrawer={openDrawer}
          onFocusInput={focusComposer}
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
  const styles = stylesFor(t);
  const [confirming, setConfirming] = useState(false);
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
          </View>
        )}

        {/* Teaching copy behind the house ⓘ, as ApprovalCard and the
            account screens do it — this
            was a bare "What this is" button that unfolded the same lines. */}
        <View style={styles.safetyAbout}>
          <InfoDisclosure
            label="What this is"
            lines={SAFETY_EXPLAINER}
            testID="safety-explain"
          />
        </View>
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
  const styles = stylesFor(t);
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
  const styles = stylesFor(t);
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
  writing,
  onChangeDraft,
  onSelectionChange,
  mention,
  secondOpinion,
  onOpenDrawer,
  onFocusInput,
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
  writing: { offered: boolean; panel: React.ReactNode; undo: (() => void) | null };
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
  /** A reviewed second-opinion request. Its full context is the editable
   * draft below; this header names the room and selected recipients. */
  secondOpinion: {
    room: string;
    agents: string[];
    onCancel: () => void;
  } | null;
  onOpenDrawer: (d: Drawer) => void;
  /** The input taking (or being pressed into while holding) focus: the
   * parent closes whatever the keyboard is about to cover. */
  onFocusInput: () => void;
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
  const styles = stylesFor(t);
  const canSend = draft.trim().length > 0;
  // The chip is attached to the composer exactly like a drawer, so it flattens
  // the same seam: two stacked slabs with rounded corners between them would
  // read as floating cards. The mention PICKER is such a slab and joins it;
  // the mention chip strip is bare pills on the ground, so it does not — a
  // squared corner under nothing solid reads as a glitch.
  const open =
    drawer !== 'none' ||
    chip !== null ||
    secondOpinion !== null ||
    mention.choices.length > 0;
  // A ref, not state: the input stays uncontrolled with respect to selection,
  // so a programmatic cursor can never fight the person typing.
  const selection = useRef({ start: 0, end: 0 });

  // The chip speaks when it appears or changes: "Replying to Dawit. dinner
  // at eight?" — who, then what, the bubble's own order. Keyed on the chip's
  // WORDS, not the object: the parent builds a fresh chip each render, and a
  // keystroke must not read the chip out again. Queued, so it lands after
  // the rail's own dismissal rather than cutting it off.
  const chipLabel = chip?.label ?? null;
  const chipText = chip?.text ?? null;
  useEffect(() => {
    if (chipLabel === null) return;
    AccessibilityInfo.announceForAccessibilityWithOptions(
      chipText ? `${chipLabel}. ${chipText}` : chipLabel,
      { queue: true },
    );
  }, [chipLabel, chipText]);

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
      {writing.panel}
      {(writing.offered && drawer !== 'writing') || writing.undo ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', alignItems: 'center', gap: 8 }}>
          {writing.undo ? (
            <Pressable
              testID="composer-writing-undo"
              accessibilityRole="button"
              accessibilityLabel="Undo writing suggestion"
              onPress={writing.undo}
              style={{ minHeight: t.layout.touchTarget, justifyContent: 'center', paddingHorizontal: 12 }}
            >
              <Text style={[t.type.compactBody, { color: t.color.inkMuted }]}>Undo</Text>
            </Pressable>
          ) : null}
          {writing.offered && drawer !== 'writing' ? (
            <Pressable
              testID="composer-writing"
              accessibilityRole="button"
              accessibilityLabel="Improve draft"
              accessibilityHint="Opens writing and translation options"
              onPress={() => onOpenDrawer('writing')}
              style={{ minHeight: t.layout.touchTarget, justifyContent: 'center', paddingHorizontal: 12 }}
            >
              <Text style={[t.type.compactStrong, { color: t.color.pine }]}>Improve</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      {secondOpinion ? (
        <View
          testID="second-opinion-review"
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
            <Text style={[t.type.compactStrong, { color: t.color.inkStrong }]}>
              Second opinion draft
            </Text>
            <Text style={[t.type.timeStatus, { color: t.color.inkMuted }]}>
              {`Room · ${secondOpinion.room}`}
            </Text>
            <Text style={[t.type.timeStatus, { color: t.color.inkMuted }]}>
              {secondOpinion.agents.length === 0
                ? 'Selected agent · None'
                : `Selected agent${
                    secondOpinion.agents.length === 1 ? '' : 's'
                  } · ${namesInSentence(secondOpinion.agents)}`}
            </Text>
            <Text style={[t.type.compactBody, { color: t.color.inkBody }]}>
              Edit the request below. Send confirms it.
            </Text>
            <Text style={[t.type.timeStatus, { color: t.color.inkMuted }]}>
              {`Rounds must be enabled on the selected agent${
                secondOpinion.agents.length === 1 ? '’s computer' : 's’ computers'
              }. This app cannot confirm that setting.`}
            </Text>
          </View>
          <Pressable
            onPress={secondOpinion.onCancel}
            accessibilityRole="button"
            accessibilityLabel="Cancel second opinion draft"
            testID="second-opinion-cancel"
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            style={({ pressed }) => [
              styles.chipCancel,
              {
                borderRadius: t.radius.circle,
                backgroundColor: pressed ? t.color.pineWash : 'transparent',
              },
            ]}
          >
            <CloseGlyph size={16} color={t.color.inkMuted} />
          </Pressable>
        </View>
      ) : null}
      {/* What this message is about to do to another one, attached to the
          composer so the answer and the thing answered stay together. */}
      {chip ? (
        <View
          testID="composer-chip"
          // TalkBack reads a change to this region in place; VoiceOver has
          // no live regions, so the effect above speaks the chip outright.
          accessibilityLiveRegion="polite"
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
            <Text style={[t.type.compactStrong, { color: t.color.inkStrong }]}>
              {chip.label}
            </Text>
            <Text
              numberOfLines={2}
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
            <CloseGlyph size={16} color={t.color.inkMuted} />
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
          {/* The promises the icons could be read as making — a photo taken
              here never reaches the camera roll, a location is read only on
              the tap — behind the house ⓘ
              rather than printed under the grid on every open. */}
          <View style={styles.drawerAbout}>
            <InfoDisclosure
              label="About attachments"
              lines={ATTACH_ABOUT}
              testID="attach-about"
            />
          </View>
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
          accessibilityLabel={COPY.attach}
          accessibilityHint={COPY.attachHint}
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
          // The system keyboard follows the palette: with nothing said here
          // iOS raised a light keyboard over the dark thread. `scheme` is
          // the token set's own name for itself — the one place a platform
          // appearance must be named.
          keyboardAppearance={t.scheme}
          selectionColor={t.color.pine}
          value={draft}
          onChangeText={onChangeDraft}
          onSelectionChange={e => {
            selection.current = e.nativeEvent.selection;
            onSelectionChange(e.nativeEvent.selection);
          }}
          onFocus={onFocusInput}
          // Pressing into an already-focused field fires no onFocus, so a
          // drawer would sit open occupying the keyboard's place.
          onPressIn={onFocusInput}
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
            a reply chip means the person is mid-sentence, not mid-thought —
            AND the recorder is free: while a take is in progress or waiting
            in the bar above, a live mic here would start a second take over
            it. */}
        {!canSend && !chip && !voice.recording && !voice.hasDraft ? (
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
  const styles = stylesFor(t);
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
  onOpenReaction: (row: db.MessageRow, emoji: string) => void;
  onOpenPhoto: (row: db.MessageRow) => void;
  onRetryPhoto: (row: db.MessageRow) => void;
  /** `${msgId}:${direction}` of the note currently playing, or null. */
  playingVoice: string | null;
  /** Decoded lengths that disagreed with a sender's claim. */
  trueDurations: Map<string, number>;
  /** Play head of THIS row's note while it is the one playing, in seconds;
   * 0 for every other row. */
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
  /** An incoming approval request, when no message matches this reply. */
  quotedApproval: ApprovalQuote | undefined;
  /** Who wrote the quoted message or request, resolved from its stored
   * authorship — "You", or my name for them. */
  quotedAuthor: string | undefined;
  /** This row's FULL ANSWER is open . Screen-held, so a
   * requery cannot close it. Always false for a row with no detail. */
  expanded: boolean;
  /** Open or close this row's full answer. */
  onToggleDetail: (row: db.MessageRow) => void;
  /** Tapping the quote: scroll to and flash the quoted row. */
  onReveal: (row: db.MessageRow) => void;
  onRevealApproval: (approval: ApprovalQuote) => void;
  /** This row was just revealed by a tapped quote: wash it pine. */
  flashed: boolean;
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
    a.onOpenReaction !== b.onOpenReaction ||
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
    a.quoted?.deletedAt !== b.quoted?.deletedAt ||
    a.quotedApproval?.peerId !== b.quotedApproval?.peerId ||
    a.quotedApproval?.q !== b.quotedApproval?.q ||
    a.quotedApproval?.kind !== b.quotedApproval?.kind ||
    a.quotedAuthor !== b.quotedAuthor ||
    a.onReveal !== b.onReveal ||
    a.onRevealApproval !== b.onRevealApproval ||
    a.flashed !== b.flashed ||
    // Without these two the memo goes stale and the disclosure does not open
    //  — the defect this comparator's own header warns
    // about. The detail's CONTENT is free: `x.row.body` is already compared
    // below, and the detail rides in the body.
    a.expanded !== b.expanded ||
    a.onToggleDetail !== b.onToggleDetail
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
    if (p[i].direction !== q[i].direction || p[i].emoji !== q[i].emoji ||
      p[i].reactorId !== q[i].reactorId || p[i].ts !== q[i].ts) {
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
const MessageRow = memo(function MessageRowWithProvenance(
  props: MessageRowProps,
) {
  const { row } = props.item;
  const inner = <MessageRowInner {...props} />;
  // Outgoing rows are never relayed to me: `sharedBy` marks what SOMEONE ELSE
  // handed me, and my own sends are first-hand by construction.
  if (!row.sharedBy || row.direction === 'out') return inner;
  const t = props.theme;
  const styles = stylesFor(t);
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
  onOpenReaction,
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
  quotedApproval,
  quotedAuthor,
  expanded,
  onToggleDetail,
  onReveal,
  onRevealApproval,
  flashed,
  overlay,
}: MessageRowProps) {
  const styles = stylesFor(t);
  const { row, envelope } = item;
  const out = row.direction === 'out';
  const revealQuote =
    quoted && !quoted.deletedAt
      ? () => onReveal(quoted)
      : quotedApproval
        ? () => onRevealApproval(quotedApproval)
        : undefined;
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
   *
   * The RULE itself lives in `aiSenderOf` above, because the round pass asks
   * the same question of the same row and a round must not become a third
   * source of this signal .
   */
  const aiSender = aiSenderOf(row, { inRoom, isAgentId, peerIsAgent });

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
          marginTop: item.newDay
            ? 0
            : item.firstInGroup
              ? t.space.s5
              : t.space.s2,
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
  /** A gesture, not a sentence: plain words that are one to three emoji
   * draw at display size with no bubble. Plain words ONLY — a reply keeps
   * its quote box, a mention its marks, a streamed overlay its cursor, and
   * each of those needs the surface. */
  const jumbo =
    envelope === null && overlay === undefined && isEmojiOnly(displayText(row.body));
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

  /**
   * The addresses in this row's words. The bubble is one
   * accessible element, which flattens the nested link's own `onPress` out
   * of the tree — exactly the reason the quote needs an action of its own.
   * Without a matching one per address a screen-reader user could hear the
   * link read out and had no way to open it. Taken from `spokenWords`, so a
   * mention row's names are already resolved and nothing is parsed twice. */
  const bodyLinks = isStructured
    ? []
    : linkRuns(spokenWords).flatMap(run => (run.kind === 'link' ? [run] : []));

  /**
   * THE FULL ANSWER carried by this row, or null . Read
   * through envelope.ts's `detailText` — the one reader — so the brief on
   * glass and the detail behind the tap can never disagree about what a body
   * is. Structured rows are excluded outright: a photo, voice note, file or
   * location has no words to stand above a disclosure.
   */
  const detail = isStructured ? null : detailText(row.body);
  /**
   * Reading the full answer is not an outbound act, so it survives
   * `interactionsOff` — which withdraws the rail, the reaction chips, the
   * retry and the reply arrow, every one of them a way to SEND something.
   * A blocked or unreviewed peer's message is still a message to read.
   */
  const detailAction =
    detail === null
      ? []
      : [
          {
            name: 'detail',
            label: expanded ? ROUND_COPY.hideDetail : ROUND_COPY.showDetail,
          },
        ];

  const a11yActions = interactionsOff
    ? detailAction.length > 0
      ? detailAction
      : undefined
    : [
        // React works in rooms too: sendReaction fans the same carrier to
        // every member, addressed by the row's own the design key.
        { name: 'react', label: 'React' },
        ...(isStructured ? [] : [{ name: 'copy', label: 'Copy' }]),
        // One per address, for the same reason the quote gets one below.
        ...bodyLinks.map((run, i) => ({
          name: `link:${i}`,
          label: `Open ${run.text}`,
        })),
        // The bubble is ONE element to a screen reader, so the quote's own
        // tap is not reachable that way; the rotor offers it instead.
        ...(revealQuote
          ? [{ name: 'reveal', label: 'Go to the quoted message' }]
          : []),
        // The bubble is ONE element, so the disclosure's own tap is not
        // reachable through VoiceOver either — the same reason the quote
        // gets an action, and the same remedy. The label comes from
        // ROUND_COPY, never a re-typed literal.
        ...detailAction,
        { name: 'delete', label: 'Delete for me' },
      ];
  const onA11yAction = (name: string) => {
    if (name === 'react') onLongPress(row, index);
    if (name === 'detail' && detail !== null) onToggleDetail(row);
    if (name === 'reveal') revealQuote?.();
    if (name.startsWith('link:')) {
      const link = bodyLinks[Number(name.slice('link:'.length))];
      // Same rejection discipline as the tap: a scheme this device cannot
      // open is not an error the person can act on from a bubble.
      if (link) void Linking.openURL(link.url).catch(() => undefined);
    }
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
          // No surface under jumbo emoji: the glyphs are the message. The
          // press wash survives, so a long-press still shows it took.
          jumbo && {
            backgroundColor: pressed ? t.color.pineWash : 'transparent',
            borderColor: 'transparent',
          },
          // The row a tapped quote just led here: a pine wash for a
          // moment, so the eye finds it after the scroll.
          flashed && { backgroundColor: t.color.pineWash },
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
              // The quote goes to the message it quotes when tapped — the
              // messenger convention. Inert when the original is gone: there
              // is nowhere to go, and a button that does nothing is worse
              // than a box.
              <Pressable
                testID={`quote-${row.msgId}`}
                onPress={revealQuote}
                disabled={!revealQuote}
                accessibilityRole={revealQuote ? 'button' : undefined}
                accessibilityLabel={
                  revealQuote && quotedAuthor
                    ? `Go to the quoted message from ${quotedAuthor}`
                    : undefined
                }
                style={[
                  styles.quote,
                  {
                    borderRadius: t.radius.small,
                    backgroundColor: out
                      ? t.color.bubbleOutPressed
                      : t.color.paperLayer,
                    borderLeftColor: out ? t.color.onBubbleOut : t.color.pine,
                  },
                ]}
              >
                {quotedAuthor ? (
                  // Who is being answered, over their words: resolved by the
                  // parent from the quoted ROW's authorship, never from the
                  // reply's envelope — a peer cannot name the author.
                  <Text
                    testID={`quote-author-${row.msgId}`}
                    numberOfLines={1}
                    style={[
                      t.type.compactStrong,
                      styles.quoteAuthor,
                      { color: out ? t.color.onBubbleOut : t.color.pine },
                    ]}
                  >
                    {quotedAuthor}
                  </Text>
                ) : null}
                <Text
                  numberOfLines={1}
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
                    : quotedApproval
                      ? APPROVAL_KIND_COPY[quotedApproval.kind]
                      : COPY.quoteMissing}
                </Text>
              </Pressable>
            ) : null}
            <Text
              style={[
                jumbo ? t.type.display : t.type.message,
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
                      linkedText(
                        segment.text,
                        out ? t.color.onBubbleOut : t.color.pine,
                        `l-${row.msgId}-${i}`,
                        t,
                      )
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
                  : linkedText(
                      displayText(row.body),
                      out ? t.color.onBubbleOut : t.color.pine,
                      `l-${row.msgId}`,
                      t,
                    )}
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
                  {
                    // Same switch as the tick below: on the transparent
                    // jumbo surface the on-pine ink is near-white on an
                    // off-white ground, so a jumbo row takes the paper
                    // ink.
                    color:
                      out && !jumbo ? t.color.onBubbleOut : t.color.inkMuted,
                  },
                ]}
              >
                {COPY.edited}
              </Text>
            ) : null}
            {detail !== null ? (
              // THE FULL ANSWER, inside the bubble and UNDER the words
              // : the brief and the detail are one message
              // written by one model under one sender, so the disclosure
              // belongs to the bubble rather than beside it. Visible by
              // default is the BRIEF; only the detail is collapsed.
              <DetailDisclosure
                detail={detail}
                expanded={expanded}
                onToggle={() => onToggleDetail(row)}
                out={out}
                msgId={row.msgId}
              />
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
                convention gets from turning blue.

                A JUMBO row has no pine under it: the surface went
                transparent, so the on-pine pair would be near-white on the
                off-white thread ground, and the read tick invisible in both
                themes. It takes the same paper pair the photo status below
                already uses, for the same reason. */}
            <TickGlyph
              status={tickStatusOf(row.status)}
              color={jumbo ? t.color.inkMuted : t.color.onBubbleOut}
              readColor={jumbo ? t.color.pine : t.color.onPine}
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
          // The 28pt disc stays quiet while its touch target reaches 44pt.
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          style={({ pressed }) => [
            styles.replyArrow,
            {
              borderRadius: t.radius.circle,
              backgroundColor: pressed ? t.color.pineWash : t.color.paperLayer,
            },
          ]}
        >
          <ReplyGlyph size={15} color={t.color.inkMuted} />
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
            status={tickStatusOf(row.status)}
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
          {groupReactions(reactions).map(group => {
            const word = REACTION_WORD[group.emoji] ?? group.emoji;
            const label = `${word.charAt(0).toUpperCase()}${word.slice(1)}, ${group.count} ${group.count === 1 ? 'reaction' : 'reactions'}${group.includesMine ? ', including you' : ''}. Show who reacted`;
            return (
              <Pressable
                key={group.emoji}
                onPress={interactionsOff ? undefined : () => onOpenReaction(row, group.emoji)}
                disabled={interactionsOff}
                accessibilityRole="button"
                accessibilityLabel={label}
                accessibilityState={{ disabled: interactionsOff }}
                testID={`reaction-group-${row.msgId}-${group.emoji}`}
                style={[
                  styles.reactionChip,
                  {
                    borderRadius: t.radius.small,
                    backgroundColor: group.includesMine ? t.color.pineWash : t.color.paperSheet,
                    borderColor: group.includesMine ? t.color.pineLine : t.color.lineSoft,
                  },
                ]}
              >
                <Text style={t.type.compactBody}>{group.emoji}</Text>
                <Text style={[t.type.compactStrong, { color: t.color.inkBody }]}>{group.count}</Text>
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
            styles.messageClock,
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
  const styles = stylesFor(t);
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
      {/* Free to wrap: clamped to one line, "Delete this message?" ellipsised
          at large text sizes. The strip
          wraps too, so at those sizes the buttons take a line of their own
          under the question instead of squeezing it. */}
      <Text
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
            style={styles.actionButton}
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
              style={styles.actionButton}
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
            style={styles.actionButton}
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
            style={styles.actionButton}
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
              style={styles.actionButton}
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
              style={styles.actionButton}
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
            style={styles.actionButton}
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
  const styles = stylesFor(t);
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
