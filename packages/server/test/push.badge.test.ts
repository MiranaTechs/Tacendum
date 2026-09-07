import { beforeEach, describe, expect, it } from 'vitest';
import { deliverPushWake } from '../src/handlers/push-worker.js';
import { registerPushTokenHandler } from '../src/handlers/push.js';
import type { AuthContext, HttpEvent } from '../src/handlers/http.js';
import type { TestOnlyDataLayer } from '../src/db/data.js';
import { makeMemoryDb, makeTestDeps, type TestDeps } from './helpers.js';

/**
 * Two things that between them meant a device could receive no notifications
 * at all, and the badge that goes with them.
 *
 * The bug these were written for: a registration required a VoIP token, and
 * the client would not send an alert token without one. A phone that granted
 * the notification permission but produced no PushKit credentials — the
 * ordinary case for a build whose registry has not yet come up — registered
 * NOTHING. The push-token table was empty and every message notification
 * failed at the first step, silently, because a failed push is best-effort by
 * contract and never surfaces anywhere the user can see.
 *
 * So: either token alone must register, and a message push must carry a badge.
 */

const ALICE: AuthContext = { userId: 'user-alice' };
const VOIP = 'a'.repeat(64);
const ALERT = 'b'.repeat(64);
const SENDER = 'user-bob';

function put(body: unknown): HttpEvent {
  return {
    method: 'PUT',
    path: '/v1/push-token',
    headers: {},
    body: JSON.stringify(body),
  };
}

const BASE = { env: 'sandbox' as const, bundleId: 'com.miranatechnologies.tacendum' };

/** Count calls to `listQueuedMessages` by wrapping it in place. */
function jest_fn_listQueued(target: TestOnlyDataLayer): { calls: number } {
  const counter = { calls: 0 };
  const original = target.listQueuedMessages.bind(target);
  // Plain pass-through, not `async`: the method returns an AsyncIterable of
  // pages, and wrapping that in a promise would break `for await` consumers.
  target.listQueuedMessages = (recipientId: string) => {
    counter.calls += 1;
    return original(recipientId);
  };
  return counter;
}

let db: TestOnlyDataLayer;
let deps: TestDeps;
beforeEach(async () => {
  db = makeMemoryDb();
  deps = makeTestDeps(db);
  // registerPushTokenHandler is normally reached through requireAuth, whose
  // strong account-state read guarantees this row exists at admission. Keep
  // direct handler tests honest about that precondition.
  await db.createUser({ userId: ALICE.userId, createdAt: deps.now() });
});

describe('a device registers whichever tokens it actually has', () => {
  it('accepts an ALERT token with no VoIP token', async () => {
    const result = await registerPushTokenHandler(put({ ...BASE, alertToken: ALERT }), deps, ALICE);

    expect(result.statusCode).toBe(204);
    const stored = await db.getPushToken(ALICE.userId);
    expect(stored?.alertToken).toBe(ALERT);
    // Not stored as '' or null: DynamoDB rejects an explicit undefined, and a
    // falsy-but-present token would be handed to APNs.
    expect(stored?.voipToken).toBeUndefined();
  });

  it('accepts a VoIP token with no alert token', async () => {
    const result = await registerPushTokenHandler(put({ ...BASE, voipToken: VOIP }), deps, ALICE);

    expect(result.statusCode).toBe(204);
    expect((await db.getPushToken(ALICE.userId))?.voipToken).toBe(VOIP);
  });

  it('refuses a registration with NEITHER token', async () => {
    // A row with no token is a row nothing can ever be sent to. Rejected
    // rather than written, so the table cannot fill with dead rows that each
    // cost a lookup per message.
    const result = await registerPushTokenHandler(put(BASE), deps, ALICE);

    expect(result.statusCode).toBe(400);
    expect(await db.getPushToken(ALICE.userId)).toBeUndefined();
  });

  it('still refuses a token that is not hex — optional is not unvalidated', async () => {
    const result = await registerPushTokenHandler(
      put({ ...BASE, alertToken: 'not-hex-'.repeat(8) }),
      deps,
      ALICE,
    );

    expect(result.statusCode).toBe(400);
  });
});

