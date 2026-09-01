import { describe, expect, it } from 'vitest';
import { collectUsageCounts } from '../src/usage-metrics.js';

describe('collectUsageCounts', () => {
  it('counts rolling 24h, 7d, and 30d windows from UTC day buckets', async () => {
    const calls: Array<{ day: string; min?: string }> = [];

    const count = await collectUsageCounts(Date.parse('2026-07-29T18:47:00Z'), {
      connectionItemCount: async () => 3,
      queryActivityDay: async (day, min) => {
        calls.push({ day, ...(min ? { min } : {}) });
        if (min === '2026-07-28T18#') return 2;
        if (min === '2026-07-22T18#') return 3;
        if (min === '2026-06-29T18#') return 4;
        return 1;
      },
    });

    expect(count).toEqual({
      online: 3,
      daily: 3,
      weekly: 10,
      monthly: 34,
    });
    expect(calls).toContainEqual({
      day: '2026-07-28',
      min: '2026-07-28T18#',
    });
    expect(calls).toContainEqual({
      day: '2026-07-22',
      min: '2026-07-22T18#',
    });
    expect(calls).toContainEqual({
      day: '2026-06-29',
      min: '2026-06-29T18#',
    });
  });

  it('uses exact UTC-hour boundaries across a leap day and month rollover', async () => {
    const calls: Array<{ day: string; min?: string }> = [];

    const count = await collectUsageCounts(Date.parse('2024-03-01T00:59:59Z'), {
      connectionItemCount: async () => 8,
      queryActivityDay: async (day, min) => {
        calls.push({ day, ...(min ? { min } : {}) });
        if (min === '2024-02-29T00#') return 10;
        if (min === '2024-02-23T00#') return 20;
        if (min === '2024-01-31T00#') return 30;
        return 1;
      },
    });

    expect(count).toEqual({
      online: 8,
      daily: 11,
      weekly: 27,
      monthly: 60,
    });
    expect(calls.filter((call) => call.min)).toEqual([
      { day: '2024-01-31', min: '2024-01-31T00#' },
      { day: '2024-02-23', min: '2024-02-23T00#' },
      { day: '2024-02-29', min: '2024-02-29T00#' },
    ]);
  });

  it('returns explicit zero values when no users are active or online', async () => {
    const count = await collectUsageCounts(Date.parse('2026-01-01T00:00:00Z'), {
      connectionItemCount: async () => 0,
      queryActivityDay: async () => 0,
    });

    expect(count).toEqual({
      online: 0,
      daily: 0,
      weekly: 0,
      monthly: 0,
    });
  });

  it('reuses each full-day count across overlapping rolling windows', async () => {
    const fullDayCalls = new Map<string, number>();

    const count = await collectUsageCounts(Date.parse('2026-07-29T18:47:00Z'), {
      connectionItemCount: async () => 0,
      queryActivityDay: async (day, min) => {
        if (min) return 0;
        fullDayCalls.set(day, (fullDayCalls.get(day) ?? 0) + 1);
        return day === '2026-07-29' ? 7 : 1;
      },
    });

    expect(count).toEqual({
      online: 0,
      daily: 7,
      weekly: 13,
      monthly: 36,
    });
    expect(fullDayCalls.size).toBe(30);
    expect([...fullDayCalls.values()]).toEqual(Array.from({ length: 30 }, () => 1));
  });
});
