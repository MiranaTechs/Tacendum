import { describe, expect, it, vi } from 'vitest';

/**
 * three external-review blockers against the plaintext spool.
 *
 * The contract under test is the ack contract: `append` returning is what
 * authorizes deleting the server's only copy, so every defect here is a way
 * for an ACKNOWLEDGED message (or a purge that reported success) to be
 * silently undone by a crash, a lock takeover, or a power cut.
 *
 * The directory-fsync tests need to SEE fsync calls, which no filesystem
 * observation can do in-process, so `node:fs` is wrapped pass-through with a
 * recorder. Everything still hits the real disk; the wrapper only remembers
 * which fds were opened on which paths and when fsync/rename happened.
 */

const trace = vi.hoisted(() => ({
  on: false,
  ops: [] as { op: 'open' | 'rename' | 'fsync'; path: string; fd?: number }[],
  fdPaths: new Map<number, string>(),
}));

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  const openSync: typeof real.openSync = (path, flags, mode) => {
    const fd = real.openSync(path, flags, mode);
    if (trace.on) {
      trace.fdPaths.set(fd, String(path));
      trace.ops.push({ op: 'open', path: String(path), fd });
    }
    return fd;
  };
  const renameSync: typeof real.renameSync = (oldPath, newPath) => {
    real.renameSync(oldPath, newPath);
    if (trace.on) trace.ops.push({ op: 'rename', path: String(newPath) });
  };
  const fsyncSync: typeof real.fsyncSync = (fd) => {
    real.fsyncSync(fd);
    if (trace.on) trace.ops.push({ op: 'fsync', fd, path: trace.fdPaths.get(fd) ?? '' });
  };
  return { ...real, openSync, renameSync, fsyncSync };
});

import { randomBytes } from 'node:crypto';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'tacendum-gate-msglog-'));
process.env.TACENDUM_HOME = home;

const { MessageLog, RETAIN_MS } = await import('../src/msglog.js');
const { stateDir } = await import('../src/config.js');
const { CliError } = await import('../src/exit.js');
type MessageRecord = import('../src/msglog.js').MessageRecord;

const PEER = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
let seq = 0;
function rec(over: Partial<MessageRecord> = {}): MessageRecord {
  seq += 1;
  return {
    id: `01HGATEXXXXXXXXXXXXXX${String(seq).padStart(5, '0')}`,
    dir: 'in',
    peer: PEER,
    ts: Date.now(),
    tcm: '',
    text: `text ${seq}`,
    read: false,
    ...over,
  };
}

/**
 * `messages.lock` is a DIRECTORY, and a holder is a single-use entry inside it named
 * `<12-digit seq>.<32-hex nonce>` holding the same `pid:incarnation:hex` token
 * the old lock FILE held. So another process's claim is planted as an ENTRY,
 * and "the lock is held" is "a holder entry is present" — never
 * `existsSync(lockPath)`, which is true forever once the spool has been
 * written to once and so distinguishes nothing.
 *
 * The shape is duplicated here rather than imported: a test that reads the
 * rule off the code under test cannot catch the code changing the rule.
 */
const ENTRY_RE = /^\d{12}\.[0-9a-f]{32}$/;

/** The lock's holder entries, in queue order. */
function holderEntries(lockPath: string): string[] {
  try {
    return readdirSync(lockPath)
      .filter((name) => ENTRY_RE.test(name))
      .sort();
  } catch {
    return []; // no directory: nobody holds it
  }
}

/**
 * Put a holder in the queue by hand — the stand-in for the other process.
 * `ageMs` backdates the entry's mtime, which is how the implementation
 * separates a holder it merely cannot inspect from an abandoned one. Returns
 * the entry's name.
 */
function plantEntry(lockPath: string, opts: { token: string; ageMs?: number }): string {
  mkdirSync(lockPath, { recursive: true, mode: 0o700 });
  const name = `000000000001.${randomBytes(16).toString('hex')}`;
  writeFileSync(join(lockPath, name), opts.token, { mode: 0o600 });
  if (opts.ageMs !== undefined) {
    const then = (Date.now() - opts.ageMs) / 1000;
    utimesSync(join(lockPath, name), then, then);
  }
  return name;
}

/** Comfortably past LOCK_STALE_MS, which is 30 seconds. */
const HOUR_MS = 3_600_000;

describe('a crash-truncated tail is repaired BEFORE the next append', () => {
  it('the appended (and therefore acked) record survives a fragment at EOF', () => {
    const log = new MessageLog('gate-tail');
    const first = rec();
    log.append(first);
    // The crash: a process died after some bytes of a record, before its
    // newline. Readers skip this fragment — but an append glued onto it
    // would produce ONE unparseable line containing a record the caller
    // acked the server for on the strength of append() returning.
    appendFileSync(log.path, '{"id":"01HCRASHED","dir":"in"', { mode: 0o600 });
    const second = rec();
    log.append(second);
    const ids = log.read().map((r) => r.id);
    expect(ids).toContain(second.id); // the acked record is readable…
    expect(ids).toContain(first.id); // …and repair ate no complete record
    // The fragment is off the disk, not merely skipped.
    expect(readFileSync(log.path, 'utf8')).not.toContain('01HCRASHED');
  });

  it('repairs a fragment longer than one backward-scan chunk', () => {
    const log = new MessageLog('gate-tail-long');
    const first = rec();
    log.append(first);
    appendFileSync(log.path, `{"id":"01HLONG","text":"${'x'.repeat(20_000)}`, { mode: 0o600 });
    const second = rec();
    log.append(second);
    expect(log.read().map((r) => r.id)).toEqual([second.id, first.id]);
  });

  it('a spool that is ALL fragment truncates to empty, then appends cleanly', () => {
    const log = new MessageLog('gate-tail-only');
    log.append(rec());
    // The whole file is one unterminated line — the crash happened during
    // the very first append. There is no complete record to preserve.
    writeFileSync(log.path, '{"id":"01HFRAG');
    const only = rec();
    log.append(only);
    expect(log.read().map((r) => r.id)).toEqual([only.id]);
    expect(readFileSync(log.path, 'utf8')).not.toContain('01HFRAG');
  });
});

