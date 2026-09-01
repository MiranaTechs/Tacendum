import {
  DISCOVERY_MIN_ACCOUNT_AGE_SECONDS,
  DiscoveryLookupRequest,
  SetDiscoverableRequest,
  normalizeEmailIdentifier,
  normalizePhoneIdentifier,
  normalizeUsernameIdentifier,
  usernameSkeleton,
  type DiscoveryLookupResponse,
} from '@tacendum/shared';
import { LIMITS } from '../ratelimit.js';
import {
  activeEmailClaimKeys,
  activeNameskelClaimKeys,
  activePhoneClaimKeys,
  activeUsernameClaimKeys,
  userRefForLog,
} from '../opaque-ref.js';
import {
  EMAIL_CLAIM_KEY_PREFIX,
  PHONE_CLAIM_KEY_PREFIX,
  USERNAME_CLAIM_KEY_PREFIX,
  identifierClaimDiscoverable,
  type IdentifierClaimRecord,
  type UsernameTombstoneRecord,
} from '../db/data.js';
import {
  accountsPhoneRoute,
  accountsRefusal,
  accountsRoute,
  accountsUsernameRoute,
} from './devices.js';
import {
  classRefs,
  hmacKeys,
  identifierEligible,
  type IdentifierClassPrefix,
} from './identifiers.js';
import {
  type AuthedHandler,
  type Handler,
  type HttpResult,
  json,
  parseJson,
  rateLimitedResult,
} from './http.js';

/**
 * Contact discovery, token-path: the
 * typed-single-identifier lookup — parallel `{email} xor {phone} xor
 * {username}` fields — and the owner's per-class
 * discoverability consent toggles. All libsignal-free (route placement)
 * and all master-flag routes, so the default-OFF `feature#accounts` flag is
 * checked FIRST and one operator write is the kill switch; the PHONE
 * class inside the shared lookup additionally rides `feature#accounts-phone`
 * (the two-tier switch, — the recovery legs' exact pattern) and
 * the USERNAME class rides `feature#accounts-username` at the same position
 * (the third class on the same spine, nothing doubled).
 *
 * THE RULE-2 SURFACE OF THE WHOLE PROGRAM. The lookup is the endpoint the
 * three-way oracle test exists for: for every identifier the caller has no
 * consented right to resolve — unregistered, registered-but-not-discoverable,
 * inside the recovery cool-down, or (username class) a live tombstone — and
 * for every refused caller and every exhausted budget, the answer is ONE
 * frozen result object, `discoveryRefusal` below: bytes, status, and headers
 * uniform across EVERY refusal.
 *
 * The TIME clause, stated with its honest boundary:
 * the rule demands time-uniformity across IDENTIFIERS — "answers identically
 * for every X the caller has no consented right to resolve." The
 * identifier-KEYED refusal classes {miss, non-consented hit, in-cool-down
 * hit} therefore do IDENTICAL work into the single exit (the unconditional
 * all-versions walk below), with the pinned 5 ms median bound as the
 * empirical detector. The earlier returns (burst, daily, fleet, missing key,
 * malformed body, caller gate) are CALLER-keyed and identifier-independent:
 * for a fixed caller state they fire the same way for every X — several
 * before X is even parsed — so their shorter latency teaches a caller only
 * its OWN state, never anything about an address. A runtime fixed-floor pad
 * that would equalize even those was considered and refused — new machinery
 * and a new pinned constant; the structural single-exit + pinned
 * empirical bound on the X-keyed classes is the chosen enforcement.
 *
 * Rule 5 binds every log line here exactly as in identifiers.ts: no
 * identifier, no ULID, no groupId — opaque refs only, and the fleet-refused
 * scrape event is deliberately field-free.
 */

/**
 * THE single shared exit of the lookup's every refusal — a FROZEN singleton
 * of the program's collapsed refusal, so a suite can assert with reference
 * identity (not merely byte equality) that the miss branch and the
 * non-consented branch returned through ONE exit function. Deliberately the
 * same bytes as `accountsRefusal`: one program, one refusal stream.
 *
 * Unlike every other route's caller-keyed budgets, the lookup's budget
 * refusals ALSO return this shape — never a 429: on this route
 * the refusal shape is itself the oracle surface, and "my budget ran out"
 * vs "the address is not resolvable" must be indistinguishable to a scraper
 * pacing its probes off the answer.
 */
