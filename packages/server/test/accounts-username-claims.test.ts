import { beforeAll, describe, expect, it } from 'vitest';
import { ListTablesCommand } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, GetCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  MAX_VERIFIED_IDENTIFIERS_PER_GROUP,
  TABLES,
  USERNAME_RENAME_COOLDOWN_SECONDS,
  USERNAME_TOMBSTONE_TTL_SECONDS,
  normalizeUsernameIdentifier,
  usernameSkeleton,
} from '@tacendum/shared';
import { makeDocClient, makeDynamoClient } from '../src/db/client.js';
import {
  NAMESKEL_CLAIM_KEY_PREFIX,
  USERNAME_CLAIM_KEY_PREFIX,
  identifierClaimDiscoverable,
  isClaimKey,
  makeDataLayer,
  type DataLayer,
  type IdentifierClaimRecord,
  type UsernameTombstoneRecord,
} from '../src/db/data.js';
import {
  activeNameskelClaimKeys,
  activeUsernameClaimKeys,
  emailClaimKey,
  identifierClaimHash,
  type IdentifierHmacKey,
} from '../src/opaque-ref.js';
import { makeMemoryDb } from './helpers.js';

/**
 * (part A) — THE UNIQUENESS SUITE, driven against the
 * memory twin AND real DynamoDB Local (heavy project; the twin runs
 * unconditionally, the store is gated on :8000 exactly as the accounts-*
 * suites gate — TACENDUM_REQUIRE_DDB=1 turns the skip into a failure). One
 * scenario list, two DataLayers, so the twin can never drift more
 * permissive than the store (the helpers.ts rule).
 *
 * EVERY deadline here runs under an ADVANCING clock (a test pinning now
 * beside advancing timers hides deadline defects). `Clock` is the only source of time; every
 * DataLayer call takes `clock.nowMs`; a scenario that must wait 29 days
 * calls `clock.advance(29 * DAY)` and the arithmetic is the store's own.
 *
 * Names are UNIQUE PER RUN AND PER CASE (DynamoDB Local persists across
 * runs): a per-run digit string is spelled into pure letters (a..j) so the
 * skeleton folds never collapse two runs' suffixes onto one row.
 */

const REQUIRE = process.env.TACENDUM_REQUIRE_DDB === '1';
const DAY = 86_400_000;
const START_MS = 1_700_000_000_000;

/** The one clock. Advancing, never pinned. */
class Clock {
  nowMs = START_MS;
  advance(ms: number): void {
    this.nowMs += ms;
  }
  get nowSeconds(): number {
    return Math.floor(this.nowMs / 1000);
  }
}

// Digits only (valid Crockford base32); '72' is this file's discriminator.
const RUN = `${Date.now()}72`;
let seq = 0;
function uid(): string {
  return `01${`${RUN}${String(++seq).padStart(4, '0')}`.padStart(24, '0')}`;
}
/** The run's letter suffix: digits → a..j, a charset the skeleton folds
 * leave alone (no i, l, r, n, v, c pairs can form), inside USERNAME_STRICT. */
const SUFFIX = RUN.split('')
  .map((d) => 'abcdefghij'[Number(d)])
  .join('');
let nameSeq = 0;
/** A per-case name family: `alice` → `alice<run><case>`; callers derive the
 * confusable siblings by substituting in the BASE (`al1ce`), so the family
 * shares one suffix and the skeleton relation the case is about. */
function family(): (base: string) => string {
  const tag = `${SUFFIX}${'abcdefghij'[nameSeq % 10]}${'abcdefghij'[Math.floor(nameSeq / 10) % 10]}`;
  nameSeq += 1;
  return (base) => `${base}${tag}`;
}

const TEST_KID = 'test-identifier-hmac-key';
const V1: IdentifierHmacKey[] = [{ version: 1, key: TEST_KID }];
/** A rotation window: v2 newest, v1 retiring. */
const V12: IdentifierHmacKey[] = [{ version: 2, key: 'test-identifier-hmac-key-v2' }, ...V1];

interface Acct {
  userId: string;
  groupId: string;
  identityKeyPub: string;
}

/** The candidate keys the handler computes for one name under one key set:
 * exact row and skeleton row, newest first (opaque-ref's walks). */
function keysFor(keys: readonly IdentifierHmacKey[], name: string) {
  const normalized = normalizeUsernameIdentifier(name);
  return {
    claimKeys: activeUsernameClaimKeys(keys, normalized),
    skeletonKeys: activeNameskelClaimKeys(keys, usernameSkeleton(normalized)),
  };
}

/** Every lifecycle verb the suite drives, over ANY DataLayer, through the
 * public surface only — the handler's own read-then-transact shape. */
function verbs(db: DataLayer) {
  return {
    /** A grouped, identifier-holding account (a claimant is grouped by
     * construction) — minted through the REAL lazy-solo attach lane. */
    async account(clock: Clock): Promise<Acct> {
      const userId = uid();
      const identityKeyPub = `idkey-un-${userId}`;
      const born = await db.getOrCreateUserByIdentityKey(identityKeyPub, userId, clock.nowMs);
      expect(born.kind).toBe('ok');
      const claimKey = emailClaimKey(1, identifierClaimHash(TEST_KID, `${userId}@example.test`));
      await db.putEmailCode({
        userId,
        purpose: 'attach',
        claimKey,
        deviceClass: 'phone',
        code: '123456',
        attempts: 0,
        createdAt: clock.nowMs,
        expiresAt: clock.nowSeconds + 300,
      });
      expect(
        await db.attachIdentifier({
          userId,
          deviceClass: 'phone',
          newGroupId: uid(),
          claimKey,
          retiringClaimKeys: [],
          nowMs: clock.nowMs,
        }),
      ).toBe('attached');
      const user = await db.getUserById(userId);
      expect(user?.groupId).toBeDefined();
      return { userId, groupId: user!.groupId!, identityKeyPub };
    },
    async refs(acct: Acct): Promise<readonly string[]> {
      const group = await db.getAccountGroup(acct.groupId);
      expect(group).toBeDefined();
      return group!.identifierRefs;
    },
    async heldRef(acct: Acct): Promise<string | undefined> {
      return (await this.refs(acct)).find((ref) => ref.startsWith(USERNAME_CLAIM_KEY_PREFIX));
    },
    async claim(
      acct: Acct,
      name: string,
      clock: Clock,
      keys: readonly IdentifierHmacKey[] = V1,
      discoverable = true,
    ) {
      const { claimKeys, skeletonKeys } = keysFor(keys, name);
      // The handler's shape (username.ts): a non-holder inside the cool-down
      // pre-reads the exact-name row at EVERY active version (the tombstone
      // may sit on a retiring one), and only its OWN live tombstone lets
      // the transaction drop the cool-down clause (`reclaimingOwn`).
      // Outside the cool-down nothing is read — so a case about an unread
      // tombstone expiring by the condition alone stays unread.
      const group = await db.getAccountGroup(acct.groupId);
      let reclaimingOwn = false;
      if (
        group?.usernameRenamedAt !== undefined &&
        group.usernameRenamedAt > clock.nowSeconds - USERNAME_RENAME_COOLDOWN_SECONDS
      ) {
        for (const key of claimKeys) {
          const standing = await db.getUsernameClaim(key, clock.nowSeconds);
          // The handler's own-tombstone test (username.ts): the group that
          // held the name, OR — since 2026-10-08 (S3) — the MEMBER whose
          // dissolving unlink left it, whose group no longer exists.
          if (
            isTombstone(standing) &&
            (standing.formerGroupId === acct.groupId || standing.formerUserId === acct.userId)
          ) {
            reclaimingOwn = true;
          }
        }
      }
      return db.claimUsername({
        userId: acct.userId,
        groupId: acct.groupId,
        refsSnapshot: await this.refs(acct),
        claimKey: claimKeys[0]!,
        skeletonKey: skeletonKeys[0]!,
        retiringClaimKeys: claimKeys.slice(1),
        retiringSkeletonKeys: skeletonKeys.slice(1),
        discoverable,
        reclaimingOwn,
        nowMs: clock.nowMs,
      });
    },
    async rename(
      acct: Acct,
      name: string,
      clock: Clock,
      keys: readonly IdentifierHmacKey[] = V1,
      discoverable = true,
    ) {
      const { claimKeys, skeletonKeys } = keysFor(keys, name);
      const oldClaimKey = await this.heldRef(acct);
      expect(oldClaimKey).toBeDefined();
      return db.renameUsername({
        userId: acct.userId,
        groupId: acct.groupId,
        refsSnapshot: await this.refs(acct),
        oldClaimKey: oldClaimKey!,
        claimKeys,
        skeletonKeys,
        discoverable,
        nowMs: clock.nowMs,
      });
    },
    async unlink(acct: Acct, clock: Clock) {
      const claimKey = await this.heldRef(acct);
      expect(claimKey).toBeDefined();
      return db.unlinkUsername({
        userId: acct.userId,
        groupId: acct.groupId,
        refsSnapshot: await this.refs(acct),
        claimKey: claimKey!,
        nowMs: clock.nowMs,
      });
    },
    /** The exact-name row as the lookup will read it (newest version). */
    async read(name: string, clock: Clock, keys: readonly IdentifierHmacKey[] = V1) {
      return db.getUsernameClaim(keysFor(keys, name).claimKeys[0]!, clock.nowSeconds);
    },
  };
}

