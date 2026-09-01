import {
  LOW_PREKEY_THRESHOLD,
  type GroupSibling,
  type PrekeyBundle,
  type RevokedKeysHint,
  UploadKeysRequest,
} from '@tacendum/shared';
import type { AccountGroupMember, UserRecord } from '../db/data.js';
import { type AuthedHandler, errorResult, json, parseJson, rateLimitedResult } from './http.js';
import { LIMITS } from '../ratelimit.js';
import { userRefForLog } from '../opaque-ref.js';

/**
 * PUT /v1/keys — the authenticated caller uploads its own identity key,
 * signed prekey, and a batch of one-time prekeys. Keys always belong
 * to the caller; there is no way to publish keys for another user.
 */
export const uploadKeysHandler: AuthedHandler = async (event, deps, auth) => {
  const parsed = parseJson(event, UploadKeysRequest);
  if (!parsed.ok) return parsed.result;

  const { registrationId, identityKey, signedPrekey, kyberPrekey, oneTimePrekeys } = parsed.data;
  const stored = await deps.db.storeKeys(
    auth.userId,
    { registrationId, identityKeyPub: identityKey, signedPrekey, kyberPrekey },
    oneTimePrekeys,
  );
  if (!stored) {
    // The account already carries a DIFFERENT identity key. Rotation is not a
    // supported operation — a new key is a new account — and `storeKeys` refuses it with a conditional write.
    // This return value was being DISCARDED, so a refused upload answered 204
    // and the client believed its keys were published while the server had
    // stored nothing: it would then be unreachable, with no error anywhere to
    // say why. The `identity_key_immutable` code existed for this case and had
    // no emitter. 409, not 400: the request is well-formed, it conflicts with
    // the account's existing state.
    // Opaque ref, not the ULID.
    deps.log('key_upload_rejected_immutable', {
      userRef: userRefForLog(auth.userId, deps.userRefSalt),
    });
    return errorResult(
      409,
      'identity_key_immutable',
      'this account is bound to a different identity key; a new key is a new account',
    );
  }

  return { statusCode: 204 };
};

/** One member entry as the wire serves it: the shared GroupSibling
 * shape, certs included when a ceremony minted them — one field set, two
 * spellings would drift. A certless member (the solo-attach founder or
 * a recovery-attached device — no ceremony ever ran) is served
 * honestly WITHOUT certs, and the client's standing rule already
 * answers it: no verifiable cross-signature ⇒ block-and-warn. */
function toGroupSibling(member: AccountGroupMember): GroupSibling {
  return {
    userId: member.userId,
    class: member.class,
    ...(member.certs !== undefined
      ? {
          certs: {
            offerSig: member.certs.offerSig,
            acceptSig: member.certs.acceptSig,
            groupId: member.certs.groupId,
            offererUserId: member.certs.offererUserId,
            acceptorUserId: member.certs.acceptorUserId,
            class: member.certs.class,
            rosterEpoch: member.certs.rosterEpoch,
            offerNonce: member.certs.offerNonce,
            expiresAt: member.certs.expiresAt,
          },
        }
      : {}),
  };
}

/**
 * GET /v1/keys/{userId} — fetch a prekey bundle for the target user and
 * atomically consume one of their one-time prekeys. If the pool is empty the
 * bundle omits `oneTimePrekey` (signed-prekey-only). `lowPrekeyCount` is set
 * when fewer than LOW_PREKEY_THRESHOLD one-time prekeys remain.
 *
 * Since this route carries the group dimension, and EVERY
 * group-aware branch reads `feature#accounts` FIRST:
 *
 * - flag OFF or DELETED: the legacy path below runs byte-identically to the
 * pre-accounts build — per-ULID rate key, no extra reads, no siblings, no
 * roster version, no forwarding hint — even for accounts already grouped.
 * The kill switch restores the shipped surface, not merely the new routes.
 * - flag ON, target grouped: the bundle gains `rosterVersion` + `siblings`
 * (server-attested hint, client-verified truth; certs ride along),
 * and the pair rate key collapses to (callerGroup, targetGroup) under the
 * re-derived pinned ceiling so a 3×3 mesh establishment succeeds
 * without tripling anyone's drain allowance.
 * - target REVOKED (tombstoned): the bundle is refused REGARDLESS of the
 * flag — a tombstone exists only because a revoke committed, and a kill
 * switch must never hand a stolen device new inbound sessions (the
 * enforcement-is-not-flag-gated rule). What IS flag-gated is the
 * forwarding hint: flag ON serves the surviving roster + certificates in
 * an ApiError-shaped 404 (`RevokedKeysHint`) so a peer holding only the
 * dead ULID re-targets; flag OFF serves the plain legacy `not_found`
 * bytes, indistinguishable from a user with no bundle.
 */
