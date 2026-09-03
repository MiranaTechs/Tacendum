import { beforeEach, describe, expect, it } from 'vitest';
import { monotonicFactory } from 'ulid';
import type { ServerFrame, WsTicketRole } from '@tacendum/shared';
import {
  CONNECTION_REAP_GRACE_MS,
  drainQueuedMessages,
  wsConnectHandler,
  wsDefaultHandler,
  wsDisconnectHandler,
  type WsDeps,
} from '../src/handlers/ws.js';
import { wsTicketHandler } from '../src/handlers/ws-ticket.js';
import { CONNECTION_ROW_TTL_SECONDS, connectionExpiresAt, type TestOnlyDataLayer } from '../src/db/data.js';
import { makeMemoryDb, makeTestDeps, parseBody, testIdentityKey, type TestDeps } from './helpers.js';

/** Monotonic so msgIds minted in the same millisecond still sort in order. */
const ulid = monotonicFactory();

/** Fake transport: records frames per connectionId; `dead` connections refuse. */
function makeFakeSender() {
  const inbox = new Map<string, ServerFrame[]>();
  const dead = new Set<string>();
  /** Connections that answer Gone ONCE and are live thereafter — an AWS socket
   * whose $connect integration had not finished when the first probe arrived. */
  const reviveOnNextProbe = new Set<string>();
  return {
    inbox,
    dead,
    reviveAfterProbe: (id: string): void => {
      reviveOnNextProbe.add(id);
    },
    async post(connectionId: string, frame: ServerFrame): Promise<boolean> {
      if (dead.has(connectionId)) {
        if (reviveOnNextProbe.delete(connectionId)) dead.delete(connectionId);
        return false;
      }
      const frames = inbox.get(connectionId) ?? [];
      frames.push(frame);
      inbox.set(connectionId, frames);
      return true;
    },
  };
}

const B64 = 'Y2lwaGVydGV4dA=='; // "ciphertext"
const ALICE_KEY = testIdentityKey(0x11);
const BOB_KEY = testIdentityKey(0x12);

/**
 * The connection-row steal, the probe that fixed it,
 * and the removal of the competition the probe was arbitrating.
 *
 * The connections table holds ONE row per user. `putConnection` was an
 * unconditional Put, so a one-shot `tacendum send` dialling from the same
 * account overwrote the live listener's row, and its $disconnect then deleted
 * the row it had just written (the conditional guard matched: it only defends
 * against stale deletes racing a NEWER write). The listener stayed on an open
 * socket believing it was listening while every message for the account queued
 * toward the 30-day TTL.
 *
 * Rounds 5-7 tried to arbitrate that competition correctly and could not:
 * - reading every non-answer as "dead" displaced live listeners on a throttle;
 * - a 2 s settle-and-reprobe read "still Gone" as "established and dead rather
 * than still establishing", which no duration can establish, because a
 * $connect whose row write applied but whose SDK response is delayed holds
 * API Gateway off establishing that socket for as long as the delay lasts;
 * - deleting the settle without enforcing the invariant it stood for made an
 * ordinary ~50-200 ms handshake overlap enough to displace an establishing
 * owner that had already returned 200 and could no longer recover;
 * - and treating a lost claim as evidence about the winner stranded the loser
 * when the winner was a one-shot that immediately left.
 *
 * THE FIX STOPS ARBITRATING. The competition cannot be arbitrated correctly
 * because ONE of the two competitors never wanted the row: a one-shot opens a
 * socket to push one frame and collect one receipt, both of which post to its
 * own connectionId. The WebSocket ticket now carries a ROLE, minted over HTTPS
 * and stored server-side, and a 'send' dial never reads the row, never probes
 * anyone, never claims, and can never delete anybody's row on the way out.
 *
 * What is left is listener-versus-listener, where both parties are long-lived
 * and both redial. So a listening dial that does not end up owning the row is
 * REFUSED (503) rather than told 200 and left silently unroutable — the app
 * backs off and redials with a fresh ticket, and `WsClient` now does too. And a
 * connect that claimed the row re-reads it, consistently, before answering 200,
 * so an owner displaced while it was still establishing refuses itself instead
 * of going live with nothing pointing at it.
 */
