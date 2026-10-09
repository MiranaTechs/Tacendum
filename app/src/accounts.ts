import {
  normalizeEmailIdentifier,
  normalizePhoneIdentifier,
  PHONE_E164_STRICT,
  type DiscoveryLookupResponse,
  type PrekeyBundle,
} from '@tacendum/shared';
import * as apiModule from './api';
import { ApiRequestError } from './api';
// The cached account-level read every identifier surface renders from
// (accountsUsername.getIdentifierState, fix/username-discovery 2026-10-08):
// every write below that changes the account's facts drops it, so a screen
// re-reading after the write never shows the state before it. accountsUsername
// imports pickDiscoveryAnchor from here; both uses are call-time, so the
// cycle is inert.
import {
  clearIdentifierRoutePacing,
  getIdentifierState,
  identifierRoutePacing,
  adoptableRowStamp,
  invalidateIdentifierState,
  localRowStale,
  noteIdentifierRouteCall,
} from './accountsUsername';
import type { IdentifierState } from './accountsUsername';
import * as cryptoModule from 'tacendum-crypto';
import * as dbModule from './db';
import { API_BASE } from './config';
import { currentToken } from './reauth';
import { DEVICE_SLOT_CLASS, type DeviceSlotClass } from './deviceNoun';
import { dissolveGrouping } from './linking';
import { sanitizeDisplayName } from './person';
import { session } from './session';
import { PHONE_UI_ENABLED } from './phoneUi';

/**
 * Identifier attach + discovery + recovery, client state machine. Screens drive this module; this module drives
 * api + the local database — and the local database is the ONLY place the
 * address ever lives readable, because the server stores a keyed hash and
 * never echoes it. Deps-injected like linking.ts: the suite's central
 * assertions are about REFUSALS leaving state untouched, which needs call
 * ledgers, not a network.
 *
 * The honesty rules this module encodes rather than papers over:
 *  - the code-send answer is UNIFORM (a 200 proves the ask was accepted,
 *    never that mail moved) — `requestAttachCode` records only "this device
 *    asked";
 *  - the consent toggle's 204 is UNIFORM — `setDiscoverable` records this
 *    device's OWN decision, the consent-edge shape, and never claims the
 *    server confirmed anything;
 *  - EVERY discovery refusal is one outcome, 'no_match' — miss,
 *    not-discoverable, recovery cool-down, and spent budgets are
 *    indistinguishable BY DESIGN, and
 *    this module refuses to invent distinctions the wire deliberately
 *    withholds. Only a transport failure is 'error' (offline is a fact
 *    about THIS device, honestly distinguishable).
 */

/* ── deps ─────────────────────────────────────────────────────────── */

export interface AccountsDeps {
  api: {
    emailRequestCode(token: string, email: string, deviceClass: DeviceSlotClass): Promise<void>;
    emailVerify(token: string, email: string, code: string): Promise<void>;
    emailUnlink(token: string): Promise<void>;
    setDiscoverable(token: string, on: boolean): Promise<void>;
    discoveryLookup(token: string, email: string): Promise<DiscoveryLookupResponse>;
    recoveryRequestCode(token: string, email: string): Promise<void>;
    recoveryVerify(
      token: string,
      email: string,
      code: string,
      deviceClass: DeviceSlotClass,
    ): Promise<{ groupId: string; completesAt: number }>;
    /** The parallel-field twins ({phone} instead of {email} — the
     * populated field IS the class, never a discriminant). Dark behind the
     * PHONE_UI_ENABLED surfaces: no landed flow reaches them. */
    recoveryRequestCodePhone(token: string, phone: string): Promise<void>;
    recoveryVerifyPhone(
      token: string,
      phone: string,
      code: string,
      deviceClass: DeviceSlotClass,
    ): Promise<{ groupId: string; completesAt: number }>;
    recoveryCancel(token: string): Promise<void>;
    recoveryComplete(
      token: string,
      groupId: string,
      challenge: string,
      signature: string,
    ): Promise<void>;
    authChallenge(identityKey: string): Promise<{ challenge: string }>;
    getPrekeyBundle(token: string, userId: string): Promise<PrekeyBundle>;
  };
  crypto: {
    identityPublicKey(): Promise<string | null>;
    signAuthChallenge(challenge: string, origin: string): Promise<string>;
  };
  db: Pick<
    typeof dbModule,
    | 'loadAccountIdentifier'
    | 'saveAccountIdentifier'
    | 'clearAccountIdentifier'
    | 'savePhoneIdentifier'
    | 'clearPhoneIdentifier'
    | 'loadLocalRecovery'
    | 'saveLocalRecovery'
    | 'clearLocalRecovery'
    | 'saveRecoveryNotice'
    | 'loadRecoveryNotice'
    | 'upsertChat'
    | 'setLocalName'
    | 'loadLinkGroup'
    | 'saveLinkGroup'
    | 'upsertLinkedDevice'
  > &
    /** The username class's local rows the downgrade takes with it (the
     * gate pass, 2026-10-08): the dissolve's last exit tombstones the name
     * server-side, so a row left behind read, on the next visit, as
     * "changed or removed from another device". Optional for the suites
     * that build deps by hand; the default deps wire the real module. */
    Partial<
      Pick<
        typeof dbModule,
        'clearUsernameIdentifier' | 'clearUsernameUnlink' | 'clearUsernameCooldown'
      >
    >;
  dissolve(): Promise<void>;
  token(): Promise<string | null>;
  selfId(): Promise<string | null>;
  now(): number;
}

