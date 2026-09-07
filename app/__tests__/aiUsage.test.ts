import type { AiWorkUsage } from '@tacendum/shared';
import {
  AI_USAGE_CURRENT_MS,
  isCurrentLocalTurnLimitExhausted,
  usageDisplayRows,
  usageFreshness,
} from '../src/aiUsage';

const NOW = 1_800_000_000_000;

function usage(overrides: Partial<AiWorkUsage> = {}): AiWorkUsage {
  return {
    source: 'local-budget',
    unit: 'turns',
    period: 'hour',
    observedAt: NOW - 60_000,
    used: 5,
    remaining: 0,
    limit: 5,
    ...overrides,
  };
}

describe('usage freshness', () => {
  test('a receipt is current only inside the short snapshot window', () => {
    expect(usageFreshness(NOW, NOW)).toBe('current');
    expect(usageFreshness(NOW - AI_USAGE_CURRENT_MS, NOW)).toBe('current');
    expect(usageFreshness(NOW - AI_USAGE_CURRENT_MS - 1, NOW)).toBe('stale');
  });

  test('missing, malformed, and future receipt clocks are unknown', () => {
    expect(usageFreshness(null, NOW)).toBe('unknown');
    expect(usageFreshness(Number.NaN, NOW)).toBe('unknown');
    expect(usageFreshness(NOW + 1, NOW)).toBe('unknown');
    expect(usageFreshness(NOW, Number.NaN)).toBe('unknown');
  });
});

describe('authoritative local turn exhaustion', () => {
  test('blocks only on a current local turns row with an explicit exhausted limit', () => {
    expect(isCurrentLocalTurnLimitExhausted([usage()], NOW, NOW)).toBe(true);
    expect(
      isCurrentLocalTurnLimitExhausted(
        [usage({ used: 0, remaining: 5, limit: 5 })],
        NOW,
        NOW,
      ),
    ).toBe(false);
    expect(
      isCurrentLocalTurnLimitExhausted(
        [usage({ used: 0, remaining: undefined, limit: undefined })],
        NOW,
        NOW,
      ),
    ).toBe(false);
    expect(
      isCurrentLocalTurnLimitExhausted(
        [usage({ used: undefined, remaining: 0, limit: undefined })],
        NOW,
        NOW,
      ),
    ).toBe(true);
  });

  test('stale, queued-old, future, provider, and non-turn evidence cannot block', () => {
    expect(
      isCurrentLocalTurnLimitExhausted(
        [usage()],
        NOW - AI_USAGE_CURRENT_MS - 1,
        NOW,
      ),
    ).toBe(false);
    expect(
      isCurrentLocalTurnLimitExhausted(
        [usage({ observedAt: NOW - AI_USAGE_CURRENT_MS - 1 })],
        NOW,
        NOW,
      ),
    ).toBe(false);
    expect(
      isCurrentLocalTurnLimitExhausted(
        [usage({ observedAt: NOW + 1 })],
        NOW,
        NOW,
      ),
    ).toBe(false);
    expect(
      isCurrentLocalTurnLimitExhausted(
        [usage({ source: 'provider-reported' })],
        NOW,
        NOW,
      ),
    ).toBe(false);
    expect(
      isCurrentLocalTurnLimitExhausted([usage({ unit: 'tokens' })], NOW, NOW),
    ).toBe(false);
    expect(isCurrentLocalTurnLimitExhausted(null, NOW, NOW)).toBe(false);
  });

  test('contradictory latest snapshots fail open instead of disabling a task', () => {
    expect(
      isCurrentLocalTurnLimitExhausted(
        [usage({ remaining: 0, used: 1, limit: 5 })],
        NOW,
        NOW,
      ),
    ).toBe(false);
    const tied = [usage(), usage({ used: 4, remaining: 1 })];
    expect(isCurrentLocalTurnLimitExhausted(tied, NOW, NOW)).toBe(false);
    expect(usageDisplayRows(tied, NOW, NOW).some(row => row.exhausted)).toBe(
      false,
    );
  });
});

describe('usage display rows', () => {
  test('keeps units, periods, zeroes, sources, and currency provenance explicit', () => {
    const rows = usageDisplayRows(
      [
        usage({ used: 0, remaining: undefined, limit: undefined }),
        usage({
          source: 'provider-reported',
          unit: 'tokens',
          period: 'session',
          used: 12_500,
          remaining: undefined,
          limit: undefined,
        }),
        usage({
          source: 'provider-reported',
          unit: 'usd',
          period: 'day',
          used: 1.236,
          remaining: undefined,
          limit: 10,
        }),
      ],
      NOW,
      NOW,
    );

    expect(rows[0]).toMatchObject({
      title: 'Turns · Hour',
      value: '0 turns used',
      sourceLabel: 'Local budget',
      freshness: 'current',
    });
    expect(rows[1]).toMatchObject({
      title: 'Tokens · Session',
      value: '12,500 tokens used',
      sourceLabel: 'Provider reported',
    });
    expect(rows[1]?.value).not.toContain('$');
    expect(rows[2]).toMatchObject({
      title: 'Cost · Day',
      value: '≈$1.24 used · $10.00 limit',
      sourceLabel: 'Provider reported',
    });
  });

  test('never renders a tiny positive amount as exact zero', () => {
    const rows = usageDisplayRows(
      [
        usage({
          source: 'provider-reported',
          unit: 'usd',
          period: 'day',
          used: 0.004,
          remaining: undefined,
          limit: undefined,
        }),
        usage({
          source: 'provider-reported',
          unit: 'tokens',
          period: 'session',
          used: 0.004,
          remaining: undefined,
          limit: undefined,
        }),
        usage({
          used: 0,
          remaining: undefined,
          limit: undefined,
        }),
      ],
      NOW,
      NOW,
    );

    expect(rows.map(row => row.value)).toEqual([
      '<$0.01 used',
      '<0.01 tokens used',
      '0 turns used',
    ]);
  });

  test('labels an old source behind a fresh receipt stale and a future source untrusted', () => {
    const [old, future] = usageDisplayRows(
      [
        usage({ observedAt: NOW - AI_USAGE_CURRENT_MS - 1 }),
        usage({ observedAt: NOW + 1, period: 'day' }),
      ],
      NOW,
      NOW,
    );
    expect(old).toMatchObject({ freshness: 'stale' });
    expect(old?.freshnessLabel).toContain('Stale');
    expect(future).toMatchObject({ freshness: 'unknown' });
    expect(future?.freshnessLabel).toContain('Source time untrusted');
  });

  test('missing usage produces no invented row', () => {
    expect(usageDisplayRows(null, null, NOW)).toEqual([]);
    expect(usageDisplayRows([], NOW, NOW)).toEqual([]);
  });
});
