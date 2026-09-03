import { describe, expect, it } from 'vitest';
import type { AuthContext, HttpEvent } from '../src/handlers/http.js';
import { authChallengeHandler } from '../src/handlers/auth-account.js';
import { getPrekeyBundleHandler } from '../src/handlers/keys.js';
import { LIMITS } from '../src/ratelimit.js';
import { makeMemoryDb, makeTestDeps, jsonPost, testIdentityKey } from './helpers.js';

/**
 * abuse ceilings.
 *
 * The register/verify cases that used to live here died with the phone number
 * but the CONTROL they exercised did not: LIMITS.auth
 * is still the only ceiling on the unauthenticated surface, and that surface is
 * now POST /v1/auth/challenge. The per-IP bucket is therefore re-asserted
 * against the route that inherited it rather than dropped along with the routes
 * that were deleted — losing this coverage would leave the one public endpoint
 * in the stack unbounded and untested.
 *
 * The brute-force and enumeration cases are GONE, not ported, and that is the
 * honest outcome: they bounded guessing at a 6-digit code and hid which phones
 * had a code pending. There is nothing to guess at a challenge — it is answered
 * with a signature or not at all — so a per-code attempt cap and a generic
 * "no pending code" response have no analogue. What replaced them is asserted
 * in auth-account.test.ts with real signatures.
 */

const B64 = 'QUJDMTIz';

function bundleEvent(userId: string, sourceIp = '10.0.0.1'): HttpEvent {
  return { method: 'GET', path: '/', headers: {}, pathParameters: { userId }, sourceIp };
}

async function seedTarget(db: ReturnType<typeof makeMemoryDb>, userId: string): Promise<void> {
  await db.createUser({ userId, createdAt: 0 });
  await db.storeKeys(
    userId,
    {
      registrationId: 7,
      identityKeyPub: B64,
      signedPrekey: { keyId: 1, pub: B64, sig: B64 },
      kyberPrekey: { keyId: 1, pub: B64, sig: B64 },
    },
    Array.from({ length: 50 }, (_, i) => ({ keyId: i + 1, pub: B64 })),
  );
}

describe('rate limiting', () => {
  it('auth challenge: allows a burst up to capacity, then 429 with Retry-After', async () => {
    const deps = makeTestDeps(makeMemoryDb());
    const body = { identityKey: testIdentityKey(0x11) };
    for (let i = 0; i < LIMITS.auth.capacity; i++) {
      const res = await authChallengeHandler(jsonPost(body), deps);
      expect(res.statusCode).toBe(200);
    }
    const limited = await authChallengeHandler(jsonPost(body), deps);
    expect(limited.statusCode).toBe(429);
    expect(limited.headers?.['retry-after']).toBeDefined();
    expect(JSON.parse(limited.body!).error.code).toBe('rate_limited');
  });

  it('auth challenge: a different source IP has its own bucket', async () => {
    // Per-IP is the ONLY dimension available here, and deliberately so: keying
    // on the identity key would bound nobody, because keys are free to mint
    // So the per-IP bucket has to actually be
    // per-IP — one noisy client must not lock everyone else out.
    const deps = makeTestDeps(makeMemoryDb());
    const body = { identityKey: testIdentityKey(0x12) };
    for (let i = 0; i < LIMITS.auth.capacity; i++) {
      await authChallengeHandler(jsonPost(body, '1.1.1.1'), deps);
    }
    expect((await authChallengeHandler(jsonPost(body, '1.1.1.1'), deps)).statusCode).toBe(429);
    expect((await authChallengeHandler(jsonPost(body, '2.2.2.2'), deps)).statusCode).toBe(200);
  });

  it('auth challenge: a DIFFERENT identity key from one IP shares that IP bucket', async () => {
    // Non-vacuity for the choice above: if the bucket key ever drifted to
    // include the identity key, one host could mint unlimited challenges just
    // by generating a new keypair per request, and this test would fail.
    const deps = makeTestDeps(makeMemoryDb());
    for (let i = 0; i < LIMITS.auth.capacity; i++) {
      const res = await authChallengeHandler(
        jsonPost({ identityKey: testIdentityKey(0x20 + i) }, '3.3.3.3'),
        deps,
      );
      expect(res.statusCode).toBe(200);
    }
    const fresh = await authChallengeHandler(
      jsonPost({ identityKey: testIdentityKey(0x7f) }, '3.3.3.3'),
      deps,
    );
    expect(fresh.statusCode).toBe(429);
  });

  it('prekey fetch: per-(caller,target) limit; a different target resets', async () => {
    const db = makeMemoryDb();
    const deps = makeTestDeps(db);
    // ULID-shaped targets (the path param is shape-validated).
    const targetA = '01TARGETA00000000000000000';
    const targetB = '01TARGETB00000000000000000';
    await seedTarget(db, targetA);
    await seedTarget(db, targetB);
    const caller: AuthContext = { userId: 'caller' };
    for (let i = 0; i < LIMITS.prekeyFetch.capacity; i++) {
      expect((await getPrekeyBundleHandler(bundleEvent(targetA), deps, caller)).statusCode).toBe(200);
    }
    expect((await getPrekeyBundleHandler(bundleEvent(targetA), deps, caller)).statusCode).toBe(429);
    // Same caller, different target -> separate bucket.
    expect((await getPrekeyBundleHandler(bundleEvent(targetB), deps, caller)).statusCode).toBe(200);
  });
});

describe('logging', () => {
  it('the auth challenge never puts the identity key in the structured log', async () => {
    // The key identifies the account exactly as the phone number used to, so
    // the log-hygiene rule covers it for the same reason: the retained operational log must
    // not become a register of who has an account.
    const deps = makeTestDeps(makeMemoryDb());
    const identityKey = testIdentityKey(0x33);
    await authChallengeHandler(jsonPost({ identityKey }), deps);

    expect(deps.logs.some((e) => e.event === 'auth_challenge_issued')).toBe(true);
    const keyInLogs = deps.logs.some((e) =>
      Object.values(e.fields).some((v) => String(v).includes(identityKey)),
    );
    expect(keyInLogs).toBe(false);
  });

  it('the issued challenge itself never reaches the log either', async () => {
    const deps = makeTestDeps(makeMemoryDb());
    const res = await authChallengeHandler(jsonPost({ identityKey: testIdentityKey(0x34) }), deps);
    const challenge = JSON.parse(res.body!).challenge as string;

    const challengeInLogs = deps.logs.some((e) =>
      Object.values(e.fields).some((v) => String(v).includes(challenge)),
    );
    expect(challengeInLogs).toBe(false);
  });
});
