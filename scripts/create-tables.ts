/**
 * Creates every Tacendum table (the shared `TABLES` set plus the
 * HttpFn-only call-metric dedupe table) in DynamoDB Local, with the same
 * TTL attribute the deployed tables use.
 * Idempotent: skips tables that already exist. Run: `pnpm tables:create`.
 *
 * IDEMPOTENT MEANS IT NEVER RESHAPES A TABLE IT DID NOT JUST CREATE. A local
 * `tacendum_users` created before keypair accounts landed still carries the
 * deleted `phone-index` GSI, and this script will report `= exists` and leave
 * it there. Harmless — nothing reads it any more — but if you want the local
 * shape to match the deployed one, drop the table (or `docker compose down`
 * and remove `.dynamodb-data/`) and run this again.
 */
import {
  CreateTableCommand,
  DynamoDBClient,
  ListTablesCommand,
  UpdateTimeToLiveCommand,
  waitUntilTableExists,
  type CreateTableCommandInput,
} from '@aws-sdk/client-dynamodb';
import {
  ACTIVITY_DAY_INDEX,
  CALL_METRIC_DEDUPE_TABLE,
  SESSIONS_USER_INDEX,
  TABLES,
} from '@tacendum/shared';

const ENDPOINT = process.env.DDB_ENDPOINT ?? 'http://localhost:8000';
const REGION = process.env.AWS_REGION ?? 'us-east-1';

const client = new DynamoDBClient({
  region: REGION,
  endpoint: ENDPOINT,
  credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
});

// PAY_PER_REQUEST mirrors on-demand DynamoDB and needs no throughput tuning.
const BILLING = 'PAY_PER_REQUEST' as const;

/** TTL attribute per table NAME (real TTL in AWS; swept manually locally) —
 * one entry per `timeToLiveAttribute` the CDK stack declares, so the local
 * shape matches the deployed one. */
const TTL_ATTR: Record<string, string> = {
  [TABLES.sessions]: 'expiresAt',
  [TABLES.messages]: 'expiresAt',
  // Connection rows expire in AWS (the 2026-08-28 incident backstop); the
  // local table carried no TTL entry until this map gained one.
  [TABLES.connections]: 'expiresAt',
  [TABLES.pushTokens]: 'expiresAt',
  [TABLES.rateBuckets]: 'expiresAt',
  [TABLES.activity]: 'expiresAt',
  [TABLES.reports]: 'expiresAt',
  [CALL_METRIC_DEDUPE_TABLE.name]: CALL_METRIC_DEDUPE_TABLE.ttlAttribute,
};

