/**
 * Everything the app knows about blocking a person that is not a database
 * read, a network call, or a screen: what a block permits, what it forbids,
 * what that state looks like, and what it says.
 *
 * THE PROPERTY THIS MODULE EXISTS FOR: a blocked person must not be able to
 * tell that they have been blocked. Not from a delivery failure, not from a
 * missing receipt, not from a timing difference, not from a network callback.
 * To them the conversation must look exactly like one where the other person
 * simply stopped replying. That property is not held by any single line of
 * code — it is held by every path agreeing, which is why the decision lives in
 * one table here rather than in an `if` at each site. Scattered booleans
 * drift; one vocabulary cannot. Enforcement sites read as sentences from this
 * module.
 *
 * Deliberately pure, exactly like safety.ts: no db, no messaging, no envelope
 * import, and from react-native only `Platform` — a plain constant, imported
 * for the one copy branch whose SUBSTANCE diverges by platform (the
 * screenshot-notice list) — so it is unit-testable on its own and
 * cannot pull a screen's worth of dependencies into a test of a sentence.
 * The device NOUN is not a branch here any more: sentences interpolate
 * `DEVICE_NOUN`, so
 * the copy names whatever it is actually running on.
 *
 * NAMING, non-negotiable. `messaging.isPeerBlocked()` already means "sending
 * is paused by an unaccepted identity change" and feeds
 * `safetyStateFor({ blocked })` -> 'changed'. Nothing here is named `blocked`:
 * the state is `blockedAt` / `peerBlocked`, the messaging predicate is
 * `isBlockedLocally`, and a BlockState value must NEVER reach safetyStateFor.
 * A block is not an identity change, and a person who blocks someone must
 * never be shown a safety alarm for having done so.
 *
 * ACCEPTED RESIDUALS — enforcement is client-side only:
 *
 * - There is no server change, no new endpoint, and no server-side record of
 *   who blocked whom. A server-side block list would be a social graph on the
 *   server, which this product deliberately does not have (no
 *   directory, no lookup, no server-side profile).
 * - Because of that, a blocked peer can still queue ciphertext at you and can
 *   still consume your one-time prekeys by fetching your bundle. Both are
 *   already bounded by the existing per-caller rate limits and the 30-day
 *   message TTL, and neither is visible to the blocked person.
 * - The block record is local to this device AND to this workspace file. It
 *   does not survive a reinstall or an account delete, and a duress workspace
 *   keeps its own separate list.
 * - blocking.ts and safety.ts are now two copy decks describing adjacent
 *   per-peer states, and they can drift — precisely the failure safety.ts:6-11
 *   was created to end. safety.ts was not editable in this task; merging the
 *   two decks is a follow-up.
 */

import { Platform } from 'react-native';
import { DEVICE_NOUN } from './deviceNoun';

/**
 * Theme colour keys this module is allowed to name, exactly the SafetyTone
 * contract: keys into `theme.color`, resolved by the screen, so the palette
 * has one definition and this module still imports no react-native.
 *
 * `danger` and `dangerWash` are deliberately absent from this union. A block
 * is the person's own settled decision, not an alarm — safety.ts:60 already
 * assigns warningMark/warningInk to "a thing to do, not a thing gone wrong",
 * and rendering someone's own choice in red frames it as a fault. Red stays
 * reserved for the irreversible (delete) and the alarming (identity change).
 */
export type BlockTone =
  | 'warningMark'
  | 'warningInk'
  | 'paperLayer'
  | 'lineStrong'
  | 'inkMuted'
  | 'inkStrong'
  | 'inkBody';

/**
 * The whole of what this module is told about a conversation. Every predicate
 * takes this one object so that a caller cannot accidentally pass the
 * identity-change flag into a block decision, or the reverse.
 */
export interface BlockState {
  /** When this device blocked them, or null. */
  blockedAt: number | null;
}

/**
 * `!= null` rather than a truthiness check on purpose: a block recorded at
 * epoch 0 is still a block.
 */
export function isBlocked(state: BlockState): boolean {
  return state.blockedAt != null;
}

