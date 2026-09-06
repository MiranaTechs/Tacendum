/**
 * The compose-side mention algebra, tested DIRECTLY for the first time
 *. Every one of these functions has lived
 * inside an 8,841-line screen since it was written, reachable only through a
 * mounted thread; this file asks them the questions the mount cannot.
 *
 * THE INVARIANT UNDER TEST: the wire's marks and its `who` ids are produced
 * by ONE walk, so the Nth mark is the Nth id by construction — and a chip the
 * person edited into is no longer a mention, so the visible text can never
 * name someone the ids do not, or the other way round.
 *
 * Falsifier (CONTRIBUTING.md:76-80): each block below was run against a
 * deliberately broken predicate before it was believed — see the commit body.
 */
import { MENTION_MARK } from '../src/envelope';
import {
  caretAfterEdit,
  liveMentionChips,
  mentionQueryAt,
  mentionWire,
  namesInSentence,
  shiftMentionChips,
  type MentionChip,
} from '../src/thread/mentions';

/** `@Ana` at 0..4 in 'Hi @Ana there' would be start 3, end 7. */
const chipFor = (draft: string, id: string, name: string): MentionChip => {
  const start = draft.indexOf(`@${name}`);
  return { id, name, start, end: start + 1 + name.length };
};

describe('shiftMentionChips carries chips across one edit', () => {
  test('a chip wholly before the edit keeps its place', () => {
    const prev = 'Hi @Ana there';
    const chip = chipFor(prev, 'u-ana', 'Ana');
    const next = 'Hi @Ana there!';
    expect(shiftMentionChips(prev, next, [chip])).toEqual([chip]);
  });

  test('a chip wholly after the edit shifts by the delta, both ways', () => {
    const prev = 'ok @Ana';
    const chip = chipFor(prev, 'u-ana', 'Ana');
    const inserted = shiftMentionChips(prev, 'okay @Ana', [chip]);
    expect(inserted).toEqual([{ ...chip, start: chip.start + 2, end: chip.end + 2 }]);
    // A deletion is the same arithmetic with a negative delta.
    const deleted = shiftMentionChips(prev, 'o @Ana', [chip]);
    expect(deleted).toEqual([{ ...chip, start: chip.start - 1, end: chip.end - 1 }]);
  });

  test('a chip the edit cut INTO stops being a mention', () => {
    const prev = 'Hi @Ana there';
    const chip = chipFor(prev, 'u-ana', 'Ana');
    // A backspace inside the name: what survives is plain visible text.
    expect(shiftMentionChips(prev, 'Hi @An there', [chip])).toEqual([]);
  });

  test('an unchanged draft returns the chips untouched', () => {
    const prev = 'Hi @Ana';
    const chips = [chipFor(prev, 'u-ana', 'Ana')];
    expect(shiftMentionChips(prev, prev, chips)).toBe(chips);
  });
});

describe('liveMentionChips is the gate every consumer goes through', () => {
  test('a chip whose span no longer reads @name is dropped', () => {
    const draft = 'Hi Ben there';
    const stale: MentionChip = { id: 'u-ana', name: 'Ana', start: 3, end: 7 };
    expect(liveMentionChips(draft, [stale])).toEqual([]);
  });

  test('surviving chips come back sorted by position', () => {
    const draft = 'Hi @Ben and @Ana';
    const ana = chipFor(draft, 'u-ana', 'Ana');
    const ben = chipFor(draft, 'u-ben', 'Ben');
    expect(liveMentionChips(draft, [ana, ben])).toEqual([ben, ana]);
  });

  test('a chip running past the end of the draft is dropped, not read', () => {
    expect(
      liveMentionChips('Hi', [{ id: 'u-ana', name: 'Ana', start: 0, end: 40 }]),
    ).toEqual([]);
  });
});

describe('mentionQueryAt finds the query the caret is completing', () => {
  test('the caret after "@An" is completing "An"', () => {
    expect(mentionQueryAt('Hi @An', 6, [])).toEqual({ at: 3, query: 'An' });
  });

  test('a bare "@" at a word boundary opens the picker with an empty query', () => {
    expect(mentionQueryAt('Hi @', 4, [])).toEqual({ at: 3, query: '' });
  });

  test('an address is not a summons — a@b never opens the picker', () => {
    expect(mentionQueryAt('mail a@b', 8, [])).toBeNull();
  });

  test('a newline between the "@" and the caret ends the query', () => {
    expect(mentionQueryAt('@Ana\nhello', 10, [])).toBeNull();
  });

  test('the picker never reopens from inside a settled chip', () => {
    const draft = 'Hi @Ana';
    const chip = chipFor(draft, 'u-ana', 'Ana');
    expect(mentionQueryAt(draft, draft.length, [chip])).toBeNull();
  });

  test('a null caret is not a query', () => {
    expect(mentionQueryAt('Hi @An', null, [])).toBeNull();
  });
});

describe('mentionWire emits ids only, in one walk', () => {
  test('the Nth mark is the Nth id, and no name reaches the wire', () => {
    const draft = 'Hi @Ben and @Ana, lunch?';
    const chips = [
      chipFor(draft, 'u-ben', 'Ben'),
      chipFor(draft, 'u-ana', 'Ana'),
    ];
    const wire = mentionWire(draft, chips);
    expect(wire.who).toEqual(['u-ben', 'u-ana']);
    expect(wire.text).toBe(`Hi ${MENTION_MARK} and ${MENTION_MARK}, lunch?`);
    // THE point of the chip model: the name I have for someone is mine.
    expect(wire.text).not.toContain('Ben');
    expect(wire.text).not.toContain('Ana');
    expect(wire.text.split(MENTION_MARK).length - 1).toBe(wire.who.length);
  });

  test('a literal mark the person pasted in is stripped, so marks can never outnumber ids', () => {
    const draft = `pasted ${MENTION_MARK} then @Ana`;
    const wire = mentionWire(draft, [chipFor(draft, 'u-ana', 'Ana')]);
    expect(wire.who).toEqual(['u-ana']);
    expect(wire.text.split(MENTION_MARK).length - 1).toBe(1);
  });

  test('a stale chip degrades to plain text rather than mentioning a stranger', () => {
    const draft = 'Hi Ben there';
    const stale: MentionChip = { id: 'u-ana', name: 'Ana', start: 3, end: 7 };
    expect(mentionWire(draft, [stale])).toEqual({ text: 'Hi Ben there', who: [] });
  });

  test('no chips is the plain draft, trimmed', () => {
    expect(mentionWire('  just words  ', [])).toEqual({
      text: 'just words',
      who: [],
    });
  });
});

describe('caretAfterEdit lands at the end of what was inserted', () => {
  test('typing at the end', () => {
    expect(caretAfterEdit('Hi', 'Hi t')).toBe(4);
  });

  test('an insertion in the middle lands after the inserted run', () => {
    // 'big ' went in at 3, so the caret is at 7 — not at the start of it.
    expect(caretAfterEdit('Hi there', 'Hi big there')).toBe(7);
  });

  test('a deletion lands where the cut ended', () => {
    expect(caretAfterEdit('Hi there', 'Hi ere')).toBe(3);
  });
});

describe('namesInSentence reads a list the way a person says it', () => {
  test('none, one, two, three', () => {
    expect(namesInSentence([])).toBe('');
    expect(namesInSentence(['you'])).toBe('you');
    expect(namesInSentence(['you', 'Ana'])).toBe('you and Ana');
    expect(namesInSentence(['Ana', 'Ben', 'you'])).toBe('Ana, Ben and you');
  });
});
