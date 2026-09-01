import { CallMetricLifecycle, type CallMetricLifecycleDeps } from '../src/call/metrics';

const START = 1_800_000_000_000;

function lifecycle() {
  const deps = {
    open: jest.fn().mockResolvedValue(undefined),
    answered: jest.fn().mockResolvedValue(undefined),
    connected: jest.fn().mockResolvedValue(undefined),
    peak: jest.fn().mockResolvedValue(undefined),
    finalize: jest.fn().mockResolvedValue(undefined),
    discard: jest.fn().mockResolvedValue(undefined),
    touch: jest.fn().mockResolvedValue(undefined),
    now: () => Date.now(),
  } as unknown as jest.Mocked<CallMetricLifecycleDeps>;
  return { lifecycle: new CallMetricLifecycle(deps), deps };
}

describe('CallMetricLifecycle', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(START);
  });

  afterEach(() => jest.useRealTimers());

  it('shares one heartbeat for authoritative direct and group reports and tears it down', async () => {
    const { lifecycle: metrics, deps } = lifecycle();
    await metrics.open({ reportId: 'R1', localId: 'direct', scope: 'direct', media: 'audio', startedAt: START });
    await metrics.open({ reportId: 'R2', localId: 'group', scope: 'group', media: 'video', startedAt: START });

    expect(jest.getTimerCount()).toBe(1);
    await jest.advanceTimersByTimeAsync(30_000);
    expect(deps.touch).toHaveBeenCalledWith('direct', START + 30_000);
    expect(deps.touch).toHaveBeenCalledWith('group', START + 30_000);

    await metrics.finalize('direct', 'hangup', START + 31_000);
    expect(jest.getTimerCount()).toBe(1);
    await metrics.discard('group');
    expect(jest.getTimerCount()).toBe(0);
    metrics.deactivate('missing');
    expect(jest.getTimerCount()).toBe(0);
  });

  it('queues listeners only after successful finalization and can deactivate every report', async () => {
    const { lifecycle: metrics, deps } = lifecycle();
    const seen: string[] = [];
    metrics.onQueued(() => seen.push('first'));
    metrics.onQueued(() => { throw new Error('listener'); });
    metrics.onQueued(() => seen.push('last'));
    await metrics.open({ reportId: 'R1', localId: 'one', scope: 'direct', media: 'audio', startedAt: START });
    await metrics.open({ reportId: 'R2', localId: 'two', scope: 'group', media: 'video', startedAt: START });
    await metrics.connected('one', START + 1);
    await metrics.discard('one');
    expect(seen).toEqual([]);
    await metrics.finalize('two', 'hangup', START + 2);
    expect(seen).toEqual(['first', 'last']);
    await metrics.open({ reportId: 'R3', localId: 'three', scope: 'direct', media: 'audio', startedAt: START });
    expect(jest.getTimerCount()).toBe(1);
    metrics.deactivate();
    expect(jest.getTimerCount()).toBe(0);
    expect(deps.finalize).toHaveBeenCalledTimes(1);
  });

  it('does not queue failed finalization and deactivates only the named report', async () => {
    const { lifecycle: metrics, deps } = lifecycle();
    const queued = jest.fn();
    metrics.onQueued(queued);
    await metrics.open({ reportId: 'R1', localId: 'one', scope: 'direct', media: 'audio', startedAt: START });
    await metrics.open({ reportId: 'R2', localId: 'two', scope: 'group', media: 'audio', startedAt: START });
    metrics.deactivate('one');
    await jest.advanceTimersByTimeAsync(30_000);
    expect(deps.touch).not.toHaveBeenCalledWith('one', expect.any(Number));
    expect(deps.touch).toHaveBeenCalledWith('two', START + 30_000);
    (deps.finalize as jest.Mock).mockRejectedValueOnce(new Error('db'));
    await metrics.finalize('two', 'hangup', START + 31_000);
    expect(queued).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);

    await metrics.open({ reportId: 'R3', localId: 'three', scope: 'direct', media: 'audio', startedAt: START });
    await metrics.open({ reportId: 'R4', localId: 'four', scope: 'group', media: 'audio', startedAt: START });
    metrics.deactivate('three');
    expect(jest.getTimerCount()).toBe(1);
    metrics.deactivate();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('does not resurrect a heartbeat when an open finishes after full deactivation', async () => {
    const { lifecycle: metrics, deps } = lifecycle();
    let releaseOpen!: () => void;
    (deps.open as jest.Mock).mockReturnValueOnce(new Promise<void>(resolve => {
      releaseOpen = resolve;
    }));

    const opening = metrics.open({
      reportId: 'R1',
      localId: 'old-workspace',
      scope: 'direct',
      media: 'audio',
      startedAt: START,
    });
    await Promise.resolve();
    expect(deps.open).toHaveBeenCalledTimes(1);

    metrics.deactivate();
    releaseOpen();
    await opening;

    expect(jest.getTimerCount()).toBe(0);
    await jest.advanceTimersByTimeAsync(30_000);
    expect(deps.touch).not.toHaveBeenCalled();
  });

  it('does not let an old finalization notify a replacement workspace', async () => {
    const { lifecycle: metrics, deps } = lifecycle();
    let releaseFinalize!: () => void;
    (deps.finalize as jest.Mock).mockReturnValueOnce(new Promise<void>(resolve => {
      releaseFinalize = resolve;
    }));
    await metrics.open({
      reportId: 'R1',
      localId: 'old-workspace',
      scope: 'direct',
      media: 'audio',
      startedAt: START,
    });
    const finalizing = metrics.finalize('old-workspace', 'hangup', START + 1);
    await Promise.resolve();
    expect(deps.finalize).toHaveBeenCalledTimes(1);

    metrics.deactivate();
    const replacementQueued = jest.fn();
    metrics.onQueued(replacementQueued);
    await metrics.open({
      reportId: 'R2',
      localId: 'replacement-workspace',
      scope: 'direct',
      media: 'audio',
      startedAt: START + 2,
    });
    releaseFinalize();
    await finalizing;

    expect(replacementQueued).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(1);
    await jest.advanceTimersByTimeAsync(30_000);
    expect(deps.touch).toHaveBeenCalledWith('replacement-workspace', START + 30_000);
  });
});