const DISCOVERY_UNIFORM_REFUSAL: HttpResult = Object.freeze(accountsRefusal());
export function discoveryRefusal(): HttpResult {
  return DISCOVERY_UNIFORM_REFUSAL;
}

/**
 * POST /v1/discovery/lookup: typed single identifier → the minimal
 * disclosure (member ULIDs + classes + roster version) — iff the identifier's
 * OWNER consented to be found and no recovery cool-down is pending. Priced
 * BEFORE resolution (the ws.ts priced-oracle precedent): every budget and
 * every caller gate spends before anything identifier-shaped is read.
 */
const discoveryLookupHandler: AuthedHandler = async (event, deps, auth) => {
  const keys = await hmacKeys(deps);
  if (!keys) return discoveryRefusal();
  // Parse BEFORE any budget is charged: the parse
  // is pure CPU — no read rides it — and the class it names decides which
  // kill switch governs the request, so nothing is spent until the request
  // is known to be well-formed and its class live. Parse failures collapse
  // (the accounts-program rule): a zod issue list would disclose the request
  // shape of a route the caller may only be probing — and the schema is
  // `.strict` + exactly-one-of, so a batch-shaped payload ({email,
  // emails:[…]}), a both-fields, or a neither-field shape is malformed here,
  // never a quietly-stripped multi-lookup (the typed-single wire contract,
  // enforced).
  const parsed = parseJson(event, DiscoveryLookupRequest);
  if (!parsed.ok) return discoveryRefusal();
  // THE PARALLEL-FIELD WIRE: the identifier class
  // IS the populated field — no discriminant. A phone-classed lookup rides
  // the phone kill switch (the two-tier rule, the recovery-leg
  // pattern): `feature#accounts-phone` ABSENT collapses the phone CLASS
  // alone with the same frozen bytes, while the email path keeps its
  // landed read sequence untouched (no phone-flag read joins the
  // live email path). The
  // read rides only the caller's own declared class — never anything about
  // an address — so it is not an identifier-keyed timing surface; it fires
  // FLAT, once, for every phone-classed request regardless of what the
  // number resolves to, and the email
  // class never pays it — the cross-class latency step it adds is a
  // deployment fact about a class the CALLER chose, never an address fact.
  const phoneClassed = parsed.data.phone !== undefined;
  if (phoneClassed && !(await deps.db.isAccountsPhoneFeatureEnabled())) {
    return discoveryRefusal();
  }
  // THE USERNAME CLASS'S KILL SWITCH, at the SAME position ("the sub-flag read at the phone-flag's position, before the
  // shared burst window"): `feature#accounts-username` ABSENT collapses the
  // username CLASS alone with the same frozen bytes, spends nothing, and
  // joins neither the email nor the phone path — the read rides ONLY a
  // username-classed request, FLAT, once, whatever the name resolves to
  // (pinned by count in accounts-username-discovery.test.ts), exactly the
  // phone read's discipline. The same row is the K_id rotation-window brake
  //with it deleted, no username lookup reads across a mixed fleet.
  const usernameClassed = parsed.data.username !== undefined;
  if (usernameClassed && !(await deps.db.isAccountsUsernameFeatureEnabled())) {
    return discoveryRefusal();
  }

  // The per-DEVICE burst brake — before every caller-gate read below (:
  // priced before resolution; release pin: 5/min), but AFTER the parse and
  // the class-flag check: the burst window is ONE
  // across classes, so a DARK phone class must not spend the LIVE email
  // class's shared window — five flag-OFF phone probes used to starve the
  // caller's own email lookups for the minute under a green kill-switch
  // suite. The one flag GetItem this places ahead of the brake rides only
  // phone-classed requests, and the wrapper's master-flag and bearer-auth
  // reads already precede the brake for EVERY request — the brake's job is
  // unchanged: it prices the caller-gate reads below, never the wrapper's.
  // Deliberately keyed to the calling ULID, not the group (the pushmsg-rcpt
  // shape: it protects those reads from one hot device, and a 3-member
  // group's worst-case 15/min transient is capped by the GROUP-keyed daily
  // budget either way). In AWS `deps.rateLimit` is the DDB fixed-window
  // limiter, so every count here is fleet-wide by construction — two warm
  // containers share one window (the budget suite drives exactly that).
  // Refusals are the uniform exit, never a 429 (header note).
  if ((await deps.rateLimit.take(`discburst:${auth.userId}`, LIMITS.discoveryLookupBurst)) > 0) {
    return discoveryRefusal();
  }

  // THE ANTI-SYBIL CALLER GATE: the
  // caller must hold a VERIFIED identifier of its own — a real inbox
  // round-trip per attacker identity, priced by the send budgets — and be
  // at least 72 h old. Identity keypairs are free; these two are what a
  // freshly minted fleet of them cannot have. Both refusals are the uniform
  // exit: the gate must not become its own oracle about the CALLER either.
  const caller = await deps.db.getUserById(auth.userId);
  if (!identifierEligible(caller)) return discoveryRefusal();
  if (deps.now() - caller.createdAt < DISCOVERY_MIN_ACCOUNT_AGE_SECONDS * 1000) {
    return discoveryRefusal();
  }
  if (caller.groupId === undefined) return discoveryRefusal();
  const callerGroup = await deps.db.getAccountGroup(caller.groupId);
  if (!callerGroup) return discoveryRefusal();
  // THE POSSESSION-CLASS PIN (load-bearing): the
  // "verified identifier" above means a POSSESSION-PROOF identifier — email
  // or phone, the classes an inbox round-trip mints. A username is free to
  // hold (holding a name qualifies you to BE FOUND, never to SEARCH),
  // so the landed any-ref-at-all spelling of this check would have let a
  // username-only group pass this gate and the verified-inbox cost per
  // attacker identity evaporate. With the claim gate a username-only
  // group cannot even be minted, but a group can SHED its possession proof
  // after claiming (an email unlink leaves the name standing) — and the pin
  // stands on its own regardless: defense in depth, never a dependency on
  // the claim lane. Class-BLIND across the two possession classes:
  // a phone-only caller searches email space and vice versa.
  const possessionRefs =
    classRefs(callerGroup.identifierRefs, EMAIL_CLAIM_KEY_PREFIX).length +
    classRefs(callerGroup.identifierRefs, PHONE_CLAIM_KEY_PREFIX).length;
  if (possessionRefs === 0) return discoveryRefusal();

  // THE PER-ACCOUNT DAILY BUDGET, keyed by the GROUP: the
  // account object IS the grouping so the pinned
  // "per-account 20 lookups/day" is ONE budget across every linked member —
  // keying by auth.userId would hand a 3-member group 60/day, tripling what
  // one verified inbox buys (verification eligibility is satisfied by the
  // GROUP's identifier, so the budget must collapse to the same scope, the
  // emailattach:<group> precedent). Taken after the gate reads because the
  // scope IS the group id; still before the fleet ceiling and before
  // anything identifier-shaped is read.
  if ((await deps.rateLimit.take(`disc:${caller.groupId}`, LIMITS.discoveryLookup)) > 0) {
    return discoveryRefusal();
  }
  // THE SAME 20/DAY, ANCHORED TO THE CALLING USER TOO: the
  // group window alone is churn-resettable — unlinking a
  // lazy-solo group's last identifier deletes the group row, and the next
  // verified attach (a fresh email alias, inside the 10/day attach
  // allowance) mints a NEW groupId while the user's 72 h age carries over —
  // so one aged user could re-mint `disc:` up to 11 times a day (~220
  // lookups) and the documented 100-aged-user fleet price collapsed to ~10.
  // The user row is the anchor churn cannot shed: a fresh userId means a
  // fresh 72 h clock. Same pinned constant, ONE more window — an admitted
  // lookup spends BOTH, so a 3-member group still shares 20/day total (the
  // group collapse stands; this window only ever shrinks capacity, never
  // grants). One cross-charge direction exists: a user-window refusal here
  // lands after the group take, so the probe cost the group window a token
  // without being admitted — a sibling can spend the shared window exactly
  // as fast by being admitted, so nothing amplifies (the
  // bounded-exception class). Refusal: the uniform exit, never a 429.
  if ((await deps.rateLimit.take(`discuser:${auth.userId}`, LIMITS.discoveryLookup)) > 0) {
    return discoveryRefusal();
  }

  // The fleet-wide global ceiling (release pin: 2,000/day), taken AFTER the
  // gate so Sybil-cheap identities can never draw the shared budget down,
  // and BEFORE resolution so the ceiling prices the read. Beyond it: uniform
  // refusals + the scrape-alarm event (field-free; the infra metric
  // filter counts it, and the `feature#accounts` flag is the one-write kill
  // switch that stops a detected crawl outright).
  if ((await deps.rateLimit.take('disc-fleet', LIMITS.discoveryLookupFleet)) > 0) {
    deps.log('discovery_lookup_fleet_refused');
    return discoveryRefusal();
  }
  // The ADMITTED-volume counter, SPLIT PER CLASS:
  // field-free (no identifier-derived fields), emitted for every admitted
  // probe BEFORE resolution — hit, miss, and non-consented alike, so it is
  // branch-identical work AND the signal the anomaly alarm reads. The
  // over-cap scrape event above fires only past the ceiling; each class's
  // counter makes an under-cap sustained crawl of ITS space (including the
  // fixed window's accepted 2× boundary artifact — ratelimit-ddb.ts)
  // visible at 50% of the shared daily ceiling without any refusal ever
  // happening — a phone-targeted crawl pages on its OWN volume in days,
  // never hiding inside email volume at year scale. The class is the
  // caller's own request field (never an address fact), so the split
  // discloses nothing the log discipline protects. The username class's counter joined
  // at (third admitted counter) with the same 50%-of-ceiling
  // alarm twin in infra, and the aggregate alarm sums all three.
  deps.log(
    usernameClassed
      ? 'discovery_lookup_admitted_username'
      : phoneClassed
        ? 'discovery_lookup_admitted_phone'
        : 'discovery_lookup_admitted',
  );

  // RESOLUTION — and from here to the single exit, the miss and the
  // non-consented branches do IDENTICAL work ('s TIME clause):
  // every active key version is read UNCONDITIONALLY (no short-circuit on
  // first hit — during a rotation window a newest-version hit and a total
  // miss must cost the same two GetItems), the read-time rule is ONE pure
  // function call either way, and both failure modes fall through to the
  // same frozen return. Only the POSITIVE branch does more (the group read,
  // the opportunistic migration) — a branch already distinguishable by its
  // answer, so extra work there discloses nothing. The walk is the
  // populated field's OWN claim prefix — claim keys are
  // prefix-disjoint, so a phone lookup can never resolve an email claim or
  // vice versa — and everything downstream of `candidates` is class-blind.
  // THE USERNAME CLASS walks
  // `activeUsernameClaimKeys` — the EXACT-name row only; the skeleton row is
  // anti-squat, never fuzzy-match — through the class's OWN read,
  // `getUsernameClaim`: one strongly consistent GetItem per version, exactly
  // the possession classes' cost, but it SEES tombstones. A live tombstone
  // (rename, unlink, deletion, revocation — held for the 30-day window) is
  // answered as a record whose `tombstoned` bit `identifierClaimDiscoverable`
  // reads as NON-CONSENTED: the same one helper call, the same frozen exit,
  // no branch of its own — the timing suite samples it beside the miss and
  // the non-consented hit under the same 5 ms pin. An ELAPSED tombstone
  // reads as a miss and is reaped by that read (the read-is-the-reaper
  // rule) — a one-shot write on a key nobody holds, never a repeatable
  // timing signature: the very next probe of that name IS a plain miss.
  // COOL-DOWN SEMANTICS, N/A FOR THIS CLASS — stated, not assumed: the
  // recovery cool-down (`discoverableAfter`) is ARMED by recovery completion
  // onto the identifier that proved the code, and recovery is EXCLUDED for
  // the username class absolutely (the recovery wires reject the key
  // at `.strict`), so no username-KEYED cool-down shadow
  // can ever be written. The only way a username claim carries the
  // attribute is by INHERITING a still-live group-row carrier at claim time
  // (the attach lane's re-arm rule, mirrored by the claim handler), and that
  // inherited value rides the SAME read-time helper below — no username-
  // specific arithmetic exists here, which is exactly why none is tested as
  // a fourth username branch: the in-cool-down class is pinned once, on the
  // possession classes that can arm it.
  const normalized = usernameClassed
    ? normalizeUsernameIdentifier(parsed.data.username!)
    : phoneClassed
      ? normalizePhoneIdentifier(parsed.data.phone!)
      : normalizeEmailIdentifier(parsed.data.email!);
  const nowSeconds = Math.floor(deps.now() / 1000);
  const candidates = usernameClassed
    ? activeUsernameClaimKeys(keys, normalized)
    : phoneClassed
      ? activePhoneClaimKeys(keys, normalized)
      : activeEmailClaimKeys(keys, normalized);
  const found: Array<IdentifierClaimRecord | UsernameTombstoneRecord | undefined> = [];
  for (const claimKey of candidates) {
    found.push(
      usernameClassed
        ? await deps.db.getUsernameClaim(claimKey, nowSeconds)
        : await deps.db.getIdentifierClaim(claimKey),
    );
  }
  const hitIndex = found.findIndex((claim) => claim !== undefined);
  const claim = hitIndex >= 0 ? found[hitIndex] : undefined;
  // The read-time rule, through its ONE named helper — consent AND any
  // recovery cool-down elapsed, AND not a tombstone (the lookup
  // routes through `identifierClaimDiscoverable`, never a
  // re-derivation). Only a LIVE claim passes the guard, so `claim.groupId`
  // below is typed by it.
  //
  // SELF-DISCOVERY IS A MISS (field-reported, device-verified: the lookup
  // used to resolve the caller's OWN identifier, and the self-conversation
  // it seeded rendered undecryptable on every client). Consent is consent to
  // be found BY OTHERS — a claim owned by the CALLER'S OWN group is an
  // identifier the caller has no consented right to resolve through
  // discovery, so it joins the refusal classes: the third clause of the
  // ONE exit condition, after the guard (so the helper call is unconditional
  // — the same work as the non-consented hit, one pure ULID compare more),
  // never an early return of its own. `caller.groupId` is defined here (the
  // gate above refused the ungrouped), and keying on the GROUP means a
  // linked sibling's device is "self" too — the account IS the group.
  // The frozen bytes, the skipped group read, and the skipped migration are
  // exactly the miss branch's; no write, no tombstone, no new copy.
  if (
    claim === undefined ||
    !identifierClaimDiscoverable(claim, nowSeconds) ||
    claim.groupId === caller.groupId
  ) {
    return discoveryRefusal();
  }

  // POSITIVE: the claim's group, read only now (the refusal branches never
  // read it — that skipped GetItem is exactly what the timing suite would
  // catch on the wrong side). A claim whose group vanished mid-flight (a
  // raced dissolve) refuses through the same exit.
  const group = await deps.db.getAccountGroup(claim.groupId);
  if (!group || group.members.length === 0) return discoveryRefusal();

  // Opportunistic K_id forward-migration (the
  // wiring): a claim that resolved under a RETIRING key version re-writes
  // under the newest, best-effort, POSITIVE PATH ONLY — migrating on an
  // internal non-consented hit would make that refusal branch do write-work
  // a miss does not (refusal uniformity outranks migration opportunism; the recovery
  // legs made the same call). A dormant non-discoverable
  // row waits for a resolution moment that is already distinguishable, or
  // for the rotation window's stated invalidation cost. CLASS-BLIND: the candidates above already carry the class's
  // own prefix, so this same call is the phone claims' forward-migration
  // site — the -recorded "no phone migration caller yet" bound is
  // discharged in this commit. The username class rides the same
  // call: its skeleton twin is versioned with the namespace so the
  // newest-version skeleton key travels with the claim — derived HERE, on
  // the positive branch only, from the skeleton the server never stores
  // (the data layer throws on a username migration without it, so a name
  // whose anti-squat row stayed behind on a retiring version is impossible
  // rather than silent).
  if (hitIndex > 0) {
    await deps.db.migrateIdentifierClaimForward({
      oldClaimKey: candidates[hitIndex]!,
      newClaimKey: candidates[0]!,
      claim,
      ...(usernameClassed
        ? { newSkeletonKey: activeNameskelClaimKeys(keys, usernameSkeleton(normalized))[0]! }
        : {}),
    });
  }

  // Opaque caller ref only: no identifier, no target ULID, no
  // groupId in the retained log — this event is the volume signal the
  // anomaly monitoring reads.
  deps.log('discovery_lookup_resolved', {
    userRef: userRefForLog(auth.userId, deps.userRefSalt),
  });
  // RULED, on the record: the hit body must stop
  // disclosing per-member device classes — "why the need to disclose how
  // many devices the user has and what they are chatting with." This is the
  // ONE hit-body site: the email lookup, the phone lookup, and the
  // username lookup share this builder, so all three classes are covered
  // here — and the username class adds NO byte to it (response
  // unchanged, no echo of the name — pointer never proof).
  // WHY A CONSTANT AND NOT A DROPPED FIELD: shipped clients zod-`.parse`
  // DiscoveryLookupResponse with `class` REQUIRED (app/src/api.ts:644,698;
  // dto.ts:1309-1312) and there is no OTA — omitting the field bricks every
  // shipped client's parse. The constant literal 'phone' for EVERY member
  // satisfies the old parsers while disclosing nothing: the same literal for
  // everyone carries zero bits about the target's fleet.
  // SEQUENCING (the named remaining step — deliberately NOT done here):
  // build 19 makes the DTO `class` optional + hardens the anchor; a LATER
  // deploy, once shipped clients run build 19, drops the field and
  // re-cuts the wire fixture.
  const body: DiscoveryLookupResponse = {
    members: group.members.map((m) => ({ userId: m.userId, class: 'phone' })),
    rosterVersion: group.epoch,
  };
  return json(200, body);
};

