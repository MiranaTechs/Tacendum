/**
 * Blocking, persistence half. The feature's only real property is that a
 * blocked person cannot tell — so the tests that matter here assert what the
 * database does NOT do: it does not move a timestamp on a re-block, it does
 * not drop the block when the conversation is deleted, it does not destroy a
 * draft, and it does not leave a queued envelope flushable after the block is
 * written.
 *
 * Harness follows db.revise.test.ts: the fake op-sqlite in jest.setup.js
 * records statements rather than running them, so scoping is asserted on the
 * SQL and its parameters BY POSITION (peerId and a status are both strings —
 * `toContain` would still pass with them bound to each other's placeholders).
 * `blocked_peers` alone gets a small model (below), because the questions this
 * feature has to answer — "is it still blocked after X?" — are questions about
 * rows, not about strings.
 */
import * as db from '../src/db';

interface FakeDb {
  name: string;
  execute: jest.Mock;
  close: jest.Mock;
}
const sqlite = (
  jest.requireMock('@op-engineering/op-sqlite') as {
    __sqlite: {
      opened: string[];
      instances: Map<string, FakeDb>;
      reset: () => void;
    };
  }
).__sqlite;

const REAL = 'tacendum.sqlite';
const DECOY = 'tacendum-decoy.sqlite';
const PEER = '01PEERZ3NDEKTSV4RRFFQ69G5F';
const OTHER = '01OTHERZ3NDEKTSV4RRFFQ69G5';
const AT = 1_700_000_000_000;

function statements(name = REAL): string[] {
  return (sqlite.instances.get(name)?.execute.mock.calls ?? []).map(c =>
    String(c[0]),
  );
}
function callsOf(fragment: string, name = REAL): unknown[][] {
  return (sqlite.instances.get(name)?.execute.mock.calls ?? []).filter(c =>
    String(c[0]).includes(fragment),
  );
}
/** Statements issued from this point on, so one call's SQL can be read in
 * isolation from the schema pass that preceded it. */
function since(name = REAL): () => string[] {
  const mark = statements(name).length;
  return () => statements(name).slice(mark);
}

/**
 * A model of the `blocked_peers` table, installed over the recording fake.
 *
 * It honours the clause each statement actually carries (the conflict clause,
 * the WHERE, the transaction verbs) rather than assuming the implementation —
 * so swapping DO NOTHING for OR REPLACE, or dropping the transaction, makes a
 * test fail instead of passing silently. Every statement that does not name
 * `blocked_peers` falls through untouched, which is precisely the property the
 * deleteChat test needs: a table nobody names cannot be changed.
 */
function installBlockModel(name = REAL) {
  const rows = new Map<string, number>();
  const fail = { on: null as RegExp | null };
  let snapshot: Map<string, number> | null = null;
  const instance = sqlite.instances.get(name)!;
  instance.execute.mockImplementation(
    async (sql: string, params: unknown[] = []) => {
      const s = String(sql);
      if (fail.on?.test(s)) throw new Error('SQLITE_IOERR');
      // The setup file's schema-inference answers, reproduced: an empty answer
      // reads as "old shape on disk" and recurses forever.
      if (s.includes('PRAGMA table_info(attachments')) {
        return { rows: [{ name: 'direction' }] };
      }
      if (s.includes('PRAGMA table_info(reactions')) {
        // BOTH columns the rebuild loop checks. An answer missing one reads as
        // 'old shape on disk', so initSchema drops the table and re-enters
        // itself forever — a 4 GB heap death, not a red test, which is why a
        // stale mock here is so expensive to diagnose.
        return { rows: [{ name: 'targetDirection' }, { name: 'reactorId' }] };
      }
      if (s.includes('PRAGMA table_info(pending_revisions')) {
        return { rows: [{ name: 'writerId' }] };
      }
      if (s === 'BEGIN IMMEDIATE') {
        snapshot = new Map(rows);
        return { rows: [] };
      }
      if (s === 'COMMIT') {
        snapshot = null;
        return { rows: [] };
      }
      if (s === 'ROLLBACK') {
        if (snapshot) {
          rows.clear();
          for (const [k, v] of snapshot) rows.set(k, v);
        }
        snapshot = null;
        return { rows: [] };
      }
      if (!s.includes('blocked_peers')) return { rows: [] };
      if (/INSERT INTO blocked_peers/.test(s)) {
        const [peerId, at] = params as [string, number];
        const existed = rows.has(peerId);
        if (!existed || !/ON CONFLICT\(peerId\) DO NOTHING/.test(s)) {
          rows.set(peerId, at);
        }
        return { rows: [], rowsAffected: existed ? 0 : 1 };
      }
      if (/DELETE FROM blocked_peers/.test(s)) {
        if (/WHERE peerId = \?/.test(s)) rows.delete(params[0] as string);
        else rows.clear();
        return { rows: [], rowsAffected: 1 };
      }
      if (/SELECT blockedAt FROM blocked_peers/.test(s)) {
        const at = rows.get(params[0] as string);
        return { rows: at === undefined ? [] : [{ blockedAt: at }] };
      }
      if (/SELECT peerId FROM blocked_peers/.test(s)) {
        return { rows: [...rows.keys()].map(peerId => ({ peerId })) };
      }
      return { rows: [] };
    },
  );
  return { rows, fail };
}

