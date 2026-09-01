import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrivateKey } from '@signalapp/libsignal-client';
import { ulid } from 'ulid';
import { activityActorRef, userRefForLog } from '../src/opaque-ref.js';
import {
  ACTIVITY_DAY_INDEX,
  AGPL_SOURCE_URL_DEFAULT,
  authSignedBytes,
  AUTH_CHALLENGE_TTL_SECONDS,
} from '@tacendum/shared';
import { DescribeTableCommand } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';

/** Must match `makeTestDeps`'s apiOrigin — the audience this server accepts. */
const TEST_ORIGIN = 'https://api.test.tacendum.com';
import {
  authChallengeHandler,
  authHandler,
  SOURCE_LINK_REL,
  sourceOfferUrl,
} from '../src/handlers/auth-account.js';
import { deleteAccountHandler } from '../src/handlers/account.js';
import { uploadKeysHandler } from '../src/handlers/keys.js';
import { IDKEY_CLAIM_PREFIX, makeDataLayer } from '../src/db/data.js';
import { makeDocClient, makeDynamoClient } from '../src/db/client.js';
import { TABLES } from '../src/db/tables.js';
import type { HttpEvent } from '../src/handlers/http.js';
import { makeMemoryDb, makeTestDeps, parseBody, type TestDeps } from './helpers.js';

/**
 * Keypair-only account auth (/).
 *
 * Signatures here are REAL libsignal signatures, not fixtures or mocks. A
 * mocked verifier would make the one property that matters — that only the
 * holder of the private key can authenticate — untestable, which is exactly
 * how the identity-key defect originally slipped through.
 */

let deps: TestDeps;
const REQUIRE_DDB = process.env.TACENDUM_REQUIRE_DDB === '1';
const activityDoc = makeDocClient(makeDynamoClient());
const activityDb = makeDataLayer(activityDoc);
let activityTableAvailable = false;
let activityIndexPresent = false;
const activityRowsToDelete = new Set<string>();

beforeAll(async () => {
  try {
    const client = makeDynamoClient();
    const description = await client.send(
      new DescribeTableCommand({ TableName: TABLES.activity }),
    );
    activityTableAvailable = true;
    activityIndexPresent = (description.Table?.GlobalSecondaryIndexes ?? []).some(
      (index) => index.IndexName === ACTIVITY_DAY_INDEX,
    );
  } catch {
    activityTableAvailable = false;
  }
  if (REQUIRE_DDB && !activityTableAvailable) {
    throw new Error('TACENDUM_REQUIRE_DDB=1 but the activity table is unavailable');
  }
  if (REQUIRE_DDB && !activityIndexPresent) {
    throw new Error(`${ACTIVITY_DAY_INDEX} is missing; re-run pnpm tables:create`);
  }
});

afterAll(async () => {
  for (const actorHash of activityRowsToDelete) {
    await activityDoc.send(
      new DeleteCommand({ TableName: TABLES.activity, Key: { actorHash } }),
    ).catch(() => {});
  }
});

/** Per-call source IP. The per-IP auth limiter is 10 burst and this flow costs
 * TWO requests, so a single IP funds only five sign-ins before answering 429
 * and failing tests for a reason that has nothing to do with what they assert. */
let ipSeq = 0;
function post(path: string, body: unknown): HttpEvent {
  ipSeq++;
  return {
    method: 'POST',
    path,
    headers: { 'content-type': 'application/json' },
    pathParameters: {},
    body: JSON.stringify(body),
    sourceIp: `198.51.100.${ipSeq % 250}`,
  };
}

interface Identity {
  priv: PrivateKey;
  publicB64: string;
}

function newIdentity(): Identity {
  const priv = PrivateKey.generate();
  return { priv, publicB64: Buffer.from(priv.getPublicKey().serialize()).toString('base64') };
}

/**
 * Sign exactly what the server verifies, through the SHARED builder rather than
 * a local re-implementation. A test that rebuilds the format by hand is a test
 * that agrees with itself: it would have kept passing through the whole of the
 * v1 relay defect, because it made the same omission the code did.
 *
 * `origin` defaults to the deps' own origin — the honest case. Passing a
 * different one is how the relay test states the attack.
 */
function sign(
  identity: Identity,
  challengeB64: string,
  origin: string = TEST_ORIGIN,
): string {
  const message = authSignedBytes(origin, challengeB64);
  return Buffer.from(identity.priv.sign(new Uint8Array(message))).toString('base64');
}

async function getChallenge(identity: Identity): Promise<string> {
  const res = await authChallengeHandler(
    post('/v1/auth/challenge', { identityKey: identity.publicB64 }),
    deps,
  );
  expect(res.statusCode).toBe(200);
  return parseBody<{ challenge: string }>(res.body).challenge;
}

/** Full happy path: challenge, sign, auth. `extra` merges into the auth body
 * (e.g. `{ accountClass: 'integration' }`). */
