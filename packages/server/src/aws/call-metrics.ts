import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import {
  GetCommand,
  PutCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import type {
  CallMetricClaim,
  CallMetricPublisher,
  CallMetricStore,
} from '../call-metrics.js';
import { makeDocClient } from '../db/client.js';
import type { Deps } from '../handlers/http.js';

export const CALL_METRIC_DEDUPE_TABLE_ENV = 'TACENDUM_TABLE_CALL_METRIC_DEDUPE';

type DedupeStatus = 'pending' | 'publishing' | 'published';

interface DedupeRow {
  key: string;
  digest: string;
  status: DedupeStatus;
  leaseUntil?: number;
  expiresAt: number;
}

type CloudWatchSender = Pick<CloudWatchClient, 'send'>;

/**
 * Durable claim store for call metric batches. It retains only the opaque
 * dedupe key and content digest, never the report body or caller identity.
 */
export function makeAwsCallMetricStore(
  doc: DynamoDBDocumentClient,
  tableName: string,
): CallMetricStore {
  return {
    async claim(input): Promise<CallMetricClaim> {
      try {
        await doc.send(
          new PutCommand({
            TableName: tableName,
            Item: {
              key: input.key,
              digest: input.digest,
              status: 'publishing' satisfies DedupeStatus,
              leaseUntil: input.leaseUntil,
              expiresAt: input.expiresAt,
            },
            ConditionExpression: 'attribute_not_exists(#key)',
            ExpressionAttributeNames: { '#key': 'key' },
          }),
        );
        return 'claimed';
      } catch (err) {
        if (!isConditionalCheckFailed(err)) throw err;
      }

      const current = await doc.send(
        new GetCommand({
          TableName: tableName,
          Key: { key: input.key },
          ConsistentRead: true,
        }),
      );
      const row = current.Item as DedupeRow | undefined;
      if (!row) return 'busy';
      if (row.digest !== input.digest) return 'conflict';
      if (row.status === 'published') return 'published';
      if (row.status === 'publishing' && (row.leaseUntil ?? Infinity) > input.now) return 'busy';

      try {
        await doc.send(
          new UpdateCommand({
            TableName: tableName,
            Key: { key: input.key },
            UpdateExpression: 'SET #status = :publishing, #leaseUntil = :leaseUntil, #expiresAt = :expiresAt',
            ConditionExpression:
              '#digest = :digest AND (#status = :pending OR (#status = :publishing AND #leaseUntil <= :now))',
            ExpressionAttributeNames: {
              '#digest': 'digest',
              '#status': 'status',
              '#leaseUntil': 'leaseUntil',
              '#expiresAt': 'expiresAt',
            },
            ExpressionAttributeValues: {
              ':digest': input.digest,
              ':pending': 'pending',
              ':publishing': 'publishing',
              ':leaseUntil': input.leaseUntil,
              ':expiresAt': input.expiresAt,
              ':now': input.now,
            },
          }),
        );
        return 'claimed';
      } catch (err) {
        if (isConditionalCheckFailed(err)) return 'busy';
        throw err;
      }
    },

    async markPublished(input): Promise<void> {
      await doc.send(
        new UpdateCommand({
          TableName: tableName,
          Key: { key: input.key },
          UpdateExpression: 'SET #status = :published REMOVE #leaseUntil',
          ConditionExpression:
            '#status = :publishing AND #digest = :digest AND #leaseUntil = :leaseUntil',
          ExpressionAttributeNames: {
            '#status': 'status',
            '#digest': 'digest',
            '#leaseUntil': 'leaseUntil',
          },
          ExpressionAttributeValues: {
            ':published': 'published',
            ':publishing': 'publishing',
            ':digest': input.digest,
            ':leaseUntil': input.leaseUntil,
          },
        }),
      );
    },

    async release(input): Promise<void> {
      await doc.send(
        new UpdateCommand({
          TableName: tableName,
          Key: { key: input.key },
          UpdateExpression: 'SET #status = :pending REMOVE #leaseUntil',
          ConditionExpression:
            '#status = :publishing AND #digest = :digest AND #leaseUntil = :leaseUntil',
          ExpressionAttributeNames: {
            '#status': 'status',
            '#digest': 'digest',
            '#leaseUntil': 'leaseUntil',
          },
          ExpressionAttributeValues: {
            ':pending': 'pending',
            ':publishing': 'publishing',
            ':digest': input.digest,
            ':leaseUntil': input.leaseUntil,
          },
        }),
      );
    },
  };
}

export function makeAwsCallMetricPublisher(cloudWatch: CloudWatchSender): CallMetricPublisher {
  return {
    async publish(data): Promise<void> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2_000);
      try {
        await cloudWatch.send(
          new PutMetricDataCommand({ Namespace: 'Tacendum/Calls', MetricData: [...data] }),
          { abortSignal: controller.signal },
        );
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export function makeAwsCallMetrics({
  env = process.env,
  doc = makeDocClient(),
}: {
  env?: NodeJS.ProcessEnv;
  doc?: DynamoDBDocumentClient;
} = {}): NonNullable<Deps['callMetrics']> {
  const tableName = env[CALL_METRIC_DEDUPE_TABLE_ENV];
  if (!tableName) throw new Error(`${CALL_METRIC_DEDUPE_TABLE_ENV} is required and must be non-empty`);
  const cloudWatch = new CloudWatchClient({ maxAttempts: 1 });
  return {
    store: makeAwsCallMetricStore(doc, tableName),
    publisher: makeAwsCallMetricPublisher(cloudWatch),
  };
}

function isConditionalCheckFailed(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'name' in err &&
    (err as { name?: unknown }).name === 'ConditionalCheckFailedException'
  );
}
