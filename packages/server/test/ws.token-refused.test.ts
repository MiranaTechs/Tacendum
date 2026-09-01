import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import WebSocket from 'ws';
import type { APIGatewayRequestAuthorizerEvent } from 'aws-lambda';
import { wsConnectHandler, type WsDeps } from '../src/handlers/ws.js';
import { startWsServer } from '../src/local/ws.js';
import { makeMemoryDb, makeTestDeps, testIdentityKey, type TestDeps } from './helpers.js';
import type { DataLayer } from '../src/db/data.js';

/**
 * the transitional `?token=` scheme is GONE, on every host.
 *
 * The bearer-in-the-URL branch existed for exactly one deploy so an
 * already-running client would not be disconnected by the server updating
 * first. No released client exists — v1.0 has not
 * shipped, and both clients dial ticket-first — so the branch is now pure
 * attack surface: a 30-day credential accepted from the one place every
 * proxy, access log and crash reporter writes down.
 *
 * Every case here presents a VALID session token, because that is the only
 * dial the removal changes: a bad token was always refused. Each host must
 * refuse it the way it refuses any unauthenticated dial — Deny from the
 * authorizer, 401 from the pure handler, close 4001 from the local adapter —
 * so the tests assert the refusal, not merely the absence of the old path.
 */

const authorizerDb = makeMemoryDb();
const authorizerDeps = makeTestDeps(authorizerDb);

vi.mock('../src/aws/deps.js', () => ({ makeAwsDeps: (): unknown => authorizerDeps }));

const METHOD_ARN = 'arn:aws:execute-api:us-east-1:123456789012:api123/prod/$connect';

const effectOf = (r: { policyDocument: unknown }): string =>
  (r.policyDocument as { Statement: { Effect: string }[] }).Statement[0]!.Effect;

describe('AWS authorizer refuses a bearer in the query string', () => {
  it('denies a VALID session token presented as ?token=', async () => {
    await authorizerDb.createSession({
      token: 'tok-still-valid',
      userId: 'user-f7',
      createdAt: authorizerDeps.now(),
      expiresAt: Math.floor(authorizerDeps.now() / 1000) + 3600,
    });
    const { handler } = await import('../src/aws/ws-authorizer.lambda.js');

    const result = await handler({
      methodArn: METHOD_ARN,
      queryStringParameters: { token: 'tok-still-valid' },
    } as unknown as APIGatewayRequestAuthorizerEvent);

    expect(effectOf(result)).toBe('Deny');
    // No principal leaks out with the refusal: the context must not carry the
    // userId the (refused) token would have resolved to.
    expect(result.context?.userId).toBeUndefined();
  });
});

describe('pure $connect handler refuses a bearer in the query string', () => {
  it('answers 401 to a VALID session token presented as ?token=', async () => {
    const db = makeMemoryDb();
    const deps = makeTestDeps(db);
    const resolution = await db.getOrCreateUserByIdentityKey(
      testIdentityKey(0x31),
      deps.newUserId(),
      deps.now(),
    );
    if (resolution.kind !== 'ok') throw new Error('fixture account was not created');
    const token = deps.newAuthToken();
    await db.createSession({
      token,
      userId: resolution.user.userId,
      createdAt: deps.now(),
      expiresAt: Math.floor(deps.now() / 1000) + 3600,
    });
    const wsDeps: WsDeps = {
      ...deps,
      sender: { post: async () => true },
      scheduleDrain: async () => {},
      schedulePush: async () => {},
    };

    const result = await wsConnectHandler(
      { routeKey: '$connect', connectionId: 'conn-f7', queryStringParameters: { token } },
      wsDeps,
    );

    expect(result.statusCode).toBe(401);
    expect(result.userId).toBeUndefined();
    // And the refusal wrote no routing state for the refused dial.
    expect(await db.getConnection(resolution.user.userId)).toBeUndefined();
  });
});

describe('local adapter refuses a bearer in the query string', () => {
  let db: DataLayer;
  let deps: TestDeps;
  let server: Server;
  let wsUrl: string;
  let validToken: string;

  function dialForCloseCode(url: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      socket.on('close', (code) => resolve(code));
      socket.on('error', reject);
    });
  }

  beforeAll(async () => {
    db = makeMemoryDb();
    deps = makeTestDeps(db);
    const resolution = await db.getOrCreateUserByIdentityKey(
      testIdentityKey(0x32),
      deps.newUserId(),
      deps.now(),
    );
    if (resolution.kind !== 'ok') throw new Error('fixture account was not created');
    validToken = deps.newAuthToken();
    await db.createSession({
      token: validToken,
      userId: resolution.user.userId,
      createdAt: deps.now(),
      expiresAt: Math.floor(deps.now() / 1000) + 3600,
    });
    server = startWsServer(0, deps);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    wsUrl = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws`;
  });

  afterAll(() => {
    server?.close();
  });

  it('closes 4001 on a VALID session token presented as ?token=', async () => {
    expect(await dialForCloseCode(`${wsUrl}?token=${validToken}`)).toBe(4001);
  });
});
