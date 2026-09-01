import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SendFrame, ServerFrame } from '@tacendum/shared';
import { wsDefaultHandler, type WsDeps } from '../src/handlers/ws.js';
import {
  integrationBindHandler,
  integrationRevokeHandler,
} from '../src/handlers/integrations.js';
import { registerPushTokenHandler } from '../src/handlers/push.js';
import { deleteAccountHandler } from '../src/handlers/account.js';
import { activityActorRef } from '../src/opaque-ref.js';
import type { AuthContext, HttpEvent } from '../src/handlers/http.js';
import type { DataLayer } from '../src/db/data.js';
import { allQueued, makeMemoryDb, makeTestDeps, parseBody, type TestDeps } from './helpers.js';

/**
 * Integration-account enforcement.
 *
 * The property under test is the single-recipient binding: an integration
 * account can put bytes on exactly one phone — its owner's — and nothing
 * else. That one control is what makes mass minting pointless, spam to
 * strangers impossible, and prompt-injection exfil a message to the victim's
 * own device.
 */

// Valid Crockford-base32 ULIDs (the alphabet excludes I, L, O, U): the bind
// route validates its owner field as a Ulid, so these must actually parse.
const OWNER = '01AAAAAAAAAAAAAAAAAAAAAAAA';
const BOT = '01BBBBBBBBBBBBBBBBBBBBBBBB';
const HUMAN = '01CCCCCCCCCCCCCCCCCCCCCCCC';
const STRANGER = '01DDDDDDDDDDDDDDDDDDDDDDDD';
const MSG = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

let db: DataLayer;
let deps: TestDeps;
let wsDeps: WsDeps;
let posted: Array<{ connectionId: string; frame: ServerFrame }>;

function makeFakeSender() {
  const sink: Array<{ connectionId: string; frame: ServerFrame }> = [];
  return {
    posted: sink,
    async post(connectionId: string, frame: ServerFrame): Promise<boolean> {
      sink.push({ connectionId, frame });
      return true;
    },
  };
}

/** Create an account directly at the data layer, class included. */
async function mkAccount(
  userId: string,
  accountClass?: 'integration',
): Promise<void> {
  const res = await db.getOrCreateUserByIdentityKey(
    `idkey-for-${userId}`,
    userId,
    Date.parse('2026-07-27T00:00:00Z'),
    accountClass,
  );
  expect(res.kind).toBe('ok');
}

async function bind(caller: string, owner: unknown) {
  const event: HttpEvent = {
    method: 'POST',
    path: '/v1/integrations/bind',
    headers: { 'content-type': 'application/json' },
    pathParameters: {},
    body: JSON.stringify({ owner }),
    sourceIp: '198.51.100.7',
  };
  const auth: AuthContext = { userId: caller };
  return integrationBindHandler(event, deps, auth);
}

async function revoke(caller: string, target: string) {
  const event: HttpEvent = {
    method: 'DELETE',
    path: `/v1/integrations/${target}`,
    headers: {},
    pathParameters: { userId: target },
    sourceIp: '198.51.100.7',
  };
  const auth: AuthContext = { userId: caller };
  return integrationRevokeHandler(event, deps, auth);
}

async function send(from: string, frame: Partial<SendFrame> = {}) {
  return wsDefaultHandler(
    {
      routeKey: '$default' as const,
      connectionId: `conn-${from}`,
      senderUserId: from,
      body: JSON.stringify({
        type: 'send',
        to: OWNER,
        msgId: MSG,
        msgType: 'ciphertext',
        payload: 'QUJD',
        ...frame,
      }),
    },
    wsDeps,
  );
}

function errorCodePosted(): string | undefined {
  const err = posted.map((p) => p.frame).find((f) => f.type === 'error');
  return err && err.type === 'error' ? err.code : undefined;
}

async function queuedFor(recipient: string): Promise<number> {
  return (await allQueued(db, recipient)).length;
}

