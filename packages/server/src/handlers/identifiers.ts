import { timingSafeEqual } from 'node:crypto';
import { ulid } from 'ulid';
import {
  EMAIL_CODE_TTL_SECONDS,
  EmailCodeRequest,
  EmailVerifyRequest,
  MAX_VERIFIED_IDENTIFIERS_PER_CLASS,
  PhoneCodeRequest,
  PhoneVerifyRequest,
  RECOVERY_DELAY_SECONDS,
  RECOVERY_DISCOVERY_COOLDOWN_SECONDS,
  RecoveryCodeRequest,
  RecoveryVerifyRequest,
  normalizeEmailIdentifier,
  normalizePhoneIdentifier,
  type AccountsNotice,
  type DeviceClass,
  type RecoveryVerifyResponse,
} from '@tacendum/shared';
import { LIMITS } from '../ratelimit.js';
import {
  activeEmailClaimKeys,
  activePhoneClaimKeys,
  emailSuppressionKey,
  identifierClaimHash,
  phoneSuppressionKey,
  userRefForLog,
  type IdentifierHmacKey,
} from '../opaque-ref.js';
import { smsDestinationAllowed } from '../sms/eum.js';
import {
  accountsPhoneRoute,
  accountsRefusal,
  accountsRoute,
  deliverAccountsNotice,
} from './devices.js';
import {
  EMAIL_CLAIM_KEY_PREFIX,
  PHONE_CLAIM_KEY_PREFIX,
  USERNAME_CLAIM_KEY_PREFIX,
  type IdentifierClaimRecord,
  type UserRecord,
} from '../db/data.js';
import {
  type AuthContext,
  type AuthedHandler,
  type Deps,
  type Handler,
  json,
  parseJson,
  rateLimitedResult,
} from './http.js';

/**
 * Email + phone linking and recovery, token-path half (the phone twin joined — same shapes, same refusal
 * discipline, with the class differences named at each divergence: the SMS
 * seam's vendor-send-only fleet accounting, the
 * destination brake, and the per-class one-slot/unlink rules).
 *
 * This module is deliberately libsignal-free and holds NO keyed-hash call
 * site of its own: every route here verifies no identity signature (route
 * placement — the one recovery leg that does, /v1/recovery/complete, lives
 * in recovery-signed.ts on the auth Lambda), and every identifier hash
 * reaches through opaque-ref.ts, the ONE module permitted to compute the
 * derived-subkey construction (a test grep over this directory pins
 * exactly that).
 *
 * Refusal discipline, and one widening of it stated up front: refusal uniformity binds
 * every route here — identical bytes/status for every identifier the caller
 * has no consented right to resolve — so refusals keyed to the IDENTIFIER
 * (the per-address send budget, the resend cool-down, a suppressed address,
 * a recovery request for an address that resolves to nothing) answer the
 * SAME bytes as success or the same collapsed refusal as everything else,
 * never a distinguishable 429. Only budgets keyed to the CALLER'S OWN
 * account may 429 (the devices.ts named non-member), and the bare 401 stays
 * the middleware's.
 *
 * Rule 5 binds every log line: the identifier plaintext appears in NO log
 * event, NO error, and NO rate-limit key — the HMAC ref is the only
 * identifier-shaped value in reach, and even ULIDs ride as opaque refs. The
 * canary suite drives the error paths and greps the captured sink.
 */

/** The active K_id set, newest first — or undefined, which every route
 * treats as the collapsed refusal (fail closed; never a raw fallback).
 * Exported for the discovery module and the username lane — the
 * SAME set, the same order, so the identifier-resolving surfaces cannot
 * drift.
 *
 * ASYNC since the first-tap fix: in AWS the set rides a live getter over a
 * per-container cache whose FIRST read starts the Secrets Manager fetch and
 * answers "in flight" (aws/deps.ts). Refusing on that answer made the first
 * identifier-lane request every fresh container served the frozen 403 and
 * its retry, seconds later on the same container, a 200 — the reported
 * "first Claim fails, second succeeds". So an in-flight fetch is awaited
 * here and the getter re-read: at most twice, once per configured secret
 * (the primary and a retiring pair ride separate fetches). A fetch that
 * FAILS, or an unprovisioned key, stays the collapsed refusal — the lane
 * waits for a value, never invents one.
 *
 * TIMING, for the record: every route calls this AFTER its
 * `idroute` take has been charged and BEFORE the body is parsed, so on a
 * cold container the first request spends its budget unit and then holds
 * the invocation for the Secrets Manager round-trip. The wait sits inside
 * the already-charged unit, is per-CONTAINER (the cache is shared by every
 * caller the container serves), and changes no bytes — the refusal shapes
 * are identical either way — so the cold-start latency is not a per-user
 * signal and must not be read as one. */
export async function hmacKeys(deps: Deps): Promise<readonly IdentifierHmacKey[] | undefined> {
  for (let waited = 0; ; waited++) {
    const state = deps.identifierHmac;
    if (state === undefined) return undefined;
    if ('keys' in state) {
      if (state.keys.length === 0) return undefined;
      return [...state.keys].sort((a, b) => b.version - a.version);
    }
    if (waited === 2) return undefined;
    try {
      if ((await awaitBounded(state.pending, IDENTIFIER_KEY_WAIT_MS)) === 'timed_out') {
        return undefined;
      }
    } catch {
      return undefined;
    }
  }
}

/** How long the identifier lane waits on an in-flight K_id fetch before
 * answering the collapsed refusal. Above the Secrets Manager clients' own
 * pinned round-trip bound (aws/deps.ts SECRETS_MANAGER_REQUEST_TIMEOUTS: 1 s
 * connect + 2 s request) so a live fetch is never abandoned early, and far
 * below every function's Lambda timeout so a HUNG fetch costs the caller one
 * refusal, not a 5xx after the whole invocation. The fetch itself is not
 * cancelled: it keeps going and lands in the container cache for the next
 * request. */
export const IDENTIFIER_KEY_WAIT_MS = 3_000;

/** Race a pending fetch against the wait bound. The timer is always cleared
 * (a live fetch must not leave a stray timer holding the event loop), and a
 * rejected fetch propagates to the caller's catch exactly as before. */
