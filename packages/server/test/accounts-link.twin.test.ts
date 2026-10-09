import { describe, expect, it } from 'vitest';
import { emailClaimKey, identifierClaimHash } from '../src/opaque-ref.js';
import { makeMemoryDb } from './helpers.js';

/**
 * THE JOIN BRANCH RE-CERTIFIES THE OFFERER'S OWN ENTRY — the memory twin
 * (field report 2026-10-08, S2 (b)). The store's rule is pinned over
 * DynamoDB Local in accounts-link.test.ts (`heavy`, so it runs on a
 * developer's machine and nowhere else); this is the store-blind half, in
 * the `fast` project CI actually runs, the accounts-discovery-self.twin
 * pattern.
 *
 * Why the twin must carry it: every routes suite that links a sibling
 * through `makeMemoryDb` (the username routes' `linkSibling`, the revoke
 * notice) reads back the roster the twin wrote. A twin whose join appended
 * the acceptor alone would hand those suites a roster the store never
 * produces — the offerer's entry certless (an attach-created founder) or
 * carrying a PREVIOUS ceremony's certs (a re-link after an unlink) — the
 * exact shape that stalled the offerer's completion probe (app linking.ts
 * `completeOffererLink`) on "Waiting for the new device to confirm". The
 * twin may never drift more permissive than the store; it may not stay
 * less faithful either once the store's rule is ruled.
 */

// Digits only (valid Crockford base32); '81' is this file's discriminator.
const RUN = `${Date.now()}81`;
let seq = 0;
function uid(): string {
  return `01${`${RUN}${String(++seq).padStart(4, '0')}`.padStart(24, '0')}`;
}

const TEST_KID = 'test-identifier-hmac-key';
const START_MS = 1_700_000_000_000;

type Db = ReturnType<typeof makeMemoryDb>;

/** A registered human account (no group yet). */
async function person(db: Db, nowMs: number): Promise<string> {
  const userId = uid();
  const born = await db.getOrCreateUserByIdentityKey(`idkey-link-twin-${userId}`, userId, nowMs);
  expect(born.kind).toBe('ok');
  return userId;
}

/** The §3 lazy-solo founder an email attach mints: a one-member group born
 * WITHOUT a ceremony, so its entry carries no certs — honestly. */
async function attachFounder(db: Db, userId: string, nowMs: number): Promise<string> {
  const claimKey = emailClaimKey(1, identifierClaimHash(TEST_KID, `${userId}@example.test`));
  await db.putEmailCode({
    userId,
    purpose: 'attach',
    claimKey,
    deviceClass: 'phone',
    code: '123456',
    attempts: 0,
    createdAt: nowMs,
    expiresAt: Math.floor(nowMs / 1000) + 300,
  });
  const groupId = uid();
  expect(
    await db.attachIdentifier({
      userId,
      deviceClass: 'phone',
      newGroupId: groupId,
      claimKey,
      retiringClaimKeys: [],
      nowMs,
    }),
  ).toBe('attached');
  return groupId;
}

interface Ceremony {
  offerNonce: string;
  offerSig: string;
  acceptSig: string;
  expiresAt: number;
}

/** One link ceremony at the data layer: the offer row, then the consume.
 * `offererClass` present exactly for a FIRST link (rosterEpoch 0). */
async function ceremony(
  db: Db,
  input: {
    groupId: string;
    offererUserId: string;
    acceptorUserId: string;
    rosterEpoch: number;
    offererClass?: 'phone';
    nowMs: number;
  },
): Promise<Ceremony> {
  const offerNonce = `nonce-link-twin-${RUN}-${++seq}`;
  const nowS = Math.floor(input.nowMs / 1000);
  const expiresAt = nowS + 600;
  const offerSig = Buffer.from(`o-${offerNonce}`).toString('base64');
  const acceptSig = Buffer.from(`a-${offerNonce}`).toString('base64');
  expect(
    await db.putLinkOffer({
      offerNonce,
      groupId: input.groupId,
      offererUserId: input.offererUserId,
      acceptorUserId: input.acceptorUserId,
      acceptorClass: 'tablet',
      ...(input.offererClass !== undefined ? { offererClass: input.offererClass } : {}),
      rosterEpoch: input.rosterEpoch,
      expiresAt,
      offerSig,
    }),
  ).toBe('created');
  expect(
    await db.linkDeviceToGroup({
      offerNonce,
      acceptSig,
      nowSeconds: nowS,
      linkedAtMs: input.nowMs,
    }),
  ).toBe('linked');
  return { offerNonce, offerSig, acceptSig, expiresAt };
}

