import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  AccessibilityInfo,
  BackHandler,
  // Deprecated in core but still shipped (the StartChatScreen trade): a
  // paste target is the whole point of an id.
  Clipboard,
  FlatList,
  Linking,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { BLOCK_COPY as BLOCK } from '../blocking';
import { getSecret, setSecret } from 'tacendum-crypto';
import * as db from '../db';
import * as lock from '../lock';
import { DEVICE_NOUN } from '../deviceNoun';
import { parseEnvelope, previewFor } from '../envelope';
import { messaging } from '../messaging';
import { session } from '../session';
import { isNamingSettled, namingNudgeDue, skipNaming } from '../naming';
import { NAMING_COPY } from '../namingCopy';
import { shareIdMessage } from '../peerId';
import {
  dismissSoftUpdate,
  isSoftUpdateDismissed,
  storeUrl,
  updateGate,
} from '../updateGate';
import { UPDATE_COPY } from '../updateGateCopy';
import {
  personName,
  sanitizeDisplayName,
  spokenPersonName,
} from '../person';
import { FIELD_MODE_COPY } from '../fieldModeCopy';
import { useFieldModeActive } from '../useFieldModeActive';
import { useTheme } from '../theme';
import { timeLabel } from '../time';
import { Avatar } from '../ui/Avatar';
import { InfoDisclosure } from '../ui/InfoDisclosure';
import {
  HomeHeader,
  InlineError,
  InlineNotice,
  OutlineButton,
  TextAction,
} from '../ui/primitives';
import { QuietRoom } from '../ui/QuietRoom';
import { RoomMark } from '../ui/RoomMark';
import { shareWithAnchor, type ShareAnchor } from '../ui/shareWithAnchor';
import { useCoalescedSubscribe } from '../ui/useCoalescedSubscribe';

interface Props {
  profile: db.ProfileRow;
  /** The conversation the wide shell's DETAIL pane has open beside this
   * list: that row wears the selected wash and says
   * so to assistive tech. Undefined whenever no detail is open — including
   * always in compact, where the list is never beside its thread. */
  selectedPeerId?: string;
  onOpenChat: (peerId: string) => void;
  onOpenProfile: () => void;
  /** The + control: reaching someone new lives on its own surface. */
  onStartChat: () => void;
  /** The App Lock nudge's route in: Settings, where the lock lives.
   * Optional — without it the nudge still shows and still says where, it
   * just offers no button that would claim a route it lacks. */
  onOpenAppLock?: () => void;
  /** A room is made FROM people already here, so its entry lives with the
   * list rather than behind the + (which reaches someone new). */
  onStartRoom: () => void;
  /** Settings, for the Field Mode line under the title. Optional
   * for the same reason `onOpenAppLock` is: without it the line still says
   * the true thing, it just offers no control that would claim a route this
   * screen was not given. The host passes
   * `onOpenSettings={() => setRoute({ name: 'settings', from: 'chats' })}`,
   * and `from` is what brings the person back here afterwards. */
  onOpenSettings?: () => void;
  /** The durable approvals/work inbox. Kept outside the chat rows so the
   * door remains present when an approval is the first thing a peer sends. */
  onOpenAttention?: () => void;
}

const COPY = {
  title: 'Rooms',
  profileAction: 'Open your profile',

  startTitle: 'Open a room',
  // The share text itself is `shareIdMessage` (peerId.ts): one helper, so
  // every surface sends the id on a line of its own.

  listLabel: 'Your rooms',
  filterLabel: 'Filter rooms',
  noMatch: 'No room matches that.',
  previewNone: 'No messages yet',
  previewUnreadable: 'Message couldn’t be opened',
  unread: (label: string, preview: string) =>
    `${label}, new messages, ${preview}`,
  /** A room mentioned YOU (the mentions contract). The @ mark is visual
   * only, so the fact travels in the label — the same rule the room word
   * follows. */
  unreadMention: (label: string, preview: string) =>
    `${label}, new messages, you were mentioned, ${preview}`,

  rowActions: 'Room actions',

  // The two reversible row actions (tablestakes-8). Both are local, neither
  // is ever sent, and neither names a device.
  pin: 'Pin to the top',
  unpin: 'Unpin',
  /** The pinned mark is a glyph in a 12pt gutter, so the WORD travels in the
   * row's label — two channels, never the glyph alone. */
  pinnedSpoken: (label: string) => `${label}, pinned`,
  markUnread: 'Mark unread',
  markedUnread: 'Marked unread.',
  /** The preview slot's prefix when there is something unsent here. Pine
   * carries it visually; `draftSpoken` carries it for everyone else. */
  draftPrefix: 'Draft',
  draftSpoken: (label: string, text: string) => `${label}, draft, ${text}`,

  deleteChat: 'Delete room',
  // The device is named in the
  // platform's own words via the token, here and in the room copy below.
  deleteConfirm: `Delete this room? The messages are only on this ${DEVICE_NOUN} — Tacendum has no copy to restore.`,
  /**
   * Deleting a conversation also deletes its 1:1 call log. State that
   * consequence explicitly so a user does not expect calls to remain in
   * Calls after their messages are erased. Keep it separate from the
   * existing message-loss sentence and avoid an additional device noun.
   */
  deleteAlsoCalls: 'Your calls with them go too.',
  keep: 'Keep',
  delete: 'Delete',
  deleted: 'Room deleted.',
  deleteFailed: 'Tacendum couldn’t delete this room. Try again.',

  // Rooms. Deleting a room is LOCAL — the
  // room lives on for its other members — and the recreate rule is said
  // rather than hidden: the copy must not imply more was removed
  // than was.
  newRoom: 'New group',
  roomFallbackName: 'Group',
  deleteRoom: 'Delete room',
  roomDeleteConfirm:
    `Delete this room from this ${DEVICE_NOUN}? Its messages here are only on this ` +
    `${DEVICE_NOUN} — Tacendum has no copy to restore. The other members keep ` +
    'theirs, and while the room stays active with you in it, it can return.',
  /** The room's own second line. "here" rather than a device noun, and
   * "The room's calls" rather than "your calls": a room-call leg belongs to
   * the room, and deleteGroup takes the room's legs alone. */
  roomDeleteAlsoCalls: 'The room’s calls here go too.',
  roomDeleted: `Room deleted from this ${DEVICE_NOUN}.`,

  /** What VoiceOver hears for a room row. The walled-square mark is visual
   * only, so the WORD travels in the label — a distinction that exists only
   * visually is not a distinction for everyone. */
  roomSpoken: (label: string) => `${label}, group`,

  // No seat count: a conversation here is one other person or a room full
  // of them, and the empty state may not promise either.
  emptyCaption: 'This seat is yours',
  emptyRoom: 'A private space waiting for the people you invite',
  emptyTitle: 'Nobody else is here yet',
  stepOne: 'Send someone your ID.',
  /** The new-chat screen offers scanning before typing, so the first-run
   * instructions introduce those actions in the same order. */
  stepTwo: 'Tap + to scan their code, or type their ID.',
  /** Conversation actions live behind a long press or the row's ellipsis.
   * Name the location without listing a subset of a drawer that can vary. */
  actionsHint: 'The … beside a room holds what you can do with it.',
  copyId: 'Copy ID',
  shareId: 'Share ID',
  // Byte-identical to StartChatScreen.tsx — the same copy action must never
  // get two different sentences.
  copied:
    'Copied. Paste it into a text — or read it out loud, four letters at a time.',

  attentionTitle: 'Needs attention',
  attentionUnknown: 'Review agent requests',
  attentionCount: (count: number) =>
    count === 0
      ? 'No requests waiting'
      : `${count} ${count === 1 ? 'request' : 'requests'} waiting`,

} as const;

/** Where a filter earns its space: below this, scanning the list is faster. */
const FILTER_FROM = 8;

/** The notify-requery coalescing window, the same 80ms the thread and the
 * app's ProfileWatcher hold: long enough to coalesce a draining backlog,
 * short enough that an arriving message still lands before the eye notices
 * (two live panes must not double per-notify SQLite
 * requeries). */
const REFRESH_DEBOUNCE_MS = 80;

/** How long the copy confirmation holds — StartChatScreen's own number. */
const COPY_NOTICE_MS = 3000;

/** The + button's geometry: where it floats and how big it is. The list's
 * bottom inset is derived from these, so the two cannot drift apart. */
const FAB_BOTTOM = 24;
const FAB_SIZE = 56;

/**
 * WHERE THE LIST WAS, LAST TIME SOMEBODY LOOKED AT IT.
 *
 * Module scope, not state and not a ref, precisely because the router keeps
 * no stack (`App.tsx`): this
 * screen UNMOUNTS on every navigation into a conversation and mounts afresh
 * on the way back, so anything held inside the component is gone by the time
 * it would be needed. Opening the thirtieth conversation and backing out
 * returned you to the top of the list, every time.
 *
 * NOT A DURESS TELL, and the guard is what makes that true. An offset is a
 * number with no content; it names nobody and says nothing about what is in
 * the list. But it is still process-scope state, and the one boundary it
 * must not cross is the workspace switch — so `offsetOwner` names the
 * SESSION as well as the account.
 *
 * The account alone does not separate them: a decoy workspace stores the
 * real account's own `userId` (decoy.ts writes it into the decoy profile so
 * the two never drift), so an id-only owner check does not fire on a duress
 * unlock, and the place the owner had scrolled their real list to would be
 * put back under the decoy. `${session.mode}:${userId}` fires on both a
 * change of account and a change of session, which is every crossing there
 * is.
 */
let lastOffset = 0;
let offsetOwner: string | null = null;

/**
 * The conversations this run has PROVEN have something inbound.
 *
 * `canMarkUnread` is the one question the drawer cannot answer from what is
 * already on screen, and the only statement that answers it today is
 * `db.listMessages`, whose own comment calls it deliberately unbounded: it
 * selects every column of every message in the conversation, bodies
 * included, to compute one boolean. Cache known-positive results so
 * reopening the same drawer does not repeatedly read its whole history.
 *
 * ONLY THE `true` ANSWER IS KEPT, and the asymmetry is the design. A
 * conversation that has received something cannot un-receive it, so a true
 * holds for the life of the process. A false can turn true at any moment —
 * that is what an arrival IS — so it is never remembered and the next
 * drawer asks again, which is cheap precisely because a conversation with
 * nothing inbound is the small one.
 *
 * Forgotten with `lastOffset`, on the same owner change and for the same
 * reason: it is a fact about one workspace's conversations, and the decoy
 * shares this account's id.
 *
 * A bulk inbound-peer query could replace this cache and the history read;
 * until such a query exists, cache only facts that remain true.
 */
const inboundSeen = new Set<string>();

/**
 * Which step of a row's attached actions is showing. Blocking gets its own
 * step rather than borrowing `confirm`: the two confirmations say different
 * things, in different tones, and one of them is reversible.
 */
type RowMenu = 'none' | 'actions' | 'confirm' | 'blockConfirm';

/**
 * The single line a conversation shows, with honest fallbacks. `previewFor`
 * runs again here as defence in depth: an envelope that reached the preview
 * column raw must never leak its JSON into the list.
 */
