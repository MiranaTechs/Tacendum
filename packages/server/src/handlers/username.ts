import {
  type AccountsNotice,
  DISCOVERY_MIN_ACCOUNT_AGE_SECONDS,
  RESERVED_USERNAMES,
  RESERVED_USERNAME_SKELETONS,
  USERNAME_RENAME_COOLDOWN_SECONDS,
  USERNAME_TAKEN_BODY,
  USERNAME_TAKEN_STATUS,
  UsernameClaimRequest,
  UsernameUnlinkRequest,
  normalizeUsernameIdentifier,
  usernameSkeleton,
} from '@tacendum/shared';
import { LIMITS } from '../ratelimit.js';
import {
  activeNameskelClaimKeys,
  activeUsernameClaimKeys,
  userRefForLog,
} from '../opaque-ref.js';
import {
  EMAIL_CLAIM_KEY_PREFIX,
  PHONE_CLAIM_KEY_PREFIX,
  USERNAME_CLAIM_KEY_PREFIX,
  type UsernameRevokeResult,
} from '../db/data.js';
import { accountsRefusal, accountsUsernameRoute, deliverAccountsNotice } from './devices.js';
import { classRefs, hmacKeys, identifierEligible } from './identifiers.js';
import {
  type AuthedHandler,
  type Deps,
  type Handler,
  type HttpResult,
  json,
  parseJson,
} from './http.js';

/**
 * The username class's lifecycle verbs, token-path: claim (which IS rename when the caller's group already
 * holds a name) and unlink. Libsignal-free and keyed-hash-free like
 * identifiers.ts (every claim key reaches through opaque-ref.ts); every
 * route rides `accountsUsernameRoute` (master AND `feature#accounts-username`,
 * both checked before auth and parsing) and the class's consent toggle is
 * discovery.ts's per-class handler.
 *
 * THE REFUSAL DISCIPLINE OF THIS LANE, stated once (a deliberate
 * carve-out): the claim verb — and only it — answers ONE distinguishable
 * identifier-keyed result, the frozen 409 `taken`, because in this class
 * uniqueness is the product and the user must learn occupancy to proceed.
 * What `taken` discloses is namespace occupancy of a self-chosen public
 * label, never linkage (not who, not whether discoverable, no fact about any
 * possession-proof identifier), and only as the priced side effect of an
 * authenticated, identifier-verified, aged, budget-charged WRITE attempt.
 * Reserved names, skeleton conflicts, and live tombstones answer the SAME
 * bytes, so the one distinguishable answer stays one bit. (Byte- and
 * status-uniform, not TIME-uniform: a reserved name returns before any
 * DynamoDB round-trip, a store-held name after the transaction — and the
 * denylist is compiled-in and public by design, so the timing tells a
 * caller only what RESERVED_USERNAMES already tells everyone — a recorded
 * residual, not a defect.) EVERYTHING ELSE —
 * flag off, the caller gate, a malformed body, the route budget, the caller
 * bucket, the fleet ceiling, a cool-down, a stale snapshot — is the program's
 * ONE frozen refusal, and on this lane even the CALLER-keyed budgets refuse
 * in that shape, never a 429 (the lookup lane's rule, for the
 * same reason: beside a designed one-bit answer, a second distinguishable
 * refusal shape would let a scraper pace its probes off the budget answer).
 *
 * Rule 5 binds every log line: no name, no skeleton, no hash, no claim key,
 * no ULID, no groupId — the counters are field-free and the success events
 * carry the opaque caller ref only.
 */

/** The frozen singleton of the program's collapsed refusal, so a suite can
 * assert with reference identity that every refused case of this lane
 * returned through ONE exit (the discovery.ts pattern). */
const USERNAME_UNIFORM_REFUSAL: HttpResult = Object.freeze(accountsRefusal());
export function usernameRefusal(): HttpResult {
  return USERNAME_UNIFORM_REFUSAL;
}

/** THE one distinguishable answer (carve-out): the frozen 409, body
 * bytes pinned in @tacendum/shared (`USERNAME_TAKEN_BODY`), the ordinary
 * JSON content-type header and nothing else — occupancy, one bit. */
