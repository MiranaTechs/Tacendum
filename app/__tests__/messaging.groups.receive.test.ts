/**
 * ROOMS — the receive path.
 *
 * THE HARNESS IS THE POINT. The suite-wide op-sqlite mock RECORDS statements
 * without executing them, and a gate proved two logic inversions that pass
 * every recorded-statement test and are caught only by a real engine. So this
 * file rebinds the mocked connection to Node's real SQLite (`node:sqlite`):
 * the REAL `db.ts` SQL executes for real, under the REAL `messaging.ts`, and
 * every assertion below reads actual rows back out of an actual engine —
 * behaviour, not parameters. (A test here once would have passed with a
 * mutation that deleted every reaction in every 1:1 chat; against the real
 * engine that mutation fails loudly — see 'a room purge does not reach into
 * 1:1 rows'.)
 *
 * What this file proves:
 *  - photo / file / voice / location / reply / edit / retraction / reaction
 *    all land in a room THROUGH THE SAME BRANCHES as 1:1 — plus the source
 *    scan asserting the absence of duplicated switch arms, because two
 *    copies pass tests and then drift (it has shipped twice);
 *  - two members reacting to one message are two visible rows;
 *  - a forged `del` from member M naming author A's message is refused AND
 *    does not suppress A's genuine retraction (the writer-keyed park);
 *  - a `grp.msg` from a sender the fold says is out is decrypted, acked
 *    byte-identically, and rendered as a tagged, attributed row — never
 *    silently dropped;
 *  - a non-owner Add / Remove takes effect nowhere and stores nothing; the
 *    owner's equivalents take effect; nothing is ever held as "waiting";
 *  - `grp.del`: counted → full purge, non-owner → declined row and no other
 *    effect, unknown room → nothing; the replayed-del transport backstop;
 *  - local delete recreates on traffic; leave-then-delete stays gone;
 *    `blocked_peers` untouched throughout;
 *  - the quiet drops and the laundering refusals;
 *  - the design: a blocked member's room traffic drops whole, and their blob is
 *    never fetched at boot.
 *
 * Arrival-permutation and shuffled-replay convergence (the design through the
 * real apply path) live in messaging.groups.convergence.test.ts.
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

import { foldRoster, effectiveDisappearSec, verdictFor } from '@tacendum/shared/group-fold';
import * as db from '../src/db';
import { MENTION_MARK, previewFor } from '../src/envelope';
import { messaging } from '../src/messaging';
import { session } from '../src/session';

// --- the real engine, bound under the recorded mock -------------------------

type Row = Record<string, unknown>;
interface Engine {
  prepare(sql: string): { all(...args: unknown[]): Row[] };
  close(): void;
}
// Required, not imported: the repo's TS config has no node types, and the
// runtime (jest under Node 22) has the modules.
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (p: string) => Engine;
};
const { readFileSync } = require('fs') as {
  readFileSync: (p: string, encoding: 'utf8') => string;
};
declare const __dirname: string;

interface FakeDb {
  name: string;
  execute: jest.Mock;
  close: jest.Mock;
}
const sqlite = (
  jest.requireMock('@op-engineering/op-sqlite') as {
    open: (o: { name: string }) => FakeDb;
    __sqlite: { instances: Map<string, FakeDb>; reset: () => void };
  }
);
const crypto = jest.requireMock('tacendum-crypto') as {
  __keychain: Map<string, string>;
  decryptEnvelope: jest.Mock;
  encryptText: jest.Mock;
  hasSession: jest.Mock;
};
const api = jest.requireMock('../src/api') as {
  apiGetAttachmentUrl: jest.Mock;
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

/** Route the fake op-sqlite connection to the real engine. The jest.fn still
 * records, so statement ORDER stays assertable while the SQL executes. */
function bindRealEngine(): void {
  engine = new DatabaseSync(':memory:');
  const instance = sqlite.open({ name: 'tacendum.sqlite' });
  instance.execute.mockImplementation(
    async (sql: unknown, params?: unknown[]) => {
      const args = (params ?? []).map(p => (p === undefined ? null : p));
      const rows = engine.prepare(String(sql)).all(...args);
      // op-sqlite reports rowsAffected; applyEdit/tombstoneMessage decide
      // "park or apply" on it, so the shim must carry the real count.
      const changes = engine.prepare('SELECT changes() AS c').all()[0]!
        .c as number;
      return { rows, rowsAffected: changes };
    },
  );
}

const q = (sql: string, ...args: unknown[]): Row[] =>
  engine.prepare(sql).all(...args);

// --- ids (all wire ids must satisfy the shared Ulid regex) ------------------

const pad = (seed: string): string => (seed + '0'.repeat(26)).slice(0, 26);
const ME = pad('ME'); // this phone
const ANA = pad('ANA'); // the owner
const BEN = pad('BEN'); // a 1:1 peer, never in any room
const CARA = pad('CARA');
const DAN = pad('DAN');
const EVE = pad('EVE');
const ROOM = pad('7R00M');
const ROOM2 = pad('7R00M2');
const mid = (seed: string): string => pad('M' + seed.toUpperCase());

// --- wire helpers -----------------------------------------------------------

