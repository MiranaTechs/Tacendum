import { describe, expect, it, vi } from 'vitest';
import { SOURCE_LINK_REL } from '../src/handlers/auth-account.js';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { AGPL_SOURCE_URL_DEFAULT } from '@tacendum/shared';
import { MAX_BODY_BYTES } from '../src/handlers/http.js';
import { makeMemoryDb, makeTestDeps, testIdentityKey } from './helpers.js';

const db = makeMemoryDb();
const testDeps = makeTestDeps(db);

// AuthFn builds its deps via makeAuthDeps() — swap in the deterministic test
// deps (in-memory db, injected clock, captured logs).
vi.mock('../src/aws/deps.js', () => ({ makeAuthDeps: (): unknown => testDeps }));

/**
 * AWS auth Lambda adapter (src/aws/auth.lambda.ts).
 *
 * This function hosts the ONLY unauthenticated, data-touching routes in the
 * stack — POST /v1/auth/challenge and POST /v1/auth cannot require a token,
 * because they are how a token is obtained. Until now it had no adapter test at
 * all: the coverage below was written for the HTTP adapter, against
 * register/verify, and moved here when deleted those
 * routes and left this the only place the per-IP ceiling can be observed.
 */

interface LambdaResponse {
  statusCode: number;
  headers?: Record<string, string>;
  body?: string;
}

function httpEvent(over: {
  routeKey: string;
  body?: string;
  isBase64Encoded?: boolean;
  sourceIp?: string;
}): APIGatewayProxyEventV2 {
  const [method, path] = over.routeKey.split(' ');
  return {
    routeKey: over.routeKey,
    headers: {},
    ...(over.body !== undefined ? { body: over.body } : {}),
    isBase64Encoded: over.isBase64Encoded ?? false,
    requestContext: {
      http: { method, path, sourceIp: over.sourceIp ?? '127.0.0.1' },
    },
  } as unknown as APIGatewayProxyEventV2;
}

async function invoke(event: APIGatewayProxyEventV2): Promise<LambdaResponse> {
  const { handler } = await import('../src/aws/auth.lambda.js');
  return (await handler(event)) as LambdaResponse;
}

function parseError(res: LambdaResponse): { error: { code: string; detail: string } } {
  return JSON.parse(res.body ?? '') as { error: { code: string; detail: string } };
}

