/**
 * INVARIANT HARNESS — an ack is a receipt for durable custody, never for a
 * local failure.
 *
 * An ack deletes the server's only copy of a message, and the ratchet refuses
 * the same ciphertext twice, so a wrong ack is permanent loss. That property
 * has now been violated four separate ways across several review passes — a
 * lock timeout took the tamper branch, a libsignal-wrapped ENOSPC dodged an
 * `instanceof CliError` guard, `listen --calls` acked before it knew whether
 * a frame was a call, a failed spool write left the redelivery a purgeable
 * duplicate — and every one was found by a human reading code, because the
 * rule lived in comments. `gate.acksafety.test.ts` pins those KNOWN cases;
 * this file holds the PROPERTY across a generated matrix, so the fifth
 * violation — the one nobody has listed — fails here without anyone having
 * thought of it.
 *
 * The invariant, in the observables (ack frames on the socket, `seen.json`,
 * the spool bytes on disk) rather than in any branch of inbound.ts:
 *
 *   1. ACK ⇒ DURABLE. When an ack for a spool-worthy frame leaves the client,
 *      its record is ALREADY readable on disk — checked at the instant the
 *      ack passes through the fake socket, so an "append later" reorder fails
 *      even if the append eventually lands. And ACK ⇒ SEEN, for every frame
 *      of every mode: an ack whose seen marker never landed comes back as a
 *      POSSIBLE MESSAGE LOSS alarm for mail that was in fact delivered.
 *   2. A PROVEN LOCAL FAILURE NEVER ACKS — and never marks seen, because a
 *      seen-marked frame is acked away unprocessed on its next redelivery,
 *      which is the same loss one hop later.
 *   3. THE ONE EXCEPTION: genuinely undecryptable ciphertext acks WITHOUT a
 *      record (poison must be purged). The control row asserts that purge
 *      still happens and that poison is never spooled and never rendered on
 *      stdout — pinned positively, so the exception can neither be silently
 *      widened into a failure-eats-mail branch nor silently dropped. One
 *      shape inside the exception is held to more: a ratchet DUPLICATE is
 *      undecryptable ciphertext that may be LOST MAIL (a run that died
 *      between ratchet commit and spool custody), so purging it silently is
 *      forbidden — the crash-window cells own that, and there are now two
 *      sets of them, one per inbound path. An earlier revision pinned the property
 *      against `attachInbound` only; an earlier revision found `listen --calls` still
 *      reporting that exact loss as "message rejected" tamper, invisible
 *      here because the mirror had no crash-window cell.
 *
 * MECHANICAL GENERATION: a matrix of injected local failures × frame kinds,
 * enumerated in code below — a new failure mode or frame kind is one entry.
 * Failures are injected through the real filesystem (chmod, a pre-existing
 * lock file, a directory squatting on writeFileAtomic's temp path), never by
 * stubbing the code under test; frames are real ciphertext from real sender
 * stores, plus two corrupt shapes. Every cell runs the real inbound path:
 * `attachInbound` for the listen/sync policy, a real `CallSession` (real
 * WsClient parse path, mocked socket) for its mirror — and BOTH sweeps
 * enumerate ONE kind list (`frameKinds`) AND ONE failure list
 * (`failureModes`), with no per-mode opt-out between them. An earlier revision found the
 * mirror sweeping a hand-picked three-kind subset that stayed green while
 * replies through `listen --calls` were being destroyed; an earlier revision found the
 * other half of the same hole — the failure list still had a `callPath` flag,
 * and the one mode it excluded was ratchet-lock contention, the very incident
 * ("a lock-acquisition timeout destroyed mail") this file exists for.
 *
 * `mustNotAck` is declared PER CELL and only where the injection PROVABLY
 * prevents durable handling of that kind (e.g. every successful decrypt must
 * persist the ratchet advance, so an unwritable sessions/ dir provably fails
 * every valid decrypt). Cells where an injection may not bite (an unwritable
 * identities/ dir under an ordinary ciphertext frame) still assert
 * directions 1 and 3, which are unconditional.
 *
 * NON-VACUITY (verified against this working tree, then restored):
 *  - inbound.ts guard reverted to bare `err instanceof CliError` (dropping
 *    `|| probe.failed()`): the "session save fails mid-decrypt" column acked
 *    valid frames away — 6 cells failed.
 *  - inbound.ts local-failure branch disabled (tamper acks unconditionally):
 *    the "ratchet lock held by a live process" cell acked a frame that was
 *    never even examined — 8 cells failed, that one among them.
 *  - inbound.ts ack moved above `log.append`: the at-ack-time snapshot caught
 *    the record missing from disk in every control-row spool cell, even
 *    though the append completed before settle — 3 cells failed.
 *  - call-session.ts spool guard reverted to the historical
 *    `!wasCall && maySpool(rendered)`: 4 CallSession
 *    reply-envelope cells failed — "[no failure (control) × reply-envelope]
 *    the ack left before the record was readable on disk" and "[spool file
 *    read-only × reply-envelope] acked under a local failure: the server's
 *    only copy is gone" among them. Before an earlier revision the mirror had no reply
 *    kind and this revert ran green.
 *  - inbound.ts ratchet-duplicate branch disabled (duplicates fall through to
 *    the tamper purge again): the crash-window cell failed with "a message
 *    the ratchet consumed but never delivered was purged without any loss
 *    report".
 *  - inbound.ts quarantine serialization removed (the bare read-modify-rename
 *    back): the two-process cell failed with "rows one process preserved were
 *    renamed away by the other: expected [ 'QRACE-B-0', … ] to deeply equal
 *    []" — every row child B was told was preserved, gone, both children
 *    exiting 0.
 *  - the lock-refusal CliError declassified for the CallSession
 *    target only, and only for first-contact prekey frames — a call-session
 *    guard that discriminates by msgType, which is the narrowest form of the
 *    defect. Exactly one cell failed: "[ratchet lock held by a live process ×
 *    prekey-first-contact] acked under a local failure: the server's only
 *    copy is gone" (with the seen-mark assertion behind it). Every other
 *    CallSession cell — the read-only-root CliError included — stayed green,
 *    which is the finding restated: before this revision the mirror never ran
 *    this mode at all, so real lock contention could eat mail unobserved.
 *  - call-session.ts's ratchet-duplicate branch removed, so a
 *    duplicate falls into its tamper tail exactly as it did before the fix:
 *    "crash window: reports the possible loss loudly instead of purging it as
 *    silent poison" failed with "a message the ratchet consumed but never
 *    delivered was purged without any loss report", while the sibling cell
 *    stayed green (pre-fix code acked correctly; it only lied about why).
 *    Before this revision NO cell here delivered an already-consumed
 *    ciphertext to the mirror, so the whole defect was invisible.
 *  - THE INJECTIONS THEMSELVES, which the list above never
 *    checked. 'account root read-only (ratchet lock uncreatable)' was
 *    reverted to its bare `chmod(root, 0o500)`: 6 cells failed with "a
 *    durable record exists although this mode refuses BEFORE any ciphertext
 *    is examined", 3 per sweep — which is what those 16 cells had been doing
 *    all along, decrypting and spooling under a mode that advertises a lock
 *    refusal (H1 below).
 *  - inbound.ts's ack moved ABOVE `stores.markSeen`: 6 cells of
 *    'seen-marker write fails post-append' failed with "acked without
 *    marking seen". Before this revision that whole mode produced neither an
 *    ack nor a seen mark in any of its 16 cells and asserted NOTHING.
 *  - `stores.markSeen` hoisted above the spool append, in
 *    inbound.ts and then in call-session.ts: 3 cells failed per path with
 *    "the injection lands AFTER custody, so the plaintext must be on disk".
 *  - inbound.ts's classifier reverted to bare
 *    `err instanceof CliError` again — the earlier revert, re-run against
 *    the widened identity predicate: 12 cells failed rather than 2, the ten
 *    new ones being the non-prekey kinds this file used to call "merely
 *    opportunistic".
 *  - `spools` flipped on two kinds (plain-text to false,
 *    vault-announcement to true): 4 control cells failed with "the spool
 *    policy disagrees with this kind's declared `spools:`". Before this
 *    revision `spools` only ever SKIPPED assertions, so it could not be
 *    wrong in a way anything noticed.
 *  - THE INJECTIONS AGAIN, one half at a time, because an earlier revision's
 *    own repair of them was pinned by too little. 'account root read-only':
 *    with the `*.lock` sweep dropped, 16 cells fail on the setup self-check
 *    (`the ratchet lock … is still takeable`); with the chmod dropped
 *    instead, the same 16; with the self-check deleted AND the sweep dropped,
 *    12 fail rather than the 6 that failed before `decryptFootprint` existed
 *    — the 6 new ones being carrier-react, call-envelope and
 *    vault-announcement in both sweeps, each reporting a ratchet advance
 *    under a mode that claims nothing was examined. The 4 that still pass
 *    there are the corrupt kinds, which write nothing to those stores even on
 *    a healthy path; the self-check is what holds them.
 *  - 'seen-marker write fails post-append': setup replaced with a
 *    no-op — 16 cells fail on `mustNotMarkSeen`, corrupt kinds included,
 *    where before the same sabotage gave `Tests 16 passed`. And with
 *    `mustNotMarkSeen` removed so only the setup self-check is left,
 *    `writeFileAtomic`'s temp name changed to `.tmpX` in stores.ts: 16 cells
 *    fail as "the seen.json temp squat … no longer blocks markSeen", which is
 *    the silent-revert this mode's private coupling used to allow.
 *  - (the mode's third life) 'seen-marker write fails
 *    post-append' re-staged as a 0o500 account root with the ratchet lock
 *    kept takeable, after its second life — a directory squatting the
 *    seen.json TARGET, live file parked beside — broke the READS its own
 *    sweep-2 settling depends on: the pre-seen settle marker answered
 *    unseen, missed the redelivery branch, and its purge died at markSeen
 *    under the same squat, so all 8 CallSession cells timed out unacked.
 *    With the chmod injection no-op'd, 16 cells
 *    fail on `mustNotMarkSeen` — same count, same observable as the
 *    earlier measurement of the first life.
 *  - each remaining mode's injection deleted in turn: 'spool file
 *    read-only' 6 failed, 'state dir read-only' 6 failed (either half),
 *    'session save fails mid-decrypt' 12, 'one-time-prekey delete fails
 *    mid-decrypt' 2 (only a first-contact frame consumes one), 'identity pin
 *    write fails mid-decrypt' 12, 'ratchet lock held by a live process' 4 of
 *    its 4 cells with the holder never spawned. The control row: `spools`
 *    flipped on plain-text, 2 failed.
 *  - a mode's `setup` made to throw after its chmod, with
 *    `await mode.setup()` back OUTSIDE the try: 24 cells failed instead of
 *    16 — the extra 8 being later modes and the two crash-window cells at
 *    the end of the file, running against a read-only spool leaked by a
 *    teardown that never happened.
 *
 * HONESTLY NOT COVERED:
 *  - A LYING fsync (write succeeds, durability silently doesn't). Injecting
 *    that needs fs mocking, which would un-real the path under test; the
 *    chmod/EACCES injections exercise the same catch/classify code, but
 *    "readable on disk at ack time" is as close to "durable" as userland can
 *    observe.
 *  - Power-cut torn writes and tail repair (msglog's own tests), quarantine
 *    CONTENT and the remaining redelivery examples (gate.acksafety),
 *    cross-PROCESS races other than the quarantine rewrite (lock.ts tests).
 *    The crash-window redelivery lifecycle (BOTH inbound paths: the mirror's
 *    cells live at the end of its own describe, where its live session and
 *    peer stores already exist) and the two-writer quarantine race ARE
 *    covered here.
 *  - Distinguishing a crash-window loss from an attacker's byte-exact replay:
 *    both surface as the same loud POSSIBLE MESSAGE LOSS purge, asserted as
 *    one outcome, because no local record can tell them apart after the fact.
 *  - `listen --calls` call-machine semantics: the call frame here is
 *    deliberately an unparseable call envelope, because this harness is about
 *    the ack, not about ringing.
 *  - Whether a prekeys/ failure bites a NON-prekey decrypt: only a
 *    first-contact envelope consumes a one-time prekey, so that mode's
 *    `mustNotAck` stays `k.prekey` and its other cells hold only the
 *    unconditional directions (which include ACK⇒SEEN — "conservative" here
 *    means asserting less, never asserting nothing).
 *
 *    NOT identities/, NOT ANY MORE, and the correction is recorded because
 *    this list is what a reader consults before narrowing a predicate. Until
 *    an earlier revision this bullet lumped the two together and called the non-prekey
 *    identity cells "merely opportunistic". That was a guess, and re-deriving
 *    it from the tree showed it wrong in the under-asserting direction:
 *    libsignal re-pins the sender's identity on EVERY decrypt, so with
 *    `identities/` at 0o500 all six valid kinds fail, and that mode now
 *    asserts `mustNotAck: k => k.valid`. A header that still said otherwise
 *    would be an invitation to narrow the predicate back — see the mode's own
 *    comment for the premise to re-derive if libsignal ever changes.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { monotonicFactory } from 'ulid';
import type { ClientFrame, MsgType, PrekeyBundle, ServerFrame } from '@tacendum/shared';

const { wsInstances, sendHook } = vi.hoisted(() => ({
  wsInstances: [] as Array<{
    handlers: Record<string, Array<(...a: unknown[]) => void>>;
    sent: string[];
  }>,
  // Lets the CallSession half observe the disk AT THE INSTANT an ack leaves —
  // assigned once the caller's spool path exists (see below).
  sendHook: { fn: null as null | ((msgId: string) => void) },
}));

vi.mock('ws', () => {
  // Enough of `ws` for CallSession.connect(): open on the next tick, record
  // outgoing frames, expose handlers so cells can push frames through the
  // REAL WsClient parse path. Same shape gate.acksafety.test.ts proved out.
  class FakeWebSocket {
    handlers: Record<string, Array<(...a: unknown[]) => void>> = {};
    sent: string[] = [];
    constructor(_url: string) {
      wsInstances.push(this);
      setTimeout(() => {
        for (const h of this.handlers.open ?? []) h();
      }, 0);
    }
    on(event: string, cb: (...a: unknown[]) => void) {
      (this.handlers[event] ??= []).push(cb);
      return this;
    }
    off(event: string, cb: (...a: unknown[]) => void) {
      this.handlers[event] = (this.handlers[event] ?? []).filter(h => h !== cb);
      return this;
    }
    removeAllListeners() {
      this.handlers = {};
      return this;
    }
    close() {}
    send(data: string) {
      this.sent.push(data);
      try {
        const parsed = JSON.parse(data) as { type?: string; msgId?: string };
        if (parsed.type === 'ack' && typeof parsed.msgId === 'string') sendHook.fn?.(parsed.msgId);
      } catch {
        // Not JSON: nothing this harness snapshots on.
      }
    }
  }
  return { default: FakeWebSocket };
});

// Set BEFORE the src imports: config.ts snapshots the env at module evaluation.
const home = mkdtempSync(join(tmpdir(), 'tacendum-ackharness-'));
const previousHome = process.env.TACENDUM_HOME;
const previousApi = process.env.TACENDUM_API;
process.env.TACENDUM_HOME = home;
process.env.TACENDUM_API = 'http://ackharness.test';

const { FileStores } = await import('../src/stores.js');
const { generateAndStoreKeys, establishSession, encryptText, decryptEnvelope } = await import(
  '../src/messaging.js'
);
const { attachInbound, undeliveredPath } = await import('../src/inbound.js');
// Read-only here: an injection that claims "the ratchet lock cannot be taken"
// proves it through lock.ts's OWN api rather than through a private guess at
// how a lock is represented (see `ratchetLockIsTakeable`).
const { withFileLock } = await import('../src/lock.js');
const { MessageLog } = await import('../src/msglog.js');
const { CallSession } = await import('../src/call-session.js');
const { saveProfile } = await import('../src/profile.js');
const { clientDir, stateDir } = await import('../src/config.js');
type WsClient = import('../src/wsclient.js').WsClient;
type Reporter = import('../src/output.js').Reporter;
type MessageRecord = import('../src/msglog.js').MessageRecord;

const ulid = monotonicFactory();

/** A premise this harness's assertions lean on. A broken premise must fail
 * LOUDLY as itself, not silently weaken a cell into always-green. */
