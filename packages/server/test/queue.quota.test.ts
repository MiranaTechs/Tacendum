import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { monotonicFactory } from 'ulid';
import { ListTablesCommand } from '@aws-sdk/client-dynamodb';
import { DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { TABLES } from '@tacendum/shared';
import { makeDynamoClient, makeDocClient } from '../src/db/client.js';
import {
  makeDataLayer,
  QueuedQuotaExceededError,
  type DataLayer,
  type QueueQuota,
  type QueuedMessage,
} from '../src/db/data.js';
import { wsDefaultHandler, drainQueuedMessages, type WsDeps } from '../src/handlers/ws.js';
import type { ServerFrame } from '@tacendum/shared';
import { allQueued, makeMemoryDb, makeTestDeps, testIdentityKey } from './helpers.js';

/**
 * the offline queue has a per-(SENDER, recipient) item and byte cap.
 *
 * The streaming-drain fix stopped a flood from black-holing the
 * backlog, but nothing bounded what could be ENQUEUED: one account could pile
 * ~5 near-30 KB messages/sec at one victim for the 30-day TTL. This caps what
 * any one sender may leave undelivered for any one recipient — refusing the NEW
 * send, never evicting what is already queued, and PER PAIR so a flooder cannot
 * deny the victim to everyone else.
 *
 * Every property is asserted against BOTH data-layer implementations: the
 * memory twin inline, and the real DynamoDB layer under a gate. Small,
 * exhaustible caps are injected so the real store is exercised cheaply.
 */

const ulid = monotonicFactory();

function makeMsg(
  recipientId: string,
  senderId: string,
  payload: string,
  expiresAt = Math.floor(Date.now() / 1000) + 3600,
): QueuedMessage {
  return { recipientId, msgId: ulid(), senderId, type: 'ciphertext', payload, ts: Date.now(), expiresAt };
}

/** The per-pair cap contract, run against whichever DataLayer is passed. */
function quotaContract(makeDb: (quota: QueueQuota) => DataLayer, tag: string): void {
  const R = () => `r-${tag}-${ulid()}`;
  const A = () => `a-${tag}-${ulid()}`;

  it(`${tag}: refuses the item that would exceed the per-pair ITEM cap`, async () => {
    const db = makeDb({ items: 3, bytes: 1_000_000 });
    const recipient = R();
    const sender = A();

    for (let i = 0; i < 3; i++) {
      await db.enqueueMessage(makeMsg(recipient, sender, 'x'));
    }
    await expect(db.enqueueMessage(makeMsg(recipient, sender, 'x'))).rejects.toBeInstanceOf(
      QueuedQuotaExceededError,
    );
    // Refused the NEW one, evicted nothing: exactly the three that fit remain.
    expect((await allQueued(db, recipient)).length).toBe(3);
  });

  it(`${tag}: the cap is PER PAIR — a second sender is unaffected by the first filling it`, async () => {
    const db = makeDb({ items: 3, bytes: 1_000_000 });
    const recipient = R();
    const flooder = A();
    const honest = A();

    for (let i = 0; i < 3; i++) await db.enqueueMessage(makeMsg(recipient, flooder, 'x'));
    await expect(db.enqueueMessage(makeMsg(recipient, flooder, 'x'))).rejects.toBeInstanceOf(
      QueuedQuotaExceededError,
    );

    // The honest sender has its OWN full allowance against the same victim —
    // proving this is not a per-recipient TOTAL (which would be an eviction /
    // denial primitive the flooder could aim at everyone).
    for (let i = 0; i < 3; i++) {
      // A genuine first-time enqueue reports inserted: true — the stronger pin
      // (a duplicate would report false and must not spend wake budgets).
      await expect(db.enqueueMessage(makeMsg(recipient, honest, 'y'))).resolves.toEqual({
        inserted: true,
      });
    }
    expect((await allQueued(db, recipient)).length).toBe(6);
  });

  it(`${tag}: refuses the item that would exceed the per-pair BYTE cap, under the item cap`, async () => {
    const db = makeDb({ items: 100, bytes: 100 });
    const recipient = R();
    const sender = A();

    // 60 + 40 == 100 fits (<=), the next byte does not.
    await db.enqueueMessage(makeMsg(recipient, sender, 'A'.repeat(60)));
    await db.enqueueMessage(makeMsg(recipient, sender, 'B'.repeat(40)));
    await expect(db.enqueueMessage(makeMsg(recipient, sender, 'C'))).rejects.toBeInstanceOf(
      QueuedQuotaExceededError,
    );
    // Two items — far under the item cap — so it was the byte bound that bit.
    expect((await allQueued(db, recipient)).length).toBe(2);
  });
}

describe('memory data layer', () => {
  quotaContract((quota) => makeMemoryDb(quota), 'mem');
});

describe('DynamoDB data layer', () => {
  let available = false;
  const cleanup: Array<{ recipientId: string; msgId: string }> = [];
  let doc: ReturnType<typeof makeDocClient>;

  beforeAll(async () => {
    const client = makeDynamoClient();
    doc = makeDocClient(client);
    try {
      const { TableNames = [] } = await client.send(new ListTablesCommand({}));
      available = TableNames.includes(TABLES.messages);
    } catch {
      available = false;
    }
    if (process.env.TACENDUM_REQUIRE_DDB === '1' && !available) {
      throw new Error('TACENDUM_REQUIRE_DDB=1 but DynamoDB Local is down');
    }
  });

  afterAll(async () => {
    if (!available) return;
    for (const key of cleanup) {
      await doc.send(new DeleteCommand({ TableName: TABLES.messages, Key: key }));
    }
    // Enqueues now also write quota-ledger rows under each partition; purge
    // sweeps them so the shared local store keeps no run garbage.
    const db = makeDataLayer(doc);
    for (const recipientId of new Set(cleanup.map((k) => k.recipientId))) {
      await db.purgeQueuedMessages(recipientId);
    }
  });

  // A DataLayer whose enqueue also records rows for cleanup.
  function trackedDb(quota: QueueQuota): DataLayer {
    const db = makeDataLayer(doc, quota);
    const inner = db.enqueueMessage.bind(db);
    db.enqueueMessage = async (...args) => {
      // Forward the outcome, do not swallow it: the caller reads `inserted` to
      // decide whether a push budget is spent, and a wrapper that returned
      // void would make every tracked enqueue look like a duplicate.
      const outcome = await inner(...args);
      cleanup.push({ recipientId: args[0].recipientId, msgId: args[0].msgId });
      return outcome;
    };
    return db;
  }

  it('runs the per-pair cap contract against real DynamoDB', async (ctx) => {
    if (!available) return ctx.skip();
    // Re-run the same three properties against the real store, cheaply, via
    // the injected small caps. Sharing the contract is what proves the two
    // implementations enforce the SAME rule rather than merely both having one.
    const inner = describeInline();
    await inner.itemCap();
    await inner.perPair();
    await inner.byteCap();

    function describeInline() {
      const R = () => `01RQUOTA${ulid()}`;
      const S = () => `01SQUOTA${ulid()}`;
      return {
        async itemCap() {
          const db = trackedDb({ items: 3, bytes: 1_000_000 });
          const r = R();
          const s = S();
          for (let i = 0; i < 3; i++) await db.enqueueMessage(makeMsg(r, s, 'x'));
          await expect(db.enqueueMessage(makeMsg(r, s, 'x'))).rejects.toBeInstanceOf(
            QueuedQuotaExceededError,
          );
          expect((await allQueued(db, r)).length).toBe(3);
        },
        async perPair() {
          const db = trackedDb({ items: 3, bytes: 1_000_000 });
          const r = R();
          const flooder = S();
          const honest = S();
          for (let i = 0; i < 3; i++) await db.enqueueMessage(makeMsg(r, flooder, 'x'));
          await expect(db.enqueueMessage(makeMsg(r, flooder, 'x'))).rejects.toBeInstanceOf(
            QueuedQuotaExceededError,
          );
          for (let i = 0; i < 3; i++) await db.enqueueMessage(makeMsg(r, honest, 'y'));
          expect((await allQueued(db, r)).length).toBe(6);
        },
        async byteCap() {
          const db = trackedDb({ items: 100, bytes: 100 });
          const r = R();
          const s = S();
          await db.enqueueMessage(makeMsg(r, s, 'A'.repeat(60)));
          await db.enqueueMessage(makeMsg(r, s, 'B'.repeat(40)));
          await expect(db.enqueueMessage(makeMsg(r, s, 'C'))).rejects.toBeInstanceOf(
            QueuedQuotaExceededError,
          );
          expect((await allQueued(db, r)).length).toBe(2);
        },
      };
    }
  });

  it('the stored rows still drain (msgBytes is bookkeeping, not payload)', async (ctx) => {
    if (!available) return ctx.skip();
    // The real layer stashes a `msgBytes` attribute for cheap counting. Prove
    // it did not disturb what the drain posts: the frame the recipient gets is
    // the message, unchanged.
    const db = trackedDb({ items: 10, bytes: 1_000_000 });
    const r = `01RDRAIN${ulid()}`;
    const s = `01SDRAIN${ulid()}`;
    await db.enqueueMessage(makeMsg(r, s, 'Y2lwaGVydGV4dA=='));
    const posted: ServerFrame[] = [];
    await drainQueuedMessages(r, 'conn-x', {
      db,
      sender: {
        async post(_c, f) {
          posted.push(f);
          return true;
        },
      },
      now: () => Date.now(),
    });
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ type: 'msg', from: s, payload: 'Y2lwaGVydGV4dA==' });
  });
});

