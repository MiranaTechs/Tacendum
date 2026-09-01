import {
  closeSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { CliError, EXIT } from './exit.js';

/**
 * A cross-process file lock.
 *
 * Two CLI processes sharing one account directory is not a misuse — it is the
 * documented shape of the product: a `listen` daemon plus a hook-driven
 * `send`, or a `make -j` fan-out. Both sides of that do a read-modify-write of
 * the same Double Ratchet session file, and losing one of those writes loses
 * a chain advance: messages that never decrypt, or a session forked so badly
 * that both ends must be reset. The NSE hit exactly this and got a lock;
 * the CLI had none.
 *
 * STALE RECOVERY WAS RENAME-BASED, AND THAT WAS NOT ENOUGH. Kept here because
 * the reasoning is what the current design is a reply to, and marked as
 * superseded because a header that states a rule the code no longer follows is
 * the same defect as a wrong rule. The obvious version — stat the lock, see it
 * is old, `rm` it, create your own — is a TOCTOU: two processes both observe
 * the same stale lock, both remove it, and the second removes the FIRST one's
 * freshly created lock, so both proceed believing they hold it. `rename` has
 * the property `rm` lacks: it consumes the file, so only one racer can win a
 * given path. That is true and still insufficient — see "A LOCK PATHNAME IS
 * USED ONCE AND NEVER AGAIN" below, which is what actually ships: no recovery
 * step takes a pathname away from anyone, because no pathname is ever shared.
 *
 * THE TOKEN IS PUBLISHED WHOLE OR NOT AT ALL. Writing the
 * token into a file already visible at the lock path let readers catch it
 * mid-write — and a token torn just after its second ':' is byte-shaped like
 * the complete legacy `pid:hex` token, which is honoured for as long as
 * ANYTHING wears that pid, so a fragment could outlive its crashed writer as
 * an unbounded wedge. The token is therefore staged complete in a private
 * file and published with link(), which atomically gives the entry the
 * finished file or fails EEXIST: no moment exists at which a published name
 * holds a fragment. And because a claimer can stall between publishing and
 * returning — long enough (SIGSTOP, sleep, breakpoint) to be classified dead
 * and have its ticket collected — acquisition reports success only after
 * re-reading the queue and finding its own ticket still in it. Without that
 * check a stopped-then-resumed claimer returned "acquired" while another
 * process held the lock: two processes inside the same ratchet
 * read-modify-write.
 *
 * A FAILED DIRECTORY READ IS NOT AN EMPTY DIRECTORY. Every
 * question this lock asks — who is queued ahead of me, is anyone still
 * choosing — is a readdir, and readdirSync throws EMFILE at the descriptor
 * ceiling that a `make -j` fan-out or a long-lived `listen` daemon actually
 * reaches. Reporting that as `[]` made every guard fail toward "enter" at the
 * same instant, and correlated: at the ceiling the liveness probe's
 * readFileSync and its `ps` spawn fail too. Reads therefore report failure as
 * failure (`unreadable`), the acquisition loop treats it as RETRY, and the
 * 10-second deadline still bounds the retrying.
 *
 * LIVENESS IS BOUND TO AN INCARNATION, NOT A PID. The pid
 * alone made a dead holder look alive: the OS recycles pids, so a token left
 * by a crashed process passed `kill(pid, 0)` for the entire lifetime of
 * whatever unrelated long-running process inherited the number, and every
 * acquisition attempt re-armed the 10-second timeout — an account wedged
 * until a stranger exited or a human removed the file. The token therefore
 * also records WHEN its writer started, which a recycled pid cannot fake.
 */

/**
 * When a lock is presumed abandoned. Generous relative to what it guards —
 * every operation under it is local crypto and a few small file writes, never
 * network I/O — so a lock this old means a process died holding it, not one
 * that is merely slow.
 *
 * WAS 30 SECONDS, AND CAME DOWN TO 9 TO RESTORE THE INVARIANT BELOW — because
 * of the two constants this is the one that could move. Raising LOCK_WAIT_MS
 * above 30s was the alternative, and it was tried and rejected on measurement:
 * `sleepSync` blocks the event loop, so a 45-second budget is a 45-second
 * FREEZE of whatever hook invoked the CLI, and it pushed refusals past the
 * suite's timeouts and past vitest's own worker RPC deadline. A budget whose
 * only correct value exceeds every caller's patience is the wrong constant to
 * grow.
 *
 * It came down only this far, and the gap to the wait is deliberately one
 * second, because the youth test is what SHORT-CIRCUITS `holderIsAlive`: every
 * millisecond a contended wait spends PAST this threshold pays a `ps` spawn per
 * blocking entry per 25ms poll — the "about forty subprocesses a second"
 * `entryBlocks` documents. Keeping the threshold high keeps that probing to the
 * last second of a 10-second wait instead of most of it. (The suite is green
 * either way; this is an argument from the cost `entryBlocks` already records,
 * not from an observed failure.)
 *
 * 9 seconds still dominates what this guards by three orders of magnitude —
 * single-digit milliseconds of local crypto and a couple of small writes — so
 * it remains the "sized for millisecond holds" threshold the file argues for.
 * And it only decides anything when `holderIsAlive` CANNOT answer, since a
 * probeable live holder blocks at ANY age: the exposure added is "a live
 * holder whose probe fails transiently, between 9 and 30 seconds into a hold
 * that should have taken milliseconds" — two pathologies at once, against a
 * bug that needed none.
 */
const LOCK_STALE_MS = 9_000;

/**
 * How long to wait for a holder before giving up.
 *
 * THE INVARIANT IS `LOCK_WAIT_MS > LOCK_STALE_MS`, AND IT USED TO BE INVERTED
 * (10s wait against a 30s staleness threshold), WHICH MADE ORPHAN RECOVERY
 * UNREACHABLE FOR MOST WAITERS. An entry is broken only once it is BOTH past
 * `LOCK_STALE_MS` and unprobeable (`entryBlocks`), and its mtime is stamped
 * once at publication and never refreshed. So a waiter that arrives when the
 * entry is `a` milliseconds old can only ever break it if it is still waiting
 * at `LOCK_STALE_MS`, i.e. iff `a + LOCK_WAIT_MS > LOCK_STALE_MS`. With a 10s
 * wait against a 30s threshold that failed for every `a` under 20 seconds: a
 * process that died holding the lock refused every waiter arriving in the
 * first 20 seconds of the corpse's life, each after a pointless full-length
 * wait, and only a waiter lucky enough to show up late recovered it. Worst
 * case `a = 0` — the waiter arrives the instant the corpse published — so the
 * requirement over all arrival times reduces to `LOCK_WAIT_MS > LOCK_STALE_MS`.
 *
 * THIS CONSTANT DID NOT MOVE; `LOCK_STALE_MS` came down under it instead, and
 * that direction is deliberate. The wait is SYNCHRONOUS — `sleepSync` blocks
 * the event loop — so this number is a ceiling on how long a hook-invoked CLI
 * can freeze, and every caller's patience is already calibrated to it. It
 * clears the 9s threshold by one second, which is 40 rounds of the 25ms
 * contention poll — enough for the waiter to notice the corpse, collect it,
 * re-read the queue and enter. The margin is deliberately THIN rather than
 * generous: widening it means lowering the threshold, and every second below
 * the threshold is a second of `ps` storm on contended waits (see
 * `LOCK_STALE_MS`). A waiter that loses this race still fails safe — it
 * refuses, and the next attempt arrives with the corpse already stale.
 *
 * Callers that must not wait even this long pass their own budget: attend's
 * turn lock declines after a second rather than stalling a supervised loop
 * behind a multi-minute agent turn (see `tryFileLockAsync`).
 */
const LOCK_WAIT_MS = 10_000;

/**
 * Exported for the one test that can catch this class of regression: the
 * relationship above is a property of the PAIR, so no behavioural test of
 * either constant alone pins it, and re-inverting them is a two-character
 * edit that would restore an unreachable-orphan-recovery bug the suite could
 * otherwise only notice as an intermittent 45-second failure.
 */
export const LOCK_TIMINGS = { waitMs: LOCK_WAIT_MS, staleMs: LOCK_STALE_MS } as const;

const FILE_MODE = 0o600;

/**
 * Recorded when the writer could not read its own start time. A lock bearing
 * this is stealable once stale even if its writer lives — deliberately: on a
 * platform where no one can verify the holder, an unverifiable lock that is
 * ALSO 30 seconds past a threshold sized for millisecond holds is far more
 * likely a corpse than a survivor, and the corpse wedges forever.
 */
const UNKNOWN_INCARNATION = '?';

/** Block this thread. The lock is only ever held across local work, so the
 * wait is milliseconds; an async sleep would let a second command in the same
 * process interleave, which is the thing being prevented. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * When the process with this pid started — the fact that distinguishes pid
 * 4242 today from pid 4242 recycled tomorrow, immutable for the life of a
 * process and unreadable by no one (both sources below can see other users'
 * processes, which `kill(pid, 0)`'s EPERM case cannot).
 *
 * Linux: field 22 of /proc/<pid>/stat, clock ticks since boot. Parsed after
 * the LAST ')' because comm may itself contain spaces and parentheses. Boot
 * time is deliberately NOT mixed in: /proc/stat's btime is recomputed from
 * the wall clock, so an NTP step while a lock is held would make a live
 * holder look recycled and get it stolen from — the exact double-writer
 * corruption the lock exists to prevent. The cost is that a pre-reboot lock
 * needs the recycled pid's tick count to collide too before it can wedge,
 * which is strictly narrower than the pure-pid bug this replaces.
 *
 * macOS/BSD: `ps -o lstart=`, the absolute timestamp captured once at spawn.
 * LC_ALL=C pins the format so the writer's own reading and a later checker's
 * reading are byte-identical; sanitized because the raw form contains ':',
 * the token separator.
 */
function processIncarnation(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const start = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    if (start !== undefined && /^\d+$/.test(start)) return start;
  } catch {
    // No /proc: not Linux. Ask ps instead.
  }
  try {
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
      env: { ...process.env, LC_ALL: 'C' },
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    if (out !== '') return out.replace(/[^A-Za-z0-9]+/g, '-');
  } catch {
    // ps absent or refused; the caller decides what unknown means.
  }
  return undefined;
}

