import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyWebsocketEventV2 } from 'aws-lambda';
import { sessionTokenDigest } from '../src/db/data.js';
import { makeMemoryDb, makeTestDeps } from './helpers.js';

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

/**
 * What the REAL AWS scheduler puts on the wire to the push function.
 *
 * `ws.urgent.test.ts` covers the routing decision, but it supplies its own
 * `schedulePush`, so it can only ever prove what its own fake does. The
 * production bug lived in the adapter that fake stands in for: it was written
 * as a two-parameter arrow, TypeScript accepts a function that ignores
 * trailing parameters wherever a wider one is expected, and so every `kind`
 * and `message` the handler passed was discarded on the way to Lambda.
 *
 * `deliverPushWake` treats a missing `kind` as 'call' — deliberately, so an
 * event already in flight across a deploy keeps its old meaning — which meant
 * every message notification in production went out as a VoIP push. Three
 * consequences, none of them visible from any test that existed: no
 * notification was ever shown, the notification-service extension never
 * launched (`mutable-content` is only on the alert branch), and a device
 * holding a VoIP token rang CallKit with a full incoming-call screen for a
 * text message.
 *
 * So this test asserts on the serialised InvokeCommand payload — the actual
 * bytes — because that is the only place the dropped fields would have shown.
 */

const DOMAIN = 'ws.example.com';
const API_ID = 'abc123xyz';
const SENDER = '0000000000000000000SENDER1';
const SENDER_TOKEN = 'tok-user-sender';
const RECIPIENT = '0000000000000000000RECPT02';
const MSG = '01JBQ0000000000000000000AA';

function wsEvent(body: string): APIGatewayProxyWebsocketEventV2 {
  return {
    requestContext: {
      routeKey: '$default',
      connectionId: 'conn-sender',
      domainName: DOMAIN,
      apiId: API_ID,
      stage: 'prod',
      authorizer: { userId: SENDER, sessionDigest: sessionTokenDigest(SENDER_TOKEN) },
    },
    body,
  } as unknown as APIGatewayProxyWebsocketEventV2;
}

/** Every push payload this run put on the wire, in order. */
function invokedPayloads(): Record<string, unknown>[] {
  return lambdaSendMock.mock.calls
    .filter(
      ([cmd]) =>
        (cmd as { input?: { FunctionName?: string } }).input?.FunctionName ===
        'push-fn',
    )
    .map(([cmd]) => {
      const input = (cmd as { input: { Payload: Uint8Array } }).input;
      return JSON.parse(Buffer.from(input.Payload).toString('utf8'));
    });
}

/** The payload of the single InvokeCommand this run produced. */
function invokedPayload(): Record<string, unknown> | null {
  return invokedPayloads()[0] ?? null;
}

beforeEach(async () => {
  lambdaSendMock.mockReset();
  mgmtSendMock.mockReset();
  lambdaSendMock.mockResolvedValue({});
  process.env.PUSH_FUNCTION_NAME = 'push-fn';
  process.env.DRAIN_FUNCTION_NAME = 'drain-fn';

  for (const userId of [SENDER, RECIPIENT]) {
    await db.createUser({ userId, createdAt: testDeps.now() });
  }
  // The sender's socket is bound to a LIVE session — the $default guard
  // refuses digestless or revoked frames before any push decision runs.
  await db.createSession({
    token: SENDER_TOKEN,
    userId: SENDER,
    createdAt: testDeps.now(),
    expiresAt: Math.floor(testDeps.now() / 1000) + 3600,
  });
  await db.putPushToken({
    userId: RECIPIENT,
    alertToken: 'b'.repeat(64),
    env: 'sandbox',
    bundleId: 'com.miranatechnologies.tacendum',
    updatedAt: testDeps.now(),
    expiresAt: Math.floor(testDeps.now() / 1000) + 86_400,
  });
});

