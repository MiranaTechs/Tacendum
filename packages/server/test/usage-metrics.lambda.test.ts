import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DescribeTableCommand } from '@aws-sdk/client-dynamodb';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import {
  PutMetricDataCommand,
  type PutMetricDataCommandInput,
} from '@aws-sdk/client-cloudwatch';
import { ACTIVITY_DAY_INDEX } from '@tacendum/shared';

const { rawSendMock, docSendMock, cloudWatchSendMock } = vi.hoisted(() => ({
  rawSendMock: vi.fn(),
  docSendMock: vi.fn(),
  cloudWatchSendMock: vi.fn(),
}));

vi.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: class {
    send = rawSendMock;
  },
  DescribeTableCommand: class {
    constructor(readonly input: { TableName: string }) {}
  },
}));

vi.mock('@aws-sdk/lib-dynamodb', () => {
  class DynamoDBDocumentClient {
    send = docSendMock;

    static from(): DynamoDBDocumentClient {
      return new DynamoDBDocumentClient();
    }
  }

  return {
    DynamoDBDocumentClient,
    QueryCommand: class {
      constructor(readonly input: Record<string, unknown>) {}
    },
  };
});

vi.mock('@aws-sdk/client-cloudwatch', () => ({
  CloudWatchClient: class {
    send = cloudWatchSendMock;
  },
  PutMetricDataCommand: class {
    constructor(readonly input: Record<string, unknown>) {}
  },
}));

function queryInputs(): Array<Record<string, unknown>> {
  return docSendMock.mock.calls.map(([command]) => (command as QueryCommand).input);
}

function publishedMetricInput(): PutMetricDataCommandInput {
  const command = cloudWatchSendMock.mock.calls[0]?.[0] as PutMetricDataCommand;
  return command.input;
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-07-29T18:47:00Z'));
  vi.stubEnv('TACENDUM_TABLE_ACTIVITY', 'activity-table-test');
  vi.stubEnv('TACENDUM_TABLE_CONNECTIONS', 'connections-table-test');
  vi.stubEnv('AWS_REGION', 'us-east-1');
  rawSendMock.mockReset();
  docSendMock.mockReset();
  cloudWatchSendMock.mockReset();
  rawSendMock.mockResolvedValue({ Table: { ItemCount: 3 } });
  docSendMock.mockResolvedValue({ Count: 0 });
  cloudWatchSendMock.mockResolvedValue({});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('usage metrics Lambda', () => {
  it.each([
    ['TACENDUM_TABLE_ACTIVITY', undefined],
    ['TACENDUM_TABLE_ACTIVITY', ''],
    ['TACENDUM_TABLE_CONNECTIONS', undefined],
    ['TACENDUM_TABLE_CONNECTIONS', ''],
  ])('fails closed when %s is %s', async (name, value) => {
    if (value === undefined) {
      delete process.env[name];
    } else {
      vi.stubEnv(name, value);
    }

    await expect(import('../src/aws/usage-metrics.lambda.js')).rejects.toThrow(
      `${name} is required and must be non-empty`,
    );
  });

  it('ignores unrelated table environment variables', async () => {
    vi.stubEnv('TACENDUM_TABLE_USERS', '');

    const { handler } = await import('../src/aws/usage-metrics.lambda.js');

    await expect(handler()).resolves.toBeUndefined();
    expect((rawSendMock.mock.calls[0]?.[0] as DescribeTableCommand).input).toEqual({
      TableName: 'connections-table-test',
    });
    expect(queryInputs().every((input) => input.TableName === 'activity-table-test')).toBe(true);
  });

  it('reads only the connection table estimate and counts activity through the sparse GSI', async () => {
    const { handler } = await import('../src/aws/usage-metrics.lambda.js');

    await handler();

    expect(rawSendMock).toHaveBeenCalledTimes(1);
    const describe = rawSendMock.mock.calls[0]?.[0];
    expect(describe).toBeInstanceOf(DescribeTableCommand);
    expect((describe as DescribeTableCommand).input).toEqual({
      TableName: 'connections-table-test',
    });
    expect(queryInputs().length).toBeGreaterThan(0);
    for (const input of queryInputs()) {
      expect(input).toMatchObject({
        TableName: 'activity-table-test',
        IndexName: ACTIVITY_DAY_INDEX,
        Select: 'COUNT',
      });
    }
  });

  it('sums every page, reuses the opaque cursor only for pagination, and never logs it', async () => {
    const cursor = { actorHash: 'opaque-cursor-never-log', activityDay: '2026-07-29' };
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    rawSendMock.mockResolvedValue({ Table: { ItemCount: 9 } });
    docSendMock.mockImplementation(async (command: QueryCommand) => {
      const input = command.input;
      const values = input.ExpressionAttributeValues as Record<string, string>;
      if (values[':day'] !== '2026-07-29' || values[':minimum']) return { Count: 0 };
      if (!input.ExclusiveStartKey) return { Count: 2, LastEvaluatedKey: cursor };
      return { Count: 3 };
    });

    const { handler } = await import('../src/aws/usage-metrics.lambda.js');
    await handler();

    const currentDayPages = queryInputs().filter((input) => {
      const values = input.ExpressionAttributeValues as Record<string, string>;
      return values[':day'] === '2026-07-29' && !values[':minimum'];
    });
    expect(currentDayPages).toHaveLength(2);
    expect(currentDayPages[0]).not.toHaveProperty('ExclusiveStartKey');
    expect(currentDayPages[1]).toEqual({
      ...currentDayPages[0],
      ExclusiveStartKey: cursor,
    });
    const metricValues = Object.fromEntries(
      (publishedMetricInput().MetricData ?? []).map((metric) => [
        metric.MetricName,
        metric.Value,
      ]),
    );
    expect(metricValues).toEqual({
      OnlineUsersEstimate: 9,
      DailyActiveUsers: 5,
      WeeklyActiveUsers: 5,
      MonthlyActiveUsers: 5,
    });
    for (const spy of [logSpy, errorSpy, infoSpy, warnSpy, debugSpy]) {
      expect(JSON.stringify(spy.mock.calls)).not.toContain('opaque-cursor-never-log');
    }
  });

  it('publishes four dimensionless Tacendum Count metrics including numeric zeros', async () => {
    rawSendMock.mockResolvedValue({ Table: {} });
    docSendMock.mockResolvedValue({});

    const { handler } = await import('../src/aws/usage-metrics.lambda.js');
    await handler();

    expect(cloudWatchSendMock).toHaveBeenCalledTimes(1);
    expect(publishedMetricInput()).toEqual({
      Namespace: 'Tacendum',
      MetricData: [
        { MetricName: 'OnlineUsersEstimate', Unit: 'Count', Value: 0 },
        { MetricName: 'DailyActiveUsers', Unit: 'Count', Value: 0 },
        { MetricName: 'WeeklyActiveUsers', Unit: 'Count', Value: 0 },
        { MetricName: 'MonthlyActiveUsers', Unit: 'Count', Value: 0 },
      ],
    });
  });

  it('does not publish a partial snapshot when an activity query fails', async () => {
    docSendMock.mockRejectedValueOnce(new Error('query unavailable'));

    const { handler } = await import('../src/aws/usage-metrics.lambda.js');

    await expect(handler()).rejects.toThrow('query unavailable');
    expect(cloudWatchSendMock).not.toHaveBeenCalled();
  });
});
