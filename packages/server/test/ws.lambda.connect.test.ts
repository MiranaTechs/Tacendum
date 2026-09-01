import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyWebsocketEventV2 } from 'aws-lambda';
import { sessionTokenDigest } from '../src/db/data.js';
import { allQueued, makeMemoryDb, makeTestDeps } from './helpers.js';

const db = makeMemoryDb();
const testDeps = makeTestDeps(db);

const { lambdaSendMock, mgmtSendMock } = vi.hoisted(() => ({
  lambdaSendMock: vi.fn(),
  mgmtSendMock: vi.fn(),
}));

vi.mock('../src/aws/deps.js', () => ({ makeAwsDeps: (): unknown => testDeps }));

vi.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: class {
    send = lambdaSendMock;
  },
  InvokeCommand: class {
    readonly input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  },
}));

vi.mock('@aws-sdk/client-apigatewaymanagementapi', () => ({
  ApiGatewayManagementApiClient: class {
    send = mgmtSendMock;
  },
  PostToConnectionCommand: class {
    readonly input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  },
  GetConnectionCommand: class {
    readonly input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  },
}));

// The custom domain the client dialled. Root-mapped, so it carries NO stage
// in its path — which is exactly what made this a bug.
const DOMAIN = 'ws.example.com';
const API_ID = 'abc123xyz';
const STAGE = 'prod';
/** What the management client must be built from, whatever the client dialled. */
const MGMT_HOST = `${API_ID}.execute-api.us-east-1.amazonaws.com`;

function wsEvent(over: {
  routeKey: string;
  connectionId?: string;
  token?: string;
  userId?: string;
  role?: string;
  sessionDigest?: string;
  body?: string;
}): APIGatewayProxyWebsocketEventV2 {
  return {
    requestContext: {
      routeKey: over.routeKey,
      connectionId: over.connectionId ?? 'conn-1',
      domainName: DOMAIN,
      apiId: API_ID,
      stage: STAGE,
      ...(over.userId !== undefined
        ? {
            authorizer: {
              userId: over.userId,
              ...(over.role !== undefined ? { role: over.role } : {}),
              ...(over.sessionDigest !== undefined ? { sessionDigest: over.sessionDigest } : {}),
            },
          }
        : {}),
    },
    ...(over.token !== undefined ? { queryStringParameters: { token: over.token } } : {}),
    ...(over.body !== undefined ? { body: over.body } : {}),
  } as unknown as APIGatewayProxyWebsocketEventV2;
}

/** Bind a live session to `userId` and return its digest — every legitimate
 * authorizer context carries one (digestless connects are refused).
 * Deterministic token, so re-binding the same user is idempotent. */
async function bindSession(userId: string, suffix = ''): Promise<string> {
  const token = `tok-${userId}${suffix}`;
  await db.createSession({
    token,
    userId,
    createdAt: testDeps.now(),
    expiresAt: Math.floor(testDeps.now() / 1000) + 3600,
  });
  return sessionTokenDigest(token);
}

/**
 * API Gateway does not establish the WebSocket connection until the $connect
 * integration completes, so posting from $connect 410s on every reconnect.
 * These tests pin the fix: $connect authenticates and records the connection,
 * then schedules the drain child asynchronously — it never touches the
 * management API and never forwards the bearer token.
 */
