import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { clientDir, stateDir } from './config.js';
import { CliError, EXIT } from './exit.js';
import { capChatHead, enqueueNotification, plainForChat } from './hooks.js';
import { MessageLog, type MessageRecord } from './msglog.js';
import { type Reporter } from './output.js';
import { loadProfile } from './profile.js';
import { tryFileLockAsync, withFileLock } from './lock.js';
import { AuthSession } from './session.js';
import { sendEncrypted } from './send.js';
import { cmdService, type ServiceIo } from './service.js';
import { FileStores, writeFileAtomic } from './stores.js';

/**
 * `review-peer` — the App Review peer.
 *
 * A SIBLING OF ATTEND, NOT A WIDENING OF IT. attend answers only the account's
 * bound owner, and that predicate is a security boundary
 * (`attend.ts:29-37`) — this file never touches it and never imports it. What
 * it does instead is the thing attend must never do: answer ANYBODY.
 *
 * THE ONLY REASON THAT IS SAFE IS THAT THE REPLY IS CANNED. There is no agent
 * behind this module, no child process, no prompt and no model call — the reply
 * is one of a fixed rotation of sentences written by us, chosen by a counter.
 * Why that exclusion is load-bearing rather than a
 * simplification: an answer-anyone attend with a live agent would make every
 * App Review tester an authenticated prompt-injection surface aimed at a
 * process on our host, with the agent's capability array as the entire defence.
 * Fixed text has no such surface, so "no agent" is the property that buys the
 * open predicate, and the two may never be relaxed independently.
 * `review-peer.test.ts` reads this file back and asserts the absence.
 *
 * WHAT IT SHARES WITH ATTEND, deliberately, because these are the parts that
 * were learned the hard way: a cursor file of its own that is advanced as a
 * watermark and NEVER `markRead` (marking read starts the 24-hour body-purge
 * clock and falsifies the operator's unread view); a per-pass turn lock, so a
 * hand-run pass and the supervised unit cannot both answer the same rows; a
 * config file at mode 0600; and a session built fresh inside each pass rather
 * than a long-lived holder, because a holder that spans a token renewal
 * silently reverts profile fields written by other commands (session.ts:203-217
 * carries that whole argument).
 *
 * WHAT IS DIFFERENT, AND WHY. The budget. attend's budget is per ACCOUNT and
 * exists to bound cost; this one is per PEER and exists to bound two things
 * cost has nothing to do with:
 *
 *  1. a responder that answers strangers is a SPAM REFLECTOR unless somebody
 *     bounds what one stranger can make it emit, and
 *  2. the server suppresses notification wakes at 4/min per (sender,recipient)
 *     pair. A reviewer hammering the peer past that would see messages
 *     delivered and silent, and read push as broken — a worse review outcome
 *     than no reply at all. So the ceiling is 3/min, under the suppression
 *     threshold rather than at it.
 *
 * The budget therefore lives on DISK, per peer, and a restart does not reset
 * it: an in-memory counter is not a budget, it is a counter that a crash-loop
 * launders.
 */

/**
 * The rotation that ships. Overridable per account (see `reviewReplies`), but
 * a default exists so the responder is never one missing file away from
 * answering with nothing — an empty rotation on a review peer is silence at the
 * exact moment somebody is deciding whether the product works.
 *
 * The copy is fixed and doing three jobs: say what this is
 * (a small program, so nobody reads it as a person), say the thing the review
 * needs demonstrated (end-to-end encryption, deletion), and point at the
 * staffed window for calls, which this account declines around the clock.
 */
export const REVIEW_PEER_REPLIES: readonly string[] = [
  "Hi — this is Tacendum's review peer, a small program. Everything you send here " +
    'is end-to-end encrypted. Try a photo, a reply, an edit.',
  'Still here. Deleting your account from Settings removes it and its data from the ' +
    'server — this conversation stays on your device only.',
  'For calls: this peer declines automatically outside the staffed window named in the ' +
    'review notes. Inside that window a person answers audio and video at this same ID.',
];

/**
 * The per-peer ceilings. 3/min is the load-bearing one — see the header for the
 * server's 4/min wake suppression, which is the number this must stay under.
 * 30/day bounds the reflector over the long run: a reviewer needs a handful of
 * replies, and anything past thirty in a day is somebody testing what this
 * thing can be aimed at.
 */
