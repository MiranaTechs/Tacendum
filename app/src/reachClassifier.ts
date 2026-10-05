import { EmailIdentifier, normalizeEmailIdentifier } from '@tacendum/shared';
import {
  extractId,
  fold,
  idAttempt,
  idProblem,
  URI_SHAPED,
  type IdProblem,
} from './peerId';

/**
 * What Open a room's one field was given: a Tacendum ID, a handle (the
 * find-by-name class), an email, or none of those yet — worked out from the
 * shape of the text alone, before anything is looked up, so the field can say
 * which and offer the one action that can succeed.
 *
 * Pure on purpose: no react-native, no api, no db. The handle validator is
 * INJECTED (the screen passes the shared one while that class is live, and
 * null while it is dark), so this module owns no class-specific rule and the
 * classifier and its suite run as plain data.
 *
 * The order of the rules is the safety argument, because `extractId` finds a
 * 26-character run ANYWHERE in a string:
 *
 *  1. a link is never an ID or an email, even when an ID-sized slug sits in
 *     it, even inside typed prose, and even wrapped in brackets or quotes
 *     ("<https://…>", Markdown's "[text](https://…)") — a slug offered for
 *     Start chat would address a stranger;
 *  2. an `@` after the first character is an email, before any ID rule — a
 *     long address used to make up an ID out of its letters;
 *  3. a leading `@` is a handle;
 *  4. an ID is judged on the RAW text (`fold` maps O to 0, so "oliver" would
 *     otherwise read as 011VER…), and an unbroken run of more than 26 ID
 *     characters is TOO LONG, never trimmed: one extra character at the start
 *     or in the middle is somebody else's ID;
 *  5. a letter-led word is a handle, and anything else is unknown.
 */

/** Who "you" are on this device, for the "That's you" check. */
export interface SelfKeys {
  /** profile.userId, canonical. */
  userId: string;
  /** VERIFIED emails only, already normalized. A pending one may be a typo
   * of somebody else's address. */
  emails: readonly string[];
  /** The claimed handle, normalized; null when there is none or the class
   * is dark. */
  handle: string | null;
}

export type Reach =
  | { kind: 'empty' }
  | { kind: 'id'; id: string | null; count: number; problem: IdProblem | null; self: boolean }
  | { kind: 'handle'; label: string; normalized: string | null; self: boolean }
  | { kind: 'email'; label: string; valid: boolean; self: boolean }
  | { kind: 'unknown' };

export interface ClassifyOptions {
  /** The handle validator, or null while that class is dark: then nothing is
   * ever classified as a handle. */
  handleShape: ((raw: string) => string | null) | null;
}

/** The grouping people add when they pass an ID on — a local copy of the set
 * peerId.ts keeps private (that file stays unchanged). */
const GROUPING = /[\s\-_.,:;/|()[\]]/g;
const LEADING_GROUPING = /^[\s\-_.,:;/|()[\]]+/;
const MAILTO = /^mailto:/i;
/** A handle as typed: a letter, then letters, digits or underscores. */
const HANDLE_WORD = /^[A-Za-z][A-Za-z0-9_]*$/;
/** The brackets and quotes a link travels in: "<https://…>", "(https://…)",
 * "\"https://…\"", Markdown's "[text](https://…)", an HTML href="…". */
