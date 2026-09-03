/**
 * Deleting a message moves the chat's line.
 *
 * `deleteMessage` removed the row and everything hanging off it but never
 * touched `chats`, and both of its callers refresh only the thread — so the
 * list row kept previewing the deleted words, sorted under the deleted
 * message's timestamp. The preview is now recomputed INSIDE the same
 * transaction, by the rule messaging.refreshPreview already applies: the
 * newest row that is either retracted or not a carrier wins; a retracted
 * one reads DELETED_PREVIEW; nothing left clears BOTH columns — the
 * `previewNone` state the list renders as "No messages yet", never a blank
 * under a live timestamp.
 *
 * On Node's real SQLite engine bound under the recorded op-sqlite mock (the
 * db.history.share.test.ts harness), because "what does the chats row say
 * now" is SQL behaviour the recording mock cannot see. */
import * as db from '../src/db';
import { DELETED_PREVIEW } from '../src/envelope';

// --- the real engine, bound under the recorded mock -------------------------

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

// --- ids and seeds ----------------------------------------------------------

const pad = (seed: string): string => (seed + '0'.repeat(26)).slice(0, 26);
const PEER = pad('PEER');
/** Real Crockford ULIDs — a mention's `who` is validated by the schema. */
const ME = '01HQMEME00000000000000000M';
const CARA = '01HQCAAA00000000000000000C';
const FIRST = pad('A1');
const SECOND = pad('B2');
const CARRIER = pad('C3');

/** One inbound 1:1 row through the REAL insertMessage. */
async function seed(msgId: string, body: string, ts: number): Promise<void> {
  await db.insertMessage({
    msgId,
    peerId: PEER,
    direction: 'in',
    body,
    ts,
    status: 'received',
  } as db.MessageRow);
}

async function line(): Promise<{ at: number | null; text: string | null }> {
  const chat = await db.getChat(PEER);
  expect(chat).not.toBeNull();
  return { at: chat!.lastMessageAt, text: chat!.lastMessageText };
}

beforeEach(async () => {
  await db.close();
  sqlite.__sqlite.reset();
  db.setWorkspace('real');
  bindRealEngine();
  await db.initDb();
  await db.upsertChat(PEER);
});

afterEach(async () => {
  await db.close();
  engine.close();
});

// ---------------------------------------------------------------------------

test('deleting the newest message hands the line to the one before it, timestamp included', async () => {
  await seed(FIRST, 'first', 1000);
  await db.touchChat(PEER, 'first', 1000);
  await seed(SECOND, 'second', 2000);
  await db.touchChat(PEER, 'second', 2000);
  expect(await line()).toEqual({ at: 2000, text: 'second' });

  await db.deleteMessage(SECOND, 'in');
  expect(await line()).toEqual({ at: 1000, text: 'first' });
});

test('deleting the last message clears BOTH columns — "No messages yet", never a blank under a live timestamp', async () => {
  await seed(FIRST, 'first', 1000);
  await db.touchChat(PEER, 'first', 1000);
  await seed(SECOND, 'second', 2000);
  await db.touchChat(PEER, 'second', 2000);

  await db.deleteMessage(SECOND, 'in');
  await db.deleteMessage(FIRST, 'in');
  expect(await line()).toEqual({ at: null, text: null });
});

test('deleting an OLDER message leaves the line untouched', async () => {
  await seed(FIRST, 'first', 1000);
  await db.touchChat(PEER, 'first', 1000);
  await seed(SECOND, 'second', 2000);
  await db.touchChat(PEER, 'second', 2000);

  await db.deleteMessage(FIRST, 'in');
  expect(await line()).toEqual({ at: 2000, text: 'second' });
});

test('a retracted newest-remaining row previews DELETED_PREVIEW, as the list does for a retraction', async () => {
  await seed(FIRST, 'first', 1000);
  // Retracted on disk exactly as tombstoneMessage leaves it: the body gone,
  // the stamp set, the row keeping its place.
  engine.exec(
    `UPDATE messages SET body = '', deletedAt = 1200 WHERE msgId = '${FIRST}'`,
  );
  await seed(SECOND, 'second', 2000);
  await db.touchChat(PEER, 'second', 2000);

  await db.deleteMessage(SECOND, 'in');
  expect(await line()).toEqual({ at: 1000, text: DELETED_PREVIEW });
});