describe('the AWS push scheduler', () => {
  it('carries kind and message to the push function, not just the two ids', async () => {
    const { handler } = await import('../src/aws/ws.lambda.js');

    await handler(
      wsEvent(
        JSON.stringify({
          type: 'send',
          to: RECIPIENT,
          msgId: MSG,
          msgType: 'ciphertext',
          payload: 'QUJD',
        }),
      ),
    );

    const payload = invokedPayload();
    expect(payload).not.toBeNull();
    // The two fields that were being dropped. Without `kind`, the worker
    // defaults to 'call' and sends a VoIP ring; without `message`, it has no
    // ciphertext to hand the extension even if it took the right branch.
    expect(payload?.kind).toBe('message');
    expect(payload?.message).toMatchObject({
      msgId: MSG,
      msgType: 'ciphertext',
      payload: 'QUJD',
    });
    expect(payload?.recipientId).toBe(RECIPIENT);
    expect(payload?.senderUserId).toBe(SENDER);
  });

  it('sends a CALL wake with kind=call and no message', async () => {
    // The other branch. `kind` is explicit here rather than omitted — the
    // handler defaults its own parameter to 'call' and passes it on. The
    // field stays OPTIONAL on `PushWakeEvent` for a different reason: an
    // event already queued when a deploy lands has no `kind` at all, and
    // absence must keep meaning what it meant when it was written.
    const { handler } = await import('../src/aws/ws.lambda.js');

    await handler(
      wsEvent(
        JSON.stringify({
          type: 'send',
          to: RECIPIENT,
          msgId: MSG,
          msgType: 'ciphertext',
          payload: 'QUJD',
          urgent: true,
        }),
      ),
    );

    const payload = invokedPayload();
    expect(payload).not.toBeNull();
    expect(payload?.kind).toBe('call');
    // No ciphertext on a ring: a call wake carries routing facts only, and
    // the offer arrives over the socket.
    expect(payload?.message).toBeUndefined();
  });

  /**
   * THE SAME BYTE-LEVEL PIN, FOR THE SAME REASON, ONE FIELD LATER.
   *
   * `wakeId` is what makes a platform redelivery of the async invoke
   * distinguishable from a second scheduling decision. It is minted here, on
   * the way out — so an adapter that drops it (the exact failure this file
   * exists to catch, one parameter along) does not fail loudly; it silently
   * reverts the push worker to its pre-fix behaviour, because absence means
   * "ring, no dedup" by design. Only the wire bytes can show that.
   */
  it('mints a wakeId onto both wake kinds, fresh for every schedule', async () => {
    const { handler } = await import('../src/aws/ws.lambda.js');
    const send = (msgId: string, urgent: boolean): string =>
      JSON.stringify({
        type: 'send',
        to: RECIPIENT,
        msgId,
        msgType: 'ciphertext',
        payload: 'QUJD',
        ...(urgent ? { urgent: true } : {}),
      });

    // FRESH msgIds: the banner wake is gated on `inserted`, so replaying a
    // msgId an earlier case in this file already enqueued would silently
    // produce one payload instead of two.
    await handler(wsEvent(send('01JBQ0000000000000000000BA', false)));
    await handler(wsEvent(send('01JBQ0000000000000000000BB', true)));

    const payloads = invokedPayloads();
    expect(payloads).toHaveLength(2);
    const [banner, ring] = payloads as [Record<string, unknown>, Record<string, unknown>];
    expect(banner.kind).toBe('message');
    expect(ring.kind).toBe('call');
    // Non-empty on BOTH branches: a ring that carries no id is a ring the
    // worker cannot dedup, and a banner that carries none is arm drift.
    for (const payload of payloads) {
      expect(typeof payload.wakeId).toBe('string');
      expect((payload.wakeId as string).length).toBeGreaterThan(0);
    }
    // DIFFERENT per schedule — the whole point. A constant, or anything
    // derived from the frame, would make the second genuine wake look like a
    // redelivery of the first and silence it: denial-of-RING.
    expect(banner.wakeId).not.toBe(ring.wakeId);
  });

  /**
   * THE AWS ARM OF THE MINT RULE (mirror of `push.wakeid.mint.test.ts`).
   *
   * The case above uses two frames with DIFFERENT msgIds, which a wakeId
   * derived from `msgId` satisfies — so on its own it cannot see the mutation
   * every comment on this field warns against. The frames here are IDENTICAL,
   * because that is what a client resend of a call offer after a dropped ack
   * puts on the wire, and ws.ts deliberately refuses to gate that ring on the
   * queued row. Two schedules, two ids, or the resent offer never rings.
   */
  it('mints a DIFFERENT wakeId for a resend of one identical offer', async () => {
    const { handler } = await import('../src/aws/ws.lambda.js');
    const offer = JSON.stringify({
      type: 'send',
      to: RECIPIENT,
      msgId: '01JBQ0000000000000000000BC',
      msgType: 'ciphertext',
      payload: 'QUJD',
      urgent: true,
    });

    await handler(wsEvent(offer));
    await handler(wsEvent(offer));

    const payloads = invokedPayloads();
    // Two rings scheduled, not one: the urgent branch is deliberately NOT
    // gated on `inserted`, so the duplicate enqueue still wakes.
    expect(payloads).toHaveLength(2);
    expect(payloads[0]?.wakeId).not.toBe(payloads[1]?.wakeId);
  });
});
