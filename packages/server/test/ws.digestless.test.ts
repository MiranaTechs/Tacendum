import { beforeEach, describe, expect, it } from 'vitest';
import { ulid } from 'ulid';
import type { ServerFrame } from '@tacendum/shared';
import { wsTicketHandler } from '../src/handlers/ws-ticket.js';
import { wsConnectHandler, wsDefaultHandler, type WsDeps } from '../src/handlers/ws.js';
import { makeSessionGuard } from '../src/handlers/session-guard.js';
import { revokeConnectionForSessions } from '../src/handlers/session-revoke.js';
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
 * DIGESTLESS SOCKETS FAIL CLOSED.
 *
 * Every enforcement point used to gate on `sessionDigest !== undefined` — a
 * connection row or frame WITHOUT a digest skipped the session check
 * entirely, in the name of "legacy digestless sockets". v1.0 has not shipped:
 * there is no released client, so there are no legacy digestless sockets in
 * the field and no rollout window to protect. A digestless socket is not a
 * compatibility case — it is a socket the session machinery cannot revoke,
 * and on a session-enforcing host (one with a `sessionGuard`, which is both
 * shipped hosts) it must be refused and torn down wherever it appears:
 * dialling, sending, receiving live delivery, being drained, holding the
 * routing row, and being matched by a revoke.
 */

const B64 = 'Y2lwaGVydGV4dA==';

let db: TestOnlyDataLayer;
let deps: TestDeps;
let wsDeps: WsDeps;
let sender: {
  inbox: Map<string, ServerFrame[]>;
  failFor: Set<string>;
  post(connectionId: string, frame: ServerFrame): Promise<boolean>;
};

