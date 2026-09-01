import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { monotonicFactory } from 'ulid';
import {
  DeleteCommand,
  GetCommand,
  QueryCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { PrivateKey } from '@signalapp/libsignal-client';
import { authSignedBytes, TABLES, type AuthResponse } from '@tacendum/shared';
import { makeDocClient } from '../src/db/client.js';
import { IDKEY_CLAIM_PREFIX, makeDataLayer, type DataLayer } from '../src/db/data.js';
import { authChallengeHandler, authHandler } from '../src/handlers/auth-account.js';
import { getPrekeyBundleHandler, uploadKeysHandler } from '../src/handlers/keys.js';
import type { AuthContext, Deps, HttpEvent } from '../src/handlers/http.js';

/**
 * Hardening regressions — these only fail on REAL DynamoDB semantics
 * (conditional deletes, transactions, Put overwrite), so they run against
 * DynamoDB Local and skip if it is unreachable.
 */

const ulid = monotonicFactory();
const B64 = 'QUJDMTIz';
const REQUIRE = process.env.TACENDUM_REQUIRE_DDB === '1';

let doc: DynamoDBDocumentClient;
let db: DataLayer;
let available = false;
const cleanupUsers: string[] = [];
const cleanupIdentityKeys: string[] = [];
const cleanupTokens: string[] = [];

/** The audience these deps accept. Named once so `sign` and `makeDeps`
 * cannot drift — . */
const TEST_ORIGIN = 'https://api.test.tacendum.com';

function makeDeps(): Deps {
  let seq = 0;
  return {
    db,
    apiOrigin: TEST_ORIGIN,
    now: () => Date.now(),
    newUserId: () => ulid(),
    newAuthToken: () => `htok-${ulid()}-${seq++}`,
    newEmailCode: () => "000000",
    // Real 32-byte nonces: these tests drive genuine libsignal signatures.
    newChallenge: () => randomBytes(32).toString('base64'),
    // No-op limiter: these tests exercise DB atomicity (conditional deletes,
    // transactions), not rate limiting (covered by ratelimit.test.ts).
    rateLimit: { take: async () => 0 },
    log: () => {},
    // Calls are unexercised here; these are the honest unconfigured values.
    turn: null,
    push: { wake: async () => 'failed' as const, notify: async () => 'failed' as const },
    // Attachments are unexercised here (covered by attachments.test.ts).
    newAttachmentId: () => 'unused',
    newReportId: () => 'report-1',
    attachments: {
      uploadUrl: async () => 'https://unused.test',
      downloadUrl: async () => 'https://unused.test',
    },
  };
}

function post(body: unknown): HttpEvent {
  return { method: 'POST', path: '/', headers: {}, body: JSON.stringify(body) };
}
const caller: AuthContext = { userId: 'caller' };
function bundleEvent(userId: string): HttpEvent {
  return { method: 'GET', path: '/', headers: {}, pathParameters: { userId } };
}
function uploadBody(n: number, startId = 1) {
  return {
    registrationId: 5,
    identityKey: B64,
    signedPrekey: { keyId: 1, pub: B64, sig: B64 },
    kyberPrekey: { keyId: 1, pub: B64, sig: B64 },
    oneTimePrekeys: Array.from({ length: n }, (_, i) => ({ keyId: startId + i, pub: B64 })),
  };
}

beforeAll(async () => {
  doc = makeDocClient();
  db = makeDataLayer(doc);
  try {
    await doc.send(
      new QueryCommand({
        TableName: TABLES.sessions,
        KeyConditionExpression: '#t = :t',
        ExpressionAttributeNames: { '#t': 'token' },
        ExpressionAttributeValues: { ':t': `probe-${ulid()}` },
        Limit: 1,
      }),
    );
    available = true;
  } catch {
    if (REQUIRE) throw new Error('TACENDUM_REQUIRE_DDB=1 but DynamoDB Local is unreachable');
    console.warn('[skip] DynamoDB Local not reachable; skipping hardening integration tests');
  }
});

afterAll(async () => {
  if (!available) return;
  for (const userId of cleanupUsers) {
    // Drain any queued prekeys and message rows, then the user row.
    const pks = await doc.send(
      new QueryCommand({
        TableName: TABLES.prekeys,
        KeyConditionExpression: 'userId = :u',
        ExpressionAttributeValues: { ':u': userId },
      }),
    );
    for (const item of pks.Items ?? []) {
      await doc.send(
        new DeleteCommand({ TableName: TABLES.prekeys, Key: { userId, keyId: item.keyId } }),
      );
    }
    await doc.send(new DeleteCommand({ TableName: TABLES.users, Key: { userId } }));
  }
  for (const identityKey of cleanupIdentityKeys) {
    await doc.send(
      new DeleteCommand({ TableName: TABLES.sessions, Key: { token: `chal#${identityKey}` } }),
    );
    await doc.send(
      new DeleteCommand({
        TableName: TABLES.users,
        Key: { userId: `${IDKEY_CLAIM_PREFIX}${identityKey}` },
      }),
    );
  }
  for (const token of cleanupTokens) {
    await doc.send(new DeleteCommand({ TableName: TABLES.sessions, Key: { token } }));
  }
});

/**
 * A FRESH keypair per test, so no run can alias a historical row — the same
 * property the per-run unique phone number used to buy, and now free: an
 * identity key is 32 random bytes.
 *
 * Real libsignal keys, not fixtures. These tests drive `authHandler`, which
 * refuses to reach the atomicity being tested without a signature that
 * actually verifies.
 */
interface Identity {
  priv: PrivateKey;
  publicB64: string;
}

function uniqueIdentity(): Identity {
  const priv = PrivateKey.generate();
  const publicB64 = Buffer.from(priv.getPublicKey().serialize()).toString('base64');
  cleanupIdentityKeys.push(publicB64);
  return { priv, publicB64 };
}

/**
 * Exactly what the server verifies, via the SHARED builder rather than a local
 * copy of the format. Hand-rolling it here is how a test
 * ends up agreeing with a bug instead of catching it — the v1 audience defect
 * survived precisely because every test rebuilt the same omission.
 */
function sign(identity: Identity, challengeB64: string): string {
  const message = authSignedBytes(TEST_ORIGIN, challengeB64);
  return Buffer.from(identity.priv.sign(new Uint8Array(message))).toString('base64');
}

async function issueChallenge(identity: Identity, deps: Deps): Promise<string> {
  const res = await authChallengeHandler(post({ identityKey: identity.publicB64 }), deps);
  expect(res.statusCode).toBe(200);
  return (JSON.parse(res.body!) as { challenge: string }).challenge;
}

/** Full sign-in, recording the created account for cleanup. */
async function signIn(identity: Identity, deps: Deps): Promise<AuthResponse> {
  const challenge = await issueChallenge(identity, deps);
  const res = await authHandler(
    post({
      identityKey: identity.publicB64,
      challenge,
      signature: sign(identity, challenge),
    }),
    deps,
  );
  expect(res.statusCode).toBe(200);
  const body = JSON.parse(res.body!) as AuthResponse;
  cleanupUsers.push(body.userId);
  return body;
}

describe('auth challenge is single-use under concurrency', () => {
  it('N parallel auths with the same signed challenge -> exactly one session, one account', async (ctx) => {
    if (!available) ctx.skip();
    const deps = makeDeps();
    const me = uniqueIdentity();
    const challenge = await issueChallenge(me, deps);
    const signature = sign(me, challenge);

    // Every one of these carries a VALID signature, so nothing but the
    // conditional delete in consumeAuthChallengeIfMatches decides the winner.
    // A read-then-delete would let several through and mint several accounts —
    // this only fails on real DynamoDB semantics, which is why it lives here.
    const N = 12;
    const results = await Promise.all(
      Array.from({ length: N }, () =>
        authHandler(post({ identityKey: me.publicB64, challenge, signature }), deps),
      ),
    );
    const ok = results.filter((r) => r.statusCode === 200);
    expect(ok).toHaveLength(1); // only one auth may win
    const body = JSON.parse(ok[0]!.body!) as AuthResponse;
    cleanupUsers.push(body.userId);

    // And there is exactly one account for the key — resolved through the
    // claim row, because no role in this stack may Query the users table.
    const user = await db.getUserByIdentityKeyClaim(me.publicB64);
    expect(user?.userId).toBe(body.userId);
  }, 20_000);

  it('replay after a successful auth is rejected on real DynamoDB', async (ctx) => {
    if (!available) ctx.skip();
    const deps = makeDeps();
    const me = uniqueIdentity();
    const challenge = await issueChallenge(me, deps);
    const signature = sign(me, challenge);

    const first = await authHandler(
      post({ identityKey: me.publicB64, challenge, signature }),
      deps,
    );
    expect(first.statusCode).toBe(200);
    cleanupUsers.push((JSON.parse(first.body!) as AuthResponse).userId);

    // Same bytes, same valid signature — refused, because the nonce is spent.
    const replay = await authHandler(
      post({ identityKey: me.publicB64, challenge, signature }),
      deps,
    );
    expect(replay.statusCode).toBe(401);
  }, 20_000);

  it('two outstanding challenges for one key coexist, and each consumes exactly once (O9)', async (ctx) => {
    if (!available) ctx.skip();
    // Data-layer statement of the concurrent-challenge property, on real
    // DynamoDB keying: issuing must not overwrite the pending row (a clobber
    // primitive for anyone holding the public key), and re-keying per nonce
    // must not weaken the conditional-delete single-use guarantee.
    const identityKey = `itest-chal-${ulid()}`;
    const expiresAt = Math.floor(Date.now() / 1000) + 300;
    await db.putAuthChallenge({ identityKeyPub: identityKey, challenge: 'nonce-one', expiresAt });
    await db.putAuthChallenge({ identityKeyPub: identityKey, challenge: 'nonce-two', expiresAt });

    expect(await db.consumeAuthChallengeIfMatches(identityKey, 'nonce-one')).toBe(true);
    expect(await db.consumeAuthChallengeIfMatches(identityKey, 'nonce-one')).toBe(false); // spent
    expect(await db.consumeAuthChallengeIfMatches(identityKey, 'nonce-two')).toBe(true);
    expect(await db.consumeAuthChallengeIfMatches(identityKey, 'nonce-two')).toBe(false); // spent
  }, 20_000);

  it('idkey-claim rows exist in the users table but never resolve as identities', async (ctx) => {
    if (!available) ctx.skip();
    const deps = makeDeps();
    const me = uniqueIdentity();
    await signIn(me, deps);

    // The transactional claim item really is in the users table…
    const claimId = `${IDKEY_CLAIM_PREFIX}${me.publicB64}`;
    const raw = await doc.send(new GetCommand({ TableName: TABLES.users, Key: { userId: claimId } }));
    expect(raw.Item).toBeDefined();
    // …but the data layer must refuse to resolve it: otherwise any
    // authenticated caller could probe `idkey#<b64>` ids (WS send.to,
    // GET /v1/keys/{userId}) as an is-this-key-registered oracle, and queue
    // ciphertext to a recipientId nothing ever drains.
    expect(await db.getUserById(claimId)).toBeUndefined();
  }, 20_000);
});

describe('session tokens are hashed at rest', () => {
  it('the plaintext bearer token is never stored; getSession still resolves it', async (ctx) => {
    if (!available) ctx.skip();
    const deps = makeDeps();
    const { userId, authToken } = await signIn(uniqueIdentity(), deps);

    // No sessions row is keyed by the raw token.
    const raw = await doc.send(
      new GetCommand({ TableName: TABLES.sessions, Key: { token: authToken } }),
    );
    expect(raw.Item).toBeUndefined();

    // But the digest key exists, and getSession resolves the presented token.
    const digestKey = `sess:${createHash('sha256').update(authToken).digest('hex')}`;
    const stored = await doc.send(
      new GetCommand({ TableName: TABLES.sessions, Key: { token: digestKey } }),
    );
    expect(stored.Item?.userId).toBe(userId);
    cleanupTokens.push(digestKey);

    const session = await db.getSession(authToken);
    expect(session?.userId).toBe(userId);
  }, 20_000);
});

describe('key re-upload replaces the pool (no stale prekeys under a new identity)', () => {
  it('second upload clears the first pool', async (ctx) => {
    if (!available) ctx.skip();
    const deps = makeDeps();
    const me = uniqueIdentity();
    const { userId } = await signIn(me, deps);
    const auth: AuthContext = { userId };

    // The account's OWN key. The row carries identityKeyPub from birth and the
    // key is immutable, so uploading any other one is refused outright (409) —
    // and the pool would never be written, making this test fail for a reason
    // that has nothing to do with pool replacement.
    const body = (n: number, startId: number) => ({
      ...uploadBody(n, startId),
      identityKey: me.publicB64,
    });

    // Upload keyIds 1..5, then re-upload keyIds 100..102.
    expect((await uploadKeysHandler(post(body(5, 1)), deps, auth)).statusCode).toBe(204);
    expect(await db.countOneTimePrekeys(userId)).toBe(5);
    expect((await uploadKeysHandler(post(body(3, 100)), deps, auth)).statusCode).toBe(204);
    expect(await db.countOneTimePrekeys(userId)).toBe(3);

    // The bundle now only ever hands out keyIds from the new pool.
    const seen = new Set<number>();
    for (let i = 0; i < 3; i++) {
      const bundle = JSON.parse(
        (await getPrekeyBundleHandler(bundleEvent(userId), deps, caller)).body!,
      );
      if (bundle.oneTimePrekey) seen.add(bundle.oneTimePrekey.keyId);
    }
    for (const id of seen) expect(id).toBeGreaterThanOrEqual(100);
  }, 20_000);
});
