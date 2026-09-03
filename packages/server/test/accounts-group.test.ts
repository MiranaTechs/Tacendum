import { beforeAll, describe, expect, it } from 'vitest';
import { ListTablesCommand } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { TABLES } from '@tacendum/shared';
import { makeDocClient, makeDynamoClient } from '../src/db/client.js';
import { TABLES as SERVER_TABLES } from '../src/db/tables.js';
import {
  ACCOUNTS_FEATURE_FLAG_KEY,
  GROUP_ROW_PREFIX,
  LINK_OFFER_KEY_PREFIX,
  groupRowKey,
  isClaimKey,
  makeTestOnlyDataLayer,
  type TestOnlyDataLayer,
  type DeviceClass,
  type LinkOfferRecord,
} from '../src/db/data.js';

/**
 * Account-group data layer against REAL DynamoDB.
 *
 * The properties under test are transactional, so the memory twin cannot
 * prove them: the link is one TransactWriteItems whose group-row conditions
 * hold the class-slot invariant, the roster-epoch serialization, and the
 * ≤3-member cap, whose acceptor-row condition (`attribute_not_exists(groupId)`)
 * turns a raced second link into a refusal, and
 * whose conditional offer delete is what makes an offer single-use.
 *
 * Two evidence classes, named honestly (an earlier
 * header overclaimed): the SEQUENTIAL cases pin refusal
 * classification and all-or-nothing final state, which a naive sequential
 * read-then-write implementation could also produce; what proves the
 * ConditionExpressions themselves are (a) the CONTENTION cases below —
 * concurrent same-nonce consumes, a contended class slot, same-epoch roster
 * mutations, each impossible to pass with unconditional writes — and (b)
 * the corrupt-derived-set cases (cap, acting-member) that make the precheck
 * and the condition DISAGREE and assert the condition wins.
 *
 * Runs against DynamoDB Local; skips when it is down unless
 * TACENDUM_REQUIRE_DDB=1 — set it so a skipped run
 * can never read as a pass.
 */

const REQUIRE = process.env.TACENDUM_REQUIRE_DDB === '1';

let db: TestOnlyDataLayer;
let doc: DynamoDBDocumentClient;
let available = false;

/** Distinct identities per run so reruns never collide. Digits only, which is
 * valid Crockford base32, so every minted id is a real ULID. */
const RUN = `${Date.now()}`;
let seq = 0;

/** A fresh, valid, run-unique ULID. */
function uid(): string {
  return `01${`${RUN}${String(++seq).padStart(4, '0')}`.padStart(24, '0')}`;
}

/** Create an account directly at the data layer, returning both ids. */
async function mkUser(): Promise<{ userId: string; identityKeyPub: string }> {
  const userId = uid();
  const identityKeyPub = `acct-key-${RUN}-${userId}`;
  const res = await db.getOrCreateUserByIdentityKey(identityKeyPub, userId, Date.now());
  expect(res.kind).toBe('ok');
  return { userId, identityKeyPub };
}

const NOW_S = Math.floor(Date.now() / 1000);

/** A live offer row for one ceremony, written the way the submit leg will
 * write it. Signature strings are opaque to the data layer (verification is
 * the auth Lambda's job); distinct per offer so a test can prove which
 * ceremony's certs landed on a member entry. */
function mkOffer(o: {
  groupId: string;
  offererUserId: string;
  acceptorUserId: string;
  acceptorClass: DeviceClass;
  rosterEpoch: number;
  offererClass?: DeviceClass;
  expiresAt?: number;
}): LinkOfferRecord {
  const offerNonce = `nonce-${RUN}-${++seq}`;
  return {
    offerNonce,
    groupId: o.groupId,
    offererUserId: o.offererUserId,
    acceptorUserId: o.acceptorUserId,
    acceptorClass: o.acceptorClass,
    ...(o.offererClass ? { offererClass: o.offererClass } : {}),
    rosterEpoch: o.rosterEpoch,
    expiresAt: o.expiresAt ?? NOW_S + 600,
    offerSig: `offer-sig-${offerNonce}`,
  };
}

/** Put the offer, then run the link transaction that consumes it. */
async function offerAndLink(
  o: Parameters<typeof mkOffer>[0],
): Promise<{ offer: LinkOfferRecord; result: Awaited<ReturnType<TestOnlyDataLayer['linkDeviceToGroup']>> }> {
  const offer = mkOffer(o);
  expect(await db.putLinkOffer(offer)).toBe('created');
  const result = await db.linkDeviceToGroup({
    offerNonce: offer.offerNonce,
    acceptSig: `accept-sig-${offer.offerNonce}`,
    nowSeconds: NOW_S,
    linkedAtMs: Date.now(),
  });
  return { offer, result };
}

/** A fresh phone+tablet group (the v1 maximum the API can build — desktop is
 * schema-reserved). Returns ids and the group at epoch 1. */
