import { beforeEach, describe, expect, it } from 'vitest';
import type { OneTimePrekey, PrekeyBundle, UploadKeysRequest } from '@tacendum/shared';
import { uploadKeysHandler, getPrekeyBundleHandler } from '../src/handlers/keys.js';
import type { AuthContext, HttpEvent } from '../src/handlers/http.js';
import type { TestOnlyDataLayer } from '../src/db/data.js';
import { LIMITS } from '../src/ratelimit.js';
import {
  KEY_FIXTURE,
  jsonPost,
  makeMemoryDb,
  makeTestDeps,
  parseBody,
  type TestDeps,
} from './helpers.js';

// ULID-shaped (the {userId} path param is shape-validated before it can
// become a limiter partition key).
const USER = '01KEYS00000000000000000001';
const NOBODY = '01N0B0DY000000000000000000';
const B64 = 'QUJDMTIz'; // "ABC123"

function auth(userId = USER): AuthContext {
  return { userId };
}

function bundleEvent(userId: string): HttpEvent {
  return { method: 'GET', path: '/', headers: {}, pathParameters: { userId } };
}

const SPK = { keyId: 1, pub: KEY_FIXTURE.curvePub, sig: KEY_FIXTURE.sig };
const KYBER = { keyId: 1, pub: KEY_FIXTURE.kyberPub, sig: KEY_FIXTURE.sig };

function makeUpload(oneTimePrekeys: OneTimePrekey[]): UploadKeysRequest {
  return {
    registrationId: 42,
    identityKey: B64,
    signedPrekey: { ...SPK },
    kyberPrekey: { ...KYBER },
    oneTimePrekeys,
  };
}

function prekeys(n: number): OneTimePrekey[] {
  return Array.from({ length: n }, (_, i) => ({ keyId: i + 1, pub: KEY_FIXTURE.curvePub }));
}

