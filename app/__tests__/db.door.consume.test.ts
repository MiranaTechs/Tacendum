/**
 * THE TWO DOOR READERS THAT HOLD A HANDLE ACROSS AN AWAIT, and the verdict
 * that lands in the gap.
 *
 * `takeCallOffer` and `takeCallOffersForSession` are a SELECT followed by a
 * DELETE. Every other db function in this module is one statement, so these
 * two are the only place where "which workspace does this reach" can be
 * answered twice in one call — and the pre-verdict door is exactly where that
 * matters, because the press being serviced and the coerced unlock racing it
 * are the same scenario by construction (`conn`'s gate comment).
 *
 * `conn()`'s cost note used to promise that a duress verdict landing in that
 * gap left the half-read rows "in the real file rather than being consumed on
 * a coerced session's behalf". It did not: both readers cached the handle and
 * issued the DELETE straight at it, so the write landed on `tacendum.sqlite`
 * whenever nothing else happened to call `conn()` first — and when something
 * DID (a second press, the arm's own `initDb`), the handle had been closed
 * under them and the statement rejected, which the callers turn into "nothing
 * to restore" and the ring hears as a released CXCall.
 *
 * Both halves are pinned here, on both readers (the group reader and
 * the 1:1 reader are twins), together with the controls that say the ordinary
 * uncontested path still consumes what it read.
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
/* Real Crockford ULIDs: the shipped schemas validate every id. */
const SID = '01HQ5E55N0000000000000AAAA';
const LEG = '01HQ5TARTERLEG0000000000AA';
const CID = '01HQ1T01CA11000000000000AA';
const PEER = '01HQPEER0000000000000000AA';
const SELF = '01HQSELF0000000000000000AA';

const TAKE_GROUP = 'DELETE FROM call_offers WHERE sid = ?';
const TAKE_ONE = 'DELETE FROM call_offers WHERE cid = ?';
/** An ordinary (non-door) caller's two statements, and a transaction's. */
const MSG = '01HQMESSAGE00000000000000A';
const SEEN_INSERT = 'INSERT OR IGNORE INTO seen';
const SEEN_TRIM = 'DELETE FROM seen';
const OUTBOX_INSERT = 'INSERT OR IGNORE INTO outbox';

/**
 * What runs while one particular door statement is in flight. Each fires once.
 *
 * THREE SLOTS, NOT ONE, because the door has three statements a release can
 * land under and they fail differently. `inTheGap` is the offer SELECT — the
 * window where a verdict can still change which file the DELETE reaches.
 * `inTheDelete` is the write that follows it, where the rows are ALREADY in
 * the caller's hand and a cut throws them away. `inTheSessionRead` is
 * `loadCallSession`, the single-statement reader the small-group restore
 * cannot finish without.
 */
let inTheGap: (() => void | Promise<void>) | null = null;
let inTheDelete: (() => void | Promise<void>) | null = null;
let inTheSessionRead: (() => void | Promise<void>) | null = null;
/** …and the fourth: `loadSelfAccountIdForRing`, the one door read with no
 * second statement and the one `restoreLocked` returns at. */
let inTheProfileRead: (() => void | Promise<void>) | null = null;

/** Run a slot's hook, once, from inside the statement it names. */
async function fire(
  hook: (() => void | Promise<void>) | null,
): Promise<void> {
  if (hook) await hook();
}

/** The held ring, as `call_offers` holds it: one small-group leg and one 1:1. */
function heldOffers() {
  return [
    {
      cid: LEG,
      peerId: PEER,
      sdp: 'v=0\r\na=fingerprint:sha-256 AA\r\nOFFER',
      video: 0,
      exp: Date.now() + 60_000,
      serverTs: 1,
      sid: SID as string | null,
    },
    {
      cid: CID,
      peerId: PEER,
      sdp: 'v=0\r\na=fingerprint:sha-256 BB\r\nOFFER',
      video: 0,
      exp: Date.now() + 60_000,
      serverTs: 2,
      sid: null as string | null,
    },
  ];
}

/** A file that answers the door's three reads, and runs `inTheGap` inside the
 * offer SELECT — the one window a verdict can land in unseen. */