describe('auth.lambda adapter', () => {
  it('dispatches POST /v1/auth/challenge by routeKey to the real handler', async () => {
    const identityKey = testIdentityKey(0x41);
    const res = await invoke(
      httpEvent({
        routeKey: 'POST /v1/auth/challenge',
        body: JSON.stringify({ identityKey }),
        sourceIp: '198.51.100.1',
      }),
    );

    expect(res.statusCode).toBe(200);
    // The challenge was actually stored against the key — proof the real
    // handler ran, not just that the adapter answered 200.
    const challenge = JSON.parse(res.body ?? '').challenge as string;
    expect((await db.getAuthChallenge(identityKey, challenge))?.challenge).toBe(challenge);
  });

  it('propagates sourceIp: one IP exhausts its auth bucket while another still passes', async () => {
    // MOVED here from http.lambda.test.ts. The property is that
    // requestContext.http.sourceIp actually reaches the handler; the per-IP
    // LIMITS.auth bucket is how that becomes observable, and this is now the
    // only adapter hosting a route that uses it. Without this, the one public
    // endpoint in the stack would have its sole ceiling untested.
    const limited = '198.51.100.50';
    const other = '198.51.100.51';
    const challenge = (ip: string): Promise<LambdaResponse> =>
      invoke(
        httpEvent({
          routeKey: 'POST /v1/auth/challenge',
          body: JSON.stringify({ identityKey: testIdentityKey(0x42) }),
          sourceIp: ip,
        }),
      );

    // LIMITS.auth: capacity 30 (raised when the limiter became durable) — the burst succeeds, the 31st call 429s.
    for (let i = 0; i < 30; i++) {
      expect((await challenge(limited)).statusCode).toBe(200);
    }
    const throttled = await challenge(limited);
    expect(throttled.statusCode).toBe(429);
    expect(throttled.headers?.['retry-after']).toBeDefined();
    expect(parseError(throttled).error.code).toBe('rate_limited');

    // A different sourceIp has its own bucket — the IP must have reached the
    // handler for this to hold.
    expect((await challenge(other)).statusCode).toBe(200);
  });

  it('decodes a base64 body when isBase64Encoded is set', async () => {
    const identityKey = testIdentityKey(0x43);
    const res = await invoke(
      httpEvent({
        routeKey: 'POST /v1/auth/challenge',
        body: Buffer.from(JSON.stringify({ identityKey }), 'utf8').toString('base64'),
        isBase64Encoded: true,
        sourceIp: '198.51.100.2',
      }),
    );

    expect(res.statusCode).toBe(200);
    const challenge = (JSON.parse(res.body ?? '') as { challenge: string }).challenge;
    expect(await db.getAuthChallenge(identityKey, challenge)).toBeDefined();
  });

  it('returns 404 not_found for an unknown routeKey', async () => {
    const res = await invoke(
      httpEvent({ routeKey: 'POST /v1/auth/nonexistent', sourceIp: '198.51.100.3' }),
    );

    expect(res.statusCode).toBe(404);
    const { error } = parseError(res);
    expect(error.code).toBe('not_found');
    expect(error.detail).toBe('POST /v1/auth/nonexistent');
  });

  it('rejects a body over MAX_BODY_BYTES with 413 before invoking the route', async () => {
    // Not cosmetic on this route in particular: the identity key becomes part
    // of a DynamoDB partition key, so an unbounded body is the cheapest way to
    // push a megabyte at the one endpoint anyone can reach without a token.
    const res = await invoke(
      httpEvent({
        routeKey: 'POST /v1/auth/challenge',
        body: 'a'.repeat(MAX_BODY_BYTES + 1),
        sourceIp: '198.51.100.4',
      }),
    );

    expect(res.statusCode).toBe(413);
    expect(parseError(res).error.code).toBe('invalid_request');
  });

  it('rejects a non-canonical spelling of an identity key rather than minting a second account', async () => {
    // Two strings, one key: the DTO now requires canonical base64 for identity
    // keys because the value is used as a raw claim key and compared by string
    // equality in storeKeys. Accepting both spellings would let a client create
    // its account under one and be refused key upload against the other.
    const canonical = testIdentityKey(0x44);
    const padded = `${canonical}=`;

    const ok = await invoke(
      httpEvent({
        routeKey: 'POST /v1/auth/challenge',
        body: JSON.stringify({ identityKey: canonical }),
        sourceIp: '198.51.100.5',
      }),
    );
    expect(ok.statusCode).toBe(200);

    // Challenge rows are keyed per (key, nonce) pair, so "nothing under the
    // alternate spelling" is asserted on the write itself.
    const put = vi.spyOn(db, 'putAuthChallenge');
    const res = await invoke(
      httpEvent({
        routeKey: 'POST /v1/auth/challenge',
        body: JSON.stringify({ identityKey: padded }),
        sourceIp: '198.51.100.6',
      }),
    );
    expect(res.statusCode).toBe(400);
    expect(parseError(res).error.code).toBe('invalid_request');
    // And nothing was filed under the alternate spelling.
    expect(put).not.toHaveBeenCalled();
    put.mockRestore();
  });
});

/**
 * The AGPL source offer at the AuthFn boundary.
 *
 * is owed to every REMOTE USER of the service. The first implementation put
 * the offer at the two success exits, which quietly excluded everyone the
 * service says no to — and that is most of the population is written about:
 * the unauthenticated prober, the rate-limited bot, App Review hitting a route
 * that does not exist. The offer therefore lives at the adapter, and the
 * assertions below are one per exit this function can take, because the point
 * of a boundary is that it has no exceptions.
 *
 * Safe to apply to everything AuthFn returns because AuthFn hosts these two
 * routes and nothing else: the function boundary is the obligation's boundary.
 * The local host, which serves all twenty routes in one process, scopes by path
 * instead — see http.adapter.test.ts.
 */