describe("the join branch re-certifies the OFFERER's own entry — the memory twin (field report 2026-10-08, S2 (b))", () => {
  it("an attach-created founder (born certless) links a tablet through the join branch: the offerer's entry carries THIS ceremony's certs exactly as the acceptor's does, and the email the attach minted rides through untouched", async () => {
    const db = makeMemoryDb();
    db.setAccountsFeatureEnabled(true);
    const a = await person(db, START_MS);
    const groupId = await attachFounder(db, a, START_MS);
    const before = (await db.getAccountGroup(groupId))!;
    expect(before.epoch).toBe(1);
    expect(before.attachCreated).toBe(true);
    // Born certless, honestly — the state the join must repair.
    expect(before.members).toHaveLength(1);
    expect(before.members[0]!.certs).toBeUndefined();

    const b = await person(db, START_MS + 1_000);
    const c = await ceremony(db, {
      groupId,
      offererUserId: a,
      acceptorUserId: b,
      rosterEpoch: 1,
      nowMs: START_MS + 2_000,
    });

    const group = (await db.getAccountGroup(groupId))!;
    expect(group.epoch).toBe(2);
    expect(group.members.map((m) => [m.userId, m.class])).toEqual([
      [a, 'phone'],
      [b, 'tablet'],
    ]);
    // The store's rule: the offerer's entry re-certified IN PLACE with this
    // ceremony's certs, the acceptor's appended with the same — so the
    // offerer's completion probe can verify the acceptance off its own entry.
    for (const member of group.members) {
      expect(member.certs?.offerNonce, member.userId).toBe(c.offerNonce);
      expect(member.certs?.offerSig, member.userId).toBe(c.offerSig);
      expect(member.certs?.acceptSig, member.userId).toBe(c.acceptSig);
      expect(member.certs?.groupId, member.userId).toBe(groupId);
      expect(member.certs?.offererUserId, member.userId).toBe(a);
      expect(member.certs?.acceptorUserId, member.userId).toBe(b);
      expect(member.certs?.class, member.userId).toBe('tablet');
      expect(member.certs?.rosterEpoch, member.userId).toBe(1);
      expect(member.certs?.expiresAt, member.userId).toBe(c.expiresAt);
    }
    expect(group.members[0]!.certs).toEqual(group.members[1]!.certs);
    // Everything else on the offerer's entry and the group is untouched.
    expect(group.members[0]!.linkedAt).toBe(before.members[0]!.linkedAt);
    expect(group.identifierRefs).toEqual(before.identifierRefs);
    expect(group.attachCreated).toBe(true);
    expect((await db.getUserById(b))?.groupId).toBe(groupId);
  });

  it("unlink, then link a replacement: the offerer's entry carries the NEW ceremony's certificates (not the first ceremony's), the newcomer's entry carries the same, and the departed tablet stays ungrouped", async () => {
    const db = makeMemoryDb();
    db.setAccountsFeatureEnabled(true);
    const a = await person(db, START_MS);
    const b = await person(db, START_MS);
    const groupId = uid();
    // A FIRST link (rosterEpoch 0): the group is born with both entries
    // certified by ceremony one — the branch that was always right.
    const first = await ceremony(db, {
      groupId,
      offererUserId: a,
      acceptorUserId: b,
      rosterEpoch: 0,
      offererClass: 'phone',
      nowMs: START_MS + 1_000,
    });
    const linked = (await db.getAccountGroup(groupId))!;
    expect(linked.epoch).toBe(1);
    for (const member of linked.members) expect(member.certs?.offerNonce).toBe(first.offerNonce);

    // The tablet leaves (the roster walk; epoch 1 → 2).
    expect(
      await db.unlinkDeviceFromGroup({
        groupId,
        actingUserId: a,
        targetUserId: b,
        rosterEpoch: 1,
        nowMs: START_MS + 2_000,
      }),
    ).toBe('unlinked');
    expect((await db.getAccountGroup(groupId))!.epoch).toBe(2);

    // A replacement tablet joins through the join branch (grouped offerer,
    // no declared class).
    const c = await person(db, START_MS + 3_000);
    const second = await ceremony(db, {
      groupId,
      offererUserId: a,
      acceptorUserId: c,
      rosterEpoch: 2,
      nowMs: START_MS + 4_000,
    });

    const group = (await db.getAccountGroup(groupId))!;
    expect(group.epoch).toBe(3);
    expect(group.members.map((m) => [m.userId, m.class])).toEqual([
      [a, 'phone'],
      [c, 'tablet'],
    ]);
    const mine = group.members.find((m) => m.userId === a)!;
    const theirs = group.members.find((m) => m.userId === c)!;
    // Before the mirror landed the offerer kept the FIRST ceremony's certs
    // (acceptor b, nonce `first`), which the new tablet's key can never
    // verify.
    expect(mine.certs?.offerNonce).toBe(second.offerNonce);
    expect(mine.certs?.offerNonce).not.toBe(first.offerNonce);
    expect(mine.certs?.acceptorUserId).toBe(c);
    expect(mine.certs?.acceptSig).toBe(second.acceptSig);
    expect(mine.certs?.rosterEpoch).toBe(2);
    expect(mine.certs).toEqual(theirs.certs);
    // The departed tablet's row is still unlinked: nothing re-grouped it.
    expect((await db.getUserById(b))?.groupId).toBeUndefined();
    expect((await db.getUserById(c))?.groupId).toBe(groupId);
  });
});
