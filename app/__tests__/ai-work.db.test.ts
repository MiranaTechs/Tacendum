/**
 * Structured AI facts use the real app SQL against an in-memory SQLite
 * engine. The tests exercise event identity, receive-order timestamps,
 * request correlation and lifecycle erasure without touching an app file.
 */
import type { AiWorkMetadata } from '@tacendum/shared';
import * as db from '../src/db';

type Row = Record<string, unknown>;
interface Engine {
  prepare(sql: string): { all(...args: unknown[]): Row[] };
  close(): void;
}
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (path: string) => Engine;
};

interface FakeDb {
  execute: jest.Mock;
}
const sqlite = jest.requireMock('@op-engineering/op-sqlite') as {
  open: (options: { name: string }) => FakeDb;
  __sqlite: { reset: () => void };
};

const PEER = '01JWORKPEER000000000000001';
const OTHER = '01JWORKPEER000000000000002';
const Q = '01J8MEAPPR0VAQ4X2C6TKN9RFV';
const NOW = 1_800_000_000_000;
const EVENT_1 = '01J8MEAPPR0VAQ4X2C6TKN9RFW';
const EVENT_2 = '01J8MEAPPR0VAQ4X2C6TKN9RFX';

let engine: Engine;

function bindRealEngine(): void {
  engine = new DatabaseSync(':memory:');
  const instance = sqlite.open({ name: 'tacendum.sqlite' });
  instance.execute.mockImplementation(
    async (sql: unknown, params?: unknown[]) => {
      const args = (params ?? []).map(value =>
        value === undefined ? null : value,
      );
      const rows = engine.prepare(String(sql)).all(...args);
      const changes = engine.prepare('SELECT changes() AS c').all()[0]!
        .c as number;
      return { rows, rowsAffected: changes };
    },
  );
}

beforeEach(async () => {
  await db.close();
  sqlite.__sqlite.reset();
  db.setWorkspace('real');
  bindRealEngine();
  await db.initDb();
  await db.upsertChat(PEER, 'Claude Code');
  await db.upsertChat(OTHER, 'Codex');
});

afterEach(async () => {
  await db.close();
  engine.close();
});

const event = (
  eventId: string,
  overrides: Partial<AiWorkMetadata> = {},
): AiWorkMetadata => ({
  provider: 'claude',
  updatedAt: NOW - 1_000,
  event: 'turn-complete',
  eventId,
  project: 'Tacendum',
  runTag: 's-7c2e',
  ...overrides,
});

test('deduplicates only by authenticated peer plus eventId, never runTag or copy', async () => {
  await db.recordAiWork(
    PEER,
    'wire-1',
    NOW,
    event(EVENT_1, {
      capabilities: { notifications: true, approvals: true, tasks: true },
    }),
  );
  await db.recordAiWork(
    PEER,
    'wire-replay',
    NOW + 1,
    event(EVENT_1, {
      event: 'turn-failed',
      project: 'Replayed project',
      capabilities: { notifications: false, approvals: false, tasks: false },
    }),
  );
  await db.recordAiWork(PEER, 'wire-2', NOW + 2, event(EVENT_2));
  await db.recordAiWork(OTHER, 'wire-other', NOW + 3, event(EVENT_1));

  const rows = await db.listRecentAiWorkEvents(NOW + 4);
  expect(rows.map(row => [row.peerId, row.eventId, row.event])).toEqual([
    [OTHER, EVENT_1, 'turn-complete'],
    [PEER, EVENT_2, 'turn-complete'],
    [PEER, EVENT_1, 'turn-complete'],
  ]);
  await expect(db.getAiAgentState(PEER)).resolves.toMatchObject({
    project: 'Tacendum',
    capabilities: { notifications: true, approvals: true, tasks: true },
    lastReceivedAt: NOW + 2,
  });
});

test('a provider change clears absent provider-scoped facts', async () => {
  await db.recordAiWork(PEER, 'profile-claude', NOW, {
    provider: 'claude',
    updatedAt: NOW,
    project: 'Tacendum',
    capabilities: { notifications: true, approvals: true, tasks: true },
    context: {
      availability: 'captured',
      capturedAt: NOW,
      repository: 'natln/Tacendum',
    },
    usage: [
      {
        source: 'local-budget',
        unit: 'turns',
        period: 'session',
        observedAt: NOW,
        remaining: 3,
      },
    ],
  });
  await db.recordAiWork(PEER, 'profile-codex', NOW + 1, {
    provider: 'codex',
    updatedAt: NOW + 1,
  });

  await expect(db.getAiAgentState(PEER)).resolves.toMatchObject({
    provider: 'codex',
    project: null,
    capabilities: null,
    context: null,
    usage: null,
  });
});