const USERNAME_TAKEN: HttpResult = Object.freeze({
  statusCode: USERNAME_TAKEN_STATUS,
  headers: Object.freeze({ 'content-type': 'application/json' }),
  body: USERNAME_TAKEN_BODY,
});
export function usernameTaken(): HttpResult {
  return USERNAME_TAKEN;
}

/** The compiled-in denylist check on the in-transit normalized
 * plaintext BEFORE hashing — the only moment plaintext exists — exact AND
 * skeleton-vs-SKELETON (the reserved names are skeletonized at build time,
 * so `m0derator` still hits `moderator` through the i→l fold). */
function isReservedUsername(normalized: string, skeleton: string): boolean {
  return (
    (RESERVED_USERNAMES as readonly string[]).includes(normalized) ||
    RESERVED_USERNAME_SKELETONS.has(skeleton)
  );
}

/**
 * POST /v1/identifiers/username/claim — and /rename, the SAME verb spelled
 * for the client's intent (the claim endpoint IS rename when the group
 * already holds a username ref; no discriminant field exists, the route
 * decides nothing the group state does not). Priced BEFORE resolution, in
 * this order and for these reasons:
 *
 * 1. the caller-keyed route budget (`idroute:`), then the K_id set and the
 * parse — pure CPU, nothing spent on a malformed body;
 * 2. THE CLAIM GATE: a live human caller, ≥72 h old
 * (DISCOVERY_MIN_ACCOUNT_AGE_SECONDS reused), whose GROUP holds at least
 * one verified POSSESSION-PROOF identifier (email or phone — a username
 * never qualifies, the Sybil arithmetic on the record for: free
 * identities × 10/day would otherwise saturate any fleet ceiling and
 * squat thousands of names monthly at zero cost). Refused: the frozen
 * bytes, never an oracle about the caller either;
 * 3. the rename cool-down as a caller-state precheck for a HOLDER (the
 * transaction's `usernameRenamedAt` condition is the enforcement) — a
 * holder inside its 30 days spends nothing on a rename that cannot
 * commit;
 * 4. the caller bucket `unameclaim:<group>` (10/day, its OWN window, never
 * the shared attach budget) and then the fleet ceiling
 * `unameclaim-fleet` (2,000/day), taken AFTER the gate so free
 * identities can never draw the shared budget down; the field-free
 * admitted counter fires here, BEFORE resolution, for every attempt
 * that reaches the namespace (claim and rename alike — the 50% alarm
 * twin's metric);
 * 5. the denylist, on plaintext, before hashing; then, for a NON-holder
 * inside the cool-down (unlink stamps it — the anti-hoarding
 * rule: claim→unlink→claim-another is a rename in two verbs), a
 * pre-read of the exact-name row at every active version: the caller's
 * OWN live tombstone at any of them admits the reclaim
 * (`reclaimingOwn`, the former-owner right — on a retiring
 * version too), anything else is the frozen refusal without a
 * transaction — this precheck needs the claim keys, so it sits after
 * the hash and the budgets (a refused attempt burns budget, never the
 * cool-down); then
 * the transaction — `claimUsername` for a group holding no name,
 * `renameUsername` (the five-item Put-overwrite transaction) for a
 * holder.
 */
