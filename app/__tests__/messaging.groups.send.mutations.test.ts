/**
 * ROOMS — the OUTBOUND MEMBERSHIP seam's SURVIVING MUTATIONS, on Node's REAL SQLite engine.
 *
 * An independent gate ran 45 mutations against `fanOutMembership` and 19
 * survived — rules the code gets right and nothing defended. Three were
 * closed by GroupProfile.send.test.tsx; this file closes the rest, one test
 * per rule, each verified by applying the exact mutation and watching the
 * test fail (harness copied from messaging.groups.send.test.ts):
 *
 *  - the PRE-ENQUEUE quiesce: a relock landing after the LAST leg composes
 *    still aborts before the transaction (the existing quiesce test
 *    pins only the per-leg check);
 *  - duress + a DECLINED apply echoes NOTHING (announce-only-when-applied;
 *    the committed duress test only drives an applied write);
 *  - the apply runs UNDER runGroupApply — an outbound write queues behind an
 *    in-flight inbound apply instead of interleaving;
 *  - an identity change surfacing MID-COMPOSE skips that member loudly —
 *    flag recorded, banner named — never an anonymous failed leg (the
 *    committed test pre-sets the flag, so only the pre-gate was pinned);
 *  - membership legs NOTIFY (grp.roster/grp.set/grp.del are not
 *    carriers — no suite mentioned `notify` on this path at all);
 *  - the announcement row NEVER expires, even in a room with a live
 *    disappearing timer (and sweepExpired's localMsgId join would
 *    kill unsent legs with an expiring row);
 *  - legs flush in wire-id order, not roster order (the timing signature;
 *    fanOut's copy of the rule has a test, the membership copy had none);
 *  - a fan-out whose EVERY leg settles at enqueue settles the announcement
 *    row — never "Sending…" forever;
 *  - createRoom's failed list NAMES identity-skipped members (its
 *    only failure fixture was an encrypt throw, never a skip);
 *  - a brand-new member's grp.new snapshot carries the ROOM'S name, not a
 *    hardcoded fallback (the Add test asserted tcm/ms/n but never nm);
 *  - the announcement row's sq is the envelope's n (the order tiebreak);
 *  - the membership payload cap holds: an oversized leg settles as a failed
 *    leg, and nothing over the server's ceiling is ever queued.
 *
 * Two suite-wide disciplines, learned the hard way: every fixture asserts
 * its PRECONDITION before the rule (six suites have shipped tests whose
 * fixture never reached the code under test), and every wire-level wait is a
 * bounded wait on a CONDITION with the budget counted in POLLS, never a
 * fixed sleep or a wall-clock deadline (fixed-deadline polling produced 7
 * false mutation kills under parallel-worker load).
 */

jest.mock('../src/ws', () => {
  const handlers: {
    frame?: (f: unknown) => void;
    state?: (s: string) => void;
  } = {};
  const state = { open: true };
  const calls = {
    start: jest.fn(),
    stop: jest.fn(),
    send: jest.fn((_frame: unknown) => true),
  };
  class WsClient {
    onFrame(cb: (f: unknown) => void) {
      handlers.frame = cb;
    }
    onState(cb: (s: string) => void) {
      handlers.state = cb;
    }
    start(token: string) {
      calls.start(token);
    }
    stop() {
      calls.stop();
    }
    send(frame: unknown) {
      return calls.send(frame) as boolean;
    }
    get isOpen() {
      return state.open;
    }
  }
  return { WsClient, __ws: { handlers, calls, state } };
});

jest.mock('../src/api', () => ({
  apiUploadKeys: jest.fn().mockRejectedValue(new Error('network in test')),
  apiGetPrekeyBundle: jest.fn().mockRejectedValue(new Error('network in test')),
  apiDeleteAccount: jest.fn().mockRejectedValue(new Error('network in test')),
  apiCreateAttachment: jest.fn().mockRejectedValue(new Error('network in test')),
  apiGetAttachmentUrl: jest.fn().mockRejectedValue(new Error('network in test')),
  uploadBlob: jest.fn().mockRejectedValue(new Error('network in test')),
  downloadBlob: jest.fn().mockRejectedValue(new Error('network in test')),
  apiWsTicket: jest.fn().mockRejectedValue(new Error('network in test')),
}));

jest.mock('../src/decoy', () => ({
  syncDecoyProfile: jest.fn(async () => undefined),
}));

import { MAX_PAYLOAD_B64_LENGTH } from '@tacendum/shared';
import {
  applyGroupDel,
  applyRosterWrite,
  applySettingsWrite,
  ownerOnlyPolicy,
  unconditionalPolicy,
} from '@tacendum/shared/group-fold';
import * as db from '../src/db';
import { messaging } from '../src/messaging';
import { createRoom } from '../src/screens/GroupCreateScreen';
import { session } from '../src/session';