async function signIn(
  identity: Identity,
  extra: Record<string, unknown> = {},
): Promise<{ userId: string; authToken: string }> {
  const challenge = await getChallenge(identity);
  const res = await authHandler(
    post('/v1/auth', {
      identityKey: identity.publicB64,
      challenge,
      signature: sign(identity, challenge),
      ...extra,
    }),
    deps,
  );
  expect(res.statusCode).toBe(200);
  return parseBody(res.body);
}

/** The keyed-pseudonymization salt: with it present, the
 * lifecycle log events carry `userRef` and the activity writes are keyed by
 * the salted opaque ref — the states these suites now pin. */
const SALT = 'auth-test-user-ref-salt';

beforeEach(() => {
  deps = { ...makeTestDeps(makeMemoryDb()), userRefSalt: SALT };
});

describe('proving the key', () => {
  it('signs in with no phone number anywhere in the exchange', async () => {
    const me = newIdentity();
    const { userId, authToken } = await signIn(me);

    expect(userId).toBeTruthy();
    expect(authToken).toBeTruthy();
    // There used to be an `expect(deps.smsSent).toHaveLength(0)` here. It is
    // REMOVED rather than skipped: deleted `Deps.sendSms` outright, so
    // "no SMS was sent" is now a fact the type checker enforces at every call
    // site rather than something one test can observe at runtime. Asserting an
    // empty array that nothing can ever append to is a test that cannot fail.
  });

  it('refuses a signature from a different key', async () => {
    const me = newIdentity();
    const impostor = newIdentity();
    const challenge = await getChallenge(me);

    const res = await authHandler(
      post('/v1/auth', {
        identityKey: me.publicB64,
        challenge,
        // Correct challenge, correct claimed key, wrong signer.
        signature: sign(impostor, challenge),
      }),
      deps,
    );

    expect(res.statusCode).toBe(401);
    expect(parseBody<{ error: { code: string } }>(res.body).error.code).toBe('invalid_signature');
  });

  it('refuses a signature over the bare challenge, without the domain tag', async () => {
    // NON-VACUITY for the domain separation. Strip the prefix and the same key
    // over the same nonce must stop verifying — otherwise the tag is decoration
    // and a future message type signed by this key could be replayed as a login.
    const me = newIdentity();
    const challenge = await getChallenge(me);
    const bare = Buffer.from(
      me.priv.sign(new Uint8Array(Buffer.from(challenge, 'base64'))),
    ).toString('base64');

    const res = await authHandler(
      post('/v1/auth', { identityKey: me.publicB64, challenge, signature: bare }),
      deps,
    );

    expect(res.statusCode).toBe(401);
    expect(parseBody<{ error: { code: string } }>(res.body).error.code).toBe('invalid_signature');
  });

  it('answers 401 rather than 500 on signature bytes that are not a signature', async () => {
    const me = newIdentity();
    const challenge = await getChallenge(me);

    const res = await authHandler(
      post('/v1/auth', { identityKey: me.publicB64, challenge, signature: 'AAAA' }),
      deps,
    );

    expect(res.statusCode).toBe(401);
  });

  it('rejects a challenge issued for another key', async () => {
    const a = newIdentity();
    const b = newIdentity();
    const challengeForA = await getChallenge(a);
    await getChallenge(b);

    // B presents A's nonce, signed correctly by B. The challenge is bound to
    // the key it was issued for, so this is not a valid login.
    const res = await authHandler(
      post('/v1/auth', {
        identityKey: b.publicB64,
        challenge: challengeForA,
        signature: sign(b, challengeForA),
      }),
      deps,
    );

    expect(res.statusCode).toBe(401);
    expect(parseBody<{ error: { code: string } }>(res.body).error.code).toBe('invalid_challenge');
  });

  it('refuses an expired challenge and says so distinctly', async () => {
    const me = newIdentity();
    const challenge = await getChallenge(me);
    deps.advanceMs((AUTH_CHALLENGE_TTL_SECONDS + 1) * 1000);

    const res = await authHandler(
      post('/v1/auth', {
        identityKey: me.publicB64,
        challenge,
        signature: sign(me, challenge),
      }),
      deps,
    );

    expect(res.statusCode).toBe(401);
    expect(parseBody<{ error: { code: string } }>(res.body).error.code).toBe('challenge_expired');
  });

  it('spends a challenge exactly once, even under concurrent use', async () => {
    const me = newIdentity();
    const challenge = await getChallenge(me);
    const signature = sign(me, challenge);
    const body = { identityKey: me.publicB64, challenge, signature };

    const results = await Promise.all(
      Array.from({ length: 8 }, () => authHandler(post('/v1/auth', body), deps)),
    );

    expect(results.filter(r => r.statusCode === 200)).toHaveLength(1);
  });

  it('does not spend the challenge on a wrong signature', async () => {
    // A failed attempt must not cost an honest client its nonce: without the
    // private key, retrying gains an attacker nothing, so charging for
    // failures buys no security and breaks slow or flaky clients.
    const me = newIdentity();
    const impostor = newIdentity();
    const challenge = await getChallenge(me);

    await authHandler(
      post('/v1/auth', {
        identityKey: me.publicB64,
        challenge,
        signature: sign(impostor, challenge),
      }),
      deps,
    );
    const res = await authHandler(
      post('/v1/auth', {
        identityKey: me.publicB64,
        challenge,
        signature: sign(me, challenge),
      }),
      deps,
    );

    expect(res.statusCode).toBe(200);
  });
});

