import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { monotonicFactory } from 'ulid';
import WebSocket from 'ws';
import { QueryCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { TABLES, type ServerFrame } from '@tacendum/shared';
import { makeDocClient } from '../src/db/client.js';
import { makeDataLayer, sessionTokenDigest, type DataLayer } from '../src/db/data.js';
import { makeDeps } from '../src/local/http.js';
import { startWsServer } from '../src/local/ws.js';
import type { Deps } from '../src/handlers/http.js';
import { allQueued } from './helpers.js';

/**
 * Against the real ws adapter + DynamoDB Local:
 * 1. offline -> send -> connect -> receive -> ack -> messages row gone
 * 2. two live sockets: round-trip + receipts
 * Skips when DynamoDB Local is not reachable.
 */

const ulid = monotonicFactory();
const B64 = 'Y2lwaGVydGV4dA==';

let doc: DynamoDBDocumentClient;
let db: DataLayer;
let deps: Deps;
let server: Server;
let wsUrl: string;
let available = false;

const cleanupUsers: string[] = [];
const cleanupTokens: string[] = [];

async function makeUser(tag: string): Promise<{ userId: string; token: string }> {
  const userId = ulid();
  const token = `it-${tag}-${ulid()}`;
  cleanupUsers.push(userId);
  cleanupTokens.push(token);
  await db.createUser({ userId, createdAt: Date.now() });
  await db.createSession({
    token,
    userId,
    createdAt: Date.now(),
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  });
  return { userId, token };
}

/**
 * A fresh single-use ticket per dial, minted straight onto the sessions table
 * the way POST /v1/ws-ticket would. The socket takes ONLY a ticket now — the
 * transitional `?token=` branch is deleted — and each ticket is spent by
 * the $connect it authorises, so nothing needs cleaning up afterwards.
 */
async function mintTicket(userId: string, token: string): Promise<string> {
  const ticket = `it-tkt-${ulid()}`;
  await db.putWsTicket({
    ticket,
    userId,
    expiresAt: Math.floor(Date.now() / 1000) + 60,
    role: 'listen',
    // Bound to the minting session, as the real route always binds it — a
    // digestless ticket is refused outright (fail-closed).
    sessionDigest: sessionTokenDigest(token),
  });
  return ticket;
}

/** A ws client that records server frames and lets tests await specific ones. */
class TestClient {
  readonly frames: ServerFrame[] = [];
  private socket!: WebSocket;
  private waiters: { pred: (f: ServerFrame) => boolean; resolve: (f: ServerFrame) => void }[] = [];

  async connect(userId: string, token: string): Promise<void> {
    const ticket = await mintTicket(userId, token);
    this.socket = new WebSocket(`${wsUrl}?ticket=${encodeURIComponent(ticket)}`);
    await new Promise<void>((resolve, reject) => {
      this.socket.once('open', resolve);
      this.socket.once('error', reject);
    });
    this.socket.on('message', (data) => {
      const frame = JSON.parse(data.toString()) as ServerFrame;
      this.frames.push(frame);
      for (const w of [...this.waiters]) {
        if (w.pred(frame)) {
          this.waiters.splice(this.waiters.indexOf(w), 1);
          w.resolve(frame);
        }
      }
    });
  }

  /** Resolve on the first frame (past or future) matching pred. */
  waitFor(pred: (f: ServerFrame) => boolean, timeoutMs = 5000): Promise<ServerFrame> {
    const existing = this.frames.find(pred);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for frame')), timeoutMs);
      this.waiters.push({
        pred,
        resolve: (f) => {
          clearTimeout(timer);
          resolve(f);
        },
      });
    });
  }

  send(frame: unknown): void {
    this.socket.send(JSON.stringify(frame));
  }

  close(): void {
    this.socket?.close();
  }
}

beforeAll(async () => {
  doc = makeDocClient();
  db = makeDataLayer(doc);
  try {
    await doc.send(
      new QueryCommand({
        TableName: TABLES.messages,
        KeyConditionExpression: 'recipientId = :r',
        ExpressionAttributeValues: { ':r': 'probe' },
        Limit: 1,
      }),
    );
    available = true;
  } catch {
    if (process.env.TACENDUM_REQUIRE_DDB === '1') {
      throw new Error('TACENDUM_REQUIRE_DDB=1 but DynamoDB Local is unreachable');
    }
    console.warn('[skip] DynamoDB Local not reachable; skipping ws integration tests');
    return;
  }

  deps = { ...makeDeps(), db, log: () => {} };
  server = startWsServer(0, deps); // port 0 -> ephemeral
  await new Promise<void>((resolve) => server.on('listening', resolve));
  const { port } = server.address() as AddressInfo;
  wsUrl = `ws://localhost:${port}/ws`;
});

afterAll(async () => {
  server?.close();
  if (!available) return;
  const { DeleteCommand } = await import('@aws-sdk/lib-dynamodb');
  for (const userId of cleanupUsers) {
    for (const m of await allQueued(db, userId)) {
      await db.deleteQueuedMessage(userId, m.msgId);
    }
    await doc.send(new DeleteCommand({ TableName: TABLES.connections, Key: { userId } }));
    await doc.send(new DeleteCommand({ TableName: TABLES.users, Key: { userId } }));
  }
  for (const token of cleanupTokens) {
    await doc.send(new DeleteCommand({ TableName: TABLES.sessions, Key: { token } }));
  }
});