let wireN = 0;
async function flush(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

/** Decrypts to `text` and runs the full inbound path. Returns the wire id. */
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
const gRoster = (g: string, m: string, s: 'in' | 'out', n: number): string =>
  JSON.stringify({ tcm: 'grp.roster', g, m, s, n });
const gSet = (g: string, s: number, n: number): string =>
  JSON.stringify({ tcm: 'grp.set', g, s, n });
const gDel = (g: string, n = 1): string => JSON.stringify({ tcm: 'grp.del', g, n });
const gMsg = (g: string, m: string, b: string, sq = 1): string =>
  JSON.stringify({ tcm: 'grp.msg', g, m, sq, b });
const gConsent = (g: string, a: string, s: 'share' | 'hold', n: number): string =>
  JSON.stringify({ tcm: 'grp.consent', g, a, s, n });

async function acceptRoom(
  g = ROOM,
  ms: string[] = [ANA, ME, CARA],
  n = 1,
  from = ANA,
): Promise<string> {
  return deliver(gNew(g, ms, n), from);
}

// --- state readers (actual rows out of the actual engine) -------------------

const roomPresent = (g: string): boolean =>
  q(`SELECT peerId FROM chats WHERE peerId = ?`, g).length === 1;
const anchor = (g: string): Row | undefined =>
  q(`SELECT ownerId, name FROM groups WHERE groupId = ?`, g)[0];
const slots = (g: string): Row[] =>
  q(
    `SELECT memberId, writerId, seq, state FROM group_members
     WHERE groupId = ? ORDER BY memberId, writerId`,
    g,
  );
const settingsRows = (g: string): Row[] =>
  q(
    `SELECT writerId, seq, disappearSec FROM group_settings
     WHERE groupId = ? ORDER BY writerId`,
    g,
  );
const messageRows = (g: string): Row[] =>
  q(
    `SELECT msgId, authorId, body, outsider, status, direction, deletedAt,
            editedAt
     FROM messages WHERE peerId = ? ORDER BY ts, msgId`,
    g,
  );
const heldRows = (): Row[] =>
  q(`SELECT peerId, targetMsgId, writerId, kind FROM pending_revisions`);
const acksFor = (wireId: string): unknown[] =>
  ws.calls.send.mock.calls
    .map(c => c[0] as { type: string; msgId?: string })
    .filter(f => f.type === 'ack' && f.msgId === wireId);
const seen = (wireId: string): boolean =>
  q(`SELECT 1 AS x FROM seen WHERE msgId = ?`, wireId).length === 1;

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
  api.apiGetAttachmentUrl.mockReset();
  api.apiGetAttachmentUrl.mockRejectedValue(new Error('network in test'));
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

// ---------------------------------------------------------------------------

describe('the harness itself', () => {
  test('the real engine executes the real schema (not a recorded no-op)', async () => {
    // A recorded mock answers every SELECT with []. The real engine must
    // disagree: initDb created the four group tables and the seen table.
    const tables = q(
      `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`,
    ).map(r => r.name);
    for (const t of ['groups', 'group_members', 'group_settings', 'group_counters', 'seen']) {
      expect(tables).toContain(t);
    }
  });

  test('every minted id is a wire-legal ULID', () => {
    const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
    for (const id of [ME, ANA, BEN, CARA, DAN, EVE, ROOM, ROOM2, mid('X1')]) {
      expect(id).toMatch(ULID);
    }
  });
});

describe('one switch, not two (the structural half)', () => {
  const src = readFileSync(`${__dirname}/../src/messaging.ts`, 'utf8');
  const count = (needle: string): number => src.split(needle).length - 1;

  test('applyContent exists once and is reached from exactly three callers', () => {
    expect(count('private async applyContent')).toBe(1);
    // Three callers now: the 1:1 path, the room
    // unwrap, and the device-leg unwrap (`dev.msg` — a grouped peer's leg
    // reaches the identical switch with the shared id as its row key). The
    // invariant this pin protects is unchanged: ONE switch, no copied arms.
    expect(count('this.applyContent({')).toBe(3);
  });

  test('the content arms exist exactly once each — a second copy is the defect that shipped twice', () => {
    // The inbound revision arm and the inbound reaction arm. The outbox
    // reconcile path matches on row.direction === 'out' and is not an arm of
    // this switch.
    expect(count("envelope?.tcm === 'edit' || envelope?.tcm === 'del'")).toBe(1);
    expect(count("if (envelope?.tcm === 'react') {")).toBe(1);
  });

  test('the room unwrap routes into the switch and carries no arm of its own', () => {
    const at = src.indexOf('private async handleGroupMessage');
    expect(at).toBeGreaterThan(0);
    const end = src.indexOf('\n  private ', at + 1);
    const body = src.slice(at, end);
    expect(body).toContain('this.applyContent({');
    // No duplicated write path inside the room handler: everything a room
    // message persists is persisted by the shared switch.
    for (const arm of [
      'insertMessage',
      'setReaction',
      'tombstoneMessage',
      'putAttachment',
      'holdRevision',
      'editRow',
    ]) {
      expect(body).not.toContain(arm);
    }
  });
});

describe('Verify 1 — every content kind lands in a room through the shared switch', () => {
  beforeEach(async () => {
    await acceptRoom();
  });

  test('a photo: row, attributed author, pending attachment with real dimensions, preview', async () => {
    const body = JSON.stringify({
      tcm: 'image',
      att: 'blob-1',
      key: 'a2V5',
      w: 320,
      h: 200,
    });
    const wire = await deliver(gMsg(ROOM, mid('P1'), body), ANA);
    const row = q(
      `SELECT * FROM messages WHERE msgId = ? AND direction = 'in'`,
      `${ANA}.${mid('P1')}`,
    )[0]!;
    expect(row).toBeDefined();
    expect(row.peerId).toBe(ROOM);
    expect(row.authorId).toBe(ANA);
    expect(row.body).toBe(body);
    expect(row.outsider).toBeNull();
    const att = q(
      `SELECT w, h FROM attachments WHERE msgId = ? AND direction = 'in'`,
      `${ANA}.${mid('P1')}`,
    )[0]!;
    expect(att).toBeDefined();
    expect(att.w).toBe(320);
    expect(att.h).toBe(200);
    expect(acksFor(wire)).toHaveLength(1);
    const chat = q(`SELECT lastMessageText FROM chats WHERE peerId = ?`, ROOM)[0]!;
    expect(chat.lastMessageText).toBe(previewFor(body));
    expect(previewFor(body)).not.toContain('{'); // never raw JSON in the list
  });

  test('the sender’s per-room counter is stored on the row, and absent means null', async () => {
    // A gate mutated `sq: envelope.sq ?? null` to a constant null and the
    // mutation SURVIVED all 50 tests — the value was wired through and never
    // read back. It is what orders group rows: the thread sorts by
    // (ts, authorId, sq) because a fan-out leg's wire id is random and
    // the server drains an offline queue in wire-id order, so two causally
    // ordered messages can arrive reversed. An unasserted ordering key is one
    // a refactor drops silently.
    await deliver(gMsg(ROOM, mid('Q1'), 'first', 7), ANA);
    expect(
      q(
        `SELECT sq FROM messages WHERE msgId = ? AND direction = 'in'`,
        `${ANA}.${mid('Q1')}`,
      )[0]!.sq,
    ).toBe(7);

    // Absent on the wire — a build predating the field — stores null rather
    // than inventing a number. Null sorts as the order those rows already
    // have, so it must not become 0 or 1 by accident.
    const noSq = JSON.stringify({ tcm: 'grp.msg', g: ROOM, m: mid('Q2'), b: 'second' });
    await deliver(noSq, ANA);
    expect(
      q(
        `SELECT sq FROM messages WHERE msgId = ? AND direction = 'in'`,
        `${ANA}.${mid('Q2')}`,
      )[0]!.sq,
    ).toBeNull();
  });

  test('a file and a voice note: rows plus attachment intents', async () => {
    const file = JSON.stringify({
      tcm: 'file',
      att: 'blob-2',
      key: 'a2V5',
      name: 'lease.pdf',
      size: 1234,
      mime: 'application/pdf',
    });
    const voice = JSON.stringify({
      tcm: 'voice',
      att: 'blob-3',
      key: 'a2V5',
      dur: 4,
    });
    await deliver(gMsg(ROOM, mid('F1'), file), ANA);
    await deliver(gMsg(ROOM, mid('V1'), voice), CARA);
    for (const [author, m] of [
      [ANA, mid('F1')],
      [CARA, mid('V1')],
    ] as const) {
      const key = `${author}.${m}`;
      expect(
        q(`SELECT 1 AS x FROM messages WHERE msgId = ? AND peerId = ?`, key, ROOM),
      ).toHaveLength(1);
      expect(
        q(`SELECT 1 AS x FROM attachments WHERE msgId = ?`, key),
      ).toHaveLength(1);
    }
  });

  test('a location and a reply: ordinary rows, no attachment', async () => {
    const loc = JSON.stringify({ tcm: 'loc', lat: 52.1, lng: 4.3 });
    const reply = JSON.stringify({
      tcm: 'reply',
      ref: `${ANA}.${mid('P1')}`,
      ofs: false,
      text: 'that one',
    });
    await deliver(gMsg(ROOM, mid('X9'), loc), ANA);
    await deliver(gMsg(ROOM, mid('R1'), reply), CARA);
    // The content rows (their keys carry the author prefix); the invitation
    // row from the accept sits beside them.
    const content = messageRows(ROOM).filter(r => String(r.msgId).includes('.'));
    expect(content.map(r => r.body)).toEqual([loc, reply]);
    expect(q(`SELECT 1 AS x FROM attachments`)).toHaveLength(0);
  });

  test('an edit rewrites the author’s own room row in place — no new row, edited mark set', async () => {
    await deliver(gMsg(ROOM, mid('T1'), 'soup at 6'), ANA);
    const before = messageRows(ROOM).length;
    const edit = JSON.stringify({
      tcm: 'edit',
      ref: `${ANA}.${mid('T1')}`,
      text: 'soup at 7',
    });
    await deliver(gMsg(ROOM, mid('E1'), edit), ANA);
    const row = q(
      `SELECT body, editedAt FROM messages WHERE msgId = ?`,
      `${ANA}.${mid('T1')}`,
    )[0]!;
    expect(String(row.body)).toContain('soup at 7');
    expect(row.editedAt).not.toBeNull();
    expect(messageRows(ROOM)).toHaveLength(before); // a rewrite, not a row
  });

  test('a retraction tombstones the author’s own room row', async () => {
    await deliver(gMsg(ROOM, mid('T2'), 'take this back'), ANA);
    const del = JSON.stringify({ tcm: 'del', ref: `${ANA}.${mid('T2')}` });
    await deliver(gMsg(ROOM, mid('D1'), del), ANA);
    const row = q(
      `SELECT body, deletedAt FROM messages WHERE msgId = ?`,
      `${ANA}.${mid('T2')}`,
    )[0]!;
    expect(row.deletedAt).not.toBeNull();
    expect(row.body).toBe('');
  });

  test('a reaction lands against the shared row key, reactor authenticated, direction derived — not claimed', async () => {
    await deliver(gMsg(ROOM, mid('T3'), 'pizza?'), ANA);
    // ofs:true is a LIE about authorship in a fan-out; the room path derives
    // the direction from the ref's author prefix and must ignore the bit.
    const react = JSON.stringify({
      tcm: 'react',
      ref: `${ANA}.${mid('T3')}`,
      ofs: true,
      emoji: '\u{1F44D}',
    });
    await deliver(gMsg(ROOM, mid('K1'), react), CARA);
    const rows = q(
      `SELECT targetDirection, direction, reactorId, emoji FROM reactions
       WHERE targetMsgId = ?`,
      `${ANA}.${mid('T3')}`,
    );
    expect(rows).toEqual([
      {
        targetDirection: 'in', // derived: the author is ANA, not this phone
        direction: 'in',
        reactorId: CARA,
        emoji: '\u{1F44D}',
      },
    ]);
  });

  test('a reaction to MY message derives direction out', async () => {
    // My own fan-out row, as the send path stores it.
    await db.insertMessage({
      msgId: `${ME}.${mid('MYNE')}`,
      peerId: ROOM,
      direction: 'out',
      body: 'my words',
      ts: 8_000,
      status: 'sent',
      authorId: ME,
      sq: 1,
    });
    // ofs:true here is the 1:1 claim "the target is MY OWN message" — from
    // ANA, about MY row, that claim is a lie, and under the 1:1 mapping it
    // would land on 'in'. The room path must derive 'out' from the ref's
    // author prefix and ignore the bit entirely.
    const react = JSON.stringify({
      tcm: 'react',
      ref: `${ME}.${mid('MYNE')}`,
      ofs: true,
      emoji: '\u{2764}',
    });
    await deliver(gMsg(ROOM, mid('K2'), react), ANA);
    const rows = q(
      `SELECT targetDirection, reactorId FROM reactions WHERE targetMsgId = ?`,
      `${ME}.${mid('MYNE')}`,
    );
    expect(rows).toEqual([{ targetDirection: 'out', reactorId: ANA }]);
  });

  test('persist-before-ack ordering holds for a room row exactly as for a 1:1 row', async () => {
    const wire = await deliver(gMsg(ROOM, mid('T4'), 'ordering'), ANA);
    const calls = sqlite.__sqlite.instances
      .get('tacendum.sqlite')!
      .execute.mock.calls.map(c => String(c[0]));
    const insertAt = calls.findIndex(
      (s, i) =>
        s.includes('INSERT OR IGNORE INTO messages') &&
        String(
          sqlite.__sqlite.instances.get('tacendum.sqlite')!.execute.mock.calls[
            i
          ]![1],
        ).includes(mid('T4')),
    );
    const seenAt = calls.findIndex(
      (s, i) =>
        s.includes('INSERT OR IGNORE INTO seen') &&
        String(
          sqlite.__sqlite.instances.get('tacendum.sqlite')!.execute.mock.calls[
            i
          ]![1],
        ).includes(wire),
    );
    expect(insertAt).toBeGreaterThanOrEqual(0);
    expect(seenAt).toBeGreaterThan(insertAt); // row first, seen after, ack last
    expect(acksFor(wire)).toHaveLength(1);
  });
});

describe('Verify 2 — two members reacting to one message are two visible rows', () => {
  test('two reactors, two rows; a reactor repeating replaces only their own', async () => {
    await acceptRoom();
    await deliver(gMsg(ROOM, mid('T1'), 'movie night'), ANA);
    const ref = `${ANA}.${mid('T1')}`;
    const r = (emoji: string) =>
      JSON.stringify({ tcm: 'react', ref, ofs: false, emoji });
    await deliver(gMsg(ROOM, mid('KA'), r('\u{2764}')), ANA);
    await deliver(gMsg(ROOM, mid('KB'), r('\u{1F44D}')), CARA);
    // The UI's own read path, over the real JOIN.
    let visible = await db.listReactions(ROOM);
    expect(visible).toHaveLength(2);
    expect(new Set(visible.map(v => v.reactorId))).toEqual(new Set([ANA, CARA]));
    // CARA changes her mind: still two rows, hers updated, ANA's untouched.
    await deliver(gMsg(ROOM, mid('KC'), r('\u{1F389}'), 2), CARA);
    visible = await db.listReactions(ROOM);
    expect(visible).toHaveLength(2);
    expect(visible.find(v => v.reactorId === CARA)!.emoji).toBe('\u{1F389}');
    expect(visible.find(v => v.reactorId === ANA)!.emoji).toBe('\u{2764}');
  });
});

describe('Verify 3 — a forged del is refused and does not suppress the genuine retraction', () => {
  beforeEach(async () => {
    await acceptRoom();
  });

  test('a forged del naming a present message: not applied, not parked, acked', async () => {
    await deliver(gMsg(ROOM, mid('T1'), 'the target'), ANA);
    const forged = JSON.stringify({ tcm: 'del', ref: `${ANA}.${mid('T1')}` });
    const wire = await deliver(gMsg(ROOM, mid('X1'), forged), CARA);
    const row = q(
      `SELECT deletedAt, body FROM messages WHERE msgId = ?`,
      `${ANA}.${mid('T1')}`,
    )[0]!;
    expect(row.deletedAt).toBeNull();
    expect(row.body).toBe('the target');
    expect(heldRows()).toHaveLength(0); // refused at the door, never parked
    expect(acksFor(wire)).toHaveLength(1); // and never redelivered
  });

  test('a forged edit is refused the same way', async () => {
    await deliver(gMsg(ROOM, mid('T2'), 'honest words'), ANA);
    const forged = JSON.stringify({
      tcm: 'edit',
      ref: `${ANA}.${mid('T2')}`,
      text: 'poisoned',
    });
    await deliver(gMsg(ROOM, mid('X2'), forged), CARA);
    const row = q(
      `SELECT body, editedAt FROM messages WHERE msgId = ?`,
      `${ANA}.${mid('T2')}`,
    )[0]!;
    expect(row.body).toBe('honest words');
    expect(row.editedAt).toBeNull();
  });

  test('the overtake: M’s forgery cannot occupy the slot A’s genuine retraction needs', async () => {
    const ref = `${ANA}.${mid('T3')}`; // not on this phone yet
    // CARA's forgery arrives first — it must park NOTHING.
    await deliver(
      gMsg(ROOM, mid('X3'), JSON.stringify({ tcm: 'del', ref })),
      CARA,
    );
    expect(heldRows()).toHaveLength(0);
    // ANA's genuine retraction overtakes her own message: parked, under HER
    // writer key.
    await deliver(
      gMsg(ROOM, mid('X4'), JSON.stringify({ tcm: 'del', ref })),
      ANA,
    );
    expect(heldRows()).toEqual([
      { peerId: ROOM, targetMsgId: ref, writerId: ANA, kind: 'del' },
    ]);
    // The message lands: the retraction applies the moment the row exists.
    await deliver(gMsg(ROOM, mid('T3'), 'now you see me'), ANA);
    const row = q(
      `SELECT deletedAt, body FROM messages WHERE msgId = ?`,
      ref,
    )[0]!;
    expect(row.deletedAt).not.toBeNull();
    expect(row.body).toBe('');
    expect(heldRows()).toHaveLength(0); // consumed, not lingering
  });
});

describe('Verify 4 — a sender the fold says is out renders tagged, attributed, never dropped', () => {
  test('a never-admitted sender: decrypted, acked byte-identically, tagged row', async () => {
    await acceptRoom(ROOM, [ANA, ME]); // CARA is not in this room
    const memberWire = await deliver(gMsg(ROOM, mid('A1'), 'from ana'), ANA);
    const outsiderWire = await deliver(
      gMsg(ROOM, mid('C1'), 'let me in'),
      CARA,
    );
    const rows = messageRows(ROOM).filter(r => r.status === 'received');
    const fromAna = rows.find(r => r.authorId === ANA)!;
    const fromCara = rows.find(r => r.authorId === CARA)!;
    // Never silently dropped; visibly tagged; attributed. The tag is what a
    // renderer keys on, and NULL-vs-1 is what no assertion can mistake.
    expect(fromCara).toBeDefined();
    expect(fromCara.outsider).toBe(1);
    expect(fromCara.body).toBe('let me in');
    expect(fromAna.outsider).toBeNull();
    // Byte-identical on the wire: same ack shape, seen row, and nothing else
    // sent about either frame.
    expect(acksFor(outsiderWire)).toEqual([
      { type: 'ack', msgId: outsiderWire },
    ]);
    expect(acksFor(memberWire)).toEqual([{ type: 'ack', msgId: memberWire }]);
    expect(seen(outsiderWire)).toBe(true);
  });

  test('a removed member is tagged; the owner re-adding a member the OWNER removed untags', async () => {
    await acceptRoom();
    await deliver(gRoster(ROOM, CARA, 'out', 2), ANA); // owner removes
    await deliver(gMsg(ROOM, mid('C2'), 'still here?'), CARA);
    expect(
      q(`SELECT outsider FROM messages WHERE msgId = ?`, `${CARA}.${mid('C2')}`)[0]!
        .outsider,
    ).toBe(1);
    await deliver(gRoster(ROOM, CARA, 'in', 3), ANA); // owner re-adds
    await deliver(gMsg(ROOM, mid('C3'), 'back'), CARA);
    expect(
      q(`SELECT outsider FROM messages WHERE msgId = ?`, `${CARA}.${mid('C3')}`)[0]!
        .outsider,
    ).toBeNull();
  });

  test('a member who LEFT stays out until their own answering in — the owner’s re-add alone moves nothing', async () => {
    await acceptRoom();
    await deliver(gRoster(ROOM, CARA, 'out', 1), CARA); // her own leave
    await deliver(gMsg(ROOM, mid('C4'), 'one more thing'), CARA);
    expect(
      q(`SELECT outsider FROM messages WHERE msgId = ?`, `${CARA}.${mid('C4')}`)[0]!
        .outsider,
    ).toBe(1);
    // The owner's "re-add" is an invitation, not a return.
    await deliver(gRoster(ROOM, CARA, 'in', 5), ANA);
    await deliver(gMsg(ROOM, mid('C5'), 'am i back?'), CARA);
    expect(
      q(`SELECT outsider FROM messages WHERE msgId = ?`, `${CARA}.${mid('C5')}`)[0]!
        .outsider,
    ).toBe(1);
    // Her own answering in completes the required pair.
    await deliver(gRoster(ROOM, CARA, 'in', 2), CARA);
    await deliver(gMsg(ROOM, mid('C6'), 'back for real'), CARA);
    expect(
      q(`SELECT outsider FROM messages WHERE msgId = ?`, `${CARA}.${mid('C6')}`)[0]!
        .outsider,
    ).toBeNull();
  });
});

describe('Verify 5 — non-owner roster writes: effect nowhere, stored nothing, declined loudly', () => {
  beforeEach(async () => {
    await acceptRoom(ROOM, [ANA, ME, CARA, DAN]);
  });

  test('a non-owner Add stores no slot and renders a declined, attributed row that does not bump the list', async () => {
    const bumpBefore = q(
      `SELECT lastMessageAt FROM chats WHERE peerId = ?`,
      ROOM,
    )[0]!.lastMessageAt;
    const before = slots(ROOM);
    const wire = await deliver(gRoster(ROOM, EVE, 'in', 1), CARA);
    expect(slots(ROOM)).toEqual(before); // nothing stored, no lane grown
    expect(
      q(`SELECT 1 AS x FROM group_members WHERE memberId = ?`, EVE),
    ).toHaveLength(0);
    const declined = messageRows(ROOM).filter(r => r.authorId === CARA);
    expect(declined).toHaveLength(1); // never silently
    expect(declined[0]!.body).toBe(gRoster(ROOM, EVE, 'in', 1));
    expect(
      q(`SELECT lastMessageAt FROM chats WHERE peerId = ?`, ROOM)[0]!
        .lastMessageAt,
    ).toBe(bumpBefore);
    expect(acksFor(wire)).toHaveLength(1);
    // EVE never became a member on this phone: her traffic is tagged.
    await deliver(gMsg(ROOM, mid('EV'), 'hello'), EVE);
    expect(
      q(`SELECT outsider FROM messages WHERE msgId = ?`, `${EVE}.${mid('EV')}`)[0]!
        .outsider,
    ).toBe(1);
  });

  test('a non-owner Remove takes effect nowhere: the victim keeps talking as a member', async () => {
    const before = slots(ROOM);
    await deliver(gRoster(ROOM, DAN, 'out', 1), CARA);
    expect(slots(ROOM)).toEqual(before);
    await deliver(gMsg(ROOM, mid('DN'), 'unbothered'), DAN);
    expect(
      q(`SELECT outsider FROM messages WHERE msgId = ?`, `${DAN}.${mid('DN')}`)[0]!
        .outsider,
    ).toBeNull();
  });

  test('the owner’s equivalents take effect: Remove excludes, Add admits', async () => {
    await deliver(gRoster(ROOM, DAN, 'out', 2), ANA);
    expect(
      slots(ROOM).find(s => s.memberId === DAN && s.writerId === ANA),
    ).toMatchObject({ seq: 2, state: 'out' });
    await deliver(gMsg(ROOM, mid('D1'), 'hello?'), DAN);
    expect(
      q(`SELECT outsider FROM messages WHERE msgId = ?`, `${DAN}.${mid('D1')}`)[0]!
        .outsider,
    ).toBe(1);
    await deliver(gRoster(ROOM, EVE, 'in', 3), ANA);
    await deliver(gMsg(ROOM, mid('E1'), 'thanks for the add'), EVE);
    expect(
      q(`SELECT outsider FROM messages WHERE msgId = ?`, `${EVE}.${mid('E1')}`)[0]!
        .outsider,
    ).toBeNull();
    // Counted changes announce and bump.
    const announced = messageRows(ROOM).filter(r => r.authorId === ANA);
    expect(announced.map(r => r.body)).toEqual(
      expect.arrayContaining([gRoster(ROOM, DAN, 'out', 2), gRoster(ROOM, EVE, 'in', 3)]),
    );
  });

  test('a replayed roster write announces nothing the second time', async () => {
    await deliver(gRoster(ROOM, DAN, 'out', 2), ANA);
    const after = messageRows(ROOM).length;
    await deliver(gRoster(ROOM, DAN, 'out', 2), ANA); // same content, new wire id
    expect(messageRows(ROOM)).toHaveLength(after); // stale: no announcement stream
  });
});

describe('Verify — the consent announcement (grp.consent)', () => {
  beforeEach(async () => {
    await acceptRoom(ROOM, [ANA, ME, CARA, DAN]);
    // DAN is the AGENT of this room: it has spoken an AI-marked message here,
    // so `listRoomAgentAuthorIds(ROOM)` names it. That is what makes a stance
    // ABOUT DAN meaningful — grp.consent's subject must be an agent-class
    // member (marker-OR-record), the same set the consent surface reads.
    await db.insertMessage({
      msgId: `${DAN}.${mid('AISPOKE')}`,
      peerId: ROOM,
      direction: 'in',
      body: 'from the agent',
      ts: 8_500,
      status: 'received',
      authorId: DAN,
      ai: 1,
    });
  });

  test('a member’s own consent stance stores an attributed, inbound event row', async () => {
    const wire = await deliver(gConsent(ROOM, DAN, 'hold', 1), CARA);
    const rows = messageRows(ROOM).filter(r => r.authorId === CARA);
    expect(rows).toHaveLength(1);
    // The body is the envelope verbatim; the SUBJECT is the authenticated
    // sender (authorId = frame.from), never a payload field.
    expect(rows[0]!.body).toBe(gConsent(ROOM, DAN, 'hold', 1));
    expect(rows[0]!.direction).toBe('in');
    expect(acksFor(wire)).toHaveLength(1);
  });

  test('a NON-member cannot narrate the room’s sharing — no row is stored, still drained', async () => {
    const before = messageRows(ROOM).length;
    // EVE is not in [ANA, ME, CARA, DAN]: a stranger who learned the gid.
    const wire = await deliver(gConsent(ROOM, DAN, 'hold', 1), EVE);
    expect(messageRows(ROOM)).toHaveLength(before);
    expect(acksFor(wire)).toHaveLength(1); // drained, never redelivered forever
  });

  test('m3: a stance about a NON-agent subject is dropped — the subject must be an agent-class member, not any account', async () => {
    // CARA is a member (gate 1 passes), but names ANA — a human co-member who
    // is NOT an agent (no machine, no AI-marked message here). A modified
    // client emitting this would render a misleading "ANA isn't sharing"; the
    // subject gate drops it. (Revert the gate and this row IS stored — red.)
    const before = messageRows(ROOM).length;
    const wire = await deliver(gConsent(ROOM, ANA, 'hold', 2), CARA);
    expect(messageRows(ROOM)).toHaveLength(before);
    expect(
      messageRows(ROOM).some(r => String(r.body).includes(gConsent(ROOM, ANA, 'hold', 2))),
    ).toBe(false);
    expect(acksFor(wire)).toHaveLength(1); // still drained, never redelivered
  });

  test('a RELAYED ai-claim about a human never opens the subject gate about them', async () => {
    // Ana (the owner, the only accepted relayer) fabricates one history entry
    // whose body is AI-marked and whose CLAIMED author is CARA — a human
    // co-member. The row stores with ai=1 for the bubble badge (the belt),
    // but the claim is second-hand (`sharedBy`), so it must not admit CARA
    // into the agent set the grp.consent subject gate reads: otherwise the
    // relayer alone could mint "… isn't sharing with Cara" about a human.
    await deliver(
      JSON.stringify({
        tcm: 'grp.hist',
        g: ROOM,
        n: 2,
        to: ME,
        c: 1,
        e: {
          m: mid('HFAKE'),
          a: CARA,
          t: 8_600,
          b: JSON.stringify({ tcm: 'msg', text: 'forged as Cara', ai: true }),
        },
      }),
      ANA,
    );
    // Precondition: the relayed row exists and carries the claim — the stance
    // below is dropped by the first-hand filter alone, not by absence.
    const relayed = q(
      `SELECT ai, sharedBy FROM messages WHERE msgId = ?`,
      `${CARA}.${mid('HFAKE')}`,
    );
    expect(relayed).toHaveLength(1);
    expect(relayed[0]!.ai).toBe(1);
    expect(relayed[0]!.sharedBy).toBe(ANA);
    const before = messageRows(ROOM).length;
    const wire = await deliver(gConsent(ROOM, CARA, 'hold', 2), ANA);
    expect(messageRows(ROOM)).toHaveLength(before); // no stance row about a human
    expect(acksFor(wire)).toHaveLength(1); // still drained
  });

  test('a consent announcement never raises an unread count — an event, not a message', async () => {
    await deliver(gConsent(ROOM, DAN, 'share', 1), CARA);
    const arrived = q(
      `SELECT arrivedAt FROM messages WHERE peerId = ? AND authorId = ?`,
      ROOM,
      CARA,
    );
    expect(arrived).toHaveLength(1);
    expect(arrived[0]!.arrivedAt).toBeNull();
  });
});

/**
 * THE ROSTER-WRITE CLASS (the consent
 * bootstrap fix), receive side. A runtime test proved the consent surface
 * unreachable for every app-only second human: the agent's pre-consent frames
 * are refused (correctly), and the surface waited on an AI-marked row that
 * could therefore never arrive. The owner's roster write now carries the
 * class, so THIS phone learns an agent is present at the natural authority
 * point — before the agent ever speaks.
 */
describe('the roster-write class', () => {
  const slotClass = (g: string, memberId: string, writerId: string): unknown =>
    q(
      `SELECT class FROM group_members WHERE groupId = ? AND memberId = ? AND writerId = ?`,
      g,
      memberId,
      writerId,
    )[0]?.class ?? null;

  test('a grp.new carrying ic persists CLASSED seed slots this phone folds', async () => {
    await deliver(
      JSON.stringify({ tcm: 'grp.new', g: ROOM, nm: 'Kitchen', ms: [ANA, ME, DAN], n: 1, ic: [DAN] }),
      ANA,
    );
    expect(slotClass(ROOM, DAN, ANA)).toBe('integration');
    expect(slotClass(ROOM, ME, ANA)).toBeNull();
    const fold = foldRoster(ANA, await db.listGroupMemberSlots(ROOM));
    expect(fold.classes[DAN]).toBe('integration');
    expect(fold.classes[ME]).toBeUndefined();
  });

  test('an OWNER grp.roster carrying c persists the class; the fold reads it', async () => {
    await acceptRoom(ROOM, [ANA, ME, CARA]);
    await deliver(
      JSON.stringify({ tcm: 'grp.roster', g: ROOM, m: DAN, s: 'in', n: 2, c: 'integration' }),
      ANA,
    );
    expect(slotClass(ROOM, DAN, ANA)).toBe('integration');
    const fold = foldRoster(ANA, await db.listGroupMemberSlots(ROOM));
    expect(fold.classes[DAN]).toBe('integration');
    expect(verdictFor(fold, DAN)).toBe('in');
  });

  test('a NON-owner write carrying c moves NO class — only the authority lane classifies', async () => {
    await acceptRoom(ROOM, [ANA, ME, CARA]);
    // CARA's own sovereign rejoin, self-classed: sovereignty may stand, the
    // class claim must not surface anywhere.
    await deliver(
      JSON.stringify({ tcm: 'grp.roster', g: ROOM, m: CARA, s: 'in', n: 5, c: 'integration' }),
      CARA,
    );
    const fold = foldRoster(ANA, await db.listGroupMemberSlots(ROOM));
    expect(fold.classes[CARA]).toBeUndefined();
  });

  test('class NEVER admits: an ic id outside ms folds nobody in', async () => {
    await deliver(
      JSON.stringify({ tcm: 'grp.new', g: ROOM, nm: 'Kitchen', ms: [ANA, ME], n: 1, ic: [EVE] }),
      ANA,
    );
    const fold = foldRoster(ANA, await db.listGroupMemberSlots(ROOM));
    expect(verdictFor(fold, EVE)).toBe('out');
    expect(fold.classes[EVE]).toBeUndefined();
  });

  test('THE DEADLOCK, inverted: grp.consent about a CLASS-ONLY agent — zero ai rows — now stores its row', async () => {
    // The stranger's phone: the agent DAN has NEVER spoken here (no messages,
    // no machine_peers), only the owner's classed roster names it. Before the
    // rule this stance was dropped (the subject gate read marker-OR-record
    // alone) — the exact loop that made the consent surface unreachable.
    await deliver(
      JSON.stringify({ tcm: 'grp.new', g: ROOM, nm: 'Kitchen', ms: [ANA, ME, CARA, DAN], n: 1, ic: [DAN] }),
      ANA,
    );
    const wire = await deliver(gConsent(ROOM, DAN, 'hold', 1), CARA);
    const rows = messageRows(ROOM).filter(r => r.authorId === CARA);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.body).toBe(gConsent(ROOM, DAN, 'hold', 1));
    expect(acksFor(wire)).toHaveLength(1);
  });

  test('grp.hist BELT: a relayed MARKED envelope body back-fills messages.ai raise-only', async () => {
    await acceptRoom(ROOM, [ANA, ME, CARA]);
    const marked = JSON.stringify({ tcm: 'msg', text: 'from the agent, relayed', ai: true });
    const bare = JSON.stringify({ tcm: 'msg', text: 'from a human, relayed' });
    await deliver(
      JSON.stringify({
        tcm: 'grp.hist',
        g: ROOM,
        n: 2,
        to: ME,
        c: 2,
        e: { m: mid('HM'), a: DAN, t: 8_000, b: marked },
      }),
      ANA,
    );
    await deliver(
      JSON.stringify({
        tcm: 'grp.hist',
        g: ROOM,
        n: 2,
        to: ME,
        c: 2,
        e: { m: mid('HB'), a: CARA, t: 8_001, b: bare },
      }),
      ANA,
    );
    const rows = q(
      `SELECT msgId, ai, sharedBy FROM messages WHERE peerId = ? AND sharedBy IS NOT NULL ORDER BY ts`,
      ROOM,
    );
    expect(rows).toHaveLength(2);
    // The marked relay carries its claim into the row — DETECTION back-fill
    // only: sharedBy still marks it a second-hand, unauthenticated account.
    expect(rows[0]!.ai).toBe(1);
    expect(rows[0]!.sharedBy).toBe(ANA);
    // The bare relay stays unmarked — raise-only, never invented.
    expect(rows[1]!.ai).toBeNull();
  });
});