function defaultDeps(): AccountsDeps {
  return {
    api: {
      emailRequestCode: apiModule.apiEmailRequestCode,
      emailVerify: apiModule.apiEmailVerify,
      emailUnlink: apiModule.apiEmailUnlink,
      setDiscoverable: apiModule.apiSetDiscoverable,
      discoveryLookup: apiModule.apiDiscoveryLookup,
      recoveryRequestCode: apiModule.apiRecoveryRequestCode,
      recoveryVerify: apiModule.apiRecoveryVerify,
      recoveryRequestCodePhone: apiModule.apiRecoveryRequestCodePhone,
      recoveryVerifyPhone: apiModule.apiRecoveryVerifyPhone,
      recoveryCancel: apiModule.apiRecoveryCancel,
      recoveryComplete: apiModule.apiRecoveryComplete,
      authChallenge: apiModule.apiAuthChallenge,
      getPrekeyBundle: apiModule.apiGetPrekeyBundle,
    },
    crypto: {
      identityPublicKey: cryptoModule.identityPublicKey,
      signAuthChallenge: cryptoModule.signAuthChallenge,
    },
    db: dbModule,
    dissolve: () => dissolveGrouping(),
    token: currentToken,
    selfId: async () => (await dbModule.loadProfile())?.userId ?? null,
    now: Date.now,
  };
}

/** An http-level answer from the server (the collapsed 403 above all —
 * budgets and malformed bodies included): a REFUSAL, not a transport
 * failure. Everything else (offline, DNS, a dead socket) is 'failed'. */
function isRefusal(error: unknown): boolean {
  return error instanceof ApiRequestError;
}

/** The code request's ONE distinguishable refusal (D2, fix/username-
 * discovery 2026-10-08): a 429 from the caller's OWN budgets — the
 * per-device identifier-route burst and the per-group daily attach
 * allowance (identifiers.ts `rateLimitedResult`) — by STATUS alone. Both
 * are self-keyed, so the answer discloses nothing about any address; every
 * address-shaped refusal stays inside the collapsed 403 above. */
function isRateLimited(error: unknown): boolean {
  return error instanceof ApiRequestError && error.status === 429;
}

/* ── the account's own facts (D2) ─────────────────────────────────── */

export type { IdentifierState } from './accountsUsername';
/** The stale-row rule the email screen applies to its own row against the
 * account's live email (`emailSince`), and the identifier-route pacing note
 * the phone module records before each of its legs: by reference, for the
 * same reason. */
export { adoptableRowStamp, clearIdentifierRoutePacing, localRowStale, noteIdentifierRouteCall };

/**
 * The account group's facts the email surface renders beside its local row
 * (D2, the 2026-10-08 fix train): whether the group holds a verified email
 * (`emailLinked` — true and false are FACTS from the state route; null is
 * unknown), from the caller-owned state read. Exposed through THIS module
 * because the email screen drives it already and the handle class's word
 * census keeps that class's module out of every other screen and deck;
 * the read itself is cached by its module and dropped by every write above
 * and below (`invalidateIdentifierState`).
 */
export function loadIdentifierState(): Promise<IdentifierState> {
  return getIdentifierState();
}

/* ── email attach ────────────────────────────────────────────── */

export type AttachRequestOutcome = 'sent' | 'refused' | 'failed';

/** The attach code request's answers: the recovery request's three, plus
 * the self-keyed 429s the request step may tell apart (D2; split by
 * Retry-After at the gate pass): 'rate_limited' is this device's burst
 * window (seconds — "wait a minute"), 'rate_limited_today' the account's
 * daily allowance (hours — "they reset at midnight UTC"). */
export type AttachCodeOutcome = AttachRequestOutcome | 'rate_limited' | 'rate_limited_today';

/** Retry-After past this is not the minute's burst window but a day's
 * allowance (the server's burst window is 60 s; the daily window refills
 * on the UTC day, or at hours of token-bucket refill). */
const RATE_LIMIT_BURST_MAX_SECONDS = 60;

/** The per-minute identifier-route pacing this device keeps (U3): the
 * server allows ten identifier-route calls a minute per device and the
 * email legs draw the same window as the username verbs, so the Email
 * screen asks this before a tap exactly as the Username screen does.
 * Seconds to wait, or null when a call may go now. */
