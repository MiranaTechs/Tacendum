import { describe, expect, it } from 'vitest';
import { AccountsNotice, normalizeUsernameIdentifier, usernameSkeleton } from '@tacendum/shared';
import { USERNAME_CLAIM_KEY_PREFIX, type TestOnlyDataLayer } from '../src/db/data.js';
import { activeNameskelClaimKeys, activeUsernameClaimKeys } from '../src/opaque-ref.js';
import { notifyUsernameRevoked, revokeUsernameAndNotify } from '../src/handlers/username.js';
import { allQueued, makeMemoryDb, makeTestDeps, type TestDeps } from './helpers.js';

/**
 * (server twin) — THE REVOCATION NOTICE: after the
 * data-layer revoke commits, and only then, `usernameRevoked` is fanned to
 * every member of the holder's group through the ordinary accounts-notice
 * queue (the recovery-notice delivery pattern).
 * Driven against the memory twin through the SAME twin the ops script drives
 * (`revokeUsernameAndNotify`), under the deps clock (advanced, never pinned).
 *
 * What these pin:
 * - `revoked` → one 'accounts' queue row per member of the holder's group,
 * payload exactly `{ kind: 'usernameRevoked' }` — kind only, reasonless,
 * no groupId, no holder; a non-member receives nothing;
 * - `gone` (the second run, or a name never claimed) sends NOTHING — a
 * notice is never minted for a tombstone that did not land now;
 * - best-effort per member: one member's enqueue failing is a counter, the
 * other member still receives its row, and the outcome stays `revoked`;
 * - field-free logging over every log line the path produced.
 */

const KEYS = [{ version: 1, key: 'test-identifier-hmac-key' }];
const RUN = `${Date.now()}75`;
let seq = 0;
function uid(): string {
  return `01${`${RUN}${String(++seq).padStart(4, '0')}`.padStart(24, '0')}`;
}
const SUFFIX = RUN.split('')
  .map((d) => 'abcdefghij'[Number(d)])
  .join('');

interface Acct {
  userId: string;
}

async function mkAcct(db: TestOnlyDataLayer, deps: TestDeps): Promise<Acct> {
  const userId = uid();
  const born = await db.getOrCreateUserByIdentityKey(`idkey-rv-${userId}`, userId, deps.now());
  expect(born.kind).toBe('ok');
  return { userId };
}

/** A phone+tablet group through the real link transaction (the
 * accounts-recovery seeding), holding `name` through the real claim
 * transaction (the data layer's own CAS — the handler's gate is the business, not this suite's). */
async function mkHolderGroup(
  db: TestOnlyDataLayer,
  deps: TestDeps,
  name: string,
): Promise<{ phone: Acct; tablet: Acct; groupId: string; claimKeys: string[] }> {
  const phone = await mkAcct(db, deps);
  const tablet = await mkAcct(db, deps);
  const groupId = uid();
  const offerNonce = `nonce-rv-${RUN}-${++seq}`;
  const nowS = Math.floor(deps.now() / 1000);
  expect(
    await db.putLinkOffer({
      offerNonce,
      groupId,
      offererUserId: phone.userId,
      acceptorUserId: tablet.userId,
      acceptorClass: 'tablet',
      offererClass: 'phone',
      rosterEpoch: 0,
      expiresAt: nowS + 600,
      offerSig: Buffer.from(`o-${offerNonce}`).toString('base64'),
    }),
  ).toBe('created');
  expect(
    await db.linkDeviceToGroup({
      offerNonce,
      acceptSig: Buffer.from(`a-${offerNonce}`).toString('base64'),
      nowSeconds: nowS,
      linkedAtMs: deps.now(),
    }),
  ).toBe('linked');
  const normalized = normalizeUsernameIdentifier(name);
  const claimKeys = activeUsernameClaimKeys(KEYS, normalized);
  const skeletonKeys = activeNameskelClaimKeys(KEYS, usernameSkeleton(normalized));
  const group = await db.getAccountGroup(groupId);
  expect(
    await db.claimUsername({
      userId: phone.userId,
      groupId,
      refsSnapshot: group!.identifierRefs,
      claimKey: claimKeys[0]!,
      skeletonKey: skeletonKeys[0]!,
      retiringClaimKeys: [],
      retiringSkeletonKeys: [],
      discoverable: true,
      nowMs: deps.now(),
    }),
  ).toBe('claimed');
  return { phone, tablet, groupId, claimKeys };
}

