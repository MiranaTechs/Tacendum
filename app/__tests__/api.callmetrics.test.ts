import { API_BASE } from '../src/config';

jest.mock('../src/db', () => ({ loadProfile: jest.fn(async () => null) }));

describe('apiPostCallMetric', () => {
  let api: typeof import('../src/api');
  const report = {
    reportId: '01K2ABCDEF0123456789ABCDEF', occurredAt: 1_800_000_000_000,
    scope: 'direct', media: 'audio', answered: true, connected: true,
    outcome: 'completed', setupMs: 12, durationSeconds: 2,
  } as const;

  beforeEach(() => {
    jest.resetModules();
    api = jest.requireActual('../src/api') as typeof import('../src/api');
    (globalThis as unknown as { fetch: unknown }).fetch = jest.fn(async () => ({
      ok: true, status: 204, headers: { get: () => null }, json: async () => ({}),
    }));
  });

  it('posts the immutable report with its bearer and exposes response metadata', async () => {
    await expect(api.apiPostCallMetric('metric-bearer', report)).resolves.toEqual({ status: 204, retryAfterSeconds: null });
    expect(globalThis.fetch).toHaveBeenCalledWith(`${API_BASE}/v1/call-metrics`, expect.objectContaining({
      method: 'POST', headers: expect.objectContaining({ authorization: 'Bearer metric-bearer' }),
      body: JSON.stringify(report),
    }));
  });

  it('keeps 401 outside allowStatus so request renews once before surfacing a final refusal', async () => {
    const reauth = jest.requireActual('../src/reauth') as typeof import('../src/reauth');
    jest.spyOn(reauth, 'reauthenticate').mockResolvedValue('error');
    (globalThis.fetch as jest.Mock).mockResolvedValueOnce({ ok: false, status: 401, headers: { get: () => null }, json: async () => ({}) });
    await expect(api.apiPostCallMetric('metric-bearer', report)).resolves.toEqual({ status: 401, retryAfterSeconds: null });
    expect(reauth.reauthenticate).toHaveBeenCalledWith('metric-bearer');
  });

  it('accepts only a non-negative numeric Retry-After', async () => {
    (globalThis.fetch as jest.Mock).mockResolvedValueOnce({ ok: false, status: 429, headers: { get: () => '9' }, json: async () => ({}) });
    await expect(api.apiPostCallMetric('metric-bearer', report)).resolves.toEqual({ status: 429, retryAfterSeconds: 9 });
  });
});
