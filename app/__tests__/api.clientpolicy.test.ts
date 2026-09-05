/**
 * THE UPDATE CHECK'S URL, PER REASON (follow-up).
 *
 * The server answers `GET /v1/client-policy` with `Cache-Control: max-age=300`,
 * which is the right answer for the two checks nobody is standing in front of
 * — the boot one and the throttled foreground one — and the wrong answer for
 * the two they are. A person who taps "Check again" on the wall, or "Get
 * started" on the landing screen, is asking BECAUSE the last answer was a
 * refusal; being handed that same refusal back out of the HTTP cache for the
 * next five minutes makes the only control on the screen look broken, and on
 * the landing screen it can wall off a phone the operator has already
 * unblocked.
 *
 * So the reason decides the URL, and the URL is what this file pins: the two
 * waited-on reasons carry a unique query, the two background ones stay on the
 * cacheable path. Driven through the REAL `request()` against a scripted
 * fetch, exactly as api.serverahead.test.ts does, because the URL is the
 * transport's business and nothing above it can see it.
 */

jest.mock('../src/db', () => ({ loadProfile: jest.fn(async () => null) }));

import { apiClientPolicy } from '../src/api';
import { API_BASE } from '../src/config';

/** A policy the shipped schema parses, with no floor on either store. */
const POLICY = { ios: { minBuild: 0 }, android: { minBuild: 0 } };

/** Every path fetched this test, API_BASE stripped, in order. */
let paths: string[] = [];

beforeEach(() => {
  paths = [];
  (globalThis as unknown as { fetch: unknown }).fetch = jest.fn(
    async (url: string) => {
      paths.push(String(url).slice(API_BASE.length));
      return {
        ok: true,
        status: 200,
        json: async () => POLICY,
        text: async () => JSON.stringify(POLICY),
      } as unknown as Response;
    },
  );
});

test('the checks nobody is waiting on keep the cacheable URL', async () => {
  await apiClientPolicy('enterWorkspace');
  await apiClientPolicy('foreground');
  // No reason at all is the same URL: a caller that does not say it is being
  // waited on is not.
  await apiClientPolicy();
  expect(paths).toEqual([
    '/v1/client-policy',
    '/v1/client-policy',
    '/v1/client-policy',
  ]);
});

test('the two checks a person is standing in front of cannot be answered from a cache', async () => {
  const now = jest.spyOn(Date, 'now');
  try {
    now.mockReturnValue(1_800_000_000_000);
    await apiClientPolicy('recheck');
    now.mockReturnValue(1_800_000_000_001);
    await apiClientPolicy('getStarted');
  } finally {
    now.mockRestore();
  }
  expect(paths).toEqual([
    '/v1/client-policy?r=recheck&t=1800000000000',
    '/v1/client-policy?r=getStarted&t=1800000000001',
  ]);
});

test('two presses of the same control are two different URLs', async () => {
  // A clock the test moves, rather than the wall clock: two presses inside
  // one millisecond would otherwise pass this by accident and fail it by
  // accident, and the property under test is that the stamp is the CURRENT
  // time, not that two calls happen to straddle a tick.
  const now = jest.spyOn(Date, 'now');
  try {
    now.mockReturnValue(1_800_000_000_000);
    await apiClientPolicy('recheck');
    now.mockReturnValue(1_800_000_000_500);
    await apiClientPolicy('recheck');
  } finally {
    now.mockRestore();
  }
  expect(paths).toHaveLength(2);
  // Both are the busted shape, and they differ — a stamp that repeated would
  // be a cache key that repeated, which is the whole defect.
  for (const path of paths) {
    expect(path).toMatch(/^\/v1\/client-policy\?r=recheck&t=\d+$/);
  }
  expect(new Set(paths).size).toBe(2);
});

test('the answer parses the same whichever URL asked for it', async () => {
  await expect(apiClientPolicy('recheck')).resolves.toEqual(POLICY);
  await expect(apiClientPolicy('foreground')).resolves.toEqual(POLICY);
});
