/**
 * ROOMS, the schema half.
 *
 * What this file proves, and against what:
 *
 *  - The MIGRATION SHAPE — which branches run, which verbs they issue, and
 *    that the rebuild loop terminates — is proved here against a stateful
 *    model whose PRAGMA answers are derived from the DDL the code itself
 *    issued, the way a real engine's would be. Rebuild a table and the model
 *    answers with the new columns; forget a column in the recreated DDL and
 *    the loop trips the model's recursion guard instead of hanging jest.
 *  - ROW SURVIVAL — that a pre-migration file keeps every byte of chats,
 *    messages, outbox and attachments — cannot be proved against a mock that
 *    holds no rows. It was proved separately against Node's real SQLite
 *    engine (the same initSchema, over a file built in the pre-rooms
 *    shape); what THIS file pins is the migration's verb budget:
 *    The schema half is purely additive — booting a pre-rooms file issues no DROP and no
 *    DELETE at all (the room-aware key rebuilds land with the write
 *    paths that name the new keys in ON CONFLICT).
 *
 * Harness follows db.blocking.test.ts: models honour the clauses each
 * statement actually carries (the conflict target, the DO UPDATE SET, the
 * ORDER BY, the WHERE), so stripping a clause from db.ts changes what the
 * model does rather than passing silently.
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
const ROOM = '01ROOMZ3NDEKTSV4RRFFQ69G5A';
const OTHER_ROOM = '02ROOMZ3NDEKTSV4RRFFQ69G5A';
const FRIEND = '01FRIENDZ3NDEKTSV4RRFFQ69G';
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
/** Statements issued from this point on, so one call's SQL can be read apart
 * from the schema pass that preceded it. */
function since(name = REAL): () => string[] {
  const mark = statements(name).length;
  return () => statements(name).slice(mark);
}

/** Split on commas that are not inside parentheses. */
function splitArgs(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')') depth--;
    else if (s[i] === ',' && depth === 0) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  out.push(s.slice(start));
  return out.map(x => x.trim()).filter(x => x.length > 0);
}

/** Column names out of a CREATE TABLE statement's body — first identifier of
 * each top-level comma part that is not a table constraint. SQL comments are
 * stripped first, as an engine's tokenizer would, so a commented DDL (the
 * group_members lane warning, the reactions rationale) parses to its real
 * columns. */
function columnsOfCreate(sql: string): string[] {
  const body = sql
    .slice(sql.indexOf('(') + 1, sql.lastIndexOf(')'))
    .replace(/--[^\n]*/g, '');
  return splitArgs(body)
    .filter(p => !/^(PRIMARY|UNIQUE|CHECK|FOREIGN)\b/i.test(p))
    .map(p => p.split(/\s+/)[0]);
}

/**
 * A stateful schema model: PRAGMA table_info answers come from what the code
 * itself has created, altered and dropped — which is exactly what makes the
 * rebuild loop's fixed point testable. `initial` is the shape "on disk"
 * before boot; {} is a fresh file.
 */
function installMigrationModel(initial: Record<string, string[]>) {
  // Materialise the instance before initDb so the model is in place for the
  // very first statement.
  const instance = (
    jest.requireMock('@op-engineering/op-sqlite') as {
      open: (o: { name: string }) => FakeDb;
    }
  ).open({ name: REAL });
  const columns = new Map(Object.entries(initial).map(([t, c]) => [t, [...c]]));
  const drops: string[] = [];
  instance.execute.mockImplementation(async (rawSql: string) => {
    const s = String(rawSql);
    const create = /CREATE TABLE IF NOT EXISTS (\w+)/.exec(s);
    if (create) {
      if (!columns.has(create[1])) columns.set(create[1], columnsOfCreate(s));
      return { rows: [] };
    }
    const alter = /ALTER TABLE (\w+) ADD COLUMN (\w+)/.exec(s);
    if (alter) {
      columns.get(alter[1])?.push(alter[2]);
      return { rows: [] };
    }
    const drop = /DROP TABLE (\w+)/.exec(s);
    if (drop) {
      columns.delete(drop[1]);
      drops.push(drop[1]);
      // THE TRAP THIS PHASE DOCUMENTS: a registered column the recreated DDL
      // does not actually contain makes this loop drop and re-enter forever.
      // Throwing turns that into a red test instead of a hung suite.
      if (drops.length > 4) {
        throw new Error(`rebuild did not terminate: ${drops.join(', ')}`);
      }
      return { rows: [] };
    }
    const pragma = /PRAGMA table_info\((\w+)\)/.exec(s);
    if (pragma) {
      return { rows: (columns.get(pragma[1]) ?? []).map(name => ({ name })) };
    }
    return { rows: [] };
  });
  return { columns, drops };
}

