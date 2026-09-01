import { describe, expect, it, vi, afterAll } from 'vitest';

/**
 * CRASH-INJECTION HARNESS — the durable plaintext spool keeps only whole
 * records, and never loses one whose append() returned.
 *
 * Why a harness and not more regression tests. msglog.ts states this
 * invariant in prose, and the prose has been violated three times by authors
 * who had read it: a short write committed a truncated line; a crash between a record and its newline made the NEXT append glue
 * onto the fragment, losing both; and the repair for that
 * truncated a COMPLETE record that merely lacked its LF. Each fix
 * has a hand-picked regression test in gate.msglog*.test.ts — one crash
 * state each. This file generates the crash states MECHANICALLY, so the
 * fourth violation, in a shape nobody has listed, fails here first.
 *
 * THE INVARIANT (msglog.ts's ack contract, asserted as a property):
 *   after ANY crash and one subsequent real append,
 *     (1) every line of messages.jsonl parses — whole records only;
 *     (2) every record whose append() had returned before the crash is still
 *         readable — append() returning is what authorizes acking away the
 *         server's ONLY copy — and is still THE RECORD APPEND() WAS GIVEN,
 *         field for field (or that record with exactly its body withheld,
 *         once redacted). An earlier revision: this file used to assert only that the ID
 *         survived, so a serialization that kept id and text but rewrote
 *         `peer` passed every assertion while misattributing the whole inbox
 *         — an id is not a record;
 *     (3) no record appears that no append ever wrote;
 *     (4) once purge() has returned, no byte of a purged body remains in any
 *         file under the account — including temp litter a crash left. Round
 *         6: a pass SIGKILLed between its temp's fsync and its rename
 *         strands a full pre-rewrite snapshot that no later pass listed, so
 *         this is now asserted against manufactured dead-pass litter too,
 *         not only against whatever the kill instruments happen to strand;
 *     (5) an append may not report success while the durability it promises
 *         is failing: a REAL error (EIO) opening or fsyncing a directory in
 *         the entry chain fails that append and every later one until a
 *         walk succeeds — only a capability refusal (EINVAL/EPERM/ENOTSUP/
 *         EISDIR: "directory fsync is not a thing here") may be absorbed.
 *
 * MECHANICAL GENERATION — six instruments, precision to realism:
 *   - a truncation sweep: a known-good spool is cut at EVERY byte offset
 *     (mid-record, mid-multibyte-codepoint, at the JSON/LF seam, on record
 *     boundaries) and a real append runs against the wreckage;
 *   - a fault-injecting writeSync (pass-through vi.mock): every write goes
 *     short at a swept width, or dies at a swept byte budget — the two
 *     failures writeSync actually has;
 *   - a fault-injecting openSync/fsyncSync on the spool DIRECTORY: a dying
 *     disk (EIO) versus a refusing platform (ENOTSUP and kin) — an earlier revision
 *     found the two conflated at the open, and a first failure forgotten by
 *     the next append;
 *   - manufactured dead-pass litter: the pid-tagged, fsynced temp snapshot
 *     that a SIGKILL between fsync and rename strands, placed
 *     deterministically where the kill instruments can only sometimes land;
 *   - real child processes SIGKILLed at swept confirmation counts and post-
 *     confirmation delays while appending — locks, fds and OS buffers die
 *     mid-flight for real;
 *   - the same, mid retention/purge rewrite cycles.
 *
 * NON-VACUITY: verified by sabotage before landing — (a) repairTail forced
 * to truncate to the last LF unconditionally fails the sweep at each
 * record's JSON/LF seam; (b) writeAllSync reverted to one writeSync fails
 * the short-write sweep; (c) append() without the tail repair fails the
 * sweep across mid-record offsets; (d) a serialization that keeps id and
 * text but rewrites `peer` fails verifyRecords' field comparison; (d2) a retention rewrite that emits
 * {id,dir,peer,ts,text:'',red:true} — tcm, read and bytes dropped — fails 6
 * tests with "redacted record … lost field tcm"; (e) retention without the stranded-
 * temp sweep fails both stranded-snapshot tests; (f) a fsyncDirSync that
 * swallows open errors, or an append that keys the directory walk off the
 * file existing, fails the directory-durability tests. Re-run those edits
 * if this file is ever weakened.
 *
 * WHAT THIS DOES NOT COVER, honestly:
 *   - a real power cut: an fsync that lied, or an un-persisted directory
 *     entry resurrecting a replaced spool. The fsync ORDERING is asserted by
 *     gate.msglog*.test.ts via fs tracing; physical durability is not
 *     observable from userspace. Property (4) is the strongest purge claim a
 *     test can make without cutting power.
 *   - torn bytes INSIDE an already-fsynced region (disk corruption): the
 *     sweep tears only the tail, the shape a dying append produces.
 *   - live-process lock takeover interleavings — gate.lock*.test.ts and
 *     gate.msglog*.test.ts own those; the children here die alone, so
 *     "concurrent append vs retention" is exercised only in its serialized,
 *     crash-interrupted form.
 *   - records larger than repairTail's 8KB backward-scan chunk: the sweep
 *     file is kept small so every offset is affordable (a 20KB fragment has
 *     a gate test).
 *   - SIGKILL cannot be steered onto a chosen syscall; the sweep and the
 *     write clamp supply that precision, the kills supply the realism.
 *
 * Deterministic: no randomness — swept lists only. Child kill timing varies
 * by machine, but every assertion is invariant-true at ANY kill point, so
 * scheduling jitter moves the coverage, never the verdict.
 */

