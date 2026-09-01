import { beforeEach, describe, expect, it } from 'vitest';
import { authenticate } from '../src/handlers/auth.js';
import { deleteAccountHandler } from '../src/handlers/account.js';
import { PrivateKey } from '@signalapp/libsignal-client';
import { authSignedBytes } from '@tacendum/shared';
import { authChallengeHandler, authHandler } from '../src/handlers/auth-account.js';
import {
  deleteOtherSessionsHandler,
  deleteSessionHandler,
} from '../src/handlers/session.js';
import type { AuthContext, HttpEvent } from '../src/handlers/http.js';
import { LIMITS } from '../src/ratelimit.js';
import { makeMemoryDb, makeTestDeps, parseBody, type TestDeps } from './helpers.js';

/**
 * Session revocation. Until this landed, a
 * leaked bearer token could only be killed by deleting the whole account —
 * sessions are keyed by token digest, so there was nothing to find them by.
 *
 * Every test here asserts the negative that matters: the revoked token no
 * longer authenticates. Asserting the handler returned 200 proves nothing.
 */

const USER = '01USERUNDERTESTAAAAAAAAAAA';
const OTHER = '01SOMEONEELSEBBBBBBBBBBBBB';

let deps: TestDeps;

function auth(userId = USER): AuthContext {
  return { userId };
}

function del(path: string, token: string | undefined): HttpEvent {
  return {
    method: 'DELETE',
    path,
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
    pathParameters: {},
    body: null,
    sourceIp: '203.0.113.7',
  };
}

/** Mint a session the way verify does, and hand back its plaintext token. */
async function issue(userId: string, token: string): Promise<string> {
  await deps.db.createSession({
    token,
    userId,
    createdAt: deps.now(),
    expiresAt: Math.floor(deps.now() / 1000) + 3600,
  });
  return token;
}

/** The only question that matters about a revoked credential. */
async function stillWorks(token: string): Promise<boolean> {
  return (await authenticate(del('/v1/me', token), deps)) !== null;
}

beforeEach(() => {
  deps = makeTestDeps(makeMemoryDb());
});

describe('DELETE /v1/session — sign out', () => {
  it('the calling token stops authenticating', async () => {
    const token = await issue(USER, 'tok-calling');
    expect(await stillWorks(token)).toBe(true);

    const res = await deleteSessionHandler(del('/v1/session', token), deps, auth());
    expect(res.statusCode).toBe(200);
    expect(await stillWorks(token)).toBe(false);
  });

  it('leaves this user’s other sessions alone — signing out one device is not signing out all', async () => {
    const phone = await issue(USER, 'tok-phone');
    const tablet = await issue(USER, 'tok-tablet');

    await deleteSessionHandler(del('/v1/session', phone), deps, auth());

    expect(await stillWorks(phone)).toBe(false);
    expect(await stillWorks(tablet)).toBe(true);
  });

  it('is idempotent: revoking twice is still 200, not an error to retry against', async () => {
    const token = await issue(USER, 'tok-twice');
    await deleteSessionHandler(del('/v1/session', token), deps, auth());
    const again = await deleteSessionHandler(del('/v1/session', token), deps, auth());
    expect(again.statusCode).toBe(200);
  });

  it('is rate limited per user, and the limit is roomier than account deletion', async () => {
    // Signing out is a panic action; being locked out of the control that
    // stops a leaked token would be the wrong failure.
    expect(LIMITS.sessionRevoke.capacity).toBeGreaterThan(LIMITS.accountDelete.capacity);

    for (let i = 0; i < LIMITS.sessionRevoke.capacity; i++) {
      const t = await issue(USER, `tok-burst-${i}`);
      const res = await deleteSessionHandler(del('/v1/session', t), deps, auth());
      expect(res.statusCode).toBe(200);
    }
    const over = await deleteSessionHandler(del('/v1/session', 'tok-over'), deps, auth());
    expect(over.statusCode).toBe(429);
  });
});

