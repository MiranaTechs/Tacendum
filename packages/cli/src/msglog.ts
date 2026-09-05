import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  ftruncateSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { ATOMIC_TMP_SUFFIX_RE } from './atomic-write.js';
import { stateDir, tacendumHome } from './config.js';
import { CliError, EXIT } from './exit.js';
import { withFileLock } from './lock.js';

/**
 * The durable message log.
 *
 * `listen` used to be the only way to receive: a process holding a socket
 * open, printing to a stdout that scrolls away. Anything sent while it was
 * not running redelivered for 30 days and then vanished. MCP is
 * request/response — `read_messages` needs something on disk to read — and a
 * human's `inbox` needs the same thing, so this file is where consumed
 * messages land, appended by the one inbound policy (`attachInbound`) BEFORE
 * the ack that deletes the server's only copy.
 *
 * **THIS IS DECRYPTED PLAINTEXT AT REST**, and the tradeoff is stated rather
 * than implied. The identity private key on this machine can already
 * impersonate the account outright, so a stolen disk was never a partial
 * compromise; what the log changes is how much of that disk is LEGIBLE
 * without replaying the account. Every rule below exists to keep that
 * legibility small, brief, and owner-only:
 *
 *  - **A separate compartment.** The spool lives under
 *    `$TACENDUM_HOME/state/<name>/`, NOT beside `identity.json` — chat
 *    history and key material must be copyable, backed up, and destroyed
 *    independently (see `stateDir` in config.ts). Operators who want less at
 *    rest point `TACENDUM_HOME` at an encrypted volume and exclude `state/`
 *    from backup and sync tooling; nothing under it is needed to keep the
 *    account.
 *  - **Store less.** Only conversational text (`tcm` '' and `reply`) is ever
 *    persisted. Vault titles and bodies, attachment ids and keys, carrier
 *    payloads, call signalling, server error text: none of it is written,
 *    because `render.ts` already withholds those from the terminal and a
 *    file remembers longer than a terminal does. Room rows (`grp.msg`, and
 *    only they) additionally carry three pieces of ULID/flag-class metadata
 *    under this same posture — `grp` (the room id), the `men` mentions-self
 *    flag, and the `ai` AI-origin marker (this author spoke AI-marked here) —
 *    because the room trigger predicate and the send-path agent exclusion read
 *    structure, never text:
 *    none is content, and all age out with the row exactly as every other
 *    field does — INCLUDING across redaction, which purges only the body and
 *    keeps this metadata to the 30-day ceiling (a redacted AI-marked row must
 *    stay in the agent-exclusion set, or the agent silently rejoins fan-out).
 *  - **Retention, not append-forever.** Nothing outlives the 30-day server
 *    queue TTL the log mirrors. Once a record is consumed (marked read by
 *    `inbox`), its BODY is purged on the first retention pass at least 24
 *    hours later — sooner with `inbox --purge` — leaving only redacted
 *    metadata (id, direction, peer, timestamp, byte count), and even that
 *    ages out at 30 days. Retention runs at every `listen`, `sync` and
 *    `inbox` invocation, so any account that is actually used converges on
 *    the policy without a daemon.
 *  - **Fail closed on a suspicious spool.** Mode bits only govern CREATION,
 *    so every open re-validates: the file must be a regular file, not a
 *    symlink, with one hard link and no group/other bits, and its directory
 *    the same — otherwise the CLI refuses with the remedy, rather than
 *    appending plaintext into a file something else can read or has
 *    substituted.
 *  - **One writer at a time.** Appends, read-marks and retention rewrites
 *    take the per-account lock — the SHARED one in lock.ts, because a
 *    retention rewrite (write temp, rename over) racing an append would
 *    silently drop the appended record, and this file's original private
 *    rm-based lock could be "recovered" out from under a stalled-but-alive
 *    retention pass, whose resumed rename then erased an append the server
 *    had already been acked for. Partial lines are still
 *    possible (a crash mid-write is not a transaction): `read()` skips any
 *    line that does not parse — only the final line can be damaged this way
 *    — and the next `append` repairs the tail before writing: a tail that
 *    PARSES is a complete record that lost only its newline and is finished
 *    in place, an unparseable fragment is truncated back to the last record
 *    boundary, and the next retention rewrite drops a survivor for good.
 *
 * Layout, under `$TACENDUM_HOME/state/<name>/` (0700):
 *   messages.jsonl        one record per line, oldest first, 0600
 *   messages-read.json    { msgId: readAtMs } — the mutable half, split out
 *                         because a log cannot flip a bit in place
 *   messages.lock         the single-writer lock (pid:token inside; lock.ts)
 *
 * There is deliberately NO on-disk "this namespace is already durable"
 * marker. An earlier revision kept one (`messages.dirsync`) so the ancestor-directory
 * walk was paid once per spool lifetime; an earlier revision showed that no FILE can
 * carry that fact, because a file is exactly the thing that gets copied.
 * Restore a home holding both `messages.jsonl` and the marker into a freshly
 * created directory tree — `cp -r`, a backup restore, a container image — and
 * the marker asserts durability for the OLD namespace's directory entries,
 * none of which exist here. The first append believed it, skipped the walk,
 * returned, and the caller acked away the server's only copy of a message
 * whose entire subtree could still evaporate on power loss. The proof is now
 * an in-memory flag (`dirWalkDone`) that a copy cannot carry: every process
 * pays the walk once, on its first append. `append()` deletes a stale marker
 * left by an older build so nobody reads it as evidence again.
 */

/** Nothing in the spool outlives the server queue TTL it mirrors (30 days). */
export const RETAIN_MS = 30 * 24 * 60 * 60 * 1000;

/** A consumed body survives at most this long past its read mark. */
export const REDACT_AFTER_MS = 24 * 60 * 60 * 1000;

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
/** Group/other bits; any of these on the spool or its directory is a refusal. */
const WORLD_BITS = 0o077;