function premise(cond: boolean, why: string): void {
  if (!cond) throw new Error(`harness premise broken: ${why}`);
}

function bundleFrom(
  userId: string,
  upload: Awaited<ReturnType<typeof generateAndStoreKeys>>,
  otkIndex: number,
): PrekeyBundle {
  const otk = upload.oneTimePrekeys[otkIndex];
  premise(otk !== undefined, `one-time prekey index ${otkIndex} exists`);
  return {
    userId,
    registrationId: upload.registrationId,
    identityKey: upload.identityKey,
    signedPrekey: upload.signedPrekey,
    kyberPrekey: upload.kyberPrekey,
    oneTimePrekey: otk,
  };
}

function readSpool(spoolPath: string): MessageRecord[] {
  let content = '';
  try {
    content = readFileSync(spoolPath, 'utf8');
  } catch {
    return [];
  }
  const out: MessageRecord[] = [];
  for (const line of content.split('\n')) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line) as MessageRecord);
    } catch {
      // A torn line is a record that is NOT durably readable — exactly what
      // the invariant asks about, so it simply does not count.
    }
  }
  return out;
}

/**
 * Everything a decrypt durably writes, as one comparable string: session
 * records, TOFU identity pins, one-time prekeys — the exact three stores
 * `probeStorePersistence` wraps in inbound.ts, because they are the three
 * durable mutations a decrypt performs.
 *
 * CONSTRAINT: a mode that claims the ciphertext was never examined is checked
 * against the RATCHET, not only against the spool. An earlier revision's H1a: after the
 * read-only-root mode was repaired, its `mustLeaveNoTrace` predicate still
 * had teeth in only 6 of its 16 cells — the spool half is vacuous for the
 * five kinds that never spool, and the stdout half is dead twice over
 * (`lines` is null for the whole CallSession sweep, and in sweep 1 `markSeen`
 * throws before `report.line` runs). What actually happened in the other 10
 * while the injection was doing nothing is a durably ADVANCED ratchet, and
 * that is visible right here: a chain advance rewrites
 * `sessions/<peer>.<dev>.bin`, and a first-contact decrypt creates one.
 *
 * Compared as a BOOLEAN and never printed: these bytes are ratchet and key
 * state, and an assertion message is an operator-facing line.
 */
function decryptFootprint(root: string): string {
  const parts: string[] = [];
  for (const sub of ['sessions', 'identities', 'prekeys']) {
    const dir = join(root, sub);
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch {
      parts.push(`${sub}/<absent>`);
      continue;
    }
    for (const name of names) {
      try {
        parts.push(`${sub}/${name}=${readFileSync(join(dir, name)).toString('base64')}`);
      } catch {
        parts.push(`${sub}/${name}=<unreadable>`);
      }
    }
  }
  return parts.join('\n');
}

/**
 * Can this process take the account's ratchet lock RIGHT NOW, through
 * lock.ts's own api?
 *
 * An injection that exists to make the lock unobtainable has no downstream
 * observable of its own for a frame that was never going to write anything
 * (the two corrupt kinds spool nothing and render nothing whether the lock
 * was refused or the ciphertext was rejected). Asking the lock directly is
 * that observable, and asking it through the API means it holds under any
 * representation the lock grows next — the forged-holder drift documented at
 * `LOCK_HOLDER_SRC` is exactly this mistake one layer down.
 */
function ratchetLockIsTakeable(stores: InstanceType<typeof FileStores>): boolean {
  try {
    // The PATH comes from the store, not from a literal. Asking the lock
    // through its API covers a change in how a lock is REPRESENTED but not in
    // where it lives, and this check guessed the location — the same class of
    // private-convention guess the seen-squat below was just fixed for. Under
    // a moved path the mode's own `*.lock` sweep would stop removing the real
    // lock AND this probe would keep returning false, so the four corrupt
    // cells it is the sole holder of would revert to asserting nothing, in
    // silence.
    withFileLock(stores.ratchetLockPath(), () => {});
    return true;
  } catch {
    return false;
  }
}

/** The two WsClient methods the inbound policy uses — plus the property this
 * harness exists for: the state of the spool ON DISK at the instant each ack
 * left, so "durable BEFORE ack" is checked as an ordering, not an eventuality. */
class FakeWs {
  handlers: ((f: ServerFrame) => void)[] = [];
  sent: ClientFrame[] = [];
  ackSpoolSnapshots = new Map<string, MessageRecord[]>();
  constructor(private readonly spoolPath: string) {}
  onFrame(h: (f: ServerFrame) => void): void {
    this.handlers.push(h);
  }
  send(f: ClientFrame): void {
    // The FIRST ack is the one that deletes the server's copy, so it is the
    // one whose instant matters; a later duplicate must not repaint it.
    if (f.type === 'ack' && !this.ackSpoolSnapshots.has(f.msgId)) {
      this.ackSpoolSnapshots.set(f.msgId, readSpool(this.spoolPath));
    }
    this.sent.push(f);
  }
  deliver(f: ServerFrame): void {
    for (const h of this.handlers) h(f);
  }
  acked(msgId: string): boolean {
    return this.sent.some(f => f.type === 'ack' && f.msgId === msgId);
  }
}

function fakeReporter(): { r: Reporter; lines: Record<string, unknown>[]; notes: string[] } {
  const lines: Record<string, unknown>[] = [];
  // Captured, not dropped: the crash-window block below asserts that a purge
  // of possibly-lost mail is LOUD, and stderr text is the only place that
  // loudness is observable.
  const notes: string[] = [];
  const r = {
    json: true,
    plain: true,
    line: (record: Record<string, unknown>) => lines.push(record),
    emit: (record: Record<string, unknown>) => lines.push(record),
    note: (text: string) => notes.push(text),
    status: () => {},
    done: () => {},
  } as unknown as Reporter;
  return { r, lines, notes };
}