async function mkLinkedPair(): Promise<{
  groupId: string;
  phone: { userId: string; identityKeyPub: string };
  tablet: { userId: string; identityKeyPub: string };
}> {
  const phone = await mkUser();
  const tablet = await mkUser();
  const groupId = uid();
  const { result } = await offerAndLink({
    groupId,
    offererUserId: phone.userId,
    offererClass: 'phone',
    acceptorUserId: tablet.userId,
    acceptorClass: 'tablet',
    rosterEpoch: 0,
  });
  expect(result).toBe('linked');
  return { groupId, phone, tablet };
}

async function rawRow(table: string, key: Record<string, unknown>) {
  const res = await doc.send(new GetCommand({ TableName: table, Key: key, ConsistentRead: true }));
  return res.Item;
}

/** The reverse nonce-pointer set on a user row — empty set
 * when the attribute is absent. */
async function nonceSetOf(userId: string): Promise<Set<string>> {
  const row = await rawRow(SERVER_TABLES.users, { userId });
  return (row?.linkOfferNonces as Set<string> | undefined) ?? new Set();
}

beforeAll(async () => {
  const client = makeDynamoClient();
  doc = makeDocClient(client);
  db = makeTestOnlyDataLayer(doc);
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

function gated(name: string, fn: () => Promise<void>): void {
  it(name, async (ctx) => {
    if (!available) return ctx.skip();
    await fn();
  });
}

describe('linkDeviceToGroup', () => {
  gated('first link creates the group with both members at epoch 1 and stamps groupId on both user rows', async () => {
    const { groupId, phone, tablet } = await mkLinkedPair();

    const group = await db.getAccountGroup(groupId);
    expect(group).toBeDefined();
    expect(group?.epoch).toBe(1);
    expect(group?.identifierRefs).toEqual([]);
    expect(group?.members.map((m) => [m.userId, m.class])).toEqual([
      [phone.userId, 'phone'],
      [tablet.userId, 'tablet'],
    ]);
    // Both ceremony signatures ride the member entries as the link
    // certificates — availability copy, never authority —
    // WITH their full signed-tuple context: the
    // consuming transaction deletes the offer row, so the tuple a
    // verifier re-derives the pinned preimage from must survive here.
    for (const member of group?.members ?? []) {
      expect(member.certs!.offerSig).toMatch(/^offer-sig-/);
      expect(member.certs!.acceptSig).toMatch(/^accept-sig-/);
      expect(member.certs!.groupId).toBe(groupId);
      expect(member.certs!.offererUserId).toBe(phone.userId);
      expect(member.certs!.acceptorUserId).toBe(tablet.userId);
      // The tuple's class = the JOINING device's slot, on BOTH entries of a
      // first link — not the entry's own class.
      expect(member.certs!.class).toBe('tablet');
      expect(member.certs!.rosterEpoch).toBe(0);
      expect(member.certs!.offerNonce).toMatch(/^nonce-/);
      expect(member.certs!.expiresAt).toBeGreaterThan(NOW_S);
    }
    expect((await rawRow(SERVER_TABLES.users, { userId: phone.userId }))?.groupId).toBe(groupId);
    expect((await rawRow(SERVER_TABLES.users, { userId: tablet.userId }))?.groupId).toBe(groupId);
  });

  gated('a second device of an OCCUPIED class is REFUSED with the distinct class_occupied error and mutates nothing', async () => {
    const { groupId, tablet } = await mkLinkedPair();
    const secondPhone = await mkUser();

    const { result } = await offerAndLink({
      groupId,
      offererUserId: tablet.userId,
      acceptorUserId: secondPhone.userId,
      acceptorClass: 'phone',
      rosterEpoch: 1,
    });
    expect(result).toBe('class_occupied');

    // Nothing moved: same two members, same epoch, and the refused device's
    // row never gained a groupId — the transaction is atomic, not best-effort.
    const group = await db.getAccountGroup(groupId);
    expect(group?.members).toHaveLength(2);
    expect(group?.epoch).toBe(1);
    expect(
      (await rawRow(SERVER_TABLES.users, { userId: secondPhone.userId }))?.groupId,
    ).toBeUndefined();
  });

  gated('an offer is single-use: the link consumes the row and a replayed nonce is REFUSED offer_consumed even when every roster condition would pass', async () => {
    const { groupId, phone, tablet } = await mkLinkedPair();

    // Free the tablet slot, then link a new tablet through offer O.
    expect(
      await db.unlinkDeviceFromGroup({
        groupId,
        actingUserId: phone.userId,
        targetUserId: tablet.userId,
        rosterEpoch: 1,
      }),
    ).toBe('unlinked');
    const tablet2 = await mkUser();
    const { offer } = await (async () => {
      const r = await offerAndLink({
        groupId,
        offererUserId: phone.userId,
        acceptorUserId: tablet2.userId,
        acceptorClass: 'tablet',
        rosterEpoch: 2,
      });
      expect(r.result).toBe('linked');
      return r;
    })();

    // The winning transaction consumed the offer row itself.
    expect(
      await rawRow(SERVER_TABLES.sessions, {
        token: `${LINK_OFFER_KEY_PREFIX}${offer.offerNonce}`,
      }),
    ).toBeUndefined();

    // Free the tablet slot AGAIN so a replay meets a roster state in which
    // epoch, class slot, cap, and the acceptor's solo state would ALL pass —
    // isolating the offer-consume condition as the thing that refuses.
    expect(
      await db.unlinkDeviceFromGroup({
        groupId,
        actingUserId: phone.userId,
        targetUserId: tablet2.userId,
        rosterEpoch: 3,
      }),
    ).toBe('unlinked');
    const replay = await db.linkDeviceToGroup({
      offerNonce: offer.offerNonce,
      acceptSig: 'accept-sig-replayed',
      nowSeconds: NOW_S,
      linkedAtMs: Date.now(),
    });
    expect(replay).toBe('offer_consumed');
    expect((await db.getAccountGroup(groupId))?.members).toHaveLength(1);
  });

  gated('the 3-member cap holds as its own transaction condition even when class bookkeeping would admit a fourth', async () => {
    // Belt-and-braces (≤3 members ⇒ one row): with one-per-class over a
    // three-class taxonomy the cap is normally implied by the class-slot
    // condition, so this seeds a deliberately corrupt row — three members but
    // a memberClasses set missing entries — and proves size(members) < 3 is
    // enforced INDEPENDENTLY. A naive implementation that trusts the class
    // condition alone admits the fourth member here.
    const a = await mkUser();
    const b = await mkUser();
    const c = await mkUser();
    const groupId = uid();
    const key = groupRowKey(groupId);
    const member = (u: { userId: string }, cls: DeviceClass) => ({
      userId: u.userId,
      class: cls,
      linkedAt: Date.now(),
      certs: { offerSig: 'seed', acceptSig: 'seed' },
    });
    await doc.send(
      new PutCommand({
        TableName: SERVER_TABLES.users,
        Item: {
          userId: key,
          members: [member(a, 'phone'), member(b, 'phone'), member(c, 'phone')],
          memberClasses: new Set(['phone']),
          identifierRefs: [],
          epoch: 5,
          createdAt: Date.now(),
        },
      }),
    );
    for (const u of [a, b, c]) {
      await doc.send(
        new UpdateCommand({
          TableName: SERVER_TABLES.users,
          Key: { userId: u.userId },
          UpdateExpression: 'SET groupId = :g',
          ExpressionAttributeValues: { ':g': groupId },
        }),
      );
    }

    const joiner = await mkUser();
    const { result } = await offerAndLink({
      groupId,
      offererUserId: a.userId,
      acceptorUserId: joiner.userId,
      acceptorClass: 'tablet', // absent from the seeded memberClasses set
      rosterEpoch: 5,
    });
    expect(result).toBe('group_full');
    const group = await db.getAccountGroup(groupId);
    expect(group?.members).toHaveLength(3);
    expect(group?.epoch).toBe(5);
    expect((await rawRow(SERVER_TABLES.users, { userId: joiner.userId }))?.groupId).toBeUndefined();
  });

  gated('class = desktop is REFUSED before any write — the slot is schema-reserved in v1', async () => {
    const a = await mkUser();
    const b = await mkUser();
    const groupId = uid();
    const { result } = await offerAndLink({
      groupId,
      offererUserId: a.userId,
      offererClass: 'phone',
      acceptorUserId: b.userId,
      acceptorClass: 'desktop',
      rosterEpoch: 0,
    });
    expect(result).toBe('desktop_reserved');
    expect(await db.getAccountGroup(groupId)).toBeUndefined();
    expect((await rawRow(SERVER_TABLES.users, { userId: a.userId }))?.groupId).toBeUndefined();
    expect((await rawRow(SERVER_TABLES.users, { userId: b.userId }))?.groupId).toBeUndefined();
  });

  gated('an offer bound to a stale roster epoch is REFUSED stale_epoch — an acceptance never lands over a roster that moved after signing', async () => {
    const { groupId, phone, tablet } = await mkLinkedPair();
    // Offer minted against epoch 1...
    const straggler = await mkUser();
    const offer = mkOffer({
      groupId,
      offererUserId: phone.userId,
      acceptorUserId: straggler.userId,
      acceptorClass: 'tablet',
      rosterEpoch: 1,
    });
    expect(await db.putLinkOffer(offer)).toBe('created');
    // ...then the roster moves (tablet unlinks, epoch 1 → 2)...
    expect(
      await db.unlinkDeviceFromGroup({
        groupId,
        actingUserId: phone.userId,
        targetUserId: tablet.userId,
        rosterEpoch: 1,
      }),
    ).toBe('unlinked');
    // ...so the acceptance is refused by the epoch condition, even though the
    // tablet slot it wants is now free.
    const result = await db.linkDeviceToGroup({
      offerNonce: offer.offerNonce,
      acceptSig: `accept-sig-${offer.offerNonce}`,
      nowSeconds: NOW_S,
      linkedAtMs: Date.now(),
    });
    expect(result).toBe('stale_epoch');
    expect((await db.getAccountGroup(groupId))?.epoch).toBe(2);
    expect(
      (await rawRow(SERVER_TABLES.users, { userId: straggler.userId }))?.groupId,
    ).toBeUndefined();
  });

  gated('a device already in a group is REFUSED already_grouped by the acceptor-row condition, and the atomic refusal leaves the second group unborn', async () => {
    const { tablet } = await mkLinkedPair();
    const other = await mkUser();
    const group2 = uid();
    const { result } = await offerAndLink({
      groupId: group2,
      offererUserId: other.userId,
      offererClass: 'phone',
      acceptorUserId: tablet.userId, // already grouped elsewhere
      acceptorClass: 'tablet',
      rosterEpoch: 0,
    });
    expect(result).toBe('already_grouped');
    // The whole transaction refused: no second group row, and the offerer's
    // own row was not half-stamped.
    expect(await db.getAccountGroup(group2)).toBeUndefined();
    expect((await rawRow(SERVER_TABLES.users, { userId: other.userId }))?.groupId).toBeUndefined();
  });

  gated('an expired-but-unreaped offer is REFUSED offer_expired — the clock is the enforcement, TTL reaping is cleanup', async () => {
    const a = await mkUser();
    const b = await mkUser();
    const groupId = uid();
    const offer = mkOffer({
      groupId,
      offererUserId: a.userId,
      offererClass: 'phone',
      acceptorUserId: b.userId,
      acceptorClass: 'tablet',
      rosterEpoch: 0,
      expiresAt: NOW_S - 5, // past, but the row is still in the table
    });
    expect(await db.putLinkOffer(offer)).toBe('created');
    // The row exists (unreaped)...
    expect(
      await rawRow(SERVER_TABLES.sessions, { token: `${LINK_OFFER_KEY_PREFIX}${offer.offerNonce}` }),
    ).toBeDefined();
    // ...reads as gone at the data layer (the pair-ledger discipline)...
    expect(await db.getLinkOffer(offer.offerNonce, NOW_S)).toBeUndefined();
    // ...and the link refuses on the explicit expiry field.
    const result = await db.linkDeviceToGroup({
      offerNonce: offer.offerNonce,
      acceptSig: `accept-sig-${offer.offerNonce}`,
      nowSeconds: NOW_S,
      linkedAtMs: Date.now(),
    });
    expect(result).toBe('offer_expired');
    expect(await db.getAccountGroup(groupId)).toBeUndefined();
  });
});

describe('putLinkOffer / getLinkOffer', () => {
  gated('an offer nonce is single-mint: a second put of the same nonce answers exists and overwrites nothing', async () => {
    const a = await mkUser();
    const b = await mkUser();
    const offer = mkOffer({
      groupId: uid(),
      offererUserId: a.userId,
      offererClass: 'phone',
      acceptorUserId: b.userId,
      acceptorClass: 'tablet',
      rosterEpoch: 0,
    });
    expect(await db.putLinkOffer(offer)).toBe('created');
    expect(await db.putLinkOffer({ ...offer, offerSig: 'usurper-sig' })).toBe('exists');
    expect((await db.getLinkOffer(offer.offerNonce, NOW_S))?.offerSig).toBe(offer.offerSig);
  });

  gated('an offer lands with reverse nonce pointers on BOTH named user rows — how the deletion sweep finds every pending offer naming a member without a scan', async () => {
    const a = await mkUser();
    const b = await mkUser();
    const offer = mkOffer({
      groupId: uid(),
      offererUserId: a.userId,
      offererClass: 'phone',
      acceptorUserId: b.userId,
      acceptorClass: 'tablet',
      rosterEpoch: 0,
    });
    expect(await db.putLinkOffer(offer)).toBe('created');
    expect((await nonceSetOf(a.userId)).has(offer.offerNonce)).toBe(true);
    expect((await nonceSetOf(b.userId)).has(offer.offerNonce)).toBe(true);
  });

  gated('an offer naming a nonexistent user is REFUSED unknown_member with NOTHING written — a pointer write never mints a ghost user row', async () => {
    const a = await mkUser();
    const ghost = uid(); // never created
    const offer = mkOffer({
      groupId: uid(),
      offererUserId: a.userId,
      offererClass: 'phone',
      acceptorUserId: ghost,
      acceptorClass: 'tablet',
      rosterEpoch: 0,
    });
    expect(await db.putLinkOffer(offer)).toBe('unknown_member');
    expect(
      await rawRow(SERVER_TABLES.sessions, { token: `${LINK_OFFER_KEY_PREFIX}${offer.offerNonce}` }),
    ).toBeUndefined();
    expect(await rawRow(SERVER_TABLES.users, { userId: ghost })).toBeUndefined();
    expect((await nonceSetOf(a.userId)).has(offer.offerNonce)).toBe(false);
  });

  gated('the consuming link removes the nonce from both reverse sets in the same transaction', async () => {
    const phone = await mkUser();
    const tablet = await mkUser();
    const { offer, result } = await offerAndLink({
      groupId: uid(),
      offererUserId: phone.userId,
      offererClass: 'phone',
      acceptorUserId: tablet.userId,
      acceptorClass: 'tablet',
      rosterEpoch: 0,
    });
    expect(result).toBe('linked');
    expect((await nonceSetOf(phone.userId)).has(offer.offerNonce)).toBe(false);
    expect((await nonceSetOf(tablet.userId)).has(offer.offerNonce)).toBe(false);
  });
});

describe('unlinkDeviceFromGroup', () => {
  gated('unlink clears BOTH sides — the roster entry and the user row groupId — and frees the class slot for a re-link', async () => {
    const { groupId, phone, tablet } = await mkLinkedPair();

    expect(
      await db.unlinkDeviceFromGroup({
        groupId,
        actingUserId: tablet.userId, // the leaver may act for itself (flat model)
        targetUserId: tablet.userId,
        rosterEpoch: 1,
      }),
    ).toBe('unlinked');

    const group = await db.getAccountGroup(groupId);
    expect(group?.members.map((m) => m.userId)).toEqual([phone.userId]);
    expect(group?.epoch).toBe(2);
    // The departed device is a standalone anonymous account again — which it
    // always was: no groupId attr, user row otherwise intact.
    const tabletRow = await rawRow(SERVER_TABLES.users, { userId: tablet.userId });
    expect(tabletRow).toBeDefined();
    expect(tabletRow?.groupId).toBeUndefined();
    expect(tabletRow?.tombstoned).toBeUndefined();

    // The freed slot is genuinely free: a new tablet links.
    const tablet2 = await mkUser();
    const { result } = await offerAndLink({
      groupId,
      offererUserId: phone.userId,
      acceptorUserId: tablet2.userId,
      acceptorClass: 'tablet',
      rosterEpoch: 2,
    });
    expect(result).toBe('linked');
  });

  gated('a mutation signed at an epoch that already moved is REFUSED stale_epoch and mutates nothing (serialization)', async () => {
    const { groupId, phone, tablet } = await mkLinkedPair();
    expect(
      await db.unlinkDeviceFromGroup({
        groupId,
        actingUserId: phone.userId,
        targetUserId: tablet.userId,
        rosterEpoch: 1,
      }),
    ).toBe('unlinked');
    // The same mutation again — signed at the epoch that already moved.
    expect(
      await db.unlinkDeviceFromGroup({
        groupId,
        actingUserId: phone.userId,
        targetUserId: tablet.userId,
        rosterEpoch: 1,
      }),
    ).toBe('stale_epoch');
  });

  gated('a non-member cannot act: the mutation is REFUSED not_acting_member', async () => {
    const { groupId, tablet } = await mkLinkedPair();
    const stranger = await mkUser();
    expect(
      await db.unlinkDeviceFromGroup({
        groupId,
        actingUserId: stranger.userId,
        targetUserId: tablet.userId,
        rosterEpoch: 1,
      }),
    ).toBe('not_acting_member');
    expect((await db.getAccountGroup(groupId))?.members).toHaveLength(2);
  });

  gated('unlinking the last member deletes the group row entirely', async () => {
    const { groupId, phone, tablet } = await mkLinkedPair();
    expect(
      await db.unlinkDeviceFromGroup({
        groupId,
        actingUserId: phone.userId,
        targetUserId: tablet.userId,
        rosterEpoch: 1,
      }),
    ).toBe('unlinked');
    expect(
      await db.unlinkDeviceFromGroup({
        groupId,
        actingUserId: phone.userId,
        targetUserId: phone.userId,
        rosterEpoch: 2,
      }),
    ).toBe('unlinked');
    expect(await db.getAccountGroup(groupId)).toBeUndefined();
    expect(await rawRow(SERVER_TABLES.users, { userId: groupRowKey(groupId) })).toBeUndefined();
    expect((await rawRow(SERVER_TABLES.users, { userId: phone.userId }))?.groupId).toBeUndefined();
  });

  gated('the LAST member takes the identifier claim rows with it — a survivor leaves them untouched, the final exit deletes group row AND every identifierRefs target in one transaction', async () => {
    const { groupId, phone, tablet } = await mkLinkedPair();
    // the attach, simulated at the row level (the house corrupt-row
    // pattern): one claim row + the group row's reverse ref pointing at it.
    // The reverse list is the ONLY way the GetItem-only sweep reaches the
    // claim row, so deleting the group row without the claim rows it names
    // would strand them forever.
    const claimKey = `emailhash#v1#test-${RUN}-${++seq}`;
    await doc.send(
      new PutCommand({
        TableName: SERVER_TABLES.users,
        Item: { userId: claimKey, groupId, createdAt: Date.now() },
      }),
    );
    await doc.send(
      new UpdateCommand({
        TableName: SERVER_TABLES.users,
        Key: { userId: groupRowKey(groupId) },
        UpdateExpression: 'SET identifierRefs = :r',
        ExpressionAttributeValues: { ':r': [claimKey] },
      }),
    );

    // Survivor semantics first: one member leaves, the group and its
    // identifier claims survive untouched apart from the roster change.
    expect(
      await db.unlinkDeviceFromGroup({
        groupId,
        actingUserId: phone.userId,
        targetUserId: tablet.userId,
        rosterEpoch: 1,
      }),
    ).toBe('unlinked');
    expect(await rawRow(SERVER_TABLES.users, { userId: claimKey })).toBeDefined();
    expect((await db.getAccountGroup(groupId))?.identifierRefs).toEqual([claimKey]);

    // Last member out: the group row and the claim row die together — an
    // implementation that deletes the group row alone orphans an
    // unreachable emailhash# row (no scan, no Query, no index may find it).
    expect(
      await db.unlinkDeviceFromGroup({
        groupId,
        actingUserId: phone.userId,
        targetUserId: phone.userId,
        rosterEpoch: 2,
      }),
    ).toBe('unlinked');
    expect(await db.getAccountGroup(groupId)).toBeUndefined();
    expect(await rawRow(SERVER_TABLES.users, { userId: claimKey })).toBeUndefined();
  });

  gated('the acting member is bound INSIDE the transaction: a memberIds set omitting the actor refuses not_acting_member even though the members list — and so the precheck — admits them', async () => {
    // The corrupt-derived-set pattern (the cap test's trick): members and
    // memberIds disagree, so the precheck (which walks the members list)
    // passes and ONLY the contains(memberIds, :actor) ConditionExpression
    // can refuse. A precheck-only implementation unlinks here.
    const a = await mkUser();
    const b = await mkUser();
    const groupId = uid();
    const member = (u: { userId: string }, cls: DeviceClass) => ({
      userId: u.userId,
      class: cls,
      linkedAt: Date.now(),
      certs: { offerSig: 'seed', acceptSig: 'seed' },
    });
    await doc.send(
      new PutCommand({
        TableName: SERVER_TABLES.users,
        Item: {
          userId: groupRowKey(groupId),
          members: [member(a, 'phone'), member(b, 'tablet')],
          memberClasses: new Set(['phone', 'tablet']),
          memberIds: new Set([b.userId]), // the actor is MISSING here
          identifierRefs: [],
          epoch: 4,
          createdAt: Date.now(),
        },
      }),
    );
    for (const u of [a, b]) {
      await doc.send(
        new UpdateCommand({
          TableName: SERVER_TABLES.users,
          Key: { userId: u.userId },
          UpdateExpression: 'SET groupId = :g',
          ExpressionAttributeValues: { ':g': groupId },
        }),
      );
    }

    expect(
      await db.unlinkDeviceFromGroup({
        groupId,
        actingUserId: a.userId,
        targetUserId: b.userId,
        rosterEpoch: 4,
      }),
    ).toBe('not_acting_member');
    // Nothing moved: the refusal came from the condition, atomically.
    const group = await db.getAccountGroup(groupId);
    expect(group?.epoch).toBe(4);
    expect(group?.members).toHaveLength(2);
    expect((await rawRow(SERVER_TABLES.users, { userId: b.userId }))?.groupId).toBe(groupId);
  });
});

describe('revokeDeviceFromGroup (lost/stolen strength)', () => {
  gated('revoke removes the member, tombstones its identity key, and leaves a tombstoned row with formerGroupId', async () => {
    const { groupId, phone, tablet } = await mkLinkedPair();

    expect(
      await db.revokeDeviceFromGroup({
        groupId,
        actingUserId: phone.userId,
        targetUserId: tablet.userId,
        rosterEpoch: 1,
      }),
    ).toBe('revoked');

    const group = await db.getAccountGroup(groupId);
    expect(group?.members.map((m) => m.userId)).toEqual([phone.userId]);
    expect(group?.epoch).toBe(2);

    // The dead ULID keeps a forwarding hint, never authority: row
    // tombstoned, formerGroupId retained, groupId gone.
    const victimRow = await rawRow(SERVER_TABLES.users, { userId: tablet.userId });
    expect(victimRow?.tombstoned).toBe(true);
    expect(victimRow?.formerGroupId).toBe(groupId);
    expect(victimRow?.groupId).toBeUndefined();

    // The identity key can never re-auth: the claim row answers tombstoned,
    // not "fresh account" (the enforcement half — teardown is the cleanup).
    const reauth = await db.getOrCreateUserByIdentityKey(
      tablet.identityKeyPub,
      uid(),
      Date.now(),
    );
    expect(reauth.kind).toBe('tombstoned');
  });

  gated('a stale-epoch revoke is REFUSED and tombstones nothing', async () => {
    const { groupId, phone, tablet } = await mkLinkedPair();
    expect(
      await db.unlinkDeviceFromGroup({
        groupId,
        actingUserId: phone.userId,
        targetUserId: tablet.userId,
        rosterEpoch: 1,
      }),
    ).toBe('unlinked');
    // Revoke signed at epoch 1 lands against epoch 2: refused whole — a
    // removed member's in-flight mutation lands against nothing.
    expect(
      await db.revokeDeviceFromGroup({
        groupId,
        actingUserId: phone.userId,
        targetUserId: tablet.userId,
        rosterEpoch: 1,
      }),
    ).toBe('stale_epoch');
    const reauth = await db.getOrCreateUserByIdentityKey(
      tablet.identityKeyPub,
      uid(),
      Date.now(),
    );
    expect(reauth.kind).toBe('ok');
  });
});

describe('contention — the ConditionExpressions, not the prechecks, are the enforcement', () => {
  gated('N concurrent consumes of ONE offer: exactly one links, every loser refuses, and exactly the winning ceremony lands', async () => {
    const a = await mkUser();
    const b = await mkUser();
    const groupId = uid();
    const offer = mkOffer({
      groupId,
      offererUserId: a.userId,
      offererClass: 'phone',
      acceptorUserId: b.userId,
      acceptorClass: 'tablet',
      rosterEpoch: 0,
    });
    expect(await db.putLinkOffer(offer)).toBe('created');
    const N = 6;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        db.linkDeviceToGroup({
          offerNonce: offer.offerNonce,
          acceptSig: `accept-sig-race-${i}`,
          nowSeconds: NOW_S,
          linkedAtMs: Date.now(),
        }),
      ),
    );
    // A naive implementation (read, check, write, unconditional delete)
    // lets several contenders through; the conditional offer consume plus
    // the group/user conditions admit EXACTLY one.
    const winners = results.flatMap((r, i) => (r === 'linked' ? [i] : []));
    expect(winners).toHaveLength(1);
    for (const r of results) {
      expect(['linked', 'offer_consumed', 'already_grouped', 'stale_epoch']).toContain(r);
    }
    const group = await db.getAccountGroup(groupId);
    expect(group?.epoch).toBe(1);
    expect(group?.members).toHaveLength(2);
    // Exactly the winning call's acceptance signature became the cert — a
    // loser's ceremony left no trace.
    for (const m of group?.members ?? []) {
      expect(m.certs!.acceptSig).toBe(`accept-sig-race-${winners[0]}`);
    }
    expect(
      await rawRow(SERVER_TABLES.sessions, { token: `${LINK_OFFER_KEY_PREFIX}${offer.offerNonce}` }),
    ).toBeUndefined();
  });

  gated('two ceremonies contend for ONE free class slot: exactly one links; the loser mutates nothing and its unconsumed single-use offer survives', async () => {
    const { groupId, phone, tablet } = await mkLinkedPair();
    expect(
      await db.unlinkDeviceFromGroup({
        groupId,
        actingUserId: phone.userId,
        targetUserId: tablet.userId,
        rosterEpoch: 1,
      }),
    ).toBe('unlinked'); // epoch 2, tablet slot free
    const c1 = await mkUser();
    const c2 = await mkUser();
    const o1 = mkOffer({
      groupId,
      offererUserId: phone.userId,
      acceptorUserId: c1.userId,
      acceptorClass: 'tablet',
      rosterEpoch: 2,
    });
    const o2 = mkOffer({
      groupId,
      offererUserId: phone.userId,
      acceptorUserId: c2.userId,
      acceptorClass: 'tablet',
      rosterEpoch: 2,
    });
    expect(await db.putLinkOffer(o1)).toBe('created');
    expect(await db.putLinkOffer(o2)).toBe('created');
    const outcomes = await Promise.all([
      db.linkDeviceToGroup({
        offerNonce: o1.offerNonce,
        acceptSig: `accept-sig-${o1.offerNonce}`,
        nowSeconds: NOW_S,
        linkedAtMs: Date.now(),
      }),
      db.linkDeviceToGroup({
        offerNonce: o2.offerNonce,
        acceptSig: `accept-sig-${o2.offerNonce}`,
        nowSeconds: NOW_S,
        linkedAtMs: Date.now(),
      }),
    ]);
    expect(outcomes.filter((r) => r === 'linked')).toHaveLength(1);
    const loserIdx = outcomes[0] === 'linked' ? 1 : 0;
    expect(['stale_epoch', 'class_occupied']).toContain(outcomes[loserIdx]);
    const group = await db.getAccountGroup(groupId);
    expect(group?.epoch).toBe(3);
    expect(group?.members).toHaveLength(2);
    expect(group?.members.filter((m) => m.class === 'tablet')).toHaveLength(1);
    const loser = loserIdx === 0 ? { offer: o1, user: c1 } : { offer: o2, user: c2 };
    expect((await rawRow(SERVER_TABLES.users, { userId: loser.user.userId }))?.groupId).toBeUndefined();
    // The losing transaction rolled back WHOLE: its single-use offer was
    // NOT consumed — a naive implementation deletes the offer regardless of
    // whether the roster write landed.
    expect(await db.getLinkOffer(loser.offer.offerNonce, NOW_S)).toBeDefined();
  });

  gated('two roster mutations signed at the SAME epoch: exactly one commits; the loser leaves NO enforcement side effects (serialization)', async () => {
    const { groupId, phone, tablet } = await mkLinkedPair();
    const [ur, rr] = await Promise.all([
      db.unlinkDeviceFromGroup({
        groupId,
        actingUserId: phone.userId,
        targetUserId: tablet.userId,
        rosterEpoch: 1,
      }),
      db.revokeDeviceFromGroup({
        groupId,
        actingUserId: tablet.userId,
        targetUserId: phone.userId,
        rosterEpoch: 1,
      }),
    ]);
    expect([ur === 'unlinked', rr === 'revoked'].filter(Boolean)).toHaveLength(1);
    const group = await db.getAccountGroup(groupId);
    expect(group?.epoch).toBe(2);
    expect(group?.members).toHaveLength(1);
    if (ur === 'unlinked') {
      expect(['stale_epoch', 'not_acting_member', 'not_member']).toContain(rr);
      expect(group?.members[0]?.userId).toBe(phone.userId);
      // The losing revoke tombstoned NOTHING — a non-transactional revoke
      // would have written the tombstone before losing the roster race.
      const phoneRow = await rawRow(SERVER_TABLES.users, { userId: phone.userId });
      expect(phoneRow?.tombstoned).toBeUndefined();
      expect(
        (await db.getOrCreateUserByIdentityKey(phone.identityKeyPub, uid(), Date.now())).kind,
      ).toBe('ok');
    } else {
      expect(['stale_epoch', 'not_acting_member', 'not_member']).toContain(ur);
      expect(group?.members[0]?.userId).toBe(tablet.userId);
      // Revoke won WHOLE: enforcement record present, and the losing unlink
      // half-cleared nothing.
      const phoneRow = await rawRow(SERVER_TABLES.users, { userId: phone.userId });
      expect(phoneRow?.tombstoned).toBe(true);
      expect(phoneRow?.formerGroupId).toBe(groupId);
      expect((await rawRow(SERVER_TABLES.users, { userId: tablet.userId }))?.groupId).toBe(groupId);
    }
  });
});