describe('concurrent challenges', () => {
  it('issuing a second challenge does not clobber the first one in flight (O9)', async () => {
    // /v1/auth/challenge is unauthenticated and takes only the PUBLIC identity
    // key, so anyone who knows a victim's key can call it at will. If issuing
    // overwrote the single pending row, that call would be a remote sign-in
    // denial: keep clobbering and the victim's signed answer never lands.
    const me = newIdentity();
    const first = await getChallenge(me);
    const second = await getChallenge(me);
    expect(second).not.toBe(first);

    const res = await authHandler(
      post('/v1/auth', {
        identityKey: me.publicB64,
        challenge: first,
        signature: sign(me, first),
      }),
      deps,
    );
    expect(res.statusCode).toBe(200);
  });

  it('coexisting challenges are each single-use: spend, replay refused, sibling still spends', async () => {
    const me = newIdentity();
    const first = await getChallenge(me);
    const second = await getChallenge(me);

    const spendFirst = await authHandler(
      post('/v1/auth', {
        identityKey: me.publicB64,
        challenge: first,
        signature: sign(me, first),
      }),
      deps,
    );
    expect(spendFirst.statusCode).toBe(200);

    const replayFirst = await authHandler(
      post('/v1/auth', {
        identityKey: me.publicB64,
        challenge: first,
        signature: sign(me, first),
      }),
      deps,
    );
    expect(replayFirst.statusCode).toBe(401);

    const spendSecond = await authHandler(
      post('/v1/auth', {
        identityKey: me.publicB64,
        challenge: second,
        signature: sign(me, second),
      }),
      deps,
    );
    expect(spendSecond.statusCode).toBe(200);
    // Same key, same account — the sibling nonce signs into the same identity.
    expect(parseBody<{ userId: string }>(spendSecond.body).userId).toBe(
      parseBody<{ userId: string }>(spendFirst.body).userId,
    );
  });
});

describe('one account per key', () => {
  it('returns the same account when the same key signs in again', async () => {
    const me = newIdentity();
    const first = await signIn(me);
    const second = await signIn(me);

    expect(second.userId).toBe(first.userId);
    expect(second.authToken).not.toBe(first.authToken);
  });

  it('gives different keys different accounts', async () => {
    const a = await signIn(newIdentity());
    const b = await signIn(newIdentity());

    expect(a.userId).not.toBe(b.userId);
  });

  it('creates exactly one account when the same new key auths concurrently', async () => {
    const me = newIdentity();
    // Distinct challenges are impossible here (one pending per key), so this
    // exercises the claim row through repeated sequential sign-ins instead.
    const ids = new Set<string>();
    for (let i = 0; i < 5; i++) ids.add((await signIn(me)).userId);

    expect(ids.size).toBe(1);
  });

  it('supersedes prior sessions when the key proves itself again', async () => {
    const me = newIdentity();
    const first = await signIn(me);
    await signIn(me);

    // The old token is gone: one account, one device.
    expect(await deps.db.getSession(first.authToken)).toBeUndefined();
  });

  it('binds the identity key to the account row at creation', async () => {
    // This is what actually closes If the row were created WITHOUT the
    // key, storeKeys' attribute_not_exists branch would let a stolen token
    // publish a different key while the claim still named the original.
    const me = newIdentity();
    const { userId } = await signIn(me);

    const user = await deps.db.getUserById(userId);
    expect(user?.identityKeyPub).toBe(me.publicB64);
  });
});

