import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ErrorCode, LibSignalErrorBase } from '@signalapp/libsignal-client';
import { apiGetAttachmentUrl, downloadBlob, type Credential } from './api.js';
import { BlobCipherError, decryptBlob } from './attachments.js';
import { b64ToBytes } from './bytes.js';
import { decryptEnvelope, isIdentityChange } from './messaging.js';
import { RETAIN_MS, UNDELIVERED_FILE, type MessageLog, type MessageRecord } from './msglog.js';
import type { Reporter } from './output.js';
import { maySpool, prefixLines, renderBody, sanitizeServerField } from './render.js';
import { groupBodyRenderer, mentionNames } from './room-render.js';
import { isBlocked } from './blocked.js';
import { CliError } from './exit.js';
import { writeFileAtomic, type FileStores } from './stores.js';
import { stateDir } from './config.js';
import { withFileLock, withFileLockAsync } from './lock.js';
import type { WsClient } from './wsclient.js';

/**
 * The one inbound policy in this CLI, moved out of `main.ts`
 * when the message log made it worth testing directly.
 * `listen`, `sync` and `send --drain` all install it, so there is exactly one
 * place where a frame's fate is decided.
 */

export interface InboundOptions {
  name: string;
  userId: string;
  stores: FileStores;
  ws: WsClient;
  report: Reporter;
  /** The durable message log. Written on every consumed message. */
  log: MessageLog;
  /**
   * Decrypt, render and ACK this account's own queue. `listen` does; `send`
   * does not unless asked. See the doc block below for why that asymmetry is
   * deliberate.
   */
  consume: boolean;
  /**
   * When set, a 1:1 `file` envelope's blob is fetched, decrypted and written
   * under `saveDir` AT RECEIVE TIME — the only moment the capability exists,
   * because the spool refuses to store attachment ids and keys (msglog.ts's
   * store-less rule, kept). Best-effort and post-ack: a failed download is a
   * note, never a re-ack and never a retry — the ratchet cannot decrypt a
   * redelivery anyway. Room file envelopes render withheld and are NOT saved
   * in this phase.
   */
  attachments?: { token: Credential; saveDir: string } | undefined;
  /**
   * `listen --detail` (§3.7): print a message's DETAIL after its
   * brief, and carry it in the `--json` record. OFF by default, in both
   * modes, and the default is the decision — `listen` is a stream people
   * grep, and a 3 000-character finding wrapping between two `[peer] …` lines
   * would end that. Brief-first everywhere; the rest on request.
   *
   * `sync` and `send --drain` never set it: they are not reading surfaces,
   * and `tacendum inbox --detail` is where a spooled detail is read.
   */
  detail?: boolean | undefined;
}

export interface Inbound {
  /** Every frame seen so far has finished processing. */
  settled(): Promise<void>;
  /** Messages decrypted and acked by this handler. */
  readonly consumed: number;
  /** The one-line summary a non-consuming caller owes the operator. */
  report(): void;
}

/**
 * Detect a LOCAL store failure inside a libsignal call.
 *
 * When a store callback throws, libsignal does not propagate the original —
 * it wraps it in a LibSignalErrorBase with code Generic, erasing
 * `code`/`errno`/CliError-ness entirely, so BY TYPE the failure is
 * indistinguishable from tampered ciphertext (verified against
 * libsignal-client 0.98.0: `error in method call 'storeSession': Error:
 * ENOSPC…`, code 0). Matching the wrapper's message text would be a match
 * against prose (the exit.ts lesson), so detection is structural: the stores
 * record any throw that crosses the store boundary, the caller arms the
 * record before the decrypt and asks it afterwards.
 *
 * This probe used to instrument three WRITE methods here at the consumer, and
 * that list was the defect it now documents: identity READS (`exists`/`load`
 * resolve through `readCredential`, which THROWS on a locked or unreachable
 * keychain — by design, refusing beats answering "absent") fell straight
 * through it, so a locked keychain classified as tamper and the ACK deleted
 * the server's only copy of a fully retryable message. The recording now
 * lives in stores.ts (`recordThrowsAcrossStoreBoundary`), first-party and
 * boundary-wide — every method of every store object libsignal touches,
 * reads included, enumerated from the real prototype chains at construction —
 * exactly the recorder this comment used to say the probe should be deleted
 * in favour of. The probe interface survives as the per-decrypt arm/ask
 * discipline both inbound paths already share.
 */
export interface StorePersistenceProbe {
  /** Forget anything recorded before this decrypt. */
  arm(): void;
  /** Did OUR store code throw — read, write, or refusal — since `arm()`? */
  failed(): boolean;
  /** The recorded throw itself — the error as OUR code raised it, before
   * libsignal's wrapper erased its type and errno. `undefined` iff `failed()`
   * is false. Consumed only by `describeLocalFailure`; the wrapper the
   * handlers caught must never be the one described, because its message
   * embeds the failing file path and the path embeds the account name. */
  failure(): unknown;
}

export function probeStorePersistence(stores: FileStores): StorePersistenceProbe {
  return {
    arm: () => stores.armStoreBoundary(),
    failed: () => stores.storeBoundaryFailed(),
    failure: () => stores.storeBoundaryFailure(),
  };
}

/**
 * WHAT MAY TRAVEL IN AN OPERATOR NOTE ABOUT A LOCAL FAILURE — one rule, one
 * function, both inbound handlers.
 *
 * The notes these feed reach operator terminals, hook logs and CI logs. The
 * account name is a caller-supplied value (`--name "$VAR"` is one bad env var
 * away from a secret), and it is embedded in EVERY path under the state
 * directory — so any exception message that quotes a path (every Node fs
 * error does) is a leak. Three things are allowed to travel, nothing else:
 *
 *  - an errno code, shape-checked against the OS vocabulary (`E[A-Z0-9]+`,
 *    the same check `readCredentialGuarded` in stores.ts applies) so an
 *    exotic error object cannot smuggle arbitrary text through the slot;
 *  - repo-authored fixed prose;
 *  - the message of a CliError that crossed the STORE boundary — and only
 *    that provenance. Every CliError a libsignal store callback can raise is
 *    minted in keychain.ts (`describeFailure`: fixed classification strings,
 *    verified 2026-07-31) or in stores.ts (`readCredentialGuarded` /
 *    `parseCredential`: fixed prose plus a shape-checked errno), and each is
 *    certified value-free by construction. A DIRECT CliError — one the
 *    handler caught unwrapped — has no such certificate: the ratchet-lock
 *    refusals in lock.ts deliberately embed the lock path as a remedy
 *    (`rm -rf ${lockPath}`), and that path carries the account name, so its
 *    message may NOT travel here. Those still print in full where a wedged
 *    lock actually gets fixed: the top-level CliError handler of whatever
 *    command hit it next.
 */