function previewLine(chat: db.ChatRow): string {
  if (chat.lastMessageAt === null) return COPY.previewNone;
  // Newlines collapse rather than truncate: a one-line preview that stops at
  // the first line break hides the rest of a message that did arrive.
  const line = previewFor(chat.lastMessageText ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return line === '' ? COPY.previewUnreadable : line;
}

/**
 * One conversation, plus the actions attached beneath it. A continuous row,
 * not a card: the only edges are the pressed wash and the seam the list draws
 * between rows.
 *
 * Memoised: every prop is a primitive, a row object the list holds, or a
 * stable callback, so a re-render of the list for one row's drawer, a socket
 * transition or a keystroke in the filter leaves the other rows' trees
 * untouched. `renderItem` below is a `useCallback` for the same reason — an
 * inline arrow handed VirtualizedList a new function every render. */
const ConversationRow = React.memo(function ConversationRowBody({
  chat,
  room,
  unread,
  mentioned,
  blocked,
  selected,
  menu,
  draft,
  canMarkUnread,
  onOpen,
  onMenu,
  onDelete,
  onBlock,
  onUnblock,
  onPin,
  onMarkUnread,
}: {
  chat: db.ChatRow;
  /** The room anchor when this row IS a room: its name
   * comes from here, never from the peer-profile columns a person fills. */
  room: db.GroupRow | undefined;
  unread: boolean;
  /** An unread message in this ROOM mentions me — WhatsApp's @ badge (the
   * mentions contract). Believed only alongside `room`: a 1:1 has one
   * possible addressee, so "mentioned" is not a fact its row can carry. */
  mentioned: boolean;
  /**
   * This device blocks this person. Read from `blocked_peers`, never from
   * messaging's enforcement Set — that Set is empty in a duress session, where
   * the decoy workspace's own rows are the truth.
   */
  blocked: boolean;
  /** This row's conversation is OPEN in the wide shell's detail pane.
   * False everywhere in compact, so nothing below may change when it is —
   * the wash and the a11y bit both key on true only. */
  selected: boolean;
  /** Which step of this row's actions is showing, if any. */
  menu: RowMenu;
  /** What is sitting unsent in this conversation's composer, if anything
   *. Undefined is the ordinary case; the preview line is
   * unchanged then. */
  draft: string | undefined;
  /** Whether this conversation has anything inbound to mark, or
   * `undefined` while the answer is still on its way. The row is WITHHELD
   * rather than greyed when there is nothing: `markChatUnread` is a silent
   * no-op with nothing to roll back to. Unknown reserves the space instead
   * — see `heldUnreadSlot`. */
  canMarkUnread: boolean | undefined;
  onOpen: (peerId: string) => void;
  onMenu: (peerId: string, next: RowMenu) => void;
  onDelete: (peerId: string) => Promise<boolean>;
  onBlock: (peerId: string) => Promise<boolean>;
  onUnblock: (peerId: string) => Promise<boolean>;
  /** A moment, or null to unpin. */
  onPin: (peerId: string, at: number | null) => Promise<boolean>;
  onMarkUnread: (peerId: string) => Promise<boolean>;
}) {
  const t = useTheme();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  /** Kept apart from the delete pair: two failures must not borrow each
   * other's sentence. */
  const [blockBusy, setBlockBusy] = useState(false);
  const [blockFailed, setBlockFailed] = useState(false);

  // A failure notice belongs to the attempt that produced it, and the row
  // outlives every step of its drawer — it is a FlatList cell, so closing the
  // drawer by long-pressing the row again unmounts nothing. Without this, a
  // failed unblock leaves BLOCK.failed sitting in state, and the next time the
  // drawer is opened InlineError mounts, renders and announces "Tacendum
  // couldn't save that. Try again." to VoiceOver, describing an attempt the
  // person did not just make. Clearing on every step change covers all the
  // exits — the long-press dismissal, the cancel, another row's drawer opening
  // — rather than the one that happened to be noticed.
  useEffect(() => {
    setFailed(false);
    setBlockFailed(false);
  }, [menu]);
  // A room is named by its anchor (localName still outranking — my list, my
  // labels), and NEVER by its ULID: personName's shortId fallback would put
  // a room id on screen, so a nameless room falls back to a word instead.
  // Sanitized at each step (the anchor's name is peer-chosen free
  // text like a card) because the wire schema's min(1) accepts a
  // whitespace-only anchor name, which personName would silently degrade to
  // the room's id. The monogram may keep the ULID-tail path — that is
  // deliberate.
  const label = room
    ? sanitizeDisplayName(chat.localName) ||
      sanitizeDisplayName(room.name) ||
      COPY.roomFallbackName
    : personName(chat.peerId, chat.displayName, chat.localName);
  /**
   * The same row, said out loud. `label` above falls back to
   * `shortId` for somebody who has never shared a name — eight ULID
   * characters, which a screen reader pronounces as invented words, on the
   * row that introduces a stranger. The SPOKEN name spells that tail
   * instead. Rooms are unaffected by construction: a nameless room falls
   * back to a word, never to an id, so the two are the same string there.
   */
  const spokenLabel = room
    ? label
    : spokenPersonName(chat.peerId, chat.displayName, chat.localName);
  // A name I gave outranks the card they shared, so the disc and the line
  // under it can never disagree about who this is — and a card that
  // sanitizes away is not a name, exactly as personName drops it.
  const named =
    room !== undefined ||
    (sanitizeDisplayName(chat.localName) ||
      sanitizeDisplayName(chat.displayName)) !== '';
  const preview = previewLine(chat);
  /** Pinned is a moment on the row, not a flag: `listChats` orders by it, so
   * the row only has to SAY so. */
  const pinned = chat.pinnedAt != null;
  /**
   * The draft, collapsed to the one line this row has — and withheld on a
   * blocked row, which has exactly one thing to say and it is not this
   *. A row that is discarding what this person sends keeps its
   * status.
   */
  const draftLine = blocked ? '' : (draft ?? '').replace(/\s+/g, ' ').trim();
  const showDraft = draftLine !== '';
  /**
   * WHETHER THIS OPENING OF THE DRAWER HAS TO HOLD THE MARK-UNREAD SPACE.
   *
   * `canMarkUnread` is undefined until the read behind it lands, and the
   * drawer paints before that. Inserting the row afterwards pushed Block
   * and Delete down 44pt under a finger already moving; collapsing a
   * placeholder afterwards would pull Delete UP into where Block had been,
   * which is worse. So the decision is frozen at the moment this drawer
   * OPENS: opened without an answer, the space is held for as long as this
   * opening lasts, whichever way the answer goes. Closing the drawer
   * forgets it, and the next opening — with the answer now remembered —
   * paints its final shape immediately.
   */
  const heldUnreadSlot = useRef(false);
  if (menu !== 'actions') {
    heldUnreadSlot.current = false;
  } else if (canMarkUnread === undefined) {
    heldUnreadSlot.current = true;
  }

  /** The name a screen reader hears, plus the two facts that are otherwise
   * only a glyph: room-ness, and pinned-ness. */
  const spokenTitle = (() => {
    const withKind = room ? COPY.roomSpoken(spokenLabel) : spokenLabel;
    return pinned ? COPY.pinnedSpoken(withKind) : withKind;
  })();

  const remove = () => {
    setBusy(true);
    setFailed(false);
    void onDelete(chat.peerId).then(ok => {
      if (ok) return;
      setBusy(false);
      setFailed(true);
    });
  };

  /**
   * Both writes go through messaging so the enforcement Set and the screens
   * stay in step; the row only reports what the write did. A failure leaves the
   * row exactly as it was, which is what BLOCK.failed says.
   */
  const runBlockWrite = (work: (peerId: string) => Promise<boolean>) => {
    setBlockBusy(true);
    setBlockFailed(false);
    void work(chat.peerId).then(ok => {
      // Cleared either way, unlike the delete pair above: a deleted row leaves
      // the list, but a blocked one stays and its drawer will be opened again.
      setBlockBusy(false);
      if (!ok) setBlockFailed(true);
    });
  };

  return (
    <View>
      <Pressable
        onPress={() => onOpen(chat.peerId)}
        onLongPress={() =>
          onMenu(chat.peerId, menu === 'none' ? 'actions' : 'none')
        }
        delayLongPress={t.motion.longPress}
        accessibilityRole="button"
        // The rotor action reaches the same drawer without a long press, which
        // VoiceOver cannot perform on a list row.
        accessibilityActions={[{ name: 'actions', label: COPY.rowActions }]}
        onAccessibilityAction={event => {
          if (event.nativeEvent.actionName === 'actions') {
            onMenu(chat.peerId, menu === 'none' ? 'actions' : 'none');
          }
        }}
        accessibilityState={{
          expanded: menu !== 'none',
          // Only ever ADDED: a compact row must render byte-identically,
          // and `selected: false` would be a new prop where there was none.
          ...(selected ? { selected: true } : {}),
        }}
        // Blocked outranks unread: it is the state that changes what this row
        // will and will not do. A room says so in EVERY state — including the
        // quiet one, which for a person stays label-free (their Text children
        // already read correctly) — because the room mark is only visual.
        {...(blocked
          ? {
              accessibilityLabel: BLOCK.rowLabel(spokenTitle, preview),
            }
          : unread || (room && mentioned)
            ? {
                // "you were mentioned" outranks the plain unread sentence:
                // being addressed is the one fact worth adding words for.
                //
                // The TAIL is whatever the preview slot is actually
                // showing, which is the draft when there is one. News
                // outranks a draft in the sentence, but it does not put the
                // incoming message back: the visible slot has already given
                // that line up to the draft, so speaking it would describe a
                // row nobody can see. Same rule as the branch below, one
                // sentence further on.
                accessibilityLabel: (room && mentioned
                  ? COPY.unreadMention
                  : COPY.unread)(
                  spokenTitle,
                  showDraft ? `${COPY.draftPrefix}, ${draftLine}` : preview,
                ),
              }
            : showDraft
              ? {
                  // News outranks a draft — an arrival is about them, a
                  // draft is about me — but a draft outranks the preview it
                  // has replaced on screen, or the two channels would
                  // disagree about what this row is showing.
                  accessibilityLabel: COPY.draftSpoken(spokenTitle, draftLine),
                }
              : room || pinned
                ? {
                    accessibilityLabel: `${spokenTitle}, ${preview}`,
                  }
                : {})}
        testID={`chat-${chat.peerId}`}
        style={({ pressed }) => [
          styles.row,
          {
            minHeight: t.layout.chatRowHeight,
            paddingHorizontal: t.layout.gutter,
            // The selected wash is the pressed wash held: the open
            // conversation reads as "this one", in the same ink a press
            // already taught. In compact `selected` is always false and this
            // line is exactly the pre-wide expression.
            backgroundColor:
              pressed || selected ? t.color.pineWash : 'transparent',
          },
        ]}
      >
        {/* A person is a circle; a room is the Quiet Room's walled square
            with a doorway (RoomMark). The monogram mechanism inside is
            the initials of the room's name, or the ULID's tail when it
            has none — but the SHAPE is the signal: in a list mixing both,
            room-ness must not depend on reading the name. */}
        {room ? (
          <RoomMark
            roomId={chat.peerId}
            name={chat.localName ?? room.name}
            size={t.layout.avatar.row}
            testID={`room-mark-${chat.peerId}`}
          />
        ) : (
          <Avatar
            peerId={chat.peerId}
            displayName={chat.localName ?? chat.displayName}
            photoB64={chat.avatarB64}
            size={t.layout.avatar.row}
          />
        )}
        {/* The marker lives in the gap that already exists, so the name column
            never shifts between a read and an unread row. */}
        <View style={styles.rowGap}>
          {unread ? (
            <View
              style={[
                styles.unreadMark,
                {
                  borderRadius: t.radius.tail,
                  backgroundColor: t.color.pine,
                },
              ]}
            />
          ) : pinned ? (
            /* The pinned mark, in the column the unread dot already owns —
               so the name never shifts, and the two can never collide. News
               outranks placement: an arrival is about somebody else, a pin
               is my own filing, so it is drawn in the muted ink: forest in
               this column means unread. Frozen against Dynamic Type and
               hidden from assistive tech, the "…" precedent below: the row
               is ONE element and the WORD rides its label. */
            <Text
              allowFontScaling={false}
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
              testID={`pin-mark-${chat.peerId}`}
              style={[styles.pinMark, { color: t.color.inkMuted }]}
            >
              ▲
            </Text>
          ) : null}
        </View>
        <View style={styles.rowBody}>
          <View style={styles.rowTopLine}>
            {/* Nobody is given a fabricated name: without a shared or local one
                the person is their id, set in the utility face that says so. */}
            <Text
              numberOfLines={1}
              style={[
                named ? t.type.rowTitle : t.type.utilityData,
                styles.rowName,
                { color: t.color.inkStrong },
              ]}
            >
              {label}
            </Text>
            {/* The word takes the timestamp's place, and takes it even when
                there has never been a message. A frozen "2 days ago" that
                never moves again tells the row's owner the person went quiet,
                when in fact this device is discarding what they send; the
                word that replaces it is the reason the clock stopped. Same
                face, same column, so the 72pt row does not move. */}
            {blocked ? (
              <Text
                numberOfLines={1}
                style={[
                  t.type.timeStatus,
                  styles.rowTime,
                  { color: t.color.inkMuted },
                ]}
              >
                {BLOCK.rowStatus}
              </Text>
            ) : chat.lastMessageAt !== null ? (
              <Text
                style={[
                  t.type.timeStatus,
                  styles.rowTime,
                  { color: t.color.inkMuted },
                ]}
              >
                {timeLabel(chat.lastMessageAt)}
              </Text>
            ) : null}
          </View>
          {/* Two channels for "new", never colour alone: the marker above and
              the preview's own weight. No count is ever rendered. */}
          <View style={styles.rowPreviewLine}>
            <Text
              numberOfLines={1}
              style={[
                unread ? t.type.compactStrong : t.type.compactBody,
                styles.rowPreview,
                { color: unread ? t.color.inkBody : t.color.inkMuted },
              ]}
            >
              {/* The conventional shape, and the reason the drafts table was
                  built: the word in pine, then what you left. Two children
                  rather than a fragment, so the line is one text run the row
                  can ellipsize. The row's own weight carries the rest, so a
                  draft on an unread row still reads as unread. */}
              {showDraft ? (
                <Text
                  testID={`draft-prefix-${chat.peerId}`}
                  style={{ color: t.color.pine }}
                >
                  {COPY.draftPrefix}
                </Text>
              ) : null}
              {showDraft ? ` ${draftLine}` : preview}
            </Text>
            {/* WhatsApp's @ badge: an unread message in this room mentions
                YOU. Rooms only, and re-verified by the screen against the
                parsed envelope's `who` — never against a body's claim. The
                glyph scales with text; the WORD rides the row's label. */}
            {room && mentioned ? (
              <View
                testID={`mention-badge-${chat.peerId}`}
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
                style={[
                  styles.mentionBadge,
                  {
                    backgroundColor: 'transparent',
                    borderColor: t.color.pineLine,
                    borderRadius: t.radius.tail,
                  },
                ]}
              >
                <Text style={[t.type.compactStrong, { color: t.color.pine }]}>
                  @
                </Text>
              </View>
            ) : null}
          </View>
        </View>
        {/* The visible door to Block and Delete: a long press and the
            VoiceOver rotor action reached
            the drawer, and nothing on screen said so. A 44pt target at the
            row's trailing edge opens — and closes — the same drawer. Hidden
            from VoiceOver on purpose: the row is ONE element whose rotor
            action already reaches the drawer, and a glyph read out as
            "ellipsis" after every preview would be noise, not a door. */}
        <Pressable
          onPress={() =>
            onMenu(chat.peerId, menu === 'none' ? 'actions' : 'none')
          }
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          testID={`chat-more-${chat.peerId}`}
          style={({ pressed }) => [
            styles.rowMore,
            {
              width: t.layout.touchTarget,
              minHeight: t.layout.touchTarget,
              borderRadius: t.radius.circle,
              backgroundColor: pressed ? t.color.pineWash : 'transparent',
            },
          ]}
        >
          <Text
            allowFontScaling={false}
            style={[
              t.type.iconGlyph,
              { color: menu === 'none' ? t.color.inkMuted : t.color.pine },
            ]}
          >
            …
          </Text>
        </Pressable>
      </Pressable>

      {menu === 'actions' ? (
        <View
          testID={`chat-drawer-${chat.peerId}`}
          style={[
            styles.rowDrawer,
            {
              backgroundColor: t.color.paperLayer,
              borderColor: t.color.lineSoft,
              borderTopWidth: t.hairline,
              borderBottomWidth: t.hairline,
            },
          ]}
        >
          {blocked ? (
            <>
              {/* PIN LIVES IN BOTH DRAWERS, and it has to. `listChats`
                  orders pinned rows first whatever else is true of them, so
                  a conversation you pinned and then blocked sits at the top
                  of your home screen permanently — and every other route
                  back is unblock, unpin, block again. Same control, same
                  testID, same label as the unblocked branch; it leads here
                  because "reversible above irreversible" has only one
                  irreversible thing left to be above, and unblocking is the
                  subject of this drawer, not its filing. */}
              <Pressable
                onPress={() =>
                  void onPin(chat.peerId, pinned ? null : Date.now())
                }
                accessibilityRole="button"
                accessibilityLabel={pinned ? COPY.unpin : COPY.pin}
                testID={`chat-${pinned ? 'unpin' : 'pin'}-${chat.peerId}`}
                style={({ pressed }) => [
                  styles.rowDrawerAction,
                  {
                    minHeight: t.layout.touchTarget,
                    paddingHorizontal: t.layout.gutter,
                    backgroundColor: pressed ? t.color.pineWash : 'transparent',
                  },
                ]}
              >
                <Text
                  style={[t.type.compactStrong, { color: t.color.inkStrong }]}
                >
                  {pinned ? COPY.unpin : COPY.pin}
                </Text>
              </Pressable>
              <Pressable
                onPress={() => runBlockWrite(onUnblock)}
                disabled={blockBusy}
                accessibilityRole="button"
                accessibilityLabel={BLOCK.unblock}
                accessibilityState={{ disabled: blockBusy }}
                testID={`chat-unblock-${chat.peerId}`}
                style={({ pressed }) => [
                  styles.rowDrawerAction,
                  {
                    minHeight: t.layout.touchTarget,
                    paddingHorizontal: t.layout.gutter,
                    backgroundColor: pressed ? t.color.pineWash : 'transparent',
                  },
                ]}
              >
                <Text
                  style={[
                    t.type.compactStrong,
                    {
                      color: blockBusy ? t.color.inkMuted : t.color.inkStrong,
                    },
                  ]}
                >
                  {BLOCK.unblock}
                </Text>
              </Pressable>
              {/* No Delete row while blocked, deliberately. `blocked_peers` is
                  its own table so deleting a conversation cannot silently
                  unblock the person it was with — which means deleting here
                  would leave a live block with no surface left to reverse it. */}
              <Text
                style={[
                  t.type.compactBody,
                  styles.rowDrawerNote,
                  {
                    paddingHorizontal: t.layout.gutter,
                    color: t.color.inkMuted,
                  },
                ]}
              >
                {BLOCK.drawerBlockedNote}
              </Text>
              {blockFailed ? (
                <View style={{ paddingHorizontal: t.layout.gutter }}>
                  <InlineError
                    message={BLOCK.failed}
                    testID={`chat-unblock-error-${chat.peerId}`}
                    surface={t.color.paperSheet}
                  />
                </View>
              ) : null}
            </>
          ) : (
            <>
              {/* Reversible above irreversible, so the two filing actions
                  lead: pinning and marking unread change where a row sits
                  and what it says, and both are undone by doing them again
                  (tablestakes-8). Neither is ever sent — the person pinned
                  is never told. */}
              <Pressable
                onPress={() =>
                  void onPin(chat.peerId, pinned ? null : Date.now())
                }
                accessibilityRole="button"
                accessibilityLabel={pinned ? COPY.unpin : COPY.pin}
                testID={`chat-${pinned ? 'unpin' : 'pin'}-${chat.peerId}`}
                style={({ pressed }) => [
                  styles.rowDrawerAction,
                  {
                    minHeight: t.layout.touchTarget,
                    paddingHorizontal: t.layout.gutter,
                    backgroundColor: pressed ? t.color.pineWash : 'transparent',
                  },
                ]}
              >
                <Text
                  style={[t.type.compactStrong, { color: t.color.inkStrong }]}
                >
                  {pinned ? COPY.unpin : COPY.pin}
                </Text>
              </Pressable>
              {/* WITHHELD, never greyed: with nothing inbound there is
                  nothing to roll the clock back to, and a control that does
                  nothing is the same defect as one that claims something.
                  While the answer is still on its way the SPACE is held
                  instead (see `heldUnreadSlot`), so Block and Delete never
                  move under a finger already travelling to them. */}
              {canMarkUnread === true ? (
                <Pressable
                  onPress={() => void onMarkUnread(chat.peerId)}
                  accessibilityRole="button"
                  accessibilityLabel={COPY.markUnread}
                  testID={`chat-markunread-${chat.peerId}`}
                  style={({ pressed }) => [
                    styles.rowDrawerAction,
                    {
                      minHeight: t.layout.touchTarget,
                      paddingHorizontal: t.layout.gutter,
                      backgroundColor: pressed
                        ? t.color.pineWash
                        : 'transparent',
                    },
                  ]}
                >
                  <Text
                    style={[t.type.compactStrong, { color: t.color.inkStrong }]}
                  >
                    {COPY.markUnread}
                  </Text>
                </Pressable>
              ) : heldUnreadSlot.current ? (
                <View
                  testID={`chat-markunread-hold-${chat.peerId}`}
                  accessibilityElementsHidden
                  importantForAccessibility="no-hide-descendants"
                  style={{ minHeight: t.layout.touchTarget }}
                />
              ) : null}
              {/* Blocking is protective, not destructive, so it takes the
                  pine wash: two stacked red rows read as one
                  undifferentiated hazard. A ROOM offers no Block at all —
                  blocking a room is not a thing ; a member is blocked
                  from their own conversation, and leaving is the room-shaped
                  act. */}
              {room === undefined ? (
                <Pressable
                  onPress={() => onMenu(chat.peerId, 'blockConfirm')}
                  accessibilityRole="button"
                  accessibilityLabel={BLOCK.action}
                  testID={`chat-block-${chat.peerId}`}
                  style={({ pressed }) => [
                    styles.rowDrawerAction,
                    {
                      minHeight: t.layout.touchTarget,
                      paddingHorizontal: t.layout.gutter,
                      backgroundColor: pressed
                        ? t.color.pineWash
                        : 'transparent',
                    },
                  ]}
                >
                  <Text
                    style={[t.type.compactStrong, { color: t.color.inkStrong }]}
                  >
                    {BLOCK.action}
                  </Text>
                </Pressable>
              ) : null}
              <Pressable
                onPress={() => onMenu(chat.peerId, 'confirm')}
                accessibilityRole="button"
                accessibilityLabel={room ? COPY.deleteRoom : COPY.deleteChat}
                testID={`chat-delete-${chat.peerId}`}
                style={({ pressed }) => [
                  styles.rowDrawerAction,
                  {
                    minHeight: t.layout.touchTarget,
                    paddingHorizontal: t.layout.gutter,
                    backgroundColor: pressed
                      ? t.color.dangerWash
                      : 'transparent',
                  },
                ]}
              >
                <Text style={[t.type.compactStrong, { color: t.color.danger }]}>
                  {room ? COPY.deleteRoom : COPY.deleteChat}
                </Text>
              </Pressable>
            </>
          )}
        </View>
      ) : null}

      {menu === 'blockConfirm' ? (
        // Paper and a slate rule, never the danger rule: this is the person's
        // own settled decision, not an alarm about something gone wrong.
        <View
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          testID={`chat-block-panel-${chat.peerId}`}
          style={[
            styles.rowConfirm,
            {
              backgroundColor: t.color.paperLayer,
              borderLeftColor: t.color.warningMark,
            },
          ]}
        >
          <Text style={[t.type.compactStrong, { color: t.color.inkStrong }]}>
            {BLOCK.confirmQuestion}
          </Text>
          <Text
            style={[
              t.type.compactBody,
              styles.rowConfirmBody,
              { color: t.color.inkBody },
            ]}
          >
            {BLOCK.confirmBody}
          </Text>
          <View style={styles.confirmActions}>
            <TextAction
              label={BLOCK.cancel}
              // Leaving the confirmation takes its failure notice with it —
              // the step-change effect above clears it on the way out.
              onPress={() => onMenu(chat.peerId, 'none')}
              disabled={blockBusy}
              testID={`chat-block-cancel-${chat.peerId}`}
            />
            {/* The kit's outlined button in its warning tone:
                slate, never red — a block is the person's own settled
                decision, not an alarm. */}
            <OutlineButton
              label={BLOCK.confirm}
              tone="warning"
              size="compact"
              onPress={() => runBlockWrite(onBlock)}
              disabled={blockBusy}
              testID={`chat-block-confirm-${chat.peerId}`}
              style={styles.confirmDelete}
            />
          </View>
          {blockFailed ? (
            <InlineError
              message={BLOCK.failed}
              testID={`chat-block-error-${chat.peerId}`}
              // A sheet on the panel, like every nested error in this row.
              surface={t.color.paperSheet}
            />
          ) : null}
        </View>
      ) : null}

      {menu === 'confirm' ? (
        <View
          style={[
            styles.rowConfirm,
            {
              backgroundColor: t.color.paperLayer,
              borderLeftColor: t.color.danger,
            },
          ]}
        >
          {/* Deleting is final and local, and the copy must not imply it stops
              them reaching you: an inbound message recreates the row. The
              room variant says the room-shaped truths — other members keep
              their copies, and a live room you are still in can return
              (the recreate rule, stated rather than discovered). */}
          <Text style={[t.type.compactBody, { color: t.color.inkBody }]}>
            {room ? COPY.roomDeleteConfirm : COPY.deleteConfirm}
          </Text>
          {/* What the delete also takes, said rather than
              discovered later in Calls. A second line, because the sentence
              above is anchored in the copy inventory. */}
          <Text
            testID={`chat-delete-calls-${chat.peerId}`}
            style={[
              t.type.compactBody,
              styles.rowConfirmAlso,
              { color: t.color.inkBody },
            ]}
          >
            {room ? COPY.roomDeleteAlsoCalls : COPY.deleteAlsoCalls}
          </Text>
          <View style={styles.confirmActions}>
            <TextAction
              label={COPY.keep}
              onPress={() => onMenu(chat.peerId, 'none')}
              disabled={busy}
              testID={`chat-keep-${chat.peerId}`}
            />
            <OutlineButton
              label={COPY.delete}
              tone="danger"
              size="compact"
              onPress={remove}
              disabled={busy}
              testID={`chat-delete-confirm-${chat.peerId}`}
              style={styles.confirmDelete}
            />
          </View>
          {failed ? (
            <InlineError
              message={COPY.deleteFailed}
              testID={`chat-delete-error-${chat.peerId}`}
              // A sheet on the panel, like every nested error in this row.
              surface={t.color.paperSheet}
            />
          ) : null}
        </View>
      ) : null}
    </View>
  );
});

/** Filter over rows already on this device. No lookup, so never "search". */
function FilterField({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  const t = useTheme();
  const [focused, setFocused] = useState(false);
  return (
    <View style={[styles.filterWrap, { paddingHorizontal: t.layout.gutter }]}>
      <TextInput
        value={value}
        onChangeText={onChange}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        placeholder={COPY.filterLabel}
        placeholderTextColor={t.color.inkMuted}
        keyboardAppearance={t.scheme}
        selectionColor={t.color.pine}
        cursorColor={t.color.pine}
        accessibilityLabel={COPY.filterLabel}
        autoCapitalize="none"
        autoCorrect={false}
        clearButtonMode="while-editing"
        testID="chat-filter"
        style={[
          t.type.input,
          styles.filterInput,
          {
            minHeight: t.layout.touchTarget,
            borderRadius: t.radius.button,
            backgroundColor: t.color.paperSheet,
            color: t.color.inkStrong,
            borderWidth: focused ? 2 : 1,
            borderColor: focused ? t.color.pine : t.color.lineField,
          },
        ]}
      />
    </View>
  );
}

/**
 * The only way to reach someone new, and the only way out of this device.
 * Permanent furniture with no conversations (it IS the screen's job then), a
 * scrolling header once there are — never hidden behind a chevron either way.
 */
/**
 * Zero conversations. The panel above teaches how to reach someone; this
 * teaches the half that actually blocks people — they need your id too.
 */
function EmptyChats({
  profile,
  onShare,
  nudge,
}: {
  profile: db.ProfileRow;
  /** Called with the pressed control's ref: the button lives here and the
   * share call lives in the parent, so the anchor travels with the press. */
  onShare: (anchor: ShareAnchor) => void;
  /** The naming nudge when it is owed (null otherwise), mounted under the
   * steps: the parent owns whether it shows, since the same card heads the
   * list once there are conversations. */
  nudge: React.ReactNode;
}) {
  const t = useTheme();
  /** The Share ID button, so the iPad popover points at it. */
  const shareAnchor = useRef<View>(null);
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
    },
    [],
  );
  const copyId = useCallback(() => {
    // The bare id, and no pasteboard expiry (contrast pasteboard.ts): an id
    // is an address, not a secret — the whole point is that it gets pasted.
    // A copy is not a share site (exactly four of those are pinned).
    Clipboard.setString(profile.userId);
    setCopied(true);
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(false), COPY_NOTICE_MS);
  }, [profile.userId]);
  return (
    <View style={styles.emptyState}>
      <QuietRoom
        you={{
          peerId: profile.userId,
          displayName: profile.displayName,
          photoB64: profile.avatarB64,
        }}
        caption={COPY.emptyCaption}
        accessibilityLabel={COPY.emptyRoom}
      />
      <Text
        style={[
          t.type.sectionTitle,
          styles.emptyTitle,
          { color: t.color.inkStrong },
        ]}
        accessibilityRole="header"
      >
        {COPY.emptyTitle}
      </Text>

      <View style={styles.steps}>
        <View style={styles.step}>
          <Text
            style={[
              t.type.utilityLabel,
              styles.stepNumeral,
              { color: t.color.inkMuted },
            ]}
          >
            1.
          </Text>
          <View style={styles.stepBody}>
            <Text style={[t.type.compactBody, { color: t.color.inkBody }]}>
              {COPY.stepOne}
            </Text>
            <View style={styles.stepAction}>
              <TextAction
                label={COPY.copyId}
                onPress={copyId}
                testID="empty-copy-id"
              />
              <TextAction
                ref={shareAnchor}
                label={COPY.shareId}
                onPress={() => onShare(shareAnchor)}
                testID="empty-share-id"
              />
            </View>
            {copied ? (
              <InlineNotice
                tone="pine"
                message={COPY.copied}
                testID="empty-id-copied"
              />
            ) : null}
          </View>
        </View>
        <View style={[styles.step, styles.stepGap]}>
          <Text
            style={[
              t.type.utilityLabel,
              styles.stepNumeral,
              { color: t.color.inkMuted },
            ]}
          >
            2.
          </Text>
          <View style={styles.stepBody}>
            <Text style={[t.type.compactBody, { color: t.color.inkBody }]}>
              {COPY.stepTwo}
            </Text>
          </View>
        </View>
        {/* Not a numbered step — there is nothing to do yet — but the one
            sentence that used to be missing: where a row's
            actions live once there are rows. */}
        <Text
          style={[t.type.compactBody, styles.emptyHint, { color: t.color.inkMuted }]}
          testID="empty-actions-hint"
        >
          {COPY.actionsHint}
        </Text>
      </View>

      {nudge}
    </View>
  );
}