function isTombstone(
  rec: IdentifierClaimRecord | UsernameTombstoneRecord | undefined,
): rec is UsernameTombstoneRecord {
  return rec !== undefined && 'tombstoned' in rec && rec.tombstoned === true;
}

/**
 * THE SUITE. `raw` is the store-only row reader (undefined for the twin,
 * whose rows are its maps): where it exists, the row SHAPE is pinned too —
 * a tombstone is a Put-overwrite AT the key with no groupId and no
 * plaintext, and an elapsed one is physically gone after the reaping read.
 */
function uniquenessSuite(
  label: string,
  getDb: () => DataLayer,
  gated: (name: string, fn: () => Promise<void>) => void,
  raw?: (key: string) => Promise<Record<string, unknown> | undefined>,
): void {
  describe(`${label}: the uniqueness suite (advancing clock)`, () => {
    gated('concurrent claims of ONE name → exactly one winner; the loser reads `taken`', async () => {
      const v = verbs(getDb());
      const clock = new Clock();
      const name = family()('alice');
      const [a, b] = await Promise.all([v.account(clock), v.account(clock)]);
      const results = await Promise.all([v.claim(a, name, clock), v.claim(b, name, clock)]);
      expect([...results].sort()).toEqual(['claimed', 'taken']);
      // Exactly one group holds the ref; the row names exactly that group.
      const held = await Promise.all([a, b].map((acct) => v.heldRef(acct)));
      expect(held.filter((ref) => ref !== undefined)).toHaveLength(1);
      const row = await v.read(name, clock);
      expect(isTombstone(row)).toBe(false);
      const winner = results[0] === 'claimed' ? a : b;
      expect((row as IdentifierClaimRecord).groupId).toBe(winner.groupId);
    });

    gated('the skeleton row: `al1ce`, `a_lice` are refused while `alice` stands; a distinct skeleton passes; the explicit consent bit lands on the row', async () => {
      const v = verbs(getDb());
      const clock = new Clock();
      const f = family();
      const a = await v.account(clock);
      const b = await v.account(clock);
      const c = await v.account(clock);
      expect(await v.claim(a, f('alice'), clock, V1, true)).toBe('claimed');
      expect(await v.claim(b, f('al1ce'), clock)).toBe('taken');
      expect(await v.claim(b, f('a_lice'), clock)).toBe('taken');
      // The exact row is untouched by the refused attempts…
      const live = await v.read(f('alice'), clock);
      expect(isTombstone(live)).toBe(false);
      const claim = live as IdentifierClaimRecord;
      expect(claim.groupId).toBe(a.groupId);
      expect(claim.discoverable).toBe(true);
      expect(claim.verifiedAt).toBe(clock.nowMs);
      expect(claim.skeletonKey).toBe(keysFor(V1, f('alice')).skeletonKeys[0]);
      expect(identifierClaimDiscoverable(claim, clock.nowSeconds)).toBe(true);
      // …a distinct skeleton passes (`alicia` → `allcla`), and an unchecked
      // claim is legal: held but unfindable (the row says false).
      expect(await v.claim(b, f('alicia'), clock, V1, false)).toBe('claimed');
      const unchecked = await v.read(f('alicia'), clock);
      expect((unchecked as IdentifierClaimRecord).discoverable).toBe(false);
      expect(identifierClaimDiscoverable(unchecked as IdentifierClaimRecord, clock.nowSeconds)).toBe(false);
      // The per-class one-slot cap, structural: a holder claiming again is
      // refused BEFORE any occupancy answer (the handler routes to rename).
      expect(await v.claim(a, f('bob'), clock)).toBe('identifier_cap');
      // A group that never claimed takes the third slot (email + username):
      // the cap grew to 3 with the class and the size() backstop admits it.
      expect(await v.claim(c, f('carol'), clock)).toBe('claimed');
      expect((await v.refs(c)).length).toBeLessThanOrEqual(MAX_VERIFIED_IDENTIFIERS_PER_GROUP);
      if (raw) {
        const row = await raw(keysFor(V1, f('alice')).claimKeys[0]!);
        expect(row?.kind).toBe('identifierClaim');
        expect(row?.discoverable).toBe(true);
        expect(row?.groupId).toBe(a.groupId);
        expect(JSON.stringify(row)).not.toContain(f('alice'));
        const skel = await raw(keysFor(V1, f('alice')).skeletonKeys[0]!);
        expect(skel?.kind).toBe('usernameSkeleton');
        expect(skel?.groupId).toBe(a.groupId);
        expect(skel?.claimKey).toBe(keysFor(V1, f('alice')).claimKeys[0]);
      }
    });

    gated('rotation-window conflict: a claim held under the RETIRING version refuses the newest-version claim — exact row AND skeleton row; the forward-migration moves both rows', async () => {
      const v = verbs(getDb());
      const clock = new Clock();
      const f = family();
      const a = await v.account(clock);
      const b = await v.account(clock);
      // A claims under v1 alone (pre-rotation); then the fleet rotates.
      expect(await v.claim(a, f('alice'), clock, V1)).toBe('claimed');
      expect(await v.claim(b, f('alice'), clock, V12)).toBe('taken');
      expect(await v.claim(b, f('al1ce'), clock, V12)).toBe('taken');
      expect(await v.claim(b, f('bob'), clock, V12)).toBe('claimed');
      // The v1 row still resolves (the lookup's walk reads every version)…
      const v1Row = await v.read(f('alice'), clock, V1);
      expect(isTombstone(v1Row)).toBe(false);
      // …and migrates forward WITH its skeleton, class-blind at the site.
      const { claimKeys, skeletonKeys } = keysFor(V12, f('alice'));
      await expect(
        getDb().migrateIdentifierClaimForward({
          oldClaimKey: claimKeys[1]!,
          newClaimKey: claimKeys[0]!,
          claim: v1Row as IdentifierClaimRecord,
        }),
      ).rejects.toThrow('moves with its skeleton key');
      expect(
        await getDb().migrateIdentifierClaimForward({
          oldClaimKey: claimKeys[1]!,
          newClaimKey: claimKeys[0]!,
          claim: v1Row as IdentifierClaimRecord,
          newSkeletonKey: skeletonKeys[0]!,
        }),
      ).toBe('migrated');
      const v2Row = await v.read(f('alice'), clock, V12);
      expect((v2Row as IdentifierClaimRecord).skeletonKey).toBe(skeletonKeys[0]);
      expect(await v.read(f('alice'), clock, V1)).toBeUndefined();
      expect(await v.refs(a)).toContain(claimKeys[0]);
      // Post-migration the skeleton guards under v2 — and the v1 skeleton
      // row is gone, so nothing retiring holds it either.
      expect(await v.claim(b, f('al1ce'), clock, V12)).toBe('identifier_cap');
      const c = await v.account(clock);
      expect(await v.claim(c, f('al1ce'), clock, V12)).toBe('taken');
      if (raw) {
        expect(await raw(skeletonKeys[1]!)).toBeUndefined();
        expect((await raw(skeletonKeys[0]!))?.claimKey).toBe(claimKeys[0]);
      }
    });

    gated('unlink → a 30-day former-owner tombstone on BOTH rows: the stranger is refused at 29d and admitted at 30d, the former owner reclaims early, the elapsed tombstone is reaped by the read', async () => {
      const v = verbs(getDb());
      const clock = new Clock();
      const f = family();
      const a = await v.account(clock);
      const c = await v.account(clock);
      const stranger = await v.account(clock);
      expect(await v.claim(a, f('alice'), clock)).toBe('claimed');
      expect(await v.claim(c, f('carol'), clock)).toBe('claimed');
      clock.advance(DAY);
      const unlinkedAt = clock.nowSeconds;
      expect(await v.unlink(a, clock)).toBe('unlinked');
      expect(await v.unlink(c, clock)).toBe('unlinked');
      // The refs shrank; the email ref survived by construction.
      expect(await v.heldRef(a)).toBeUndefined();
      expect((await v.refs(a)).length).toBe(1);
      // The tombstone: shape, freesAt, former owner — and NON-CONSENTED to
      // the lookup's read-time rule.
      const tomb = await v.read(f('alice'), clock);
      expect(isTombstone(tomb)).toBe(true);
      const t = tomb as UsernameTombstoneRecord;
      expect(t.freesAt).toBe(unlinkedAt + USERNAME_TOMBSTONE_TTL_SECONDS);
      expect(t.formerGroupId).toBe(a.groupId);
      expect(t.skeletonKey).toBe(keysFor(V1, f('alice')).skeletonKeys[0]);
      expect(identifierClaimDiscoverable(t, clock.nowSeconds)).toBe(false);
      if (raw) {
        const row = await raw(keysFor(V1, f('alice')).claimKeys[0]!);
        expect(row?.tombstoned).toBe(true);
        expect(row?.groupId).toBeUndefined();
        expect(row?.formerGroupId).toBe(a.groupId);
        expect(row?.freesAt).toBe(t.freesAt);
        const skel = await raw(keysFor(V1, f('alice')).skeletonKeys[0]!);
        expect(skel?.tombstoned).toBe(true);
        expect(skel?.groupId).toBeUndefined();
        expect(skel?.freesAt).toBe(t.freesAt);
      }
      // 29 days on: held against strangers — exact row AND skeleton row.
      clock.advance(29 * DAY);
      expect(await v.claim(stranger, f('alice'), clock)).toBe('taken');
      expect(await v.claim(stranger, f('al1ce'), clock)).toBe('taken');
      expect(await v.claim(stranger, f('carol'), clock)).toBe('taken');
      // The former owner reclaims EARLY (its own tombstone passes the
      // condition at both rows).
      expect(await v.claim(a, f('alice'), clock)).toBe('claimed');
      expect(isTombstone(await v.read(f('alice'), clock))).toBe(false);
      // Day 30: `carol` frees for everyone — the read reaps the elapsed
      // tombstone first, then the stranger's claim lands on a clean key.
      clock.advance(DAY);
      expect(clock.nowSeconds).toBe(t.freesAt);
      expect(await v.read(f('carol'), clock)).toBeUndefined();
      if (raw) {
        expect(await raw(keysFor(V1, f('carol')).claimKeys[0]!)).toBeUndefined();
        expect(await raw(keysFor(V1, f('carol')).skeletonKeys[0]!)).toBeUndefined();
      }
      expect(await v.claim(stranger, f('carol'), clock)).toBe('claimed');
      // …while `alice`, re-held live by A, stays refused.
      const late = await v.account(clock);
      expect(await v.claim(late, f('alice'), clock)).toBe('taken');
      // And a tombstone need not be read to expire: `carol`'s twin case —
      // C unlinked `carol`; a name whose tombstone nobody read is still
      // free to a stranger at day 30 through the condition alone.
      const d = await v.account(clock);
      expect(await v.claim(d, f('dave'), clock)).toBe('claimed');
      expect(await v.unlink(d, clock)).toBe('unlinked');
      clock.advance(USERNAME_TOMBSTONE_TTL_SECONDS * 1000);
      expect(await v.claim(late, f('dave'), clock)).toBe('claimed');
    });

    gated('tombstone on a RETIRING version (corrected): the former owner reclaims under the newest version through its own tombstone; a stranger is held for 30 days and admitted after', async () => {
      const v = verbs(getDb());
      const clock = new Clock();
      const f = family();
      const a = await v.account(clock);
      const c = await v.account(clock);
      const b = await v.account(clock);
      expect(await v.claim(a, f('alice'), clock, V1)).toBe('claimed');
      expect(await v.claim(c, f('carol'), clock, V1)).toBe('claimed');
      clock.advance(DAY);
      expect(await v.unlink(a, clock)).toBe('unlinked');
      expect(await v.unlink(c, clock)).toBe('unlinked');
      // The fleet rotates: both tombstones now sit on the RETIRING version.
      clock.advance(DAY);
      expect(await v.claim(b, f('alice'), clock, V12)).toBe('taken');
      expect(await v.claim(b, f('al1ce'), clock, V12)).toBe('taken');
      // Plain-ABSENT retiring checks would refuse A here for the whole key-
      // retirement window; the tombstone-aware check lets its owner through.
      expect(await v.claim(a, f('alice'), clock, V12)).toBe('claimed');
      expect(isTombstone(await v.read(f('alice'), clock, V12))).toBe(false);
      // The stranger waits out `carol`'s window, then passes the retiring
      // check on its elapsed tombstone.
      clock.advance(28 * DAY);
      expect(await v.claim(b, f('carol'), clock, V12)).toBe('taken');
      clock.advance(DAY);
      expect(await v.claim(b, f('carol'), clock, V12)).toBe('claimed');
    });

    gated('rename: the five-item transaction — old rows tombstoned former-owner, new rows born with the explicit bit, ref re-pointed; cool-down refused at 29d, accepted at 30d, consumed on SUCCESS only', async () => {
      const v = verbs(getDb());
      const clock = new Clock();
      const f = family();
      const a = await v.account(clock);
      const b = await v.account(clock);
      expect(await v.claim(a, f('alice'), clock, V1, true)).toBe('claimed');
      clock.advance(DAY);
      const renamedAt = clock.nowSeconds;
      // The first rename: no cool-down stands yet.
      expect(await v.rename(a, f('bob'), clock, V1, false)).toBe('renamed');
      const old = await v.read(f('alice'), clock);
      expect(isTombstone(old)).toBe(true);
      expect((old as UsernameTombstoneRecord).formerGroupId).toBe(a.groupId);
      expect((old as UsernameTombstoneRecord).freesAt).toBe(renamedAt + USERNAME_TOMBSTONE_TTL_SECONDS);
      const now = await v.read(f('bob'), clock);
      expect(isTombstone(now)).toBe(false);
      expect((now as IdentifierClaimRecord).discoverable).toBe(false);
      expect((now as IdentifierClaimRecord).groupId).toBe(a.groupId);
      expect(await v.heldRef(a)).toBe(keysFor(V1, f('bob')).claimKeys[0]);
      expect(await v.refs(a)).not.toContain(keysFor(V1, f('alice')).claimKeys[0]);
      expect((await getDb().getAccountGroup(a.groupId))?.usernameRenamedAt).toBe(renamedAt);
      // The freed name is held against strangers (both rows)…
      expect(await v.claim(b, f('alice'), clock)).toBe('taken');
      expect(await v.claim(b, f('a1ice'), clock)).toBe('taken');
      // …and the new name's skeleton guards too.
      expect(await v.claim(b, f('b0b'), clock)).toBe('taken');
      // 29 days: the cool-down refuses, and consumes NOTHING.
      clock.advance(29 * DAY);
      expect(await v.rename(a, f('carol'), clock)).toBe('cooldown');
      expect((await getDb().getAccountGroup(a.groupId))?.usernameRenamedAt).toBe(renamedAt);
      expect(await v.heldRef(a)).toBe(keysFor(V1, f('bob')).claimKeys[0]);
      // Day 30 exactly: accepted, and the stamp moves.
      clock.advance(DAY);
      expect(clock.nowSeconds - renamedAt).toBe(USERNAME_RENAME_COOLDOWN_SECONDS);
      expect(await v.rename(a, f('carol'), clock)).toBe('renamed');
      const secondRenamedAt = clock.nowSeconds;
      expect((await getDb().getAccountGroup(a.groupId))?.usernameRenamedAt).toBe(secondRenamedAt);
      expect(await v.rename(a, f('dave'), clock)).toBe('cooldown');
      // A FAILED rename never consumes the cool-down: at the next window,
      // `taken` (B holds `erin`) is followed by a rename that succeeds.
      expect(await v.claim(b, f('erin'), clock)).toBe('claimed');
      clock.advance(USERNAME_RENAME_COOLDOWN_SECONDS * 1000);
      expect(await v.rename(a, f('erin'), clock)).toBe('taken');
      expect((await getDb().getAccountGroup(a.groupId))?.usernameRenamedAt).toBe(secondRenamedAt);
      expect(await v.rename(a, f('frank'), clock)).toBe('renamed');
      // The held name is a no-op rename, never a transaction, never a stamp.
      const third = clock.nowSeconds;
      clock.advance(USERNAME_RENAME_COOLDOWN_SECONDS * 1000);
      expect(await v.rename(a, f('frank'), clock)).toBe('same_name');
      expect((await getDb().getAccountGroup(a.groupId))?.usernameRenamedAt).toBe(third);
      // The former-owner right after an unlink: A unlinks `frank` — the
      // stamp moves, an unlink IS a name change — and takes `frank` back at
      // once through its own tombstone (a claim, not a rename). `carol`,
      // renamed away 30 days ago and elapsed, is a claim of ANOTHER name
      // inside the fresh cool-down: refused, nothing minted.
      expect(await v.unlink(a, clock)).toBe('unlinked');
      const unlinkedAt = clock.nowSeconds;
      expect((await getDb().getAccountGroup(a.groupId))?.usernameRenamedAt).toBe(unlinkedAt);
      expect(await v.claim(a, f('carol'), clock)).toBe('cooldown');
      expect(await v.read(f('carol'), clock)).toBeUndefined();
      expect(await v.claim(a, f('frank'), clock)).toBe('claimed');
      expect((await getDb().getAccountGroup(a.groupId))?.usernameRenamedAt).toBe(unlinkedAt);
      expect(await v.claim(b, f('frank'), clock)).toBe('identifier_cap');
      const c = await v.account(clock);
      expect(await v.claim(c, f('frank'), clock)).toBe('taken');
      if (raw) {
        // The old skeleton row is a tombstone AT its key, not a deletion.
        const skel = await raw(keysFor(V1, f('bob')).skeletonKeys[0]!);
        expect(skel?.kind).toBe('usernameSkeleton');
        expect(skel?.tombstoned).toBe(true);
        expect(skel?.formerGroupId).toBe(a.groupId);
      }
    });

    gated('UNLINK IS A NAME CHANGE (the anti-hoarding rule): the unlink stamps the cool-down; claim → unlink → claim-ANOTHER is `cooldown` at 29 d (nothing minted, nothing consumed) and admitted at 30 d; claim → unlink → reclaim-the-SAME is admitted at 1 d; unlink-then-reclaim launders no cool-down; a claim never stamps', async () => {
      const v = verbs(getDb());
      const clock = new Clock();
      const f = family();
      const a = await v.account(clock);
      const b = await v.account(clock);
      const stranger = await v.account(clock);
      const stampOf = async () => (await getDb().getAccountGroup(a.groupId))?.usernameRenamedAt;
      expect(await v.claim(a, f('alice'), clock)).toBe('claimed');
      // A first name is not a change of name: no stamp.
      expect(await stampOf()).toBeUndefined();
      // T0 + 1 d: the unlink stamps.
      clock.advance(DAY);
      const firstUnlink = clock.nowSeconds;
      expect(await v.unlink(a, clock)).toBe('unlinked');
      expect(await stampOf()).toBe(firstUnlink);
      // THE HOARD, refused: another name inside the window is `cooldown` —
      // the group's refs and stamp untouched, NO tombstone minted for it.
      expect(await v.claim(a, f('bob'), clock)).toBe('cooldown');
      expect(await v.heldRef(a)).toBeUndefined();
      expect(await stampOf()).toBe(firstUnlink);
      expect(await v.read(f('bob'), clock)).toBeUndefined();
      // `bob` was free all along — B takes it — so the refusal above was the
      // caller's cool-down, never occupancy.
      expect(await v.claim(b, f('bob'), clock)).toBe('claimed');
      // The SAME name back at 1 d: A's own live tombstone at the exact row
      // admits the reclaim; a claim never stamps.
      expect(await v.claim(a, f('alice'), clock)).toBe('claimed');
      expect(isTombstone(await v.read(f('alice'), clock))).toBe(false);
      expect(await stampOf()).toBe(firstUnlink);
      // …and the unlink+reclaim laundered nothing: a rename inside the
      // window is still the cool-down.
      expect(await v.rename(a, f('carol'), clock)).toBe('cooldown');
      // T0 + 2 d: unlink again (the stamp moves), and the window runs from
      // THIS unlink: 29 d on, another name is still refused and `alice` is
      // still held against a stranger; at 30 d both free.
      clock.advance(DAY);
      const secondUnlink = clock.nowSeconds;
      expect(await v.unlink(a, clock)).toBe('unlinked');
      expect(await stampOf()).toBe(secondUnlink);
      clock.advance(29 * DAY);
      expect(await v.claim(a, f('carol'), clock)).toBe('cooldown');
      expect(await v.claim(stranger, f('alice'), clock)).toBe('taken');
      clock.advance(DAY);
      expect(clock.nowSeconds - secondUnlink).toBe(USERNAME_RENAME_COOLDOWN_SECONDS);
      expect(await v.claim(a, f('carol'), clock)).toBe('claimed');
      // The claim did not stamp: a rename right after it is admitted (the
      // cool-down that stands is the second unlink's, elapsed).
      expect(await stampOf()).toBe(secondUnlink);
      expect(await v.rename(a, f('dave'), clock)).toBe('renamed');
      expect(await stampOf()).toBe(clock.nowSeconds);
      // `alice`'s tombstone elapsed with the window: free to the stranger.
      expect(await v.claim(stranger, f('alice'), clock)).toBe('claimed');
    });

    gated('twin-vs-store parity (a): a live username row WITHOUT its skeleton key — constructible only through the class-blind migrate — throws the same error from unlink, rename, and revoke on both DataLayers, never a silent half-tombstone', async () => {
      const db = getDb();
      const v = verbs(db);
      const clock = new Clock();
      const f = family();
      const a = await v.account(clock);
      expect(await v.claim(a, f('alice'), clock, V1)).toBe('claimed');
      const { claimKeys } = keysFor(V12, f('alice'));
      const v1Row = (await v.read(f('alice'), clock, V1)) as IdentifierClaimRecord;
      // The drift: a caller migrating a record it stripped of `skeletonKey`
      // (the migrate throw guards only a record that CARRIES one).
      const { skeletonKey: _dropped, ...stripped } = v1Row;
      expect(
        await db.migrateIdentifierClaimForward({
          oldClaimKey: claimKeys[1]!,
          newClaimKey: claimKeys[0]!,
          claim: stripped,
        }),
      ).toBe('migrated');
      const refs = await v.refs(a);
      expect(refs).toContain(claimKeys[0]);
      const drifted = 'live row carries no skeleton key';
      await expect(
        db.unlinkUsername({
          userId: a.userId,
          groupId: a.groupId,
          refsSnapshot: refs,
          claimKey: claimKeys[0]!,
          nowMs: clock.nowMs,
        }),
      ).rejects.toThrow(drifted);
      const target = keysFor(V12, f('bob'));
      await expect(
        db.renameUsername({
          userId: a.userId,
          groupId: a.groupId,
          refsSnapshot: refs,
          oldClaimKey: claimKeys[0]!,
          claimKeys: target.claimKeys,
          skeletonKeys: target.skeletonKeys,
          discoverable: true,
          nowMs: clock.nowMs,
        }),
      ).rejects.toThrow(drifted);
      await expect(db.revokeUsername({ claimKey: claimKeys[0]!, nowMs: clock.nowMs })).rejects.toThrow(
        drifted,
      );
      // Loud AND untouched: the ref and the live row stand, nothing tombstoned.
      expect(await v.refs(a)).toEqual(refs);
      expect(isTombstone(await v.read(f('alice'), clock, V12))).toBe(false);
    });

    gated('twin-vs-store parity (b): the forward-migration no-ops on a TOMBSTONE at the newest claim key OR the newest skeleton key exactly as on a live row (`attribute_not_exists`), and lands once the reaping read has taken it', async () => {
      const db = getDb();
      const v = verbs(db);
      const clock = new Clock();
      const f = family();
      // A container that knows only v2 — the mixed-fleet residual —
      // is how a second group's rows land under the newest version beside
      // a first group's retiring-version claim.
      const V2ONLY: IdentifierHmacKey[] = [V12[0]!];
      const a = await v.account(clock);
      const b = await v.account(clock);
      const d = await v.account(clock);
      const e = await v.account(clock);
      expect(await v.claim(a, f('alice'), clock, V1)).toBe('claimed');
      expect(await v.claim(b, f('alice'), clock, V2ONLY)).toBe('claimed');
      expect(await v.claim(d, f('dave'), clock, V1)).toBe('claimed');
      // `d4ve` folds to `dave`: E's unlink leaves a tombstone at the newest
      // SKELETON key alone (its exact row is another name's).
      expect(await v.claim(e, f('d4ve'), clock, V2ONLY)).toBe('claimed');
      clock.advance(DAY);
      expect(await v.unlink(b, clock)).toBe('unlinked');
      expect(await v.unlink(e, clock)).toBe('unlinked');
      const alice = keysFor(V12, f('alice'));
      const dave = keysFor(V12, f('dave'));
      expect(isTombstone(await v.read(f('alice'), clock, V12))).toBe(true);
      expect(await v.read(f('dave'), clock, V12)).toBeUndefined();
      const migrate = async (name: string, keys: ReturnType<typeof keysFor>) =>
        db.migrateIdentifierClaimForward({
          oldClaimKey: keys.claimKeys[1]!,
          newClaimKey: keys.claimKeys[0]!,
          claim: (await v.read(name, clock, V1)) as IdentifierClaimRecord,
          newSkeletonKey: keys.skeletonKeys[0]!,
        });
      expect(await migrate(f('alice'), alice)).toBe('noop');
      expect(await migrate(f('dave'), dave)).toBe('noop');
      // Nothing moved: the refs still name the v1 keys, the v1 rows resolve.
      expect(await v.refs(a)).toContain(alice.claimKeys[1]);
      expect(await v.refs(d)).toContain(dave.claimKeys[1]);
      expect(isTombstone(await v.read(f('alice'), clock, V1))).toBe(false);
      expect(isTombstone(await v.read(f('dave'), clock, V1))).toBe(false);
      if (raw) {
        expect((await raw(alice.claimKeys[0]!))?.tombstoned).toBe(true);
        expect((await raw(dave.skeletonKeys[0]!))?.tombstoned).toBe(true);
      }
      // 30 d on: the reaping reads take the tombstones (the `alice` claim
      // tombstone remembers its skeleton twin; `d4ve`'s does likewise), and
      // the migrations land with both rows under v2.
      clock.advance(USERNAME_TOMBSTONE_TTL_SECONDS * 1000);
      expect(await v.read(f('alice'), clock, V12)).toBeUndefined();
      expect(await v.read(f('d4ve'), clock, V12)).toBeUndefined();
      expect(await migrate(f('alice'), alice)).toBe('migrated');
      expect(await migrate(f('dave'), dave)).toBe('migrated');
      expect(await v.refs(a)).toContain(alice.claimKeys[0]);
      expect(await v.refs(d)).toContain(dave.claimKeys[0]);
      expect((await v.read(f('alice'), clock, V12) as IdentifierClaimRecord).skeletonKey).toBe(alice.skeletonKeys[0]);
      expect((await v.read(f('dave'), clock, V12) as IdentifierClaimRecord).skeletonKey).toBe(dave.skeletonKeys[0]);
      expect(await v.read(f('alice'), clock, V1)).toBeUndefined();
    });

    gated('rename to a SAME-SKELETON name (`alice` → `al1ce`): the one skeleton row is re-pointed, never tombstoned-and-reborn in one transaction', async () => {
      const v = verbs(getDb());
      const clock = new Clock();
      const f = family();
      const a = await v.account(clock);
      const b = await v.account(clock);
      expect(await v.claim(a, f('alice'), clock)).toBe('claimed');
      clock.advance(DAY);
      expect(await v.rename(a, f('al1ce'), clock)).toBe('renamed');
      const held = await v.read(f('al1ce'), clock);
      expect(isTombstone(held)).toBe(false);
      // The shared skeleton row still stands, now pointing at the new claim.
      expect((held as IdentifierClaimRecord).skeletonKey).toBe(keysFor(V1, f('alice')).skeletonKeys[0]);
      expect(await v.claim(b, f('alice'), clock)).toBe('taken');
      expect(await v.claim(b, f('a1ice'), clock)).toBe('taken');
      // The old exact-name tombstone carries NO skeleton pointer (the
      // skeleton is live), so the reaping read never touches it.
      const old = await v.read(f('alice'), clock);
      expect(isTombstone(old)).toBe(true);
      expect((old as UsernameTombstoneRecord).skeletonKey).toBeUndefined();
      clock.advance(USERNAME_TOMBSTONE_TTL_SECONDS * 1000);
      expect(await v.read(f('alice'), clock)).toBeUndefined();
      expect(await v.claim(b, f('alice'), clock)).toBe('taken');
      if (raw) {
        const skel = await raw(keysFor(V1, f('alice')).skeletonKeys[0]!);
        expect(skel?.tombstoned).toBeUndefined();
        expect(skel?.claimKey).toBe(keysFor(V1, f('al1ce')).claimKeys[0]);
      }
    });

    gated('the deletion sweep: a last member\'s exit (deleteGroupedUser, unlinkDeviceFromGroup, the solo purge) tombstones the name NOBODY-reclaims — held 30 days against everyone, then free', async () => {
      const db = getDb();
      const v = verbs(db);
      const clock = new Clock();
      const f = family();
      const stranger = await v.account(clock);
      // (1) Account deletion of the sole member.
      const a = await v.account(clock);
      expect(await v.claim(a, f('alice'), clock)).toBe('claimed');
      clock.advance(DAY);
      const deletedAt = clock.nowSeconds;
      expect(
        await db.deleteGroupedUser(a.userId, a.groupId, { identityKeyPub: a.identityKeyPub }, clock.nowMs),
      ).toBe('deleted');
      expect(await db.getAccountGroup(a.groupId)).toBeUndefined();
      const tomb = await v.read(f('alice'), clock);
      expect(isTombstone(tomb)).toBe(true);
      expect((tomb as UsernameTombstoneRecord).formerGroupId).toBeUndefined();
      expect((tomb as UsernameTombstoneRecord).freesAt).toBe(deletedAt + USERNAME_TOMBSTONE_TTL_SECONDS);
      if (raw) {
        const row = await raw(keysFor(V1, f('alice')).claimKeys[0]!);
        expect(row?.tombstoned).toBe(true);
        expect(row?.formerGroupId).toBeUndefined();
        expect(JSON.stringify(row)).not.toContain(a.groupId);
        expect((await raw(keysFor(V1, f('alice')).skeletonKeys[0]!))?.tombstoned).toBe(true);
      }
      // (2) The last member's roster exit.
      const d = await v.account(clock);
      expect(await v.claim(d, f('dave'), clock)).toBe('claimed');
      const group = await db.getAccountGroup(d.groupId);
      expect(
        await db.unlinkDeviceFromGroup({
          groupId: d.groupId,
          actingUserId: d.userId,
          targetUserId: d.userId,
          rosterEpoch: group!.epoch,
          nowMs: clock.nowMs,
        }),
      ).toBe('unlinked');
      expect(isTombstone(await v.read(f('dave'), clock))).toBe(true);
      expect((await v.read(f('dave'), clock) as UsernameTombstoneRecord).formerGroupId).toBeUndefined();
      // (3) The solo purge (the sweep's sole-member group branch).
      const c = await v.account(clock);
      expect(await v.claim(c, f('carol'), clock)).toBe('claimed');
      await db.purgeIdentifierArtifactsForUser(c.userId, { groupId: c.groupId }, clock.nowMs);
      expect(await db.getAccountGroup(c.groupId)).toBeUndefined();
      expect(isTombstone(await v.read(f('carol'), clock))).toBe(true);
      // Held against EVERYONE for 30 days — no former owner exists.
      clock.advance(29 * DAY);
      for (const name of ['alice', 'al1ce', 'dave', 'carol']) {
        expect(await v.claim(stranger, f(name), clock), name).toBe('taken');
      }
      clock.advance(DAY);
      expect(await v.claim(stranger, f('alice'), clock)).toBe('claimed');
      const other = await v.account(clock);
      expect(await v.claim(other, f('dave'), clock)).toBe('claimed');
    });

    gated('operator revocation (data primitive): nobody reclaims — the revoked holder is refused before 30 days, its slot reopens at once, everyone is admitted after; a dead key answers `gone`', async () => {
      const db = getDb();
      const v = verbs(db);
      const clock = new Clock();
      const f = family();
      const a = await v.account(clock);
      const b = await v.account(clock);
      expect(await v.claim(a, f('alice'), clock)).toBe('claimed');
      const claimKey = keysFor(V1, f('alice')).claimKeys[0]!;
      clock.advance(DAY);
      const revokedAt = clock.nowSeconds;
      // The commit answers the holder's groupId — what the ops lane fans the
      // usernameRevoked notice to — and nothing else about the holder.
      expect(await db.revokeUsername({ claimKey, nowMs: clock.nowMs })).toEqual({
        outcome: 'revoked',
        groupId: a.groupId,
      });
      expect(await db.revokeUsername({ claimKey, nowMs: clock.nowMs })).toEqual({ outcome: 'gone' });
      // Detached the NAME only: the email ref and the group survive.
      expect(await v.heldRef(a)).toBeUndefined();
      expect((await v.refs(a)).length).toBe(1);
      expect(await db.getAccountGroup(a.groupId)).toBeDefined();
      const tomb = await v.read(f('alice'), clock);
      expect(isTombstone(tomb)).toBe(true);
      expect((tomb as UsernameTombstoneRecord).formerGroupId).toBeUndefined();
      expect((tomb as UsernameTombstoneRecord).freesAt).toBe(revokedAt + USERNAME_TOMBSTONE_TTL_SECONDS);
      // The revoked holder does NOT reclaim early; its slot is free for a
      // different name at once.
      expect(await v.claim(a, f('alice'), clock)).toBe('taken');
      expect(await v.claim(a, f('al1ce'), clock)).toBe('taken');
      expect(await v.claim(a, f('bob'), clock)).toBe('claimed');
      clock.advance(29 * DAY);
      expect(await v.claim(b, f('alice'), clock)).toBe('taken');
      clock.advance(DAY);
      expect(await v.claim(b, f('alice'), clock)).toBe('claimed');
      if (raw) {
        expect((await raw(claimKey))?.groupId).toBe(b.groupId);
      }
    });

    gated('the claim row is never a user (CLAIM_PREFIXES): both prefixes are guarded, and getUserById refuses them', async () => {
      const db = getDb();
      const v = verbs(db);
      const clock = new Clock();
      const f = family();
      const a = await v.account(clock);
      expect(await v.claim(a, f('alice'), clock)).toBe('claimed');
      const { claimKeys, skeletonKeys } = keysFor(V1, f('alice'));
      expect(claimKeys[0]!.startsWith(USERNAME_CLAIM_KEY_PREFIX)).toBe(true);
      expect(skeletonKeys[0]!.startsWith(NAMESKEL_CLAIM_KEY_PREFIX)).toBe(true);
      expect(isClaimKey(claimKeys[0]!)).toBe(true);
      expect(isClaimKey(skeletonKeys[0]!)).toBe(true);
      expect(await db.getUserById(claimKeys[0]!)).toBeUndefined();
      expect(await db.getUserById(skeletonKeys[0]!)).toBeUndefined();
      // The class-general read answers absent for a tombstone: the username
      // class reads its own rows through getUsernameClaim.
      expect(await v.unlink(a, clock)).toBe('unlinked');
      expect(await db.getIdentifierClaim(claimKeys[0]!)).toBeUndefined();
      expect(isTombstone(await v.read(f('alice'), clock))).toBe(true);
    });

    gated('the take-back survives the dissolving unlink (field report 2026-10-08, S3): a one-device attach-created account whose LAST identifier is its username — the dissolving unlink writes the former MEMBER on both tombstones (no dangling group id); a stranger is `taken` at 29 d; the former owner, verified again into a FRESH group, reclaims at once — inside that group\'s own cool-down too — exactly what the unlink confirmation promises', async () => {
      // BOTH DataLayers (the 2026-10-08 integrate pass landed the helpers.ts
      // mirror of the store's fourth condition arm and of the dissolving
      // unlink's `formerUserId`). The store is the authority the twin must
      // never out-permit — and once the rule is ruled, a twin that stayed
      // LESS permissive would refuse the take-back every store-blind suite
      // proves the handler's walk admits, hiding a handler regression there.
      const db = getDb();
      const v = verbs(db);
      const clock = new Clock();
      const f = family();
      const a = await v.account(clock);
      expect(await v.claim(a, f('alice'), clock)).toBe('claimed');
      const { claimKeys, skeletonKeys } = keysFor(V1, f('alice'));

      // The email leaves first — the group survives on the name alone.
      const refs = await v.refs(a);
      const emailRefs = refs.filter((ref) => !ref.startsWith(USERNAME_CLAIM_KEY_PREFIX));
      expect(emailRefs).toHaveLength(1);
      expect(
        await db.unlinkIdentifierClass({
          userId: a.userId,
          groupId: a.groupId,
          refsSnapshot: refs,
          claimKeys: emailRefs,
        }),
      ).toBe('unlinked');
      expect(await v.refs(a)).toEqual([claimKeys[0]]);

      // Then the name — the LAST identifier — and the lazy-solo group dissolves.
      clock.advance(DAY);
      expect(await v.unlink(a, clock)).toBe('unlinked');
      const unlinkedAt = clock.nowSeconds;
      expect(await db.getAccountGroup(a.groupId)).toBeUndefined();
      expect((await db.getUserById(a.userId))?.groupId).toBeUndefined();

      // The tombstones: the former MEMBER on both rows, no group id at all —
      // the group that could reclaim died in the same transaction, so nothing
      // dangles, and the right moved to the person who can still exercise it.
      const tomb = await v.read(f('alice'), clock);
      expect(isTombstone(tomb)).toBe(true);
      expect((tomb as UsernameTombstoneRecord).formerUserId).toBe(a.userId);
      expect((tomb as UsernameTombstoneRecord).formerGroupId).toBeUndefined();
      expect((tomb as UsernameTombstoneRecord).freesAt).toBe(unlinkedAt + USERNAME_TOMBSTONE_TTL_SECONDS);
      // (The skeleton row's tombstone is not read here: `getUsernameClaim`
      // answers only `kind = identifierClaim` rows on the store. Its member
      // is proved below instead — the reclaim walks BOTH keys through the
      // condition, so a skeleton tombstone without the member would answer
      // `taken`.)
      if (raw) {
        // The row SHAPE (store only): a tombstone AT both keys, the member on
        // each, no group id, no plaintext.
        const claimRow = await raw(claimKeys[0]!);
        expect(claimRow?.tombstoned).toBe(true);
        expect(claimRow?.formerUserId).toBe(a.userId);
        expect(claimRow?.formerGroupId).toBeUndefined();
        expect(claimRow?.groupId).toBeUndefined();
        const skeletonRow = await raw(skeletonKeys[0]!);
        expect(skeletonRow?.tombstoned).toBe(true);
        expect(skeletonRow?.formerUserId).toBe(a.userId);
        expect(skeletonRow?.formerGroupId).toBeUndefined();
      }

      // A stranger is refused the name for the window (one bit: `taken`).
      const c = await v.account(clock);
      clock.advance(DAY);
      expect(await v.claim(c, f('alice'), clock)).toBe('taken');

      // The former owner verifies again: a NEW lazy-solo group for the SAME
      // member (the lazy-attach recipe `account()` runs, on an existing row).
      const again = emailClaimKey(1, identifierClaimHash(TEST_KID, `${a.userId}-again@example.test`));
      await db.putEmailCode({
        userId: a.userId,
        purpose: 'attach',
        claimKey: again,
        deviceClass: 'phone',
        code: '123456',
        attempts: 0,
        createdAt: clock.nowMs,
        expiresAt: clock.nowSeconds + 300,
      });
      // THE WINDOW SURVIVES THE GROUP (the 2026-10-08 gate pass, re-cutting
      // this case's own earlier pin — `bob` used to be `claimed` here): the
      // dissolving unlink carried its stamp onto the member's user row, and
      // the verify handler hands a still-running stamp to the lazy-solo
      // attach, which copies it onto the group it mints — exactly as the
      // `discoverableAfter` carrier rides. Without the carry every name the
      // person ever held stayed reserved for them while a DIFFERENT name was
      // admitted at once from each fresh group: hoarding, one code per name.
      const carried = (await db.getUserById(a.userId))?.usernameRenamedAt;
      expect(carried).toBe(unlinkedAt);
      expect(
        await db.attachIdentifier({
          userId: a.userId,
          deviceClass: 'phone',
          newGroupId: uid(),
          claimKey: again,
          retiringClaimKeys: [],
          nowMs: clock.nowMs,
          // The handler's own spelling (`carriedUsernameCooldown`): the stamp
          // rides only when the row holds one. Under exactOptionalPropertyTypes
          // an explicit undefined is not an absent key, and the assertion above
          // has just pinned the value that rides here.
          ...(carried !== undefined ? { usernameRenamedAt: carried } : {}),
        }),
      ).toBe('attached');
      const a2: Acct = { ...a, groupId: (await db.getUserById(a.userId))!.groupId! };
      expect(a2.groupId).not.toBe(a.groupId);
      expect((await db.getAccountGroup(a2.groupId))?.usernameRenamedAt).toBe(unlinkedAt);

      // Inside the CARRIED window: another name is `cooldown` (refused by
      // the group condition, nothing consumed) and the own former name is
      // admitted: the walk sees the member, the condition admits by
      // `formerUserId`, and the cool-down clause is dropped for the reclaim.
      // (All inside `alice`'s 30-day tombstone window: the walk reads a LIVE
      // tombstone; an elapsed one would be a plain free name.)
      clock.advance(3_600_000);
      expect(await v.claim(a2, f('bob'), clock)).toBe('cooldown');
      expect(await v.claim(a2, f('carol'), clock)).toBe('cooldown');
      expect(await v.heldRef(a2)).toBeUndefined();
      expect(isTombstone(await v.read(f('alice'), clock))).toBe(true);
      expect(await v.claim(a2, f('alice'), clock)).toBe('claimed');
      expect(await v.heldRef(a2)).toBe(claimKeys[0]);
      const live = await v.read(f('alice'), clock);
      expect(isTombstone(live)).toBe(false);
      expect((live as IdentifierClaimRecord).groupId).toBe(a2.groupId);
      if (raw) {
        // The reclaim overwrote both tombstones: the skeleton row is live
        // again and names the new group.
        expect((await raw(skeletonKeys[0]!))?.groupId).toBe(a2.groupId);
        expect((await raw(skeletonKeys[0]!))?.tombstoned).toBeUndefined();
      }
    });

    gated('the take-back survives the OTHER order (gate pass 2026-10-08): the name leaves first — its tombstones name the group AND the member — then the email dissolves the group: the stamp moves onto the member, a stranger is `taken`, and the former owner reclaims from a fresh group that inherited the window (a different name is `cooldown` there)', async () => {
      const db = getDb();
      const v = verbs(db);
      const clock = new Clock();
      const f = family();
      const a = await v.account(clock);
      expect(await v.claim(a, f('alice'), clock)).toBe('claimed');
      const { claimKeys, skeletonKeys } = keysFor(V1, f('alice'));

      // The name leaves first: the group survives on the email, stamped,
      // and BOTH owners stand on both tombstones (the surviving-unlink
      // shape since the gate pass; the group alone before it).
      clock.advance(DAY);
      expect(await v.unlink(a, clock)).toBe('unlinked');
      const unlinkedAt = clock.nowSeconds;
      expect((await db.getAccountGroup(a.groupId))?.usernameRenamedAt).toBe(unlinkedAt);
      const tomb = await v.read(f('alice'), clock);
      expect(isTombstone(tomb)).toBe(true);
      expect((tomb as UsernameTombstoneRecord).formerGroupId).toBe(a.groupId);
      expect((tomb as UsernameTombstoneRecord).formerUserId).toBe(a.userId);
      if (raw) {
        expect((await raw(skeletonKeys[0]!))?.formerGroupId).toBe(a.groupId);
        expect((await raw(skeletonKeys[0]!))?.formerUserId).toBe(a.userId);
      }

      // Then the email — the LAST identifier — and the lazy-solo group
      // dissolves: the stamp it carried moves onto the member.
      const refs = await v.refs(a);
      expect(
        await db.unlinkIdentifierClass({
          userId: a.userId,
          groupId: a.groupId,
          refsSnapshot: refs,
          claimKeys: [...refs],
        }),
      ).toBe('unlinked');
      expect(await db.getAccountGroup(a.groupId)).toBeUndefined();
      expect((await db.getUserById(a.userId))?.groupId).toBeUndefined();
      expect((await db.getUserById(a.userId))?.usernameRenamedAt).toBe(unlinkedAt);

      // A stranger is refused the name for the window.
      const c = await v.account(clock);
      clock.advance(DAY);
      expect(await v.claim(c, f('alice'), clock)).toBe('taken');

      // The former owner verifies again, the handler's carry in hand: the
      // fresh group inherits the window, a different name waits, the own
      // name comes straight back.
      const again = emailClaimKey(1, identifierClaimHash(TEST_KID, `${a.userId}-again@example.test`));
      await db.putEmailCode({
        userId: a.userId,
        purpose: 'attach',
        claimKey: again,
        deviceClass: 'phone',
        code: '123456',
        attempts: 0,
        createdAt: clock.nowMs,
        expiresAt: clock.nowSeconds + 300,
      });
      // The stamp the dissolve moved onto the member is what the handler
      // carries (`carriedUsernameCooldown`'s spelling: present only when the
      // row holds one — an explicit undefined is not an absent key under
      // exactOptionalPropertyTypes).
      const carried = (await db.getUserById(a.userId))?.usernameRenamedAt;
      expect(carried).toBe(unlinkedAt);
      expect(
        await db.attachIdentifier({
          userId: a.userId,
          deviceClass: 'phone',
          newGroupId: uid(),
          claimKey: again,
          retiringClaimKeys: [],
          nowMs: clock.nowMs,
          ...(carried !== undefined ? { usernameRenamedAt: carried } : {}),
        }),
      ).toBe('attached');
      const a2: Acct = { ...a, groupId: (await db.getUserById(a.userId))!.groupId! };
      expect((await db.getAccountGroup(a2.groupId))?.usernameRenamedAt).toBe(unlinkedAt);
      expect(await v.claim(a2, f('bob'), clock)).toBe('cooldown');
      expect(await v.claim(a2, f('alice'), clock)).toBe('claimed');
      expect(await v.heldRef(a2)).toBe(claimKeys[0]);
      const live = await v.read(f('alice'), clock);
      expect(isTombstone(live)).toBe(false);
      expect((live as IdentifierClaimRecord).groupId).toBe(a2.groupId);
      // Past the carried window a different name is free again.
      clock.advance(30 * DAY);
      expect(await v.rename(a2, f('bob'), clock)).toBe('renamed');
    });
  });
}