export function localErrno(err: unknown): string {
  // THE READ IS GUARDED BECAUSE THIS RUNS INSIDE THE FAILURE HANDLER. Reading
  // `.code` is a property access, and a property access can execute code: a
  // getter that throws, or a Proxy whose trap throws, turns this line into an
  // exception raised while we are already describing an exception. A reviewer
  // demonstrated all three shapes throwing here (2026-07-31). They degraded
  // safely — the outer frame catch reported `frame processing error` and the
  // queue recovered — so this is hardening, not a repair. It is worth doing
  // anyway: a throw from inside the code that explains a throw is the shape
  // that makes an incident unreadable, and no producer we actually have
  // (libsignal, node:fs) needs the leniency.
  let code: unknown;
  try {
    code = (err as NodeJS.ErrnoException | null | undefined)?.code;
  } catch {
    return 'unclassified';
  }
  return typeof code === 'string' && /^E[A-Z0-9]{1,16}$/.test(code) ? code : 'unclassified';
}

export function describeLocalFailure(err: unknown, probe: StorePersistenceProbe): string {
  if (probe.failed()) {
    const original = probe.failure();
    if (original instanceof CliError) return original.message;
    return `a local store operation failed (${localErrno(original)})`;
  }
  if (err instanceof CliError) {
    // The pre-decrypt refusal. In both handlers the only unwrapped CliError
    // source inside the decrypt try is `withFileLockAsync` on the ratchet
    // lock — `decryptEnvelope` is pure libsignal plus stores (verified
    // 2026-07-31), and a store throw arrives wrapped, with the probe set.
    return 'could not take this account’s ratchet lock — another tacendum process may be using it';
  }
  return `a local store operation failed (${localErrno(err)})`;
}

/**
 * The tamper-branch diagnostic, shared by both handlers for the same
 * divergence reason as the classifier. An undecryptable error's text is
 * library-authored but DERIVED from bytes the peer and the server chose, and
 * nothing certifies it free of control bytes or bounded — so it gets exactly
 * the treatment the server's own error frames get: stripped and bounded
 * (`sanitizeServerField`), never dropped, because "which libsignal error"
 * is the one diagnostic a tamper report has.
 */
export function describeUndecryptable(err: unknown): string {
  if (!(err instanceof Error)) return 'unknown error';
  // String() first: the old `err.name + ': ' + err.message` coerced, and an
  // exception object with a non-string `name` must degrade to coercion here
  // too, not to a throw inside the failure handler.
  return `${sanitizeServerField(String(err.name), 64)}: ${sanitizeServerField(String(err.message), 200)}`;
}

/**
 * THE classifier for a failed inbound decrypt — one function, called by both
 * inbound paths.
 *
 * CONSTRAINT: there is exactly one place in this CLI that decides what a
 * decrypt failure MEANS, and no call site may re-derive it. An earlier revision fixed the
 * duplicate misdiagnosis inside `attachInbound` and exported an
 * `isRatchetDuplicate` predicate "because the CallSession mirror owes the
 * identical classification" — and the mirror never imported it. Concretely:
 * `listen --calls` decrypts a frame, the process is killed after libsignal has
 * durably advanced the ratchet but before the spool append, the server
 * redelivers the same bytes, libsignal raises DuplicatedMessage, and for a
 * whole round that fell through to CallSession's tamper branch, which acked
 * the row away while telling the operator "message rejected" — a valid,
 * unrecoverable message reported as an attacker's poison. A predicate the
 * second call site is TRUSTED to remember is a rule that diverges; a total
 * function returning a closed union, switched on exhaustively at both sites
 * (see `assertAllDispositionsHandled`), is one that cannot — adding a
 * disposition fails to compile in both places at once.
 *
 * THE ORDER IS PART OF THE RULE, not an implementation detail:
 *  1. identity change — the peer's key is not the pinned one. The ciphertext
 *     was never opened; the message must stay queued for `tacendum trust`.
 *  2. LOCAL failure — the ratchet lock refused (a CliError, thrown before any
 *     ciphertext was examined) or OUR store code threw DURING the decrypt:
 *     a write that failed (ENOSPC on the session save), a READ that refused
 *    ,
 *     or any store error not yet imagined. libsignal wraps whatever a store
 *     callback throws in a code-Generic LibSignalErrorBase that erases the
 *     errno and the type, so BY TYPE it is indistinguishable from tamper and
 *     only the armed probe — fed by the boundary-wide recorder in stores.ts —
 *     can tell them apart. Checked BEFORE the duplicate test because our
 *     machine failing must never be read as anything the peer's bytes did.
 *  3. ratchet duplicate — libsignal refused ciphertext THIS ratchet has
 *     already consumed. Structural, by error code, never a match against
 *     prose. A flipped byte fails deserialization or authentication, never
 *     duplicate detection, so only bytes this ratchet genuinely opened once
 *     (or a byte-exact replay of them) land here.
 *  4. everything else — tampered or corrupt ciphertext.
 */
export type DecryptDisposition =
  | 'identity-change'
  | 'local-failure'
  | 'ratchet-duplicate'
  | 'undecryptable';

export function classifyDecryptFailure(
  err: unknown,
  probe: StorePersistenceProbe,
): DecryptDisposition {
  if (isIdentityChange(err)) return 'identity-change';
  if (err instanceof CliError || probe.failed()) return 'local-failure';
  if (err instanceof LibSignalErrorBase && err.code === ErrorCode.DuplicatedMessage) {
    return 'ratchet-duplicate';
  }
  return 'undecryptable';
}

/**
 * Compile-time proof that a call site handles every disposition.
 *
 * CONSTRAINT: a disposition added to the union must break the build at EVERY
 * inbound path, not silently fall into whichever branch happens to be last.
 * That silent fall-through is precisely how DuplicatedMessage spent a round
 * being acked away as tamper by `listen --calls`. Each handler ends with
 * `if (d !== 'undecryptable') assertAllDispositionsHandled(d)`, so a new
 * member narrows to something that is not `never` and fails to compile there.
 */
export function assertAllDispositionsHandled(d: never): never {
  throw new Error(`unhandled decrypt disposition: ${String(d)}`);
}