const usernameClaimHandler: AuthedHandler = async (event, deps, auth) => {
  if ((await deps.rateLimit.take(`idroute:${auth.userId}`, LIMITS.identifierRoute)) > 0) {
    return usernameRefusal();
  }
  // Awaited: on a fresh container the first read starts the K_id fetch
  // (identifiers.ts `hmacKeys`) — an earlier first-tap 403 was this line
  // refusing on "in flight" instead of waiting for the key.
  const keys = await hmacKeys(deps);
  if (!keys) return usernameRefusal();
  // `.strict` + the explicit consent bit: a rider field, a missing
  // `discoverable`, or a name outside USERNAME_STRICT after normalization is
  // malformed and collapses — never repaired, never stripped.
  const parsed = parseJson(event, UsernameClaimRequest);
  if (!parsed.ok) return usernameRefusal();

  const caller = await deps.db.getUserById(auth.userId);
  if (!identifierEligible(caller)) return usernameRefusal();
  const nowMs = deps.now();
  const nowSeconds = Math.floor(nowMs / 1000);
  if (nowMs - caller.createdAt < DISCOVERY_MIN_ACCOUNT_AGE_SECONDS * 1000) {
    return usernameRefusal();
  }
  // Grouped by construction: the possession-proof gate below can only
  // be satisfied by a group, and a solo device holds no refs at all.
  if (caller.groupId === undefined) return usernameRefusal();
  const group = await deps.db.getAccountGroup(caller.groupId);
  if (!group) return usernameRefusal();
  const possessionRefs =
    classRefs(group.identifierRefs, EMAIL_CLAIM_KEY_PREFIX).length +
    classRefs(group.identifierRefs, PHONE_CLAIM_KEY_PREFIX).length;
  if (possessionRefs === 0) return usernameRefusal();

  const held = classRefs(group.identifierRefs, USERNAME_CLAIM_KEY_PREFIX);
  // The cool-down (caller state only — the transactions' condition is the
  // enforcement and rename/unlink consume it on success alone): the
  // same cutoff arithmetic the five-item rename and the claim condition on.
  const inCooldown =
    group.usernameRenamedAt !== undefined &&
    group.usernameRenamedAt > nowSeconds - USERNAME_RENAME_COOLDOWN_SECONDS;
  // A holder's precheck: nothing spent on a rename that cannot commit. (A
  // non-holder's is below — it needs the claim key.)
  if (held.length > 0 && inCooldown) return usernameRefusal();

  // The budgets, group-scoped then fleet-wide — both charged per ATTEMPT,
  // both refusing in the frozen shape (never a 429 on this lane). In AWS
  // `deps.rateLimit` is the DDB fixed-window limiter, so each count is
  // fleet-wide by construction.
  if ((await deps.rateLimit.take(`unameclaim:${caller.groupId}`, LIMITS.usernameClaim)) > 0) {
    return usernameRefusal();
  }
  if ((await deps.rateLimit.take('unameclaim-fleet', LIMITS.usernameClaimFleet)) > 0) {
    // Field-free: the infra metric filter counts it; the class kill
    // switch is one delete of the feature#accounts-username row.
    deps.log('username_claim_fleet_refused');
    return usernameRefusal();
  }
  // The ADMITTED-volume counter: field-free, every attempt that reaches the
  // namespace — claimed, renamed, and taken alike — so an under-cap sustained
  // occupancy walk pages at 50% of the ceiling without a refusal ever firing.
  deps.log('username_claim_admitted');

  // Plaintext exists from here to the key derivation and nowhere durable:
  // the denylist reads it (exact and skeleton-vs-skeleton), opaque-ref.ts
  // hashes it, and it is never logged.
  const normalized = normalizeUsernameIdentifier(parsed.data.username);
  const skeleton = usernameSkeleton(normalized);
  if (isReservedUsername(normalized, skeleton)) {
    deps.log('username_claim_taken');
    return usernameTaken();
  }
  // Every active-version key of BOTH rows, newest first: index 0 is what the
  // transaction WRITES; the tail is condition-checked with the tombstone-
  // aware expression in the same transaction (uniqueness across the whole
  // rotation window).
  const claimKeys = activeUsernameClaimKeys(keys, normalized);
  const skeletonKeys = activeNameskelClaimKeys(keys, skeleton);

  if (held.length === 0) {
    // THE CLAIM. A non-holder inside the cool-down (its last name change
    // was an unlink — or a rename followed by an unlink) may only take its
    // OWN name back: EVERY active version of the exact-name row is pre-read
    // (the walk, ≤2 strongly consistent GetItems — the tombstone may
    // sit on a RETIRING version, the corrected-spelling case), and only
    // this group's live tombstone at one of them admits the attempt (the
    // transaction drops the cool-down clause for it; the rows' tombstone-
    // aware condition at every version is what then admits the reclaim).
    // Anything else — a free name, a stranger's name — is the frozen
    // refusal, no transaction: a claim of another name is a rename in two
    // verbs and waits the same 30 days. The walk is caller-state-gated and,
    // like every read of this class, reaps an elapsed tombstone.
    let reclaimingOwn = false;
    if (inCooldown) {
      for (const key of claimKeys) {
        const standing = await deps.db.getUsernameClaim(key, nowSeconds);
        if (
          standing !== undefined &&
          'tombstoned' in standing &&
          standing.formerGroupId === caller.groupId
        ) {
          reclaimingOwn = true;
        }
      }
      if (!reclaimingOwn) return usernameRefusal();
    }
    // The recovery cool-down re-arm rides the group-row carrier only:
    // the address-keyed shadow the attach lane also reads is written by
    // recovery completion, and recovery is EXCLUDED for this class
    // absolutely — no username-keyed shadow can ever exist.
    const carried =
      group.discoverableAfter !== undefined && group.discoverableAfter > nowSeconds
        ? { discoverableAfter: group.discoverableAfter }
        : {};
    const result = await deps.db.claimUsername({
      userId: auth.userId,
      groupId: caller.groupId,
      refsSnapshot: group.identifierRefs,
      claimKey: claimKeys[0]!,
      skeletonKey: skeletonKeys[0]!,
      retiringClaimKeys: claimKeys.slice(1),
      retiringSkeletonKeys: skeletonKeys.slice(1),
      discoverable: parsed.data.discoverable,
      ...carried,
      reclaimingOwn,
      nowMs,
    });
    if (result === 'taken') {
      deps.log('username_claim_taken');
      return usernameTaken();
    }
    // identifier_cap, cooldown (raced past the precheck), stale,
    // unknown_member: the caller's own state moved under it (a sibling
    // claimed first, a membership ended, an unlink landed) — collapsed.
    if (result !== 'claimed') return usernameRefusal();
    deps.log('username_claimed', { userRef: userRefForLog(auth.userId, deps.userRefSalt) });
    return json(200, {});
  }

  // THE RENAME: one TransactWrite, five items, Put-overwrites only —
  // the old rows become tombstones the former owner may reclaim for 30 days,
  // the new rows are born under the tombstone-aware condition, and the
  // cool-down is consumed only if the whole transaction commits.
  const result = await deps.db.renameUsername({
    userId: auth.userId,
    groupId: caller.groupId,
    refsSnapshot: group.identifierRefs,
    oldClaimKey: held[0]!,
    claimKeys,
    skeletonKeys,
    discoverable: parsed.data.discoverable,
    nowMs,
  });
  if (result === 'taken') {
    deps.log('username_claim_taken');
    return usernameTaken();
  }
  // cooldown (raced past the precheck), same_name (a no-op that must not
  // consume the cool-down), stale, unknown_member: collapsed.
  if (result !== 'renamed') return usernameRefusal();
  deps.log('username_renamed', { userRef: userRefForLog(auth.userId, deps.userRefSalt) });
  return json(200, {});
};