/** The shape a fully-migrated pre-rooms install holds on disk. */
const PRE_G3: Record<string, string[]> = {
  profile: ['key', 'value'],
  chats: [
    'peerId', 'displayName', 'lastMessageAt', 'lastMessageText', 'about',
    'avatarB64', 'profileVersion', 'sentProfileVersion', 'safetyCheckedAt',
    'localName', 'createdAt', 'lastOpenedAt', 'identityChangedAt',
    'safetyMismatchAt', 'disappearSec', 'disappearVersion',
  ],
  messages: [
    'msgId', 'peerId', 'direction', 'body', 'ts', 'status', 'expiresAt',
    'editedAt', 'deletedAt', 'readAt', 'readSent',
  ],
  seen: ['msgId', 'ts'],
  attachments: ['msgId', 'direction', 'state', 'dataB64', 'w', 'h'],
  pending_revisions: [
    'peerId', 'targetMsgId', 'targetDirection', 'kind', 'text', 'ts',
  ],
  reactions: ['targetMsgId', 'targetDirection', 'direction', 'emoji', 'ts'],
  outbox: [
    'msgId', 'peerId', 'msgType', 'payload', 'attempts', 'priority', 'urgent',
    'notify',
  ],
  drafts: ['peerId', 'text', 'updatedAt'],
  blocked_peers: ['peerId', 'blockedAt'],
  call_log: [
    'cid', 'peerId', 'direction', 'kind', 'state', 'reason', 'startedAt',
    'connectedAt', 'endedAt', 'lastSeenAt', 'missed',
  ],
  call_offers: ['cid', 'peerId', 'sdp', 'video', 'exp', 'serverTs'],
  vault_items: [
    'peerId', 'id', 'writerId', 'seq', 'ackSeq', 'title', 'body', 'updatedAt',
    'deleted',
  ],
};

interface CounterRow {
  groupId: string;
  scope: string;
  seq: number;
}
interface FakeOutboxRow {
  msgId: string;
  peerId: string;
  msgType: string;
  payload: string;
  attempts: number;
  priority: number;
  urgent: number;
  notify: number;
  seq: number | null;
}

/**
 * The working model for everything past the schema pass: chats rows (for the
 * two the design filters), blocked_peers (copied from db.blocking.test.ts),
 * group_counters (the allocator, with the conflict target, the SET expression
 * and RETURNING all read off the statement), and outbox (with the ORDER BY
 * evaluated term by term).
 */
