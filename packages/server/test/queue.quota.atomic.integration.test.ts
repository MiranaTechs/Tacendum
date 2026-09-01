import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { monotonicFactory } from 'ulid';
import { ListTablesCommand } from '@aws-sdk/client-dynamodb';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { TABLES } from '@tacendum/shared';
import { makeDynamoClient, makeDocClient } from '../src/db/client.js';
import {
  makeDataLayer,
  QueuedQuotaExceededError,
  type DataLayer,
  type QueueQuota,
  type QueuedMessage,
} from '../src/db/data.js';
import { allQueued, makeMemoryDb } from './helpers.js';

/**
 * The per-pair offline-queue cap must hold under CONCURRENCY.
 *
 * The enforcement was check-then-write: a Query that counted the pair's
 * rows, then an unconditional Put. Two sends racing both counted before either
 * wrote, and BOTH landed — a concurrency scan reproduced `fulfilled=2,
 * rejected=0` against a one-item limit. A cap that only holds sequentially is
 * not a cap; it is a suggestion an attacker's concurrency ignores.
 *
 * The property asserted here is the race itself: N concurrent enqueues against
 * a limit of 1 admit EXACTLY one, against the REAL DynamoDB store — the place
 * the race physically exists — and against the memory twin, which must enforce
 * the same rule atomically or every handler unit test proves the wrong store.
 *
 * Alongside atomicity, the ledger must RELEASE: an ack frees the pair's slot,
 * or the cap decays into a permanent lockout for that pair. And because
 * DynamoDB TTL reaps message rows without running our code, a counter that
 * drifted above the truth must self-heal on the refusal path rather than
 * silence a legitimate correspondent forever.
 */

const ulid = monotonicFactory();
const RACERS = 8;

function makeMsg(recipientId: string, senderId: string, payload = 'x'): QueuedMessage {
  return {
    recipientId,
    msgId: ulid(),
    senderId,
    type: 'ciphertext',
    payload,
    ts: Date.now(),
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  };
}

async function raceEnqueues(
  dbForRacer: (i: number) => DataLayer,
  recipientId: string,
  senderId: string,
): Promise<{ fulfilled: number; rejected: number; nonQuotaErrors: unknown[] }> {
  const results = await Promise.allSettled(
    Array.from({ length: RACERS }, (_v, i) =>
      dbForRacer(i).enqueueMessage(makeMsg(recipientId, senderId)),
    ),
  );
  const fulfilled = results.filter((r) => r.status === 'fulfilled').length;
  const rejectedResults = results.filter(
    (r): r is PromiseRejectedResult => r.status === 'rejected',
  );
  const nonQuotaErrors = rejectedResults
    .map((r) => r.reason as unknown)
    .filter((reason) => !(reason instanceof QueuedQuotaExceededError));
  return { fulfilled, rejected: rejectedResults.length, nonQuotaErrors };
}

