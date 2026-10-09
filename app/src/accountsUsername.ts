import * as apiModule from './api';
import { ApiRequestError, ServerAheadError, type IdentifierStateRead } from './api';
import * as dbModule from './db';
import { currentToken } from './reauth';
import { accountRequestGeneration } from './accountLifecycle';
import { session } from './session';
import { pickDiscoveryAnchor, type DiscoveryOutcome, type SimpleOutcome } from './accounts';
import {
  RESERVED_USERNAMES,
  RESERVED_USERNAME_SKELETONS,
  USERNAME_RENAME_COOLDOWN_SECONDS,
  USERNAME_STRICT,
  USERNAME_TAKEN_STATUS,
  hasReservedUsernameAffix,
  normalizeUsernameIdentifier,
  usernameSkeleton,
  type DiscoveryLookupResponse,
  type UsernameEligibilityResponse,
} from '@tacendum/shared';

/**
 * Username claim / rename / unlink + per-class consent + find-by-name,
 * client state machine (accountsPhone.ts's
 * module sibling, exactly the accounts.ts discipline: deps-injected,
 * refusal-first, the local database the ONLY readable home of the name
 * because the server stores a keyed hash and never echoes it). Every
 * surface that calls this module renders ONLY under the build-pinned
 * `USERNAME_UI_ENABLED` (usernameUi.ts): the module ships dark.
 *
 * THE OUTCOME MAP OF THIS CLASS, stated once:
 * the claim verb — and only it — answers ONE distinguishable identifier-
 * keyed result, the frozen 409 `taken`, and this module surfaces it as
 * 'taken' by STATUS ALONE. Every other server refusal — the frozen 403,
 * fleet ceiling and caller budget included — is 'refused', rendered as a
 * generic "try again later" that never says why (a second distinguishable
 * shape would let a scraper pace its probes). A transport failure is
 * 'failed'. And 'invalid' is this device's OWN knowledge, before any wire
 * call: the strict shape (refused-never-repaired) and the PUBLIC
 * denylist (exact AND skeleton-vs-skeleton, the server's own check
 * mirrored so a reserved name never spends a claim attempt).
 *
 * Duress: every wire call below reaches the api.ts chokepoint, which throws
 * a transport-shaped error in a duress session (network-silent) —
 * so every verb here answers 'failed' there, indistinguishable from
 * offline, and nothing is written; the rows themselves live in the
 * workspace-scoped store (the decoy file in duress) by construction.
 */

/* ── deps ─────────────────────────────────────────────────────────── */

export interface AccountsUsernameDeps {
  api: {
    usernameClaim(token: string, username: string, discoverable: boolean): Promise<void>;
    usernameRename(token: string, username: string, discoverable: boolean): Promise<void>;
    usernameUnlink(token: string): Promise<void>;
    setUsernameDiscoverable(token: string, on: boolean): Promise<void>;
    discoveryLookupUsername(token: string, username: string): Promise<DiscoveryLookupResponse>;
  };
  db: Pick<
    typeof dbModule,
    | 'loadUsernameIdentifier'
    | 'saveUsernameIdentifier'
    | 'clearUsernameIdentifier'
    | 'saveUsernameUnlink'
    | 'clearUsernameUnlink'
    | 'loadUsernameCooldown'
    | 'saveUsernameCooldown'
    | 'clearUsernameCooldown'
  >;
  token(): Promise<string | null>;
  now(): number;
}

function defaultDeps(): AccountsUsernameDeps {
  return {
    api: {
      usernameClaim: apiModule.apiClaimUsername,
      usernameRename: apiModule.apiRenameUsername,
      usernameUnlink: apiModule.apiUnlinkUsername,
      setUsernameDiscoverable: apiModule.apiSetUsernameDiscoverable,
      discoveryLookupUsername: apiModule.apiDiscoveryLookupUsername,
    },
    db: dbModule,
    token: currentToken,
    now: Date.now,
  };
}

export interface UsernameEligibilityDeps {
  api: {
    usernameEligibility(token: string): Promise<UsernameEligibilityResponse>;
  };
  token(): Promise<string | null>;
}

function defaultEligibilityDeps(): UsernameEligibilityDeps {
  return {
    api: { usernameEligibility: apiModule.apiUsernameEligibility },
    token: currentToken,
  };
}