describe('key distribution', () => {
  let db: TestOnlyDataLayer;
  let deps: TestDeps;

  beforeEach(async () => {
    db = makeMemoryDb();
    deps = makeTestDeps(db);
    await db.createUser({ userId: USER, createdAt: deps.now() });
  });

  it('uploadKeys stores identity + signed prekey and appends one-time prekeys (204)', async () => {
    const res = await uploadKeysHandler(jsonPost(makeUpload(prekeys(5))), deps, auth());
    expect(res.statusCode).toBe(204);
    const user = await db.getUserById(USER);
    expect(user?.registrationId).toBe(42);
    expect(user?.identityKeyPub).toBe(B64);
    expect(user?.signedPrekey).toEqual(SPK);
    expect(user?.kyberPrekey).toEqual(KYBER);
    expect(await db.countOneTimePrekeys(USER)).toBe(5);
  });

  /**
   * The upload schema checked the base64 ALPHABET only, so a stolen bearer
   * could publish an unverifiable signed prekey under the victim's identity
   * key and every peer's bundle processing would fail until the victim
   * re-uploaded — a quieter DoS than deletion. libsignal is deliberately off
   * HttpFn, so the door check is the byte LENGTH every shipped client
   * produces (33 / 64 / 1569); garbage of the wrong size is refused at the
   * schema, 400. */
  it('uploadKeys refuses key material that is not libsignal-sized (400)', async () => {
    const b64 = (n: number): string => Buffer.alloc(n, 0x42).toString('base64');
    const bad: Array<[string, Partial<UploadKeysRequest>]> = [
      ['32-byte curve pub', { signedPrekey: { ...SPK, pub: b64(32) } }],
      ['34-byte curve pub', { signedPrekey: { ...SPK, pub: b64(34) } }],
      ['63-byte signature', { signedPrekey: { ...SPK, sig: b64(63) } }],
      ['65-byte kyber signature', { kyberPrekey: { ...KYBER, sig: b64(65) } }],
      ['1568-byte kyber pub', { kyberPrekey: { ...KYBER, pub: b64(1568) } }],
      ['33-byte kyber pub (a curve key in the KEM slot)', { kyberPrekey: { ...KYBER, pub: b64(33) } }],
      ['34-byte one-time prekey', { oneTimePrekeys: [{ keyId: 1, pub: b64(34) }] }],
    ];
    for (const [label, over] of bad) {
      // Each refused upload still spends the per-account budget (priced
      // before the parse); an hour apart keeps the window open.
      deps.advanceMs(3600 * 1000);
      const res = await uploadKeysHandler(jsonPost({ ...makeUpload(prekeys(1)), ...over }), deps, auth());
      expect(res.statusCode, label).toBe(400);
      expect(parseBody<{ error: { code: string } }>(res.body).error.code, label).toBe('invalid_request');
    }
    expect(await db.countOneTimePrekeys(USER)).toBe(0);
    expect((await uploadKeysHandler(jsonPost(makeUpload(prekeys(1))), deps, auth())).statusCode).toBe(204);
  });

  it('uploadKeys rejects a malformed body (400 invalid_request)', async () => {
    const res = await uploadKeysHandler(jsonPost({ registrationId: 'nope' }), deps, auth());
    expect(res.statusCode).toBe(400);
  });

  it('re-upload replaces the one-time prekey pool (does not append)', async () => {
    await uploadKeysHandler(jsonPost(makeUpload(prekeys(5))), deps, auth());
    expect(await db.countOneTimePrekeys(USER)).toBe(5);
    // Second upload with 3 keys -> pool is exactly 3, not 8.
    await uploadKeysHandler(jsonPost(makeUpload(prekeys(3))), deps, auth());
    expect(await db.countOneTimePrekeys(USER)).toBe(3);
  });

  it('duplicate keyIds in one upload collapse to one prekey', async () => {
    const dup = makeUpload([
      { keyId: 7, pub: KEY_FIXTURE.curvePub },
      { keyId: 7, pub: KEY_FIXTURE.curvePub },
      { keyId: 8, pub: KEY_FIXTURE.curvePub },
    ]);
    const res = await uploadKeysHandler(jsonPost(dup), deps, auth());
    expect(res.statusCode).toBe(204);
    expect(await db.countOneTimePrekeys(USER)).toBe(2);
  });

  it('getPrekeyBundle returns a full bundle and consumes exactly one prekey', async () => {
    await uploadKeysHandler(jsonPost(makeUpload(prekeys(20))), deps, auth());
    const res = await getPrekeyBundleHandler(bundleEvent(USER), deps, auth('caller'));
    expect(res.statusCode).toBe(200);
    const bundle = parseBody<PrekeyBundle>(res.body);
    expect(bundle.userId).toBe(USER);
    expect(bundle.registrationId).toBe(42);
    expect(bundle.identityKey).toBe(B64);
    expect(bundle.signedPrekey.keyId).toBe(1);
    expect(bundle.oneTimePrekey?.keyId).toBe(1); // lowest keyId consumed first
    expect(bundle.lowPrekeyCount).toBeUndefined();
    expect(await db.countOneTimePrekeys(USER)).toBe(19);
  });

  it('sequential fetches hand out distinct one-time prekeys', async () => {
    await uploadKeysHandler(jsonPost(makeUpload(prekeys(3))), deps, auth());
    const ids: number[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await getPrekeyBundleHandler(bundleEvent(USER), deps, auth('caller'));
      ids.push(parseBody<PrekeyBundle>(res.body).oneTimePrekey!.keyId);
    }
    expect(new Set(ids).size).toBe(3);
    expect(ids).toEqual([1, 2, 3]);
  });

  it('empty pool: signed-prekey-only bundle with lowPrekeyCount', async () => {
    await uploadKeysHandler(jsonPost(makeUpload([])), deps, auth());
    const res = await getPrekeyBundleHandler(bundleEvent(USER), deps, auth('caller'));
    expect(res.statusCode).toBe(200);
    const bundle = parseBody<PrekeyBundle>(res.body);
    expect(bundle.oneTimePrekey).toBeUndefined();
    expect(bundle.lowPrekeyCount).toBe(true);
    expect(bundle.signedPrekey.keyId).toBe(1);
  });

  it('lowPrekeyCount toggles at the < 10 boundary', async () => {
    // 11 uploaded -> consume 1 -> 10 remain -> NOT low.
    await uploadKeysHandler(jsonPost(makeUpload(prekeys(11))), deps, auth());
    let bundle = parseBody<PrekeyBundle>(
      (await getPrekeyBundleHandler(bundleEvent(USER), deps, auth('caller'))).body,
    );
    expect(bundle.lowPrekeyCount).toBeUndefined();

    // Consume one more -> 9 remain -> low.
    bundle = parseBody<PrekeyBundle>(
      (await getPrekeyBundleHandler(bundleEvent(USER), deps, auth('caller'))).body,
    );
    expect(bundle.lowPrekeyCount).toBe(true);
  });

  it('404 when the target user has not uploaded keys', async () => {
    const res = await getPrekeyBundleHandler(bundleEvent(USER), deps, auth('caller'));
    expect(res.statusCode).toBe(404);
  });

  it('404 for an unknown user', async () => {
    const res = await getPrekeyBundleHandler(bundleEvent(NOBODY), deps, auth('caller'));
    expect(res.statusCode).toBe(404);
  });

  /**
   * The {userId} path param used to be checked
   * for presence only, then became the limiter key `prekey:<caller>:<userId>`
   * — a DynamoDB partition key with a 2 KB ceiling — so a multi-KB value made
   * the limiter's UpdateCommand throw ValidationException: a 500, not a 4xx.
   * A ULID or nothing, decided BEFORE any bucket is named. */
  it('a userId path param that is not a ULID is 400 invalid_request, and no limiter key is ever built from it', async () => {
    const takes: string[] = [];
    const inner = deps.rateLimit;
    deps.rateLimit = {
      take: async (bucket, opts) => {
        takes.push(bucket);
        return inner.take(bucket, opts);
      },
    };
    for (const bad of ['x'.repeat(3000), 'user-under-test', USER.toLowerCase(), '']) {
      const res = await getPrekeyBundleHandler(bundleEvent(bad), deps, auth('caller'));
      expect(res.statusCode, bad.slice(0, 20)).toBe(400);
      expect(parseBody<{ error: { code: string } }>(res.body).error.code).toBe('invalid_request');
    }
    expect(takes).toEqual([]);
  });

  /**
   * PUT /v1/keys was the only authenticated data-writing route with no budget:
   * every call replaces the whole one-time prekey pool (a pool Query, a batch
   * delete, up to ~80 BatchWrites), so it was loopable at whatever the stage
   * throttle admitted. The budget must still admit honest replenishment — one
   * upload a day plus a few lowPrekeyCount-triggered top-ups — which 5 burst /
   * 10 per hour does. */
  it('PUT /v1/keys is budgeted per account: a burst, then 429 with retry-after, refilling on the clock', async () => {
    for (let i = 0; i < LIMITS.keyUpload.capacity; i++) {
      expect((await uploadKeysHandler(jsonPost(makeUpload(prekeys(2))), deps, auth())).statusCode).toBe(204);
    }
    const limited = await uploadKeysHandler(jsonPost(makeUpload(prekeys(2))), deps, auth());
    expect(limited.statusCode).toBe(429);
    expect(limited.headers?.['retry-after']).toBeDefined();
    expect(parseBody<{ error: { code: string } }>(limited.body).error.code).toBe('rate_limited');
    // The refused upload changed nothing.
    expect(await db.countOneTimePrekeys(USER)).toBe(2);
    // Another account is its own bucket.
    await db.createUser({ userId: NOBODY, createdAt: deps.now() });
    expect((await uploadKeysHandler(jsonPost(makeUpload(prekeys(1))), deps, auth(NOBODY))).statusCode).toBe(204);
    // Sustained: one token per (3600 / 10) seconds.
    deps.advanceMs((3600 / 10) * 1000 + 1);
    expect((await uploadKeysHandler(jsonPost(makeUpload(prekeys(3))), deps, auth())).statusCode).toBe(204);
    expect(await db.countOneTimePrekeys(USER)).toBe(3);
  });

  it('400 when userId path param is missing', async () => {
    const res = await getPrekeyBundleHandler(
      { method: 'GET', path: '/', headers: {} },
      deps,
      auth('caller'),
    );
    expect(res.statusCode).toBe(400);
  });
});
