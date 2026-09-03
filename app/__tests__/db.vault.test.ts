/**
 * SHARED ROOM VAULT — the store half.
 *
 * WHAT WAS WRONG WITH THE FIRST ANSWER. A vault item has two writers, so the
 * first design gave the shared row a total order — a sender wall clock `v`,
 * bumped `max(now, current + 1)`, tied on the stored writer id — and this file
 * used to prove that the order was total. It was. It was also wrong three
 * separate ways, all of them silent, and all three were invisible to a test
 * that only asked "do both phones pick the same winner?":
 *
 *  1. STICKY CLAMP. A wall clock in the ordering makes the peer's clock a
 *     correctness input, so it needed a future clamp, and the clamp DROPPED the
 *     frame AND ACKED IT — purging the server's copy and spending the ratchet
 *     key. An honest restore-from-backup with a wrong date silenced an item
 *     forever, and `max(now, current + 1)` then carried the poisoned number
 *     into every later edit of that item.
 *  2. THE KEY DID NOT DETERMINE THE VALUE. `max(now, current + 1)` saturates on
 *     `current + 1` in the steady state, so same-version collisions were the
 *     NORMAL case, not the rare one — and because the version was read early
 *     and written late with an `await` in between, two overlapping saves put
 *     two different bodies under one identical key.
 *  3. IDENTITY BIAS. The tiebreak compared account ids, so the same person lost
 *     every tie, forever, and was never told.
 *
 * WHAT REPLACED IT. One row per (item, WRITER) — a slot. A writer's own writes
 * are totally ordered by a counter only that writer allocates, in ONE atomic
 * statement, so within a slot a tie is not rare, it is IMPOSSIBLE. The merge is
 * `max` over one integer with no tiebreak at all, which makes it a lattice
 * join: commutative, associative, idempotent, and therefore immune to delivery
 * order, duplication and both wall clocks. Cross-slot ordering is carried by
 * `ackSeq` — "I had already seen your write number k" — which is causality
 * rather than recency, the one thing a clock cannot express.
 *
 * THE TESTS THAT MATTER HERE are `convergence` (the same cross-apply as before,
 * now over slots) and `allocation` (the atomic counter, which is defect 2 at
 * its root). Everything else is table hygiene.
 *
 * HARNESS. Two phones are modelled inside one connection by using the peer id
 * as the phone: Alice's rows for this item are (peerId = BOB, id, *), Bob's are
 * (peerId = ALICE, id, *). That is exactly how the shipping code keys it — the
 * conversation IS the scope — so the two views are as independent here as they
 * are on two devices.
 *
 * The model (below) reads the clauses each statement actually carries rather
 * than assuming the implementation, copying db.blocking.test.ts. That is what
 * makes the non-vacuity checks real: strip a clause from the SQL and the
 * model's behaviour changes with it.
 */
import * as db from '../src/db';
import {
  EnvelopeRefusedError,
  VAULT_ACK_TRUST_MAX,
  VAULT_BODY_MAX,
  encodeEnvelope,
  parseEnvelope,
  type VaultEnvelope,
} from '../src/envelope';

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

/** Two accounts. ALICE sorts below BOB, which used to decide every tie and now
 * decides nothing — that change is asserted directly below. */
const ALICE = '01AAAAZ3NDEKTSV4RRFFQ69G5F';
const BOB = '01BBBBZ3NDEKTSV4RRFFQ69G5F';
const ITEM = '01WFXZ3NDEKTSV4RRFFQ69G5AB';
const OTHER_ITEM = '02WFXZ3NDEKTSV4RRFFQ69G5AB';
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

type Row = db.VaultSlotRow;

type Cell = string | number;

/**
 * THE MODEL INTERPRETS THE SQL. It does not reproduce it.
 *
 * The first version of this model recognised each statement by a regex and then
 * destructured `params` POSITIONALLY, hardcoding the literals in every `VALUES`
 * clause. That made a whole class of defect unfalsifiable, and a mutation run
 * proved it: swapping `title` and `body` in the merge's column list (every
 * credential stored into the label and every label into the credential),
 * deleting `body = excluded.body` from the upsert (a merged frame that keeps
 * the OLD secret forever), widening `ON CONFLICT(peerId, id, writerId)` back to
 * `(peerId, id)` (the shared row this whole amendment exists to remove), and
 * flipping the reservation's `deleted` literal from 1 to 0 (every abandoned
 * reservation showing as a live blank item — against a test whose name is "a
 * reservation shows nothing until its content is committed") ALL left the suite
 * 100% green. The model had never read the column list, the conflict target,
 * the `DO UPDATE SET` list, or any literal.
 *
 * So the parser below reads them:
 *
 *  - the column list is zipped against the VALUES list, so a swapped column
 *    swaps the stored values;
 *  - value expressions are EVALUATED (`?`, integer and `''` literals, `? + 1`,
 *    `vault_items.seq + 1`, `MAX(a, b)`, `excluded.<col>`), so a changed
 *    literal or a changed increment changes what lands;
 *  - the row key is built from the ON CONFLICT TARGET, so widening the target
 *    really does collapse two writers onto one row;
 *  - `DO UPDATE SET` is applied assignment by assignment, so a dropped one
 *    really does leave the old value behind;
 *  - `?` is consumed by ONE left-to-right cursor across the whole statement,
 *    which is what the driver does.
 *
 * `strip` rewrites the SQL before the model reads it, standing in for a build
 * of db.ts with that clause missing. `legacyColumns` stands in for a file on
 * disk carrying the pre-amendment table shape.
 */

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

/** The value expressions db.ts's vault statements actually use, evaluated.
 * Anything else throws rather than guessing — a model that silently coped with
 * an expression it did not understand would be back to asserting against
 * itself. */
function evalExpr(
  expr: string,
  next: () => unknown,
  current: Partial<Row> | undefined,
  excluded: Partial<Row> | undefined,
): Cell {
  const s = expr.trim().replace(/^\((.*)\)$/s, '$1').trim();
  // Rightmost top-level +/- first, so `a + b + c` associates left as SQL does.
  let depth = 0;
  for (let i = s.length - 1; i > 0; i--) {
    if (s[i] === ')') depth++;
    else if (s[i] === '(') depth--;
    else if ((s[i] === '+' || s[i] === '-') && depth === 0) {
      const left = Number(evalExpr(s.slice(0, i), next, current, excluded));
      const right = Number(evalExpr(s.slice(i + 1), next, current, excluded));
      return s[i] === '+' ? left + right : left - right;
    }
  }
  const fn = /^(MAX|MIN)\((.*)\)$/is.exec(s);
  if (fn) {
    const args = splitArgs(fn[2]).map(a =>
      Number(evalExpr(a, next, current, excluded)),
    );
    return fn[1].toUpperCase() === 'MAX' ? Math.max(...args) : Math.min(...args);
  }
  if (s === '?') return next() as Cell;
  if (/^-?\d+$/.test(s)) return Number(s);
  const literal = /^'(.*)'$/s.exec(s);
  if (literal) return literal[1];
  const qualified = /^(excluded|vault_items)\.(\w+)$/i.exec(s);
  if (qualified) {
    const from = qualified[1].toLowerCase() === 'excluded' ? excluded : current;
    return (from as Record<string, Cell> | undefined)?.[qualified[2]] ?? 0;
  }
  if (/^\w+$/.test(s)) {
    return (current as Record<string, Cell> | undefined)?.[s] ?? 0;
  }
  throw new Error(`model cannot evaluate SQL expression: ${expr}`);
}

/** `a = ?, b = excluded.b` -> the columns it names, evaluated left to right. */
function evalAssignments(
  clause: string,
  next: () => unknown,
  current: Partial<Row> | undefined,
  excluded: Partial<Row> | undefined,
): Record<string, Cell> {
  const out: Record<string, Cell> = {};
  for (const part of splitArgs(clause)) {
    const eq = part.indexOf('=');
    out[part.slice(0, eq).trim()] = evalExpr(
      part.slice(eq + 1),
      next,
      current,
      excluded,
    );
  }
  return out;
}

/** `x = ? AND excluded.seq > vault_items.seq`, evaluated left to right. */
function evalWhere(
  clause: string | null,
  next: () => unknown,
  current: Partial<Row> | undefined,
  excluded: Partial<Row> | undefined,
): boolean {
  if (!clause) return true;
  return clause
    .split(/\bAND\b/i)
    .map(c => c.trim())
    .filter(Boolean)
    .every(term => {
      const m = /^(.*?)(>=|<=|<>|!=|>|<|=)(.*)$/s.exec(term);
      if (!m) throw new Error(`model cannot evaluate SQL condition: ${term}`);
      const left = evalExpr(m[1], next, current, excluded);
      const right = evalExpr(m[3], next, current, excluded);
      switch (m[2]) {
        case '>':
          return Number(left) > Number(right);
        case '<':
          return Number(left) < Number(right);
        case '>=':
          return Number(left) >= Number(right);
        case '<=':
          return Number(left) <= Number(right);
        case '<>':
        case '!=':
          return left !== right;
        default:
          return left === right;
      }
    });
}

