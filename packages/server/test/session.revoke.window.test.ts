import { beforeEach, describe, expect, it } from 'vitest';
import { ulid } from 'ulid';
import type { ServerFrame } from '@tacendum/shared';
import { wsTicketHandler } from '../src/handlers/ws-ticket.js';
import { wsConnectHandler, wsDefaultHandler, type WsDeps } from '../src/handlers/ws.js';
import { makeSessionGuard } from '../src/handlers/session-guard.js';
import { sessionTokenDigest, type TestOnlyDataLayer } from '../src/db/data.js';
import {
  makeMemoryDb,
  makeTestDeps,
  allQueued,
  parseBody,
  testIdentityKey,
  type TestDeps,
} from './helpers.js';

/**
 * The revocation WINDOW: the session guard cached
 * its POSITIVE verdict for 60 s, so a session revoked at T kept a warm
 * socket sending — and receiving live deliveries — until the cached "active"
 * expired. "Sign out" answered 200 and the stolen socket carried on for up
 * to a minute.
 *
 * These tests pin the fix: a positive verdict is never a licence. The frame
 * AFTER the revoke commits must be refused, and the live delivery AFTER the
 * revoke must be withheld — with no clock advance, because there is no
 * window to wait out. Only the negative verdict may be cached (it is
 * monotonic: a revoked or expired session never becomes active again).
 */

const B64 = 'Y2lwaGVydGV4dA==';

let db: TestOnlyDataLayer;
let deps: TestDeps;
let wsDeps: WsDeps;
let sender: {
  inbox: Map<string, ServerFrame[]>;
  post(connectionId: string, frame: ServerFrame): Promise<boolean>;
};

function makeSender() {
  const inbox = new Map<string, ServerFrame[]>();
  return {
    inbox,
    async post(connectionId: string, frame: ServerFrame): Promise<boolean> {
      const frames = inbox.get(connectionId) ?? [];
      frames.push(frame);
      inbox.set(connectionId, frames);
      return true;
    },
  };
}

async function makeUser(seed: number): Promise<{ userId: string; token: string }> {
  const resolution = await db.getOrCreateUserByIdentityKey(
    testIdentityKey(seed),
    deps.newUserId(),
    deps.now(),
  );
  if (resolution.kind !== 'ok') throw new Error('fixture account was not created');
  const token = deps.newAuthToken();
  await db.createSession({
    token,
    userId: resolution.user.userId,
    createdAt: deps.now(),
    expiresAt: Math.floor(deps.now() / 1000) + 30 * 24 * 3600,
  });
  return { userId: resolution.user.userId, token };
}

async function connect(userId: string, token: string, connectionId: string) {
  const res = await wsTicketHandler(
    { method: 'POST', path: '/v1/ws-ticket', headers: { authorization: `Bearer ${token}` }, body: '' },
    deps,
    { userId },
  );
  expect(res.statusCode).toBe(200);
  const { ticket } = parseBody<{ ticket: string }>(res.body);
  return wsConnectHandler(
    { routeKey: '$connect', connectionId, queryStringParameters: { ticket } },
    wsDeps,
  );
}

function sendFrame(to: string, connectionId: string, senderUserId: string, sessionToken: string) {
  return wsDefaultHandler(
    {
      routeKey: '$default',
      connectionId,
      senderUserId,
      sessionDigest: sessionTokenDigest(sessionToken),
      body: JSON.stringify({ type: 'send', to, msgId: ulid(), msgType: 'ciphertext', payload: B64 }),
    },
    wsDeps,
  );
}

beforeEach(() => {
  db = makeMemoryDb();
  deps = makeTestDeps(db);
  sender = makeSender();
  wsDeps = {
    ...deps,
    sender,
    scheduleDrain: async () => {},
    schedulePush: async () => {},
    sessionGuard: makeSessionGuard(db),
  };
});

