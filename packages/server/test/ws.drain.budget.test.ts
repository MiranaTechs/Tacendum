import { describe, expect, it } from 'vitest';
import { monotonicFactory } from 'ulid';
import type { ServerFrame } from '@tacendum/shared';
import { drainQueuedMessages } from '../src/handlers/ws.js';
import type { DataLayer } from '../src/db/data.js';
import { makeMemoryDb, makeTestDeps } from './helpers.js';

/**
 * S2b — the reconnect drain runs under an EXPLICIT per-invocation budget.
 *
 * The queue's size is attacker-controlled. The streaming fix capped
 * what the drain HOLDS at a page; nothing capped what one invocation POSTS, so
 * a huge backlog meant the drain Lambda pumped until its host killed it at the
 * timeout — no clean stop, no record of where it got to, and a re-run that
 * repeats the same prefix at full length.
 *
 * The budget bounds items, bytes and time per invocation, and the result
 * carries a CURSOR (the last posted msgId) so the caller resumes exactly where
 * it stopped instead of starting over. Across invocations the queue head
 * itself advances as the client acks the delivered prefix — every invocation
 * delivers a bounded prefix and terminates on its own terms.
 */

const ulid = monotonicFactory();
const RECIPIENT = 'user-budget-recipient';

async function seed(db: DataLayer, count: number, payload = 'Y2lwaGVydGV4dA=='): Promise<string[]> {
  const msgIds: string[] = [];
  for (let i = 0; i < count; i++) {
    const msgId = ulid();
    msgIds.push(msgId);
    await db.enqueueMessage({
      recipientId: RECIPIENT,
      msgId,
      senderId: `sender-${i % 3}`,
      type: 'ciphertext',
      payload,
      ts: Date.now(),
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    });
  }
  return msgIds;
}

/** Seed one row with a caller-chosen expiry, so a slice can be handed a run of
 * already-expired rows (the drain filters them on the clock, never trusting
 * TTL to have reaped them). Returns the msgId. */
async function seedOne(db: DataLayer, expiresAt: number): Promise<string> {
  const msgId = ulid();
  await db.enqueueMessage({
    recipientId: RECIPIENT,
    msgId,
    senderId: 'sender-x',
    type: 'ciphertext',
    payload: 'Y2lwaGVydGV4dA==',
    ts: Date.now(),
    expiresAt,
  });
  return msgId;
}

function collector(): {
  posted: Array<{ connectionId: string; frame: ServerFrame }>;
  sender: { post(connectionId: string, frame: ServerFrame): Promise<boolean> };
} {
  const posted: Array<{ connectionId: string; frame: ServerFrame }> = [];
  return {
    posted,
    sender: {
      async post(connectionId, frame) {
        posted.push({ connectionId, frame });
        return true;
      },
    },
  };
}

describe('S2b — item budget', () => {
  it('posts exactly the budget, reports exhaustion with a cursor, and resumes from it', async () => {
    const db = makeMemoryDb();
    const deps = makeTestDeps(db);
    const msgIds = await seed(db, 10);
    const { posted, sender } = collector();

    const first = await drainQueuedMessages(
      RECIPIENT,
      'conn-1',
      { db, sender, now: deps.now },
      { maxItems: 4, maxBytes: 10_000_000 },
    );

    expect(first).toMatchObject({ outcome: 'budget_exhausted', cursor: msgIds[3] });
    expect(posted).toHaveLength(4);
    expect(posted.map((p) => (p.frame as { msgId?: string }).msgId)).toEqual(msgIds.slice(0, 4));

    // Resume from the cursor: the next slice continues, never repeats.
    const second = await drainQueuedMessages(
      RECIPIENT,
      'conn-1',
      { db, sender, now: deps.now },
      { maxItems: 4, maxBytes: 10_000_000 },
      first.outcome === 'budget_exhausted' ? first.cursor : undefined,
    );
    expect(second).toMatchObject({ outcome: 'budget_exhausted', cursor: msgIds[7] });
    expect(posted).toHaveLength(8);

    const third = await drainQueuedMessages(
      RECIPIENT,
      'conn-1',
      { db, sender, now: deps.now },
      { maxItems: 4, maxBytes: 10_000_000 },
      second.outcome === 'budget_exhausted' ? second.cursor : undefined,
    );
    expect(third).toMatchObject({ outcome: 'complete' });
    expect(posted).toHaveLength(10);
    expect(posted.map((p) => (p.frame as { msgId?: string }).msgId)).toEqual(msgIds);
  });
});

