import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { monotonicFactory } from 'ulid';
import { ListTablesCommand } from '@aws-sdk/client-dynamodb';
import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
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
import { allQueued, makeMemoryDb } from './helpers.js';

/**
 * The ledger races the reap/reconcile machinery itself induced.
 *
 *  - qVer restarts at 1 for every INCARNATION of a ledger row, so a
 *               reconciler's stale reset can cross a delete/recreate boundary
 *               (the zero-ledger reap, or TTL) and land on a NEW
 *               incarnation that merely accumulated the same version number.
 *  - an ACK that decided "live, decrement" just before the expiry
 *               boundary can commit its decrement AFTER a reconcile already
 *               excluded that row and re-admitted another — nothing bound the
 *               transaction to the ledger state the decision was made against.
 *  - msgId is SENDER-CONTROLLED, so a stale duplicate ack whose
 *               delete is conditioned on mere existence can delete a DIFFERENT
 *               sender's replacement row while decrementing the original
 *               sender's ledger.
 *  - every enqueue blindly assigned the ledger clocks, so a
 *               reversed commit order moved expiry BACKWARD in the store while
 *               the memory twin took Math.max — the twin masked the bug.
 *
 * All against the REAL store (DynamoDB Local): every one of these lives in
 * command-boundary interleavings and TTL/recreation lifecycles the memory twin
 * does not model. The schedules interleave REAL operations over separate
 * clients at exact command boundaries — genuine concurrency, not mocks.
 */

