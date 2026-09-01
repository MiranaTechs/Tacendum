import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import WebSocket from 'ws';
import type { SendFrame, ServerFrame } from '@tacendum/shared';
import { wsDefaultHandler, type WsDeps } from '../src/handlers/ws.js';
import { startWsServer } from '../src/local/ws.js';
import { sessionTokenDigest, type DataLayer } from '../src/db/data.js';
import { makeMemoryDb, makeTestDeps, testIdentityKey, type TestDeps } from './helpers.js';

/**
 * WHERE THE WAKE ID IS MINTED — the one rule the redelivery guard rests on,
 * and the one nothing used to enforce.
 *
 * `wakeRecipient` (ws.ts) mints a FRESH ULID per SCHEDULE, and three separate
 * comments — push-worker.ts on `PushWakeEvent.wakeId`, ws.ts at the mint,
 * data.ts on `wakeAlreadyRang` — say in as many words that it must never be
 * derived from the frame. Nothing tested it. Replacing the mint with
 * `w-${message?.msgId ?? verify?.msgId ?? recipientId}` left all 74 server
 * files and 683 tests green, and it is a DENIAL-OF-RING:
 *
 *   callee offline -> offer wake rings -> claim written -> ack dropped in
 *   flight -> the client resends the SAME offer with the SAME msgId (the
 *   exact resend ws.ts refuses to gate, because gating it is on this
 *   project's rejected-remedies list) -> same derived wakeId -> the worker's
 *   `alreadyRang` says true -> 'redelivered' -> THE PHONE NEVER RINGS.
 *
 * The three tests that touch wakeId could not see it. `push.redelivery.test.ts`
 * hand-writes 'wake-a'/'wake-b' and calls `deliverPushWake` directly, so it
 * never reaches the mint at all; `ws.lambda.push.test.ts` and
 * `local.ws.push.test.ts` do reach it, but compare the ids of two wakes built
 * from frames with DIFFERENT msgIds — which a msgId-derived key satisfies.
 *
 * So the assertion here is the one the design actually needs: TWO SCHEDULING
 * DECISIONS OVER ONE IDENTICAL FRAME GET TWO IDS, on both wake branches, and
 * the real local host really rings twice for them.
 */

const SENDER = '0000000000000000000SENDER1';
const RECIPIENT = '0000000000000000000RECPT02';
/** ONE msgId, reused deliberately — a client resend reuses it, and that is the
 * whole point of this file. */
const MSG = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

/** Crockford base32, 26 characters — what `ulid()` produces.
 *
 * Distinctness alone is timing-dependent: a key derived from `Date.now()` is
 * "fresh per schedule" only until two resends land in the same millisecond,
 * which is exactly when a caller redials. Pinning the shape as well means the
 * guard rail does not depend on how fast this suite happens to run. */
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** Fake transport: every post succeeds. A post that succeeds is precisely the
 * half-open-socket case the verify branch exists for (ws.ts, Phase H
 * hardware), so this is the branch, not a neighbour of it. */
function makeFakeSender() {
  return {
    async post(): Promise<boolean> {
      return true;
    },
  };
}

