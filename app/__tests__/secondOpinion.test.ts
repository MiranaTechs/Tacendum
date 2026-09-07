import {
  SECOND_OPINION_CONTEXT_MAX,
  buildSecondOpinionDraft,
  eligibleSecondOpinionTargetIds,
  selectedSecondOpinionTargetsAreCurrent,
} from '../src/secondOpinion';

const CLAUDE = '01M1W7QFTW6B62EZG47QXTB2RA';
const CODEX = '01M1W7QPFAXC7E1BRNNRKTJZSZ';
const GEMINI = '01M1W7QAAAAAAAAAAAAAAAAAAA';

describe('eligibleSecondOpinionTargetIds', () => {
  test('requires a current task-capable room agent other than the source', () => {
    expect(
      eligibleSecondOpinionTargetIds(CLAUDE, [
        {
          peerId: CLAUDE,
          inRoom: true,
          recognizedInRoom: true,
          tasksConfigured: true,
          owned: true,
          consent: 'undecided',
        },
        {
          peerId: CODEX,
          inRoom: true,
          recognizedInRoom: true,
          tasksConfigured: true,
          owned: true,
          consent: 'undecided',
        },
        {
          peerId: GEMINI,
          inRoom: false,
          recognizedInRoom: true,
          tasksConfigured: true,
          owned: true,
          consent: 'undecided',
        },
      ]),
    ).toEqual([CODEX]);
  });

  test('requires consent for another member’s agent but not an owned agent', () => {
    const base = {
      inRoom: true,
      recognizedInRoom: true,
      tasksConfigured: true,
      owned: false,
    } as const;
    expect(
      eligibleSecondOpinionTargetIds(CLAUDE, [
        { peerId: CODEX, ...base, consent: 'undecided' },
        { peerId: GEMINI, ...base, consent: 'consented' },
      ]),
    ).toEqual([GEMINI]);
    expect(
      eligibleSecondOpinionTargetIds(CLAUDE, [
        { peerId: CODEX, ...base, owned: true, consent: 'refused' },
      ]),
    ).toEqual([CODEX]);
  });

  test('does not infer readiness from room recognition without a task capability', () => {
    expect(
      eligibleSecondOpinionTargetIds(CLAUDE, [
        {
          peerId: CODEX,
          inRoom: true,
          recognizedInRoom: true,
          tasksConfigured: false,
          owned: true,
          consent: 'consented',
        },
      ]),
    ).toEqual([]);
  });
});

describe('buildSecondOpinionDraft', () => {
  test('builds an editable review-only mention whose ids and visible names agree', () => {
    const result = buildSecondOpinionDraft(
      [
        { peerId: CODEX, name: 'Codex' },
        { peerId: GEMINI, name: 'Gemini' },
      ],
      JSON.stringify({
        tcm: 'msg',
        text: 'Two checks need attention.',
        d: 'The first check failed in storage.test.ts.',
        ai: true,
      }),
    );

    expect(result).not.toBeNull();
    expect(result?.draft).toContain('@Codex @Gemini');
    expect(result?.draft).toContain('Please give a second opinion');
    expect(result?.draft).toContain('Review only; do not change files.');
    expect(result?.draft).toContain('Context shared:');
    expect(result?.draft).toContain('Two checks need attention.');
    expect(result?.draft).toContain(
      'Full answer:\nThe first check failed in storage.test.ts.',
    );
    expect(result?.chips).toEqual([
      { id: CODEX, name: 'Codex', start: 0, end: 6 },
      { id: GEMINI, name: 'Gemini', start: 7, end: 14 },
    ]);
  });

  test('labels a bounded excerpt instead of silently cutting long context', () => {
    const result = buildSecondOpinionDraft(
      [{ peerId: CODEX, name: 'Codex' }],
      'x'.repeat(SECOND_OPINION_CONTEXT_MAX + 50),
    );
    expect(result?.draft).toContain('Context excerpt shared:');
    expect(result?.draft).toContain('…');
    expect(result?.draft).not.toContain('Context shared:\n');
  });

  test('refuses absent targets and bodies with no readable words', () => {
    expect(buildSecondOpinionDraft([], 'answer')).toBeNull();
    expect(
      buildSecondOpinionDraft(
        [{ peerId: CODEX, name: 'Codex' }],
        JSON.stringify({ tcm: 'shot' }),
      ),
    ).toBeNull();
  });
});

describe('selectedSecondOpinionTargetsAreCurrent', () => {
  test('requires at least one selected agent and rejects any stale selection', () => {
    expect(selectedSecondOpinionTargetsAreCurrent([], [CODEX])).toBe(false);
    expect(selectedSecondOpinionTargetsAreCurrent([CODEX], [CODEX, GEMINI])).toBe(
      true,
    );
    expect(
      selectedSecondOpinionTargetsAreCurrent([CODEX, GEMINI], [CODEX]),
    ).toBe(false);
  });
});
