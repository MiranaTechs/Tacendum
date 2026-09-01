import { describe, expect, it, vi } from 'vitest';

/**
 * An earlier review, M1 — `append()` must not report failure once the body is on
 * disk.
 *
 * The contract, in one line: `append` returning is what authorizes the ack
 * that deletes the server's only copy, and a THROW is the only way it can say
 * "the record is not on disk". inbound.ts believes that literally — it
 * answers an append throw by writing the SAME plaintext to
 * `undelivered.jsonl`, which `inbox --purge` never redacts (retention rewrites
 * `messages.jsonl` and nothing else) and which the operator is told to recover
 * with `cat undelivered.jsonl >> messages.jsonl` — yielding the message twice
 * under one id, since `loadAll` deduplicates nothing. So a throw raised AFTER
 * the fsync costs a permanent second plaintext copy and buys nothing: the
 * record it claims failed is already durable.
 *
 * An earlier revision put the ancestor-directory walk after the record's fsync and hit
 * exactly that. An earlier revision moved the walk ahead of the write and its
 * comment declared the window closed — "so nothing that can throw runs after
 * the record's fsync" — while the same commit's message still listed the
 * finding as open. The comment was false: the locked section returns into
 * `withFileLock`, whose `finally` releases the lock, and that unlink can fail
 * (EACCES, EIO, EPERM) like any other syscall.
 *
 * These tests therefore do NOT enumerate the callees. `node:fs` is wrapped
 * pass-through so the suite can arm a trap the instant the record's own fsync
 * returns and fail EVERY filesystem call after it, whatever it is and
 * whoever makes it. Real work still reaches the real disk: the trap performs
 * the operation and then reports failure, which is both what a post-hoc EIO
 * looks like and what keeps the temp home usable for the assertions.
 */

const ctl = vi.hoisted(() => ({
  fdPaths: new Map<number, string>(),
  /** Arm the after-fsync trap when this path's fd is fsynced. */
  armOnFsyncOf: null as string | null,
  armed: false,
  /** How many calls the armed trap failed — a zero here means a vacuous pass. */
  fired: 0,
  /** Fail `openSync` of a directory (the walk's O_DIRECTORY open), as EMFILE does. */
  failDirOpen: false,
  /** Fail `writeSync` on this path once, as ENOSPC does mid-record. */
  failWriteOn: null as string | null,
  /** Fail `fsyncSync` on this path, as EIO does when the record never lands. */
  failFsyncOn: null as string | null,
  /** Fail `closeSync` of this path — the ONE call in the `finally`, isolated
   *  from the lock release so the local guard and the latch can be told
   *  apart. */
  failCloseOn: null as string | null,
}));

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  const errno = (code: string, what: string): NodeJS.ErrnoException => {
    const err = new Error(`injected ${code} at ${what}`) as NodeJS.ErrnoException;
    err.code = code;
    return err;
  };
  /** The armed trap: the call already happened, and it still reports failure. */
  const afterFsync = (what: string): void => {
    if (!ctl.armed) return;
    ctl.fired += 1;
    throw errno('EIO', what);
  };
  const openSync: typeof real.openSync = (path, flags, mode) => {
    if (ctl.failDirOpen && typeof flags === 'number' && (flags & real.constants.O_DIRECTORY) !== 0) {
      // EMFILE opens nothing, so this one throws INSTEAD of doing the work.
      throw errno('EMFILE', `openSync(${String(path)})`);
    }
    if (ctl.armed) {
      ctl.fired += 1;
      throw errno('EMFILE', `openSync(${String(path)})`);
    }
    const fd = real.openSync(path, flags, mode);
    ctl.fdPaths.set(fd, String(path));
    return fd;
  };
  const fsyncSync: typeof real.fsyncSync = (fd) => {
    const path = ctl.fdPaths.get(fd) ?? '';
    if (ctl.failFsyncOn !== null && path === ctl.failFsyncOn) throw errno('EIO', 'fsyncSync');
    real.fsyncSync(fd);
    if (ctl.armOnFsyncOf !== null && path === ctl.armOnFsyncOf) ctl.armed = true;
    else afterFsync('fsyncSync');
  };
  const writeSync = ((fd: number, ...rest: unknown[]) => {
    const path = ctl.fdPaths.get(fd) ?? '';
    if (ctl.failWriteOn !== null && path === ctl.failWriteOn) {
      ctl.failWriteOn = null;
      throw errno('ENOSPC', 'writeSync');
    }
    const n = (real.writeSync as (...a: unknown[]) => number)(fd, ...rest);
    afterFsync('writeSync');
    return n;
  }) as typeof real.writeSync;
  const closeSync: typeof real.closeSync = (fd) => {
    const path = ctl.fdPaths.get(fd) ?? '';
    real.closeSync(fd);
    ctl.fdPaths.delete(fd);
    if (ctl.failCloseOn !== null && path === ctl.failCloseOn) throw errno('EIO', 'closeSync');
    afterFsync('closeSync');
  };
  const rmSync: typeof real.rmSync = (path, opts) => {
    real.rmSync(path, opts);
    afterFsync(`rmSync(${String(path)})`);
  };
  const unlinkSync: typeof real.unlinkSync = (path) => {
    real.unlinkSync(path);
    afterFsync(`unlinkSync(${String(path)})`);
  };
  const renameSync: typeof real.renameSync = (from, to) => {
    real.renameSync(from, to);
    afterFsync(`renameSync(${String(to)})`);
  };
  const linkSync: typeof real.linkSync = (from, to) => {
    real.linkSync(from, to);
    afterFsync(`linkSync(${String(to)})`);
  };
  const ftruncateSync: typeof real.ftruncateSync = (fd, len) => {
    real.ftruncateSync(fd, len);
    afterFsync('ftruncateSync');
  };
  return {
    ...real,
    openSync,
    fsyncSync,
    writeSync,
    closeSync,
    rmSync,
    unlinkSync,
    renameSync,
    linkSync,
    ftruncateSync,
  };
});