describe('ws.lambda $connect drain scheduling', () => {
  beforeEach(() => {
    vi.stubEnv('WS_DRAIN_FUNCTION_NAME', 'tacendum-ws-drain');
    lambdaSendMock.mockReset().mockResolvedValue({ StatusCode: 202 });
    mgmtSendMock.mockReset().mockResolvedValue({});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('records the connection and async-invokes the drain child with only non-secret fields', async () => {
    // A non-empty queue is exactly the case the old code drained inline.
    await db.enqueueMessage({
      recipientId: 'user-c1',
      msgId: '01AAAAAAAAAAAAAAAAAAAAAAAA',
      senderId: 'user-other',
      type: 'ciphertext',
      payload: 'Y2lwaGVydGV4dA==',
      ts: testDeps.now(),
      expiresAt: Math.floor(testDeps.now() / 1000) + 60,
    });

    const { handler } = await import('../src/aws/ws.lambda.js');
    // NO token in the URL — this is what a ticket dial looks like by the time
    // it reaches the integration: the authorizer has already authenticated it
    // and spent the ticket, and hands the principal over in the context.
    const c1Digest = await bindSession('user-c1');
    const res = await handler(
      wsEvent({ routeKey: '$connect', userId: 'user-c1', sessionDigest: c1Digest }),
    );

    expect(res).toEqual({ statusCode: 200 });
    expect(await db.getConnection('user-c1')).toMatchObject({ connectionId: 'conn-1' });

    // Scheduled, not posted: zero management-API traffic during $connect.
    expect(mgmtSendMock).not.toHaveBeenCalled();
    expect(lambdaSendMock).toHaveBeenCalledTimes(1);

    const invoke = lambdaSendMock.mock.calls[0]?.[0] as {
      input?: { FunctionName?: string; InvocationType?: string; Payload?: Uint8Array };
    };
    expect(invoke.input?.FunctionName).toBe('tacendum-ws-drain');
    expect(invoke.input?.InvocationType).toBe('Event');
    const rawPayload = Buffer.from(invoke.input?.Payload ?? []).toString('utf8');
    // Exactly the four routing facts — nothing else, and never the token.
    //
    // `domainName` is the EXECUTE-API host, not `DOMAIN`, which is the custom
    // domain the client dialled. This assertion used to name `DOMAIN` and so
    // pinned the bug: a root-mapped custom domain plus an appended stage gave
    // `/prod/@connections/…`, which IAM read as the stage twice and denied.
    expect(JSON.parse(rawPayload)).toEqual({
      userId: 'user-c1',
      connectionId: 'conn-1',
      domainName: MGMT_HOST,
      stage: STAGE,
      // The socket's bound session rides to the drain so it (and every
      // continuation) can refuse a revoked socket. A DIGEST, never a token.
      sessionDigest: c1Digest,
    });
    expect(rawPayload).not.toContain('tok-connect');
  });

  it("reads the ticket ROLE out of the authorizer context, so a one-shot claims no row", async () => {
    // The role reaches this route only through the authorizer context — the
    // authorizer SPENT the ticket, so $connect cannot look it up, and it must
    // not be re-declared in the socket URL where nothing could check it agreed.
    // If this route drops the context field, every AWS dial arbitrates as a
    // listener and the one-shot `send` is back to taking the account's routing
    // row and deleting it again on the way out — with the whole local suite
    // still green, because the local adapter has no authorizer stage at all.
    await db.putConnection({
      userId: 'user-role',
      connectionId: 'conn-incumbent',
      connectedAt: testDeps.now(),
      sessionDigest: await bindSession('user-role'),
    });
    const { handler } = await import('../src/aws/ws.lambda.js');

    const res = await handler(
      wsEvent({
        routeKey: '$connect',
        connectionId: 'conn-oneshot',
        userId: 'user-role',
        role: 'send',
        sessionDigest: await bindSession('user-role'),
      }),
    );

    expect(res).toEqual({ statusCode: 200 });
    // Untouched, and never probed: a 'send' dial does not read the row at all.
    expect(await db.getConnection('user-role')).toMatchObject({
      connectionId: 'conn-incumbent',
    });
    expect(mgmtSendMock).not.toHaveBeenCalled();
  });

  it('defaults a context with no role to listen', async () => {
    // A roleless context is a connection authorized before roles existed (or
    // by a previous deploy's authorizer) and still live. Defaulting to 'send'
    // would silently stop routing to a client that is already running;
    // 'listen' is the behaviour it has always had.
    await db.putConnection({
      userId: 'user-roleless',
      connectionId: 'conn-incumbent-2',
      connectedAt: testDeps.now(),
      // Digest-bearing, so the incumbent is probed rather than displaced —
      // a digestless row would be torn out from under this test's premise.
      sessionDigest: await bindSession('user-roleless'),
    });
    mgmtSendMock.mockResolvedValue({}); // the incumbent answers the probe
    const { handler } = await import('../src/aws/ws.lambda.js');

    const res = await handler(
      wsEvent({
        routeKey: '$connect',
        connectionId: 'conn-second',
        userId: 'user-roleless',
        // A DIFFERENT session of the same account: a dial from the SAME
        // session now displaces its own row without a probe (the same-session
        // takeover, gate.connrow), which would satisfy this test's 503→200 in
        // a way that says nothing about the role default. Cross-session, the
        // listener arbitration still probes and still spares — the observable
        // this test needs a roleless dial to produce.
        sessionDigest: await bindSession('user-roleless', '-second'),
      }),
    );

    // Arbitrated as a listener: it probed the live incumbent and was refused.
    expect(res).toEqual({ statusCode: 503 });
    expect(mgmtSendMock).toHaveBeenCalled();
  });

  it('refuses a $connect carrying no authorizer principal', async () => {
    // API Gateway cannot deliver this — the authorizer runs first and a Deny
    // stops the request — so it is defence in depth rather than a live path.
    // It is asserted because the alternative to trusting the context is
    // re-deriving identity from the URL, which is what this change removed:
    // the authorizer has already SPENT the single-use ticket, so a second
    // lookup here would refuse the connection API Gateway had just allowed.
    const { handler } = await import('../src/aws/ws.lambda.js');
    const res = await handler(
      wsEvent({ routeKey: '$connect', connectionId: 'conn-bad', token: 'tok-nope' }),
    );

    expect(res).toEqual({ statusCode: 401 });
    expect(lambdaSendMock).not.toHaveBeenCalled();
    expect(mgmtSendMock).not.toHaveBeenCalled();
  });

  it('fails the $connect when the drain cannot be scheduled', async () => {
    lambdaSendMock.mockRejectedValueOnce(
      Object.assign(new Error('invoke failed'), { name: 'ServiceException' }),
    );

    const { handler } = await import('../src/aws/ws.lambda.js');
    const res = await handler(
      wsEvent({
        routeKey: '$connect',
        connectionId: 'conn-2',
        userId: 'user-c2',
        sessionDigest: await bindSession('user-c2'),
      }),
    );

    // 500 makes the client retry the connect instead of sitting on an
    // undrained queue that nothing will ever replay.
    expect(res).toEqual({ statusCode: 500 });
    expect(mgmtSendMock).not.toHaveBeenCalled();
  });

  it('$default still posts through the management API and never schedules a drain', async () => {
    await db.createUser({ userId: '0000000000000000000R000001', createdAt: testDeps.now() });
    // The sender needs a row too: a senderUserId with no account is refused
    // outright (deleted-mid-socket fails closed).
    await db.createUser({ userId: 'user-c3', createdAt: testDeps.now() });

    // Offline recipient: the frame queues and the sender's receipt goes out
    // over PostToConnection — live routing is untouched by the connect fix.
    const { handler } = await import('../src/aws/ws.lambda.js');
    const res = await handler(
      wsEvent({
        routeKey: '$default',
        connectionId: 'conn-3',
        userId: 'user-c3',
        sessionDigest: await bindSession('user-c3'),
        body: JSON.stringify({
          type: 'send',
          to: '0000000000000000000R000001',
          msgId: '01BBBBBBBBBBBBBBBBBBBBBBBB',
          msgType: 'ciphertext',
          payload: 'Y2lwaGVydGV4dA==',
        }),
      }),
    );

    expect(res).toEqual({ statusCode: 200 });
    expect(lambdaSendMock).not.toHaveBeenCalled();
    expect(mgmtSendMock).toHaveBeenCalledTimes(1);
  });
});

/**
 * Route coverage beyond $connect: $disconnect cleanup and the authorizer guard.
 * API Gateway caches the $connect authorizer context and attaches it to every
 * later route; when it is missing (or empty), $disconnect must skip cleanup
 * without throwing and $default must refuse the frame before touching it.
 */
describe('ws.lambda $disconnect and authorizer guards', () => {
  beforeEach(() => {
    lambdaSendMock.mockReset().mockResolvedValue({ StatusCode: 202 });
    mgmtSendMock.mockReset().mockResolvedValue({});
  });

  it('$disconnect with an authorizer userId deletes the connection row', async () => {
    await db.putConnection({
      userId: 'user-d1',
      connectionId: 'conn-d1',
      connectedAt: testDeps.now(),
    });

    const { handler } = await import('../src/aws/ws.lambda.js');
    const res = await handler(
      wsEvent({ routeKey: '$disconnect', connectionId: 'conn-d1', userId: 'user-d1' }),
    );

    expect(res).toEqual({ statusCode: 200 });
    expect(await db.getConnection('user-d1')).toBeUndefined();
  });

  it('$disconnect without an authorizer context returns 200 and touches nothing', async () => {
    await db.putConnection({
      userId: 'user-d2',
      connectionId: 'conn-d2',
      connectedAt: testDeps.now(),
    });

    const { handler } = await import('../src/aws/ws.lambda.js');
    const res = await handler(wsEvent({ routeKey: '$disconnect', connectionId: 'conn-d2' }));

    // No principal, no guess: the pre-existing row for another user survives.
    expect(res).toEqual({ statusCode: 200 });
    expect(await db.getConnection('user-d2')).toMatchObject({ connectionId: 'conn-d2' });
  });

  it('$default without an authorizer context returns 401 and never processes the frame', async () => {
    const { handler } = await import('../src/aws/ws.lambda.js');
    const res = await handler(
      wsEvent({
        routeKey: '$default',
        connectionId: 'conn-noauth',
        body: JSON.stringify({
          type: 'send',
          to: '0000000000000000000R200002',
          msgId: '01CCCCCCCCCCCCCCCCCCCCCCCC',
          msgType: 'ciphertext',
          payload: 'Y2lwaGVydGV4dA==',
        }),
      }),
    );

    expect(res).toEqual({ statusCode: 401 });
    // The frame body never reached the handler: nothing enqueued, nothing posted.
    expect(await allQueued(db, '0000000000000000000R200002')).toEqual([]);
    expect(mgmtSendMock).not.toHaveBeenCalled();
    expect(lambdaSendMock).not.toHaveBeenCalled();
  });

  it('treats an empty-string authorizer userId exactly like a missing one', async () => {
    const { handler } = await import('../src/aws/ws.lambda.js');
    const res = await handler(
      wsEvent({
        routeKey: '$default',
        connectionId: 'conn-empty',
        userId: '',
        body: JSON.stringify({
          type: 'send',
          to: '0000000000000000000R200002',
          msgId: '01DDDDDDDDDDDDDDDDDDDDDDDD',
          msgType: 'ciphertext',
          payload: 'Y2lwaGVydGV4dA==',
        }),
      }),
    );

    expect(res).toEqual({ statusCode: 401 });
    expect(await allQueued(db, '0000000000000000000R200002')).toEqual([]);
    expect(mgmtSendMock).not.toHaveBeenCalled();
    expect(lambdaSendMock).not.toHaveBeenCalled();
  });
});


/**
 * The management endpoint must be built from the execute-api host, never from
 * the host the client dialled.
 *
 * This API is fronted by a custom domain mapped at the root. Using
 * `requestContext.domainName` produced `https://ws.tacendum.com/prod`, so every
 * management call addressed `/prod/@connections/…` and IAM evaluated it as
 * `<api>/prod/POST/prod/@connections/*` — the stage twice — against a grant of
 * `<api>/prod/POST/@connections/*`. Every post and every GetConnection was
 * denied with AccessDeniedException.
 *
 * Nothing failed loudly: the drain treats the exception as a failed drain,
 * leaves the queue for "the next reconnect", and the recipient simply never
 * receives anything. It survived every existing test because the local adapter
 * has no API Gateway and the CLI e2e never uses one. Two real phones found it.
 */
describe('the management endpoint is the execute-api host, not the dialled one', () => {
  beforeEach(() => {
    vi.stubEnv('WS_DRAIN_FUNCTION_NAME', 'tacendum-ws-drain');
    vi.stubEnv('AWS_REGION', 'us-east-1');
    lambdaSendMock.mockReset().mockResolvedValue({ StatusCode: 202 });
    mgmtSendMock.mockReset().mockResolvedValue({});
  });

  it('hands the drain child the execute-api host, not the custom domain', async () => {
    const { handler } = await import('../src/aws/ws.lambda.js');

    await handler(
      wsEvent({
        routeKey: '$connect',
        userId: 'user-endpoint',
        sessionDigest: await bindSession('user-endpoint'),
      }),
    );

    const invoke = lambdaSendMock.mock.calls[0]?.[0] as { input: { Payload: string } };
    const payload = JSON.parse(invoke.input.Payload) as { domainName: string };

    expect(payload.domainName).toBe(MGMT_HOST);
    // The dialled host must NOT survive into the drain: appending the stage to
    // a root-mapped custom domain is what doubled it.
    expect(payload.domainName).not.toBe(DOMAIN);
    expect(payload.domainName).not.toContain('ws.example.com');
  });
});