export interface MessageRecord {
  /** The wire msgId, a ULID — also the dedupe key `seen.json` already uses. */
  id: string;
  /** 'in' is the only direction written today; the field exists so outbound
   * logging can join later without a second record shape. */
  dir: 'in' | 'out';
  /** The peer's userId, exactly as the frame carried it. Sanitized at DISPLAY
   * time, not here — the raw id is what sessions and pins are keyed by. */
  peer: string;
  /** Server receipt time, milliseconds — the one clock both ends share. */
  ts: number;
  /** The declared envelope kind: '' for plain text, 'reply' for replies. The
   * only two kinds this log accepts. */
  tcm: string;
  /** A `--title` summary line. Outbound-only by construction (inbound bodies
   * carry no structured title), reserved with the `dir` field. */
  title?: string;
  /** The RENDERED body — what `render.ts` decided this message looks like.
   * Empty once redacted. */
  text: string;
  /** State at append time. `read()` merges the read sidecar over this. */
  read: boolean;
  /** UTF-8 size of the purged body. Present only on redacted records. */
  bytes?: number;
  /** True once the body has been purged under the retention policy. */
  red?: boolean;
  /** For a reply: the msgId it answers, exactly as the wire carried it
   * (the phone's long-press reply returns the msgId
   * the notify path minted, and this is where it stops dying). */
  ref?: string;
  /** For a reply: true iff the QUOTED message was authored by the replier. */
  ofs?: boolean;
  /** For dir:'out' LEDGER rows (the reserved outbound shape, now written):
   * which host session this send belongs to. `key` is the host's own
   * session id where one exists (claude/gemini session_id, cursor
   * conversation_id); `tag` is the short human tag the title carried. */
  sess?: { host: string; key?: string; tag?: string };
  /** grp.msg rows ONLY: the room id. On dir:'in' rows it is what
   * the room trigger predicate routes by; on attend's dir:'out' room-reply
   * ledger rows (keyed `${selfUserId}.${m}`, the compound row key) it is what
   * reply-to-continue joins against — the SAME-grp clause. */
  grp?: string;
  /** grp.msg rows ONLY: the structured mention envelope's who[]
   * named this account. Written only when true; rendered text never sets it
   * (a plain-text "@name" must never read as a mention — deliberate rule). */
  men?: boolean;
  /** grp.msg rows ONLY: the inbound `grp.msg` WRAPPER carried the
   * Art. 50 AI-origin marker, so THIS author speaks AI-marked in this room.
   * Written only when true. It is the CLI's MARKER-RECORD half of the app's
   * `listRoomAgentAuthorIds` (`roomAiAuthorIds` below is its one reader);
   * since the roster-class upgrade the OTHER half is the room
   * fold's `classes` — the owner's authoritative roster write — so an agent
   * never heard AI-marked is no longer invisible where its owner classed
   * it. The room send path reads the union back to drop an unaddressed
   * agent's leg. */
  ai?: boolean;
  /** grp.msg rows ONLY: the room message id (`env.m`), the
   * SECOND half of the §5.3 compound row key `${peer}.${rm}` every member of
   * the room derives for this message. `id` above is the wire msgId of THIS
   * account's own leg, which differs per member by construction (rule 19), so
   * it is not the room-wide key and cannot stand in for one — without `rm` the
   * rounds composer cannot build the reply `ref` that joins an answer to the
   * human turn it answers, and cannot key the once-per-round guard.
   *
   * Routing metadata of the `grp`/`men`/`ai` class, never body: a ULID this
   * client rendered off an authenticated frame. It SURVIVES redaction with
   * them (see `applyRetention`) — a detail, which is body, would not. */
  rm?: string;
  /**
   * `msg` and `reply` rows: the DETAIL the sender wrote
   * beside this row's brief. `text` stays the brief on every surface; this is
   * the rest of the same message, by the same author, in the same frame.
   *
   * BODY, NOT METADATA, and that distinction is the whole of R16: `grp`,
   * `men`, `ai` and `rm` are ULID/flag-class routing this client derived from
   * an authenticated frame, and they ride through redaction because losing
   * them silently changes routing. A detail is prose a peer wrote — the exact
   * class of thing `applyRetention` exists to purge — so it is DROPPED there
   * with `text`, and the drop is pinned by a test rather than left to a
   * reviewer noticing an absent line.
   *
   * `bytes` on a redacted row keeps meaning "the size of the delivered body",
   * i.e. `text` alone; see `applyRetention`.
   */
  detail?: string;
}

export interface ReadOptions {
  /** Only records from this peer userId. */
  peer?: string | undefined;
  /** Only records not yet marked read. */
  unread?: boolean | undefined;
  /** Newest-first cap; 0 or absent means everything. */
  limit?: number | undefined;
  /** Only records in this direction ('in' = what peers said, 'out' = the
   * outbound ledger). Absent means both — the retention pass must sweep
   * every row, whichever way it went. */
  dir?: 'in' | 'out' | undefined;
}

export interface RetentionOutcome {
  /** Records removed entirely (older than RETAIN_MS, or unparseable). */
  dropped: number;
  /** Records whose body was purged to metadata this pass. */
  redacted: number;
}

function refuse(path: string, why: string, remedy: string): never {
  throw new CliError(
    EXIT.ERROR,
    `refusing to use the message log: ${path} ${why}. ${remedy}. ` +
      `Failing closed, because this file holds decrypted messages`,
  );
}

/** The open-time validation the mode-on-create cannot provide. */
function assertPrivateFile(fd: number, path: string): void {
  const st = fstatSync(fd);
  if (!st.isFile()) refuse(path, 'is not a regular file', 'remove it and retry');
  if (st.nlink !== 1) {
    refuse(path, `has ${st.nlink} hard links`, 'something else holds a link to it; remove it and retry');
  }
  if ((st.mode & WORLD_BITS) !== 0) {
    refuse(path, `is group/world accessible (0${(st.mode & 0o777).toString(8)})`, `run: chmod 600 ${path}`);
  }
}

function assertPrivateDir(path: string): void {
  const st = lstatSync(path);
  if (st.isSymbolicLink()) refuse(path, 'is a symlink', 'remove the link and retry');
  if (!st.isDirectory()) refuse(path, 'is not a directory', 'remove it and retry');
  if ((st.mode & WORLD_BITS) !== 0) {
    refuse(path, `is group/world accessible (0${(st.mode & 0o777).toString(8)})`, `run: chmod 700 ${path}`);
  }
}

/**
 * Make a directory ENTRY as durable as the bytes behind it.
 *
 * `fsync` on a file covers its contents, not its name. Power loss after
 * `rename(tmp, messages.jsonl)` but before the DIRECTORY is persisted can
 * bring the old file back — a purge that reported success resurrecting the
 * plaintext it purged — and the same gap lets an acked first append survive
 * as bytes with no directory entry pointing at them.
 *
 * Best-effort ONLY for capability refusals: EINVAL/EPERM/ENOTSUP/EISDIR is
 * the platform saying a directory fsync is not a thing here, and there the
 * rename is already as durable as this filesystem allows, so failing an
 * operation that succeeded would be noise. An earlier revision swallowed EVERY error,
 * which let a real I/O failure (EIO, ENOSPC) report success too — append()
 * returned, the caller ACKed away the server's only copy, and the entry for
 * the acknowledged plaintext was never durable. An earlier revision's fix
 * applied that rule to the FSYNC but left the OPEN a bare catch-all, so the
 * same real failure surfacing one syscall earlier (EIO, EMFILE at the open)
 * still reported success. One rule, both syscalls: a capability
 * refusal returns, everything else propagates.
 */
const DIR_FSYNC_UNSUPPORTED = new Set(['EINVAL', 'EPERM', 'ENOTSUP', 'EISDIR']);

function fsyncDirSync(path: string): void {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // EISDIR: how platforms whose open() cannot take a directory at all say
    // so (libuv on Windows) — the capability refusal, one syscall early.
    if (code !== undefined && DIR_FSYNC_UNSUPPORTED.has(code)) return;
    throw err;
  }
  try {
    fsyncSync(fd);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === undefined || !DIR_FSYNC_UNSUPPORTED.has(code)) throw err;
    // Otherwise: this filesystem cannot sync a directory fd — nothing more
    // durable was ever on offer.
  } finally {
    closeSync(fd);
  }
}

/**
 * Write every byte of `data`, or throw.
 *
 * `writeSync` may return a SHORT count at a quota or device boundary without
 * throwing, so a single call can leave a partial record that a following
 * `fsync` then commits as if it were whole.
 */
function writeAllSync(fd: number, data: Buffer): void {
  let written = 0;
  while (written < data.length) {
    const n = writeSync(fd, data, written, data.length - written);
    if (n <= 0) {
      throw new Error(`write stalled at ${written}/${data.length} bytes`);
    }
    written += n;
  }
}

/**
 * The quarantine spool's filename, defined HERE rather than in `inbound.ts`
 * where it is written. `sweepQuarantineTemps` below has to match the temps
 * that writer mints, and two string literals in two files drift; inbound.ts
 * imports this one. It cannot go the other way — inbound.ts already imports
 * this module, and the cycle would be the price of putting it there.
 */
export const UNDELIVERED_FILE = 'undelivered.jsonl';

