export const USAGE_METRICS = {
  online: 'OnlineUsersEstimate',
  daily: 'DailyActiveUsers',
  weekly: 'WeeklyActiveUsers',
  monthly: 'MonthlyActiveUsers',
} as const;

export interface UsageCounts {
  online: number;
  daily: number;
  weekly: number;
  monthly: number;
}

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;

type WindowName = 'daily' | 'weekly' | 'monthly';

const WINDOW_DAYS: Record<WindowName, number> = {
  daily: 1,
  weekly: 7,
  monthly: 30,
};

interface Boundary {
  day: string;
  minimumHourActor: string;
}

function boundary(nowHourMs: number, days: number): Boundary {
  const hour = new Date(nowHourMs - days * DAY_MS).toISOString().slice(0, 13);
  return {
    day: hour.slice(0, 10),
    minimumHourActor: `${hour}#`,
  };
}

export async function collectUsageCounts(
  nowMs: number,
  deps: {
    connectionItemCount(): Promise<number>;
    queryActivityDay(day: string, minimumHourActor?: string): Promise<number>;
  },
): Promise<UsageCounts> {
  const nowHourMs = Math.floor(nowMs / HOUR_MS) * HOUR_MS;
  const boundaries = {
    monthly: boundary(nowHourMs, WINDOW_DAYS.monthly),
    weekly: boundary(nowHourMs, WINDOW_DAYS.weekly),
    daily: boundary(nowHourMs, WINDOW_DAYS.daily),
  };

  const monthlyBoundaryDate = new Date(`${boundaries.monthly.day}T00:00:00.000Z`);
  const currentHour = new Date(nowHourMs);
  const currentDayMs = Date.UTC(
    currentHour.getUTCFullYear(),
    currentHour.getUTCMonth(),
    currentHour.getUTCDate(),
  );
  const fullDays: string[] = [];
  for (
    let dayMs = monthlyBoundaryDate.getTime() + DAY_MS;
    dayMs <= currentDayMs;
    dayMs += DAY_MS
  ) {
    fullDays.push(new Date(dayMs).toISOString().slice(0, 10));
  }

  const onlinePromise = deps.connectionItemCount();
  const fullDayPromises = fullDays.map(async (day) => [
    day,
    await deps.queryActivityDay(day),
  ] as const);
  const boundaryPromises = (Object.keys(boundaries) as WindowName[]).map(async (name) => [
    name,
    await deps.queryActivityDay(
      boundaries[name].day,
      boundaries[name].minimumHourActor,
    ),
  ] as const);

  const [online, fullDayEntries, boundaryEntries] = await Promise.all([
    onlinePromise,
    Promise.all(fullDayPromises),
    Promise.all(boundaryPromises),
  ]);
  const fullDayCounts = new Map(fullDayEntries);
  const boundaryCounts = Object.fromEntries(boundaryEntries) as Record<WindowName, number>;

  const countWindow = (name: WindowName): number => {
    let total = boundaryCounts[name];
    for (const [day, count] of fullDayCounts) {
      if (day > boundaries[name].day) total += count;
    }
    return total;
  };

  return {
    online,
    daily: countWindow('daily'),
    weekly: countWindow('weekly'),
    monthly: countWindow('monthly'),
  };
}
