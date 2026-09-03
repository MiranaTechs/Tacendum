import { afterAll, beforeAll, it } from 'vitest';
import { ListTablesCommand } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { TABLES } from '@tacendum/shared';
import { makeDocClient, makeDynamoClient } from '../src/db/client.js';
import { TABLES as SERVER_TABLES } from '../src/db/tables.js';
import { makeTestOnlyDataLayer, type TestOnlyDataLayer } from '../src/db/data.js';
import { mintedClaimKeys, selfDiscoverySuite } from './accounts-discovery-self.suite.js';

/**
 * SELF-DISCOVERY IS A MISS — the DynamoDB Local leg. The scenario is
 * accounts-discovery-self.suite.ts, shared verbatim with the memory twin in
 * accounts-discovery-self.twin.test.ts.
 *
 * This file is `heavy` (vitest.config.ts): it opens ListTables against :8000 in
 * beforeAll and drives the routes against the real store. CI runs only
 * `--project fast`, which is exactly why the store-blind twin no longer lives
 * here. */

const REQUIRE = process.env.TACENDUM_REQUIRE_DDB === '1';

// --- DynamoDB Local (gated on availability; REQUIRE forces). ---
let ddb: TestOnlyDataLayer;
let doc: DynamoDBDocumentClient;
let available = false;

beforeAll(async () => {
  const client = makeDynamoClient();
  doc = makeDocClient(client);
  const base = makeTestOnlyDataLayer(doc);
  ddb = {
    ...base,
    isAccountsFeatureEnabled: async () => true,
    isAccountsPhoneFeatureEnabled: async () => true,
    isAccountsUsernameFeatureEnabled: async () => true,
  };
  try {
    const { TableNames = [] } = await client.send(new ListTablesCommand({}));
    available = TableNames.includes(TABLES.users);
  } catch {
    available = false;
  }
  if (REQUIRE && !available) {
    throw new Error('TACENDUM_REQUIRE_DDB=1 but DynamoDB Local unavailable');
  }
});

afterAll(async () => {
  if (!available) return;
  for (const claimKey of mintedClaimKeys) {
    await doc.send(
      new DeleteCommand({ TableName: SERVER_TABLES.users, Key: { userId: claimKey } }),
    );
  }
});

selfDiscoverySuite(
  'DynamoDB Local',
  () => ddb,
  (name, fn) => {
    it(name, async (ctx) => {
      if (!available) return ctx.skip();
      await fn();
    });
  },
);