export function identifierRoutePacingNow(nowMs = Date.now()): number | null {
  return identifierRoutePacing(nowMs);
}

/** Ask for an attach code. On the uniform 200 the pending address is
 * recorded locally — the only place it can be recorded, and only the fact
 * this device asked. */
export async function requestAttachCode(
  rawEmail: string,
  deps: AccountsDeps = defaultDeps(),
): Promise<AttachCodeOutcome> {
  const token = await deps.token();
  if (!token) return 'failed';
  const normalized = normalizeEmailIdentifier(rawEmail);
  // The server charges this leg to the caller's shared identifier-route
  // window (the one the Username screen paces): counted here too.
  noteIdentifierRouteCall(deps.now());
  try {
    await deps.api.emailRequestCode(token, normalized, DEVICE_SLOT_CLASS);
  } catch (error) {
    if (isRateLimited(error)) {
      const retry = (error as ApiRequestError).retryAfterSeconds;
      return retry !== null && retry > RATE_LIMIT_BURST_MAX_SECONDS
        ? 'rate_limited_today'
        : 'rate_limited';
    }
    // A refusal here can be a sibling's change the cached state read does
    // not know yet (the account's one email was linked, or removed, from
    // another device): the next read goes to the wire.
    if (isRefusal(error)) {
      invalidateIdentifierState();
      return 'refused';
    }
    return 'failed';
  }
  const existing = await deps.db.loadAccountIdentifier();
  await deps.db.saveAccountIdentifier({
    email: existing?.email ?? null,
    verifiedAt: existing?.verifiedAt ?? null,
    discoverable: existing?.discoverable ?? false,
    pendingEmail: normalized,
    pendingRequestedAt: deps.now(),
    restoredAt: existing?.restoredAt ?? null,
    since: existing?.since ?? null,
  });
  return 'sent';
}

export type AttachConfirmOutcome = 'attached' | 'refused' | 'failed';

/**
 * Prove the code — the attach itself. REFUSAL-FIRST CONTRACT: a refused
 * verify (wrong code, expired row, an address already claimed, the dark
 * flag — one collapsed byte-stream, deliberately) changes NOTHING locally.
 * Success records the identifier with `discoverable: false` — DEFAULT OFF
 * IS STRUCTURAL: no code path exists from here to a discoverable
 * identifier without the owner's own later toggle.
 */
export async function confirmAttach(
  rawEmail: string,
  code: string,
  deps: AccountsDeps = defaultDeps(),
): Promise<AttachConfirmOutcome> {
  const token = await deps.token();
  if (!token) return 'failed';
  const normalized = normalizeEmailIdentifier(rawEmail);
  noteIdentifierRouteCall(deps.now());
  try {
    await deps.api.emailVerify(token, normalized, code);
  } catch (error) {
    return isRefusal(error) ? 'refused' : 'failed';
  }
  await deps.db.saveAccountIdentifier({
    email: normalized,
    verifiedAt: deps.now(),
    // The design: consent belongs to the discovered party and is a LATER, separate
    // act. A freshly verified identifier is not findable.
    discoverable: false,
    pendingEmail: null,
    pendingRequestedAt: null,
    // An ordinary attach IS this device's own act — never the restored
    // placeholder state.
    restoredAt: null,
    // No server stamp yet: the Email screen's next settled read adopts the
    // live row's stamp as this row's (the proof pass, 2026-10-08).
  });
  // The account now holds an email: the cached account-level read is stale.
  invalidateIdentifierState();
  return 'attached';
}

export type SimpleOutcome = 'ok' | 'refused' | 'failed';

/** The consent toggle. The wire's 204 is uniform BY DESIGN, so what this
 * records is this device's own decision — exactly the consent-edge pattern:
 * the local row is the memory, never a server receipt. */
export async function setDiscoverable(
  on: boolean,
  deps: AccountsDeps = defaultDeps(),
): Promise<SimpleOutcome> {
  const token = await deps.token();
  if (!token) return 'failed';
  noteIdentifierRouteCall(deps.now());
  try {
    await deps.api.setDiscoverable(token, on);
  } catch (error) {
    // Refused: the account may no longer hold this email (a sibling's
    // change) — the next state read goes to the wire.
    if (isRefusal(error)) {
      invalidateIdentifierState();
      return 'refused';
    }
    return 'failed';
  }
  const existing = await deps.db.loadAccountIdentifier();
  if (existing) {
    // The owner's own toggle is a REAL decision: it also settles the
    // restored-placeholder state a recovery leaves behind —
    // from here on the switch shows what this device set.
    await deps.db.saveAccountIdentifier({ ...existing, discoverable: on, restoredAt: null });
  }
  invalidateIdentifierState();
  return 'ok';
}

/** Unlink the email: server claim + consent die together, then the
 * local record follows. A refusal keeps local state — the screen says the
 * truth it has rather than inventing a cleaner one. */