/**
 * The one-time naming nudge: an account
 * registered before the naming moment existed never saw the step, so the
 * list asks once — under the steps while there is nobody here yet, and as
 * the list's head once there is, because an EXISTING nameless account (the
 * population the nudge exists for) already has conversations. The parent
 * owns the owed/settled state; either control here settles it durably
 * (workspace-scoped, so a duress session answers into the decoy file) and
 * it never shows again.
 */
function NamingNudge({
  placement,
  onAdd,
  onSkip,
}: {
  placement: 'empty' | 'list';
  /** The profile-screen entry: it already knows how to edit a name, so
   * the nudge points there rather than growing a field. */
  onAdd: () => void;
  onSkip: () => void;
}) {
  const t = useTheme();
  return (
    <View
      testID="naming-nudge"
      style={[
        styles.nudge,
        placement === 'empty'
          ? styles.nudgeEmpty
          : [styles.nudgeList, { marginHorizontal: t.layout.gutter }],
        {
          borderRadius: t.radius.drawer,
          backgroundColor: t.color.paperSheet,
          borderColor: t.color.lineSoft,
          borderWidth: t.hairline,
        },
      ]}
    >
      <Text
        accessibilityRole="header"
        style={[t.type.sectionTitle, { color: t.color.inkStrong }]}
      >
        {NAMING_COPY.title}
      </Text>
      <Text
        style={[t.type.compactBody, styles.nudgeBody, { color: t.color.inkBody }]}
      >
        {NAMING_COPY.nudgeBody}
      </Text>
      <InfoDisclosure
        label={NAMING_COPY.infoLabel}
        lines={NAMING_COPY.infoLines}
        testID="naming-nudge-info"
      />
      <View style={styles.nudgeActions}>
        <TextAction
          label={NAMING_COPY.nudgeAdd}
          onPress={onAdd}
          testID="naming-nudge-add"
        />
        <TextAction
          label={NAMING_COPY.skip}
          onPress={onSkip}
          testID="naming-nudge-skip"
        />
      </View>
    </View>
  );
}