function installVaultModel(name = REAL) {
  const rows = new Map<string, Row>();
  const strip = { pattern: null as RegExp | null };
  /** Rows sweepExpired should consider doomed, so the sweep gets past its
   * early return and its full statement list can be inspected. */
  const doomed = { msgIds: [] as string[] };
  /** What PRAGMA table_info(vault_items) answers. Empty = a table that was only
   * just created (or cannot be read), which is what a fresh file looks like and
   * what must NOT trigger a rebuild. */
  const legacyColumns = { names: [] as string[] };
  const key = (peerId: string, id: string, writerId: string) =>
    `${writerId}|${peerId}|${id}`;
  /** The row key built from whatever columns the statement's ON CONFLICT TARGET
   * actually names — so widening the target really does make two writers
   * collide on one row, exactly as it would on a device. */
  const keyOfTarget = (row: Partial<Row>, target: string[]) =>
    target.map(c => String((row as Record<string, unknown>)[c] ?? '')).join('|');
  const findByTarget = (row: Partial<Row>, target: string[]) => {
    const want = keyOfTarget(row, target);
    for (const [k, existing] of rows) {
      if (keyOfTarget(existing, target) === want) return { k, existing };
    }
    return null;
  };
  const instance = sqlite.instances.get(name)!;
  let snapshot: Map<string, Row> | null = null;
  instance.execute.mockImplementation(
    async (rawSql: string, params: unknown[] = []) => {
      let s = String(rawSql);
      if (strip.pattern) s = s.replace(strip.pattern, '');
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
      if (s.includes('PRAGMA table_info(vault_items')) {
        return { rows: legacyColumns.names.map(column => ({ name: column })) };
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
      if (/SELECT msgId FROM messages WHERE expiresAt/.test(s)) {
        return { rows: doomed.msgIds.map(msgId => ({ msgId })) };
      }
      if (!s.includes('vault_items')) return { rows: [] };

      // --- the merge's creation cap, read off the guard ----------
      // `mergeVaultSlot` carries its bound INSIDE the statement: `SELECT
      // <values> WHERE (<this writer's slot count> < N OR <this slot
      // exists>)`. The model evaluates exactly that guard — the cap literal
      // is read from the SQL, so a changed number changes what the model
      // admits — and then hands the statement on in its VALUES shape, so the
      // column list, conflict target and merge WHERE are read as before.
      let effectiveParams = params;
      const guarded =
        /^INSERT INTO vault_items\s*\(([^)]*)\)\s*SELECT\s+([\s\S]*?)\s+WHERE\s+\(\(SELECT COUNT\(\*\) FROM vault_items WHERE peerId = \? AND writerId = \?\) < (\d+)\s+OR EXISTS \(SELECT 1 FROM vault_items WHERE peerId = \? AND id = \? AND writerId = \?\)\)\s*(ON CONFLICT[\s\S]*)$/i.exec(
          s.trim(),
        );
      if (guarded) {
        const [, columnList, valueList, capLiteral, tail] = guarded;
        const nValues = (valueList.match(/\?/g) ?? []).length;
        const [gPeer, gWriter, ePeer, eId, eWriter] = params.slice(nValues, nValues + 5) as string[];
        const held = [...rows.values()].filter(
          r => r.peerId === gPeer && r.writerId === gWriter,
        ).length;
        const exists = rows.has(key(ePeer, eId, eWriter));
        if (!(held < Number(capLiteral) || exists)) {
          return { rows: [], rowsAffected: 0 };
        }
        s = `INSERT INTO vault_items (${columnList}) VALUES (${valueList}) ${tail}`;
        effectiveParams = [...params.slice(0, nValues), ...params.slice(nValues + 5)];
      }

      // --- every INSERT, read from its own column list ---------------------
      // reserveVaultSeq, mergeVaultSlot and the migration's carry-over all land
      // here. Nothing about which of them it is matters: the column list, the
      // VALUES expressions, the ON CONFLICT target, the DO UPDATE SET list and
      // the merge's WHERE are all read off THIS statement.
      const insert =
        /INSERT(?: OR (\w+))? INTO vault_items\s*\(([^)]*)\)\s*VALUES\s*\(([\s\S]*?)\)\s*(?:ON CONFLICT\s*\(([^)]*)\)\s*DO UPDATE SET([\s\S]*?))?(?:\s*WHERE([\s\S]*?))?(?:\s*RETURNING\s+(\w+))?\s*$/i.exec(
          s.trim(),
        );
      if (insert) {
        const [, orClause, columnList, valueList, conflictTarget, setList, whereClause, returning] =
          insert;
        let cursor = 0;
        const next = () => effectiveParams[cursor++];
        const columns = splitArgs(columnList);
        const values = splitArgs(valueList);
        expect(values.length).toBe(columns.length); // a real driver would error
        const candidate: Partial<Row> = {};
        columns.forEach((column, i) => {
          (candidate as Record<string, Cell>)[column] = evalExpr(
            values[i],
            next,
            undefined,
            undefined,
          );
        });
        // Keyed by the CONFLICT TARGET when there is one; by the real primary
        // key otherwise, which is what SQLite would do.
        const target = conflictTarget
          ? splitArgs(conflictTarget)
          : ['peerId', 'id', 'writerId'];
        const hit = findByTarget(candidate, target);
        if (!hit) {
          const row = candidate as Row;
          rows.set(key(row.peerId, row.id, row.writerId), row);
          return {
            rows: returning
              ? [{ [returning]: (row as unknown as Record<string, Cell>)[returning] }]
              : [],
            rowsAffected: 1,
          };
        }
        if (!setList) {
          // INSERT OR IGNORE with no upsert clause: the existing row stands.
          expect(orClause?.toUpperCase()).toBe('IGNORE');
          return {
            rows: returning
              ? [{ [returning]: (hit.existing as unknown as Record<string, Cell>)[returning] }]
              : [],
            rowsAffected: 0,
          };
        }
        const updates = evalAssignments(setList, next, hit.existing, candidate);
        const wins = evalWhere(whereClause ?? null, next, hit.existing, candidate);
        if (wins) Object.assign(hit.existing, updates);
        return {
          rows: returning
            ? [{ [returning]: (hit.existing as unknown as Record<string, Cell>)[returning] }]
            : [],
          rowsAffected: wins ? 1 : 0,
        };
      }
      // --- every UPDATE, read from its own SET and WHERE --------------------
      // releaseVaultSeq, blankSupersededSlots and commitVaultSlot. The `seq = ?`
      // guards that make an overtaken save a no-op are read off the statement
      // rather than assumed, so deleting one really does change what happens.
      const update =
        /UPDATE vault_items\s+SET([\s\S]*?)\s+WHERE([\s\S]*?)$/i.exec(s.trim());
      if (update) {
        let cursor = 0;
        const next = () => params[cursor++];
        // SET is evaluated against a placeholder so its `?`s are consumed in
        // statement order, then re-evaluated against the row that matches.
        const setClause = update[1];
        const whereClause = update[2];
        const probe = { ...([...rows.values()][0] ?? {}) } as Partial<Row>;
        const setParamCount = (() => {
          let n = 0;
          const count = () => {
            n++;
            return 0;
          };
          evalAssignments(setClause, count, probe, undefined);
          return n;
        })();
        const setParams = params.slice(0, setParamCount);
        const whereParams = params.slice(setParamCount);
        let affected = 0;
        for (const row of [...rows.values()]) {
          let wi = 0;
          if (!evalWhere(whereClause, () => whereParams[wi++], row, undefined)) {
            continue;
          }
          let si = 0;
          Object.assign(
            row,
            evalAssignments(setClause, () => setParams[si++], row, undefined),
          );
          affected++;
        }
        void next;
        return { rows: [], rowsAffected: affected };
      }
      // --- reads -----------------------------------------------------------
      if (/SELECT seq FROM vault_items WHERE/.test(s)) {
        const row = rows.get(
          key(params[0] as string, params[1] as string, params[2] as string),
        );
        return { rows: row ? [{ seq: row.seq }] : [] };
      }
      // Anchored on SELECT: `DELETE FROM vault_items WHERE peerId = ?` matches
      // the same tail, and a read branch that swallowed it would quietly turn
      // every lifecycle wipe into a no-op.
      if (/SELECT[\s\S]*FROM vault_items WHERE peerId = \? AND id = \?/.test(s)) {
        return {
          rows: [...rows.values()].filter(
            r => r.peerId === params[0] && r.id === params[1],
          ),
        };
      }
      if (/SELECT[\s\S]*FROM vault_items WHERE peerId = \?/.test(s)) {
        return { rows: [...rows.values()].filter(r => r.peerId === params[0]) };
      }
      if (/SELECT[\s\S]*FROM vault_items$/.test(s.trim())) {
        // The migration's legacy read: every row, no scope.
        return { rows: [...rows.values()] };
      }
      if (/DROP TABLE vault_items/.test(s)) {
        rows.clear();
        // A real DROP takes the old shape with it, so the CREATE that follows
        // is what the next PRAGMA sees. Modelling that is what makes the
        // rebuild terminate here as it does on a device.
        legacyColumns.names = [];
        return { rows: [], rowsAffected: 1 };
      }
      if (/DELETE FROM vault_items WHERE peerId = \?/.test(s)) {
        const peerId = params[0] as string;
        for (const [k, r] of [...rows]) if (r.peerId === peerId) rows.delete(k);
        return { rows: [], rowsAffected: 1 };
      }
      if (/DELETE FROM vault_items/.test(s)) {
        rows.clear();
        return { rows: [], rowsAffected: 1 };
      }
      return { rows: [] };
    },
  );
  return { rows, strip, doomed, legacyColumns };
}

async function init(name = REAL) {
  await db.initDb();
  return installVaultModel(name);
}

beforeEach(async () => {
  await db.close();
  sqlite.reset();
  db.setWorkspace('real');
});

afterEach(async () => {
  await db.close();
});

// ---------------------------------------------------------------------------
// 1. CONVERGENCE — the reason this plan was amended before any code was written
// ---------------------------------------------------------------------------

/** One write as it appears on the wire and in a slot. `seq` is the writer's own
 * counter for this item; `ackSeq` is what that writer had already seen of the
 * other side when they composed it. */
interface Write {
  title: string;
  body: string;
  writerId: string;
  seq: number;
  ackSeq: number;
  deleted?: number;
}