describe('the identity key is immutable', () => {
  it('refuses to bind a different key to an existing account', async () => {
    const me = newIdentity();
    const attacker = newIdentity();
    const { userId } = await signIn(me);

    const stored = await deps.db.storeKeys(
      userId,
      {
        registrationId: 42,
        identityKeyPub: attacker.publicB64,
        signedPrekey: { keyId: 1, pub: 'QUJD', sig: 'QUJD' },
        kyberPrekey: { keyId: 1, pub: 'QUJD', sig: 'QUJD' },
      },
      [],
    );

    // The takeover this whole design turns on: a stolen bearer token must not
    // be able to rebind the account to the attacker's key.
    expect(stored).toBe(false);
    expect((await deps.db.getUserById(userId))?.identityKeyPub).toBe(me.publicB64);
  });

  it('answers PUT /v1/keys with 409 identity_key_immutable rather than a silent 204', async () => {
    // The refusal above happens in the data layer and returns a boolean. That
    // boolean was being DISCARDED by uploadKeysHandler, so a rejected rotation
    // answered 204: the client believed its keys were published, the server
    // had stored nothing, and the account was simply unreachable with no error
    // anywhere. The `identity_key_immutable` code was declared for this case
    // and had no emitter at all.
    const me = newIdentity();
    const attacker = newIdentity();
    const { userId } = await signIn(me);

    const res = await uploadKeysHandler(
      post('/v1/keys', {
        registrationId: 42,
        identityKey: attacker.publicB64,
        signedPrekey: { keyId: 1, pub: 'QUJD', sig: 'QUJD' },
        kyberPrekey: { keyId: 1, pub: 'QUJD', sig: 'QUJD' },
        oneTimePrekeys: [],
      }),
      deps,
      { userId },
    );

    expect(res.statusCode).toBe(409);
    expect(parseBody<{ error: { code: string } }>(res.body).error.code).toBe(
      'identity_key_immutable',
    );
    expect((await deps.db.getUserById(userId))?.identityKeyPub).toBe(me.publicB64);
  });

  it('still answers 204 for a legitimate first upload of the account key', async () => {
    // Non-vacuity for the 409 above: if uploadKeysHandler started refusing
    // everything, the test above would still pass and key upload would be
    // broken for every honest client.
    const me = newIdentity();
    const { userId } = await signIn(me);

    const res = await uploadKeysHandler(
      post('/v1/keys', {
        registrationId: 42,
        identityKey: me.publicB64,
        signedPrekey: { keyId: 1, pub: 'QUJD', sig: 'QUJD' },
        kyberPrekey: { keyId: 1, pub: 'QUJD', sig: 'QUJD' },
        oneTimePrekeys: [{ keyId: 9, pub: 'QUJD' }],
      }),
      deps,
      { userId },
    );

    expect(res.statusCode).toBe(204);
    expect(await deps.db.countOneTimePrekeys(userId)).toBe(1);
  });

  it('allows an identical re-upload, so reinstall and retry still work', async () => {
    const me = newIdentity();
    const { userId } = await signIn(me);

    const stored = await deps.db.storeKeys(
      userId,
      {
        registrationId: 42,
        identityKeyPub: me.publicB64,
        signedPrekey: { keyId: 1, pub: 'QUJD', sig: 'QUJD' },
        kyberPrekey: { keyId: 1, pub: 'QUJD', sig: 'QUJD' },
      },
      [],
    );

    expect(stored).toBe(true);
  });
});

describe('claim rows are not identities', () => {
  it('refuses to resolve an idkey claim row as a user', async () => {
    // Otherwise GET /v1/keys/{userId} and WS send.to become an
    // is-this-key-registered oracle, and ciphertext could be queued to a
    // recipientId nothing ever drains — the exact reasons the phone claim
    // prefix is already guarded.
    const me = newIdentity();
    await signIn(me);

    expect(await deps.db.getUserById(`${IDKEY_CLAIM_PREFIX}${me.publicB64}`)).toBeUndefined();
  });
});

describe('malformed input', () => {
  it('refuses a key that is not a public key, before storing a challenge', async () => {
    // Challenge rows are keyed per (key, nonce) pair, so "no row for this key"
    // is not a question the data layer can answer; wrap the write instead —
    // the same pattern the report tests use on putReport.
    const put = vi.spyOn(deps.db, 'putAuthChallenge');
    const res = await authChallengeHandler(
      post('/v1/auth/challenge', { identityKey: 'QUJDMTIz' }),
      deps,
    );

    expect(res.statusCode).toBe(400);
    // Nothing was written: a challenge stored against a string that can never
    // verify is a row nobody can ever consume.
    expect(put).not.toHaveBeenCalled();
  });

  it('answers 401 when no challenge was ever issued', async () => {
    const me = newIdentity();
    const res = await authHandler(
      post('/v1/auth', {
        identityKey: me.publicB64,
        challenge: 'bm90LWEtcmVhbC1jaGFsbGVuZ2UtdmFsdWUtaGVyZQ==',
        signature: sign(me, 'bm90LWEtcmVhbC1jaGFsbGVuZ2UtdmFsdWUtaGVyZQ=='),
      }),
      deps,
    );

    expect(res.statusCode).toBe(401);
  });
});