const WRAPPERS = /[<>()[\]{}"'`]+/;
/** A scheme with its two slashes anywhere in a token: "href=https://…". */
const SCHEME_SLASHES = /[a-z][a-z0-9+.-]*:\/\//i;

/** The longest unbroken run of letters and digits, after the fold. */
function longestRun(text: string): number {
  return fold(text)
    .split(/[^0-9A-Z]+/)
    .reduce((longest, run) => Math.max(longest, run.length), 0);
}

/** Characters as counted against 26: folded, grouping removed, nothing else
 * dropped, so a stray character is counted rather than hidden. */
function compactLength(text: string): number {
  return fold(text).replace(GROUPING, '').length;
}

function emailValid(label: string): boolean {
  return EmailIdentifier.safeParse(normalizeEmailIdentifier(label)).success;
}

/**
 * Whether a token carries a link: it, or any piece of it between brackets or
 * quotes, starts with a scheme, or a scheme and its slashes sit anywhere in
 * it. Testing only the token's own start let a wrapped link through, and its
 * slug read as a complete ID. `mailto:` counts only when `mailto` is set.
 */
function hasScheme(token: string, mailto: boolean): boolean {
  if (SCHEME_SLASHES.test(token)) return true;
  return token
    .split(WRAPPERS)
    .some(piece => URI_SHAPED.test(piece) && (mailto || !MAILTO.test(piece)));
}

function isLink(text: string): boolean {
  if (text.split(/\s+/).some(token => hasScheme(token, false) && extractId(token) !== null)) {
    return true;
  }
  return !/\s/.test(text) && hasScheme(text, false);
}

function handleReach(
  label: string,
  handleShape: (raw: string) => string | null,
  mine: SelfKeys,
): Reach {
  const normalized = label === '' ? null : handleShape(label);
  return {
    kind: 'handle',
    label,
    normalized,
    self: normalized !== null && normalized === mine.handle,
  };
}

export function classifyReach(raw: string, mine: SelfKeys, opts: ClassifyOptions): Reach {
  const text = raw.trim();
  if (text === '') return { kind: 'empty' };

  // 1. A link, anywhere in the entry. "ID: <id>" (a label, then a space) is
  // not a link; "ID:<id>" with no space is, like any scheme glued to an ID.
  if (isLink(text)) return { kind: 'unknown' };

  // 2. An email: an @ that is not the first character.
  if (text.indexOf('@') > 0) {
    const label = text.replace(MAILTO, '');
    const valid = emailValid(label);
    return {
      kind: 'email',
      label,
      valid,
      self: valid && mine.emails.includes(normalizeEmailIdentifier(label)),
    };
  }

  // 3. A leading @ is a handle, when that class is live.
  if (text.startsWith('@')) {
    if (opts.handleShape === null) return { kind: 'unknown' };
    return handleReach(text.slice(1).trim(), opts.handleShape, mine);
  }

  // 4. An ID: digit-led in the RAW text, or a 0-7-led ID whose run is
  // exactly 26 (so "O1BX…" typed with the letter O reads once it is whole,
  // and no name of 27 to 32 letters ever reads as an over-long ID).
  const attempt = idAttempt(text);
  const firstCharacter = attempt.replace(LEADING_GROUPING, '').charAt(0);
  const digitLed = /[0-9]/.test(firstCharacter);
  const run = longestRun(attempt);
  const whole = extractId(text);
  const wholeOk = whole !== null && /^[0-7]/.test(whole) && run === 26;
  if (digitLed || wholeOk) {
    if (run > 26) {
      return {
        kind: 'id',
        id: null,
        count: compactLength(attempt),
        problem: idProblem(attempt),
        self: false,
      };
    }
    const id = extractId(attempt) ?? (wholeOk ? whole : null);
    return {
      kind: 'id',
      id,
      count: id !== null ? 26 : compactLength(attempt),
      problem: id !== null ? null : idProblem(attempt),
      self: id !== null && id === mine.userId,
    };
  }

  // 5. A letter-led word is a handle, when that class is live.
  if (opts.handleShape !== null && HANDLE_WORD.test(text)) {
    return handleReach(text, opts.handleShape, mine);
  }

  return { kind: 'unknown' };
}

/* ── the gated paste reader ──────────────────────────────────────────── */

export interface SmartPaste {
  /** Every distinct ID read, in order of first appearance (your own ID
   * already dropped when exactly one other is beside it). */
  ids: string[];
  /** Nothing usable, but a link carried an ID-sized run: refuse as a link. */
  inUriOnly: boolean;
  /** No ID, but exactly one email (or, with handles live, one @handle)
   * token: what to put in the field instead of the whole paste. */
  fill: string | null;
}

const EMAIL_TOKEN = /^[^\s@:/]+@[^\s@:/]+$/;
const HANDLE_TOKEN = /^@[A-Za-z][A-Za-z0-9_]*$/;

function firstAlphanumeric(text: string): string {
  return text.match(/[0-9A-Za-z]/)?.[0] ?? '';
}

/**
 * The IDs inside a paste, under peerId.ts's paste rules plus three gates.
 * A token carrying a link is set aside as a link, wrapped in brackets or
 * quotes included (`hasScheme`), where peerId.ts tests only its first
 * character.
 *
 *  1. a token holding an @ (an email, a handle) never yields an ID;
 *  2. an ID counts only when its first character in the raw text is a digit
 *     0-7 (every server-minted ULID starts there), so a long name never
 *     makes one up;
 *  3. no 26-character run is ever trimmed out of a longer one.
 *
 * Then two rules for what a paste can still fill: your own ID beside exactly
 * one other fills the other (a forwarded thread carries both), and a paste
 * with no ID fills its one email or @handle token. The clipboard is never
 * read: the caller hands over the field's new text.
 */
export function smartPastedIds(
  raw: string,
  selfId: string | null,
  handleShape: ((raw: string) => string | null) | null,
): SmartPaste {
  const tokens = raw.split(/\s+/).filter(token => token !== '');
  const plain: string[] = [];
  let inUri = false;
  for (const token of tokens) {
    if (hasScheme(token, true)) {
      if (extractId(token) !== null) inUri = true;
      continue;
    }
    if (token.includes('@')) continue;
    plain.push(token);
  }

  let ids: string[] = [];
  for (const token of plain) {
    if (longestRun(token) > 26) continue;
    const id = extractId(token);
    if (id === null) continue;
    // fold is length-preserving, so the index matches the raw token.
    const at = fold(token).indexOf(id);
    const first = at >= 0 ? token.charAt(at) : firstAlphanumeric(token);
    if (!/[0-7]/.test(first)) continue;
    if (!ids.includes(id)) ids.push(id);
  }
  if (ids.length === 0 && plain.length > 0) {
    // An ID spaced into fours has no single token big enough.
    const joined = plain.join(' ');
    const spaced = extractId(joined);
    if (spaced !== null && longestRun(joined) <= 26 && /[0-7]/.test(firstAlphanumeric(joined))) {
      ids.push(spaced);
    }
  }
  if (ids.length > 1) ids = ids.filter(id => id !== selfId);

  let fill: string | null = null;
  if (ids.length === 0 && !inUri) {
    const candidates: string[] = [];
    for (const token of tokens) {
      const email = token
        .replace(MAILTO, '')
        .replace(/^[<(["']+/, '')
        .replace(/[>)\]"'.,;:!?]+$/, '');
      if (EMAIL_TOKEN.test(email) && emailValid(email)) {
        candidates.push(email);
        continue;
      }
      const handle = token.replace(/^[(["']+/, '').replace(/[)\]"'.,;:!?]+$/, '');
      if (handleShape !== null && HANDLE_TOKEN.test(handle) && handleShape(handle.slice(1)) !== null) {
        candidates.push(handle);
      }
    }
    const distinct = Array.from(new Set(candidates));
    if (distinct.length === 1 && distinct[0] !== raw.trim()) fill = distinct[0]!;
  }

  return { ids, inUriOnly: ids.length === 0 && inUri, fill };
}

/* ── small helpers the screen shares ─────────────────────────────────── */

/**
 * What one change inserted: the new text between the longest shared prefix
 * and the longest shared suffix that does not overlap it. A change is a
 * paste when this is longer than one character, so select-all and paste over
 * a longer grouped value still reads as a paste, and a keystroke never does.
 */
export function insertedRun(prev: string, next: string): string {
  let start = 0;
  const limit = Math.min(prev.length, next.length);
  while (start < limit && prev.charAt(start) === next.charAt(start)) start += 1;
  let endPrev = prev.length;
  let endNext = next.length;
  while (endPrev > start && endNext > start && prev.charAt(endPrev - 1) === next.charAt(endNext - 1)) {
    endPrev -= 1;
    endNext -= 1;
  }
  return next.slice(start, endNext);
}

/** An ID in fours, the way one person reads it to another. */
export function groupId(id: string): string {
  return id.match(/.{1,4}/g)?.join(' ') ?? id;
}

/** The same groups on two lines, four then three — the layout of the other
 * person's My ID, so the two can be compared line for line at any width. */
export function groupIdLines(id: string): string {
  const groups = id.match(/.{1,4}/g) ?? [id];
  if (groups.length <= 4) return groups.join(' ');
  return `${groups.slice(0, 4).join(' ')}\n${groups.slice(4).join(' ')}`;
}
