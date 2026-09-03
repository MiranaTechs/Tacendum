import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import WebSocket from 'ws';
import type { ServerFrame } from '@tacendum/shared';
import { sessionTokenDigest, type TestOnlyDataLayer } from '../src/db/data.js';
import { makeMemoryDb, makeTestDeps, testIdentityKey } from './helpers.js';

/**
 * WHAT THE LOCAL ADAPTER PUTS INTO THE PUSH WORKER.
 *
 * `ws.lambda.push.test.ts` exists because the AWS scheduler silently dropped
 * `kind` and `message` on their way to Lambda — TypeScript accepts a narrower
 * arrow wherever a wider function type is expected, so every trailing
 * parameter the handler passed went into the void, and the compiler said
 * nothing. The local adapter's `schedulePush` is the OTHER arm of that same
 * deliberate twin, written as the same shape for the same reason — and it had
 * no test at all. An arm-drift there is invisible until someone runs the
 * local host and wonders why a behaviour that is pinned in the cloud does not
 * hold on their laptop.
 *
 * The field under test is `wakeId`: the per-schedule id the push worker uses
 * to tell a PLATFORM REDELIVERY of one wake apart from two genuine wakes. The
 * local host cannot redeliver anything — it awaits `deliverPushWake` inline,
 * exactly once — so nothing here would break if the field were dropped. That
 * is precisely why it needs pinning: a silently-dropped field on the arm that
 * does not need it is how the arms drift apart, and the next fix built on
 * "both schedulers carry X" is then wrong on one host.
 *
 * BOTH BRANCHES, because the local scheduler forks: a `verify` wake is
 * DETACHED (it sleeps the ack grace inside the worker, and awaiting it would
 * stall the send path for the whole grace), everything else is awaited.
 */

const { deliverPushWakeMock } = vi.hoisted(() => ({
  deliverPushWakeMock: vi.fn(),
}));

vi.mock('../src/handlers/push-worker.js', () => ({
  deliverPushWake: deliverPushWakeMock,
}));

const { startWsServer } = await import('../src/local/ws.js');

let db: TestOnlyDataLayer;
let deps: ReturnType<typeof makeTestDeps>;
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
  const socket = new WebSocket(`${wsUrl}?ticket=${encodeURIComponent(await mintTicket(userId))}`);
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  return socket;
}

/** Send one frame and resolve on its receipt, so the assertion runs after the
 * adapter has finished with it. */
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

it('threads a wakeId into the worker on both scheduler branches', async () => {
  deliverPushWakeMock.mockReset();
  deliverPushWakeMock.mockResolvedValue('sent');

  // BRANCH 1 — the awaited bare wake. Nobody is listening for bob, so the
  // urgent frame takes the no-connection path: no probe, no msgId, the
  // asleep-phone ring.
  const sender = await dial(alice);
  await sendAwaitingReceipt(sender, {
    type: 'send',
    to: bob,
    msgId: '01JBQ0000000000000000000CA',
    msgType: 'ciphertext',
    payload: 'QUJD',
    urgent: true,
  });

  // BRANCH 2 — the detached verify wake. bob's socket now exists and takes
  // the bytes, so the wake carries the ack-liveness probe and the local
  // scheduler fires it WITHOUT awaiting. `deliverPushWake` is still invoked
  // synchronously, so the call is recorded by the time the receipt lands.
  const listener = await dial(bob);
  await sendAwaitingReceipt(sender, {
    type: 'send',
    to: bob,
    msgId: '01JBQ0000000000000000000CB',
    msgType: 'ciphertext',
    payload: 'QUJD',
    urgent: true,
  });
  listener.close();
  sender.close();

  const events = deliverPushWakeMock.mock.calls.map(
    ([event]) => event as { verify?: unknown; wakeId?: string },
  );
  expect(events).toHaveLength(2);
  const bare = events.find((event) => !event.verify);
  const probed = events.find((event) => event.verify);
  expect(bare).toBeDefined();
  expect(probed).toBeDefined();
  for (const event of [bare, probed]) {
    expect(typeof event?.wakeId).toBe('string');
    expect((event?.wakeId as string).length).toBeGreaterThan(0);
  }
  // Two schedules, two ids. Reusing one would make the second ring look like
  // a redelivery of the first and silence it.
  expect(bare?.wakeId).not.toBe(probed?.wakeId);
});
