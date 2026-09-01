import * as db from './db';
import { setBadgeCount } from 'tacendum-call';
import { deleteSharedState, writeSharedState } from 'tacendum-crypto';

/**
 * The two files the notification extension does badge arithmetic with:
 * `badge = base + extra`. The app writes `base` (its real unread total) and
 * DELETES `extra` whenever it recomputes, which is what makes the app the
 * owner of the truth — any drift the extension's counter picks up self-heals
 * the next time this runs.
 */
const BADGE_BASE = 'badge-base';
const BADGE_EXTRA = 'badge-extra';

/**
 * The extension's per-sender continuation counts behind the coalesced banner: "<sender> <count>" lines written by
 * CollapseCounter.swift and rendered as "N new messages" at preview level
 * `.full`. The app only ever DELETES this file — never writes it — and does
 * so on BadgeCounter's exact reset path, because the moments are the same
 * moment: whenever the app takes the truth back (cold start and every
 * foreground resume via syncBadge, the wipe/lock clears via clearBadge), a
 * surviving banner stops being a continuation — the user is here, and the
 * next push from any sender is message 1 of a new absence.
 */
const COALESCE_COUNTS = 'coalesce-counts';

/**
 * The number on the app icon.
 *
 * **Who sets it, and why it takes two of them.** The server puts a count on
 * every message push — it has to, because a notification that arrives while
 * the app is dead is the only thing that can raise a badge at that moment, and
 * only the server knows a message is waiting. But the server's number is the
 * depth of the DELIVERY QUEUE, not unread mail: it counts what it has not yet
 * handed over, and it stops counting the instant the device acks. It has no
 * idea what anyone has read, and telling it would be telling it who is talking
 * to whom and when they looked.
 *
 * So the app owns the number whenever it is running. `syncBadge` overwrites
 * whatever the server last set with this device's own unread count, which is
 * the real answer. The server's count is the stand-in for the window where
 * nothing better exists.
 *
 * **Duress.** `unreadCounts` reads whichever workspace is open, so a decoy
 * session badges the decoy's unread and never leaks the real one from THIS
 * side. Stated honestly: the notification EXTENSION keeps incrementing for
 * real messages that arrive during a decoy session, so the icon can tick up
 * — the same fact the un-suppressible "New message" banner already announces
 * (an extension may rewrite a notification, never drop one). The badge adds
 * no bit the banner does not; the count it shows is base + arrivals, not the
 * real workspace's unread total, which is never written while the decoy is
 * open.
 */

/**
 * Push this device's unread total to the icon.
 *
 * Never throws and never rejects: it is called from teardown paths, from
 * background transitions, and after message delivery, and a badge is not worth
 * failing any of those. A database that cannot be read leaves the previous
 * number alone rather than clearing it — a stale count is a smaller lie than a
 * zero over a phone with unread messages.
 */
export async function syncBadge(): Promise<void> {
  try {
    const counts = await db.unreadCounts();
    let total = 0;
    for (const n of Object.values(counts)) total += n;
    await setBadgeCount(total);
    // Base rewritten and the extension's counter reset, in that order — a
    // crash between the two leaves base fresh and extra stale, which over-
    // counts by at most the stale extras until the next sync. The reverse
    // order could briefly under-count, and a badge that says nothing is
    // waiting when something is, is the worse lie.
    await writeSharedState(BADGE_BASE, String(total)).catch(() => undefined);
    await deleteSharedState(BADGE_EXTRA).catch(() => undefined);
    // The continuation counts leave with the extra: the app is foregrounded
    // (or backgrounding, having just been), so the next banner is not a
    // continuation of anything the user has not seen.
    await deleteSharedState(COALESCE_COUNTS).catch(() => undefined);
  } catch {
    // Deliberate. See above.
  }
}

/**
 * Clear the icon unconditionally, without consulting the database.
 *
 * For the two moments where the count is not merely unknown but must not be
 * computed: a wipe has taken the database away, and a lock screen should not
 * be reading conversation state to decide what to draw on the icon. Both want
 * the same thing — no number.
 */
export async function clearBadge(): Promise<void> {
  try {
    await setBadgeCount(0);
  } catch {
    // Same posture.
  }
  // Without these, the next push would resurrect the number just cleared:
  // the extension computes base + extra from the files, not from the icon.
  await writeSharedState(BADGE_BASE, '0').catch(() => undefined);
  await deleteSharedState(BADGE_EXTRA).catch(() => undefined);
  // And the continuation counts, for the same reason a wipe zeroes the
  // badge: a count accumulated before this moment must not shape the next
  // banner after it.
  await deleteSharedState(COALESCE_COUNTS).catch(() => undefined);
}