/**
 * The one-time App Lock nudge. After the naming moment nothing ever said
 * the app can be locked: the lock lives in Settings, and a person who never
 * opens Settings never learns that their chats are exactly as private as
 * the phone's own lock. The list says it once, in the naming nudge's slot
 * and shape — a quiet card, never an alert: an InlineNotice announces on
 * every mount, and this list mounts on every return to it.
 *
 * Owed while App Lock is off and nothing has answered. Either control
 * settles it durably in the Keychain — the store the lock's own state lives
 * in (lock.ts), and the store every other small device preference uses
 * (readReceipts.ts, pushConsent.ts). Device-scoped on purpose: the lock is
 * this device's, so the answer is too, and a sign-out does not re-ask.
 * Never in a duress session: one exists only under a lock that is on. */
const LOCK_NUDGE_COPY = {
  title: 'Add a lock code',
  body: `Your rooms are only as private as this ${DEVICE_NOUN}’s lock. A lock code of your own is asked for whenever Tacendum opens.`,
  where: 'Turn it on in Settings → App Lock, whenever you like.',
  open: 'Open Settings',
  skip: 'Not now',
  infoLabel: 'What a lock code does',
  infoLines: [
    `With App Lock on, Tacendum asks for its own code when it opens and after it has been in the background — on top of the ${DEVICE_NOUN}’s passcode.`,
    `The code never leaves this ${DEVICE_NOUN}. Forgetting it means setting the app up again, so pick one you will remember.`,
  ],
} as const;