/**
 * Every kind of thing this app can put on the wire toward one person. Each one
 * is a liveness beacon: it proves you are online, that you received their
 * traffic, and that you are reading it.
 *
 * 'deliveryReceipt' names a capability this app does not have yet. It is
 * listed so that adding it is a compile error in OUTBOUND_WHILE_BLOCKED
 * rather than a silent new beacon. ('typingState' was reserved the same way
 * and is live now.)
 */
export type OutboundKind =
  /** Text, reply, image — anything a person composed. */
  | 'message'
  | 'reaction'
  | 'edit'
  | 'retraction'
  | 'screenshotNotice'
  | 'profileCard'
  /** A Shared Room Vault write. Its OWN kind rather than a
   * reuse of 'message', so that the day someone decides a vault op should keep
   * flowing to a blocked person it has to be argued for in this table instead
   * of inherited by accident. */
  | 'vaultItem'
  /** One leg of a room fan-out — `grp.msg` wrapping whatever a member
   * composed. Its own kind for vaultItem's exact reason:
   * today a room containing a blocked member is READ-ONLY, so nothing fans
   * around them — but the day someone argues room traffic to a blocked
   * member is different from 1:1 text (it demonstrably is: N-1 other people
   * already see it), the argument has to be made in this table rather than
   * inherited from a decision made for a private message. */
  | 'groupMessage'
  /** A room membership or settings envelope — `grp.new` / `grp.roster` /
   * `grp.set` / `grp.del`. Separate from
   * 'groupMessage' because roster writes already carry ARGUED exceptions the
   * conversation kind must never inherit: The two exits (my own leave,
   * the owner's delete-for-everyone) proceed past a block as visible failed
   * legs, and a Remove deliberately fans to the removed member. Widening any
   * of that to ordinary room speech has to be argued here, not drifted into. */
  | 'groupRoster'
  /** "I read your messages." Its own kind rather than a reuse of 'message',
   * so that the day someone argues a receipt is harmless enough to keep
   * flowing to a blocked person, the argument has to be made in this table.
   * It is not harmless: it proves the device is live, being used, and by
   * someone who opened the thread. */
  | 'readReceipt'
  /** Call signalling: offer/answer/ice/end. A blocked person must not be able to make your phone ring. */
  | 'callSignal'
  /** An outbox row flushing. */
  | 'queuedEnvelope'
  /** Reserved: no client-originated receipt exists today. */
  | 'deliveryReceipt'
  /** "I am composing toward you, right now" — the sharpest liveness beacon
   * this app can emit. Sent only inside relay-only typing
   * frames; while blocked, never. */
  | 'typingState';

/**
 * THE TABLE. While a person is blocked, this device sends them nothing.
 *
 * Typed `Record<OutboundKind, false>` on purpose, twice over: the type forbids
 * writing a `true` here, and a newly added OutboundKind fails to compile until
 * it is listed. There is no way to add an outbound path to this app and
 * quietly leave it leaking.
 */
export const OUTBOUND_WHILE_BLOCKED: Record<OutboundKind, false> = {
  message: false,
  reaction: false,
  edit: false,
  retraction: false,
  screenshotNotice: false,
  profileCard: false,
  vaultItem: false,
  groupMessage: false,
  groupRoster: false,
  readReceipt: false,
  callSignal: false,
  queuedEnvelope: false,
  deliveryReceipt: false,
  typingState: false,
};

/** May this device send them this? While they are blocked: never. */
export function maySendTo(kind: OutboundKind, state: BlockState): boolean {
  return isBlocked(state) ? OUTBOUND_WHILE_BLOCKED[kind] : true;
}

/** The two things an inbound message can ask this phone to go and fetch. */
export type InboundFetchKind = 'attachment' | 'avatar';

/**
 * No blob a blocked person can point at is ever fetched.
 *
 * This is the subtlest requirement in the feature and the easiest to miss: a
 * blob fetch is a read receipt through a side channel — it proves to anyone
 * watching the blob store that you received and parsed their message. A
 * download needs no envelope, no receipt and no reply to give you away, and it
 * happens automatically, which is exactly why it has to be refused by policy
 * rather than by remembering.
 */
export const FETCH_WHILE_BLOCKED: Record<InboundFetchKind, false> = {
  attachment: false,
  avatar: false,
};

/**
 * May this device fetch a blob on their behalf? While they are blocked: never.
 * Enforce this both where the fetch is queued and again immediately before the
 * first network call, because the download queue drains long after the frame
 * that filled it was handled.
 */