/**
 * Cached: a process's start time never changes, and on macOS reading it costs
 * a subprocess spawn that should not be paid on every acquisition.
 *
 * THE FAILURE IS NOT CACHED, only the answer. `??=` over
 * `processIncarnation(pid) ?? UNKNOWN_INCARNATION` cached BOTH, because the
 * right-hand side is never nullish — so a single failed `ps` (one EAGAIN at a
 * fork limit, one moment at the descriptor ceiling) stamped `?` into every
 * token that process wrote for the rest of its life. `holderIsAlive` reads a
 * recorded `?` as dead, so `doorBlocks`' "young OR alive" collapsed to
 * age-only and a LIVE claimant's door stopped blocking after DOOR_MAX_MS.
 * Measured at 4 of 4 trials: with a 6s stall injected between the queue read
 * and the ticket link, two processes were concurrently inside the critical
 * section for 509ms.
 *
 * The trigger is the correlated one this file already documents as reached: at
 * the fd ceiling, /proc/self/stat and the `ps` spawn fail together, and a
 * `listen` daemon is the longest-lived process here and the most exposed. So
 * an unanswerable probe now means "ask again next time", which costs one spawn
 * and cannot wedge; only a real reading is remembered.
 */
let ownIncarnation: string | undefined;
function myIncarnation(): string {
  if (ownIncarnation !== undefined) return ownIncarnation;
  const probed = processIncarnation(process.pid);
  if (probed === undefined) return UNKNOWN_INCARNATION;
  ownIncarnation = probed;
  return probed;
}