describe('Verify 6 — no write is ever held as waiting', () => {
  test('there is no held-write store anywhere in the schema', () => {
    const tables = q(`SELECT name FROM sqlite_master WHERE type = 'table'`).map(
      r => String(r.name),
    );
    for (const t of tables) {
      expect(t).not.toMatch(/held|wait|queue|pending_writes|group_slots/i);
    }
    // pending_revisions is the one legitimate park (a revision racing its own
    // message) and it must not be colonised by roster machinery: after the
    // adversarial deliveries below it stays empty.
  });

  test('a pre-anchor AUTHORITY write stores nothing anywhere, and the owner’s next write heals', async () => {
    // No grp.new for ROOM2 has arrived. The owner's claim about CARA cannot
    // be classified and must be dropped whole — not parked, not slotted.
    const wire = await deliver(gRoster(ROOM2, CARA, 'out', 2), ANA);
    expect(q(`SELECT * FROM group_members WHERE groupId = ?`, ROOM2)).toHaveLength(0);
    expect(q(`SELECT * FROM groups WHERE groupId = ?`, ROOM2)).toHaveLength(0);
    expect(q(`SELECT * FROM messages WHERE peerId = ?`, ROOM2)).toHaveLength(0);
    expect(heldRows()).toHaveLength(0);
    expect(acksFor(wire)).toHaveLength(1);
    // The anchor lands; CARA folds in off the seed alone (the drop lost the
    // removal, exactly as documented)...
    await acceptRoom(ROOM2, [ANA, ME, CARA]);
    await deliver(gMsg(ROOM2, mid('C7'), 'hi'), CARA);
    expect(
      q(`SELECT outsider FROM messages WHERE msgId = ?`, `${CARA}.${mid('C7')}`)[0]!
        .outsider,
    ).toBeNull();
    // ...and the owner's next write about that member restates the truth.
    await deliver(gRoster(ROOM2, CARA, 'out', 3), ANA);
    await deliver(gMsg(ROOM2, mid('C8'), 'hi again'), CARA);
    expect(
      q(`SELECT outsider FROM messages WHERE msgId = ?`, `${CARA}.${mid('C8')}`)[0]!
        .outsider,
    ).toBe(1);
  });

  test('a pre-anchor SOVEREIGN write lands in its final slot — classified, not waiting', async () => {
    await deliver(gRoster(ROOM2, CARA, 'out', 1), CARA); // her own departure
    // Stored at its ordinary winner-per-key home, silently.
    expect(slots(ROOM2)).toEqual([
      { memberId: CARA, writerId: CARA, seq: 1, state: 'out' },
    ]);
    expect(q(`SELECT * FROM messages WHERE peerId = ?`, ROOM2)).toHaveLength(0);
    expect(heldRows()).toHaveLength(0);
    // When the anchor arrives, her pre-anchor departure holds: sovereignty
    // was never waiting for the owner.
    await acceptRoom(ROOM2, [ANA, ME, CARA]);
    await deliver(gMsg(ROOM2, mid('C9'), 'straggler'), CARA);
    expect(
      q(`SELECT outsider FROM messages WHERE msgId = ?`, `${CARA}.${mid('C9')}`)[0]!
        .outsider,
    ).toBe(1);
  });
});