describe('S1 — the quota is atomic under concurrency (real DynamoDB)', () => {
  let available = false;
  let doc: ReturnType<typeof makeDocClient>;
  let db: DataLayer;
  const purgeTargets: string[] = [];

  const QUOTA: QueueQuota = { items: 1, bytes: 1_000_000 };

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
    if (available) db = makeDataLayer(doc, QUOTA);
  });

  afterAll(async () => {
    if (!available) return;
    // Purge sweeps the whole partition — message rows and quota bookkeeping
    // alike — so the shared local store does not accumulate run garbage.
    for (const recipientId of purgeTargets) {
      await db.purgeQueuedMessages(recipientId);
    }
  });

  it(`admits EXACTLY one of ${RACERS} concurrent sends against a limit of 1`, async (ctx) => {
    if (!available) return ctx.skip();
    const recipient = `01RACE${ulid()}`;
    const sender = `01SRACE${ulid()}`;
    purgeTargets.push(recipient);

    // One client — one TCP connection — per racer, so the requests are
    // genuinely concurrent at the store instead of serialising on a shared
    // keep-alive socket and passing by scheduling luck.
    const racers = Array.from({ length: RACERS }, () =>
      makeDataLayer(makeDocClient(makeDynamoClient()), QUOTA),
    );
    const { fulfilled, rejected, nonQuotaErrors } = await raceEnqueues(
      (i) => racers[i] ?? db,
      recipient,
      sender,
    );

    // The scanner's exact reproduction, inverted into the requirement: a
    // one-item cap admits one item no matter how the arrivals interleave.
    expect(nonQuotaErrors).toEqual([]);
    expect(fulfilled).toBe(1);
    expect(rejected).toBe(RACERS - 1);
    // And the store agrees with the verdicts: exactly one row exists.
    expect((await allQueued(db, recipient)).length).toBe(1);
  });

  it('an ack RELEASES the slot: the pair is not locked out forever', async (ctx) => {
    if (!available) return ctx.skip();
    const recipient = `01RREL${ulid()}`;
    const sender = `01SREL${ulid()}`;
    purgeTargets.push(recipient);

    const first = makeMsg(recipient, sender);
    await db.enqueueMessage(first);
    await expect(db.enqueueMessage(makeMsg(recipient, sender))).rejects.toBeInstanceOf(
      QueuedQuotaExceededError,
    );

    // The recipient acks the delivered message — the ledger must come back
    // down WITH THE ACK, in its transaction. (The refusal-path reconciler
    // would eventually scavenge a stale ledger too, but that would turn the
    // expensive recount into the common path of every active chat: the ack
    // is the release; the reconciler exists for TTL drift alone.)
    await db.deleteQueuedMessage(recipient, first.msgId);
    const ledger = await doc.send(
      new GetCommand({
        TableName: TABLES.messages,
        Key: { recipientId: recipient, msgId: `#quota#${sender}` },
      }),
    );
    expect(ledger.Item?.qItems).toBe(0);
    await expect(db.enqueueMessage(makeMsg(recipient, sender))).resolves.toEqual({
      inserted: true,
    });
    expect((await allQueued(db, recipient)).length).toBe(1);
  });

  it('only a USER-AUTHORED send establishes correspondence, against the real store', async (ctx) => {
    if (!available) return ctx.skip();
    // The store expressions the twin stands in for: `SET qEstab = :estab` on
    // the pair ledger for a user-authored send only, and the read that turns
    // it into `hasQueuedCorrespondence`. A syntax error in either only shows
    // against real DynamoDB, which is why this is here and not a twin unit.
    const recipient = `01RESTB${ulid()}`;
    const sender = `01SESTB${ulid()}`;
    purgeTargets.push(recipient);

    // An automatic carrier (call.end/busy, a read receipt): it queues and
    // counts, so the ledger row EXISTS — but it must NOT establish.
    const carrier = makeMsg(recipient, sender);
    await db.enqueueMessage(carrier, { establishesCorrespondence: false });
    const afterCarrier = await doc.send(
      new GetCommand({
        TableName: TABLES.messages,
        Key: { recipientId: recipient, msgId: `#quota#${sender}` },
      }),
    );
    expect(afterCarrier.Item?.qItems).toBe(1); // counted
    expect(afterCarrier.Item?.qEstab).toBeUndefined(); // but not established
    expect(
      await db.hasQueuedCorrespondence(sender, recipient, Math.floor(Date.now() / 1000)),
    ).toBe(false);

    // The carrier is delivered and acked (releasing the item:1 slot). Since
    // An UNESTABLISHED pair ledger emptied by an ack is REAPED, not
    // left at zero for 30 days, so this pair reverts to unknown either way.
    await db.deleteQueuedMessage(recipient, carrier.msgId);
    expect(
      await db.hasQueuedCorrespondence(sender, recipient, Math.floor(Date.now() / 1000)),
    ).toBe(false);

    // A user-authored message from the same sender now stamps the marker.
    await db.enqueueMessage(makeMsg(recipient, sender), {
      establishesCorrespondence: true,
    });
    const afterMsg = await doc.send(
      new GetCommand({
        TableName: TABLES.messages,
        Key: { recipientId: recipient, msgId: `#quota#${sender}` },
      }),
    );
    expect(afterMsg.Item?.qEstab).toBe(true);
    expect(
      await db.hasQueuedCorrespondence(sender, recipient, Math.floor(Date.now() / 1000)),
    ).toBe(true);
  });

  it('a counter drifted ABOVE the truth heals on refusal instead of silencing the pair', async (ctx) => {
    if (!available) return ctx.skip();
    // DynamoDB TTL deletes expired message rows without running our code, so
    // the ledger can be left counting rows that no longer exist. That upward
    // drift must be bounded — but the heal is OFF the refusal path now
    //: the refused send returns its refusal immediately and
    // SCHEDULES a leased, budgeted recount instead of paying for one
    // in-request. The guarantee under test is unchanged in what matters:
    // never refused FOREVER. The drifted ledger heals across a few refusals,
    // and once the reconcile's reset lands, a send from the legitimate
    // correspondent SUCCEEDS.
    const recipient = `01RDRIFT${ulid()}`;
    const sender = `01SDRIFT${ulid()}`;
    purgeTargets.push(recipient);

    // Manufacture the drift TTL would produce: a ledger row claiming the pair
    // is at cap while the partition holds nothing.
    await doc.send(
      new UpdateCommand({
        TableName: TABLES.messages,
        Key: { recipientId: recipient, msgId: `#quota#${sender}` },
        UpdateExpression: 'SET qItems = :i, qBytes = :b, expiresAt = :e',
        ExpressionAttributeValues: {
          ':i': QUOTA.items,
          ':b': 10,
          ':e': Math.floor(Date.now() / 1000) + 3600,
        },
      }),
    );

    // The FIRST send against the drifted ledger is refused — healing
    // in-request was the read-amplification DoS the redesign removed.
    await expect(db.enqueueMessage(makeMsg(recipient, sender))).rejects.toBeInstanceOf(
      QueuedQuotaExceededError,
    );

    // That refusal scheduled the out-of-band reconcile. Await its completed
    // reset: the recount of the empty partition lowers the ledger to zero.
    await expect
      .poll(
        async () => {
          const ledger = await doc.send(
            new GetCommand({
              TableName: TABLES.messages,
              Key: { recipientId: recipient, msgId: `#quota#${sender}` },
            }),
          );
          return ledger.Item?.qItems;
        },
        { timeout: 10_000, interval: 25 },
      )
      .toBe(0);

    // NEVER REFUSES FOREVER: with the ledger healed, the send is admitted and
    // genuinely stored (inserted: true — the caller's wake fires for it).
    await expect(db.enqueueMessage(makeMsg(recipient, sender))).resolves.toEqual({
      inserted: true,
    });
    expect((await allQueued(db, recipient)).length).toBe(1);
  });

  it('bookkeeping rows never surface in the drain stream and cannot be acked away', async (ctx) => {
    if (!available) return ctx.skip();
    const recipient = `01RCTL${ulid()}`;
    const sender = `01SCTL${ulid()}`;
    purgeTargets.push(recipient);

    await db.enqueueMessage(makeMsg(recipient, sender));
    // The pager must never replay the ledger as a message.
    for (const m of await allQueued(db, recipient)) {
      expect(m.msgId.startsWith('#')).toBe(false);
    }
    // A hostile ack naming the ledger row must not delete the pair's count.
    // (The frame schema already refuses non-ULID msgIds; the store refuses
    // independently so the guard does not live in exactly one place.)
    await db.deleteQueuedMessage(recipient, `#quota#${sender}`);
    const ledger = await doc.send(
      new GetCommand({
        TableName: TABLES.messages,
        Key: { recipientId: recipient, msgId: `#quota#${sender}` },
      }),
    );
    expect(ledger.Item).toBeDefined();
  });
});