// --- the matrix ------------------------------------------------------------

interface FrameKind {
  kind: string;
  /** Real ciphertext from a real sender: decryptable when nothing local fails. */
  valid: boolean;
  /** The spool policy persists this plaintext, so an ack owes a durable record. */
  spools: boolean;
  /** Arrives as first-contact 'prekey': a one-time prekey is consumed mid-decrypt. */
  prekey: boolean;
  make: () => Promise<{ from: string; msgType: MsgType; payload: string; expectText: string | null }>;
}

interface FailureMode {
  name: string;
  /** True where this injection PROVABLY prevents durable handling of `kind`,
   * making any ack — or markSeen — destroyed mail. Conservative on purpose:
   * a cell where the injection may not bite still gets the UNCONDITIONAL
   * directions, and there are FIVE — count them in `assertCell` rather than
   * trusting this list, which has now been wrong twice: ack⇒durable, ack⇒seen,
   * seen⇒durable, poison never spooled, poison never rendered. (The earlier
   * repair of this very block added the one it was missing, asserted a count,
   * and omitted a different one — seen⇒durable. An index that is consulted
   * before narrowing a predicate has to be checkable, so the instruction to
   * recount is part of it.) Conservative here therefore means "asserts less",
   * never "asserts nothing". */
  mustNotAck: (kind: FrameKind) => boolean;
  /**
   * True where this mode claims the failure lands BEFORE any ciphertext is
   * examined, so the frame must leave NO durable trace: no spool record, no
   * rendered line, no ratchet advance.
   *
   * CONSTRAINT: a mode that advertises "nothing here was even looked at" is
   * checked against the disk, never trusted. An earlier revision's H1: 'account root
   * read-only (ratchet lock uncreatable)' advertised exactly that while the
   * lock was in fact acquired in ~1ms — inputs: any spoolable frame arriving
   * at a 0o500 account root whose `ratchet.lock` DIRECTORY already exists
   * (the module-scope handshake and every earlier cell create it, 0o700, and
   * chmod on the parent does not touch it) -> the ratchet is durably
   * advanced, a durable spool row is written, and the ack is suppressed only
   * because `markSeen` then fails into the frame-chain catch. All 16 cells
   * passed while asserting nothing about a lock refusal. `mustNotAck` alone
   * cannot catch that, because the incidental markSeen failure satisfies it.
   *
   * THE SPOOL HALF WAS NOT ENOUGH EITHER. Restated because
   * the fix above was written as if it were: with the `*.lock` sweep dropped
   * again, only 6 of the 16 cells failed — the three spooling kinds in each
   * sweep. The other 10 (carrier-react, call-envelope, vault-announcement,
   * corrupt-garbage, corrupt-bitflip) sat green while the ratchet was being
   * advanced under a mode that claims nothing was examined, which is
   * destroyed mail: the unacked redelivery comes back a ratchet duplicate and
   * is purged with a POSSIBLE MESSAGE LOSS report. So the predicate now also
   * asserts `decryptFootprintChanged` — no session record written, no
   * identity re-pinned, no one-time prekey consumed — which flips for every
   * VALID kind rather than only the spooling ones. The two corrupt kinds
   * write nothing to those stores even on a healthy path, so they are held
   * by the injection's own setup self-check instead (`ratchetLockIsTakeable`
   * for the read-only-root mode, the live holder's `ready` file for the
   * contention mode, which has no corrupt cells anyway — `onlyKinds` leaves
   * it two valid ones). A setup self-check fails every cell of its mode at
   * once, which is the coverage this predicate cannot reach from outside.
   */
  mustLeaveNoTrace?: (kind: FrameKind) => boolean;
  /**
   * True where this injection PROVABLY lands AFTER the spool append, so the
   * plaintext must be readable on disk whatever became of the ack.
   *
   * CONSTRAINT: an injection downstream of custody must still leave custody
   * taken. 'seen-marker write fails post-append' was written for direction 1
   * and could not reach it — `markSeen` precedes the ack on both paths, so
   * that mode never produces an ack and every one of its 16 cells asserted
   * nothing at all. Inputs it now catches: `markSeen` moved above
   * `log.append` -> under this injection the append never runs, the
   * unacked redelivery is refused as a ratchet duplicate and purged, and
   * the plaintext is gone with no spool row and no quarantine.
   *
   * IT CANNOT TELL THAT ITS OWN INJECTION STOPPED, and that is `mustNotMarkSeen`'s
   * job, not this one's: a HEALTHY decrypt writes the same spool row, so
   * deleting the injection outright left all 16 cells green.
   */
  mustPersist?: (kind: FrameKind) => boolean;
  /**
   * True where this injection breaks the SEEN-MARKER WRITE ITSELF, so no cell
   * of this mode may come back seen.
   *
   * CONSTRAINT: an injection whose effect no other observable distinguishes
   * from success must be watched by one that does. An earlier revision's H1b:
   * 'seen-marker write fails post-append' asserted only `mustPersist` — "a
   * spool row exists" — which is equally true when nothing is injected, so
   * replacing its setup with a no-op left `Tests 16 passed`. `seen` is the
   * observable that differs: with the squat in place `markSeen` throws and
   * nothing is ever marked (and therefore, by ACK⇒SEEN, nothing is ever
   * acked); without it every cell comes back seen, corrupt kinds included —
   * the tamper purge marks seen too. That covers all 16, not the 6 spooling
   * ones. This is NOT a claim that acking would be wrong here (it would not
   * be: the record is already durable), which is why it is a predicate of
   * its own and not `mustNotAck`.
   */
  mustNotMarkSeen?: (kind: FrameKind) => boolean;
  /** Awaited: an injection that needs a second process to be real (the held
   * ratchet lock) cannot be staged synchronously. */
  setup: () => void | Promise<void>;
  teardown: () => void | Promise<void>;
  /** The no-injection row, whose job is proving the harness CAN see acks. */
  control?: boolean;
  /** Bounds modes that are slow by construction (the lock wait is 10s). */
  onlyKinds?: readonly string[];
  timeoutMs?: number;
}
// NO per-mode "also sweep the mirror" flag. There was one —
// `callPath: boolean` — and it is deleted rather than corrected, because no
// flag of that shape can be right: it makes the mirror's coverage an opt-in
// that a new mode gets wrong by default, and the ONE mode left opted out
// ('ratchet lock held by a live process') was the incident the harness was
// written for. Both sweeps now run the whole product: every mode in this
// list × every kind in `frameKinds`, with `onlyKinds` — a statement about
// cost, applied identically to both sweeps — the only narrowing left.

/**
 * A REAL holder for an account's ratchet lock: a child process that takes it
 * through lock.ts's OWN api and keeps it until this process says let go.
 *
 * CONSTRAINT: the injection may not know how a lock is REPRESENTED. This mode
 * used to forge the holder — `writeFileSync(root/ratchet.lock, 'held-by-
 * harness')` — which made the harness a second, unmaintained implementation
 * of lock.ts, and the two drifted the moment the lock became a directory with
 * a token inside it: `setup` threw EISDIR, and a mode whose setup throws is a
 * mode that asserts nothing, silently, in the one cell that watches the
 * incident this file was written for. Taking the lock through the API holds
 * under any representation, and it makes "held by a LIVE process" literally
 * true — which is what the stale-steal path keys on, and what a forged token
 * could only imitate.
 */
const LOCK_HOLDER_SRC = `
import { existsSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const [, , lockSrc, lockPath, readyPath, releasePath] = process.argv;
const { withFileLockAsync } = await import(pathToFileURL(lockSrc).href);
await withFileLockAsync(lockPath, async () => {
  writeFileSync(readyPath, String(process.pid));
  while (!existsSync(releasePath)) await new Promise((r) => setTimeout(r, 5));
});
`;

let holderSeq = 0;

async function holdRatchetLock(root: string): Promise<{ release: () => Promise<void> }> {
  const tag = `${process.pid}-${++holderSeq}`;
  const script = join(home, `lock-holder-${tag}.mts`);
  const ready = join(home, `lock-held-${tag}`);
  const letGo = join(home, `lock-release-${tag}`);
  writeFileSync(script, LOCK_HOLDER_SRC, { mode: 0o600 });
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      script,
      join(process.cwd(), 'packages/cli/src/lock.ts'),
      join(root, 'ratchet.lock'),
      ready,
      letGo,
    ],
    {
      cwd: process.cwd(), // bare 'tsx' resolves from the repo root
      env: { ...process.env, TACENDUM_HOME: home, NODE_USE_SYSTEM_CA: '0' },
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  );
  let stderr = '';
  child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
  const exited = new Promise<void>(resolve => child.on('exit', () => resolve()));
  // A holder that never took the lock must fail LOUDLY as itself: the cell
  // behind it would otherwise run with no contention at all and pass.
  //
  // AND IT MUST NOT FAIL LOUDLY WHILE STILL HOLDING THE LOCK. The child may
  // have taken the lock and then stalled before writing `ready` (a loaded
  // machine, a slow `ps` in the incarnation probe), in which case this throw
  // is the last anyone hears of it: nothing releases it, the release-file it
  // polls for is deleted with the temp home in `afterAll`, and the process
  // spins forever as an orphan while every remaining cell in this file
  // contends for a lock nobody will give back. Concrete failure this
  // prevents: one slow holder boot -> the whole rest of the sweep waits its
  // 10s refusal, reports "acked=false" for the wrong reason, and a stray
  // node process survives the run. Killed and reaped before the throw
  // escapes.
  try {
    await vi.waitFor(
      () => {
        if (!existsSync(ready)) {
          throw new Error(`the lock holder never took ${root}/ratchet.lock: ${stderr.slice(0, 400)}`);
        }
      },
      { timeout: 30_000, interval: 20 },
    );
  } catch (err) {
    child.kill('SIGKILL');
    await exited;
    for (const p of [script, ready, letGo]) rmSync(p, { force: true });
    // The lock directory outlives a SIGKILLed holder; lock.ts steals it only
    // after LOCK_STALE_MS, which is longer than a cell's budget. Removing it
    // is what the timeout message itself tells an operator to do.
    rmSync(join(root, 'ratchet.lock'), { recursive: true, force: true });
    throw err;
  }
  return {
    release: async () => {
      writeFileSync(letGo, '');
      await exited; // released and gone before the next cell contends
      for (const p of [script, ready, letGo]) rmSync(p, { force: true });
    },
  };
}

interface TargetPaths {
  /** clientDir: ratchet.lock, seen.json, sessions/, prekeys/, identities/. */
  root: string;
  /** stateDir: messages.jsonl and its messages.lock. */
  state: string;
  spool: string;
  /** The target's OWN store handle. An injection that squats a private temp
   * path proves it bit by calling the real api that writes there, rather than
   * trusting the convention it copied — see the seen-marker mode. */
  stores: InstanceType<typeof FileStores>;
}