/**
 * Apply a sequence of writes on one phone. The phone is identified by the peer
 * it is talking to, because that is the scope the real key uses: on Alice's
 * device the conversation with Bob is `peerId = BOB`.
 *
 * Everything goes through `mergeVaultSlot`, including a phone's own writes: the
 * merge is a join, so applying my own frame and applying theirs are the same
 * operation and the same code path.
 */
async function applyOn(
  phoneTalkingTo: string,
  id: string,
  writes: Write[],
): Promise<db.VaultItemRow | null> {
  for (const w of writes) {
    await db.mergeVaultSlot({
      peerId: phoneTalkingTo,
      id,
      writerId: w.writerId,
      seq: w.seq,
      ackSeq: w.ackSeq,
      title: w.title,
      body: w.body,
      updatedAt: AT,
      deleted: w.deleted ?? 0,
    });
  }
  return db.getVaultItem(phoneTalkingTo, id);
}

/** What both phones must agree on. `peerId` differs by construction (each
 * phone names the other), so it is not part of the comparison. */
function view(row: db.VaultItemRow | null) {
  return row === null
    ? null
    : {
        title: row.title,
        body: row.body,
        seq: row.seq,
        ackSeq: row.ackSeq,
        writerId: row.writerId,
        deleted: row.deleted,
        contested: row.contested,
      };
}

/** The whole slot table for one item on one phone, in a stable order — the
 * strongest statement of convergence available, because it compares the STATE
 * rather than the rendered value. */
async function slotsOn(phoneTalkingTo: string, id: string) {
  return (await db.listVaultSlots(phoneTalkingTo, id))
    .map(s => ({
      writerId: s.writerId,
      seq: s.seq,
      ackSeq: s.ackSeq,
      title: s.title,
      body: s.body,
      deleted: s.deleted,
    }))
    .sort((a, b) => (a.writerId < b.writerId ? -1 : 1));
}

describe('two writers converge', () => {
  /** The exact collision, in the new vocabulary: both phones
   * hold Alice's write #1, and both people then edit without seeing the other.
   * Alice's second write acknowledges nothing of Bob's (`ackSeq: 0`), Bob's
   * first acknowledges Alice's #1 — no, deliberately NOT: this pair is
   * concurrent, so neither acknowledges the other. Nothing about arrival order
   * may decide the outcome. */
  const ALICE_EDIT: Write = {
    title: 'Front door',
    body: '4417',
    writerId: ALICE,
    seq: 2,
    ackSeq: 0,
  };
  const BOB_EDIT: Write = {
    title: 'Front door',
    body: '9903',
    writerId: BOB,
    seq: 1,
    ackSeq: 0,
  };

  it('cross-applies two concurrent edits in BOTH orders on BOTH sides and lands in ONE place', async () => {
    await init();
    // Distinct item ids so the four runs cannot contaminate each other; every
    // guard is per (peerId, id, writerId), so this is four independent
    // histories of the same pair of writes.
    const aliceOwnFirst = await applyOn(BOB, ITEM, [ALICE_EDIT, BOB_EDIT]);
    const aliceTheirsFirst = await applyOn(BOB, OTHER_ITEM, [
      BOB_EDIT,
      ALICE_EDIT,
    ]);
    const bobOwnFirst = await applyOn(ALICE, ITEM, [BOB_EDIT, ALICE_EDIT]);
    const bobTheirsFirst = await applyOn(ALICE, OTHER_ITEM, [
      ALICE_EDIT,
      BOB_EDIT,
    ]);

    const settled = view(aliceOwnFirst);
    expect(settled).not.toBeNull();
    expect(view(aliceTheirsFirst)).toEqual(settled);
    expect(view(bobOwnFirst)).toEqual(settled);
    expect(view(bobTheirsFirst)).toEqual(settled);
    // Convergence of the STATE, not just of the rendered value: both phones
    // hold both slots, byte for byte.
    expect(await slotsOn(BOB, ITEM)).toEqual(await slotsOn(ALICE, ITEM));
    expect(await slotsOn(BOB, ITEM)).toHaveLength(2);
    // Neither write saw the other, so this is a real disagreement rather than
    // an update — recorded rather than quietly thrown away.
    expect(settled?.contested).toBe(true);
  });

  it('the winner is chosen by CONTENT, so it is not the same person every time', async () => {
    // The old tiebreak compared account ids: BOB sorts above ALICE, so Bob won
    // every tie forever and Alice was never told. Comparing content instead is
    // just as deterministic on both phones and has no permanent favourite —
    // here the LOWER-id writer wins, purely because of what they typed.
    await init();
    const aliceHigherContent: Write = { ...ALICE_EDIT, body: 'zzzz' };
    const alice = await applyOn(BOB, ITEM, [aliceHigherContent, BOB_EDIT]);
    const bob = await applyOn(ALICE, ITEM, [BOB_EDIT, aliceHigherContent]);
    expect(view(alice)).toEqual(view(bob));
    expect(alice?.writerId).toBe(ALICE);
  });

  it('an edit that SAW the other one wins, and is not flagged as a disagreement', async () => {
    // The ordinary case, and the one a clock cannot tell apart from the case
    // above. Bob read Alice's #2 and then typed, so his write acknowledges it
    // and dominates it. Recency and causality look identical to a clock; only
    // the acknowledgement distinguishes them.
    await init();
    const bobSawAlice: Write = { ...BOB_EDIT, ackSeq: 2 };
    const alice = await applyOn(BOB, ITEM, [ALICE_EDIT, bobSawAlice]);
    const bob = await applyOn(ALICE, ITEM, [bobSawAlice, ALICE_EDIT]);

    expect(view(alice)).toEqual(view(bob));
    expect(alice).toMatchObject({ body: '9903', writerId: BOB, contested: false });
    // And Alice's superseded door code is not left sitting in plaintext.
    expect((await slotsOn(BOB, ITEM))[0]).toMatchObject({ title: '', body: '' });
  });

  it('NON-VACUITY: with the acknowledgement removed, the superseding edit LOSES', async () => {
    // Strip `ackSeq` out of both writes — which is exactly what a scheme with
    // no causality field (a wall clock, or a Lamport counter) can express — and
    // the pair above becomes indistinguishable from the concurrent pair. The
    // resolution then falls to the content tiebreak and picks the write that
    // was superseded, silently.
    await init();
    const blind: Write = { ...BOB_EDIT, ackSeq: 0 };
    const settled = await applyOn(BOB, ITEM, [ALICE_EDIT, blind]);
    expect(settled?.body).toBe('9903');
    expect(settled?.contested).toBe(true);
    // The tell: with the acknowledgement present it was a clean supersession;
    // without it, the same two writes read as a disagreement.
    const withAck = await applyOn(ALICE, ITEM, [
      ALICE_EDIT,
      { ...BOB_EDIT, ackSeq: 2 },
    ]);
    expect(withAck?.contested).toBe(false);
  });

  it('NON-VACUITY: without the merge guard, a replayed older frame overwrites the newer one', async () => {
    // The shipped-bug simulation for the merge itself. Strip the one clause
    // that makes it a max-register and it becomes a blind overwrite, so the
    // last frame to ARRIVE wins — which is delivery order deciding state, the
    // thing convergence forbids.
    const model = await init();
    await applyOn(BOB, ITEM, [
      { ...ALICE_EDIT, seq: 5, body: 'current' },
    ]);
    model.strip.pattern = /WHERE excluded\.seq > vault_items\.seq/;
    await applyOn(BOB, ITEM, [{ ...ALICE_EDIT, seq: 1, body: 'ancient' }]);
    expect((await db.getVaultItem(BOB, ITEM))?.body).toBe('ancient');

    // Restored, the same replay changes nothing.
    model.strip.pattern = null;
    await applyOn(BOB, OTHER_ITEM, [{ ...ALICE_EDIT, seq: 5, body: 'current' }]);
    await applyOn(BOB, OTHER_ITEM, [{ ...ALICE_EDIT, seq: 1, body: 'ancient' }]);
    expect((await db.getVaultItem(BOB, OTHER_ITEM))?.body).toBe('current');
  });

  it('a del outranks a set when the two are concurrent, whichever arrives first', async () => {
    // The precedent holdRevision already sets, kept: a deletion is the safer
    // loss, because an item that comes back after someone removed it is a
    // credential they believe is gone, and re-displaying a secret whose owner
    // just tried to destroy it is the worse of the two information losses.
    await init();
    const del: Write = {
      title: '',
      body: '',
      writerId: ALICE,
      seq: 2,
      ackSeq: 0,
      deleted: 1,
    };
    const setFirst = await applyOn(BOB, ITEM, [BOB_EDIT, del]);
    const delFirst = await applyOn(BOB, OTHER_ITEM, [del, BOB_EDIT]);

    expect(view(setFirst)).toEqual(view(delFirst));
    expect(setFirst?.deleted).toBe(1);
    expect(setFirst?.contested).toBe(true);
  });

  it('a deletion that SAW the edit clears the peer’s copy of the credential too', async () => {
    // A deletion has to delete on both slots or it has not deleted anything.
    await init();
    await applyOn(BOB, ITEM, [BOB_EDIT]);
    await applyOn(BOB, ITEM, [
      { title: '', body: '', writerId: ALICE, seq: 1, ackSeq: 1, deleted: 1 },
    ]);
    expect(await db.listVaultItems(BOB)).toEqual([]);
    const raw = JSON.stringify(await slotsOn(BOB, ITEM));
    expect(raw).not.toContain('9903');
  });

  it('applies in any order, any number of times, and lands in the same place', async () => {
    // The lattice property, exercised rather than asserted: a small history
    // shuffled and duplicated must always settle identically.
    await init();
    const history: Write[] = [
      { title: 'Door', body: 'a1', writerId: ALICE, seq: 1, ackSeq: 0 },
      { title: 'Door', body: 'b1', writerId: BOB, seq: 1, ackSeq: 1 },
      { title: 'Door', body: 'a2', writerId: ALICE, seq: 2, ackSeq: 1 },
      { title: 'Door', body: 'b2', writerId: BOB, seq: 2, ackSeq: 2 },
    ];
    const orders: Write[][] = [
      history,
      [...history].reverse(),
      [history[2], history[0], history[3], history[1], history[3]],
      [...history, ...history],
      [history[3], history[3], history[0], history[1], history[2]],
    ];
    const settled = await Promise.all(
      orders.map((writes, i) =>
        applyOn(BOB, `0${i}WFXZ3NDEKTSV4RRFFQ69G5A`, writes),
      ),
    );
    for (const item of settled) {
      expect(view(item)).toEqual(view(settled[0]));
    }
    expect(settled[0]).toMatchObject({ body: 'b2', contested: false });
  });
});

