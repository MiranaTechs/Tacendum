import { createHash, createHmac } from 'node:crypto';

/**
 * The server's ONE keyed pseudonymization: an
 * HMAC-SHA256 over the userId, truncated. Moved here from handlers/turn.ts
 * so the same primitive can pseudonymize the
 * identity-bearing lifecycle log events and the activity actor key, not just
 * the STUN username.
 *
 * ONE stored secret, THREE key domains (design decision, on
 * cross-ledger joinability). The stored secret is the coturn user salt
 * (Secrets Manager `CoturnUserSalt` in AWS, `TURN_USER_SALT` locally) — no
 * second provisioned secret. But the three ref spaces no longer share a key:
 *
 * - the STUN username ref (handlers/turn.ts) keys the HMAC with the RAW
 * salt — byte-for-byte the derivation coturn has always been given, so
 * that surface's refs do not change;
 * - lifecycle log events (`userRef` fields) key it with
 * HMAC-SHA256(salt, LOG_REF_DOMAIN), so CloudWatch keeps a stable
 * debugging pseudonym instead of a 3-month per-user sign-in history in
 * raw ULIDs;
 * - the activity actor key (activity.ts) keys it with
 * HMAC-SHA256(salt, ACTIVITY_KEY_DOMAIN), so the 35-day presence table
 * cannot be reversed by hashing every known userId.
 *
 * What the separation buys, stated plainly (it replaces the one-key trade
 * this header used to disclose): anyone holding two of the three surfaces —
 * coturn's relay log, our CloudWatch logs, the activity table — can no
 * longer join them on the ref, because each surface's refs live under a
 * different derived key. No surface holds a userId; none of the three keys
 * reverses to the salt. Rotating the ONE stored salt still rotates all
 * three domains at once — one secret to manage, one rotation story, three
 * unjoinable ref spaces.
 */

/** Per-purpose key domains. Named once here so no derivation ever spells a
 * domain string inline (an inline twin that drifted would silently fork a
 * fourth ref space). The STUN domain has no constant: its "domain key" is
 * the raw salt itself, fixed by what coturn computes. */
const LOG_REF_DOMAIN = 'log-ref';
const ACTIVITY_KEY_DOMAIN = 'activity-key';

/** Domain keys are derived once per (salt, domain) and cached: the salt is
 * fetched once per process (cold start), so this map holds a handful of
 * entries in production — recomputing the outer HMAC per log line would be
 * harmless but pointless. The cache id is a ONE-WAY digest of (domain, salt),
 * NEVER the raw salt: K_id (and the coturn salt) must not linger as a
 * plaintext Map KEY in a long-lived process where a heap dump could read it
 *. Distinct per (domain, salt) so a test that rotates salts
 * still gets fresh keys, and irreversible so the id discloses no secret. */
const domainKeys = new Map<string, Buffer>();

function domainKey(salt: string, domain: string): Buffer {
  const cacheId = createHash('sha256').update(domain).update(String.fromCharCode(0)).update(salt).digest('base64');
  let key = domainKeys.get(cacheId);
  if (!key) {
    key = createHmac('sha256', salt).update(domain).digest();
    domainKeys.set(cacheId, key);
  }
  return key;
}

/**
 * A stable, opaque per-user handle under the given key. Truncated to 16
 * base64url chars (96 bits): far beyond collision range for any plausible
 * user count, and short enough to keep the STUN username attribute small.
 * Keyed so it cannot be reversed by enumerating userIds, and so rotating
 * the salt breaks correlation of old relay logs to new ones. The key is the
 * raw salt for the STUN domain (turn.ts — unchanged bytes) and a derived
 * per-purpose key for the log and activity domains (below).
 */
export function opaqueUserRef(userId: string, key: string | Buffer): string {
  return createHmac('sha256', key).update(userId).digest('base64url').slice(0, 16);
}

/**
 * What a log line carries when the salt is not available (deps.userRefSalt
 * unset: TURN not configured, or the Secrets Manager fetch still in flight on
 * a cold start). The event still fires; the identity is simply absent — the
 * raw ULID is never the fallback, matching the turn handler's posture of
 * never computing an unsalted ref. Greppable, so a deployment where every
 * ref reads this way is findable as the config gap it is.
 */
export const USER_REF_UNAVAILABLE = 'unavailable';

/** The `userRef` value for an identity-bearing log event: the opaque ref
 * under the log domain key when the salt is present, the `unavailable`
 * sentinel when it is not. */
export function userRefForLog(userId: string, salt: string | undefined): string {
  return salt ? opaqueUserRef(userId, domainKey(salt, LOG_REF_DOMAIN)) : USER_REF_UNAVAILABLE;
}