/** One entry per way a machine can locally fail mid-frame. Adding a mode is
 * adding an entry; nothing else in the file has to know it exists. */
function failureModes(p: TargetPaths): FailureMode[] {
  // Per call, so the two sweeps cannot share a holder; cells run serially.
  let held: { release: () => Promise<void> } | null = null;
  return [
    {
      name: 'no failure (control)',
      mustNotAck: () => false,
      setup: () => {},
      teardown: () => {},
      control: true,
    },
    {
      // The append cannot open the spool: the EACCES surfaces from log.append.
      name: 'spool file read-only',
      mustNotAck: k => k.spools,
      setup: () => chmodSync(p.spool, 0o400),
      teardown: () => chmodSync(p.spool, 0o600),
    },
    {
      // The spool's OWN lock cannot be created (a CliError, not an fs error),
      // and the undelivered quarantine cannot be written either — the
      // worst-documented residual, where the render is the last copy.
      name: 'state dir read-only (spool lock + quarantine unwritable)',
      mustNotAck: k => k.spools,
      // The lock DIRECTORIES have to go before the chmod, or this mode stops
      // injecting the failure it is named for. lock.ts now keeps each lock in
      // its own directory whose holders are single-use entries inside it; a
      // `*.lock` left over from an earlier cell is 0o700 and writable, so
      // acquisition happily stages a token in there while the state dir is
      // read-only, the append to the already-open spool succeeds, and the
      // frame is acked — the mode silently degrades from "custody is
      // impossible" to "custody worked". Removing them first restores the
      // injection: mkdir into a read-only state dir is EACCES, which is the
      // CliError this mode exists to send through the ack decision.
      //
      // THE OLD TEXT HERE ENDED "That is a green cell asserting nothing", and
      // that sentence was false against this tree — corrected rather than
      // deleted, because a justification comment nobody re-measures is how
      // an earlier revision got three of its findings. Measured 2026-07-30, with the
      // `*.lock` sweep dropped and the chmod kept: `Tests 6 failed | 10
      // passed`, every failure "[state dir read-only × <spooling kind>] acked
      // under a local failure". Dropping the chmod instead and keeping the
      // sweep gives the same 6. So BOTH halves are pinned, and by the same
      // cells — `mustNotAck: k => k.spools` sees the ack that the degraded
      // mode allows. What is true is the narrower statement: the other 10
      // cells (the three non-spooling valid kinds and the two corrupt ones,
      // in both sweeps) cannot see this injection stop, and that is honest
      // rather than a hole — an unwritable state dir provably bites only the
      // kinds that take the spool lock. Unlike the read-only-root mode below,
      // this one never claims the frame was left unexamined, so there is
      // nothing here for `mustLeaveNoTrace` to hold.
      setup: () => {
        for (const lock of readdirSync(p.state).filter(f => f.endsWith('.lock'))) {
          rmSync(join(p.state, lock), { recursive: true, force: true });
        }
        chmodSync(p.state, 0o500);
      },
      teardown: () => chmodSync(p.state, 0o700),
    },
    {
      // EVERY successful decrypt must persist the ratchet advance, so this
      // provably fails every valid kind — and libsignal wraps the throw in a
      // code-Generic LibSignalErrorBase that is, BY TYPE, tamper. The exact
      // shape that acked valid mail away over a full disk.
      name: 'session save fails mid-decrypt',
      mustNotAck: k => k.valid,
      setup: () => chmodSync(join(p.root, 'sessions'), 0o500),
      teardown: () => chmodSync(join(p.root, 'sessions'), 0o700),
    },
    {
      // Consumed one-time prekey cannot be deleted: bites first-contact only.
      // In the CALL sweep too, since an earlier revision gave the mirror a prekey kind.
      name: 'one-time-prekey delete fails mid-decrypt',
      mustNotAck: k => k.prekey,
      setup: () => chmodSync(join(p.root, 'prekeys'), 0o500),
      teardown: () => chmodSync(join(p.root, 'prekeys'), 0o700),
    },
    {
      // The TOFU pin write fails.
      //
      // WIDENED FROM `k.prekey` TO EVERY VALID KIND, because the
      // old predicate was a guess and the guess was wrong in the direction
      // that under-asserts. libsignal re-pins the sender's identity on EVERY
      // decrypt, not only on first contact: with `identities/` at 0o500 all
      // six valid kinds fail with `error in method call 'saveIdentityKey':
      // EACCES`, so five cells per sweep were declared "merely
      // opportunistic" while in fact proving a local failure the harness
      // then declined to hold anything to. If a future libsignal stops
      // re-pinning on post-handshake ciphertext, this fails as "acked under
      // a local failure" — that is a premise to re-derive from the tree, not
      // an assertion to weaken back.
      name: 'identity pin write fails mid-decrypt',
      mustNotAck: k => k.valid,
      setup: () => chmodSync(join(p.root, 'identities'), 0o500),
      teardown: () => chmodSync(join(p.root, 'identities'), 0o700),
    },
    {
      // The ratchet lock file cannot even be created: a CliError before any
      // ciphertext is examined, so NOTHING here may be acked — including the
      // corrupt frames, which were never proven corrupt.
      name: 'account root read-only (ratchet lock uncreatable)',
      mustNotAck: () => true,
      mustLeaveNoTrace: () => true,
      // THE TWIN OF THE STATE-DIR MODE ABOVE, missed when that one was
      // repaired. The mechanics are identical and so is the fix:
      // `clientDir/ratchet.lock` is a DIRECTORY, created by the module-scope
      // handshake and by every earlier cell, 0o700 and writable — and chmod
      // on its PARENT does not touch it. Acquisition therefore stages its
      // token inside the surviving directory and succeeds; measured before
      // this fix, every one of the 16 cells decrypted the frame, durably
      // advanced the ratchet, wrote a durable spool row for the spoolable
      // kinds, and died at `markSeen` with EACCES — "!! frame processing
      // error" in all 16, never once the lock refusal this mode is named
      // for, at 80-410ms rather than the 10s a refusal costs. Removing the
      // directories first makes ensureLockDir's own mkdir the EACCES, which
      // is the CliError raised before any ciphertext is read. `mustLeaveNoTrace`
      // above is the pin that keeps this honest — but only for the kinds it
      // can see. Measured 2026-07-30 with the self-check below deleted and
      // the `*.lock` sweep dropped: 12 of the 16 cells fail (6 on the spool
      // half, 6 more on `decryptFootprintChanged`), and the 4 that do not are
      // the corrupt kinds in both sweeps, which write nothing to the decrypt
      // stores even when the lock IS taken. Those 4 are held by the setup's
      // own self-check below, and nothing else in the file can hold them.
      setup: () => {
        for (const lock of readdirSync(p.root).filter(f => f.endsWith('.lock'))) {
          rmSync(join(p.root, lock), { recursive: true, force: true });
        }
        chmodSync(p.root, 0o500);
        // SELF-CHECK, ASKED THROUGH lock.ts's OWN API. This mode's entire
        // claim is "the lock cannot be created", and for the two corrupt
        // kinds nothing downstream can tell a refusal from a rejection —
        // both spool nothing, render nothing and ack nothing. So the
        // injection is asked to demonstrate itself, per cell, before the
        // frame is delivered.
        //
        // Discriminating on BOTH halves of the injection: drop the `*.lock`
        // sweep and the surviving 0o700 directory takes the lock in ~1ms;
        // drop the chmod and `ensureLockDir`'s mkdir succeeds. Either way
        // every cell of this mode dies here as a broken premise instead of
        // passing while the ratchet is quietly advanced.
        premise(
          !ratchetLockIsTakeable(p.stores),
          `the ratchet lock under ${p.root} is still takeable with the account root at 0o500 — this mode has stopped injecting`,
        );
      },
      teardown: () => chmodSync(p.root, 0o700),
    },
    {
      // A live sibling holding the ratchet lock: lock.ts waits its full 10s
      // and refuses with the same CliError a busy machine produces. THE cell
      // from the incident list — "a lock-acquisition timeout destroyed mail"
      // — and the root stays writable, so a reverted tamper branch CAN ack
      // here and be caught (unlike the 0o500 row, where markSeen's own
      // failure would mask the revert).
      //
      // CONSTRAINT: this mode runs in BOTH sweeps. `listen --calls`
      // takes the SAME ratchet lock as `listen`, from its own copy of the
      // local-failure guard: a call-session guard that let the "is held"
      // CliError reach the tamper branch marked the frame seen and acked the
      // server's only copy, and nothing here could see it — every other
      // CallSession mode fails somewhere the guard still recognises (an
      // uncreatable lock under a read-only root is a different CliError, on a
      // path where markSeen would fail too).
      //
      // Two kinds, not one: 10s of lock wait per cell is the mode's own cost,
      // so the list stays short, but it must contain a first-contact PREKEY
      // frame as well as post-handshake text. A hook-driven `send` holding
      // the ratchet lock while a stranger's first message arrives is the
      // ordinary shape of this race, and a guard that discriminates by
      // msgType (or a decrypt path that reaches for a one-time prekey before
      // the lock refusal is classified) is invisible to a plain-text-only
      // cell.
      name: 'ratchet lock held by a live process',
      mustNotAck: () => true,
      // Same claim as the read-only-root mode, so the same disk check: the
      // refusal is raised before `decryptEnvelope` is entered, so a spool row
      // or a rendered line here would mean the sibling never actually held
      // the lock and the cell was watching an uncontended decrypt.
      mustLeaveNoTrace: () => true,
      onlyKinds: ['plain-text', 'prekey-first-contact'],
      timeoutMs: 60_000, // holder boot, then the full 10s refusal
      setup: async () => {
        held = await holdRatchetLock(p.root);
      },
      teardown: async () => {
        const h = held;
        held = null;
        await h?.release();
      },
    },
    {
      // The seen-marker WRITE fails — and only the write — after the spool
      // append succeeded: the account root at 0o500 with the ratchet lock's
      // directory kept, so writeFileAtomic cannot create its temp beside
      // seen.json (EACCES, inside its recorded try). No mustNotAck: acking a
      // durably-appended record is safe even if the seen marker is lost.
      //
      // THIS MODE IS ON ITS THIRD INJECTION, and the failures of the first
      // two are its spec. The original squat sat on writeFileAtomic's temp
      // path, `seen.json.<pid>.tmp` — predictable by design. The external
      // scan fix made that name fresh entropy per write,
      // with O_EXCL refusing anything pre-placed — this mode's own trick,
      // outlawed. The replacement squatted the TARGET (a directory at
      // seen.json, the live file parked beside), and its comment claimed
      // "reads stay healthy" because loadSeen folds the EISDIR into "nothing
      // seen yet" — but an injection for the WRITE had broken every READ:
      // ids that WERE seen answered unseen, so sweep 2's pre-seen settle
      // marker fell off its read-only redelivery branch into a decrypt whose
      // own tamper purge died at markSeen under the same squat. No frame of
      // this mode could ever ack, settleCaller timed its 10s out per cell,
      // and all 8 CallSession cells failed — the release-gate red of
      // 2026-08-10.
      //
      // The chmod is the injection whose blast radius this file has already
      // MEASURED: the account-root mode's H1 history — root at 0o500 while
      // the 0o700 ratchet.lock directory survives — is verbatim "decrypted
      // the frame, durably advanced the ratchet, wrote a durable spool row
      // for the spoolable kinds, and died at markSeen with EACCES". That is
      // this mode's exact claim, reached without touching seen.json itself:
      // the live file stays readable in place (hasSeen stays truthful for
      // every earlier mark, no park/restore), sessions/, prekeys/,
      // identities/ and the state dir keep their own modes, and the ONLY
      // root-level write any frame performs is the seen marker's temp. The
      // contrast with the account-root mode is the lock: that mode removes
      // the `*.lock` directories so acquisition refuses BEFORE custody; this
      // one proves the lock takeable on both sides of the chmod so custody
      // SUCCEEDS and the failure lands after it.
      //
      // THIS MODE'S OLD STATED PURPOSE WAS UNREACHABLE, and saying so rather
      // than leaving it: "the cell exists for direction 1 — any reordering of
      // append/markSeen/ack must still never ack before disk". `markSeen`
      // precedes `ws.send({type:'ack'})` at every ack site on both inbound
      // paths, so an injection that breaks `markSeen` guarantees NO ack ever
      // leaves, which makes direction 1 (`if (res.acked && kind.spools)`)
      // dead code here. Measured: all 16 cells came back
      // acked=false seen=false, i.e. asserting nothing whatsoever.
      //
      // What this injection CAN pin is the ordering from the other side —
      // custody was taken before the seen marker was attempted — which is
      // `mustPersist` below, and which is the half that actually loses mail
      // when it is wrong.
      //
      // AND `mustPersist` ALONE STILL COULD NOT SEE ITS OWN INJECTION: a healthy decrypt writes the same spool row, so deleting the
      // setup entirely left all 16 cells green with nothing injected at all.
      // `mustNotMarkSeen` is the observable that differs — see its doc block.
      name: 'seen-marker write fails post-append',
      mustNotAck: () => false,
      mustNotMarkSeen: () => true,
      mustPersist: k => k.valid && k.spools,
      setup: () => {
        // BEFORE the chmod: taking the lock through its own api creates
        // ratchet.lock's directory if an earlier mode's `*.lock` sweep
        // removed it. Under 0o500 a missing lock directory cannot be
        // recreated, and the mode would silently degrade into the
        // account-root refusal — custody never taken, `mustPersist` red for
        // the wrong reason.
        premise(
          ratchetLockIsTakeable(p.stores),
          `the ratchet lock under ${p.root} is not takeable before the chmod — this mode cannot stage its injection`,
        );
        chmodSync(p.root, 0o500);
        // SELF-CHECK ONE, through the same public api the code under test
        // calls, because the chmod is coupled to behavior that is not this
        // file's to know: that writeFileAtomic stages its temp BESIDE the
        // target. A write path that started staging elsewhere (a temp
        // subdirectory, O_TMPFILE) would silently revert all 16 cells of
        // this mode to asserting nothing, with no test failing anywhere —
        // measured, in this mode's first life. A `markSeen` that
        // SUCCEEDS here means the injection is gone. Loud as itself, per
        // cell, before delivery.
        const probeId = `SEENFAIL-${ulid()}`;
        let refused = false;
        try {
          p.stores.markSeen(probeId);
        } catch {
          refused = true;
        }
        premise(
          refused && !p.stores.hasSeen(probeId),
          `markSeen under ${p.root} at 0o500 did not fail — the seen-marker write survived the read-only account root and this mode has stopped injecting`,
        );
        // SELF-CHECK TWO, the half the first cannot see: the failure must
        // land AFTER custody, so the lock this mode deliberately preserves
        // must still be takeable — the property that separates it from the
        // account-root mode. A lock.ts that started staging lock tokens at
        // the account root (rather than inside the lock's own directory)
        // would flip every cell here into a before-custody refusal while the
        // first self-check stayed green.
        premise(
          ratchetLockIsTakeable(p.stores),
          `the ratchet lock under ${p.root} stopped being takeable at 0o500 — custody would refuse before the seen marker is ever attempted, which is the account-root mode's claim, not this one's`,
        );
        // The probe's own failure is RECORDED, and stores.ts states the
        // protocol: take it once before the decrypt or "a leftover record from
        // an earlier operation would launder a real tamper into transient".
        // Inert today — inbound.ts classifies through its own WeakMap probe —
        // but inbound.ts:60 says that probe should be replaced by exactly this
        // first-party recorder, and on the day it is, these cells would start
        // delivering every frame with a stale failure armed and nothing here
        // would notice: seen stays false, so `mustNotMarkSeen` is satisfied
        // either way.
        p.stores.takePersistenceFailure();
      },
      teardown: () => chmodSync(p.root, 0o700),
    },
  ];
}

