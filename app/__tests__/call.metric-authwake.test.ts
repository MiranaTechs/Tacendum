/** The real REST listener seam plus real call wiring and drain generation. */
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
  discardCallMetricReport: jest.fn(), deleteCallMetricReport: jest.fn(),
  finalizeCallMetricReport: jest.fn(), listDueCallMetricReports: jest.fn(async () => []),
  nextCallMetricAttemptAt: jest.fn(async () => null),
  markCallMetricAnswered: jest.fn(), markCallMetricConnected: jest.fn(),
  openCallMetricReport: jest.fn(), pruneExpiredCallMetricReports: jest.fn(),
  raiseCallMetricPeak: jest.fn(), reconcileCallMetricReports: jest.fn(),
  recordCallMetricRetry: jest.fn(), touchCallMetricReport: jest.fn(),
  activeWorkspace: () => 'real',
}));

jest.mock('../src/messaging', () => ({
  AUTH_TOKEN_KEY: 'authToken',
  messaging: { onTransportOpen: jest.fn(() => () => undefined) },
}));

jest.mock('../src/reauth', () => {
  let resolve: ((value: 'ok') => void) | undefined;
  return {
    currentToken: jest.fn(async () => 'fresh-token'),
    reauthenticate: jest.fn(() => new Promise<'ok'>(done => { resolve = done; })),
    __renewal: { finish: () => resolve?.('ok') },
  };
});

jest.mock('../src/session', () => ({ session: { mode: 'real' } }));

import * as api from '../src/api';
import * as calling from '../src/call';
import * as db from '../src/db';
import { deactivateCallMetricDrain } from '../src/call/metrics';

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

afterEach(() => {
  calling.disarmCallMetricDrainNudges();
  deactivateCallMetricDrain();
});

test('a 401 begun by the old workspace cannot wake the re-adopted drain after its renewal await', async () => {
  await calling.activateCallMetricDrainForWorkspace();
  let requests = 0;
  (globalThis as unknown as { fetch: unknown }).fetch = jest.fn(async () => {
    requests++;
    return requests === 1
      ? { ok: false, status: 401, headers: { get: () => null }, json: async () => ({}) }
      : { ok: true, status: 204, headers: { get: () => null }, json: async () => ({}) };
  });
  const oldRequest = api.apiPostCallMetric('stale-token', {
    reportId: '01K2ABCDEF0123456789ABCDEF', occurredAt: 1_800_000_000_000,
    scope: 'direct', media: 'audio', answered: true, connected: true,
    outcome: 'completed', setupMs: 12, durationSeconds: 2,
  });
  await flush();

  calling.disarmCallMetricDrainNudges();
  deactivateCallMetricDrain();
  await calling.activateCallMetricDrainForWorkspace();
  (db.listDueCallMetricReports as jest.Mock).mockClear();
  (jest.requireMock('../src/reauth').__renewal as { finish(): void }).finish();
  await oldRequest;
  await flush();

  expect(db.listDueCallMetricReports).not.toHaveBeenCalled();
});