const clamp = vi.hoisted(() => ({
  /** Spool path whose writes get faults; null = everything passes through. */
  path: null as string | null,
  /** Largest byte count one writeSync call may claim to have written. */
  max: Number.POSITIVE_INFINITY,
  /** Total bytes allowed onto the armed path before the next write throws. */
  failAfter: Number.POSITIVE_INFINITY,
  written: 0,
  fdPaths: new Map<number, string>(),
  /** DIRECTORY fault injection: the exact path whose open or fsync fails
   * with the given errno — how a dying disk (EIO) or a refusing platform
   * (ENOTSUP…) surfaces under the directory-entry walk. Only fsyncDirSync
   * ever opens a directory path, so keying on the path is precise. */
  dirPath: null as string | null,
  dirOpenCode: null as string | null,
  dirFsyncCode: null as string | null,
}));

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  const errnoErr = (code: string, what: string): NodeJS.ErrnoException => {
    const err = new Error(`injected ${code} ${what}`) as NodeJS.ErrnoException;
    err.code = code;
    return err;
  };
  const openSync: typeof real.openSync = (path, flags, mode) => {
    if (clamp.dirPath !== null && clamp.dirOpenCode !== null && String(path) === clamp.dirPath) {
      throw errnoErr(clamp.dirOpenCode, 'opening the directory');
    }
    const fd = real.openSync(path, flags, mode);
    clamp.fdPaths.set(fd, String(path));
    return fd;
  };
  const fsyncSync: typeof real.fsyncSync = (fd) => {
    if (
      clamp.dirPath !== null &&
      clamp.dirFsyncCode !== null &&
      clamp.fdPaths.get(fd) === clamp.dirPath
    ) {
      throw errnoErr(clamp.dirFsyncCode, 'fsyncing the directory');
    }
    real.fsyncSync(fd);
  };
  // Only the (fd, buffer, offset, length) shape msglog's write loop uses is
  // intercepted; the lock file, sidecar and everything else pass through, so
  // the fault lands exactly where a full device would put it.
  const writeSync = ((fd: number, data: unknown, a?: unknown, b?: unknown, c?: unknown): number => {
    const armed =
      clamp.path !== null &&
      clamp.fdPaths.get(fd) === clamp.path &&
      typeof data !== 'string' &&
      typeof a === 'number' &&
      typeof b === 'number';
    if (!armed) {
      return (real.writeSync as unknown as (...args: unknown[]) => number)(fd, data, a, b, c);
    }
    if (clamp.written >= clamp.failAfter) {
      const err = new Error('injected device failure') as NodeJS.ErrnoException;
      err.code = 'ENOSPC';
      throw err;
    }
    const allowed = Math.min(b, clamp.max, clamp.failAfter - clamp.written);
    const n = real.writeSync(fd, data as NodeJS.ArrayBufferView, a, allowed);
    clamp.written += n;
    return n;
  }) as typeof real.writeSync;
  return { ...real, openSync, writeSync, fsyncSync };
});

import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const home = mkdtempSync(join(tmpdir(), 'tacendum-crash-'));
process.env.TACENDUM_HOME = home;

const { MessageLog } = await import('../src/msglog.js');
const { stateDir } = await import('../src/config.js');
type MessageRecord = import('../src/msglog.js').MessageRecord;

afterAll(() => rmSync(home, { recursive: true, force: true }));

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const MSGLOG_URL = pathToFileURL(join(ROOT, 'packages/cli/src/msglog.ts')).href;
const PEER = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

/** Every record an in-process append() was given, captured at creation, so
 * survival is judged on the WHOLE record — an earlier revision: judging by id alone let
 * a serialization that rewrote `peer` misattribute the entire inbox unseen. */
const written = new Map<string, MessageRecord>();

let seq = 0;
function rec(over: Partial<MessageRecord> = {}): MessageRecord {
  seq += 1;
  const r: MessageRecord = {
    id: `01HCRASHXXXXXXXXXXXXX${String(seq).padStart(5, '0')}`,
    dir: 'in',
    peer: PEER,
    ts: Date.now(),
    tcm: '',
    text: `text ${seq}`,
    read: false,
    ...over,
  };
  written.set(r.id, { ...r });
  return r;
}

/** What the record with this id looked like when append() was given it.
 * Child-process records never cross the pipe whole, but every field except
 * `ts` is a pure function of the id (the child scripts build them that way),
 * so misattribution is detectable across a real crash boundary too;
 * `tsKnown: false` relaxes ts to "any finite number". Unknown ids return
 * null — their PROVENANCE is each test's own assertion, property (3). */