/**
 * Read the authenticated caller's authoritative group-level possession
 * proof before a claim, rename, or username lookup. A linked sibling's
 * verified email or phone qualifies, so local identifier rows cannot answer
 * this question. Refusals and transport failures stay indistinguishable to
 * the UI and become a retryable availability state.
 */
export type UsernameEligibilityOutcome = 'eligible' | 'needs_verification' | 'unavailable';
export async function getUsernameEligibility(
  deps: UsernameEligibilityDeps = defaultEligibilityDeps(),
): Promise<UsernameEligibilityOutcome> {
  try {
    const token = await deps.token();
    if (!token) return 'unavailable';
    const response = await deps.api.usernameEligibility(token);
    return response.hasVerifiedIdentifier ? 'eligible' : 'needs_verification';
  } catch {
    return 'unavailable';
  }
}

/* ── the caller-owned state read (fix/username-discovery, 2026-10-08) ── */

/**
 * The ONE read an identifier surface asks before it renders: the facts about
 * the caller's OWN account group that a linked sibling, a reinstalled phone
 * or a recovered account cannot learn from its local rows — the server never
 * echoes a name (§4.9) and the rows do not sync between siblings. Two
 * sources, named on the answer:
 *
 *  - 'state': GET /v1/identifiers/state. `holdsUsername`, `emailLinked` and
 *    `phoneLinked` are the group's class refs as FACTS (false is a fact, not
 *    an unknown); `cooldownUntil` is the §4.8 window's end.
 *  - 'legacy': the eligibility read, when the state route answers 404 —
 *    TODAY'S production server (fef7a0dc) has no such route, and this build
 *    must keep working against it until the new server deploys. The three
 *    sibling facts are then null (= UNKNOWN), and a surface on this path
 *    says so instead of guessing. A server AHEAD of this build on the new
 *    route (its strict parse threw) degrades the same way: the eligibility
 *    shape is the one every shipped build still parses.
 *
 * `eligibility` keeps refusals and failures DISTINGUISHABLE (U3): the frozen
 * 403 is 'refused' — the caller's identifier-route budget or a dark flag,
 * never a connection problem — and a transport failure is 'failed'.
 *
 * UNITS: `cooldownUntil`, `usernameSince` and `emailSince` are MILLISECONDS
 * on this module's Date.now() scale (every row and every `now()` here is
 * ms); the wire carries them in UNIX EPOCH SECONDS (the rows' own unit) and
 * each is converted exactly once, here.
 *
 * THE THREE FACTS OF THE GATE PASS (2026-10-08): `usernameSince` and
 * `emailSince` are the moments the account's LIVE rows of those classes
 * were written — what tells this device its own row is a PHANTOM when a
 * sibling renamed the name or replaced the address (`holdsUsername` and
 * `emailLinked` stay true either way; see `localRowStale`). And
 * `usernameFindable` is the held name's consent bit as the server holds
 * it, so a sibling's rename form starts at the current value instead of a
 * default that would flip an unfindable name findable. Null = no row of
 * that class, or unknown (legacy, refused, failed).
 */
export type IdentifierStateSource = 'state' | 'legacy';
export type IdentifierStateEligibility =
  | 'eligible'
  | 'needs_verification'
  | 'refused'
  | 'failed';
export interface IdentifierState {
  source: IdentifierStateSource;
  eligibility: IdentifierStateEligibility;
  /** null = unknown (the legacy path, a refusal, a failure); false is a FACT. */
  holdsUsername: boolean | null;
  emailLinked: boolean | null;
  phoneLinked: boolean | null;
  /** The §4.8 cool-down's end, ms (Date.now() scale); null = none running or unknown. */
  cooldownUntil: number | null;
  /** When the account's live username row was written, ms; null = none or unknown. */
  usernameSince: number | null;
  /** When the account's live email row was written, ms; null = none or unknown. */
  emailSince: number | null;
  /** The held name's consent bit as the server holds it; null = none or unknown. */
  usernameFindable: boolean | null;
  /** The linked email's consent bit as the server holds it (the proof pass,
   * 2026-10-08: a sibling shows and moves findability by email from it);
   * null = no email, or unknown. */
  emailFindable: boolean | null;
}

export interface IdentifierStateDeps {
  api: {
    identifierState(token: string): Promise<IdentifierStateRead>;
    usernameEligibility(token: string): Promise<UsernameEligibilityResponse>;
  };
  token(): Promise<string | null>;
  now(): number;
}

