import { describe, expect, it, vi } from 'vitest';
import type { APIGatewayRequestAuthorizerEvent } from 'aws-lambda';
import type { WsTicketRole } from '@tacendum/shared';
import { sessionTokenDigest } from '../src/db/data.js';
import { makeMemoryDb, makeTestDeps } from './helpers.js';

const db = makeMemoryDb();
const testDeps = makeTestDeps(db);

vi.mock('../src/aws/deps.js', () => ({ makeAwsDeps: (): unknown => testDeps }));

const METHOD_ARN = 'arn:aws:execute-api:us-east-1:123456789012:api123/prod/$connect';

function connectEvent(token?: string): APIGatewayRequestAuthorizerEvent {
  return {
    methodArn: METHOD_ARN,
    queryStringParameters: token !== undefined ? { token } : null,
  } as unknown as APIGatewayRequestAuthorizerEvent;
}

/** The query string API Gateway hands a ticket dial. */
function ticketEvent(params: Record<string, string>): APIGatewayRequestAuthorizerEvent {
  return {
    methodArn: METHOD_ARN,
    queryStringParameters: params,
  } as unknown as APIGatewayRequestAuthorizerEvent;
}

const effectOf = (r: { policyDocument: unknown }): string =>
  (r.policyDocument as { Statement: { Effect: string }[] }).Statement[0]!.Effect;

/**
 * WebSocket APIs only support REQUEST authorizers with the IAM-policy response
 * shape; the HTTP-API `isAuthorized` simple response is rejected by API
 * Gateway, which would 500 every $connect.
 */
describe('ws-authorizer.lambda handler', () => {
  it('denies a VALID session token presented as ?token= — the transitional branch is gone', async () => {
    // This used to be the Allow case. deleted the bearer-in-the-URL branch:
    // no released client exists, both clients dial ticket-first, and a 30-day
    // credential accepted from the query string was pure log-leak surface.
    const nowSeconds = Math.floor(testDeps.now() / 1000);
    await db.createSession({
      token: 'tok-valid',
      userId: 'user-9',
      createdAt: testDeps.now(),
      expiresAt: nowSeconds + 3600,
    });

    const { handler } = await import('../src/aws/ws-authorizer.lambda.js');
    const result = await handler(connectEvent('tok-valid'));

    expect(result.policyDocument).toMatchObject({
      Version: '2012-10-17',
      Statement: [{ Action: 'execute-api:Invoke', Effect: 'Deny', Resource: METHOD_ARN }],
    });
    // No principal rides out with a refusal.
    expect(result.principalId).toBe('unauthorized');
    expect(result.context?.userId).toBeUndefined();
  });

  it('returns a Deny policy for an unknown token and for a missing token', async () => {
    const { handler } = await import('../src/aws/ws-authorizer.lambda.js');

    for (const event of [connectEvent('tok-unknown'), connectEvent()]) {
      const result = await handler(event);
      expect(result.policyDocument).toMatchObject({
        Statement: [{ Action: 'execute-api:Invoke', Effect: 'Deny', Resource: METHOD_ARN }],
      });
      expect(result.context?.userId).toBeUndefined();
    }
  });
});

/**
 * THE PATH THAT SHIPS, tested HERE rather than only through the pure handler.
 *
 * This file is the AWS seam, and the seam is where the ticket work went wrong
 * twice: the authorizer role was granted GetItem while consuming a ticket needs
 * DeleteItem, and $connect re-authenticated from the URL after this function had
 * already spent the ticket. Both survived a full unit suite and four green e2e
 * gates, because every one of those exercises the LOCAL adapter — which has no
 * authorizer stage at all. `e2e.sh` check 8 cannot cover this either, for the
 * same reason: it runs `local/dev.ts`.
 *
 * So the AWS-only properties are asserted here, at the only layer that models
 * them.
 */