/**
 * THE disposition for a ratchet duplicate, shared by both inbound paths.
 *
 * CONSTRAINT: purging a duplicate is never silent. Reaching here means
 * `hasSeen` was false, so either a previous run died between the decrypt's
 * durable ratchet commit and the spool append — the server redelivers the
 * unacked row and the plaintext existed only in that dead process's memory —
 * or a sibling process draining the same queue consumed it a moment ago and
 * its spool record explains everything. The spool is the witness that
 * separates the two.
 *
 * Purge either way: the message key is destroyed, so every redelivery until
 * the 30-day TTL would fail exactly here and the ack costs nothing that still
 * exists. What must not happen — the concrete failure this function prevents
 * — is the old behaviour on both paths: reporting a LOST VALID MESSAGE as
 * rejected poison, which tells the operator the opposite of the truth.
 *
 * Rule 4: the alarm names the msgId and the (already display-sanitized) peer
 * address and nothing else. There is no plaintext to leak here — the decrypt
 * failed — and `delivered` is a boolean derived from ids, never from bodies.
 *
 * Residual, stated precisely: a byte-exact replay of captured ciphertext (and
 * a sibling's consumption of a never-spooled kind) is indistinguishable from
 * the crash loss and raises the same alarm; telling them apart would need a
 * pre-decrypt intent journal, which still could not recover the plaintext —
 * it would only rename the warning.
 */
export function purgeRatchetDuplicate(args: {
  msgId: string;
  /** The peer address AS SHOWN — sanitized by the caller before it gets here. */
  shownFrom: string;
  stores: Pick<FileStores, 'markSeen'>;
  ws: Pick<WsClient, 'send'>;
  log: Pick<MessageLog, 'read'>;
  /** The operator-facing stderr of the calling path. */
  note: (text: string) => void;
}): void {
  let delivered = false;
  try {
    // dir:'in' only: an outbound LEDGER row under a colliding id is not
    // proof this inbound message was ever delivered.
    delivered = args.log.read({ dir: 'in' }).some(rec => rec.id === args.msgId);
  } catch {
    // An unreadable spool cannot prove delivery, so it is reported below as
    // though it had not happened — a false alarm over a silent loss.
  }
  args.stores.markSeen(args.msgId);
  args.ws.send({ type: 'ack', msgId: args.msgId });
  if (delivered) return;
  args.note(
    `!! POSSIBLE MESSAGE LOSS msgId=${args.msgId} from=${args.shownFrom}: ` +
      `the ratchet already consumed this ciphertext but no delivery was ever recorded — ` +
      `most likely a previous run died between decrypt and spool write, and the ` +
      `plaintext is unrecoverable (a replay of captured ciphertext looks identical). ` +
      `Purging the server row; no retry can ever decrypt it again.`,
  );
}

/**
 * The undelivered quarantine.
 *
 * When the spool write fails AFTER a successful decrypt, "leave it queued and
 * fail closed" cannot make the message recoverable: the ratchet has already
 * been durably advanced, so the server's redelivery of the same bytes is
 * refused as a duplicate (redelivery.test.ts) and purged as poison on the
 * next connect. At that moment this process holds the LAST decryptable copy,
 * and a terminal that scrolls away is not custody — so the plaintext is
 * written here before giving up. Same compartment and rules as the spool it
 * substitutes for: under `state/<name>/` (never beside key material), 0600
 * with the same fail-closed permission checks, and nothing outlives the
 * 30-day retention ceiling. Every rewrite — any quarantine write, and
 * `pruneUndelivered` on every consuming attach — decides each existing row's
 * fate, and the full table is stated here because an operator repairing this
 * file by hand needs to know which rows survive the next attach:
 *   - trusted `ts` (a finite number in the local clock's past), unexpired:
 *     kept as-is; expired: dropped, even when it is the last copy — the
 *     ceiling outranks custody (tested: gate.acksafety "ages quarantined
 *     rows out").
 *   - untrusted `ts` (missing, non-numeric, or future-dated): the clock
 *     restarts — the row is rewritten with ts = now and ages out RETAIN_MS
 *     from that observation. Never dropped on sight, never kept forever.
 *   - a line that does not PARSE: dropped at the next rewrite, at ANY age —
 *     no grace period. (This writer is atomic, so a torn line is external
 *     damage, not a crashed quarantine write; see the loop below.)
 * Rows are MessageRecords, so `cat undelivered.jsonl >> messages.jsonl` is a
 * legitimate operator repair, and a hand-added row that parses survives at
 * least one full retention window even if its `ts` was mangled.
 *
 * Deliberately NOT under the msglog lock: a lock timeout is one of the spool
 * failures this file exists to survive, so sharing the lock would guarantee
 * the quarantine fails exactly when it is needed. It holds its OWN lock
 * instead: the rewrite is read-modify-rename, so two processes
 * quarantining the same instant both read the same rows, each appended only
 * its own, and the loser of the rename race had its row — the last copy of a
 * message — silently renamed away. undelivered.lock is only ever held across
 * this function's local file work, and failing to take it degrades to
 * refusing custody (null, reported by the caller), never to throwing into
 * the failure handler this code runs inside.
 */

/** Group/other permission bits; any of them refuses the write (msglog rule). */
const WORLD_BITS = 0o077;

export function undeliveredPath(name: string): string {
  return join(stateDir(name), UNDELIVERED_FILE);
}

/** Preserve one decrypted-but-unspoolable record. Returns the path on
 * success, null when the quarantine itself could not be written safely —
 * it NEVER throws, because it runs inside a failure handler. */
export function quarantineUndelivered(
  name: string,
  record: MessageRecord,
  now = Date.now(),
): string | null {
  return rewriteUndelivered(name, record, now);
}

/** Age out quarantined rows past the retention ceiling. Creates nothing. */
export function pruneUndelivered(name: string, now = Date.now()): void {
  rewriteUndelivered(name, null, now);
}