export const REVIEW_PEER_PER_MINUTE = 3;
export const REVIEW_PEER_PER_DAY = 30;

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The rotation, as an operator may override it. */
export interface ReviewPeerConfig {
  replies: string[];
}

const configPath = (account: string): string => join(clientDir(account), 'review-peer.json');
const cursorPath = (account: string): string => join(stateDir(account), 'review-peer-cursor.json');
const bucketPath = (account: string): string => join(stateDir(account), 'review-peer-bucket.json');
const bucketLockPath = (account: string): string => join(stateDir(account), 'review-peer-bucket.lock');

/**
 * THE UNIT OF EXCLUSION IS THE PASS, AND ITS SCOPE IS THE ACCOUNT — attend's
 * argument (`attend.ts:588-616`) transplanted, because the shape that made it
 * true there is the shape here too. The cursor advances only as rows are
 * answered, so until a pass finishes, `pendingRows` hands the same rows to
 * anybody else who looks: two passes (the supervised unit plus a hand-run one
 * during setup) would each send the reviewer a reply to the same message. The
 * budget below is serialized separately and correctly, and would count both of
 * those as one apiece — a budget that counts duplicates honestly is still
 * duplicates.
 */
const turnLockPath = (account: string): string => join(stateDir(account), 'review-peer-turn.lock');

/** Long enough to clear the lock's doorway protocol, short enough that
 * declining is instant. A second pass stands down rather than queueing: the
 * pass holding the lock is already answering these rows. */
const TURN_LOCK_WAIT_MS = 1_000;

function loadJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

function ensureStateDir(account: string): void {
  mkdirSync(stateDir(account), { recursive: true, mode: 0o700 });
}

/**
 * THE OUTBOUND FUNNEL, and there is exactly one. Every sentence this module
 * can put on somebody's phone crosses it, the same way attend's does: the
 * markdown flattener and the length cap that every hook body already crosses.
 * The rotation is our own plain prose today and would survive untouched — the
 * funnel is here for the config file, which is an ordinary file on disk that an
 * operator (or a bad merge, or a restored backup) can put anything into.
 */
const funnel = (text: string): string => capChatHead(plainForChat(text));

/**
 * The rotation this account answers with: the config file if it holds usable
 * copy, the shipped default otherwise.
 *
 * FUNNELLED AND FILTERED AT LOAD, not at send. A configured entry that the
 * funnel reduces to nothing (a page of fences, whitespace) would otherwise be
 * sent as an EMPTY message and counted as an answer — attend shipped exactly
 * that bug against its agent's output and had to test the funnel's result
 * rather than its input. Doing it here means the send path holds a
 * non-empty-by-construction string, and a config file whose every entry
 * evaporates falls back to the default instead of muting the peer.
 */
export function reviewReplies(account: string): string[] {
  const cfg = loadJson<ReviewPeerConfig>(configPath(account));
  const usable = Array.isArray(cfg?.replies)
    ? cfg.replies
        .filter((r): r is string => typeof r === 'string')
        .map(funnel)
        .filter(r => r !== '')
    : [];
  return usable.length > 0 ? usable : REVIEW_PEER_REPLIES.map(funnel);
}

/** Writes the rotation at 0600 — the same mode attend's config carries, for
 * the same reason: it is a file a supervised daemon then obeys for months. */
