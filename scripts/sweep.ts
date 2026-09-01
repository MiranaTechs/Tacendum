/**
 * DynamoDB Local ignores TTL (PLAN §4, §9). This sweep deletes rows whose
 * `expiresAt` (unix seconds) is in the past, from the tables that carry a TTL.
 * In AWS the same attribute is a real TTL and this script is unnecessary.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  ScanCommand,
  DeleteCommand,
} from '@aws-sdk/lib-dynamodb';
import { TABLES } from '@tacendum/shared';

const ENDPOINT = process.env.DDB_ENDPOINT ?? 'http://localhost:8000';
const REGION = process.env.AWS_REGION ?? 'us-east-1';

const doc = DynamoDBDocumentClient.from(
  new DynamoDBClient({
    region: REGION,
    endpoint: ENDPOINT,
    credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
  }),
);

// table -> [partition-key, sort-key?] so we can build a DeleteCommand key.
const TTL_TABLES: { name: string; keys: string[] }[] = [
  { name: TABLES.sessions, keys: ['token'] },
  { name: TABLES.messages, keys: ['recipientId', 'msgId'] },
  { name: TABLES.activity, keys: ['actorHash'] },
];

async function sweepTable(name: string, keys: string[]): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  let deleted = 0;
  let lastKey: Record<string, unknown> | undefined;

  do {
    const res = await doc.send(
      new ScanCommand({
        TableName: name,
        FilterExpression: 'attribute_exists(expiresAt) AND expiresAt < :now',
        ExpressionAttributeValues: { ':now': now },
        ExclusiveStartKey: lastKey,
      }),
    );
    for (const item of res.Items ?? []) {
      const key = Object.fromEntries(keys.map((k) => [k, item[k]]));
      await doc.send(new DeleteCommand({ TableName: name, Key: key }));
      deleted += 1;
    }
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);

  return deleted;
}

async function main(): Promise<void> {
  for (const { name, keys } of TTL_TABLES) {
    const n = await sweepTable(name, keys);
    console.log(`swept ${n} expired row(s) from ${name}`);
  }
}

main().catch((err) => {
  console.error('sweep failed:', err);
  process.exit(1);
});