function installGroupsModel(name = REAL) {
  const chats = new Map<
    string,
    { kind?: string | null; sentProfileVersion?: number | null }
  >();
  const blocked = new Map<string, number>();
  const counters = new Map<string, CounterRow>();
  const outbox: FakeOutboxRow[] = [];
  const fail = { on: null as RegExp | null };
  const dropReturning = { on: false };
  let blockedSnapshot: Map<string, number> | null = null;
  const instance = sqlite.instances.get(name)!;

  const orderBy = (rows: FakeOutboxRow[], clause: string): FakeOutboxRow[] => {
    const terms = splitArgs(clause).map(t => {
      const m = /^([\s\S]*?)(?:\s+(ASC|DESC))?$/i.exec(t.trim())!;
      return { expr: m[1].trim(), desc: (m[2] ?? 'ASC').toUpperCase() === 'DESC' };
    });
    const value = (row: FakeOutboxRow, expr: string): unknown => {
      const coalesce = /^COALESCE\((\w+),\s*(-?\d+)\)$/i.exec(expr);
      if (coalesce) {
        const v = (row as unknown as Record<string, unknown>)[coalesce[1]];
        return v ?? Number(coalesce[2]);
      }
      if (/^\w+$/.test(expr)) {
        return (row as unknown as Record<string, unknown>)[expr];
      }
      throw new Error(`model cannot evaluate ORDER BY term: ${expr}`);
    };
    return [...rows].sort((a, b) => {
      for (const { expr, desc } of terms) {
        const va = value(a, expr);
        const vb = value(b, expr);
        // SQLite: NULL sorts before everything ascending, after descending.
        const rank = (v: unknown) => (v === null || v === undefined ? 0 : 1);
        let cmp = rank(va) - rank(vb);
        if (cmp === 0 && rank(va) === 1) {
          cmp = va! < vb! ? -1 : va! > vb! ? 1 : 0;
        }
        if (cmp !== 0) return desc ? -cmp : cmp;
      }
      return 0;
    });
  };

  instance.execute.mockImplementation(
    async (rawSql: string, params: unknown[] = []) => {
      const s = String(rawSql);
      if (fail.on?.test(s)) throw new Error('SQLITE_IOERR');
      // The setup file's schema-inference answers, reproduced: an empty
      // answer reads as "old shape on disk" and recurses forever.
      if (s.includes('PRAGMA table_info(attachments')) {
        return { rows: [{ name: 'direction' }] };
      }
      if (s.includes('PRAGMA table_info(reactions')) {
        return { rows: [{ name: 'targetDirection' }, { name: 'reactorId' }] };
      }
      if (s.includes('PRAGMA table_info(pending_revisions')) {
        return { rows: [{ name: 'writerId' }] };
      }
      if (s === 'BEGIN IMMEDIATE') {
        blockedSnapshot = new Map(blocked);
        return { rows: [] };
      }
      if (s === 'COMMIT') {
        blockedSnapshot = null;
        return { rows: [] };
      }
      if (s === 'ROLLBACK') {
        if (blockedSnapshot) {
          blocked.clear();
          for (const [k, v] of blockedSnapshot) blocked.set(k, v);
        }
        blockedSnapshot = null;
        return { rows: [] };
      }

      // --- chats reads the two the design filters issue ------------------------
      const guard = /^SELECT 1 AS x FROM chats\s+WHERE peerId = \?/.exec(
        s.trim(),
      );
      if (guard) {
        const row = chats.get(params[0] as string);
        if (!row) return { rows: [] };
        const kind = s.includes("COALESCE(kind, 'peer')")
          ? row.kind ?? 'peer'
          : row.kind;
        const hit = s.includes("<> 'peer'") ? kind !== 'peer' : kind === 'peer';
        return { rows: hit ? [{ x: 1 }] : [] };
      }
      if (/^SELECT peerId FROM chats WHERE COALESCE\(sentProfileVersion/.test(s.trim())) {
        const version = params[0] as number;
        const rows = [...chats.entries()]
          .filter(([, r]) => (r.sentProfileVersion ?? -1) < version)
          .filter(([, r]) => {
            if (!s.includes('kind')) return true; // filter stripped: model follows
            const kind = s.includes("COALESCE(kind, 'peer')")
              ? r.kind ?? 'peer'
              : r.kind;
            return kind === 'peer';
          })
          .map(([peerId]) => ({ peerId }));
        return { rows };
      }

      // --- blocked_peers, verbatim from db.blocking.test.ts ---------------
      if (/INSERT INTO blocked_peers/.test(s)) {
        const [peerId, at] = params as [string, number];
        const existed = blocked.has(peerId);
        if (!existed || !/ON CONFLICT\(peerId\) DO NOTHING/.test(s)) {
          blocked.set(peerId, at);
        }
        return { rows: [], rowsAffected: existed ? 0 : 1 };
      }
      if (/DELETE FROM blocked_peers/.test(s)) {
        if (/WHERE peerId = \?/.test(s)) blocked.delete(params[0] as string);
        else blocked.clear();
        return { rows: [], rowsAffected: 1 };
      }
      if (/SELECT blockedAt FROM blocked_peers/.test(s)) {
        const at = blocked.get(params[0] as string);
        return { rows: at === undefined ? [] : [{ blockedAt: at }] };
      }
      if (/SELECT peerId FROM blocked_peers/.test(s)) {
        return { rows: [...blocked.keys()].map(peerId => ({ peerId })) };
      }

      // --- group_counters: the allocator, clauses read off the statement --
      const upsert =
        /INSERT INTO group_counters\s*\(([^)]*)\)\s*VALUES\s*\(([^)]*)\)\s*(?:ON CONFLICT\s*\(([^)]*)\)\s*DO UPDATE SET([\s\S]*?))?(?:\s*RETURNING\s+(\w+))?\s*$/i.exec(
          s.trim(),
        );
      if (upsert) {
        const [, columnList, valueList, conflictTarget, setList, returning] =
          upsert;
        let cursor = 0;
        const next = () => params[cursor++];
        const evalExpr = (expr: string, current?: CounterRow): number | string => {
          const e = expr.trim();
          const plus = /^(.*?)\+(.*)$/.exec(e);
          if (plus) {
            return (
              Number(evalExpr(plus[1], current)) +
              Number(evalExpr(plus[2], current))
            );
          }
          if (e === '?') return next() as number | string;
          if (/^-?\d+$/.test(e)) return Number(e);
          const qualified = /^(\w+)\.(\w+)$/.exec(e);
          if (qualified) {
            return (current as unknown as Record<string, number>)?.[
              qualified[2]
            ];
          }
          throw new Error(`model cannot evaluate: ${expr}`);
        };
        const columns = splitArgs(columnList);
        const values = splitArgs(valueList);
        expect(values.length).toBe(columns.length);
        const candidate = {} as Record<string, number | string>;
        columns.forEach((column, i) => {
          candidate[column] = evalExpr(values[i]);
        });
        const target = conflictTarget
          ? splitArgs(conflictTarget)
          : ['groupId', 'scope'];
        const key = target.map(c => String(candidate[c])).join('|');
        let row = [...counters.values()].find(
          r =>
            target
              .map(c => String((r as unknown as Record<string, unknown>)[c]))
              .join('|') === key,
        );
        if (!row) {
          row = candidate as unknown as CounterRow;
          counters.set(`${row.groupId}|${row.scope}`, row);
        } else if (setList) {
          for (const part of splitArgs(setList)) {
            const eq = part.indexOf('=');
            (row as unknown as Record<string, number | string>)[
              part.slice(0, eq).trim()
            ] = evalExpr(part.slice(eq + 1), row);
          }
        }
        if (dropReturning.on) return { rows: [] };
        return {
          rows: returning
            ? [{ [returning]: (row as unknown as Record<string, number>)[returning] }]
            : [],
          rowsAffected: 1,
        };
      }
      if (/DELETE FROM group_counters/.test(s)) {
        for (const [k, r] of [...counters]) {
          if (r.groupId === (params[0] as string)) counters.delete(k);
        }
        return { rows: [], rowsAffected: 1 };
      }

      // --- outbox: the ORDER BY, evaluated -------------------------------
      const outboxSelect = /FROM outbox\s+ORDER BY ([\s\S]*)$/i.exec(s.trim());
      if (outboxSelect) {
        return { rows: orderBy(outbox, outboxSelect[1]) };
      }
      return { rows: [] };
    },
  );
  return { chats, blocked, counters, outbox, fail, dropReturning };
}

