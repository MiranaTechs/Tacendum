/**
 * The callback owners live in call/index, but the generation belongs to the
 * drain. Exercise both together: an auth/socket callback retained by an old
 * emitter must be harmless after relock and real-workspace re-adoption.
 */
jest.mock('../src/db', () => ({
  // Device-set defaults: the reads every send
  // and receive now consults — an EMPTY world here, so suites predating
  // multi-device keep exercising the single-leg wire byte-for-byte. A suite
  // that defines its own version below wins (later keys override).
  listLinkedDevices: jest.fn(async () => []),
  listPeerDevices: jest.fn(async () => []),
  getPeerDevice: jest.fn(async () => null),
  upsertPeerDevice: jest.fn(async () => undefined),
  blockPeer: jest.fn(async () => undefined),
  markChatOpened: jest.fn(async () => undefined),
  setLocalName: jest.fn(async () => undefined),
  replaceSiblingMachinePeers: jest.fn(async () => undefined),
  discardCallMetricReport: jest.fn(),
  deleteCallMetricReport: jest.fn(),
  finalizeCallMetricReport: jest.fn(),
  listDueCallMetricReports: jest.fn(async () => []),
  nextCallMetricAttemptAt: jest.fn(async () => null),
  markCallMetricAnswered: jest.fn(),
  markCallMetricConnected: jest.fn(),
  openCallMetricReport: jest.fn(),
  pruneExpiredCallMetricReports: jest.fn(),
  raiseCallMetricPeak: jest.fn(),
  reconcileCallMetricReports: jest.fn(),
  recordCallMetricRetry: jest.fn(),
  touchCallMetricReport: jest.fn(),
  activeWorkspace: () => 'real',
}));

