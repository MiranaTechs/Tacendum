import { describe, expect, it } from 'vitest';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'tacendum-msglog-'));
process.env.TACENDUM_HOME = home;

const { MessageLog, takeInbox, RETAIN_MS, REDACT_AFTER_MS } = await import('../src/msglog.js');
const { stateDir, clientDir } = await import('../src/config.js');
type MessageRecord = import('../src/msglog.js').MessageRecord;

const PEER_A = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const PEER_B = '01BOBBOBBOBBOBBOBBOBBOBBOB';

let seq = 0;
function rec(over: Partial<MessageRecord> = {}): MessageRecord {
  seq += 1;
  return {
    id: `01HXXXXXXXXXXXXXXXXXX${String(seq).padStart(5, '0')}`,
    dir: 'in',
    peer: PEER_A,
    ts: Date.now(),
    tcm: '',
    text: `text ${seq}`,
    read: false,
    ...over,
  };
}

/**
 * the design plan, as amended by its security review. The properties under
 * test are the review's, in its order: the compartment split, the mode/link
 * validation on every open, retention over append-forever, and the read
 * lifecycle `inbox` is built on.
 */
describe('the durable message log', () => {
  it('lives in the state compartment, NOT beside the identity key', () => {
    const log = new MessageLog('compartment');
    log.append(rec());
    // The spool is under $TACENDUM_HOME/state/<name>/ …
    expect(log.path.startsWith(stateDir('compartment'))).toBe(true);
    expect(existsSync(log.path)).toBe(true);
    // … and the KEY directory gained nothing: copying it (backup, scp, a
    // debug tarball) must never quietly copy conversation plaintext.
    expect(existsSync(join(clientDir('compartment'), 'messages.jsonl'))).toBe(false);
  });

  it('creates the spool 0600 in a 0700 directory', () => {
    const log = new MessageLog('perms');
    log.append(rec());
    expect(statSync(log.path).mode & 0o777).toBe(0o600);
    expect(statSync(stateDir('perms')).mode & 0o777).toBe(0o700);
  });

  it('refuses a spool that has gone group/world readable, with the remedy', () => {
    const log = new MessageLog('loose');
    log.append(rec());
    chmodSync(log.path, 0o644);
    // Mode on create governs creation only; every OPEN re-validates. Both
    // directions fail closed: no more plaintext in, none out.
    expect(() => log.append(rec())).toThrow(/refusing to use the message log/);
    expect(() => log.read()).toThrow(/chmod 600/);
    chmodSync(log.path, 0o600);
    expect(log.read().length).toBe(1);
  });

  it('refuses a spool that has been replaced by a symlink', () => {
    const log = new MessageLog('symlinked');
    const target = join(stateDir('symlinked'), 'elsewhere');
    mkdirSync(stateDir('symlinked'), { recursive: true, mode: 0o700 });
    writeFileSync(target, '', { mode: 0o600 });
    symlinkSync(target, log.path);
    // O_NOFOLLOW makes the open itself fail — plaintext must never be
    // appended through a link something else planted.
    expect(() => log.append(rec())).toThrow();
  });

  it('reads newest-first, honouring peer filter and limit', () => {
    const log = new MessageLog('order');
    const a = rec({ peer: PEER_A, ts: 1000 });
    const b = rec({ peer: PEER_B, ts: 2000 });
    const c = rec({ peer: PEER_A, ts: 3000 });
    for (const r of [a, b, c]) log.append(r);

    const all = log.read();
    expect(all.map(r => r.id)).toEqual([c.id, b.id, a.id]);
    expect(log.read({ peer: PEER_B }).map(r => r.id)).toEqual([b.id]);
    expect(log.read({ limit: 2 }).map(r => r.id)).toEqual([c.id, b.id]);
    expect(log.read({ limit: 0 }).length).toBe(3); // 0 means everything
  });

  it('skips a damaged trailing line instead of refusing the whole inbox', () => {
    const log = new MessageLog('crashline');
    log.append(rec());
    // A crash mid-append leaves at most one partial line at the end.
    appendFileSync(log.path, '{"id":"01HTRUNCATED', { mode: 0o600 });
    expect(log.read().length).toBe(1);
    // …and the next retention pass drops it from the file physically.
    log.applyRetention();
    expect(readFileSync(log.path, 'utf8')).not.toContain('01HTRUNCATED');
  });

  it('marks read persistently, across instances', () => {
    const log = new MessageLog('readstate');
    const r1 = rec();
    log.append(r1);
    expect(log.read({ unread: true }).length).toBe(1);
    log.markRead([r1.id]);
    // A DIFFERENT instance — inbox runs in a different process than listen.
    const again = new MessageLog('readstate');
    expect(again.read()[0]?.read).toBe(true);
    expect(again.read({ unread: true }).length).toBe(0);
  });

  it('takeInbox marks returned messages read — unless --peek', () => {
    const log = new MessageLog('peek');
    log.append(rec());
    log.append(rec());

    const peeked = takeInbox(log, { limit: 10, unread: false, peek: true });
    expect(peeked.length).toBe(2);
    // Peek looked without touching: still unread for the next reader.
    expect(log.read({ unread: true }).length).toBe(2);

    const taken = takeInbox(log, { limit: 10, unread: false, peek: false });
    // Returned records carry the state AS IT WAS…
    expect(taken.every(r => !r.read)).toBe(true);
    // …but the mark landed.
    expect(log.read({ unread: true }).length).toBe(0);
  });

  it('takeInbox with a limit marks ONLY what it returned', () => {
    const log = new MessageLog('partial');
    const older = rec({ ts: 1 });
    const newer = rec({ ts: 2 });
    log.append(older);
    log.append(newer);
    takeInbox(log, { limit: 1, unread: false, peek: false });
    // The page the caller never saw stays unread.
    const unread = log.read({ unread: true });
    expect(unread.map(r => r.id)).toEqual([older.id]);
  });
});

