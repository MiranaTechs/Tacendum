/**
 * The approvals store — single-use insert, conditional
 * settlement, and the read-time maintenance pass (local lapse, redaction,
 * retention) on a MOVING clock.
 *
 * THE MODEL INTERPRETS THE SQL — db.vault.test.ts's discipline, sized to this
 * table. Statements are recognised by their verb, `?` placeholders are bound
 * positionally into the text first (one left-to-right cursor, as the driver
 * binds), and the column lists, SET assignments, WHERE conditions, ON
 * CONFLICT target and ORDER BY terms are all READ from the statement and
 * evaluated against an in-memory table. Strip a clause from db.ts — the
 * conflict target, `state = 'pending'`, the deadline comparison — and the
 * model's behaviour changes with it; that is what keeps these tests
 * falsifiable rather than assertions against themselves.
 *
 * THE CLOCK IS A PARAMETER. Every deadline here is exercised by moving `now`
 * forward through listApprovals/settleApproval calls — nothing pins Date.now
 * beside an advancing timer (the frozen-clock rule: that shape has hidden
 * release-blocking defects under a green suite before).
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
      instances: Map<string, FakeDb>;
      reset: () => void;
    };
  }
).__sqlite;

const REAL = 'tacendum.sqlite';
const PEER = '01FRIENDZ3NDEKTSV4RRFFQ69G';
const OTHER_PEER = '01OTHERZ3NDEKTSV4RRFFQ69GZ';
const Q = '01J8MEAPPR0VAQ4X2C6TKN9RFV';
const Q2 = '01J8MEAPPR0VAQ4X2C6TKN9RFW';
const T0 = 1_700_000_000_000;

type Cell = string | number | null;
type Row = Record<string, Cell>;

let table: Row[] = [];
let revokedPeers = new Set<string>();

/** Bind `?` placeholders into the text positionally — one cursor over the
 * whole statement, which is what the driver does. The evaluator resolves
 * each `§n§` marker against the params array. */
function bind(sql: string): string {
  let i = 0;
  return sql.replace(/\?/g, () => `§${i++}§`);
}

function splitTop(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  const upper = s.toUpperCase();
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')') depth--;
    else if (
      depth === 0 &&
      (sep === ','
        ? s[i] === ','
        : upper.startsWith(` ${sep} `, i - 1))
    ) {
      if (sep === ',') {
        out.push(s.slice(start, i));
        start = i + 1;
      } else {
        out.push(s.slice(start, i));
        start = i + sep.length + 1;
        i += sep.length;
      }
    }
  }
  out.push(s.slice(start));
  return out.map(x => x.trim()).filter(x => x.length > 0);
}

/** The value expressions the approvals statements actually use. Anything
 * else throws — a model that coped silently would assert against itself. */
function evalExpr(expr: string, row: Row | null, params: readonly unknown[]): Cell {
  const s = expr.trim().replace(/^\((.*)\)$/s, '$1').trim();
  // Rightmost top-level +/-, left-associating as SQL does; * binds tighter.
  let depth = 0;
  for (let i = s.length - 1; i > 0; i--) {
    if (s[i] === ')') depth++;
    else if (s[i] === '(') depth--;
    else if ((s[i] === '+' || s[i] === '-') && depth === 0) {
      const left = Number(evalExpr(s.slice(0, i), row, params));
      const right = Number(evalExpr(s.slice(i + 1), row, params));
      return s[i] === '+' ? left + right : left - right;
    }
  }
  depth = 0;
  for (let i = s.length - 1; i > 0; i--) {
    if (s[i] === ')') depth++;
    else if (s[i] === '(') depth--;
    else if (s[i] === '*' && depth === 0) {
      return (
        Number(evalExpr(s.slice(0, i), row, params)) *
        Number(evalExpr(s.slice(i + 1), row, params))
      );
    }
  }
  const coalesce = /^COALESCE\((.*)\)$/i.exec(s);
  if (coalesce) {
    for (const arg of splitTop(coalesce[1]!, ',')) {
      const v = evalExpr(arg, row, params);
      if (v !== null && v !== undefined) return v;
    }
    return null;
  }
  const bound = /^§(\d+)§$/.exec(s);
  if (bound) return params[Number(bound[1])] as Cell;
  if (/^-?\d+$/.test(s)) return Number(s);
  const literal = /^'(.*)'$/s.exec(s);
  if (literal) return literal[1]!;
  if (/^\w+$/.test(s)) {
    const v = row?.[s];
    return v === undefined ? null : v;
  }
  throw new Error(`approvals model cannot evaluate: ${expr}`);
}