describe('the positive verdict is never a licence — SEND stops at the revoke', () => {
  it('refuses the very next frame after the revoke, with no window to wait out', async () => {
    const alice = await makeUser(0x60);
    const bob = await makeUser(0x61);
    expect((await connect(alice.userId, alice.token, 'conn-warm')).statusCode).toBe(200);

    // Warm the guard with a positive verdict — the exact state the old cache
    // turned into a 60 s licence.
    expect((await sendFrame(bob.userId, 'conn-warm', alice.userId, alice.token)).statusCode).toBe(
      200,
    );

    // Revoke at the store (the proactive disconnect may be in-flight,
    // throttled, or unwired — the row deliberately survives).
    await db.deleteSession(alice.token);

    // NO clock advance. The next frame must observe the revoke.
    const queuedBefore = (await allQueued(db, bob.userId)).length;
    const res = await sendFrame(bob.userId, 'conn-warm', alice.userId, alice.token);

    expect(res.statusCode).toBe(401);
    expect((await allQueued(db, bob.userId)).length).toBe(queuedBefore); // nothing enqueued
    const frames = sender.inbox.get('conn-warm') ?? [];
    expect(frames.some((f) => f.type === 'error' && f.code === 'session_revoked')).toBe(true);
    expect(deps.disconnected).toContain('conn-warm');
    expect(await db.getConnection(alice.userId)).toBeUndefined();
  });

  it('caches the NEGATIVE verdict — repeated frames after the refusal cost no further reads', async () => {
    const alice = await makeUser(0x62);
    const bob = await makeUser(0x63);
    expect((await connect(alice.userId, alice.token, 'conn-neg')).statusCode).toBe(200);
    await db.deleteSession(alice.token);

    let reads = 0;
    const counted = db.getSessionByDigest.bind(db);
    db.getSessionByDigest = async (digest) => {
      reads += 1;
      return counted(digest);
    };

    expect((await sendFrame(bob.userId, 'conn-neg', alice.userId, alice.token)).statusCode).toBe(401);
    const readsAfterFirst = reads;
    expect((await sendFrame(bob.userId, 'conn-neg', alice.userId, alice.token)).statusCode).toBe(401);
    expect((await sendFrame(bob.userId, 'conn-neg', alice.userId, alice.token)).statusCode).toBe(401);
    // Fail-closed caching is free: "inactive" is monotonic, so it may be held
    // without re-reading. Only the first refusal pays a read.
    expect(reads).toBe(readsAfterFirst);
  });
});

describe('the positive verdict is never a licence — RECEIVING stops at the revoke', () => {
  it('withholds a live delivery the moment the recipient session is revoked, warm cache or not', async () => {
    const alice = await makeUser(0x64); // sender
    const bob = await makeUser(0x65); // recipient with a live socket
    expect((await connect(bob.userId, bob.token, 'conn-bob-live')).statusCode).toBe(200);

    // First delivery lands — and warms the guard with a positive verdict for
    // Bob's session digest at the delivery gate.
    expect((await sendFrame(bob.userId, 'conn-alice', alice.userId, alice.token)).statusCode).toBe(
      200,
    );
    const delivered = (sender.inbox.get('conn-bob-live') ?? []).filter((f) => f.type === 'msg');
    expect(delivered.length).toBe(1);

    // Bob revokes. The proactive row-delete did not run; the row survives.
    await db.deleteSession(bob.token);

    // NO clock advance. The next delivery must observe the revoke: nothing new
    // on the revoked socket, ciphertext queued for a re-authenticated login,
    // row torn down, socket hung up.
    const bobFramesBefore = (sender.inbox.get('conn-bob-live') ?? []).length;
    expect((await sendFrame(bob.userId, 'conn-alice', alice.userId, alice.token)).statusCode).toBe(
      200,
    );
    expect((sender.inbox.get('conn-bob-live') ?? []).length).toBe(bobFramesBefore);
    expect((await allQueued(db, bob.userId)).length).toBe(2); // both sends queued; only one ever left live
    expect(await db.getConnection(bob.userId)).toBeUndefined();
    expect(deps.disconnected).toContain('conn-bob-live');
  });
});
