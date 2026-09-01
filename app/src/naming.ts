import * as db from './db';
import { messaging } from './messaging';
import { sanitizeDisplayName } from './person';

/**
 * The naming moment — the module half, shared by the
 * post-registration step (NamingScreen) and the chat list's one-time nudge.
 *
 * Closes a gap (registration mints `displayName ''`, `profileVersion 0`, and
 * nothing ever prompted) WITHOUT a new layer: the name rides the existing
 * `ProfileEnvelope` through the existing `messaging.saveProfile`, and the
 * fan-out is the existing lazy `chatsMissingMyProfile` machinery — no new
 * sync, no wire change, no server coupling (no build pin).
 *
 * Two facts the two surfaces share:
 *
 *  - SETTLED is a durable, workspace-scoped answer (`profile` kv, the
 *    blockedMirrorDirty discipline): a name OR a "Not now" settles it, so the
 *    nudge shows once and never again. A duress session's answer lands in the
 *    decoy file, because `conn()` already points there —
 *    saveProfile's own duress branch does the same for the card.
 *  - The typed name is sanitized AT INPUT, the standing regime for this device's
 *    own labels (localName follows the same rule): the bytes a person types
 *    are theirs, but a bidi override or a zero-width run is not a name.
 */

/** The bound `ProfileEnvelope.n` enforces on the wire (envelope.ts). */
export const NAME_MAX = 40;

/**
 * What the step will actually save: sanitized, one line, within the bound.
 *
 * The bound is counted in UTF-16 units — the unit `ProfileEnvelope.n`'s
 * max(40) counts — but the cut lands on a CODE-POINT boundary: `slice`
 * through a surrogate pair (an emoji at the tail, reachable by paste or IME
 * past the field's own maxLength) would save a lone surrogate, which
 * encodes as U+FFFD on the wire and paints as a replacement glyph on every
 * peer. So: the longest code-point-aligned prefix that fits.
 */
export function normalizeName(raw: string): string {
  const clean = sanitizeDisplayName(raw);
  let fitted = '';
  for (const char of clean) {
    if (fitted.length + char.length > NAME_MAX) break;
    fitted += char;
  }
  return fitted.trim();
}

/** The nudge is owed to a nameless account that has never answered. */
export function namingNudgeDue(
  profile: Pick<db.ProfileRow, 'displayName'>,
  settled: boolean,
): boolean {
  return profile.displayName === '' && !settled;
}

export function isNamingSettled(): Promise<boolean> {
  return db.getNamingSettled();
}

/** "Not now": nothing minted, nothing shared — only the answer is kept. */
export async function skipNaming(): Promise<void> {
  await db.setNamingSettled();
}

/**
 * Save the name through the existing card path. About and avatar pass
 * through UNCHANGED from the row the caller holds: on a fresh registration
 * both are '' (the spec's `about:'', avatarB64:''`), and on the nudge path
 * an existing account may already carry a photo it must not lose. Settles
 * only after the local write landed, so a failed save leaves the nudge owed.
 * Returns null — and saves nothing — when the input sanitizes to nothing.
 */
export async function submitName(
  profile: Pick<db.ProfileRow, 'about' | 'avatarB64'>,
  raw: string,
): Promise<db.ProfileRow | null> {
  const displayName = normalizeName(raw);
  if (displayName === '') return null;
  const saved = await messaging.saveProfile({
    displayName,
    about: profile.about,
    avatarB64: profile.avatarB64,
  });
  await db.setNamingSettled();
  return saved;
}