describe('the counter: one atomic statement, and why', () => {
  it('two overlapping saves get DIFFERENT numbers', async () => {
    // DIVERGENCE 3 at its root. The two calls are started together and awaited
    // together, exactly as two taps in quick succession would be.
    await init();
    const [first, second] = await Promise.all([
      db.reserveVaultSeq(BOB, ITEM, ALICE, AT),
      db.reserveVaultSeq(BOB, ITEM, ALICE, AT),
    ]);
    expect(new Set([first, second]).size).toBe(2);
    expect(Math.max(first, second)).toBe(2);
  });

  it('NON-VACUITY: the read-then-write allocator this replaced hands out the same number twice', async () => {
    // What `getVaultItem` -> `nextVaultVersion` -> `putVaultItem` did, with an
    // `await` (a prekey fetch) in the gap. Both saves read 0, both stamp 1, and
    // two different bodies end up under one identical ordering key.
    await init();
    const racy = async () => {
      const current = (await db.getVaultItem(BOB, OTHER_ITEM))?.seq ?? 0;
      await Promise.resolve(); // the prekey fetch
      return current + 1;
    };
    const [a, b] = await Promise.all([racy(), racy()]);
    expect(a).toBe(b);
  });

  it('a refused write gives the number back, so the vault is untouched', async () => {
    await init();
    const first = await db.reserveVaultSeq(BOB, ITEM, ALICE, AT);
    await db.releaseVaultSeq(BOB, ITEM, ALICE, first);
    expect(await db.reserveVaultSeq(BOB, ITEM, ALICE, AT)).toBe(first);
  });

  it('but not when a later save already took the next number', async () => {
    // Guarded on the number itself: releasing a stale reservation must not pull
    // the counter out from under a save that overtook it.
    await init();
    const first = await db.reserveVaultSeq(BOB, ITEM, ALICE, AT);
    const second = await db.reserveVaultSeq(BOB, ITEM, ALICE, AT);
    await db.releaseVaultSeq(BOB, ITEM, ALICE, first);
    expect(await db.reserveVaultSeq(BOB, ITEM, ALICE, AT)).toBe(second + 1);
  });

  it('a reservation shows nothing until its content is committed', async () => {
    // A refused or unencryptable write must leave the vault exactly as it was.
    await init();
    await db.reserveVaultSeq(BOB, ITEM, ALICE, AT);
    expect(await db.listVaultItems(BOB)).toEqual([]);
    // NOTHING, not "a tombstone". This assertion used to read
    // `toMatchObject({ deleted: 1 })`, and that was the bug rather than the
    // check: a reservation born a tombstone WINS a concurrency, so an
    // uncommitted placeholder outranked the peer's real value (see the
    // non-vacuity test below). It is now its own state, dropped by the
    // collapse — which is the stronger form of the sentence this test is named
    // after.
    expect(await db.getVaultItem(BOB, ITEM)).toBeNull();
    // The ROW is still there and still holds the counter — a reservation must
    // be invisible, not absent, or the number it is holding is lost.
    const [slot] = await db.listVaultSlots(BOB, ITEM);
    expect(slot).toMatchObject({ seq: 1, title: '', body: '' });
    // And it acknowledges NOTHING. A slot born with a non-zero ackSeq would
    // claim to have seen writes of theirs that never reached this phone, which
    // is the same suppression the inbound clamp exists to stop — only
    // self-inflicted, and reaching every item rather than one.
    expect(slot.ackSeq).toBe(0);
    // Not 0 and not 1: neither a live value nor a deletion.
    expect(slot.deleted).not.toBe(0);
    expect(slot.deleted).not.toBe(1);
  });

  it('NON-VACUITY: a reservation that acknowledged their writes would bury them', async () => {
    // Why the literal above is load-bearing rather than tidy. Their real write
    // arrives; my slot is a bare reservation with no content at all. If that
    // reservation claimed to have seen it, my empty tombstone would strictly
    // dominate their value and blank it — an item deleted by a write that was
    // never made.
    await init();
    await db.mergeVaultSlot({
      peerId: BOB,
      id: ITEM,
      writerId: BOB,
      seq: 3,
      ackSeq: 0,
      title: 'Door',
      body: '4417',
      updatedAt: AT,
      deleted: 0,
    });
    await db.reserveVaultSeq(BOB, ITEM, ALICE, AT);
    expect((await db.getVaultItem(BOB, ITEM))?.body).toBe('4417');
  });

  it('a purged slot restarts ABOVE what the peer still holds, not at 1', async () => {
    // THE COUNTER-REGRESSION REPAIR. `deleteChat` purges vault_items for that
    // peer and tells the peer nothing (a credential must not outlive the
    // conversation), so my counter restarts while their copy of my slot stays
    // where it was. Restarting at 1 under a peer holding 7 means the merge's
    // one-way ratchet discards my next seven frames with no error, no row and
    // no retry: I see the new door code and believe it is shared, they keep the
    // old one forever.
    //
    // The floor is the number they last told me they had seen of mine.
    await init();
    expect(await db.reserveVaultSeq(BOB, ITEM, ALICE, AT, 7)).toBe(8);
    // And it keeps counting from there, so nothing is special about the repair.
    expect(await db.reserveVaultSeq(BOB, ITEM, ALICE, AT, 7)).toBe(9);
  });

  it('the floor only ever RAISES: a stale one cannot pull the counter back', async () => {
    // NON-VACUITY for the line above, and the safety argument for honouring an
    // unverifiable number at all. A floor can only push my next write higher —
    // it can never suppress anything, and gaps are legal and unobservable.
    await init();
    await db.reserveVaultSeq(BOB, ITEM, ALICE, AT, 20);
    expect(await db.reserveVaultSeq(BOB, ITEM, ALICE, AT, 3)).toBe(22);
  });

  it('REFUSES rather than guesses when the allocation returns nothing', async () => {
    // The fallback that used to sit here re-read the row and returned whatever
    // it found. The increment is still atomic, but two overlapping saves then
    // both read the POST-increment value and get the SAME number — two
    // different bodies under one identical ordering key, which is DIVERGENCE 3
    // verbatim, reintroduced by the fallback meant to be harmless. Reusing a
    // number is the one thing this design cannot tolerate, so a driver that
    // drops RETURNING rows has to break the write loudly.
    const model = await init();
    const instance = sqlite.instances.get(REAL)!;
    const real = instance.execute.getMockImplementation()!;
    instance.execute.mockImplementation(async (sql: string, params?: unknown) => {
      const res = await real(sql, params);
      if (/RETURNING seq/.test(String(sql))) return { ...res, rows: [] };
      return res;
    });
    await expect(db.reserveVaultSeq(BOB, ITEM, ALICE, AT)).rejects.toThrow(
      /counter could not be allocated/,
    );
    // And it never falls back to a read that could hand out a duplicate.
    expect(
      statements().filter(s => /SELECT seq FROM vault_items/.test(s)),
    ).toEqual([]);
    void model;
  });

  it('an overtaken commit is a no-op, so the number always describes its own content', async () => {
    // The other half of the reservation fix. Save #1 reserves 1, save #2 reserves 2 and
    // commits; save #1's commit then arrives late. If it landed, this phone
    // would hold save #1's body while the peer — who merges by number — holds
    // save #2's.
    await init();
    const one = await db.reserveVaultSeq(BOB, ITEM, ALICE, AT);
    const two = await db.reserveVaultSeq(BOB, ITEM, ALICE, AT);
    const slot = {
      peerId: BOB,
      id: ITEM,
      writerId: ALICE,
      ackSeq: 0,
      title: 'Door',
      updatedAt: AT,
      deleted: 0,
    };
    expect(await db.commitVaultSlot({ ...slot, seq: two, body: 'second' })).toBe(
      true,
    );
    expect(await db.commitVaultSlot({ ...slot, seq: one, body: 'first' })).toBe(
      false,
    );
    expect((await db.getVaultItem(BOB, ITEM))?.body).toBe('second');
  });
});

describe('the read rule is a pure function of the slots', () => {
  const base = {
    peerId: BOB,
    id: ITEM,
    title: 'Door',
    body: 'x',
    updatedAt: AT,
    deleted: 0,
  };

  it('gives the same answer whatever order the slots are handed to it', () => {
    const a = { ...base, writerId: ALICE, seq: 2, ackSeq: 0, body: 'a' };
    const b = { ...base, writerId: BOB, seq: 3, ackSeq: 0, body: 'b' };
    expect(db.collapseVaultSlots([a, b])).toEqual(db.collapseVaultSlots([b, a]));
  });

  it('collapses silently when both people typed the same thing', () => {
    // The common false positive: the router resets and both sides paste the new
    // Wi-Fi password. Concurrent, but there is nothing to choose between.
    const a = { ...base, writerId: ALICE, seq: 1, ackSeq: 0, body: 'same' };
    const b = { ...base, writerId: BOB, seq: 1, ackSeq: 0, body: 'same' };
    expect(db.collapseVaultSlots([a, b])).toMatchObject({
      body: 'same',
      contested: false,
    });
  });

  it('reads dominance componentwise, so a lying acknowledgement needs BOTH halves', () => {
    const mine = { seq: 5, ackSeq: 2 };
    // They saw my #5 and wrote #3, having already sent me #2. Ordinary.
    expect(db.vaultSlotDominates({ seq: 3, ackSeq: 5 }, mine)).toBe(true);
    expect(db.vaultSlotDominates(mine, { seq: 3, ackSeq: 5 })).toBe(false);
    // A claim to have seen my #5 while their own counter is BEHIND what I have
    // already acknowledged of theirs is not a story that holds together, and
    // the second component is what refuses it.
    expect(db.vaultSlotDominates({ seq: 1, ackSeq: 5 }, mine)).toBe(false);
  });

  it('has nothing to say about an item nobody has written', () => {
    expect(db.collapseVaultSlots([])).toBeNull();
  });
});