describe('the wake id mint', () => {
  let db: DataLayer;
  let deps: TestDeps;
  let wsDeps: WsDeps;
  /** Every schedule this run, in order, exactly as `wakeRecipient` handed it
   * over — no worker, so nothing sleeps out an ack grace. */
  let scheduled: Array<{ verify?: { msgId: string }; wakeId?: string }>;

  const frame = (): SendFrame =>
    ({
      type: 'send',
      to: RECIPIENT,
      msgId: MSG,
      msgType: 'ciphertext',
      payload: 'QUJD',
      urgent: true,
    }) as SendFrame;

  const send = async (): Promise<unknown> =>
    wsDefaultHandler(
      {
        routeKey: '$default' as const,
        connectionId: 'conn-sender',
        senderUserId: SENDER,
        body: JSON.stringify(frame()),
      },
      wsDeps,
    );

  beforeEach(async () => {
    scheduled = [];
    db = makeMemoryDb();
    deps = makeTestDeps(db);
    wsDeps = {
      ...deps,
      sender: makeFakeSender(),
      scheduleDrain: async () => {},
      // EVERY PARAMETER NAMED, for the reason the adapters state: a narrower
      // arrow typechecks and silently drops the trailing ones — which here
      // would drop the very field under test and make this file vacuous.
      schedulePush: async (_recipientId, _senderUserId, _kind, _message, verify, wakeId) => {
        scheduled.push({ ...(verify ? { verify: { msgId: verify.msgId } } : {}), ...(wakeId ? { wakeId } : {}) });
      },
    };
    for (const userId of [SENDER, RECIPIENT]) {
      await db.createUser({ userId, createdAt: deps.now() });
    }
    await db.putPushToken({
      userId: RECIPIENT,
      voipToken: 'a'.repeat(64),
      env: 'sandbox',
      bundleId: 'com.miranatechnologies.tacendum',
      updatedAt: deps.now(),
      expiresAt: Math.floor(deps.now() / 1000) + 86_400,
    });
  });

  it('gives an offline callee a fresh id for each resend of one offer', async () => {
    // The BARE wake — no connection row, no probe, no msgId on the event.
    // The dominant ring case (a locked phone), and the one where a derived
    // key has nothing to fall back on but the recipient id, which is constant
    // for the whole conversation.
    await send();
    await send();

    expect(scheduled).toHaveLength(2);
    const ids = scheduled.map((entry) => entry.wakeId);
    for (const id of ids) expect(id).toMatch(ULID);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it('gives a frozen callee a fresh id for each resend of one offer', async () => {
    // The VERIFY wake — the frozen-callee redial itself. The row is live, the
    // post "succeeds" into a socket nobody is reading, so the wake carries the
    // ack probe and therefore carries the frame's msgId. Both schedules name
    // the SAME msgId, which is what makes this the branch a frame-derived key
    // silences even if the bare branch above were somehow spared.
    await db.putConnection({
      userId: RECIPIENT,
      connectionId: 'conn-recipient',
      connectedAt: deps.now(),
    });

    await send();
    await send();

    expect(scheduled).toHaveLength(2);
    expect(scheduled.map((entry) => entry.verify?.msgId)).toEqual([MSG, MSG]);
    const ids = scheduled.map((entry) => entry.wakeId);
    for (const id of ids) expect(id).toMatch(ULID);
    expect(ids[0]).not.toBe(ids[1]);
  });
});

/**
 * THE SAME CLAIM AT THE LOCAL HOST, END TO END.
 *
 * Above, the worker is absent and the assertion is about ids. Here the real
 * `startWsServer` runs the real `deliverPushWake` against the real memory data
 * layer, so the assertion is the thing a user would notice: the resent offer
 * RINGS. If the mint ever collapses, this fails as "1 push instead of 2" —
 * a missed call, stated in the units the rule is written in.
 *
 * The AWS arm of the same twin is pinned on the wire bytes in
 * `ws.lambda.push.test.ts` ("two identical frames get two different wakeIds"),
 * because that host schedules through an async Lambda invoke it cannot await
 * a ring out of.
 */
describe('the local host', () => {
  let db: DataLayer;
  let deps: TestDeps;
  let server: Server;
  let wsUrl: string;
  let alice: string;
  let bob: string;

  /** A fresh single-use ticket bound to a live session — the only credential
   * the socket takes (a digestless ticket is refused outright). */
  async function mintTicket(userId: string): Promise<string> {
    const token = deps.newAuthToken();
    await db.createSession({
      token,
      userId,
      createdAt: deps.now(),
      expiresAt: Math.floor(deps.now() / 1000) + 3600,
    });
    const ticket = deps.newAuthToken();
    await db.putWsTicket({
      ticket,
      userId,
      expiresAt: Math.floor(deps.now() / 1000) + 60,
      role: 'listen',
      sessionDigest: sessionTokenDigest(token),
    });
    return ticket;
  }

  async function dial(userId: string): Promise<WebSocket> {
    const socket = new WebSocket(
      `${wsUrl}?ticket=${encodeURIComponent(await mintTicket(userId))}`,
    );
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    return socket;
  }

  /** Send one frame and resolve on its receipt, so the assertion runs after
   * the adapter has finished with it — the local scheduler AWAITS the worker
   * on this branch. */
  function sendAwaitingReceipt(socket: WebSocket, frame: Record<string, unknown>): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no receipt')), 5_000);
      const onMessage = (data: WebSocket.RawData): void => {
        const parsed = JSON.parse(data.toString()) as ServerFrame;
        if (parsed.type !== 'receipt' || parsed.msgId !== frame.msgId) return;
        clearTimeout(timer);
        socket.off('message', onMessage);
        resolve();
      };
      socket.on('message', onMessage);
      socket.send(JSON.stringify(frame));
    });
  }

  async function makeUser(seed: number): Promise<string> {
    const resolution = await db.getOrCreateUserByIdentityKey(
      testIdentityKey(seed),
      deps.newUserId(),
      deps.now(),
    );
    if (resolution.kind !== 'ok') throw new Error('fixture account was not created');
    return resolution.user.userId;
  }

  beforeAll(async () => {
    db = makeMemoryDb();
    deps = makeTestDeps(db);
    alice = await makeUser(0x41);
    bob = await makeUser(0x42);
    await db.putPushToken({
      userId: bob,
      voipToken: 'v'.repeat(64),
      env: 'sandbox',
      bundleId: 'com.miranatechnologies.tacendum',
      updatedAt: deps.now(),
      expiresAt: Math.floor(deps.now() / 1000) + 86_400,
    });

    server = startWsServer(0, deps);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    wsUrl = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws`;
  });

  afterAll(() => {
    server?.close();
  });

  it('rings the offline callee for BOTH sends of a resent call offer', async () => {
    const sender = await dial(alice);
    const offer = {
      type: 'send',
      to: bob,
      msgId: MSG,
      msgType: 'ciphertext',
      payload: 'QUJD',
      urgent: true,
    };

    await sendAwaitingReceipt(sender, offer);
    // The resend: byte-identical, because that is what a client retry after a
    // dropped ack puts on the wire.
    await sendAwaitingReceipt(sender, offer);
    sender.close();

    expect(deps.pushesSent).toEqual([
      { userId: bob, fromUserId: alice },
      { userId: bob, fromUserId: alice },
    ]);
    // Named explicitly so a failure says WHICH silence this was. The worker
    // logs this line only when the redelivery guard fired, and a resend is
    // not a redelivery.
    expect(deps.logs.filter((entry) => entry.event === 'push_suppressed_redelivery')).toEqual([]);
  });
});
