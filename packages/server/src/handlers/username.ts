import {
  type AccountsNotice,
  type IdentifierStateResponse,
  RESERVED_USERNAMES,
  RESERVED_USERNAME_SKELETONS,
  USERNAME_RENAME_COOLDOWN_SECONDS,
  USERNAME_TAKEN_BODY,
  USERNAME_TAKEN_STATUS,
  UsernameClaimRequest,
  type UsernameEligibilityResponse,
  UsernameUnlinkRequest,
  normalizeUsernameIdentifier,
  usernameSkeleton,
  hasReservedUsernameAffix,
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
 * authenticated, identifier-verified, budget-charged WRITE attempt.
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
    RESERVED_USERNAME_SKELETONS.has(skeleton) ||
    // The operator/brand affix rule: each end segment exact and
    // skeleton-vs-skeleton, same refusal bytes.
    hasReservedUsernameAffix(normalized)
  );
}

/** The later of the group row's `usernameRenamedAt` and the caller row's
 * (the stamp a dissolving unlink carried onto the member; 2026-10-08 gate
 * pass), or undefined when neither stands. Unix seconds. */
function latestUsernameStamp(
  groupStamp: number | undefined,
  callerStamp: number | undefined,
): number | undefined {
  if (groupStamp === undefined) return callerStamp;
  if (callerStamp === undefined) return groupStamp;
  return Math.max(groupStamp, callerStamp);
}

/** Whether a stamp is inside the §4.8 window at `nowSeconds` — the exact
 * cutoff arithmetic the rename and claim conditions use. */
function cooldownRunning(stamp: number | undefined, nowSeconds: number): boolean {
  return stamp !== undefined && stamp > nowSeconds - USERNAME_RENAME_COOLDOWN_SECONDS;
}

/**
 * POST /v1/identifiers/username/claim — and /rename, the SAME verb spelled
 * for the client's intent (the group's state decides which transaction
 * runs; no discriminant field exists). Since 2026-10-08 the SPELLING carries
 * ONE guard (step 2b below, the field report's silent-rename fix): the
 * /claim spelling on a group that already holds a name is refused, never
 * run as the rename the group's state implies. Priced BEFORE resolution, in
 * this order and for these reasons:
 *
 *  1. the caller-keyed route budget (`idroute:`), then the K_id set and the
 *     parse — pure CPU, nothing spent on a malformed body;
 *  2. THE CLAIM GATE: a live human caller whose GROUP holds at least
 *     one verified POSSESSION-PROOF identifier (email or phone — a username
 *     never qualifies). Fresh verified accounts may claim immediately;
 *     proof plus the caller and fleet budgets retain the anti-automation
 *     cost. Refused: the frozen bytes, never an oracle about the caller;
 *  2b. THE /claim-SPELLING GUARD (field report 2026-10-08, U1; taken by
 *     recommendation): the username is
 *     device-local client state the server never echoes (§4.9) and nothing
 *     syncs it to a linked sibling, so a sibling device (an iPad, a Mac, a
 *     reinstalled phone) shows the CLAIM form for an account that already
 *     holds a name, and its "claim" of a different name used to run here as
 *     the rename the group's state implied — silently renaming the account
 *     out from under the phone that still displays the old name, and
 *     consuming the 30-day cool-down. The /claim spelling on a group that
 *     holds a username ref is therefore the frozen refusal, BEFORE the
 *     budgets: no claim attempt spent, no admitted counter, no transaction
 *     (so the same-name retry of a sibling or the holder spends nothing
 *     either — it used to draw a claim attempt before the `same_name`
 *     no-op). The /rename spelling keeps the group-state routing exactly:
 *     it is the client's EXPLICIT intent (the "Change my username" form the
 *     shipped builds 31-33 send only when they hold a local row), and on a
 *     claimless group it still claims. The spelling discloses nothing the
 *     caller did not already send: the refusal is caller-keyed and byte-
 *     identical to every other refusal of this lane;
 *  3. the rename cool-down as a caller-state precheck for a HOLDER (the
 *     transaction's `usernameRenamedAt` condition is the enforcement) — a
 *     holder inside its 30 days spends nothing on a rename that cannot
 *     commit;
 *  4. the caller bucket `unameclaim:<group>` (10/day, its OWN window, never
 *     the shared attach budget) and then the fleet ceiling
 *     `unameclaim-fleet` (2,000/day), taken AFTER the gate so free
 *     identities can never draw the shared budget down; the field-free
 *     admitted counter fires here, BEFORE resolution, for every attempt
 *     that reaches the namespace (claim and rename alike — the 50% alarm
 *     twin's metric);
 *  5. the denylist, on plaintext, before hashing; then, for a NON-holder
 *     inside the cool-down (unlink stamps it — the anti-hoarding
 *     fix: claim→unlink→claim-another is a rename in two verbs), a
 *     pre-read of the exact-name row at every active version: the caller's
 *     OWN live tombstone at any of them admits the reclaim
 *     (`reclaimingOwn`, the former-owner right — on a retiring
 *     version too), anything else is the frozen refusal without a
 *     transaction — this precheck needs the claim keys, so it sits after
 *     the hash and the budgets (a refused attempt burns budget, never the
 *     cool-down); then
 *     the transaction — `claimUsername` for a group holding no name,
 *     `renameUsername` (the five-item Put-overwrite transaction) for a
 *     holder.
 *
 * ONE body behind two thin route wrappers: `spelling` is the only thing the
 * route key contributes, and step 2b is the only place that reads it.
 */