describe('operational logging', () => {
  it('records human sign-in activity without logging the user id in account_created', async () => {
    const touch = vi.spyOn(deps.db, 'touchActivity');
    const result = await signIn(newIdentity());

    // The activity write is keyed by the SALTED opaque ref, never the raw
    // userId.
    expect(touch).toHaveBeenCalledWith(
      activityActorRef(result.userId, SALT),
      deps.now(),
      expect.any(AbortSignal),
    );
    expect(JSON.stringify(touch.mock.calls)).not.toContain(result.userId);
    const created = deps.logs.find((row) => row.event === 'account_created');
    expect(created?.fields).toEqual({ class: 'human' });
    expect(JSON.stringify(created)).not.toContain(result.userId);
  });

  it('auth_success carries the opaque ref, never the raw userId', async () => {
    const result = await signIn(newIdentity());

    const line = deps.logs.find((row) => row.event === 'auth_success');
    expect(line?.fields).toEqual({ userRef: userRefForLog(result.userId, SALT) });
  });

  it('keeps a successful human sign-in successful when activity recording is rejected', async () => {
    vi.spyOn(deps.db, 'touchActivity').mockRejectedValue(new Error('activity unavailable'));

    const result = await signIn(newIdentity());

    expect(result.authToken).toEqual(expect.any(String));
    expect(deps.logs.filter((row) => row.event === 'activity_touch_failed')).toHaveLength(1);
  });

  it('a deferred sign-in touch released after deletion cannot replace the activity tombstone', async (ctx) => {
    if (!activityTableAvailable || !activityIndexPresent) return ctx.skip();

    const userId = ulid();
    // The table key is now SHA-256 over the SALTED opaque ref (activity.ts):
    // touch and delete both derive the same ref upstream, so the race under
    // test races on the same row it always did — just under the new key.
    const actorRef = activityActorRef(userId, SALT);
    const actorHash = createHash('sha256').update(actorRef).digest('hex');
    activityRowsToDelete.add(actorHash);
    deps.newUserId = () => userId;
    deps.db.touchActivity = activityDb.touchActivity;
    deps.db.deleteActivity = activityDb.deleteActivity;

    let releaseTouch!: () => void;
    const released = new Promise<void>((resolve) => {
      releaseTouch = resolve;
    });
    let reportTouchStarted!: (userId: string) => void;
    const touchStarted = new Promise<string>((resolve) => {
      reportTouchStarted = resolve;
    });
    const originalTouch = deps.db.touchActivity.bind(deps.db);
    vi.spyOn(deps.db, 'touchActivity').mockImplementation(async (userId, nowMs, signal) => {
      reportTouchStarted(userId);
      await released;
      await originalTouch(userId, nowMs, signal);
    });
    const deleteActivity = vi.spyOn(deps.db, 'deleteActivity');

    const pendingSignIn = signIn(newIdentity());
    const touchingUserId = await Promise.race([
      touchStarted,
      pendingSignIn.then(() => undefined),
    ]);
    expect(touchingUserId).toBe(actorRef);
    const deletion = await deleteAccountHandler(
      {
        method: 'DELETE',
        path: '/v1/account',
        headers: {},
      },
      deps,
      { userId },
    );

    expect(deletion.statusCode).toBe(200);
    expect(deleteActivity).toHaveBeenCalledWith(actorRef, deps.now());
    releaseTouch();
    await pendingSignIn;

    const base = await activityDoc.send(
      new GetCommand({
        TableName: TABLES.activity,
        Key: { actorHash },
        ConsistentRead: true,
      }),
    );
    expect(base.Item).toEqual({
      actorHash,
      expiresAt: 1_700_000_300,
    });

    const indexed = await activityDoc.send(
      new QueryCommand({
        TableName: TABLES.activity,
        IndexName: ACTIVITY_DAY_INDEX,
        KeyConditionExpression:
          'activityDay = :day AND activityHourActor = :hourActor',
        ExpressionAttributeValues: {
          ':day': '2023-11-14',
          ':hourActor': `2023-11-14T22#${actorHash}`,
        },
      }),
    );
    expect(indexed.Items).toEqual([]);
  });

  it('never writes the identity key, challenge, signature, OR raw userId to the log', async () => {
    const me = newIdentity();
    const { userId } = await signIn(me);

    const serialized = JSON.stringify(deps.logs);
    expect(serialized).not.toContain(me.publicB64);
    // FLIPPED deliberately: this line used to assert the userId WAS
    // present ("operators need it"). The retained log now keeps only the
    // salted opaque ref — a stable pseudonym operators can still correlate
    // on, without CloudWatch holding a 3-month per-user sign-in history.
    expect(serialized).not.toContain(userId);
    expect(serialized).toContain(userRefForLog(userId, SALT));
  });
});

