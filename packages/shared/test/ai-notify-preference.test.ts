import { describe, expect, it } from 'vitest';
import { AiNotifyPreferenceSchema, aiNotifyPreference } from '../src/ai-notify-preference.js';

const Q = '01J00000000000000000000000';

describe('AI routine notification preference wire fragment', () => {
  it('accepts only a canonical request id and the two bounded modes', () => {
    expect(AiNotifyPreferenceSchema.parse({ q: Q, routine: 'quiet' })).toEqual({
      q: Q,
      routine: 'quiet',
    });
    expect(AiNotifyPreferenceSchema.safeParse({ q: Q, routine: 'all' }).success).toBe(true);
    expect(AiNotifyPreferenceSchema.safeParse({ q: Q, routine: 'decisions-only' }).success).toBe(
      false,
    );
    expect(AiNotifyPreferenceSchema.safeParse({ q: 'not-an-id', routine: 'quiet' }).success).toBe(
      false,
    );
    expect(
      AiNotifyPreferenceSchema.safeParse({ q: Q, routine: 'quiet', future: true }).success,
    ).toBe(false);
  });

  it('drops malformed optional metadata without costing its profile carrier', () => {
    expect(aiNotifyPreference.parse(undefined)).toBeUndefined();
    expect(aiNotifyPreference.parse({ q: Q, routine: 'future' })).toBeUndefined();
    expect(aiNotifyPreference.parse({ q: Q, routine: 'all', extra: 1 })).toBeUndefined();
  });
});
