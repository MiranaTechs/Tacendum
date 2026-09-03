import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { monotonicFactory } from 'ulid';
import { ListTablesCommand } from '@aws-sdk/client-dynamodb';
import { TABLES } from '@tacendum/shared';
import { makeDynamoClient, makeDocClient } from '../src/db/client.js';
import { makeDataLayer, type DataLayer, type QueuedMessage } from '../src/db/data.js';
import { allQueued, makeMemoryDb } from './helpers.js';

/**
 * The queued row carries the frame's `urgent` bit and the store can list a
 * partition's urgent rows on their own, in msgId order, under a bound on how
 * many rows the filtered Query may EVALUATE. The contract is asserted against
 * the real store (DynamoDB Local — the filter and the Limit-before-filter
 * semantics physically live there) and against the memory twin, which every
 * drain unit test runs on and must therefore answer identically. */

const ulid = monotonicFactory();

function makeMsg(recipientId: string, senderId: string, urgent?: true): QueuedMessage {
  return {
    recipientId,
    msgId: ulid(),
    senderId,
    type: 'ciphertext',
    payload: 'Y2lwaGVydGV4dA==',
    ts: Date.now(),
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    ...(urgent ? { urgent: true } : {}),
  };
}

async function allUrgent(db: DataLayer, recipientId: string, maxScanned = 5000): Promise<string[]> {
  const out: string[] = [];
  for await (const page of db.listUrgentQueuedMessages(recipientId, maxScanned)) {
    out.push(...page.map((m) => m.msgId));
  }
  return out;
}

/** The contract, run once per store. `dbFor` answers undefined when the store
 * is unavailable (DynamoDB Local down), which skips rather than fails. */
function contract(
  name: string,
  dbFor: () => DataLayer | undefined,
  track: (recipientId: string) => void,
) {
  describe(name, () => {
    it('lists only the urgent rows, in msgId order, and leaves the ordered stream whole', async (ctx) => {
      const db = dbFor();
      if (!db) return ctx.skip();
      const recipient = `01URG${ulid()}`;
      track(recipient);
      const n1 = makeMsg(recipient, 'sender-a');
      const u1 = makeMsg(recipient, 'caller', true);
      const n2 = makeMsg(recipient, 'sender-a');
      const u2 = makeMsg(recipient, 'caller', true);
      for (const m of [n1, u1, n2, u2]) await db.enqueueMessage(m);

      expect(await allUrgent(db, recipient)).toEqual([u1.msgId, u2.msgId]);
      const rows = await allQueued(db, recipient);
      expect(rows.map((m) => m.msgId)).toEqual([n1.msgId, u1.msgId, n2.msgId, u2.msgId]);
      // The bit is on the ROW, present-and-true or absent — never false.
      expect(rows.find((m) => m.msgId === u1.msgId)?.urgent).toBe(true);
      expect(rows.find((m) => m.msgId === n1.msgId)?.urgent).toBeUndefined();
    });

    it('honours the scan bound: an urgent row past maxScanned evaluated rows is not returned', async (ctx) => {
      const db = dbFor();
      if (!db) return ctx.skip();
      const recipient = `01URG${ulid()}`;
      track(recipient);
      const n1 = makeMsg(recipient, 'sender-a');
      const n2 = makeMsg(recipient, 'sender-a');
      const u1 = makeMsg(recipient, 'caller', true);
      for (const m of [n1, n2, u1]) await db.enqueueMessage(m);

      expect(await allUrgent(db, recipient, 2)).toEqual([]);
      expect(await allUrgent(db, recipient, 3)).toEqual([u1.msgId]);
    });

    it('answers an empty partition, and one with no urgent rows, with nothing', async (ctx) => {
      const db = dbFor();
      if (!db) return ctx.skip();
      const recipient = `01URG${ulid()}`;
      track(recipient);
      expect(await allUrgent(db, recipient)).toEqual([]);
      await db.enqueueMessage(makeMsg(recipient, 'sender-a'));
      expect(await allUrgent(db, recipient)).toEqual([]);
    });
  });
}

describe('the urgent rows of a queue (real DynamoDB)', () => {
  let available = false;
  let db: DataLayer | undefined;
  const purgeTargets: string[] = [];

  beforeAll(async () => {
    const client = makeDynamoClient();
    const doc = makeDocClient(client);
    try {
      const { TableNames = [] } = await client.send(new ListTablesCommand({}));
      available = TableNames.includes(TABLES.messages);
    } catch {
      available = false;
    }
    if (process.env.TACENDUM_REQUIRE_DDB === '1' && !available) {
      throw new Error('TACENDUM_REQUIRE_DDB=1 but DynamoDB Local is down');
    }
    if (available) db = makeDataLayer(doc);
  });

  afterAll(async () => {
    if (!db) return;
    for (const recipientId of purgeTargets) await db.purgeQueuedMessages(recipientId);
  });

  contract(
    'store',
    () => db,
    (r) => purgeTargets.push(r),
  );
});

describe('the memory twin answers the same contract', () => {
  const db = makeMemoryDb();
  contract(
    'twin',
    () => db,
    () => {},
  );
});
