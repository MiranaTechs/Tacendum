import { randomUUID } from 'node:crypto';
import { monotonicFactory } from 'ulid';
import {
  ACCOUNT_GROUP_MAX_MEMBERS,
  CONSENT_MAX_EDGES,
  CREW_MAX_MEMBERS,
  EMAIL_CODE_ATTEMPT_CAP,
  EMAIL_SUPPRESSION_TTL_SECONDS,
  KIT_ZERO_MATERIAL_B64,
  MAX_VERIFIED_IDENTIFIERS_PER_GROUP,
  PHONE_SUPPRESSION_TTL_SECONDS,
  USERNAME_RENAME_COOLDOWN_SECONDS,
  USERNAME_TOMBSTONE_TTL_SECONDS,
  type OneTimePrekey,
  type WsTicketRole,
} from '@tacendum/shared';
import {
  activityRecord,
  activityTombstone,
  type ActivityRecord,
  type ActivityTombstone,
} from '../src/activity.js';
import {
  DEFAULT_QUEUE_QUOTA,
  attachClassPrefixForClaimKey,
  cooldownKeyFromClaimKey,
  cooldownShadowKeyForClaimKey,
  identifierClassForClaimKey,
  recoveryIdentifierClassForClaimKey,
  IDKEY_CLAIM_PREFIX,
  USERNAME_CLAIM_KEY_PREFIX,
  isClaimKey,
  isQueueControlKey,
  QueuedQuotaExceededError,
  QueueGroupReachRevokedError,
  QueueParticipantTombstonedError,
  connectionExpiresAt,
  resolveQueueQuota,
  sessionTokenDigest,
  type AccountGroupMember,
  type AuthChallengeRecord,
  type KitChallengeRecord,
  type ConnectionRecord,
  type DataLayer,
  type TestOnlyDataLayer,
  type EmailCodeRecord,
  type IdentifierClaimRecord,
  type LinkOfferInitRecord,
  type LinkOfferRecord,
  type PushTokenRecord,
  type QueueQuota,
  type RecoveryPendingRecord,
  type ReportRecord,
  type QueuedMessage,
  type SessionRecord,
  type UserRecord,
  type UsernameTombstoneRecord,
  LINK_OFFER_POINTER_CAP,
  parseClientPolicyItem,
} from '../src/db/data.js';
import type { Deps, HttpEvent } from '../src/handlers/http.js';
import type { LogFields } from '../src/log.js';
import { makeRateLimiter } from '../src/ratelimit.js';
import { makeMemoryCallMetricStore } from '../src/call-metrics.js';

/** Queue page size for the in-memory twin. Tiny on purpose: three queued
 * messages already span two pages, so ordinary unit tests exercise the paged
 * stream rather than degenerating to the one-page case. */
const MEMORY_QUEUE_PAGE_SIZE = 2;

/** In-memory DataLayer mirroring the DynamoDB semantics the handlers rely on.
 * `queueQuota` mirrors the real layer's per-pair cap; defaulted so existing
 * callers are unchanged, injectable so a test can drive a small, exhaustible
 * cap against the same enforcement the DynamoDB layer runs. */