/**
 * Did `withFileLock` refuse because somebody else HOLDS the lock?
 *
 * The one failure a sweep is entitled to shrug at, and only that one — see
 * `sweepQuarantineTemps`. `acquire` in lock.ts converts every acquisition
 * failure into a `CliError`, so the class alone cannot separate "held" from
 * "cannot create the lock directory (EACCES)"; only the two contention
 * refusals carry `is held)`. Matching a sentence is unpleasant, but the
 * mismatch direction is the safe one: if lock.ts ever rewords, a contended
 * sweep starts THROWING rather than returning quietly — noisy, and never
 * silent over plaintext, which is the failure this predicate exists to stop.
 */
function isLockContention(err: unknown): boolean {
  return err instanceof CliError && / is held\)\./.test(err.message);
}

export class MessageLog {
  private readonly root: string;
  private readonly logPath: string;
  private readonly readPath: string;
  private readonly lockPath: string;
  /** An earlier artifact this build only ever DELETES — see the file header. */
  private readonly staleDirSyncMarker: string;
  /**
   * Has THIS PROCESS proven the directory entries naming the spool durable?
   *
   * Starts false in every process by construction, which is the whole point:
   * the fact "the ancestor walk succeeded" is a fact about one namespace on
   * one filesystem, and process memory is the only place to keep it that a
   * `cp -r` of the home cannot carry along.
   */
  private dirWalkDone = false;
  /**
   * Every file `messages.lock` governs — the single source both `tempFor` and
   * `sweepStrandedTemps` read, so "what this lock may create a temp for" and
   * "what this lock may delete a stranded temp of" cannot drift apart.
   * NOTHING written under a different lock belongs here: `undelivered.jsonl`
   * lives in the same directory and is the quarantine's, under
   * `undelivered.lock`.
   */
  private readonly ownedTargets: readonly string[];

  constructor(name: string) {
    this.root = stateDir(name);
    this.logPath = join(this.root, 'messages.jsonl');
    this.readPath = join(this.root, 'messages-read.json');
    this.lockPath = join(this.root, 'messages.lock');
    this.staleDirSyncMarker = join(this.root, 'messages.dirsync');
    this.ownedTargets = [this.logPath, this.readPath];
  }

  /** Where the log lives — surfaced so `doctor` and tests can point at it. */
  get path(): string {
    return this.logPath;
  }

  /**
   * The open-time validation, runnable at STARTUP by a long-lived embedder.
   *
   * The MCP server must refuse to serve before its
   * first frame if the spool has been loosened or replaced — deferring to the
   * per-call refusal would mean the host is first told the tools exist and
   * only later, mid-session, that the account's storage is compromised.
   * Validates whatever exists and CREATES NOTHING: a fresh account with no
   * spool yet is healthy, not broken, and a read-only embedder must not mint
   * an empty spool as a side effect (same rule as `ensureDir` being
   * writer-only).
   */
  validate(): void {
    try {
      lstatSync(this.root);
    } catch {
      return; // nothing on disk yet — a spool that does not exist cannot leak
    }
    assertPrivateDir(this.root);
    try {
      lstatSync(this.logPath);
    } catch {
      return; // directory exists (and is private); no log file yet
    }
    // O_NOFOLLOW makes a symlinked spool fail at the open, exactly as the
    // read and append paths would.
    const fd = openSync(this.logPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      assertPrivateFile(fd, this.logPath);
    } finally {
      closeSync(fd);
    }
  }

  /**
   * Create-and-validate the state directory. Called by writers only, so a
   * read-only command on a fresh install does not mint an empty spool as a
   * side effect.
   */
  private ensureDir(): void {
    // The parent (`$TACENDUM_HOME/state/`) is created 0700 too: it exists
    // only to hold spools, so there is no reason any of it is ever wider.
    const madeParent = mkdirSync(dirname(this.root), { recursive: true, mode: DIR_MODE });
    const madeRoot = mkdirSync(this.root, { recursive: true, mode: DIR_MODE });
    // CONSTRAINT: a completed walk proves durability only for the directory
    // entries that existed WHEN IT RAN; minting any of them again voids the
    // proof. Concretely: a long-lived `listen` walks on its first append, an
    // operator (or a test) removes `state/`, the next append recreates the
    // whole chain — and without this reset the process would keep believing
    // it had already synced, so it would ack on entries that were never made
    // durable and power loss would take the recreated subtree with the
    // server's copy already deleted. `mkdirSync(recursive)` returns the first
    // path it created, or undefined when it created nothing, so this asks the
    // filesystem rather than guessing.
    if (madeParent !== undefined || madeRoot !== undefined) this.dirWalkDone = false;
    assertPrivateDir(this.root);
  }

  /**
   * The single-writer lock — the SHARED acquisition rule in lock.ts, not a
   * private copy. This file used to carry its own rm-based stale takeover,
   * which was a TOCTOU with a worse consequence than the ratchet's: retention
   * reads its snapshot, stalls past the threshold (a slept laptop is enough),
   * a listener "recovers" the lock, appends and ACKS a message — and the
   * resumed retention renames its pre-takeover snapshot over the file,
   * permanently erasing the acked record. The shared lock
   * steals by rename (one winner, never a window) and only from a pid that is
   * actually dead, so a stalled-but-alive holder is waited out, never
   * dispossessed. One acquisition rule in the package, so it cannot drift.
   */
  private withLock<T>(fn: () => T): T {
    this.ensureDir();
    return withFileLock(this.lockPath, fn);
  }

