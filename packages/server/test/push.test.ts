import { beforeEach, describe, expect, it } from 'vitest';
import {
  deletePushTokenHandler,
  registerPushTokenHandler,
} from '../src/handlers/push.js';
import type { AuthContext, HttpEvent } from '../src/handlers/http.js';
import type { TestOnlyDataLayer } from '../src/db/data.js';
import { makeMemoryDb, makeTestDeps, parseBody, type TestDeps } from './helpers.js';

/**
 * PUT/DELETE /v1/push-token. The token is the capability to
 * wake someone's phone, so the only thing that matters here is that a caller
 * can write exactly one row — their own — and that the endpoint is write-only:
 * there is deliberately no read route, because a readable token store would be
 * a harvesting primitive.
 */

const ALICE: AuthContext = { userId: 'user-alice' };
const BOB: AuthContext = { userId: 'user-bob' };
const TOKEN_A = 'a'.repeat(64);
const TOKEN_B = 'b'.repeat(64);

function put(body: unknown): HttpEvent {
  return {
    method: 'PUT',
    path: '/v1/push-token',
    headers: {},
    body: JSON.stringify(body),
  };
}
const del = (): HttpEvent => ({
  method: 'DELETE',
  path: '/v1/push-token',
  headers: {},
});

const VALID = {
  voipToken: TOKEN_A,
  env: 'sandbox' as const,
  bundleId: 'com.miranatechnologies.tacendum',
};

let db: TestOnlyDataLayer;
let deps: TestDeps;
beforeEach(() => {
  db = makeMemoryDb();
  deps = makeTestDeps(db);
});

describe('registering a token', () => {
  it('stores the caller\'s token and answers 204', async () => {
    const result = await registerPushTokenHandler(put(VALID), deps, ALICE);
    expect(result.statusCode).toBe(204);

    const stored = await db.getPushToken(ALICE.userId);
    expect(stored).toMatchObject({
      userId: ALICE.userId,
      voipToken: TOKEN_A,
      env: 'sandbox',
      bundleId: VALID.bundleId,
    });
  });

  it('is idempotent, and a re-registration replaces the old token', async () => {
    await registerPushTokenHandler(put(VALID), deps, ALICE);
    await registerPushTokenHandler(
      put({ ...VALID, voipToken: TOKEN_B, env: 'production' }),
      deps,
      ALICE,
    );
    const stored = await db.getPushToken(ALICE.userId);
    expect(stored?.voipToken).toBe(TOKEN_B);
    expect(stored?.env).toBe('production');
  });

  it('sets a TTL so a token nobody has refreshed in a quarter expires', async () => {
    await registerPushTokenHandler(put(VALID), deps, ALICE);
    const stored = await db.getPushToken(ALICE.userId);
    const ninetyDays = 90 * 24 * 3600;
    expect(stored?.expiresAt).toBe(Math.floor(deps.now() / 1000) + ninetyDays);
  });

  it('rejects a malformed token instead of storing something APNs will refuse', async () => {
    for (const body of [
      { ...VALID, voipToken: 'nope' },
      { ...VALID, voipToken: 'z'.repeat(64) },
      { ...VALID, env: 'staging' },
      { ...VALID, bundleId: '' },
      {},
    ]) {
      const result = await registerPushTokenHandler(put(body), deps, ALICE);
      expect(result.statusCode).toBe(400);
      expect(parseBody<{ error: { code: string } }>(result.body).error.code).toBe(
        'invalid_request',
      );
    }
    expect(await db.getPushToken(ALICE.userId)).toBeUndefined();
  });

  it('writes ONLY to the caller\'s own row — the body cannot name another user', async () => {
    // There is no userId field in the request by design; prove that smuggling
    // one changes nothing about which row is written.
    await registerPushTokenHandler(
      put({ ...VALID, userId: BOB.userId }),
      deps,
      ALICE,
    );
    expect(await db.getPushToken(ALICE.userId)).toBeDefined();
    expect(await db.getPushToken(BOB.userId)).toBeUndefined();
  });

  it('never logs the token itself — it is the capability to ring a phone', async () => {
    await registerPushTokenHandler(put(VALID), deps, ALICE);
    expect(JSON.stringify(deps.logs)).not.toContain(TOKEN_A);
  });

  it('rate-limits writes per user', async () => {
    let limited = 0;
    for (let i = 0; i < 14; i++) {
      const r = await registerPushTokenHandler(put(VALID), deps, ALICE);
      if (r.statusCode === 429) limited++;
    }
    expect(limited).toBeGreaterThan(0);
    expect(
      (await registerPushTokenHandler(put(VALID), deps, BOB)).statusCode,
    ).toBe(204);
  });
});

