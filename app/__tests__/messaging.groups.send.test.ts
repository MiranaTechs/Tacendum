/**
 * ROOMS — the OUTBOUND MEMBERSHIP sender.
 *
 * Originally `fanOut` covered `grp.msg` only, and the four membership envelopes —
 * `grp.new`, `grp.roster`, `grp.set`, `grp.del` — cannot ride inside a
 * `grp.msg` (the laundering refusal), so until this seam existed every
 * Add / Remove / Leave / timer / delete-for-everyone applied only on the
 * phone that made it. This file proves the seam on Node's REAL SQLite engine
 * (the recorded op-sqlite mock records statements without executing them —
 * the harness note in messaging.groups.receive.test.ts is the argument):
 *
 *  - each kind fans to the folded membership and to NOBODY else, with the union for roster writes (a Remove reaches the removed member);
 *  - a brand-new member's Add leg carries a `grp.new` snapshot, because a
 *    bare authority write pre-anchor is dropped and never healed;
 *  - one announcement row + N legs in ONE transaction — a crash between
 *    them leaves neither;
 *  - wire ids are uncorrelated at this layer;
 *  - duress writes zero frames; a blocked member makes the room read-only
 *    BEFORE the local apply (throw, not divergence), while the two the design
 *    exits — leave, delete-for-everyone — settle the blocked leg as a
 *    visible failure instead;
 *  - `grp.del` legs survive the counted purge and still transmit;
 *  - membership legs spend the SAME the design pacing budget as messages;
 *  - a failed leg is durable and visible, never silent;
 *  - a `grp.new` sent through the migrated `createRoom` leaves no row in
 *    any 1:1 thread and dies with `deleteGroup`.
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
  // The consent edge routes: a uniform 204 → void. The ONLY things a
  // setRoomConsent test needs to observe are that they were CALLED (the edge
  // is written) and with what — never a return value, because the route
  // deliberately answers the same for everything.
  apiConsentWrite: jest.fn().mockResolvedValue(undefined),
  apiConsentDelete: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../src/decoy', () => ({
  syncDecoyProfile: jest.fn(async () => undefined),
}));

import {
  applyGroupDel,
  applyRosterWrite,
  applySettingsWrite,
  ownerOnlyPolicy,
  unconditionalPolicy,
} from '@tacendum/shared/group-fold';
import * as blocking from '../src/blocking';
import * as db from '../src/db';
import {
  BlockedPeerError,
  FANOUT_PACING,
  groupDeliveryNotice,
  messaging,
} from '../src/messaging';
import { createRoom } from '../src/screens/GroupCreateScreen';
import { session } from '../src/session';

// The drain under test is genuinely slow: The bucket is born EMPTY and
// refills at ~3.83 tokens/s, so even a two-leg fan-out spends real seconds,
// and Jest's DEFAULT 5 s per-test deadline sits close enough for worker-
// scheduling stalls to expire it while nothing is wrong (measured: pinned to
// the efficiency cores, suites in this app fail on exactly that deadline —
// the same class that once handed a review 7 false mutation kills).
// Every ASSERTION deadline in this file is bounded in polls instead (see
// waitForSent); this ceiling is only the backstop against a genuine hang.
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

/** Every `send`-type frame the socket saw, in order. */
function sentFrames(): { to: string; msgId: string }[] {
  return ws.calls.send.mock.calls
    .map(c => c[0] as { type: string; to?: string; msgId?: string })
    .filter(f => f.type === 'send') as { to: string; msgId: string }[];
}

/** Poll the paced drain with real timers (the bucket is born empty).
 * The budget is counted in POLLS, never in wall-clock: each iteration is one
 * 25 ms timer grant from the SAME queue the pacer's resume timer rides, so a
 * stalled worker delays the poll and the drain together instead of expiring
 * the wait — and the bucket refills on wall-clock, so a stall only makes each
 * poll observe MORE progress. (The fixed Date.now() deadline this replaces
 * expired under parallel-worker load for reasons unrelated to the code.)
 * 320 polls is the old 8 s budget at nominal speed; on exhaustion the helper
 * returns and lets the caller's assertion fail loudly. */