export function makeMemoryDb(
  queueQuota: QueueQuota = DEFAULT_QUEUE_QUOTA,
  /** The store's `DataLayerHooks.nowMs` seam mirrored: the wall clock
   * a clockless last-exit sweep stamps a username tombstone from. Every
   * clocked path in the suites passes `nowMs` explicitly; this is the
   * landed call sites' fallback, exactly as in the store. */
  hooks: { nowMs?: () => number } = {},
): TestOnlyDataLayer & {
  /** Twin-only operator seam for the `feature#accounts` flag row — the
   * production row is operator-written and the DataLayer deliberately has
   * no write method for it, so the twin's operator is the test. */
  setAccountsFeatureEnabled(on: boolean): void;
  /** Same twin-only operator seam for `feature#accounts-phone`. */
  setAccountsPhoneFeatureEnabled(on: boolean): void;
  /** Same twin-only operator seam for `feature#accounts-username`. */
  setAccountsUsernameFeatureEnabled(on: boolean): void;
  /** Same twin-only operator seam for the `policy#client` row.
   * Takes the RAW item, so a suite can plant the
   * malformed ones an operator console admits. */
  setClientPolicyRow(item: unknown): void;
} {
  const quota = resolveQueueQuota(queueQuota);
  const wallNowMs = hooks.nowMs ?? Date.now;
  const usersByIdentityKey = new Map<string, UserRecord>();
  const usersById = new Map<string, UserRecord>();
  const wsTickets = new Map<
    string,
    { ticket: string; userId: string; expiresAt: number; role: WsTicketRole; sessionDigest?: string }
  >();
  const authChallenges = new Map<string, AuthChallengeRecord>();
  // The kit's two challenge namespaces (§3), keyed by
  // (kind, account, nonce) so per-request rows COEXIST here exactly as the
  // store's prefix-disjoint digest keys make them coexist there. A twin that
  // modelled one-outstanding-per-account would pass the very lockout test
  // §2 inv. 6 exists to fail.
  const kitChallenges = new Map<string, KitChallengeRecord>();
  const kitChallengeKey = (kind: KitChallengeRecord['kind'], userId: string, challenge: string) =>
    `${kind}\n${userId}\n${challenge}`;
  const sessions = new Map<string, SessionRecord>();
  const prekeys = new Map<string, OneTimePrekey[]>(); // userId -> sorted by keyId
  // The pool generation on each user row, mirrored so a consume or count
  // against a stale generation answers nothing here too.
  const prekeyGens = new Map<string, string>();
  const connections = new Map<string, ConnectionRecord>(); // userId -> connection
  const queues = new Map<string, Map<string, QueuedMessage>>(); // recipientId -> msgId -> msg
  // The quota LEDGERS (S1), mirroring the real layer's `#quota#...` items:
  // maintained IN THE SAME synchronous step as the row write — the in-memory
  // equivalent of the TransactWriteItems, and what makes the twin's cap hold
  // under interleaved awaits instead of being check-then-write. Pair ledgers
  // survive their count reaching zero (the correspondence signal); memory has
  // no TTL reaper, so `expiresAt` is checked at read exactly like the store.
  // `established` mirrors the store's `qEstab` marker: true once a
  // user-authored send has EVER ridden this pair ledger, and sticky thereafter
  // (used, like `attribute_not_exists(qEstab)`, to decide the reap).
  // `estabExpiresAt` mirrors the store's `qEstabExpiresAt`: the
  // establishment's OWN expiry, refreshed only by a user-authored send, so a
  // pair is CURRENTLY established only while that clock is in the future —
  // automatic carriers refresh the general `expiresAt` but not this one. The
  // row's existence alone no longer means correspondence.
  const pairLedgers = new Map<
    string,
    { items: number; bytes: number; expiresAt: number; established: boolean; estabExpiresAt: number }
  >();
  const strangerLedgers = new Map<string, { items: number; bytes: number; expiresAt: number }>();
  // Rows billed to the stranger ledger (the real layer's qUnknown flag), so
  // release decrements exactly what billing added even after a status flip.
  const strangerBilled = new Map<string, Set<string>>(); // recipientId -> msgIds
  // The billing stamp (the real layer's `qPair` row attribute): which
  // pair-ledger KEY a row was billed under when the sender was
  // group-collapsed, so release decrements exactly the ledger billing chose
  // even after the sender's roster changes. Absent = billed under the
  // literal sender ULID, exactly as shipped.
  const pairBilled = new Map<string, Map<string, string>>(); // recipientId -> msgId -> pair key
  const pairKey = (senderId: string, recipientId: string): string =>
    `${recipientId}\n${senderId}`;
  /** The group-aware establishment walk — the twin of the store's
   * `pairEstablishedAny`: OR of the two-clock establishment rule over every
   * (writer key, receiver partition) pair ledger. */
  const anyEstablished = (
    writerKeys: readonly string[],
    receiverPartitions: readonly string[],
    nowSeconds: number,
  ): boolean => {
    for (const partition of receiverPartitions) {
      for (const writer of writerKeys) {
        const ledger = pairLedgers.get(pairKey(writer, partition));
        if (
          ledger !== undefined &&
          ledger.expiresAt > nowSeconds &&
          ledger.estabExpiresAt > nowSeconds
        ) {
          return true;
        }
      }
    }
    return false;
  };
  const pushTokens = new Map<string, PushTokenRecord>(); // userId -> token row
  // Ring claims (the platform-redelivery guard), keyed by the server-minted
  // wakeId and holding only their TTL. The store keeps these in the SAME
  // table as the token rows under a `wake#` key — the push worker's role has
  // no other table it may write — but the twin keeps them apart, because a
  // test that could reach a claim through `getPushToken` would be a test
  // asserting on a key shape no caller uses.
  const wakeClaims = new Map<string, number>(); // wakeId -> expiresAt (unix s)
  // Reports are write-only through the DataLayer by design (no getReport),
  // so tests assert on them by wrapping `putReport` — the same way the
  // deletion-ordering tests wrap `purgeQueuedMessages`.
  const reports = new Map<string, ReportRecord>();
  const activities = new Map<string, ActivityRecord | ActivityTombstone>();
  // Revoked identity keys. The real layer keeps the
  // tombstone ON the claim row; a side set is the same observable behavior.
  const tombstonedKeys = new Set<string>();
  /** The twin's model of the store's `claimedUserId` attribute on an `idkey#`
   * claim row: which account that claim NAMES. Kept beside `usersById`
   * because the twin's claim rows are `UserRecord`s and carry no such field,
   * and it is load-bearing — the rebind's leg (b) conditions on
   * `claimedUserId = :self`, so a twin without the pointer could not model the
   * drift state where an old key's claim belongs to a DIFFERENT account. */
  const idkeyClaimOwner = new Map<string, string>();
  // Directed consent edges: userId -> the agentIds that
  // human consented to. A Set per partition mirrors the store's edge rows;
  // its SIZE mirrors the `#count` control row — one synchronous step per
  // write, so the cap holds under interleaved awaits exactly as the store's
  // TransactWriteItems does (the pairLedgers rule).
  const consentEdges = new Map<string, Set<string>>();
  // Account groups mirroring the store's `group#` rows:
  // link/unlink/revoke mutate roster + user rows in ONE synchronous step —
  // the in-memory equivalent of the TransactWriteItems — so the class-slot,
  // epoch, and cap refusals hold under interleaved awaits exactly as the
  // store's conditions do (the pairLedgers rule). Offers mirror the
  // sessions-table `linkoffer#` rows: single-mint, single-use, expiry
  // checked at read (the clock decides, not a reaper).
  const accountGroups = new Map<
    string,
    {
      members: AccountGroupMember[];
      identifierRefs: string[];
      epoch: number;
      createdAt: number;
      /** The group-level recovery cool-down carrier. */
      discoverableAfter?: number;
      /** The never-ceremonially-grouped founder marker —
       * the store's lazy-solo dissolve rides it. */
      attachCreated?: boolean;
      /** The rename cool-down's stored fact unix seconds. */
      usernameRenamedAt?: number;
    }
  >();
  const linkOffers = new Map<string, LinkOfferRecord>();
  // INIT-leg rows: the tuple minted for A to sign, single-use,
  // consumed by the promote in the same synchronous step the offer row is
  // born — the twin of the store's conditional-delete + Put transaction.
  const linkOfferInits = new Map<string, LinkOfferInitRecord>();
  // The `feature#accounts` flag: operator-written in production, so the twin
  // exposes a test-only setter (below, beyond the DataLayer surface) instead
  // of a DataLayer write method that must never exist. Absent = OFF.
  let accountsFeatureOn = false;
  // ABSENT = OFF, the shipped default — the phone train boots dark.
  let accountsPhoneFeatureOn = false;
  // ABSENT = OFF — the username class boots dark.
  let accountsUsernameFeatureOn = false;
  // The `policy#client` row, held as the RAW item an
  // operator would type rather than as a parsed record: the twin runs the
  // store's own `parseClientPolicyItem` over it, so a suite that plants a
  // typo exercises the real refusal instead of a fake that cannot hold one.
  let clientPolicyItem: unknown;
  // Email linking + recovery, mirroring the store's
  // rows: claim rows keyed by their versioned HMAC key, one code row per
  // requesting device (attempt cap enforced in the same synchronous step as
  // the read — the store's conditional increment), suppression shadows, and
  // pending recovery rows whose cancel/complete serialization mirrors the
  // store's conditions (the pairLedgers rule: one synchronous step each).
  const identifierClaims = new Map<string, IdentifierClaimRecord>();
  // Per-(requester, PURPOSE) code slots — the store's split (attach and
  // recovery never share a slot, so a recovery request can't clobber a pending
  // attach row — closing the registered-vs-not oracle).
  const emailCodes = new Map<string, EmailCodeRecord>();
  const codeSlot = (userId: string, purpose: EmailCodeRecord['purpose']): string =>
    `${userId}#${purpose}`;
  // Suppression shadows carry their explicit expiry: the map value is
  // the unix-seconds `expiresAt` the reading walk enforces and reaps on.
  const emailSuppressions = new Map<string, number>();
  // The address-keyed recovery cool-down shadows,
  // keyed by `emailcool#v<K>#<hash>` exactly as the store keys them.
  const emailCooldowns = new Map<string, number>();
  const recoveries = new Map<string, RecoveryPendingRecord>();
  // The username class mirroring the store's rows: the
  // LIVE exact-name claim lives in `identifierClaims` (with its
  // `skeletonKey`), the live skeleton row here, and every TOMBSTONE — at a
  // claim key or a skeleton key — here, keyed exactly as the store keys the
  // overwritten row. A key is FREE to a claimant when it is in neither live
  // map and its tombstone (if any) has elapsed or names the claimant as
  // former owner — the store's one condition string, one function here.
  const usernameSkeletons = new Map<string, { groupId: string; claimKey: string }>();
  const usernameTombstones = new Map<
    string,
    { freesAt: number; formerGroupId?: string; skeletonKey?: string }
  >();
  const usernameFreesAt = (nowMs: number): number =>
    Math.floor(nowMs / 1000) + USERNAME_TOMBSTONE_TTL_SECONDS;
  const usernameKeyFree = (key: string, nowSeconds: number, groupId: string): boolean => {
    if (identifierClaims.has(key) || usernameSkeletons.has(key)) return false;
    const tomb = usernameTombstones.get(key);
    return tomb === undefined || tomb.freesAt <= nowSeconds || tomb.formerGroupId === groupId;
  };
  /** The store's `readLiveUsernameClaim` mirrored: the LIVE claim at the
   * key or undefined — and the store's THROW on a live row without its
   * skeleton twin (store drift the claim transaction makes impossible):
   * loud on both DataLayers, never a silent half-tombstone in one and an
   * error in the other (the twin-drift rule). */
  const readLiveUsernameClaim = (claimKey: string): IdentifierClaimRecord | undefined => {
    const live = identifierClaims.get(claimKey);
    if (!live) return undefined;
    if (live.skeletonKey === undefined) {
      throw new Error('username claim: live row carries no skeleton key');
    }
    return live;
  };
  /** The store's tombstone Put-overwrites for one live username claim and
   * its skeleton (rename/unlink/revoke/dissolve): the live rows leave their
   * maps, the tombstones take their keys. `formerGroupId` absent = the
   * nobody-reclaims shape. A ref whose live row is gone writes nothing; a
   * live row without its skeleton key throws, as the store's pre-read does. */
  const tombstoneUsernameRows = (
    claimKey: string,
    groupId: string,
    nowMs: number,
    formerGroupId?: string,
  ): void => {
    const live = readLiveUsernameClaim(claimKey);
    if (!live || live.groupId !== groupId || live.skeletonKey === undefined) return;
    identifierClaims.delete(claimKey);
    usernameSkeletons.delete(live.skeletonKey);
    const freesAt = usernameFreesAt(nowMs);
    usernameTombstones.set(claimKey, {
      freesAt,
      ...(formerGroupId !== undefined ? { formerGroupId } : {}),
      skeletonKey: live.skeletonKey,
    });
    usernameTombstones.set(live.skeletonKey, {
      freesAt,
      ...(formerGroupId !== undefined ? { formerGroupId } : {}),
    });
  };
  /** The dissolve rule: a dying group's username refs are tombstoned
   * nobody-reclaims, its other refs deleted — the store's last-exit shape. */
  const disposeDissolvedRefs = (refs: readonly string[], groupId: string, nowMs: number): void => {
    for (const ref of refs) {
      if (ref.startsWith(USERNAME_CLAIM_KEY_PREFIX)) tombstoneUsernameRows(ref, groupId, nowMs);
      else identifierClaims.delete(ref);
    }
  };

  /** The shared roster-removal step behind unlink AND revoke — one
   * body, same reason as the store's: two copies of the epoch/membership
   * rules is where drift would live. */
  function rosterRemovalStep(
    { groupId, actingUserId, targetUserId, rosterEpoch, nowMs }: Parameters<DataLayer['unlinkDeviceFromGroup']>[0],
    strength: 'unlink' | 'revoke',
  ): 'done' | 'unknown_group' | 'stale_epoch' | 'not_member' | 'not_acting_member' {
    const group = accountGroups.get(groupId);
    if (!group) return 'unknown_group';
    if (group.epoch !== rosterEpoch) return 'stale_epoch';
    if (!group.members.some((m) => m.userId === actingUserId)) return 'not_acting_member';
    const target = group.members.find((m) => m.userId === targetUserId);
    if (!target) return 'not_member';
    const targetRow = usersById.get(targetUserId);
    if (!targetRow || targetRow.groupId !== groupId) return 'not_member';
    // The class conditions mirrored: the store's
    // roster-removal transaction refuses an integration-class target or
    // actor even under corrupt roster state.
    if (targetRow.accountClass !== undefined) return 'not_member';
    const actorRow = usersById.get(actingUserId);
    if (!actorRow || actorRow.accountClass !== undefined || actorRow.tombstoned === true) {
      return 'not_acting_member';
    }
    const remaining = group.members.filter((m) => m.userId !== targetUserId);
    if (remaining.length === 0) {
      // Last member out: the store deletes the group row AND every claim
      // row its identifierRefs reverse list names in one transaction
      // — mirrored since the claim rows
      // landed: the refs' claim entries die in the same synchronous step.
      // The pending recovery row goes too (before this, a last exit
      // orphaned it forever on the TTL-less users table), with the
      // recovering device's reverse pointer cleared as the store's
      // post-commit cleanup does. Username refs are TOMBSTONED, not
      // deleted (the store's dissolve rule), from the caller's clock
      // with the store's wall-clock fallback.
      disposeDissolvedRefs(group.identifierRefs, groupId, nowMs ?? wallNowMs());
      accountGroups.delete(groupId);
      const pending = recoveries.get(groupId);
      if (pending !== undefined) {
        recoveries.delete(groupId);
        const recRow = usersById.get(pending.newUserId);
        if (recRow?.recoveryGroupId === groupId) delete recRow.recoveryGroupId;
      }
    } else {
      group.members = remaining;
      group.epoch = rosterEpoch + 1;
    }
    delete targetRow.groupId;
    if (strength === 'revoke') {
      // The record is the enforcement: row tombstoned with
      // the forwarding hint, identity key tombstoned so it never re-auths.
      targetRow.tombstoned = true;
      targetRow.formerGroupId = groupId;
      if (targetRow.identityKeyPub !== undefined) {
        tombstonedKeys.add(targetRow.identityKeyPub);
      }
    }
    return 'done';
  }

  // --- Link-offer reverse pointers, the store's cap-with-reap mirrored so
  // the twin can never drift more permissive: a pointer ADD refuses at
  // LINK_OFFER_POINTER_CAP after reaping dead nonces; a refusing read of an
  // expired row reaps that row's POINTERS (the row stays for the TTL, refused
  // at every read, as in the store); a link deletes the winning nonce from
  // both rows. An emptied set drops the attribute, exactly as DynamoDB's
  // DELETE of the last element does.
  const linkOfferNonceLive = (nonce: string, nowSeconds: number): boolean =>
    (linkOffers.get(nonce)?.expiresAt ?? 0) > nowSeconds ||
    (linkOfferInits.get(nonce)?.expiresAt ?? 0) > nowSeconds;
  const dropLinkOfferPointer = (userId: string, nonce: string): void => {
    const row = usersById.get(userId);
    row?.linkOfferNonces?.delete(nonce);
    if (row?.linkOfferNonces?.size === 0) delete row.linkOfferNonces;
  };
  const addLinkOfferPointer = (
    userId: string,
    nonce: string,
    nowSeconds: number,
  ): 'added' | 'pointer_cap' => {
    const row = usersById.get(userId)!;
    const set = (row.linkOfferNonces ??= new Set<string>());
    if (set.size >= LINK_OFFER_POINTER_CAP) {
      for (const held of [...set]) {
        if (!linkOfferNonceLive(held, nowSeconds)) set.delete(held);
      }
      if (set.size >= LINK_OFFER_POINTER_CAP) return 'pointer_cap';
    }
    set.add(nonce);
    return 'added';
  };
  const reapExpiredLinkOffer = (
    kind: 'offer' | 'init',
    rec: { offerNonce: string; offererUserId: string; acceptorUserId: string },
  ): void => {
    dropLinkOfferPointer(rec.offererUserId, rec.offerNonce);
    if (kind === 'offer') dropLinkOfferPointer(rec.acceptorUserId, rec.offerNonce);
  };

  return {
    async getUserById(userId, signal) {
      // Same guard as the DynamoDB layer, and it must stay the SAME guard:
      // isClaimKey is imported rather than re-implemented so a new claim
      // namespace cannot be guarded in production and unguarded here.
      if (isClaimKey(userId)) return undefined;
      signal?.throwIfAborted();
      return usersById.get(userId);
    },
    async touchActivity(userId, nowMs, signal) {
      signal?.throwIfAborted();
      const record = activityRecord(userId, nowMs);
      const existing = activities.get(record.actorHash);
      if (
        !existing ||
        existing.expiresAt <= Math.floor(nowMs / 1000) ||
        ('activityHourActor' in existing &&
          existing.activityHourActor < record.activityHourActor)
      ) {
        activities.set(record.actorHash, record);
      }
    },
    async deleteActivity(userId, nowMs) {
      const tombstone = activityTombstone(userId, nowMs);
      activities.set(tombstone.actorHash, tombstone);
    },
    async createUser(user) {
      usersById.set(user.userId, user);
      // An account made this way (tests that need a user row without going
      // through auth) is still indexable by its key when it has one, so
      // deletion and the immutability check behave as they do in DynamoDB.
      if (user.identityKeyPub !== undefined) {
        usersByIdentityKey.set(user.identityKeyPub, user);
      }
    },
    async createSession(session) {
      sessions.set(session.token, session);
    },
    async deleteUser(userId, claims, guard) {
      // Mirrors the real layer's guarded delete leg ('s backstop): under `requireEmptyCrew` a row holding a live crew
      // refuses with NOTHING deleted — user row and claim row alike. The
      // mirror must not drift more permissive than the store it stands in
      // for, or a memory-db handler test would pass the exact interleaving
      // the DynamoDB condition exists to refuse.
      if (guard?.requireEmptyCrew === true) {
        const row = usersById.get(userId);
        if (row !== undefined && (row.crewCount ?? 0) > 0) return 'crew_not_empty';
      }
      // The mirror guard: a no-release delete refuses once the
      // row carries a crewId, so a teardown that decided "not adopted" from a
      // stale read cannot leak the owner's slot. Same drift rule as above — a
      // mirror more permissive than the store makes memory-db tests prove the
      // wrong thing.
      if (guard?.requireNoCrewId === true) {
        const row = usersById.get(userId);
        if (row !== undefined && row.crewId !== undefined) return 'crew_appeared';
      }
      usersById.delete(userId);
      // A tombstoned claim survives every deletion, mirroring the real
      // layer's conditional delete: the tombstone side-set
      // already outlives this map entry, but the claim row must too, or a
      // memory-db test could pass a flow the real conditional refuses.
      if (claims.identityKeyPub !== undefined && !tombstonedKeys.has(claims.identityKeyPub)) {
        usersByIdentityKey.delete(claims.identityKeyPub);
        usersById.delete(`${IDKEY_CLAIM_PREFIX}${claims.identityKeyPub}`);
        idkeyClaimOwner.delete(`${IDKEY_CLAIM_PREFIX}${claims.identityKeyPub}`);
      }
      // The fused pending-recovery delete mirrored: a hinted recovery row still naming this device dies in the same
      // synchronous step as the row; one re-minted for another device is
      // untouched (the store's condition-cancel-and-retry-without shape).
      if (claims.pendingRecoveryGroupId !== undefined) {
        const rec = recoveries.get(claims.pendingRecoveryGroupId);
        if (rec?.newUserId === userId) recoveries.delete(claims.pendingRecoveryGroupId);
      }
      return 'deleted';
    },
    async deleteOneTimePrekeys(userId) {
      prekeys.delete(userId);
    },
    async deleteSession(token) {
      sessions.delete(token);
    },
    async getOrCreateUserByIdentityKey(identityKeyPub, candidateUserId, createdAtMs, accountClass) {
      const claimKey = `${IDKEY_CLAIM_PREFIX}${identityKeyPub}`;
      // Tombstone first, mirroring the real layer: a revoked key answers
      // "revoked", never "conflict" and above all never "fresh account".
      if (tombstonedKeys.has(identityKeyPub)) return { kind: 'tombstoned' };
      const claim = usersById.get(claimKey);
      if (claim) {
        const existing = usersByIdentityKey.get(identityKeyPub);
        // Claim without a user row: the partially-deleted account state. The
        // real layer reports it rather than recreating, and so must this, or
        // the handler's 409 path is untestable.
        if (!existing) return { kind: 'conflict' };
        return { kind: 'ok', user: existing, created: false };
      }
      // identityKeyPub IS set at birth — mirroring the real transaction, and
      // load-bearing: it is what makes storeKeys refuse a different key from
      // the very first upload.
      const created: UserRecord = {
        userId: candidateUserId,
        identityKeyPub,
        createdAt: createdAtMs,
        // Class at birth or never.
        ...(accountClass ? { accountClass } : {}),
      };
      usersByIdentityKey.set(identityKeyPub, created);
      usersById.set(candidateUserId, created);
      // Mirror DynamoDB: the transactional claim shares the users table under
      // 'idkey#<b64>', so the getUserById guard above stays testable.
      usersById.set(claimKey, { userId: claimKey, createdAt: createdAtMs });
      idkeyClaimOwner.set(claimKey, candidateUserId);
      return { kind: 'ok', user: created, created: true };
    },
    async bindIntegrationOwner(integrationUserId, ownerUserId) {
      const row = usersById.get(integrationUserId);
      if (!row || row.accountClass !== 'integration') return 'not_integration';
      if (row.ownerUserId === ownerUserId) return 'already';
      if (row.ownerUserId !== undefined) return 'owner_conflict';
      // The owner-liveness pin mirrored: a
      // missing or tombstoned owner row never GAINS a binding — the store
      // enforces this as a ConditionCheck in the bind transaction.
      const owner = usersById.get(ownerUserId);
      if (!owner || owner.tombstoned === true) return 'unknown_owner';
      row.ownerUserId = ownerUserId;
      return 'bound';
    },
    async adoptCrewMember(ownerUserId, memberUserId, mintCrewId) {
      // Mirrors the DynamoDB transaction's conditions AND its member-first
      // disambiguation order, so an outcome this db reports is one the real
      // layer would. The checks must not drift more permissive than the
      // store they stand in for (see consumeWsTicket above). Never
      // 'crew_contended': the real layer's crewId pin exists for the gap
      // between its pre-read and its transaction, and here read and write
      // are one synchronous step — there is no gap to lose a race in.
      const owner = usersById.get(ownerUserId);
      const crewId = owner?.crewId ?? mintCrewId;
      const member = usersById.get(memberUserId);
      if (!member || member.accountClass !== 'integration') return 'not_integration';
      if (member.crewId !== undefined) {
        return member.crewId === crewId && member.ownerUserId === ownerUserId
          ? 'already'
          : 'crew_conflict';
      }
      if (member.ownerUserId !== undefined && member.ownerUserId !== ownerUserId) {
        return 'owner_conflict';
      }
      if (!owner || owner.accountClass !== undefined) return 'unknown_owner';
      // THE PER-GROUP CAP mirrored: a grouped
      // owner's 8 slots are the GROUP's — the sum of every member's own
      // crewCount, taken in the same synchronous step the store's pins make
      // atomic. A solo owner keeps the shipped single-row cap.
      const ownerGroup =
        owner.groupId !== undefined ? accountGroups.get(owner.groupId) : undefined;
      const crewTotal =
        ownerGroup && ownerGroup.members.some((m) => m.userId === ownerUserId)
          ? ownerGroup.members.reduce(
              (sum, m) => sum + (usersById.get(m.userId)?.crewCount ?? 0),
              0,
            )
          : owner.crewCount ?? 0;
      if (crewTotal >= CREW_MAX_MEMBERS) return 'cap_reached';
      // The "transaction": both rows or neither, which in memory is just
      // writing both after every condition has passed.
      owner.crewId = crewId;
      owner.crewCount = (owner.crewCount ?? 0) + 1;
      member.ownerUserId = ownerUserId;
      member.crewId = crewId;
      return 'adopted';
    },
    async releaseCrewSlot(ownerUserId) {
      // Mirrors the conditional ADD: no row is ever CREATED here (the real
      // layer's attribute_exists guard — ADD on a missing item would mint a
      // ghost row at -1), and zero never goes negative.
      const owner = usersById.get(ownerUserId);
      if (!owner || (owner.crewCount ?? 0) <= 0) return;
      owner.crewCount = (owner.crewCount ?? 0) - 1;
    },
    async deleteCrewMemberAndReleaseSlot(memberUserId, ownerUserId) {
      // Mirrors the transaction's exactly-once shape: the
      // decrement happens ONLY when this call is the one that deletes the
      // member row. Member already gone → the real transaction cancels on
      // attribute_exists and releases nothing; owner unreleasable → the row
      // is still deleted, alone. The mirror must not drift more forgiving
      // than the store it stands in for.
      const member = usersById.get(memberUserId);
      if (!member) return;
      usersById.delete(memberUserId);
      const owner = usersById.get(ownerUserId);
      if (!owner || (owner.crewCount ?? 0) <= 0) return;
      owner.crewCount = (owner.crewCount ?? 0) - 1;
    },
    async tombstoneIdentityKey(identityKeyPub) {
      // Mirror the real conditional: only a key with a claim row can be
      // tombstoned; an unknown key is an idempotent no-op.
      if (usersById.has(`${IDKEY_CLAIM_PREFIX}${identityKeyPub}`)) {
        tombstonedKeys.add(identityKeyPub);
      }
    },
    async getUserByIdentityKeyClaim(identityKeyPub) {
      const claim = usersById.get(`${IDKEY_CLAIM_PREFIX}${identityKeyPub}`);
      if (!claim) return undefined;
      return usersByIdentityKey.get(identityKeyPub);
    },
    async putAuthChallenge(rec) {
      // Keyed per (identity key, nonce) like the real layer's digest key:
      // concurrent challenges coexist, and issuing never clobbers a sibling.
      authChallenges.set(`${rec.identityKeyPub}\n${rec.challenge}`, rec);
    },
    async getAuthChallenge(identityKeyPub, challenge) {
      return authChallenges.get(`${identityKeyPub}\n${challenge}`);
    },
    async consumeAuthChallengeIfMatches(identityKeyPub, challenge) {
      const mapKey = `${identityKeyPub}\n${challenge}`;
      const rec = authChallenges.get(mapKey);
      if (!rec || rec.challenge !== challenge) return false;
      authChallenges.delete(mapKey);
      return true;
    },
    // --- Paper recovery kit (§3) ---
    // MIRRORS THE STORE, and the fidelity is the point: the original identity
    // immutability defect survived its first draft precisely because the twin
    // was more permissive than the store it stands in for (see `storeKeys`
    // below). Every condition the real transaction carries is carried here.

    async setKitEnrollment(userId, salt, verifierDigest, nowMs) {
      // Mirror the store's `isClaimKey` guard: a caller-supplied `idkey#…`
      // must not be able to ask whether that key is registered, nor have kit
      // attributes written onto a bookkeeping row.
      if (isClaimKey(userId)) return false;
      // Mirror the store's all-zero refusal.
      if (salt === KIT_ZERO_MATERIAL_B64 || verifierDigest === KIT_ZERO_MATERIAL_B64) return false;
      const row = usersById.get(userId);
      // Mirror `attribute_exists(userId) AND attribute_not_exists(tombstoned)`:
      // a revoked device must not be able to arm a recovery for the account it
      // was cut off from.
      if (!row || row.tombstoned === true) return false;
      row.kitSalt = salt;
      row.kitVerifierDigest = verifierDigest;
      row.kitEnrolledAt = nowMs;
      return true;
    },

    async clearKitEnrollment(userId) {
      // Mirror the store's `isClaimKey` guard — see `setKitEnrollment`.
      if (isClaimKey(userId)) return;
      const row = usersById.get(userId);
      // Idempotent by contract, mirroring the store: revoking a kit that is
      // not there is a success, and a missing row is a no-op rather than a
      // throw.
      if (!row) return;
      delete row.kitSalt;
      delete row.kitVerifierDigest;
      delete row.kitEnrolledAt;
    },

    async putKitChallenge(rec) {
      // Per (kind, account, nonce), like the store's prefix-disjoint digest
      // key: concurrent mints coexist and one can never clobber a sibling's.
      kitChallenges.set(kitChallengeKey(rec.kind, rec.userId, rec.challenge), { ...rec });
    },

    async consumeKitChallengeIfMatches(kind, userId, challenge) {
      const mapKey = kitChallengeKey(kind, userId, challenge);
      const rec = kitChallenges.get(mapKey);
      if (!rec) return undefined;
      // Spent by the ATTEMPT, expired or not — the store's conditional delete
      // with ALL_OLD does not read the clock either, so a caller cannot retry
      // a dead nonce until the clock suits them. Expiry is the caller's call
      // on the record handed back.
      kitChallenges.delete(mapKey);
      return { ...rec };
    },

    async rebindUserIdentity(input) {
      const { userId, expectedIdentityKeyPub, core, nowMs } = input;
      // Mirror the store's `isClaimKey` guard — see `setKitEnrollment`.
      if (isClaimKey(userId)) return { kind: 'stale' };
      // The crashed client's retry (§0.5), short-circuited BEFORE anything
      // else exactly as the store does — there, because legs (a) and (c)
      // would address one item twice and DynamoDB would 500 the whole
      // transaction; here, so the two agree about what a retry answers.
      if (expectedIdentityKeyPub === core.identityKeyPub) return { kind: 'unchanged' };

      const oldClaimKey = `${IDKEY_CLAIM_PREFIX}${expectedIdentityKeyPub}`;
      const newClaimKey = `${IDKEY_CLAIM_PREFIX}${core.identityKeyPub}`;

      // PRECEDENCE MIRRORS THE STORE'S. The real catch reads
      // CancellationReasons positionally and tests index 2 (the new claim)
      // FIRST, so when the row condition and the claim condition fail
      // together the answer is `key_in_use`. A twin that answered `stale`
      // there would make a handler test prove the wrong 4xx.
      if (usersById.has(newClaimKey)) return { kind: 'key_in_use' };

      const row = usersById.get(userId);
      // Mirror `attribute_exists(userId) AND attribute_not_exists(tombstoned)
      // AND identityKeyPub = :old`: a delete or a second rebind racing us
      // wins, and this call loses rather than overwriting; and a REVOKED row
      // loses to the same guard `setKitEnrollment` already applies, so a kit
      // armed before the revoke cannot rekey a tombstoned account into a
      // sign-in-but-cannot-send split state. Nothing is mutated on this branch
      // — the store's transaction is all-or-none.
      if (!row || row.tombstoned === true || row.identityKeyPub !== expectedIdentityKeyPub) {
        return { kind: 'stale' };
      }
      // Mirror leg (b)'s `attribute_exists(userId)`: the OLD claim is
      // TOMBSTONED, never minted. A row whose key has no claim is drift, and
      // the store fails loudly on it rather than writing a bare tombstone for
      // a key that was never registered (`tombstoneIdentityKey`'s stated
      // rule). It answers `stale`; the caller re-reads.
      // …AND `claimedUserId = :self`: the claim must already NAME this
      // account, so a drift state where the old key belongs to someone else
      // cannot have that other account's LIVE claim revoked from here.
      if (!usersById.has(oldClaimKey) || idkeyClaimOwner.get(oldClaimKey) !== userId) {
        return { kind: 'stale' };
      }

      const poolGen = randomUUID();
      row.registrationId = core.registrationId;
      row.identityKeyPub = core.identityKeyPub;
      row.signedPrekey = core.signedPrekey;
      row.kyberPrekey = core.kyberPrekey;
      // The pool generation rolls in the SAME step as the key:
      // the old one-time pool is orphaned atomically with
      // the swap, so no bundle can ever pair the new identity key with an old
      // one-time prekey.
      row.prekeyPoolGen = poolGen;
      // `prekeyGens` is NOT touched, and that is the whole mechanism. It
      // models the generation stamped on the stored PREKEY ITEMS, which the
      // store writes with the pool and this transaction does not rewrite. The
      // row's generation moves; the pool's stamp does not; so every consume
      // and count under the generation a bundle reads off the row now answers
      // nothing, and the entire old pool is orphaned atomically with the key.
      // Setting it here would model a store that rewrites 100 prekey items
      // inside a 3-item TransactWrite, which is not a store anyone can build.

      // The OLD claim survives, TOMBSTONED IN PLACE. The store SETs one
      // attribute on the EXISTING item, exactly as `tombstoneIdentityKey`
      // does — it does not replace the row — so the birth `createdAt` and
      // every other attribute survive, and the twin does the same rather than
      // re-minting the item (the earlier draft's whole-item write discarded
      // both, and this file exists because a twin that drifts from the store
      // is how the identity-immutability defect survived its first draft).
      //
      // The twin does not model the store's `claimedUserId` attribute at all:
      // resolution here goes through the `usersByIdentityKey` map, and the
      // `tombstonedKeys` set is the twin's own spelling of the flag, kept in
      // step with it. The consequence that matters is the same on both sides:
      // the old key's next sign-in latches `identity_tombstoned` instead of
      // minting a fresh account, which is what a found-or-stolen old phone
      // must hear.
      const oldClaim = usersById.get(oldClaimKey);
      if (oldClaim) oldClaim.tombstoned = true;
      tombstonedKeys.add(expectedIdentityKeyPub);
      // The old key keeps resolving to this row, mirroring the retained
      // `claimedUserId`. It is unreachable as a live account: every resolver
      // checks the tombstone first.
      usersByIdentityKey.set(core.identityKeyPub, row);
      usersById.set(newClaimKey, { userId: newClaimKey, createdAt: nowMs });
      idkeyClaimOwner.set(newClaimKey, userId);
      return { kind: 'rebound', prekeyPoolGen: poolGen };
    },

    async putWsTicket(rec) {
      wsTickets.set(rec.ticket, rec);
    },
    async consumeWsTicket(ticket, nowSeconds) {
      const rec = wsTickets.get(ticket);
      // Delete FIRST, unconditionally on existence: the real implementation is
      // a conditional delete, so a ticket is spent by the attempt whether or
      // not it turns out to be expired. Returning early on expiry without
      // deleting would model a store this one is not, and the single-use test
      // would pass here while failing against DynamoDB.
      if (!rec) return undefined;
      wsTickets.delete(ticket);
      // `<=`, matching the real implementation: at expiresAt the ticket is
      // over. The two comparisons must not drift — a double that is more
      // permissive than the store it stands in for is a test that passes for a
      // system nobody runs.
      if (rec.expiresAt <= nowSeconds) return undefined;
      // /#3 — a ticket BOUND to a session is refused once that session is
      // gone or expired (the store gates on a strongly-consistent read of the
      // session row; here we scan the same sessions the twin holds). Sessions
      // are keyed by plaintext token, so hash each to match the bound digest —
      // exactly as getSessionByDigest does. The ticket is already spent above,
      // whichever way this goes. A ticket with no bound digest is
      // ungated, matching the store.
      if (rec.sessionDigest !== undefined) {
        let sessionLive = false;
        for (const [token, srec] of sessions) {
          if (sessionTokenDigest(token) === rec.sessionDigest && srec.expiresAt > nowSeconds) {
            sessionLive = true;
            break;
          }
        }
        if (!sessionLive) return undefined;
      }
      // The role comes back with the userId, as it does from the real row's
      // `ticketRole` attribute: $connect must be able to read it from state the
      // server holds, never from the socket URL. The session digest rides
      // along the same way so the socket this ticket opens can be bound
      // to the session that minted it.
      return {
        userId: rec.userId,
        role: rec.role,
        ...(rec.sessionDigest !== undefined ? { sessionDigest: rec.sessionDigest } : {}),
      };
    },
    async deleteSessionsForUser(userId, exceptToken) {
      let revoked = 0;
      for (const [token, rec] of [...sessions]) {
        if (rec.userId !== userId || token === exceptToken) continue;
        sessions.delete(token);
        revoked++;
      }
      return revoked;
    },
    async purgeQueuedMessages(recipientId) {
      // The real purge sweeps the whole partition — message rows AND the
      // quota ledgers that live under it. Mirror both, or a deleted account's
      // ledger would survive here and diverge from the store.
      queues.delete(recipientId);
      strangerLedgers.delete(recipientId);
      strangerBilled.delete(recipientId);
      pairBilled.delete(recipientId);
      for (const key of [...pairLedgers.keys()]) {
        if (key.startsWith(`${recipientId}\n`)) pairLedgers.delete(key);
      }
    },
    async getSession(token) {
      return sessions.get(token);
    },
    async getSessionByDigest(digest) {
      // Sessions are keyed by plaintext token here; the real layer keys by the
      // digest. Match the real behaviour by hashing each token — the mirror
      // must resolve exactly the sessions the store would, not more.
      for (const [token, rec] of sessions) {
        if (sessionTokenDigest(token) === digest) {
          return { userId: rec.userId, createdAt: rec.createdAt, expiresAt: rec.expiresAt };
        }
      }
      return undefined;
    },
    async storeKeys(userId, core, oneTimePrekeys) {
      const user = usersById.get(userId);
      if (!user) throw new Error('user not found');
      // Mirror the real ConditionExpression: the identity key is immutable, so
      // a re-upload of the SAME key is fine and a different one is refused
      // Enforced here too, or the takeover test
      // passes against DynamoDB and silently diverges in memory — which is
      // exactly how this defect originally slipped through.
      if (user.identityKeyPub !== undefined && user.identityKeyPub !== core.identityKeyPub) {
        return false;
      }
      user.registrationId = core.registrationId;
      user.identityKeyPub = core.identityKeyPub;
      user.signedPrekey = core.signedPrekey;
      user.kyberPrekey = core.kyberPrekey;
      // A fresh generation per upload, on the row and the pool.
      const poolGen = randomUUID();
      user.prekeyPoolGen = poolGen;
      prekeyGens.set(userId, poolGen);
      // Match DynamoDB semantics: REPLACE the pool, and dedupe by keyId (a Put
      // overwrites same-key items). Prevents in-memory-only test divergence.
      const byKeyId = new Map<number, OneTimePrekey>();
      for (const pk of oneTimePrekeys) byKeyId.set(pk.keyId, pk);
      prekeys.set(
        userId,
        [...byKeyId.values()].sort((a, b) => a.keyId - b.keyId),
      );
      return true;
    },
    async consumeOneTimePrekey(userId, poolGen) {
      if (poolGen !== undefined && prekeyGens.get(userId) !== poolGen) return undefined;
      const pool = prekeys.get(userId);
      return pool && pool.length > 0 ? pool.shift() : undefined;
    },
    async countOneTimePrekeys(userId, poolGen) {
      if (poolGen !== undefined && prekeyGens.get(userId) !== poolGen) return 0;
      return prekeys.get(userId)?.length ?? 0;
    },
    async claimConnection(rec, expectedConnectionId) {
      // Mirrors the real conditional write: claim only if the row is absent or
      // still names the connection we probed. A memory db that claimed
      // unconditionally would make every handler test pass over the exact race
      // the conditional exists to lose.
      const current = connections.get(rec.userId);
      if (current !== undefined && current.connectionId !== expectedConnectionId) {
        return false;
      }
      // Mirror the real store: the TTL backstop is stamped by the WRITE, from
      // the row's own connectedAt — a twin that skipped it would let "every
      // written row carries expiresAt" pass here and fail against DynamoDB.
      // NOT mirrored: the real store's wall-clock clamp on a stale
      // connectedAt. The twin has only the harness's manual clock, handlers
      // always write connectedAt = now() (making the clamp a no-op in every
      // twin scenario), and the clamp is a claim about the request on the
      // wire — pinned where it is decided, connection.ttl.datalayer.test.ts.
      connections.set(rec.userId, { ...rec, expiresAt: connectionExpiresAt(rec.connectedAt) });
      return true;
    },
    async putConnection(rec) {
      // Mirror DynamoDB: same store-stamped TTL backstop as claimConnection.
      connections.set(rec.userId, { ...rec, expiresAt: connectionExpiresAt(rec.connectedAt) });
    },
    async getConnection(userId) {
      return connections.get(userId);
    },
    async putReport(rec) {
      reports.set(rec.reportId, rec);
    },
    async putPushToken(rec) {
      // Mirror DynamoDB: a Put replaces the whole row.
      pushTokens.set(rec.userId, rec);
    },
    async getPushToken(userId) {
      return pushTokens.get(userId);
    },
    async wakeAlreadyRang(wakeId) {
      const expiresAt = wakeClaims.get(wakeId);
      if (expiresAt === undefined) return false;
      // Memory has no TTL reaper, so expiry is checked at read — the same
      // shape every other TTL'd row in this twin uses, with one difference
      // that matters to whoever tests it: the others take their `now` as an
      // argument (`consumeWsTicket`, `hasQueuedCorrespondence`), and this one
      // cannot, because the DataLayer hands `wakeAlreadyRang` no clock — the
      // store reaps server-side. So it reads the WALL clock, and the only way
      // to reach this branch is to move the wall clock. Which is what
      // push.redelivery.test.ts ("stops suppressing once it has expired") now
      // does; before it, this branch had no caller in the suite at all.
      //
      // One direction of divergence, stated: DynamoDB reaps lazily and CAN
      // still return an expired claim, so the store may stay suppressed
      // slightly longer than this does. Nothing depends on it — by then the
      // wake is older than Lambda's maximum event age and no redelivery of it
      // can exist.
      if (expiresAt <= Math.floor(Date.now() / 1000)) {
        wakeClaims.delete(wakeId);
        return false;
      }
      return true;
    },
    async markWakeRang(wakeId, expiresAt) {
      // Mirrors the store's unconditional SET: re-claiming an id already
      // claimed just refreshes it.
      wakeClaims.set(wakeId, expiresAt);
    },
    async deletePushToken(userId) {
      pushTokens.delete(userId);
    },
    async mergePushToken(rec) {
      // Mirror the store's Android branch: a whole-row replace, no merge —
      // one FCM token means no half-row race, and a platform switch
      // must be total (db/data.ts states the full reasoning).
      if (rec.platform === 'android') {
        pushTokens.set(rec.userId, {
          userId: rec.userId,
          platform: 'android',
          ...(rec.fcmToken ? { fcmToken: rec.fcmToken } : {}),
          bundleId: rec.bundleId,
          updatedAt: rec.updatedAt,
          expiresAt: rec.expiresAt,
        });
        return;
      }
      const stored = pushTokens.get(rec.userId);
      // `stored.env === rec.env` also mirrors the store's condition on an
      // ANDROID incumbent: that row has no env attribute, so the comparison
      // fails and the iOS registration replaces it wholesale below.
      if (stored && stored.env === rec.env && stored.bundleId === rec.bundleId) {
        pushTokens.set(rec.userId, {
          ...stored,
          ...(rec.voipToken ? { voipToken: rec.voipToken } : {}),
          ...(rec.alertToken ? { alertToken: rec.alertToken } : {}),
          ...(rec.env ? { env: rec.env } : {}),
          bundleId: rec.bundleId,
          updatedAt: rec.updatedAt,
          expiresAt: rec.expiresAt,
        });
      } else {
        pushTokens.set(rec.userId, { ...rec });
      }
    },

    async removePushTokenField(userId, field, expectedValue) {
      // Mirrors the conditional REMOVE + tidy-if-empty pair.
      const row = pushTokens.get(userId);
      if (!row || row[field] !== expectedValue) return;
      const next = { ...row };
      delete next[field];
      if (!next.voipToken && !next.alertToken && !next.fcmToken) {
        pushTokens.delete(userId);
      } else {
        pushTokens.set(userId, next);
      }
    },
    async deleteConnection(userId, connectionId) {
      if (connections.get(userId)?.connectionId === connectionId) {
        connections.delete(userId);
      }
    },
    async enqueueMessage(msg, opts) {
      // /S1 — mirror the real layer's ATOMIC ledger enforcement: the checks
      // and the writes below are one synchronous step (no await anywhere), so
      // interleaved concurrent enqueues admit exactly what the store's
      // TransactWriteItems would. A twin that re-counted rows around an await
      // would make every handler test pass over the exact race the
      // transaction exists to lose. Never evicts.
      if (isQueueControlKey(msg.msgId)) {
        throw new Error('msgId collides with the quota ledger namespace');
      }
      // COMMIT-TIME tombstone enforcement, mirrored: the store carries these as ConditionCheck items INSIDE
      // the enqueue TransactWriteItems, so no send commits from or to a
      // tombstoned row once a revoke commits — checked here BEFORE the
      // duplicate return, because a revoked participant must never see the
      // idempotent success. `serverMinted` (deliverAccountsNotice) skips the
      // sender side only; a self-send carries the recipient check alone,
      // matching the store's one-operation-per-item rule.
      if (
        opts?.serverMinted !== true &&
        msg.senderId !== msg.recipientId &&
        usersById.get(msg.senderId)?.tombstoned === true
      ) {
        throw new QueueParticipantTombstonedError('sender');
      }
      if (usersById.get(msg.recipientId)?.tombstoned === true) {
        throw new QueueParticipantTombstonedError('recipient');
      }
      // The widened-reach delivery pin mirrored
      // (GroupReachPin): the store carries a group-row membership
      // ConditionCheck in the enqueue transaction; an amicable unlink leaves
      // both user rows live, so the tombstone mirrors above cannot catch it.
      if (opts?.groupReachPin !== undefined) {
        const pin = opts.groupReachPin;
        const group = accountGroups.get(pin.groupId);
        const memberIds = new Set((group?.members ?? []).map((m) => m.userId));
        if (!group || !memberIds.has(pin.ownerUserId) || !memberIds.has(pin.memberUserId)) {
          throw new QueueGroupReachRevokedError(pin.arm);
        }
      }
      const q = queues.get(msg.recipientId) ?? new Map<string, QueuedMessage>();
      // Idempotent duplicate (the Put condition) — success, but reported as
      // NOT an insert, mirroring the store: the caller charges
      // push budgets only for a genuine insert, and a twin that reported
      // duplicates as inserts would let the replay-drains-the-wake-budget
      // defect pass every memory-db handler test.
      if (q.has(msg.msgId)) return { inserted: false };
      const newBytes = Buffer.byteLength(msg.payload, 'utf8');
      const nowSeconds = Math.floor(msg.ts / 1000);
      // Does THIS send establish correspondence ? Mirror of the store's
      // `qEstab`: only a user-authored frame does; automatic carriers default
      // to false at the handler. Absent opts default to establishing, matching
      // the real layer.
      const establishesCorrespondence = opts?.establishesCorrespondence ?? true;
      // The group-aware collapse, mirrored (see the store's enqueue):
      // scoped pair key, roster-divided recipient caps, group-aware
      // establishment walk. Absent ctx = every line below as it always was.
      const ctx = opts?.groupCtx;
      const senderScope = ctx?.senderScope ?? msg.senderId;
      const rosterSize = Math.max(1, Math.floor(ctx?.recipientRosterSize ?? 1));
      const shareOf = (cap: number): number =>
        rosterSize > 1 ? Math.max(1, Math.floor(cap / rosterSize)) : cap;
      // Established = the RECIPIENT has itself USER-AUTHORED to this sender
      // WITHIN THE ESTABLISHMENT WINDOW (their reverse pair ledger's
      // `estabExpiresAt` is still in the future) — the existence-only rule was
      // mintable by the victim's own carriers and the shared-expiry rule
      // was renewable indefinitely through induced automatic carriers
      //. Automatic carriers refresh the general `expiresAt` but
      // never `estabExpiresAt`, so establishment ages on the user-authored
      // clock alone.
      // BOTH clocks gate, exactly as the store's getPairLedger does
      // — the rule now lives in `anyEstablished`, one body for
      // this classification, the single-key signal, and the walk, so the
      // twin cannot drift a clock the store checks. With group context the
      // walk covers every (recipient scope key, sender member partition) —
      // linking a device never resets an established pair to stranger.
      const established = anyEstablished(
        ctx ? ctx.recipientKeys : [msg.recipientId],
        ctx ? ctx.senderMembers : [msg.senderId],
        nowSeconds,
      );
      const effItems = shareOf(
        established ? quota.items : Math.min(quota.items, quota.unknownItems),
      );
      const effBytes = shareOf(
        established ? quota.bytes : Math.min(quota.bytes, quota.unknownBytes),
      );
      // The group ADMISSION WALK, mirrored: sum every
      // ledger the logical relationship may be billed — {senderScope} ∪
      // sender member ULIDs across the recipient's member partitions — and
      // refuse when the TOTAL would exceed the ONE-account allowance, so
      // per-ULID rows billed before a link (or under a larger pre-transition
      // share) can never fork into a fresh full group allowance. Same-
      // partition legacy residue also shrinks this partition's headroom,
      // matching the store's transactional half.
      let txnMaxItems = effItems;
      let txnMaxBytes = effBytes;
      if (ctx) {
        const writerKeys = [...new Set([senderScope, ...ctx.senderMembers])];
        const partitions = [...new Set(ctx.recipientMembers)];
        const capTotalItems = established
          ? quota.items
          : Math.min(quota.items, quota.unknownItems);
        const capTotalBytes = established
          ? quota.bytes
          : Math.min(quota.bytes, quota.unknownBytes);
        let totalItems = 0;
        let totalBytes = 0;
        let legacyItems = 0;
        let legacyBytes = 0;
        for (const partition of partitions) {
          for (const writer of writerKeys) {
            const row = pairLedgers.get(pairKey(writer, partition));
            if (row === undefined || row.expiresAt <= nowSeconds) continue;
            totalItems += row.items;
            totalBytes += row.bytes;
            if (partition === msg.recipientId && writer !== senderScope) {
              legacyItems += row.items;
              legacyBytes += row.bytes;
            }
          }
        }
        if (totalItems + 1 > capTotalItems || totalBytes + newBytes > capTotalBytes) {
          throw new QueuedQuotaExceededError();
        }
        txnMaxItems = effItems - legacyItems;
        txnMaxBytes = effBytes - legacyBytes;
        if (txnMaxItems < 1 || newBytes > txnMaxBytes) throw new QueuedQuotaExceededError();
      }
      const pair = pairLedgers.get(pairKey(senderScope, msg.recipientId)) ?? {
        items: 0,
        bytes: 0,
        expiresAt: 0,
        established: false,
        estabExpiresAt: 0,
      };
      if (pair.items + 1 > txnMaxItems || pair.bytes + newBytes > txnMaxBytes) {
        throw new QueuedQuotaExceededError();
      }
      const stranger = strangerLedgers.get(msg.recipientId) ?? {
        items: 0,
        bytes: 0,
        expiresAt: 0,
      };
      if (
        !established &&
        (stranger.items + 1 > shareOf(quota.unknownTotalItems) ||
          stranger.bytes + newBytes > shareOf(quota.unknownTotalBytes))
      ) {
        throw new QueuedQuotaExceededError();
      }
      // Commit — every check passed; ledgers and row move together. The
      // clocks take Math.max, NEVER the last committer: the
      // store enforces the same monotonicity (creation-only in the admission
      // transaction, a forward-only conditional bump after it), so a reversed
      // commit order cannot regress a clock in EITHER twin. The twin had max
      // for the establishment clock but last-committer-wins was live in the
      // store — this line is the general clock's half of the same rule.
      pair.items += 1;
      pair.bytes += newBytes;
      pair.expiresAt = Math.max(pair.expiresAt, msg.expiresAt);
      // A user-authored send marks the pair sticky (mirror of the store's
      // `SET qEstab`, kept for the reap decision) AND pushes the
      // establishment's own expiry forward (mirror of `qEstabExpiresAt`).
      // An automatic carrier does neither — it only rode the
      // general `expiresAt` above.
      if (establishesCorrespondence) {
        pair.established = true;
        pair.estabExpiresAt = Math.max(pair.estabExpiresAt, msg.expiresAt);
      }
      pairLedgers.set(pairKey(senderScope, msg.recipientId), pair);
      if (senderScope !== msg.senderId) {
        const billedPairs = pairBilled.get(msg.recipientId) ?? new Map<string, string>();
        billedPairs.set(msg.msgId, senderScope);
        pairBilled.set(msg.recipientId, billedPairs);
      }
      if (!established) {
        stranger.items += 1;
        stranger.bytes += newBytes;
        // Monotonic like the pair clock.
        stranger.expiresAt = Math.max(stranger.expiresAt, msg.expiresAt);
        strangerLedgers.set(msg.recipientId, stranger);
        const billed = strangerBilled.get(msg.recipientId) ?? new Set<string>();
        billed.add(msg.msgId);
        strangerBilled.set(msg.recipientId, billed);
      }
      q.set(msg.msgId, msg);
      queues.set(msg.recipientId, q);
      return { inserted: true };
    },
    async reconcileQueueLedger() {
      // The twin of the store's leased, budgeted drift repair — and a
      // DELIBERATE, DOCUMENTED no-op. The store's
      // reconciler exists for exactly one writer this layer cannot transact
      // with: DynamoDB TTL, which reaps message rows without touching their
      // ledger, drifting the ledger HIGH. This twin has NO TTL reaper (rows
      // leave only through the ack path, which releases the ledger in the
      // same synchronous step), so a memory ledger can never drift and there
      // is never anything to heal. 'complete' is the truthful outcome of a
      // scan over an undrifted ledger: the counts already match the rows.
      // The twin's enqueue therefore also schedules nothing on refusal — a
      // twin refusal is always a TRUE cap, never drift.
      return 'complete' as const;
    },
    async *listQueuedMessages(recipientId, afterMsgId) {
      const q = queues.get(recipientId);
      if (!q) return;
      const all = [...q.values()]
        .filter((m) => afterMsgId === undefined || m.msgId > afterMsgId)
        .sort((a, b) => (a.msgId < b.msgId ? -1 : 1));
      // Paged like the real layer (DynamoDB pages by size; this twin pages by
      // count) so consumers written against the stream meet multiple pages in
      // unit tests, not only in the DynamoDB Local integration suites.
      for (let i = 0; i < all.length; i += MEMORY_QUEUE_PAGE_SIZE) {
        yield all.slice(i, i + MEMORY_QUEUE_PAGE_SIZE);
      }
    },
    async *listUrgentQueuedMessages(recipientId, maxScanned) {
      const q = queues.get(recipientId);
      if (!q) return;
      // Mirror the store: the scan bound counts EVALUATED rows in key order,
      // BEFORE the urgent filter — an urgent row past it is not returned,
      // exactly as DynamoDB's Limit-then-filter leaves it out.
      const urgent = [...q.values()]
        .sort((a, b) => (a.msgId < b.msgId ? -1 : 1))
        .slice(0, Math.max(0, maxScanned))
        .filter((m) => m.urgent === true);
      for (let i = 0; i < urgent.length; i += MEMORY_QUEUE_PAGE_SIZE) {
        yield urgent.slice(i, i + MEMORY_QUEUE_PAGE_SIZE);
      }
    },
    async getQueuedMessage(recipientId, msgId) {
      // The memory twin of the strongly-consistent point read: a Map is
      // always consistent with itself, so this is just the lookup.
      if (isQueueControlKey(msgId)) return undefined;
      return queues.get(recipientId)?.get(msgId);
    },

    async deleteQueuedMessage(recipientId, msgId) {
      // Mirror the real release transaction: the row and its ledger share one
      // synchronous step, a second ack of the same msgId finds no row and
      // releases nothing.
      //
      // DELIBERATE, DOCUMENTED DIVERGENCE from the store: the
      // DynamoDB layer SKIPS the ledger decrement for a TTL-lagged EXPIRED row,
      // because a refusal-path recount may already have excluded it (so a
      // decrement would double-release). This twin has NO TTL reaper and NO
      // reconcile path, so an expired row is still fully counted in its ledger
      // and MUST be released here — there is no already-corrected count to
      // double-free. Mirroring the store's skip would LEAK the count. Releasing
      // unconditionally is the faithful behaviour for a store with neither TTL
      // lag nor reconciliation.
      if (isQueueControlKey(msgId)) return;
      const q = queues.get(recipientId);
      const row = q?.get(msgId);
      if (!q || !row) return;
      q.delete(msgId);
      const rowBytes = Buffer.byteLength(row.payload, 'utf8');
      // Release against the ledger the row was BILLED under: the
      // billing stamp when the sender was group-collapsed, else the literal
      // sender — the twin of the store reading `qPair` off the row.
      const billedScope = pairBilled.get(recipientId)?.get(msgId) ?? row.senderId;
      pairBilled.get(recipientId)?.delete(msgId);
      const pair = pairLedgers.get(pairKey(billedScope, recipientId));
      if (pair) {
        pair.items -= 1;
        pair.bytes -= rowBytes;
        // reap a zero-count pair ledger the recipient never had
        // user-authored correspondence over, mirroring the store's conditional
        // delete keyed on `attribute_not_exists(qEstab)`. An ESTABLISHED pair
        // (ever `qEstab`) SURVIVES at zero as the correspondence signal.
        if (pair.items <= 0 && pair.established !== true) {
          pairLedgers.delete(pairKey(billedScope, recipientId));
        }
      }
      if (strangerBilled.get(recipientId)?.delete(msgId)) {
        const stranger = strangerLedgers.get(recipientId);
        if (stranger) {
          stranger.items -= 1;
          stranger.bytes -= rowBytes;
        }
      }
    },
    async hasQueuedCorrespondence(senderId, recipientId, nowSeconds) {
      // ESTABLISHED, not merely EXISTS and FRESH on the establishment's
      // own clock — the existence-only signal was mintable by the
      // victim's own automatic carriers, and the shared-expiry signal was
      // renewable indefinitely through induced ones. The GENERAL clock gates
      // too, exactly as the store's getPairLedger treats a generally-expired
      // row as absent — under monotonic clocks the two checks
      // agree, and checking only one here was the divergence that masked the
      // store's regression.
      const ledger = pairLedgers.get(pairKey(senderId, recipientId));
      return (
        ledger !== undefined &&
        ledger.expiresAt > nowSeconds &&
        ledger.estabExpiresAt > nowSeconds
      );
    },
    async hasQueuedCorrespondenceAny(writerKeys, receiverPartitions, nowSeconds) {
      // The group-aware walk — one shared body (`anyEstablished`) with
      // the enqueue classification, the store's rule mirrored.
      return anyEstablished(writerKeys, receiverPartitions, nowSeconds);
    },
    async writeConsentEdge(userId, agentId, _nowMs) {
      // Mirrors the transaction's conditions in their store order and
      // precedence: the idempotent re-consent answers 'already' even at the
      // cap (it needs no slot — it holds one), and the cap is checked in the
      // same synchronous step as the write so concurrent writes cannot both
      // pass. The mirror must not drift more permissive than the store.
      // THE PER-GROUP CAP mirrored: a grouped
      // caller's 16 slots are the GROUP's — the sum of every member's edge
      // count (the twin of the store's `#count` walk + pins). A solo caller
      // keeps the shipped per-partition cap. 'contended' never occurs here:
      // read and write are one synchronous step, so there is no pin to lose.
      const edges = consentEdges.get(userId) ?? new Set<string>();
      if (edges.has(agentId)) return 'already';
      const callerRow = usersById.get(userId);
      const callerGroup =
        callerRow?.groupId !== undefined ? accountGroups.get(callerRow.groupId) : undefined;
      const consentTotal =
        callerGroup && callerGroup.members.some((m) => m.userId === userId)
          ? callerGroup.members.reduce(
              (sum, m) => sum + (consentEdges.get(m.userId)?.size ?? 0),
              0,
            )
          : edges.size;
      if (consentTotal >= CONSENT_MAX_EDGES) return 'cap_reached';
      edges.add(agentId);
      consentEdges.set(userId, edges);
      return 'written';
    },
    async deleteConsentEdge(userId, agentId) {
      // Idempotent, and the slot release rides the same step as the removal
      // (Set semantics ARE the exactly-once shape the store's transaction
      // buys): a double delete finds no edge and releases nothing.
      consentEdges.get(userId)?.delete(agentId);
    },
    async hasConsentEdge(userId, agentId) {
      // The control-key refusal mirrored (belt in both layers).
      if (agentId === '#count') return false;
      return consentEdges.get(userId)?.has(agentId) === true;
    },
    async purgeConsentEdges(userId) {
      consentEdges.delete(userId);
    },

    // --- Optional account grouping ---
    async getAccountGroup(groupId) {
      const group = accountGroups.get(groupId);
      if (!group) return undefined;
      // Copies out, so a caller mutating its view cannot corrupt the store —
      // the map entry is the twin's "row".
      return {
        groupId,
        members: group.members.map((m) => ({
          ...m,
          ...(m.certs !== undefined ? { certs: { ...m.certs } } : {}),
        })),
        identifierRefs: [...group.identifierRefs],
        ...(group.usernameRenamedAt !== undefined
          ? { usernameRenamedAt: group.usernameRenamedAt }
          : {}),
        epoch: group.epoch,
        createdAt: group.createdAt,
        ...(group.discoverableAfter !== undefined
          ? { discoverableAfter: group.discoverableAfter }
          : {}),
        ...(group.attachCreated === true ? { attachCreated: true } : {}),
      };
    },
    async isAccountsFeatureEnabled() {
      return accountsFeatureOn;
    },
    async isAccountsPhoneFeatureEnabled() {
      return accountsPhoneFeatureOn;
    },
    async isAccountsUsernameFeatureEnabled() {
      return accountsUsernameFeatureOn;
    },
    async getClientPolicy() {
      return parseClientPolicyItem(clientPolicyItem);
    },
    async putLinkOffer(rec) {
      // Same loud throws as the store: malformed tuples are caller bugs.
      if ((rec.rosterEpoch === 0) !== (rec.offererClass !== undefined)) {
        throw new Error('link offer: offererClass present iff first link (rosterEpoch 0)');
      }
      if (rec.offererUserId === rec.acceptorUserId) {
        throw new Error('link offer: a device cannot link to itself');
      }
      if (rec.offererClass !== undefined && rec.offererClass === rec.acceptorClass) {
        throw new Error('link offer: first link cannot declare one class twice');
      }
      if (linkOffers.has(rec.offerNonce)) return 'exists';
      // The store writes reverse nonce pointers onto both named users' rows
      // in the same transaction and refuses
      // rather than minting ghost rows; the twin mirrors the REFUSAL — the
      // pointer sets themselves are unobservable through the DataLayer
      // surface (only the sweep and raw-row tests read them), and the
      // twin's offers die with the map, so parity lives in the refusal.
      if (!usersById.has(rec.offererUserId) || !usersById.has(rec.acceptorUserId)) {
        return 'unknown_member';
      }
      linkOffers.set(rec.offerNonce, { ...rec });
      return 'created';
    },
    async getLinkOffer(offerNonce, nowSeconds) {
      const rec = linkOffers.get(offerNonce);
      if (!rec) return undefined;
      // The clock decides, not the reaper (the store's rule, mirrored) —
      // and the refusing read reaps.
      if (rec.expiresAt <= nowSeconds) {
        reapExpiredLinkOffer('offer', rec);
        return undefined;
      }
      return { ...rec };
    },
    async putLinkOfferInit(rec, nowSeconds) {
      if ((rec.rosterEpoch === 0) !== (rec.offererClass !== undefined)) {
        throw new Error('link offer: offererClass present iff first link (rosterEpoch 0)');
      }
      if (rec.offererUserId === rec.acceptorUserId) {
        throw new Error('link offer: a device cannot link to itself');
      }
      if (rec.offererClass !== undefined && rec.offererClass === rec.acceptorClass) {
        throw new Error('link offer: first link cannot declare one class twice');
      }
      if (linkOfferInits.has(rec.offerNonce)) return 'exists';
      if (!usersById.has(rec.offererUserId) || !usersById.has(rec.acceptorUserId)) {
        return 'unknown_member';
      }
      // The offerer's own pointer, under the cap-with-reap.
      if (addLinkOfferPointer(rec.offererUserId, rec.offerNonce, nowSeconds) === 'pointer_cap') {
        return 'pointer_cap';
      }
      linkOfferInits.set(rec.offerNonce, { ...rec });
      return 'created';
    },
    async getLinkOfferInit(offerNonce, nowSeconds) {
      const rec = linkOfferInits.get(offerNonce);
      if (!rec) return undefined;
      if (rec.expiresAt <= nowSeconds) {
        reapExpiredLinkOffer('init', rec);
        return undefined;
      }
      return { ...rec };
    },
    async promoteLinkOfferInit(offerNonce, offerSig, nowSeconds) {
      const rec = linkOfferInits.get(offerNonce);
      // Consumed, expired-but-unreaped, or never existed: one answer, the
      // store's conditional-delete refusal mirrored (the expired row reaped
      // at the refusing read, as the store's readLinkOfferInit does).
      if (!rec) return 'gone';
      if (rec.expiresAt <= nowSeconds) {
        reapExpiredLinkOffer('init', rec);
        return 'gone';
      }
      if (linkOffers.has(offerNonce)) return 'gone';
      // The acceptor's pointer — the row the caller does NOT own — under the
      // same cap-with-reap; an acceptor deleted since init is the store's
      // attribute_exists refusal ('gone').
      if (!usersById.has(rec.acceptorUserId)) return 'gone';
      if (addLinkOfferPointer(rec.acceptorUserId, offerNonce, nowSeconds) === 'pointer_cap') {
        return 'pointer_cap';
      }
      linkOfferInits.delete(offerNonce);
      linkOffers.set(offerNonce, { ...rec, offerSig });
      return 'promoted';
    },
    async userAccountState(userId) {
      const row = usersById.get(userId);
      if (row === undefined) return 'absent';
      return row.tombstoned === true ? 'tombstoned' : 'live';
    },
    async linkDeviceToGroup({ offerNonce, acceptSig, nowSeconds, linkedAtMs }) {
      const offer = linkOffers.get(offerNonce);
      if (!offer) return 'offer_consumed';
      if (offer.expiresAt <= nowSeconds) {
        reapExpiredLinkOffer('offer', offer);
        return 'offer_expired';
      }
      const { groupId, offererUserId, acceptorUserId, acceptorClass, offererClass, rosterEpoch } =
        offer;
      if (acceptorClass === 'desktop' || offererClass === 'desktop') return 'desktop_reserved';
      // Full signed-tuple context on the certs, mirroring the store
      //: the consume deletes the offer row,
      // so the certificate carries every preimage field except the subject
      // identity keys (verifiers supply those from their own pins).
      const certs: AccountGroupMember['certs'] = {
        offerSig: offer.offerSig,
        acceptSig,
        groupId,
        offererUserId,
        acceptorUserId,
        class: acceptorClass,
        rosterEpoch,
        offerNonce,
        expiresAt: offer.expiresAt,
      };
      const acceptorRow = usersById.get(acceptorUserId);
      const offererRow = usersById.get(offererUserId);
      if (!acceptorRow || !offererRow) return 'unknown_member';
      // The human-class refusal mirrored: agents never occupy
      // device slots — the twin of the store's
      // `attribute_not_exists(accountClass)` transaction conditions.
      if (acceptorRow.accountClass !== undefined || offererRow.accountClass !== undefined) {
        return 'integration_class';
      }
      // THE MERGED-CAP REFUSAL mirrored: sum crew + consent state
      // over every party of the would-be merged roster in the same
      // synchronous step the store's pins make atomic.
      {
        const existing =
          rosterEpoch === 0
            ? []
            : (accountGroups.get(groupId)?.members ?? []).map((m) => m.userId);
        const partyIds = [...new Set([offererUserId, acceptorUserId, ...existing])];
        const mergedCrew = partyIds.reduce(
          (sum, id) => sum + (usersById.get(id)?.crewCount ?? 0),
          0,
        );
        const mergedConsent = partyIds.reduce(
          (sum, id) => sum + (consentEdges.get(id)?.size ?? 0),
          0,
        );
        if (mergedCrew > CREW_MAX_MEMBERS || mergedConsent > CONSENT_MAX_EDGES) {
          return 'cap_exceeded';
        }
      }
      // Refusal order mirrors the store's cancellation classification:
      // group-row conditions first, then the acceptor's pristineness, then
      // offerer drift. The mirror must not drift more permissive than the
      // store (the adoptCrewMember rule).
      if (rosterEpoch === 0) {
        if (accountGroups.has(groupId)) return 'stale_epoch';
        if (acceptorRow.groupId !== undefined) return 'already_grouped';
        if (offererRow.groupId !== undefined) return 'already_grouped';
        accountGroups.set(groupId, {
          members: [
            {
              userId: offererUserId,
              class: offererClass as NonNullable<typeof offererClass>,
              linkedAt: linkedAtMs,
              certs,
            },
            { userId: acceptorUserId, class: acceptorClass, linkedAt: linkedAtMs, certs },
          ],
          identifierRefs: [],
          epoch: 1,
          createdAt: linkedAtMs,
        });
        offererRow.groupId = groupId;
        acceptorRow.groupId = groupId;
      } else {
        const group = accountGroups.get(groupId);
        if (!group || group.epoch !== rosterEpoch) return 'stale_epoch';
        // The offerer must be in the AUTHORITATIVE roster: a user
        // row still naming this groupId is a pointer,
        // never membership — the store's `contains(memberIds,:off)`
        // condition mirrored.
        if (!group.members.some((m) => m.userId === offererUserId)) return 'stale_epoch';
        if (group.members.some((m) => m.class === acceptorClass)) return 'class_occupied';
        if (group.members.length >= ACCOUNT_GROUP_MAX_MEMBERS) return 'group_full';
        if (acceptorRow.groupId !== undefined) return 'already_grouped';
        if (offererRow.groupId !== groupId) return 'stale_epoch';
        group.members.push({
          userId: acceptorUserId,
          class: acceptorClass,
          linkedAt: linkedAtMs,
          certs,
        });
        group.epoch = rosterEpoch + 1;
        acceptorRow.groupId = groupId;
      }
      // Consumed in the same synchronous step the roster committed in —
      // the twin's offer-consume conditional delete — and the winning nonce
      // leaves both reverse sets, as the store's `DELETE linkOfferNonces` does.
      linkOffers.delete(offerNonce);
      dropLinkOfferPointer(offererUserId, offerNonce);
      dropLinkOfferPointer(acceptorUserId, offerNonce);
      return 'linked';
    },
    async unlinkDeviceFromGroup(input) {
      const outcome = rosterRemovalStep(input, 'unlink');
      return outcome === 'done' ? 'unlinked' : outcome;
    },
    async revokeDeviceFromGroup(input) {
      const outcome = rosterRemovalStep(input, 'revoke');
      if (outcome === 'done') {
        // The victim's agent bindings die in the same step (binding
        // fate) — the twin of the store's same-transaction tombstones:
        // USER row AND idkey claim, so the read-time enforcement refuses the
        // agent's bearer too.
        for (const agent of input.agents ?? []) {
          const row = usersById.get(agent.userId);
          if (row) row.tombstoned = true;
          tombstonedKeys.add(agent.identityKeyPub);
        }
        return 'revoked';
      }
      return outcome;
    },
    async deleteGroupedUser(userId, groupId, claims, nowMs) {
      // The store's fused member-deletion transaction, one synchronous
      // step (the pairLedgers rule): roster removal + guarded row delete +
      // claim delete commit together or not at all. The crew backstop rides
      // the same step — a refused deletion destroys NOTHING, roster included.
      const group = accountGroups.get(groupId);
      if (!group) return 'unknown_group';
      const row = usersById.get(userId);
      if (!row || row.groupId !== groupId || !group.members.some((m) => m.userId === userId)) {
        return 'stale';
      }
      if ((row.crewCount ?? 0) > 0) return 'crew_not_empty';
      const outcome = rosterRemovalStep(
        {
          groupId,
          actingUserId: userId,
          targetUserId: userId,
          rosterEpoch: group.epoch,
          nowMs: nowMs ?? wallNowMs(),
        },
        'unlink',
      );
      if (outcome !== 'done') return outcome === 'unknown_group' ? 'unknown_group' : 'stale';
      usersById.delete(userId);
      // A tombstoned claim survives every deletion (the deleteUser rule,
      // mirrored — the store's keepClaim fallback).
      if (claims.identityKeyPub !== undefined && !tombstonedKeys.has(claims.identityKeyPub)) {
        usersByIdentityKey.delete(claims.identityKeyPub);
        usersById.delete(`${IDKEY_CLAIM_PREFIX}${claims.identityKeyPub}`);
        idkeyClaimOwner.delete(`${IDKEY_CLAIM_PREFIX}${claims.identityKeyPub}`);
      }
      return 'deleted';
    },

    async purgeLinkOffersForUser(offerNonces) {
      // The store deletes both namespaces per nonce (offer + init); the
      // twin's maps are exactly those namespaces. Idempotent — a dead nonce
      // deletes nothing.
      for (const nonce of offerNonces) {
        linkOffers.delete(nonce);
        linkOfferInits.delete(nonce);
      }
    },

    async tombstoneAgentBindings(agents) {
      // attribute_exists twin: a vanished agent row is a retryable conflict,
      // never a partial commit (the store's condition mirrored).
      if (agents.some((a) => !usersById.has(a.userId))) return 'binding_conflict';
      for (const agent of agents) {
        const row = usersById.get(agent.userId);
        if (row) row.tombstoned = true;
        tombstonedKeys.add(agent.identityKeyPub);
      }
      return 'done';
    },

    // --- Email linking + recovery the store mirrored ---
    async putEmailCode(rec) {
      emailCodes.set(codeSlot(rec.userId, rec.purpose), { ...rec });
    },
    async takeEmailCodeAttempt(userId, purpose, nowSeconds) {
      const rec = emailCodes.get(codeSlot(userId, purpose));
      // The store's conditional increment, one synchronous step: absent,
      // expired-but-unreaped (the clock, never a reaper), and cap-exhausted
      // all refuse BEFORE the caller ever compares a code — and the attempt
      // is spent by the ask, right or wrong. The refusing read REAPS the
      // expired case physically the store's conditional delete.
      if (!rec || rec.expiresAt <= nowSeconds || rec.attempts >= EMAIL_CODE_ATTEMPT_CAP) {
        if (rec !== undefined && rec.expiresAt <= nowSeconds) {
          emailCodes.delete(codeSlot(userId, purpose));
        }
        return undefined;
      }
      rec.attempts += 1;
      return { ...rec };
    },
    async deleteEmailCode(userId, purpose) {
      emailCodes.delete(codeSlot(userId, purpose));
    },
    async getIdentifierClaim(claimKey) {
      const rec = identifierClaims.get(claimKey);
      return rec ? { ...rec } : undefined;
    },
    async migrateIdentifierClaimForward({ oldClaimKey, newClaimKey, claim, newSkeletonKey }) {
      // The store's forward-migration mirrored (rotation): re-point the
      // group's ref and move the claim to the newest key, or no-op when the
      // group no longer names the old key (unlinked / already migrated).
      // A username claim moves with its skeleton row — the store's
      // throw on a missing newest-version skeleton key mirrored.
      if (claim.skeletonKey !== undefined && newSkeletonKey === undefined) {
        throw new Error('migrate: a username claim moves with its skeleton key');
      }
      const group = accountGroups.get(claim.groupId);
      if (!group || !group.identifierRefs.includes(oldClaimKey)) return 'noop';
      // The store's newest-key Puts are `attribute_not_exists(userId)`: a
      // LIVE row at either newest key refuses — and so does a TOMBSTONE
      // (elapsed or not, it is a row at the key until the reaping read
      // takes it) — the twin-drift rule.
      if (identifierClaims.has(newClaimKey) || usernameTombstones.has(newClaimKey)) return 'noop';
      if (
        newSkeletonKey !== undefined &&
        (usernameSkeletons.has(newSkeletonKey) || usernameTombstones.has(newSkeletonKey))
      ) {
        return 'noop';
      }
      group.identifierRefs = group.identifierRefs.map((ref) =>
        ref === oldClaimKey ? newClaimKey : ref,
      );
      identifierClaims.set(newClaimKey, {
        ...claim,
        claimKey: newClaimKey,
        ...(newSkeletonKey !== undefined ? { skeletonKey: newSkeletonKey } : {}),
      });
      identifierClaims.delete(oldClaimKey);
      if (claim.skeletonKey !== undefined && newSkeletonKey !== undefined) {
        usernameSkeletons.set(newSkeletonKey, { groupId: claim.groupId, claimKey: newClaimKey });
        const old = usernameSkeletons.get(claim.skeletonKey);
        if (old === undefined || old.groupId === claim.groupId) {
          usernameSkeletons.delete(claim.skeletonKey);
        }
      }
      return 'migrated';
    },
    async isIdentifierSuppressed(suppressionKey, nowSeconds) {
      // The store's expiry-and-reap read: a live shadow suppresses; an
      // elapsed one answers false AND dies at this read.
      const expiresAt = emailSuppressions.get(suppressionKey);
      if (expiresAt === undefined) return false;
      if (expiresAt > nowSeconds) return true;
      emailSuppressions.delete(suppressionKey);
      return false;
    },
    async putIdentifierSuppression(suppressionKey, nowMs) {
      // Per-class TTL by the key's prefix (the store's
      // rule): today the two pins are aliases; the twin mirrors the read so
      // a future divergence diverges here too.
      emailSuppressions.set(
        suppressionKey,
        Math.floor(nowMs / 1000) +
          (suppressionKey.startsWith('phonesupp#')
            ? PHONE_SUPPRESSION_TTL_SECONDS
            : EMAIL_SUPPRESSION_TTL_SECONDS),
      );
    },
    async getIdentifierRecoveryCooldown(claimKeys, nowSeconds) {
      // The store's shadow walk mirrored (class-aware from): max
      // still-live stamp, the explicit clock deciding — and an ELAPSED
      // shadow reaped by the walk.
      let live: number | undefined;
      for (const claimKey of claimKeys) {
        const key = cooldownKeyFromClaimKey(claimKey);
        const until = emailCooldowns.get(key);
        if (until === undefined) continue;
        if (until <= nowSeconds) {
          emailCooldowns.delete(key);
          continue;
        }
        if (live === undefined || until > live) live = until;
      }
      return live;
    },
    async attachIdentifier({ userId, deviceClass, existingGroupId, newGroupId, claimKey, refsSnapshot, retiringClaimKeys, nowMs, discoverableAfter }) {
      // The structural per-class backstop mirrored (first as in the
      // store): a matching snapshot already holding this class's ref refuses
      // before anything else — at cap 3 the size total no longer refuses
      // it by coincidence.
      if (
        existingGroupId !== undefined &&
        (refsSnapshot ?? []).some(
          (ref) => identifierClassForClaimKey(ref) === identifierClassForClaimKey(claimKey),
        )
      ) {
        return 'identifier_cap';
      }
      // Mirror order matches the store's cancellation classification: claim
      // uniqueness, then the group condition, then the code consume — one
      // synchronous step, so interleaved attaches admit exactly what the
      // store's TransactWriteItems would.
      if (identifierClaims.has(claimKey)) return 'claim_exists';
      // The rotation-window uniqueness condition mirrored:
      // a retiring-version claim held anywhere refuses the attach.
      if ((retiringClaimKeys ?? []).some((key) => identifierClaims.has(key))) {
        return 'claim_exists';
      }
      const code = emailCodes.get(codeSlot(userId, 'attach'));
      const codeValid = code !== undefined && code.purpose === 'attach' && code.claimKey === claimKey;
      if (existingGroupId !== undefined) {
        const group = accountGroups.get(existingGroupId);
        if (!group || !group.members.some((m) => m.userId === userId)) return 'unknown_member';
        // The PER-CLASS cap mirrored: exact snapshot equality — the
        // handler class-checked the snapshot, so a moved list refuses; the
        // classification mirrors the store's UX re-read (same-class ref
        // present = the slot filled; otherwise a raced snapshot).
        const snap = refsSnapshot ?? [];
        if (
          group.identifierRefs.length !== snap.length ||
          !snap.every((k, i) => group.identifierRefs[i] === k) ||
          // The store's size backstop mirrored: even a
          // MATCHING snapshot cannot grow the refs past the pinned
          // total — the storage layer refuses, whatever the caller checked.
          group.identifierRefs.length >= MAX_VERIFIED_IDENTIFIERS_PER_GROUP
        ) {
          // The store's exhaustive dispatch mirrored: a
          // username key throws by name here too, never reads as email.
          const classPrefix = attachClassPrefixForClaimKey(claimKey);
          return group.identifierRefs.some((ref) => ref.startsWith(classPrefix))
            ? 'identifier_cap'
            : 'stale';
        }
        // The caller-class pin mirrored: only a
        // live human row attaches to an existing group.
        const callerRow = usersById.get(userId);
        if (!callerRow || callerRow.accountClass !== undefined || callerRow.tombstoned === true) {
          return 'unknown_member';
        }
        if (!codeValid) return 'code_gone';
        group.identifierRefs.push(claimKey);
      } else {
        const row = usersById.get(userId);
        if (!row) return 'unknown_member';
        // The class condition mirrored: an integration can never
        // found a lazy solo group. Same answer class as the store's
        // re-read classification (row exists, write refused).
        if (row.groupId !== undefined || row.accountClass !== undefined) {
          return 'already_grouped';
        }
        if (!codeValid) return 'code_gone';
        accountGroups.set(newGroupId, {
          // No ceremony ⇒ no certs, honestly (the store's rule). The
          // attachCreated marker is the lazy-solo dissolve's carrier.
          members: [{ userId, class: deviceClass, linkedAt: nowMs }],
          identifierRefs: [claimKey],
          epoch: 1,
          createdAt: nowMs,
          attachCreated: true,
        });
        row.groupId = newGroupId;
      }
      identifierClaims.set(claimKey, {
        claimKey,
        groupId: existingGroupId ?? newGroupId,
        createdAt: nowMs,
        verifiedAt: nowMs,
        discoverable: false,
        // The re-arm carried from the group row (the store's rule).
        ...(discoverableAfter !== undefined ? { discoverableAfter } : {}),
      });
      emailCodes.delete(codeSlot(userId, 'attach'));
      return 'attached';
    },
    async unlinkIdentifierClass({ userId, groupId, refsSnapshot, claimKeys }) {
      const group = accountGroups.get(groupId);
      if (!group) return 'unknown_group';
      if (!group.members.some((m) => m.userId === userId)) return 'not_member';
      // The UNCHANGED-full-snapshot condition mirrored (per-class from
      //): the refs must equal the caller's full snapshot exactly, or
      // nothing moves.
      if (
        group.identifierRefs.length !== refsSnapshot.length ||
        !refsSnapshot.every((k, i) => group.identifierRefs[i] === k)
      ) {
        return 'stale';
      }
      const removed = new Set(claimKeys);
      const remainder = refsSnapshot.filter((ref) => !removed.has(ref));
      for (const key of claimKeys) {
        const claim = identifierClaims.get(key);
        if (!claim || claim.groupId === groupId) identifierClaims.delete(key);
      }
      // THE LAZY-SOLO REAP mirrored (per-class from
      // ONLY on an EMPTY remainder, the LAST class's unlink): a
      // still-unmutated attach-created solo group dissolves with its last
      // identifier — the group row, the founder's groupId, and any pending
      // recovery die in the same synchronous step, returning the account to
      // never-opted-in.
      if (
        remainder.length === 0 &&
        group.attachCreated === true &&
        group.epoch === 1 &&
        group.members.length === 1 &&
        group.members[0]!.userId === userId
      ) {
        accountGroups.delete(groupId);
        const row = usersById.get(userId);
        if (row?.groupId === groupId) delete row.groupId;
        const pending = recoveries.get(groupId);
        if (pending !== undefined) {
          recoveries.delete(groupId);
          const recRow = usersById.get(pending.newUserId);
          if (recRow?.recoveryGroupId === groupId) delete recRow.recoveryGroupId;
        }
        return 'unlinked';
      }
      group.identifierRefs = remainder;
      return 'unlinked';
    },
    async setIdentifierDiscoverable(claimKey, groupId, actingUserId, discoverable) {
      // The store's in-transaction membership condition mirrored:
      // only a CURRENT member of the claim's group toggles.
      const group = accountGroups.get(groupId);
      if (!group || !group.members.some((m) => m.userId === actingUserId)) return 'gone';
      // The actor-class pin mirrored.
      const actorRow = usersById.get(actingUserId);
      if (!actorRow || actorRow.accountClass !== undefined || actorRow.tombstoned === true) {
        return 'gone';
      }
      const claim = identifierClaims.get(claimKey);
      if (!claim || claim.groupId !== groupId) return 'gone';
      claim.discoverable = discoverable;
      return 'set';
    },
    async putRecoveryPending(rec) {
      const standing = recoveries.get(rec.groupId);
      // A cancelled or expired row is not pending (the store's condition):
      // a fresh legitimate recovery replaces it.
      if (
        standing &&
        standing.canceled !== true &&
        standing.expiresAt > Math.floor(rec.requestedAt / 1000)
      ) {
        return 'exists';
      }
      const row = usersById.get(rec.newUserId);
      if (!row) return 'unknown_member';
      // The class arm mirrors the store's condition: an agent never
      // drives a recovery ceremony.
      if (row.groupId !== undefined || row.tombstoned === true || row.accountClass !== undefined) {
        return 'not_pristine';
      }
      // The liveness pins mirrored: the claim
      // must still name the group and the group row must still exist AT
      // COMMIT, or a sweep racing the handler's precheck would mint an
      // orphan recovery row for a dead group.
      const claim = identifierClaims.get(rec.claimKey);
      if (!claim || claim.groupId !== rec.groupId) return 'stale';
      if (!accountGroups.has(rec.groupId)) return 'stale';
      recoveries.set(rec.groupId, {
        ...rec,
        // Derived from the proving claim key's PREFIX — a caller-supplied
        // identifierClass is ignored, the store's rule; the
        // recovery-lane narrowing mirrored too — a username-class key
        // throws here exactly as the real store would.
        identifierClass: recoveryIdentifierClassForClaimKey(rec.claimKey),
      });
      row.recoveryGroupId = rec.groupId;
      // The displaced device's pointer clears with the replacement,
      // conditioned on still naming this group.
      if (standing !== undefined && standing.newUserId !== rec.newUserId) {
        const displaced = usersById.get(standing.newUserId);
        if (displaced?.recoveryGroupId === rec.groupId) delete displaced.recoveryGroupId;
      }
      return 'created';
    },
    async getRecoveryPending(groupId) {
      const rec = recoveries.get(groupId);
      // The claim-key prefix is authoritative and the read fails CLOSED
      // (the store's fix-pass rule): a phonehash#-proved row reads as
      // 'phone' whatever its stored attribute says; only a non-phone prefix
      // with no phone attribute reads 'email' (every genuine previous row —
      // reachable in the twin only through a hand-built legacy-shaped row).
      return rec
        ? {
            ...rec,
            identifierClass:
              rec.claimKey.startsWith('phonehash#') || rec.identifierClass === 'phone'
                ? ('phone' as const)
                : ('email' as const),
          }
        : undefined;
    },
    async cancelRecoveryPending(groupId, nowSeconds) {
      const rec = recoveries.get(groupId);
      if (!rec) return 'gone';
      // The store's expiry condition + reap: an expired row is not
      // cancellable (completion already refuses it by the clock) — the
      // cancel-shaped read deletes it and clears the reverse pointer.
      if (rec.expiresAt <= nowSeconds) {
        recoveries.delete(groupId);
        const recRow = usersById.get(rec.newUserId);
        if (recRow?.recoveryGroupId === groupId) delete recRow.recoveryGroupId;
        return 'gone';
      }
      rec.canceled = true;
      // A LIVE cancel clears the refused device's reverse pointer,
      // mirroring the store's post-cancel cleanup; the
      // canceled row itself stays (replaceable, readable-refusing).
      const canceledRow = usersById.get(rec.newUserId);
      if (canceledRow?.recoveryGroupId === groupId) delete canceledRow.recoveryGroupId;
      return 'canceled';
    },
    async completeRecovery({ groupId, newUserId, nowSeconds, linkedAtMs, discoverableAfter }) {
      const pending = recoveries.get(groupId);
      if (!pending || pending.newUserId !== newUserId) return { outcome: 'gone' };
      // The guards in the store's condition order: cancel WINS, then the
      // delay's own clock check — never a reaper, never advisory.
      if (pending.canceled === true) return { outcome: 'canceled' };
      if (pending.completesAt > nowSeconds) return { outcome: 'not_ready' };
      // The upper bound: past its window the row is stale, by
      // the clock never the reaper — and the refusing read REAPS it,
      // reverse pointer included, the store's conditional delete mirrored.
      if (pending.expiresAt <= nowSeconds) {
        recoveries.delete(groupId);
        const recRow = usersById.get(pending.newUserId);
        if (recRow?.recoveryGroupId === groupId) delete recRow.recoveryGroupId;
        return { outcome: 'stale' };
      }
      // The proving claim must still name this group: an unlink
      // during the window revoked the recovery's basis.
      const claim = identifierClaims.get(pending.claimKey);
      if (!claim || claim.groupId !== groupId) return { outcome: 'stale' };
      const group = accountGroups.get(groupId);
      if (!group) return { outcome: 'stale' };
      const newRow = usersById.get(newUserId);
      if (
        !newRow ||
        newRow.groupId !== undefined ||
        newRow.tombstoned === true ||
        // The class condition mirrored: an agent never becomes a
        // group member through any verb, recovery included.
        newRow.accountClass !== undefined
      ) {
        return { outcome: 'stale' };
      }
      const incumbentMember = group.members.find((m) => m.class === pending.deviceClass);
      if (!incumbentMember && group.members.length >= ACCOUNT_GROUP_MAX_MEMBERS) {
        return { outcome: 'stale' };
      }
      // THE MERGED-CAP SUM mirrored: recovery
      // admission never checked crew/consent state, so a lived-in solo
      // account can recover into a group — the post-recovery roster must
      // still fit the per-group caps, the link transaction's exact rule.
      {
        const nextIds = [
          ...group.members
            .filter((m) => m.userId !== incumbentMember?.userId)
            .map((m) => m.userId),
          newUserId,
        ];
        const mergedCrew = nextIds.reduce(
          (sum, id) => sum + (usersById.get(id)?.crewCount ?? 0),
          0,
        );
        const mergedConsent = nextIds.reduce(
          (sum, id) => sum + (consentEdges.get(id)?.size ?? 0),
          0,
        );
        if (mergedCrew > CREW_MAX_MEMBERS || mergedConsent > CONSENT_MAX_EDGES) {
          return { outcome: 'cap_exceeded' };
        }
      }
      let incumbent: { userId: string; identityKeyPub: string } | undefined;
      if (incumbentMember) {
        const victim = usersById.get(incumbentMember.userId);
        if (!victim?.identityKeyPub) return { outcome: 'stale' };
        incumbent = { userId: incumbentMember.userId, identityKeyPub: victim.identityKeyPub };
        victim.tombstoned = true;
        victim.formerGroupId = groupId;
        delete victim.groupId;
        tombstonedKeys.add(victim.identityKeyPub!);
      }
      const remaining = group.members.filter((m) => m.userId !== incumbentMember?.userId);
      group.members = [
        ...remaining,
        // No ceremony ⇒ no certs (peers owe the recovered device TOFU).
        { userId: newUserId, class: pending.deviceClass, linkedAt: linkedAtMs },
      ];
      group.epoch += 1;
      newRow.groupId = groupId;
      delete newRow.recoveryGroupId;
      for (const ref of group.identifierRefs) {
        const claim = identifierClaims.get(ref);
        if (claim && claim.groupId === groupId) claim.discoverableAfter = discoverableAfter;
      }
      // The GROUP-LEVEL carrier: survives an unlink of the claim
      // rows, so a re-minted claim re-arms from it.
      group.discoverableAfter = discoverableAfter;
      // The IDENTIFIER-keyed carriers (CROSS-CLASS —
      // the store's rule): completion arms a
      // shadow for EVERY identifier the group holds, both classes, plus the
      // proving claim key itself, so no re-attach loop in EITHER class
      // sheds the cool-down. A username ref maps to no shadow and is
      // filtered, not thrown on — the store's rule.
      for (const ref of new Set([pending.claimKey, ...group.identifierRefs])) {
        const shadowKey = cooldownShadowKeyForClaimKey(ref);
        if (shadowKey !== null) emailCooldowns.set(shadowKey, discoverableAfter);
      }
      recoveries.delete(groupId);
      return {
        outcome: 'completed',
        deviceClass: pending.deviceClass,
        rosterEpoch: group.epoch,
        ...(incumbent ? { incumbent } : {}),
        survivors: remaining.map((m) => m.userId),
      };
    },
    async purgeIdentifierArtifactsForUser(userId, hints, nowMs) {
      emailCodes.delete(codeSlot(userId, 'attach'));
      emailCodes.delete(codeSlot(userId, 'recovery'));
      if (hints.recoveryGroupId !== undefined) {
        const rec = recoveries.get(hints.recoveryGroupId);
        if (rec?.newUserId === userId) recoveries.delete(hints.recoveryGroupId);
      }
      if (hints.groupId === undefined) return;
      const group = accountGroups.get(hints.groupId);
      if (!group || group.members.length !== 1 || group.members[0]!.userId !== userId) return;
      // Username refs tombstoned, the rest deleted (the store's rule).
      disposeDissolvedRefs(group.identifierRefs, hints.groupId, nowMs ?? wallNowMs());
      accountGroups.delete(hints.groupId);
      recoveries.delete(hints.groupId);
    },

    // --- Username claims the store mirrored ---
    async getUsernameClaim(claimKey, nowSeconds) {
      const live = identifierClaims.get(claimKey);
      if (live) return { ...live };
      const tomb = usernameTombstones.get(claimKey);
      if (!tomb) return undefined;
      if (tomb.freesAt > nowSeconds) {
        const rec: UsernameTombstoneRecord = { claimKey, tombstoned: true, freesAt: tomb.freesAt };
        if (tomb.formerGroupId !== undefined) rec.formerGroupId = tomb.formerGroupId;
        if (tomb.skeletonKey !== undefined) rec.skeletonKey = tomb.skeletonKey;
        return rec;
      }
      // Elapsed: the read is the reaper (the store's conditional deletes —
      // only a still-elapsed TOMBSTONE goes; a live re-claim at either key
      // survives, which the live-map check above already guarantees here).
      usernameTombstones.delete(claimKey);
      if (tomb.skeletonKey !== undefined) {
        const skel = usernameTombstones.get(tomb.skeletonKey);
        if (skel !== undefined && skel.freesAt <= nowSeconds) {
          usernameTombstones.delete(tomb.skeletonKey);
        }
      }
      return undefined;
    },
    async claimUsername({
      userId,
      groupId,
      refsSnapshot,
      claimKey,
      skeletonKey,
      retiringClaimKeys,
      retiringSkeletonKeys,
      discoverable,
      discoverableAfter,
      reclaimingOwn = false,
      nowMs,
    }) {
      // The structural per-class backstop mirrored, first as in the store.
      if (refsSnapshot.some((ref) => identifierClassForClaimKey(ref) === 'username')) {
        return 'identifier_cap';
      }
      const nowSeconds = Math.floor(nowMs / 1000);
      // Mirror order matches the store's cancellation classification:
      // occupancy (either row, any version, the tombstone-aware rule) first,
      // then the group condition, then the caller pin — ONE synchronous
      // step, so interleaved claims admit exactly what the store's
      // TransactWriteItems would: one winner.
      for (const key of [claimKey, skeletonKey, ...retiringClaimKeys, ...retiringSkeletonKeys]) {
        if (!usernameKeyFree(key, nowSeconds, groupId)) return 'taken';
      }
      const group = accountGroups.get(groupId);
      if (!group || !group.members.some((m) => m.userId === userId)) return 'unknown_member';
      if (
        group.identifierRefs.length !== refsSnapshot.length ||
        !refsSnapshot.every((k, i) => group.identifierRefs[i] === k) ||
        group.identifierRefs.length >= MAX_VERIFIED_IDENTIFIERS_PER_GROUP
      ) {
        return group.identifierRefs.some((ref) => ref.startsWith(USERNAME_CLAIM_KEY_PREFIX))
          ? 'identifier_cap'
          : 'stale';
      }
      // THE COOL-DOWN ON THE CLAIM (the hoarding fix) — the store's group
      // condition clause, dropped for the reclaim of the group's own live
      // tombstone; refused WITHOUT consuming anything, never stamped here.
      if (
        !reclaimingOwn &&
        group.usernameRenamedAt !== undefined &&
        group.usernameRenamedAt > nowSeconds - USERNAME_RENAME_COOLDOWN_SECONDS
      ) {
        return 'cooldown';
      }
      const callerRow = usersById.get(userId);
      if (!callerRow || callerRow.accountClass !== undefined || callerRow.tombstoned === true) {
        return 'unknown_member';
      }
      group.identifierRefs.push(claimKey);
      identifierClaims.set(claimKey, {
        claimKey,
        groupId,
        createdAt: nowMs,
        verifiedAt: nowMs,
        // The EXPLICIT consent bit — the one birth write that may
        // set it ON.
        discoverable,
        skeletonKey,
        ...(discoverableAfter !== undefined ? { discoverableAfter } : {}),
      });
      usernameSkeletons.set(skeletonKey, { groupId, claimKey });
      // The Put-overwrites: any elapsed/former-owner tombstone at either key
      // is gone with the row that replaced it.
      usernameTombstones.delete(claimKey);
      usernameTombstones.delete(skeletonKey);
      return 'claimed';
    },
    async renameUsername({
      userId,
      groupId,
      refsSnapshot,
      oldClaimKey,
      claimKeys,
      skeletonKeys,
      discoverable,
      nowMs,
    }) {
      if (claimKeys.includes(oldClaimKey)) return 'same_name';
      if (!refsSnapshot.includes(oldClaimKey)) return 'stale';
      // The store's pre-read: a live row without its skeleton twin throws.
      const old = readLiveUsernameClaim(oldClaimKey);
      if (!old || old.groupId !== groupId || old.skeletonKey === undefined) return 'stale';
      const newClaimKey = claimKeys[0]!;
      const newSkeletonKey = skeletonKeys[0]!;
      const sameSkeleton = old.skeletonKey === newSkeletonKey;
      const nowSeconds = Math.floor(nowMs / 1000);
      // Occupancy first (the store's classification order), over every
      // version of both new rows — minus the rows this rename itself owns
      // (the old skeleton, shared or retiring-version twin).
      const own = new Set([oldClaimKey, old.skeletonKey]);
      for (const key of [...claimKeys, ...skeletonKeys]) {
        if (own.has(key)) continue;
        if (!usernameKeyFree(key, nowSeconds, groupId)) return 'taken';
      }
      const group = accountGroups.get(groupId);
      if (!group || !group.members.some((m) => m.userId === userId)) return 'unknown_member';
      if (
        group.identifierRefs.length !== refsSnapshot.length ||
        !refsSnapshot.every((k, i) => group.identifierRefs[i] === k)
      ) {
        return 'stale';
      }
      // THE COOL-DOWN AS A CONDITION — refused WITHOUT consuming anything.
      if (
        group.usernameRenamedAt !== undefined &&
        group.usernameRenamedAt > nowSeconds - USERNAME_RENAME_COOLDOWN_SECONDS
      ) {
        return 'cooldown';
      }
      const callerRow = usersById.get(userId);
      if (!callerRow || callerRow.accountClass !== undefined || callerRow.tombstoned === true) {
        return 'unknown_member';
      }
      // The five items, one synchronous step.
      const freesAt = usernameFreesAt(nowMs);
      identifierClaims.delete(oldClaimKey);
      usernameTombstones.set(oldClaimKey, {
        freesAt,
        formerGroupId: groupId,
        ...(sameSkeleton ? {} : { skeletonKey: old.skeletonKey }),
      });
      if (sameSkeleton) {
        usernameSkeletons.set(old.skeletonKey, { groupId, claimKey: newClaimKey });
      } else {
        usernameSkeletons.delete(old.skeletonKey);
        usernameTombstones.set(old.skeletonKey, { freesAt, formerGroupId: groupId });
        usernameSkeletons.set(newSkeletonKey, { groupId, claimKey: newClaimKey });
        usernameTombstones.delete(newSkeletonKey);
      }
      identifierClaims.set(newClaimKey, {
        claimKey: newClaimKey,
        groupId,
        createdAt: nowMs,
        verifiedAt: nowMs,
        discoverable,
        skeletonKey: sameSkeleton ? old.skeletonKey : newSkeletonKey,
        ...(old.discoverableAfter !== undefined ? { discoverableAfter: old.discoverableAfter } : {}),
      });
      usernameTombstones.delete(newClaimKey);
      group.identifierRefs = refsSnapshot.map((ref) => (ref === oldClaimKey ? newClaimKey : ref));
      // Consumed on SUCCESS only — stamped here, after every refusal above.
      group.usernameRenamedAt = nowSeconds;
      return 'renamed';
    },
    async unlinkUsername({ userId, groupId, refsSnapshot, claimKey, nowMs }) {
      if (!refsSnapshot.includes(claimKey)) return 'stale';
      // The store's pre-read position: a drifted live row throws HERE,
      // before the group checks (the result itself is re-read below).
      readLiveUsernameClaim(claimKey);
      const group = accountGroups.get(groupId);
      if (!group) return 'unknown_group';
      if (!group.members.some((m) => m.userId === userId)) return 'not_member';
      if (
        group.identifierRefs.length !== refsSnapshot.length ||
        !refsSnapshot.every((k, i) => group.identifierRefs[i] === k)
      ) {
        return 'stale';
      }
      const remainder = refsSnapshot.filter((ref) => ref !== claimKey);
      const dissolve =
        remainder.length === 0 &&
        group.attachCreated === true &&
        group.epoch === 1 &&
        group.members.length === 1 &&
        group.members[0]!.userId === userId;
      // The former-owner right exists only while the group survives to
      // exercise it (the store's rule: no dangling group id in a row).
      tombstoneUsernameRows(claimKey, groupId, nowMs, dissolve ? undefined : groupId);
      if (dissolve) {
        accountGroups.delete(groupId);
        const row = usersById.get(userId);
        if (row?.groupId === groupId) delete row.groupId;
        const pending = recoveries.get(groupId);
        if (pending !== undefined) {
          recoveries.delete(groupId);
          const recRow = usersById.get(pending.newUserId);
          if (recRow?.recoveryGroupId === groupId) delete recRow.recoveryGroupId;
        }
        return 'unlinked';
      }
      group.identifierRefs = remainder;
      // An unlink is a name change: the surviving group takes the rename
      // cool-down stamp (the store's Update, the hoarding fix).
      group.usernameRenamedAt = Math.floor(nowMs / 1000);
      return 'unlinked';
    },
    async revokeUsername({ claimKey, nowMs }) {
      const live = readLiveUsernameClaim(claimKey);
      if (!live) return { outcome: 'gone' };
      // Nobody-reclaims tombstones, the holder's ref shrunk — one step.
      tombstoneUsernameRows(claimKey, live.groupId, nowMs);
      const group = accountGroups.get(live.groupId);
      if (group) group.identifierRefs = group.identifierRefs.filter((ref) => ref !== claimKey);
      return { outcome: 'revoked', groupId: live.groupId };
    },

    // Test-only control, beyond the DataLayer surface: the production flag
    // row is operator-written (there is deliberately no write method), so
    // the twin's operator is the test.
    setAccountsFeatureEnabled(on: boolean) {
      accountsFeatureOn = on;
    },
    setAccountsPhoneFeatureEnabled(on: boolean) {
      accountsPhoneFeatureOn = on;
    },
    setAccountsUsernameFeatureEnabled(on: boolean) {
      accountsUsernameFeatureOn = on;
    },
    setClientPolicyRow(item: unknown) {
      clientPolicyItem = item;
    },
  };
}