// --- The memory twin: unconditional. ---
let memDb: DataLayer;
beforeAll(() => {
  memDb = makeMemoryDb();
});
uniquenessSuite('memory twin', () => memDb, (name, fn) => it(name, fn));

// --- DynamoDB Local: gated exactly as the accounts-* suites gate. ---
let doc: DynamoDBDocumentClient;
let ddb: DataLayer;
let available = false;

beforeAll(async () => {
  const client = makeDynamoClient();
  doc = makeDocClient(client);
  ddb = makeDataLayer(doc);
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

function gatedDdb(name: string, fn: () => Promise<void>): void {
  it(name, async (ctx) => {
    if (!available) return ctx.skip();
    await fn();
  });
}

async function rawRow(key: string): Promise<Record<string, unknown> | undefined> {
  const res = await doc.send(
    new GetCommand({ TableName: TABLES.users, Key: { userId: key }, ConsistentRead: true }),
  );
  return res.Item;
}

uniquenessSuite('DynamoDB Local', () => ddb, gatedDdb, rawRow);

describe('the lookup-facing predicate: a tombstone is non-consented through the ONE read-time rule', () => {
  it('identifierClaimDiscoverable answers false for a tombstone, whatever the clock says', () => {
    const tomb: UsernameTombstoneRecord = { claimKey: 'usernamehash#v1#x', tombstoned: true, freesAt: 10 };
    expect(identifierClaimDiscoverable(tomb, 0)).toBe(false);
    expect(identifierClaimDiscoverable(tomb, 10)).toBe(false);
    expect(identifierClaimDiscoverable(tomb, 10_000)).toBe(false);
    // The live rule is untouched beside it.
    expect(identifierClaimDiscoverable({ discoverable: true }, 0)).toBe(true);
    expect(identifierClaimDiscoverable({ discoverable: true, discoverableAfter: 5 }, 4)).toBe(false);
    expect(identifierClaimDiscoverable({ discoverable: true, discoverableAfter: 5 }, 5)).toBe(true);
    expect(identifierClaimDiscoverable({ discoverable: false }, 0)).toBe(false);
  });
});

/**
 * The reaping read deleted the claim tombstone FIRST and the skeleton
 * tombstone second, non-transactionally. A crash between the two stranded the
 * skeleton tombstone: the only pointer to it (`skeletonKey`) lived on the
 * claim tombstone just deleted, and the users table has no TTL, so nothing
 * would ever reap it again. Reversed, the unreachable row goes first; a crash
 * then leaves the REACHABLE claim tombstone, which the next read reaps again
 * (the skeleton delete no-ops on the absent row). Pinned on the wire with a
 * scripted doc — no store needed. */
describe('getUsernameClaim reaps the unreachable skeleton tombstone BEFORE the reachable claim tombstone', () => {
  const CLAIM_KEY = 'usernamehash#v1#elapsed';
  const SKELETON_KEY = 'nameskel#v1#elapsed';
  const NOW = 2_000;

  function scriptedDoc(skeletonRefuses: boolean): {
    deletes: string[];
    doc: DynamoDBDocumentClient;
  } {
    const deletes: string[] = [];
    const send = async (cmd: unknown): Promise<unknown> => {
      if (cmd instanceof GetCommand) {
        return {
          Item: {
            userId: CLAIM_KEY,
            kind: 'identifierClaim',
            tombstoned: true,
            freesAt: NOW - 1,
            skeletonKey: SKELETON_KEY,
          },
        };
      }
      if (cmd instanceof DeleteCommand) {
        const key = (cmd.input.Key as { userId: string }).userId;
        deletes.push(key);
        if (skeletonRefuses && key === SKELETON_KEY) {
          throw Object.assign(new Error('refused'), { name: 'ConditionalCheckFailedException' });
        }
        return {};
      }
      return {};
    };
    return { deletes, doc: { send } as unknown as DynamoDBDocumentClient };
  }

  it('deletes the skeleton tombstone first, then the claim tombstone', async () => {
    const { deletes, doc } = scriptedDoc(false);
    const db = makeDataLayer(doc);
    expect(await db.getUsernameClaim(CLAIM_KEY, NOW)).toBeUndefined();
    expect(deletes).toEqual([SKELETON_KEY, CLAIM_KEY]);
  });

  it('a skeleton row already taken by a live re-claim (condition refused) does not stop the claim reap', async () => {
    const { deletes, doc } = scriptedDoc(true);
    const db = makeDataLayer(doc);
    expect(await db.getUsernameClaim(CLAIM_KEY, NOW)).toBeUndefined();
    expect(deletes).toEqual([SKELETON_KEY, CLAIM_KEY]);
  });
});