interface CellResult {
  msgId: string;
  acked: boolean;
  seen: boolean;
  /** Spool contents on disk at the instant this msgId's ack left, if it did. */
  spoolAtAck: MessageRecord[] | undefined;
  expectText: string | null;
  /** stdout records (attachInbound only; CallSession prints via console). */
  lines: Record<string, unknown>[] | null;
  /** Did sessions/, identities/ or prekeys/ change while this frame was in
   * flight? The ratchet advance made observable — see `decryptFootprint`. */
  decryptFootprintChanged: boolean;
}

/** The invariant, asserted identically for every cell of both sweeps. */
function assertCell(mode: FailureMode, kind: FrameKind, res: CellResult, spoolPath: string): void {
  const cell = `[${mode.name} × ${kind.kind}]`;

  // Direction 2: a proven local failure never acks — and never marks seen,
  // because a seen frame is acked away unprocessed on its next redelivery.
  if (mode.mustNotAck(kind)) {
    expect(res.acked, `${cell} acked under a local failure: the server's only copy is gone`).toBe(false);
    expect(res.seen, `${cell} marked seen under a local failure: the redelivery will be acked away unprocessed`).toBe(false);
  }

  // ACK ⇒ SEEN, unconditionally and on every path. Every ack site in
  // inbound.ts and call-session.ts — the success tail, the tamper purge, the
  // duplicate purge, the redelivery branch — marks seen FIRST, and the
  // crash-window cells already pin the pair for duplicates. Pinned for the
  // whole matrix because the inverse is a loss report waiting to happen:
  // inputs — a valid frame acked without its seen marker, then redelivered
  // after a reconnect -> `hasSeen` is false, libsignal refuses the
  // already-consumed ciphertext, and the operator gets a POSSIBLE MESSAGE
  // LOSS alarm for mail that was in fact delivered. Cheap here because it
  // gives the many acked=true cells something to hold: before this,
  // `[one-time-prekey delete fails mid-decrypt × carrier-react]` and its
  // siblings asserted literally nothing.
  if (res.acked) {
    expect(res.seen, `${cell} acked without marking seen: the redelivery raises a false loss alarm`).toBe(true);
  }

  // The injection landed where the mode says it lands. See `mustLeaveNoTrace`
  // and `mustPersist` for the concrete failures each prevents.
  if (mode.mustLeaveNoTrace?.(kind) === true) {
    expect(
      readSpool(spoolPath).some(rec => rec.id === res.msgId),
      `${cell} a durable record exists although this mode refuses BEFORE any ciphertext is examined — the injection is not injecting and this cell asserts nothing`,
    ).toBe(false);
    // The half that reaches the kinds the spool cannot: no ratchet advance,
    // no re-pinned identity, no consumed one-time prekey. A frame nobody was
    // allowed to decrypt leaves these three stores byte-identical.
    expect(
      res.decryptFootprintChanged,
      `${cell} sessions/, identities/ or prekeys/ changed although this mode refuses BEFORE any ciphertext is examined — the ratchet was advanced, so the injection is not injecting and the unacked redelivery is now a purgeable duplicate`,
    ).toBe(false);
    if (res.lines !== null) {
      expect(
        res.lines.some(l => l.msgId === res.msgId),
        `${cell} a frame this mode never let anyone decrypt was rendered on stdout`,
      ).toBe(false);
    }
  }
  if (mode.mustPersist?.(kind) === true) {
    expect(
      readSpool(spoolPath).some(rec => rec.id === res.msgId),
      `${cell} the injection lands AFTER custody, so the plaintext must be on disk — it is not, and the unacked redelivery will be refused as a ratchet duplicate`,
    ).toBe(true);
  }
  if (mode.mustNotMarkSeen?.(kind) === true) {
    expect(
      res.seen,
      `${cell} the frame was marked seen although this mode makes the seen-marker write FAIL — the injection is not injecting and this cell asserts nothing`,
    ).toBe(false);
  }

  // Direction 1: at the moment the ack left, the record was already on disk.
  if (res.acked && kind.spools) {
    const atAck = (res.spoolAtAck ?? []).find(rec => rec.id === res.msgId);
    expect(
      atAck !== undefined,
      `${cell} the ack left before the record was readable on disk`,
    ).toBe(true);
    expect(atAck?.text, `${cell} the durable record does not carry the message text`).toBe(res.expectText);
  }
  // …and a seen mark owes the same durability an ack does, for the same
  // redelivery-destroying reason.
  if (res.seen && kind.spools && kind.valid) {
    expect(
      readSpool(spoolPath).some(rec => rec.id === res.msgId),
      `${cell} marked seen without a durable record`,
    ).toBe(true);
  }

  // Direction 3, unconditional half: poison never becomes a record or a line.
  if (!kind.valid) {
    expect(
      readSpool(spoolPath).some(rec => rec.id === res.msgId),
      `${cell} undecryptable ciphertext produced a spool record`,
    ).toBe(false);
    if (res.lines !== null) {
      expect(
        res.lines.some(l => l.msgId === res.msgId),
        `${cell} undecryptable ciphertext was rendered on stdout`,
      ).toBe(false);
    }
  }

  // The control row proves the harness can see acks at all — a sweep in which
  // nothing ever acks would pass every check above and verify nothing. It
  // also pins the documented exception in the POSITIVE direction: corrupt
  // ciphertext MUST still be acked (purged), or poison wedges the queue.
  if (mode.control === true) {
    expect(res.acked, `${cell} control cell did not ack — the harness has gone vacuous`).toBe(true);
    // AND `spools` IS A CLAIM ABOUT THE PRODUCT, not a knob for relaxing
    // assertions. Everywhere else in this function `spools:false` only ever
    // SKIPS a check (direction 1 is `res.acked && kind.spools`), so a
    // regression that started persisting a kind declared unspoolable would
    // be invisible AND would silently remove that kind from the ack⇒durable
    // property. Inputs: `maySpool` widened to accept vault announcements ->
    // '[vault item saved]' bodies land in a spool that outlives the terminal
    // (the M3 "store less" rule) and nothing here notices. The control row is
    // the only place the declaration can be checked against reality, because
    // it is the only row where nothing is injected.
    expect(
      readSpool(spoolPath).some(rec => rec.id === res.msgId),
      `${cell} the spool policy disagrees with this kind's declared \`spools: ${String(kind.spools)}\``,
    ).toBe(kind.spools);
  }
}