describe('retention (the review\'s "not append-forever")', () => {
  it('purges a consumed body after the 24h grace, keeping redacted metadata', () => {
    const log = new MessageLog('grace');
    const r1 = rec({ text: 'the door code is 4211' });
    log.append(r1);
    const readAt = Date.now() - REDACT_AFTER_MS - 1000; // consumed >24h ago
    log.markRead([r1.id], readAt);

    const outcome = log.applyRetention();
    expect(outcome.redacted).toBe(1);
    const [kept] = log.read();
    expect(kept).toMatchObject({ id: r1.id, peer: r1.peer, ts: r1.ts, red: true, read: true });
    expect(kept?.text).toBe('');
    expect(kept?.bytes).toBe(Buffer.byteLength('the door code is 4211', 'utf8'));
    // The plaintext is off the disk, not merely off the API.
    expect(readFileSync(log.path, 'utf8')).not.toContain('4211');
  });

  it('redaction preserves the ROOM routing/exclusion metadata: grp, men and ai survive with the body gone', () => {
    const log = new MessageLog('room-redact');
    // An inbound AI-marked room row — the shape roomAgentAuthorIds keys on.
    const r1 = rec({
      text: 'crew, the staging key is 4211',
      tcm: 'grp.msg',
      grp: '01GRPGRPGRPGRPGRPGRPGRPGRP',
      men: true,
      ai: true,
    });
    log.append(r1);
    log.markRead([r1.id], Date.now() - REDACT_AFTER_MS - 1000); // consumed >24h ago

    expect(log.applyRetention().redacted).toBe(1);
    const [kept] = log.read();
    // The BODY is gone — only content is purged.
    expect(kept?.text).toBe('');
    expect(kept?.red).toBe(true);
    expect(readFileSync(log.path, 'utf8')).not.toContain('4211');
    // …but the room routing/exclusion metadata rode through redaction exactly
    // as `ref` does. WITHOUT this, roomAgentAuthorIds (grp===gid && ai===true)
    // loses the agent the instant its AI-marked row redacts, and the agent
    // silently rejoins non-mention fan-out. Reddens if any is dropped.
    expect(kept?.grp).toBe('01GRPGRPGRPGRPGRPGRPGRPGRP');
    expect(kept?.men).toBe(true);
    expect(kept?.ai).toBe(true);
  });

  it('leaves a consumed body alone inside the grace period', () => {
    const log = new MessageLog('inside-grace');
    const r1 = rec();
    log.append(r1);
    log.markRead([r1.id]); // read just now
    expect(log.applyRetention().redacted).toBe(0);
    expect(log.read()[0]?.text).toBe(r1.text);
  });

  it('purge() (inbox --purge) skips the grace: consumed bodies go NOW', () => {
    const log = new MessageLog('force');
    const r1 = rec({ text: 'secret sentence' });
    log.append(r1);
    log.markRead([r1.id]);
    expect(log.purge().redacted).toBe(1);
    expect(readFileSync(log.path, 'utf8')).not.toContain('secret sentence');
    // Unread bodies are NOT touched even by force — nobody consumed them.
    const r2 = rec({ text: 'still unread' });
    log.append(r2);
    expect(log.purge().redacted).toBe(0);
    expect(log.read()[0]?.text).toBe('still unread');
  });

  it('drops everything older than the 30-day queue TTL, metadata included', () => {
    const log = new MessageLog('ttl');
    const ancient = rec({ ts: Date.now() - RETAIN_MS - 1000 });
    const fresh = rec();
    log.append(ancient);
    log.append(fresh);
    const outcome = log.applyRetention();
    expect(outcome.dropped).toBe(1);
    expect(log.read().map(r => r.id)).toEqual([fresh.id]);
    // The sidecar cannot grow against a log that cannot: pruned with it.
    log.markRead([fresh.id]);
    log.applyRetention({ now: Date.now() + RETAIN_MS + 1000 });
    expect(log.read().length).toBe(0);
    expect(JSON.parse(readFileSync(join(stateDir('ttl'), 'messages-read.json'), 'utf8'))).toEqual({});
  });
});
