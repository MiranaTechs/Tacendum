import { open, type DB, type QueryResult, type Scalar } from '@op-engineering/op-sqlite';
import {
  AiWorkCapabilitiesSchema,
  AiWorkContextSchema,
  AiWorkMetadataSchema,
  AiWorkUsageSchema,
  CallMetricReport,
  displayAiWorkTimestamp,
  type AiWorkCapabilities,
  type AiWorkContext,
  type AiWorkMetadata,
  type AiWorkUsage,
  type CallEndReason,
  type DeviceClass,
} from '@tacendum/shared';
import { prepareDatabaseDirectory } from 'tacendum-crypto';
import {
  DELETED_PREVIEW,
  PREVIEW_SCAN,
  isCarrierEnvelope,
  mentionWho,
  previewFor,
} from './envelope';
import {
  AI_SAVED_TASK_MAX,
  normalizeAiTaskTemplate,
} from './aiTasks';
import { publishGroupNames, publishPeerNames } from './nse';
import { personName } from './person';

/**
 * Plain SQLite (no SQLCipher: at-rest protection is iOS Data
 * Protection, not app-side crypto). Holds chat/message history, the profile,
 * and the msgId dedupe set. Protocol/key state never touches this file — it
 * lives in the native module's stores.
 */

/**
 * Me, as this device knows me.
 *
 * `phone` is GONE: there is no phone number in the
 * account model any more, so there is nothing to store. See `saveProfile` for
 * what becomes of the number an older install already wrote.
 */
export interface ProfileRow {
  userId: string;
  registrationId: number;
  /** How I appear to the people I talk to (shared peer-to-peer, never stored
   * server-side). Empty string = unset; the UI falls back to the userId. */
  displayName: string;
  about: string;
  /** base64 JPEG of my avatar, or '' for none. */
  avatarB64: string;
  /** Monotonic version stamped on every profile card I send. */
  profileVersion: number;
}

/**
 * HOW a conversation came to exist on this phone:
 * the other person handed over a QR, the id was typed by hand, or a
 * server-side discovery lookup resolved them. Local only — never on any wire.
 *
 * DELIBERATELY AN OPEN TAXONOMY, like `kind`: plain TEXT, no CHECK, no
 * exhaustive switch, so a third discovery class is an additive literal
 * here rather than a schema rebuild. The discovery family is a PREFIX —
 * `discovery` bare, or `discovery-<class>` — and `serverIntroduced` reads
 * the family, so a new discovery class earns the reminder by its name alone.
 * NULL is a row that predates the column, and it reads as NOT
 * server-introduced: an existing install wakes up with every chat
 * unbannered, because nothing on disk says the server introduced it.
 */
export type IntroducedBy = 'qr' | 'manual' | 'discovery' | 'discovery-username';

/** The username class's provenance mark: a chat
 * that began by typing someone's name into the server's lookup. The
 * `discovery-` prefix is what `serverIntroduced` reads, so the banner
 * already covers it; the value is spelled HERE and nowhere else in app/src
 * (the kind-spelling rule — everything else imports the constant). */
export const DISCOVERY_USERNAME_INTRODUCED: IntroducedBy = 'discovery-username';

/**
 * Did the SERVER make this introduction? The ONE predicate the thread's
 * reminder asks. A hand-off, a typed id, and a row that predates provenance
 * all answer no — the reminder is about who vouched for the account, and
 * none of those was the server.
 */
export function serverIntroduced(kind: string | null | undefined): boolean {
  return kind === 'discovery' || (kind != null && kind.startsWith('discovery-'));
}

export interface ChatRow {
  peerId: string;
  displayName: string | null;
  lastMessageAt: number | null;
  lastMessageText: string | null;
  /** Peer's shared profile (their card, applied newest-version-wins). */
  about: string | null;
  avatarB64: string | null;
  profileVersion: number | null;
  /** When this device last confirmed the safety number matched (local only). */
  safetyCheckedAt: number | null;
  /** The name I gave this person on this device. Never sent, never shared —
   * it outranks their card because it is my list, not theirs. */
  localName: string | null;
  /** When this conversation first appeared here, so a chat with no messages
   * yet still has a place in the list instead of sorting to the bottom. */
  createdAt: number | null;
  /** Last time I opened this thread, measured against `seen.ts` to derive
   * what is new. This device's clock only. */
  lastOpenedAt: number | null;
  /** Agreed disappearing-message timer in seconds; 0/null = off. Shared with
   * the peer, newest setting wins. */
  disappearSec?: number | null;
  /** Version that set the timer, so a late frame cannot undo a newer one. */
  disappearVersion?: number | null;
  /** When an identity change was recorded for this peer (local only). */
  identityChangedAt: number | null;
  /** When a safety-number comparison FAILED on this device. The counterpart
   * to safetyCheckedAt: without it there is nowhere to record the bad
   * outcome, and the honest answer looks identical to never having looked. */
  safetyMismatchAt: number | null;
  /** Who introduced this person here (see `IntroducedBy`). NULL/absent on
   * rows that predate the column and on chats an inbound message opened —
   * neither is a server introduction. Local only. */
  introducedBy?: IntroducedBy | null;
  /** When this conversation was pinned to the top, or null when it is not.
   * A moment, not a flag: pinned rows sort newest-pin-first among themselves.
   * Local only, and absent on rows that predate the column. */
  pinnedAt?: number | null;
}

export type MessageStatus =
  | 'pending'
  | 'sent'
  | 'delivered'
  /** The peer's read receipt landed (`markRead`) — the filled second tick.
   * Written since read receipts shipped; named here so the thread need
   * not cast for it. */
  | 'read'
  | 'received'
  | 'error';

export interface MessageRow {
  msgId: string;
  peerId: string;
  direction: 'in' | 'out';
  body: string;
  ts: number;
  status: MessageStatus;
  /** When this row stops existing (epoch ms); null when it keeps. */
  expiresAt?: number | null;
  /** When the author last rewrote this message; null when never edited. */
  editedAt?: number | null;
  /** When the author retracted it; null while it still stands. A retracted
   * row keeps its place with an empty body — see tombstoneMessage. */
  deletedAt?: number | null;
  /** WHO wrote this row, when `peerId` names a room:
   * `frame.from`, authenticated — never a payload field. NULL in a 1:1,
   * where the author is `peerId` or me and the direction says which. */
  authorId?: string | null;
  /** The author's own per-room counter; NULL in a 1:1 and on rows
   * that predate it — both sort as 0, the order those rows already have. */
  sq?: number | null;
  /** 1 when this room row's sender was OUT of the room by this phone's fold
   * AT ARRIVAL: the row renders as a visibly
   * tagged, attributed row — "Ben isn't in this room" — never blended in as
   * a member's bubble and never silently dropped. Recorded at arrival
   * because that is the honest claim: the roster may change later, and a
   * later re-add must not retroactively untag what arrived from outside. */
  outsider?: number | null;
  /** WHO relayed this row to me, when it did not arrive first-hand: the id of the member whose ratchet
   * carried it. NULL on everything I witnessed myself. A row with this
   * set is that person's ACCOUNT of a message, never an authenticated one. */
  sharedBy?: string | null;
  /** 1 when the sealed envelope CLAIMED AI origin at arrival — the room wrapper's `ai` or the inner kind's, recorded at
   * the door like `outsider`. Sender-claimed and relay-invisible, never
   * proof; the badge derives from THIS or the machine_peers record. NULL on
   * human rows and rows that predate the column. */
  ai?: number | null;
  /**
   * When THIS PHONE received the row, by its OWN clock — the unread window.
   *
   * Deliberately not `ts`: that is the sender's clock, and a peer who set it
   * to last year would never appear unread while one who set it to next year
   * would appear unread forever. An unread badge keyed on a number the sender
   * chooses is a badge the sender controls.
   *
   * Set where a row is CONVERSATION: the inbound content insert and the
   * relayed-history insert both stamp it — arrival is arrival, whoever
   * carried it. What keeps 200 catch-up messages from being 200 unread ones
   * is `sharedBy`, which the unread queries exclude, never a missing clock.
   * Membership announcements stay NULL: a roster change is an event, not a
   * message.
   */
  arrivedAt?: number | null;
}

/**
 * Workspace selection. The decoy workspace is a second file
 * with the identical schema, rendered by the identical screens — selected
 * once at unlock time. Switching requires a closed connection: the
 * caller must have stopped messaging and closed the db first, so a late
 * async write can never land in the wrong world.
 */
export type Workspace = 'real' | 'decoy';

const WORKSPACE_FILES: Record<Workspace, string> = {
  real: 'tacendum.sqlite',
  decoy: 'tacendum-decoy.sqlite',
};

let workspace: Workspace = 'real';
let db: OwnedHandle | null = null;
/**
 * WHICH FILE `db` IS ACTUALLY ON — which is not always the file the module has
 * since decided it wants.
 *
 * `beginUnlock` declares a verdict, but `conn()` used to consult that
 * declaration only on its lazy-open branch (`if (!db)`), and the thing that
 * makes the handle non-null before any verdict is THE PRE-VERDICT DOOR ITSELF.
 * The feature's own scenario is that ordering: the phone rings, the press
 * happens, and the coerced passcode is typed second ("handing a ringing phone
 * to someone and telling them to unlock it is the entire setup", below). So on
 * every duress unlock that followed a lock-screen press the declaration was a
 * NO-OP — the whole arm above `close()` still pointed at `tacendum.sqlite`, a
 * second press read the last group call's roster and the profile row out of it
 * and DELETEd its offer rows, and the real workspace was written while
 * somebody was standing over the phone.
 *
 * Null when no handle is open, in which case it says nothing and is not read.
 */
let openWorkspace: Workspace | null = null;
/**
 * Cleared ONLY by initDb(), set by close() — and, crucially, TRUE from the
 * moment this module is evaluated. While latched, conn() throws instead of
 * lazily opening or re-opening, so a stale callback firing behind the lock
 * screen can never resurrect a connection the relock just closed.
 *
 * IT USED TO INITIALIZE TO FALSE, AND THAT WAS THE BUG. Latched-by-close
 * alone protects the RELOCK arm and leaves the COLD-START arm wide open: a
 * fresh process satisfied neither guard in conn(), and `workspace` defaults to
 * 'real', so the first db call from anywhere LAZILY OPENED `tacendum.sqlite`.
 * The call module's mount-time startup did exactly that from a React effect
 * that runs before the lock verdict is read — the real workspace opened and
 * took three writes behind the lock screen, and on a duress unlock it opened
 * BEFORE the decoy. A partial mirror in the plainest form: one arm of a
 * deliberate twin protected, the other not.
 *
 * Initializing to true makes a launched process indistinguishable from a
 * relocked one, which is the invariant the quiesce rule actually states: no
 * workspace opens until something DECIDES to open one. Code that uses this
 * module without deciding now gets a loud "database is closed" instead of a
 * silently-opened real workspace.
 *
 * TWO THINGS CAN DECIDE, and the second one is not a leak but a hole this
 * file states out loud rather than hides:
 *
 *  1. initDb(), whose only production callers are App.tsx's two unlock arms,
 *     both strictly after the verdict.
 *  2. conn('servicing-a-callkit-answer') — the narrow door below, opened by a
 *     CallKit answer that is ALREADY IN FLIGHT when the process starts.
 *
 * (openDecoyConnection() is a third opener and consults nothing here at all;
 * see the note there for why that is correct and what it does and does not
 * promise. An earlier version of this comment claimed "no pre-verdict path
 * can open either file no matter what future code calls", which was false on
 * both counts the day it was written.)
 */
let closedLatch = true;

/**
 * THE VERDICT, KNOWN TO THE DOOR BEFORE THE UNLOCK'S FIRST AWAIT.
 *
 * `workspace` cannot carry this, because `setWorkspace` legitimately refuses
 * while a handle is open and both unlock arms have fallible work to do before
 * they are in a position to close one. So the arms declare their answer here,
 * synchronously, at the top — and `conn()`'s lazy open follows the DECLARED
 * workspace rather than the stale one.
 *
 * WHAT IT FIXES, AND IT IS NOT A RACE. The duress arm used to run
 * `db.close(); await refreshDecoyTimestamps(); db.setWorkspace('decoy')`.
 * Throughout that await — a SELECT and, on a populated decoy, six UPDATEs —
 * the module sat at `closedLatch === true, db === null, workspace === 'real'`,
 * and the pre-verdict door below is by design not stopped by the latch. So a
 * lock-screen press landing in that window opened `tacendum.sqlite` while
 * somebody was standing over the phone, read the last small-group call's
 * roster out of it, DELETEd its offer rows — and left a handle open, which
 * made the `setWorkspace('decoy')` that followed throw and dropped the whole
 * arm into its catch: the coerced person got "Get started" instead of the
 * decoy, and the arm's own defences below that line never ran. Handing a
 * ringing phone to someone and telling them to unlock it is the entire setup;
 * the two overlap by construction.
 *
 * Cleared by `initDb()`, which is the moment `workspace` itself holds the
 * answer, and by `relockWorkspace()`, which is the moment the verdict is spent
 * — whether it was spent by a relock or by an arm that died before it could
 * honour it. Deliberately NOT cleared by `close()`: `close()` runs INSIDE the
 * arms, between the declaration and the switch, and clearing it there would
 * reopen the window this exists to shut.
 *
 * WHAT AN UNLOCK THAT DIES LEAVES BEHIND — corrected, because the previous
 * sentence here was the justification for a defect. It used to read: an unlock
 * that dies before `initDb()` leaves this set, "the safe direction, and the
 * only honest one until the app relocks". Safe in one direction only. It is a
 * duress arm that has fallible work to do before the switch, so the leftover
 * this described was always 'decoy' — pointing the door at the EMPTY decoy in
 * a process with no session, no coordinator and a landing screen, for as long
 * as it took somebody to background the app. Every lock-screen answer in that
 * window was released as `failed_media`: a discarded answer, no race required,
 * defended by this comment. The arm's catch now spends the declaration where
 * the attempt ends (`relockWorkspace`), so nothing "until the app relocks"
 * survives.
 */
let pendingWorkspace: Workspace | null = null;

/**
 * Declare which world an unlock has just decided on.
 *
 * Called from the FIRST synchronous line of each unlock arm — before
 * `session.setMode`'s effects, before any await — and from both arms, because
 * a declaration on one arm only is the partial mirror this whole area keeps
 * producing. On the real arm it names the workspace the door already defaults
 * to and changes nothing; that is the point of stating it anyway.
 */
export function beginUnlock(next: Workspace): void {
  pendingWorkspace = next;
}

/**
 * The verdict is spent: put the door back where a COLD PROCESS finds it.
 *
 * THE DECLARATION CANNOT REACH THE LOCKED-IDLE WINDOW, AND THAT WINDOW IS THE
 * DOOR'S WHOLE PREMISE. Answering a call from the lock screen does not unlock
 * the phone, so the state a lock-screen press is serviced in is normally one
 * with NO unlock in flight — nothing to have declared anything. Between
 * sessions the only thing pointing the door was `workspace`, which a duress
 * session leaves reading 'decoy' and which `relock()` did not touch; autolock
 * defaults to 0 s, so every backgrounding after a coerced unlock left the
 * module there. A real incoming call answered from the lock screen in that
 * state was looked up in the EMPTY DECOY: `restoreLocked` found no row and
 * released the CXCall as `failed_media`, and the 1:1 path found no offer and
 * did the same. THE TAPPED ANSWER WAS DISCARDED — a denial of ring reached
 * without any race, by the ordinary use of the feature.
 *
 * 'real' IS THE ANSWER, for the reason the gate comment on `conn` already
 * gives: the VoIP push that rang this phone was addressed to the real account.
 * A pointer only a successful unlock could correct was the bug; this makes a
 * relocked process indistinguishable from a launched one for the workspace
 * exactly as `closedLatch` starting true does for the connection.
 *
 * `pendingWorkspace` goes with it, and that is not tidiness: an unlock that
 * DIED leaves its declaration set on purpose (see the note there), so without
 * this line a failed duress attempt pointed the door at the decoy for the whole
 * of the next locked window — the same denial of ring by the other route.
 *
 * CALLED AFTER `close()` AND NOT BEFORE IT. Everything relock does above the
 * close still belongs to the session that is ending — `endCallOnQuiesce` lands
 * a call-log row, `messaging.stop()` drains — and re-homing those writes into
 * the real workspace is precisely the disclosure this module exists to stop. A
 * press landing in that (awaited) window reaches the ending session's own
 * world, which is where it has always reached and is the safe direction.
 *
 * THE SECOND CALLER IS AN UNLOCK THAT DIED, AND IT IS NOT A RELOCK — it is the
 * same fact. A duress arm that throws (`enterDecoyWorkspace`'s catch) has no
 * session: it lands the phone on "Get started" with nothing opened, no
 * messaging, no coordinator. Yet it left `pendingWorkspace === 'decoy'`, and
 * `relock()` was the only thing that cleared it while `mustRelock` needs a
 * background→foreground cycle — so between a failed coercion and the next
 * foregrounding, EVERY lock-screen answer resolved the empty decoy and was
 * released as `failed_media`. That is the identical denial of ring this
 * function was written to end, reached by the other leftover, and no unlock is
 * in flight in that window either. A verdict that could not be honoured is
 * spent exactly as one that has been.
 *
 * AND THE LATCH GOES WITH THEM, which is this function's own sentence taken
 * literally: a COLD PROCESS finds `closedLatch === true`. From `relock()` it
 * changes nothing (`close()` sets it one line earlier). From the dead arm it is
 * load-bearing: that arm can die AFTER `initDb()` unlatched, with a handle open
 * on the decoy — and moving `workspace` back to 'real' underneath an unlatched
 * module would let the next ordinary `conn('verdict')` caller (the landing
 * screen's "Get started", say) re-home that handle onto `tacendum.sqlite` and
 * WRITE it, on a phone somebody is standing over. Latched, only the door can
 * open anything, which is the state every other locked window is already in.
 *
 * NOT CLOSING THE HANDLE HERE IS DELIBERATE — for a reason that had to be
 * REPLACED, because the one written here was refuted by its own premise. It
 * said: `close()` cuts a statement in flight, and the statements in flight
 * here are a lock-screen press's, so `conn()` drops the handle instead. But
 * `conn()`'s drop WAS `stale.close()` — the identical call, the identical
 * `sqlite3_interrupt`, on the identical statement. Nothing was avoided; the
 * cut was merely charged to the next press instead of to this function, which
 * made it harder to see and no less fatal. The paragraph was the justification
 * for a defect, exactly as the one on `pendingWorkspace` had been a round
 * earlier.
 *
 * The cut is now impossible from either closer (`doorStatementsRunning`), so
 * what is left is the honest reason to leave the handle alone: this function
 * takes no view on connections. It spends a verdict. The handle belongs to
 * whoever opened it, `conn()` re-homes it the moment anyone asks for a
 * workspace it is not on, the latch above means only the door may ask, and the
 * next unlock arm's own `close()` reaches it in any case.
 */
export function relockWorkspace(): void {
  closedLatch = true;
  workspace = 'real';
  pendingWorkspace = null;
}

export function setWorkspace(next: Workspace): void {
  if (db) {
    throw new Error('close the database before switching workspace');
  }
  workspace = next;
}

export function activeWorkspace(): Workspace {
  return workspace;
}

/**
 * WHICH FILE THIS MODULE IS POINTED AT RIGHT NOW — one expression, because two
 * copies of it is precisely the partial mirror this area keeps producing.
 *
 * `conn()` asks it to decide which workspace to open and whether an already-open
 * handle is on the wrong one; `close()` asks it to decide whether the handle it
 * is about to release has been moved off by a verdict, and must therefore be
 * REVOKED rather than merely drained. Those are the same question, and a
 * release that answered it differently from the open beside it would be a
 * handle bound by one closer and not the other.
 */
function targetWorkspace(): Workspace {
  return pendingWorkspace ?? workspace;
}

/**
 * Drain the transaction chain, then release the handle and latch.
 *
 * RELEASED RATHER THAN CLOSED OUTRIGHT, and the difference is a ring. This is
 * the close inside `enterDecoyWorkspace`, and the statements it can be running
 * on top of are a lock-screen press's — somebody typing the duress passcode on
 * a phone that is ringing is the feature's own scenario, not a race anyone has
 * to construct. See `doorStatementsRunning`: the `close()` itself waits for a
 * statement already in the pool rather than interrupting it.
 *
 * A HANDLE THE POINTER HAS MOVED OFF IS REVOKED ON THIS FUNCTION'S FIRST
 * SYNCHRONOUS LINES — BEFORE THE DRAIN, WHICH IS THE WHOLE OF IT. Dropping it
 * from `db` binds only the next caller to ASK; the eighteen callers holding
 * this very object across an await — NINE of them mid-`BEGIN
 * IMMEDIATE`…`COMMIT` — would keep writing the file the verdict just declared
 * off-limits. Revoked, they get a rejected promise, which is what they got
 * when this line was an outright close.
 *
 * AND REVOKING AFTER `await txChain` IS THE SAME DEFECT WEARING THE FIX'S
 * CLOTHES, which is how it shipped for a round. The drain runs every
 * `runExclusive` transaction that is RUNNING **or merely QUEUED** at the
 * verdict, on the live handle, and this function is the thing that waits for
 * it. A queued one had issued NOTHING when the passcode was typed — so its
 * `BEGIN IMMEDIATE`, its rows and its `COMMIT` were all new after the verdict,
 * with the `-journal` minted and removed beside `tacendum.sqlite` and its mtime
 * moved. Bind first, drain second: queued transactions unwind on rejections
 * instead of committing, and a running one is refused at its next statement.
 *
 * THE PREDICATE IS `conn()`'s OWN, AND DELIBERATELY NOT "EVERY CLOSE". A
 * release binds exactly when the module's pointer has moved off the file the
 * handle is open on — `targetWorkspace() !== openWorkspace` — which is the same
 * question `conn()`'s re-home asks one line before it releases. Written as
 * "revoke on every `close()`" instead, the two closers stop agreeing in the
 * other direction: `relock()` closes with the pointer UNMOVED, so its drain is
 * the owner's own writes going into the owner's own workspace, and refusing
 * them would throw away a message somebody had just sent because the phone
 * autolocked underneath it. Nothing is protected by that; a message is lost.
 *
 * IT COSTS THE RING NOTHING, which is the half rule 3 watches. `revoke()`
 * refuses statements not yet DISPATCHED; a door read already in the pool holds
 * its own promise and answers, and the close under it is still deferred
 * (`doorStatementsRunning`). The door's SECOND statement re-asks `conn()` and
 * opens on the workspace the verdict chose — exactly what it did before.
 *
 * AND `db` IS LEFT ALONE WHEN NOTHING IS BOUND, which is not tidiness either:
 * emptying it across the drain would put a door press on a SECOND connection to
 * the same file while a transaction holds its RESERVED lock, and the `COMMIT`
 * that follows takes EXCLUSIVE — `SQLITE_BUSY` on the press, `failed_media` on
 * the ring. That is the "give the door its own connection" remedy this module
 * rejected, reached by accident. When something IS bound the two handles are on
 * DIFFERENT files by construction, which is the only reason it is safe there.
 *
 * THEN WHATEVER IS OPEN AFTER THE DRAIN, TOO, and it need not be the same
 * handle: a press landing during the await opens a new one on the verdict's
 * workspace. Releasing only the handle read at the top would leave that one
 * orphaned — open, unrevoked and unreachable. See `Handle`.
 */
export async function close(): Promise<void> {
  closedLatch = true;
  const atVerdict = db && openWorkspace !== targetWorkspace() ? db : null;
  if (atVerdict) {
    db = null;
    atVerdict.revoke();
  }
  await txChain;
  const current = db;
  db = null;
  if (atVerdict) releaseHandle(atVerdict);
  if (current) releaseHandle(current);
}

/**
 * KEEP THESE DATABASES OUT OF THE DEVICE BACKUP — BY CONSTRUCTION.
 *
 * The files are plain SQLite by design (see the note at the top: at-rest
 * protection is iOS Data Protection, not app-side crypto). Data Protection
 * governs whether a file is readable while the phone is locked and says
 * NOTHING about the backup service, which copies app data wholesale. Only the
 * key store and a QR scratch directory were ever excluded — so an iCloud
 * backup, which is on by default, held the entire plaintext message history
 * and every decrypted image in it, while the site told people there was no
 * backup at all.
 *
 * THE MECHANISM IS A DIRECTORY, NOT A LIST OF FILES. Both databases live in
 * `Library/tacendum-db/`, and the native side sets the backup-exclusion flag
 * on the DIRECTORY — iOS skips an excluded directory's whole subtree, so
 * every file SQLite ever mints in there is excluded from the moment it is
 * created. That matters because these databases run SQLite's default DELETE
 * journal mode, and the sidecar that actually exists next to them is
 * `<db>-journal`: plaintext page pre-images, created during every write
 * transaction, persisting after a crash as a hot journal. The previous
 * design flagged individual files at open time and listed `-wal`/`-shm` —
 * WAL sidecars these databases never create — so the journal was never
 * flagged at all, and no per-file, at-open scheme can fix that: the journal
 * mostly does not exist at open time, and a file created mid-session is a
 * file the flag has not reached. The full argument, the rejected
 * alternatives (per-file `-journal` flagging, switching to WAL,
 * journal_mode=MEMORY/OFF) and the one-time migration from the old
 * Library-root location live in the native module's DatabaseDirectory.swift.
 *
 * Both workspaces, and the decoy especially: a decoy database — or a
 * decoy-NAMED journal file, whose filename alone proves the feature is armed
 * — recoverable from a backup defeats the entire point of having one.
 *
 * The keys stay excluded, which is what makes "lose the phone and the
 * account is gone" true. This makes the message text keep the same promise.
 *
 * SYNCHRONOUS, BEFORE open(), NEVER a fallback path: the native call migrates
 * a legacy database into the directory, so it must finish before op-sqlite
 * creates anything at the new path, and if the directory truly cannot be
 * prepared the open must fail LOUDLY — opening at some other path would show
 * every existing install an empty history, which reads as "my messages are
 * gone" and is far worse than an error.
 *
 * A FAILED EXCLUSION IS VISIBLE BUT NOT FATAL. `excluded: false` means the
 * attribute write failed; the database still opens (the flag is hardening,
 * not correctness — turning it into an outage would be the wrong trade), but
 * it is warned about instead of being swallowed at every layer, which is how
 * the old design shipped broken with nobody able to notice. The warning
 * deliberately names no file.
 */
function databaseLocation(file: string): string {
  const { location, excluded } = prepareDatabaseDirectory(file);
  if (!excluded) {
    console.warn(
      '[db] backup exclusion could not be asserted on the database directory',
    );
  }
  return location;
}

/**
 * Why a caller believes it is allowed a connection.
 *
 * `'verdict'` is everything: the lock screen has been answered and a world
 * chosen, so `initDb()` has cleared the latch. `'servicing-a-callkit-answer'`
 * is the ONE exception, and it exists because of a conflict this codebase
 * decides in the ring's favour on purpose.
 *
 * THE CONFLICT. Answering a call from the lock screen after iOS killed the
 * app cold-launches the process BY that press: `flushPendingEvents()` replays
 * it from a mount effect, above and before the effect that reads the lock
 * verdict. The answer path is pure SQLite — the ringing offer was persisted
 * precisely so it would survive the kill — so a database that fails
 * closed here does not protect anything: it makes `takeOffer` yield null,
 * `rehydrate` release the CXCall as `failed_media`, and the call die in the
 * owner's hand, with nothing anywhere that would replay the answer after an
 * unlock. Rule 3 outranks the privacy boundary where the two genuinely
 * conflict, and they genuinely conflict here.
 *
 * THE BOUNDARY, IN ONE SENTENCE, HONESTLY: before any verdict exists, the only
 * thing that may open a workspace is CallKit telling us what the person did
 * with a call it is already showing them — the green button OR the red one —
 * and what that press may reach is the NEWEST `call_sessions` row whatever it
 * names, plus, if that row's sid is the one it named, the `call_offers` rows
 * for that session and the single `profile` row holding this device's account
 * id; so somebody holding the phone can, by pressing a button iOS is already
 * offering them on the lock screen, cause `tacendum.sqlite` to be opened and
 * learn one call's SDP, its peers' ids, the roster and room of the last
 * small-group call this device was in, and this device's own account id (and
 * consume those offer rows, which is a DELETE), while every other row of every
 * table — the profile projection, the chats, the messages, the media, the
 * older call rows — plus the housekeeping writes and the push-token upload
 * stay shut until somebody proves which world they are in.
 *
 * That is more than the previous version of this sentence admitted, in two
 * places, and both corrections are the comment catching up with the code
 * rather than the code being changed:
 *
 *  - "an answer already in flight" was wrong. The same subscription pair
 *    serves `callKitEnd`, so a DECLINE walks through this door too, and it
 *    must — declining after a kill still has to reach the leg that tells the
 *    caller no, and rule 3 covers the red button as much as the green one.
 *  - "the rows for the call being answered" was wrong. `callKitNamesSession`
 *    asks for the NEWEST session row and compares the sid AFTERWARDS, so a
 *    press about anything at all — a 1:1 cid, a synthetic push placeholder —
 *    reads that row. The `WHERE sid = ?` read that would end this is written
 *    up at `loadCallSession`; it is not applied because the test that pins
 *    this statement's literal text lives outside the lane that found it.
 *
 * What remains true, and is the actual promise: nothing here reaches a MESSAGE,
 * a chat, a contact, an attachment or the profile projection, and nothing here
 * writes anything except the consumption of the offer rows it just answered.
 * What a pre-verdict holder of the phone gets out of this door is the call
 * CallKit was already offering them, and the identity of the call before it.
 *
 * WHICH FILE. With no verdict in flight `workspace` holds 'real', and that is
 * the correct one — the VoIP push that rang this phone was addressed to the
 * real account. It holds 'real' at launch because that is its initializer and
 * BETWEEN SESSIONS because `relockWorkspace()` puts it back; a duress session
 * leaves it reading 'decoy', and for as long as nothing reset it, every
 * lock-screen answer for the rest of the phone's uptime was looked up in the
 * decoy and discarded. From the instant an unlock declares itself
 * (`beginUnlock`), `pendingWorkspace` overrides it, so a press landing DURING
 * a duress unlock reaches the decoy's (empty) tables and restores nothing —
 * including when a press has ALREADY opened the real file, which is the
 * ordinary case and which the re-homing in `conn()` is what makes true. That is
 * the same answer this door has always given after a duress verdict; the
 * declaration only moves it to where the verdict actually is.
 */
type ConnGate = 'verdict' | 'servicing-a-callkit-answer';

/**
 * A CONNECTION AS THIS MODULE HANDS IT OUT — the driver's handle behind a
 * switch this module owns, and never the driver's object itself.
 *
 * BECAUSE "DROPPED FROM `db`" IS NOT "UNREACHABLE", which is the sentence the
 * deferral below was first shipped with and which was false in this same file
 * eighteen times. Callers do not all re-ask `conn()` per statement: eighteen
 * capture the handle once (`const d = conn()`) and go on using that object
 * across an await — NINE of them for a whole `BEGIN IMMEDIATE`…`COMMIT`
 * transaction (`enqueueOutgoing`, `enqueueOutgoingFanout`, the grp.new
 * applier), the other nine for a two-statement pair or a DELETE/INSERT loop
 * (`markSeen`, `setDraft`, `clearLocalState`, `saveMyProfileCard`). Every one
 * of the eighteen issues at least two statements on it. Nulling `db`
 * stops the next caller to ASK and none of those: they hold the object, not
 * the pointer. So for as long as a release was deferred for the ring's sake
 * (`doorStatementsRunning`), every one of them went on writing the file a
 * duress verdict had just declared off-limits — an `INSERT` and a `COMMIT` on
 * `tacendum.sqlite`, its journal created and removed and its mtime moved
 * later than the moment the passcode was typed. That is the privacy defect the
 * deferral is written to avoid, re-created by the deferral.
 *
 * So a release REVOKES this switch. The two halves are then independent, which
 * is the only shape that satisfies both rules at once: nothing NEW may touch
 * the released file (privacy), and nothing ALREADY RUNNING may be aborted
 * (the ring). One `sqlite3_interrupt` cannot make that distinction —
 * it is per CONNECTION, so cutting the transaction would cut the door read
 * beside it — but a switch in front of the dispatch can.
 *
 * WHY THE SWITCH IS NOT A FLAG ON THE DRIVER'S OWN OBJECT: `DBHostObject::set`
 * throws `You cannot write to this object!` (DBHostObject.cpp), so there is
 * nowhere on it to put one — and a harness whose handle is an ordinary JS
 * object would have accepted the patch and hidden that. The switch has to live
 * in something this module minted.
 */
export interface Handle {
  execute: (query: string, params?: Scalar[]) => Promise<QueryResult>;
}

/** A handle this module opened, with the two levers only it may pull. */
interface OwnedHandle extends Handle {
  /**
   * STOP ANSWERING — synchronous, irreversible, and NOT a close. A statement
   * already dispatched holds its own promise and runs to its answer; every
   * statement issued from here on gets a REJECTED promise, which is exactly
   * what a caller holding a closed handle used to get and what the ROLLBACK
   * and `.catch()` arms of this file are already written for.
   */
  revoke: () => void;
  /** The driver's `close`: `sqlite3_interrupt` first, so it aborts whatever is
   * running — which is why it is the half that gets deferred. */
  close: () => void;
}

function openHandle(chosen: Workspace): OwnedHandle {
  const file = WORKSPACE_FILES[chosen];
  // databaseLocation BEFORE open, every open — see `databaseLocation`.
  const raw = open({ name: file, location: databaseLocation(file) });
  let revoked = false;
  return {
    // NEITHER `async` NOR A `.then`: door statements come through here, on the
    // one path in this app that is measured in microtask hops, so this hands
    // back the driver's OWN promise (see `doorExecute`) and costs zero.
    execute: (query, params) =>
      revoked
        ? Promise.reject(new Error('database handle released'))
        : raw.execute(query, params),
    revoke: () => {
      revoked = true;
    },
    close: () => raw.close(),
  };
}

/**
 * HOW MANY DOOR STATEMENTS ARE RUNNING RIGHT NOW — the one thing a handle has
 * to be asked before it is closed.
 *
 * `close()` IS NOT A POLITE HAND-BACK. `DBHostObject.cpp`'s `close` runs
 * `sqlite3_interrupt(db)` first, then `thread_pool->waitFinished()`, then
 * `opsqlite_close`; the interrupted `sqlite3_step` makes `bridge.cpp` throw
 * `[op-sqlite] statement execution error: …`, and `utils.cpp`'s promisify
 * turns that into a REJECTED promise. So closing a handle does not merely
 * stop the statements that come after it — it ABORTS THE ONE THAT IS RUNNING.
 *
 * On this door that abort is a discarded answer. `takeCallOffer` and
 * `takeCallOffersForSession` are the only two-statement readers in the module,
 * and both are serviced from a CallKit press: `controller.ts` turns their
 * rejection into `endCall(cid, 'failed_media')` and `group.ts` into
 * `endCall(sid, 'failed_media')`. The person tapped ANSWER and the call was
 * released — a denial of ring, which rule 3 makes the one outcome this module
 * may not trade for anything.
 *
 * And both closers were reaching it. The re-home below closes the handle the
 * instant anyone asks for a workspace the open one is not, which on a phone
 * being handed over mid-ring is a SECOND CallKit event out of the same native
 * flush; `enterDecoyWorkspace`'s own `await db.close()` reaches it with no
 * second press at all, because the duress passcode is typed while the first
 * press's SELECT is still in the pool.
 *
 * SO A RELEASE THAT WOULD CUT ONE IS DEFERRED, NOT CANCELLED — the `close()`
 * waits for the statements already in the pool to answer. Deferring costs one
 * file handle for the length of one SQLite round trip; closing costs the ring.
 *
 * AND THE DEFERRAL IS ONLY HALF OF A RELEASE, which is the half this paragraph
 * used to claim on its own and could not deliver. It said the handle leaving
 * `db` meant "nothing new can be issued on it, because every caller goes
 * through `conn()`" — false in this file eighteen times over: every caller
 * OBTAINS a handle from `conn()`, and eighteen of them go on using that same
 * object for two or more statements, nine of those inside a transaction that
 * ends in `COMMIT`. A handle that is merely deferred
 * is still open and still answers them, so the window this note calls "one
 * SQLite round trip" was a window in which a transaction begun before the
 * verdict COMMITTED to the real file after it. The other half is
 * `releaseHandle`'s `revoke()`: see `Handle`.
 *
 * WHAT IT DOES NOT DO, because that would be the privacy defect coming back:
 * it does not let anything NEW touch the released file — not from a fresh
 * `conn()` (the pointer is gone) and not from a captured handle (it is
 * revoked). A duress verdict still re-homes the door on the same synchronous
 * line it always did, the DELETE that follows a SELECT still lands on the file
 * the verdict chose, and the only thing the deferral protects is a statement
 * that was ALREADY DISPATCHED before the verdict existed. That is the same
 * rows-already-in-hand rule the cost note on `conn()` states, one instant
 * earlier.
 *
 * AND "ALREADY DISPATCHED" IS MEASURED FROM THE VERDICT, NOT FROM THE CLOSE,
 * which is the sentence this paragraph once shipped without being able to
 * make true. `close()` awaits the transaction chain, so when the revoke lived
 * after that await the sentence above was false in its sharpest case: every
 * `runExclusive` transaction RUNNING OR QUEUED at the verdict ran to `COMMIT`
 * on the file, and a queued one had dispatched nothing at all. Both closers now
 * bind before anything they wait for — `conn()`'s re-home before it opens the
 * replacement, `close()` before it drains — so the protected set really is the
 * statements the pool already held.
 */
let doorStatementsRunning = 0;
/** Handles revoked while a door statement was still running on them, waiting
 * for it to answer before they are actually closed. */
const releasedUnderTheDoor: OwnedHandle[] = [];

function releaseHandle(handle: OwnedHandle): void {
  // REVOKED FIRST AND UNCONDITIONALLY — before the branch, so that both the
  // deferred and the immediate release mean the same thing to every caller
  // holding this object. This is what binds a RE-HOME; `close()` does its own
  // binding earlier, because it has a drain to get through first.
  //
  // UNPINNABLE ON THE IMMEDIATE BRANCH, AND KEPT ANYWAY — disclosed rather than
  // deleted. There, the very next line closes the handle, and both op-sqlite
  // (SQLITE_MISUSE out of `promisify`) and the harness already refuse a closed
  // one, so moving this line inside the deferral branch keeps the whole repo
  // green. It stays outside it because "the driver will refuse it" is the exact
  // assumption this area died on before, when the harness handed a closed
  // handle its own answers back; the guarantee is this module's to make.
  handle.revoke();
  if (doorStatementsRunning > 0) {
    releasedUnderTheDoor.push(handle);
    return;
  }
  handle.close();
}

/**
 * Issue a statement through the pre-verdict door, and hold every release off
 * it until it has answered.
 *
 * Returns the driver's OWN promise rather than one chained off it: the door is
 * serviced inside a CallKit press, and a wrapper here would add a microtask
 * hop to every statement on the one path in this app that is measured in them.
 * The bookkeeping rides on a side observer, which settles before the caller
 * resumes because it was registered first.
 *
 * COUNTED BEFORE THE DISPATCH, AND THE OTHER ORDER IS A REAL BUG rather than a
 * style choice — it was written the other way and five tests said so. On the
 * device `execute` queues the statement and returns, so nothing can run
 * between the call and the line after it and the two orders are the same. In
 * the test harness the statement's stand-in runs INLINE up to its first await,
 * which is exactly how a test arranges "something lands while this is in
 * flight" — and counted afterwards, that something arrives while the number
 * still reads zero and is not held off at all. Counting first is correct in
 * both, so it is the only order that is correct at all.
 *
 * The catch is the price of counting first. `execute` is a JSI host function
 * and may throw synchronously rather than returning a rejected promise (a
 * parameter it cannot bind); without this the number would stay above zero for
 * the rest of the process, deferring every close forever — one leaked file
 * handle per workspace switch, and a `setWorkspace` that starts refusing.
 */
function doorExecute(sql: string, params?: Scalar[]): Promise<QueryResult> {
  const handle = conn('servicing-a-callkit-answer');
  const answered = (): void => {
    doorStatementsRunning -= 1;
    if (doorStatementsRunning > 0) return;
    while (releasedUnderTheDoor.length > 0) {
      releasedUnderTheDoor.pop()?.close();
    }
  };
  doorStatementsRunning += 1;
  let running: Promise<QueryResult>;
  try {
    running = handle.execute(sql, params);
  } catch (err) {
    answered();
    throw err;
  }
  running.then(answered, answered);
  return running;
}

function conn(gate: ConnGate = 'verdict'): Handle {
  if (closedLatch && gate === 'verdict') {
    throw new Error('database is closed');
  }
  const chosen = targetWorkspace();
  // AN ALREADY-OPEN HANDLE DOES NOT OUTRANK THE DECISION. Steering only the
  // lazy open below left `beginUnlock` defeated by exactly the caller it was
  // written to defend against (see `openWorkspace`). A handle on the wrong file
  // is dropped and reopened on the right one, so "which workspace does this
  // read reach" has one answer — `pendingWorkspace ?? workspace` — rather than
  // two that differ by whether somebody pressed a button first.
  //
  // Unreachable for a `'verdict'` caller by construction, and that is the
  // reason it is safe to do this here rather than only at the door: the latch
  // is clear only after `initDb()`, which is the moment `workspace` holds the
  // verdict and the declaration is spent, and `setWorkspace` refuses to move
  // `workspace` while a handle is open. Only the door runs while the two can
  // disagree — before a verdict, and inside an unlock arm that has declared one.
  //
  // WHAT IT COSTS, STATED — AND STATED THE RIGHT WAY ROUND THIS TIME. The two
  // door readers are a SELECT and then a DELETE (`takeCallOffer`,
  // `takeCallOffersForSession`), so a verdict can land between their two
  // statements. Each now asks HERE again for the second one instead of reusing
  // the handle the first was given, and that is what makes both sentences
  // below true rather than merely hoped for:
  //
  //  - THE DELETE FOLLOWS THE DECLARATION. Cached, it went to whatever file the
  //    SELECT had opened — so unless something else happened to call `conn()`
  //    in the gap, a duress verdict did not stop it, and `tacendum.sqlite` was
  //    WRITTEN on a coerced session's behalf while somebody stood over the
  //    phone. Asked again, it lands on the decoy, matches nothing, and the rows
  //    the press half-read stay in the real file exactly as this note has
  //    always claimed they did.
  //  - AND NOTHING IS EVER EXECUTED ON A HANDLE THIS BLOCK HAS CLOSED. When
  //    something DID call `conn()` in that gap — a second press, the unlock
  //    arm's own `initDb` — the cached handle had been dropped and closed under
  //    the caller, and op-sqlite's `execute` checks neither `invalidated` nor a
  //    null `db` before dispatching (DBHostObject.cpp, unlike its `interrupt`
  //    next door). What comes back is a rejected promise; both callers' own
  //    `.catch()` turns it into "nothing to restore"; and the ring hears a
  //    tapped answer released as `failed_media`. A denial of ring manufactured
  //    by the defence is not a trade this codebase makes.
  //  - AND THE RELEASE BELOW DOES NOT CUT THE STATEMENT THAT IS ALREADY
  //    RUNNING, which is the half this note used to leave out and which cost a
  //    ring on its own. The sentence above closed one direction only:
  //    execute-after-close. `close()` also runs `sqlite3_interrupt` on its way
  //    down, so re-homing under a door read ABORTED that read — the same
  //    rejected promise, the same `failed_media`, reached by the defence
  //    rather than by the defect it was defending against. The handle is now
  //    REVOKED here — which is what binds the verdict, for the callers holding
  //    it as much as for the next one to ask — and CLOSED only once the
  //    statements already dispatched on it have answered; see
  //    `doorStatementsRunning` and `Handle`.
  //
  // WHAT IS NOT CLAIMED, because it is not true: the SELECT has already
  // resolved by then, and its rows are returned to the caller. The press keeps
  // the answer it was given — the call CallKit was already offering the person
  // holding the phone, which is precisely what this door exists to serve — and
  // the real workspace keeps its rows. That is the only ordering in which any
  // of this fires: a REAL verdict never moves the door off the real file.
  if (db && openWorkspace !== chosen) {
    const stale = db;
    db = null;
    releaseHandle(stale);
  }
  if (!db) {
    db = openHandle(chosen);
    openWorkspace = chosen;
  }
  return db;
}

/**
 * Serialize multi-statement transactions so two overlapping `BEGIN`s can never
 * nest (op-sqlite runs one connection). Single statements don't need this.
 */
let txChain: Promise<unknown> = Promise.resolve();
function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
  const result = txChain.then(fn, fn);
  txChain = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export async function initDb(): Promise<void> {
  // Prepare BOTH database families up front, not just the active one. The
  // point is the one-time migration into the excluded directory: the decoy
  // file must move out of the old backed-up Library-root location on the
  // first launch of the build that knows better — not on the first decoy
  // open, which for an owner who is never coerced (exactly the population
  // the decoy exists for) might be never. Cheap after the first run: one
  // stat-and-return per file.
  databaseLocation(WORKSPACE_FILES.real);
  databaseLocation(WORKSPACE_FILES.decoy);
  // UNLATCHED HERE, not on the first line: the two calls above are the ones
  // that can throw (an App Group container that cannot be prepared), and
  // clearing the latch before them left a FAILED unlock with the door open —
  // the next db call from anywhere would lazily open a workspace nobody had
  // successfully chosen. Failing this way leaves the module exactly as a cold
  // process finds it.
  closedLatch = false;
  // The declaration has been honoured: `workspace` now holds what the verdict
  // chose, so the override is spent. See the note on `pendingWorkspace` for why
  // `close()` must not do this and `relockWorkspace()` must.
  //
  // AND IT IS UNENFORCEABLE TODAY, WHICH IS RECORDED RATHER THAN LEFT TO LOOK
  // LOAD-BEARING. Both `setWorkspace` callers are preceded by a `beginUnlock`
  // of the SAME workspace (App.tsx 461/524 and 646/716), so by the time this
  // line runs the two pointers already agree and `conn()` cannot tell the
  // difference; deleting it keeps the whole suite green, and no test here
  // pins it, because the state that would need one is not reachable from any
  // caller that exists. It is kept for the same reason the declaration on the
  // REAL arm is: it is the declaration's own end of life, stated at the one
  // moment it is true, and it is what stops a THIRD `setWorkspace` caller —
  // one that never declared anything — from inheriting a stale override.
  pendingWorkspace = null;
  await initSchema(conn());
  // The room-names mirror is retracted at every relock and duress entry
  // (retractSelfId), and the module that republishes the PEER names at
  // session start is off in messaging — this is the database's own moment in
  // the unlock sequence (App.tsx arms the previews lease, awaited, before it
  // opens the workspace), so the mirror the extension titles room banners
  // from is rebuilt here. In a decoy workspace the write-side gates refuse,
  // which keeps the mirror empty exactly as the peer names stay empty.
  republishGroupNames();
}

/**
 * Create/migrate the schema on a given connection. Exported so the decoy
 * generator can prepare the decoy file over its own
 * short-lived connection while the real workspace stays active.
 */
export async function initSchema(d: Handle): Promise<void> {
  await d.execute(`
    CREATE TABLE IF NOT EXISTS profile (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`);
  await d.execute(`
    CREATE TABLE IF NOT EXISTS chats (
      peerId TEXT PRIMARY KEY,
      displayName TEXT,
      lastMessageAt INTEGER,
      lastMessageText TEXT
    )`);
  // Peer profile card fields, added after the table shipped. Additive columns
  // (unlike the attachments/reactions key change) — no data needs discarding.
  const chatColumns = (
    (await d.execute(`PRAGMA table_info(chats)`)).rows as { name: string }[]
  ).map(r => r.name);
  for (const [column, ddl] of [
    ['about', 'about TEXT'],
    ['avatarB64', 'avatarB64 TEXT'],
    ['profileVersion', 'profileVersion INTEGER'],
    // Version of MY card this peer has already received, so a re-share only
    // happens when something actually changed.
    ['sentProfileVersion', 'sentProfileVersion INTEGER'],
    // When this device last recorded that the safety number matched. Local
    // only: never sent to the peer, never a public trust badge.
    ['safetyCheckedAt', 'safetyCheckedAt INTEGER'],
    // The name I chose for this person here. Local only: it is never put on
    // the wire, so it cannot leak a nickname back to the person named.
    ['localName', 'localName TEXT'],
    ['createdAt', 'createdAt INTEGER'],
    ['lastOpenedAt', 'lastOpenedAt INTEGER'],
    ['identityChangedAt', 'identityChangedAt INTEGER'],
    // A comparison that failed, recorded so it can be shown instead of being
    // indistinguishable from "never checked".
    ['safetyMismatchAt', 'safetyMismatchAt INTEGER'],
    // Disappearing messages: the agreed timer in seconds (0/NULL = off) and
    // the version that set it, so the newest setting wins on both phones.
    ['disappearSec', 'disappearSec INTEGER'],
    ['disappearVersion', 'disappearVersion INTEGER'],
    // Rooms. A room reuses `chats` rather than getting a
    // table of its own: everything a thread does — drafts, unread counts,
    // disappearing sweeps, the list ordering — already keys on `peerId`, and
    // a second conversation table would fork every one of those.
    //
    // DELIBERATELY AN OPEN TEXT TAXONOMY: no CHECK constraint and no
    // exhaustive switch, so a third kind is an additive change rather than a
    // schema rebuild. NULL means the 1:1 chat every existing row is,
    // which is why no backfill is needed.
    ['kind', 'kind TEXT'],
    // The room's name as its creator set it. Distinct from `displayName`,
    // which is a peer's own profile card and is overwritten by their
    // broadcasts — a room has no card to broadcast.
    ['groupName', 'groupName TEXT'],
    // Contact provenance: who introduced this person —
    // 'qr' | 'manual' | 'discovery', an open taxonomy like `kind` above. No
    // backfill on purpose: NULL means "before provenance was recorded" and
    // reads as NOT server-introduced, so an existing install's chats all
    // wake up unbannered. Never on the wire.
    ['introducedBy', 'introducedBy TEXT'],
    // When this conversation was pinned to the top of the list, or NULL for
    // the ordinary rows. A moment rather than a flag, so pinned rows keep an
    // order among themselves (newest pin first) without a second column and
    // without a cap. Local only: a pin is my list, not a claim about the
    // person, so nothing about it goes on the wire.
    ['pinnedAt', 'pinnedAt INTEGER'],
  ] as const) {
    if (!chatColumns.includes(column)) {
      await d.execute(`ALTER TABLE chats ADD COLUMN ${ddl}`);
    }
  }
  // Owner-requested routine notification mode for one authenticated agent.
  // `effectiveRoutine` changes only when that same peer echoes the exact
  // pending q+value; a queued request is visible but never painted as active.
  await d.execute(`
    CREATE TABLE IF NOT EXISTS ai_notify_preferences (
      peerId TEXT PRIMARY KEY,
      effectiveRoutine TEXT NOT NULL DEFAULT 'all'
        CHECK (effectiveRoutine IN ('all','quiet')),
      pendingQ TEXT,
      requestedRoutine TEXT
        CHECK (requestedRoutine IS NULL OR requestedRoutine IN ('all','quiet')),
      requestedAt INTEGER,
      acknowledgedAt INTEGER
    )`);
  // User-authored AI request shortcuts are private workspace content. They
  // never ride a profile or message envelope, and every lookup stays scoped
  // to the peer whose reviewed task composer owns them.
  await d.execute(`
    CREATE TABLE IF NOT EXISTS ai_task_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      peerId TEXT NOT NULL,
      name TEXT NOT NULL,
      prompt TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    )`);
  // Backfill for chats that predate `createdAt`: their first known moment is
  // their last message. Idempotent (the guard is `IS NULL`), so it is safe on
  // a partially migrated file and a no-op on every later launch.
  await d.execute(
    `UPDATE chats SET createdAt = COALESCE(lastMessageAt, 0)
     WHERE createdAt IS NULL`,
  );
  // PK is (msgId, direction): an inbound frame whose sender-chosen msgId
  // collides with one of my own outgoing ids is a distinct row, so it can
  // never be silently dropped by INSERT OR IGNORE against my sent message.
  await d.execute(`
    CREATE TABLE IF NOT EXISTS messages (
      msgId TEXT NOT NULL,
      peerId TEXT NOT NULL,
      direction TEXT NOT NULL CHECK (direction IN ('in','out')),
      body TEXT NOT NULL,
      ts INTEGER NOT NULL,
      status TEXT NOT NULL,
      PRIMARY KEY (msgId, direction)
    )`);
  // Revision stamps, added after the table shipped. Additive (like the chats
  // columns above) — nothing on disk needs discarding, and a NULL in either
  // column means "never edited" / "not retracted".
  const messageColumns = (
    (await d.execute(`PRAGMA table_info(messages)`)).rows as { name: string }[]
  ).map(r => r.name);
  for (const [column, ddl] of [
    // When this row should stop existing (epoch ms), or NULL for "keeps".
    // Set at send time for my own messages and at READ time for theirs — a
    // message that expires before it has been read has disappeared without
    // ever being delivered, which is a bug, not a feature.
    ['expiresAt', 'expiresAt INTEGER'],
    ['editedAt', 'editedAt INTEGER'],
    ['deletedAt', 'deletedAt INTEGER'],
    // When THEY read my message, or NULL. The status column carries 'read'
    // too; this is the timestamp behind it.
    ['readAt', 'readAt INTEGER'],
    // Whether a read receipt for THEIR message has already gone out. A flag
    // rather than a timestamp: the only question is "again?", and defaulting
    // to 0 means every row that predates this column is treated as
    // unacknowledged and picked up the next time the thread is opened.
    ['readSent', 'readSent INTEGER NOT NULL DEFAULT 0'],
    // Rooms. WHO wrote this row, when `peerId` names
    // a room rather than a person. NULL in a 1:1, where the author is
    // `peerId` or me and the direction says which.
    ['authorId', 'authorId TEXT'],
    // The author's own per-room counter. Group rows order by
    // `(ts, authorId, sq)` and NOT by msgId, because a fan-out leg's wire
    // msgId is now pure randomness and the server drains an offline
    // queue in wire-id order — so two causally ordered messages that reached
    // the server in one millisecond can arrive reversed. NULL sorts as 0,
    // which is the order rows written before this column already have.
    ['sq', 'sq INTEGER'],
    // Rooms, the receive path. 1 = this room
    // row's sender was OUT of the room by this phone's fold when it arrived,
    // so it renders as a visibly tagged, attributed row rather than a
    // member's bubble. Recorded AT ARRIVAL, not derived at render: the
    // roster changes over time and a later re-add must not retroactively
    // untag words that arrived from outside. NULL/0 on every 1:1 row and
    // every member row.
    ['outsider', 'outsider INTEGER'],
    // Rooms, history sharing. WHO relayed this row
    // to me when it did not arrive first-hand: the id of the member whose
    // ratchet carried it. NULL on everything this phone witnessed itself. A
    // row with this set is that person's ACCOUNT of a message, never an
    // authenticated one — and it is barred from being relayed onward
    // (selectHistoryForShare), or a second-hand claim would arrive at the
    // next hop wearing first-hand provenance.
    ['sharedBy', 'sharedBy TEXT'],
    // The unread window, on THIS phone's clock. Rooms never had one: the
    // unread join keys `seen.msgId = messages.msgId`, and a room row's id is
    // the composite `${author}.${m}` while `seen` records the WIRE id, so the
    // join could not match and no room ever showed a count.
    ['arrivedAt', 'arrivedAt INTEGER'],
    // The Art. 50 AI-origin marker.
    // 1 = the sealed envelope CLAIMED AI origin (`ai: true` — on the
    // grp.msg wrapper for rooms, on the inner kind for 1:1), recorded AT
    // ARRIVAL on `outsider`'s exact reasoning: the room wrapper is
    // discarded at persist, so a render-time re-parse would have nothing to
    // read — and a body that merely LOOKS marked must not badge a row that
    // arrived unmarked. Sender-claimed, relay-invisible, NOT provable (the
    // marker honesty limits); the badge is marker-OR-machine_peers, so the
    // owner's record still badges a lying client that omits this. NULL/0 on
    // every human row and every row that predates the column.
    ['ai', 'ai INTEGER'],
  ] as const) {
    if (!messageColumns.includes(column)) {
      await d.execute(`ALTER TABLE messages ADD COLUMN ${ddl}`);
    }
  }
  await d.execute(
    `CREATE INDEX IF NOT EXISTS idx_messages_peer ON messages (peerId, msgId)`,
  );
  // Covers the thread read, which orders by (ts, msgId) rather than msgId: an
  // inbound row's msgId is the SENDER's ULID, so their clock must not be able
  // to place a reply above the message it answers.
  await d.execute(
    `CREATE INDEX IF NOT EXISTS idx_messages_peer_ts
     ON messages (peerId, ts, msgId)`,
  );
  await d.execute(`
    CREATE TABLE IF NOT EXISTS seen (
      msgId TEXT PRIMARY KEY,
      ts INTEGER NOT NULL
    )`);
  // `markSeen`'s prune keeps the 5000 most RECENTLY SEEN rows, ordered by
  // `ts` (this device's clock at processing time) with msgId as the
  // tiebreak — so the ORDER BY has an index to walk instead of a sort per
  // inbound frame. Additive: CREATE INDEX IF NOT EXISTS is the whole
  // migration for a file that predates it.
  await d.execute(
    `CREATE INDEX IF NOT EXISTS idx_seen_ts ON seen (ts, msgId)`,
  );
  // Decrypted attachment blobs, keyed by their message. `state` tracks the
  // download lifecycle for inbound images ('pending' -> 'ready'/'failed');
  // outbound images are written 'ready' at send time. dataB64 is the plain
  // image — same at-rest posture as message bodies (iOS Data Protection).
  await d.execute(`
    CREATE TABLE IF NOT EXISTS attachments (
      msgId TEXT NOT NULL,
      direction TEXT NOT NULL CHECK (direction IN ('in','out')),
      state TEXT NOT NULL CHECK (state IN ('pending','ready','failed')),
      dataB64 TEXT,
      w INTEGER,
      h INTEGER,
      PRIMARY KEY (msgId, direction)
    )`);
  // A revision (edit/retraction) whose target has not arrived yet. Frames are
  // handled concurrently and drained in queue order, so a cheap carrier can
  // overtake the expensive prekey message it revises; without somewhere to
  // wait, acking the carrier would lose it forever. Reactions get this for
  // free by living in their own table and being JOINed at read time.
  //
  // `writerId` is IN THE KEY, and that is a security fix, not cosmetics: a room row's key is `${authorId}.${m}` and is
  // computable by every member, so without a writer in the key member M could
  // park a forged `del` naming author A's message in the PK slot and thereby
  // SUPPRESS A's genuine retraction — the upsert's newest-wins guard would
  // arbitrate two different writers' claims over one row. With the writer in
  // the key, M's forgery occupies M's slot and nobody else's, and the apply
  // path takes only the revision whose writer is the target's author.
  await d.execute(`
    CREATE TABLE IF NOT EXISTS pending_revisions (
      peerId TEXT NOT NULL,
      targetMsgId TEXT NOT NULL,
      targetDirection TEXT NOT NULL CHECK (targetDirection IN ('in','out')),
      writerId TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL CHECK (kind IN ('edit','del')),
      text TEXT NOT NULL,
      ts INTEGER NOT NULL,
      PRIMARY KEY (targetMsgId, targetDirection, writerId)
    )`);
  // Tapback reactions: at most one per REACTOR per target message row; emoji
  // '' is a retraction tombstone (kept so a late redelivery can't resurrect
  // it). targetDirection mirrors the messages composite key: msgIds are
  // sender-chosen, so (targetMsgId) alone is spoofable across directions.
  //
  // `reactorId` widens the key for rooms: `direction` is
  // binary, so two members reacting to one message would collide on a single
  // row and the second would silently overwrite the first. '' is the 1:1
  // value — a 1:1 chat has exactly one person per side, so the empty reactor
  // keeps its old one-row-per-side shape byte-identically.
  await d.execute(`
    CREATE TABLE IF NOT EXISTS reactions (
      targetMsgId TEXT NOT NULL,
      targetDirection TEXT NOT NULL CHECK (targetDirection IN ('in','out')),
      direction TEXT NOT NULL CHECK (direction IN ('in','out')),
      reactorId TEXT NOT NULL DEFAULT '',
      emoji TEXT NOT NULL,
      ts INTEGER NOT NULL,
      PRIMARY KEY (targetMsgId, targetDirection, direction, reactorId)
    )`);
  // Dev-stage schema step: rebuild when an old shape is on disk. Ready
  // attachments re-download on the next launch (the pointer envelope is the
  // durable record) and reactions replay from their message rows.
  //
  // THE TWO ROOM-AWARE KEY REBUILDS LAND HERE, IN THE SAME COMMIT AS
  // THE WRITE PATHS THAT NAME THE NEW KEYS: an earlier attempt
  // rebuilt the keys alone, and every intervening build's
  // `setReaction`/`holdRevision` threw `ON CONFLICT clause does not match
  // any PRIMARY KEY or UNIQUE constraint` on phones that had migrated —
  // before markSeen and the ack, so the server redelivered an undecryptable
  // frame forever. One tapback wedged the drain. The real-engine proof
  // (prove-g3.cjs section 3) asserts both functions APPLY on a migrated
  // file, so the rebuilds cannot come back alone.
  for (const [table, column] of [
    ['attachments', 'direction'],
    ['reactions', 'targetDirection'],
    ['reactions', 'reactorId'],
    ['pending_revisions', 'writerId'],
  ] as const) {
    const info = await d.execute(`PRAGMA table_info(${table})`);
    const columns = (info.rows as { name: string }[]).map(r => r.name);
    if (!columns.includes(column)) {
      await d.execute(`DROP TABLE ${table}`);
      await initSchema(d);
      return;
    }
  }
  // Outgoing wire envelopes (ciphertext only — same bytes the server sees).
  // Kept until the server receipts the msgId, so a restart can re-flush
  // without re-encrypting (re-encrypting would double-advance the ratchet).
  // `attempts` bounds retries so a permanently-rejected (poison) envelope is
  // eventually marked errored instead of re-sent on every reconnect forever.
  await d.execute(`
    CREATE TABLE IF NOT EXISTS outbox (
      msgId TEXT PRIMARY KEY,
      peerId TEXT NOT NULL,
      msgType TEXT NOT NULL,
      payload TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0
    )`);
  // Migration v3. Call signalling must not queue behind a
  // 10 MB photo: a ringing phone cannot wait on an upload. Safe because the
  // Double Ratchet tolerates out-of-order delivery — the recipient caches
  // skipped message keys and decrypts a later message before an earlier one
  // without harm. This is the one place calls relax the outbox ordering
  // invariant, so it is written down here and tested explicitly.
  const outboxColumns = (
    (await d.execute(`PRAGMA table_info(outbox)`)).rows as { name: string }[]
  ).map(r => r.name);
  for (const [column, ddl] of [
    ['priority', 'priority INTEGER NOT NULL DEFAULT 0'],
    // Written in V1, read by the transport in V2 — one migration, not two.
    ['urgent', 'urgent INTEGER NOT NULL DEFAULT 0'],
    // 0 = do NOT raise a notification for this frame: it is a carrier (read
    // receipt, reaction, edit, deletion, profile sync, call signalling), which
    // rewrites a row that already exists and never becomes a message. DEFAULT
    // 1, so rows written before this column existed keep notifying.
    ['notify', 'notify INTEGER NOT NULL DEFAULT 1'],
    // Rooms. One local message fans out to N−1
    // outbox rows, each with its own random wire `msgId`; `localMsgId` is the
    // single row in `messages` they all belong to, so a receipt on one leg
    // updates the right bubble and a retry knows what it is retrying.
    ['localMsgId', 'localMsgId TEXT'],
    // Local flush order, which no longer travels on the wire. `flushPending`
    // used to drain in ULID order and rely on the wire msgId being monotonic;
    // random wire ids break that ACROSS fan-outs, so the order becomes
    // a local fact. NULL rows keep ordering by msgId exactly as before —
    // `COALESCE(seq, 0)` in `listOutbox` is what makes the migration
    // byte-identical for everything already queued.
    ['seq', 'seq INTEGER'],
    // `localMsgId` now doubles as the PURGE KEY
    // for every extra envelope of a device fan-out — sibling transcript
    // copies included, which used to ride with it NULL and so outlived the
    // message they copied when it expired or was retracted before the
    // flush. `ledger` says whether the row is a DELIVERY leg (1: counted in
    // "Not delivered to N of M", settled through the LEG_* sentinels) or
    // transport only (0: the sibling copy, best-effort like a 1:1 carrier).
    // DEFAULT 1, so every row written before the column existed — room
    // legs, peer-device extras — keeps its place in the ledger.
    ['ledger', 'ledger INTEGER NOT NULL DEFAULT 1'],
  ] as const) {
    if (!outboxColumns.includes(column)) {
      await d.execute(`ALTER TABLE outbox ADD COLUMN ${ddl}`);
      if (column === 'notify') {
        // Backfill: priority 1 is exclusively call signalling, and a call
        // frame queued by a pre-`notify` build would otherwise default to 1 —
        // an old offer or ICE candidate draining after the upgrade would
        // banner "New message" over a call, which is one of the two device
        // symptoms this column exists to prevent.
        await d.execute(`UPDATE outbox SET notify = 0 WHERE priority = 1`);
      }
    }
  }
  // Migration v3: the call log. Rows are LOCAL — each side
  // derives its own from its own state machine and they are never exchanged,
  // so a peer cannot forge your call history. `connectedAt` and `endedAt` are
  // deliberately nullable: a call that never connected has no duration, and
  // "0:00" would be a different and false claim.
  await d.execute(`
    CREATE TABLE IF NOT EXISTS call_log (
      cid TEXT PRIMARY KEY,
      peerId TEXT NOT NULL,
      direction TEXT NOT NULL CHECK (direction IN ('in','out')),
      kind TEXT NOT NULL CHECK (kind IN ('audio','video')),
      state TEXT NOT NULL CHECK (state IN ('active','ended')),
      reason TEXT,
      startedAt INTEGER NOT NULL,
      connectedAt INTEGER,
      endedAt INTEGER,
      lastSeenAt INTEGER NOT NULL,
      missed INTEGER NOT NULL DEFAULT 0
    )`);
  await d.execute(
    `CREATE INDEX IF NOT EXISTS idx_call_log_peer ON call_log (peerId, startedAt DESC)`,
  );
  // Aggregate call telemetry is local-only until terminal finalization. One
  // row becomes its own durable outbox item, so a crash cannot strand a draft
  // between deleting it and creating a queued replacement.
  await d.execute(`
    CREATE TABLE IF NOT EXISTS call_metric_reports (
      reportId TEXT PRIMARY KEY,
      localId TEXT NOT NULL,
      scope TEXT NOT NULL CHECK (scope IN ('direct','group')),
      media TEXT NOT NULL CHECK (media IN ('audio','video')),
      startedAt INTEGER NOT NULL,
      answeredAt INTEGER,
      connectedAt INTEGER,
      endedAt INTEGER,
      outcome TEXT CHECK (
        outcome IS NULL OR outcome IN (
          'completed','declined','busy','unanswered',
          'connection_failed','media_failed','blocked','unsupported'
        )
      ),
      groupPeakParticipants INTEGER CHECK (
        groupPeakParticipants IS NULL OR
        groupPeakParticipants BETWEEN 2 AND 6
      ),
      payload TEXT,
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      nextAttemptAt INTEGER NOT NULL DEFAULT 0,
      lastSeenAt INTEGER NOT NULL,
      expiresAt INTEGER NOT NULL,
      UNIQUE(scope, localId)
    )`);
  await d.execute(
    `CREATE INDEX IF NOT EXISTS idx_call_metric_reports_due
     ON call_metric_reports (nextAttemptAt, endedAt)
     WHERE payload IS NOT NULL`,
  );
  // Small-group calls. Additive, the `messages` idiom
  // above: PRAGMA table_info, then ALTER for whatever is missing, so a file
  // already holding real call history gains the columns and loses nothing.
  //
  // ONE ROW PER LEG with a SHARED sessionId. Each row still lands in
  // that peer's 1:1 thread through the untouched `idx_call_log_peer` — no PK
  // rebuild, no rewrite of any existing query — and the aggregate the room
  // thread shows ("Call with Ana, Ben and Cara") is a GROUP BY over this
  // column. Every row written before now has NULL in both, which is what
  // keeps `db.calllog.test.ts` passing unmodified.
  const callLogColumns = (
    (await d.execute(`PRAGMA table_info(call_log)`)).rows as { name: string }[]
  ).map(r => r.name);
  for (const [column, ddl] of [
    ['sessionId', 'sessionId TEXT'],
    ['roomId', 'roomId TEXT'],
  ] as const) {
    if (!callLogColumns.includes(column)) {
      await d.execute(`ALTER TABLE call_log ADD COLUMN ${ddl}`);
    }
  }
  // The decrypted offer for a call that is currently ringing.
  //
  // Needed because the ratchet is one-way. `decryptEnvelope` consumes the
  // message key before the plaintext exists anywhere, so a `call.offer` can
  // be decrypted exactly once — the server redelivering an unacked copy hands
  // back bytes libsignal now refuses (proved in packages/cli/test/
  // redelivery.test.ts). If the app is killed while ringing and the user then
  // answers from the lock screen, THIS row is the only surviving copy of the
  // SDP the answer has to be built against.
  //
  // Deleted the moment the call reaches a terminal state, so in steady state
  // the table holds at most one row and usually none. It is not history —
  // that is `call_log` — and it must not be read for anything a person sees.
  await d.execute(`
    CREATE TABLE IF NOT EXISTS call_offers (
      cid TEXT PRIMARY KEY,
      peerId TEXT NOT NULL,
      sdp TEXT NOT NULL,
      video INTEGER NOT NULL,
      exp INTEGER NOT NULL,
      serverTs INTEGER NOT NULL
    )`);
  // Small-group calls: which SESSION this stored offer belongs to.
  //
  // NOT cosmetic bookkeeping — it is the whole of the session-restore fix. A cold-launch
  // answer must rebuild the SESSION, not one leg: without this column the
  // restore has no way to find the held offers that arrived beside the
  // starter's, so a phone killed mid-ring and answered from the lock screen
  // would come back into a three-way call holding exactly one leg. NULL on
  // every ordinary 1:1 offer.
  const callOfferColumns = (
    (await d.execute(`PRAGMA table_info(call_offers)`)).rows as { name: string }[]
  ).map(r => r.name);
  if (!callOfferColumns.includes('sid')) {
    await d.execute(`ALTER TABLE call_offers ADD COLUMN sid TEXT`);
  }
  // The live small-group call session, written BEFORE CallKit is told to
  // ring and deleted at release — the same persist-before-ring ordering
  // `call_offers` uses, for the same reason: there must be no window in which
  // the system shows a call the app cannot answer.
  //
  // `starterId` is the frame.from of the accepted ginvite and NEVER a payload
  // field (the writerId rule), exactly as `groups.ownerId` is. `roster` is a
  // JSON array and its ORDER is load-bearing: the offer rule decides who offers to whom
  // by roster index, so a restore that sorted it would re-form the mesh with
  // both ends of a leg waiting for the other to offer.
  //
  // It joins DB_TABLES (departure 9). A table outside that list survives
  // sign-out, and the decoy workspace inherits it — here that is a real
  // room's call roster handed to a coerced unlock.
  await d.execute(`
    CREATE TABLE IF NOT EXISTS call_sessions (
      sid       TEXT PRIMARY KEY,
      roomId    TEXT,
      starterId TEXT NOT NULL,
      roster    TEXT NOT NULL,
      se        INTEGER NOT NULL,
      video     INTEGER NOT NULL,
      startedAt INTEGER NOT NULL
    )`);
  // Always-relay, remembered per person.
  //
  // The DECISION lives in `call/policy.ts`; this is only the memory it reads.
  // A row exists for a peer only when a choice was made ABOUT that peer —
  // absent means "no memory", which is what makes the first-call default
  // (`relayForPeer`) reachable at all. Booleans in SQLite are integers, and
  // the CHECK is there because a third value would be silently truthy.
  //
  // IN THE DATABASE RATHER THAN THE KEYCHAIN, which is the opposite of where
  // the app-wide switch lives, and deliberately. This is per-PEER: the set of
  // keys would be the set of people this phone has called, unbounded, and the
  // Keychain survives both a sign-out and a workspace wipe — so a wiped phone
  // would still hold a list of who its owner had spoken to. Here the rows sit
  // inside whichever workspace file is open, so a duress session sees none of
  // them (the `blocked_peers` argument, verbatim) and a sign-out takes them
  // with everything else. It joins DB_TABLES for exactly that reason.
  await d.execute(`
    CREATE TABLE IF NOT EXISTS call_relay_prefs (
      peerId TEXT PRIMARY KEY,
      relay INTEGER NOT NULL CHECK (relay IN (0,1)),
      updatedAt INTEGER NOT NULL
    )`);
  // Unsent words, so leaving a thread (to open a photo, or because the phone
  // was force-quit) is never destructive. Never sent anywhere; cleared with
  // the rest of local state on sign-out.
  await d.execute(`
    CREATE TABLE IF NOT EXISTS drafts (
      peerId TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      mentionState TEXT,
      updatedAt INTEGER NOT NULL
    )`);
  // Mention intent shipped after ordinary string drafts. It remains on the
  // same row so words and their exact local recipient binding are replaced
  // and deleted together; old rows simply read NULL and stay plain text.
  const draftColumns = (
    (await d.execute(`PRAGMA table_info(drafts)`)).rows as { name: string }[]
  ).map(r => r.name);
  if (!draftColumns.includes('mentionState')) {
    await d.execute(`ALTER TABLE drafts ADD COLUMN mentionState TEXT`);
  }
  // Blocking (local-only, this device). Its OWN table, deliberately not a
  // column on `chats`: deleteChat() runs `DELETE FROM chats WHERE peerId = ?`,
  // so a blockedAt column would be erased by deleting the conversation —
  // block-then-delete would silently unblock a harasser. `seen` survives
  // deletion for the same class of reason.
  //
  // A new table needs no ALTER and no PRAGMA table_info dance: the bare
  // CREATE TABLE IF NOT EXISTS is the whole migration, so a file that already
  // holds real conversations gains the table and loses nothing. It sits after
  // the attachments/reactions rebuild branch that re-enters initSchema and
  // returns; the recursive call creates it too, so both orders are correct.
  //
  // Workspace/duress comes free from conn(): the rows live
  // inside whichever file is open, so a duress session sees an empty list and
  // a block recorded under duress stays in the decoy file.
  await d.execute(`
    CREATE TABLE IF NOT EXISTS blocked_peers (
      peerId TEXT PRIMARY KEY,
      blockedAt INTEGER NOT NULL
    )`);
  // Shared Room Vault. Its own table rather than a pinned
  // flag on a message, and the reason is an invariant rather than tidiness: a
  // message's identity is (msgId, direction) and the edit path is author-only
  // BY CONSTRUCTION, so a both-sides-editable message row would break that.
  // It also makes the disappearing-message exemption structural — `sweepExpired`
  // names `messages`/`attachments`/`reactions` and cannot reach here — instead
  // of a condition someone can forget. The announcement rows in `messages` DO
  // expire with the conversation; the item does not. That asymmetry is the
  // feature (a vault item is kept indefinitely, which is a retention
  // INCREASE and is said out loud rather than implied).
  //
  // ONE ROW PER (item, WRITER) — a "slot" — not one row per item. This is the
  // amendment that removed the convergence defects (amended;
  // see `collapseVaultSlots` for the whole argument). A row shared by two
  // writers needs a total order to arbitrate, that order was a wall clock, a
  // wall clock needs a clamp, a clamp is a drop, and on a one-way ratchet a
  // drop is permanent. Giving each writer their own row makes last-write-wins
  // WITHIN a row true by construction rather than by heuristic: a writer's own
  // writes are totally ordered by a counter only that writer allocates, so the
  // merge is `max` over one integer with no tiebreak anywhere.
  //
  // Keyed (peerId, id, writerId). The peer scope is IN the key rather than
  // reached through a JOIN because `id` is chosen by whichever side created the
  // item — (id) alone would be spoofable across conversations, the same defect
  // `reactions.targetDirection` exists to close. `writerId` is in the key and
  // never on the wire: inbound it is `frame.from`, outbound it is my own
  // account id, so slot ownership is authenticated by the ratchet and no
  // payload a peer can construct writes into my slot.
  //
  // `deleted` is a tombstone, not a DELETE: the row survives so a replayed
  // older `set` cannot resurrect an item somebody removed — the same rule as a
  // retracted reaction's emoji ''. `title`/`body` are BLANKED when it is set,
  // and also when a slot is definitively superseded by the other slot, because
  // a row that still held the credential would be a deletion that deleted
  // nothing.
  //
  // `updatedAt` is THIS PHONE'S clock at the moment it applied the row, on both
  // the inbound and the outbound path. It used to be `frame.ts` inbound and
  // `Date.now()` outbound, which meant the list ORDER diverged under clock skew
  // even when the item state agreed. It is display only now; nothing orders by
  // it (see `listVaultItems`).
  //
  // Workspace/duress isolation comes free from conn(): the rows live inside
  // whichever file is open, so a coerced unlock reaches the decoy's vault and
  // never the real one.
  await d.execute(`
    CREATE TABLE IF NOT EXISTS vault_items (
      peerId TEXT NOT NULL,
      id TEXT NOT NULL,
      writerId TEXT NOT NULL,
      seq INTEGER NOT NULL,
      ackSeq INTEGER NOT NULL DEFAULT 0,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      updatedAt INTEGER NOT NULL,
      deleted INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (peerId, id, writerId)
    )`);
  await d.execute(
    `CREATE INDEX IF NOT EXISTS idx_vault_items_peer
     ON vault_items (peerId, id)`,
  );
  // Dev-stage schema step, the same shape the attachments/reactions rebuild
  // above uses. The vault shipped once with a (peerId, id) key and a `version`
  // column holding a sender wall clock; that key cannot be widened by ALTER, so
  // a file carrying the old shape is rebuilt.
  //
  // The rows are CARRIED OVER rather than dropped — this table is the one place
  // on the phone where losing a row means losing the only copy of a credential.
  // Each old row becomes exactly ONE slot, so the migration cannot manufacture
  // a disagreement out of nothing.
  //
  // The old `version` is DISCARDED, not translated. A millisecond clock and a
  // per-writer counter are not the same measure, and carrying the number
  // forward would import exactly the skew poison the amendment removed —
  // including any row already sitting a day in the future. `ackSeq = 0` says
  // "this write had seen nothing of yours", which is the honest reading of a
  // frame from a build that had no way to say what it had seen.
  //
  // An empty PRAGMA answer means the table was only just created (or cannot be
  // read), so there is nothing to migrate and the branch is skipped: the bare
  // CREATE TABLE IF NOT EXISTS above is still the whole migration for a fresh
  // file, and no DROP is ever issued on one.
  const vaultColumns = (
    (await d.execute(`PRAGMA table_info(vault_items)`)).rows as { name: string }[]
  ).map(r => r.name);
  if (vaultColumns.length > 0 && !vaultColumns.includes('seq')) {
    const legacy = (
      await d.execute(
        `SELECT peerId, id, title, body, writerId, updatedAt, deleted
         FROM vault_items`,
      )
    ).rows as unknown as {
      peerId: string;
      id: string;
      title: string;
      body: string;
      writerId: string;
      updatedAt: number;
      deleted: number;
    }[];
    await d.execute(`DROP TABLE vault_items`);
    await initSchema(d);
    for (const row of legacy) {
      await d.execute(
        `INSERT OR IGNORE INTO vault_items
           (peerId, id, writerId, seq, ackSeq, title, body, updatedAt, deleted)
         VALUES (?, ?, ?, 1, 0, ?, ?, ?, ?)`,
        [
          row.peerId,
          row.id,
          row.writerId,
          row.title,
          row.body,
          row.updatedAt,
          row.deleted,
        ],
      );
    }
    return;
  }
  // Rooms. Bare CREATE TABLE IF NOT EXISTS is the whole
  // migration, as blocked_peers was: a file already holding real conversations
  // gains the tables and loses nothing. All of them join DB_TABLES or they
  // survive sign-out and leak real rooms into the decoy workspace.
  //
  // The room's ANCHOR: the constants that must outlive a local delete
  // exactly as a peer's session outlives deleteChat — written once at accept,
  // never updated by any later write, and removed only by a counted grp.del,
  // a sign-out, or deleteGroup's full-purge variant. ownerId is the
  // frame.from of the accepted grp.new — NEVER a payload field.
  // distributionId is reserved NULL (sender-key swap) and never read.
  await d.execute(`
    CREATE TABLE IF NOT EXISTS groups (
      groupId  TEXT PRIMARY KEY,
      ownerId  TEXT NOT NULL,
      name     TEXT,
      distributionId TEXT
    )`);
  // Membership slots, winner per (groupId, memberId, writerId) — the same
  // per-writer CRDT shape as vault_items, and the key IS the storage bound:
  // at most two rows per member plus the capped hostile-owner margin.
  // updatedAt is THIS PHONE'S clock at the moment it applied the row, on both
  // paths, and is display-only — nothing orders by it.
  await d.execute(`
    CREATE TABLE IF NOT EXISTS group_members (
      groupId  TEXT NOT NULL,
      memberId TEXT NOT NULL,
      writerId TEXT NOT NULL,     -- NEVER on the wire: frame.from / my own id.
                                  -- Only two lanes ever store: writerId =
                                  -- memberId (sovereign self) or writerId =
                                  -- groups.ownerId (authority). Anything else
                                  -- declines and stores nothing (the
                                  -- two-lane rule).
                                  --
                                  -- FOR THE OWNER'S OWN ROW THE TWO LANES ARE
                                  -- ONE ROW, and that is deliberate. When
                                  -- memberId = writerId = ownerId this key
                                  -- admits a single row, so the fold counts it
                                  -- in BOTH lanes (found in
                                  -- implementation). Do NOT "fix" this by widening
                                  -- the key to split them: the merged row is
                                  -- what keeps rule 2 true for the owner --
                                  -- that they can always rejoin their own room
                                  -- -- and splitting the lanes silently breaks
                                  -- it. The merged row is also cap-exempt, so
                                  -- a hostile owner cannot flood themselves
                                  -- out of their own room.
      seq      INTEGER NOT NULL,
      state    TEXT NOT NULL CHECK (state IN ('in','out')),
      updatedAt INTEGER NOT NULL,
      -- The roster-write member class:
      -- 'integration' when the write carried the writer's claim that this
      -- member is a machine; NULL = unknown/human, the only safe default.
      -- Stored verbatim with its slot; MEANING is the fold's call (authority
      -- lane only — group-fold.ts GroupFold.classes), and it is raise-only
      -- informational: nothing may admit, exclude from membership, or gate
      -- delivery on it. Pre-existing tables gain it via the ALTER below.
      class    TEXT,
      PRIMARY KEY (groupId, memberId, writerId)
    )`);
  // The additive migration for tables that predate `class` — the messages
  // ALTER-list pattern, one column.
  const groupMemberColumns = (
    (await d.execute(`PRAGMA table_info(group_members)`)).rows as {
      name: string;
    }[]
  ).map(r => r.name);
  if (!groupMemberColumns.includes('class')) {
    await d.execute(`ALTER TABLE group_members ADD COLUMN class TEXT`);
  }
  // Per-writer timer slots, winner per (groupId, writerId).
  await d.execute(`
    CREATE TABLE IF NOT EXISTS group_settings (
      groupId  TEXT NOT NULL,
      writerId TEXT NOT NULL,
      seq      INTEGER NOT NULL,
      disappearSec INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (groupId, writerId)
    )`);
  // MY OWN allocators for the two counters a room needs (see reserveGroupSeq):
  // 'writer' numbers my grp.new/grp.roster/grp.set writes, 'msg' numbers
  // messages.sq on my own outbound messages.
  //
  // NOT in the original design, and here is why it exists anyway: the counters
  // cannot live inside the three slot tables without poisoning a lane. Bumping
  // my sovereign group_members row would let a message send out-run my own
  // later leave (the leave's lower seq loses to the inflated row and my own
  // phone refuses it while every peer applies it), and a sentinel row in
  // either slot table leaks into the fold, the rd digest or the owner-lane
  // cap. A counter is not a slot, so it gets a table that no fold reads.
  //
  // It lives and dies with the slots: a local delete keeps it — a
  // counter that reset would make my next write reuse a number some peer
  // already holds, and on a max-merge lane a reused number is a permanent,
  // silent mute — and the counted grp.del purge removes it with the room.
  await d.execute(`
    CREATE TABLE IF NOT EXISTS group_counters (
      groupId TEXT NOT NULL,
      scope   TEXT NOT NULL CHECK (scope IN ('writer','msg')),
      seq     INTEGER NOT NULL,
      PRIMARY KEY (groupId, scope)
    )`);
  // Approvals. Its OWN table on the vault_items
  // pattern — the bare CREATE TABLE IF NOT EXISTS is the whole migration —
  // and deliberately NOT a messages row, for the three reasons the
  // defect map recorded: a messages row would hold a command line at rest, its arrivedAt stamp is what the unread query counts while the
  // thread filter keeps it invisible (the phantom unread), and its carrier
  // preview would blank the chat's last words. The card is derived at render
  // time from THIS table, the way call chips derive from call_log.
  //
  // Keyed (peerId, q): `q` is chosen by the asking machine, so alone it
  // would be spoofable across conversations — the same defect vault_items'
  // peer scope closes. INSERT ... DO NOTHING under this key is the
  // single-use rule at rest: a replayed or re-bound second frame for a `q`
  // this phone already holds changes nothing (a settled or lapsed id is
  // burned — the CLI's journal says the same thing on its side).
  //
  // `state` mirrors the spine's shape (pending → answered | lapsed). All
  // deadlines run on the CLI's clock; `arrivedAt` (THIS phone's clock at
  // persist) plus `ttlSec` is only what the countdown and the local
  // grey-out derive from — display, never authorization.
  //
  // `payload` is the exact bytes the machine will run, so it is the
  // highest-sensitivity string in this file after the vault: settled rows
  // are redacted to their byte count after APPROVAL_REDACT_AFTER_MS and
  // aged out after APPROVAL_RETAIN_MS (both mirroring the CLI journal's
  // posture), and the table is in DB_TABLES so sign-out wipes it and the
  // decoy workspace never inherits a real machine's command lines.
  await d.execute(`
    CREATE TABLE IF NOT EXISTS approvals (
      peerId TEXT NOT NULL,
      q TEXT NOT NULL,
      wireMsgId TEXT NOT NULL,
      kind TEXT NOT NULL,
      payload TEXT NOT NULL,
      payloadBytes INTEGER NOT NULL,
      ttlSec INTEGER NOT NULL,
      sessionTag TEXT,
      verbs TEXT NOT NULL,
      ts INTEGER NOT NULL,
      arrivedAt INTEGER NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending'
        CHECK (state IN ('pending','answered','lapsed')),
      answerVerb TEXT,
      settledAt INTEGER,
      PRIMARY KEY (peerId, q)
    )`);
  // Supplementary work facts never participate in the approval binding. The
  // original q/p pair above remains the complete authorization; these
  // columns only explain captured context and later host observations.
  const approvalColumns = (
    (await d.execute(`PRAGMA table_info(approvals)`)).rows as { name: string }[]
  ).map(r => r.name);
  for (const [column, ddl] of [
    ['workJson', 'workJson TEXT'],
    ['workReceivedAt', 'workReceivedAt INTEGER'],
    ['hostObservation', 'hostObservation TEXT'],
    ['hostObservationProvider', 'hostObservationProvider TEXT'],
    ['hostObservationSourceAt', 'hostObservationSourceAt INTEGER'],
    ['hostObservationReceivedAt', 'hostObservationReceivedAt INTEGER'],
  ] as const) {
    if (!approvalColumns.includes(column)) {
      await d.execute(`ALTER TABLE approvals ADD COLUMN ${ddl}`);
    }
  }
  // Canonical event ids are deduplicated only within their authenticated
  // peer. runTag stays a display/grouping hint and cannot occupy this key.
  await d.execute(`
    CREATE TABLE IF NOT EXISTS ai_work_events (
      peerId TEXT NOT NULL,
      eventId TEXT NOT NULL,
      wireMsgId TEXT NOT NULL,
      provider TEXT NOT NULL,
      event TEXT NOT NULL,
      project TEXT,
      projectReceivedAt INTEGER,
      requestId TEXT,
      runTag TEXT,
      originKind TEXT NOT NULL DEFAULT 'profile',
      sourceRef TEXT,
      workJson TEXT NOT NULL,
      contextJson TEXT,
      contextReceivedAt INTEGER,
      sourceAt INTEGER NOT NULL,
      displayAt INTEGER NOT NULL,
      timeTrusted INTEGER NOT NULL,
      receivedAt INTEGER NOT NULL,
      PRIMARY KEY (peerId, eventId)
    )`);
  const aiWorkEventColumns = (
    (await d.execute(`PRAGMA table_info(ai_work_events)`)).rows as { name: string }[]
  ).map(row => row.name);
  if (!aiWorkEventColumns.includes('originKind')) {
    await d.execute(
      `ALTER TABLE ai_work_events ADD COLUMN originKind TEXT NOT NULL DEFAULT 'profile'`,
    );
  }
  if (!aiWorkEventColumns.includes('sourceRef')) {
    await d.execute(`ALTER TABLE ai_work_events ADD COLUMN sourceRef TEXT`);
  }
  for (const [column, ddl] of [
    ['projectReceivedAt', 'projectReceivedAt INTEGER'],
    ['contextJson', 'contextJson TEXT'],
    ['contextReceivedAt', 'contextReceivedAt INTEGER'],
  ] as const) {
    if (!aiWorkEventColumns.includes(column)) {
      await d.execute(`ALTER TABLE ai_work_events ADD COLUMN ${ddl}`);
    }
  }
  await d.execute(
    `CREATE INDEX IF NOT EXISTS idx_ai_work_events_received
     ON ai_work_events (receivedAt, peerId, eventId)`,
  );
  // Latest source-backed facts for one integration. Optional fields merge
  // independently: an event with no usage must not erase a previously
  // reported budget, while an explicit unavailable context does replace it.
  await d.execute(`
    CREATE TABLE IF NOT EXISTS ai_agent_state (
      peerId TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      project TEXT,
      projectReceivedAt INTEGER,
      projectWireMsgId TEXT,
      projectOriginKind TEXT,
      capabilitiesJson TEXT,
      capabilitiesReceivedAt INTEGER,
      contextJson TEXT,
      contextReceivedAt INTEGER,
      contextWireMsgId TEXT,
      contextOriginKind TEXT,
      usageJson TEXT,
      usageReceivedAt INTEGER,
      lastSourceAt INTEGER NOT NULL,
      lastDisplayAt INTEGER NOT NULL,
      lastTimeTrusted INTEGER NOT NULL,
      lastReceivedAt INTEGER NOT NULL
    )`);
  const aiAgentStateColumns = (
    (await d.execute(`PRAGMA table_info(ai_agent_state)`)).rows as { name: string }[]
  ).map(row => row.name);
  for (const [column, ddl] of [
    ['projectReceivedAt', 'projectReceivedAt INTEGER'],
    ['projectWireMsgId', 'projectWireMsgId TEXT'],
    ['projectOriginKind', 'projectOriginKind TEXT'],
    ['contextWireMsgId', 'contextWireMsgId TEXT'],
    ['contextOriginKind', 'contextOriginKind TEXT'],
  ] as const) {
    if (!aiAgentStateColumns.includes(column)) {
      await d.execute(`ALTER TABLE ai_agent_state ADD COLUMN ${ddl}`);
    }
  }
  // Machines this account PAIRED, as the server itself confirmed them
  // (the knowledge-source rule is in machine.ts).
  // Written in exactly two places — the adopt and revoke 204 handlers on the
  // peer profile — and NEVER from anything a peer sends: an envelope, a
  // display name, or an approval frame must not be able to put a row here,
  // because this table is what the AI badge derives from and a peer-writable
  // row would be the spoof the badge exists to prevent. Append-only
  // (DO NOTHING on conflict): a class is never acquired, shed, or spoofed
  // after birth, so a revoked machine's history keeps its marker.
  await d.execute(`
    CREATE TABLE IF NOT EXISTS machine_peers (
      peerId TEXT PRIMARY KEY,
      learnedAt INTEGER NOT NULL
    )`);
  // Successful integration revocations, learned only from the owner-called
  // server route. Unlike machine_peers' immutable class, this is lifecycle:
  // once this key is retired, late/replayed approval frames may never become
  // actionable again. Separate so historical AI attribution survives while
  // live capability does not.
  await d.execute(`
    CREATE TABLE IF NOT EXISTS revoked_machine_peers (
      peerId TEXT PRIMARY KEY,
      revokedAt INTEGER NOT NULL
    )`);
  // The consent record (DARK). This user's own per-agent decision, keyed to the agent
  // account: 'consented' or 'refused', undecided = no row. LOCAL ONLY in
  // this phase: no server write, no envelope, no group announcement — the
  // server-stored consent edge, the delivery enforcement and the
  // group-visible roster event come later, and this table is the record that
  // phase will announce from. A decision is the user's own and revisable
  // (unlike machine_peers' birth-permanent class), so the write is an
  // upsert, not append-only. In DB_TABLES: which agents this person refused
  // is exactly the kind of relationship a coerced unlock must not inherit.
  await d.execute(`
    CREATE TABLE IF NOT EXISTS agent_consent (
      peerId TEXT PRIMARY KEY,
      state TEXT NOT NULL CHECK (state IN ('consented','refused')),
      decidedAt INTEGER NOT NULL
    )`);
  // Linked devices. Three tables, all local
  // truth rendered from ceremony results and server fan-out notices — the
  // server serves rosters only inside prekey-bundle responses, so what the
  // "Linked devices" screen shows is this device's own record.
  //
  // `link_group` is a single-row table (the CHECK pins the key): this
  // account's groupId + the last roster epoch this device saw. No row =
  // never linked — the anonymous default, structurally.
  await d.execute(`
    CREATE TABLE IF NOT EXISTS link_group (
      key TEXT PRIMARY KEY CHECK (key = 'group'),
      groupId TEXT NOT NULL,
      rosterEpoch INTEGER NOT NULL
    )`);
  // One row per member device ULID ever seen in this account's roster.
  // `state` keeps revoked/unlinked rows AS HISTORY (the loud device-list
  // discipline: an event stays visible) while the roster UI lists only
  // 'linked' rows — which is exactly how "a revoked device disappears from
  // the roster" is enforced and tested. `certsJson` carries the link
  // certificates where this device holds them (availability, never
  // authority — peers verify certs against their own pinned keys).
  await d.execute(`
    CREATE TABLE IF NOT EXISTS linked_devices (
      userId TEXT PRIMARY KEY,
      class TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('linked','revoked','unlinked')),
      updatedAt INTEGER NOT NULL,
      certsJson TEXT
    )`);
  // The pending inbound link offer on the NEW device, durable
  // because the queue row is acked once this row exists: a relaunch between
  // ack and confirmation must still be able to show the ceremony. At most
  // one pending offer is ever shown; expiry is enforced at read time from
  // the notice's own expiresAt (explicit-expiry discipline — reaping is
  // cleanup, never the enforcement).
  await d.execute(`
    CREATE TABLE IF NOT EXISTS link_pending_offer (
      offerNonce TEXT PRIMARY KEY,
      noticeJson TEXT NOT NULL,
      receivedAt INTEGER NOT NULL
    )`);
  // The OFFERER's own submitted-but-uncommitted offer: the
  // server deliberately excludes the ceremony parties from the memberLinked
  // fan-out, so this single row is the only durable path by which the
  // offering device learns its acceptance committed after the scan screen
  // unmounted. Consumed by the completion probe; expired rows reap at read.
  await d.execute(`
    CREATE TABLE IF NOT EXISTS link_pending_ceremony (
      key TEXT PRIMARY KEY CHECK (key = 'offer'),
      offerJson TEXT NOT NULL,
      createdAt INTEGER NOT NULL
    )`);
  // Each member's identity public key as
  // this device holds it — what member* notice signatures and sibling
  // certificates verify against ("pinned keys", locally recorded at the
  // same TOFU/ceremony moment the native store pins them). Additive column;
  // the ALTER is a no-op wherever a fresh CREATE above already ran, and
  // the duplicate-column error on an existing file is exactly that.
  await d
    .execute(`ALTER TABLE linked_devices ADD COLUMN identityKeyPub TEXT NOT NULL DEFAULT ''`)
    .catch(() => undefined);
  // A PEER's device set: server-attested hint,
  // client-verified truth. One row per device ULID; `anchorId` names the
  // contact the device belongs to (`= userId` for the contact itself and
  // for a standalone device); `state` carries the TOFU verdict — 'linked'
  // cross-signed, 'pending' the block-and-warn hold, 'removed'/'revoked'
  // via verified signed notices (terminal, never resurrected).
  await d.execute(`
    CREATE TABLE IF NOT EXISTS peer_devices (
      userId TEXT PRIMARY KEY,
      anchorId TEXT NOT NULL,
      class TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('linked','pending','removed','revoked')),
      identityKeyPub TEXT NOT NULL DEFAULT '',
      certsJson TEXT NOT NULL DEFAULT '',
      updatedAt INTEGER NOT NULL
    )`);
  // The signed roster-mutation request, persisted byte-identical BEFORE the
  // call leaves this device (the permitted
  // completion re-drive): a crash between commit and teardown
  // is re-driven by re-sending the SAME signed tuple within its explicit
  // expiry — the nonce is single-use for roster effect, and the epoch
  // condition (not this row) is what makes the replay harmless.
  await d.execute(`
    CREATE TABLE IF NOT EXISTS link_pending_mutation (
      offerNonce TEXT PRIMARY KEY,
      op TEXT NOT NULL CHECK (op IN ('unlink','revoke')),
      bodyJson TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      expiresAt INTEGER NOT NULL
    )`);
  // The machine-peers each OWN sibling device reports through sibling sync: which integration-class accounts a
  // sibling owns, so a revoke can honestly name the victim's agents
  // (`boundAgents`) from local truth the server refuses to
  // serve.
  await d.execute(`
    CREATE TABLE IF NOT EXISTS sibling_machine_peers (
      agentId TEXT NOT NULL,
      deviceUserId TEXT NOT NULL,
      updatedAt INTEGER NOT NULL,
      PRIMARY KEY (agentId, deviceUserId)
    )`);
  // The account's optional identifiers as THIS device knows them
  // (ONE ROW PER CLASS: the earlier single email-specific row
  // could not represent two classes, and per-class consent must be
  // STRUCTURAL, never a shared Boolean). LOCAL truth by construction: the
  // server never echoes an identifier back (it stores only the keyed
  // hash), so the Settings surfaces render what this device itself
  // attached. `kind` is the class; each class's `discoverable`, pending
  // state, and `restoredAt` live on its OWN row, which is what makes
  // "email consent never implies phone consent" a schema fact.
  await d.execute(`
    CREATE TABLE IF NOT EXISTS account_identifier (
      kind TEXT PRIMARY KEY CHECK (kind IN ('email','phone','username')),
      value TEXT,
      verifiedAt INTEGER,
      discoverable INTEGER NOT NULL DEFAULT 0,
      pendingValue TEXT,
      pendingRequestedAt INTEGER,
      restoredAt INTEGER,
      serverSince INTEGER
    )`);
  // THE PER-CLASS REBUILD MIGRATION (the chats-table discipline:
  // PRAGMA-detect the old shape, then rebuild CARRYING the data; the bare
  // CREATE above is the whole migration for a fresh file). An earlier-era file
  // holds the single `key = 'identifier'` email row: it migrates to
  // `kind = 'email'` with its columns carried, raw-equal — phone-ux drives
  // exactly that on the real engine. `restoredAt` may still be missing on
  // an older file (its old ALTER lived here), so it
  // is added before the carry reads it.
  const accountIdentifierCols = (
    (await d.execute(`PRAGMA table_info(account_identifier)`)).rows as {
      name: string;
    }[]
  ).map(c => c.name);
  if (accountIdentifierCols.includes('key')) {
    if (!accountIdentifierCols.includes('restoredAt')) {
      await d.execute(`ALTER TABLE account_identifier ADD COLUMN restoredAt INTEGER`);
    }
    // ONE TRANSACTION AROUND THE WHOLE REBUILD:
    // as bare autocommitted statements, a crash after the RENAME (or after
    // the new CREATE) left the NEW shape on disk with the data stranded in
    // the _ac8 table — the next launch's PRAGMA saw no 'key' column,
    // skipped this branch forever, and the landed email consent silently
    // vanished. Atomic, the crash rolls the file back to the OLD shape and
    // the next launch re-detects and re-runs: rename → create → carry →
    // drop commit together or not at all.
    await d.execute('BEGIN IMMEDIATE');
    try {
      await d.execute(`ALTER TABLE account_identifier RENAME TO account_identifier_ac8`);
      await d.execute(`
        CREATE TABLE account_identifier (
          kind TEXT PRIMARY KEY CHECK (kind IN ('email','phone','username')),
          value TEXT,
          verifiedAt INTEGER,
          discoverable INTEGER NOT NULL DEFAULT 0,
          pendingValue TEXT,
          pendingRequestedAt INTEGER,
          restoredAt INTEGER
        )`);
      await d.execute(`
        INSERT INTO account_identifier
          (kind, value, verifiedAt, discoverable, pendingValue, pendingRequestedAt, restoredAt)
        SELECT 'email', email, verifiedAt, discoverable, pendingEmail, pendingRequestedAt, restoredAt
        FROM account_identifier_ac8 WHERE key = 'identifier'`);
      await d.execute(`DROP TABLE account_identifier_ac8`);
      await d.execute('COMMIT');
    } catch (error) {
      await d.execute('ROLLBACK').catch(() => undefined);
      throw error;
    }
  }
  // THE CHECK-WIDENING MIGRATION: an earlier file
  // pins `kind IN ('email','phone')` in the table's own CHECK, and SQLite
  // cannot alter a CHECK in place — so the same rebuild-carrying-the-data
  // discipline runs once more, detected off the table's recorded DDL (a
  // PRAGMA cannot see a CHECK). Both landed rows are carried column for
  // column, raw-equal; the bare CREATE above is the whole migration for a
  // fresh file, and a file already carrying the widened CHECK skips this.
  // `recovery_local` is DELIBERATELY NOT widened: the username class is
  // recovery-excluded absolutely, and its CHECK refusing the kind is
  // that exclusion made structural on this device.
  const accountIdentifierDdl = (
    (await d.execute(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'account_identifier'`,
    )).rows as { sql: string }[]
  )[0]?.sql;
  if (accountIdentifierDdl !== undefined && !accountIdentifierDdl.includes("'username'")) {
    await d.execute('BEGIN IMMEDIATE');
    try {
      await d.execute(`ALTER TABLE account_identifier RENAME TO account_identifier_acp3`);
      await d.execute(`
        CREATE TABLE account_identifier (
          kind TEXT PRIMARY KEY CHECK (kind IN ('email','phone','username')),
          value TEXT,
          verifiedAt INTEGER,
          discoverable INTEGER NOT NULL DEFAULT 0,
          pendingValue TEXT,
          pendingRequestedAt INTEGER,
          restoredAt INTEGER
        )`);
      await d.execute(`
        INSERT INTO account_identifier
          (kind, value, verifiedAt, discoverable, pendingValue, pendingRequestedAt, restoredAt)
        SELECT kind, value, verifiedAt, discoverable, pendingValue, pendingRequestedAt, restoredAt
        FROM account_identifier_acp3`);
      await d.execute(`DROP TABLE account_identifier_acp3`);
      await d.execute('COMMIT');
    } catch (error) {
      await d.execute('ROLLBACK').catch(() => undefined);
      throw error;
    }
  }
  // THE SERVER-STAMP COLUMN (the proof pass, 2026-10-08): `serverSince` is
  // the server's own birth stamp of the live row this device wrote (the
  // state route's `usernameSince` / `emailSince`, read back right after the
  // write), so a later read tells this row from a sibling's by EXACT
  // equality instead of comparing two clocks. An older file (and the two
  // rebuilds above, which carry the columns they know) lacks it: added in
  // place — NULL means "no stamp", and the skew rule governs that row.
  const accountIdentifierColsNow = (
    (await d.execute(`PRAGMA table_info(account_identifier)`)).rows as {
      name: string;
    }[]
  ).map(c => c.name);
  if (!accountIdentifierColsNow.includes('serverSince')) {
    await d.execute(`ALTER TABLE account_identifier ADD COLUMN serverSince INTEGER`);
  }
  // A recovery THIS device started: the groupId + completesAt the
  // verify leg answered, held so the pending state survives a relaunch and
  // completion can name the group. Deleted on completion or abandonment.
  // `kind` is deliberate: restoration is TYPED — completion
  // writes the recovered identifier under the pending row's OWN kind, so a
  // phone recovery never resurrects as an email row.
  await d.execute(`
    CREATE TABLE IF NOT EXISTS recovery_local (
      key TEXT PRIMARY KEY CHECK (key = 'recovery'),
      kind TEXT NOT NULL CHECK (kind IN ('email','phone')),
      value TEXT NOT NULL,
      groupId TEXT NOT NULL,
      completesAt INTEGER NOT NULL,
      verifiedAt INTEGER NOT NULL
    )`);
  // The recovery_local half of the rebuild (same discipline): a
  // pre-migration STARTED recovery defaults to 'email' — the only kind
  // that could have started one.
  const recoveryLocalCols = (
    (await d.execute(`PRAGMA table_info(recovery_local)`)).rows as {
      name: string;
    }[]
  ).map(c => c.name);
  if (recoveryLocalCols.includes('email')) {
    // The same one-transaction rebuild discipline: a
    // crash mid-rebuild must never strand a STARTED recovery in the _ac8
    // table behind a fresh empty new-shape table.
    await d.execute('BEGIN IMMEDIATE');
    try {
      await d.execute(`ALTER TABLE recovery_local RENAME TO recovery_local_ac8`);
      await d.execute(`
        CREATE TABLE recovery_local (
          key TEXT PRIMARY KEY CHECK (key = 'recovery'),
          kind TEXT NOT NULL CHECK (kind IN ('email','phone')),
          value TEXT NOT NULL,
          groupId TEXT NOT NULL,
          completesAt INTEGER NOT NULL,
          verifiedAt INTEGER NOT NULL
        )`);
      await d.execute(`
        INSERT INTO recovery_local (key, kind, value, groupId, completesAt, verifiedAt)
        SELECT 'recovery', 'email', email, groupId, completesAt, verifiedAt
        FROM recovery_local_ac8 WHERE key = 'recovery'`);
      await d.execute(`DROP TABLE recovery_local_ac8`);
      await d.execute('COMMIT');
    } catch (error) {
      await d.execute('ROLLBACK').catch(() => undefined);
      throw error;
    }
  }
  // The latest recovery notice this MEMBER device received (loudness —
  // the client half). One row,
  // latest state wins: requested → cancelled/completed is the whole
  // lifecycle a surviving member can see.
  await d.execute(`
    CREATE TABLE IF NOT EXISTS recovery_notice (
      key TEXT PRIMARY KEY CHECK (key = 'notice'),
      kind TEXT NOT NULL CHECK (kind IN ('requested','completed','cancelled')),
      groupId TEXT NOT NULL,
      class TEXT,
      completesAt INTEGER,
      receivedAt INTEGER NOT NULL
    )`);
  // The operator revocation of this account's username, as this device
  // received it (`usernameRevoked`, kind only).
  // One row, latest wins; cleared when the owner dismisses it. Written by
  // the notice parser in EVERY binary (the arming order's client half);
  // rendered only under USERNAME_UI_ENABLED.
  await d.execute(`
    CREATE TABLE IF NOT EXISTS username_notice (
      key TEXT PRIMARY KEY CHECK (key = 'notice'),
      receivedAt INTEGER NOT NULL
    )`);
  // The unlink THIS device performed: the
  // name it let go and when. An unlink stamps the server's 30-day cool-down
  // exactly as a rename does, and the refusal of a different name inside it
  // is the reasonless 403 by design — so this row is the only place the
  // claim form can learn to warn before the tap. One row, latest wins;
  // cleared by the next claim that lands. Rendered only under
  // USERNAME_UI_ENABLED.
  await d.execute(`
    CREATE TABLE IF NOT EXISTS username_unlink (
      key TEXT PRIMARY KEY CHECK (key = 'unlink'),
      username TEXT NOT NULL,
      unlinkedAt INTEGER NOT NULL
    )`);
  // The end of the username cool-down THIS device started (§4.8,
  // 2026-10-08 — U2): a rename stamps the
  // server's 30-day window exactly as an unlink does, and the refusal of
  // the next change is the reasonless 403 by design, so the device keeps
  // the window's end for EVERY verb that stamps it, not only the unlink.
  // One row, latest wins; kept by a take-back (the server's window runs
  // on), cleared by a claim that lands with no window running. The state
  // route carries the same fact for siblings and reinstalls; this row is
  // the offline fallback. Rendered only under USERNAME_UI_ENABLED.
  await d.execute(`
    CREATE TABLE IF NOT EXISTS username_cooldown (
      key TEXT PRIMARY KEY CHECK (key = 'cooldown'),
      until INTEGER NOT NULL
    )`);
  // Per-PAIR verification match records (the design row
  // 26b): a matched/mismatch stamp per peer DEVICE, beside the chat-level
  // record the anchor pair keeps in `chats`. Local to this device like every
  // verification record — a human act is never synced.
  await d.execute(`
    CREATE TABLE IF NOT EXISTS peer_device_safety (
      userId TEXT PRIMARY KEY,
      checkedAt INTEGER,
      mismatchAt INTEGER
    )`);
}

// --- profile ---

export async function loadProfile(): Promise<ProfileRow | null> {
  const res = await conn().execute(`SELECT key, value FROM profile`);
  const map = new Map<string, string>();
  for (const row of res.rows as { key: string; value: string }[]) {
    map.set(row.key, row.value);
  }
  const userId = map.get('userId');
  const registrationId = map.get('registrationId');
  // The two rows without which there is no usable account. `phone` used to be
  // a third, and dropping it from this check is what lets a file written by an
  // older build keep loading: the number is simply never asked for again.
  if (!userId || !registrationId) return null;
  return {
    userId,
    registrationId: Number(registrationId),
    displayName: map.get('displayName') ?? '',
    about: map.get('about') ?? '',
    avatarB64: map.get('avatarB64') ?? '',
    profileVersion: Number(map.get('profileVersion') ?? '0'),
  };
}

export async function saveProfile(profile: ProfileRow): Promise<void> {
  const d = conn();
  // Every key that makes up a ProfileRow, written together. This list and
  // `loadProfile`'s reads are one projection in two halves — the CHAT_COLUMNS
  // comment below records what happens when a pair like this drifts apart.
  const rows: [string, string][] = [
    ['userId', profile.userId],
    ['registrationId', String(profile.registrationId)],
    ['displayName', profile.displayName],
    ['about', profile.about],
    ['avatarB64', profile.avatarB64],
    ['profileVersion', String(profile.profileVersion)],
  ];
  for (const [key, value] of rows) {
    await d.execute(
      `INSERT OR REPLACE INTO profile (key, value) VALUES (?, ?)`,
      [key, value],
    );
  }
  // The phone number an older build wrote here.
  //
  // THE DECISION, and where it lives, stated because the placement is the
  // interesting half. `profile` is key/value, so a phone number is a ROW, not
  // a column: there is no ALTER to run, no explicit projection that could
  // silently start returning undefined, and the only reader there ever was
  // (`map.get('phone')` in loadProfile) is gone. So the usual "leave a dropped
  // column unread, it is safer" reasoning does not apply — nothing can break —
  // and what leaving it WOULD do is keep a real phone number sitting in a
  // plaintext SQLite file belonging to an app that no longer has any use for
  // one. That is exactly the residue this feature exists to delete. It goes.
  //
  // But it goes HERE, on the write path, and deliberately not in `initSchema`:
  // this repo guards "opening the database destroys nothing" in two separate
  // tests, and one line of residue purging is not worth spending an invariant
  // that valuable. A caller of saveProfile is already rewriting the whole
  // profile projection, so removing a key that is no longer part of it is that
  // caller's own write finishing the job.
  //
  // HONEST LIMIT: an install that never writes a profile again keeps the row,
  // unread, until sign-out (`clearLocalState` empties the table). Every path
  // that mints or re-authenticates an account passes through here, so the
  // window is "upgraded, and nothing has happened since".
  await d.execute(`DELETE FROM profile WHERE key = 'phone'`);
}

/**
 * Update the parts of my profile people see, stamping a new version. Returns
 * the saved row so the caller can share the card straight away.
 */
export async function saveMyProfileCard(fields: {
  displayName: string;
  about: string;
  avatarB64: string;
  version: number;
}): Promise<ProfileRow | null> {
  const d = conn();
  for (const [key, value] of [
    ['displayName', fields.displayName],
    ['about', fields.about],
    ['avatarB64', fields.avatarB64],
    ['profileVersion', String(fields.version)],
  ] as const) {
    await d.execute(
      `INSERT OR REPLACE INTO profile (key, value) VALUES (?, ?)`,
      [key, value],
    );
  }
  return loadProfile();
}

export const DB_TABLES = [
  'profile',
  'chats',
  'messages',
  'seen',
  'outbox',
  'attachments',
  'reactions',
  'drafts',
  'pending_revisions',
  // Call history is local state like any other: it must not outlive a
  // sign-out, and the decoy workspace must never inherit real calls.
  'call_log',
  // Active drafts and queued aggregate reports are local lifecycle state.
  // They must not survive a sign-out or appear in a decoy workspace.
  'call_metric_reports',
  // Holds a live SDP, which carries the DTLS fingerprint and (without
  // always-relay) candidate addresses. Wiping it matters more than wiping
  // history, not less.
  'call_offers',
  // Small-group calls. The original design
  // said calls needed no decoy work; that was true of the two tables above
  // and is NOT true of this one. A `call_sessions` row is a real room's call
  // ROSTER — who was on a call with whom — and a table missing from this list
  // survives sign-out into the decoy workspace, which hands a coerced unlock
  // exactly the membership the decoy exists to hide.
  'call_sessions',
  // Per-person always-relay memory. A row names someone this phone has
  // called and a choice made about them, so it is exactly the shape of thing
  // that must not survive a sign-out into a decoy workspace.
  'call_relay_prefs',
  // Blocks are wiped by a sign-out / inconsistent-boot recovery, and this is
  // intended: a wipe is a wipe, and there is no identity left for a block to
  // protect. (Deleting one CONVERSATION is a different act — see deleteChat.)
  'blocked_peers',
  // The highest-value strings on the phone: door codes, Wi-Fi passwords,
  // logins. Forgetting this line would mean sign-out, account deletion and
  // inconsistent-boot recovery each leave plaintext credentials in SQLite, and
  // a decoy rebuild inherit the real ones. Wiping it matters
  // more than wiping history, not less.
  'vault_items',
  // Rooms. A group table missing here survives
  // sign-out — real room ids, owners and rosters left in plaintext SQLite —
  // and the decoy workspace inherits them, which hands a coerced unlock the
  // exact membership list the decoy exists to hide. group_counters carries
  // room ids too, so it is in the wipe for the same reason as the other
  // three.
  'groups',
  'group_members',
  'group_settings',
  'group_counters',
  // Pending and settled approval requests — command lines and diffs a
  // machine asked to run. Absent from this list they
  // would survive sign-out and the decoy workspace would inherit a real
  // machine's pending commands, which is exactly the disclosure the decoy
  // exists to prevent.
  'approvals',
  // Structured agent events can contain repository/branch/result evidence;
  // the state row also names configured capabilities and usage. Both belong
  // to the real account and must never survive a wipe into the decoy.
  'ai_work_events',
  'ai_agent_state',
  'ai_notify_preferences',
  'ai_task_templates',
  // Which contacts are the real account's machines. A row here names
  // a relationship the server refuses to enumerate; surviving sign-out into
  // the decoy workspace would hand a coerced unlock exactly that list.
  'machine_peers',
  // A server-confirmed retired integration is account relationship state.
  // It must survive conversation deletion but never sign-out/duress switch.
  'revoked_machine_peers',
  // The consent record (dark). Which agents this person consented
  // to — or pointedly refused — is a relationship map like the one above,
  // and a refusal surviving into the decoy would disclose exactly the
  // stance the decoy exists to hide.
  'agent_consent',
  // Linked devices. The roster names this account's
  // OTHER devices — the exact grouping the server refuses to enumerate to
  // anyone without a member ULID — and a pending offer (either side's)
  // names a ceremony in flight. Surviving sign-out into the decoy
  // workspace would hand a coerced unlock that whole map, so all four
  // tables join the wipe.
  'link_group',
  'linked_devices',
  'link_pending_offer',
  'link_pending_ceremony',
  // A peer's device set is a relationship
  // map (who has which devices, verified how), a persisted signed mutation
  // names a revocation in flight, and the sibling machine-peers table maps
  // devices to agents — every one is disclosure a coerced unlock must not
  // inherit, so all three join the wipe.
  'peer_devices',
  'link_pending_mutation',
  'sibling_machine_peers',
  // The attached email IS an identifier, a
  // pending recovery names a takeover in flight, a recovery notice names the
  // account's grouping, and per-pair verification stamps are a relationship
  // map — every one is disclosure a coerced unlock must not inherit.
  'account_identifier',
  'recovery_local',
  'recovery_notice',
  // A revocation notice names a fact about this
  // account's name — disclosure a coerced unlock must not inherit. The
  // unlink memory (build 24) names the former name itself.
  'username_notice',
  'username_unlink',
  // The window's end names when this account last changed its name (U2).
  'username_cooldown',
  'peer_device_safety',
] as const;

/** Wipe all local state — the recovery path when boot finds an inconsistent
 * profile (e.g. SQLite profile present but the Keychain auth token is gone).
 * Runs against the ACTIVE workspace: in a duress session that is the decoy
 * file, which is exactly what a duress sign-out must (only) clear. */
export async function clearLocalState(): Promise<void> {
  const d = conn();
  for (const table of DB_TABLES) {
    await d.execute(`DELETE FROM ${table}`);
  }
}

/**
 * Open a short-lived side connection to the DECOY file, inside the excluded
 * directory. Every direct open of the decoy file goes through here — this is
 * the seam, not the creation call site, because `open()` IS creation: SQLite
 * mints the file the first time anyone opens it, so whichever caller reaches
 * it first (App Lock setup writing the decoy world, a sign-out clearing it, a
 * duress unlock drifting timestamps) is the creation site that day. Wherever
 * that happens, the file is born inside a directory whose exclusion flag was
 * asserted before the open — see the block comment at databaseLocation().
 *
 * databaseLocation() on EVERY open, deliberately, matching conn(): the
 * directory attribute survives normal use but a restore can shed it, and the
 * native side read-checks before writing — one no-op attribute check per
 * short-lived connection. An exclusion failure warns and opens anyway
 * (hardening must never stop the database opening); an unpreparable
 * directory throws, because opening the decoy anywhere else would recreate
 * the un-excluded layout this exists to end.
 *
 * IT DOES NOT CONSULT `closedLatch`, AND THAT IS THE CODE BEING RIGHT AND AN
 * EARLIER COMMENT BEING WRONG — the fix is here, in prose, not there. This is
 * a SHORT-LIVED SIDE connection to the decoy file, opened and closed by the
 * caller; it never becomes the module's `db` handle and never serves
 * `conn()`. Latching it would break the two things it exists for, both of
 * which legitimately run while the REAL workspace is the active one: App Lock
 * setup generating the decoy world, and a real session's sign-out wiping it.
 *
 * What that costs, stated rather than assumed: a future pre-verdict caller of
 * this function would open (and, `open()` being creation, could MINT) the
 * decoy file before any verdict. Every caller today — decoy generation,
 * `clearDecoyState`, `refreshDecoyTimestamps` — runs strictly after one, and
 * the file it reaches is the decoy either way, so nothing about the real
 * world is disclosed by it. The blanket claim this file used to make — that
 * no pre-verdict path could open either file "no matter what future code
 * calls" — was false, and an absolute that is false is worse than the hole it
 * was covering.
 */
export function openDecoyConnection(): DB {
  const file = WORKSPACE_FILES.decoy;
  return open({ name: file, location: databaseLocation(file) });
}

/** Wipe the decoy file from a REAL session (sign-out), over a short-lived
 * side connection so the active real workspace is undisturbed. */
export async function clearDecoyState(): Promise<void> {
  const d = openDecoyConnection();
  try {
    await initSchema(d);
    for (const table of DB_TABLES) {
      await d.execute(`DELETE FROM ${table}`);
    }
  } finally {
    d.close();
  }
}

// --- chats ---

// Explicit, not SELECT *: a column added to the table is invisible to every
// reader until it is named here. The disappearing-message pair below was
// added and forgotten once — getChat returned undefined for both, so the send
// path read "no timer" and the UI showed Off, while the rows on disk were
// correct. Add here whenever you add to the ALTER list.
const CHAT_COLUMNS = `peerId, displayName, lastMessageAt, lastMessageText,
     about, avatarB64, profileVersion, safetyCheckedAt, localName, createdAt,
     lastOpenedAt, identityChangedAt, safetyMismatchAt,
     disappearSec, disappearVersion, introducedBy, pinnedAt`;

export async function listChats(): Promise<ChatRow[]> {
  // A chat you just started has no lastMessageAt, and sorting those last put
  // it underneath every old thread — below the fold on the one screen where
  // you went looking for it. Its creation moment stands in until it speaks.
  //
  // Pinned rows lead. (pinnedAt IS NULL) sorts 0 before 1, so the pinned set
  // comes first without a CASE; pinnedAt DESC then puts the newest pin at the
  // top of that set. Everything after the second comma is exactly the order
  // this list has always had, so an unpinned list is unmoved. No cap: the
  // list is invite-only and short by construction.
  const res = await conn().execute(
    `SELECT ${CHAT_COLUMNS}
     FROM chats ORDER BY (pinnedAt IS NULL), pinnedAt DESC,
       COALESCE(lastMessageAt, createdAt, 0) DESC, peerId`,
  );
  return res.rows as unknown as ChatRow[];
}

export async function getChat(peerId: string): Promise<ChatRow | null> {
  const res = await conn().execute(
    `SELECT ${CHAT_COLUMNS} FROM chats WHERE peerId = ?`,
    [peerId],
  );
  return (res.rows[0] as unknown as ChatRow) ?? null;
}

/**
 * Apply a peer's profile card, newest version wins. A replayed or reordered
 * older card can never undo a newer one (the peer stamps the version).
 */
export async function applyPeerProfile(
  peerId: string,
  card: {
    displayName: string;
    about: string;
    /** Whether the card carries a photo at all (not whether it downloaded). */
    hasAvatar: boolean;
    version: number;
  },
): Promise<void> {
  const d = conn();
  await d.execute(
    `INSERT INTO chats (peerId, displayName, about, profileVersion)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(peerId) DO UPDATE SET
       displayName = excluded.displayName,
       about = excluded.about,
       profileVersion = excluded.profileVersion
     WHERE excluded.profileVersion > COALESCE(chats.profileVersion, -1)`,
    [peerId, card.displayName, card.about, card.version],
  );
  // The photo is applied separately from the text: a card WITH a photo keeps
  // the face already on screen until the new blob decrypts (so a slow network
  // never blanks someone's face), while a card WITHOUT one is a deliberate
  // removal and must actually remove it.
  if (!card.hasAvatar) {
    await d.execute(
      `UPDATE chats SET avatarB64 = NULL
       WHERE peerId = ? AND COALESCE(profileVersion, -1) <= ?`,
      [peerId, card.version],
    );
  }
}

/**
 * Store a peer's avatar once its blob finishes downloading, and RETURN the net
 * change in stored avatar bytes so the caller can advance the storage ledger.
 * Avatars land in chats.avatarB64 and were never counted against
 * the auto-fetch ceiling, so a Sybil roster of maximum-size faces grew the
 * disk without bound — "one per peer" is no limit when accounts are free.
 *
 * The delta is the REPLACEMENT difference, `new − old`, never the full new
 * length: this row may already hold a face, and charging the whole new length
 * on every version would let a peer walk the ledger up by re-sending. The
 * write is version-gated (a stale card must not overwrite a newer face), so it
 * may store nothing at all — `rowsAffected === 0` means the gate refused and
 * the bytes are unchanged, delta 0. base64 is ASCII, so length() in characters
 * IS bytes, exactly as the attachment ledger measures.
 */
export async function setPeerAvatar(
  peerId: string,
  avatarB64: string,
  version: number,
): Promise<number> {
  const d = conn();
  // The bytes this peer's avatar already holds, read before the overwrite.
  const before = await d.execute(
    `SELECT COALESCE(length(avatarB64), 0) AS len FROM chats WHERE peerId = ?`,
    [peerId],
  );
  const res = await d.execute(
    `UPDATE chats SET avatarB64 = ?
     WHERE peerId = ? AND COALESCE(profileVersion, -1) <= ?`,
    [avatarB64, peerId, version],
  );
  // The version gate refused a stale card (or the peer has no row): nothing
  // changed on disk, so nothing is charged to the ledger.
  if ((res.rowsAffected ?? 0) === 0) return 0;
  const oldLen = Number((before.rows[0] as { len?: number } | undefined)?.len ?? 0);
  return avatarB64.length - oldLen;
}

/**
 * Record that this device compared the safety number and it matched. Local
 * only — it is never sent to the peer and is not a trust claim about them.
 * An identity change clears it (pass null) so the check must be redone.
 */
export async function setSafetyChecked(
  peerId: string,
  at: number | null,
): Promise<void> {
  await conn().execute(
    `UPDATE chats SET safetyCheckedAt = ? WHERE peerId = ?`,
    [at, peerId],
  );
}

/**
 * Record that a comparison FAILED on this device (or clear it with null).
 * Local only, like every other safety record: nothing is sent to the peer.
 * Kept separate from `safetyCheckedAt` so "we compared and they differed" can
 * never be collapsed into "not checked yet".
 */
export async function setSafetyMismatch(
  peerId: string,
  at: number | null,
): Promise<void> {
  await conn().execute(
    `UPDATE chats SET safetyMismatchAt = ? WHERE peerId = ?`,
    [at, peerId],
  );
}

/**
 * The name I gave this person on this device; null clears it. Never enters an
 * envelope — it is a label on my own list, not a claim about them.
 */
export async function setLocalName(
  peerId: string,
  name: string | null,
): Promise<void> {
  const trimmed = name?.trim();
  await conn().execute(`UPDATE chats SET localName = ? WHERE peerId = ?`, [
    trimmed ? trimmed : null,
    peerId,
  ]);
  // The shared name mirror follows the database from HERE, its own writer,
  // rather than from each screen that renames: a mirror callers must remember
  // is a mirror one of them forgets, and the cost of forgetting is a ring
  // that greets someone by a name their owner deliberately replaced.
  republishPeerNames();
  // A rename can just as well be a ROOM's — rooms are chats rows and
  // `localName` is how anyone renames one for themselves
  // — and the extension titles room banners from its own mirror.
  republishGroupNames();
}

/** Remember that I read this thread, so what arrived later can be told apart
 * from what I have already seen. This device's clock only. */
export async function markChatOpened(
  peerId: string,
  at: number,
): Promise<void> {
  await conn().execute(`UPDATE chats SET lastOpenedAt = ? WHERE peerId = ?`, [
    at,
    peerId,
  ]);
}

/**
 * Pin a conversation to the top of the list, or unpin it with null.
 *
 * A MOMENT RATHER THAN A FLAG, so pinned rows keep an order among themselves
 * (see listChats) without a second column. Local to this workspace, like
 * every other thing on a chats row: a pin made under duress pins a decoy row
 * and nothing real moves, and a pin is never sent, so the person pinned is
 * never told.
 */
export async function setPinned(
  peerId: string,
  at: number | null,
): Promise<void> {
  await conn().execute(`UPDATE chats SET pinnedAt = ? WHERE peerId = ?`, [
    at,
    peerId,
  ]);
}

/**
 * Put the unread mark back on a conversation I have already read.
 *
 * markChatOpened only ever clears; unread is defined as "arrived after I last
 * opened this", so the reverse is one UPDATE that rolls lastOpenedAt back to
 * ONE MILLISECOND BEFORE THE NEWEST INBOUND ARRIVAL. Not to zero: rolling all
 * the way back would light every message this thread has ever received, and
 * the mark a person asked for is "there is something here", not "start again".
 *
 * THE SUBSELECT IS unreadCounts' OWN PREDICATE, deliberately duplicated
 * rather than approximated. A 1:1 row's window is COALESCE(arrivedAt, seen.ts)
 * and a room row's is arrivedAt with sharedBy IS NULL, and a mark computed
 * from any other rule is a mark that screen would not have counted - it would
 * set a flag nothing displays, which is the same defect as a control that
 * claims something it did not do.
 *
 * BACKWARDS ONLY, WHICH IS WHY THE MIN IS THERE. The roll-back is scalar
 * MIN over the value already on the row, so this statement can lower
 * lastOpenedAt and never raise it. Without that guard the assignment is a
 * move FORWARD on a conversation that is ALREADY unread — three unread
 * messages become one, and the two the person had not read are marked read by
 * the control they tapped to keep them. Nothing in the caller can prevent it:
 * The menu withholds the row only when there is nothing inbound, not when the chat
 * is already unread, so the precondition would have to be "call this only on
 * a read chat" and no type says that. Monotonic here, unconditionally, means
 * a second tap is harmless from any caller.
 *
 * The floor inside the MIN is COALESCE(lastOpenedAt, 0) — the same reading
 * unreadCounts gives a never-opened row, so a NULL resolves to 0 in both
 * statements rather than being pulled up to an arrival.
 *
 * A NO-OP WHEN THERE IS NOTHING INBOUND. MAX over no rows is NULL, MIN of
 * anything with NULL is NULL, and the outer COALESCE then writes lastOpenedAt
 * back over itself. You cannot mark unread what never arrived, and the caller
 * withholds the control rather than offering one that quietly does nothing.
 *
 * THIS DEVICE ONLY. syncThreadRead propagates READ to my sibling devices;
 * there is no inverse envelope, so the mark stays here. Nothing claims
 * otherwise, so nothing needs to say so.
 */
export async function markChatUnread(peerId: string): Promise<void> {
  // NO BACKTICKS IN THIS COMMENT: scripts/prove-db.mjs pulls a function's SQL
  // by finding the first backtick after its name, and one in the prose here
  // would silently become the "SQL" it proves. No interpolation in the
  // template either, for the same reader - an unprovable SQL function is how
  // two logic inversions once passed the whole jest suite.
  await conn().execute(
    `UPDATE chats SET lastOpenedAt = COALESCE(
       MIN(COALESCE(lastOpenedAt, 0),
           (SELECT MAX(CASE WHEN g.groupId IS NULL
                            THEN COALESCE(m.arrivedAt, s.ts)
                            ELSE m.arrivedAt END) - 1
              FROM messages m
              LEFT JOIN groups g ON g.groupId = m.peerId
              LEFT JOIN seen s ON s.msgId = m.msgId
             WHERE m.peerId = chats.peerId
               AND m.direction = 'in'
               AND (g.groupId IS NULL OR m.sharedBy IS NULL))),
       lastOpenedAt)
     WHERE peerId = ?`,
    [peerId],
  );
}

/** Record (or clear, with null) an identity change for this peer. */
export async function setIdentityChanged(
  peerId: string,
  at: number | null,
): Promise<void> {
  await conn().execute(
    `UPDATE chats SET identityChangedAt = ? WHERE peerId = ?`,
    [at, peerId],
  );
}

/** Peers carrying an unreviewed identity change, so the list can mark them
 * without asking the protocol layer about every row it draws. */
export async function listIdentityChanged(): Promise<string[]> {
  const res = await conn().execute(
    `SELECT peerId FROM chats WHERE identityChangedAt IS NOT NULL`,
  );
  return (res.rows as { peerId: string }[]).map(r => r.peerId);
}

/** Peers who have not yet received version `version` of my card.
 *
 * PEERS, structurally: a room's chats row has no person
 * behind its peerId, so unfiltered this list would hand broadcastProfile a
 * room id to send a card to — apiGetPrekeyBundle 404s, shareProfileWith
 * swallows it, and it retries on every launch forever, a permanent silent
 * prekey fetch per room. NULL kind is the 1:1 every pre-rooms row is. */
export async function chatsMissingMyProfile(
  version: number,
): Promise<string[]> {
  const res = await conn().execute(
    `SELECT peerId FROM chats WHERE COALESCE(sentProfileVersion, -1) < ?
       AND COALESCE(kind, 'peer') = 'peer'`,
    [version],
  );
  return (res.rows as { peerId: string }[]).map(r => r.peerId);
}

/** True when this peer already holds version `version` of my card. */
export async function peerHasMyProfile(
  peerId: string,
  version: number,
): Promise<boolean> {
  const res = await conn().execute(
    `SELECT 1 AS x FROM chats
     WHERE peerId = ? AND COALESCE(sentProfileVersion, -1) >= ?`,
    [peerId, version],
  );
  return res.rows.length > 0;
}

export async function markMyProfileSent(
  peerId: string,
  version: number,
): Promise<void> {
  await conn().execute(
    `UPDATE chats SET sentProfileVersion = ? WHERE peerId = ?`,
    [version, peerId],
  );
}

export async function upsertChat(
  peerId: string,
  displayName?: string,
  /** How this person was introduced. Only the three
   * creation paths that KNOW say so — QR, typed id, discovery tap; every
   * inbound-message caller leaves it unset, which is the honest answer. */
  introducedBy?: IntroducedBy,
): Promise<void> {
  // `createdAt` is written on insert only: an inbound message from a peer I
  // already have must never reset when this conversation began. Provenance
  // keeps the FIRST answer on disk the same way — how a chat began is a fact
  // about its beginning — and fills in only where nothing was recorded, so
  // a discovery tap on a chat an inbound message opened still earns the
  // reminder (the server DID introduce the account to the person tapping).
  await conn().execute(
    `INSERT INTO chats (peerId, displayName, createdAt, introducedBy)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(peerId) DO UPDATE SET
       displayName = COALESCE(excluded.displayName, chats.displayName),
       introducedBy = COALESCE(chats.introducedBy, excluded.introducedBy)`,
    [peerId, displayName ?? null, Date.now(), introducedBy ?? null],
  );
}

/**
 * Move a chat's line — the preview text AND the list-sort timestamp — for a
 * NEW message. An UNCONDITIONAL last-writer upsert, deliberately: the write
 * ORDER is arbitrated above this function, by MessagingService's per-chat
 * dispatch chain (runChatLine), which serialises every chat-line write and
 * skips any write whose dispatch token is older than the last one applied.
 *
 * A timestamp guard in this statement was tried and reverted: `ts` arrives
 * from TWO clock domains — compose paths stamp the device's Date.now(),
 * inbound paths carry the frame's SERVER-stamped ts — and a guard comparing
 * them froze the line for the whole skew whenever the clocks disagreed. A
 * device running ahead pinned its own send against every inbound update; a
 * device running behind never saw its own sends take the line, and silently
 * dropped a fire-once membership announce for good. Clock skew of a full
 * day is inside this codebase's threat model (PROFILE_FUTURE_TOLERANCE_MS),
 * so no cross-clock comparison can ever be the arbiter. Dispatch order —
 * the order events entered this process — is the one domain both writers
 * share.
 */
export async function touchChat(
  peerId: string,
  lastText: string,
  ts: number,
): Promise<void> {
  await conn().execute(
    `INSERT INTO chats (peerId, lastMessageAt, lastMessageText) VALUES (?, ?, ?)
     ON CONFLICT(peerId) DO UPDATE SET
       lastMessageAt = excluded.lastMessageAt,
       lastMessageText = excluded.lastMessageText`,
    [peerId, ts, lastText],
  );
}

// --- messages ---

export async function insertMessage(message: MessageRow): Promise<void> {
  // OR IGNORE is also the room dedup: a room row's key is
  // `${authorId}.${m}`, identical on every phone, so an author re-fanning the
  // same `m` in a fresh frame (new wire id, so `seen` cannot catch it) lands
  // on the existing row and is ignored rather than duplicated.
  // OR IGNORE is also what makes a first-hand copy unbeatable (history
  // sharing): a relayed entry whose room key `${authorId}.${m}` I already
  // hold lands on my witnessed row and is ignored, so a relay can never
  // overwrite first-hand provenance with a second-hand account.
  await conn().execute(
    `INSERT OR IGNORE INTO messages
       (msgId, peerId, direction, body, ts, status, expiresAt, authorId, sq,
        outsider, sharedBy, arrivedAt, ai)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      message.msgId,
      message.peerId,
      message.direction,
      message.body,
      message.ts,
      message.status,
      message.expiresAt ?? null,
      message.authorId ?? null,
      message.sq ?? null,
      message.outsider ?? null,
      message.sharedBy ?? null,
      message.arrivedAt ?? null,
      message.ai ?? null,
    ],
  );
}

/** Persist an outgoing message row and its wire envelope atomically, so a
 * crash can never strand a 'pending' message with no envelope to flush.
 *
 * `seq` is allocated here too, inside the same transaction and by the same
 * MAX(seq)+1 rule the fan-out enqueues use. It used to be left NULL, which
 * `listOutbox`'s `COALESCE(seq, 0)` reads as 0 — so every plain 1:1 send
 * sorted AHEAD of every seq'd fan-out and room leg regardless of age, and
 * the flush order stopped meaning enqueue order the moment a phone had both
 * kinds queued. The ratchet tolerated it (skipped message keys are cached);
 * the contract did not. */
export async function enqueueOutgoing(
  message: MessageRow,
  envelope: {
    msgType: string;
    payload: string;
    /** 1 = call signalling, flushed ahead of ordinary messages. */
    priority?: number;
    /** Marks a frame that may wake a sleeping peer. Persisted here early so
     * a later wire change is a pure transport edit; nothing reads it yet. */
    urgent?: boolean;
  /** false for carrier frames: queue and deliver, but raise no notification. */
  notify?: boolean;
  },
): Promise<void> {
  const d = conn();
  await runExclusive(async () => {
    await d.execute('BEGIN IMMEDIATE');
    try {
      await d.execute(
        `INSERT OR IGNORE INTO messages (msgId, peerId, direction, body, ts, status, expiresAt)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          message.msgId,
          message.peerId,
          message.direction,
          message.body,
          message.ts,
          message.status,
          message.expiresAt ?? null,
        ],
      );
      const base = Number(
        (
          (await d.execute(`SELECT COALESCE(MAX(seq), 0) AS base FROM outbox`))
            .rows[0] as { base?: number } | undefined
        )?.base ?? 0,
      );
      await d.execute(
        `INSERT OR IGNORE INTO outbox
           (msgId, peerId, msgType, payload, attempts, priority, urgent, notify, seq)
         VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)`,
        [
          message.msgId,
          message.peerId,
          envelope.msgType,
          envelope.payload,
          envelope.priority ?? 0,
          envelope.urgent ? 1 : 0,
          envelope.notify === false ? 0 : 1,
          base + 1,
        ],
      );
      await d.execute('COMMIT');
    } catch (err) {
      await d.execute('ROLLBACK');
      throw err;
    }
  });
}

/**
 * THE LEG LEDGER. A settled fan-out leg is not deleted the
 * way a receipted 1:1 envelope is — its outbox row STAYS, payload cleared so
 * it can never transmit again, with the outcome written into `attempts` as a
 * negative sentinel no live row can hold. That one decision is what gives
 * "Not delivered to N of M" durable numbers with no schema change: M is every
 * row sharing a `localMsgId`, N is the LEG_FAILED rows among them, and the
 * per-member state on long-press is the rows' own `peerId`s. Ledger rows die
 * with their message (deleteMessage, sweepExpired — both join on
 * `localMsgId`) or with their room (deleteGroup), never with a receipt.
 *
 * The precedence is delivered > sent > failed: a late receipt for a leg the
 * retry cap had already written off proves the server took it after all, so
 * an upgrade out of `failed` is honest and allowed; no transition ever
 * downgrades.
 */
export const LEG_FAILED = -1;
export const LEG_SENT = -2;
export const LEG_DELIVERED = -3;

/**
 * One leg of a group fan-out: the wire envelope queued to
 * ONE member. `msgId` is the leg's wire id — 26 characters of pure CSPRNG
 * (`randomMsgId`), never a ULID minted by `nextMsgId` — and `peerId` is
 * the MEMBER, never the room.
 *
 * `failed` marks a leg that could never be composed (the member's account is
 * gone, so there is no ciphertext): it is written directly as a settled
 * LEG_FAILED ledger row with an empty payload, so the flush never sees it and
 * the room row's "Not delivered to N of M" counts it honestly instead of
 * omitting the member silently.
 */
export interface FanoutLeg {
  msgId: string;
  peerId: string;
  msgType: string;
  payload: string;
  urgent?: boolean;
  notify?: boolean;
  failed?: boolean;
}

/**
 * Persist ONE composed group message and ALL of its legs atomically: exactly one `messages` row — keyed
 * `${authorId}.${m}`, carrying `authorId` and `sq` — plus N `outbox` rows,
 * each with its own random wire msgId and `localMsgId` pointing back at the
 * message row. One transaction, so a crash between them leaves NEITHER: the
 * same invariant `enqueueOutgoing` holds for a 1:1 send, widened exactly once.
 *
 * Plain INSERTs, not OR IGNORE: the local key and every wire id are minted
 * fresh by the caller, so a conflict is a bug — and it must roll the WHOLE
 * write back rather than leave a bubble with half its legs.
 *
 * `outbox.seq` — the local flush order that no longer travels on the wire
 * — is allocated inside the transaction as MAX(seq)+1..+N in the
 * caller's (already randomised) leg order, so legs across two fan-outs to the
 * same member flush in enqueue order even though their wire ids are random.
 */
export async function enqueueOutgoingFanout(
  message: MessageRow & { authorId: string; sq: number },
  legs: FanoutLeg[],
): Promise<void> {
  const d = conn();
  await runExclusive(async () => {
    await d.execute('BEGIN IMMEDIATE');
    try {
      await d.execute(
        `INSERT INTO messages
           (msgId, peerId, direction, body, ts, status, expiresAt, authorId, sq)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          message.msgId,
          message.peerId,
          message.direction,
          message.body,
          message.ts,
          message.status,
          message.expiresAt ?? null,
          message.authorId,
          message.sq,
        ],
      );
      const base = Number(
        (
          (
            await d.execute(
              `SELECT COALESCE(MAX(seq), 0) AS base FROM outbox`,
            )
          ).rows[0] as { base?: number } | undefined
        )?.base ?? 0,
      );
      for (let i = 0; i < legs.length; i++) {
        const leg = legs[i];
        await d.execute(
          `INSERT INTO outbox
             (msgId, peerId, msgType, payload, attempts, priority, urgent,
              notify, localMsgId, seq)
           VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
          [
            leg.msgId,
            leg.peerId,
            leg.msgType,
            leg.failed ? '' : leg.payload,
            leg.failed ? LEG_FAILED : 0,
            leg.urgent ? 1 : 0,
            leg.notify === false ? 0 : 1,
            message.msgId,
            base + 1 + i,
          ],
        );
      }
      await d.execute('COMMIT');
    } catch (err) {
      await d.execute('ROLLBACK');
      throw err;
    }
  });
}

/**
 * Persist ONE 1:1 message and ALL of its DEVICE legs atomically — enqueueOutgoing's
 * shape widened the way enqueueOutgoingFanout widened it for rooms: exactly one
 * `messages` row (the ordinary 1:1 row — no authorId, no sq, so every existing thread
 * render is untouched), plus one PRIMARY outbox envelope carrying the row's own msgId
 * (receipts flow exactly as today: the anchor's ack is the delivery), plus N EXTRA
 * envelopes with their own wire msgIds. PEER-device extras carry `localMsgId` pointing
 * at the message row: they join the fan-out leg LEDGER, so a member leg written off at
 * the retry cap is a durable LEG_FAILED row behind "Not delivered to N of M" — never a
 * silently deleted envelope — while the message row's own bubble stays the primary
 * leg's receipts (aggregateFanoutStatus folds status for ROOM rows only). SIBLING sync
 * extras carry the same `localMsgId` — it is the PURGE KEY sweepExpired/deleteMessage
 * reach the row by — but `ledger = 0`: a transcript copy is convenience, not delivery,
 * and must never count in the member ledger. One transaction, so a crash leaves either
 * the whole send or none of it. */
export async function enqueueOutgoingDeviceFanout(
  message: MessageRow,
  primary: {
    msgType: string;
    payload: string;
    urgent?: boolean;
    notify?: boolean;
    /** The primary leg's WIRE address — the anchor by default, or the
     * promoted surviving device when the anchor is revoked. The message ROW stays keyed to the anchor either way:
     * the conversation's address never changes. */
    to?: string;
  },
  extras: Array<{ to: string; msgId: string; msgType: string; payload: string; ledger?: boolean }>,
  opts: { priority?: number } = {},
): Promise<void> {
  const d = conn();
  await runExclusive(async () => {
    await d.execute('BEGIN IMMEDIATE');
    try {
      await d.execute(
        `INSERT INTO messages
           (msgId, peerId, direction, body, ts, status, expiresAt)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          message.msgId,
          message.peerId,
          message.direction,
          message.body,
          message.ts,
          message.status,
          message.expiresAt ?? null,
        ],
      );
      const base = Number(
        (
          (await d.execute(`SELECT COALESCE(MAX(seq), 0) AS base FROM outbox`))
            .rows[0] as { base?: number } | undefined
        )?.base ?? 0,
      );
      await d.execute(
        `INSERT INTO outbox
           (msgId, peerId, msgType, payload, attempts, priority, urgent, notify, seq)
         VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)`,
        [
          message.msgId,
          primary.to ?? message.peerId,
          primary.msgType,
          primary.payload,
          opts.priority ?? 0,
          primary.urgent ? 1 : 0,
          primary.notify === false ? 0 : 1,
          base + 1,
        ],
      );
      for (let i = 0; i < extras.length; i++) {
        const leg = extras[i];
        await d.execute(
          `INSERT INTO outbox
             (msgId, peerId, msgType, payload, attempts, priority, urgent, notify,
              localMsgId, seq, ledger)
           VALUES (?, ?, ?, ?, 0, ?, 0, ?, ?, ?, ?)`,
          [
            leg.msgId,
            leg.to,
            leg.msgType,
            leg.payload,
            opts.priority ?? 0,
            primary.notify === false ? 0 : 1,
            message.msgId,
            base + 2 + i,
            leg.ledger ? 1 : 0,
          ],
        );
      }
      await d.execute('COMMIT');
    } catch (err) {
      await d.execute('ROLLBACK');
      throw err;
    }
  });
}

/**
 * ONE bare outbox envelope, no messages row (the sibling-sync and peer-notice PRODUCERS' enqueue): a typed carrier
 * (`x.acct.sync`, `x.acct.notice`) is transport between devices, never a
 * message, so it must leave no thread row, no preview, and no unread —
 * exactly the shape the device fan-out's extra legs already take. Durable
 * before the wire like every send; flushes in the ordinary ULID order;
 * best-effort at the retry cap (the outbox drop path for non-leg rows).
 */
export async function enqueueEnvelopeOnly(env: {
  to: string;
  msgId: string;
  msgType: string;
  payload: string;
}): Promise<void> {
  const d = conn();
  await runExclusive(async () => {
    const base = Number(
      (
        (await d.execute(`SELECT COALESCE(MAX(seq), 0) AS base FROM outbox`))
          .rows[0] as { base?: number } | undefined
      )?.base ?? 0,
    );
    await d.execute(
      `INSERT INTO outbox
         (msgId, peerId, msgType, payload, attempts, priority, urgent, notify, seq)
       VALUES (?, ?, ?, ?, 0, 0, 0, 0, ?)`,
      [env.msgId, env.to, env.msgType, env.payload, base + 1],
    );
  });
}

/**
 * One conversation's whole history, oldest first. Ordered by `ts` and not by
 * msgId: an inbound row's msgId is the SENDER's ULID (their clock), while `ts`
 * is the receiving side's record, so msgId order lets a peer with a skewed
 * clock place their reply above the message it answers and split a day into
 * two dividers. msgId is the tiebreaker so the order is total and stable.
 *
 * Deliberately unbounded and single-argument: the scripted simulator verification
 * reads it directly, and the thread renders the whole thread.
 */
export async function listMessages(peerId: string): Promise<MessageRow[]> {
  // `arrivedAt` rides along for the thread's unread divider: "new since
  // last open" is THIS phone's arrival clock, the same column the chat
  // list's unread count reads, never the sender's ts.
  const res = await conn().execute(
    `SELECT msgId, peerId, direction, body, ts, status, editedAt, deletedAt,
            expiresAt, authorId, sq, outsider, sharedBy, ai, arrivedAt
     FROM messages WHERE peerId = ? ORDER BY ts, msgId`,
    [peerId],
  );
  return res.rows as unknown as MessageRow[];
}

/**
 * The character that neutralises a wildcard inside a find pattern.
 *
 * NOT A BACKSLASH, and the reason is the gate rather than SQL. A backslash has
 * to be written doubled in a TypeScript template, and scripts/prove-db.mjs
 * pulls a function's SQL out of THIS FILE'S RAW TEXT — so the engine would be
 * handed a two-character escape and refuse the statement, and the one proof
 * that can say what this query matches would never run. A tilde is one
 * character in the source and one character at runtime, which is the whole
 * requirement; any single character does the job identically.
 */
const FIND_ESCAPE = '~';

/**
 * The most rows one find may return, and the floor of one.
 *
 * SQLite reads a NEGATIVE limit as NO LIMIT and coerces a non-integer, and
 * the rows here are RAW BODIES — an image or file body is JSON carrying
 * base64. So a caller's NaN parse, a -1 sentinel or an off-by-one would not
 * return slightly too much; it would read every envelope on the phone across
 * the bridge, on every keystroke. The clamp lives here because the caller is
 * the thing that can be wrong, and 200 is far past what a person scrolls in
 * one conversation. A caller needing more should widen this constant on
 * purpose rather than pass a bigger number.
 */
const FIND_LIMIT_MAX = 200;

/** Wrap a person's words as a LIKE pattern, with every wildcard AND the
 * escape character itself neutralised. One pass, so an escape this function
 * introduces is never escaped again. */
function findPattern(query: string): string {
  return `%${query.replace(/[~%_]/g, c => FIND_ESCAPE + c)}%`;
}

/**
 * Messages whose body contains `query` — newest first, capped at `limit`.
 *
 * A PREFILTER, NEVER AN ANSWER. The caller decides what counts as a match,
 * and it must, because a body is sometimes an envelope: an image message is
 * stored as JSON carrying base64, so a three-letter query LIKE-matches inside
 * key material and would show a person a "result" that is a fragment of a
 * photo. Every caller refines these rows through displayText(body,
 * resolveName) — the same reader the clipboard and the VoiceOver label use —
 * and keeps a row only when the query survives in the WORDS. A room's rows
 * come free: displayText already unwraps the grp.msg carrier.
 *
 * TWO PATTERNS, ONE MEANING. SQLite's LIKE folds case for ASCII only, so the
 * query is bound as typed AND locale-lowercased, OR'd. The refinement in JS
 * compares locale-lowercased and is the authority. The residual, stated
 * plainly: a row differing from the query only by case in a non-ASCII script
 * can fail the prefilter and never reach the refinement, so it may miss. That
 * is a missed row, never a wrong one.
 *
 * `peerId` null drops the peer clause, for a reader across conversations.
 * Retracted rows are excluded here rather than in the caller: a tombstone
 * keeps its place in the thread with an empty body, and it is not something
 * to find. Expired rows never reach this query at all — sweepExpired has
 * taken them.
 *
 * THE LIMIT IS CLAMPED, not bound as given: a positive integer, at most
 * FIND_LIMIT_MAX. A caller asking for more gets that ceiling.
 *
 * Reading your own history is not a send: this runs under a block, under an
 * identity change, and in a duress session, where it reaches the decoy's own
 * rows and nothing else.
 */
export async function findMessages(
  peerId: string | null,
  query: string,
  limit: number,
): Promise<MessageRow[]> {
  // NO BACKTICKS AND NO INTERPOLATION BELOW: scripts/prove-db.mjs takes the
  // text between the first two backticks after this function's name, and an
  // unprovable SQL function is how two logic inversions once passed the whole
  // jest suite.
  // Clamped, never bound as given: see FIND_LIMIT_MAX. Math.trunc first so a
  // fractional limit cannot reach the binder, then the floor of 1 catches
  // 0, every negative, and NaN.
  const cap = Math.max(1, Math.min(FIND_LIMIT_MAX, Math.trunc(limit) || 1));
  const res = await conn().execute(
    `SELECT msgId, peerId, direction, body, ts, status, editedAt, deletedAt,
            expiresAt, authorId, sq, outsider, sharedBy, ai, arrivedAt
     FROM messages
     WHERE (peerId = ? OR ? IS NULL)
       AND deletedAt IS NULL
       AND (body LIKE ? ESCAPE '~' OR body LIKE ? ESCAPE '~')
     ORDER BY ts DESC, msgId DESC
     LIMIT ?`,
    [
      peerId,
      peerId,
      findPattern(query),
      findPattern(query.toLocaleLowerCase()),
      cap,
    ],
  );
  return res.rows as unknown as MessageRow[];
}

/** One message row. (msgId, direction) is the identity — msgId alone is
 * sender-spoofable across directions. */
export async function getMessage(
  msgId: string,
  direction: 'in' | 'out',
): Promise<MessageRow | null> {
  const res = await conn().execute(
    `SELECT msgId, peerId, direction, body, ts, status, editedAt, deletedAt,
            expiresAt, authorId, sq, outsider, sharedBy, ai
     FROM messages WHERE msgId = ? AND direction = ?`,
    [msgId, direction],
  );
  return (res.rows[0] as unknown as MessageRow) ?? null;
}

/**
 * Park a revision whose target row is not here yet. Newest wins WITHIN ONE
 * WRITER's slot, and a retraction outranks an edit at the same instant — a
 * message taken back cannot be un-taken by a racing rewrite.
 *
 * `writerId` is the authenticated reviser — `frame.from`, never a payload
 * field — and it is part of the conflict target: the
 * newest-wins arbitration above is only sound between one writer's own
 * claims. Across writers it was a suppression primitive — member M parks a
 * forged `del` naming author A's row, and A's genuine retraction then loses
 * the upsert. One slot per writer ends the contest: M's forgery sits in M's
 * slot, is never taken for A's row (takeHeldRevision matches the writer to
 * the target's author), and suppresses nothing.
 */
/**
 * THE PEER-WRITABLE BOUNDS. Four tables take rows on a peer's say-so and
 * were reaped only by `deleteChat` and by their target's expiry: a held
 * revision whose target never arrives, a reaction whose target never
 * arrives, a vault slot, an approval. An unblocked contact could grow each
 * at their send-quota rate, indefinitely. Two instruments, chosen per table:
 *
 *  - AGE. A revision or reaction still waiting for its target after the
 *    server's 30-day queue TTL is waiting for a message that can no longer
 *    be delivered — `sweepExpired` reaps it (the same hook that reaps
 *    expired messages, on the same clock). Approvals already had a
 *    retention rule at read time; the sweep now applies it whether or not
 *    the thread is ever opened.
 *  - A CAP, refused IN the write statement so a burst of concurrent frames
 *    cannot overshoot it: held revisions per conversation, vault slots per
 *    (conversation, writer), LIVE pending approvals per conversation. A
 *    refused write returns false and the frame is acked exactly as an
 *    applied one — a bound that stranded frames un-acked would be a
 *    redelivery loop, and the ratchet key is spent either way.
 *
 * Every cap admits an UPDATE of a row that already exists (the conflict
 * target's row): the bound is on how many rows a peer may create, never on
 * whether they may revise their own. The numbers are generous for any honest
 * use (a thread does not hold two hundred edits awaiting two hundred
 * messages) and small enough that the tables stay a few kilobytes per
 * contact under abuse. */
export const HELD_REVISION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const HELD_REVISIONS_PER_PEER_CAP = 200;

/**
 * Returns whether the revision is now held (inserted or its slot updated).
 * False means the per-conversation cap refused a NEW slot; a slot that
 * already exists is always eligible for the newest-wins update.
 */
export async function holdRevision(rev: {
  peerId: string;
  targetMsgId: string;
  targetDirection: 'in' | 'out';
  writerId: string;
  kind: 'edit' | 'del';
  text: string;
  ts: number;
}): Promise<boolean> {
  const res = await conn().execute(
    `INSERT INTO pending_revisions
       (peerId, targetMsgId, targetDirection, writerId, kind, text, ts)
     SELECT ?, ?, ?, ?, ?, ?, ?
     WHERE (SELECT COUNT(*) FROM pending_revisions WHERE peerId = ?) < ${HELD_REVISIONS_PER_PEER_CAP}
        OR EXISTS (SELECT 1 FROM pending_revisions
                   WHERE targetMsgId = ? AND targetDirection = ? AND writerId = ?)
     ON CONFLICT(targetMsgId, targetDirection, writerId) DO UPDATE SET
       peerId = excluded.peerId,
       kind = excluded.kind,
       text = excluded.text,
       ts = excluded.ts
     WHERE excluded.ts > pending_revisions.ts
        OR (excluded.ts = pending_revisions.ts AND excluded.kind = 'del')`,
    [
      rev.peerId,
      rev.targetMsgId,
      rev.targetDirection,
      rev.writerId,
      rev.kind,
      rev.text,
      rev.ts,
      rev.peerId,
      rev.targetMsgId,
      rev.targetDirection,
      rev.writerId,
    ],
  );
  return (res.rowsAffected ?? 0) > 0;
}

/** A parked revision for this row FROM THIS WRITER, if one is waiting. The
 * writer filter is the authorship check applied at held-apply time: only the
 * target's author may revise it, so only their slot is ever taken. */
export async function takeHeldRevision(
  peerId: string,
  targetMsgId: string,
  targetDirection: 'in' | 'out',
  writerId: string,
): Promise<{ kind: 'edit' | 'del'; text: string; ts: number } | null> {
  const res = await conn().execute(
    `SELECT kind, text, ts FROM pending_revisions
     WHERE peerId = ? AND targetMsgId = ? AND targetDirection = ?
       AND writerId = ?`,
    [peerId, targetMsgId, targetDirection, writerId],
  );
  const row = res.rows[0] as unknown as
    | { kind: 'edit' | 'del'; text: string; ts: number }
    | undefined;
  return row ?? null;
}

export async function dropHeldRevision(
  targetMsgId: string,
  targetDirection: 'in' | 'out',
  writerId: string,
): Promise<void> {
  await conn().execute(
    `DELETE FROM pending_revisions
     WHERE targetMsgId = ? AND targetDirection = ? AND writerId = ?`,
    [targetMsgId, targetDirection, writerId],
  );
}

/** Revisions still waiting, so a boot can retry any whose target has since
 * landed (a crash or a relock can strand one mid-apply). */
export async function listHeldRevisions(): Promise<
  Array<{
    peerId: string;
    targetMsgId: string;
    targetDirection: 'in' | 'out';
    writerId: string;
    kind: 'edit' | 'del';
    text: string;
    ts: number;
  }>
> {
  const res = await conn().execute(
    `SELECT peerId, targetMsgId, targetDirection, writerId, kind, text, ts
     FROM pending_revisions`,
  );
  return res.rows as unknown as Array<{
    peerId: string;
    targetMsgId: string;
    targetDirection: 'in' | 'out';
    writerId: string;
    kind: 'edit' | 'del';
    text: string;
    ts: number;
  }>;
}

/** The newest rows of a conversation, newest first. Bounded because the only
 * caller wants the latest VISIBLE row and carriers may sit on top of it —
 * reading a whole thread to recompute one preview line is not worth it.
 * `ai` is projected like every other MessageRow reader's: the preview
 * caller ignores it today, but a typed row silently missing a column is the
 * exact landmine the supersede and edit paths just grew out of. */
export async function listRecentMessages(
  peerId: string,
  limit: number,
): Promise<MessageRow[]> {
  const res = await conn().execute(
    `SELECT msgId, peerId, direction, body, ts, status, editedAt, deletedAt,
            expiresAt, authorId, sq, outsider, sharedBy, ai
     FROM messages WHERE peerId = ? ORDER BY ts DESC, msgId DESC LIMIT ?`,
    [peerId, limit],
  );
  return res.rows as unknown as MessageRow[];
}

/** One room message this phone may relay to a newcomer (history sharing).
 * `authorId` is non-null by selection — a row with no room author is not
 * shareable — and on the wire it becomes `e.a`, the relayer's CLAIM about
 * who wrote it, nothing more. */
export interface ShareableMessage {
  msgId: string;
  authorId: string;
  body: string;
  ts: number;
  expiresAt: number | null;
}

/**
 * The most recent `limit` room messages this phone may relay onward
 * ("Rooms can share history with a new member").
 * Four exclusions, each a rule of the decision with its own failing-mutation
 * test (db.history.share.test.ts) and real-engine proof (prove-db.mjs the design):
 *
 *  - expired (`expiresAt <= now`, sweepExpired's own boundary): the timer
 *    binds — a share must never resurrect a message the timer took, or the
 *    timer becomes a suggestion.
 *  - retracted (`deletedAt`): a retraction is not undone by a relay.
 *  - relayed (`sharedBy`): this phone may relay only what it WITNESSED.
 *    Without this, provenance launders — a previous relayer's
 *    unauthenticated account would leave here as first-hand history, and
 *    the next phone could launder it again.
 *  - author-less (`authorId IS NULL`): a 1:1 row is not room history, and a
 *    room row that never carried its author has no `e.a` to claim.
 *  - the room's OWN announcements (`{"tcm":"grp.`): a roster change, a timer
 *    change or an earlier share is a thing that happened TO the room, not
 *    something anyone said in it, and replaying them to a newcomer would
 *    announce old events as if they were new. Found by a test rather than by
 *    reasoning: the composer refused `e.b` outright, because a `grp.*` body
 *    is exactly what the no-nesting rule exists to keep out of an entry.
 *    Content envelopes are deliberately NOT excluded — an image, a file, a
 *    location or a reply IS conversation, and its `{"tcm":"image"` body does
 *    not match this prefix.
 *
 * The exclusions are in SQL rather than in the caller so that `limit` counts
 * SHAREABLE messages: filtering after the LIMIT would silently under-deliver
 * whenever the tail of a room happened to be announcements.
 *
 * Newest first. The CALLER clamps `limit` to MAX_HISTORY_SHARE — this
 * function trusts its arguments the way every sibling here does.
 */
export async function selectHistoryForShare(
  groupId: string,
  limit: number,
  now: number,
): Promise<ShareableMessage[]> {
  const res = await conn().execute(
    `SELECT msgId, authorId, body, ts, expiresAt
     FROM messages
     WHERE peerId = ?
       AND authorId IS NOT NULL
       AND sharedBy IS NULL
       AND deletedAt IS NULL
       AND body NOT LIKE '{"tcm":"grp.%'
       AND (expiresAt IS NULL OR expiresAt > ?)
     ORDER BY ts DESC, msgId DESC LIMIT ?`,
    [groupId, now, limit],
  );
  return res.rows as unknown as ShareableMessage[];
}

/**
 * A message I only had someone's ACCOUNT of has now arrived first-hand:
 * replace the account with the real thing (history sharing).
 *
 * `INSERT OR IGNORE` makes a row I already hold unbeatable, which is right
 * when the relayed copy arrives second — but it is exactly wrong when the
 * relayed copy arrived FIRST and the author's own message follows. That
 * happens on any straggler re-fan to a newcomer, and leaving it alone would
 * mean a relayer's claim permanently outranking the author's own words. So
 * first-hand supersedes: the body and the timestamp are overwritten and
 * `sharedBy` is cleared, because this phone has now witnessed it.
 *
 * Scoped `AND sharedBy IS NOT NULL` so it can only ever upgrade provenance,
 * never rewrite a row this phone already witnessed. The row key is
 * `${authorId}.${m}`, identical on every phone, so the two copies are the
 * same row by construction — there is no matching to get wrong.
 *
 * `ai` is the arriving first-hand copy's Art. 50 claim, carried RAISE-ONLY: the CASE sets 1 when
 * the superseding copy claims it and otherwise leaves the column exactly as
 * it was — never cleared, because a lying (or merely older) client must not
 * un-badge a row by silence. Without this, applyContent's INSERT OR IGNORE
 * is a no-op against the existing row and the author's own marked message
 * stayed permanently unbadged on exactly the no-machine_peers phones the marker rule
 * serves.
 */
export async function supersedeRelayed(
  peerId: string,
  msgId: string,
  body: string,
  ts: number,
  ai: boolean,
): Promise<boolean> {
  const res = await conn().execute(
    `UPDATE messages SET body = ?, ts = ?, sharedBy = NULL,
            ai = CASE WHEN ? THEN 1 ELSE ai END
     WHERE msgId = ? AND peerId = ? AND sharedBy IS NOT NULL`,
    [body, ts, ai ? 1 : 0, msgId, peerId],
  );
  return (res.rowsAffected ?? 0) > 0;
}

/** Rewrite a chat's preview line WITHOUT touching lastMessageAt: an edit or a
 * retraction changes what the last message says, never when it arrived, so it
 * must not reorder the chat list. */
export async function setChatPreview(
  peerId: string,
  lastText: string,
): Promise<void> {
  await conn().execute(`UPDATE chats SET lastMessageText = ? WHERE peerId = ?`, [
    lastText,
    peerId,
  ]);
}

/**
 * Replace the words of a message its author rewrote.
 *
 * Scoped by peerId as well as (msgId, direction): msgIds are sender-chosen, so
 * without the conversation in the WHERE clause a peer could quote an id from
 * somebody else's thread and rewrite a message there. Two guards ride along —
 * a retracted row is never resurrected, and a stale edit (redelivery, or a
 * clock that moved backwards) can never overwrite a newer one.
 *
 * `ai` is the applied edit's own Art. 50 claim,
 * RAISE-ONLY on supersedeRelayed's exact terms: 1 when
 * the edit claims it, untouched otherwise — never cleared. The reviser is
 * the authenticated row author (resolveRevisionTarget), and in the shipped
 * `--stream`-without-`--marker` posture the anchor lands BARE while the
 * marked durable final arrives as this edit — discarding its claim left the
 * whole streamed reply unbadged on every paired-never-adopted phone.
 */
export async function applyEdit(
  peerId: string,
  msgId: string,
  direction: 'in' | 'out',
  text: string,
  ts: number,
  ai = false,
): Promise<boolean> {
  const res = await conn().execute(
    `UPDATE messages SET body = ?, editedAt = ?,
            ai = CASE WHEN ? THEN 1 ELSE ai END
     WHERE msgId = ? AND direction = ? AND peerId = ?
       AND deletedAt IS NULL
       AND (editedAt IS NULL OR editedAt < ?)`,
    [text, ts, ai ? 1 : 0, msgId, direction, peerId, ts],
  );
  // Whether anything matched: the caller parks a revision whose target row is
  // not on this device yet rather than acking it into oblivion.
  return (res.rowsAffected ?? 0) > 0;
}

/**
 * Retract a message on this device because its author retracted it: the words
 * (and any photo bytes and chips) actually go, but the row stays so the
 * conversation shows that something was here and is gone. A message that
 * silently vanishes is indistinguishable from one that never arrived.
 *
 * Same peer scope as applyEdit, and `deletedAt IS NULL` makes a redelivered
 * retraction a no-op rather than a re-stamp.
 */
export async function tombstoneMessage(
  peerId: string,
  msgId: string,
  direction: 'in' | 'out',
  ts: number,
): Promise<boolean> {
  const d = conn();
  let applied = false;
  await runExclusive(async () => {
    await d.execute('BEGIN IMMEDIATE');
    try {
      const res = await d.execute(
        `UPDATE messages SET body = '', deletedAt = ?
         WHERE msgId = ? AND direction = ? AND peerId = ? AND deletedAt IS NULL`,
        [ts, msgId, direction, peerId],
      );
      applied = (res.rowsAffected ?? 0) > 0;
      // Scoped through the messages row, exactly like the UPDATE above: a
      // msgId is sender-chosen, so an unscoped cascade would hand any peer a
      // way to destroy a photo or a chip in somebody else's conversation.
      await d.execute(
        `DELETE FROM attachments WHERE msgId = ? AND direction = ?
           AND EXISTS (SELECT 1 FROM messages m
                       WHERE m.msgId = ? AND m.direction = ? AND m.peerId = ?)`,
        [msgId, direction, msgId, direction, peerId],
      );
      await d.execute(
        `DELETE FROM reactions WHERE targetMsgId = ? AND targetDirection = ?
           AND EXISTS (SELECT 1 FROM messages m
                       WHERE m.msgId = ? AND m.direction = ? AND m.peerId = ?)`,
        [msgId, direction, msgId, direction, peerId],
      );
      await d.execute('COMMIT');
    } catch (err) {
      await d.execute('ROLLBACK').catch(() => undefined);
      throw err;
    }
  });
  return applied;
}

/**
 * Remove one message and everything hanging off it, on this device only —
 * there is no server copy and nothing is sent, so this is irreversible and the
 * confirmation in the UI is the only safety net.
 *
 * The `seen` row is deliberately left behind: it is what makes a redelivery of
 * the same frame a no-op, so without it the message a person just removed
 * could reappear on the next reconnect.
 */
export async function deleteMessage(
  msgId: string,
  direction: 'in' | 'out',
): Promise<void> {
  const d = conn();
  await runExclusive(async () => {
    await d.execute('BEGIN IMMEDIATE');
    try {
      // Whose line this row may be holding:
      // read before the deletes, so the chat's preview can be recomputed
      // for the right conversation once the row is gone. `ts` rides along
      // because WHETHER it held the line is decided by comparing it with
      // the chat's current sort key — see recomputeChatPreviewInTx.
      const owner = (
        await d.execute(
          `SELECT peerId, ts FROM messages WHERE msgId = ? AND direction = ?`,
          [msgId, direction],
        )
      ).rows[0] as unknown as { peerId: string; ts: number } | undefined;
      await d.execute(
        `DELETE FROM reactions WHERE targetMsgId = ? AND targetDirection = ?`,
        [msgId, direction],
      );
      await d.execute(
        `DELETE FROM attachments WHERE msgId = ? AND direction = ?`,
        [msgId, direction],
      );
      // Only my OWN send has an outbox row, so deleting an INBOUND row must
      // not touch it: a peer who reuses one of my msgIds could otherwise
      // destroy my queued message by sending me one I then delete for me
      // (found by review).
      //
      // BOTH KEYS: a group
      // message's legs carry random wire msgIds and point back through
      // `localMsgId`, so `msgId = ?` alone missed every leg — a deleted
      // group message left N envelopes that still transmitted. Safe inside
      // the direction guard: `localMsgId` is written exclusively by
      // enqueueOutgoingFanout and only ever names one of MY OWN 'out' rows.
      if (direction === 'out') {
        await d.execute(`DELETE FROM outbox WHERE msgId = ? OR localMsgId = ?`, [
          msgId,
          msgId,
        ]);
      }
      await d.execute(
        `DELETE FROM messages WHERE msgId = ? AND direction = ?`,
        [msgId, direction],
      );
      // The chat's line follows the row: both callers refresh only the
      // thread, so without this the list kept previewing the deleted
      // words, sorted under the deleted message's timestamp.
      if (owner) await recomputeChatPreviewInTx(d, owner.peerId, owner.ts);
      await d.execute('COMMIT');
    } catch (err) {
      await d.execute('ROLLBACK');
      throw err;
    }
  });
}

/**
 * Recompute one chat's line from what is left of its messages, inside the
 * caller's transaction. The rule messaging.refreshPreview applies from
 * outside, applied here from inside: the newest row that is retracted or not
 * a carrier wins — a retraction previews DELETED_PREVIEW, anything else its
 * preview line — and nothing left clears BOTH columns, the `previewNone`
 * state the list renders as "No messages yet" (never '' under a live
 * timestamp).
 *
 * WHAT THIS MAY NEVER DO is hand the line to a row the RECEIVE path refused
 * to line. `lastMessageAt` is the chat list's sort key, and refreshPreview —
 * whose rule this mirrors — never writes it at all; here a local "Delete for
 * me" does, so three kinds of row that are stored deliberately without a
 * touchChat have to be kept out of the candidate scan, or deleting any
 * message hands them the bump the protocol denied them:
 *
 *  - relayed history (`sharedBy`): a relayer's ACCOUNT of a message, under a
 *    timestamp the relayer chose — "history must not reorder their chat list
 *    to today" (messaging.ts, the grp.hist apply);
 *  - a row that arrived from OUTSIDE the room (`outsider`): "a declined
 *    attempt must not let an outsider reorder anyone's chat list";
 *  - a DECLINED announcement or roster attempt, which no column marks — only
 *    its missing touchChat does. That one is caught by never moving the sort
 *    key FORWARD: candidates are bounded to `ts <= the line's own timestamp`,
 *    so a row that is newer than the line and never lined the chat cannot
 *    become the line by way of somebody else's delete.
 *
 * And the recompute only runs at all when the deleted row could have BEEN the
 * line: older than the current sort key, it held nothing, and rewriting the
 * line from underneath it could only move it. A chat with no sort key
 * (`lastMessageAt IS NULL`) is left alone for the same reason — the list
 * renders it "No messages yet" and ignores the text entirely, so a delete
 * must not be what gives it a position. */
async function recomputeChatPreviewInTx(
  d: Handle,
  peerId: string,
  deletedTs: number,
): Promise<void> {
  const chat = (
    await d.execute(`SELECT lastMessageAt FROM chats WHERE peerId = ?`, [peerId])
  ).rows[0] as unknown as { lastMessageAt: number | null } | undefined;
  const lineAt = chat?.lastMessageAt ?? null;
  if (lineAt === null || deletedTs < lineAt) return;
  const rows = (
    await d.execute(
      `SELECT body, ts, deletedAt FROM messages
       WHERE peerId = ? AND ts <= ?
         AND sharedBy IS NULL AND COALESCE(outsider, 0) = 0
       ORDER BY ts DESC, msgId DESC LIMIT ?`,
      [peerId, lineAt, PREVIEW_SCAN],
    )
  ).rows as unknown as { body: string; ts: number; deletedAt: number | null }[];
  const latest = rows.find(r => r.deletedAt || !isCarrierEnvelope(r.body));
  if (!latest) {
    await d.execute(
      `UPDATE chats SET lastMessageAt = NULL, lastMessageText = NULL WHERE peerId = ?`,
      [peerId],
    );
    return;
  }
  await d.execute(
    `UPDATE chats SET lastMessageAt = ?, lastMessageText = ? WHERE peerId = ?`,
    [
      latest.ts,
      latest.deletedAt ? DELETED_PREVIEW : await previewInTx(d, latest.body),
      peerId,
    ],
  );
}

/**
 * previewFor with this phone's OWN names for a mention body, from the
 * store's own rows — messaging.previewWithNames minus the service, because a
 * resolver-less recompute rewrites "@Cara lunch?" to " lunch?" (the
 * resolver-must-name rule). Self renders as 'you'; anyone else as personName
 * (localName ∥ displayName ∥ id-fragment — the renderer treats an id-fragment
 * echo as "cannot name" and keeps the words, G7).
 */
async function previewInTx(d: Handle, body: string): Promise<string> {
  const who = mentionWho(body);
  if (who.length === 0) return previewFor(body);
  const self = (
    await d.execute(`SELECT value FROM profile WHERE key = 'userId'`)
  ).rows[0] as unknown as { value: string } | undefined;
  const names = new Map<string, string>();
  for (const id of new Set(who)) {
    if (id === self?.value) {
      names.set(id, 'you');
      continue;
    }
    const chat = (
      await d.execute(
        `SELECT displayName, localName FROM chats WHERE peerId = ?`,
        [id],
      )
    ).rows[0] as unknown as
      | { displayName: string | null; localName: string | null }
      | undefined;
    if (chat) names.set(id, personName(id, chat.displayName, chat.localName));
  }
  return previewFor(body, id => names.get(id) ?? null);
}

/**
 * Remove a whole conversation from this device: its messages, their photos and
 * reactions, its vault items, its 1:1 call history and the always-relay choice
 * made about that person, anything still queued to send, and the draft. The
 * room legs are scoped out and die with the room (`deleteGroup`).
 * Irreversible for the same reason as `deleteMessage`, and `seen` survives for
 * the same reason. Children go before parents so a failure mid-way cannot
 * orphan rows.
 *
 * `call_relay_prefs` goes with the calls, and that is a judgement rather than
 * a cascade: it is one row per peer recording a choice made ABOUT that
 * person, which is the same residue as the call log — a delete that claims
 * to take the calls but leaves a row naming who was called. It is safe to
 * take because it is a PREFERENCE, not a protection, and it cannot become one
 * by being kept: the `call_log` rows go in the same transaction, so
 * `hasConnectedCallWith` is false for a re-added peer and `relayForPeer`
 * falls back to its first-call default, which relays. Dropping the row can
 * only make the next call more careful, never less.
 *
 * A block is NOT removed here, deliberately. `blocked_peers` is a separate
 * table so that deleting a conversation cannot silently unblock the person
 * it was with — their next message would otherwise recreate the row and land
 * in the list. `seen` survives deletion for the same reason.
 *
 * Vault items ARE removed, and that is the opposite decision taken for the
 * opposite reason. A block is a PROTECTION whose loss would
 * let something back in; a vault item is content belonging to the Room, and
 * leaving it would orphan a row of credentials behind a conversation no screen
 * can reach any more.
 */
export async function deleteChat(peerId: string): Promise<void> {
  const d = conn();
  await runExclusive(async () => {
    await d.execute('BEGIN IMMEDIATE');
    try {
      // Whole-key matched, as in sweepExpired and tombstoneMessage: deleting
      // one conversation must not reach into another's rows through a
      // sender-chosen msgId that happens to collide.
      await d.execute(
        `DELETE FROM reactions WHERE EXISTS (
           SELECT 1 FROM messages m
           WHERE m.msgId = reactions.targetMsgId
             AND m.direction = reactions.targetDirection
             AND m.peerId = ?)`,
        [peerId],
      );
      await d.execute(
        `DELETE FROM attachments WHERE EXISTS (
           SELECT 1 FROM messages m
           WHERE m.msgId = attachments.msgId
             AND m.direction = attachments.direction
             AND m.peerId = ?)`,
        [peerId],
      );
      // `localMsgId IS NULL` is the third instance of the dormant-defect
      // class, found while making the first two live: a
      // fan-out leg is queued against a MEMBER id, so deleting my 1:1
      // conversation with Ana would otherwise take the room message legs
      // addressed to her with it — a silent omission, the exact tell.
      // The 1:1 purge keeps its scope: this conversation's envelopes only.
      // Room legs belong to the room and die with it (deleteGroup), with
      // their message (deleteMessage), or with their expiry (sweepExpired).
      await d.execute(
        `DELETE FROM outbox WHERE peerId = ? AND localMsgId IS NULL`,
        [peerId],
      );
      await d.execute(`DELETE FROM drafts WHERE peerId = ?`, [peerId]);
      // Keyed on peerId directly, like outbox and drafts — a held revision
      // for a conversation that no longer exists has nothing to apply to,
      // and left behind it would apply to a future row of the same id.
      await d.execute(`DELETE FROM pending_revisions WHERE peerId = ?`, [peerId]);
      // Keyed on peerId directly, so it sits with outbox/drafts rather than
      // with the two subquery-driven deletes above — it needs no messages row
      // to find its rows, and it must go before `chats` like every other child.
      await d.execute(`DELETE FROM vault_items WHERE peerId = ?`, [peerId]);
      // The calls go with the conversation, or "delete" is not what happened.
      // Without this the person kept every call row on the Calls tab, renamed
      // to a bare id fragment (CallsScreen resolves names from listChats) and
      // still one tap from redial — under a confirmation that says Tacendum
      // has no copy to restore.
      //
      // `roomId IS NULL` is the SAME scoping the outbox delete above makes,
      // for the same reason: a room call writes ONE ROW PER LEG keyed by the
      // member's id, so an unscoped purge would take the room's call history
      // out with a 1:1 delete. A room's calls belong to the room and die with
      // it (deleteGroup).
      await d.execute(
        `DELETE FROM call_log WHERE peerId = ? AND roomId IS NULL`,
        [peerId],
      );
      // And the remembered always-relay choice about this person, keyed on
      // peerId directly like outbox and drafts. The reasoning is written
      // above: a preference, not a protection, and safe to drop precisely
      // because the call rows it would have outlived go in the same
      // transaction. NOT deleted by deleteGroup — a room id never appears
      // in this table, and a member's own choice is not the room's to take.
      await d.execute(`DELETE FROM call_relay_prefs WHERE peerId = ?`, [
        peerId,
      ]);
      // Approval payloads are conversation-owned exact command/file bytes.
      // Leaving them behind would let recreating this chat revive an old
      // authorisation request under the same (peerId, q).
      await d.execute(`DELETE FROM approvals WHERE peerId = ?`, [peerId]);
      await d.execute(`DELETE FROM ai_work_events WHERE peerId = ?`, [peerId]);
      await d.execute(`DELETE FROM ai_agent_state WHERE peerId = ?`, [peerId]);
      await d.execute(`DELETE FROM ai_notify_preferences WHERE peerId = ?`, [peerId]);
      await d.execute(`DELETE FROM ai_task_templates WHERE peerId = ?`, [peerId]);
      await d.execute(`DELETE FROM messages WHERE peerId = ?`, [peerId]);
      await d.execute(`DELETE FROM chats WHERE peerId = ?`, [peerId]);
      await d.execute('COMMIT');
    } catch (err) {
      await d.execute('ROLLBACK');
      throw err;
    }
  });
  // AFTER the durable delete, and best-effort, on deleteGroup's reasoning:
  // the person is gone from chats, so their name must leave the extension's
  // mirror or a straggler VoIP push (or a room mention) would still greet
  // the owner with a name this phone deliberately no longer holds.
  republishPeerNames();
}

/**
 * Remove a room from this device: deleteChat's
 * cascade sibling, with the room's ULID standing where the peerId stands.
 * Same purge set, same order (children before parents), and — exactly like
 * deleteChat — it MUST NOT clear blocks: a member blocked from inside a room
 * stays blocked after the room is gone.
 *
 * TWO FORMS, and which tables each touches is the entire design:
 *
 *  - DEFAULT (a local delete — the drawer's "Delete room"): purges the
 *    conversation — messages, attachments, reactions, outbox, drafts, held
 *    revisions, the chats row — and KEEPS the groups anchor, the
 *    group_members / group_settings slots and the group_counters row. That is
 *    deleteChat's precedent made structural: a deleted conversation comes
 *    back on the next inbound message, and a room can only come back if its
 *    owner, roster and my own counters survive the delete (a reset counter
 *    would make my next write reuse a number some peer already holds).
 *
 *  - purgeState: true — called ONLY by the grp.del apply path (the counted,
 *    owner-authenticated delete-for-everyone): removes those four too. After
 *    this the phone does not hold the room at all, and later traffic for its
 *    groupId is discarded quietly upstream.
 *
 * Fan-out legs are queued against MEMBER ids, not the room id, so
 * outbox.peerId = groupId alone would miss every queued leg; outbox.localMsgId
 * pointing into the room's message rows is the key that finds them, which is
 * why the outbox purge runs while the message rows still exist.
 */
export async function deleteGroup(
  groupId: string,
  opts: { purgeState?: boolean } = {},
): Promise<void> {
  const d = conn();
  await runExclusive(async () => {
    await d.execute('BEGIN IMMEDIATE');
    try {
      // Whole-key matched, exactly as deleteChat: deleting one room must not
      // reach into another conversation's rows through a sender-chosen msgId
      // that happens to collide.
      await d.execute(
        `DELETE FROM reactions WHERE EXISTS (
           SELECT 1 FROM messages m
           WHERE m.msgId = reactions.targetMsgId
             AND m.direction = reactions.targetDirection
             AND m.peerId = ?)`,
        [groupId],
      );
      await d.execute(
        `DELETE FROM attachments WHERE EXISTS (
           SELECT 1 FROM messages m
           WHERE m.msgId = attachments.msgId
             AND m.direction = attachments.direction
             AND m.peerId = ?)`,
        [groupId],
      );
      // Both keys: legs a fan-out queued to members (found through
      // localMsgId, direction-guarded so a peer-chosen inbound id cannot
      // widen the match), and anything queued against the room id directly.
      await d.execute(
        `DELETE FROM outbox WHERE peerId = ? OR EXISTS (
           SELECT 1 FROM messages m
           WHERE m.msgId = outbox.localMsgId
             AND m.direction = 'out'
             AND m.peerId = ?)`,
        [groupId, groupId],
      );
      await d.execute(`DELETE FROM drafts WHERE peerId = ?`, [groupId]);
      await d.execute(`DELETE FROM pending_revisions WHERE peerId = ?`, [
        groupId,
      ]);
      await d.execute(`DELETE FROM vault_items WHERE peerId = ?`, [groupId]);
      // deleteChat's purge, room-keyed: a room call's legs each carry this
      // roomId, so one statement reaches the whole session's history and no
      // member's 1:1 rows.
      await d.execute(`DELETE FROM call_log WHERE roomId = ?`, [groupId]);
      // And the live-session roster. Not history — `call_sessions` is written
      // before CallKit rings and deleted at release — but a row stranded by a
      // crash outlives the room, and this table's own comment says what that
      // costs: it hands a coerced unlock the membership the decoy exists to
      // hide. In BOTH forms, because a locally deleted room is exactly the
      // room whose roster must not be readable from the drawer that deleted
      // it.
      await d.execute(`DELETE FROM call_sessions WHERE roomId = ?`, [groupId]);
      await d.execute(`DELETE FROM messages WHERE peerId = ?`, [groupId]);
      await d.execute(`DELETE FROM chats WHERE peerId = ?`, [groupId]);
      if (opts.purgeState) {
        await d.execute(`DELETE FROM group_members WHERE groupId = ?`, [
          groupId,
        ]);
        await d.execute(`DELETE FROM group_settings WHERE groupId = ?`, [
          groupId,
        ]);
        await d.execute(`DELETE FROM group_counters WHERE groupId = ?`, [
          groupId,
        ]);
        await d.execute(`DELETE FROM groups WHERE groupId = ?`, [groupId]);
      }
      await d.execute('COMMIT');
    } catch (err) {
      await d.execute('ROLLBACK');
      throw err;
    }
  });
  // AFTER the durable delete, and best-effort: the room is gone from chats,
  // so its name must leave the extension's mirror or a straggler push would
  // still title a banner with a room this phone deliberately no longer
  // holds.
  republishGroupNames();
}

/**
 * Allocate the next number in one of MY two per-room sequences, atomically:
 *
 *  - 'writer': numbers my grp.new / grp.roster / grp.set writes. One counter
 *    per room across all of my lanes, because a grp.new carries ONE n for its
 *    whole member list; each lane then receives an increasing subsequence,
 *    which is all a per-lane max-merge needs. Gaps are legal and
 *    unobservable.
 *  - 'msg': numbers messages.sq on my own outbound messages — the
 *    (ts, authorId, sq) thread order, monotonic per (author, room).
 *
 * One statement, allocate-then-return: read-the-row-then-add is not a mutex,
 * and two overlapping sends sharing a number is the one thing a max-merged
 * lane cannot tolerate (the peer keeps whichever content arrived first and
 * the divergence is permanent and silent).
 */
/** A room's anchor: the constants written once at accept. */
export interface GroupRow {
  groupId: string;
  ownerId: string;
  name: string | null;
}

export async function getGroup(groupId: string): Promise<GroupRow | null> {
  const res = await conn().execute(
    `SELECT groupId, ownerId, name FROM groups WHERE groupId = ?`,
    [groupId],
  );
  return (res.rows[0] as unknown as GroupRow) ?? null;
}

/**
 * Every room anchor this device holds, in one read.
 *
 * The chat list resolved rooms with a getGroup per row — N single-row selects
 * beside the four reads a refresh already makes, on the screen a person looks
 * at most, re-run on every receipt, frame, socket transition and attachment
 * tick. The rate is coalesced; the COST per refresh was not. The caller keeps
 * its own map and filters to the ids it is drawing, and it keeps the
 * press-time getGroup re-check as well: that one is a correctness gate
 * against stranding a room's queued fan-out legs, not render cost.
 *
 * The same three columns getGroup reads, deliberately — one anchor shape.
 */
export async function listGroups(): Promise<GroupRow[]> {
  const res = await conn().execute(`SELECT groupId, ownerId, name FROM groups`);
  return res.rows as unknown as GroupRow[];
}

/**
 * The rooms the notification extension may NAME, read
 * from `chats` rather than `groups` because presence is the chats row: a
 * locally deleted room must leave the mirror, or its name would keep
 * appearing on the lock screen for straggler traffic the app will quietly
 * recreate-or-drop. Precedence is `personName`'s exactly — the name I gave
 * the room outranks the name its creator set — and rooms resolving to no
 * name are handed over empty for `publishGroupNames` to drop.
 */
async function listGroupNames(): Promise<
  { groupId: string; name: string }[]
> {
  const res = await conn().execute(
    `SELECT peerId, groupName, localName FROM chats WHERE kind = 'group'`,
  );
  const rows = res.rows as {
    peerId: string;
    groupName: string | null;
    localName: string | null;
  }[];
  return rows.map(r => ({
    groupId: r.peerId,
    name: (r.localName ?? '').trim() || (r.groupName ?? '').trim(),
  }));
}

/**
 * The PEOPLE the peer mirror may name: 1:1 rows only, `listGroupNames`'s
 * complement. Rooms are chats rows too, and mapping listChats whole used to
 * write a renamed room's name into the peer file — a room name is the same
 * disclosure class as a contact (retractSelfId's reasoning), and it belongs
 * solely to the group mirror. Precedence is `personName`'s; peers resolving
 * to no name are handed over empty for `publishPeerNames` to drop, which is
 * what makes the ring fall back to its placeholder rather than a ULID.
 * NULL kind is the 1:1 every pre-rooms row is.
 */
export async function listPeerNames(): Promise<
  { peerId: string; name: string }[]
> {
  const res = await conn().execute(
    `SELECT peerId, displayName, localName FROM chats
     WHERE COALESCE(kind, 'peer') = 'peer'`,
  );
  const rows = res.rows as {
    peerId: string;
    displayName: string | null;
    localName: string | null;
  }[];
  return rows.map(r => ({
    peerId: r.peerId,
    name: (r.localName ?? '').trim() || (r.displayName ?? '').trim(),
  }));
}

/**
 * Mirror the room names to the file the extension reads, following the
 * database from HERE — its own writer — on `setLocalName`'s reasoning: a
 * mirror callers must remember is a mirror one of them forgets, and the cost
 * of forgetting is a room banner that misattributes itself as a 1:1. Called
 * where the mirror's inputs change (a room appearing, a room deleted, a
 * rename) and from initDb so a real unlock rebuilds what the last relock
 * retracted. Fire-and-forget: no room operation may fail over a mirror, and
 * the duress/relock gates live at the write inside `publishGroupNames`.
 */
function republishGroupNames(): void {
  void (async () => {
    await publishGroupNames(await listGroupNames());
  })().catch(() => undefined);
}

/**
 * The peer mirror's twin of `republishGroupNames`, on the same reasoning:
 * the mirror follows the database from its own writer, fire-and-forget —
 * no rename or delete may fail over a mirror — and the duress/relock gates
 * live at the write inside `publishPeerNames`.
 */
function republishPeerNames(): void {
  void (async () => {
    await publishPeerNames(await listPeerNames());
  })().catch(() => undefined);
}

/**
 * Every stored membership slot of one room, in the exact shape
 * `foldRoster` consumes — the send path folds these to
 * learn who a fan-out addresses. `updatedAt` is display-only and deliberately
 * not selected: nothing downstream may order by a wall clock.
 */
export interface GroupMemberSlotRow {
  memberId: string;
  writerId: string;
  seq: number;
  state: 'in' | 'out';
  /** The roster-write member class — 'integration' or
   * absent. Normalised from the column's NULL so the shared fold's optional
   * field reads it verbatim; anything else stored is treated as absent (the
   * class costs itself, never the slot). */
  class?: 'integration';
}

export async function listGroupMemberSlots(
  groupId: string,
): Promise<GroupMemberSlotRow[]> {
  const res = await conn().execute(
    `SELECT memberId, writerId, seq, state, class FROM group_members WHERE groupId = ?`,
    [groupId],
  );
  return (
    res.rows as unknown as (Omit<GroupMemberSlotRow, 'class'> & {
      class?: unknown;
    })[]
  ).map(({ class: cls, ...slot }) => ({
    ...slot,
    ...(cls === 'integration' ? { class: 'integration' as const } : {}),
  }));
}

/** Every stored timer slot of one room, in `effectiveDisappearSec`'s shape: the send path stamps my own copy's expiry from the
 * folded minimum, exactly as a 1:1 send stamps `chats.disappearSec`. */
export interface GroupSettingsSlotRow {
  writerId: string;
  seq: number;
  disappearSec: number;
}

export async function listGroupSettingsSlots(
  groupId: string,
): Promise<GroupSettingsSlotRow[]> {
  const res = await conn().execute(
    `SELECT writerId, seq, disappearSec FROM group_settings WHERE groupId = ?`,
    [groupId],
  );
  return res.rows as unknown as GroupSettingsSlotRow[];
}

export async function reserveGroupSeq(
  groupId: string,
  scope: 'writer' | 'msg',
): Promise<number> {
  const res = await conn().execute(
    `INSERT INTO group_counters (groupId, scope, seq) VALUES (?, ?, 1)
     ON CONFLICT(groupId, scope) DO UPDATE SET
       seq = group_counters.seq + 1
     RETURNING seq`,
    [groupId, scope],
  );
  const returned = (res.rows[0] as unknown as { seq: number } | undefined)?.seq;
  if (typeof returned === 'number') return returned;
  // REFUSE RATHER THAN GUESS — reserveVaultSeq's argument, which applies here
  // unchanged: re-reading the row hands two overlapping allocations the SAME
  // number, so a driver that drops RETURNING rows must break the write loudly
  // rather than let two frames share one ordering key.
  throw new Error('groups: the counter could not be allocated');
}

// --- Rooms: the SQLite binding of the slot-store seam -----

/** One recorded store mutation, replayed onto SQLite by persist() in the
 * order the pure apply issued it. */
type GroupStoreMutation =
  | { op: 'anchor'; ownerId: string; name: string | null }
  | { op: 'putSlot'; slot: GroupMemberSlotRow }
  | { op: 'deleteSlot'; memberId: string; writerId: string }
  | { op: 'putSettings'; slot: GroupSettingsSlotRow }
  | { op: 'present' }
  | { op: 'clear' };

/**
 * `GroupSlotStore` (packages/shared/src/group-fold.ts), bound to SQLite.
 *
 * The seam's methods are SYNCHRONOUS — the fold is a pure computation and
 * must stay one — so this binding is a LOADED SNAPSHOT plus a mutation log:
 * `loadGroupStore` reads the room's anchor, slots, settings and presence in
 * one pass; the pure apply functions run against the in-memory copy exactly
 * as the CLI's file store will run them; `persist()` then replays the
 * recorded mutations onto the real tables. The apply path serialises whole
 * load→apply→persist rounds per room (messaging's runGroupApply), so the
 * snapshot cannot go stale between load and persist.
 *
 * Presence is the `chats` row: false after a local delete, while the
 * anchor and slots survive — which is exactly why the two live behind one
 * seam, so the two delete acts cannot fork per platform.
 */
export interface LoadedGroupStore {
  readonly groupId: string;
  /** The room name for the chats row when presence turns on. The grp.new
   * accept path sets it from the envelope before applying; every later load
   * carries the anchor's stored name. Never trusted from any later write. */
  anchorName: string | null;
  getOwner(): string | undefined;
  setOwner(ownerId: string): void;
  getSlot(memberId: string, writerId: string): GroupMemberSlotRow | undefined;
  putSlot(slot: GroupMemberSlotRow): void;
  deleteSlot(memberId: string, writerId: string): void;
  listSlots(): readonly GroupMemberSlotRow[];
  getSettingsSlot(writerId: string): GroupSettingsSlotRow | undefined;
  putSettingsSlot(slot: GroupSettingsSlotRow): void;
  listSettingsSlots(): readonly GroupSettingsSlotRow[];
  isPresent(): boolean;
  setPresent(present: boolean): void;
  clear(): void;
  persist(): Promise<void>;
}

export async function loadGroupStore(
  groupId: string,
): Promise<LoadedGroupStore> {
  const anchor = await getGroup(groupId);
  const slotRows = await listGroupMemberSlots(groupId);
  const settingsRows = await listGroupSettingsSlots(groupId);
  const chat = (
    await conn().execute(`SELECT peerId FROM chats WHERE peerId = ?`, [groupId])
  ).rows as { peerId: string }[];

  let owner = anchor?.ownerId;
  let present = chat.length > 0;
  const slots = new Map(
    slotRows.map(s => [`${s.memberId}|${s.writerId}`, s] as const),
  );
  const settings = new Map(settingsRows.map(s => [s.writerId, s] as const));
  const mutations: GroupStoreMutation[] = [];

  const store: LoadedGroupStore = {
    groupId,
    anchorName: anchor?.name ?? null,
    getOwner: () => owner,
    setOwner(ownerId) {
      // Written once at accept, never updated by any later write:
      // applyGroupNew only calls this when no anchor exists, and persist()
      // writes it with OR IGNORE so even a raced duplicate cannot re-anchor.
      owner = ownerId;
      mutations.push({ op: 'anchor', ownerId, name: store.anchorName });
    },
    getSlot: (memberId, writerId) => slots.get(`${memberId}|${writerId}`),
    putSlot(slot) {
      slots.set(`${slot.memberId}|${slot.writerId}`, slot);
      mutations.push({ op: 'putSlot', slot });
    },
    deleteSlot(memberId, writerId) {
      slots.delete(`${memberId}|${writerId}`);
      mutations.push({ op: 'deleteSlot', memberId, writerId });
    },
    listSlots: () => [...slots.values()],
    getSettingsSlot: writerId => settings.get(writerId),
    putSettingsSlot(slot) {
      settings.set(slot.writerId, slot);
      mutations.push({ op: 'putSettings', slot });
    },
    listSettingsSlots: () => [...settings.values()],
    isPresent: () => present,
    setPresent(next) {
      if (next === present) return;
      present = next;
      if (next) {
        mutations.push({ op: 'present' });
        return;
      }
      // No inbound apply ever turns presence OFF: a local delete is the UI's
      // act and goes through deleteGroup directly, and the counted grp.del
      // goes through clear(). A pure-layer change that starts emitting this
      // must be seen, not absorbed into a quiet no-op.
      throw new Error('groups: no inbound apply may delete a room locally');
    },
    clear() {
      owner = undefined;
      present = false;
      slots.clear();
      settings.clear();
      mutations.push({ op: 'clear' });
    },
    async persist() {
      const pending = mutations.splice(0, mutations.length);
      if (pending.length === 0) return;
      // The counted grp.del is its own cascade (deleteGroup runs its own
      // exclusive transaction, so it cannot nest inside the batch below) and
      // the pure classifier emits it alone — applyGroupDel touches nothing
      // else. Asserted rather than assumed.
      if (pending.some(m => m.op === 'clear')) {
        if (pending.length !== 1) {
          throw new Error('groups: clear() must be the only recorded mutation');
        }
        await deleteGroup(groupId, { purgeState: true });
        return;
      }
      // One transaction for the rest: a grp.new is an anchor plus up to
      // GROUP_MAX_MEMBERS slots plus the chats row, and a crash between them
      // would leave a room whose redelivered frame can never be re-decrypted
      // (the ratchet key is spent) — the same invariant
      // enqueueOutgoingFanout holds for the send path.
      const d = conn();
      await runExclusive(async () => {
        await d.execute('BEGIN IMMEDIATE');
        try {
          for (const m of pending) {
            if (m.op === 'anchor') {
              await d.execute(
                `INSERT OR IGNORE INTO groups (groupId, ownerId, name)
                 VALUES (?, ?, ?)`,
                [groupId, m.ownerId, m.name],
              );
            } else if (m.op === 'putSlot') {
              await d.execute(
                `INSERT OR REPLACE INTO group_members
                   (groupId, memberId, writerId, seq, state, updatedAt, class)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [
                  groupId,
                  m.slot.memberId,
                  m.slot.writerId,
                  m.slot.seq,
                  m.slot.state,
                  // Display only; nothing orders by it.
                  Date.now(),
                  // The write's class claim, verbatim with its
                  // slot; NULL = unknown/human.
                  m.slot.class ?? null,
                ],
              );
            } else if (m.op === 'deleteSlot') {
              await d.execute(
                `DELETE FROM group_members
                 WHERE groupId = ? AND memberId = ? AND writerId = ?`,
                [groupId, m.memberId, m.writerId],
              );
            } else if (m.op === 'putSettings') {
              await d.execute(
                `INSERT OR REPLACE INTO group_settings
                   (groupId, writerId, seq, disappearSec)
                 VALUES (?, ?, ?, ?)`,
                [groupId, m.slot.writerId, m.slot.seq, m.slot.disappearSec],
              );
            } else if (m.op === 'present') {
              // kind='group' unconditionally: a room id can never have been a
              // 1:1 row, and re-stamping is idempotent. groupName only fills
              // a hole — a rename is chats.localName and must survive
              // recreation.
              await d.execute(
                `INSERT INTO chats (peerId, createdAt, kind, groupName)
                 VALUES (?, ?, 'group', ?)
                 ON CONFLICT(peerId) DO UPDATE SET
                   kind = 'group',
                   groupName = COALESCE(chats.groupName, excluded.groupName)`,
                [groupId, Date.now(), store.anchorName],
              );
            }
          }
          await d.execute('COMMIT');
        } catch (err) {
          await d.execute('ROLLBACK');
          throw err;
        }
      });
      // A room APPEARING is the one mutation in this batch that changes the
      // extension's name mirror — slots and settings say who is in a room,
      // never what it is called. After the commit, so the mirror can only
      // ever trail the durable truth, and best-effort like every publisher. The clear() branch republishes inside
      // deleteGroup.
      if (pending.some(m => m.op === 'present')) {
        republishGroupNames();
      }
    },
  };
  return store;
}

/**
 * Agree a disappearing-message timer for this conversation, newest wins.
 *
 * Returns whether it was applied: a frame carrying an older version than the
 * one on the row is dropped, which is what stops a delayed or replayed
 * envelope from quietly lengthening (or shortening) the timer later.
 */
export async function setDisappearTimer(
  peerId: string,
  seconds: number,
  version: number,
): Promise<boolean> {
  const d = conn();
  const rows = (
    await d.execute(`SELECT disappearVersion FROM chats WHERE peerId = ?`, [peerId])
  ).rows as { disappearVersion: number | null }[];
  const current = rows[0]?.disappearVersion ?? -1;
  if (rows.length > 0 && version <= current) return false;
  await d.execute(
    `INSERT INTO chats (peerId, disappearSec, disappearVersion)
     VALUES (?, ?, ?)
     ON CONFLICT(peerId) DO UPDATE SET disappearSec = ?, disappearVersion = ?`,
    [peerId, seconds, version, seconds, version],
  );
  return true;
}

/**
 * Start the clock on messages that are now visible.
 *
 * Inbound rows get their expiry when they are READ, not when they arrive: a
 * message that expired in the queue while the phone was off would vanish
 * having never been delivered, which is indistinguishable from losing it.
 * Only rows with no expiry yet are touched, so re-opening a thread never
 * extends anything.
 */
export async function armExpiry(
  peerId: string,
  seconds: number,
  now: number,
): Promise<void> {
  if (seconds <= 0) return;
  await conn().execute(
    `UPDATE messages SET expiresAt = ?
     WHERE peerId = ? AND direction = 'in' AND expiresAt IS NULL`,
    [now + seconds * 1000, peerId],
  );
}

/**
 * Delete every message whose time is up, with its attachments and reactions.
 * Returns how many rows went, so a caller can skip re-rendering for nothing.
 *
 * One transaction: a sweep that removed a message but left its photo pointer
 * behind would leave the blob referenced by nothing and undeletable.
 */
export async function sweepExpired(now: number): Promise<number> {
  const d = conn();
  return runExclusive(async () => {
    // The age reaps run on every sweep, expiring messages or not, and
    // outside the transaction below: they answer no render decision and
    // touch nothing the transaction's whole-key cascades reach.
    //
    // A held revision or a reaction whose target has not arrived inside the
    // server's queue TTL is waiting for a frame that can no longer be
    // delivered. `ts` is the sender's stamp — clamped on the way in for
    // revisions (reviseStamp), server-stamped for a delivered frame — so a
    // future-dated one is reaped at most a day late, never never.
    await d.execute(`DELETE FROM pending_revisions WHERE ts <= ?`, [
      now - HELD_REVISION_TTL_MS,
    ]);
    await d.execute(
      `DELETE FROM reactions WHERE ts <= ? AND NOT EXISTS (
         SELECT 1 FROM messages m
         WHERE m.msgId = reactions.targetMsgId
           AND m.direction = reactions.targetDirection)`,
      [now - HELD_REVISION_TTL_MS],
    );
    // The approvals retention rule, as listApprovals applies it — here for
    // every conversation, so a thread never opened cannot keep a machine's
    // command lines past the CLI journal's own retention.
    await d.execute(
      `DELETE FROM approvals
       WHERE ? - COALESCE(settledAt, arrivedAt) >= ${APPROVAL_RETAIN_MS}`,
      [now],
    );
    const doomed = (
      await d.execute(
        `SELECT msgId FROM messages WHERE expiresAt IS NOT NULL AND expiresAt <= ?`,
        [now],
      )
    ).rows as { msgId: string }[];
    if (doomed.length === 0) return 0;
    await d.execute('BEGIN IMMEDIATE');
    try {
      // MATCHED ON THE WHOLE KEY, not on msgId alone. A msgId is chosen by
      // whoever sent the message, so `msgId IN (SELECT ...)` let a peer's
      // expiring message delete the attachment or the chip belonging to MY
      // message of the same id — the collision `tombstoneMessage` already
      // guards against, in the two places that had not copied the guard.
      await d.execute(
        `DELETE FROM reactions WHERE EXISTS (
           SELECT 1 FROM messages m
           WHERE m.msgId = reactions.targetMsgId
             AND m.direction = reactions.targetDirection
             AND m.expiresAt IS NOT NULL AND m.expiresAt <= ?)`,
        [now],
      );
      await d.execute(
        `DELETE FROM attachments WHERE EXISTS (
           SELECT 1 FROM messages m
           WHERE m.msgId = attachments.msgId
             AND m.direction = attachments.direction
             AND m.expiresAt IS NOT NULL AND m.expiresAt <= ?)`,
        [now],
      );
      // A held edit/delete waiting for its target: the target is expiring,
      // so the revision has nothing left to revise. Omitted from the first
      // pass (found by review); whole-key matched like the two above.
      await d.execute(
        `DELETE FROM pending_revisions WHERE EXISTS (
           SELECT 1 FROM messages m
           WHERE m.msgId = pending_revisions.targetMsgId
             AND m.direction = pending_revisions.targetDirection
             AND m.expiresAt IS NOT NULL AND m.expiresAt <= ?)`,
        [now],
      );
      // THE ROW THAT STILL TRANSMITS. A disappearing message the person
      // watched vanish could still be sitting in the outbox, un-flushed —
      // and the next flush sent it, minutes or hours after its own timer
      // said it was gone. The visible row and the queued envelope are the
      // same message and must die together.
      //
      // Scoped to direction='out' for the same reason as the two above: an
      // inbound message carrying a colliding sender-chosen msgId must not
      // delete MY queued envelope.
      //
      // BOTH KEYS: a fan-out leg's
      // wire msgId is pure randomness and never equals the message row's own
      // id — the legs point back through `localMsgId` — so matching on
      // outbox.msgId alone missed every leg, and an expired group message
      // left N envelopes that still transmitted. `localMsgId` only ever
      // names one of MY OWN 'out' rows (it is written exclusively by
      // enqueueOutgoingFanout), so the direction guard holds for it too.
      await d.execute(
        `DELETE FROM outbox WHERE msgId IN
           (SELECT msgId FROM messages
            WHERE expiresAt IS NOT NULL AND expiresAt <= ? AND direction = 'out')
         OR localMsgId IN
           (SELECT msgId FROM messages
            WHERE expiresAt IS NOT NULL AND expiresAt <= ? AND direction = 'out')`,
        [now, now],
      );
      await d.execute(
        `DELETE FROM messages WHERE expiresAt IS NOT NULL AND expiresAt <= ?`,
        [now],
      );
      await d.execute('COMMIT');
    } catch (err) {
      await d.execute('ROLLBACK');
      throw err;
    }
    return doomed.length;
  });
}

/**
 * How many inbound messages arrived in each chat since I last opened it.
 *
 * TWO WINDOWS, one per row shape, because the receive path writes two shapes
 * — and pretending it was one shape is what hid a real bug for the whole
 * life of rooms. Both windows are THIS PHONE'S OWN CLOCK (never
 * `messages.ts`: a peer with a skewed clock cannot manufacture a row that
 * stays unread forever). A ROOM row's msgId is the composite
 * `${author}.${m}` while `seen` records wire ids, so no seen row can ever
 * match one; its window is `arrivedAt`, stamped at the insert. A 1:1 row's
 * window is `arrivedAt` too, falling back to `seen.ts` (also this device's
 * clock, stamped when the frame was processed) only for rows predating the
 * arrivedAt column — those keep counting instead of degrading. The fallback
 * must never be the PRIMARY window: markSeen prunes `seen` to the 5000 most
 * recently seen rows on every call (by `ts` — it used to be by
 * msgId, and a room fan-out leg's wire id is pure CSPRNG, most of which sort
 * above any time-ordered 1:1 ULID, so ordinary room traffic preferentially
 * evicted exactly the 1:1 seen rows), and a window read from seen alone
 * silently cleared an unread chat's dot and the app badge once a row aged
 * out. The branches must not fall through to each other, either: an inbound
 * announcement row (grp.new, grp.roster) is keyed by its WIRE id, which
 * `seen` DOES match — a room count that borrowed the seen window would call
 * being added to a room "unread", and the announcement insert deliberately
 * leaves `arrivedAt` NULL (an event, not a message), so the room branch's
 * COALESCE keeps it out.
 *
 * `sharedBy IS NULL`: a newcomer handed 200 relayed history rows must not
 * see 200 unread — the same rule that keeps relays out of touchChat and
 * notifications. `COALESCE(arrivedAt, 0)`: pre-migration room rows never
 * count (they were seen under the old broken behaviour anyway) — honest
 * degrade, no false unread storm on upgrade. `direction = 'in'` keeps a
 * sender-chosen msgId that collides with one of my own sent ids from
 * counting, and carrier envelopes never insert a messages row so they cannot
 * count at all. */
export async function unreadCounts(): Promise<Record<string, number>> {
  const res = await conn().execute(
    // NO BACKTICKS IN THIS COMMENT, deliberately: scripts/prove-db.mjs pulls
    // a function's SQL by finding the first backtick after its name, so one
    // in the prose above the query silently becomes the "SQL" it proves. This
    // comment cost three real-engine proofs the first time it was written.
    `SELECT m.peerId AS peerId, COUNT(*) AS n
     FROM messages m
     JOIN chats c ON c.peerId = m.peerId
     LEFT JOIN groups g ON g.groupId = m.peerId
     LEFT JOIN seen s ON s.msgId = m.msgId
     WHERE m.direction = 'in' AND (
       (g.groupId IS NULL AND COALESCE(m.arrivedAt, s.ts) > COALESCE(c.lastOpenedAt, 0))
       OR
       (g.groupId IS NOT NULL AND m.sharedBy IS NULL
        AND COALESCE(m.arrivedAt, 0) > COALESCE(c.lastOpenedAt, 0))
     )
     GROUP BY m.peerId`,
  );
  const counts: Record<string, number> = {};
  for (const row of res.rows as unknown as { peerId: string; n: number }[]) {
    counts[row.peerId] = Number(row.n);
  }
  return counts;
}

/**
 * The unread inbound bodies of every ROOM, keyed by room id — the chat
 * list's @-badge feed (the mentions contract). Rooms only, by the
 * `groups` join: a 1:1 has exactly one other person, so "mentioned" adds
 * nothing there and the badge never shows for one. This function stays
 * envelope-ignorant on purpose — WHAT in these bodies is a mention of ME is
 * the caller's judgement, made with parseEnvelope against its own account
 * id, never with a LIKE pattern here.
 *
 * Windowed on LOCAL ARRIVAL, exactly as `unreadCounts`' room branch is: a
 * room row's msgId is the composite `${author}.${m}`, while `seen`
 * records WIRE ids, so a seen-join can never match one. COALESCE falls back
 * to `m.ts` only for rows predating the arrivedAt column — an
 * offline-drained mention (sent at T, arriving at T+1h) sits OUTSIDE a
 * `m.ts` window and used to miss the badge entirely. The residual on those
 * legacy rows is a skewed ts keeping a body inside the window longer than
 * it deserves — which can only keep the badge lit, never invent a mention,
 * because the caller re-parses every body and checks `who` itself before
 * drawing anything. `sharedBy IS NULL` for the same reason it is in
 * `unreadCounts`: a relayed historical mention is one member's account of a
 * past message, and it must not summon anyone today.
 *
 * Tombstoned rows are out: a retracted mention should not keep summoning.
 */
export async function unreadRoomBodies(): Promise<Record<string, string[]>> {
  const res = await conn().execute(
    `SELECT m.peerId AS peerId, m.body AS body
     FROM messages m
     JOIN chats c ON c.peerId = m.peerId
     JOIN groups g ON g.groupId = m.peerId
     WHERE m.direction = 'in'
       AND m.deletedAt IS NULL
       AND m.sharedBy IS NULL
       AND COALESCE(m.arrivedAt, m.ts) > COALESCE(c.lastOpenedAt, 0)`,
  );
  const bodies: Record<string, string[]> = {};
  for (const row of res.rows as unknown as { peerId: string; body: string }[]) {
    (bodies[row.peerId] ??= []).push(row.body);
  }
  return bodies;
}

/** Apply a server delivery receipt to an OUTGOING row, monotonically:
 * a late 'sent' can never downgrade an already-'delivered' message, and a
 * receipt can never touch an inbound or tamper-'error' row.
 *
 * ROOMS: a receipt for a fan-out leg names the leg's
 * random wire msgId, which matches no `messages` row — the resolution is
 * wire msgId → `outbox.localMsgId` → the group row, HERE rather than in
 * messaging, so the receipt path above this stays one code path. The leg is
 * settled into the ledger (payload cleared, outcome in `attempts` — see
 * LEG_SENT/LEG_DELIVERED) and the group row's aggregate recomputed. */
export async function applyReceipt(
  msgId: string,
  state: 'sent' | 'delivered',
): Promise<void> {
  const rank = state === 'delivered' ? 3 : 2;
  // `read` outranks every receipt: now that a `sent` row can reach `read`
  // (markRead), a receipt the socket redelivers after the peer's read
  // must not pull the filled tick back to a hollow one.
  await conn().execute(
    `UPDATE messages SET status = ?
     WHERE msgId = ? AND direction = 'out'
       AND (CASE status WHEN 'read' THEN 4 WHEN 'delivered' THEN 3 WHEN 'sent' THEN 2 WHEN 'pending' THEN 1 ELSE 0 END) < ?`,
    [state, msgId, rank],
  );
  const leg = (
    await conn().execute(
      `SELECT localMsgId FROM outbox
       WHERE msgId = ? AND localMsgId IS NOT NULL AND ledger = 1`,
      [msgId],
    )
  ).rows[0] as { localMsgId: string } | undefined;
  if (!leg) return;
  // Settle the leg, monotonically: delivered is terminal; anything else
  // (live, sent, or a failed leg a late receipt just vindicated) becomes at
  // least 'sent'. The payload is cleared in the same statement — a settled
  // leg must never transmit again.
  await conn().execute(
    `UPDATE outbox SET payload = '',
       attempts = CASE
         WHEN attempts = ${LEG_DELIVERED} OR ? = 'delivered' THEN ${LEG_DELIVERED}
         ELSE ${LEG_SENT}
       END
     WHERE msgId = ? AND localMsgId IS NOT NULL AND ledger = 1`,
    [state, msgId],
  );
  await aggregateFanoutStatus(leg.localMsgId);
}

/** Mark an outgoing message failed (poison envelope that never receipts). */
export async function markOutgoingError(msgId: string): Promise<void> {
  await conn().execute(
    `UPDATE messages SET status = 'error' WHERE msgId = ? AND direction = 'out'`,
    [msgId],
  );
}

/**
 * Write a fan-out leg off (retry cap reached, or its member was blocked in
 * the same tick the leg was queued): the leg becomes a LEG_FAILED ledger row
 * — payload cleared, never transmitted again, still counted — and the group
 * row's aggregate is recomputed. The 1:1 equivalent is markOutgoingError +
 * deleteOutboxEnvelope; a leg instead KEEPS its row, because the row is the
 * only durable record of who exactly did not get the message (an
 * omission must never be silent). A leg already settled by a receipt is left
 * alone — failure never downgrades an outcome.
 */
export async function markLegFailed(msgId: string): Promise<void> {
  const leg = (
    await conn().execute(
      `SELECT localMsgId FROM outbox
       WHERE msgId = ? AND localMsgId IS NOT NULL AND ledger = 1`,
      [msgId],
    )
  ).rows[0] as { localMsgId: string } | undefined;
  if (!leg) return;
  await conn().execute(
    `UPDATE outbox SET payload = '', attempts = ${LEG_FAILED}
     WHERE msgId = ? AND localMsgId IS NOT NULL AND ledger = 1 AND attempts >= 0`,
    [msgId],
  );
  await aggregateFanoutStatus(leg.localMsgId);
}

/**
 * The per-leg ledger of one group message, read straight off the outbox rows
 * sharing its `localMsgId` (see the LEG_* comment for why those rows are the
 * source of truth). `queued` legs are still live in the flush;
 * `failedPeerIds` is the honest list behind "Not delivered to N of M" and the
 * per-member state on long-press.
 */
export interface FanoutDeliveryState {
  total: number;
  queued: number;
  sent: number;
  delivered: number;
  failed: number;
  failedPeerIds: string[];
}

export async function fanoutDeliveryState(
  localMsgId: string,
): Promise<FanoutDeliveryState> {
  const row = (
    await conn().execute(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(CASE WHEN attempts >= 0 THEN 1 ELSE 0 END), 0) AS queued,
              COALESCE(SUM(CASE WHEN attempts = ${LEG_SENT} THEN 1 ELSE 0 END), 0) AS sent,
              COALESCE(SUM(CASE WHEN attempts = ${LEG_DELIVERED} THEN 1 ELSE 0 END), 0) AS delivered,
              COALESCE(SUM(CASE WHEN attempts = ${LEG_FAILED} THEN 1 ELSE 0 END), 0) AS failed
       FROM outbox WHERE localMsgId = ? AND ledger = 1`,
      [localMsgId],
    )
  ).rows[0] as
    | { total: number; queued: number; sent: number; delivered: number; failed: number }
    | undefined;
  const failedPeers = (
    await conn().execute(
      `SELECT peerId FROM outbox
       WHERE localMsgId = ? AND ledger = 1 AND attempts = ${LEG_FAILED} ORDER BY peerId`,
      [localMsgId],
    )
  ).rows as { peerId: string }[];
  return {
    total: Number(row?.total ?? 0),
    queued: Number(row?.queued ?? 0),
    sent: Number(row?.sent ?? 0),
    delivered: Number(row?.delivered ?? 0),
    failed: Number(row?.failed ?? 0),
    failedPeerIds: failedPeers.map(r => r.peerId),
  };
}

/**
 * The thread's failed fan-outs in ONE read (a device-retest finding):
 * every out-row of this room thread whose leg ledger holds at least one
 * LEG_FAILED row, with the sentence's two numbers. The thread refresh loads
 * THIS — one query per refresh, exactly like the reaction and attachment
 * batches — instead of running `fanoutDeliveryState` per row per render.
 *
 * Rows only where something failed: an all-delivered fan-out contributes
 * nothing, so the map the screen keeps is as small as the bad news. A 1:1
 * thread can never answer here — `outbox.localMsgId` is written exclusively
 * by `enqueueOutgoingFanout`, and a 1:1 envelope's is NULL — and a duress
 * session reads the decoy workspace, whose decoy sends enqueue zero legs, so the surface built on this cannot tell duress from
 * all-delivered. `direction = 'out'` guards the join: wire ids are
 * sender-chosen, so an inbound row could otherwise collide with a local key.
 */
export interface FanoutFailureRow {
  localMsgId: string;
  failed: number;
  total: number;
}

export async function listFanoutFailures(
  threadPeerId: string,
): Promise<FanoutFailureRow[]> {
  const rows = (
    await conn().execute(
      `SELECT o.localMsgId AS localMsgId,
              COUNT(*) AS total,
              SUM(CASE WHEN o.attempts = ${LEG_FAILED} THEN 1 ELSE 0 END) AS failed
       FROM outbox o
       JOIN messages m ON m.msgId = o.localMsgId AND m.direction = 'out'
       WHERE m.peerId = ? AND o.localMsgId IS NOT NULL AND o.ledger = 1
       GROUP BY o.localMsgId
       HAVING SUM(CASE WHEN o.attempts = ${LEG_FAILED} THEN 1 ELSE 0 END) > 0`,
      [threadPeerId],
    )
  ).rows as { localMsgId: string; failed: number; total: number }[];
  return rows.map(r => ({
    localMsgId: String(r.localMsgId),
    failed: Number(r.failed),
    total: Number(r.total),
  }));
}

/**
 * Fold the settled ledger into the group row's single status, once no leg is
 * live: 'delivered' only when EVERY leg delivered, 'error'
 * only when EVERY leg failed (nothing left this phone — the one case where a
 * red bubble is the truth), otherwise 'sent' — with the failures carried by
 * the ledger's "Not delivered to N of M", never by a red bubble. While any
 * leg is live the row stays 'pending' ("Sending…"), which is what the design's
 * admission control shows for a fan-out queued behind the pacing budget.
 */
export async function aggregateFanoutStatus(localMsgId: string): Promise<void> {
  const state = await fanoutDeliveryState(localMsgId);
  if (state.total === 0 || state.queued > 0) return;
  // ROOM rows only (authorId set): a 1:1 DEVICE fan-out's bubble belongs to
  // the PRIMARY leg's receipts — its ledger rows are the peer's EXTRA
  // devices, and folding their outcomes into the row would mark a message
  // the anchor received 'error' (all extras failed) or 'delivered' (all
  // extras landed while the anchor's own leg did not). The ledger still
  // carries the honest per-device outcomes either way.
  const owner = (
    await conn().execute(
      `SELECT authorId FROM messages WHERE msgId = ? AND direction = 'out'`,
      [localMsgId],
    )
  ).rows[0] as { authorId?: string | null } | undefined;
  if (owner?.authorId == null) return;
  if (state.failed === state.total) {
    await markOutgoingError(localMsgId);
    return;
  }
  await conn().execute(
    `UPDATE messages SET status = ?
     WHERE msgId = ? AND direction = 'out'
       AND (CASE status WHEN 'delivered' THEN 3 WHEN 'sent' THEN 2 WHEN 'pending' THEN 1 ELSE 0 END) < ?`,
    [
      state.delivered === state.total ? 'delivered' : 'sent',
      localMsgId,
      state.delivered === state.total ? 3 : 2,
    ],
  );
}

// --- drafts (unsent words, this device only, never sent anywhere) ---

export interface ComposerDraft {
  text: string;
  /** Opaque, locally produced mention binding. The compose model validates
   * room, full text, ranges, ids and current names before it can be used. */
  mentionState: string | null;
}

/** The saved draft for a chat, or '' when there is none. */
export async function getDraft(peerId: string): Promise<string> {
  const res = await conn().execute(`SELECT text FROM drafts WHERE peerId = ?`, [
    peerId,
  ]);
  return (res.rows[0] as { text?: string } | undefined)?.text ?? '';
}

/** Read the words and their optional local mention binding atomically. */
export async function getComposerDraft(
  peerId: string,
): Promise<ComposerDraft> {
  const res = await conn().execute(
    `SELECT text, mentionState FROM drafts WHERE peerId = ?`,
    [peerId],
  );
  const row = res.rows[0] as
    | { text?: string; mentionState?: string | null }
    | undefined;
  return {
    text: row?.text ?? '',
    mentionState: row?.mentionState ?? null,
  };
}

/** Save a draft, or drop the row when there is nothing left to keep — an
 * empty draft must not linger as a stored fragment of what someone typed. */
export async function setDraft(
  peerId: string,
  text: string,
  mentionState: string | null = null,
): Promise<void> {
  const d = conn();
  if (text.trim() === '') {
    await d.execute(`DELETE FROM drafts WHERE peerId = ?`, [peerId]);
    return;
  }
  await d.execute(
    `INSERT OR REPLACE INTO drafts (peerId, text, mentionState, updatedAt) VALUES (?, ?, ?, ?)`,
    [peerId, text, mentionState, Date.now()],
  );
}

/**
 * Every unsent draft, keyed by conversation — the chat list's whole read.
 *
 * ONE WHOLE-TABLE STATEMENT, NEVER ONE PER ROW, in the `unreadCounts` shape
 * the caller already knows how to hold. A refresh runs four reads inside an
 * 80 ms coalescing window; this makes it five, not five per row.
 *
 * `text <> ''` is belt and braces: setDraft drops the row when nothing is
 * left rather than storing an empty fragment of what someone typed, so the
 * table should never hold one. A guard costs nothing and an empty prefix on a
 * list row would be a claim about a message that does not exist.
 *
 * Local by construction, like everything else on this file: a duress session
 * reads the decoy workspace's drafts and nothing else.
 */
export async function listDrafts(): Promise<Record<string, string>> {
  const res = await conn().execute(
    `SELECT peerId, text FROM drafts WHERE text <> ''`,
  );
  const drafts: Record<string, string> = {};
  for (const row of res.rows as unknown as { peerId: string; text: string }[]) {
    drafts[row.peerId] = row.text;
  }
  return drafts;
}

// --- blocking (this device, this workspace; never sent, never server-side) ---

/**
 * Record a block and make it true in the same breath.
 *
 * One transaction, in this order: write the row, purge anything still queued
 * to that person, then mark those queued messages 'error' ("Not sent"). The
 * purge is inside the same transaction as the row so there is no window in
 * which the block is recorded but a queued envelope is still flushable.
 *
 * THE PURGE IS 1:1-SCOPED (`localMsgId IS NULL`).
 * A room fan-out leg's `peerId` is the
 * MEMBER's id, not the room's, so the unscoped purge this function shipped
 * with hard-deleted a blocked member's queued legs: "Not delivered to N of M"
 * silently lost that member (the denominator shrank — the exact omission
 * the design forbids), and when it was the last live leg the bubble sat on
 * "Sending…" for ever because nothing recomputed the aggregate. Live legs
 * (`attempts >= 0`) now settle through `markLegFailed` — the SAME path the
 * retry cap and fanOutMembership's blocked-member legs use: payload cleared
 * so nothing flushes, row kept as the ledger entry, aggregate
 * recomputed so an all-settled fan-out reaches 'error', never a permanent
 * 'pending'. Legs a receipt already settled are left alone, as ever.
 * `markLegFailed` runs on this same connection, so every settle joins THIS
 * transaction: a block that half-applied would be worse than the defect.
 *
 * ON CONFLICT DO NOTHING, not REPLACE: re-blocking must not move the original
 * timestamp.
 *
 * ACCEPTED RESIDUAL: queued-but-unsent messages to that person are dropped and
 * marked 'Not sent'. The Double Ratchet tolerates the gap (a receiver decrypts
 * message N+1 with N missing), so nothing desyncs — but those words were never
 * delivered and never will be. Parking them instead would make unblocking fire
 * a burst of stale messages, which is itself a tell.
 *
 * DRAFTS ARE NOT TOUCHED: blocking must not destroy words someone typed, and
 * an unsent draft is never sent anywhere.
 */
export async function blockPeer(peerId: string, at: number): Promise<void> {
  const d = conn();
  // A room cannot be blocked: there is no single person
  // behind the row, so a blocked_peers entry would protect nothing — leaving
  // is the act that exists. Checked BEFORE the transaction, because the purge
  // and the status rewrite below must not run against a room either: erroring
  // a room's pending fan-out rows would be a delete wearing block's clothes.
  // The COALESCE mirrors chatsMissingMyProfile's filter; no chats row at all
  // means a person you have never spoken to, who is blockable as ever.
  const room = await d.execute(
    `SELECT 1 AS x FROM chats
     WHERE peerId = ? AND COALESCE(kind, 'peer') <> 'peer'`,
    [peerId],
  );
  if (room.rows.length > 0) return;
  await runExclusive(async () => {
    await d.execute('BEGIN IMMEDIATE');
    try {
      await d.execute(
        `INSERT INTO blocked_peers (peerId, blockedAt) VALUES (?, ?)
         ON CONFLICT(peerId) DO NOTHING`,
        [peerId, at],
      );
      // A blocked peer cannot receive an answer. Burn any request already on
      // this phone in the same transaction as the block so lifting the block
      // cannot revive stale executable/file payloads.
      await d.execute(`DELETE FROM approvals WHERE peerId = ?`, [peerId]);
      await d.execute(`DELETE FROM ai_work_events WHERE peerId = ?`, [peerId]);
      await d.execute(`DELETE FROM ai_agent_state WHERE peerId = ?`, [peerId]);
      await d.execute(`DELETE FROM ai_notify_preferences WHERE peerId = ?`, [peerId]);
      await d.execute(`DELETE FROM ai_task_templates WHERE peerId = ?`, [peerId]);
      // The member's LIVE room legs, read before the purge (see the block
      // comment above): these settle, they are never deleted.
      const legs = (
        await d.execute(
          `SELECT msgId FROM outbox
           WHERE peerId = ? AND localMsgId IS NOT NULL AND ledger = 1 AND attempts >= 0`,
          [peerId],
        )
      ).rows as { msgId: string }[];
      // Transport rows to the blocked id go the way 1:1 envelopes do — the
      // `ledger = 0` arm is a sibling transcript copy, which carries a purge
      // key but is not a delivery leg to be written into the ledger.
      await d.execute(
        `DELETE FROM outbox WHERE peerId = ? AND (localMsgId IS NULL OR ledger = 0)`,
        [peerId],
      );
      for (const leg of legs) {
        await markLegFailed(leg.msgId);
      }
      await d.execute(
        `UPDATE messages SET status = 'error'
         WHERE peerId = ? AND direction = 'out' AND status = 'pending'`,
        [peerId],
      );
      await d.execute('COMMIT');
    } catch (err) {
      await d.execute('ROLLBACK');
      throw err;
    }
  });
}

/** Lift a block. Messages that arrived while it stood are gone — they were
 * dropped on arrival, not queued here, and unblocking does not bring them
 * back (intended). */
export async function unblockPeer(peerId: string): Promise<void> {
  await conn().execute(`DELETE FROM blocked_peers WHERE peerId = ?`, [peerId]);
}

/**
 * When this device blocked them, or null. This is the UI's read.
 *
 * Named `getBlockedAt`, never `isPeerBlocked`: that name is taken by the
 * identity-change flag on messaging, and collapsing the two states into one
 * boolean is the wrong-state bug this feature dies on.
 */
export async function getBlockedAt(peerId: string): Promise<number | null> {
  const res = await conn().execute(
    `SELECT blockedAt FROM blocked_peers WHERE peerId = ?`,
    [peerId],
  );
  return (res.rows[0] as { blockedAt?: number } | undefined)?.blockedAt ?? null;
}

/** Every peer blocked on this device. Read once at start to seed the hot-path
 * set, and by the chat list to draw row state — the mirror of
 * listIdentityChanged(), and for the same reason: the list must not ask the
 * protocol layer about every row it draws. */
export async function listBlockedPeers(): Promise<string[]> {
  const res = await conn().execute(`SELECT peerId FROM blocked_peers`);
  return (res.rows as { peerId: string }[]).map(r => r.peerId);
}

/**
 * Whether the blocked-peers MIRROR — the App Group file the notification
 * extension and CallKit read — is known to be out of step with this table.
 * A blocked-mirror write can fail (the shared container is full
 * or faulted) after the DB block has already committed, and both native
 * readers fail OPEN on a missing/stale mirror — so the block is enforced
 * in-app while the lock screen still rings. This marker records that partial
 * state so it survives a relaunch and the UI can say so.
 *
 * Stored in the app-private `profile` kv table ON PURPOSE: the mirror lives in
 * the SHARED container, and the failure this records IS that container being
 * unwritable, so the marker must not share its fate. `profile` is a general
 * app-local key/value store (the retired phone number lived here too — see
 * saveProfile), and it is workspace-scoped, so a real session's stale mirror
 * is never confused with the decoy's.
 */
const BLOCKED_MIRROR_DIRTY_KEY = 'blockedMirrorDirty';

export async function setBlockedMirrorDirty(dirty: boolean): Promise<void> {
  const d = conn();
  if (dirty) {
    await d.execute(
      `INSERT OR REPLACE INTO profile (key, value) VALUES (?, ?)`,
      [BLOCKED_MIRROR_DIRTY_KEY, '1'],
    );
  } else {
    await d.execute(`DELETE FROM profile WHERE key = ?`, [
      BLOCKED_MIRROR_DIRTY_KEY,
    ]);
  }
}

export async function getBlockedMirrorDirty(): Promise<boolean> {
  const res = await conn().execute(`SELECT value FROM profile WHERE key = ?`, [
    BLOCKED_MIRROR_DIRTY_KEY,
  ]);
  return (res.rows[0] as { value?: string } | undefined)?.value === '1';
}

/**
 * Whether the naming moment has been answered — by a
 * name or by "Not now" — so the one-time nudge for a nameless account never
 * shows twice. The same `profile` kv discipline as the marker above:
 * workspace-scoped (a duress session's answer lands in the decoy file and
 * nowhere else — `conn()` already points there), and emptied with the rest
 * of the table at sign-out, so a fresh account is asked afresh. Write-once
 * by design: nothing un-settles it.
 */
const NAMING_SETTLED_KEY = 'namingSettled';

export async function setNamingSettled(): Promise<void> {
  await conn().execute(
    `INSERT OR REPLACE INTO profile (key, value) VALUES (?, ?)`,
    [NAMING_SETTLED_KEY, '1'],
  );
}

export async function getNamingSettled(): Promise<boolean> {
  const res = await conn().execute(`SELECT value FROM profile WHERE key = ?`, [
    NAMING_SETTLED_KEY,
  ]);
  return (res.rows[0] as { value?: string } | undefined)?.value === '1';
}

// --- outbox (pending outgoing envelopes, flushed in ULID order) ---

export interface OutboxRow {
  msgId: string;
  peerId: string;
  msgType: 'prekey' | 'ciphertext';
  payload: string;
  attempts: number;
  /** 0 = ordinary message, 1 = call signalling (flushed first). */
  priority: number;
  /** 1 when this frame may wake a sleeping peer (a ring). */
  urgent: number;
  /** 0 when this frame must NOT raise a notification — it is transport, not
   * conversation. See the `notify` column comment on the migration. */
  notify: number;
  /** The group row this fan-out leg belongs to (`messages.msgId`), or
   * null/undefined for a 1:1 envelope. The flush reads this to route a leg
   * through the pacing bucket and the leg ledger. It is also
   * the PURGE KEY of a sibling transcript copy — see `ledger` for which of
   * the two a row is. */
  localMsgId?: string | null;
  /**
   * 1 (the default, and every row predating the column) when the row is a
   * DELIVERY leg counted in the ledger; 0 for a sibling transcript copy
   * that carries `localMsgId` only so the sweep can reach it. */
  ledger?: number;
}

// --- call log --------------------------------------------

export type CallDirection = 'in' | 'out';
export type CallKind = 'audio' | 'video';

export interface CallLogRow {
  cid: string;
  peerId: string;
  direction: CallDirection;
  kind: CallKind;
  state: 'active' | 'ended';
  reason: string | null;
  startedAt: number;
  /** null when the call never connected — not the same as a 0-second call. */
  connectedAt: number | null;
  endedAt: number | null;
  lastSeenAt: number;
  missed: number;
}

export interface CallMetricDraft {
  reportId: string;
  localId: string;
  scope: 'direct' | 'group';
  media: 'audio' | 'video';
  startedAt: number;
  expiresAt: number;
}

export interface QueuedCallMetricReport {
  reportId: string;
  payload: string;
  attempts: number;
  nextAttemptAt: number;
  endedAt: number;
  expiresAt: number;
}

interface CallMetricRow extends CallMetricDraft {
  answeredAt: number | null;
  connectedAt: number | null;
  groupPeakParticipants: number | null;
  lastSeenAt: number;
}

type CallMetricOutcome = ReturnType<typeof CallMetricReport.parse>['outcome'];

/**
 * Keep every report operation behind the lifecycle transaction seam.
 *
 * `conn()` with no argument is the `'verdict'` gate, which is the correct door
 * for a metric write: reports must never travel through the pre-verdict CallKit
 * door, and after relock the closed latch makes these throw rather than write.
 * The handle is a `Handle`, not the driver's `DB` — every operation below needs
 * only `execute`, which is all `Handle` exposes.
 */
function runCallMetric<T>(operation: (d: Handle) => Promise<T>): Promise<T> {
  const d = conn();
  return runExclusive(() => operation(d));
}

/** Start an idempotent local lifecycle draft. `localId` never leaves SQLite. */
export async function openCallMetricReport(draft: CallMetricDraft): Promise<void> {
  await runCallMetric(d => d.execute(
    `INSERT INTO call_metric_reports
       (reportId, localId, scope, media, startedAt, lastSeenAt, expiresAt)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(scope, localId) DO NOTHING`,
    [
      draft.reportId,
      draft.localId,
      draft.scope,
      draft.media,
      draft.startedAt,
      draft.startedAt,
      draft.expiresAt,
    ],
  ));
}

/** First answer wins; later reducer replay cannot rewrite its timestamp. */
export async function markCallMetricAnswered(localId: string, at: number): Promise<void> {
  await runCallMetric(d => d.execute(
    `UPDATE call_metric_reports
     SET answeredAt = MAX(startedAt, ?), lastSeenAt = MAX(lastSeenAt, ?)
     WHERE localId = ? AND endedAt IS NULL AND answeredAt IS NULL`,
    [at, at, localId],
  ));
}

/** First connection wins. A connected group necessarily has at least two. */
export async function markCallMetricConnected(localId: string, at: number): Promise<void> {
  await runCallMetric(d => d.execute(
    `UPDATE call_metric_reports
     SET answeredAt = COALESCE(answeredAt, MAX(startedAt, ?)),
         connectedAt = MAX(COALESCE(answeredAt, startedAt), ?),
         lastSeenAt = MAX(lastSeenAt, ?),
         groupPeakParticipants = CASE
           WHEN scope = 'group' THEN MAX(COALESCE(groupPeakParticipants, 2), 2)
           ELSE groupPeakParticipants
         END
     WHERE localId = ? AND endedAt IS NULL AND connectedAt IS NULL`,
    [at, at, at, localId],
  ));
}

/** Peak participation only rises; it is meaningful only to group reports. */
export async function raiseCallMetricPeak(localId: string, peak: number): Promise<void> {
  await runCallMetric(d => d.execute(
    `UPDATE call_metric_reports
     SET groupPeakParticipants = MAX(COALESCE(groupPeakParticipants, 2), ?)
     WHERE localId = ? AND scope = 'group' AND endedAt IS NULL`,
    [peak, localId],
  ));
}

/** A heartbeat dates a hard crash without allowing time to move backwards. */
export async function touchCallMetricReport(localId: string, at: number): Promise<void> {
  await runCallMetric(d => d.execute(
    `UPDATE call_metric_reports SET lastSeenAt = MAX(lastSeenAt, ?)
     WHERE localId = ? AND endedAt IS NULL`,
    [at, localId],
  ));
}

function callMetricOutcome(
  reason: CallEndReason,
  answered: boolean,
  connected: boolean,
): CallMetricOutcome {
  if (reason === 'hangup') {
    if (connected) return 'completed';
    return answered ? 'connection_failed' : 'unanswered';
  }
  if (reason === 'decline') return 'declined';
  if (reason === 'busy') return 'busy';
  if (reason === 'timeout' || reason === 'cancelled' || reason === 'expired') return 'unanswered';
  if (reason === 'failed_ice') return 'connection_failed';
  if (reason === 'failed_media') return 'media_failed';
  if (reason === 'blocked') return 'blocked';
  return 'unsupported';
}

function callMetricPayload(
  row: CallMetricRow,
  endedAt: number,
  outcome: CallMetricOutcome,
): string {
  const answered = row.answeredAt !== null;
  const connected = row.connectedAt !== null;
  const report = CallMetricReport.parse({
    reportId: row.reportId,
    occurredAt: endedAt,
    scope: row.scope,
    media: row.media,
    answered,
    connected,
    outcome,
    ...(connected
      ? {
          setupMs: Math.min(120_000, Math.max(0, row.connectedAt! - row.startedAt)),
          durationSeconds: Math.min(86_400, Math.max(0, endedAt - row.connectedAt!) / 1000),
        }
      : {}),
    ...(row.scope === 'group' && connected
      ? { groupPeakParticipants: row.groupPeakParticipants ?? 2 }
      : {}),
  });
  return JSON.stringify(report);
}

async function finalizeCallMetricRow(
  d: Handle,
  row: CallMetricRow,
  endedAt: number,
  outcome: CallMetricOutcome,
): Promise<void> {
  const terminalAt = Math.max(endedAt, row.lastSeenAt);
  const payload = callMetricPayload(row, terminalAt, outcome);
  const groupPeakParticipants =
    row.scope === 'group' && row.connectedAt !== null
      ? (row.groupPeakParticipants ?? 2)
      : null;
  await d.execute(
    `UPDATE call_metric_reports
     SET endedAt = ?, outcome = ?, groupPeakParticipants = ?, payload = ?
     WHERE localId = ? AND endedAt IS NULL`,
    [terminalAt, outcome, groupPeakParticipants, payload, row.localId],
  );
}

/** Terminal finalization is read/validate/write in one serialized transaction. */
export async function finalizeCallMetricReport(input: {
  localId: string;
  endedAt: number;
  reason: CallEndReason;
}): Promise<void> {
  const d = conn();
  await runExclusive(async () => {
    await d.execute('BEGIN IMMEDIATE');
    try {
      const row = (
        await d.execute(
          `SELECT reportId, localId, scope, media, startedAt, answeredAt,
                  connectedAt, groupPeakParticipants, lastSeenAt, expiresAt
           FROM call_metric_reports WHERE localId = ? AND endedAt IS NULL`,
          [input.localId],
        )
      ).rows[0] as unknown as CallMetricRow | undefined;
      if (row) {
        await finalizeCallMetricRow(
          d,
          row,
          input.endedAt,
          callMetricOutcome(input.reason, row.answeredAt !== null, row.connectedAt !== null),
        );
      }
      await d.execute('COMMIT');
    } catch (error) {
      await d.execute('ROLLBACK');
      throw error;
    }
  });
}

/** Glare losers are abandoned drafts, never reports. */
export async function discardCallMetricReport(localId: string): Promise<void> {
  await runCallMetric(d => d.execute(
    `DELETE FROM call_metric_reports WHERE localId = ? AND endedAt IS NULL AND payload IS NULL`,
    [localId],
  ));
}

/** Recover drafts at their last local heartbeat, never at a later boot clock. */
export async function reconcileCallMetricReports(): Promise<void> {
  const d = conn();
  await runExclusive(async () => {
    await d.execute('BEGIN IMMEDIATE');
    try {
      const rows = (
        await d.execute(
          `SELECT reportId, localId, scope, media, startedAt, answeredAt,
                  connectedAt, groupPeakParticipants, lastSeenAt, expiresAt
           FROM call_metric_reports WHERE endedAt IS NULL`,
        )
      ).rows as unknown as CallMetricRow[];
      for (const row of rows) {
        const outcome: CallMetricOutcome =
          row.connectedAt !== null
            ? 'media_failed'
            : row.answeredAt !== null
              ? 'connection_failed'
              : 'unanswered';
        await finalizeCallMetricRow(d, row, row.lastSeenAt, outcome);
      }
      await d.execute('COMMIT');
    } catch (error) {
      await d.execute('ROLLBACK');
      throw error;
    }
  });
}

export async function listDueCallMetricReports(
  now: number,
  limit = 20,
): Promise<QueuedCallMetricReport[]> {
  const boundedLimit = Number.isInteger(limit) && limit > 0
    ? Math.min(limit, 20)
    : 20;
  return runCallMetric(async d => {
    const result = await d.execute(
      `SELECT reportId, payload, attempts, nextAttemptAt, endedAt, expiresAt
       FROM call_metric_reports
       WHERE payload IS NOT NULL AND nextAttemptAt <= ? AND expiresAt > ?
       ORDER BY endedAt ASC, reportId ASC LIMIT ?`,
      [now, now, boundedLimit],
    );
    return result.rows as unknown as QueuedCallMetricReport[];
  });
}

/** The next future outbox wake survives process and workspace restarts. */
export async function nextCallMetricAttemptAt(after: number): Promise<number | null> {
  return runCallMetric(async d => {
    const result = await d.execute(
      `SELECT nextAttemptAt FROM call_metric_reports
       WHERE payload IS NOT NULL AND nextAttemptAt > ?
       ORDER BY nextAttemptAt ASC LIMIT 1`,
      [after],
    );
    const row = result.rows[0] as unknown as { nextAttemptAt?: number } | undefined;
    return typeof row?.nextAttemptAt === 'number' ? row.nextAttemptAt : null;
  });
}

export async function recordCallMetricRetry(
  reportId: string,
  attempts: number,
  nextAttemptAt: number,
): Promise<void> {
  await runCallMetric(d => d.execute(
    `UPDATE call_metric_reports SET attempts = ?, nextAttemptAt = ?
     WHERE reportId = ? AND payload IS NOT NULL`,
    [attempts, nextAttemptAt, reportId],
  ));
}

export async function deleteCallMetricReport(reportId: string): Promise<void> {
  await runCallMetric(d => d.execute(
    `DELETE FROM call_metric_reports WHERE reportId = ?`,
    [reportId],
  ));
}

/** Seven-day retention applies only after a report has become queue data. */
export async function pruneExpiredCallMetricReports(now: number): Promise<void> {
  await runCallMetric(d => d.execute(
    `DELETE FROM call_metric_reports
     WHERE expiresAt <= ? AND payload IS NOT NULL`,
    [now],
  ));
}

/** Open a call row. Written when the call starts, not when it ends, so a
 * crash mid-call still leaves evidence the call happened. */
export async function startCallLog(call: {
  cid: string;
  peerId: string;
  direction: CallDirection;
  kind: CallKind;
  startedAt: number;
  /** Small-group calls: the session all of this call's sibling legs
   * share, and the room it belongs to. Both NULL for an ordinary 1:1. */
  sessionId?: string | null;
  roomId?: string | null;
}): Promise<void> {
  await conn().execute(
    `INSERT INTO call_log
       (cid, peerId, direction, kind, state, startedAt, lastSeenAt, missed,
        sessionId, roomId)
     VALUES (?, ?, ?, ?, 'active', ?, ?, 0, ?, ?)
     ON CONFLICT(cid) DO NOTHING`,
    [
      call.cid,
      call.peerId,
      call.direction,
      call.kind,
      call.startedAt,
      call.startedAt,
      call.sessionId ?? null,
      call.roomId ?? null,
    ],
  );
}

/** Heartbeat, so a call interrupted by a crash can be dated honestly. */
export async function touchCallLog(cid: string, at: number): Promise<void> {
  await conn().execute(
    `UPDATE call_log SET lastSeenAt = ? WHERE cid = ? AND state = 'active'`,
    [at, cid],
  );
}

/** Close a call row. Terminal and idempotent: the first reason wins, so a
 * late duplicate end cannot rewrite how a call is remembered. */
export async function endCallLog(
  cid: string,
  end: {
    reason: string;
    connectedAt: number | null;
    endedAt: number;
    missed: boolean;
  },
): Promise<void> {
  await conn().execute(
    `UPDATE call_log
     SET state = 'ended', reason = ?, connectedAt = ?, endedAt = ?,
         lastSeenAt = ?, missed = ?
     WHERE cid = ? AND state = 'active'`,
    [
      end.reason,
      end.connectedAt,
      end.endedAt,
      end.endedAt,
      end.missed ? 1 : 0,
      cid,
    ],
  );
}

/**
 * Boot recovery: a call still marked active is one the app died
 * during. Close it with the last heartbeat as its end — using `now` would
 * report a phone that was off overnight as a twelve-hour call.
 */
export async function reconcileActiveCalls(_now: number): Promise<void> {
  await conn().execute(
    `UPDATE call_log
     SET state = 'ended', reason = 'failed_media', endedAt = lastSeenAt
     WHERE state = 'active'`,
  );
}

/**
 * Every finished call across all conversations, newest first — the Calls
 * tab. Active rows are excluded: a call in progress is a live surface, not
 * history, and a crashed one is reconciled to 'ended' at boot before
 * anything reads this.
 */
export async function listAllCalls(limit = 200): Promise<CallLogRow[]> {
  const res = await conn().execute(
    `SELECT cid, peerId, direction, kind, state, reason, startedAt,
            connectedAt, endedAt, lastSeenAt, missed
     FROM call_log WHERE state = 'ended'
     ORDER BY startedAt DESC LIMIT ?`,
    [limit],
  );
  return res.rows as unknown as CallLogRow[];
}

export interface StoredOffer {
  cid: string;
  peerId: string;
  sdp: string;
  video: boolean;
  exp: number;
  serverTs: number;
  /** The small-group session this offer belongs to, or null for a 1:1. */
  sid?: string | null;
}

/**
 * Keep the decrypted offer for a ringing call.
 *
 * Written BEFORE CallKit is told to ring, so there is no window in which the
 * system shows a call the app could not answer after being killed.
 */
export async function saveCallOffer(offer: StoredOffer): Promise<void> {
  await conn().execute(
    `INSERT INTO call_offers (cid, peerId, sdp, video, exp, serverTs, sid)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(cid) DO NOTHING`,
    [
      offer.cid,
      offer.peerId,
      offer.sdp,
      offer.video ? 1 : 0,
      offer.exp,
      offer.serverTs,
      offer.sid ?? null,
    ],
  );
}

/**
 * Read and delete the stored offer for `cid`.
 *
 * Take rather than get: it is consumed by the one answer it can serve, and
 * leaving it behind would let a second answer for the same cid rebuild a call
 * that has already ended.
 */
/**
 * The 1:1 reader, and it deliberately does NOT select the new `sid` column.
 *
 * A session is restored WHOLE, by `takeCallOffersForSession` — restoring one
 * leg by cid is precisely the old cid-keyed bug — so nothing on this path has a use
 * for the column, and leaving its returned shape byte-identical is what keeps
 * `db.calllog.test.ts` passing unmodified (the additive-migration claim).
 *
 * ON THE PRE-VERDICT DOOR (`conn`'s gate), with `takeCallOffersForSession`,
 * `loadCallSession` and `loadSelfAccountIdForRing`: these four are the whole
 * of what servicing an in-flight lock-screen answer needs, and a cold launch
 * from that press has no verdict to have opened a workspace with.
 */
export async function takeCallOffer(cid: string): Promise<StoredOffer | null> {
  const res = await doorExecute(
    `SELECT cid, peerId, sdp, video, exp, serverTs FROM call_offers WHERE cid = ?`,
    [cid],
  );
  const row = res.rows?.[0] as
    | { cid: string; peerId: string; sdp: string; video: number; exp: number; serverTs: number }
    | undefined;
  if (!row) return null;
  // ASKED AGAIN, NOT CACHED — see the cost note on `conn`. A verdict can land
  // in this gap, and a handle held across it is both a write to the file the
  // verdict just left and, if anything else asked `conn()` meanwhile, a
  // statement on a closed connection.
  await doorExecute(`DELETE FROM call_offers WHERE cid = ?`, [cid]);
  return { ...row, video: row.video === 1 };
}

/**
 * WHO THIS DEVICE IS, and the only `profile` row the pre-verdict door exposes.
 *
 * Deliberately not `loadProfile()`, which stays behind the latch: that returns
 * the whole projection — display name, about text, avatar — and the small-group
 * restore needs exactly one field. The coordinator refuses to rebuild a
 * session without knowing which member of the persisted roster is this phone
 * (`restoreLocked` returns at `if (!selfId)`), so a cold lock-screen answer to
 * a group call cannot complete without this one string, and refusing it is a
 * denial of ring for every small-group call answered after a kill.
 *
 * Read through the same door as the offer rows and for the same reason; see
 * the gate comment on `conn`.
 */
export async function loadSelfAccountIdForRing(): Promise<string | null> {
  const res = await doorExecute(`SELECT value FROM profile WHERE key = 'userId'`);
  const row = res.rows?.[0] as { value: string } | undefined;
  return row?.value ?? null;
}

/**
 * Take EVERY stored offer belonging to one small-group session
 * repair, as a query.
 *
 * A killed-mid-ring device holds the starter's ginvite AND every held
 * join_leg offer that arrived beside it. Restoring by cid would rebuild
 * one leg and silently drop the rest, so the restore asks by SESSION and
 * takes them all in one go. Take rather than get, for the same reason
 * `takeCallOffer` is: an offer that has served its one answer must not be
 * able to rebuild a call that has already ended.
 */
export async function takeCallOffersForSession(sid: string): Promise<StoredOffer[]> {
  const res = await doorExecute(
    `SELECT cid, peerId, sdp, video, exp, serverTs, sid FROM call_offers
     WHERE sid = ? ORDER BY serverTs ASC, cid ASC`,
    [sid],
  );
  const rows = (res.rows ?? []) as unknown as {
    cid: string;
    peerId: string;
    sdp: string;
    video: number;
    exp: number;
    serverTs: number;
    sid: string | null;
  }[];
  if (rows.length === 0) return [];
  // The twin of the line in `takeCallOffer`, for the same two reasons.
  await doorExecute(`DELETE FROM call_offers WHERE sid = ?`, [sid]);
  return rows.map(row => ({ ...row, video: row.video === 1, sid: row.sid ?? null }));
}

/** Drop a stored offer whose call is over, answered or not. */
export async function deleteCallOffer(cid: string): Promise<void> {
  await conn().execute(`DELETE FROM call_offers WHERE cid = ?`, [cid]);
}

/**
 * Drop every stored offer belonging to a session that is over — the group
 * twin of `deleteCallOffer`, called at `closeSessionRow`.
 *
 * The 1:1 path has always dropped its offer the moment the machine went idle,
 * because the row holds a DTLS fingerprint and a set of candidate addresses
 * and is worth nothing once the call is over. A session's invites had no such
 * owner: `takeCallOffersForSession` consumes them on the RESTORE path, and an
 * ordinary answered-or-declined session left one row per invite for the boot
 * prune to find, which on a phone that is never force-quit can be weeks.
 */
export async function deleteCallOffersForSession(sid: string): Promise<void> {
  await conn().execute(`DELETE FROM call_offers WHERE sid = ?`, [sid]);
}

/**
 * Boot sweep: an offer past its `exp` can never be answered, and one left by
 * a crash would otherwise sit here holding an SDP forever. Bounded by the
 * offer's own expiry rather than a policy of ours, so it needs no tuning.
 */
export async function pruneCallOffers(now: number): Promise<void> {
  await conn().execute(`DELETE FROM call_offers WHERE exp <= ?`, [now]);
}

// --- small-group call sessions --------------------------

export interface StoredCallSession {
  sid: string;
  /** NULL for an ad-hoc picker call. */
  roomId: string | null;
  /** frame.from of the accepted ginvite — never a payload field. */
  starterId: string;
  /** ORDERED: the offer rule is roster-index based, so the order IS data. */
  roster: string[];
  se: number;
  video: boolean;
  startedAt: number;
}

/**
 * Write (or refresh) the live session row.
 *
 * Written BEFORE the CXCall is reported and refreshed whenever the roster or
 * the epoch moves, so a device killed at any point in a session's life comes
 * back holding the roster it actually had — the offer ordering is derived
 * from it, and a stale roster would re-form the mesh with the wrong side
 * offering on some legs.
 */
export async function saveCallSession(row: StoredCallSession): Promise<void> {
  await conn().execute(
    `INSERT INTO call_sessions (sid, roomId, starterId, roster, se, video, startedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(sid) DO UPDATE SET
       roomId = excluded.roomId,
       roster = excluded.roster,
       se = excluded.se,
       video = excluded.video`,
    [
      row.sid,
      row.roomId,
      row.starterId,
      JSON.stringify(row.roster),
      row.se,
      row.video ? 1 : 0,
      row.startedAt,
    ],
  );
}

/**
 * The session to restore on a cold launch, or null.
 *
 * Newest first and only one is ever returned: the busy rule allows one session per
 * device, so a second row can only be a crash residue, and restoring the
 * older of two would rebuild a call that is certainly over. The boot sweep
 * removes the rest.
 *
 * On the pre-verdict door (`conn`'s gate): this read is how a CallKit press
 * is told apart from a 1:1 one at all (`callKitNamesSession`), so on a cold
 * launch it happens before any verdict by construction.
 *
 * IT IS ALSO THE WIDEST THING THE DOOR ADMITS, AND THE COMMENT ON `conn` NOW
 * SAYS SO RATHER THAN IMPLYING OTHERWISE. `callKitNamesSession` asks this for
 * EVERY CallKit press — answers and declines, 1:1 cids and synthetic push
 * placeholders — and compares the sid afterwards, so a press about a different
 * call entirely still pulls the newest session's `roomId`, `starterId` and
 * full ROSTER into the process before any verdict exists. The narrowing is a
 * `WHERE sid = ?` variant selected by `callKitNamesSession`, which would make
 * a press that names no session of ours read nothing; it is NOT applied here
 * because `call.group.test.ts`'s classification-suspension harness gates on
 * this statement's literal text, and changing the text silently turns four
 * tests about a real CallKit race into tests that reach no branch at all.
 * That file belongs to another lane. See the residual note in the handover.
 */
export async function loadCallSession(): Promise<StoredCallSession | null> {
  const res = await doorExecute(
    `SELECT sid, roomId, starterId, roster, se, video, startedAt
     FROM call_sessions ORDER BY startedAt DESC LIMIT 1`,
  );
  const row = res.rows?.[0] as
    | {
        sid: string;
        roomId: string | null;
        starterId: string;
        roster: string;
        se: number;
        video: number;
        startedAt: number;
      }
    | undefined;
  if (!row) return null;
  // Parse-permissive, the roster doctrine (call.ts): a roster this build
  // cannot read collapses to empty rather than throwing the restore away —
  // an empty roster dials NOBODY, which is the safe direction to fail.
  let roster: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.roster);
    if (Array.isArray(parsed) && parsed.every(id => typeof id === 'string')) {
      roster = parsed as string[];
    }
  } catch {
    roster = [];
  }
  return {
    sid: row.sid,
    roomId: row.roomId ?? null,
    starterId: row.starterId,
    roster,
    se: row.se,
    video: row.video === 1,
    startedAt: row.startedAt,
  };
}

/** Release the session row. Called at `closeSessionRow`, i.e. immediately
 * after the one CXCall is released. */
export async function deleteCallSession(sid: string): Promise<void> {
  await conn().execute(`DELETE FROM call_sessions WHERE sid = ?`, [sid]);
}

/**
 * Boot sweep, `pruneCallOffers`'s sibling.
 *
 * A session row left by a crash names who was on a call with whom, and
 * nothing else would ever remove it. Bounded by the ring TTL rather than by
 * a policy of ours: past it the session can no longer be answered, so a row
 * that old is residue by definition.
 */
export async function pruneCallSessions(olderThan: number): Promise<void> {
  await conn().execute(`DELETE FROM call_sessions WHERE startedAt <= ?`, [olderThan]);
}

/** One peer's calls, newest first. */
export async function listCallLog(peerId: string): Promise<CallLogRow[]> {
  const res = await conn().execute(
    `SELECT cid, peerId, direction, kind, state, reason, startedAt,
            connectedAt, endedAt, lastSeenAt, missed
     FROM call_log WHERE peerId = ? ORDER BY startedAt DESC`,
    [peerId],
  );
  return res.rows as unknown as CallLogRow[];
}

/**
 * Has a call with this peer ever CONNECTED (the `hasCalledBefore` fact)?
 *
 * `connectedAt IS NOT NULL` is the whole of it, and the null branch is the
 * point. A row is opened for every call that is merely attempted — a missed
 * one, a declined one, a call that rang out — and those are rows a STRANGER
 * can cause: ring someone once from an unknown id and they have a call_log
 * row for you. If mere existence counted as "we have called before", that
 * unanswered ring would flip the next call to a direct connection and hand
 * over the address the first-call default exists to protect. A connected call
 * cannot be manufactured from the other side: it means this device answered,
 * or the peer answered a call this device placed, and media actually flowed —
 * which is precisely the disclosure the default is guarding against repeating.
 *
 * Direction is not filtered: a connected call in either direction exchanged
 * media with that peer, and the address is out either way. Small-group legs
 * count for the same reason — a leg is a peer connection with that person.
 */
export async function hasConnectedCallWith(peerId: string): Promise<boolean> {
  const res = await conn().execute(
    `SELECT 1 AS present FROM call_log
     WHERE peerId = ? AND connectedAt IS NOT NULL LIMIT 1`,
    [peerId],
  );
  return res.rows.length > 0;
}

/**
 * The remembered always-relay choice for one person.
 *
 * **null means no memory**, and it is not the same as `false`. `relayForPeer`
 * branches on exactly that: absent, the first-call default decides; present,
 * the person's choice wins over the default in both directions. Collapsing
 * the two would make "relay this person's calls" indistinguishable from
 * "never chose", which is the same defect in the opposite direction.
 */
export async function getPeerRelayPref(peerId: string): Promise<boolean | null> {
  const res = await conn().execute(
    `SELECT relay FROM call_relay_prefs WHERE peerId = ?`,
    [peerId],
  );
  const row = (res.rows as unknown as { relay: number }[])[0];
  return row === undefined ? null : row.relay === 1;
}

/** Record — or, with null, forget — the choice for one person. Forgetting
 * DELETES rather than writing a value, so the first-call default becomes
 * reachable again instead of being frozen to whatever was last chosen. */
export async function setPeerRelayPref(
  peerId: string,
  relay: boolean | null,
  now = Date.now(),
): Promise<void> {
  if (relay === null) {
    await conn().execute(`DELETE FROM call_relay_prefs WHERE peerId = ?`, [peerId]);
    return;
  }
  await conn().execute(
    `INSERT INTO call_relay_prefs (peerId, relay, updatedAt) VALUES (?, ?, ?)
     ON CONFLICT(peerId) DO UPDATE SET relay = excluded.relay,
                                       updatedAt = excluded.updatedAt`,
    [peerId, relay ? 1 : 0, now],
  );
}

/**
 * Pending envelopes in flush order: call signalling first, then local `seq`
 * order, then ULID order. A ringing
 * phone cannot wait behind a 10 MB photo upload, and the ratchet tolerates
 * the reordering because the recipient caches skipped message keys.
 *
 * `seq` is the local flush order that no longer travels on the wire: a
 * fan-out leg's wire msgId is pure randomness, so ULID order stops meaning
 * send order ACROSS fan-outs. COALESCE(seq, 0) is what keeps this
 * byte-identical for every row written before the column existed — they all
 * tie at 0 and fall through to the msgId order they have always had.
 */
export async function listOutbox(): Promise<OutboxRow[]> {
  const res = await conn().execute(
    `SELECT msgId, peerId, msgType, payload, attempts, priority, urgent, notify, localMsgId, ledger
     FROM outbox ORDER BY priority DESC, COALESCE(seq, 0) ASC, msgId ASC`,
  );
  // Settled fan-out legs (attempts < 0 — the LEG_* ledger) are bookkeeping,
  // not pending work: excluded HERE, in JS, so the flush never re-sends a
  // settled leg and pruneInflight treats it as gone. Filtered after the read
  // rather than in the WHERE clause deliberately — the ledger is small, and
  // the SELECT's shape (`FROM outbox ORDER BY …`) is pinned by tests as the
  // whole flush-order contract.
  return (res.rows as unknown as OutboxRow[]).filter(
    row => (row.attempts ?? 0) >= 0,
  );
}

export async function bumpOutboxAttempt(msgId: string): Promise<void> {
  // `attempts >= 0` for parity with the other two ledger mutators
  // (`markLegFailed`, `deleteOutboxEnvelope`). A settled leg carries a
  // NEGATIVE sentinel, and incrementing it walks the sentinel back toward
  // zero — -3 → -2 → -1 → 0 — at which point the row reads as live again.
  // Reachable only for a receipt landing mid-flush-pass on a leg still in the
  // snapshot, so the observable damage is one member's row reading "sent"
  // instead of "delivered"; the `listOutbox` filter stops it going further.
  // Bounded and cosmetic is still wrong: the invariant is that a settled row
  // is immutable, and an invariant with one unguarded mutator is not one.
  await conn().execute(
    `UPDATE outbox SET attempts = attempts + 1 WHERE msgId = ? AND attempts >= 0`,
    [msgId],
  );
}

export async function deleteOutboxEnvelope(msgId: string): Promise<void> {
  // `attempts >= 0` spares the leg ledger: a receipted fan-out leg was
  // already settled by applyReceipt (attempts < 0 — see LEG_SENT), and the
  // receipt path's follow-up delete must not erase the row that carries
  // "Not delivered to N of M"'s denominator. Every live row — 1:1 or leg —
  // still deletes exactly as before.
  await conn().execute(
    `DELETE FROM outbox WHERE msgId = ? AND attempts >= 0`,
    [msgId],
  );
}

// --- attachments (decrypted image blobs, one per image message) ---

export type AttachmentState = 'pending' | 'ready' | 'failed';

export interface AttachmentRow {
  msgId: string;
  /** Direction of the OWNING message row — (msgId, direction) is the message
   * identity; msgId alone is sender-spoofable across directions. */
  direction: 'in' | 'out';
  state: AttachmentState;
  dataB64: string | null;
  w: number | null;
  h: number | null;
}

export async function putAttachment(
  msgId: string,
  direction: 'in' | 'out',
  state: AttachmentState,
  dataB64: string | null = null,
  w: number | null = null,
  h: number | null = null,
): Promise<void> {
  await conn().execute(
    `INSERT INTO attachments (msgId, direction, state, dataB64, w, h) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(msgId, direction) DO UPDATE SET
       state = excluded.state,
       dataB64 = COALESCE(excluded.dataB64, attachments.dataB64),
       w = COALESCE(excluded.w, attachments.w),
       h = COALESCE(excluded.h, attachments.h)`,
    [msgId, direction, state, dataB64, w, h],
  );
}

export async function getAttachment(
  msgId: string,
  direction: 'in' | 'out',
): Promise<AttachmentRow | null> {
  const res = await conn().execute(
    `SELECT msgId, direction, state, dataB64, w, h FROM attachments
     WHERE msgId = ? AND direction = ?`,
    [msgId, direction],
  );
  return (res.rows[0] as unknown as AttachmentRow) ?? null;
}

/** All attachments belonging to one chat's messages. */
export async function listAttachments(
  peerId: string,
): Promise<AttachmentRow[]> {
  const res = await conn().execute(
    `SELECT a.msgId, a.direction, a.state, a.dataB64, a.w, a.h
     FROM attachments a
     JOIN messages m ON m.msgId = a.msgId AND m.direction = a.direction
     WHERE m.peerId = ?`,
    [peerId],
  );
  return res.rows as unknown as AttachmentRow[];
}

/**
 * The same rows as `listAttachments` WITHOUT the image bytes. The thread only
 * needs state and dimensions to lay a photo bubble out; reading every blob in
 * a conversation into JS strings on every refresh is tens of megabytes for a
 * chat with photos in it. The bytes are fetched per bubble via getAttachment.
 */
export async function listAttachmentMeta(
  peerId: string,
): Promise<(Omit<AttachmentRow, 'dataB64'> & { b64len: number | null })[]> {
  const res = await conn().execute(
    // b64len is computed, not stored: it lets a document row show the size
    // of the bytes THIS DEVICE HOLDS rather than the size its sender
    // claimed — without loading the bytes to find out.
    `SELECT a.msgId, a.direction, a.state, a.w, a.h,
            length(a.dataB64) AS b64len
     FROM attachments a
     JOIN messages m ON m.msgId = a.msgId AND m.direction = a.direction
     WHERE m.peerId = ?`,
    [peerId],
  );
  return res.rows as unknown as (Omit<AttachmentRow, 'dataB64'> & {
    b64len: number | null;
  })[];
}

/**
 * Every base64 character of attachment payload this workspace holds, both
 * directions — the STORAGE LEDGER behind messaging's auto-fetch ceiling
 * (AUTO_FETCH_STORAGE_CEILING there).
 *
 * Deliberately a SUM over the table rather than a maintained counter: this
 * file deletes attachment rows from five places (retraction, tombstones,
 * chat deletion among them), and a counter missing any one decrement would
 * eat the budget forever, while the table cannot disagree with the disk it
 * measures — content the person deletes frees exactly what it held, at the
 * next measurement. base64 is ASCII, so length() in characters IS bytes.
 * Read once per messaging session, not per fetch: at the ~4 GiB worst case
 * this scan is real IO, and once per unlock is what it is worth.
 */
export async function sumAttachmentBytes(): Promise<number> {
  const res = await conn().execute(
    `SELECT COALESCE(SUM(length(dataB64)), 0) AS total FROM attachments`,
  );
  return Number((res.rows[0] as { total?: number } | undefined)?.total ?? 0);
}

/**
 * Every base64 character of avatar payload this workspace holds — the chat
 * avatars' half of the persistent storage ledger, summed beside
 * `sumAttachmentBytes` and into the SAME ceiling.
 *
 * A SUM over the table for the same reason `sumAttachmentBytes` is one: the
 * disk is the ledger, so an avatar the person removes (a card without a face
 * NULLs the column) frees exactly what it held at the next measurement, and no
 * maintained counter can drift from it. base64 is ASCII, so length() in
 * characters IS bytes. Read once per messaging session, not per fetch.
 */
export async function sumAvatarBytes(): Promise<number> {
  const res = await conn().execute(
    `SELECT COALESCE(SUM(length(avatarB64)), 0) AS total FROM chats`,
  );
  return Number((res.rows[0] as { total?: number } | undefined)?.total ?? 0);
}

// --- reactions (tapback: one per reacting side per target message row) ---

export interface ReactionRow {
  targetMsgId: string;
  /** Direction of the TARGET message row (messages composite key). */
  targetDirection: 'in' | 'out';
  /** Who reacted: 'out' = me, 'in' = the peer. */
  direction: 'in' | 'out';
  /** WHICH member reacted, in a room: `frame.from`, authenticated. '' in a
   * 1:1, where `direction` already names the only two possible reactors —
   * and the '' keeps every 1:1 row in its old one-per-side shape. */
  reactorId: string;
  emoji: string;
  ts: number;
}

/** Set or replace a reaction; emoji '' retracts (tombstone survives
 * redelivery). One row per reactor: the conflict target
 * carries `reactorId`, so two members reacting to one room message are two
 * rows, both visible — under the old binary key the second silently
 * overwrote the first. */
export async function setReaction(
  targetMsgId: string,
  targetDirection: 'in' | 'out',
  direction: 'in' | 'out',
  emoji: string,
  ts: number,
  reactorId = '',
): Promise<void> {
  await conn().execute(
    `INSERT INTO reactions (targetMsgId, targetDirection, direction, reactorId, emoji, ts)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(targetMsgId, targetDirection, direction, reactorId) DO UPDATE SET
       emoji = excluded.emoji, ts = excluded.ts
     WHERE excluded.ts >= reactions.ts`,
    [targetMsgId, targetDirection, direction, reactorId, emoji, ts],
  );
}

/** All reactions attached to one chat's messages. */
export async function listReactions(peerId: string): Promise<ReactionRow[]> {
  const res = await conn().execute(
    `SELECT r.targetMsgId, r.targetDirection, r.direction, r.reactorId, r.emoji, r.ts
     FROM reactions r
     JOIN messages m ON m.msgId = r.targetMsgId AND m.direction = r.targetDirection
     WHERE m.peerId = ? AND r.emoji != ''`,
    [peerId],
  );
  return res.rows as unknown as ReactionRow[];
}

// --- Shared Room Vault ---

/**
 * ONE WRITER'S VIEW of one item — a row of `vault_items`. An item is not a
 * row; an item is the SET of its writers' slots, which in a 1:1 Room is at
 * most two. `collapseVaultSlots` turns that set into the thing a screen shows.
 */
export interface VaultSlotRow {
  peerId: string;
  /** ULID minted by whichever side created the item. */
  id: string;
  /** This slot's one and only writer. Never on the wire (see envelope.ts). */
  writerId: string;
  /** That writer's counter for that item — 1, 2, 3 … NOT a clock. Only its own
   * writer advances it, and it is allocated by one atomic statement
   * (`reserveVaultSeq`), so two writes can never share a number. That is what
   * makes the merge `max` over one integer with no tiebreak: within a slot a
   * tie is impossible rather than rare. */
  seq: number;
  /** The highest `seq` this writer had applied from the OTHER side for this
   * item when they wrote; 0 = none. Carries causality, which no clock can:
   * "their latest acknowledged my latest" is the difference between an update
   * and a blind clobber. Clamped to my own counter on arrival, so a peer
   * cannot claim to have seen a write that never existed. */
  ackSeq: number;
  title: string;
  /** The secret. Blank on a tombstone, and blanked when this slot is
   * definitively superseded by the other one — a superseded credential sitting
   * in plaintext is a deletion that deleted nothing. */
  body: string;
  /** THIS PHONE'S clock when it applied this slot. Display only. Never an
   * ordering key and never a guard: a peer's wall clock is not evidence, and
   * mixing the two clocks is what made the list order diverge under skew. */
  updatedAt: number;
  /** 1 = tombstone. The row survives so a replayed older `set` cannot
   * resurrect it, exactly like a retracted reaction's emoji '' row. */
  deleted: number;
}

/**
 * What a screen shows for one item: the winning slot, plus whether the two
 * slots actually disagreed. A pure function of the slot set, so two phones
 * holding the same slots render the same thing.
 */
export interface VaultItemRow extends VaultSlotRow {
  /** True when neither slot had seen the other and their contents differ —
   * two people edited the same credential without either seeing the other's
   * change. The value shown is still identical on both phones (the collapse is
   * deterministic), but it is genuinely a choice rather than a supersession,
   * and V3's vault surface is expected to say so. Recorded in the row rather
   * than discarded because a coin flip nobody is told about is exactly the
   * failure the amendment exists to prevent. */
  contested: boolean;
}

// Explicit, not SELECT *: a column added to the table is invisible to every
// reader until it is named here. The disappearing-message pair on `chats` was
// added and forgotten once — getChat returned undefined for both, so the send
// path read "no timer" and the UI showed Off while the rows on disk were
// correct. That cost is why this constant exists before there is a second
// reader to share it. Add here whenever you add a column.
const VAULT_COLUMNS = `peerId, id, writerId, seq, ackSeq, title, body,
     updatedAt, deleted`;

/**
 * Did `x` already know about everything `y` claims? A two-entry version vector
 * comparison, written componentwise on purpose.
 *
 * Orient the vectors against the pair of writers: for x's own slot the vector
 * is (x.seq, x.ackSeq); for y's it is (y.ackSeq, y.seq). `x` dominates `y`
 * exactly when x's vector is ≥ y's in BOTH components.
 *
 * In honest play the second conjunct follows from the first, so the intuition
 * is the single question "did their latest write acknowledge my latest write?"
 * — but both are evaluated, because they are free and because the pair of them
 * is what makes a lying `ackSeq` harmless once it has been clamped.
 *
 * The componentwise form is also deliberate rather than reduced: the reduction
 * holds only while a Room has exactly two writers, and this whole amendment
 * exists because a comparison rule was once reduced to something that held
 * usually.
 */
export function vaultSlotDominates(
  x: Pick<VaultSlotRow, 'seq' | 'ackSeq'>,
  y: Pick<VaultSlotRow, 'seq' | 'ackSeq'>,
): boolean {
  return x.ackSeq >= y.seq && x.seq >= y.ackSeq;
}

/**
 * `deleted` for a slot that has been ALLOCATED but never written — a
 * reservation. Neither 0 (a live value) nor 1 (a tombstone), because it is
 * neither: it is a number being held while the frame that will carry it is
 * composed. `collapseVaultSlots` drops it, so it shows nothing and, crucially,
 * cannot win a concurrency against the peer's real value. No write can produce
 * it: `commitVaultSlot` always writes 0 or 1, and an inbound merge derives
 * `deleted` from the envelope's `op`.
 */
const VAULT_SLOT_RESERVED = 2;

/** The content of a slot, as one comparable string. Used only to recognise two
 * slots that say the same thing, and to break a genuine concurrency by
 * CONTENT rather than by identity — the old tiebreak compared account ids, so
 * whichever id sorted higher won every tie forever and the same person lost
 * every time.
 *
 * THE SEPARATOR BELOW IS A LITERAL NUL (U+0000), not a space, and it has to be
 * something no title or body can contain: a printable separator would let
 * (title "a b", body "c") and (title "a", body "b c") produce the SAME key, and
 * this key is what two phones use to agree on a winner. It is invisible here,
 * and it is worth knowing that it makes `grep`/`file` treat this whole file as
 * binary — several greps over db.ts return nothing at all without `-a`, which
 * is a real hazard for anyone reviewing this code. Replacing it with a
 * length-prefixed encoding would be behaviour-equivalent (both phones compute
 * whichever form identically) and greppable; deliberately NOT done here,
 * because changing a live tiebreak to improve tooling is the wrong trade to
 * make in passing. Recorded so the next reader chooses rather than
 * discovers. */
function vaultContentKey(slot: VaultSlotRow): string {
  return `${slot.deleted ? 1 : 0}\u0000${slot.title}\u0000${slot.body}`;
}

/**
 * THE READ RULE. Turn one item's slots into the single row a screen shows.
 *
 * Pure, exported, and total: every branch returns the same answer for the same
 * slot set whatever order the slots are given in, which is the entire
 * convergence claim. Two phones that have applied the same set of frames hold
 * the same slots, so they show the same value — regardless of delivery order,
 * duplication, or what either wall clock said.
 *
 *   0 slots            -> nothing
 *   1 slot             -> that slot
 *   one dominates      -> the dominant one. This is the ordinary case: an edit
 *                         made after reading the other side's edit.
 *   equal content      -> either; they agree, so there is nothing to choose
 *   concurrent, a del  -> THE TOMBSTONE. The precedent `holdRevision` sets and
 *                         the vault design already carried: an item that comes
 *                         back after someone removed it is a credential they
 *                         believe is gone, and re-displaying a secret whose
 *                         owner just tried to destroy it is the worse of the
 *                         two information losses
 *   concurrent, differ -> the higher content key. Arbitrary, and that is the
 *                         point — but arbitrary by CONTENT, which both phones
 *                         compute identically and which does not systematically
 *                         favour one person. Flagged `contested`
 *
 * NOTE ON WHAT THIS DELIBERATELY DOES NOT DO. The natural next step is a
 * multi-value register: keep both values, label them by author, let the person
 * choose. The state here already supports it — both slots are retained and
 * `contested` is computed — but rendering it needs a vault UI that
 * is not built. Storing a second value that no screen can show would be
 * strictly worse than choosing: the value would exist in the database and be
 * unreachable by any human, which is the failure this amendment condemns in
 * the old design. So the collapse is deterministic today, the disagreement is
 * recorded rather than destroyed, and a later UI can surface it without a migration.
 */
export function collapseVaultSlots(
  slots: VaultSlotRow[],
): VaultItemRow | null {
  // A RESERVATION IS NOT STATE, and leaving it in here was a real item loss.
  // `reserveVaultSeq` creates a brand-new slot before the send, because the
  // frame has to carry the number. That slot used to be born a plain tombstone
  // (`deleted = 1`), and a tombstone WINS a concurrency — so from the moment I
  // began an edit until the moment it committed, my empty placeholder outranked
  // the peer's real value and their credential vanished from my vault. A crash
  // in that window (or any failure that stops `releaseVaultSeq` running) made it
  // permanent: their later writes stay concurrent with my orphan, so the
  // tombstone keeps winning and the item is never seen again.
  //
  // So the reservation is born VAULT_SLOT_RESERVED, which is not a value of
  // `deleted` any write produces (`commitVaultSlot` always writes 0 or 1, and
  // an inbound merge derives it from `op`), and it is dropped here. The row
  // still exists, still holds the counter, and is still returned by
  // `listVaultSlots` — a reservation must be invisible, not absent.
  const live = slots.filter(slot => slot.deleted !== VAULT_SLOT_RESERVED);
  if (live.length === 0) return null;
  // Sorted so the function cannot depend on the order rows came back in.
  const ordered = [...live].sort((a, b) => (a.writerId < b.writerId ? -1 : 1));
  if (ordered.length === 1) return { ...ordered[0], contested: false };
  // More than two writers is out of scope for a 1:1 Room, but
  // the fold is written so that it degrades correctly rather than throwing.
  return ordered.reduce<VaultItemRow>(
    (winner, slot) => {
      const next = { ...slot, contested: false };
      if (vaultSlotDominates(winner, next) && !vaultSlotDominates(next, winner)) {
        return { ...winner, contested: winner.contested };
      }
      if (vaultSlotDominates(next, winner) && !vaultSlotDominates(winner, next)) {
        return { ...next, contested: winner.contested };
      }
      const a = vaultContentKey(winner);
      const b = vaultContentKey(next);
      if (a === b) return winner;
      if (winner.deleted !== next.deleted) {
        const tombstone = winner.deleted ? winner : next;
        return { ...tombstone, contested: true };
      }
      return { ...(a > b ? winner : next), contested: true };
    },
    { ...ordered[0], contested: false },
  );
}

/**
 * Take the next number for MY slot of one item, in ONE statement.
 *
 * This single statement is the mutex the old code did not have, and its absence
 * was the sharpest of the three convergence defects. The version used to be
 * read (`getVaultItem`), computed (`nextVaultVersion`), and only written much
 * later from `onEnqueued` — with an `await` on a possible prekey fetch in
 * between and no lock. Two overlapping saves therefore read the same number,
 * stamped the same number, and put TWO DIFFERENT BODIES under one identical
 * ordering key. Each phone then resolved by its own arrival order, so the two
 * ended up on different values with nothing on screen to say so.
 *
 * `INSERT … ON CONFLICT DO UPDATE … RETURNING` reads and increments inside one
 * write, so two overlapping saves get 5 and 6 in a definite order, 6 wins on
 * BOTH phones by its own writer's counter, and the losing save merely burns a
 * number. Gaps are legal and unobservable.
 *
 * A brand-new slot is created RESERVED, which is neither a live blank item nor
 * a tombstone: a reservation is not yet a write, and until `commitVaultSlot`
 * lands there is nothing here to show. That is what keeps the invariant
 * the vault design wanted — a refused or unencryptable write leaves the vault
 * untouched — while still allocating the number before the frame that has to
 * carry it.
 *
 * It was a plain tombstone (`deleted = 1`) and that lost an item. A tombstone
 * WINS a concurrency, so an uncommitted placeholder outranked the peer's real
 * value: their credential disappeared from my vault for the whole reserve→send
 * window, and permanently if anything stopped `releaseVaultSeq` from running —
 * their later writes stay concurrent with the orphan, so it keeps winning. See
 * VAULT_SLOT_RESERVED and the filter at the top of `collapseVaultSlots`.
 *
 * An EXISTING slot keeps its own `deleted` and its own content: only `seq`
 * moves. What I already published stays on screen while the next edit is in
 * flight, which is what a person expects and what the invariant requires.
 *
 * `floor` IS THE REPAIR FOR A COUNTER THAT WENT BACKWARDS, and without it the
 * merge's one-way ratchet turns an ordinary user action into permanent silent
 * divergence. `deleteChat` purges this table for that peer (a credential must not outlive the conversation) and sends nothing, so MY
 * counter restarts at 1 while the peer's copy of my slot still sits at, say, 7.
 * The item comes back the moment they write again, I edit it, and every one of
 * my next seven frames is discarded by `excluded.seq > vault_items.seq` with no
 * error, no row and no retry anywhere in the codebase — I see the new door code
 * and believe it is shared; they keep the old one forever. The mirror case
 * (they delete the conversation, then write) loses THEIR writes on MY phone the
 * same way.
 *
 * The number that repairs it is already on the wire and needs no new state: a
 * frame's `k` is "the highest write of YOURS I have applied", which is exactly
 * the peer's copy of my counter, and it is stored as their slot's `ackSeq`. So
 * the caller passes that back here and my next number clears it. Symmetric by
 * construction, because after a purge the item can only reappear via THEIR
 * frame — so the repair value always arrives before it is needed.
 *
 * Raising it can never suppress anything: a bigger number only makes my own
 * write win harder, and gaps are legal and unobservable. That is why it is safe
 * to honour an unverifiable claim here (see `applyVaultEnvelope`'s clamp, which
 * is bounded precisely so a hostile claim cannot exhaust the counter space).
 */
export async function reserveVaultSeq(
  peerId: string,
  id: string,
  writerId: string,
  at: number,
  floor = 0,
): Promise<number> {
  const res = await conn().execute(
    `INSERT INTO vault_items
       (peerId, id, writerId, seq, ackSeq, title, body, updatedAt, deleted)
     VALUES (?, ?, ?, ? + 1, 0, '', '', ?, ${VAULT_SLOT_RESERVED})
     ON CONFLICT(peerId, id, writerId) DO UPDATE SET
       seq = MAX(vault_items.seq + 1, ? + 1)
     RETURNING seq`,
    [peerId, id, writerId, floor, at, floor],
  );
  const returned = (res.rows[0] as unknown as { seq: number } | undefined)?.seq;
  if (typeof returned === 'number') return returned;
  // REFUSE RATHER THAN GUESS. This used to re-read the row and return whatever
  // it found, which is not a mutex: two overlapping saves both read the
  // post-increment value and get the SAME number — two different bodies under
  // one identical ordering key, which is DIVERGENCE 3 verbatim, reintroduced by
  // the fallback meant to be harmless. Reusing a number is the one thing this
  // design cannot tolerate, so a driver that drops RETURNING rows must break
  // the write loudly (the caller reports it and `releaseVaultSeq` is not even
  // reached, because nothing was allocated that this phone can see).
  throw new Error('vault: the counter could not be allocated');
}

/**
 * Give a reserved number back, when the frame that was going to carry it never
 * left this phone.
 *
 * Guarded on the exact number, so it only ever undoes a reservation nothing has
 * built on: if a later save already took `seq + 1`, or a merge moved the slot
 * on, this is a no-op. Nothing was on the wire (the send threw before the
 * outbox commit), so no peer can hold the number being released.
 *
 * Without it a blocked peer, an unverified safety number or a refused envelope
 * would each leave the slot's counter one higher than the item it describes —
 * harmless for convergence, but it would break the plainer promise that a
 * refused write leaves the vault exactly as it was.
 */
export async function releaseVaultSeq(
  peerId: string,
  id: string,
  writerId: string,
  seq: number,
): Promise<void> {
  await conn().execute(
    `UPDATE vault_items SET seq = seq - 1
      WHERE peerId = ? AND id = ? AND writerId = ? AND seq = ?`,
    [peerId, id, writerId, seq],
  );
}

/**
 * Write the content of MY slot at the number I reserved.
 *
 * Guarded on `seq = ?` rather than on `>`: the commit belongs to one specific
 * reservation. If a later save has already taken a higher number, this one lost
 * and must not overwrite — otherwise the newer content would be sitting under
 * the older frame's number, and the peer (who merges by number) would end up on
 * a different value. Guarding here is what makes "the number determines the
 * content" true on both phones rather than only on this one.
 *
 * Idempotent: replaying the same commit writes the same bytes at the same
 * number.
 */
export async function commitVaultSlot(slot: VaultSlotRow): Promise<boolean> {
  const res = await conn().execute(
    `UPDATE vault_items
        SET ackSeq = ?, title = ?, body = ?, updatedAt = ?, deleted = ?
      WHERE peerId = ? AND id = ? AND writerId = ? AND seq = ?`,
    [
      slot.ackSeq,
      slot.title,
      slot.body,
      slot.updatedAt,
      slot.deleted,
      slot.peerId,
      slot.id,
      slot.writerId,
      slot.seq,
    ],
  );
  const applied = (res.rowsAffected ?? 0) > 0;
  if (applied) await blankSupersededSlots(slot.peerId, slot.id);
  return applied;
}

/**
 * Merge one slot that arrived from the peer. THE WHOLE STATE MERGE is the
 * `WHERE excluded.seq > vault_items.seq` on the last line.
 *
 * That is a join over a max-register: only one writer ever emits into a slot,
 * and that writer emits a strictly increasing sequence, so `max` is well
 * defined on the payload as well as on the key. Item state is the product of
 * two such lattices, so merging is commutative, associative and idempotent —
 * which is why this needs no tiebreak, no clock, and no clamp, and why
 * delivery order, duplication and interleaving cannot change where two phones
 * end up.
 *
 * Consequences worth naming, because each one was a defect before:
 *  - a REPLAY is arithmetically a no-op, not a guard someone must keep strict;
 *  - an OUT-OF-ORDER frame (7 then 5) needs no buffering: 5's content was
 *    already superseded by its own author's hand, so nothing is held or lost;
 *  - a LOST frame stalls nothing, because gaps are legal — that writer's next
 *    write repairs the item with no resync;
 *  - a frame composed on a phone whose clock is a decade out applies normally,
 *    because no clock is read anywhere in this function.
 *
 * Returns whether it applied, so the caller knows whether to announce it. A row
 * announcing a change that did not happen is worse than no row — it lets one
 * replayed envelope become an endless stream of notices.
 */
/** How many slots ONE writer may hold in one conversation — the bound on
 * what a peer can create here, refused inside the merge statement so a
 * burst cannot overshoot it. A writer's EXISTING slot merges past the cap
 * as ever: the number is on creation, never on convergence. */
export const VAULT_SLOTS_PER_WRITER_CAP = 500;

export async function mergeVaultSlot(slot: VaultSlotRow): Promise<boolean> {
  const res = await conn().execute(
    `INSERT INTO vault_items
       (peerId, id, writerId, seq, ackSeq, title, body, updatedAt, deleted)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
     WHERE ((SELECT COUNT(*) FROM vault_items WHERE peerId = ? AND writerId = ?) < ${VAULT_SLOTS_PER_WRITER_CAP}
        OR EXISTS (SELECT 1 FROM vault_items WHERE peerId = ? AND id = ? AND writerId = ?))
     ON CONFLICT(peerId, id, writerId) DO UPDATE SET
       seq = excluded.seq,
       ackSeq = excluded.ackSeq,
       title = excluded.title,
       body = excluded.body,
       updatedAt = excluded.updatedAt,
       deleted = excluded.deleted
     WHERE excluded.seq > vault_items.seq`,
    [
      slot.peerId,
      slot.id,
      slot.writerId,
      slot.seq,
      slot.ackSeq,
      slot.title,
      slot.body,
      slot.updatedAt,
      slot.deleted,
      slot.peerId,
      slot.writerId,
      slot.peerId,
      slot.id,
      slot.writerId,
    ],
  );
  const applied = (res.rowsAffected ?? 0) > 0;
  if (applied) await blankSupersededSlots(slot.peerId, slot.id);
  return applied;
}

/**
 * Blank the content of a slot the other slot has definitively superseded.
 *
 * The same reasoning `tombstoneVaultItem` carried, extended across writers: the
 * metadata is what the ordering needs, so the row stays; the strings are what
 * the ordering does NOT need, so a superseded door code must not go on sitting
 * in plaintext. It is what makes a deletion actually delete — my `del`
 * dominates their `set`, so their copy of the credential is cleared too, on my
 * phone and on theirs.
 *
 * Only on strict dominance. A CONCURRENT pair is not superseded: neither writer
 * saw the other, both values are real, and `collapseVaultSlots` records the
 * disagreement instead of destroying half of it.
 */
async function blankSupersededSlots(peerId: string, id: string): Promise<void> {
  const slots = await listVaultSlots(peerId, id);
  if (slots.length < 2) return;
  for (const loser of slots) {
    if (!loser.title && !loser.body) continue;
    const superseded = slots.some(
      other =>
        other.writerId !== loser.writerId &&
        vaultSlotDominates(other, loser) &&
        !vaultSlotDominates(loser, other),
    );
    if (!superseded) continue;
    await conn().execute(
      `UPDATE vault_items SET title = '', body = ''
        WHERE peerId = ? AND id = ? AND writerId = ? AND seq = ?`,
      [peerId, id, loser.writerId, loser.seq],
    );
  }
}

/**
 * Every writer's slot for one item, tombstones included. This is the durable
 * state; `getVaultItem` is a view of it.
 *
 * Tombstones are deliberately NOT filtered: a tombstone is a real state, a
 * writer needs the counter it has to beat, and an item whose row looked absent
 * would be re-created from scratch by the next edit.
 */
export async function listVaultSlots(
  peerId: string,
  id: string,
): Promise<VaultSlotRow[]> {
  const res = await conn().execute(
    `SELECT ${VAULT_COLUMNS} FROM vault_items WHERE peerId = ? AND id = ?`,
    [peerId, id],
  );
  return res.rows as unknown as VaultSlotRow[];
}

/**
 * The slots of one item that a person could actually be shown and could
 * actually choose between — for the contested row, which is the only surface
 * that renders more than the collapse's winner.
 *
 * WHY THIS EXISTS RATHER THAN THE SCREEN FILTERING. `listVaultSlots` returns
 * reservations, and a reservation is `VAULT_SLOT_RESERVED` — a module-private
 * sentinel, deliberately, because it is an implementation detail of how a
 * counter is held while a frame is composed. A screen that filtered it itself
 * would have to hardcode `2`, and the next person to change the sentinel would
 * change it in one of two places. So the knowledge stays here and the screen
 * asks a question in its own vocabulary.
 *
 * Three things are dropped, each for its own reason:
 *  - a RESERVATION is not a value; it is a number being held (see
 *    `collapseVaultSlots`, which drops it for the same reason);
 *  - a TOMBSTONE is not a value; there is nothing to keep;
 *  - a BLANKED slot is not a value either — `blankSupersededSlots` already
 *    wiped it because the other slot strictly dominates, so offering it would
 *    be offering an empty string as a credential.
 *
 * What is left is exactly the set of live, non-empty, per-writer values, which
 * on a contested item is the two the person has to choose between and in every
 * other case is one or none. Sorted by `writerId` so the order is the same on
 * both phones and the rows do not swap places between renders.
 */
export async function listVaultContenders(
  peerId: string,
  id: string,
): Promise<VaultSlotRow[]> {
  const slots = await listVaultSlots(peerId, id);
  return slots
    .filter(
      slot =>
        slot.deleted !== VAULT_SLOT_RESERVED &&
        slot.deleted !== 1 &&
        (slot.title !== '' || slot.body !== ''),
    )
    .sort((a, b) => (a.writerId < b.writerId ? -1 : a.writerId > b.writerId ? 1 : 0));
}

/**
 * One item as a screen sees it, tombstone included. Mirrors `getMessage`, which
 * also returns retracted rows, against `listVaultItems` below, which hides them
 * — the same split as `listReactions`.
 */
export async function getVaultItem(
  peerId: string,
  id: string,
): Promise<VaultItemRow | null> {
  return collapseVaultSlots(await listVaultSlots(peerId, id));
}

/**
 * Everything a Room's vault actually holds — newest ITEM first, tombstones
 * hidden.
 *
 * ORDERED BY `id`, NOT BY TIME, and that is a correctness decision rather than
 * a taste one. `id` is a ULID minted once by whichever side created the item
 * and never rewritten, so it is time-ordered AND both phones compute the same
 * order from the same bytes. The old ordering key was `updatedAt`, which was
 * `frame.ts` on the inbound path (the SENDER's clock) and `Date.now()` on the
 * outbound one — so under clock skew the two phones listed the same items in
 * different orders even when they agreed on every value.
 *
 * The tempting fix is "order by recency, but with a clock we trust". There
 * isn't one: causal history is a partial order, so no clock-free global
 * recency exists, and reaching for a wall clock again to get one would
 * reintroduce the whole class of failure this amendment removed. Recency stays
 * as a per-row label from `updatedAt` ("last changed on this device"), which is
 * locally true, and the ORDER is the thing that converges. A vault is a
 * reference list, not a feed; rows that jump because the other person edited
 * something are worse than rows that stay where they were.
 *
 * The collapse happens here rather than in SQL because an item is a set of
 * slots: `WHERE deleted = 0` on the raw rows would show an item whose other
 * slot is a tombstone that dominates it.
 */
export async function listVaultItems(peerId: string): Promise<VaultItemRow[]> {
  const res = await conn().execute(
    `SELECT ${VAULT_COLUMNS} FROM vault_items WHERE peerId = ?`,
    [peerId],
  );
  const byItem = new Map<string, VaultSlotRow[]>();
  for (const slot of res.rows as unknown as VaultSlotRow[]) {
    const bucket = byItem.get(slot.id);
    if (bucket) bucket.push(slot);
    else byItem.set(slot.id, [slot]);
  }
  const items: VaultItemRow[] = [];
  for (const slots of byItem.values()) {
    const item = collapseVaultSlots(slots);
    if (item && !item.deleted) items.push(item);
  }
  return items.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

// --- approvals ---

/**
 * How long a SETTLED approval keeps its payload, and how long the record
 * itself lives. Both mirror the CLI journal's posture (msglog.ts:
 * REDACT_AFTER_MS / RETAIN_MS) — if those move, these move in the same
 * commit: a phone must not remember a machine's command lines longer than
 * the machine's own journal does.
 */
export const APPROVAL_REDACT_AFTER_MS = 24 * 60 * 60 * 1000;
export const APPROVAL_RETAIN_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * How many LIVE pending asks one machine may hold open in one conversation:
 * a request past its own local deadline no longer counts, whether or not a
 * read has marked it lapsed yet, so a machine whose asks all timed out is
 * not locked out until the thread is opened. Refused inside the insert
 * (false back, frame acked) — a hundred unanswered questions is not a
 * workflow, it is a flood. */
export const PENDING_APPROVALS_PER_PEER_CAP = 100;

/** The request families the schema names. A row can only hold what the
 * shared schema's `.catch('other')` admitted, but the read coerces anyway so
 * rendering stays total over whatever is on disk. */
export type ApprovalKind = 'exec' | 'file' | 'other';

/** Mirrors the spine's states. There is no 'expired': TTL expiry on the
 * machine is `deny, via:'ttl'`, and this phone's own local grey-out is
 * recorded as `lapsed` — the two never contradict because the card's copy
 * claims only what this phone did (nothing). */
export type ApprovalState = 'pending' | 'answered' | 'lapsed';

export interface ApprovalRow {
  peerId: string;
  /** The request id — THE binding, single-use. Scoped by peerId in the key
   * because it is chosen by the asking machine. */
  q: string;
  /** The wire msgId the request arrived under — the `ref` the answer reply
   * names (the tested reply channel). */
  wireMsgId: string;
  kind: ApprovalKind;
  /** The exact bytes the machine will run — rendered verbatim or not at
   * all; '' once redacted (payloadBytes keeps the honest count). */
  payload: string;
  payloadBytes: number;
  /** TTL in seconds, clamped by the sender. arrivedAt + ttlSec*1000 is the
   * LOCAL deadline the countdown and grey-out derive from — display only;
   * expiry is decided on the CLI's clock. */
  ttlSec: number;
  sessionTag: string | null;
  /** The admissible verbs as the wire carried them. The card renders ONLY
   * these, and only the ones this build recognises. */
  verbs: string[];
  /** The frame's timestamp — the row's place in the thread's timeline. */
  ts: number;
  /** THIS phone's clock at persist — the countdown base. */
  arrivedAt: number;
  state: ApprovalState;
  answerVerb: string | null;
  settledAt: number | null;
  /** Supplementary sender facts for this exact request. They never replace
   * q/p as the authorization and disappear with the sensitive payload. */
  work?: AiWorkMetadata | null;
  workReceivedAt?: number | null;
  /** What the authenticated host later said it observed. This is deliberately
   * separate from the phone's queued answer and never means the operation ran. */
  hostObservation?: AiWorkMetadata['approvalObservation'] | null;
  hostObservationProvider?: AiWorkMetadata['provider'] | null;
  hostObservationSourceAt?: number | null;
  hostObservationReceivedAt?: number | null;
}

/**
 * The payload-free shape used by the workspace attention inbox.  Keeping the
 * exact request body out of this query is deliberate: the inbox may be
 * visible beside another pane, while ApprovalCard remains the one place that
 * renders the bytes a decision authorises.
 */
export interface PendingApprovalSummaryRow {
  peerId: string;
  q: string;
  kind: ApprovalKind;
  sessionTag: string | null;
  ts: number;
  arrivedAt: number;
  deadline: number;
  displayName: string | null;
  localName: string | null;
  /** Server-confirmed historical machine classification, never peer copy. */
  machine: boolean;
}

/** UTF-8 byte length without Buffer (Hermes has no node builtins). Counts
 * what an encoder would emit; a lone surrogate counts as the 3-byte
 * replacement character an encoder would write for it. */
function utf8ByteLength(s: string): number {
  let bytes = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/**
 * Persist one inbound approval request. Called BEFORE markSeen/ack — the ack
 * purges the server's only copy and the ratchet key is already spent, so a
 * crash between persist and ack must find the row on disk (the same ordering
 * every other durable branch uses).
 *
 * DO NOTHING under (peerId, q) is the single-use rule at rest: a replayed
 * frame, or a hostile re-bind of a known `q` to a second payload, changes
 * nothing — what this phone shows for `q` is what it stored first, exactly
 * as the CLI's append-once journal holds what it will execute.
 *
 * Returns whether a row was stored. False for the replay above AND for the
 * PENDING_APPROVALS_PER_PEER_CAP refusal; the caller acks either way, as it
 * always did. */
export async function insertApproval(approval: {
  peerId: string;
  q: string;
  wireMsgId: string;
  kind: ApprovalKind;
  payload: string;
  ttlSec: number;
  sessionTag: string | null;
  verbs: string[];
  ts: number;
  arrivedAt: number;
  work?: AiWorkMetadata;
}): Promise<boolean> {
  const res = await conn().execute(
    `INSERT INTO approvals
       (peerId, q, wireMsgId, kind, payload, payloadBytes, ttlSec,
        sessionTag, verbs, ts, arrivedAt, state)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending'
     WHERE (SELECT COUNT(*) FROM approvals
            WHERE peerId = ? AND state = 'pending' AND arrivedAt + ttlSec * 1000 > ?)
           < ${PENDING_APPROVALS_PER_PEER_CAP}
       AND NOT EXISTS (
         SELECT 1 FROM revoked_machine_peers WHERE peerId = ?
       )
     ON CONFLICT(peerId, q) DO NOTHING`,
    [
      approval.peerId,
      approval.q,
      approval.wireMsgId,
      approval.kind,
      approval.payload,
      utf8ByteLength(approval.payload),
      approval.ttlSec,
      approval.sessionTag,
      JSON.stringify(approval.verbs),
      approval.ts,
      approval.arrivedAt,
      approval.peerId,
      approval.arrivedAt,
      approval.peerId,
    ],
  );
  const stored = (res.rowsAffected ?? 0) > 0;
  if (!stored || approval.work === undefined) return stored;

  // Supplementary context is accepted only when it names this exact request.
  // A missing or different requestId costs only the context; the original
  // q/p row above remains intact and actionable.
  const parsed = AiWorkMetadataSchema.safeParse(approval.work);
  if (!parsed.success || parsed.data.requestId !== approval.q) return stored;
  await conn().execute(
    `UPDATE approvals SET workJson = ?, workReceivedAt = ?
     WHERE peerId = ? AND q = ?`,
    [JSON.stringify(parsed.data), approval.arrivedAt, approval.peerId, approval.q],
  );
  return stored;
}

/**
 * Every approval in one conversation, oldest first, after read-time
 * maintenance — the same shape as the CLI journal's read (readJournal
 * filters and redacts as it loads):
 *
 *  1. a pending row past its LOCAL deadline becomes `lapsed`, settled at
 *     that deadline (not at `now` — a phone off for a week must not report
 *     a week-late lapse time);
 *  2. a settled row older than APPROVAL_REDACT_AFTER_MS loses its payload
 *     (payloadBytes keeps the honest count for the receipt);
 *  3. a record older than APPROVAL_RETAIN_MS is gone entirely.
 *
 * `now` is a parameter, not a Date.now() call, so every caller — the screen
 * and the tests — moves the same clock.
 */
async function maintainApprovals(
  d: Handle,
  now: number,
  peerId?: string,
): Promise<void> {
  if (peerId !== undefined) {
    // Keep these statements byte-stable for the focused approval-store test
    // interpreter; the global arm below owns the same three policies.
    await d.execute(
      `UPDATE approvals
       SET state = 'lapsed', settledAt = arrivedAt + ttlSec * 1000
       WHERE peerId = ? AND state = 'pending'
         AND arrivedAt + ttlSec * 1000 <= ?`,
      [peerId, now],
    );
    await d.execute(
      `UPDATE approvals SET payload = '', workJson = NULL
       WHERE peerId = ? AND state != 'pending' AND settledAt IS NOT NULL
         AND ? - settledAt >= ${APPROVAL_REDACT_AFTER_MS} AND payload != ''`,
      [peerId, now],
    );
    await d.execute(
      `DELETE FROM approvals
       WHERE peerId = ? AND ? - COALESCE(settledAt, arrivedAt) >= ${APPROVAL_RETAIN_MS}`,
      [peerId, now],
    );
    return;
  }

  await d.execute(
    `UPDATE approvals
     SET state = 'lapsed', settledAt = arrivedAt + ttlSec * 1000
     WHERE state = 'pending' AND arrivedAt + ttlSec * 1000 <= ?`,
    [now],
  );
  await d.execute(
    `UPDATE approvals SET payload = '', workJson = NULL
     WHERE state != 'pending' AND settledAt IS NOT NULL
       AND ? - settledAt >= ${APPROVAL_REDACT_AFTER_MS} AND payload != ''`,
    [now],
  );
  await d.execute(
    `DELETE FROM approvals
     WHERE ? - COALESCE(settledAt, arrivedAt) >= ${APPROVAL_RETAIN_MS}`,
    [now],
  );
}

export async function listApprovals(
  peerId: string,
  now: number,
): Promise<ApprovalRow[]> {
  const d = conn();
  await maintainApprovals(d, now, peerId);
  const res = await d.execute(
    `SELECT peerId, q, wireMsgId, kind, payload, payloadBytes, ttlSec,
            sessionTag, verbs, ts, arrivedAt, state, answerVerb, settledAt,
            workJson, workReceivedAt, hostObservation,
            hostObservationProvider, hostObservationSourceAt,
            hostObservationReceivedAt
     FROM approvals WHERE peerId = ? ORDER BY ts ASC, q ASC`,
    [peerId],
  );
  return (res.rows as unknown as (Omit<ApprovalRow, 'verbs' | 'kind' | 'work'> & {
    verbs: string;
    kind: string;
    workJson: string | null;
  })[]).map(row => {
    let verbs: string[] = [];
    try {
      const parsed = JSON.parse(row.verbs) as unknown;
      if (Array.isArray(parsed)) {
        verbs = parsed.filter((v): v is string => typeof v === 'string');
      }
    } catch {
      // A row this build cannot read renders no buttons — never a crash.
    }
    let work: AiWorkMetadata | null = null;
    if (row.workJson) {
      try {
        const parsed = AiWorkMetadataSchema.safeParse(JSON.parse(row.workJson));
        if (parsed.success) work = parsed.data;
      } catch {
        // Supplementary metadata is fail-soft; q/p remain renderable.
      }
    }
    const { workJson, ...stored } = row;
    void workJson;
    return {
      ...stored,
      kind:
        row.kind === 'exec' || row.kind === 'file' ? row.kind : ('other' as const),
      verbs,
      work,
    };
  });
}

/**
 * Every live approval this workspace can safely surface, nearest deadline
 * first.  Maintenance is global so a request does not keep command/file bytes
 * merely because its thread was never opened.  The final read is one query:
 * no per-chat cap and no N+1 that could silently lose a valid request.
 *
 * A chat preview is intentionally not required.  Messaging durably creates
 * the chat before the approval row, and an approval can be the first thing a
 * machine sends.  The inner chat join also keeps a deleted conversation's
 * legacy orphan rows invisible; deleteChat now removes those rows at source.
 */
export async function listPendingApprovalSummaries(
  now: number,
): Promise<PendingApprovalSummaryRow[]> {
  const d = conn();
  await maintainApprovals(d, now);

  const res = await d.execute(
    `SELECT a.peerId, a.q, a.kind, a.sessionTag, a.ts, a.arrivedAt,
            a.arrivedAt + a.ttlSec * 1000 AS deadline,
            c.displayName, c.localName,
            CASE WHEN mp.peerId IS NULL THEN 0 ELSE 1 END AS machine
     FROM approvals a
     INNER JOIN chats c ON c.peerId = a.peerId
     LEFT JOIN machine_peers mp ON mp.peerId = a.peerId
     WHERE a.state = 'pending'
       AND a.hostObservation IS NULL
       AND a.arrivedAt + a.ttlSec * 1000 > ?
       AND c.identityChangedAt IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM blocked_peers b WHERE b.peerId = a.peerId
       )
       AND NOT EXISTS (
         SELECT 1 FROM revoked_machine_peers r WHERE r.peerId = a.peerId
       )
     ORDER BY deadline ASC, a.arrivedAt DESC, a.peerId ASC, a.q ASC`,
    [now],
  );

  return (res.rows as unknown as (Omit<PendingApprovalSummaryRow, 'kind' | 'machine'> & {
    kind: string;
    machine: number;
  })[]).map(row => ({
    ...row,
    kind:
      row.kind === 'exec' || row.kind === 'file'
        ? row.kind
        : ('other' as const),
    machine: row.machine === 1,
  }));
}

/**
 * Record this phone's answer — called AFTER the outbox row exists (the card
 * flips to answered only once the reply is really queued). Conditional on
 * `pending` AND on the local deadline, so it is the second half of two
 * defences: a double-tap's second settle changes nothing, and an answer
 * that raced past the deadline is refused at the store even if the screen's
 * own clock check missed it. The CLI spine defends too (a burned id never
 * re-binds); the card must not rely on that.
 */
export async function settleApproval(
  peerId: string,
  q: string,
  verb: string,
  at: number,
): Promise<boolean> {
  const res = await conn().execute(
    `UPDATE approvals SET state = 'answered', answerVerb = ?, settledAt = ?
     WHERE peerId = ? AND q = ? AND state = 'pending'
       AND arrivedAt + ttlSec * 1000 > ?`,
    [verb, at, peerId, q, at],
  );
  return (res.rowsAffected ?? 0) > 0;
}

/**
 * Record a local lapse (a tap that found the deadline already passed).
 * Settled at the DEADLINE, not at `at` — the lapse happened when the timer
 * ran out, not when someone noticed.
 */
export async function lapseApproval(
  peerId: string,
  q: string,
): Promise<boolean> {
  const res = await conn().execute(
    `UPDATE approvals
     SET state = 'lapsed', settledAt = arrivedAt + ttlSec * 1000
     WHERE peerId = ? AND q = ? AND state = 'pending'`,
    [peerId, q],
  );
  return (res.rowsAffected ?? 0) > 0;
}

// --- saved AI requests ---

export interface AiTaskTemplateRow {
  id: number;
  peerId: string;
  name: string;
  prompt: string;
  createdAt: number;
  updatedAt: number;
}

function aiTaskTemplateTime(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/** Create one local shortcut only while its peer is a live, unblocked chat.
 * The count and insert share one immediate transaction, so concurrent taps
 * cannot cross the per-agent limit. */
export async function createAiTaskTemplate(
  peerId: string,
  name: string,
  prompt: string,
  at: number,
): Promise<AiTaskTemplateRow | null> {
  const input = normalizeAiTaskTemplate(name, prompt);
  if (!input || !aiTaskTemplateTime(at)) return null;
  const d = conn();
  return runExclusive(async () => {
    await d.execute('BEGIN IMMEDIATE');
    try {
      const inserted = await d.execute(
        `INSERT INTO ai_task_templates
           (peerId, name, prompt, createdAt, updatedAt)
         SELECT ?, ?, ?, ?, ?
         WHERE EXISTS (
           SELECT 1 FROM chats c
           WHERE c.peerId = ? AND c.identityChangedAt IS NULL
         )
           AND NOT EXISTS (
             SELECT 1 FROM blocked_peers b WHERE b.peerId = ?
           )
           AND NOT EXISTS (
             SELECT 1 FROM revoked_machine_peers r WHERE r.peerId = ?
           )
           AND (SELECT COUNT(*) FROM ai_task_templates WHERE peerId = ?)
             < ${AI_SAVED_TASK_MAX}`,
        [
          peerId,
          input.name,
          input.prompt,
          at,
          at,
          peerId,
          peerId,
          peerId,
          peerId,
        ],
      );
      if ((inserted.rowsAffected ?? 0) !== 1) {
        await d.execute('COMMIT');
        return null;
      }
      const id = inserted.insertId;
      if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1) {
        throw new Error('saved request id unavailable');
      }
      await d.execute('COMMIT');
      return {
        id,
        peerId,
        name: input.name,
        prompt: input.prompt,
        createdAt: at,
        updatedAt: at,
      };
    } catch (err) {
      await d.execute('ROLLBACK');
      throw err;
    }
  });
}

/** Newest edited shortcuts first. Lifecycle joins make an old screen refresh
 * empty as soon as the peer is deleted, blocked or revoked. */
export async function listAiTaskTemplates(
  peerId: string,
): Promise<AiTaskTemplateRow[]> {
  const res = await conn().execute(
    `SELECT t.id, t.peerId, t.name, t.prompt, t.createdAt, t.updatedAt
     FROM ai_task_templates t
     INNER JOIN chats c ON c.peerId = t.peerId
     WHERE t.peerId = ? AND c.identityChangedAt IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM blocked_peers b WHERE b.peerId = t.peerId
       )
       AND NOT EXISTS (
         SELECT 1 FROM revoked_machine_peers r WHERE r.peerId = t.peerId
       )
     ORDER BY t.updatedAt DESC, t.id DESC`,
    [peerId],
  );
  return res.rows as unknown as AiTaskTemplateRow[];
}

/** Edit only the selected peer's row, under the same lifecycle guards used at
 * creation. A stale screen can therefore fail, but cannot restore retired
 * text. */
export async function updateAiTaskTemplate(
  peerId: string,
  id: number,
  name: string,
  prompt: string,
  at: number,
): Promise<boolean> {
  const input = normalizeAiTaskTemplate(name, prompt);
  if (!input || !Number.isSafeInteger(id) || id < 1 || !aiTaskTemplateTime(at)) {
    return false;
  }
  const d = conn();
  return runExclusive(async () => {
    await d.execute('BEGIN IMMEDIATE');
    try {
      const updated = await d.execute(
        `UPDATE ai_task_templates
         SET name = ?, prompt = ?, updatedAt = ?
         WHERE id = ? AND peerId = ?
           AND EXISTS (
             SELECT 1 FROM chats c
             WHERE c.peerId = ai_task_templates.peerId
               AND c.identityChangedAt IS NULL
           )
           AND NOT EXISTS (
             SELECT 1 FROM blocked_peers b
             WHERE b.peerId = ai_task_templates.peerId
           )
           AND NOT EXISTS (
             SELECT 1 FROM revoked_machine_peers r
             WHERE r.peerId = ai_task_templates.peerId
           )`,
        [input.name, input.prompt, at, id, peerId],
      );
      await d.execute('COMMIT');
      return (updated.rowsAffected ?? 0) === 1;
    } catch (err) {
      await d.execute('ROLLBACK');
      throw err;
    }
  });
}

/** Delete by both local id and peer so a stale row from another profile can
 * never be removed through an id collision. */
export async function deleteAiTaskTemplate(
  peerId: string,
  id: number,
): Promise<boolean> {
  if (!Number.isSafeInteger(id) || id < 1) return false;
  const result = await conn().execute(
    `DELETE FROM ai_task_templates WHERE peerId = ? AND id = ?`,
    [peerId, id],
  );
  return (result.rowsAffected ?? 0) === 1;
}

// --- structured AI work facts (AI workflows A3) ---

/** Structured activity is a short local digest, not a second transcript. */
export const AI_WORK_EVENT_RETAIN_MS = 7 * 24 * 60 * 60 * 1000;
/** Repository, branch, result summary and project labels are short-lived
 * context, even when their carrier is a profile snapshot. */
export const AI_WORK_CONTEXT_RETAIN_MS = 24 * 60 * 60 * 1000;
/** Old usage remains useful when labelled stale, but is not kept forever. */
export const AI_WORK_USAGE_RETAIN_MS = 30 * 24 * 60 * 60 * 1000;
export const AI_WORK_EVENT_LIST_LIMIT = 250;
export type AiWorkOriginKind = 'message' | 'approval' | 'profile';

export interface AiWorkEventRow {
  peerId: string;
  eventId: string;
  wireMsgId: string;
  provider: AiWorkMetadata['provider'];
  event: NonNullable<AiWorkMetadata['event']>;
  project: string | null;
  projectReceivedAt: number | null;
  requestId: string | null;
  runTag: string | null;
  originKind: AiWorkOriginKind;
  sourceRef: string;
  sourceAt: number;
  displayAt: number;
  timeTrusted: boolean;
  receivedAt: number;
  displayName: string | null;
  localName: string | null;
  context: AiWorkContext | null;
}

export interface AiAgentStateRow {
  peerId: string;
  provider: AiWorkMetadata['provider'];
  project: string | null;
  projectReceivedAt: number | null;
  capabilities: AiWorkCapabilities | null;
  capabilitiesReceivedAt: number | null;
  context: AiWorkContext | null;
  contextReceivedAt: number | null;
  usage: AiWorkUsage[] | null;
  usageReceivedAt: number | null;
  lastSourceAt: number;
  lastDisplayAt: number;
  lastTimeTrusted: boolean;
  lastReceivedAt: number;
  displayName: string | null;
  localName: string | null;
}

interface StoredAiAgentState {
  peerId: string;
  provider: AiWorkMetadata['provider'];
  project: string | null;
  projectReceivedAt: number | null;
  capabilitiesJson: string | null;
  capabilitiesReceivedAt: number | null;
  contextJson: string | null;
  contextReceivedAt: number | null;
  usageJson: string | null;
  usageReceivedAt: number | null;
  lastSourceAt: number;
  lastDisplayAt: number;
  lastTimeTrusted: number;
  lastReceivedAt: number;
  displayName: string | null;
  localName: string | null;
}

function parseCapabilitiesJson(value: string | null): AiWorkCapabilities | null {
  if (!value) return null;
  try {
    const parsed = AiWorkCapabilitiesSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function parseContextJson(value: string | null): AiWorkContext | null {
  if (!value) return null;
  try {
    const parsed = AiWorkContextSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function parseUsageJson(value: string | null): AiWorkUsage[] | null {
  if (!value) return null;
  try {
    const raw = JSON.parse(value) as unknown;
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > 8) return null;
    const usage: AiWorkUsage[] = [];
    for (const item of raw) {
      const parsed = AiWorkUsageSchema.safeParse(item);
      if (!parsed.success) return null;
      usage.push(parsed.data);
    }
    return usage;
  } catch {
    return null;
  }
}

function decodeAiAgentState(raw: StoredAiAgentState): AiAgentStateRow {
  return {
    peerId: raw.peerId,
    provider: raw.provider,
    project: raw.project,
    projectReceivedAt: raw.projectReceivedAt,
    capabilities: parseCapabilitiesJson(raw.capabilitiesJson),
    capabilitiesReceivedAt: raw.capabilitiesReceivedAt,
    context: parseContextJson(raw.contextJson),
    contextReceivedAt: raw.contextReceivedAt,
    usage: parseUsageJson(raw.usageJson),
    usageReceivedAt: raw.usageReceivedAt,
    lastSourceAt: raw.lastSourceAt,
    lastDisplayAt: raw.lastDisplayAt,
    lastTimeTrusted: raw.lastTimeTrusted === 1,
    lastReceivedAt: raw.lastReceivedAt,
    displayName: raw.displayName,
    localName: raw.localName,
  };
}

/**
 * Remove structured copies as soon as their source no longer exists. The
 * source predicates include logical expiry, so a disappearing message or
 * approval stops surfacing before a different screen happens to sweep it.
 */
async function maintainAiWork(d: Handle, now: number): Promise<void> {
  // The normalized columns are the event record. This legacy-required cell
  // never keeps a second copy of result summaries, usage, or capabilities.
  await d.execute(`UPDATE ai_work_events SET workJson = '{}' WHERE workJson != '{}'`);
  await d.execute(
    `DELETE FROM ai_work_events
     WHERE ? - receivedAt >= ${AI_WORK_EVENT_RETAIN_MS}
        OR (originKind = 'message' AND NOT EXISTS (
          SELECT 1 FROM messages m
          WHERE m.peerId = ai_work_events.peerId
            AND m.msgId = COALESCE(ai_work_events.sourceRef, ai_work_events.wireMsgId)
            AND m.direction = 'in'
            AND m.body != ''
            AND (m.expiresAt IS NULL OR m.expiresAt > ?)
        ))
        OR (originKind = 'approval' AND NOT EXISTS (
          SELECT 1 FROM approvals a
          WHERE a.peerId = ai_work_events.peerId
            AND a.wireMsgId = COALESCE(ai_work_events.sourceRef, ai_work_events.wireMsgId)
            AND a.state = 'pending'
            AND a.arrivedAt + a.ttlSec * 1000 > ?
            AND a.workJson IS NOT NULL
        ))`,
    [now, now, now],
  );
  await d.execute(
    `UPDATE ai_work_events
     SET project = NULL, projectReceivedAt = NULL,
         contextJson = NULL, contextReceivedAt = NULL
     WHERE (project IS NOT NULL OR contextJson IS NOT NULL)
       AND (COALESCE(projectReceivedAt, contextReceivedAt) IS NULL
         OR ? - COALESCE(projectReceivedAt, contextReceivedAt)
              >= ${AI_WORK_CONTEXT_RETAIN_MS})`,
    [now],
  );

  await d.execute(
    `UPDATE ai_agent_state
     SET project = NULL, projectReceivedAt = NULL,
         projectWireMsgId = NULL, projectOriginKind = NULL
     WHERE project IS NOT NULL AND (
       projectReceivedAt IS NULL OR projectOriginKind IS NULL
       OR ? - projectReceivedAt >= ${AI_WORK_CONTEXT_RETAIN_MS}
       OR (projectOriginKind = 'message' AND NOT EXISTS (
         SELECT 1 FROM messages m
         WHERE m.peerId = ai_agent_state.peerId
           AND m.msgId = ai_agent_state.projectWireMsgId
           AND m.direction = 'in'
           AND m.body != ''
           AND (m.expiresAt IS NULL OR m.expiresAt > ?)
       ))
       OR (projectOriginKind = 'approval' AND NOT EXISTS (
         SELECT 1 FROM approvals a
         WHERE a.peerId = ai_agent_state.peerId
           AND a.wireMsgId = ai_agent_state.projectWireMsgId
           AND a.state = 'pending'
           AND a.arrivedAt + a.ttlSec * 1000 > ?
           AND a.workJson IS NOT NULL
       ))
     )`,
    [now, now, now],
  );

  await d.execute(
    `UPDATE ai_agent_state
     SET contextJson = NULL, contextReceivedAt = NULL,
         contextWireMsgId = NULL, contextOriginKind = NULL
     WHERE contextJson IS NOT NULL AND (
       contextReceivedAt IS NULL OR contextOriginKind IS NULL
       OR ? - contextReceivedAt >= ${AI_WORK_CONTEXT_RETAIN_MS}
       OR (contextOriginKind = 'message' AND NOT EXISTS (
         SELECT 1 FROM messages m
         WHERE m.peerId = ai_agent_state.peerId
           AND m.msgId = ai_agent_state.contextWireMsgId
           AND m.direction = 'in'
           AND m.body != ''
           AND (m.expiresAt IS NULL OR m.expiresAt > ?)
       ))
       OR (contextOriginKind = 'approval' AND NOT EXISTS (
         SELECT 1 FROM approvals a
         WHERE a.peerId = ai_agent_state.peerId
           AND a.wireMsgId = ai_agent_state.contextWireMsgId
           AND a.state = 'pending'
           AND a.arrivedAt + a.ttlSec * 1000 > ?
           AND a.workJson IS NOT NULL
       ))
     )`,
    [now, now, now],
  );

  await d.execute(
    `UPDATE ai_agent_state
     SET usageJson = NULL, usageReceivedAt = NULL
     WHERE usageJson IS NOT NULL
       AND ? - usageReceivedAt >= ${AI_WORK_USAGE_RETAIN_MS}`,
    [now],
  );
}

/**
 * Persist authenticated sender facts. Local receipt order is authoritative;
 * sender time is retained only as a labelled display hint. Event identity is
 * exactly (peerId,eventId), while runTag remains a collision-prone label.
 *
 * A successful block/revoke/delete and this write share runExclusive, and the
 * INSERT guards lifecycle state inside the transaction. Replayed late facts
 * therefore cannot recreate a retired integration after its chat is rebuilt.
 */
export async function recordAiWork(
  peerId: string,
  wireMsgId: string,
  receivedAt: number,
  work: AiWorkMetadata,
  originKind: AiWorkOriginKind = 'profile',
  sourceRef: string = wireMsgId,
): Promise<void> {
  const parsed = AiWorkMetadataSchema.safeParse(work);
  if (!parsed.success) return;
  const value = parsed.data;
  const display = displayAiWorkTimestamp(value.updatedAt, receivedAt);
  const d = conn();

  await runExclusive(async () => {
    await d.execute('BEGIN IMMEDIATE');
    try {
      await maintainAiWork(d, receivedAt);

      let acceptsFacts = true;
      if (value.event !== undefined && value.eventId !== undefined) {
        const eventInsert = await d.execute(
          `INSERT INTO ai_work_events
             (peerId, eventId, wireMsgId, provider, event,
              project, projectReceivedAt, requestId, runTag, originKind,
              sourceRef, workJson, contextJson, contextReceivedAt,
              sourceAt, displayAt, timeTrusted, receivedAt)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
           WHERE EXISTS (
             SELECT 1 FROM chats c
             WHERE c.peerId = ? AND c.identityChangedAt IS NULL
           )
             AND NOT EXISTS (
               SELECT 1 FROM blocked_peers b WHERE b.peerId = ?
             )
             AND NOT EXISTS (
               SELECT 1 FROM revoked_machine_peers r WHERE r.peerId = ?
             )
           ON CONFLICT(peerId, eventId) DO NOTHING`,
          [
            peerId,
            value.eventId,
            wireMsgId,
            value.provider,
            value.event,
            value.project ?? null,
            value.project === undefined ? null : receivedAt,
            value.requestId ?? null,
            value.runTag ?? null,
            originKind,
            sourceRef,
            '{}',
            value.context === undefined ? null : JSON.stringify(value.context),
            value.context === undefined ? null : receivedAt,
            value.updatedAt,
            display.at,
            display.trusted ? 1 : 0,
            receivedAt,
            peerId,
            peerId,
            peerId,
          ],
        );
        // A duplicate canonical event is the same fact, not a fresh snapshot.
        // It cannot refresh age or roll capability/usage/context backwards.
        acceptsFacts = (eventInsert.rowsAffected ?? 0) > 0;
      }

      if (acceptsFacts) await d.execute(
        `INSERT INTO ai_agent_state
           (peerId, provider, project, projectReceivedAt,
            projectWireMsgId, projectOriginKind,
            capabilitiesJson, capabilitiesReceivedAt,
            contextJson, contextReceivedAt, contextWireMsgId, contextOriginKind,
            usageJson, usageReceivedAt,
            lastSourceAt, lastDisplayAt, lastTimeTrusted, lastReceivedAt)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         WHERE EXISTS (
           SELECT 1 FROM chats c
           WHERE c.peerId = ? AND c.identityChangedAt IS NULL
         )
           AND NOT EXISTS (
             SELECT 1 FROM blocked_peers b WHERE b.peerId = ?
           )
           AND NOT EXISTS (
             SELECT 1 FROM revoked_machine_peers r WHERE r.peerId = ?
           )
         ON CONFLICT(peerId) DO UPDATE SET
           provider = excluded.provider,
           project = CASE
             WHEN excluded.provider != ai_agent_state.provider
               THEN excluded.project
             ELSE COALESCE(excluded.project, ai_agent_state.project)
           END,
           projectReceivedAt = CASE
             WHEN excluded.provider != ai_agent_state.provider
               THEN excluded.projectReceivedAt
             ELSE COALESCE(excluded.projectReceivedAt, ai_agent_state.projectReceivedAt)
           END,
           projectWireMsgId = CASE
             WHEN excluded.provider != ai_agent_state.provider
               THEN excluded.projectWireMsgId
             ELSE COALESCE(excluded.projectWireMsgId, ai_agent_state.projectWireMsgId)
           END,
           projectOriginKind = CASE
             WHEN excluded.provider != ai_agent_state.provider
               THEN excluded.projectOriginKind
             ELSE COALESCE(excluded.projectOriginKind, ai_agent_state.projectOriginKind)
           END,
           capabilitiesJson = CASE
             WHEN excluded.provider != ai_agent_state.provider
               THEN excluded.capabilitiesJson
             ELSE COALESCE(excluded.capabilitiesJson, ai_agent_state.capabilitiesJson)
           END,
           capabilitiesReceivedAt = CASE
             WHEN excluded.provider != ai_agent_state.provider
               THEN excluded.capabilitiesReceivedAt
             ELSE COALESCE(
               excluded.capabilitiesReceivedAt,
               ai_agent_state.capabilitiesReceivedAt
             )
           END,
           contextJson = CASE
             WHEN excluded.provider != ai_agent_state.provider
               THEN excluded.contextJson
             ELSE COALESCE(excluded.contextJson, ai_agent_state.contextJson)
           END,
           contextReceivedAt = CASE
             WHEN excluded.provider != ai_agent_state.provider
               THEN excluded.contextReceivedAt
             ELSE COALESCE(excluded.contextReceivedAt, ai_agent_state.contextReceivedAt)
           END,
           contextWireMsgId = CASE
             WHEN excluded.provider != ai_agent_state.provider
               THEN excluded.contextWireMsgId
             ELSE COALESCE(excluded.contextWireMsgId, ai_agent_state.contextWireMsgId)
           END,
           contextOriginKind = CASE
             WHEN excluded.provider != ai_agent_state.provider
               THEN excluded.contextOriginKind
             ELSE COALESCE(excluded.contextOriginKind, ai_agent_state.contextOriginKind)
           END,
           usageJson = CASE
             WHEN excluded.provider != ai_agent_state.provider
               THEN excluded.usageJson
             ELSE COALESCE(excluded.usageJson, ai_agent_state.usageJson)
           END,
           usageReceivedAt = CASE
             WHEN excluded.provider != ai_agent_state.provider
               THEN excluded.usageReceivedAt
             ELSE COALESCE(excluded.usageReceivedAt, ai_agent_state.usageReceivedAt)
           END,
           lastSourceAt = excluded.lastSourceAt,
           lastDisplayAt = excluded.lastDisplayAt,
           lastTimeTrusted = excluded.lastTimeTrusted,
           lastReceivedAt = excluded.lastReceivedAt
         WHERE excluded.lastReceivedAt >= ai_agent_state.lastReceivedAt`,
        [
          peerId,
          value.provider,
          value.project ?? null,
          value.project === undefined ? null : receivedAt,
          value.project === undefined ? null : sourceRef,
          value.project === undefined ? null : originKind,
          value.capabilities === undefined
            ? null
            : JSON.stringify(value.capabilities),
          value.capabilities === undefined ? null : receivedAt,
          value.context === undefined ? null : JSON.stringify(value.context),
          value.context === undefined ? null : receivedAt,
          value.context === undefined ? null : sourceRef,
          value.context === undefined ? null : originKind,
          value.usage === undefined ? null : JSON.stringify(value.usage),
          value.usage === undefined ? null : receivedAt,
          value.updatedAt,
          display.at,
          display.trusted ? 1 : 0,
          receivedAt,
          peerId,
          peerId,
          peerId,
        ],
      );

      if (
        acceptsFacts &&
        value.approvalObservation !== undefined &&
        value.requestId !== undefined
      ) {
        await d.execute(
          `UPDATE approvals
           SET hostObservation = ?, hostObservationProvider = ?,
               hostObservationSourceAt = ?, hostObservationReceivedAt = ?
           WHERE peerId = ? AND q = ?
             AND (
               hostObservation IS NULL
               OR CASE ?
                    WHEN 'answer-received' THEN 1
                    WHEN 'decision-returned' THEN 2
                    WHEN 'provider-received' THEN 3
                    WHEN 'expired' THEN 4
                    ELSE 0
                  END
                  > CASE hostObservation
                    WHEN 'answer-received' THEN 1
                    WHEN 'decision-returned' THEN 2
                    WHEN 'provider-received' THEN 3
                    WHEN 'expired' THEN 4
                    ELSE 0
                  END
             )
             AND EXISTS (
               SELECT 1 FROM chats c
               WHERE c.peerId = approvals.peerId
                 AND c.identityChangedAt IS NULL
             )
             AND NOT EXISTS (
               SELECT 1 FROM blocked_peers b WHERE b.peerId = approvals.peerId
             )
             AND NOT EXISTS (
               SELECT 1 FROM revoked_machine_peers r
               WHERE r.peerId = approvals.peerId
             )`,
          [
            value.approvalObservation,
            value.provider,
            value.updatedAt,
            receivedAt,
            peerId,
            value.requestId,
            value.approvalObservation,
          ],
        );
      }

      await d.execute('COMMIT');
    } catch (err) {
      await d.execute('ROLLBACK');
      throw err;
    }
  });
}

/** Recent structured events, in this phone's receive order. */
export async function listRecentAiWorkEvents(now: number): Promise<AiWorkEventRow[]> {
  const d = conn();
  await maintainApprovals(d, now);
  await maintainAiWork(d, now);
  const res = await d.execute(
    `SELECT e.peerId, e.eventId, e.wireMsgId, e.provider, e.event,
            e.project, e.projectReceivedAt, e.requestId, e.runTag, e.originKind,
            COALESCE(e.sourceRef, e.wireMsgId) AS sourceRef,
            e.contextJson, e.contextReceivedAt, e.sourceAt,
            e.displayAt, e.timeTrusted, e.receivedAt,
            c.displayName, c.localName
     FROM ai_work_events e
     INNER JOIN chats c ON c.peerId = e.peerId
     WHERE c.identityChangedAt IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM blocked_peers b WHERE b.peerId = e.peerId
       )
       AND NOT EXISTS (
         SELECT 1 FROM revoked_machine_peers r WHERE r.peerId = e.peerId
       )
     ORDER BY e.receivedAt DESC, e.peerId ASC, e.eventId ASC
     LIMIT ${AI_WORK_EVENT_LIST_LIMIT}`,
  );
  const rows: AiWorkEventRow[] = [];
  for (const raw of res.rows as unknown as Array<{
    peerId: string;
    eventId: string;
    wireMsgId: string;
    provider: AiWorkMetadata['provider'];
    event: NonNullable<AiWorkMetadata['event']>;
    project: string | null;
    projectReceivedAt: number | null;
    requestId: string | null;
    runTag: string | null;
    originKind: AiWorkOriginKind;
    sourceRef: string;
    contextJson: string | null;
    contextReceivedAt: number | null;
    sourceAt: number;
    displayAt: number;
    timeTrusted: number;
    receivedAt: number;
    displayName: string | null;
    localName: string | null;
  }>) {
    const context = parseContextJson(raw.contextJson);
    const candidate = AiWorkMetadataSchema.safeParse({
      provider: raw.provider,
      updatedAt: raw.sourceAt,
      event: raw.event,
      eventId: raw.eventId,
      ...(raw.project === null ? {} : { project: raw.project }),
      ...(raw.requestId === null ? {} : { requestId: raw.requestId }),
      ...(raw.runTag === null ? {} : { runTag: raw.runTag }),
      ...(context === null ? {} : { context }),
    });
    if (!candidate.success) continue;
    const { contextJson, timeTrusted, ...stored } = raw;
    void contextJson;
    rows.push({ ...stored, timeTrusted: timeTrusted === 1, context });
  }
  return rows;
}

/** Latest independently merged facts for one integration. */
export async function getAiAgentState(peerId: string): Promise<AiAgentStateRow | null> {
  const d = conn();
  await maintainAiWork(d, Date.now());
  const res = await d.execute(
    `SELECT s.peerId, s.provider, s.project,
            s.projectReceivedAt,
            s.capabilitiesJson, s.capabilitiesReceivedAt,
            s.contextJson, s.contextReceivedAt,
            s.usageJson, s.usageReceivedAt,
            s.lastSourceAt, s.lastDisplayAt, s.lastTimeTrusted,
            s.lastReceivedAt, c.displayName, c.localName
     FROM ai_agent_state s
     INNER JOIN chats c ON c.peerId = s.peerId
     WHERE s.peerId = ? AND c.identityChangedAt IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM blocked_peers b WHERE b.peerId = s.peerId
       )
       AND NOT EXISTS (
         SELECT 1 FROM revoked_machine_peers r WHERE r.peerId = s.peerId
       )`,
    [peerId],
  );
  const raw = res.rows[0] as unknown as StoredAiAgentState | undefined;
  if (!raw) return null;
  return decodeAiAgentState(raw);
}

/** Every non-retired integration with source-backed state, newest receipt first. */
export async function listAiAgentStates(now: number): Promise<AiAgentStateRow[]> {
  const d = conn();
  await maintainAiWork(d, now);
  const res = await d.execute(
    `SELECT s.peerId, s.provider, s.project, s.projectReceivedAt,
            s.capabilitiesJson, s.capabilitiesReceivedAt,
            s.contextJson, s.contextReceivedAt,
            s.usageJson, s.usageReceivedAt,
            s.lastSourceAt, s.lastDisplayAt, s.lastTimeTrusted,
            s.lastReceivedAt, c.displayName, c.localName
     FROM ai_agent_state s
     INNER JOIN chats c ON c.peerId = s.peerId
     WHERE c.identityChangedAt IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM blocked_peers b WHERE b.peerId = s.peerId
       )
       AND NOT EXISTS (
         SELECT 1 FROM revoked_machine_peers r WHERE r.peerId = s.peerId
       )
     ORDER BY s.lastReceivedAt DESC, s.peerId ASC`,
  );
  return (res.rows as unknown as StoredAiAgentState[]).map(decodeAiAgentState);
}

export type AiRoutineNotificationMode = 'all' | 'quiet';

export interface AiNotifyPreferenceRow {
  peerId: string;
  effectiveRoutine: AiRoutineNotificationMode;
  pendingQ: string | null;
  requestedRoutine: AiRoutineNotificationMode | null;
  requestedAt: number | null;
  acknowledgedAt: number | null;
}

const defaultAiNotifyPreference = (peerId: string): AiNotifyPreferenceRow => ({
  peerId,
  effectiveRoutine: 'all',
  pendingQ: null,
  requestedRoutine: null,
  requestedAt: null,
  acknowledgedAt: null,
});

/** Current effective mode plus any owner request awaiting an exact host ack. */
export async function getAiNotifyPreference(
  peerId: string,
): Promise<AiNotifyPreferenceRow> {
  const res = await conn().execute(
    `SELECT peerId, effectiveRoutine, pendingQ, requestedRoutine,
            requestedAt, acknowledgedAt
     FROM ai_notify_preferences WHERE peerId = ?`,
    [peerId],
  );
  const raw = res.rows[0] as unknown as AiNotifyPreferenceRow | undefined;
  if (
    !raw ||
    (raw.effectiveRoutine !== 'all' && raw.effectiveRoutine !== 'quiet') ||
    (raw.requestedRoutine !== null &&
      raw.requestedRoutine !== 'all' &&
      raw.requestedRoutine !== 'quiet')
  ) {
    return defaultAiNotifyPreference(peerId);
  }
  return raw;
}

/**
 * Persist the request before its carrier can flush. Last choice wins: an ack
 * for an older q is ignored once the owner has requested a newer value.
 */
export async function beginAiNotifyPreference(
  peerId: string,
  q: string,
  routine: AiRoutineNotificationMode,
  requestedAt: number,
): Promise<boolean> {
  const res = await conn().execute(
    `INSERT INTO ai_notify_preferences
       (peerId, effectiveRoutine, pendingQ, requestedRoutine, requestedAt,
        acknowledgedAt)
     SELECT ?, 'all', ?, ?, ?, NULL
     WHERE EXISTS (
       SELECT 1 FROM chats c
       WHERE c.peerId = ? AND c.identityChangedAt IS NULL
     )
       AND NOT EXISTS (
         SELECT 1 FROM blocked_peers b WHERE b.peerId = ?
       )
       AND NOT EXISTS (
         SELECT 1 FROM revoked_machine_peers r WHERE r.peerId = ?
       )
     ON CONFLICT(peerId) DO UPDATE SET
       pendingQ = excluded.pendingQ,
       requestedRoutine = excluded.requestedRoutine,
       requestedAt = excluded.requestedAt
     WHERE NOT EXISTS (
       SELECT 1 FROM blocked_peers b WHERE b.peerId = excluded.peerId
     )
       AND NOT EXISTS (
         SELECT 1 FROM revoked_machine_peers r WHERE r.peerId = excluded.peerId
       )`,
    [peerId, q, routine, requestedAt, peerId, peerId, peerId],
  );
  return (res.rowsAffected ?? 0) > 0;
}

/** Apply only the authenticated peer's exact q+value echo. */
export async function applyAiNotifyPreferenceAck(
  peerId: string,
  q: string,
  routine: AiRoutineNotificationMode,
  acknowledgedAt: number,
): Promise<boolean> {
  const res = await conn().execute(
    `UPDATE ai_notify_preferences
     SET effectiveRoutine = requestedRoutine,
         pendingQ = NULL, requestedRoutine = NULL, requestedAt = NULL,
         acknowledgedAt = ?
     WHERE peerId = ? AND pendingQ = ? AND requestedRoutine = ?
       AND NOT EXISTS (
         SELECT 1 FROM blocked_peers b WHERE b.peerId = ai_notify_preferences.peerId
       )
       AND NOT EXISTS (
         SELECT 1 FROM revoked_machine_peers r
         WHERE r.peerId = ai_notify_preferences.peerId
       )`,
    [acknowledgedAt, peerId, q, routine],
  );
  return (res.rowsAffected ?? 0) > 0;
}

/** Undo only the request whose carrier failed before becoming durable. */
export async function clearAiNotifyPreferenceRequest(
  peerId: string,
  q: string,
): Promise<void> {
  await conn().execute(
    `UPDATE ai_notify_preferences
     SET pendingQ = NULL, requestedRoutine = NULL, requestedAt = NULL
     WHERE peerId = ? AND pendingQ = ?`,
    [peerId, q],
  );
}

// --- the machine record ---

/**
 * Remember a server-confirmed machine. Called from the peer profile's adopt
 * and revoke success paths ONLY — the two owner-called routes whose 204 is
 * the server saying "this is a machine you paired" — and nowhere a peer's
 * content can reach (see the table comment in initDb and the rule in
 * machine.ts). DO NOTHING under the key: the first learn wins, and there is
 * no delete — a class is birth-permanent, so a revoked machine's history
 * keeps its marker.
 */
export async function recordMachinePeer(
  peerId: string,
  learnedAt: number,
): Promise<void> {
  await conn().execute(
    `INSERT INTO machine_peers (peerId, learnedAt)
     VALUES (?, ?)
     ON CONFLICT(peerId) DO NOTHING`,
    [peerId, learnedAt],
  );
}

/**
 * Persist the owner route's successful revoke and burn every approval from
 * that retired key atomically. A failed server call never reaches this
 * function. The lifecycle row survives deleteChat, and insertApproval checks
 * it in its INSERT statement so a late/replayed frame cannot revive work.
 */
export async function recordMachineRevoked(
  peerId: string,
  revokedAt: number,
): Promise<void> {
  const d = conn();
  await runExclusive(async () => {
    await d.execute('BEGIN IMMEDIATE');
    try {
      await d.execute(
        `INSERT INTO machine_peers (peerId, learnedAt)
         VALUES (?, ?) ON CONFLICT(peerId) DO NOTHING`,
        [peerId, revokedAt],
      );
      await d.execute(
        `INSERT INTO revoked_machine_peers (peerId, revokedAt)
         VALUES (?, ?) ON CONFLICT(peerId) DO NOTHING`,
        [peerId, revokedAt],
      );
      await d.execute(`DELETE FROM approvals WHERE peerId = ?`, [peerId]);
      await d.execute(`DELETE FROM ai_work_events WHERE peerId = ?`, [peerId]);
      await d.execute(`DELETE FROM ai_agent_state WHERE peerId = ?`, [peerId]);
      await d.execute(`DELETE FROM ai_notify_preferences WHERE peerId = ?`, [peerId]);
      await d.execute(`DELETE FROM ai_task_templates WHERE peerId = ?`, [peerId]);
      await d.execute('COMMIT');
    } catch (err) {
      await d.execute('ROLLBACK');
      throw err;
    }
  });
}

/** Every machine this account has been TOLD about, for the AI badge and the
 * roster attribution. Small by construction (the crew caps at 8 live
 * machines), so callers hold it as a Set. */
export async function listMachinePeers(): Promise<string[]> {
  const res = await conn().execute(
    `SELECT peerId FROM machine_peers ORDER BY peerId ASC`,
  );
  return (res.rows as { peerId: string }[]).map(r => r.peerId);
}

// --- agent consent (the DARK record) ---

/** The three answers. 'undecided' is the absence of a row — the
 * state every agent starts in, and the state a wipe returns them to. */
export type AgentConsentState = 'consented' | 'refused' | 'undecided';

/**
 * Record THIS USER's decision about ONE agent account. Local only for now:
 * writes no server edge, sends no envelope, announces nothing — a later phase turns
 * 'consented' into the server-stored pairwise edge and 'refused' into the
 * refusal the send/inbox arms enforce; until then this row is a decision
 * waiting for its delivery semantics, deliberately invisible everywhere.
 * An upsert, because a decision is the user's own and revisable — refusing
 * after consenting must land, and the newest decision is the whole truth
 * (`decidedAt` is display/history, never an arbiter).
 */
export async function setAgentConsent(
  peerId: string,
  state: 'consented' | 'refused',
  decidedAt: number,
): Promise<void> {
  await conn().execute(
    `INSERT INTO agent_consent (peerId, state, decidedAt)
     VALUES (?, ?, ?)
     ON CONFLICT(peerId) DO UPDATE SET
       state = excluded.state,
       decidedAt = excluded.decidedAt`,
    [peerId, state, decidedAt],
  );
}

/** What this user decided about one agent — 'undecided' when they never
 * have. The one reader the consent surfaces build on. */
export async function getAgentConsent(peerId: string): Promise<AgentConsentState> {
  const res = await conn().execute(
    `SELECT state FROM agent_consent WHERE peerId = ?`,
    [peerId],
  );
  const state = (res.rows[0] as { state?: string } | undefined)?.state;
  return state === 'consented' || state === 'refused' ? state : 'undecided';
}

/**
 * How many agents THIS CLIENT has locally recorded as 'consented'.
 * The cap-aware surface reads THIS and nothing else: the server's
 * `POST /v1/consent` answers a uniform 204 whether the edge stored or was
 * silently dropped over the CONSENT_MAX_EDGES cap, so the only place
 * the app can honestly say "you may have reached your sharing limit" is its
 * own count of what it has consented to. This is a LOWER BOUND on the
 * server's edge count (edges written from another client are not here), which
 * is exactly why the surface is hedged and advisory — it never probes the
 * route to learn the true number, because there is no route to ask.
 */
export async function countConsentedAgents(): Promise<number> {
  const res = await conn().execute(
    `SELECT COUNT(*) AS total FROM agent_consent WHERE state = 'consented'`,
  );
  return Number((res.rows[0] as { total?: number } | undefined)?.total ?? 0);
}

/**
 * The authenticated authors of AI-marked messages in one room —
 * the marker half of "the roster signal the badge uses"
 * (marker-OR-machine_peers), lifted to the roster level so a NON-owner, whose
 * `machine_peers` never names someone else's agent, can still tell a room
 * member is an agent once it has spoken. Derived only from `messages.ai`, the
 * claim recorded AT ARRIVAL from the sealed marker — never from a live probe,
 * never from a body re-parse, and never from anything the server enumerates. An agent that has not yet spoken is invisible here, which is the
 * honest floor: the app never GUESSES a member's class (machine.ts's rule).
 *
 * FIRST-HAND ROWS ONLY (`sharedBy IS NULL`): a grp.hist relay stores
 * `authorId` as the RELAYER'S claim about a third party, and this set feeds
 * delivery (roomContentAudience), the grp.consent subject gate and the consent
 * choice-set — surfaces where a fabricated history entry must not let the
 * relayer mark a HUMAN as an agent. The relayed row keeps its `ai` flag for
 * the bubble badge (detection-for-rendering on a row already marked
 * second-hand); it simply never feeds this set.
 */
export async function listRoomAgentAuthorIds(groupId: string): Promise<string[]> {
  const res = await conn().execute(
    `SELECT DISTINCT authorId FROM messages
       WHERE peerId = ? AND ai = 1 AND authorId IS NOT NULL
         AND sharedBy IS NULL`,
    [groupId],
  );
  return (res.rows as { authorId: string }[]).map(r => r.authorId);
}

// --- msgId dedupe (idempotent drain) ---

export async function hasSeen(msgId: string): Promise<boolean> {
  const res = await conn().execute(`SELECT 1 AS x FROM seen WHERE msgId = ?`, [
    msgId,
  ]);
  return res.rows.length > 0;
}

/**
 * Mark my own messages as read by the peer (WhatsApp's second tick, filled).
 *
 * Guarded three ways, because `ids` comes off the wire:
 *   - `direction = 'out'` — a peer can only report having read MY messages,
 *     never rewrite the status of their own;
 *   - `peerId = ?` — an id from one conversation cannot reach into another;
 *   - `status IN ('sent','delivered')` — read follows a send the server
 *     took, so a receipt cannot resurrect a failed send, overwrite an error
 *     row, or claim a message this device never got out of its outbox.
 *
 * `sent` is admitted on purpose. The server posts exactly ONE receipt per
 * send — `delivered` if the recipient had a live socket at that instant,
 * `sent` otherwise — and nothing at drain or ack time, so a message queued
 * while they were offline (on iOS: whenever the app was backgrounded) stays
 * `sent` forever. The old `= 'delivered'` guard therefore matched zero rows
 * for most messages, and the peer's read envelope was consumed and acked
 * with nothing to show for it. A peer proving they read a message is
 * stronger evidence of delivery than any server receipt; the two
 * anti-forgery guards above are what keep the proof honest.
 *
 * Returns how many rows actually moved, so the caller can skip a re-render
 * for a replayed receipt. */
export async function markRead(
  peerId: string,
  msgIds: string[],
  at: number,
): Promise<number> {
  if (msgIds.length === 0) return 0;
  const holes = msgIds.map(() => '?').join(',');
  const res = await conn().execute(
    `UPDATE messages SET status = 'read', readAt = ?
     WHERE peerId = ? AND direction = 'out' AND status IN ('sent', 'delivered')
       AND msgId IN (${holes})`,
    [at, peerId, ...msgIds],
  );
  return res.rowsAffected ?? 0;
}

/** THEIR messages in this thread that this device has displayed but not yet
 * acknowledged — the batch a read receipt reports. */
export async function unreadInboundIds(peerId: string): Promise<string[]> {
  const res = await conn().execute(
    `SELECT msgId FROM messages
     WHERE peerId = ? AND direction = 'in' AND readSent = 0
     ORDER BY ts ASC`,
    [peerId],
  );
  return (res.rows as unknown as { msgId: string }[]).map(r => r.msgId);
}

/** Remember that a receipt for these went out, so it is sent once. */
export async function markReadSent(msgIds: string[]): Promise<void> {
  if (msgIds.length === 0) return;
  const holes = msgIds.map(() => '?').join(',');
  // Scoped to the direction the flag is ABOUT. Unscoped, a receipt for a
  // peer-chosen inbound id also marked my own outgoing row of the same id —
  // and in another conversation entirely (found by review).
  await conn().execute(
    `UPDATE messages SET readSent = 1 WHERE direction = 'in' AND msgId IN (${holes})`,
    msgIds,
  );
}

export async function markSeen(msgId: string, ts: number): Promise<void> {
  const d = conn();
  await d.execute(`INSERT OR IGNORE INTO seen (msgId, ts) VALUES (?, ?)`, [
    msgId,
    ts,
  ]);
  // Bounded: the server queue TTL is 30 days; keep the 5000 most RECENTLY
  // SEEN ids — by `ts`, which every caller stamps with this device's clock
  // at processing time, and NEVER by msgId order. Room legs, device fan-out
  // extras and every `x.acct.*` carrier ride pure-CSPRNG wire ids
  // (`randomMsgId`: first char '0'–'7', the rest uniform Crockford), ~99 %
  // of which sort above any time-ordered ULID; an id-ordered prune therefore
  // evicted every 1:1 row — including the one this very call had just
  // inserted — once 5000 random ids existed, which switched 1:1 redelivery
  // dedup off and re-imported the NSE spool on every launch. Ordered by
  // insertion time the row just written is always the newest, whatever its
  // id looks like. msgId is the tiebreak only.
  await d.execute(
    `DELETE FROM seen WHERE msgId NOT IN
       (SELECT msgId FROM seen ORDER BY ts DESC, msgId DESC LIMIT 5000)`,
  );
}

// --- linked devices ---

/** One member of this account's device roster, as this device recorded it. */
export interface LinkedDeviceRow {
  userId: string;
  class: DeviceClass;
  state: 'linked' | 'revoked' | 'unlinked';
  updatedAt: number;
  /** JSON of the ceremony signatures where held; '' when not. */
  certsJson: string;
  /** The member's identity public key as this device holds it — what
   * member* notice signatures verify against; '' when not yet known. */
  identityKeyPub?: string;
}

export interface LinkGroupRow {
  groupId: string;
  rosterEpoch: number;
}

/** This account's group name + last seen roster epoch, or null when this
 * device has never linked (the anonymous default, structurally). */
export async function loadLinkGroup(): Promise<LinkGroupRow | null> {
  const res = await conn().execute(
    `SELECT groupId, rosterEpoch FROM link_group WHERE key = 'group'`,
  );
  const row = (res.rows as unknown as { groupId: string; rosterEpoch: number }[])[0];
  return row ? { groupId: row.groupId, rosterEpoch: Number(row.rosterEpoch) } : null;
}

export async function saveLinkGroup(groupId: string, rosterEpoch: number): Promise<void> {
  await conn().execute(
    `INSERT OR REPLACE INTO link_group (key, groupId, rosterEpoch) VALUES ('group', ?, ?)`,
    [groupId, rosterEpoch],
  );
}

export async function upsertLinkedDevice(row: LinkedDeviceRow): Promise<void> {
  await conn().execute(
    `INSERT OR REPLACE INTO linked_devices (userId, class, state, updatedAt, certsJson, identityKeyPub)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [row.userId, row.class, row.state, row.updatedAt, row.certsJson, row.identityKeyPub ?? ''],
  );
}

/** Flip one member's state (revoked/unlinked) without touching its history
 * row — the roster UI filters to 'linked', so this IS the disappearance. */
export async function markLinkedDeviceState(
  userId: string,
  state: 'linked' | 'revoked' | 'unlinked',
  updatedAt: number,
): Promise<void> {
  await conn().execute(
    `UPDATE linked_devices SET state = ?, updatedAt = ? WHERE userId = ?`,
    [state, updatedAt, userId],
  );
}

/** Every device row ever recorded, newest change first — the "Linked
 * devices" screen filters to state = 'linked' for the roster and may render
 * the rest as history. */
export async function listLinkedDevices(): Promise<LinkedDeviceRow[]> {
  const res = await conn().execute(
    `SELECT userId, class, state, updatedAt, certsJson, identityKeyPub FROM linked_devices
     ORDER BY updatedAt DESC, userId ASC`,
  );
  return (res.rows as unknown as LinkedDeviceRow[]).map(r => ({
    userId: r.userId,
    class: r.class,
    state: r.state,
    updatedAt: Number(r.updatedAt),
    certsJson: r.certsJson ?? '',
    identityKeyPub: r.identityKeyPub ?? '',
  }));
}

/** Leave the group locally (own unlink, or a dissolve): the group row and
 * every member row go; the account continues standalone — which it always
 * was. */
export async function clearLinkGroup(): Promise<void> {
  const d = conn();
  await d.execute(`DELETE FROM link_group`);
  await d.execute(`DELETE FROM linked_devices`);
  // A pending outgoing offer is a claim about a group this device just
  // left; it must not survive to reconcile against nothing.
  await d.execute(`DELETE FROM link_pending_ceremony`);
  // A stored recovery notice names THE GROUPING —
  // leaving the group makes it a former group's claim, and a delayed
  // redelivery must not resurrect it as if it were this account's.
  await d.execute(`DELETE FROM recovery_notice`);
}

/** Durably hold the inbound link offer BEFORE the queue row is acked: a relaunch between ack and human confirmation must still be able
 * to show the ceremony. */
export async function savePendingLinkOffer(
  offerNonce: string,
  noticeJson: string,
  receivedAt: number,
): Promise<void> {
  await conn().execute(
    `INSERT OR REPLACE INTO link_pending_offer (offerNonce, noticeJson, receivedAt)
     VALUES (?, ?, ?)`,
    [offerNonce, noticeJson, receivedAt],
  );
}

/** The newest pending offer, or null. Expiry is the READER's check, against
 * the notice's own expiresAt — reaping is cleanup, never the enforcement. */
export async function loadPendingLinkOffer(): Promise<
  { offerNonce: string; noticeJson: string; receivedAt: number } | null
> {
  const res = await conn().execute(
    `SELECT offerNonce, noticeJson, receivedAt FROM link_pending_offer
     ORDER BY receivedAt DESC LIMIT 1`,
  );
  const row = (
    res.rows as unknown as { offerNonce: string; noticeJson: string; receivedAt: number }[]
  )[0];
  return row
    ? {
        offerNonce: row.offerNonce,
        noticeJson: row.noticeJson,
        receivedAt: Number(row.receivedAt),
      }
    : null;
}

export async function deletePendingLinkOffer(offerNonce: string): Promise<void> {
  await conn().execute(`DELETE FROM link_pending_offer WHERE offerNonce = ?`, [offerNonce]);
}

/** Durably record the OFFERER's submitted offer: the
 * completion probe must survive the scan screen's lifetime, or a person who
 * backgrounds the app between submit and acceptance is server-side grouped
 * while every local surface says otherwise. Single row — one live outgoing
 * offer at a time, the newest wins. */
export async function savePendingLinkCeremony(
  offerJson: string,
  createdAt: number,
): Promise<void> {
  await conn().execute(
    `INSERT OR REPLACE INTO link_pending_ceremony (key, offerJson, createdAt)
     VALUES ('offer', ?, ?)`,
    [offerJson, createdAt],
  );
}

export async function loadPendingLinkCeremony(): Promise<
  { offerJson: string; createdAt: number } | null
> {
  const res = await conn().execute(
    `SELECT offerJson, createdAt FROM link_pending_ceremony WHERE key = 'offer'`,
  );
  const row = (res.rows as unknown as { offerJson: string; createdAt: number }[])[0];
  return row ? { offerJson: row.offerJson, createdAt: Number(row.createdAt) } : null;
}

export async function deletePendingLinkCeremony(): Promise<void> {
  await conn().execute(`DELETE FROM link_pending_ceremony`);
}

/**
 * The step-1 pristineness fact, CLIENT-side: whether this install has a
 * lived-in life a link would merge into someone's group. The server's
 * transaction conditions are the enforcement; this check is
 * the honest local mirror that refuses to even SHOW a ceremony on a
 * non-pristine device — no pair-ledger rows (chats, rooms included), no
 * crew, no consent edges, and no existing group. Identifier claims are
 * server-side state with no local table in v1; the server's precheck and
 * conditions carry that class alone.
 */
export async function pristineForLink(): Promise<boolean> {
  const d = conn();
  for (const probe of [
    `SELECT COUNT(*) AS n FROM chats`,
    `SELECT COUNT(*) AS n FROM machine_peers`,
    `SELECT COUNT(*) AS n FROM agent_consent`,
    `SELECT COUNT(*) AS n FROM link_group`,
  ]) {
    const res = await d.execute(probe);
    const row = (res.rows as unknown as { n: number }[])[0];
    if (Number(row?.n ?? 0) > 0) return false;
  }
  return true;
}

// --- peer device sets ---

/** One device of a PEER's set, TOFU verdict included — peerDevices.ts owns
 * the semantics; this is only the row. */
export interface PeerDeviceDbRow {
  userId: string;
  anchorId: string;
  class: DeviceClass | 'unknown';
  state: 'linked' | 'pending' | 'removed' | 'revoked';
  identityKeyPub: string;
  certsJson: string;
  updatedAt: number;
}

export async function upsertPeerDevice(row: PeerDeviceDbRow): Promise<void> {
  // A per-pair verification stamp is a human act
  // ABOUT A KEY, recorded under the pair's ULID. If this write REPLACES the
  // device's recorded key with a different one (a kit rebind keeps the ULID
  // and swaps the key), the old stamp must die with the old key — otherwise
  // "you checked this pair and it matched" reads as vouching for a number
  // that did not exist when the human compared. One conditional statement,
  // before the upsert, so no write path can skip it; an empty incoming key
  // asserts nothing and clears nothing.
  if (row.identityKeyPub !== '') {
    await conn().execute(
      `DELETE FROM peer_device_safety
       WHERE userId = ?
         AND EXISTS (
           SELECT 1 FROM peer_devices
           WHERE userId = ? AND identityKeyPub != '' AND identityKeyPub != ?
         )`,
      [row.userId, row.userId, row.identityKeyPub],
    );
  }
  await conn().execute(
    `INSERT OR REPLACE INTO peer_devices
       (userId, anchorId, class, state, identityKeyPub, certsJson, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [row.userId, row.anchorId, row.class, row.state, row.identityKeyPub, row.certsJson, row.updatedAt],
  );
}

export async function getPeerDevice(userId: string): Promise<PeerDeviceDbRow | null> {
  const res = await conn().execute(
    `SELECT userId, anchorId, class, state, identityKeyPub, certsJson, updatedAt
     FROM peer_devices WHERE userId = ?`,
    [userId],
  );
  const row = (res.rows as unknown as PeerDeviceDbRow[])[0];
  return row
    ? { ...row, updatedAt: Number(row.updatedAt), identityKeyPub: row.identityKeyPub ?? '', certsJson: row.certsJson ?? '' }
    : null;
}

export async function listPeerDevices(anchorId: string): Promise<PeerDeviceDbRow[]> {
  const res = await conn().execute(
    `SELECT userId, anchorId, class, state, identityKeyPub, certsJson, updatedAt
     FROM peer_devices WHERE anchorId = ? ORDER BY userId ASC`,
    [anchorId],
  );
  return (res.rows as unknown as PeerDeviceDbRow[]).map(r => ({
    ...r,
    updatedAt: Number(r.updatedAt),
    identityKeyPub: r.identityKeyPub ?? '',
    certsJson: r.certsJson ?? '',
  }));
}

// --- persisted signed roster mutations (the permitted re-drive) ---

export interface PendingLinkMutationRow {
  offerNonce: string;
  op: 'unlink' | 'revoke';
  /** The EXACT signed request body as sent — the byte-identical re-drive's
   * whole point; never rebuilt, never re-signed. */
  bodyJson: string;
  createdAt: number;
  expiresAt: number;
}

export async function savePendingLinkMutation(row: PendingLinkMutationRow): Promise<void> {
  await conn().execute(
    `INSERT OR REPLACE INTO link_pending_mutation (offerNonce, op, bodyJson, createdAt, expiresAt)
     VALUES (?, ?, ?, ?, ?)`,
    [row.offerNonce, row.op, row.bodyJson, row.createdAt, row.expiresAt],
  );
}

export async function listPendingLinkMutations(): Promise<PendingLinkMutationRow[]> {
  const res = await conn().execute(
    `SELECT offerNonce, op, bodyJson, createdAt, expiresAt FROM link_pending_mutation
     ORDER BY createdAt ASC`,
  );
  return (res.rows as unknown as PendingLinkMutationRow[]).map(r => ({
    ...r,
    createdAt: Number(r.createdAt),
    expiresAt: Number(r.expiresAt),
  }));
}

export async function deletePendingLinkMutation(offerNonce: string): Promise<void> {
  await conn().execute(`DELETE FROM link_pending_mutation WHERE offerNonce = ?`, [offerNonce]);
}

// --- sibling machine-peers ---

/** Record which agents a SIBLING device owns, replacing that device's list
 * wholesale — the sync envelope carries the sender's whole current roster,
 * so the replace is the idempotent apply. */
export async function replaceSiblingMachinePeers(
  deviceUserId: string,
  agentIds: readonly string[],
  updatedAt: number,
): Promise<void> {
  const d = conn();
  await d.execute(`DELETE FROM sibling_machine_peers WHERE deviceUserId = ?`, [deviceUserId]);
  for (const agentId of agentIds) {
    await d.execute(
      `INSERT OR REPLACE INTO sibling_machine_peers (agentId, deviceUserId, updatedAt)
       VALUES (?, ?, ?)`,
      [agentId, deviceUserId, updatedAt],
    );
  }
}

/** The agents a sibling device owns, as sibling sync reported them — what a
 * revoke names as `boundAgents`. */
export async function listSiblingAgents(deviceUserId: string): Promise<string[]> {
  const res = await conn().execute(
    `SELECT agentId FROM sibling_machine_peers WHERE deviceUserId = ? ORDER BY agentId ASC`,
    [deviceUserId],
  );
  return (res.rows as unknown as { agentId: string }[]).map(r => r.agentId);
}

// --- account identifier + recovery + per-pair records ---
// --- (one row per identifier CLASS) ---

/** The identifier classes the per-class rows may hold. This module is the ONE place the
 * phone and username kinds are spelled — everything else imports the
 * constants (android.copy.divergences.test.ts and the username plumbing
 * suite hold that: the kind value is data taxonomy, not copy, and only
 * db.ts may carry it). */
export type IdentifierKind = 'email' | 'phone' | 'username';
export const EMAIL_KIND: IdentifierKind = 'email';
export const PHONE_KIND: IdentifierKind = 'phone';
export const USERNAME_KIND: IdentifierKind = 'username';

/** The email identifier as this device knows it (LOCAL truth — the server
 * never echoes addresses). `email`/`verifiedAt` present = attached;
 * `pendingEmail` = a code was requested and not yet proven. The SHAPE is
 * the landed one — it reads/writes the `kind = 'email'` row
 * of the per-class table, so every landed caller is untouched while the
 * phone class lives structurally beside it. */
export interface AccountIdentifierRow {
  email: string | null;
  verifiedAt: number | null;
  /** This device's OWN consent decision — default OFF, structurally. */
  discoverable: boolean;
  pendingEmail: string | null;
  pendingRequestedAt: number | null;
  /** Non-null: this row was written by RECOVERY COMPLETION. The server preserved the account's pre-loss consent —
   * which this device cannot read back (the wire is uniform by design) —
   * so `discoverable` here is a placeholder, not a decision. The owner's
   * first toggle records a real decision and clears this mark. */
  restoredAt: number | null;
  /** The server's own birth stamp of the live email row this device wrote
   * (the state route's `emailSince`, ms on this device's scale, read back
   * right after the attach landed — the proof pass, 2026-10-08): the row is
   * a phantom when the account's live stamp differs from it, exactly. Null
   * or absent: no stamp (an older row, or the read-back did not land), and
   * the clock-skew rule governs instead. */
  since?: number | null;
}

/** One per-class row as the store holds it, raw. */
interface IdentifierClassRow {
  value: string | null;
  verifiedAt: number | null;
  discoverable: number;
  pendingValue: string | null;
  pendingRequestedAt: number | null;
  restoredAt: number | null;
  serverSince: number | null;
}

async function loadIdentifierClassRow(
  kind: IdentifierKind,
): Promise<IdentifierClassRow | null> {
  const res = await conn().execute(
    `SELECT value, verifiedAt, discoverable, pendingValue, pendingRequestedAt, restoredAt, serverSince
     FROM account_identifier WHERE kind = ?`,
    [kind],
  );
  return (res.rows as unknown as IdentifierClassRow[])[0] ?? null;
}

async function saveIdentifierClassRow(
  kind: IdentifierKind,
  row: IdentifierClassRow,
): Promise<void> {
  await conn().execute(
    `INSERT OR REPLACE INTO account_identifier
     (kind, value, verifiedAt, discoverable, pendingValue, pendingRequestedAt, restoredAt, serverSince)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [kind, row.value, row.verifiedAt, row.discoverable, row.pendingValue, row.pendingRequestedAt, row.restoredAt, row.serverSince],
  );
}

export async function loadAccountIdentifier(): Promise<AccountIdentifierRow | null> {
  const row = await loadIdentifierClassRow(EMAIL_KIND);
  if (!row) return null;
  return {
    email: row.value ?? null,
    verifiedAt: row.verifiedAt ?? null,
    discoverable: row.discoverable === 1,
    pendingEmail: row.pendingValue ?? null,
    pendingRequestedAt: row.pendingRequestedAt ?? null,
    restoredAt: row.restoredAt ?? null,
    since: row.serverSince ?? null,
  };
}

export async function saveAccountIdentifier(row: AccountIdentifierRow): Promise<void> {
  await saveIdentifierClassRow(EMAIL_KIND, {
    value: row.email,
    verifiedAt: row.verifiedAt,
    discoverable: row.discoverable ? 1 : 0,
    pendingValue: row.pendingEmail,
    pendingRequestedAt: row.pendingRequestedAt,
    restoredAt: row.restoredAt,
    serverSince: row.since ?? null,
  });
}

/** Clears the EMAIL row only (per-class unlink
 * made local: the phone class's row, consent included, survives an email
 * unlink by construction; single-class behavior is exactly the landed
 * delete-all, since only one row can exist). */
export async function clearAccountIdentifier(): Promise<void> {
  await conn().execute(`DELETE FROM account_identifier WHERE kind = ?`, [EMAIL_KIND]);
}

/** The phone identifier as this device knows it (the email row's
 * structural sibling: its own consent, pending state, and restored mark). */
export interface PhoneIdentifierRow {
  phone: string | null;
  verifiedAt: number | null;
  /** This device's OWN consent decision for the PHONE class — default OFF,
   * structurally, and never moved by the email toggle. */
  discoverable: boolean;
  pendingPhone: string | null;
  pendingRequestedAt: number | null;
  /** Non-null: written by RECOVERY COMPLETION (the restored-placeholder
   * shape, per class) — `discoverable` is a placeholder until the owner's own
   * toggle settles it. */
  restoredAt: number | null;
}

export async function loadPhoneIdentifier(): Promise<PhoneIdentifierRow | null> {
  const row = await loadIdentifierClassRow(PHONE_KIND);
  if (!row) return null;
  return {
    phone: row.value ?? null,
    verifiedAt: row.verifiedAt ?? null,
    discoverable: row.discoverable === 1,
    pendingPhone: row.pendingValue ?? null,
    pendingRequestedAt: row.pendingRequestedAt ?? null,
    restoredAt: row.restoredAt ?? null,
  };
}

export async function savePhoneIdentifier(row: PhoneIdentifierRow): Promise<void> {
  await saveIdentifierClassRow(PHONE_KIND, {
    value: row.phone,
    verifiedAt: row.verifiedAt,
    discoverable: row.discoverable ? 1 : 0,
    pendingValue: row.pendingPhone,
    pendingRequestedAt: row.pendingRequestedAt,
    restoredAt: row.restoredAt,
    // The phone class is dark; no stamp is read back for it yet.
    serverSince: null,
  });
}

/** Clears the PHONE row only — the mirror of `clearAccountIdentifier`. */
export async function clearPhoneIdentifier(): Promise<void> {
  await conn().execute(`DELETE FROM account_identifier WHERE kind = ?`, [PHONE_KIND]);
}

/**
 * The username as this device knows it (the
 * per-class row, kind = 'username'): LOCAL truth, because the server
 * stores a keyed hash and never echoes a name. `value` is
 * the NORMALIZED handle the claim committed under; `claimedAt` rides the
 * row's `verifiedAt` column (a claim is the class's whole proof — there is
 * no code to prove, so `pendingValue`/`pendingRequestedAt` stay NULL and
 * `restoredAt` is unused: recovery never writes this class).
 * `discoverable` is this device's OWN record of the consent bit the claim
 * (or a later toggle) sent — the consent checkbox's decision, per class,
 * never moved by the email or phone toggles.
 */
export interface UsernameIdentifierRow {
  username: string;
  claimedAt: number;
  discoverable: boolean;
  /** The server's own birth stamp of the live username row this device
   * wrote (the state route's `usernameSince`, ms, read back right after the
   * claim or rename landed — the proof pass, 2026-10-08): the row is a
   * phantom when the account's live stamp differs from it, exactly. Null or
   * absent: no stamp, and the clock-skew rule governs. */
  since?: number | null;
}

export async function loadUsernameIdentifier(): Promise<UsernameIdentifierRow | null> {
  const row = await loadIdentifierClassRow(USERNAME_KIND);
  if (!row || row.value === null || row.verifiedAt === null) return null;
  return {
    username: row.value,
    claimedAt: row.verifiedAt,
    discoverable: row.discoverable === 1,
    since: row.serverSince ?? null,
  };
}

export async function saveUsernameIdentifier(row: UsernameIdentifierRow): Promise<void> {
  await saveIdentifierClassRow(USERNAME_KIND, {
    value: row.username,
    verifiedAt: row.claimedAt,
    discoverable: row.discoverable ? 1 : 0,
    pendingValue: null,
    pendingRequestedAt: null,
    restoredAt: null,
    serverSince: row.since ?? null,
  });
}

/** Clears the USERNAME row only — unlink, rename-away, or a revocation
 * notice; the email and phone rows survive by construction. */
export async function clearUsernameIdentifier(): Promise<void> {
  await conn().execute(`DELETE FROM account_identifier WHERE kind = ?`, [USERNAME_KIND]);
}

/** A recovery this device started: pending until completed/abandoned.
 * `kind` is the class of the identifier that proved the code;
 * `value` is that identifier as this device typed-and-normalized it —
 * restoration is TYPED off this pair. */
export interface LocalRecoveryRow {
  kind: IdentifierKind;
  value: string;
  groupId: string;
  completesAt: number;
  verifiedAt: number;
}

export async function loadLocalRecovery(): Promise<LocalRecoveryRow | null> {
  const res = await conn().execute(
    `SELECT kind, value, groupId, completesAt, verifiedAt FROM recovery_local WHERE key = 'recovery'`,
  );
  const row = (res.rows as unknown as LocalRecoveryRow[])[0];
  return row
    ? {
        kind: row.kind,
        value: row.value,
        groupId: row.groupId,
        completesAt: row.completesAt,
        verifiedAt: row.verifiedAt,
      }
    : null;
}

export async function saveLocalRecovery(row: LocalRecoveryRow): Promise<void> {
  await conn().execute(
    `INSERT OR REPLACE INTO recovery_local (key, kind, value, groupId, completesAt, verifiedAt)
     VALUES ('recovery', ?, ?, ?, ?, ?)`,
    [row.kind, row.value, row.groupId, row.completesAt, row.verifiedAt],
  );
}

export async function clearLocalRecovery(): Promise<void> {
  await conn().execute(`DELETE FROM recovery_local`);
}

/** The latest recovery notice a MEMBER device received (the design loudness). */
export interface RecoveryNoticeRow {
  kind: 'requested' | 'completed' | 'cancelled';
  groupId: string;
  class: string | null;
  completesAt: number | null;
  receivedAt: number;
}

export async function saveRecoveryNotice(row: RecoveryNoticeRow): Promise<void> {
  await conn().execute(
    `INSERT OR REPLACE INTO recovery_notice (key, kind, groupId, class, completesAt, receivedAt)
     VALUES ('notice', ?, ?, ?, ?, ?)`,
    [row.kind, row.groupId, row.class, row.completesAt, row.receivedAt],
  );
}

export async function loadRecoveryNotice(): Promise<RecoveryNoticeRow | null> {
  const res = await conn().execute(
    `SELECT kind, groupId, class, completesAt, receivedAt FROM recovery_notice WHERE key = 'notice'`,
  );
  const row = (res.rows as unknown as RecoveryNoticeRow[])[0];
  return row
    ? {
        kind: row.kind,
        groupId: row.groupId,
        class: row.class ?? null,
        completesAt: row.completesAt ?? null,
        receivedAt: row.receivedAt,
      }
    : null;
}

export async function clearRecoveryNotice(): Promise<void> {
  await conn().execute(`DELETE FROM recovery_notice`);
}

/** The operator revocation of this account's username as this device
 * received it: the notice is kind-only on the
 * wire, so the row holds only WHEN it arrived. */
export interface UsernameNoticeRow {
  receivedAt: number;
}

export async function saveUsernameNotice(row: UsernameNoticeRow): Promise<void> {
  await conn().execute(
    `INSERT OR REPLACE INTO username_notice (key, receivedAt) VALUES ('notice', ?)`,
    [row.receivedAt],
  );
}

export async function loadUsernameNotice(): Promise<UsernameNoticeRow | null> {
  const res = await conn().execute(
    `SELECT receivedAt FROM username_notice WHERE key = 'notice'`,
  );
  const row = (res.rows as unknown as UsernameNoticeRow[])[0];
  return row ? { receivedAt: row.receivedAt } : null;
}

export async function clearUsernameNotice(): Promise<void> {
  await conn().execute(`DELETE FROM username_notice`);
}

/** The unlink THIS device performed: the
 * name and the moment, so the claim form that follows can say — before the
 * tap — that a DIFFERENT name waits 30 days and this one comes straight
 * back. Written by the module on a landed unlink, cleared by the next
 * landed claim; the SERVER's clock is the gate, this is the device's memory. */
export interface UsernameUnlinkRow {
  username: string;
  unlinkedAt: number;
}

export async function saveUsernameUnlink(row: UsernameUnlinkRow): Promise<void> {
  await conn().execute(
    `INSERT OR REPLACE INTO username_unlink (key, username, unlinkedAt) VALUES ('unlink', ?, ?)`,
    [row.username, row.unlinkedAt],
  );
}

export async function loadUsernameUnlink(): Promise<UsernameUnlinkRow | null> {
  const res = await conn().execute(
    `SELECT username, unlinkedAt FROM username_unlink WHERE key = 'unlink'`,
  );
  const row = (res.rows as unknown as UsernameUnlinkRow[])[0];
  return row ? { username: row.username, unlinkedAt: Number(row.unlinkedAt) } : null;
}

export async function clearUsernameUnlink(): Promise<void> {
  await conn().execute(`DELETE FROM username_unlink`);
}

/** The end of the username cool-down this device started (§4.8, U2 —
 * 2026-10-08): stamped by a landed rename AND a landed unlink (the two
 * verbs the server stamps `usernameRenamedAt` on), kept by a take-back,
 * cleared by a claim landing with no window running. `until` is ms on the
 * device's Date.now() scale, like every row here; the SERVER's clock is the
 * gate, this is the device's memory of what it did. */
export interface UsernameCooldownRow {
  until: number;
}

export async function saveUsernameCooldown(row: UsernameCooldownRow): Promise<void> {
  await conn().execute(
    `INSERT OR REPLACE INTO username_cooldown (key, until) VALUES ('cooldown', ?)`,
    [row.until],
  );
}

export async function loadUsernameCooldown(): Promise<UsernameCooldownRow | null> {
  const res = await conn().execute(`SELECT until FROM username_cooldown WHERE key = 'cooldown'`);
  const row = (res.rows as unknown as UsernameCooldownRow[])[0];
  return row ? { until: Number(row.until) } : null;
}

export async function clearUsernameCooldown(): Promise<void> {
  await conn().execute(`DELETE FROM username_cooldown`);
}

/** Per-PAIR verification match record: this device's
 * own stamp for ONE peer device — matched (checkedAt) or mismatched
 * (mismatchAt), mutually exclusive like the chat-level pair's. */
export interface PeerPairSafetyRow {
  checkedAt: number | null;
  mismatchAt: number | null;
}

export async function getPeerPairSafety(userId: string): Promise<PeerPairSafetyRow> {
  const res = await conn().execute(
    `SELECT checkedAt, mismatchAt FROM peer_device_safety WHERE userId = ?`,
    [userId],
  );
  const row = (res.rows as unknown as PeerPairSafetyRow[])[0];
  return row
    ? { checkedAt: row.checkedAt ?? null, mismatchAt: row.mismatchAt ?? null }
    : { checkedAt: null, mismatchAt: null };
}

export async function setPeerPairChecked(userId: string, at: number | null): Promise<void> {
  await conn().execute(
    `INSERT OR REPLACE INTO peer_device_safety (userId, checkedAt, mismatchAt)
     VALUES (?, ?, NULL)`,
    [userId, at],
  );
}

export async function setPeerPairMismatch(userId: string, at: number | null): Promise<void> {
  await conn().execute(
    `INSERT OR REPLACE INTO peer_device_safety (userId, checkedAt, mismatchAt)
     VALUES (?, NULL, ?)`,
    [userId, at],
  );
}

/** Drop one pair's verification record outright:
 * used when the identity behind the pair is RESET — accepting an identity
 * change re-pins a NEW key, and no earlier human comparison can vouch for
 * it (the acceptIdentityChange contract, extended to the pair table). */
export async function clearPeerPairSafety(userId: string): Promise<void> {
  await conn().execute(`DELETE FROM peer_device_safety WHERE userId = ?`, [userId]);
}
