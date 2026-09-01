import {
  deleteSharedState,
  readSharedState,
  writeSharedState,
} from 'tacendum-crypto';
import { PREVIEWS_ARMED_FILE } from './previews';
import { session } from './session';

/**
 * Facts the notification-service extension needs and cannot work out itself.
 *
 * The extension has no database (op-sqlite is a JSI HostObject, so touching it
 * would boot a JavaScript runtime in a process with ~24 MB to spend) and no
 * Keychain (reaching it needs a shared access group, and adding one rewrites
 * the access group of items that already exist — the lock passcode among
 * them). So anything it needs, the app writes to a file in the App Group
 * container.
 *
 * Kept separate from `previews.ts` because these are different in kind: that
 * module holds a PREFERENCE and a claim about the current session, while this
 * is a projection of database state. They are written at different moments and
 * for different reasons.
 */

/** This device's own user id. Needed as the local address to decrypt. */
export const SELF_ID_FILE = 'self-user-id';

/**
 * ULIDs of peers this device has blocked, newline-separated.
 *
 * A blocked sender can still put bytes on the wire — blocking is enforced on
 * receipt and is deliberately undetectable to them — so the server still
 * queues their message and still sends a push. Without this mirror the block
 * would be visibly incomplete in the one place it is most conspicuous: a
 * banner on the lock screen, from someone the owner blocked.
 */
export const BLOCKED_FILE = 'blocked-peers';

/**
 * Publish the id the extension decrypts as.
 *
 * Called when a real session opens. Never from a duress session: the decoy
 * workspace has its own identity, and an extension decrypting as the decoy
 * would spool decoy plaintext into the real inbox.
 */
export async function publishSelfId(userId: string): Promise<void> {
  await writeSharedState(SELF_ID_FILE, userId);
}

/**
 * Withdraw it, so the extension cannot decrypt at all.
 *
 * Called on relock and on duress alongside `disarmPreviews`. Belt and braces:
 * the armed marker alone already stops the extension, and this stops it a
 * second, independent way — without a local address there is nothing to
 * decrypt with, whatever the marker says.
 */
export async function retractSelfId(): Promise<void> {
  // NAMES FIRST, and each deletion independent of the others. The review
  // counterexample for the old order: the self-id delete throws, and the
  // names — the contact list, the more sensitive of the two — are never
  // even attempted. Now a failure in any still attempts the others, and
  // the self-id failure propagates so the caller knows the retraction is
  // incomplete. Room names are names too — "Divorce support group" on the
  // lock screen is the same disclosure class as a contact — so they leave
  // with the peer names, independently.
  const names = deleteSharedState(PEER_NAMES_FILE).catch(() => undefined);
  const rooms = deleteSharedState(GROUP_NAMES_FILE).catch(() => undefined);
  const self = deleteSharedState(SELF_ID_FILE);
  await names;
  await rooms;
  await self;
}

/**
 * Mirror the blocked list out of the database.
 *
 * Rewritten whole rather than appended to, so an unblock takes effect: a
 * mirror that only ever grows would keep suppressing notifications from
 * someone the owner deliberately let back in.
 */
export async function publishBlockedPeers(ids: readonly string[]): Promise<void> {
  await writeSharedState(BLOCKED_FILE, ids.join('\n'));
}

/**
 * peerId → display name, as a JSON object.
 *
 * Read by CallKitCenter at VOIP PUSH TIME, which is the only reason it
 * exists: the push arrives before anything can decrypt, so without this the
 * full-screen ring's first paint says "Incoming call" and stays that way on
 * a cold launch. The value obeys `personName`'s precedence — the name I gave
 * them outranks the name they shared — and peers with neither are simply
 * absent, so the ring falls back to the placeholder rather than showing a
 * raw ULID.
 *
 * These are REAL NAMES ON DISK in the shared container, which is why
 * `retractSelfId` deletes this file too: a duress session must not leak the
 * owner's contact list to the lock screen one incoming call at a time.
 */
export const PEER_NAMES_FILE = 'peer-names';