function rewriteUndelivered(
  name: string,
  record: MessageRecord | null,
  now: number,
): string | null {
  try {
    const dir = stateDir(name);
    const path = undeliveredPath(name);
    if (record === null && !existsSync(path)) return null;
    if (record !== null) {
      // 0700 like the spool's own ensureDir; a prune must not mint anything.
      mkdirSync(dirname(dir), { recursive: true, mode: 0o700 });
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    // lstat, so a symlinked state dir reads as "not a directory" and refuses.
    const dirStat = lstatSync(dir);
    if (!dirStat.isDirectory() || (dirStat.mode & WORLD_BITS) !== 0) return null;
    // The read below and the rename inside writeFileAtomic are one critical
    // section: unlocked, two processes quarantining at once each read the
    // same rows and the second rename discarded the first one's row. Every check on the FILE runs inside the lock, because the file a
    // waiter validated can be replaced before its turn comes.
    return withFileLock(join(dir, 'undelivered.lock'), () => {
      const kept: string[] = [];
      let dropped = 0;
      let clockRestarted = 0;
      let fd = -1;
      try {
        fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      } catch (err) {
        // Only "does not exist yet" is fine; a symlink (ELOOP) or unreadable
        // file means refusing to write plaintext next to something suspicious.
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return null;
      }
      if (fd >= 0) {
        try {
          const st = fstatSync(fd);
          if (!st.isFile() || st.nlink !== 1 || (st.mode & WORLD_BITS) !== 0) return null;
          for (const line of readFileSync(fd, 'utf8').split('\n')) {
            if (!line) continue;
            try {
              const parsed: unknown = JSON.parse(line);
              if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
                const ts = (parsed as { ts?: unknown }).ts;
                if (typeof ts === 'number' && Number.isFinite(ts) && ts <= now) {
                  // A trustworthy timestamp: age out on the retention clock,
                  // the same test `applyRetention` applies to the spool.
                  if (now - ts < RETAIN_MS) {
                    kept.push(line);
                    continue;
                  }
                } else {
                  // A ts this clock cannot measure — missing, non-numeric,
                  // NaN-producing, or claiming the future. Both easy answers
                  // shipped and both were wrong: this branch used to DROP such
                  // a row at any age (destroying what may be the last copy of
                  // a message the spool write failed on, while the comment
                  // below claimed it "ages out"), and `applyRetention` in
                  // msglog.ts still KEEPS the same row forever, because
                  // `now - ts >= RETAIN_MS` is false when the subtraction
                  // yields NaN or a huge negative — verified by execution
                  // 2026-07-30, and reachable from the wire: MsgFrame.ts is an
                  // unbounded server-controlled z.number(). Neither instant
                  // destruction nor immortality honours this file's contract
                  // (custody, bounded by the 30-day ceiling), so the clock
                  // RESTARTS: the row is rewritten with ts = now and ages out
                  // RETAIN_MS from this first observation. Idempotent — the
                  // rewritten ts is a finite number <= now, so every later
                  // pass takes the trusted branch above. The spool half of the
                  // disagreement stands (msglog.ts is another workstream's,
                  // committed) and is narrowed at the source instead: this
                  // file's inbound path caps the ts it persists at the local
                  // clock (see the append site), so a future-dated frame
                  // cannot seed either file through it.
                  kept.push(JSON.stringify({ ...parsed, ts: now }));
                  clockRestarted += 1;
                  continue;
                }
              }
              // Parseable but not an object (a bare number, string, array):
              // no reader can use it — dropped with the unparseable, below.
            } catch {
              // An UNPARSEABLE row is dropped HERE, AT ANY AGE — it does not
              // age out, and no grace period applies. That is deliberate and
              // matches the spool's own retention rule for unparseable lines
              // (`applyRetention` counts them in `dropped`). It is also not
              // custody abandoned: this file's writer is writeFileAtomic
              // (fsync + rename), so a torn line was never a crashed
              // quarantine write — it is external damage, and the documented
              // repair (`cat undelivered.jsonl >> messages.jsonl`) would only
              // feed it to a spool whose read() skips it and whose retention
              // drops it. An operator hand-repairing this file gets the grace
              // period only for lines that PARSE — the docblock above says so.
            }
            dropped += 1;
          }
        } finally {
          closeSync(fd);
        }
      }
      // THE CLAMP IS HERE, not at the callers, for the reason an earlier revision moved
      // the spool's clamp into `MessageLog.append`: a rule written at the call
      // sites diverges at the mirror, and this one already had. `attachInbound`
      // capped the `ts` it quarantines; `CallSession`, which quarantines
      // through this same function, handed the raw server value. Measured: the
      // same bytes and the same spool failure produced a row dated ~now on
      // `listen` and the year 2108 on `listen --calls`.
      //
      // A future `ts` matters because retention is `now - ts >= RETAIN_MS`,
      // which is false forever for a future date and for NaN — so the row, and
      // its plaintext body, outlive the 30-day custody ceiling. `MsgFrame.ts`
      // is an unbounded server-controlled `z.number()`, so the value is off the
      // wire. Written as "keep only what is provably retirable" rather than
      // "reject what is future", because `x > now` is false for NaN too.
      if (record !== null) {
        const retirable =
          Number.isFinite(record.ts) && record.ts <= now ? record : { ...record, ts: now };
        kept.push(JSON.stringify(retirable));
      }
      // A prune that changed nothing writes nothing. A restarted clock IS a
      // change: it exists only in the rewritten line, so skipping the write
      // would restart the same clock on every pass — a row that never ages.
      else if (dropped === 0 && clockRestarted === 0) return null;
      // Durable (fsync + dir fsync) via the shared atomic writer, 0600 — the
      // whole point is that this copy survives what the spool write did not.
      // "Durable" here rides on writeFileAtomic's DEFAULT parameter, and
      // until an earlier revision nothing asserted it: this exact call switched to
      // 'crash-consistent' left every pre-existing CLI test green (measured
      // 2026-07-30). gate.retention-seam test 7 now pins the fsync ordering,
      // so weakening either the default or this call fails there.
      writeFileAtomic(path, kept.length > 0 ? `${kept.join('\n')}\n` : '');
      return record !== null ? path : null;
    });
  } catch {
    return null;
  }
}

/**
 * ACK POLICY — six cases, and the invariant is `ack <=> markSeen` except
 * where noted:
 *   redelivery (already seen)  ack again, print nothing
 *   decrypt OK                 log (fsynced), markSeen, ack, render — in that
 *                              order: the ack deletes the server's only copy,
 *                              so nothing is acked that is not durable first
 *   spool write failed         NEITHER — preserve the plaintext in the
 *                              undelivered quarantine, render loudly, leave
 *                              the row queued (see the inline comment)
 *   identity change            NEITHER — the message stays queued and decrypts
 *                              after `tacendum trust` and a reconnect
 *   ratchet duplicate          markSeen + ack (no retry can ever decrypt it
 *                              again), and if the spool has no record of the
 *                              id, say LOUDLY that a message may have died in
 *                              a crash window — never a silent poison purge
 *
 *   tamper/corruption          markSeen + ack to purge the poison row, and
 *                              render NOTHING
 *
 * WHY `send` DOES NOT CONSUME BY DEFAULT. The server drains a user's whole
 * queue to every socket that connects, and `send` opens a socket, so a one-
 * shot send is handed the sender's own backlog. Today it drops those frames on
 * the floor without acking, and since only an ack deletes a row
 * (`drainQueuedMessages` deletes nothing), they redeliver on every send for
 * the full 30-day TTL. The one-line prescription was "ack and
 * discard on send". That is the wrong default, and the reason is asymmetric
 * damage:
 *
 *   - Acking destroys the server's only copy. `send`'s stdout is its receipt
 *     line and a cron job discards stderr, so the owner's reply would be
 *     decrypted into a void and then deleted — irreversibly, invisibly. And
 *     it cannot be undone by re-reading: `redelivery.test.ts` proves the
 *     ratchet refuses the same ciphertext twice, so a decrypted-and-lost
 *     message is lost for good.
 *   - Not acking costs re-downloading a backlog that, for a send-only
 *     integration account, is approximately empty — and it is self-limiting,
 *     because the queue TTL is 30 days.
 *
 * So the default is: observe, do not decrypt, do not ack, and SAY SO. Making
 * the cost visible is the actual fix — the defect was never the redelivery,
 * it was that nothing ever told anyone the mail was piling up. `--drain` opts
 * into the full listen policy for the genuinely send-only case, and puts the
 * plaintext on stdout where it is not thrown away.
 */