test('a carrier envelope newest-remaining is skipped — transport never takes the line', async () => {
  await seed(FIRST, 'first', 1000);
  // Call signalling is a carrier by namespace alone (isCarrierEnvelope):
  // never a row, never a preview.
  await seed(CARRIER, '{"tcm":"call.ringing"}', 1500);
  await seed(SECOND, 'second', 2000);
  await db.touchChat(PEER, 'second', 2000);

  await db.deleteMessage(SECOND, 'in');
  expect(await line()).toEqual({ at: 1000, text: 'first' });
});

test('a mention newest-remaining is re-said with THIS phone\'s names — never " lunch? " with the names dropped', async () => {
  // The resolver-less recompute the mention contract forbids: without names
  // the marks drop and "@Cara lunch? @you" becomes " lunch? ". The store
  // names from its own rows — the chats row for Cara, the profile for me.
  engine.exec(`INSERT INTO profile (key, value) VALUES ('userId', '${ME}')`);
  await db.upsertChat(CARA, 'Cara');
  await seed(
    FIRST,
    JSON.stringify({
      tcm: 'mention',
      text: '\uFFFC lunch? \uFFFC',
      who: [CARA, ME],
    }),
    1000,
  );
  await seed(SECOND, 'second', 2000);
  await db.touchChat(PEER, 'second', 2000);

  await db.deleteMessage(SECOND, 'in');
  expect(await line()).toEqual({ at: 1000, text: '@Cara lunch? @you' });
});

// --- the recompute may never LINE a row the receive path refused to line ----
//
// `lastMessageAt` is the chat list's sort key, and three kinds of row
// are stored deliberately WITHOUT touching it: relayed history (`sharedBy`,
// a relayer's account with a relayer-claimed `ts`), a row that arrived from
// outside the room (`outsider`), and a declined announcement/roster attempt
// (no column marks it — only its missing touchChat does). Letting a local
// "Delete for me" hand any of them the line would give a member, a relayer
// or an outsider the chat-list bump the protocol denies them.
// messaging.refreshPreview, whose rule this mirrors, never writes
// `lastMessageAt` at all.

const RELAY = pad('R4');
const DECLINED = pad('D5');
const OUTSIDE = pad('O6');

/** FIRST at 1000 holds the line under SECOND at 2000; SECOND is deleted. */
async function seedTwoLined(): Promise<void> {
  await seed(FIRST, 'first', 1000);
  await db.touchChat(PEER, 'first', 1000);
  await seed(SECOND, 'second', 2000);
  await db.touchChat(PEER, 'second', 2000);
}

test('a relayed row with a FUTURE timestamp never becomes the line', async () => {
  await seedTwoLined();
  // Stored exactly as the relayed-history path leaves it: the relayer's own
  // claimed `t` (here, later than anything witnessed), NO touchChat.
  await db.insertMessage({
    msgId: RELAY,
    peerId: PEER,
    direction: 'in',
    body: 'relayed words',
    ts: 5000,
    status: 'received',
    sharedBy: CARA,
  } as db.MessageRow);

  await db.deleteMessage(SECOND, 'in');
  expect(await line()).toEqual({ at: 1000, text: 'first' });
});

test('deleting a row that never held the line leaves the line alone', async () => {
  await seedTwoLined();
  await db.insertMessage({
    msgId: RELAY,
    peerId: PEER,
    direction: 'in',
    body: 'relayed words',
    ts: 5000,
    status: 'received',
    sharedBy: CARA,
  } as db.MessageRow);

  await db.deleteMessage(RELAY, 'in');
  expect(await line()).toEqual({ at: 2000, text: 'second' });
});

test('a declined attempt newer than the line never becomes the line', async () => {
  await seedTwoLined();
  // A non-owner's roster write that the fold DECLINED: announced in the
  // thread, never allowed to reorder anyone's chat list, and no column
  // records that — only the missing touchChat does.
  await seed(DECLINED, '{"tcm":"grp.roster","g":"x"}', 4000);

  await db.deleteMessage(SECOND, 'in');
  expect(await line()).toEqual({ at: 1000, text: 'first' });
});

test('a row from OUTSIDE the room never becomes the line', async () => {
  await seedTwoLined();
  await db.insertMessage({
    msgId: OUTSIDE,
    peerId: PEER,
    direction: 'in',
    body: 'from outside',
    ts: 1500,
    status: 'received',
    outsider: 1,
  } as db.MessageRow);

  await db.deleteMessage(SECOND, 'in');
  expect(await line()).toEqual({ at: 1000, text: 'first' });
});