/**
 * Is the process that WROTE the lock file still running?
 *
 * `kill(pid, 0)` answers only whether the pid exists now, not whether it is
 * still the writer, so it is merely the cheap first gate. Only a lock whose
 * writer is provably or presumptively GONE answers false; an unreadable or
 * malformed lock answers "not alive", so a corrupt lock can still be
 * recovered rather than wedging the account forever.
 */
function holderIsAlive(lockPath: string): boolean {
  let raw: string;
  try {
    raw = readFileSync(lockPath, 'utf8');
  } catch {
    return false;
  }
  const parts = raw.split(':');
  const pid = Number(parts[0]);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (err) {
    // ESRCH: nothing has this pid; the writer is certainly gone. EPERM: it
    // exists under another user — fall through, the incarnation sources can
    // read foreign processes even when signalling them is refused.
    if ((err as NodeJS.ErrnoException).code !== 'EPERM') return false;
  }
  // The pid exists. Whether its process is the one that wrote this file is
  // the question kill() cannot answer.
  if (parts.length === 2 && parts[1] !== undefined && /^[0-9a-f]+$/.test(parts[1])) {
    // The complete pre-incarnation token, `pid:randomhex`. It recorded no
    // start time, so pid existence is the only liveness it supports — kept,
    // so a holder still running the previous binary is not stolen from
    // mid-upgrade. No current binary writes this shape, so the pid-reuse
    // wedge survives only for locks that predate this fix.
    return true;
  }
  if (parts.length !== 3) {
    // No complete token of any version has this shape: a torn or corrupt
    // write. Matching a pid against a fragment is what wedged before — the
    // fragment's leading digits named the (very alive) writer itself, or
    // whatever process now wears them — so a fragment is dead by fiat, and
    // recoverable.
    return false;
  }
  const recorded = parts[1];
  if (recorded === undefined || recorded === '' || recorded === UNKNOWN_INCARNATION) {
    return false; // see UNKNOWN_INCARNATION: unverifiable + stale = presumed dead
  }
  const current = processIncarnation(pid);
  // An unanswerable probe counts as dead, not alive. Both misjudgements
  // lose, but not equally: calling a dead holder alive wedges the account
  // for the lifetime of an unrelated process (observed; unbounded), while
  // calling a live one dead needs that holder to ALSO be 30s past a
  // threshold sized for millisecond holds, on a machine where the same
  // probe worked moments earlier — and costs one steal, not a wedge.
  if (current === undefined) return false;
  return current === recorded;
}

/**
 * What acquisition hands back: the name of the entry it created, and nothing
 * else.
 *
 * It used to carry the token bytes and the file's dev/ino so that `release`
 * could re-verify them. That belonged to the design where a lock lived at ONE
 * reusable pathname and a replacement file could therefore occupy it. Under
 * single-use `<seq>.<nonce>` names no replacement is constructible, so the
 * extra fields authenticated nothing and the check that read them could only
 * ever fail open — see `release`.
 */
interface LockHandle {
  /** The single-use entry this process created. Never reused by anyone. */
  path: string;
}

/**
 * Write the whole token into the PRIVATE staging file, or leave no file.
 *
 * `writeSync` may return a SHORT count at a quota or device boundary without
 * throwing, so the write loops until
 * every byte lands. The file being written is never the lock path itself —
 * a fragment visible there was misclassifiable (see the header), and worse,
 * this function's failure cleanup used to remove the LOCK path, which after
 * a mid-write steal is the NEW holder's lock. The staging path
 * is ours alone — pid and random bytes in its name — so removing it on
 * failure can never take anyone else's lock with it.
 */
