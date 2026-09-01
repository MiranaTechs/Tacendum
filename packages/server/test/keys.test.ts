import { beforeEach, describe, expect, it } from 'vitest';
import type { OneTimePrekey, PrekeyBundle, UploadKeysRequest } from '@tacendum/shared';
import { uploadKeysHandler, getPrekeyBundleHandler } from '../src/handlers/keys.js';
import type { AuthContext, HttpEvent } from '../src/handlers/http.js';
import type { DataLayer } from '../src/db/data.js';
import { jsonPost, makeMemoryDb, makeTestDeps, parseBody, type TestDeps } from './helpers.js';

const USER = 'user-under-test';
const B64 = 'QUJDMTIz'; // "ABC123"

function auth(userId = USER): AuthContext {
  return { userId };
}

function bundleEvent(userId: string): HttpEvent {
  return { method: 'GET', path: '/', headers: {}, pathParameters: { userId } };
}

function makeUpload(oneTimePrekeys: OneTimePrekey[]): UploadKeysRequest {
  return {
    registrationId: 42,
    identityKey: B64,
    signedPrekey: { keyId: 1, pub: B64, sig: B64 },
    kyberPrekey: { keyId: 1, pub: B64, sig: B64 },
    oneTimePrekeys,
  };
}

function prekeys(n: number): OneTimePrekey[] {
  return Array.from({ length: n }, (_, i) => ({ keyId: i + 1, pub: B64 }));
}

describe('key distribution', () => {
  let db: DataLayer;
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
    expect(user?.signedPrekey).toEqual({ keyId: 1, pub: B64, sig: B64 });
    expect(user?.kyberPrekey).toEqual({ keyId: 1, pub: B64, sig: B64 });
    expect(await db.countOneTimePrekeys(USER)).toBe(5);
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
      { keyId: 7, pub: B64 },
      { keyId: 7, pub: B64 },
      { keyId: 8, pub: B64 },
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
    const res = await getPrekeyBundleHandler(bundleEvent('nobody'), deps, auth('caller'));
    expect(res.statusCode).toBe(404);
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
