import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  AccessibilityInfo,
  // Deprecated in core but still shipped (the StartChatScreen trade): a
  // paste target is the whole point of an id.
  Clipboard,
  FlatList,
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
import { isNamingSettled, namingNudgeDue, skipNaming } from '../naming';
import { NAMING_COPY } from '../namingCopy';
import { shareIdMessage } from '../peerId';
import { personName, sanitizeDisplayName } from '../person';
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
}

const COPY = {
  title: 'Chats',
  profileAction: 'Open your profile',

  startTitle: 'Start a chat',
  // The share text itself is `shareIdMessage` (peerId.ts): one helper, so
  // every surface sends the id on a line of its own.

  listLabel: 'Your chats',
  filterLabel: 'Filter conversations',
  noMatch: 'No conversation matches that.',
  previewNone: 'No messages yet',
  previewUnreadable: 'Message couldn’t be opened',
  unread: (label: string, preview: string) =>
    `${label}, new messages, ${preview}`,
  /** A room mentioned YOU (the mentions contract). The @ mark is visual
   * only, so the fact travels in the label — the same rule the room word
   * follows. */
  unreadMention: (label: string, preview: string) =>
    `${label}, new messages, you were mentioned, ${preview}`,

  rowActions: 'Conversation actions',
  deleteChat: 'Delete conversation',
  // The device is named in the
  // platform's own words via the token, here and in the room copy below.
  deleteConfirm: `Delete this conversation? The messages are only on this ${DEVICE_NOUN} — Tacendum has no copy to restore.`,
  keep: 'Keep',
  delete: 'Delete',
  deleted: 'Conversation deleted.',
  deleteFailed: 'Tacendum couldn’t delete this chat. Try again.',

  // Rooms. Deleting a room is LOCAL — the
  // room lives on for its other members — and the recreate rule is said
  // rather than hidden: rule 22 forbids copy that implies more was removed
  // than was.
  newRoom: 'New room',
  roomFallbackName: 'Room',
  deleteRoom: 'Delete room',
  roomDeleteConfirm:
    `Delete this room from this ${DEVICE_NOUN}? Its messages here are only on this ` +
    `${DEVICE_NOUN} — Tacendum has no copy to restore. The other members keep ` +
    'theirs, and while the room stays active with you in it, it can return.',
  roomDeleted: `Room deleted from this ${DEVICE_NOUN}.`,

  /** What VoiceOver hears for a room row. The walled-square mark is visual
   * only, so the WORD travels in the label — a distinction that exists only
   * visually is not a distinction for everyone. */
  roomSpoken: (label: string) => `${label}, room`,

  // No seat count: a conversation here is one other person or a room full
  // of them, and the empty state may not promise either.
  emptyCaption: 'This seat is yours',
  emptyRoom: 'A private space waiting for the people you invite',
  emptyTitle: 'Nobody else is here yet',
  stepOne: 'Send someone your ID.',
  stepTwo: 'Tap +, then enter theirs.',
  /** Where a conversation's actions live: Block and Delete sit behind a
   * long press and the … each row carries, and nothing on the screen
   * used to say so. */
  actionsHint: 'Later, the … beside a chat holds Block and Delete.',
  copyId: 'Copy ID',
  shareId: 'Share ID',
  // Byte-identical to StartChatScreen.tsx — the same copy action must never
  // get two different sentences.
  copied:
    'Copied. Paste it into a text — or read it out loud, four letters at a time.',

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
  onOpen,
  onMenu,
  onDelete,
  onBlock,
  onUnblock,
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
  onOpen: (peerId: string) => void;
  onMenu: (peerId: string, next: RowMenu) => void;
  onDelete: (peerId: string) => Promise<boolean>;
  onBlock: (peerId: string) => Promise<boolean>;
  onUnblock: (peerId: string) => Promise<boolean>;
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
  // A name I gave outranks the card they shared, so the disc and the line
  // under it can never disagree about who this is — and a card that
  // sanitizes away is not a name, exactly as personName drops it.
  const named =
    room !== undefined ||
    (sanitizeDisplayName(chat.localName) ||
      sanitizeDisplayName(chat.displayName)) !== '';
  const preview = previewLine(chat);

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
              accessibilityLabel: BLOCK.rowLabel(
                room ? COPY.roomSpoken(label) : label,
                preview,
              ),
            }
          : unread || (room && mentioned)
            ? {
                // "you were mentioned" outranks the plain unread sentence:
                // being addressed is the one fact worth adding words for.
                accessibilityLabel: (room && mentioned
                  ? COPY.unreadMention
                  : COPY.unread)(room ? COPY.roomSpoken(label) : label, preview),
              }
            : room
              ? {
                  accessibilityLabel: `${COPY.roomSpoken(label)}, ${preview}`,
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
            the — initials of the room's name, or the ULID's tail when it
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
              {preview}
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
                    backgroundColor: t.color.pineWash,
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
              {/* Reversible above irreversible. Blocking is protective, not
                  destructive, so it takes the pine wash: two stacked red rows
                  read as one undifferentiated hazard. A ROOM offers no Block
                  at all — blocking a room is not a thing; a member is
                  blocked from their own conversation, and leaving is the
                  room-shaped act. */}
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
        // Paper and a slate rule, never the danger wash: this is the person's
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
              // Paper layer under a danger wash measures under AA.
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
              backgroundColor: t.color.dangerWash,
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
              // Danger wash on danger wash measures under AA.
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
            borderColor: focused ? t.color.pine : t.color.lineStrong,
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
              { color: t.color.pine },
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
              { color: t.color.pine },
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
  body: 'Your chats are only as private as this phone’s lock. A lock code of your own is asked for whenever Tacendum opens.',
  where: 'Turn it on in Settings → App Lock, whenever you like.',
  open: 'Open Settings',
  skip: 'Not now',
  infoLabel: 'What a lock code does',
  infoLines: [
    'With App Lock on, Tacendum asks for its own code when it opens and after it has been in the background — on top of the phone’s passcode.',
    'The code never leaves this phone. Forgetting it means setting the app up again, so pick one you will remember.',
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
}: Props) {
  const t = useTheme();
  const [chats, setChats] = useState<db.ChatRow[]>([]);
  /**
   * Which rows are rooms, keyed by the room's ULID, carrying the anchor
   * (owner + name). Read from the `groups` anchor per row because
   * `listChats` does not select the columns — the anchor is the one
   * place a room's constants live anyway.
   */
  const [rooms, setRooms] = useState<Map<string, db.GroupRow>>(new Map());
  const [unread, setUnread] = useState<Record<string, number>>({});
  /** Rooms whose unread messages mention ME — the @ badge (the mentions
   * contract). Decided HERE, against the parsed envelope's `who` and my
   * own account id: the db read hands over bodies, never judgements, so a
   * body that merely wears a mention's shape cannot light the badge. */
  const [mentioned, setMentioned] = useState<Set<string>>(new Set());
  const [wsState, setWsState] = useState(messaging.wsState);
  const [query, setQuery] = useState('');
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

  /** Sequenced (CallsScreen's own guard): this refresh is N async reads
   * long — listChats, then a getGroup per row — and it is called both
   * directly after a delete/block and from the 80 ms notify window, so two
   * can overlap. Every set below lands only if no newer refresh has
   * started since, or a just-deleted row's OLDER snapshot could resolve
   * last and paint the row back. */
  const refreshSeq = useRef(0);
  const refresh = useCallback(() => {
    const seq = ++refreshSeq.current;
    const current = () => seq === refreshSeq.current;
    void db.listChats().then(async rows => {
      if (!current()) return;
      setChats(rows);
      // The anchors identify the rooms among the rows. A row whose anchor
      // read fails renders as a person — the quiet posture every other
      // enhancement here takes — and its delete still re-checks the anchor.
      const anchors = await Promise.all(
        rows.map(
          async row =>
            [row.peerId, await db.getGroup(row.peerId).catch(() => null)] as const,
        ),
      );
      if (!current()) return;
      setRooms(
        new Map(
          anchors.filter((pair): pair is [string, db.GroupRow] => pair[1] !== null),
        ),
      );
    });
    void db.unreadCounts().then(
      counts => {
        if (current()) setUnread(counts);
      },
      () => {
        // Marks are an enhancement: a list without them still works.
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
    setWsState(messaging.wsState);
    setMirrorStale(messaging.isBlockNotificationMirrorStale());
    // My own id is the mention check's constant; everything else here reads
    // fresh on every call.
  }, [profile.userId]);

  // ONE COALESCED REQUERY WINDOW per notify burst.
  // Under the wide shell this list is LIVE beside an open thread, and
  // messaging.notify() fires on every receipt, inbound frame, socket
  // transition and attachment tick — subscribed raw, a draining backlog
  // cost one full list requery (listChats + a getGroup per row + three
  // more reads) PER notify, doubled against the thread's own requeries.
  // The window itself lives in useCoalescedSubscribe now, so the profile
  // and composer screens hold the same one; the screen's own mutations
  // (delete/block/unblock) keep calling refresh() directly and are not
  // delayed.
  useCoalescedSubscribe(refresh, REFRESH_DEBOUNCE_MS);

  // Colour alone cannot carry connection state, so the marker always travels
  // with the word (the bare dot is cut).
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

  const openChat = useCallback(
    (peerId: string) => {
      setMenu(null);
      // Written on navigate, so a message that arrives while you are already
      // inside the thread marks the row until you back out and return.
      void db.markChatOpened(peerId, Date.now());
      // Sibling sync 'read': siblings clear their badge for this thread too.
      void messaging.syncThreadRead(peerId);
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

  const changeMenu = useCallback((peerId: string, next: RowMenu) => {
    setMenu(next === 'none' ? null : { peerId, step: next });
  }, []);

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
      if (!live) return;
      setNudge(naming);
      setLockNudge(lockDue);
    })();
    return () => {
      live = false;
    };
  }, [profile]);
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
    () => ({ menu, unread, blockedIds, rooms, mentioned, selectedPeerId }),
    [menu, unread, blockedIds, rooms, mentioned, selectedPeerId],
  );
  const listInset = useMemo(() => {
    const clearance = FAB_BOTTOM + FAB_SIZE + t.space.s6;
    return { paddingBottom: clearance, indicator: { bottom: clearance } };
  }, [t]);

  // Stable across renders: the memoised row skips when its props are
  // unchanged, and that needs the callbacks — these five are already
  // useCallbacks — and this function to keep their identity.
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
        onOpen={openChat}
        onMenu={changeMenu}
        onDelete={deleteChat}
        onBlock={blockPeer}
        onUnblock={unblockPeer}
      />
    ),
    [
      blockPeer,
      blockedIds,
      changeMenu,
      deleteChat,
      menu,
      mentioned,
      openChat,
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
          <View style={styles.connection} testID={`ws-${wsState}`}>
            <View
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

      <FlatList
        data={visible}
        extraData={listExtra}
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
        ListEmptyComponent={
          filtering && trimmedQuery !== '' ? (
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
        <Text style={[t.type.iconGlyph, styles.fabGlyph, { color: t.color.onPine }]}>
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
  rowConfirmBody: { marginTop: 8 },
  confirmActions: { flexDirection: 'row', alignItems: 'center', marginTop: 10 },
  /** The kit's compact OutlineButton beside the TextAction: only the gap
   * between them is this screen's. */
  confirmDelete: { marginLeft: 8 },

  noMatch: { marginTop: 24, textAlign: 'center' },

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
