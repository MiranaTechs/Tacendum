import {
  CONSENT_MAX_EDGES,
  MAX_ATTACHMENT_BYTES,
  MAX_PAYLOAD_B64_LENGTH,
  encodeCallEnvelope,
  encodeGroupCallEnvelope,
  isCallTcm,
  parseGroupCallEnvelope,
  type AccountsNoticeFrame,
  type CallEnvelope,
  type GroupCallEnvelope,
  type GroupSibling,
  type MsgFrame,
  type PrekeyBundle,
  type StreamEditEnvelope,
  type TypingMsgFrame,
} from '@tacendum/shared';
import {
  composeRosterDigest,
  GROUP_MAX_MEMBERS,
  isGroupTcm,
  MAX_HISTORY_SHARE,
} from '@tacendum/shared/group-envelope';
import {
  applyGroupDel,
  applyGroupNew,
  applyRosterWrite,
  applySettingsWrite,
  effectiveDisappearSec,
  foldRoster,
  noteRoomTraffic,
  ownerOnlyPolicy,
  unconditionalPolicy,
  verdictFor,
  type RosterSlot,
  type SettingsSlot,
} from '@tacendum/shared/group-fold';
import { randomMsgId } from '@tacendum/shared/msgid';
import { createPacingBucket, type PacingBucket } from '@tacendum/shared/pacing';
import {
  blobDecrypt,
  blobEncrypt,
  clearInboxEntry,
  decryptEnvelope,
  encryptText,
  getSecret,
  hasIdentity,
  hasSession,
  type InboxEntry,
  isIdentityChangeError,
  isStoreBusyError,
  processPreKeyBundle,
  randomBytes,
  readInbox,
  resetPeer,
  safetyNumber,
  sha256,
  verifyLinkOp,
} from 'tacendum-crypto';
import {
  announceIncoming,
  setDeliveryTransport,
  socketSurvivesBackground,
  startBackgroundDelivery,
  stopBackgroundDelivery,
} from './background';
import { syncBadge } from './badge';
import { publishBlockedPeers, publishPeerNames, publishSelfId } from './nse';
import {
  apiConsentDelete,
  apiConsentWrite,
  apiCreateAttachment,
  apiGetAttachmentUrl,
  apiGetPrekeyBundle,
  downloadBlob,
  uploadBlob,
  type ApiRequestError,
  apiWsTicket,
} from './api';
import {
  isBlocked,
  mayFetchFor,
  mayPersistInbound,
  maySendTo,
  mustAckInbound,
  type BlockState,
} from './blocking';
import * as db from './db';
import { syncDecoyProfile } from './decoy';
import { FileEnvelope,
  DELETED_PREVIEW,
  PREVIEW_SCAN,
  VoiceEnvelope,
  VOICE_MAX_SECONDS,
  encodeEnvelope,
  aiOriginOf,
  isCarrierEnvelope,
  MAX_READ_IDS,
  mentionWho,
  parseEnvelope,
  previewFor,
  rewriteBody,
  VAULT_ACK_TRUST_MAX,
  VAULT_BODY_MAX,
  VAULT_TITLE_MAX,
  type Envelope,
  type ImageEnvelope,
  type TypingEnvelope,
  type VaultEnvelope,
} from './envelope';
import {
  handleAccountsNoticeFrame,
  onPeerRosterNotice,
  type PeerRosterNotice,
} from './linking';
import {
  acceptPeerDevice,
  anchorFor,
  applyPeerMutationNotice,
  applyServedRoster,
  fanoutDeviceSet,
  forgetPeerIdentity,
  inboundGateFor,
  recordPeerIdentity,
  type ServedSibling,
} from './peerDevices';
import {
  applySiblingSync,
  buildLocalNameSync,
  buildMachinePeersSync,
  buildPeerRosterSync,
  buildReadSync,
} from './sync';
import { buildDeviceLegs, deviceFanoutTargets, type DeviceFanoutDeps } from './deviceFanout';
import {
  chimeForArrival,
  loadMessageSound,
  noteTransportOpen,
} from './messageSound';
import { nextMsgId } from './msgid';
import { personName } from './person';
import { readReceiptsEnabled } from './readReceipts';
import { typingIndicatorsEnabled } from './typingIndicators';
import {
  AUTH_TOKEN_KEY,
  probeAndHeal,
  resumeReauth,
  subscribeToken,
  suspendReauth,
} from './reauth';
import { session } from './session';
import { streamEdits } from './streamEdits';
import { WsClient, type WsState } from './ws';

/**
 * Messaging core: session bootstrap on first send,
 * encrypt-at-compose with a pending outbox flushed in ULID order, dedupe +
 * ack on receive, tamper rejection without rendering.
 * Decrypted plaintext goes only to SQLite/UI — never to logs.
 */

/**
 * The Keychain account for the bearer token. DEFINED IN `reauth.ts` now — the
 * module that owns the credential's whole lifecycle, including replacing it —
 * and re-exported from here so every existing importer (registration.ts,
 * App.tsx, call/index.ts) keeps working off one definition rather than two
 * copies of a string that can drift apart silently.
 */
export { AUTH_TOKEN_KEY };

/**
 * Re-exported for the same reason and through the same door as
 * `AUTH_TOKEN_KEY`: `registration.ts` needs to suspend re-auth across account
 * deletion, and importing `./reauth` there directly adds an import edge that
 * loads the module in a different order — enough to leave the binding
 * undefined at call time under the app's existing cycle. One seam, already
 * proven, rather than a second one that only mostly works.
 */
export { resumeReauth, suspendReauth };

/** A queued envelope the server keeps rejecting (bad recipient, etc.) is
 * marked failed after this many sends rather than retried forever. Valid
 * sends always receipt on the first attempt (enqueue-always); ten, spread
 * over the backoff schedule below, is roughly fifteen minutes of open
 * socket before the app stops trying and says so. */
const MAX_SEND_ATTEMPTS = 10;
/** Base receipt window: a send unanswered this long on an "open" socket is
 * treated as lost and becomes eligible to resend. Doubles as the retry
 * timer's tick — rows deeper in the backoff below simply skip ticks until
 * their own delay has elapsed. */
const RECEIPT_TIMEOUT_MS = 15_000;
/** Backoff ceiling. Doubling without a cap would push the late retries past
 * anyone's patience; two minutes keeps them coming while a link that keeps
 * losing frames is no longer hammered every fifteen seconds. */
const MAX_RETRY_DELAY_MS = 120_000;

/**
 * Fan-out pacing, sized HERE because the sizing
 * rule belongs to the caller and the algorithm to `@tacendum/shared/pacing`:
 * this is a HUMAN account under the server's `wsSend` (30 burst, 5/sec —
 * `packages/server/src/ratelimit.ts`), paced at the 24 per 6-second
 * window, strictly below it. An integration caller must mint its own bucket
 * under `integrationSend` — never inherit this pair.
 *
 * The window bound is worst-case over ANY 6-second interval, which pins the
 * shape: a token bucket can emit at most `capacity + windowSec × refill`
 * frames in a window, so capacity 1 with refill (24−1)/6 ≈ 3.83/s is exactly
 * 24 — and capacity 1 is also what the jitter needs, because a burst of
 * two legs in one tick is precisely the co-timing the jitter exists to break.
 * An 11-leg fan-out drains in ~2.6 s, the figure the design quotes.
 */
const FANOUT_WINDOW_FRAMES = 24;
const FANOUT_WINDOW_SEC = 6;
const FANOUT_BURST = 1;
const FANOUT_REFILL_PER_SEC =
  (FANOUT_WINDOW_FRAMES - FANOUT_BURST) / FANOUT_WINDOW_SEC;

/**
 * Exported ONLY so a test can pin the arithmetic directly.
 *
 * Review showed the behavioural window test cannot catch a widened pair: the
 * per-leg jitter spreads the drain, so no practical fixture size reliably
 * observes the violation even though the bucket genuinely permits it —
 * measured, the shipped pair tops out at 23 frames per 6 s and a pair widened
 * to the server's own 30 reaches 29. A test that cannot fail is not evidence,
 * so the invariant is asserted as arithmetic instead of hunted for in a
 * drain: capacity + window x refill must stay at or under this plan's 24,
 * which is itself strictly below `wsSend`'s 30. The client never trips
 * the server rather than recovering from it — and the design says it cannot even
 * see a rate-limit rejection, so tripping it would fail silently.
 */
export const FANOUT_PACING = {
  windowFrames: FANOUT_WINDOW_FRAMES,
  windowSec: FANOUT_WINDOW_SEC,
  burst: FANOUT_BURST,
  refillPerSec: FANOUT_REFILL_PER_SEC,
  /** What the bucket can actually emit in one window. */
  worstCaseInWindow: FANOUT_BURST + FANOUT_WINDOW_SEC * FANOUT_REFILL_PER_SEC,
  /** `packages/server/src/ratelimit.ts` wsSend, the ceiling we stay under. */
  serverWindowFrames: 30,
} as const;
/** Random extra delay added to every paced leg resume (the jitter). It
 * RAISES a timing join from trivial to easy; it does not eliminate it and
 * must not be claimed to. */
const LEG_JITTER_MAX_MS = 350;

/**
 * Typing pacing. Its OWN bucket, never the fan-out
 * pacer: typing must never queue behind — or push in front of — a real
 * message. Sized under the server's LIMITS.typing (15 burst, 3/sec): the
 * burst covers one full room (GROUP_MAX_MEMBERS − me = 11 legs) plus a
 * concurrent 1:1; the refill sustains one room refresh per 10 s with
 * margin. A refused token DROPS the signal — typing that cannot go now is
 * worthless in five seconds, so nothing here ever waits.
 */
const TYPING_BURST = 12;
const TYPING_REFILL_PER_SEC = 1.2;

/**
 * How long a row waits after its latest send before it may be sent again:
 * 15 s, 30 s, 60 s, then 120 s flat — doubling, capped. `attempts` counts
 * sends ALREADY made (bumped right after each ws.send), so a row with one
 * unanswered send waits the base window and each further silence doubles it.
 * A resend is the SAME ciphertext, idempotent by msgId — the recipient
 * dedupes — so the patience costs correctness nothing. The delay only holds
 * within one socket lifetime: a reconnect clears `inflight` and re-sends
 * immediately, which is deliberate (a fresh link deserves a fresh try;
 * attempts still cap across connections).
 */
function retryDelayMs(attempts: number): number {
  return Math.min(
    RECEIPT_TIMEOUT_MS * 2 ** Math.max(0, attempts - 1),
    MAX_RETRY_DELAY_MS,
  );
}

/** Blob downloads run through a small bounded queue: a peer can address many
 * carrier messages at one ≤10 MiB pointer, and each download buffers the whole
 * base64 blob in a JS string — unbounded concurrency is a remote OOM. */
const MAX_CONCURRENT_DOWNLOADS = 2;

/**
 * The AUTOMATIC download is bounded; the manual one is not.
 *
 * Concurrency alone bounds nothing but the instantaneous memory: the queue
 * behind it drained COMPLETELY, so any unblocked peer could address thousands
 * of carrier messages at ≤10 MiB pointers and this phone would fetch, decrypt
 * and write every one — device-storage and bandwidth exhaustion at roughly
 * 35 GiB/hour on a fast link, invisible until the disk was full.
 *
 * Four bounds, all on AUTO-fetch only (a user's own tap is consent and is
 * exempt — `retryAttachment` passes `manual`):
 *
 * - MAX_QUEUED_DOWNLOADS caps the BACKLOG. At 2 concurrent and ~1-2 s per
 *   blob, 128 jobs is ~2 minutes of drain — a full album share fits, an
 *   attack cannot stack an hour of work.
 * - The WINDOW BUDGET caps the RATE, in ciphertext-base64 chars (≈ bytes on
 *   the wire) and in count. 256 MiB/hour ≈ 85 typical 3 MiB photos or 500+
 *   voice notes — above any human hour — while the worst case falls from
 *   unbounded to ≤ ~270 MiB/window (one ≤13.3 MiB overshoot on the last
 *   accepted blob, since size is only known after the fetch). The window is
 *   FIXED, not sliding: a burst straddling the boundary can reach 2× budget
 *   once, and is then rate-bound — accepted for a counter this simple.
 * - The COUNT budget stops many-tiny-pointer floods the byte budget would
 *   never notice (300/hour ≈ 5/minute sustained).
 * - The STORAGE CEILING bounds the SUM the three rate bounds cannot: at
 *   256 MiB/hour a patient sender still writes ~6 GiB/day of disk, forever.
 *   Total stored attachment bytes are measured from the attachments table
 *   itself once per session (the disk is the ledger — it survives every
 *   relaunch, cannot drift, and content the person deletes frees exactly
 *   what it held) and advanced in memory as fetches land. At the ceiling,
 *   automatic fetch stops; nothing already stored is ever deleted to make
 *   room — an app that evicts old attachments hands every sender a remote
 *   deletion primitive.
 *
 * A refused auto-fetch degrades VISIBLY, never silently: the row lands on
 * 'failed', which ChatThreadScreen renders as "tap to retry" — the message is
 * still there and the photo is one deliberate tap away. 'failed' also means
 * the boot-time reconcile (which resumes only missing/'pending' rows) does
 * not re-flood on every launch; the flood stays exactly as large as the
 * budget that admitted it, attributed on screen to the sender, who is one
 * block away from permanent silence. Avatars share the machinery and the
 * budget (a hostile profile card per version is the same flood); a refused
 * avatar is simply skipped — the peer's next card re-offers it.
 */
const MAX_QUEUED_DOWNLOADS = 128;
const AUTO_FETCH_WINDOW_MS = 60 * 60 * 1000;
const AUTO_FETCH_BYTE_BUDGET = 256 * 1024 * 1024;
const AUTO_FETCH_COUNT_BUDGET = 300;
/**
 * The storage ceiling's number, in stored base64 characters (ASCII: one
 * character is one byte). 4 GiB of base64 ≈ 3 GiB of raw media ≈ a thousand
 * typical 3 MiB photos — years of a real correspondence — while it is ~3% of
 * the smallest phone this app ships on, so this app can never be the thing
 * that filled the disk. An attacker at the full admitted rate reaches it in
 * ~17 hours and then degrades VISIBLY: rows land 'failed' ("tap to retry"),
 * attributed on screen to a sender who is one block away from silence.
 * Overshoot is bounded by what was already in flight when the line was
 * crossed: MAX_CONCURRENT_DOWNLOADS × one blob ≈ 27 MiB, under 1%.
 */
const AUTO_FETCH_STORAGE_CEILING = 4 * 1024 * 1024 * 1024;

/** Clock skew allowed on a peer's profile version before the card is ignored:
 * a far-future version would win newest-wins forever. */
const PROFILE_FUTURE_TOLERANCE_MS = 24 * 60 * 60 * 1000;

/** Call signalling flushes ahead of ordinary messages. */
const CALL_OUTBOX_PRIORITY = 1;

/**
 * A revision's stamp, from a timestamp the sender chose. Two jobs: order
 * revisions against each other (so a stale redelivery loses), and mark the
 * row as edited/retracted at all. Only the second is security-relevant —
 * a falsy stamp reads as "never edited" — so the floor is 1 and the ceiling
 * is now plus the same clock-skew tolerance profile cards get.
 */
function reviseStamp(ts: number): number {
  if (!Number.isFinite(ts) || ts < 1) return 1;
  return Math.min(ts, Date.now() + PROFILE_FUTURE_TOLERANCE_MS);
}

/** The room envelopes as parseEnvelope's union carries them (plus `grp.hist`, plus `grp.consent` —
 * the roster-style member-consent announcement). */
type GroupEnvelope = Extract<
  Envelope,
  {
    tcm:
      | 'grp.msg'
      | 'grp.new'
      | 'grp.roster'
      | 'grp.del'
      | 'grp.set'
      | 'grp.hist'
      | 'grp.consent';
  }
>;

/** parseEnvelope's union does not narrow through isGroupTcm on the tcm
 * alone; this guard narrows the envelope itself. */
function isGroupEnvelope(envelope: Envelope): envelope is GroupEnvelope {
  return isGroupTcm(envelope.tcm);
}

/**
 * Everything THE ONE CONTENT SWITCH needs to know about where a piece
 * of content lands. A 1:1 frame and a room message differ only in this data
 * — never in the switch arms.
 */
interface ContentContext {
  gen: number;
  /** The frame's dispatch token (claimed at handleIncoming's synchronous
   * top) — what orders this frame's chat-line write among the line's
   * writers. See runChatLine/touchChatOrdered. */
  token: number;
  /** The conversation row: `frame.from` in a 1:1, the room id in a room. */
  convId: string;
  /** The authenticated sender — always `frame.from`; equals convId in 1:1. */
  senderId: string;
  /** The frame's wire msgId: what is marked seen and acked. */
  wireMsgId: string;
  /** The local row key content addresses: the wire msgId in a 1:1,
   * `${authorId}.${m}` in a room. */
  rowMsgId: string;
  /** null in a 1:1; `frame.from` in a room. */
  authorId: string | null;
  ts: number;
  /** The author's per-room counter off the wire; null in a 1:1. */
  sq: number | null;
  /** The tag: the sender was folded OUT of the room at arrival. */
  outsider: boolean;
  /** The Art. 50 origin claim at arrival: the
   * room wrapper's `ai` OR the inner envelope's, resolved by the caller —
   * `outsider`'s pattern, recorded at the door because the wrapper is
   * discarded at persist. */
  ai: boolean;
  /** The body EXACTLY as `messages.body` holds it. */
  text: string;
  envelope: Envelope | null;
  /** The plaintext came from the notification extension's spool (a
   * `preDecrypted` pass — the launch/resume drain, the rescue, a parked
   * duplicate carrying a body), not from this process's own decrypt. The
   * push that woke the extension already announced it, so the chime stays
   * quiet (messageSound.ts). Carried as data like every other difference
   * between the callers — never a second arm. */
  spooled: boolean;
}

/** Split a room content ref `${authorId}.${m}`. A ULID cannot
 * contain '.', so the first dot is unambiguous; anything else is not a room
 * ref and resolves to nothing. */
function splitRoomRef(ref: string): { authorId: string; m: string } | null {
  const dot = ref.indexOf('.');
  if (dot <= 0 || dot === ref.length - 1) return null;
  return { authorId: ref.slice(0, dot), m: ref.slice(dot + 1) };
}

/**
 * "There is no account at that id" — the one API failure that is a fact about
 * the address rather than about the network, so the UI can stop telling someone
 * to check a connection that is working.
 *
 * Matched by name and status rather than `instanceof`: a jest module mock of
 * `./api` that omits the class would turn the check itself into a TypeError
 * thrown from inside a catch block on the send path. `ApiRequestError` sets
 * `name` in its constructor, so this is exact.
 */
function isNotFound(err: unknown): boolean {
  return (
    err instanceof Error &&
    err.name === 'ApiRequestError' &&
    (err as ApiRequestError).status === 404
  );
}

/**
 * "The server answered in a shape this build cannot read" — `api.ts`'s
 * ServerAheadError. Matched by name for the same reason isNotFound() is: a
 * jest module mock of `./api` that omits the class must not turn the check
 * into a TypeError inside a catch block. */
function isServerAhead(err: unknown): boolean {
  return err instanceof Error && err.name === 'ServerAheadError';
}

/**
 * "You blocked this person on this device, so nothing goes out." Thrown by the
 * compose paths that have a UI surface to report it (text, reply, image, call);
 * the surfaceless paths (screenshot notice, profile card, reaction, edit,
 * retraction) return silently instead — a rejected promise where the UI has
 * been removed is an unhandled rejection, not a message.
 *
 * Matched by `name` rather than `instanceof`, for the same reason isNotFound()
 * documents above: a jest module mock that omits the class would turn the check
 * itself into a TypeError thrown from inside a catch block on the send path.
 */
export class BlockedPeerError extends Error {
  constructor(message = 'blocked') {
    super(message);
    this.name = 'BlockedPeerError';
  }
}

/**
 * A vault item this build will not send, refused at the composer.
 *
 * Typed, with the field and the limit on it, because the UI has to be able to
 * say WHICH box is too long and by how much — "couldn't save" over a pasted SSH
 * key is not a message, it is a shrug. It carries the limit and never the
 * value: an error string gets logged, rendered, and sometimes copied, and the
 * value here is a credential.
 *
 * This exists because the caps used to be enforced only by the RECEIVER's
 * parser. A 2100-character value composed fine, sent fine, and then arrived as
 * "Unsupported message" — by which point the ack had purged the server's copy
 * and the ratchet key was spent, so the item was gone on both phones with no
 * way back. Refusing before anything is allocated is the whole fix.
 */
export class VaultItemRefusedError extends Error {
  readonly field: 'title' | 'body';
  readonly limit: number;
  readonly reason: 'empty' | 'too-long' | 'envelope';
  constructor(field: 'title' | 'body', reason: 'empty' | 'too-long' | 'envelope') {
    const limit = field === 'title' ? VAULT_TITLE_MAX : VAULT_BODY_MAX;
    const noun = field === 'title' ? 'name' : 'value';
    super(
      reason === 'empty'
        ? `a vault item needs a ${noun}`
        : reason === 'envelope'
          ? `that ${noun} starts with a reserved sequence`
          : `that ${noun} is too long (limit ${limit} characters)`,
    );
    this.name = 'VaultItemRefusedError';
    this.field = field;
    this.limit = limit;
    this.reason = reason;
  }
}

/** The sender half of the vault's field rules, checked before ANY allocation:
 * before an id is minted, before a counter is reserved, before a prekey is
 * fetched and before the ratchet moves. `encodeEnvelope` re-checks the same
 * caps from the same schema a moment later and would throw anyway — this pass
 * exists so the thing that reaches the UI names the field. */
function assertVaultItemFits(title: string, body: string): void {
  for (const [field, value, max] of [
    ['title', title, VAULT_TITLE_MAX],
    ['body', body, VAULT_BODY_MAX],
  ] as const) {
    if (value.length === 0) throw new VaultItemRefusedError(field, 'empty');
    if (value.length > max) throw new VaultItemRefusedError(field, 'too-long');
    // The same refusal the schema makes: a string starting with the sentinel
    // reads as structure everywhere in this app, so it must not become a title
    // that gets drawn into a thread row.
    if (value.startsWith('{"tcm":')) {
      throw new VaultItemRefusedError(field, 'envelope');
    }
  }
}

/**
 * The room bubble's honest failure line: a half-delivered
 * fan-out shows "Not delivered to N of M" — an aggregate — rather than a red
 * bubble, because in a room a red bubble would say "nobody got it" when nine
 * of eleven people did. Null while nothing has failed. Pure and exported so
 * the thread screen and its tests share one sentence; the numbers come from
 * `db.fanoutDeliveryState`, whose per-leg ledger is the source of truth.
 */
export function groupDeliveryNotice(state: {
  failed: number;
  total: number;
}): string | null {
  if (state.failed <= 0 || state.total <= 0) return null;
  return `Not delivered to ${state.failed} of ${state.total}`;
}

/**
 * The skipped-member banner: a member with an
 * unaccepted safety-number change is skipped LOUDLY — the other legs send,
 * and this names who is not receiving. The asymmetry with both neighbours is
 * deliberate and load-bearing: a BLOCK's whole property is that the skip is
 * undetectable, so this sentence must never render for one (the design makes a
 * blocked room read-only instead); and the 1:1 path HARD-PAUSES on the same
 * finding, which a room must not inherit, because pausing a whole room for
 * one member's rekey hands any member a mute button over everyone else.
 * `SAFETY_COPY.changed` is written for one person and is not reused here.
 *
 * Takes display NAMES — resolution from member ids is the screen's job.
 */
export function groupSafetySkipBanner(names: string[]): string | null {
  if (names.length === 0) return null;
  if (names.length === 1) {
    return `${names[0]}’s safety number changed. They are not receiving messages in this room until you review it.`;
  }
  const list =
    names.length === 2
      ? `${names[0]} and ${names[1]}`
      : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return `${list}’s safety numbers changed. They are not receiving messages in this room until you review them.`;
}

type Listener = () => void;

/**
 * A decrypted envelope, handed to whoever registered interest. This is how calling receives its protocol without `messaging.ts`
 * importing a single call-related symbol: the CallService is just a
 * subscriber, and this file stays a messaging file.
 */
export type EnvelopeListener = (
  peerId: string,
  envelope: Envelope,
  meta: { msgId: string; ts: number },
) => void;

/** A decrypted typing signal. Ephemeral by contract: never persisted, never
 * previewed — delivered to subscribers or lost, like a shout down a hall. */
export type TypingListener = (
  peerId: string,
  envelope: TypingEnvelope,
  ts: number,
) => void;

/**
 * How an inbound frame terminally resolved when it was NOT call signalling.
 * See `onFrameVerdict` for the contract and for what deliberately never
 * emits one.
 */
export type FrameVerdict = 'not_call' | 'undecryptable';

export type FrameVerdictListener = (peerId: string, verdict: FrameVerdict) => void;

/**
 * BLOCKING (blocking.ts) IS ENFORCED ENTIRELY IN THIS CLASS, and it adds no
 * wire byte, no envelope type and no zod schema — `packages/shared` and
 * `packages/server` are untouched by it. That is the whole property: a blocked
 * person must not be able to tell they have been blocked, and anything the
 * server learned about the block would eventually be something they could
 * learn too. If this file ever starts sending a "you are blocked" frame, or
 * suppressing one the unblocked case sends, the block stops being invisible.
 */
class MessagingService {
  private ws = new WsClient();
  private selfUserId: string | null = null;
  private token: string | null = null;
  /** Drops the token subscription installed by start(). `this.token` is the
   * bearer every REST call in this file presents, so a re-auth that did not
   * reach it would leave each of those calls 401ing, being rescued by the
   * stale-bearer check, and paying a wasted round trip forever. */
  private unsubscribeToken: (() => void) | null = null;
  /** Bumped by stop(). Async work captures the value at entry and re-checks
   * it before EVERY database write: a continuation that was suspended in an
   * await when a relock happened must not write into whichever workspace
   * opened next (entry guards are not enough). */
  private generation = 0;
  private listeners = new Set<Listener>();
  /** Recovery hooks for subsystems that must retry only after a live transport. */
  private transportOpenListeners = new Set<() => void>();
  /**
   * Has the CURRENT socket produced any server frame at all? False from
   * `open` until the first receipt, message, typing or accounts frame
   * arrives; a send made while this is false burns no `attempts`. A
   * half-open socket — NAT rebinding, radio hand-off — reads OPEN to the
   * kernel and swallows every `send` without answering, and the outbox used
   * to count ten such sends (about fifteen minutes) and then mark the
   * message failed under a screen that said "Connected". Retry attempts are
   * evidence about the MESSAGE only when the socket has shown it can carry
   * anything; the transport's own receive-silence watchdog (ws.ts) is what
   * tears a dead socket down. */
  private socketLive = false;
  private envelopeListeners = new Set<EnvelopeListener>();
  private typingListeners = new Set<TypingListener>();
  /** See onFrameVerdict. Subscription-owned like envelopeListeners:
   * stop() does not clear it; subscribers unsubscribe themselves. */
  private frameVerdictListeners = new Set<FrameVerdictListener>();
  private flushing = false;
  /** Set when flushPending is entered while a pass is already running. The
   * caller's row postdates that pass's listOutbox snapshot, so without a
   * latch it could sit 'pending' on an open socket: the running pass would
   * finish, see an empty inflight map (e.g. it just exhausted the last old
   * row), and never re-arm. The running pass re-lists before handing off. */
  private flushQueued = false;
  /** msgId -> send time. A msgId is treated as in-flight (skipped by the
   * flush) only until its backoff delay — retryDelayMs of the row's attempt
   * count — elapses without a receipt; after that it is re-sent (a duplicate
   * frame is safe — idempotent by msgId, the recipient dedupes), so a dropped
   * send/receipt can't strand it. */
  private inflight = new Map<string, number>();
  /** Pending store-busy local retries; cancelled wholesale by stop(). */
  /** msgIds currently mid-handling (value: the GENERATION that claimed the
   * id). A concurrent duplicate is parked and re-entered once the in-flight
   * copy settles. Generation-scoped so a stale handler surviving a relock
   * cannot hold the door against — or delete the claim of — the next
   * workspace's handling of the same msgId. */
  private inflightMsgIds = new Map<string, number>();
  /**
   * The spool drain's PROOF OF IMPORT: every wire id `noteSeen` wrote while
   * a drain is running, plus the ids whose durable `seen` row already proved
   * an import from an earlier launch (the short-circuit at the top of
   * handleIncomingInner). Non-null only for the duration of `drainInbox`,
   * which consumes it — so it is bounded by one spool's worth of ids and
   * costs nothing on the socket path. The drain used to read `seen` back
   * instead, and `markSeen`'s prune could evict the row it had just
   * inserted, so an imported message was never cleared. */
  private drainWitness: Set<string> | null = null;
  /** The parked duplicate per msgId, if one arrived mid-handling. The
   * pre-decrypted body rides along when the parked copy has one — it may be
   * the only plaintext in existence. */
  private parkedDuplicates = new Map<string, { frame: MsgFrame; preDecrypted?: string }>();
  /** Store-busy retries WAITING IN PLACE (see the busy branch of
   * handleIncomingInner): the timer, and the wake that resolves the wait —
   * `stop()` clears the one and fires the other with `false`, so a handler
   * parked on a relocked workspace returns instead of dangling. */
  private busyRetryWaits: Array<{
    timer: ReturnType<typeof setTimeout>;
    wake: (woke: boolean) => void;
  }> = [];
  /**
   * PER-SENDER ORDER ON THE INBOUND PATH: one promise chain per
   * `frame.from`, so a sender's frames are handled in the order they
   * arrived and a frame that is WAITING — a store-busy retry — cannot be
   * overtaken by its successor. The hazard was concrete: a `prekey` message
   * that establishes the session hits the extension's transient store lock
   * and waits 1.5 s; the `ciphertext` right behind it decrypts against a
   * session that does not exist yet, and the generic catch below classifies
   * that as tamper — error row, seen, ACKED — a permanent loss of a message
   * that would have decrypted a moment later. Cross-sender concurrency is
   * untouched (one chain per sender), and the chain is bookkeeping only:
   * entries drop as soon as they settle. */
  private senderChains = new Map<string, Promise<void>>();
  /** Drives the timeout-based retry while the socket stays open and idle. */
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  /** Unsubscribe for the linking module's signed peer-notice feed — armed in start(), released in stop(). */
  private unsubscribePeerNotice: (() => void) | null = null;
  /** Peers whose safety number changed and hasn't been accepted — sending is
   * blocked and the UI shows a warning until the user accepts. */
  private identityChanged = new Set<string>();
  /**
   * Peers this person blocked on this device. The inbound path consults this
   * once per frame, so it is a Set and not a SQLite read: `blocked_peers` is
   * read exactly once, in start(), and mutated only by blockPeer/unblockPeer
   * below. Same shape, same seeding site and same failure tolerance as
   * `identityChanged` directly above — and deliberately a SEPARATE Set, because
   * the two states mean opposite things (see isBlockedLocally).
   */
  private blockedPeers = new Set<string>();
  /**
   * The blocked-peers MIRROR (the App Group file the notification
   * extension and CallKit read) is known to be out of step with the database.
   * Set when a mirror write fails after the DB block committed; cleared when a
   * later publish succeeds. Seeded from the durable marker at start() so the
   * partial state survives a relaunch, then reconciled by the boot re-publish.
   */
  private blockedMirrorDirty = false;
  /** Bounded attachment-download machinery (see MAX_CONCURRENT_DOWNLOADS). */
  private downloadQueue: Array<{ key: string; run: () => Promise<void> }> = [];
  private downloadKeys = new Set<string>();
  private activeDownloads = 0;
  /** The auto-fetch window (see MAX_QUEUED_DOWNLOADS). Reset by stop():
   * the window is per unlocked session, and both ends of a relock/unlock
   * cycle need the owner's passphrase — an attacker cannot refresh their own
   * budget. */
  private autoFetchWindow = { startedAt: 0, bytes: 0, count: 0 };
  /**
   * TOTAL stored attachment bytes (base64 chars) — the storage ceiling's
   * ledger. Loaded from the attachments table once per session (start()) and
   * advanced in memory as fetches land; null until the load returns. The
   * gate reads null as "under": the load is one local SELECT racing fetches
   * that each take seconds, so what null can admit is a couple of in-flight
   * blobs, once — while failing CLOSED here would freeze every photo on a
   * database hiccup. In-session growth the charge below does not see (my own
   * sends) is trued up by the next session's measurement, in the safe
   * direction meanwhile. Reset by stop() with the window above: the next
   * workspace measures its own table, and a decoy inherits nothing.
   */
  private storedAttachmentBytes: number | null = null;
  /** My avatar's uploaded blob for the current profile version — uploaded once
   * and reused for every peer that still needs the card. */
  private pendingAvatar: {
    attachmentId: string;
    keyB64: string;
    version: number;
  } | null = null;
  /** peerId -> card version currently being shared (dedupes send/broadcast
   * races without blocking a newer card). */
  private sharingProfileTo = new Map<string, number>();
  /**
   * The fan-out governor: every leg takes one token before
   * it may reach the wire. Created by start() and EMPTY at birth — after a
   * relaunch the server-side window may still be depleted by the previous
   * run, and `createPacingBucket`'s `initialTokens` exists precisely so the
   * caller can decide what survives a restart. Starting at zero is that
   * decision made conservatively: at capacity 1 it costs the first leg at
   * most ~260 ms and needs no persisted level. 1:1 traffic and call
   * signalling never consult it — a human's typing is its own governor and a
   * ring cannot wait.
   */
  private fanoutPacer: PacingBucket | null = null;
  /** Pending paced resume of the flush; at most one, so a refused pass does
   * not stack timers. Cleared by stop() like every other timer here. */
  private fanoutResumeTimer: ReturnType<typeof setTimeout> | null = null;
  /** The typing governor — see TYPING_BURST above.
   * Unlike the fan-out pacer it is FULL at birth: the worst cold-start
   * burst is one room's legs, which the server's typing bucket absorbs by
   * design, and a dropped typing signal (unlike a dropped leg) costs a
   * cosmetic hint, not a message. */
  private typingPacer: PacingBucket | null = null;
  /**
   * roomId -> members whose legs were skipped over an unaccepted identity
   * change: the state behind the loud banner. Per
   * workspace like `identityChanged` (cleared by stop()); entries leave when
   * the change is accepted.
   */
  private groupSkipped = new Map<string, Set<string>>();
  /**
   * Serialises whole load→apply→persist rounds of the room slot store. Frames are handled CONCURRENTLY, and two roster writes
   * for one room interleaving their snapshot loads would lose whichever
   * write persisted first — a read-modify-write race the winner-per-key
   * SQL cannot arbitrate because the loser never saw the winner's row.
   * Same chain idiom as db's runExclusive.
   */
  private groupChain: Promise<unknown> = Promise.resolve();
  public wsState: WsState = 'closed';
  /**
   * The server answered a send-path DTO in a shape this build cannot
   * read: set when a prekey bundle fails to parse, cleared the next time
   * one parses. The state a thread can show as "update Tacendum" instead
   * of a connection error; the socket's own reading of the same condition
   * is `WsClient.serverAhead`. */
  public serverAhead = false;

  private runGroupApply<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.groupChain.then(fn, fn);
    this.groupChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /**
   * THE CHAT LINE'S ORDERING DOMAIN. chats.lastMessageText/lastMessageAt
   * have two writers — touchChat (a captured value) and setChatPreview (a
   * recompute) — while frames are handled concurrently and compose paths run
   * alongside them. The two used to be arbitrated by whoever wrote last;
   * then, briefly, by a timestamp guard that compared the device clock
   * against the server clock and froze the line for the whole skew (see
   * db.touchChat's comment). The arbiter is DISPATCH ORDER — the order
   * events entered this process — carried by two pieces:
   *
   *  - a per-chat promise chain (the runGroupApply idiom): every read-
   *    compute-write that ends in a chat-line write runs as one entry, so a
   *    recompute's read and its write are atomic against the other writer,
   *    and name resolution can suspend as long as it likes without another
   *    entry interleaving. Per-chat, so unrelated chats stay parallel.
   *
   *  - a dispatch token, claimed SYNCHRONOUSLY when the event enters
   *    (handleIncoming's first line for frames — before decrypt, because a
   *    frame's chat identity is not known until after it — and at the write
   *    call for compose paths). A captured-value write whose token is older
   *    than the last applied one is skipped: it describes an earlier event
   *    than the line already shows. Recomputes carry no token — they read
   *    current truth inside the chain, so they are correct at any position.
   */
  private chatLineChains = new Map<string, Promise<unknown>>();
  private chatLineSeq = new Map<string, number>();
  private dispatchSeq = 0;

  /** Claim the next dispatch token, synchronously. */
  private claimDispatchToken(): number {
    return ++this.dispatchSeq;
  }

  private runChatLine<T>(convId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chatLineChains.get(convId) ?? Promise.resolve();
    const result = prev.then(fn, fn);
    this.chatLineChains.set(
      convId,
      result.then(
        () => undefined,
        () => undefined,
      ),
    );
    return result;
  }

  /**
   * The one door to db.touchChat: serialised per chat, skipped when a LATER
   * event already owns the line, refused after a relock. `makePreview` runs
   * inside the chain entry so a mention's per-id name lookups cannot let
   * another frame's write interleave (an earlier defect), and `token`
   * defaults to claim-at-call for compose paths.
   */
  private touchChatOrdered(
    convId: string,
    ts: number,
    makePreview: () => Promise<string>,
    token: number = this.claimDispatchToken(),
  ): Promise<void> {
    const gen = this.generation;
    return this.runChatLine(convId, async () => {
      const preview = await makePreview();
      if (this.stale(gen)) return;
      if ((this.chatLineSeq.get(convId) ?? 0) > token) return;
      this.chatLineSeq.set(convId, token);
      await db.touchChat(convId, preview, ts);
    });
  }

  /** Notify UI that chats/messages changed. */
  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Receive decrypted envelopes as they arrive. Returns an unsubscribe.
   * Subscribers are advisory: a throwing one must never break delivery,
   * persistence, or the ack for everyone else.
   */
  onEnvelope(listener: EnvelopeListener): () => void {
    this.envelopeListeners.add(listener);
    return () => this.envelopeListeners.delete(listener);
  }

  private emitEnvelope(
    peerId: string,
    envelope: Envelope,
    meta: { msgId: string; ts: number },
  ): void {
    for (const listener of this.envelopeListeners) {
      try {
        listener(peerId, envelope, meta);
      } catch {
        // Advisory only — never let a subscriber break the message path.
      }
    }
  }

  /** Receive typing signals as they arrive. Returns an unsubscribe. */
  onTyping(listener: TypingListener): () => void {
    this.typingListeners.add(listener);
    return () => this.typingListeners.delete(listener);
  }