function defaultIdentifierStateDeps(): IdentifierStateDeps {
  return {
    api: {
      identifierState: apiModule.apiIdentifierState,
      usernameEligibility: apiModule.apiUsernameEligibility,
    },
    token: currentToken,
    now: Date.now,
  };
}

/** How long a landed answer serves from memory: a FEW SECONDS, enough to
 * fold one screen's own back-to-back reads (a mount's read and the re-read
 * a verb's `finally` fires) into one wire call — never a minute (the gate
 * pass, 2026-10-08: a minute-long app-wide memory replayed the reported
 * symptoms — the claim form, the attach form, the false "verify an
 * email first" door — for up to 60 s after a sibling changed the account,
 * after this device completed a link, or after a revocation landed). The
 * state route has its own 30/min bucket, so a read per screen mount is
 * cheap; Open a room keeps its own per-visit answer; single-flight below
 * still folds concurrent reads. Refusals and failures are never kept —
 * Retry must reach the wire. */
export const IDENTIFIER_STATE_CACHE_MS = 2_000;

const UNKNOWN_FACTS = {
  holdsUsername: null,
  emailLinked: null,
  phoneLinked: null,
  cooldownUntil: null,
  usernameSince: null,
  emailSince: null,
  usernameFindable: null,
  emailFindable: null,
} as const;

/** The memory, keyed by WHOSE answer it is: the account request generation
 * (a new identity after a deletion never reads the old account's facts —
 * the generation only grows, so older generations are dropped on write) and
 * the session mode (a duress session never reads the real session's answer;
 * its own reads die at the api chokepoint and are never kept). */
const identifierStateCache = new Map<string, { state: IdentifierState; expiresAt: number }>();
let identifierStateInflight: { key: string; promise: Promise<IdentifierState> } | null = null;
/** Bumped by every invalidation: a read that was out when a claim, rename,
 * unlink, consent, attach or remove landed must not store its stale answer. */
let identifierStateEpoch = 0;

function identifierStateKey(): string {
  return `${accountRequestGeneration()}:${session.mode}`;
}

/** Called after EVERY verb that changes the facts — claim, rename, unlink,
 * consent, attach, remove — so the next read goes to the wire. */
export function invalidateIdentifierState(): void {
  identifierStateCache.clear();
  identifierStateInflight = null;
  identifierStateEpoch += 1;
}

export async function getIdentifierState(
  deps: IdentifierStateDeps = defaultIdentifierStateDeps(),
): Promise<IdentifierState> {
  const key = identifierStateKey();
  const hit = identifierStateCache.get(key);
  if (hit && hit.expiresAt > deps.now()) return hit.state;
  if (identifierStateInflight && identifierStateInflight.key === key) {
    return identifierStateInflight.promise;
  }
  const epoch = identifierStateEpoch;
  const promise = readIdentifierState(deps).then(
    state => {
      if (identifierStateInflight?.promise === promise) identifierStateInflight = null;
      const landed = state.eligibility === 'eligible' || state.eligibility === 'needs_verification';
      if (landed && epoch === identifierStateEpoch) {
        const generation = `${accountRequestGeneration()}:`;
        for (const stale of identifierStateCache.keys()) {
          if (!stale.startsWith(generation)) identifierStateCache.delete(stale);
        }
        identifierStateCache.set(key, { state, expiresAt: deps.now() + IDENTIFIER_STATE_CACHE_MS });
      }
      return state;
    },
    (error: unknown) => {
      if (identifierStateInflight?.promise === promise) identifierStateInflight = null;
      throw error;
    },
  );
  identifierStateInflight = { key, promise };
  return promise;
}

