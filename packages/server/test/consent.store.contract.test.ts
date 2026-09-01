import { describe, expect, it } from 'vitest';
import {
  DeleteCommand,
  QueryCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { CONSENT_TXN_ATTEMPTS, makeDataLayer } from '../src/db/data.js';

/**
 * The consent store's two .2-remediation contracts, pinned against a
 * scripted doc client because neither is observable through DynamoDB Local
 * (Local serializes single-node and never emits TransactionConflict, and a
 * read's consistency flag is invisible in its results):
 *
 * 1. BOUNDED CONFLICT RETRY — every write and delete for one human
 * contends on the shared `#count` item, and the SDK does not retry
 * TransactionConflict (a non-throttling 400). The old code's comment
 * said "the caller retries"; no caller did, so a concurrent grant or
 * revoke surfaced as a 500. The retry lives in the data layer now,
 * bounded by CONSENT_TXN_ATTEMPTS, reasons-read: a refused condition
 * is an ANSWER (never retried), a pure conflict is a transient
 * (retried), exhaustion is the honest throw.
 *
 * 2. purgeConsentEdges READS STRONGLY CONSISTENTLY — the only purge-swept
 * table with no TTL backstop: a row an eventually-consistent page
 * missed would survive account deletion forever, unreachable (no read
 * route, no agentId index). listOneTimePrekeyIds is the precedent.
 */

type Sent = { kind: 'transact' | 'delete' | 'query' | 'other'; input: Record<string, unknown> };

function conflictError(reasons: Array<{ Code?: string }>): Error {
  const err = new Error('Transaction cancelled');
  err.name = 'TransactionCanceledException';
  (err as unknown as { CancellationReasons: Array<{ Code?: string }> }).CancellationReasons =
    reasons;
  return err;
}

const PURE_CONFLICT = [{ Code: 'TransactionConflict' }, { Code: 'TransactionConflict' }];

/** A doc client that runs a script: each entry either throws or resolves. */
function scriptedDoc(script: Array<Error | 'ok'>): { doc: DynamoDBDocumentClient; sent: Sent[] } {
  const sent: Sent[] = [];
  const doc = {
    send: async (cmd: unknown): Promise<Record<string, never>> => {
      sent.push({
        kind:
          cmd instanceof TransactWriteCommand
            ? 'transact'
            : cmd instanceof DeleteCommand
              ? 'delete'
              : cmd instanceof QueryCommand
                ? 'query'
                : 'other',
        input: (cmd as { input: Record<string, unknown> }).input,
      });
      const step = script.shift();
      if (step === undefined || step === 'ok') return {};
      throw step;
    },
  } as unknown as DynamoDBDocumentClient;
  return { doc, sent };
}

const HUMAN = '0000000000000000000PERSN01';
const AGENT = '0000000000000000000AGENT01';

describe('bounded conflict retry (writeConsentEdge)', () => {
  // Since every attempt begins with the caller-row
  // GetItem that resolves the caller's group for the per-group cap — an
  // empty result ({} → no row) is the solo shape, whose transaction gains
  // one user-row ConditionCheck beside the shipped two items. The scripts
  // below feed each attempt an 'ok' for that read, then the transact
  // outcome; the CONTRACTS pinned are unchanged — bounded retry, refusals
  // are answers, exhaustion throws.
  it('a pure TransactionConflict is retried and the second attempt lands — no 500 for a concurrent grant', async () => {
    const { doc, sent } = scriptedDoc(['ok', conflictError(PURE_CONFLICT), 'ok', 'ok']);
    const db = makeDataLayer(doc);
    expect(await db.writeConsentEdge(HUMAN, AGENT, 1)).toBe('written');
    expect(sent.filter((s) => s.kind === 'transact')).toHaveLength(2);
  });

  it('a refused condition is an ANSWER, never retried: already and cap_reached return on the first attempt', async () => {
    for (const [reasons, expected] of [
      [[{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }], 'already'],
      [[{ Code: 'None' }, { Code: 'ConditionalCheckFailed' }], 'cap_reached'],
    ] as const) {
      const { doc, sent } = scriptedDoc(['ok', conflictError([...reasons])]);
      const db = makeDataLayer(doc);
      expect(await db.writeConsentEdge(HUMAN, AGENT, 1)).toBe(expected);
      expect(sent.filter((s) => s.kind === 'transact')).toHaveLength(1);
    }
  });

  it('sustained contention exhausts the bound and throws honestly — never an unbounded spin', async () => {
    const script: Array<Error | 'ok'> = [];
    for (let i = 0; i < CONSENT_TXN_ATTEMPTS + 2; i += 1) {
      script.push('ok', conflictError(PURE_CONFLICT));
    }
    const { doc, sent } = scriptedDoc(script);
    const db = makeDataLayer(doc);
    await expect(db.writeConsentEdge(HUMAN, AGENT, 1)).rejects.toThrowError(
      'Transaction cancelled',
    );
    expect(sent.filter((s) => s.kind === 'transact')).toHaveLength(CONSENT_TXN_ATTEMPTS);
  });

  it('a non-transaction error propagates untouched on the first attempt', async () => {
    const boom = new Error('socket reset');
    const { doc, sent } = scriptedDoc(['ok', boom]);
    const db = makeDataLayer(doc);
    await expect(db.writeConsentEdge(HUMAN, AGENT, 1)).rejects.toThrowError('socket reset');
    expect(sent.filter((s) => s.kind === 'transact')).toHaveLength(1);
  });
});

describe('bounded conflict retry + delete-on-zero (deleteConsentEdge)', () => {
  it('a pure conflict on the decrement is retried, and revocation completes', async () => {
    const { doc, sent } = scriptedDoc([conflictError(PURE_CONFLICT), 'ok']);
    const db = makeDataLayer(doc);
    await db.deleteConsentEdge(HUMAN, AGENT);
    expect(sent.filter((s) => s.kind === 'transact')).toHaveLength(2);
  });

  it('the LAST edge routes to the delete-on-zero transaction: edge and #count leave together', async () => {
    // Attempt 1 (shape A, decrement conditioned on edges > 1): the counter
    // refuses — this is the last edge. Attempt 2 (shape B): both deletes.
    const { doc, sent } = scriptedDoc([
      conflictError([{ Code: 'None' }, { Code: 'ConditionalCheckFailed' }]),
      'ok',
    ]);
    const db = makeDataLayer(doc);
    await db.deleteConsentEdge(HUMAN, AGENT);
    expect(sent).toHaveLength(2);
    const shapeB = sent[1]!.input as {
      TransactItems: Array<{ Delete?: { Key: Record<string, unknown> } }>;
    };
    expect(shapeB.TransactItems).toHaveLength(2);
    expect(shapeB.TransactItems[0]?.Delete?.Key).toEqual({ userId: HUMAN, agentId: AGENT });
    expect(shapeB.TransactItems[1]?.Delete?.Key).toEqual({ userId: HUMAN, agentId: '#count' });
  });

  it('REVOCATION IS NEVER BLOCKED: drift no shape can satisfy falls back to the bare edge delete', async () => {
    // Counter refuses shape A (not > 1) and shape B (not = 1) on every
    // attempt — the drifted-counter state. The edge must still go.
    const script: Array<Error | 'ok'> = [];
    for (let i = 0; i < CONSENT_TXN_ATTEMPTS * 2; i += 1) {
      script.push(conflictError([{ Code: 'None' }, { Code: 'ConditionalCheckFailed' }]));
    }
    script.push('ok'); // the bare DeleteCommand
    const { doc, sent } = scriptedDoc(script);
    const db = makeDataLayer(doc);
    await db.deleteConsentEdge(HUMAN, AGENT);
    const last = sent[sent.length - 1]!;
    expect(last.kind).toBe('delete');
    expect(last.input).toMatchObject({ Key: { userId: HUMAN, agentId: AGENT } });
  });

  it('an already-gone edge returns on the first attempt (idempotent repeat)', async () => {
    const { doc, sent } = scriptedDoc([
      conflictError([{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }]),
    ]);
    const db = makeDataLayer(doc);
    await db.deleteConsentEdge(HUMAN, AGENT);
    expect(sent).toHaveLength(1);
  });
});

describe('purgeConsentEdges reads strongly consistently', () => {
  it('every purge page carries ConsistentRead: true — the no-TTL table cannot afford a stale page', async () => {
    const { doc, sent } = scriptedDoc(['ok']);
    const db = makeDataLayer(doc);
    await db.purgeConsentEdges(HUMAN);
    const queries = sent.filter((s) => s.kind === 'query');
    expect(queries).toHaveLength(1);
    expect(queries[0]!.input.ConsistentRead).toBe(true);
    // And the first page carries NO ExclusiveStartKey (the sibling
    // paginators' conditional-spread shape, not an explicit undefined).
    expect('ExclusiveStartKey' in queries[0]!.input).toBe(false);
  });
});
