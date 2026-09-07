import type { AiWorkUsage } from '@tacendum/shared';

/** Usage is a point-in-time observation, not a lease. Five minutes keeps an
 * hourly counter useful between nearby actions while staying far below its
 * period; an old snapshot cannot disable a new task for the rest of an hour. */
export const AI_USAGE_CURRENT_MS = 5 * 60 * 1000;

export type AiUsageFreshness = 'current' | 'stale' | 'unknown';

export interface AiUsageDisplayRow {
  key: string;
  title: string;
  value: string;
  sourceLabel: 'Local budget' | 'Provider reported';
  freshness: AiUsageFreshness;
  freshnessLabel: string;
  /** Display emphasis only. Task gating must call the aggregate helper,
   * which also resolves duplicate/latest-row ambiguity. */
  exhausted: boolean;
}

function validTime(value: number | null): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Freshness of the phone's receipt. Source timestamps are evaluated per
 * row by `usageDisplayRows` and the exhaustion predicate; a fresh delivery
 * alone never makes queued old usage current. */
export function usageFreshness(
  receivedAt: number | null,
  now: number,
): AiUsageFreshness {
  if (!validTime(receivedAt) || !validTime(now) || receivedAt > now)
    return 'unknown';
  return now - receivedAt <= AI_USAGE_CURRENT_MS ? 'current' : 'stale';
}

type RowFreshness = {
  freshness: AiUsageFreshness;
  freshnessLabel: string;
};

function ageLabel(at: number, now: number): string {
  const age = Math.max(0, now - at);
  if (age < 60_000) return 'just now';
  if (age < 60 * 60_000) return `${Math.floor(age / 60_000)}m ago`;
  if (age < 24 * 60 * 60_000) return `${Math.floor(age / (60 * 60_000))}h ago`;
  return `${Math.floor(age / (24 * 60 * 60_000))}d ago`;
}

function rowFreshness(
  row: AiWorkUsage,
  receivedAt: number | null,
  now: number,
): RowFreshness {
  if (!validTime(now) || !validTime(row.observedAt)) {
    return { freshness: 'unknown', freshnessLabel: 'Source time unavailable' };
  }
  // A source observation after the phone's clock, or after the receipt that
  // carried it, cannot authorize a local block. Keep it visible and say why.
  if (
    row.observedAt > now ||
    (validTime(receivedAt) && row.observedAt > receivedAt)
  ) {
    return {
      freshness: 'unknown',
      freshnessLabel: 'Source time untrusted · reported in the future',
    };
  }
  const receipt = usageFreshness(receivedAt, now);
  if (receipt === 'unknown') {
    return {
      freshness: 'unknown',
      freshnessLabel: `Reported ${ageLabel(
        row.observedAt,
        now,
      )} · receipt time unavailable`,
    };
  }
  if (receipt === 'stale' || now - row.observedAt > AI_USAGE_CURRENT_MS) {
    return {
      freshness: 'stale',
      freshnessLabel: `Stale · reported ${ageLabel(row.observedAt, now)}`,
    };
  }
  return {
    freshness: 'current',
    freshnessLabel: `Current · reported ${ageLabel(row.observedAt, now)}`,
  };
}

function groupedFixed(value: number, fractionDigits: number): string {
  const fixed = value.toFixed(fractionDigits);
  const [whole = '0', fraction] = fixed.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return fraction === undefined ? grouped : `${grouped}.${fraction}`;
}

function groupedVariable(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  const digits = Number.isInteger(rounded)
    ? 0
    : Number.isInteger(rounded * 10)
      ? 1
      : 2;
  return groupedFixed(rounded, digits);
}

function amount(value: number, unit: AiWorkUsage['unit']): string {
  const rounded = Number(value.toFixed(2));
  if (unit === 'usd') {
    if (value > 0 && rounded === 0) return '<$0.01';
    return `${rounded !== value ? '≈' : ''}$${groupedFixed(rounded, 2)}`;
  }
  const noun =
    unit === 'turns'
      ? value === 1
        ? 'turn'
        : 'turns'
      : value === 1
        ? 'token'
        : 'tokens';
  if (value > 0 && rounded === 0) return `<0.01 ${noun}`;
  return `${rounded !== value ? '≈' : ''}${groupedVariable(rounded)} ${noun}`;
}

