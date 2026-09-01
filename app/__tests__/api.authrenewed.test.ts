jest.mock('../src/reauth', () => {
  let complete: ((value: 'ok') => void) | undefined;
  return {
    currentToken: jest.fn(async () => 'fresh-token'),
    reauthenticate: jest.fn(() => new Promise<'ok'>(resolve => { complete = resolve; })),
    __renewal: {
      finish() { complete?.('ok'); },
    },
  };
});

import { API_BASE } from '../src/config';

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

test('a renewal notifies the listener snapshot from the request generation, never one armed while it awaited', async () => {
  jest.resetModules();
  const api = jest.requireActual('../src/api') as typeof import('../src/api');
  const renewal = jest.requireMock('../src/reauth').__renewal as { finish(): void };
  let requests = 0;
  (globalThis as unknown as { fetch: unknown }).fetch = jest.fn(async () => {
    requests++;
    return requests === 1
      ? { ok: false, status: 401, headers: { get: () => null }, json: async () => ({}) }
      : { ok: true, status: 204, headers: { get: () => null }, json: async () => ({}) };
  });
  const oldGeneration = jest.fn();
  const removeOld = api.onApiAuthRenewed(oldGeneration);
  const pending = api.apiPostCallMetric('stale-token', {
    reportId: '01K2ABCDEF0123456789ABCDEF', occurredAt: 1_800_000_000_000,
    scope: 'direct', media: 'audio', answered: true, connected: true,
    outcome: 'completed', setupMs: 12, durationSeconds: 2,
  });
  await flush();

  removeOld();
  const replacementGeneration = jest.fn();
  api.onApiAuthRenewed(replacementGeneration);
  renewal.finish();
  await expect(pending).resolves.toEqual({ status: 204, retryAfterSeconds: null });

  expect(oldGeneration).toHaveBeenCalledTimes(1);
  expect(replacementGeneration).not.toHaveBeenCalled();
  expect(globalThis.fetch).toHaveBeenCalledWith(`${API_BASE}/v1/call-metrics`, expect.anything());
});
