import { afterAll, beforeAll, describe, expect, it, type TestContext } from 'vitest';
import { monotonicFactory } from 'ulid';
import { ListTablesCommand } from '@aws-sdk/client-dynamodb';
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
 * S2a — the recipient partition is no longer unbounded in the number of
 * ATTACKER-MINTED senders.
 *
 * The per-pair cap bounds one sender; accounts are free to mint, so N
 * Sybil accounts were N full allowances aimed at one victim — the partition
 * grew linearly in the attacker's willingness to register.
 *
 * A per-recipient TOTAL cap is NOT the fix and must never become it: a prior
 * validation established it is an eviction/denial primitive — the attacker
 * fills the victim's global quota and every legitimate sender is refused.
 *
 * The shape here degrades against the marginal sender instead. A sender the
 * recipient has itself written to (any frame — a reply, a read receipt —
 * within the trailing message-TTL window) is ESTABLISHED and keeps the full
 * per-pair allowance, bottomless in aggregate because only the recipient can
 * mint that status. A sender with no such reverse correspondence is UNKNOWN:
 * it gets a tighter per-pair bound and shares a per-recipient ceiling with
 * every other unknown sender, so a Sybil fleet of any size holds ONE small
 * allowance, not N large ones.
 *
 * Refusals are the SAME error either way, deliberately: a distinct
 * "stranger quota" refusal would let any sender probe whether the recipient
 * has ever written to them.
 */

const ulid = monotonicFactory();

/** Small, exhaustible caps driving the same enforcement production runs. */
const QUOTA: Required<QueueQuota> = {
  items: 10,
  bytes: 1_000_000,
  unknownItems: 2,
  unknownBytes: 1_000_000,
  unknownTotalItems: 3,
  unknownTotalBytes: 1_000_000,
};

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

function strangerContract(
  makeDb: () => DataLayer,
  ids: () => { recipient: string; sender: () => string },
  tag: string,
  enabled: () => boolean = () => true,
): void {
  const gated =
    (body: (db: DataLayer, recipient: string, sender: () => string) => Promise<void>) =>
    async (ctx: TestContext) => {
      if (!enabled()) return ctx.skip();
      const { recipient, sender } = ids();
      await body(makeDb(), recipient, sender);
    };

  it(
    `${tag}: a Sybil fleet shares ONE small allowance instead of N per-pair allowances`,
    gated(async (db, recipient, sender) => {
      // Sybil 1: unknown, so its per-pair bound is the tighter unknownItems=2.
      const sybil1 = sender();
      await db.enqueueMessage(makeMsg(recipient, sybil1));
      await db.enqueueMessage(makeMsg(recipient, sybil1));
      await expect(db.enqueueMessage(makeMsg(recipient, sybil1))).rejects.toBeInstanceOf(
        QueuedQuotaExceededError,
      );

      // Sybil 2: a FRESH account — at HEAD this held a fresh full allowance.
      // Now it draws on the same shared unknown-sender ceiling (3), which
      // sybil 1 already holds 2 of: one more item fits, then the fleet is done.
      const sybil2 = sender();
      await db.enqueueMessage(makeMsg(recipient, sybil2));
      await expect(db.enqueueMessage(makeMsg(recipient, sybil2))).rejects.toBeInstanceOf(
        QueuedQuotaExceededError,
      );

      // Sybil 3..N: minting more accounts buys nothing at all.
      const sybil3 = sender();
      await expect(db.enqueueMessage(makeMsg(recipient, sybil3))).rejects.toBeInstanceOf(
        QueuedQuotaExceededError,
      );

      expect((await allQueued(db, recipient)).length).toBe(QUOTA.unknownTotalItems);
    }),
  );

  it(
    `${tag}: an ESTABLISHED sender is untouched by a full stranger ceiling — no eviction primitive`,
    gated(async (db, recipient, sender) => {
      // The recipient has written to `friend` — the only way established
      // status can be minted, and exactly what an attacker cannot forge.
      const friend = sender();
      await db.enqueueMessage(makeMsg(friend, recipient));

      // A Sybil fleet fills the entire unknown-sender ceiling at the victim.
      for (let i = 0; i < QUOTA.unknownTotalItems; i++) {
        await db.enqueueMessage(makeMsg(recipient, sender()));
      }
      await expect(db.enqueueMessage(makeMsg(recipient, sender()))).rejects.toBeInstanceOf(
        QueuedQuotaExceededError,
      );

      // The friend still holds the FULL per-pair allowance: refusing the
      // marginal stranger never refuses the people the recipient actually
      // corresponds with. (This is the exact property the rejected total-cap
      // design violates.)
      for (let i = 0; i < QUOTA.items; i++) {
        // Each is a genuine first-time enqueue: it must not just resolve, it
        // must report that it STORED a row (inserted: true).
        await expect(db.enqueueMessage(makeMsg(recipient, friend))).resolves.toEqual({
          inserted: true,
        });
      }
      await expect(db.enqueueMessage(makeMsg(recipient, friend))).rejects.toBeInstanceOf(
        QueuedQuotaExceededError,
      );
    }),
  );

  it(
    `${tag}: acking a stranger's message releases its share of the ceiling`,
    gated(async (db, recipient, sender) => {
      const queued: QueuedMessage[] = [];
      for (let i = 0; i < QUOTA.unknownTotalItems; i++) {
        const msg = makeMsg(recipient, sender());
        queued.push(msg);
        await db.enqueueMessage(msg);
      }
      const late = sender();
      await expect(db.enqueueMessage(makeMsg(recipient, late))).rejects.toBeInstanceOf(
        QueuedQuotaExceededError,
      );

      // The recipient drains and acks one — the shared ceiling must free with
      // the row, or the stranger door jams shut permanently.
      const first = queued[0];
      if (!first) throw new Error('fixture');
      await db.deleteQueuedMessage(recipient, first.msgId);
      await expect(db.enqueueMessage(makeMsg(recipient, late))).resolves.toEqual({
        inserted: true,
      });
    }),
  );
}

describe('S2a — memory data layer', () => {
  strangerContract(
    () => makeMemoryDb(QUOTA),
    () => {
      const recipient = `r-${ulid()}`;
      return { recipient, sender: () => `s-${ulid()}` };
    },
    'mem',
  );
});

describe('S2a — DynamoDB data layer', () => {
  let available = false;
  let doc: ReturnType<typeof makeDocClient>;
  const purgeTargets: string[] = [];

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
    const db = makeDataLayer(doc, QUOTA);
    for (const recipientId of purgeTargets) {
      await db.purgeQueuedMessages(recipientId);
    }
  });

  strangerContract(
    () => makeDataLayer(doc, QUOTA),
    () => {
      // Established status is minted by the RECIPIENT sending, which writes
      // into the counterpart's partition — track every id for cleanup.
      const recipient = `01RSTR${ulid()}`;
      purgeTargets.push(recipient);
      return {
        recipient,
        sender: () => {
          const s = `01SSTR${ulid()}`;
          purgeTargets.push(s);
          return s;
        },
      };
    },
    'ddb',
    () => available,
  );
});
