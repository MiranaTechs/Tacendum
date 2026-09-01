import type { QueuedCallMetricReport } from '../src/db';
import { CallMetricDrain, type CallMetricDrainDeps } from '../src/call/metrics';

const NOW = 1_800_000_000_000;
const REPORT = {
  reportId: '01K2ABCDEF0123456789ABCDEF',
  occurredAt: NOW,
  scope: 'direct',
  media: 'audio',
  answered: true,
  connected: true,
  outcome: 'completed',
  setupMs: 120,
  durationSeconds: 12,
};

function row(overrides: Partial<QueuedCallMetricReport> = {}): QueuedCallMetricReport {
  return {
    reportId: REPORT.reportId,
    payload: JSON.stringify(REPORT),
    attempts: 0,
    nextAttemptAt: NOW,
    endedAt: NOW,
    expiresAt: NOW + 7 * 24 * 60 * 60 * 1000,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

async function flushMicrotasks(turns = 8): Promise<void> {
  for (let i = 0; i < turns; i++) await Promise.resolve();
}

type DrainTestDeps = CallMetricDrainDeps & {
  nextDueAt(after: number): Promise<number | null>;
};

function build(overrides: Partial<DrainTestDeps> = {}) {
  const deps = {
    reconcile: jest.fn().mockResolvedValue(undefined),
    prune: jest.fn().mockResolvedValue(undefined),
    listDue: jest.fn().mockResolvedValue([]),
    nextDueAt: jest.fn().mockResolvedValue(null),
    retry: jest.fn().mockResolvedValue(undefined),
    remove: jest.fn().mockResolvedValue(undefined),
    token: jest.fn().mockResolvedValue('bearer'),
    post: jest.fn().mockResolvedValue({ status: 204, retryAfterSeconds: null }),
    isReal: jest.fn(() => true),
    now: () => NOW,
    random: () => 0.5,
    setTimer: setTimeout,
    clearTimer: clearTimeout,
    warn: jest.fn(),
    ...overrides,
  } as unknown as jest.Mocked<DrainTestDeps>;
  return { deps, drain: new CallMetricDrain(deps) };
}

describe('CallMetricDrain', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('reconciles, prunes, and delivers at most twenty oldest queued reports on real activation', async () => {
    const rows = Array.from({ length: 21 }, (_, i) => row({
      reportId: `01K2ABCDEF0123456789ABCDE${String(i).padStart(2, '0')}`,
      endedAt: NOW + i,
    }));
    const { drain, deps } = build({ listDue: jest.fn().mockResolvedValue(rows) });

    await drain.activate();

    expect(deps.reconcile).toHaveBeenCalledTimes(1);
    expect(deps.prune).toHaveBeenCalledWith(NOW);
    expect(deps.listDue).toHaveBeenCalledWith(NOW, 20);
    expect(deps.post).toHaveBeenCalledTimes(20);
    expect(deps.remove).toHaveBeenCalledWith(rows[0]!.reportId);
  });

  it('is network-silent without a real authenticated session', async () => {
    for (const deps of [
      { isReal: jest.fn(() => false) },
      { token: jest.fn().mockResolvedValue(null) },
    ]) {
      const { drain, deps: all } = build({ ...deps, listDue: jest.fn().mockResolvedValue([row()]) });
      await drain.activate();
      expect(all.post).not.toHaveBeenCalled();
    }
  });

  it('retains transient answers with persisted capped jittered retry and honours Retry-After', async () => {
    const { drain, deps } = build({
      listDue: jest.fn().mockResolvedValue([row({ attempts: 0 })]),
      post: jest.fn()
        .mockResolvedValueOnce({ status: 503, retryAfterSeconds: null })
        .mockResolvedValueOnce({ status: 429, retryAfterSeconds: 17 }),
    });

    await drain.activate();
    expect(deps.retry).toHaveBeenLastCalledWith(REPORT.reportId, 1, NOW + 5_000);
    deps.listDue.mockResolvedValueOnce([row({ attempts: 1 })]);
    await drain.nudge();
    expect(deps.retry).toHaveBeenLastCalledWith(REPORT.reportId, 2, NOW + 17_000);
  });

  it.each([401, 408, 429, 500, 502, 503, 504])('retains final %i without deleting it', async status => {
    const { drain, deps } = build({
      listDue: jest.fn().mockResolvedValue([row()]),
      post: jest.fn().mockResolvedValue({ status, retryAfterSeconds: null }),
    });
    await drain.activate();
    expect(deps.remove).not.toHaveBeenCalled();
    expect(deps.retry).toHaveBeenCalledWith(REPORT.reportId, 1, NOW + 5_000);
  });

  it('retains an unknown HTTP answer and a rejected transport without leaking either', async () => {
    const { drain, deps } = build({
      listDue: jest.fn()
        .mockResolvedValueOnce([row({ reportId: '01K2ABCDEF0123456789ABCDEG' })])
        .mockResolvedValueOnce([row({ reportId: '01K2ABCDEF0123456789ABCDEH' })]),
      post: jest.fn()
        .mockResolvedValueOnce({ status: 418, retryAfterSeconds: null })
        .mockRejectedValueOnce(new TypeError('Network request failed')),
    });
    await drain.activate();
    await drain.nudge();
    expect(deps.remove).not.toHaveBeenCalled();
    expect(deps.retry).toHaveBeenCalledWith('01K2ABCDEF0123456789ABCDEG', 1, NOW + 5_000);
    expect(deps.retry).toHaveBeenCalledWith('01K2ABCDEF0123456789ABCDEH', 1, NOW + 5_000);
  });

  it.each([400, 403, 404, 409, 422])('drops only structural poison status %i without logging payload', async status => {
    const { drain, deps } = build({
      listDue: jest.fn().mockResolvedValue([row()]),
      post: jest.fn().mockResolvedValue({ status, retryAfterSeconds: null }),
    });
    await drain.activate();
    expect(deps.remove).toHaveBeenCalledWith(REPORT.reportId);
    expect(String(deps.warn.mock.calls[0]![0])).not.toContain(REPORT.reportId);
    expect(String(deps.warn.mock.calls[0]![0])).not.toContain('completed');
  });

  it('single-flights and latches one nudge that arrives during delivery', async () => {
    const response = deferred<{ status: number; retryAfterSeconds: null }>();
    const { drain, deps } = build({
      listDue: jest.fn().mockResolvedValue([row()]).mockResolvedValueOnce([row()]).mockResolvedValueOnce([]),
      post: jest.fn().mockReturnValue(response.promise),
    });
    const active = drain.activate();
    await flushMicrotasks();
    const nudge = drain.nudge();
    expect(deps.post).toHaveBeenCalledTimes(1);
    response.resolve({ status: 204, retryAfterSeconds: null });
    await Promise.all([active, nudge]);
    expect(deps.listDue).toHaveBeenCalledTimes(2);
    expect(deps.post).toHaveBeenCalledTimes(1);
  });

  it('fences a response that outlives deactivation before it can mutate a replacement workspace', async () => {
    const response = deferred<{ status: number; retryAfterSeconds: null }>();
    const { drain, deps } = build({
      listDue: jest.fn().mockResolvedValue([row()]),
      post: jest.fn().mockReturnValue(response.promise),
    });
    const running = drain.activate();
    await Promise.resolve();
    drain.deactivate();
    response.resolve({ status: 204, retryAfterSeconds: null });
    await running;
    expect(deps.remove).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('waits for obsolete in-flight work then runs reconcile, prune, and drain for the new activation', async () => {
    const response = deferred<{ status: number; retryAfterSeconds: null }>();
    const { drain, deps } = build({
      listDue: jest.fn()
        .mockResolvedValueOnce([row()])
        .mockResolvedValueOnce([]),
      post: jest.fn().mockReturnValueOnce(response.promise),
    });
    const oldActivation = drain.activate();
    await flushMicrotasks();
    expect(deps.post).toHaveBeenCalledTimes(1);
    const replacementActivation = drain.activate();
    response.resolve({ status: 204, retryAfterSeconds: null });
    await Promise.all([oldActivation, replacementActivation]);
    expect(deps.reconcile).toHaveBeenCalledTimes(2);
    expect(deps.prune).toHaveBeenCalledTimes(2);
    expect(deps.listDue).toHaveBeenCalledTimes(2);
  });

  it('rejects a stale captured wakeup after replacement activation but accepts the new generation callback', async () => {
    const { drain, deps } = build();
    await drain.activate();
    const staleWake = drain.captureNudge();
    drain.deactivate();
    await drain.activate();
    deps.listDue.mockClear();

    staleWake();
    await flushMicrotasks();
    expect(deps.listDue).not.toHaveBeenCalled();

    drain.captureNudge()();
    await flushMicrotasks();
    expect(deps.listDue).toHaveBeenCalledTimes(1);
  });

  it('keeps the earliest due timer when later rows schedule longer retries', async () => {
    let timerId = 0;
    const timers = new Map<number, { delay: number; callback: () => void }>();
    const { drain, deps } = build({
      listDue: jest.fn().mockResolvedValue([
        row({ reportId: '01K2ABCDEF0123456789ABCDEG', attempts: 1 }),
        row({ reportId: '01K2ABCDEF0123456789ABCDEH', attempts: 0 }),
      ]),
      post: jest.fn()
        .mockResolvedValueOnce({ status: 503, retryAfterSeconds: null })
        .mockResolvedValueOnce({ status: 429, retryAfterSeconds: 17 }),
      // Mirror the persisted rows written by retry(): the durable query must
      // still report the earlier ten-second wake after both updates.
      nextDueAt: jest.fn().mockResolvedValue(NOW + 10_000),
      setTimer: jest.fn((callback: () => void, delay: number) => {
        timerId++;
        timers.set(timerId, { callback, delay });
        return timerId as unknown as ReturnType<typeof setTimeout>;
      }),
      clearTimer: jest.fn((id: number) => timers.delete(id)),
    });
    await drain.activate();
    expect([...timers.values()].map(timer => timer.delay)).toEqual([10_000]);
    expect(deps.retry).toHaveBeenLastCalledWith('01K2ABCDEF0123456789ABCDEH', 1, NOW + 17_000);
  });

  it('continues with another bounded due pass after a full batch so later due rows are not stranded', async () => {
    const firstBatch = Array.from({ length: 20 }, (_, i) => row({
      reportId: `01K2ABCDEF0123456789ABCDE${String(i).padStart(2, '0')}`,
    }));
    const later = row({ reportId: '01K2ABCDEF0123456789ABCDEG' });
    const { drain, deps } = build({
      listDue: jest.fn()
        .mockResolvedValueOnce(firstBatch)
        .mockResolvedValueOnce([later]),
    });
    await drain.activate();
    expect(deps.listDue).toHaveBeenCalledTimes(2);
    expect(deps.post).toHaveBeenCalledTimes(21);
    expect(deps.remove).toHaveBeenCalledWith(later.reportId);
  });

  it('re-arms a persisted future retry when a real workspace is adopted', async () => {
    jest.setSystemTime(NOW);
    const dueAt = NOW + 5_000;
    let queued = true;
    const queuedRow = row({ nextAttemptAt: dueAt });
    const { drain, deps } = build({
      now: () => Date.now(),
      listDue: jest.fn(async now => queued && now >= dueAt ? [queuedRow] : []),
      nextDueAt: jest.fn(async () => queued ? dueAt : null),
      remove: jest.fn(async () => { queued = false; }),
    });

    await drain.activate();

    // Removing the persisted-schedule lookup/arm must strand this row again.
    expect(jest.getTimerCount()).toBe(1);
    expect(deps.post).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(5_000);
    await flushMicrotasks();

    expect(deps.post).toHaveBeenCalledTimes(1);
    expect(deps.remove).toHaveBeenCalledWith(queuedRow.reportId);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('prunes with a fresh clock before an ordinary wake can deliver an expired report', async () => {
    let now = NOW;
    let queued = true;
    const expiresAt = NOW + 5_000;
    const expired = row({ nextAttemptAt: expiresAt, expiresAt });
    const prune = jest.fn(async (at: number) => {
      if (at >= expiresAt) queued = false;
    });
    const { drain, deps } = build({
      now: () => now,
      prune,
      listDue: jest.fn(async at => queued && at >= expiresAt ? [expired] : []),
      nextDueAt: jest.fn(async () => queued ? expiresAt : null),
    });

    await drain.activate();
    deps.prune.mockClear();
    deps.post.mockClear();
    now = expiresAt;

    await drain.nudge();

    // Removing per-pass pruning makes the immutable expired row post here.
    expect(deps.prune).toHaveBeenCalledWith(expiresAt);
    expect(deps.post).not.toHaveBeenCalled();
  });

  it('discards an immutable locally malformed payload instead of retrying it forever', async () => {
    const malformed = row({ payload: '{not-json' });
    const { drain, deps } = build({
      listDue: jest.fn().mockResolvedValue([malformed]),
    });

    await drain.activate();

    // Replacing this delete with retry recreates a permanent poison loop.
    expect(deps.remove).toHaveBeenCalledWith(malformed.reportId);
    expect(deps.retry).not.toHaveBeenCalled();
    expect(String(deps.warn.mock.calls[0]![0])).not.toContain(malformed.reportId);
    expect(String(deps.warn.mock.calls[0]![0])).not.toContain(malformed.payload);
  });
});
