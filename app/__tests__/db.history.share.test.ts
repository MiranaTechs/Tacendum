/**
 * HISTORY SHARING, the store half ("Rooms can share
 * history with a new member"; grp.hist contract the design).
 *
 * Two things are proved here, both on Node's REAL SQLite engine bound under
 * the recorded op-sqlite mock (the db.blocking.legs.test.ts harness), because
 * both are SQL behaviour the recording mock cannot see:
 *
 *  - the `sharedBy` column arrives ADDITIVELY — by ALTER on a file that
 *    predates it, touching no existing byte — exactly like the six additive
 *    message columns before it;
 *  - `selectHistoryForShare` refuses each of the four categories the decision
 *    names: expired (the timer binds), retracted (a relay undoes nothing),
 *    relayed (only what this phone WITNESSED may travel onward — without
 *    this, provenance launders and a second-hand claim becomes first-hand at
 *    the next hop), and author-less (a 1:1 row is not room history).
 *
 * Every exclusion test asserts its own PRECONDITION before the rule: the row
 * it excludes is shown to be in the thread and disqualified by exactly one
 * clause, so deleting that clause from db.ts flips the test red instead of
 * proving an empty set twice.
 */
import * as db from '../src/db';

// --- the real engine, bound under the recorded mock -------------------------

type Row = Record<string, unknown>;
interface Engine {
  prepare(sql: string): { all(...args: unknown[]): Row[] };
  exec(sql: string): void;
  close(): void;
}
// eslint-disable-next-line @typescript-eslint/no-var-requires
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
let instance: FakeDb;

function bindRealEngine(): void {
  engine = new DatabaseSync(':memory:');
  instance = sqlite.open({ name: 'tacendum.sqlite' });
  instance.execute.mockImplementation(
    async (sql: unknown, params?: unknown[]) => {
      const s = String(sql);
      const args = (params ?? []).map(p => (p === undefined ? null : p));
      const rows = engine.prepare(s).all(...args);
      const changes = engine.prepare('SELECT changes() AS c').all()[0]!
        .c as number;
      return { rows, rowsAffected: changes };
    },
  );
}

const q = (sql: string, ...args: unknown[]): Row[] =>
  engine.prepare(sql).all(...args);

/** Statements the store issued from this point on. */
function since(): () => string[] {
  const mark = instance.execute.mock.calls.length;
  return () =>
    instance.execute.mock.calls.slice(mark).map(c => String(c[0]));
}

// --- ids and seeds ----------------------------------------------------------

const pad = (seed: string): string => (seed + '0'.repeat(26)).slice(0, 26);
const ME = pad('ME'); // this phone — the sharer-to-be
const CARA = pad('CARA'); // a member whose messages this phone witnessed
const PREV = pad('PREV'); // the PREVIOUS owner, who relayed history to me
const OLDAUTH = pad('OLDAUTH'); // the author PREV's relay claims wrote it
const FRIEND = pad('FRIEND'); // a 1:1 correspondent, never in any room
const ROOM = pad('7R00M');
const AT = 1_700_000_000_000;

/** One room row through the REAL insertMessage, first-hand unless overridden. */
async function seedRoomMsg(
  over: Partial<db.MessageRow> & { msgId: string },
): Promise<void> {
  await db.insertMessage({
    peerId: ROOM,
    direction: 'in',
    body: 'kelno vash',
    ts: AT,
    status: 'received',
    authorId: CARA,
    ...over,
  } as db.MessageRow);
}

const shareIds = async (limit = 50, now = AT): Promise<string[]> =>
  (await db.selectHistoryForShare(ROOM, limit, now)).map(m => m.msgId);

beforeEach(async () => {
  await db.close();
  sqlite.__sqlite.reset();
  db.setWorkspace('real');
  bindRealEngine();
});

afterEach(async () => {
  await db.close();
  engine.close();
});

// ---------------------------------------------------------------------------

describe('the harness itself', () => {
  test('the real engine executes the real schema, sharedBy included', async () => {
    await db.initDb();
    const cols = q(`PRAGMA table_info(messages)`).map(r => r.name);
    expect(cols).toContain('sharedBy');
  });
});

