/**
 * The member-consent DB helpers — proved on
 * Node's REAL SQLite engine bound under the recorded op-sqlite mock (the
 * db.history.share.test.ts harness), because both are SQL behaviour the
 * recording mock cannot see:
 *
 *  - `countConsentedAgents` counts ONLY 'consented' rows — the cap surface
 *    reads this and nothing else, so a 'refused' row (which consumes no
 *    server edge) must never inflate the count;
 *  - `listRoomAgentAuthorIds` returns the DISTINCT authenticated authors of
 *    ai-marked messages IN ONE ROOM — the marker half of the badge signal
 *    lifted to the roster (a NON-owner's agent detection). It filters on
 *    `ai = 1` AND `authorId IS NOT NULL` AND the room, so an unmarked message,
 *    an author-less (1:1) row, or a marked message in ANOTHER room never leaks
 *    a member into a room's agent set (a room-scoped read that never asks the server).
 *
 * Every exclusion test asserts its own precondition — the row it excludes is
 * shown present and disqualified by exactly one clause — so deleting that
 * clause flips the test red instead of proving an empty set twice.
 */
import * as db from '../src/db';

type Row = Record<string, unknown>;
interface Engine {
  prepare(sql: string): { all(...args: unknown[]): Row[] };
  exec(sql: string): void;
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

let engine: Engine;

function bindRealEngine(): void {
  engine = new DatabaseSync(':memory:');
  const instance = sqlite.open({ name: 'tacendum.sqlite' });
  instance.execute.mockImplementation(async (sql: unknown, params?: unknown[]) => {
    const args = (params ?? []).map(p => (p === undefined ? null : p));
    const rows = engine.prepare(String(sql)).all(...args);
    const changes = engine.prepare('SELECT changes() AS c').all()[0]!.c as number;
    return { rows, rowsAffected: changes };
  });
}

const pad = (seed: string): string => (seed + '0'.repeat(26)).slice(0, 26);
const ROOM = pad('7R00M');
const ROOM2 = pad('7R00M2');
const CLAUDE = pad('AGENT');
const CODEX = pad('AGENT2');
const HUMAN = pad('HUMAN');
const AT = 1_700_000_000_000;

async function seedMsg(over: Partial<db.MessageRow> & { msgId: string }): Promise<void> {
  await db.insertMessage({
    peerId: ROOM,
    direction: 'in',
    body: 'hello',
    ts: AT,
    status: 'received',
    ...over,
  } as db.MessageRow);
}

beforeEach(async () => {
  await db.close();
  sqlite.__sqlite.reset();
  db.setWorkspace('real');
  bindRealEngine();
  await db.initDb();
});

afterEach(async () => {
  await db.close();
  engine.close();
});

describe('countAgentConsents — the cap surface reads local consents only', () => {
  test('counts consented rows, and a refused row never inflates the count', async () => {
    expect(await db.countConsentedAgents()).toBe(0);
    await db.setAgentConsent(CLAUDE, 'consented', AT);
    await db.setAgentConsent(CODEX, 'consented', AT);
    // Precondition: the refused row EXISTS (so the count below excludes it by
    // its state clause, not by its absence).
    await db.setAgentConsent(HUMAN, 'refused', AT);
    expect(await db.getAgentConsent(HUMAN)).toBe('refused');
    expect(await db.countConsentedAgents()).toBe(2);
    // Revising consented → refused frees the count (the upsert is the consent model).
    await db.setAgentConsent(CODEX, 'refused', AT + 1);
    expect(await db.countConsentedAgents()).toBe(1);
  });
});

describe('listRoomAgentAuthorIds — the marker half of the badge, room-scoped', () => {
  test('returns the DISTINCT authors of ai-marked messages in this room', async () => {
    await seedMsg({ msgId: 'a1', authorId: CLAUDE, ai: 1 });
    await seedMsg({ msgId: 'a2', authorId: CLAUDE, ai: 1 }); // same author, once
    await seedMsg({ msgId: 'b1', authorId: CODEX, ai: 1 });
    const ids = await db.listRoomAgentAuthorIds(ROOM);
    expect(ids.sort()).toEqual([CLAUDE, CODEX].sort());
  });

  test('an UNMARKED message never marks its author an agent (precondition present)', async () => {
    // The row exists and is from HUMAN — excluded by ai != 1 alone.
    await seedMsg({ msgId: 'h1', authorId: HUMAN, ai: 0 });
    await seedMsg({ msgId: 'h2', authorId: HUMAN }); // ai null
    expect(await db.listRoomAgentAuthorIds(ROOM)).toEqual([]);
  });

  test('an author-less (1:1-shaped) marked row is excluded by authorId IS NOT NULL', async () => {
    await seedMsg({ msgId: 'n1', authorId: null, ai: 1 });
    expect(await db.listRoomAgentAuthorIds(ROOM)).toEqual([]);
  });

  test('a marked message in ANOTHER room never leaks into this room’s agent set', async () => {
    await seedMsg({ msgId: 'x1', peerId: ROOM2, authorId: CLAUDE, ai: 1 });
    // Precondition: the OTHER room does see it.
    expect(await db.listRoomAgentAuthorIds(ROOM2)).toEqual([CLAUDE]);
    // This room does not.
    expect(await db.listRoomAgentAuthorIds(ROOM)).toEqual([]);
  });

  test('a RELAYED marked row never enters the agent set — first-hand rows only', async () => {
    // A grp.hist relay stores `authorId` as the RELAYER'S CLAIM about a third
    // party (`sharedBy` marks the row second-hand, unauthenticated). The
    // marker half of the agent set feeds delivery (roomContentAudience), the
    // grp.consent subject gate and the consent choice-set, so it must read
    // first-hand rows only — otherwise a room owner could mark a HUMAN as an
    // agent on a newcomer's phone by fabricating one history entry.
    // Precondition: the relayed row exists, is marked, and names its claimed
    // author — excluded by `sharedBy IS NULL` alone.
    await seedMsg({ msgId: 'r1', authorId: HUMAN, ai: 1, sharedBy: pad('0WNER') });
    expect(await db.listRoomAgentAuthorIds(ROOM)).toEqual([]);
    // A first-hand marked row in the same room still counts (the belt's
    // DISPLAY back-fill on relayed rows is untouched: `messages.ai` stays 1
    // on the relayed row for the bubble badge; it just stops feeding the set).
    await seedMsg({ msgId: 'f1', authorId: CLAUDE, ai: 1 });
    expect(await db.listRoomAgentAuthorIds(ROOM)).toEqual([CLAUDE]);
  });
});