/** Flatten the paged queue stream — the test-side "whole queue" view. Works
 * against either DataLayer implementation; only tests may afford this, which
 * is why it lives here and not on the interface. */
export async function allQueued(db: DataLayer, recipientId: string): Promise<QueuedMessage[]> {
  const out: QueuedMessage[] = [];
  for await (const page of db.listQueuedMessages(recipientId)) out.push(...page);
  return out;
}

/**
 * A deterministic, VALID libsignal-shaped identity key for tests that need an
 * account to exist but are not testing authentication itself.
 *
 * Deliberately not `PrivateKey.generate()`: most callers only need "this row
 * has some key", and a fresh keypair per call makes failures non-reproducible.
 * Tests that assert something about SIGNATURES must use a real generated key
 * (see auth-account.test.ts) — a fixture cannot sign, and mocking that away is
 * how the identity-key defect originally slipped through.
 *
 * 33 bytes, 0x05-prefixed like a real Curve25519 public key, and canonical
 * base64 — the shared DTO now REQUIRES canonical form for identity keys, so a
 * fixture that was not canonical would fail validation rather than the thing
 * under test.
 */
export function testIdentityKey(seed = 1): string {
  const bytes = Buffer.alloc(33, seed & 0xff);
  bytes[0] = 0x05;
  return bytes.toString('base64');
}