export function mayFetchFor(
  kind: InboundFetchKind,
  state: BlockState,
): boolean {
  return isBlocked(state) ? FETCH_WHILE_BLOCKED[kind] : true;
}

/**
 * ALWAYS true, including while blocked. Refusing to decrypt would desync the
 * Double Ratchet and leave the session broken if they are later unblocked, so
 * a blocked peer's frame is decrypted and then discarded — decrypt, then drop.
 * The cost is accepted: their traffic still spends CPU and still advances the
 * ratchet.
 */
export function mayDecryptInbound(_state: BlockState): true {
  return true;
}

/** Decrypted, then dropped: while blocked, nothing they send is written down. */
export function mayPersistInbound(state: BlockState): boolean {
  return !isBlocked(state);
}

/**
 * ALWAYS true, including while blocked. An un-acked queue is both a growing
 * backlog and a behavioural difference; the queue must drain exactly as it
 * would for anyone else. The ack goes to the SERVER and is never routed to the
 * peer, so acking is byte-identical to the unblocked case — and NOT acking
 * would be the observable difference this feature exists to avoid.
 */
export function mustAckInbound(_state: BlockState): true {
  return true;
}

/**
 * Governs inbound edit, retraction and reaction. A blocked person must not be
 * able to rewrite or retract messages already sitting on your phone — that is
 * a security property, not a side effect of dropping their traffic.
 */
export function mayApplyPeerMutation(state: BlockState): boolean {
  return !isBlocked(state);
}

/**
 * The state's rule colour and its label ink, named as TOKEN KEYS rather than
 * literals — the SAFETY_STATUS contract exactly, so a screen resolves them
 * against the live theme.
 */
export function blockStatusTone(state: BlockState): {
  rule: BlockTone;
  ink: BlockTone;
} {
  return isBlocked(state)
    ? /** A thing this person chose, not a thing gone wrong. */
      { rule: 'warningMark', ink: 'warningInk' }
    : { rule: 'lineStrong', ink: 'inkMuted' };
}

/**
 * What blocking actually does, said plainly and before it is used. The honest
 * version is the useful one: an app that implies a block stops delivery leaves
 * someone believing they are unreachable by a person who is still sending.
 */
export const BLOCK_EXPLAINER: string[] = [
  `Blocking is a setting on this ${DEVICE_NOUN}. They are never told, and nothing about their app changes.`,
  'It does not stop them sending. Their messages still arrive here, and Tacendum discards them without saving them or showing you.',
  // The Android list omits "no screenshot notices" deliberately: screenshots
  // are BLOCKED there ("prevented, not disclosed"), so no such notice
  // exists to withhold — naming it would imply it otherwise fires. This is a
  // SUBSTANCE divergence, so the Platform branch stays; only the noun is
  // token-rendered.
  Platform.OS === 'android'
    ? `While they are blocked, this ${DEVICE_NOUN} sends them nothing: no replies, no delivery or read marks, no reactions, no calls. To them the chat looks like one where you stopped replying.`
    : `While they are blocked, this ${DEVICE_NOUN} sends them nothing: no replies, no delivery or read marks, no reactions, no screenshot notices, no calls. To them the chat looks like one where you stopped replying.`,
];

/**
 * One copy deck for all three screens — the chat list, the peer profile and
 * the thread — so the same state cannot come to be described three different
 * ways. Nothing here claims the block stops, prevents or shields: the second
 * explainer line says it does not stop them sending, and every sentence that
 * follows names discard-on-arrival instead.
 */