describe('feature#accounts flag row', () => {
  gated('absent = OFF, operator-written {enabled: true} = ON, deleted again = OFF, malformed = OFF', async () => {
    // The flag row is operator-written — there is deliberately NO TestOnlyDataLayer
    // write method for it; these direct writes ARE the operator's console
    // write. Deleting it is the kill switch.
    await doc.send(
      new DeleteCommand({
        TableName: SERVER_TABLES.users,
        Key: { userId: ACCOUNTS_FEATURE_FLAG_KEY },
      }),
    );
    expect(await db.isAccountsFeatureEnabled()).toBe(false);

    await doc.send(
      new PutCommand({
        TableName: SERVER_TABLES.users,
        Item: { userId: ACCOUNTS_FEATURE_FLAG_KEY, enabled: true },
      }),
    );
    expect(await db.isAccountsFeatureEnabled()).toBe(true);

    // Malformed rows fail CLOSED.
    await doc.send(
      new PutCommand({
        TableName: SERVER_TABLES.users,
        Item: { userId: ACCOUNTS_FEATURE_FLAG_KEY, enabled: 'yes' },
      }),
    );
    expect(await db.isAccountsFeatureEnabled()).toBe(false);

    await doc.send(
      new DeleteCommand({
        TableName: SERVER_TABLES.users,
        Key: { userId: ACCOUNTS_FEATURE_FLAG_KEY },
      }),
    );
    expect(await db.isAccountsFeatureEnabled()).toBe(false);
  });
});

describe('claim-key discipline (data.ts CLAIM_PREFIXES)', () => {
  gated('group rows and the flag row are unaddressable as users — getUserById refuses the prefixes', async () => {
    const { groupId } = await mkLinkedPair();
    expect(isClaimKey(groupRowKey(groupId))).toBe(true);
    expect(isClaimKey(ACCOUNTS_FEATURE_FLAG_KEY)).toBe(true);
    // The rows EXIST, and are still refused — a caller-supplied group# or
    // feature# reaching GET /v1/keys/{userId} or WS send.to would be an
    // oracle and a dead-letter queue mint.
    expect(await db.getUserById(groupRowKey(groupId))).toBeUndefined();
    expect(await db.getUserById(`${GROUP_ROW_PREFIX}nonexistent`)).toBeUndefined();
    expect(await db.getUserById(ACCOUNTS_FEATURE_FLAG_KEY)).toBeUndefined();
  });
});