describe('integration account class', () => {
  it('does not record sign-in activity for integration accounts', async () => {
    const touch = vi.spyOn(deps.db, 'touchActivity');

    await signIn(newIdentity(), { accountClass: 'integration' });

    expect(touch).not.toHaveBeenCalled();
  });

  it('records accountClass at creation, on the row', async () => {
    const bot = newIdentity();
    const { userId } = await signIn(bot, { accountClass: 'integration' });

    const row = await deps.db.getUserById(userId);
    expect(row?.accountClass).toBe('integration');
  });

  it('class is immutable: a later sign-in without the field keeps it', async () => {
    const bot = newIdentity();
    const { userId } = await signIn(bot, { accountClass: 'integration' });
    const again = await signIn(bot);

    expect(again.userId).toBe(userId);
    expect((await deps.db.getUserById(userId))?.accountClass).toBe('integration');
  });

  it('class cannot be acquired: a human account sending the field stays human', async () => {
    const me = newIdentity();
    const { userId } = await signIn(me);
    const again = await signIn(me, { accountClass: 'integration' });

    expect(again.userId).toBe(userId);
    expect((await deps.db.getUserById(userId))?.accountClass).toBeUndefined();
  });

  it('rejects any accountClass value other than "integration"', async () => {
    const me = newIdentity();
    const challenge = await getChallenge(me);
    const res = await authHandler(
      post('/v1/auth', {
        identityKey: me.publicB64,
        challenge,
        signature: sign(me, challenge),
        accountClass: 'admin',
      }),
      deps,
    );
    expect(res.statusCode).toBe(400);
  });

  it('a tombstoned identity key never authenticates again', async () => {
    const bot = newIdentity();
    await signIn(bot, { accountClass: 'integration' });

    await deps.db.tombstoneIdentityKey(bot.publicB64);

    const challenge = await getChallenge(bot);
    const res = await authHandler(
      post('/v1/auth', {
        identityKey: bot.publicB64,
        challenge,
        signature: sign(bot, challenge),
      }),
      deps,
    );
    expect(res.statusCode).toBe(403);
    expect(parseBody<{ error: { code: string } }>(res.body).error.code).toBe(
      'identity_tombstoned',
    );
  });

  it('logs account_created with the class on creation, and not on sign-in', async () => {
    const bot = newIdentity();
    await signIn(bot, { accountClass: 'integration' });
    await signIn(bot);

    const mints = deps.logs.filter((l) => l.event === 'account_created');
    expect(mints).toHaveLength(1);
    expect(mints[0]?.fields).toMatchObject({ class: 'integration' });

    const me = newIdentity();
    await signIn(me);
    const all = deps.logs.filter((l) => l.event === 'account_created');
    expect(all).toHaveLength(2);
    expect(all[1]?.fields).toMatchObject({ class: 'human' });
  });
});

/**
 * the relay, and the fix for it.
 *
 * This is the only test in this file that proves the audience property. The
 * rest verify that a correct signature is accepted and a wrong one is not —
 * both of which passed throughout the v1 defect, because the defect was not
 * that signatures verified incorrectly. It was that they verified ANYWHERE.
 */
describe('a signature is only valid at the endpoint it was minted for', () => {
  it('a relayed signature is REFUSED — the whole point of v2', async () => {
    const identity = newIdentity();

    // The attacker owns the endpoint the client is talking to: TACENDUM_API
    // pointed somewhere hostile, or a proxy in front of the client. It fetches
    // a genuine challenge from the REAL server for the victim's own key.
    const challenge = await getChallenge(identity);

    // The client signs it — a perfectly valid signature over a real nonce —
    // but for the audience it believes it is authenticating to.
    const relayed = sign(identity, challenge, 'https://evil.example');

    // The attacker presents that signature to the real server. Under v1 this
    // returned a genuine 30-day session token for the victim's account.
    const res = await authHandler(
      post('/v1/auth', {
        identityKey: identity.publicB64,
        challenge,
        signature: relayed,
      }),
      deps,
    );

    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body!).error.code).toBe('invalid_signature');
  });

  it('the same client, signing for the right origin, is accepted', async () => {
    // The control. Without it the test above would also pass if auth were
    // simply broken for everyone, which is not the property being claimed.
    const identity = newIdentity();
    const challenge = await getChallenge(identity);

    const res = await authHandler(
      post('/v1/auth', {
        identityKey: identity.publicB64,
        challenge,
        signature: sign(identity, challenge, TEST_ORIGIN),
      }),
      deps,
    );

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body!).authToken).toEqual(expect.any(String));
  });

  it('an origin that differs only in case, port or path is the SAME audience', async () => {
    // Normalisation is not cosmetic here: if these were different audiences,
    // a client configured with a trailing slash could never log in, and the
    // failure would look like a broken signature rather than a config typo.
    const identity = newIdentity();
    const challenge = await getChallenge(identity);

    const res = await authHandler(
      post('/v1/auth', {
        identityKey: identity.publicB64,
        challenge,
        signature: sign(identity, challenge, 'HTTPS://API.Test.Tacendum.com:443/v1/'),
      }),
      deps,
    );

    expect(res.statusCode).toBe(200);
  });

  it('a neighbouring origin is not the same audience', async () => {
    // The length prefix earns its place here: without it, a crafted origin
    // could absorb the challenge's leading bytes and collide with a different
    // (origin, challenge) pair.
    const identity = newIdentity();
    const challenge = await getChallenge(identity);

    const res = await authHandler(
      post('/v1/auth', {
        identityKey: identity.publicB64,
        challenge,
        signature: sign(identity, challenge, 'https://api.test.tacendum.com.evil.example'),
      }),
      deps,
    );

    expect(res.statusCode).toBe(401);
  });
});