describe('S1 — the memory twin enforces the same rule atomically', () => {
  it(`admits EXACTLY one of ${RACERS} concurrent sends against a limit of 1`, async () => {
    const db = makeMemoryDb({ items: 1, bytes: 1_000_000 });
    const recipient = `r-${ulid()}`;
    const sender = `s-${ulid()}`;

    const { fulfilled, rejected, nonQuotaErrors } = await raceEnqueues(() => db, recipient, sender);

    expect(nonQuotaErrors).toEqual([]);
    expect(fulfilled).toBe(1);
    expect(rejected).toBe(RACERS - 1);
    expect((await allQueued(db, recipient)).length).toBe(1);
  });

  it('an ack RELEASES the slot in the twin too', async () => {
    const db = makeMemoryDb({ items: 1, bytes: 1_000_000 });
    const recipient = `r-${ulid()}`;
    const sender = `s-${ulid()}`;

    const first = makeMsg(recipient, sender);
    await db.enqueueMessage(first);
    await expect(db.enqueueMessage(makeMsg(recipient, sender))).rejects.toBeInstanceOf(
      QueuedQuotaExceededError,
    );
    await db.deleteQueuedMessage(recipient, first.msgId);
    await expect(db.enqueueMessage(makeMsg(recipient, sender))).resolves.toEqual({
      inserted: true,
    });
  });
});
