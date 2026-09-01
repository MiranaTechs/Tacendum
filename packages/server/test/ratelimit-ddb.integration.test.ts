import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { DeleteCommand } from '@aws-sdk/lib-dynamodb';
import {
  CreateTableCommand,
  DeleteTableCommand,
  waitUntilTableExists,
  type DynamoDBClient,
} from '@aws-sdk/client-dynamodb';
import { TABLE_ENV_VARS } from '@tacendum/shared';
import { makeDocClient, makeDynamoClient } from '../src/db/client.js';
import { makeDdbRateLimiter } from '../src/ratelimit-ddb.js';
import type { RateLimiter } from '../src/ratelimit.js';

/**
 * The property the in-memory limiter cannot have and this one exists for
 * two limiter INSTANCES — two Lambda containers —
 * share one count. Runs against DynamoDB Local; skips when it is down unless
 * TACENDUM_REQUIRE_DDB=1 (same contract as the other integration suites).
 *
 * A PER-RUN TABLE, not the shared `tacendum_rate_buckets`. A release
 * run that exercised two suites against one DynamoDB Local
 * failed the shared-count test with the SECOND instance admitted — an
 * increment on this suite's pinned-window row went missing mid-test, in a
 * run where the same file passes alone every time (5/5 measured). The
 * per-run buckets were already collision-proof (pid + random below); what
 * remained shared was the TABLE — one name every gate, e2e server, and this
 * suite's own past runs write into, where the pinned-clock rows carry an
 * `expiresAt` years in the past and accumulate forever (DynamoDB Local
 * enforces no TTL, and sweep.ts deliberately does not cover rate buckets).
 * The limiter already reads its table name from the environment
 * (TACENDUM_TABLE_RATE_BUCKETS — how Lambda gets its CloudFormation name),
 * so this suite exercises that same seam: create a uniquely named table,
 * point the env var at it for the duration, drop it after. No assertion
 * changed; only the blast radius did.
 */

const REQUIRE = process.env.TACENDUM_REQUIRE_DDB === '1';
const OPTS = { capacity: 5, refillPerSec: 5 / 60 }; // 5 per 60s window

const RATE_TABLE = `tacendum_rate_buckets_it_${process.pid}_${randomBytes(4).toString('hex')}`;
const PREV_TABLE_ENV = process.env[TABLE_ENV_VARS.rateBuckets];

let client: DynamoDBClient;
let doc: DynamoDBDocumentClient;
let available = false;

/**
 * Distinct bucket per test, across PROCESSES as well as within one.
 *
 * `Date.now()` plus a per-module counter was not enough: vitest runs suites in
 * parallel workers, two of which can start in the same millisecond with the
 * same counter, mint the same key, and then share a token budget — so one
 * suite's takes exhausted another's window and the failure looked like a
 * limiter bug while landing on a different test each run. The pid and a random
 * suffix make a collision impossible rather than unlikely. Rows expire by TTL
 * in real AWS either way.
 */
let seq = 0;
function freshBucket(): string {
  return `test:${process.pid}:${Date.now()}:${randomBytes(4).toString('hex')}:${seq++}`;
}

beforeAll(async () => {
  client = makeDynamoClient();
  doc = makeDocClient(client);
  try {
    // Same shape as create-tables.ts gives the shared table; the limiter
    // needs only the partition key.
    await client.send(
      new CreateTableCommand({
        TableName: RATE_TABLE,
        BillingMode: 'PAY_PER_REQUEST',
        AttributeDefinitions: [{ AttributeName: 'bucket', AttributeType: 'S' }],
        KeySchema: [{ AttributeName: 'bucket', KeyType: 'HASH' }],
      }),
    );
    await waitUntilTableExists({ client, maxWaitTime: 30 }, { TableName: RATE_TABLE });
    // makeDdbRateLimiter resolves its table from the env ON EVERY take, so
    // this must be set before the first test and holds for all of them.
    process.env[TABLE_ENV_VARS.rateBuckets] = RATE_TABLE;
    available = true;
  } catch {
    available = false;
  }
  if (REQUIRE && !available) {
    throw new Error('TACENDUM_REQUIRE_DDB=1 but DynamoDB Local unavailable (create table failed)');
  }
}, 45000);