const definitions: CreateTableCommandInput[] = [
  {
    // No secondary index, deliberately. The
    // `phone-index` GSI that used to live here was an enumeration primitive
    // held shut only by IAM denials; keypair accounts delete the threat instead
    // of guarding it. Accounts are reached by `userId`, or by a GetItem on the
    // `idkey#<b64>` claim row — a point lookup nobody can scan.
    TableName: TABLES.users,
    BillingMode: BILLING,
    // Only key attributes are declared: DynamoDB rejects an AttributeDefinition
    // that no key schema references, so the old `phoneE164` entry had to go
    // with the index rather than linger as documentation.
    AttributeDefinitions: [{ AttributeName: 'userId', AttributeType: 'S' }],
    KeySchema: [{ AttributeName: 'userId', KeyType: 'HASH' }],
  },
  {
    TableName: TABLES.prekeys,
    BillingMode: BILLING,
    AttributeDefinitions: [
      { AttributeName: 'userId', AttributeType: 'S' },
      { AttributeName: 'keyId', AttributeType: 'N' },
    ],
    KeySchema: [
      { AttributeName: 'userId', KeyType: 'HASH' },
      { AttributeName: 'keyId', KeyType: 'RANGE' },
    ],
  },
  {
    TableName: TABLES.sessions,
    BillingMode: BILLING,
    AttributeDefinitions: [
      { AttributeName: 'token', AttributeType: 'S' },
      { AttributeName: 'userId', AttributeType: 'S' },
    ],
    KeySchema: [{ AttributeName: 'token', KeyType: 'HASH' }],
    // Session revocation reaches a user's other sessions through this; rows
    // without a userId (pending verifications share the table) are simply not
    // indexed. KEYS_ONLY — nothing reads a session row in order to delete it.
    GlobalSecondaryIndexes: [
      {
        IndexName: SESSIONS_USER_INDEX,
        KeySchema: [{ AttributeName: 'userId', KeyType: 'HASH' }],
        Projection: { ProjectionType: 'KEYS_ONLY' },
      },
    ],
  },
  {
    TableName: TABLES.connections,
    BillingMode: BILLING,
    AttributeDefinitions: [{ AttributeName: 'userId', AttributeType: 'S' }],
    KeySchema: [{ AttributeName: 'userId', KeyType: 'HASH' }],
  },
  {
    // VoIP push tokens, one row per user.
    TableName: TABLES.pushTokens,
    BillingMode: BILLING,
    AttributeDefinitions: [{ AttributeName: 'userId', AttributeType: 'S' }],
    KeySchema: [{ AttributeName: 'userId', KeyType: 'HASH' }],
  },
  {
    // Abuse reports. Keyed by an opaque ULID and carrying
    // no index: a GSI on either party would turn the table into a
    // "who reported whom" enumeration primitive, which is exactly what a
    // report must not be.
    TableName: TABLES.reports,
    BillingMode: BILLING,
    AttributeDefinitions: [{ AttributeName: 'reportId', AttributeType: 'S' }],
    KeySchema: [{ AttributeName: 'reportId', KeyType: 'HASH' }],
  },
  {
    TableName: TABLES.messages,
    BillingMode: BILLING,
    AttributeDefinitions: [
      { AttributeName: 'recipientId', AttributeType: 'S' },
      { AttributeName: 'msgId', AttributeType: 'S' },
    ],
    KeySchema: [
      { AttributeName: 'recipientId', KeyType: 'HASH' },
      { AttributeName: 'msgId', KeyType: 'RANGE' },
    ],
  },
  {
    // Pairwise consent edges: one row per directed
    // (human -> agent) authorization plus the per-human `#count` control
    // row. NO index, ever — a GSI on agentId would answer "who consented to
    // this agent", the enumeration D6.2 refuses to every caller. No TTL:
    // an edge is durable authorization state, deleted by its writer or with
    // its writer's account.
    TableName: TABLES.consentEdges,
    BillingMode: BILLING,
    AttributeDefinitions: [
      { AttributeName: 'userId', AttributeType: 'S' },
      { AttributeName: 'agentId', AttributeType: 'S' },
    ],
    KeySchema: [
      { AttributeName: 'userId', KeyType: 'HASH' },
      { AttributeName: 'agentId', KeyType: 'RANGE' },
    ],
  },
  {
    // Call-metric batch dedupe claims (HttpFn only): the opaque dedupe
    // key and a content digest, never a report body or a caller — same
    // PK and TTL attribute as the stack's CallMetricDedupeTable.
    TableName: CALL_METRIC_DEDUPE_TABLE.name,
    BillingMode: BILLING,
    AttributeDefinitions: [
      { AttributeName: CALL_METRIC_DEDUPE_TABLE.partitionKey, AttributeType: 'S' },
    ],
    KeySchema: [{ AttributeName: CALL_METRIC_DEDUPE_TABLE.partitionKey, KeyType: 'HASH' }],
  },
  {
    // Fixed-window rate-limit counters: one row per
    // (bucket, window), atomic ADD, reaped by TTL.
    TableName: TABLES.rateBuckets,
    BillingMode: BILLING,
    AttributeDefinitions: [{ AttributeName: 'bucket', AttributeType: 'S' }],
    KeySchema: [{ AttributeName: 'bucket', KeyType: 'HASH' }],
  },
  {
    TableName: TABLES.activity,
    BillingMode: BILLING,
    AttributeDefinitions: [
      { AttributeName: 'actorHash', AttributeType: 'S' },
      { AttributeName: 'activityDay', AttributeType: 'S' },
      { AttributeName: 'activityHourActor', AttributeType: 'S' },
    ],
    KeySchema: [{ AttributeName: 'actorHash', KeyType: 'HASH' }],
    GlobalSecondaryIndexes: [
      {
        IndexName: ACTIVITY_DAY_INDEX,
        KeySchema: [
          { AttributeName: 'activityDay', KeyType: 'HASH' },
          { AttributeName: 'activityHourActor', KeyType: 'RANGE' },
        ],
        Projection: { ProjectionType: 'KEYS_ONLY' },
      },
    ],
  },
];

async function main(): Promise<void> {
  const { TableNames = [] } = await client.send(new ListTablesCommand({}));
  const existing = new Set(TableNames);

  for (const def of definitions) {
    const name = def.TableName!;
    if (existing.has(name)) {
      console.log(`= exists   ${name}`);
      continue;
    }
    await client.send(new CreateTableCommand(def));
    await waitUntilTableExists({ client, maxWaitTime: 30 }, { TableName: name });
    console.log(`+ created  ${name}`);

    const ttlAttr = TTL_ATTR[name];
    if (ttlAttr) {
      // DynamoDB Local accepts the call but does not enforce TTL (see sweep.ts).
      await client.send(
        new UpdateTimeToLiveCommand({
          TableName: name,
          TimeToLiveSpecification: { Enabled: true, AttributeName: ttlAttr },
        }),
      );
      console.log(`  ttl on   ${name}.${ttlAttr}`);
    }
  }

  const { TableNames: after = [] } = await client.send(new ListTablesCommand({}));
  console.log(`\nTables in ${ENDPOINT}: ${after.sort().join(', ')}`);
}

main().catch((err) => {
  console.error('create-tables failed:', err);
  process.exit(1);
});