describe('S2b — byte budget', () => {
  it('stops once the posted payload bytes would exceed the budget', async () => {
    const db = makeMemoryDb();
    const deps = makeTestDeps(db);
    // 16 bytes of payload per message; a 40-byte budget fits 2, not 3.
    await seed(db, 5, 'Y2lwaGVydGV4dA==');
    const { posted, sender } = collector();

    const result = await drainQueuedMessages(
      RECIPIENT,
      'conn-1',
      { db, sender, now: deps.now },
      { maxItems: 1_000, maxBytes: 40 },
    );

    expect(result.outcome).toBe('budget_exhausted');
    expect(posted).toHaveLength(2);
  });
});

describe('S2b — time budget', () => {
  it('stops posting once the deadline passes, and still reports where it stopped', async () => {
    const db = makeMemoryDb();
    const deps = makeTestDeps(db);
    const msgIds = await seed(db, 10);
    const posted: string[] = [];
    // Each post costs 100 ms of injected clock; a 250 ms deadline fits 3.
    const sender = {
      async post(_connectionId: string, frame: ServerFrame): Promise<boolean> {
        posted.push((frame as { msgId?: string }).msgId ?? '');
        deps.advanceMs(100);
        return true;
      },
    };

    const result = await drainQueuedMessages(
      RECIPIENT,
      'conn-1',
      { db, sender, now: deps.now },
      { maxItems: 1_000, maxBytes: 10_000_000, deadlineMs: deps.now() + 250 },
    );

    expect(result.outcome).toBe('budget_exhausted');
    expect(posted).toEqual(msgIds.slice(0, 3));
    if (result.outcome === 'budget_exhausted') {
      expect(result.cursor).toBe(msgIds[2]);
    }
  });
});

describe('expired rows are budgeted and advance the cursor', () => {
  it('stops a long expired run on the scanned-row budget and resumes PAST it, even with zero posts', async () => {
    const db = makeMemoryDb();
    const deps = makeTestDeps(db);
    const nowSec = Math.floor(deps.now() / 1000);
    // A run of already-expired rows in front of a single live tail. Without a
    // per-row scan budget the drain skips every expired row with no budget
    // check at all, so a run large enough to consume the invocation (in prod:
    // killed at the Lambda timeout) leaves the live tail behind it undelivered
    // and the cursor — the last POSTED msgId — never advances, so the next
    // attempt restarts before the run and repeats forever.
    const expiredIds: string[] = [];
    for (let i = 0; i < 5; i++) expiredIds.push(await seedOne(db, nowSec - 1));
    const liveId = await seedOne(db, nowSec + 3600);
    const { posted, sender } = collector();
    const budget = { maxItems: 2000, maxBytes: 10_000_000, maxScanned: 3 };

    const first = await drainQueuedMessages(RECIPIENT, 'conn-1', { db, sender, now: deps.now }, budget);

    // Zero posted (every examined row was expired), but the slice STOPPED on
    // the scanned-row budget and reported a cursor past the examined prefix —
    // not 'complete', which would mean it walked the whole run in one slice.
    expect(posted).toHaveLength(0);
    expect(first.outcome).toBe('budget_exhausted');
    if (first.outcome === 'budget_exhausted') {
      expect(first.cursor).toBe(expiredIds[2]); // last of the 3 examined rows
    }

    // Resume from the cursor until the drain completes: the continuation walks
    // the remaining expired rows and finally delivers the live tail — the row
    // the buggy resume-from-last-post could never reach.
    let cursor = first.outcome === 'budget_exhausted' ? first.cursor : undefined;
    let guard = 0;
    while (cursor !== undefined && guard++ < 10) {
      const r = await drainQueuedMessages(
        RECIPIENT,
        'conn-1',
        { db, sender, now: deps.now },
        budget,
        cursor,
      );
      cursor = r.outcome === 'budget_exhausted' ? r.cursor : undefined;
    }
    expect(posted.map((p) => (p.frame as { msgId?: string }).msgId)).toEqual([liveId]);
  });

  it('enforces the DEADLINE on expired rows too, not only on posted ones', async () => {
    const db = makeMemoryDb();
    const deps = makeTestDeps(db);
    const nowSec = Math.floor(deps.now() / 1000);
    // Two expired rows, then a live one. A generator that advances the clock as
    // each page is fetched models the wall-clock a real drain spends SCANNING
    // an expired run — independent of posts. With the deadline enforced only on
    // posted rows, the scan blows past it and the live tail is posted anyway;
    // enforced per row, the slice stops inside the run with a resumable cursor.
    const e0 = await seedOne(db, nowSec - 1);
    const e1 = await seedOne(db, nowSec - 1);
    await seedOne(db, nowSec + 3600); // live tail, must NOT post this slice
    const realList = db.listQueuedMessages.bind(db);
    db.listQueuedMessages = async function* (recipientId: string, afterMsgId?: string) {
      for await (const page of realList(recipientId, afterMsgId)) {
        deps.advanceMs(200); // each page fetch "costs" wall-clock
        yield page;
      }
    };
    const { posted, sender } = collector();
    // Deadline 300 ms out: page 0 (e0,e1) fetch spends 200; page 1 fetch spends
    // another 200 → now past the deadline before the live row is examined.
    const first = await drainQueuedMessages(
      RECIPIENT,
      'conn-1',
      { db, sender, now: deps.now },
      { maxItems: 2000, maxBytes: 10_000_000, deadlineMs: deps.now() + 300 },
    );

    expect(posted).toHaveLength(0);
    expect(first.outcome).toBe('budget_exhausted');
    if (first.outcome === 'budget_exhausted') {
      // Stopped at the last examined key (an expired row), never at the live
      // tail — the cursor is one of the expired rows, not undefined/complete.
      expect([e0, e1]).toContain(first.cursor);
    }
  });
});