describe('ws adapter integration', () => {
  it('rejects a bad ticket — and a valid session bearer presented as ?token=', async (ctx) => {
    if (!available) ctx.skip();
    const socket = new WebSocket(`${wsUrl}?ticket=bogus`);
    const code = await new Promise<number>((resolve) => {
      socket.on('close', (c) => resolve(c));
      socket.on('error', () => {}); // swallow; close still fires
    });
    expect(code).toBe(4001);

    // The transitional bearer branch is DELETED: a working session token
    // in the URL is refused exactly like garbage, over the real adapter.
    const holder = await makeUser('t');
    const bearerDial = new WebSocket(`${wsUrl}?token=${encodeURIComponent(holder.token)}`);
    const bearerCode = await new Promise<number>((resolve) => {
      bearerDial.on('close', (c) => resolve(c));
      bearerDial.on('error', () => {}); // swallow; close still fires
    });
    expect(bearerCode).toBe(4001);
  });

  it('offline path: send -> queue -> connect -> receive -> ack -> row gone', async (ctx) => {
    if (!available) ctx.skip();
    const alice = await makeUser('a');
    const bob = await makeUser('b');

    const aliceClient = new TestClient();
    await aliceClient.connect(alice.userId, alice.token);

    // Bob is offline; alice sends.
    const msgId = ulid();
    aliceClient.send({ type: 'send', to: bob.userId, msgId, msgType: 'ciphertext', payload: B64 });

    // Sender receipt says 'sent' (queued, not delivered).
    const receipt = await aliceClient.waitFor((f) => f.type === 'receipt' && f.msgId === msgId);
    expect(receipt).toMatchObject({ state: 'sent' });
    expect(await allQueued(db, bob.userId)).toHaveLength(1);

    // Bob connects -> drain delivers the queued message.
    const bobClient = new TestClient();
    await bobClient.connect(bob.userId, bob.token);
    const msg = await bobClient.waitFor((f) => f.type === 'msg' && f.msgId === msgId);
    expect(msg).toMatchObject({ from: alice.userId, msgType: 'ciphertext', payload: B64 });

    // Not deleted until the ack.
    expect(await allQueued(db, bob.userId)).toHaveLength(1);
    bobClient.send({ type: 'ack', msgId });

    // Poll until the row is gone (ack is fire-and-forget).
    let remaining = -1;
    for (let i = 0; i < 40; i++) {
      remaining = (await allQueued(db, bob.userId)).length;
      if (remaining === 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(remaining).toBe(0);

    aliceClient.close();
    bobClient.close();
  });

  it('transport cap: a schema-max payload clears the socket; an over-32 KiB frame closes it with 1009', async (ctx) => {
    if (!available) ctx.skip();
    const carol = await makeUser('e');
    const dave = await makeUser('f');

    // The largest schema-legal payload (30 000 b64 chars) plus its envelope
    // must fit the adapter's 32 KiB frame ceiling — the whole point of the cap.
    const carolClient = new TestClient();
    await carolClient.connect(carol.userId, carol.token);
    const msgId = ulid();
    carolClient.send({
      type: 'send',
      to: dave.userId,
      msgId,
      msgType: 'ciphertext',
      payload: 'A'.repeat(30_000),
    });
    const receipt = await carolClient.waitFor((f) => f.type === 'receipt' && f.msgId === msgId);
    expect(receipt).toMatchObject({ state: 'sent' });
    carolClient.close();

    // Past 32 KiB the transport refuses the frame outright (1009 Message Too
    // Big) — mirroring API Gateway's frame cap — instead of an error frame
    // from the schema on a still-open socket.
    const doomed = new WebSocket(
      `${wsUrl}?ticket=${encodeURIComponent(await mintTicket(carol.userId, carol.token))}`,
    );
    await new Promise<void>((resolve, reject) => {
      doomed.once('open', () => resolve());
      doomed.once('error', reject);
    });
    doomed.send(
      JSON.stringify({
        type: 'send',
        to: dave.userId,
        msgId: ulid(),
        msgType: 'ciphertext',
        payload: 'A'.repeat(33 * 1024),
      }),
    );
    const closeCode = await new Promise<number>((resolve) => {
      doomed.on('close', (c) => resolve(c));
      doomed.on('error', () => {}); // swallow; close still fires
    });
    expect(closeCode).toBe(1009);
  });

  it('two sockets online: round-trip both ways with delivered receipts', async (ctx) => {
    if (!available) ctx.skip();
    const alice = await makeUser('c');
    const bob = await makeUser('d');

    const aliceClient = new TestClient();
    const bobClient = new TestClient();
    await aliceClient.connect(alice.userId, alice.token);
    await bobClient.connect(bob.userId, bob.token);

    // alice -> bob
    const m1 = ulid();
    const t0 = Date.now();
    aliceClient.send({ type: 'send', to: bob.userId, msgId: m1, msgType: 'prekey', payload: B64 });
    const gotByBob = await bobClient.waitFor((f) => f.type === 'msg' && f.msgId === m1);
    const latencyMs = Date.now() - t0;
    expect(gotByBob).toMatchObject({ from: alice.userId, msgType: 'prekey' });
    const r1 = await aliceClient.waitFor((f) => f.type === 'receipt' && f.msgId === m1);
    expect(r1).toMatchObject({ state: 'delivered' });
    // Local round-trip should be comfortably fast.
    expect(latencyMs).toBeLessThan(2000);

    // bob -> alice (reply direction)
    const m2 = ulid();
    bobClient.send({ type: 'ack', msgId: m1 });
    bobClient.send({ type: 'send', to: alice.userId, msgId: m2, msgType: 'ciphertext', payload: B64 });
    const gotByAlice = await aliceClient.waitFor((f) => f.type === 'msg' && f.msgId === m2);
    expect(gotByAlice).toMatchObject({ from: bob.userId, msgType: 'ciphertext' });
    const r2 = await bobClient.waitFor((f) => f.type === 'receipt' && f.msgId === m2);
    expect(r2).toMatchObject({ state: 'delivered' });

    aliceClient.close();
    bobClient.close();
  });
});
