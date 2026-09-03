import * as apiModule from './api';
import { ApiRequestError } from './api';
import * as dbModule from './db';
import { currentToken } from './reauth';
import { pickDiscoveryAnchor, type DiscoveryOutcome, type SimpleOutcome } from './accounts';
import {
  DISCOVERY_MIN_ACCOUNT_AGE_SECONDS,
  RESERVED_USERNAMES,
  RESERVED_USERNAME_SKELETONS,
  USERNAME_RENAME_COOLDOWN_SECONDS,
  USERNAME_STRICT,
  USERNAME_TAKEN_STATUS,
  normalizeUsernameIdentifier,
  usernameSkeleton,
  type DiscoveryLookupResponse,
} from '@tacendum/shared';
import { decodeTime } from 'ulid';

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
 * through the i→l fold — the server's own check, mirrored). The server
 * answers a reserved name with the same `taken` bytes; the local answer is
 * honestly its own ('reserved'), because the denylist is public by design
 * and this device can say so without spending an attempt. */
export function checkUsernameLocally(raw: string): UsernameLocalCheck {
  const normalized = normalizedUsernameOrNull(raw);
  if (normalized === null) return 'invalid';
  if ((RESERVED_USERNAMES as readonly string[]).includes(normalized)) return 'reserved';
  if (RESERVED_USERNAME_SKELETONS.has(usernameSkeleton(normalized))) return 'reserved';
  return 'ok';
}

/* ── the claim gate's preconditions, from this device's own knowledge ── */

/**
 * The age gate, counted locally (a simulator-tested
 * report: every refusal is the reasonless 403 by design, so the two
 * preconditions this device CAN know are said before the tap). The account
 * ID is the ULID the server minted at creation, so its time half IS the
 * server's own `createdAt` stamp — the same clock the gate reads, no local
 * registration timestamp to keep. Whole hours still to wait, 0 when the
 * gate is already open, null when the ID does not decode (a fixture, a
 * malformed row): unknown is quiet, never a false warning. Surfaced, never
 * enforced — the server is the gate.
 */
export function usernameClaimWaitHours(userId: string, nowMs: number): number | null {
  const opensAt = usernameClaimOpensAtMs(userId);
  if (opensAt === null) return null;
  const remainingMs = opensAt - nowMs;
  return remainingMs > 0 ? Math.ceil(remainingMs / 3_600_000) : 0;
}

/** When the §4.5 age gate opens for this account, in milliseconds since the
 * epoch — the server-minted ID's own time half plus the three days the
 * server counts on the CALLER's createdAt; null for an ID that does not
 * decode. The screen arms a timer on it so a wait that ends on-screen
 * re-enables the claim button. */
export function usernameClaimOpensAtMs(userId: string): number | null {
  try {
    return decodeTime(userId) + DISCOVERY_MIN_ACCOUNT_AGE_SECONDS * 1000;
  } catch {
    return null;
  }
}

/** Whether an unlink this device performed still holds the cool-down
 * on a DIFFERENT name: the same 30-day arithmetic the server's precheck
 * runs on `usernameRenamedAt`, on this device's own stamp. */
export function unlinkCooldownActive(row: dbModule.UsernameUnlinkRow, nowMs: number): boolean {
  return nowMs - row.unlinkedAt < USERNAME_RENAME_COOLDOWN_SECONDS * 1000;
}

/* ── claim / rename (ONE server verb) ─────────────────── */

export type UsernameClaimOutcome =
  | 'claimed'
  | 'renamed'
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
 */
export async function claimUsername(
  rawUsername: string,
  discoverable: boolean,
  deps: AccountsUsernameDeps = defaultDeps(),
): Promise<UsernameClaimOutcome> {
  const check = checkUsernameLocally(rawUsername);
  if (check !== 'ok') return check;
  const normalized = normalizedUsernameOrNull(rawUsername)!;
  const token = await deps.token();
  if (!token) return 'failed';
  const held = await deps.db.loadUsernameIdentifier();
  const renaming = held !== null;
  try {
    if (renaming) await deps.api.usernameRename(token, normalized, discoverable);
    else await deps.api.usernameClaim(token, normalized, discoverable);
  } catch (error) {
    if (isTaken(error)) return 'taken';
    return isRefusal(error) ? 'refused' : 'failed';
  }
  await deps.db.saveUsernameIdentifier({
    username: normalized,
    claimedAt: deps.now(),
    discoverable,
  });
  // A landed claim ends the unlink memory: whatever cool-down the server
  // still holds, the name this device is now told about is the held one.
  await deps.db.clearUsernameUnlink();
  return renaming ? 'renamed' : 'claimed';
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
  try {
    await deps.api.setUsernameDiscoverable(token, on);
  } catch (error) {
    return isRefusal(error) ? 'refused' : 'failed';
  }
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
  try {
    await deps.api.usernameUnlink(token);
  } catch (error) {
    return isRefusal(error) ? 'refused' : 'failed';
  }
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
  await deps.db.saveUsernameUnlink({ username: held?.username ?? '', unlinkedAt: deps.now() });
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