const makeUsernameClaimHandler =
  (spelling: 'claim' | 'rename'): AuthedHandler =>
  async (event, deps, auth) => {
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
    // Step 2b: the /claim spelling never renames. A group that holds a name
    // changes it only through the /rename spelling (the explicit intent);
    // every /claim on it — another name, the held name, a stale sibling's
    // retype — is the frozen refusal before any budget is drawn.
    if (spelling === 'claim' && held.length > 0) return usernameRefusal();
    // The cool-down (caller state only — the transactions' condition is the
    // enforcement and rename/unlink consume it on success alone): the
    // same cutoff arithmetic the five-item rename and the claim condition on.
    // The LATER of the group's stamp and the caller's own (the stamp a
    // dissolving unlink carried onto the member — the 2026-10-08 gate pass;
    // the next lazy-solo attach copies it onto the group it mints, so the
    // transaction's group-row condition agrees).
    const inCooldown = cooldownRunning(
      latestUsernameStamp(group.usernameRenamedAt, caller.usernameRenamedAt),
      nowSeconds,
    );
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
      // like every read of this class, reaps an elapsed tombstone. "Own"
      // means the GROUP that held the name — or, since 2026-10-08 (the
      // field report's S3), the MEMBER whose dissolving unlink left it:
      // that group died in the unlink's own transaction, so the take-back
      // the unlink confirmation promises can only be exercised by the person
      // (`formerUserId`), from whatever fresh group they verify into next.
      let reclaimingOwn = false;
      if (inCooldown) {
        for (const key of claimKeys) {
          const standing = await deps.db.getUsernameClaim(key, nowSeconds);
          if (
            standing !== undefined &&
            'tombstoned' in standing &&
            (standing.formerGroupId === caller.groupId || standing.formerUserId === auth.userId)
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
 * GET /v1/identifiers/username/eligibility — the caller's own readiness for
 * username claim and lookup. It accepts no name or target and returns only
 * whether this account group holds an email or phone possession proof. The
 * group read means a verified linked sibling qualifies even when this device
 * has no local identifier row.
 */
const usernameEligibilityHandler: AuthedHandler = async (_event, deps, auth) => {
  if ((await deps.rateLimit.take(`idroute:${auth.userId}`, LIMITS.identifierRoute)) > 0) {
    return usernameRefusal();
  }
  // The pointer is authorization-adjacent: an amicable unlink can leave a
  // stale eventual read naming the former group. Read it strongly, then
  // require the caller in the authoritative roster before consuming any of
  // that group's proof state.
  const caller = await deps.db.getUserById(auth.userId, undefined, { consistent: true });
  if (!identifierEligible(caller)) return usernameRefusal();

  let hasVerifiedIdentifier = false;
  if (caller.groupId !== undefined) {
    const group = await deps.db.getAccountGroup(caller.groupId);
    if (group?.members.some((member) => member.userId === auth.userId)) {
      hasVerifiedIdentifier =
        classRefs(group.identifierRefs, EMAIL_CLAIM_KEY_PREFIX).length > 0 ||
        classRefs(group.identifierRefs, PHONE_CLAIM_KEY_PREFIX).length > 0;
    }
  }
  const response: UsernameEligibilityResponse = { hasVerifiedIdentifier };
  return json(200, response);
};

/**
 * GET /v1/identifiers/state (2026-10-08, the field report's sibling fix —
 * taken by recommendation): the caller's
 * OWN account-group facts, and nothing about any other party. A linked
 * sibling (an iPad, a Mac, a reinstalled phone) holds no local identifier
 * rows — the server never echoes a name (§4.9) and the rows do not sync —
 * so without this read the app showed the claim form, the attach form and
 * the own-name refusals on every device but the one that acted. The five
 * strict keys of `IdentifierStateResponse`, in the pinned order:
 *  - `hasVerifiedIdentifier`: the eligibility read's EXACT boolean (email
 *    OR phone ref present) — the claim and username-lookup gate;
 *  - `emailLinked` / `phoneLinked`: a verified claim of that class stands
 *    on the group (the attach form is wrong on a sibling when it does);
 *  - `holdsUsername`: the group holds a username ref (the claim form is
 *    wrong when it does; a local row is a phantom when it does not);
 *  - `usernameCooldownUntil`: the §4.8 rename/unlink cool-down's END in
 *    UNIX SECONDS while a window runs (`usernameRenamedAt + 30 d`, the
 *    exact arithmetic the rename and claim conditions use), else null —
 *    from the LATER of the group's stamp and the caller's own user-row
 *    stamp (the one a dissolving unlink carried; the gate pass), so a
 *    solo device that just removed its last identifier still reads the
 *    window it is inside;
 *  - `usernameSince` / `emailSince` (the 2026-10-08 gate pass): the unix
 *    seconds the LIVE claim row of that class was written, or null — the
 *    one fact that tells a device its local row is a PHANTOM when a
 *    sibling RENAMED the name or REPLACED the address (both leave
 *    `holdsUsername` / `emailLinked` true). A stamp, never a name;
 *  - `usernameFindable`: the held name's consent bit as the server holds
 *    it, or null — a sibling's rename form starts at the current value
 *    instead of a default it could not see;
 *  - `emailFindable` (the 2026-10-08 proof pass): the linked email's
 *    consent bit the same way, or null — so a sibling's Email screen can
 *    show and move findability by email (the consent write is group-keyed)
 *    after the linking device is lost, reinstalled or recovered.
 *
 * A NEW route rather than a field on the eligibility read, deliberately:
 * `UsernameEligibilityResponse` is parsed `.strict()` by builds 31-33 with
 * no OTA path, so one new field THERE would disable username claim and
 * search fleet-wide the day this deploys; that shape stays byte-identical.
 *
 * The same discipline as the eligibility read, line for line: the caller
 * pointer is read STRONGLY and the caller must stand in the AUTHORITATIVE
 * roster before any fact of that group is consumed — a stale post-unlink
 * pointer reads every fact false and no window, never the former group's
 * email or name slot. No name, no claim key, no hash, no ULID, no target,
 * no refusal reason travels — the plan's "no refusal reason travels on a
 * caller-owned read" is amended to "no fact about ANOTHER party travels on
 * a caller-owned read" (ruled 2026-10-08): these facts are the
 * caller's own account, which the caller's own device already displays on
 * the device that acted. Charged to its OWN caller-keyed bucket
 * (`idstate:<userId>`, 30/min — U3): the app reads it on every account
 * screen mount, so it must never draw the shared 10/min `idroute:` window a
 * focused session's claims, toggles and lookups already spend; refused in
 * the frozen shape like every refusal of this lane, and flag-gated exactly
 * like the eligibility read (dark class, dark facts).
 */
const identifierStateHandler: AuthedHandler = async (_event, deps, auth) => {
  if ((await deps.rateLimit.take(`idstate:${auth.userId}`, LIMITS.identifierState)) > 0) {
    return usernameRefusal();
  }
  const caller = await deps.db.getUserById(auth.userId, undefined, { consistent: true });
  if (!identifierEligible(caller)) return usernameRefusal();

  const nowSeconds = Math.floor(deps.now() / 1000);
  const response: IdentifierStateResponse = {
    hasVerifiedIdentifier: false,
    emailLinked: false,
    phoneLinked: false,
    holdsUsername: false,
    usernameCooldownUntil: null,
    usernameSince: null,
    emailSince: null,
    usernameFindable: null,
    emailFindable: null,
  };
  // The caller's OWN stamp first (a solo device after a dissolving unlink
  // holds the window on its user row and no group at all); the group's
  // stamp joins it below when the caller stands in the roster.
  let stamp = caller.usernameRenamedAt;
  if (caller.groupId !== undefined) {
    const group = await deps.db.getAccountGroup(caller.groupId);
    if (group?.members.some((member) => member.userId === auth.userId)) {
      const emailKeys = classRefs(group.identifierRefs, EMAIL_CLAIM_KEY_PREFIX);
      const usernameKeys = classRefs(group.identifierRefs, USERNAME_CLAIM_KEY_PREFIX);
      response.emailLinked = emailKeys.length > 0;
      response.phoneLinked = classRefs(group.identifierRefs, PHONE_CLAIM_KEY_PREFIX).length > 0;
      response.hasVerifiedIdentifier = response.emailLinked || response.phoneLinked;
      response.holdsUsername = usernameKeys.length > 0;
      stamp = latestUsernameStamp(group.usernameRenamedAt, stamp);
      // The live rows' birth stamps and the name's consent bit: two
      // strongly consistent GetItems off the group's own refs (never a
      // Query, never a name). A ref whose row is gone or tombstoned under
      // the handler's feet reads as no fact (null), never as a guess.
      if (usernameKeys.length > 0) {
        const live = await deps.db.getUsernameClaim(usernameKeys[0]!, nowSeconds);
        if (live !== undefined && !('tombstoned' in live)) {
          response.usernameSince = Math.floor(live.createdAt / 1000);
          response.usernameFindable = live.discoverable;
        }
      }
      if (emailKeys.length > 0) {
        const live = await deps.db.getIdentifierClaim(emailKeys[0]!);
        if (live !== undefined) {
          response.emailSince = Math.floor(live.verifiedAt / 1000);
          response.emailFindable = live.discoverable;
        }
      }
    }
  }
  response.usernameCooldownUntil = cooldownRunning(stamp, nowSeconds)
    ? stamp! + USERNAME_RENAME_COOLDOWN_SECONDS
    : null;
  return json(200, response);
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
// `/claim` and `/rename` are ONE body behind two route keys: the group's
// state decides which transaction runs, and the spelling — the
// client's declared intent — decides exactly one thing since 2026-10-08:
// the /claim spelling never renames (step 2b).
export const usernameClaimRoute: Handler = accountsUsernameRoute(makeUsernameClaimHandler('claim'));
export const usernameRenameRoute: Handler = accountsUsernameRoute(
  makeUsernameClaimHandler('rename'),
);
export const usernameUnlinkRoute: Handler = accountsUsernameRoute(usernameUnlinkHandler);
export const usernameEligibilityRoute: Handler = accountsUsernameRoute(usernameEligibilityHandler);
// The caller-owned state read (2026-10-08): its own handler, its own bucket,
// the same two flags.
export const identifierStateRoute: Handler = accountsUsernameRoute(identifierStateHandler);