  private emitTyping(peerId: string, envelope: TypingEnvelope, ts: number): void {
    for (const listener of this.typingListeners) {
      try {
        listener(peerId, envelope, ts);
      } catch {
        // Advisory only — never let a subscriber break the frame path.
      }
    }
  }

  /**
   * A frame from `peerId` RESOLVED as something that can never ring.
   *
   * The VoIP push rings a CallKit placeholder BEFORE anything decrypts (the design
   * — the report is a PushKit obligation), and `urgent` is a client-set bit
   * on an opaque payload: any unblocked account can set it on arbitrary
   * ciphertext and ring this phone full-screen. The only thing that can end
   * that ring early is the frame draining behind the push proving itself —
   * and this file is the only layer that knows when it has. `onEnvelope`
   * states the call-signalling fact; this hook states its complement:
   *
   *   'not_call'       — the frame decrypted fine and is not call signalling
   *                      (including a call.g* shape nothing here can parse,
   *                      and a blocked sender's dropped frame) — or is a
   *                      REDELIVERY of an already-seen msgId, which this
   *                      delivery can never turn into call signalling: the
   *                      key is spent, no envelope will be emitted, and the
   *                      first delivery's controller already owned whatever
   *                      ring that frame was about.
   *   'undecryptable'  — the frame TERMINALLY failed decrypt: tamper, or an
   *                      identity change no offer behind it could survive.
   *
   * Deliberately NOT emitted for outcomes that are still in flight — a
   * store-busy retry, a DuplicatedMessage awaiting its spool rescue, a
   * relock-stale return — because the frame may yet prove the ring, and a
   * false verdict here is a dropped call. Those cases keep the native
   * 75-second watchdog as their only bound, which is the earlier behaviour.
   *
   * Like `onEnvelope`, this keeps messaging call-agnostic: it names no cid,
   * no CallKit concept, and no policy — just the fact, to whoever asked.
   */
  onFrameVerdict(listener: FrameVerdictListener): () => void {
    this.frameVerdictListeners.add(listener);
    return () => this.frameVerdictListeners.delete(listener);
  }

  private emitFrameVerdict(peerId: string, verdict: FrameVerdict): void {
    for (const listener of this.frameVerdictListeners) {
      try {
        listener(peerId, verdict);
      } catch {
        // Advisory only — never let a subscriber break the message path.
      }
    }
  }

  /**
   * Send a call-signalling envelope through the ratchet.
   * A thin sibling of sendReaction: no message row, no chat preview, and
   * queued ahead of ordinary traffic so a ringing phone never waits behind a
   * photo upload. `urgent` marks the frames that may wake a sleeping device
   * (offer and end); the wire bit itself is reserved for a later wire version.
   */
  async sendCallEnvelope(
    peerUserId: string,
    envelope: CallEnvelope,
    opts: { urgent?: boolean } = {},
  ): Promise<void> {
    // Above the duress branch and above every frame type: a blocked person
    // must never be able to make this phone ring, and this phone must never
    // ring theirs by accident. No offer, no answer, no ICE, no end frame.
    if (!maySendTo('callSignal', this.blockStateFor(peerUserId))) {
      throw new BlockedPeerError('blocked');
    }
    if (session.mode === 'duress') {
      // A duress session is network-silent. Calls are the
      // loudest thing this app can do, so this is refused outright.
      throw new Error('messaging unavailable');
    }
    await this.encryptAndEnqueue(peerUserId, encodeCallEnvelope(envelope), {
      preview: null,
      priority: CALL_OUTBOX_PRIORITY,
      urgent: opts.urgent === true,
    });
  }

  /**
   * Send a SMALL-GROUP call envelope (`call.ginvite` / `call.gjoin` /
   * `call.gleave`).
   *
   * A sibling of `sendCallEnvelope` rather than a widening of it, for the
   * same reason `GroupCallEnvelope` is a separate union from `CallEnvelope`:
   * the 1:1 send path is what every shipped build runs, and leaving its type
   * and its encoder untouched is what keeps a 1:1 regression impossible by
   * construction. Both gates above are repeated verbatim, and they must be —
   * a blocked person must never be able to make this phone ring and this
   * phone must never ring theirs, whichever union the frame belongs to, and a
   * duress session is silent in both shapes.
   */
  async sendGroupCallEnvelope(
    peerUserId: string,
    envelope: GroupCallEnvelope,
    opts: { urgent?: boolean } = {},
  ): Promise<void> {
    if (!maySendTo('callSignal', this.blockStateFor(peerUserId))) {
      throw new BlockedPeerError('blocked');
    }
    if (session.mode === 'duress') {
      throw new Error('messaging unavailable');
    }
    await this.encryptAndEnqueue(peerUserId, encodeGroupCallEnvelope(envelope), {
      preview: null,
      priority: CALL_OUTBOX_PRIORITY,
      urgent: opts.urgent === true,
    });
  }

  /**
   * Fire-and-forget typing state toward one person. Five
   * gates, in order, every one a silent drop — a typing signal is never
   * worth an error, a retry, or a queue:
   *   preference → duress → block → socket-open → session-exists.
   * Never queued, never persisted, never allowed to trigger X3DH.
   */
  async sendTypingState(peerUserId: string, state: 'start' | 'stop'): Promise<void> {
    if (!this.selfUserId) return;
    if (!typingIndicatorsEnabled()) return;
    if (session.mode === 'duress') return;
    if (!maySendTo('typingState', this.blockStateFor(peerUserId))) return;
    if (!this.ws.isOpen) return;
    if (this.flushing) return; // Never contend with a live outbox flush.
    const pacer = this.typingPacer;
    if (!pacer || !pacer.tryTake(Date.now())) return; // Drop, never queue.
    try {
      if (!(await hasSession(peerUserId))) return; // Typing never bootstraps X3DH.
      const { msgType, payload } = await encryptText(
        this.selfUserId,
        peerUserId,
        encodeEnvelope({ tcm: 'x.typing', state }),
      );
      this.ws.send({ type: 'typing', to: peerUserId, msgType, payload });
    } catch {
      // Ratchet or encode refusal — a typing signal is never worth surfacing.
    }
  }

  /**
   * The room form: one sealed leg per folded member, each carrying the room
   * id INSIDE the ciphertext — the server never learns room structure, the
   * same property message fan-out has. Uses roomComposeGates so typing is
   * exactly as permissive as an actual room message (absent, oversize,
   * not-in, and blocked-member rooms all refuse there); refusals drop
   * silently. Legs beyond the pacer's budget are dropped, not queued — the
   * roster order is randomised per event (platform CSPRNG, like fan-out's
   * leg order) so a dry bucket starves a different tail each time.
   */
  async sendRoomTypingState(groupId: string, state: 'start' | 'stop'): Promise<void> {
    if (!this.selfUserId) return;
    if (!typingIndicatorsEnabled()) return;
    if (session.mode === 'duress') return;
    if (!this.ws.isOpen) return;
    if (this.flushing) return;
    let fold: Awaited<ReturnType<MessagingService['roomComposeGates']>>['fold'];
    try {
      ({ fold } = await this.roomComposeGates(groupId));
    } catch {
      return; // No such room, not in it, over ceiling, or read-only (blocked member).
    }
    // Claim-hygiene: a typing signal ADDRESSES no
    // one — it carries no `who` and no ref — so roomContentAudience drops EVERY
    // agent member, the same seam content legs pass through. Agents consume the
    // durable spool via attend, never live typing, so this changes no agent
    // behaviour; it closes the "non-mention traffic reaching an agent" gap the claim is sensitive to. Humans are never in the agent set, untouched.
    const body = encodeEnvelope({ tcm: 'x.typing', state, room: groupId });
    const recipients = await this.roomContentAudience(
      groupId,
      body,
      fold.members.filter(id => id !== this.selfUserId),
      fold,
    );
    // Randomised recipient order off the platform CSPRNG — never Math.random
    // (fan-out's random-msgId sort is the precedent). A
    // failed draw degrades the ordering, never the delivery.
    const keyed = await Promise.all(
      recipients.map(async id => {
        try {
          const bytes = await randomBytes(2);
          return { id, key: (bytes[0] << 8) | bytes[1] };
        } catch {
          return { id, key: 0 };
        }
      }),
    );
    keyed.sort((a, b) => a.key - b.key);
    for (const memberId of keyed.map(k => k.id)) {
      // Defense in depth — roomComposeGates already refused blocked members.
      if (!maySendTo('typingState', this.blockStateFor(memberId))) continue;
      const pacer = this.typingPacer;
      if (!pacer || !pacer.tryTake(Date.now())) return; // Budget dry: drop the rest.
      try {
        if (!(await hasSession(memberId))) continue;
        const { msgType, payload } = await encryptText(this.selfUserId, memberId, body);
        if (!this.ws.send({ type: 'typing', to: memberId, msgType, payload })) return;
      } catch {
        continue; // This leg refused; the rest still get theirs.
      }
    }
  }

  async start(selfUserId: string): Promise<void> {
    // Defense in depth: a duress session is
    // network-silent. App.tsx never calls start() in duress; if some future
    // path does, refuse rather than connect.
    if (session.mode === 'duress') {
      throw new Error('messaging unavailable');
    }
    if (this.selfUserId === selfUserId && this.token) return; // already running
    this.selfUserId = selfUserId;
    const token = await getSecret(AUTH_TOKEN_KEY);
    if (!token) throw new Error('no auth token — register first');
    this.token = token;
    // Fresh per start(), empty at birth — see the field's comment for why an
    // empty bucket is the restart decision the design asks the caller to make.
    this.fanoutPacer = createPacingBucket(
      FANOUT_BURST,
      FANOUT_REFILL_PER_SEC,
      0,
    );
    this.typingPacer = createPacingBucket(TYPING_BURST, TYPING_REFILL_PER_SEC);
    // A fresh chat-line ordering domain per start(). The token counter keeps
    // rising for the life of the process — a later event must outrank an
    // earlier one across a relock too — but the chains and the last-applied
    // map are session bookkeeping.
    this.chatLineChains = new Map();
    this.chatLineSeq = new Map();

    // The signed roster-mutation feed: every
    // committed unlink/revoke this device signs fans its notice to peers.
    // The PROMISE is returned to the notifier:
    // fire-and-forget producers ignore it, but the dissolve producer AWAITS
    // it, so every peer leg is durably enqueued in the outbox BEFORE any
    // roster mutation leaves — the statement-before-teardown order.
    this.unsubscribePeerNotice?.();
    this.unsubscribePeerNotice = onPeerRosterNotice(notice =>
      this.fanPeerRosterNotice(notice),
    );

    this.ws.onFrame(frame => {
      // Any parsed server frame proves the socket carries traffic both ways.
      this.socketLive = true;
      if (frame.type === 'msg') {
        void this.dispatchIncoming(frame);
      } else if (frame.type === 'receipt') {
        void this.handleReceipt(frame.msgId, frame.state);
      } else if (frame.type === 'typing') {
        void this.handleTypingFrame(frame);
      } else if (frame.type === 'accounts') {
        void this.handleAccountsFrame(frame);
      }
      // 'error' frames carry no msgId (see shared/frames ErrorFrame), so they
      // cannot be tied to an outbox row; poison rows are bounded by
      // MAX_SEND_ATTEMPTS instead. Never logged (may reference wire data).
    });
    this.ws.onState(state => {
      this.wsState = state;
      if (state === 'open') {
        // The chime's clock (messageSound.ts): what the server's $connect
        // drain posts in the next moments is backlog that already sounded
        // as pushes, not news.
        noteTransportOpen();
        // A fresh socket has proved nothing yet (see `socketLive`).
        this.socketLive = false;
        // New connection: nothing is in flight yet; re-flush the whole outbox.
        this.inflight.clear();
        void this.flushPending();
        for (const listener of this.transportOpenListeners) {
          try {
            listener();
          } catch (error) {
            console.warn(`[messaging] transport-open listener failed: ${error instanceof Error ? error.name : 'unknown'}`);
          }
        }
      }
      this.notify();
    });
    // Seed the block from disk BEFORE the socket can carry anything: a warning
    // this device has already shown must survive a relaunch, and the window
    // between opening the socket and reading the table would be a window in
    // which a send to a changed identity slips through.
    try {
      for (const id of await db.listIdentityChanged()) {
        this.identityChanged.add(id);
      }
    } catch {
      // Pre-migration database: fall through rather than failing boot, which
      // App.tsx's recovery path could read as an inconsistent half-state.
    }
    // Blocks are seeded here for the same reason and BEFORE the socket opens:
    // the window between opening the socket and reading the table is a window
    // in which a beacon slips out to someone this phone was told to be silent
    // towards. Its OWN try/catch, not the one above: a pre-migration file that
    // throws on listIdentityChanged must not also skip the block seed, or a
    // failure in the less serious feature would silently disable this one.
    try {
      for (const id of await db.listBlockedPeers()) {
        this.blockedPeers.add(id);
      }
    } catch {
      // Same posture: never fail boot over it.
    }
    // The durable partial-enforcement marker, read once so the UI
    // reflects a mirror a prior session could not write even before this
    // session's re-publish below reconciles it. Never fail boot over it.
    try {
      this.blockedMirrorDirty = await db.getBlockedMirrorDirty();
    } catch {
      this.blockedMirrorDirty = false;
    }
    // Everything the notification extension decrypted while this app was not
    // running, imported BEFORE the socket opens.
    //
    // The order is not a preference. Those messages had their ratchet keys
    // consumed by the extension, so the server's copy of their ciphertext is
    // already undecryptable — and the server, which never saw an ack, will
    // redeliver it the moment the socket comes up. Importing first means
    // `handleIncoming` finds the msgId in `seen`, acks, and moves on.
    // Importing after would mean racing a redelivery that can only fail.
    //
    // The message-sound preference rides the same moment: every REAL unlock
    // reaches here and duress never does, which is exactly the "at init and
    // on every real unlock" rule the Keychain preferences get from App.tsx —
    // loaded before the socket can deliver anything, and never throws.
    await loadMessageSound();
    await this.drainInbox();
    // The drain may have imported unread messages, and at a cold launch no
    // AppState transition has fired yet — nothing else recomputes the icon
    // until the app is backgrounded. This also resets the extension's
    // increment counter, which is what heals any drift it picked up.
    void syncBadge();
    // The extension needs this to decrypt at all, and it is published only
    // once a real session is genuinely open — never from duress, which never
    // reaches here.
    void publishSelfId(selfUserId).catch(() => undefined);
    // Re-publish the blocked mirror from the DB truth and reconcile the dirty
    // marker: this is the retry that clears a partial block once
    // the shared container recovers, and re-flags it if it has not.
    void this.reconcileBlockedMirror();
    void this.publishNames();
    // A re-auth replaces the bearer in the Keychain; this keeps THIS object's
    // copy — the one every REST call below presents — in step with it, so a
    // renewal triggered by the socket does not leave the prekey fetch and the
    // attachment calls each burning a 401 to discover it.
    this.unsubscribeToken?.();
    this.unsubscribeToken = subscribeToken(next => {
      this.token = next;
      // And the socket's copy too. A renewal driven by the REST path revokes
      // the bearer the socket is holding, and a socket left with a revoked
      // token dials it forever: the probe asks about the CURRENT bearer, hears
      // 200, and reports a blip while the dial that keeps failing presents the
      // dead one. Keeping both copies in step is what makes the two seams one
      // feature instead of two that disagree.
      this.ws.adoptToken(next);
    });
    // The socket's disambiguation probe. It reads
    // `this.token` at call time rather than closing over `token`, so a
    // renewal that has already happened is the credential the probe checks.
    this.ws.start(token, () => probeAndHeal(this.token), () => this.mintWsTicket());
    // BACKGROUND DELIVERY, after the dial and never
    // before it: the foreground service is the permission to KEEP a socket,
    // not the thing that opens one, and starting it first would put
    // "Connected" on the screen over a session that has not connected. A
    // no-op on every other platform. The transport is installed with it, so
    // the Doze policy pauses THIS session's socket and no other.
    setDeliveryTransport(this);
    startBackgroundDelivery();
    // The storage ledger (AUTO_FETCH_STORAGE_CEILING): one SELECT per
    // session, off the boot path. Until it lands the gate reads "under" —
    // see the field for why that direction, and what it can cost.
    void this.loadStoredAttachmentBytes();
    // Crash recovery: finish work whose durable record exists but whose side
    // effects may not (interrupted blob downloads, unapplied reactions).
    void this.reconcileLocalState();
    // The one-time prekey pool, topped up on a schedule: off the boot
    // path, best-effort, at most once a day.
    void this.maybeReplenishPrekeys('schedule');
  }

  /**
   * Top up this device's one-time prekey pool:
   * `registration.replenishPrekeys` mints a fresh batch natively and
   * re-advertises it, throttled to once a day from here and to once an
   * hour from a served `lowPrekeyCount` signal. Best-effort — a failure is
   * asked again on the next start — and never logged: the failure could
   * name the server's answer.
   *
   * `registration.ts` is loaded LAZILY, at the call, on purpose (the
   * devhook.ts idiom): it imports the call stack and this module, and a
   * static import here would make the cycle a load-order hazard for every
   * module that starts with this one. A `require` rather than `import()`
   * because the jest runtime cannot evaluate a dynamic import without
   * `--experimental-vm-modules`. `hasIdentity` is asked first so a device
   * with nothing to mint from never loads it at all. */
  private async maybeReplenishPrekeys(reason: 'schedule' | 'low'): Promise<void> {
    const gen = this.generation;
    if (!this.token || session.mode === 'duress') return;
    try {
      if (!(await hasIdentity())) return;
      if (this.stale(gen)) return;
      const { replenishPrekeys } = require('./registration') as typeof import('./registration');
      const token = this.token;
      if (this.stale(gen) || !token) return;
      await replenishPrekeys(token, { reason });
    } catch {
      // Best-effort: the next start() (or the next low-pool signal) asks
      // again. The pool this device already advertised stays valid.
    }
  }

  /** Measure the persistent storage ledger — attachments AND chat avatars
   * — at session start. Fails OPEN, and the field's comment owns
   * that decision; the generation guard keeps a slow measurement of workspace
   * A from pricing workspace B's fetches. Avatars are summed into the SAME
   * ledger because they are stored bytes gated by the same ceiling: "one per
   * peer" is no bound when a Sybil roster can each supply a maximum-size face.
   */
  private async loadStoredAttachmentBytes(): Promise<void> {
    const gen = this.generation;
    try {
      const [attachments, avatars] = await Promise.all([
        db.sumAttachmentBytes(),
        db.sumAvatarBytes(),
      ]);
      if (this.stale(gen)) return;
      this.storedAttachmentBytes = (Number(attachments) || 0) + (Number(avatars) || 0);
    } catch {
      // Ledger stays null — under — rather than freezing every photo on a
      // measurement failure. A database this SELECT fails against is one
      // nothing else in this file works against either.
    }
  }

  /**
   * Close the socket because the app is leaving the foreground.
   *
   * THIS IS WHAT MAKES NOTIFICATIONS EXIST AT ALL. iOS freezes a backgrounded
   * process but leaves its TCP connection standing, so without this the
   * server sees a live connection row, `postToConnection` SUCCEEDS into the
   * frozen socket's buffer, the message is marked delivered — and no push is
   * ever sent. The recipient learns nothing until they open the app, which
   * is precisely a messenger with no notifications. Closing here makes the
   * server's `$disconnect` fire, the row die, and every message that follows
   * take the push branch.
   *
   * Deliberately NOT `stop()`: that is relock's tool and clears per-workspace
   * state — the block Set, the identity-change Set, the generation — none of
   * which stops being true because the phone went in a pocket.
   */
  private paused = false;

  pause(): void {
    if (!this.token) return;
    // ANDROID KEEPS THE SOCKET. Everything
    // above is an argument about a platform that pushes: close the socket so
    // the server takes the push branch. Android has no push branch in this
    // build — the socket IS the delivery path, and
    // MessagingForegroundService exists to hold precisely this one up — so
    // closing it here would produce the very defect the method exists to
    // prevent, arrived at from the other side: a messenger that hears nothing
    // while it is in a pocket. Device idle is the one signal that takes the
    // socket down here, and it has its own policy (background.ts
    // `applyDeviceIdle`, pinned by app/__tests__/doze.android.test.ts).
    if (socketSurvivesBackground()) return;
    this.suspendTransport();
  }

  /**
   * The DOZE pause — the Android background contract, stated as code: under
   * device idle the socket is paused and nothing is delivered; delivery
   * resumes on exit from idle.
   *
   * Separate from `pause` because they are separate signals — the app leaving
   * the screen, and the DEVICE going to sleep — and on Android only the second
   * may take the socket down.
   */
  pauseForIdle(): void {
    if (!this.token) return;
    this.suspendTransport();
  }

  /** The other edge. `resume` is already guarded on `paused`, so a wake that
   * follows no pause of ours dials nothing. */
  resumeFromIdle(): void {
    void this.resume();
  }

  private suspendTransport(): void {
    this.paused = true;
    // `suspend`, never `stop`: stop clears the frame/state handlers, and a
    // resume that re-dials without them is a connected socket the app cannot
    // hear — the server delivers into it and pushes nothing, which is the
    // exact incident this pair exists to fix, reproduced one layer down.
    this.ws.suspend();
  }

  /**
   * Reopen the socket on returning to the foreground.
   *
   * The spool is drained FIRST, for the same reason start() drains before
   * dialling: anything the extension decrypted while the app was away has a
   * spent ratchet key, and the reconnect triggers the server's redelivery of
   * exactly those ciphertexts. Importing first turns each redelivery into a
   * seen-and-ack; dialling first turns it into a race the rescue path has to
   * win. The badge sync is what clears the extension's counter now that the
   * messages are inside.
   */
  async resume(): Promise<void> {
    if (!this.token || !this.selfUserId) return;
    // Only a PAUSED session resumes. iOS fires inactive→active for Control
    // Center and the notification shade without any 'background' in between,
    // so an unguarded resume would dial a second socket over a live one.
    if (!this.paused) return;
    this.paused = false;
    await this.drainInbox();
    void syncBadge();
    this.ws.start(this.token, () => probeAndHeal(this.token), () => this.mintWsTicket());
  }