describe('the migration (additive, like the six columns before it)', () => {
  test('a pre-history file gains sharedBy by ONE ALTER, and its rows survive untouched', async () => {
    // The messages table exactly as the build before history sharing left it:
    // every earlier additive column present, sharedBy absent, one real row.
    engine.exec(`CREATE TABLE messages (
      msgId TEXT NOT NULL, peerId TEXT NOT NULL,
      direction TEXT NOT NULL CHECK (direction IN ('in','out')),
      body TEXT NOT NULL, ts INTEGER NOT NULL, status TEXT NOT NULL,
      expiresAt INTEGER, editedAt INTEGER, deletedAt INTEGER,
      readAt INTEGER, readSent INTEGER NOT NULL DEFAULT 0,
      authorId TEXT, sq INTEGER, outsider INTEGER,
      PRIMARY KEY (msgId, direction))`);
    engine.exec(
      `INSERT INTO messages (msgId, peerId, direction, body, ts, status, authorId)
       VALUES ('${CARA}.01M', '${ROOM}', 'in', 'kelno vash', ${AT}, 'received', '${CARA}')`,
    );

    const issued = since();
    await db.initDb();

    // Each missing column arrived by exactly ONE ALTER, and never a rebuild.
    // The list grows as columns are added — that is the migration working, not
    // a failure — but it must stay one ALTER per column, in order, with no
    // DROP anywhere near it.
    const cols = q(`PRAGMA table_info(messages)`).map(r => r.name);
    expect(cols).toContain('sharedBy');
    expect(cols).toContain('arrivedAt');
    const alters = issued().filter(s => s.includes('ALTER TABLE messages'));
    expect(alters).toEqual([
      'ALTER TABLE messages ADD COLUMN sharedBy TEXT',
      'ALTER TABLE messages ADD COLUMN arrivedAt INTEGER',
      // The Art. 50 marker column — the list growing by one ALTER
      // is this pin's own comment working as written.
      'ALTER TABLE messages ADD COLUMN ai INTEGER',
    ]);
    expect(issued().some(s => /DROP TABLE messages/.test(s))).toBe(false);

    // The pre-migration row kept every byte, and its provenance reads
    // first-hand: NULL is "witnessed myself", which every old row was.
    expect(q(`SELECT * FROM messages`)).toEqual([
      expect.objectContaining({
        msgId: `${CARA}.01M`,
        peerId: ROOM,
        body: 'kelno vash',
        ts: AT,
        status: 'received',
        authorId: CARA,
        sharedBy: null,
      }),
    ]);
  });

  test('a second boot issues no messages ALTER at all', async () => {
    await db.initDb();
    await db.close();
    const issued = since();
    await db.initDb();
    expect(issued().filter(s => s.includes('ALTER TABLE messages'))).toEqual(
      [],
    );
  });
});

describe('insertMessage carries provenance', () => {
  test('persists sharedBy when set, NULL when the row is first-hand', async () => {
    await db.initDb();
    await seedRoomMsg({ msgId: `${OLDAUTH}.01A`, authorId: OLDAUTH, sharedBy: PREV });
    await seedRoomMsg({ msgId: `${CARA}.01B` });
    const rows = q(
      `SELECT msgId, sharedBy FROM messages ORDER BY msgId`,
    );
    expect(rows).toEqual([
      { msgId: `${CARA}.01B`, sharedBy: null },
      { msgId: `${OLDAUTH}.01A`, sharedBy: PREV },
    ]);
  });

  test('a first-hand copy I already hold always wins: the relayed duplicate is ignored', async () => {
    await db.initDb();
    // I witnessed CARA's message myself…
    await seedRoomMsg({ msgId: `${CARA}.01M`, body: 'what I saw' });
    // …and a later relay carries the same room key with different words.
    await seedRoomMsg({
      msgId: `${CARA}.01M`,
      body: 'what the relayer says I saw',
      sharedBy: PREV,
    });
    expect(q(`SELECT body, sharedBy FROM messages`)).toEqual([
      { body: 'what I saw', sharedBy: null },
    ]);
  });
});

