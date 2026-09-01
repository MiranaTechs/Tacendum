import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ListTablesCommand } from '@aws-sdk/client-dynamodb';
import { GetCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { CONSENT_MAX_EDGES, TABLES } from '@tacendum/shared';
import { makeDocClient, makeDynamoClient } from '../src/db/client.js';
import { CONSENT_COUNT_KEY, makeDataLayer, type DataLayer } from '../src/db/data.js';

/**
 * The consent-edge store against REAL DynamoDB
 * Local: the write transaction's cap and idempotence, the delete
 * transaction's exactly-once slot release and its never-blocked edge
 * delete, the strongly consistent predicate read, the control-key refusal
 * and the account-deletion purge. The memory twin mirrors these semantics;
 * this suite is what keeps the mirror honest against the store.
 *
 * Skips when DynamoDB Local is down or the table has not been created
 * (run `pnpm tables:create`) unless TACENDUM_REQUIRE_DDB=1.
 */

const REQUIRE = process.env.TACENDUM_REQUIRE_DDB === '1';

let doc: DynamoDBDocumentClient;
let db: DataLayer;
let available = false;

/** Run-unique digits-only ULIDs (crew.ws.test.ts's scheme, own `8` marker). */
const RUN = `${Date.now()}`;
let seq = 0;
function uid(): string {
  return `01${`${RUN}8${String(++seq).padStart(4, '0')}`.padStart(24, '0')}`;
}

const purgeUsers: string[] = [];

beforeAll(async () => {
  const client = makeDynamoClient();
  doc = makeDocClient(client);
  db = makeDataLayer(doc);
  try {
    const { TableNames = [] } = await client.send(new ListTablesCommand({}));
    available = TableNames.includes(TABLES.consentEdges);
  } catch {
    available = false;
  }
  if (REQUIRE && !available) {
    throw new Error(
      'TACENDUM_REQUIRE_DDB=1 but DynamoDB Local (or tacendum_consent_edges — run pnpm tables:create) is unavailable',
    );
  }
});

afterAll(async () => {
  if (!available) return;
  for (const userId of purgeUsers) await db.purgeConsentEdges(userId);
});

async function countRow(userId: string): Promise<number | undefined> {
  const res = await doc.send(
    new GetCommand({
      TableName: TABLES.consentEdges,
      Key: { userId, agentId: CONSENT_COUNT_KEY },
      ConsistentRead: true,
    }),
  );
  return (res.Item as { edges?: number } | undefined)?.edges;
}

describe('consent-edge store (DynamoDB Local)', () => {
  it('writes, reads strongly consistently, re-consents idempotently, and counts exactly once', async () => {
    if (!available) return;
    const human = uid();
    const agent = uid();
    purgeUsers.push(human);
    expect(await db.hasConsentEdge(human, agent)).toBe(false);
    expect(await db.writeConsentEdge(human, agent, Date.now())).toBe('written');
    expect(await db.hasConsentEdge(human, agent)).toBe(true);
    expect(await countRow(human)).toBe(1);
    // Idempotent re-consent: 'already', and the counter does NOT move — the
    // transaction cancels whole, which is the whole point of the Put
    // condition living inside it.
    expect(await db.writeConsentEdge(human, agent, Date.now())).toBe('already');
    expect(await countRow(human)).toBe(1);
  });

  it('enforces CONSENT_MAX_EDGES in the transaction condition and frees slots on delete', async () => {
    if (!available) return;
    const human = uid();
    purgeUsers.push(human);
    const agents: string[] = [];
    for (let i = 0; i < CONSENT_MAX_EDGES; i += 1) {
      const agent = uid();
      agents.push(agent);
      expect(await db.writeConsentEdge(human, agent, Date.now())).toBe('written');
    }
    const over = uid();
    expect(await db.writeConsentEdge(human, over, Date.now())).toBe('cap_reached');
    expect(await db.hasConsentEdge(human, over)).toBe(false);
    expect(await countRow(human)).toBe(CONSENT_MAX_EDGES);
    // Delete one -> exactly one slot back.
    await db.deleteConsentEdge(human, agents[0]!);
    expect(await countRow(human)).toBe(CONSENT_MAX_EDGES - 1);
    expect(await db.writeConsentEdge(human, over, Date.now())).toBe('written');
    expect(await db.hasConsentEdge(human, over)).toBe(true);
  });

  it('a re-consent at the cap answers already, never cap_reached (edge precedence)', async () => {
    if (!available) return;
    const human = uid();
    purgeUsers.push(human);
    let first = '';
    for (let i = 0; i < CONSENT_MAX_EDGES; i += 1) {
      const agent = uid();
      if (i === 0) first = agent;
      await db.writeConsentEdge(human, agent, Date.now());
    }
    expect(await db.writeConsentEdge(human, first, Date.now())).toBe('already');
    expect(await countRow(human)).toBe(CONSENT_MAX_EDGES);
  });

  it('double-delete releases exactly once, and total revocation leaves NO counter row (delete-on-zero)', async () => {
    if (!available) return;
    const human = uid();
    const agent = uid();
    purgeUsers.push(human);
    await db.writeConsentEdge(human, agent, Date.now());
    await db.deleteConsentEdge(human, agent);
    await db.deleteConsentEdge(human, agent); // idempotent repeat
    // The LAST edge takes the `#count` row with it (a remediation): a
    // human who revokes everything leaves the table holding nothing about
    // them — the counter was the one row that outlived total revocation.
    expect(await countRow(human)).toBeUndefined();
    expect(await db.hasConsentEdge(human, agent)).toBe(false);
  });

  it('delete-on-zero re-arms cleanly: the next grant recreates the counter at 1 and the cap still holds', async () => {
    if (!available) return;
    const human = uid();
    purgeUsers.push(human);
    const a1 = uid();
    const a2 = uid();
    await db.writeConsentEdge(human, a1, Date.now());
    await db.deleteConsentEdge(human, a1);
    expect(await countRow(human)).toBeUndefined();
    // Recreation rides the write transaction's own attribute_not_exists
    // branch — the same path a first-ever consent takes.
    expect(await db.writeConsentEdge(human, a2, Date.now())).toBe('written');
    expect(await countRow(human)).toBe(1);
    // And a multi-edge partition only decrements: the counter row survives
    // while edges remain (the cap-reset hole stays shut).
    await db.writeConsentEdge(human, uid(), Date.now());
    await db.deleteConsentEdge(human, a2);
    expect(await countRow(human)).toBe(1);
  });

  it('deletion is never blocked by counter drift: the edge goes even when the count is already 0', async () => {
    if (!available) return;
    const human = uid();
    const agent = uid();
    purgeUsers.push(human);
    await db.writeConsentEdge(human, agent, Date.now());
    // Simulate drift: force the counter to zero underneath the live edge.
    await db.deleteConsentEdge(human, uid()); // no-op (edge absent), counter untouched
    const { UpdateCommand } = await import('@aws-sdk/lib-dynamodb');
    await doc.send(
      new UpdateCommand({
        TableName: TABLES.consentEdges,
        Key: { userId: human, agentId: CONSENT_COUNT_KEY },
        UpdateExpression: 'SET edges = :zero',
        ExpressionAttributeValues: { ':zero': 0 },
      }),
    );
    await db.deleteConsentEdge(human, agent);
    expect(await db.hasConsentEdge(human, agent)).toBe(false);
    expect(await countRow(human)).toBe(0);
  });

  it('refuses the #count control key as an edge probe', async () => {
    if (!available) return;
    const human = uid();
    purgeUsers.push(human);
    await db.writeConsentEdge(human, uid(), Date.now());
    expect(await db.hasConsentEdge(human, CONSENT_COUNT_KEY)).toBe(false);
  });

  it('purge sweeps the whole partition — edges and the control row', async () => {
    if (!available) return;
    const human = uid();
    const a1 = uid();
    const a2 = uid();
    await db.writeConsentEdge(human, a1, Date.now());
    await db.writeConsentEdge(human, a2, Date.now());
    await db.purgeConsentEdges(human);
    expect(await db.hasConsentEdge(human, a1)).toBe(false);
    expect(await db.hasConsentEdge(human, a2)).toBe(false);
    expect(await countRow(human)).toBeUndefined();
  });
});
