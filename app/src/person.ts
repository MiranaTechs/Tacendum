/**
 * How a person is named and pictured across the app. There is no directory:
 * a name only exists if that person chose to share it with you, so every
 * surface must degrade gracefully to the account id.
 */

/** Longest id fragment shown when someone hasn't shared a name. */
const SHORT_ID_LENGTH = 8;

/**
 * Characters a peer-chosen name may not paint on screen: C0/C1
 * controls (minus the \t..\r whitespace ones, which the collapse below
 * turns into honest spaces), the bidi embedding/override/isolate marks that
 * can reverse or reorder neighbouring text, and the zero-width space and
 * direction marks that make two identical-looking names distinct strings.
 * U+200D (zero-width joiner) is deliberately ABSENT: stripping it would
 * tear joined emoji apart.
 */
const NOISE_CLASS = [
  [0x0000, 0x0008], // C0 before the whitespace controls
  [0x000e, 0x001f], // C0 after them
  [0x007f, 0x009f], // DEL + C1
  [0x200b, 0x200b], // zero-width space
  [0x200e, 0x200f], // LRM, RLM (U+200D between them stays)
  [0x202a, 0x202e], // bidi embedding/override
  [0x2066, 0x2069], // bidi isolates
]
  .map(([lo, hi]) =>
    lo === hi
      ? String.fromCodePoint(lo!)
      : `${String.fromCodePoint(lo!)}-${String.fromCodePoint(hi!)}`,
  )
  .join('');
// Built from code points rather than written as a literal: every character
// in this class is invisible, and an invisible regex is an unreviewable one.
const NAME_NOISE = new RegExp(`[${NOISE_CLASS}]`, 'g');

/**
 * Display-time hardening for a name someone else chose. Runs where a name
 * meets a screen — and on this device's own typed labels at input — never
 * on an envelope or a stored peer card, so the bytes a peer sent stay
 * faithful in the database (the CLI's sanitizeForTerminal posture, applied
 * to screens).
 */
export function sanitizeDisplayName(raw: string | null | undefined): string {
  return (raw ?? '')
    .replace(NAME_NOISE, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Ids are ULIDs — the tail is the part that differs between people. */
export function shortId(userId: string): string {
  return userId.length <= SHORT_ID_LENGTH
    ? userId
    : `…${userId.slice(-SHORT_ID_LENGTH)}`;
}

/**
 * The name to show for a peer: the name I gave them here, else the name they
 * shared, else their short id.
 *
 * My own label outranks their card because this is my list — if I filed
 * someone as "Mum", a card update must not rename her back to "Helen R.".
 */
export function personName(
  peerId: string,
  sharedName?: string | null,
  localName?: string | null,
): string {
  // Sanitize per layer, not once at the end: a name that is ALL marks must
  // fall through to the next layer, exactly as if it were absent.
  return (
    sanitizeDisplayName(localName) ||
    sanitizeDisplayName(sharedName) ||
    shortId(peerId)
  );
}

/** Whether the peer has actually shared a name (an id fallback is not one). */
export function hasSharedName(displayName?: string | null): boolean {
  return (displayName ?? '').trim() !== '';
}

/**
 * How to refer to someone INSIDE A SENTENCE. `personName` falls back to an id
 * fragment, which reads as noise in prose ("Ask …KX7A9QZ2 to send it again");
 * here the fallback is the pronoun a person would actually use. Labels keep
 * `personName`, prose uses this.
 */
export function personRef(
  peerId: string,
  sharedName?: string | null,
  localName?: string | null,
): string {
  const name =
    sanitizeDisplayName(localName) || sanitizeDisplayName(sharedName);
  return name ? name : 'them';
}

/**
 * An id spaced out for reading aloud or for VoiceOver: single characters, with
 * a wider gap every four. Screen readers say a 26-character ULID as invented
 * words, which is unusable for the one task ids exist for — passing one to
 * another person exactly.
 */
export function spellId(id: string): string {
  return id
    .replace(/(.{4})/g, '$1 ')
    .trim()
    .split('')
    .join(' ');
}

/**
 * Monogram for the avatar disc: initials of a real name ("Maya Ruiz" → MR),
 * or two id characters when there is no name yet.
 *
 * The id fallback deliberately takes the TAIL, not the head (a documented
 * departure from the spec's "first two characters"). Account ids are ULIDs
 * whose leading characters encode registration time, so everyone who joined
 * in the same hour would wear an identical monogram — "01" for the whole
 * address book. The tail is the random half, so two people look different.
 */
export function monogram(
  peerId: string,
  sharedName?: string | null,
  localName?: string | null,
): string {
  // Same precedence as personName: the disc and the name below it must never
  // disagree about who this is.
  const name =
    sanitizeDisplayName(localName) || sanitizeDisplayName(sharedName);
  if (name) {
    const words = name.split(/\s+/).filter(Boolean);
    const letters =
      words.length > 1
        ? `${words[0]![0]}${words[words.length - 1]![0]}`
        : name.slice(0, 2);
    return letters.toUpperCase();
  }
  return (
    peerId
      .replace(/[^a-zA-Z0-9]/g, '')
      .slice(-2)
      .toUpperCase() || '?'
  );
}

/**
 * Deterministic tint index for a person without a photo, so the same person
 * always gets the same monogram color (identity you can recognize at a glance
 * without a server ever assigning one).
 */
export function tintIndex(peerId: string, buckets: number): number {
  let hash = 0;
  for (let i = 0; i < peerId.length; i++) {
    hash = (hash * 31 + peerId.charCodeAt(i)) % 100000;
  }
  return hash % buckets;
}