/**
 * `listVaultContenders` — the question the contested row asks: which slots
 * could a person actually be shown, and actually choose between?
 *
 * It lives here rather than in the screen because the sentinel it filters is
 * module-private: a screen doing this itself would have to hardcode a 2, and
 * the next person to change the sentinel would change it in one of two places.
 * Which means the filter has to be proved here too — it was covered only by the
 * peer-profile render test, so narrowing or moving that test would have left it
 * unguarded.
 */
describe('which slots a person may be offered a choice between', () => {
  const CAROL = '01CCCCZ3NDEKTSV4RRFFQ69G5F';

  it('offers the live values, in an order both phones compute', async () => {
    await init();
    // The contested pair, written in the order that is NOT the answer: the
    // sort by writerId is what makes the two rows sit in the same order on
    // both phones instead of swapping places between renders.
    await applyOn(BOB, ITEM, [
      { writerId: BOB, seq: 1, ackSeq: 0, title: 'Door', body: 'theirs' },
      { writerId: ALICE, seq: 1, ackSeq: 0, title: 'Door', body: 'mine' },
    ]);
    // …and a reservation: a number being held while a frame is composed.
    await db.reserveVaultSeq(BOB, ITEM, CAROL, AT);

    const contenders = await db.listVaultContenders(BOB, ITEM);
    expect(contenders.map(s => s.writerId)).toEqual([ALICE, BOB]);
    expect(contenders.map(s => s.body)).toEqual(['mine', 'theirs']);

    // The ROW is still there: this hides a reservation, it does not delete one,
    // or the counter it is holding would be lost.
    expect((await db.listVaultSlots(BOB, ITEM)).map(s => s.writerId).sort()).toEqual(
      [ALICE, BOB, CAROL].sort(),
    );
  });

  it('drops a reservation and a tombstone for WHAT THEY ARE, not for being empty', async () => {
    // Both states are empty in every reachable case, which means the two rules
    // "a reservation is not a value" and "a tombstone is not a value" are
    // invisible to a fixture built the ordinary way — strip either filter and
    // the emptiness check alone still passes. So both rows are hand-built with
    // real content, exactly as the peer-profile render test does it. If a
    // future path ever writes a reservation over an existing slot's strings (a
    // `DO UPDATE SET` away, since the conflict branch touches only `seq`), this
    // is the test that notices.
    await init();
    await db.mergeVaultSlot({
      peerId: BOB,
      id: ITEM,
      writerId: ALICE,
      seq: 1,
      ackSeq: 0,
      title: 'Door',
      body: 'mine',
      updatedAt: AT,
      deleted: 0,
    });
    await db.mergeVaultSlot({
      peerId: BOB,
      id: ITEM,
      writerId: BOB,
      seq: 1,
      ackSeq: 0,
      title: 'Door',
      body: 'RESERVED-NOT-A-VALUE',
      updatedAt: AT,
      deleted: 2,
    });
    await db.mergeVaultSlot({
      peerId: BOB,
      id: ITEM,
      writerId: CAROL,
      seq: 1,
      ackSeq: 0,
      title: 'Door',
      body: 'RETRACTED-NOT-A-VALUE',
      updatedAt: AT,
      deleted: 1,
    });

    const contenders = await db.listVaultContenders(BOB, ITEM);
    expect(contenders.map(s => s.writerId)).toEqual([ALICE]);
    expect(contenders.map(s => s.body)).toEqual(['mine']);
  });

  it('offers no slot whose value has already been blanked as superseded', async () => {
    // `blankSupersededSlots` wipes the loser's strings, and an empty string is
    // not a credential: offering it would be offering nothing as a choice.
    await init();
    await applyOn(BOB, ITEM, [
      { writerId: ALICE, seq: 1, ackSeq: 0, title: 'Door', body: 'mine' },
      { writerId: BOB, seq: 1, ackSeq: 0, title: '', body: '' },
    ]);

    const contenders = await db.listVaultContenders(BOB, ITEM);
    expect(contenders.map(s => s.writerId)).toEqual([ALICE]);
  });
});

describe('a writer’s own counter, and what it refuses', () => {
  const write = (over: Partial<Write>): Write => ({
    title: 'Wi-Fi',
    body: 'x',
    writerId: ALICE,
    seq: 1,
    ackSeq: 0,
    ...over,
  });

  it('a higher number wins and an older frame changes nothing', async () => {
    await init();
    await applyOn(BOB, ITEM, [write({ seq: 10, body: 'old' })]);
    await applyOn(BOB, ITEM, [write({ seq: 11, body: 'new' })]);
    // The replay of a frame this phone already superseded.
    await applyOn(BOB, ITEM, [write({ seq: 10, body: 'old' })]);
    expect((await db.getVaultItem(BOB, ITEM))?.body).toBe('new');
  });

  it('a gap is not a stall — 7 arrives, 5 never does, and nothing waits', async () => {
    // A delta scheme needs every frame; a slot carries whole state, so a lost
    // frame is repaired by that writer's next write with no resync. This is the
    // property that makes the design survive a transport that cannot redeliver.
    await init();
    await applyOn(BOB, ITEM, [write({ seq: 7, body: 'seven' })]);
    await applyOn(BOB, ITEM, [write({ seq: 5, body: 'five' })]);
    expect((await db.getVaultItem(BOB, ITEM))?.body).toBe('seven');
    await applyOn(BOB, ITEM, [write({ seq: 9, body: 'nine' })]);
    expect((await db.getVaultItem(BOB, ITEM))?.body).toBe('nine');
  });

  it('re-applying the identical write is a no-op, so a redelivery is free', async () => {
    // Boot-time replay, a server redelivery and the original are the same row.
    await init();
    const slot = {
      peerId: BOB,
      id: ITEM,
      writerId: ALICE,
      seq: 10,
      ackSeq: 0,
      title: 'Wi-Fi',
      body: 'hunter2',
      updatedAt: AT,
      deleted: 0,
    };
    expect(await db.mergeVaultSlot(slot)).toBe(true);
    expect(await db.mergeVaultSlot(slot)).toBe(false);
    expect((await db.getVaultItem(BOB, ITEM))?.body).toBe('hunter2');
  });

  it('a forged counter saturates the forger’s OWN slot and reaches no further', async () => {
    // The freeze the deleted 24h clamp existed to prevent. A crafted far-ahead
    // version used to pin an item for BOTH sides forever; a crafted counter now
    // exhausts only the slot its author may write, and my own writes are
    // untouched.
    await init();
    await applyOn(BOB, ITEM, [
      write({ writerId: BOB, seq: Number.MAX_SAFE_INTEGER, body: 'forged' }),
    ]);
    await applyOn(BOB, ITEM, [write({ seq: 1, ackSeq: 0, body: 'mine' })]);
    const slots = await slotsOn(BOB, ITEM);
    expect(slots).toHaveLength(2);
    expect(slots.find(s => s.writerId === ALICE)?.body).toBe('mine');
    // My next edit still allocates normally: their number is on another line.
    expect(await db.reserveVaultSeq(BOB, ITEM, ALICE, AT)).toBe(2);
  });
});

describe('deletion is a tombstone, and the tombstone is empty', () => {
  const set = (over: Partial<Write>): Write => ({
    title: 'Door',
    body: '4417',
    writerId: ALICE,
    seq: 10,
    ackSeq: 0,
    ...over,
  });
  const del = (over: Partial<Write>): Write =>
    set({ title: '', body: '', deleted: 1, ...over });

  it('keeps the row so a replayed older set cannot resurrect the item', async () => {
    await init();
    await applyOn(BOB, ITEM, [set({})]);
    await applyOn(BOB, ITEM, [del({ seq: 11 })]);

    // The frame that used to create the item, arriving late.
    await applyOn(BOB, ITEM, [set({ seq: 10 })]);
    expect((await db.getVaultItem(BOB, ITEM))?.deleted).toBe(1);
    expect(await db.listVaultItems(BOB)).toEqual([]);
  });

  it('blanks the title and the value — a tombstone must not still hold the credential', async () => {
    await init();
    await applyOn(BOB, ITEM, [set({})]);
    await applyOn(BOB, ITEM, [del({ seq: 11 })]);
    const row = await db.getVaultItem(BOB, ITEM);
    expect(row).toMatchObject({ deleted: 1, title: '', body: '' });
    // Belt and braces: the statement that wrote the tombstone did not carry it.
    const insert = callsOf('INSERT INTO vault_items').at(-1)!;
    expect(JSON.stringify(insert[1])).not.toContain('4417');
  });

  it('getVaultItem returns the tombstone; listVaultItems hides it', async () => {
    // The split mirrors getMessage (returns retracted rows) vs listReactions
    // (filters them). A writer needs the counter it has to beat; a screen does
    // not want a row that is not there.
    await init();
    await applyOn(BOB, ITEM, [del({ seq: 11 })]);
    expect(await db.getVaultItem(BOB, ITEM)).not.toBeNull();
    expect(await db.listVaultItems(BOB)).toEqual([]);
  });
});

