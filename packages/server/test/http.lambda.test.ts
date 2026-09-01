import { afterEach, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { MAX_BODY_BYTES } from '../src/handlers/http.js';
import { makeMemoryDb, makeTestDeps } from './helpers.js';

const db = makeMemoryDb();
const testDeps = makeTestDeps(db);

// The adapter builds its deps via makeAwsDeps() — swap in the deterministic
// test deps (in-memory db, injected clock, captured logs).
vi.mock('../src/aws/deps.js', () => ({ makeAwsDeps: (): unknown => testDeps }));
vi.mock('../src/aws/call-metrics.js', () => ({
  makeAwsCallMetrics: () => testDeps.callMetrics,
}));

/**
 * A live session, because EVERY route this adapter hosts is authenticated now.
 * The two public ones (the account challenge and its response) moved to AuthFn
 * when register/verify were deleted so the only way
 * to prove a real handler ran behind this adapter is to reach it with a token.
 */
const SESSION_TOKEN = 'lambda-test-token';
const SESSION_USER = 'user-lambda';
const VOIP_TOKEN = 'a'.repeat(64);

async function seedSession(): Promise<void> {
  if (await db.getSession(SESSION_TOKEN)) return;
  await db.createUser({ userId: SESSION_USER, createdAt: testDeps.now() });
  await db.createSession({
    token: SESSION_TOKEN,
    userId: SESSION_USER,
    createdAt: testDeps.now(),
    expiresAt: Math.floor(testDeps.now() / 1000) + 3600,
  });
}

function authed(): Record<string, string> {
  return { authorization: `Bearer ${SESSION_TOKEN}` };
}

function pushTokenBody(voipToken = VOIP_TOKEN): string {
  return JSON.stringify({ voipToken, env: 'sandbox', bundleId: 'com.tacendum.test' });
}

function callMetricBody(): string {
  return JSON.stringify({
    reportId: '01K2ABCDEF0123456789ABCDEF',
    occurredAt: testDeps.now(),
    scope: 'direct',
    media: 'audio',
    answered: false,
    connected: false,
    outcome: 'unanswered',
  });
}

/** The structured (non-string) member of APIGatewayProxyResultV2 the adapter returns. */
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
  headers?: Record<string, string>;
  pathParameters?: Record<string, string>;
}): APIGatewayProxyEventV2 {
  const [method, path] = over.routeKey.split(' ');
  return {
    routeKey: over.routeKey,
    headers: over.headers ?? {},
    ...(over.pathParameters !== undefined ? { pathParameters: over.pathParameters } : {}),
    ...(over.body !== undefined ? { body: over.body } : {}),
    isBase64Encoded: over.isBase64Encoded ?? false,
    requestContext: {
      http: { method, path, sourceIp: over.sourceIp ?? '127.0.0.1' },
    },
  } as unknown as APIGatewayProxyEventV2;
}

async function invoke(event: APIGatewayProxyEventV2): Promise<LambdaResponse> {
  const { handler } = await import('../src/aws/http.lambda.js');
  return (await handler(event)) as LambdaResponse;
}

function parseError(res: LambdaResponse): { error: { code: string; detail: string } } {
  return JSON.parse(res.body ?? '') as { error: { code: string; detail: string } };
}

/** Named like a real least-privilege failure so the log assertion is meaningful. */
class AccessDenied extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AccessDenied';
  }
}

/**
 * AWS HTTP Lambda adapter (src/aws/http.lambda.ts): routeKey dispatch into the
 * real pure handlers, API GW v2 -> HttpEvent mapping (base64 bodies), the
 * pre-dispatch 413 body ceiling, and the payload-free 500 path.
 */