/** Open the real workspace and put the model behind it. */
async function init(name = REAL) {
  await db.initDb();
  return installBlockModel(name);
}

beforeEach(async () => {
  await db.close();
  sqlite.reset();
  db.setWorkspace('real');
});

afterEach(async () => {
  await db.close();
});

describe('migration', () => {
  it('adds blocked_peers as its own table, with no ALTER and nothing dropped', async () => {
    await db.initDb();
    const sql = statements();
    const create = sql.find(s =>
      s.includes('CREATE TABLE IF NOT EXISTS blocked_peers'),
    );
    expect(create).toBeDefined();
    expect(create).toMatch(/peerId TEXT PRIMARY KEY/);
    expect(create).toMatch(/blockedAt INTEGER NOT NULL/);
    // This runs against installs holding real conversations: a new table needs
    // no ALTER and no rebuild, so the migration must not be able to rewrite or
    // discard anything that is already on disk.
    expect(sql.filter(s => /^\s*DROP TABLE/m.test(s))).toEqual([]);
    expect(sql.filter(s => /^\s*DELETE FROM/m.test(s))).toEqual([]);
    expect(sql.filter(s => /ALTER TABLE .*blocked_peers/.test(s))).toEqual([]);
  });

  it('is idempotent, and a second launch leaves the rows on disk alone', async () => {
    const model = await init();
    await db.blockPeer(PEER, AT);
    expect(await db.getBlockedAt(PEER)).toBe(AT);

    // A second app launch over the same open file: the whole schema pass runs
    // again. Nothing may throw, and nothing already recorded may be lost.
    const later = since();
    await expect(db.initDb()).resolves.toBeUndefined();
    expect(
      later().filter(s =>
        s.includes('CREATE TABLE IF NOT EXISTS blocked_peers'),
      ),
    ).toHaveLength(1);
    expect(
      later().filter(s => /^\s*(DROP TABLE|DELETE FROM)/m.test(s)),
    ).toEqual([]);
    expect(await db.getBlockedAt(PEER)).toBe(AT);
    expect(model.rows.get(PEER)).toBe(AT);
  });

  it('creates the table on the decoy file too, so a duress session has one', async () => {
    db.setWorkspace('decoy');
    await db.initDb();
    expect(statements(DECOY).join('\n')).toMatch(
      /CREATE TABLE IF NOT EXISTS blocked_peers/,
    );
    expect(sqlite.instances.has(REAL)).toBe(false);
  });
});

describe('blockPeer / unblockPeer / reads', () => {
  it('records the block and reads it back', async () => {
    await init();
    await db.blockPeer(PEER, AT);
    expect(await db.getBlockedAt(PEER)).toBe(AT);
    expect(await db.listBlockedPeers()).toContain(PEER);
    expect(await db.getBlockedAt(OTHER)).toBeNull();
  });

  it('does not move the timestamp when the same person is blocked again', async () => {
    await init();
    await db.blockPeer(PEER, AT);
    await db.blockPeer(PEER, AT + 60_000);
    // The original moment is the honest one — the second tap changed nothing,
    // and "blocked since" is the only date this feature ever shows.
    expect(await db.getBlockedAt(PEER)).toBe(AT);
    const [insert] = callsOf('INSERT INTO blocked_peers');
    expect(String(insert[0])).toContain('ON CONFLICT(peerId) DO NOTHING');
  });

  it('unblocks, and the read goes back to null', async () => {
    await init();
    await db.blockPeer(PEER, AT);
    await db.unblockPeer(PEER);
    expect(await db.getBlockedAt(PEER)).toBeNull();
    expect(await db.listBlockedPeers()).toEqual([]);
    const [del] = callsOf('DELETE FROM blocked_peers WHERE peerId');
    expect(del[1]).toEqual([PEER]);
  });

  it('unblocking one person leaves everyone else blocked', async () => {
    await init();
    await db.blockPeer(PEER, AT);
    await db.blockPeer(OTHER, AT + 1);
    await db.unblockPeer(PEER);
    expect(await db.listBlockedPeers()).toEqual([OTHER]);
  });
});