// The bucket is born EMPTY and refills at ~3.83 tokens/s, so the wire-level
// waits below genuinely spend real seconds — close enough to Jest's DEFAULT
// 5 s per-test deadline for worker-scheduling stalls to expire it while
// nothing is wrong (the same wall-clock class as the false kills above).
// Every ASSERTION deadline in this file is bounded in polls (see `until`);
// this ceiling is only the backstop against a genuine hang.
jest.setTimeout(120_000);

// --- the real engine, bound under the recorded mock -------------------------

type Row = Record<string, unknown>;
interface Engine {
  prepare(sql: string): { all(...args: unknown[]): Row[] };
  close(): void;
}
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (p: string) => Engine;
};
// eslint-disable-next-line @typescript-eslint/no-var-requires
const nodeCrypto = require('crypto') as {
  randomFillSync: (buf: Uint8Array) => Uint8Array;
};

interface FakeDb {
  name: string;
  execute: jest.Mock;
  close: jest.Mock;
}
const sqlite = jest.requireMock('@op-engineering/op-sqlite') as {
  open: (o: { name: string }) => FakeDb;
  __sqlite: { instances: Map<string, FakeDb>; reset: () => void };
};
const crypto = jest.requireMock('tacendum-crypto') as {
  __keychain: Map<string, string>;
  decryptEnvelope: jest.Mock;
  encryptText: jest.Mock;
  hasSession: jest.Mock;
  isIdentityChangeError: jest.Mock;
  randomBytes: jest.Mock;
};
const ws = (
  jest.requireMock('../src/ws') as {
    __ws: {
      handlers: { frame?: (f: unknown) => void };
      calls: { send: jest.Mock };
      state: { open: boolean };
    };
  }
).__ws;

let engine: Engine;

function bindRealEngine(): void {
  engine = new DatabaseSync(':memory:');
  const instance = sqlite.open({ name: 'tacendum.sqlite' });
  instance.execute.mockImplementation(
    async (sql: unknown, params?: unknown[]) => {
      const args = (params ?? []).map(p => (p === undefined ? null : p));
      const rows = engine.prepare(String(sql)).all(...args);
      const changes = engine.prepare('SELECT changes() AS c').all()[0]!
        .c as number;
      return { rows, rowsAffected: changes };
    },
  );
}

const q = (sql: string, ...args: unknown[]): Row[] =>
  engine.prepare(sql).all(...args);

// --- ids --------------------------------------------------------------------

const pad = (seed: string): string => (seed + '0'.repeat(26)).slice(0, 26);
const ME = pad('ME');
const ANA = pad('ANA');
const BEN = pad('BEN');
const CARA = pad('CARA');
const DAN = pad('DAN');
const EVE = pad('EVE');
const FRAN = pad('FRAN'); // has a 1:1 chat, never in any room
const ROOM = pad('7R00M');