describe('handleSend surfaces the cap as a clean 429', () => {
  const B64 = 'Y2lwaGVydGV4dA==';

  it('the third send to an offline recipient is refused, nothing is evicted, no 500', async () => {
    const db = makeMemoryDb({ items: 2, bytes: 1_000_000 });
    const deps = makeTestDeps(db);
    const inbox = new Map<string, ServerFrame[]>();
    const sender = {
      async post(connectionId: string, frame: ServerFrame): Promise<boolean> {
        const frames = inbox.get(connectionId) ?? [];
        frames.push(frame);
        inbox.set(connectionId, frames);
        return true;
      },
    };
    const wsDeps: WsDeps = {
      ...deps,
      sender,
      scheduleDrain: async () => {},
      schedulePush: async () => {},
    };

    const alice = await db.getOrCreateUserByIdentityKey(testIdentityKey(0x71), deps.newUserId(), deps.now());
    const bob = await db.getOrCreateUserByIdentityKey(testIdentityKey(0x72), deps.newUserId(), deps.now());
    if (alice.kind !== 'ok' || bob.kind !== 'ok') throw new Error('fixtures not created');
    const aliceId = alice.user.userId;
    const bobId = bob.user.userId;

    const send = (msgId: string) =>
      wsDefaultHandler(
        {
          routeKey: '$default',
          connectionId: 'conn-a',
          senderUserId: aliceId,
          body: JSON.stringify({ type: 'send', to: bobId, msgId, msgType: 'ciphertext', payload: B64 }),
        },
        wsDeps,
      );

    expect((await send(ulid())).statusCode).toBe(200);
    expect((await send(ulid())).statusCode).toBe(200);

    const refused = await send(ulid());
    expect(refused.statusCode).toBe(429);

    // Specific, clean error frame — and it names neither bob's existence nor
    // his online state.
    const frames = inbox.get('conn-a') ?? [];
    const err = frames.find((f) => f.type === 'error');
    expect(err).toMatchObject({ type: 'error', code: 'send_quota_exceeded' });
    const detail = (err as { detail?: string }).detail ?? '';
    expect(detail).not.toMatch(/exist|online|offline|recipient/i);

    // Nothing evicted: bob still holds exactly the two that fit.
    expect((await allQueued(db, bobId)).length).toBe(2);
  });
});