describe('list order converges (minor 4)', () => {
  const ITEM_A = '01AAAZ3NDEKTSV4RRFFQ69G5AB';
  const ITEM_B = '02BBBZ3NDEKTSV4RRFFQ69G5AB';

  /** The same two items on two phones whose clocks disagree wildly. State
   * agrees; only `updatedAt` differs, because each phone stamps its own. */
  async function twoSkewedPhones() {
    await init();
    for (const [phone, skew] of [
      [BOB, 0],
      [ALICE, 9_000_000],
    ] as const) {
      await db.mergeVaultSlot({
        peerId: phone,
        id: ITEM_A,
        writerId: ALICE,
        seq: 1,
        ackSeq: 0,
        title: 'A',
        body: 'a',
        updatedAt: AT + skew,
        deleted: 0,
      });
      await db.mergeVaultSlot({
        peerId: phone,
        id: ITEM_B,
        writerId: BOB,
        seq: 1,
        ackSeq: 0,
        title: 'B',
        body: 'b',
        updatedAt: AT + 1000 - skew,
        deleted: 0,
      });
    }
  }

  it('two phones with wildly different clocks list the same items in the same order', async () => {
    await twoSkewedPhones();
    const onBobsPhone = (await db.listVaultItems(ALICE)).map(i => i.id);
    const onAlicesPhone = (await db.listVaultItems(BOB)).map(i => i.id);
    expect(onAlicesPhone).toEqual(onBobsPhone);
    // Newest item first, by the ULID both sides agree on.
    expect(onAlicesPhone).toEqual([ITEM_B, ITEM_A]);
  });

  it('NON-VACUITY: ordering by updatedAt puts them in opposite orders', async () => {
    // What the code did before: `frame.ts` inbound, `Date.now()` outbound, and
    // `ORDER BY updatedAt DESC`. The two phones agreed on every value and still
    // showed the list upside down relative to each other.
    await twoSkewedPhones();
    const byTime = async (phone: string) =>
      (await db.listVaultItems(phone))
        .slice()
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map(i => i.id);
    expect(await byTime(BOB)).not.toEqual(await byTime(ALICE));
  });

  it('does not order by updatedAt in SQL at all', async () => {
    await init();
    await db.listVaultItems(BOB);
    const read = callsOf('FROM vault_items WHERE peerId = ?').at(-1)!;
    expect(String(read[0])).not.toContain('ORDER BY updatedAt');
  });
});

describe('migration', () => {
  it('adds vault_items as its own table, with no ALTER and nothing dropped', async () => {
    await db.initDb();
    const sql = statements();
    const create = sql.find(s =>
      s.includes('CREATE TABLE IF NOT EXISTS vault_items'),
    );
    expect(create).toBeDefined();
    // The writer is IN the key. That single change is what makes
    // last-write-wins true by construction instead of by heuristic: a row has
    // exactly one author, so two writes can never contend for it.
    expect(create).toMatch(/PRIMARY KEY \(peerId, id, writerId\)/);
    expect(create).toMatch(/seq INTEGER NOT NULL/);
    expect(create).toMatch(/ackSeq INTEGER NOT NULL DEFAULT 0/);
    expect(create).toMatch(/writerId TEXT NOT NULL/);
    expect(create).toMatch(/updatedAt INTEGER NOT NULL/);
    expect(create).toMatch(/deleted INTEGER NOT NULL DEFAULT 0/);
    // The wall clock is gone from the schema, not merely unused by it.
    expect(create).not.toMatch(/version/);
    // This runs against installs holding real conversations: a new table needs
    // no ALTER and no rebuild, so the migration must not be able to rewrite or
    // discard anything already on disk.
    expect(sql.filter(s => /^\s*DROP TABLE/m.test(s))).toEqual([]);
    expect(sql.filter(s => /^\s*DELETE FROM/m.test(s))).toEqual([]);
    expect(sql.filter(s => /ALTER TABLE .*vault_items/.test(s))).toEqual([]);
  });

  it('is idempotent, and a second launch leaves the rows on disk alone', async () => {
    const model = await init();
    await applyOn(BOB, ITEM, [
      { title: 'Door', body: '4417', writerId: ALICE, seq: 10, ackSeq: 0 },
    ]);
    const later = since();
    await expect(db.initDb()).resolves.toBeUndefined();
    expect(
      later().filter(s => s.includes('CREATE TABLE IF NOT EXISTS vault_items')),
    ).toHaveLength(1);
    expect(later().filter(s => /^\s*(DROP TABLE|DELETE FROM)/m.test(s))).toEqual(
      [],
    );
    expect((await db.getVaultItem(BOB, ITEM))?.body).toBe('4417');
    expect(model.rows.size).toBe(1);
  });

  it('rebuilds a file carrying the old shape, and CARRIES THE ROWS OVER', async () => {
    // The one place on the phone where dropping a row means losing the only
    // copy of a credential. The key cannot be widened by ALTER, so the table is
    // rebuilt — but each old row becomes exactly ONE slot, so the migration
    // cannot invent a disagreement either.
    const model = await init();
    model.rows.set(`${ALICE}:${BOB} ${ITEM}`, {
      peerId: BOB,
      id: ITEM,
      writerId: ALICE,
      seq: 0,
      ackSeq: 0,
      title: 'Door',
      body: '4417',
      updatedAt: AT,
      deleted: 0,
    });
    model.legacyColumns.names = [
      'peerId',
      'id',
      'title',
      'body',
      'version',
      'writerId',
      'updatedAt',
      'deleted',
    ];

    const later = since();
    await db.initDb();

    expect(later().some(s => /DROP TABLE vault_items/.test(s))).toBe(true);
    const item = await db.getVaultItem(BOB, ITEM);
    expect(item).toMatchObject({ title: 'Door', body: '4417', writerId: ALICE });
    // The old wall-clock version is DISCARDED rather than translated: carrying
    // it forward would import the skew poison, including any row already
    // sitting a day in the future.
    expect(item).toMatchObject({ seq: 1, ackSeq: 0 });
  });

  it('a fresh file is never rebuilt, so no DROP is ever issued on one', async () => {
    // NON-VACUITY for the branch above. An unreadable PRAGMA answer is what a
    // just-created table looks like, and it must read as "nothing to migrate".
    const model = await init();
    model.legacyColumns.names = [];
    const later = since();
    await db.initDb();
    expect(later().filter(s => /DROP TABLE vault_items/.test(s))).toEqual([]);
  });

  it('creates the table on the decoy file too, so a duress session has one', async () => {
    db.setWorkspace('decoy');
    await db.initDb();
    expect(statements(DECOY).join('\n')).toMatch(
      /CREATE TABLE IF NOT EXISTS vault_items/,
    );
    expect(sqlite.instances.has(REAL)).toBe(false);
  });

  it('every column in the DDL is named by the readers', async () => {
    // The regression guard CHAT_COLUMNS did not have when the disappearing
    // pair was added and forgotten: getChat returned undefined for both, so
    // the send path read "no timer" while the rows on disk were correct.
    await init();
    await db.getVaultItem(BOB, ITEM);
    await db.listVaultItems(BOB);
    const create = statements().find(s =>
      s.includes('CREATE TABLE IF NOT EXISTS vault_items'),
    )!;
    const columns = [
      ...create.matchAll(/^\s{6}(\w+) (?:TEXT|INTEGER)/gm),
    ].map(m => m[1]);
    expect(columns).toEqual([
      'peerId',
      'id',
      'writerId',
      'seq',
      'ackSeq',
      'title',
      'body',
      'updatedAt',
      'deleted',
    ]);
    const reads = statements().filter(s => /SELECT[\s\S]*FROM vault_items/.test(s));
    expect(reads.length).toBeGreaterThanOrEqual(2);
    for (const read of reads) {
      for (const column of columns) {
        expect(read).toContain(column);
      }
    }
  });
});