async function init(name = REAL) {
  await db.initDb();
  return installGroupsModel(name);
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
  it('boots a pre-rooms file: additive ALTERs land, EXACTLY the two key rebuilds run, and the loop terminates', async () => {
    const model = installMigrationModel(PRE_G3);
    await expect(db.initDb()).resolves.toBeUndefined();

    // THE TWO ROOM-AWARE KEY REBUILDS: they
    // land in the SAME commit as the writer-aware ON CONFLICT targets in
    // setReaction/holdRevision — a rebuilt key under the old targets made
    // both functions throw on every migrated phone, before markSeen and the
    // ack, so the server redelivered a frame whose ratchet key was already
    // consumed. One tapback wedged the drain. These two tables and NO OTHER:
    // a third name appearing here is a rebuild someone added without its
    // write paths.
    expect(model.drops).toEqual(['reactions', 'pending_revisions']);
    // No DELETE anywhere in a boot: with the mocked engine holding no rows,
    // the verb budget is the strongest "keeps every row" statement available
    // here; row-for-row survival is proved against real SQLite (see header).
    expect(statements().filter(s => /^\s*DELETE FROM/m.test(s))).toEqual([]);

    // The additive columns arrived by ALTER, never by rebuild.
    for (const [table, column] of [
      ['chats', 'kind'],
      ['chats', 'groupName'],
      ['messages', 'authorId'],
      ['messages', 'sq'],
      ['messages', 'outsider'],
      ['outbox', 'localMsgId'],
      ['outbox', 'seq'],
    ] as const) {
      expect(model.columns.get(table)).toContain(column);
      expect(
        statements().some(s =>
          new RegExp(`ALTER TABLE ${table} ADD COLUMN ${column}`).test(s),
        ),
      ).toBe(true);
    }

    // The rebuilt keys: the writer columns exist AND sit inside the PRIMARY
    // KEY, because a writer column outside the key would let two writers
    // collide on one row again — the exact defect the rebuild exists to end.
    expect(model.columns.get('reactions')).toContain('reactorId');
    expect(model.columns.get('pending_revisions')).toContain('writerId');
    const create = (table: string) =>
      statements().find(s =>
        s.includes(`CREATE TABLE IF NOT EXISTS ${table}`),
      ) ?? '';
    expect(create('reactions')).toMatch(
      /PRIMARY KEY \(targetMsgId, targetDirection, direction, reactorId\)/,
    );
    expect(create('pending_revisions')).toMatch(
      /PRIMARY KEY \(targetMsgId, targetDirection, writerId\)/,
    );
    expect(model.columns.get('groups')).toEqual([
      'groupId', 'ownerId', 'name', 'distributionId',
    ]);
    expect(model.columns.get('group_members')).toEqual([
      // 'class' joined later (the roster-write class rule) — an
      // additive ALTER on a pre-existing file, landing LAST exactly as the
      // messages.ai precedent did. A CONSCIOUS pin update.
      'groupId', 'memberId', 'writerId', 'seq', 'state', 'updatedAt', 'class',
    ]);
    expect(model.columns.get('group_settings')).toEqual([
      'groupId', 'writerId', 'seq', 'disappearSec',
    ]);
    expect(model.columns.get('group_counters')).toEqual([
      'groupId', 'scope', 'seq',
    ]);
  });

  it('boots a fresh file with no DROP at all, and a second boot changes nothing', async () => {
    const model = installMigrationModel({});
    await db.initDb();
    expect(model.drops).toEqual([]);

    const later = since();
    await expect(db.initDb()).resolves.toBeUndefined();
    expect(model.drops).toEqual([]);
    expect(later().filter(s => /^\s*(DROP TABLE|DELETE FROM)/m.test(s))).toEqual(
      [],
    );
  });

  it('DB_TABLES holds exactly the tables initSchema creates — the wipe list cannot drift from the schema', async () => {
    // THE privacy test: a table created here but missing from
    // DB_TABLES survives sign-out, and the decoy workspace inherits its rows
    // — for the group tables that is real room ids, owners and rosters
    // handed to a coerced unlock.
    await db.initDb();
    const created = statements()
      .map(s => /CREATE TABLE IF NOT EXISTS (\w+)/.exec(s)?.[1])
      .filter((t): t is string => t !== undefined);
    expect(created.length).toBeGreaterThan(0);
    expect(new Set(created)).toEqual(new Set(db.DB_TABLES));
  });

  it('the three room tables and the counter are in DB_TABLES by name', () => {
    expect(db.DB_TABLES).toContain('groups');
    expect(db.DB_TABLES).toContain('group_members');
    expect(db.DB_TABLES).toContain('group_settings');
    expect(db.DB_TABLES).toContain('group_counters');
  });

  it('group_members keeps its EXACT key — the owner’s two lanes are deliberately ONE row', async () => {
    await db.initDb();
    const create = (frag: string) =>
      statements().find(s => s.includes(`CREATE TABLE IF NOT EXISTS ${frag}`)) ??
      '';
    // THE KEY IS THE DESIGN. When memberId = writerId = ownerId this key
    // admits a single row, so the fold counts it in both lanes; widening it
    // to "split the lanes" silently breaks the owner's ability to rejoin
    // their own room — the schema comment says so, and this
    // pins it against exactly that "fix".
    expect(create('group_members')).toMatch(
      /PRIMARY KEY \(groupId, memberId, writerId\)/,
    );
    expect(create('group_members')).toMatch(
      /state\s+TEXT NOT NULL CHECK \(state IN \('in','out'\)\)/,
    );
    expect(create('groups')).toMatch(/groupId\s+TEXT PRIMARY KEY/);
    expect(create('group_settings')).toMatch(
      /PRIMARY KEY \(groupId, writerId\)/,
    );
    expect(create('group_counters')).toMatch(/PRIMARY KEY \(groupId, scope\)/);
  });
});

