import { afterAll, beforeAll, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import WebSocket from 'ws';
import { startWsServer } from '../src/local/ws.js';
import { makeMemoryDb, makeTestDeps, testIdentityKey } from './helpers.js';
import { sessionTokenDigest, type DataLayer } from '../src/db/data.js';

/**
 * HOW THE LOCAL ADAPTER REFUSES, which is not the same question as WHY.
 *
 * API Gateway refuses the UPGRADE on any non-200 from `$connect`, so a client
 * there reads the status straight off the failed handshake. This host has
 * already completed the upgrade by the time `$connect` runs, so the only channel
 * it has left is the close code — and it used to spend the same one on every
 * non-200: `close(4001, 'unauthorized')`.
 *
 * That collapsed two refusals with opposite remedies. A 503 means the account's
 * routing row is held by another live connection and the remedy is to dial
 * again; 4001 means the credential is dead and the remedy is to re-authenticate.
 * Delivered as 4001, the CLI spent a full reauth on a routing conflict and the
 * app burnt its single auth probe on one. 1013 is RFC 6455's "Try Again Later",
 * and it routes both clients to a plain backoff redial instead.
 *
 * Driven through the real adapter over a real socket, because the mapping is
 * three lines inside `startWsServer` and every handler test in the repository
 * reaches `wsConnectHandler` directly — the status is asserted a dozen times
 * and the code it turns into, nowhere.
 */
let db: DataLayer;
let deps: ReturnType<typeof makeTestDeps>;
let server: Server;
let wsUrl: string;
let aliceId: string;

/** A fresh single-use ticket per dial — the only credential the socket takes.
 * Bound to a live session, as every real mint is (a digestless ticket is now
 * refused outright — fail-closed). */
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

/** The close code, from a dial that is expected not to survive. */
function dialForCloseCode(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.on('close', (code) => resolve(code));
    socket.on('error', reject);
  });
}

beforeAll(async () => {
  db = makeMemoryDb();
  deps = makeTestDeps(db);
  const resolution = await db.getOrCreateUserByIdentityKey(
    testIdentityKey(0x21),
    deps.newUserId(),
    deps.now(),
  );
  if (resolution.kind !== 'ok') throw new Error('fixture account was not created');
  aliceId = resolution.user.userId;

  server = startWsServer(0, deps);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  wsUrl = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws`;
});

afterAll(() => {
  server?.close();
});

it('a dead credential still closes 4001, so the remedy is still re-authentication', async () => {
  expect(await dialForCloseCode(`${wsUrl}?ticket=never-minted`)).toBe(4001);
});

it('a refused row claim closes 1013, not 4001 — redial, do not re-authenticate', async () => {
  // The first listener takes the row and stays open.
  const incumbent = new WebSocket(`${wsUrl}?ticket=${await mintTicket(aliceId)}`);
  await new Promise<void>((resolve, reject) => {
    incumbent.on('open', resolve);
    incumbent.on('error', reject);
  });

  try {
    // The second listener probes the incumbent, finds it live, and is refused
    // 503 by `$connect`. Delivered as 4001 this reads as "your session is
    // dead" — and the CLI's remedy for that is `POST /v1/auth`, which REVOKES
    // every other session for the account, including the incumbent's.
    expect(await dialForCloseCode(`${wsUrl}?ticket=${await mintTicket(aliceId)}`)).toBe(1013);
  } finally {
    incumbent.close();
  }
});