function evalCond(cond: string, row: Row, params: readonly unknown[]): boolean {
  const c = cond.trim().replace(/^\((.*)\)$/s, '$1').trim();
  const ands = splitTop(c, 'AND');
  if (ands.length > 1) return ands.every(a => evalCond(a, row, params));
  const isNotNull = /^(.*)\bIS NOT NULL$/i.exec(c);
  if (isNotNull) return evalExpr(isNotNull[1]!, row, params) !== null;
  const cmp = /^(.*?)(<=|>=|!=|=|<|>)(.*)$/s.exec(c);
  if (!cmp) throw new Error(`approvals model cannot evaluate condition: ${c}`);
  const left = evalExpr(cmp[1]!, row, params);
  const right = evalExpr(cmp[3]!, row, params);
  switch (cmp[2]) {
    case '=':
      return left === right;
    case '!=':
      return left !== right;
    case '<=':
      return Number(left) <= Number(right);
    case '>=':
      return Number(left) >= Number(right);
    case '<':
      return Number(left) < Number(right);
    default:
      return Number(left) > Number(right);
  }
}

function runApprovalSql(
  rawSql: string,
  params: readonly unknown[],
): { rows: Row[]; rowsAffected?: number } | null {
  const flat = rawSql.replace(/\s+/g, ' ').trim();
  if (/^INSERT INTO revoked_machine_peers\b/i.test(flat)) {
    const peerId = String(params[0]);
    const added = !revokedPeers.has(peerId);
    revokedPeers.add(peerId);
    return { rows: [], rowsAffected: added ? 1 : 0 };
  }
  if (!/\bapprovals\b/i.test(flat)) return null;
  if (/^CREATE TABLE/i.test(flat)) return { rows: [] };
  const sql = bind(flat);

  // Two shapes: the plain VALUES insert, and the guarded
  // `SELECT <values> WHERE (SELECT COUNT(*) FROM approvals WHERE <cond>) < N`.
  // The guard is EVALUATED (the condition against every stored row, the cap
  // literal read off the statement), so a stripped condition or a changed
  // number changes what the model admits.
  const insert =
    /^INSERT INTO approvals \(([^)]*)\) (?:VALUES \((.*)\)|SELECT (.*?) WHERE \(SELECT COUNT\(\*\) FROM approvals WHERE (.*)\) < (\d+)(?: AND NOT EXISTS \( SELECT 1 FROM revoked_machine_peers WHERE peerId = (§\d+§) \))?) ON CONFLICT\(([^)]*)\) DO NOTHING$/i.exec(
      sql,
    );
  if (insert) {
    const cols = insert[1]!.split(',').map(x => x.trim());
    const valueList = insert[2] ?? insert[3]!;
    if (insert[4] !== undefined) {
      const live = table.filter(row => evalCond(insert[4]!, row, params)).length;
      if (!(live < Number(insert[5]))) return { rows: [], rowsAffected: 0 };
    }
    if (
      insert[6] !== undefined &&
      revokedPeers.has(String(evalExpr(insert[6], null, params)))
    ) {
      return { rows: [], rowsAffected: 0 };
    }
    const values = splitTop(valueList, ',').map(v => evalExpr(v, null, params));
    if (cols.length !== values.length) {
      throw new Error('approvals model: column/value count mismatch');
    }
    const row: Row = {};
    cols.forEach((col, i) => {
      row[col] = values[i] === undefined ? null : values[i]!;
    });
    const target = insert[7]!.split(',').map(x => x.trim());
    const clash = table.some(r => target.every(col => r[col] === row[col]));
    // DO NOTHING is the single-use rule at rest: the model inserts ONLY
    // when the conflict target finds no existing row.
    if (!clash) table.push(row);
    return { rows: [], rowsAffected: clash ? 0 : 1 };
  }

  const update = /^UPDATE approvals SET (.*?) WHERE (.*)$/i.exec(sql);
  if (update) {
    const assignments = splitTop(update[1]!, ',').map(a => {
      const eq = a.indexOf('=');
      return { col: a.slice(0, eq).trim(), expr: a.slice(eq + 1).trim() };
    });
    let affected = 0;
    for (const row of table) {
      if (!evalCond(update[2]!, row, params)) continue;
      // Evaluate every RHS against the row's PRE-update image, as one SQL
      // statement does, then apply.
      const next = assignments.map(a => ({
        col: a.col,
        value: evalExpr(a.expr, row, params),
      }));
      for (const { col, value } of next) row[col] = value;
      affected++;
    }
    return { rows: [], rowsAffected: affected };
  }

  const del = /^DELETE FROM approvals WHERE (.*)$/i.exec(sql);
  if (del) {
    const before = table.length;
    table = table.filter(row => !evalCond(del[1]!, row, params));
    return { rows: [], rowsAffected: before - table.length };
  }

  const select = /^SELECT (.*?) FROM approvals WHERE (.*?)(?: ORDER BY (.*))?$/i.exec(
    sql,
  );
  if (select) {
    const matched = table.filter(row => evalCond(select[2]!, row, params));
    // Materialise the SELECT's OWN projection: a column the INSERT never
    // named answers NULL, as SQLite does — and a column missing from the
    // projection goes missing here too (the CHAT_COLUMNS lesson: explicit,
    // not SELECT *).
    const projection = select[1]!.split(',').map(x => x.trim());
    if (select[3]) {
      const terms = splitTop(select[3]!, ',').map(term => {
        const m = /^(\w+)(?: (ASC|DESC))?$/i.exec(term.trim());
        if (!m) throw new Error(`approvals model cannot order by: ${term}`);
        return { col: m[1]!, dir: (m[2] ?? 'ASC').toUpperCase() };
      });
      matched.sort((a, b) => {
        for (const { col, dir } of terms) {
          const x = a[col];
          const y = b[col];
          if (x === y) continue;
          const cmp = (x ?? 0) < (y ?? 0) ? -1 : 1;
          return dir === 'ASC' ? cmp : -cmp;
        }
        return 0;
      });
    }
    return {
      rows: matched.map(r => {
        const out: Row = {};
        for (const col of projection) out[col] = r[col] ?? null;
        return out;
      }),
    };
  }

  throw new Error(`approvals model does not recognise: ${flat}`);
}