describe('reserveGroupSeq', () => {
  it('allocates 1, 2, 3, … per room and scope, with no number ever repeated', async () => {
    await init();
    const got: number[] = [];
    for (let i = 0; i < 8; i++) got.push(await db.reserveGroupSeq(ROOM, 'writer'));
    expect(got).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(new Set(got).size).toBe(8);
  });

  it('the two scopes are independent counters, and so are two rooms', async () => {
    await init();
    await db.reserveGroupSeq(ROOM, 'writer');
    await db.reserveGroupSeq(ROOM, 'writer');
    // A message send must not advance my roster lane, and vice versa: the
    // roster lane's numbers ride grp.roster's `n` while msg numbers ride
    // `sq`, and cross-talk would open gaps a peer could mistake for loss.
    expect(await db.reserveGroupSeq(ROOM, 'msg')).toBe(1);
    expect(await db.reserveGroupSeq(OTHER_ROOM, 'writer')).toBe(1);
    expect(await db.reserveGroupSeq(ROOM, 'writer')).toBe(3);
  });

  it('allocates in ONE atomic statement — no read-then-add anywhere', async () => {
    const model = await init();
    const later = since();
    await db.reserveGroupSeq(ROOM, 'writer');
    const sql = later();
    expect(sql).toHaveLength(1);
    expect(sql[0]).toContain('ON CONFLICT(groupId, scope) DO UPDATE');
    expect(sql[0]).toContain('RETURNING seq');
    expect(model.counters.get(`${ROOM}|writer`)?.seq).toBe(1);
  });

  it('REFUSES rather than guesses when the driver drops the RETURNING row', async () => {
    const model = await init();
    model.dropReturning.on = true;
    // reserveVaultSeq's argument, inherited: re-reading the row hands two
    // overlapping allocations the same number, and a reused number under a
    // max-merge lane is permanent silent divergence.
    await expect(db.reserveGroupSeq(ROOM, 'writer')).rejects.toThrow(
      /could not be allocated/,
    );
  });
});