/**
 * POST /v1/identifiers/email/discoverable: the consent toggle — an
 * owner-written attribute on the identifier claim row, default OFF, the
 * uniform-204 write shape (write-authority
 * discipline per consent.ts): every well-formed write answers 204 whether
 * the caller's group holds a claim or not — silently lossy for the claimless
 * caller, exactly like the over-cap consent write — so the answer teaches
 * nothing the caller did not already know. The caller-keyed route budget's
 * 429 is the one distinguishable refusal (it discloses only the caller's own
 * spend), and a malformed body collapses like every accounts route.
 *
 * OFF is immediate: the lookup's read-time rule consults the claim row
 * strongly-consistently, so consent withdrawn is consent gone on the next
 * read — no cache, no propagation window. The cool-down attribute is
 * deliberately untouched in either direction (consent and cool-down are
 * independent halves of the rule).
 */
const makeSetDiscoverableHandler = (classPrefix: IdentifierClassPrefix): AuthedHandler =>
  async (event, deps, auth) => {
  const retry = await deps.rateLimit.take(`idroute:${auth.userId}`, LIMITS.identifierRoute);
  if (retry > 0) return rateLimitedResult(retry);
  const parsed = parseJson(event, SetDiscoverableRequest);
  if (!parsed.ok) return accountsRefusal();
  const caller = await deps.db.getUserById(auth.userId);
  if (!identifierEligible(caller)) return accountsRefusal();
  if (caller.groupId !== undefined) {
    const group = await deps.db.getAccountGroup(caller.groupId);
    if (group) {
      // CONSENT IS PER CLASS: each route toggles ONLY its own
      // class's claim rows — the class-prefix filter over the refs snapshot,
      // so email consent never implies phone consent and neither ever
      // implies the other. Behavior-identical for the single-class group
      // the landed email route served (its refs were all emailhash#).
      for (const claimKey of classRefs(group.identifierRefs, classPrefix)) {
        // These snapshot reads are UX; the write's own transaction is the
        // authorization: the groupId pin makes a
        // stale caller's write on a re-claimed key a no-op, and the
        // in-transaction `contains(memberIds,:actor)` condition refuses a
        // caller whose membership ended after the reads above (or that a
        // stale user-row read still showed grouped) — every 'gone' absorbed
        // into the uniform 204. The claimless caller's shorter path here
        // discloses only the caller's OWN state (which it already knows),
        // never anything about another party — the uniform-204
        // shape governs the bytes, and they are identical.
        await deps.db.setIdentifierDiscoverable(
          claimKey,
          caller.groupId,
          auth.userId,
          parsed.data.discoverable,
        );
      }
    }
  }
  // Outcome-free and party-free (the consent.ts stance): the
  // retained log must not become the consent ledger the route refuses to
  // serve.
  deps.log('discovery_consent_write');
  return { statusCode: 204 };
};

// The wrapped routes (flag FIRST, then bearer auth — devices.ts): what the
// local adapter and the ordinary HTTP Lambda host mount — libsignal-free.
// The phone consent toggle rides accountsPhoneRoute (master AND phone flag); phone LOOKUP resolution is.
export const discoveryLookupRoute: Handler = accountsRoute(discoveryLookupHandler);
export const setDiscoverableRoute: Handler = accountsRoute(
  makeSetDiscoverableHandler(EMAIL_CLAIM_KEY_PREFIX),
);
export const setPhoneDiscoverableRoute: Handler = accountsPhoneRoute(
  makeSetDiscoverableHandler(PHONE_CLAIM_KEY_PREFIX),
);
// The username class's consent toggle: the SAME
// per-class handler behind accountsUsernameRoute (master AND username flag).
// The claim wrote the explicit consent-at-claim bit; this is the standing
// revocation/re-grant, OFF immediate on the next strongly consistent read.
// A tombstone carries no groupId, so the owner-pinned write is a no-op on it
// by construction — absorbed into the uniform 204 like every other 'gone'.
export const setUsernameDiscoverableRoute: Handler = accountsUsernameRoute(
  makeSetDiscoverableHandler(USERNAME_CLAIM_KEY_PREFIX),
);