test('message-origin facts disappear on logical expiry before a message sweep', async () => {
  const wireMsgId = 'wire-expiring-source';
  await db.insertMessage({
    msgId: wireMsgId,
    peerId: PEER,
    direction: 'in',
    body: 'source-backed update',
    ts: NOW,
    status: 'received',
    expiresAt: NOW + 100,
  });
  await db.recordAiWork(
    PEER,
    wireMsgId,
    NOW,
    event(EVENT_1, {
      context: {
        availability: 'captured',
        capturedAt: NOW,
        resultSummary: 'The turn completed.',
      },
    }),
    'message',
  );

  await expect(db.listRecentAiWorkEvents(NOW + 99)).resolves.toHaveLength(1);
  await expect(db.listRecentAiWorkEvents(NOW + 100)).resolves.toEqual([]);
  expect(engine.prepare(`SELECT COUNT(*) AS c FROM messages`).all()[0]!.c).toBe(1);
  await expect(db.getAiAgentState(PEER)).resolves.toMatchObject({
    project: null,
    context: null,
  });
});

test('message deletion removes its event and state context on the next workspace read', async () => {
  const wireMsgId = 'wire-deleted-source';
  await db.insertMessage({
    msgId: wireMsgId,
    peerId: PEER,
    direction: 'in',
    body: 'source-backed update',
    ts: NOW,
    status: 'received',
  });
  await db.recordAiWork(
    PEER,
    wireMsgId,
    NOW,
    event(EVENT_1, {
      context: {
        availability: 'captured',
        capturedAt: NOW,
        resultSummary: 'This copy belongs to the source message.',
      },
    }),
    'message',
  );

  await db.deleteMessage(wireMsgId, 'in');
  await expect(db.listRecentAiWorkEvents(NOW + 1)).resolves.toEqual([]);
  await expect(db.getAiAgentState(PEER)).resolves.toMatchObject({
    project: null,
    context: null,
  });
});

test('event context clears after one day and the event expires after seven days', async () => {
  const wireMsgId = 'wire-retained-source';
  await db.insertMessage({
    msgId: wireMsgId,
    peerId: PEER,
    direction: 'in',
    body: 'durable source update',
    ts: NOW,
    status: 'received',
  });
  await db.recordAiWork(
    PEER,
    wireMsgId,
    NOW,
    event(EVENT_1, {
      context: {
        availability: 'captured',
        capturedAt: NOW,
        resultSummary: 'Bounded supplementary result.',
      },
    }),
    'message',
  );

  await expect(
    db.listRecentAiWorkEvents(NOW + db.AI_WORK_CONTEXT_RETAIN_MS - 1),
  ).resolves.toEqual([
    expect.objectContaining({
      project: 'Tacendum',
      context: expect.objectContaining({
        resultSummary: 'Bounded supplementary result.',
      }),
    }),
  ]);
  await expect(
    db.listRecentAiWorkEvents(NOW + db.AI_WORK_CONTEXT_RETAIN_MS),
  ).resolves.toEqual([
    expect.objectContaining({ project: null, context: null }),
  ]);
  await expect(
    db.listRecentAiWorkEvents(NOW + db.AI_WORK_EVENT_RETAIN_MS),
  ).resolves.toEqual([]);
  expect(engine.prepare(`SELECT COUNT(*) AS c FROM messages`).all()[0]!.c).toBe(1);
});

test('settling an approval drops its event/state copy while preserving exact q/p receipt', async () => {
  const wireMsgId = 'wire-approval-source';
  const work = event(EVENT_1, {
    event: 'needs-review',
    requestId: Q,
    context: {
      availability: 'captured',
      capturedAt: NOW,
      branch: 'feature/chat-review',
    },
  });
  await db.insertApproval({
    peerId: PEER,
    q: Q,
    wireMsgId,
    kind: 'exec',
    payload: 'pnpm test\n--filter exact',
    ttlSec: 600,
    sessionTag: null,
    verbs: ['approve', 'deny'],
    ts: NOW,
    arrivedAt: NOW,
    work,
  });
  await db.recordAiWork(PEER, wireMsgId, NOW, work, 'approval');
  expect((await db.listApprovals(PEER, NOW + 1))[0]!.payload).toBe(
    'pnpm test\n--filter exact',
  );
  await db.settleApproval(PEER, Q, 'approve', NOW + 2);

  await expect(db.listRecentAiWorkEvents(NOW + 3)).resolves.toEqual([]);
  await expect(db.getAiAgentState(PEER)).resolves.toMatchObject({
    project: null,
    context: null,
  });
  expect((await db.listApprovals(PEER, NOW + 3))[0]).toMatchObject({
    payload: 'pnpm test\n--filter exact',
    state: 'answered',
  });
});

