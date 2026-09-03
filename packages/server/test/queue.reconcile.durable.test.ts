import { describe, expect, it, vi } from 'vitest';
import {
  DeleteCommand,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import {
  makeDataLayer,
  QueuedQuotaExceededError,
  RECONCILE_DEBOUNCE_MAX_KEYS,
  RECONCILE_LEASE_MS,
  type LedgerReconcileRequest,
} from '../src/db/data.js';

/**
 * Quota repair must be DURABLE under Lambda.
 *
 * The refusal path used to schedule the ledger reconcile as an UNAWAITED
 * promise on the same event loop. Under Lambda the execution environment can
 * FREEZE the moment the response returns: the floating promise may resume on a
 * later invocation, in a different container, or never. A ledger drifted HIGH
 * (TTL-reaped rows the ledger still counts) then never heals, and legitimate
 * senders stay refused indefinitely.
 *
 * The harness cannot literally freeze the event loop, so the property is
 * asserted the closest honest way: the DURABLE handoff (the host-provided
 * `scheduleReconcile` hook — under AWS a Lambda async Event invoke, whose
 * internal queue survives the container) must have been issued AND awaited
 * BEFORE `enqueueMessage` settles. Everything after settle is a freeze under
 * Lambda semantics, so nothing that happens after settle may count.
 *
 * The refusal itself must stay a fast 429: the sender never waits on (or
 * fails on) the repair — only on the one queueing call that makes it durable.
 */

const LEDGER_QUOTA = { items: 1, bytes: 1_000_000 };
const MSG_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'; // a real ULID (not a ledger key)

/** A recording doc stub, same shape as queue.consistency.test.ts. */
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

/** Scripts a pair-ledger admission failure: every enqueue is refused. */
function refusingDoc(): { commands: unknown[]; doc: DynamoDBDocumentClient } {
  return recordingDoc((cmd) => {
    if (cmd instanceof GetCommand) return {}; // unknown sender classification
    if (cmd instanceof TransactWriteCommand) {
      throw Object.assign(new Error('cancelled'), {
        name: 'TransactionCanceledException',
        CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, {}, {}],
      });
    }
    if (cmd instanceof QueryCommand) return { Items: [], Count: 0 };
    if (cmd instanceof UpdateCommand) return { Attributes: { qItems: 5, qBytes: 500 } };
    return {};
  });
}

const msg = {
  recipientId: 'R',
  msgId: MSG_ID,
  senderId: 'S',
  type: 'ciphertext',
  payload: 'QUJD',
  ts: 1_000_000_000_000,
  expiresAt: 4_000_000_000,
} as const;

/** Give any floating (event-loop-scheduled) work a chance to run, so the
 * assertions below can prove the repair did NOT ride on it. */
