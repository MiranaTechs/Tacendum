import { deleteSharedState, readSharedState, writeSharedState } from 'tacendum-crypto';
import { session } from './session';

/**
 * How much of a message a notification is allowed to show.
 *
 * Three levels, because the honest answer to "should notifications show
 * message content" is that it depends on who is standing behind you. A
 * messenger that picks one for everybody is picking wrong for somebody.
 *
 *   full    sender's name and the message text
 *   sender  the sender's name only
 *   none    "New message", and nothing else
 *
 * **Defaults to `sender`, not `full`.** The middle option is the one that is
 * useful without being a disclosure: it tells you whether to reach for your
 * phone, and it does not put a stranger's words on a screen you are not
 * holding. Someone who wants the full text can say so; someone who would have
 * been harmed by it never has to discover the setting first.
 *
 * **Stored as a FILE, not in the Keychain.** The extension that renders the
 * notification cannot read the Keychain — reaching it needs a shared
 * `keychain-access-groups` entitlement, and adding one rewrites the access
 * group of items that already exist, the lock passcode verifier among them. A
 * preference must not be able to lock someone out of their own app. See
 * `sharedStateRoot()` in TacendumCryptoImpl.swift.
 */

export type PreviewLevel = 'full' | 'sender' | 'none';

/** The file both processes agree on. Lowercase and hyphens: it becomes a path. */
export const PREVIEW_LEVEL_FILE = 'preview-level';

/**
 * The file whose EXISTENCE says previews may be rendered at all.
 *
 * Written on a real unlock, deleted on relock and on duress. The polarity is
 * deliberate and it is the opposite of the obvious one: a "duress" flag that
 * must be SET to suppress previews fails open — an app killed mid-duress, a
 * write that did not land, a file lost to a restore, and the decoy session's
 * notifications start showing the real owner's messages.
 *
 * Absence is the safe state, and absence is also the state after a crash,
 * after a reinstall, after a restore, and before the app has ever run. Every
 * way this can go wrong ends in "no preview".
 */
export const PREVIEWS_ARMED_FILE = 'previews-armed';

/**
 * How long an armed marker stays valid without renewal, and the sanity bound
 * the extension applies against clock rollback.
 *
 * The marker is a LEASE, not a flag. A bare flag had a provable failure:
 * shared-state files that are readable but no longer writable survive a
 * duress entry — both disarm routes fail, both are swallowed because the
 * decoy must open — and every future notification then renders real previews
 * inside the decoy session. Two changes close that:
 *
 *  - the marker carries a DEADLINE the app renews (at unlock, and on
 *    backgrounding from a real session). Files that cannot be written stop
 *    being renewed, so they expire on their own — no write required at
 *    duress time.
 *  - the extension must prove the file is WRITABLE before showing a preview
 *    (it atomically rewrites the marker and reads it back). The unwritable
 *    state fails that gate immediately, not in seven days.
 *
 * Seven days rather than the auto-lock interval, deliberately: a messenger
 * whose previews die minutes after the phone is pocketed has no previews.
 * The deadline is the backstop for the exotic asymmetry (app cannot write,
 * extension can); the write gate is the fix for the common one.
 */
export const PREVIEW_LEASE_MS = 7 * 24 * 60 * 60 * 1000;

/** The marker's shape. Anything that does not parse to this is disarmed. */
export function armedMarker(now: number): string {
  return JSON.stringify({ v: 1, deadline: now + PREVIEW_LEASE_MS });
}

const LEVELS: readonly PreviewLevel[] = ['full', 'sender', 'none'];

export const DEFAULT_PREVIEW_LEVEL: PreviewLevel = 'sender';

/**
 * Mirrored in memory because the settings screen reads it on every render and
 * this is a file. Loaded at init and on every real unlock, exactly like the
 * read-receipt preference.
 */
let level: PreviewLevel = DEFAULT_PREVIEW_LEVEL;

export function previewLevel(): PreviewLevel {
  return level;
}

function parse(value: string | null): PreviewLevel {
  return LEVELS.includes(value as PreviewLevel)
    ? (value as PreviewLevel)
    : DEFAULT_PREVIEW_LEVEL;
}