describe('the badge the server deliberately does NOT send', () => {
  beforeEach(async () => {
    await db.createUser({ userId: ALICE.userId, createdAt: deps.now() });
    await db.putPushToken({
      userId: ALICE.userId,
      alertToken: ALERT,
      env: 'sandbox',
      bundleId: BASE.bundleId,
      updatedAt: deps.now(),
      expiresAt: Math.floor(deps.now() / 1000) + 86_400,
    });
  });

  const queue = async (msgId: string) =>
    db.enqueueMessage({
      recipientId: ALICE.userId,
      msgId,
      senderId: SENDER,
      type: 'ciphertext',
      payload: 'QUJD',
      ts: deps.now(),
      expiresAt: Math.floor(deps.now() / 1000) + 86_400,
    });

  const push = async (msgId: string) =>
    deliverPushWake(
      {
        recipientId: ALICE.userId,
        senderUserId: SENDER,
        kind: 'message',
        message: { msgId, msgType: 'ciphertext', payload: 'QUJD', ts: deps.now() },
      },
      deps,
    );

  it('sends no badge, however many frames are queued', async () => {
    // THIS TEST USED TO ASSERT THE OPPOSITE — that the badge equals the queue
    // depth — and the rule was wrong.
    //
    // Read receipts, reactions, profile-card syncs, edits and deletions all
    // travel as ordinary encrypted frames through this same queue, and every
    // one of them is a CARRIER on arrival: it rewrites an existing row and
    // never becomes a message (`isCarrierEnvelope`). Counting the queue counts
    // all of them, and the worst case inverts the feature — somebody READING
    // your messages sends a receipt, which queues, which raises YOUR badge.
    //
    // The server cannot separate them. The distinction is inside the
    // ciphertext, and a "this one is only transport" flag would hand the
    // server exactly the metadata this design refuses it.
    await queue('msg-1');
    await queue('msg-2');
    await queue('msg-3');

    await push('msg-3');

    expect(deps.alertsSent).toEqual([{ userId: ALICE.userId, msgId: 'msg-3', badge: undefined }]);
  });

  it('does not read the queue at all on the push path', async () => {
    // Not merely "computes nothing from it" — does not touch it. A count that
    // is read and then discarded is a DynamoDB query per push, on the path
    // whose entire contract is that it must not slow message delivery down.
    const spy = jest_fn_listQueued(db);

    await queue('msg-1');
    await push('msg-1');

    expect(spy.calls).toBe(0);
  });

  it('still delivers the notification itself', async () => {
    // The point of removing the badge was to stop showing a wrong number, not
    // to stop notifying.
    await queue('msg-1');
    await push('msg-1');

    expect(deps.alertsSent).toHaveLength(1);
    expect(deps.alertsSent[0]?.msgId).toBe('msg-1');
  });
});

describe('a registration never downgrades the row', () => {
  it('a voip-only PUT keeps the stored alert token', async () => {
    // The launch race: the first upload of every launch runs before APNs has
    // answered, so it carries the VoIP token alone — and a whole-row replace
    // erased the alert token the previous session registered. Notifications
    // that work exactly once and then never again.
    await registerPushTokenHandler(
      put({ ...BASE, voipToken: VOIP, alertToken: ALERT }),
      deps,
      ALICE,
    );

    await registerPushTokenHandler(put({ ...BASE, voipToken: VOIP }), deps, ALICE);

    const stored = await db.getPushToken(ALICE.userId);
    expect(stored?.alertToken).toBe(ALERT);
    expect(stored?.voipToken).toBe(VOIP);
  });

  it('an alert-only PUT keeps the stored voip token', async () => {
    await registerPushTokenHandler(
      put({ ...BASE, voipToken: VOIP, alertToken: ALERT }),
      deps,
      ALICE,
    );

    await registerPushTokenHandler(put({ ...BASE, alertToken: ALERT }), deps, ALICE);

    expect((await db.getPushToken(ALICE.userId))?.voipToken).toBe(VOIP);
  });

  it('does NOT carry tokens across an env change', async () => {
    // A token minted for the other APNs host is not a token. Carrying it
    // across a sandbox/production reinstall would aim every push at a host
    // that has never heard of it.
    await registerPushTokenHandler(
      put({ ...BASE, voipToken: VOIP, alertToken: ALERT }),
      deps,
      ALICE,
    );

    await registerPushTokenHandler(
      put({ ...BASE, env: 'production', voipToken: 'c'.repeat(64) }),
      deps,
      ALICE,
    );

    const stored = await db.getPushToken(ALICE.userId);
    expect(stored?.env).toBe('production');
    expect(stored?.alertToken).toBeUndefined();
    expect(stored?.voipToken).toBe('c'.repeat(64));
  });

  it('a fresh token still replaces the stored one', async () => {
    await registerPushTokenHandler(put({ ...BASE, alertToken: ALERT }), deps, ALICE);

    await registerPushTokenHandler(put({ ...BASE, alertToken: 'd'.repeat(64) }), deps, ALICE);

    expect((await db.getPushToken(ALICE.userId))?.alertToken).toBe('d'.repeat(64));
  });
});

