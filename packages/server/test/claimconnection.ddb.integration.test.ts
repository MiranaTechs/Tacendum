import { randomBytes } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { ListTablesCommand } from '@aws-sdk/client-dynamodb';
import { TABLES } from '@tacendum/shared';
import { makeDocClient, makeDynamoClient } from '../src/db/client.js';
import { makeDataLayer, type DataLayer } from '../src/db/data.js';

/**
 * The connection claim, against REAL DynamoDB.
 *
 * The memory db mirrors this conditional, which is what keeps the handler
 * tests honest — but a mirror cannot prove the ConditionExpression itself is
 * right, and that expression is the whole arbitration. It is the only thing
 * standing between a one-shot `send` and a live listener's row: lose the race
 * and the listener keeps a socket it believes is connected while every message
 * queues to the 30-day TTL.
 *
 * Skips when DynamoDB Local is down unless TACENDUM_REQUIRE_DDB=1.
 */

const REQUIRE = process.env.TACENDUM_REQUIRE_DDB === '1';
let db: DataLayer;
let available = false;

const uid = (): string => `01CLAIM${randomBytes(9).toString('hex').toUpperCase().slice(0, 19)}`;

beforeAll(async () => {
  const client = makeDynamoClient();
  db = makeDataLayer(makeDocClient(client));
  try {
    const { TableNames = [] } = await client.send(new ListTablesCommand({}));
    available = TableNames.includes(TABLES.connections);
  } catch {
    available = false;
  }
  if (REQUIRE && !available) throw new Error('TACENDUM_REQUIRE_DDB=1 but DynamoDB Local is down');
});

function gated(name: string, fn: () => Promise<void>): void {
  it(name, async (ctx) => {
    if (!available) return ctx.skip();
    await fn();
  });
}

describe('claimConnection arbitrates inside the store', () => {
  gated('claims an absent row, and refuses once someone else holds it', async () => {
    const userId = uid();
    const now = Date.now();

    // Absent row, expecting absent: the listener wins it.
    expect(
      await db.claimConnection({ userId, connectionId: 'listener', connectedAt: now }, undefined),
    ).toBe(true);

    // A one-shot send that read "absent" from a stale replica and tries to
    // claim on that basis MUST lose — this is the exact eventual-consistency
    // sequence that unrouted a live listener.
    expect(
      await db.claimConnection({ userId, connectionId: 'oneshot', connectedAt: now }, undefined),
    ).toBe(false);
    expect((await db.getConnection(userId))?.connectionId).toBe('listener');
  });

  gated('claims when the row still names the connection that was probed', async () => {
    const userId = uid();
    const now = Date.now();
    await db.claimConnection({ userId, connectionId: 'dead', connectedAt: now }, undefined);

    // Probed 'dead', found it gone, replacing it: allowed.
    expect(
      await db.claimConnection({ userId, connectionId: 'fresh', connectedAt: now }, 'dead'),
    ).toBe(true);
    expect((await db.getConnection(userId))?.connectionId).toBe('fresh');

    // A second claimant carrying the SAME stale expectation is refused — the
    // row moved on while its probe was in flight.
    expect(
      await db.claimConnection({ userId, connectionId: 'late', connectedAt: now }, 'dead'),
    ).toBe(false);
    expect((await db.getConnection(userId))?.connectionId).toBe('fresh');
  });

  gated('exactly one of many concurrent claimants wins', async () => {
    const userId = uid();
    const now = Date.now();
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        db.claimConnection({ userId, connectionId: `c${i}`, connectedAt: now }, undefined),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    // And the row belongs to the one that reported success.
    const winner = `c${results.indexOf(true)}`;
    expect((await db.getConnection(userId))?.connectionId).toBe(winner);
  });
});