beforeEach(async () => {
  await db.close();
  sqlite.reset();
  table = [];
  revokedPeers = new Set();
  db.setWorkspace('real');
  await db.initDb();
  const instance = sqlite.instances.get(REAL)!;
  const base = instance.execute.getMockImplementation()!;
  instance.execute.mockImplementation((sql: string, params?: unknown[]) => {
    const handled = runApprovalSql(String(sql), params ?? []);
    return handled ?? base(sql, params);
  });
});

afterEach(async () => {
  await db.close();
});

const ASK = {
  peerId: PEER,
  q: Q,
  wireMsgId: '01APPROVALFRAME00000000A01',
  kind: 'exec' as const,
  payload: 'npm test -- --watch=false\ncwd: /Users/op/tacendum',
  ttlSec: 600,
  sessionTag: 's-7c2e',
  verbs: ['approve', 'deny'],
  ts: T0,
  arrivedAt: T0,
};
const DEADLINE = T0 + 600 * 1000;

describe('insert — single-use under (peerId, q)', () => {
  test('a stored request reads back whole, verbs and kind intact', async () => {
    await db.insertApproval(ASK);
    const rows = await db.listApprovals(PEER, T0 + 1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      peerId: PEER,
      q: Q,
      wireMsgId: ASK.wireMsgId,
      kind: 'exec',
      payload: ASK.payload,
      ttlSec: 600,
      sessionTag: 's-7c2e',
      verbs: ['approve', 'deny'],
      ts: T0,
      arrivedAt: T0,
      state: 'pending',
      answerVerb: null,
    });
  });

  test('payloadBytes counts UTF-8 bytes, not UTF-16 units', async () => {
    // 'é' is 2 bytes, '€' is 3, '🙂' is 4 (one astral code point, two UTF-16
    // units) — 1 + 2 + 3 + 4 = 10.
    await db.insertApproval({ ...ASK, payload: 'aé€🙂' });
    const rows = await db.listApprovals(PEER, T0 + 1);
    expect(rows[0]!.payloadBytes).toBe(10);
  });

  test('a second frame re-binding a known q changes NOTHING — the id is single-use', async () => {
    await db.insertApproval(ASK);
    await db.insertApproval({
      ...ASK,
      payload: 'rm -rf / --no-preserve-root',
      wireMsgId: '01APPROVALFRAME00000000EVIL',
      ttlSec: 3600,
    });
    const rows = await db.listApprovals(PEER, T0 + 1);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload).toBe(ASK.payload);
    expect(rows[0]!.wireMsgId).toBe(ASK.wireMsgId);
  });

  test('the peer scope is IN the key: the same q from another conversation is its own row', async () => {
    await db.insertApproval(ASK);
    await db.insertApproval({ ...ASK, peerId: OTHER_PEER, payload: 'other' });
    expect(await db.listApprovals(PEER, T0 + 1)).toHaveLength(1);
    expect(await db.listApprovals(OTHER_PEER, T0 + 1)).toHaveLength(1);
    expect((await db.listApprovals(PEER, T0 + 1))[0]!.payload).toBe(ASK.payload);
  });

  test('a successfully revoked machine rejects late and replayed approval inserts', async () => {
    await db.insertApproval(ASK);
    await db.recordMachineRevoked(PEER, T0 + 1);

    expect(await db.listApprovals(PEER, T0 + 2)).toHaveLength(0);
    expect(
      await db.insertApproval({ ...ASK, q: Q2, arrivedAt: T0 + 3, ts: T0 + 3 }),
    ).toBe(false);
    expect(await db.listApprovals(PEER, T0 + 4)).toHaveLength(0);
  });
});