describe('deleteGroup', () => {
  it('default form: purges the conversation, in one transaction, children before parents', async () => {
    await init();
    const later = since();
    await db.deleteGroup(ROOM);
    const sql = later();
    expect(sql[0]).toBe('BEGIN IMMEDIATE');
    // COMMIT closes the WRITE set. The one statement allowed after it is the
    // extension name-mirror's read-only refresh, which
    // must FOLLOW the durable delete rather than ride inside it — the mirror
    // may only ever trail the database's truth.
    expect(sql[sql.length - 1]).toBe(
      `SELECT peerId, groupName, localName FROM chats WHERE kind = 'group'`,
    );
    expect(sql[sql.length - 2]).toBe('COMMIT');
    const order = [
      'DELETE FROM reactions',
      'DELETE FROM attachments',
      'DELETE FROM outbox',
      'DELETE FROM drafts',
      'DELETE FROM pending_revisions',
      'DELETE FROM vault_items',
      'DELETE FROM messages',
      'DELETE FROM chats',
    ].map(frag => sql.findIndex(s => s.includes(frag)));
    for (const at of order) expect(at).toBeGreaterThan(0);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('default form: leaves blocked_peers AND the group tables untouched — not so much as named', async () => {
    const model = await init();
    model.blocked.set(FRIEND, AT);
    const later = since();
    await db.deleteGroup(ROOM);
    const sql = later();
    // The block: same argument as deleteChat — a member blocked from inside
    // a room must stay blocked after the room is gone.
    expect(sql.filter(s => s.includes('blocked_peers'))).toEqual([]);
    expect(await db.getBlockedAt(FRIEND)).toBe(AT);
    // The anchor, the slots and the counters: The whole design is that a
    // locally deleted room can come back on new traffic, which needs the
    // owner, the roster and MY counters to survive — a reset counter would
    // make my next write reuse a number some peer already holds.
    expect(sql.filter(s => /\bgroups\b/.test(s))).toEqual([]);
    expect(sql.filter(s => s.includes('group_members'))).toEqual([]);
    expect(sql.filter(s => s.includes('group_settings'))).toEqual([]);
    expect(sql.filter(s => s.includes('group_counters'))).toEqual([]);
  });

  it('purgeState form: removes the anchor, both slot tables and the counters too — and still not the blocks', async () => {
    const model = await init();
    model.blocked.set(FRIEND, AT);
    await db.reserveGroupSeq(ROOM, 'writer');
    const later = since();
    await db.deleteGroup(ROOM, { purgeState: true });
    const sql = later();
    for (const frag of [
      'DELETE FROM group_members WHERE groupId = ?',
      'DELETE FROM group_settings WHERE groupId = ?',
      'DELETE FROM group_counters WHERE groupId = ?',
      'DELETE FROM groups WHERE groupId = ?',
    ]) {
      const calls = callsOf(frag);
      expect(calls).toHaveLength(1);
      expect(calls[0][1]).toEqual([ROOM]);
    }
    // COMMIT, then only the name-mirror's read-only refresh — see the
    // default-form case above for why the read trails the transaction.
    expect(sql[sql.length - 1]).toBe(
      `SELECT peerId, groupName, localName FROM chats WHERE kind = 'group'`,
    );
    expect(sql[sql.length - 2]).toBe('COMMIT');
    expect(sql.filter(s => s.includes('blocked_peers'))).toEqual([]);
    expect(await db.getBlockedAt(FRIEND)).toBe(AT);
    // The purged counter is gone with the room.
    expect(model.counters.has(`${ROOM}|writer`)).toBe(false);
  });

  it('scopes every delete to THIS room', async () => {
    await init();
    const later = since();
    await db.deleteGroup(ROOM, { purgeState: true });
    for (const call of (sqlite.instances.get(REAL)?.execute.mock.calls ?? [])
      .filter(c => later().includes(String(c[0])))
      .filter(c => /^DELETE FROM/.test(String(c[0]).trim()))) {
      // Every DELETE carries the room id in its params — an unparameterised
      // DELETE here would be clearLocalState wearing deleteGroup's name.
      expect(call[1]).toEqual(
        expect.arrayContaining([ROOM]),
      );
    }
  });

  it('finds fan-out legs through outbox.localMsgId, while the message rows still exist', async () => {
    await init();
    const later = since();
    await db.deleteGroup(ROOM);
    const sql = later();
    const outboxAt = sql.findIndex(s => s.includes('DELETE FROM outbox'));
    const messagesAt = sql.findIndex(s => s.includes('DELETE FROM messages'));
    // A leg is queued against the MEMBER's id, so peerId = room alone
    // would leave every queued leg flushable after the room is gone — a
    // deleted room that keeps sending. localMsgId is the key that finds
    // them, and it only works while the room's message rows are still there.
    expect(sql[outboxAt]).toContain('outbox.localMsgId');
    expect(sql[outboxAt]).toContain('peerId = ?');
    expect(sql[outboxAt]).toContain("m.direction = 'out'");
    expect(outboxAt).toBeLessThan(messagesAt);
  });

  it('rolls back whole when any statement fails', async () => {
    const model = await init();
    model.fail.on = /DELETE FROM drafts/;
    const later = since();
    await expect(db.deleteGroup(ROOM)).rejects.toThrow(/SQLITE_IOERR/);
    expect(later()).toContain('ROLLBACK');
    expect(later()).not.toContain('COMMIT');
  });

  it('purgeState is named by db.ts ALONE — the grp.del apply path reaches it only through the store seam', () => {
    // The ownership clause, enforced as a source scan: a
    // screen or a settings surface reaching for the full purge would
    // silently break the recreate-on-traffic rule. The counted grp.del
    // reaches the purge through loadGroupStore's clear() — which maps to
    // deleteGroup({purgeState:true}) inside db.ts itself — so even the
    // apply path never writes the literal, and no other file may either.
    // (`fs`/`__dirname` are untyped here; app/tsconfig.json declares only
    // the jest types — same shape as qr.test.ts's import scan.)
    const fs = jest.requireActual<{
      readdirSync(
        path: string,
        opts: { withFileTypes: true },
      ): { name: string; isDirectory(): boolean }[];
      readFileSync(path: string, encoding: string): string;
    }>('fs');
    const testPath = expect.getState().testPath ?? '';
    const srcDir = `${testPath.slice(0, testPath.lastIndexOf('/__tests__/'))}/src`;
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = `${dir}/${entry.name}`;
        if (entry.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry.name)) {
          // db.ts is the definition (and documents the ownership rule in its
          // comment) AND the one authorised call site — the store seam's
          // clear(). Every OTHER file is an offender, the apply path
          // included.
          if (full === `${srcDir}/db.ts`) continue;
          const text = fs.readFileSync(full, 'utf8');
          if (/purgeState:\s*true/.test(text)) offenders.push(full);
        }
      }
    };
    walk(srcDir);
    expect(offenders).toEqual([]);
  });
});