beforeEach(async () => {
  db = makeMemoryDb();
  // Salted: the revoke's activity tombstone is addressed
  // by the opaque ref and skipped entirely when no salt is present.
  deps = { ...makeTestDeps(db), userRefSalt: 'integrations-test-salt' };
  const sender = makeFakeSender();
  posted = sender.posted;
  wsDeps = {
    ...deps,
    sender,
    scheduleDrain: async () => {},
    schedulePush: async (userId, fromUserId) => {
      deps.pushesSent.push({ userId, fromUserId });
    },
  };
  await mkAccount(OWNER);
  await mkAccount(HUMAN);
  await mkAccount(STRANGER);
  await mkAccount(BOT, 'integration');
});

describe('send enforcement', () => {
  it('an unbound integration cannot send at all', async () => {
    const res = await send(BOT);
    expect(res.statusCode).toBe(403);
    expect(errorCodePosted()).toBe('integration_unbound');
    expect(await queuedFor(OWNER)).toBe(0);
  });

  it('a bound integration sends to its owner', async () => {
    await bind(BOT, OWNER);
    const res = await send(BOT);
    expect(res.statusCode).toBe(200);
    expect(await queuedFor(OWNER)).toBe(1);
  });

  it('a bound integration cannot message anyone else', async () => {
    await bind(BOT, OWNER);
    const res = await send(BOT, { to: STRANGER });
    expect(res.statusCode).toBe(403);
    expect(errorCodePosted()).toBe('integration_recipient_forbidden');
    expect(await queuedFor(STRANGER)).toBe(0);
  });

  it('refuses urgent frames from integrations — no ring, no push', async () => {
    await bind(BOT, OWNER);
    const res = await send(BOT, { urgent: true });
    expect(res.statusCode).toBe(403);
    expect(errorCodePosted()).toBe('integration_urgent_forbidden');
    expect(await queuedFor(OWNER)).toBe(0);
    expect(deps.pushesSent).toHaveLength(0);
  });

  it('integrations get the tighter class quota; humans keep theirs', async () => {
    await bind(BOT, OWNER);
    // LIMITS.integrationSend capacity is 10. The 11th burst send must refuse.
    for (let i = 0; i < 10; i++) {
      const r = await send(BOT, { msgId: MSG.slice(0, 25) + 'ABCDEFGHJK'[i]! });
      expect(r.statusCode).toBe(200);
    }
    const over = await send(BOT, { msgId: MSG.slice(0, 25) + 'M' });
    expect(over.statusCode).toBe(429);
    expect(errorCodePosted()).toBe('rate_limited');

    // A human under the same clock still sends: wsSend capacity is 30.
    for (let i = 0; i < 11; i++) {
      const r = await send(HUMAN, { msgId: MSG.slice(0, 24) + 'Z' + 'ABCDEFGHJKM'[i]! });
      expect(r.statusCode).toBe(200);
    }
  });

  it('human sends are byte-identical to before (control)', async () => {
    const res = await send(HUMAN);
    expect(res.statusCode).toBe(200);
    expect(await queuedFor(OWNER)).toBe(1);
    const receipt = posted.map((p) => p.frame).find((f) => f.type === 'receipt');
    expect(receipt).toBeTruthy();
  });
});

describe('POST /v1/integrations/bind', () => {
  it('binds once, idempotently', async () => {
    expect((await bind(BOT, OWNER)).statusCode).toBe(204);
    expect((await db.getUserById(BOT))?.ownerUserId).toBe(OWNER);
    expect((await bind(BOT, OWNER)).statusCode).toBe(204);
  });

  it('refuses a second, different owner — bindings are write-once', async () => {
    await bind(BOT, OWNER);
    const res = await bind(BOT, STRANGER);
    expect(res.statusCode).toBe(409);
    expect(parseBody<{ error: { code: string } }>(res.body).error.code).toBe('owner_conflict');
    expect((await db.getUserById(BOT))?.ownerUserId).toBe(OWNER);
  });

  it('refuses a human caller', async () => {
    const res = await bind(HUMAN, OWNER);
    expect(res.statusCode).toBe(403);
    expect(parseBody<{ error: { code: string } }>(res.body).error.code).toBe('not_integration');
  });

  it('refuses an owner that does not resolve', async () => {
    const res = await bind(BOT, '01EEEEEEEEEEEEEEEEEEEEEEEE');
    expect(res.statusCode).toBe(404);
    expect(parseBody<{ error: { code: string } }>(res.body).error.code).toBe('unknown_owner');
  });

  it('refuses binding to itself', async () => {
    const res = await bind(BOT, BOT);
    expect(res.statusCode).toBe(400);
  });

  it('refuses a malformed owner id', async () => {
    const res = await bind(BOT, 'not-a-ulid');
    expect(res.statusCode).toBe(400);
  });
});