/**
 * POST /v1/identifiers/username/unlink — the per-class twin of the email and
 * phone unlinks: only THIS class leaves — the claim row and its
 * skeleton row become former-owner tombstones (never deletes), the ref
 * leaves under the unchanged full-snapshot CAS, and the email/phone refs,
 * their consent, and their rows survive by construction. The verb carries
 * no body; a body that is present must be the pinned empty object
 * (`UsernameUnlinkRequest`, `.strict`) — any rider is malformed and
 * collapses, so nothing ever travels on the unlink verb.
 */
const usernameUnlinkHandler: AuthedHandler = async (event, deps, auth) => {
  if ((await deps.rateLimit.take(`idroute:${auth.userId}`, LIMITS.identifierRoute)) > 0) {
    return usernameRefusal();
  }
  if (event.body !== undefined && event.body !== null && event.body !== '') {
    const parsed = parseJson(event, UsernameUnlinkRequest);
    if (!parsed.ok) return usernameRefusal();
  }
  const caller = await deps.db.getUserById(auth.userId);
  if (!identifierEligible(caller) || caller.groupId === undefined) return usernameRefusal();
  const group = await deps.db.getAccountGroup(caller.groupId);
  if (!group) return usernameRefusal();
  const held = classRefs(group.identifierRefs, USERNAME_CLAIM_KEY_PREFIX);
  // No username to remove = the collapsed refusal, exactly as the email and
  // phone twins answer.
  if (held.length === 0) return usernameRefusal();
  const result = await deps.db.unlinkUsername({
    userId: auth.userId,
    groupId: caller.groupId,
    refsSnapshot: group.identifierRefs,
    claimKey: held[0]!,
    nowMs: deps.now(),
  });
  if (result !== 'unlinked') return usernameRefusal();
  deps.log('identifier_unlinked', { userRef: userRefForLog(auth.userId, deps.userRefSalt) });
  return json(200, {});
};