export async function unlinkIdentifier(
  deps: AccountsDeps = defaultDeps(),
): Promise<SimpleOutcome> {
  const token = await deps.token();
  if (!token) return 'failed';
  noteIdentifierRouteCall(deps.now());
  try {
    await deps.api.emailUnlink(token);
  } catch (error) {
    // Refused: the group holds no email any more — a sibling removed it
    // after this device's last read. The next read goes to the wire, so a
    // retry is not answered from the same stale memory.
    if (isRefusal(error)) {
      invalidateIdentifierState();
      return 'refused';
    }
    return 'failed';
  }
  await deps.db.clearAccountIdentifier();
  // The account's email is gone — for every device, since the claim is the
  // GROUP's (a linked sibling may run this with no local row at all).
  invalidateIdentifierState();
  return 'ok';
}

/**
 * Downgrade to anonymous (the settings-surface flow): identifier
 * first (its own server delete — tolerated as already-gone), then the
 * dissolve producer (linking.dissolveGrouping: the signed peer-visible
 * statement + the roster walked down on the landed unlink verb, whose last
 * exit deletes the group row and any remaining claims), then the local
 * record. Every step is capability-shrinking, so a failure mid-way leaves
 * a state strictly no worse than where it stopped — and the copy says so.
 */
export async function downgradeToAnonymous(
  deps: AccountsDeps = defaultDeps(),
): Promise<'downgraded' | 'failed'> {
  const token = await deps.token();
  if (!token) return 'failed';
  noteIdentifierRouteCall(deps.now());
  try {
    await deps.api.emailUnlink(token);
  } catch (error) {
    // Already-gone / never-attached refuses here; that IS the desired
    // state. A transport failure still surfaces below through dissolve —
    // and an identifier-less dissolve is a complete downgrade.
    if (!isRefusal(error)) return 'failed';
  }
  // Whatever the dissolve below does, the identifier leg has already
  // changed the account's facts: drop the cached read now, not only on the
  // complete exit (a partial downgrade must not keep showing the email).
  invalidateIdentifierState();
  // Whether a ceremonial group stands to dissolve: its last exit tombstones
  // the account's username server-side (nobody reclaims), so the local
  // username row and this device's cool-down memories go with it below —
  // a row left behind read, on the next visit, as "changed or removed from
  // another device" (the gate pass, 2026-10-08). A lazily minted solo group
  // has no local row and keeps its name through the email leg alone.
  const grouped = (await deps.db.loadLinkGroup()) !== null;
  try {
    await deps.dissolve();
  } catch {
    return 'failed';
  }
  await deps.db.clearAccountIdentifier();
  // The phone class's local row goes with the downgrade too: the
  // dissolve's last exit takes EVERY claim server-side, and a flag-dark
  // binary simply has no phone row for this to touch.
  await deps.db.clearPhoneIdentifier();
  if (grouped) {
    await deps.db.clearUsernameIdentifier?.();
    await deps.db.clearUsernameUnlink?.();
    await deps.db.clearUsernameCooldown?.();
  }
  return 'downgraded';
}

/* ── find by email ───────────────────────────────────────────── */

export type DiscoveryOutcome =
  | { outcome: 'found'; anchor: string; deviceCount: number }
  | { outcome: 'no_match' }
  | { outcome: 'error' };

/** The ONE anchor choice for a positive lookup: ULID ascending, and NOTHING
 * else. The phone-first class preference DIED with the information that fed
 * it: the deployed server sends one constant
 * literal for every member, and a later deploy drops the field entirely —
 * so build 19 ignores `class` UNCONDITIONALLY. This is deliberate hardening,
 * not just simplification: ranking on any class the wire happens to carry
 * would make the anchor a class-dependent channel that the planned wire
 * states (all-constant or all-absent) never produce, so a heterogeneous
 * response must not route differently either. Shared with the find-by-phone
 * twin (accountsPhone.ts imports THIS function) so the two identifier
 * classes cannot drift apart on which member a chat addresses — the same
 * anchor now, under the constant, and after the field is gone. */
export function pickDiscoveryAnchor(
  response: DiscoveryLookupResponse,
): { anchor: string; deviceCount: number } | null {
  const members = [...response.members].sort((a, b) =>
    a.userId < b.userId ? -1 : 1,
  );
  const first = members[0];
  if (!first) return null;
  return { anchor: first.userId, deviceCount: members.length };
}

/**
 * One typed-single-identifier lookup. A positive answer names the
 * account's member ULIDs; the ANCHOR — the ULID the chat is addressed to —
 * is chosen by ULID order alone (class is ignored unconditionally; see
 * pickDiscoveryAnchor), and is an API fact the screen never renders (no ULID anywhere in this flow). EVERY server refusal is 'no_match',
 * indistinguishable by design.
 */