describe('pruning a dead token', () => {
  const bothTokens = async () => {
    await db.createUser({ userId: ALICE.userId, createdAt: deps.now() });
    await db.putPushToken({
      userId: ALICE.userId,
      voipToken: VOIP,
      alertToken: ALERT,
      env: 'sandbox',
      bundleId: BASE.bundleId,
      updatedAt: deps.now(),
      expiresAt: Math.floor(deps.now() / 1000) + 86_400,
    });
  };

  it('a dead ALERT token takes only the alert token — the VoIP one keeps ringing', async () => {
    // The counterexample: a half-rotated row (fresh VoIP, stale
    // alert) where the stale alert's 410 deleted the WHOLE row and silenced
    // calls entirely. The prune is field-level now, keyed on which push
    // failed.
    await bothTokens();
    const dead: TestDeps = {
      ...deps,
      push: { ...deps.push, notify: async () => 'token_invalid' as const },
    };

    const outcome = await deliverPushWake(
      {
        recipientId: ALICE.userId,
        senderUserId: SENDER,
        kind: 'message',
        message: { msgId: 'm', msgType: 'ciphertext', payload: 'QUJD', ts: deps.now() },
      },
      dead,
    );

    expect(outcome).toBe('token_invalid');
    const row = await db.getPushToken(ALICE.userId);
    expect(row?.alertToken).toBeUndefined();
    expect(row?.voipToken).toBe(VOIP);
  });

  it('a dead VOIP token takes only the voip token — banners keep arriving', async () => {
    await bothTokens();
    const dead: TestDeps = {
      ...deps,
      push: { ...deps.push, wake: async () => 'token_invalid' as const },
    };

    const outcome = await deliverPushWake(
      { recipientId: ALICE.userId, senderUserId: SENDER },
      dead,
    );

    expect(outcome).toBe('token_invalid');
    const row = await db.getPushToken(ALICE.userId);
    expect(row?.voipToken).toBeUndefined();
    expect(row?.alertToken).toBe(ALERT);
  });

  it('the row goes only when NOTHING usable remains', async () => {
    await db.createUser({ userId: ALICE.userId, createdAt: deps.now() });
    await db.putPushToken({
      userId: ALICE.userId,
      alertToken: ALERT,
      env: 'sandbox',
      bundleId: BASE.bundleId,
      updatedAt: deps.now(),
      expiresAt: Math.floor(deps.now() / 1000) + 86_400,
    });
    const dead: TestDeps = {
      ...deps,
      push: { ...deps.push, notify: async () => 'token_invalid' as const },
    };

    await deliverPushWake(
      {
        recipientId: ALICE.userId,
        senderUserId: SENDER,
        kind: 'message',
        message: { msgId: 'm', msgType: 'ciphertext', payload: 'QUJD', ts: deps.now() },
      },
      dead,
    );

    expect(await db.getPushToken(ALICE.userId)).toBeUndefined();
  });

  it('a dead FCM token takes the row — one token serves both lanes on Android', async () => {
    // UNREGISTERED from Google on EITHER kind of wake condemns the same one
    // token so unlike the iOS half-row prunes above there is nothing
    // usable left and the tidy delete removes the row itself. Still the
    // conditional field-level discipline: a re-registration racing this
    // prune keeps its fresh token (the memory twin mirrors the store's
    // condition).
    const FCM = `device-instance-id:APA91b${'x'.repeat(120)}`;
    await db.createUser({ userId: ALICE.userId, createdAt: deps.now() });
    await db.putPushToken({
      userId: ALICE.userId,
      platform: 'android',
      fcmToken: FCM,
      bundleId: BASE.bundleId,
      updatedAt: deps.now(),
      expiresAt: Math.floor(deps.now() / 1000) + 86_400,
    });
    const dead: TestDeps = {
      ...deps,
      push: { ...deps.push, wake: async () => 'token_invalid' as const },
    };

    const outcome = await deliverPushWake(
      { recipientId: ALICE.userId, senderUserId: SENDER },
      dead,
    );

    expect(outcome).toBe('token_invalid');
    expect(await db.getPushToken(ALICE.userId)).toBeUndefined();
    // The prune log names the field, never the token.
    expect(deps.logs).toContainEqual({
      event: 'push_token_pruned',
      fields: { field: 'fcmToken' },
    });
  });

  it('a dead FCM token on the MESSAGE lane prunes fcmToken too — not alertToken', async () => {
    // The iOS mapping (message -> alertToken) must not leak onto Android:
    // an Android row has no alertToken, and a prune keyed on the wrong
    // field would be a silent no-op leaving a dead token to fail forever.
    const FCM = `device-instance-id:APA91b${'y'.repeat(120)}`;
    await db.createUser({ userId: ALICE.userId, createdAt: deps.now() });
    await db.putPushToken({
      userId: ALICE.userId,
      platform: 'android',
      fcmToken: FCM,
      bundleId: BASE.bundleId,
      updatedAt: deps.now(),
      expiresAt: Math.floor(deps.now() / 1000) + 86_400,
    });
    const dead: TestDeps = {
      ...deps,
      push: { ...deps.push, notify: async () => 'token_invalid' as const },
    };

    const outcome = await deliverPushWake(
      {
        recipientId: ALICE.userId,
        senderUserId: SENDER,
        kind: 'message',
        message: { msgId: 'm', msgType: 'ciphertext', payload: 'QUJD', ts: deps.now() },
      },
      dead,
    );

    expect(outcome).toBe('token_invalid');
    expect(await db.getPushToken(ALICE.userId)).toBeUndefined();
    expect(deps.logs).toContainEqual({
      event: 'push_token_pruned',
      fields: { field: 'fcmToken' },
    });
  });
});

