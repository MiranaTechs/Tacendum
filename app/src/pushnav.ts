/**
 * The redemption half of a banner tap.
 *
 * AppDelegate writes ONE line — "<unix-ms> <threadIdentifier>" — into the
 * shared container when a notification is tapped (the platform's default
 * action only; no category with answer actions exists anywhere, by the adopted
 * design). This module consumes it. Navigation rides those identifiers and
 * NOTHING else: no URL scheme, no deep link, no RN link-listener surface —
 * the bare-id guardrail covers every entry surface, and push.tapnav.test.ts
 * pins all three absences.
 *
 * WHAT THE INTENT IS: a row key. The threadIdentifier the NSE mints is the
 * peer's ULID for a 1:1 and "g/" plus the room's ULID for a room, and a
 * room's conversation row IS its ULID — so both redeem
 * to the same `{ name: 'thread', peerId }` route, prefix stripped. It
 * carries no approval content, no message byte, no name: what waits on disk
 * while the lock screen stands says nothing about anyone, and what comes
 * out of here can only ever be 26 characters of the id alphabet.
 *
 * WHO MAY REDEEM: only a caller already standing inside an open REAL
 * workspace — App.tsx calls this after `enterRealWorkspace` routed to
 * chats, and on the foreground edge under the same
 * `session.mode === 'real'` gate the socket resume uses. The decoy arm
 * calls it to DISCARD: a tap must not decorate the decoy with a thread its
 * database cannot explain, and the intent must not outlive the coerced
 * session to teleport a later real unlock. Nothing here touches lock.ts
 * and nothing here can — the tap path ends in a file, the unlock rules,
 * and this runs strictly after the verdict.
 */

import { deleteSharedState, readSharedState } from 'tacendum-crypto';

/** One fact in two languages — AppDelegate.swift writes it, this deletes it
 * (the `coalesce-counts` pinning pattern). */
export const PENDING_NAV_FILE = 'pending-nav';

/**
 * How stale a tap may be and still navigate. Generous enough to survive a
 * lock-screen cooldown between the tap and the verdict; small enough that a
 * phone picked up hours later opens on chats like any other launch instead
 * of teleporting into a conversation nobody just asked for.
 */
export const PENDING_NAV_TTL_MS = 10 * 60 * 1000;

/** A clock that jumped backward leaves a future timestamp behind; past this
 * wobble the line is treated as the corruption it is, not as a fresh tap. */
const MAX_FUTURE_SKEW_MS = 60 * 1000;

/**
 * The line as Swift writes it and ONLY as Swift writes it: unix-ms, one
 * space, then a bare 26-char id or "g/" plus one — peerId.ts's CANON
 * alphabet, restated because that regex is not exported and a
 * machine-minted key gets none of the folding tolerance a human-typed id
 * earns (the pin test holds the two literals together). Anything else — an
 * envelope, a URL, a name — is not an intent.
 */
const INTENT_LINE = /^(\d{1,15}) (g\/)?([0-9A-HJKMNP-TV-Z]{26})$/;

/**
 * Read, validate, DELETE, and only then answer. Consume-before-answer is
 * the failure direction stated as code: an intent that cannot be deleted is
 * reported as absent, because a tap that navigates on every unlock forever
 * is worse than a tap that navigates zero times. Never throws — a
 * navigation nicety must not be able to fail an unlock.
 */
export async function consumePendingNav(
  now: number = Date.now(),
): Promise<string | null> {
  let raw: string | null;
  try {
    raw = await readSharedState(PENDING_NAV_FILE);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    await deleteSharedState(PENDING_NAV_FILE);
  } catch {
    return null;
  }
  const m = INTENT_LINE.exec(raw);
  if (!m) return null;
  const ts = Number(m[1]);
  if (now - ts > PENDING_NAV_TTL_MS) return null;
  if (ts - now > MAX_FUTURE_SKEW_MS) return null;
  return m[3];
}