function writeToken(fd: number, stagePath: string, token: string): void {
  const data = Buffer.from(token, 'utf8');
  try {
    let written = 0;
    while (written < data.length) {
      const n = writeSync(fd, data, written, data.length - written);
      if (n <= 0) throw new Error(`write stalled at ${written}/${data.length} bytes`);
      written += n;
    }
    closeSync(fd);
    return;
  } catch (err) {
    try {
      closeSync(fd);
    } catch {
      // Already closed above, or unclosable — removal matters more.
    }
    try {
      rmSync(stagePath, { force: true });
    } catch {
      // Could not even remove it. The remnant is inert: nothing ever links,
      // reads or classifies a staging file, so it wedges nothing, and
      // rethrowing rm's error here would mask the write failure itself.
    }
    throw new CliError(
      EXIT.ERROR,
      `cannot write the account lock (${stagePath}): ${
        (err as NodeJS.ErrnoException).code ?? (err as Error).message
      }`,
    );
  }
}
/**
 * A LOCK PATHNAME IS USED ONCE AND NEVER AGAIN.
 *
 * Every earlier version of this file put the lock at one fixed pathname and
 * recovered from a dead holder by taking that pathname away — first with
 * `rm`, then, when that proved to be a TOCTOU, with `rename`, on the theory
 * that rename CONSUMES the file so only one racer can win it. That theory is
 * true and still insufficient, because it answers the wrong question. The
 * verdict a thief forms is about an INODE ("the process that wrote THIS file
 * is gone"); the operation it then performs is about a PATHNAME. Between the
 * two, the pathname can come to name a different file:
 *
 *   C: reads the stale lock, confirms its writer is dead — verdict formed
 *   B: steals the same stale lock, publishes its own, passes every check,
 *      and enters the critical section
 *   C: renames "the lock" away, using a verdict about a file that no longer
 *      exists, and thereby deletes B's LIVE lock; links its own; its own
 *      post-publication inode check passes, because its own lock really is
 *      what the pathname names now; enters
 *
 * Two writers inside one Double Ratchet read-modify-write, which is not a
 * retryable error but permanent, silent message loss for that session. No
 * amount of re-checking closes it: POSIX has no unlink-if-inode, so any
 * sequence of "look, then remove" can be split at exactly that point.
 *
 * So the pathname stops being reusable. `lockPath` is now a DIRECTORY, and a
 * holder is a single-use entry inside it named `<seq>.<nonce>`:
 *
 *   - the 128-bit nonce means a name is minted at most once in the lifetime
 *     of the universe, so a verdict about a name can never be applied to a
 *     file some other process created later. Removing an entry you judged
 *     dead is unconditionally safe, because nothing live can be there.
 *   - `seq` orders the waiting room. The holder is the LOWEST-ordered entry
 *     that still blocks; everyone else waits and re-reads. That makes this a
 *     queue rather than a scramble, and it means acquisition never removes
 *     anything in order to succeed — the winner wins by being lowest, not by
 *     deleting the incumbent.
 *
 * The directory (rather than sibling files next to `lockPath`) is deliberate:
 * everything this lock owns lives under one entry that a sibling's cleanup
 * sweep cannot enumerate. msglog's purge unlinks by pattern in the same
 * directory, and a lock file swept out from under a live holder is the same
 * double-writer bug arriving by a different road.
 */

/** Zero-padded so a lexical compare of entry names IS the queue order. */
const SEQ_WIDTH = 12;

/** `<12 digits>.<32 hex>` — the only names `acquire` treats as holders. The
 * staging file is dot-prefixed and cannot match. */
const ENTRY_RE = /^\d{12}\.[0-9a-f]{32}$/;

/**
 * `.door.<32 hex>` — a claimant that is BETWEEN reading the queue and joining
 * it. Dot-prefixed, so it can never be mistaken for a holder entry.
 */
const DOOR_RE = /^\.door\.[0-9a-f]{32}$/;

/**
 * How long a doorway can plausibly stay open: it spans one readdir, one
 * utimes and one link. Three orders of magnitude of headroom. It is the same
 * kind of window as LOCK_STALE_MS and is used the same way (see `doorBlocks`)
 * — a door younger than this blocks whatever its writer looks like, and past
 * it a door blocks only while its writer is provably alive.
 */
const DOOR_MAX_MS = 5_000;

/**
 * THE DOORWAY, and the race that made it necessary (found by sabotage, ~6% of
 * 150 two-process trials, after the single-use-pathname redesign shipped).
 *
 * Picking a ticket is a READ of the queue followed by a WRITE to it, and two
 * racers that both read an empty queue both pick ticket 1. The nonce tie-break
 * is supposed to settle that, and it does — but only if both entries are
 * visible when either one decides:
 *
 *   A  reads [] -> picks 1.aaa
 *   B  reads [] -> picks 1.bbb        (bbb sorts BELOW aaa)
 *   A  links 1.aaa, sees [1.aaa], nothing ahead -> ENTERS
 *   B  links 1.bbb, sees [1.aaa, 1.bbb], nothing sorts below it -> ENTERS
 *
 * Both are correct about what they saw; A's view was simply taken before B
 * existed. This is Lamport's bakery doorway, and it has the same answer: a
 * claimant announces that it is CHOOSING before it reads, and no one may
 * conclude the queue is empty ahead of them while any announcement is open.
 * Once a door closes, that claimant's entry is already published, so a view
 * taken with no doors open is complete.
 *
 * A DOOR IS JUDGED BY EXACTLY THE RULE AN ENTRY IS JUDGED BY (`entryBlocks`),
 * with a shorter window: it blocks while it is YOUNG **or** written by a live
 * process. The two are deliberately the same shape, because they answer the
 * same question — "might this file belong to a process that is still working?"
 * — and the two ways of being wrong are not symmetric in either case.
 *
 * CONSTRAINT: the age test may not be an early RETURN.
 * Written as "young AND alive" a door carrying a live, probeable pid backdated
 * six seconds was walked past in a millisecond and then deleted — readmitting
 * verbatim the two-process ticket race the doorway was added to close (~6% of
 * 150 trials): two claimants read the same queue, take the same ticket, and
 * both enter one Double Ratchet read-modify-write.
 *
 * THE OR DID NOT CLOSE THE OTHER HALF, and the earlier version of this comment
 * claimed it had. A door whose writer cannot be PROBED is
 * read as dead by `holderIsAlive`, so for such a door the OR collapses to
 * age-only and a live claimant stops blocking after DOOR_MAX_MS. The route
 * that mattered was `myIncarnation` memoising its own probe FAILURE, which
 * made every token a process wrote unverifiable for the rest of its life after
 * a single failed `ps`; that is fixed at the source, in `myIncarnation`, and
 * this predicate is not what fixed it. What remains is the honest residual: on
 * a platform where nobody can be probed at all, an unverifiable door older than
 * DOOR_MAX_MS IS collected while possibly live, because the alternative is an
 * account wedged forever by a corpse nobody can identify. See
 * UNKNOWN_INCARNATION, which makes the same trade for entries.
 *
 * So the cost of the OR is bounded but NOT free: a corpse from a claimant
 * killed mid-choice stalls others for at most DOOR_MAX_MS out of a 10-second
 * budget and is then collected, which is safe because the name carries a
 * 128-bit nonce and is never minted twice — while an unverifiable LIVE door
 * past that window is collected too, which is not safe and is accepted only
 * because it requires a platform where the probe never works.
 */
