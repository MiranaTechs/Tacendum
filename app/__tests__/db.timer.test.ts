/**
 * Disappearing messages, persistence half.
 *
 * These exist because of a bug class the mocked sqlite cannot catch on its
 * own: a column added to a table is invisible to every reader until it is
 * named in that reader's explicit SELECT. `getChat` and the three message
 * queries all use hand-written column lists, so adding `disappearSec`,
 * `disappearVersion` and `expiresAt` to the schema was NOT enough — the send
 * path read "no timer" and armExpiry appeared to do nothing, while the rows
 * on disk were perfectly correct. Found by driving real op-sqlite in the
 * simulator; pinned here so it cannot come back.
 *
 * Harness follows db.blocking.test.ts: the fake op-sqlite records statements
 * rather than executing them, so these assert on the SQL itself.
 */
import * as db from '../src/db';

interface FakeDb {
  name: string;
  execute: jest.Mock;
  close: jest.Mock;
}
const sqlite = (
  jest.requireMock('@op-engineering/op-sqlite') as {
    __sqlite: { instances: Map<string, FakeDb>; reset(): void };
  }
).__sqlite;

/** Every statement any open database has been asked to run. Aggregated
 * across instances: initDb may hold a connection opened before this file's
 * reset, and the decoy workspace is a second file. */
function statements(): string[] {
  return [...sqlite.instances.values()].flatMap(instance =>
    instance.execute.mock.calls.map(call => String(call[0])),
  );
}

function sqlMatching(fragment: string): string[] {
  return statements().filter(s => s.includes(fragment));
}

// ONCE, not per test: initDb is idempotent, so resetting the fake between
// tests empties the instance map and nothing ever re-opens — every later
// assertion then reads an empty statement log and passes or fails for the
// wrong reason. Tests that care about counts take their own baseline.
beforeAll(async () => {
  sqlite.reset();
  await db.initDb();
});

describe('the schema carries the timer', () => {
  it('adds every new column to a table that predates them', () => {
    // Additive ALTERs, guarded by the PRAGMA check — safe on a file with real
    // conversations in it.
    for (const column of ['disappearSec', 'disappearVersion', 'expiresAt']) {
      expect(sqlMatching(`ADD COLUMN ${column}`).length).toBeGreaterThan(0);
    }
  });
});

describe('readers actually project the new columns', () => {
  it('getChat selects the timer pair, or the send path silently sees no timer', async () => {
    await db.getChat('01PEERAAAAAAAAAAAAAAAAAAAA');

    const select = sqlMatching('FROM chats WHERE peerId').at(-1) ?? '';
    expect(select).toContain('disappearSec');
    expect(select).toContain('disappearVersion');
  });

  it('every message query selects expiresAt, or nothing can tell what is armed', async () => {
    await db.listMessages('01PEERAAAAAAAAAAAAAAAAAAAA');

    const select = sqlMatching('FROM messages WHERE peerId').at(-1) ?? '';
    expect(select).toContain('expiresAt');
  });
});

describe('arming the clock', () => {
  it('touches inbound rows only, and only ones not already armed', async () => {
    await db.armExpiry('01PEERAAAAAAAAAAAAAAAAAAAA', 3600, 1_700_000_000_000);

    const update = sqlMatching('UPDATE messages SET expiresAt').at(-1) ?? '';
    // Their messages, not mine: my own start their clock at send.
    expect(update).toContain("direction = 'in'");
    // Re-opening a thread must never extend a clock that is already running.
    expect(update).toContain('expiresAt IS NULL');
  });

  it('does nothing at all when the timer is off', async () => {
    const before = sqlMatching('UPDATE messages SET expiresAt').length;
    await db.armExpiry('01PEERAAAAAAAAAAAAAAAAAAAA', 0, 1_700_000_000_000);

    expect(sqlMatching('UPDATE messages SET expiresAt')).toHaveLength(before);
  });
});

describe('the sweep', () => {
  it('takes reactions and attachments with the message, in one transaction', async () => {
    // A sweep that removed a message but left its photo pointer would leave a
    // blob referenced by nothing and undeletable.
    const instances = [...sqlite.instances.values()];
    const saved = instances.map(i => i.execute.getMockImplementation());
    for (const inst of instances) {
      inst.execute.mockImplementation(async (sql: string) => {
        if (String(sql).startsWith('SELECT msgId FROM messages WHERE expiresAt')) {
          return { rows: [{ msgId: '01GONE' }] };
        }
        return { rows: [] };
      });
    }

    // Baseline BEFORE the sweep: `DELETE FROM outbox` and
    // `DELETE FROM attachments` are also issued by deleteChat and by
    // blocking, so an unscoped search over the whole log is answered by
    // somebody else's statement and passes whatever the sweep does. (It
    // did: the first version of the outbox assertion below survived its own
    // mutation for exactly this reason.)
    const before = statements().length;
    const removed = await db.sweepExpired(1_700_000_000_000);
    const swept = statements().slice(before);
    // Restored so the "nothing due" test below is not answered by this mock.
    instances.forEach((inst, i) => inst.execute.mockImplementation(saved[i]));

    expect(removed).toBe(1);
    expect(sqlMatching('BEGIN IMMEDIATE').length).toBeGreaterThan(0);
    expect(sqlMatching('DELETE FROM reactions').length).toBeGreaterThan(0);
    expect(sqlMatching('DELETE FROM attachments').length).toBeGreaterThan(0);
    expect(sqlMatching('DELETE FROM messages WHERE expiresAt').length).toBeGreaterThan(0);
    expect(sqlMatching('COMMIT').length).toBeGreaterThan(0);

    // THE ROW THAT STILL TRANSMITTED. A disappearing message the person
    // watched vanish could still be sitting un-flushed in the outbox, and
    // the next flush sent it — after its own timer said it was gone. The
    // visible row and the queued envelope are one message.
    const outboxSweeps = swept.filter(s => s.includes('DELETE FROM outbox'));
    expect(outboxSweeps).toHaveLength(1);
    // Scoped to my own sends: an inbound message carrying a colliding
    // sender-chosen msgId must not delete MY queued envelope.
    expect(outboxSweeps[0]).toContain("direction = 'out'");

    // WHOLE-KEY CASCADES. A msgId is chosen by whoever sent the message, so
    // matching on it alone let a peer's expiring message delete the
    // attachment or the chip belonging to MY message of the same id.
    const attSweep = swept.filter(s => s.includes('DELETE FROM attachments'));
    expect(attSweep).toHaveLength(1);
    expect(attSweep[0]).toContain('attachments.direction');
    const reaSweep = swept.filter(s => s.includes('DELETE FROM reactions'));
    expect(reaSweep).toHaveLength(1);
    expect(reaSweep[0]).toContain('reactions.targetDirection');
  });

  it('opens no transaction when nothing is due', async () => {
    const before = sqlMatching('BEGIN IMMEDIATE').length;

    const removed = await db.sweepExpired(1_700_000_000_000);

    expect(removed).toBe(0);
    expect(sqlMatching('BEGIN IMMEDIATE')).toHaveLength(before);
  });
});