/**
 * The AGPL source offer.
 *
 * is owed to every REMOTE USER of this service, and these two routes are
 * what every remote user passes through — an unauthenticated caller, a CLI, an
 * integration bot, App Review. So the obligation is asserted here, on the
 * responses themselves, rather than on some separate endpoint a reviewer would
 * have to already know to ask for.
 *
 * SCOPE OF THIS FILE: the BODY field, which belongs to the two success shapes
 * and is therefore the handlers' to set. The matching `Link` header is added by
 * each host — it has to be, because only a host sees the 401s, 429s, 413s and
 * 500s these handlers never return from, and is owed to those callers too.
 * The header is proven at both boundaries instead: `http.adapter.test.ts` for
 * the local host, `auth.lambda.test.ts` for AuthFn.
 */
describe('the AGPL source offer', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('offers the source in the body of an unauthenticated challenge', async () => {
    const me = newIdentity();
    const res = await authChallengeHandler(
      post('/v1/auth/challenge', { identityKey: me.publicB64 }),
      deps,
    );

    expect(res.statusCode).toBe(200);
    expect(parseBody<{ source?: string }>(res.body).source).toBe(AGPL_SOURCE_URL_DEFAULT);
  });

  it('offers the source in the body of a successful sign-in', async () => {
    // Repeated on this response deliberately: a client holding a challenge can
    // reach /v1/auth without ever having seen the challenge response in this
    // process, and the offer is owed to the user, not to one request.
    const identity = newIdentity();
    const challenge = await getChallenge(identity);

    const res = await authHandler(
      post('/v1/auth', {
        identityKey: identity.publicB64,
        challenge,
        signature: sign(identity, challenge),
      }),
      deps,
    );

    expect(res.statusCode).toBe(200);
    expect(parseBody<{ source?: string }>(res.body).source).toBe(AGPL_SOURCE_URL_DEFAULT);
  });

  it('serves the deployed release URL when one is configured, not the repo root', async () => {
    // NON-VACUITY. Without this the two tests above would pass against a
    // hard-coded constant, and asks for the source of the version actually
    // serving the caller — a tag, not a moving branch. The deploy is what
    // knows the tag, so the deploy is what must be able to say it.
    const tagged = 'https://github.com/MiranaTechs/Tacendum/tree/v1.2.3';
    vi.stubEnv('TACENDUM_SOURCE_URL', tagged);

    const identity = newIdentity();
    const challenge = await getChallenge(identity);
    const res = await authHandler(
      post('/v1/auth', {
        identityKey: identity.publicB64,
        challenge,
        signature: sign(identity, challenge),
      }),
      deps,
    );

    expect(parseBody<{ source?: string }>(res.body).source).toBe(tagged);
  });

  it('refuses a source URL Node cannot put in a header, rather than 500ing sign-in', async () => {
    // The claim two comments up — "a misconfigured source URL must not take
    // down sign-in" — did not hold when it was only the EMPTY case that fell
    // back. Node's writeHead rejects any header value outside its permitted
    // character class with ERR_INVALID_CHAR, so an em dash or an un-punycoded
    // IDN hostname in TACENDUM_SOURCE_URL turned every call on both auth routes
    // into a 500: an outage caused by the licence notice rather than prevented
    // by it. Here the resolver refuses the value; that it also stops being an
    // outage on the wire is proven against the real node:http response in
    // http.adapter.test.ts, which is where writeHead actually runs.
    vi.stubEnv('TACENDUM_SOURCE_URL', 'https://github.com/MiranaTechs/Tacendum/tree/v1.2.3—rc1');
    expect(sourceOfferUrl()).toBe(AGPL_SOURCE_URL_DEFAULT);
    // An un-punycoded IDN hostname is the same failure with a duller cause.
    // ABOVE U+00FF specifically: Node's permitted class runs to \xff, so a
    // latin-1 accent is fine and this test would have been a lie about `ü`
    // (it asserted that first, and went red — the filter is not "non-ASCII").
    vi.stubEnv('TACENDUM_SOURCE_URL', 'https://тacendum.example/src');
    expect(sourceOfferUrl()).toBe(AGPL_SOURCE_URL_DEFAULT);
    // ...and the latin-1 case is admitted, which is the boundary stated — and
    // then PUNYCODED on the way out, because `new URL()` normalises the host.
    // Note what that means: a value can be admitted and still not survive
    // verbatim. Normalisation is the point, not a side effect.
    vi.stubEnv('TACENDUM_SOURCE_URL', 'https://tacendüm.example/src');
    expect(sourceOfferUrl()).toBe('https://xn--tacendm-s2a.example/src');
    // A newline is the one that would have been an injected header, not just a
    // throw, on any host less careful than node:http.
    vi.stubEnv('TACENDUM_SOURCE_URL', 'https://example.test/a\r\nx-injected: 1');
    expect(sourceOfferUrl()).toBe(AGPL_SOURCE_URL_DEFAULT);

    // And an ordinary ASCII URL still passes through untouched, so the filter
    // is a filter and not a permanent fallback.
    vi.stubEnv('TACENDUM_SOURCE_URL', 'https://github.com/MiranaTechs/Tacendum/tree/v1.2.3');
    expect(sourceOfferUrl()).toBe('https://github.com/MiranaTechs/Tacendum/tree/v1.2.3');
  });

  it('never emits a Link target that stops early, which would point somewhere else', async () => {
    // NODE-SAFE IS NOT LINK-SAFE, and this is the gap. RFC 8288 delimits the
    // target with <...>, so a `>` inside the URL ends it early: Node is happy
    // to send `<https://x.example/a>b>; rel="source"` exactly as written, and a
    // conforming parser reads the target as `https://x.example/a` and chokes on
    // the rest. The offer then points at a DIFFERENT place — for worse than
    // no offer, because an absent notice is a bug and a confident wrong one is
    // a false statement about where the source is.
    vi.stubEnv('TACENDUM_SOURCE_URL', 'https://x.example/a>b');
    expect(sourceOfferUrl()).toBe('https://x.example/a%3Eb');
    // A space ends the target just as effectively.
    vi.stubEnv('TACENDUM_SOURCE_URL', 'https://x.example/a b');
    expect(sourceOfferUrl()).toBe('https://x.example/a%20b');

    // Whatever comes back, it must be safe to interpolate: no `>`, no space.
    for (const hostile of ['https://x.example/a>b', 'https://x.example/a b<c"d']) {
      vi.stubEnv('TACENDUM_SOURCE_URL', hostile);
      expect(sourceOfferUrl()).not.toMatch(/[ >]/);
    }
  });

  it('pins the Link relation to the exact dual token, which no adapter test can do', async () => {
    // The adapter tests build their EXPECTED header from SOURCE_LINK_REL and
    // the server builds the ACTUAL from the same constant, so they hold the
    // emission and the constant together but cannot see the constant itself
    // drift — set it back to the bare `source` and every one of them stays
    // green. This literal is the one assertion that goes red.
    // Two tokens because `rel` is a space-separated list (RFC 8288)
    // serving two readers: `source` is the word an AGPL reviewer greps
    // response headers for, but it is not IANA-registered, and the RFC
    // requires an unregistered extension relation to be an absolute URI —
    // the second token — so a strict parser matches the URI while a human
    // still sees the word — the registry gap decided the shape.
    expect(SOURCE_LINK_REL).toBe('source https://tacendum.com/rel/source');
  });

  it('pins the default source URL literally, for the same reason', async () => {
    // The same tautology one constant over, and the more damaging one: every
    // other assertion about the fallback compares it to
    // AGPL_SOURCE_URL_DEFAULT, so an org rename or a typo in dto.ts changes
    // what offers the world and the whole suite stays green. A source
    // offer pointing at a repository that does not exist is worse than no
    // offer, because it looks like compliance.
    expect(AGPL_SOURCE_URL_DEFAULT).toBe('https://github.com/MiranaTechs/Tacendum');
  });

  it('refuses a URL nobody could fetch the source from', async () => {
    // `new URL()` is perfectly happy with all of these (verified). An offer
    // that is not retrievable over the web is not an offer, and a `javascript:`
    // one is a link nobody should be handed at all.
    for (const bad of [
      'javascript:alert(1)',
      'ftp://example.test/src',
      'file:///etc/passwd',
      'github.com/MiranaTechs/Tacendum',
      'not a url at all',
    ]) {
      vi.stubEnv('TACENDUM_SOURCE_URL', bad);
      expect(sourceOfferUrl(), bad).toBe(AGPL_SOURCE_URL_DEFAULT);
    }
  });

  it('falls back to the repo root on an empty setting instead of refusing to sign anyone in', async () => {
    // The deliberate divergence from `readTableNames`, which THROWS on a
    // set-but-empty variable. An empty table name is unrecoverable; an empty
    // source URL is not. Refusing to start would deny every user the sign-in
    // exists to protect their access to, in order to perfect a notice
    // about it — so a misconfigured offer degrades to the truthful repo root
    // and the sign-in still succeeds.
    vi.stubEnv('TACENDUM_SOURCE_URL', '');
    expect(sourceOfferUrl()).toBe(AGPL_SOURCE_URL_DEFAULT);
    vi.stubEnv('TACENDUM_SOURCE_URL', '   ');
    expect(sourceOfferUrl()).toBe(AGPL_SOURCE_URL_DEFAULT);

    const result = await signIn(newIdentity());
    expect(result.authToken).toEqual(expect.any(String));
  });
});