async function readIdentifierState(deps: IdentifierStateDeps): Promise<IdentifierState> {
  const token = await deps.token();
  if (!token) return { source: 'state', eligibility: 'failed', ...UNKNOWN_FACTS };
  let read: IdentifierStateRead;
  try {
    read = await deps.api.identifierState(token);
  } catch (error) {
    if (!(error instanceof ServerAheadError)) {
      return { source: 'state', eligibility: 'failed', ...UNKNOWN_FACTS };
    }
    read = { kind: 'absent' };
  }
  switch (read.kind) {
    case 'state': {
      const { value } = read;
      return {
        source: 'state',
        eligibility: value.hasVerifiedIdentifier ? 'eligible' : 'needs_verification',
        holdsUsername: value.holdsUsername,
        emailLinked: value.emailLinked,
        phoneLinked: value.phoneLinked,
        // Wire seconds → this module's milliseconds, the one conversion.
        cooldownUntil:
          value.usernameCooldownUntil === null ? null : value.usernameCooldownUntil * 1000,
        usernameSince: value.usernameSince === null ? null : value.usernameSince * 1000,
        emailSince: value.emailSince === null ? null : value.emailSince * 1000,
        usernameFindable: value.usernameFindable,
        emailFindable: value.emailFindable,
      };
    }
    case 'refused':
      return { source: 'state', eligibility: 'refused', ...UNKNOWN_FACTS };
    case 'failed':
      return { source: 'state', eligibility: 'failed', ...UNKNOWN_FACTS };
    case 'absent':
      break;
  }
  try {
    // The legacy read draws the caller's shared identifier-route bucket
    // (the state read has its own): counted, so the screen can pace.
    noteIdentifierRouteCall(deps.now());
    const response = await deps.api.usernameEligibility(token);
    return {
      source: 'legacy',
      eligibility: response.hasVerifiedIdentifier ? 'eligible' : 'needs_verification',
      ...UNKNOWN_FACTS,
    };
  } catch (error) {
    return {
      source: 'legacy',
      eligibility: isRefusal(error) ? 'refused' : 'failed',
      ...UNKNOWN_FACTS,
    };
  }
}

/** The accounts.ts rule verbatim: an http-level answer is a REFUSAL (the
 * collapsed 403 above all); everything else is a transport failure. */
function isRefusal(error: unknown): boolean {
  return error instanceof ApiRequestError;
}

/** THE one distinguishable answer: the frozen 409, by status alone —
 * never by body bytes, which the client does not read for this. */
function isTaken(error: unknown): boolean {
  return error instanceof ApiRequestError && error.status === USERNAME_TAKEN_STATUS;
}

/* ── local pre-checks (the design shape, the design public denylist) ──────────── */

export type UsernameLocalCheck = 'ok' | 'invalid' | 'reserved';

/** Normalize (trim + case-fold — the ONE normalization, byte-locked in the
 * shared package) and require the strict shape; null for anything the wire
 * would refuse. Refused, never repaired. */
export function normalizedUsernameOrNull(raw: string): string | null {
  const normalized = normalizeUsernameIdentifier(raw);
  return USERNAME_STRICT.test(normalized) ? normalized : null;
}

/** This device's own pre-check, before any wire call: the shape, then the
 * compiled-in denylist exact AND skeleton-vs-SKELETON (the reserved names
 * are skeletonized at build time, so `m0derator` still hits `moderator`
 * through the i→l fold — the server's own check, mirrored), then the
 * reserved-AFFIX rule (`alice_team`, `admin_bob`,
 * `tacendum_fan` — the operator/brand subset as a first or last `_`
 * segment; mirrored here since 2026-10-08, U5, so it stops spending a claim
 * attempt and coming back as "taken"). The server answers a reserved name
 * with the same `taken` bytes; the local answer is honestly its own
 * ('reserved'), because the denylist is public by design and this device
 * can say so without spending an attempt. */
export function checkUsernameLocally(raw: string): UsernameLocalCheck {
  const normalized = normalizedUsernameOrNull(raw);
  if (normalized === null) return 'invalid';
  if ((RESERVED_USERNAMES as readonly string[]).includes(normalized)) return 'reserved';
  if (RESERVED_USERNAME_SKELETONS.has(usernameSkeleton(normalized))) return 'reserved';
  if (hasReservedUsernameAffix(normalized)) return 'reserved';
  return 'ok';
}

/** The §4.8 window, on this module's millisecond scale. */
export const USERNAME_COOLDOWN_MS = USERNAME_RENAME_COOLDOWN_SECONDS * 1000;

/** Whether an unlink this device performed still holds the cool-down
 * on a DIFFERENT name: the same 30-day arithmetic the server's precheck
 * runs on `usernameRenamedAt`, on this device's own stamp. */
export function unlinkCooldownActive(row: dbModule.UsernameUnlinkRow, nowMs: number): boolean {
  return nowMs - row.unlinkedAt < USERNAME_COOLDOWN_MS;
}

/* ── the dated cool-down (U2, 2026-10-08) ──────────────────────────── */

/**
 * The end of the running window, from EVERYTHING this device knows: the
 * state route's `cooldownUntil` (the server's own stamp, so a sibling and a
 * reinstall know it too), the window row this device wrote on its own
 * rename or unlink (the offline fallback), and the unlink moment itself
 * (the memory an older build left, with no window row beside it). The
 * latest one that is still ahead of `nowMs`; null when every source has
 * passed or none is known. All ms on the Date.now() scale.
 */