export interface LogEntry {
  event: string;
  fields: LogFields;
}

export interface TestDeps extends Deps {
  /** The twin, with its test-only planting primitives. */
  db: TestOnlyDataLayer;
  /** Advance the injected clock by N milliseconds. */
  advanceMs(ms: number): void;
  /** Set the nonce the next auth-challenge call will issue. */
  setNextChallenge(challenge: string): void;
  /** Emails the fake seam "sent" this run — the assertion surface. The
   * fake records the address so a suite can prove where a code went; the
   * REAL seam never logs one, which the log-canary case pins. */
  emailsSent: Array<{ address: string; code: string; ref: string; purpose: 'attach' | 'recovery' }>;
  /** Force the next seam outcome (suppression / failure paths). */
  setNextEmailOutcome(outcome: 'sent' | 'suppressed' | 'failed'): void;
  /** SMS codes the fake seam "sent" this run — the assertion surface.
   * The fake records the number so a suite can prove where a code went; the
   * REAL seam never logs one, which the log-canary case pins. */
  smsSent: Array<{ number: string; code: string; ref: string; purpose: 'attach' | 'recovery' }>;
  /** Force the next SMS seam outcome (the vendor's synchronous refusal /
   * failure paths). */
  setNextSmsOutcome(outcome: 'sent' | 'suppressed' | 'failed'): void;
  /** Structured log entries captured this run. */
  logs: LogEntry[];
  /** VoIP wake-ups this run — the assertion surface for urgent routing. */
  pushesSent: Array<{ userId: string; fromUserId: string }>;
  /** Message notifications this run, with the badge each carried. */
  alertsSent: Array<{ userId: string; msgId: string; badge?: number }>;
  /** Transport disconnects requested this run — the assertion surface for
   * session/account revocation tearing a live socket down. */
  disconnected: string[];
  /** Batches accepted by the default in-memory call-metrics publisher. */
  publishedCallMetrics: Array<readonly import('../src/call-metrics.js').CallMetricDatum[]>;
}

