import { describe, expect, it, vi } from 'vitest';
import { opaqueUserRef, USER_REF_UNAVAILABLE, userRefForLog } from '../src/opaque-ref.js';
import { touchHumanActivity } from '../src/activity.js';
import { turnCredentialsHandler } from '../src/handlers/turn.js';
import { deleteSessionHandler, deleteOtherSessionsHandler } from '../src/handlers/session.js';
import { deleteAccountHandler } from '../src/handlers/account.js';
import { crewAdoptHandler } from '../src/handlers/crew.js';
import { integrationBindHandler } from '../src/handlers/integrations.js';
import { uploadKeysHandler } from '../src/handlers/keys.js';
import type { HttpEvent } from '../src/handlers/http.js';
import { makeMemoryDb, makeTestDeps, testIdentityKey, type TestDeps } from './helpers.js';

/**
 * Log identity-ref remediation: the account-lifecycle log events carried raw
 * user ULIDs into CloudWatch at 3-month retention — a per-user sign-in and
 * device-supersession history, plus the crew_adopted owner→member edge. These
 * tests pin the fix: every identity-bearing lifecycle event now carries the
 * opaque HMAC ref (`userRef` / `ownerRef` / `memberRef`), never the raw ULID,
 * and the raw ULID appears NOWHERE in the emitted log stream (the grep-style
 * assertion). When the salt is absent the ref degrades to the `unavailable`
 * sentinel — never to the raw id.
 *
 * Since the design decision the log refs live in their OWN key
 * domain (HMAC-SHA256(salt, 'log-ref') keys the construction), so they are
 * not joinable to the STUN usernames or the activity keys — the final
 * describe block proves the three-way separation against the real seams.
 */

const SALT = 'test-user-ref-salt';
const OWNER = '01AAAAAAAAAAAAAAAAAAAAAAAA';
const MEMBER = '01BBBBBBBBBBBBBBBBBBBBBBBB';
const BOT = '01CCCCCCCCCCCCCCCCCCCCCCCC';

function saltedDeps(): TestDeps {
  return { ...makeTestDeps(makeMemoryDb()), userRefSalt: SALT };
}