describe('ws-authorizer.lambda: the ticket path', () => {
  /** Mint a ticket bound to a live session — as every real mint is; a
   * digestless ticket is denied outright (fail-closed, asserted below).
   * Returns the digest too, so context assertions can name it. */
  async function mintTicket(
    userId: string,
    role: WsTicketRole = 'listen',
  ): Promise<{ ticket: string; digest: string }> {
    const token = testDeps.newAuthToken();
    await db.createSession({
      token,
      userId,
      createdAt: testDeps.now(),
      expiresAt: Math.floor(testDeps.now() / 1000) + 3600,
    });
    const ticket = testDeps.newAuthToken();
    const digest = sessionTokenDigest(token);
    await db.putWsTicket({
      ticket,
      userId,
      expiresAt: Math.floor(testDeps.now() / 1000) + 60,
      role,
      sessionDigest: digest,
    });
    return { ticket, digest };
  }

  it('allows a valid ticket and hands $connect the userId in the context', async () => {
    // The context is the ONLY thing downstream gets: $connect no longer re-reads
    // the URL, because by then the ticket is spent.
    const { ticket, digest } = await mintTicket('user-t1');
    const { handler } = await import('../src/aws/ws-authorizer.lambda.js');

    const result = await handler(ticketEvent({ ticket }));

    expect(effectOf(result)).toBe('Allow');
    expect(result.principalId).toBe('user-t1');
    // The session DIGEST rides the context too — it is how $connect
    // binds the socket to the session revocation later matches on.
    expect(result.context).toEqual({ userId: 'user-t1', role: 'listen', sessionDigest: digest });
  });

  it("carries the ticket's ROLE into the context, which is the only way it reaches $connect", async () => {
    // On AWS this stage SPENDS the ticket, so $connect cannot look the role up
    // again — and it must not be re-declared in the socket URL, where nothing
    // could check it matched the one the client authenticated for. If this
    // context field goes missing, ws.lambda.ts defaults every dial to 'listen'
    // and every one-shot `send` is back to competing for the account's single
    // routing row: the whole fix silently inert on the only host that has an
    // authorizer, with every local test still green.
    const { ticket, digest } = await mintTicket('user-t7', 'send');
    const { handler } = await import('../src/aws/ws-authorizer.lambda.js');

    const result = await handler(ticketEvent({ ticket }));

    expect(effectOf(result)).toBe('Allow');
    expect(result.context).toEqual({ userId: 'user-t7', role: 'send', sessionDigest: digest });
  });

  it('a bearer dial is refused outright, valid session or not', async () => {
    // The transitional `?token=` path used to Allow here with no role. It is
    // deleted: the ticket is the only credential this authorizer spends,
    // so the bearer dial gets the same Deny as an empty-handed one.
    await db.createSession({
      token: 'tok-roleless',
      userId: 'user-t8',
      createdAt: testDeps.now(),
      expiresAt: Math.floor(testDeps.now() / 1000) + 3600,
    });
    const { handler } = await import('../src/aws/ws-authorizer.lambda.js');

    const result = await handler(connectEvent('tok-roleless'));

    expect(effectOf(result)).toBe('Deny');
    expect(result.context?.userId).toBeUndefined();
  });

  it('spends the ticket, so a replay of the same URL is denied', async () => {
    const { ticket } = await mintTicket('user-t2');
    const { handler } = await import('../src/aws/ws-authorizer.lambda.js');

    expect(effectOf(await handler(ticketEvent({ ticket })))).toBe('Allow');
    // A captured socket URL is worth nothing precisely because of this line.
    expect(effectOf(await handler(ticketEvent({ ticket })))).toBe('Deny');
  });

  it('denies an empty ?ticket= even when a perfectly good token is alongside it', async () => {
    // `?ticket=&token=x` used to be one character away from deciding which
    // credential ended up in the URL. With the token branch deleted both
    // dials below are refused: an empty ticket is not a ticket, and a bearer
    // is not a credential this route takes any more.
    await db.createSession({
      token: 'tok-alongside',
      userId: 'user-t3',
      createdAt: testDeps.now(),
      expiresAt: Math.floor(testDeps.now() / 1000) + 3600,
    });
    const { handler } = await import('../src/aws/ws-authorizer.lambda.js');

    expect(effectOf(await handler(ticketEvent({ ticket: '', token: 'tok-alongside' })))).toBe(
      'Deny',
    );
    expect(effectOf(await handler(connectEvent('tok-alongside')))).toBe('Deny');
  });

  it('denies a spent ticket rather than falling through to a valid token', async () => {
    await db.createSession({
      token: 'tok-fallthrough',
      userId: 'user-t4',
      createdAt: testDeps.now(),
      expiresAt: Math.floor(testDeps.now() / 1000) + 3600,
    });
    const { ticket } = await mintTicket('user-t4');
    const { handler } = await import('../src/aws/ws-authorizer.lambda.js');

    expect(effectOf(await handler(ticketEvent({ ticket, token: 'tok-fallthrough' })))).toBe(
      'Allow',
    );
    // The replay carries a good bearer. Falling through would make every replay
    // a second chance at the old path.
    expect(effectOf(await handler(ticketEvent({ ticket, token: 'tok-fallthrough' })))).toBe(
      'Deny',
    );
  });

  it('reports the ticket scheme, and a refused bearer dial reports NO scheme at all', async () => {
    /*
     * The token branch is retired its `scheme: 'token'` log line went
     * with it. The ticket line stays so the connect metric is continuous —
     * and this test is now the alarm: a `ws_connect_auth` line for a bearer
     * dial means the deleted branch has somehow come back.
     */
    // `fields` is explicitly `| undefined` rather than optional: the tsconfig
    // sets exactOptionalPropertyTypes, under which an absent property and one
    // present-but-undefined are different types, and the log signature passes
    // the latter.
    const logged: Array<{ event: string; fields: Record<string, unknown> | undefined }> = [];
    const spy = vi
      .spyOn(testDeps, 'log')
      .mockImplementation((event: string, fields?: Record<string, unknown>) => {
        logged.push({ event, fields });
      });

    try {
      await db.createSession({
        token: 'tok-scheme',
        userId: 'user-t5',
        createdAt: testDeps.now(),
        expiresAt: Math.floor(testDeps.now() / 1000) + 3600,
      });
      const { ticket } = await mintTicket('user-t5');
      const { handler } = await import('../src/aws/ws-authorizer.lambda.js');

      await handler(ticketEvent({ ticket }));
      await handler(connectEvent('tok-scheme'));

      const schemes = logged
        .filter(l => l.event === 'ws_connect_auth')
        .map(l => l.fields?.scheme);
      expect(schemes).toEqual(['ticket']);

      // Never the credential itself — log hygiene makes no exception for a value
      // that only lives sixty seconds.
      const dump = JSON.stringify(logged);
      expect(dump).not.toContain(ticket);
      expect(dump).not.toContain('tok-scheme');
    } finally {
      spy.mockRestore();
    }
  });

  it('denies a ticket that carries NO bound session digest — digestless dials fail closed', async () => {
    // v1.0 has not shipped: every mint binds the caller's session, so a
    // digestless ticket is not a legacy client to protect — it would open a
    // socket no session revocation can ever match, and it is refused.
    const ticket = testDeps.newAuthToken();
    await db.putWsTicket({
      ticket,
      userId: 'user-t8',
      expiresAt: Math.floor(testDeps.now() / 1000) + 60,
      role: 'listen',
    });
    const { handler } = await import('../src/aws/ws-authorizer.lambda.js');

    const result = await handler(ticketEvent({ ticket }));

    expect(effectOf(result)).toBe('Deny');
    expect(result.context?.userId).toBeUndefined();
  });

  it('denies a ticket that has expired on the clock', async () => {
    const ticket = testDeps.newAuthToken();
    await db.putWsTicket({
      ticket,
      userId: 'user-t6',
      // Already over: DynamoDB's TTL sweep lags up to 48 hours, so expiry is a
      // code decision, not a storage one.
      expiresAt: Math.floor(testDeps.now() / 1000) - 1,
      role: 'listen',
    });
    const { handler } = await import('../src/aws/ws-authorizer.lambda.js');

    expect(effectOf(await handler(ticketEvent({ ticket })))).toBe('Deny');
  });
});
