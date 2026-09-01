/**
 * ROOMS — the screenshot notice.
 *
 * A screenshot of a room disclosed the ROOM, so the notice must fan to the
 * full membership — through `fanOut`, the same legs, gates, ledger and
 * pacing as any room message — and a room id must never reach the
 * addressing layer (`SendFrame.to` takes a user id or nothing).
 * Before this seam existed the App.tsx trigger passed the room's ULID into
 * `encryptAndEnqueue`, which died fetching a prekey bundle for a non-user
 * id inside the notice's silent catch: wired, and broken twice over.
 *
 * Proved on Node's REAL SQLite engine, exactly as
 * messaging.groups.send.test.ts argues (the recorded op-sqlite mock records
 * statements without executing them, so a fold read against it proves
 * nothing). What this file pins:
 *
 *  - the notice reaches every member and NOBODY else; no leg and no frame
 *    ever carries the room id as a destination;
 *  - a 1:1 notice is untouched by the seam — bare `shot` envelope, no
 *    wrapper, one leg;
 *  - a blocked member suppresses the ROOM notice entirely (the design's
 *    evidence-gathering case, generalised: the read-only room) —
 *    with the fixture first proven ABLE to send, so the suppression
 *    assertion cannot pass vacuously;
 *  - anything short of the anchor's definite "not a room" suppresses
 *    rather than sends (sendReadReceipt's definite-answer rule);
 *  - duress: one decoy row, zero frames, and the anchor is never read;
 *  - an incoming room notice lands attributed to the AUTHENTICATED sender
 *    (`frame.from`), never anything its payload claims.
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

import * as db from '../src/db';
import { messaging } from '../src/messaging';
import { createRoom } from '../src/screens/GroupCreateScreen';
import { session } from '../src/session';

// The bucket is born empty and refills at ~3.83 tokens/s, so a drain
// spends real seconds; the default 5 s deadline expires under worker load
// while nothing is wrong. Assertions are bounded in POLLS (waitForSent);
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
const mid = (seed: string): string => pad('M' + seed.toUpperCase());

const SHOT_BODY = '{"tcm":"shot"}';

async function flush(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

/** Every `send`-type frame the socket saw, in order. */
function sentFrames(): { to: string; msgId: string }[] {
  return ws.calls.send.mock.calls
    .map(c => c[0] as { type: string; to?: string; msgId?: string })
    .filter(f => f.type === 'send') as { to: string; msgId: string }[];
}

/** Poll the paced drain with real timers; budget counted in POLLS, never in
 * wall-clock (messaging.groups.send.test.ts's argument: a stalled worker
 * delays the poll and the drain together, and the bucket refills on
 * wall-clock, so a stall only makes each poll observe MORE progress). On
 * exhaustion the helper returns and lets the caller's assertion fail loudly. */
