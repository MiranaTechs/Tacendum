import { beforeEach, expect, it, vi } from 'vitest';
import { PrivateKey } from '@signalapp/libsignal-client';
import { authSignedBytes } from '@tacendum/shared';
import { authChallengeHandler, authHandler } from '../src/handlers/auth-account.js';
import { deleteAccountRoute } from '../src/handlers/account.js';
import { makeMemoryDb, makeTestDeps, parseBody, type TestDeps } from './helpers.js';

// Memory DataLayer only: no AWS client, credentials, or database connection.
let deps: TestDeps;
let key: PrivateKey;
let identityKey: string;
beforeEach(() => {
  deps = makeTestDeps(makeMemoryDb());
  key = PrivateKey.generate();
  identityKey = Buffer.from(key.getPublicKey().serialize()).toString('base64');
});

async function auth(expectedUserId?: string) {
  const challengeRes = await authChallengeHandler({
    method: 'POST', path: '/v1/auth/challenge', headers: {},
    body: JSON.stringify({ identityKey }),
  }, deps);
  expect(challengeRes.statusCode).toBe(200);
  const { challenge } = parseBody<{ challenge: string }>(challengeRes.body);
  return authHandler({
    method: 'POST', path: '/v1/auth', headers: {},
    body: JSON.stringify({ identityKey, challenge, expectedUserId,
      signature: Buffer.from(key.sign(new Uint8Array(authSignedBytes(deps.apiOrigin, challenge)))).toString('base64'),
    }),
  }, deps);
}

it('renews the same live device ID and supersedes only its old bearer', async () => {
  const first = parseBody<{ userId: string; authToken: string }>((await auth()).body);
  const renewed = await auth(first.userId);
  expect(renewed.statusCode).toBe(200);
  expect(parseBody<{ userId: string }>(renewed.body).userId).toBe(first.userId);
  expect(await deps.db.getSession(first.authToken)).toBeUndefined();
});

it('a delayed renewal after deletion never creates another account for the old key', async () => {
  const first = parseBody<{ userId: string; authToken: string }>((await auth()).body);
  expect((await deleteAccountRoute({ method: 'DELETE', path: '/v1/account',
    headers: { authorization: `Bearer ${first.authToken}` } }, deps)).statusCode).toBe(200);
  const create = vi.spyOn(deps.db, 'getOrCreateUserByIdentityKey');
  const renewed = await auth(first.userId);
  expect(renewed.statusCode).toBe(409);
  expect(parseBody<{ error: { code: string } }>(renewed.body).error.code).toBe('account_gone');
  expect(create).not.toHaveBeenCalled();
  expect(await deps.db.getUserByIdentityKeyClaim(identityKey)).toBeUndefined();
});

it('a restored profile belonging to another key cannot renew or displace either account', async () => {
  const first = parseBody<{ userId: string; authToken: string }>((await auth()).body);
  key = PrivateKey.generate();
  identityKey = Buffer.from(key.getPublicKey().serialize()).toString('base64');
  const refused = await auth(first.userId);
  expect(refused.statusCode).toBe(409);
  expect(await deps.db.getSession(first.authToken)).toBeDefined();
  expect(await deps.db.getUserByIdentityKeyClaim(identityKey)).toBeUndefined();
});

it('explicit fresh registration after human deletion receives a different ID', async () => {
  const first = parseBody<{ userId: string; authToken: string }>((await auth()).body);
  await deleteAccountRoute({ method: 'DELETE', path: '/v1/account',
    headers: { authorization: `Bearer ${first.authToken}` } }, deps);
  const next = await auth();
  expect(next.statusCode).toBe(200);
  expect(parseBody<{ userId: string }>(next.body).userId).not.toBe(first.userId);
});