function expectationFor(id: string): { rec: MessageRecord; tsKnown: boolean } | null {
  const tracked = written.get(id);
  if (tracked !== undefined) return { rec: tracked, tsKnown: true };
  const base = { id, dir: 'in' as const, peer: PEER, ts: 0, tcm: '', read: false };
  if (id.startsWith('01HKA')) {
    return { rec: { ...base, text: `body-of-${id}-${'x'.repeat(2048)}` }, tsKnown: false };
  }
  if (id.startsWith('01HKL')) return { rec: { ...base, text: `body-of-${id}` }, tsKnown: false };
  if (id.startsWith('01HKX')) {
    return { rec: { ...base, text: `expired-${id.slice(5)}` }, tsKnown: false };
  }
  return null;
}

/**
 * The whole-record half of property (2): the record on disk must be, field
 * for field, the record its append() was given — or, when marked redacted,
 * that record with exactly its body withheld. Both compare OUTCOMES against
 * what the caller handed over, never how msglog serializes it: any layout
 * that round-trips the same fields passes unchanged.
 */
function checkRecordIntegrity(parsed: Record<string, unknown>, ctx: string): string {
  const id = parsed['id'];
  if (typeof id !== 'string') throw new Error(`${ctx}: a record with no string id was committed`);
  const exp = expectationFor(id);
  if (exp === null) return id;
  const orig = exp.rec as unknown as Record<string, unknown>;
  if (!exp.tsKnown && (typeof parsed['ts'] !== 'number' || !Number.isFinite(parsed['ts']))) {
    throw new Error(`${ctx}: record ${id} lost its timestamp (ts=${String(parsed['ts'])})`);
  }
  if (parsed['red'] === true) {
    if (parsed['text'] !== '') {
      throw new Error(`${ctx}: record ${id} is marked redacted but still carries a body`);
    }
    // Redaction's contract (msglog.ts): the BODY goes, EVERYTHING ELSE stays.
    // So the redacted record is a total function of the record append() was
    // given, and it is compared as a WHOLE RECORD — every field required to
    // be present, equal, and nothing else beside them.
    //
    // CONSTRAINT: absence must fail as loudly as corruption. An earlier revision: this
    // branch validated only the keys that were still THERE, so a retention
    // rewrite emitting {id,dir,peer,ts,text:'',red:true} — tcm, read and
    // bytes dropped — passed a check advertised as a whole-record comparison,
    // while `inbox` showed the row unread forever, its envelope kind gone and
    // the promised size of the destroyed body unrecoverable. A missing field
    // is not a "leaner redaction"; it is the record not surviving.
    const expected: Record<string, unknown> = {
      id,
      dir: orig['dir'],
      peer: orig['peer'],
      ts: orig['ts'],
      tcm: orig['tcm'],
      text: '',
      read: true,
      bytes: Buffer.byteLength(exp.rec.text, 'utf8'),
      red: true,
    };
    for (const k of new Set([...Object.keys(parsed), ...Object.keys(expected)])) {
      // the log-hygiene rule: these messages quote `expected`, which is metadata by
      // construction (its `text` is ''), and NEVER `orig[k]` or the bytes of
      // an unrecognized field — a body that survived redaction must not be
      // reprinted by the assertion that caught it. Size and type localise the
      // defect without carrying the plaintext into a failure log.
      if (!(k in parsed)) {
        throw new Error(
          `${ctx}: redacted record ${id} lost field ${k} — redaction owes ` +
            `${JSON.stringify(expected[k])} and dropped the key instead`,
        );
      }
      // ts of a child-process record is unknown to the parent; the finite
      // check above already ran, and presence was just required.
      if (k === 'ts' && !exp.tsKnown) continue;
      if (!(k in expected)) {
        throw new Error(
          `${ctx}: redacted record ${id} grew field ${k} — ` +
            `${JSON.stringify(parsed[k]).length} bytes of ${typeof parsed[k]} that no ` +
            `append wrote; an invented field is where a body hides`,
        );
      }
      if (!Object.is(parsed[k], expected[k])) {
        throw new Error(
          `${ctx}: redacted record ${id} field ${k} is ${JSON.stringify(parsed[k])}, ` +
            `expected ${JSON.stringify(expected[k])}`,
        );
      }
    }
    return id;
  }
  // Un-redacted: exact. Every field the append was given is present and
  // equal, and no field appears that it was not given.
  for (const k of new Set([...Object.keys(parsed), ...Object.keys(orig)])) {
    if (k === 'ts' && !exp.tsKnown) continue;
    if (!Object.is(parsed[k], orig[k])) {
      throw new Error(
        `${ctx}: record ${id} did not survive intact — field ${k} is ` +
          `${JSON.stringify(parsed[k])}, its append was given ${JSON.stringify(orig[k])}`,
      );
    }
  }
  return id;
}

/** Parse every line of a spool, throwing (with context) on any torn or glued
 * line — property (1) — verify every recognized record survived INTACT —
 * property (2), whole-record half — and return the ids in file order. */
function verifyRecords(raw: string, ctx: string): string[] {
  if (raw === '') return [];
  if (!raw.endsWith('\n')) {
    throw new Error(`${ctx}: spool does not end on a record boundary`);
  }
  return raw.slice(0, -1).split('\n').map((line, i) => {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      throw new Error(
        `${ctx}: spool line ${i} does not parse — a torn or glued record was committed`,
      );
    }
    return checkRecordIntegrity(parsed, `${ctx}: spool line ${i}`);
  });
}