async function flush(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

/** Bounded wait on a CONDITION, the budget counted in POLLS — never a
 * wall-clock deadline, which worker scheduling can expire for reasons
 * unrelated to the code (a Date.now() budget here is how the send suite
 * manufactured false mutation kills). Each poll is one 25 ms timer grant
 * from the same queue the pacer's own timers ride, so a stalled worker
 * delays the poll and the drain together. 320 polls is the old 8 s budget
 * at nominal speed; on exhaustion it returns and lets the caller's
 * assertion fail loudly. */
async function until(
  done: () => boolean,
  maxPolls = 320,
): Promise<void> {
  for (let poll = 0; !done(); poll++) {
    if (poll >= maxPolls) return;
    await new Promise<void>(resolve => setTimeout(() => resolve(), 25));
    await flush();
  }
}

/** Every `send`-type frame the socket saw, in order. */
function sentFrames(): { to: string; msgId: string; notify?: boolean }[] {
  return ws.calls.send.mock.calls
    .map(
      c => c[0] as { type: string; to?: string; msgId?: string; notify?: boolean },
    )
    .filter(f => f.type === 'send') as {
    to: string;
    msgId: string;
    notify?: boolean;
  }[];
}

/** The plaintext each member's leg carried, from the ratchet's own calls. */
function composedFor(): Map<string, Row> {
  const out = new Map<string, Row>();
  for (const call of crypto.encryptText.mock.calls) {
    const [, peer, plaintext] = call as [string, string, string];
    try {
      out.set(peer, JSON.parse(plaintext) as Row);
    } catch {
      /* profile cards etc. */
    }
  }
  return out;
}

// --- inbound helper ---------------------------------------------------------

let wireN = 0;
async function deliver(text: string, from: string): Promise<string> {
  const msgId = `01WIRE${String(++wireN).padStart(20, '0')}`;
  crypto.decryptEnvelope.mockResolvedValue(text);
  ws.handlers.frame?.({
    type: 'msg',
    from,
    msgId,
    msgType: 'ciphertext',
    payload: 'AAAA',
    ts: 9_000 + wireN,
  });
  await flush();
  return msgId;
}

const gNew = (g: string, ms: string[], n = 1, nm = 'Kitchen'): string =>
  JSON.stringify({ tcm: 'grp.new', g, nm, ms, n });
const gRoster = (g: string, m: string, s: 'in' | 'out', n: number): string =>
  JSON.stringify({ tcm: 'grp.roster', g, m, s, n });

// --- the screens' closures, as the screens run them -------------------------

async function createMyRoom(members: string[], nm = 'Kitchen') {
  const result = await createRoom(ME, nm, members);
  // The create fan-out has its own suites; everything below asserts a LATER
  // fan-out, so clear its legs and traffic out of the way.
  q(`DELETE FROM outbox`);
  ws.calls.send.mockClear();
  crypto.encryptText.mockClear();
  return result;
}

async function ownerRosterWrite(
  groupId: string,
  memberId: string,
  state: 'in' | 'out',
) {
  const seq = await db.reserveGroupSeq(groupId, 'writer');
  return messaging.fanOutMembership(
    groupId,
    { tcm: 'grp.roster', g: groupId, m: memberId, s: state, n: seq },
    {
      apply: async () => {
        const store = await db.loadGroupStore(groupId);
        const applied = applyRosterWrite(
          store,
          ME,
          { writerId: ME, memberId, seq, state },
          ownerOnlyPolicy,
        );
        await store.persist();
        return applied.outcome === 'applied';
      },
    },
  );
}

async function setMyTimer(groupId: string, seconds: number) {
  const seq = await db.reserveGroupSeq(groupId, 'writer');
  return messaging.fanOutMembership(
    groupId,
    { tcm: 'grp.set', g: groupId, s: seconds, n: seq },
    {
      apply: async () => {
        const store = await db.loadGroupStore(groupId);
        const applied = applySettingsWrite(
          store,
          { writerId: ME, seq, disappearSec: seconds },
          unconditionalPolicy,
        );
        await store.persist();
        return applied === 'applied';
      },
    },
  );
}

async function deleteForEveryone(groupId: string) {
  const seq = await db.reserveGroupSeq(groupId, 'writer');
  return messaging.fanOutMembership(
    groupId,
    { tcm: 'grp.del', g: groupId, n: seq },
    {
      apply: async () => {
        const store = await db.loadGroupStore(groupId);
        const result = applyGroupDel(store, { writerId: ME, seq });
        if (result !== 'purged') return false;
        await store.persist();
        return true;
      },
    },
  );
}

beforeEach(async () => {
  messaging.stop();
  await db.close();
  crypto.__keychain.clear();
  sqlite.__sqlite.reset();
  crypto.encryptText.mockReset();
  crypto.encryptText.mockResolvedValue({ msgType: 'ciphertext', payload: 'AAAA' });
  crypto.decryptEnvelope.mockReset();
  crypto.hasSession.mockReset();
  crypto.hasSession.mockResolvedValue(true);
  crypto.isIdentityChangeError.mockReset();
  crypto.isIdentityChangeError.mockReturnValue(false);
  crypto.randomBytes.mockImplementation(async (count: number) =>
    nodeCrypto.randomFillSync(new Uint8Array(count)),
  );
  ws.calls.send.mockClear();
  ws.state.open = true;
  session.setMode('real');
  db.setWorkspace('real');
  bindRealEngine();
  crypto.__keychain.set('authToken', 'token-1');
  await db.initDb();
  await messaging.start(ME);
  await flush();
  ws.calls.send.mockClear();
});

afterEach(async () => {
  jest.useRealTimers();
  messaging.stop();
  await db.close();
  engine.close();
  session.setMode('real');
  db.setWorkspace('real');
});

// ---------------------------------------------------------------------------
// The design — the PRE-ENQUEUE quiesce, distinct from the per-leg one.
// ---------------------------------------------------------------------------

describe('quiesce — a relock landing AFTER the last leg composes', () => {
  test('still aborts before the transaction: no announcement row, no leg, in whichever workspace opens next', async () => {
    // The committed quiesce test relocks at leg 3 of 10, which the PER-LEG
    // check catches — so deleting the second check, the one immediately
    // before enqueueOutgoingFanout, kept every test green while a relock
    // landing after the last compose wrote the row and every leg into the
    // next workspace (the exact leak). Here the relock lands DURING the
    // FINAL compose, after the last per-leg check has already passed.
    await db.upsertChat(BEN, 'Ben');
    await db.upsertChat(CARA, 'Cara');
    await db.upsertChat(DAN, 'Dan');
    const { groupId } = await createMyRoom([BEN, CARA, DAN]);

    let calls = 0;
    crypto.encryptText.mockImplementation(async () => {
      calls += 1;
      if (calls === 3) messaging.stop(); // the relock, during the LAST compose
      return { msgType: 'ciphertext', payload: 'Q0lQSEVS' };
    });

    await expect(ownerRosterWrite(groupId, BEN, 'out')).rejects.toThrow(
      'messaging not started',
    );

    // Precondition — the relock really landed AFTER the last per-leg check:
    // all three legs composed (the per-leg quiesce would have stopped at 2 if
    // the relock had landed any earlier). The pre-enqueue check is therefore
    // the ONLY thing standing between this fan-out and the transaction.
    expect(crypto.encryptText).toHaveBeenCalledTimes(3);

    // The rule: nothing landed — no leg, no announcement row.
    expect(q(`SELECT msgId FROM outbox`)).toEqual([]);
    expect(
      q(
        `SELECT msgId FROM messages WHERE peerId = ? AND body LIKE '%grp.roster%'`,
        groupId,
      ),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The design — duress: a DECLINED apply must echo nothing.
// ---------------------------------------------------------------------------

describe('duress with a declined apply', () => {
  test('a declined/stale write in a duress session writes NO decoy announcement row (announce-only-when-applied)', async () => {
    await db.upsertChat(BEN, 'Ben');
    const { groupId } = await createMyRoom([BEN]);
    session.setMode('duress');

    // Precondition — this fixture CAN write a decoy row: an APPLIED duress
    // write echoes one announcement (the committed duress test's behaviour,
    // re-proven here so the declined case below is a difference, not a
    // fixture that never reached the echo).
    const applied = await ownerRosterWrite(groupId, BEN, 'out');
    expect(applied).not.toBeNull();
    expect(applied!.localMsgId).not.toBeNull();
    const rowsAfterApplied = q(
      `SELECT msgId FROM messages WHERE peerId = ?`,
      groupId,
    ).length;
    expect(
      q(
        `SELECT msgId FROM messages WHERE peerId = ? AND body LIKE '%grp.roster%'`,
        groupId,
      ),
    ).toHaveLength(1);

    // The rule: a DECLINED apply echoes nothing — no row, no ratchet, no
    // frame. The duress echo exists so the decoy does not go inert, but an
    // announcement for a write that never applied would be a decoy thread
    // asserting a roster change no store holds.
    crypto.encryptText.mockClear();
    const declined = await messaging.fanOutMembership(
      groupId,
      { tcm: 'grp.set', g: groupId, s: 60, n: 99 },
      { apply: async () => false },
    );
    expect(declined).toBeNull();
    expect(
      q(`SELECT msgId FROM messages WHERE peerId = ?`, groupId),
    ).toHaveLength(rowsAfterApplied);
    expect(
      q(
        `SELECT msgId FROM messages WHERE peerId = ? AND body LIKE '%grp.set%'`,
        groupId,
      ),
    ).toEqual([]);
    expect(crypto.encryptText).not.toHaveBeenCalled();
    expect(sentFrames()).toEqual([]);
    expect(q(`SELECT msgId FROM outbox`)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The apply runs UNDER the same serialisation as the inbound apply path.
// ---------------------------------------------------------------------------

describe('the outbound apply is serialised against the inbound apply path', () => {
  test('an outbound write QUEUES behind an in-flight inbound apply; it does not interleave its load/persist round', async () => {
    // fanOutMembership runs opts.apply under runGroupApply — the same chain
    // the inbound frame path applies roster writes on. Mutated to a bare
    // opts.apply(), no test raced the two, so the lost-update guard on
    // the OUTBOUND seam was undefended. Here an inbound apply is held open
    // mid-persist (inside the chain, inside its transaction) and an outbound
    // write is issued: serialised, its apply MUST NOT run until the inbound
    // round completes.
    await db.upsertChat(BEN, 'Ben');
    await db.upsertChat(CARA, 'Cara');
    const { groupId } = await createMyRoom([BEN, CARA]);

    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const instance = sqlite.__sqlite.instances.get('tacendum.sqlite')!;
    const real = instance.execute.getMockImplementation()!;
    instance.execute.mockImplementation(
      async (sql: unknown, params?: unknown[]) => {
        // BEN's sovereign leave persisting: (groupId, memberId=BEN,
        // writerId=BEN, ...) — unique to the INBOUND apply below.
        if (
          String(sql).includes('INSERT OR REPLACE INTO group_members') &&
          params?.[1] === BEN &&
          params?.[2] === BEN
        ) {
          order.push('inbound-persist');
          await gate;
        }
        return real(sql, params);
      },
    );

    let p: ReturnType<typeof messaging.fanOutMembership> | null = null;
    try {
      // BEN leaves — the inbound apply enters the chain and blocks mid-persist.
      await deliver(gRoster(groupId, BEN, 'out', 1), BEN);
      await until(() => order.length > 0, 160);
      // Precondition — the inbound apply really is in flight and held open.
      expect(order).toEqual(['inbound-persist']);

      // The outbound write, while the inbound round is still open. (A literal
      // n: reserveGroupSeq would block on the open transaction's lock before
      // the seam was even reached, proving nothing.)
      p = messaging.fanOutMembership(
        groupId,
        { tcm: 'grp.set', g: groupId, s: 3600, n: 2 },
        {
          apply: async () => {
            order.push('outbound-apply');
            return true;
          },
        },
      );

      // A generous bounded window in which a de-serialised apply WOULD run
      // (the mutation calls opts.apply() directly, which lands within a few
      // microtask ticks — long before this window closes).
      for (let i = 0; i < 40; i++) {
        await flush();
        await new Promise<void>(resolve => setTimeout(() => resolve(), 5));
      }
      // THE RULE: the outbound apply has NOT run — it is queued behind the
      // inbound round, not interleaved into the middle of it.
      expect(order).toEqual(['inbound-persist']);

      release();
      const result = await p;
      expect(result).not.toBeNull();
      // Strict order: the inbound round completed, THEN the outbound apply.
      expect(order).toEqual(['inbound-persist', 'outbound-apply']);
    } finally {
      // Idempotent; frees the chain if an assertion threw above, then DRAINS
      // the in-flight rounds — an orphaned fan-out finishing after afterEach
      // closes the db would crash the worker instead of failing the test.
      release();
      if (p) await p.catch(() => undefined);
      for (let i = 0; i < 10; i++) {
        await flush();
        await new Promise<void>(resolve => setTimeout(() => resolve(), 10));
      }
    }

    // Both writes landed whole — nothing was lost to interleaving.
    expect(
      q(
        `SELECT state FROM group_members
         WHERE groupId = ? AND memberId = ? AND writerId = ?`,
        groupId,
        BEN,
        BEN,
      ),
    ).toEqual([{ state: 'out' }]);
    // The grp.set fanned to the PRE-apply snapshot (slots are read once,
    // before the apply): both members' legs exist.
    expect(
      q(`SELECT peerId FROM outbox`).map(l => l.peerId).sort(),
    ).toEqual([BEN, CARA].sort());
  });
});

// ---------------------------------------------------------------------------
// The design — an identity change surfacing MID-COMPOSE, not pre-flagged.
// ---------------------------------------------------------------------------

describe('an identity change surfacing mid-compose', () => {
  test('names THAT member loudly and records a settled failed leg so the delivery notice counts them', async () => {
    // The committed test sets the flag BEFORE the fan-out, so only the
    // pre-gate (`identityChanged.has`) was pinned; neutralising
    // isIdentityChangeError in the CATCH survived — the member became an
    // anonymous failed leg, the flag was never recorded, and no banner named
    // them. Here the change surfaces from the ratchet itself, mid-compose.
    await db.upsertChat(BEN, 'Ben');
    await db.upsertChat(CARA, 'Cara');
    await db.upsertChat(DAN, 'Dan');
    const { groupId } = await createMyRoom([BEN, CARA, DAN]);

    // Precondition — CARA is NOT pre-flagged: the pre-gate cannot fire, so
    // whatever happens next happens in the compose loop's catch.
    expect(messaging.skippedInRoom(groupId)).toEqual([]);

    const caraErr = new Error('identity changed');
    crypto.isIdentityChangeError.mockImplementation(
      (e: unknown) => e === caraErr,
    );
    crypto.encryptText.mockImplementation(
      async (_self: string, peer: string) => {
        if (peer === CARA) throw caraErr;
        return { msgType: 'ciphertext', payload: 'AAAA' };
      },
    );

    const result = await ownerRosterWrite(groupId, BEN, 'out');
    expect(result).not.toBeNull();

    // Precondition — the ratchet really was asked for Cara (the error came
    // from mid-compose, not from a fixture that skipped her earlier).
    expect(
      crypto.encryptText.mock.calls.some(c => c[1] === CARA),
    ).toBe(true);

    // The identity-specific outcome stays SKIPPED (so the banner can
    // name the safety-number reason), while a settled empty ledger leg makes
    // the event-row delivery notice count the same non-delivery honestly.
    expect(result!.skipped).toEqual([CARA]);
    expect(result!.failed).toEqual([]);
    expect(q(`SELECT payload, attempts FROM outbox WHERE peerId = ?`, CARA)).toEqual([
      { payload: '', attempts: db.LEG_FAILED },
    ]);
    expect(messaging.skippedInRoom(groupId)).toEqual([CARA]);
    // The durable flag was recorded (void'd write — settle on the condition).
    await until(
      () =>
        q(
          `SELECT identityChangedAt FROM chats WHERE peerId = ?`,
          CARA,
        )[0]?.identityChangedAt != null,
      160,
    );
    expect(
      q(`SELECT identityChangedAt FROM chats WHERE peerId = ?`, CARA)[0]!
        .identityChangedAt,
    ).not.toBeNull();
    // And the other members' legs are live — the identity failure cost
    // nobody else and remains in the same denominator.
    const legs = q(`SELECT peerId, attempts FROM outbox ORDER BY peerId`);
    expect(legs.map(l => l.peerId).sort()).toEqual([BEN, CARA, DAN].sort());
    expect(legs.filter(l => l.peerId !== CARA).every(l => l.attempts === 0)).toBe(true);
    expect(await db.fanoutDeliveryState(result!.localMsgId!)).toMatchObject({
      total: 3,
      failed: 1,
      failedPeerIds: [CARA],
    });
  });
});

// ---------------------------------------------------------------------------
// The design — membership legs NOTIFY: a roster change is a thing that happened
// to you, not a carrier.
// ---------------------------------------------------------------------------

describe('membership legs notify', () => {
  test('grp.roster, grp.set and grp.del legs all queue with notify = 1, and the flushed frames never carry notify:false', async () => {
    await db.upsertChat(BEN, 'Ben');
    await db.upsertChat(CARA, 'Cara');
    const { groupId } = await createMyRoom([BEN, CARA]);

    // grp.roster (a Remove — fans to BEN and, the union, CARA herself).
    const roster = await ownerRosterWrite(groupId, CARA, 'out');
    expect(roster).not.toBeNull();
    let legs = q(`SELECT peerId, notify FROM outbox ORDER BY peerId`);
    // Precondition: the legs this asserts on exist.
    expect(legs.map(l => l.peerId).sort()).toEqual([BEN, CARA].sort());
    expect(legs.every(l => l.notify === 1)).toBe(true);

    // The wire meaning of the bit: the flush omits notify (server default
    // true) rather than sending notify:false — silenced-arrival is exactly
    // what a muted CARRIER gets and a roster change must not.
    await until(() => sentFrames().length >= 2);
    expect(sentFrames().length).toBeGreaterThanOrEqual(2);
    expect(sentFrames().every(f => f.notify !== false)).toBe(true);

    q(`DELETE FROM outbox`);
    ws.calls.send.mockClear();
    crypto.encryptText.mockClear();

    // grp.set (CARA is out of the fold now — one leg, to BEN).
    const timer = await setMyTimer(groupId, 3600);
    expect(timer).not.toBeNull();
    legs = q(`SELECT peerId, notify FROM outbox`);
    expect(legs.map(l => l.peerId)).toEqual([BEN]);
    expect(legs.every(l => l.notify === 1)).toBe(true);

    q(`DELETE FROM outbox`);
    ws.calls.send.mockClear();
    crypto.encryptText.mockClear();

    // grp.del (the non-thread parent changes nothing about the bit).
    const del = await deleteForEveryone(groupId);
    expect(del).not.toBeNull();
    legs = q(`SELECT peerId, notify FROM outbox`);
    expect(legs.map(l => l.peerId)).toEqual([BEN]);
    expect(legs.every(l => l.notify === 1)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The announcement row never expires, and its sq is the
// envelope's n.
// ---------------------------------------------------------------------------

describe('the announcement row: no expiry, ordered by its own n', () => {
  test('a room with a LIVE disappearing timer still stores roster history with expiresAt NULL and sq = n, and the sweep cannot eat it or its unsent legs', async () => {
    await db.upsertChat(BEN, 'Ben');
    await db.upsertChat(CARA, 'Cara');
    const { groupId } = await createMyRoom([BEN, CARA]);

    // A live room timer FIRST — so an announcement row that borrowed the
    // conversation's expiry (or any fixed expiry) would have something real
    // to borrow. Writer lane: create spent 1, so grp.set carries n=2 and the
    // roster write below n=3 — neither 0 nor 1, so a hardcoded sq cannot
    // masquerade as either write's true number.
    const timer = await setMyTimer(groupId, 3600);
    expect(timer).not.toBeNull();
    const roster = await ownerRosterWrite(groupId, BEN, 'out');
    expect(roster).not.toBeNull();

    // Precondition — the timer is genuinely live in the store.
    expect(
      q(
        `SELECT disappearSec FROM group_settings WHERE groupId = ? AND writerId = ?`,
        groupId,
        ME,
      ),
    ).toEqual([{ disappearSec: 3600 }]);

    const rows = q(
      `SELECT body, expiresAt, sq FROM messages
       WHERE peerId = ? AND direction = 'out' ORDER BY ts`,
      groupId,
    ).filter(
      r =>
        String(r.body).includes('"tcm":"grp.set"') ||
        String(r.body).includes('"tcm":"grp.roster"'),
    );
    expect(rows).toHaveLength(2);
    // The rules: roster history is not conversation — it NEVER expires, and
    // each row is ordered by its own write's n (the
    // (ts, authorId, sq) tiebreak), not by a constant.
    expect(rows.every(r => r.expiresAt === null)).toBe(true);
    expect(rows.map(r => r.sq)).toEqual([2, 3]);

    // And the sweep — whose localMsgId join kills a row's unsent legs with
    // it — finds nothing to eat, a day later.
    const legsBefore = q(`SELECT msgId FROM outbox`).length;
    expect(legsBefore).toBeGreaterThan(0); // precondition: live legs at stake
    await db.sweepExpired(Date.now() + 86_400_000);
    expect(
      q(
        `SELECT msgId FROM messages WHERE peerId = ? AND direction = 'out'`,
        groupId,
      ).length,
    ).toBeGreaterThanOrEqual(2);
    expect(q(`SELECT msgId FROM outbox`)).toHaveLength(legsBefore);
  });
});

// ---------------------------------------------------------------------------
// The design — membership legs flush in wire-id order, not roster order.
// ---------------------------------------------------------------------------

describe('membership legs are handed over in wire-id order', () => {
  test('outbox.seq order is the ids’ own sorted order, not the roster’s — deterministically, with ids minted in DESCENDING order', async () => {
    // fanOut's copy of this rule has a dedicated test; the membership copy
    // had none, so deleting its legs.sort(...) shipped a fan-out that
    // flushes in roster order — a deterministic timing signature.
    // Deterministic wire ids, DESCENDING in mint order: draw k fills every
    // byte with (31 - k), so id k is lexicographically below id k-1 in every
    // character. If the sort is gone, enqueue order = compose order =
    // descending ids; sorted, it is their exact reverse.
    await db.upsertChat(BEN, 'Ben');
    await db.upsertChat(CARA, 'Cara');
    await db.upsertChat(DAN, 'Dan');
    await db.upsertChat(EVE, 'Eve');
    const { groupId } = await createMyRoom([BEN, CARA, DAN, EVE]);

    let draw = 0;
    crypto.randomBytes.mockImplementation(async (count: number) => {
      const v = 31 - draw;
      draw += 1;
      return new Uint8Array(count).fill(v);
    });

    const result = await setMyTimer(groupId, 3600);
    expect(result).not.toBeNull();

    const composeOrder = crypto.encryptText.mock.calls
      .map(c => c[1] as string)
      .filter(p => [BEN, CARA, DAN, EVE].includes(p));
    expect(composeOrder).toHaveLength(4);

    const legRows = q(`SELECT msgId, peerId FROM outbox ORDER BY seq`);
    expect(legRows).toHaveLength(4);
    const idOf = new Map(legRows.map(r => [String(r.peerId), String(r.msgId)]));

    // Precondition — the counter burn: ids really minted DESCENDING in
    // compose order, so an unsorted hand-over CANNOT coincide with sorted
    // order (the trap where roster order accidentally equals id order and
    // the assertion below can never fail).
    for (let i = 1; i < composeOrder.length; i++) {
      expect(
        idOf.get(composeOrder[i - 1])! > idOf.get(composeOrder[i])!,
      ).toBe(true);
    }

    // The rule: hand-over (outbox.seq, the transmit order) is the wire ids'
    // OWN sorted order — the exact reverse of the roster walk, here.
    for (let i = 1; i < legRows.length; i++) {
      expect(String(legRows[i - 1].msgId) < String(legRows[i].msgId)).toBe(
        true,
      );
    }
    expect(legRows.map(r => r.peerId)).toEqual([...composeOrder].reverse());
  });
});

// ---------------------------------------------------------------------------
// The design — a fan-out whose every leg settles at enqueue settles its row.
// ---------------------------------------------------------------------------

describe('a fan-out settled entirely at enqueue', () => {
  test('leaving a room whose only other member is blocked settles the announcement row to error — never "Sending…" forever', async () => {
    // Every leg here is a pre-failed ledger row, so no receipt, retry or
    // flush pass will EVER touch this fan-out again: if the enqueue itself
    // does not fold the ledger into the row, nothing else will.
    await deliver(gNew(ROOM, [ANA, ME]), ANA);
    expect(q(`SELECT peerId FROM chats WHERE peerId = ?`, ROOM)).toHaveLength(1);
    await messaging.blockPeer(ANA);
    ws.calls.send.mockClear();
    crypto.encryptText.mockClear();

    const seq = await db.reserveGroupSeq(ROOM, 'writer');
    const result = await messaging.fanOutMembership(
      ROOM,
      { tcm: 'grp.roster', g: ROOM, m: ME, s: 'out', n: seq },
      {
        apply: async () => {
          const store = await db.loadGroupStore(ROOM);
          const applied = applyRosterWrite(
            store,
            ME,
            { writerId: ME, memberId: ME, seq, state: 'out' },
            ownerOnlyPolicy,
          );
          await store.persist();
          return applied.outcome === 'applied';
        },
      },
    );
    expect(result).not.toBeNull();
    expect(result!.failed).toEqual([ANA]);

    // Precondition — EVERY leg settled at enqueue: one leg, already failed.
    const legs = q(`SELECT peerId, attempts, payload FROM outbox`);
    expect(legs).toHaveLength(1);
    expect(legs[0]!.attempts).toBe(db.LEG_FAILED);
    expect(legs[0]!.payload).toBe('');

    // The rule: the announcement row is settled — 'error' (nothing left this
    // phone), not a 'pending' that no later event can ever resolve.
    const rows = q(
      `SELECT status FROM messages
       WHERE peerId = ? AND direction = 'out' AND body LIKE '%grp.roster%'`,
      ROOM,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('error');
  });
});

// ---------------------------------------------------------------------------
// The design — createRoom's failed list names identity-skipped members.
// ---------------------------------------------------------------------------

describe('createRoom names identity-skipped members', () => {
  test('a member skipped over an unaccepted identity change appears in the failed list with the safety-number reason — never a silent omission', async () => {
    // createRoom's only failure fixture anywhere was an encrypt throw (the
    // `failed` spread); dropping the `skipped` spread silently omitted
    // exactly the members the design says must be named.
    await db.upsertChat(BEN, 'Ben');
    await db.upsertChat(CARA, 'Cara');
    messaging.stop();
    await db.setIdentityChanged(BEN, Date.now());
    await messaging.start(ME);
    await flush();
    ws.calls.send.mockClear();
    crypto.encryptText.mockClear();

    const result = await createRoom(ME, 'Kitchen', [BEN, CARA]);

    // Precondition — BEN really was SKIPPED, not composed: his only row is a
    // settled empty failed leg, while CARA's invitation queued (so the
    // fixture exercised the identity path, not a room that failed whole).
    expect(q(`SELECT payload, attempts FROM outbox WHERE peerId = ?`, BEN)).toEqual([
      { payload: '', attempts: db.LEG_FAILED },
    ]);
    expect(q(`SELECT msgId FROM outbox WHERE peerId = ?`, CARA)).toHaveLength(1);

    // The rule: the failed list NAMES him, with the reason the screen shows.
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.peerId).toBe(BEN);
    expect(result.failed[0]!.reason).toMatch(/[Ss]afety number changed/);
    // And names ONLY him — CARA's seat is not slandered.
    expect(result.failed.some(f => f.peerId === CARA)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The design — the invite snapshot carries the ROOM'S name.
// ---------------------------------------------------------------------------

describe('the brand-new member’s grp.new snapshot', () => {
  test('carries the room’s own name in nm — a hardcoded fallback would anchor the room under the wrong name forever', async () => {
    // The Add test asserts the snapshot's tcm, ms and n but never nm — and
    // the anchor name is written ONCE at accept and never updated by any
    // later write, so a wrong nm here is not healed, ever.
    await db.upsertChat(BEN, 'Ben');
    await db.upsertChat(FRAN, 'Fran');
    const { groupId } = await createMyRoom([BEN], 'Ops Deck');

    // Precondition — the stored anchor really carries the name the snapshot
    // must copy, and it is not the 'Room' fallback.
    expect(
      q(`SELECT name FROM groups WHERE groupId = ?`, groupId),
    ).toEqual([{ name: 'Ops Deck' }]);

    const result = await ownerRosterWrite(groupId, FRAN, 'in');
    expect(result).not.toBeNull();

    const composed = composedFor();
    // Precondition — Fran's leg is the snapshot (the seam fired at all).
    expect(composed.get(FRAN)!.tcm).toBe('grp.new');
    // The rule: the snapshot anchors the room under ITS name.
    expect(composed.get(FRAN)!.nm).toBe('Ops Deck');
  });
});

// ---------------------------------------------------------------------------
// The design — the membership payload cap.
// ---------------------------------------------------------------------------

describe('the membership payload cap', () => {
  test('an oversized leg settles as a visible failed leg; nothing over the server’s ceiling is ever queued or flushed', async () => {
    // No oversized fixture existed on the membership path, so deleting the
    // cap whole survived — queueing a frame the server rejects at a size
    // the client cannot see fail (rate/size rejections are silent).
    await db.upsertChat(BEN, 'Ben');
    await db.upsertChat(CARA, 'Cara');
    const { groupId } = await createMyRoom([BEN, CARA]);

    const big = 'A'.repeat(MAX_PAYLOAD_B64_LENGTH + 1);
    // Precondition — the fixture really exceeds the cap the rule names.
    expect(big.length).toBeGreaterThan(MAX_PAYLOAD_B64_LENGTH);
    crypto.encryptText.mockImplementation(
      async (_self: string, peer: string) => {
        if (peer === BEN) return { msgType: 'ciphertext', payload: big };
        return { msgType: 'ciphertext', payload: 'AAAA' };
      },
    );

    const result = await ownerRosterWrite(groupId, CARA, 'out');
    expect(result).not.toBeNull();

    // The rule, half one: BEN's leg is a settled, counted failure — the
    // apply stood, so the outcome is durable, visible, never a throw.
    expect(result!.failed).toEqual([BEN]);
    const benLeg = q(
      `SELECT payload, attempts FROM outbox WHERE peerId = ?`,
      BEN,
    )[0]!;
    expect(benLeg.attempts).toBe(db.LEG_FAILED);
    expect(benLeg.payload).toBe('');

    // Half two: NOTHING over the ceiling is queued, and CARA's leg is live.
    const oversized = q(`SELECT msgId FROM outbox`).filter(
      r =>
        String(
          q(`SELECT payload FROM outbox WHERE msgId = ?`, r.msgId)[0]!.payload,
        ).length > MAX_PAYLOAD_B64_LENGTH,
    );
    expect(oversized).toEqual([]);
    const caraLeg = q(
      `SELECT payload, attempts FROM outbox WHERE peerId = ?`,
      CARA,
    )[0]!;
    expect(caraLeg.attempts).toBe(0);
    expect(caraLeg.payload).toBe('AAAA');

    // And the wire agrees: CARA's frame goes out; BEN never receives one.
    await until(() => sentFrames().length >= 1);
    expect(sentFrames().some(f => f.to === CARA)).toBe(true);
    expect(sentFrames().every(f => f.to !== BEN)).toBe(true);
  });
});