function bearerEvent(method: string, path: string, body?: unknown): HttpEvent {
  return {
    method,
    path,
    headers: { authorization: 'Bearer token-1', 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

/** The grep-style assertion: the whole emitted log stream, stringified, holds
 * none of the raw ids that flowed through the handler. */
function expectNoRawIds(deps: TestDeps, ...ids: string[]): void {
  const stream = JSON.stringify(deps.logs);
  for (const id of ids) expect(stream).not.toContain(id);
}

describe('opaqueUserRef (the moved primitive, crypto unchanged)', () => {
  it('is 16 base64url chars, stable per (user, salt)', () => {
    const ref = opaqueUserRef(OWNER, SALT);
    expect(ref).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(opaqueUserRef(OWNER, SALT)).toBe(ref);
  });

  it('differs across users and across salts', () => {
    expect(opaqueUserRef(OWNER, SALT)).not.toBe(opaqueUserRef(MEMBER, SALT));
    expect(opaqueUserRef(OWNER, SALT)).not.toBe(opaqueUserRef(OWNER, 'other-salt'));
  });

  it('userRefForLog degrades to the sentinel, never the raw id', () => {
    expect(userRefForLog(OWNER, undefined)).toBe(USER_REF_UNAVAILABLE);
    expect(userRefForLog(OWNER, '')).toBe(USER_REF_UNAVAILABLE);
    // Salted, it is a well-formed ref in the LOG domain — deliberately NOT
    // the raw-salt (STUN) derivation it equalled before the
    // domain-separation decision.
    expect(userRefForLog(OWNER, SALT)).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(userRefForLog(OWNER, SALT)).not.toBe(opaqueUserRef(OWNER, SALT));
  });
});

describe('session lifecycle events carry the opaque ref, not the ULID', () => {
  it('session_revoked', async () => {
    const deps = saltedDeps();
    const res = await deleteSessionHandler(
      bearerEvent('DELETE', '/v1/session'),
      deps,
      { userId: OWNER },
    );
    expect(res.statusCode).toBe(200);
    const line = deps.logs.find((l) => l.event === 'session_revoked');
    expect(line?.fields).toEqual({ userRef: userRefForLog(OWNER, SALT) });
    expectNoRawIds(deps, OWNER);
  });

  it('other_sessions_revoked keeps the count beside the ref', async () => {
    const deps = saltedDeps();
    const res = await deleteOtherSessionsHandler(
      bearerEvent('DELETE', '/v1/sessions/others'),
      deps,
      { userId: OWNER },
    );
    expect(res.statusCode).toBe(200);
    const line = deps.logs.find((l) => l.event === 'other_sessions_revoked');
    expect(line?.fields).toEqual({ userRef: userRefForLog(OWNER, SALT), revoked: 0 });
    expectNoRawIds(deps, OWNER);
  });

  it('degrades to the sentinel without a salt — never the raw id', async () => {
    const deps = makeTestDeps(makeMemoryDb()); // no userRefSalt
    await deleteSessionHandler(bearerEvent('DELETE', '/v1/session'), deps, { userId: OWNER });
    const line = deps.logs.find((l) => l.event === 'session_revoked');
    expect(line?.fields).toEqual({ userRef: USER_REF_UNAVAILABLE });
    expectNoRawIds(deps, OWNER);
  });
});

describe('account_deleted carries the opaque ref, not the ULID', () => {
  it('account_deleted', async () => {
    const deps = saltedDeps();
    const key = testIdentityKey(0x31);
    const made = await deps.db.getOrCreateUserByIdentityKey(key, OWNER, 1000);
    if (made.kind !== 'ok') throw new Error('fixture account was not created');
    await deps.db.createSession({
      token: 'token-1',
      userId: OWNER,
      createdAt: 1000,
      expiresAt: 4_000_000_000,
    });
    const res = await deleteAccountHandler(
      bearerEvent('DELETE', '/v1/account'),
      deps,
      { userId: OWNER },
    );
    expect(res.statusCode).toBe(200);
    const line = deps.logs.find((l) => l.event === 'account_deleted');
    expect(line?.fields).toEqual({ userRef: userRefForLog(OWNER, SALT) });
    expectNoRawIds(deps, OWNER);
  });
});

describe('crew_adopted: BOTH ends of the ownership edge are opaque', () => {
  it('logs ownerRef and memberRef, never either ULID', async () => {
    const deps = saltedDeps();
    await deps.db.createUser({ userId: OWNER, createdAt: 1000 });
    await deps.db.createUser({ userId: MEMBER, createdAt: 1000, accountClass: 'integration' });
    await deps.db.bindIntegrationOwner(MEMBER, OWNER);

    const res = await crewAdoptHandler(
      bearerEvent('POST', '/v1/crew/adopt', { member: MEMBER }),
      deps,
      { userId: OWNER },
    );
    expect(res.statusCode).toBe(204);
    const line = deps.logs.find((l) => l.event === 'crew_adopted');
    expect(line?.fields).toEqual({
      ownerRef: userRefForLog(OWNER, SALT),
      memberRef: userRefForLog(MEMBER, SALT),
    });
    expectNoRawIds(deps, OWNER, MEMBER);
  });
});

describe('integration_bound carries the opaque ref, not the ULID', () => {
  it('integration_bound', async () => {
    const deps = saltedDeps();
    await deps.db.createUser({ userId: OWNER, createdAt: 1000 });
    await deps.db.createUser({ userId: BOT, createdAt: 1000, accountClass: 'integration' });

    const res = await integrationBindHandler(
      bearerEvent('POST', '/v1/integrations/bind', { owner: OWNER }),
      deps,
      { userId: BOT },
    );
    expect(res.statusCode).toBe(204);
    const line = deps.logs.find((l) => l.event === 'integration_bound');
    expect(line?.fields).toEqual({ userRef: userRefForLog(BOT, SALT) });
    expectNoRawIds(deps, BOT, OWNER);
  });
});

describe('key_upload_rejected_immutable carries the opaque ref, not the ULID', () => {
  it('key_upload_rejected_immutable', async () => {
    const deps = saltedDeps();
    const original = testIdentityKey(0x41);
    const made = await deps.db.getOrCreateUserByIdentityKey(original, OWNER, 1000);
    if (made.kind !== 'ok') throw new Error('fixture account was not created');
    await deps.db.storeKeys(
      OWNER,
      {
        registrationId: 7,
        identityKeyPub: original,
        signedPrekey: { keyId: 1, pub: 'c3Br', sig: 'c2ln' },
        kyberPrekey: { keyId: 2, pub: 'a3li', sig: 'a3Np' },
      },
      [],
    );

    const res = await uploadKeysHandler(
      bearerEvent('PUT', '/v1/keys', {
        registrationId: 7,
        identityKey: testIdentityKey(0x42), // a DIFFERENT key: refused as immutable
        signedPrekey: { keyId: 1, pub: 'c3Br', sig: 'c2ln' },
        kyberPrekey: { keyId: 2, pub: 'a3li', sig: 'a3Np' },
        oneTimePrekeys: [],
      }),
      deps,
      { userId: OWNER },
    );
    expect(res.statusCode).toBe(409);
    const line = deps.logs.find((l) => l.event === 'key_upload_rejected_immutable');
    expect(line?.fields).toEqual({ userRef: userRefForLog(OWNER, SALT) });
    expectNoRawIds(deps, OWNER);
  });
});

describe('domain separation: one stored secret, three unjoinable ref spaces (design decision)', () => {
  /** The STUN leg, driven through the REAL turn handler: the username coturn
   * validates is `<expiry>:<ref>`, and that ref must stay byte-for-byte the
   * raw-salt derivation (coturn compatibility) while the log and activity
   * refs leave its domain. */
  async function stunRefFor(userId: string): Promise<string> {
    const deps = saltedDeps();
    deps.turn = {
      urls: ['turn:turn.example.com:3478?transport=udp'],
      authSecret: 'turn-auth-secret-for-tests',
      userSalt: SALT,
    };
    const res = await turnCredentialsHandler(
      { method: 'POST', path: '/v1/turn-credentials', headers: {}, body: '{}' },
      deps,
      { userId },
    );
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body as string) as { iceServers: { username?: string }[] };
    const username = body.iceServers.find((s) => s.username)?.username;
    if (!username) throw new Error('no TURN entry carried a username');
    return username.split(':')[1]!;
  }

  /** The activity leg, driven through the REAL touch seam: whatever
   * `touchHumanActivity` hands the data layer IS the activity actor ref. */
  async function activityRefFor(userId: string): Promise<string> {
    const db = makeMemoryDb();
    const touch = vi.spyOn(db, 'touchActivity').mockResolvedValue();
    await touchHumanActivity(
      { userId, createdAt: 1000 },
      { db, log: () => {}, now: () => 1000, userRefSalt: SALT },
    );
    expect(touch).toHaveBeenCalledOnce();
    return touch.mock.calls[0]![0];
  }

  it('the same user under the same salt gets THREE different refs across STUN, log, and activity', async () => {
    const stunRef = await stunRefFor(OWNER);
    const logRef = userRefForLog(OWNER, SALT);
    const activityRef = await activityRefFor(OWNER);

    // Each is a well-formed 16-char ref in its own space...
    for (const ref of [stunRef, logRef, activityRef]) {
      expect(ref).toMatch(/^[A-Za-z0-9_-]{16}$/);
    }
    // ...and no two spaces share it: coturn's relay log, the CloudWatch
    // lifecycle events, and the 35-day activity table stop being joinable
    // to EACH OTHER on the ref. One stored secret still keys all three —
    // rotating it breaks all three ref spaces at once.
    expect(logRef).not.toBe(stunRef);
    expect(activityRef).not.toBe(stunRef);
    expect(activityRef).not.toBe(logRef);
  });

  it('the STUN ref stays byte-for-byte the raw-salt derivation (coturn compatibility)', async () => {
    expect(await stunRefFor(OWNER)).toBe(opaqueUserRef(OWNER, SALT));
  });

  it('the log ref is stable across events for the same user', async () => {
    const deps = saltedDeps();
    await deleteSessionHandler(bearerEvent('DELETE', '/v1/session'), deps, { userId: OWNER });
    await deleteOtherSessionsHandler(
      bearerEvent('DELETE', '/v1/sessions/others'),
      deps,
      { userId: OWNER },
    );
    const refs = deps.logs
      .filter((l) => l.event === 'session_revoked' || l.event === 'other_sessions_revoked')
      .map((l) => l.fields?.['userRef']);
    expect(refs).toHaveLength(2);
    expect(refs[1]).toBe(refs[0]);
    expect(refs[0]).toBe(userRefForLog(OWNER, SALT));
  });
});