export const BLOCK_COPY = {
  /** Section header on the peer profile. */
  title: 'Blocking',
  /** The action that starts the two-step block. */
  action: 'Block this person',
  statusLabel: `Blocked on this ${DEVICE_NOUN}`,
  notBlockedLabel: 'Not blocked',
  confirmQuestion: `Block them on this ${DEVICE_NOUN}?`,
  /** The consequence, stated above the button rather than after it. */
  confirmBody:
    'Anything they send from now on is discarded as it arrives — Tacendum keeps no copy, so unblocking will not bring it back.',
  confirm: 'Block',
  cancel: 'Cancel',
  blockedTitle: 'You blocked this person.',
  blockedBody:
    'Their messages arrive here and are discarded. They are not saved, and they will not appear if you unblock.',
  blockedQuiet: 'Nothing is sent to them from this chat.',
  unblock: 'Unblock',
  /** Replaces the timestamp in the chat list row. */
  rowStatus: 'Blocked',
  /** The row for VoiceOver: the state that changes behaviour is said first after the name. */
  rowLabel: (label: string, preview: string) => `${label}, blocked, ${preview}`,
  /**
   * Why a blocked conversation offers no Delete: the block deliberately
   * survives conversation deletion, so deleting here would strand it with no
   * surface left to reverse it.
   */
  drawerBlockedNote:
    'Unblock first if you want to delete this conversation — deleting it here would take the only way back with it.',
  /** Said when the composer is replaced by the banner; nothing else announces that. */
  bannerAnnounce: `The composer is closed. You blocked this person on this ${DEVICE_NOUN}.`,
  blockedAnnounce: `Blocked. Their messages will be discarded on this ${DEVICE_NOUN}.`,
  unblockedAnnounce: 'Unblocked. Their messages will appear here again.',
  /** Shown only when the write itself failed, so the sentence is true. */
  failed: 'Tacendum couldn’t save that. Try again.',
  /**
   * The block committed and IS enforced in this app, but the file
   * the lock screen reads to silence their calls and banners could not be
   * written (a storage fault). The block is real; what may still leak is a
   * notification, until Tacendum can rewrite that file — which it retries on
   * its own the next time it opens.
   */
  partialMirror:
    'Blocked here. A storage problem means their calls and notifications may still reach your lock screen until you reopen Tacendum.',
  /**
   * The same failure in the other direction. The unblock
   * committed and in-app delivery IS restored, but the lock-screen file could
   * not be rewritten, so the extension keeps silencing someone the owner
   * deliberately let back in — which reads as "their messages never arrive".
   */
  partialUnblockMirror:
    'Unblocked here. A storage problem means their calls and notifications may stay silenced on your lock screen until you reopen Tacendum.',
  /**
   * The STANDING form of both sentences above, shown wherever blocking is
   * offered while the durable dirty marker is set. Direction-neutral on
   * purpose: the marker records that the mirror file could not be written,
   * not which change it was carrying, and after a relaunch nobody remembers.
   */
  mirrorStale:
    'A storage problem is keeping your lock screen out of step with your block list. Calls and notifications may not follow your latest change until you reopen Tacendum.',
} as const;

/* ── disappearing messages ────────────────────────────────── */

/**
 * The timer choices. Short options first because they are the ones people
 * reach for deliberately; a week exists so "on" does not have to mean "gone
 * before I read it on a bad day".
 */
export const DISAPPEAR_OPTIONS: ReadonlyArray<{ label: string; seconds: number }> = [
  { label: 'Off', seconds: 0 },
  { label: '1 hour', seconds: 60 * 60 },
  { label: '1 day', seconds: 24 * 60 * 60 },
  { label: '1 week', seconds: 7 * 24 * 60 * 60 },
];

export const DISAPPEAR = {
  title: 'Disappearing messages',
  on: 'ON',
  off: 'OFF',
  /** Said as a fact about both devices, because it is a shared setting. */
  status: (label: string) => `Messages here disappear after ${label.toLowerCase()}.`,
  notSet: 'Messages here stay until someone deletes them.',
  shared: 'Either of you can change this, and it changes for both of you.',
  // The sentence that keeps this honest. Deletion is cooperative: it removes
  // messages from two devices and cannot reach a photograph of the screen.
  // The app already tells you about screenshots; it must not imply more.
  // "Devices", not "phones": the other end is a device this copy has
  // never seen. The screenshot-notice promise is unchanged — it is about the
  // conversation, and a notice still arrives from a side that discloses.
  limit:
    'This removes messages from both devices. It can’t stop someone photographing the screen — Tacendum tells you when a screenshot is taken instead.',
  failed: 'Tacendum couldn’t change that. Try again.',
} as const;

/** How a timer reads in a sentence, for the status line. */
export function disappearLabel(seconds: number | null | undefined): string | null {
  if (!seconds || seconds <= 0) return null;
  return DISAPPEAR_OPTIONS.find(o => o.seconds === seconds)?.label ?? `${seconds}s`;
}