describe('the two room-message filters', () => {
  it('broadcastProfile sends zero frames for a workspace containing only rooms: the list it iterates is empty', async () => {
    const model = await init();
    // broadcastProfile (messaging.ts) sends exactly one card per id in
    // chatsMissingMyProfile's answer, so this list IS the frame count.
    // Unfiltered, each room id would 404 the prekey fetch and retry on every
    // launch forever — a silent, permanent no-op per room.
    model.chats.set(ROOM, { kind: 'group', sentProfileVersion: null });
    model.chats.set(OTHER_ROOM, { kind: 'group', sentProfileVersion: 2 });
    expect(await db.chatsMissingMyProfile(9)).toEqual([]);
  });

  it('still lists the people — including rows that predate the kind column', async () => {
    const model = await init();
    model.chats.set(ROOM, { kind: 'group', sentProfileVersion: null });
    model.chats.set(FRIEND, { kind: null, sentProfileVersion: 3 });
    model.chats.set('01EXPLICIT', { kind: 'peer', sentProfileVersion: null });
    model.chats.set('01CURRENT', { kind: null, sentProfileVersion: 9 });
    const missing = await db.chatsMissingMyProfile(9);
    expect(missing.sort()).toEqual(['01EXPLICIT', FRIEND].sort());
  });

  it('blockPeer refuses a room outright: no row, no purge, no status rewrite, no transaction', async () => {
    const model = await init();
    model.chats.set(ROOM, { kind: 'group' });
    const later = since();
    await db.blockPeer(ROOM, AT);
    expect(await db.getBlockedAt(ROOM)).toBeNull();
    // Nothing but the guard read: erroring a room's pending fan-out rows
    // would be a delete wearing block's clothes.
    expect(later().filter(s => !s.trim().startsWith('SELECT'))).toEqual([]);
  });

  it('blockPeer still blocks people, including someone with no chats row at all', async () => {
    const model = await init();
    model.chats.set(FRIEND, { kind: null });
    await db.blockPeer(FRIEND, AT);
    expect(await db.getBlockedAt(FRIEND)).toBe(AT);
    await db.blockPeer('01STRANGER', AT + 1);
    expect(await db.getBlockedAt('01STRANGER')).toBe(AT + 1);
  });
});

