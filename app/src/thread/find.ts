// Find in this conversation — the algebra.
//
// The word is FIND, never Search. The chat list's field says *Filter*
// because it makes no lookup (`ChatListScreen.tsx:753`); this makes none
// either — it reads rows already on this device and asks the server
// nothing — and the no-directory story is worth more than the familiar
// verb. "Search" stays a word this product does not use.
//
// Pure, and the db/envelope types are imported as TYPES ONLY where they
// can be. Import direction is one-way: nothing here reaches `../screens/`.
import { type MessageRow } from '../db';
import { displayText, type MentionNameResolver } from '../envelope';

/**
 * The shortest query worth asking the database for.
 *
 * One letter matches most of a conversation, which is not a result — it is
 * the whole thread with a number over it. Two is where the answer starts
 * being about the query rather than about the language.
 */
export const FIND_MIN_QUERY = 2;

/**
 * How long the field waits before it asks.
 *
 * The same 400 ms cadence the draft save uses, and for the same reason: a
 * person typing "door" should cost one query, not four. It is its own
 * constant rather than a borrowed `DRAFT_SAVE_MS` because the two are the
 * same number for different reasons, and one of them will move first.
 */
export const FIND_DEBOUNCE_MS = 400;

/**
 * How many rows the prefilter may return.
 *
 * `db.findMessages` clamps to this ceiling itself and would ignore a bigger
 * number; it is named here so the caller asks for what it can actually get.
 * These are RAW BODIES — an image or a file body carries base64 — so the
 * number is a memory budget as much as a result count.
 */
export const FIND_LIMIT = 200;

/** Whether a query is long enough to ask. Whitespace is not a letter. */
export function findQueryReady(query: string): boolean {
  return query.trim().length >= FIND_MIN_QUERY;
}

/**
 * The rows a person actually found, from the rows SQL guessed at.
 *
 * SQL IS A PREFILTER, NEVER AN ANSWER, and this is the half that makes it
 * true. A stored body is sometimes an envelope: a photo is JSON carrying a
 * base64 AES key, so `body LIKE '%door%'` matches inside key material and
 * would offer a person a "result" that is a fragment of a photo. Every row
 * is re-read through `displayText` — the same words-reader the clipboard
 * and the VoiceOver label use, which unwraps replies, mentions, room
 * wrappers and device legs — and a row survives only when the query is in
 * the WORDS.
 *
 * The comparison is locale-lowercased on both sides, so it is the authority
 * over SQL's ASCII-only folding. Order is preserved: the caller hands these
 * in newest-first and the reading counts them that way.
 *
 * `resolveName` is the thread's own author-label resolver. Without it a
 * mention's marks drop and the words stand alone — which is a narrower
 * match, never a wrong one, and never a ULID on screen.
 */
export function refineFindRows(
  rows: readonly MessageRow[],
  query: string,
  resolveName?: MentionNameResolver,
): MessageRow[] {
  const needle = query.trim().toLocaleLowerCase();
  if (needle.length === 0) return [];
  const kept: MessageRow[] = [];
  for (const row of rows) {
    const words = displayText(row.body, resolveName);
    if (words.toLocaleLowerCase().includes(needle)) kept.push(row);
  }
  return kept;
}

/**
 * The cursor after one step, CLAMPED rather than wrapped.
 *
 * A stepper that wraps silently turns "there are no more" into "here is the
 * first one again", and on a list a person is reading backwards through
 * their own history that reads as a bug. The ends are ends, and the control
 * that reached one says so by going disabled.
 */
export function stepFindCursor(
  cursor: number,
  total: number,
  delta: number,
): number {
  if (total <= 0) return 0;
  return Math.max(0, Math.min(total - 1, cursor + delta));
}
