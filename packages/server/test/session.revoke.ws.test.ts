import { beforeEach, describe, expect, it } from 'vitest';
import { ulid } from 'ulid';
import { PrivateKey } from '@signalapp/libsignal-client';
import { authSignedBytes, type ServerFrame } from '@tacendum/shared';
import { wsTicketHandler } from '../src/handlers/ws-ticket.js';
import {
  deleteOtherSessionsHandler,
  deleteSessionHandler,
} from '../src/handlers/session.js';
import { deleteAccountHandler } from '../src/handlers/account.js';
import { authChallengeHandler, authHandler } from '../src/handlers/auth-account.js';
import { wsConnectHandler, wsDefaultHandler, type WsDeps } from '../src/handlers/ws.js';
import { makeSessionGuard } from '../src/handlers/session-guard.js';
import { sessionTokenDigest, type DataLayer } from '../src/db/data.js';
import type { HttpEvent } from '../src/handlers/http.js';
import {
  makeMemoryDb,
  makeTestDeps,
  allQueued,
  parseBody,
  testIdentityKey,
  type TestDeps,
} from './helpers.js';

/**
 * revoking a session must revoke the SOCKET it opened.
 *
 * The defect: the connection row carried only {userId, connectionId,
 * connectedAt}, and sign-out deleted only the session row. A stolen socket —
 * opened with a ticket the stolen bearer minted — kept sending and receiving
 * for as long as it stayed connected, after its owner had done the one thing
 * the product offers to stop it. "Sign out" answered 200 and revoked nothing
 * that mattered.
 *
 * The fix binds the connection to the session that authorized it (the
 * session-token DIGEST rides the ticket into the connection row and the
 * authorizer context), so revocation can (a) delete the row + disconnect the
 * live socket, and (b) refuse further frames on any socket that survives the
 * disconnect — on a cadence, never a DB read per frame.
 */

const B64 = 'Y2lwaGVydGV4dA==';

let db: DataLayer;
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
  return { userId: resolution.user.userId, token: await issueSession(resolution.user.userId) };
}

/** A 30-day session, the real lifetime, so expiry never fires inside a test. */
async function issueSession(userId: string): Promise<string> {
  const token = deps.newAuthToken();
  await db.createSession({
    token,
    userId,
    createdAt: deps.now(),
    expiresAt: Math.floor(deps.now() / 1000) + 30 * 24 * 3600,
  });
  return token;
}

/** Mint over the REAL ticket route with the bearer in the header, exactly as a
 * client does — this is the request whose session the socket must inherit. */
async function mintTicket(userId: string, token: string): Promise<string> {
  const res = await wsTicketHandler(
    { method: 'POST', path: '/v1/ws-ticket', headers: { authorization: `Bearer ${token}` }, body: '' },
    deps,
    { userId },
  );
  expect(res.statusCode).toBe(200);
  return parseBody<{ ticket: string }>(res.body).ticket;
}

async function connect(userId: string, token: string, connectionId: string) {
  const ticket = await mintTicket(userId, token);
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
      // The host fills this from the authorizer context (AWS) or its own
      // connect-time map (local adapter); the unit test fills it directly.
      sessionDigest: sessionTokenDigest(sessionToken),
      body: JSON.stringify({ type: 'send', to, msgId: ulid(), msgType: 'ciphertext', payload: B64 }),
    },
    wsDeps,
  );
}

function del(path: string, token: string): HttpEvent {
  return {
    method: 'DELETE',
    path,
    headers: { authorization: `Bearer ${token}` },
    pathParameters: {},
    body: null,
    sourceIp: '203.0.113.7',
  };
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
    // The real recheck cache over the memory store — so the cadence test below
    // exercises the actual window, not a stub.
    sessionGuard: makeSessionGuard(db),
  };
});