export async function publishPeerNames(
  entries: readonly { peerId: string; name: string }[],
): Promise<void> {
  const map: Record<string, string> = {};
  for (const e of entries) {
    if (e.name) map[e.peerId] = e.name;
  }
  // Checked at the WRITE, not only at the call site: every publisher is
  // fire-and-forget, so a write that began in a real session can land after
  // a duress entry retracted the mirror — recreating the contact list the
  // retraction just deleted. The check narrows that race to the microseconds
  // between it and the write. (A DECOY session republishing decoy names is
  // fine — desirable, even; mode is 'duress' then and this still refuses,
  // keeping the mirror empty, which shows the placeholder. A ring that says
  // "Incoming call" during duress reveals nothing.)
  if (session.mode !== 'real') return;
  // And the lease, for the RELOCK the mode gate cannot see (relock keeps
  // mode 'real'): a rename racing a relock used to land its listChats write
  // after retractSelfId deleted this file, resurrecting the whole contact
  // list on a locked phone — every subsequent VoIP ring then named its
  // caller in exactly the state the retraction exists to keep nameless.
  // Relock disarms the lease BEFORE the retraction starts, so an in-flight
  // write across a relock finds it gone and refuses. Unlock re-arms the
  // lease before messaging starts, so the boot-time publish is never
  // refused.
  if (!(await previewsArmed())) return;
  await writeSharedState(PEER_NAMES_FILE, JSON.stringify(map));
}

/**
 * groupId → display name, as a JSON object.
 *
 * Read by the notification-service extension to TITLE a room's banner at
 * preview level `full`. It exists because `PEER_NAMES_FILE` is peer-keyed and
 * a room banner keyed on the sender would misattribute — a room message would
 * dress itself as a 1:1 from whoever happened to write it. The extension
 * never takes a room's name from any payload byte; a room absent from this
 * mirror simply shows the generic body, which is the permitted direction to
 * be wrong in.
 *
 * These are REAL ROOM NAMES ON DISK in the shared container — the same
 * disclosure class as the contact list — so `retractSelfId` deletes this file
 * alongside the peer names.
 */
export const GROUP_NAMES_FILE = 'group-names';

/**
 * True while the previews-armed lease is live.
 *
 * BOTH name publishers gate on this at the write. They are fire-and-forget
 * from db.ts, which has no access to messaging's stop() generation, and a
 * RELOCK keeps session mode 'real', so the mode gate alone cannot catch a
 * write that was in flight across one. The lease is the signal that CAN be
 * read from here: relock disarms it before retracting the mirrors, so the
 * straggling write finds the lease gone and refuses. The check narrows that
 * race to the microseconds between it and the write, exactly like the mode
 * check above. Anything unreadable or unparseable reads as disarmed — the
 * extension applies the same rule.
 */
async function previewsArmed(): Promise<boolean> {
  try {
    const raw = await readSharedState(PREVIEWS_ARMED_FILE);
    if (!raw) return false;
    const lease = JSON.parse(raw) as { v?: unknown; deadline?: unknown };
    return (
      lease.v === 1 &&
      typeof lease.deadline === 'number' &&
      Date.now() < lease.deadline
    );
  } catch {
    return false;
  }
}

/**
 * Mirror the rooms' names out of the database. Rewritten whole, like the
 * blocked list, so a deleted room's name actually leaves the file. Rooms
 * whose name resolves empty are dropped — the extension shows the generic
 * body for them rather than an empty title.
 *
 * Two gates, both at the WRITE because every publisher is fire-and-forget:
 * the session-mode check (a duress entry must not rebuild what retractSelfId
 * just deleted), and the armed lease (a plain relock keeps mode 'real', so
 * only the lease can refuse a write that was in flight across it). The lease
 * gate also means this mirror never exists in a state where the extension
 * could not render a preview anyway.
 */
export async function publishGroupNames(
  entries: readonly { groupId: string; name: string }[],
): Promise<void> {
  const map: Record<string, string> = {};
  for (const e of entries) {
    if (e.name) map[e.groupId] = e.name;
  }
  if (session.mode !== 'real') return;
  if (!(await previewsArmed())) return;
  await writeSharedState(GROUP_NAMES_FILE, JSON.stringify(map));
}