describe('the spool lock cannot be taken from a live holder', () => {
  it('waits out (then refuses) a stale-LOOKING lock whose owner is alive', () => {
    // The old private lock rm'd anything with a >10s mtime — so a retention
    // pass suspended mid-snapshot lost its lock, a listener appended and
    // ACKED, and the resumed pass renamed its stale snapshot over the acked
    // record. The shared lock asks the pid, and our own pid is the most
    // certainly-alive one there is: this append must refuse, not proceed.
    const log = new MessageLog('gate-lock-live');
    log.append(rec());
    const lockPath = join(stateDir('gate-lock-live'), 'messages.lock');
    // The other process's claim: a holder entry bearing OUR pid, backdated an
    // hour so nothing but the liveness probe can save it. Under the legacy
    // two-part `pid:hex` token, pid existence IS the liveness answer.
    const alive = plantEntry(lockPath, { token: `${process.pid}:feedface`, ageMs: HOUR_MS });
    let err: unknown;
    try {
      log.append(rec());
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).message).toContain(lockPath);
    // Not merely refused — LEFT ALONE. This is the assertion that separates
    // "waited out and gave up" from "stole the lock and then happened to
    // throw": the live claim is still the only holder, and the refuser took
    // its own queued ticket back out on the way through.
    expect(holderEntries(lockPath)).toEqual([alive]);
    rmSync(join(lockPath, alive), { force: true });
  }, 30_000);

  it('still recovers a DEAD holder\'s lock without operator help', () => {
    const log = new MessageLog('gate-lock-dead');
    log.append(rec());
    const lockPath = join(stateDir('gate-lock-dead'), 'messages.lock');
    // What a SIGKILL leaves: a holder entry naming a pid nothing wears, aged
    // past the stale window, with no one alive to release it.
    plantEntry(lockPath, { token: '999999:gone', ageMs: HOUR_MS });
    const r = rec();
    log.append(r); // a SIGKILL must cost a wait, never a wedge
    expect(log.read().map((x) => x.id)).toContain(r.id);
    // The corpse was COLLECTED, not merely stepped over — safe precisely
    // because the name is single-use and can never come back as a live claim
    // — and the appender released its own. Nobody holds the lock now.
    // (`existsSync(lockPath)` cannot say this: the directory is the waiting
    // room and outlives every holder by design.)
    expect(holderEntries(lockPath)).toEqual([]);
  });

  it('abandons a retention rewrite whose snapshot the file has outrun', () => {
    const log = new MessageLog('gate-snapshot');
    // Old enough to guarantee a drop, hence a rewrite.
    log.append(rec({ ts: Date.now() - RETAIN_MS - 1000 }));
    const acked = rec();
    // The takeover, replayed deterministically: between retention's snapshot
    // read and its rename, another process (holding a lock an operator freed
    // by hand) appends a record and ACKS it to the server.
    const original = log['readPrivateWithStat'].bind(log);
    let taken = false;
    log['readPrivateWithStat'] = (p: string) => {
      const snap = original(p);
      if (p === log.path && !taken) {
        taken = true;
        appendFileSync(log.path, `${JSON.stringify(acked)}\n`);
      }
      return snap;
    };
    expect(() => log.applyRetention()).toThrow(/changed while retention held its snapshot/);
    // The acked record is still in the spool: the stale snapshot did not win.
    expect(log.read().map((r) => r.id)).toContain(acked.id);
  });
});

describe('directory entries are fsynced, not merely renamed', () => {
  it('purge fsyncs the spool directory AFTER renaming the rewrite in', () => {
    // The temp file was fsynced and renamed, but the rename lives in the
    // DIRECTORY, and an unsynced directory can come back from power loss
    // still pointing at the old file — plaintext the purge reported
    // destroyed, resurrected.
    const log = new MessageLog('gate-dirsync');
    const r1 = rec({ text: 'burn after reading' });
    log.append(r1);
    log.markRead([r1.id]);
    trace.ops.length = 0;
    trace.fdPaths.clear();
    trace.on = true;
    try {
      expect(log.purge().redacted).toBe(1);
    } finally {
      trace.on = false;
    }
    const root = stateDir('gate-dirsync');
    const renameIdx = trace.ops.findIndex((o) => o.op === 'rename' && o.path === log.path);
    expect(renameIdx).toBeGreaterThanOrEqual(0);
    const dirSyncedAfter = trace.ops
      .slice(renameIdx + 1)
      .some((o) => o.op === 'fsync' && o.path === root);
    expect(dirSyncedAfter).toBe(true);
  });

  it('the first append fsyncs the directory that names the new spool file', () => {
    // "Durable before ack" includes the file EXISTING after power loss, not
    // just its bytes: a first append whose directory entry evaporates is an
    // acked message in an unreachable inode.
    const log = new MessageLog('gate-dirsync-create');
    trace.ops.length = 0;
    trace.fdPaths.clear();
    trace.on = true;
    try {
      log.append(rec());
    } finally {
      trace.on = false;
    }
    const root = stateDir('gate-dirsync-create');
    expect(trace.ops.some((o) => o.op === 'fsync' && o.path === root)).toBe(true);
  });
});
