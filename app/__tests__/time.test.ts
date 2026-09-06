/**
 * The time labels, and the year they used to leave off.
 *
 * `dayLabel` writes the thread's date dividers and `timeLabel` writes the
 * chat list's row times, and both fell through to `{ month, day }` for
 * anything older than a week — so a message from March 2024 read "Mar 3"
 * and sat, unremarkably, between two dates from this year. One comparison
 * in each helper now adds `year: 'numeric'` when the timestamp's year is
 * not the current one; the locale does the rest, so there is no new string
 * and no divergence row.
 *
 * Written against the OPTION SET rather than a locale literal: the
 * expectation is built by the same `toLocaleDateString` the helper calls,
 * so the test pins WHICH OPTIONS ship rather than what one machine's ICU
 * happens to print. The falsifier — the pair of `not.toBe` assertions —
 * is what stops that being circular: a helper that added the year always,
 * or never, fails.
 *
 * The clock is pinned with fake timers because both helpers read `new
 * Date()` for "now", and a suite that runs on 1 January would otherwise
 * disagree with one that runs in July.
 */

import { clockLabel, dayLabel, sameDay, timeLabel } from '../src/time';

/** Local-time constructor: the helpers compare calendar days locally, so a
 * UTC literal would drift a day either side of the machine's zone. */
const at = (
  y: number,
  m: number,
  d: number,
  h = 12,
  min = 0,
): number => new Date(y, m - 1, d, h, min).getTime();

const shortDate = (ts: number, withYear: boolean): string =>
  new Date(ts).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(withYear ? { year: 'numeric' as const } : {}),
  });

afterEach(() => {
  jest.useRealTimers();
});

/** Freeze "now" so both helpers' day arithmetic is deterministic. */
function now(ts: number): void {
  jest.useFakeTimers();
  jest.setSystemTime(ts);
}

describe('dayLabel — the year appears only when it is not this one', () => {
  test('Today and Yesterday are untouched', () => {
    now(at(2026, 9, 6, 9));
    expect(dayLabel(at(2026, 9, 6, 1))).toBe('Today');
    expect(dayLabel(at(2026, 9, 5, 23))).toBe('Yesterday');
    // Even across a year boundary: the words never carry a date at all.
    now(at(2027, 1, 1, 9));
    expect(dayLabel(at(2026, 12, 31, 22))).toBe('Yesterday');
  });

  test('a date in the current year is the short date, with no year', () => {
    now(at(2026, 9, 6, 9));
    const ts = at(2026, 3, 3);
    expect(dayLabel(ts)).toBe(shortDate(ts, false));
    // The falsifier: adding the year unconditionally would pass the line
    // above only if the two renderings were identical, and they are not.
    expect(dayLabel(ts)).not.toBe(shortDate(ts, true));
  });

  test('a date in a previous year says which year', () => {
    now(at(2026, 9, 6, 9));
    const ts = at(2024, 3, 3);
    expect(dayLabel(ts)).toBe(shortDate(ts, true));
    expect(dayLabel(ts)).not.toBe(shortDate(ts, false));
    expect(dayLabel(ts)).toContain('2024');
  });

  test('the January boundary: the last week of December, read in January', () => {
    now(at(2027, 1, 1, 9));
    const ts = at(2026, 12, 20);
    expect(dayLabel(ts)).toBe(shortDate(ts, true));
    expect(dayLabel(ts)).toContain('2026');
  });
});

describe('timeLabel — the same rule on the list row', () => {
  test('today is a clock time and this week is a weekday, both unchanged', () => {
    now(at(2026, 9, 6, 18));
    expect(timeLabel(at(2026, 9, 6, 9, 30))).toBe(
      new Date(at(2026, 9, 6, 9, 30)).toLocaleTimeString(undefined, {
        hour: 'numeric',
        minute: '2-digit',
      }),
    );
    expect(timeLabel(at(2026, 9, 3))).toBe(
      new Date(at(2026, 9, 3)).toLocaleDateString(undefined, {
        weekday: 'short',
      }),
    );
  });

  test('a row from this year keeps the bare short date', () => {
    now(at(2026, 9, 6, 9));
    const ts = at(2026, 3, 3);
    expect(timeLabel(ts)).toBe(shortDate(ts, false));
    expect(timeLabel(ts)).not.toBe(shortDate(ts, true));
  });

  test('a row from a previous year says the year', () => {
    now(at(2026, 9, 6, 9));
    const ts = at(2024, 3, 3);
    expect(timeLabel(ts)).toBe(shortDate(ts, true));
    expect(timeLabel(ts)).toContain('2024');
  });

  test('a weekday within the last week never grows a year, even across the boundary', () => {
    // Three days old, but last year: the weekday branch has no date in it
    // to qualify, and "Mon 2026" would be nonsense.
    now(at(2027, 1, 2, 9));
    expect(timeLabel(at(2026, 12, 30))).toBe(
      new Date(at(2026, 12, 30)).toLocaleDateString(undefined, {
        weekday: 'short',
      }),
    );
    expect(timeLabel(at(2026, 12, 30))).not.toContain('2026');
  });
});

describe('the helpers this change does not touch', () => {
  test('sameDay and clockLabel are unchanged', () => {
    expect(sameDay(at(2024, 3, 3, 1), at(2024, 3, 3, 23))).toBe(true);
    expect(sameDay(at(2024, 3, 3), at(2025, 3, 3))).toBe(false);
    const ts = at(2024, 3, 3, 14, 5);
    expect(clockLabel(ts)).toBe(
      new Date(ts).toLocaleTimeString(undefined, {
        hour: 'numeric',
        minute: '2-digit',
      }),
    );
  });
});
