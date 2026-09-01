import { describe, expect, it, vi } from 'vitest';
import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { makeDataLayer, QueuedQuotaExceededError } from '../src/db/data.js';

/**
 * #6 / #11 — the quota bookkeeping's reconciliation and release reads must be
 * STRONGLY CONSISTENT.
 *
 * These defects live in DynamoDB's eventual consistency, which DynamoDB Local
 * does not simulate — an integration test cannot reproduce the stale read.
 * They are asserted the same way the ticket-role round-trip is (see
 * wsticket.datalayer.test.ts): on the SDK commands themselves, through a
 * recording stub, so the property holds regardless of the store's replica lag.
 *
 * #6 — refusal-path reconciliation recounts the partition and can reset the
 * ledger DOWNWARD. If either the ledger read or the recount is served from a
 * stale replica, the reset lands BELOW the truth (a committed row unseen), and
 * a second sender slips under a cap of one. Both reads must be consistent.
 *
 * #11 — ack release reads the row's billing facts before decrementing. An
 * eventually-consistent read of a row that was written moments ago (an
 * immediate ack after a live delivery) returns ABSENT, so the release is
 * skipped and the row + quota stay charged until reconnect or TTL. The read
 * must be consistent.
 */

const LEDGER_QUOTA = { items: 1, bytes: 1_000_000 };
const MSG_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'; // a real ULID (not a ledger key)

/** A recording doc stub: every command is captured; a `reply` fn scripts the
 * response by command instance and call ordinal. */
function recordingDoc(reply: (cmd: unknown, index: number) => unknown): {
  commands: unknown[];
  doc: DynamoDBDocumentClient;
} {
  const commands: unknown[] = [];
  const send = async (cmd: unknown): Promise<unknown> => {
    const out = reply(cmd, commands.length);
    commands.push(cmd);
    return out;
  };
  return { commands, doc: { send } as unknown as DynamoDBDocumentClient };
}

describe('#11 — ack release reads the row strongly consistently', () => {
  it('deleteQueuedMessage reads the billing row with ConsistentRead', async () => {
    const { commands, doc } = recordingDoc((cmd) => {
      if (cmd instanceof GetCommand) {
        return { Item: { senderId: 'S', msgBytes: 3, qUnknown: false, expiresAt: 4_000_000_000 } };
      }
      return {}; // TransactWrite / Delete
    });
    const db = makeDataLayer(doc, LEDGER_QUOTA);

    await db.deleteQueuedMessage('R', MSG_ID);

    const get = commands.find((c) => c instanceof GetCommand) as GetCommand | undefined;
    expect(get).toBeDefined();
    // An immediate ack after a live delivery must SEE the row it is releasing.
    expect(get?.input.ConsistentRead).toBe(true);
  });
});

describe('#6 — refusal-path reconciliation reads strongly consistently', () => {
  it('the recount Query carries ConsistentRead, the ledger is read via its own conditional write, and the healed resend is admitted', async () => {
    // The reconcile moved OFF the refusal path: the refused send
    // throws immediately and SCHEDULES a leased, budgeted slice. The slice's
    // reads are the subject here:
    //   - the ledger counts come back from the lease's own conditional
    //     UpdateCommand (ReturnValues ALL_NEW) — a write is strongly
    //     consistent by construction, so no stale-replica GetItem can serve
    //     the reconcile a phantom ledger;
    //   - the recount Query must still carry ConsistentRead (the #6 defect:
    //     a stale recount misses a committed row, the reset lands below the
    //     truth, and a second sender slips the cap).
    let transactCount = 0;
    const { commands, doc } = recordingDoc((cmd) => {
      if (cmd instanceof GetCommand) {
        // The only GetItem on this path is the advisory established-
        // classification read (eventual consistency is fine there):
        // unknown sender → established = false.
        return {};
      }
      if (cmd instanceof UpdateCommand) {
        const expr = cmd.input.UpdateExpression ?? '';
        if (expr.includes('qReconUntil = :until')) {
          // The lease acquisition, ALL_NEW: hands the slice the ledger it is
          // bound to — drifted HIGH (5 items) over an empty partition.
          return { Attributes: { qItems: 5, qBytes: 500, qGen: 'G1', qVer: 7 } };
        }
        return {}; // the downward reset, clock bumps
      }
      if (cmd instanceof QueryCommand) {
        return { Items: [], Count: 0 }; // recount sees nothing (the truth here)
      }
      if (cmd instanceof TransactWriteCommand) {
        // First transaction: the pair-ledger admission condition fails, which
        // schedules the reconcile and throws the refusal. The resend after
        // the heal commits. (Counted independently — the throwing call never
        // reaches the recorder's push.)
        transactCount += 1;
        if (transactCount === 1) {
          throw Object.assign(new Error('cancelled'), {
            name: 'TransactionCanceledException',
            CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, {}, {}],
          });
        }
        return {};
      }
      return {};
    });
    const db = makeDataLayer(doc, LEDGER_QUOTA);

    const msg = {
      recipientId: 'R',
      msgId: MSG_ID,
      senderId: 'S',
      type: 'ciphertext',
      payload: 'QUJD',
      ts: 1_000_000_000_000,
      expiresAt: 4_000_000_000,
    } as const;

    // The refusal is IMMEDIATE — no in-request recount (that synchronous scan
    // was the read-amplification DoS the redesign removed).
    await expect(db.enqueueMessage(msg)).rejects.toBeInstanceOf(QueuedQuotaExceededError);

    // Await the scheduled slice deterministically: it is done when the
    // downward reset (`SET qItems = :ti, …`) has been issued.
    const isReset = (c: unknown): boolean =>
      c instanceof UpdateCommand &&
      (c.input.UpdateExpression ?? '').startsWith('SET qItems = :ti');
    await vi.waitFor(() => {
      expect(commands.some(isReset)).toBe(true);
    });

    // #6 — the recount IS the truth the ledger is reset to.
    const recount = commands.find((c) => c instanceof QueryCommand) as QueryCommand | undefined;
    expect(recount).toBeDefined();
    expect(recount?.input.ConsistentRead).toBe(true);

    // The ledger read rides the lease's conditional write (ALL_NEW), not a
    // separate — potentially stale — GetItem: the lease asked for the row
    // back, and no GetItem beyond the advisory classification reads exists.
    const lease = commands.find(
      (c) =>
        c instanceof UpdateCommand &&
        (c.input.UpdateExpression ?? '').includes('qReconUntil = :until'),
    ) as UpdateCommand | undefined;
    expect(lease).toBeDefined();
    expect(lease?.input.ReturnValues).toBe('ALL_NEW');

    // NEVER REFUSES FOREVER: the reconcile completed and reset the drifted
    // ledger, and the resend of the SAME refused message (nothing was stored
    // by the refusal) is now admitted and genuinely inserted.
    await expect(db.enqueueMessage(msg)).resolves.toEqual({ inserted: true });
  });
});
