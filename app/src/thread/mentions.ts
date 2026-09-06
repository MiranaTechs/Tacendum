// The compose-side mention model, lifted out of ChatThreadScreen.tsx verbatim
// with pure text arithmetic: a draft, a caret
// and an array of chips in, the same three plus the wire form out. No state,
// no theme, no render — and `thread.mentions.test.ts` is the first direct
// coverage it has ever had.
//
// Import direction is one-way: constants and the wire's own mark, nothing
// from `../screens/`.
import { MENTION_MARK } from '../envelope';
import { MENTION_QUERY_MAX } from './constants';

// --- @-mentions: the compose-side model ---------
//
// THE INVARIANT THIS BLOCK EXISTS TO HOLD: the wire's `text` marks and its
// `who` ids are NEVER produced separately. `mentionWire` derives both in one
// left-to-right walk over one array of chips, so the Nth mark and the Nth id
// come from the same chip by construction — the UI cannot produce the
// mismatch that compose refuses, because there is no second bookkeeping to
// fall out of step.
//
// A chip records the exact characters it stands behind (`@` + the name this
// phone showed at pick time). It is only ever BELIEVED after re-validation
// against the draft (`liveMentionChips`), so every programmatic draft write —
// the post-send clear, the saved-draft load, an edit borrowing the composer —
// degrades stale chips to plain visible text instead of silently mentioning
// whoever used to be at that offset. Person-made edits go through
// `shiftMentionChips`, which keeps chips the edit did not touch and drops any
// chip the edit cut into: what survives is exactly what the person can see.

/** One live mention in the composer: WHO, and the exact span of draft text
 * (`@` + the name this phone showed) standing in for them. */
export interface MentionChip {
  id: string;
  /** The name as shown at pick time — matching text, never wire content. */
  name: string;
  /** Index of the '@' in the draft. */
  start: number;
  /** Exclusive end of the token (start + 1 + name.length). */
  end: number;
}

/** The one contiguous span an edit changed: common prefix `p`, common suffix
 * `s`, computed so they never overlap. One text event is one contiguous
 * replacement — typing, deletion, paste and autocorrect all fit it. */
function editSpan(prev: string, next: string): { p: number; s: number } {
  const max = Math.min(prev.length, next.length);
  let p = 0;
  while (p < max && prev[p] === next[p]) p += 1;
  let s = 0;
  while (
    s < max - p &&
    prev[prev.length - 1 - s] === next[next.length - 1 - s]
  ) {
    s += 1;
  }
  return { p, s };
}

/** Where the caret lands after an edit: the end of what was just inserted.
 * Lets the picker follow typing on the keystroke itself, before the input's
 * own selection event confirms it. */
export function caretAfterEdit(prev: string, next: string): number {
  return next.length - editSpan(prev, next).s;
}

/**
 * Carry chips across one text edit. A chip wholly before the change keeps its
 * place; wholly after, it shifts by the edit's delta; a chip the edit CUT
 * INTO stops being a mention — its surviving characters stay in the draft as
 * the plain text the person just made of them, visibly no longer a chip.
 */
export function shiftMentionChips(
  prev: string,
  next: string,
  chips: MentionChip[],
): MentionChip[] {
  if (prev === next) return chips;
  const { p, s } = editSpan(prev, next);
  const changedEnd = prev.length - s;
  const delta = next.length - prev.length;
  const out: MentionChip[] = [];
  for (const chip of chips) {
    if (chip.end <= p) {
      out.push(chip);
    } else if (chip.start >= changedEnd) {
      out.push({ ...chip, start: chip.start + delta, end: chip.end + delta });
    }
    // else: the edit reached into the token — no longer a mention.
  }
  return out;
}

/**
 * The chips the draft still actually carries: each span must read exactly
 * `@name`, in order. THE GATE every consumer goes through — the strip, the
 * picker's arithmetic and the send path all see only what survives this, so
 * a draft rewritten around the chips can degrade a mention to plain text but
 * can never mention someone the visible text does not name.
 */
export function liveMentionChips(
  draft: string,
  chips: MentionChip[],
): MentionChip[] {
  return chips
    .filter(
      chip =>
        chip.start >= 0 &&
        chip.end <= draft.length &&
        draft.slice(chip.start, chip.end) === `@${chip.name}`,
    )
    .sort((a, b) => a.start - b.start);
}

/**
 * The active @-query at the caret, or null when the caret is not completing
 * one. An '@' triggers only on a word boundary — `a@b` is an address, not a
 * summons — and never from inside an already-settled chip, so the picker
 * does not reopen over a mention that is finished.
 */
export function mentionQueryAt(
  draft: string,
  caret: number | null,
  chips: MentionChip[],
): { at: number; query: string } | null {
  if (caret === null) return null;
  const end = Math.max(0, Math.min(caret, draft.length));
  for (let i = end - 1; i >= 0 && end - i <= MENTION_QUERY_MAX + 1; i -= 1) {
    const ch = draft[i]!;
    if (ch === '\n') return null;
    if (ch !== '@') continue;
    if (i > 0 && !/\s/.test(draft[i - 1]!)) return null;
    if (chips.some(chip => i >= chip.start && i < chip.end)) return null;
    return { at: i, query: draft.slice(i + 1, end) };
  }
  return null;
}

/**
 * The wire form: one MENTION_MARK where each chip stood, `who` in the SAME
 * order, both from ONE walk (the invariant above). Literal U+FFFC characters
 * a person pasted into the plain text are stripped — a mark the walk did not
 * put there is the one way marks could outnumber ids, and compose refusing
 * that mismatch is only safe because this function makes it unreachable.
 */
export function mentionWire(
  draft: string,
  chips: MentionChip[],
): { text: string; who: string[] } {
  const who: string[] = [];
  let text = '';
  let pos = 0;
  for (const chip of liveMentionChips(draft, chips)) {
    text += draft.slice(pos, chip.start).split(MENTION_MARK).join('');
    text += MENTION_MARK;
    who.push(chip.id);
    pos = chip.end;
  }
  text += draft.slice(pos).split(MENTION_MARK).join('');
  return { text: text.trim(), who };
}

/** 'you' / 'you and Ana' / 'Ana, Ben and you' — the label clause's list. */
export function namesInSentence(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
