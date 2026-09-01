import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { DescribeTableCommand } from '@aws-sdk/client-dynamodb';
import { QueryCommand, type QueryCommandInput } from '@aws-sdk/lib-dynamodb';
import { ACTIVITY_DAY_INDEX } from '@tacendum/shared';
import { USAGE_METRICS, collectUsageCounts } from '../usage-metrics.js';
import { makeDocClient, makeDynamoClient, readDynamoConfig } from '../db/client.js';

const ACTIVITY_TABLE_ENV = 'TACENDUM_TABLE_ACTIVITY';
const CONNECTIONS_TABLE_ENV = 'TACENDUM_TABLE_CONNECTIONS';

interface UsageMetricTables {
  activity: string;
  connections: string;
}

function requiredTableName(name: string, env: NodeJS.ProcessEnv): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is required and must be non-empty`);
  return value;
}

export function readUsageMetricTables(
  env: NodeJS.ProcessEnv = process.env,
): UsageMetricTables {
  return {
    activity: requiredTableName(ACTIVITY_TABLE_ENV, env),
    connections: requiredTableName(CONNECTIONS_TABLE_ENV, env),
  };
}

const tables = readUsageMetricTables();
const dynamo = makeDynamoClient();
const doc = makeDocClient(dynamo);
const cloudWatch = new CloudWatchClient({ region: readDynamoConfig().region });

async function connectionItemCount(): Promise<number> {
  const result = await dynamo.send(
    new DescribeTableCommand({
      TableName: tables.connections,
    }),
  );
  return result.Table?.ItemCount ?? 0;
}

async function queryActivityDay(day: string, minimumHourActor?: string): Promise<number> {
  let count = 0;
  let cursor: QueryCommandInput['ExclusiveStartKey'];

  do {
    const page = await doc.send(
      new QueryCommand({
        TableName: tables.activity,
        IndexName: ACTIVITY_DAY_INDEX,
        KeyConditionExpression: minimumHourActor
          ? 'activityDay = :day AND activityHourActor >= :minimum'
          : 'activityDay = :day',
        ExpressionAttributeValues: {
          ':day': day,
          ...(minimumHourActor ? { ':minimum': minimumHourActor } : {}),
        },
        Select: 'COUNT',
        ...(cursor ? { ExclusiveStartKey: cursor } : {}),
      }),
    );
    count += page.Count ?? 0;
    cursor = page.LastEvaluatedKey;
  } while (cursor);

  return count;
}

export async function handler(): Promise<void> {
  const counts = await collectUsageCounts(Date.now(), {
    connectionItemCount,
    queryActivityDay,
  });

  await cloudWatch.send(
    new PutMetricDataCommand({
      Namespace: 'Tacendum',
      MetricData: [
        { MetricName: USAGE_METRICS.online, Unit: 'Count', Value: counts.online },
        { MetricName: USAGE_METRICS.daily, Unit: 'Count', Value: counts.daily },
        { MetricName: USAGE_METRICS.weekly, Unit: 'Count', Value: counts.weekly },
        { MetricName: USAGE_METRICS.monthly, Unit: 'Count', Value: counts.monthly },
      ],
    }),
  );
}