/** The server's own attachment-id shape (handlers/attachments.ts): 32 random
 * bytes base64url. Anything else is not a capability and is never dialled. */
const ATTACHMENT_ID_RE = /^[A-Za-z0-9_-]{43}$/;

function parseFileCapability(
  body: string,
): { att: string; keyB64: string; name: string; size: number } | null {
  if (!body.startsWith('{')) return null;
  let env: unknown;
  try {
    env = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof env !== 'object' || env === null) return null;
  const e = env as Record<string, unknown>;
  if (e.tcm !== 'file') return null;
  if (typeof e.att !== 'string' || !ATTACHMENT_ID_RE.test(e.att)) return null;
  if (typeof e.key !== 'string' || e.key.length === 0 || e.key.length > 100) return null;
  return {
    att: e.att,
    keyB64: e.key,
    name: typeof e.name === 'string' ? e.name : '',
    size: typeof e.size === 'number' && Number.isFinite(e.size) ? e.size : -1,
  };
}

/** The filename is the peer's claim. Separators and control characters become
 * '_', leading dots are stripped (no hidden files, no '..'), empty falls back
 * to a constant — the peer-names precedent: a field is an input. */
function safeFileName(claimed: string): string {
  const cleaned = claimed
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f/\\:]/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 200)
    .trim();
  return cleaned === '' ? 'attachment' : cleaned;
}

/** O_EXCL per candidate: two listeners saving the same name race the fd, not
 * the check. 0600 like every other file this CLI writes about a message. */