describe('lifecycle', () => {
  it('deleting the conversation takes its vault with it', async () => {
    const model = await init();
    await applyOn(BOB, ITEM, [
      { title: 'Door', body: '4417', writerId: ALICE, seq: 10, ackSeq: 0 },
    ]);
    const later = since();
    await db.deleteChat(BOB);
    // Read the statement list BEFORE the assertions below issue reads of their
    // own, or the transaction's COMMIT is no longer the last thing in it.
    const sql = later();

    expect(await db.getVaultItem(BOB, ITEM)).toBeNull();
    expect(model.rows.size).toBe(0);
    const purge = sql.findIndex(s => s.includes('DELETE FROM vault_items'));
    const chats = sql.findIndex(s => s.includes('DELETE FROM chats'));
    // Children before parents, inside the one transaction — a failure mid-way
    // must not be able to orphan a row of credentials.
    expect(purge).toBeGreaterThan(-1);
    expect(purge).toBeLessThan(chats);
    expect(sql[0]).toBe('BEGIN IMMEDIATE');
    // Every write sits inside the transaction. AFTER the commit the only
    // traffic is the peer-name mirror republish — a read, on deleteGroup's
    // precedent: the deleted contact's name must leave the extension's
    // mirror, and no delete may fail over it.
    const commit = sql.indexOf('COMMIT');
    expect(commit).toBeGreaterThan(chats);
    for (const s of sql.slice(commit + 1)) {
      expect(s).toMatch(/^SELECT/);
    }
  });

  it('scoped to that conversation: another Room’s vault is untouched', async () => {
    // NON-VACUITY for the line above. The model deletes only what the statement
    // names and scopes, so an unscoped or missing DELETE changes this result.
    const model = await init();
    await applyOn(BOB, ITEM, [
      { title: 'Door', body: '4417', writerId: ALICE, seq: 10, ackSeq: 0 },
    ]);
    await applyOn(ALICE, ITEM, [
      { title: 'Wi-Fi', body: 'hunter2', writerId: BOB, seq: 10, ackSeq: 0 },
    ]);
    await db.deleteChat(BOB);
    expect(model.rows.size).toBe(1);
    expect((await db.getVaultItem(ALICE, ITEM))?.body).toBe('hunter2');
    const [purge] = callsOf('DELETE FROM vault_items WHERE peerId');
    expect(purge[1]).toEqual([BOB]);
  });

  it('sign-out wipes it with the rest of local state', async () => {
    expect(db.DB_TABLES).toContain('vault_items');
    const model = await init();
    await applyOn(BOB, ITEM, [
      { title: 'Door', body: '4417', writerId: ALICE, seq: 10, ackSeq: 0 },
    ]);
    await db.clearLocalState();
    expect(statements().join('\n')).toMatch(/DELETE FROM vault_items/);
    expect(model.rows.size).toBe(0);
  });

  it('NON-VACUITY: dropped from the wipe list, the credentials survive the wipe', async () => {
    // Exactly what forgetting the DB_TABLES line would do — sign-out, account
    // deletion and inconsistent-boot recovery all leaving door codes behind in
    // plaintext SQLite.
    const model = await init();
    await applyOn(BOB, ITEM, [
      { title: 'Door', body: '4417', writerId: ALICE, seq: 10, ackSeq: 0 },
    ]);
    const instance = sqlite.instances.get(REAL)!;
    for (const table of db.DB_TABLES.filter(t => t !== 'vault_items')) {
      await instance.execute(`DELETE FROM ${table}`);
    }
    expect(model.rows.size).toBe(1);
    expect((await db.getVaultItem(BOB, ITEM))?.body).toBe('4417');
  });

  it('wipes the decoy file’s vault too', async () => {
    await db.clearDecoyState();
    expect(statements(DECOY).join('\n')).toMatch(/DELETE FROM vault_items/);
  });
});