function seed(name: string, offers = heldOffers()): FakeDb {
  const record: FakeDb = {
    name,
    execute: jest.fn(async (sql: unknown, params?: unknown) => {
      const s = String(sql);
      if (/^SELECT[\s\S]*FROM call_offers/.test(s)) {
        const key = /WHERE sid = \?/.test(s) ? 'sid' : 'cid';
        const want = Array.isArray(params) ? String(params[0]) : '';
        const rows = offers.filter(o => String(o[key] ?? '') === want);
        const hook = inTheGap;
        inTheGap = null;
        await fire(hook);
        return { rows };
      }
      if (/^DELETE FROM call_offers/.test(s)) {
        const hook = inTheDelete;
        inTheDelete = null;
        await fire(hook);
        return { rows: [] };
      }
      if (/^SELECT value FROM profile WHERE key = 'userId'/.test(s)) {
        const hook = inTheProfileRead;
        inTheProfileRead = null;
        await fire(hook);
        return { rows: [{ value: SELF }] };
      }
      // The schema-inference PRAGMAs `initDb`'s destructive-rebuild path
      // checks, answered exactly as the default file in `jest.setup.js` does:
      // an empty answer there reads as "old shape on disk" and recurses
      // forever (a HANG, not a red test). Needed because the cases at the
      // bottom of this file unlatch the module the way a real session does.
      if (/^PRAGMA table_info\(attachments/.test(s)) {
        return { rows: [{ name: 'direction' }] };
      }
      if (/^PRAGMA table_info\(reactions/.test(s)) {
        return { rows: [{ name: 'targetDirection' }, { name: 'reactorId' }] };
      }
      if (/^PRAGMA table_info\(pending_revisions/.test(s)) {
        return { rows: [{ name: 'writerId' }] };
      }
      if (/^SELECT[\s\S]*FROM call_sessions/.test(s)) {
        const hook = inTheSessionRead;
        inTheSessionRead = null;
        await fire(hook);
        return {
          rows: [
            {
              sid: SID,
              roomId: null,
              starterId: PEER,
              roster: JSON.stringify([PEER]),
              se: 0,
              video: 0,
              startedAt: 1,
            },
          ],
        };
      }
      return { rows: [] };
    }),
    close: jest.fn(),
  };
  sqlite.instances.set(name, record);
  return record;
}

function statements(name: string): string[] {
  const record = sqlite.instances.get(name);
  return record ? record.execute.mock.calls.map(c => String(c[0])) : [];
}

/** Did this statement reach that file at all? Prefix, because the ordinary
 * writers below are matched by their opening clause rather than their text. */
function reached(name: string, prefix: string): boolean {
  return statements(name).some(s => s.trimStart().startsWith(prefix));
}

/**
 * Hold ONE statement on a seeded file open, and hand back the lever that lets
 * it answer — how an ordinary caller is parked mid-call while a verdict lands.
 */
function suspend(record: FakeDb, prefix: string): () => void {
  let go: () => void = () => {};
  const held = new Promise<void>(resolve => {
    go = resolve;
  });
  const base = record.execute.getMockImplementation() as (
    sql: unknown,
    params?: unknown,
  ) => Promise<{ rows: unknown[] }>;
  record.execute.mockImplementation(async (sql: unknown, params?: unknown) => {
    if (String(sql).trimStart().startsWith(prefix)) {
      await held;
      return { rows: [] };
    }
    return base(sql, params);
  });
  return go;
}

beforeEach(async () => {
  await db.close();
  // Back to what a COLD process holds: latched, pointed at the real file, no
  // declaration standing. `beginUnlock('decoy')` is what each case fires, so a
  // leftover from the previous one would decide the next one's outcome.
  db.relockWorkspace();
  sqlite.reset();
  inTheGap = null;
  inTheDelete = null;
  inTheSessionRead = null;
  inTheProfileRead = null;
  closeCallsMidRead = -1;
});

test('the harness itself: a closed handle rejects, and a re-open is a different handle', async () => {
  // THE MOCK IS THE EVIDENCE FOR EVERYTHING BELOW, so it is asserted rather
  // than assumed. Until this round `close` was a no-op `jest.fn()` and a
  // re-open handed back the same object, which made every use-after-close in
  // this repo — including the two cases at the bottom of this file — read as
  // green. A harness that cannot reach the state production reaches proves
  // nothing, so its contract is pinned here where a future edit to
  // `jest.setup.js` will trip over it.
  const opsqlite = jest.requireMock('@op-engineering/op-sqlite') as {
    open: (o: { name: string; location?: string }) => {
      execute: jest.Mock;
      close: () => void;
    };
  };

  const first = opsqlite.open({ name: REAL, location: '.' });
  await expect(first.execute('SELECT 1')).resolves.toBeDefined();
  first.close();
  await expect(first.execute('SELECT 1')).rejects.toThrow('database is closed');

  const second = opsqlite.open({ name: REAL, location: '.' });
  expect(second).not.toBe(first);
  await expect(second.execute('SELECT 1')).resolves.toBeDefined();

  // …and the FILE behind both handles is still one recorder, which is what
  // every `sqlAgainst`-style assertion in this repo reads. The statement the
  // closed handle refused never reached it.
  expect(statements(REAL)).toEqual(['SELECT 1', 'SELECT 1']);
});

test('the harness itself: a close INTERRUPTS the statement already running', async () => {
  // THE OTHER HALF OF WHAT `close` MEANS, and the half whose absence let the
  // previous round ship two tests asserting a row set production cannot
  // return. `DBHostObject.cpp:298-316` runs `sqlite3_interrupt(db)` before it
  // drains the pool; the interrupted step throws in `bridge.cpp:499` and
  // `utils.cpp`'s promisify rejects. A mock that only checks a flag at CALL
  // time models the statements that come AFTER a close and silently grants
  // every one that was already running — the strictly more forgiving
  // direction, and the one this file's whole subject depends on.
  const opsqlite = jest.requireMock('@op-engineering/op-sqlite') as {
    open: (o: { name: string; location?: string }) => {
      execute: jest.Mock;
      close: () => void;
    };
  };
  const handle = opsqlite.open({ name: REAL, location: '.' });
  const disk = sqlite.instances.get(REAL)!;
  let answer: (v: unknown) => void = () => {};
  disk.execute.mockImplementation(
    () => new Promise(resolve => (answer = resolve as (v: unknown) => void)),
  );

  const running = handle.execute('SELECT slow');
  handle.close();
  // Answering AFTER the close must not resurrect it: production's promise is
  // already rejected by then, and the pool's late result is thrown away.
  answer({ rows: [] });

  await expect(running).rejects.toThrow('interrupted');
});

test('the harness itself: the default file answer settles where it stands', async () => {
  // THE MOCK'S COST CONTRACT, pinned because other lanes pay for it. The
  // default file implementation answers with a VALUE, so a suite that
  // delegates to it from inside its own `async` override settles that override
  // where it stands; answer with a promise instead and the override's promise
  // is PENDING at return, which is the one state the handle wraps — one extra
  // microtask hop on every statement of all 149 suites, several of which flush
  // a fixed number of ticks.
  //
  // It is also the honest boundary of the interrupt model: a statement that
  // has answered by the time `execute` returns is never in flight, so `close`
  // cannot cut it. That is exact inside this harness (nothing ran in between,
  // so no close could have landed) and it is where the model stops being a
  // model of production's timing — which is why it is written down here rather
  // than left as a property nobody stated.
  const opsqlite = jest.requireMock('@op-engineering/op-sqlite') as {
    open: (o: { name: string; location?: string }) => { execute: jest.Mock };
  };
  const handle = opsqlite.open({ name: REAL, location: '.' });
  const disk = sqlite.instances.get(REAL)!;

  const straightFromTheFile = disk.execute('SELECT 1') as { then?: unknown };
  expect(typeof straightFromTheFile.then).not.toBe('function');
  expect(straightFromTheFile).toEqual({ rows: [] });

  // …and the handle still hands production a promise however the file answered.
  await expect(handle.execute('SELECT 1')).resolves.toEqual({ rows: [] });
});

/** How many microtask generations before `p` has settled. */
async function ticksUntil(p: Promise<unknown>): Promise<number> {
  let settled = false;
  void p.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  let ticks = 0;
  while (!settled && ticks < 50) {
    ticks += 1;
    await Promise.resolve();
  }
  return ticks;
}

test('the door costs the ring no microtask hop that an ordinary read does not', async () => {
  // THE DESIGN CLAIM ON `doorExecute`, MEASURED — it says it returns the
  // driver's OWN promise rather than one chained off it, because the door is
  // serviced inside a CallKit press and `call.relay`'s cold-launch answer
  // flushes a fixed number of ticks. Nothing pinned it: wrapping the return in
  // one `.then(r => r)` kept the whole repo green while charging every
  // lock-screen answer an extra generation.
  //
  // RELATIVE, NOT ABSOLUTE. `loadCallSession` (through the door) and
  // `deleteCallOffer` (a plain `conn()` caller) are the same shape — one
  // `await` on one statement — so the door's own cost is the difference
  // between them, and the harness's own hop count cancels out.
  seed(REAL);
  await db.initDb();

  const throughTheDoor = await ticksUntil(db.loadCallSession());
  const plain = await ticksUntil(db.deleteCallOffer(CID));

  expect(throughTheDoor).toBe(plain);
});

test('the uncontested group read still consumes the rows it answered with', async () => {
  const real = seed(REAL);

  const rows = await db.takeCallOffersForSession(SID);

  expect(rows.map(r => r.cid)).toEqual([LEG]);
  // The control for both cases below: with no verdict in flight the DELETE
  // lands exactly where the SELECT did, which is the whole "take rather than
  // get" invariant. A fix that simply stopped deleting would pass those two
  // and fail this.
  expect(statements(REAL)).toContain(TAKE_GROUP);
  expect(real.close).not.toHaveBeenCalled();
  expect(sqlite.instances.has(DECOY)).toBe(false);
});

test('the uncontested 1:1 read still consumes the row it answered with', async () => {
  seed(REAL);

  const row = await db.takeCallOffer(CID);

  expect(row?.cid).toBe(CID);
  expect(statements(REAL)).toContain(TAKE_ONE);
  expect(sqlite.instances.has(DECOY)).toBe(false);
});

test('a duress verdict landing under the group read keeps its DELETE off the real file', async () => {
  // THE DEFAULT INTERLEAVING, which is the one the cost note described
  // BACKWARDS. Nothing else calls `conn()` in the gap, so the cached handle is
  // still open on `tacendum.sqlite` and still perfectly willing — and the
  // DELETE it is handed is a WRITE to the real workspace, issued on behalf of
  // a session that has just declared itself coerced.
  seed(REAL);
  inTheGap = () => {
    db.beginUnlock('decoy');
  };

  const rows = await db.takeCallOffersForSession(SID);

  // RULE 3 FIRST. The press was already tapped; whatever the verdict does to
  // the workspace pointer, the answer it produced is not thrown away.
  expect(rows.map(r => r.cid)).toEqual([LEG]);
  // AND THE REAL FILE IS NOT WRITTEN — the sentence `conn()` makes, made true.
  expect(statements(REAL)).not.toContain(TAKE_GROUP);
  // The positive half, so "it stopped deleting" cannot pass this: the DELETE
  // went where the declaration points, which is where every other read from
  // here on goes too.
  expect(statements(DECOY)).toContain(TAKE_GROUP);
});

test('a duress verdict landing under the 1:1 read keeps its DELETE off the real file', async () => {
  // The twin, one file down: `rehydrate` asks `call_offers WHERE cid = ?`
  // through the same door, and caches the same handle across the same await.
  seed(REAL);
  inTheGap = () => {
    db.beginUnlock('decoy');
  };

  const row = await db.takeCallOffer(CID);

  expect(row?.cid).toBe(CID);
  expect(statements(REAL)).not.toContain(TAKE_ONE);
  expect(statements(DECOY)).toContain(TAKE_ONE);
});

/**
 * WHAT THE CLOSE DOES TO THE STATEMENT THAT IS ALREADY RUNNING — the half the
 * previous round's harness could not see, and got backwards in two of its own
 * tests as a result.
 *
 * `close()` is not a polite hand-back. `DBHostObject.cpp` runs
 * `sqlite3_interrupt(db)` FIRST, then drains the pool, then closes; the
 * interrupted step throws in `bridge.cpp` and `utils.cpp`'s promisify REJECTS
 * the promise the door is awaiting. So a release that lands under a door read
 * does not merely stop the NEXT statement — it kills the one in flight, and
 * `controller.ts`/`group.ts` turn that rejection into `failed_media` on a call
 * somebody has already answered.
 *
 * Both cases below therefore assert the ORDER, not just the outcome: at the
 * instant the verdict lands (inside the SELECT, `closeCallsMidRead`) the real
 * handle must still be open, and it must be closed by the time the reader
 * returns. Asserting only "close was called" passes on the shipped defect,
 * where it was called a round trip too early.
 */
let closeCallsMidRead = -1;

test('a group read the re-home releases underneath still answers the ring', async () => {
  // Something else DOES call `conn()` in the gap here — a second CallKit press
  // out of one native flush, which is the ordinary case for a phone being
  // handed over mid-ring — so the re-home fires while the SELECT is still in
  // the pool. It drops the handle from `db` (nothing new can reach the real
  // file) but does NOT close it until the statement already dispatched has
  // answered. Rule 3: the tie goes to the ring.
  const real = seed(REAL);
  inTheGap = async () => {
    db.beginUnlock('decoy');
    await db.loadCallSession();
    closeCallsMidRead = real.close.mock.calls.length;
  };

  const rows = await db.takeCallOffersForSession(SID);

  expect(rows.map(r => r.cid)).toEqual([LEG]);
  // THE ORDER, which is the whole fix: not closed while the read was running…
  expect(closeCallsMidRead).toBe(0);
  // …and closed once it had answered, so the deferral releases the file rather
  // than leaking it.
  expect(real.close).toHaveBeenCalled();
  // The re-home really happened — otherwise this case is the one above.
  expect(sqlite.instances.has(DECOY)).toBe(true);
  expect(statements(REAL)).not.toContain(TAKE_GROUP);
});

test('a 1:1 read the re-home releases underneath still answers the ring', async () => {
  const real = seed(REAL);
  inTheGap = async () => {
    db.beginUnlock('decoy');
    await db.loadCallSession();
    closeCallsMidRead = real.close.mock.calls.length;
  };

  const row = await db.takeCallOffer(CID);

  expect(row?.cid).toBe(CID);
  expect(closeCallsMidRead).toBe(0);
  expect(real.close).toHaveBeenCalled();
  expect(sqlite.instances.has(DECOY)).toBe(true);
  expect(statements(REAL)).not.toContain(TAKE_ONE);
});

/**
 * THE DELETE IS A DOOR STATEMENT TOO, and it is the one with the most to lose.
 *
 * By the time it runs the SELECT has answered and the rows are in the
 * caller's hand — the offer CallKit is ringing about. A release landing under
 * the DELETE interrupts it, `takeCallOffer…` unwinds on the rejection, and
 * `controller.ts:2114`/`group.ts:2000` turn the empty result into
 * `endCall(..., 'failed_media')`. An answer that was already read out of the
 * database is discarded by the bookkeeping write that follows it.
 *
 * Note which file the DELETE is on here, because it is the other half of the
 * previous round's fix and it still holds: no verdict existed when this
 * statement asked `conn()`, so it is correctly on the real file. The verdict
 * arrives while it runs, and moves the NEXT statement, not this one.
 */
test('a group DELETE the re-home releases underneath still answers the ring', async () => {
  const real = seed(REAL);
  inTheDelete = async () => {
    db.beginUnlock('decoy');
    await db.loadCallSession();
    closeCallsMidRead = real.close.mock.calls.length;
  };

  const rows = await db.takeCallOffersForSession(SID);

  expect(rows.map(r => r.cid)).toEqual([LEG]);
  expect(closeCallsMidRead).toBe(0);
  expect(statements(REAL)).toContain(TAKE_GROUP);
});

test('a 1:1 DELETE the re-home releases underneath still answers the ring', async () => {
  const real = seed(REAL);
  inTheDelete = async () => {
    db.beginUnlock('decoy');
    await db.loadCallSession();
    closeCallsMidRead = real.close.mock.calls.length;
  };

  const row = await db.takeCallOffer(CID);

  expect(row?.cid).toBe(CID);
  expect(closeCallsMidRead).toBe(0);
  expect(statements(REAL)).toContain(TAKE_ONE);
});

test('the session read the re-home releases underneath still answers the ring', async () => {
  // `loadCallSession` is the fourth door read and the only single-statement
  // one, so nothing else in this file covers it — but `restoreLocked` cannot
  // rebuild a small-group call without the row it returns, and the door's own
  // gate comment names it. A release landing under it is the same discarded
  // answer by a shorter route.
  const real = seed(REAL);
  inTheSessionRead = async () => {
    db.beginUnlock('decoy');
    await db.loadSelfAccountIdForRing();
    closeCallsMidRead = real.close.mock.calls.length;
  };

  const session = await db.loadCallSession();

  expect(session?.sid).toBe(SID);
  expect(closeCallsMidRead).toBe(0);
  expect(real.close).toHaveBeenCalled();
});

test('the profile read the re-home releases underneath still answers the ring', async () => {
  // THE SIXTH DOOR STATEMENT, and the twin of the case above: `restoreLocked`
  // returns at `if (!selfId)` (call/index.ts), so a release cutting THIS read
  // ends a small-group answer by the shortest route on the page — the press
  // falls through to the 1:1 handler, which finds no offer for a sid and
  // releases the CXCall. Every other `'servicing-a-callkit-answer'` statement
  // has a case in this file; without this one, routing this read back through
  // a plain `conn()` would have been invisible in the whole repo.
  const real = seed(REAL);
  inTheProfileRead = async () => {
    db.beginUnlock('decoy');
    await db.loadCallSession();
    closeCallsMidRead = real.close.mock.calls.length;
  };

  const selfId = await db.loadSelfAccountIdForRing();

  expect(selfId).toBe(SELF);
  expect(closeCallsMidRead).toBe(0);
  expect(real.close).toHaveBeenCalled();
});

test('a door statement that REJECTS still releases the door', async () => {
  // THE OTHER ARM OF THE COUNTER'S OBSERVER, and the more reachable of the two
  // by far: a synchronous throw is a parameter that will not bind, but a
  // REJECTION is what every SQLite error becomes (`utils.cpp`'s promisify) and
  // what this whole round says an interrupted statement produces. If only the
  // fulfilment arm decremented, the count would sit above zero for the rest of
  // the process: every release from then on deferred forever, one leaked file
  // handle per workspace switch — and, worse since a deferral is no longer a
  // free pass, a revoked handle that never actually closes.
  const real = seed(REAL);
  real.execute.mockImplementation(async (sql: unknown) => {
    if (/^SELECT[\s\S]*FROM call_offers/.test(String(sql))) {
      throw new Error('[op-sqlite] statement execution error: interrupted');
    }
    return { rows: [] };
  });

  await expect(db.takeCallOffersForSession(SID)).rejects.toThrow('interrupted');

  // The door is not wedged: the next release closes rather than deferring.
  await db.close();
  expect(real.close).toHaveBeenCalled();
});

test('a statement that throws on dispatch does not wedge the door shut', async () => {
  // THE COST OF COUNTING BEFORE THE DISPATCH, paid. `execute` is a JSI host
  // function: a parameter it cannot bind throws synchronously instead of
  // answering with a rejected promise. If that throw escaped without putting
  // the count back, the number would sit above zero for the rest of the
  // process and EVERY release from then on would be deferred forever — one
  // leaked file handle per workspace switch, and `setWorkspace` refusing on a
  // handle nobody can reach.
  const real = seed(REAL);
  real.execute.mockImplementation(() => {
    throw new Error('could not bind parameter');
  });

  // Synchronous, not a rejection — the harness half of the same fact, pinned
  // here because everything below it depends on which of the two it is.
  const handle = (
    jest.requireMock('@op-engineering/op-sqlite') as {
      open: (o: { name: string; location?: string }) => { execute: jest.Mock };
    }
  ).open({ name: REAL, location: '.' });
  expect(() => handle.execute('SELECT 1')).toThrow('could not bind parameter');

  await expect(db.takeCallOffer(CID)).rejects.toThrow('could not bind parameter');

  // The door is not wedged: an ordinary close still closes, now.
  await db.close();
  expect(real.close).toHaveBeenCalled();
});

/**
 * A DEFERRED HANDLE IS STILL AN OPEN HANDLE, AND AN OPEN HANDLE STILL ANSWERS
 * — the other half of what a release has to mean.
 *
 * Not every caller in this module re-asks `conn()` per statement. Eighteen
 * capture the handle once and use it across an await (`markSeen`, `setDraft`,
 * `clearLocalState`, …), nine of them for a whole `BEGIN IMMEDIATE`…`COMMIT`
 * transaction (`enqueueOutgoing`, `enqueueOutgoingFanout`, `deleteGroup`,
 * `loadGroupStore`, …). Dropping
 * the handle from `db` stops the NEXT `conn()` caller and nobody else: every
 * one of those captures goes on writing the file the verdict has just declared
 * off-limits, for the whole length of the deferral — a COMMIT on
 * `tacendum.sqlite`, its `-journal` created and removed, its mtime moved,
 * after the moment the duress passcode was typed.
 *
 * So the release REVOKES rather than merely drops: the handle stops answering
 * the instant the verdict lands, while the statements already dispatched on it
 * run to their answer. The three cases below are the ordinary caller's twins of
 * the door cases above — the two-statement pair and the transaction, from each
 * of the two closers — with the uncontested control that says the ordinary
 * path still writes both of its statements.
 */
test('the uncontested two-statement write still reaches the real file with both statements', async () => {
  seed(REAL);
  await db.initDb();

  await db.markSeen(MSG, 1);

  expect(reached(REAL, SEEN_INSERT)).toBe(true);
  expect(reached(REAL, SEEN_TRIM)).toBe(true);
});

test('a write holding the handle across the re-home cannot commit to the real file after the verdict', async () => {
  // THE TRANSACTION, which is the sharpest form of it: `enqueueOutgoing` has
  // issued BEGIN IMMEDIATE and its first INSERT and is waiting on the pool when
  // the duress passcode is typed. The re-home releases the handle underneath
  // it; if the release is only a deferral, the transaction resumes on the
  // handle it captured before the verdict existed and COMMITS to
  // `tacendum.sqlite` on a coerced session's clock.
  const real = seed(REAL);
  await db.initDb();
  const resume = suspend(real, 'INSERT OR IGNORE INTO messages');
  let outcome = 'still running';
  const writing = db
    .enqueueOutgoing(
      { msgId: MSG, peerId: PEER, direction: 'out', body: 'x', ts: 1, status: 'pending' },
      { msgType: 'msg', payload: '{}' },
    )
    .then(
      () => {
        outcome = 'the transaction completed';
      },
      (err: Error) => {
        outcome = err.message;
      },
    );

  inTheGap = async () => {
    db.beginUnlock('decoy');
    // The re-home, from a second CallKit press out of the same native flush.
    await db.loadCallSession();
    closeCallsMidRead = real.close.mock.calls.length;
    // …and the parked transaction resumes INSIDE the deferral window, which is
    // the only window in which any of this is reachable.
    resume();
    await writing;
  };

  const rows = await db.takeCallOffersForSession(SID);

  // RULE 3 FIRST, and unchanged: the press keeps the answer it was given.
  expect(rows.map(r => r.cid)).toEqual([LEG]);
  // The deferral really was open when the write resumed — otherwise this case
  // proves nothing, because a closed handle refuses on its own.
  expect(closeCallsMidRead).toBe(0);
  // THE PRIVACY CLAIM, first because it is the one a person is standing over
  // the phone for: no statement of this transaction reaches the real file
  // after the verdict, and least of all its COMMIT.
  expect(reached(REAL, OUTBOX_INSERT)).toBe(false);
  expect(reached(REAL, 'COMMIT')).toBe(false);
  expect(outcome).toBe('database handle released');
  // …and it is not re-homed either: a captured handle that followed the
  // verdict would carry the real session's rows INTO the decoy.
  expect(reached(DECOY, OUTBOX_INSERT)).toBe(false);
});

test('a write holding the handle across the duress close cannot reach the real file after the verdict', async () => {
  // The twin, from the other closer and with no second press at all:
  // `enterDecoyWorkspace`'s own `await db.close()` (App.tsx), while an ordinary
  // two-statement writer is parked between its INSERT and its trim.
  const real = seed(REAL);
  await db.initDb();
  const resume = suspend(real, SEEN_INSERT);
  let outcome = 'still running';
  const writing = db.markSeen(MSG, 1).then(
    () => {
      outcome = 'the write completed';
    },
    (err: Error) => {
      outcome = err.message;
    },
  );

  inTheGap = async () => {
    db.beginUnlock('decoy');
    await db.close();
    closeCallsMidRead = real.close.mock.calls.length;
    resume();
    await writing;
  };

  const rows = await db.takeCallOffersForSession(SID);

  expect(rows.map(r => r.cid)).toEqual([LEG]);
  expect(closeCallsMidRead).toBe(0);
  expect(reached(REAL, SEEN_TRIM)).toBe(false);
  expect(reached(DECOY, SEEN_TRIM)).toBe(false);
  expect(outcome).toBe('database handle released');
});

test('the duress arm’s own close does not cut the read it landed on', async () => {
  // AND NO SECOND PRESS IS NEEDED FOR ANY OF IT. This is the plain hand-over:
  // the phone rings, somebody presses ANSWER, and while that press's SELECT is
  // still in the pool the duress passcode is typed. `enterDecoyWorkspace` runs
  // `await db.close()` (App.tsx) — the same `sqlite3_interrupt`, on the same
  // in-flight statement, with nothing racing it at all. `conn()`'s re-home is
  // one closer of two, and this is the other.
  const real = seed(REAL);
  inTheGap = async () => {
    db.beginUnlock('decoy');
    await db.close();
    closeCallsMidRead = real.close.mock.calls.length;
  };

  const rows = await db.takeCallOffersForSession(SID);

  expect(rows.map(r => r.cid)).toEqual([LEG]);
  expect(closeCallsMidRead).toBe(0);
  expect(real.close).toHaveBeenCalled();
  // The DELETE still follows the verdict rather than the handle the SELECT
  // used: `close()` dropped the handle, and the door re-opens on the decoy.
  expect(statements(REAL)).not.toContain(TAKE_GROUP);
  expect(statements(DECOY)).toContain(TAKE_GROUP);
});

/**
 * THE MISSING CELL OF THE 2×2 ABOVE, AND THE ONE THE NINE TRANSACTIONS LIVE IN.
 *
 * The block above ships the transaction against the RE-HOME closer and the
 * two-statement pair against `close()`. `markSeen` is not inside
 * `runExclusive`, and that is the only reason its `close()` case passed:
 * `close()` awaited the whole transaction chain BEFORE it released anything, so
 * a `runExclusive` caller — running or merely QUEUED at the instant the duress
 * passcode was typed — ran to `COMMIT` on `tacendum.sqlite`, and `close()` was
 * the thing that waited for it. A queued one had issued nothing at all when the
 * verdict landed: its `BEGIN IMMEDIATE`, its inserts and its `COMMIT` were all
 * new after it, with the `-journal` minted and removed beside the real file
 * and its mtime moved later than the moment somebody was coerced.
 *
 * `close()` is the closer `enterDecoyWorkspace` actually calls (App.tsx), so
 * the class the deferral was written for was the one class the deferral's own
 * closer did not reach. The four cases below are that cell: the transaction
 * running, the transaction queued, the READ arm of the same refusal, and the
 * handle a press opens while the chain is draining.
 *
 * NONE OF THEM AWAITS THE CLOSE BEFORE RESUMING, and that is the subject rather
 * than a convenience: `close()` waits on the chain, the chain waits on the
 * parked statement, so awaiting the close first would deadlock the test on
 * exactly the drain being described.
 */
const MSG_QUEUED = '01HQMESSAGE00000000000000B';
const BEGIN = 'BEGIN IMMEDIATE';
const MSGS_INSERT = 'INSERT OR IGNORE INTO messages';

/** Let the microtask queue run out, so "queued" and "running" are facts about
 * the harness rather than hopes about it. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

/**
 * A transaction that is GENUINELY RUNNING when the caller returns — the state
 * the two cases below are about, asserted rather than assumed.
 *
 * `enqueueOutgoing` captures its handle synchronously and then hands its body
 * to `runExclusive`, which schedules it. Without the settle below the body has
 * not run at all when the verdict lands and the "running" case would silently
 * be a second copy of the "queued" one.
 */
async function parkARunningTransaction(
  real: FakeDb,
  msgId: string,
): Promise<{ resume: () => void; done: Promise<string> }> {
  const resume = suspend(real, MSGS_INSERT);
  const done = db
    .enqueueOutgoing(
      { msgId, peerId: PEER, direction: 'out', body: 'x', ts: 1, status: 'pending' },
      { msgType: 'msg', payload: '{}' },
    )
    .then(
      () => 'the transaction completed',
      (err: Error) => err.message,
    );
  await settle();
  // BEGIN IMMEDIATE is on the real file and the first INSERT is in the pool:
  // this transaction has an open write transaction on `tacendum.sqlite`.
  expect(statements(REAL).filter(s => s === BEGIN)).toHaveLength(1);
  return { resume, done };
}

test('a transaction RUNNING at the duress close cannot commit to the real file after the verdict', async () => {
  const real = seed(REAL);
  await db.initDb();
  const resume = suspend(real, MSGS_INSERT);
  let outcome = 'still running';
  const writing = db
    .enqueueOutgoing(
      { msgId: MSG, peerId: PEER, direction: 'out', body: 'x', ts: 1, status: 'pending' },
      { msgType: 'msg', payload: '{}' },
    )
    .then(
      () => {
        outcome = 'the transaction completed';
      },
      (err: Error) => {
        outcome = err.message;
      },
    );
  await settle();
  // The premise, asserted: BEGIN IMMEDIATE has landed on the real file and the
  // first INSERT is parked in the pool.
  expect(statements(REAL).filter(s => s === BEGIN)).toHaveLength(1);

  inTheGap = async () => {
    db.beginUnlock('decoy');
    const closing = db.close();
    closeCallsMidRead = real.close.mock.calls.length;
    resume();
    await writing;
    await closing;
  };

  const rows = await db.takeCallOffersForSession(SID);

  // RULE 3 FIRST, and unchanged: the press keeps the answer it was given, and
  // the release did not cut the read it landed on.
  expect(rows.map(r => r.cid)).toEqual([LEG]);
  expect(closeCallsMidRead).toBe(0);
  // THE PRIVACY CLAIM. Its BEGIN and its first INSERT were dispatched before
  // the verdict existed and are the unavoidable set; everything after the
  // verdict is refused, and least of all does it COMMIT.
  expect(reached(REAL, OUTBOX_INSERT)).toBe(false);
  expect(reached(REAL, 'COMMIT')).toBe(false);
  expect(outcome).toBe('database handle released');
  // …and it is not re-homed either: a captured handle that followed the
  // verdict would carry the real session's rows INTO the decoy.
  expect(reached(DECOY, OUTBOX_INSERT)).toBe(false);
  // RELEASED ONCE. Binding the handle without also dropping it from `db`
  // leaves the same object to be found again after the drain and released a
  // SECOND time — two `opsqlite_close` calls on one connection, which this
  // mock forgives and `DBHostObject`'s freed pointer does not.
  expect(real.close).toHaveBeenCalledTimes(1);
});

test('a transaction merely QUEUED at the duress close reaches the real file with nothing at all', async () => {
  // THE SHARPEST FORM, because nothing about this one is "already in hand":
  // `runExclusive` had not called its body when the passcode was typed. Every
  // statement it issues is new after the verdict — and the first of them opens
  // a write transaction on `tacendum.sqlite` and mints the journal beside it.
  const real = seed(REAL);
  await db.initDb();
  const parked = await parkARunningTransaction(real, MSG);
  let outcome = 'still running';
  const queued = db
    .enqueueOutgoing(
      { msgId: MSG_QUEUED, peerId: PEER, direction: 'out', body: 'y', ts: 2, status: 'pending' },
      { msgType: 'msg', payload: '{}' },
    )
    .then(
      () => {
        outcome = 'the transaction completed';
      },
      (err: Error) => {
        outcome = err.message;
      },
    );
  await settle();
  // …and this one has issued NOTHING: still one BEGIN on the file, the parked
  // transaction's.
  expect(statements(REAL).filter(s => s === BEGIN)).toHaveLength(1);

  inTheGap = async () => {
    db.beginUnlock('decoy');
    const closing = db.close();
    closeCallsMidRead = real.close.mock.calls.length;
    parked.resume();
    await parked.done;
    await queued;
    await closing;
  };

  const rows = await db.takeCallOffersForSession(SID);

  expect(rows.map(r => r.cid)).toEqual([LEG]);
  expect(closeCallsMidRead).toBe(0);
  expect(outcome).toBe('database handle released');
  // STILL one BEGIN — the queued transaction contributed none, so no journal,
  // no rows and no COMMIT of its own after the verdict.
  expect(statements(REAL).filter(s => s === BEGIN)).toHaveLength(1);
  expect(reached(REAL, OUTBOX_INSERT)).toBe(false);
  expect(reached(DECOY, BEGIN)).toBe(false);
});

test('a READ queued at the duress close cannot reach the real file either', async () => {
  // BOTH ARMS OF THE REFUSAL. The guard is on the handle, not on the statement,
  // so it must refuse a SELECT exactly as it refuses a COMMIT — and five
  // captured-handle callers issue a SELECT across an await (`sweepExpired`,
  // `blockPeer`, `setPeerAvatar`, `setDisappearTimer`, `enqueueOutgoingFanout`).
  // Narrowing the guard to writes on the grounds that "a read harms nothing"
  // leaves a revoked handle reading `tacendum.sqlite` after the verdict — the
  // roster of the last group call, the ids of every expiring message — and
  // `conn`'s own gate comment names that as the harm.
  const real = seed(REAL);
  await db.initDb();
  const parked = await parkARunningTransaction(real, MSG);
  let outcome = 'still running';
  const sweeping = db.sweepExpired(Date.now()).then(
    () => {
      outcome = 'the sweep completed';
    },
    (err: Error) => {
      outcome = err.message;
    },
  );
  await settle();
  expect(reached(REAL, 'SELECT msgId FROM messages')).toBe(false);

  inTheGap = async () => {
    db.beginUnlock('decoy');
    const closing = db.close();
    closeCallsMidRead = real.close.mock.calls.length;
    parked.resume();
    await parked.done;
    await sweeping;
    await closing;
  };

  const rows = await db.takeCallOffersForSession(SID);

  expect(rows.map(r => r.cid)).toEqual([LEG]);
  expect(closeCallsMidRead).toBe(0);
  expect(outcome).toBe('database handle released');
  expect(reached(REAL, 'SELECT msgId FROM messages')).toBe(false);
});

test('a duress close with NO press in flight is refused by this module, not by the driver', async () => {
  // THE PLAIN CASE, and the only one on this page with no ring in it: the phone
  // is not ringing, somebody types the duress passcode, and an ordinary
  // transaction is mid-flight. Nothing is deferred — `doorStatementsRunning` is
  // zero — so the release takes its IMMEDIATE branch, and the refusal has to be
  // this module's rather than the driver's. Two reasons that matters. The
  // handle is not closed until the drain finishes, so a revoke that only ran on
  // the deferred branch would leave the whole transaction to COMMIT on the way
  // there. And "the driver will refuse it anyway" is precisely the assumption
  // this area died on a round ago, when the harness handed a closed handle its
  // own answers back; the message below is which layer said no.
  const real = seed(REAL);
  await db.initDb();
  const parked = await parkARunningTransaction(real, MSG);

  db.beginUnlock('decoy');
  const closing = db.close();
  parked.resume();
  const outcome = await parked.done;
  await closing;

  expect(outcome).toBe('database handle released');
  expect(reached(REAL, OUTBOX_INSERT)).toBe(false);
  expect(reached(REAL, 'COMMIT')).toBe(false);
  expect(real.close).toHaveBeenCalledTimes(1);
});

test('a drain releases EVERY handle deferred under one press, not just the last', async () => {
  // TWO HANDLES CAN BE DEFERRED BY ONE `close()`, and this is the shape that
  // does it: the verdict binds the handle it found, the press that is being
  // serviced opens another on the workspace the verdict chose, and the drain
  // reaches both only after that press answers. A drain that releases one and
  // leaves the rest leaks an open connection to `tacendum.sqlite` — file handle,
  // journal lock and all — on a phone somebody is standing over.
  const real = seed(REAL);
  const decoy = seed(DECOY);
  await db.initDb();
  const parked = await parkARunningTransaction(real, MSG);
  const answerTheDoor = suspend(decoy, 'SELECT sid, roomId');

  db.beginUnlock('decoy');
  const closing = db.close();
  const reading = db.loadCallSession();
  parked.resume();
  await parked.done;
  await closing;

  // Both are deferred at this instant — the press has not answered yet.
  expect(real.close).not.toHaveBeenCalled();
  expect(decoy.close).not.toHaveBeenCalled();

  answerTheDoor();
  await reading;

  expect(real.close).toHaveBeenCalledTimes(1);
  expect(decoy.close).toHaveBeenCalledTimes(1);
});

test('a door statement whose CONNECTION fails does not wedge the door shut', async () => {
  // THE TWIN OF "a statement that throws on dispatch", at the OTHER of
  // `doorExecute`'s two throw sources — and the one with no test until now.
  // `conn()` opens lazily and `openHandle` runs the native directory
  // preparation first, which throws when the App Group container cannot be
  // prepared: exactly the cold-launch-by-press path this door exists for. Count
  // before that call and the throw leaves the number above zero for the rest of
  // the process — every release from then on deferred forever, and since a
  // deferral is no longer a free pass, a REVOKED handle that never closes.
  const real = seed(REAL);
  const opsqlite = jest.requireMock('@op-engineering/op-sqlite') as {
    open: jest.Mock;
  };
  opsqlite.open.mockImplementationOnce(() => {
    throw new Error('database directory unavailable');
  });

  await expect(db.loadCallSession()).rejects.toThrow(
    'database directory unavailable',
  );

  // The door is not wedged: the next release closes rather than deferring.
  await db.initDb();
  await db.close();
  expect(real.close).toHaveBeenCalled();
});

test('a relock drains its own writes into its own workspace rather than refusing them', async () => {
  // THE OTHER HALF OF THE PREDICATE, and the reason it is not "revoke on every
  // close". `relock()` closes with NO verdict — no `beginUnlock`, the pointer
  // unmoved — so the transactions in the chain are the owner's own, bound for
  // the owner's own workspace. Binding them there protects nothing and loses a
  // message somebody had just sent, because the phone autolocked underneath it.
  const real = seed(REAL);
  await db.initDb();
  const parked = await parkARunningTransaction(real, MSG);

  const closing = db.close();
  parked.resume();
  await parked.done;
  await closing;

  expect(reached(REAL, OUTBOX_INSERT)).toBe(true);
  expect(reached(REAL, 'COMMIT')).toBe(true);
  expect(real.close).toHaveBeenCalled();
});

test('a door read that opens a handle while the close is draining is released, not orphaned', async () => {
  // WHY `close()` RE-READS `db` AFTER ITS AWAIT — load-bearing prose in two
  // rounds of review with no test under it. The verdict drops and revokes the
  // handle the module held; a lock-screen press landing DURING the drain opens
  // another one, on the file the verdict points at. If the close released only
  // the handle it read at the top, that second handle is orphaned — open, never
  // closed and never revoked — a live connection to a workspace on a phone
  // somebody is standing over.
  const real = seed(REAL);
  await db.initDb();
  const parked = await parkARunningTransaction(real, MSG);

  db.beginUnlock('decoy');
  const closing = db.close();
  const session = await db.loadCallSession();
  parked.resume();
  await parked.done;
  await closing;

  // The press was served out of the decoy, which is where the verdict points.
  expect(session).toBeNull();
  expect(sqlite.instances.has(DECOY)).toBe(true);
  expect(sqlite.instances.get(DECOY)!.close).toHaveBeenCalledTimes(1);
  // ONCE HERE TOO, and this is the arm where a stale pointer costs two closes
  // rather than one: left in `db`, the bound handle is re-homed by this very
  // press and then released again by the drain's own tail.
  expect(real.close).toHaveBeenCalledTimes(1);
  // …and nothing is left in `db`, so `setWorkspace` on the next line of
  // `enterDecoyWorkspace` cannot be made to throw by a press that landed here.
  expect(() => db.setWorkspace('decoy')).not.toThrow();
});