describe('selectHistoryForShare — the four exclusions', () => {
  test('1. the timer binds: an expired row is never shared, and the boundary is sweepExpired’s own', async () => {
    await db.initDb();
    await seedRoomMsg({ msgId: `${CARA}.01LIVE`, ts: AT - 400 });
    await seedRoomMsg({
      msgId: `${CARA}.02LATER`,
      ts: AT - 300,
      expiresAt: AT + 60_000,
    });
    // Both doomed rows are NEWER than the live ones, so if the clause goes,
    // they surface at the top — the mutation cannot hide in the ordering.
    await seedRoomMsg({ msgId: `${CARA}.03GONE`, ts: AT - 200, expiresAt: AT - 1 });
    // expiresAt == now belongs to sweepExpired (`expiresAt <= ?`): a share
    // racing the sweep must not resurrect what the sweep is deleting.
    await seedRoomMsg({ msgId: `${CARA}.04EDGE`, ts: AT - 100, expiresAt: AT });

    expect(await shareIds()).toEqual([`${CARA}.02LATER`, `${CARA}.01LIVE`]);
  });

  test('2. a retraction is not undone by a relay: the tombstoned row stays out', async () => {
    await db.initDb();
    await seedRoomMsg({ msgId: `${CARA}.01KEPT`, ts: AT - 200 });
    await seedRoomMsg({ msgId: `${CARA}.02TAKEN`, ts: AT - 100, body: 'regretted' });
    // The REAL retraction path: body emptied, deletedAt stamped, row kept.
    expect(
      await db.tombstoneMessage(ROOM, `${CARA}.02TAKEN`, 'in', AT - 50),
    ).toBe(true);
    // Precondition, or the fixture cannot fail: the tombstone is still a row
    // in the thread — newest, authored, unexpired — excluded by deletedAt
    // alone.
    expect(
      q(`SELECT deletedAt FROM messages WHERE msgId = ?`, `${CARA}.02TAKEN`),
    ).toEqual([{ deletedAt: AT - 50 }]);

    expect(await shareIds()).toEqual([`${CARA}.01KEPT`]);
  });

  test('3. provenance does not launder: a row relayed to me is not mine to relay onward', async () => {
    await db.initDb();
    // The scene this clause exists for: PREV owned the room and shared its
    // history with me when I joined — an ACCOUNT, authenticated as PREV and
    // nobody else. The room later became mine to hand to a newcomer. What I
    // witnessed may travel; PREV's account may not, or it would arrive at
    // the next hop as MY first-hand history and the claim would harden with
    // every handover.
    await seedRoomMsg({ msgId: `${ME}.01MINE`, direction: 'out', authorId: ME, ts: AT - 200 });
    await seedRoomMsg({ msgId: `${CARA}.01SEEN`, ts: AT - 100 });
    await seedRoomMsg({
      msgId: `${OLDAUTH}.01TOLD`,
      authorId: OLDAUTH,
      sharedBy: PREV,
      ts: AT - 50,
    });
    // Precondition, or the fixture cannot fail: the relayed row IS in the
    // thread — newest, authored, standing, unexpired — so the ONLY clause
    // between it and the share is `sharedBy IS NULL`.
    expect(
      q(
        `SELECT authorId, sharedBy, deletedAt, expiresAt FROM messages
         WHERE msgId = ?`,
        `${OLDAUTH}.01TOLD`,
      ),
    ).toEqual([
      { authorId: OLDAUTH, sharedBy: PREV, deletedAt: null, expiresAt: null },
    ]);

    expect(await shareIds()).toEqual([`${CARA}.01SEEN`, `${ME}.01MINE`]);
  });

  test('4. a row that cannot name its author is not history: author-less and 1:1 rows stay out', async () => {
    await db.initDb();
    await seedRoomMsg({ msgId: `${CARA}.01REAL`, ts: AT - 200 });
    // A room-thread row with no author — whatever wrote it, the wire's `e.a`
    // is a claim about WHO, and a row that cannot make the claim cannot be
    // relayed as anyone's words. Newest, so a dropped clause surfaces it.
    await seedRoomMsg({ msgId: pad('01NOAUTH'), authorId: null, ts: AT - 100 });
    // And a 1:1 row in its own thread: kept out by the room scope itself.
    await db.insertMessage({
      msgId: pad('01FRIENDMSG'),
      peerId: FRIEND,
      direction: 'in',
      body: 'between the two of us',
      ts: AT - 50,
      status: 'received',
    });

    expect(await shareIds()).toEqual([`${CARA}.01REAL`]);
  });

  test('newest first, LIMIT honoured — the extent is the LAST n messages, not the first', async () => {
    await db.initDb();
    for (let i = 1; i <= 5; i++) {
      await seedRoomMsg({ msgId: `${CARA}.0${i}M`, ts: AT - 1000 + i });
    }
    expect(await shareIds(3)).toEqual([
      `${CARA}.05M`,
      `${CARA}.04M`,
      `${CARA}.03M`,
    ]);
  });

  test('5. the room’s OWN announcements are not history — but content envelopes are', async () => {
    // Found by a screen test, not by reasoning: shareHistory threw
    // "cannot send that grp.hist (e.b)" because the room's roster and
    // creation rows were being offered as shareable words. They are things
    // that happened TO the room, and replaying them would announce old
    // events as new — the composer refusing them is the no-nesting rule
    // doing its job, but the query should never have handed them over.
    await db.initDb();
    await seedRoomMsg({
      msgId: `${CARA}.01ANNOUNCE`,
      ts: AT - 400,
      body: JSON.stringify({ tcm: 'grp.roster', g: ROOM, m: CARA, s: 'in', n: 2 }),
    });
    await seedRoomMsg({
      msgId: `${CARA}.02NEW`,
      ts: AT - 350,
      body: JSON.stringify({ tcm: 'grp.new', g: ROOM, nm: 'Kitchen', ms: [CARA], n: 1 }),
    });
    // An image IS conversation and must still travel: the exclusion keys on
    // the `grp.` prefix, not on "is an envelope".
    await seedRoomMsg({
      msgId: `${CARA}.03IMAGE`,
      ts: AT - 300,
      body: JSON.stringify({ tcm: 'image', id: 'blob', k: 'key', n: 'a.jpg' }),
    });
    await seedRoomMsg({ msgId: `${CARA}.04WORDS`, ts: AT - 200 });

    expect(await shareIds()).toEqual([`${CARA}.04WORDS`, `${CARA}.03IMAGE`]);
  });

  test('the whole world at once: one row of each kind, and only the plain room message travels', async () => {
    await db.initDb();
    await seedRoomMsg({ msgId: `${OLDAUTH}.01TOLD`, authorId: OLDAUTH, sharedBy: PREV, ts: AT - 500 });
    await seedRoomMsg({ msgId: `${CARA}.02GONE`, ts: AT - 400, expiresAt: AT - 1 });
    await seedRoomMsg({ msgId: `${CARA}.03TAKEN`, ts: AT - 300, body: 'regretted' });
    // Retract through the REAL path, exactly as test 2 does. Passing
    // `deletedAt` to the seed helper looks like it works and does nothing:
    // `insertMessage` has no deletedAt column, so the field is dropped in
    // silence and the row arrives un-retracted. A fixture that quietly fails
    // to build the condition it names is the failure mode this suite exists
    // to catch, so it must not be one.
    expect(
      await db.tombstoneMessage(ROOM, `${CARA}.03TAKEN`, 'in', AT - 10),
    ).toBe(true);
    await db.insertMessage({
      msgId: pad('01FRIENDMSG'),
      peerId: FRIEND,
      direction: 'in',
      body: 'between the two of us',
      ts: AT - 200,
      status: 'received',
    });
    await seedRoomMsg({
      msgId: `${CARA}.05PLAIN`,
      ts: AT - 100,
      expiresAt: AT + 60_000,
    });

    // The one survivor comes back WHOLE: the relayer needs every field the
    // wire's `e` carries — the room key, the author claim, the words, the
    // original ts and the original expiry.
    expect(await db.selectHistoryForShare(ROOM, 50, AT)).toEqual([
      {
        msgId: `${CARA}.05PLAIN`,
        authorId: CARA,
        body: 'kelno vash',
        ts: AT - 100,
        expiresAt: AT + 60_000,
      },
    ]);
  });
});