async function waitForSent(n: number, maxPolls = 320): Promise<void> {
  for (let poll = 0; sentFrames().length < n; poll++) {
    if (poll >= maxPolls) return; // let the assertion fail loudly
    await new Promise<void>(resolve => setTimeout(() => resolve(), 25));
    await flush();
  }
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

/** Poll until `n` outbox legs are durable. The fan-out is PACED and drains on
 * real timers, so reading `outbox` the instant `createRoom` resolves races the
 * drain — observed failing about 1 run in 6, one leg short. Bounded in POLLS
 * (waitForSent's argument — and this helper's old 4 s wall-clock deadline was
 * the suite's shortest, the first to expire under load), so a leg that never
 * lands still fails the assertion loudly rather than hanging. */
async function waitForLegs(n: number, maxPolls = 160): Promise<void> {
  for (let poll = 0; q(`SELECT msgId FROM outbox`).length < n; poll++) {
    if (poll >= maxPolls) return;
    await new Promise<void>(resolve => setTimeout(() => resolve(), 25));
    await flush();
  }
}

// --- inbound helper (member-side rooms, and members' own writes) ------------

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
  // The invite legs belong to the CREATE fan-out, which has its own test;
  // everything below asserts a LATER fan-out, so clear them out of the way
  // (no receipt ever settles them in this harness).
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
  // REAL platform randomness for the wire ids: the property below is a
  // statement about CSPRNG output, and a deterministic stand-in would make it
  // a statement about the stand-in.
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
  await db.upsertChat(FRAN, 'Fran'); // a bystander with a 1:1 thread
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

describe('the harness itself', () => {
  test('the real engine executes the real schema (not a recorded no-op)', () => {
    const tables = q(
      `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`,
    ).map(r => r.name);
    for (const t of ['groups', 'group_members', 'group_settings', 'outbox']) {
      expect(tables).toContain(t);
    }
  });
});

describe('recipients — the folded membership and nobody else', () => {
  test('grp.new (createRoom): one leg per invitee, none to a bystander, none to the room id, no row in any 1:1 thread', async () => {
    await db.upsertChat(BEN, 'Ben');
    await db.upsertChat(CARA, 'Cara');
    const { groupId } = await createRoom(ME, 'Kitchen', [BEN, CARA]);
    await waitForLegs(2);

    const legs = q(
      `SELECT peerId, localMsgId FROM outbox ORDER BY peerId`,
    );
    expect(legs.map(l => l.peerId)).toEqual([BEN, CARA].sort());
    expect(legs.every(l => l.peerId !== groupId)).toBe(true);
    expect(legs.every(l => l.peerId !== FRAN)).toBe(true);

    // THE MIGRATION'S POINT: the invitation is room-scoped, so the members'
    // PRIVATE 1:1 threads hold no out-row and no "New room" preview — the
    // sendText seam left both on the creator's phone.
    for (const peer of [BEN, CARA, FRAN]) {
      expect(q(`SELECT msgId FROM messages WHERE peerId = ?`, peer)).toEqual([]);
      const chat = q(
        `SELECT lastMessageText FROM chats WHERE peerId = ?`,
        peer,
      )[0];
      expect(chat?.lastMessageText ?? null).toBeNull();
    }
    // The room's own announcement row parents every leg.
    const parent = q(
      `SELECT msgId FROM messages WHERE peerId = ?`,
      groupId,
    )[0]!;
    expect(legs.every(l => l.localMsgId === parent.msgId)).toBe(true);
  });

  test('grp.new invite legs die with deleteGroup — they belong to the room, not to the 1:1 conversations', async () => {
    await db.upsertChat(BEN, 'Ben');
    const { groupId } = await createRoom(ME, 'Kitchen', [BEN]);
    expect(q(`SELECT msgId FROM outbox`)).toHaveLength(1);

    await db.deleteGroup(groupId);
    // The sendText seam's legs survived this exact call (peerId = member,
    // localMsgId NULL). Room-scoped legs must not.
    expect(q(`SELECT msgId FROM outbox`)).toEqual([]);
  });

  test('grp.roster Remove fans to the folded membership INCLUDING the removed member, and to nobody else', async () => {
    for (const [id, name] of [[BEN, 'Ben'], [CARA, 'Cara'], [DAN, 'Dan']]) {
      await db.upsertChat(id, name);
    }
    const { groupId } = await createMyRoom([BEN, CARA, DAN]);

    const result = await ownerRosterWrite(groupId, DAN, 'out');
    expect(result).not.toBeNull();

    const legs = q(`SELECT peerId FROM outbox ORDER BY peerId`);
    // DAN included: "Removing B first is an ordinary owner write that fans
    // to the full roster — B included, so it is not a silent omission."
    expect(legs.map(l => l.peerId).sort()).toEqual([BEN, CARA, DAN].sort());
    // The removed member's leg carries the roster write itself (he holds the
    // anchor; nothing to re-invite).
    expect(composedFor().get(DAN)!.tcm).toBe('grp.roster');
    // The announcement row is in the room, attributed to me.
    const rows = q(
      `SELECT authorId, direction, body FROM messages WHERE peerId = ?`,
      groupId,
    );
    expect(
      rows.filter(r => String(r.body).includes('"tcm":"grp.roster"')),
    ).toHaveLength(1);
    expect(rows.every(r => r.authorId === ME)).toBe(true);
  });

  test('Leave (a member of someone else’s room) fans my sovereign out to every other member', async () => {
    await deliver(gNew(ROOM, [ANA, ME, CARA]), ANA);
    expect(q(`SELECT peerId FROM chats WHERE peerId = ?`, ROOM)).toHaveLength(1); // fixture reaches the engine
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
    const legs = q(`SELECT peerId FROM outbox ORDER BY peerId`);
    expect(legs.map(l => l.peerId).sort()).toEqual([ANA, CARA].sort());
    expect(composedFor().get(ANA)!.s).toBe('out');
  });

  test('grp.set fans to the folded members; a declined apply sends nothing and announces nothing', async () => {
    await db.upsertChat(BEN, 'Ben');
    await db.upsertChat(CARA, 'Cara');
    const { groupId } = await createMyRoom([BEN, CARA]);
    const before = q(`SELECT COUNT(*) AS n FROM messages`)[0]!.n;

    const result = await setMyTimer(groupId, 3600);
    expect(result).not.toBeNull();
    expect(
      q(`SELECT peerId FROM outbox`).map(l => l.peerId).sort(),
    ).toEqual([BEN, CARA].sort());
    expect(composedFor().get(BEN)!.tcm).toBe('grp.set');
    expect(Number(q(`SELECT COUNT(*) AS n FROM messages`)[0]!.n)).toBe(
      Number(before) + 1,
    );

    // The seam's half of announce-only-when-applied (messaging:2370): a
    // closure that reports "declined/stale" fans nothing and writes no row.
    crypto.encryptText.mockClear();
    const declined = await messaging.fanOutMembership(
      groupId,
      { tcm: 'grp.set', g: groupId, s: 60, n: 99 },
      { apply: async () => false },
    );
    expect(declined).toBeNull();
    expect(crypto.encryptText).not.toHaveBeenCalled();
    expect(Number(q(`SELECT COUNT(*) AS n FROM messages`)[0]!.n)).toBe(
      Number(before) + 1,
    );
  });

  test('Add: a brand-new member’s leg carries the grp.new snapshot (a bare pre-anchor authority write is dropped); the rest get the roster write', async () => {
    await db.upsertChat(BEN, 'Ben');
    await db.upsertChat(CARA, 'Cara');
    const { groupId } = await createMyRoom([BEN, CARA]);

    const result = await ownerRosterWrite(groupId, FRAN, 'in');
    expect(result).not.toBeNull();

    const legs = q(`SELECT peerId FROM outbox ORDER BY peerId`);
    expect(legs.map(l => l.peerId).sort()).toEqual([BEN, CARA, FRAN].sort());
    const composed = composedFor();
    // FRAN has never held the room: a bare grp.roster would be dropped on
    // her phone with no later write to heal it — her leg is the room itself.
    expect(composed.get(FRAN)!.tcm).toBe('grp.new');
    expect((composed.get(FRAN)!.ms as string[]).sort()).toEqual(
      [ME, BEN, CARA, FRAN].sort(),
    );
    // Same n on both shapes: one write, not an equivocation.
    expect(composed.get(FRAN)!.n).toBe(composed.get(BEN)!.n);
    expect(composed.get(BEN)!.tcm).toBe('grp.roster');
    expect(composed.get(BEN)!.m).toBe(FRAN);
  });

  test('re-Add of a member who LEFT keeps the roster-write leg — his phone holds the anchor and renders it as the invitation', async () => {
    await db.upsertChat(BEN, 'Ben');
    await db.upsertChat(CARA, 'Cara');
    const { groupId } = await createMyRoom([BEN, CARA]);
    await deliver(gRoster(groupId, BEN, 'out', 1), BEN); // Ben leaves
    ws.calls.send.mockClear();
    crypto.encryptText.mockClear();

    const result = await ownerRosterWrite(groupId, BEN, 'in');
    expect(result).not.toBeNull();
    expect(composedFor().get(BEN)!.tcm).toBe('grp.roster');
    // And the write did not readmit him locally — only his own `in` can.
    const slots = await db.listGroupMemberSlots(groupId);
    expect(
      slots.find(s => s.memberId === BEN && s.writerId === BEN)!.state,
    ).toBe('out');
  });
});

describe('wire ids at this layer', () => {
  test('no two legs of one membership fan-out share more than 6 leading characters or sit adjacent under base-32 successor', async () => {
    const others: string[] = [];
    for (let i = 0; i < 11; i++) {
      const id = pad(`X${i}Z`);
      others.push(id);
      await db.upsertChat(id, `X ${i}`);
    }
    const { groupId } = await createMyRoom(others);

    const result = await ownerRosterWrite(groupId, others[0], 'out');
    expect(result).not.toBeNull();
    const ids = q(
      `SELECT msgId FROM outbox WHERE localMsgId = ?`,
      result!.localMsgId,
    ).map(r => String(r.msgId));
    expect(ids).toHaveLength(11);

    const shared = (a: string, b: string): number => {
      let k = 0;
      while (k < a.length && a[k] === b[k]) k++;
      return k;
    };
    const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    const asNum = (s: string): bigint => {
      let v = 0n;
      for (const ch of s) v = v * 32n + BigInt(B32.indexOf(ch));
      return v;
    };
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        expect(shared(ids[i], ids[j])).toBeLessThanOrEqual(6);
        const gap = asNum(ids[i]) - asNum(ids[j]);
        expect(gap === 1n || gap === -1n).toBe(false);
      }
    }
  });
});