jest.mock('../src/api', () => {
  const listeners = new Set<() => void>();
  return {
    apiPostCallMetric: jest.fn(),
    onApiAuthRenewed(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    __apiMetricWake: { listeners },
  };
});

jest.mock('../src/messaging', () => {
  const listeners = new Set<() => void>();
  return {
    AUTH_TOKEN_KEY: 'authToken',
    messaging: {
      resume: jest.fn(async () => undefined),
      onTransportOpen(listener: () => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    __transportMetricWake: { listeners },
  };
});

jest.mock('../src/reauth', () => ({ currentToken: jest.fn(async () => 'token') }));
jest.mock('../src/session', () => ({ session: { mode: 'real' } }));

import * as calling from '../src/call';
import * as db from '../src/db';
import {
  callMetricDrain,
  callMetricLifecycle,
  deactivateCallMetricDrain,
} from '../src/call/metrics';

const apiWakes = (jest.requireMock('../src/api') as {
  __apiMetricWake: { listeners: Set<() => void> };
}).__apiMetricWake.listeners;
const transportWakes = (jest.requireMock('../src/messaging') as {
  __transportMetricWake: { listeners: Set<() => void> };
}).__transportMetricWake.listeners;

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

describe('call metric wakeup ownership', () => {
  beforeEach(() => {
    calling.disarmCallMetricDrainNudges();
    deactivateCallMetricDrain();
    callMetricLifecycle.deactivate();
    apiWakes.clear();
    transportWakes.clear();
    (db.listDueCallMetricReports as jest.Mock).mockClear().mockResolvedValue([]);
  });

  afterEach(() => {
    calling.disarmCallMetricDrainNudges();
    deactivateCallMetricDrain();
    callMetricLifecycle.deactivate();
    jest.useRealTimers();
  });

  it('quiesces captured callbacks, drain retry authority, and the singleton heartbeat together', async () => {
    // Mutations caught: remove any one of callback disposal, drain
    // deactivation, or lifecycle deactivation from the call-wiring boundary.
    // This is the public operation every destructive workspace seam needs;
    // testing the three owners together prevents them drifting apart again.
    jest.useFakeTimers();
    jest.setSystemTime(1_800_000_000_000);
    (db.listDueCallMetricReports as jest.Mock).mockResolvedValueOnce([
      {
        reportId: '01K2ABCDEF0123456789ABCDEF',
        payload: JSON.stringify({
          reportId: '01K2ABCDEF0123456789ABCDEF',
          occurredAt: 1_800_000_000_000,
          scope: 'direct',
          media: 'audio',
          answered: true,
          connected: true,
          outcome: 'completed',
          setupMs: 120,
          durationSeconds: 12,
        }),
        attempts: 0,
        nextAttemptAt: 1_800_000_000_000,
        endedAt: 1_800_000_000_000,
        expiresAt: 1_800_604_800_000,
      },
    ]);
    const mockedApi = jest.requireMock('../src/api') as {
      apiPostCallMetric: jest.Mock;
    };
    const mockedDb = jest.requireMock('../src/db') as {
      nextCallMetricAttemptAt: jest.Mock;
    };
    mockedApi.apiPostCallMetric.mockResolvedValueOnce({
      status: 503,
      retryAfterSeconds: null,
    });
    // retry() persists this future wake before the drain reconciles its one
    // in-memory timer with SQLite. Keep the double faithful to that boundary.
    mockedDb.nextCallMetricAttemptAt.mockResolvedValueOnce(1_800_000_005_000);

    await callMetricLifecycle.open({
      reportId: '01K2ABCDEF0123456789ABCDEG',
      localId: 'active-before-quiesce',
      scope: 'direct',
      media: 'audio',
      startedAt: 1_800_000_000_000,
    });
    await calling.activateCallMetricDrainForWorkspace();
    expect(jest.getTimerCount()).toBe(2);
    expect(apiWakes.size).toBe(1);
    expect(transportWakes.size).toBe(1);
    const staleAuth = [...apiWakes][0]!;
    const staleTransport = [...transportWakes][0]!;

    expect(() => calling.quiesceCallMetrics()).not.toThrow();

    expect(jest.getTimerCount()).toBe(0);
    expect(callMetricDrain.activeReal).toBe(false);
    expect(apiWakes.size).toBe(0);
    expect(transportWakes.size).toBe(0);
    (db.listDueCallMetricReports as jest.Mock).mockClear();
    staleAuth();
    staleTransport();
    await flush();
    expect(db.listDueCallMetricReports).not.toHaveBeenCalled();
  });

  it('registers wakes only after real activation and fences retained auth/transport callbacks across relock and re-adoption', async () => {
    // Generic calling startup has not registered an upload wake merely by
    // loading its module; App arms them only after messaging + drain adoption.
    expect(apiWakes.size).toBe(0);
    expect(transportWakes.size).toBe(0);

    await calling.activateCallMetricDrainForWorkspace();
    expect(apiWakes.size).toBe(1);
    const staleAuth = [...apiWakes][0]!;
    const staleTransport = [...transportWakes][0]!;

    calling.disarmCallMetricDrainNudges();
    deactivateCallMetricDrain();
    await calling.activateCallMetricDrainForWorkspace();
    (db.listDueCallMetricReports as jest.Mock).mockClear();

    staleAuth();
    staleTransport();
    await flush();
    expect(db.listDueCallMetricReports).not.toHaveBeenCalled();

    for (const wake of apiWakes) wake();
    for (const wake of transportWakes) wake();
    await flush();
    expect(db.listDueCallMetricReports).toHaveBeenCalledTimes(2);
  });

  it('arms finalization wakeups before the initial due snapshot can resolve', async () => {
    let releaseFirstSnapshot: ((reports: []) => void) | undefined;
    (db.listDueCallMetricReports as jest.Mock)
      .mockImplementationOnce(() => new Promise<[]>(resolve => { releaseFirstSnapshot = resolve; }))
      .mockResolvedValue([]);

    const activation = calling.activateCallMetricDrainForWorkspace();
    await flush();
    expect(db.listDueCallMetricReports).toHaveBeenCalledTimes(1);

    await callMetricLifecycle.finalize('finished-during-recovery', 'hangup', 1_800_000_000_000);
    releaseFirstSnapshot!([]);
    await activation;

    expect(db.listDueCallMetricReports).toHaveBeenCalledTimes(2);
  });

  it('a foreground resume nudge captured before await cannot drain the re-adopted workspace', async () => {
    await calling.activateCallMetricDrainForWorkspace();
    let releaseResume: (() => void) | undefined;
    const mockedMessaging = jest.requireMock('../src/messaging') as {
      messaging: { resume: jest.Mock };
    };
    mockedMessaging.messaging.resume.mockImplementationOnce(() => new Promise<void>(resolve => {
      releaseResume = resolve;
    }));

    calling.resumeCallMetricDrainAfterTransportResume();
    await flush();
    calling.disarmCallMetricDrainNudges();
    deactivateCallMetricDrain();
    await calling.activateCallMetricDrainForWorkspace();
    (db.listDueCallMetricReports as jest.Mock).mockClear();
    releaseResume!();
    await flush();

    expect(db.listDueCallMetricReports).not.toHaveBeenCalled();
  });
});