export const getPrekeyBundleHandler: AuthedHandler = async (event, deps, auth) => {
  const userId = event.pathParameters?.userId;
  if (!userId) {
    return errorResult(400, 'invalid_request', 'missing userId');
  }

  // The flag read: one strongly consistent GetItem,
  // taken FIRST because both the rate-key choice and the response shape hang
  // off it. OFF ⇒ every line below is the shipped pre-accounts behavior.
  const accountsOn = await deps.db.isAccountsFeatureEnabled();

  // Per-(caller, target) limit: one authed account can't drain another user's
  // one-time-prekey pool (confidentiality is not broken either way — the
  // signed-prekey fallback is valid X3DH — but this bounds the abuse). With
  // accounts ON and EITHER side grouped, the key collapses to the group pair
  // and the ceiling is the re-derived 12/min group-pair pin (a
  // full 3×3 mesh is 9 fetches and must succeed in one window). The
  // rows needed to resolve the scopes are read before the take on this
  // branch; the response still discloses nothing before the limit is priced.
  let groupScoped = false;
  let bucket = `prekey:${auth.userId}:${userId}`;
  if (accountsOn) {
    const caller = await deps.db.getUserById(auth.userId);
    const scopeTarget = await deps.db.getUserById(userId);
    const callerScope = caller?.groupId ?? auth.userId;
    const targetScope =
      scopeTarget?.groupId ??
      (scopeTarget?.tombstoned === true ? scopeTarget.formerGroupId : undefined) ??
      userId;
    if (callerScope !== auth.userId || targetScope !== userId) {
      groupScoped = true;
      bucket = `prekey-group:${callerScope}:${targetScope}`;
    }
  }
  if (groupScoped) {
    // The pinned ceiling, taken FAIR-SHARE: one
    // undifferentiated 12-token bucket let a few early retries from one
    // device pair exhaust the window before the rest of the mesh ran — the
    // pinned worst case held only for the polite ordering. Every (caller
    // device, target device) pair holds ONE reserved fetch per window (9
    // reservations cover the full 3×3 mesh under ANY interleaving); retries
    // overflow to the shared remainder. Aggregate unchanged: 9×1 + 3 = 12,
    // the release pin exactly — see LIMITS.prekeyFetchGroupPairReserve.
    const reserved = await deps.rateLimit.take(
      `prekey-guar:${auth.userId}:${userId}`,
      LIMITS.prekeyFetchGroupPairReserve,
    );
    if (reserved > 0) {
      const retry = await deps.rateLimit.take(bucket, LIMITS.prekeyFetchGroupPairShared);
      if (retry > 0) return rateLimitedResult(retry);
    }
  } else {
    const retry = await deps.rateLimit.take(bucket, LIMITS.prekeyFetch);
    if (retry > 0) return rateLimitedResult(retry);
  }

  // The SERVE read runs AFTER the limit is priced and is STRONGLY CONSISTENT
  //: the earlier shape cached the pre-take scope read —
  // eventually consistent, and taken before a DDB round trip — so a
  // pre-revoke snapshot could resume after the revoke transaction committed,
  // consume a prekey, and serve a 200 bundle for the dead device. Tombstone
  // enforcement reads the committed truth; the scope reads above stay cheap
  // because a mispriced BUCKET is a rate-key blur, never an enforcement hole.
  const user: UserRecord | undefined = await deps.db.getUserById(userId, undefined, {
    consistent: true,
  });

  // A REVOKED device's row is dead: never serve its bundle — a
  // tombstone exists only because a revoke committed, so this refusal is
  // enforcement and is NOT flag-gated. The forwarding hint (surviving roster
  // + certs, same disclosure class) IS: disclosure surfaces answer
  // pre-accounts bytes while the flag is off.
  if (user?.tombstoned === true) {
    if (accountsOn && user.formerGroupId !== undefined) {
      const survivors = await deps.db.getAccountGroup(user.formerGroupId);
      if (survivors !== undefined) {
        const hint: RevokedKeysHint = {
          error: {
            code: 'recipient_revoked',
            detail: 'this device was revoked by its account',
          },
          rosterVersion: survivors.epoch,
          siblings: survivors.members.map(toGroupSibling),
        };
        return json(404, hint);
      }
    }
    return errorResult(404, 'not_found', 'no key bundle for this user');
  }

  if (
    !user ||
    user.registrationId === undefined ||
    !user.identityKeyPub ||
    !user.signedPrekey ||
    !user.kyberPrekey
  ) {
    return errorResult(404, 'not_found', 'no key bundle for this user');
  }

  // THE PER-TARGET AGGREGATE ONE-TIME-PREKEY BUDGET (the anti-Sybil drain floor, release pin: 30/day ACROSS ALL REQUESTERS,
  // keyed by the SERVED user): per-(caller,target) limits alone are
  // Sybil-washable because identity keypairs are free, so N fresh attacker
  // identities must exhaust a budget that does not reset with N. When the
  // budget is spent the bundle DEGRADES to signed-prekey-only — the standard
  // X3DH fallback, session setup still succeeds with reduced forward secrecy
  // for the first messages — and the pool is untouched. NOT flag-gated —
  // like the tombstone refusal above, this is
  // ENFORCEMENT, not a disclosure surface: the kill-switch byte-identity
  // rule governs what a response DISCLOSES, and a signed-prekey-only bundle
  // is a shape the pre-accounts surface already produces (pool exhaustion).
  // The kill switch is the operator's answer to a DETECTED crawl — the
  // member ULIDs discovery already disclosed survive the flag delete, so
  // the drain floor those ULIDs would otherwise be spent against must
  // survive it too.
  const targetBudgetSpent =
    (await deps.rateLimit.take(`prekeyotp:${userId}`, LIMITS.prekeyTargetDaily)) > 0;
  const oneTimePrekey = targetBudgetSpent ? undefined : await deps.db.consumeOneTimePrekey(userId);
  const remaining = await deps.db.countOneTimePrekeys(userId);

  const bundle: PrekeyBundle = {
    userId,
    registrationId: user.registrationId,
    identityKey: user.identityKeyPub,
    signedPrekey: user.signedPrekey,
    kyberPrekey: user.kyberPrekey,
    ...(oneTimePrekey ? { oneTimePrekey } : {}),
    ...(remaining < LOW_PREKEY_THRESHOLD ? { lowPrekeyCount: true } : {}),
  };
  // The device dimension: ADDITIVE, appended after every legacy field,
  // served only when the flag is ON and the target is genuinely grouped — a
  // solo target's response is the byte-identical legacy object (old clients
  // see NOTHING new; pinned against a captured fixture). A
  // REVOKED member can never appear here: the revoke transaction removed it
  // from the group row this list is read from.
  if (accountsOn && user.groupId !== undefined) {
    const group = await deps.db.getAccountGroup(user.groupId);
    if (group !== undefined) {
      bundle.rosterVersion = group.epoch;
      bundle.siblings = group.members
        .filter((m) => m.userId !== userId)
        .map(toGroupSibling);
    }
  }
  return json(200, bundle);
};