  /**
   * Append one record and FSYNC it. The caller acks the server only after
   * this returns: the ack deletes the server's only copy and the ratchet
   * refuses the same ciphertext twice, so "durable before ack" is the whole
   * point of this method existing — an OS-buffered write that a power cut
   * discards is not durable, hence the fsync rather than a bare append.
   */
  append(input: MessageRecord): void {
    // A RECORD THIS SPOOL CANNOT RETIRE MAY NOT ENTER IT. `applyRetention`
    // drops on `now - record.ts >= RETAIN_MS`, so a FUTURE-dated `ts` is never
    // expired: the row, and its plaintext body, live forever in a file whose
    // whole contract is a 30-day ceiling. `MsgFrame.ts` is an unbounded,
    // server-controlled `z.number()`, so the value arrives off the wire.
    //
    // THE CAP IS HERE, not at the callers, because at the callers it diverged
    // — which is this codebase's most repeated defect and was repeated again
    // one commit ago. An earlier fix capped `attachInbound` and set out to make
    // "a future-dated frame cannot seed an immortal row" true; CallSession
    // writes to the SAME spool and was left uncapped, so `listen` capped and
    // `listen --calls` did not. Measured on the mirror: a frame dated
    // now + 1000*RETAIN_MS persisted as the year 2108 and survived an
    // applyRetention run past its nominal expiry (dropped:0, remaining:1).
    // The spool is what implements retention, so the spool enforces what it
    // can retain, and a third caller cannot get this wrong.
    //
    // Only the PERSISTED value is clamped. Callers still hand their own `ts`
    // to anything else they do with the frame, and the server's receipt time
    // is still preferred whenever it is one this clock can have reached.
    // Written as "keep only what is provably retirable" rather than "reject
    // what is future": `input.ts > now` is FALSE for NaN and so would have let
    // a non-finite value through, and `applyRetention`'s own comparison is
    // false for NaN too — the same row, immortal by a different route.
    const now = Date.now();
    const record: MessageRecord =
      Number.isFinite(input.ts) && input.ts <= now ? input : { ...input, ts: now };
    // CONSTRAINT: ONCE THE BODY IS FSYNCED, THIS METHOD RETURNS NORMALLY —
    // whatever fails afterwards. A throw is the only way append() can say
    // "the record is not on disk", and inbound.ts answers that (inbound.ts,
    // `maySpool` branch) by writing the SAME plaintext to
    // `undelivered.jsonl` — and call-session.ts's mirrored inbound path does
    // the identical thing, so there are two callers with this contract, not
    // one. That copy is never redacted — `applyRetention`
    // rewrites `messages.jsonl` and nothing else, so `inbox --purge` redacts
    // the spool and leaves the quarantine — and it lives to the same 30-day
    // ceiling. The operator is told `plaintext preserved at <path> — fix the
    // spool, then recover it from there`, and recovering it is what
    // inbound.ts documents the rows for: `cat undelivered.jsonl >>
    // messages.jsonl`. `loadAll` deduplicates nothing, so the result is the
    // message TWICE under one id, both returned by `read()`.
    //
    // The window this latch closes was known-open at the previous commit and
    // is checkable, not remembered: that commit's own message lists "append() can
    // still throw after the record is durable" under "Known still open",
    // while the comment it shipped in this method claimed the opposite —
    // "THE NAMESPACE IS MADE DURABLE BEFORE ANY PLAINTEXT IS WRITTEN, so
    // nothing that can throw runs after the record's fsync" (this method's
    // own comment at the time). The second clause was false, and
    // the counterexample is one frame out: the locked section returns into
    // `withFileLock`, whose `finally` releases the lock — today a single
    // `rmSync(entry, { force: true })` (lock.ts `release`), and `force`
    // swallows ENOENT alone. EACCES from a spool directory an operator
    // chmod'ed, EIO from a failing disk, EPERM from an immutable flag: each
    // is raised strictly AFTER the fsync, propagates out of append(), and
    // buys the second plaintext copy exactly as the walk did.
    //
    // So the latch below does not enumerate what runs after the fsync —
    // enumerating is what keeps being wrong. `durable` is set by an
    // assignment (which cannot throw) on the statement after `fsyncSync`
    // returns, and EVERY failure raised after that point — this file's
    // `closeSync`, the lock release, anything a later change puts between
    // them — reaches the catch below and stops there. It is a local, so it
    // says nothing about any other call. Before the fsync the catch rethrows
    // unchanged, so a failed open, a failed walk, a short write and a failed
    // rollback all still refuse the ack.
    //
    // Both obligations that CAN be met before the fsync are met there rather
    // than demoted: the ancestor walk and the stale-marker unlink both run
    // before a byte of body is written. `closeSync` and the lock release are
    // the only two that cannot — an fsync needs the fd it closes, and the
    // lock exists to serialize the write it is released after — so those two
    // are demoted, and the latch demotes whatever a later edit adds beside
    // them.
    //
    // Stated rather than glossed: this gives up VISIBILITY of a failed
    // release. The entry stays in `messages.lock` carrying this live
    // process's pid and incarnation, which `holderIsAlive` reads as a live
    // holder, so every later acquisition on this account — this process's
    // own included — waits LOCK_WAIT_MS (10s) and then throws. That is loud,
    // and it lands where no record is durable: those later appends fail
    // before writing anything, so their bodies are quarantined as a FIRST
    // copy and their rows stay unacked on the server. Losing the lock is
    // recoverable and duplicating plaintext is not.
    let durable = false;
    try {
      this.withLock(() => {
        // CONSTRAINT: every PROCESS pays the directory-entry walk below before
        // its first append authorizes an ack, and the walk stays owed until one
        // has SUCCEEDED (an earlier revision keyed it off "does the file exist yet", so a
        // first append whose walk threw a real EIO still left messages.jsonl
        // behind and every later append skipped the walk — an earlier revision).
        //
        // An earlier revision recorded "a walk succeeded" in a FILE so the cost was paid
        // once per spool lifetime. Restore a home containing both
        // messages.jsonl and that marker into a newly created directory tree —
        // `cp -r`, a backup restore, a fresh container — and the marker is a
        // claim about directory entries that do not exist on this filesystem:
        // append, ack (the server's copy is now deleted), power cut, and the
        // restored spool subtree is gone. `dirWalkDone` is memory, not a file,
        // so the restored home starts owing the walk exactly as a fresh one
        // does. The file-exists disjunct stays for the entry the open below is
        // about to create: a new `messages.jsonl` name is a new directory entry
        // to sync even inside a process that already walked.
        const needsDirWalk = !this.dirWalkDone || !existsSync(this.logPath);
        // O_RDWR rather than O_WRONLY: repairing a crash-damaged tail means
        // reading the end of the file this append is about to land after.
        const fd = openSync(
          this.logPath,
          constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
          FILE_MODE,
        );
        try {
          assertPrivateFile(fd, this.logPath);
          if (needsDirWalk) {
            // CONSTRAINT: THE NAMESPACE IS MADE DURABLE BEFORE ANY PLAINTEXT IS
            // WRITTEN. An earlier revision ran this walk AFTER the record was fsynced and
            // the fd closed, so a walk failure — `openSync(dir, O_DIRECTORY)`
            // returning EMFILE is enough — reported a failed append for a
            // record already durably in the spool, and the method's contract
            // (see the CONSTRAINT on `append` above) turns that into a second,
            // never-redacted plaintext copy. No ack is sent either, so the
            // server redelivers, the ratchet refuses the duplicate, and it is
            // purged as poison: the redelivery buys nothing and the duplicate
            // is permanent.
            //
            // The latch on `append` now catches that class of mistake wherever
            // it is made, but the ORDER is still the primary fix and is what
            // this comment pins: a failure here should refuse the ack, and it
            // can only do that honestly while no body is on disk yet.
            //
            // Both obligations still hold — the record durable AND every
            // directory entry that names it durable — so the ORDER changes, not
            // the set. The O_CREAT above has already minted the
            // `messages.jsonl` entry (which is why the walk cannot precede the
            // open), the walk below persists that entry and every ancestor, and
            // only then does a byte of the body reach the disk. A walk that
            // fails now leaves at most an EMPTY `messages.jsonl` — no plaintext
            // anywhere, `dirWalkDone` still false, so the next append re-owes
            // the walk for the entry this open just made, and the caller's
            // retry is a retry rather than a second copy.
            //
            // `ensureDir`'s recursive mkdir can mint the WHOLE chain on a fresh
            // home — the spool dir, `state/`, even $TACENDUM_HOME itself — and
            // an earlier revision synced only the bottom two, leaving the entry that NAMES
            // `state/` unsynced: power loss after the ack could take the whole
            // subtree while the server copy was already deleted. Each
            // created name lives in its PARENT, so walk up to the parent of
            // $TACENDUM_HOME — the deepest directory this code can never have
            // created — syncing every level; it is a handful of fsyncs, paid
            // once per PROCESS (the cheaper "once per spool lifetime" needed a
            // file to remember it, and a file is the one thing a restore
            // carries into a namespace it does not describe).
            const stop = dirname(tacendumHome());
            for (let dir = this.root; ; dir = dirname(dir)) {
              fsyncDirSync(dir);
              if (dir === stop || dirname(dir) === dir) break;
            }
            // Only now — after every level succeeded, since fsyncDirSync throws
            // on a real I/O failure — is the walk a fact, and only for this
            // process. Nothing is written to disk to remember it.
            this.dirWalkDone = true;
            // Tidy away a legacy marker, which is now a liability rather than
            // an optimization: it asserts durability for whatever namespace it
            // was copied out of, and a future reader must not find one and
            // wonder. Swallowed because it decides nothing: the marker is
            // empty, this build never reads it, and an unremovable inert file
            // must not fail an append that is otherwise entitled to proceed.
            try {
              rmSync(this.staleDirSyncMarker, { force: true });
            } catch {
              // An unremovable inert file changes nothing about this record.
            }
          }
          // writeSync CAN RETURN SHORT — at a quota or device boundary it
          // writes some bytes and returns that count without throwing, so the
          // fsync below would commit a truncated JSON line and the caller would
          // ack the server on the strength of it (an earlier review, F3). The
          // record would then be silently skipped by every later read. Loop
          // until the whole line is down, and fail loudly if it cannot be.
          const line = Buffer.from(`${JSON.stringify(record)}\n`, 'utf8');
          // Repair BEFORE appending: a crash in an EARLIER append (die after
          // the partial write, before rollback) leaves an un-newline-terminated
          // fragment at EOF, and writing after it would glue this record onto
          // the fragment — one unparseable line that gets fsynced and ACKED,
          // then skipped by every read: an acknowledged message lost to a crash
          // that predates it (an earlier review). The repaired size doubles as
          // the rollback point for a short write below, keeping the invariant
          // the readers and their tests rely on: only a whole record is ever
          // in this file.
          const sizeBefore = this.repairTail(fd);
          // THE ROLLBACK COVERS THE FSYNC, NOT JUST THE WRITE. It used to wrap
          // `writeAllSync` alone, so a transient EIO — or a delayed-allocation
          // ENOSPC, which surfaces at fsync rather than at write — left the
          // COMPLETE record sitting in the spool while append() reported
          // failure. Verified by injection: the record was readable, `read()`
          // returned it, and the next append kept it, because repairTail sees
          // a properly terminated line. inbound.ts answers that failure by
          // quarantining the same body to undelivered.jsonl, which retention
          // never redacts, and the documented repair then yields the message
          // twice under one id (an earlier review). Both statements are inside one
          // try so "the caller was told no" and "nothing is on disk" cannot
          // come apart.
          try {
            writeAllSync(fd, line);
            fsyncSync(fd);
          } catch (err) {
            try {
              ftruncateSync(fd, sizeBefore);
              fsyncSync(fd);
            } catch {
              // Truncation itself failed; the throw below is still the right
              // answer — the caller must not ack.
            }
            throw err;
          }
          // THE ONLY PLACE THIS IS SET, and it is the statement after the
          // fsync because that is the instant the caller becomes entitled to
          // ack. An assignment cannot throw, so nothing can fail between the
          // record becoming durable and this being recorded.
          durable = true;
        } finally {
          // Guarded even though the latch above already stops a close failure
          // from reaching the caller: on the NOT-durable paths the latch
          // rethrows whatever error surfaces, and an unguarded `close` failure
          // would surface INSTEAD of the write or walk error that actually
          // refused the ack. The fd is released by the OS either way.
          try {
            closeSync(fd);
          } catch {
            // Nothing here is owed to a durability decision already made.
          }
        }
      });
    } catch (err) {
      // The two halves, spelled out because a future reader has to be able
      // to check them: `durable` false means no body reached the disk (or
      // the short-write rollback took it back off), so the caller must not
      // ack and the error propagates unchanged; `durable` true means the
      // body IS on disk, and the only thing a throw could still buy is the
      // duplicate plaintext copy described at the top of this method.
      if (!durable) throw err;
    }
  }

