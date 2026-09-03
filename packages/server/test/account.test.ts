import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deleteAccountHandler, deleteAccountRoute } from '../src/handlers/account.js';
import { requireAuth } from '../src/handlers/auth.js';
import { json, type AuthContext, type HttpEvent } from '../src/handlers/http.js';
import { DeleteCommand, TransactWriteCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { IDKEY_CLAIM_PREFIX, makeDataLayer, type DataLayer } from '../src/db/data.js';
import { activityActorRef } from '../src/opaque-ref.js';
import {
  allQueued,
  makeMemoryDb,
  makeTestDeps,
  parseBody,
  testIdentityKey,
  type TestDeps,
} from './helpers.js';

/**
 * DELETE /v1/account: the account stops existing — the identity key can claim
 * a fresh account, the ID resolves to nobody, the prekey pool is gone, queued
 * ciphertext is purged, and the calling token is dead. The client wipes its
 * device only after this succeeds, so the promise "your ID stops working" is
 * never false.
 */

const IDENTITY_KEY = testIdentityKey(0x21);

function event(token = 'token-1'): HttpEvent {
  return {
    method: 'DELETE',
    path: '/v1/account',
    headers: { authorization: `Bearer ${token}` },
  };
}

describe('delete account', () => {
  let deps: TestDeps;
  let auth: AuthContext;

  beforeEach(async () => {
    // Salted: activity deletion is keyed by the opaque ref
    // and skipped entirely when no salt is present.
    deps = { ...makeTestDeps(makeMemoryDb()), userRefSalt: 'account-test-salt' };
    const resolution = await deps.db.getOrCreateUserByIdentityKey(IDENTITY_KEY, 'user-1', 1000);
    if (resolution.kind !== 'ok') throw new Error('fixture account was not created');
    const user = resolution.user;
    auth = { userId: user.userId };
    await deps.db.createSession({
      token: 'token-1',
      userId: user.userId,
      createdAt: 1000,
      expiresAt: 4_000_000_000,
    });
    await deps.db.storeKeys(
      user.userId,
      {
        registrationId: 7,
        // The SAME key the account was created under: storeKeys enforces
        // immutability, so a different one here would be refused and the
        // fixture would silently have no keys at all.
        identityKeyPub: IDENTITY_KEY,
        signedPrekey: { keyId: 1, pub: 'spk', sig: 'sig' },
        kyberPrekey: { keyId: 2, pub: 'kyber', sig: 'ksig' },
      },
      [{ keyId: 10, pub: 'otp-10' }],
    );
    await deps.db.enqueueMessage({
      recipientId: user.userId,
      msgId: '01QUEUED',
      senderId: 'user-2',
      type: 'ciphertext',
      payload: 'AAAA',
      ts: 2000,
      expiresAt: 4_000_000_000,
    });
    await deps.db.putConnection({
      userId: user.userId,
      connectionId: 'conn-1',
      connectedAt: 1500,
    });
    // A registered device, so the deletion sweep has a push-token row to
    // destroy. Without this the assertion below passes vacuously.
    await deps.db.putPushToken({
      userId: user.userId,
      voipToken: 'voip-token-1',
      alertToken: 'alert-token-1',
      env: 'sandbox',
      bundleId: 'com.miranatechnologies.tacendum',
      updatedAt: 1500,
      expiresAt: 4_000_000_000,
    });
  });

  it('deletes the user, frees the identity key, and revokes the calling session', async () => {
    const res = await deleteAccountHandler(event(), deps, auth);
    expect(res.statusCode).toBe(200);

    expect(await deps.db.getUserById('user-1')).toBeUndefined();
    expect(await deps.db.getUserByIdentityKeyClaim(IDENTITY_KEY)).toBeUndefined();
    // The claim row must go with the user, or the key resolves to a user row
    // that is gone — the 409 `account_conflict` state — and its owner could
    // never sign in again.
    expect(await deps.db.getUserById(`${IDKEY_CLAIM_PREFIX}${IDENTITY_KEY}`)).toBeUndefined();
    expect(await deps.db.getSession('token-1')).toBeUndefined();
  });

  it('deletes activity AFTER the user row — a refused delete destroys nothing', async () => {
    const calls: string[] = [];
    vi.spyOn(deps.db, 'deleteActivity').mockImplementation(async (userId, nowMs) => {
      calls.push(`activity:${userId}:${nowMs}`);
    });
    const originalDeleteUser = deps.db.deleteUser.bind(deps.db);
    // Forwards the guard too: deleteUser takes an optional third argument
    // and returns an outcome. A spy that drops
    // either would silently disarm the crew guards under test elsewhere.
    vi.spyOn(deps.db, 'deleteUser').mockImplementation(async (userId, claims, guard) => {
      calls.push(`user:${userId}`);
      return originalDeleteUser(userId, claims, guard);
    });

    await deleteAccountHandler(event(), deps, auth);

    // ORDER REVERSED ON MERGE, deliberately. This asserted
    // activity-then-user-row; the crew lane moved
    // every destructive step to AFTER the guarded row delete, so a
    // `crew_not_empty` refusal cannot return 409 having already destroyed the
    // caller's data — their activity history included.
    // Safe to reorder because the original sequence was not load-bearing:
    // `deleteActivity` writes a tombstone into the SEPARATE activity table
    // keyed by `actorHash` (data.ts) and never reads or depends on the user
    // row, exactly like the queue purge beside it.
    expect(calls).toEqual([
      `user:${auth.userId}`,
      // The activity tombstone is addressed by the salted opaque ref — the
      // raw userId never reaches the activity table path.
      `activity:${activityActorRef(auth.userId, 'account-test-salt')}:${deps.now()}`,
    ]);
  });

  it('purges the prekey pool, queued ciphertext, and the connection row', async () => {
    await deleteAccountHandler(event(), deps, auth);

    expect(await deps.db.consumeOneTimePrekey('user-1')).toBeUndefined();
    expect(await allQueued(deps.db, 'user-1')).toEqual([]);
    expect(await deps.db.getConnection('user-1')).toBeUndefined();
  });

  it('destroys the push-token row — a deleted account cannot be rung', async () => {
    // Nothing in the deletion path touched this row until
    // this fix; it lapsed on its own 90-day liveness TTL, so an Apple
    // device token bound to the account id — and the capability to ring that
    // phone — outlived the account by up to three months. App Store guideline
    // 5.1.1(v) requires deletion to reach associated personal data, and a
    // device identifier is exactly that.
    expect(await deps.db.getPushToken('user-1')).toBeDefined();

    await deleteAccountHandler(event(), deps, auth);

    expect(await deps.db.getPushToken('user-1')).toBeUndefined();
  });

  it('deleting an account with no registered device still succeeds', async () => {
    // The delete is unconditional and keyed by userId alone, which is what
    // makes the sweep retry-safe — but it also means the no-token case must
    // not throw. A client that never registered for push (notifications
    // denied at first launch) has no row at all.
    await deps.db.deletePushToken('user-1');

    const res = await deleteAccountHandler(event(), deps, auth);

    expect(res.statusCode).toBe(200);
    expect(await deps.db.getUserById('user-1')).toBeUndefined();
  });

  it('is idempotent — deleting an already-deleted account still succeeds', async () => {
    await deleteAccountHandler(event(), deps, auth);
    const again = await deleteAccountHandler(event(), deps, auth);
    expect(again.statusCode).toBe(200);
  });

  it('lets the same identity key claim a brand-new account afterwards', async () => {
    // Reinstall: same key on the same device. It must get a NEW account rather
    // than a conflict, which is only true if the claim row was really removed.
    await deleteAccountHandler(event(), deps, auth);
    const reborn = await deps.db.getOrCreateUserByIdentityKey(IDENTITY_KEY, 'user-99', 5000);
    expect(reborn.kind).toBe('ok');
    if (reborn.kind !== 'ok') return;
    expect(reborn.user.userId).toBe('user-99');
  });

  it('logs the deletion without the identity key', async () => {
    // The key identifies the account exactly as the phone number used to, so
    // it stays out of the retained operational log for the same reason.
    await deleteAccountHandler(event(), deps, auth);
    const entry = deps.logs.find(l => l.event === 'account_deleted');
    expect(entry).toBeDefined();
    expect(JSON.stringify(entry)).not.toContain(IDENTITY_KEY);
  });

  it('a crew appearing between the read-time check and the delete leg is refused (crew_not_empty)', async () => {
    // The read-then-delete gap, produced deterministically ('s backstop): the handler's read sees no crew and proceeds;
    // an adopt's committed footprint lands on the owner row before the
    // delete leg runs. The memory db mirrors the DynamoDB row condition, so
    // the delete must refuse rather than remove the owner of a live crew —
    // the crew.test.ts DDB suite proves the real condition; this pins the
    // handler mapping and keeps the mirror from drifting more permissive
    // than the store it stands in for.
    // Anchored ON the delete leg, not on an earlier destructive call. It used
    // to hook `purgeQueuedMessages` because the purges ran BEFORE the delete —
    // they were moved after it, precisely so a refusal
    // destroys nothing, so that hook no longer lands in the window at all.
    let purged = false;
    const raced: DataLayer = {
      ...deps.db,
      purgeQueuedMessages: async (recipientId) => {
        purged = true;
        return deps.db.purgeQueuedMessages(recipientId);
      },
      deleteUser: async (userId, claims, guard) => {
        // The adopt commits immediately before the delete leg. The memory db
        // serves live row references, so this is the committed write's exact
        // footprint.
        const row = await deps.db.getUserById('user-1');
        if (row) row.crewCount = 1;
        return deps.db.deleteUser(userId, claims, guard);
      },
    };
    const res = await deleteAccountHandler(event(), { ...deps, db: raced }, auth);
    expect(res.statusCode).toBe(409);
    expect(parseBody<{ error: { code: string } }>(res.body).error.code).toBe('crew_not_empty');

    // A REFUSED deletion destroys nothing. The 409 used to arrive
    // after the queue purge had already run, so the caller kept their account
    // and lost their undelivered ciphertext.
    expect(purged).toBe(false);

    // The owner row survived, and so did its claim — both-or-neither held.
    expect(await deps.db.getUserById('user-1')).toBeDefined();
    expect((await deps.db.getUserByIdentityKeyClaim(IDENTITY_KEY))?.userId).toBe('user-1');
    // The calling session survived too: the refusal precedes session
    // teardown, so the account remains authenticated and retryable.
    expect(await deps.db.getSession('token-1')).toBeDefined();
  });

  it('rate limits repeated deletion attempts per user (429)', async () => {
    for (let i = 0; i < 3; i++) {
      await deleteAccountHandler(event(), deps, auth);
    }
    const res = await deleteAccountHandler(event(), deps, auth);
    expect(res.statusCode).toBe(429);
    expect(res.headers?.['retry-after']).toBeDefined();
  });

  /**
   * The row goes
   * FIRST and the residue sweep runs after it, with sessions last, so that a
   * crash mid-sweep leaves the caller authenticated to re-run the sequence.
   * The bearer check then made `authenticate` refuse a session whose user row is
   * ABSENT — which is exactly the state a crashed sweep leaves behind — and
   * the idempotency cases above never noticed, because they hand the handler
   * a pre-built auth context and never pass through `authenticate`. These
   * two go THROUGH the wrapper the route tables wire. */
  it('a crash mid-sweep AFTER the row delete is retryable THROUGH requireAuth — the deletion route admits an absent-row session', async () => {
    // The sweep dies right after the guarded row delete (a Lambda timeout, a
    // DDB throttle): the user row is gone; the queue, prekeys, push token,
    // connection row and sessions are not.
    let crashed = false;
    const crashing: DataLayer = {
      ...deps.db,
      purgeQueuedMessages: async () => {
        crashed = true;
        throw new Error('simulated crash mid-sweep');
      },
    };
    await expect(deleteAccountRoute(event(), { ...deps, db: crashing })).rejects.toThrow(
      'simulated crash mid-sweep',
    );
    expect(crashed).toBe(true);
    expect(await deps.db.getUserById('user-1')).toBeUndefined();
    expect(await deps.db.userAccountState('user-1')).toBe('absent');
    expect((await allQueued(deps.db, 'user-1')).map((m) => m.msgId)).toEqual(['01QUEUED']);
    expect(await deps.db.getPushToken('user-1')).toBeDefined();
    expect(await deps.db.getSession('token-1')).toBeDefined();

    // Every OTHER route refuses this bearer now...
    const me = await requireAuth(async (_e, _d, a) => json(200, a))(event(), deps);
    expect(me.statusCode).toBe(401);

    // ...but the hintless retry of the deletion route, same bearer, finishes
    // the userId-keyed sweep: nothing is stranded.
    const retry = await deleteAccountRoute(event(), deps);
    expect(retry.statusCode).toBe(200);
    expect(await allQueued(deps.db, 'user-1')).toEqual([]);
    expect(await deps.db.consumeOneTimePrekey('user-1')).toBeUndefined();
    expect(await deps.db.getPushToken('user-1')).toBeUndefined();
    expect(await deps.db.getConnection('user-1')).toBeUndefined();
    expect(await deps.db.getSession('token-1')).toBeUndefined();
    // With the sessions gone the bearer is dead on this route too.
    expect((await deleteAccountRoute(event(), deps)).statusCode).toBe(401);
  });

  it('the deletion route still refuses a TOMBSTONED row — the exception is for a row that is GONE, never for a revoked one', async () => {
    // Live reference: the memory db serves rows by reference (see the
    // crew_not_empty race above), so this is a revoke's committed footprint.
    const row = await deps.db.getUserById('user-1');
    expect(row).toBeDefined();
    row!.tombstoned = true;
    expect(await deps.db.userAccountState('user-1')).toBe('tombstoned');

    const res = await deleteAccountRoute(event(), deps);
    expect(res.statusCode).toBe(401);
    // Refused at auth: nothing was destroyed.
    expect((await allQueued(deps.db, 'user-1')).map((m) => m.msgId)).toEqual(['01QUEUED']);
    expect(await deps.db.getPushToken('user-1')).toBeDefined();
    expect(await deps.db.getSession('token-1')).toBeDefined();
  });
});

/**
 * The deleteUser FALLBACK — the single-item row delete taken when the
 * transaction's claim leg refused because the claim is tombstoned — applied
 * only the empty-crew condition. The mirror guard (`requireNoCrewId`) was
 * dropped on that path, so its `crew_appeared`
 * answer could never fire there: a teardown that passed `requireNoCrewId`
 * together with an `identityKeyPub` would have deleted an adopted member's
 * row unconditionally and leaked the owner's slot. Latent with today's
 * callers; pinned on the wire with a scripted doc. */
describe('deleteUser fallback carries the SAME row condition as the transaction', () => {
  const USER = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
  const IDKEY = 'idkey-fallback-fixture';

  function scriptedDoc(fallbackRefuses: boolean): {
    deletes: DeleteCommand[];
    doc: DynamoDBDocumentClient;
  } {
    const deletes: DeleteCommand[] = [];
    const send = async (cmd: unknown): Promise<unknown> => {
      if (cmd instanceof TransactWriteCommand) {
        // The user leg passes, the claim leg refuses (tombstoned claim):
        // the exact shape that takes the fallback.
        throw Object.assign(new Error('cancelled'), {
          name: 'TransactionCanceledException',
          CancellationReasons: [{}, { Code: 'ConditionalCheckFailed' }],
        });
      }
      if (cmd instanceof DeleteCommand) {
        deletes.push(cmd);
        if (fallbackRefuses) {
          throw Object.assign(new Error('refused'), { name: 'ConditionalCheckFailedException' });
        }
        return {};
      }
      return {};
    };
    return { deletes, doc: { send } as unknown as DynamoDBDocumentClient };
  }

  it('requireNoCrewId: the fallback delete is conditioned on attribute_not_exists(crewId)', async () => {
    const { deletes, doc } = scriptedDoc(false);
    const db = makeDataLayer(doc);
    await expect(
      db.deleteUser(USER, { identityKeyPub: IDKEY }, { requireNoCrewId: true }),
    ).resolves.toBe('deleted');
    expect(deletes).toHaveLength(1);
    expect(deletes[0]!.input.ConditionExpression).toBe('attribute_not_exists(crewId)');
  });

  it("requireNoCrewId: a crewId that appeared in the gap answers 'crew_appeared' from the fallback, nothing deleted", async () => {
    const { deletes, doc } = scriptedDoc(true);
    const db = makeDataLayer(doc);
    await expect(
      db.deleteUser(USER, { identityKeyPub: IDKEY }, { requireNoCrewId: true }),
    ).resolves.toBe('crew_appeared');
    expect(deletes).toHaveLength(1);
  });

  it('requireEmptyCrew: the fallback keeps the empty-crew condition it always had', async () => {
    const { deletes, doc } = scriptedDoc(false);
    const db = makeDataLayer(doc);
    await expect(
      db.deleteUser(USER, { identityKeyPub: IDKEY }, { requireEmptyCrew: true }),
    ).resolves.toBe('deleted');
    expect(deletes[0]!.input.ConditionExpression).toBe(
      'attribute_not_exists(crewCount) OR crewCount = :zero',
    );
  });

  it('no guard: the fallback delete is unconditional', async () => {
    const { deletes, doc } = scriptedDoc(false);
    const db = makeDataLayer(doc);
    await expect(db.deleteUser(USER, { identityKeyPub: IDKEY })).resolves.toBe('deleted');
    expect(deletes[0]!.input.ConditionExpression).toBeUndefined();
  });
});
