import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GetConnectionCommand,
  PostToConnectionCommand,
} from '@aws-sdk/client-apigatewaymanagementapi';
import type { ServerFrame } from '@tacendum/shared';
import { sessionTokenDigest } from '../src/db/data.js';
import { log } from '../src/log.js';
import { allQueued, makeMemoryDb, makeTestDeps } from './helpers.js';

const db = makeMemoryDb();
const testDeps = makeTestDeps(db);

const { mgmtSendMock, lambdaSendMock } = vi.hoisted(() => ({
  mgmtSendMock: vi.fn(),
  lambdaSendMock: vi.fn(),
}));

vi.mock('../src/aws/deps.js', () => ({ makeAwsDeps: (): unknown => testDeps }));

// #5 — the drain self-invokes to continue past its per-invocation budget. Mock
// the Lambda client so the continuation is observable and never actually
// re-runs; InvokeCommand records the JSON payload it was handed.
vi.mock('@aws-sdk/client-lambda', () => ({
  LambdaClient: class {
    send = lambdaSendMock;
  },
  InvokeCommand: class {
    readonly input: { FunctionName?: string; Payload?: Uint8Array };
    constructor(input: { FunctionName?: string; Payload?: Uint8Array }) {
      this.input = input;
    }
  },
}));

/** Decode the WsDrainEvent payload of the Nth (default last) self-invoke. */
function continuationPayload(nth = -1): Record<string, unknown> | undefined {
  const calls = lambdaSendMock.mock.calls;
  const call = nth < 0 ? calls.at(nth) : calls[nth];
  const cmd = call?.[0] as { input?: { Payload?: Uint8Array } } | undefined;
  if (!cmd?.input?.Payload) return undefined;
  return JSON.parse(Buffer.from(cmd.input.Payload).toString('utf8')) as Record<string, unknown>;
}

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
  // The revoked-session teardown hangs the socket up through the management
  // API (disconnectorFor); the class must exist for that path to construct.
  DeleteConnectionCommand: class {
    readonly input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  },
}));

function goneError(): Error {
  return Object.assign(new Error('connection gone'), { name: 'GoneException' });
}

/** Route the shared client mock: scripted GetConnection outcomes, recorded
 * PostToConnection frames (optionally scripted to fail). */
function scriptManagementApi(opts: {
  getOutcomes: Array<'gone' | 'ok'>;
  postOutcomes?: Array<'gone' | 'ok'>;
}): { posts: Array<{ connectionId: string; frame: ServerFrame }>; getCalls: () => number } {
  const posts: Array<{ connectionId: string; frame: ServerFrame }> = [];
  let getCalls = 0;
  mgmtSendMock.mockImplementation(async (cmd: unknown) => {
    if (cmd instanceof GetConnectionCommand) {
      getCalls += 1;
      const outcome = opts.getOutcomes.shift() ?? 'gone';
      if (outcome === 'gone') throw goneError();
      return { ConnectedAt: new Date(0) };
    }
    if (cmd instanceof PostToConnectionCommand) {
      const input = (cmd as { input: { ConnectionId: string; Data: Uint8Array } }).input;
      const outcome = opts.postOutcomes?.shift() ?? 'ok';
      if (outcome === 'gone') throw goneError();
      posts.push({
        connectionId: input.ConnectionId,
        frame: JSON.parse(Buffer.from(input.Data).toString('utf8')) as ServerFrame,
      });
      return {};
    }
    throw new Error('unexpected command');
  });
  return { posts, getCalls: () => getCalls };
}

async function seedQueue(userId: string, msgIds: string[]): Promise<void> {
  // Insert out of msgId order: the drain must sort, not rely on insertion.
  for (const msgId of [...msgIds].reverse()) {
    await db.enqueueMessage({
      recipientId: userId,
      msgId,
      senderId: 'user-sender',
      type: 'ciphertext',
      payload: 'Y2lwaGVydGV4dA==',
      ts: testDeps.now(),
      expiresAt: Math.floor(testDeps.now() / 1000) + 60,
    });
  }
}

