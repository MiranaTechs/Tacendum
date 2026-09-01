import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

/**
 * DynamoDB configuration, injected via env so the same handlers run against
 * DynamoDB Local now and real DynamoDB after the AWS deploy (invariant).
 */
export interface DynamoConfig {
  region: string;
  endpoint: string | undefined;
}

export function readDynamoConfig(env: NodeJS.ProcessEnv = process.env): DynamoConfig {
  // Unset locally -> DynamoDB Local default. The CDK stack sets it to '' in
  // AWS -> undefined, so the SDK resolves the real regional endpoint.
  const endpoint = env.DDB_ENDPOINT ?? 'http://localhost:8000';
  return {
    region: env.AWS_REGION ?? 'us-east-1',
    endpoint: endpoint === '' ? undefined : endpoint,
  };
}

export function makeDynamoClient(config: DynamoConfig = readDynamoConfig()): DynamoDBClient {
  const isLocal = Boolean(config.endpoint);
  return new DynamoDBClient({
    region: config.region,
    ...(config.endpoint ? { endpoint: config.endpoint } : {}),
    // DynamoDB Local ignores credentials but the SDK still requires some.
    ...(isLocal
      ? { credentials: { accessKeyId: 'local', secretAccessKey: 'local' } }
      : {}),
  });
}

export function makeDocClient(client: DynamoDBClient = makeDynamoClient()): DynamoDBDocumentClient {
  return DynamoDBDocumentClient.from(client, {
    marshallOptions: { removeUndefinedValues: true },
  });
}