describe('a spent deadline binds BEFORE the first fetch and the first post', () => {
  it('posts NOTHING when the deadline has already passed at entry, and claims no progress', async () => {
    const db = makeMemoryDb();
    const deps = makeTestDeps(db);
    await seed(db, 3);
    const { posted, sender } = collector();

    // The deadline computes to "now" — the caller is already inside its safety
    // margin. The old contract still posted the first live row ("a budgeted
    // invocation always makes forward progress"), i.e. it bound the ITEM
    // budget, not the clock: a handler with no time posted anyway. The slice
    // must instead end with nothing posted, nothing examined, and the cursor
    // exactly where it started, so the caller hands the WHOLE slice to a fresh
    // invocation with a full clock.
    const result = await drainQueuedMessages(
      RECIPIENT,
      'conn-1',
      { db, sender, now: deps.now },
      { maxItems: 2000, maxBytes: 10_000_000, deadlineMs: deps.now() },
    );

    expect(posted).toHaveLength(0);
    expect(result.outcome).toBe('budget_exhausted');
    if (result.outcome === 'budget_exhausted') {
      expect(result.cursor).toBeUndefined(); // no progress claimed on a fresh drain
    }
  });

  it('a spent deadline on a RESUMED slice returns the resume cursor unchanged', async () => {
    const db = makeMemoryDb();
    const deps = makeTestDeps(db);
    const msgIds = await seed(db, 3);
    const { posted, sender } = collector();

    const result = await drainQueuedMessages(
      RECIPIENT,
      'conn-1',
      { db, sender, now: deps.now },
      { maxItems: 2000, maxBytes: 10_000_000, deadlineMs: deps.now() },
      msgIds[0], // resuming after the first message
    );

    expect(posted).toHaveLength(0);
    expect(result.outcome).toBe('budget_exhausted');
    if (result.outcome === 'budget_exhausted') {
      // The unchanged cursor: the tail from msgIds[1] on is someone else's
      // whole slice, not this invocation's progress.
      expect(result.cursor).toBe(msgIds[0]);
    }
  });
});

describe('S2b — the old outcomes survive the budget', () => {
  it('an unbudgeted call still completes the whole queue', async () => {
    const db = makeMemoryDb();
    const deps = makeTestDeps(db);
    await seed(db, 5);
    const { posted, sender } = collector();

    const result = await drainQueuedMessages(RECIPIENT, 'conn-1', { db, sender, now: deps.now });
    expect(result.outcome).toBe('complete');
    expect(posted).toHaveLength(5);
  });

  it('a dead socket still reports socket_gone, budget or not', async () => {
    const db = makeMemoryDb();
    const deps = makeTestDeps(db);
    await seed(db, 5);

    const result = await drainQueuedMessages(
      RECIPIENT,
      'conn-1',
      { db, sender: { post: async () => false }, now: deps.now },
      { maxItems: 100, maxBytes: 10_000_000 },
    );
    expect(result.outcome).toBe('socket_gone');
  });
});
