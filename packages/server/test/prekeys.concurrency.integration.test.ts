import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ulid } from 'ulid';
import { DeleteCommand, QueryCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { TABLES, type OneTimePrekey, type PrekeyBundle } from '@tacendum/shared';
import { makeDocClient } from '../src/db/client.js';
import { makeDataLayer, type DataLayer } from '../src/db/data.js';
import { getPrekeyBundleHandler } from '../src/handlers/keys.js';
import type { AuthContext, Deps, HttpEvent } from '../src/handlers/http.js';

/**
 * Fire N parallel bundle fetches and assert no one-time
 * prekey is ever returned twice. Requires DynamoDB Local (the conditional
 * DeleteItem is what makes consumption atomic); skips if it is not reachable.
 */

const B64 = 'QUJDMTIz';
const createdUserIds: string[] = [];

let doc: DynamoDBDocumentClient;
let db: DataLayer;
let deps: Deps;
let available = false;

function makeDeps(dataLayer: DataLayer): Deps {
  return {
    db: dataLayer,
    now: () => Date.now(),
    newUserId: () => ulid(),
    newAuthToken: () => 'unused',
    newEmailCode: () => 'unused',
    newChallenge: () => randomBytes(32).toString('base64'),
    // Calls play no part in prekey atomicity; the honest degraded values.
    // Audience for auth-v2 signature binding this suite
    // never signs, but Deps requires the field — same origin makeTestDeps uses.
    apiOrigin: 'https://api.test.tacendum.com',
    turn: null,
    push: { wake: async () => 'failed' as const, notify: async () => 'failed' as const },
    // No-op limiter: this test exercises DB-level prekey-consumption atomicity,
    // not rate limiting (which is covered by ratelimit.test.ts).
    rateLimit: { take: async () => 0 },
    log: () => {},
    // Attachments are unexercised here (covered by attachments.test.ts).
    newAttachmentId: () => 'unused',
    newReportId: () => 'report-1',
    attachments: {
      uploadUrl: async () => 'https://unused.test',
      downloadUrl: async () => 'https://unused.test',
    },
  };
}

function prekeys(n: number): OneTimePrekey[] {
  return Array.from({ length: n }, (_, i) => ({ keyId: i + 1, pub: B64 }));
}

function bundleEvent(userId: string): HttpEvent {
  return { method: 'GET', path: '/', headers: {}, pathParameters: { userId } };
}

const caller: AuthContext = { userId: 'caller' };

/** Create a user with a full key bundle and `count` one-time prekeys. */
async function seedUser(count: number): Promise<string> {
  const userId = ulid();
  createdUserIds.push(userId);
  await db.createUser({ userId, createdAt: Date.now() });
  await db.storeKeys(
    userId,
    {
      registrationId: 7,
      identityKeyPub: B64,
      signedPrekey: { keyId: 1, pub: B64, sig: B64 },
      kyberPrekey: { keyId: 1, pub: B64, sig: B64 },
    },
    prekeys(count),
  );
  return userId;
}

beforeAll(async () => {
  doc = makeDocClient();
  db = makeDataLayer(doc);
  deps = makeDeps(db);
  try {
    await doc.send(
      new QueryCommand({
        TableName: TABLES.prekeys,
        KeyConditionExpression: 'userId = :u',
        ExpressionAttributeValues: { ':u': `probe-${ulid()}` },
        Limit: 1,
      }),
    );
    available = true;
  } catch {
    available = false;
    if (process.env.TACENDUM_REQUIRE_DDB === '1') {
      throw new Error('TACENDUM_REQUIRE_DDB=1 but DynamoDB Local is unreachable');
    }
    console.warn('[skip] DynamoDB Local not reachable; skipping concurrency test');
  }
});

afterAll(async () => {
  if (!available) return;
  for (const userId of createdUserIds) {
    const res = await doc.send(
      new QueryCommand({
        TableName: TABLES.prekeys,
        KeyConditionExpression: 'userId = :u',
        ExpressionAttributeValues: { ':u': userId },
      }),
    );
    for (const item of res.Items ?? []) {
      await doc.send(
        new DeleteCommand({ TableName: TABLES.prekeys, Key: { userId, keyId: item.keyId } }),
      );
    }
    await doc.send(new DeleteCommand({ TableName: TABLES.users, Key: { userId } }));
  }
});

describe('prekey consumption is atomic under concurrency', () => {
  it('N parallel fetches each get a distinct one-time prekey (no double hand-out)', async (ctx) => {
    if (!available) ctx.skip();
    const N = 40;
    const userId = await seedUser(N);

    const results = await Promise.all(
      Array.from({ length: N }, () => getPrekeyBundleHandler(bundleEvent(userId), deps, caller)),
    );

    const keyIds = results
      .map((r) => JSON.parse(r.body ?? '{}') as PrekeyBundle)
      .map((b) => b.oneTimePrekey?.keyId)
      .filter((k): k is number => k !== undefined);

    expect(keyIds).toHaveLength(N); // every fetch got one
    expect(new Set(keyIds).size).toBe(N); // all distinct — none handed out twice
    expect(await db.countOneTimePrekeys(userId)).toBe(0);
  }, 30_000);

  it('oversubscribed: more callers than prekeys -> exactly the pool is handed out once', async (ctx) => {
    if (!available) ctx.skip();
    const N = 10;
    const M = 30;
    const userId = await seedUser(N);

    const results = await Promise.all(
      Array.from({ length: M }, () => getPrekeyBundleHandler(bundleEvent(userId), deps, caller)),
    );

    const keyIds = results
      .map((r) => JSON.parse(r.body ?? '{}') as PrekeyBundle)
      .map((b) => b.oneTimePrekey?.keyId)
      .filter((k): k is number => k !== undefined);

    // All M requests succeed (200); exactly N of them carry a one-time prekey.
    expect(results.every((r) => r.statusCode === 200)).toBe(true);
    expect(keyIds).toHaveLength(N);
    expect(new Set(keyIds).size).toBe(N);
    expect(await db.countOneTimePrekeys(userId)).toBe(0);
  }, 30_000);
});