describe('DELETE /v1/integrations/{userId}', () => {
  beforeEach(async () => {
    await bind(BOT, OWNER);
  });

  it('the owner revokes: sessions dead, key tombstoned, account gone', async () => {
    await db.createSession({
      token: 'tok-bot',
      userId: BOT,
      createdAt: 0,
      expiresAt: 4102444800,
    });

    const res = await revoke(OWNER, BOT);
    expect(res.statusCode).toBe(204);

    expect(await db.getSession('tok-bot')).toBeUndefined();
    expect(await db.getUserById(BOT)).toBeUndefined();
    expect(await queuedFor(BOT)).toBe(0);
    // The tombstone: the same identity key can never authenticate again.
    const again = await db.getOrCreateUserByIdentityKey(
      `idkey-for-${BOT}`,
      '01FRESHAAAAAAAAAAAAAAAAAAA',
      1,
    );
    expect(again.kind).toBe('tombstoned');
  });

  it('the owner deletes activity before deleting the integration user row', async () => {
    const calls: string[] = [];
    vi.spyOn(db, 'deleteActivity').mockImplementation(async (userId, nowMs) => {
      calls.push(`activity:${userId}:${nowMs}`);
    });
    const originalDeleteUser = db.deleteUser.bind(db);
    // Forwards the guard too: deleteUser takes an optional third argument
    // and returns an outcome. A spy that drops
    // either would silently disarm the crew guards under test elsewhere.
    vi.spyOn(db, 'deleteUser').mockImplementation(async (userId, claims, guard) => {
      calls.push(`user:${userId}`);
      return originalDeleteUser(userId, claims, guard);
    });

    await revoke(OWNER, BOT);

    // The tombstone is addressed by the salted opaque ref — the raw userId
    // never reaches the activity table path.
    expect(calls).toEqual([
      `activity:${activityActorRef(BOT, 'integrations-test-salt')}:${deps.now()}`,
      `user:${BOT}`,
    ]);
  });

  it('a repeat after full completion answers 404; the key stays dead', async () => {
    // Crash-RETRY idempotency is the guarantee (the user row goes last, so a
    // partial revoke still resolves and re-runs every step). A repeat after
    // FULL completion cannot be told apart from a never-existing id — the
    // claim is keyed by the identity key, which died with the row — so it is
    // an honest 404, and the tombstone must still hold.
    expect((await revoke(OWNER, BOT)).statusCode).toBe(204);
    expect((await revoke(OWNER, BOT)).statusCode).toBe(404);
    const again = await db.getOrCreateUserByIdentityKey(`idkey-for-${BOT}`, '01FRESHAAAAAAAAAAAAAAAAAAA', 1);
    expect(again.kind).toBe('tombstoned');
  });

  it('a non-owner cannot revoke', async () => {
    const res = await revoke(STRANGER, BOT);
    expect(res.statusCode).toBe(403);
    expect(parseBody<{ error: { code: string } }>(res.body).error.code).toBe(
      'not_integration_owner',
    );
    expect(await db.getUserById(BOT)).toBeTruthy();
  });

  it('a human account is not revocable through this route', async () => {
    const res = await revoke(OWNER, HUMAN);
    expect(res.statusCode).toBe(403);
    expect(parseBody<{ error: { code: string } }>(res.body).error.code).toBe(
      'not_integration_owner',
    );
  });

  it('404 on an unknown target', async () => {
    const res = await revoke(OWNER, '01EEEEEEEEEEEEEEEEEEEEEEEE');
    expect(res.statusCode).toBe(404);
  });
});