const LOCK_NUDGE_KEY = 'lockNudge.dismissed';

async function lockNudgeDue(): Promise<boolean> {
  if ((await lock.status()).enabled) return false;
  return (await getSecret(LOCK_NUDGE_KEY)) !== '1';
}

function settleLockNudge(): Promise<void> {
  return setSecret(LOCK_NUDGE_KEY, '1');
}

/**
 * The store build the soft update card is owed for, or null.
 *
 * Read straight off the gate singleton rather than through `checkNow`, which
 * is the right shape (this list must not dial anything) and was, on its own,
 * how a real session's answer reached the decoy: the singleton outlives a
 * relock. The getter it reads now refuses a non-real session, and `relock()`
 * clears the answer as well, so the card can only ever be raised by the
 * session that earned it.
 */
async function softUpdateDue(): Promise<number | null> {
  const latest = updateGate.softLatestBuild;
  if (latest === undefined) return null;
  return (await isSoftUpdateDismissed(latest)) ? null : latest;
}

function LockNudge({
  placement,
  onOpen,
  onSkip,
}: {
  placement: 'empty' | 'list';
  /** The route into Settings, when the host wired one. */
  onOpen: (() => void) | undefined;
  onSkip: () => void;
}) {
  const t = useTheme();
  return (
    <View
      testID="lock-nudge"
      style={[
        styles.nudge,
        placement === 'empty'
          ? styles.nudgeEmpty
          : [styles.nudgeList, { marginHorizontal: t.layout.gutter }],
        {
          borderRadius: t.radius.drawer,
          backgroundColor: t.color.paperSheet,
          borderColor: t.color.lineSoft,
          borderWidth: t.hairline,
        },
      ]}
    >
      <Text
        accessibilityRole="header"
        style={[t.type.sectionTitle, { color: t.color.inkStrong }]}
      >
        {LOCK_NUDGE_COPY.title}
      </Text>
      <Text
        style={[t.type.compactBody, styles.nudgeBody, { color: t.color.inkBody }]}
      >
        {LOCK_NUDGE_COPY.body}
      </Text>
      {onOpen ? null : (
        // No button can promise a route this screen was not given, so the
        // words carry the way instead.
        <Text
          style={[t.type.compactBody, styles.nudgeBody, { color: t.color.inkBody }]}
        >
          {LOCK_NUDGE_COPY.where}
        </Text>
      )}
      <InfoDisclosure
        label={LOCK_NUDGE_COPY.infoLabel}
        lines={LOCK_NUDGE_COPY.infoLines}
        testID="lock-nudge-info"
      />
      <View style={styles.nudgeActions}>
        {onOpen ? (
          <TextAction
            label={LOCK_NUDGE_COPY.open}
            onPress={onOpen}
            testID="lock-nudge-open"
          />
        ) : null}
        <TextAction
          label={LOCK_NUDGE_COPY.skip}
          onPress={onSkip}
          testID="lock-nudge-skip"
        />
      </View>
    </View>
  );
}

/**
 * The soft update card. The gate said this build
 * still works and a newer one is on the store, so this is a nudge and never
 * a wall: the naming nudge's slot and shape, one quiet card, dismissible.
 *
 * DISMISSED PER `latestBuild`, not per install. A flag would silence every
 * future release after one "Not now"; the VALUE means the next release asks
 * exactly once more, and the one after that once more again.
 *
 * Never in a duress session, for free: the gate refuses to check there, so
 * there is no decision for this card to render.
 */
function UpdateNudge({
  placement,
  url,
  onSkip,
}: {
  placement: 'empty' | 'list';
  /** The store link, when the policy carried one. No link, no button —
   * the same rule the update wall follows. */
  url: string | undefined;
  onSkip: () => void;
}) {
  const t = useTheme();
  return (
    <View
      testID="update-nudge"
      style={[
        styles.nudge,
        placement === 'empty'
          ? styles.nudgeEmpty
          : [styles.nudgeList, { marginHorizontal: t.layout.gutter }],
        {
          borderRadius: t.radius.drawer,
          backgroundColor: t.color.paperSheet,
          borderColor: t.color.lineSoft,
          borderWidth: t.hairline,
        },
      ]}
    >
      <Text
        accessibilityRole="header"
        style={[t.type.sectionTitle, { color: t.color.inkStrong }]}
      >
        {UPDATE_COPY.nudgeTitle}
      </Text>
      <Text
        style={[t.type.compactBody, styles.nudgeBody, { color: t.color.inkBody }]}
      >
        {UPDATE_COPY.nudgeBody}
      </Text>
      <View style={styles.nudgeActions}>
        {url ? (
          <TextAction
            label={UPDATE_COPY.nudgeOpen}
            onPress={() => {
              void Linking.openURL(url).catch(() => undefined);
            }}
            testID="update-nudge-open"
          />
        ) : null}
        <TextAction
          label={UPDATE_COPY.nudgeSkip}
          onPress={onSkip}
          testID="update-nudge-skip"
        />
      </View>
    </View>
  );
}

/**
 * Chat list: who you talk to, and the only way to reach someone new. Tacendum
 * has no directory, so the start-chat panel is permanent furniture rather than
 * a hidden compose action — an id typed by hand is the entire address book.
 */