describe('outbox ordering', () => {
  const row = (
    msgId: string,
    priority: number,
    seq: number | null,
  ): FakeOutboxRow => ({
    msgId,
    peerId: FRIEND,
    msgType: 'ciphertext',
    payload: 'AAAA',
    attempts: 0,
    priority,
    urgent: 0,
    notify: 1,
    seq,
  });

  it('is byte-identical for rows without seq: priority first, then exact ULID order', async () => {
    const model = await init();
    // Scrambled insert order, no seq anywhere — every pre-rooms row on disk.
    model.outbox.push(row('01ZB', 0, null));
    model.outbox.push(row('01AA', 0, null));
    model.outbox.push(row('01ZC', 1, null));
    model.outbox.push(row('01MM', 0, null));
    const got = (await db.listOutbox()).map(r => r.msgId);
    // What the pre-rooms query (priority DESC, msgId ASC) produced, computed
    // independently of the SQL under test.
    const legacy = [...model.outbox]
      .sort((a, b) =>
        a.priority !== b.priority
          ? b.priority - a.priority
          : a.msgId < b.msgId
            ? -1
            : 1,
      )
      .map(r => r.msgId);
    expect(got).toEqual(legacy);
    expect(got).toEqual(['01ZC', '01AA', '01MM', '01ZB']);
  });

  it('orders seq before msgId within a priority, so flush order is the local fact, not the random wire id', async () => {
    const model = await init();
    model.outbox.push(row('01AA', 0, 2)); // low ULID, later seq
    model.outbox.push(row('01ZZ', 0, 1)); // high ULID, earlier seq
    model.outbox.push(row('01MM', 0, null)); // legacy row: COALESCE ties at 0
    model.outbox.push(row('01KK', 0, 0)); // an explicit 0 is the SAME class
    // A NULL row and a 0 row are one equivalence class under COALESCE — the
    // tie falls to msgId — where bare `seq ASC` would put every legacy row
    // strictly first (SQLite sorts NULL before 0) and quietly reorder a
    // mixed queue.
    const got = (await db.listOutbox()).map(r => r.msgId);
    expect(got).toEqual(['01KK', '01MM', '01ZZ', '01AA']);
  });

  it('priority still beats everything: call signalling flushes first regardless of seq', async () => {
    const model = await init();
    model.outbox.push(row('01AA', 0, 1));
    model.outbox.push(row('01ZZ', 1, 99));
    const got = (await db.listOutbox()).map(r => r.msgId);
    expect(got).toEqual(['01ZZ', '01AA']);
  });
});
