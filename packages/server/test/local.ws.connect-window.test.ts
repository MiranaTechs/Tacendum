import { afterAll, beforeAll, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import WebSocket from 'ws';
import type { ServerFrame } from '@tacendum/shared';
import { startWsServer } from '../src/local/ws.js';
import { sessionTokenDigest, type ConnectionRecord, type TestOnlyDataLayer } from '../src/db/data.js';
import { makeMemoryDb, makeTestDeps, testIdentityKey } from './helpers.js';

/**
 * THE CONNECT WINDOW: a message queued after the drain's snapshot and before
 * the recipient's connection row exists is delivered by NEITHER path.
 *
 * Found by the Android harness against a running local server: a CLI peer's
 * socket authenticated at ts=…203564, the app's message to that peer was
 * queued at ts=…203579 — 15 ms later — and it was neither posted to the live
 * socket nor drained. An hour later it was still in the peer's queue while the
 * sender's own row read 'sent'.
 *
 * `wsConnectHandler` calls `scheduleDrain` BEFORE `acquireConnectionRow`, which
 * is right on AWS (the call only enqueues a Lambda, and that Lambda waits for a
 * handshake API Gateway does not complete until $connect returns, so its
 * snapshot is taken after the row is visible). The local adapter used to run
 * the whole drain inline at that call site, which inverted the order:
 *
 * 1. $connect authenticates and runs the drain to completion — queue empty.
 * 2. ANOTHER user's `send` lands. `getConnection(recipient)` finds no row,
 * because this connect has not claimed one yet. The frame is enqueued and
 * the sender is told 'sent'.
 * 3. $connect claims the row and answers 200. The socket is live, routable,
 * and sitting on a message no path will ever deliver — nothing re-drains
 * without another $connect, so the frame waits out its 30-day TTL.
 *
 * The gap is every round trip `acquireConnectionRow` makes (read the incumbent,
 * probe it, claim, consistent re-read) plus the connect's own tail, which is
 * why 15 ms of real store latency was enough to hit it by accident.
 *
 * THE WINDOW IS REAL, NOT SIMULATED. Everything below is the shipping code
 * path: the real `startWsServer`, real `ws` sockets, the real handlers, the
 * real drain. The one test-side seam is a LATENCY injection — the recipient's
 * `claimConnection` is held open — which widens a window that already exists
 * instead of manufacturing one. Racing it for real would mean landing a send
 * inside a few microseconds of in-memory microtasks, and a test that hits the
 * defect one run in a thousand is a test that reports the fix as unnecessary.
 */

/** The frame that must not be lost. */
const MSG_ID = '01JBQ0000000000000000000WD';

let db: TestOnlyDataLayer;
let deps: ReturnType<typeof makeTestDeps>;
let server: Server;
let wsUrl: string;
let alice: string;
let bob: string;

/**
 * The one test-side seam, armed only while a test wants bob's row claim parked
 * mid-`$connect`. `announce` fires when the server reaches the claim (so the
 * test knows the drain has already been decided); `hold` is what the server
 * waits on, and the test resolves it to let the connect finish. Disarmed by the
 * first claim it catches, so the retry loop inside `acquireConnectionRow` and
 * every later reconnect run at full speed.
 */
let claimGate: { announce: () => void; hold: Promise<void> } | undefined;

/**
 * The memory store, with ONE call slowed down: the recipient's row claim. Every
 * other operation — the ticket spend, the queue read, the enqueue, the
 * connection reads — is the untouched twin, so the ordering under test is the
 * adapter's own.
 */
function withParkedClaim(inner: TestOnlyDataLayer): TestOnlyDataLayer {
  return {
    ...inner,
    async claimConnection(rec: ConnectionRecord, expectedConnectionId: string | undefined) {
      const gate = claimGate;
      if (gate !== undefined && rec.userId === bob) {
        // Park BEFORE the write commits — the row is not visible to the send
        // path until this returns, which is exactly the state the connect is
        // in for the duration of its own claim round trip.
        claimGate = undefined;
        gate.announce();
        await gate.hold;
      }
      return inner.claimConnection(rec, expectedConnectionId);
    },
  };
}

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
  const socket = new WebSocket(`${wsUrl}?ticket=${encodeURIComponent(await mintTicket(userId))}`);
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  return socket;
}

/** Send one frame; resolve with its receipt. */
function sendAwaitingReceipt(
  socket: WebSocket,
  frame: Record<string, unknown>,
): Promise<Extract<ServerFrame, { type: 'receipt' }>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no receipt')), 5_000);
    const onMessage = (data: WebSocket.RawData): void => {
      const parsed = JSON.parse(data.toString()) as ServerFrame;
      if (parsed.type !== 'receipt' || parsed.msgId !== frame.msgId) return;
      clearTimeout(timer);
      socket.off('message', onMessage);
      resolve(parsed);
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
  const memory = makeMemoryDb();
  db = withParkedClaim(memory);
  deps = makeTestDeps(db);
  alice = await makeUser(0x51);
  bob = await makeUser(0x52);

  server = startWsServer(0, deps);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  wsUrl = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws`;
});

afterAll(() => {
  server?.close();
});

it('delivers a message enqueued between the connect drain and the row claim', async () => {
  // The sender, established and routable before anything else happens.
  const sender = await dial(alice);

  // Park bob's row claim. From here until `release()`, bob's $connect is
  // exactly where the observed trace caught it: authenticated, drain decided,
  // no connection row yet.
  let announce!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((resolve) => {
    announce = resolve;
  });
  claimGate = {
    announce: () => announce(),
    hold: new Promise<void>((resolve) => {
      release = resolve;
    }),
  };

  const listener = new WebSocket(`${wsUrl}?ticket=${await mintTicket(bob)}`);
  const delivered = new Promise<void>((resolve) => {
    listener.on('message', (data: WebSocket.RawData) => {
      const frame = JSON.parse(data.toString()) as ServerFrame;
      if (frame.type === 'msg' && frame.msgId === MSG_ID) resolve();
    });
  });
  const closed = new Promise<number>((resolve) => listener.once('close', resolve));

  try {
    await reached;

    // THE SEND, inside the window. Nobody holds bob's row, so this queues and
    // the sender is told 'sent' — the exact receipt the trace recorded
    // beside the message that never arrived.
    const receipt = await sendAwaitingReceipt(sender, {
      type: 'send',
      to: bob,
      msgId: MSG_ID,
      msgType: 'ciphertext',
      payload: 'QUJD',
    });
    expect(receipt.state).toBe('sent');

    // Let the connect finish: it claims the row, re-reads it, answers 200.
    release();

    // The message must reach bob over the socket that was connecting when it
    // was queued. Without the parked drain, nothing ever posts it: the drain
    // ran before the send and no path re-runs it, so this races the timeout
    // and loses.
    await Promise.race([
      delivered,
      closed.then((code) => {
        throw new Error(`listener closed (${code}) before the queued message arrived`);
      }),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error('queued message was never delivered to the connecting socket')),
          4_000,
        ),
      ),
    ]);
  } finally {
    listener.close();
    sender.close();
  }
});