// --- shared fixtures ---------------------------------------------------------

const ALICE = '01AKHALICE'.padEnd(26, 'A');
const BOB = '01AKHBOB'.padEnd(26, 'B');
const BOB_NAME = 'ackh-bob';

const aliceStores = new FileStores('ackh-alice');
const bobStores = new FileStores(BOB_NAME);
await generateAndStoreKeys(aliceStores);
const bobUpload = await generateAndStoreKeys(bobStores);
// Alice takes one-time prekey 0; each first-contact cell takes its own later.
await establishSession(aliceStores, ALICE, bundleFrom(BOB, bobUpload, 0));

const bobLog = new MessageLog(BOB_NAME);
const bobPaths: TargetPaths = {
  root: clientDir(BOB_NAME),
  state: stateDir(BOB_NAME),
  spool: bobLog.path,
  stores: bobStores,
};

let cellSeq = 0;

async function makeFromAlice(body: string): Promise<{ from: string; msgType: MsgType; payload: string }> {
  const enc = await encryptText(aliceStores, ALICE, BOB, body);
  // Post-handshake, alice speaks 'ciphertext' — the kind whose decrypt lives
  // entirely on the on-disk session, which several cells rely on.
  premise(enc.msgType === 'ciphertext', 'alice must be past the prekey handshake');
  return { from: ALICE, ...enc };
}

/** What a sweep needs from its sender side — so BOTH sweeps enumerate the
 * SAME kind list below. An earlier revision found the CallSession mirror sweeping a
 * hand-picked three-kind subset, which stayed green while a reverted
 * `!wasCall` spool guard ate every reply delivered through `listen --calls`:
 * a kind that exists only in one sweep protects only one inbound path. */
interface SenderRig {
  /** The established peer's wire id — the corrupt shapes claim it too, so
   * poison arrives from an address the target genuinely has a session with. */
  peer: string;
  /** Real post-handshake ciphertext from the established peer. */
  encrypt: (body: string) => Promise<{ from: string; msgType: MsgType; payload: string }>;
  /** Real first-contact 'prekey' ciphertext from a brand-new sender. */
  firstContact: (text: string) => Promise<{ from: string; msgType: MsgType; payload: string }>;
}

/** A brand-new sender per call, so the frame arrives as first-contact
 * 'prekey' and the decrypt consumes a one-time prekey and pins an identity
 * mid-flight — the two extra store writes the ciphertext kinds never touch.
 * The upload is a thunk because the CallSession target's is minted in a
 * beforeAll; the counter is per-target so no two senders share a prekey. */
function makeFirstContact(
  targetId: string,
  upload: () => Awaited<ReturnType<typeof generateAndStoreKeys>>,
  otk: { next: number },
): SenderRig['firstContact'] {
  return async (text: string) => {
    const n = ++cellSeq;
    const from = `01AKHFRESH${n}`.padEnd(26, 'Z');
    const senderStores = new FileStores(`ackh-fresh-${n}`);
    await generateAndStoreKeys(senderStores);
    await establishSession(senderStores, from, bundleFrom(targetId, upload(), otk.next++));
    const enc = await encryptText(senderStores, from, targetId, text);
    premise(enc.msgType === 'prekey', 'a first message must be a prekey envelope');
    return { from, ...enc };
  };
}

/** One entry per shape a frame can arrive in. Adding a kind is adding an
 * entry — and because both sweeps call this, it lands in the mirror too. */
function frameKinds(rig: SenderRig): FrameKind[] {
  return [
    {
      kind: 'plain-text',
      valid: true,
      spools: true,
      prekey: false,
      make: async () => {
        const text = `plain body ${++cellSeq}`;
        return { ...(await rig.encrypt(text)), expectText: text };
      },
    },
    {
      kind: 'reply-envelope',
      valid: true,
      spools: true,
      prekey: false,
      make: async () => {
        const text = `reply body ${++cellSeq}`;
        return {
          ...(await rig.encrypt(JSON.stringify({ tcm: 'reply', ref: ulid(), text }))),
          expectText: text,
        };
      },
    },
    {
      // A carrier: state transport, deliberately never spooled — an ack without
      // a record is CORRECT here, which is exactly why it is in the matrix.
      kind: 'carrier-react',
      valid: true,
      spools: false,
      prekey: false,
      make: async () => ({
        ...(await rig.encrypt(JSON.stringify({ tcm: 'react', ref: ulid(), ofs: false, emoji: '+1' }))),
        expectText: null,
      }),
    },
    {
      // Call signalling by NAMESPACE (deliberately unparseable as a call, so no
      // call machine side effects): the F2 defect was acking before knowing a
      // frame was not a call.
      kind: 'call-envelope',
      valid: true,
      spools: false,
      prekey: false,
      make: async () => ({
        ...(await rig.encrypt(JSON.stringify({ tcm: 'call.offer', v: -1 }))),
        expectText: null,
      }),
    },
    {
      // Rendered ('[vault item saved]') but never spooled: the third custody
      // class, distinct from both a message and a carrier.
      kind: 'vault-announcement',
      valid: true,
      spools: false,
      prekey: false,
      make: async () => ({
        ...(await rig.encrypt(JSON.stringify({ tcm: 'vault', op: 'put', t: 'door', b: '1234' }))),
        expectText: null,
      }),
    },
    {
      kind: 'prekey-first-contact',
      valid: true,
      spools: true,
      prekey: true,
      make: async () => {
        const text = `first contact ${++cellSeq}`;
        return { ...(await rig.firstContact(text)), expectText: text };
      },
    },
    {
      // Not ciphertext at all: fails deserialization before any store is touched.
      kind: 'corrupt-garbage',
      valid: false,
      spools: false,
      prekey: false,
      make: async () => ({
        from: rig.peer,
        msgType: 'ciphertext' as MsgType,
        payload: Buffer.from(`not signal ciphertext ${++cellSeq}`).toString('base64'),
        expectText: null,
      }),
    },
    {
      // Real envelope, one byte flipped: deserializes (or not), then fails
      // authentication — the closest shape to actual wire tampering.
      kind: 'corrupt-bitflip',
      valid: false,
      spools: false,
      prekey: false,
      make: async () => {
        const enc = await rig.encrypt(`bitflip victim ${++cellSeq}`);
        const bytes = Buffer.from(enc.payload, 'base64');
        const mid = Math.floor(bytes.length / 2);
        bytes[mid] = (bytes[mid] ?? 0) ^ 0xff;
        return { from: rig.peer, msgType: enc.msgType, payload: bytes.toString('base64'), expectText: null };
      },
    },
  ];
}

const KINDS: FrameKind[] = frameKinds({
  peer: ALICE,
  encrypt: makeFromAlice,
  // One-time prekey 0 went to alice; every first-contact sender gets its own.
  firstContact: makeFirstContact(BOB, () => bobUpload, { next: 1 }),
});

// Handshake, exactly as the gate does it: after bob answers once, alice's
// envelopes are 'ciphertext' — and the exchange seeds bob's spool file so the
// chmod-based modes have a file to make read-only.
{
  const ws = new FakeWs(bobPaths.spool);
  const { r, notes } = fakeReporter();
  const inbound = attachInbound({
    name: BOB_NAME,
    userId: BOB,
    stores: bobStores,
    ws: ws as unknown as WsClient,
    report: r,
    log: bobLog,
    consume: true,
  });
  ws.deliver({
    type: 'msg',
    from: ALICE,
    msgId: ulid(),
    ...(await encryptText(aliceStores, ALICE, BOB, 'handshake: first contact')),
    ts: Date.now(),
  });
  await inbound.settled();
  premise(inbound.consumed === 1, `handshake frame was not consumed: ${notes.join(' | ')}`);
  const back = await encryptText(bobStores, BOB, ALICE, 'handshake: reply');
  await decryptEnvelope(aliceStores, ALICE, BOB, back.msgType, back.payload);
}

afterAll(() => {
  if (previousHome === undefined) delete process.env.TACENDUM_HOME;
  else process.env.TACENDUM_HOME = previousHome;
  if (previousApi === undefined) delete process.env.TACENDUM_API;
  else process.env.TACENDUM_API = previousApi;
  rmSync(home, { recursive: true, force: true });
});

// --- sweep 1: attachInbound (listen / sync / send --drain) -------------------

describe('attachInbound: every injected local failure × every frame kind', () => {
  for (const mode of failureModes(bobPaths)) {
    for (const kind of KINDS) {
      if (mode.onlyKinds !== undefined && !mode.onlyKinds.includes(kind.kind)) continue;
      it(
        `${mode.name} × ${kind.kind}`,
        async () => {
          // Made BEFORE the injection: the sender's machine is not the one
          // failing, and a broken premise must not hide behind the chmod.
          const made = await kind.make();
          const msgId = ulid();
          const ws = new FakeWs(bobPaths.spool);
          const { r, lines } = fakeReporter();
          const inbound = attachInbound({
            name: BOB_NAME,
            userId: BOB,
            stores: bobStores,
            ws: ws as unknown as WsClient,
            report: r,
            log: bobLog,
            consume: true,
          });
          // Bracketed OUTSIDE setup/teardown. The conclusion — any difference
          // across this window was written by the frame — holds because
          // `decryptFootprint` reads NAMES and BYTES and never modes, and
          // every setup that reaches these three subdirectories only chmods
          // them ('session save', 'one-time-prekey delete' and 'identity pin'
          // chmod sessions/, prekeys/ and identities/ respectively). It is NOT
          // because setups leave these directories alone: they do not, and a
          // new mode that WROTE one would break this bracket.
          const footprintBefore = decryptFootprint(bobPaths.root);
          // SETUP IS INSIDE THE try, not above it. A setup that throws
          // half-done used to skip teardown entirely, and every setup here
          // mutates something first: a chmod, a squatted temp path, or — in
          // `holdRatchetLock` — a live child process holding the account
          // lock. Measured: one mode's setup made to throw after its chmod
          // took 24 cells down instead of 16, the extra 8 being LATER modes
          // and the two crash-window cells at the very bottom of this file,
          // all running against a read-only spool that no teardown ever
          // restored. Every teardown in `failureModes` is idempotent — a
          // chmod to a mode the path may already have, `rmSync(force)` — so
          // running one after a setup that never fired is safe.
          try {
            await mode.setup();
            ws.deliver({
              type: 'msg',
              from: made.from,
              msgId,
              msgType: made.msgType,
              payload: made.payload,
              ts: Date.now(),
            });
            await inbound.settled();
          } finally {
            // Always undone, or one failed cell would poison every later one.
            await mode.teardown();
          }
          assertCell(mode, kind, {
            msgId,
            acked: ws.acked(msgId),
            seen: bobStores.hasSeen(msgId),
            spoolAtAck: ws.ackSpoolSnapshots.get(msgId),
            expectText: made.expectText,
            lines,
            decryptFootprintChanged: decryptFootprint(bobPaths.root) !== footprintBefore,
          }, bobPaths.spool);
        },
        mode.timeoutMs ?? 20_000,
      );
    }
  }
});