describe('settlement — conditional on pending, inside the deadline', () => {
  test('the first answer settles; the second changes nothing (double-answer, refused at the store)', async () => {
    await db.insertApproval(ASK);
    expect(await db.settleApproval(PEER, Q, 'approve', T0 + 5_000)).toBe(true);
    // The double-tap's second landing — and a later contradictory verb.
    expect(await db.settleApproval(PEER, Q, 'approve', T0 + 6_000)).toBe(false);
    expect(await db.settleApproval(PEER, Q, 'deny', T0 + 7_000)).toBe(false);
    const rows = await db.listApprovals(PEER, T0 + 8_000);
    expect(rows[0]).toMatchObject({
      state: 'answered',
      answerVerb: 'approve',
      settledAt: T0 + 5_000,
    });
  });

  test('an answer past the local deadline is refused at the store even if the caller missed it', async () => {
    await db.insertApproval(ASK);
    expect(await db.settleApproval(PEER, Q, 'approve', DEADLINE)).toBe(false);
    expect(await db.settleApproval(PEER, Q, 'approve', DEADLINE + 1)).toBe(false);
    const rows = await db.listApprovals(PEER, DEADLINE - 1);
    expect(rows[0]!.state).toBe('pending');
    expect(rows[0]!.answerVerb).toBeNull();
  });

  test('one second inside the deadline still settles — the boundary is >, not >=', async () => {
    await db.insertApproval(ASK);
    expect(await db.settleApproval(PEER, Q, 'deny', DEADLINE - 1)).toBe(true);
  });

  test('a recorded lapse burns the id: no answer lands after it', async () => {
    await db.insertApproval(ASK);
    expect(await db.lapseApproval(PEER, Q)).toBe(true);
    expect(await db.settleApproval(PEER, Q, 'approve', T0 + 1_000)).toBe(false);
    const rows = await db.listApprovals(PEER, T0 + 2_000);
    // Settled at the DEADLINE, not at the moment someone noticed.
    expect(rows[0]).toMatchObject({ state: 'lapsed', settledAt: DEADLINE });
  });
});