function doorBlocks(path: string): boolean {
  // Freshness first, for the reason spelled out in `entryBlocks`: these are an
  // OR, and `holderIsAlive` costs a `ps` spawn on macOS inside a 25ms poll.
  try {
    if (Date.now() - lstatSync(path).mtimeMs <= DOOR_MAX_MS) return true;
  } catch {
    return false; // closed between listing and stat: it blocks nobody
  }
  return holderIsAlive(path);
}

/**
 * What a read of the lock directory produced.
 *
 * CONSTRAINT: a read that FAILED is not an empty directory, and callers must
 * not be able to conflate them by accident — hence a value they have to
 * destructure rather than an array that silently reads as "nothing here".
 * `gone` is ENOENT and only ENOENT: the directory is provably absent, which
 * the caller repairs by rebuilding and re-staging. Everything else is
 * `unreadable` — EMFILE at the descriptor ceiling, EACCES on a directory an
 * operator chmod'ed, ENOTDIR if something replaced it with a file — and the
 * only safe reading of "I cannot see the queue" is to wait and look again.
 */
type DirRead = string[] | 'gone' | 'unreadable';

function readLockDir(lockPath: string): DirRead {
  try {
    return readdirSync(lockPath);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'gone' : 'unreadable';
  }
}

/** Open doorways, in no particular order. */
function listDoors(lockPath: string): DirRead {
  const names = readLockDir(lockPath);
  if (typeof names === 'string') return names;
  return names.filter((name) => DOOR_RE.test(name));
}

/**
 * Does this entry stand between us and the lock?
 *
 * Two independent reasons to yield, because each covers the other's blind
 * spot. A LIVE writer is the obvious one. A YOUNG entry blocks even when its
 * writer looks dead, because "looks dead" has failure modes — an unparseable
 * token, a `ps` that could not answer, a pid in another user's namespace —
 * and an entry created seconds ago is far more likely a healthy holder this
 * process cannot inspect than a corpse. Waiting costs a bounded 10 seconds;
 * being wrong costs a corrupted ratchet.
 */
function entryBlocks(path: string): boolean {
  // Freshness first, and the order is load-bearing rather than stylistic.
  // These are an OR, so either may be evaluated first — but `holderIsAlive`
  // costs a `ps` spawn on macOS and the contention loop below re-runs this
  // every 25ms, so probing liveness first meant waiting on a perfectly
  // healthy holder burned about forty subprocesses a second. An lstat decides
  // the common case; the expensive question is asked only about an entry that
  // is already older than the window, i.e. only when recovering a corpse.
  try {
    if (Date.now() - lstatSync(path).mtimeMs <= LOCK_STALE_MS) return true;
  } catch {
    return false; // vanished between listing and stat: it blocks nobody
  }
  return holderIsAlive(path);
}

/** Holder entries, in queue order. Anything else in the directory (staging
 * files, junk) is not a holder and is ignored rather than removed: this
 * function is called on the contention path and must never be destructive.
 * Returns `gone`/`unreadable` rather than `[]` when the read itself failed —
 * see `DirRead`; every caller here reads an empty queue as licence to enter. */
function listEntries(lockPath: string): DirRead {
  const names = readLockDir(lockPath);
  if (typeof names === 'string') return names;
  return names.filter((name) => ENTRY_RE.test(name)).sort();
}

/**
 * The lock directory, created if absent.
 *
 * A PLAIN FILE at this path is a lock written by a build of this CLI from
 * before the single-use-pathname design. No released binary ever wrote one,
 * so this exists to keep a developer's working tree from wedging across the
 * change rather than as a compatibility guarantee: the two schemes cannot
 * actually exclude each other, since they contend on different paths. It is
 * therefore conservative in the only direction that matters — if the old file
 * still blocks, refuse; only a provably abandoned one is cleared.
 */
function ensureLockDir(lockPath: string): void {
  try {
    mkdirSync(lockPath, { recursive: true, mode: 0o700 });
    return; // created, or already a directory
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EEXIST' && code !== 'ENOTDIR') {
      throw new CliError(EXIT.ERROR, `cannot create the account lock (${lockPath}): ${code}`);
    }
  }
  if (entryBlocks(lockPath)) {
    throw new CliError(
      EXIT.ERROR,
      `another tacendum process is using this account (${lockPath} is held). ` +
        `Wait for it to finish; if nothing else is running, remove it: rm ${lockPath}`,
    );
  }
  try {
    unlinkSync(lockPath);
  } catch {
    // Someone else cleared it first; mkdir below decides the outcome.
  }
  try {
    mkdirSync(lockPath, { recursive: true, mode: 0o700 });
  } catch (err) {
    throw new CliError(
      EXIT.ERROR,
      `cannot create the account lock (${lockPath}): ${
        (err as NodeJS.ErrnoException).code ?? (err as Error).message
      }`,
    );
  }
}