describe('one transaction — a crash between the row and the legs leaves neither', () => {
  test('a failure on the Nth leg INSERT rolls back the announcement row and every earlier leg', async () => {
    await db.upsertChat(BEN, 'Ben');
    await db.upsertChat(CARA, 'Cara');
    const { groupId } = await createMyRoom([BEN, CARA]);
    const messagesBefore = q(`SELECT COUNT(*) AS n FROM messages`)[0]!.n;

    const instance = sqlite.__sqlite.instances.get('tacendum.sqlite')!;
    const real = instance.execute.getMockImplementation()!;
    let legInserts = 0;
    instance.execute.mockImplementation(
      async (sql: unknown, params?: unknown[]) => {
        if (String(sql).includes('INSERT INTO outbox')) {
          legInserts += 1;
          if (legInserts === 2) throw new Error('injected crash');
        }
        return real(sql, params);
      },
    );
    await expect(ownerRosterWrite(groupId, CARA, 'out')).rejects.toThrow(
      'injected crash',
    );
    instance.execute.mockImplementation(real);

    // NEITHER: no announcement row landed, no orphan leg survived.
    expect(Number(q(`SELECT COUNT(*) AS n FROM messages`)[0]!.n)).toBe(
      Number(messagesBefore),
    );
    expect(q(`SELECT msgId FROM outbox`)).toEqual([]);
  });
});

describe('duress', () => {
  test('a duress session applies locally, writes ONE decoy announcement row, and puts ZERO frames on the wire', async () => {
    await db.upsertChat(BEN, 'Ben');
    const { groupId } = await createMyRoom([BEN]);
    session.setMode('duress');

    const result = await ownerRosterWrite(groupId, BEN, 'out');
    await flush();
    await new Promise<void>(resolve => setTimeout(() => resolve(), 400));
    await flush();

    expect(sentFrames()).toEqual([]);
    expect(q(`SELECT msgId FROM outbox`)).toEqual([]); // no legs, ever
    // The announcement still visibly happened (the decoy must not go inert):
    // localEcho's row, already 'sent'.
    const rows = q(
      `SELECT body, status FROM messages WHERE peerId = ? ORDER BY ts`,
      groupId,
    );
    expect(
      rows.filter(r => String(r.body).includes('"tcm":"grp.roster"')),
    ).toHaveLength(1);
    expect(result!.localMsgId).not.toBeNull();
    // And the apply ran against the (decoy) store.
    const slots = await db.listGroupMemberSlots(groupId);
    expect(
      slots.find(s => s.memberId === BEN && s.writerId === ME)!.state,
    ).toBe('out');
  });
});

describe('quiesce: a relock mid-fan-out', () => {
  test('composition STOPS at the relock, and nothing is written', async () => {
    // A gate found this seam live in the code but pinned by no test at all,
    // while its committed twin (messaging.fanout.test.ts, the grp.msg path)
    // has exactly this assertion. The quiesce row requires proving it
    // "with a relock injected mid-fan-out"; for this path that proof was
    // missing, so a refactor could delete the per-leg check and every test
    // would stay green.
    const others: string[] = [];
    for (let i = 0; i < 10; i++) {
      const id = pad(`Q${i}Z`);
      others.push(id);
      await db.upsertChat(id, `Q ${i}`);
    }
    const { groupId } = await createMyRoom(others);
    crypto.encryptText.mockClear();

    let calls = 0;
    crypto.encryptText.mockImplementation(async () => {
      calls += 1;
      if (calls === 3) messaging.stop(); // the relock, mid-compose
      return { msgType: 'ciphertext', payload: 'Q0lQSEVS' };
    });

    await expect(ownerRosterWrite(groupId, others[0]!, 'out')).rejects.toThrow(
      'messaging not started',
    );

    // Nothing landed: the single transaction had not run, so no leg and no
    // row can appear in whichever workspace opens next.
    expect(q(`SELECT msgId FROM outbox`)).toEqual([]);

    // And it stopped AT the relock rather than merely writing nothing. A
    // single pre-commit check would also write nothing — while running the
    // ratchet seven more times against a store the relock is closing. The
    // mutation that deletes the PER-LEG check makes this read 11.
    expect(crypto.encryptText).toHaveBeenCalledTimes(3);
  });
});

describe('blocking', () => {
  test('a blocked member makes the room read-only: Remove/Add/timer throw BEFORE the local apply — no divergence, no allocation', async () => {
    await db.upsertChat(BEN, 'Ben');
    await db.upsertChat(CARA, 'Cara');
    await db.upsertChat(EVE, 'Eve');
    const { groupId } = await createMyRoom([BEN, CARA, EVE]);
    await messaging.blockPeer(EVE);
    crypto.encryptText.mockClear();
    ws.calls.send.mockClear();

    await expect(ownerRosterWrite(groupId, CARA, 'out')).rejects.toThrow(
      BlockedPeerError,
    );
    await expect(setMyTimer(groupId, 3600)).rejects.toThrow(BlockedPeerError);

    // BEFORE the apply: Cara's seat is untouched — a refused write must not
    // fork this phone's roster from everyone else's (the defect class).
    const slots = await db.listGroupMemberSlots(groupId);
    expect(
      slots.find(s => s.memberId === CARA && s.writerId === ME)!.state,
    ).toBe('in');
    // Before ANY allocation: nothing composed, nothing queued, nothing rowed.
    expect(crypto.encryptText).not.toHaveBeenCalled();
    expect(q(`SELECT msgId FROM outbox`)).toEqual([]);
    expect(
      q(
        `SELECT body FROM messages WHERE peerId = ? AND body LIKE '%grp.set%'`,
        groupId,
      ),
    ).toEqual([]);
  });

  test('membership gates consult the ROOM kind — groupRoster on every seat, never the 1:1 message row', async () => {
    // Behaviour cannot pin this (every table row is false), so the routing
    // is pinned directly: groupRoster is the row already carrying the design's
    // two argued exits (leave, delete-for-everyone), and a membership write
    // still reading 'message' — or 'groupMessage' — would inherit someone
    // else's future argument instead of forcing its own.
    await db.upsertChat(BEN, 'Ben');
    await db.upsertChat(CARA, 'Cara');
    const { groupId } = await createMyRoom([BEN, CARA]);
    const gate = jest.spyOn(blocking, 'maySendTo');

    const result = await ownerRosterWrite(groupId, CARA, 'out');
    expect(result).not.toBeNull();

    const kinds = gate.mock.calls.map(c => c[0]);
    // Pre-apply gate plus the per-leg gate: Ben and Cara at each site.
    expect(kinds.filter(k => k === 'groupRoster')).toHaveLength(4);
    expect(kinds).not.toContain('message');
    expect(kinds).not.toContain('groupMessage');
    gate.mockRestore();
  });

  test('Leave still works from a blocked room (it is offered as the way out): the blocked member’s leg settles as a VISIBLE failure, zero frames to them', async () => {
    await deliver(gNew(ROOM, [ANA, ME, EVE]), ANA);
    await messaging.blockPeer(EVE);
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
    expect(result!.failed).toEqual([EVE]);

    // Eve's leg is a settled LEG_FAILED ledger row: counted by "Not
    // delivered to N of M", payload empty so it can never transmit.
    const eveLeg = q(
      `SELECT payload, attempts FROM outbox WHERE peerId = ?`,
      EVE,
    )[0]!;
    expect(eveLeg.attempts).toBe(db.LEG_FAILED);
    expect(eveLeg.payload).toBe('');
    expect(crypto.encryptText.mock.calls.every(c => c[1] !== EVE)).toBe(true);

    await waitForSent(1);
    expect(sentFrames().some(f => f.to === ANA)).toBe(true);
    expect(sentFrames().every(f => f.to !== EVE)).toBe(true);
  });

  test('a leg written off by the QUEUED-ENVELOPE block gate notifies — the thread repaints instead of lagging until an unrelated event', async () => {
    // flushPending's block-refusal branch called
    // markLegFailed without setting `errored`, so the pass-end notify was
    // skipped and the delivery notice lagged indefinitely.
    await db.upsertChat(BEN, 'Ben');
    const { groupId } = await createMyRoom([BEN]);
    // Enqueue one live leg. The bucket is born empty, so the flush pass
    // inside this call breaks before transmitting: the leg is durably queued
    // at attempts=0 with the ~261 ms resume timer armed.
    await setMyTimer(groupId, 3600);
    expect(
      Number(q(`SELECT attempts FROM outbox WHERE peerId = ?`, BEN)[0]!.attempts),
    ).toBe(0);

    // NOW the block lands — the second-line defence's exact window: the leg
    // was enqueued before the block could purge it. Simulated at the gate
    // itself so ONLY flushPending's queuedEnvelope row answers false.
    const real = blocking.maySendTo;
    const gate = jest
      .spyOn(blocking, 'maySendTo')
      .mockImplementation((kind, st) =>
        kind === 'queuedEnvelope' ? false : real(kind, st),
      );
    const repaints = jest.fn();
    const unsub = messaging.subscribe(repaints);

    // The resume pass finds the gate closed and writes the leg off…
    for (let poll = 0; poll < 320; poll++) {
      const leg = q(`SELECT attempts FROM outbox WHERE peerId = ?`, BEN)[0];
      if (leg !== undefined && Number(leg.attempts) === db.LEG_FAILED) break;
      await new Promise<void>(resolve => setTimeout(() => resolve(), 25));
      await flush();
    }
    await flush(); // let the pass reach its end-of-pass notify
    expect(
      Number(q(`SELECT attempts FROM outbox WHERE peerId = ?`, BEN)[0]!.attempts),
    ).toBe(db.LEG_FAILED);
    // …and the settle NOTIFIES: before the fix, nothing repainted here.
    expect(repaints).toHaveBeenCalled();
    unsub();
    gate.mockRestore();
  });
});