describe('DELETE /v1/sessions/others — lost-device revocation', () => {
  it('kills every other session for this user and keeps the caller signed in', async () => {
    const here = await issue(USER, 'tok-here');
    const lost = await issue(USER, 'tok-lost-device');
    const old = await issue(USER, 'tok-old-laptop');

    const res = await deleteOtherSessionsHandler(
      del('/v1/sessions/others', here),
      deps,
      auth(),
    );
    expect(res.statusCode).toBe(200);
    expect(parseBody<{ revoked: number }>(res.body).revoked).toBe(2);

    expect(await stillWorks(lost)).toBe(false);
    expect(await stillWorks(old)).toBe(false);
    // The whole point: you do not sign yourself out doing this.
    expect(await stillWorks(here)).toBe(true);
  });

  it('never touches another user’s sessions', async () => {
    const mine = await issue(USER, 'tok-mine');
    await issue(USER, 'tok-mine-2');
    const theirs = await issue(OTHER, 'tok-theirs');

    await deleteOtherSessionsHandler(del('/v1/sessions/others', mine), deps, auth(USER));

    expect(await stillWorks(theirs)).toBe(true);
  });

  it('reports zero when there is nothing else to revoke', async () => {
    const only = await issue(USER, 'tok-only');
    const res = await deleteOtherSessionsHandler(
      del('/v1/sessions/others', only),
      deps,
      auth(),
    );
    expect(parseBody<{ revoked: number }>(res.body).revoked).toBe(0);
    expect(await stillWorks(only)).toBe(true);
  });
});

describe('DELETE /v1/account — the residual this index closed', () => {
  it('takes every session with it, not just the calling one', async () => {
    // Before the user index, siblings lapsed by TTL: a deleted account stayed
    // reachable for up to 30 days by any other token it had issued.
    const calling = await issue(USER, 'tok-acct-calling');
    const sibling = await issue(USER, 'tok-acct-sibling');

    const res = await deleteAccountHandler(del('/v1/account', calling), deps, auth());
    expect(res.statusCode).toBe(200);

    expect(await stillWorks(calling)).toBe(false);
    expect(await stillWorks(sibling)).toBe(false);
  });
});

describe('POST /v1/auth — a new sign-in supersedes the old ones', () => {
  it('revokes the previous session and leaves the caller with a working one', async () => {
    // A token from a previous install stayed live for up to 30 days. Proving
    // the identity key again ends it — one account, one device, so an older
    // token has no legitimate claim once the key re-proves itself.
    // This case was written against POST /v1/verify and moved to POST /v1/auth
    // when deleted the phone path. The signature is a
    // REAL libsignal signature: authHandler will not reach the revocation step
    // without one, so a fixture would test nothing.
    const priv = PrivateKey.generate();
    const identityKey = Buffer.from(priv.getPublicKey().serialize()).toString('base64');
    const stale = await issue(USER, 'tok-old-install');

    // Pin the account to USER so the sign-in resolves the same userId the
    // stale session belongs to — that is what makes this a RE-registration
    // rather than a first one, and the stale token relevant at all.
    const pinned = await deps.db.getOrCreateUserByIdentityKey(identityKey, USER, deps.now());
    expect(pinned.kind).toBe('ok');

    const post = (path: string, body: unknown): HttpEvent => ({
      method: 'POST',
      path,
      headers: { 'content-type': 'application/json' },
      pathParameters: {},
      body: JSON.stringify(body),
      sourceIp: '203.0.113.9',
    });

    const issued = await authChallengeHandler(post('/v1/auth/challenge', { identityKey }), deps);
    expect(issued.statusCode).toBe(200);
    const { challenge } = parseBody<{ challenge: string }>(issued.body);

    // Built by the shared definition, not by hand — .
    const signature = Buffer.from(
      priv.sign(new Uint8Array(authSignedBytes(deps.apiOrigin, challenge))),
    ).toString('base64');

    const res = await authHandler(post('/v1/auth', { identityKey, challenge, signature }), deps);
    expect(res.statusCode).toBe(200);
    const { authToken, userId } = parseBody<{ authToken: string; userId: string }>(res.body);
    expect(userId).toBe(USER);

    expect(await stillWorks(stale)).toBe(false);
    expect(await stillWorks(authToken)).toBe(true);
  });
});
