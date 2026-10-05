/**
 * Reading an account id that a human retyped, read aloud, or pasted out of a
 * message. There is no directory to fall back on: if the id is wrong, the chat
 * simply addresses nobody (or worse, somebody else), so every tolerance here
 * has to be a decoding rule rather than a guess.
 */

/** Account ids are ULIDs: 26 Crockford base32 characters. */
export const ID_LENGTH = 26;

/** The canonical alphabet — Crockford base32 omits I, L, O and U. */
const CANON = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** Everything outside the canonical alphabet, once folded. */
const NOT_IN_ALPHABET = /[^0-9A-HJKMNP-TV-Z]/g;

/** The characters people add to make an id readable when they pass it on. */
const SEPARATORS = /[\s\-_.,:;/|()[\]]/g;

/**
 * Anything shaped like a URI: a scheme, then a colon. `WIFI:`, `https:`,
 * `mailto:`, `otpauth:`. ONE definition, shared by the QR import path
 * (`qr.ts`, where it runs before `extractId` ever sees the payload) and the
 * paste path below — an id that only appears inside a URI is a link slug or
 * a Wi-Fi password, not an address, and a second regex written for the
 * second path is how the two would drift apart.
 *
 * Always tested on the RAW token, never a folded one: `fold` maps O→0, and
 * `otpauth:` folded starts with a digit and stops looking like a scheme.
 */
export const URI_SHAPED = /^[a-z][a-z0-9+.-]*:/i;

/**
 * Normalise the confusable characters. Crockford base32 omits I, L, O and U
 * precisely because people mistake them for 1, 1, 0 and V, so mapping them is
 * the standard decode rule and a strict widening: a correctly transcribed id
 * contains none of them, so nothing valid changes meaning.
 */
export const fold = (s: string) =>
  s.toUpperCase().replace(/O/g, '0').replace(/[IL]/g, '1');

/** Folded, with the grouping people type by hand removed and NOTHING else —
 * so a stray character survives to be reported rather than quietly deleted
 * until the id happens to look the right length. */
function compact(raw: string): string {
  return fold(raw).replace(SEPARATORS, '');
}

/**
 * The id inside whatever was typed or pasted, or null when there isn't one.
 * Accepts an id sitting in the middle of a sentence (people paste "My
 * Tacendum ID is …") and an id broken into readable groups by spaces, dashes
 * or newlines.
 */
export function extractId(raw: string): string | null {
  const folded = fold(raw);
  const embedded = folded.match(/[0-9A-HJKMNP-TV-Z]{26}/);
  if (embedded) return embedded[0];
  const bare = folded.replace(NOT_IN_ALPHABET, '');
  return CANON.test(bare) ? bare : null;
}

/** Why an id was not accepted, so the message can say something true. */
export type IdProblem = 'short' | 'long' | 'u' | 'chars';

/**
 * What is wrong with an id that `extractId` refused, or null when nothing is.
 *
 * `U` is reported rather than folded to V: it is the one confusable character
 * where guessing would silently produce a DIFFERENT valid id, and addressing
 * the wrong account is worse than asking for the id again.
 */
export function idProblem(raw: string): IdProblem | null {
  const candidate = compact(raw);
  if (candidate.includes('U')) return 'u';
  if (candidate.length < ID_LENGTH) return 'short';
  if (candidate.length > ID_LENGTH) return 'long';
  if (!CANON.test(candidate)) return 'chars';
  return null;
}

/** A token big enough to be somebody's attempt at an id, rather than a word
 * beside one: half an id. */
const ATTEMPT_MIN = ID_LENGTH / 2;

/**
 * The part of a refused field that IS the id attempt, for `idProblem` to
 * judge. Running it on the whole field reported "never contains the letter
 * U" — pointing at the word Tacendum — when the id in the sentence was merely
 * a character short.
 *
 * The whole field is the attempt unless it is longer than an id AND exactly
 * one token is id-sized: then that token is what they meant and the rest is
 * prose. An id split into groups, or into two halves, has no token that big
 * (or is not longer than an id at all), so it is still judged whole and its
 * count still counts every character they typed.
 */
export function idAttempt(raw: string): string {
  if (compact(raw).length <= ID_LENGTH) return raw;
  const sized = raw
    .split(/\s+/)
    .filter(token => compact(token).length >= ATTEMPT_MIN);
  return sized.length === 1 ? sized[0]! : raw;
}

/* ── the id as words, in both directions ───────────────────── */

/**
 * The text a share sheet sends, on every surface that shares an id.
 *
 * Three lines, the id ALONE on the second: no sentence around it, no
 * punctuation touching it. The field report was that "My Tacendum ID is
 * <26 characters>. Add me…" arrived as something the recipient had to
 * hand-edit on a phone; a line of its own is what a long-press selects whole,
 * and what `idsInPastedText` reads back as exactly one id.
 *
 * No scheme, no link, no URL-ified id — the pinned guardrail. A URL would put
 * the id where browsers open, log and sync it, and would make every Tacendum
 * message look like a link worth tapping.
 */
export function shareIdMessage(id: string): string {
  return `My Tacendum ID:\n${id}\nAdd me in Tacendum → Open a room.`;
}

export interface PastedIds {
  /** Every distinct id found outside a URI, in order of first appearance. */
  ids: string[];
  /** Nothing usable was found, but a URI-shaped token carried an id-shaped
   * run — a link slug, a Wi-Fi password. The caller refuses rather than
   * treating the paste as prose, so the person learns the id is never a
   * URL. */
  inUriOnly: boolean;
}

/**
 * The ids inside whatever a person pasted. The rules are the QR import
 * path's (`qr.ts` `idFromPayloads`), applied per whitespace token:
 *
 *  - a URI-shaped token is dropped before `extractId` sees it, because
 *    `extractId` finds a 26-character run ANYWHERE and a link or a Wi-Fi
 *    password can contain one by accident — and a false id addresses a
 *    real stranger;
 *  - every other token is asked for an id; a sentence's worth of words
 *    yields nothing, an id with a comma stuck to it yields the id;
 *  - if no token held one, the tokens together are tried once, so an id
 *    spaced into fours still reads;
 *  - the result is the DISTINCT set: the caller fills the field with one,
 *    and refuses to guess between two.
 *
 * Nothing here reads the clipboard. The caller detects a paste from the
 * shape of the change and hands over the field's new text.
 */
export function idsInPastedText(raw: string): PastedIds {
  const tokens = raw.split(/\s+/).filter(token => token !== '');
  const plain: string[] = [];
  let inUri = false;
  for (const token of tokens) {
    if (URI_SHAPED.test(token)) {
      if (extractId(token) !== null) inUri = true;
    } else {
      plain.push(token);
    }
  }
  const ids: string[] = [];
  for (const token of plain) {
    const id = extractId(token);
    if (id !== null && !ids.includes(id)) ids.push(id);
  }
  if (ids.length === 0) {
    const spaced = extractId(plain.join(' '));
    if (spaced !== null) ids.push(spaced);
  }
  return { ids, inUriOnly: ids.length === 0 && inUri };
}