describe('a block survives deleting the conversation', () => {
  it('keeps the row when the whole chat is deleted', async () => {
    // THE headline: the drawer puts Block and Delete one gesture apart, so a
    // block stored as a column on `chats` would be erased by the very next
    // tap — silently unblocking the exact person the feature exists for.
    await init();
    await db.blockPeer(PEER, AT);
    await db.insertMessage({
      msgId: '01IN',
      peerId: PEER,
      direction: 'in',
      body: 'hello',
      ts: AT,
      status: 'received',
    });
    await db.enqueueOutgoing(
      {
        msgId: '01OUT',
        peerId: PEER,
        direction: 'out',
        body: 'hi',
        ts: AT + 1,
        status: 'pending',
      },
      { msgType: 'ciphertext', payload: 'AAAA' },
    );
    await db.putAttachment('01IN', 'in', 'ready', 'Zm9v', 10, 10);
    await db.setReaction('01IN', 'in', 'out', '👍', AT + 2);

    const later = since();
    await db.deleteChat(PEER);
    const deletion = later();

    expect(await db.getChat(PEER)).toBeNull();
    expect(await db.getBlockedAt(PEER)).toBe(AT);
    expect(await db.listBlockedPeers()).toContain(PEER);
    // Belt and braces: deleteChat must not so much as name the table.
    expect(deletion.filter(s => s.includes('blocked_peers'))).toEqual([]);

    // WHOLE-KEY CASCADES. Attachments and reactions are keyed on
    // (msgId, direction) and a msgId is chosen by whoever sent the message,
    // so matching on msgId alone let deleting ONE conversation reach into
    // another's rows through a colliding id. Same guard tombstoneMessage
    // has always had, in the place that had not copied it.
    const att = deletion.filter(s => s.includes('DELETE FROM attachments')).at(-1) ?? '';
    expect(att).toContain('attachments.direction');
    const rea = deletion.filter(s => s.includes('DELETE FROM reactions')).at(-1) ?? '';
    expect(rea).toContain('reactions.targetDirection');
  });
});

describe('blocking makes itself true in the same transaction', () => {
  it('writes the row, purges the outbox and marks the queue errored, atomically', async () => {
    await init();
    const later = since();
    await db.blockPeer(PEER, AT);
    const sql = later().filter(s => !s.startsWith('SELECT'));
    // Every removal must commit with the block. No intermediate COMMIT may
    // expose a blocked peer with queued envelopes or actionable AI state.
    expect(sql[0]).toBe('BEGIN IMMEDIATE');
    expect(sql[1]).toContain('INSERT INTO blocked_peers');
    expect(sql[2]).toBe('DELETE FROM approvals WHERE peerId = ?');
    expect(sql[3]).toBe('DELETE FROM ai_work_events WHERE peerId = ?');
    expect(sql[4]).toBe('DELETE FROM ai_agent_state WHERE peerId = ?');
    expect(sql[5]).toBe('DELETE FROM ai_notify_preferences WHERE peerId = ?');
    for (const table of ['approvals', 'ai_work_events', 'ai_agent_state', 'ai_notify_preferences']) {
      expect(callsOf(`DELETE FROM ${table} WHERE peerId = ?`).at(-1)?.[1]).toEqual([PEER]);
    }
    expect(sql[6]).toContain('DELETE FROM outbox');
    expect(sql[7]).toContain("UPDATE messages SET status = 'error'");
    expect(sql[8]).toBe('COMMIT');
    expect(sql).toHaveLength(9);
  });

  it('purges only that person’s queued envelopes', async () => {
    await init();
    const later = since();
    await db.blockPeer(PEER, AT);
    const [purge] = callsOf('DELETE FROM outbox');
    // The scope is the whole defence: blocking one person must not silently
    // throw away what is queued to everybody else.
    expect(String(purge[0])).toContain('WHERE peerId = ?');
    expect(purge[1]).toEqual([PEER]);
    expect(later().some(s => /DELETE FROM outbox\s*$/.test(s.trim()))).toBe(
      false,
    );
  });

  it('marks that person’s pending outgoing messages as errored, and nothing else', async () => {
    await init();
    await db.blockPeer(PEER, AT);
    const [update] = callsOf("UPDATE messages SET status = 'error'\n");
    const sql = String(update[0]);
    // Scoped three ways on purpose: another conversation, an inbound row, or
    // an already-'sent'/'delivered' message must all be left exactly as they
    // are — a status that changes under someone is a lie about what happened.
    expect(sql).toContain('peerId = ?');
    expect(sql).toContain("direction = 'out'");
    expect(sql).toContain("status = 'pending'");
    expect(update[1]).toEqual([PEER]);
  });

  it('does not touch the draft', async () => {
    await init();
    const later = since();
    await db.blockPeer(PEER, AT);
    // Blocking must not destroy words someone typed. An unsent draft is never
    // sent anywhere, so there is nothing to suppress.
    expect(later().filter(s => s.includes('drafts'))).toEqual([]);
  });

  it('rolls the block back when the purge fails, so it is never half-applied', async () => {
    const model = await init();
    const later = since();
    model.fail.on = /DELETE FROM outbox/;

    await expect(db.blockPeer(PEER, AT)).rejects.toThrow(/SQLITE_IOERR/);

    // A recorded block whose outbox was never purged would flush a message to
    // the person it was recorded against.
    expect(await db.getBlockedAt(PEER)).toBeNull();
    expect(later()).toContain('ROLLBACK');
    expect(later()).not.toContain('COMMIT');
  });
});