describe('the AGPL source offer at the AuthFn boundary', () => {
  const LINK = `<${AGPL_SOURCE_URL_DEFAULT}>; rel="${SOURCE_LINK_REL}"`;

  it('rides a 200', async () => {
    const res = await invoke(
      httpEvent({
        routeKey: 'POST /v1/auth/challenge',
        body: JSON.stringify({ identityKey: testIdentityKey(0x51) }),
        sourceIp: '198.51.100.60',
      }),
    );

    expect(res.statusCode).toBe(200);
    expect(res.headers?.link).toBe(LINK);
    expect((JSON.parse(res.body ?? '') as { source?: string }).source).toBe(
      AGPL_SOURCE_URL_DEFAULT,
    );
  });

  it('rides a 400 the handler refuses', async () => {
    const res = await invoke(
      httpEvent({
        routeKey: 'POST /v1/auth/challenge',
        body: JSON.stringify({ identityKey: 'not-a-key' }),
        sourceIp: '198.51.100.61',
      }),
    );

    expect(res.statusCode).toBe(400);
    expect(res.headers?.link).toBe(LINK);
  });

  it('rides a 401 from a signature that does not verify', async () => {
    // A REAL challenge first. The earlier version of this test presented one
    // that had never been issued, so the handler refused it as
    // `invalid_challenge` and returned long before any signature was checked:
    // the assertion passed, and the 401 it caught was not the 401 in its name.
    // The code is pinned below so it cannot quietly drift back.
    const identityKey = testIdentityKey(0x52);
    const issued = await invoke(
      httpEvent({
        routeKey: 'POST /v1/auth/challenge',
        body: JSON.stringify({ identityKey }),
        sourceIp: '198.51.100.62',
      }),
    );
    const { challenge } = JSON.parse(issued.body ?? '') as { challenge: string };

    const res = await invoke(
      httpEvent({
        routeKey: 'POST /v1/auth',
        body: JSON.stringify({
          identityKey,
          challenge,
          signature: Buffer.alloc(64, 0x22).toString('base64'),
        }),
        sourceIp: '198.51.100.62',
      }),
    );

    expect(res.statusCode).toBe(401);
    expect(parseError(res).error.code).toBe('invalid_signature');
    expect(res.headers?.link).toBe(LINK);
  });

  it('offers the CONFIGURED url, not a constant baked into the adapter', async () => {
    // NON-VACUITY for every assertion in this describe: they all pin the
    // default, so an adapter that hard-coded that default would satisfy the lot
    // of them. asks for the source of the version actually serving the
    // caller, which is never a constant.
    const tagged = 'https://github.com/MiranaTechs/Tacendum/tree/v4.5.6';
    vi.stubEnv('TACENDUM_SOURCE_URL', tagged);
    try {
      const ok = await invoke(
        httpEvent({
          routeKey: 'POST /v1/auth/challenge',
          body: JSON.stringify({ identityKey: testIdentityKey(0x55) }),
          sourceIp: '198.51.100.67',
        }),
      );
      expect(ok.headers?.link).toBe(`<${tagged}>; rel="${SOURCE_LINK_REL}"`);
      expect((JSON.parse(ok.body ?? '') as { source?: string }).source).toBe(tagged);

      // And on an adapter-owned exit, where no handler runs at all.
      const missing = await invoke(
        httpEvent({ routeKey: 'POST /v1/auth/nope', sourceIp: '198.51.100.68' }),
      );
      expect(missing.statusCode).toBe(404);
      expect(missing.headers?.link).toBe(`<${tagged}>; rel="${SOURCE_LINK_REL}"`);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('rides the 404 for an unknown routeKey, which the handlers never see', async () => {
    // Adapter-owned exit: no handler runs, so nothing downstream of here could
    // ever have added the offer. This is the exit that proves the placement.
    const res = await invoke(
      httpEvent({ routeKey: 'POST /v1/auth/nope', sourceIp: '198.51.100.63' }),
    );

    expect(res.statusCode).toBe(404);
    expect(res.headers?.link).toBe(LINK);
  });

  it('rides the 413 for an oversized body, refused before dispatch', async () => {
    const res = await invoke(
      httpEvent({
        routeKey: 'POST /v1/auth/challenge',
        body: 'a'.repeat(MAX_BODY_BYTES + 1),
        sourceIp: '198.51.100.64',
      }),
    );

    expect(res.statusCode).toBe(413);
    expect(res.headers?.link).toBe(LINK);
  });

  it('rides the 500 when a handler throws', async () => {
    const spy = vi
      .spyOn(testDeps.db, 'putAuthChallenge')
      .mockRejectedValue(new Error('table unavailable'));
    try {
      const res = await invoke(
        httpEvent({
          routeKey: 'POST /v1/auth/challenge',
          body: JSON.stringify({ identityKey: testIdentityKey(0x53) }),
          sourceIp: '198.51.100.65',
        }),
      );

      expect(res.statusCode).toBe(500);
      expect(res.headers?.link).toBe(LINK);
    } finally {
      spy.mockRestore();
    }
  });

  it('rides the 429 when a caller has spent its per-IP bucket', async () => {
    // The rate-limited caller is the one the success-exit implementation was
    // most obviously wrong about: a client stuck in a retry loop may never see
    // a 200 at all, and it is still a remote user of this service.
    const ip = '198.51.100.66';
    const challenge = (): Promise<LambdaResponse> =>
      invoke(
        httpEvent({
          routeKey: 'POST /v1/auth/challenge',
          body: JSON.stringify({ identityKey: testIdentityKey(0x54) }),
          sourceIp: ip,
        }),
      );
    // LIMITS.auth capacity is 30; the 31st is refused.
    for (let i = 0; i < 30; i++) await challenge();
    const throttled = await challenge();

    expect(throttled.statusCode).toBe(429);
    expect(throttled.headers?.link).toBe(LINK);
    // The offer is ADDED to what the refusal already carried, never instead of
    // it: a client that loses Retry-After to a licence header is worse off.
    expect(throttled.headers?.['retry-after']).toBeDefined();
  });
});
