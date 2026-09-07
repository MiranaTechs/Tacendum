/**
 * THE ART. 50 MARKER, RECEIVE SIDE —
 * parse + persist, against the REAL engine (the messaging.groups.receive
 * harness verbatim: the mocked op-sqlite connection is rebound to Node's
 * real SQLite so the real db.ts SQL runs under the real messaging.ts).
 *
 * What this file pins:
 *
 *  1. A room message whose grp.msg WRAPPER carries `ai:true` lands as a row
 *     with `ai = 1` — recorded AT ARRIVAL, like `outsider`, because the
 *     wrapper is discarded at persist and a render-time re-parse would have
 *     nothing to read. `b` stays the bare words in `body`.
 *  2. Without the marker (and with a malformed one) the row lands unmarked —
 *     the marker costs itself, never the message.
 *  3. A 1:1 `msg` envelope persists VERBATIM as the body (the marker rides
 *     the stored bytes) AND stamps `ai = 1`; the chat preview shows the
 *     words, never the JSON.
 *  4. The durable edit final applied to a marked `msg` anchor rewrites the
 *     words INSIDE the wrapper — the marker survives the agent correcting
 *     itself — and the row stays marked.
 *  5. The remediation: the provenance-upgrade path
 *     (`supersedeRelayed`) carries the arriving wrapper's claim RAISE-ONLY;
 *     the edit arm stamps `ai` raise-only, so the shipped
 *     `--stream`-without-`--marker` posture (bare anchor, marked final)
 *     badges; a marked INNER envelope badges without wrapper `ai`
 *     (the amended marker rule's other door); and the projections that feed
 *     the badge PIN the `ai` column (db.timer.test.ts's expiresAt
 *     precedent).
 *
 * Plus the consent surface, DARK: a local record of the
 * user's per-agent consent decision — no server write, no envelope, no
 * announcement; those come later. Pinned here because the model lives in
 * db.ts beside the tables the wipe covers.
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
import { session } from '../src/session';

type Row = Record<string, unknown>;
interface Engine {
  prepare(sql: string): { all(...args: unknown[]): Row[] };
  close(): void;
}
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (p: string) => Engine;
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
};
const ws = (
  jest.requireMock('../src/ws') as {
    __ws: {
      handlers: { frame?: (f: unknown) => void };
      calls: { send: jest.Mock };
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

const pad = (seed: string): string => (seed + '0'.repeat(26)).slice(0, 26);
const ME = pad('ME');
const ANA = pad('ANA'); // the room's owner
const CLAUDE = pad('AGENT'); // a paired-never-adopted machine, 1:1
const ROOM = pad('7R00M');
const mid = (seed: string): string => pad('M' + seed.toUpperCase());

let wireN = 0;
async function flush(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

async function deliver(
  text: string,
  from: string,
  wireId?: string,
): Promise<string> {
  const msgId = wireId ?? `01WIRE${String(++wireN).padStart(20, '0')}`;
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
const gMsg = (
  g: string,
  m: string,
  b: string,
  extra: Record<string, unknown> = {},
): string => JSON.stringify({ tcm: 'grp.msg', g, m, sq: 1, b, ...extra });

beforeEach(async () => {
  messaging.stop();
  await db.close();
  crypto.__keychain.clear();
  sqlite.__sqlite.reset();
  crypto.encryptText.mockClear();
  crypto.decryptEnvelope.mockReset();
  crypto.hasSession.mockReset();
  crypto.hasSession.mockResolvedValue(true);
  ws.calls.send.mockClear();
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
  messaging.stop();
  await db.close();
  engine.close();
  session.setMode('real');
  db.setWorkspace('real');
});

describe('the room wrapper marker persists on the row', () => {
  beforeEach(async () => {
    await deliver(gNew(ROOM, [ANA, ME]), ANA);
  });

  // Scoped to CONTENT rows by the composite key (`${author}.${m}` —
  // a ULID cannot contain '.'): the grp.new announcement row shares the
  // room's peerId under its wire id and is not under test here.
  const contentRows = (): Row[] =>
    q(
      `SELECT msgId, body, ai FROM messages
       WHERE peerId = ? AND msgId LIKE '%.%' ORDER BY ts, msgId`,
      ROOM,
    );

  test('grp.msg with ai:true on the wrapper → row ai = 1, body = the bare words', async () => {
    await deliver(gMsg(ROOM, mid('A1'), 'the room answer', { ai: true }), ANA);
    expect(contentRows()).toEqual([
      { msgId: `${ANA}.${mid('A1')}`, body: 'the room answer', ai: 1 },
    ]);
  });

  test('grp.msg without the marker → row lands unmarked', async () => {
    await deliver(gMsg(ROOM, mid('A2'), 'plain words'), ANA);
    expect(contentRows()).toEqual([
      { msgId: `${ANA}.${mid('A2')}`, body: 'plain words', ai: null },
    ]);
  });

  test('a malformed marker costs the marker, never the message', async () => {
    await deliver(gMsg(ROOM, mid('A3'), 'still here', { ai: 'x' }), ANA);
    expect(contentRows()).toEqual([
      { msgId: `${ANA}.${mid('A3')}`, body: 'still here', ai: null },
    ]);
  });

  test('a marked INNER envelope badges WITHOUT wrapper ai — the amended marker rule’s other door', async () => {
    // The compose side now sets `ai` inside an envelope-shaped `b` as well
    // (rule 1), precisely so the claim survives paths that
    // relay only the `b` bytes. The receive door `envelope.ai === true ||
    // aiOriginOf(inner)` must therefore badge on the inner claim alone.
    const inner = JSON.stringify({ tcm: 'msg', text: 'inner marked', ai: true });
    await deliver(gMsg(ROOM, mid('A4'), inner), ANA);
    expect(contentRows()).toEqual([
      { msgId: `${ANA}.${mid('A4')}`, body: inner, ai: 1 },
    ]);
  });
});

describe('the provenance upgrade carries the marker, raise-only', () => {
  const BOT = pad('B0T');
  const HM = mid('H1');
  const KEY = `${BOT}.${HM}`;
  const hist = (b: string): string =>
    JSON.stringify({
      tcm: 'grp.hist',
      g: ROOM,
      n: 2,
      to: ME,
      c: 1,
      e: { m: HM, a: BOT, t: 8_000, b },
    });
  const rowOf = (): Row[] =>
    q(`SELECT body, ts, sharedBy, ai FROM messages WHERE peerId = ? AND msgId = ?`, ROOM, KEY);

  beforeEach(async () => {
    await deliver(gNew(ROOM, [ANA, ME, BOT]), ANA);
    // ANA (the owner) relays BOT's message as history: second-hand, unmarked.
    await deliver(hist('the analysis'), ANA);
    expect(rowOf()).toEqual([{ body: 'the analysis', ts: 8_000, sharedBy: ANA, ai: null }]);
  });

  test('the author’s own MARKED copy supersedes: body, provenance AND the ai claim land', async () => {
    // The straggler re-fan: BOT's first-hand copy of the SAME m arrives with
    // `ai: true` on the wrapper. applyContent's INSERT OR IGNORE is a no-op
    // against the existing row, so the UPDATE must carry the claim — or a
    // first-hand agent message stays permanently unbadged on exactly the
    // no-machine_peers phones the marker rule serves.
    await deliver(gMsg(ROOM, HM, 'the analysis', { ai: true }), BOT);
    expect(rowOf()).toEqual([
      { body: 'the analysis', ts: expect.any(Number) as number, sharedBy: null, ai: 1 },
    ]);
  });

  test('an UNMARKED superseding copy raises nothing — and can never clear an existing 1', async () => {
    // Raise-only, direction 2: a lying (or merely older) client's unmarked
    // copy must not un-badge a row. Force the badge on the relayed row, then
    // supersede without a claim.
    q(`UPDATE messages SET ai = 1 WHERE peerId = ? AND msgId = ?`, ROOM, KEY);
    await deliver(gMsg(ROOM, HM, 'the analysis', {}), BOT);
    expect(rowOf()).toEqual([
      { body: 'the analysis', ts: expect.any(Number) as number, sharedBy: null, ai: 1 },
    ]);
  });

  test('null stays null: no claim anywhere leaves the row unmarked', async () => {
    await deliver(gMsg(ROOM, HM, 'the analysis', {}), BOT);
    expect(rowOf()).toEqual([
      { body: 'the analysis', ts: expect.any(Number) as number, sharedBy: null, ai: null },
    ]);
  });
});

describe('the 1:1 msg envelope persists verbatim, marked', () => {
  const MSG = '{"tcm":"msg","text":"the build is green","ai":true}';

  test('body stored byte-verbatim, ai = 1, preview shows the words', async () => {
    await deliver(MSG, CLAUDE);
    const rows = q(`SELECT body, ai FROM messages WHERE peerId = ?`, CLAUDE);
    expect(rows).toEqual([{ body: MSG, ai: 1 }]);
    const chat = q(`SELECT lastMessageText FROM chats WHERE peerId = ?`, CLAUDE);
    expect(chat).toEqual([{ lastMessageText: 'the build is green' }]);
  });

  test('the durable edit final rewrites the words INSIDE the wrapper — marker intact, row still marked', async () => {
    const anchorWire = await deliver(MSG, CLAUDE);
    await deliver(
      JSON.stringify({
        tcm: 'edit',
        ref: anchorWire,
        text: 'the build is green, and deployed',
        ai: true,
      }),
      CLAUDE,
    );
    const rows = q(
      `SELECT body, ai, editedAt FROM messages WHERE peerId = ? AND msgId = ?`,
      CLAUDE,
      anchorWire,
    );
    expect(rows).toHaveLength(1);
    const row = rows[0] as { body: string; ai: number; editedAt: number };
    expect(JSON.parse(row.body)).toEqual({
      tcm: 'msg',
      text: 'the build is green, and deployed',
      ai: true,
    });
    expect(row.ai).toBe(1);
    expect(row.editedAt).not.toBeNull();
  });
});

describe('structured AI work stays source-backed and 1:1', () => {
  const EVENT = '01J8MEAPPR0VAQ4X2C6TKN9RFW';

  test('a valid msg event persists after its source row and keeps the original body', async () => {
    const work = {
      provider: 'claude',
      updatedAt: Date.now(),
      event: 'turn-complete',
      eventId: EVENT,
      project: 'Tacendum',
      context: {
        availability: 'captured',
        capturedAt: Date.now(),
        resultSummary: 'Reported completion, with no claim about checks.',
      },
    } as const;
    const body = JSON.stringify({
      tcm: 'msg',
      text: 'The turn finished.',
      ai: true,
      work,
    });
    const wireId = await deliver(body, CLAUDE);

    expect(q(`SELECT body FROM messages WHERE peerId = ?`, CLAUDE)).toEqual([
      { body },
    ]);
    const events = await db.listRecentAiWorkEvents(Date.now());
    expect(events).toEqual([
      expect.objectContaining({
        peerId: CLAUDE,
        eventId: EVENT,
        wireMsgId: wireId,
        sourceRef: wireId,
        event: 'turn-complete',
        project: 'Tacendum',
      }),
    ]);
  });

  test('malformed work costs itself while conversational words still land', async () => {
    const body = JSON.stringify({
      tcm: 'msg',
      text: 'The answer remains visible.',
      ai: true,
      work: { provider: 'claude' },
    });
    await deliver(body, CLAUDE);

    expect(q(`SELECT body FROM messages WHERE peerId = ?`, CLAUDE)).toEqual([
      { body },
    ]);
    await expect(db.listRecentAiWorkEvents(Date.now())).resolves.toEqual([]);
  });

  test('a terminal edit records one event against the edited anchor', async () => {
    const anchor = await deliver('streaming…', CLAUDE);
    const work = {
      provider: 'codex',
      updatedAt: Date.now(),
      event: 'turn-complete',
      eventId: EVENT,
      project: 'Tacendum',
    } as const;
    const editWire = await deliver(
      JSON.stringify({
        tcm: 'edit',
        ref: anchor,
        text: 'The final answer.',
        ai: true,
        work,
      }),
      CLAUDE,
    );

    expect(q(`SELECT body FROM messages WHERE peerId = ? AND msgId = ?`, CLAUDE, anchor)).toEqual([
      { body: 'The final answer.' },
    ]);
    await expect(db.listRecentAiWorkEvents(Date.now())).resolves.toEqual([
      expect.objectContaining({
        eventId: EVENT,
        wireMsgId: editWire,
        sourceRef: anchor,
        provider: 'codex',
      }),
    ]);
  });

  test('a profile snapshot updates capabilities without inventing an event', async () => {
    const now = Date.now();
    await deliver(
      JSON.stringify({
        tcm: 'profile',
        n: 'Claude Code',
        a: '',
        v: now,
        work: {
          provider: 'claude',
          updatedAt: now,
          capabilities: { notifications: true, approvals: true, tasks: false },
        },
      }),
      CLAUDE,
    );

    await expect(db.getAiAgentState(CLAUDE)).resolves.toMatchObject({
      provider: 'claude',
      capabilities: { notifications: true, approvals: true, tasks: false },
    });
    await expect(db.listRecentAiWorkEvents(Date.now())).resolves.toEqual([]);
  });

  test('room-contained work never enters the personal attention store', async () => {
    await deliver(gNew(ROOM, [ANA, ME]), ANA);
    const inner = JSON.stringify({
      tcm: 'msg',
      text: 'Room answer',
      ai: true,
      work: {
        provider: 'claude',
        updatedAt: Date.now(),
        event: 'turn-complete',
        eventId: EVENT,
      },
    });
    await deliver(gMsg(ROOM, mid('W1'), inner, { ai: true }), ANA);

    await expect(db.listRecentAiWorkEvents(Date.now())).resolves.toEqual([]);
  });
});

describe('the edit arm stamps the marker, raise-only', () => {
  const rowOf = (wireId: string): Row[] =>
    q(
      `SELECT body, ai, editedAt FROM messages WHERE peerId = ? AND msgId = ?`,
      CLAUDE,
      wireId,
    );

  test('the SHIPPED posture (--stream without --marker): bare anchor, MARKED durable final → the row badges', async () => {
    // The anchor lands bare (ai NULL) because bare text has no field; the
    // durable edit final is an envelope and is marked UNGATED. Discarding
    // its claim left the whole streamed reply unbadged on every
    // paired-never-adopted phone — the wire's claim was dead on arrival.
    const anchor = await deliver('half a thought', CLAUDE);
    expect(rowOf(anchor)).toEqual([{ body: 'half a thought', ai: null, editedAt: null }]);
    await deliver(
      JSON.stringify({ tcm: 'edit', ref: anchor, text: 'the whole thought', ai: true }),
      CLAUDE,
    );
    expect(rowOf(anchor)).toEqual([
      { body: 'the whole thought', ai: 1, editedAt: expect.any(Number) as number },
    ]);
  });

  test('raise-only: an UNMARKED edit of a marked row keeps the badge — a reviser cannot un-badge by silence', async () => {
    const MSG = '{"tcm":"msg","text":"the build is green","ai":true}';
    const anchor = await deliver(MSG, CLAUDE);
    await deliver(
      JSON.stringify({ tcm: 'edit', ref: anchor, text: 'quieter words' }),
      CLAUDE,
    );
    const rows = rowOf(anchor);
    expect((rows[0] as { ai: number }).ai).toBe(1);
    expect(JSON.parse((rows[0] as { body: string }).body)).toEqual({
      tcm: 'msg',
      text: 'quieter words',
      ai: true,
    });
  });

  test('a bare thread stays bare: an unmarked edit of an unmarked row raises nothing', async () => {
    const anchor = await deliver('typed words', CLAUDE);
    await deliver(JSON.stringify({ tcm: 'edit', ref: anchor, text: 'edited words' }), CLAUDE);
    expect(rowOf(anchor)).toEqual([
      { body: 'edited words', ai: null, editedAt: expect.any(Number) as number },
    ]);
  });
});

describe('the projections pin ai — the badge reads the COLUMN (db.timer.test.ts precedent)', () => {
  const sqlCalls = (): string[] => {
    const instance = sqlite.__sqlite.instances.get('tacendum.sqlite')!;
    return instance.execute.mock.calls.map(c => String(c[0]));
  };

  test('listMessages, getMessage and listRecentMessages all select ai', async () => {
    await db.listMessages(CLAUDE);
    const list = sqlCalls().filter(s => s.includes('FROM messages WHERE peerId = ? ORDER BY ts, msgId')).at(-1) ?? '';
    expect(list).toMatch(/\bai\b/);

    await db.getMessage(mid('P1'), 'in');
    const get = sqlCalls().filter(s => s.includes('WHERE msgId = ? AND direction = ?')).at(-1) ?? '';
    expect(get).toMatch(/\bai\b/);

    await db.listRecentMessages(CLAUDE, 5);
    const recent = sqlCalls().filter(s => s.includes('ORDER BY ts DESC, msgId DESC LIMIT ?')).at(-1) ?? '';
    expect(recent).toMatch(/\bai\b/);
  });
});

describe('the consent record — local, dark, announces nothing', () => {
  test('undecided until decided; consented and refused both record and read back', async () => {
    expect(await db.getAgentConsent(CLAUDE)).toBe('undecided');
    await db.setAgentConsent(CLAUDE, 'consented', 1_000);
    expect(await db.getAgentConsent(CLAUDE)).toBe('consented');
    await db.setAgentConsent(CLAUDE, 'refused', 2_000);
    expect(await db.getAgentConsent(CLAUDE)).toBe('refused');
    const rows = q(`SELECT peerId, state, decidedAt FROM agent_consent`);
    expect(rows).toEqual([{ peerId: CLAUDE, state: 'refused', decidedAt: 2_000 }]);
  });

  test('the record is in the wipe: sign-out clears it and the decoy inherits nothing', async () => {
    await db.setAgentConsent(CLAUDE, 'consented', 1_000);
    expect(db.DB_TABLES).toContain('agent_consent');
    await db.clearLocalState();
    expect(await db.getAgentConsent(CLAUDE)).toBe('undecided');
    expect(q(`SELECT * FROM agent_consent`)).toEqual([]);
  });

  test('nothing about a consent write reaches the wire — no frame, no API call', async () => {
    ws.calls.send.mockClear();
    await db.setAgentConsent(CLAUDE, 'refused', 3_000);
    expect(ws.calls.send).not.toHaveBeenCalled();
  });
});
