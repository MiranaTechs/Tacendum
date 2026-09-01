import { describe, expect, it } from 'vitest';
import { TABLES } from '@tacendum/shared';
import { readDynamoConfig } from '../src/db/client.js';

describe('smoke', () => {
  it('exposes every canonical table name', () => {
    // Pinned so a table arriving without review —
    // the usual way an unreviewed data store lands in a privacy-sensitive
    // system — fails here before it reaches the CDK.
    expect(Object.keys(TABLES)).toHaveLength(10);
    expect(TABLES.consentEdges).toBe('tacendum_consent_edges');
    expect(TABLES.messages).toBe('tacendum_messages');
    expect(TABLES.pushTokens).toBe('tacendum_push_tokens');
    expect(TABLES.rateBuckets).toBe('tacendum_rate_buckets');
    expect(TABLES.activity).toBe('tacendum_activity');
  });

  it('defaults to the local DynamoDB endpoint', () => {
    const config = readDynamoConfig({});
    expect(config.endpoint).toBe('http://localhost:8000');
    expect(config.region).toBe('us-east-1');
  });
});
