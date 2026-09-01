import { describe, expect, it, vi } from 'vitest';

/**
 * four release-blockers in an earlier revision's own msglog fixes.
 *
 * Same contract as gate.msglog.test.ts: `append` returning authorizes the
 * ack that deletes the server's only copy, so every defect here is a way for
 * acknowledged plaintext (or a purge that reported success) to be silently
 * destroyed or silently not-durable.
 *
 * `node:fs` is wrapped pass-through, as in gate.msglog.test.ts, for three
 * powers no in-process filesystem observation provides: seeing WHICH
 * directories get fsynced, injecting an fsync failure with a chosen errno,
 * and running an interloper at the exact moment retention opens its temp
 * file (the check-to-use gap, replayed deterministically).
 */

const ctl = vi.hoisted(() => ({
  on: false,
  ops: [] as { op: 'open' | 'fsync'; path: string; fd?: number }[],
  fdPaths: new Map<number, string>(),
  /** Throw from fsyncSync (with failCode) when the fd was opened on this path. */
  failPath: null as string | null,
  failCode: 'EIO',
  /** Fired before every openSync; the hook self-disarms. */
  onOpen: null as ((path: string) => void) | null,
}));

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  const openSync: typeof real.openSync = (path, flags, mode) => {
    ctl.onOpen?.(String(path));
    const fd = real.openSync(path, flags, mode);
    ctl.fdPaths.set(fd, String(path));
    if (ctl.on) ctl.ops.push({ op: 'open', path: String(path), fd });
    return fd;
  };
  const fsyncSync: typeof real.fsyncSync = (fd) => {
    const path = ctl.fdPaths.get(fd) ?? '';
    if (ctl.failPath !== null && path === ctl.failPath) {
      const err = new Error(`injected fsync failure (${ctl.failCode})`) as NodeJS.ErrnoException;
      err.code = ctl.failCode;
      throw err;
    }
    real.fsyncSync(fd);
    if (ctl.on) ctl.ops.push({ op: 'fsync', path, fd });
  };
  return { ...real, openSync, fsyncSync };
});

import {
  appendFileSync,
  existsSync,
  readFileSync,
  statSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'tacendum-gate-msglog2-'));
process.env.TACENDUM_HOME = home;

const { MessageLog, RETAIN_MS } = await import('../src/msglog.js');
const { stateDir } = await import('../src/config.js');
type MessageRecord = import('../src/msglog.js').MessageRecord;

const PEER = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
let seq = 0;
function rec(over: Partial<MessageRecord> = {}): MessageRecord {
  seq += 1;
  return {
    id: `01HGATE2XXXXXXXXXXXXX${String(seq).padStart(5, '0')}`,
    dir: 'in',
    peer: PEER,
    ts: Date.now(),
    tcm: '',
    text: `text ${seq}`,
    read: false,
    ...over,
  };
}