  /** A process-lifetime hook; callers own their idempotent disposer. */
  onTransportOpen(listener: () => void): () => void {
    this.transportOpenListeners.add(listener);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      this.transportOpenListeners.delete(listener);
    };
  }

  /**
   * A fresh single-use ticket for one dial, including every reconnect. One method rather than a closure at each `ws.start`,
   * because the rule below was written twice and has to hold in both.
   *
   * Null means "dial without a ticket", and it is returned for exactly one
   * reason: there is no bearer to mint with — a stopped or duress session,
   * where rule 15 requires the socket reach nothing at all.
   *
   * EVERY FAILURE THROWS, which is the half that matters. Catching any reads
   * as defensive and does the opposite: it makes the original defect
   * reachable on demand, because anyone who can fail this one request — a 500,
   * a 429, a WAF block — pushes the thirty-day bearer back into the socket URL
   * while the socket host itself stays up. A dial that fails and retries is the
   * safe outcome; a dial that succeeds carrying a month-long credential in a
   * logged URL is not.
   *
   * A 404 threw its lot in with the rest when the transition ended: the
   * branch existed for servers predating the route, production answers 401 —
   * never 404 — and a downgrade any middlebox could induce with a status code
   * is not a fallback, it is the defect with a trigger.
   */
  private async mintWsTicket(): Promise<string | null> {
    const bearer = this.token;
    if (!bearer) return null;
    return apiWsTicket(bearer);
  }

  stop(): void {
    this.generation++;
    this.paused = false;
    // A busy-retry timer poking the store after a relock would race the next
    // workspace's own drain; the generation check inside the callback already
    // refuses, so this is belt and braces plus hygiene.
    for (const wait of this.busyRetryWaits.splice(0)) {
      clearTimeout(wait.timer);
      wait.wake(false);
    }
    // Chains hold only this generation's frames; the next workspace's
    // first frame from any sender must not queue behind a dead handler.
    this.senderChains.clear();
    this.parkedDuplicates.clear();
    // Cleared so the next workspace's first frame for a msgId is not turned
    // away by a claim whose handler died with this generation; the stale
    // handler's finally only deletes entries carrying its OWN generation.
    this.inflightMsgIds.clear();
    this.ws.stop();
    this.socketLive = false;
    // With the socket, and in the same breath: an ongoing "Connected"
    // notification that outlived its session would advertise a connection
    // nothing is holding, and a Doze policy that outlived one would pause a
    // socket belonging to whatever opens next.
    setDeliveryTransport(null);
    stopBackgroundDelivery();
    this.selfUserId = null;
    // Before the field is nulled and before anything else can run: a token
    // delivered after a relock would re-arm `this.token` in a stopped service,
    // and a stopped service with a live bearer is precisely what rules 13/14
    // exist to prevent.
    this.unsubscribeToken?.();
    this.unsubscribeToken = null;
    this.token = null;
    this.inflight.clear();
    // A latch left by a pass the relock interrupted must not carry a flush
    // request into the next workspace; its start() re-flushes regardless.
    this.flushQueued = false;
    // Re-seeded by the next start() from whichever workspace opens then. A
    // duress session must never inherit the real session's list, and vice
    // versa.
    this.blockedPeers.clear();
    // The stream overlay is per-workspace memory under the same rules: a
    // decoy session must not inherit the real session's half-written
    // replies, and a continuation that survives the relock is refused by
    // its generation before it can repaint (applyStreamEdit's guard).
    streamEdits.clear();
    // The same rule, applied to the rest of the per-workspace state rather than
    // to one Set of it. `identityChanged` is re-seeded by start() from the
    // workspace that opens next, exactly as `blockedPeers` is; the other two
    // are in-flight bookkeeping about REAL peers and REAL uploaded blobs, and a
    // discipline that names rules 15/16 and then applies them to one of four
    // fields is a rule nobody can check. None of these is observable in a decoy
    // today (the ids do not collide and the paths that read them are duress
    // refused) — which is the argument for clearing them now, while that is
    // still true, rather than after some future screen makes it false.
    this.identityChanged.clear();
    this.sharingProfileTo.clear();
    this.pendingAvatar = null;
    this.downloadQueue.length = 0;
    this.downloadKeys.clear();
    // The auto-fetch window is per unlocked session. Both ends of a
    // relock/unlock cycle need the owner's passphrase, so resetting here
    // hands no budget to an attacker — and a decoy session must not inherit
    // (or be observable through) the real session's spend.
    this.autoFetchWindow = { startedAt: 0, bytes: 0, count: 0 };
    // The storage ledger goes back to "not measured": the next start()
    // measures whichever workspace opens then. Unlike the window this hands
    // nobody a budget — the ledger is the table, and the table survived.
    this.storedAttachmentBytes = null;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    // Per-workspace room state, cleared under rules 15/16 exactly as
    // `identityChanged` is: a decoy session must not inherit the real
    // session's skip banners, and a resume timer aimed at this generation's
    // flush must not fire into the next one's outbox.
    this.groupSkipped.clear();
    this.fanoutPacer = null;
    this.typingPacer = null;
    if (this.fanoutResumeTimer) {
      clearTimeout(this.fanoutResumeTimer);
      this.fanoutResumeTimer = null;
    }
    // The peer-notice feed must not outlive the session that armed it: a
    // notice fired into a stopped (or decoy-bound) messaging core would
    // read the wrong workspace.
    this.unsubscribePeerNotice?.();
    this.unsubscribePeerNotice = null;
  }

  /** True when a relock/stop happened after `gen` was captured. */
  private stale(gen: number): boolean {
    return gen !== this.generation;
  }

  // --- Safety numbers / identity change ---

  /** Whether sending to this peer is currently blocked by an unaccepted
   * safety-number change. */
  isPeerBlocked(peerUserId: string): boolean {
    return this.identityChanged.has(peerUserId);
  }

  /** Displayable safety number for a peer (null until a session is pinned). */
  getSafetyNumber(peerUserId: string): Promise<string | null> {
    if (!this.selfUserId) return Promise.resolve(null);
    return safetyNumber(this.selfUserId, peerUserId);
  }

  /**
   * Accept a peer's changed identity: re-pin (TOFU) and unblock sending.
   *
   * The ordering is the whole point and lives here rather than at the call
   * sites, because a screen that got it backwards would leave a stale "you
   * marked this as matching" standing against a key this device has already
   * seen change. Clear the local findings FIRST: if one of those writes fails,
   * the throw leaves sending blocked and nothing accepted, which is the safe
   * direction. A new identity is a new thing to verify — no earlier comparison
   * can vouch for it.
   */
  async acceptIdentityChange(peerUserId: string): Promise<void> {
    // Defense in depth: resetPeer touches the REAL
    // libsignal store. A duress session can never reach this (the block is only
    // seeded and set by start()/the wire, both refused in duress), but it must
    // not become reachable by accident either.
    if (session.mode === 'duress') throw new Error('messaging unavailable');
    await db.setSafetyChecked(peerUserId, null);
    await db.setSafetyMismatch(peerUserId, null);
    // The PAIR record too: the id being accepted
    // may also be a listed peer DEVICE with its own per-pair stamp, and a
    // human comparison made against the superseded key must not survive
    // the reset to vouch for the new one.
    await db.clearPeerPairSafety(peerUserId);
    // The ROSTER pin too: `peer_devices` recorded
    // the superseded key at the first TOFU moment, and that row — not the
    // native store — is what verifies a signed `x.acct.notice` from this
    // contact and vouches for their cross-signed siblings. Left standing,
    // every later notice failed against the key the human just retired:
    // dropped and acked, silently. Unpinned here, in the findings group,
    // for the same reason the findings are: a failed write throws before
    // the reset and leaves sending blocked, the safe direction. The next
    // served bundle re-pins (recordPeerIdentity's empty-key path) —
    // fetched below when the network allows, and by the next send otherwise.
    await forgetPeerIdentity(peerUserId, this.peerDeviceDeps());
    await db.setIdentityChanged(peerUserId, null);
    await resetPeer(peerUserId);
    this.identityChanged.delete(peerUserId);
    // Re-pin now rather than at the next send, so a signed notice arriving
    // in between verifies. Best-effort by contract: offline, the unpinned
    // row waits for the bundle the next send fetches anyway — and the
    // acceptance itself has already stood.
    if (this.token) {
      try {
        const bundle = await apiGetPrekeyBundle(this.token, peerUserId);
        const pd = this.peerDeviceDeps();
        await recordPeerIdentity(peerUserId, bundle.identityKey, pd, { force: true });
        // The roster signal every bundle fetch is (§2.5): siblings are
        // re-judged under the key just pinned.
        await this.notePeerBundle(peerUserId, bundle);
      } catch {
        // Transient: the unpinned row vouches for nothing until the next
        // bundle fetch re-pins it — never a stale key, never a silent trust.
      }
    }
    // The design: the hold this acceptance releases may
    // have been raised by an asserted sibling in the 'pending' state — the
    // human's review here IS the acceptance that ends the block-and-warn,
    // exactly the identityChanged contract the hold borrowed. The
    // roster-keyed block extension inside acceptPeerDevice still applies.
    try {
      for (const row of await db.listPeerDevices(peerUserId)) {
        if (row.state === 'pending') {
          await acceptPeerDevice(row.userId, this.peerDeviceDeps());
        }
      }
    } catch {
      // The identity acceptance stands either way; the hold resurfaces on
      // the next frame if the row write failed.
    }
    // Accepting the change is what the room banner asked for: their future
    // legs send again, so the banner naming them comes down in every room. Messages skipped meanwhile are NOT re-sent — the
    // same accepted residual as the 1:1 pause.
    for (const [groupId, skipped] of this.groupSkipped) {
      skipped.delete(peerUserId);
      if (skipped.size === 0) this.groupSkipped.delete(groupId);
    }
    this.notify();
  }

  /**
   * Members of this room whose legs are being skipped over an unaccepted
   * identity change — the ids behind `groupSafetySkipBanner`'s names. Empty array means no banner.
   */
  skippedInRoom(groupId: string): string[] {
    return [...(this.groupSkipped.get(groupId) ?? [])].sort();
  }

  // --- Blocking (local to this device; blocking.ts is the policy) ---

  /**
   * Whether this person has blocked that peer on this device.
   *
   * Distinct from isPeerBlocked(), which means an unaccepted identity change.
   * The two must never be OR-ed into one variable — see safetyStateFor: an
   * identity change is an alarm about a key, a block is this person's own
   * settled decision, and feeding the second into the first would paint
   * "their safety number changed" over someone who simply blocked a nuisance.
   */
  isBlockedLocally(peerUserId: string): boolean {
    return this.blockedPeers.has(peerUserId);
  }

  /**
   * The one value every policy predicate takes. Written as a helper rather
   * than a bare boolean so every gate below reads as a sentence out of
   * blocking.ts — `maySendTo('message', this.blockStateFor(peer))` — and so a
   * caller cannot accidentally hand a policy function the identity-change flag.
   */
  private blockStateFor(peerUserId: string): BlockState {
    return { blockedAt: this.blockedPeers.has(peerUserId) ? 1 : null };
  }

  /**
   * Block a peer on this device. The durable write comes first and the Set is
   * only mutated if it succeeded, so the UI's "Tacendum couldn’t save that"
   * is true whenever it is shown: a failed block must not look enforced for
   * the rest of this launch and then silently lapse on the next one.
   *
   * db.blockPeer also purges that peer's outbox inside the same transaction,
   * so there is no window where the block is recorded and a queued envelope is
   * still flushable. The purged rows' `inflight` entries are then pruned —
   * nothing could ever resend them (their rows are gone), but a map entry
   * with no row keeps `inflight.size` non-zero, and scheduleRetry would
   * re-arm a do-nothing flush every RECEIPT_TIMEOUT_MS for the rest of the
   * socket's life.
   */
  async blockPeer(peerUserId: string): Promise<void> {
    await db.blockPeer(peerUserId, Date.now());
    this.blockedPeers.add(peerUserId);
    await this.pruneInflight();
    // The notification extension reads a FILE, not this Set and not the
    // database — it has neither. AWAITED now, not fire-and-forget:
    // a block that does not reach the extension is a block that fails in the
    // one place it is most conspicuous — a banner or a full-screen ring on the
    // lock screen, from the person the owner just blocked — and both native
    // readers fail OPEN on a missing/stale mirror, so a swallowed write left
    // the block enforced in-app while the lock screen kept ringing. The DB
    // block is never rolled back (it IS enforced here); reconcile records
    // whether suppression reached the extension so the UI can surface it via
    // `isBlockNotificationMirrorStale`.
    await this.reconcileBlockedMirror();
    this.notify();
  }

  /** Whether notification suppression for blocked peers has NOT yet
   * reached the extension's mirror — the UI's read, right after `blockPeer`
   * resolves, for surfacing partial enforcement. In-memory, seeded from the
   * durable marker at start() and reconciled by every publish. */
  isBlockNotificationMirrorStale(): boolean {
    return this.blockedMirrorDirty;
  }

  /**
   * Mirror the blocked set to the file the extension reads, and RETURN whether
   * the write committed.
   *
   * Rewritten whole rather than appended to, so an unblock takes effect — a
   * mirror that only grew would keep suppressing notifications from someone
   * the owner deliberately let back in. A failure returns false rather than
   * throwing: the caller (reconcileBlockedMirror) records it durably instead.
   */
  private async publishBlocked(): Promise<boolean> {
    try {
      await publishBlockedPeers([...this.blockedPeers]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Publish the blocked mirror and reconcile the durable dirty marker.
   * Returns whether the extension's mirror is now in step with
   * the database. The marker is persisted to the app-private DB — never the
   * shared container whose failure it records — so a partial block survives a
   * relaunch; a marker that itself cannot be written is a strictly lesser
   * failure than the mirror it guards, so it is swallowed while the in-memory
   * flag and the next start()'s re-publish still hold.
   */
  private async reconcileBlockedMirror(): Promise<boolean> {
    const mirrored = await this.publishBlocked();
    const dirty = !mirrored;
    // Persist ONLY on a genuine change of state. The in-memory flag is seeded
    // from the durable marker at start(), so a healthy boot whose mirror
    // publishes must issue NO write at all — App.reauth pins that a re-auth
    // mutates nothing, and the marker only needs updating when enforcement
    // actually crossed between complete and partial.
    if (dirty !== this.blockedMirrorDirty) {
      this.blockedMirrorDirty = dirty;
      try {
        await db.setBlockedMirrorDirty(dirty);
      } catch {
        // A marker we cannot persist does not undo the block; the in-memory
        // flag and the next start's re-publish still hold.
      }
      // The flip is PUBLISHED, not merely readable: every
      // screen that renders the warning subscribes and re-reads on notify, so
      // a reconcile that changed the answer after a screen's last read — the
      // boot-time retry clearing it, a failed publish setting it — must poke
      // them or an open screen keeps announcing a mirror state this flag no
      // longer holds. Inside the change-guard, so a healthy no-change publish
      // stays invisible exactly as its no-write marker rule requires.
      this.notify();
    }
    return mirrored;
  }

  /**
   * Mirror every peer's resolved display name for the VoIP push's first
   * paint. `personName` precedence, minus the id fallback — an absent entry
   * makes the native side show its placeholder, which reads better on a
   * full-screen ring than eight characters of ULID.
   */
  private async publishNames(): Promise<void> {
    // Generation-checked around the db read: this is fire-and-forget from
    // several places, and a RELOCK (which keeps session.mode 'real' — the
    // mode gate in nse.ts only covers duress) must not have an in-flight
    // publish recreate the peer-names mirror that retractSelfId just
    // deleted. stop() bumps the generation before the relock retracts.
    const gen = this.generation;
    try {
      // 1:1 rows only (`listPeerNames`): rooms are chats rows too, and a
      // renamed room's name in the PEER file would sidestep the group
      // mirror's own gates for the same disclosure class.
      const peers = await db.listPeerNames();
      if (this.stale(gen)) return;
      await publishPeerNames(peers);
    } catch {
      // A mirror that cannot be written costs a name on a ring, nothing else.
    }
  }

  /**
   * Drop `inflight` entries whose outbox rows no longer exist. A per-peer
   * purge (a block, or Delete conversation on the chat list) erases rows by
   * peerId while this map is keyed by msgId, and every other eraser of an
   * entry needs the row (the MAX_SEND_ATTEMPTS branch), the receipt that was
   * already lost (handleReceipt), or an explicit retraction — so without this
   * sweep the entries are permanent. Public because the chat list's delete
   * path writes through db directly.
   */
  async pruneInflight(): Promise<void> {
    if (this.inflight.size === 0) return;
    const live = new Set((await db.listOutbox()).map(row => row.msgId));
    for (const msgId of [...this.inflight.keys()]) {
      if (!live.has(msgId)) this.inflight.delete(msgId);
    }
  }

  /**
   * Unblock: their messages appear here again from now on.
   *
   * ACCEPTED RESIDUAL: whatever arrived while they were blocked is gone. It was
   * decrypted and dropped, never queued locally, and unblocking does not bring
   * it back. That is intended — the confirmation copy says so before the block
   * is taken.
   *
   * reconcileLocalState is re-run so that a photo or avatar from BEFORE the
   * block, withheld by mayFetchFor while it stood, resumes downloading.
   */
  async unblockPeer(peerUserId: string): Promise<boolean> {
    await db.unblockPeer(peerUserId);
    this.blockedPeers.delete(peerUserId);
    // Same reason as blockPeer, in the other direction: without this the
    // extension keeps silently swallowing notifications from someone who has
    // been unblocked, which reads as "messages from them never arrive". Routed
    // through the reconcile so an unblock whose mirror write fails is flagged
    // and retried exactly as a block is.
    //
    // AWAITED, exactly as blockPeer awaits: fired and
    // forgotten, this promise resolved while the extension still SUPPRESSED
    // the person's calls and banners, `isBlockNotificationMirrorStale()` read
    // clean at the one moment every screen reads it, and each of them
    // announced ordinary success for an unblock the lock screen had not
    // heard about. The database unblock above is never rolled back — in-app
    // delivery IS restored — and the reconcile's verdict is returned so the
    // caller holds the same truth the flag now does.
    const mirrored = await this.reconcileBlockedMirror();
    this.notify();
    void this.reconcileLocalState();
    return mirrored;
  }

  /** Send a text: ensure session (X3DH/PQXDH), encrypt, enqueue, flush. */
  async sendText(peerUserId: string, text: string): Promise<void> {
    // Above the duress branch: a blocked conversation writes no local echo
    // either, in either world.
    if (!maySendTo('message', this.blockStateFor(peerUserId))) {
      throw new BlockedPeerError('blocked');
    }
    if (session.mode === 'duress') {
      await this.localEcho(peerUserId, text, text);
      return;
    }
    await this.encryptAndEnqueue(peerUserId, text, { preview: text });
    void this.shareProfileWith(peerUserId);
  }

  /**
   * Duress-session compose: the row lands in the decoy
   * workspace as already 'sent' — no session, no crypto, no wire. Composing
   * in a decoy thread must visibly work; nothing real may be touched.
   */
  private async localEcho(
    peerId: string,
    body: string,
    preview: string | null,
    onEnqueued?: (msgId: string, ts: number) => Promise<void>,
  ): Promise<void> {
    const gen = this.generation;
    const msgId = await nextMsgId();
    const ts = Date.now();
    if (this.stale(gen)) return;
    // The SAME expiry the real path stamps. A decoy row is still a row in a
    // room with a timer, and a decoy that outlives the setting is a decoy
    // that stands out — the one thing a decoy must never do. (Document bytes
    // and coordinates were the loudest version of this: they survived a
    // sweep that took every text around them.)
    const timer = (await db.getChat(peerId).catch(() => null))?.disappearSec ?? 0;
    if (this.stale(gen)) return;
    await db.insertMessage({
      msgId,
      peerId,
      direction: 'out',
      body,
      ts,
      status: 'sent',
      expiresAt: timer > 0 ? ts + timer * 1000 : null,
    });
    if (preview !== null) {
      const line = preview;
      await this.touchChatOrdered(peerId, ts, async () => line);
    }
    await onEnqueued?.(msgId, ts);
    this.notify();
  }

  // --- Rooms: the send path ------------------------

  /**
   * fanOut's pre-allocation gates, factored out so
   * the attachment composers can run them BEFORE the blob upload: the roster
   * fold, the member ceiling, my own membership, and THE BLOCK for every
   * member. sendImage's argument, room-shaped: blobEncrypt +
   * apiCreateAttachment + uploadBlob all run before any envelope exists, so a
   * gate that lived only inside fanOut would already have put a blob in the
   * shared store — which is itself a beacon to anyone watching that store. fanOut runs these same gates again itself; for an attachment
   * send that second pass is defence in depth, catching a block that landed
   * during the upload while nothing has been written yet.
   *
   * 'groupMessage', not 'message': room traffic argues its own row of the
   * OUTBOUND_WHILE_BLOCKED table rather than inheriting the 1:1 one.
   */
  private async roomComposeGates(groupId: string): Promise<{
    group: db.GroupRow;
    fold: ReturnType<typeof foldRoster>;
  }> {
    if (!this.selfUserId) throw new Error('messaging not started');
    const group = await db.getGroup(groupId);
    if (!group) throw new Error('no such room');
    const fold = foldRoster(
      group.ownerId,
      await db.listGroupMemberSlots(groupId),
      ownerOnlyPolicy,
    );
    // GROUP_MAX_MEMBERS in the composer as well as the schema: the
    // schema bounds a peer's grp.new; this bounds what a folded local roster
    // can make THIS phone transmit.
    if (fold.members.length > GROUP_MAX_MEMBERS) {
      throw new Error(
        `this room lists ${fold.members.length} members — the ceiling is ${GROUP_MAX_MEMBERS}`,
      );
    }
    if (verdictFor(fold, this.selfUserId) !== 'in') {
      throw new Error('you are not in this room');
    }
    // Gate 2 — the block, for EVERY member, before any allocation.
    for (const memberId of fold.members) {
      if (memberId === this.selfUserId) continue;
      if (!maySendTo('groupMessage', this.blockStateFor(memberId))) {
        throw new BlockedPeerError('blocked');
      }
    }
    return { group, fold };
  }

  /**
   * The mention-audience rule: the recipients of a room CONTENT (`grp.msg`)
   * message, with every AGENT member this message does not @mention removed.
   * The rule is per-agent, per-message: agent X keeps its leg iff the
   * structured mention `who[]` names X; a HUMAN member always keeps its leg.
   *
   * This is a SENDER DEFAULT, not a server rule — the honest ceiling the design
   * states out loud: a modified co-member client can still send an agent
   * anything the consent predicate allows, so the claim upgrades only to
   * "by default, agents receive only messages that mention them", never to
   * "provably". Because it is a default and not a refusal, a dropped agent is
   * simply NOT a recipient: it never reaches the leg ledger, so it renders no
   * failed/refused leg (that surface is the consent-refused case, where a
   * leg was ATTEMPTED and the server refused — a different thing kept
   * distinct here and in the tests).
   *
   * ROSTER-CLASS fan-out does NOT come through here: `grp.new`, `grp.roster`,
   * `grp.set`, `grp.del`, `grp.consent` and history relay all ride
   * `fanOutMembership`. Those fan to the whole folded roster except for the
   * ruled hold stance: after revocation it reaches human members and
   * no recognized agent. Only non-mention `grp.msg` content legs to agents
   * use the separate audience rule below.
   *
   * The agent set is the same three-signal set the consent surface reads
   * (`handleGroupConsent`): the owner's adopted machines (`machine_peers`) ∪
   * the room's AI-marked authors (`listRoomAgentAuthorIds`) ∪
   * the fold's roster classes — the owner's authoritative write.
   * The owner's client therefore excludes its own agents even before they
   * speak, and since the roster class, so does every co-member's: exclusion
   * no longer waits for the agent to have spoken. Humans are never here —
   * class comes only from the owner's authority slot. A malicious owner's
   * false mark costs a human, in that owner's room alone, the non-mention
   * content and typing legs PLUS the unmentioned-target lifecycle carriers
   * (edit/del/react — keepLifecycleAgents keeps an agent only for mentioned
   * targets) and a spoofable consent stance line (the class opens the
   * subject gate) — sender defaults and render facts, never a refusal, and
   * the mislabel badges visibly on every member's roster (the corrected
   * bound).
   */
  private async roomContentAudience(
    groupId: string,
    body: string,
    recipients: readonly string[],
    fold: ReturnType<typeof foldRoster>,
  ): Promise<string[]> {
    // The fold is THE CALLER'S — both call sites hold `{ group, fold }` from
    // roomComposeGates immediately before this call, so the audience is
    // computed against the exact roster the gates checked: one anchor read,
    // one fold (a remediation — this used to re-read the anchor and
    // re-fold off independently-timed reads, so the audience could in
    // principle see a roster the gates never did).
    const classed = Object.entries(fold.classes)
      .filter(([, cls]) => cls === 'integration')
      .map(([id]) => id);
    const agentIds = new Set<string>([
      ...(await db.listMachinePeers()),
      ...(await db.listRoomAgentAuthorIds(groupId)),
      ...classed,
    ]);
    // No agents in this room ⇒ nothing to prune, and no lookups worth doing.
    if (agentIds.size === 0) return [...recipients];
    // The agents this frame is ADDRESSED TO or OWNED BY; every OTHER agent's content leg is dropped. Humans have no
    // id in `agentIds`, so the predicate never touches them.
    const addressed = await this.roomAddressedAgents(body, agentIds);
    return recipients.filter(id => !(agentIds.has(id) && !addressed.has(id)));
  }

  /**
   * The agents a room CONTENT frame is ADDRESSED TO or OWNED BY — the
   * "addressed-or-owned" rule, which broadened the pure
   * @mention test. An agent keeps its content leg iff any one holds:
   *   1. the body @MENTIONS it (`mentionWho` — the original rule); OR
   *   2. REPLY-TO-CONTINUE: a `reply` whose composite ref names a row the agent
   *      AUTHORED. This MIRRORS attend's trigger owner branch exactly — there
   *      `ROOM_REF_RE.exec(ref)` with `ref[1] === selfUserId`; here the app's
   *      own canonical splitter `splitRoomRef` (the one `resolveRevisionTarget`
   *      and `resolveReactionTarget` already route revisions and reactions by)
   *      with `authorId === agentId`. The critical leg: the owner
   *      replies to Claude's message and it must reach Claude. OR
   *   3. LIFECYCLE CARRIER (edit/del/react): the agent already RECEIVED the
   *      TARGET message. "Received" is read CONSERVATIVELY off this phone's own
   *      messages store — the target's mention set (and, for a reaction, its
   *      author) — never re-derived. An agent whose only tie to the target was
   *      a reply-to-continue is UNDER-included, never over-included: harmless
   *      for a tombstone (no body) and safe for an edit (no leak).
   *
   * Ordinary non-mention chatter is still excluded; a HUMAN is never excluded.
   */
  private async roomAddressedAgents(
    body: string,
    agentIds: ReadonlySet<string>,
  ): Promise<Set<string>> {
    const keep = new Set<string>();
    for (const id of mentionWho(body)) if (agentIds.has(id)) keep.add(id);
    const env = parseEnvelope(body);
    if (!env) return keep; // bare text @mentions nobody (the loop added none)
    if (env.tcm === 'reply') {
      // Reply-to-continue: the agent that AUTHORED the replied-to row.
      const target = splitRoomRef(env.ref);
      if (target && agentIds.has(target.authorId)) keep.add(target.authorId);
      return keep;
    }
    if (env.tcm === 'edit' || env.tcm === 'del' || env.tcm === 'react') {
      await this.keepLifecycleAgents(env.tcm, env.ref, agentIds, keep);
    }
    return keep;
  }

  /**
   * Lifecycle carriers. The agent received the TARGET iff the
   * target row (looked up in THIS phone's own store by the ref) MENTIONED the
   * agent — or, for a reaction, was AUTHORED by it. Safe defaults when the
   * target is NOT found, the asymmetry the rule draws because the carriers
   * differ in what they carry:
   *   - del   : a tombstone carries NO body → INCLUDE (a redundant tombstone on
   *             a row the agent never had is a harmless no-op).
   *   - edit  : carries a NEW body → EXCLUDE (default-including would LEAK the
   *             new words to an unmentioned agent).
   *   - react : metadata only, but undeterminable target → EXCLUDE.
   */
  private async keepLifecycleAgents(
    kind: 'edit' | 'del' | 'react',
    ref: string,
    agentIds: ReadonlySet<string>,
    keep: Set<string>,
  ): Promise<void> {
    const includeAll = (): void => {
      for (const a of agentIds) keep.add(a);
    };
    const target = splitRoomRef(ref);
    if (!target) {
      if (kind === 'del') includeAll(); // undeterminable tombstone is harmless
      return; // edit/react: EXCLUDE when undeterminable
    }
    // Direction in this phone's own store: my own rows are 'out', a co-member's
    // 'in' — the ref's author prefix decides, as resolveReactionTarget does.
    const direction = target.authorId === this.selfUserId ? 'out' : 'in';
    let row: Awaited<ReturnType<typeof db.getMessage>> = null;
    try {
      row = await db.getMessage(ref, direction);
    } catch {
      row = null;
    }
    if (!row) {
      if (kind === 'del') includeAll(); // harmless tombstone
      return; // edit/react: EXCLUDE when the target cannot be resolved
    }
    const mentioned = new Set(mentionWho(row.body));
    for (const a of agentIds) {
      if (mentioned.has(a)) keep.add(a);
      else if (kind === 'react' && row.authorId === a) keep.add(a);
    }
  }

  /**
   * Send one message into a room: compose ONCE, then one leg per member
   * through the same encrypt core as a 1:1 send. The result is exactly one
   * `messages` row (keyed `${selfId}.${m}`, carrying authorId and sq) plus
   * one outbox row per sendable member, committed in ONE transaction
   * (`db.enqueueOutgoingFanout`) — a crash between them leaves neither.
   *
   * Gate order, and why it is this order:
   *
   *  1. DURESS, its own explicit local-only seam mirroring `localEcho`: one
   *     decoy row, nothing on the wire (the duress rule wants the
   *     seam stated, not inherited from start()'s refusal). Above every
   *     other gate, DELIBERATELY unlike sendText (whose block gate outranks
   *     its duress branch): the gates below read the ROSTER, and a duress
   *     session must not fold even the decoy's slot tables to decide
   *     whether to fake a send — the decoy row lands unconditionally.
   *  2. BLOCK, above everything else and before ANY allocation: a
   *     room containing someone you blocked is READ-ONLY. Sending around
   *     them is not offered, because omitting a member silently is itself
   *     the tell the blocking module exists to prevent — in a room a far
   *     louder one than in a 1:1, since B watches everyone answer things B
   *     never saw. Refusing here means no counter reserved, no id minted,
   *     no prekey fetched, no ratchet advanced, no row written.
   *  3. IDENTITY CHANGE skips THAT MEMBER's leg only, loudly:
   *     the other legs send, and the banner names who is not receiving.
   *     Deliberately not the 1:1 hard pause — see groupSafetySkipBanner.
   *
   * `body` is EXACTLY what `messages.body` would hold in a 1:1 chat — plain
   * text or a nested envelope JSON; this function wraps it in
   * `grp.msg` for the wire and stores it unwrapped, so every existing render
   * and replay path works on the row unchanged.
   */
  async fanOut(
    groupId: string,
    body: string,
    opts: {
      preview?: string | null;
      /** Runs after the one-transaction commit and before the first flush —
       * encryptAndEnqueue's contract, for the same side-effect rows (an
       * attachment's bytes, a reaction chip) that must exist by the time the
       * wire can move. In duress it runs against the decoy row instead, so
       * a decoy photo still gets its attachment row. */
      onEnqueued?: (msgId: string, ts: number) => Promise<void>;
    } = {},
  ): Promise<{ localMsgId: string; skipped: string[] }> {
    // The DEFAULT resolves names (the mentions contract): retrySend re-fans a
    // STORED mention envelope with no preview — the original send passed its
    // own resolved words, the retry only holds the wire body — and a
    // resolver-less default rewrote the chat line to " lunch? ". Computed
    // above the duress branch so the decoy leg carries the same line.
    const preview =
      opts.preview !== undefined
        ? opts.preview
        : (await this.previewWithNames(body)) || null;
    if (session.mode === 'duress') {
      let echoed = '';
      await this.localEcho(groupId, body, preview, async (id, ts) => {
        echoed = id;
        await opts.onEnqueued?.(id, ts);
      });
      return { localMsgId: echoed, skipped: [] };
    }
    if (!this.selfUserId || !this.token) {
      throw new Error('messaging not started');
    }
    const gen = this.generation;
    const selfId = this.selfUserId;

    const { group, fold } = await this.roomComposeGates(groupId);
    // The CONTENT audience. An AGENT member this
    // message does not @mention is dropped HERE, before the skip split, so
    // it is never a recipient of this sealed copy — not a skipped leg, not a
    // failed leg, simply absent (the clean-exclusion the paragraph draws,
    // distinct from the consent-refused leg). Human legs are untouched.
    const recipients = await this.roomContentAudience(
      groupId,
      body,
      fold.members.filter(id => id !== selfId),
      fold,
    );

    // Gate 3 — the identity-change skip, loud and per-member.
    const skipped: string[] = [];
    const sendable: string[] = [];
    for (const memberId of recipients) {
      (this.identityChanged.has(memberId) ? skipped : sendable).push(memberId);
    }

    // Allocations — only past every gate. `m` is the group-message id, minted
    // ONCE for all legs: it rides INSIDE the ciphertext, so a
    // time-ordered ULID is fine here; rule 19 binds the WIRE ids below, which
    // all come from randomMsgId.
    const sq = await db.reserveGroupSeq(groupId, 'msg');
    const m = await nextMsgId();
    const localMsgId = `${selfId}.${m}`;
    const rd = await composeRosterDigest(group.ownerId, fold.members, sha256);
    const wrapper = encodeEnvelope({
      tcm: 'grp.msg',
      g: groupId,
      m,
      rd,
      sq,
      b: body,
    });
    // Derived at the choke point exactly as encryptAndEnqueue derives it —
    // isCarrierEnvelope recurses through grp.msg into `b`, so a group
    // reaction inherits notify:false with no caller remembering a flag.
    const notify = !isCarrierEnvelope(wrapper);
    // My own copy's expiry, from the room's folded minimum — the
    // same clock-starts-at-send rule as a 1:1 send.
    const timer = effectiveDisappearSec(
      await db.listGroupSettingsSlots(groupId),
      fold,
      unconditionalPolicy,
    );

    const legs: db.FanoutLeg[] = [];
    for (const memberId of sendable) {
      // A relock mid-fan-out must not let a leg write into the other
      // workspace (the quiesce row): checked per LEG, and because every
      // row lands in the single transaction below, a stale abort here leaves
      // nothing partial anywhere.
      if (this.stale(gen)) throw new Error('messaging not started');
      // Defence in depth behind gate 2: a block that landed mid-compose
      // aborts the whole fan-out while nothing has been written yet.
      if (!maySendTo('groupMessage', this.blockStateFor(memberId))) {
        throw new BlockedPeerError('blocked');
      }
      try {
        if (!(await hasSession(memberId))) {
          const bundle = await apiGetPrekeyBundle(this.token, memberId);
          await processPreKeyBundle(bundle, selfId);
        }
        const { msgType, payload } = await encryptText(
          selfId,
          memberId,
          wrapper,
        );
        if (payload.length > MAX_PAYLOAD_B64_LENGTH) {
          // Same refusal as the 1:1 path: the server would reject the frame
          // and the poison envelope would wedge the outbox. Thrown before the
          // transaction, so nothing is written; the ratchet ids already
          // advanced for earlier legs are burned, the same accepted cost as a
          // 1:1 compose that fails after encryptText.
          throw new Error('message too large to send');
        }
        legs.push({
          // THE WIRE ID: 26 characters of pure CSPRNG, one per leg, no
          // timestamp, no counter. NEVER nextMsgId — N
          // monotonic ULIDs under one sender is a free, exact, durable
          // membership join key in the server's queue for 30 days.
          msgId: await randomMsgId(randomBytes),
          peerId: memberId,
          msgType,
          payload,
          notify,
        });
      } catch (err) {
        if (isIdentityChangeError(err)) {
          // Gate 3's mid-compose twin: the change surfaced by THIS encrypt.
          // Skip that member only — the room does not pause.
          this.identityChanged.add(memberId);
          void db.setIdentityChanged(memberId, Date.now()).catch(() => undefined);
          skipped.push(memberId);
          continue;
        }
        if (isNotFound(err)) {
          // No account behind that member id: there is no ciphertext to
          // queue, but the member must still be COUNTED — a settled failed
          // leg in the ledger, so "Not delivered to N of M" names them
          // instead of omitting them silently.
          legs.push({
            msgId: await randomMsgId(randomBytes),
            peerId: memberId,
            msgType: 'ciphertext',
            payload: '',
            notify,
            failed: true,
          });
          continue;
        }
        throw err;
      }
    }

    // Randomised recipient order: the flush transmits in
    // `outbox.seq` order, which enqueueOutgoingFanout assigns in THIS array's
    // order — so sort the legs by their wire ids, which are pure CSPRNG. A
    // uniform shuffle for free, from bytes already paid for.
    legs.sort((a, b) => (a.msgId < b.msgId ? -1 : a.msgId > b.msgId ? 1 : 0));

    if (this.stale(gen)) throw new Error('messaging not started');
    const ts = Date.now();
    await db.enqueueOutgoingFanout(
      {
        msgId: localMsgId,
        peerId: groupId,
        direction: 'out',
        body,
        ts,
        status: legs.length === 0 ? 'sent' : 'pending',
        expiresAt: timer > 0 ? ts + timer * 1000 : null,
        authorId: selfId,
        sq,
      },
      legs,
    );
    // The side-effect seam, exactly where encryptAndEnqueue runs it: after
    // the commit (the row exists, the legs are durable) and before the first
    // flush below (the bytes exist by the time the wire can move).
    await opts.onEnqueued?.(localMsgId, ts);
    // Settles the degenerate ledgers in one place (every leg pre-failed, or
    // none sendable) instead of special-casing them above.
    await db.aggregateFanoutStatus(localMsgId);
    // Recorded only once the others' legs are durably queued: a banner that
    // said "not receiving" while an earlier throw meant NOBODY was receiving
    // would be false.
    if (skipped.length > 0) this.recordSkipped(groupId, skipped);
    if (preview !== null) {
      const line = preview;
      await this.touchChatOrdered(groupId, ts, async () => line);
    }
    this.notify();
    await this.flushPending();
    return { localMsgId, skipped };
  }

  /**
   * Send one MEMBERSHIP envelope — `grp.new`, `grp.roster`, `grp.set` or
   * `grp.del` — to the room's folded membership. fanOut's sibling, sharing its machinery rather than copying it:
   * the same per-leg block / identity / duress gates in the same order, the
   * same `randomMsgId` wire ids (a membership change fanned with
   * correlated ids IS the join key), the same single-transaction
   * `enqueueOutgoingFanout`, the same leg ledger, and the same pacing bucket
   * (legs carry `localMsgId`, which is the token the gate reads, so
   * membership frames spend the SAME budget as messages — a roster write does
   * not get to burst past the window a message may not).
   *
   * These envelopes cannot ride inside `grp.msg` — the laundering refusal
   * — so without this seam every Add / Remove / Leave / timer /
   * delete-for-everyone applied only on the phone that made it.
   *
   * THE APPLY RIDES IN `opts.apply`, AND THE ORDER IS THE CONTRACT:
   * gates → apply → compose → enqueue. The gates (block above everything) run BEFORE the local apply, so a refused write leaves this phone's
   * roster byte-identical to everyone else's — applying first and then
   * refusing to send would be a silent per-phone fork, the defect class.
   * The closure returning false ("declined"/"stale") sends nothing and writes
   * no row, preserving the announce-only-when-applied rule (messaging:2370).
   * It runs under `runGroupApply`, serialised against the inbound apply path.
   *
   * ONCE THE APPLY HAS RUN THERE IS NO ABORT. A per-member compose failure
   * becomes a settled LEG_FAILED ledger row — durable, counted by "Not
   * delivered to N of M" — never a throw, because the roster HAS changed on
   * this phone and a thrown-away fan-out would be exactly the silent
   * divergence the gate order exists to prevent. (fanOut may still throw
   * mid-compose: a message send aborted whole costs nothing, since nothing
   * was applied. Here something was.) The only post-apply throws left are the quiesce (a relock must not write into the other workspace) and the
   * enqueue transaction itself failing — both surfaced by the screens with
   * their own copy, never silently.
   *
   * Two deliberate departures from the pre-apply block THROW, both the design's
   * own exits from a read-only room and both leaving a visible failed leg for
   * the blocked member rather than an omitted or transmitted one:
   *
   *  - LEAVE (my own sovereign `out`): The design offers "Leave" ON the
   *    blocked-member system row, so leaving must work from exactly the room
   *    state every other write is refused in. The blocked member's phone
   *    keeps a stale roster — the disclosed block residual, not a new leak.
   *  - `grp.del`: refusing would hold the whole room hostage to one block,
   *    and the button's copy already says best-effort.
   *
   * `grp.new` recipients come from the envelope's own `ms` (at create the
   * fold does not exist until the apply runs); everything else fans to the
   * folded membership — for `grp.roster` UNITED WITH the written-about member
   * (a Remove "fans to the full roster — B included, so it is not a
   * silent omission"; the same union is what lets a re-added leaver see
   * "invited back"). Nobody else, ever: both sources are authenticated local
   * state, and there is no caller-supplied recipient list to widen.
   *
   * ONE MEMBER, TWO POSSIBLE PAYLOADS, found while building this: an owner's
   * Add fans `grp.roster in` — but a BRAND-NEW member has no anchor, and the design
   * drops an authority write that has no room ("heals on the owner's next
   * write", which for an Add never comes). The design names the healing envelope:
   * the `grp.new` "that would have admitted a brand-new member". So when the
   * written-about member appears in NO stored slot of this room (neither
   * lane, never a writer), their leg carries a `grp.new` roster snapshot at
   * the same `n` instead of the bare roster write; everyone else still gets
   * the roster write. A re-added LEAVER has slots, keeps the roster-write leg,
   * and renders it as "invited back — Rejoin?" (only their own `in`
   * readmits them).
   *
   * `grp.del` ORDERS THE OTHER WAY AROUND INTERNALLY, and this is the design
   * contradiction found while building, recorded here: the counted purge
   * (`deleteGroup purgeState`) deletes every outbox leg whose parent message
   * row is in the room — a join that is deliberate — so a
   * room-parented grp.del fan-out would have its legs destroyed by the very
   * purge it announces. And a counted grp.del renders nothing (the
   * room it would announce into is gone), so there is no announcement row to
   * parent them to anyway. The legs therefore ride a NON-THREAD parent row
   * whose peerId is the composite localMsgId itself — a value structurally
   * unable to match any chats row, so it renders nowhere, while the legs keep
   * the ledger, the retries and the pacing token. Enqueued AFTER the purge:
   * a crash between apply and enqueue then leaves the room locally gone and
   * the delete unsent (the user sees the room still standing on other phones
   * and nothing on this one), whereas enqueue-then-purge would let the purge
   * eat the legs on every successful run. The narrow crash loss is accepted
   * and stated; the systematic one is not.
   */
  async fanOutMembership(
    groupId: string,
    envelope: Extract<
      GroupEnvelope,
      { tcm: 'grp.new' | 'grp.roster' | 'grp.set' | 'grp.del' | 'grp.hist' | 'grp.consent' }
    >,
    opts: {
      apply?: () => Promise<boolean>;
      /**
       * Restrict the send to ONE member (history sharing): a transcript entry
       * goes to the newcomer alone, never to the room. Intersected with the
       * folded roster rather than replacing it, so this can only ever narrow
       * the recipient set — it must not become a way to address a non-member.
       */
      only?: string;
    } = {},
  ): Promise<{
    localMsgId: string | null;
    skipped: string[];
    failed: string[];
  } | null> {
    // Compose-side validation FIRST (envelope.ts's encode invariant): an
    // envelope this build cannot parse must never reach the apply, the
    // ratchet, or the wire. Throws with nothing allocated and nothing applied.
    const body = encodeEnvelope(envelope);
    // A transcript entry announces NOTHING. Its legs parent to a non-thread
    // row exactly as grp.del's do, so relaying 200 messages leaves 200
    // durable outbox records and not one row in anybody's thread — the
    // sharing is announced once, by the `e`-less announcement leg.
    const isTranscript = envelope.tcm === 'grp.hist' && envelope.e !== undefined;
    const announce = envelope.tcm !== 'grp.del' && !isTranscript;

    if (session.mode === 'duress') {
      // The explicit seam, mirroring fanOut's: the apply runs against the
      // decoy workspace (conn() already points there), the announcement lands
      // as a decoy row, and NOTHING touches the wire. Above every other gate,
      // exactly as fanOut: a duress session must not fold slot tables to
      // decide whether to fake a send.
      const proceed = opts.apply ? await opts.apply() : true;
      if (!proceed) return null;
      let echoed: string | null = null;
      if (announce) {
        await this.localEcho(groupId, body, previewFor(body) || null, async id => {
          echoed = id;
        });
      }
      return { localMsgId: echoed, skipped: [], failed: [] };
    }
    if (!this.selfUserId || !this.token) {
      throw new Error('messaging not started');
    }
    const gen = this.generation;
    const selfId = this.selfUserId;

    const group = await db.getGroup(groupId);
    if (envelope.tcm !== 'grp.new' && !group) throw new Error('no such room');
    // The slots are read ONCE, before the apply, and every decision below —
    // recipients, the brand-new-member test — is made on this snapshot: for
    // grp.del the apply is the purge, after which there is nothing to read.
    const slots = await db.listGroupMemberSlots(groupId);
    const fold = group
      ? foldRoster(group.ownerId, slots, ownerOnlyPolicy)
      : null;
    if (fold && fold.members.length > GROUP_MAX_MEMBERS) {
      throw new Error(
        `this room lists ${fold.members.length} members — the ceiling is ${GROUP_MAX_MEMBERS}`,
      );
    }
    if (envelope.tcm === 'grp.del' && group!.ownerId !== selfId) {
      // Defence in depth behind the owner-only button: a non-owner's
      // grp.del takes effect nowhere and this phone must not emit one.
      throw new Error('only the owner can delete this room for everyone');
    }
    if (envelope.tcm === 'grp.hist' && group!.ownerId !== selfId) {
      // Rule 1 of the decision, defended on the send side as well as the
      // receive side. Every other phone will decline a non-owner's share, so
      // emitting one would only produce a room full of declined rows naming
      // this device — the honest failure is here, loudly, before the wire.
      throw new Error('only the owner can share this room’s history');
    }

    const targets = new Set<string>();
    if (envelope.tcm === 'grp.new') {
      for (const id of envelope.ms) targets.add(id);
    } else {
      for (const id of fold!.members) targets.add(id);
      if (envelope.tcm === 'grp.roster') targets.add(envelope.m);
    }
    targets.delete(selfId);
    // Narrowing only, and only to someone the fold already named: `only` picks
    // one recipient OUT of the roster, it never adds one to it. A transcript
    // addressed to a non-member would be history leaving the room.
    const recipients = opts.only
      ? [...targets].filter(id => id === opts.only)
      : [...targets];

    // The design/the design seam described above: a member no stored slot has ever
    // named cannot apply a bare roster write — their leg carries the room.
    const inviteTarget =
      envelope.tcm === 'grp.roster' &&
      envelope.s === 'in' &&
      !slots.some(
        s => s.memberId === envelope.m || s.writerId === envelope.m,
      )
        ? envelope.m
        : null;
    let inviteBody: string | null = null;
    if (inviteTarget !== null && group) {
      // Same `n` on both envelopes: the invited member folds in at exactly
      // the seq every other phone stores from the roster write, so the two
      // payloads describe ONE write, not an equivocation.
      const inviteMs = [...new Set([group.ownerId, ...fold!.members, inviteTarget])];
      // The snapshot's class claims, OWNER-ONLY: the
      // fold's existing classes plus the write's own `c` for the added
      // member, so a newcomer's very first fold already knows the room's
      // machines. A non-owner's snapshot claims nothing — their write never
      // counts, and the class is the owner's statement or nobody's.
      const inviteIc =
        selfId === group.ownerId
          ? inviteMs
              .filter(
                id =>
                  fold!.classes[id] === 'integration' ||
                  (envelope.tcm === 'grp.roster' &&
                    envelope.c === 'integration' &&
                    id === inviteTarget),
              )
              .sort()
          : [];
      inviteBody = encodeEnvelope({
        tcm: 'grp.new',
        g: groupId,
        nm: (group.name ?? '').trim() || 'Room',
        ms: inviteMs,
        n: envelope.n,
        ...(inviteIc.length > 0 ? { ic: inviteIc } : {}),
      });
    }

    // Gate 2 — the block, BEFORE the apply and before any allocation:
    // a room containing someone you blocked is read-only, and a write refused
    // here leaves the local roster exactly as unsent as the wire. The two
    // The design exits — my own leave, and the owner's grp.del — are the only
    // kinds that proceed; their blocked legs settle as visible failures below.
    const isExit =
      envelope.tcm === 'grp.del' ||
      (envelope.tcm === 'grp.roster' &&
        envelope.m === selfId &&
        envelope.s === 'out');
    // 'groupRoster', not 'message': a membership write argues its own row of
    // the OUTBOUND_WHILE_BLOCKED table — it already carries the two argued
    // The design exceptions below, which ordinary room speech must never inherit.
    if (!isExit) {
      for (const memberId of recipients) {
        if (!maySendTo('groupRoster', this.blockStateFor(memberId))) {
          throw new BlockedPeerError('blocked');
        }
      }
    }

    // THE APPLY — under the same serialisation as the inbound apply path, so
    // a roster frame arriving mid-action cannot interleave its load/persist
    // with ours. False means declined or stale: nothing announced, nothing
    // sent, nothing written by this seam.
    const proceed = opts.apply
      ? await this.runGroupApply(opts.apply)
      : true;
    if (!proceed) return null;

    // Revocation closes the server edge first and
    // its courtesy announcement goes to the HUMAN audience only. Keep the
    // full `recipients` set through the pre-apply block gate above — a hold
    // must not become a private exception to a read-only room — then narrow
    // only the legs minted for this one envelope. The agent set is the same
    // three-signal union used by roomContentAudience and the consent subject gate;
    // `envelope.a` is included defensively even if this phone has not learned
    // its class yet. Share and every other kind still fan to the complete
    // folded roster.
    let audience = recipients;
    if (envelope.tcm === 'grp.consent' && envelope.s === 'hold') {
      const agentIds = new Set<string>([
        envelope.a,
        ...(await db.listMachinePeers()),
        ...(await db.listRoomAgentAuthorIds(groupId)),
        ...(fold?.members.filter(id => fold.classes[id] === 'integration') ?? []),
      ]);
      audience = recipients.filter(memberId => !agentIds.has(memberId));
    }
    const skipped: string[] = [];
    const failedNow: string[] = [];
    const legs: db.FanoutLeg[] = [];
    for (const memberId of audience) {
      // The quiesce row, per leg: a relock mid-compose aborts before the
      // transaction below, so nothing lands in the other workspace.
      if (this.stale(gen)) throw new Error('messaging not started');
      if (this.identityChanged.has(memberId)) {
        // Gate 3 — skip encryption to THAT member loudly; the banner names
        // them, and a settled empty leg lets the event row's delivery
        // notice count the non-delivery instead of silently shrinking M.
        skipped.push(memberId);
        legs.push({
          msgId: await randomMsgId(randomBytes),
          peerId: memberId,
          msgType: 'ciphertext',
          payload: '',
          notify: true,
          failed: true,
        });
        continue;
      }
      if (!maySendTo('groupRoster', this.blockStateFor(memberId))) {
        // Reachable only on the two exit kinds (everything else threw above)
        // or a block landed mid-compose: a settled failed leg — counted,
        // visible, zero frames — never a silent omission.
        legs.push({
          msgId: await randomMsgId(randomBytes),
          peerId: memberId,
          msgType: 'ciphertext',
          payload: '',
          notify: true,
          failed: true,
        });
        failedNow.push(memberId);
        continue;
      }
      const legBody =
        inviteBody !== null && memberId === inviteTarget ? inviteBody : body;
      try {
        if (!(await hasSession(memberId))) {
          const bundle = await apiGetPrekeyBundle(this.token, memberId);
          await processPreKeyBundle(bundle, selfId);
        }
        const { msgType, payload } = await encryptText(
          selfId,
          memberId,
          legBody,
        );
        if (payload.length > MAX_PAYLOAD_B64_LENGTH) {
          throw new Error('message too large to send');
        }
        legs.push({
          // Rule 19, unchanged by the kind: every wire id is pure CSPRNG.
          msgId: await randomMsgId(randomBytes),
          peerId: memberId,
          msgType,
          payload,
          // Membership envelopes are NOT carriers: a roster or timer
          // change is a thing that happened to you, so it may notify.
          notify: !isCarrierEnvelope(legBody),
        });
      } catch (err) {
        if (isIdentityChangeError(err)) {
          this.identityChanged.add(memberId);
          void db
            .setIdentityChanged(memberId, Date.now())
            .catch(() => undefined);
          skipped.push(memberId);
          legs.push({
            msgId: await randomMsgId(randomBytes),
            peerId: memberId,
            msgType: 'ciphertext',
            payload: '',
            notify: true,
            failed: true,
          });
          continue;
        }
        // Post-apply, no abort (see the doc comment): the outcome is a
        // durable failed leg, visible as "Not delivered to N of M".
        legs.push({
          msgId: await randomMsgId(randomBytes),
          peerId: memberId,
          msgType: 'ciphertext',
          payload: '',
          notify: true,
          failed: true,
        });
        failedNow.push(memberId);
      }
    }
    // Randomised recipient order, from bytes already paid for.
    legs.sort((a, b) => (a.msgId < b.msgId ? -1 : a.msgId > b.msgId ? 1 : 0));

    if (!announce && legs.length === 0) {
      // A grp.del with nobody to tell (a solo room, or every member skipped):
      // the purge already ran in the apply; there is nothing to record.
      if (skipped.length > 0) this.recordSkipped(groupId, skipped);
      this.notify();
      return { localMsgId: null, skipped, failed: failedNow };
    }

    if (this.stale(gen)) throw new Error('messaging not started');
    const ts = Date.now();
    const localMsgId = `${selfId}.${await nextMsgId()}`;
    await db.enqueueOutgoingFanout(
      {
        msgId: localMsgId,
        // Announced kinds parent their legs to the room's own announcement
        // row — the same row the receive path writes for the same envelope —
        // so the legs die with the message or the room and the thread shows
        // the change. grp.del parents to a non-thread row (doc comment above).
        peerId: announce ? groupId : localMsgId,
        direction: 'out',
        body,
        ts,
        status: legs.length === 0 ? 'sent' : 'pending',
        // Membership announcements carry no expiry, exactly as the receive
        // path stores them: a roster change is not conversation.
        expiresAt: null,
        authorId: selfId,
        sq: envelope.n,
      },
      legs,
    );
    await db.aggregateFanoutStatus(localMsgId);
    if (skipped.length > 0) this.recordSkipped(groupId, skipped);
    if (announce) {
      await this.touchChatOrdered(groupId, ts, async () => previewFor(body));
    }
    this.notify();
    await this.flushPending();
    return { localMsgId, skipped, failed: failedNow };
  }

  /**
   * Share the room's recent history with a newcomer.
   *
   * THE REVERSAL THIS IMPLEMENTS, stated where the code is: until today the
   * app promised "people you add see what happens next, not what happened
   * before", and that was true by construction — senders fan out to the roster
   * AT SEND TIME, so a later member simply had no copies. The owner asked for
   * history sharing anyway, which is a reasonable ask, but it has a cost that
   * is not glossed: everyone already in the room sent those words believing
   * they went only to the people then present, and their consent cannot be
   * obtained now because the words are already sent.
   *
   * So the four rules of the decision are the four things this function does:
   * only the owner may call it, the owner states the extent, the room is TOLD
   * (the announcement is not optional and not suppressible), and the
   * disappearing timer still wins (enforced in the query here and
   * again against the receiver's own clock at apply).
   *
   * Announcement first, then one paced leg per entry. If the announcement
   * fails there is no share: the room learning what happened is a precondition
   * of the history moving, not a courtesy afterwards.
   */
  async shareHistory(
    groupId: string,
    newcomerId: string,
    extent: number,
  ): Promise<{ shared: number; announced: boolean }> {
    if (!this.selfUserId) throw new Error('messaging not started');
    const selfId = this.selfUserId;
    const group = await db.getGroup(groupId);
    if (!group) throw new Error('no such room');
    if (group.ownerId !== selfId) {
      throw new Error('only the owner can share this room’s history');
    }
    // A newcomer who is not in the roster is not a newcomer. Checked here as
    // well as by `only`'s intersection, so the caller gets a real error rather
    // than a silent zero-leg send.
    const slots = await db.listGroupMemberSlots(groupId);
    const fold = foldRoster(group.ownerId, slots, ownerOnlyPolicy);
    if (verdictFor(fold, newcomerId) !== 'in') {
      throw new Error('that person is not in this room');
    }

    const limit = Math.min(Math.max(Math.floor(extent), 0), MAX_HISTORY_SHARE);
    if (limit === 0) return { shared: 0, announced: false };
    // Oldest first on the wire: if the share is interrupted the newcomer keeps
    // a contiguous run ending at the interruption, rather than a scatter with
    // holes in it. `selectHistoryForShare` returns newest-first because the
    // EXTENT means the last n messages.
    const entries = (
      await db.selectHistoryForShare(groupId, limit, Date.now())
    ).reverse();
    if (entries.length === 0) return { shared: 0, announced: false };

    const seq = await db.reserveGroupSeq(groupId, 'writer');
    const announced = await this.fanOutMembership(groupId, {
      tcm: 'grp.hist',
      g: groupId,
      n: seq,
      to: newcomerId,
      c: entries.length,
    });
    // Duress returns a local echo and touches no wire; a declined apply
    // returns null. Either way nothing may be relayed.
    if (announced === null || session.mode === 'duress') {
      return { shared: 0, announced: announced !== null };
    }

    let shared = 0;
    for (const entry of entries) {
      // One entry per envelope: each was already a legal body, so nothing
      // needs chunking or reassembly, and a failure is one visible failed leg
      // instead of a silently truncated transcript.
      const sent = await this.fanOutMembership(
        groupId,
        {
          tcm: 'grp.hist',
          g: groupId,
          n: seq,
          to: newcomerId,
          c: entries.length,
          e: {
            m: entry.msgId.slice(entry.authorId.length + 1),
            a: entry.authorId,
            t: entry.ts,
            ...(entry.expiresAt !== null ? { x: entry.expiresAt } : {}),
            b: entry.body,
          },
        },
        { only: newcomerId },
      );
      if (sent !== null) shared += 1;
      // NO pacing here on purpose. The bucket lives at the FLUSH layer, not
      // at compose: every leg these enqueue is already metered by the same
      // `fanoutPacer` an ordinary fan-out goes through, so a second bucket
      // here would be a competing definition of one rate limit — and 200 rows
      // committing quickly is not the thing the server can see.
    }
    return { shared, announced: true };
  }

  /** The banner's bookkeeping, shared by both fan-out paths. */
  private recordSkipped(groupId: string, skipped: string[]): void {
    const set = this.groupSkipped.get(groupId) ?? new Set<string>();
    for (const id of skipped) set.add(id);
    this.groupSkipped.set(groupId, set);
  }

  // --- Profile cards (E2EE, peer-to-peer; no server-side profile) ---

  /**
   * Save my profile and share it with everyone I already talk to. The avatar
   * is uploaded ONCE per version and every peer receives the same blob
   * pointer, so N peers cost one upload.
   */
  async saveProfile(fields: {
    displayName: string;
    about: string;
    avatarB64: string;
  }): Promise<db.ProfileRow | null> {
    if (session.mode === 'duress') {
      // Decoy-local edit only: no version race matters, no share, no sync.
      // (The share path would fail silently anyway — this makes the seam
      // explicit rather than safe-by-accident.)
      const current = await db.loadProfile();
      const saved = await db.saveMyProfileCard({
        ...fields,
        version: (current?.profileVersion ?? 0) + 1,
      });
      this.notify();
      return saved;
    }
    const current = await db.loadProfile();
    // Versions must be strictly increasing or newest-wins breaks: two saves in
    // the same millisecond, or a clock moved backwards, would otherwise emit a
    // card that every peer ignores as stale.
    const version = Math.max(Date.now(), (current?.profileVersion ?? 0) + 1);
    const saved = await db.saveMyProfileCard({ ...fields, version });
    this.pendingAvatar = null; // re-uploaded lazily for the new version
    this.notify();
    // The decoy's copy of my own profile tracks the real one. Best-effort, and a silent no-op in a duress session.
    void syncDecoyProfile().catch(() => undefined);
    // Sharing is deliberately not awaited: the profile is saved the moment it
    // is on disk, and the UI must not wait on the network to say so.
    void this.broadcastProfile();
    return saved;
  }

  /** Push my current card to every peer that hasn't received this version. */
  private async broadcastProfile(): Promise<void> {
    const me = await db.loadProfile();
    if (!me || me.profileVersion === 0) return;
    for (const peerId of await db.chatsMissingMyProfile(me.profileVersion)) {
      // Belt and braces with the gate inside shareProfileWith. This is the
      // path that fires when someone edits their OWN name — a beacon they
      // never asked to send, to everyone they have ever talked to.
      if (!maySendTo('profileCard', this.blockStateFor(peerId))) continue;
      await this.shareProfileWith(peerId, me);
    }
  }

  /**
   * Send my card to one peer if they don't have this version yet. Failures are
   * swallowed: a profile is decoration, and it must never block or fail a
   * message send. The next send or launch retries.
   */
  private async shareProfileWith(
    peerUserId: string,
    profile?: db.ProfileRow,
  ): Promise<void> {
    try {
      // First statement inside the try: no card, and critically no
      // db.markMyProfileSent — recording a blocked peer as holding this
      // version would mean they never receive it after an unblock either.
      if (!maySendTo('profileCard', this.blockStateFor(peerUserId))) return;
      const me = profile ?? (await db.loadProfile());
      if (!me || me.profileVersion === 0) return;
      // A send and a broadcast can race for the same peer. The guard holds the
      // version in flight rather than a bare flag: a NEWER card must still get
      // through, or an edit made mid-send would never reach that person.
      const inflight = this.sharingProfileTo.get(peerUserId);
      if (inflight !== undefined && inflight >= me.profileVersion) return;
      if (await db.peerHasMyProfile(peerUserId, me.profileVersion)) return;

      this.sharingProfileTo.set(peerUserId, me.profileVersion);
      try {
        const avatar = me.avatarB64 ? await this.uploadAvatar(me) : null;
        const envelope = encodeEnvelope({
          tcm: 'profile',
          n: me.displayName,
          a: me.about,
          ...(avatar ? { att: avatar.attachmentId, key: avatar.keyB64 } : {}),
          v: me.profileVersion,
        });
        await this.encryptAndEnqueue(peerUserId, envelope, { preview: null });
        await db.markMyProfileSent(peerUserId, me.profileVersion);
      } finally {
        // Only clear my own claim — a newer share may already own the slot.
        if (this.sharingProfileTo.get(peerUserId) === me.profileVersion) {
          this.sharingProfileTo.delete(peerUserId);
        }
      }
    } catch {
      // Best-effort — retried on the next send or app start.
    }
  }

  /**
   * Encrypt + upload my avatar once per profile version, then reuse it.
   *
   * No block gate here on purpose: the only caller is shareProfileWith, which
   * already returned for a blocked peer before reaching this line. The upload
   * is also per-VERSION and shared across every peer, so gating it on one
   * relationship would be meaningless — it is my blob, not a message to them.
   */
  private async uploadAvatar(
    me: db.ProfileRow,
  ): Promise<{ attachmentId: string; keyB64: string } | null> {
    if (this.pendingAvatar?.version === me.profileVersion) {
      return this.pendingAvatar;
    }
    if (!this.token) return null;
    const { keyB64, blobB64 } = await blobEncrypt(me.avatarB64);
    const { attachmentId, uploadUrl } = await apiCreateAttachment(
      this.token,
      blobB64.length,
    );
    await uploadBlob(uploadUrl, blobB64);
    this.pendingAvatar = { attachmentId, keyB64, version: me.profileVersion };
    return this.pendingAvatar;
  }

  /**
   * COMPOSE-ONCE-UPLOAD-ONCE: encrypt the blob under ONE fresh
   * random key and upload it ONCE; the returned {att, key} pair is what every
   * recipient shares — the one peer of a 1:1, or all N legs of a fan-out,
   * each carrying the same capability id and the same key inside its own
   * ratchet. This helper being the ONLY caller of apiCreateAttachment +
   * uploadBlob on the message path is what keeps the 10/min attachmentCreate
   * trap structurally unwritable: a per-recipient loop 429s at the 11th
   * member. Callers gate BEFORE calling — a blob in the shared store
   * is itself a beacon to anyone watching that store.
   */
  private async composeAttachment(
    dataB64: string,
    kindWord: 'image' | 'file' | 'voice message',
  ): Promise<{ att: string; key: string }> {
    if (!this.token) throw new Error('messaging not started');
    // Reject BEFORE the native decode/encrypt round trip: the ciphertext b64
    // is ~40 chars longer than the plaintext b64, so an over-cap blob is
    // knowable up front — no point paying the peak-memory pipeline first.
    if (dataB64.length > MAX_ATTACHMENT_BYTES - 64) {
      throw new Error(`${kindWord} too large to send`);
    }
    const { keyB64, blobB64 } = await blobEncrypt(dataB64);
    if (blobB64.length > MAX_ATTACHMENT_BYTES) {
      throw new Error(`${kindWord} too large to send`);
    }
    // Blob first, envelope second: a crash between the two leaks only an
    // orphaned unreadable ciphertext blob (expired by the bucket lifecycle),
    // never a message pointing at a missing blob.
    const { attachmentId, uploadUrl } = await apiCreateAttachment(
      this.token,
      blobB64.length,
    );
    await uploadBlob(uploadUrl, blobB64);
    return { att: attachmentId, key: keyB64 };
  }

  /**
   * Send an image: encrypt the blob under a fresh AES-GCM key (native,
   * libsignal), upload the ciphertext to the presigned URL, then send the
   * pointer envelope (id + key + dimensions) through the normal Signal path —
   * or, into a room, ONE upload fanned to every member's leg.
   * The stored message body IS the envelope; the plain image lands in the
   * attachments table so the sender renders instantly.
   */
  async sendImage(
    peerUserId: string,
    imageB64: string,
    w: number,
    h: number,
  ): Promise<void> {
    // FIRST, above the duress branch and above the size check. blobEncrypt +
    // apiCreateAttachment + uploadBlob all run before the envelope is built, so
    // a gate placed any lower would already have put a blob in the shared
    // store — which is itself a beacon to anyone watching that store.
    if (!maySendTo('message', this.blockStateFor(peerUserId))) {
      throw new BlockedPeerError('blocked');
    }
    if (session.mode === 'duress') {
      // Placeholder pointer (parse-safe, never fetched): the decoy attachment
      // row is written 'ready', so nothing ever tries to download it. The
      // seam is the same whether the decoy thread is a person or a room —
      // localEcho lands the row in whichever it is, and nothing here reads
      // the roster to decide how to fake (fanOut's duress argument).
      const envelope = encodeEnvelope({
        tcm: 'image',
        att: 'decoy',
        key: 'decoy',
        w,
        h,
      });
      await this.localEcho(peerUserId, envelope, 'Photo', msgId =>
        db.putAttachment(msgId, 'out', 'ready', imageB64, w, h),
      );
      return;
    }
    if (!this.token) throw new Error('messaging not started');
    // The room seam. Definite answer only: anything short of
    // the anchor's "not a room" must throw rather than fall through, because
    // the 1:1 path would put the room id in SendFrame.to.
    const room = await db.getGroup(peerUserId);
    // The per-MEMBER block gate, BEFORE the upload — the same "gate above
    // the beacon" rule as the 1:1 gate at the top, N-shaped.
    if (room) await this.roomComposeGates(peerUserId);
    const { att, key } = await this.composeAttachment(imageB64, 'image');
    const envelope = encodeEnvelope({ tcm: 'image', att, key, w, h });
    // The local plain image is written via onEnqueued — before the envelope
    // can flush — so no receipted message ever lacks its attachment row. If a
    // crash still slips between commit and write, reconcileLocalState
    // re-downloads from the pointer on next launch.
    if (room) {
      await this.fanOut(peerUserId, envelope, {
        preview: 'Photo',
        onEnqueued: msgId =>
          db.putAttachment(msgId, 'out', 'ready', imageB64, w, h),
      });
    } else {
      await this.encryptAndEnqueue(peerUserId, envelope, {
        preview: 'Photo',
        onEnqueued: msgId =>
          db.putAttachment(msgId, 'out', 'ready', imageB64, w, h),
      });
      void this.shareProfileWith(peerUserId);
    }
    this.notify();
  }

  /**
   * Send a document. The same blob discipline as a photo — the server sees
   * only ciphertext length — with the name/size/mime riding inside the
   * ratchet as display facts.
   */
  async sendFile(
    peerUserId: string,
    dataB64: string,
    name: string,
    size: number,
    mime: string,
  ): Promise<void> {
    if (!maySendTo('message', this.blockStateFor(peerUserId))) {
      throw new BlockedPeerError('blocked');
    }
    if (session.mode === 'duress') {
      const envelope = encodeEnvelope({
        tcm: 'file',
        att: 'decoy',
        key: 'decoy',
        name,
        size,
        mime,
      });
      await this.localEcho(peerUserId, envelope, 'Document', msgId =>
        db.putAttachment(msgId, 'out', 'ready', dataB64, null, null),
      );
      return;
    }
    if (!this.token) throw new Error('messaging not started');
    // Room detection, then the per-member gate ABOVE the upload — sendImage's
    // ordering, for sendImage's reason.
    const room = await db.getGroup(peerUserId);
    if (room) await this.roomComposeGates(peerUserId);
    const { att, key } = await this.composeAttachment(dataB64, 'file');
    const envelope = encodeEnvelope({
      tcm: 'file',
      att,
      key,
      name,
      size,
      mime,
    });
    if (room) {
      await this.fanOut(peerUserId, envelope, {
        preview: 'Document',
        onEnqueued: msgId =>
          db.putAttachment(msgId, 'out', 'ready', dataB64, null, null),
      });
    } else {
      await this.encryptAndEnqueue(peerUserId, envelope, {
        preview: 'Document',
        onEnqueued: msgId =>
          db.putAttachment(msgId, 'out', 'ready', dataB64, null, null),
      });
      void this.shareProfileWith(peerUserId);
    }
    this.notify();
  }

  /**
   * Send a voice note. Byte-for-byte the document pipeline — the server sees
   * only ciphertext length — with a claimed duration riding inside the
   * ratchet so the bubble can size itself before the blob lands.
   */
  async sendVoice(
    peerUserId: string,
    dataB64: string,
    durationSec: number,
  ): Promise<void> {
    if (!maySendTo('message', this.blockStateFor(peerUserId))) {
      throw new BlockedPeerError('blocked');
    }
    // Clamped, not trusted: the recorder's own cap is the real limit, and a
    // duration outside the schema's range would make an envelope this build
    // cannot parse — which the encoder refuses at compose time anyway.
    const dur = Math.max(1, Math.min(VOICE_MAX_SECONDS, Math.round(durationSec)));
    if (session.mode === 'duress') {
      const envelope = encodeEnvelope({
        tcm: 'voice',
        att: 'decoy',
        key: 'decoy',
        dur,
      });
      await this.localEcho(peerUserId, envelope, 'Voice message', msgId =>
        db.putAttachment(msgId, 'out', 'ready', dataB64, null, null),
      );
      return;
    }
    if (!this.token) throw new Error('messaging not started');
    const room = await db.getGroup(peerUserId);
    if (room) await this.roomComposeGates(peerUserId);
    const { att, key } = await this.composeAttachment(dataB64, 'voice message');
    const envelope = encodeEnvelope({ tcm: 'voice', att, key, dur });
    // PAST THIS LINE THE MESSAGE IS COMMITTED. Both enqueue cores write the
    // message row and the outbox row(s) in one transaction and only THEN run
    // onEnqueued to store the audio — so a failure in the attachment write
    // leaves a queued envelope that will still send. The caller must be able
    // to tell that apart from a failure before the commit, or its "hand the
    // take back" repair becomes a duplicate send (found by review).
    let enqueued = false;
    const storeTake = (msgId: string): Promise<void> => {
      enqueued = true;
      return db.putAttachment(msgId, 'out', 'ready', dataB64, null, null);
    };
    try {
      if (room) {
        await this.fanOut(peerUserId, envelope, {
          preview: 'Voice message',
          onEnqueued: storeTake,
        });
      } else {
        await this.encryptAndEnqueue(peerUserId, envelope, {
          preview: 'Voice message',
          onEnqueued: storeTake,
        });
      }
    } catch (err) {
      if (enqueued && err && typeof err === 'object') {
        (err as { enqueued?: boolean }).enqueued = true;
      }
      throw err;
    }
    this.notify();
    if (!room) void this.shareProfileWith(peerUserId);
  }

  /** Share where I am, once. Coordinates travel only inside the ratchet. */
  async sendLocation(
    peerUserId: string,
    lat: number,
    lng: number,
  ): Promise<void> {
    if (!maySendTo('message', this.blockStateFor(peerUserId))) {
      throw new BlockedPeerError('blocked');
    }
    const envelope = encodeEnvelope({ tcm: 'loc', lat, lng });
    if (session.mode === 'duress') {
      await this.localEcho(peerUserId, envelope, 'Location');
      return;
    }
    if (!this.token) throw new Error('messaging not started');
    // No blob here, so fanOut's own gates are the gates: the
    // coordinates ride inside each member's ratchet exactly as they ride the
    // one ratchet of a 1:1.
    const room = await db.getGroup(peerUserId);
    if (room) {
      await this.fanOut(peerUserId, envelope, { preview: 'Location' });
    } else {
      await this.encryptAndEnqueue(peerUserId, envelope, {
        preview: 'Location',
      });
      void this.shareProfileWith(peerUserId);
    }
    this.notify();
  }

  /** Send (or with emoji '' retract) a tapback reaction to a message row. */
  async sendReaction(
    peerUserId: string,
    targetMsgId: string,
    targetDirection: 'in' | 'out',
    emoji: string,
  ): Promise<void> {
    // Returns silently rather than throwing: the reaction rail is removed for
    // a blocked conversation, so there is no error surface to report to and a
    // rejected promise here would be an unhandled rejection. No carrier, and
    // no local chip either — db.setReaction is never reached.
    if (!maySendTo('reaction', this.blockStateFor(peerUserId))) return;
    if (session.mode === 'duress') {
      await db.setReaction(
        targetMsgId,
        targetDirection,
        'out',
        emoji,
        Date.now(),
      );
      this.notify();
      return;
    }
    const envelope = encodeEnvelope({
      tcm: 'react',
      // In a room the ref is the row key `${authorId}.${m}` — already
      // this row's msgId, deterministic on every member's phone — and the
      // receive side DERIVES the direction from its author prefix, so the
      // `ofs` bit below is simply ignored there (resolveReactionTarget).
      ref: targetMsgId,
      // From the peer's perspective my 'out' rows are the ones I authored.
      ofs: targetDirection === 'out',
      emoji,
    });
    // Reactions ride the same durable outbox but never surface as rows: the
    // carrier message row is hidden by the UI's envelope filter, and the chat
    // preview is left untouched (fanOut derives notify:false the same way —
    // isCarrierEnvelope recurses through grp.msg). The local chip is
    // written via onEnqueued (before any flush); reconcileLocalState replays
    // carrier rows on boot, so sender and recipient state can't diverge
    // across a crash.
    const room = await db.getGroup(peerUserId);
    if (room) {
      await this.fanOut(peerUserId, envelope, {
        preview: null,
        onEnqueued: (_msgId, ts) =>
          db.setReaction(targetMsgId, targetDirection, 'out', emoji, ts),
      });
    } else {
      await this.encryptAndEnqueue(peerUserId, envelope, {
        preview: null,
        onEnqueued: (_msgId, ts) =>
          db.setReaction(targetMsgId, targetDirection, 'out', emoji, ts),
      });
    }
    this.notify();
  }

  /**
   * Tell this conversation that I took a screenshot of it. Always sent, never
   * configurable (envelope.ts: disclosure that can be switched off is not
   * disclosure). The notice annotates my own already-completed action, so it
   * is best-effort by design: a send that cannot bootstrap (offline with no
   * session, identity block) is dropped silently rather than interrupting.
   */
  /**
   * Agree a disappearing-message timer with this peer. Applied locally first
   * so the person who set it sees it take effect even if the send is queued,
   * and carried to the other side as a versioned envelope (newest wins).
   *
   * Blocked peers get nothing, like every other outbound path: a timer frame
   * would be a liveness beacon.
   *
   * The row this leaves behind IS the announcement ("a silently shortened timer is a trust problem"). encryptAndEnqueue stores
   * every plaintext it sends, so the sender's row is free — for a long time it
   * was also a bug, because nothing rendered it and the thread printed the
   * envelope as an ordinary chat bubble full of {"tcm":"timer"...}. It is now
   * a system line (ChatThreadScreen) on this side and an inserted row on the
   * peer's (handleIncoming), so both phones say the same thing.
   *
   * DOES THE ANNOUNCEMENT ITSELF EXPIRE? Yes when switching ON, no when
   * switching OFF — and that falls out of the ordering above rather than by
   * accident, so it is worth stating. db.setDisappearTimer lands BEFORE
   * encryptAndEnqueue reads `disappearSec`, so the "You set disappearing
   * messages to 1 hour" row is stamped with the very timer it announces and
   * goes with the conversation it belongs to. That is the property people
   * actually want: a thread that empties itself must not keep a permanent
   * ledger saying "this is the conversation where we turned the shredder on".
   * Switching OFF stamps nothing (disappearSec is 0 by then), so "You turned
   * disappearing messages off" persists — correct, because from that moment
   * nothing in the thread expires and the notice must outlive the setting it
   * revoked.
   */
  async setDisappearTimer(peerUserId: string, seconds: number): Promise<void> {
    if (!maySendTo('message', this.blockStateFor(peerUserId))) {
      throw new BlockedPeerError(peerUserId);
    }
    const version = Date.now();
    await db.setDisappearTimer(peerUserId, seconds, version);
    this.notify();
    const envelope = encodeEnvelope({ tcm: 'timer', s: seconds, v: version });
    // previewFor rather than a literal: the inbound branch previews the same
    // body through the same function, and two hand-written copies of one
    // sentence drift the moment either is reworded.
    await this.encryptAndEnqueue(peerUserId, envelope, {
      preview: previewFor(envelope),
    });
  }

  /**
   * Start the clock on what is now on screen, then remove whatever is already
   * past its time. Called when a thread is opened and when the app comes
   * forward — the two moments a person is actually looking.
   */
  async sweepDisappearing(peerId?: string): Promise<void> {
    const gen = this.generation;
    if (peerId !== undefined) {
      const chat = await db.getChat(peerId);
      const seconds = chat?.disappearSec ?? 0;
      if (seconds > 0 && !this.stale(gen)) {
        await db.armExpiry(peerId, seconds, Date.now());
      }
    }
    if (this.stale(gen)) return;
    const removed = await db.sweepExpired(Date.now());
    if (removed > 0 && !this.stale(gen)) this.notify();
  }

  /**
   * Tell them their messages have been displayed (the filled second tick).
   *
   * Called when a thread is on screen. Silent on every refusal, because the
   * caller is a screen-lifecycle effect and a receipt that cannot be sent is
   * never worth interrupting someone for.
   *
   * Five gates, in this order:
   *   - the SETTING. Read receipts are the one status that reports on a
   *     person rather than on a delivery, so they can be turned off. Off
   *     means nothing is sent and nothing is marked — a receipt withheld
   *     today must not be emitted tomorrow when the setting flips back.
   *   - blocking, like every other outbound kind. A receipt proves the device
   *     is live, in use, and that someone opened the thread.
   *   - duress. A decoy session must never confirm that the real person read
   *     anything; `encryptAndEnqueue` would refuse anyway, and returning here
   *     means the decoy does not even build the envelope.
   *   - ROOMS. Rooms send no read receipts: each reader
   *     emitting N−1 receipts makes an active room O(N²) frames per
   *     conversational round, and "who has read this" has nowhere to live.
   *     Gated at THIS seam and not only in the screen, because this path
   *     resolves its recipient into `SendFrame.to` — a user id, never a
   *     group id — so the seam must refuse a room id no matter
   *     who calls it. Room-ness is the anchor's answer (`db.getGroup`),
   *     exactly as both screens decide it; anything short of a definite
   *     "not a room" — the anchor row exists, the query failed — suppresses,
   *     because a receipt sent into a room is unrecoverable and one withheld
   *     retries on the next open (`readSent` stays 0). Only the outbound
   *     envelope is suppressed: unread counts and the blue-dot ride
   *     `markChatOpened`/`unreadCounts`, which nothing here touches.
   *   - nothing to say. No unacknowledged inbound rows, no envelope.
   */
  async sendReadReceipt(peerUserId: string): Promise<void> {
    if (!readReceiptsEnabled()) return;
    if (!maySendTo('readReceipt', this.blockStateFor(peerUserId))) return;
    if (session.mode === 'duress') return;

    // `undefined` (a failed read) is deliberately NOT `null` (the anchor
    // answered "no such room"): only the definite answer proceeds.
    const group = await db.getGroup(peerUserId).catch(() => undefined);
    if (group !== null) return;

    const pending = await db.unreadInboundIds(peerUserId).catch(() => []);
    if (pending.length === 0) return;

    // Split rather than truncate: the cap exists so a single envelope stays
    // bounded, not so the tail of a long thread is silently never
    // acknowledged.
    for (let i = 0; i < pending.length; i += MAX_READ_IDS) {
      const batch = pending.slice(i, i + MAX_READ_IDS);
      try {
        await this.encryptAndEnqueue(
          peerUserId,
          encodeEnvelope({ tcm: 'read', ids: batch }),
          // `preview: null` — a read receipt must not touch the chat list.
          // Being told someone read you is not a new message, and a preview
          // line saying so would reorder the list and look like traffic.
          { preview: null },
        );
      } catch {
        // Blocked, in duress, or the ratchet refused. Leave `readSent` alone
        // so the next time the thread opens it tries again.
        return;
      }
      // AFTER the enqueue, so a failure above leaves them unacknowledged
      // rather than marking them sent for an envelope that never existed.
      await db.markReadSent(batch).catch(() => undefined);
    }
  }

  async sendScreenshotNotice(peerUserId: string): Promise<void> {
    // THE GATE THAT CANNOT LIVE IN THE UI. App.tsx calls this unconditionally
    // from the screenshot listener and App.tsx is not this feature's to edit —
    // but more to the point, screenshotting a harasser's thread to gather
    // evidence is exactly the act that would otherwise transmit proof that
    // this phone is online and reading them. Above the try, above
    // encodeEnvelope, above the duress branch; returns silently, because this
    // path's whole contract is that it never throws. (For a room this state
    // is always CLEAR — a room id is never blockable — and the per-MEMBER
    // gates live inside fanOut, the read-only rule: their throw lands in
    // this catch, so a room holding someone you blocked discloses nothing.)
    if (!maySendTo('screenshotNotice', this.blockStateFor(peerUserId))) return;
    const envelope = encodeEnvelope({ tcm: 'shot' });
    try {
      if (session.mode === 'duress') {
        // Rule 15: the decoy thread shows the notice; nothing real is
        // touched. Identical whether the decoy thread is a person or a room
        // — localEcho lands the row in whichever it is — and deliberately
        // ABOVE the anchor read below, fanOut's own duress argument: a
        // duress session must not read room state to decide how to fake.
        await this.localEcho(peerUserId, envelope, 'Screenshot');
        return;
      }
      // The room seam: a screenshot of a room disclosed
      // the room, so the notice fans to the full membership through fanOut —
      // the same legs, gates, ledger and pacing as any room message — and a
      // room id never reaches encryptAndEnqueue, which would put it in
      // `SendFrame.to`. sendReadReceipt's definite-answer rule:
      // anything short of the anchor's definite "not a room" falls silent,
      // because a notice sent astray is unrecoverable and one withheld
      // annotates an action already complete.
      const group = await db.getGroup(peerUserId).catch(() => undefined);
      if (group !== null) {
        if (group === undefined) return;
        await this.fanOut(peerUserId, envelope, { preview: 'Screenshot' });
        return;
      }
      await this.encryptAndEnqueue(peerUserId, envelope, {
        preview: 'Screenshot',
      });
    } catch {
      // Dropped, not logged — the body is content-adjacent, and
      // there is no compose surface to report a failed notice to. The duress
      // branch is inside the same net: never-throws is the whole contract.
      // A room fan-out refused by a member's block ends here too, silently —
      // The evidence-gathering case, generalised to N members.
    }
  }

  // --- Shared Room Vault ---

  /**
   * Who this phone is, for the writer-id tiebreak.
   *
   * `selfUserId` is null in a duress session (messaging never starts), so the
   * decoy path falls back to the profile row — which holds the same account id,
   * because the profile is the one real datum sanctioned to cross into the
   * decoy file. That keeps a decoy vault row the same SHAPE as
   * a real one: a `writerId` column that read differently in the two worlds
   * would be exactly the kind of cheap probe rule 16 forbids.
   */
  private async selfWriterId(): Promise<string> {
    if (this.selfUserId) return this.selfUserId;
    try {
      return (await db.loadProfile())?.userId ?? '';
    } catch {
      return '';
    }
  }

  /**
   * A vault frame from the PEER becomes a row in the peer's slot.
   *
   * The old doctrine here was "one function for every direction", on the theory
   * that convergence rested on both phones running the same comparison. It does
   * not, and that theory was doing real harm: it forced my own writes down a
   * path that had to guess at a version, which is how two overlapping saves
   * came to share one. Convergence rests on the SHAPE of the state — one slot
   * per writer, merged by that writer's own counter (see db.mergeVaultSlot) —
   * so the inbound and outbound paths are free to differ, and they must, since
   * only one of them allocates a number.
   *
   * `writerId` is `frame.from` and is not taken from the payload: a peer cannot
   * write into my slot with anything they can construct.
   *
   * Returns whether it applied, so the caller can suppress an announcement for
   * a write that changed nothing.
   */
  private async applyVaultEnvelope(
    peerId: string,
    envelope: VaultEnvelope,
    writerId: string,
    at: number,
    gen: number,
  ): Promise<boolean | 'stale'> {
    // A `set` missing either field is dropped rather than stored blank. The
    // wire format allows both to be absent (a `del` carries neither), so
    // "absent" is a shape a peer can send at will — and an item with no name
    // is unreachable in the vault UI while an item with no value is a
    // credential that is not there. Neither is worth a row or an announcement.
    //
    // Dropped HERE rather than refused by the schema on purpose: a parser
    // refusal costs the whole message, and this transport gives no second copy.
    // The receiver stays strictly more permissive than the sender.
    if (envelope.op === 'set' && (!envelope.title || !envelope.body)) {
      return false;
    }
    // THE ACK CLAMP, and it is the security teeth of the whole scheme. `k`
    // claims "I had already seen your write number k". Unclamped, a peer sends
    // k = 999999, their slot dominates mine for a write they never saw, and my
    // value is suppressed with no trace. `k` can only legitimately name a write
    // *I* made, so clamping it to my own counter is exact rather than
    // heuristic. It does not stop a hostile peer overwriting an item — nothing
    // can, they are a writer — but it stops them suppressing history that never
    // reached them.
    //
    // WHEN I HOLD NO SLOT AT ALL the exact clamp is unavailable, and clamping to
    // 0 there was itself a defect: it is what made `deleteChat` (which purges
    // this item) destroy the only record of how high my counter had got,
    // so my next write restarted at 1 and every frame up to the peer's stored
    // high-water mark was discarded by the merge, silently and forever. Their
    // claim is the repair — it IS their copy of my counter — so it is honoured,
    // bounded by VAULT_ACK_TRUST_MAX so an absurd claim cannot exhaust the
    // counter space (see the constant, and db.reserveVaultSeq's `floor`).
    //
    // Honouring it suppresses nothing: the slot it would order against does not
    // exist, and by the time it does, `floor` has already carried my counter
    // past it.
    const mine = (await db.listVaultSlots(peerId, envelope.id)).find(
      slot => slot.writerId !== writerId,
    );
    // Rule 13/14, and the read above is exactly why it is needed HERE rather
    // than only at the top: a relock landing between that read and this write
    // would put a real vault slot into whichever workspace opened next. The
    // caller acks on a boolean, so staleness has to be its own answer — an
    // acked frame is destroyed on the server and there is no second copy.
    if (this.stale(gen)) return 'stale';
    return db.mergeVaultSlot({
      peerId,
      id: envelope.id,
      writerId,
      seq: envelope.n,
      ackSeq: mine
        ? Math.min(envelope.k, mine.seq)
        : Math.min(envelope.k, VAULT_ACK_TRUST_MAX),
      title: envelope.title ?? '',
      body: envelope.body ?? '',
      // THIS phone's clock, not `frame.ts`. A relayed timestamp is unproven,
      // and mixing it with the local one on the outbound path is what made two
      // phones list the same vault in different orders (see listVaultItems).
      updatedAt: at,
      deleted: envelope.op === 'del' ? 1 : 0,
    });
  }

  /**
   * Save (or overwrite) one vault item and tell the other phone.
   *
   * Returns the item's id, minting one when the caller is creating rather than
   * editing — ULIDs come from the same entropy pool msgIds do, so the id is
   * time-ordered and the vault has no second identifier scheme.
   *
   * ORDER OF THE THREE GATES, each for its own reason:
   *  - the block gate is FIRST, above the duress branch and above every write.
   *    A vault op is a liveness beacon like any other frame, and a blocked
   *    conversation writes no local echo either, in either world;
   *  - the duress branch is second. Without it the write
   *    reaches encryptAndEnqueue, which throws 'messaging not started' because
   *    a duress session never starts messaging — and the peer-profile screen
   *    would then show an error string that a healthy real session never
   *    produces. That is a one-tap oracle telling a coercer which code was
   *    entered, which is precisely what the duress-indistinguishability rule forbids;
   *  - a safety-number change is deliberately NOT caught here. It throws out of
   *    encryptAndEnqueue and must reach the compose surface: a vault write is
   *    the last thing that should go quietly to a key nobody has verified.
   *
   * WHAT IS WRITTEN WHEN. The counter is RESERVED before the send, because the
   * frame has to carry it; the content is COMMITTED from `onEnqueued`, exactly
   * as react/edit/del do, because a refused or unencryptable write must leave
   * the vault untouched. Reserving is not writing: a fresh slot is created as an
   * empty tombstone and an existing one keeps its content, so a write that never
   * reaches the wire changes nothing a person can see — and `releaseVaultSeq`
   * hands the number back so it does not even change what a person cannot see.
   * The crash window between the outbox commit and the content write is the same
   * one react/edit/del have, and `reconcileLocalState` replays it.
   *
   * Refusals happen in strict order of how much they cost: shape first (nothing
   * allocated at all), then the block gate, then duress, then the wire.
   */
  async saveVaultItem(
    peerUserId: string,
    item: { id?: string; title: string; body: string },
  ): Promise<string> {
    // FIRST, above every gate and every allocation. A value the composer should
    // never have accepted must fail here, loudly, with something the UI can
    // render — not at the peer's parser, where the frame is already spent: the
    // ack purges the server copy and the ratchet key is consumed, so a frame
    // the receiver refuses is a credential nobody has any more.
    assertVaultItemFits(item.title, item.body);
    if (!maySendTo('vaultItem', this.blockStateFor(peerUserId))) {
      throw new BlockedPeerError(peerUserId);
    }
    const id = item.id ?? (await nextMsgId());
    await this.dispatchVaultWrite(peerUserId, {
      op: 'set',
      id,
      title: item.title,
      body: item.body,
    });
    return id;
  }

  /**
   * Retract a vault item on both phones. Same gates, same path — the only
   * difference is that the envelope carries no title and no value, so a
   * deletion cannot re-transmit the credential it is deleting.
   */
  async deleteVaultItem(peerUserId: string, id: string): Promise<void> {
    if (!maySendTo('vaultItem', this.blockStateFor(peerUserId))) {
      throw new BlockedPeerError(peerUserId);
    }
    await this.dispatchVaultWrite(peerUserId, { op: 'del', id });
  }

  /**
   * The half both vault senders share: allocate, tell the other phone, then
   * commit locally — duress echo or real wire.
   *
   * `k` is read BEFORE the reservation and names the peer's slot, which is the
   * one claim a clock cannot make: "this write had already seen your write
   * number k". Reading it a moment early can only make it stale, never wrong —
   * a stale `k` shows a disagreement that has already been resolved, whereas an
   * inflated one would hide a real one.
   */
  private async dispatchVaultWrite(
    peerUserId: string,
    op:
      | { op: 'set'; id: string; title: string; body: string }
      | { op: 'del'; id: string },
  ): Promise<void> {
    const writerId = await this.selfWriterId();
    const slots = await db.listVaultSlots(peerUserId, op.id);
    const peerSlot = slots.find(slot => slot.writerId === peerUserId);
    const ackSeq = peerSlot?.seq ?? 0;
    // Their slot's `ackSeq` is THEIR COPY OF MY COUNTER — the `k` they last put
    // on the wire. Passing it as the reservation's floor is what stops a purged
    // conversation (deleteChat) restarting my counter underneath the
    // high-water mark they still hold, which would otherwise make every one of
    // my next writes vanish into their merge guard. See db.reserveVaultSeq.
    const seq = await db.reserveVaultSeq(
      peerUserId,
      op.id,
      writerId,
      Date.now(),
      peerSlot?.ackSeq ?? 0,
    );
    const commit = async (_id: string, ts: number) => {
      await db.commitVaultSlot({
        peerId: peerUserId,
        id: op.id,
        writerId,
        seq,
        ackSeq,
        title: op.op === 'set' ? op.title : '',
        body: op.op === 'set' ? op.body : '',
        updatedAt: ts,
        deleted: op.op === 'del' ? 1 : 0,
      });
    };
    // Set the instant the outbox row is durable, and read by the catch below.
    // Everything after that commit — touchChat, the content commit itself,
    // notify(), flushPending() — can still throw, and until this flag existed
    // every one of those throws handed back a number that a queued frame was
    // already carrying. See the catch.
    let onWire = false;
    try {
      const envelope: VaultEnvelope =
        op.op === 'del'
          ? { tcm: 'vault', op: 'del', id: op.id, n: seq, k: ackSeq }
          : {
              tcm: 'vault',
              op: 'set',
              id: op.id,
              title: op.title,
              body: op.body,
              n: seq,
              k: ackSeq,
            };
      // Throws for anything this build could not parse back (envelope.ts), so
      // a frame that would have arrived as "Unsupported message" never leaves.
      const body = encodeEnvelope(envelope);
      if (session.mode === 'duress') {
        // The decoy vault visibly accepts the item and the decoy thread shows
        // the notice; no session, no crypto, no wire. The row lands 'sent' like
        // every other local echo — a 'pending' row would show a spinner that
        // resolves in a workspace with no socket.
        await this.localEcho(peerUserId, body, previewFor(body), commit);
        return;
      }
      // previewFor rather than a literal, for the reason setDisappearTimer
      // gives: the inbound branch previews the same body through the same
      // function, and two hand-written copies of one sentence drift the moment
      // either is reworded. Non-null, or touchChat is skipped and the chat list
      // never learns the conversation moved.
      await this.encryptAndEnqueue(peerUserId, body, {
        preview: previewFor(body),
        onEnqueued: commit,
        onWire: () => {
          onWire = true;
        },
      });
    } catch (err) {
      // ONLY IF NOTHING REACHED THE WIRE. The old comment here asserted that
      // outright — "nothing reached the wire, so nobody can be holding this
      // number" — and it was false for every throw raised after
      // `db.enqueueOutgoing` commits, which is its own transaction: touchChat,
      // the content commit, `notify()` (whose subscribers are unguarded, unlike
      // emitEnvelope's) and `flushPending()` all run afterwards and all can
      // throw. Releasing there walks the counter back to seq-1 while a durable
      // outbox row carrying seq is still queued; the next save then reserves
      // seq AGAIN with different content, the peer's merge sees `seq > seq` as
      // false and drops it, and the two phones hold different credentials with
      // nothing on either screen to say so. `reconcileLocalState` cannot repair
      // it either — it replays at the frame's own number, and commitVaultSlot's
      // `seq = ?` guard no-ops against a slot that has been walked back.
      //
      // Guarded on the number itself inside db as well, so a save that overtook
      // this one keeps its reservation.
      if (!onWire) {
        await db
          .releaseVaultSeq(peerUserId, op.id, writerId, seq)
          .catch(() => undefined);
      }
      throw err;
    }
  }

  /**
   * Apply new words to a row, preserving whatever shape that row has — a
   * reply keeps its quote. Reads the current body first, so both sides do the
   * same merge against their own copy and the wire only carries the text.
   */
  private async editRow(
    peerUserId: string,
    targetMsgId: string,
    direction: 'in' | 'out',
    text: string,
    ts: number,
    /** The edit envelope's own Art. 50 claim, raise-only in db.applyEdit.
     * Only the inbound arm passes it; my own compose paths and the
     * held-revision replay (which does not persist the claim — a recorded
     * residual) leave it false, which touches nothing. */
    ai = false,
  ): Promise<boolean> {
    // A durable edit of an INBOUND row is the stream's final word —
    // the overlay key for (peer, that msgId) closes for good, and every
    // late relay frame for it repaints nothing. Closed BEFORE the row
    // rewrite so an intermediate racing this apply cannot slip in between;
    // closed even when the apply below no-ops (parked, stale, redelivered)
    // because an edit ARRIVING at all means the turn is over. Both inbound
    // apply sites — the direct arm and held-revision replay — funnel
    // through here, which is why the hook lives here and not in the arm.
    // 'out' edits are my own compose path and duress decoys: no overlay
    // has ever existed for those keys, and the peer scope would be wrong.
    if (direction === 'in') streamEdits.close(peerUserId, targetMsgId);
    let body = text;
    try {
      const current = await db.getMessage(targetMsgId, direction);
      if (current) body = rewriteBody(current.body, text);
    } catch {
      // No row to read: applyEdit will report that nothing matched and the
      // caller parks the revision.
    }
    return db.applyEdit(peerUserId, targetMsgId, direction, body, ts, ai);
  }

  /**
   * Rewrite a message I already sent. Only my own words are editable, which
   * is why the envelope carries no authorship bit — the recipient applies it
   * to the row I authored, full stop. My own copy changes at compose time so
   * the two sides never disagree while the wire catches up.
   */
  async sendEdit(
    peerUserId: string,
    targetMsgId: string,
    text: string,
  ): Promise<void> {
    // Silent, like sendReaction: no carrier AND no local editRow. The row
    // belongs to a conversation that is no longer two-way, so rewriting my own
    // copy of it would only make the two phones disagree the moment the block
    // is lifted.
    if (!maySendTo('edit', this.blockStateFor(peerUserId))) return;
    if (session.mode === 'duress') {
      await this.editRow(peerUserId, targetMsgId, 'out', text, Date.now());
      await this.refreshPreview(peerUserId);
      this.notify();
      return;
    }
    // In a room the ref is my own row's the design key `${selfId}.${m}` — the
    // receive side refuses any revision whose author prefix is not the
    // SENDER's own id (author laundering), so this envelope can only
    // ever rewrite the row I authored, on every phone, through the same
    // branch as a 1:1 edit.
    const envelope = encodeEnvelope({ tcm: 'edit', ref: targetMsgId, text });
    // A carrier: hidden from the thread by the envelope filter and forbidden
    // from moving the chat's timestamp. The preview is recomputed afterwards
    // instead, because editing the newest message DOES change what the chat
    // list should say — just not when it was said.
    const room = await db.getGroup(peerUserId);
    if (room) {
      await this.fanOut(peerUserId, envelope, {
        preview: null,
        onEnqueued: async (_msgId, ts) => {
          await this.editRow(peerUserId, targetMsgId, 'out', text, ts);
        },
      });
    } else {
      await this.encryptAndEnqueue(peerUserId, envelope, {
        preview: null,
        onEnqueued: async (_msgId, ts) => {
          await this.editRow(peerUserId, targetMsgId, 'out', text, ts);
        },
      });
    }
    await this.refreshPreview(peerUserId);
    this.notify();
  }

  /**
   * Retract a message I already sent, on both phones. Their copy is
   * tombstoned, not silently removed: a message that vanishes without trace
   * is indistinguishable from one that never arrived.
   */
  async sendDelete(peerUserId: string, targetMsgId: string): Promise<void> {
    // ABOVE the deleteOutboxEnvelope call: while blocked there is no carrier
    // and no tombstone, and db.blockPeer has already purged this peer's outbox
    // in the transaction that recorded the block, so there is nothing here to
    // retract. Silent for the same reason as sendEdit.
    if (!maySendTo('retraction', this.blockStateFor(peerUserId))) return;
    // Drop the original's queued ciphertext first, whatever the session: if it
    // never left this phone, retracting it must stop it leaving, not race a
    // reconnect that delivers words already taken back. Harmless once sent —
    // the outbox row is deleted on receipt anyway.
    await db.deleteOutboxEnvelope(targetMsgId).catch(() => undefined);
    this.inflight.delete(targetMsgId);
    if (session.mode === 'duress') {
      await db.tombstoneMessage(peerUserId, targetMsgId, 'out', Date.now());
      await this.refreshPreview(peerUserId);
      this.notify();
      return;
    }
    const envelope = encodeEnvelope({ tcm: 'del', ref: targetMsgId });
    const room = await db.getGroup(peerUserId);
    if (room) {
      // The deleteOutboxEnvelope above missed every queued leg: a group
      // message's legs carry their own random wire ids and point back
      // through `localMsgId` (the lesson db.deleteMessage records —
      // `msgId = ?` alone deletes nothing). Enumerate and drop them, so a
      // message retracted before it ever left cannot leave afterwards.
      // Best-effort like the 1:1 purge: once sent, the legs settle anyway.
      try {
        for (const legRow of await db.listOutbox()) {
          if (legRow.localMsgId !== targetMsgId) continue;
          await db.deleteOutboxEnvelope(legRow.msgId);
          this.inflight.delete(legRow.msgId);
        }
      } catch {
        // A failed purge only risks the original arriving before the
        // retraction — the tombstone still lands on every phone.
      }
      await this.fanOut(peerUserId, envelope, {
        preview: null,
        onEnqueued: async (_msgId, ts) => {
          await db.tombstoneMessage(peerUserId, targetMsgId, 'out', ts);
        },
      });
    } else {
      await this.encryptAndEnqueue(peerUserId, envelope, {
        preview: null,
        onEnqueued: async (_msgId, ts) => {
          await db.tombstoneMessage(peerUserId, targetMsgId, 'out', ts);
        },
      });
    }
    await this.refreshPreview(peerUserId);
    this.notify();
  }

  /**
   * Remove one message from THIS phone only. Nothing is said to anybody —
   * `sendDelete` is the retraction; this is the local erase.
   *
   * It lives here, rather than as a bare `db.deleteMessage` in the screen,
   * because deleting a message CHANGES THE CHAT'S LINE, and every other
   * line-changing path in this file notifies. The thread's own `refresh`
   * repaints the thread; under the wide shell the chat list is live BESIDE
   * the open thread and repaints on nothing but `notify()`, so a db-only
   * delete left the list row previewing the words the person had just
   * deleted — until an unrelated receipt or socket transition happened to
   * fire, or indefinitely while offline.
   *
   * No `refreshPreview`: the new line is recomputed inside deleteMessage's
   * own transaction (db.recomputeChatPreviewInTx), which is the single
   * source of it — recomputing again from out here could only race that.
   */
  async deleteForMe(msgId: string, direction: 'in' | 'out'): Promise<void> {
    await db.deleteMessage(msgId, direction);
    this.notify();
  }

  /** Answer a specific earlier message. Unlike edit/del this is ordinary
   * conversation — a row of its own, previewed by its own words. */
  async sendReply(
    peerUserId: string,
    targetMsgId: string,
    targetDirection: 'in' | 'out',
    text: string,
  ): Promise<void> {
    // Ordinary conversation, so it throws like sendText — the composer is the
    // caller and has somewhere to say so. Above the duress branch: no local
    // echo either.
    if (!maySendTo('message', this.blockStateFor(peerUserId))) {
      throw new BlockedPeerError('blocked');
    }
    const envelope = encodeEnvelope({
      tcm: 'reply',
      // In a room the ref is the quoted row's the design key — the same key on
      // every member's phone, so the quote resolves everywhere, and the
      // author prefix (authenticated, never a payload field) is what the
      // renderer's lookup lands on. `ofs` still travels: in a room it is
      // consistent by construction (the prefix decides direction), and a
      // forged bit can only miss the lookup, never re-voice a row.
      ref: targetMsgId,
      // From the peer's perspective my 'out' rows are the ones I authored.
      ofs: targetDirection === 'out',
      text,
    });
    if (session.mode === 'duress') {
      await this.localEcho(peerUserId, envelope, text);
      return;
    }
    const room = await db.getGroup(peerUserId);
    if (room) {
      await this.fanOut(peerUserId, envelope, { preview: text });
      return;
    }
    await this.encryptAndEnqueue(peerUserId, envelope, { preview: text });
    void this.shareProfileWith(peerUserId);
  }

  /**
   * Recompute a chat's preview after a row was rewritten or retracted. Only
   * the line changes — never lastMessageAt, or an edit to an old message
   * would jump the conversation to the top of the list.
   *
   * WITH the resolver (previewWithNames), because the latest row can be a
   * mention that the revision did not touch: an inbound edit of an OLDER row
   * recomputes this line from the mention, and a resolver-less recompute
   * rewrote "@Cara lunch? @you" to " lunch? " with zero action from this
   * phone's person (the mentions contract — the same rule as applyContent's
   * touchChat).
   *
   * ONE CHAIN ENTRY, read to write: the resolver awaits a getChat per
   * mentioned id, and with the read outside the chain a revision frame's
   * recompute could suspend there while a newer content frame landed, then
   * write LAST — old words at the new message's sort position. Inside the
   * chain the read and the write are atomic against the other line writer.
   * No token: a recompute reads current truth at its position in the chain,
   * so it is correct wherever it runs and must never suppress a later
   * captured write (or be suppressed by an earlier one).
   */
  private refreshPreview(peerUserId: string): Promise<void> {
    const gen = this.generation;
    return this.runChatLine(peerUserId, async () => {
      try {
        const recent = await db.listRecentMessages(peerUserId, PREVIEW_SCAN);
        const latest = recent.find(
          row => row.deletedAt || !isCarrierEnvelope(row.body),
        );
        const line = !latest
          ? ''
          : latest.deletedAt
            ? DELETED_PREVIEW
            : await this.previewWithNames(latest.body);
        if (this.stale(gen)) return;
        await db.setChatPreview(peerUserId, line);
      } catch {
        // A stale preview line is cosmetic; never fail a send over it.
      }
    });
  }

  /** previewFor, with names prefetched for a mention body. `who` ≤ 12 ids;
   * self renders as 'you' (the chat list is this phone's own surface). Names
   * resolve via personName (localName ∥ displayName ∥ id-fragment — but an
   * id-fragment echo is treated as "cannot name" by the renderer). */
  private async previewWithNames(body: string): Promise<string> {
    const who = mentionWho(body);
    if (who.length === 0) return previewFor(body);
    const names = new Map<string, string>();
    for (const id of new Set(who)) {
      if (id === this.selfUserId) { names.set(id, 'you'); continue; }
      const chat = await db.getChat(id).catch(() => undefined);
      if (chat) names.set(id, personName(id, chat.displayName, chat.localName));
    }
    return previewFor(body, id => names.get(id) ?? null);
  }

  /** Shared send core: session bootstrap, encrypt-at-compose, atomic enqueue. */
  /** The peerDevices dependency slice — the real database, the real native
   * verify. One construction site so the receive arms and the
   * send fork judge rosters with the same machine. */
  private peerDeviceDeps() {
    return {
      db: {
        getPeerDevice: db.getPeerDevice,
        listPeerDevices: db.listPeerDevices,
        upsertPeerDevice: db.upsertPeerDevice,
        peerBlockedAt: db.getBlockedAt,
        blockPeer: db.blockPeer,
      },
      crypto: { verifyLinkOp },
      now: Date.now,
    };
  }

  /** The device fan-out dependency slice: leg encryption rides
   * the ordinary session bootstrap, and every bundle fetched on the way is
   * also a roster signal. */
  private deviceFanDeps(): DeviceFanoutDeps {
    return {
      peers: this.peerDeviceDeps(),
      ownDevices: () => db.listLinkedDevices(),
      crypto: {
        encryptText: async (self, to, plain) => {
          if (!(await hasSession(to))) {
            const bundle = await apiGetPrekeyBundle(this.token!, to);
            await this.notePeerBundle(to, bundle);
            await processPreKeyBundle(bundle, self);
          }
          return encryptText(self, to, plain);
        },
      },
    };
  }

  /**
   * Record what a served bundle says about a peer's device set:
   * the owner's identity at the TOFU moment, then every asserted sibling —
   * each sibling's OWN key fetched (the session the fan-out needs anyway)
   * and its certificate chain verified locally. An unverifiable sibling
   * flags the ANCHOR's thread exactly like an identity change:
   * block-and-warn until the human accepts.
   */
  private async notePeerBundle(userId: string, bundle: PrekeyBundle): Promise<void> {
    // A bundle served for THIS device that says the pool is low is the one
    // in-band signal the client has about its own prekeys: answer it,
    // throttled to the hourly floor inside replenishPrekeys.
    if (bundle.userId === this.selfUserId && bundle.lowPrekeyCount) {
      void this.maybeReplenishPrekeys('low');
    }
    const pd = this.peerDeviceDeps();
    await recordPeerIdentity(userId, bundle.identityKey, pd);
    const siblings = bundle.siblings ?? [];
    if (siblings.length === 0 || !this.token) return;
    const served: ServedSibling[] = [];
    for (const sibling of siblings) {
      const known = await db.getPeerDevice(sibling.userId);
      if (known) {
        // A 'pending' row is RE-JUDGED with its stored TOFU key: a
        // certificate that has since become verifiable
        // — the pinned signer arrived by another road — upgrades the hold
        // to 'linked' through the same applyServedRoster machine. Any
        // other known state is old news; terminal states never resurrect.
        if (known.state !== 'pending') continue;
        served.push({
          userId: sibling.userId,
          class: sibling.class,
          certs: sibling.certs,
          identityKeyPub: known.identityKeyPub,
        });
        continue;
      }
      try {
        const sb = await apiGetPrekeyBundle(this.token, sibling.userId);
        served.push({
          userId: sibling.userId,
          class: sibling.class,
          certs: sibling.certs,
          identityKeyPub: sb.identityKey,
        });
      } catch {
        // Transient: the sibling stays unknown until the next signal —
        // never a silent trust, never a lost send.
      }
    }
    if (served.length === 0) return;
    const anchor = await anchorFor(userId, pd);
    await this.applyAndSurfaceRoster(anchor, served);
  }

  /**
   * Apply one resolved (keys-attached) served roster and surface what it
   * found: the unverified hold flags the anchor's thread exactly like an
   * identity change, and ANY finding — accepted included — re-syncs this
   * device's roster evidence to its own siblings (the sync 'roster'
   * kind: the one production signal an ESTABLISHED sibling session has for
   * a peer's new device, since only bootstrapping devices fetch bundles).
   */
  private async applyAndSurfaceRoster(
    anchor: string,
    served: ServedSibling[],
  ): Promise<void> {
    const pd = this.peerDeviceDeps();
    const findings = await applyServedRoster({ anchorId: anchor, siblings: served }, pd);
    let accepted = false;
    for (const finding of findings) {
      if (finding.outcome === 'unverified') {
        // The design: handled exactly like identityChanged — durable warning on
        // the anchor's chat, sends refused until the human accepts.
        this.identityChanged.add(anchor);
        await db.upsertChat(anchor);
        await db.setIdentityChanged(anchor, Date.now());
        this.notify();
      } else {
        accepted = true;
      }
    }
    if (accepted) this.notify();
    if (findings.length > 0) {
      await this.syncPeerRosterToSiblings(anchor).catch(() => undefined);
    }
  }

  /**
   * The forwarding hint, acted on: the dead
   * ULID's row flips revoked, and every SURVIVING member the hint names is
   * resolved (its own bundle fetched for the key the certificate must
   * bind) and TOFU-judged under the SAME anchor — so a peer holding only
   * the dead ULID re-targets instead of wedging on a dead end.
   */
  private async noteRevokedHint(
    deadId: string,
    hint: { siblings: GroupSibling[] },
  ): Promise<void> {
    if (!this.token) return;
    const dead = await db.getPeerDevice(deadId);
    const anchor = dead?.anchorId ?? deadId;
    if (dead && dead.state !== 'revoked') {
      await db.upsertPeerDevice({ ...dead, state: 'revoked', updatedAt: Date.now() });
    } else if (!dead) {
      await db.upsertPeerDevice({
        userId: deadId,
        anchorId: deadId,
        class: 'unknown',
        state: 'revoked',
        identityKeyPub: '',
        certsJson: '',
        updatedAt: Date.now(),
      });
    }
    const served: ServedSibling[] = [];
    for (const sibling of hint.siblings) {
      const known = await db.getPeerDevice(sibling.userId);
      if (known && known.state !== 'pending') continue;
      try {
        const key = known?.identityKeyPub
          ? known.identityKeyPub
          : (await apiGetPrekeyBundle(this.token, sibling.userId)).identityKey;
        served.push({
          userId: sibling.userId,
          class: sibling.class,
          certs: sibling.certs,
          identityKeyPub: key,
        });
      } catch {
        // Transient; the survivor stays unknown until the next signal.
      }
    }
    if (served.length > 0) {
      await this.applyAndSurfaceRoster(anchor, served);
    }
  }

  /**
   * The fan-out compose: every leg sealed in its own pairwise
   * session, one message row, one shared id — committed atomically with the
   * primary (anchor) envelope carrying the row's own msgId so receipts flow
   * exactly as a single-leg send's do; the extra device and sibling legs
   * ride their own wire ids.
   */
  private async enqueueDeviceFanout(
    peerUserId: string,
    plaintext: string,
    opts: {
      preview: string | null;
      onEnqueued?: (msgId: string, ts: number) => Promise<void>;
      onWire?: () => void;
      priority?: number;
      urgent?: boolean;
    },
    gen: number,
  ): Promise<string> {
    if (!this.selfUserId) throw new Error('messaging not started');
    const msgId = await nextMsgId();
    const ts = Date.now();
    // The timer is read BEFORE the legs are sealed: the sibling transcript
    // carries the same deadline the row gets, so the copy on the other
    // device disappears when this one does.
    const timer = (await db.getChat(peerUserId))?.disappearSec ?? 0;
    const expiresAt = timer > 0 ? ts + timer * 1000 : null;
    const legs = await buildDeviceLegs(
      { selfUserId: this.selfUserId, anchorId: peerUserId, body: plaintext, msgId, ts, expiresAt },
      this.deviceFanDeps(),
    );
    // PRIMARY PROMOTION: the anchor's leg where
    // it exists; otherwise the first surviving peer-device leg — a revoked
    // anchor with living siblings must not wedge the whole conversation
    // behind a dead ULID. Only a send with ZERO peer legs is unaddressable.
    const primary =
      legs.find(l => l.kind === 'peer' && l.to === peerUserId) ??
      legs.find(l => l.kind === 'peer');
    if (!primary) {
      // No addressable device at all: the named the design refusal surfaces as
      // itself.
      throw new Error('no account for this id');
    }
    for (const leg of legs) {
      if (leg.payload.length > MAX_PAYLOAD_B64_LENGTH) {
        throw new Error('message too large to send');
      }
    }
    if (this.stale(gen)) throw new Error('messaging not started');
    const extras = [];
    for (const leg of legs) {
      if (leg === primary) continue;
      extras.push({
        to: leg.to,
        // Rule 19, the fan-out discipline: extra legs ride pure-CSPRNG wire
        // ids — N monotonic ULIDs under one sender is a membership join key.
        msgId: await randomMsgId(randomBytes),
        msgType: leg.msgType,
        payload: leg.payload,
        // PEER extras join the leg ledger: a member device leg written off
        // must be a durable LEG_FAILED row, never a silent delete. Sibling
        // sync legs stay best-effort by design — they still get the row's
        // purge key (db.enqueueOutgoingDeviceFanout), so an expired or
        // retracted message takes its un-flushed transcripts with it.
        ledger: leg.kind === 'peer',
      });
    }
    await db.enqueueOutgoingDeviceFanout(
      {
        msgId,
        peerId: peerUserId,
        direction: 'out',
        body: plaintext,
        ts,
        status: 'pending',
        expiresAt,
      },
      {
        msgType: primary.msgType,
        payload: primary.payload,
        urgent: opts.urgent,
        notify: !isCarrierEnvelope(plaintext),
        to: primary.to,
      },
      extras,
      { priority: opts.priority },
    );
    opts.onWire?.();
    if (opts.preview !== null) {
      const line = opts.preview;
      await this.touchChatOrdered(peerUserId, ts, async () => line);
    }
    await opts.onEnqueued?.(msgId, ts);
    this.notify();
    await this.flushPending();
    return msgId;
  }

  /** Apply one sibling sync envelope with the real stores. */
  private async applySiblingSyncEnvelope(
    senderId: string,
    envelope: Extract<Envelope, { tcm: 'x.acct.sync' }>,
  ): Promise<'applied' | 'dropped'> {
    return applySiblingSync(senderId, envelope, {
      insertSentTranscript: async d => {
        await db.upsertChat(d.peerId);
        try {
          await db.insertMessage({
            msgId: d.msgId,
            peerId: d.peerId,
            direction: 'out',
            body: d.body,
            ts: d.ts,
            status: 'sent',
            // The sender's deadline, when the chat had a timer: the sweep
            // reaches this copy exactly as it reaches the original.
            expiresAt: d.expiresAt ?? null,
          });
        } catch {
          return false; // Redelivery: the row exists — idempotent.
        }
        await this.touchChatOrdered(d.peerId, d.ts, async () =>
          previewFor(d.body) || d.body,
        );
        return true;
      },
      markReadSynced: async d => {
        // Advance-only: the account read this thread up to d.ts on a
        // sibling; a stale replay must never resurrect an unread badge.
        const chat = await db.getChat(d.peerId).catch(() => null);
        if (chat && (chat.lastOpenedAt ?? 0) < d.ts) {
          await db.markChatOpened(d.peerId, d.ts);
        }
      },
      setLocalName: async d => {
        await db.upsertChat(d.peerId);
        await db.setLocalName(d.peerId, d.name === '' ? null : d.name);
      },
      peerDevices: this.peerDeviceDeps(),
      replaceSiblingMachinePeers: (deviceUserId, agentIds, syncTs) =>
        db.replaceSiblingMachinePeers(deviceUserId, agentIds, syncTs),
    });
  }

  /* ── sibling sync/notice PRODUCERS ──────────── */

  /** This account's OTHER linked devices, or [] when solo — the sibling
   * sync senders' recipient set. */
  private async ownSiblingIds(): Promise<string[]> {
    if (!this.selfUserId) return [];
    try {
      return (await db.listLinkedDevices())
        .filter(r => r.state === 'linked' && r.userId !== this.selfUserId)
        .map(r => r.userId)
        .sort();
    } catch {
      return [];
    }
  }

  /**
   * Seal + enqueue ONE bare typed carrier for one device ULID — no
   * messages row, no preview, no notify (`db.enqueueEnvelopeOnly`; the
   * extra-leg shape). `sibling: true` skips the peer-roster noting: an own
   * device is not a peer and must never land in `peer_devices`.
   */
  private async sendBareCarrier(
    to: string,
    plaintext: string,
    opts: { sibling: boolean },
  ): Promise<void> {
    if (!this.selfUserId || !this.token) return;
    // The block choke point, FIRST — before any prekey fetch or ratchet
    // advance (the encryptAndEnqueue discipline): a blocked id gets no
    // frame from this path either, and the roster-keyed auto-extension
    // means a peer's individual DEVICE ids can be blocked too.
    if (!maySendTo('message', this.blockStateFor(to))) return;
    if (!(await hasSession(to))) {
      const bundle = await apiGetPrekeyBundle(this.token, to);
      if (!opts.sibling) await this.notePeerBundle(to, bundle);
      await processPreKeyBundle(bundle, this.selfUserId);
    }
    const { msgType, payload } = await encryptText(this.selfUserId, to, plaintext);
    if (payload.length > MAX_PAYLOAD_B64_LENGTH) return;
    await db.enqueueEnvelopeOnly({
      to,
      msgId: await randomMsgId(randomBytes),
      msgType,
      payload,
    });
    await this.flushPending();
  }

  /** One typed sync envelope to every own sibling. Best-effort per leg —
   * own-device consistency reconverges on the next signal, and a sync must
   * never fail the user action that produced it. */
  private async sendSyncToSiblings(
    envelope: Extract<Envelope, { tcm: 'x.acct.sync' }>,
  ): Promise<void> {
    if (session.mode === 'duress') return;
    const siblings = await this.ownSiblingIds();
    if (siblings.length === 0) return;
    const body = encodeEnvelope(envelope);
    for (const to of siblings) {
      try {
        await this.sendBareCarrier(to, body, { sibling: true });
      } catch {
        // Best-effort; the next state change re-syncs.
      }
    }
  }

  /** Sibling sync 'read': this device read `peerId`'s thread — siblings
   * clear their badge. Screens call it beside `markChatOpened`. */
  async syncThreadRead(peerId: string): Promise<void> {
    try {
      await this.sendSyncToSiblings(buildReadSync({ peerId, msgIds: [], ts: Date.now() }));
    } catch {
      // Best-effort by contract.
    }
  }

  /** Sibling sync 'name': the per-contact local name chosen here. */
  async syncLocalName(peerId: string, name: string | null): Promise<void> {
    try {
      await this.sendSyncToSiblings(
        buildLocalNameSync({ peerId, name: name ?? '', ts: Date.now() }),
      );
    } catch {
      // Best-effort by contract.
    }
  }

  /** Sibling sync 'machines': this device's machine roster, whole (what lets a surviving sibling name a revoked device's agents). Bounded
   * to the schema's 8; the crew caps live machines at 8 by design. */
  async syncMachinePeers(): Promise<void> {
    try {
      const agentIds = (await db.listMachinePeers()).slice(0, 8);
      await this.sendSyncToSiblings(buildMachinePeersSync({ agentIds, ts: Date.now() }));
    } catch {
      // Best-effort by contract.
    }
  }

  /** Sibling sync 'roster': a peer's device set as THIS device verified it,
   * synced as EVIDENCE (certs + keys — the receiver re-verifies). The one
   * production signal an established sibling session has for a peer's new
   * device. */
  private async syncPeerRosterToSiblings(anchorId: string): Promise<void> {
    const rows = await db.listPeerDevices(anchorId);
    const devices = [];
    for (const row of rows) {
      if (row.userId === anchorId) continue;
      if (row.state !== 'linked' && row.state !== 'pending') continue;
      if (row.class === 'unknown' || row.certsJson === '' || row.identityKeyPub === '') {
        continue;
      }
      try {
        devices.push({
          userId: row.userId,
          class: row.class,
          // certsJson !== '' is guaranteed above, so the parse yields a real
          // certificate — the sync device shape requires it non-optional.
          certs: JSON.parse(row.certsJson) as NonNullable<GroupSibling['certs']>,
          identityKeyPub: row.identityKeyPub,
        });
      } catch {
        continue; // an unparseable stored cert is not evidence
      }
    }
    if (devices.length === 0) return;
    await this.sendSyncToSiblings(
      buildPeerRosterSync({ anchorId, devices: devices.slice(0, 8) }),
    );
  }

  /**
   * THE SIGNED PEER-FACING NOTICE PRODUCER (the design's
   * "signed unlink/revoke notices fan out in-band", the peer-visible
   * half): the committed mutation's exact signed tuple rides an
   * `x.acct.notice` to every device of every 1:1 contact, inside each
   * pairwise ratchet. Best-effort per peer — blocked peers get nothing by
   * the standing rule, rooms are not contacts, and a peer this device
   * never chatted with learns from the bundle/`recipient_revoked` signals.
   */
  private async fanPeerRosterNotice(notice: PeerRosterNotice): Promise<void> {
    if (session.mode === 'duress' || !this.selfUserId || !this.token) return;
    const body = encodeEnvelope({
      tcm: 'x.acct.notice',
      op: notice.op,
      groupId: notice.tuple.groupId,
      offererUserId: notice.tuple.offererUserId,
      acceptorUserId: notice.tuple.acceptorUserId,
      subjectIdentityPubKey: notice.tuple.subjectIdentityPubKey,
      class: notice.tuple.class,
      rosterEpoch: notice.tuple.rosterEpoch,
      offerNonce: notice.tuple.offerNonce,
      expiresAt: notice.tuple.expiresAt,
      sig: notice.signature,
    });
    let chats: db.ChatRow[] = [];
    try {
      chats = await db.listChats();
    } catch {
      return;
    }
    const pd = this.peerDeviceDeps();
    for (const chat of chats) {
      const peerId = chat.peerId;
      if (!maySendTo('message', this.blockStateFor(peerId))) continue;
      // Rooms are not contacts; the definite-answer rule (sendReadReceipt).
      const group = await db.getGroup(peerId).catch(() => undefined);
      if (group !== null) continue;
      const devices = await fanoutDeviceSet(peerId, pd).catch(() => [peerId]);
      for (const to of devices) {
        try {
          await this.sendBareCarrier(to, body, { sibling: false });
        } catch {
          // Per-device best-effort, like the server's own notice stance.
        }
      }
    }
  }

  private async encryptAndEnqueue(
    peerUserId: string,
    plaintext: string,
    opts: {
      preview: string | null;
      /** Runs after the message+envelope commit and before the first flush —
       * for side-effect rows that must exist by the time the wire can move. */
      onEnqueued?: (msgId: string, ts: number) => Promise<void>;
      /**
       * THE POINT OF NO RETURN, announced synchronously the instant
       * `enqueueOutgoing` commits and BEFORE anything that could throw runs.
       *
       * A caller that allocated something on the assumption the send might not
       * happen — the vault reserves its counter before composing, because the
       * frame has to carry it — needs to know which side of that commit a throw
       * came from. Everything below the commit (touchChat, onEnqueued, notify,
       * flushPending) can throw over a row that is already durable and will
       * still flush, and undoing the allocation there is what makes two phones
       * disagree. Deliberately sync and deliberately not awaited: it must not
       * be able to fail, and it must not be able to reorder.
       */
      onWire?: () => void;
      /** Flush order: 1 = call signalling, ahead of ordinary traffic. */
      priority?: number;
      /** May wake a sleeping peer. Persisted now; rides the wire in V2. */
      urgent?: boolean;
    },
  ): Promise<string> {
    // THE CHOKE POINT. First statement, before any await and before the
    // identity-change check: blocked outranks identity-changed everywhere, so
    // a blocked peer can never produce the "safety number changed" error
    // string or the 'changed' safety state. Refusing here means no prekey
    // fetch, no processPreKeyBundle and no encryptText — the ratchet does not
    // advance and none of their one-time prekeys are consumed — and therefore
    // no messages row, no outbox row, no touchChat and no onEnqueued.
    if (!maySendTo('message', this.blockStateFor(peerUserId))) {
      throw new BlockedPeerError('blocked');
    }
    if (!this.selfUserId || !this.token)
      throw new Error('messaging not started');
    const gen = this.generation;
    if (this.identityChanged.has(peerUserId)) {
      throw new Error(
        'safety number changed — verify and accept it before sending',
      );
    }

    let msgType: string;
    let payload: string;
    try {
      if (!(await hasSession(peerUserId))) {
        const bundle = await apiGetPrekeyBundle(this.token, peerUserId);
        // The bundle fetch that establishes the session is also
        // the roster signal — the peer's device set is recorded and
        // TOFU-judged before any leg shape is chosen. An unverifiable
        // sibling flags the thread exactly like a key change, refused just
        // below.
        await this.notePeerBundle(peerUserId, bundle);
        await processPreKeyBundle(bundle, this.selfUserId);
        if (this.identityChanged.has(peerUserId)) {
          throw new Error(
            'safety number changed — verify and accept it before sending',
          );
        }
      }
      // The device fan-out fork — a grouped peer, or a sender
      // with linked siblings, leaves the single-leg path entirely: one
      // sealed envelope per (sender-device → recipient-device) pair plus
      // sibling transcript legs, one shared message id. An ungrouped peer
      // with no siblings never reaches the fork's compose — its wire stays
      // byte-identical to the pre-accounts path.
      const fanTargets = await deviceFanoutTargets(
        this.selfUserId,
        peerUserId,
        this.deviceFanDeps(),
      );
      if (fanTargets.peerDevices.length > 1 || fanTargets.siblings.length > 0) {
        return await this.enqueueDeviceFanout(peerUserId, plaintext, opts, gen);
      }
      // Encrypt at compose time; the ratchet advances in send order, and the
      // outbox flushes in the same (ULID) order.
      ({ msgType, payload } = await encryptText(
        this.selfUserId,
        peerUserId,
        plaintext,
      ));
    } catch (err) {
      // Structural, not instanceof: test doubles mock the api module whole,
      // and the code is the wire contract either way.
      const revoked = err as { code?: string; hint?: { siblings: GroupSibling[] } | null } | null;
      if (revoked?.code === 'recipient_revoked') {
        // The forwarding hint: the anchor is
        // DEAD server-side, and the refusal named its surviving roster.
        // Record the tombstone, verify + admit the survivors under the same
        // anchor, and retry the fan-out ONCE — the promoted primary carries
        // the send. No survivors verifiable = the honest dead end.
        if (revoked.hint) {
          await this.noteRevokedHint(peerUserId, revoked.hint).catch(() => undefined);
          const retryTargets = await deviceFanoutTargets(
            this.selfUserId,
            peerUserId,
            this.deviceFanDeps(),
          );
          if (retryTargets.peerDevices.length > 0) {
            return await this.enqueueDeviceFanout(peerUserId, plaintext, opts, gen);
          }
        }
        throw new Error('no account for this id');
      }
      if (isNotFound(err)) {
        // A well-formed but mistyped id: nobody is at that address. Reported as
        // itself, so the UI stops blaming a connection that is working and
        // leaving a phantom conversation behind.
        throw new Error('no account for this id');
      }
      if (isIdentityChangeError(err)) {
        // Block-and-warn: the peer's key changed. Surface it to the UI, and
        // record it on the chat row so the loudest warning in the product
        // survives a relaunch instead of living only in this Set.
        this.identityChanged.add(peerUserId);
        void db
          .setIdentityChanged(peerUserId, Date.now())
          .catch(() => undefined);
        this.notify();
        throw new Error(
          'safety number changed — verify and accept it before sending',
        );
      }
      if (isServerAhead(err)) {
        // The bundle no longer parses on this build: not a
        // connection problem, not this contact, not fixable by retrying —
        // fixable by updating. Nothing was enqueued and the ratchet did not
        // advance, so the words are still the person's to send again once
        // they have; the flag is the state the thread can show meanwhile,
        // and the error keeps its own name and its "update Tacendum" text
        // for the composer's classifier.
        if (!this.serverAhead) {
          this.serverAhead = true;
          this.notify();
        }
        throw err;
      }
      throw err;
    }
    if (this.serverAhead) {
      // A bundle parsed again: whatever was ahead of this build no longer is
      // (an update, or a server rollback). Cleared on evidence, not on time.
      this.serverAhead = false;
      this.notify();
    }
    if (payload.length > MAX_PAYLOAD_B64_LENGTH) {
      // Reject before enqueue: the server would reject an oversized frame and
      // the poison envelope would sit in the outbox. The ratchet already
      // advanced, so this msgId is burned; surface a clear error to the caller.
      throw new Error('message too large to send');
    }
    if (this.stale(gen)) {
      // A relock crossed the compose — never enqueue into the next workspace.
      throw new Error('messaging not started');
    }
    const msgId = await nextMsgId();
    const ts = Date.now();
    // My own messages start their clock at SEND, not when I next open the
    // thread — otherwise something I sent and never looked at again would sit
    // here forever while the recipient's copy expired on time.
    const timer = (await db.getChat(peerUserId))?.disappearSec ?? 0;

    // Message row + wire envelope committed together, so a crash can never
    // leave a 'pending' message with no envelope to flush.
    await db.enqueueOutgoing(
      {
        msgId,
        peerId: peerUserId,
        direction: 'out',
        body: plaintext,
        ts,
        status: 'pending',
        expiresAt: timer > 0 ? ts + timer * 1000 : null,
      },
      {
        msgType,
        payload,
        priority: opts.priority ?? 0,
        urgent: opts.urgent,
        // DERIVED HERE, not passed in by callers. Every carrier goes through
        // this one function, and a flag each of six call sites had to remember
        // is a flag one of them eventually forgets — which is exactly how the
        // push registration shipped without its `bundleId`. `isCarrierEnvelope`
        // already IS the definition of "rewrites an existing row rather than
        // becoming a message", so the notification rule reads straight off it
        // and cannot drift from it.
        notify: !isCarrierEnvelope(plaintext),
      },
    );
    // First thing after the commit and before anything that can throw: from
    // here on the frame WILL be sent, so no caller may undo what it allocated
    // for it. See the `onWire` doc above.
    opts.onWire?.();
    if (opts.preview !== null) {
      const line = opts.preview;
      await this.touchChatOrdered(peerUserId, ts, async () => line);
    }
    await opts.onEnqueued?.(msgId, ts);

    this.notify();
    await this.flushPending();
    return msgId;
  }

  /** Flush pending outgoing envelopes in ULID order while the socket is open. */
  private async flushPending(): Promise<void> {
    if (!this.ws.isOpen) return;
    if (this.flushing) {
      // A pass is already between awaits; its snapshot cannot contain the
      // row this caller just committed. Latch a re-run rather than dropping
      // the request — see `flushQueued`.
      this.flushQueued = true;
      return;
    }
    this.flushing = true;
    try {
      do {
        this.flushQueued = false;
        const gen = this.generation;
        const pending = await db.listOutbox();
        let errored = false;
        for (const item of pending) {
          if (this.stale(gen)) return;
          // A fan-out leg routes its failures through the leg LEDGER rather
          // than through markOutgoingError: the leg's wire msgId matches no
          // messages row, and the settled row it leaves behind is what makes
          // "Not delivered to N of M" honest. `ledger` (db.ts): a sibling
          // transcript row carries the message's purge key too but is NOT a
          // delivery leg — it fails like a 1:1 envelope, never into "Not
          // delivered to N of M".
          const isLeg = item.localMsgId != null && item.ledger !== 0;
          // Second line of defence behind db.blockPeer's transactional purge —
          // this catches an envelope enqueued in the same tick as the block.
          // DROPPED, not parked: a parked queue means unblocking delivers a
          // burst of stale messages, which is a tell of its own and a delivery
          // the person had already decided against.
          if (!maySendTo('queuedEnvelope', this.blockStateFor(item.peerId))) {
            if (isLeg) {
              await db.markLegFailed(item.msgId);
            } else {
              await db.markOutgoingError(item.msgId);
              await db.deleteOutboxEnvelope(item.msgId);
            }
            this.inflight.delete(item.msgId);
            // A settle HERE must repaint like every other settle: without
            // this, the pass-end notify was skipped and
            // the thread's delivery notice waited on an unrelated event to
            // learn the leg was written off.
            errored = true;
            continue;
          }
          // Per-row exponential backoff over the shared 15 s tick: a row still
          // inside its own window just skips this pass. Its `inflight` entry
          // stays put on purpose — the entry IS the delay clock, and a non-empty
          // map is what keeps scheduleRetry re-arming.
          const sentAt = this.inflight.get(item.msgId);
          if (
            sentAt !== undefined &&
            Date.now() - sentAt < retryDelayMs(item.attempts)
          ) {
            continue;
          }
          if (item.attempts >= MAX_SEND_ATTEMPTS) {
            // Never receipted after many attempts — treat as undeliverable.
            if (isLeg) {
              await db.markLegFailed(item.msgId);
            } else {
              await db.markOutgoingError(item.msgId);
              await db.deleteOutboxEnvelope(item.msgId);
            }
            this.inflight.delete(item.msgId);
            errored = true;
            continue;
          }
          if (isLeg) {
            // THE PACING GATE (mandatory): one token per leg, from the
            // bucket sized strictly below the server's wsSend — the client
            // never trips the server rather than recovering from it. Sitting
            // BEFORE ws.send and before the attempt bump is what makes it
            // The admission control too: a fan-out the remaining budget
            // cannot fit stays QUEUED at zero attempts — its bubble says
            // "Sending…" — instead of starting, accumulating attempts, and
            // erroring fifteen minutes later. Refusal stops the whole pass
            // (`break`, not `continue`): outbox.seq order is the flush-order
            // contract, and legs to one member across two fan-outs must not
            // leapfrog. Call signalling is untouched — priority 1 sorts
            // before every leg, so it has already been sent by this line.
            const pacer = this.fanoutPacer;
            if (!pacer) return; // stopped under us; stale-guarded anyway
            const now = Date.now();
            if (!pacer.tryTake(now)) {
              await this.scheduleFanoutResume(pacer.msUntilAvailable(now));
              break;
            }
          }
          const ok = this.ws.send({
            type: 'send',
            to: item.peerId,
            msgId: item.msgId,
            msgType: item.msgType,
            payload: item.payload,
            // BOTH BITS, and `urgent` had never been sent at all.
            //
            // It was written to the outbox in V1 with "read by the transport
            // in V2", and V2 never added it here — so the server saw
            // `urgent === undefined` on every frame this app has ever sent,
            // including call offers. That was invisible while the push
            // schedulers were dropping `kind` (everything took the VoIP branch
            // by accident, so calls happened to ring). With the schedulers
            // fixed, a call offer without this bit would be classified as an
            // ordinary message and banner instead of ring.
            //
            // Omitted rather than sent false, in both cases: the schema makes
            // them optional and absence is the safe default for each — no ring
            // and do notify.
            ...(item.urgent ? { urgent: true } : {}),
            ...(item.notify === 0 ? { notify: false } : {}),
          });
          if (!ok) break; // socket dropped; retry on next open
          this.inflight.set(item.msgId, Date.now());
          // The attempt is recorded only on a socket that has produced a
          // frame: a send into a socket the far end may not even be on is
          // not evidence the message is undeliverable, and counting it is
          // how a dead link marked good messages failed. The inflight clock
          // above still runs, so the row is retried on the ordinary schedule
          // — it just does not walk toward MAX_SEND_ATTEMPTS.
          if (this.socketLive) await db.bumpOutboxAttempt(item.msgId);
        }
        // Exhaustion almost always fires from the silent retry-timer path,
        // where nothing else repaints the thread — without this notify, the
        // failed row would only surface after some unrelated event. Guarded
        // like every other post-await effect: a relock mid-flush must not
        // notify a screen that is now rendering the other workspace.
        if (errored && !this.stale(gen)) this.notify();
      } while (this.flushQueued && this.ws.isOpen);
    } finally {
      this.flushing = false;
    }
    this.scheduleRetry();
  }

  /** While the socket stays open, keep re-checking the outbox so a message
   * whose send frame or receipt was dropped is retried after the timeout —
   * `flushPending` alone only fires on a new send or reconnect. Self-clears
   * once the outbox drains (nothing left in flight). */
  private scheduleRetry(): void {
    if (this.retryTimer || this.inflight.size === 0 || !this.ws.isOpen) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.flushPending();
    }, RECEIPT_TIMEOUT_MS);
  }

  /**
   * Re-run the flush once the pacing bucket can admit the next leg, plus
   * jitter: the deterministic refill interval alone
   * would space the legs EXACTLY, which is its own signature; the random
   * addition breaks the metronome. One timer at most — a second refusal while
   * one is armed rides the armed one.
   */
  private async scheduleFanoutResume(waitMs: number): Promise<void> {
    if (this.fanoutResumeTimer) return;
    const jitter = await this.legJitterMs();
    if (this.fanoutResumeTimer) return; // armed while we awaited the bytes
    this.fanoutResumeTimer = setTimeout(() => {
      this.fanoutResumeTimer = null;
      void this.flushPending();
    }, waitMs + jitter);
  }

  /** U(0, LEG_JITTER_MAX_MS) off the platform CSPRNG — never Math.random
   * (jitter is a privacy mitigation, and a mitigation fed by
   * a predictable source is theatre). The 2^16 % 351 modulo bias is ~0.2% on
   * a delay, which distorts no property the jitter defends. A failed draw
   * falls back to the FULL jitter rather than zero: the failure mode must not
   * be "every leg exactly on the refill tick". */
  private async legJitterMs(): Promise<number> {
    try {
      const bytes = await randomBytes(2);
      return ((bytes[0] << 8) | bytes[1]) % (LEG_JITTER_MAX_MS + 1);
    } catch {
      return LEG_JITTER_MAX_MS;
    }
  }

  /**
   * Import what the notification extension decrypted, one entry at a time.
   *
   * Each is committed and only THEN removed from the spool, so a crash
   * mid-import loses nothing. These are the one class of message that cannot
   * be re-fetched: the extension consumed their ratchet keys, so the copy the
   * server still holds can never be decrypted again by anyone.
   *
   * `markSeen` is what makes the redelivery harmless — `handleIncoming` checks
   * it before decrypting and simply acks — so it is written in the same step
   * as the message row rather than left to the socket.
   *
   * Never throws. This runs on the launch path, and a spool the app cannot
   * read must not stop it opening.
   */
  private async drainInbox(): Promise<void> {
    let entries: InboxEntry[] = [];
    try {
      entries = await readInbox();
    } catch {
      return;
    }
    // The witness is armed for the whole drain and disarmed after it (see
    // the field): a handler that finishes writes the id here through
    // `noteSeen`, and that write — not a read of `seen` — is the proof.
    const witness = new Set<string>();
    this.drainWitness = witness;
    try {
    for (const entry of entries) {
      try {
        // Straight through the ordinary inbound path, with the plaintext
        // supplied. `payload` is empty because nothing will look at it: the
        // decrypt is the one step being skipped.
        await this.handleIncoming(
          {
            type: 'msg',
            from: entry.from,
            msgId: entry.msgId,
            msgType: 'ciphertext',
            payload: '',
            ts: entry.ts,
          } as MsgFrame,
          entry.body,
        );

        // CLEARED ONLY ON PROOF, never on "the call returned".
        //
        // `handleIncoming` resolves WITHOUT persisting anything on two paths:
        // no `selfUserId`, and a generation that went stale mid-flight. The
        // second is reachable exactly here — a relock while the drain is
        // running calls `messaging.stop()`, the handler returns early, and
        // treating that as success would delete the only copy of a plaintext
        // whose ciphertext is already spent. There is no second chance for
        // these; the server's copy cannot be decrypted again by anyone.
        //
        // Every branch that genuinely finishes marks the id seen through
        // `noteSeen` — the message branch, the carrier branches, the blocked
        // drop — and a frame whose `seen` row is ALREADY there was imported
        // on an earlier launch, which the short-circuit witnesses too. The
        // early returns do not. So the WITNESS of that write is the proof,
        // and its absence means try again next launch.
        //
        // The witness, not a read of the `seen` table: `markSeen` prunes the
        // table on every call, and a prune can never be trusted to spare the
        // row the handler just wrote — the id-ordered version evicted exactly
        // that row for every 1:1 message once 5000 CSPRNG wire ids existed,
        // so the spool was re-imported on every launch (chat lines regressed,
        // ready photos flipped back to 'pending' and re-downloaded).
        if (witness.has(entry.msgId)) {
          await clearInboxEntry(entry.msgId);
        }
      } catch {
        // Leave it in the spool and try again next launch. A message that
        // cannot be imported is not a message that should be discarded.
      }
    }
    } finally {
      if (this.drainWitness === witness) this.drainWitness = null;
    }
  }

  /**
   * A relayed typing frame. Ephemeral on this side too:
   * no hasSeen (there is no msgId), no ack, no row, no preview — decrypt,
   * gate, emit to whoever is listening, forget.
   */
  private async handleTypingFrame(frame: TypingMsgFrame): Promise<void> {
    if (!this.selfUserId) return;
    const gen = this.generation;
    let text: string;
    try {
      text = await decryptEnvelope(
        this.selfUserId,
        frame.from,
        frame.msgType,
        frame.payload,
      );
    } catch {
      return; // Tamper/corruption — never render (decryptEnvelope's contract).
    }
    if (this.stale(gen)) return;
    // Decrypt-then-drop, blocking.ts decision 2: the ratchet must advance
    // even for a blocked sender or the session desyncs. The SIGNAL dies here.
    if (!mayPersistInbound(this.blockStateFor(frame.from))) return;
    if (session.mode === 'duress') return;
    const envelope = parseEnvelope(text);
    if (envelope === null) return;
    if (envelope.tcm === 'x.typing') {
      this.emitTyping(frame.from, envelope, frame.ts);
      return;
    }
    // x.edit — a stream-edit intermediate, the second
    // occupant of the relay-only typing lane. Same silences on every other
    // path: a malformed or future-shaped payload parsed to null above and
    // was dropped without a trace, and blocked/duress died before the parse
    // (after the decrypt — the ratchet had to advance either way).
    if (envelope.tcm === 'x.edit') {
      await this.applyStreamEdit(frame.from, envelope, gen);
      return;
    }
    // Any other kind inside a typing frame is noise: dropped, like the
    // x.typing-only version of this function always did.
  }

  /**
   * A server-minted accounts notice off the durable queue: a pending link offer to this device, or a link/unlink/revoke
   * roster event. Plaintext by construction — server-visible facts, never
   * message content — so there is no decrypt here; the linking module
   * validates, persists, and notifies its screens. Acked ONCE HANDLED,
   * stored or dropped alike: the offer's durable row is written before this
   * ack (crash-safe), and a malformed notice redelivered forever would be a
   * poison row. Only a thrown handler leaves the row un-acked for the next
   * drain.
   */
  private async handleAccountsFrame(frame: AccountsNoticeFrame): Promise<void> {
    const gen = this.generation;
    // Duress FIRST, above any state mutation (the sendText discipline):
    // the decoy workspace must never write link state — the
    // three link tables are in DB_TABLES precisely because this map must
    // not survive into the decoy — and the un-acked row waits for the real
    // session. Unreachable today (start() refuses in duress) but wired the
    // way every other frame handler is, not the other way round.
    if (session.mode === 'duress') return;
    try {
      await handleAccountsNoticeFrame(frame);
    } catch {
      return; // Transient (db closed mid-relock, network) — await redelivery.
    }
    if (this.stale(gen)) return;
    // Re-read past the awaits (the assertion defeats TS's stale narrowing
    // from the early return above): a relock-to-duress mid-handle must not
    // ack either.
    if ((session as { mode: 'real' | 'duress' }).mode === 'duress') return;
    this.ws.send({ type: 'ack', msgId: frame.msgId });
  }

  /**
   * Apply one sealed `x.edit` intermediate to the memory overlay.
   *
   * THE APPLY PREDICATE: a messages row with (msgId = ref, direction 'in',
   * peerId = THE FRAME'S SENDER) must already exist. The ratchet session IS
   * the sender authorization — the same argument the shipped durable edit
   * makes: db.applyEdit scopes its UPDATE by peerId so a quoted msgId can
   * never reach into another conversation, and `direction 'in'` pins the
   * target to a message the sender authored. The overlay store never sees
   * the database, so that WHERE clause is applied HERE, before memory
   * changes: a stranger's x.edit ref'ing another peer's bubble reads a row
   * whose peerId is not theirs and dies. A room row fails the same check by
   * construction (its peerId is the room id, never a sender), which is what
   * keeps v1 1:1-only without a second flag.
   *
   * MEMORY ONLY. No row, no preview, no unread, no badge, no ack, no
   * notify() — the durable inbound funnel is untouched, and tests pin the
   * absence. The store's own guards (seq strictly increasing, closed keys
   * terminal) arbitrate everything after this predicate.
   */
  private async applyStreamEdit(
    from: string,
    envelope: StreamEditEnvelope,
    gen: number,
  ): Promise<void> {
    let row: Awaited<ReturnType<typeof db.getMessage>> = null;
    try {
      row = await db.getMessage(envelope.ref, 'in');
    } catch {
      return; // A store mid-relock reads as "no anchor": the overlay is optional.
    }
    // A relock crossed the read: the next workspace must not inherit a
    // repaint aimed at this one (the quiesce rules applied to memory —
    // stop() clears the store, and this guard covers the continuation that
    // was already suspended when it did).
    if (this.stale(gen)) return;
    // No anchor, wrong conversation, or a retracted row — a tombstone is
    // never repainted, the durable rule mirrored. All three are silent:
    // the frame is ephemeral, and the durable final edit heals whatever
    // the overlay missed.
    if (!row || row.peerId !== from || row.deletedAt) return;
    streamEdits.apply(from, envelope.ref, envelope.seq, envelope.text);
  }

  /**
   * @param preDecrypted Plaintext the NOTIFICATION EXTENSION already produced.
   *
   * When present, the decrypt below is skipped — and skipping it is the whole
   * point: the extension consumed the ratchet's message key, so attempting it
   * again would throw `DuplicatedMessage`, land in the catch, and write a
   * visible error row into the conversation for a message that arrived
   * perfectly well.
   *
   * Everything after the decrypt is deliberately shared. The block drop, the
   * call branch, the profile branch, edits, deletions, reactions, the `seen`
   * write and the ack are identical whichever process turned the ciphertext
   * into text, and a second copy of that logic is a second place for the two
   * to disagree about what a message means.
   */
  /**
   * The socket's door for `msg` frames: claim the dispatch token NOW (arrival
   * order is what the token records — see handleIncoming), then run the
   * handler behind whatever this sender already has in flight. See
   * `senderChains` for why the order is per sender.
   */
  private dispatchIncoming(frame: MsgFrame): Promise<void> {
    const token = this.claimDispatchToken();
    const prev = this.senderChains.get(frame.from);
    // An idle sender starts NOW — synchronously up to the handler's first
    // await, exactly the timing the door has always had; only a sender with
    // handling in flight queues behind it. handleIncoming never throws (its
    // own catch discipline); the catch is so a link that somehow did could
    // never wedge the sender's chain.
    const link = (
      prev
        ? prev.then(() => this.handleIncoming(frame, undefined, undefined, token))
        : this.handleIncoming(frame, undefined, undefined, token)
    ).catch(() => undefined);
    this.senderChains.set(frame.from, link);
    void link.then(() => {
      if (this.senderChains.get(frame.from) === link) {
        this.senderChains.delete(frame.from);
      }
    });
    return link;
  }

  private async handleIncoming(
    frame: MsgFrame,
    preDecrypted?: string,
    busyRetriesLeft = 3,
    reusedToken?: number,
  ): Promise<void> {
    if (!this.selfUserId) return;
    const gen = this.generation;
    // The dispatch token — claimed ONCE PER EVENT, synchronously, before
    // decrypt, before the first await: this is the one instant that still
    // knows the order frames entered the process. A frame that suspends in
    // decrypt while a later one sails past must lose the chat line to it,
    // and only a token claimed here can say so (the frame's chat identity
    // is not known until after decrypt, so no per-chat queue can). Every
    // RE-ENTRY of the same event — the store-busy retry, a parked duplicate
    // resumed by the finally below, the spool rescue — passes the token it
    // was first given and REUSES it here: re-processing is the same event
    // continuing, not a new event entering, and a re-minted token let a
    // delayed old frame outrank every frame that legitimately overtook it
    // while it waited.
    const token = reusedToken ?? this.claimDispatchToken();

    // TWO copies of the same frame can arrive CONCURRENTLY — the server's
    // failed-post handover posting to the fresh socket while that socket's
    // own $connect drain redelivers the queued row. Both pass `hasSeen`
    // (neither has finished), both decrypt; one consumes the ratchet key and
    // the other throws DuplicatedMessage — and if the ERROR row's insert
    // lands first, the real plaintext's INSERT OR IGNORE is the one ignored.
    // Permanent loss, of a message that decrypted fine. Collapse them at the
    // door, synchronously, before the first await — but COALESCE, not
    // discard: if the in-flight copy dies unacked (a db read rejecting
    // outside the inner try, say), a discarded duplicate was the redelivery
    // the one-shot drain will never repeat. The noted copy re-enters once
    // the first settles; when the first succeeded, the re-entry finds the
    // msgId seen and simply acks.
    if (this.inflightMsgIds.has(frame.msgId)) {
      // Prefer the copy that carries PLAINTEXT: a drain pass racing a
      // ciphertext redelivery for the same msgId may hold the only
      // decrypted body in existence, and parking the bare frame over it
      // would discard exactly the thing worth replaying.
      const already = this.parkedDuplicates.get(frame.msgId);
      if (already?.preDecrypted === undefined) {
        this.parkedDuplicates.set(frame.msgId, { frame, preDecrypted });
      }
      return;
    }
    this.inflightMsgIds.set(frame.msgId, gen);
    try {
      await this.handleIncomingInner(
        frame,
        preDecrypted,
        busyRetriesLeft,
        gen,
        token,
      );
    } catch {
      // Only the inner function's PRE-TRY section can throw (a db read
      // rejecting before the main handling begins) — everything after has
      // its own catch discipline. The frame stays unacked; the parked
      // duplicate below, or the next reconnect's redelivery, is the retry.
      // Letting it propagate would be an unhandled rejection: the frame
      // handler fires this void.
    } finally {
      // Only OUR claim: after a relock, a newer generation may hold this
      // msgId legitimately, and deleting its entry would re-open the door
      // to the concurrent-duplicate race for that workspace.
      if (this.inflightMsgIds.get(frame.msgId) === gen) {
        this.inflightMsgIds.delete(frame.msgId);
        const parked = this.parkedDuplicates.get(frame.msgId);
        this.parkedDuplicates.delete(frame.msgId);
        if (parked && !this.stale(gen)) {
          // The SAME token, deliberately: when this copy died unacked
          // without writing the line, the parked copy is this event
          // CONTINUING, and a fresh token would let it outrank frames that
          // legitimately overtook the wait. When this copy DID apply,
          // hasSeen short-circuits the re-entry before any line write, so
          // the token is never consumed and reuse is harmless.
          void this.handleIncoming(
            parked.frame,
            parked.preDecrypted,
            undefined,
            token,
          );
        }
      }
    }
  }

  private async handleIncomingInner(
    frame: MsgFrame,
    preDecrypted: string | undefined,
    busyRetriesLeft: number,
    gen: number,
    /** Dispatch token claimed at frame entry — see handleIncoming. */
    token: number,
  ): Promise<void> {
    // Re-narrowed here (the outer guard cannot carry across the split); a
    // stop() between the two is caught by the generation check regardless.
    if (!this.selfUserId) return;
    const alreadySeen = await db.hasSeen(frame.msgId);
    if (alreadySeen || this.stale(gen)) {
      // Redelivery of an already-processed message: ack again, re-process
      // nothing — no decrypt, no ratchet advance, no row, no re-mark. But
      // for the ring, SAY SO: the seen msgId proves this delivery can never
      // produce call signalling (the ratchet key is spent, and no envelope
      // will be emitted for it), and a VoIP push whose drain carries only an
      // already-seen frame — trivially arranged, `urgent` is a client-set
      // bit and the server redelivers by msgId — used to get nothing here,
      // leaving its placeholder to the native 75-second watchdog. Terminal
      // is terminal whether it was decided this pass or a previous one; the
      // same-shape precedents are the blocked drop and the malformed
      // call.g* frame below, both 'not_call' because nothing about THIS
      // frame can ring from here. When the first delivery genuinely was the
      // offer a ring is waiting on, the controller already owns that ring's
      // fate (the envelope was emitted before `seen` could be observed
      // here), its notes are retired on adoption, and a burn-down dismissal
      // is a native no-op unless the placeholder is still unclaimed — so a
      // false dismissal cannot be manufactured from this line.
      //
      // The stale(gen) arm stays SILENT, deliberately: a relock raced the
      // frame, the workspace is switching, and the frame stays unacked — the
      // next session's redelivery re-decides it and may yet prove a ring.
      // That is the contract's "relock-stale return" case (onFrameVerdict),
      // and stop() has torn down this controller's subscription regardless.
      //
      // AND, for a drain in flight, this counts as proof of import. The
      // witness is in-memory, so it can only ever speak for THIS
      // drain; an entry whose import finished on an earlier launch but whose
      // `clearInboxEntry` never landed (app killed, workspace relocked, the
      // clear threw) would otherwise have no proof on any later launch and
      // would sit in the spool until `markSeen`'s prune dropped its id — at
      // which point the drain re-imported the spooled plaintext, which is
      // the duplicate-import symptom deferred rather than removed. A DURABLE seen row
      // is exactly as good a proof as the witness of a write, and the
      // sibling rescue path already treats it that way. The stale arm is
      // pointedly excluded: a relock proves nothing was imported.
      if (alreadySeen) this.drainWitness?.add(frame.msgId);
      if (!this.stale(gen)) {
        this.emitFrameVerdict(frame.from, 'not_call');
        this.ws.send({ type: 'ack', msgId: frame.msgId });
      }
      return;
    }

    // A frame from a peer device in the 'pending'
    // hold — a server-asserted sibling whose cross-signature did not verify
    // — blocks exactly like a key change: no decrypt (the ratchet must not
    // advance), no seen row, no ack. The message stays queued on the server
    // and redelivers once the human accepts the device; the anchor's thread
    // carries the same durable warning an identity change does.
    if ((await inboundGateFor(frame.from)) === 'hold') {
      if (this.stale(gen)) return;
      this.emitFrameVerdict(frame.from, 'undecryptable');
      const holdAnchor = await anchorFor(frame.from);
      this.identityChanged.add(holdAnchor);
      await db.upsertChat(holdAnchor);
      await db.setIdentityChanged(holdAnchor, Date.now());
      this.notify();
      return;
    }

    try {
      // NOTE: decryptEnvelope advances the libsignal
      // ratchet in the *native* store before the plaintext is written to
      // SQLite below. A crash in the window between the two commits loses this
      // one message (redelivery can't re-decrypt the consumed ciphertext).
      // Closing it fully needs a single transactional store spanning ratchet +
      // message state — a deferred durability item; the ordering here already
      // minimizes the window.
      const text =
        preDecrypted ??
        (await decryptEnvelope(
          this.selfUserId,
          frame.from,
          frame.msgType,
          frame.payload,
        ));
      // A relock happened while the decrypt was in flight: write NOTHING —
      // the active workspace may now be the decoy. Cost: the ratchet already
      // advanced, so this one message resurfaces as an error row on the next
      // real session's redelivery — the same accepted class as the
      // decrypt-before-persist window documented below. Isolation wins.
      if (this.stale(gen)) return;
      // THE DROP. Before parseEnvelope, therefore before the call branch,
      // before the profile branch, before edit/del, before react and before
      // insertMessage: every one of those is either a visible change or, in
      // calling's case, a ringing phone.
      //
      // Decrypt-then-drop (blocking.ts decision 2): the ratchet has already
      // advanced above, so the session stays usable if they are later
      // unblocked. Refusing to decrypt would desync it and leave the
      // conversation permanently broken.
      //
      // ACCEPTED RESIDUALS, both bounded and both invisible to them: their
      // traffic still costs this phone a decrypt, and the `seen` row below
      // still grows one row per dropped message (`seen` is unbounded by
      // design). Neither is observable from the other end.
      const block = this.blockStateFor(frame.from);
      if (!mayPersistInbound(block)) {
        // A blocked sender's frame is a terminal non-call resolution —
        // their `urgent` push may still have rung a placeholder when the
        // native blocked-peers mirror was unreadable (locked before first
        // unlock, container mismatch — CallKitCenter reads it best-effort),
        // and this drop is then the only proof the ring will ever get.
        this.emitFrameVerdict(frame.from, 'not_call');
        // markSeen BEFORE the ack, exactly as every other branch does it, and
        // for one extra reason here: a redelivery that re-decrypted against an
        // already-advanced ratchet would throw and manufacture a visible error
        // row for someone whose traffic is supposed to be invisible.
        await this.noteSeen(frame.msgId);
        // The ack goes to the SERVER and is never routed to the peer. Their
        // 'delivered' receipt is emitted by the server at send time from
        // socket liveness (packages/server/src/handlers/ws.ts), not from this
        // ack — so acking is byte-identical to the unblocked case, and NOT
        // acking would be the observable difference (plus a growing backlog).
        if (mustAckInbound(block)) {
          this.ws.send({ type: 'ack', msgId: frame.msgId });
        }
        return; // no notify() — a re-render is a behavioural difference too
      }
      const envelope = parseEnvelope(text);
      // THE SHAPE IS THE VERDICT. The payload has decrypted, so whether
      // it can ring is decided here, once, before any branch below applies
      // it — a profile card, a receipt, a room frame, a plain message and
      // unparseable JSON all resolve the same way: not a call, and a VoIP
      // placeholder ringing for this sender has nothing left to wait for.
      // Emitted before the branches rather than at each of their returns so
      // a branch that later fails transiently (store busy — retried) cannot
      // change what the payload already proved. Call-SHAPED frames are
      // excluded even when unparseable as 1:1 envelopes: `call.g*` has its
      // own parse below, and everything else `call.*` flows through
      // `onEnvelope`, where the controller owns every dismissal.
      if (
        !(envelope && isCallTcm(envelope.tcm)) &&
        !text.startsWith('{"tcm":"call.g')
      ) {
        this.emitFrameVerdict(frame.from, 'not_call');
      }
      // Call signalling is transport, not conversation: no row, no
      // preview, no unread — hand it to whoever is listening and ack. A
      // duress session never reaches here (start() refuses), but the mode is
      // checked anyway: nothing about a real call may surface in the decoy.
      //
      // EVERY call envelope is acked here, the offer included. An earlier draft
      // specified holding the offer's ack until the call
      // reached a terminal state, and that is not implementable. The premise
      // was that the server would redeliver the offer to a phone killed while
      // ringing. It would, but `decryptEnvelope` above already consumed the
      // ratchet's message key, so the redelivered bytes are undecryptable
      // (packages/cli/test/redelivery.test.ts asserts libsignal's
      // DuplicatedMessage). Worse, the failure is indistinguishable from
      // tamper, so it would land in the catch below and write a VISIBLE error
      // row into the conversation — one per reconnect during a 60-second ring.
      //
      // What the design was actually protecting is served instead by persisting the
      // DECRYPTED offer (`db.saveCallOffer`, written by the call controller
      // before anything rings), which is the same persist-before-ack ordering
      // every other branch here uses.
      if (envelope && isCallTcm(envelope.tcm)) {
        await this.noteSeen(frame.msgId);
        this.ws.send({ type: 'ack', msgId: frame.msgId });
        if (session.mode !== 'duress') {
          this.emitEnvelope(frame.from, envelope, {
            msgId: frame.msgId,
            ts: frame.ts,
          });
        }
        return;
      }
      // Small-group call signalling. Its own branch,
      // because `call.g*` is deliberately NOT in the 1:1 `Envelope` union —
      // that union is byte-for-byte what an already-shipped build parses
      // with, and leaving it alone is what makes "an old build receiving a
      // ginvite rings nothing and renders nothing" a property rather than a
      // hope. Without this branch a ginvite would fall through to
      // `applyContent` and be persisted as an (invisible, carrier-classified)
      // message row per frame: a session's worth of rows holding SDPs.
      //
      // Routed on the DECLARED tcm before the parse and acked identically
      // either way, so a malformed or future-shaped group frame costs a
      // silent drop and never the message — the one-way ratchet makes a
      // parser-shaped refusal a permanent loss.
      if (envelope === null && text.startsWith('{"tcm":"call.g')) {
        await this.noteSeen(frame.msgId);
        this.ws.send({ type: 'ack', msgId: frame.msgId });
        const group = parseGroupCallEnvelope(text);
        // Call-shaped, but nothing this build can ring — the malformed
        // group frame is dropped quietly below, and quiet must not
        // extend to the placeholder its `urgent` bit may have rung.
        if (!group) this.emitFrameVerdict(frame.from, 'not_call');
        if (group && session.mode !== 'duress') {
          // Handed over as the PARSED envelope, exactly as the 1:1 branch
          // does: the listener is the call controller's single subscription
          // point, and one subscription is one order.
          this.emitEnvelope(frame.from, group as unknown as Envelope, {
            msgId: frame.msgId,
            ts: frame.ts,
          });
        }
        return;
      }
      // A group frame this build cannot USE is dropped quietly at apply
      // time, never refused at the parser: the whole grp. namespace
      // routes on the declared tcm, so a malformed or future-shaped group
      // frame acks byte-identically and leaves no row — a parser-shaped
      // refusal would cost the message, and on a one-way ratchet that loss
      // is permanent. (The one conversational exception — a kind so old the
      // build predates rooms entirely — cannot arise here: this build knows
      // all five.)
      if (envelope === null && text.startsWith('{"tcm":"grp.')) {
        await this.noteSeen(frame.msgId);
        this.ws.send({ type: 'ack', msgId: frame.msgId });
        return;
      }
      // The one x.* kind this build CAN use: a
      // well-formed approval request becomes an `approvals` row the thread
      // renders as the card — never a messages row (the row would hold a
      // command line at rest — plus the phantom unread and the
      // blanked preview the recorded defect map recorded), never a preview
      // touch, never a reorder. ABOVE the generic drop by construction: a
      // malformed or future-shaped x.approval parses to null, misses this
      // branch, and takes the drop below — acked identically, no row, no
      // crash — which is byte-for-byte what every pre-card build does with
      // every x.approval, and why the kind was deployable at all.
      if (envelope?.tcm === 'x.approval') {
        // Nothing about a real machine's pending commands may surface in
        // the decoy. A duress session never reaches here (start() refuses),
        // but the mode is checked anyway, exactly as the call branch does —
        // and the frame still acks byte-identically, because not acking
        // would be the observable difference.
        if (session.mode === 'duress') {
          await this.noteSeen(frame.msgId);
          this.ws.send({ type: 'ack', msgId: frame.msgId });
          return;
        }
        // The chat must exist for the card to have a thread to live in;
        // upsertChat writes no preview and no lastMessageAt, so the chat
        // list's line and order stay untouched.
        await db.upsertChat(frame.from);
        if (this.stale(gen)) return;
        // Persisted BEFORE markSeen/ack, the ordering every durable branch
        // uses: the ack purges the server's copy and the ratchet key is
        // already spent, so a crash between the two must find the row on
        // disk. insertApproval is DO NOTHING under (peerId, q) — a replay
        // or a re-bind of a known id changes nothing (single-use, the
        // CLI's append-once journal holds the other half of that rule).
        //
        // `arrivedAt` is THIS phone's clock: the countdown base, display
        // only. `frame.ts` keeps the row's place in the timeline. The
        // deadline itself lives on the CLI's clock (deny via:'ttl'); the
        // card's local grey-out claims only what this phone did — nothing.
        await db.insertApproval({
          peerId: frame.from,
          q: envelope.q,
          wireMsgId: frame.msgId,
          kind: envelope.k,
          payload: envelope.p,
          ttlSec: envelope.x,
          sessionTag: envelope.s ?? null,
          verbs: envelope.a,
          ts: frame.ts,
          arrivedAt: Date.now(),
        });
        // A relock crossed the write: leave WITHOUT acking, exactly as the
        // vault branch does — acking would purge the server's copy of a
        // frame this phone never persisted, and redelivery is the only
        // repair there is.
        if (this.stale(gen)) return;
        await this.noteSeen(frame.msgId);
        this.ws.send({ type: 'ack', msgId: frame.msgId });
        this.notify();
        return;
      }
      // SIBLING SYNC: a typed sync
      // envelope from one of THIS account's own linked devices. The sender
      // gate is the own-roster check — a stranger's x.acct.sync is dropped
      // by the floor below exactly as any x.* is, and even a well-formed
      // one from a non-sibling applies nothing. Applied before seen/ack
      // (the durable-branch ordering); malformed payloads cost the sync,
      // never a row, and ack identically.
      if (envelope?.tcm === 'x.acct.sync') {
        if (session.mode !== 'duress') {
          const sibling = (await db.listLinkedDevices()).find(
            d => d.userId === frame.from && d.state === 'linked',
          );
          if (sibling) {
            const outcome = await this.applySiblingSyncEnvelope(frame.from, envelope);
            if (this.stale(gen)) return;
            if (outcome === 'applied') this.notify();
          }
        }
        await this.noteSeen(frame.msgId);
        this.ws.send({ type: 'ack', msgId: frame.msgId });
        return;
      }
      // THE SIGNED PEER-FACING ROSTER NOTICE: a
      // peer's device says a member left (unlink/revoke) or the whole
      // grouping dissolved. Verified against the ACTING member's key as
      // THIS device pinned it — peerDevices owns that machine — and a
      // forged one applies nothing while acking identically.
      if (envelope?.tcm === 'x.acct.notice') {
        if (session.mode !== 'duress') {
          const outcome = await applyPeerMutationNotice({
            senderDeviceId: frame.from,
            op: envelope.op,
            tuple: {
              groupId: envelope.groupId,
              offererUserId: envelope.offererUserId,
              acceptorUserId: envelope.acceptorUserId,
              subjectIdentityPubKey: envelope.subjectIdentityPubKey,
              class: envelope.class,
              rosterEpoch: envelope.rosterEpoch,
              offerNonce: envelope.offerNonce,
              expiresAt: envelope.expiresAt,
            },
            signature: envelope.sig,
          });
          if (this.stale(gen)) return;
          if (outcome === 'applied') this.notify();
        }
        await this.noteSeen(frame.msgId);
        this.ws.send({ type: 'ack', msgId: frame.msgId });
        return;
      }
      // The floor of the reserved x.* carrier namespace: ANY x.* kind
      // arriving as a durable send is dropped whole, routed on the DECLARED
      // tcm before the parse — parsed and unparseable alike — and acked
      // identically either way, exactly as the grp. drop above (a
      // parser-shaped refusal would cost the message, and on a one-way
      // ratchet that loss is permanent). x.typing belongs ONLY inside
      // relay-only typing frames; honoring a durable one would turn the one
      // deliberately-droppable signal into a persistent one ("typing" on
      // next connect, hours later). And an unknown x.* used to fall through
      // to applyContent, which cost three things per frame: an invisible
      // row holding the raw carrier JSON at rest (a command line in
      // `messages`), a phantom unread the filtered-out row could
      // never clear, and a blanked preview line (previewFor yields '' for
      // carriers, so the touch wrote '' over the chat's last words). No
      // row, no preview, no notify, nothing logged. A kind a build CAN use
      // (x.approval, when it ships) takes its branch ABOVE this one; this
      // drop staying the floor is what makes a future x.* kind deployable
      // against builds already in the field.
      if (text.startsWith('{"tcm":"x.')) {
        await this.noteSeen(frame.msgId);
        this.ws.send({ type: 'ack', msgId: frame.msgId });
        return;
      }
      // Rooms, the receive path. After the block drop —
      // The table: a blocked member's room traffic decrypts then drops
      // through the same early gate as their 1:1 traffic — and after the
      // call branch, because signalling outranks conversation.
      if (envelope && isGroupEnvelope(envelope)) {
        await this.handleGroupEnvelope(
          frame,
          envelope,
          text,
          gen,
          token,
          preDecrypted !== undefined,
        );
        return;
      }
      if (envelope?.tcm === 'profile') {
        // A card dated far in the future would win forever and freeze this
        // person's profile, so anything past a generous clock-skew window is
        // not applied. (Their next card, correctly dated, still lands.)
        if (envelope.v > Date.now() + PROFILE_FUTURE_TOLERANCE_MS) {
          await this.noteSeen(frame.msgId);
          this.ws.send({ type: 'ack', msgId: frame.msgId });
          return;
        }
        // A profile card updates who this person is, it is not a message:
        // no row, no preview change, no unread. Newest version wins.
        await db.upsertChat(frame.from);
        if (this.stale(gen)) return;
        // Republished below via publishNames — a card is exactly the event
        // that changes what an incoming ring should say.
        await db.applyPeerProfile(frame.from, {
          displayName: envelope.n,
          about: envelope.a,
          // A card carrying a photo keeps the known face until the new blob
          // arrives; a card carrying none is an explicit removal.
          hasAvatar: Boolean(envelope.att && envelope.key),
          version: envelope.v,
        });
        await this.noteSeen(frame.msgId);
        this.ws.send({ type: 'ack', msgId: frame.msgId });
        if (envelope.att && envelope.key) {
          this.queueAvatarDownload(
            frame.from,
            envelope.att,
            envelope.key,
            envelope.v,
          );
        }
        // A card is exactly the event that changes what an incoming ring
        // should say; the mirror follows the database.
        void this.publishNames();
        this.notify();
        return;
      }
      if (envelope?.tcm === 'timer') {
        // A setting AND an announcement. It is not a carrier: unlike a profile
        // card or a reaction, someone shortening the window on my words is a
        // thing I am entitled to be told about ("a
        // silently shortened timer is a trust problem"), so it leaves a row on
        // this phone exactly as it leaves one on theirs. Same future-dated
        // guard the profile card uses — a frame dated far ahead would win
        // forever and freeze the timer.
        if (envelope.v > Date.now() + PROFILE_FUTURE_TOLERANCE_MS) {
          await this.noteSeen(frame.msgId);
          this.ws.send({ type: 'ack', msgId: frame.msgId });
          return;
        }
        await db.upsertChat(frame.from);
        if (this.stale(gen)) return;
        const applied = await db.setDisappearTimer(frame.from, envelope.s, envelope.v);
        // Arm what is already here so turning the timer ON starts the clock
        // on the visible backlog rather than only on what arrives next.
        if (applied && envelope.s > 0 && !this.stale(gen)) {
          await db.armExpiry(frame.from, envelope.s, Date.now());
        }
        // THE ANNOUNCEMENT ROW, and it must come AFTER armExpiry.
        //
        // armExpiry stamps every inbound row that has no expiry yet, so
        // inserting first would start this row's clock at ARRIVAL rather than
        // at read — and a peer setting a short timer while this phone was off
        // would then delete the only notice that they had set it. Left
        // unarmed, the thread-open sweep arms it at READ, which is the rule
        // every other inbound row already follows (db.armExpiry's own comment:
        // a message that expired in the queue vanished having never been
        // delivered). It then expires with the conversation it announced —
        // see setDisappearTimer for why announcing OFF is the one that stays.
        //
        // Only when `applied`. A superseded or replayed frame changed nothing
        // on this phone, and a row announcing a change that did not happen is
        // worse than no row: it would let a peer replay one old envelope into
        // an endless stream of "they set disappearing messages to ..." lines.
        //
        // Persist BEFORE markSeen/ack, like every other row-writing branch: the
        // ack purges the server's copy, so a crash in between would lose the
        // notice for good.
        if (applied && !this.stale(gen)) {
          await db.insertMessage({
            msgId: frame.msgId,
            peerId: frame.from,
            direction: 'in',
            // The body IS the envelope, exactly as the screenshot notice does
            // it. Nothing ever renders it raw: ChatThreadScreen has a branch
            // ahead of every bubble path and previewFor/displayText both
            // special-case it.
            body: text,
            ts: frame.ts,
            status: 'received',
          });
          if (this.stale(gen)) return;
          await this.touchChatOrdered(
            frame.from,
            frame.ts,
            async () => previewFor(text),
            token,
          );
        }
        await this.noteSeen(frame.msgId);
        this.ws.send({ type: 'ack', msgId: frame.msgId });
        if (applied) this.notify();
        return;
      }
      if (envelope?.tcm === 'vault') {
        // A vault write is a SETTING and an ANNOUNCEMENT, like the timer above
        // and unlike a profile card: the other person changing the door code is
        // a thing I am entitled to be told about, so it leaves a row here
        // exactly as it leaves one there.
        //
        // THERE IS NO FUTURE CLAMP HERE, AND ITS ABSENCE IS THE FIX.
        //
        // The card and the timer still clamp, because their version genuinely
        // is a sender wall clock. The vault's used to be, and the clamp it
        // needed was a permanent silent drop: a peer restoring from a backup
        // with a wrong date wrote a version a day ahead, this phone dropped the
        // frame AND ACKED IT — so the server's copy was purged and the ratchet
        // key spent — and it was STICKY, because `max(now, current + 1)` then
        // carried the bad number into every later edit of that item. One honest
        // clock error silenced one credential forever, and a malicious peer
        // could aim it deliberately.
        //
        // Nothing on the wire is a clock now (envelope.ts), so there is no
        // future-dated frame to clamp, no drop, and nothing to make sticky. A
        // forged counter of 2^53 saturates the forger's OWN slot and can never
        // reach mine, so the freeze this guard existed to prevent is not
        // mitigated here — it is impossible one layer down.
        await db.upsertChat(frame.from);
        if (this.stale(gen)) return;
        // `frame.from` is BOTH the conversation and the writer id. As the
        // conversation it scopes the (peerId, id, writerId) key so a peer's
        // chosen id cannot reach into another Room; as the writer id it names
        // the slot only they may write, which is why `writerId` is not a field
        // a payload can set.
        //
        // `Date.now()` and not `frame.ts`: a relayed timestamp is unproven, and
        // `updatedAt` is display only. Storing the sender's clock inbound while
        // storing this phone's outbound is what made the two vaults list the
        // same items in different orders.
        const applied = await this.applyVaultEnvelope(
          frame.from,
          envelope,
          frame.from,
          Date.now(),
          gen,
        );
        // A relock crossed the merge: leave WITHOUT acking, exactly as the
        // stale checks either side of this branch do. Acking would purge the
        // server's copy of a frame this phone never applied, and this transport
        // has no second copy — a redelivery is the only repair there is.
        if (applied === 'stale') return;
        // Only when `applied`, and persisted BEFORE markSeen/ack — both rules
        // copied verbatim from the timer branch, and for the same two reasons:
        // a row announcing a change that did not happen lets one replayed
        // envelope become an endless stream of notices, and the ack purges the
        // server's copy so a crash in between would lose the notice for good.
        //
        // The row's body IS the envelope, secret included. Nothing renders it
        // raw: ChatThreadScreen has a branch ahead of every bubble path that
        // draws the TITLE only, previewFor words it without the title, and
        // displayText — the clipboard and VoiceOver path — yields ''.
        if (applied && !this.stale(gen)) {
          await db.insertMessage({
            msgId: frame.msgId,
            peerId: frame.from,
            direction: 'in',
            body: text,
            ts: frame.ts,
            status: 'received',
          });
          if (this.stale(gen)) return;
          await this.touchChatOrdered(
            frame.from,
            frame.ts,
            async () => previewFor(text),
            token,
          );
        }
        await this.noteSeen(frame.msgId);
        this.ws.send({ type: 'ack', msgId: frame.msgId });
        if (applied) this.notify();
        return;
      }
      if (envelope?.tcm === 'read') {
        // A status rewrite, not a message: no row, no preview, no unread.
        // `frame.from` scopes it to this conversation and `db.markRead`
        // additionally requires direction 'out' and a current status of
        // 'delivered', so a peer can only report having read MY messages and
        // cannot resurrect a failed send.
        await db.upsertChat(frame.from);
        if (this.stale(gen)) return;
        const changed = await db
          .markRead(frame.from, envelope.ids, frame.ts)
          .catch(() => 0);
        await this.noteSeen(frame.msgId);
        this.ws.send({ type: 'ack', msgId: frame.msgId });
        // Only when something moved: a replayed receipt must not re-render
        // every open list for no visible change.
        if (changed > 0) this.notify();
        return;
      }

      // Everything from here down is CONTENT, and it runs through THE ONE
      // SWITCH: applyContent. A room message reaches the identical
      // method through handleGroupMessage with the room's context — same
      // arms, same guards, same ack ordering — which is what "photos, files,
      // locations, replies, edits, retractions and reactions work in rooms
      // with zero duplication" means in code. A second copy of these arms
      // has shipped drift twice; do not add one.
      // DEVICE FAN-OUT, receive half: a
      // grouped peer's leg wears the dev.msg wrapper. The row is keyed by
      // the SHARED id `m` — redelivery and any cross-path duplicate of the
      // same authored message dedupe on it — and lands in the ANCHOR's
      // thread whichever of the peer's devices sent this leg. The inner
      // body runs through THE ONE SWITCH exactly as a room message's does.
      if (envelope?.tcm === 'dev.msg') {
        const anchor = await anchorFor(frame.from);
        const inner = parseEnvelope(envelope.b);
        await this.applyContent({
          gen,
          token,
          convId: anchor,
          senderId: frame.from,
          wireMsgId: frame.msgId,
          rowMsgId: envelope.m,
          authorId: null,
          ts: frame.ts,
          sq: null,
          outsider: false,
          ai: aiOriginOf(envelope) || aiOriginOf(inner),
          text: envelope.b,
          envelope: inner,
          spooled: preDecrypted !== undefined,
        });
        return;
      }
      await this.applyContent({
        gen,
        token,
        convId: frame.from,
        senderId: frame.from,
        wireMsgId: frame.msgId,
        rowMsgId: frame.msgId,
        authorId: null,
        ts: frame.ts,
        sq: null,
        outsider: false,
        // 1:1: the inner envelope's own claim (`msg`, and any future kind
        // that carries the field). Sender-claimed, per the honest-limits rule.
        ai: aiOriginOf(envelope),
        text,
        envelope,
        spooled: preDecrypted !== undefined,
      });
      return;
    } catch (err) {
      // Same rule as above: after a relock, even the error paths must not
      // touch the (possibly switched) workspace.
      if (this.stale(gen)) return;
      const failed = this.blockStateFor(frame.from);
      if (isBlocked(failed)) {
        // Same reasoning as the decrypted drop above — a blocked
        // sender's unreadable frame is terminal, and its ring must not
        // outlive it when the native mirror missed the block.
        this.emitFrameVerdict(frame.from, 'undecryptable');
        // BLOCK OUTRANKS BOTH FAILURE MODES BELOW. Without this, blocking
        // someone whose key changed would paint a red banner and resurrect
        // their row in this person's own list — and, because that branch
        // deliberately does not ack, would leave their ciphertext queued on
        // the server forever as a growing, externally visible backlog. A
        // tamper/corruption frame would likewise insert a visible error row.
        // Same two statements as the drop above, for the same reasons.
        await this.noteSeen(frame.msgId);
        if (mustAckInbound(failed)) {
          this.ws.send({ type: 'ack', msgId: frame.msgId });
        }
        return;
      }
      if (isIdentityChangeError(err)) {
        // The sender's safety number changed. Block-and-warn: do NOT ack or
        // mark seen — the message stays queued and re-delivers (and decrypts)
        // once the user accepts the new identity.
        //
        // Terminal FOR THE RING even though the frame stays queued — no
        // offer behind this failure can decrypt until the person accepts the
        // new identity, which is a decision, not a wait. A placeholder left
        // ringing against it has nothing to wait for.
        this.emitFrameVerdict(frame.from, 'undecryptable');
        this.identityChanged.add(frame.from);
        await db.upsertChat(frame.from);
        // After upsertChat, so the row this UPDATE targets exists. Durable for
        // the same reason as the send path: a warning that disappears on
        // relaunch is not a warning.
        await db.setIdentityChanged(frame.from, Date.now());
        this.notify();
        return;
      }
      // THE SPOOL RESCUE. A failed decrypt is not always tamper: if the
      // notification extension decrypted this exact message while the app was
      // asleep, its ratchet key is SPENT and the redelivered ciphertext can
      // only ever throw DuplicatedMessage — but the plaintext is sitting in
      // the spool. The race is real and scheduled by the server itself: the
      // push fires precisely when no socket is connected, so an extension can
      // finish decrypting after the app's launch-time drain and before the
      // socket's redelivery. Without this check that message became a visible
      // error row, was marked seen and acked — and the next drain then
      // DELETED the spooled plaintext because `seen` said it was handled.
      // Permanent loss, of a message that was decrypted successfully.
      try {
        // Never from inside a rescue: the pre-decrypted pass skips the
        // decrypt, so reaching this catch AGAIN means the import itself
        // failed (a database error, a relock) — and re-entering would find
        // the same spool entry and recurse without bound. Returning leaves
        // the entry spooled for the next launch, which is the contract.
        const spooled = preDecrypted !== undefined
          ? undefined
          : (await readInbox()).find(e => e.msgId === frame.msgId);
        if (spooled) {
          // Depth-one recursion: with a pre-decrypted body the decrypt is
          // skipped, so this cannot land back here for the same reason.
          // The INNER path, deliberately — the outer door still holds this
          // msgId in `inflightMsgIds`, and the rescue is the same handling
          // continued, not a concurrent duplicate to be dropped.
          // The SAME dispatch token: this is the same frame's handling
          // continued, not a new event entering the system.
          await this.handleIncomingInner(
            frame,
            spooled.body,
            busyRetriesLeft,
            gen,
            token,
          );
          if (await db.hasSeen(frame.msgId)) {
            await clearInboxEntry(frame.msgId).catch(() => undefined);
          }
          return;
        }
      } catch {
        // The spool being unreadable must not change what the original
        // error meant. Fall through and let the branches below decide.
      }
      // A DUPLICATED ratchet message whose spool gave us nothing is NOT
      // tamper: the key was spent by the extension, and the spooled
      // plaintext may simply have been unreadable THIS attempt. Poisoning
      // here acked away the last recovery chance. Unacked, the server
      // redelivers and the rescue retries with the spool healthy.
      if (
        preDecrypted === undefined &&
        err instanceof Error &&
        err.message.includes('DuplicatedMessage')
      ) {
        return;
      }
      // A busy store lock is TRANSIENT BY CONSTRUCTION — its only other
      // holder is the notification extension, which lives for seconds. Do
      // nothing at all: no error row, no `seen`, no ack. The server still
      // holds the ciphertext and redelivers it; the next attempt finds the
      // lock free. Treating this as tamper acked away a perfectly good
      // message over a five-second wait.
      if (isStoreBusyError(err)) {
        // Retried LOCALLY, bounded, because the server's drain is one-shot:
        // an unacked frame is not redelivered until the next reconnect, and
        // for a call offer that reconnect can land after the ring is dead.
        // The lock's holder is the notification extension, which lives for
        // seconds — three retries spaced 1.5s apart outlive any legitimate
        // hold. Exhausted retries fall back to the old behaviour: unacked,
        // redelivered on reconnect. The retry carries the SAME dispatch
        // token it entered with — this frame's handling continued, not a
        // new event — or a 1.5s wait outranked every frame that landed
        // inside it and dragged the chat line back to older words.
        //
        // WAITED IN PLACE, not re-entered from a timer: the 1.5 s is part of
        // THIS frame's handling, so the per-sender chain
        // (`dispatchIncoming`) holds every later frame from the same sender
        // behind it, and the msgId's in-flight claim stays put — a duplicate
        // arriving mid-wait parks and re-enters after the retry, exactly as
        // one arriving mid-decrypt does. The retry goes through the INNER
        // path like the spool rescue: the same handling continued, never a
        // concurrent duplicate to be turned away.
        if (busyRetriesLeft > 0 && !this.stale(gen)) {
          const woke = await new Promise<boolean>(resolve => {
            const wait = {
              timer: setTimeout(() => {
                const at = this.busyRetryWaits.indexOf(wait);
                if (at >= 0) this.busyRetryWaits.splice(at, 1);
                resolve(true);
              }, 1_500),
              wake: resolve,
            };
            this.busyRetryWaits.push(wait);
          });
          if (woke && !this.stale(gen)) {
            await this.handleIncomingInner(
              frame,
              preDecrypted,
              busyRetriesLeft - 1,
              gen,
              token,
            );
          }
        }
        return;
      }
      // NEVER from a spool pass. The plaintext in hand decrypted FINE — the
      // failure was a transient db write — and this branch's markSeen+ack
      // would be read by the drain's proof check as "imported", deleting the
      // only plaintext and suppressing every future redelivery. Returning
      // leaves the entry spooled for the next launch, which is the contract;
      // seen stays a truthful proof of import for the passes that matter.
      if (preDecrypted !== undefined) return;
      // The tamper classification below is terminal — the ratchet key is
      // spent and the bytes will never decrypt — so the verdict is emitted
      // whether or not the error-row writes beneath succeed: what the
      // payload proved does not depend on persisting the proof.
      this.emitFrameVerdict(frame.from, 'undecryptable');
      // Tamper/corruption: reject loudly in the UI as an error row, render
      // nothing of the payload, ack to purge the poison message.
      //
      // Its own try, because this IS the catch: a database that fails here
      // used to throw out of the handler as an unhandled rejection — and the
      // ordering below is the loss-prevention. The ack comes strictly last,
      // so a write that dies part-way leaves the message QUEUED on the
      // server (redelivered, retried later) instead of purged with nothing
      // recorded anywhere.
      try {
        await db.insertMessage({
          msgId: frame.msgId,
          peerId: frame.from,
          direction: 'in',
          body: '',
          ts: frame.ts,
          status: 'error',
        });
        await db.upsertChat(frame.from);
        await this.noteSeen(frame.msgId);
        this.ws.send({ type: 'ack', msgId: frame.msgId });
      } catch {
        // Left un-acked on purpose. See above.
      }
    }
    this.notify();
  }

  // --- Rooms: the receive path ----

  /**
   * The ONE seam every inbound branch marks a wire id seen through: the
   * durable `seen` row (redelivery dedup) plus, while a spool drain is
   * running, the in-memory witness the drain clears entries on. Any branch
   * that finishes its handling calls this; the early returns (no session,
   * a stale generation, a store-busy retry) do not — which is exactly what
   * makes the witness a truthful proof of import.
   */
  private async noteSeen(msgId: string): Promise<void> {
    await db.markSeen(msgId, Date.now());
    this.drainWitness?.add(msgId);
  }

  /** markSeen then ack, in the order every inbound branch uses: seen is the
   * durable proof, the ack purges the server's only other copy. */
  private async ackInbound(msgId: string): Promise<void> {
    await this.noteSeen(msgId);
    this.ws.send({ type: 'ack', msgId });
  }

  /**
   * One authenticated `grp.*` frame, routed by kind. Every completed branch
   * acks BYTE-IDENTICALLY to a 1:1 frame — same two statements, same order —
   * whatever it decided (the gate table): a counted write, a
   * declined one, a room this phone does not hold, and a member's straggler
   * all look the same on the wire.
   *
   * The transport-level replay backstop the classifier defers to is
   * `hasSeen` at the top of handleIncomingInner: a REPLAYED frame (same wire
   * msgId) re-acks and changes nothing, so a replayed genuine `grp.del`
   * cannot re-purge a re-anchored room. A NEW frame with the same payload is
   * its writer's own act, not a replay.
   */
  private async handleGroupEnvelope(
    frame: MsgFrame,
    envelope: GroupEnvelope,
    text: string,
    gen: number,
    token: number,
    /** The frame's body came from the extension's spool — see
     * ContentContext.spooled. Only the content arm consumes it. */
    spooled: boolean,
  ): Promise<void> {
    const selfId = this.selfUserId;
    if (!selfId) return;
    switch (envelope.tcm) {
      case 'grp.msg':
        return this.handleGroupMessage(frame, envelope, gen, token, spooled);
      case 'grp.new':
        return this.handleGroupNew(frame, envelope, text, gen, token);
      case 'grp.roster':
        return this.handleGroupRoster(frame, envelope, text, gen, token);
      case 'grp.set':
        return this.handleGroupSettings(frame, envelope, text, gen, token);
      case 'grp.del':
        return this.handleGroupDel(frame, envelope, text, gen, token);
      case 'grp.hist':
        return this.handleGroupHistory(frame, envelope, text, gen, token);
      case 'grp.consent':
        return this.handleGroupConsent(frame, envelope, text, gen, token);
    }
  }

  /**
   * `grp.hist` — history shared with a newcomer.
   *
   * Two shapes through one handler, told apart by `e`: the announcement every
   * member gets, and one transcript entry the newcomer alone gets.
   *
   * THE OWNER GATE IS THE WHOLE SECURITY PROPERTY. A relayed entry is an
   * unauthenticated claim about a third party's words (the ratchet proves who
   * RELAYED it, never who wrote it), so the one thing that must hold is that
   * only the room's owner can make the claim at all. `ownerId` is a constant
   * written once at accept and never carried in a payload, so the verdict is
   * stable the moment the write arrives — same reasoning as `grp.del`.
   * Anything else renders as a declined, attributed row and stores no history.
   */
  private async handleGroupHistory(
    frame: MsgFrame,
    envelope: Extract<GroupEnvelope, { tcm: 'grp.hist' }>,
    text: string,
    gen: number,
    token: number,
  ): Promise<void> {
    const room = await this.runGroupApply(async () => {
      if (this.stale(gen)) return null;
      const store = await db.loadGroupStore(envelope.g);
      const owner = store.getOwner();
      // Unanchored or ended room: acked byte-identically, then discarded. Straggler history recreates nothing.
      if (owner === undefined || !store.isPresent()) return { deliver: false as const };
      return { deliver: true as const, byOwner: frame.from === owner };
    });
    if (room === null || this.stale(gen)) return;
    if (!room.deliver) {
      await this.ackInbound(frame.msgId);
      return;
    }

    if (room.byOwner && envelope.e) {
      const entry = envelope.e;
      // The timer binds, checked against MY clock and not the relayer's. The relayer filtered too, but its clock is not evidence:
      // without this a skewed or dishonest sender could hand back a message
      // the timer already took, and the timer would become a suggestion.
      const expiresAt = entry.x ?? null;
      if (expiresAt !== null && expiresAt <= Date.now()) {
        await this.ackInbound(frame.msgId);
        return;
      }
      await db.insertMessage({
        // The author's own room key, NOT the relayer's — so the author's
        // first-hand copy is literally the same row if it ever arrives.
        msgId: `${entry.a}.${entry.m}`,
        peerId: envelope.g,
        direction: 'in',
        body: entry.b,
        ts: entry.t,
        status: 'received',
        // The CLAIMED author. Paired with sharedBy below, which is what stops
        // this being read as authenticated anywhere.
        authorId: entry.a,
        expiresAt,
        sharedBy: frame.from,
        // The Art. 50 marker survives the relay (the belt): the
        // amended marker sits INSIDE an envelope-shaped `b`, so a
        // relayed agent message still carries its claim — back-filled here
        // RAISE-ONLY (bare stays bare; nothing is invented). DETECTION, not
        // authentication: `sharedBy` above already marks this row a
        // second-hand, unauthenticated account, and that does not change.
        ...(aiOriginOf(parseEnvelope(entry.b)) ? { ai: 1 } : {}),
        // Honest arrival: this phone received the relay NOW. What keeps a
        // newcomer's 200 catch-up rows from being 200 unread ones — and a
        // relayed historical mention off the @ badge — is `sharedBy` above,
        // which the unread queries exclude, never a missing clock.
        arrivedAt: Date.now(),
      });
      // NO touchChat and NO notify. A newcomer handed 200 messages must not
      // get 200 notifications, and history must not reorder their chat list
      // to today or put a past message's words on a lock screen dated now.
      // The announcement leg below is the one thing that surfaces, once.
      await this.ackInbound(frame.msgId);
      return;
    }

    // The announcement — and the declined row, which uses the same shape
    // deliberately: a refused share is still something the room should see.
    // Counted versus declined is derived at render time from authorId against
    // the anchor's owner, exactly as roster rows are.
    await db.insertMessage({
      msgId: frame.msgId,
      peerId: envelope.g,
      direction: 'in',
      body: text,
      ts: frame.ts,
      status: 'received',
      authorId: frame.from,
    });
    if (this.stale(gen)) return;
    if (room.byOwner) {
      // A declined attempt must not let a non-owner reorder anyone's chat
      // list — the same rule the roster handler holds.
      await this.touchChatOrdered(
        envelope.g,
        frame.ts,
        async () => previewFor(text),
        token,
      );
      if (this.stale(gen)) return;
    }
    await this.ackInbound(frame.msgId);
    this.notify();
  }

  /**
   * `grp.new` — invitation-or-room: the accept path anchors the
   * room (frame.from IS the owner, forever), converts `ms` into owner-lane
   * `in` slots WITH THE SENDER CLAMPED IN (a recorded defect's
   * class, closed against a hostile composer too — the clamp lives in
   * `applyGroupNew`), and leaves the grp.new itself as an attributed row the
   * UI renders as an invitation or a plain announcement (the
   * row is the shared apply layer's). Whether it is an invitation is derived
   * at render time from message history with the sender, not stored.
   */
  private async handleGroupNew(
    frame: MsgFrame,
    envelope: Extract<GroupEnvelope, { tcm: 'grp.new' }>,
    text: string,
    gen: number,
    token: number,
  ): Promise<void> {
    const selfId = this.selfUserId!;
    const result = await this.runGroupApply(async () => {
      if (this.stale(gen)) return null;
      const store = await db.loadGroupStore(envelope.g);
      // The accept path names the room from the envelope; a later duplicate
      // keeps the stored anchor's name (written once).
      store.anchorName = store.anchorName ?? envelope.nm;
      const applied = applyGroupNew(
        store,
        selfId,
        {
          writerId: frame.from,
          members: envelope.ms,
          seq: envelope.n,
          // The writer's class claims: stamped onto the
          // seed slots so THIS phone's fold knows which members the owner's
          // records call machines — the consent surface can then be offered
          // before any of them has spoken. Judged by the fold (authority
          // lane only), never here.
          ...(envelope.ic !== undefined ? { integrations: envelope.ic } : {}),
        },
        ownerOnlyPolicy,
      );
      await store.persist();
      return applied;
    });
    // A relock crossed the apply: leave WITHOUT acking, like every stale
    // return in this file — redelivery is the only repair there is.
    if (result === null || this.stale(gen)) return;
    if (result.outcome === 'accepted') {
      // Being added to a room is a thing that happened to you: a real
      // row, attributed to the claimed owner, previewed as "New room".
      // Persist BEFORE the ack, like every row-writing branch.
      await db.insertMessage({
        msgId: frame.msgId,
        peerId: envelope.g,
        direction: 'in',
        body: text,
        ts: frame.ts,
        status: 'received',
        authorId: frame.from,
      });
      if (this.stale(gen)) return;
      await this.touchChatOrdered(
        envelope.g,
        frame.ts,
        async () => previewFor(text),
        token,
      );
      if (this.stale(gen)) return;
    }
    await this.ackInbound(frame.msgId);
    // 'merged' moved slots (or recreated a hidden room) with no new surface
    // row; 'ignored' — an exact replay, or a forged re-anchor from a second
    // writer — changed nothing and re-renders nothing.
    if (result.outcome !== 'ignored') this.notify();
  }

  /**
   * `grp.roster` — the two lanes and nothing else. The pure
   * fold classifies: a SOVEREIGN self write and the OWNER's authority write
   * count; anything else is provably dead the moment it arrives, stores no
   * slot, and renders as a DECLINED, ATTRIBUTED row — never silently
   * (the founding argument). There is no pending state anywhere: nothing
   * is ever "not yet decidable", and a held-write row appearing would be
   * deleted machinery growing back.
   */
  private async handleGroupRoster(
    frame: MsgFrame,
    envelope: Extract<GroupEnvelope, { tcm: 'grp.roster' }>,
    text: string,
    gen: number,
    token: number,
  ): Promise<void> {
    const selfId = this.selfUserId!;
    const write: RosterSlot = {
      // rule 16: the writer is frame.from, NEVER a payload field — a payload
      // claiming someone else's lane lands in its real sender's.
      writerId: frame.from,
      memberId: envelope.m,
      seq: envelope.n,
      state: envelope.s,
      // The class claim rides the slot verbatim; whether
      // it MEANS anything is the fold's call — only the owner's authority
      // lane classifies, so a non-owner's claim is stored inert.
      ...(envelope.c !== undefined ? { class: envelope.c } : {}),
    };
    const result = await this.runGroupApply(async () => {
      if (this.stale(gen)) return null;
      const store = await db.loadGroupStore(envelope.g);
      const applied = applyRosterWrite(store, selfId, write, ownerOnlyPolicy);
      await store.persist();
      return { applied, present: store.isPresent() };
    });
    if (result === null || this.stale(gen)) return;
    const { applied, present } = result;
    // Announce only what the room can show: 'applied' is a counted change
    // ("Ana removed Ben"), 'declined' is the attributed refusal ("Cara tried
    // to remove Ben..."), both derived at render time from authorId against
    // the anchor's owner — deterministic forever, because the owner is a
    // constant. 'stale' (a replay) announces NOTHING: messaging.ts's
    // announce-only-when-applied rule, which stops one old envelope becoming
    // an endless announcement stream. Pre-anchor and unknown-room have no
    // surface to announce into.
    const visible =
      present && (applied.outcome === 'applied' || applied.outcome === 'declined');
    if (visible) {
      await db.insertMessage({
        msgId: frame.msgId,
        peerId: envelope.g,
        direction: 'in',
        body: text,
        ts: frame.ts,
        status: 'received',
        authorId: frame.from,
      });
      if (this.stale(gen)) return;
      if (applied.outcome === 'applied') {
        // A counted change bumps the room; a declined attempt must not let
        // an outsider reorder anyone's chat list.
        await this.touchChatOrdered(
          envelope.g,
          frame.ts,
          async () => previewFor(text),
          token,
        );
        if (this.stale(gen)) return;
      }
    }
    await this.ackInbound(frame.msgId);
    if (visible) this.notify();
  }

  /**
   * `grp.consent` — the member-consent announcement. A
   * SOVEREIGN self-statement, closest in shape to grp.roster's self lane: the
   * AUTHENTICATED sender (`frame.from`) tells the room their OWN
   * sharing stance toward one agent — "Bob isn't sharing with Claude" and its
   * consented counterpart. There is no authority decision and no roster
   * mutation; a member may always narrate their own consent. TWO gates:
   * (1) MEMBERSHIP — a non-member (or a removed member) cannot narrate a room
   * they are not in, so a stance from anyone the fold does not currently place
   * `in` stores no row; (2) the SUBJECT is an agent-class member of THIS room —
   * a stance is only meaningful about an agent, so `a` must be in the same
   * marker-OR-record set the consent surface reads (machine_peers ∪ ai-marked
   * authors here), exactly as grp.roster validates its `m` against the fold.
   * Without it a modified client could emit `grp.consent` naming an arbitrary
   * account and render a misleading system line ("Mallory isn't sharing with
   * Bob"). Because the announcer is `frame.from` and never a payload field, a
   * peer can only ever announce THEIR OWN stance.
   *
   * Stored exactly as a roster announcement: the envelope JSON is the row
   * body, `authorId` is the authenticated sender, and there is NO `arrivedAt`
   * — a sharing change is an event, not a message, so it never raises an
   * unread count (handleGroupRoster's rule). The relay saw only ciphertext
   * (relay-blind): it routed one opaque leg per member, learning nothing of who
   * shares with whom.
   */
  private async handleGroupConsent(
    frame: MsgFrame,
    envelope: Extract<GroupEnvelope, { tcm: 'grp.consent' }>,
    text: string,
    gen: number,
    token: number,
  ): Promise<void> {
    const group = await db.getGroup(envelope.g);
    // Pre-anchor / unknown room: no surface to announce into (grp.roster's
    // floor). Ack so the frame drains rather than redelivering forever.
    if (!group || this.stale(gen)) {
      await this.ackInbound(frame.msgId);
      return;
    }
    const slots = await db.listGroupMemberSlots(envelope.g);
    const fold = foldRoster(group.ownerId, slots, ownerOnlyPolicy);
    // Gate 1 — MEMBERSHIP. `frame.from` is authenticated, so this reads the
    // sender's OWN membership, never a claim: a removed member or a stranger
    // who learned the gid stores no row.
    // Gate 2 — the SUBJECT is an agent-class member of THIS room: the
    // marker-OR-record set the consent surface reads, plus
    // the fold's roster class — the owner's authoritative write — so a
    // stance about a never-spoken agent stores its row on the stranger's
    // phone too. A stance about a non-agent account stays meaningless and a
    // spoof vector: no row, no system line. (The CLI's room-render.ts holds
    // the same three-signal gate.)
    const agentIds = new Set<string>([
      ...(await db.listMachinePeers()),
      ...(await db.listRoomAgentAuthorIds(envelope.g)),
      ...fold.members.filter(id => fold.classes[id] === 'integration'),
    ]);
    const visible =
      verdictFor(fold, frame.from) === 'in' && agentIds.has(envelope.a);
    if (visible) {
      await db.insertMessage({
        msgId: frame.msgId,
        peerId: envelope.g,
        direction: 'in',
        body: text,
        ts: frame.ts,
        status: 'received',
        authorId: frame.from,
      });
      if (this.stale(gen)) return;
      await this.touchChatOrdered(
        envelope.g,
        frame.ts,
        async () => previewFor(text),
        token,
      );
      if (this.stale(gen)) return;
    }
    await this.ackInbound(frame.msgId);
    if (visible) this.notify();
  }

  /**
   * The member-consent DECISION, driven from
   * the room's roster surface. The human chooses whether the room's agent may
   * hear them, and this does the three things that decision means, in the
   * order the rule fixes:
   *
   *  1. THE EDGE, blocking. `share` writes the global pairwise edge
   *     (POST /v1/consent); `hold` deletes it (DELETE). This is the ONLY act
   *     that gates delivery — "consenting writes the pairwise edge, refusing writes
   *     nothing" — so nothing local may claim a stance the server never took.
   *     A refused call throws: the decision did not take.
   *  2. THE LOCAL RECORD, after the edge call settles. The route's 204 is
   *     UNIFORM: stored, already-stored, nonexistent, non-integration
   *     and over-cap are indistinguishable, so this client's own row is the
   *     ONLY place it knows it tried. Best-effort (the CLI's
   *     recordConsentGrant precedent): a full disk cannot un-take a decision
   *     the server already accepted.
   *  3. THE ANNOUNCEMENT, best-effort. A grp.consent event sealed
   *     into the room so every HUMAN author learns who the agent can and
   *     cannot hear before typing. `share` reaches the full roster, including
   *     the agent whose newly written edge admits that leg. `hold` reaches
   *     humans only: every recognized agent is intentionally outside the
   *     audience after the subject's edge is deleted. The subject learns on
   *     its next server-refused frame.
   *     A read-only room or an unsendable human leg must not un-take the
   *     decision — the caller is told "sharing changed, room not told".
   *
   * REVOKE FIRST, TELL HUMANS ONLY. Privacy does
   * not wait for courtesy delivery. Both directions therefore run edge →
   * local record → announcement. For share, that is POST then full-roster
   * fan-out. For hold, it is DELETE immediately, then `refused`, then a
   * human-only fan-out. There is no receipt gate and no ordering exception:
   * no agent leg can race the DELETE because none exists.
   *
   * The hold failure matrix is now clean:
   *  (a) DELETE fails → throw; no local record and no announcement. Nothing
   *      changed and the caller can retry without a contradictory room row.
   *  (b) DELETE succeeds, announcement fails → the refusal stands and the
   *      result carries `announced:false`; the screen says sharing stopped
   *      but the room was not told.
   *  (c) both succeed → the edge is gone and the human room was told.
   *
   * `atCap` is computed from LOCAL COUNT ALONE. The server stores while
   * edges < CONSENT_MAX_EDGES, so the CONSENT_MAX_EDGES-th share still takes and
   * only the next one is dropped: a local count of exactly CONSENT_MAX_EDGES
   * implies nothing was lost, and only a count STRICTLY ABOVE it (recorded after
   * the opaque 204) is the first that implies a prior full slate and a
   * possibly-dropped write — hence `> CONSENT_MAX_EDGES`, not `>=`. When it
   * trips, the app may say so gently. It is a lower bound on the server's real
   * count
   * (edges from another client are not here), which is why the surface is
   * hedged and advisory, and it NEVER probes the route to check: there is no
   * read route, deliberately.
   */
  async setRoomConsent(
    groupId: string,
    agentId: string,
    share: boolean,
  ): Promise<{ atCap: boolean; announced: boolean }> {
    // Duress, ABOVE the token check — exactly as sendText and
    // fanOutMembership branch before any token or wire touch. A decoy decision
    // must visibly SUCCEED while touching nothing real: no server edge, no
    // announcement, no wire. The local echo lands in the decoy workspace
    // (conn() already points there), so the surface reflects the choice like
    // every other decoy action, and nothing distinguishes it from a real one.
    // We do NOT lean on `this.token` being null here (start() throws in
    // duress): that invariant is the defense-in-depth the codebase refuses to
    // rely on, so the seam is explicit.
    if (session.mode === 'duress') {
      await db
        .setAgentConsent(agentId, share ? 'consented' : 'refused', Date.now())
        .catch(() => {});
      return { atCap: false, announced: true };
    }
    const gen = this.generation;
    const token = this.token;
    if (!token) throw new Error('messaging not started');
    // The group-visible announcement, best-effort in BOTH directions (see
    // the doc comment's matrix). For a hold, fanOutMembership itself narrows
    // the delivery audience to humans after keeping the normal room gates.
    let announced = false;
    const announce = async (): Promise<void> => {
      if (this.stale(gen)) return;
      try {
        const seq = await db.reserveGroupSeq(groupId, 'writer');
        if (this.stale(gen)) return;
        await this.fanOutMembership(groupId, {
          tcm: 'grp.consent',
          g: groupId,
          a: agentId,
          s: share ? 'share' : 'hold',
          n: seq,
        });
        if (this.stale(gen)) return;
        announced = true;
      } catch {
        announced = false;
      }
    };
    if (share) {
      // 1. The edge — the delivery-gating act, first. A throw propagates:
      //    the decision did not take, and nothing after may claim it did.
      await apiConsentWrite(token, agentId);
      if (this.stale(gen)) return { atCap: false, announced: false };
      // 2. This client's memory of its own act, after the uniform 204.
      try {
        await db.setAgentConsent(agentId, 'consented', Date.now());
      } catch {
        /* the edge stands; only this client's local record is poorer */
      }
      if (this.stale(gen)) return { atCap: false, announced: false };
      // 3. Announce — the leg to the agent rides the edge just written.
      await announce();
    } else {
      // 1. Revoke FIRST. Privacy does not wait for a courtesy frame; a throw
      //    leaves both local state and the room untouched.
      await apiConsentDelete(token, agentId);
      // The old-token DELETE may finish after a relock, but its continuation
      // must never write stance/sequence/outbox state into the newly active
      // workspace. It cannot be cancelled here; generation ownership makes
      // its successful partial outcome explicit instead.
      if (this.stale(gen)) return { atCap: false, announced: false };
      // 2. This client's memory of its own act, after the delete stood.
      try {
        await db.setAgentConsent(agentId, 'refused', Date.now());
      } catch {
        /* the edge fell; only this client's local record is poorer */
      }
      if (this.stale(gen)) return { atCap: false, announced: false };
      // 3. Tell the humans. No recognized agent gets a leg; the subject's next
      //    refused server frame is how it learns the edge is gone.
      await announce();
    }
    if (this.stale(gen)) return { atCap: false, announced: false };
    // 4. The cap surface, from local state ONLY — never the wire.
    let atCap = false;
    if (share) {
      try {
        atCap = (await db.countConsentedAgents()) > CONSENT_MAX_EDGES;
      } catch {
        atCap = false;
      }
    }
    return { atCap, announced };
  }

  /**
   * `grp.set` — apply-only announcement: the slot lands under the
   * UNCONDITIONAL policy (the timer stays every member's own safety lever —
   * the roster and the timer exercising both policy values is what keeps the seam honest), and a row is announced ONLY on 'applied' — 'stale'
   * announces nothing, so a replayed envelope cannot become a notice stream.
   */
  private async handleGroupSettings(
    frame: MsgFrame,
    envelope: Extract<GroupEnvelope, { tcm: 'grp.set' }>,
    text: string,
    gen: number,
    token: number,
  ): Promise<void> {
    const write: SettingsSlot = {
      writerId: frame.from,
      seq: envelope.n,
      disappearSec: envelope.s,
    };
    const result = await this.runGroupApply(async () => {
      if (this.stale(gen)) return null;
      const store = await db.loadGroupStore(envelope.g);
      const applied = applySettingsWrite(store, write, unconditionalPolicy);
      await store.persist();
      return { applied, present: store.isPresent() };
    });
    if (result === null || this.stale(gen)) return;
    const visible = result.applied === 'applied' && result.present;
    if (visible) {
      await db.insertMessage({
        msgId: frame.msgId,
        peerId: envelope.g,
        direction: 'in',
        body: text,
        ts: frame.ts,
        status: 'received',
        authorId: frame.from,
      });
      if (this.stale(gen)) return;
      await this.touchChatOrdered(
        envelope.g,
        frame.ts,
        async () => previewFor(text),
        token,
      );
      if (this.stale(gen)) return;
    }
    await this.ackInbound(frame.msgId);
    if (visible) this.notify();
  }

  /**
   * `grp.del` — delete-for-everyone, counted on ONE stable fact:
   * frame.from is the room's owner. Counted → the FULL purge (the anchor,
   * every slot, the counters, the conversation — and never the blocks),
   * rendering nothing because the room it would announce into is gone.
   * Non-owner → a declined, attributed row and no other effect. Unknown
   * room → nothing, deliberately: no tombstone store (the design weighs it).
   */
  private async handleGroupDel(
    frame: MsgFrame,
    envelope: Extract<GroupEnvelope, { tcm: 'grp.del' }>,
    text: string,
    gen: number,
    // grp.del is the one group handler with no chat-line write: a counted
    // purge deletes the conversation outright and a declined attempt only
    // inserts its attributed row. The dispatch token is accepted so the six
    // handlers keep one shape, and named as unused so lint holds the claim.
    _token: number,
  ): Promise<void> {
    const result = await this.runGroupApply(async () => {
      if (this.stale(gen)) return null;
      const store = await db.loadGroupStore(envelope.g);
      const presentBefore = store.isPresent();
      const applied = applyGroupDel(store, {
        writerId: frame.from,
        seq: envelope.n,
      });
      await store.persist();
      return { applied, presentBefore };
    });
    if (result === null || this.stale(gen)) return;
    const declinedVisibly =
      result.applied === 'declined' && result.presentBefore;
    if (declinedVisibly) {
      await db.insertMessage({
        msgId: frame.msgId,
        peerId: envelope.g,
        direction: 'in',
        body: text,
        ts: frame.ts,
        status: 'received',
        authorId: frame.from,
      });
      if (this.stale(gen)) return;
    }
    await this.ackInbound(frame.msgId);
    if (result.applied === 'purged' || declinedVisibly) this.notify();
  }

  /**
   * `grp.msg` — the unwrap. Establish that this phone shows the room
   * (recreating it iff my own fold says I am still a member
   * recreate-on-traffic rule, `deleteChat`'s precedent), classify the sender
   * against the fold, then feed the wrapped body to THE SAME content switch
   * a 1:1 frame runs (`applyContent`) with the room's context. The row key
   * is `${frame.from}.${m}`: deterministic on every phone, authorId
   * authenticated, so reactions/edits/retractions resolve to the same key
   * everywhere.
   */
  private async handleGroupMessage(
    frame: MsgFrame,
    envelope: Extract<GroupEnvelope, { tcm: 'grp.msg' }>,
    gen: number,
    token: number,
    spooled: boolean,
  ): Promise<void> {
    const selfId = this.selfUserId!;
    const room = await this.runGroupApply(async () => {
      if (this.stale(gen)) return null;
      const store = await db.loadGroupStore(envelope.g);
      if (store.getOwner() === undefined) {
        // A room this phone does not hold — never anchored, or ended by a
        // counted grp.del: decrypted and acked byte-identically (ratchet
        // health, the gate table), then discarded quietly.
        return { deliver: false as const };
      }
      noteRoomTraffic(store, selfId, ownerOnlyPolicy);
      await store.persist();
      if (!store.isPresent()) {
        // Locally deleted AND my own fold says I am out (left, then
        // deleted): straggler traffic recreates nothing.
        return { deliver: false as const };
      }
      const fold = foldRoster(store.getOwner()!, store.listSlots(), ownerOnlyPolicy);
      return {
        deliver: true as const,
        // A sender my fold says is OUT still renders — as a
        // visibly tagged, attributed row, never a member's bubble, never a
        // silent drop. Removal is not simultaneous: some of these are
        // honest words from someone who does not yet know, and silent
        // omission is itself the tell the design exists to prevent. A sender you
        // never want to hear again is what BLOCK is for, and blocked senders
        // were already dropped whole at the top of handleIncomingInner.
        outsider: verdictFor(fold, frame.from) !== 'in',
      };
    });
    if (room === null || this.stale(gen)) return;
    if (!room.deliver) {
      await this.ackInbound(frame.msgId);
      return;
    }
    const inner = parseEnvelope(envelope.b);
    if (
      inner &&
      (isCallTcm(inner.tcm) ||
        inner.tcm === 'timer' ||
        inner.tcm === 'vault' ||
        inner.tcm === 'profile' ||
        inner.tcm === 'read' ||
        isGroupTcm(inner.tcm))
    ) {
      // Not conversation. The pairwise settings kinds have room-native
      // counterparts (`grp.set`; the design turns receipts off) and applying one
      // here would bypass the room's own lattice with a two-party rule;
      // signalling never rides inside a room wrapper; and a nested `grp.*`
      // is the laundering refusal (the schema already refuses to parse
      // one, so that limb is belt-and-braces). Receiver-permissive: acked,
      // dropped quietly, no row.
      await this.ackInbound(frame.msgId);
      return;
    }
    // The room lane's Art. 50 claim, resolved ONCE for both writes below:
    // the WRAPPER's marker (group-envelope.ts) — discarded at persist,
    // so it must be read here — OR the inner envelope's own (the amended
    // The marker's other door: the compose funnel now marks an envelope-shaped `b`
    // inside as well, so the claim survives paths that relay only `b`).
    const aiClaim = envelope.ai === true || aiOriginOf(inner);
    // If someone relayed me this message as history and the author's own copy
    // has now arrived, the author wins: applyContent's INSERT OR IGNORE would
    // otherwise leave the relayer's unauthenticated account standing forever
    // in front of the real words. Upgrades provenance only, never the reverse
    // — and the first-hand copy's ai claim lands with it, raise-only,
    // or the author's own marked message would stay unbadged forever behind
    // the relayer's unmarked account.
    await db.supersedeRelayed(
      envelope.g,
      `${frame.from}.${envelope.m}`,
      envelope.b,
      frame.ts,
      aiClaim,
    );
    if (this.stale(gen)) return;
    await this.applyContent({
      gen,
      token,
      convId: envelope.g,
      senderId: frame.from,
      wireMsgId: frame.msgId,
      rowMsgId: `${frame.from}.${envelope.m}`,
      authorId: frame.from,
      ts: frame.ts,
      sq: envelope.sq ?? null,
      outsider: room.outsider,
      ai: aiClaim,
      text: envelope.b,
      envelope: inner,
      spooled,
    });
  }

  /**
   * THE ONE CONTENT SWITCH. Both inbound content paths end here: a
   * 1:1 frame with its own context, a room message with the room's. The
   * arms are the moved-not-copied bodies of the earlier inline branches;
   * every difference between the two callers is DATA in the context, plus
   * the two resolvers below — never a second copy of an arm. That absence
   * of duplication is load-bearing and tested by source scan: two copies of
   * a switch arm pass every test and then drift, and that exact failure has
   * shipped twice.
   */
  private async applyContent(ctx: ContentContext): Promise<void> {
    const { gen, envelope, text } = ctx;
    if (envelope?.tcm === 'x.edit') {
      // A relay-only intermediate arriving as a DURABLE send. The
      // 1:1 stored case never reaches here — the x.* namespace floor in
      // the inbound handler drops it first — so this arm is the ROOM-
      // WRAPPED case (`grp.msg` wrapping an x.edit body slips past that
      // floor and past the not-conversation drop, both of which predate
      // the kind). Acked and ignored whole: no messages row (a raw
      // carrier at rest — the same rule-4 defect the floor's comment
      // records), no overlay (the relay lane is the ONLY door — honoring
      // a durable copy would freeze a half-sentence on any phone that
      // fetches it hours later, the exact failure the 15s fade exists to
      // prevent), no preview, no unread, no notify. Seen-then-acked so
      // redelivery cannot retry what was refused on purpose.
            await this.noteSeen(ctx.wireMsgId);
      this.ws.send({ type: 'ack', msgId: ctx.wireMsgId });
      return;
    }
    if (envelope?.tcm === 'edit' || envelope?.tcm === 'del') {
      // Rewrites of a message that already exists: no row, no preview
      // bump, no unread. The conversation id scopes the change to THIS
      // conversation and direction 'in' to a message the sender authored —
      // together those are what stop a quoted msgId from reaching into
      // another thread or rewriting something I wrote.
      // The ts is relayed, not proven. It orders revisions against each
      // other, but a falsy or absurd value must never reach the columns the
      // UI reads as "was edited" / "was retracted" — ts:0 would erase both
      // marks while still applying the change. Clamped to at least 1, and
      // never further ahead than a generous clock-skew window.
      const stamp = reviseStamp(ctx.ts);
      const target = this.resolveRevisionTarget(ctx, envelope.ref);
      if (target === null) {
        // Room only — author laundering: a revision whose ref does
        // not name its own SENDER's message. Refused at the door: not
        // applied, and NOT HELD — parking it under any key is exactly how a
        // forgery got to suppress the genuine retraction. Acked, so the
        // forgery cannot redeliver either.
        await this.noteSeen(ctx.wireMsgId);
        this.ws.send({ type: 'ack', msgId: ctx.wireMsgId });
        return;
      }
      const applied =
        envelope.tcm === 'edit'
          ? await this.editRow(
              ctx.convId,
              target.msgId,
              target.direction,
              envelope.text,
              stamp,
              // The resolved claim: the edit envelope's own `ai` (1:1)
              // or the room wrapper's — the reviser is the authenticated
              // row author, and db.applyEdit raises, never clears.
              ctx.ai,
            )
          : await db.tombstoneMessage(
              ctx.convId,
              target.msgId,
              target.direction,
              stamp,
            );
      if (this.stale(gen)) return;
      if (!applied) {
        // The message being revised is not here yet — frames are handled
        // concurrently, so a carrier can overtake the prekey message it
        // revises. Park it BEFORE acking (the ack purges the server's copy,
        // so an unparked revision would be lost for good); the ordinary
        // message path applies it the moment the row lands. The writer is
        // the authenticated sender: one slot per writer, so nobody's parked
        // claim can occupy anybody else's.
        await db.holdRevision({
          peerId: ctx.convId,
          targetMsgId: target.msgId,
          targetDirection: target.direction,
          writerId: ctx.senderId,
          kind: envelope.tcm,
          text: envelope.tcm === 'edit' ? envelope.text : '',
          ts: stamp,
        });
        if (this.stale(gen)) return;
      }
      await this.refreshPreview(ctx.convId);
      await this.noteSeen(ctx.wireMsgId);
      this.ws.send({ type: 'ack', msgId: ctx.wireMsgId });
      this.notify();
      return;
    }
    if (envelope?.tcm === 'react') {
      // Reactions mutate an existing message instead of adding a row; the
      // seen-set (already checked above) dedupes redelivery. The target
      // resolver owns the two addressing modes: the 1:1 `ofs` claim, and
      // the room's derived-never-claimed direction plus the authenticated
      // reactor.
      const target = this.resolveReactionTarget(ctx, envelope.ref, envelope.ofs);
      if (target !== null) {
        await db.setReaction(
          target.msgId,
          target.direction,
          'in',
          envelope.emoji,
          ctx.ts,
          target.reactorId,
        );
      }
      await this.noteSeen(ctx.wireMsgId);
      this.ws.send({ type: 'ack', msgId: ctx.wireMsgId });
      this.notify();
      return;
    }
    // Persist BEFORE acking / marking seen: the ack purges the server queue
    // and markSeen suppresses redelivery, so a crash after either but before
    // the row is written would lose the message forever. Ordered
    // persist -> markSeen -> ack, a crash before markSeen just re-delivers
    // (re-decrypt throws on the advanced ratchet, the OR IGNORE error-row
    // insert is a no-op against the real row, and it is acked away).
    await db.insertMessage({
      msgId: ctx.rowMsgId,
      peerId: ctx.convId,
      direction: 'in',
      body: text,
      ts: ctx.ts,
      status: 'received',
      authorId: ctx.authorId,
      sq: ctx.sq,
      outsider: ctx.outsider ? 1 : null,
      // The Art. 50 arrival record: the claim the sealed
      // envelope carried, resolved by the caller. The badge reads THIS,
      // never the body, so a body that merely looks marked cannot badge.
      ai: ctx.ai ? 1 : null,
      // THE unread window. This is the one content switch, so every kind
      // that is conversation — 1:1 and room alike — gets it; membership
      // announcements do not (a roster change is an event, not a message).
      // The relayed-history insert stamps it too — arrival is arrival — and
      // `sharedBy` is what keeps those rows out of the unread count. Our
      // clock, never `ctx.ts`, which the sender chose.
      arrivedAt: Date.now(),
    });
    if (this.stale(gen)) return;
    // A revision may have arrived before the message it revises; applying it
    // here is what makes the two orders equivalent. Only the SENDER's own
    // slot is consulted — the row's author is the only writer whose parked
    // revision may touch it, which is the authorship check applied a
    // second time, at held-apply.
    const held = await db.takeHeldRevision(ctx.convId, ctx.rowMsgId, 'in', ctx.senderId);
    if (held) {
      if (held.kind === 'edit') {
        await this.editRow(ctx.convId, ctx.rowMsgId, 'in', held.text, held.ts);
      } else {
        await db.tombstoneMessage(ctx.convId, ctx.rowMsgId, 'in', held.ts);
      }
      await db.dropHeldRevision(ctx.rowMsgId, 'in', ctx.senderId);
      if (this.stale(gen)) return;
    }
    await db.upsertChat(ctx.convId);
    // WITH the resolver: this is the single seam all INBOUND conversation
    // content crosses. Its outbound twin is fanOut's preview default,
    // which resolves the same way for the one caller that hands it a bare
    // mention body (retrySend re-fanning a stored envelope). Every other
    // touchChat site carries a grp.*/notice body previewFor already
    // special-cases. Resolver-less, an inbound "@Ana lunch?" reached the
    // chat list as " lunch?" (the mentions contract). The name lookups run
    // INSIDE the chain entry: however long they suspend, no other frame's
    // line write interleaves, and the dispatch token settles who owns the
    // line if this frame was overtaken before it could queue.
    await this.touchChatOrdered(
      ctx.convId,
      ctx.ts,
      () => this.previewWithNames(text),
      ctx.token,
    );
    if (
      envelope?.tcm === 'image' ||
      envelope?.tcm === 'file' ||
      envelope?.tcm === 'voice'
    ) {
      // Durable 'pending' BEFORE markSeen/ack: once acked the server purges
      // the message, so the download intent must already be on disk —
      // reconcileLocalState resumes any 'pending' row after a crash. The
      // dimensions ride along so the placeholder reserves the photo's real
      // shape while it downloads (putAttachment COALESCEs, so a later write
      // can never be clobbered with nulls).
      await db.putAttachment(
        ctx.rowMsgId,
        'in',
        'pending',
        null,
        envelope.tcm === 'image' ? envelope.w : null,
        envelope.tcm === 'image' ? envelope.h : null,
      );
    }
    await this.noteSeen(ctx.wireMsgId);
    this.ws.send({ type: 'ack', msgId: ctx.wireMsgId });
    if (
      envelope?.tcm === 'image' ||
      envelope?.tcm === 'file' ||
      envelope?.tcm === 'voice'
    ) {
      // Gated on the SENDER, not the conversation: in a room the block that
      // must stop this fetch is the author's (a blob fetch is a read
      // receipt through a side channel), and a room id itself is never
      // blockable.
      this.queueAttachmentDownload(ctx.senderId, ctx.rowMsgId, 'in', envelope);
    }
    // THE BANNER. On a platform with no push, nothing
    // else announces a message that arrived while the app was away: the
    // socket delivered it into a process the person is not looking at, and
    // without this the phone stays silent until it is next opened.
    //
    // HERE, and not earlier: after the row is durably stored, after the ack —
    // a banner for a message the thread cannot show is a promise nobody can
    // keep. Fire-and-forget, because a notification must never fail a
    // delivery. And this is the ONE content switch, so a room message
    // and a 1:1 announce through the same line, with the room carried as
    // context exactly as every other difference between them is.
    //
    // What may be SAID is not decided here. The in-process handler applies the
    // shared-state gates — the previews-armed lease, the preview level, the
    // block mirror — exactly as the notification-service extension
    // applies them to a push on iOS, where this call is a no-op.
    void announceIncoming({
      from: ctx.senderId,
      msgId: ctx.wireMsgId,
      roomId: ctx.authorId === null ? null : ctx.convId,
      body: text,
    });
    // THE CHIME, the banner's exact complement: it
    // sounds only while the app is ACTIVE, where the banner and the push
    // are silent by policy, so no arrival is announced twice. Same line,
    // same contract — after persist and ack, fire-and-forget, never fails a
    // delivery — and the same ONE switch, so a room message and a 1:1 chime
    // through the same call. Every other gate (the preference, duress, the
    // spool, the reconnect backlog, the thread on screen, a call, the burst)
    // is decided in messageSound.ts, not here.
    //
    // One gate IS here, because only this class can see it: the generation.
    // Relock runs `stop()` (generation++, socket down) BEFORE the lock
    // screen paints, but a delivery whose persist completed a moment before
    // the stop still reaches this line — with `session.mode` still 'real',
    // since the lock is a route, not a mode. The last `stale` check above is
    // before the persist; re-asked here, the frame that straddled the relock
    // stores and acks (delivery is not the lock's to refuse) and stays
    // silent (a sound behind the lock would be the lock's new signal).
    if (!this.stale(gen)) {
      void chimeForArrival({ convId: ctx.convId, spooled: ctx.spooled });
    }
    this.notify();
  }

  /**
   * Where a revision's ref points. In a 1:1 the ref is the wire
   * msgId and the peer scope does the authorship work. In a room it is
   * `${authorId}.${m}`, and the author prefix must be THE SENDER's own id —
   * edit and del are author-only, resolved against frame.from and never a
   * payload field. null = refuse (room only).
   */
  private resolveRevisionTarget(
    ctx: ContentContext,
    ref: string,
  ): { msgId: string; direction: 'in' } | null {
    if (ctx.authorId === null) return { msgId: ref, direction: 'in' };
    const target = splitRoomRef(ref);
    if (target === null || target.authorId !== ctx.senderId) return null;
    // The sender revising their own message: on this phone that row is
    // always 'in' — an inbound frame's sender is never this device.
    return { msgId: ref, direction: 'in' };
  }

  /**
   * Where a reaction's ref points, and who reacted. 1:1: `ofs` is the
   * sender's authorship claim (what they authored is my 'in' row) and the
   * reactor is '' — the direction already names them. Room: the direction is
   * DERIVED from the ref's author prefix against this phone's own id, never
   * from `ofs` (a payload bit with no per-receiver meaning in a fan-out),
   * and the reactor is frame.from, authenticated — member M cannot sign
   * member C's tapback.
   */
  private resolveReactionTarget(
    ctx: ContentContext,
    ref: string,
    ofs: boolean,
  ): { msgId: string; direction: 'in' | 'out'; reactorId: string } | null {
    if (ctx.authorId === null) {
      return { msgId: ref, direction: ofs ? 'in' : 'out', reactorId: '' };
    }
    const target = splitRoomRef(ref);
    if (target === null) return null;
    return {
      msgId: ref,
      direction: target.authorId === this.selfUserId ? 'out' : 'in',
      reactorId: ctx.senderId,
    };
  }

  /** Does the current window still admit an automatic fetch? Rolls the
   * window over when it has expired. Consulted at queue time (so a refusal is
   * decided while the frame's context is at hand) and AGAIN inside the fetch
   * (the queue drains long after — the same async-continuation reasoning as
   * the block re-checks). */
  private autoFetchBudgetOk(): boolean {
    const now = Date.now();
    if (now - this.autoFetchWindow.startedAt >= AUTO_FETCH_WINDOW_MS) {
      this.autoFetchWindow = { startedAt: now, bytes: 0, count: 0 };
    }
    return (
      this.autoFetchWindow.bytes < AUTO_FETCH_BYTE_BUDGET &&
      this.autoFetchWindow.count < AUTO_FETCH_COUNT_BUDGET
    );
  }

  /** Charge one completed automatic fetch to the window. `bytes` is the
   * downloaded base64 ciphertext length — what actually crossed the network —
   * charged AFTER the fetch because the pointer does not carry a size, which
   * is why the last accepted blob can overshoot the budget by one blob. */
  private noteAutoFetched(bytes: number): void {
    this.autoFetchWindow.bytes += bytes;
    this.autoFetchWindow.count += 1;
  }

  /** The storage ceiling's gate: does TOTAL stored attachment payload still
   * admit an automatic fetch? Nothing rolls over here — unlike the window,
   * only the person freeing content moves this number down, measured at the
   * next session. null (not yet measured, or unmeasurable) reads as under —
   * the field owns that decision. Manual fetches never ask. */
  private autoStorageOk(): boolean {
    return (
      this.storedAttachmentBytes === null ||
      this.storedAttachmentBytes < AUTO_FETCH_STORAGE_CEILING
    );
  }

  /** Advance the ledger by what a fetch actually STORED (the plaintext
   * base64 written to the attachments table — not the wire ciphertext, which
   * is the window's currency). Charged for manual fetches too: the gate
   * binds only automatic ones, but the ledger measures storage, whoever grew
   * it. A blob that failed authentication stored nothing and charges
   * nothing. No charge while null — the measurement in flight will include
   * this write or miss it by one blob, which the next session trues up. */
  private noteStored(bytes: number): void {
    if (this.storedAttachmentBytes !== null) {
      this.storedAttachmentBytes += bytes;
    }
  }

  /** Enqueue a blob download, deduped by key, bounded in flight. Photos and
   * avatars share the bound — both buffer a whole blob in a JS string.
   *
   * Automatic jobs are additionally bounded by backlog depth and by the
   * window budget; a `manual` job (the user's own tap) is exempt from both.
   * Returns 'refused' so the attachment caller can mark the row visibly.
   * A key already queued reports 'queued' — the work exists either way. */
  private queueDownload(
    key: string,
    run: () => Promise<void>,
    manual = false,
  ): 'queued' | 'refused' {
    if (this.downloadKeys.has(key)) return 'queued';
    if (
      !manual &&
      (this.downloadQueue.length >= MAX_QUEUED_DOWNLOADS ||
        !this.autoFetchBudgetOk() ||
        !this.autoStorageOk())
    ) {
      return 'refused';
    }
    this.downloadKeys.add(key);
    this.downloadQueue.push({ key, run });
    this.pumpDownloads();
    return 'queued';
  }

  /** The visible half of a refusal — the row lands on 'failed', which the
   * thread renders as "tap to retry". Same generation discipline as every
   * other fire-and-forget write: a relock mid-write must not touch the next
   * workspace. */
  private markAttachmentUnfetched(msgId: string, direction: 'in' | 'out'): void {
    const gen = this.generation;
    void (async () => {
      if (this.stale(gen)) return;
      await db.putAttachment(msgId, direction, 'failed');
      if (!this.stale(gen)) this.notify();
    })().catch(() => undefined);
  }

  /**
   * REQUIREMENT 4, first of two gates. `peerId` is a parameter for this reason
   * alone — without it there is no way to know whose blob this is, and a fetch
   * IS A READ RECEIPT THROUGH A SIDE CHANNEL: it proves to anyone watching the
   * blob store that this phone received and parsed their message. The second
   * gate is inside fetchAttachment, because the queue drains long after.
   */
  private queueAttachmentDownload(
    peerId: string,
    msgId: string,
    direction: 'in' | 'out',
    envelope: ImageEnvelope | FileEnvelope | VoiceEnvelope,
    manual = false,
  ): void {
    // The block gate stays a SILENT return, deliberately: a blocked peer's
    // row is left 'pending' because a state change is a visible difference
    // (see fetchAttachment). The budget refusal below is the opposite —
    // visibly 'failed' — because it is this phone's own bound, not a secret.
    if (!mayFetchFor('attachment', this.blockStateFor(peerId))) return;
    const verdict = this.queueDownload(
      `msg:${msgId}:${direction}`,
      () => this.fetchAttachment(peerId, msgId, direction, envelope, manual),
      manual,
    );
    if (verdict === 'refused') this.markAttachmentUnfetched(msgId, direction);
  }

  /** Requirement 4 again: an avatar blob fetch is the same read receipt. */
  private queueAvatarDownload(
    peerId: string,
    att: string,
    key: string,
    version: number,
  ): void {
    if (!mayFetchFor('avatar', this.blockStateFor(peerId))) return;
    this.queueDownload(`avatar:${peerId}:${version}`, () =>
      this.fetchAvatar(peerId, att, key, version),
    );
  }

  private pumpDownloads(): void {
    while (
      this.activeDownloads < MAX_CONCURRENT_DOWNLOADS &&
      this.downloadQueue.length > 0
    ) {
      const job = this.downloadQueue.shift()!;
      this.activeDownloads++;
      void job
        .run()
        .catch(() => undefined) // a write refused post-relock is not a crash
        .finally(() => {
          this.activeDownloads--;
          this.downloadKeys.delete(job.key);
          this.pumpDownloads();
        });
    }
  }

  /** Download + decrypt a peer's avatar onto their chat row. */
  private async fetchAvatar(
    peerId: string,
    att: string,
    key: string,
    version: number,
  ): Promise<void> {
    if (!this.token) return;
    // Re-checked HERE, not only at queue time: pumpDownloads drains this queue
    // long after the frame was handled, so a block taken while the job waited
    // must still stop the first network call. Same async-continuation problem
    // the stale(gen) re-checks in this file exist for.
    if (!mayFetchFor('avatar', this.blockStateFor(peerId))) return;
    // Avatars are always automatic and share the window — a hostile
    // profile card per version is the photo flood in different clothes. A
    // refusal simply skips; the peer's next card re-offers the blob. (The
    // shared queue-time gate already refuses a spent window; this is the
    // run-time re-check, for jobs that were queued while it was open.)
    // The storage ceiling holds here too — a device at its cap pulls no blob
    // of any kind on its own. Avatars DO feed the ledger they are gated by:
    // they land one-per-peer on the chat row, but "one per peer"
    // is no bound when accounts are free, so their bytes are charged to the
    // same ceiling as attachments — by the REPLACEMENT delta below, so an
    // overwrite of the same face never double-charges.
    if (!this.autoFetchBudgetOk() || !this.autoStorageOk()) return;
    const gen = this.generation;
    try {
      const { downloadUrl } = await apiGetAttachmentUrl(this.token, att);
      const blobB64 = await downloadBlob(downloadUrl);
      this.noteAutoFetched(blobB64.length);
      const avatarB64 = await blobDecrypt(key, blobB64);
      if (this.stale(gen)) return;
      // setPeerAvatar returns the net bytes the write added (new − old, or 0
      // when the version gate refused it); the ledger advances by exactly
      // that, after the write lands, matching the attachment path.
      const delta = await db.setPeerAvatar(peerId, avatarB64, version);
      this.noteStored(delta);
      this.notify();
    } catch {
      // No avatar this round; the peer's next card re-offers it.
    }
  }

  /** Download + decrypt an image blob into the attachments table. */
  private async fetchAttachment(
    peerId: string,
    msgId: string,
    direction: 'in' | 'out',
    envelope: ImageEnvelope | FileEnvelope | VoiceEnvelope,
    manual = false,
  ): Promise<void> {
    if (!this.token) return;
    // The second requirement-4 gate, before the first network call and before
    // any row is written.
    //
    // ACCEPTED RESIDUAL: a photo from BEFORE the block that never finished
    // downloading stays undownloaded while the block stands, and its row is
    // deliberately left 'pending' rather than moved to 'failed' — a state
    // change is a visible difference. unblockPeer re-runs
    // reconcileLocalState, which resumes it.
    if (!mayFetchFor('attachment', this.blockStateFor(peerId))) return;
    // The second budget gate: the queue drains long after the frame that
    // filled it, and the window can exhaust between queue time and run time —
    // a job admitted while the budget was open must re-ask before its first
    // network call, exactly as the block gate above re-asks. Refusal is the
    // same visible 'failed'. The storage ceiling re-asks here too, and this
    // is also where it FIRST binds for the fetches racing the session's one
    // ledger measurement (the field's null window).
    if (!manual && (!this.autoFetchBudgetOk() || !this.autoStorageOk())) {
      this.markAttachmentUnfetched(msgId, direction);
      return;
    }
    const gen = this.generation;
    // Dimensions from the pointer, so a placeholder is the photo's shape rather
    // than a guess (COALESCEd, so a retry can't null out what already landed).
    await db.putAttachment(
      msgId,
      direction,
      'pending',
      null,
      envelope.tcm === 'image' ? envelope.w : null,
      envelope.tcm === 'image' ? envelope.h : null,
    );
    this.notify();
    try {
      const { downloadUrl } = await apiGetAttachmentUrl(
        this.token,
        envelope.att,
      );
      const blobB64 = await downloadBlob(downloadUrl);
      // Charged as soon as the bytes exist — before the decrypt, because
      // a blob that fails authentication below still crossed the network.
      if (!manual) this.noteAutoFetched(blobB64.length);
      // GCM decrypt authenticates: a swapped or corrupted blob throws here
      // and the row lands on 'failed' — nothing unauthenticated is rendered.
      const imageB64 = await blobDecrypt(envelope.key, blobB64);
      // A relock crossed this download: drop the plaintext on the floor —
      // the pending row re-queues it on the next real session's reconcile.
      if (this.stale(gen)) return;
      await db.putAttachment(
        msgId,
        direction,
        'ready',
        imageB64,
        envelope.tcm === 'image' ? envelope.w : null,
        envelope.tcm === 'image' ? envelope.h : null,
      );
      // The ledger advances by what landed on disk, after it landed.
      this.noteStored(imageB64.length);
    } catch {
      if (this.stale(gen)) return;
      await db.putAttachment(msgId, direction, 'failed');
    }
    this.notify();
  }

  /**
   * UI hook: re-attempt a failed or stuck image download.
   *
   * The peer is looked up from the row rather than taken as an argument
   * because PhotoViewerScreen is one of the callers and the gate has to hold
   * there too — a "Try again" tap must not become a fetch that tells a blocked
   * person this phone is still reading them. The lookup is a local SQLite
   * read; no row means nothing to retry.
   */
  async retryAttachment(
    msgId: string,
    direction: 'in' | 'out',
    body: string,
  ): Promise<void> {
    const envelope = parseEnvelope(body);
    if (
      envelope?.tcm !== 'image' &&
      envelope?.tcm !== 'file' &&
      envelope?.tcm !== 'voice'
    ) {
      return;
    }
    const row = await db.getMessage(msgId, direction);
    if (!row) return;
    // The author where there is one — same argument as the boot-time fetch:
    // a room row's peerId is the room, and the gate must see the SENDER.
    // MANUAL: a tap on "try again" is the person's own consent, so it is
    // exempt from the auto-fetch budget and the backlog cap — the block gate
    // above is the one refusal that still applies.
    this.queueAttachmentDownload(
      row.authorId ?? row.peerId,
      msgId,
      direction,
      envelope,
      true,
    );
  }

  /**
   * Boot-time crash recovery. The durable records are the message rows; this
   * replays whatever side effects an interruption may have dropped:
   * - image rows with a missing or still-'pending' attachment re-download
   *   (works for my own sends too — the blob decrypts with the envelope key);
   * - my reaction carrier rows re-apply their chip (idempotent, ts-guarded);
   * - my vault writes re-apply their item (idempotent, version-guarded).
   */
  private async reconcileLocalState(): Promise<void> {
    const gen = this.generation;
    try {
      for (const chat of await db.listChats()) {
        if (this.stale(gen)) return;
        // Boot-time is the sneakiest fetch of all: a photo pointer from before
        // the block would otherwise hit the blob store on every single launch,
        // once per relaunch, forever. The local replays below (my own
        // reactions, edits and retractions) may continue — they touch nothing
        // but this phone.
        const cblock = this.blockStateFor(chat.peerId);
        const mayFetch = mayFetchFor('attachment', cblock);
        // META, never the bytes: only `.state` is read below, and
        // `listAttachments` SELECTs every blob's base64 plaintext — at the
        // 4 GiB storage ceiling that was every photo in every chat
        // materialised as JS strings on every unlock, an OOM at boot for a
        // large history.
        const attachments = new Map(
          (await db.listAttachmentMeta(chat.peerId)).map(a => [
            `${a.msgId}:${a.direction}`,
            a,
          ]),
        );
        for (const row of await db.listMessages(chat.peerId)) {
          if (this.stale(gen)) return;
          if (row.status === 'error') continue;
          const envelope = parseEnvelope(row.body);
          if (
            envelope?.tcm === 'image' ||
            envelope?.tcm === 'file' ||
            envelope?.tcm === 'voice'
          ) {
            if (!mayFetch) continue;
            const existing = attachments.get(`${row.msgId}:${row.direction}`);
            if (!existing || existing.state === 'pending') {
              // The AUTHOR where there is one (a room row): the block that
              // must stop this boot-time fetch is the sender's, and a room
              // id itself is never blockable — gating on chat.peerId alone
              // would re-fetch a blocked member's photo on every launch
              // (a blob fetch is a read receipt through a side
              // channel).
              this.queueAttachmentDownload(
                row.authorId ?? chat.peerId,
                row.msgId,
                row.direction,
                envelope,
              );
            }
          } else if (envelope?.tcm === 'react' && row.direction === 'out') {
            await db.setReaction(
              envelope.ref,
              envelope.ofs ? 'out' : 'in',
              'out',
              envelope.emoji,
              row.ts,
            );
          } else if (envelope?.tcm === 'edit' && row.direction === 'out') {
            // Both guards make this idempotent: the editedAt comparison is
            // strict, and a tombstone refuses edits outright.
            await db.applyEdit(
              chat.peerId,
              envelope.ref,
              'out',
              envelope.text,
              row.ts,
            );
          } else if (envelope?.tcm === 'del' && row.direction === 'out') {
            await db.tombstoneMessage(chat.peerId, envelope.ref, 'out', row.ts);
          } else if (envelope?.tcm === 'vault' && row.direction === 'out') {
            // My own vault write, whose content is committed from onEnqueued
            // and can therefore be lost to a crash between the outbox commit
            // and the write — the same window react/edit/del have, replayed the
            // same way.
            //
            // Committed rather than merged, because this is MY slot and the
            // frame already carries the number that was reserved for it. That
            // makes the replay exactly idempotent: it rewrites the same bytes
            // at the same number, and if a later save has since taken a higher
            // number the commit's `seq = ?` guard makes it a no-op instead of
            // resurrecting superseded content. THE THREAD ROW IS THE VAULT'S
            // WRITE-AHEAD LOG — the only durable second copy there is, now that
            // the ack destroys the server's.
            if (this.selfUserId) {
              await db.commitVaultSlot({
                peerId: chat.peerId,
                id: envelope.id,
                writerId: this.selfUserId,
                seq: envelope.n,
                ackSeq: envelope.k,
                title: envelope.title ?? '',
                body: envelope.body ?? '',
                updatedAt: row.ts,
                deleted: envelope.op === 'del' ? 1 : 0,
              });
            }
          }
        }
      }
      // Revisions parked because their target had not arrived, or stranded
      // mid-apply by a crash or a relock: retry any whose row exists now.
      for (const held of await db.listHeldRevisions()) {
        if (this.stale(gen)) return;
        const applied =
          held.kind === 'edit'
            ? await this.editRow(
                held.peerId,
                held.targetMsgId,
                held.targetDirection,
                held.text,
                held.ts,
              )
            : await db.tombstoneMessage(
                held.peerId,
                held.targetMsgId,
                held.targetDirection,
                held.ts,
              );
        if (applied) {
          await db.dropHeldRevision(
            held.targetMsgId,
            held.targetDirection,
            held.writerId,
          );
          await this.refreshPreview(held.peerId);
        }
      }
      // Anyone who missed my latest card gets it now (a send that failed
      // while offline, or a chat started before I filled my profile in).
      await this.broadcastProfile();
    } catch {
      // Best-effort: a failed pass re-runs on the next start().
    }
    this.notify();
  }

  private async handleReceipt(
    msgId: string,
    state: 'sent' | 'delivered',
  ): Promise<void> {
    const gen = this.generation;
    await db.applyReceipt(msgId, state);
    if (this.stale(gen)) return;
    await db.deleteOutboxEnvelope(msgId);
    this.inflight.delete(msgId);
    this.notify();
  }
}

export const messaging = new MessagingService();