/**
 * Block until the lock is ours, or return null once `waitMs` is spent.
 *
 * The null is what lets a caller DECLINE rather than fail: attend's second
 * pass wants "somebody else is doing this turn, stand down", which is a normal
 * outcome, not an error, and routing it through an exception forced every
 * caller to tell contention apart from a broken lock directory by matching the
 * message prose (msglog's `isLockContention` still does, for the throwing
 * wrapper). Only the DEADLINE returns null; a lock directory that cannot be
 * created or read still throws, because that is not somebody else's turn.
 */
function acquireOrNull(lockPath: string, waitMs: number): LockHandle | null {
  ensureLockDir(lockPath);

  // A token, not just the pid: it is what `holderIsAlive` reads to decide
  // whether the process that published an entry is still running.
  const token = `${process.pid}:${myIncarnation()}:${randomBytes(8).toString('hex')}`;

  // Staged privately, then published with link(): the entry appears whole or
  // not at all. A token torn just after its second ':' is byte-shaped like
  // the complete legacy `pid:hex` form, which is honoured for as long as
  // ANYTHING wears that pid, so a fragment visible to a reader could outlive
  // its crashed writer as an unbounded wedge.
  const stagePath = join(lockPath, `.stage.${process.pid}.${randomBytes(16).toString('hex')}`);
  // Re-stageable, because the staging file lives INSIDE the lock directory
  // and an operator following a timeout remedy (`rm -rf ratchet.lock`) can
  // take both away mid-acquisition. Without this the command died on a bare
  // ENOENT from link(); with it, the directory is simply rebuilt and the
  // claim restarted, which is what a lock that recovers from a corpse should
  // also do when the corpse is removed by hand.
  const stage = (): void => {
    let fd: number;
    try {
      fd = openSync(stagePath, 'wx', FILE_MODE);
    } catch (err) {
      throw new CliError(
        EXIT.ERROR,
        `cannot stage the account lock (${stagePath}): ${
          (err as NodeJS.ErrnoException).code ?? (err as Error).message
        }`,
      );
    }
    writeToken(fd, stagePath, token);
  };
  stage();

  /**
   * What one trip through the doorway produced.
   *
   * `restage` means the lock directory is provably gone and our staging file
   * with it; `retry` means nothing was learned and the caller should look
   * again, bounded by the deadline. Neither is an error, and neither is a
   * ticket — which is the point of making them distinct values rather than
   * letting an empty-looking queue stand in for both.
   */
  type Ticket = { kind: 'took'; name: string } | { kind: 'restage' } | { kind: 'retry' };

  /**
   * Open the doorway, read the queue, publish our entry, close the doorway.
   *
   * CONSTRAINT: the door must be closed on EVERY exit from
   * here, and the way that is guaranteed is structural — the door's name is a
   * local this function alone can see, and it is unlinked by this function's
   * own `finally`. It used to be a variable in the enclosing scope closed by
   * calls sprinkled along the success paths, and two `continue`s re-entered
   * the branch and overwrote the name without closing the old door; a single
   * observed acquisition leaked 197 of them. That was survivable only while a
   * door belonging to a live process blocked nobody. Now that one does (see
   * `doorBlocks`), a single leaked door wedges the account for the entire
   * lifetime of the process that leaked it, so a path that can forget to
   * close one may not exist.
   */
  const takeTicket = (): Ticket => {
    // THE DOORWAY OPENS HERE, before the read below, and closes only once
    // this claimant is published. See `doorBlocks`.
    const door = join(lockPath, `.door.${randomBytes(16).toString('hex')}`);
    try {
      linkSync(stagePath, door);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // Nothing was created, so there is nothing to close: returning before
      // the try/finally below is the only path on which that is true.
      if (code === 'ENOENT') return { kind: 'restage' };
      throw new CliError(EXIT.ERROR, `cannot take the account lock (${lockPath}): ${code}`);
    }
    try {
      // Take the next free ticket. Two racers can still compute the same
      // seq; their nonces differ, both entries exist, and the lower nonce
      // wins the tie — sound now that the doorway keeps either of them from
      // deciding before the other has published.
      const entries = listEntries(lockPath);
      if (entries === 'gone') return { kind: 'restage' };
      // A queue we could not READ is not an empty queue. Treating it as one
      // made a claimant take ticket 1 while a live holder sat on ticket 5 —
      // and 1 sorts below 5, so nothing was ahead of it and it entered
      // alongside the holder (see `DirRead`).
      if (entries === 'unreadable') return { kind: 'retry' };
      const last = entries[entries.length - 1];
      const seq = last === undefined ? 1 : Number(last.slice(0, SEQ_WIDTH)) + 1;
      // A FRESH nonce every attempt, exactly as the door above gets one, and
      // for the same reason: a re-queue must not reuse a name another process
      // may already have judged abandoned, or that process's stale verdict
      // ("collect that entry") lands on our new, live one. Minted once per
      // acquisition it also spun forever against our OWN earlier entry —
      // EEXIST on every attempt, with the deadline as the only exit.
      const name = `${String(seq).padStart(SEQ_WIDTH, '0')}.${randomBytes(16).toString('hex')}`;
      const candidate = join(lockPath, name);
      // Freshen first: `entryBlocks` treats a young entry as a holder, and
      // a claimer stopped between staging and publishing would otherwise
      // publish an entry that is already past the threshold at birth.
      try {
        const now = new Date();
        utimesSync(stagePath, now, now);
        linkSync(stagePath, candidate);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        // The directory (and with it our staging file) was removed under us.
        if (code === 'ENOENT') return { kind: 'restage' };
        // EEXIST needs a 128-bit nonce collision, but a full disk, a
        // read-only mount or a link-less filesystem must surface as itself
        // rather than spin here and then report a lock nobody holds.
        if (code !== 'EEXIST') {
          throw new CliError(EXIT.ERROR, `cannot take the account lock (${candidate}): ${code}`);
        }
        return { kind: 'retry' };
      }
      return { kind: 'took', name };
    } finally {
      try {
        unlinkSync(door);
      } catch {
        // Already collected as abandoned. Leaving one behind would stall
        // other claimants until it is both past DOOR_MAX_MS and unprobeable,
        // never longer, and never wrongly admit one.
      }
    }
  };

  const deadline = Date.now() + waitMs;
  let mine: string | undefined;
  let attempts = 0;
  try {
    for (;;) {
      // Checked on EVERY iteration, re-queues included: a process that keeps
      // losing the queue must still end in a refusal, not an unbounded loop.
      //
      // NOT on the first one, though, and that guard is what makes `waitMs: 0`
      // mean "one honest attempt" instead of "always fail". Without it a zero
      // budget is already spent when the loop opens, so the lock is reported
      // held before anything has looked at it — and attend's second pass, the
      // caller that wants the shortest possible budget, would have declined
      // every turn including the ones nobody else was running.
      if (attempts++ > 0 && Date.now() > deadline) {
        // Our own ticket must not outlive the attempt that took it: left
        // behind it blocks the next contender for LOCK_STALE_MS for nothing.
        // The throwing wrapper's catch does this too, and a `return` does not
        // run a catch — hence the explicit cleanup here.
        if (mine !== undefined) {
          try {
            unlinkSync(join(lockPath, mine));
          } catch {
            // Already collected; the null below is the outcome that matters.
          }
          mine = undefined;
        }
        return null;
      }

      if (mine === undefined) {
        const ticket = takeTicket();
        if (ticket.kind === 'restage') {
          ensureLockDir(lockPath);
          stage();
          continue;
        }
        if (ticket.kind === 'retry') {
          sleepSync(25);
          continue;
        }
        mine = ticket.name;
      }

      // DOORS ARE READ BEFORE THE QUEUE, AND THE ORDER IS THE PROOF.
      //
      // Lamport checks `choosing[]` before comparing tickets. This loop had it
      // the other way round — queue first, doors second — which is unsound for
      // a reason no run on this machine ever hit. Let T be a claimant that read
      // the queue before we published, so it can tie our seq and undercut our
      // nonce:
      //
      //   us: read queue   -> T is not there yet, nothing sorts ahead of us
      //   T:  publish 1.T     (a lower nonce, so it IS ahead of us)
      //   T:  close its door
      //   us: read doors   -> none open, T's is already closed
      //   both enter, and two writers share one Double Ratchet
      //
      // Our two reads straddled T's whole publish-and-close, so we saw neither
      // its ticket nor its door. Reading doors FIRST closes that: anyone whose
      // door is open we wait for, and anyone who opens a door after this read
      // must read the queue after our ticket is already in it, so their seq is
      // strictly greater and they cannot be ahead of us. No interleaving is
      // left in which a claimant ahead of us is invisible to both reads.
      //
      // Our own door is already closed — `takeTicket` closes it before
      // returning a ticket — so nothing here can wait on itself.
      const doors = listDoors(lockPath);
      if (doors === 'gone') {
        mine = undefined;
        ensureLockDir(lockPath);
        stage();
        continue;
      }
      if (doors === 'unreadable') {
        // Same rule as the queue read below: "I cannot see whether anyone is
        // still choosing" is not "nobody is".
        sleepSync(25);
        continue;
      }
      if (doors.some((name) => doorBlocks(join(lockPath, name)))) {
        sleepSync(25);
        continue;
      }

      const entries = listEntries(lockPath);
      if (entries === 'gone') {
        // The directory went, and our ticket and staging file with it. Rebuild
        // both and contend again rather than waiting on a queue that no longer
        // exists; the deadline still bounds this.
        mine = undefined;
        ensureLockDir(lockPath);
        stage();
        continue;
      }
      if (entries === 'unreadable') {
        // A read that failed cannot be told from a directory in which our
        // ticket was collected, and the two want opposite actions — wait, or
        // rejoin the queue. Waiting is the one that cannot admit a second
        // writer, and the deadline bounds it.
        sleepSync(25);
        continue;
      }
      if (!entries.includes(mine)) {
        // Our ticket was cleared as abandoned — we stalled past the
        // threshold. Whatever holds the lock now is not ours to touch, so
        // rejoin the queue at the back rather than assuming anything.
        mine = undefined;
        continue;
      }

      // The holder is the lowest-ordered entry that still blocks. Nothing is
      // removed to make that true; entries ahead of us are simply read.
      const myName = mine;
      const ahead = entries.filter((name) => name < myName);
      if (ahead.some((name) => entryBlocks(join(lockPath, name)))) {
        sleepSync(25);
        continue;
      }

      // We hold it. The abandoned doors and tickets can go now: each name is
      // single-use, so removing one we judged abandoned can never remove a
      // live claimant's ENTRY — an entry is only judged abandoned when it is
      // both stale and unverifiable, and the nonce means the name cannot be
      // reused, which is the point of the redesign. Doors are a weaker claim
      // and `doorBlocks` says so: an unprobeable door past DOOR_MAX_MS can be
      // collected while its writer lives. Collected
      // HERE and not at the door check above, because a process that yields on
      // the queue below would otherwise sweep doors it is not the winner for.
      for (const name of doors) {
        try {
          unlinkSync(join(lockPath, name));
        } catch {
          // Collected by someone else; nothing here is load-bearing.
        }
      }
      for (const name of ahead) {
        try {
          unlinkSync(join(lockPath, name));
        } catch {
          // Already collected by someone else. Nothing here is load-bearing.
        }
      }
      return { path: join(lockPath, mine) };
    }
  } catch (err) {
    // Never leave our own ticket behind on a refusal: it blocks later
    // contenders for no reason. The door needs no handling here — it belongs
    // to `takeTicket` and is closed by that function's own finally.
    if (mine !== undefined) {
      try {
        unlinkSync(join(lockPath, mine));
      } catch {
        // Already gone; the throw below is the outcome that matters.
      }
    }
    throw err;
  } finally {
    // The staging link is spent on every path: on success the entry lives on
    // as the second link to the same inode; on failure nothing may remain.
    try {
      rmSync(stagePath, { force: true });
    } catch {
      // An orphaned staging file is inert — it does not match ENTRY_RE, so
      // nothing lists, reads or classifies it — and removing it must not
      // mask the real outcome.
    }
  }
}