/* ── the ops lane's notice half ─────────────── */

/**
 * Fan `AccountsNotice { kind: 'usernameRevoked' }` to EVERY member of the
 * (former) holder's group — the recovery-notice delivery pattern verbatim
 * (identifiers.ts `recoveryRequested`): one `deliverAccountsNotice` per
 * member through the durable queue, best-effort per member (an enqueue
 * failure is a counter, never a retry, never a thrown revocation). Kind
 * only, reasonless on the wire. ATTRIBUTION: the notice is about
 * the recipient's OWN account and no member acted, so each delivery is
 * attributed to its recipient (`aboutUserId = member`) — the memberRevoked
 * precedent of a notice attributed to a device that did not act, and the
 * sender-side wake buckets then key on the group exactly as every other
 * notice about a grouped member does. Called ONLY after the data-layer
 * revoke committed (`revokeUsernameAndNotify`), never before: a notice
 * about a tombstone that did not land would be a lie the holder cannot
 * check. Returns the count of members the notice was handed to the queue
 * for — a script-facing number, never a log field.
 */
export async function notifyUsernameRevoked(deps: Deps, groupId: string): Promise<number> {
  const group = await deps.db.getAccountGroup(groupId);
  if (!group) return 0;
  const notice: AccountsNotice = { kind: 'usernameRevoked' };
  for (const member of group.members) {
    await deliverAccountsNotice(deps, member.userId, member.userId, notice);
  }
  return group.members.length;
}

/**
 * THE OPS-LANE TWIN scripts/revoke-username.ts drives (primitive +
 * notice): walk the supplied claim keys newest-first (the walk — the
 * first version holding a LIVE claim is the one revoked), and on `revoked`
 * and only then — fan the notice to the holder's members. `gone` on every
 * version means nothing is live and nothing is sent; `stale` sends nothing
 * either (nothing committed). The primitive's own outcome word is what the
 * script prints; the notice count is returned beside it for the script's
 * exit code and never logged with anything else.
 *
 * THE NOTICE HALF IS BEST-EFFORT AS A WHOLE, not only per member: once the
 * tombstone TransactWrite has committed, NOTHING on the notice side may turn
 * the twin's answer into a throw. `deliverAccountsNotice` already swallows
 * an enqueue failure, but the group read before the fan-out is a DynamoDB
 * call of its own, and a transient failure there would have the script
 * print `revoke failed` for a revocation that landed — the operator's
 * re-run then answers `gone`, the revoked branch is never re-entered, and
 * the holder's members never hear. So the whole half
 * runs under one catch: the failure is the same counter an enqueue failure
 * is, the outcome stays `revoked`, and the count says 0 — the honest
 * number of members the notice was handed to the queue for.
 */
export async function revokeUsernameAndNotify(
  deps: Deps,
  claimKeys: readonly string[],
  nowMs: number,
): Promise<{ outcome: UsernameRevokeResult['outcome']; notified: number }> {
  for (const claimKey of claimKeys) {
    const result = await deps.db.revokeUsername({ claimKey, nowMs });
    if (result.outcome === 'gone') continue;
    if (result.outcome === 'stale') return { outcome: 'stale', notified: 0 };
    let notified = 0;
    try {
      notified = await notifyUsernameRevoked(deps, result.groupId);
    } catch {
      deps.log('accounts_notice_enqueue_failed');
    }
    return { outcome: 'revoked', notified };
  }
  return { outcome: 'gone', notified: 0 };
}

// The wrapped routes (both flags FIRST, then bearer auth — devices.ts): what
// the local adapter and the ordinary HTTP Lambda host mount, libsignal-free.
// `/claim` and `/rename` are ONE handler behind two route keys: the group's
// state decides which transaction runs the spelling is the client's
// declared intent and carries no discriminant.
export const usernameClaimRoute: Handler = accountsUsernameRoute(usernameClaimHandler);
export const usernameRenameRoute: Handler = accountsUsernameRoute(usernameClaimHandler);
export const usernameUnlinkRoute: Handler = accountsUsernameRoute(usernameUnlinkHandler);