describe('push tokens', () => {
  it('integrations cannot register push tokens', async () => {
    const event: HttpEvent = {
      method: 'PUT',
      path: '/v1/push-token',
      headers: { 'content-type': 'application/json' },
      pathParameters: {},
      body: JSON.stringify({}),
      sourceIp: '198.51.100.7',
    };
    const res = await registerPushTokenHandler(event, deps, { userId: BOT });
    expect(res.statusCode).toBe(403);
    expect(parseBody<{ error: { code: string } }>(res.body).error.code).toBe(
      'integration_forbidden',
    );
  });
});

describe('gate 2026-07-28 hardening', () => {
  it('a sender whose account is gone cannot send at all (deleted mid-socket)', async () => {
    // No mkAccount for this id: the account was deleted while its socket (and
    // the authorizer's verdict) stayed live. The optional-chain fallthrough
    // that read "no row" as "unrestricted human" was the hole.
    const res = await send('01GGGGGGGGGGGGGGGGGGGGGGGG');
    expect(res.statusCode).toBe(403);
    expect(errorCodePosted()).toBe('unknown_sender');
    expect(await queuedFor(OWNER)).toBe(0);
  });

  it('self-delete tombstones an integration key — the class cannot be shed', async () => {
    await bind(BOT, OWNER);
    const event: HttpEvent = {
      method: 'DELETE',
      path: '/v1/account',
      headers: {},
      pathParameters: {},
      sourceIp: '198.51.100.7',
    };
    const res = await deleteAccountHandler(event, deps, { userId: BOT });
    expect(res.statusCode).toBe(200);
    // The thief-holding-the-key path: delete the account, re-register the
    // same key as an unrestricted human. Must answer "tombstoned" forever.
    const again = await db.getOrCreateUserByIdentityKey(
      `idkey-for-${BOT}`,
      '01FRESHAAAAAAAAAAAAAAAAAAA',
      1,
    );
    expect(again.kind).toBe('tombstoned');
  });

  it('a HUMAN self-delete still frees its key (unchanged behavior)', async () => {
    const event: HttpEvent = {
      method: 'DELETE',
      path: '/v1/account',
      headers: {},
      pathParameters: {},
      sourceIp: '198.51.100.7',
    };
    const res = await deleteAccountHandler(event, deps, { userId: HUMAN });
    expect(res.statusCode).toBe(200);
    const again = await db.getOrCreateUserByIdentityKey(
      `idkey-for-${HUMAN}`,
      '01FRESHAAAAAAAAAAAAAAAAAAA',
      1,
    );
    expect(again.kind).toBe('ok');
  });

  it('a tombstoned claim survives deleteUser — the revoke/self-delete race is closed', async () => {
    await db.tombstoneIdentityKey(`idkey-for-${BOT}`);
    // The racing self-delete: full claim bag, as deleteAccountHandler passes.
    await db.deleteUser(BOT, { identityKeyPub: `idkey-for-${BOT}` });
    const again = await db.getOrCreateUserByIdentityKey(
      `idkey-for-${BOT}`,
      '01FRESHAAAAAAAAAAAAAAAAAAA',
      1,
    );
    expect(again.kind).toBe('tombstoned');
  });

  it('only the owner may message an integration — no dead drops', async () => {
    await bind(BOT, OWNER);
    const fromStranger = await send(STRANGER, { to: BOT });
    expect(fromStranger.statusCode).toBe(403);
    expect(errorCodePosted()).toBe('integration_inbox_restricted');
    expect(await queuedFor(BOT)).toBe(0);

    // The owner CAN: read receipts and profile cards from the owner's app are
    // routine and must keep flowing.
    const fromOwner = await send(OWNER, { to: BOT });
    expect(fromOwner.statusCode).toBe(200);
    expect(await queuedFor(BOT)).toBe(1);
  });

  it('nobody may message an unbound integration', async () => {
    const res = await send(OWNER, { to: BOT });
    expect(res.statusCode).toBe(403);
    expect(errorCodePosted()).toBe('integration_inbox_restricted');
  });
});