import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'tacendum-m1-'));
process.env.TACENDUM_HOME = home;

const { MessageLog } = await import('../src/msglog.js');
type MessageRecord = import('../src/msglog.js').MessageRecord;

const PEER = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
let seq = 0;
function rec(over: Partial<MessageRecord> = {}): MessageRecord {
  seq += 1;
  return {
    id: `01HM1XXXXXXXXXXXXXXXXX${String(seq).padStart(4, '0')}`,
    dir: 'in',
    peer: PEER,
    ts: Date.now(),
    tcm: '',
    text: `body ${seq}`,
    read: false,
    ...over,
  };
}

function reset(): void {
  ctl.armOnFsyncOf = null;
  ctl.armed = false;
  ctl.fired = 0;
  ctl.failDirOpen = false;
  ctl.failWriteOn = null;
  ctl.failFsyncOn = null;
  ctl.failCloseOn = null;
}

/** Lines actually in the spool — the duplicate the quarantine path creates is
 * a SECOND copy of one body, so counting matters, not just presence. */
function spoolLines(path: string): string[] {
  return readFileSync(path, 'utf8').split('\n').filter(Boolean);
}

/**
 * How many times `body` appears across EVERY file in the account directory.
 *
 * The defect is a second copy of one plaintext ANYWHERE under the account —
 * `undelivered.jsonl` is where inbound.ts puts it, but a stranded
 * `messages.jsonl.<pid>.tmp` would be one too. Counting the directory rather
 * than the spool is the assertion that matches the harm; counting only
 * `messages.jsonl` would pass while the duplicate sat beside it.
 */
function copiesUnderAccount(dir: string, body: string): number {
  let n = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const text = readFileSync(join(dir, entry.name), 'utf8');
    n += text.split(body).length - 1;
  }
  return n;
}

