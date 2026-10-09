import * as apiModule from './api';
import { ApiRequestError } from './api';
import * as dbModule from './db';
import { currentToken } from './reauth';
import { DEVICE_SLOT_CLASS, type DeviceSlotClass } from './deviceNoun';
import {
  // The shared identifier-route pacing (U3; the gate pass 2026-10-08): the
  // server charges every phone leg to the same per-device window the other
  // identifier classes' legs draw, so each is counted before it is sent.
  noteIdentifierRouteCall,
  normalizedPhoneOrNull,
  pickDiscoveryAnchor,
  type DiscoveryOutcome,
  type SimpleOutcome,
} from './accounts';
import type { DiscoveryLookupResponse } from '@tacendum/shared';

/**
 * Phone attach + per-class consent + find-by-phone, client state machine
 * (AccountEmailScreen's module sibling, exactly the
 * accounts.ts discipline: deps-injected, refusal-first, the local database
 * the ONLY readable home of the number because the server stores a keyed
 * hash and never echoes it). Every surface that calls this module renders
 * ONLY under the build-pinned `PHONE_UI_ENABLED` (phoneUi.ts): the
 * module ships dark.
 *
 * The one honesty rule the phone class ADDS: entry is
 * country-code-explicit and strict E.164 — a malformed number is refused
 * LOCALLY as 'invalid' (this device's own knowledge of the shape, honestly
 * distinguishable), never repaired, never sent, and never dressed up as a
 * server refusal. Everything else is the email module's honesty verbatim:
 * uniform code-send answers, consent recorded as this device's OWN
 * decision, and EVERY server refusal of the find flow one 'no_match'.
 */

/* ── deps ─────────────────────────────────────────────────────────── */

export interface AccountsPhoneDeps {
  api: {
    phoneRequestCode(token: string, phone: string, deviceClass: DeviceSlotClass): Promise<void>;
    phoneVerify(token: string, phone: string, code: string): Promise<void>;
    phoneUnlink(token: string): Promise<void>;
    setPhoneDiscoverable(token: string, on: boolean): Promise<void>;
    discoveryLookupPhone(token: string, phone: string): Promise<DiscoveryLookupResponse>;
  };
  db: Pick<
    typeof dbModule,
    'loadPhoneIdentifier' | 'savePhoneIdentifier' | 'clearPhoneIdentifier'
  >;
  token(): Promise<string | null>;
  now(): number;
}

function defaultDeps(): AccountsPhoneDeps {
  return {
    api: {
      phoneRequestCode: apiModule.apiRequestPhoneCode,
      phoneVerify: apiModule.apiVerifyPhone,
      phoneUnlink: apiModule.apiUnlinkPhone,
      setPhoneDiscoverable: apiModule.apiSetPhoneDiscoverable,
      discoveryLookupPhone: apiModule.apiDiscoveryLookupPhone,
    },
    db: dbModule,
    token: currentToken,
    now: Date.now,
  };
}

/** The accounts.ts rule verbatim: an http-level answer is a REFUSAL (the
 * collapsed 403 above all); everything else is a transport failure. */
function isRefusal(error: unknown): boolean {
  return error instanceof ApiRequestError;
}

/* ── phone attach (the design twin) ───────────────────────────────────────── */

export type PhoneAttachRequestOutcome = 'sent' | 'invalid' | 'refused' | 'failed';

/** Ask for an attach code by text message. On the uniform 200 only the
 * fact this device asked is recorded — the normalized pending number. */
export async function requestPhoneAttachCode(
  rawPhone: string,
  deps: AccountsPhoneDeps = defaultDeps(),
): Promise<PhoneAttachRequestOutcome> {
  const normalized = normalizedPhoneOrNull(rawPhone);
  if (normalized === null) return 'invalid';
  const token = await deps.token();
  if (!token) return 'failed';
  noteIdentifierRouteCall(deps.now());
  try {
    await deps.api.phoneRequestCode(token, normalized, DEVICE_SLOT_CLASS);
  } catch (error) {
    return isRefusal(error) ? 'refused' : 'failed';
  }
  const existing = await deps.db.loadPhoneIdentifier();
  await deps.db.savePhoneIdentifier({
    phone: existing?.phone ?? null,
    verifiedAt: existing?.verifiedAt ?? null,
    discoverable: existing?.discoverable ?? false,
    pendingPhone: normalized,
    pendingRequestedAt: deps.now(),
    restoredAt: existing?.restoredAt ?? null,
  });
  return 'sent';
}