const ulid = monotonicFactory();
const STRANGER_LEDGER_KEY = '#quota-strangers';

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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Wrap a real doc so the operation under test can be interleaved with real
 * concurrent operations at exact command boundaries (the queue.quota.races
 * idiom, extended to the round-3 boundaries: the reconcile's conditional
 * RESET write, and the ack's release transaction). */
function schedulingDoc(
  realDoc: DynamoDBDocumentClient,
  hooks: {
    /** Before the refusal-path partition recount (the only Query enqueue runs). */
    onRecount?: () => Promise<void>;
    /** Before the reconcile's conditional reset lands on this ledger key. */
    onLedgerReset?: { key: { recipientId: string; msgId: string }; run: () => Promise<void> };
    /** Before an ack's release transaction containing a Delete of this row. */
    onAckTransact?: { key: { recipientId: string; msgId: string }; run: () => Promise<void> };
  },
): DynamoDBDocumentClient {
  let recounted = false;
  let reset = false;
  let acked = false;
  const send = async (cmd: unknown): Promise<unknown> => {
    if (cmd instanceof QueryCommand && hooks.onRecount && !recounted) {
      recounted = true;
      await hooks.onRecount();
    } else if (cmd instanceof UpdateCommand && hooks.onLedgerReset && !reset) {
      const { Key, ExpressionAttributeValues } = (cmd as UpdateCommand).input;
      if (
        Key?.recipientId === hooks.onLedgerReset.key.recipientId &&
        Key?.msgId === hooks.onLedgerReset.key.msgId &&
        ExpressionAttributeValues !== undefined &&
        ':ti' in ExpressionAttributeValues // the reset's truth value — only the reconcile carries it
      ) {
        reset = true;
        await hooks.onLedgerReset.run();
      }
    } else if (cmd instanceof TransactWriteCommand && hooks.onAckTransact && !acked) {
      const items = (cmd as TransactWriteCommand).input.TransactItems ?? [];
      const hit = items.some(
        (i) =>
          i.Delete?.Key?.recipientId === hooks.onAckTransact!.key.recipientId &&
          i.Delete?.Key?.msgId === hooks.onAckTransact!.key.msgId,
      );
      if (hit) {
        acked = true;
        await hooks.onAckTransact.run();
      }
    }
    return realDoc.send(cmd as never);
  };
  return { send } as unknown as DynamoDBDocumentClient;
}

describe('ledger incarnations, ack bindings and clock monotonicity (real DynamoDB)', () => {
  let available = false;
  let doc: ReturnType<typeof makeDocClient>;
  const purge: Array<{ db: DataLayer; recipientId: string }> = [];

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
    for (const { db, recipientId } of purge) await db.purgeQueuedMessages(recipientId);
  });

  it(
    'a reconcile reset cannot cross a reap/recreate boundary onto a new ledger incarnation',
    { timeout: 20_000 },
    async (ctx) => {
      if (!available) return ctx.skip();
      const recipient = `01RINC${ulid()}`;
      const sender = `01SINC${ulid()}`;
      const QUOTA: QueueQuota = { items: 1, bytes: 1_000_000 };
      const db = makeDataLayer(doc, QUOTA);
      purge.push({ db, recipientId: recipient });
      const nowSec = Math.floor(Date.now() / 1000);

      // AUTOMATIC (non-establishing) traffic throughout, so the pair ledger is
      // reapable at zero (the delete requires no qEstab).
      const auto = { establishesCorrespondence: false } as const;

      // L occupies the cap of one — incarnation 1 of the ledger, qVer 1.
      const L = makeMsg(recipient, sender, nowSec + 3600);
      await db.enqueueMessage(L, auto);

      // M2's refused enqueue drives the reconcile under attack. The schedule:
      //   - at its recount: ack L. The release decrements the ledger to zero
      //     and the reap DELETES the empty unestablished row — so the
      //     recount sees zero AND the incarnation the reconciler read no longer
      //     exists.
      //   - at its conditional reset: a real re-send M' RECREATES the ledger —
      //     incarnation 2, one mutation, hence the SAME qVer the reconciler
      //     captured from incarnation 1.
      // A reset guarded on qVer alone cannot tell the incarnations apart: it
      // lands, zeroes incarnation 2 underneath its live row, and M2's retry is
      // admitted — two live rows under a cap of one.
      const mPrime = makeMsg(recipient, sender, nowSec + 3600);
      const m2Db = makeDataLayer(
        schedulingDoc(makeDocClient(makeDynamoClient()), {
          onRecount: async () => {
            await db.deleteQueuedMessage(recipient, L.msgId);
          },
          onLedgerReset: {
            key: { recipientId: recipient, msgId: queuePairLedgerKey(sender) },
            run: async () => {
              await db.enqueueMessage(mPrime, auto);
            },
          },
        }),
        QUOTA,
      );

      const m2 = makeMsg(recipient, sender, nowSec + 3600);
      try {
        await m2Db.enqueueMessage(m2, auto);
      } catch (err) {
        if (!(err instanceof QueuedQuotaExceededError)) throw err;
      }

      // THE INVARIANT: however the ack, the reap, the recreation and the reset
      // interleaved, a cap of one admits at most one live row…
      const live = await allQueued(db, recipient);
      expect(live.length).toBeLessThanOrEqual(1);

      // …and the surviving incarnation still counts its own rows.
      const ledger = await doc.send(
        new GetCommand({
          TableName: TABLES.messages,
          Key: { recipientId: recipient, msgId: queuePairLedgerKey(sender) },
        }),
      );
      const qItems = typeof ledger.Item?.qItems === 'number' ? ledger.Item.qItems : 0;
      expect(qItems).toBe(live.length);
    },
  );

  it(
    'an ack that decided "live" just before the expiry boundary cannot decrement a ledger a reconcile has since rebuilt',
    { timeout: 20_000 },
    async (ctx) => {
      if (!available) return ctx.skip();
      const recipient = `01RTOC${ulid()}`;
      const sender = `01STOC${ulid()}`;
      const QUOTA: QueueQuota = { items: 1, bytes: 1_000_000 };
      const db = makeDataLayer(doc, QUOTA);
      purge.push({ db, recipientId: recipient });

      // A expires 2 s from now: live when the ack reads it, expired by the
      // time the ack's transaction is allowed to land.
      const A = makeMsg(recipient, sender, Math.floor(Date.now() / 1000) + 2);
      await db.enqueueMessage(A);

      // The delayed ack: it reads A (still live), decides to decrement, and
      // its release transaction is then held at the command boundary while
      //   - the wall clock crosses A's expiry, and
      //   - B's refused enqueue SCHEDULES the reconcile (the
      //     heal is out of band now, never in-request): the recount EXCLUDES
      //     the now-expired A, its completed reset lowers the ledger, and
      //     B's resend is admitted — the ledger now counts B alone.
      // The resumed transaction then deletes A and decrements the ledger that
      // no longer counts it, unless the release is bound to the ledger state
      // its decision was made against.
      const B = makeMsg(recipient, sender, Math.floor(Date.now() / 1000) + 3600);
      const ackDb = makeDataLayer(
        schedulingDoc(makeDocClient(makeDynamoClient()), {
          onAckTransact: {
            key: { recipientId: recipient, msgId: A.msgId },
            run: async () => {
              await sleep(2_500); // A crosses its expiry for real
              B.ts = Date.now(); // B's enqueue evaluates expiry at ITS OWN now
              // First attempt: refused (the ledger still counts expired A)
              // and the reconcile is scheduled by the refusal.
              await expect(db.enqueueMessage(B)).rejects.toBeInstanceOf(
                QueuedQuotaExceededError,
              );
              // Await the reconcile's completed reset (recount excluded A).
              await expect
                .poll(
                  async () => {
                    const l = await doc.send(
                      new GetCommand({
                        TableName: TABLES.messages,
                        Key: { recipientId: recipient, msgId: queuePairLedgerKey(sender) },
                      }),
                    );
                    return l.Item?.qItems;
                  },
                  { timeout: 10_000, interval: 25 },
                )
                .toBe(0);
              // Never refuses forever: the healed ledger admits B.
              await expect(db.enqueueMessage(B)).resolves.toEqual({ inserted: true });
            },
          },
        }),
        QUOTA,
      );
      await ackDb.deleteQueuedMessage(recipient, A.msgId);

      // THE INVARIANT: the ledger still counts B — the stale decrement either
      // never landed or was refused and re-decided as the expired-row delete.
      const ledger = await doc.send(
        new GetCommand({
          TableName: TABLES.messages,
          Key: { recipientId: recipient, msgId: queuePairLedgerKey(sender) },
        }),
      );
      expect(ledger.Item?.qItems).toBe(1);

      // And the cap of one therefore still holds against a new send.
      await expect(
        db.enqueueMessage(makeMsg(recipient, sender, Math.floor(Date.now() / 1000) + 3600)),
      ).rejects.toBeInstanceOf(QueuedQuotaExceededError);
    },
  );

  it(
    'a stale duplicate ack cannot delete a different sender\'s replacement row at a reused msgId',
    { timeout: 20_000 },
    async (ctx) => {
      if (!available) return ctx.skip();
      const recipient = `01RIDA${ulid()}`;
      const senderA = `01SIDA${ulid()}`;
      const senderB = `01SIDB${ulid()}`;
      const QUOTA: QueueQuota = { items: 4, bytes: 1_000_000 };
      const db = makeDataLayer(doc, QUOTA);
      purge.push({ db, recipientId: recipient });
      purge.push({ db, recipientId: senderA });
      const nowSec = Math.floor(Date.now() / 1000);

      // The recipient has user-authored to A, so A is ESTABLISHED: A's pair
      // ledger carries qEstab and survives the zero-count reap — exactly the
      // ledger the stale ack can push NEGATIVE.
      await db.enqueueMessage(makeMsg(senderA, recipient, nowSec + 3600));

      // A queues X at a sender-chosen msgId.
      const X = makeMsg(recipient, senderA, nowSec + 3600, 'from-A');
      await db.enqueueMessage(X);

      // Two duplicate acks of X race (clients deliberately re-ack redelivered
      // ids). The SECOND is held at its release transaction while
      //   - the first ack wins: X deleted, A's ledger decremented to zero, and
      //   - colluding B queues a REPLACEMENT at the same sender-chosen msgId.
      // An existence-only delete then destroys B's row while decrementing A's
      // ledger again: B's message lost, B still charged, A's ledger negative.
      const replacement: QueuedMessage = {
        ...makeMsg(recipient, senderB, nowSec + 3600, 'from-B'),
        msgId: X.msgId,
      };
      const staleAckDb = makeDataLayer(
        schedulingDoc(makeDocClient(makeDynamoClient()), {
          onAckTransact: {
            key: { recipientId: recipient, msgId: X.msgId },
            run: async () => {
              await db.deleteQueuedMessage(recipient, X.msgId); // the first ack wins
              await db.enqueueMessage(replacement); // B reuses the freed msgId
            },
          },
        }),
        QUOTA,
      );
      await staleAckDb.deleteQueuedMessage(recipient, X.msgId);

      // THE INVARIANT: B's replacement row survives the stale ack…
      const live = await allQueued(db, recipient);
      const survivor = live.find((m) => m.msgId === X.msgId);
      expect(survivor?.senderId).toBe(senderB);
      expect(survivor?.payload).toBe('from-B');

      // …and A's established ledger was released exactly once, never negative.
      const ledger = await doc.send(
        new GetCommand({
          TableName: TABLES.messages,
          Key: { recipientId: recipient, msgId: queuePairLedgerKey(senderA) },
        }),
      );
      expect(ledger.Item?.qItems).toBe(0);
    },
  );

  it(
    'a reversed commit order cannot move the ledger clocks backward (store and memory twin agree)',
    { timeout: 20_000 },
    async (ctx) => {
      if (!available) return ctx.skip();
      const recipient = `01RREV${ulid()}`;
      const sender = `01SREV${ulid()}`;
      const QUOTA: QueueQuota = { items: 10, bytes: 1_000_000 };
      const db = makeDataLayer(doc, QUOTA);
      const twin = makeMemoryDb(QUOTA);
      purge.push({ db, recipientId: recipient });
      const nowSec = Math.floor(Date.now() / 1000);

      // The NEWER user-authored send (fresh expiry) commits FIRST; an OLDER
      // in-flight automatic carrier (its expiry already in the past) commits
      // SECOND. Under last-committer-wins both the pair clock and the stranger
      // clock move BACKWARD: at a time the establishment is plainly live, the
      // ledger row reads expired, correspondence reports false, and the
      // legitimate caller is charged to the exhausted stranger ring bucket.
      const newer = makeMsg(recipient, sender, nowSec + 3600, 'user-authored');
      const older: QueuedMessage = {
        ...makeMsg(recipient, sender, nowSec - 10, 'auto-carrier'),
        ts: (nowSec - 10) * 1000,
      };
      for (const layer of [db, twin]) {
        await layer.enqueueMessage(newer, { establishesCorrespondence: true });
        await layer.enqueueMessage(older, { establishesCorrespondence: false });
      }

      // THE INVARIANT, on BOTH stores: the establishment minted by the newer
      // send is still live — the older commit cannot regress either clock. The
      // memory twin already took Math.max here while the store took
      // last-committer-wins; that divergence let every twin-backed test pass
      // over the store's regression, so the twins must now AGREE.
      const storeAnswer = await db.hasQueuedCorrespondence(sender, recipient, nowSec + 60);
      const twinAnswer = await twin.hasQueuedCorrespondence(sender, recipient, nowSec + 60);
      expect(storeAnswer).toBe(twinAnswer);
      expect(storeAnswer).toBe(true);

      // And the raw clocks pin the max, not the last commit: the pair ledger's
      // general expiry, its establishment expiry, and the stranger aggregate's
      // expiry all kept the newer instant.
      const pair = await doc.send(
        new GetCommand({
          TableName: TABLES.messages,
          Key: { recipientId: recipient, msgId: queuePairLedgerKey(sender) },
        }),
      );
      expect(pair.Item?.expiresAt).toBe(newer.expiresAt);
      expect(pair.Item?.qEstabExpiresAt).toBe(newer.expiresAt);
      const stranger = await doc.send(
        new GetCommand({
          TableName: TABLES.messages,
          Key: { recipientId: recipient, msgId: STRANGER_LEDGER_KEY },
        }),
      );
      expect(stranger.Item?.expiresAt).toBe(newer.expiresAt);
    },
  );
});