async function flushEventLoop(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe('quota repair is durable: the handoff completes BEFORE the refusal settles', () => {
  it('awaits the host scheduleReconcile hook before rejecting, and runs no in-process slice', async () => {
    const { commands, doc } = refusingDoc();
    const scheduled: LedgerReconcileRequest[] = [];
    // The hook resolves only on a LATER macrotask: if the refusal did not
    // genuinely await it, the settle-order assertion below fails.
    let hookSettled = false;
    const hook = vi.fn(async (req: LedgerReconcileRequest): Promise<void> => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      hookSettled = true;
      scheduled.push(req);
    });
    const db = makeDataLayer(doc, LEDGER_QUOTA, { scheduleReconcile: hook });

    await expect(db.enqueueMessage(msg)).rejects.toBeInstanceOf(QueuedQuotaExceededError);

    // The durable handoff had SETTLED by the time the refusal did. Under
    // Lambda, anything scheduled but not yet settled at this point can freeze
    // with the container and never happen.
    expect(hookSettled).toBe(true);
    expect(scheduled).toEqual([{ recipientId: 'R', target: { kind: 'pair', senderId: 'S' } }]);

    // And the repair is the WORKER's job now: no in-process slice may run in
    // this host — not even after the response, where Lambda would freeze it.
    await flushEventLoop();
    const leaseWrites = commands.filter(
      (c) =>
        c instanceof UpdateCommand && (c.input.UpdateExpression ?? '').includes('qReconUntil'),
    );
    expect(leaseWrites).toHaveLength(0);
  });

  it('schedules the STRANGER ledger too when the aggregate refused', async () => {
    const { doc } = recordingDoc((cmd) => {
      if (cmd instanceof GetCommand) return {}; // unknown sender
      if (cmd instanceof TransactWriteCommand) {
        throw Object.assign(new Error('cancelled'), {
          name: 'TransactionCanceledException',
          // Pair passes, stranger aggregate refuses.
          CancellationReasons: [{}, { Code: 'ConditionalCheckFailed' }, {}],
        });
      }
      return {};
    });
    const scheduled: LedgerReconcileRequest[] = [];
    const db = makeDataLayer(doc, LEDGER_QUOTA, {
      scheduleReconcile: async (req) => {
        scheduled.push(req);
      },
    });

    await expect(db.enqueueMessage(msg)).rejects.toBeInstanceOf(QueuedQuotaExceededError);
    expect(scheduled).toEqual([{ recipientId: 'R', target: { kind: 'stranger' } }]);
  });

  it('still refuses with the quota error when the durable handoff itself fails', async () => {
    // The 429 is the sender's answer either way: a broken scheduler leaves the
    // ledger drifted HIGH (over-refusal, healed by a later refusal's schedule),
    // which must never surface as a 500 on the send path.
    const { doc } = refusingDoc();
    const db = makeDataLayer(doc, LEDGER_QUOTA, {
      scheduleReconcile: async () => {
        throw new Error('invoke failed');
      },
    });
    await expect(db.enqueueMessage(msg)).rejects.toBeInstanceOf(QueuedQuotaExceededError);
  });

  it('debounces repeat refusals of the same ledger inside one container', async () => {
    const { doc } = refusingDoc();
    const hook = vi.fn(async (): Promise<void> => {});
    const db = makeDataLayer(doc, LEDGER_QUOTA, { scheduleReconcile: hook });

    await expect(db.enqueueMessage(msg)).rejects.toBeInstanceOf(QueuedQuotaExceededError);
    await expect(db.enqueueMessage(msg)).rejects.toBeInstanceOf(QueuedQuotaExceededError);

    // One durable schedule per ledger per debounce window: N rejected sends
    // must not become N invokes.
    expect(hook).toHaveBeenCalledTimes(1);
  });

  it('the debounce map is BOUNDED: past the cap the oldest entry is evicted, never merely the expired ones', async () => {
    // Nothing expires inside this test (one wall-clock instant), so before
    // the fix the map simply grew past the cap: the prune only removed
    // expired entries and the set ran regardless. Now the 513th distinct
    // ledger evicts the FIRST one, whose next refusal therefore schedules
    // again — while the second, still inside the map, stays debounced.
    const { doc } = refusingDoc();
    const hook = vi.fn(async (): Promise<void> => {});
    const db = makeDataLayer(doc, LEDGER_QUOTA, { scheduleReconcile: hook });
    const at = (i: number) => ({ ...msg, recipientId: `R${i}` });
    for (let i = 0; i <= RECONCILE_DEBOUNCE_MAX_KEYS; i++) {
      await expect(db.enqueueMessage(at(i))).rejects.toBeInstanceOf(QueuedQuotaExceededError);
    }
    expect(hook).toHaveBeenCalledTimes(RECONCILE_DEBOUNCE_MAX_KEYS + 1);
    // R0 was evicted to make room: it schedules again (evicting the next
    // oldest in turn — the map never holds more than the cap).
    await expect(db.enqueueMessage(at(0))).rejects.toBeInstanceOf(QueuedQuotaExceededError);
    expect(hook).toHaveBeenCalledTimes(RECONCILE_DEBOUNCE_MAX_KEYS + 2);
    // The most recent ledger is still inside the window: debounced, and a
    // debounced repeat evicts nothing.
    await expect(
      db.enqueueMessage(at(RECONCILE_DEBOUNCE_MAX_KEYS)),
    ).rejects.toBeInstanceOf(QueuedQuotaExceededError);
    expect(hook).toHaveBeenCalledTimes(RECONCILE_DEBOUNCE_MAX_KEYS + 2);
  });

  it('a failed handoff clears the debounce so the next refusal retries the schedule', async () => {
    const { doc } = refusingDoc();
    let calls = 0;
    const db = makeDataLayer(doc, LEDGER_QUOTA, {
      scheduleReconcile: async () => {
        calls += 1;
        if (calls === 1) throw new Error('throttled');
      },
    });
    await expect(db.enqueueMessage(msg)).rejects.toBeInstanceOf(QueuedQuotaExceededError);
    await expect(db.enqueueMessage(msg)).rejects.toBeInstanceOf(QueuedQuotaExceededError);
    expect(calls).toBe(2);
  });
});