describe('sign-out revokes the live socket', () => {
  it('DELETE /v1/session deletes the connection row and disconnects the transport', async () => {
    const alice = await makeUser(0x41);
    expect((await connect(alice.userId, alice.token, 'conn-signout')).statusCode).toBe(200);
    expect(await db.getConnection(alice.userId)).toMatchObject({
      connectionId: 'conn-signout',
      sessionDigest: sessionTokenDigest(alice.token),
    });

    const res = await deleteSessionHandler(del('/v1/session', alice.token), deps, {
      userId: alice.userId,
    });
    expect(res.statusCode).toBe(200);

    // The row is gone — nothing routes inbound to the dead session's socket…
    expect(await db.getConnection(alice.userId)).toBeUndefined();
    // …and the transport was told to hang it up.
    expect(deps.disconnected).toContain('conn-signout');
  });

  it('a frame on a revoked session is refused immediately — no cached verdict survives the revoke', async () => {
    const alice = await makeUser(0x42);
    const bob = await makeUser(0x43);
    expect((await connect(alice.userId, alice.token, 'conn-stolen')).statusCode).toBe(200);

    // A frame BEFORE revocation observes a positive verdict. The guard must
    // not cache it: the 60 s positive cache this used to assert WAS the
    // revocation window — a revoked socket kept
    // sending until the cached "active" expired.
    expect((await sendFrame(bob.userId, 'conn-stolen', alice.userId, alice.token)).statusCode).toBe(
      200,
    );

    // Revoke straight at the store — the handler path is covered above; this
    // isolates the OTHER half of the fix: a socket that survived the proactive
    // disconnect (in-flight, throttled, or the row delete raced) must still
    // stop working. The connection row is deliberately left in place.
    await db.deleteSession(alice.token);

    // NO clock advance: the very next frame observes the revoke and is
    // refused BEFORE it can enqueue.
    const queuedBefore = (await allQueued(db, bob.userId)).length;
    const res = await sendFrame(bob.userId, 'conn-stolen', alice.userId, alice.token);

    expect(res.statusCode).toBe(401);
    expect((await allQueued(db, bob.userId)).length).toBe(queuedBefore); // nothing enqueued
    const frames = sender.inbox.get('conn-stolen') ?? [];
    expect(frames.some((f) => f.type === 'error' && f.code === 'session_revoked')).toBe(true);
    expect(deps.disconnected).toContain('conn-stolen');
  });

  it('a pre-minted ticket bound to a revoked session opens no NEW socket', async () => {
    const alice = await makeUser(0x44);
    const ticket = await mintTicket(alice.userId, alice.token);

    await db.deleteSession(alice.token);

    const res = await wsConnectHandler(
      { routeKey: '$connect', connectionId: 'conn-late', queryStringParameters: { ticket } },
      wsDeps,
    );
    // #3 — consuming the ticket now verifies its BOUND session still lives.
    // The victim revoked it, so the dial is REFUSED outright: no socket
    // establishes, and the routing row is never claimed. This used to return
    // 200 and lean on the first-frame recheck to stop it — a window in which
    // the attacker held a live socket as the victim, drained the queue, and
    // owned the account's single routing row before ever sending a frame.
    expect(res.statusCode).toBe(401);
    expect(await db.getConnection(alice.userId)).toBeUndefined();
  });

  it('a session revoked DURING $connect (after auth, before ownership) leaves no row to deny the real user', async () => {
    const alice = await makeUser(0x48);
    // The revoke lands mid-connect: after consumeWsTicket authenticated the
    // dial (the ticket's bound session was still live then) and before the row
    // is claimed. That is the window `deps.scheduleDrain` runs in, so deleting
    // the session from inside it models a revocation racing row acquisition —
    // the session-revoke path finds no row yet and tears nothing down.
    wsDeps.scheduleDrain = async () => {
      await db.deleteSession(alice.token);
    };

    const res = await connect(alice.userId, alice.token, 'conn-mid');

    // Refused after ownership was revalidated, and — the whole point — NO
    // routing row is left behind: without the post-ownership recheck this
    // returned 200 and a fresh listener would probe the dead socket 'live' and
    // be refused forever.
    expect(res.statusCode).toBe(401);
    expect(await db.getConnection(alice.userId)).toBeUndefined();
    expect(deps.disconnected).toContain('conn-mid');
  });

  it('a reconnect displaces an incumbent whose session was revoked, even though its socket still answers a probe', async () => {
    const alice = await makeUser(0x49);
    // Alice's first socket owns the row.
    expect((await connect(alice.userId, alice.token, 'conn-dead')).statusCode).toBe(200);

    // Its session is revoked, but the proactive row-delete did not run (raced,
    // throttled or unwired) so the row survives — and this test's transport
    // ACKs every probe (makeSender.post returns true), so a probe alone would
    // read the dead socket as 'live'.
    await db.deleteSession(alice.token);

    // Alice re-authenticates and dials a fresh socket.
    const fresh = await issueSession(alice.userId);
    const res = await connect(alice.userId, fresh, 'conn-live');

    // NOT spared as 'live': the incumbent's revoked digest is validated before
    // the probe, so the fresh listener displaces the dead row and owns it.
    expect(res.statusCode).toBe(200);
    expect(await db.getConnection(alice.userId)).toMatchObject({ connectionId: 'conn-live' });
  });

  it('the same-session takeover holds under the ENFORCING guard: probe-free, ghost displaced', async () => {
    // The gate.connrow twin of this test runs guardless; this one runs over
    // the REAL session guard, because the takeover's whole mechanism is a
    // guard-adjacent shortcut (both digests present and equal) and a guard
    // regression could re-route same-session dials back into the probe. This
    // harness's transport ACKs every post (makeSender), so a probe would read
    // the ghost 'live' and refuse — the ghost-incumbent failure mode.
    const alice = await makeUser(0x4a);
    expect((await connect(alice.userId, alice.token, 'conn-ghost')).statusCode).toBe(200);

    const res = await connect(alice.userId, alice.token, 'conn-fresh');
    expect(res.statusCode).toBe(200);
    expect(await db.getConnection(alice.userId)).toMatchObject({ connectionId: 'conn-fresh' });
    // Probe-free: nothing was ever posted to the ghost.
    expect(sender.inbox.get('conn-ghost')).toBeUndefined();
  });

  it('the revalidation covers the takeover path too: a revoke landing mid-takeover leaves no socket and no row', async () => {
    // The dialling socket is NOT taken on faith by the takeover: its session
    // is authenticated at the mint, at the ticket's spend, and — pinned here —
    // by the post-ownership revalidation. The revoke lands in the
    // scheduleDrain window, after the spend saw a live session and before the
    // row is claimed, exactly as in the no-incumbent test above — but
    // with a same-session ghost holding the row, so the dial takes the
    // takeover branch and the CAS lands before the guard answers.
    const alice = await makeUser(0x4b);
    expect((await connect(alice.userId, alice.token, 'conn-ghost')).statusCode).toBe(200);

    wsDeps.scheduleDrain = async () => {
      await db.deleteSession(alice.token);
    };
    const res = await connect(alice.userId, alice.token, 'conn-fresh');

    // Refused after ownership was revalidated; the displaced ghost's row is
    // already gone and the takeover's own claim is torn back down — a revoked
    // session ends this dial holding nothing, same as every other arm.
    expect(res.statusCode).toBe(401);
    expect(await db.getConnection(alice.userId)).toBeUndefined();
    expect(deps.disconnected).toContain('conn-fresh');
  });
});