describe('read-time maintenance — the moving clock', () => {
  test('a pending row past its deadline reads back lapsed, settled at the deadline', async () => {
    await db.insertApproval(ASK);
    // One millisecond inside: still pending.
    expect((await db.listApprovals(PEER, DEADLINE - 1))[0]!.state).toBe('pending');
    // At the deadline: lapsed, and settledAt is the deadline itself.
    const rows = await db.listApprovals(PEER, DEADLINE);
    expect(rows[0]).toMatchObject({ state: 'lapsed', settledAt: DEADLINE });
  });

  test('a settled payload survives until APPROVAL_REDACT_AFTER_MS and not past it — the byte count stays', async () => {
    await db.insertApproval(ASK);
    await db.settleApproval(PEER, Q, 'approve', T0 + 5_000);
    const settledAt = T0 + 5_000;
    const beforeCut = await db.listApprovals(
      PEER,
      settledAt + db.APPROVAL_REDACT_AFTER_MS - 1,
    );
    expect(beforeCut[0]!.payload).toBe(ASK.payload);
    const afterCut = await db.listApprovals(
      PEER,
      settledAt + db.APPROVAL_REDACT_AFTER_MS,
    );
    expect(afterCut[0]!.payload).toBe('');
    // The receipt keeps its honest count — 49, the same number the fixture's
    // answer case carries as `n`; the bytes themselves are gone.
    expect(afterCut[0]!.payloadBytes).toBe(49);
    expect(afterCut[0]!.state).toBe('answered');
  });

  test('a PENDING payload is never redacted — the card must keep showing what approval would run', async () => {
    await db.insertApproval({ ...ASK, ttlSec: 3600 });
    const rows = await db.listApprovals(
      PEER,
      T0 + db.APPROVAL_REDACT_AFTER_MS,
    );
    // 24h < the hour ceiling can't happen on real TTLs — but the clause
    // under test is `state != 'pending'`, so the model must show a pending
    // row keeping its payload while the clock alone would have cut it.
    // (ttlSec 3600 lapses at T0+1h; redaction fires from settledAt, which a
    // lapse sets to the deadline — assert on the lapsed row's payload
    // surviving until deadline + 24h.)
    expect(rows[0]!.payload).toBe(ASK.payload);
    const lapsedDeadline = T0 + 3600 * 1000;
    const kept = await db.listApprovals(
      PEER,
      lapsedDeadline + db.APPROVAL_REDACT_AFTER_MS - 1,
    );
    expect(kept[0]!.payload).toBe(ASK.payload);
    const cut = await db.listApprovals(
      PEER,
      lapsedDeadline + db.APPROVAL_REDACT_AFTER_MS,
    );
    expect(cut[0]!.payload).toBe('');
  });

  test('a record older than APPROVAL_RETAIN_MS is gone entirely', async () => {
    await db.insertApproval(ASK);
    await db.settleApproval(PEER, Q, 'deny', T0 + 5_000);
    const settledAt = T0 + 5_000;
    expect(
      await db.listApprovals(PEER, settledAt + db.APPROVAL_RETAIN_MS - 1),
    ).toHaveLength(1);
    expect(
      await db.listApprovals(PEER, settledAt + db.APPROVAL_RETAIN_MS),
    ).toHaveLength(0);
  });

  test('rows come back oldest first by frame ts', async () => {
    await db.insertApproval({ ...ASK, q: Q2, ts: T0 + 60_000, arrivedAt: T0 + 60_000 });
    await db.insertApproval(ASK);
    const rows = await db.listApprovals(PEER, T0 + 61_000);
    expect(rows.map(r => r.q)).toEqual([Q, Q2]);
  });

  test('a verbs cell this build cannot read renders no buttons, never a crash', async () => {
    await db.insertApproval(ASK);
    // Simulate a corrupted / future-shaped cell on disk.
    table[0]!.verbs = 'not json';
    const rows = await db.listApprovals(PEER, T0 + 1);
    expect(rows[0]!.verbs).toEqual([]);
  });

  test('an unknown kind on disk coerces to the generic label family', async () => {
    await db.insertApproval(ASK);
    table[0]!.kind = 'network';
    const rows = await db.listApprovals(PEER, T0 + 1);
    expect(rows[0]!.kind).toBe('other');
  });
});

