import { describe, expect, it } from 'vitest';
import { TABLES as LOCAL_TABLES, TABLE_ENV_VARS } from '@tacendum/shared';
import { readTableNames } from '../src/db/tables.js';
import { readDynamoConfig } from '../src/db/client.js';

/**
 * In AWS the CDK stack passes CloudFormation-generated table names to Lambda
 * via env vars; locally they are unset and the canonical names apply.
 */
describe('readTableNames', () => {
  it('falls back to the canonical local names when env vars are unset', () => {
    expect(readTableNames({})).toEqual(LOCAL_TABLES);
  });

  it('throws on a set-but-empty table env var instead of silently falling back', () => {
    // '' is a meaningful sentinel for DDB_ENDPOINT but never for a table name;
    // falling back to the local name in a real Region would fail per-request.
    expect(() => readTableNames({ [TABLE_ENV_VARS.users]: '' })).toThrow(
      `${TABLE_ENV_VARS.users} is set but empty`,
    );
  });

  it('resolves every table from its TACENDUM_TABLE_* env var', () => {
    const env = {
      [TABLE_ENV_VARS.users]: 'gen-users',
      [TABLE_ENV_VARS.prekeys]: 'gen-prekeys',
      [TABLE_ENV_VARS.sessions]: 'gen-sessions',
      [TABLE_ENV_VARS.connections]: 'gen-connections',
      [TABLE_ENV_VARS.messages]: 'gen-messages',
      [TABLE_ENV_VARS.pushTokens]: 'gen-push-tokens',
      [TABLE_ENV_VARS.rateBuckets]: 'gen-rate-buckets',
      [TABLE_ENV_VARS.activity]: 'gen-activity',
      [TABLE_ENV_VARS.reports]: 'gen-reports',
      [TABLE_ENV_VARS.consentEdges]: 'gen-consent-edges',
    };
    expect(readTableNames(env)).toEqual({
      users: 'gen-users',
      prekeys: 'gen-prekeys',
      sessions: 'gen-sessions',
      connections: 'gen-connections',
      messages: 'gen-messages',
      pushTokens: 'gen-push-tokens',
      rateBuckets: 'gen-rate-buckets',
      activity: 'gen-activity',
      reports: 'gen-reports',
      consentEdges: 'gen-consent-edges',
    });
  });
});

describe('readDynamoConfig endpoint', () => {
  it('treats an empty DDB_ENDPOINT as "use the real AWS endpoint"', () => {
    expect(readDynamoConfig({ DDB_ENDPOINT: '' }).endpoint).toBeUndefined();
  });

  it('defaults to DynamoDB Local when unset', () => {
    expect(readDynamoConfig({}).endpoint).toBe('http://localhost:8000');
  });
});
