import { describe, expect, it } from 'vitest';
import {
  BatchWriteCommand,
  DeleteCommand,
  QueryCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { makeDataLayer, PREKEY_CANDIDATE_PAGE } from '../src/db/data.js';
import { makeMemoryDb } from './helpers.js';

/**
 * The one-time prekey pool generation, on the wire.
 *
 * `storeKeys` replaces the pool in three non-transactional steps. Between the
 * row Update (new signed prekey visible) and the stale-pool delete, a bundle
 * fetch could consume an OLD-pool one-time prekey and serve it under the NEW
 * signed prekey; on a reinstall the first prekey message built on that bundle
 * is lost. Now every upload mints a pool GENERATION, stamped on the user row
 * and on every prekey item it writes, and the consume is conditioned on the
 * generation the caller read off the row — a foreign-generation key is never
 * handed out.
 *
 * The consume queried the ten LOWEST keyIds and tried them in order, so N
 * concurrent fetches all raced the same candidates and a 50-loop bailout
 * reported the pool empty. The page is wider now and the candidate is picked
 * at random from it. */

const USER = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

function page(n: number, poolGen?: string): Record<string, unknown>[] {
  return Array.from({ length: n }, (_, i) => ({
    userId: USER,
    keyId: i + 1,
    pub: 'QUJDMTIz',
    ...(poolGen === undefined ? {} : { poolGen }),
  }));
}

/** A scripted doc: Queries answer from `pages` in order (the last one
 * repeats), Deletes succeed and echo the key back, everything is recorded. */
function scriptedDoc(pages: { Items: Record<string, unknown>[]; LastEvaluatedKey?: unknown }[]): {
  queries: QueryCommand[];
  deletes: DeleteCommand[];
  doc: DynamoDBDocumentClient;
} {
  const queries: QueryCommand[] = [];
  const deletes: DeleteCommand[] = [];
  let q = 0;
  const send = async (cmd: unknown): Promise<unknown> => {
    if (cmd instanceof QueryCommand) {
      queries.push(cmd);
      const reply = pages[Math.min(q, pages.length - 1)]!;
      q += 1;
      return reply;
    }
    if (cmd instanceof DeleteCommand) {
      deletes.push(cmd);
      const keyId = (cmd.input.Key as { keyId: number }).keyId;
      return { Attributes: { keyId, pub: 'QUJDMTIz' } };
    }
    return {};
  };
  return { queries, deletes, doc: { send } as unknown as DynamoDBDocumentClient };
}

describe('consumeOneTimePrekey is conditioned on the pool generation', () => {
  it('filters the candidate page AND conditions the delete on the generation the caller read', async () => {
    const { queries, deletes, doc } = scriptedDoc([{ Items: page(5, 'gen-2') }]);
    const db = makeDataLayer(doc);
    const got = await db.consumeOneTimePrekey(USER, 'gen-2');
    expect(got?.pub).toBe('QUJDMTIz');
    expect(queries[0]!.input.FilterExpression).toBe('poolGen = :g');
    expect(queries[0]!.input.ExpressionAttributeValues?.[':g']).toBe('gen-2');
    expect(deletes[0]!.input.ConditionExpression).toBe('attribute_exists(keyId) AND poolGen = :g');
    expect(deletes[0]!.input.ExpressionAttributeValues?.[':g']).toBe('gen-2');
  });

  it('a legacy row (no generation yet) consumes unconditioned, exactly as before', async () => {
    const { queries, deletes, doc } = scriptedDoc([{ Items: page(5) }]);
    const db = makeDataLayer(doc);
    expect(await db.consumeOneTimePrekey(USER)).toBeDefined();
    expect(queries[0]!.input.FilterExpression).toBeUndefined();
    expect(deletes[0]!.input.ConditionExpression).toBe('attribute_exists(keyId)');
  });

  it('a page holding only foreign-generation rows is paged past, not reported as an empty pool', async () => {
    // DynamoDB applies Limit BEFORE the filter: a page can come back with no
    // Items and a LastEvaluatedKey. The consume must continue from that key.
    const { queries, doc } = scriptedDoc([
      { Items: [], LastEvaluatedKey: { userId: USER, keyId: 25 } },
      { Items: page(3, 'gen-2') },
    ]);
    const db = makeDataLayer(doc);
    expect(await db.consumeOneTimePrekey(USER, 'gen-2')).toBeDefined();
    expect(queries).toHaveLength(2);
    expect(queries[1]!.input.ExclusiveStartKey).toEqual({ userId: USER, keyId: 25 });
  });

  it('countOneTimePrekeys counts the caller’s generation only, so a stale leftover never hides a low pool', async () => {
    const counts: QueryCommand[] = [];
    const send = async (cmd: unknown): Promise<unknown> => {
      if (cmd instanceof QueryCommand) {
        counts.push(cmd);
        return { Count: 3 };
      }
      return {};
    };
    const db = makeDataLayer({ send } as unknown as DynamoDBDocumentClient);
    expect(await db.countOneTimePrekeys(USER, 'gen-2')).toBe(3);
    expect(counts[0]!.input.FilterExpression).toBe('poolGen = :g');
    expect(await db.countOneTimePrekeys(USER)).toBe(3);
    expect(counts[1]!.input.FilterExpression).toBeUndefined();
  });
});

describe('storeKeys stamps a generation and flips the row BEFORE the pool changes', () => {
  it('row Update carries the new generation; pool Puts carry it; only foreign-generation rows are deleted', async () => {
    const commands: unknown[] = [];
    const send = async (cmd: unknown): Promise<unknown> => {
      commands.push(cmd);
      if (cmd instanceof QueryCommand) {
        // The listing after the write: two leftovers of the old generation,
        // one row already re-stamped by the new Puts (same keyId).
        const gen = commands
          .filter((c): c is UpdateCommand => c instanceof UpdateCommand)
          .map((c) => c.input.ExpressionAttributeValues?.[':g'])[0];
        return {
          Items: [
            { keyId: 1, poolGen: gen },
            { keyId: 7, poolGen: 'gen-old' },
            { keyId: 9 },
          ],
        };
      }
      return {};
    };
    const db = makeDataLayer({ send } as unknown as DynamoDBDocumentClient);
    await expect(
      db.storeKeys(
        USER,
        {
          registrationId: 7,
          identityKeyPub: 'ik',
          signedPrekey: { keyId: 2, pub: 'p', sig: 's' },
          kyberPrekey: { keyId: 3, pub: 'p', sig: 's' },
        },
        [{ keyId: 1, pub: 'p1' }],
      ),
    ).resolves.toBe(true);

    const update = commands.find((c): c is UpdateCommand => c instanceof UpdateCommand)!;
    const gen = update.input.ExpressionAttributeValues?.[':g'] as string;
    expect(typeof gen).toBe('string');
    expect(gen.length).toBeGreaterThan(8);
    expect(update.input.UpdateExpression).toContain('prekeyPoolGen = :g');
    // The identity-key immutability condition is untouched.
    expect(update.input.ConditionExpression).toBe(
      'attribute_exists(userId) AND (attribute_not_exists(identityKeyPub) OR identityKeyPub = :ik)',
    );

    const batches = commands.filter((c): c is BatchWriteCommand => c instanceof BatchWriteCommand);
    const puts = batches.flatMap((b) =>
      Object.values(b.input.RequestItems ?? {}).flatMap((reqs) =>
        reqs.flatMap((r) => (r.PutRequest ? [r.PutRequest.Item] : [])),
      ),
    );
    const deletes = batches.flatMap((b) =>
      Object.values(b.input.RequestItems ?? {}).flatMap((reqs) =>
        reqs.flatMap((r) => (r.DeleteRequest ? [r.DeleteRequest.Key] : [])),
      ),
    );
    expect(puts).toEqual([{ userId: USER, keyId: 1, pub: 'p1', poolGen: gen }]);
    // Foreign generations only: the row the Put just re-stamped is spared.
    expect(deletes.map((k) => (k as { keyId: number }).keyId).sort()).toEqual([7, 9]);

    // Order: the row flips FIRST (the consume conditions on it), then the
    // pool is written, then the stale rows go.
    const order = commands.map((c) => (c as object).constructor.name);
    expect(order.indexOf('UpdateCommand')).toBeLessThan(order.indexOf('BatchWriteCommand'));
    const firstBatch = batches[0]!;
    expect(
      Object.values(firstBatch.input.RequestItems ?? {}).flat().every((r) => r.PutRequest),
    ).toBe(true);
  });
});

describe('the candidate page is wide and the pick is random', () => {
  it(`queries ${PREKEY_CANDIDATE_PAGE} candidates and does not always try the lowest keyId first`, async () => {
    expect(PREKEY_CANDIDATE_PAGE).toBeGreaterThanOrEqual(25);
    const firstTried: number[] = [];
    for (let run = 0; run < 32; run++) {
      const { queries, deletes, doc } = scriptedDoc([{ Items: page(PREKEY_CANDIDATE_PAGE) }]);
      const db = makeDataLayer(doc);
      await db.consumeOneTimePrekey(USER);
      expect(queries[0]!.input.Limit).toBe(PREKEY_CANDIDATE_PAGE);
      firstTried.push((deletes[0]!.input.Key as { keyId: number }).keyId);
    }
    // 32 draws from a page of 25: the chance every draw is keyId 1 is
    // (1/25)^32 — a deterministic lowest-first pick fails this every time.
    expect(new Set(firstTried).size).toBeGreaterThan(1);
  });

  it('a raced-away candidate falls through to another on the SAME page, then re-queries', async () => {
    let refusals = 0;
    const queries: QueryCommand[] = [];
    const send = async (cmd: unknown): Promise<unknown> => {
      if (cmd instanceof QueryCommand) {
        queries.push(cmd);
        return { Items: page(3) };
      }
      if (cmd instanceof DeleteCommand) {
        if (refusals < 5) {
          refusals += 1;
          throw Object.assign(new Error('raced'), { name: 'ConditionalCheckFailedException' });
        }
        return { Attributes: { keyId: 2, pub: 'QUJDMTIz' } };
      }
      return {};
    };
    const db = makeDataLayer({ send } as unknown as DynamoDBDocumentClient);
    expect(await db.consumeOneTimePrekey(USER)).toBeDefined();
    // Three candidates per page, five refusals: page one exhausted (3), page
    // two partly (2), the sixth attempt lands — two queries, never a bailout.
    expect(queries).toHaveLength(2);
  });
});

describe('the in-memory twin honours the generation the same way', () => {
  it('a consume or count against a stale generation answers nothing; the current one serves', async () => {
    const db = makeMemoryDb();
    await db.createUser({ userId: USER, createdAt: 1 });
    await db.storeKeys(
      USER,
      {
        registrationId: 1,
        identityKeyPub: 'ik',
        signedPrekey: { keyId: 1, pub: 'p', sig: 's' },
        kyberPrekey: { keyId: 2, pub: 'p', sig: 's' },
      },
      [{ keyId: 10, pub: 'p10' }],
    );
    const gen = (await db.getUserById(USER))?.prekeyPoolGen;
    expect(typeof gen).toBe('string');
    expect(await db.consumeOneTimePrekey(USER, 'stale-generation')).toBeUndefined();
    expect(await db.countOneTimePrekeys(USER, 'stale-generation')).toBe(0);
    expect(await db.countOneTimePrekeys(USER, gen)).toBe(1);
    expect(await db.consumeOneTimePrekey(USER, gen)).toEqual({ keyId: 10, pub: 'p10' });
    // A re-upload mints a NEW generation.
    await db.storeKeys(
      USER,
      {
        registrationId: 1,
        identityKeyPub: 'ik',
        signedPrekey: { keyId: 3, pub: 'p', sig: 's' },
        kyberPrekey: { keyId: 4, pub: 'p', sig: 's' },
      },
      [{ keyId: 11, pub: 'p11' }],
    );
    expect((await db.getUserById(USER))?.prekeyPoolGen).not.toBe(gen);
    expect(await db.consumeOneTimePrekey(USER, gen)).toBeUndefined();
  });
});