test('profile project/context expire at the bounded context lifetime', async () => {
  await db.recordAiWork(PEER, 'profile-context', NOW, {
    provider: 'claude',
    updatedAt: NOW,
    project: 'Tacendum',
    capabilities: { notifications: true, approvals: false, tasks: false },
    context: {
      availability: 'captured',
      capturedAt: NOW,
      repository: 'natln/Tacendum',
    },
  });

  await db.listRecentAiWorkEvents(NOW + db.AI_WORK_CONTEXT_RETAIN_MS);
  await expect(db.getAiAgentState(PEER)).resolves.toMatchObject({
    provider: 'claude',
    project: null,
    context: null,
    capabilities: { notifications: true, approvals: false, tasks: false },
  });
});

test('uses phone receive order and labels a future source clock untrusted', async () => {
  await db.recordAiWork(
    PEER,
    'wire-future',
    NOW,
    event(EVENT_1, { updatedAt: NOW + 10 * 60_000 }),
  );
  await db.recordAiWork(
    PEER,
    'wire-older-source',
    NOW + 1,
    event(EVENT_2, { updatedAt: NOW - 60_000 }),
  );

  const rows = await db.listRecentAiWorkEvents(NOW + 2);
  expect(rows.map(row => row.eventId)).toEqual([EVENT_2, EVENT_1]);
  expect(rows[1]).toMatchObject({
    sourceAt: NOW + 10 * 60_000,
    displayAt: NOW,
    timeTrusted: false,
  });
});

test('merges source-backed capability, context and usage snapshots without inventing missing values', async () => {
  await db.recordAiWork(PEER, 'wire-capability', NOW, {
    provider: 'codex',
    updatedAt: NOW,
    project: 'Tacendum',
    capabilities: { notifications: true, approvals: true, tasks: false },
    context: {
      availability: 'captured',
      capturedAt: NOW - 2_000,
      repository: 'natln/Tacendum',
      branch: 'feature/chat-review',
    },
  });
  await db.recordAiWork(PEER, 'wire-usage', NOW + 1, {
    provider: 'codex',
    updatedAt: NOW + 1,
    usage: [
      {
        source: 'local-budget',
        unit: 'turns',
        period: 'session',
        observedAt: NOW,
        remaining: 0,
        limit: 12,
      },
    ],
  });

  await expect(db.getAiAgentState(PEER)).resolves.toMatchObject({
    provider: 'codex',
    project: 'Tacendum',
    capabilities: { notifications: true, approvals: true, tasks: false },
    context: {
      availability: 'captured',
      repository: 'natln/Tacendum',
      branch: 'feature/chat-review',
    },
    usage: [
      expect.objectContaining({
        source: 'local-budget',
        unit: 'turns',
        remaining: 0,
      }),
    ],
  });
  await expect(db.getAiAgentState(OTHER)).resolves.toBeNull();
});

test('correlates host observations to the same peer and request without changing local answer state', async () => {
  for (const peerId of [PEER, OTHER]) {
    await db.insertApproval({
      peerId,
      q: Q,
      wireMsgId: `wire-approval-${peerId}`,
      kind: 'exec',
      payload: 'pnpm test',
      ttlSec: 600,
      sessionTag: null,
      verbs: ['approve', 'deny'],
      ts: NOW,
      arrivedAt: NOW,
    });
  }
  await db.recordAiWork(PEER, 'wire-observation', NOW + 2, {
    provider: 'claude',
    updatedAt: NOW + 1,
    requestId: Q,
    approvalObservation: 'decision-returned',
  });

  const mine = (await db.listApprovals(PEER, NOW + 3))[0]!;
  expect(mine).toMatchObject({
    state: 'pending',
    hostObservation: 'decision-returned',
    hostObservationProvider: 'claude',
    hostObservationReceivedAt: NOW + 2,
  });
  expect((await db.listApprovals(OTHER, NOW + 3))[0]!.hostObservation).toBeNull();

  await db.recordAiWork(PEER, 'wire-observation-late-low', NOW + 4, {
    provider: 'claude',
    updatedAt: NOW + 4,
    requestId: Q,
    approvalObservation: 'answer-received',
  });
  await db.recordAiWork(PEER, 'wire-observation-duplicate', NOW + 5, {
    provider: 'claude',
    updatedAt: NOW + 5,
    requestId: Q,
    approvalObservation: 'decision-returned',
  });

  expect((await db.listApprovals(PEER, NOW + 6))[0]).toMatchObject({
    hostObservation: 'decision-returned',
    hostObservationSourceAt: NOW + 1,
    hostObservationReceivedAt: NOW + 2,
  });
});

test('revoke burns structured work and rejects late facts after chat recreation', async () => {
  await db.recordAiWork(PEER, 'wire-1', NOW, event(EVENT_1));
  await db.recordMachineRevoked(PEER, NOW + 1);
  await db.deleteChat(PEER);
  await db.upsertChat(PEER, 'Claude Code again');
  await db.recordAiWork(PEER, 'wire-late', NOW + 2, event(EVENT_2));

  await expect(db.listRecentAiWorkEvents(NOW + 3)).resolves.toEqual([]);
  await expect(db.getAiAgentState(PEER)).resolves.toBeNull();
});