async function awaitBounded(
  pending: Promise<void>,
  ms: number,
): Promise<'settled' | 'timed_out'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<'timed_out'>((resolve) => {
    timer = setTimeout(() => resolve('timed_out'), ms);
  });
  try {
    return await Promise.race([pending.then(() => 'settled' as const), bound]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** A row that may hold or prove identifiers: exists, live, human-class.
 * Exported for the discovery module (its caller gate starts here). */
export function identifierEligible(user: UserRecord | undefined): user is UserRecord {
  return user !== undefined && user.tombstoned !== true && user.accountClass !== 'integration';
}

/** Constant-time equality for the ONE server-held secret this module compares
 * against caller bytes — the verification code (and the derived claim key it
 * was minted for) — so a `!==` short-circuit cannot become a per-character
 * timing side channel (every other keyed-secret compare on the
 * auth path already runs constant-time). A length mismatch is an immediate
 * non-match — codes and claim keys are fixed-shape, so length is not secret. */
function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Resolve an identifier to its claim row across every active key version —
 * the rotation walk: ≤2 strongly consistent GetItems, zero Queries.
 * Class-general: the caller hands the class's OWN candidate keys
 * (`activeEmailClaimKeys` / `activePhoneClaimKeys`). */
async function resolveClaim(
  deps: Deps,
  candidates: readonly string[],
): Promise<IdentifierClaimRecord | undefined> {
  for (const claimKey of candidates) {
    const claim = await deps.db.getIdentifierClaim(claimKey);
    if (claim) return claim;
  }
  return undefined;
}

/** The claim-row prefixes a per-class filter may name (the username class
 * joined — its skeleton twin `nameskel#` never rides a ref list). */
export type IdentifierClassPrefix =
  | typeof EMAIL_CLAIM_KEY_PREFIX
  | typeof PHONE_CLAIM_KEY_PREFIX
  | typeof USERNAME_CLAIM_KEY_PREFIX;

/** The refs of ONE identifier class, prefix-filtered from a group's
 * `identifierRefs` snapshot (all active versions) — the per-class rule
 * every slot check, unlink, and consent toggle routes through. */
export function classRefs(
  identifierRefs: readonly string[],
  classPrefix: IdentifierClassPrefix,
): string[] {
  return identifierRefs.filter((ref) => ref.startsWith(classPrefix));
}

/**
 * The shared code-send leg behind BOTH request-code routes: budgets, the
 * suppression check, the mint, the row, the SES send — everything keyed by
 * the HMAC ref, and every identifier-keyed refusal collapsed into the ONE
 * uniform success answer `json(200, {})` so a remote caller learns nothing
 * about the address from the shape of the reply. `sendable` is the
 * one branch the caller decides (a recovery MISS mints and sends nothing);
 * the identifier-keyed budgets are charged before anything else, one take
 * per branch of the same size, so the miss and the hit spend identically —
 * on separate windows (below). */
async function sendCodeLeg(
  deps: Deps,
  auth: AuthContext,
  input: {
    normalized: string;
    keys: readonly IdentifierHmacKey[];
    purpose: 'attach' | 'recovery';
    deviceClass: DeviceClass;
    /** Absent = the recovery MISS: charge, answer uniformly, send nothing. */
    row?: { claimKey: string; targetGroupId?: string };
  },
): Promise<ReturnType<typeof json>> {
  const uniform = json(200, {});
  const newest = input.keys[0]!;
  const hash = identifierClaimHash(newest.key, input.normalized);
  // Budgets, identifier-keyed ones first and ALL of them charged before any
  // branch diverges (the miss must spend what the hit
  // spends): resend cool-down, per-address daily sends, fleet ceiling. Each
  // keys on the HMAC, never the plaintext, and each refusal is the SAME
  // uniform answer — a distinguishable refusal would disclose send traffic
  // against an address the caller may only be probing.
  if ((await deps.rateLimit.take(`emailresend:${hash}`, LIMITS.identifierResend)) > 0) {
    return uniform;
  }
  // THE PER-ADDRESS DAILY WINDOW, SPLIT BY BRANCH. A MISS spends
  // `emailmiss:<hash>`, a send `emailsend:<hash>` — the same Appendix A size
  // (5/day), the same HMAC key, the same uniform answer, one write at the
  // same position either way, so the anti-probing bound and rule 2's
  // byte/cost uniformity are exactly what they were. What changed: five
  // strangers' recovery requests naming an address that NOBODY has attached
  // yet used to spend the address's whole send window, locking its owner out
  // of attaching it until the UTC day rolled — a free, repeatable denial
  // handed to anyone who knew the address. Sends to a CLAIMED address (the
  // paid drain, real mail in the owner's inbox) stay bounded at 5/day and
  // alarmed through the fleet counter; no reservation can tell the owner's
  // recovery from a stranger's, and none is attempted.
  if (input.row === undefined) {
    // The miss window's own refusal is unobservable by design (the answer
    // is uniform whatever it says); the take exists so the miss costs what
    // the hit costs at this point of the leg.
    await deps.rateLimit.take(`emailmiss:${hash}`, LIMITS.identifierSendRecipient);
    // The MISS returns BEFORE the fleet take (the R-P7e rule the phone twin
    // already followed, "a miss costs us nothing and must not be a zero-spend
    // fleet-DoS lever"): a hundred pristine accounts × ten misses a day could
    // otherwise spend the whole 1 000/day email lane without one SES call.
    // The timing consequence stays inside the recorded §12 row 27(a) regime,
    // exactly as it does for phone.
    return uniform;
  }
  if ((await deps.rateLimit.take(`emailsend:${hash}`, LIMITS.identifierSendRecipient)) > 0) {
    return uniform;
  }
  if ((await deps.rateLimit.take('emailsend-fleet', LIMITS.identifierSendFleet)) > 0) {
    // The fleet ceiling's alarm half is the scrape-alarm's job (infra reads
    // the counter event below); the caller still sees the uniform answer.
    deps.log('identifier_send_fleet_refused');
    return uniform;
  }
  // The suppression shadow: keyed by the HMAC ref, never the address.
  // A suppressed ref answers uniformly and sends nothing. The read applies
  // the shadow's explicit expiry and reaps an elapsed row — SES
  // account-level suppression stays the durable authority behind it.
  // EVERY active key version is walked (the
  // getIdentifierRecoveryCooldown discipline): the shadow key embeds the K_id
  // version, so a newest-only read made every rotated-window row both
  // ineffective (a suppressed address got SES sends again mid-rotation) and
  // UNREACHABLE — no read would ever visit it to reap it, the exact
  // unreaped-forever class forbids. ≤2 strongly consistent GetItems
  // (two active versions at most), each reaping its own elapsed row; the
  // write below stays newest-version. Retiring a version before its
  // shadows' 90-day clock elapses would still orphan them — the recorded
  // operational bound: a retiring K_id
  // stays in the active set at least EMAIL_SUPPRESSION_TTL_SECONDS.
  const nowMs = deps.now();
  const suppKey = emailSuppressionKey(newest.version, hash);
  for (const k of input.keys) {
    const versionKey = emailSuppressionKey(k.version, identifierClaimHash(k.key, input.normalized));
    if (await deps.db.isIdentifierSuppressed(versionKey, Math.floor(nowMs / 1000))) return uniform;
  }
  const code = deps.newEmailCode();
  await deps.db.putEmailCode({
    userId: auth.userId,
    purpose: input.purpose,
    claimKey: input.row.claimKey,
    ...(input.row.targetGroupId !== undefined
      ? { targetGroupId: input.row.targetGroupId }
      : {}),
    deviceClass: input.deviceClass,
    code,
    attempts: 0,
    createdAt: nowMs,
    expiresAt: Math.floor(nowMs / 1000) + EMAIL_CODE_TTL_SECONDS,
  });
  const outcome = await deps.email!.sendCode({
    address: input.normalized,
    code,
    ref: hash,
    purpose: input.purpose,
  });
  if (outcome === 'suppressed') {
    // SES refused the address as suppressed: record OUR shadow so the next
    // send skips the provider call entirely — keyed by the ref, never the
    // address.
    await deps.db.putIdentifierSuppression(suppKey, nowMs);
  }
  // Field-free beyond the opaque caller ref, deliberately:
  // no address, no hash-of-address in the retained log — the counter event
  // is what the fleet alarm's metric filter counts.
  if (outcome === 'sent') {
    deps.log('identifier_code_sent', { userRef: userRefForLog(auth.userId, deps.userRefSalt) });
  } else {
    deps.log('identifier_code_send_failed');
  }
  return uniform;
}

/**
 * The SMS twin of `sendCodeLeg` — the same shape with the
 * class's divergences named where they happen rather than parameterized
 * away:
 *
 * 1. THE DESTINATION BRAKE runs before ANYTHING vendor-shaped: an
 * off-allowlist number answers the uniform bytes and never touches the
 * seam, the fleet windows, or a code row (a send that cannot happen must
 * not spend the fleet). The per-number budgets ARE charged first —
 * identifier-keyed budgets spend uniformly for every refusal class.
 * 2. THE FLEET BUCKETS CHARGE ON VENDOR SENDS ONLY (the named,
 * deliberate divergence from the email twin's pre-branch accounting),
 * with ONE bounded exception stated at the takes below:
 * the recovery MISS returns before the fleet takes, so a run of misses
 * can never exhaust the 200/day SMS lane at zero vendor spend. The
 * timing consequence stays inside the RECORDED regime —
 * the miss already returns before the hit's suppression read + code Put
 * + vendor send (bytes and status uniform; latency the recorded known
 * residual), and one more hit-only take does not widen that class.
 * Recorded honestly beside it (the two named residuals):
 * (a) with the fleet untouched on misses, MISS VOLUME has no fleet-wide
 * brake — what bounds a distributed miss-probe of the NANP keyspace is
 * caller-keyed only (10/min route, 10/day caller ceiling, one pristine
 * account per 10 probes/day) plus the per-number 3/day, and the
 * hit-vs-miss latency delta (a full vendor round-trip) has no pad —
 * both recorded as the regime EXTENDED to the phone
 * class, cheaper for an attacker than the consent-gated discovery
 * route but still target-consentless-resolution-free (a hit discloses
 * nothing to the caller beyond timing; the SMS lands on the OWNER's
 * phone); (b) the PAID drain survives by design:
 * attach-path request-codes always send, so ~20 pristine accounts × 10
 * numbers can exhaust the 200/day lane at real vendor spend
 * (~US$1.50-10/day) — alarmed (`sms_send_fleet_refused`), killed by
 * one flag delete, and bounded by the US$25 monthly wall.
 * 3. The suppression shadow is `phonesupp#` and is written ONLY from the
 * vendor's SYNCHRONOUS refusal (no DLR/event pipe).
 */
async function sendPhoneCodeLeg(
  deps: Deps,
  auth: AuthContext,
  input: {
    normalized: string;
    keys: readonly IdentifierHmacKey[];
    purpose: 'attach' | 'recovery';
    deviceClass: DeviceClass;
    /** Absent = the recovery MISS: charge the identifier-keyed budgets,
     * answer uniformly, send nothing — and leave the FLEET untouched. */
    row?: { claimKey: string; targetGroupId?: string };
  },
): Promise<ReturnType<typeof json>> {
  const uniform = json(200, {});
  const newest = input.keys[0]!;
  const hash = identifierClaimHash(newest.key, input.normalized);
  // Identifier-keyed budgets first, charged uniformly hit and miss (uniform refusals;
  // release pin: 60 s resend, 3/day per number) — HMAC keys, never plaintext.
  if ((await deps.rateLimit.take(`phoneresend:${hash}`, LIMITS.phoneResend)) > 0) {
    return uniform;
  }
  // THE PER-NUMBER DAILY WINDOW, SPLIT BY BRANCH (the email leg's rule,
  // same argument): a miss spends `phonemiss:<hash>`, a send
  // `phonesend:<hash>`, same size (3/day), same key, same uniform answer.
  // The MISS branch returns here: nothing to send, the
  // destination brake moot, the FLEET untouched.
  if (input.row === undefined) {
    await deps.rateLimit.take(`phonemiss:${hash}`, LIMITS.phoneSendRecipient);
    return uniform;
  }
  if ((await deps.rateLimit.take(`phonesend:${hash}`, LIMITS.phoneSendRecipient)) > 0) {
    return uniform;
  }
  // THE SERVER-SIDE BRAKE: destination-country default-DENY, the cheap
  // allowlist prefix check BEFORE the vendor seam is touched — refusal
  // through the same uniform identifier-keyed exit as everything else.
  // (Stated honestly: `+1` admits all NANP destinations — the vendor-side
  // Protect country rule is the sharp per-country edge; this is the brake.)
  if (!smsDestinationAllowed(input.normalized)) return uniform;
  // The suppression shadow (phonesupp#): keyed by the HMAC ref, never the
  // number; every active key version walked, elapsed rows reaped by the
  // read (the discipline the email walk pins).
  // THE K_id ROTATION BOUND, RESTATED FOR PHONE (the email
  // leg's recorded bound covered emailsupp# shadows only): a retiring K_id
  // must stay in the active set at least PHONE_SUPPRESSION_TTL_SECONDS for
  // these shadows. The stricter phone-only clause recorded here —
  // "phone claim rows have NO forward-migration site yet" — is now DISCHARGED
  // by the code that makes it false: discovery-by-phone's positive path now walks
  // `phonehash#` under the same ≤2-version window and calls
  // `migrateIdentifierClaimForward` class-blind, so phone claims migrate
  // exactly as email claims do and the surviving bound is the shadow TTL
  // one above (plus stated dormant-row invalidation cost, per class).
  const nowMs = deps.now();
  const suppKey = phoneSuppressionKey(newest.version, hash);
  for (const k of input.keys) {
    const versionKey = phoneSuppressionKey(k.version, identifierClaimHash(k.key, input.normalized));
    if (await deps.db.isIdentifierSuppressed(versionKey, Math.floor(nowMs / 1000))) return uniform;
  }
  // THE FLEET TAKES, on the send branch only: the 5/min burst
  // brake, then the 200/day ceiling. BOTH refusals emit the same field-free
  // `sms_send_fleet_refused` counter (the burst brake was
  // silent — the "caps the worst hour" control produced zero
  // telemetry, so a flood's refusals vanished until the daily ceiling also
  // exhausted; one counter, one metric filter, one alarm — "the SMS lane is
  // being drained" is the meaning either way). The "vendor sends only"
  // accounting carries ONE bounded, deliberate exception:
  // when the burst take succeeds and the daily ceiling then refuses, the
  // burst token was spent on a non-send — ≤5/min, self-healing in ≤12 s per
  // token, and the DAILY window stays untouched. The reverse order would be
  // worse, not better: taking the daily first hands >burst-rate traffic a
  // zero-vendor-spend burn of the whole 200/day window on burst refusals —
  // exactly the zero-spend exhaustion this accounting exists to close — and
  // the take-only limiter API has no atomic dual-take.
  if ((await deps.rateLimit.take('smssend-fleet-burst', LIMITS.phoneSendFleetBurst)) > 0) {
    deps.log('sms_send_fleet_refused');
    return uniform;
  }
  if ((await deps.rateLimit.take('smssend-fleet', LIMITS.phoneSendFleet)) > 0) {
    deps.log('sms_send_fleet_refused');
    return uniform;
  }
  const code = deps.newEmailCode();
  await deps.db.putEmailCode({
    userId: auth.userId,
    purpose: input.purpose,
    claimKey: input.row.claimKey,
    ...(input.row.targetGroupId !== undefined
      ? { targetGroupId: input.row.targetGroupId }
      : {}),
    deviceClass: input.deviceClass,
    code,
    attempts: 0,
    createdAt: nowMs,
    expiresAt: Math.floor(nowMs / 1000) + EMAIL_CODE_TTL_SECONDS,
  });
  const outcome = await deps.sms!.sendCode({
    number: input.normalized,
    code,
    ref: hash,
    purpose: input.purpose,
  });
  if (outcome === 'suppressed') {
    // The vendor's SYNCHRONOUS opted-out refusal: record OUR shadow so the
    // next send skips the vendor entirely — keyed by the ref, never the
    // number. The ONLY feedback v1 consumes (no DLR pipe, row 27(d)).
    await deps.db.putIdentifierSuppression(suppKey, nowMs);
  }
  // Field-free beyond the opaque caller ref: no number, no
  // hash-of-number in the retained log — this counter is what the 50%
  // fleet-send alarm's metric filter counts.
  if (outcome === 'sent') {
    deps.log('sms_code_sent', { userRef: userRefForLog(auth.userId, deps.userRefSalt) });
  } else {
    deps.log('sms_code_send_failed');
  }
  return uniform;
}

/**
 * POST /v1/identifiers/email/request-code: ask for an attach code. The
 * caller's own state may refuse distinguishably (its group already holds its
 * one email; its attach budget is spent) — that discloses nothing about any
 * identifier — but everything address-shaped answers uniformly.
 */
const emailRequestCodeHandler: AuthedHandler = async (event, deps, auth) => {
  const retry = await deps.rateLimit.take(`idroute:${auth.userId}`, LIMITS.identifierRoute);
  if (retry > 0) return rateLimitedResult(retry);
  const keys = await hmacKeys(deps);
  if (!keys || !deps.email) return accountsRefusal();
  const parsed = parseJson(event, EmailCodeRequest);
  if (!parsed.ok) return accountsRefusal();
  //the desktop slot cannot be occupied in v1 — not by attach either.
  if (parsed.data.class === 'desktop') return accountsRefusal();

  const caller = await deps.db.getUserById(auth.userId);
  if (!identifierEligible(caller)) return accountsRefusal();
  // The caller's own group state (no identifier involved): a grouped caller
  // must not declare a class (the roster knows it — the linkOfferInit rule),
  // and a group already holding its ONE email refuses here as UX (the
  // verify arm's class check + refs-snapshot CAS, with the transaction's
  // size() backstop, are the enforcement).
  let attachScope = auth.userId;
  if (caller.groupId !== undefined) {
    const group = await deps.db.getAccountGroup(caller.groupId);
    if (!group) return accountsRefusal();
    const own = group.members.find((m) => m.userId === auth.userId);
    if (!own || own.class !== parsed.data.class) return accountsRefusal();
    // PER-CLASS one-slot precheck: a group
    // already holding its ONE email refuses here as UX — a standing PHONE
    // ref no longer blocks an email attach (one of each may coexist). The
    // transaction's refs-snapshot condition is the enforcement.
    if (classRefs(group.identifierRefs, EMAIL_CLAIM_KEY_PREFIX).length >= MAX_VERIFIED_IDENTIFIERS_PER_CLASS) {
      return accountsRefusal();
    }
    attachScope = caller.groupId;
  }
  // The per-group attach budget (release pin: 10/day, ONE bucket ACROSS
  // identifier classes — the phone legs draw this same key) — caller-scoped,
  // so its refusal may 429 like every self-keyed budget.
  const attachRetry = await deps.rateLimit.take(
    `emailattach:${attachScope}`,
    LIMITS.identifierAttach,
  );
  if (attachRetry > 0) return rateLimitedResult(attachRetry);

  const normalized = normalizeEmailIdentifier(parsed.data.email);
  const newest = keys[0]!;
  return sendCodeLeg(deps, auth, {
    normalized,
    keys,
    purpose: 'attach',
    deviceClass: parsed.data.class,
    row: {
      claimKey: activeEmailClaimKeys([newest], normalized)[0]!,
    },
  });
};

/**
 * POST /v1/identifiers/email/verify: the attach. Every validation
 * attempt — right or wrong — spends one of the row's capped attempts
 * (release pin: 5), atomically; the attach itself is ONE TransactWrite whose
 * conditions (claim uniqueness, the one-email cap, the caller's
 * pristineness/membership, the code consume) are the authorization.
 */
const emailVerifyHandler: AuthedHandler = async (event, deps, auth) => {
  const retry = await deps.rateLimit.take(`idroute:${auth.userId}`, LIMITS.identifierRoute);
  if (retry > 0) return rateLimitedResult(retry);
  const keys = await hmacKeys(deps);
  if (!keys) return accountsRefusal();
  const parsed = parseJson(event, EmailVerifyRequest);
  if (!parsed.ok) return accountsRefusal();

  const caller = await deps.db.getUserById(auth.userId);
  if (!identifierEligible(caller)) return accountsRefusal();

  const nowSeconds = Math.floor(deps.now() / 1000);
  // ONE attempt consumed by the ask itself, right or wrong (the conditional
  // increment is the cap); absent, expired-but-unreaped, and cap-exhausted
  // all collapse — the row's clock decides, never the TTL reaper.
  const codeRow = await deps.db.takeEmailCodeAttempt(auth.userId, 'attach', nowSeconds);
  if (!codeRow || codeRow.purpose !== 'attach') return accountsRefusal();
  const normalized = normalizeEmailIdentifier(parsed.data.email);
  // Every active-version claim key, newest first: index 0 is what the attach
  // WRITES; the tail is condition-checked ABSENT in the same transaction
  // (claim uniqueness across the whole rotation window, so a
  // retiring-version claim held by another group refuses this attach).
  const candidates = activeEmailClaimKeys(keys, normalized);
  const claimKey = candidates[0]!;
  // The code must match AND must have been minted for THIS address — a code
  // for a different address proves nothing about this one. Both compares run
  // constant-time (the code is the guessed secret; the claim key binds it to
  // the address).
  if (!constantTimeEqual(codeRow.claimKey, claimKey) || !constantTimeEqual(codeRow.code, parsed.data.code)) {
    return accountsRefusal();
  }

  // The re-arm: a still-live recovery discovery cool-down carries
  // onto the fresh claim, so no unlink/re-attach loop sheds it. TWO
  // carriers, max wins: the caller's own group row (the original
  // landing), and the ADDRESS-keyed shadow the recovery completion writes —
  // the shadow is what closes the "leave the
  // group, attach into a new solo group / from a fresh account" bypass,
  // because it follows the address rather than the group or the device.
  // Elapsed (or never-armed) cool-downs carry nothing.
  let carriedCooldown: number | undefined;
  let refsSnapshot: readonly string[] | undefined;
  if (caller.groupId !== undefined) {
    const group = await deps.db.getAccountGroup(caller.groupId);
    if (!group) return accountsRefusal();
    // PER-CLASS one-slot precheck at the verify arm too ("refused at
    // both arms"): the class's slot already filled refuses here, and the
    // snapshot below makes the check atomic in the transaction.
    if (classRefs(group.identifierRefs, EMAIL_CLAIM_KEY_PREFIX).length >= MAX_VERIFIED_IDENTIFIERS_PER_CLASS) {
      return accountsRefusal();
    }
    refsSnapshot = group.identifierRefs;
    if (group.discoverableAfter !== undefined && group.discoverableAfter > nowSeconds) {
      carriedCooldown = group.discoverableAfter;
    }
  }
  const shadowCooldown = await deps.db.getIdentifierRecoveryCooldown(candidates, nowSeconds);
  if (shadowCooldown !== undefined && (carriedCooldown === undefined || shadowCooldown > carriedCooldown)) {
    carriedCooldown = shadowCooldown;
  }
  const result = await deps.db.attachIdentifier({
    userId: auth.userId,
    deviceClass: codeRow.deviceClass,
    ...(caller.groupId !== undefined ? { existingGroupId: caller.groupId } : {}),
    newGroupId: ulid(),
    claimKey,
    ...(refsSnapshot !== undefined ? { refsSnapshot } : {}),
    retiringClaimKeys: candidates.slice(1),
    nowMs: deps.now(),
    ...(carriedCooldown !== undefined ? { discoverableAfter: carriedCooldown } : {}),
  });
  // claim_exists, identifier_cap, stale, already_grouped, code_gone,
  // unknown_member: each is a fact the caller has no consented right to
  // distinguish (the first would answer "is this address linked to some
  // account").
  if (result !== 'attached') return accountsRefusal();
  deps.log('identifier_attached', { userRef: userRefForLog(auth.userId, deps.userRefSalt) });
  return json(200, {});
};

/**
 * POST /v1/identifiers/email/unlink: delete the group's claim row(s) +
 * their discovery consent (it lives ON the claim row) + the group row's
 * identifierRefs — capability-shrinking, bearer-authorized (no roster
 * mutation happens; signature rule is about rosters).
 */
const emailUnlinkHandler: AuthedHandler = async (_event, deps, auth) => {
  const retry = await deps.rateLimit.take(`idroute:${auth.userId}`, LIMITS.identifierRoute);
  if (retry > 0) return rateLimitedResult(retry);
  const caller = await deps.db.getUserById(auth.userId);
  if (!identifierEligible(caller) || caller.groupId === undefined) return accountsRefusal();
  const group = await deps.db.getAccountGroup(caller.groupId);
  if (!group) return accountsRefusal();
  // PER-CLASS unlink: only THIS route's class leaves —
  // the class-prefix filter over the refs snapshot, all active versions. A
  // standing phone claim, its consent, and its ref survive by construction
  // (the transaction subtracts exactly these keys under the unchanged
  // full-snapshot condition). No email claim to remove = the collapsed
  // refusal, exactly as the landed single-class case answered.
  const emailKeys = classRefs(group.identifierRefs, EMAIL_CLAIM_KEY_PREFIX);
  if (emailKeys.length === 0) return accountsRefusal();
  const result = await deps.db.unlinkIdentifierClass({
    userId: auth.userId,
    groupId: caller.groupId,
    refsSnapshot: group.identifierRefs,
    claimKeys: emailKeys,
  });
  if (result !== 'unlinked') return accountsRefusal();
  deps.log('identifier_unlinked', { userRef: userRefForLog(auth.userId, deps.userRefSalt) });
  return json(200, {});
};

// --- The phone attach family: the email routes' twins. The
// ROUTE is the identifier class (no discriminant field exists);
// `class` keeps its landed device-slot meaning; every leg rides
// `accountsPhoneRoute` (master AND phone flag, checked first) and the SMS
// send leg's brakes/accounting.

/** POST /v1/identifiers/phone/request-code — emailRequestCodeHandler's twin.
 * Same caller-state refusals (which may 429 — they disclose nothing about
 * any identifier), same uniform answer for everything number-shaped. */
const phoneRequestCodeHandler: AuthedHandler = async (event, deps, auth) => {
  const retry = await deps.rateLimit.take(`idroute:${auth.userId}`, LIMITS.identifierRoute);
  if (retry > 0) return rateLimitedResult(retry);
  const keys = await hmacKeys(deps);
  if (!keys || !deps.sms) return accountsRefusal();
  const parsed = parseJson(event, PhoneCodeRequest);
  if (!parsed.ok) return accountsRefusal();
  //the desktop slot cannot be occupied in v1 — not by attach either.
  if (parsed.data.class === 'desktop') return accountsRefusal();

  const caller = await deps.db.getUserById(auth.userId);
  if (!identifierEligible(caller)) return accountsRefusal();
  let attachScope = auth.userId;
  if (caller.groupId !== undefined) {
    const group = await deps.db.getAccountGroup(caller.groupId);
    if (!group) return accountsRefusal();
    const own = group.members.find((m) => m.userId === auth.userId);
    if (!own || own.class !== parsed.data.class) return accountsRefusal();
    // PER-CLASS one-slot precheck (release-pinned): ONE verified phone per
    // group — a standing EMAIL ref does not block (coexist); the
    // transaction's refs-snapshot condition is the enforcement.
    if (classRefs(group.identifierRefs, PHONE_CLAIM_KEY_PREFIX).length >= MAX_VERIFIED_IDENTIFIERS_PER_CLASS) {
      return accountsRefusal();
    }
    attachScope = caller.groupId;
  }
  // THE SHARED ATTACH BUDGET: the SAME `emailattach:`
  // bucket the email legs draw — ONE 10/day budget across identifier
  // classes, so a second class never doubles the probe budget. The key name
  // stays the landed spelling deliberately: renaming it would fork the live
  // window.
  const attachRetry = await deps.rateLimit.take(
    `emailattach:${attachScope}`,
    LIMITS.identifierAttach,
  );
  if (attachRetry > 0) return rateLimitedResult(attachRetry);

  const normalized = normalizePhoneIdentifier(parsed.data.phone);
  const newest = keys[0]!;
  return sendPhoneCodeLeg(deps, auth, {
    normalized,
    keys,
    purpose: 'attach',
    deviceClass: parsed.data.class,
    row: {
      claimKey: activePhoneClaimKeys([newest], normalized)[0]!,
    },
  });
};

/** POST /v1/identifiers/phone/verify — emailVerifyHandler's twin: same
 * attempt-cap consume, same constant-time compares, same ONE TransactWrite
 * whose conditions are the authorization (per-class snapshot from). */
const phoneVerifyHandler: AuthedHandler = async (event, deps, auth) => {
  const retry = await deps.rateLimit.take(`idroute:${auth.userId}`, LIMITS.identifierRoute);
  if (retry > 0) return rateLimitedResult(retry);
  const keys = await hmacKeys(deps);
  if (!keys) return accountsRefusal();
  const parsed = parseJson(event, PhoneVerifyRequest);
  if (!parsed.ok) return accountsRefusal();

  const caller = await deps.db.getUserById(auth.userId);
  if (!identifierEligible(caller)) return accountsRefusal();

  const nowSeconds = Math.floor(deps.now() / 1000);
  const codeRow = await deps.db.takeEmailCodeAttempt(auth.userId, 'attach', nowSeconds);
  if (!codeRow || codeRow.purpose !== 'attach') return accountsRefusal();
  const normalized = normalizePhoneIdentifier(parsed.data.phone);
  const candidates = activePhoneClaimKeys(keys, normalized);
  const claimKey = candidates[0]!;
  // The code must match AND must have been minted for THIS number — the
  // claim key binds it (and, prefix-disjoint by construction, an EMAIL
  // attach code can never satisfy a phone verify or vice versa).
  if (!constantTimeEqual(codeRow.claimKey, claimKey) || !constantTimeEqual(codeRow.code, parsed.data.code)) {
    return accountsRefusal();
  }

  // The re-arm, second class: group-row carrier + the
  // phonecool# number-keyed shadow, max wins — so the re-attach shed stays
  // closed for phone from day one.
  let carriedCooldown: number | undefined;
  let refsSnapshot: readonly string[] | undefined;
  if (caller.groupId !== undefined) {
    const group = await deps.db.getAccountGroup(caller.groupId);
    if (!group) return accountsRefusal();
    if (classRefs(group.identifierRefs, PHONE_CLAIM_KEY_PREFIX).length >= MAX_VERIFIED_IDENTIFIERS_PER_CLASS) {
      return accountsRefusal();
    }
    refsSnapshot = group.identifierRefs;
    if (group.discoverableAfter !== undefined && group.discoverableAfter > nowSeconds) {
      carriedCooldown = group.discoverableAfter;
    }
  }
  const shadowCooldown = await deps.db.getIdentifierRecoveryCooldown(candidates, nowSeconds);
  if (shadowCooldown !== undefined && (carriedCooldown === undefined || shadowCooldown > carriedCooldown)) {
    carriedCooldown = shadowCooldown;
  }
  const result = await deps.db.attachIdentifier({
    userId: auth.userId,
    deviceClass: codeRow.deviceClass,
    ...(caller.groupId !== undefined ? { existingGroupId: caller.groupId } : {}),
    newGroupId: ulid(),
    claimKey,
    ...(refsSnapshot !== undefined ? { refsSnapshot } : {}),
    retiringClaimKeys: candidates.slice(1),
    nowMs: deps.now(),
    ...(carriedCooldown !== undefined ? { discoverableAfter: carriedCooldown } : {}),
  });
  if (result !== 'attached') return accountsRefusal();
  deps.log('identifier_attached', { userRef: userRefForLog(auth.userId, deps.userRefSalt) });
  return json(200, {});
};

/** POST /v1/identifiers/phone/unlink — the per-class twin of the email
 * unlink: only the phone claims leave; a standing email claim,
 * its consent, and its ref survive by construction. */
const phoneUnlinkHandler: AuthedHandler = async (_event, deps, auth) => {
  const retry = await deps.rateLimit.take(`idroute:${auth.userId}`, LIMITS.identifierRoute);
  if (retry > 0) return rateLimitedResult(retry);
  const caller = await deps.db.getUserById(auth.userId);
  if (!identifierEligible(caller) || caller.groupId === undefined) return accountsRefusal();
  const group = await deps.db.getAccountGroup(caller.groupId);
  if (!group) return accountsRefusal();
  const phoneKeys = classRefs(group.identifierRefs, PHONE_CLAIM_KEY_PREFIX);
  if (phoneKeys.length === 0) return accountsRefusal();
  const result = await deps.db.unlinkIdentifierClass({
    userId: auth.userId,
    groupId: caller.groupId,
    refsSnapshot: group.identifierRefs,
    claimKeys: phoneKeys,
  });
  if (result !== 'unlinked') return accountsRefusal();
  deps.log('identifier_unlinked', { userRef: userRefForLog(auth.userId, deps.userRefSalt) });
  return json(200, {});
};

/**
 * POST /v1/recovery/request-code: the recovering device asks for a code
 * to the address it claims. THE RULE-2 ROUTE OF THIS MODULE: whether the
 * address resolves to a group is exactly what the caller has no right to
 * learn without the inbox, so the MISS and the HIT answer identical bytes,
 * charge identical budgets, and differ only in whether an email leaves SES
 * which only the inbox holder observes.
 */
const recoveryRequestCodeHandler: AuthedHandler = async (event, deps, auth) => {
  const retry = await deps.rateLimit.take(`idroute:${auth.userId}`, LIMITS.identifierRoute);
  if (retry > 0) return rateLimitedResult(retry);
  const keys = await hmacKeys(deps);
  if (!keys) return accountsRefusal();
  const parsed = parseJson(event, RecoveryCodeRequest);
  if (!parsed.ok) return accountsRefusal();
  // THE PARALLEL-FIELD WIRE: the identifier class
  // IS the populated field — the schema enforced exactly-one-of. The
  // phone-classed request additionally rides the phone kill switch (this
  // shared route stays master-flag-gated; the CLASS inside it is what
  // the sub-flag darkens) and the class's own delivery seam, failing closed
  // when either is absent.
  const phoneClassed = parsed.data.phone !== undefined;
  if (phoneClassed) {
    if (!(await deps.db.isAccountsPhoneFeatureEnabled())) return accountsRefusal();
    if (!deps.sms) return accountsRefusal();
  } else if (!deps.email) {
    return accountsRefusal();
  }
  const caller = await deps.db.getUserById(auth.userId);
  // Pristine only: a grouped or
  // lived-in device does not recover — it IS an account. Deliberately NO
  // caller identifier/age gate beyond this (the pristineness this leg REQUIRES
  // means a fresh install can never hold a verified identifier, and an age
  // gate would delay every legitimate reinstall-and-recover).
  if (!identifierEligible(caller) || caller.groupId !== undefined) return accountsRefusal();
  // THE PER-ACCOUNT DAILY SEND CEILING ("per-account AND fleet-wide"), the
  // half the recovery leg was missing: the fleet bucket alone
  // let one pristine account cycle addresses and drain the fleet ceiling.
  // Caller-keyed, so it may 429 like every self-keyed budget (the
  // identifier stays uniform — this bounds the CALLER), and it re-uses the
  // pinned 10/day attach budget — the ONE bucket across classes and verbs
  // (a phone-classed request draws the same window), rather than
  // minting a new pinned value. Charged before resolution, uniformly
  // for hit and miss.
  const dailyRetry = await deps.rateLimit.take(
    `emailattach:${auth.userId}`,
    LIMITS.identifierAttach,
  );
  if (dailyRetry > 0) return rateLimitedResult(dailyRetry);

  if (phoneClassed) {
    const normalized = normalizePhoneIdentifier(parsed.data.phone!);
    const claim = await resolveClaim(deps, activePhoneClaimKeys(keys, normalized));
    return sendPhoneCodeLeg(deps, auth, {
      normalized,
      keys,
      purpose: 'recovery',
      // The recovering device declares its class at VERIFY; the request leg
      // stores a placeholder the verify leg overwrites-by-replacing (one
      // row per requester). 'phone' here is never read.
      deviceClass: 'phone',
      // The MISS branch: no row, no send, the FLEET untouched —
      // bytes and identifier-keyed budgets identical to the hit.
      ...(claim !== undefined
        ? { row: { claimKey: claim.claimKey, targetGroupId: claim.groupId } }
        : {}),
    });
  }
  const normalized = normalizeEmailIdentifier(parsed.data.email!);
  const claim = await resolveClaim(deps, activeEmailClaimKeys(keys, normalized));
  return sendCodeLeg(deps, auth, {
    normalized,
    keys,
    purpose: 'recovery',
    // The recovering device declares its class at VERIFY; the request leg
    // stores a placeholder the verify leg overwrites-by-replacing (one row
    // per requester). 'phone' here is never read.
    deviceClass: 'phone',
    // The MISS branch: no row, no send — bytes and budgets identical.
    ...(claim !== undefined
      ? { row: { claimKey: claim.claimKey, targetGroupId: claim.groupId } }
      : {}),
  });
};

/**
 * POST /v1/recovery/verify: code proven — the pending row is born
 * (72 h delay as a stored, condition-checked fact) and EVERY member is
 * notified with the cancel capability. Success is only reachable with the
 * emailed code: inbox possession is the consented proof.
 */
const recoveryVerifyHandler: AuthedHandler = async (event, deps, auth) => {
  const retry = await deps.rateLimit.take(`idroute:${auth.userId}`, LIMITS.identifierRoute);
  if (retry > 0) return rateLimitedResult(retry);
  const keys = await hmacKeys(deps);
  if (!keys) return accountsRefusal();
  const parsed = parseJson(event, RecoveryVerifyRequest);
  if (!parsed.ok) return accountsRefusal();
  if (parsed.data.class === 'desktop') return accountsRefusal();
  // The parallel-field wire again: `class` above is the DEVICE
  // SLOT, untouched; the identifier class is the populated field, and a
  // phone-classed verify rides the phone kill switch.
  const phoneClassed = parsed.data.phone !== undefined;
  if (phoneClassed && !(await deps.db.isAccountsPhoneFeatureEnabled())) {
    return accountsRefusal();
  }
  const caller = await deps.db.getUserById(auth.userId);
  if (!identifierEligible(caller) || caller.groupId !== undefined) return accountsRefusal();

  const nowSeconds = Math.floor(deps.now() / 1000);
  const codeRow = await deps.db.takeEmailCodeAttempt(auth.userId, 'recovery', nowSeconds);
  if (!codeRow || codeRow.purpose !== 'recovery' || codeRow.targetGroupId === undefined) {
    return accountsRefusal();
  }
  const normalized = phoneClassed
    ? normalizePhoneIdentifier(parsed.data.phone!)
    : normalizeEmailIdentifier(parsed.data.email!);
  // The code row's claim key was recorded at REQUEST time from the resolving
  // version — recompute across every active version so a rotation between
  // the two legs cannot orphan the ceremony (the class's OWN prefix walk —
  // claim keys are prefix-disjoint, so a phone code can never prove an email
  // claim or vice versa). The code compare runs constant-time (the guessed
  // secret).
  const candidates = phoneClassed
    ? activePhoneClaimKeys(keys, normalized)
    : activeEmailClaimKeys(keys, normalized);
  if (!candidates.includes(codeRow.claimKey) || !constantTimeEqual(codeRow.code, parsed.data.code)) {
    return accountsRefusal();
  }
  // Re-resolve at verify time: an unlink or re-attach since the request must
  // not let a stale code recover a group the identifier no longer names.
  const claim = await deps.db.getIdentifierClaim(codeRow.claimKey);
  if (!claim || claim.groupId !== codeRow.targetGroupId) return accountsRefusal();

  const nowMs = deps.now();
  const completesAt = nowSeconds + RECOVERY_DELAY_SECONDS;
  const created = await deps.db.putRecoveryPending({
    groupId: claim.groupId,
    newUserId: auth.userId,
    deviceClass: parsed.data.class,
    claimKey: claim.claimKey,
    requestedAt: nowMs,
    // TTL horizon: well past completion, so a cancelled or abandoned row
    // reaps without a scheduler while the cancel stays readable meanwhile.
    completesAt,
    expiresAt: completesAt + RECOVERY_DISCOVERY_COOLDOWN_SECONDS,
  });
  if (created !== 'created') return accountsRefusal();
  await deps.db.deleteEmailCode(auth.userId, 'recovery');

  //EVERY member device is notified and can cancel — the cancel WINS.
  const group = await deps.db.getAccountGroup(claim.groupId);
  if (group) {
    const notice: AccountsNotice = {
      kind: 'recoveryRequested',
      groupId: claim.groupId,
      class: parsed.data.class,
      completesAt,
    };
    for (const member of group.members) {
      await deliverAccountsNotice(deps, member.userId, auth.userId, notice);
    }
  }
  deps.log('recovery_requested', { userRef: userRefForLog(auth.userId, deps.userRefSalt) });
  const body: RecoveryVerifyResponse = { groupId: claim.groupId, completesAt };
  return json(200, body);
};

/**
 * POST /v1/recovery/cancel: any surviving member kills the pending
 * recovery — bearer-authorized deliberately: cancel is the REFUSAL verb, its
 * failure direction is safety, and demanding a signature would let a thief
 * with the phone but not the passcode outrun the owner's tablet.
 */
const recoveryCancelHandler: AuthedHandler = async (_event, deps, auth) => {
  const retry = await deps.rateLimit.take(`idroute:${auth.userId}`, LIMITS.identifierRoute);
  if (retry > 0) return rateLimitedResult(retry);
  const caller = await deps.db.getUserById(auth.userId);
  if (!identifierEligible(caller) || caller.groupId === undefined) return accountsRefusal();
  const group = await deps.db.getAccountGroup(caller.groupId);
  if (!group || !group.members.some((m) => m.userId === auth.userId)) return accountsRefusal();
  const result = await deps.db.cancelRecoveryPending(
    caller.groupId,
    Math.floor(deps.now() / 1000),
  );
  if (result !== 'canceled') return accountsRefusal();
  const notice: AccountsNotice = { kind: 'recoveryCancelled', groupId: caller.groupId };
  for (const member of group.members) {
    if (member.userId === auth.userId) continue;
    await deliverAccountsNotice(deps, member.userId, auth.userId, notice);
  }
  deps.log('recovery_cancelled', { userRef: userRefForLog(auth.userId, deps.userRefSalt) });
  return json(200, {});
};

// The wrapped routes (flag FIRST, then bearer auth — devices.ts): what the
// local adapter and the ordinary HTTP Lambda host mount — libsignal-free.
// The phone attach family rides accountsPhoneRoute (master AND phone flag); the shared recovery legs stay master-flag routes whose
// PHONE-classed requests the handlers darken (the sub-flag reads above) —
// and the cancel leg stays master-flag-only ON PURPOSE: a surviving
// member's safety-critical cancel of a phone recovery lands even with the
// phone train dark.
export const emailRequestCodeRoute: Handler = accountsRoute(emailRequestCodeHandler);
export const emailVerifyRoute: Handler = accountsRoute(emailVerifyHandler);
export const emailUnlinkRoute: Handler = accountsRoute(emailUnlinkHandler);
export const phoneRequestCodeRoute: Handler = accountsPhoneRoute(phoneRequestCodeHandler);
export const phoneVerifyRoute: Handler = accountsPhoneRoute(phoneVerifyHandler);
export const phoneUnlinkRoute: Handler = accountsPhoneRoute(phoneUnlinkHandler);
export const recoveryRequestCodeRoute: Handler = accountsRoute(recoveryRequestCodeHandler);
export const recoveryVerifyRoute: Handler = accountsRoute(recoveryVerifyHandler);
export const recoveryCancelRoute: Handler = accountsRoute(recoveryCancelHandler);