/**
 * Re-read the persisted choice.
 *
 * A failed or unreadable read falls back to the DEFAULT rather than to `none`.
 * That looks like the wrong direction for a privacy setting, and it is worth
 * being explicit about why it is not: this value only ever governs what the
 * app shows in ITS OWN settings screen. The extension reads the file directly
 * and has its own default, so a hiccup here cannot cause a disclosure — it can
 * only make the settings screen briefly disagree with reality, and falling
 * back to `none` would tell someone their previews are off when they are not.
 */
export async function loadPreviewLevel(): Promise<void> {
  try {
    level = parse(await readSharedState(PREVIEW_LEVEL_FILE));
  } catch {
    level = DEFAULT_PREVIEW_LEVEL;
  }
}

/**
 * A COERCED TAP MOVES THE ROW AND WRITES NOTHING — the `setReadReceipts`
 * rule, and the file makes it sharper than its Keychain siblings: the
 * notification extension reads this value directly, so a coerced write would
 * change what a banner shows on the owner's own phone long after the session
 * ended, in the direction of disclosing more. The in-memory value still
 * follows the tap (rule 16) and `loadPreviewLevel` re-reads the file on every
 * REAL unlock.
 */
export async function setPreviewLevel(next: PreviewLevel): Promise<void> {
  level = next;
  if (session.mode === 'duress') return;
  await writeSharedState(PREVIEW_LEVEL_FILE, next);
}

/**
 * Say that a REAL session is open, so previews may be rendered.
 *
 * Called after a real unlock and after a launch with no lock configured —
 * never from a duress session, and never speculatively.
 */
export async function armPreviews(): Promise<void> {
  await writeSharedState(PREVIEWS_ARMED_FILE, armedMarker(Date.now()));
}

/**
 * Push the lease's deadline out again.
 *
 * Called from the AppState listener on BACKGROUNDING, and only from a real
 * session — never on foregrounding, where it would race the relock decision:
 * relock's disarm is async, and a fire-and-forget renewal issued just before
 * it could land just after and re-arm a locked app. Backgrounding has no such
 * race; the session that is backgrounding is the session the lease describes.
 */
export async function renewPreviews(): Promise<void> {
  await armPreviews();
}

/**
 * Withdraw permission to render previews.
 *
 * Called on relock and on entering the decoy workspace, and it tries TWICE by
 * two different mechanisms. Deleting is the primary route because absence is
 * the state every other failure already lands in — a crash, a restore, a fresh
 * install. Overwriting with something that is not `ARMED` is the backup,
 * because a delete and a write fail for different reasons and a container that
 * will not unlink a file is often still willing to truncate one.
 *
 * Throws only if BOTH fail, which is the caller's signal that previews may
 * still render. No caller lets that stop it: the duress path in particular
 * must reach the decoy whatever happens, because somebody is standing over the
 * phone and an unusual outcome is itself the disclosure.
 */
export async function disarmPreviews(): Promise<void> {
  try {
    await deleteSharedState(PREVIEWS_ARMED_FILE);
  } catch (err) {
    // Second, independent route to the same state. A delete and a write fail
    // for different reasons — a file the container will not unlink is often
    // still writable — so trying both is not superstition. Anything that does
    // not parse as a live lease reads as disarmed, so a '0' is as good as an
    // absence.
    await writeSharedState(PREVIEWS_ARMED_FILE, '0');
    // Reached only if the write ALSO succeeded. If it did not, its error
    // replaces this one and still propagates, which is what the caller needs:
    // both routes failed and previews may still render.
    void err;
  }
}

/**
 * A duress session shows the DEFAULT in settings, not the owner's real choice.
 *
 * Same rule as screen security and read receipts: the real preference is real
 * state and stays sealed. Nothing is rendered from a decoy session anyway —
 * `disarmPreviews` has already run — so this is only about what the settings
 * screen displays. It deliberately does NOT write the file: the owner's stored
 * choice must survive a duress session untouched.
 */
export function resetPreviewLevelForDuress(): void {
  level = DEFAULT_PREVIEW_LEVEL;
}