async function waitForSent(n: number, maxPolls = 320): Promise<void> {
  for (let poll = 0; sentFrames().length < n; poll++) {
    if (poll >= maxPolls) return;
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
const gMsg = (g: string, m: string, b: string, sq = 1): string =>
  JSON.stringify({ tcm: 'grp.msg', g, m, sq, b });

async function createMyRoom(members: string[], nm = 'Kitchen') {
  for (const id of members) await db.upsertChat(id, `P ${id.slice(0, 4)}`);
  const result = await createRoom(ME, nm, members);
  // The invite legs belong to the CREATE fan-out, which has its own suite;
  // everything below asserts the NOTICE's fan-out.
  q(`DELETE FROM outbox`);
  ws.calls.send.mockClear();
  crypto.encryptText.mockClear();
  return result;
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
  messaging.stop();
  await db.close();
  engine.close();
  session.setMode('real');
  db.setWorkspace('real');
});

// ---------------------------------------------------------------------------

describe('a screenshot in a room', () => {
  test('the notice fans to every member and to nobody else, and the room id never appears as a destination', async () => {
    const { groupId } = await createMyRoom([BEN, CARA, DAN]);
    // Precondition, so the recipient assertion cannot pass against an empty
    // fold: the roster genuinely holds all four seats.
    expect((await db.listGroupMemberSlots(groupId)).length).toBe(4);

    await expect(
      messaging.sendScreenshotNotice(groupId),
    ).resolves.toBeUndefined();

    // One leg per member — never the room, never the bystander, never me.
    const legs = q(`SELECT peerId, localMsgId FROM outbox ORDER BY peerId`);
    expect(legs.map(l => l.peerId)).toEqual([BEN, CARA, DAN].sort());
    expect(legs.every(l => l.peerId !== groupId)).toBe(true);
    expect(legs.every(l => l.peerId !== FRAN)).toBe(true);

    // Each leg carries the shot INSIDE the room wrapper: the receive side
    // unwraps grp.msg and stores the notice attributed to frame.from.
    const composed = composedFor();
    for (const member of [BEN, CARA, DAN]) {
      expect(composed.get(member)!.tcm).toBe('grp.msg');
      expect(composed.get(member)!.g).toBe(groupId);
      expect(composed.get(member)!.b).toBe(SHOT_BODY);
    }

    // My own copy is a room row — 'You took a screenshot.' — previewed as
    // every 1:1 notice is, and it parents the legs.
    const rows = q(
      `SELECT msgId, body, authorId, direction FROM messages WHERE peerId = ?`,
      groupId,
    ).filter(r => r.body === SHOT_BODY);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.direction).toBe('out');
    expect(rows[0]!.authorId).toBe(ME);
    expect(legs.every(l => l.localMsgId === rows[0]!.msgId)).toBe(true);
    expect(
      q(`SELECT lastMessageText FROM chats WHERE peerId = ?`, groupId)[0]!
        .lastMessageText,
    ).toBe('Screenshot');

    // And the wire agrees: three frames, none of them to the room.
    await waitForSent(3);
    expect(sentFrames().map(f => f.to).sort()).toEqual(
      [BEN, CARA, DAN].sort(),
    );
    expect(sentFrames().every(f => f.to !== groupId)).toBe(true);
  });

  test('a 1:1 screenshot is untouched by the room seam: one leg, the bare shot envelope, no wrapper', async () => {
    // Precondition for the routing decision: the anchor's answer for FRAN is
    // a definite "not a room".
    expect(await db.getGroup(FRAN)).toBeNull();

    await expect(
      messaging.sendScreenshotNotice(FRAN),
    ).resolves.toBeUndefined();

    expect(crypto.encryptText).toHaveBeenCalledWith(ME, FRAN, SHOT_BODY);
    const legs = q(`SELECT peerId FROM outbox`);
    expect(legs.map(l => l.peerId)).toEqual([FRAN]);
    const rows = q(
      `SELECT body FROM messages WHERE peerId = ?`,
      FRAN,
    ).filter(r => r.body === SHOT_BODY);
    expect(rows).toHaveLength(1);
    await waitForSent(1);
    expect(sentFrames().map(f => f.to)).toEqual([FRAN]);
  });

  test('a blocked member suppresses the room notice ENTIRELY — the evidence-gathering case, and never a partial fan-out around them', async () => {
    const { groupId } = await createMyRoom([BEN, EVE]);

    // Precondition, asserted before the rule (the fixture-cannot-fail trap):
    // this exact room CAN fan the notice while nobody is blocked.
    await messaging.sendScreenshotNotice(groupId);
    expect(q(`SELECT peerId FROM outbox`)).toHaveLength(2);
    q(`DELETE FROM outbox`);
    q(`DELETE FROM messages WHERE peerId = ? AND body = ?`, groupId, SHOT_BODY);
    ws.calls.send.mockClear();
    crypto.encryptText.mockClear();

    await messaging.blockPeer(EVE);
    ws.calls.send.mockClear();

    // Never throws (the App.tsx listener calls it unconditionally), and
    // sends NOTHING: not to Eve — the block — and not to Ben either, because
    // omitting Eve silently is itself the tell (the read-only room).
    await expect(
      messaging.sendScreenshotNotice(groupId),
    ).resolves.toBeUndefined();
    await flush();

    expect(crypto.encryptText).not.toHaveBeenCalled();
    expect(q(`SELECT peerId FROM outbox`)).toEqual([]);
    expect(sentFrames()).toEqual([]);
    // No local row either: the gate sits before ANY allocation.
    expect(
      q(`SELECT msgId FROM messages WHERE peerId = ? AND body = ?`, groupId, SHOT_BODY),
    ).toEqual([]);
  });

  test('anything short of the anchor’s definite "not a room" suppresses rather than sends', async () => {
    // Sending a notice astray is unrecoverable; withholding one annotates an
    // action already complete. So a failed anchor read falls silent — the
    // same rule sendReadReceipt pins for the receipt path.
    await createMyRoom([BEN]);
    const instance = sqlite.__sqlite.instances.get('tacendum.sqlite')!;
    const real = instance.execute.getMockImplementation()!;
    instance.execute.mockImplementation(
      async (sql: unknown, params?: unknown[]) => {
        if (String(sql).includes('FROM groups WHERE groupId')) {
          throw new Error('db is busy');
        }
        return real(sql, params);
      },
    );

    await expect(
      messaging.sendScreenshotNotice(FRAN),
    ).resolves.toBeUndefined();
    instance.execute.mockImplementation(real);

    expect(crypto.encryptText).not.toHaveBeenCalled();
    expect(q(`SELECT peerId FROM outbox`)).toEqual([]);
    expect(sentFrames()).toEqual([]);
  });

  test('duress: one decoy row in the room thread, ZERO frames, and the anchor is never read', async () => {
    const { groupId } = await createMyRoom([BEN]);
    const instance = sqlite.__sqlite.instances.get('tacendum.sqlite')!;
    session.setMode('duress');
    const anchorReads = (): number =>
      instance.execute.mock.calls.filter(c =>
        String(c[0]).includes('FROM groups WHERE groupId'),
      ).length;
    const before = anchorReads();

    await expect(
      messaging.sendScreenshotNotice(groupId),
    ).resolves.toBeUndefined();
    await flush();

    // The seam sits ABOVE the anchor read (fanOut's own duress argument): a
    // duress session must not read room state to decide how to fake a send.
    expect(anchorReads()).toBe(before);
    expect(crypto.encryptText).not.toHaveBeenCalled();
    expect(sentFrames()).toEqual([]);
    expect(q(`SELECT msgId FROM outbox`)).toEqual([]);
    const rows = q(
      `SELECT body, status, direction FROM messages WHERE peerId = ?`,
      groupId,
    ).filter(r => r.body === SHOT_BODY);
    expect(rows).toEqual([
      { body: SHOT_BODY, status: 'sent', direction: 'out' },
    ]);
  });

  test('an incoming room notice lands attributed to the AUTHENTICATED sender, never a payload claim', async () => {
    await deliver(gNew(ROOM, [ANA, ME, CARA]), ANA);
    // Precondition: the room really anchored (the fixture reaches the rule).
    expect(q(`SELECT peerId FROM chats WHERE peerId = ?`, ROOM)).toHaveLength(1);

    // The shot rides the wrapper with a smuggled name field beside its tcm —
    // the schema strips it, and nothing downstream may resurrect it.
    await deliver(
      gMsg(ROOM, mid('S1'), '{"tcm":"shot","name":"You"}'),
      CARA,
    );

    const rows = q(
      `SELECT msgId, authorId, direction, body FROM messages
       WHERE peerId = ? AND body LIKE '%"tcm":"shot"%'`,
      ROOM,
    );
    expect(rows).toHaveLength(1);
    // Attributed to frame.from — the row key and authorId both derive from
    // the authenticated sender, so the thread labels it "Cara took a
    // screenshot." whatever the payload said.
    expect(rows[0]!.authorId).toBe(CARA);
    expect(rows[0]!.direction).toBe('in');
    expect(rows[0]!.msgId).toBe(`${CARA}.${mid('S1')}`);
    expect(
      q(`SELECT lastMessageText FROM chats WHERE peerId = ?`, ROOM)[0]!
        .lastMessageText,
    ).toBe('Screenshot');
  });
});