export async function discoverySearch(
  rawEmail: string,
  deps: AccountsDeps = defaultDeps(),
): Promise<DiscoveryOutcome> {
  const token = await deps.token();
  if (!token) return { outcome: 'error' };
  const normalized = normalizeEmailIdentifier(rawEmail);
  let response: DiscoveryLookupResponse;
  try {
    response = await deps.api.discoveryLookup(token, normalized);
  } catch (error) {
    return isRefusal(error) ? { outcome: 'no_match' } : { outcome: 'error' };
  }
  const picked = pickDiscoveryAnchor(response);
  if (!picked) return { outcome: 'no_match' };
  return { outcome: 'found', anchor: picked.anchor, deviceCount: picked.deviceCount };
}

/**
 * The result card was tapped: open the ordinary chat ("tap → chat").
 * The TYPED email becomes the local label (the one name the finder actually
 * knows; local-only, exactly like any nickname), and everything after this
 * is the normal thread: first bundle fetch pins keys TOFU, the safety
 * machinery applies unchanged — discovery changes who you can reach, never
 * the trust model.
 *
 * The chat is marked `introducedBy: 'discovery'`: the
 * SERVER resolved this person, not a friend's hand-off, and the thread says
 * so until a safety-number match is recorded. Both shipped classes (email
 * and phone) arrive here, so the mark is made once, for both. Local only —
 * the lookup's bytes are unchanged and nothing rides back.
 */
export async function startDiscoveredChat(
  typedEmail: string,
  anchor: string,
  deps: AccountsDeps = defaultDeps(),
  /** The provenance mark (a kind set designed open): the shipped email
   * and phone classes record 'discovery'; the username class passes `db.DISCOVERY_USERNAME_INTRODUCED` — a server
   * introduction like the others, distinguishable in the record only so a
   * client-local "found as X" line can one day read it. */
  introducedBy: dbModule.IntroducedBy = 'discovery',
): Promise<void> {
  await deps.db.upsertChat(anchor, undefined, introducedBy);
  try {
    // The label is the TYPED email, exactly as typed (trimmed only): it is
    // the finder's own knowledge, a nickname — normalization is a WIRE
    // concern (the lookup already normalized before resolving) and applying
    // it here would silently rewrite what the person wrote. Sanitizing is not normalizing: it strips only what
    // no one can honestly type into an email field — controls, bidi marks,
    // zero-width characters — and leaves every visible byte alone.
    await deps.db.setLocalName(anchor, sanitizeDisplayName(typedEmail));
  } catch {
    // A label is a convenience; losing it must not block the chat.
  }
}

/* ── recovery ─────────────────────────────────────────── */

/** Pre-registration intent: the landing screen's "Recover my account
 * grouping" sits BESIDE registration (never inside it), so after
 * the ordinary, untouched registration completes, the router returns here
 * instead of the chat list. In-process by design: a relaunch mid-flow
 * lands on the ordinary workspace, and the durable `recovery_local` row is
 * what carries a STARTED recovery across relaunches. */
let recoveryIntentFlag = false;
export function setRecoveryIntent(on: boolean): void {
  recoveryIntentFlag = on;
}
export function recoveryIntent(): boolean {
  return recoveryIntentFlag;
}

/**
 * The server's code window: an attach or recovery code works for 5 minutes
 * (the decks' code-sent sentences say so). One constant for the three code
 * surfaces, so a pending row older than this renders as expired and a
 * recovery-request memo older than this is forgotten. */
export const PENDING_CODE_TTL_MS = 5 * 60_000;

/**
 * The server's resend cool-down: one code per address (or number) per 60 s
 * (ratelimit.ts `identifierResend` / `phoneResend`). A tap inside it sends
 * nothing and answers the same — so the three code surfaces count it down
 * on the button instead of inviting the tap. */
export const RESEND_COOLDOWN_MS = 60_000;

/** Milliseconds still to wait before another code may be asked for; 0 when
 * none — including for an unknown request time, and for a clock that moved
 * backwards (a wait computed from the future would lock the button for as
 * long as the clock is wrong). */
export function resendWaitMs(requestedAt: number | null, now: number): number {
  if (requestedAt == null) return 0;
  const age = now - requestedAt;
  if (age < 0) return 0;
  return Math.max(0, RESEND_COOLDOWN_MS - age);
}

/** "1:00" / "0:47" — the countdown's clock, rounded UP to the second so it
 * never reads 0:00 while the button is still refusing. */