function makeSender() {
  const inbox = new Map<string, ServerFrame[]>();
  const failFor = new Set<string>();
  return {
    inbox,
    failFor,
    async post(connectionId: string, frame: ServerFrame): Promise<boolean> {
      if (failFor.has(connectionId)) return false;
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

async function mintTicket(userId: string, token: string): Promise<string> {
  const res = await wsTicketHandler(
    { method: 'POST', path: '/v1/ws-ticket', headers: { authorization: `Bearer ${token}` }, body: '' },
    deps,
    { userId },
  );
  expect(res.statusCode).toBe(200);
  return parseBody<{ ticket: string }>(res.body).ticket;
}

function sendFrame(
  to: string,
  connectionId: string,
  senderUserId: string,
  sessionToken?: string,
) {
  return wsDefaultHandler(
    {
      routeKey: '$default',
      connectionId,
      senderUserId,
      ...(sessionToken !== undefined ? { sessionDigest: sessionTokenDigest(sessionToken) } : {}),
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

describe('a digestless DIAL is refused on a session-enforcing host', () => {
  it('refuses a ticket that carries no bound session digest', async () => {
    const alice = await makeUser(0x70);
    // A pre-F3-shaped ticket: minted straight at the store with no digest.
    const ticket = deps.newAuthToken();
    await db.putWsTicket({
      ticket,
      userId: alice.userId,
      expiresAt: Math.floor(deps.now() / 1000) + 60,
      role: 'listen',
    });

    const res = await wsConnectHandler(
      { routeKey: '$connect', connectionId: 'conn-dl-dial', queryStringParameters: { ticket } },
      wsDeps,
    );

    expect(res.statusCode).toBe(401);
    expect(await db.getConnection(alice.userId)).toBeUndefined();
  });

  it('refuses an authorizer-context connect that carries no session digest', async () => {
    const alice = await makeUser(0x71);
    const res = await wsConnectHandler(
      {
        routeKey: '$connect',
        connectionId: 'conn-dl-aws',
        authorizedUserId: alice.userId,
        authorizedRole: 'listen',
        // authorizedSessionDigest deliberately absent — a stale-deploy
        // authorizer context. Fail closed, not open.
      },
      wsDeps,
    );

    expect(res.statusCode).toBe(401);
    expect(await db.getConnection(alice.userId)).toBeUndefined();
  });
});

describe('a digestless FRAME is refused and its socket torn down', () => {
  it('refuses the frame, deletes the row and hangs the socket up', async () => {
    const alice = await makeUser(0x72);
    const bob = await makeUser(0x73);
    // A digestless connection row that somehow exists (legacy write).
    await db.putConnection({
      userId: alice.userId,
      connectionId: 'conn-dl-frame',
      connectedAt: deps.now(),
    });

    const queuedBefore = (await allQueued(db, bob.userId)).length;
    const res = await sendFrame(bob.userId, 'conn-dl-frame', alice.userId /* no token */);

    expect(res.statusCode).toBe(401);
    expect((await allQueued(db, bob.userId)).length).toBe(queuedBefore);
    expect(await db.getConnection(alice.userId)).toBeUndefined();
    expect(deps.disconnected).toContain('conn-dl-frame');
  });
});

describe('a digestless connection row cannot RECEIVE', () => {
  it('withholds live delivery to a digestless row, queues, and reaps the row', async () => {
    const alice = await makeUser(0x74);
    const bob = await makeUser(0x75);
    await db.putConnection({
      userId: bob.userId,
      connectionId: 'conn-dl-rx',
      connectedAt: deps.now(),
    });

    expect((await sendFrame(bob.userId, 'conn-alice-a', alice.userId, alice.token)).statusCode).toBe(
      200,
    );

    // Nothing landed on the digestless socket…
    expect((sender.inbox.get('conn-dl-rx') ?? []).filter((f) => f.type === 'msg')).toHaveLength(0);
    // …the ciphertext queued for a real login…
    expect((await allQueued(db, bob.userId)).length).toBe(1);
    // …and the unrevocable row was torn down and the socket hung up.
    expect(await db.getConnection(bob.userId)).toBeUndefined();
    expect(deps.disconnected).toContain('conn-dl-rx');
  });

  it('refuses the post-failure FRESH row too when it is digestless', async () => {
    const alice = await makeUser(0x76);
    const bob = await makeUser(0x77);
    // Bob's current row is a valid, digest-bearing socket whose transport
    // died (posts fail); the re-read then finds a DIGESTLESS newer row.
    await db.putConnection({
      userId: bob.userId,
      connectionId: 'conn-bob-dead',
      // Old enough that the failed post may reap it.
      connectedAt: deps.now() - 60_000,
      sessionDigest: sessionTokenDigest(bob.token),
    });
    sender.failFor.add('conn-bob-dead');
    const reads: string[] = [];
    const realGet = db.getConnection.bind(db);
    db.getConnection = async (userId: string) => {
      const row = await realGet(userId);
      if (userId === bob.userId) {
        reads.push(userId);
        if (reads.length >= 2) {
          // The "reconnect" that raced the failed post: a digestless row.
          return {
            userId: bob.userId,
            connectionId: 'conn-bob-fresh',
            connectedAt: deps.now(),
          };
        }
      }
      return row;
    };

    expect((await sendFrame(bob.userId, 'conn-alice-b', alice.userId, alice.token)).statusCode).toBe(
      200,
    );

    // The digestless fresh row must not be posted to.
    expect((sender.inbox.get('conn-bob-fresh') ?? []).filter((f) => f.type === 'msg')).toHaveLength(
      0,
    );
    expect(deps.disconnected).toContain('conn-bob-fresh');
  });
});

describe('a digestless incumbent cannot HOLD the routing row', () => {
  it('a valid listener displaces a digestless incumbent instead of being refused over it', async () => {
    const alice = await makeUser(0x78);
    await db.putConnection({
      userId: alice.userId,
      connectionId: 'conn-dl-incumbent',
      connectedAt: deps.now(),
    });
    // The memory sender answers every post, so a probe would read 'live' —
    // the exact verdict that used to let a digestless socket keep the row
    // and 503 every legitimate reconnect.
    const ticket = await mintTicket(alice.userId, alice.token);
    const res = await wsConnectHandler(
      { routeKey: '$connect', connectionId: 'conn-dl-claimant', queryStringParameters: { ticket } },
      wsDeps,
    );

    expect(res.statusCode).toBe(200);
    expect(await db.getConnection(alice.userId)).toMatchObject({
      connectionId: 'conn-dl-claimant',
      sessionDigest: sessionTokenDigest(alice.token),
    });
  });
});

describe('a revoke never leaves a digestless row standing', () => {
  it('single-session sign-out (onlyDigest) tears down an unmatchable digestless row', async () => {
    const alice = await makeUser(0x79);
    await db.putConnection({
      userId: alice.userId,
      connectionId: 'conn-dl-revoke',
      connectedAt: deps.now(),
    });

    await revokeConnectionForSessions(deps, alice.userId, {
      onlyDigest: sessionTokenDigest(alice.token),
    });

    // The digestless row cannot be proven to be ANY live session's socket,
    // and every legitimately-written row carries a digest — so the safe
    // direction for a revoke is teardown, not "leave it".
    expect(await db.getConnection(alice.userId)).toBeUndefined();
    expect(deps.disconnected).toContain('conn-dl-revoke');
  });
});
