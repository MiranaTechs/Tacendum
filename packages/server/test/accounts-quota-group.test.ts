import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ListTablesCommand } from '@aws-sdk/client-dynamodb';
import { GetCommand, PutCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { TABLES } from '@tacendum/shared';
import { makeDocClient, makeDynamoClient } from '../src/db/client.js';
import { TABLES as SERVER_TABLES } from '../src/db/tables.js';
import {
  DEFAULT_QUEUE_QUOTA,
  groupRowKey,
  makeDataLayer,
  queuePairLedgerKey,
  QueuedQuotaExceededError,
  type DataLayer,
  type DeviceClass,
  type GroupQuotaContext,
} from '../src/db/data.js';
import { getPrekeyBundleHandler, uploadKeysHandler } from '../src/handlers/keys.js';
import { deliverAccountsNotice } from '../src/handlers/devices.js';
import { LIMITS, type RateLimiter } from '../src/ratelimit.js';
import { wsDefaultHandler, type WsDeps } from '../src/handlers/ws.js';
import { makeTestDeps, type TestDeps } from './helpers.js';

/**
 * group-aware quotas, against REAL DynamoDB and the REAL
 * quota ledger rows (heavy project; run with TACENDUM_REQUIRE_DDB=1
 * so a skipped run can never read as a pass).
 *
 * The four pinned properties (the WORST case is driven,
 * never the average):
 * 1. Linking a device does NOT reset the pair relationship to stranger: the
 * reply that established it lives in the OLD device's partition, and the
 * group-aware establishment walk still finds it. Asserted with real
 * ledger rows and a control that proves the stranger cap genuinely bites.
 * 2. A 3-device recipient's TOTAL inbound queue budget never EXCEEDS the
 * 1-device budget (never 3×): the recipient-side caps divide by roster
 * size — ⌊cap/N⌋ per member queue, so the aggregate sits at most N−1
 * items UNDER the 1-device budget where the cap does not divide (the
 * flooring deficit asserted at the release constants) —
 * and the admission walk additionally bounds the TOTAL across
 * every billing key the relationship ever used, so neither linking a
 * loaded recipient nor a sender's standalone residue forks a fresh
 * allowance.
 * 3. Three linked senders draw ONE shared `pushmsg` wake budget, not three
 * — and `pushmsg-rcpt` deliberately STAYS per-ULID:
 * each member is its own physical device with its own queue, the bucket
 * protects that one device's attention, and collapsing it would let two
 * siblings' legitimate traffic starve the third's wakes. The aggregate
 * across a 3-device recipient is the cost of three real phones, never an
 * abuse-budget multiplication, because no SENDER-side budget multiplies.
 * 4. A full 3×3 mesh establishment — 9 prekey fetches inside one window —
 * SUCCEEDS under the pinned 12/min group-pair ceiling (release-pinned), the
 * ceiling is REAL (the 13th fetch refuses — the release value asserted
 * itself, no test-config shadow), and the kill switch restores the
 * per-ULID 5/min key.
 *
 * 3-member groups are seeded at the ROW level: the desktop slot is
 * schema-reserved in v1 (occupancy refused at the LINK transaction),
 * so the API can build at most phone+tablet — but the slot exists precisely
 * so activation is a condition-lift, not a migration, which means the quota
 * machinery must already hold at the schema's ≤3 maximum. Seeding the row
 * shape the schema defines is the honest way to drive that worst case today.
 */

const REQUIRE = process.env.TACENDUM_REQUIRE_DDB === '1';

let base: DataLayer;
let db: DataLayer; // flag-overridable view over `base`
let doc: DynamoDBDocumentClient;
let available = false;
let flagOn = false;
let deps: TestDeps;

const RUN = `${Date.now()}`;
let seq = 0;
function uid(): string {
  return `01${`${RUN}${String(++seq).padStart(4, '0')}`.padStart(24, '0')}`;
}
const NOW_S = Math.floor(Date.now() / 1000);
const b64 = (s: string): string => Buffer.from(s).toString('base64');

/** Run-unique canonical 0x05-prefixed identity key (the idkey claim is
 * store-global; reusing one across runs resolves the previous run's user). */
function runIdentityKey(n: number): string {
  const bytes = Buffer.alloc(33);
  bytes[0] = 0x05;
  bytes.write(`q${RUN}:${n}`, 1);
  return bytes.toString('base64');
}

beforeAll(async () => {
  const client = makeDynamoClient();
  doc = makeDocClient(client);
  base = makeDataLayer(doc);
  db = { ...base, isAccountsFeatureEnabled: async () => flagOn };
  try {
    const { TableNames = [] } = await client.send(new ListTablesCommand({}));
    available = TableNames.includes(TABLES.users);
  } catch {
    available = false;
  }
  if (REQUIRE && !available) {
    throw new Error('TACENDUM_REQUIRE_DDB=1 but DynamoDB Local unavailable');
  }
});

beforeEach(() => {
  flagOn = false; // the shipped default, restored before every test
  deps = makeTestDeps(db);
});

function gated(name: string, fn: () => Promise<void>): void {
  it(name, async (ctx) => {
    if (!available) return ctx.skip();
    await fn();
  });
}

async function mkUser(n: number): Promise<string> {
  const userId = uid();
  const res = await base.getOrCreateUserByIdentityKey(runIdentityKey(n), userId, Date.now());
  expect(res.kind).toBe('ok');
  return userId;
}

/** Seed a group at the row level (see the header): the pinned group-row
 * shape plus the `groupId` attr on every member row. */
async function seedGroup(members: Array<{ userId: string; class: DeviceClass }>): Promise<string> {
  const groupId = uid();
  const certs = {
    offerSig: b64(`sig-${groupId}`),
    acceptSig: b64(`sig-${groupId}`),
    groupId,
    offererUserId: members[0]!.userId,
    acceptorUserId: members[1]!.userId,
    class: members[1]!.class,
    rosterEpoch: 0,
    offerNonce: `nonce-${RUN}-${++seq}`,
    expiresAt: NOW_S + 600,
  };
  await doc.send(
    new PutCommand({
      TableName: SERVER_TABLES.users,
      Item: {
        userId: groupRowKey(groupId),
        members: members.map((m) => ({ ...m, linkedAt: Date.now(), certs })),
        identifierRefs: [],
        epoch: members.length - 1,
        createdAt: Date.now(),
      },
    }),
  );
  for (const m of members) {
    await doc.send(
      new UpdateCommand({
        TableName: SERVER_TABLES.users,
        Key: { userId: m.userId },
        UpdateExpression: 'SET groupId = :g',
        ExpressionAttributeValues: { ':g': groupId },
      }),
    );
  }
  return groupId;
}

/** Raw ledger row read — "asserted with the real quota ledger rows". */
async function ledgerRow(
  recipientId: string,
  pairKeyScope: string,
): Promise<{ qItems?: number; qBytes?: number } | undefined> {
  const res = await doc.send(
    new GetCommand({
      TableName: SERVER_TABLES.messages,
      Key: { recipientId, msgId: queuePairLedgerKey(pairKeyScope) },
      ConsistentRead: true,
    }),
  );
  return res.Item as { qItems?: number; qBytes?: number } | undefined;
}

function msg(recipientId: string, senderId: string) {
  return {
    recipientId,
    senderId,
    msgId: uid(),
    type: 'ciphertext' as const,
    payload: 'QUJD',
    ts: Date.now(),
    expiresAt: NOW_S + 3600,
  };
}

/** A rate limiter that RECORDS every take (bucket + capacity) and then
 * delegates to the deterministic real limiter — the budget-sharing facts
 * below are facts about KEYS, and the exhaustion facts are driven for real. */
function recordingLimiter(real: RateLimiter): {
  limiter: RateLimiter;
  taken: Array<{ bucket: string; capacity: number }>;
} {
  const taken: Array<{ bucket: string; capacity: number }> = [];
  return {
    taken,
    limiter: {
      take: async (bucket, opts) => {
        taken.push({ bucket, capacity: opts.capacity });
        return real.take(bucket, opts);
      },
    },
  };
}

describe('linking never resets an established pair to stranger', () => {
  gated('the group-aware walk finds the pre-link reply; a genuine stranger still hits the unknown cap; the collapsed ledger row is real', async () => {
    // Small, exhaustible caps against the REAL store (the injection seam).
    const dbq = makeDataLayer(doc, {
      items: 10,
      bytes: 1024 * 1024,
      unknownItems: 2,
      unknownBytes: 256 * 1024,
      unknownTotalItems: 4,
      unknownTotalBytes: 256 * 1024,
    });
    const a1 = await mkUser(++seq);
    const a2 = await mkUser(++seq);
    const b = await mkUser(++seq);

    // B USER-AUTHORS one message to — the establishment, minted before
    // any link exists, living in the partition under B's bare ULID key.
    await dbq.enqueueMessage(msg(a1, b));

    // links via the REAL link transaction.
    const groupId = uid();
    const offerNonce = `nonce-${RUN}-${++seq}`;
    expect(
      await base.putLinkOffer({
        offerNonce,
        groupId,
        offererUserId: a1,
        acceptorUserId: a2,
        acceptorClass: 'tablet',
        offererClass: 'phone',
        rosterEpoch: 0,
        expiresAt: NOW_S + 600,
        offerSig: b64(`offer-${offerNonce}`),
      }),
    ).toBe('created');
    expect(
      await base.linkDeviceToGroup({
        offerNonce,
        acceptSig: b64(`accept-${offerNonce}`),
        nowSeconds: NOW_S,
        linkedAtMs: Date.now(),
      }),
    ).toBe('linked');

    // The NEW device sends to B under the collapsed keys: 3 messages — past
    // the unknown cap (2) — all admitted, because the walk finds B's reply
    // to the SIBLING and prices as established, not as a stranger.
    const groupCtx: GroupQuotaContext = {
      senderScope: groupId,
      senderMembers: [a2, a1],
      recipientKeys: [b],
      recipientMembers: [b],
      recipientRosterSize: 1,
    };
    for (let i = 0; i < 3; i++) {
      await dbq.enqueueMessage(msg(b, a2), { groupCtx });
    }
    // The real collapsed ledger row: billed under `#quota#<groupId>`.
    expect((await ledgerRow(b, groupId))?.qItems).toBe(3);

    // CONTROL — the naive-implementation failure this suite must catch: a
    // sender with NO establishment (a genuine stranger) is refused at the
    // unknown cap by the very same store and quota. If the caps did not
    // bite, the three sends above would prove nothing.
    const stranger = await mkUser(++seq);
    await dbq.enqueueMessage(msg(b, stranger));
    await dbq.enqueueMessage(msg(b, stranger));
    await expect(dbq.enqueueMessage(msg(b, stranger))).rejects.toThrow(QueuedQuotaExceededError);
  });
});

describe('linking COLLAPSES existing allowances, never forks them', () => {
  gated('two standalone fills against a victim leave NO fresh #quota#<groupId> allowance after linking: the admission walk sums the per-ULID residue', async () => {
    const dbq = makeDataLayer(doc, {
      items: 4,
      bytes: 1024 * 1024,
      unknownItems: 4,
      unknownBytes: 1024 * 1024,
      unknownTotalItems: 40,
      unknownTotalBytes: 1024 * 1024,
    });
    const a1 = await mkUser(++seq);
    const a2 = await mkUser(++seq);
    const v = await mkUser(++seq);

    // Standalone, pre-link: and each queue 2 against V under their bare
    // ULID keys — 4 items of per-ULID residue, a full one-account allowance.
    for (const a of [a1, a2]) {
      await dbq.enqueueMessage(msg(v, a));
      await dbq.enqueueMessage(msg(v, a));
    }
    expect((await ledgerRow(v, a1))?.qItems).toBe(2);
    expect((await ledgerRow(v, a2))?.qItems).toBe(2);

    // They link. The FIRST group-scoped send is refused: the walk counts the
    // per-ULID residue against the ONE-account allowance, so the fresh
    // `#quota#<groupId>` key holds no new capacity — before this fix it held
    // a third full allowance (2×cap standalone + 1×cap group).
    const gid = await seedGroup([
      { userId: a1, class: 'phone' },
      { userId: a2, class: 'tablet' },
    ]);
    const groupCtx: GroupQuotaContext = {
      senderScope: gid,
      senderMembers: [a1, a2],
      recipientKeys: [v],
      recipientMembers: [v],
      recipientRosterSize: 1,
    };
    await expect(dbq.enqueueMessage(msg(v, a1), { groupCtx })).rejects.toThrow(
      QueuedQuotaExceededError,
    );
    expect(await ledgerRow(v, gid)).toBeUndefined();

    // CONTROL — the walk grants exactly the REMAINDER, not zero: a pair with
    // half-spent standalone residue (1+1 of 4) admits 2 group-scoped sends
    // and refuses the 3rd — total across all scope keys stays the 1-account
    // allowance under every billing-key history.
    const c1 = await mkUser(++seq);
    const c2 = await mkUser(++seq);
    const w = await mkUser(++seq);
    await dbq.enqueueMessage(msg(w, c1));
    await dbq.enqueueMessage(msg(w, c2));
    const gid2 = await seedGroup([
      { userId: c1, class: 'phone' },
      { userId: c2, class: 'tablet' },
    ]);
    const ctx2: GroupQuotaContext = {
      senderScope: gid2,
      senderMembers: [c1, c2],
      recipientKeys: [w],
      recipientMembers: [w],
      recipientRosterSize: 1,
    };
    await dbq.enqueueMessage(msg(w, c1), { groupCtx: ctx2 });
    await dbq.enqueueMessage(msg(w, c2), { groupCtx: ctx2 });
    await expect(dbq.enqueueMessage(msg(w, c1), { groupCtx: ctx2 })).rejects.toThrow(
      QueuedQuotaExceededError,
    );
    expect((await ledgerRow(w, gid2))?.qItems).toBe(2);
  });
});

describe('revocation is enforced at COMMIT time, not by the precheck', () => {
  gated('a tombstoned participant is refused by the enqueue transaction itself, with every handler precheck bypassed', async () => {
    const s = await mkUser(++seq);
    const r = await mkUser(++seq);
    const t = await mkUser(++seq);
    // Tombstone T's row directly — the corrupt-state bypass: a direct store
    // enqueue never runs the WS handler's prechecks, so what refuses here is
    // the ConditionCheck inside the TransactWriteItems and nothing else.
    await doc.send(
      new UpdateCommand({
        TableName: SERVER_TABLES.users,
        Key: { userId: t },
        UpdateExpression: 'SET tombstoned = :t',
        ExpressionAttributeValues: { ':t': true },
      }),
    );
    // TO a revoked device: refused at commit.
    await expect(base.enqueueMessage(msg(t, s))).rejects.toMatchObject({
      name: 'QueueParticipantTombstonedError',
      side: 'recipient',
    });
    // FROM a revoked device: refused at commit.
    await expect(base.enqueueMessage(msg(r, t))).rejects.toMatchObject({
      name: 'QueueParticipantTombstonedError',
      side: 'sender',
    });
    // No row and no ledger leaked from either refusal.
    expect(await ledgerRow(t, s)).toBeUndefined();
    expect(await ledgerRow(r, t)).toBeUndefined();
    // `serverMinted` (deliverAccountsNotice's revoke notices, ATTRIBUTED to
    // the revoked member) skips the SENDER side only...
    const minted = await base.enqueueMessage(msg(r, t), {
      establishesCorrespondence: false,
      serverMinted: true,
    });
    expect(minted.inserted).toBe(true);
    // ...and never the recipient side: nothing enqueues to a dead mailbox.
    await expect(
      base.enqueueMessage(msg(t, s), { establishesCorrespondence: false, serverMinted: true }),
    ).rejects.toMatchObject({ name: 'QueueParticipantTombstonedError', side: 'recipient' });
    // Control: the untouched pair still enqueues.
    expect((await base.enqueueMessage(msg(r, s))).inserted).toBe(true);
  });
});

describe('the WS handler itself resolves the collapse (the plumbing is load-bearing)', () => {
  gated('a real ws send bills the collapsed #quota#<groupId> ledger with the flag ON, and the per-ULID key with it deleted — through wsDefaultHandler, never a hand-built context', async () => {
    flagOn = true;
    const a1 = await mkUser(++seq);
    const a2 = await mkUser(++seq);
    const b = await mkUser(++seq);
    const gid = await seedGroup([
      { userId: a1, class: 'phone' },
      { userId: a2, class: 'tablet' },
    ]);
    const wsDeps: WsDeps = {
      ...deps,
      sender: { post: async () => true },
      scheduleDrain: async () => {},
      schedulePush: async () => {},
    };
    const send = async (from: string) =>
      wsDefaultHandler(
        {
          routeKey: '$default' as const,
          connectionId: `conn-${from}`,
          senderUserId: from,
          body: JSON.stringify({
            type: 'send',
            to: b,
            msgId: uid(),
            msgType: 'ciphertext',
            payload: 'QUJD',
          }),
        },
        wsDeps,
      );
    // Flag ON: the handler resolves the group context itself — the row bills
    // under the collapsed group key, never the sender ULID. Omitting or
    // corrupting resolveGroupSendContext in the handler now fails HERE.
    expect((await send(a2)).statusCode).toBe(200);
    expect((await ledgerRow(b, gid))?.qItems).toBe(1);
    expect(await ledgerRow(b, a2)).toBeUndefined();
    // Flag DELETED after enablement (the kill switch): the
    // same send through the same handler restores the per-ULID quota key —
    // group-aware WS billing surviving flag deletion also fails HERE.
    flagOn = false;
    expect((await send(a2)).statusCode).toBe(200);
    expect((await ledgerRow(b, a2))?.qItems).toBe(1);
    expect((await ledgerRow(b, gid))?.qItems).toBe(1);
  });
});

describe('a 3-device recipient’s TOTAL inbound budget never exceeds the 1-device budget', () => {
  gated('one sender against three member queues: 2 rounds of fan-out fill the shared allowance; the third round refuses on every leg; the ⌊cap/3⌋ flooring deficit is stated, not hidden', async () => {
    // An INDIVISIBLE cap on purpose: the earlier
    // conveniently-divisible 6 hid the flooring arithmetic and let the suite
    // claim exact equality that production constants do not deliver. With 7,
    // the honest bound surfaces: the aggregate is 3×⌊7/3⌋ = 6 — NEVER above
    // the 1-device budget, up to N−1 items below it.
    const dbq = makeDataLayer(doc, {
      items: 7,
      bytes: 1024 * 1024,
      unknownItems: 7,
      unknownBytes: 1024 * 1024,
      unknownTotalItems: 30,
      unknownTotalBytes: 1024 * 1024,
    });
    const b1 = await mkUser(++seq);
    const b2 = await mkUser(++seq);
    const b3 = await mkUser(++seq);
    const s = await mkUser(++seq);
    const gid = await seedGroup([
      { userId: b1, class: 'phone' },
      { userId: b2, class: 'tablet' },
      { userId: b3, class: 'desktop' },
    ]);
    const legs = [b1, b2, b3];
    const ctxFor = (): GroupQuotaContext => ({
      senderScope: s,
      senderMembers: [s],
      recipientKeys: [gid, b1, b2, b3],
      recipientMembers: [b1, b2, b3],
      recipientRosterSize: 3,
    });

    // Two full fan-out rounds — 6 legs, ⌊7/3⌋ = 2 per member queue — fill
    // every per-member share of the ONE-device `items` budget (7).
    for (let round = 0; round < 2; round++) {
      for (const leg of legs) {
        await dbq.enqueueMessage(msg(leg, s), { groupCtx: ctxFor() });
      }
    }
    // The third round refuses on EVERY leg: the total is 6, never 21.
    for (const leg of legs) {
      await expect(dbq.enqueueMessage(msg(leg, s), { groupCtx: ctxFor() })).rejects.toThrow(
        QueuedQuotaExceededError,
      );
    }
    // The real ledger rows: one pair ledger per member queue, 2 items each.
    // The aggregate is the HONEST bound: 3×⌊cap/3⌋ — at
    // most the 1-device budget, short of it by up to N−1 items where the cap
    // does not divide. Exactness was never deliverable transactionally (a
    // cross-partition sum cannot be one ConditionExpression) and the suite
    // no longer pretends otherwise.
    let total = 0;
    for (const leg of legs) {
      const row = await ledgerRow(leg, s);
      expect(row?.qItems).toBe(2);
      total += row?.qItems ?? 0;
    }
    expect(total).toBe(3 * Math.floor(7 / 3));
    expect(total).toBeLessThanOrEqual(7);
    // The same arithmetic at the RELEASE constants (never a test-config
    // shadow): a 3-device recipient's aggregate item ceiling is 4,998 of the
    // 5,000 1-device items and 33,554,430 of the 33,554,432 bytes — the
    // ≤N−1 flooring deficit stated as itself.
    expect(3 * Math.floor(DEFAULT_QUEUE_QUOTA.items / 3)).toBe(4998);
    expect(3 * Math.floor(DEFAULT_QUEUE_QUOTA.items / 3)).toBeLessThanOrEqual(
      DEFAULT_QUEUE_QUOTA.items,
    );
    expect(3 * Math.floor(DEFAULT_QUEUE_QUOTA.bytes / 3)).toBe(33554430);
    expect(3 * Math.floor(DEFAULT_QUEUE_QUOTA.bytes / 3)).toBeLessThanOrEqual(
      DEFAULT_QUEUE_QUOTA.bytes,
    );
  });
});

describe('three linked senders share ONE pushmsg wake budget', () => {
  gated('the sender wake bucket keys on the group: one sibling exhausts it for all three, an unrelated sender still wakes, and pushmsg-rcpt stays per-ULID by design', async () => {
    flagOn = true;
    const a1 = await mkUser(++seq);
    const a2 = await mkUser(++seq);
    const a3 = await mkUser(++seq);
    const r = await mkUser(++seq);
    const c = await mkUser(++seq);
    const gid = await seedGroup([
      { userId: a1, class: 'phone' },
      { userId: a2, class: 'tablet' },
      { userId: a3, class: 'desktop' },
    ]);

    const { limiter, taken } = recordingLimiter(deps.rateLimit);
    const scheduled: string[] = [];
    const wsDeps: WsDeps = {
      ...deps,
      rateLimit: limiter,
      sender: { post: async () => true },
      scheduleDrain: async () => {},
      schedulePush: async (recipientId, senderUserId) => {
        scheduled.push(`${senderUserId}->${recipientId}`);
      },
    };
    const send = async (from: string, connectionId: string) =>
      wsDefaultHandler(
        {
          routeKey: '$default' as const,
          connectionId,
          senderUserId: from,
          body: JSON.stringify({
            type: 'send',
            to: r,
            msgId: uid(),
            msgType: 'ciphertext',
            payload: 'QUJD',
          }),
        },
        wsDeps,
      );

    // drains the SHARED budget: every offline message send spends one
    // `pushmsg` token before any later gate, so 30 sends (the pinned
    // LIMITS.pushMessage burst, asserted as the release value itself) empty
    // the group bucket even though the pair bucket suppressed most banners.
    expect(LIMITS.pushMessage.capacity).toBe(30);
    for (let i = 0; i < 30; i++) {
      expect((await send(a1, 'conn-a1')).statusCode).toBe(200);
    }
    const scheduledAfterA1 = scheduled.length;
    expect(scheduledAfterA1).toBeGreaterThan(0);

    // The SIBLINGS find the shared bucket empty: their wakes are suppressed
    // at the SENDER bucket — three linked senders held ONE budget, not three.
    for (const sibling of [a2, a3]) {
      const before = deps.logs.filter((l) => l.event === 'push_suppressed_rate_limited').length;
      expect((await send(sibling, `conn-${sibling}`)).statusCode).toBe(200);
      expect(scheduled.length).toBe(scheduledAfterA1);
      expect(deps.logs.filter((l) => l.event === 'push_suppressed_rate_limited').length).toBe(before + 1);
    }

    // An UNRELATED solo sender still wakes: the exhaustion was the group's
    // shared budget, never the recipient's reachability.
    expect((await send(c, 'conn-c')).statusCode).toBe(200);
    expect(scheduled.length).toBe(scheduledAfterA1 + 1);

    // The key shapes, recorded from the REAL takes — the rationale this
    // suite documents as it asserts:
    // - `pushmsg` keyed by the GROUP for every linked sender (one budget);
    // - `pushmsg-pair` sender side collapsed too (one fair share);
    // - `pushmsg-rcpt` keyed by the DEVICE ULID — per-ULID BY DESIGN: it
    // protects one physical device's attention, and collapsing it would
    // let two siblings' legitimate traffic starve the third's wakes.
    const buckets = taken.map((t) => t.bucket);
    for (const sibling of [a1, a2, a3]) {
      expect(buckets).toContain(`wssend:${sibling}`); // flood control stays per-device
      expect(buckets).not.toContain(`pushmsg:${sibling}`);
    }
    expect(buckets.filter((k) => k === `pushmsg:${gid}`).length).toBe(32);
    expect(buckets).toContain(`pushmsg:${c}`);
    expect(buckets).toContain(`pushmsg-pair:${gid}:${r}`);
    expect(buckets).toContain(`pushmsg-rcpt:${r}`);
    expect(buckets.some((k) => k === `pushmsg-rcpt:${gid}`)).toBe(false);
  });
});

describe('accounts NOTICES draw the SAME collapsed sender wake budget as ws sends', () => {
  gated('deliverAccountsNotice keys pushmsg/pushmsg-pair on the ABOUT member\'s group: a sibling\'s ws sends exhaust the notice wake too, and an unrelated solo about-user still notifies per-ULID', async () => {
    // The notice path is operational on AWS
    // (makeAuthNoticePushSender); charging the individual aboutUserId there
    // gave every linked sibling an independent notice-wake budget BESIDE the
    // one collapsed budget property 3 pins for the ws path — "no sender-side
    // budget multiplies". This drives both paths
    // through ONE shared bucket.
    flagOn = true;
    const a1 = await mkUser(++seq);
    const a2 = await mkUser(++seq);
    const r = await mkUser(++seq); // ws recipient, used to drain the group bucket
    const r2 = await mkUser(++seq); // fresh notice recipient with a push token
    const c = await mkUser(++seq); // unrelated SOLO about-user
    const gid = await seedGroup([
      { userId: a1, class: 'phone' },
      { userId: a2, class: 'tablet' },
    ]);
    await base.putPushToken({
      userId: r2,
      platform: 'ios',
      alertToken: 'a'.repeat(64),
      bundleId: 'com.miranatechnologies.tacendum',
      updatedAt: Date.now(),
      expiresAt: NOW_S + 3600,
    });

    const { limiter, taken } = recordingLimiter(deps.rateLimit);
    const noticeDeps = { ...deps, rateLimit: limiter };
    const wsDeps: WsDeps = {
      ...noticeDeps,
      sender: { post: async () => true },
      scheduleDrain: async () => {},
      schedulePush: async () => {},
    };

    // A first notice about grouped a2 delivers, and its takes show the
    // collapsed keys: `pushmsg:<group>` and `pushmsg-pair:<group>:<r2>`,
    // never a2's ULID.
    const alertsBefore = deps.alertsSent.length;
    await deliverAccountsNotice(noticeDeps, r2, a2, {
      kind: 'memberLinked',
      groupId: gid,
      userId: a2,
      class: 'tablet',
      rosterEpoch: 1,
      identityKeyPub: 'QUJD',
      certs: {
        offerSig: 'QUJD',
        acceptSig: 'QUJD',
        groupId: gid,
        offererUserId: a1,
        acceptorUserId: a2,
        class: 'tablet',
        rosterEpoch: 0,
        offerNonce: 'n',
        expiresAt: NOW_S + 600,
      },
    });
    expect(deps.alertsSent.length).toBe(alertsBefore + 1);

    // Sibling a1's ORDINARY ws sends drain the remainder of the one group
    // `pushmsg` budget (the pinned release burst, asserted as itself)...
    expect(LIMITS.pushMessage.capacity).toBe(30);
    for (let i = 0; i < 29; i++) {
      const res = await wsDefaultHandler(
        {
          routeKey: '$default' as const,
          connectionId: 'conn-a1',
          senderUserId: a1,
          body: JSON.stringify({
            type: 'send',
            to: r,
            msgId: uid(),
            msgType: 'ciphertext',
            payload: 'QUJD',
          }),
        },
        wsDeps,
      );
      expect(res.statusCode).toBe(200);
    }

    // ...and the SECOND notice about sibling a2 finds that same bucket empty:
    // the wake is suppressed (no alert), while the durable enqueue still
    // lands — a lost banner, never a lost notice.
    await deliverAccountsNotice(noticeDeps, r2, a2, {
      kind: 'memberLinked',
      groupId: gid,
      userId: a2,
      class: 'tablet',
      rosterEpoch: 1,
      identityKeyPub: 'QUJD',
      certs: {
        offerSig: 'QUJD',
        acceptSig: 'QUJD',
        groupId: gid,
        offererUserId: a1,
        acceptorUserId: a2,
        class: 'tablet',
        rosterEpoch: 0,
        offerNonce: 'n',
        expiresAt: NOW_S + 600,
      },
    });
    expect(deps.alertsSent.length).toBe(alertsBefore + 1);

    // An unrelated SOLO about-user still notifies through the identical call:
    // the exhaustion was the group's shared budget, keyed per-ULID for the
    // ungrouped exactly as wakeRecipient keys them.
    await deliverAccountsNotice(noticeDeps, r2, c, {
      kind: 'memberUnlinked',
      groupId: gid,
      userId: c,
      class: 'phone',
      rosterEpoch: 1,
      actingUserId: a1,
      subjectIdentityPubKey: 'QUJD',
      offerNonce: 'n',
      expiresAt: NOW_S + 600,
      signedRosterEpoch: 0,
      signature: 'QUJD',
    });
    expect(deps.alertsSent.length).toBe(alertsBefore + 2);
    expect(deps.alertsSent.at(-1)?.userId).toBe(r2);

    // The key shapes, recorded from the REAL takes: the notice path and the
    // ws path drew ONE `pushmsg:<group>` budget (30 ws + 1 notice), no
    // per-ULID sibling bucket was ever touched, and the pair bucket's sender
    // side collapsed too. `pushmsg-rcpt` stays per-ULID by design.
    const buckets = taken.map((t) => t.bucket);
    expect(buckets.filter((k) => k === `pushmsg:${gid}`).length).toBe(31);
    expect(buckets).not.toContain(`pushmsg:${a2}`);
    expect(buckets).not.toContain(`pushmsg-pair:${a2}:${r2}`);
    expect(buckets).toContain(`pushmsg-pair:${gid}:${r2}`);
    expect(buckets).toContain(`pushmsg:${c}`);
    expect(buckets).toContain(`pushmsg-pair:${c}:${r2}`);
    expect(buckets).toContain(`pushmsg-rcpt:${r2}`);
    expect(buckets.some((k) => k === `pushmsg-rcpt:${gid}`)).toBe(false);
  });
});

describe('the 3×3 prekey mesh under the pinned group-pair ceiling', () => {
  gated('9 fetches in one window ALL succeed, retry headroom holds to 12, the 13th refuses — and the kill switch restores the per-ULID 5/min key', async () => {
    flagOn = true;
    const [a1, a2, a3] = [await mkUser(++seq), await mkUser(++seq), await mkUser(++seq)];
    const bs = [await mkUser(++seq), await mkUser(++seq), await mkUser(++seq)];
    await seedGroup([
      { userId: a1, class: 'phone' },
      { userId: a2, class: 'tablet' },
      { userId: a3, class: 'desktop' },
    ]);
    await seedGroup([
      { userId: bs[0]!, class: 'phone' },
      { userId: bs[1]!, class: 'tablet' },
      { userId: bs[2]!, class: 'desktop' },
    ]);
    // Publish keys for every target device (empty one-time pools: the
    // signed-prekey-only bundle is a full 200).
    for (const b of bs) {
      // Publish against the key each row was born with (identity keys are
      // immutable; a different key would be refused by storeKeys).
      const row = await base.getUserById(b);
      const key = row!.identityKeyPub!;
      const up = await uploadKeysHandler(
        {
          method: 'PUT',
          path: '/',
          headers: {},
          body: JSON.stringify({
            registrationId: 7,
            identityKey: key,
            signedPrekey: { keyId: 1, pub: key, sig: key },
            kyberPrekey: { keyId: 2, pub: key, sig: key },
            oneTimePrekeys: [],
          }),
        },
        deps,
        { userId: b },
      );
      expect(up.statusCode).toBe(204);
    }

    const { limiter, taken } = recordingLimiter(deps.rateLimit);
    const depsRec: TestDeps = { ...deps, rateLimit: limiter };
    const fetch = async (caller: string, target: string) =>
      getPrekeyBundleHandler(
        { method: 'GET', path: '/', headers: {}, pathParameters: { userId: target } },
        depsRec,
        { userId: caller },
      );

    // THE WORST CASE, driven: the full 3×3 mesh — 9 fetches, one window —
    // succeeds, each unique device pair riding its RESERVED token
    // (reservations are what make the mesh order-independent).
    for (const caller of [a1, a2, a3]) {
      for (const target of bs) {
        expect((await fetch(caller, target)).statusCode).toBe(200);
      }
    }
    // Retry headroom to the pinned ceiling (12/min — the
    // release value asserted as itself), and the fair-share decomposition
    // sums to that pin EXACTLY: 9 reservations + the shared remainder.
    expect(LIMITS.prekeyFetchGroupPair.capacity).toBe(12);
    expect(
      9 * LIMITS.prekeyFetchGroupPairReserve.capacity +
        LIMITS.prekeyFetchGroupPairShared.capacity,
    ).toBe(LIMITS.prekeyFetchGroupPair.capacity);
    for (let i = 0; i < 3; i++) {
      expect((await fetch(a1, bs[0]!)).statusCode).toBe(200);
    }
    // ...and the ceiling is REAL: the 13th draw in the window refuses.
    expect((await fetch(a1, bs[0]!)).statusCode).toBe(429);
    // The take shapes, recorded from the REAL limiter: 9 distinct per-device-
    // pair reservation buckets (capacity 1 each) + ONE collapsed group-pair
    // shared pool (capacity 3) that granted the 3 retries and refused the
    // 13th draw — 12 grants total, the pinned aggregate.
    const guarTakes = taken.filter((t) => t.bucket.startsWith('prekey-guar:'));
    const sharedTakes = taken.filter((t) => t.bucket.startsWith('prekey-group:'));
    expect(new Set(guarTakes.map((t) => t.bucket)).size).toBe(9);
    expect(guarTakes.every((t) => t.capacity === LIMITS.prekeyFetchGroupPairReserve.capacity)).toBe(
      true,
    );
    expect(sharedTakes.length).toBe(4); // 3 retry grants + the refused 13th
    expect(new Set(sharedTakes.map((t) => t.bucket)).size).toBe(1);
    expect(sharedTakes.every((t) => t.capacity === LIMITS.prekeyFetchGroupPairShared.capacity)).toBe(
      true,
    );

    // KILL SWITCH: flag deleted after enablement ⇒ the
    // very same pair prices on the per-ULID legacy key at the legacy 5/min —
    // the group bucket being empty no longer matters, and the legacy bucket
    // enforces its own pinned ceiling.
    flagOn = false;
    for (let i = 0; i < 5; i++) {
      expect((await fetch(a1, bs[0]!)).statusCode).toBe(200);
    }
    expect((await fetch(a1, bs[0]!)).statusCode).toBe(429);
    const legacyTakes = taken.filter((t) => t.bucket === `prekey:${a1}:${bs[0]!}`);
    expect(legacyTakes.length).toBe(6);
    expect(legacyTakes.every((t) => t.capacity === LIMITS.prekeyFetch.capacity)).toBe(true);
  });

  gated('the HOSTILE interleaving: one pair burns every retry token FIRST and the mesh still completes', async () => {
    flagOn = true;
    const [a1, a2, a3] = [await mkUser(++seq), await mkUser(++seq), await mkUser(++seq)];
    const bs = [await mkUser(++seq), await mkUser(++seq), await mkUser(++seq)];
    await seedGroup([
      { userId: a1, class: 'phone' },
      { userId: a2, class: 'tablet' },
      { userId: a3, class: 'desktop' },
    ]);
    await seedGroup([
      { userId: bs[0]!, class: 'phone' },
      { userId: bs[1]!, class: 'tablet' },
      { userId: bs[2]!, class: 'desktop' },
    ]);
    for (const b of bs) {
      const row = await base.getUserById(b);
      const key = row!.identityKeyPub!;
      const up = await uploadKeysHandler(
        {
          method: 'PUT',
          path: '/',
          headers: {},
          body: JSON.stringify({
            registrationId: 7,
            identityKey: key,
            signedPrekey: { keyId: 1, pub: key, sig: key },
            kyberPrekey: { keyId: 2, pub: key, sig: key },
            oneTimePrekeys: [],
          }),
        },
        deps,
        { userId: b },
      );
      expect(up.statusCode).toBe(204);
    }
    const fetch = async (caller: string, target: string) =>
      getPrekeyBundleHandler(
        { method: 'GET', path: '/', headers: {}, pathParameters: { userId: target } },
        deps,
        { userId: caller },
      );

    // The sequencing the single shared bucket could NOT survive: (a1, b1)
    // retries FOUR times before anyone else moves — its reservation plus the
    // ENTIRE shared retry pool.
    for (let i = 0; i < 4; i++) {
      expect((await fetch(a1, bs[0]!)).statusCode).toBe(200);
    }
    // The other 8 unique device pairs still complete the mesh: each rides
    // its own reservation, which no sibling's retries can spend.
    for (const caller of [a1, a2, a3]) {
      for (const target of bs) {
        if (caller === a1 && target === bs[0]!) continue;
        expect((await fetch(caller, target)).statusCode).toBe(200);
      }
    }
    // 12 grants in the window — the pinned aggregate — and it is spent:
    // every further draw refuses, whichever pair asks.
    expect((await fetch(a1, bs[0]!)).statusCode).toBe(429);
    expect((await fetch(a2, bs[1]!)).statusCode).toBe(429);
  });
});