export function formatResendClock(remainingMs: number): string {
  const seconds = Math.max(0, Math.ceil(remainingMs / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/* ── the recovery-request memo ────────────────────────── */

/**
 * Which address a recovery code was asked for, and when. Nothing local
 * records a REQUESTED (not yet proven) recovery code — the attach flow
 * writes `pendingEmail`, this flow wrote nothing — so an App Lock relock
 * ("Right away" is the default) or a relaunch between "Email me a code"
 * and the inbox threw the screen back to an empty form, where a re-request
 * inside the resend minute quietly sends nothing. The memo lives in the
 * Keychain (the lock's own at-rest store; no schema change), for the code's
 * own 5-minute life, and never in a duress session (rule 16: the decoy
 * workspace must not carry the real workspace's address).
 */
export interface RecoveryRequestRecord {
  address: string;
  kind: dbModule.IdentifierKind;
  requestedAt: number;
}

const KEY_RECOVERY_REQUEST = 'recovery.request';

async function rememberRecoveryRequest(record: RecoveryRequestRecord): Promise<void> {
  if (session.mode === 'duress') return;
  try {
    await cryptoModule.setSecret(KEY_RECOVERY_REQUEST, JSON.stringify(record));
  } catch {
    // A memo, never the flow: the code is on its way regardless.
  }
}

export async function clearRecoveryRequest(): Promise<void> {
  try {
    await cryptoModule.deleteSecret(KEY_RECOVERY_REQUEST);
  } catch {
    // Best-effort hygiene; an unreadable memo is forgotten on the next read.
  }
}

/** The live memo, or null. An expired memo — or one a clock that moved
 * backwards makes implausible — is forgotten on read, never restored. */
export async function loadRecoveryRequest(
  now: () => number = Date.now,
): Promise<RecoveryRequestRecord | null> {
  if (session.mode === 'duress') return null;
  let raw: string | null | undefined;
  try {
    raw = await cryptoModule.getSecret(KEY_RECOVERY_REQUEST);
  } catch {
    return null;
  }
  if (!raw) return null;
  let parsed: Partial<RecoveryRequestRecord> | null = null;
  try {
    parsed = JSON.parse(raw) as Partial<RecoveryRequestRecord>;
  } catch {
    parsed = null;
  }
  const valid =
    parsed !== null &&
    typeof parsed === 'object' &&
    typeof parsed.address === 'string' &&
    parsed.address !== '' &&
    (parsed.kind === dbModule.EMAIL_KIND || parsed.kind === dbModule.PHONE_KIND) &&
    typeof parsed.requestedAt === 'number' &&
    Number.isFinite(parsed.requestedAt);
  const age = valid ? now() - (parsed as RecoveryRequestRecord).requestedAt : -1;
  if (!valid || age < 0 || age >= PENDING_CODE_TTL_MS) {
    await clearRecoveryRequest();
    return null;
  }
  return parsed as RecoveryRequestRecord;
}

export async function requestRecoveryCode(
  rawEmail: string,
  deps: AccountsDeps = defaultDeps(),
): Promise<AttachRequestOutcome> {
  const token = await deps.token();
  if (!token) return 'failed';
  const normalized = normalizeEmailIdentifier(rawEmail);
  try {
    await deps.api.recoveryRequestCode(token, normalized);
  } catch (error) {
    return isRefusal(error) ? 'refused' : 'failed';
  }
  await rememberRecoveryRequest({
    address: normalized,
    kind: dbModule.EMAIL_KIND,
    requestedAt: deps.now(),
  });
  return 'sent';
}

export type RecoveryConfirmOutcome =
  | { outcome: 'pending'; completesAt: number }
  | { outcome: 'refused' }
  | { outcome: 'failed' };

/** Prove the emailed code: the 72 h pending row is born server-side and
 * recorded here so the wait survives a relaunch. The groupId in the answer
 * is an API fact — never rendered (the no-ULID-on-glass rule). */
export async function confirmRecoveryCode(
  rawEmail: string,
  code: string,
  deps: AccountsDeps = defaultDeps(),
): Promise<RecoveryConfirmOutcome> {
  const token = await deps.token();
  if (!token) return { outcome: 'failed' };
  const normalized = normalizeEmailIdentifier(rawEmail);
  let answer: { groupId: string; completesAt: number };
  try {
    answer = await deps.api.recoveryVerify(token, normalized, code, DEVICE_SLOT_CLASS);
  } catch (error) {
    return isRefusal(error) ? { outcome: 'refused' } : { outcome: 'failed' };
  }
  await deps.db.saveLocalRecovery({
    // Restoration is TYPED off this kind: the pending row
    // records the class of the identifier that proved the code.
    kind: dbModule.EMAIL_KIND,
    value: normalized,
    groupId: answer.groupId,
    completesAt: answer.completesAt,
    verifiedAt: deps.now(),
  });
  // The code is proven: the request memo has done its work.
  await clearRecoveryRequest();
  return { outcome: 'pending', completesAt: answer.completesAt };
}

/* ── recovery by phone (the recovery door's second class;
 *    rendered ONLY under PHONE_UI_ENABLED, dark until its train) ──── */

/** Client-side: normalize (strip human formatting), then STRICT
 * E.164 or refuse — never repair, never guess a country. Returns null for
 * anything the wire would refuse; the caller renders the honest LOCAL
 * sentence (this device's own knowledge of the shape, not a server
 * answer). */
export function normalizedPhoneOrNull(raw: string): string | null {
  const normalized = normalizePhoneIdentifier(raw.trim());
  return PHONE_E164_STRICT.test(normalized) ? normalized : null;
}

export type PhoneRequestOutcome = AttachRequestOutcome | 'invalid';

export async function requestRecoveryCodeByPhone(
  rawPhone: string,
  deps: AccountsDeps = defaultDeps(),
): Promise<PhoneRequestOutcome> {
  const normalized = normalizedPhoneOrNull(rawPhone);
  if (normalized === null) return 'invalid';
  const token = await deps.token();
  if (!token) return 'failed';
  try {
    await deps.api.recoveryRequestCodePhone(token, normalized);
  } catch (error) {
    return isRefusal(error) ? 'refused' : 'failed';
  }
  await rememberRecoveryRequest({
    address: normalized,
    kind: dbModule.PHONE_KIND,
    requestedAt: deps.now(),
  });
  return 'sent';
}

export async function confirmRecoveryCodeByPhone(
  rawPhone: string,
  code: string,
  deps: AccountsDeps = defaultDeps(),
): Promise<RecoveryConfirmOutcome | { outcome: 'invalid' }> {
  const normalized = normalizedPhoneOrNull(rawPhone);
  if (normalized === null) return { outcome: 'invalid' };
  const token = await deps.token();
  if (!token) return { outcome: 'failed' };
  let answer: { groupId: string; completesAt: number };
  try {
    answer = await deps.api.recoveryVerifyPhone(token, normalized, code, DEVICE_SLOT_CLASS);
  } catch (error) {
    return isRefusal(error) ? { outcome: 'refused' } : { outcome: 'failed' };
  }
  await deps.db.saveLocalRecovery({
    kind: dbModule.PHONE_KIND,
    value: normalized,
    groupId: answer.groupId,
    completesAt: answer.completesAt,
    verifiedAt: deps.now(),
  });
  await clearRecoveryRequest();
  return { outcome: 'pending', completesAt: answer.completesAt };
}

/**
 * THE DARK PIN OVER THE PERSISTED ROW: a
 * kind='phone' `recovery_local` row must be INVISIBLE and UNCOMPLETABLE in
 * a binary whose build pin is false — otherwise a row written by a pin-ON
 * build (or a dev build) reopens a phone surface inside a binary whose
 * store declarations do not carry it. One predicate, consumed by every
 * consumer of the row: App.tsx's two boot re-entry sites (route to the
 * recover surface only over a row this binary may show), RecoveryScreen's
 * load (render nothing for a dark row), and `completeRecovery` below (the
 * guard, independent of rendering). The row itself is PRESERVED — the
 * kill-switch dominance mirrored client-side: completion refuses while the
 * pin is false and resumes when a pin-ON binary returns.
 */
export function recoveryRowVisible(
  row: dbModule.LocalRecoveryRow | null,
): row is dbModule.LocalRecoveryRow {
  return row !== null && (PHONE_UI_ENABLED || row.kind !== dbModule.PHONE_KIND);
}

export type RecoveryCompleteOutcome = 'completed' | 'refused' | 'not_ready' | 'failed';

/**
 * Complete the recovery after the delay: live possession of THIS device's
 * registered identity key is proven over a fresh auth challenge (the
 * existing v2 preimage — the named item-1 machinery, no new crypto
 * surface), and the server's transaction conditions — delay elapsed,
 * nobody cancelled — decide. A refusal is rendered as the collapse it is:
 * a cancel and a not-yet are DELIBERATELY indistinguishable to this
 * caller, because the device the survivors just refused must not learn
 * which device refused it.
 */
export async function completeRecovery(
  deps: AccountsDeps = defaultDeps(),
): Promise<RecoveryCompleteOutcome> {
  const pending = await deps.db.loadLocalRecovery();
  if (!pending) return 'failed';
  // The dark pin's own guard: a false-pin binary
  // never completes a phone-class recovery — not even driven outside the
  // screens. The row survives untouched for the pin-ON binary.
  if (!recoveryRowVisible(pending)) return 'failed';
  if (Math.floor(deps.now() / 1000) < pending.completesAt) return 'not_ready';
  const token = await deps.token();
  const selfUserId = await deps.selfId();
  if (!token || !selfUserId) return 'failed';
  const identityKey = await deps.crypto.identityPublicKey();
  if (identityKey === null) return 'failed';
  try {
    const { challenge } = await deps.api.authChallenge(identityKey);
    const signature = await deps.crypto.signAuthChallenge(challenge, API_BASE);
    await deps.api.recoveryComplete(token, pending.groupId, challenge, signature);
  } catch (error) {
    if (!isRefusal(error)) return 'failed';
    // THE CRASH-WINDOW RECONCILIATION: an EARLIER
    // completion may have COMMITTED server-side and died before the local
    // writes below — the pending recovery is then already consumed, and
    // every retry refuses forever while this device is, in truth, grouped.
    // The committed truth is readable through an existing surface: this
    // device's own bundle serves rosterVersion exactly when it is grouped
    // (the keys route). Grouped ⇒ finish the LOCAL half of the earlier
    // commit; ungrouped ⇒ the refusal stands as-is (a cancel and a not-yet
    // stay deliberately indistinguishable). Guarded on having no local
    // group already — a device grouped by any other path is not this
    // crash window and must not have its group row overwritten.
    try {
      if ((await deps.db.loadLinkGroup()) !== null) return 'refused';
      const own = await deps.api.getPrekeyBundle(token, selfUserId);
      if (own.userId !== selfUserId || own.rosterVersion === undefined) {
        return 'refused';
      }
    } catch {
      return 'refused';
    }
    await recordCompletedRecoveryLocally(pending, selfUserId, identityKey, token, deps);
    return 'completed';
  }
  await recordCompletedRecoveryLocally(pending, selfUserId, identityKey, token, deps);
  return 'completed';
}

/** The LOCAL half of a committed recovery: group row, own roster row, and
 * the identifier row, so the unlink and consent controls exist
 * on the recovered device. The identifier is KNOWN and VERIFIED here (the
 * recovery code was a round-trip on exactly this address or number);
 * `discoverable` is recorded as the RESTORED placeholder (`restoredAt`
 * set): the server preserved the account's pre-loss consent, this device
 * cannot read it back (the wire is uniform by design), and the screen says
 * so until the owner's own toggle settles it. Restoration is TYPED: the row is written under the pending row's OWN kind — a phone
 * recovery never resurrects as an email row. */
async function recordCompletedRecoveryLocally(
  pending: dbModule.LocalRecoveryRow,
  selfUserId: string,
  identityKey: string,
  token: string,
  deps: AccountsDeps,
): Promise<void> {
  // Grouped now: record the group and this device's own roster row. The
  // recovered member is HONESTLY CERTLESS (no ceremony ran): sibling
  // rows are NOT blanket-recorded from any served list, because this fresh
  // install holds no pinned key a certificate could verify against; the
  // roster fills in through the ordinary signals as trust is established.
  await deps.db.saveLinkGroup(pending.groupId, 0);
  await deps.db.upsertLinkedDevice({
    userId: selfUserId,
    class: DEVICE_SLOT_CLASS,
    state: 'linked',
    updatedAt: deps.now(),
    certsJson: '',
    identityKeyPub: identityKey,
  });
  if (pending.kind === dbModule.PHONE_KIND) {
    await deps.db.savePhoneIdentifier({
      phone: pending.value,
      verifiedAt: deps.now(),
      discoverable: false,
      pendingPhone: null,
      pendingRequestedAt: null,
      restoredAt: deps.now(),
    });
  } else {
    await deps.db.saveAccountIdentifier({
      email: pending.value,
      verifiedAt: deps.now(),
      discoverable: false,
      pendingEmail: null,
      pendingRequestedAt: null,
      restoredAt: deps.now(),
    });
  }
  try {
    const own = await deps.api.getPrekeyBundle(token, selfUserId);
    if (own.userId === selfUserId && own.rosterVersion !== undefined) {
      await deps.db.saveLinkGroup(pending.groupId, own.rosterVersion);
    }
  } catch {
    // Loudness, never correctness: the epoch catches up from later signals.
  }
  await deps.db.clearLocalRecovery();
  // This device just joined a group that holds the identifier it proved.
  invalidateIdentifierState();
}

/** Give up locally: deletes only this device's own record of the attempt.
 * The server row runs its course — a surviving member's cancel still wins,
 * and an uncancelled row simply expires unclaimed. */
export async function abandonRecovery(
  deps: AccountsDeps = defaultDeps(),
): Promise<void> {
  await deps.db.clearLocalRecovery();
}

/** THE SURVIVING MEMBER'S CANCEL (the cancel WINS): bearer-authorized
 * deliberately, so the owner's tablet outruns a thief holding the phone.
 * On success the stored notice flips to 'cancelled' so the surface shows
 * the settled state without waiting for the fan-out echo. */
export async function cancelRecovery(
  deps: AccountsDeps = defaultDeps(),
): Promise<SimpleOutcome> {
  const token = await deps.token();
  if (!token) return 'failed';
  try {
    await deps.api.recoveryCancel(token);
  } catch (error) {
    return isRefusal(error) ? 'refused' : 'failed';
  }
  const notice = await deps.db.loadRecoveryNotice();
  if (notice) {
    await deps.db.saveRecoveryNotice({
      ...notice,
      kind: 'cancelled',
      receivedAt: deps.now(),
    });
  }
  return 'ok';
}