describe('delete for everyone', () => {
  test('delete-for-everyone still works from a blocked room — the SECOND way out', async () => {
    // A gate closed `grp.del`'s clause of `isExit` and NOTHING failed: an
    // owner with any blocked member could never delete the room for everyone,
    // which shuts the second of the two exits the design promises from a read-only
    // room. The Leave test covers the first exit; this covers the other.
    const { groupId } = await createMyRoom([BEN, EVE]);
    await messaging.blockPeer(EVE);
    ws.calls.send.mockClear();
    crypto.encryptText.mockClear();

    const result = await deleteForEveryone(groupId);
    expect(result).not.toBeNull();

    // The purge ran locally — the exit is real, not merely un-thrown.
    expect(q(`SELECT groupId FROM groups WHERE groupId = ?`, groupId)).toEqual(
      [],
    );
    // Ben is told; Eve is not, and her leg is a settled visible failure
    // rather than a silent omission (the whole argument).
    expect(result!.failed).toEqual([EVE]);
    const eveLeg = q(`SELECT payload, attempts FROM outbox WHERE peerId = ?`, EVE)[0]!;
    expect(eveLeg.attempts).toBe(db.LEG_FAILED);
    expect(eveLeg.payload).toBe('');
    await waitForSent(1);
    expect(sentFrames().map(f => f.to)).toEqual([BEN]);
  });

  test('the purge runs locally AND the grp.del legs survive it and transmit — the purge must not eat the frames announcing it', async () => {
    await db.upsertChat(BEN, 'Ben');
    await db.upsertChat(CARA, 'Cara');
    const { groupId } = await createMyRoom([BEN, CARA]);

    const result = await deleteForEveryone(groupId);
    expect(result).not.toBeNull();

    // The full the design purge, on the real engine.
    expect(q(`SELECT groupId FROM groups WHERE groupId = ?`, groupId)).toEqual([]);
    expect(q(`SELECT groupId FROM group_members WHERE groupId = ?`, groupId)).toEqual([]);
    expect(q(`SELECT peerId FROM chats WHERE peerId = ?`, groupId)).toEqual([]);
    expect(q(`SELECT msgId FROM messages WHERE peerId = ?`, groupId)).toEqual([]);

    // And the delete still leaves this phone: one live leg per member,
    // parented OUTSIDE the room so no purge join can reach them.
    const legs = q(`SELECT peerId, localMsgId, payload FROM outbox ORDER BY peerId`);
    expect(legs.map(l => l.peerId)).toEqual([BEN, CARA].sort());
    expect(legs.every(l => l.payload !== '')).toBe(true);
    expect(composedFor().get(BEN)!.tcm).toBe('grp.del');
    const parentPeer = q(
      `SELECT peerId FROM messages WHERE msgId = ?`,
      legs[0]!.localMsgId,
    )[0]!;
    expect(parentPeer.peerId).not.toBe(groupId);

    await waitForSent(2);
    expect(sentFrames().map(f => f.to).sort()).toEqual([BEN, CARA].sort());
  });

  test('a non-owner cannot emit grp.del through the seam at all', async () => {
    await deliver(gNew(ROOM, [ANA, ME, CARA]), ANA);
    ws.calls.send.mockClear();
    await expect(deleteForEveryone(ROOM)).rejects.toThrow(/owner/);
    expect(q(`SELECT msgId FROM outbox`)).toEqual([]);
    // And the room survived: the apply (which would have declined anyway)
    // was never reached with a purge.
    expect(q(`SELECT peerId FROM chats WHERE peerId = ?`, ROOM)).toHaveLength(1);
  });
});