describe('Verify 7 — grp.del', () => {
  test('a non-owner’s delete renders declined and changes nothing', async () => {
    await acceptRoom();
    await deliver(gMsg(ROOM, mid('T1'), 'history'), ANA);
    const anchorBefore = anchor(ROOM);
    const slotsBefore = slots(ROOM);
    const wire = await deliver(gDel(ROOM, 9), CARA);
    expect(anchor(ROOM)).toEqual(anchorBefore);
    expect(slots(ROOM)).toEqual(slotsBefore);
    expect(roomPresent(ROOM)).toBe(true);
    const declined = messageRows(ROOM).filter(
      r => r.authorId === CARA && r.body === gDel(ROOM, 9),
    );
    expect(declined).toHaveLength(1); // attributed, never silent
    expect(acksFor(wire)).toHaveLength(1);
    // The history survived.
    expect(
      q(`SELECT 1 AS x FROM messages WHERE msgId = ?`, `${ANA}.${mid('T1')}`),
    ).toHaveLength(1);
  });

  test('a delete for a room this phone does not hold does nothing — and stores no tombstone', async () => {
    const before = q(`SELECT COUNT(*) AS c FROM messages`)[0]!.c;
    const wire = await deliver(gDel(ROOM2), ANA);
    expect(q(`SELECT COUNT(*) AS c FROM messages`)[0]!.c).toBe(before);
    expect(q(`SELECT * FROM groups`)).toHaveLength(0);
    expect(q(`SELECT * FROM chats WHERE peerId = ?`, ROOM2)).toHaveLength(0);
    expect(acksFor(wire)).toHaveLength(1);
  });

  test('the owner’s delete is the FULL purge — and never touches blocks or 1:1 rows', async () => {
    // A 1:1 conversation with BEN, with a reaction — the exact rows a
    // room-purge mutation once reached for.
    await db.upsertChat(BEN);
    await db.insertMessage({
      msgId: mid('B1'),
      peerId: BEN,
      direction: 'in',
      body: 'unrelated',
      ts: 1_000,
      status: 'received',
    });
    await db.setReaction(mid('B1'), 'in', 'out', '\u{1F44D}', 1_000);
    await messaging.blockPeer(EVE);
    await acceptRoom();
    await deliver(gMsg(ROOM, mid('T1'), 'to be purged'), ANA);
    await deliver(gSet(ROOM, 60, 1), CARA);
    const wire = await deliver(gDel(ROOM), ANA);
    // Everything the room owned is gone.
    expect(anchor(ROOM)).toBeUndefined();
    expect(slots(ROOM)).toHaveLength(0);
    expect(settingsRows(ROOM)).toHaveLength(0);
    expect(q(`SELECT * FROM group_counters WHERE groupId = ?`, ROOM)).toHaveLength(0);
    expect(roomPresent(ROOM)).toBe(false);
    expect(messageRows(ROOM)).toHaveLength(0);
    expect(acksFor(wire)).toHaveLength(1);
    // Nothing that was not the room's is touched.
    expect(q(`SELECT * FROM blocked_peers WHERE peerId = ?`, EVE)).toHaveLength(1);
    expect(q(`SELECT * FROM messages WHERE peerId = ?`, BEN)).toHaveLength(1);
    expect(q(`SELECT * FROM reactions WHERE targetMsgId = ?`, mid('B1'))).toHaveLength(1);
    expect(q(`SELECT * FROM chats WHERE peerId = ?`, BEN)).toHaveLength(1);
    // Later traffic for the dead room: acked, discarded, recreates nothing.
    const late = await deliver(gMsg(ROOM, mid('T2'), 'anyone?'), CARA);
    expect(roomPresent(ROOM)).toBe(false);
    expect(messageRows(ROOM)).toHaveLength(0);
    expect(acksFor(late)).toHaveLength(1);
  });

  test('the grp.new race, asserted per order: new-then-del purges; del-then-new is the documented stillborn room', async () => {
    // Order 1: the room exists, then the delete lands — absent.
    await acceptRoom(ROOM, [ANA, ME]);
    await deliver(gDel(ROOM), ANA);
    expect(anchor(ROOM)).toBeUndefined();
    expect(roomPresent(ROOM)).toBe(false);
    // Order 2: the delete outruns the grp.new — a no-op with no tombstone —
    // and the invitation then lands as a room on this one phone.
    await deliver(gDel(ROOM2), ANA);
    await acceptRoom(ROOM2, [ANA, ME]);
    expect(anchor(ROOM2)).toMatchObject({ ownerId: ANA });
    expect(roomPresent(ROOM2)).toBe(true);
  });

  test('a REPLAYED genuine delete cannot re-purge a re-anchored room (the transport backstop the fold defers to)', async () => {
    await acceptRoom(ROOM, [ANA, ME]);
    const delWire = await deliver(gDel(ROOM), ANA);
    expect(anchor(ROOM)).toBeUndefined();
    // The owner re-creates a room under the same id (dishonest composers can;
    // the fold's classifier is memoryless by design).
    await acceptRoom(ROOM, [ANA, ME], 2);
    expect(roomPresent(ROOM)).toBe(true);
    // The old delete frame is REPLAYED: same wire msgId. hasSeen re-acks and
    // changes nothing.
    await deliver(gDel(ROOM), ANA, delWire);
    expect(roomPresent(ROOM)).toBe(true);
    expect(anchor(ROOM)).toMatchObject({ ownerId: ANA });
    expect(acksFor(delWire)).toHaveLength(2); // re-acked, byte-identically
  });
});