describe('sign-out', () => {
  it('wipes blocked_peers with the rest of local state', async () => {
    // Intended: a wipe is a wipe, and there is no identity left for a block
    // to protect.
    expect(db.DB_TABLES).toContain('blocked_peers');
    const model = await init();
    await db.blockPeer(PEER, AT);
    await db.clearLocalState();
    expect(statements().join('\n')).toMatch(/DELETE FROM blocked_peers/);
    expect(await db.getBlockedAt(PEER)).toBeNull();
    expect(model.rows.size).toBe(0);
  });

  it('wipes the decoy file’s blocks too', async () => {
    await db.clearDecoyState();
    expect(statements(DECOY).join('\n')).toMatch(/DELETE FROM blocked_peers/);
  });
});

describe('workspaces stay separate', () => {
  it('a block in the decoy file is invisible from the real one, and vice versa', async () => {
    await init(REAL);
    await db.blockPeer(PEER, AT);
    await db.close();

    db.setWorkspace('decoy');
    await init(DECOY);
    // A duress session sees an empty list: the real block is not evidence a
    // coerced unlock can produce.
    expect(await db.getBlockedAt(PEER)).toBeNull();
    expect(await db.listBlockedPeers()).toEqual([]);
    await db.blockPeer(OTHER, AT + 5);
    await db.close();

    db.setWorkspace('real');
    await db.initDb();
    // And a block recorded under duress stays in the decoy file.
    expect(await db.getBlockedAt(PEER)).toBe(AT);
    expect(await db.getBlockedAt(OTHER)).toBeNull();
    expect(await db.listBlockedPeers()).toEqual([PEER]);
  });
});

/**
 * The blocked-mirror dirty marker. Stored in the app-private
 * `profile` kv table, NOT the shared container whose write-failure it records.
 */
describe('the blocked-mirror dirty marker', () => {
  /** Model the `profile` kv table over the recording fake. */
  function installProfileModel(name = REAL) {
    const kv = new Map<string, string>();
    const instance = sqlite.instances.get(name)!;
    instance.execute.mockImplementation(async (sql: string, params: unknown[] = []) => {
      const s = String(sql);
      if (s.includes('PRAGMA table_info(attachments')) return { rows: [{ name: 'direction' }] };
      if (s.includes('PRAGMA table_info(reactions'))
        return { rows: [{ name: 'targetDirection' }, { name: 'reactorId' }] };
      if (s.includes('PRAGMA table_info(pending_revisions')) return { rows: [{ name: 'writerId' }] };
      if (/INSERT OR REPLACE INTO profile/.test(s)) {
        kv.set(params[0] as string, params[1] as string);
        return { rows: [] };
      }
      if (/DELETE FROM profile/.test(s)) {
        kv.delete(params[0] as string);
        return { rows: [] };
      }
      if (/SELECT value FROM profile/.test(s)) {
        const v = kv.get(params[0] as string);
        return { rows: v === undefined ? [] : [{ value: v }] };
      }
      return { rows: [] };
    });
    return kv;
  }

  it('reads false when nothing has been written', async () => {
    await db.initDb();
    installProfileModel();
    expect(await db.getBlockedMirrorDirty()).toBe(false);
  });

  it('round-trips dirty=true, and dirty=false clears it', async () => {
    await db.initDb();
    const kv = installProfileModel();

    await db.setBlockedMirrorDirty(true);
    expect(kv.get('blockedMirrorDirty')).toBe('1');
    expect(await db.getBlockedMirrorDirty()).toBe(true);

    await db.setBlockedMirrorDirty(false);
    expect(kv.has('blockedMirrorDirty')).toBe(false);
    expect(await db.getBlockedMirrorDirty()).toBe(false);
  });

  it('is workspace-scoped: the decoy never sees the real session marker', async () => {
    await db.initDb();
    installProfileModel(REAL);
    await db.setBlockedMirrorDirty(true);
    await db.close();

    db.setWorkspace('decoy');
    await db.initDb();
    installProfileModel(DECOY);
    // A fresh decoy file: the real session's stale-mirror flag is not evidence
    // a coerced unlock can produce.
    expect(await db.getBlockedMirrorDirty()).toBe(false);
  });
});