afterAll(async () => {
  if (PREV_TABLE_ENV === undefined) {
    delete process.env[TABLE_ENV_VARS.rateBuckets];
  } else {
    process.env[TABLE_ENV_VARS.rateBuckets] = PREV_TABLE_ENV;
  }
  if (!available) return;
  try {
    await client.send(new DeleteTableCommand({ TableName: RATE_TABLE }));
  } catch {
    // A leaked `tacendum_rate_buckets_it_*` table in DynamoDB Local is inert;
    // nothing else resolves its name. Not worth failing the suite over.
  }
}, 45000);

function gated(name: string, fn: () => Promise<void>): void {
  it(name, async (ctx) => {
    if (!available) return ctx.skip();
    await fn();
  });
}

describe('DDB fixed-window rate limiter', () => {
  gated('admits up to capacity in one window, then refuses with retry-after', async () => {
    const rl = makeDdbRateLimiter(doc);
    const bucket = freshBucket();
    for (let i = 0; i < OPTS.capacity; i++) {
      expect(await rl.take(bucket, OPTS)).toBe(0);
    }
    const retry = await rl.take(bucket, OPTS);
    expect(retry).toBeGreaterThan(0);
    expect(retry).toBeLessThanOrEqual(60);
  });

  gated('two instances share one count — the per-container hole is closed', async () => {
    // Two independent limiters over the same table simulate two Lambda
    // containers. In-memory, each would grant a full budget; here the SECOND
    // instance must be refused because the FIRST spent the window.
    // A FIXED clock, shared by both instances. The window is derived from the
    // clock, so on a loaded machine the six real round trips below could
    // straddle a boundary — the second instance would then be measuring a
    // FRESH window and be admitted, and the test would report "the
    // per-container hole is open" when the limiter was working perfectly.
    // That is a wall-clock dependency in the test, not a race in the code, and
    // it made this file fail differently on every heavily-parallel run.
    // Pinning the clock removes the timing from a property that was never
    // about timing: the point is that two INSTANCES share one count.
    const pinned = 1_700_000_000_000 - (1_700_000_000_000 % 60_000);
    const a: RateLimiter = makeDdbRateLimiter(doc, () => pinned);
    const b: RateLimiter = makeDdbRateLimiter(doc, () => pinned);
    const bucket = freshBucket();
    for (let i = 0; i < OPTS.capacity; i++) {
      expect(await a.take(bucket, OPTS)).toBe(0);
    }
    expect(await b.take(bucket, OPTS)).toBeGreaterThan(0);
  });

  gated('a new window resets the budget', async () => {
    // Injected clock: start exactly at a window boundary so the whole test
    // lives in known windows regardless of wall time.
    let t = 1_700_000_000_000 - (1_700_000_000_000 % 60_000);
    const rl = makeDdbRateLimiter(doc, () => t);
    const bucket = freshBucket();
    for (let i = 0; i < OPTS.capacity; i++) expect(await rl.take(bucket, OPTS)).toBe(0);
    expect(await rl.take(bucket, OPTS)).toBeGreaterThan(0);
    t += 60_000; // next window
    expect(await rl.take(bucket, OPTS)).toBe(0);
    // Cleanup the injected-clock rows (their TTL is far future relative to
    // the fake clock, not the real one).
    for (const w of [t - 60_000, t]) {
      await doc.send(
        new DeleteCommand({ TableName: RATE_TABLE, Key: { bucket: `${bucket}#${w}` } }),
      );
    }
  });

  gated('buckets are isolated', async () => {
    const rl = makeDdbRateLimiter(doc);
    const one = freshBucket();
    const other = freshBucket();
    for (let i = 0; i < OPTS.capacity; i++) expect(await rl.take(one, OPTS)).toBe(0);
    expect(await rl.take(one, OPTS)).toBeGreaterThan(0);
    expect(await rl.take(other, OPTS)).toBe(0);
  });
});