/**
 * Unlink our entry. Unconditionally, and by name.
 *
 * THERE IS NOTHING TO VERIFY. This function used to open
 * `handle.path`, compare the file's dev/ino against the one acquisition
 * created and its bytes against the token, and return WITHOUT unlinking on
 * any mismatch or any error. That check is a fossil of the design where a
 * lock lived at ONE reusable pathname: there, a process that had been
 * classified dead could find a REPLACEMENT lock at its path, and removing it
 * would release a lock somebody else was holding. Under single-use
 * `<seq>.<nonce>` names — a 128-bit nonce, never minted twice — `handle.path`
 * can only ever name the entry THIS call created. It is that file or it is
 * nothing, so there is no third case for a verification to distinguish.
 *
 * And the verification could only fail in the direction that hurts. openSync
 * throws EMFILE, not ENOENT, when a `listen` daemon reaches its descriptor
 * ceiling; the blanket catch read that as "not provably ours, leave it", and
 * the entry it left behind carried the daemon's own live pid and matching
 * incarnation. Every later acquisition — the daemon's own included — then
 * blocked on it for as long as the daemon ran, clearable only by `rm -rf`. A
 * check that cannot distinguish anything real and fails open into a permanent
 * wedge is worse than no check.
 *
 * `force` because ENOENT is a legitimate outcome: a claimer that stalled past
 * LOCK_STALE_MS has its ticket collected by the next winner, and finding it
 * already gone is exactly what should happen then.
 */
