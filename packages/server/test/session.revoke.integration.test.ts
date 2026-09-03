import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { ulid } from 'ulid';
import { DescribeTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { SESSIONS_USER_INDEX, TABLES } from '@tacendum/shared';
import { makeDocClient } from '../src/db/client.js';
import { makeDataLayer, type DataLayer } from '../src/db/data.js';

/**
 * Session revocation against REAL DynamoDB. The unit tests use an in-memory
 * map, which cannot prove the part most likely to be wrong: that the
 * SESSIONS_USER_INDEX query finds a user's sessions, that KEYS_ONLY projects
 * enough to delete by, and that verification rows sharing the table (no
 * userId attribute) stay out of the index instead of being swept up.
 *
 * Requires DynamoDB Local; skips if it is not reachable, like the other
 * integration suites. TACENDUM_REQUIRE_DDB=1 turns a skip into a failure.
 */

const REQUIRE_DDB = process.env.TACENDUM_REQUIRE_DDB === '1';

let db: DataLayer;
let doc: ReturnType<typeof makeDocClient>;
let available = false;
let indexPresent = false;
const created: string[] = [];

beforeAll(async () => {
  doc = makeDocClient();
  db = makeDataLayer(doc);
  const raw = new DynamoDBClient({
    region: process.env.AWS_REGION ?? 'us-east-1',
    endpoint: process.env.DDB_ENDPOINT ?? 'http://localhost:8000',
    credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
  });
  try {
    const desc = await raw.send(new DescribeTableCommand({ TableName: TABLES.sessions }));
    available = true;
    indexPresent = (desc.Table?.GlobalSecondaryIndexes ?? []).some(
      (i) => i.IndexName === SESSIONS_USER_INDEX,
    );
  } catch {
    available = false;
  }
  if (REQUIRE_DDB && !available) throw new Error('DynamoDB Local required but unreachable');
  if (REQUIRE_DDB && !indexPresent) {
    throw new Error(`${SESSIONS_USER_INDEX} missing — re-run pnpm tables:create on a fresh table`);
  }
});

afterAll(async () => {
  for (const token of created) {
    await db.deleteSession(token).catch(() => {});
  }
});

/** A real token shaped like the ones verify mints (32 bytes, base64url). */
function newToken(): string {
  const t = randomBytes(32).toString('base64url');
  created.push(t);
  return t;
}

async function issue(userId: string): Promise<string> {
  const token = newToken();
  await db.createSession({
    token,
    userId,
    createdAt: Date.now(),
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  });
  return token;
}

// Every case skips itself (ctx.skip) when DynamoDB Local or the index is
// absent — a visible skip, never a silent pass.
describe('deleteSessionsForUser against DynamoDB', () => {
  it('finds and deletes a user’s sessions through the index, sparing the caller', async (ctx) => {
    if (!available || !indexPresent) return ctx.skip();
    const user = ulid();
    const keep = await issue(user);
    const a = await issue(user);
    const b = await issue(user);

    const revoked = await db.deleteSessionsForUser(user, keep);

    expect(revoked).toBe(2);
    expect(await db.getSession(a)).toBeUndefined();
    expect(await db.getSession(b)).toBeUndefined();
    expect(await db.getSession(keep)).toBeDefined();
  });

  it('deletes all of them when no token is spared (account deletion)', async (ctx) => {
    if (!available || !indexPresent) return ctx.skip();
    const user = ulid();
    const a = await issue(user);
    const b = await issue(user);

    const revoked = await db.deleteSessionsForUser(user);

    expect(revoked).toBe(2);
    expect(await db.getSession(a)).toBeUndefined();
    expect(await db.getSession(b)).toBeUndefined();
  });

  it('never reaches another user’s sessions', async (ctx) => {
    if (!available || !indexPresent) return ctx.skip();
    const mine = ulid();
    const theirs = ulid();
    await issue(mine);
    const survivor = await issue(theirs);

    await db.deleteSessionsForUser(mine);

    expect(await db.getSession(survivor)).toBeDefined();
  });

  it('leaves pending auth-challenge rows in the same table untouched', async (ctx) => {
    if (!available || !indexPresent) return ctx.skip();
    // Auth challenges live in the sessions table keyed chal#<digest of
    // (identityKey, nonce)> and deliberately carry NO userId, so DynamoDB
    // leaves them out of the user-index entirely. That omission is load-bearing rather than
    // incidental: give the row a userId and every sign-in's session sweep
    // would batch-delete live challenges, breaking sign-in for anyone
    // mid-flight. This was the same assertion against pending SMS codes until
    // replaced them; the row it guards changed, the
    // hazard did not.
    const identityKey = `test-idkey-${ulid()}`;
    const challenge = 'Y2hhbGxlbmdlLWZpeHR1cmU=';
    await db.putAuthChallenge({
      identityKeyPub: identityKey,
      challenge,
      expiresAt: Math.floor(Date.now() / 1000) + 300,
    });
    const user = ulid();
    await issue(user);

    await db.deleteSessionsForUser(user);

    const still = await db.getAuthChallenge(identityKey, challenge);
    expect(still?.challenge).toBe(challenge);
    await db.consumeAuthChallengeIfMatches(identityKey, challenge);
  });

  it('is idempotent — a second sweep finds nothing and reports zero', async (ctx) => {
    if (!available || !indexPresent) return ctx.skip();
    const user = ulid();
    await issue(user);
    expect(await db.deleteSessionsForUser(user)).toBe(1);
    expect(await db.deleteSessionsForUser(user)).toBe(0);
  });
});