// --- sweep 2: the CallSession mirror (listen --calls / call) -----------------

describe('CallSession: the mirrored inbound path holds the same property', () => {
  const CALLER = 'ackh-caller';
  const CALLER_ID = '01AKHCALLER'.padEnd(26, 'C');
  const PEER_ID = '01AKHPEER'.padEnd(26, 'P');

  const realFetch = globalThis.fetch;
  let session: InstanceType<typeof CallSession>;
  let callerStores: InstanceType<typeof FileStores>;
  let callerUpload: Awaited<ReturnType<typeof generateAndStoreKeys>>;
  let peerStores: InstanceType<typeof FileStores>;
  let callerLog: InstanceType<typeof MessageLog>;
  let callerPaths: TargetPaths;
  let callerSocket: (typeof wsInstances)[number];
  const callerAckSnapshots = new Map<string, MessageRecord[]>();

  function deliverToCaller(frame: ServerFrame): void {
    for (const h of callerSocket.handlers.message ?? []) h(JSON.stringify(frame));
  }

  function ackedByCaller(msgId: string): boolean {
    return callerSocket.sent.some(raw => {
      const parsed = JSON.parse(raw) as { type: string; msgId?: string };
      return parsed.type === 'ack' && parsed.msgId === msgId;
    });
  }

  /** The frame queue is serial: once a trailing pre-seen marker frame is
   * acked (the redelivery branch — reads only, so it works under every
   * injection here), everything delivered before it has settled.
   *
   * CONSTRAINT: the wait must outlast the SLOWEST cell, not the usual one.
   * `lock.ts` spins synchronously for its full 10s before refusing, and that
   * spin blocks this thread — a fixed 10s wait here would expire on the
   * lock-contention cells and report "the marker never acked" for a session
   * that was merely waiting, turning the one cell that watches a real
   * contention failure into a flake. Cells pass their own budget. */
  async function settleCaller(marker: string, timeoutMs = 10_000): Promise<void> {
    deliverToCaller({
      type: 'msg',
      from: PEER_ID,
      msgId: marker,
      msgType: 'ciphertext',
      payload: 'AAAA',
      ts: 1,
    });
    await vi.waitFor(() => expect(ackedByCaller(marker)).toBe(true), { timeout: timeoutMs });
  }

  beforeAll(async () => {
    callerStores = new FileStores(CALLER);
    callerUpload = await generateAndStoreKeys(callerStores);
    saveProfile({
      name: CALLER,
      identityKey: callerUpload.identityKey,
      userId: CALLER_ID,
      authToken: 'live-ackh-caller',
      registrationId: callerUpload.registrationId,
      deviceId: 1,
    });
    peerStores = new FileStores('ackh-peer');
    await generateAndStoreKeys(peerStores);
    await establishSession(peerStores, PEER_ID, bundleFrom(CALLER_ID, callerUpload, 0));

    globalThis.fetch = (async (input: string | URL | Request) => {
      const path = String(input).replace('http://ackharness.test', '');
      if (path === '/v1/ws-ticket') {
        return new Response(JSON.stringify({ ticket: 'tkt', expiresAt: 1 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected request ${path}`);
    }) as typeof fetch;

    callerLog = new MessageLog(CALLER);
    callerPaths = {
      root: clientDir(CALLER),
      state: stateDir(CALLER),
      spool: callerLog.path,
      stores: callerStores,
    };
    sendHook.fn = msgId => {
      // First ack only — same rule as FakeWs.send, same reason.
      if (!callerAckSnapshots.has(msgId)) callerAckSnapshots.set(msgId, readSpool(callerPaths.spool));
    };

    session = new CallSession(CALLER);
    await session.connect();
    const socket = wsInstances[wsInstances.length - 1];
    premise(socket !== undefined, 'CallSession dialed the mocked socket');
    callerSocket = socket!;

    // Handshake: seeds the caller's spool (so chmod modes have a file) and
    // moves the peer past the prekey stage, like the alice/bob pair above.
    const m0 = await encryptText(peerStores, PEER_ID, CALLER_ID, 'handshake seed');
    const seedId = ulid();
    deliverToCaller({ type: 'msg', from: PEER_ID, msgId: seedId, ...m0, ts: Date.now() });
    await vi.waitFor(() => expect(ackedByCaller(seedId)).toBe(true), { timeout: 10_000 });
    const back = await encryptText(callerStores, CALLER_ID, PEER_ID, 'handshake reply');
    await decryptEnvelope(peerStores, PEER_ID, CALLER_ID, back.msgType, back.payload);
  }, 30_000);

  afterAll(() => {
    session.close();
    globalThis.fetch = realFetch;
    sendHook.fn = null;
  });

  const makeFromPeer = async (body: string) => {
    const enc = await encryptText(peerStores, PEER_ID, CALLER_ID, body);
    premise(enc.msgType === 'ciphertext', 'peer must be past the prekey handshake');
    return { from: PEER_ID, ...enc };
  };

  // THE SAME kind list as sweep 1, not a hand-picked subset. An earlier revision's
  // finding: the mirror swept only plain text, a malformed call envelope and
  // garbage, so restoring the historical `!wasCall && maySpool(rendered)`
  // spool guard stayed green here — while a valid REPLY through
  // `listen --calls` (onBody answers true for any envelope it cannot parse)
  // was skipped, marked seen and acked: destroyed mail no cell could see.
  const callKinds: FrameKind[] = frameKinds({
    peer: PEER_ID,
    encrypt: makeFromPeer,
    // One-time prekey 0 went to the peer; fresh senders take their own.
    firstContact: makeFirstContact(CALLER_ID, () => callerUpload, { next: 1 }),
  });

  // failureModes needs callerPaths, which exists only after beforeAll — so
  // modes are built against a lazy proxy of the same shape.
  const lazyPaths: TargetPaths = {
    get root() {
      return callerPaths.root;
    },
    get state() {
      return callerPaths.state;
    },
    get spool() {
      return callerPaths.spool;
    },
    get stores() {
      return callerStores;
    },
  };

  // THE SAME failure list as sweep 1, not a subset — see the note under
  // `interface FailureMode` for why the opt-in flag that used to live here is
  // gone rather than corrected.
  for (const mode of failureModes(lazyPaths)) {
    for (const kind of callKinds) {
      if (mode.onlyKinds !== undefined && !mode.onlyKinds.includes(kind.kind)) continue;
      it(
        `${mode.name} × ${kind.kind}`,
        async () => {
          const made = await kind.make();
          const msgId = ulid();
          const marker = ulid();
          // The settle marker is pre-seen BEFORE the injection: its ack is
          // the redelivery branch, which writes nothing and so still works
          // with the account directory locked down.
          callerStores.markSeen(marker);
          // Same bracket as sweep 1. Placed after the marker's markSeen for
          // ordering hygiene only — markSeen writes seen.json at the account
          // ROOT, which this footprint does not read, so it could not perturb
          // the window either way. What actually keeps the marker out of the
          // measurement is that it is PRE-SEEN and takes the redelivery
          // branch, so it never decrypts.
          const footprintBefore = decryptFootprint(callerPaths.root);
          // Inside the try for the reason spelled out in sweep 1: a setup
          // that throws must still be torn down, or a leaked lock holder and
          // a leftover chmod decide every later cell's outcome.
          try {
            await mode.setup();
            deliverToCaller({
              type: 'msg',
              from: made.from,
              msgId,
              msgType: made.msgType,
              payload: made.payload,
              ts: Date.now(),
            });
            // Leave the cell's own timeout a margin to report the real
            // assertion rather than dying inside the wait.
            await settleCaller(marker, Math.max(10_000, (mode.timeoutMs ?? 20_000) - 15_000));
          } finally {
            await mode.teardown();
          }
          assertCell(mode, kind, {
            msgId,
            acked: ackedByCaller(msgId),
            seen: callerStores.hasSeen(msgId),
            spoolAtAck: callerAckSnapshots.get(msgId),
            expectText: made.expectText,
            lines: null, // CallSession prints via console; stdout is not asserted here
            // The settle marker inside this window is PRE-SEEN, so it takes
            // the redelivery branch — an ack and nothing else, no decrypt and
            // no store write of its own.
            decryptFootprintChanged: decryptFootprint(callerPaths.root) !== footprintBefore,
          }, callerPaths.spool);
        },
        mode.timeoutMs ?? 20_000,
      );
    }
  }

  // THE CRASH WINDOW, IN THE MIRROR. The block at the bottom of this
  // file pinned the loud-purge property against `attachInbound` only, so it
  // stayed green for a whole round while `listen --calls` reported the same
  // event as tamper: an earlier revision exported the duplicate classifier "because the
  // CallSession mirror owes the identical classification", and the mirror
  // never imported it. A property pinned on one of two mirrored paths is a
  // property pinned on neither — the same lesson as the kind list above.
  //
  // Both directions, because the alarm has to be PRECISE as well as loud: a
  // listener that cries LOSS on every two-process drain teaches the operator
  // to ignore the one alarm that matters.

  /** Runs one already-consumed-ciphertext redelivery through the live session
   * and returns what the operator was told. CallSession reports on console. */
  async function redeliverConsumed(
    made: { from: string; msgType: MsgType; payload: string },
    msgId: string = ulid(),
  ): Promise<{ msgId: string; errs: string[] }> {
    const marker = ulid();
    callerStores.markSeen(marker);
    const errs: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errs.push(args.map(a => String(a)).join(' '));
    });
    try {
      deliverToCaller({
        type: 'msg',
        from: made.from,
        msgId,
        msgType: made.msgType,
        payload: made.payload,
        ts: Date.now(),
      });
      await settleCaller(marker);
    } finally {
      spy.mockRestore();
    }
    return { msgId, errs };
  }

  it('crash window: reports the possible loss loudly instead of purging it as silent poison', async () => {
    const text = `call-path crash-window victim ${++cellSeq}`;
    const made = await makeFromPeer(text);

    // The dead run: `decryptEnvelope` durably advanced the caller's ratchet,
    // then the process died before custody. The disk state after a SIGKILL in
    // that window is exactly what this bare call produces.
    await decryptEnvelope(callerStores, CALLER_ID, PEER_ID, made.msgType, made.payload);

    const { msgId, errs } = await redeliverConsumed(made);

    expect(
      errs.some(n => n.includes(msgId) && /loss|lost/i.test(n)),
      'a message the ratchet consumed but never delivered was purged without any loss report',
    ).toBe(true);
    expect(
      errs.some(n => n.includes(msgId) && n.includes('DECRYPT FAILED')),
      'lost mail was reported to the operator as rejected tamper',
    ).toBe(false);
    // Rule 4, trivially held here (the plaintext no longer exists to leak) —
    // pinned anyway, because this branch is the one that talks about a
    // message it could not decrypt.
    expect(errs.some(n => n.includes(text)), 'plaintext reached an operator-facing line').toBe(false);
    expect(readSpool(callerPaths.spool).some(rec => rec.id === msgId)).toBe(false);
    // Purged coherently (ack <=> markSeen): every redelivery until the 30-day
    // TTL would fail in exactly the same place.
    expect(ackedByCaller(msgId), 'the unrecoverable duplicate must still be purged').toBe(true);
    expect(callerStores.hasSeen(msgId), 'purged but not marked seen').toBe(true);
  }, 30_000);

  it('crash window: stays quiet when a sibling process already delivered the duplicate', async () => {
    const text = `call-path sibling delivered ${++cellSeq}`;
    const made = await makeFromPeer(text);
    const msgId = ulid();

    // The sibling decrypted AND took custody; this session's hasSeen gate ran
    // before the sibling's mark landed — the ordinary two-listener drain race.
    await decryptEnvelope(callerStores, CALLER_ID, PEER_ID, made.msgType, made.payload);
    callerLog.append({ id: msgId, dir: 'in', peer: PEER_ID, ts: Date.now(), tcm: '', text, read: false });

    const { errs } = await redeliverConsumed(made, msgId);

    expect(ackedByCaller(msgId)).toBe(true);
    expect(
      errs.some(n => n.includes(msgId) && /loss|lost/i.test(n)),
      'a duplicate with a durable spool record was misreported as a loss',
    ).toBe(false);
  }, 30_000);
});

// --- the crash window: ratchet committed, custody never taken ----------------
//
// The one lifecycle the matrix above cannot reach, because it needs the SAME
// ciphertext delivered twice with nothing recorded in between.
// A process that dies after `decryptEnvelope` durably advanced the session
// but before `log.append` leaves: ratchet consumed, no spool row, no seen
// mark, no ack. The disk state after a SIGKILL in that window is exactly what
// a bare `decryptEnvelope` call produces, so that is how the dead run is
// simulated — the real code path is then the redelivery, which is the code
// under test. The plaintext is genuinely unrecoverable (redelivery.test.ts);
// what these cells pin is that the purge is never SILENT: acking a lost valid
// message away with the tamper branch's "message rejected" told the operator
// the opposite of the truth.

describe('redelivery after a crash between ratchet commit and spool custody', () => {
  it('reports the possible loss loudly instead of purging it as silent poison', async () => {
    const text = `crash-window victim ${++cellSeq}`;
    const made = await makeFromAlice(text);
    const msgId = ulid();

    // The dead run: ratchet durably advanced, custody never taken.
    await decryptEnvelope(bobStores, BOB, ALICE, made.msgType, made.payload);
    premise(!bobStores.hasSeen(msgId), 'the crashed run must not have marked the frame seen');

    // The reconnect: the server redelivers the unacked row — same msgId,
    // same bytes — through the real inbound policy.
    const ws = new FakeWs(bobPaths.spool);
    const { r, lines, notes } = fakeReporter();
    const inbound = attachInbound({
      name: BOB_NAME,
      userId: BOB,
      stores: bobStores,
      ws: ws as unknown as WsClient,
      report: r,
      log: bobLog,
      consume: true,
    });
    ws.deliver({ type: 'msg', from: ALICE, msgId, msgType: made.msgType, payload: made.payload, ts: Date.now() });
    await inbound.settled();

    // THE FIX: the operator is told, by msgId, that mail may have died.
    expect(
      notes.some(n => n.includes(msgId) && /loss|lost/i.test(n)),
      'a message the ratchet consumed but never delivered was purged without any loss report',
    ).toBe(true);
    // Nothing is fabricated: no spool record, nothing rendered on stdout, and
    // the plaintext never leaks into operator-facing text (the log-hygiene rule —
    // trivially held here, since it no longer exists to leak).
    expect(readSpool(bobPaths.spool).some(rec => rec.id === msgId)).toBe(false);
    expect(lines.some(l => l.msgId === msgId)).toBe(false);
    expect(notes.some(n => n.includes(text))).toBe(false);
    // The queue is purged coherently (ack <=> markSeen): leaving the row
    // would redeliver an undecryptable frame until the 30-day TTL. If a
    // redesign ever chooses leave-and-alarm instead, this pair is the pin to
    // revisit — the loss REPORT above is the non-negotiable half.
    expect(ws.acked(msgId), 'the unrecoverable duplicate must still be purged').toBe(true);
    expect(bobStores.hasSeen(msgId), 'purged but not marked seen: the next redelivery decrypt-fails again').toBe(true);
  }, 20_000);

  it('stays quiet when a sibling process already delivered the duplicate', async () => {
    const text = `sibling delivered ${++cellSeq}`;
    const made = await makeFromAlice(text);
    const msgId = ulid();

    // The sibling: decrypted AND took custody (spool record), but this
    // process's frame handler passed its hasSeen gate before the sibling's
    // mark landed — the ordinary two-listener drain race.
    await decryptEnvelope(bobStores, BOB, ALICE, made.msgType, made.payload);
    bobLog.append({ id: msgId, dir: 'in', peer: ALICE, ts: Date.now(), tcm: '', text, read: false });

    const ws = new FakeWs(bobPaths.spool);
    const { r, notes } = fakeReporter();
    const inbound = attachInbound({
      name: BOB_NAME,
      userId: BOB,
      stores: bobStores,
      ws: ws as unknown as WsClient,
      report: r,
      log: bobLog,
      consume: true,
    });
    ws.deliver({ type: 'msg', from: ALICE, msgId, msgType: made.msgType, payload: made.payload, ts: Date.now() });
    await inbound.settled();

    // Delivered mail is not a loss: acked away like any redelivery, with no
    // alarm — a listener that cries LOSS on every two-process drain teaches
    // the operator to ignore the one alarm that matters.
    expect(ws.acked(msgId)).toBe(true);
    expect(
      notes.some(n => n.includes(msgId) && /loss|lost/i.test(n)),
      'a duplicate with a durable spool record was misreported as a loss',
    ).toBe(false);
  }, 20_000);
});

// --- the quarantine under two writers at once --------------------------------
//
// quarantineUndelivered holds the LAST copy of a message by contract, so a
// row it reports preserved must survive whatever else is preserving rows at
// the same instant. An earlier revision found the rewrite unlocked: two processes read
// the same undelivered.jsonl, each appended only its own row, and the second
// rename discarded the first one's — reported-preserved plaintext, gone. The
// test is the OUTCOME, in real child processes against the real file: every
// row every process was told was preserved is on disk afterwards, and no
// unexpired pre-existing row was dropped. HOW the writers are serialized (a
// lock, an append, anything else) is deliberately not asserted, so a correct
// refactor cannot fail it.

const QRACE_CHILD = `
import { existsSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const [, , inboundSrc, name, tag, count, barrier] = process.argv;
const { quarantineUndelivered } = await import(pathToFileURL(inboundSrc).href);
// Ready AFTER the import: loading libsignal dominates startup, and the
// barrier exists so both children enter their loops together instead of
// racing module-load time.
writeFileSync(barrier + '.ready.' + tag, '');
while (!existsSync(barrier)) await new Promise((r) => setTimeout(r, 2));
for (let i = 0; i < Number(count); i++) {
  const preserved = quarantineUndelivered(name, {
    id: 'QRACE-' + tag + '-' + i,
    dir: 'in',
    peer: '01QRACEPEER'.padEnd(26, 'A'),
    ts: Date.now(),
    tcm: '',
    text: 'row ' + tag + ' ' + i,
    read: false,
  });
  if (preserved === null) {
    console.error('quarantine refused custody at ' + tag + '-' + i);
    process.exit(3);
  }
}
process.exit(0);
`;

describe('quarantine custody survives two processes preserving at once', () => {
  const QNAME = 'ackh-qrace';
  const CHILD_ROWS = 20;
  // A fat pre-existing file widens each rewrite's read-to-replace window to
  // tens of milliseconds, so the two children's loops genuinely overlap —
  // against an empty file the window is microseconds and the cell would pass
  // vacuously with or without any serialization.
  const SEED_ROWS = 12_000;

  it('loses neither process’s rows nor any unexpired pre-existing row', async () => {
    const qdir = stateDir(QNAME);
    mkdirSync(qdir, { recursive: true, mode: 0o700 });
    const seedTs = Date.now();
    const pad = 'x'.repeat(80);
    const seeds: string[] = [];
    for (let i = 0; i < SEED_ROWS; i++) {
      seeds.push(
        JSON.stringify({
          id: `SEED-${i}`,
          dir: 'in',
          peer: '01QRACEPEER'.padEnd(26, 'A'),
          ts: seedTs,
          tcm: '',
          text: pad,
          read: false,
        }),
      );
    }
    writeFileSync(undeliveredPath(QNAME), `${seeds.join('\n')}\n`, { mode: 0o600 });

    const script = join(home, 'qrace-child.mts');
    writeFileSync(script, QRACE_CHILD, { mode: 0o600 });
    const barrier = join(home, 'qrace-barrier');
    const inboundSrc = join(process.cwd(), 'packages/cli/src/inbound.ts');

    const run = (tag: string): Promise<{ code: number | null; stderr: string }> =>
      new Promise((resolve, reject) => {
        const child = spawn(
          process.execPath,
          ['--import', 'tsx', script, inboundSrc, QNAME, tag, String(CHILD_ROWS), barrier],
          {
            env: { ...process.env, TACENDUM_HOME: home, NODE_USE_SYSTEM_CA: '0' },
            stdio: ['ignore', 'ignore', 'pipe'],
          },
        );
        let stderr = '';
        child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
        child.on('error', reject);
        child.on('close', code => resolve({ code, stderr }));
      });

    const children = [run('A'), run('B')];
    await vi.waitFor(
      () => {
        expect(existsSync(`${barrier}.ready.A`) && existsSync(`${barrier}.ready.B`)).toBe(true);
      },
      { timeout: 60_000 },
    );
    writeFileSync(barrier, '');
    const results = await Promise.all(children);

    for (const res of results) {
      expect(res.code, `exit 2 is forbidden\n${res.stderr}`).not.toBe(2);
      // A refusal under nothing but sibling contention is itself a custody
      // failure: the quarantine exists for exactly the moment it is busy.
      expect(res.code, `a child could not preserve custody under contention:\n${res.stderr}`).toBe(0);
    }

    const content = readFileSync(undeliveredPath(QNAME), 'utf8');
    const missing: string[] = [];
    for (const tag of ['A', 'B']) {
      for (let i = 0; i < CHILD_ROWS; i++) {
        if (!content.includes(`"QRACE-${tag}-${i}"`)) missing.push(`QRACE-${tag}-${i}`);
      }
    }
    expect(missing, 'rows one process preserved were renamed away by the other').toEqual([]);
    const liveSeeds = content.split('\n').filter(l => l.includes('"SEED-')).length;
    expect(liveSeeds, 'unexpired pre-existing rows were dropped by a concurrent rewrite').toBe(SEED_ROWS);
  }, 180_000);
});