export function ChatListScreen({
  profile,
  selectedPeerId,
  onOpenChat,
  onOpenProfile,
  onStartChat,
  onStartRoom,
  onOpenAppLock,
  onOpenSettings,
  onOpenAttention,
}: Props) {
  const t = useTheme();
  const [chats, setChats] = useState<db.ChatRow[]>([]);
  /**
   * Wait for the first listChats read before showing the empty state.
   * The router remounts this screen when returning from a conversation;
   * an initially empty state array says nothing about stored chats and
   * must not flash first-run instructions while SQLite is still reading.
   * Leave the list area blank until the read finishes, as the thread does.
   */
  const [loaded, setLoaded] = useState(false);
  /**
   * Which rows are rooms, keyed by the room's ULID, carrying the anchor
   * (owner + name). Read from the `groups` anchor per row because
   * `listChats` does not select the columns — the anchor is the one
   * place a room's constants live anyway.
   */
  const [rooms, setRooms] = useState<Map<string, db.GroupRow>>(new Map());
  const [unread, setUnread] = useState<Record<string, number>>({});
  /** What is sitting unsent in each conversation, in the
   * `unreadCounts` shape and read the same way: one whole-table statement
   * per refresh, never one per row. */
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  /**
   * Which conversations have anything inbound to mark unread, learned
   * one at a time when a drawer opens.
   *
   * THE HONEST COST, STATED. There is no bulk "has this chat ever received
   * anything" read, and every cheap approximation is wrong in a case people
   * actually hit: the newest row being outbound just means you replied last.
   * So the answer is read exactly, for one conversation, at the moment
   * somebody opens its drawer — the same posture the delete routing takes
   * with its press-time anchor re-check — and it is skipped entirely when
   * the row is already unread, which is inbound by definition. A bulk read
   * could replace these per-conversation reads; until then, read the
   * actual inbound state rather than estimating it.
   */
  const [inbound, setInbound] = useState<Record<string, boolean>>({});
  /** Rooms whose unread messages mention ME — the @ badge (the mentions
   * contract). Decided HERE, against the parsed envelope's `who` and my
   * own account id: the db read hands over bodies, never judgements, so a
   * body that merely wears a mention's shape cannot light the badge. */
  const [mentioned, setMentioned] = useState<Set<string>>(new Set());
  const [wsState, setWsState] = useState(messaging.wsState);
  const [query, setQuery] = useState('');
  /** Payload-free count from the same durable aggregate as AttentionScreen.
   * Null means the enhancement read failed; the door still works and makes
   * no claim about how many requests exist. */
  const [pendingApprovalCount, setPendingApprovalCount] = useState<
    number | null
  >(null);
  /**
   * Who this device blocks, read from the database rather than from messaging's
   * enforcement Set: the Set is empty in a duress session, where the decoy
   * workspace's own `blocked_peers` rows are what this list must render.
   */
  const [blockedIds, setBlockedIds] = useState<Set<string>>(new Set());
  /**
   * Whether the lock-screen mirror is out of step with the block list. Read from messaging's durable-seeded flag on every
   * refresh, so the warning is VISIBLE — not a one-off announcement — and
   * still standing after a relaunch, on the first screen anyone comes back
   * to. In duress the decoy workspace's own marker answers, which is never
   * set, so the decoy shows nothing it could not explain.
   */
  const [mirrorStale, setMirrorStale] = useState(
    messaging.isBlockNotificationMirrorStale(),
  );
  const [menu, setMenu] = useState<{
    peerId: string;
    step: 'actions' | 'confirm' | 'blockConfirm';
  } | null>(null);

  /** Read by the system-back handler, which is registered once and must see
   * what is open at the moment of the press, not at subscription. */
  const menuRef = useRef(menu);
  menuRef.current = menu;

  useEffect(() => {
    // ANDROID SYSTEM BACK closes the drawer that is open before it leaves
    // the home screen. The router's
    // handler (App.tsx) answers every press, and on the home route that
    // press exits the app — so a person who opened a row's drawer, or the
    // delete or block question inside it, and pressed Back to dismiss it
    // was closing Tacendum instead. That is the worst version of this bug
    // in the app, because it is the screen a person is on most.
    //
    // ONE PRESS CLOSES THE WHOLE DRAWER, not one step of it. Both questions
    // inside it — "Delete" and "Block" — cancel to `none` rather than back
    // to the actions row (`chat-keep-*`, `chat-block-cancel-*`), so a
    // back-to-actions step here would be a motion the screen's own controls
    // do not have. The state is one object with one open row in it, which
    // is why this is one case and not three.
    //
    // With nothing open it yields (`false`) and the router does what it
    // always did. Refs, not state: registered once, and a press can land
    // before a state has flushed. On iOS `BackHandler` is inert
    // (RegisterScreen's precedent), so this registers
    // unconditionally.
    const subscription = BackHandler.addEventListener(
      'hardwareBackPress',
      () => {
        if (menuRef.current === null) return false;
        setMenu(null);
        return true;
      },
    );
    return () => subscription.remove();
  }, []);

  /** Refresh reads chats and groups asynchronously and can overlap with
   * refreshes from writes or the coalesced notification callback. Apply a
   * result only if no newer refresh has started, or an older snapshot can
   * resurrect a deleted row. */
  const refreshSeq = useRef(0);
  const refresh = useCallback(() => {
    const seq = ++refreshSeq.current;
    const current = () => seq === refreshSeq.current;
    void db.listChats().then(async rows => {
      if (!current()) return;
      setChats(rows);
      // Set beside the rows it describes, and under the same sequence
      // guard: the gate lifts when a read that is still the newest has
      // actually answered, never on a snapshot that has been superseded.
      setLoaded(true);
      // The anchors identify the rooms among the rows. A row whose anchor
      // read fails renders as a person — the quiet posture every other
      // enhancement here takes — and its delete still re-checks the anchor.
      //
      // ONE READ, NOT ONE PER ROW. This was a getGroup per row
      // beside the four reads below — N+4 on the screen a person looks at
      // most, re-run inside every 80 ms notify window while a backlog
      // drains. `useCoalescedSubscribe` caps the RATE; it never capped the
      // cost. `listGroups` returns the same three columns `getGroup` reads,
      // so nothing downstream can tell where the anchor came from.
      const anchors = await db.listGroups().catch(() => []);
      if (!current()) return;
      // Filtered to the rows actually being drawn: the anchors table
      // outlives a locally deleted room, so it can hold
      // ids this list has no row for.
      const drawn = new Set(rows.map(row => row.peerId));
      setRooms(
        new Map(
          anchors
            .filter(anchor => drawn.has(anchor.groupId))
            .map(anchor => [anchor.groupId, anchor] as const),
        ),
      );
    },
    () => {
      // A FAILED READ OPENS THE GATE TOO. `loaded` exists to stop the empty
      // state flashing before the answer, not to withhold the screen
      // forever — and this read can reject: a connection closed under a
      // workspace switch or a relock is the ordinary case. Without this arm
      // the gate never lifted, and what was left was the header, the + and
      // nothing at all, with no way back but a remount. The empty state is
      // the wrong answer here, but it is a screen that offers a way out of
      // itself.
      if (current()) setLoaded(true);
    });
    void db.unreadCounts().then(
      counts => {
        if (current()) setUnread(counts);
      },
      () => {
        // Marks are an enhancement: a list without them still works.
      },
    );
    void db.listDrafts().then(
      byPeer => {
        if (current()) setDrafts(byPeer);
      },
      () => {
        // The unread mark's own quiet posture: a list without draft
        // prefixes still shows every conversation.
      },
    );
    void db.unreadRoomBodies().then(
      byRoom => {
        const hit = new Set<string>();
        for (const [peerId, bodies] of Object.entries(byRoom)) {
          for (const body of bodies) {
            // parseEnvelope, not the row's shape: parse-permissive on the
            // way in, but the badge itself asserts a fact ("you were
            // mentioned"), so only a well-formed mention whose `who` names
            // MY account may light it. `@you` rendering makes the same
            // check in the thread; the two can therefore never disagree.
            const envelope = parseEnvelope(body);
            if (
              envelope?.tcm === 'mention' &&
              envelope.who.includes(profile.userId)
            ) {
              hit.add(peerId);
              break;
            }
          }
        }
        if (current()) setMentioned(hit);
      },
      () => {
        // The unread marks' own quiet posture: a list that cannot read the
        // table still shows every conversation.
      },
    );
    void db.listBlockedPeers().then(
      ids => {
        if (current()) setBlockedIds(new Set(ids));
      },
      () => {
        // Same quiet posture as the unread marks: a list that cannot read the
        // table still shows every conversation, and enforcement does not live
        // here anyway.
      },
    );
    void db.listPendingApprovalSummaries(Date.now()).then(
      pending => {
        if (current()) setPendingApprovalCount(pending.length);
      },
      () => {
        if (current()) setPendingApprovalCount(null);
      },
    );
    setWsState(messaging.wsState);
    setMirrorStale(messaging.isBlockNotificationMirrorStale());
    // My own id is the mention check's constant; everything else here reads
    // fresh on every call.
  }, [profile.userId]);

  // ONE COALESCED REQUERY WINDOW per notify burst.
  // Under the wide shell this list is LIVE beside an open thread, and
  // messaging.notify() fires on every receipt, inbound frame, socket
  // transition and attachment tick — subscribed raw, a draining backlog
  // cost one full list requery (listChats + listGroups + three more reads)
  // PER notify, doubled against the thread's own requeries.
  // useCoalescedSubscribe gives the profile and composer screens the same
  // coalescing behavior; the
  // screen's own mutations (delete/block/unblock) keep calling refresh()
  // directly and are not delayed.
  useCoalescedSubscribe(refresh, REFRESH_DEBOUNCE_MS);

  // Colour alone cannot carry connection state, so the marker always travels
  // with the word.
  const connection = {
    open: { label: 'Connected', mark: t.color.pine, ink: t.color.inkMuted },
    connecting: {
      label: 'Connecting…',
      mark: t.color.warningMark,
      ink: t.color.warningInk,
    },
    closed: {
      // Named consequence, not a state: nothing typed is lost while closed.
      label: 'Offline — sends when you reconnect',
      mark: t.color.warningMark,
      ink: t.color.inkMuted,
    },
  }[wsState];

  /**
   * FIELD MODE, ON THE FIRST SCREEN. Derived from the same
   * getters Settings reads, so it cannot go stale and cannot disagree with
   * the chip; the router is not keep-alive, so this list remounts on every
   * return from Settings and the read is taken again.
   *
   * The precedence under the title is a strict order: a connection problem
   * outranks everything, then Field Mode, then nothing. In a coerced session
   * the derivation lands on Off — the same answer the Settings chip gives at
   * the same moment — so this line is the same fact at a second address, not
   * a new one, and adds no discriminator.
   */
  const fieldModeOn = useFieldModeActive();
  const showFieldMode = wsState === 'open' && fieldModeOn;

  const openChat = useCallback(
    (peerId: string) => {
      setMenu(null);
      // The thread reads the previous stamp before it clears unread state.
      // Writing here races that read, including in the retained wide pane.
      onOpenChat(peerId);
    },
    [onOpenChat],
  );

  const shareSelfId = useCallback(
    (anchor: ShareAnchor) => {
      void (async () => {
        try {
          // `message` only: adding a `url` makes iOS rank Safari above
          // Messages, and this id is meant for one person, not a post.
          await shareWithAnchor(
            { message: shareIdMessage(profile.userId) },
            anchor,
          );
        } catch {
          // Dismissing the sheet is not a failure.
        }
      })();
    },
    [profile.userId],
  );

  /**
   * The unread counts and the conversations already asked about, held as
   * refs so `changeMenu` can stay IDENTITY-STABLE. The
   * memoised row compares its props: a callback rebuilt whenever unread or
   * inbound changed would re-render every row in the list each time a
   * drawer opened, which is the exact defect the memo exists to prevent —
   * and `ChatListScreen.test.tsx` catches it.
   */
  const unreadRef = useRef(unread);
  useEffect(() => {
    unreadRef.current = unread;
  }, [unread]);
  const askedInbound = useRef(new Set<string>());
  const changeMenu = useCallback((peerId: string, next: RowMenu) => {
    setMenu(next === 'none' ? null : { peerId, step: next });
    // The one question the drawer cannot answer from what is already on
    // screen. Asked once per conversation per mount, and never for a
    // row that is already unread — unread IS inbound.
    if (next !== 'actions') return;
    if ((unreadRef.current[peerId] ?? 0) > 0) return;
    // Already proven, this run (see `inboundSeen`). Set in the same handler
    // as the menu itself, so the two land in one render and the drawer's
    // first paint is already the final one.
    if (inboundSeen.has(peerId)) {
      setInbound(prev =>
        prev[peerId] === true ? prev : { ...prev, [peerId]: true },
      );
      return;
    }
    if (askedInbound.current.has(peerId)) return;
    askedInbound.current.add(peerId);
    void db
      .listMessages(peerId)
      .then(rows => {
        const answered = rows.some(row => row.direction === 'in');
        if (answered) inboundSeen.add(peerId);
        setInbound(prev => ({ ...prev, [peerId]: answered }));
      })
      .catch(() => {
        // Unreadable means unknown, and unknown withholds: the row is never
        // offered on a guess. Asking again is allowed — the failure was the
        // read's, not the conversation's.
        askedInbound.current.delete(peerId);
      });
  }, []);

  /**
   * Pin, or unpin with null. Local to this workspace like everything else on
   * a chats row — never sent, so the person pinned is never told, and a pin
   * made under duress pins a decoy row while nothing real moves.
   */
  const pinChat = useCallback(
    async (peerId: string, at: number | null) => {
      try {
        await db.setPinned(peerId, at);
      } catch {
        return false;
      }
      setMenu(null);
      refresh();
      return true;
    },
    [refresh],
  );

  /**
   * Put the mark back on a conversation I have already read. This device
   * only: `syncThreadRead` propagates READ to my siblings and there is no
   * inverse envelope — a fact, not a defect, and nothing here claims
   * otherwise.
   */
  const markUnread = useCallback(
    async (peerId: string) => {
      try {
        await db.markChatUnread(peerId);
      } catch {
        return false;
      }
      setMenu(null);
      refresh();
      // Queued so it survives the drawer leaving the tree, the same way the
      // delete and block announcements are.
      AccessibilityInfo.announceForAccessibilityWithOptions(COPY.markedUnread, {
        queue: true,
      });
      return true;
    },
    [refresh],
  );

  const deleteChat = useCallback(
    async (peerId: string) => {
      let isRoom: boolean;
      try {
        // Routed on the anchor read NOW, not on render-time state: a room
        // must reach deleteGroup and NEVER deleteChat
        // — deleteChat on a room id deletes the room's messages
        // but spares its queued fan-out legs (their peerId is a MEMBER, not
        // the room, and `localMsgId IS NULL` protects them), so they keep
        // transmitting after the room is gone. deleteGroup finds the legs
        // through localMsgId and takes them with the room.
        isRoom = (await db.getGroup(peerId)) !== null;
        await (isRoom ? db.deleteGroup(peerId) : db.deleteChat(peerId));
      } catch {
        return false;
      }
      // The purge erased this conversation's outbox rows; drop their
      // in-flight entries too, or the retry timer re-arms forever over a map
      // it can never shrink (same orphan blockPeer prunes for itself).
      await messaging.pruneInflight();
      setMenu(null);
      refresh();
      // Queued so the announcement survives the row leaving the tree.
      AccessibilityInfo.announceForAccessibilityWithOptions(
        isRoom ? COPY.roomDeleted : COPY.deleted,
        { queue: true },
      );
      return true;
    },
    [refresh],
  );

  /**
   * Both writes go through messaging, never straight to the database: messaging
   * owns the hot-path Set that actually suppresses the beacons, and its
   * notify() is what makes the open thread agree with this list.
   */
  const blockPeer = useCallback(
    async (peerId: string) => {
      try {
        await messaging.blockPeer(peerId);
      } catch {
        return false;
      }
      setMenu(null);
      refresh();
      // The block IS enforced in-app, but if its lock-screen mirror
      // could not be written the announcement must say so rather than claim a
      // silence this device cannot yet keep.
      const partial = messaging.isBlockNotificationMirrorStale();
      // Queued so it survives the drawer leaving the tree.
      AccessibilityInfo.announceForAccessibilityWithOptions(
        partial ? BLOCK.partialMirror : BLOCK.blockedAnnounce,
        { queue: true },
      );
      return true;
    },
    [refresh],
  );

  const unblockPeer = useCallback(
    async (peerId: string) => {
      try {
        await messaging.unblockPeer(peerId);
      } catch {
        return false;
      }
      setMenu(null);
      refresh();
      // unblockPeer now awaits its mirror reconcile, so
      // this read is the settled truth — and an unblock the lock screen has
      // not heard about must not be announced as ordinary success while the
      // extension keeps silencing the person the owner just let back in.
      const partial = messaging.isBlockNotificationMirrorStale();
      AccessibilityInfo.announceForAccessibilityWithOptions(
        partial ? BLOCK.partialUnblockMirror : BLOCK.unblockedAnnounce,
        { queue: true },
      );
      return true;
    },
    [refresh],
  );

  // The one-time naming nudge: owed while the account is nameless AND
  // unanswered, whatever the list holds. Read once per mount — the answer
  // only ever moves one way. The App Lock nudge is read in the same pass and
  // committed in the same batch, so the two answers land together: naming
  // first, and the lock nudge never paints for a frame before the naming
  // answer arrives to hide it.
  const [nudge, setNudge] = useState(false);
  const [lockNudge, setLockNudge] = useState(false);
  /** The store build the soft update card is owed for, or null. Read in the
   * same pass and committed in the same batch as the other two, so the
   * three answers land together and no card paints for a frame before a
   * higher-priority one arrives to hide it. */
  const [softUpdate, setSoftUpdate] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    void (async () => {
      const naming = namingNudgeDue(profile, false)
        ? namingNudgeDue(
            profile,
            // An unreadable answer counts as answered: a nudge that cannot
            // settle must not show.
            await isNamingSettled().catch(() => true),
          )
        : false;
      const lockDue = await lockNudgeDue().catch(() => false);
      const softLatest = await softUpdateDue();
      if (!live) return;
      setNudge(naming);
      setLockNudge(lockDue);
      setSoftUpdate(softLatest);
    })();
    // The gate's answer can arrive AFTER this list mounted — the foreground
    // check is throttled to once per six hours and lands whenever it lands
    // — so the card is re-read on a decision change rather than at mount
    // only. The other two nudges have no such event: their answers are on
    // disk before the list exists.
    const off = updateGate.subscribe(() => {
      void (async () => {
        const softLatest = await softUpdateDue();
        if (live) setSoftUpdate(softLatest);
      })();
    });
    return () => {
      live = false;
      off();
    };
  }, [profile]);
  const skipSoftUpdate = useCallback(() => {
    const latest = softUpdate;
    setSoftUpdate(null);
    if (latest !== null) void dismissSoftUpdate(latest).catch(() => undefined);
  }, [softUpdate]);
  const settleNudge = useCallback(() => {
    setNudge(false);
    void skipNaming().catch(() => undefined);
  }, []);
  const addName = useCallback(() => {
    // Opening the profile IS the one showing: the nudge has done its job
    // whether or not a name gets saved there.
    settleNudge();
    onOpenProfile();
  }, [onOpenProfile, settleNudge]);
  const skipLockNudge = useCallback(() => {
    setLockNudge(false);
    void settleLockNudge().catch(() => undefined);
  }, []);
  const openAppLock = useMemo(
    () =>
      onOpenAppLock
        ? () => {
            // Same rule as addName: the one showing is spent by opening
            // Settings, whether or not a code gets set there.
            skipLockNudge();
            onOpenAppLock();
          }
        : undefined,
    [onOpenAppLock, skipLockNudge],
  );

  const filtering = chats.length >= FILTER_FROM;
  const trimmedQuery = query.trim();

  const visible = useMemo(() => {
    if (!filtering || trimmedQuery === '') return chats;
    // Rows already on this device only. Uppercased so a typed id tail matches
    // the stored id; no request is ever made. A room matches on its anchor's
    // name — the name its row actually shows.
    const needle = trimmedQuery.toUpperCase();
    return chats.filter(
      chat =>
        (chat.localName ?? '').toUpperCase().includes(needle) ||
        (chat.displayName ?? '').toUpperCase().includes(needle) ||
        (rooms.get(chat.peerId)?.name ?? '').toUpperCase().includes(needle) ||
        chat.peerId.includes(needle),
    );
  }, [chats, filtering, rooms, trimmedQuery]);

  // The header element MUST keep its identity across renders that do not
  // change it, or FlatList remounts the filter and the keyboard drops mid-word.
  const header = useMemo(
    () =>
      chats.length === 0 ? null : (
        <View>
          {/* The naming nudge heads a list that already has conversations:
              the existing nameless account is exactly who it is for. */}
          {nudge ? (
            <NamingNudge placement="list" onAdd={addName} onSkip={settleNudge} />
          ) : lockNudge ? (
            <LockNudge placement="list" onOpen={openAppLock} onSkip={skipLockNudge} />
          ) : softUpdate !== null ? (
            // Last in the chain on purpose: naming and the lock code are
            // one-time asks about this account's own safety, and a newer
            // build on the store can wait a launch behind either.
            <UpdateNudge
              placement="list"
              url={storeUrl(updateGate.policy)}
              onSkip={skipSoftUpdate}
            />
          ) : null}
          {filtering ? <FilterField value={query} onChange={setQuery} /> : null}
          {/* The room entry lives with the list, not behind the + : a room
              is made from rows already here, while + reaches someone new.
              With nobody here yet there is nobody to make a room from, so
              the empty state carries no room entry — deliberate. */}
          <View
            style={[
              styles.sectionRow,
              { marginHorizontal: t.layout.gutter },
            ]}
          >
            <Text
              style={[t.type.utilityLabel, { color: t.color.inkMuted }]}
              accessibilityRole="header"
            >
              {COPY.listLabel}
            </Text>
            <TextAction
              label={COPY.newRoom}
              onPress={onStartRoom}
              testID="new-room"
            />
          </View>
        </View>
      ),
    [
      addName,
      chats.length,
      filtering,
      lockNudge,
      nudge,
      onStartRoom,
      openAppLock,
      query,
      settleNudge,
      skipLockNudge,
      skipSoftUpdate,
      softUpdate,
      t,
    ],
  );

  const separator = useCallback(
    ({ leadingItem }: { leadingItem?: db.ChatRow }) =>
      // An open drawer already draws its own bottom hairline under that row;
      // a second one here would double the rule.
      leadingItem && menu?.peerId === leadingItem.peerId ? null : (
        <View
          style={{
            marginLeft: t.layout.separatorInset,
            height: t.hairline,
            backgroundColor: t.color.lineSoft,
          }}
        />
      ),
    [menu, t],
  );

  // blockedIds belongs here or FlatList will not repaint the row whose time
  // column and drawer both depend on it; rooms for the same reason — an
  // anchor arriving after the first paint renames the row.
  const listExtra = useMemo(
    () => ({
      menu,
      unread,
      blockedIds,
      rooms,
      mentioned,
      selectedPeerId,
      drafts,
      inbound,
    }),
    [
      menu,
      unread,
      blockedIds,
      rooms,
      mentioned,
      selectedPeerId,
      drafts,
      inbound,
    ],
  );
  const listInset = useMemo(() => {
    const clearance = FAB_BOTTOM + FAB_SIZE + t.space.s6;
    return { paddingBottom: clearance, indicator: { bottom: clearance } };
  }, [t]);

  /**
   * SCROLL MEMORY, in three parts.
   *
   * The offset is remembered in module scope (see `lastOffset`), forgotten
   * when the account changes, and put back EXACTLY ONCE — after the first
   * render that actually has rows. Once, not on every requery: a restore
   * per refresh would fight the person's own scrolling for as long as a
   * backlog takes to drain, which is precisely when someone is scrolling.
   *
   * `scrollToOffset` on the ref rather than the `contentOffset` prop: the
   * prop's Android support is not something to bet a release on, and the
   * list clamps an offset past its own end, so a shorter list simply lands
   * at its end instead of somewhere impossible.
   *
   * That same clamp is why the restore is armed by the effect and FIRED
   * from `onContentSizeChange`: before the list has measured, its content
   * size is zero and every offset clamps to the top.
   */
  const listRef = useRef<FlatList<db.ChatRow>>(null);
  const restored = useRef(false);
  /** Armed by the effect below, drained by `onContentSizeChange`. */
  const pendingRestore = useRef(false);
  // Read at the first render of this mount, before any effect can restore
  // from it: a different account — or the same account's other session —
  // inherits nothing. Guarded by its own ref so a re-render cannot re-zero
  // an offset this session has since written.
  const ownerChecked = useRef(false);
  if (!ownerChecked.current) {
    ownerChecked.current = true;
    const owner = `${session.mode}:${profile.userId}`;
    if (offsetOwner !== owner) {
      offsetOwner = owner;
      lastOffset = 0;
      inboundSeen.clear();
    }
  }
  const onScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      lastOffset = event.nativeEvent.contentOffset.y;
    },
    [],
  );
  const rowCount = visible.length;
  useEffect(() => {
    if (restored.current || !loaded || rowCount === 0) return;
    restored.current = true;
    if (lastOffset > 0) pendingRestore.current = true;
  }, [loaded, rowCount]);
  /**
   * WHERE THE RESTORE ACTUALLY FIRES. The effect above only ARMS it.
   *
   * A scroll offset set against a list that has not measured yet is a no-op:
   * the underlying scroll view clamps every offset to its own content size,
   * and at the commit that first has rows that size is still zero. Firing
   * there is how "comes back where you left it" silently stops holding on a
   * device while every jest assertion stays green — jest can see the call
   * and can never see where it landed. So the number waits here, for the
   * first report of a real content height, and is put back exactly once.
   */
  const onContentSizeChange = useCallback((_width: number, height: number) => {
    if (!pendingRestore.current || height <= 0) return;
    pendingRestore.current = false;
    listRef.current?.scrollToOffset({ offset: lastOffset, animated: false });
  }, []);

  // Stable across renders: the memoised row skips when its
  // props are unchanged, and that needs the callbacks — these five are
  // already useCallbacks — and this function to keep their identity.
  const renderRow = useCallback(
    ({ item }: { item: db.ChatRow }) => (
      <ConversationRow
        chat={item}
        room={rooms.get(item.peerId)}
        unread={(unread[item.peerId] ?? 0) > 0}
        mentioned={mentioned.has(item.peerId)}
        blocked={blockedIds.has(item.peerId)}
        selected={item.peerId === selectedPeerId}
        menu={menu?.peerId === item.peerId ? menu.step : 'none'}
        draft={drafts[item.peerId]}
        // Unread IS inbound, so the question only reaches the read rows —
        // and undefined means "not answered yet", which the row reserves the
        // space for rather than guessing at.
        canMarkUnread={
          (unread[item.peerId] ?? 0) > 0 ? true : inbound[item.peerId]
        }
        onOpen={openChat}
        onMenu={changeMenu}
        onDelete={deleteChat}
        onBlock={blockPeer}
        onUnblock={unblockPeer}
        onPin={pinChat}
        onMarkUnread={markUnread}
      />
    ),
    [
      blockPeer,
      blockedIds,
      changeMenu,
      deleteChat,
      drafts,
      inbound,
      markUnread,
      menu,
      mentioned,
      openChat,
      pinChat,
      rooms,
      selectedPeerId,
      unblockPeer,
      unread,
    ],
  );

  return (
    <View style={[styles.root, { backgroundColor: t.color.paperGround }]}>
      {/* The home header the Calls tab shares: one title role,
          one height, the same profile door — only the word changes when the
          tab does. The connection line rides under the title as before. */}
      <HomeHeader
        title={COPY.title}
        statusLine={
          /* Connection status needs attention only when it is not open. Keep the
             wrapper and its ws-<state> testID mounted for observation, but
             hide an empty wrapper from assistive technology so it does not
             add a meaningless navigation stop. */
          <View
            style={styles.connection}
            testID={`ws-${wsState}`}
            {...(wsState === 'open' && !showFieldMode
              ? {
                  accessibilityElementsHidden: true,
                  importantForAccessibility: 'no-hide-descendants' as const,
                }
              : {})}
          >
            {wsState === 'open' ? null : (
              <>
                <View
                  testID="ws-mark"
                  style={[
                    styles.connectionMark,
                    {
                      borderRadius: t.radius.tail,
                      backgroundColor: connection.mark,
                    },
                  ]}
                />
                <Text
                  numberOfLines={1}
                  style={[t.type.timeStatus, { color: connection.ink }]}
                >
                  {connection.label}
                </Text>
              </>
            )}
            {showFieldMode ? (
              /* Pressable when the host wired a route, plain words when it
                 did not — the LockNudge's rule: no control may promise a
                 door this screen was not given. */
              <Pressable
                {...(onOpenSettings
                  ? {
                      onPress: onOpenSettings,
                      accessibilityRole: 'button' as const,
                      accessibilityLabel: FIELD_MODE_COPY.homeAction,
                    }
                  : {})}
                testID="home-fieldmode"
                style={({ pressed }) => [
                  styles.fieldMode,
                  {
                    borderRadius: t.radius.tail,
                    backgroundColor: pressed
                      ? t.color.pineWash
                      : 'transparent',
                  },
                ]}
              >
                <Text
                  numberOfLines={1}
                  style={[t.type.timeStatus, { color: t.color.pine }]}
                >
                  {FIELD_MODE_COPY.homeLabel}
                </Text>
              </Pressable>
            ) : null}
          </View>
        }
        profile={profile}
        onOpenProfile={onOpenProfile}
        profileLabel={COPY.profileAction}
      />

      {/* The standing, VISIBLE form of the partial-mirror
          warning. The announcements above speak once, to VoiceOver, at the
          moment of the action; this stays for everyone, survives a relaunch
          (the flag is durable-seeded), and leaves with the reconcile that
          finally rewrites the file. */}
      {mirrorStale ? (
        <View style={{ paddingHorizontal: t.layout.gutter }}>
          <InlineError message={BLOCK.mirrorStale} testID="block-mirror-stale" />
        </View>
      ) : null}

      {onOpenAttention ? (
        <View style={[styles.attentionClamp, { maxWidth: t.layout.contentMax }]}>
          <Pressable
            onPress={onOpenAttention}
            accessibilityRole="button"
            accessibilityLabel={pendingApprovalCount === 0
              ? 'AI activity and setup'
              : `${COPY.attentionTitle}. ${pendingApprovalCount === null
                ? COPY.attentionUnknown
                : COPY.attentionCount(pendingApprovalCount)}`}
            accessibilityHint={pendingApprovalCount === 0 ? 'Opens agent activity and setup' : 'Opens requests waiting for your decision'}
            testID="open-attention"
            style={({ pressed }) => [
              styles.attentionDoor,
              pendingApprovalCount === 0 && styles.attentionQuiet,
              {
                backgroundColor: pressed
                  ? t.color.pineWash
                  : t.color.paperSheet,
                borderColor: t.color.lineSoft,
                borderLeftColor: pendingApprovalCount === 0 ? t.color.lineSoft : t.color.warningMark,
              },
            ]}
          >
            <View style={styles.attentionCopy}>
              {pendingApprovalCount === 0 ? (
                <Text style={[t.type.compactBody, { color: t.color.inkMuted }]}>AI activity and setup</Text>
              ) : <>
              <Text style={[t.type.bodyStrong, { color: t.color.inkStrong }]}>
                {COPY.attentionTitle}
              </Text>
              <Text style={[t.type.compactBody, { color: t.color.inkMuted }]}>

                {pendingApprovalCount === null
                  ? COPY.attentionUnknown
                  : COPY.attentionCount(pendingApprovalCount)}
              </Text>
              </>}
            </View>
            <Text
              allowFontScaling={false}
              accessibilityElementsHidden
              importantForAccessibility="no"
              style={[t.type.iconGlyph, { color: t.color.inkMuted }]}
            >
              ›
            </Text>
          </Pressable>
        </View>
      ) : null}

      <FlatList
        data={visible}
        extraData={listExtra}
        // THE READING COLUMN. Width only, and the
        // same clamp CallsScreen uses, so switching tabs changes the word
        // and not the measure. It never engages below 520pt, so no phone
        // moves; on a medium window — iPad portrait, Split View, most
        // Android tablets in portrait, the class that gets no pane
        // projection at all — 72pt rows stop being painted across the whole
        // glass. The FAB is deliberately OUTSIDE this: it hangs off the
        // window, or it drifts into the middle of a tablet's screen.
        style={[styles.clamp, { maxWidth: t.layout.contentMax }]}
        keyExtractor={chat => chat.peerId}
        keyboardShouldPersistTaps="handled"
        // The + button floats over the list's bottom edge: the content ends
        // one FAB-clearance above it, so the last row — and the Block/Delete
        // drawer it opens — scrolls clear of the disc instead of sitting
        // under it. The indicator is inset by the same amount.
        contentContainerStyle={listInset}
        scrollIndicatorInsets={listInset.indicator}
        ListHeaderComponent={header}
        ItemSeparatorComponent={separator}
        ref={listRef}
        // The place the list was left, written cheaply and restored once
        //. 100 ms is the same window the refresh coalescing holds:
        // often enough that a fast flick is remembered accurately, rare
        // enough that scrolling costs nothing.
        onScroll={onScroll}
        scrollEventThrottle={100}
        // The restore's real trigger: an offset set before the list has a
        // content size is clamped to nothing (see `onContentSizeChange`).
        onContentSizeChange={onContentSizeChange}
        ListEmptyComponent={
          // NOTHING until the first read answers. A
          // filter that matched nothing is a different question and only
          // reachable once there are rows, so it sits inside the gate.
          !loaded ? null : filtering && trimmedQuery !== '' ? (
            // The Quiet Room is reserved for genuinely having nobody; a filter
            // that matched nothing is not that.
            <Text
              style={[
                t.type.compactBody,
                styles.noMatch,
                { color: t.color.inkMuted },
              ]}
            >
              {COPY.noMatch}
            </Text>
          ) : (
            <EmptyChats
              profile={profile}
              onShare={shareSelfId}
              nudge={
                nudge ? (
                  <NamingNudge
                    placement="empty"
                    onAdd={addName}
                    onSkip={settleNudge}
                  />
                ) : lockNudge ? (
                  <LockNudge
                    placement="empty"
                    onOpen={openAppLock}
                    onSkip={skipLockNudge}
                  />
                ) : softUpdate !== null ? (
                  <UpdateNudge
                    placement="empty"
                    url={storeUrl(updateGate.policy)}
                    onSkip={skipSoftUpdate}
                  />
                ) : null
              }
            />
          )
        }
        renderItem={renderRow}
      />

      {/* The one way to reach someone new. A flat pine circle on the paper —
          no shadow, no float; it reads as furniture, not a layer. */}
      <Pressable
        onPress={onStartChat}
        accessibilityRole="button"
        accessibilityLabel={COPY.startTitle}
        testID="new-chat-fab"
        style={({ pressed }) => [
          styles.fab,
          {
            right: t.layout.gutter,
            borderRadius: t.radius.circle,
            backgroundColor: pressed ? t.color.pinePressed : t.color.pine,
          },
        ]}
      >
        {/* Frozen, like every other glyph in this file: at
            fontSize 30 with no cap the + scales to about 93pt inside a
            56pt disc. The label above carries the meaning at any size. */}
        <Text
          allowFontScaling={false}
          style={[t.type.iconGlyph, styles.fabGlyph, { color: t.color.onPine }]}
        >
          +
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },

  connection: { flexDirection: 'row', alignItems: 'center', marginTop: 2 },
  connectionMark: { width: 6, height: 6, marginRight: 6 },
  /** The Field Mode line's own press box, inside the status row. Negative
   * inset so the words stay on the header's grid while the target grows. */
  fieldMode: { marginLeft: -6, paddingHorizontal: 6, paddingVertical: 2 },

  filterWrap: { paddingTop: 12, paddingBottom: 12 },
  filterInput: { paddingHorizontal: 14 },

  // Label left, the room entry right; the TextAction's own 44pt box carries
  // the height, so the label centres against it instead of the old margins.
  sectionRow: {
    marginTop: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },

  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10 },
  rowGap: { width: 12, alignItems: 'center' },
  unreadMark: { width: 6, height: 6 },
  /** The pinned mark, sized to sit in the same 12pt gutter as the 6pt unread
   * dot without widening it. Fixed, because it never scales. */
  pinMark: { fontSize: 9, lineHeight: 11 },
  rowBody: { flex: 1 },
  rowTopLine: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
  },
  rowName: { flexShrink: 1 },
  rowTime: { marginLeft: 8 },
  rowPreviewLine: { flexDirection: 'row', alignItems: 'center', marginTop: 3 },
  rowPreview: { flex: 1 },
  /** minWidth/minHeight, never a fixed box: the @ glyph scales with the
   * person's text size and the pill grows around it instead of clipping. */
  mentionBadge: {
    minWidth: 22,
    minHeight: 20,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 5,
    marginLeft: 8,
  },

  /** The trailing … target: a 44pt disc at the row's edge, held in by
   * the row's own gutter. */
  rowMore: { alignItems: 'center', justifyContent: 'center', marginLeft: 4 },

  rowDrawer: { width: '100%' },
  rowDrawerAction: { justifyContent: 'center' },
  rowDrawerNote: { paddingBottom: 12 },
  rowConfirm: { borderLeftWidth: 3, padding: 12 },
  /** The second confirm line sits under the first, in the same measure. */
  rowConfirmAlso: { marginTop: 6 },
  rowConfirmBody: { marginTop: 8 },
  confirmActions: { flexDirection: 'row', alignItems: 'center', marginTop: 10 },
  /** The kit's compact OutlineButton beside the TextAction: only the gap
   * between them is this screen's. */
  confirmDelete: { marginLeft: 8 },

  noMatch: { marginTop: 24, textAlign: 'center' },

  /** Full width until contentMax caps it — CallsScreen's own expression. */
  clamp: { width: '100%', alignSelf: 'center' },
  attentionClamp: {
    width: '100%',
    alignSelf: 'center',
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  attentionDoor: {
    minHeight: 60,
    borderWidth: StyleSheet.hairlineWidth,
    borderLeftWidth: 3,
    borderRadius: 2,
    paddingHorizontal: 12,
    paddingVertical: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  attentionQuiet: { minHeight: 44, borderLeftWidth: StyleSheet.hairlineWidth, paddingVertical: 4 },
  attentionCopy: { flex: 1, gap: 2 },

  fab: {
    position: 'absolute',
    bottom: FAB_BOTTOM,
    width: FAB_SIZE,
    height: FAB_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  fabGlyph: { fontSize: 30, lineHeight: 34 },

  emptyState: { marginTop: 40, alignItems: 'center' },
  emptyTitle: { marginTop: 20, textAlign: 'center' },
  steps: { marginTop: 20, width: 280 },
  step: { flexDirection: 'row' },
  stepGap: { marginTop: 16 },
  stepNumeral: { width: 20, marginTop: 3 },
  stepBody: { flex: 1 },
  stepAction: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginLeft: -8,
  },
  emptyHint: { marginTop: 16 },

  nudge: { padding: 16 },
  nudgeEmpty: { marginTop: 28, width: 280 },
  nudgeList: { marginTop: 8, marginBottom: 12 },
  nudgeBody: { marginTop: 6, marginBottom: 4 },
  nudgeActions: { flexDirection: 'row', gap: 4, marginLeft: -8, marginTop: 4 },
});
