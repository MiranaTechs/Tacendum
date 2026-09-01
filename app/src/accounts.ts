import {
  normalizeEmailIdentifier,
  normalizePhoneIdentifier,
  PHONE_E164_STRICT,
  type DiscoveryLookupResponse,
  type PrekeyBundle,
} from '@tacendum/shared';
import * as apiModule from './api';
import { ApiRequestError } from './api';
import * as cryptoModule from 'tacendum-crypto';
import * as dbModule from './db';
import { API_BASE } from './config';
import { currentToken } from './reauth';
import { DEVICE_SLOT_CLASS, type DeviceSlotClass } from './deviceNoun';
import { dissolveGrouping } from './linking';
import { sanitizeDisplayName } from './person';
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

/* ── email attach ────────────────────────────────────────────── */

export type AttachRequestOutcome = 'sent' | 'refused' | 'failed';

/** Ask for an attach code. On the uniform 200 the pending address is
 * recorded locally — the only place it can be recorded, and only the fact
 * this device asked. */
export async function requestAttachCode(
  rawEmail: string,
  deps: AccountsDeps = defaultDeps(),
): Promise<AttachRequestOutcome> {
  const token = await deps.token();
  if (!token) return 'failed';
  const normalized = normalizeEmailIdentifier(rawEmail);
  try {
    await deps.api.emailRequestCode(token, normalized, DEVICE_SLOT_CLASS);
  } catch (error) {
    return isRefusal(error) ? 'refused' : 'failed';
  }
  const existing = await deps.db.loadAccountIdentifier();
  await deps.db.saveAccountIdentifier({
    email: existing?.email ?? null,
    verifiedAt: existing?.verifiedAt ?? null,
    discoverable: existing?.discoverable ?? false,
    pendingEmail: normalized,
    pendingRequestedAt: deps.now(),
    restoredAt: existing?.restoredAt ?? null,
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
  });
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
  try {
    await deps.api.setDiscoverable(token, on);
  } catch (error) {
    return isRefusal(error) ? 'refused' : 'failed';
  }
  const existing = await deps.db.loadAccountIdentifier();
  if (existing) {
    // The owner's own toggle is a REAL decision: it also settles the
    // restored-placeholder state a recovery leaves behind —
    // from here on the switch shows what this device set.
    await deps.db.saveAccountIdentifier({ ...existing, discoverable: on, restoredAt: null });
  }
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
  try {
    await deps.api.emailUnlink(token);
  } catch (error) {
    return isRefusal(error) ? 'refused' : 'failed';
  }
  await deps.db.clearAccountIdentifier();
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
  try {
    await deps.api.emailUnlink(token);
  } catch (error) {
    // Already-gone / never-attached refuses here; that IS the desired
    // state. A transport failure still surfaces below through dissolve —
    // and an identifier-less dissolve is a complete downgrade.
    if (!isRefusal(error)) return 'failed';
  }
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