describe('a failed leg is visible, never silent', () => {
  test('a member whose leg cannot be composed becomes a settled failed leg behind the announcement row, and the notice names the numbers', async () => {
    await db.upsertChat(BEN, 'Ben');
    await db.upsertChat(CARA, 'Cara');
    const { groupId } = await createMyRoom([BEN, CARA]);
    crypto.encryptText.mockImplementation(
      async (_self: string, peer: string) => {
        if (peer === CARA) throw new Error('ratchet said no');
        return { msgType: 'ciphertext', payload: 'AAAA' };
      },
    );

    const result = await ownerRosterWrite(groupId, BEN, 'out');
    expect(result).not.toBeNull();
    // The apply stood, so the outcome is recorded, not thrown away.
    expect(result!.failed).toEqual([CARA]);
    const state = await db.fanoutDeliveryState(result!.localMsgId!);
    expect(state.failed).toBe(1);
    expect(state.failedPeerIds).toEqual([CARA]);
    expect(groupDeliveryNotice(state)).toBe('Not delivered to 1 of 2');
    // The announcement row exists and still carries the change.
    expect(
      q(
        `SELECT body FROM messages WHERE msgId = ?`,
        result!.localMsgId,
      ),
    ).toHaveLength(1);
  });

  test('listFanoutFailures batches the thread’s failed fan-outs in ONE read — the failed rows only, keyed to the room thread, never a 1:1', async () => {
    // The screen must not run fanoutDeliveryState per row per render: this
    // is the batch the thread refresh loads instead.
    await db.upsertChat(BEN, 'Ben');
    await db.upsertChat(CARA, 'Cara');
    const { groupId } = await createMyRoom([BEN, CARA]);
    crypto.encryptText.mockImplementation(
      async (_self: string, peer: string) => {
        if (peer === CARA) throw new Error('ratchet said no');
        return { msgType: 'ciphertext', payload: 'AAAA' };
      },
    );
    const failedFan = await ownerRosterWrite(groupId, BEN, 'out');
    // A second, CLEAN fan-out in the same thread: it must contribute nothing.
    crypto.encryptText.mockImplementation(async () => ({
      msgType: 'ciphertext',
      payload: 'AAAA',
    }));
    await setMyTimer(groupId, 3600);

    const failures = await db.listFanoutFailures(groupId);
    expect(failures).toEqual([
      { localMsgId: failedFan!.localMsgId, failed: 1, total: 2 },
    ]);
    // A 1:1 thread never grows a row: legs are room-only by construction
    // (outbox.localMsgId is written exclusively by enqueueOutgoingFanout).
    expect(await db.listFanoutFailures(FRAN)).toEqual([]);
    // And the numbers agree with the per-message ledger read the sentence is
    // defined on — one source of truth, two access paths.
    const state = await db.fanoutDeliveryState(failedFan!.localMsgId!);
    expect(state.failed).toBe(failures[0]!.failed);
    expect(state.total).toBe(failures[0]!.total);
  });

  test('an identity-changed member is named in the safety banner AND counted by the delivery notice', async () => {
    await db.upsertChat(BEN, 'Ben');
    await db.upsertChat(CARA, 'Cara');
    const { groupId } = await createMyRoom([BEN, CARA]);
    messaging.stop();
    await db.setIdentityChanged(BEN, Date.now());
    await messaging.start(ME);
    await flush();
    ws.calls.send.mockClear();
    crypto.encryptText.mockClear();

    const result = await ownerRosterWrite(groupId, CARA, 'out');
    expect(result).not.toBeNull();
    expect(result!.skipped).toEqual([BEN]);
    expect(messaging.skippedInRoom(groupId)).toEqual([BEN]);
    // Cara's live leg (the removed member) exists. Ben cannot be encrypted
    // to, but still gets a settled empty failed leg: the room banner names
    // the safety-number reason while the event row honestly counts the
    // non-delivery in its denominator.
    const legs = q(`SELECT peerId, payload, attempts FROM outbox ORDER BY peerId`);
    expect(legs.map(l => l.peerId)).toEqual([BEN, CARA].sort());
    const benLeg = legs.find(l => l.peerId === BEN)!;
    expect(benLeg.payload).toBe('');
    expect(benLeg.attempts).toBe(db.LEG_FAILED);
    const state = await db.fanoutDeliveryState(result!.localMsgId!);
    expect(state).toMatchObject({ total: 2, failed: 1 });
    expect(state.failedPeerIds).toEqual([BEN]);
    expect(groupDeliveryNotice(state)).toBe('Not delivered to 1 of 2');
  });
});

describe('membership frames spend the same pacing budget as messages', () => {
  test('the shipped pacing PAIR cannot exceed 24 in any window, and stays under the server ceiling', () => {
    // The behavioural test below cannot catch a widened pair — a gate proved
    // it: the per-leg jitter spreads the drain, so raising the window to the
    // server's own 30 still passes a frame-counting assertion, while the
    // bucket genuinely permits 29 per 6 s instead of 23. So the invariant is
    // pinned as arithmetic. A bucket emits `burst + window x refill`, and
    // The rule binds the PAIR, not the capacity alone.
    expect(FANOUT_PACING.worstCaseInWindow).toBeLessThanOrEqual(
      FANOUT_PACING.windowFrames,
    );
    expect(FANOUT_PACING.windowFrames).toBe(24);
    // Strictly below the server's, because the design says the client cannot see a
    // rate-limit rejection: tripping it fails silently.
    expect(FANOUT_PACING.windowFrames).toBeLessThan(
      FANOUT_PACING.serverWindowFrames,
    );
    // Capacity 1 is load-bearing for the jitter as well: a burst of two
    // legs in one tick is exactly the co-timing the jitter exists to break.
    expect(FANOUT_PACING.burst).toBe(1);
  });

  beforeEach(() => {
    jest.useFakeTimers();
  });

  test('a message fan-out plus a roster fan-out never exceed 24 frames in any 6-second window, and every leg sends exactly once', async () => {
    // Deterministic but NON-linear per draw (a linear ramp repeats its low
    // five bits every 32 draws, which collides two wire ids' whole alphabet).
    let draw = 0;
    crypto.randomBytes.mockImplementation(async (count: number) => {
      draw += 1;
      const out = new Uint8Array(count);
      for (let i = 0; i < count; i++) {
        out[i] = (Math.imul((draw << 8) + i + 1, 2654435761) >>> 13) & 0xff;
      }
      return out;
    });
    const others: string[] = [];
    for (let i = 0; i < 11; i++) {
      const id = pad(`X${i}Z`);
      others.push(id);
      await db.upsertChat(id, `X ${i}`);
    }
    const { groupId } = await createMyRoom(others);

    const times: number[] = [];
    const t0 = Date.now();
    ws.calls.send.mockImplementation((frame: unknown) => {
      if ((frame as { type: string }).type === 'send') {
        times.push(Date.now() - t0);
      }
      return true;
    });

    // THREE fan-outs, not two. A gate found the earlier version drove 22
    // frames against a ceiling of 24 — so `count <= 24` could not fail, and
    // raising FANOUT_WINDOW_FRAMES to the server's own 30 passed it. A test
    // whose named bound cannot fire proves nothing; 33 frames is past the
    // ceiling, so the pacing is what holds the window, not the fixture size.
    await messaging.fanOut(groupId, 'hello everyone');
    await ownerRosterWrite(groupId, others[0], 'out');
    await messaging.fanOut(groupId, 'and again');

    await jest.advanceTimersByTimeAsync(30_000);
    expect(times).toHaveLength(33); // each leg exactly once, both kinds paced

    for (let i = 0; i < times.length; i++) {
      let count = 0;
      for (let j = i; j < times.length && times[j] < times[i] + 6_000; j++) {
        count++;
      }
      expect(count).toBeLessThanOrEqual(24);
    }
  });
});

