import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { monotonicFactory } from 'ulid';
import { ListTablesCommand } from '@aws-sdk/client-dynamodb';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { TABLES } from '@tacendum/shared';
import { makeDynamoClient, makeDocClient } from '../src/db/client.js';
import {
  makeDataLayer,
  queuePairLedgerKey,
  type DataLayer,
  type QueuedMessage,
} from '../src/db/data.js';
import { makeMemoryDb } from './helpers.js';

/**
 * a zero-count UNESTABLISHED pair ledger is reaped, not left as a
 * durable per-sender control row a Sybil fleet can pile in the victim
 * partition. Established correspondence (a real user-authored send) survives at
 * zero as the correspondence signal and ages via its own TTL.
 *
 * establishment ages on its OWN clock. It once
 * shared the ledger's single expiry, so an attacker kept privilege alive
 * indefinitely by inducing the victim's device into automatic carriers that
 * refreshed it. A separate `qEstabExpiresAt`, refreshed only by user-authored
 * sends, ages establishment independently of automatic traffic.
 */

const ulid = monotonicFactory();

function makeMsg(
  recipientId: string,
  senderId: string,
  expiresAt: number,
): QueuedMessage {
  return {
    recipientId,
    msgId: ulid(),
    senderId,
    type: 'ciphertext',
    payload: 'Y2lwaGVydGV4dA==',
    ts: Date.now(),
    expiresAt,
  };
}

describe('zero-ledger reap and establishment aging (real DynamoDB)', () => {
  let available = false;
  let doc: ReturnType<typeof makeDocClient>;
  let db: DataLayer;
  const purgeTargets: string[] = [];

  const getLedger = (recipient: string, sender: string) =>
    doc.send(
      new GetCommand({
        TableName: TABLES.messages,
        Key: { recipientId: recipient, msgId: queuePairLedgerKey(sender) },
      }),
    );

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
    if (available) db = makeDataLayer(doc); // default quota (cap 5000)
  });

  afterAll(async () => {
    if (!available) return;
    for (const recipientId of purgeTargets) await db.purgeQueuedMessages(recipientId);
  });

  it('acking the last message of an UNESTABLISHED pair reaps the ledger row', async (ctx) => {
    if (!available) return ctx.skip();
    const recipient = `01RREAP${ulid()}`;
    const carrierSender = `01SCAR${ulid()}`;
    const realSender = `01SREAL${ulid()}`;
    purgeTargets.push(recipient);
    const soon = Math.floor(Date.now() / 1000) + 3600;

    // An UNESTABLISHED pair: only an automatic carrier (a call.end/busy, a read
    // receipt) ever rode it. Acking its last message must REAP the ledger.
    const carrier = makeMsg(recipient, carrierSender, soon);
    await db.enqueueMessage(carrier, { establishesCorrespondence: false });
    expect((await getLedger(recipient, carrierSender)).Item).toBeDefined();
    await db.deleteQueuedMessage(recipient, carrier.msgId);
    expect((await getLedger(recipient, carrierSender)).Item).toBeUndefined(); // reaped

    // An ESTABLISHED pair (a real user-authored message): its ledger SURVIVES
    // at zero as the correspondence signal, aging via its own TTL.
    const real = makeMsg(recipient, realSender, soon);
    await db.enqueueMessage(real, { establishesCorrespondence: true });
    await db.deleteQueuedMessage(recipient, real.msgId);
    const kept = await getLedger(recipient, realSender);
    expect(kept.Item).toBeDefined(); // survives
    expect(kept.Item?.qItems).toBe(0);
    expect(kept.Item?.qEstab).toBe(true);
  });

  it('an automatic carrier does NOT renew establishment past the user-authored window', async (ctx) => {
    if (!available) return ctx.skip();
    const recipient = `01REST${ulid()}`;
    const sender = `01SEST${ulid()}`;
    purgeTargets.push(recipient);
    const now = Math.floor(Date.now() / 1000);
    const estabExpiry = now + 100; // the user-authored send's TTL
    const carrierExpiry = now + 100_000; // a much later automatic carrier
    const between = now + 50_000; // after establishment expiry, before carrier's

    // A user-authored send establishes the pair, its own expiry riding this
    // message's TTL.
    await db.enqueueMessage(makeMsg(recipient, sender, estabExpiry), {
      establishesCorrespondence: true,
    });
    expect(await db.hasQueuedCorrespondence(sender, recipient, now)).toBe(true);

    // An automatic carrier much later pushes the ledger's GENERAL expiry far
    // forward — but must NOT renew establishment.
    await db.enqueueMessage(makeMsg(recipient, sender, carrierExpiry), {
      establishesCorrespondence: false,
    });

    // Queried after the user-authored window but before the carrier's TTL: the
    // ledger row is still live, but establishment has aged out on its own
    // clock. The shared-expiry bug renewed it here indefinitely.
    expect(await db.hasQueuedCorrespondence(sender, recipient, between)).toBe(false);
  });
});

describe('the memory twin ages establishment on its own clock', () => {
  it('an automatic carrier does not renew establishment past the user-authored window', async () => {
    const db = makeMemoryDb();
    const recipient = `r-${ulid()}`;
    const sender = `s-${ulid()}`;
    const now = Math.floor(Date.now() / 1000);
    const estabExpiry = now + 100;
    const carrierExpiry = now + 100_000;
    const between = now + 50_000;

    await db.enqueueMessage(makeMsg(recipient, sender, estabExpiry), {
      establishesCorrespondence: true,
    });
    expect(await db.hasQueuedCorrespondence(sender, recipient, now)).toBe(true);

    await db.enqueueMessage(makeMsg(recipient, sender, carrierExpiry), {
      establishesCorrespondence: false,
    });
    expect(await db.hasQueuedCorrespondence(sender, recipient, between)).toBe(false);
  });
});