describe('reconcileQueueLedger — the outcome the worker continues on', () => {
  it("reports 'stood_down' when another reconciler holds the lease", async () => {
    const { doc } = recordingDoc((cmd) => {
      if (cmd instanceof UpdateCommand) {
        throw Object.assign(new Error('held'), { name: 'ConditionalCheckFailedException' });
      }
      return {};
    });
    const db = makeDataLayer(doc, LEDGER_QUOTA);
    await expect(db.reconcileQueueLedger('R', { kind: 'pair', senderId: 'S' })).resolves.toBe(
      'stood_down',
    );
  });

  it("reports 'complete' after a full scan resets the drifted ledger", async () => {
    const commands: unknown[] = [];
    const { doc } = recordingDoc((cmd) => {
      commands.push(cmd);
      if (cmd instanceof UpdateCommand) {
        const expr = cmd.input.UpdateExpression ?? '';
        if (expr.includes('qReconUntil = :until')) {
          return { Attributes: { qItems: 5, qBytes: 500, qGen: 'G1', qVer: 7 } };
        }
        return {};
      }
      if (cmd instanceof QueryCommand) return { Items: [], Count: 0 }; // truth: empty
      return {};
    });
    const db = makeDataLayer(doc, LEDGER_QUOTA);
    await expect(db.reconcileQueueLedger('R', { kind: 'stranger' })).resolves.toBe('complete');
    // And the reset actually landed (this is the heal, not a bystander).
    expect(
      commands.some(
        (c) =>
          c instanceof UpdateCommand &&
          (c.input.UpdateExpression ?? '').startsWith('SET qItems = :ti'),
      ),
    ).toBe(true);
  });

  it("reports 'continue' when the page budget exhausts mid-partition, persisting the cursor and never lowering", async () => {
    const updates: UpdateCommand[] = [];
    const { doc } = recordingDoc((cmd) => {
      if (cmd instanceof UpdateCommand) {
        updates.push(cmd);
        const expr = cmd.input.UpdateExpression ?? '';
        if (expr.includes('qReconUntil = :until')) {
          return { Attributes: { qItems: 5, qBytes: 500, qGen: 'G1', qVer: 7 } };
        }
        return {};
      }
      if (cmd instanceof QueryCommand) {
        // Every page reports more remaining: the budget, not the partition,
        // must end the slice.
        return {
          Items: [{ msgBytes: 10 }],
          LastEvaluatedKey: { recipientId: 'R', msgId: '01ARZ3NDEKTSV4RRFFQ69G5FAV' },
        };
      }
      return {};
    });
    const db = makeDataLayer(doc, LEDGER_QUOTA);
    await expect(db.reconcileQueueLedger('R', { kind: 'pair', senderId: 'S' })).resolves.toBe(
      'continue',
    );
    // Invariant 2 — NO ledger count was written from the incomplete scan; the
    // only non-lease writes persist scan state (cursor + partials).
    const loweredLedger = updates.some((c) =>
      (c.input.UpdateExpression ?? '').startsWith('SET qItems = :ti'),
    );
    expect(loweredLedger).toBe(false);
    const persisted = updates.find((c) =>
      (c.input.UpdateExpression ?? '').includes('qReconCursor = :c'),
    );
    expect(persisted).toBeDefined();
    expect(persisted?.input.ExpressionAttributeValues?.[':c']).toBe(
      '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    );
  });
});

/**
 * One clock inside the store. The debounce window, the reconcile lease and
 * the ack-release expiry boundary read `Date.now()` directly while the
 * connection-TTL clamp read the injected `DataLayerHooks.nowMs`, so a test
 * could pin one and not the others. All three ride the store's clock now;
 * these cases drive them with it. */
describe('the store has ONE clock: the injected nowMs drives the debounce, the lease and the expiry boundary', () => {
  const T0 = 1_700_000_000_000;

  it('the durable-handoff debounce expires on the injected clock', async () => {
    const { doc } = refusingDoc();
    let now = T0;
    const hook = vi.fn(async (): Promise<void> => {});
    const db = makeDataLayer(doc, LEDGER_QUOTA, { scheduleReconcile: hook, nowMs: () => now });
    await expect(db.enqueueMessage(msg)).rejects.toBeInstanceOf(QueuedQuotaExceededError);
    now += RECONCILE_LEASE_MS - 1;
    await expect(db.enqueueMessage(msg)).rejects.toBeInstanceOf(QueuedQuotaExceededError);
    expect(hook).toHaveBeenCalledTimes(1); // inside the window: debounced
    now += 1;
    await expect(db.enqueueMessage(msg)).rejects.toBeInstanceOf(QueuedQuotaExceededError);
    expect(hook).toHaveBeenCalledTimes(2); // the window elapsed on the store's clock
  });

  it('the reconcile lease is taken and bounded on the injected clock', async () => {
    const leases: UpdateCommand[] = [];
    const { doc } = recordingDoc((cmd) => {
      if (cmd instanceof UpdateCommand) {
        if ((cmd.input.UpdateExpression ?? '').includes('qReconUntil = :until')) {
          leases.push(cmd);
          return { Attributes: { qItems: 5, qBytes: 500, qGen: 'G1', qVer: 7 } };
        }
        return {};
      }
      if (cmd instanceof QueryCommand) return { Items: [], Count: 0 };
      return {};
    });
    const db = makeDataLayer(doc, LEDGER_QUOTA, { nowMs: () => T0 });
    await db.reconcileQueueLedger('R', { kind: 'stranger' });
    expect(leases).toHaveLength(1);
    expect(leases[0]!.input.ExpressionAttributeValues?.[':nowMs']).toBe(T0);
    expect(leases[0]!.input.ExpressionAttributeValues?.[':until']).toBe(T0 + RECONCILE_LEASE_MS);
  });

  it('the recount page budget is measured on the injected clock, so a slice under a pinned past clock still pages', async () => {
    // The deadline is minted from the store's clock (nowMs + RECONCILE_SLICE_MS);
    // a loop guard reading the WALL clock instead would already be past a
    // deadline pinned in 2023 and the slice would count nothing — no Query at
    // all — while reporting a recount it never made.
    const queries: QueryCommand[] = [];
    const { doc } = recordingDoc((cmd) => {
      if (cmd instanceof UpdateCommand) {
        if ((cmd.input.UpdateExpression ?? '').includes('qReconUntil = :until')) {
          return { Attributes: { qItems: 5, qBytes: 500, qGen: 'G1', qVer: 7 } };
        }
        return {};
      }
      if (cmd instanceof QueryCommand) {
        queries.push(cmd);
        return { Items: [], Count: 0 };
      }
      return {};
    });
    const db = makeDataLayer(doc, LEDGER_QUOTA, { nowMs: () => T0 });
    await db.reconcileQueueLedger('R', { kind: 'stranger' });
    expect(queries).toHaveLength(1);
  });

  it('the ack-release expiry boundary is decided on the injected clock', async () => {
    // A row whose `expiresAt` (unix seconds) is long past on the WALL clock
    // but still live on the store's injected clock: the release must take
    // the live path (a TransactWrite that decrements the ledger), never the
    // expired path (a bare row delete that leaves the ledger alone).
    const { commands, doc } = recordingDoc((cmd) => {
      if (cmd instanceof GetCommand) {
        const key = cmd.input.Key as { msgId: string };
        if (key.msgId === MSG_ID) {
          return { Item: { senderId: 'S', msgBytes: 10, expiresAt: 1_000, qNonce: 'n' } };
        }
        return { Item: { qItems: 1, qBytes: 10, qGen: 'G1', qVer: 1 } };
      }
      return {};
    });
    const db = makeDataLayer(doc, LEDGER_QUOTA, { nowMs: () => 500 * 1000 });
    await db.deleteQueuedMessage('R', MSG_ID);
    expect(commands.some((c) => c instanceof TransactWriteCommand)).toBe(true);
    // No bare delete of the MESSAGE row (the expired path's shape). The
    // conditional reap of an empty pair ledger that follows the live path
    // is a DeleteCommand too, keyed by the ledger row — not this one.
    const bareRowDelete = commands.some(
      (c) =>
        c instanceof DeleteCommand && (c.input.Key as { msgId?: string }).msgId === MSG_ID,
    );
    expect(bareRowDelete).toBe(false);
  });
});