describe('a complete record missing only its newline is NOT a fragment', () => {
  it('survives the next append, which completes it instead of truncating it', () => {
    // The crash: a short write put down every JSON byte but died before the
    // LF. After restart the record still READS (split needs no terminator),
    // so the server's redelivery gets deduped and ACKed — these bytes are
    // the only plaintext copy. An earlier revision's repair keyed on the newline alone
    // and deleted exactly this record on the next append.
    const log = new MessageLog('gate2-tail-complete');
    const first = rec();
    const victim = rec();
    log.append(first);
    log.append(victim);
    truncateSync(log.path, statSync(log.path).size - 1); // exactly the LF
    const next = rec();
    log.append(next);
    expect(log.read().map((r) => r.id)).toEqual([next.id, victim.id, first.id]);
    // The repair finished the line it kept: three whole records, terminated.
    const raw = readFileSync(log.path, 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(raw.split('\n').filter(Boolean).length).toBe(3);
  });

  it('a complete-but-unterminated record that is the WHOLE file also survives', () => {
    // Same crash on the very first append: keep === 0, so a newline-based
    // repair truncated the entire file.
    const log = new MessageLog('gate2-tail-whole');
    log.append(rec());
    const victim = rec();
    writeFileSync(log.path, JSON.stringify(victim)); // no LF anywhere
    const next = rec();
    log.append(next);
    expect(log.read().map((r) => r.id)).toEqual([next.id, victim.id]);
  });

  it('a tail that does not parse is still truncated — repair got smarter, not laxer', () => {
    const log = new MessageLog('gate2-tail-torn');
    const first = rec();
    log.append(first);
    appendFileSync(log.path, '{"id":"01HTORN","text":"cut mid-str', { mode: 0o600 });
    const next = rec();
    log.append(next);
    expect(log.read().map((r) => r.id)).toEqual([next.id, first.id]);
    expect(readFileSync(log.path, 'utf8')).not.toContain('01HTORN');
  });
});

describe('a REAL directory-fsync failure fails the operation', () => {
  it('append throws on EIO syncing the spool directory — the caller must not ack', () => {
    const log = new MessageLog('gate2-dir-eio');
    ctl.failPath = stateDir('gate2-dir-eio');
    ctl.failCode = 'EIO';
    try {
      expect(() => log.append(rec())).toThrow(/injected fsync failure/);
    } finally {
      ctl.failPath = null;
    }
  });

  it('append still succeeds on EINVAL — "cannot sync a directory here" is not a failure', () => {
    const log = new MessageLog('gate2-dir-einval');
    ctl.failPath = stateDir('gate2-dir-einval');
    ctl.failCode = 'EINVAL';
    try {
      const r = rec();
      log.append(r);
      expect(log.read().map((x) => x.id)).toEqual([r.id]);
    } finally {
      ctl.failPath = null;
    }
  });

  it('purge throws on EIO instead of reporting plaintext destroyed that may resurrect', () => {
    const log = new MessageLog('gate2-purge-eio');
    const r = rec({ text: 'burn after reading' });
    log.append(r);
    log.markRead([r.id]);
    ctl.failPath = stateDir('gate2-purge-eio');
    ctl.failCode = 'EIO';
    try {
      expect(() => log.purge()).toThrow(/injected fsync failure/);
    } finally {
      ctl.failPath = null;
    }
  });
});

describe('the FIRST append persists every directory entry it minted', () => {
  it('fsyncs the chain up through $TACENDUM_HOME and its parent', () => {
    // ensureDir's recursive mkdir can create spool dir, state/, and
    // $TACENDUM_HOME itself; each name lives in its PARENT, and an earlier revision
    // stopped at state/ — so the entry naming state/ (and the one naming
    // $TACENDUM_HOME) could evaporate at power loss, taking the whole acked
    // subtree while the server copy was already deleted.
    const log = new MessageLog('gate2-chain');
    ctl.ops.length = 0;
    ctl.on = true;
    try {
      log.append(rec());
    } finally {
      ctl.on = false;
    }
    const root = stateDir('gate2-chain');
    const synced = ctl.ops.filter((o) => o.op === 'fsync').map((o) => o.path);
    for (const dir of [root, dirname(root), home, dirname(home)]) {
      expect(synced).toContain(dir);
    }
  });
});

describe('the retention guard is fused to the rename and compares bytes', () => {
  it('an append landing AFTER the old stat check (temp-open time) still aborts the pass', () => {
    // An earlier revision checked (ino, size, mtime) BEFORE writing its temp file, so
    // the whole temp write was a check-to-use window: an interloper append
    // inside it (lock hand-removed by an operator) was renamed over and its
    // acked record erased. The interloper here runs at the exact moment the
    // temp file is opened — after an earlier revision's guard, before an earlier revision's.
    const log = new MessageLog('gate2-race');
    log.append(rec({ ts: Date.now() - RETAIN_MS - 1000 })); // guarantees a rewrite
    const survivor = rec();
    log.append(survivor);
    const acked = rec();
    const tmp = `${log.path}.${process.pid}.tmp`;
    ctl.onOpen = (path) => {
      if (path !== tmp) return;
      ctl.onOpen = null;
      appendFileSync(log.path, `${JSON.stringify(acked)}\n`);
    };
    try {
      expect(() => log.applyRetention()).toThrow(/changed while retention held its snapshot/);
    } finally {
      ctl.onOpen = null;
    }
    // The acked record is still in the spool, and the abandoned temp is gone.
    expect(log.read().map((r) => r.id)).toContain(acked.id);
    expect(existsSync(tmp)).toBe(false);
    // Abandoning cost nothing: the rerun converges without an interloper.
    const outcome = log.applyRetention();
    expect(outcome.dropped).toBe(1);
    const ids = log.read().map((r) => r.id);
    expect(ids).toContain(acked.id);
    expect(ids).toContain(survivor.id);
  });
});
