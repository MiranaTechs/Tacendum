import { PutMetricDataCommand, type PutMetricDataCommandInput } from '@aws-sdk/client-cloudwatch';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TestOnlyDataLayer } from '../src/db/data.js';
import type { PushWakeEvent } from '../src/handlers/push-worker.js';
import { makeMemoryDb, makeTestDeps, type TestDeps } from './helpers.js';

const { cloudWatchConfigs, cloudWatchSendMock } = vi.hoisted(() => ({
  cloudWatchConfigs: [] as Array<Record<string, unknown>>,
  cloudWatchSendMock: vi.fn(),
}));

let testDeps: TestDeps;

vi.mock('../src/aws/deps.js', () => ({
  makeAwsDeps: (): unknown => testDeps,
}));

vi.mock('../src/push/sender.js', () => ({
  apnsCredentialsSettled: (): Promise<void> => Promise.resolve(),
}));

vi.mock('@aws-sdk/client-cloudwatch', () => ({
  CloudWatchClient: class {
    send = cloudWatchSendMock;

    constructor(config: Record<string, unknown>) {
      cloudWatchConfigs.push(config);
    }
  },
  PutMetricDataCommand: class {
    constructor(readonly input: PutMetricDataCommandInput) {}
  },
}));

const EVENT: PushWakeEvent = {
  recipientId: 'user-recipient-metric-canary',
  senderUserId: 'user-sender-metric-canary',
  kind: 'call',
  message: {
    msgId: 'message-id-metric-canary',
    msgType: 'ciphertext',
    payload: 'QUJD',
    ts: 1_700_000_000_000,
  },
};

function publishedCommand(): PutMetricDataCommand {
  return cloudWatchSendMock.mock.calls[0]?.[0] as PutMetricDataCommand;
}

beforeEach(async () => {
  vi.resetModules();
  cloudWatchConfigs.length = 0;
  cloudWatchSendMock.mockReset();
  cloudWatchSendMock.mockResolvedValue({});
  const db: TestOnlyDataLayer = makeMemoryDb();
  testDeps = makeTestDeps(db);
  await db.createUser({ userId: EVENT.recipientId, createdAt: testDeps.now() });
  await db.putPushToken({
    userId: EVENT.recipientId,
    voipToken: 'a'.repeat(64),
    alertToken: 'b'.repeat(64),
    env: 'sandbox',
    bundleId: 'com.miranatechnologies.tacendum',
    updatedAt: testDeps.now(),
    expiresAt: Math.floor(testDeps.now() / 1000) + 86_400,
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('push Lambda VoIP outcome metric', () => {
  it('publishes one anonymous call outcome with exactly the Outcome dimension', async () => {
    const { handler } = await import('../src/aws/push.lambda.js');

    await handler(EVENT);

    expect(cloudWatchConfigs).toEqual([{ maxAttempts: 1 }]);
    expect(cloudWatchSendMock).toHaveBeenCalledTimes(1);
    const command = publishedCommand();
    expect(command.input).toEqual({
      Namespace: 'Tacendum',
      MetricData: [
        {
          MetricName: 'VoipWake',
          Value: 1,
          Unit: 'Count',
          Dimensions: [{ Name: 'Outcome', Value: 'sent' }],
        },
      ],
    });
    expect(command.input.MetricData?.[0]?.Dimensions?.map((d) => d.Name)).toEqual(['Outcome']);
    for (const sensitiveValue of [
      EVENT.recipientId,
      EVENT.senderUserId,
      EVENT.message?.msgId,
    ].filter((value): value is string => value !== undefined)) {
      expect(JSON.stringify(command.input)).not.toContain(sensitiveValue);
    }
  });

  it('publishes no VoipWake metric for a message push', async () => {
    const { handler } = await import('../src/aws/push.lambda.js');

    await handler({
      ...EVENT,
      kind: 'message',
    });

    expect(testDeps.alertsSent).toHaveLength(1);
    expect(cloudWatchSendMock).not.toHaveBeenCalled();
  });

  it('does not throw or deliver the push twice when CloudWatch fails', async () => {
    cloudWatchSendMock.mockRejectedValue(new Error('CloudWatch unavailable'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { handler } = await import('../src/aws/push.lambda.js');

    await expect(handler(EVENT)).resolves.toBeUndefined();

    expect(testDeps.pushesSent).toHaveLength(1);
    expect(cloudWatchSendMock).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls.flat().join(' ')).toContain('voip_metric_publish_failed');
  });

  it('aborts a stalled metric after two seconds without delivering twice', async () => {
    vi.useFakeTimers();
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockImplementation((delay: number) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), delay);
      return controller.signal;
    });
    cloudWatchSendMock.mockImplementation(
      (_command: unknown, options?: { abortSignal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          const signal = options?.abortSignal;
          if (!signal) {
            reject(new Error('missing abort signal'));
            return;
          }
          if (signal.aborted) {
            reject(new DOMException('Aborted', 'AbortError'));
            return;
          }
          signal.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true },
          );
        }),
    );
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { handler } = await import('../src/aws/push.lambda.js');

    let settled = false;
    const pending = handler(EVENT).then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(cloudWatchSendMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_999);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toBeUndefined();

    expect(timeoutSpy).toHaveBeenCalledWith(2_000);
    expect(testDeps.pushesSent).toHaveLength(1);
    expect(errorSpy.mock.calls.flat().join(' ')).toContain('voip_metric_publish_failed');
  });
});