describe('#4 — live delivery is gated on the recipient session too', () => {
  it('withholds a live post to a socket whose session was revoked, queues it, and reaps the row', async () => {
    const alice = await makeUser(0x50); // sender
    const bob = await makeUser(0x51); // recipient
    // Bob holds a live socket bound to his session.
    expect((await connect(bob.userId, bob.token, 'conn-bob')).statusCode).toBe(200);
    const bobBefore = (sender.inbox.get('conn-bob') ?? []).length;

    // Bob's session is revoked, but the PROACTIVE row-delete did not run (it
    // can be in-flight, throttled, or unwired) — the connection row survives.
    // Enforcement so far covered only client-ORIGINATED frames (the $default
    // recheck); a passive socket that only RECEIVES kept getting live posts.
    await db.deleteSession(bob.token);

    // Alice sends Bob a message.
    await sendFrame(bob.userId, 'conn-alice', alice.userId, alice.token);

    // Nothing new landed on Bob's revoked socket…
    expect((sender.inbox.get('conn-bob') ?? []).length).toBe(bobBefore);
    // …the ciphertext is queued for a re-authenticated login instead…
    expect((await allQueued(db, bob.userId)).length).toBe(1);
    // …and the stale routing row was torn down (and the socket hung up).
    expect(await db.getConnection(bob.userId)).toBeUndefined();
    expect(deps.disconnected).toContain('conn-bob');
  });

  it('a live socket whose session is STILL valid delivers normally (control)', async () => {
    const alice = await makeUser(0x52);
    const bob = await makeUser(0x53);
    expect((await connect(bob.userId, bob.token, 'conn-bob2')).statusCode).toBe(200);

    await sendFrame(bob.userId, 'conn-alice2', alice.userId, alice.token);

    // Delivered live: the message is on Bob's socket, and his routing row
    // survives. (The queued row also survives — only an ack deletes it — so
    // "delivered" is asserted on the socket, not on the queue being empty.)
    const frames = sender.inbox.get('conn-bob2') ?? [];
    expect(frames.some((f) => f.type === 'msg')).toBe(true);
    expect(await db.getConnection(bob.userId)).toMatchObject({ connectionId: 'conn-bob2' });
  });
});