export type PhoneAttachConfirmOutcome = 'attached' | 'invalid' | 'refused' | 'failed';

/**
 * Prove the code — the attach itself. REFUSAL-FIRST: a refused verify
 * changes NOTHING locally. Success records the number with
 * `discoverable: false` — DEFAULT OFF IS STRUCTURAL per class:
 * no code path exists from here to a findable number without the owner's
 * own later toggle, and the email row is untouched by construction (its
 * own row — the per-class consent migration).
 */
export async function confirmPhoneAttach(
  rawPhone: string,
  code: string,
  deps: AccountsPhoneDeps = defaultDeps(),
): Promise<PhoneAttachConfirmOutcome> {
  const normalized = normalizedPhoneOrNull(rawPhone);
  if (normalized === null) return 'invalid';
  const token = await deps.token();
  if (!token) return 'failed';
  noteIdentifierRouteCall(deps.now());
  try {
    await deps.api.phoneVerify(token, normalized, code);
  } catch (error) {
    return isRefusal(error) ? 'refused' : 'failed';
  }
  await deps.db.savePhoneIdentifier({
    phone: normalized,
    verifiedAt: deps.now(),
    discoverable: false,
    pendingPhone: null,
    pendingRequestedAt: null,
    restoredAt: null,
  });
  return 'attached';
}

/** The PHONE class's the design consent toggle — records this device's own
 * decision on the phone row ALONE (the email row never moves with
 * it, structurally). */
export async function setPhoneDiscoverable(
  on: boolean,
  deps: AccountsPhoneDeps = defaultDeps(),
): Promise<SimpleOutcome> {
  const token = await deps.token();
  if (!token) return 'failed';
  noteIdentifierRouteCall(deps.now());
  try {
    await deps.api.setPhoneDiscoverable(token, on);
  } catch (error) {
    return isRefusal(error) ? 'refused' : 'failed';
  }
  const existing = await deps.db.loadPhoneIdentifier();
  if (existing) {
    await deps.db.savePhoneIdentifier({ ...existing, discoverable: on, restoredAt: null });
  }
  return 'ok';
}

/** Unlink the number: the phone claim + its consent die together
 * server-side while the email class survives by construction (a per-class
 * transaction); the local phone row follows. */
export async function unlinkPhoneIdentifier(
  deps: AccountsPhoneDeps = defaultDeps(),
): Promise<SimpleOutcome> {
  const token = await deps.token();
  if (!token) return 'failed';
  noteIdentifierRouteCall(deps.now());
  try {
    await deps.api.phoneUnlink(token);
  } catch (error) {
    return isRefusal(error) ? 'refused' : 'failed';
  }
  await deps.db.clearPhoneIdentifier();
  return 'ok';
}

/* ── find by number (the design twin) ─────────────────────────────────────── */

export type PhoneDiscoveryOutcome = DiscoveryOutcome | { outcome: 'invalid' };

/**
 * One typed-single lookup with the {phone} field. The anchor choice is the
 * email flow's exact helper (class order, then ULID order — one rule, both
 * classes), and EVERY server refusal is 'no_match', indistinguishable by
 * design. A locally malformed number is 'invalid' BEFORE any wire call —
 * the one distinction this device honestly owns.
 */
export async function discoverySearchByPhone(
  rawPhone: string,
  deps: AccountsPhoneDeps = defaultDeps(),
): Promise<PhoneDiscoveryOutcome> {
  const normalized = normalizedPhoneOrNull(rawPhone);
  if (normalized === null) return { outcome: 'invalid' };
  const token = await deps.token();
  if (!token) return { outcome: 'error' };
  let response: DiscoveryLookupResponse;
  try {
    response = await deps.api.discoveryLookupPhone(token, normalized);
  } catch (error) {
    return isRefusal(error) ? { outcome: 'no_match' } : { outcome: 'error' };
  }
  const picked = pickDiscoveryAnchor(response);
  if (!picked) return { outcome: 'no_match' };
  return { outcome: 'found', anchor: picked.anchor, deviceCount: picked.deviceCount };
}