describe('history sharing — the seams that are not about the happy path', () => {
  /** Real words in the room, so there is something to relay. */
  async function seedTalk(groupId: string, n: number): Promise<void> {
    for (let i = 0; i < n; i++) {
      await db.insertMessage({
        msgId: `${BEN}.H${String(i).padStart(25, '0')}`,
        peerId: groupId,
        direction: 'in',
        body: `what Ben said ${i}`,
        ts: 1_000 + i,
        status: 'received',
        authorId: BEN,
      });
    }
  }

  test('a duress session relays NOTHING and puts zero frames on the wire', async () => {
    await db.upsertChat(BEN, 'Ben');
    const { groupId } = await createMyRoom([BEN]);
    await seedTalk(groupId, 3);
    session.setMode('duress');

    const result = await messaging.shareHistory(groupId, BEN, 50);
    await flush();
    await new Promise<void>(resolve => setTimeout(() => resolve(), 400));
    await flush();

    // The whole point of the decoy: a coerced unlock must not be able to
    // extract a room's history, and the wire is the thing an observer sees.
    expect(sentFrames()).toEqual([]);
    expect(q(`SELECT msgId FROM outbox`)).toEqual([]);
    expect(result.shared).toBe(0);
    // Not inert either — the decoy still shows the announcement it would
    // have shown, or the absence is itself the tell the design exists to prevent.
    const rows = q(
      `SELECT body FROM messages WHERE peerId = ? ORDER BY ts`,
      groupId,
    );
    expect(
      rows.filter(r => String(r.body).includes('"tcm":"grp.hist"')),
    ).toHaveLength(1);
  });

  test('a room holding someone I blocked cannot have its history shared', async () => {
    await db.upsertChat(BEN, 'Ben');
    await db.upsertChat(EVE, 'Eve');
    const { groupId } = await createMyRoom([BEN, EVE]);
    await seedTalk(groupId, 2);
    await messaging.blockPeer(EVE);
    crypto.encryptText.mockClear();
    ws.calls.send.mockClear();

    // A blocked member makes the room read-only, and relaying history is
    // speech about the whole room — it must not be an exit from that rule.
    // Refused BEFORE any allocation: no announcement, no legs, no ciphertext.
    await expect(messaging.shareHistory(groupId, BEN, 50)).rejects.toThrow();
    expect(sentFrames()).toEqual([]);
    expect(q(`SELECT msgId FROM outbox`)).toEqual([]);
    expect(
      q(`SELECT msgId FROM messages WHERE peerId = ? AND body LIKE '%grp.hist%'`, groupId),
    ).toEqual([]);
  });

  test('the extent is a CEILING, not a promise: a short room relays what it has', async () => {
    await db.upsertChat(BEN, 'Ben');
    const { groupId } = await createMyRoom([BEN]);
    await seedTalk(groupId, 3);

    const result = await messaging.shareHistory(groupId, BEN, 200);
    expect(result.shared).toBe(3);
    // And the announcement states what actually moved, not what was asked
    // for — a room told "200 messages" when three moved is a lie the room
    // cannot check.
    const announcement = crypto.encryptText.mock.calls
      .map(c => { try { return JSON.parse(String(c[2])); } catch { return null; } })
      .find(e => e && e.tcm === 'grp.hist' && e.e === undefined);
    expect(announcement.c).toBe(3);
  });

  test('a room with nothing shareable announces nothing at all', async () => {
    await db.upsertChat(BEN, 'Ben');
    const { groupId } = await createMyRoom([BEN]);
    // No words: only the room's own creation announcement, which is not
    // history. Announcing a share of zero messages would be noise in
    // everyone's thread for an event that did not happen.
    const result = await messaging.shareHistory(groupId, BEN, 50);
    expect(result).toEqual({ shared: 0, announced: false });
    const hist = crypto.encryptText.mock.calls
      .map(c => { try { return JSON.parse(String(c[2])); } catch { return null; } })
      .filter(e => e && e.tcm === 'grp.hist');
    expect(hist).toEqual([]);
  });

  test('a person who is not in the room is refused before anything is composed', async () => {
    await db.upsertChat(BEN, 'Ben');
    await db.upsertChat(EVE, 'Eve');
    const { groupId } = await createMyRoom([BEN]);
    await seedTalk(groupId, 2);
    crypto.encryptText.mockClear();

    // `only` intersects the folded roster, so a non-member would silently
    // receive nothing — but silence here would look like a successful share.
    await expect(messaging.shareHistory(groupId, EVE, 50)).rejects.toThrow(
      /not in this room/i,
    );
    expect(crypto.encryptText.mock.calls).toEqual([]);
  });
});