const EVENT = {
  userId: 'user-d1',
  connectionId: 'conn-d1',
  domainName: 'ws.example.com',
  stage: 'prod',
};

/** Bind a live session to `userId` and return its digest. Every legitimate
 * drain event carries one (digestless events are refused outright), so
 * tests about OTHER drain properties bind a session to get past the guard.
 * Deterministic token, so re-binding the same user is idempotent. */
async function bindSession(userId: string): Promise<string> {
  const token = `tok-${userId}`;
  await db.createSession({
    token,
    userId,
    createdAt: testDeps.now(),
    expiresAt: Math.floor(testDeps.now() / 1000) + 3600,
  });
  return sessionTokenDigest(token);
}

/**
 * The drain child is invoked asynchronously from $connect and can start before
 * API Gateway finishes the handshake — GetConnection reports Gone until the
 * $connect integration response goes out. These tests pin the bounded wait and
 * the drain semantics (msgId order, no deletes, stop on dead socket).
 */
describe('ws-drain.lambda handler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mgmtSendMock.mockReset();
    lambdaSendMock.mockReset();
    lambdaSendMock.mockResolvedValue({});
    // The drain self-invokes under its own function name (set by the Lambda
    // runtime in production); pin it so the continuation path is exercised.
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'tacendum-ws-drain';
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.AWS_LAMBDA_FUNCTION_NAME;
  });

  it('retries GetConnection until the handshake completes, then drains in msgId order without deleting', async () => {
    await seedQueue('user-d1', ['01MSGA', '01MSGB', '01MSGC']);
    const api = scriptManagementApi({ getOutcomes: ['gone', 'gone', 'ok'] });

    const { handler } = await import('../src/aws/ws-drain.lambda.js');
    const run = handler({ ...EVENT, sessionDigest: await bindSession('user-d1') });
    await vi.runAllTimersAsync();
    await run;

    expect(api.getCalls()).toBe(3);
    expect(api.posts.map((p) => p.connectionId)).toEqual(['conn-d1', 'conn-d1', 'conn-d1']);
    expect(api.posts.map((p) => (p.frame.type === 'msg' ? p.frame.msgId : ''))).toEqual([
      '01MSGA',
      '01MSGB',
      '01MSGC',
    ]);
    expect(api.posts[0]?.frame).toMatchObject({
      type: 'msg',
      from: 'user-sender',
      msgType: 'ciphertext',
      payload: 'Y2lwaGVydGV4dA==',
    });
    // Drain never deletes; only a client ack does.
    expect(await allQueued(db, 'user-d1')).toHaveLength(3);
  });

  it('a context already inside its safety margin posts NOTHING and hands the unchanged slice to a fresh invocation', async () => {
    await seedQueue('user-d10', ['01MSGD', '01MSGE', '01MSGF']);
    await db.putConnection({
      userId: 'user-d10',
      connectionId: 'conn-d10',
      connectedAt: testDeps.now(),
    });
    const api = scriptManagementApi({ getOutcomes: ['ok'] });

    const { handler } = await import('../src/aws/ws-drain.lambda.js');
    // A context already inside its safety margin: the deadline would compute to
    // "now". The first live row must NOT be posted on a spent clock — the drain
    // posts nothing and hands the WHOLE slice (the unchanged event, no
    // afterMsgId, no progress claimed) to a fresh invocation with a full clock.
    const run = handler(
      { ...EVENT, userId: 'user-d10', connectionId: 'conn-d10', sessionDigest: await bindSession('user-d10') },
      { getRemainingTimeInMillis: () => 0 },
    );
    await vi.runAllTimersAsync();
    await run;

    // Nothing posted on a spent clock.
    expect(api.posts).toHaveLength(0);
    // The whole slice handed off: a continuation carrying the UNCHANGED event
    // (no afterMsgId) and the validated session digest.
    expect(lambdaSendMock).toHaveBeenCalledTimes(1);
    const payload = continuationPayload();
    expect(payload).toMatchObject({ userId: 'user-d10', connectionId: 'conn-d10' });
    expect(payload).not.toHaveProperty('afterMsgId');
    // Not socket death: the row survives (only socket_gone reaps it) and the
    // queue is untouched.
    expect(await db.getConnection('user-d10')).toMatchObject({ connectionId: 'conn-d10' });
    expect(await allQueued(db, 'user-d10')).toHaveLength(3);
  });

  it('gives up after the bounded retry budget when the connection never establishes', async () => {
    const api = scriptManagementApi({ getOutcomes: [] }); // always gone

    const { handler, CONNECT_RETRY_DELAYS_MS } = await import('../src/aws/ws-drain.lambda.js');
    const run = handler({ ...EVENT, userId: 'user-d2', connectionId: 'conn-d2', sessionDigest: await bindSession('user-d2') });
    await vi.runAllTimersAsync();
    await expect(run).resolves.toBeUndefined();

    // One immediate probe plus one per backoff step — then stop for good; the
    // queue stays put and the next $connect schedules a fresh drain.
    expect(api.getCalls()).toBe(CONNECT_RETRY_DELAYS_MS.length + 1);
    expect(api.posts).toHaveLength(0);
  });

  it('does not write connection or user identifiers to the stale-handshake log', async () => {
    const infoSpy = vi.spyOn(log, 'info').mockImplementation(() => {});
    scriptManagementApi({ getOutcomes: [] });

    const { handler } = await import('../src/aws/ws-drain.lambda.js');
    const run = handler({
      ...EVENT,
      userId: 'user-private',
      connectionId: 'conn-private',
      sessionDigest: await bindSession('user-private'),
    });
    await vi.runAllTimersAsync();
    await run;

    expect(infoSpy).toHaveBeenCalledWith('ws_drain_connection_gone', {});
    const serialized = JSON.stringify(infoSpy.mock.calls);
    expect(serialized).not.toContain('user-private');
    expect(serialized).not.toContain('conn-private');
    infoSpy.mockRestore();
  });

  it('stops the drain at the first dead-socket post and keeps the rest queued', async () => {
    await seedQueue('user-d3', ['01MSGX', '01MSGY', '01MSGZ']);
    const api = scriptManagementApi({
      getOutcomes: ['ok'],
      postOutcomes: ['ok', 'gone'],
    });

    const { handler } = await import('../src/aws/ws-drain.lambda.js');
    const run = handler({ ...EVENT, userId: 'user-d3', connectionId: 'conn-d3', sessionDigest: await bindSession('user-d3') });
    await vi.runAllTimersAsync();
    await run;

    // First frame delivered, second hit a dead socket, third never attempted.
    expect(api.posts.map((p) => (p.frame.type === 'msg' ? p.frame.msgId : ''))).toEqual(['01MSGX']);
    expect(
      mgmtSendMock.mock.calls.filter(([cmd]) => cmd instanceof PostToConnectionCommand),
    ).toHaveLength(2);
    expect(await allQueued(db, 'user-d3')).toHaveLength(3);
  });

  it('never replays a message whose TTL has passed even if DynamoDB has not reaped it', async () => {
    // TTL deletion is eventual: rows at/past expiresAt can still be returned
    // by Query, so the drain must filter on the clock, not trust the table.
    const nowSec = Math.floor(testDeps.now() / 1000);
    const enqueue = (msgId: string, expiresAt: number) =>
      db.enqueueMessage({
        recipientId: 'user-d5',
        msgId,
        senderId: 'user-sender',
        type: 'ciphertext',
        payload: 'Y2lwaGVydGV4dA==',
        ts: testDeps.now(),
        expiresAt,
      });
    await enqueue('01MSGP', nowSec); // at the boundary: expired
    await enqueue('01MSGQ', nowSec + 1); // just above: live
    const api = scriptManagementApi({ getOutcomes: ['ok'] });

    const { handler } = await import('../src/aws/ws-drain.lambda.js');
    const run = handler({ ...EVENT, userId: 'user-d5', connectionId: 'conn-d5', sessionDigest: await bindSession('user-d5') });
    await vi.runAllTimersAsync();
    await run;

    expect(api.posts.map((p) => (p.frame.type === 'msg' ? p.frame.msgId : ''))).toEqual(['01MSGQ']);
    // The expired row is left for DynamoDB TTL to reap; drain never deletes.
    expect(await allQueued(db, 'user-d5')).toHaveLength(2);
  });

  it('gives up without touching the connection row when the handshake never completes', async () => {
    await db.putConnection({
      userId: 'user-d6',
      connectionId: 'conn-d6',
      connectedAt: testDeps.now(),
    });
    scriptManagementApi({ getOutcomes: [] }); // gone forever

    const { handler } = await import('../src/aws/ws-drain.lambda.js');
    const run = handler({ ...EVENT, userId: 'user-d6', connectionId: 'conn-d6', sessionDigest: await bindSession('user-d6') });
    await vi.runAllTimersAsync();
    await run;

    // A slow handshake can still establish after the probe budget; deleting
    // the row here would blackhole that live socket. Stale rows are reaped by
    // failed posts after the grace window or overwritten on reconnect.
    expect((await db.getConnection('user-d6'))?.connectionId).toBe('conn-d6');
  });

  it('giving up on a stale handshake never deletes a newer connection row', async () => {
    // The user already reconnected: the row belongs to the newer connection.
    await db.putConnection({
      userId: 'user-d7',
      connectionId: 'conn-d7-new',
      connectedAt: testDeps.now(),
    });
    scriptManagementApi({ getOutcomes: [] });

    const { handler } = await import('../src/aws/ws-drain.lambda.js');
    const run = handler({
      ...EVENT,
      userId: 'user-d7',
      connectionId: 'conn-d7-old',
      sessionDigest: await bindSession('user-d7'),
    });
    await vi.runAllTimersAsync();
    await run;

    expect((await db.getConnection('user-d7'))?.connectionId).toBe('conn-d7-new');
  });

  it('deletes the stale connection row after a dead-socket post mid-drain (messages untouched)', async () => {
    await seedQueue('user-d8', ['01MSGD', '01MSGE']);
    await db.putConnection({
      userId: 'user-d8',
      connectionId: 'conn-d8',
      connectedAt: testDeps.now(),
    });
    scriptManagementApi({ getOutcomes: ['ok'], postOutcomes: ['ok', 'gone'] });

    const { handler } = await import('../src/aws/ws-drain.lambda.js');
    const run = handler({ ...EVENT, userId: 'user-d8', connectionId: 'conn-d8', sessionDigest: await bindSession('user-d8') });
    await vi.runAllTimersAsync();
    await run;

    expect(await db.getConnection('user-d8')).toBeUndefined();
    expect(await allQueued(db, 'user-d8')).toHaveLength(2);
  });

  it('keeps the connection row after a fully delivered drain', async () => {
    await seedQueue('user-d9', ['01MSGF']);
    await db.putConnection({
      userId: 'user-d9',
      connectionId: 'conn-d9',
      connectedAt: testDeps.now(),
    });
    scriptManagementApi({ getOutcomes: ['ok'], postOutcomes: ['ok'] });

    const { handler } = await import('../src/aws/ws-drain.lambda.js');
    const run = handler({ ...EVENT, userId: 'user-d9', connectionId: 'conn-d9', sessionDigest: await bindSession('user-d9') });
    await vi.runAllTimersAsync();
    await run;

    expect((await db.getConnection('user-d9'))?.connectionId).toBe('conn-d9');
  });

  it('#5 — self-schedules a continuation from the cursor when the budget is exhausted', async () => {
    await seedQueue('user-cont', ['01MSGD', '01MSGE', '01MSGF']);
    await db.putConnection({
      userId: 'user-cont',
      connectionId: 'conn-cont',
      connectedAt: testDeps.now(),
    });
    // A live session behind the drain's bound digest — so the drain
    // proceeds and its continuation is what is under test here, not the guard.
    const contToken = 'cont-session-token';
    await db.createSession({
      token: contToken,
      userId: 'user-cont',
      createdAt: testDeps.now(),
      expiresAt: Math.floor(testDeps.now() / 1000) + 3600,
    });
    const contDigest = sessionTokenDigest(contToken);
    // Post the first frame with budget to spare, then advance the injected
    // clock past the deadline so the SECOND row trips the per-row deadline
    // check — the MID-SLICE budget exhaustion whose cursor-continuation is under
    // test. (A clock ALREADY spent at entry bounces the whole slice with no
    // post — MED-1 — which is a different path, tested separately.)
    const posts: string[] = [];
    mgmtSendMock.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof GetConnectionCommand) return { ConnectedAt: new Date(0) };
      if (cmd instanceof PostToConnectionCommand) {
        const input = (cmd as { input: { Data: Uint8Array } }).input;
        const frame = JSON.parse(Buffer.from(input.Data).toString('utf8')) as ServerFrame;
        posts.push(frame.type === 'msg' ? frame.msgId : frame.type);
        if (posts.length === 1) testDeps.advanceMs(2_000); // now past the deadline
        return {};
      }
      return {};
    });

    const { handler } = await import('../src/aws/ws-drain.lambda.js');
    // deadline = now + 1000 (3000 remaining − 2000 safety). The first message
    // posts inside it; that post advances the clock 2 s, so the budget is
    // exhausted at the second row with two messages still queued. A HEALTHY
    // socket that never reconnects would otherwise hide that tail forever.
    const run = handler(
      { ...EVENT, userId: 'user-cont', connectionId: 'conn-cont', sessionDigest: contDigest },
      { getRemainingTimeInMillis: () => 3_000 },
    );
    await vi.runAllTimersAsync();
    await run;

    expect(posts).toEqual(['01MSGD']);
    // The continuation was scheduled, carrying the cursor AND the validated
    // session digest so the next slice resumes exactly there and re-checks it.
    expect(lambdaSendMock).toHaveBeenCalledTimes(1);
    expect(continuationPayload()).toMatchObject({
      userId: 'user-cont',
      connectionId: 'conn-cont',
      afterMsgId: '01MSGD',
      sessionDigest: contDigest,
    });
  });

  it('a continuation that cannot be scheduled logs LOUD and RETHROWS so the async retry and error alarm engage', async () => {
    await seedQueue('user-loud', ['01MSGD', '01MSGE', '01MSGF']);
    await db.putConnection({
      userId: 'user-loud',
      connectionId: 'conn-loud',
      connectedAt: testDeps.now(),
    });
    const digest = await bindSession('user-loud');
    // Post the first frame with budget to spare, then advance the clock past
    // the deadline so the SECOND row exhausts the budget mid-slice and a
    // continuation is attempted.
    const posts: string[] = [];
    mgmtSendMock.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof GetConnectionCommand) return { ConnectedAt: new Date(0) };
      if (cmd instanceof PostToConnectionCommand) {
        const input = (cmd as { input: { Data: Uint8Array } }).input;
        const frame = JSON.parse(Buffer.from(input.Data).toString('utf8')) as ServerFrame;
        posts.push(frame.type === 'msg' ? frame.msgId : frame.type);
        if (posts.length === 1) testDeps.advanceMs(2_000);
        return {};
      }
      return {};
    });
    // The self-invoke is DENIED — the drain role lost lambda:InvokeFunction on
    // itself. The delivered prefix stands, but the failure must NOT be
    // swallowed: log.error alone is console.error, which the Lambda-Errors
    // alarm never sees, so the handler RETHROWS to fail the invocation (async
    // retry + Errors metric).
    lambdaSendMock.mockRejectedValue(
      Object.assign(new Error('nope'), { name: 'AccessDeniedException' }),
    );
    const errorSpy = vi.spyOn(log, 'error').mockImplementation(() => {});

    const { handler } = await import('../src/aws/ws-drain.lambda.js');
    const run = handler(
      { ...EVENT, userId: 'user-loud', connectionId: 'conn-loud', sessionDigest: digest },
      { getRemainingTimeInMillis: () => 3_000 },
    );
    // RETHROWN, so the async-invoke retry and the Errors alarm engage. The
    // rejection handler is attached before timers run so it is never unhandled.
    const rejects = expect(run).rejects.toThrow('nope');
    await vi.runAllTimersAsync();
    await rejects;

    // The first frame still posted; the continuation failure is LOUD (error)
    // and names the failure CLASS only — no id, no digest.
    expect(posts).toEqual(['01MSGD']);
    expect(errorSpy).toHaveBeenCalledWith('ws_drain_continuation_failed', {
      error: 'AccessDeniedException',
    });
    const serialized = JSON.stringify(errorSpy.mock.calls);
    expect(serialized).not.toContain('user-loud');
    expect(serialized).not.toContain('conn-loud');
    expect(serialized).not.toContain(digest);
    errorSpy.mockRestore();
  });

  it('#5 — a fully drained queue schedules NO continuation', async () => {
    await seedQueue('user-done', ['01MSGG']);
    await db.putConnection({
      userId: 'user-done',
      connectionId: 'conn-done',
      connectedAt: testDeps.now(),
    });
    scriptManagementApi({ getOutcomes: ['ok'], postOutcomes: ['ok'] });

    const { handler } = await import('../src/aws/ws-drain.lambda.js');
    const run = handler({ ...EVENT, userId: 'user-done', connectionId: 'conn-done', sessionDigest: await bindSession('user-done') });
    await vi.runAllTimersAsync();
    await run;

    expect(lambdaSendMock).not.toHaveBeenCalled();
  });

  it('#4 — a drain whose bound session was revoked delivers nothing and does not continue', async () => {
    await seedQueue('user-revoked', ['01MSGH', '01MSGI']);
    await db.putConnection({
      userId: 'user-revoked',
      connectionId: 'conn-revoked',
      connectedAt: testDeps.now(),
    });
    // A session digest whose session row does not exist (revoked / never
    // created): the socket is no longer authorized to receive.
    const api = scriptManagementApi({ getOutcomes: ['ok'] });

    const { handler } = await import('../src/aws/ws-drain.lambda.js');
    const run = handler(
      { ...EVENT, userId: 'user-revoked', connectionId: 'conn-revoked', sessionDigest: 'gone-digest' },
      { getRemainingTimeInMillis: () => 30_000 },
    );
    await vi.runAllTimersAsync();
    await run;

    // Nothing delivered, and no continuation scheduled: a passive socket that
    // never sends must not keep receiving via the drain after revocation.
    expect(api.posts).toHaveLength(0);
    expect(lambdaSendMock).not.toHaveBeenCalled();
    // The queue is untouched (drain never deletes).
    expect(await allQueued(db, 'user-revoked')).toHaveLength(2);
  });

  it('#4 — a session revoked MID-SLICE stops the drain within the recheck cadence, not at the slice end', async () => {
    // A slice can post 2000 frames over ~20 s. Checking the session only at
    // the invocation head meant a revoke landing after frame 1 kept feeding a
    // revoked socket for the whole remaining slice. The drain must re-check on
    // a cadence INSIDE the slice and stop there.
    await seedQueue('user-mid', ['01MIDA', '01MIDB', '01MIDC']);
    await db.putConnection({
      userId: 'user-mid',
      connectionId: 'conn-mid',
      connectedAt: testDeps.now(),
    });
    const midToken = 'mid-session-token';
    await db.createSession({
      token: midToken,
      userId: 'user-mid',
      createdAt: testDeps.now(),
      expiresAt: Math.floor(testDeps.now() / 1000) + 3600,
    });
    const posts: string[] = [];
    mgmtSendMock.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof GetConnectionCommand) return { ConnectedAt: new Date(0) };
      if (cmd instanceof PostToConnectionCommand) {
        const input = (cmd as { input: { ConnectionId: string; Data: Uint8Array } }).input;
        const frame = JSON.parse(Buffer.from(input.Data).toString('utf8')) as ServerFrame;
        posts.push(frame.type === 'msg' ? frame.msgId : frame.type);
        if (posts.length === 1) {
          // The revoke lands right after the first frame, and more than one
          // recheck cadence elapses before the next would post.
          testDeps.advanceMs(6_000);
          await db.deleteSession(midToken);
        }
        return {};
      }
      return {};
    });

    const { handler } = await import('../src/aws/ws-drain.lambda.js');
    const run = handler(
      {
        ...EVENT,
        userId: 'user-mid',
        connectionId: 'conn-mid',
        sessionDigest: sessionTokenDigest(midToken),
      },
      { getRemainingTimeInMillis: () => 300_000 },
    );
    await vi.runAllTimersAsync();
    await run;

    // Frame 1 posted before the revoke; the cadence recheck refuses the rest.
    expect(posts).toEqual(['01MIDA']);
    // No continuation for a revoked socket, and the queue is untouched.
    expect(lambdaSendMock).not.toHaveBeenCalled();
    expect(await allQueued(db, 'user-mid')).toHaveLength(3);
  });

  it('refuses a DIGESTLESS drain event outright — nothing is delivered to a socket no session can revoke', async () => {
    // v1.0 has not shipped: every dial binds a session, so a drain event with
    // no digest is not a legacy socket to protect — it is a socket the
    // session machinery cannot revoke, and it fails CLOSED.
    await seedQueue('user-dless', ['01DLA', '01DLB']);
    await db.putConnection({
      userId: 'user-dless',
      connectionId: 'conn-dless',
      connectedAt: testDeps.now(),
    });
    const api = scriptManagementApi({ getOutcomes: ['ok'] });

    const { handler } = await import('../src/aws/ws-drain.lambda.js');
    const run = handler(
      { ...EVENT, userId: 'user-dless', connectionId: 'conn-dless' },
      { getRemainingTimeInMillis: () => 30_000 },
    );
    await vi.runAllTimersAsync();
    await run;

    expect(api.posts).toHaveLength(0);
    expect(lambdaSendMock).not.toHaveBeenCalled();
    // The unrevocable row is torn down; the queue waits for a real login.
    expect(await db.getConnection('user-dless')).toBeUndefined();
    expect(await allQueued(db, 'user-dless')).toHaveLength(2);
  });

  it('rethrows unexpected management-API failures so the async-invoke retry can handle them', async () => {
    mgmtSendMock.mockRejectedValue(
      Object.assign(new Error('not allowed'), { name: 'ForbiddenException' }),
    );

    const { handler } = await import('../src/aws/ws-drain.lambda.js');
    await expect(
      handler({ ...EVENT, connectionId: 'conn-d4', sessionDigest: await bindSession('user-d1') }),
    ).rejects.toThrow('not allowed');
  });

  it('drops a malformed event without touching the management API', async () => {
    const { handler } = await import('../src/aws/ws-drain.lambda.js');
    await expect(
      handler({ userId: '', connectionId: '', domainName: '', stage: '' }),
    ).resolves.toBeUndefined();
    expect(mgmtSendMock).not.toHaveBeenCalled();
  });
});
