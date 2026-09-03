import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { CALL_METRIC_DEDUPE_TABLE, TABLES, TABLE_ENV_VARS } from '@tacendum/shared';
import {
  CALL_METRIC_DEDUPE_TABLE_ENV,
  makeAwsCallMetricPublisher,
  makeAwsCallMetricStore,
  makeAwsCallMetrics,
} from '../src/aws/call-metrics.js';

/**
 * The dedupe table existed only in CDK, under an env name hard-coded in three
 * places; the local table script did not create it. It now has one home in the
 * shared contract — deliberately BESIDE `TABLES`/`TABLE_ENV_VARS` rather than
 * inside them, because those name the tables EVERY application function
 * receives (the infra suite pins that) and this one is injected into HttpFn
 * alone (pinned too). The env name is the one the stack already hard-codes, so
 * no CDK change was needed. */
describe('the call-metric dedupe table is part of the shared table contract', () => {
  it('the adapter reads the env name the stack sets, through the contract', () => {
    expect(CALL_METRIC_DEDUPE_TABLE_ENV).toBe(CALL_METRIC_DEDUPE_TABLE.envVar);
    expect(CALL_METRIC_DEDUPE_TABLE.envVar).toBe('TACENDUM_TABLE_CALL_METRIC_DEDUPE');
  });

  it('is named and TTL\'d like its siblings, outside the every-function set', () => {
    expect(CALL_METRIC_DEDUPE_TABLE.name).toMatch(/^tacendum_/);
    expect(Object.values(TABLES)).not.toContain(CALL_METRIC_DEDUPE_TABLE.name);
    expect(Object.values(TABLE_ENV_VARS)).not.toContain(CALL_METRIC_DEDUPE_TABLE.envVar);
    expect(CALL_METRIC_DEDUPE_TABLE.ttlAttribute).toBe('expiresAt');
  });
});

const cloudWatch = vi.hoisted(() => ({
  client: { send: vi.fn() },
  constructor: vi.fn(),
}));

vi.mock('@aws-sdk/client-cloudwatch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-cloudwatch')>();
  return {
    ...actual,
    CloudWatchClient: cloudWatch.constructor,
  };
});

const input = {
  key: 'key-digest',
  digest: 'report-digest',
  now: 100,
  leaseUntil: 130,
  expiresAt: 900,
};

function conditionalFailure(): Error {
  return Object.assign(new Error('conditional check failed'), {
    name: 'ConditionalCheckFailedException',
  });
}

describe('AWS call-metric adapters', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    cloudWatch.client.send.mockReset();
    cloudWatch.constructor.mockReset().mockImplementation(() => cloudWatch.client);
  });

  it('conditionally creates a durable claim without retaining report content', async () => {
    const send = vi.fn().mockResolvedValue({});
    const store = makeAwsCallMetricStore({ send } as unknown as DynamoDBDocumentClient, 'call-metric-dedupe');

    await expect(store.claim(input)).resolves.toBe('claimed');

    expect(send).toHaveBeenCalledTimes(1);
    const [put] = send.mock.calls[0]!;
    expect(put).toBeInstanceOf(PutCommand);
    expect(put.input).toMatchObject({
      TableName: 'call-metric-dedupe',
      Item: {
        key: input.key,
        digest: input.digest,
        status: 'publishing',
        leaseUntil: input.leaseUntil,
        expiresAt: input.expiresAt,
      },
      ConditionExpression: 'attribute_not_exists(#key)',
    });
    expect(JSON.stringify(put.input)).not.toContain('reportId');
    expect(JSON.stringify(put.input)).not.toContain('accountId');
  });

  it('strongly reads a collision and atomically reclaims an expired matching lease', async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(conditionalFailure())
      .mockResolvedValueOnce({
        Item: {
          key: input.key,
          digest: input.digest,
          status: 'publishing',
          leaseUntil: input.now,
          expiresAt: input.expiresAt,
        },
      })
      .mockResolvedValueOnce({});
    const store = makeAwsCallMetricStore({ send } as unknown as DynamoDBDocumentClient, 'call-metric-dedupe');

    await expect(store.claim(input)).resolves.toBe('claimed');

    const [, get, update] = send.mock.calls.map(([command]) => command);
    expect(get).toBeInstanceOf(GetCommand);
    expect(get.input.ConsistentRead).toBe(true);
    expect(update).toBeInstanceOf(UpdateCommand);
    expect(update.input.ConditionExpression).toContain('#digest = :digest');
    expect(update.input.ConditionExpression).toContain('leaseUntil <= :now');
  });

  it('marks and releases only the lease it owns', async () => {
    const send = vi.fn().mockResolvedValue({});
    const store = makeAwsCallMetricStore({ send } as unknown as DynamoDBDocumentClient, 'call-metric-dedupe');

    await store.markPublished(input);
    await store.release(input);

    const [mark, release] = send.mock.calls.map(([command]) => command as UpdateCommand);
    expect(mark).toBeInstanceOf(UpdateCommand);
    expect(release).toBeInstanceOf(UpdateCommand);
    expect(mark!.input.ConditionExpression).toContain('#status = :publishing');
    expect(mark!.input.ConditionExpression).toContain('#digest = :digest');
    expect(mark!.input.ConditionExpression).toContain('#leaseUntil = :leaseUntil');
    expect(release!.input.ConditionExpression).toContain('#status = :publishing');
    expect(release!.input.UpdateExpression).toContain('REMOVE #leaseUntil');
  });

  it('uses a single-attempt Tacendum/Calls CloudWatch publisher and aborts after two seconds', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    let resolveSend: (() => void) | undefined;
    cloudWatch.client.send.mockImplementation(
      (_command: unknown, options: { abortSignal?: AbortSignal }) =>
        new Promise<void>((resolve) => {
          signal = options.abortSignal;
          resolveSend = resolve;
        }),
    );
    const doc = { send: vi.fn() } as unknown as DynamoDBDocumentClient;
    const { publisher } = makeAwsCallMetrics({
      env: { TACENDUM_TABLE_CALL_METRIC_DEDUPE: 'call-metric-dedupe' },
      doc,
    });

    const publishing = publisher.publish([]);
    expect(cloudWatch.constructor).toHaveBeenCalledWith({ maxAttempts: 1 });
    expect(cloudWatch.client.send).toHaveBeenCalledTimes(1);
    const [command] = cloudWatch.client.send.mock.calls[0]!;
    expect(command).toBeInstanceOf(PutMetricDataCommand);
    expect(command.input).toMatchObject({ Namespace: 'Tacendum/Calls', MetricData: [] });

    await vi.advanceTimersByTimeAsync(2_000);
    expect(signal?.aborted).toBe(true);
    resolveSend?.();
    await publishing;
    vi.useRealTimers();
  });

  it('supports a direct publisher client seam for focused publication tests', async () => {
    const send = vi.fn().mockResolvedValue({});
    const publisher = makeAwsCallMetricPublisher({ send } as never);

    await publisher.publish([]);

    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(PutMetricDataCommand);
  });
});