async function noticesFor(db: TestOnlyDataLayer, userId: string): Promise<AccountsNotice[]> {
  return (await allQueued(db, userId))
    .filter((m) => m.type === 'accounts')
    .map((m) => AccountsNotice.parse(JSON.parse(Buffer.from(m.payload, 'base64').toString())));
}

describe('revokeUsernameAndNotify — the ops twin', () => {
  it('revoked → every member of the holder\'s group is handed exactly { kind: "usernameRevoked" }; a stranger receives nothing; the slot reopened', async () => {
    const db = makeMemoryDb();
    const deps = makeTestDeps(db);
    const holder = await mkHolderGroup(db, deps, `alice${SUFFIX}a`);
    const stranger = await mkAcct(db, deps);
    deps.advanceMs(86_400_000);

    const result = await revokeUsernameAndNotify(deps, holder.claimKeys, deps.now());
    expect(result).toEqual({ outcome: 'revoked', notified: 2 });

    for (const member of [holder.phone, holder.tablet]) {
      const notices = await noticesFor(db, member.userId);
      expect(notices).toEqual([{ kind: 'usernameRevoked' }]);
      // Reasonless, groupless, holderless on the wire: the parsed object IS
      // the whole payload.
      const raw = (await allQueued(db, member.userId)).filter((m) => m.type === 'accounts');
      expect(raw).toHaveLength(1);
      expect(JSON.parse(Buffer.from(raw[0]!.payload, 'base64').toString())).toEqual({
        kind: 'usernameRevoked',
      });
      // Attributed to the recipient's own account — no member acted.
      expect(raw[0]!.senderId).toBe(member.userId);
    }
    expect(await allQueued(db, stranger.userId)).toEqual([]);
    // Detached the NAME only: the group survives, the username ref is gone.
    const group = await db.getAccountGroup(holder.groupId);
    expect(group).toBeDefined();
    expect(group!.members.map((m) => m.userId).sort()).toEqual(
      [holder.phone.userId, holder.tablet.userId].sort(),
    );
    expect(group!.identifierRefs.some((ref) => ref.startsWith(USERNAME_CLAIM_KEY_PREFIX))).toBe(
      false,
    );
  });

  it('gone → nothing is sent: a second run, and a name never claimed, both mint no notice', async () => {
    const db = makeMemoryDb();
    const deps = makeTestDeps(db);
    const holder = await mkHolderGroup(db, deps, `bob${SUFFIX}b`);
    deps.advanceMs(3_600_000);
    expect(await revokeUsernameAndNotify(deps, holder.claimKeys, deps.now())).toEqual({
      outcome: 'revoked',
      notified: 2,
    });
    deps.advanceMs(3_600_000);
    expect(await revokeUsernameAndNotify(deps, holder.claimKeys, deps.now())).toEqual({
      outcome: 'gone',
      notified: 0,
    });
    const never = activeUsernameClaimKeys(KEYS, `nobody${SUFFIX}b`);
    expect(await revokeUsernameAndNotify(deps, never, deps.now())).toEqual({
      outcome: 'gone',
      notified: 0,
    });
    // Still exactly one notice per member — the second run added none.
    expect(await noticesFor(db, holder.phone.userId)).toHaveLength(1);
    expect(await noticesFor(db, holder.tablet.userId)).toHaveLength(1);
  });

  it('the walk is newest-first and stops at the first live version — a retiring-version key after a gone newest is still found', async () => {
    const db = makeMemoryDb();
    const deps = makeTestDeps(db);
    const holder = await mkHolderGroup(db, deps, `carol${SUFFIX}c`);
    // A rotation window: the (fictional) newer version holds nothing; the
    // claim lives under the supplied older key. `gone` on the first, then
    // `revoked` on the second — one notice per member, never two.
    const newer = activeUsernameClaimKeys(
      [{ version: 2, key: 'test-identifier-hmac-key-v2' }],
      `carol${SUFFIX}c`,
    );
    expect(
      await revokeUsernameAndNotify(deps, [...newer, ...holder.claimKeys], deps.now()),
    ).toEqual({ outcome: 'revoked', notified: 2 });
    expect(await noticesFor(db, holder.phone.userId)).toHaveLength(1);
  });

  it("best-effort per member: one member's enqueue failing is a counter, the other still receives, the outcome stays revoked", async () => {
    const db = makeMemoryDb();
    const deps = makeTestDeps(db);
    const holder = await mkHolderGroup(db, deps, `dave${SUFFIX}d`);
    const failing: TestOnlyDataLayer = {
      ...db,
      enqueueMessage: async (msg, opts) => {
        if (msg.recipientId === holder.tablet.userId) throw new Error('injected enqueue failure');
        return db.enqueueMessage(msg, opts);
      },
    };
    const brokenDeps: TestDeps = { ...deps, db: failing };
    expect(await revokeUsernameAndNotify(brokenDeps, holder.claimKeys, deps.now())).toEqual({
      outcome: 'revoked',
      notified: 2,
    });
    expect(await noticesFor(db, holder.phone.userId)).toEqual([{ kind: 'usernameRevoked' }]);
    expect(await noticesFor(db, holder.tablet.userId)).toEqual([]);
    expect(deps.logs.filter((l) => l.event === 'accounts_notice_enqueue_failed')).toHaveLength(1);
  });

  it('best-effort as a whole: the group read failing AFTER the tombstone committed is a counter — the outcome stays revoked, the count is 0, the rows are tombstoned', async () => {
    const db = makeMemoryDb();
    const deps = makeTestDeps(db);
    const holder = await mkHolderGroup(db, deps, `frank${SUFFIX}f`);
    deps.advanceMs(3_600_000);
    let revokeCommitted = false;
    const failing: TestOnlyDataLayer = {
      ...db,
      revokeUsername: async (input) => {
        const result = await db.revokeUsername(input);
        if (result.outcome === 'revoked') revokeCommitted = true;
        return result;
      },
      getAccountGroup: async (groupId) => {
        if (revokeCommitted) throw new Error('injected group-read failure');
        return db.getAccountGroup(groupId);
      },
    };
    const brokenDeps: TestDeps = { ...deps, db: failing };
    // The script prints `revoked` and exits 0 — never `revoke failed` for a
    // revocation that landed.
    expect(await revokeUsernameAndNotify(brokenDeps, holder.claimKeys, deps.now())).toEqual({
      outcome: 'revoked',
      notified: 0,
    });
    expect(deps.logs.filter((l) => l.event === 'accounts_notice_enqueue_failed')).toHaveLength(1);
    // Nobody heard — and the tombstone is real: a re-run answers `gone`, the
    // username ref is off the group, and the slot is not reclaimable now.
    expect(await noticesFor(db, holder.phone.userId)).toEqual([]);
    expect(await noticesFor(db, holder.tablet.userId)).toEqual([]);
    deps.advanceMs(3_600_000);
    expect(await revokeUsernameAndNotify(deps, holder.claimKeys, deps.now())).toEqual({
      outcome: 'gone',
      notified: 0,
    });
    const group = await db.getAccountGroup(holder.groupId);
    expect(group!.identifierRefs.some((ref) => ref.startsWith(USERNAME_CLAIM_KEY_PREFIX))).toBe(
      false,
    );
  });

  it('notifyUsernameRevoked alone: an unknown group sends nothing and answers 0', async () => {
    const db = makeMemoryDb();
    const deps = makeTestDeps(db);
    expect(await notifyUsernameRevoked(deps, uid())).toBe(0);
  });

  it('field-free logs: no name, no claim key, no ULID, no groupId reached a log line', async () => {
    const db = makeMemoryDb();
    const deps = makeTestDeps(db);
    const name = `erin${SUFFIX}e`;
    const holder = await mkHolderGroup(db, deps, name);
    await revokeUsernameAndNotify(deps, holder.claimKeys, deps.now());
    const canaries = [
      name,
      ...holder.claimKeys,
      holder.groupId,
      holder.phone.userId,
      holder.tablet.userId,
    ];
    for (const entry of deps.logs) {
      const line = JSON.stringify(entry);
      for (const canary of canaries) expect(line).not.toContain(canary);
    }
  });
});