function writeUnique(dir: string, name: string, data: Uint8Array): string {
  for (let n = 0; n < 1000; n++) {
    const candidate = n === 0 ? name : `${name}.${n}`;
    const path = join(dir, candidate);
    let fd: number;
    try {
      fd = openSync(path, 'wx', 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw err;
    }
    try {
      writeSync(fd, data);
    } finally {
      closeSync(fd);
    }
    return path;
  }
  throw new Error('too many name collisions in the save directory');
}

/**
 * Fetch, decrypt and write a 1:1 file attachment at receive time. Best-effort
 * by contract (see InboundOptions.attachments): every failure is a note that
 * names statuses and lengths, never key, blob or plaintext bytes,
 * and never re-acks — the ack already happened and the ratchet would refuse
 * a redelivery anyway. `decryptBlob` is attachments.ts's ONE decrypt: a
 * tampered blob yields an error and zero plaintext, so nothing partial can
 * ever reach the file this function writes.
 */
async function saveInboundAttachment(
  dest: { token: Credential; saveDir: string },
  body: string,
  report: Reporter,
): Promise<void> {
  const cap = parseFileCapability(body);
  if (cap === null) return;
  try {
    const { downloadUrl } = await apiGetAttachmentUrl(dest.token, cap.att);
    const blobB64 = await downloadBlob(downloadUrl);
    const plain = decryptBlob(b64ToBytes(cap.keyB64), b64ToBytes(blobB64));
    mkdirSync(dest.saveDir, { recursive: true });
    const path = writeUnique(dest.saveDir, safeFileName(cap.name), plain);
    const sizeNote =
      cap.size === plain.length
        ? ''
        : ` — note: the envelope claimed ${cap.size} bytes, the blob decrypted to ${plain.length}`;
    report.note(`attachment saved: ${path} (${plain.length} bytes)${sizeNote}`);
  } catch (err) {
    const why =
      err instanceof BlobCipherError || err instanceof CliError ? err.message : localErrno(err);
    report.note(`!! attachment not saved (${why}) — ask the sender to re-send`);
  }
}

export function attachInbound(opts: InboundOptions): Inbound {
  const { name, userId, stores, ws, report, log, consume } = opts;
  const probe = probeStorePersistence(stores);
  // Retention parity for the quarantine: `applyRetention` runs on every
  // consuming command, so its sibling file must too — a preserved row must
  // not outlive the 30-day policy just because no NEW failure rewrites it.
  if (consume) pruneUndelivered(name);
  let queue: Promise<void> = Promise.resolve();
  let consumed = 0;
  let observed = 0;

  ws.onFrame((frame) => {
    queue = queue
      .then(async () => {
        if (frame.type === 'error') {
          report.note(`server error: ${sanitizeServerField(frame.code, 64)}: ${sanitizeServerField(frame.detail, 200)}`);
          return;
        }
        if (frame.type !== 'msg') return;

        if (!consume) {
          observed += 1;
          return;
        }

        if (stores.hasSeen(frame.msgId)) {
          // Redelivery of an already-processed message: ack again, print
          // nothing — and log nothing, or a lost ack would duplicate a row
          // the inbox has already shown.
          ws.send({ type: 'ack', msgId: frame.msgId });
          return;
        }

        // The address as it is SHOWN. The raw value still goes to
        // `decryptEnvelope`, which needs the byte-exact ProtocolAddress; only
        // the printed and JSON-emitted copies are stripped and bounded, and
        // JSON is not a free pass — `JSON.stringify` escapes C0 but leaves
        // DEL and C1 (7F-9F) intact.
        const shownFrom = sanitizeServerField(frame.from);

        // Armed HERE, not at attach: the probe is per-decrypt evidence, and a
        // stale failure from an earlier frame (or this process's own encrypt)
        // must not reclassify a genuinely tampered frame as local.
        probe.arm();
        try {
          // Under the cross-process ratchet lock: a concurrent `send` advances the
          // same session files (an earlier review, defect D).
          const text = await withFileLockAsync(stores.ratchetLockPath(), () =>
            decryptEnvelope(stores, userId, frame.from, frame.msgType, frame.payload),
          );

          // The room renderer is injected per frame (render.ts's seam): a
          // `grp.*` body APPLIES its state through the shared fold and then
          // renders the fold's answer; everything else takes the pure path.
          // The mention resolution is injected beside it, for the bare-1:1
          // shape the room path never sees.
          const rendered = renderBody(
            text,
            groupBodyRenderer(name, userId, frame.from),
            mentionNames(name, userId),
          );

          // BLOCKING, keyed on the AUTHENTICATED sender — which is
          // `frame.from` for a room message too, so one gate covers both.
          // A blocked sender's traffic is decrypted and acked byte-
          // identically (a block that changed ack behaviour would be visible
          // to the blocked party), persists nothing and displays nothing.
          // Room STATE above still applied: the fold must reach the same
          // roster on every client, blocked writer or not, or this client
          // diverges from the room — blocking silences a person, it
          // never forks the arithmetic. `isBlocked` never throws.
          const blocked = isBlocked(name, frame.from);

          // THE LOG WRITE COMES BEFORE THE ACK, and the order is the point.
          // The ack deletes the server's only copy, and the ratchet refuses
          // the same ciphertext twice (`redelivery.test.ts`), so the instant
          // the ack leaves, this process holds the last decryptable copy of
          // the message. Durable (fsynced, in `MessageLog.append`) first,
          // then delete; the reverse order has a crash window in which a
          // message exists nowhere.
          //
          // WHAT IS LOGGED IS NARROWER THAN WHAT IS SHOWN (the security review's
          // "store less"): only conversational text — plain bodies and
          // replies. Announcements (`[photo …]`, `[vault item saved]`), the
          // unsupported-kind notice, carriers and call signalling are all
          // rendered or handled but never persisted: `render.ts` already
          // decided their content does not belong on a surface with a long
          // memory, and a spool remembers longer than any terminal.
          if (maySpool(rendered) && !blocked) {
            // WHAT IS PERSISTED IS DATED BY THE LOCAL CLOCK'S CEILING.
            // `frame.ts` is server-controlled and unbounded (MsgFrame.ts in
            // packages/shared is a bare z.number()), and both retention
            // predicates trust the stored value: a future-dated ts makes the
            // row immortal in the spool (`applyRetention`'s
            // `now - ts >= RETAIN_MS` stays false until the claimed date —
            // verified by execution 2026-07-30) and would have done the same
            // in the quarantine. Capping at Date.now() means the server can
            // backdate a record into earlier expiry — a power it already has
            // by withholding delivery — but can no longer date plaintext into
            // a future it wants it to outlive the 30-day ceiling for. Display
            // (`report.line` below) still shows the frame's own ts; only what
            // reaches disk is capped.
            const persistedTs = Math.min(frame.ts, Date.now());
            // The room trigger metadata rides grp.msg rows ONLY: a bare 1:1 mention's `men` is dropped
            // here on purpose — the trigger surface is rooms, and metadata
            // persisted "just in case" is the store-less rule eroding.
            const roomMeta =
              rendered.tcm === 'grp.msg'
                ? {
                    ...(rendered.grp ? { grp: rendered.grp } : {}),
                    //the room message id, the second half
                    // of the §5.3 row key a rounds answer replies to. It
                    // rides in `roomMeta` so BOTH literals below — the spool
                    // append AND the quarantine — carry it: a field present
                    // in one and missing from the other is silently lost on
                    // exactly the recovery path nobody exercises.
                    ...(rendered.rm ? { rm: rendered.rm } : {}),
                    ...(rendered.men ? { men: true } : {}),
                    // The wrapper's AI-origin marker, recorded per
                    // author so the room send path can drop an unmentioned
                    // agent's leg — the CLI's marker-record agent signal.
                    ...(rendered.ai ? { ai: true } : {}),
                  }
                : {};
            //the DETAIL, which is BODY and not room routing
            // — so it rides its own object rather than `roomMeta`'s, and is
            // not gated on `grp.msg`: a 1:1 attend answer stays a `msg` and
            // may carry one (R3). Extracted into a shared object for
            // `roomMeta`'s exact reason: BOTH literals below — the spool
            // append AND the quarantine — must carry it, and a field present
            // in one and missing from the other is silently lost on exactly
            // the recovery path nobody exercises. Empty is no field: the
            // renderer already collapsed an absent, non-string or
            // control-only `d` to '' (render.ts `detailOf`).
            const bodyMeta = rendered.detail ? { detail: rendered.detail } : {};
            try {
              log.append({
                id: frame.msgId,
                dir: 'in',
                peer: frame.from,
                ts: persistedTs,
                tcm: rendered.tcm,
                text: rendered.text,
                read: false,
                ...(rendered.ref ? { ref: rendered.ref } : {}),
                ...(rendered.ofs ? { ofs: rendered.ofs } : {}),
                ...bodyMeta,
                ...roomMeta,
              });
            } catch (err) {
              // PRESERVE, THEN FAIL CLOSED (an earlier review). Leaving the row
              // queued cannot recover it: the ratchet durably advanced when
              // the decrypt succeeded, so the redelivered ciphertext is
              // refused as a duplicate and purged as poison on the next
              // connect. This process holds the last decryptable copy, so it
              // goes to the undelivered quarantine (0600, retention-covered)
              // where the operator can recover it. Still no ack and no
              // markSeen: the ack's only power is to delete the server row,
              // and nothing is bought by spending it on a write that failed —
              // the unacked row is what keeps the failure loud on every
              // reconnect. Residual, stated honestly: if the quarantine write
              // ALSO failed (a full disk fails both), the rendered line below
              // is the last time this message exists anywhere.
              const preserved = quarantineUndelivered(name, {
                id: frame.msgId,
                dir: 'in',
                peer: frame.from,
                ts: persistedTs,
                tcm: rendered.tcm,
                text: rendered.text,
                read: false,
                ...(rendered.ref ? { ref: rendered.ref } : {}),
                ...(rendered.ofs ? { ofs: rendered.ofs } : {}),
                // The quarantine is the same record, preserved whole — a
                // recovered row must trigger exactly as the lost one would,
                // and must READ as the lost one would: this file holds the
                // last copy of the plaintext, and half a message recovered is
                // a finding whose evidence is gone.
                ...bodyMeta,
                ...roomMeta,
              });
              // `localErrno`, never `err.message`: an fs error's message
              // quotes the spool path, and the path carries the account name.
              // The `preserved` path below DOES still travel — it, too,
              // embeds the account name, and that is accepted deliberately:
              // it is the custody pointer to the last copy of a message,
              // pinned by gate.acksafety ("preserved at"), the same
              // remedy-needs-the-path trade lock.ts makes for `rm -rf`.
              report.note(
                `!! message log write failed (${localErrno(err)}) — ` +
                  `NOT acking msgId=${frame.msgId}; ` +
                  (preserved !== null
                    ? `plaintext preserved at ${preserved} — fix the spool, then recover it from there`
                    : `the undelivered quarantine ALSO failed, so the line below is the LAST copy — ` +
                      `fix the disk before the next connect`),
              );
              if (rendered.text !== '') {
                // `prefixLines`, and this is the site where it matters most:
                // the spool write failed, so this print is the LAST copy of
                // the plaintext AND the one an attacker most wants to forge
                // on. Losing a line here is unacceptable, which is why the
                // rule prefixes rather than flattens (render.ts, round 14).
                //
                // THE DETAIL RIDES ALONG UNGATED BY `--detail`, which is the
                // one place on this path the flag has no business. Everywhere
                // else `--detail` chooses how much of a message a reader is
                // shown, and the rest stays on disk. Here there IS no disk:
                // both writes failed, so this line is the whole custody of
                // the message, and a flag nobody passed would silently
                // destroy the half the quarantine literal argues hardest to
                // keep ("half a message recovered is a finding whose evidence
                // is gone"). Same indentation as the reading surface, through
                // the same `prefixLines`, so a recovered line reads the way
                // the delivered one would have.
                report.line(
                  {
                    from: shownFrom,
                    msgId: frame.msgId,
                    ts: frame.ts,
                    unlogged: true,
                    text: rendered.text,
                    ...(rendered.detail ? { detail: rendered.detail } : {}),
                  },
                  rendered.detail
                    ? `${prefixLines(`[${shownFrom}] `, rendered.text)}\n` +
                        prefixLines(`[${shownFrom}]     `, rendered.detail)
                    : prefixLines(`[${shownFrom}] `, rendered.text),
                );
              }
              return;
            }
          }

          // A profile card is how a peer tells us their display name — the
          // one fact `contacts` cannot get from the wire address.
          //
          // "the only place the envelope is ever open" is what this comment
          // used to say, and it was false: CallSession opens the same
          // envelopes, recorded nothing, and ACKED the card — which destroys
          // the server's only copy and leaves the ratchet refusing redelivery,
          // so a calls-only bot could never learn any peer's name and the
          // pairing confirmation the card exists for could never complete.
          // Both paths record it now (an earlier review).
          if (!blocked && rendered.tcm === 'profile' && rendered.peerName) {
            try {
              stores.setPeerName(frame.from, rendered.peerName);
            } catch {
              // A name is a nicety; losing one write costs nothing durable.
            }
          }

          stores.markSeen(frame.msgId);
          ws.send({ type: 'ack', msgId: frame.msgId });
          consumed += 1;

          // THE ACK IS THE END OF THE DECRYPT. Everything below is rendering,
          // and it gets its own catch because the one below is a DECRYPT
          // failure classifier — it asks libsignal-shaped questions, and for
          // anything it cannot place it answers 'undecryptable', which marks
          // seen, ACKS, and prints "message rejected". A throw crossing this
          // boundary after the ack above would therefore send a SECOND ack and
          // report a delivered message as rejected poison:
          // gate.acksafety.test.ts ("a failure AFTER the ack") injects a
          // reporter whose `line` throws and pins one ack, no "rejected", and
          // the spooled row — a recorded sabotage run proved it (this
          // split removed -> two acks). The split also aligns the boundary
          // with CallSession, whose catch already closed before its render.
          //
          // THIS GUARD IS OWED TO A CLASS, NOT TO A DEMONSTRATED BUG. An earlier revision
          // justified it with "`listen` piped into a pager the user quits —
          // the next `report.line` throws EPIPE", and that story is false on
          // the supported platform: executed on macOS/Node 22.21.1 (repro in
          // an earlier review), EPIPE on a broken stdout pipe surfaces ONLY as
          // an asynchronous stream 'error' event, which no try here can see —
          // as does a failing write to a file fd (EBADF, run the same way).
          // No synchronous throw inside this try is known to be reachable
          // today: the record is built from JSON-parsed primitives, so
          // `JSON.stringify` cannot refuse it, and the shipped Reporter only
          // writes to streams. The boundary is kept because nothing enforces
          // that inventory — the first reporting surface that CAN throw
          // synchronously must degrade to the note below, never to a re-ack.
          //
          // A render failure is also not worth losing a delivered message
          // over: the row is in the spool and `tacendum inbox` will show it.
          try {
            // A blocked sender's line dies HERE, after the ack: their frames
            // are consumed like anyone's, and nothing about this account's
            // observable behaviour tells them so.
            if (blocked) return;
            // Signalling: silent on both streams, whether or not this build can
            // parse it. `listen --calls` is what handles these.
            if (rendered.text === '') return;

            // The one moment the file capability is in hand (the spool never
            // stores att/key — msglog.ts). Top-level 'file' only: a room file
            // arrives as grp.msg and renders withheld. Blocked returned above,
            // so a blocked sender's blob is never even dialled.
            if (opts.attachments !== undefined && rendered.tcm === 'file') {
              await saveInboundAttachment(opts.attachments, text, report);
            }

            // §3.7: `text` is the BRIEF on every surface, and the
            // detail is a second thing this line may or may not be asked for.
            // Gated on the flag in `--json` too, so the two modes agree about
            // what `--detail` means — a machine consumer that wants the whole
            // answer asks for it exactly as a human does, and a stream nobody
            // asked to widen stays the width it was.
            const showDetail = opts.detail === true && rendered.detail !== undefined;
            const record = {
              from: shownFrom,
              msgId: frame.msgId,
              ts: frame.ts,
              tcm: rendered.tcm,
              carrier: rendered.carrier,
              text: rendered.text,
              ...(showDetail ? { detail: rendered.detail } : {}),
            };
            // A machine consumer gets everything, tagged. A human gets the same
            // split the phone makes: carriers are state changes, not lines of
            // conversation, so they go to stderr and leave stdout parseable.
            //
            // BOTH HUMAN STREAMS GO THROUGH `prefixLines`, and every line of
            // both: a peer's newline used to end this program's prefix and
            // start a line the peer wrote entirely (render.ts, an earlier revision/14).
            // stderr is not the safer one of the pair — the carrier line
            // interpolates the same peer-chosen text (a reaction's emoji, a
            // profile card's name), and a log shipper reads both streams.
            //
            // THE `--json` LINE BELOW GETS NO PREFIX, and that is a decision
            // with a stated residue rather than an omission. `JSON.stringify`
            // escapes CR and LF, so the one-object-per-LF-line framing holds
            // for a body full of newlines and a reader that parses each line
            // gets the text back exactly as it arrived — which is the point of
            // the mode. It does NOT escape U+2028/U+2029 (measured on Node
            // 22.21.1), so a peer can still put a raw line separator inside
            // the quoted string: harmless to a reader that parses, visible to
            // one that runs `/^GCALL /m` across raw JSON without parsing it.
            // Closing that costs one `\u2028`-escaping pass in the Reporter
            // (output.ts) — lossless, since a JSON parser decodes the escape
            // back to the same character — and it belongs there, at the one
            // place this program turns a record into a line, not here.

            if (report.json) {
              report.line(record, '');
              return;
            }
            if (rendered.carrier) {
              report.note(prefixLines(`[${shownFrom}] (${rendered.tcm}) `, rendered.text));
              return;
            }
            report.line(
              record,
              showDetail
                ? // Brief first, then the detail INDENTED under it, through
                  // the same `prefixLines` the brief uses — every line of it,
                  // for that helper's whole reason: this is peer plaintext
                  // and its newlines are the peer's, so a line of it must
                  // never start at column zero where a `GCALL …` it wrote
                  // would read as something this program said.
                  `${prefixLines(`[${shownFrom}] `, rendered.text)}\n` +
                    prefixLines(`[${shownFrom}]     `, rendered.detail as string)
                : prefixLines(`[${shownFrom}] `, rendered.text),
            );
          } catch (renderErr) {
            // Named, never re-acked, and never rule-4-unsafe: only the id,
            // the already-public peer address and a shape-checked errno —
            // never the body that failed to print, and never the exception's
            // own text, which no contract certifies value-free.
            report.note(
              `!! could not render msgId=${frame.msgId} from=${shownFrom} ` +
                `(${localErrno(renderErr)}) — delivered, see \`tacendum inbox\``,
            );
          }
        } catch (err) {
          // One classifier, shared with the CallSession mirror. Neither path
          // decides for itself what a failure means; see the doc block above
          // `classifyDecryptFailure` for why that is not a style preference.
          const disposition = classifyDecryptFailure(err, probe);
          if (disposition === 'identity-change') {
            // Block-and-warn: the sender's safety number changed.
            // Do NOT ack or mark seen — the message stays queued and decrypts
            // after the user accepts the new identity and reconnects.
            // Recorded, not just printed: `tacendum trust` is destructive
            // (it un-pins the peer's key), and this file is what lets it
            // refuse when nothing is actually pending. The warning is usually
            // seen in one process and acted on in another, so it has to
            // survive on disk.
            stores.markIdentityChange(frame.from);
            report.note(
              `!! SAFETY NUMBER CHANGED from=${shownFrom} — message withheld. ` +
                `Verify out of band, then: tacendum trust ${name} <their-name>`,
            );
            return;
          }
          // A LOCAL failure is not tamper. Two shapes land here. (1) The
          // ratchet LOCK could not be acquired — a CliError thrown before any
          // ciphertext was examined. (2) A store WRITE failed DURING the
          // decrypt (EIO/ENOSPC on the session save) — which libsignal wraps
          // in a code-Generic LibSignalErrorBase, erasing the errno, so by
          // TYPE it is tamper; the probe armed above is the only witness that
          // it was our disk, not their bytes. Classifying either as poison
          // acks away the server's only copy of a valid message: data loss
          // caused purely by a busy or full machine. Leave the row queued —
          // a save that never reached the disk decrypts cleanly on
          // redelivery. Residual: a save that died AFTER its rename durably
          // advanced the ratchet (or a prekey message whose one-time prekey
          // was already consumed) redelivers as a ratchet duplicate — which
          // the branch below purges LOUDLY, not as silent poison; local
          // persistence has no atomic pair with the remote ack.
          if (disposition === 'local-failure') {
            // `describeLocalFailure`, never `err.message`: for the store
            // shape `err` is libsignal's wrapper, whose text embeds the
            // failing file path — and the path embeds the account name, a
            // caller-supplied value. The probe surrenders the original it
            // recorded, and one shared function decides what may travel.
            report.note(
              `!! could not process msgId=${frame.msgId}: ` +
                `${describeLocalFailure(err, probe)} — ` +
                `left on the server, will retry`,
            );
            return;
          }
          // THE RATCHET ALREADY CONSUMED THIS CIPHERTEXT (an earlier review) —
          // purged loudly by the shared disposition, so `listen` and
          // `listen --calls` cannot report the same event differently.
          if (disposition === 'ratchet-duplicate') {
            purgeRatchetDuplicate({
              msgId: frame.msgId,
              shownFrom,
              stores,
              ws,
              log,
              note: text => report.note(text),
            });
            return;
          }
          if (disposition !== 'undecryptable') assertAllDispositionsHandled(disposition);
          // Tamper/corruption: reject loudly, never render anything.
          // Ack to purge the poison message from the queue.
          stores.markSeen(frame.msgId);
          ws.send({ type: 'ack', msgId: frame.msgId });
          report.note(
            `!! DECRYPT FAILED msgId=${frame.msgId} from=${shownFrom}: ` +
              `${describeUndecryptable(err)} — message rejected`,
          );
        }
      })
      .catch((err) => {
        // A failure outside the decrypt try/catch (e.g. a corrupt store read)
        // must not reject the shared chain and stall every later frame. Drop
        // this frame — it will redeliver (unacked) and dedupe on retry.
        report.note(`!! frame processing error: ${err instanceof Error ? err.name : 'unknown'}`);
      });
  });

  return {
    settled: () => queue,
    get consumed() {
      return consumed;
    },
    report() {
      if (consume || observed === 0) return;
      report.note(
        `note: ${observed} queued message(s) for ${name} were left on the server ` +
          `(they will redeliver). Read them with: tacendum listen ${name}` +
          ` — or add --drain to consume them here.`,
      );
    },
  };
}

/**
 * Drain-completion detection for `tacendum sync`.
 *
 * There is no "end of queue" frame: the server drains the whole backlog into
 * the socket during $connect and says nothing when it is done. So "done" can
 * only be observed as silence — no `msg` frame for a quiet window. The window
 * is generous against the local adapter's single-digit-millisecond drain and
 * against production's one round trip; what it cannot be is a proof, which is
 * why `sync` acking as it goes matters: a message that slips past one run is
 * merely still queued for the next, not lost.
 *
 * MUST be constructed BEFORE `ws.connect()`, for the same reason the frame
 * handler is: `ws` does not buffer, and the drain lands in the first
 * milliseconds after open. A watcher attached after the dial can miss the
 * entire backlog and declare a loaded queue quiet.
 */
export function watchQuiet(ws: WsClient): { wait(quietMs: number): Promise<void> } {
  let last = Date.now();
  ws.onFrame((frame) => {
    if (frame.type === 'msg') last = Date.now();
  });
  return {
    async wait(quietMs: number): Promise<void> {
      for (;;) {
        const idle = Date.now() - last;
        if (idle >= quietMs) return;
        // Poll rather than re-arm a timer per frame: frames can arrive faster
        // than timers are cheap to cancel, and a 50ms check-in bounds the
        // overshoot at a twentieth of the window.
        await new Promise((resolve) => setTimeout(resolve, Math.min(quietMs - idle, 50)));
      }
    },
  };
}