describe('registering an ANDROID token', () => {
  const FCM_TOKEN = `device-instance-id:APA91b${'x'.repeat(120)}`;
  const VALID_ANDROID = {
    platform: 'android' as const,
    fcmToken: FCM_TOKEN,
    bundleId: 'com.miranatechnologies.tacendum',
  };

  it('stores one FCM token under the platform discriminator, with NO env', async () => {
    const result = await registerPushTokenHandler(put(VALID_ANDROID), deps, ALICE);
    expect(result.statusCode).toBe(204);

    const stored = await db.getPushToken(ALICE.userId);
    expect(stored).toMatchObject({
      userId: ALICE.userId,
      platform: 'android',
      fcmToken: FCM_TOKEN,
      bundleId: VALID_ANDROID.bundleId,
    });
    // FCM has no sandbox/production host split; a made-up value here would
    // be a stored lie the sender then appears to route on.
    expect(stored?.env).toBeUndefined();
    expect(stored?.voipToken).toBeUndefined();
    expect(stored?.alertToken).toBeUndefined();
  });

  it('a platform switch replaces the row TOTALLY, in both directions', async () => {
    // iOS -> Android: the APNs tokens die with the row. A row claiming both
    // platforms would make the routing discriminator ambiguous.
    await registerPushTokenHandler(put(VALID), deps, ALICE);
    await registerPushTokenHandler(put(VALID_ANDROID), deps, ALICE);
    let stored = await db.getPushToken(ALICE.userId);
    expect(stored?.platform).toBe('android');
    expect(stored?.voipToken).toBeUndefined();
    expect(stored?.env).toBeUndefined();

    // Android -> iOS: the iOS merge falls through its own env condition on
    // an Android row into a whole-row replace, so the FCM token dies too.
    await registerPushTokenHandler(put(VALID), deps, ALICE);
    stored = await db.getPushToken(ALICE.userId);
    expect(stored?.platform).toBeUndefined();
    expect(stored?.fcmToken).toBeUndefined();
    expect(stored?.voipToken).toBe(TOKEN_A);
    expect(stored?.env).toBe('sandbox');
  });

  it('rejects an FCM token on the legacy shape — the hex gate still holds', async () => {
    const result = await registerPushTokenHandler(
      put({ voipToken: FCM_TOKEN, env: 'sandbox', bundleId: VALID.bundleId }),
      deps,
      ALICE,
    );
    expect(result.statusCode).toBe(400);
    expect(await db.getPushToken(ALICE.userId)).toBeUndefined();
  });

  it('never logs the FCM token — it is the capability to wake a phone', async () => {
    await registerPushTokenHandler(put(VALID_ANDROID), deps, ALICE);
    expect(JSON.stringify(deps.logs)).not.toContain(FCM_TOKEN);
    // What IS logged: the platform, so the registration stream stays
    // observable per network without a token in sight.
    expect(deps.logs).toContainEqual({
      event: 'push_token_registered',
      fields: { platform: 'android' },
    });
  });

  it('sets the same 90-day TTL the iOS row gets', async () => {
    await registerPushTokenHandler(put(VALID_ANDROID), deps, ALICE);
    const stored = await db.getPushToken(ALICE.userId);
    expect(stored?.expiresAt).toBe(Math.floor(deps.now() / 1000) + 90 * 24 * 3600);
  });
});

describe('deleting a token', () => {
  it('removes the caller\'s row on logout', async () => {
    await registerPushTokenHandler(put(VALID), deps, ALICE);
    const result = await deletePushTokenHandler(del(), deps, ALICE);
    expect(result.statusCode).toBe(204);
    expect(await db.getPushToken(ALICE.userId)).toBeUndefined();
  });

  it('is idempotent — deleting nothing is still 204', async () => {
    expect((await deletePushTokenHandler(del(), deps, ALICE)).statusCode).toBe(204);
    expect((await deletePushTokenHandler(del(), deps, ALICE)).statusCode).toBe(204);
  });

  it('cannot delete someone else\'s token', async () => {
    await registerPushTokenHandler(put(VALID), deps, ALICE);
    await deletePushTokenHandler(del(), deps, BOB);
    expect(await db.getPushToken(ALICE.userId)).toBeDefined();
  });
});