/** Every byte of every file under `dir` — purged plaintext hides in temp
 * litter and sidecars as easily as in the spool itself. */
function allBytesUnder(dir: string): string {
  let out = '';
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    out += statSync(p).isDirectory() ? allBytesUnder(p) : readFileSync(p, 'latin1');
  }
  return out;
}

// ---------------------------------------------------------------------------
// Instrument 1: the truncation sweep.
//
// Build a known-good spool through real appends, then for EVERY byte offset t
// simulate "the machine died with only the first t bytes durable", run one
// real append, and assert the four properties. Bodies are chosen adversarially
// so offsets land mid-escape, mid-codepoint, and inside a record-shaped decoy.
// ---------------------------------------------------------------------------

const sweepLog = new MessageLog('crash-sweep');
const sweepBodies = [
  'plain ascii',
  'brace } quote " backslash \\ in the body',
  'multi-byte: 🗝️ naïve ¥€', // a cut mid-codepoint must read as a fragment, never as half a char
  'literal\nnewline and\ttab', // stringify escapes these; no raw LF ever enters the file
  'x'.repeat(200), // long enough that most offsets land mid-text
  '{"id":"01HDECOYXXXXXXXXXXXXXXXXXX","text":"a record-shaped body"}', // must never surface as its own line
];
for (const [i, text] of sweepBodies.entries()) {
  sweepLog.append(rec({ id: `01HSWEEPXXXXXXXXXXXXX${String(i).padStart(5, '0')}`, text }));
}
const goodRaw: Buffer = readFileSync(sweepLog.path);
/** Each record's id and the offset just past its final JSON byte: a prefix of
 * length >= jsonEnd holds the WHOLE record (its LF is optional — that is the
 * earlier lesson), so the record must survive any cut at or beyond it. */
const goodLines: { id: string; jsonEnd: number }[] = [];
{
  let start = 0;
  for (let i = 0; i < goodRaw.length; i++) {
    if (goodRaw[i] === 0x0a) {
      const parsed = JSON.parse(goodRaw.subarray(start, i).toString('utf8')) as { id: string };
      goodLines.push({ id: parsed.id, jsonEnd: i });
      start = i + 1;
    }
  }
}
const knownSweepIds = new Set(goodLines.map((l) => l.id));

function sweepRange(from: number, to: number): void {
  for (let t = from; t < to; t++) {
    writeFileSync(sweepLog.path, goodRaw.subarray(0, t));
    // Property (2), before any repair runs: a record that is complete in the
    // bytes must be readable from the crashed file as-is — read() needs no
    // terminator, and a reader that refused the file here would strand every
    // record in it.
    const preIds = sweepLog.read().map((r) => r.id);
    for (const l of goodLines) {
      if (t >= l.jsonEnd && !preIds.includes(l.id)) {
        throw new Error(`cut at byte ${t}: ${l.id} is complete on disk but read() lost it`);
      }
    }
    const probe = rec({ id: `01HPRB${String(t).padStart(20, '0')}`, text: `probe after cut ${t}` });
    sweepLog.append(probe);
    const ids = verifyRecords(readFileSync(sweepLog.path, 'utf8'), `cut at byte ${t}`);
    for (const id of ids) {
      if (!knownSweepIds.has(id) && id !== probe.id) {
        throw new Error(`cut at byte ${t}: record ${id} appeared that no append ever wrote`);
      }
    }
    for (const l of goodLines) {
      if (t >= l.jsonEnd && !ids.includes(l.id)) {
        throw new Error(
          `cut at byte ${t}: ${l.id} was complete before the cut (json ends at ${l.jsonEnd}) ` +
            `and the repair or append destroyed it`,
        );
      }
    }
    if (!ids.includes(probe.id)) {
      throw new Error(
        `cut at byte ${t}: the record append() just returned for (it would now be acked, ` +
          `deleting the server's only copy) is not readable`,
      );
    }
  }
}

describe('truncation sweep: one real append after a crash at every byte offset', () => {
  // Chunked so a failure names its offset range; +1 so t === size (no damage
  // at all) runs as the control.
  const size = goodRaw.length + 1;
  const CHUNKS = 4;
  for (let c = 0; c < CHUNKS; c++) {
    const from = Math.floor((size * c) / CHUNKS);
    const to = Math.floor((size * (c + 1)) / CHUNKS);
    it(`offsets ${from}..${to - 1} of ${size - 1}`, () => sweepRange(from, to), 120_000);
  }
});

// ---------------------------------------------------------------------------
// Instrument 2: short and dying writes. writeSync's contract allows a short
// count at a quota or device boundary; the loop in msglog must absorb any
// width, and a mid-record failure must surface (the caller must not ack) and
// must not strand a fragment that eats the NEXT record.
// ---------------------------------------------------------------------------

