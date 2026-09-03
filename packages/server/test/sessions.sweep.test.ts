import { describe, expect, it } from 'vitest';
import { BatchWriteCommand, QueryCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { SESSIONS_USER_INDEX } from '@tacendum/shared';
import { SESSION_SWEEP_RECHECK_MS, makeDataLayer, sessionTokenDigest } from '../src/db/data.js';
import { TABLES } from '../src/db/tables.js';

/**
 * The session sweep, and the absent-row refusal beside it.
 *
 * `deleteSessionsForUser` walks SESSIONS_USER_INDEX, a global secondary index,
 * and a GSI cannot be read consistently: a session row written inside its
 * propagation window is invisible to the walk and SURVIVES the revoke. On the
 * paths this runs on — sign-out-others, a superseding sign-in, account
 * deletion, integration revoke — a session that young is exactly the
 * attacker's fresh sign-in. The store now walks the index twice with a pause
 * between, unconditionally.
 *
 * Asserted against a SCRIPTED document client rather than DynamoDB Local,
 * because Local is one process with no replicas: its index is always current,
 * so no behavioural test there can produce the lag this exists for. What can
 * be pinned is the shape of the store's requests — two walks, a pause at least
 * the documented length between them, and every key either walk returned
 * deleted (the spared one excepted). */
describe('deleteSessionsForUser walks the index twice', () => {
  const USER = '01KYDBSSDJSPC9J0E5N2AWMJ5Y';
  const key = (token: string) => `sess:${sessionTokenDigest(token)}`;

  /** A doc client that answers each index Query from `pages` in order and
   * records every BatchWrite. */
  function scripted(pages: string[][]) {
    const queries: QueryCommand[] = [];
    const deletes: string[] = [];
    const timestamps: number[] = [];
    const send = async (command: object): Promise<unknown> => {
      if (command instanceof QueryCommand) {
        queries.push(command);
        timestamps.push(Date.now());
        const page = pages[queries.length - 1] ?? [];
        return { Items: page.map((token) => ({ token })) };
      }
      if (command instanceof BatchWriteCommand) {
        const reqs = command.input.RequestItems?.[TABLES.sessions] ?? [];
        for (const r of reqs) deletes.push(String(r.DeleteRequest?.Key?.token));
        return {};
      }
      throw new Error(`unexpected command ${command.constructor.name}`);
    };
    return {
      queries,
      deletes,
      timestamps,
      db: makeDataLayer({ send } as unknown as DynamoDBDocumentClient),
    };
  }

  it('sweeps a row the first walk could not see, after the documented pause', async () => {
    // Pass 1 sees the stale view (one old session); pass 2 sees the row that
    // propagated in between.
    const { db, queries, deletes, timestamps } = scripted([[key('old')], [key('lagging')]]);

    const revoked = await db.deleteSessionsForUser(USER);

    expect(revoked).toBe(2);
    expect(queries).toHaveLength(2);
    for (const q of queries) {
      expect(q.input).toMatchObject({
        TableName: TABLES.sessions,
        IndexName: SESSIONS_USER_INDEX,
        ExpressionAttributeValues: { ':u': USER },
      });
    }
    expect(deletes).toEqual([key('old'), key('lagging')]);
    expect(timestamps[1]! - timestamps[0]!).toBeGreaterThanOrEqual(SESSION_SWEEP_RECHECK_MS - 5);
  });

  it('walks twice even when the first walk finds nothing — an empty first pass is no evidence', async () => {
    const { db, queries, deletes } = scripted([[], [key('lagging')]]);

    const revoked = await db.deleteSessionsForUser(USER);

    expect(revoked).toBe(1);
    expect(queries).toHaveLength(2);
    expect(deletes).toEqual([key('lagging')]);
  });

  it('spares the caller’s own token on BOTH walks (the supersede and sign-out-others shape)', async () => {
    // The caller's just-minted row may itself only propagate by the second
    // walk; it must be spared wherever it shows up.
    const { db, deletes } = scripted([[key('old')], [key('mine'), key('lagging')]]);

    const revoked = await db.deleteSessionsForUser(USER, 'mine');

    expect(revoked).toBe(2);
    expect(deletes).toEqual([key('old'), key('lagging')]);
  });

  it('writes nothing when neither walk names a row', async () => {
    const { db, queries, deletes } = scripted([[], []]);

    expect(await db.deleteSessionsForUser(USER)).toBe(0);
    expect(queries).toHaveLength(2);
    expect(deletes).toEqual([]);
  });
});
