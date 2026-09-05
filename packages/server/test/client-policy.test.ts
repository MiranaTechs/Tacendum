/**
 * `GET /v1/client-policy`: the one route that tells a
 * phone what build it must be running.
 *
 * Three properties are load-bearing and each has cases here. It ANSWERS THE
 * SAME BYTES TO EVERYONE: no identifier goes in, none comes back, and the
 * log line carries neither. It FAILS OPEN: an absent row, a malformed row
 * and an unparseable env value all read as "no floor", so an operator typo
 * cannot brick the fleet. And it is CEILINGED per source IP, because an
 * unauthenticated route with no budget is an unauthenticated route with an
 * unbounded one.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ClientPolicyResponse } from '@tacendum/shared';
import { clientPolicyHandler } from '../src/handlers/client-policy.js';
import { LIMITS } from '../src/ratelimit.js';
import { makeMemoryDb, makeTestDeps, parseBody, type TestDeps } from './helpers.js';

const IP = '203.0.113.7';
const OTHER_IP = '198.51.100.9';

let db: ReturnType<typeof makeMemoryDb>;
let deps: TestDeps;
beforeEach(() => {
  db = makeMemoryDb();
  deps = makeTestDeps(db);
  // Neither variable is set in the deployed stack; a suite that means to
  // exercise the fallback says so explicitly rather than inheriting one.
  vi.stubEnv('TACENDUM_MIN_BUILD_IOS', '');
  vi.stubEnv('TACENDUM_MIN_BUILD_ANDROID', '');
});

const call = (sourceIp: string | undefined = IP) =>
  clientPolicyHandler(
    { method: 'GET', path: '/v1/client-policy', headers: {}, pathParameters: {}, body: null, ...(sourceIp ? { sourceIp } : {}) },
    deps,
  );

describe('the shipped default is no gate', () => {
  it('answers a zero floor on both platforms when no row and no env exist', async () => {
    const res = await call();
    expect(res.statusCode).toBe(200);
    expect(parseBody(res.body)).toEqual({ ios: { minBuild: 0 }, android: { minBuild: 0 } });
  });

  it('answers a response the shared DTO parses', async () => {
    const res = await call();
    expect(ClientPolicyResponse.safeParse(parseBody(res.body)).success).toBe(true);
  });
});

describe('the operator row', () => {
  it('is echoed field for field', async () => {
    const row = {
      ios: { minBuild: 25, latestBuild: 27, url: 'https://apps.apple.com/app/id123' },
      android: { minBuild: 24, latestBuild: 27, url: 'https://play.google.com/store/apps/details?id=x' },
      message: 'Build 25 fixes a call defect.',
    };
    db.setClientPolicyRow(row);
    const res = await call();
    expect(parseBody(res.body)).toEqual(row);
    expect(ClientPolicyResponse.safeParse(parseBody(res.body)).success).toBe(true);
  });

  it('drops fields it does not carry rather than inventing them', async () => {
    db.setClientPolicyRow({ ios: { minBuild: 25 }, android: { minBuild: 25 } });
    const res = await call();
    expect(parseBody(res.body)).toEqual({ ios: { minBuild: 25 }, android: { minBuild: 25 } });
  });

  it('BEATS the env fallback when both are present', async () => {
    vi.stubEnv('TACENDUM_MIN_BUILD_IOS', '99');
    vi.stubEnv('TACENDUM_MIN_BUILD_ANDROID', '99');
    db.setClientPolicyRow({ ios: { minBuild: 25 }, android: { minBuild: 24 } });
    const res = await call();
    expect(parseBody(res.body)).toEqual({ ios: { minBuild: 25 }, android: { minBuild: 24 } });
  });
});

describe('a malformed row is no gate, and never a throw', () => {
  // Every one of these is a plausible console typo. The answer to all of them
  // is the same as an absent row, because the alternative (a partially read
  // row) is a floor nobody wrote applied to a whole fleet.
  const malformed: Array<[string, unknown]> = [
    ['a string minBuild', { ios: { minBuild: '25' }, android: { minBuild: 0 } }],
    ['a null platform', { ios: null, android: { minBuild: 0 } }],
    ['an array', [{ minBuild: 25 }]],
    ['a missing platform', { ios: { minBuild: 25 } }],
    ['a fractional minBuild', { ios: { minBuild: 25.5 }, android: { minBuild: 0 } }],
    ['a negative minBuild', { ios: { minBuild: -1 }, android: { minBuild: 0 } }],
    ['a url that is not a url', { ios: { minBuild: 1, url: 'javascript:alert(1)' }, android: { minBuild: 1 } }],
    ['a message past 200 characters', { ios: { minBuild: 1 }, android: { minBuild: 1 }, message: 'm'.repeat(201) }],
  ];
  for (const [name, item] of malformed) {
    it(`reads ${name} as no row at all`, async () => {
      db.setClientPolicyRow(item);
      const res = await call();
      expect(res.statusCode).toBe(200);
      expect(parseBody(res.body)).toEqual({ ios: { minBuild: 0 }, android: { minBuild: 0 } });
    });
  }

  it('falls back to the ENV when the row is malformed, exactly as when it is absent', async () => {
    vi.stubEnv('TACENDUM_MIN_BUILD_IOS', '25');
    db.setClientPolicyRow({ ios: { minBuild: 'twenty-five' }, android: { minBuild: 0 } });
    const res = await call();
    expect(parseBody(res.body)).toEqual({ ios: { minBuild: 25 }, android: { minBuild: 0 } });
  });
});

describe('the env fallback', () => {
  it('gates one platform without touching the other', async () => {
    vi.stubEnv('TACENDUM_MIN_BUILD_ANDROID', '24');
    const res = await call();
    expect(parseBody(res.body)).toEqual({ ios: { minBuild: 0 }, android: { minBuild: 24 } });
  });

  it('reads an unparseable value as no gate', async () => {
    for (const raw of ['abc', '25.5', '-1', ' ', '1e3', '0x19']) {
      vi.stubEnv('TACENDUM_MIN_BUILD_IOS', raw);
      const res = await call();
      expect(parseBody<{ ios: { minBuild: number } }>(res.body).ios.minBuild, raw).toBe(0);
    }
  });

  it('accepts a plain integer with surrounding whitespace', async () => {
    vi.stubEnv('TACENDUM_MIN_BUILD_IOS', ' 25 ');
    const res = await call();
    expect(parseBody<{ ios: { minBuild: number } }>(res.body).ios.minBuild).toBe(25);
  });
});

describe('what an anonymous caller may buy', () => {
  it('needs no bearer token: the handler is not wrapped and never reads one', async () => {
    const res = await clientPolicyHandler(
      { method: 'GET', path: '/v1/client-policy', headers: {}, pathParameters: {}, body: null, sourceIp: IP },
      deps,
    );
    expect(res.statusCode).toBe(200);
  });

  it('is cacheable for five minutes', async () => {
    const res = await call();
    expect(res.headers?.['cache-control']).toBe('max-age=300');
    expect(res.headers?.['content-type']).toBe('application/json');
  });

  it('carries no identifier in the response', async () => {
    db.setClientPolicyRow({ ios: { minBuild: 25 }, android: { minBuild: 25 } });
    const res = await call();
    expect(res.body).not.toContain(IP);
    expect(Object.keys(parseBody<Record<string, unknown>>(res.body)).sort()).toEqual(['android', 'ios']);
  });

  it('writes NOTHING to the log, on any branch', async () => {
    // The only per-caller fact this route ever holds is the source IP, and
    // rule 4 does not admit it; everything else it could log is a constant
    // the operator already knows. So the honest line count is zero, and this
    // asserts the count rather than the absence of one substring; a log line
    // added later has to argue for itself here first.
    await call();
    db.setClientPolicyRow({ ios: { minBuild: 'bad' }, android: { minBuild: 0 } });
    await call(OTHER_IP);
    db.setClientPolicyRow({ ios: { minBuild: 25 }, android: { minBuild: 25 } });
    await call();
    for (let i = 0; i < LIMITS.clientPolicy.capacity + 1; i++) await call('192.0.2.4');
    expect(deps.logs).toEqual([]);
  });
});

describe("the client's cache-buster is inert here", () => {
  // The two checks a person is standing in front of ask on a query-bearing
  // URL (`?r=<reason>&t=<ms>`, app/src/api.ts) so the five minute
  // `Cache-Control` above cannot answer them with the verdict that raised the
  // wall. Nothing on this side may notice: API Gateway route keys match
  // method and path only, the local host matches `new URL(...).pathname`, and
  // this handler never reads the path at all. Pinned rather than assumed,
  // because a later handler that DID read the query would break the client's
  // only way to ask again.
  const busted = (sourceIp = IP) =>
    clientPolicyHandler(
      {
        method: 'GET',
        path: '/v1/client-policy?r=recheck&t=1800000000000',
        headers: {},
        pathParameters: {},
        body: null,
        sourceIp,
      },
      deps,
    );

  it('answers a query-bearing path with the same status, headers and bytes', async () => {
    db.setClientPolicyRow({ ios: { minBuild: 25 }, android: { minBuild: 24 } });
    const plain = await call();
    const withQuery = await busted();
    expect(withQuery.statusCode).toBe(plain.statusCode);
    expect(withQuery.headers).toEqual(plain.headers);
    expect(withQuery.body).toBe(plain.body);
  });

  it('spends the same per-IP bucket, so a query is not a way around the ceiling', async () => {
    for (let i = 0; i < LIMITS.clientPolicy.capacity; i++) await call();
    expect((await busted()).statusCode).toBe(429);
  });
});

describe('the per-IP ceiling', () => {
  it('refuses the call past the bucket with a 429 and a retry-after', async () => {
    for (let i = 0; i < LIMITS.clientPolicy.capacity; i++) {
      expect((await call()).statusCode, `call ${i}`).toBe(200);
    }
    const refused = await call();
    expect(refused.statusCode).toBe(429);
    expect(Number(refused.headers?.['retry-after'])).toBeGreaterThan(0);
  });

  it('does not let one IP spend the budget of another', async () => {
    for (let i = 0; i < LIMITS.clientPolicy.capacity; i++) await call();
    expect((await call()).statusCode).toBe(429);
    expect((await call(OTHER_IP)).statusCode).toBe(200);
  });

  it('refills: the same IP is served again once the window has passed', async () => {
    for (let i = 0; i < LIMITS.clientPolicy.capacity; i++) await call();
    expect((await call()).statusCode).toBe(429);
    deps.advanceMs(60_000);
    expect((await call()).statusCode).toBe(200);
  });

  it('collapses a missing source IP onto one bucket rather than an unbounded one', async () => {
    for (let i = 0; i < LIMITS.clientPolicy.capacity; i++) {
      expect((await call(undefined)).statusCode, `call ${i}`).toBe(200);
    }
    expect((await call(undefined)).statusCode).toBe(429);
  });
});