describe('sign out everywhere else', () => {
  it("kills the other session's socket and spares the caller's own", async () => {
    const alice = await makeUser(0x45);
    const lostToken = await issueSession(alice.userId); // the lost phone

    // The lost phone holds the live socket.
    expect((await connect(alice.userId, lostToken, 'conn-lost')).statusCode).toBe(200);

    const res = await deleteOtherSessionsHandler(del('/v1/sessions/others', alice.token), deps, {
      userId: alice.userId,
    });
    expect(res.statusCode).toBe(200);

    expect(await db.getConnection(alice.userId)).toBeUndefined();
    expect(deps.disconnected).toContain('conn-lost');
  });

  it("leaves the caller's own socket alone", async () => {
    const alice = await makeUser(0x46);
    expect((await connect(alice.userId, alice.token, 'conn-mine')).statusCode).toBe(200);

    await deleteOtherSessionsHandler(del('/v1/sessions/others', alice.token), deps, {
      userId: alice.userId,
    });

    // The caller's connection is bound to the one session that survived.
    expect(await db.getConnection(alice.userId)).toMatchObject({ connectionId: 'conn-mine' });
    expect(deps.disconnected).not.toContain('conn-mine');
  });
});

describe('account deletion revokes the socket too', () => {
  it('disconnects the live socket, not merely its row', async () => {
    const alice = await makeUser(0x47);
    expect((await connect(alice.userId, alice.token, 'conn-acct')).statusCode).toBe(200);

    const res = await deleteAccountHandler(del('/v1/account', alice.token), deps, {
      userId: alice.userId,
    });
    expect(res.statusCode).toBe(200);

    expect(await db.getConnection(alice.userId)).toBeUndefined();
    expect(deps.disconnected).toContain('conn-acct');
  });
});

describe('a new sign-in supersedes the old socket', () => {
  it('revoking prior sessions also disconnects the socket they opened', async () => {
    // The one revocation path that is not a DELETE route: POST /v1/auth
    // revokes every prior session. The old install's socket must go with them.
    const priv = PrivateKey.generate();
    const identityKey = Buffer.from(priv.getPublicKey().serialize()).toString('base64');
    const USER = '01SUPERSEDEDUSERAAAAAAAAAA';
    const pinned = await db.getOrCreateUserByIdentityKey(identityKey, USER, deps.now());
    expect(pinned.kind).toBe('ok');

    const staleToken = await issueSession(USER);
    expect((await connect(USER, staleToken, 'conn-old-install')).statusCode).toBe(200);

    const post = (path: string, body: unknown): HttpEvent => ({
      method: 'POST',
      path,
      headers: { 'content-type': 'application/json' },
      pathParameters: {},
      body: JSON.stringify(body),
      sourceIp: '203.0.113.9',
    });
    const issued = await authChallengeHandler(post('/v1/auth/challenge', { identityKey }), deps);
    expect(issued.statusCode).toBe(200);
    const { challenge } = parseBody<{ challenge: string }>(issued.body);
    const signature = Buffer.from(
      priv.sign(new Uint8Array(authSignedBytes(deps.apiOrigin, challenge))),
    ).toString('base64');
    const res = await authHandler(post('/v1/auth', { identityKey, challenge, signature }), deps);
    expect(res.statusCode).toBe(200);

    expect(await db.getConnection(USER)).toBeUndefined();
    expect(deps.disconnected).toContain('conn-old-install');
  });
});