describe('push wake outcomes', () => {
  const registerVoipToken = async () => {
    await db.putPushToken({
      userId: ALICE.userId,
      voipToken: VOIP,
      env: 'sandbox',
      bundleId: BASE.bundleId,
      updatedAt: deps.now(),
      expiresAt: Math.floor(deps.now() / 1000) + 86_400,
    });
  };

  it('returns `no_token` when the recipient has no push-token row', async () => {
    await expect(
      deliverPushWake({ recipientId: ALICE.userId, senderUserId: SENDER }, deps),
    ).resolves.toBe('no_token');
  });

  it.each([
    { state: 'absent' as const, userId: 'user-deleted' },
    { state: 'tombstoned' as const, userId: 'user-revoked' },
  ])(
    'refuses a delayed wake for a $state recipient even when a stale token row exists',
    async ({ state, userId }) => {
      if (state === 'tombstoned') {
        await db.createUser({ userId, createdAt: deps.now(), tombstoned: true });
      }
      await db.putPushToken({
        userId,
        voipToken: VOIP,
        env: 'sandbox',
        bundleId: BASE.bundleId,
        updatedAt: deps.now(),
        expiresAt: Math.floor(deps.now() / 1000) + 86_400,
      });

      await expect(
        deliverPushWake({ recipientId: userId, senderUserId: SENDER }, deps),
      ).resolves.toBe('no_token');
      expect(deps.pushesSent).toEqual([]);
    },
  );

  it('still wakes a newly-created account using the same physical device token', async () => {
    const newUserId = 'user-new-account';
    await db.createUser({ userId: newUserId, createdAt: deps.now() });
    await db.putPushToken({
      userId: newUserId,
      voipToken: VOIP,
      env: 'sandbox',
      bundleId: BASE.bundleId,
      updatedAt: deps.now(),
      expiresAt: Math.floor(deps.now() / 1000) + 86_400,
    });

    await expect(
      deliverPushWake({ recipientId: newUserId, senderUserId: SENDER }, deps),
    ).resolves.toBe('sent');
    expect(deps.pushesSent).toEqual([{ userId: newUserId, fromUserId: SENDER }]);
  });

  it.each(['sent', 'failed'] as const)('returns sender outcome `%s` unchanged', async (outcome) => {
    await registerVoipToken();
    const outcomeDeps: TestDeps = {
      ...deps,
      push: { ...deps.push, wake: async () => outcome },
    };

    await expect(
      deliverPushWake({ recipientId: ALICE.userId, senderUserId: SENDER }, outcomeDeps),
    ).resolves.toBe(outcome);
  });

  it('returns `failed` when lookup or delivery throws', async () => {
    const failingDeps: TestDeps = {
      ...deps,
      db: {
        ...deps.db,
        getPushToken: async () => {
          throw new Error('database unavailable');
        },
      },
    };

    await expect(
      deliverPushWake({ recipientId: ALICE.userId, senderUserId: SENDER }, failingDeps),
    ).resolves.toBe('failed');
  });
});