describe('Verify 8 — local delete follows deleteChat’s precedent through the real apply path', () => {
  test('delete then new traffic recreates the room with its roster current', async () => {
    await messaging.blockPeer(EVE);
    await acceptRoom(ROOM, [ANA, ME, CARA, DAN]);
    await deliver(gRoster(ROOM, DAN, 'out', 2), ANA); // roster history
    await deliver(gMsg(ROOM, mid('T1'), 'before delete'), ANA);
    const slotsBefore = slots(ROOM);
    await db.deleteGroup(ROOM); // the drawer's local delete
    expect(roomPresent(ROOM)).toBe(false);
    expect(messageRows(ROOM)).toHaveLength(0);
    expect(slots(ROOM)).toEqual(slotsBefore); // state outlives content
    expect(anchor(ROOM)).toMatchObject({ ownerId: ANA });
    // New traffic recreates — with the roster it kept.
    await deliver(gMsg(ROOM, mid('T2'), 'still on?'), CARA);
    expect(roomPresent(ROOM)).toBe(true);
    expect(
      q(`SELECT kind FROM chats WHERE peerId = ?`, ROOM)[0]!.kind,
    ).toBe('group');
    expect(slots(ROOM)).toEqual(slotsBefore);
    expect(
      q(`SELECT outsider FROM messages WHERE msgId = ?`, `${CARA}.${mid('T2')}`)[0]!
        .outsider,
    ).toBeNull();
    // DAN was removed before the delete; the kept roster still knows.
    await deliver(gMsg(ROOM, mid('T3'), 'me too?'), DAN);
    expect(
      q(`SELECT outsider FROM messages WHERE msgId = ?`, `${DAN}.${mid('T3')}`)[0]!
        .outsider,
    ).toBe(1);
    expect(q(`SELECT * FROM blocked_peers WHERE peerId = ?`, EVE)).toHaveLength(1);
  });

  test('leave then delete stays gone against straggler traffic', async () => {
    await messaging.blockPeer(EVE);
    await acceptRoom();
    // My own leave, as the send path records it: my sovereign out slot.
    engine
      .prepare(
        `INSERT OR REPLACE INTO group_members
           (groupId, memberId, writerId, seq, state, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .all(ROOM, ME, ME, 1, 'out', 0);
    await db.deleteGroup(ROOM);
    expect(roomPresent(ROOM)).toBe(false);
    // Straggler traffic: acked, recreates nothing, leaves no row.
    const wire = await deliver(gMsg(ROOM, mid('T4'), 'you left?'), CARA);
    expect(roomPresent(ROOM)).toBe(false);
    expect(messageRows(ROOM)).toHaveLength(0);
    expect(acksFor(wire)).toHaveLength(1);
    // A counted roster write still lands in the slots (state survives), but
    // the room does not come back for someone whose own fold says out.
    await deliver(gRoster(ROOM, DAN, 'in', 5), ANA);
    expect(roomPresent(ROOM)).toBe(false);
    expect(q(`SELECT * FROM blocked_peers WHERE peerId = ?`, EVE)).toHaveLength(1);
  });
});

describe('grp.set through the apply path', () => {
  beforeEach(async () => {
    await acceptRoom(ROOM, [ANA, ME, CARA]);
  });

  test('a member’s timer write applies, announces once, and a replay announces nothing', async () => {
    const wire = await deliver(gSet(ROOM, 60, 1), CARA);
    expect(settingsRows(ROOM)).toEqual([
      { writerId: CARA, seq: 1, disappearSec: 60 },
    ]);
    const announced = messageRows(ROOM).filter(r => r.body === gSet(ROOM, 60, 1));
    expect(announced).toHaveLength(1);
    expect(announced[0]!.authorId).toBe(CARA);
    expect(acksFor(wire)).toHaveLength(1);
    // Replay (same seq, new wire id): stale — no second announcement, no
    // slot movement, still acked.
    const replay = await deliver(gSet(ROOM, 60, 1), CARA);
    expect(
      messageRows(ROOM).filter(r => r.body === gSet(ROOM, 60, 1)),
    ).toHaveLength(1);
    expect(settingsRows(ROOM)).toEqual([
      { writerId: CARA, seq: 1, disappearSec: 60 },
    ]);
    expect(acksFor(replay)).toHaveLength(1);
  });

  test('the effective timer over the REAL stored rows: minimum across in-members, outsiders excluded', async () => {
    await deliver(gSet(ROOM, 60, 1), CARA);
    await deliver(gSet(ROOM, 45, 1), ANA);
    // EVE is not in the room; her slot stores (every settings slot is its
    // writer's own) but must never constrain the members' timer.
    await deliver(gSet(ROOM, 10, 1), EVE);
    const stored = settingsRows(ROOM).map(r => ({
      writerId: String(r.writerId),
      seq: Number(r.seq),
      disappearSec: Number(r.disappearSec),
    }));
    expect(stored.map(s => s.writerId).sort()).toEqual([ANA, CARA, EVE].sort());
    const storedSlots = slots(ROOM).map(s => ({
      memberId: String(s.memberId),
      writerId: String(s.writerId),
      seq: Number(s.seq),
      state: s.state as 'in' | 'out',
    }));
    const fold = foldRoster(ANA, storedSlots);
    expect(verdictFor(fold, EVE)).toBe('out');
    expect(effectiveDisappearSec(stored, fold)).toBe(45);
  });
});

describe('the quiet drops', () => {
  test('a future-shaped group frame acks and leaves no row anywhere — not even an Unsupported one', async () => {
    const wire = await deliver(
      `{"tcm":"grp.zzz","g":"${ROOM}","payload":"future"}`,
      ANA,
    );
    expect(q(`SELECT COUNT(*) AS c FROM messages`)[0]!.c).toBe(0);
    expect(q(`SELECT * FROM chats`)).toHaveLength(0);
    expect(acksFor(wire)).toHaveLength(1);
    expect(seen(wire)).toBe(true);
  });

  test('a malformed grp.msg is the same quiet drop', async () => {
    const wire = await deliver(
      `{"tcm":"grp.msg","g":"${ROOM}","m":"not-a-ulid","b":"x"}`,
      ANA,
    );
    expect(q(`SELECT COUNT(*) AS c FROM messages`)[0]!.c).toBe(0);
    expect(acksFor(wire)).toHaveLength(1);
  });

  test('laundering refused: a grp.roster inside a grp.msg moves no slot and leaves no row', async () => {
    await acceptRoom();
    const before = slots(ROOM);
    const msgsBefore = messageRows(ROOM).length;
    // The schema refuses to PARSE a nested grp.*; the whole frame becomes the quiet drop — and the smuggled roster write must not apply.
    const wire = await deliver(
      gMsg(ROOM, mid('N1'), gRoster(ROOM, CARA, 'out', 9)),
      CARA,
    );
    expect(slots(ROOM)).toEqual(before);
    expect(messageRows(ROOM)).toHaveLength(msgsBefore);
    expect(acksFor(wire)).toHaveLength(1);
  });

  test('pairwise settings kinds inside a room wrapper are dropped, not applied', async () => {
    await acceptRoom();
    const msgsBefore = messageRows(ROOM).length;
    // A two-party timer inside a room would bypass the room's own lattice.
    const timerWire = await deliver(
      gMsg(ROOM, mid('N2'), JSON.stringify({ tcm: 'timer', s: 5, v: 1 })),
      CARA,
    );
    expect(
      q(`SELECT disappearSec FROM chats WHERE peerId = ?`, ROOM)[0]!
        .disappearSec,
    ).toBeNull();
    // A vault write inside a room would write a two-party vault slot. The
    // body is a VALID VaultEnvelope — it parses, and the drop list is what
    // refuses it.
    const vaultWire = await deliver(
      gMsg(
        ROOM,
        mid('N3'),
        JSON.stringify({
          tcm: 'vault',
          op: 'set',
          id: mid('VV'),
          title: 't',
          body: 'b',
          n: 1,
          k: 0,
        }),
      ),
      CARA,
    );
    expect(q(`SELECT * FROM vault_items`)).toHaveLength(0);
    // A read receipt inside a room: rooms do not do receipts.
    const readWire = await deliver(
      gMsg(ROOM, mid('N4'), JSON.stringify({ tcm: 'read', ids: [mid('T9')] })),
      CARA,
    );
    expect(messageRows(ROOM)).toHaveLength(msgsBefore);
    for (const w of [timerWire, vaultWire, readWire]) {
      expect(acksFor(w)).toHaveLength(1);
    }
  });

  test('call signalling and a profile card inside a room wrapper are dropped too', async () => {
    // A gate mutated these two arms out of the drop list and BOTH mutations
    // survived all 50 tests: only timer/vault/read were exercised above. The
    // code was right; the suite could not tell. A profile card inside a room
    // would let a sender rewrite their card through a path that skips the
    // 1:1 profile checks, and call signalling has no meaning in a room at
    // all — it is routed by namespace long before this point, so an inner
    // one is a dishonest composer, not a newer build.
    await acceptRoom();
    const msgsBefore = messageRows(ROOM).length;
    const nameBefore = q(`SELECT displayName FROM chats WHERE peerId = ?`, CARA)[0]
      ?.displayName;

    const profileWire = await deliver(
      gMsg(
        ROOM,
        mid('N5'),
        // A VALID ProfileEnvelope — it parses, and the drop list is what
        // refuses it. A malformed one would fall through as plain text and
        // prove nothing (the trap this suite keeps catching).
        JSON.stringify({ tcm: 'profile', n: 'Impostor', a: '', v: 99 }),
      ),
      CARA,
    );
    const callWire = await deliver(
      gMsg(
        ROOM,
        mid('N6'),
        JSON.stringify({ tcm: 'call.end', cid: mid('C1'), r: 'hangup' }),
      ),
      CARA,
    );

    // Neither leaves a row, and the profile card did not touch the sender's
    // name anywhere.
    expect(messageRows(ROOM)).toHaveLength(msgsBefore);
    expect(
      q(`SELECT displayName FROM chats WHERE peerId = ?`, CARA)[0]?.displayName,
    ).toBe(nameBefore);
    // Still acked byte-identically — a dropped frame must not stall the drain.
    for (const w of [profileWire, callWire]) {
      expect(acksFor(w)).toHaveLength(1);
    }
  });
});

describe('grp.new', () => {
  test('an accepted grp.new anchors the room, writes the attributed row, and names it', async () => {
    const wire = await acceptRoom();
    expect(anchor(ROOM)).toEqual({ ownerId: ANA, name: 'Kitchen' });
    const chat = q(
      `SELECT kind, groupName, lastMessageText FROM chats WHERE peerId = ?`,
      ROOM,
    )[0]!;
    expect(chat.kind).toBe('group');
    expect(chat.groupName).toBe('Kitchen');
    expect(chat.lastMessageText).toBe('New group');
    const rows = messageRows(ROOM);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.authorId).toBe(ANA);
    expect(rows[0]!.body).toBe(gNew(ROOM, [ANA, ME, CARA], 1));
    expect(acksFor(wire)).toHaveLength(1);
    // The seeds are owner-lane in slots; the owner folds in from them alone.
    expect(slots(ROOM)).toEqual(
      expect.arrayContaining([
        { memberId: ANA, writerId: ANA, seq: 1, state: 'in' },
        { memberId: ME, writerId: ANA, seq: 1, state: 'in' },
        { memberId: CARA, writerId: ANA, seq: 1, state: 'in' },
      ]),
    );
  });

  test('a grp.new whose ms omits its own sender still folds the sender in (the clamp, through the apply path)', async () => {
    await acceptRoom(ROOM, [ME, CARA]); // ANA absent from her own list
    expect(
      slots(ROOM).find(s => s.memberId === ANA && s.writerId === ANA),
    ).toMatchObject({ state: 'in' });
    await deliver(gMsg(ROOM, mid('A2'), 'my room'), ANA);
    expect(
      q(`SELECT outsider FROM messages WHERE msgId = ?`, `${ANA}.${mid('A2')}`)[0]!
        .outsider,
    ).toBeNull();
  });

  test('a duplicate grp.new from the SAME writer merges seeds; an exact replay changes nothing', async () => {
    await acceptRoom(ROOM, [ANA, ME], 1);
    const rowsAfterAccept = messageRows(ROOM).length;
    await deliver(gNew(ROOM, [ANA, ME, CARA], 2), ANA); // later seed set
    expect(
      slots(ROOM).find(s => s.memberId === CARA && s.writerId === ANA),
    ).toMatchObject({ seq: 2, state: 'in' });
    expect(messageRows(ROOM)).toHaveLength(rowsAfterAccept); // no second surface row
    const slotsBefore = slots(ROOM);
    const replay = await deliver(gNew(ROOM, [ANA, ME, CARA], 2), ANA);
    expect(slots(ROOM)).toEqual(slotsBefore);
    expect(acksFor(replay)).toHaveLength(1);
  });

  test('a grp.new from a DIFFERENT writer is ignored whole: the anchor is written once', async () => {
    await acceptRoom(ROOM, [ANA, ME]);
    const slotsBefore = slots(ROOM);
    const wire = await deliver(gNew(ROOM, [CARA, ME], 5), CARA);
    expect(anchor(ROOM)).toMatchObject({ ownerId: ANA }); // never re-anchored
    expect(slots(ROOM)).toEqual(slotsBefore); // forged seeds store nothing
    expect(messageRows(ROOM).some(r => r.authorId === CARA)).toBe(false);
    expect(acksFor(wire)).toHaveLength(1);
  });
});

describe('blocking in rooms', () => {
  test('a blocked member’s room traffic decrypts, acks byte-identically, and leaves nothing', async () => {
    await acceptRoom();
    await messaging.blockPeer(CARA);
    const wire = await deliver(gMsg(ROOM, mid('C1'), 'can you see this'), CARA);
    expect(crypto.decryptEnvelope).toHaveBeenCalled(); // ratchet health
    expect(messageRows(ROOM).some(r => r.authorId === CARA)).toBe(false);
    expect(acksFor(wire)).toEqual([{ type: 'ack', msgId: wire }]);
    expect(seen(wire)).toBe(true);
    // An unblocked member still lands.
    await deliver(gMsg(ROOM, mid('A1'), 'i can'), ANA);
    expect(messageRows(ROOM).some(r => r.authorId === ANA && r.body === 'i can')).toBe(true);
  });

  test('a blocked author’s blob is never fetched at boot — the gate sees the AUTHOR, not the room', async () => {
    await acceptRoom();
    // CARA posts a photo while unblocked; the fetch hangs, so her attachment
    // row stays 'pending' for the boot reconcile. (One hang only:
    // MAX_CONCURRENT_DOWNLOADS is 2 and stop() does not reclaim in-flight
    // slots, so a second hang would wedge the pump and make this vacuous.)
    api.apiGetAttachmentUrl.mockImplementation(() => new Promise(() => undefined));
    const photo = (att: string) =>
      JSON.stringify({ tcm: 'image', att, key: 'a2V5', w: 10, h: 10 });
    await deliver(gMsg(ROOM, mid('P9'), photo('blob-cara')), CARA);
    const attsFetched = () =>
      api.apiGetAttachmentUrl.mock.calls.map(c => String(c[1]));
    expect(attsFetched()).toEqual(['blob-cara']);
    // ANA's photo arrived while this phone was off: row + pending intent on
    // disk, no fetch attempted yet — the reconcile control.
    await db.insertMessage({
      msgId: `${ANA}.${mid('PA')}`,
      peerId: ROOM,
      direction: 'in',
      body: photo('blob-ana'),
      ts: 9_500,
      status: 'received',
      authorId: ANA,
      sq: 9,
    });
    await db.putAttachment(`${ANA}.${mid('PA')}`, 'in', 'pending', null, 10, 10);
    await messaging.blockPeer(CARA);
    // Relaunch: reconcile resumes pending downloads — ANA's proves the resume
    // path is live, and CARA's must be the exception, because a blob fetch is
    // a read receipt through a side channel and a room id itself is never
    // blockable.
    messaging.stop();
    await messaging.start(ME);
    await flush();
    expect(attsFetched().slice(1)).toContain('blob-ana'); // the control refetches
    expect(attsFetched().slice(1)).not.toContain('blob-cara'); // the block holds
  });
});

/**
 * `grp.hist` — history shared with a newcomer.
 *
 * This reverses a property the app promised until today ("people you add see
 * what happens next, not what happened before"), so the tests are written
 * around the four rules that make the reversal defensible rather than merely
 * convenient — and around the one thing the ratchet CANNOT give us: a
 * relayed entry is the relayer's account of someone else's words, never an
 * authenticated one.
 */
describe('grp.hist — the owner relays history, and only the owner', () => {
  const gHist = (
    over: Record<string, unknown> = {},
    entry?: Record<string, unknown>,
  ): string =>
    JSON.stringify({
      tcm: 'grp.hist',
      g: ROOM,
      n: 7,
      to: ME,
      c: 1,
      ...(entry
        ? { e: { m: pad('5PAST'), a: CARA, t: 1_000, b: 'said before I arrived', ...entry } }
        : {}),
      ...over,
    });

  const relayed = (): Row[] =>
    q(
      `SELECT msgId, authorId, body, sharedBy, ts, expiresAt
       FROM messages WHERE peerId = ? AND sharedBy IS NOT NULL ORDER BY msgId`,
      ROOM,
    );

  it('stores the entry as an ACCOUNT: claimed author kept, relayer recorded, key is the author’s', async () => {
    await acceptRoom();
    await deliver(gHist({}, {}), ANA);

    // sharedBy is what stops this row being read as authenticated anywhere.
    // Without it the row is indistinguishable from one Cara actually sent me.
    expect(relayed()).toEqual([
      {
        msgId: `${CARA}.${pad('5PAST')}`, // the AUTHOR's key, not the relayer's
        authorId: CARA,
        body: 'said before I arrived',
        sharedBy: ANA,
        ts: 1_000, // the ORIGINAL time, not now
        expiresAt: null,
      },
    ]);
  });

  it('a NON-OWNER cannot inject history — declined row, nothing stored', async () => {
    await acceptRoom(); // Ana owns it; Cara is an ordinary member
    await deliver(gHist({}, {}), CARA);

    // The whole security property: a member who is not the owner can relay
    // nothing. If this ever passes, any member can fabricate a conversation
    // and have it land in everyone's thread wearing someone else's name.
    expect(relayed()).toEqual([]);
    // ...but it is not silent: the attempt is an attributed row, exactly as a
    // declined roster write is.
    expect(messageRows(ROOM).some(r => r.authorId === CARA)).toBe(true);
  });

  it('the timer binds against MY clock, not the relayer’s: an already-expired entry is dropped', async () => {
    await acceptRoom();
    await deliver(gHist({}, { x: Date.now() - 1 }), ANA);
    expect(relayed()).toEqual([]);

    // The control: the same entry with a live expiry DOES land, so the test
    // above is failing on expiry and not on some unrelated refusal.
    const future = Date.now() + 600_000;
    await deliver(gHist({}, { m: pad('6NEXT'), x: future }), ANA);
    expect(relayed().map(r => r.expiresAt)).toEqual([future]);
  });

  it('a first-hand copy I already hold beats the relayed account', async () => {
    await acceptRoom();
    // Cara's real message arrives first, first-hand.
    await deliver(gMsg(ROOM, pad('5PAST'), 'what Cara really said'), CARA);
    // Then Ana relays a DIFFERENT body under the same message id.
    await deliver(gHist({}, { b: 'what Ana claims Cara said' }), ANA);

    const row = messageRows(ROOM).find(r => r.msgId === `${CARA}.${pad('5PAST')}`);
    expect(row?.body).toBe('what Cara really said');
    expect(relayed()).toEqual([]); // nothing on this row is second-hand
  });

  it('and the reverse: the author’s own copy SUPERSEDES an account I was given first', async () => {
    await acceptRoom();
    await deliver(gHist({}, { b: 'what Ana claims Cara said' }), ANA);
    expect(relayed()).toHaveLength(1);

    // A straggler re-fan reaches me with the real thing. INSERT OR IGNORE
    // alone would leave the relayer's claim standing in front of the author's
    // own words forever, which is the wrong way round.
    await deliver(gMsg(ROOM, pad('5PAST'), 'what Cara really said'), CARA);

    const row = messageRows(ROOM).find(r => r.msgId === `${CARA}.${pad('5PAST')}`);
    expect(row?.body).toBe('what Cara really said');
    expect(relayed()).toEqual([]); // provenance upgraded, never downgraded
  });

  it('supersede only ever UPGRADES provenance — it is not a silent edit channel', async () => {
    // Found by mutation: deleting `AND sharedBy IS NOT NULL` from
    // supersedeRelayed passed the entire suite. That clause is the only thing
    // scoping the UPDATE to second-hand rows, and without it an author
    // re-fanning the same `m` with different words would silently rewrite
    // their own delivered message — no `editedAt`, no "edited" marker, none
    // of the writer-keyed machinery. A rewrite that leaves no trace is
    // exactly what the edit path exists to prevent.
    await acceptRoom();
    await deliver(gMsg(ROOM, pad('5PAST'), 'what I said'), CARA);
    await deliver(gMsg(ROOM, pad('5PAST'), 'what I wish I had said'), CARA);

    const row = messageRows(ROOM).find(r => r.msgId === `${CARA}.${pad('5PAST')}`);
    expect(row?.body).toBe('what I said');
    expect(row?.editedAt).toBeNull(); // and no edit was invented either
  });

  it('a transcript leg does not touch the chat preview — 200 relayed messages are not 200 notifications', async () => {
    await acceptRoom();
    const before = q(
      `SELECT lastMessageText, lastMessageAt FROM chats WHERE peerId = ?`,
      ROOM,
    )[0];
    await deliver(gHist({}, {}), ANA);
    // The words of a past message must not surface on a lock screen dated
    // today, and history must not reorder the newcomer's chat list.
    expect(q(`SELECT lastMessageText, lastMessageAt FROM chats WHERE peerId = ?`, ROOM)[0]).toEqual(
      before,
    );
  });

  it('the announcement DOES surface — the room is told, and that is rule 3', async () => {
    await acceptRoom();
    await deliver(gHist(), ANA); // no `e`: the announcement leg
    // The authors cannot consent, because their words were already sent. The
    // one thing they get is knowing it happened, so this row is not optional.
    const rows = messageRows(ROOM).filter(r => String(r.body).includes('grp.hist'));
    expect(rows).toHaveLength(1);
    expect(rows[0].authorId).toBe(ANA);
    expect(
      q(`SELECT lastMessageText FROM chats WHERE peerId = ?`, ROOM)[0].lastMessageText,
    ).toBe('History shared');
  });

  it('an unknown room recreates nothing — straggler history is acked and discarded', async () => {
    await deliver(gHist({ g: pad('9DEAD') }, {}), ANA);
    expect(roomPresent(pad('9DEAD'))).toBe(false);
    expect(
      q(`SELECT msgId FROM messages WHERE peerId = ?`, pad('9DEAD')),
    ).toEqual([]);
  });
});

describe('mentions in the chat list — the receive side resolves names', () => {
  it('an inbound mention previews with THIS phone’s names: @Cara lunch? @you', async () => {
    await acceptRoom();
    // CARA as this phone has filed her: a chat row carrying MY name for her.
    // localName outranks any card she might share — personName's precedence.
    await db.upsertChat(CARA);
    await db.setLocalName(CARA, 'Cara');
    const inner = JSON.stringify({
      tcm: 'mention',
      text: `${MENTION_MARK} lunch? ${MENTION_MARK}`,
      who: [CARA, ME],
    });
    await deliver(gMsg(ROOM, mid('AT1'), inner), ANA);
    // The receive path must reach previewFor WITH a resolver: CARA by the
    // name this phone filed her under, ME as 'you' (the chat list is this
    // phone's own surface). Resolver-less, the marks drop and the words
    // stand alone — which is exactly the defect this test exists to catch.
    expect(
      q(`SELECT lastMessageText FROM chats WHERE peerId = ?`, ROOM)[0]
        .lastMessageText,
    ).toBe('@Cara lunch? @you');
  });

  it('an inbound edit of an OLDER row keeps the newest (mention) preview resolved — refreshPreview carries the resolver too', async () => {
    await acceptRoom();
    await db.upsertChat(CARA);
    await db.setLocalName(CARA, 'Cara');
    await deliver(gMsg(ROOM, mid('AT2'), 'soup tonight?', 1), ANA);
    const inner = JSON.stringify({
      tcm: 'mention',
      text: `${MENTION_MARK} lunch? ${MENTION_MARK}`,
      who: [CARA, ME],
    });
    await deliver(gMsg(ROOM, mid('AT3'), inner, 2), ANA);
    expect(
      q(`SELECT lastMessageText FROM chats WHERE peerId = ?`, ROOM)[0]
        .lastMessageText,
    ).toBe('@Cara lunch? @you');

    // Ana rewrites her EARLIER row, with ZERO action from this phone's
    // person. The latest row — the mention — is untouched, but the revision
    // arm recomputes the chat line from it (refreshPreview), and a
    // resolver-less recompute rewrites "@Cara lunch? @you" to " lunch? ".
    const edit = JSON.stringify({
      tcm: 'edit',
      ref: `${ANA}.${mid('AT2')}`,
      text: 'stew tonight?',
    });
    await deliver(gMsg(ROOM, mid('AT4'), edit, 3), ANA);
    // The edit applied to the older row…
    expect(
      messageRows(ROOM).find(r => r.msgId === `${ANA}.${mid('AT2')}`)?.body,
    ).toBe('stew tonight?');
    // …and the recomputed preview still speaks this phone's names.
    expect(
      q(`SELECT lastMessageText FROM chats WHERE peerId = ?`, ROOM)[0]
        .lastMessageText,
    ).toBe('@Cara lunch? @you');
  });

  it('an inbound retraction of an OLDER row keeps the newest (mention) preview resolved as well', async () => {
    await acceptRoom();
    await db.upsertChat(CARA);
    await db.setLocalName(CARA, 'Cara');
    await deliver(gMsg(ROOM, mid('AT5'), 'soup tonight?', 1), ANA);
    const inner = JSON.stringify({
      tcm: 'mention',
      text: `${MENTION_MARK} lunch? ${MENTION_MARK}`,
      who: [CARA, ME],
    });
    await deliver(gMsg(ROOM, mid('AT6'), inner, 2), ANA);
    const del = JSON.stringify({ tcm: 'del', ref: `${ANA}.${mid('AT5')}` });
    await deliver(gMsg(ROOM, mid('AT7'), del, 3), ANA);
    expect(
      messageRows(ROOM).find(r => r.msgId === `${ANA}.${mid('AT5')}`)
        ?.deletedAt,
    ).not.toBeNull();
    expect(
      q(`SELECT lastMessageText FROM chats WHERE peerId = ?`, ROOM)[0]
        .lastMessageText,
    ).toBe('@Cara lunch? @you');
  });
});

describe('the room unread dot — counted by local arrival, and never by a relay', () => {
  const hist = (entry: Record<string, unknown> = {}): string =>
    JSON.stringify({
      tcm: 'grp.hist',
      g: ROOM,
      n: 7,
      to: ME,
      c: 1,
      e: {
        m: pad('5PAST'),
        a: CARA,
        t: 1_000,
        b: 'said before I arrived',
        ...entry,
      },
    });

  it('a grp.msg raises the count by one; a relayed transcript entry raises nothing; opening clears', async () => {
    await acceptRoom();
    await deliver(gMsg(ROOM, mid('DT1'), 'soup?'), ANA);
    // EXACTLY one: the conversation row, counted by THIS phone's arrival
    // clock. The inbound grp.new announcement row is an event, not a
    // message — its wire-keyed msgId matches `seen`, and a count that fell
    // through to the seen window would call being added to a room "unread".
    let counts = await db.unreadCounts();
    expect(counts[ROOM]).toBe(1);

    await deliver(hist(), ANA);
    // The relay landed as a row (this is what "does not rise" is about) —
    expect(
      q(
        `SELECT msgId FROM messages WHERE peerId = ? AND sharedBy IS NOT NULL`,
        ROOM,
      ),
    ).toHaveLength(1);
    // — but a newcomer handed a transcript must not see it as unread, and a
    // relayed historical mention must not light the @ badge: one account of
    // a past message summons nobody today.
    counts = await db.unreadCounts();
    expect(counts[ROOM]).toBe(1);
    const bodies = await db.unreadRoomBodies();
    expect(bodies[ROOM] ?? []).not.toContain('said before I arrived');

    await db.markChatOpened(ROOM, Date.now());
    counts = await db.unreadCounts();
    expect(counts[ROOM]).toBeUndefined();

    // A fresh message after the open must count again — and count by LOCAL
    // arrival: under the old seen-join a room row is invisible (composite
    // id, no seen match) while the wire-keyed announcement row above holds
    // the count at a stale value. A real tick apart, so arrival is strictly
    // after the open at any clock resolution.
    await new Promise<void>(resolve => setTimeout(resolve, 5));
    await deliver(gMsg(ROOM, mid('DT2'), 'more soup?', 2), ANA);
    counts = await db.unreadCounts();
    expect(counts[ROOM]).toBe(1);
  });

  it('a 1:1 unread survives seen-row eviction — the window is this phone’s arrival clock, seen only as the legacy fallback', async () => {
    await deliver('hello there', BEN);
    let counts = await db.unreadCounts();
    expect(counts[BEN]).toBe(1);
    // markSeen prunes `seen` to the msgId-DESC newest 5000 on EVERY call,
    // and room fan-out wire ids are pure CSPRNG — most sort ABOVE any
    // time-ordered 1:1 ULID, so ordinary room traffic preferentially evicts
    // exactly the 1:1 rows. The eviction, simulated: the message row is
    // untouched and unread, only its seen row is gone.
    q(`DELETE FROM seen`);
    counts = await db.unreadCounts();
    // The dot and the app badge must NOT silently clear: the row carries
    // arrivedAt (this phone's own clock, stamped at the insert), and that —
    // not the prunable seen table — is the 1:1 window.
    expect(counts[BEN]).toBe(1);
  });

  it('an offline-drained room mention badges by ARRIVAL: server-stamped long before the last open, arriving after it', async () => {
    await acceptRoom();
    // Opened long after every server frame stamp this harness mints (9_0xx),
    // but long before this phone's own clock: exactly the offline gap.
    await db.markChatOpened(ROOM, 500_000);
    const inner = JSON.stringify({
      tcm: 'mention',
      text: `${MENTION_MARK} you up?`,
      who: [ME],
    });
    await deliver(gMsg(ROOM, mid('GAP1'), inner), ANA);
    // Sent at T (frame ts ~9_0xx, OUTSIDE the lastOpenedAt window), drained
    // at T+later (arrivedAt = now, INSIDE it). A window on m.ts calls this
    // already-read; the badge feed must window on local arrival.
    const bodies = await db.unreadRoomBodies();
    expect(bodies[ROOM] ?? []).toContain(inner);
    // And the same arrival window holds the room's unread count up.
    expect((await db.unreadCounts())[ROOM]).toBe(1);
  });
});

describe('dispatch order owns the chat line — never a timestamp, whose clock nobody shares', () => {
  // Frames are handled concurrently (ws.onFrame fires void handleIncoming
  // per frame), compose paths run alongside them, and the chat line's two
  // writers used to arbitrate by whoever wrote last — then, briefly, by a
  // timestamp guard that compared the DEVICE clock (compose stamps) against
  // the SERVER clock (frame stamps) on one rail, which froze the line for
  // the whole skew whenever the clocks disagreed. The rule these tests pin:
  // the line belongs to the event DISPATCHED last — the order events entered
  // this process — regardless of either clock and regardless of how long an
  // earlier event's awaits suspend.

  const mentionBody = (): string =>
    JSON.stringify({
      tcm: 'mention',
      text: `${MENTION_MARK} lunch? ${MENTION_MARK}`,
      who: [CARA, ME],
    });

  /** Park the next db.getChat(CARA) on a barrier; returns release + spy. */
  function gateCaraLookup(): { release: () => void; spy: jest.SpyInstance } {
    let release!: () => void;
    const barrier = new Promise<void>(resolve => {
      release = resolve;
    });
    const realGetChat = db.getChat;
    let gated = true;
    const spy = jest.spyOn(db, 'getChat').mockImplementation(async id => {
      if (gated && id === CARA) {
        gated = false;
        await barrier;
      }
      return realGetChat(id);
    });
    return { release, spy };
  }

  const frame = (msgId: string, ts: number): void => {
    ws.handlers.frame?.({
      type: 'msg',
      from: BEN,
      msgId,
      msgType: 'ciphertext',
      payload: 'AAAA',
      ts,
    });
  };

  it('a mention frame suspended mid-preview loses to the frame dispatched after it — even when the LATER dispatch carries the OLDER server stamp', async () => {
    await db.upsertChat(CARA);
    await db.setLocalName(CARA, 'Cara');
    const { release, spy } = gateCaraLookup();
    try {
      // Frame A: the mention, dispatched FIRST, suspended in its per-id
      // name lookup. Server stamp deliberately NEWER than B's — under a
      // timestamp guard A would win, which is exactly wrong: B entered the
      // system after A.
      crypto.decryptEnvelope.mockResolvedValueOnce(mentionBody());
      frame(pad('01WRACEA'), 9_600);
      await flush();
      // Frame B: plain words, dispatched SECOND, server stamp OLDER.
      crypto.decryptEnvelope.mockResolvedValueOnce('soup tonight');
      frame(pad('01WRACEB'), 9_500);
      await flush();
      release();
      await flush();
    } finally {
      spy.mockRestore();
    }
    const after = q(
      `SELECT lastMessageText, lastMessageAt FROM chats WHERE peerId = ?`,
      BEN,
    )[0];
    expect(after.lastMessageText).toBe('soup tonight');
    expect(after.lastMessageAt).toBe(9_500);
    // Both message rows landed — the arbitration is about the chat LINE only.
    expect(q(`SELECT msgId FROM messages WHERE peerId = ?`, BEN)).toHaveLength(2);
  });

  it('a frame suspended in DECRYPT — before it can even queue its write — still loses to the frame dispatched after it', async () => {
    await db.upsertChat(CARA);
    await db.setLocalName(CARA, 'Cara');
    // Frame A suspends before its chat identity is even known, so no
    // per-chat queue can order it; only a token claimed at DISPATCH can.
    let releaseDecrypt!: () => void;
    const decryptBarrier = new Promise<void>(resolve => {
      releaseDecrypt = resolve;
    });
    crypto.decryptEnvelope.mockImplementationOnce(async () => {
      await decryptBarrier;
      return mentionBody();
    });
    frame(pad('01WRACEC'), 9_600);
    await flush();
    crypto.decryptEnvelope.mockResolvedValueOnce('soup tonight');
    frame(pad('01WRACED'), 9_500);
    await flush();
    releaseDecrypt();
    await flush();
    const after = q(
      `SELECT lastMessageText, lastMessageAt FROM chats WHERE peerId = ?`,
      BEN,
    )[0];
    expect(after.lastMessageText).toBe('soup tonight');
    expect(after.lastMessageAt).toBe(9_500);
    expect(q(`SELECT msgId FROM messages WHERE peerId = ?`, BEN)).toHaveLength(2);
  });

  it('a device clock running AHEAD cannot freeze the line: my send, then an inbound frame — the inbound message takes the line', async () => {
    // The two clock domains as this harness already embodies them: compose
    // stamps Date.now() (real, ~1.7e12 — the device), frames carry the
    // server's 9_0xx. The device is "ahead" by twelve orders of magnitude;
    // PROFILE_FUTURE_TOLERANCE_MS admits 24h of real skew into the threat
    // model, and one send under a guard that compared the two froze the
    // chat line against EVERY inbound update for the whole skew.
    crypto.encryptText.mockResolvedValue({
      msgType: 'ciphertext',
      payload: 'QUFB',
    });
    await messaging.sendText(BEN, 'my words');
    await flush();
    expect(
      q(`SELECT lastMessageText FROM chats WHERE peerId = ?`, BEN)[0]
        .lastMessageText,
    ).toBe('my words');
    const wireId = await deliver('their words', BEN);
    const row = q(
      `SELECT ts FROM messages WHERE msgId = ? AND direction = 'in'`,
      wireId,
    )[0];
    const after = q(
      `SELECT lastMessageText, lastMessageAt FROM chats WHERE peerId = ?`,
      BEN,
    )[0];
    expect(after.lastMessageText).toBe('their words');
    expect(after.lastMessageAt).toBe(row.ts);
  });

  it('a device clock running BEHIND cannot drop a fire-once membership announce from the list row', async () => {
    // Two seats only: the suite-wide randomBytes mock returns the same bytes
    // on every call, so a multi-leg fan-out would mint colliding wire ids
    // and fail on the outbox key instead of the defect under test.
    await acceptRoom(ROOM, [ANA, ME]);
    await deliver(gMsg(ROOM, mid('DT3'), 'soup?'), ANA);
    // The device clock, shifted BEHIND the server stamps this harness mints
    // (frame ts 9_0xx; the shifted clock reads ~8_0xx) but still MOVING, so
    // pacing refills keep working. The announce is fire-once — nothing ever
    // re-touches the line for it — so a guard that refused it lost it for
    // good.
    const realNow = Date.now.bind(Date);
    const t0 = realNow();
    const spy = jest
      .spyOn(Date, 'now')
      .mockImplementation(() => 8_000 + (realNow() - t0));
    try {
      crypto.encryptText.mockResolvedValue({
        msgType: 'ciphertext',
        payload: 'QUFB',
      });
      const seq = await db.reserveGroupSeq(ROOM, 'writer');
      await messaging.fanOutMembership(
        ROOM,
        { tcm: 'grp.set', g: ROOM, s: 60, n: seq },
        { apply: async () => true },
      );
      await flush();
    } finally {
      spy.mockRestore();
    }
    expect(
      q(`SELECT lastMessageText FROM chats WHERE peerId = ?`, ROOM)[0]
        .lastMessageText,
    ).toBe('Disappearing messages on');
  });

  it('a store-busy retry holds the sender\'s later frames behind it, and the newer frame still owns the line', async () => {
    // M1 (older server stamp) hits the NSE's transient store lock; the
    // bounded local retry waits 1.5 s IN PLACE. M2 (newer stamp) from the
    // SAME sender arrives inside that window and WAITS behind it (this test
    // used to pin M2 overtaking M1, which is exactly how a ciphertext
    // following a busy-delayed prekey message got classified as tamper and
    // acked away). Once the retry lands, M2 lands after it, and the line
    // belongs to M2: both stamps are SERVER ts — one clock domain — and the
    // retry is M1's handling continued under the dispatch token it entered
    // with, so it cannot outrank M2 even though it now writes first.
    const cryptoMock = crypto as unknown as { isStoreBusyError: jest.Mock };
    const instance = sqlite.__sqlite.instances.get('tacendum.sqlite')!;
    const base = instance.execute.getMockImplementation()!;
    let armed = true;
    cryptoMock.isStoreBusyError.mockImplementation(
      (e: unknown) => (e as Error).message === 'db locked (test)',
    );
    instance.execute.mockImplementation(
      async (sql: unknown, params?: unknown[]) => {
        if (
          armed &&
          String(sql).includes('INSERT OR IGNORE INTO messages') &&
          (params ?? []).includes('first words')
        ) {
          armed = false;
          throw new Error('db locked (test)');
        }
        return base(sql, params);
      },
    );
    try {
      crypto.decryptEnvelope.mockResolvedValueOnce('first words');
      frame(pad('01WBZYA'), 9_100);
      await flush(); // M1 hit the lock; retry armed; nothing written, no ack
      expect(q(`SELECT msgId FROM messages WHERE peerId = ?`, BEN)).toHaveLength(0);

      frame(pad('01WBZYB'), 9_200);
      await flush();
      // M2 is queued behind M1's wait: nothing decrypted, nothing written.
      expect(crypto.decryptEnvelope).toHaveBeenCalledTimes(1);
      expect(q(`SELECT msgId FROM messages WHERE peerId = ?`, BEN)).toHaveLength(0);

      // The decrypts, in the order they now run: M1's retry re-decrypts (the
      // ws path carried no plaintext), then M2.
      crypto.decryptEnvelope.mockResolvedValueOnce('first words');
      crypto.decryptEnvelope.mockResolvedValueOnce('second words');
      await new Promise<void>(resolve => setTimeout(resolve, 1_600));
      await flush();
    } finally {
      instance.execute.mockImplementation(base);
      cryptoMock.isStoreBusyError.mockReset();
      cryptoMock.isStoreBusyError.mockReturnValue(false);
    }
    // The retried M1 landed as a ROW and was acked — nothing is lost —
    expect(
      q(`SELECT body FROM messages WHERE peerId = ? ORDER BY ts`, BEN).map(
        r => r.body,
      ),
    ).toEqual(['first words', 'second words']);
    expect(acksFor(pad('01WBZYA'))).toHaveLength(1);
    // — and the LINE belongs to M2, which entered the system after M1 and
    // wrote after the retry.
    const after = q(
      `SELECT lastMessageText, lastMessageAt FROM chats WHERE peerId = ?`,
      BEN,
    )[0];
    expect(after.lastMessageText).toBe('second words');
    expect(after.lastMessageAt).toBe(9_200);
  });

  it('a duplicate queued behind a copy that died unacked runs after it in arrival order, and the newer frame keeps the line', async () => {
    // The first copy of W_D dies in the PRE-TRY section (a db read
    // rejecting before the main handling begins) — unacked, nothing
    // written. Its duplicate and a newer frame from the SAME sender arrive
    // while the first is in flight: a sender's frames run in
    // arrival order, so both WAIT behind the dying copy instead of
    // overtaking it (this test used to pin the overtaking). When the chain
    // moves on, the duplicate lands as W_D's first real handling, then the
    // newer frame — and the line belongs to the newer frame, which entered
    // the system later and wrote later.
    let release!: () => void;
    const barrier = new Promise<void>(resolve => {
      release = resolve;
    });
    const realHasSeen = db.hasSeen;
    const wD = pad('01WPARKA');
    let gatedOnce = true;
    const spy = jest.spyOn(db, 'hasSeen').mockImplementation(async id => {
      if (gatedOnce && id === wD) {
        gatedOnce = false;
        await barrier;
        throw new Error('db read failed (test)');
      }
      return realHasSeen(id);
    });
    try {
      // First copy: suspends at the gated hasSeen, then dies unacked.
      frame(wD, 9_100);
      await flush();
      // Its duplicate arrives while the first is in flight: queued behind it.
      frame(wD, 9_100);
      await flush();
      // A newer frame from the same sender: queued behind both.
      frame(pad('01WPARKB'), 9_200);
      await flush();
      // Arrival order, one sender: nothing behind the blocked copy has run.
      expect(crypto.decryptEnvelope).not.toHaveBeenCalled();
      expect(q(`SELECT msgId FROM messages WHERE peerId = ?`, BEN)).toHaveLength(0);
      // The decrypts, in the order they now run: the duplicate (W_D's first
      // real decrypt — the dead copy never got past hasSeen), then W_B.
      crypto.decryptEnvelope.mockResolvedValueOnce('first words');
      crypto.decryptEnvelope.mockResolvedValueOnce('second words');
      release();
      await flush();
    } finally {
      spy.mockRestore();
    }
    // The resumed copy landed as a row and was acked — nothing lost —
    expect(
      q(`SELECT body FROM messages WHERE peerId = ? ORDER BY ts`, BEN).map(
        r => r.body,
      ),
    ).toEqual(['first words', 'second words']);
    expect(acksFor(wD)).toHaveLength(1);
    // — and the LINE is the frame that entered the system later.
    const after = q(
      `SELECT lastMessageText, lastMessageAt FROM chats WHERE peerId = ?`,
      BEN,
    )[0];
    expect(after.lastMessageText).toBe('second words');
    expect(after.lastMessageAt).toBe(9_200);
  });

  it('a stale revision recompute cannot land after a newer content frame — the read-then-write is atomic against the other writer', async () => {
    await db.upsertChat(CARA);
    await db.setLocalName(CARA, 'Cara');
    const oldWire = await deliver('old words', BEN);
    await deliver(mentionBody(), BEN);
    expect(
      q(`SELECT lastMessageText FROM chats WHERE peerId = ?`, BEN)[0]
        .lastMessageText,
    ).toBe('@Cara lunch? @you');

    // The revision frame edits the OLDER row; its refreshPreview reads the
    // rows, then suspends resolving the (untouched, still-latest) mention's
    // names. While it hangs, a NEW content frame lands to completion. The
    // suspended recompute's write must not clobber the newer frame's line —
    // "old words at the new message's sort position".
    const { release, spy } = gateCaraLookup();
    try {
      crypto.decryptEnvelope.mockResolvedValueOnce(
        JSON.stringify({ tcm: 'edit', ref: oldWire, text: 'old words v2' }),
      );
      frame(pad('01WREVA'), 9_700);
      await flush();
      crypto.decryptEnvelope.mockResolvedValueOnce('new words');
      frame(pad('01WREVB'), 9_800);
      await flush();
      release();
      await flush();
    } finally {
      spy.mockRestore();
    }
    // Non-vacuity: the edit really applied to the older row.
    expect(
      q(
        `SELECT body FROM messages WHERE msgId = ? AND direction = 'in'`,
        oldWire,
      )[0].body,
    ).toBe('old words v2');
    const after = q(
      `SELECT lastMessageText, lastMessageAt FROM chats WHERE peerId = ?`,
      BEN,
    )[0];
    expect(after.lastMessageText).toBe('new words');
    expect(after.lastMessageAt).toBe(9_800);
  });
});
