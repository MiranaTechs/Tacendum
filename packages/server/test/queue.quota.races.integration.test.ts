import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { monotonicFactory } from 'ulid';
import { ListTablesCommand } from '@aws-sdk/client-dynamodb';
import {
  GetCommand,
  QueryCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { TABLES } from '@tacendum/shared';
import { makeDynamoClient, makeDocClient } from '../src/db/client.js';
import {
  makeDataLayer,
  queuePairLedgerKey,
  QueuedQuotaExceededError,
  type DataLayer,
  type QueueQuota,
  type QueuedMessage,
} from '../src/db/data.js';
import { allQueued } from './helpers.js';

/**
 * the quota ledger cannot be reset BELOW the live truth.
 *
 * Two ways it could be, both against the REAL store because both live in
 * DynamoDB's concurrency and TTL semantics that the memory twin does not model:
 *
 *  (a) ABA. With a cap of one, A is acked back to zero, a third send restores
 *      the ledger to the SAME number via a DIFFERENT row, and a refusal-path
 *      reconcile — conditioning its downward reset on the numeric VALUE alone —
 *      writes the stale zero over the live count, admitting a second sender
 *      under a cap of one. The fix versions every mutation and conditions the
 *      reset on an unchanged version; the schedule below is the race itself,
 *      driven by real concurrent operations interleaved at real command
 *      boundaries.
 *
 *  (b) Expired ACK. A refusal-path recount EXCLUDES a TTL-lagged expired row,
 *      so the ledger no longer counts it — but a delayed ack of that same,
 *      unreaped physical row would decrement the already-corrected ledger
 *      AGAIN, taking it below the truth. The fix projects `expiresAt` on the
 *      ack and deletes an expired row WITHOUT decrementing.
 */

const ulid = monotonicFactory();

function makeMsg(
  recipientId: string,
  senderId: string,
  expiresAt: number,
  payload = 'x',
): QueuedMessage {
  return {
    recipientId,
    msgId: ulid(),
    senderId,
    type: 'ciphertext',
    payload,
    ts: Date.now(),
    expiresAt,
  };
}

/** Wrap a real doc so a refused sender's reconcile can be interleaved with real
 * concurrent operations at exact command boundaries. The hooks await REAL
 * side-operations (against the same DynamoDB Local, over separate clients), so
 * the adversarial schedule is genuine concurrency, not a mock. */
function schedulingDoc(
  realDoc: DynamoDBDocumentClient,
  recipient: string,
  sender: string,
  hooks: { onRecount?: () => Promise<void>; onPairLedgerGet?: () => Promise<void> },
): DynamoDBDocumentClient {
  const pairKey = queuePairLedgerKey(sender);
  const send = async (cmd: unknown): Promise<unknown> => {
    if (cmd instanceof QueryCommand) {
      // The only Query enqueue issues is the refusal-path partition recount.
      await hooks.onRecount?.();
    } else if (cmd instanceof GetCommand) {
      const key = (cmd as GetCommand).input?.Key as { recipientId?: string; msgId?: string };
      // The reconcile ledger read — recipient partition, this pair's ledger.
      // (The advisory establishment read is on the SENDER's partition.)
      if (key?.recipientId === recipient && key?.msgId === pairKey) {
        await hooks.onPairLedgerGet?.();
      }
    }
    return realDoc.send(cmd as never);
  };
  return { send } as unknown as DynamoDBDocumentClient;
}

describe('the quota ledger is never reset below the live truth (real DynamoDB)', () => {
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
    for (const recipientId of purgeTargets) await db.purgeQueuedMessages(recipientId);
  });

  it('(a) ABA — a refused sender reconciling while an ack and a re-send interleave cannot break a cap of one', async (ctx) => {
    if (!available) return ctx.skip();
    const recipient = `01RABA${ulid()}`;
    const sender = `01SABA${ulid()}`;
    purgeTargets.push(recipient);

    // A occupies the cap of one.
    const a = makeMsg(recipient, sender, Math.floor(Date.now() / 1000) + 3600);
    await db.enqueueMessage(a);

    // The adversarial schedule for B's refused enqueue:
    //   - at B's recount: ack A, so the recount sees ZERO live rows.
    //   - at B's reconcile ledger read: land a real re-send C, restoring the
    //     ledger to the SAME numeric value via a DIFFERENT row.
    // Under the value-only reset this made the reconcile write a stale zero
    // over C's live count; the version guard refuses it.
    let ackedA = false;
    let sentC = false;
    const cMsg = makeMsg(recipient, sender, Math.floor(Date.now() / 1000) + 3600);
    const bDb = makeDataLayer(
      schedulingDoc(makeDocClient(makeDynamoClient()), recipient, sender, {
        onRecount: async () => {
          if (ackedA) return;
          ackedA = true;
          await db.deleteQueuedMessage(recipient, a.msgId);
        },
        onPairLedgerGet: async () => {
          if (sentC) return;
          sentC = true;
          // C may be refused (if A is still present when this fires, i.e. the
          // fixed Get-before-recount ordering) — that refusal is itself part
          // of the cap holding, so swallow only the quota error.
          try {
            await db.enqueueMessage(cMsg);
          } catch (err) {
            if (!(err instanceof QueuedQuotaExceededError)) throw err;
          }
        },
      }),
      QUOTA,
    );

    // B's enqueue drives the refusal → reconcile → retry path being attacked.
    const b = makeMsg(recipient, sender, Math.floor(Date.now() / 1000) + 3600);
    let bOutcome: 'resolved' | 'quota' | unknown = 'resolved';
    try {
      await bDb.enqueueMessage(b);
    } catch (err) {
      bOutcome = err instanceof QueuedQuotaExceededError ? 'quota' : err;
    }
    expect(typeof bOutcome === 'string' || bOutcome === 'quota').toBe(true);

    // THE INVARIANT: a cap of one admits at most one live row, however the ack,
    // the re-send and the reconcile interleaved. The ABA left TWO.
    const live = await allQueued(db, recipient);
    expect(live.length).toBeLessThanOrEqual(1);

    // And the ledger agrees with the live count — a reset below the truth would
    // leave the ledger under the rows it is supposed to be counting.
    const ledger = await doc.send(
      new GetCommand({
        TableName: TABLES.messages,
        Key: { recipientId: recipient, msgId: queuePairLedgerKey(sender) },
      }),
    );
    const qItems = typeof ledger.Item?.qItems === 'number' ? ledger.Item.qItems : 0;
    expect(qItems).toBe(live.length);
  });

  it('(b) expired ACK — a delayed ack of a TTL-lagged row the recount excluded does not double-release', async (ctx) => {
    if (!available) return ctx.skip();
    const recipient = `01REXP${ulid()}`;
    const sender = `01SEXP${ulid()}`;
    purgeTargets.push(recipient);
    const nowSec = Math.floor(Date.now() / 1000);

    // E is already expired at enqueue (TTL deletion is eventual — DynamoDB
    // Local leaves the physical row). It still counts in the ledger.
    const e = makeMsg(recipient, sender, nowSec - 1);
    await db.enqueueMessage(e);

    // F's enqueue is refused by the cap of one, which SCHEDULES the
    // out-of-band recount (the heal no longer runs in-request).
    // The recount filters `expiresAt > now`, EXCLUDING E, so its completed
    // reset lowers the ledger to zero; F's resend is then admitted — the
    // ledger now counts F, and no longer counts the still-present physical
    // row E.
    const f = makeMsg(recipient, sender, nowSec + 3600);
    await expect(db.enqueueMessage(f)).rejects.toBeInstanceOf(QueuedQuotaExceededError);
    await expect
      .poll(
        async () => {
          const ledger = await doc.send(
            new GetCommand({
              TableName: TABLES.messages,
              Key: { recipientId: recipient, msgId: queuePairLedgerKey(sender) },
            }),
          );
          return ledger.Item?.qItems;
        },
        { timeout: 10_000, interval: 25 },
      )
      .toBe(0);
    await expect(db.enqueueMessage(f)).resolves.toEqual({ inserted: true });
    expect((await allQueued(db, recipient)).some((m) => m.msgId === e.msgId)).toBe(true); // E unreaped
    const afterF = await doc.send(
      new GetCommand({
        TableName: TABLES.messages,
        Key: { recipientId: recipient, msgId: queuePairLedgerKey(sender) },
      }),
    );
    expect(afterF.Item?.qItems).toBe(1); // the ledger counts F, not E

    // The delayed ack of E arrives. Decrementing for it would take the ledger
    // to zero while F is live — a defeated cap. The fix deletes the expired
    // physical row WITHOUT touching the ledger.
    await db.deleteQueuedMessage(recipient, e.msgId);
    const afterAck = await doc.send(
      new GetCommand({
        TableName: TABLES.messages,
        Key: { recipientId: recipient, msgId: queuePairLedgerKey(sender) },
      }),
    );
    expect(afterAck.Item?.qItems).toBe(1); // still 1 (F) — not double-released to 0

    // The cap therefore still holds: F occupies it, so a new send is refused.
    await expect(
      db.enqueueMessage(makeMsg(recipient, sender, nowSec + 3600)),
    ).rejects.toBeInstanceOf(QueuedQuotaExceededError);
  });
});