  /**
   * Repair a crash-damaged tail; returns the size the append rolls back to.
   *
   * A MISSING NEWLINE IS NOT PROOF OF A TORN RECORD. A short write can put
   * every JSON byte down and die one byte early — before the LF — and after
   * restart `read()` parses that last line fine (split does not need the
   * terminator), the record is visible, the server's copy gets redelivered
   * and ACKed away as a duplicate. The bytes here may then be the ONLY
   * plaintext copy. An earlier revision's repair truncated on the newline test alone,
   * so the next append DELETED that complete record. Completeness
   * is therefore decided by PARSING the tail: `JSON.stringify` output only
   * parses when its closing brace — its final byte — is present, so a tail
   * that parses is a whole record missing only its LF (complete it in
   * place); only a tail that does not parse is a fragment no reader could
   * ever use, safe to cut back to the last record boundary.
   */
  private repairTail(fd: number): number {
    const size = fstatSync(fd).size;
    if (size === 0) return 0;
    const last = Buffer.alloc(1);
    readSync(fd, last, 0, 1, size - 1);
    if (last[0] === 0x0a) return size;
    const chunk = Buffer.alloc(8192);
    let end = size;
    let keep = 0; // no newline anywhere: the whole file is the tail
    while (end > 0) {
      const n = Math.min(chunk.length, end);
      readSync(fd, chunk, 0, n, end - n);
      const idx = chunk.subarray(0, n).lastIndexOf(0x0a);
      if (idx >= 0) {
        keep = end - n + idx + 1;
        break;
      }
      end -= n;
    }
    const tail = Buffer.alloc(size - keep);
    let got = 0;
    while (got < tail.length) {
      const n = readSync(fd, tail, got, tail.length - got, keep + got);
      if (n <= 0) break; // unreadable remainder: judge only what was read
      got += n;
    }
    let complete = got === tail.length;
    if (complete) {
      try {
        JSON.parse(tail.toString('utf8'));
      } catch {
        complete = false; // truly torn, not merely missing its newline
      }
    }
    if (complete) {
      // O_APPEND lands the LF at EOF, finishing what the dying append owed.
      // If we crash before the caller's fsync persists it, the tail still
      // parses and the next append simply repairs it again — idempotent.
      writeAllSync(fd, Buffer.from('\n'));
      return size + 1;
    }
    // Durability rides on the append's own fsync: if we die between here and
    // there the file still ends mid-line, which is exactly the state this
    // repair recovers from on the next append.
    ftruncateSync(fd, keep);
    return keep;
  }

  /**
   * Read the log NEWEST-FIRST, read state merged from the sidecar.
   *
   * Append order is arrival order, so newest-first is a reverse — not a sort
   * on `ts`, which is the sender-side server clock and can interleave when
   * two peers' backlogs drain together. Arrival order is the order this
   * client experienced, which is the one an inbox should show.
   *
   * Partial-line recovery, explicitly: a crash mid-append can leave one
   * damaged line, and only the last one (appends are serialized by the
   * lock). Any line that fails to parse is skipped here and physically
   * dropped by the next retention rewrite. An unreadable inbox would be a
   * worse failure than one missing record that was already lost in flight.
   */
  read(opts: ReadOptions = {}): MessageRecord[] {
    const records = this.loadAll();
    const readAt = this.loadReadMap();
    for (const r of records) if (r.read === false && readAt.has(r.id)) r.read = true;
    records.reverse();
    let out = records;
    if (opts.dir !== undefined) out = out.filter(r => r.dir === opts.dir);
    if (opts.peer !== undefined) out = out.filter(r => r.peer === opts.peer);
    if (opts.unread) out = out.filter(r => !r.read);
    if (opts.limit !== undefined && opts.limit > 0) out = out.slice(0, opts.limit);
    return out;
  }

  /** Mark ids read (timestamped — retention counts 24h from HERE, not from
   * arrival, so a body is never purged before anyone had a chance to see it). */
  markRead(ids: string[], now = Date.now()): void {
    if (ids.length === 0) return;
    this.withLock(() => {
      const merged = this.loadReadMap();
      for (const id of ids) {
        if (!merged.has(id)) merged.set(id, now);
      }
      this.writePrivate(this.readPath, JSON.stringify(Object.fromEntries(merged)));
    });
  }