describe('short and failing writes: append() may only return with a whole record down', () => {
  it('a device that takes at most N bytes per write still yields whole records, for every N', () => {
    const log = new MessageLog('crash-shortwrite');
    const base = rec({ text: 'y'.repeat(120) });
    log.append(base);
    for (const width of [1, 2, 3, 5, 7, 11, 17, 31, 64, 127]) {
      const probe = rec({ text: `w${width}-` + 'z'.repeat(150) });
      clamp.path = log.path;
      clamp.max = width;
      clamp.failAfter = Number.POSITIVE_INFINITY;
      clamp.written = 0;
      try {
        log.append(probe); // returning = "safe to ack"
      } finally {
        clamp.path = null;
        clamp.max = Number.POSITIVE_INFINITY;
      }
      const ids = verifyRecords(readFileSync(log.path, 'utf8'), `write width ${width}`);
      expect(ids, `width ${width}: an earlier record was destroyed`).toContain(base.id);
      expect(ids, `width ${width}: the record append() returned for is unreadable`).toContain(
        probe.id,
      );
    }
  }, 30_000);

  it('a write that dies mid-record fails the append, and no later record is harmed', () => {
    const log = new MessageLog('crash-failwrite');
    const base = rec({ text: 'k'.repeat(120) });
    log.append(base);
    for (const budget of [1, 2, 3, 5, 10, 25, 50, 100]) {
      const probe = rec({ text: 'q'.repeat(150) });
      // The budget must land inside the record, or nothing was injected.
      expect(budget).toBeLessThan(Buffer.byteLength(JSON.stringify(probe)) + 1);
      clamp.path = log.path;
      clamp.failAfter = budget;
      clamp.written = 0;
      let threw = false;
      try {
        log.append(probe);
      } catch {
        threw = true;
      } finally {
        clamp.path = null;
        clamp.failAfter = Number.POSITIVE_INFINITY;
      }
      expect(
        threw,
        `budget ${budget}: append returned despite a dead device — that return authorizes the ack`,
      ).toBe(true);
      // The failed record must not be visible as if it were whole…
      expect(log.read().map((r) => r.id), `budget ${budget}`).not.toContain(probe.id);
      // …and whatever it left behind must not damage the NEXT append.
      const rescue = rec();
      log.append(rescue);
      const ids = verifyRecords(readFileSync(log.path, 'utf8'), `budget ${budget}, after rescue`);
      expect(ids, `budget ${budget}: an earlier record was destroyed`).toContain(base.id);
      expect(ids, `budget ${budget}: the rescue append is unreadable`).toContain(rescue.id);
      expect(ids, `budget ${budget}: a half-written record surfaced as whole`).not.toContain(
        probe.id,
      );
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Property (5): a dying disk under the directory-entry walk. The OUTCOME under
// test is only "append() may not report success while the durability it
// promises is failing" — HOW an implementation achieves namespace durability
// (walk order, markers, reserved ranges) is deliberately unasserted. Residual
// coupling: the injector lands faults by path, so an implementation syncing
// directories through something other than openSync(path)+fsyncSync would
// dodge it — acceptable for fault DELIVERY, invisible to the assertions.
// ---------------------------------------------------------------------------

describe('directory durability: a failing disk fails the append; a refusing platform does not', () => {
  it('EIO opening the spool directory fails the first append — an open error is not a capability refusal', () => {
    const account = 'crash-dir-open-eio';
    const log = new MessageLog(account);
    clamp.dirPath = stateDir(account);
    clamp.dirOpenCode = 'EIO';
    try {
      expect(
        () => log.append(rec()),
        'append reported success though the entry naming the spool could not even be opened to sync',
      ).toThrow(/EIO/);
    } finally {
      clamp.dirPath = null;
      clamp.dirOpenCode = null;
    }
  });

  it('while directory durability keeps failing, NO append reports success — a first failure is not forgotten', () => {
    const account = 'crash-dir-retry';
    const log = new MessageLog(account);
    clamp.dirPath = stateDir(account);
    clamp.dirFsyncCode = 'EIO';
    try {
      expect(() => log.append(rec())).toThrow(/EIO/);
      // The spool FILE exists now; the entry NAMING it was never durable.
      // An earlier revision: an implementation keying the walk off the file's existence
      // returned right here — success reported, ack authorized, namespace
      // never durable, permanently.
      expect(
        () => log.append(rec()),
        'the disk is still failing every directory fsync, yet append reported success',
      ).toThrow(/EIO/);
    } finally {
      clamp.dirPath = null;
      clamp.dirFsyncCode = null;
    }
    // The disk recovers: the next append must succeed, and every line the
    // failed attempts left behind must still be whole and intact.
    const probe = rec();
    log.append(probe);
    const ids = verifyRecords(readFileSync(log.path, 'utf8'), `${account} after the disk recovered`);
    expect(ids).toContain(probe.id);
  });

  it('a platform that cannot fsync directories at all does not fail an append that succeeded', () => {
    const cases: [stage: 'open' | 'fsync', code: string][] = [
      ['open', 'EISDIR'],
      ['open', 'ENOTSUP'],
      ['fsync', 'EINVAL'],
      ['fsync', 'EPERM'],
    ];
    for (const [stage, code] of cases) {
      const account = `crash-dir-cap-${stage}-${code}`;
      const log = new MessageLog(account);
      const r = rec();
      clamp.dirPath = stateDir(account);
      if (stage === 'open') clamp.dirOpenCode = code;
      else clamp.dirFsyncCode = code;
      try {
        log.append(r); // a throw here fails an operation that DID succeed
      } finally {
        clamp.dirPath = null;
        clamp.dirOpenCode = null;
        clamp.dirFsyncCode = null;
      }
      const ids = verifyRecords(readFileSync(log.path, 'utf8'), `capability refusal ${stage}/${code}`);
      expect(ids, `${stage}/${code}: the record went missing`).toContain(r.id);
    }
  });
});

// ---------------------------------------------------------------------------
// Property (4) against manufactured dead-pass litter. The kill instruments
// below can strand a rewrite temp only when SIGKILL happens to land between
// its fsync and its rename; these two tests place that exact artifact —
// pid-tagged, fsynced, never renamed — deterministically, so the property
// fails fast and by name instead of only when the scheduler cooperates.
// ---------------------------------------------------------------------------

describe('stranded temp snapshots: a pass that died mid-rewrite cannot preserve purged plaintext', () => {
  it('the snapshot a dead pass left does not outlive the purge of a body it holds', () => {
    const account = 'crash-stranded-live';
    const log = new MessageLog(account);
    const a = rec({ text: `stranded-token-${'v'.repeat(64)}` });
    log.append(a);
    // The artifact: a retention pass snapshot-rewrote the spool, fsynced its
    // temp, and was SIGKILLed before the rename — under a pid that is gone.
    const stranded = join(stateDir(account), `messages.jsonl.${process.pid + 40000}.tmp`);
    writeFileSync(stranded, readFileSync(log.path), { mode: 0o600 });
    log.markRead([a.id]);
    expect(log.purge().redacted).toBe(1);
    const hay = allBytesUnder(stateDir(account));
    expect(
      hay.includes('stranded-token-'),
      'purge returned, but the dead pass’s snapshot still holds the body it reported destroyed',
    ).toBe(false);
    // Redacted, never dropped: the record itself is still an acked fact.
    expect(verifyRecords(readFileSync(log.path, 'utf8'), account)).toContain(a.id);
  });

  it('a purge with nothing left to redact still clears the litter before reporting success', () => {
    const account = 'crash-stranded-idle';
    const log = new MessageLog(account);
    const a = rec({ text: `idle-token-${'w'.repeat(64)}` });
    log.append(a);
    log.markRead([a.id]);
    expect(log.purge().redacted).toBe(1); // the body is out of the live spool
    // The dead pass's snapshot surfaces only now — it holds the body the
    // purge above already reported destroyed.
    const stranded = join(stateDir(account), `messages.jsonl.${process.pid + 40001}.tmp`);
    writeFileSync(stranded, `${JSON.stringify(a)}\n`, { mode: 0o600 });
    expect(log.purge()).toEqual({ dropped: 0, redacted: 0 });
    const hay = allBytesUnder(stateDir(account));
    expect(
      hay.includes('idle-token-'),
      'a nothing-to-do purge returned while a byte of a previously purged body was still on disk',
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Instruments 3 and 4: real SIGKILL. A child process appends (or cycles
// append/markRead/purge) against a real spool and confirms each completed
// operation over a pipe with writeSync — the bytes are in kernel space before
// the call returns, so a confirmation the parent read is one the child truly
// finished, and SIGKILL cannot unsay it. The parent kills at swept
// confirmation counts and delays, then recovers IN-PROCESS with a real append.
// ---------------------------------------------------------------------------

const APPEND_CHILD = join(home, 'child-append.ts');
writeFileSync(
  APPEND_CHILD,
  [
    `import { writeSync } from 'node:fs';`,
    `import { MessageLog } from ${JSON.stringify(MSGLOG_URL)};`,
    `const log = new MessageLog(process.argv[2] ?? 'missing');`,
    `const pad = 'x'.repeat(2048);`,
    `for (let i = 1; i <= 500; i += 1) {`,
    `  const id = '01HKA' + String(i).padStart(21, '0');`,
    `  log.append({ id, dir: 'in', peer: ${JSON.stringify(PEER)}, ts: Date.now(), tcm: '', text: 'body-of-' + id + '-' + pad, read: false });`,
    `  writeSync(1, 'A ' + id + '\\n');`,
    `}`,
  ].join('\n'),
);

const RETENTION_CHILD = join(home, 'child-retention.ts');
writeFileSync(
  RETENTION_CHILD,
  [
    `import { writeSync } from 'node:fs';`,
    `import { MessageLog, RETAIN_MS } from ${JSON.stringify(MSGLOG_URL)};`,
    `const log = new MessageLog(process.argv[2] ?? 'missing');`,
    `let prev: string | null = null;`,
    `for (let i = 1; i <= 400; i += 1) {`,
    `  const n = String(i).padStart(21, '0');`,
    // An already-expired row per cycle guarantees every purge() is a real
    // temp-write-compare-rename rewrite, so the kill can land inside one.
    `  log.append({ id: '01HKX' + n, dir: 'in', peer: ${JSON.stringify(PEER)}, ts: Date.now() - RETAIN_MS - 60_000, tcm: '', text: 'expired-' + n, read: false });`,
    `  const live = '01HKL' + n;`,
    `  log.append({ id: live, dir: 'in', peer: ${JSON.stringify(PEER)}, ts: Date.now(), tcm: '', text: 'body-of-' + live, read: false });`,
    `  writeSync(1, 'A ' + live + '\\n');`,
    `  if (prev !== null) {`,
    `    log.markRead([prev]);`,
    `    log.purge();`,
    `    writeSync(1, 'P ' + prev + '\\n');`,
    `  }`,
    `  prev = live;`,
    `}`,
  ].join('\n'),
);

interface ChildOutcome {
  /** Ids whose append() returned before the kill — ack-authorizing. */
  acked: string[];
  /** Ids whose purge() returned before the kill — "destroyed" was reported. */
  purged: string[];
}

function runAndKill(
  script: string,
  account: string,
  trigger: 'A' | 'P',
  count: number,
  extraDelayMs: number,
): Promise<ChildOutcome> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', script, account], {
      cwd: ROOT, // bare 'tsx' resolves from the repo root, as harness.canary does
      env: { ...process.env, TACENDUM_HOME: home, NODE_USE_SYSTEM_CA: '0' },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const out: ChildOutcome = { acked: [], purged: [] };
    let buf = '';
    let armed = false;
    const kill = (): void => void child.kill('SIGKILL');
    // tsx boot plus a few fsyncs is ~2s; a 30s silence means the harness
    // itself is broken, and the assertions below will say so loudly.
    const watchdog = setTimeout(kill, 30_000);
    child.stdout.on('data', (d: Buffer) => {
      buf += d.toString('utf8');
      const lines = buf.split('\n');
      buf = lines.pop() ?? ''; // a line missing its LF is NOT a confirmation
      for (const line of lines) {
        if (line.startsWith('A ')) out.acked.push(line.slice(2));
        else if (line.startsWith('P ')) out.purged.push(line.slice(2));
        const reached = trigger === 'A' ? out.acked.length : out.purged.length;
        if (!armed && reached >= count) {
          armed = true;
          if (extraDelayMs === 0) kill();
          else setTimeout(kill, extraDelayMs);
        }
      }
    });
    child.on('error', (e) => {
      clearTimeout(watchdog);
      reject(e);
    });
    child.on('exit', () => {
      clearTimeout(watchdog);
      resolve(out);
    });
  });
}

/** Recover the account the way the next CLI invocation would: one real
 * append. Returns every id in the recovered spool (parse-checked). */
function recoverAndReadIds(account: string): { ids: string[]; log: InstanceType<typeof MessageLog> } {
  const log = new MessageLog(account);
  const lockPath = join(stateDir(account), 'messages.lock');
  if (existsSync(lockPath)) {
    // A SIGKILLed holder leaves a FRESH lock, and the shared lock only takes
    // one from a dead pid once it is 30s stale — right for production,
    // budget-hostile here. Backdating keeps the REAL dead-holder recovery
    // path in play, which deleting the lock would bypass.
    //
    // Backdate the HOLDER ENTRIES, not the lock. lock.ts now keeps each lock
    // in a directory whose holders are single-use entries inside it, and
    // liveness is read from the entry — so ageing the directory ages the one
    // mtime nothing consults, the killed holder keeps blocking on youth, and
    // every recovery here refuses with "another tacendum process is using
    // this account". Silent, because a wedge and a real crash-recovery
    // failure look identical from the assertion.
    const past = (Date.now() - 3_600_000) / 1000;
    for (const entry of readdirSync(lockPath).filter((e) => /^\d{12}\.[0-9a-f]{32}$/.test(e))) {
      utimesSync(join(lockPath, entry), past, past);
    }
  }
  const probe = rec({ text: 'recovery probe' });
  log.append(probe);
  const ids = verifyRecords(readFileSync(log.path, 'utf8'), `${account} after recovery`);
  expect(ids, `${account}: the post-crash probe append is unreadable`).toContain(probe.id);
  return { ids, log };
}

describe('SIGKILL mid-append: every confirmed append survives the crash', () => {
  const kills: [count: number, delayMs: number][] = [
    [1, 0], [1, 6], [2, 0], [3, 3], [5, 0], [7, 6],
  ];
  for (const [count, delay] of kills) {
    it(`killed after ${count} confirmations + ${delay}ms`, async () => {
      const account = `crash-kill-${count}-${delay}`;
      const out = await runAndKill(APPEND_CHILD, account, 'A', count, delay);
      expect(
        out.acked.length,
        'the child never confirmed an append — this run exercised nothing',
      ).toBeGreaterThanOrEqual(count);
      const { ids } = recoverAndReadIds(account);
      for (const id of out.acked) {
        expect(ids, `append of ${id} returned (ack-authorizing) yet the record is gone`).toContain(id);
      }
      for (const id of ids) {
        expect(
          id.startsWith('01HKA') || id.startsWith('01HCRASH'),
          `record ${id} appeared that no append ever wrote`,
        ).toBe(true);
      }
    }, 60_000);
  }
});

describe('SIGKILL mid-purge: rewrites lose nothing appended, resurrect nothing purged', () => {
  const kills: [count: number, delayMs: number][] = [[1, 0], [1, 10], [2, 0], [3, 25]];
  for (const [count, delay] of kills) {
    it(`killed after ${count} purge cycles + ${delay}ms`, async () => {
      const account = `crash-ret-${count}-${delay}`;
      const out = await runAndKill(RETENTION_CHILD, account, 'P', count, delay);
      expect(
        out.purged.length,
        'the child never confirmed a purge — this run exercised nothing',
      ).toBeGreaterThanOrEqual(count);
      const { ids, log } = recoverAndReadIds(account);
      // (2): records appended-and-fsynced before the pass survive a pass that
      // died anywhere inside its snapshot/temp/rename sequence. (Expired rows
      // — 01HKX — are dropped by POLICY; their absence is not loss.)
      for (const id of out.acked) {
        expect(ids, `live record ${id} was confirmed before the kill and is gone`).toContain(id);
      }
      // (4): a purge that RETURNED left no byte of the body anywhere under
      // the account — spool, sidecar, or the temp litter the kill stranded.
      const hay = allBytesUnder(stateDir(account));
      for (const id of out.purged) {
        expect(hay.includes(`body-of-${id}`), `purged body of ${id} is still on disk`).toBe(false);
        expect(ids, `purge must redact ${id} to metadata, never drop the record`).toContain(id);
      }
      for (const id of ids) {
        expect(
          id.startsWith('01HKL') || id.startsWith('01HKX') || id.startsWith('01HCRASH'),
          `record ${id} appeared that no append ever wrote`,
        ).toBe(true);
      }
      // Retention is recoverable: the next pass runs clean on the crashed
      // spool and still loses nothing that was confirmed.
      log.applyRetention();
      const finalIds = verifyRecords(readFileSync(log.path, 'utf8'), `${account} after rerun`);
      for (const id of out.acked) expect(finalIds).toContain(id);
      // An earlier revision, closing property (4) for real: the kill may have stranded a
      // rewrite temp between its fsync and its rename — a full pre-rewrite
      // snapshot no later pass listed. Consume everything and purge, the way
      // an operator would; after THAT purge returns, no live body may
      // survive anywhere under the account, stranded snapshots included.
      log.markRead(finalIds.filter((id) => id.startsWith('01HKL')));
      log.purge();
      const cleaned = allBytesUnder(stateDir(account));
      expect(
        cleaned.includes('body-of-01HKL'),
        'a consumed, purged body survived — in a stranded temp snapshot or an unredacted line',
      ).toBe(false);
    }, 60_000);
  }
});

// ---------------------------------------------------------------------------
// Property (4) in its deterministic, no-crash form: what purge() reports
// destroyed is not readable ANYWHERE under the account the moment it returns.
// ---------------------------------------------------------------------------

describe('purge leaves no plaintext byte behind (the assertable half of durability)', () => {
  it('after purge() returns, the bodies are gone from every file under the account', () => {
    const log = new MessageLog('crash-purge-scan');
    const recs = [0, 1, 2].map((i) => rec({ text: `body-token-${i}-${'s'.repeat(64)}` }));
    for (const r of recs) log.append(r);
    log.markRead(recs.map((r) => r.id));
    expect(log.purge().redacted).toBe(3);
    const hay = allBytesUnder(stateDir('crash-purge-scan'));
    // The redacted records must still be the records they were — identity
    // intact, body withheld — which verifyRecords checks field by field.
    const ids = verifyRecords(readFileSync(log.path, 'utf8'), 'crash-purge-scan after purge');
    for (const [i, r] of recs.entries()) {
      expect(hay.includes(`body-token-${i}-`), `purged body ${i} is still on disk`).toBe(false);
      // Redacted, never dropped: the record itself is an acked fact.
      expect(ids).toContain(r.id);
    }
  });

  it('sweeps a QUARANTINE temp a dead pass stranded, not only its own', () => {
    // The half that scoping the spool sweep left open (an earlier review). An earlier revision
    // swept `\.\d+\.tmp$` across the whole state directory, which deleted
    // LIVE `undelivered.jsonl.<pid>.tmp` files out from under inbound.ts and
    // lost real mail. Narrowing that sweep to the files `messages.lock`
    // governs was right and stopped there: a quarantine temp STRANDED by a
    // dead pass still holds a plaintext body, and nothing removed it, so
    // `inbox --purge` reported success over plaintext still on disk.
    const account = 'crash-purge-quarantine';
    const log = new MessageLog(account);
    log.append(rec({ text: 'a live body that must survive' }));
    const body = `QUARANTINE-BODY-${'q'.repeat(64)}`;
    // pid 999999 exceeds macOS pid_max, so this temp is unambiguously the
    // work of a process that died between its fsync and its rename.
    const stranded = join(stateDir(account), 'undelivered.jsonl.999999.tmp');
    writeFileSync(stranded, `${JSON.stringify(rec({ text: body }))}\n`, { mode: 0o600 });

    log.purge();

    expect(existsSync(stranded), 'the stranded quarantine temp outlived purge').toBe(false);
    expect(
      allBytesUnder(stateDir(account)).includes(body),
      'purge returned over a plaintext body still readable under the account',
    ).toBe(false);
  });
});