/** Deterministic 43-char base64url attachment id (the real ones are 32 random
 * bytes base64url) — zero-padded so it also passes the handler's id regex. */
export function testAttachmentId(seq: number): string {
  return String(seq).padStart(43, 'A');
}

export function makeTestDeps(db: TestOnlyDataLayer, startMs = 1_700_000_000_000): TestDeps {
  let nowMs = startMs;
  // UNIQUE per call, like the real 32 random bytes. A constant here would be
  // an unrealistic fake that quietly satisfies "the challenge is bound to the
  // key it was issued for" — two identities would receive the same nonce and
  // each other's would appear valid. `setNextChallenge` pins it when a test
  // needs a specific value.
  let challengeOverride: string | undefined;
  let challengeSeq = 0;
  const freshChallenge = (): string =>
    Buffer.from(`challenge-${++challengeSeq}`.padEnd(32, '.')).toString('base64');
  const nextUserUlid = monotonicFactory(() => 0.5);
  let tokenSeq = 0;
  let attachSeq = 0;
  let reportSeq = 0;
  const logs: LogEntry[] = [];
  const pushesSent: Array<{ userId: string; fromUserId: string }> = [];
  const alertsSent: Array<{ userId: string; msgId: string; badge?: number }> = [];
  const disconnected: string[] = [];
  const publishedCallMetrics: Array<readonly import('../src/call-metrics.js').CallMetricDatum[]> = [];
  const emailsSent: TestDeps['emailsSent'] = [];
  let emailSeq = 0;
  let nextEmailOutcome: 'sent' | 'suppressed' | 'failed' = 'sent';
  const smsSent: TestDeps['smsSent'] = [];
  let nextSmsOutcome: 'sent' | 'suppressed' | 'failed' = 'sent';

  return {
    db,
    now: () => nowMs,
    // Real ULIDs, as production mints (aws/deps.ts, local/http.ts) — the
    // frames schema pins `to: Ulid`, so prose ids would no longer parse.
    // Deterministic (fixed prng, fixed seed time; the factory increments per
    // call) so failures reproduce and ids sort in mint order like before.
    newUserId: () => nextUserUlid(0),
    newAuthToken: () => `token-${++tokenSeq}`,
    newChallenge: () => challengeOverride ?? freshChallenge(),
    // The audience clients sign for. A fixed test origin,
    // so a suite that means to exercise a MISMATCH has to say so explicitly
    // rather than getting one by accident from an unset environment.
    apiOrigin: 'https://api.test.tacendum.com',
    // Deterministic limiter over the injected clock.
    rateLimit: makeRateLimiter(() => nowMs),
    callMetrics: {
      store: makeMemoryCallMetricStore(),
      publisher: { publish: async (data) => void publishedCallMetrics.push([...data]) },
    },
    log: (event, fields = {}) => logs.push({ event, fields }),
    newAttachmentId: () => testAttachmentId(++attachSeq),
    // Deterministic 6-digit codes, in mint order — a suite reads the minted
    // code from `emailsSent` (or the store) exactly as a human reads it from
    // the inbox; nothing here needs to guess.
    newEmailCode: () => String(100000 + ++emailSeq),
    // The identifier-HMAC key set: an injected TEST key (never a real
    // secret near a test), version 1 — suites that drive rotation replace
    // this field wholesale.
    identifierHmac: { keys: [{ version: 1, key: 'test-identifier-hmac-key' }] },
    // The email seam's fake: records what production would hand SES, so the
    // suites assert delivery without a transport — and the recorded address
    // is exactly what the log-canary case proves never reaches `logs`.
    email: {
      sendCode: async (input) => {
        emailsSent.push({ ...input });
        const outcome = nextEmailOutcome;
        nextEmailOutcome = 'sent';
        return outcome;
      },
    },
    // The SMS seam's fake: records what production would hand EUM,
    // so the suites assert delivery without a transport — and the recorded
    // number is exactly what the log-canary case proves never reaches
    // `logs`. One code sequence for both seams: codes read in mint order.
    sms: {
      sendCode: async (input) => {
        smsSent.push({ ...input });
        const outcome = nextSmsOutcome;
        nextSmsOutcome = 'sent';
        return outcome;
      },
    },
    // Deterministic, so a test can name the id it expects back.
    newReportId: () => `report-${++reportSeq}`,
    // URL-shaped stubs that echo their inputs so tests can assert wiring.
    attachments: {
      uploadUrl: async (attachmentId, contentLength) =>
        `https://blobs.test/put/${attachmentId}?len=${contentLength}`,
      downloadUrl: async (attachmentId) => `https://blobs.test/get/${attachmentId}`,
    },
    // No relay by default: the "unavailable" path is the one a misconfigured
    // deployment takes, so it should be what a test gets unless it says so.
    turn: null,
    push: {
      wake: async (token, fromUserId) => {
        pushesSent.push({ userId: token.userId, fromUserId });
        return 'sent' as const;
      },
      // The fake used to omit this entirely, which typechecked only because
      // the literal was inferred structurally. Every message-notification
      // test therefore ran through `deliverPushWake`'s catch-all and logged
      // `push_failed` while asserting nothing — a green path that pushed
      // nothing. Present now so the badge and payload are assertable.
      notify: async (token, message) => {
        alertsSent.push({
          userId: token.userId,
          msgId: message.msgId,
          // AlertPayload deliberately carries NO badge (push/apns.ts — it
          // would count read receipts). Probed structurally anyway, so the
          // day a badge field sneaks back into the payload, the "sends no
          // badge" assertion starts failing instead of going vacuous.
          ...(() => {
            const probe = (message as typeof message & { badge?: number }).badge;
            return probe !== undefined ? { badge: probe } : {};
          })(),
        });
        return 'sent' as const;
      },
    },
    // Best-effort transport disconnect. The host wires this to API
    // Gateway DeleteConnection / the local socket map; the test double just
    // records who was told to hang up.
    disconnectSocket: async (connectionId: string) => {
      disconnected.push(connectionId);
    },
    logs,
    pushesSent,
    alertsSent,
    disconnected,
    publishedCallMetrics,
    advanceMs: (ms) => {
      nowMs += ms;
    },
    setNextChallenge: (challenge) => {
      challengeOverride = challenge;
    },
    emailsSent,
    setNextEmailOutcome: (outcome) => {
      nextEmailOutcome = outcome;
    },
    smsSent,
    setNextSmsOutcome: (outcome) => {
      nextSmsOutcome = outcome;
    },
  };
}

/**
 * libsignal-SIZED key material for PUT /v1/keys fixtures: the upload schema
 * pins the byte lengths every shipped client produces — a Curve25519 public
 * key serialized with its type byte (33), a 64-byte signature, an
 * ML-KEM-1024 public key with its type byte (1569) — so a fixture must be
 * the right SIZE even where it need not be a real key (nothing server-side
 * verifies the bytes; that is the peer's job). Distinct fill bytes keep the
 * three tellable apart in a dump. */
export const KEY_FIXTURE = {
  curvePub: Buffer.alloc(33, 0x05).toString('base64'),
  sig: Buffer.alloc(64, 0x51).toString('base64'),
  kyberPub: Buffer.alloc(1569, 0x08).toString('base64'),
} as const;

export function jsonPost(body: unknown, sourceIp = '127.0.0.1'): HttpEvent {
  return { method: 'POST', path: '/', headers: {}, body: JSON.stringify(body), sourceIp };
}

export function authedGet(token: string | undefined): HttpEvent {
  return {
    method: 'GET',
    path: '/',
    headers: token ? { authorization: `Bearer ${token}` } : {},
  };
}

export function parseBody<T = unknown>(body: string | undefined): T {
  return JSON.parse(body ?? '') as T;
}