  /**
   * Enforce the retention policy. Idempotent and cheap when there is nothing
   * to do; rewrites atomically (temp + rename in the same directory) when
   * there is, so a reader always sees a complete file.
   *
   * `force` is `inbox --purge`: consumed bodies go NOW, not after the 24h
   * grace — the operator saying "I am done with these" outranks the grace
   * period that exists only to protect them from a too-eager cron.
   */
  applyRetention(opts: { now?: number; force?: boolean } = {}): RetentionOutcome {
    const now = opts.now ?? Date.now();
    // CONSTRAINT: the stranded-temp sweep is owed whenever the spool
    // DIRECTORY exists — `messages.jsonl` being absent is not evidence that
    // nothing plaintext is beside it. `messages.jsonl.<pid>.tmp` is a full
    // pre-rewrite snapshot with every retained body in cleartext, left by a
    // pass SIGKILLed between its temp's fsync and its rename, and the live
    // file can be removed independently: `rm state/<name>/messages.jsonl` is
    // the obvious "delete my history" move, and a restore can carry the
    // sibling without the file. An earlier revision returned HERE, before the lock and so
    // before the sweep, so `purge` reported {dropped:0,redacted:0} and exit 0
    // over that snapshot — and took the same early return on every later
    // command, so nothing ever removed it. Only an absent DIRECTORY is a true
    // nothing-to-do: a temp cannot be stranded inside a directory that does
    // not exist, and returning there keeps retention on a fresh account from
    // minting a spool as a side effect (the `ensureDir` writer-only rule).
    if (!existsSync(this.root)) return { dropped: 0, redacted: 0 };
    return this.withLock(() => {
      // Before this pass may report ANYTHING destroyed: a pass that died
      // between its temp's fsync and its rename left that temp — a full
      // pre-rewrite snapshot, retained plaintext included — as a sibling no
      // later rewrite touches, so a purge could return while a body it just
      // "destroyed" sat beside the spool forever.
      this.sweepStrandedTemps();
      // The sweep above is owed with or without a log to rewrite; everything
      // from here down needs one to read.
      if (!existsSync(this.logPath)) return { dropped: 0, redacted: 0 };
      const snap = this.readPrivateWithStat(this.logPath);
      const readAt = this.loadReadMap();
      const lines = snap.content.split('\n').filter(Boolean);
      const kept: string[] = [];
      let dropped = 0;
      let redacted = 0;

      for (const line of lines) {
        let record: MessageRecord | null = null;
        try {
          const parsed = JSON.parse(line) as MessageRecord;
          if (typeof parsed.id === 'string' && typeof parsed.text === 'string') record = parsed;
        } catch {
          record = null;
        }
        if (!record || now - record.ts >= RETAIN_MS) {
          // Unparseable (a crashed append) or older than the queue TTL —
          // including redacted metadata, which ages out on the same clock.
          // The read mark dies with the row ONLY when no surviving row
          // shares the id: an outbound ledger row aging out used to delete
          // the mark a colliding newer inbound row was standing on, which
          // resurrected it unread and stalled its redaction forever.
          // (The sidecar prune below keys on the SURVIVING rows, which is
          // exactly the rule; the old eager delete here was the bug.)
          dropped += 1;
          continue;
        }
        const consumedAt = readAt.get(record.id);
        const due =
          consumedAt !== undefined && (opts.force === true || now - consumedAt >= REDACT_AFTER_MS);
        if (due && !record.red && record.text !== '') {
          const purged: MessageRecord = {
            id: record.id,
            dir: record.dir,
            peer: record.peer,
            ts: record.ts,
            tcm: record.tcm,
            text: '',
            read: true,
            // `bytes` KEEPS ITS MEANING: the size of the DELIVERED body, i.e.
            // `text` alone. A detail is purged with it and
            // is deliberately not added in here — this number is documented
            // as what was shown, `mcp.ts` reports it as `byte_count`, and
            // silently redefining it to "everything the frame carried" is
            // worse than under-reporting: a caller comparing it against a
            // body it received would find a discrepancy with no explanation.
            bytes: Buffer.byteLength(record.text, 'utf8'),
            red: true,
            // The route is metadata, not content: a redacted reply still
            // says WHICH message it answered (an earlier review t1-2).
            ...(record.ref ? { ref: record.ref } : {}),
            ...(record.ofs ? { ofs: record.ofs } : {}),
            ...(record.sess ? { sess: record.sess } : {}),
            // The ROOM routing/exclusion metadata is the same class: `grp`
            // (the room id), `men` (mentions-self) and `ai` (this author spoke
            // AI-marked here) are ULID/flag-class fields the header already
            // declares acceptable to persist to the 30-day ceiling — NONE of
            // them is body. Dropping them here silently un-marks the row:
            // `roomAiAuthorIds` matches `grp===gid && ai===true`, so an
            // AI-marked author lost its MARKER-half agent signal the instant
            // its row redacted (24h after read, or `inbox --purge`), and an
            // agent no roster class covered silently rejoined non-mention
            // fan-out. Only `text` is content; these ride through redaction
            // exactly as `ref` does.
            ...(record.grp ? { grp: record.grp } : {}),
            ...(record.men ? { men: record.men } : {}),
            ...(record.ai ? { ai: record.ai } : {}),
            // `rm` rides through for the same reason and by the same rule
            //the room message id is a ULID, the
            // second half of the §5.3 row key — routing, not content.
            // Dropping it would silently un-key a redacted row, so a round
            // whose human turn had aged into redaction would compose a bare
            // answer with no reply ref and no once-per-round guard — a
            // behaviour change nothing would report.
            ...(record.rm ? { rm: record.rm } : {}),
            // AND `detail` IS ABSENT HERE ON PURPOSE. It is
            // the one new field of the BODY class: prose a peer wrote, the
            // second half of the same message `text` is the first half of.
            // Everything listed above is routing this client derived from an
            // authenticated frame; dropping one of those silently changes
            // where messages go, which is why they ride through. Carrying a
            // detail through instead would leave the longest peer-written
            // text on this disk surviving the purge that exists to remove
            // exactly it — and `inbox --purge`'s promise ("get the consumed
            // plaintext off this disk NOW") would be false by the width of a
            // 3 000-character finding. The rebuild is an ALLOWLIST, so the
            // absence is enforced by construction; `msglog.rounds.test.ts`
            // pins it, because an absence no test names is an absence the
            // next field addition quietly ends.
          };
          kept.push(JSON.stringify(purged));
          redacted += 1;
          continue;
        }
        kept.push(line);
      }

      if (dropped > 0 || redacted > 0) {
        // The takeover guard lives in `replaceSpool`, fused to the rename it
        // protects — see there for why it compares bytes, not stat.
        this.replaceSpool(kept.length ? `${kept.join('\n')}\n` : '', snap.content);
        // Prune sidecar entries whose record is gone, so the read map cannot
        // grow without bound against a log that cannot.
        const liveIds = new Set(
          kept
            .map(l => {
              try {
                return (JSON.parse(l) as MessageRecord).id;
              } catch {
                return '';
              }
            })
            .filter(Boolean),
        );
        for (const id of [...readAt.keys()]) if (!liveIds.has(id)) readAt.delete(id);
        this.writePrivate(this.readPath, JSON.stringify(Object.fromEntries(readAt)));
      }
      return { dropped, redacted };
    });
  }

  /** `inbox --purge`: consumed bodies go now; everything expired goes now. */
  purge(now = Date.now()): RetentionOutcome {
    const outcome = this.applyRetention({ now, force: true });
    this.sweepQuarantineTemps();
    return outcome;
  }