export function saveReviewPeerConfig(account: string, cfg: ReviewPeerConfig): void {
  writeFileAtomic(configPath(account), JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

/**
 * THE PREDICATE. Five conditions, and note which one is NOT here: there is no
 * peer test. That absence is the whole design (see the header), and it is why
 * this function lives in this file and attend's stays in attend's.
 *
 *  - `dir === 'in'`      — our own outbound rows are not messages to answer;
 *  - `tcm '' | 'reply'`  — the two conversational kinds the log accepts;
 *    anything else is a carrier, and carriers cannot reach the spool anyway
 *    (render.ts maySpool) — this is the second fence, not the first;
 *  - `red !== true`      — a redacted row's body is already gone; replying to
 *    the metadata that remains is answering a message nobody can read;
 *  - `text !== ''`       — nothing was said.
 */
export function triggers(row: MessageRecord): boolean {
  return (
    row.dir === 'in' &&
    (row.tcm === '' || row.tcm === 'reply') &&
    row.red !== true &&
    row.text !== ''
  );
}

interface Cursor {
  /** msgId of the last row this responder has finished with. */
  lastId?: string;
  /** Its append timestamp — the recovery key if the row ages out of the log. */
  lastTs?: number;
}

/** Rows after the cursor, in append order. Identical in shape to attend's, and
 * for the same reason: the CURSOR decides what has been answered, never the
 * transport and never the read flag. */
export function pendingRows(account: string): MessageRecord[] {
  const cursor = loadJson<Cursor>(cursorPath(account)) ?? {};
  const rows = new MessageLog(account).read({ dir: 'in' }).reverse(); // append order
  let start = 0;
  if (cursor.lastId !== undefined) {
    const at = rows.findIndex(r => r.id === cursor.lastId);
    if (at >= 0) start = at + 1;
    else if (cursor.lastTs !== undefined) start = rows.findIndex(r => r.ts > (cursor.lastTs as number));
    if (start < 0) start = rows.length;
  }
  return rows.slice(start).filter(triggers);
}

/** Advance the watermark. NEVER `markRead`: that starts the retention clock
 * and empties the operator's unread view, which is somebody else's signal. */
function advanceTo(account: string, row: MessageRecord): void {
  ensureStateDir(account);
  writeFileAtomic(
    cursorPath(account),
    JSON.stringify({ lastId: row.id, lastTs: row.ts } satisfies Cursor),
    { mode: 0o600 },
  );
}

/**
 * What one peer has been given, and what it gets next.
 *
 * `stamps` IS A ROLLING WINDOW, NOT A RESET COUNTER, and that is the one place
 * this budget deliberately differs from attend's hourly bucket. A fixed window
 * that resets lets a peer take its whole minute allowance at the end of one
 * window and its whole allowance again at the start of the next — six replies
 * inside one 60-second span, which is exactly what the 3/min number exists to
 * stay under (the server's 4/min wake suppression does not care where our
 * window boundaries fall). Keeping the timestamps and counting backwards makes
 * the guarantee the one that was promised: at most three in ANY trailing
 * minute, at most thirty in ANY trailing day.
 *
 * Thirty stamps is also the natural bound on the array — the day cap makes a
 * thirty-first stamp unreachable while the oldest is still inside the day — so
 * the file cannot grow with traffic, only with the number of distinct peers,
 * and peers with nothing inside the day are dropped on every write.
 *
 * `next` is the rotation cursor, and it is PER PEER: each reviewer starts at
 * the first sentence, which is the one that says what this is. It rides in the
 * same record as the stamps because both are facts about one peer written under
 * one lock — a second file would be a second lock order to get wrong.
 */
interface PeerRecord {
  stamps: number[];
  next: number;
}

interface BucketFile {
  peers: Record<string, PeerRecord>;
}

/**
 * Take one reply token for `peer` and, in the same step, claim the rotation
 * slot it will use. Returns the index, or null when the peer is at a cap.
 *
 * UNDER THE BUCKET LOCK, because read-modify-write on a shared counter is the
 * oldest race there is and this counter is the only thing standing between a
 * canned responder and a spam reflector. Taking the token and advancing the
 * rotation together is deliberate: two operations on one record, one lock, no
 * window in which a token exists without a slot.
 *
 * NOTHING IS WRITTEN ON REFUSAL. A peer at its cap must not be able to keep its
 * own window alive by knocking — a refusal that recorded a stamp would extend
 * the block for as long as the flood lasted, which turns a rate limit into a
 * ban administered by the flooder.
 */
export function takeReplyToken(account: string, peer: string, now: number): number | null {
  ensureStateDir(account);
  return withFileLock(bucketLockPath(account), () => {
    const file = loadJson<BucketFile>(bucketPath(account)) ?? { peers: {} };
    const peers = typeof file.peers === 'object' && file.peers !== null ? file.peers : {};
    const raw = peers[peer];
    const stamps = (Array.isArray(raw?.stamps) ? raw.stamps : [])
      .filter((t): t is number => typeof t === 'number' && Number.isFinite(t))
      // A stamp in the FUTURE is dropped rather than trusted: a clock that
      // jumped backwards (or a file copied from another machine) would
      // otherwise hold the peer at its cap until real time caught up.
      .filter(t => t > now - DAY_MS && t <= now);
    const next = Number.isInteger(raw?.next) && (raw?.next as number) >= 0 ? (raw?.next as number) : 0;
    if (stamps.length >= REVIEW_PEER_PER_DAY) return null;
    if (stamps.filter(t => t > now - MINUTE_MS).length >= REVIEW_PEER_PER_MINUTE) return null;

    const kept: Record<string, PeerRecord> = {};
    for (const [id, rec] of Object.entries(peers)) {
      const live = (Array.isArray(rec?.stamps) ? rec.stamps : []).filter(
        (t): t is number => typeof t === 'number' && t > now - DAY_MS && t <= now,
      );
      if (id !== peer && live.length > 0) kept[id] = { stamps: live, next: rec.next ?? 0 };
    }
    kept[peer] = { stamps: [...stamps, now], next: next + 1 };
    writeFileAtomic(bucketPath(account), JSON.stringify({ peers: kept } satisfies BucketFile), {
      mode: 0o600,
    });
    return next;
  });
}

/** The reply seam. `to` is a PARAMETER, and that is the difference from
 * attend's seam in one line: attend replies to the account's owner and nobody
 * else, this replies to whoever wrote — so the recipient is decided per row,
 * from the row, and a test can see which. */
export interface ReviewPeerIo {
  sendReply?: (to: string, body: string) => Promise<void>;
  now?: () => number;
}

/** What one pass did. */
export type ReviewPeerOutcome =
  /** Nothing pending. */
  | 'idle'
  /** At least one reply went out. */
  | 'replied'
  /** Rows were pending and every one of them was over its peer's budget. */
  | 'throttled'
  /** Another pass holds this account's lock; this one stood down. */
  | 'busy';

/**
 * The account class refusal, marked on the error rather than left to be
 * recognised by its prose — the same reason attend carries codes on its two
 * terminal errors: a lock refusal is also a `CliError` with `EXIT.ERROR`, so
 * neither the class nor the exit code separates them.
 */
const TERMINAL_INTEGRATION_CLASS = 'review_peer_integration_class';

/**
 * THE ONE SENTENCE for the integration-class refusal, shared by the pass
 * (`reviewPeerOnce`) and the unit installer (`cmdReviewPeerService`) so the
 * two can never describe the same dead end differently. It is one state in
 * both places: an account no reviewer can reach, on which the responder's
 * loop dies before its first pass — installed, that is a unit relaunching
 * into the same refusal once a minute, forever.
 */
const INTEGRATION_CLASS_REFUSAL =
  'the review peer must run on a HUMAN-class account — this one was registered as an ' +
  'integration, and the server refuses frames between an integration and anyone but its ' +
  'bound owner, so a reviewer could never reach it. Register a separate human-class ' +
  'account for the peer';

/**
 * ONE PASS. Refuse an integration account, gather pending rows, reply to each
 * within its peer's budget, advance the watermark.
 *
 * WHY THE CLASS CHECK IS FIRST AND LOUD. The server 403s frames between a
 * stranger and an integration-class account in BOTH directions
 * (`ws.ts:757-790`), and the binding is write-once — so a review peer
 * registered as an integration cannot be reached by a reviewer at all, and
 * cannot be converted into one that can. Left unchecked, the failure surfaces
 * as a peer that receives nothing and answers nothing, which looks exactly like
 * a dead process; the reviewer's message just vanishes. Refusing here, by name,
 * turns a silent dead end into one sentence naming the one fix.
 */
export async function reviewPeerOnce(
  account: string,
  io: ReviewPeerIo = {},
): Promise<ReviewPeerOutcome> {
  const profile = loadProfile(account);
  if (profile.accountClass === 'integration') {
    throw new CliError(EXIT.ERROR, INTEGRATION_CLASS_REFUSAL, undefined, TERMINAL_INTEGRATION_CLASS);
  }
  const now = io.now?.() ?? Date.now();
  const replies = reviewReplies(account);
  const got = await tryFileLockAsync(
    turnLockPath(account),
    () => reviewPass(account, replies, now, io),
    TURN_LOCK_WAIT_MS,
  );
  return got.held ? got.value : 'busy';
}

/** The pass itself. Called only with the account's pass lock held. */
async function reviewPass(
  account: string,
  replies: string[],
  now: number,
  io: ReviewPeerIo,
): Promise<ReviewPeerOutcome> {
  const batch = pendingRows(account);
  if (batch.length === 0) return 'idle';
  const send = io.sendReply ?? ((to: string, body: string) => realSendReply(account, to, body));

  let replied = false;
  let throttled = false;
  for (const row of batch) {
    const slot = takeReplyToken(account, row.peer, now);
    if (slot === null) {
      // SILENTLY, AND THE CURSOR STILL MOVES. Two decisions in one line.
      // No "you are rate limited" reply, because a responder that answers
      // every message with something is a reflector whichever sentence it
      // picks — the cap has to cost the flooder replies, not change their
      // wording. And the watermark advances anyway, because holding the rows
      // back would replay the entire flood the moment the window reopened,
      // which is the same reflector one minute later.
      throttled = true;
      advanceTo(account, row);
      continue;
    }
    // `replies` is non-empty by construction (`reviewReplies` falls back to the
    // shipped rotation) and already funnelled, so this indexes a real,
    // non-empty string.
    await send(row.peer, replies[slot % replies.length] as string);
    replied = true;
    advanceTo(account, row);
  }
  return replied ? 'replied' : throttled ? 'throttled' : 'idle';
}

/**
 * THE REAL REPLY TRANSPORT — the same funnel attend's `realSendReply` uses, one
 * message at a time, and the notify queue as the retry of last resort.
 *
 * The session is built HERE, per reply, and not held across passes. session.ts
 * (203-217) records what a long-lived holder costs: it snapshots the profile at
 * construction and a token renewal re-saves that snapshot whole, reverting
 * fields other commands wrote in the meantime. A supervised responder is
 * precisely the process that would hold one for weeks.
 */
export async function realSendReply(account: string, to: string, body: string): Promise<void> {
  const stores = new FileStores(account);
  const auth = new AuthSession(account, stores);
  try {
    await sendEncrypted({ stores, auth, to, body });
  } catch {
    enqueueNotification(account, to, body);
  }
}

/**
 * Is this the loop's own death, or somebody else's bad afternoon?
 *
 * attend's inversion, kept: the DEFAULT is transient. Every lock refusal in this
 * package is a `CliError` with `EXIT.ERROR` — the ratchet lock a sibling `send`
 * holds for a few hundred milliseconds included — and a supervised responder
 * that kills itself over contention is a responder that is silently not running
 * at the exact hour a reviewer opens the app. Only the account-class refusal is
 * terminal, because no amount of waiting fixes it.
 */
function isTerminal(err: unknown): boolean {
  return err instanceof CliError && err.code === TERMINAL_INTEGRATION_CLASS;
}

/**
 * The daemon loop the unit runs. A 2-second poll over a local jsonl, same as
 * attend's: imperceptible to a reviewer and with no missed-event mode to debug
 * at 2am, which matters more here than anywhere — this process is the product
 * for somebody who has never seen it before.
 */
export async function reviewPeerLoop(
  account: string,
  report: Reporter,
  io: ReviewPeerIo = {},
): Promise<never> {
  report.status('answering as the review peer…');
  for (;;) {
    try {
      await reviewPeerOnce(account, io);
    } catch (err) {
      if (isTerminal(err)) throw err;
    }
    await new Promise(res => setTimeout(res, 2000));
  }
}

/**
 * `review-peer service install|uninstall|status <account>` — the supervised
 * unit for the responder, on the same machinery as attend's
 * (`cmdAttendService`), sharing its whole discipline: discarded stdout, the
 * 60-second restart throttle, the atomic unit write.
 *
 * ONE difference, and it is WHICH state install refuses. attend refuses an
 * account with no attend CONFIG, because that is the state in which its
 * unit's program dies immediately — a crash-loop pinned at the throttle
 * floor that launchd never explains. The review peer has no `enable` and
 * needs no config (`reviewReplies` falls back to the shipped rotation), so a
 * config-presence check here would refuse NOTHING. The state in which THIS
 * unit's program dies immediately is the integration-class account:
 * `reviewPeerOnce` throws its refusal before the first pass, the loop ends,
 * and the supervisor relaunches it into the same refusal once a minute. So
 * install refuses the account class, with the same sentence the loop would
 * have died of — one fact, told once, at the moment the operator can still
 * act on it.
 */
export function cmdReviewPeerService(
  sub: string,
  account: string | null,
  report: Reporter,
  io: ServiceIo = {},
): void {
  if (
    sub === 'install' &&
    account !== null &&
    loadProfile(account).accountClass === 'integration'
  ) {
    throw new CliError(EXIT.ERROR, INTEGRATION_CLASS_REFUSAL);
  }
  cmdService(sub, account, report, io, 'review-peer');
}