describe('M1: a failure after the record is durable is not reported as a failed append', () => {
  it('every filesystem call after the record fsyncs may fail, and append still returns', () => {
    const log = new MessageLog('m1-after-fsync');
    // Warm the spool so the run under test is an ordinary append: the trap
    // below fails the whole tail of the call, and the first append's
    // ancestor walk is the one thing that legitimately belongs BEFORE the
    // record (see the next test), so it must not be in the trap's way.
    log.append(rec());
    const r = rec({ text: 'the body that must not be quarantined twice' });
    reset();
    ctl.armOnFsyncOf = log.path;
    try {
      // The whole claim: not "closeSync is caught" and not "the release is
      // caught", but that NOTHING failing here reaches the caller. Anything
      // a later change adds after the fsync is covered by the same trap.
      expect(() => log.append(r)).not.toThrow();
    } finally {
      ctl.armed = false;
    }
    // A trap that never fired would make the assertion above vacuous — that
    // is the way this test rots. If a future change genuinely leaves no
    // syscall after the fsync, this line is the one to re-derive, not to
    // delete.
    expect(ctl.fired).toBeGreaterThan(0);
    reset();
    const ids = log.read().map((x) => x.id);
    expect(ids.filter((id) => id === r.id)).toHaveLength(1);
    expect(spoolLines(log.path)).toHaveLength(2);
    // The harm, asserted directly: ONE copy of this body under the whole
    // account, not one line in the spool with another in the quarantine.
    expect(copiesUnderAccount(dirname(log.path), r.text)).toBe(1);
  });

  it('a close that fails BEFORE the record is durable does not replace the error that refused the ack', () => {
    // Isolates the `finally`'s own try/catch from the latch, which the
    // all-calls trap above cannot: there, both the guard and the latch would
    // have to be removed to see a failure. Here the record is NOT durable —
    // the write failed — so the latch rethrows, and what it rethrows must be
    // the ENOSPC that actually refused the ack. An unguarded `closeSync` in
    // that `finally` throws EIO out of the finally instead, replacing the
    // in-flight exception: inbound.ts then prints "message log write failed
    // (EIO)" for a full disk, and the operator repairs the wrong thing.
    const log = new MessageLog('m1-close-fails-early');
    log.append(rec());
    const before = spoolLines(log.path).length;
    reset();
    ctl.failWriteOn = log.path;
    ctl.failCloseOn = log.path;
    try {
      expect(() => log.append(rec({ text: 'never lands either' }))).toThrow(/ENOSPC/);
    } finally {
      reset();
    }
    expect(spoolLines(log.path)).toHaveLength(before);
  });

  it('a close that fails AFTER the record is durable is not reported at all', () => {
    // The same syscall on the other side of the fsync, and the opposite
    // answer: the body is on disk, so the caller is entitled to ack and a
    // failed `close` must not take that away. ONLY `closeSync` fails here —
    // the lock release still succeeds, so the account is not wedged and the
    // next append is an ordinary one.
    //
    // Deliberately NOT discriminating, and recorded as such so nobody reads
    // it as pinning one mechanism: the finally's own catch and the latch each
    // satisfy it alone (measured — with `if (!durable) throw err` sabotaged to
    // a bare `throw err`, this test still passed). It states the outcome the
    // method owes; the two tests that isolate the halves are the all-calls
    // trap above (latch) and the close-before-durable case (finally's catch).
    const log = new MessageLog('m1-close-fails-late');
    log.append(rec());
    const r = rec({ text: 'durable before the close failed' });
    reset();
    ctl.failCloseOn = log.path;
    try {
      expect(() => log.append(r)).not.toThrow();
    } finally {
      reset();
    }
    expect(copiesUnderAccount(dirname(log.path), r.text)).toBe(1);
    expect(log.read().map((x) => x.id)).toContain(r.id);
    // The lock was released normally, so the account still works.
    expect(() => log.append(rec())).not.toThrow();
  });

  it('the ancestor walk failing DOES refuse the ack, and leaves no plaintext behind', () => {
    // The other half. The walk is the failure an earlier revision shipped after the
    // fsync; the fix is that it now runs before any body is written, where
    // throwing is honest — the caller has nothing durable, so quarantining
    // the body is preservation rather than duplication. If the durability
    // latch were set any earlier than the record's own fsync, this append
    // would report success over an EMPTY spool and the message would be
    // acked away and lost.
    const log = new MessageLog('m1-walk-fails');
    reset();
    ctl.failDirOpen = true;
    try {
      expect(() => log.append(rec())).toThrow(/EMFILE/);
    } finally {
      reset();
    }
    expect(statSync(log.path).size).toBe(0);
    expect(log.read()).toHaveLength(0);
  });

  it('a write that fails mid-record refuses the ack and rolls the record back', () => {
    const log = new MessageLog('m1-write-fails');
    log.append(rec());
    const before = spoolLines(log.path).length;
    reset();
    ctl.failWriteOn = log.path;
    try {
      expect(() => log.append(rec({ text: 'never lands' }))).toThrow(/ENOSPC/);
    } finally {
      reset();
    }
    expect(spoolLines(log.path)).toHaveLength(before);
  });

  it("the record's own fsync failing refuses the ack", () => {
    // The tightest placement check there is: bytes written, fsync refused.
    // A latch set between the write and the fsync would swallow this and
    // authorize an ack for a record that a power cut can still discard,
    // which is the entire reason this method fsyncs at all.
    const log = new MessageLog('m1-fsync-fails');
    log.append(rec());
    reset();
    ctl.failFsyncOn = log.path;
    const victim = rec({ text: 'written but not durable' });
    try {
      expect(() => log.append(victim)).toThrow(/EIO/);
    } finally {
      reset();
    }

    // AND THE BYTES ARE GONE. Asserting only the throw is what let this
    // through: the rollback wrapped `writeAllSync` alone, so an fsync that
    // failed AFTER a complete write left the whole record readable in the
    // spool while append() reported failure — and inbound.ts answers a failed
    // append by quarantining the same body to undelivered.jsonl, which
    // retention never redacts. "The caller was told no" and "nothing is on
    // disk" have to be checked as one fact, or they come apart (an earlier review).
    expect(
      spoolLines(log.path),
      'the refused record is still in the spool — a second copy will be quarantined',
    ).toHaveLength(1);
    expect(log.read().map(r => r.id)).not.toContain(victim.id);
    expect(
      copiesUnderAccount(dirname(log.path), victim.text),
      'the body a failed append refused is readable somewhere under the account',
    ).toBe(0);
  });
});