const UNIT_TITLE: Record<AiWorkUsage['unit'], string> = {
  turns: 'Turns',
  tokens: 'Tokens',
  usd: 'Cost',
};

const PERIOD_TITLE: Record<AiWorkUsage['period'], string> = {
  turn: 'Turn',
  hour: 'Hour',
  session: 'Session',
  day: 'Day',
  week: 'Week',
  month: 'Month',
};

function valueLabel(row: AiWorkUsage): string {
  const parts: string[] = [];
  if (row.used !== undefined) parts.push(`${amount(row.used, row.unit)} used`);
  if (row.remaining !== undefined)
    parts.push(`${amount(row.remaining, row.unit)} left`);
  if (row.limit !== undefined)
    parts.push(`${amount(row.limit, row.unit)} limit`);
  return parts.length === 0 ? 'Value unavailable' : parts.join(' · ');
}

/** True, false, or null when the row does not contain enough consistent
 * fields to decide. Contradictory counters never disable an action. */
function explicitExhaustion(row: AiWorkUsage): boolean | null {
  const { used, remaining, limit } = row;
  for (const value of [used, remaining, limit]) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0))
      return null;
  }
  if (remaining !== undefined) {
    if (remaining > 0) return false;
    if (used !== undefined && limit !== undefined && used < limit) return null;
    return true;
  }
  if (limit === undefined) return null;
  if (limit === 0) return used === undefined || used === 0 ? true : null;
  return used === undefined ? null : used >= limit;
}

function authoritativeExhaustedIndices(
  usage: readonly AiWorkUsage[],
  receivedAt: number | null,
  now: number,
): Set<number> {
  const exhausted = new Set<number>();
  const current = usage
    .map((row, index) => ({ row, index }))
    .filter(
      ({ row }) =>
        row.source === 'local-budget' &&
        row.unit === 'turns' &&
        rowFreshness(row, receivedAt, now).freshness === 'current',
    );
  for (const period of [
    'turn',
    'hour',
    'session',
    'day',
    'week',
    'month',
  ] as const) {
    const rows = current.filter(({ row }) => row.period === period);
    if (rows.length === 0) continue;
    const newestAt = Math.max(...rows.map(({ row }) => row.observedAt));
    const newest = rows.filter(({ row }) => row.observedAt === newestAt);
    const candidate = newest[0];
    if (
      newest.length === 1 &&
      candidate !== undefined &&
      explicitExhaustion(candidate.row) === true
    ) {
      exhausted.add(candidate.index);
    }
  }
  return exhausted;
}

export function usageDisplayRows(
  usage: readonly AiWorkUsage[] | null,
  receivedAt: number | null,
  now: number,
): AiUsageDisplayRow[] {
  if (usage === null || usage.length === 0) return [];
  const exhausted = authoritativeExhaustedIndices(usage, receivedAt, now);
  return usage.map((row, index) => {
    const timing = rowFreshness(row, receivedAt, now);
    return {
      key: `${row.source}:${row.unit}:${row.period}:${row.observedAt}:${index}`,
      title: `${UNIT_TITLE[row.unit]} · ${PERIOD_TITLE[row.period]}`,
      value: valueLabel(row),
      sourceLabel:
        row.source === 'local-budget' ? 'Local budget' : 'Provider reported',
      ...timing,
      exhausted: exhausted.has(index),
    };
  });
}

/** The sole task-disable predicate. For each local turns period, only the
 * newest current observation is considered; tied contradictory snapshots
 * are not authoritative. A current exhausted period is enough to refuse a
 * new task because hourly and session limits can apply simultaneously. */
export function isCurrentLocalTurnLimitExhausted(
  usage: readonly AiWorkUsage[] | null,
  receivedAt: number | null,
  now: number,
): boolean {
  if (usage === null || usage.length === 0) return false;
  return authoritativeExhaustedIndices(usage, receivedAt, now).size > 0;
}