export function cooldownWindowEnd(
  candidates: ReadonlyArray<number | null | undefined>,
  nowMs: number,
): number | null {
  let end: number | null = null;
  for (const candidate of candidates) {
    if (candidate === null || candidate === undefined || candidate <= nowMs) continue;
    if (end === null || candidate > end) end = candidate;
  }
  return end;
}

/**
 * THE WINDOW THIS DEVICE SHOWS AND ENFORCES (the gate pass, 2026-10-08):
 * where the caller-owned state route ANSWERED, its `cooldownUntil` is the
 * window — null included. The server's stamp is the only one the server
 * enforces; a memory this device wrote (its own rename or unlink, or an
 * older build's unlink row) can be wrong — a /rename that landed on a
 * claimless group ran the claim branch and stamped nothing, a window ended
 * when the group it belonged to dissolved — and a definite answer must be
 * able to cancel it, or Change stays dark for 30 days behind a date the
 * server does not hold. The local memories govern only where the server
 * could not answer: the legacy path (today's production server), a refused
 * read, a failed one — and there the latest end still ahead wins, as
 * before (`cooldownWindowEnd`).
 */
export function knownCooldownEnd(
  state: IdentifierState | null,
  localCandidates: ReadonlyArray<number | null | undefined>,
  nowMs: number,
): number | null {
  if (state !== null && stateHasFacts(state)) {
    return state.cooldownUntil !== null && state.cooldownUntil > nowMs ? state.cooldownUntil : null;
  }
  return cooldownWindowEnd(localCandidates, nowMs);
}

/** Whether a state answer LANDED (eligible or needs_verification) — a
 * refusal and a failure carry no verdict a surface may act on. */
export function stateLanded(state: IdentifierState): boolean {
  return state.eligibility === 'eligible' || state.eligibility === 'needs_verification';
}

/** Whether a state answer carries the ACCOUNT'S FACTS: it came from the
 * state route itself, it landed, and the facts are there (the state route
 * always answers them as booleans; null is the legacy read's unknown). Only
 * such an answer may clear a row, cancel a window or name a date. */
export function stateHasFacts(state: IdentifierState): boolean {
  return state.source === 'state' && stateLanded(state) && state.holdsUsername !== null;
}

/** The window's end in the device's locale and time zone, day AND time
 * ("November 7, 2026 at 6:00 PM") — never an ISO stamp, never a count of
 * seconds. The server's window ends to the minute, and a label that named
 * only the day read as false for most of that day (the gate pass,
 * 2026-10-08: "again on November 7" beside a button still dark at 10:00
 * that morning) — the recovery and linked-devices deadlines name the time
 * the same way. */
