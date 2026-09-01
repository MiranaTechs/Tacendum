import { themeTokens } from '../src/theme';
import {
  SAFETY_COPY,
  SAFETY_EXPLAINER,
  SAFETY_STATUS,
  safetyGroups,
  safetyStateFor,
  spokenSafetyNumber,
} from '../src/safety';

/**
 * The safety state machine decides whether the app tells someone their
 * conversation is fine or that it may be intercepted, so its precedence is a
 * security property and not a presentation detail. Pure module, no mocks.
 */

const NUMBER = '457821234567890123456789012345678901234567890123456789012345';

describe('safetyStateFor precedence', () => {
  const base = {
    blocked: false,
    safety: NUMBER,
    checkedAt: null as number | null,
    mismatchAt: null as number | null,
  };

  it('ranks a pending identity change above every other finding', () => {
    expect(
      safetyStateFor({
        ...base,
        blocked: true,
        checkedAt: 1,
        mismatchAt: 2,
      }),
    ).toBe('changed');
  });

  it('ranks a recorded mismatch above a recorded match', () => {
    expect(safetyStateFor({ ...base, checkedAt: 1, mismatchAt: 2 })).toBe(
      'mismatched',
    );
  });

  it('reports a mismatch even before a session exists', () => {
    expect(safetyStateFor({ ...base, safety: null, mismatchAt: 2 })).toBe(
      'mismatched',
    );
  });

  it('reports no number when there is no session', () => {
    expect(safetyStateFor({ ...base, safety: null })).toBe('none');
    expect(safetyStateFor({ ...base, safety: '' })).toBe('none');
  });

  it('reports a match only from a local record', () => {
    expect(safetyStateFor({ ...base, checkedAt: 1 })).toBe('matched');
  });

  it('falls back to unchecked', () => {
    expect(safetyStateFor(base)).toBe('unchecked');
  });
});

describe('safety number presentation', () => {
  it('splits a 60-digit number into twelve five-digit groups', () => {
    const groups = safetyGroups(NUMBER);
    expect(groups).toHaveLength(12);
    expect(groups.every(g => g.length === 5)).toBe(true);
    expect(groups.join('')).toBe(NUMBER);
  });

  it('has no groups for an empty number', () => {
    expect(safetyGroups('')).toEqual([]);
  });

  it('spells digits out so VoiceOver cannot say a group as one quantity', () => {
    const spoken = spokenSafetyNumber(NUMBER);
    expect(spoken.startsWith('Group 1: 4 5 7 8 2.')).toBe(true);
    expect(spoken).toContain('Group 12: 1 2 3 4 5.');
    // Every group is spelled out, so nothing is left for the synthesiser to
    // read as a quantity.
    expect(spoken.split('Group ')).toHaveLength(13);
  });
});

describe('copy deck', () => {
  it('names the person in prose and never leaves a placeholder behind', () => {
    for (const state of Object.keys(
      SAFETY_COPY,
    ) as (keyof typeof SAFETY_COPY)[]) {
      const body = SAFETY_COPY[state].body('Maya', 'Today');
      expect(body).not.toContain('{');
      expect(body.length).toBeGreaterThan(0);
    }
    expect(SAFETY_COPY.none.body('Maya')).toContain('Maya');
    expect(SAFETY_COPY.matched.body('Maya', 'Today')).toContain('on Today');
    expect(SAFETY_COPY.matched.body('Maya')).not.toContain('undefined');
    expect(SAFETY_COPY.changed.title?.('Maya')).toBe(
      'Maya’s safety number changed.',
    );
  });

  it('offers an action in every state that has something to do', () => {
    expect(SAFETY_COPY.none.action).toBeNull();
    expect(SAFETY_COPY.unchecked.action).toBe('They match');
    expect(SAFETY_COPY.matched.action).toBe('Compare again');
    expect(SAFETY_COPY.mismatched.action).toBe('Compare again');
    expect(SAFETY_COPY.changed.action).toBe('Accept change');
  });

  it('gives every state a rule and an ink, and explains what the number is', () => {
    // The module names theme tokens rather than restating hexes, so the
    // palette has one definition. Assert the names resolve against the real
    // theme — a typo here would otherwise render a transparent rule.
    const palette = themeTokens().color;
    for (const state of Object.keys(
      SAFETY_COPY,
    ) as (keyof typeof SAFETY_COPY)[]) {
      expect(palette[SAFETY_STATUS[state].rule]).toMatch(/^(#|rgba)/);
      expect(palette[SAFETY_STATUS[state].ink]).toMatch(/^(#|rgba)/);
    }
    expect(SAFETY_EXPLAINER).toHaveLength(3);
  });
});