/** The activity table's actor ref: the opaque ref under the activity domain
 * key. Callers (activity.ts, the only ones) gate on the salt themselves —
 * their fail-open posture skips the write entirely rather than degrading
 * the KEY of a durable row to a sentinel. */
export function activityActorRef(userId: string, salt: string): string {
  return opaqueUserRef(userId, domainKey(salt, ACTIVITY_KEY_DOMAIN));
}

/**
 * THE THIRD NAMED SERVER HMAC — the identifier-claim construction.
 *
 * HMAC-SHA256 over the NORMALIZED identifier under `K_id` — a Secrets
 * Manager secret of its own (`IdentifierHmacKey` in AWS, plaintext
 * `IDENTIFIER_HMAC_KEY` locally, injected test keys in suites), NEVER the
 * coturn salt: the identifier ref space must not become joinable to the
 * relay/log/activity spaces above by sharing their root secret.
 *
 * The domain constant is applied as a DERIVED SUBKEY — this module's
 * existing LOG_REF/ACTIVITY shape, so the constant is IN the bytes, not
 * beside them:
 *
 * claim hash = HMAC-SHA256(HMAC-SHA256(K_id, "HMAC_IDENTIFIER"),
 * <normalized identifier>)
 *
 * The normalized identifier is CLASS-GENERAL: `normalizeEmailIdentifier`
 * for email claims,
 * `normalizePhoneIdentifier` (strict E.164) for phone claims — one
 * construction, one subkey, two syntactically DISJOINT input spaces (see
 * `phoneClaimKey` below for the argument written out).
 *
 * An undomain-separated HMAC(K_id, identifier) — or the constant merely
 * concatenated into the message — FAILS the byte fixture the suite pins
 * (accounts-identifier.test.ts). The digest is kept FULL LENGTH (43-char
 * base64url), unlike the truncated refs above: this value is a DDB claim
 * KEY, and collision headroom is what makes "one claim row per identifier"
 * a fact rather than a probability argument.
 *
 * What it buys, stated as states it: without `K_id` the stored table is
 * unreversible from a leak alone; WITH the key a compelled or malicious
 * operator enumerates at whatever rate it permits. Leak-resistance and
 * scraper-resistance, not server-blindness (the OPRF upgrade is the
 * named v2). Computed in THIS module only — no handler grows its own
 * createHmac call site (a pinned test enforces exactly that).
 */
export const HMAC_IDENTIFIER_DOMAIN = 'HMAC_IDENTIFIER';

/** The full-length claim hash for one normalized identifier under one K_id
 * version's key. The derived subkey rides the same per-(key, domain) cache
 * as the log/activity domains. */
export function identifierClaimHash(kId: string, normalizedIdentifier: string): string {
  return createHmac('sha256', domainKey(kId, HMAC_IDENTIFIER_DOMAIN))
    .update(normalizedIdentifier)
    .digest('base64url');
}

/** One K_id version: the claim key namespace is VERSIONED (`emailhash#v<K>#…`)
 * so the key can actually rotate — ≤2 active versions during a window,
 * resolution computes both, attach writes under the newest. */
export interface IdentifierHmacKey {
  version: number;
  key: string;
}

/** The versioned claim-row key for one identifier under one key version —
 * `emailhash#v<K>#<hash>`, the schema shape. */
export function emailClaimKey(keyVersion: number, claimHash: string): string {
  return `emailhash#v${keyVersion}#${claimHash}`;
}

/**
 * The versioned PHONE claim-row key — `phonehash#v<K>#<hash>` (the phone release pins). The hash inside it is the SAME
 * derived-subkey construction as email's — same `K_id`, same `HMAC_IDENTIFIER`
 * derived subkey, `identifierClaimHash` above, no new domain string and no
 * fourth server HMAC. That sharing is sound because the two NORMALIZED input
 * spaces are DISJOINT BY SYNTAX: a strict-E.164 phone matches
 * `^\+[1-9][0-9]{1,14}$` and can never contain `@`, while a normalized email
 * always carries exactly one — no single input byte-string inhabits both
 * classes, so no cross-class collision or confusion is constructible under
 * one subkey. The CLASS separation lives where row classes already separate:
 * this key PREFIX. The byte fixture pins the sharing (a class-prefixed
 * input or a distinct subkey FAILS the vector) and asserts the disjointness
 * it rides.
 */
export function phoneClaimKey(keyVersion: number, claimHash: string): string {
  return `phonehash#v${keyVersion}#${claimHash}`;
}