export function cooldownEndLabel(untilMs: number): string {
  const date = new Date(untilMs);
  try {
    return date.toLocaleString(undefined, {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return date.toString();
  }
}

/* ── the phantom row (U1, the gate pass 2026-10-08) ─────────────────── */

/**
 * The clock-skew allowance between a row THIS device wrote and the server's
 * stamp for the same write — the FALLBACK rule, for a row that carries no
 * server stamp of its own (written by a build before the proof pass, or
 * while the re-read after its write could not land): the row is stamped
 * after the wire answered, so a device clock AHEAD of the server never
 * reads its own row as stale, and one BEHIND it by less than this never
 * does either. A sibling's change inside this allowance after this
 * device's own write goes unnoticed until the next change — the price of a
 * stamp compared across two clocks, which is why a row written since the
 * proof pass carries the server's stamp instead (`since`, below).
 */
export const STALE_ROW_SKEW_MS = 5 * 60_000;

/**
 * Whether a local row this device wrote is a PHANTOM — the account's live
 * row of that class is not the one this row recorded: a sibling renamed the
 * name or replaced the address, and this device's row would move the
 * sibling's row with its switch and delete it under the old name with its
 * Remove.
 *
 * Two rules, by what the row carries (the proof pass, 2026-10-08):
 *  - `rowSinceMs` present: the server's own birth stamp of the row this
 *    device wrote, read back from the state route right after the write
 *    (`usernameSince` / `emailSince`). The row is stale when the LIVE stamp
 *    differs from it — exact seconds, no clock of this device involved. So
 *    "claim on the phone, then Change on the iPad within five minutes" is
 *    seen on the phone's next read, and a device clock running slow never
 *    reads its own fresh row as a phantom.
 *  - no `rowSinceMs` (an older row): the skew rule — stale only when the
 *    live stamp is later than this row's own `rowStampMs` (its `claimedAt`,
 *    its `verifiedAt`) by more than STALE_ROW_SKEW_MS.
 * A null `serverSinceMs` (no live row, or unknown) is never stale: an
 * unknown erases nothing.
 */
export function localRowStale(
  rowStampMs: number,
  serverSinceMs: number | null,
  rowSinceMs?: number | null,
): boolean {
  if (serverSinceMs === null) return false;
  if (rowSinceMs !== undefined && rowSinceMs !== null) return serverSinceMs !== rowSinceMs;
  return serverSinceMs > rowStampMs + STALE_ROW_SKEW_MS;
}

/**
 * Whether a local row with NO stamp of its own may ADOPT the account's live
 * stamp as its `since` (the proof pass, 2026-10-08): the row was written by
 * this device (a claim or attach that just landed, or a row from a build
 * before the stamp existed) and the live row is not a sibling's as far as
 * the skew rule can tell — so the live stamp IS this row's. From then on
 * the exact rule governs: a sibling's later write moves the live stamp
 * away from the adopted one, however soon. Only on a settled answer that
 * carries facts; never over a row that already holds a stamp.
 */
export function adoptableRowStamp(
  row: { stamp: number; since?: number | null },
  state: IdentifierState,
  cls: 'username' | 'email',
): number | null {
  if (row.since !== undefined && row.since !== null) return null;
  if (!stateHasFacts(state)) return null;
  const live = cls === 'username' ? state.usernameSince : state.emailSince;
  if (live === null) return null;
  if (localRowStale(row.stamp, live)) return null;
  return live;
}

/* ── this device's own pacing of the identifier routes (U3) ─────────── */

/**
 * The server's `idroute:<userId>` bucket admits ten identifier-route calls
 * a minute per device — the eligibility read, claim, rename, unlink and the
 * consent toggles all draw it — and refuses the eleventh with the frozen
 * 403 the screen can only render as "try again later". This ledger counts
 * the calls THIS module sent in the trailing minute so the screen can say
 * "Try again in N s" BEFORE the tap. A local estimate, never the gate: it
 * never blocks a first call (the ledger starts empty) and the server stays
 * the authority. Every leg that draws the bucket records here — this
 * module's verbs, the legacy eligibility read, and (since the gate pass,
 * 2026-10-08) the email and phone legs in accounts.ts / accountsPhone.ts,
 * which the server charges to the same window. Keyed like the state cache,
 * so a new identity or a duress session never inherits another's count.
 */
export const IDENTIFIER_ROUTE_CALLS_PER_MINUTE = 10;
const IDENTIFIER_ROUTE_WINDOW_MS = 60_000;
const identifierRouteCalls = new Map<string, number[]>();

function identifierRouteLedger(nowMs: number): number[] {
  const key = identifierStateKey();
  let calls = identifierRouteCalls.get(key);
  if (!calls) {
    calls = [];
    identifierRouteCalls.set(key, calls);
  }
  while (calls.length > 0 && calls[0]! <= nowMs - IDENTIFIER_ROUTE_WINDOW_MS) calls.shift();
  return calls;
}

/** Record one identifier-route call this device is about to make. */
export function noteIdentifierRouteCall(nowMs: number): void {
  identifierRouteLedger(nowMs).push(nowMs);
}

/** Seconds to wait before the next identifier-route call would be the
 * eleventh in a minute; null when a call may go now. */
export function identifierRoutePacing(nowMs: number): number | null {
  const calls = identifierRouteLedger(nowMs);
  if (calls.length < IDENTIFIER_ROUTE_CALLS_PER_MINUTE) return null;
  return Math.max(1, Math.ceil((calls[0]! + IDENTIFIER_ROUTE_WINDOW_MS - nowMs) / 1000));
}

/** Forget every count (tests, and a dissolved identity). */
export function clearIdentifierRoutePacing(): void {
  identifierRouteCalls.clear();
}

/* ── claim / rename (ONE server verb) ─────────────────── */

export type UsernameClaimOutcome =
  | 'claimed'
  | 'renamed'
  | 'same'
  | 'taken'
  | 'invalid'
  | 'reserved'
  | 'refused'
  | 'failed';

/**
 * Claim a name — or RENAME, when this device already holds one: the server
 * has one handler behind two route spellings and the group's state decides, so this module spells the route from the local row and sends the
 * same body either way, with the consent bit EXPLICIT on the wire.
 * REFUSAL-FIRST: a refused or taken attempt changes NOTHING locally.
 * Success records the normalized name, the claim time, and the consent bit
 * exactly as sent — the row's structural default stays OFF; a claim with
 * the box unchecked is legal and shown honestly as held-but-unfindable.
 *
 * 'same' (U4, 2026-10-08) is this device's own knowledge too: the name
 * typed is the one its row already holds (case-folded, trimmed), so nothing
 * is sent — the server would answer the reasonless 403 and charge one of
 * the group's ten daily attempts for a no-op.
 *
 * A device whose group holds a name it never recorded (a linked sibling)
 * must not reach this verb's claim spelling: `renameUsername` below is the
 * rename it may send, and the screen never shows it the claim form (U1).
 */
export async function claimUsername(
  rawUsername: string,
  discoverable: boolean,
  deps: AccountsUsernameDeps = defaultDeps(),
): Promise<UsernameClaimOutcome> {
  const check = checkUsernameLocally(rawUsername);
  if (check !== 'ok') return check;
  const normalized = normalizedUsernameOrNull(rawUsername)!;
  const held = await deps.db.loadUsernameIdentifier();
  if (held !== null && held.username === normalized) return 'same';
  return writeUsername(normalized, discoverable, held !== null ? 'rename' : 'claim', deps);
}

/**
 * The RENAME a linked sibling sends for a name it cannot see (U1): the
 * group holds a username — the caller-owned state read said so — but this
 * device has no row to spell the route from, and the claim spelling would
 * rename the account by accident (the server now refuses it, and used to
 * rename silently). Always the rename route, the consent bit explicit; a
 * landed rename gives this device its first row, so the name shows here
 * from then on.
 */
export async function renameUsername(
  rawUsername: string,
  discoverable: boolean,
  deps: AccountsUsernameDeps = defaultDeps(),
): Promise<UsernameClaimOutcome> {
  const check = checkUsernameLocally(rawUsername);
  if (check !== 'ok') return check;
  const normalized = normalizedUsernameOrNull(rawUsername)!;
  return writeUsername(normalized, discoverable, 'rename', deps);
}

async function writeUsername(
  normalized: string,
  discoverable: boolean,
  route: 'claim' | 'rename',
  deps: AccountsUsernameDeps,
): Promise<UsernameClaimOutcome> {
  const token = await deps.token();
  if (!token) return 'failed';
  noteIdentifierRouteCall(deps.now());
  try {
    if (route === 'rename') await deps.api.usernameRename(token, normalized, discoverable);
    else await deps.api.usernameClaim(token, normalized, discoverable);
  } catch (error) {
    // The server answered (or not): whatever the group's facts are now, the
    // cached state read may be behind them — a sibling's claim is the
    // likeliest reason for a refusal here — so the next read goes to the wire.
    invalidateIdentifierState();
    if (isTaken(error)) return 'taken';
    return isRefusal(error) ? 'refused' : 'failed';
  }
  invalidateIdentifierState();
  const now = deps.now();
  // A fresh row carries NO server stamp yet: the screen's next settled
  // read adopts the live row's stamp as this row's (`adoptableRowStamp`),
  // and the exact rule governs from then on (the proof pass, 2026-10-08).
  await deps.db.saveUsernameIdentifier({
    username: normalized,
    claimedAt: now,
    discoverable,
  });
  // A landed claim ends the unlink memory: whatever cool-down the server
  // still holds, the name this device is now told about is the held one.
  await deps.db.clearUsernameUnlink();
  if (route === 'rename') {
    // The server stamped `usernameRenamedAt`: the next change waits 30 days
    // (U2). Remembered here so the holder sees the date, not "try again".
    await deps.db.saveUsernameCooldown({ until: now + USERNAME_COOLDOWN_MS });
    return 'renamed';
  }
  // A claim never stamps the window. Inside one it can only be the former
  // owner's take-back (the server refuses every other name), and the
  // server's window runs on — so the memory is KEPT; a claim landing with no
  // window running clears a memory that has passed.
  const memory = await deps.db.loadUsernameCooldown();
  if (memory !== null && memory.until <= now) await deps.db.clearUsernameCooldown();
  return 'claimed';
}

/** A local row the group no longer holds as this device knows it (U1): a
 * linked sibling removed the name — or RENAMED it (the gate pass: the live
 * row's `usernameSince` is later than this row's `claimedAt`) — and this
 * device kept showing it. Called by the screen ONLY on a definite answer
 * from the state route — never on the legacy path, never on an unknown.
 * The unlink memory is untouched: it records what THIS device did. */
export async function forgetPhantomUsername(
  deps: AccountsUsernameDeps = defaultDeps(),
): Promise<void> {
  await deps.db.clearUsernameIdentifier();
}

/** The USERNAME class's the design consent toggle — records this device's own
 * decision on the username row ALONE (the email and phone rows
 * never move with it, structurally). */
export async function setUsernameDiscoverable(
  on: boolean,
  deps: AccountsUsernameDeps = defaultDeps(),
): Promise<SimpleOutcome> {
  const token = await deps.token();
  if (!token) return 'failed';
  noteIdentifierRouteCall(deps.now());
  try {
    await deps.api.setUsernameDiscoverable(token, on);
  } catch (error) {
    invalidateIdentifierState();
    return isRefusal(error) ? 'refused' : 'failed';
  }
  invalidateIdentifierState();
  const existing = await deps.db.loadUsernameIdentifier();
  if (existing) {
    await deps.db.saveUsernameIdentifier({ ...existing, discoverable: on });
  }
  return 'ok';
}

/** Unlink the name: the claim row and its skeleton row become the former
 * owner's 30-day tombstones server-side while the email and phone
 * classes survive by construction; the local username row follows. */
export async function unlinkUsername(
  deps: AccountsUsernameDeps = defaultDeps(),
): Promise<SimpleOutcome> {
  const token = await deps.token();
  if (!token) return 'failed';
  const held = await deps.db.loadUsernameIdentifier();
  noteIdentifierRouteCall(deps.now());
  try {
    await deps.api.usernameUnlink(token);
  } catch (error) {
    invalidateIdentifierState();
    return isRefusal(error) ? 'refused' : 'failed';
  }
  invalidateIdentifierState();
  await deps.db.clearUsernameIdentifier();
  // The device's memory of what it just did (build 24): the server stamped
  // its 30-day cool-down on the unlink, and only the exact name is
  // reclaimable inside it — the claim form reads this row to say so before
  // the tap, because the wire will never say why. Written UNCONDITIONALLY
  // on a landed unlink (fix): a device whose local row is missing or stale
  // (the name was claimed on a sibling, the row not yet synced or wiped)
  // still performed the unlink the server stamped, so the memory records
  // the moment with an EMPTY name — the wire never echoes one — and the
  // form warns without naming the reclaimable name.
  const now = deps.now();
  await deps.db.saveUsernameUnlink({ username: held?.username ?? '', unlinkedAt: now });
  // And the window's end itself (U2), the same memory a rename writes.
  await deps.db.saveUsernameCooldown({ until: now + USERNAME_COOLDOWN_MS });
  return 'ok';
}

/* ── find by username (the design twin) ──────────────────────────────────── */

export type UsernameDiscoveryOutcome = DiscoveryOutcome | { outcome: 'invalid' };

/**
 * One typed-single lookup with the {username} field. The anchor choice is
 * the email flow's exact helper (class order, then ULID order — one rule,
 * every class), and EVERY server refusal is 'no_match', indistinguishable
 * by design. A locally malformed name is 'invalid' BEFORE any wire call —
 * the one distinction this device honestly owns (a RESERVED name is sent
 * as typed: it is a legal lookup that simply never resolves, and refusing
 * it locally would teach the denylist through the search box).
 */
export async function discoverySearchByUsername(
  rawUsername: string,
  deps: AccountsUsernameDeps = defaultDeps(),
): Promise<UsernameDiscoveryOutcome> {
  const normalized = normalizedUsernameOrNull(rawUsername);
  if (normalized === null) return { outcome: 'invalid' };
  const token = await deps.token();
  if (!token) return { outcome: 'error' };
  let response: DiscoveryLookupResponse;
  try {
    response = await deps.api.discoveryLookupUsername(token, normalized);
  } catch (error) {
    return isRefusal(error) ? { outcome: 'no_match' } : { outcome: 'error' };
  }
  const picked = pickDiscoveryAnchor(response);
  if (!picked) return { outcome: 'no_match' };
  return { outcome: 'found', anchor: picked.anchor, deviceCount: picked.deviceCount };
}