  /**
   * The quarantine's OWN stranded temps, swept under the quarantine's OWN
   * lock.
   *
   * Scoping `sweepStrandedTemps` to the files `messages.lock` governs was
   * right — it had been deleting LIVE `undelivered.jsonl.<pid>.tmp` files out
   * from under `inbound.ts`, whose rename then failed after the ratchet had
   * already consumed the only decryptable copy. But it left the other half
   * open: a quarantine temp stranded by a dead pass holds a plaintext body,
   * and after that scoping nothing removed it, so `inbox --purge` reported
   * success over plaintext still on disk. `purge` is the command a user runs
   * when they need the body gone; "we were not entitled to judge it" is a
   * reason to take the right lock, not a reason to leave it there.
   *
   * OUTSIDE the messages.lock section, deliberately — but NOT for the reason
   * this comment used to give. It claimed inbound.ts holds `undelivered.lock`
   * and calls `append`, closing a deadlock cycle. That is false and was worth
   * catching: the only body held under `undelivered.lock` is
   * `rewriteUndelivered`, which does openSync/fstatSync/readFileSync/closeSync
   * and one `writeFileAtomic`, and takes no other lock. No path in this package
   * acquires undelivered-then-messages, so there is no cycle to close.
   *
   * The real reason is that there is no cycle YET and nesting them would be the
   * thing that creates one: `append` under `undelivered.lock` is a plausible
   * future edit — it is what "recover the quarantine into the spool" would look
   * like in code — and if it ever lands, a nested sweep here becomes a deadlock
   * rather than a bug someone can see. Nothing links the two sweeps, so nesting
   * buys nothing to pay for that.
   *
   * A CONTENDED lock is not fatal: a live quarantine legitimately holds it for
   * the length of one rename, so the temp it owns is not stranded at all, and
   * the next purge will find it if it ever really was. Nothing else here is
   * excusable — see the catch.
   */
  private sweepQuarantineTemps(): void {
    const base = UNDELIVERED_FILE;
    // CONSTRAINT: the catch below covers the ACQUISITION only. `withFileLock`
    // runs the body inside its own call, so a try around the whole thing also
    // swallows the body — an earlier revision's did, and `rmSync` throwing EACCES/EIO and
    // `fsyncDirSync` throwing EIO/ENOSPC were both discarded, so
    // `chflags uchg undelivered.jsonl.4242.tmp` made `inbox --purge` exit 0
    // reporting success with a plaintext body still sitting beside the spool.
    // That is the exact rule `sweepStrandedTemps` states for itself sixty
    // lines below ("a sweep that could not delete cannot be mistaken for one
    // that did"), and the two sweeps must not disagree. The flag records that
    // we got INSIDE the lock, which no error message can fake.
    let entered = false;
    try {
      withFileLock(join(this.root, 'undelivered.lock'), () => {
        entered = true;
        let removed = 0;
        for (const entry of readdirSync(this.root)) {
          if (!entry.startsWith(`${base}.`)) continue;
          // The quarantine's temps are minted by writeFileAtomic (inbound.ts
          // holds this lock around it), so the shape swept here is that
          // module's to define — its exported RE, not a literal, precisely so
          // the two cannot drift: when the scan fix moved
          // the suffix from the pid to fresh entropy, a literal `\d+` here
          // would have gone quietly blind, and a blind sweep is retained
          // PLAINTEXT that outlives the purge which reported it destroyed.
          // The RE still matches the old pid shape too — an upgrade may find
          // strands an earlier build left.
          if (!ATOMIC_TMP_SUFFIX_RE.test(entry.slice(base.length + 1))) continue;
          // Held under THIS lock, so the custody argument that licenses the
          // spool sweep licenses this one: any such temp visible now belongs
          // to a process that died mid-rename.
          rmSync(join(this.root, entry), { force: true });
          removed += 1;
        }
        // Same durability obligation as the spool sweep: an unlink is a
        // change to the directory and purge must not outrun the disk.
        if (removed > 0) fsyncDirSync(this.root);
      });
    } catch (err) {
      // `entered` means the body ran: the failure is a temp we could not
      // remove or a directory we could not persist, and `purge` must not
      // return success over it. A lock we could not TAKE is different only
      // when someone else holds it — then there is a live writer whose temp
      // is not ours to judge. Every other acquisition failure (the lock
      // directory is unwritable, staging hit ENOSPC) leaves us unable to look
      // with no reason to believe there is nothing there, so it propagates
      // too. The counts `purge` returns are about RECORDS, but its EXIT CODE
      // is about whether the plaintext is gone.
      if (entered || !isLockContention(err)) throw err;
    }
  }

  /**
   * The ONE place a temp name is minted for a file `messages.lock` governs.
   *
   * CONSTRAINT: the set of temps created under this lock and the set
   * `sweepStrandedTemps` deletes must be the SAME set, and two literal lists
   * drift. Both read `ownedTargets`, and a target outside it throws rather
   * than quietly minting a temp the sweep will never find — a temp the sweep
   * cannot see is retained plaintext that outlives the purge which reported
   * it destroyed.
   */
  private tempFor(target: string): string {
    if (!this.ownedTargets.includes(target)) {
      throw new Error('msglog: refusing to mint a temp for a path messages.lock does not own');
    }
    return `${target}.${process.pid}.tmp`;
  }

  /**
   * Remove temp files a dead pass stranded. Every temp for a file THIS lock
   * governs is pid-tagged, created under the lock, and consumed (renamed or
   * removed) before that lock is released — so any such temp visible while WE
   * hold the lock belongs to a process that died mid-rewrite, and what it
   * holds is the spool as it stood BEFORE that rewrite: bodies later purges
   * redact in the live file but would never have looked for in an unlisted
   * sibling. Called with the lock held.
   */
  private sweepStrandedTemps(): void {
    // CONSTRAINT: sweep only the temps `messages.lock` governs. The custody
    // argument above is an argument about THIS lock; it says nothing about a
    // sibling written under a different one. An earlier revision's predicate was
    // `\.\d+\.tmp$` over the whole state directory, which also matched
    // `undelivered.jsonl.<pid>.tmp` — the quarantine in inbound.ts, held
    // under `undelivered.lock`. A no-op `purge` running while a quarantine
    // sat between its fsync and its rename deleted that LIVE temp; the rename
    // then failed, `quarantineUndelivered` returned null, and the ratchet had
    // already consumed the only decryptable copy of the message. Silent mail
    // loss. Widening the predicate is never the fix — a temp under
    // a lock we do not hold has no liveness we are entitled to judge.
    const owned = this.ownedTargets.map(t => basename(t));
    let removed = 0;
    for (const entry of readdirSync(this.root)) {
      const mine = owned.some(
        base => entry.startsWith(`${base}.`) && /^\d+\.tmp$/.test(entry.slice(base.length + 1)),
      );
      if (!mine) continue;
      // `force` only swallows ENOENT; EACCES/EIO still throw, so a sweep that
      // could not delete cannot be mistaken for one that did.
      rmSync(join(this.root, entry), { force: true });
      removed += 1;
    }
    // CONSTRAINT: an unlink is a change to the DIRECTORY, and it is not
    // durable until the directory is. When this pass has nothing to drop or
    // redact there is no later `replaceSpool`, so nothing else ever fsyncs
    // this directory: `purge` would return success over plaintext that power
    // loss can bring straight back. Concretely — stranded temp holding a body
    // beside an already-redacted live spool, `inbox --purge` reports
    // {dropped:0,redacted:0} and exits 0, power cut, and the body is on disk
    // again. `purge` is the command a user runs when they need the plaintext
    // gone; its report must not outrun the disk.
    if (removed > 0) fsyncDirSync(this.root);
  }