describe('disappearing messages cannot reach the vault', () => {
  it('the sweep names messages, attachments and reactions — never vault_items', async () => {
    // The item outlives its own announcement row. That asymmetry is the
    // feature: an announcement is conversation and expires with it, while a
    // vault item is kept indefinitely, which the design says out loud rather than
    // implying.
    const model = await init();
    await applyOn(BOB, ITEM, [
      { title: 'Door', body: '4417', writerId: ALICE, seq: 10, ackSeq: 0 },
    ]);
    model.doomed.msgIds = ['01ANNOUNCE', '01ORDINARY'];

    const later = since();
    expect(await db.sweepExpired(AT)).toBe(2);
    const sql = later();

    expect(sql.some(s => s.includes('DELETE FROM messages'))).toBe(true);
    expect(sql.filter(s => s.includes('vault_items'))).toEqual([]);
    expect((await db.getVaultItem(BOB, ITEM))?.body).toBe('4417');
    expect(model.rows.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// THE CREATION CAP: a peer is a writer, and a writer can create slots at
// their send-quota rate forever. The merge now refuses a NEW slot past
// VAULT_SLOTS_PER_WRITER_CAP for that (conversation, writer) — inside the
// statement, so a burst cannot overshoot — while an existing slot converges
// past the cap exactly as before.
// ---------------------------------------------------------------------------

describe('a writer’s slot count is bounded', () => {
  const id = (n: number) => `0${String(n).padStart(25, '0')}`;

  async function fillToCap(model: ReturnType<typeof installVaultModel>) {
    for (let n = 1; n <= db.VAULT_SLOTS_PER_WRITER_CAP; n++) {
      expect(
        await db.mergeVaultSlot({
          peerId: BOB, id: id(n), writerId: BOB, seq: 1, ackSeq: 0,
          title: `t${n}`, body: `b${n}`, updatedAt: AT, deleted: 0,
        }),
      ).toBe(true);
    }
    expect(model.rows.size).toBe(db.VAULT_SLOTS_PER_WRITER_CAP);
  }

  it('the writer’s next NEW slot is refused — false back, nothing stored', async () => {
    const model = await init();
    await fillToCap(model);
    expect(
      await db.mergeVaultSlot({
        peerId: BOB, id: id(db.VAULT_SLOTS_PER_WRITER_CAP + 1), writerId: BOB, seq: 1, ackSeq: 0,
        title: 'one too many', body: 'x', updatedAt: AT, deleted: 0,
      }),
    ).toBe(false);
    expect(model.rows.size).toBe(db.VAULT_SLOTS_PER_WRITER_CAP);
  });

  it('an EXISTING slot still merges at the cap — the bound is on creation, not convergence', async () => {
    const model = await init();
    await fillToCap(model);
    expect(
      await db.mergeVaultSlot({
        peerId: BOB, id: id(1), writerId: BOB, seq: 2, ackSeq: 0,
        title: 't1', body: 'rotated', updatedAt: AT, deleted: 0,
      }),
    ).toBe(true);
    expect((await db.getVaultItem(BOB, id(1)))?.body).toBe('rotated');
    // …and a replayed older frame is still the arithmetic no-op it was.
    expect(
      await db.mergeVaultSlot({
        peerId: BOB, id: id(1), writerId: BOB, seq: 1, ackSeq: 0,
        title: 't1', body: 'b1', updatedAt: AT, deleted: 0,
      }),
    ).toBe(false);
  });

  it('the cap is per WRITER: the other side’s slots neither count nor are counted', async () => {
    const model = await init();
    await fillToCap(model);
    expect(
      await db.mergeVaultSlot({
        peerId: BOB, id: id(db.VAULT_SLOTS_PER_WRITER_CAP + 1), writerId: ALICE, seq: 1, ackSeq: 0,
        title: 'mine', body: 'y', updatedAt: AT, deleted: 0,
      }),
    ).toBe(true);
    expect(model.rows.size).toBe(db.VAULT_SLOTS_PER_WRITER_CAP + 1);
  });
});

// ---------------------------------------------------------------------------
// END TO END, ACROSS THE REAL WIRE
//
// The review that produced this amendment noted that neither vault suite ever
// crossed the envelope boundary: messaging.vault.test.ts mocks `db` wholesale,
// and everything above this line calls `db` directly. So the defect that lost a
// 2100-character value — composed happily, refused by the receiver's parser,
// gone from both phones — could not have been caught by either.
//
// Everything below therefore goes through the REAL `encodeEnvelope`, a REAL
// string on a REAL wire, and the REAL `parseEnvelope`, into the REAL store.
// ---------------------------------------------------------------------------

/**
 * One phone, wired exactly as messaging.ts wires it, and no more:
 *
 *  - outbound: reserve the counter, build the envelope, ENCODE it (which is
 *    where a frame this build could not read back is refused), then commit the
 *    content at the number that was reserved;
 *  - inbound: PARSE the string, clamp the peer's acknowledgement to a write I
 *    actually made, merge it into their slot.
 *
 * `writerId` is not on the wire in either direction: mine is my account id,
 * theirs is the ratchet's `frame.from`.
 */
class Phone {
  constructor(
    readonly me: string,
    readonly peer: string,
  ) {}

  private async peerSlot(id: string): Promise<db.VaultSlotRow | undefined> {
    const slots = await db.listVaultSlots(this.peer, id);
    return slots.find(s => s.writerId === this.peer);
  }

  /** Compose a write. Returns the exact bytes that would ride the ratchet. */
  async compose(
    id: string,
    content: { title: string; body: string } | null,
  ): Promise<string> {
    const peer = await this.peerSlot(id);
    const ackSeq = peer?.seq ?? 0;
    // Their slot's ackSeq is THEIR copy of MY counter, and it is the floor my
    // next number has to clear. Kept in step with messaging.dispatchVaultWrite:
    // a harness that dropped it would model a build that no longer exists.
    const seq = await db.reserveVaultSeq(
      this.peer,
      id,
      this.me,
      AT,
      peer?.ackSeq ?? 0,
    );
    const envelope: VaultEnvelope = content
      ? { tcm: 'vault', op: 'set', id, ...content, n: seq, k: ackSeq }
      : { tcm: 'vault', op: 'del', id, n: seq, k: ackSeq };
    let wire: string;
    try {
      wire = encodeEnvelope(envelope);
    } catch (err) {
      await db.releaseVaultSeq(this.peer, id, this.me, seq);
      throw err;
    }
    await db.commitVaultSlot({
      peerId: this.peer,
      id,
      writerId: this.me,
      seq,
      ackSeq,
      title: content?.title ?? '',
      body: content?.body ?? '',
      updatedAt: AT,
      deleted: content ? 0 : 1,
    });
    return wire;
  }

  /** Take delivery of one frame. Returns whether it changed anything. */
  async receive(wire: string): Promise<boolean> {
    const envelope = parseEnvelope(wire);
    if (envelope?.tcm !== 'vault') {
      // What the shipped defect looked like from here: an unreadable frame,
      // already acked, with no second copy anywhere.
      return false;
    }
    if (envelope.op === 'set' && (!envelope.title || !envelope.body)) return false;
    const mine = (await db.listVaultSlots(this.peer, envelope.id)).find(
      s => s.writerId === this.me,
    );
    return db.mergeVaultSlot({
      peerId: this.peer,
      id: envelope.id,
      writerId: this.peer,
      seq: envelope.n,
      // Exactly messaging.applyVaultEnvelope: clamped against my own slot when I
      // have one, believed (up to a bound) when I do not — because the only way
      // to hold no slot is that deleteChat purged it, and clamping to 0 there
      // was what destroyed the record of how high my counter had got.
      ackSeq: mine
        ? Math.min(envelope.k, mine.seq)
        : Math.min(envelope.k, VAULT_ACK_TRUST_MAX),
      title: envelope.title ?? '',
      body: envelope.body ?? '',
      updatedAt: AT,
      deleted: envelope.op === 'del' ? 1 : 0,
    });
  }

  read(id: string) {
    return db.getVaultItem(this.peer, id);
  }

  slots(id: string) {
    return slotsOn(this.peer, id);
  }
}

describe('two phones, one wire, real envelopes', () => {
  let alice: Phone;
  let bob: Phone;

  beforeEach(async () => {
    await init();
    alice = new Phone(ALICE, BOB);
    bob = new Phone(BOB, ALICE);
  });

  it('THE CROSS-APPLY: concurrent edits settle in one place, in either delivery order', async () => {
    // Both people hold Alice's first write. Both then edit without seeing the
    // other. The two frames are delivered in opposite orders on two items, and
    // all four views must agree.
    const first = await alice.compose(ITEM, { title: 'Front door', body: '0000' });
    await bob.receive(first);
    const firstB = await bob.compose(OTHER_ITEM, {
      title: 'Front door',
      body: '0000',
    });
    await alice.receive(firstB);

    const aliceEdit = await alice.compose(ITEM, {
      title: 'Front door',
      body: '4417',
    });
    const bobEdit = await bob.compose(ITEM, { title: 'Front door', body: '9903' });
    // Crossing in flight.
    await bob.receive(aliceEdit);
    await alice.receive(bobEdit);

    expect(await alice.slots(ITEM)).toEqual(await bob.slots(ITEM));
    const settled = await alice.read(ITEM);
    expect(view(settled)).toEqual(view(await bob.read(ITEM)));
    expect(settled?.contested).toBe(true);
    // And the list agrees too, which is the part the old `updatedAt` ordering
    // could not promise.
    expect((await db.listVaultItems(BOB)).map(i => i.id)).toEqual(
      (await db.listVaultItems(ALICE)).map(i => i.id),
    );
  });

  it('an edit made after reading theirs simply wins, on both phones', async () => {
    const created = await alice.compose(ITEM, { title: 'Door', body: '0000' });
    await bob.receive(created);
    // Bob read it, then typed. His frame acknowledges Alice's write.
    const reply = await bob.compose(ITEM, { title: 'Door', body: '9903' });
    expect(JSON.parse(reply).k).toBe(1);
    await alice.receive(reply);

    expect(view(await alice.read(ITEM))).toEqual(view(await bob.read(ITEM)));
    expect(await alice.read(ITEM)).toMatchObject({
      body: '9903',
      contested: false,
    });
  });

  it('THE DEFECT, end to end: a 2100-character value now arrives', async () => {
    // The exact frame that used to be composed happily and then discarded by
    // the receiver's parser — with the ack already gone and the ratchet key
    // spent, so it was unrecoverable on both phones and even a local replay
    // could not bring it back.
    const backupCodes = 'CODE-1234-ABCD\n'.repeat(140);
    expect(backupCodes.length).toBeGreaterThan(2048);

    const wire = await alice.compose(ITEM, {
      title: 'Backup codes',
      body: backupCodes,
    });
    expect(await bob.receive(wire)).toBe(true);
    expect((await bob.read(ITEM))?.body).toBe(backupCodes);
    expect(view(await alice.read(ITEM))).toEqual(view(await bob.read(ITEM)));
  });

  it('NON-VACUITY: over the cap, the sender refuses instead of sending a frame nobody can read', async () => {
    const tooBig = 'x'.repeat(VAULT_BODY_MAX + 1);
    await expect(
      alice.compose(ITEM, { title: 'Backup codes', body: tooBig }),
    ).rejects.toThrow(EnvelopeRefusedError);
    // Nothing left behind: no item, and the reserved number handed back.
    expect(await db.listVaultItems(BOB)).toEqual([]);
    expect(await db.reserveVaultSeq(BOB, ITEM, ALICE, AT)).toBe(1);
    // And this is what the receiver would have done with it, which is why the
    // sender must not be able to produce it.
    expect(
      parseEnvelope(
        JSON.stringify({
          tcm: 'vault',
          op: 'set',
          id: ITEM,
          title: 'Backup codes',
          body: tooBig,
          n: 1,
          k: 0,
        }),
      ),
    ).toBeNull();
  });

  it('survives replay, duplication and reordering of the same frames', async () => {
    const a1 = await alice.compose(ITEM, { title: 'Door', body: 'a1' });
    await bob.receive(a1);
    const b1 = await bob.compose(ITEM, { title: 'Door', body: 'b1' });
    const a2 = await alice.compose(ITEM, { title: 'Door', body: 'a2' });
    await alice.receive(b1);
    const a3 = await alice.compose(ITEM, { title: 'Door', body: 'a3' });

    // Bob's queue arrives late, out of order, and twice over.
    for (const wire of [a3, a1, a2, a3, a1]) await bob.receive(wire);

    expect(await alice.slots(ITEM)).toEqual(await bob.slots(ITEM));
    expect(view(await alice.read(ITEM))).toEqual(view(await bob.read(ITEM)));
    expect(await alice.read(ITEM)).toMatchObject({ body: 'a3' });
  });

  it('a frame that never arrives stalls nothing — the next write repairs it', async () => {
    // Constraint (e): this transport cannot redeliver. A delta scheme would be
    // stuck forever; a slot carries whole state, so the gap simply closes.
    const a1 = await alice.compose(ITEM, { title: 'Door', body: 'a1' });
    await bob.receive(a1);
    await alice.compose(ITEM, { title: 'Door', body: 'lost-forever' });
    const a3 = await alice.compose(ITEM, { title: 'Door', body: 'a3' });
    await bob.receive(a3);

    expect((await bob.read(ITEM))?.body).toBe('a3');
    expect(view(await alice.read(ITEM))).toEqual(view(await bob.read(ITEM)));
  });

  it('a deletion removes the item on both phones and leaves the secret nowhere', async () => {
    const created = await alice.compose(ITEM, { title: 'Door', body: '4417' });
    await bob.receive(created);
    const removed = await bob.compose(ITEM, null);
    await alice.receive(removed);

    expect(await db.listVaultItems(BOB)).toEqual([]);
    expect(await db.listVaultItems(ALICE)).toEqual([]);
    expect(JSON.stringify(await alice.slots(ITEM))).not.toContain('4417');
    expect(JSON.stringify(await bob.slots(ITEM))).not.toContain('4417');
    // And the retraction did not re-transmit what it was retracting.
    expect(removed).not.toContain('4417');
  });
});

// ---------------------------------------------------------------------------
// THE PURGE, ACROSS THE REAL WIRE
//
// Nothing above this line could catch it, because a counter regression is
// invisible to every test that only ever counts UP. `deleteChat` is the one
// ordinary user action that makes the counter go backwards, and the merge is a
// one-way ratchet — the single input it cannot survive.
// ---------------------------------------------------------------------------

describe('deleting the conversation, then talking again', () => {
  it('THE REGRESSION: my writes still land on the other phone', async () => {
    await init();
    const alice = new Phone(ALICE, BOB);
    const bob = new Phone(BOB, ALICE);

    // A history: Alice writes three times, Bob sees them all and answers.
    for (const body of ['a1', 'a2', 'a3']) {
      await bob.receive(await alice.compose(ITEM, { title: 'Door', body }));
    }
    await alice.receive(await bob.compose(ITEM, { title: 'Door', body: 'b1' }));
    expect(view(await alice.read(ITEM))).toEqual(view(await bob.read(ITEM)));

    // Alice deletes the conversation. Local, silent, and it takes the vault —
    // including every trace of how high her own counter had got.
    await db.deleteChat(BOB);
    expect(await db.listVaultItems(BOB)).toEqual([]);

    // Bob, who knows nothing of this, edits the item. It reappears on Alice's
    // phone from his frame alone.
    await alice.receive(await bob.compose(ITEM, { title: 'Door', body: 'b2' }));
    expect((await alice.read(ITEM))?.body).toBe('b2');

    // Alice now changes the door code. Before the floor this reserved 1, Bob's
    // merge guard discarded it silently, and the two phones sat on different
    // credentials with nothing on either screen to say so.
    const repaired = await alice.compose(ITEM, { title: 'Door', body: 'a4' });
    expect(await bob.receive(repaired)).toBe(true);

    expect((await bob.read(ITEM))?.body).toBe('a4');
    expect(view(await alice.read(ITEM))).toEqual(view(await bob.read(ITEM)));
    // And it keeps working afterwards: this is a repair, not a one-shot.
    await bob.receive(await alice.compose(ITEM, { title: 'Door', body: 'a5' }));
    expect((await bob.read(ITEM))?.body).toBe('a5');
  });

  it('and the mirror: THEIR writes still land on mine', async () => {
    // Symmetric by construction, because `k` always names the RECIPIENT's
    // counter — so whichever side purged, the repair value is carried by the
    // first frame the other side sends afterwards.
    await init();
    const alice = new Phone(ALICE, BOB);
    const bob = new Phone(BOB, ALICE);

    for (const body of ['b1', 'b2', 'b3']) {
      await alice.receive(await bob.compose(ITEM, { title: 'Wi-Fi', body }));
    }
    await bob.receive(await alice.compose(ITEM, { title: 'Wi-Fi', body: 'a1' }));

    // Bob is the one who deletes the conversation this time.
    await db.deleteChat(ALICE);
    expect(await db.listVaultItems(ALICE)).toEqual([]);

    await bob.receive(await alice.compose(ITEM, { title: 'Wi-Fi', body: 'a2' }));
    const theirs = await bob.compose(ITEM, { title: 'Wi-Fi', body: 'b4' });
    expect(await alice.receive(theirs)).toBe(true);

    expect((await alice.read(ITEM))?.body).toBe('b4');
    expect(view(await alice.read(ITEM))).toEqual(view(await bob.read(ITEM)));
  });
});