describe('http.lambda adapter', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('dispatches PUT /v1/push-token by routeKey to the real handler behind auth', async () => {
    await seedSession();

    const res = await invoke(
      httpEvent({
        routeKey: 'PUT /v1/push-token',
        headers: authed(),
        body: pushTokenBody(),
        sourceIp: '203.0.113.1',
      }),
    );

    expect(res.statusCode).toBe(204);
    // The row landed — proof the real registerPushTokenHandler ran, not just
    // that the adapter answered with a plausible status code.
    expect((await db.getPushToken(SESSION_USER))?.voipToken).toBe(VOIP_TOKEN);
  });

  it('dispatches DELETE /v1/account by routeKey behind auth (401 without a token)', async () => {
    const res = await invoke(httpEvent({ routeKey: 'DELETE /v1/account' }));
    expect(res.statusCode).toBe(401);
  });

  it('dispatches POST /v1/call-metrics behind auth and never publishes an anonymous request', async () => {
    await seedSession();

    const authenticated = await invoke(
      httpEvent({
        routeKey: 'POST /v1/call-metrics',
        headers: authed(),
        body: callMetricBody(),
      }),
    );
    const anonymous = await invoke(
      httpEvent({ routeKey: 'POST /v1/call-metrics', body: callMetricBody() }),
    );

    expect(authenticated.statusCode).toBe(204);
    expect(anonymous.statusCode).toBe(401);
  });

  it('decodes a base64 body when isBase64Encoded is set', async () => {
    await seedSession();
    const distinct = 'b'.repeat(64);

    const res = await invoke(
      httpEvent({
        routeKey: 'PUT /v1/push-token',
        headers: authed(),
        body: Buffer.from(pushTokenBody(distinct), 'utf8').toString('base64'),
        isBase64Encoded: true,
        sourceIp: '203.0.113.2',
      }),
    );

    expect(res.statusCode).toBe(204);
    // A value only reachable by decoding the body correctly.
    expect((await db.getPushToken(SESSION_USER))?.voipToken).toBe(distinct);
  });

  // The sourceIp-propagation case MOVED to auth.lambda.test.ts rather than
  // being deleted. It asserted that requestContext.http.sourceIp reaches the
  // handler, and it proved that through the per-IP LIMITS.auth bucket on
  // register/verify. Those routes are gone and no route this adapter hosts is
  // keyed by IP any more, so the assertion has nothing to observe HERE — but
  // the property still matters on POST /v1/auth/challenge, which is where the
  // per-IP bucket now lives and where the test now runs.

  it('returns 404 not_found for an unknown routeKey', async () => {
    const res = await invoke(
      httpEvent({ routeKey: 'DELETE /v1/nonexistent', sourceIp: '203.0.113.3' }),
    );

    expect(res.statusCode).toBe(404);
    expect(res.headers).toEqual({ 'content-type': 'application/json' });
    const { error } = parseError(res);
    expect(error.code).toBe('not_found');
    expect(error.detail).toBe('DELETE /v1/nonexistent');
  });

  it('rejects a body over MAX_BODY_BYTES with 413 before invoking the route', async () => {
    await seedSession();
    const before = await db.getPushToken(SESSION_USER);

    const res = await invoke(
      httpEvent({
        routeKey: 'PUT /v1/push-token',
        headers: authed(),
        body: 'a'.repeat(MAX_BODY_BYTES + 1),
        sourceIp: '203.0.113.4',
      }),
    );

    expect(res.statusCode).toBe(413);
    expect(parseError(res).error.code).toBe('invalid_request');
    // The guard fired BEFORE dispatch: the handler never ran, so the stored
    // row is untouched rather than merely "not obviously wrong".
    expect(await db.getPushToken(SESSION_USER)).toEqual(before);
  });

  it('maps a handler throw to a payload-free 500 logged at level error', async () => {
    await seedSession();
    // A device token is the capability to ring a phone so it
    // is exactly the kind of value that must never reach logs — which makes it the
    // right marker for "did any part of the request body leak on the 500 path".
    const marker = 'f'.repeat(64);
    const rawBody = pushTokenBody(marker);
    // `mergePushToken`, which is what the register handler calls now — and
    // the very error class the merge actually produced in production, when
    // its first read-then-write shape hit the handler's deliberately
    // read-free role.
    vi.spyOn(db, 'mergePushToken').mockRejectedValueOnce(
      new AccessDenied('not authorized to perform dynamodb:UpdateItem'),
    );
    // The level is the assertion. `Deps.log` is wired to log.info, so routing
    // the 500 through it (as this adapter once did) put every REST failure on
    // stdout at level "info" while the WebSocket adapters used "error" — an
    // operator alerting on level=error would have seen none of them.
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await invoke(
      httpEvent({
        routeKey: 'PUT /v1/push-token',
        headers: authed(),
        body: rawBody,
        sourceIp: '203.0.113.5',
      }),
    );

    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body ?? '')).toEqual({
      error: { code: 'internal', detail: 'internal error' },
    });

    const emitted = stderr.mock.calls
      .map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
      .filter((line) => line.event === 'handler_error');
    expect(emitted).toHaveLength(1);
    // Exactly the route and the error NAME — nothing else.
    expect(emitted[0]).toMatchObject({
      level: 'error',
      event: 'handler_error',
      route: 'PUT /v1/push-token',
      error: 'AccessDenied',
    });
    // It must not also come back through the handlers' info-level seam.
    expect(testDeps.logs.filter((l) => l.event === 'handler_error')).toEqual([]);

    // The request payload appears nowhere in logs or the response.
    const allLogs = JSON.stringify(testDeps.logs) + JSON.stringify(stderr.mock.calls);
    expect(allLogs).not.toContain(marker);
    expect(allLogs).not.toContain(rawBody);
    expect(res.body).not.toContain(marker);
    expect(res.body).not.toContain(rawBody);
  });
});