describe('the wipe list', () => {
  test('approvals is in DB_TABLES — sign-out wipes it and the decoy never inherits a machine\'s command lines', () => {
    expect(db.DB_TABLES).toContain('approvals');
  });
});

describe('the live-pending cap', () => {
  const q = (n: number) => `01J8MEAPPR0VAQ4X2C6TK${String(n).padStart(5, '0')}`;

  async function askUpToCap(arrivedAt = T0): Promise<void> {
    for (let n = 1; n <= db.PENDING_APPROVALS_PER_PEER_CAP; n++) {
      expect(await db.insertApproval({ ...ASK, q: q(n), ts: arrivedAt, arrivedAt })).toBe(true);
    }
    expect(table.filter(r => r.peerId === PEER)).toHaveLength(db.PENDING_APPROVALS_PER_PEER_CAP);
  }

  test('the next ask past the cap is refused — false back, no row, the frame still acked by the caller', async () => {
    await askUpToCap();
    expect(await db.insertApproval({ ...ASK, q: q(999) })).toBe(false);
    expect(table.filter(r => r.peerId === PEER)).toHaveLength(db.PENDING_APPROVALS_PER_PEER_CAP);
    // A replay of a stored id is still the DO NOTHING it was, not a refusal
    // that reads differently.
    expect(await db.insertApproval({ ...ASK, q: q(1) })).toBe(false);
  });

  test('an ask past its own deadline stops counting BEFORE any read marks it lapsed', async () => {
    await askUpToCap();
    // Nobody opened the thread: every row still says 'pending' on disk…
    expect(table.every(r => r.state === 'pending')).toBe(true);
    // …but the machine's next ask, arriving after those deadlines, is live
    // against zero live rows.
    const later = DEADLINE + 1;
    expect(await db.insertApproval({ ...ASK, q: q(999), ts: later, arrivedAt: later })).toBe(true);
  });

  test('a settled ask stops counting', async () => {
    await askUpToCap();
    expect(await db.settleApproval(PEER, q(1), 'approve', T0 + 5_000)).toBe(true);
    expect(await db.insertApproval({ ...ASK, q: q(999), ts: T0 + 6_000, arrivedAt: T0 + 6_000 })).toBe(true);
  });

  test('the cap is per conversation: another machine’s asks are its own', async () => {
    await askUpToCap();
    expect(await db.insertApproval({ ...ASK, peerId: OTHER_PEER, q: q(999) })).toBe(true);
  });

  test('the retention rule runs from the sweep too — a thread never opened does not keep command lines', async () => {
    expect(await db.insertApproval(ASK)).toBe(true);
    // One millisecond short: kept, whether or not anyone reads the thread.
    await db.sweepExpired(T0 + db.APPROVAL_RETAIN_MS - 1);
    expect(table).toHaveLength(1);
    await db.sweepExpired(T0 + db.APPROVAL_RETAIN_MS);
    expect(table).toHaveLength(0);
  });
});