describe('setRoomConsent — the member-consent decision', () => {
  const api = jest.requireMock('../src/api') as {
    apiConsentWrite: jest.Mock;
    apiConsentDelete: jest.Mock;
  };
  beforeEach(() => {
    api.apiConsentWrite.mockClear().mockResolvedValue(undefined);
    api.apiConsentDelete.mockClear().mockResolvedValue(undefined);
  });

  const consentRows = (groupId: string): Row[] =>
    q(
      `SELECT msgId, body, authorId, direction FROM messages
       WHERE peerId = ? AND body LIKE '%grp.consent%'`,
      groupId,
    );

  test('share writes the global edge FIRST, records the local decision, and announces it to the room', async () => {
    const { groupId } = await createMyRoom([DAN]);
    const res = await messaging.setRoomConsent(groupId, DAN, true);
    // 1. THE EDGE — the only delivery-gating act. Written, not deleted.
    expect(api.apiConsentWrite).toHaveBeenCalledWith('token-1', DAN);
    expect(api.apiConsentDelete).not.toHaveBeenCalled();
    // 2. THIS CLIENT'S OWN RECORD (the 204 is uniform, so the local row
    //    is the only place the app knows it tried).
    expect(await db.getAgentConsent(DAN)).toBe('consented');
    // 3. THE GROUP-VISIBLE ANNOUNCEMENT — one out-row carrying the stance,
    //    sealed into the room; the relay never parsed it.
    const rows = consentRows(groupId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.direction).toBe('out');
    expect(JSON.parse(String(rows[0]!.body))).toMatchObject({
      tcm: 'grp.consent',
      g: groupId,
      a: DAN,
      s: 'share',
    });
    expect(res).toEqual({ atCap: false, announced: true });
  });

  test('hold deletes the edge and records the refusal — "refusing writes nothing" on the server', async () => {
    const { groupId } = await createMyRoom([DAN]);
    await messaging.setRoomConsent(groupId, DAN, false);
    expect(api.apiConsentDelete).toHaveBeenCalledWith('token-1', DAN);
    expect(api.apiConsentWrite).not.toHaveBeenCalled();
    expect(await db.getAgentConsent(DAN)).toBe('refused');
    // The load-bearing announcement: "isn't sharing" rides as `hold`.
    expect(JSON.parse(String(consentRows(groupId)[0]!.body))).toMatchObject({
      s: 'hold',
      a: DAN,
    });
  });

  test('the edge is written FIRST: a refused POST leaves NOTHING local or group-visible claiming the stance', async () => {
    const { groupId } = await createMyRoom([DAN]);
    api.apiConsentWrite.mockRejectedValueOnce(new Error('refused'));
    await expect(messaging.setRoomConsent(groupId, DAN, true)).rejects.toBeTruthy();
    // The decision did not take: no local record, no announcement row.
    expect(await db.getAgentConsent(DAN)).toBe('undecided');
    expect(consentRows(groupId)).toHaveLength(0);
  });

  test('m2: the CONSENT_MAX_EDGES-th successful share does NOT flag the cap — the server stores while edges < the ceiling, so it took', async () => {
    const { groupId } = await createMyRoom([DAN]);
    // 15 other agents already locally consented; DAN makes 16 (= the ceiling) —
    // the last the server still stores. A local count of EXACTLY the ceiling
    // implies nothing was dropped, so there is no cap note. (With `>=` reverted
    // in, this expects `true` and goes red — the off-by-one this test exists to catch.)
    for (let i = 0; i < 15; i++) {
      await db.setAgentConsent(pad('CONS' + String(i).padStart(3, '0')), 'consented', 1000 + i);
    }
    const res = await messaging.setRoomConsent(groupId, DAN, true); // the 16th
    expect(await db.countConsentedAgents()).toBe(16);
    expect(res.atCap).toBe(false);
    // The edge was still written and announced regardless of the cap note.
    expect(api.apiConsentWrite).toHaveBeenCalledWith('token-1', DAN);
    expect(consentRows(groupId)).toHaveLength(1);
  });

  test('m2: only a count ABOVE the ceiling flags the cap — 17 is the first that implies a prior full slate and a possibly-dropped write', async () => {
    const { groupId } = await createMyRoom([DAN]);
    // 16 other agents already locally consented; DAN would be the 17th — the
    // first the server may have silently dropped over the cap.
    for (let i = 0; i < 16; i++) {
      await db.setAgentConsent(pad('CONS' + String(i).padStart(3, '0')), 'consented', 1000 + i);
    }
    const res = await messaging.setRoomConsent(groupId, DAN, true); // the 17th
    expect(await db.countConsentedAgents()).toBe(17);
    expect(res.atCap).toBe(true);
    // Still written and announced — the cap note is advisory, never an error,
    // and never reads the server (there is no read route).
    expect(api.apiConsentWrite).toHaveBeenCalledWith('token-1', DAN);
    expect(consentRows(groupId)).toHaveLength(1);
  });

  test('below the ceiling, share does not flag the cap; and a hold never does', async () => {
    const { groupId } = await createMyRoom([DAN]);
    await db.setAgentConsent(pad('CONS000'), 'consented', 1000);
    expect((await messaging.setRoomConsent(groupId, DAN, true)).atCap).toBe(false);
    expect((await messaging.setRoomConsent(groupId, DAN, false)).atCap).toBe(false);
  });

  test('m4: a duress session touches NO edge route and NO wire, throws nothing, and presents as success', async () => {
    const { groupId } = await createMyRoom([DAN]);
    // The token is still 'token-1' from start() in real mode — the coordinator's
    // point: the duress seam must NOT lean on `this.token` being null. Flip only
    // the session mode, exactly as a coerced unlock does.
    session.setMode('duress');
    ws.calls.send.mockClear();

    const res = await messaging.setRoomConsent(groupId, DAN, true);
    await flush();
    await new Promise<void>(resolve => setTimeout(() => resolve(), 200));
    await flush();

    // No server edge (the delivery-gating act) — neither write nor delete.
    expect(api.apiConsentWrite).not.toHaveBeenCalled();
    expect(api.apiConsentDelete).not.toHaveBeenCalled();
    // No announcement: no wire frame, no outbox leg, no consent row in the room.
    expect(sentFrames()).toEqual([]);
    expect(q(`SELECT msgId FROM outbox`)).toEqual([]);
    expect(consentRows(groupId)).toEqual([]);
    // Presents as success (the caller reads `announced` — a throw or `false`
    // would surface an error/decoy-tell), and the decoy row reflects the choice
    // like every other decoy action. Reverting the branch calls apiConsentWrite
    // (token is truthy here), so this whole test goes red.
    expect(res).toEqual({ atCap: false, announced: true });
    expect(await db.getAgentConsent(DAN)).toBe('consented');
  });

  test('m1: relay-blindness — the plaintext carries the stance, but the WIRE the relay sees is only ciphertext', async () => {
    const { groupId } = await createMyRoom([DAN]);
    crypto.encryptText.mockClear();
    // A distinctive opaque ciphertext with none of the plaintext markers, so a
    // leak would be unmistakable. What the relay routes is THIS, per leg.
    crypto.encryptText.mockResolvedValue({ msgType: 'ciphertext', payload: 'U0VBTEVE' });
    ws.calls.send.mockClear();

    await messaging.setRoomConsent(groupId, DAN, true);
    await waitForSent(1);

    // The CONTENT exists and is handed to the ratchet as plaintext — that is
    // precisely what gets SEALED (the third arg to encryptText).
    const sealed = composedFor().get(DAN);
    expect(sealed).toMatchObject({ tcm: 'grp.consent', a: DAN });

    // What the RELAY sees is every send frame's payload: opaque ciphertext,
    // never the plaintext — it routes N opaque legs and learns nothing of
    // who shares with whom. (Seal the wrong thing — plaintext on the wire — and
    // these assertions go red.)
    const wire = ws.calls.send.mock.calls
      .map(c => c[0] as { type: string; payload?: unknown })
      .filter(f => f.type === 'send')
      .map(f => String(f.payload));
    expect(wire.length).toBeGreaterThan(0);
    for (const payload of wire) {
      expect(payload).toBe('U0VBTEVE');
      expect(payload).not.toContain('grp.consent');
      expect(payload).not.toContain('tcm');
      expect(payload).not.toContain(DAN);
    }
  });

  test('hold DELETES FIRST, records refusal second, then starts the human announcement fan-out', async () => {
    await db.upsertChat(BEN, 'Ben');
    const { groupId } = await createMyRoom([BEN, DAN]);
    await db.setAgentConsent(DAN, 'consented', 1000);
    const order: string[] = [];
    let atDelete: {
      local: db.AgentConsentState;
      rows: number;
      encryptions: number;
    } | null = null;
    const localAtAnnouncement: db.AgentConsentState[] = [];
    api.apiConsentDelete.mockImplementation(async () => {
      order.push('delete');
      // At the privacy boundary, nothing local or group-visible has claimed
      // the new stance yet. A rejected DELETE therefore leaves no half-change.
      atDelete = {
        local: await db.getAgentConsent(DAN),
        rows: consentRows(groupId).length,
        encryptions: crypto.encryptText.mock.calls.length,
      };
    });
    crypto.encryptText.mockImplementation(
      async (_self: string, peer: string, plaintext: string) => {
        const envelope = JSON.parse(plaintext) as { tcm?: string };
        if (envelope.tcm === 'grp.consent') {
          order.push(`announce:${peer}`);
          // The local record is the second step, before courtesy fan-out.
          localAtAnnouncement.push(await db.getAgentConsent(DAN));
          // Keep the old subject-leg waiter from making the RED run spend its
          // full three-second timeout; the new design never reaches this leg.
          if (peer === DAN) throw new Error('subject must not be composed');
        }
        return { msgType: 'ciphertext', payload: 'AAAA' };
      },
    );

    await messaging.setRoomConsent(groupId, DAN, false);

    expect(api.apiConsentDelete).toHaveBeenCalledWith('token-1', DAN);
    expect(atDelete).toEqual({ local: 'consented', rows: 0, encryptions: 0 });
    expect(order).toEqual(['delete', `announce:${BEN}`]);
    expect(localAtAnnouncement).toEqual(['refused']);
    expect(await db.getAgentConsent(DAN)).toBe('refused');
    expect(consentRows(groupId)).toHaveLength(1);
  });

  test('edge honesty: a failed edge DELETE propagates and the local record must NOT claim refused — the decision did not take', async () => {
    const { groupId } = await createMyRoom([DAN]);
    // The standing decision this hold tries to revoke.
    await db.setAgentConsent(DAN, 'consented', 1000);
    api.apiConsentDelete.mockRejectedValueOnce(new Error('server said no'));

    await expect(
      messaging.setRoomConsent(groupId, DAN, false),
    ).rejects.toBeTruthy();

    // The edge still stands server-side, so this client keeps saying so: a
    // surface reading 'refused' here would tell the user they revoked when
    // they did not — the exact lie the failure matrix's case (a) forbids.
    expect(await db.getAgentConsent(DAN)).toBe('consented');
    // Revoke-first means there was no local write and no courtesy
    // announcement either: nothing changed, and nobody was told otherwise.
    expect(consentRows(groupId)).toHaveLength(0);
    expect(q(`SELECT msgId FROM outbox`)).toHaveLength(0);
    expect(crypto.encryptText).not.toHaveBeenCalled();
  });

  test('share direction pinned: the edge is WRITTEN before the announcement fans — write-then-announce lets the announcement leg ride the new edge', async () => {
    const { groupId } = await createMyRoom([DAN]);
    let announceRowsAtWrite = -1;
    api.apiConsentWrite.mockImplementation(async () => {
      announceRowsAtWrite = consentRows(groupId).length;
    });

    await messaging.setRoomConsent(groupId, DAN, true);

    // Nothing had been announced when the edge was written…
    expect(announceRowsAtWrite).toBe(0);
    // …and the announcement followed it.
    expect(consentRows(groupId)).toHaveLength(1);
  });

  test('a hold announcement mints legs for every human and NONE for any recognized agent', async () => {
    await db.upsertChat(BEN, 'Ben');
    await db.upsertChat(CARA, 'Cara');
    await db.upsertChat(EVE, 'Eve');
    await db.recordMachinePeer(DAN, 900);
    await db.recordMachinePeer(EVE, 901);
    const { groupId } = await createMyRoom([BEN, CARA, DAN, EVE]);
    crypto.encryptText.mockImplementation(async (_self: string, peer: string) => {
      // Neither the subject nor a different room agent belongs to the human
      // courtesy audience.
      if (peer === DAN || peer === EVE) {
        throw new Error('agents must not get a hold leg');
      }
      return { msgType: 'ciphertext', payload: 'AAAA' };
    });

    const res = await messaging.setRoomConsent(groupId, DAN, false);

    expect(res).toEqual({ atCap: false, announced: true });
    expect(crypto.encryptText.mock.calls.map(c => c[1]).sort()).toEqual(
      [BEN, CARA].sort(),
    );
    const localMsgId = consentRows(groupId)[0]!.msgId as string;
    const legs = q(
      `SELECT peerId, attempts FROM outbox WHERE localMsgId = ? ORDER BY peerId`,
      localMsgId,
    );
    expect(legs.map(l => l.peerId)).toEqual([BEN, CARA].sort());
    expect(await db.fanoutDeliveryState(localMsgId)).toMatchObject({
      total: 2,
      failed: 0,
    });
  });

  test('share is unchanged: POST first, then an announcement leg to every member INCLUDING every agent', async () => {
    await db.upsertChat(BEN, 'Ben');
    await db.upsertChat(EVE, 'Eve');
    await db.recordMachinePeer(DAN, 900);
    await db.recordMachinePeer(EVE, 901);
    const { groupId } = await createMyRoom([BEN, DAN, EVE]);
    let rowsAtWrite = -1;
    api.apiConsentWrite.mockImplementation(async () => {
      rowsAtWrite = consentRows(groupId).length;
    });

    await messaging.setRoomConsent(groupId, DAN, true);

    expect(rowsAtWrite).toBe(0);
    expect(q(`SELECT peerId FROM outbox ORDER BY peerId`).map(l => l.peerId)).toEqual(
      [BEN, DAN, EVE].sort(),
    );
    expect([...composedFor().keys()].sort()).toEqual([BEN, DAN, EVE].sort());
  });

  test('DELETE success plus a swallowed announcement failure keeps the refused record and reports room-not-told', async () => {
    const { groupId } = await createMyRoom([DAN]);
    await db.setAgentConsent(DAN, 'consented', 1000);
    const fanout = jest
      .spyOn(messaging, 'fanOutMembership')
      .mockRejectedValueOnce(new Error('read-only room'));

    const res = await messaging.setRoomConsent(groupId, DAN, false);

    expect(api.apiConsentDelete).toHaveBeenCalledWith('token-1', DAN);
    expect(await db.getAgentConsent(DAN)).toBe('refused');
    expect(res).toEqual({ atCap: false, announced: false });
    expect(consentRows(groupId)).toHaveLength(0);
    fanout.mockRestore();
  });

  test('the subject-agent exclusion does not weaken the room’s existing preflight block gate', async () => {
    const { groupId } = await createMyRoom([DAN]);
    await messaging.blockPeer(DAN);

    const res = await messaging.setRoomConsent(groupId, DAN, false);

    // Revocation still takes first, but the read-only room swallows the
    // courtesy announcement. Excluding the subject from delivery must not
    // turn a blocked room into a writable one for this envelope alone.
    expect(api.apiConsentDelete).toHaveBeenCalledWith('token-1', DAN);
    expect(res.announced).toBe(false);
    expect(consentRows(groupId)).toHaveLength(0);
  });

  test('a DELETE stalled across relock cannot record, reserve, or fan out in the newly unlocked workspace', async () => {
    await db.upsertChat(BEN, 'Ben');
    const { groupId } = await createMyRoom([BEN, DAN]);
    await db.setAgentConsent(DAN, 'consented', 1000);
    let releaseDelete: (() => void) | undefined;
    api.apiConsentDelete.mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          releaseDelete = resolve;
        }),
    );

    const hold = messaging.setRoomConsent(groupId, DAN, false);
    await flush();
    expect(api.apiConsentDelete.mock.calls).toEqual([['token-1', DAN]]);
    expect(releaseDelete).toBeDefined();

    messaging.stop();
    crypto.__keychain.set('authToken', 'token-2');
    await messaging.start(ME);
    // This row represents the newly active workspace's truth. The stale
    // continuation must not overwrite it when the old-token DELETE settles.
    await db.setAgentConsent(DAN, 'consented', 2000);
    crypto.encryptText.mockClear();
    ws.calls.send.mockClear();

    releaseDelete!();
    expect(await hold).toEqual({ atCap: false, announced: false });

    // The already-started privacy request is allowed to finish with token-1;
    // everything after it is generation-owned and stops at the lock boundary.
    expect(api.apiConsentDelete).toHaveBeenCalledTimes(1);
    expect(api.apiConsentDelete.mock.calls).toEqual([['token-1', DAN]]);
    expect(await db.getAgentConsent(DAN)).toBe('consented');
    expect(consentRows(groupId)).toEqual([]);
    expect(q(`SELECT msgId FROM outbox`)).toEqual([]);
    expect(crypto.encryptText).not.toHaveBeenCalled();
    expect(sentFrames()).toEqual([]);
  });

  test.each([
    ['share', true, 'consented'],
    ['hold', false, 'refused'],
  ] as const)('duress %s keeps the same local-only timing and observable shape', async (_label, share, state) => {
    const { groupId } = await createMyRoom([DAN]);
    session.setMode('duress');
    ws.calls.send.mockClear();

    let settled = false;
    const decision = messaging.setRoomConsent(groupId, DAN, share).then(result => {
      settled = true;
      return result;
    });
    await flush();

    expect(settled).toBe(true);
    expect(await decision).toEqual({ atCap: false, announced: true });
    expect(await db.getAgentConsent(DAN)).toBe(state);
    expect(api.apiConsentWrite).not.toHaveBeenCalled();
    expect(api.apiConsentDelete).not.toHaveBeenCalled();
    expect(sentFrames()).toEqual([]);
    expect(q(`SELECT msgId FROM outbox`)).toEqual([]);
    expect(consentRows(groupId)).toEqual([]);
  });
});