function release(handle: LockHandle): void {
  rmSync(handle.path, { force: true });
}

/**
 * Block until the lock is ours, or throw. The refusal message is load-bearing
 * prose: msglog's `isLockContention` matches ` is held).` on it to tell a
 * contended sweep apart from a broken lock directory.
 */
function acquire(lockPath: string, waitMs: number = LOCK_WAIT_MS): LockHandle {
  const held = acquireOrNull(lockPath, waitMs);
  if (held !== null) return held;
  throw new CliError(
    EXIT.ERROR,
    `another tacendum process is using this account (${lockPath} is held). ` +
      `Wait for it to finish; if nothing else is running, remove it: rm -rf ${lockPath}`,
  );
}

/**
 * Run `fn` while holding `lockPath`. Released on every path, including throw.
 *
 * Not re-entrant: a nested call on the same path in the same process would
 * deadlock against itself, so callers hold it at exactly one level.
 */
export function withFileLock<T>(lockPath: string, fn: () => T): T {
  const held = acquire(lockPath);
  try {
    return fn();
  } finally {
    release(held);
  }
}

/**
 * What `tryFileLockAsync` produces. A discriminated result rather than
 * `T | null`, because `fn` is entitled to return null itself and a caller that
 * cannot tell "the work said null" from "somebody else holds the lock" will
 * eventually act on the wrong one.
 */
export type TryLock<T> = { held: true; value: T } | { held: false };

/**
 * Hold `lockPath` for the duration of `fn`, or DECLINE.
 *
 * For work that is genuinely somebody-else's-turn-shaped: a second attend pass
 * must not queue behind a turn that runs for minutes, and must not fail
 * loudly either — its answer is "the other pass has this", which is neither an
 * error nor a reason to duplicate the work.
 *
 * `waitMs` defaults to a fraction of `LOCK_WAIT_MS` rather than to it: the
 * budget here is sized to clear the doorway protocol's 25ms polls (so a
 * momentary tie-break is not misreported as "held"), not to outlast a live
 * holder, and a decliner that waited 45 seconds would be a supervised loop
 * stalled 45 seconds per pass.
 *
 * Like `withFileLockAsync` it AWAITS inside the try — see the note there.
 */
export async function tryFileLockAsync<T>(
  lockPath: string,
  fn: () => Promise<T>,
  waitMs = 1_000,
): Promise<TryLock<T>> {
  const held = acquireOrNull(lockPath, waitMs);
  if (held === null) return { held: false };
  try {
    return { held: true, value: await fn() };
  } finally {
    release(held);
  }
}

/**
 * The async form — the ratchet calls are promise-returning.
 *
 * It has to AWAIT inside the try. The tempting one-liner
 * (`withFileLock(path, () => fn())`) returns the promise to a synchronous
 * `finally`, which releases the lock immediately and leaves the actual work
 * running unprotected — a lock that reports success and guards nothing.
 */
export async function withFileLockAsync<T>(
  lockPath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const held = acquire(lockPath);
  try {
    return await fn();
  } finally {
    release(held);
  }
}