describe('gate.connrow — a one-shot send must not unroute a live listener', () => {
  let db: TestOnlyDataLayer;
  let deps: TestDeps;
  let sender: ReturnType<typeof makeFakeSender>;
  let wsDeps: WsDeps;
  let aliceToken: string;
  let aliceId: string;
  let bobId: string;

  /** Account + session built straight on the data layer, as ws.test.ts does:
   * routing is under test here, not sign-in (auth-account.test.ts owns that). */
  async function makeUser(identityKey: string): Promise<{ userId: string; token: string }> {
    const resolution = await db.getOrCreateUserByIdentityKey(
      identityKey,
      deps.newUserId(),
      deps.now(),
    );
    if (resolution.kind !== 'ok') throw new Error('fixture account was not created');
    const token = deps.newAuthToken();
    await db.createSession({
      token,
      userId: resolution.user.userId,
      createdAt: deps.now(),
      expiresAt: Math.floor(deps.now() / 1000) + 3600,
    });
    return { userId: resolution.user.userId, token };
  }

  beforeEach(async () => {
    db = makeMemoryDb();
    deps = makeTestDeps(db);
    sender = makeFakeSender();
    wsDeps = {
      ...deps,
      sender,
      schedulePush: async () => {},
      scheduleDrain: async (userId, connectionId) => {
        await drainQueuedMessages(userId, connectionId, { db, sender, now: deps.now });
      },
    };
    ({ userId: aliceId, token: aliceToken } = await makeUser(ALICE_KEY));
    ({ userId: bobId } = await makeUser(BOB_KEY));
  });

  /**
   * Dial the way a client does: mint a ticket for the role over the REAL ticket
   * handler, then present it at $connect.
   *
   * Driven end to end on purpose. The role has to survive the mint, the ticket
   * row and `consumeWsTicket` to reach the arbitration, and a helper that
   * shortcut any of that would leave the plumbing between them untested — which
   * is the layer where "the client declares it, the server holds it" actually
   * lives.
   */
  async function connect(
    userId: string,
    connectionId: string,
    role: WsTicketRole = 'listen',
    /** Present the session's bearer at the mint, as clients do — the ticket
     * then binds its digest and the socket's row carries it. Omitted, the
     * dial is digestless, which this guardless harness permits. */
    token?: string,
  ) {
    const minted = await wsTicketHandler(
      {
        method: 'POST',
        path: '/v1/ws-ticket',
        headers: token !== undefined ? { authorization: `Bearer ${token}` } : {},
        body: JSON.stringify({ role }),
      },
      wsDeps,
      { userId },
    );
    expect(minted.statusCode).toBe(200);
    const { ticket } = parseBody<{ ticket: string }>(minted.body);
    return wsConnectHandler(
      { routeKey: '$connect', connectionId, queryStringParameters: { ticket } },
      wsDeps,
    );
  }

  /** The DELETED transitional bearer dial — kept to prove it stays refused. */
  function connectWithBearer(token: string, connectionId: string) {
    return wsConnectHandler(
      { routeKey: '$connect', connectionId, queryStringParameters: { token } },
      wsDeps,
    );
  }

  function disconnect(connectionId: string, userId: string) {
    return wsDisconnectHandler(
      { routeKey: '$disconnect', connectionId, senderUserId: userId },
      wsDeps,
    );
  }

  function sendFrame(to: string, msgId: string, connectionId: string, senderUserId: string) {
    return wsDefaultHandler(
      {
        routeKey: '$default',
        connectionId,
        senderUserId,
        body: JSON.stringify({ type: 'send', to, msgId, msgType: 'ciphertext', payload: B64 }),
      },
      wsDeps,
    );
  }

  function msgIdsIn(connectionId: string): string[] {
    return (sender.inbox.get(connectionId) ?? [])
      .filter((f) => f.type === 'msg')
      .map((f) => (f.type === 'msg' ? f.msgId : ''));
  }

  /** The listener is ROUTABLE, not merely recorded: bob's message is delivered
   * live to `connectionId` rather than silently queued for 30 days. */
  async function expectRoutable(connectionId: string): Promise<void> {
    await connect(bobId, 'conn-bob');
    const msgId = ulid();
    await sendFrame(aliceId, msgId, 'conn-bob', bobId);
    expect(msgIdsIn(connectionId)).toContain(msgId);
    expect(sender.inbox.get('conn-bob')).toContainEqual({
      type: 'receipt',
      msgId,
      state: 'delivered',
    });
  }

  describe('a one-shot never competes for the row', () => {
    it('the listener stays routable across a one-shot connect+send+disconnect', async () => {
      await connect(aliceId, 'conn-listen');
      expect((await db.getConnection(aliceId))?.connectionId).toBe('conn-listen');

      // A one-shot `tacendum send` dials from the SAME account, declaring the
      // role its ticket was minted for.
      await expect(connect(aliceId, 'conn-oneshot', 'send')).resolves.toMatchObject({
        statusCode: 200,
        userId: aliceId,
      });
      expect((await db.getConnection(aliceId))?.connectionId).toBe('conn-listen');

      // AND IT NEVER PROBED. A 'send' dial does not read the row, so it has
      // nobody to probe — the listener's socket sees no traffic at all until a
      // real message arrives. This is the assertion that tells "the one-shot
      // was spared because the probe said live" (the probe design) apart from "the
      // one-shot never entered the arbitration" (the role design): the first still
      // depends on the probe answering correctly, every time, forever.
      expect(sender.inbox.get('conn-listen')).toBeUndefined();

      // The row-less connection can still SEND: the receipt posts straight to
      // its connectionId, no connection row involved.
      const outId = ulid();
      await sendFrame(bobId, outId, 'conn-oneshot', aliceId);
      expect(sender.inbox.get('conn-oneshot')).toContainEqual({
        type: 'receipt',
        msgId: outId,
        state: 'sent', // bob is offline; the frame queued
      });

      // The one-shot closes. Its $disconnect's conditional delete must not take
      // the listener's row with it — this line is where the steal happened.
      await disconnect('conn-oneshot', aliceId);
      expect((await db.getConnection(aliceId))?.connectionId).toBe('conn-listen');

      await expectRoutable('conn-listen');
    });

    it('a listener dialling while a live one-shot is mid-flight takes the row', async () => {
      // The steal, in its stated shape. The one-shot dials first and is STILL
      // ANSWERING POSTS when the listener arrives — which is what used to make
      // the listener spare it, return 200 row-less, and never be promoted; the
      // one-shot then sent, disconnected, and its conditional delete removed
      // the only row the account had. On the local adapter this was
      // deterministic rather than rare: `local/ws.ts` puts the socket in its
      // map BEFORE calling wsConnectHandler, so a racing one-shot answers
      // probes from the instant its connection event fires.
      await connect(aliceId, 'conn-oneshot', 'send');
      expect(await db.getConnection(aliceId)).toBeUndefined(); // it claimed nothing

      await expect(connect(aliceId, 'conn-listen')).resolves.toMatchObject({ statusCode: 200 });
      expect((await db.getConnection(aliceId))?.connectionId).toBe('conn-listen');

      // The one-shot does its business and leaves. Nothing it does can reach
      // the listener's row.
      await sendFrame(bobId, ulid(), 'conn-oneshot', aliceId);
      await disconnect('conn-oneshot', aliceId);
      expect((await db.getConnection(aliceId))?.connectionId).toBe('conn-listen');

      await expectRoutable('conn-listen');
    });

    it("a whole one-shot lifecycle inside the listener's claim leaves the row alone", async () => {
      // The steal's actual interleaving: the one-shot's ENTIRE connect + send +
      // disconnect lands between the listener's row read and its claim. Under
      // the probe design this was the worst case — the one-shot's Put won, the listener's CAS was
      // refused, and the listener had to go back around and hope. Now there is
      // nothing to lose to: the one-shot writes no row, so the listener's claim
      // is not even contended, and no re-read is needed to recover.
      const trueClaim = db.claimConnection.bind(db);
      let raced = false;
      (db as WsDeps['db']).claimConnection = async (rec, expected) => {
        if (!raced && rec.connectionId === 'conn-listen') {
          raced = true;
          await connect(aliceId, 'conn-oneshot', 'send');
          await sendFrame(bobId, ulid(), 'conn-oneshot', aliceId);
          await disconnect('conn-oneshot', aliceId);
        }
        return trueClaim(rec, expected);
      };

      await expect(connect(aliceId, 'conn-listen')).resolves.toMatchObject({ statusCode: 200 });
      expect((await db.getConnection(aliceId))?.connectionId).toBe('conn-listen');
      await expectRoutable('conn-listen');
    });

    it('a one-shot still gets its drain, which is the only thing it dialled for', async () => {
      await connect(aliceId, 'conn-listen');
      // Queued and unacked — delivered to the listener once already, say, but
      // only an ack deletes the row.
      const qId = ulid();
      await db.enqueueMessage({
        recipientId: aliceId,
        msgId: qId,
        senderId: bobId,
        type: 'ciphertext',
        payload: B64,
        ts: deps.now(),
        expiresAt: Math.floor(deps.now() / 1000) + 60,
      });

      // `send --drain` and `sync` ride exactly this connection. The drain posts
      // to the DIALLING connectionId, never to whatever the row names, which is
      // why a role that owns no row still receives everything it came for.
      await connect(aliceId, 'conn-oneshot', 'send');
      expect(msgIdsIn('conn-oneshot')).toEqual([qId]);
      expect((await db.getConnection(aliceId))?.connectionId).toBe('conn-listen');
    });

    it('the role is server-held state: a role in the query string is not read', async () => {
      // The ticket is minted for 'listen' over an authenticated HTTPS request
      // and the row remembers that. A `role=send` bolted onto the socket URL is
      // a second, unauthenticated declaration of the same fact — and on AWS the
      // authorizer has already spent the ticket, so $connect could not check the
      // two agreed even if it wanted to. It must simply not be a channel.
      await connect(aliceId, 'conn-listen');
      const minted = await wsTicketHandler(
        { method: 'POST', path: '/v1/ws-ticket', headers: {}, body: JSON.stringify({ role: 'listen' }) },
        wsDeps,
        { userId: aliceId },
      );
      const { ticket } = parseBody<{ ticket: string }>(minted.body);

      const result = await wsConnectHandler(
        {
          routeKey: '$connect',
          connectionId: 'conn-liar',
          queryStringParameters: { ticket, role: 'send' },
        },
        wsDeps,
      );

      // Arbitrated as the LISTENER its ticket says it is: it probed the
      // incumbent, found it live, and was refused.
      expect(result.statusCode).toBe(503);
      expect(sender.inbox.get('conn-listen')).toHaveLength(1);
    });

    it('a bearer dial is refused and takes nothing — the transitional path is deleted', async () => {
      // The `?token=` scheme is gone. A valid thirty-day bearer in the
      // socket URL now gets the same 401 as no credential, and above all it
      // must not claim, probe or displace anybody's routing row on the way
      // out.
      await connect(aliceId, 'conn-listen');
      await expect(connectWithBearer(aliceToken, 'conn-bearer')).resolves.toMatchObject({
        statusCode: 401,
      });
      // The listener's row is exactly where it was.
      expect((await db.getConnection(aliceId))?.connectionId).toBe('conn-listen');
    });
  });

  describe('listener versus listener', () => {
    it('the probe is a receipt every shipped client discards — never an error or a msg', async () => {
      await connect(aliceId, 'conn-listen');
      await connect(aliceId, 'conn-second');

      const probes = sender.inbox.get('conn-listen') ?? [];
      expect(probes).toHaveLength(1);
      const probe = probes[0];
      // An error frame would ABORT a concurrent send from this account (the
      // CLI's waitFor reads any error in its window as the answer to its send);
      // a msg frame would fabricate a message. A receipt whose msgId nothing is
      // waiting on takes the replayed-receipt no-op path clients already have.
      expect(probe?.type).toBe('receipt');
      if (probe?.type === 'receipt') {
        // ULID-shaped, so client-side ServerFrame.safeParse accepts the frame
        // instead of logging it as protocol garbage.
        expect(probe.msgId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
      }
    });

    it('a second listener is REFUSED rather than left open and silently unroutable', async () => {
      await connect(aliceId, 'conn-listen');

      // The incumbent answered a probe, so the account is reachable — through
      // the other socket. Telling this one 200 would hand its client a healthy
      // connection that receives nothing and gives it nothing to notice; the
      // 503 is the only promotion path a row-less listener can have, because
      // its connectionId is deliberately stored nowhere and the server can
      // never reach it again.
      await expect(connect(aliceId, 'conn-second')).resolves.toEqual({ statusCode: 503 });
      expect(deps.logs).toContainEqual({
        event: 'ws_connect_incumbent_spared',
        fields: { reason: 'live' },
      });
      expect((await db.getConnection(aliceId))?.connectionId).toBe('conn-listen');
    });

    it('the refused listener wins the row on the redial after the incumbent leaves', async () => {
      await connect(aliceId, 'conn-listen');
      await expect(connect(aliceId, 'conn-second')).resolves.toEqual({ statusCode: 503 });

      // The incumbent goes. Both clients redial a 503 with a FRESH ticket — the
      // app on exponential backoff, the CLI a bounded number of times — and the
      // redial is a whole new arbitration, which is the entire point of
      // refusing rather than accepting row-less.
      await disconnect('conn-listen', aliceId);
      await expect(connect(aliceId, 'conn-second-redial')).resolves.toMatchObject({
        statusCode: 200,
      });
      await expectRoutable('conn-second-redial');
    });

    it('a crash reconnect (dead incumbent, aged row) still displaces the row and is routable', async () => {
      await connect(aliceId, 'conn-old');
      // The socket died without a $disconnect: the row survives, the socket
      // refuses posts. That Gone is a crash, and the reconnect takes the row —
      // the pre-probe behavior the probe must not regress.
      sender.dead.add('conn-old');
      deps.advanceMs(CONNECTION_REAP_GRACE_MS + 1);
      await connect(aliceId, 'conn-new');
      expect((await db.getConnection(aliceId))?.connectionId).toBe('conn-new');
      await expectRoutable('conn-new');
    });

    it('an establishing owner displaced mid-connect refuses ITSELF instead of going live row-less', async () => {
      // The displaced-establishing-owner case, and the invariant a previous revision of
      // this file inverted. It asserted that an incumbent still establishing
      // KEEPS its row, which needed the unsound 2 s settle; the fix for that was
      // to assert it LOSES the row, which pinned a stranding as correct. Neither
      // is the invariant. The invariant is: A LIVE SOCKET IS NEVER LEFT ROW-LESS
      // WITH NO PROMOTION PATH.
      //
      // So both halves are asserted here. Gone is still Gone at any row age — no
      // timer decides who is establishing, because none can: a $connect whose
      // row write applied but whose SDK response is delayed holds API Gateway
      // off establishing that socket for as long as the delay lasts, so any
      // fixed settle is out-waitable by construction. The displaced owner
      // instead discovers the loss on a consistent re-read of the row it just
      // claimed, and answers 503 — so its socket never establishes and its
      // client redials, rather than coming up healthy with nothing pointing at
      // it and every message for the account queuing the moment the winner
      // leaves.
      //
      // conn-a is modelled exactly as AWS presents it: posts answer Gone while
      // its $connect is still running, and succeed once. conn-b's whole dial
      // lands on conn-a's ownership re-read.
      sender.dead.add('conn-a');
      sender.reviveAfterProbe('conn-a');
      const trueGet = db.getConnection.bind(db);
      let raced = false;
      (db as WsDeps['db']).getConnection = async (uid) => {
        const row = await trueGet(uid);
        if (!raced && row?.connectionId === 'conn-a') {
          raced = true;
          await connect(aliceId, 'conn-b');
        }
        return trueGet(uid);
      };

      await expect(connect(aliceId, 'conn-a')).resolves.toEqual({ statusCode: 503 });
      expect(deps.logs).toContainEqual({
        event: 'ws_connect_incumbent_spared',
        fields: { reason: 'displaced' },
      });
      // The displacer owns the row and the account is reachable through it.
      expect((await db.getConnection(aliceId))?.connectionId).toBe('conn-b');
      await expectRoutable('conn-b');
    });

    it('a probe fault spares the row and REFUSES, because both clients redial a 503', async () => {
      await connect(aliceId, 'conn-old');
      deps.advanceMs(CONNECTION_REAP_GRACE_MS + 1);
      // The worst arrangement: the incumbent is genuinely DEAD, and the probe
      // cannot find that out because the AWS sender throws on non-Gone faults
      // (throttle, misconfigured management endpoint). A fault must never
      // displace — a broken management plane means nobody can be posted to
      // regardless of who holds the row, so displacing buys only the silence.
      //
      // It must also not answer 200. A previous revision removed this 503 on
      // the stated grounds that "No client performs [the redial]", having
      // checked packages/cli and not app/src/ws.ts — which is the primary
      // client and does redial: a non-200 refuses the upgrade, RN reports 1006
      // with openedAt null, one auth check returns 'blip', and it backs off and
      // dials again with a fresh ticket. Removing the refusal replaced that
      // bounded redial with "row-less on an open socket, forever".
      sender.dead.add('conn-old');
      let throttled = true;
      const basePost = sender.post.bind(sender);
      wsDeps.sender = {
        post: async (connectionId, frame) => {
          if (connectionId === 'conn-old' && throttled) {
            throw Object.assign(new Error('probe post refused'), { name: 'LimitExceededException' });
          }
          return basePost(connectionId, frame);
        },
      };
      await expect(connect(aliceId, 'conn-new')).resolves.toEqual({ statusCode: 503 });
      // The fault spared the row — displacement on ignorance stays forbidden.
      expect((await db.getConnection(aliceId))?.connectionId).toBe('conn-old');
      expect(deps.logs).toContainEqual({
        event: 'ws_connect_incumbent_spared',
        fields: { reason: 'probe_error' },
      });

      // The blip clears and the client dials again: the probe now gets a real
      // Gone, reaps the corpse, and owns the row — and ownership has to mean
      // ROUTABLE, not merely recorded.
      throttled = false;
      await expect(connect(aliceId, 'conn-redial')).resolves.toMatchObject({ statusCode: 200 });
      expect((await db.getConnection(aliceId))?.connectionId).toBe('conn-redial');
      await expectRoutable('conn-redial');
    });

    it('a one-shot is never refused by a fault it has no stake in', async () => {
      // The same management-plane blip, from a 'send' dial. It reads no row and
      // probes nobody, so there is no fault to be ignorant about and nothing to
      // refuse it over — `tacendum send` keeps working while the control plane
      // is sick, which is the case the 503 removal was reaching for and paid for
      // with the app's redial.
      await connect(aliceId, 'conn-old');
      wsDeps.sender = {
        post: async () => {
          throw Object.assign(new Error('probe post refused'), { name: 'LimitExceededException' });
        },
      };
      await expect(connect(aliceId, 'conn-oneshot', 'send')).resolves.toMatchObject({
        statusCode: 200,
        userId: aliceId,
      });
      expect((await db.getConnection(aliceId))?.connectionId).toBe('conn-old');
    });

    it('a stale probe verdict cannot displace a row the incumbent replaced mid-probe', async () => {
      await connect(aliceId, 'conn-old');
      deps.advanceMs(CONNECTION_REAP_GRACE_MS + 1);
      sender.dead.add('conn-old');
      const basePost = sender.post.bind(sender);
      wsDeps.sender = {
        post: async (connectionId, frame) => {
          if (connectionId === 'conn-old') {
            // While the probe's round trip is in flight, the old socket's owner
            // reconnects and takes the row. The probe's Gone is then a fact
            // about a connection that no longer holds it — acting on it put the
            // prober's row over a LIVE listener's, and that listener's
            // connectionId exists nowhere afterwards.
            await db.putConnection({
              userId: aliceId,
              connectionId: 'conn-relisten',
              connectedAt: deps.now(),
            });
          }
          return basePost(connectionId, frame);
        },
      };
      await expect(connect(aliceId, 'conn-new')).resolves.toEqual({ statusCode: 503 });
      expect((await db.getConnection(aliceId))?.connectionId).toBe('conn-relisten');
    });

    it("an incumbent whose $disconnect lands mid-probe frees the row for the connecting socket", async () => {
      await connect(aliceId, 'conn-old');
      deps.advanceMs(CONNECTION_REAP_GRACE_MS + 1);
      sender.dead.add('conn-old');
      const basePost = sender.post.bind(sender);
      wsDeps.sender = {
        post: async (connectionId, frame) => {
          if (connectionId === 'conn-old') {
            // The dead socket's $disconnect finally lands while the probe is in
            // flight: the row is gone, not replaced. The re-read must CLAIM
            // here, not spare — sparing on an absent row installs nobody, and a
            // live listener with no row is exactly the outage this gate exists
            // to prevent.
            await db.deleteConnection(aliceId, 'conn-old');
          }
          return basePost(connectionId, frame);
        },
      };
      await connect(aliceId, 'conn-new');
      expect((await db.getConnection(aliceId))?.connectionId).toBe('conn-new');
    });

    it("an eventually consistent miss on the initial read cannot clobber the listener's row", async () => {
      await connect(aliceId, 'conn-listen');
      // DynamoDB serves GetItem eventually consistent by default: the second
      // listener's initial read misses the row the first wrote moments ago. The
      // old code saw "no incumbent" and executed an unconditional Put — the
      // listener's row was overwritten by a connect that never probed anything,
      // and the account was left with a live listener and no row. The claim must
      // refuse to write over a row it never read.
      const trueGet = db.getConnection.bind(db);
      let misses = 1;
      (db as WsDeps['db']).getConnection = async (uid) => {
        if (misses > 0) {
          misses--;
          return undefined;
        }
        return trueGet(uid);
      };
      // The loser is refused — and the reason is 'live', not 'contended':
      // having lost the claim it went back around, read the row it had missed,
      // and PROBED the holder rather than assuming the winner was healthy.
      await expect(connect(aliceId, 'conn-second')).resolves.toEqual({ statusCode: 503 });
      expect(deps.logs).toContainEqual({
        event: 'ws_connect_incumbent_spared',
        fields: { reason: 'live' },
      });
      expect((await db.getConnection(aliceId))?.connectionId).toBe('conn-listen');
      await expectRoutable('conn-listen');
    });

    it("the data layer's claim verdict is final: a refusal never becomes a write", async () => {
      await connect(aliceId, 'conn-old');
      deps.advanceMs(CONNECTION_REAP_GRACE_MS + 1);
      sender.dead.add('conn-old');
      // The interleaving no re-read can see: a reconnect's conditional claim
      // lands between this connect's LAST read and its write. Only the store's
      // own conditional write can arbitrate that gap (TestOnlyDataLayer.claimConnection);
      // the handler's whole job is to lose gracefully when it says no. A handler
      // that fell back to read-then-Put here would re-read 'conn-old', conclude
      // "go", and clobber the winner.
      (db as WsDeps['db']).claimConnection = async (rec) => {
        await db.putConnection({
          userId: rec.userId,
          connectionId: 'conn-relisten',
          connectedAt: deps.now(),
        });
        return false;
      };
      await expect(connect(aliceId, 'conn-new')).resolves.toEqual({ statusCode: 503 });
      expect((await db.getConnection(aliceId))?.connectionId).toBe('conn-relisten');
      // Losing is not the end of the decision: the next pass reads conn-relisten
      // and probes it, so the row is left to a holder that ANSWERED, never to
      // one that merely won a race.
      expect(deps.logs).toContainEqual({
        event: 'ws_connect_incumbent_spared',
        fields: { reason: 'live' },
      });
    });

    it('a claim whose response was lost is discovered on the re-read, not reported as a loss', async () => {
      // The other way a claim comes back false: the conditional Put APPLIED and
      // its response was lost, so the SDK's retry failed the very
      // attribute_not_exists condition the first attempt satisfied. The row is
      // already ours and the store said "no". Treating that as a loss refused a
      // connection that in fact owned the row, and logged it as row-less —
      // which is how a healthy socket gets written off.
      const trueClaim = db.claimConnection.bind(db);
      let swallowed = false;
      (db as WsDeps['db']).claimConnection = async (rec, expected) => {
        const applied = await trueClaim(rec, expected);
        if (!swallowed) {
          swallowed = true;
          return false;
        }
        return applied;
      };

      await expect(connect(aliceId, 'conn-a')).resolves.toMatchObject({ statusCode: 200 });
      expect((await db.getConnection(aliceId))?.connectionId).toBe('conn-a');
      // Its own row is never probed: a receipt posted into a socket that is
      // still completing its handshake is a frame sent for no reason.
      expect(sender.inbox.get('conn-a')).toBeUndefined();
      expect(deps.logs).not.toContainEqual(
        expect.objectContaining({ event: 'ws_connect_incumbent_spared' }),
      );
    });

    it('a claim refused on every pass gives up and refuses instead of spinning', async () => {
      // The bound on the retry. Nothing here waits, so an account whose row is
      // genuinely being rewritten by other connects must terminate on attempts,
      // and it must terminate the same way every other row-less outcome does —
      // refused, logged, and redialled by the client on its own backoff.
      (db as WsDeps['db']).claimConnection = async () => false;
      await expect(connect(aliceId, 'conn-a')).resolves.toEqual({ statusCode: 503 });
      expect(deps.logs).toContainEqual({
        event: 'ws_connect_incumbent_spared',
        fields: { reason: 'contended' },
      });
    });

    it('a connect stalled scheduling its drain is never displaced into a rowless-but-open socket', async () => {
      // The round-6 finding: two seconds cannot prove a YOUNG connection dead,
      // because API Gateway cannot post to it until its $connect returns — and
      // the drain schedule (an SDK call that retries for seconds) used to sit
      // between the row write and that return, holding the row visible-but-
      // unpostable for longer than any settle. Modelled exactly: conn-a refuses
      // posts until its $connect resolves, and its drain schedule stalls on a
      // gate. The resolution is ORDERING — the row is claimed last — so the
      // one-shot that dials mid-stall finds no row to displace, and conn-a's
      // 200 means what it says.
      sender.dead.add('conn-a');
      let releaseDrain = (): void => {};
      const drainGate = new Promise<void>((resolve) => {
        releaseDrain = resolve;
      });
      const baseDrain = wsDeps.scheduleDrain;
      wsDeps.scheduleDrain = async (uid, cid) => {
        if (cid === 'conn-a') await drainGate; // the SDK retry stall
        await baseDrain(uid, cid);
      };
      const aConnect = connect(aliceId, 'conn-a');
      // One macrotask flushes every pending microtask: conn-a is now parked at
      // the stall, as far into its $connect as it will get.
      await new Promise((resolve) => setImmediate(resolve));

      // A one-shot dials, does its business, and leaves — all inside the stall.
      // Under the old ordering it found conn-a's row, out-waited the settle
      // against a socket nothing could post to, displaced it, and then deleted
      // its own row on the way out: nobody held a row, while conn-a was told 200.
      await connect(aliceId, 'conn-oneshot', 'send');
      await disconnect('conn-oneshot', aliceId);

      releaseDrain();
      await expect(aConnect).resolves.toMatchObject({ statusCode: 200 });
      sender.dead.delete('conn-a'); // $connect returned; the handshake completes

      // The property: a 200 from $connect and an established socket imply the
      // account is reachable — conn-a holds the row and messages deliver live.
      expect((await db.getConnection(aliceId))?.connectionId).toBe('conn-a');
      await expectRoutable('conn-a');
    });

    it("a drain failure on a spared connect leaves the incumbent's row alone", async () => {
      await connect(aliceId, 'conn-listen');
      wsDeps.scheduleDrain = async () => {
        throw new Error('drain schedule failed');
      };
      // The connect fails and the client retries — but the cleanup must only
      // remove a row this connect wrote, and it wrote none.
      await expect(connect(aliceId, 'conn-second')).rejects.toThrow('drain schedule failed');
      expect((await db.getConnection(aliceId))?.connectionId).toBe('conn-listen');
    });
  });

  describe('the ghost incumbent — same-session takeover', () => {
    /** A second live session for the SAME account — a second device. Built on
     * the data layer like `makeUser`'s: session plumbing is not under test. */
    async function secondSession(userId: string): Promise<string> {
      const token = deps.newAuthToken();
      await db.createSession({
        token,
        userId,
        createdAt: deps.now(),
        expiresAt: Math.floor(deps.now() / 1000) + 3600,
      });
      return token;
    }

    it("the same session's redial displaces its half-open ghost WITHOUT a probe", async () => {
      // The failure mode: a suspended phone's kernel keeps ACKing after the app
      // above it froze, so to a probe the ghost is indistinguishable from a
      // live listener. Modelled exactly — conn-ghost is NOT in sender.dead, so
      // a probe WOULD have answered 'live' and refused the redial. The fix has
      // to not ask.
      await connect(aliceId, 'conn-ghost', 'listen', aliceToken);
      expect((await db.getConnection(aliceId))?.sessionDigest).toBeDefined();

      // The same session dials again. NO clock advance on purpose, and well
      // inside CONNECTION_REAP_GRACE_MS: the displacement rides IDENTITY
      // evidence (the row's digest equals the dial's), never row age — the
      // file's constraint against elapsed-time inference stands. (No fake
      // timers here either; this harness's manual clock is the only clock,
      // so nothing can pin now() beside an advancing timer.)
      await expect(connect(aliceId, 'conn-fresh', 'listen', aliceToken)).resolves.toMatchObject({
        statusCode: 200,
      });

      // NEVER PROBED. This is the assertion that tells "displaced because the
      // probe said gone" apart from "the probe was skipped on identity": had
      // the probe run, this inbox would hold a receipt and the answer would
      // have been 'live' — the 503, the backoff, and the retry loop that
      // resets API Gateway's idle timer and keeps the ghost immortal.
      expect(sender.inbox.get('conn-ghost')).toBeUndefined();

      expect((await db.getConnection(aliceId))?.connectionId).toBe('conn-fresh');
      // The takeover is observable live, field-free — and it is a
      // takeover, not a sparing.
      expect(deps.logs).toContainEqual({ event: 'ws_connect_same_session_takeover', fields: {} });
      expect(deps.logs).not.toContainEqual(
        expect.objectContaining({ event: 'ws_connect_incumbent_spared' }),
      );
      await expectRoutable('conn-fresh');
    });

    it("a DIFFERENT session's dial still probes, and a live incumbent is still spared", async () => {
      // Cross-session contention is two devices, and there the probe's answer
      // is exactly the evidence wanted: the account IS reachable through the
      // other socket. The takeover must not widen into same-ACCOUNT.
      await connect(aliceId, 'conn-listen', 'listen', aliceToken);
      const token2 = await secondSession(aliceId);

      await expect(connect(aliceId, 'conn-second', 'listen', token2)).resolves.toEqual({
        statusCode: 503,
      });
      // It asked — one probe receipt — and it stood down.
      expect(sender.inbox.get('conn-listen')).toHaveLength(1);
      expect((await db.getConnection(aliceId))?.connectionId).toBe('conn-listen');
      expect(deps.logs).toContainEqual({
        event: 'ws_connect_incumbent_spared',
        fields: { reason: 'live' },
      });
      expect(deps.logs).not.toContainEqual(
        expect.objectContaining({ event: 'ws_connect_same_session_takeover' }),
      );
    });

    it('identity means BOTH digests: a digestless dial takes the probe path unchanged', async () => {
      // undefined === undefined must never read as "same session". A dial
      // carrying no digest has no identity to match on, so it probes like any
      // stranger and is spared like one.
      await connect(aliceId, 'conn-listen', 'listen', aliceToken);
      await expect(connect(aliceId, 'conn-anon')).resolves.toEqual({ statusCode: 503 });
      expect(sender.inbox.get('conn-listen')).toHaveLength(1);
      expect((await db.getConnection(aliceId))?.connectionId).toBe('conn-listen');
      expect(deps.logs).not.toContainEqual(
        expect.objectContaining({ event: 'ws_connect_same_session_takeover' }),
      );
    });

    it('every written connection row carries the TTL backstop, stamped by the store', async () => {
      // The bound on a row nothing ever displaces: API Gateway's 2 h
      // connection hard cap plus 15 min slack past connectedAt. Pinned as a
      // value so the slack cannot silently shrink under the cap.
      expect(CONNECTION_ROW_TTL_SECONDS).toBe(2 * 60 * 60 + 15 * 60);

      // The claim path ($connect) stamps it…
      await connect(aliceId, 'conn-listen', 'listen', aliceToken);
      const claimed = await db.getConnection(aliceId);
      expect(claimed?.expiresAt).toBe(connectionExpiresAt(claimed!.connectedAt));
      expect(claimed?.expiresAt).toBe(
        Math.floor(claimed!.connectedAt / 1000) + CONNECTION_ROW_TTL_SECONDS,
      );

      // …and so does the raw put, from the ROW's own connectedAt — the store
      // stamps every write, so no caller can forget it and none can override.
      deps.advanceMs(12_345);
      await db.putConnection({ userId: bobId, connectionId: 'conn-put', connectedAt: deps.now() });
      const put = await db.getConnection(bobId);
      expect(put?.expiresAt).toBe(connectionExpiresAt(deps.now()));

      // The takeover's rewrite refreshes the bound: the fresh socket's row
      // expires from ITS connectedAt, not the ghost's.
      deps.advanceMs(60_000);
      await connect(aliceId, 'conn-fresh', 'listen', aliceToken);
      const retaken = await db.getConnection(aliceId);
      expect(retaken?.connectionId).toBe('conn-fresh');
      expect(retaken?.expiresAt).toBe(connectionExpiresAt(deps.now()));
      expect(retaken!.expiresAt!).toBeGreaterThan(claimed!.expiresAt!);
    });

    it('a takeover whose CAS LOSES logs no takeover event — the count is landed claims, never intents', async () => {
      await connect(aliceId, 'conn-ghost', 'listen', aliceToken);
      // Between the takeover pass's read of conn-ghost and its conditional
      // claim, a competing writer lands — the interleaving no re-read can see,
      // same shape as "the data layer's claim verdict is final" above. The
      // claim itself is the REAL one, so it loses honestly.
      const trueClaim = db.claimConnection.bind(db);
      (db as WsDeps['db']).claimConnection = async (rec, expected) => {
        await db.putConnection({
          userId: rec.userId,
          connectionId: 'conn-relisten',
          connectedAt: deps.now(),
        });
        return trueClaim(rec, expected);
      };

      // The losing pass goes back around, reads conn-relisten (a different
      // holder, no shared digest), PROBES it, and is spared — and at no point
      // does the metric claim a displacement that never landed. Had the log
      // moved before the CAS, this run would have emitted it.
      await expect(connect(aliceId, 'conn-fresh', 'listen', aliceToken)).resolves.toEqual({
        statusCode: 503,
      });
      expect(deps.logs).not.toContainEqual(
        expect.objectContaining({ event: 'ws_connect_same_session_takeover' }),
      );
      expect(deps.logs).toContainEqual({
        event: 'ws_connect_incumbent_spared',
        fields: { reason: 'live' },
      });
      expect((await db.getConnection(aliceId))?.connectionId).toBe('conn-relisten');
    });

    it('a CAPTURED ticket cannot re-run the takeover: the first dial spent it', async () => {
      // The eviction-primitive worry, pinned at this seam: the takeover rides
      // the session DIGEST, and the digest reaches $connect only inside a
      // ticket that is spent — a conditional delete — by its first
      // presentation. A ticket lifted from a proxy log replays as nothing.
      await connect(aliceId, 'conn-ghost', 'listen', aliceToken);
      const minted = await wsTicketHandler(
        {
          method: 'POST',
          path: '/v1/ws-ticket',
          headers: { authorization: `Bearer ${aliceToken}` },
          body: JSON.stringify({ role: 'listen' }),
        },
        wsDeps,
        { userId: aliceId },
      );
      const { ticket } = parseBody<{ ticket: string }>(minted.body);

      // First presentation: the same-session takeover, landing as designed.
      await expect(
        wsConnectHandler(
          { routeKey: '$connect', connectionId: 'conn-fresh', queryStringParameters: { ticket } },
          wsDeps,
        ),
      ).resolves.toMatchObject({ statusCode: 200 });
      expect((await db.getConnection(aliceId))?.connectionId).toBe('conn-fresh');

      // The replay: refused at authentication, before any row logic runs — no
      // probe, no claim, no displacement. The live listener stands untouched.
      await expect(
        wsConnectHandler(
          { routeKey: '$connect', connectionId: 'conn-replay', queryStringParameters: { ticket } },
          wsDeps,
        ),
      ).resolves.toEqual({ statusCode: 401 });
      expect((await db.getConnection(aliceId))?.connectionId).toBe('conn-fresh');
      expect(sender.inbox.get('conn-fresh')).toBeUndefined();
    });
  });
});