/**
 * The versioned USERNAME claim-row key — `usernamehash#v<K>#<hash>`
 * (DARK: no route computes these yet). The hash
 * inside it is the SAME derived-subkey construction as email's and phone's —
 * same `K_id`, same `HMAC_IDENTIFIER` derived subkey, `identifierClaimHash`
 * above, no new domain string and no fourth server HMAC. The sharing stays
 * sound because the THREE normalized input spaces are pairwise DISJOINT BY
 * SYNTAX, extending the two-way argument above: a normalized username
 * matches `^[a-z][a-z0-9_]{2,31}$` — never contains `@` (disjoint from
 * email), begins `[a-z]`, never `+` (disjoint from phone). No byte string
 * inhabits two classes, so no cross-class collision or confusion is
 * constructible under one subkey; CLASS separation lives where it already
 * lives — this key PREFIX. The byte fixture pins the sharing
 * (accounts-username-surface.test.ts: a class-prefixed input or a distinct
 * subkey FAILS the vector) and asserts the three-way disjointness it rides.
 */
export function usernameClaimKey(keyVersion: number, claimHash: string): string {
  return `usernamehash#v${keyVersion}#${claimHash}`;
}

/**
 * The username-SKELETON claim-row key — `nameskel#v<K>#<hash>`: the
 * second, anti-squat claim row a username claim writes conditionally beside
 * its exact-name row, derived from `usernameSkeleton(normalized)` under the
 * SAME subkey. Never a lookup class — resolution reads the exact-name row
 * only; this row exists so `a1ice` is unclaimable while `alice` stands. The
 * skeleton input space is a subset of the username charset minus `_`, so
 * the disjointness argument above is undisturbed; its row class lives at
 * this prefix.
 */
export function nameskelClaimKey(keyVersion: number, claimHash: string): string {
  return `nameskel#v${keyVersion}#${claimHash}`;
}

/** The resolution walk, generalized per class prefix: every
 * ACTIVE claim key for one normalized identifier under one class's key
 * builder, NEWEST version first — ≤2 GetItems inside a rotation window,
 * still zero scans. Attach writes under index 0. */
function activeClaimKeys(
  keys: readonly IdentifierHmacKey[],
  normalizedIdentifier: string,
  buildKey: (keyVersion: number, claimHash: string) => string,
): string[] {
  return [...keys]
    .sort((a, b) => b.version - a.version)
    .map((k) => buildKey(k.version, identifierClaimHash(k.key, normalizedIdentifier)));
}

/** Every ACTIVE email claim key, newest first (the landed walk). */
export function activeEmailClaimKeys(
  keys: readonly IdentifierHmacKey[],
  normalizedIdentifier: string,
): string[] {
  return activeClaimKeys(keys, normalizedIdentifier, emailClaimKey);
}

/** Every ACTIVE phone claim key, newest first — the same walk over the
 * `phonehash#` namespace. */
export function activePhoneClaimKeys(
  keys: readonly IdentifierHmacKey[],
  normalizedIdentifier: string,
): string[] {
  return activeClaimKeys(keys, normalizedIdentifier, phoneClaimKey);
}

/** Every ACTIVE username claim key, newest first — the same walk over the
 * `usernamehash#` namespace (the opaque-ref generalized
 * walk reused verbatim, ≤2 strongly consistent GetItems, zero Queries). */
export function activeUsernameClaimKeys(
  keys: readonly IdentifierHmacKey[],
  normalizedIdentifier: string,
): string[] {
  return activeClaimKeys(keys, normalizedIdentifier, usernameClaimKey);
}

/** Every ACTIVE username-SKELETON claim key, newest first — the same walk
 * over the `nameskel#` namespace: the claim transaction Puts index 0
 * and ConditionChecks the rest with the tombstone-aware expression, so a
 * confusable squat is refused across the whole rotation window exactly as
 * the exact-name row is. Input is the SKELETON (`usernameSkeleton(normalized)`),
 * never the name. */
export function activeNameskelClaimKeys(
  keys: readonly IdentifierHmacKey[],
  skeleton: string,
): string[] {
  return activeClaimKeys(keys, skeleton, nameskelClaimKey);
}

/** The suppression-row key for an identifier (bounces/complaints feed a
 * suppression list keyed by the HMAC ref, never the address) — versioned
 * with the claim namespace so rotation retires suppression state together
 * with the claims it shadowed. */
export function emailSuppressionKey(keyVersion: number, claimHash: string): string {
  return `emailsupp#v${keyVersion}#${claimHash}`;
}

/** The PHONE suppression shadow — `phonesupp#v<K>#<hash>`, the emailsupp#
 * shape at the same 90-day pin. Written ONLY from the vendor's
 * SYNCHRONOUS refusal: no DLR/event pipe exists to feed it
 * at full strength, and carrier/AWS-level STOP lists stay authoritative. */
export function phoneSuppressionKey(keyVersion: number, claimHash: string): string {
  return `phonesupp#v${keyVersion}#${claimHash}`;
}
