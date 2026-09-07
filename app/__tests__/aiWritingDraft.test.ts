import { isSafeWritingText, maskWritingMentions, sameWritingDraft, type WritingDraftSnapshot } from '../src/aiWritingDraft';

describe('private writing draft identity', () => {
  const text = 'Hi @Ana and @Ana — ሰላም 👋';
  const chips = [
    { id: 'first', name: 'Ana', start: 3, end: 7 },
    { id: 'second', name: 'Ana', start: 12, end: 16 },
  ];
  it('keeps names and IDs local and reconstructs offsets for duplicate names', () => {
    const masked = maskWritingMentions(text, chips)!;
    expect(masked.draft).not.toContain('Ana');
    expect(masked.draft).not.toContain('first');
    const result = masked.restore(masked.draft.replace('Hi ', 'Hello, '))!;
    expect(result.text).toBe('Hello, @Ana and @Ana — ሰላም 👋');
    expect(result.chips.map(c => [c.id, c.start, c.end])).toEqual([
      ['first', 7, 11], ['second', 16, 20],
    ]);
  });
  it.each(['missing', 'duplicate', 'reordered', 'unknown'])('refuses %s identity tokens', kind => {
    const masked = maskWritingMentions(text, chips)!;
    const [a, b] = masked.draft.match(/\[\[TACENDUM_MENTION_\d+_\d+\]\]/g)!;
    const bad = kind === 'missing' ? masked.draft.replace(a!, '') :
      kind === 'duplicate' ? masked.draft + a :
        kind === 'reordered' ? `${b} and ${a}` : masked.draft + '[[TACENDUM_MENTION_0_7]]';
    expect(masked.restore(bad)).toBeNull();
  });
  it('chooses a namespace absent from the input', () => {
    const original = '[[TACENDUM_MENTION_0_0]] @Ana';
    const masked = maskWritingMentions(original, [{ id: 'first', name: 'Ana', start: 0, end: 4 }]);
    // Invalid ranges never grant mention authority.
    expect(masked).toBeNull();
    const start = original.indexOf('@');
    const valid = maskWritingMentions(original, [{ id: 'first', name: 'Ana', start, end: start + 4 }])!;
    expect(valid.draft).toContain('[[TACENDUM_MENTION_1_0]]');
    expect(valid.restore(valid.draft)?.text).toBe(original);
  });
  it.each(['\uFFFC', '{"tcm":1,"kind":"profile"}', '{"note":"ok","tcm":1}', '  '])('rejects unsafe output', value => {
    expect(isSafeWritingText(value)).toBe(false);
  });
  it('does not grant a newly written @name a mention ID', () => {
    expect(maskWritingMentions('Hello', [])!.restore('Hello @Ana'))
      .toEqual({ text: 'Hello @Ana', chips: [] });
  });
  const snapshot: WritingDraftSnapshot = {
    peerId: 'room', text, chips, pending: 'reply:message', revision: 3, providerRevision: 5,
  };
  it.each([
    { peerId: 'other' }, { text: text + '!' }, { pending: null },
    { revision: 4 }, { providerRevision: 6 },
    { chips: [{ ...chips[0]!, id: 'someone-else' }, chips[1]!] },
  ])('rejects a changed snapshot %o', patch => {
    expect(sameWritingDraft(snapshot, { ...snapshot, ...patch })).toBe(false);
  });
  it('accepts only an identical snapshot', () => {
    expect(sameWritingDraft(snapshot, { ...snapshot, chips: chips.map(c => ({ ...c })) })).toBe(true);
  });
});