  private loadAll(): MessageRecord[] {
    if (!existsSync(this.logPath)) return [];
    const records: MessageRecord[] = [];
    for (const line of this.readPrivate(this.logPath).split('\n')) {
      if (!line) continue;
      try {
        const parsed = JSON.parse(line) as MessageRecord;
        if (typeof parsed.id !== 'string' || typeof parsed.text !== 'string') continue;
        records.push(parsed);
      } catch {
        continue;
      }
    }
    return records;
  }

  private loadReadMap(): Map<string, number> {
    if (!existsSync(this.readPath)) return new Map();
    try {
      const parsed: unknown = JSON.parse(this.readPrivate(this.readPath));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return new Map();
      const out = new Map<string, number>();
      for (const [id, at] of Object.entries(parsed)) {
        if (typeof at === 'number' && Number.isFinite(at)) out.set(id, at);
      }
      return out;
    } catch {
      // A corrupt sidecar must not make the inbox unreadable. Worst case is
      // that consumed messages show unread once more and their bodies live
      // one retention pass longer — recoverable; an unopenable log is not.
      return new Map();
    }
  }

  /** Open-validate-read, so a swapped or loosened file is refused, not read. */
  private readPrivate(path: string): string {
    return this.readPrivateWithStat(path).content;
  }

  /** The read plus the identity of what was read, taken from the SAME fd —
   * `applyRetention` snapshots through this, and `replaceSpool` later proves
   * the snapshot still IS the file (by BYTES — see there for why the stat
   * identity was not enough) before renaming a rewrite over it. */
  private readPrivateWithStat(
    path: string,
  ): { content: string; ino: number; size: number; mtimeMs: number } {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      assertPrivateFile(fd, path);
      const st = fstatSync(fd);
      return { content: readFileSync(fd, 'utf8'), ino: st.ino, size: st.size, mtimeMs: st.mtimeMs };
    } finally {
      closeSync(fd);
    }
  }

  /** Atomic private replace: temp in the same directory, fsync, rename. The
   * mode rides on the temp file because rename keeps the source's bits. */
  private writePrivate(path: string, content: string): void {
    assertPrivateDir(dirname(path));
    const tmp = this.tempFor(path);
    const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, FILE_MODE);
    try {
      // Looped for the same reason as `append`, and it matters MORE here: this
      // writes the whole rewritten spool, so one short write would rename a
      // truncated file over the real one and lose every record past the cut.
      writeAllSync(fd, Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8'));
      fsyncSync(fd);
    } catch (err) {
      // Never rename a partial file into place; drop the temp instead.
      closeSync(fd);
      rmSync(tmp, { force: true });
      throw err;
    }
    closeSync(fd);
    renameSync(tmp, path);
    // The rename is atomic in the namespace but not yet ON DISK: until the
    // directory itself is persisted, power loss resurrects the replaced file
    // — for the spool, plaintext a purge already reported destroyed.
    fsyncDirSync(dirname(path));
  }

  /**
   * Rename `next` over the spool ONLY if the spool still holds exactly
   * `expected` — the snapshot `next` was derived from.
   *
   * The lock makes a concurrent writer impossible — unless the lock was
   * taken from us while we held the snapshot (lock.ts closes the automated
   * path, but an operator following the timeout remedy `rm messages.lock`
   * against a stalled-but-alive pass reopens it), and then this rename
   * would put a PRE-takeover snapshot over the file, permanently erasing
   * records appended and ACKED since the read. An earlier revision guarded that with an
   * (ino, size, mtime) stat checked before the temp was even written, and
   * an earlier revision broke both halves: a tail repair plus an equal-length append
   * preserves inode AND size inside one coarse mtime tick, and the
   * check-to-rename window spanned the whole temp write. So the guard is
   * now the BYTES, compared after the temp is fully prepared, immediately
   * before the rename: every append changes the bytes (each record carries
   * a fresh msgId), so equality cannot false-negative, and equal bytes mean
   * `next` is a pure function of exactly what is on disk — the rename
   * replaces nothing it was not derived from. Abandoning costs nothing:
   * retention is idempotent and reruns on the next invocation, while a
   * clobbered acked record never comes back. The residual window is the two
   * syscalls between compare and rename — closing it outright needs a
   * conditional rename POSIX does not offer, and reaching it requires this
   * pass to be preempted exactly there, its lock hand-removed, AND a full
   * fsynced append to complete inside those microseconds.
   */
  private replaceSpool(next: string, expected: string): void {
    assertPrivateDir(this.root);
    const tmp = this.tempFor(this.logPath);
    const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, FILE_MODE);
    try {
      // Looped for the same reason as `append`: this is the whole rewritten
      // spool, and a short write renamed into place loses every record past
      // the cut.
      writeAllSync(fd, Buffer.from(next, 'utf8'));
      fsyncSync(fd);
    } catch (err) {
      closeSync(fd);
      rmSync(tmp, { force: true });
      throw err;
    }
    closeSync(fd);
    let live: string;
    try {
      live = this.readPrivate(this.logPath);
    } catch (err) {
      rmSync(tmp, { force: true });
      throw err;
    }
    if (live !== expected) {
      rmSync(tmp, { force: true });
      refuse(
        this.logPath,
        'changed while retention held its snapshot',
        'another process wrote the spool; rerun — the pass was abandoned rather than erase the newer append',
      );
    }
    renameSync(tmp, this.logPath);
    // Same resurrection hazard as `writePrivate`: the rename is not durable
    // until the directory entry is.
    fsyncDirSync(this.root);
  }
}

export interface InboxOptions {
  peer?: string | undefined;
  limit: number;
  unread: boolean;
  /** Look without touching: suppress the mark-read that `inbox` implies. */
  peek: boolean;
}

/**
 * The `inbox` read: fetch newest-first, then mark what was
 * returned as read — unless `--peek`, which exists because an agent or a
 * script summarizing an inbox must be able to look without silently deciding,
 * on the operator's behalf, that the operator has seen it. Marking read is
 * not bookkeeping here: it starts the retention clock that purges the body.
 *
 * The returned records carry their read state AS IT WAS, so a caller can
 * still show which lines were new even though they are, by the time it
 * prints them, already marked.
 */
export function takeInbox(log: MessageLog, opts: InboxOptions): MessageRecord[] {
  // dir:'in' pinned: the inbox is what OTHERS said. The outbound ledger rows
  // share the spool for retention and locking, but an
  // inbox that showed the machine its own sends would count them unread and
  // read them back as conversation.
  const records = log.read({ peer: opts.peer, unread: opts.unread, limit: opts.limit, dir: 'in' });
  if (!opts.peek) {
    log.markRead(records.filter(r => !r.read).map(r => r.id));
  }
  return records;
}

/**
 * The MARKER-RECORD half of the CLI's agent-class signal: room members this
 * client has heard author an AI-marked `grp.msg` in `gid` (`ai`, written by
 * inbound.ts from the wrapper marker — the field's doc above). ONE
 * implementation, HERE beside the field it reads, because two readers of
 * `grp===gid && ai===true` would drift: `roomAgentAuthorIds`
 * (room-commands.ts) unions this with the roster fold's class record, and
 * room-render.ts's grp.consent subject gate reads the same union without
 * importing the command surface (which would be an import cycle through
 * send→inbound→room-render). Fail-OPEN to the empty set: a read error must
 * never widen exclusion into dropping a leg the message was owed.
 */
export function roomAiAuthorIds(account: string, gid: string): Set<string> {
  const ids = new Set<string>();
  try {
    for (const r of new MessageLog(account).read({ dir: 'in' })) {
      if (r.grp === gid && r.ai === true) ids.add(r.peer);
    }
  } catch {
    /* no readable spool ⇒ no known agents */
  }
  return ids;
}
