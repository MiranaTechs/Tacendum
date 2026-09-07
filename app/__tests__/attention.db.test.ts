/**
 * The attention inbox reads durable approval facts through one aggregate
 * query.  These tests bind the real db module to an in-memory Node SQLite
 * engine so joins, deadline ordering, and maintenance are exercised by the
 * same SQL that ships on device.
 */
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

let engine: Engine;

const rows = (sql: string, ...args: unknown[]): Row[] =>
  engine.prepare(sql).all(...args);

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

const pad = (seed: string): string => (seed + '0'.repeat(26)).slice(0, 26);
const CLAUDE = pad('CLAUDE');
const CODEX = pad('CODEX');
const NOW = 1_800_000_000_000;

type PendingApprovalSummary = {
  peerId: string;
  q: string;
  deadline: number;
  displayName: string | null;
  machine: boolean;
};
type ListPending = (now: number) => Promise<PendingApprovalSummary[]>;
type RecordRevoked = (peerId: string, at: number) => Promise<void>;

const listPending = (): ListPending | undefined =>
  (
    db as unknown as {
      listPendingApprovalSummaries?: ListPending;
    }
  ).listPendingApprovalSummaries;
const recordRevoked = (): RecordRevoked | undefined =>
  (
    db as unknown as {
      recordMachineRevoked?: RecordRevoked;
    }
  ).recordMachineRevoked;

beforeEach(async () => {
  await db.close();
  sqlite.__sqlite.reset();
  db.setWorkspace('real');
  bindRealEngine();
  await db.initDb();
});

afterEach(async () => {
  await db.close();
  engine.close();
});

test('includes preview-less approval chats and sorts the nearest deadline first', async () => {
  await db.upsertChat(CLAUDE, 'Claude Code');
  await db.upsertChat(CODEX, 'Codex');
  await db.recordMachinePeer(CLAUDE, NOW - 1_000);

  await db.insertApproval({
    peerId: CLAUDE,
    q: 'q-later',
    wireMsgId: 'wire-later',
    kind: 'exec',
    payload: 'npm test',
    ttlSec: 120,
    sessionTag: null,
    verbs: ['approve', 'deny'],
    ts: NOW - 2_000,
    arrivedAt: NOW - 2_000,
  });
  await db.insertApproval({
    peerId: CODEX,
    q: 'q-sooner',
    wireMsgId: 'wire-sooner',
    kind: 'file',
    payload: '/tmp/report.txt',
    ttlSec: 30,
    sessionTag: null,
    verbs: ['approve', 'deny'],
    ts: NOW - 1_000,
    arrivedAt: NOW - 1_000,
  });

  const query = listPending();
  expect(query).toBeDefined();
  if (!query) return;

  await expect(query(NOW)).resolves.toEqual([
    expect.objectContaining({
      peerId: CODEX,
      q: 'q-sooner',
      deadline: NOW + 29_000,
      displayName: 'Codex',
      machine: false,
    }),
    expect.objectContaining({
      peerId: CLAUDE,
      q: 'q-later',
      deadline: NOW + 118_000,
      displayName: 'Claude Code',
      machine: true,
    }),
  ]);
});

test('lapses expired requests globally and never returns them as pending', async () => {
  await db.upsertChat(CLAUDE, 'Claude Code');
  await db.insertApproval({
    peerId: CLAUDE,
    q: 'q-expired',
    wireMsgId: 'wire-expired',
    kind: 'exec',
    payload: 'npm test',
    ttlSec: 1,
    sessionTag: null,
    verbs: ['approve', 'deny'],
    ts: NOW - 2_000,
    arrivedAt: NOW - 2_000,
  });

  await expect(listPending()!(NOW)).resolves.toEqual([]);
  await expect(db.listApprovals(CLAUDE, NOW)).resolves.toEqual([
    expect.objectContaining({
      q: 'q-expired',
      state: 'lapsed',
      settledAt: NOW - 1_000,
    }),
  ]);
});

test('does not count a request after the authenticated host reports an answer', async () => {
  const q = '01J00000000000000000000000';
  await db.upsertChat(CLAUDE, 'Claude Code');
  await db.insertApproval({
    peerId: CLAUDE,
    q,
    wireMsgId: 'wire-host-observed',
    kind: 'exec',
    payload: 'pnpm test',
    ttlSec: 120,
    sessionTag: null,
    verbs: ['approve', 'deny'],
    ts: NOW,
    arrivedAt: NOW,
  });
  await db.recordAiWork(CLAUDE, 'wire-host-answer', NOW + 1, {
    provider: 'claude',
    updatedAt: NOW + 1,
    requestId: q,
    approvalObservation: 'answer-received',
  });

  await expect(listPending()!(NOW + 2)).resolves.toEqual([]);
  await expect(db.listApprovals(CLAUDE, NOW + 2)).resolves.toEqual([
    expect.objectContaining({
      state: 'pending',
      hostObservation: 'answer-received',
    }),
  ]);
});

test('an identity-change hold and a block keep approvals out of the inbox', async () => {
  await db.upsertChat(CLAUDE, 'Claude Code');
  await db.insertApproval({
    peerId: CLAUDE,
    q: 'q-held',
    wireMsgId: 'wire-held',
    kind: 'other',
    payload: 'opaque request',
    ttlSec: 120,
    sessionTag: null,
    verbs: ['approve', 'deny'],
    ts: NOW,
    arrivedAt: NOW,
  });

  await db.setIdentityChanged(CLAUDE, NOW);
  await expect(listPending()!(NOW)).resolves.toEqual([]);
  await db.setIdentityChanged(CLAUDE, null);
  await expect(listPending()!(NOW)).resolves.toHaveLength(1);

  await db.blockPeer(CLAUDE, NOW);
  await expect(listPending()!(NOW)).resolves.toEqual([]);
  await db.unblockPeer(CLAUDE);
  // Blocking burns already-held requests. Lifting the block must not revive
  // an ask whose sender was unable to receive an answer while blocked.
  await expect(listPending()!(NOW)).resolves.toEqual([]);
});

test('deleting then recreating a conversation cannot revive its old approvals', async () => {
  await db.upsertChat(CODEX, 'Codex');
  await db.insertApproval({
    peerId: CODEX,
    q: 'q-deleted',
    wireMsgId: 'wire-deleted',
    kind: 'file',
    payload: '/tmp/report.txt',
    ttlSec: 120,
    sessionTag: null,
    verbs: ['approve', 'deny'],
    ts: NOW,
    arrivedAt: NOW,
  });

  await db.deleteChat(CODEX);
  await db.upsertChat(CODEX, 'Codex again');

  await expect(listPending()!(NOW)).resolves.toEqual([]);
  await expect(db.listApprovals(CODEX, NOW)).resolves.toEqual([]);
});

test('global maintenance redacts and reaps legacy orphans whose threads never open', async () => {
  const redactSettledAt = NOW - db.APPROVAL_REDACT_AFTER_MS;
  await db.insertApproval({
    peerId: CLAUDE,
    q: 'q-orphan-redact',
    wireMsgId: 'wire-orphan-redact',
    kind: 'exec',
    payload: 'secret command bytes',
    ttlSec: 60,
    sessionTag: null,
    verbs: ['approve', 'deny'],
    ts: redactSettledAt - 1_000,
    arrivedAt: redactSettledAt - 1_000,
  });
  expect(
    await db.settleApproval(
      CLAUDE,
      'q-orphan-redact',
      'approve',
      redactSettledAt,
    ),
  ).toBe(true);

  const reapArrivedAt = NOW - db.APPROVAL_RETAIN_MS - 2_000;
  await db.insertApproval({
    peerId: CODEX,
    q: 'q-orphan-reap',
    wireMsgId: 'wire-orphan-reap',
    kind: 'file',
    payload: '/private/old.txt',
    ttlSec: 1,
    sessionTag: null,
    verbs: ['approve', 'deny'],
    ts: reapArrivedAt,
    arrivedAt: reapArrivedAt,
  });

  // Neither peer has a chats row: this models data left by the old
  // deleteChat implementation. The inbox returns neither, while its global
  // maintenance still clears exact bytes and removes retained history.
  await expect(listPending()!(NOW)).resolves.toEqual([]);
  expect(rows(`SELECT q, payload FROM approvals ORDER BY q ASC`)).toEqual([
    { q: 'q-orphan-redact', payload: '' },
  ]);
});

test('a confirmed machine revocation persists, burns requests, and rejects future asks', async () => {
  await db.upsertChat(CLAUDE, 'Claude Code');
  await db.insertApproval({
    peerId: CLAUDE,
    q: 'q-before-revoke',
    wireMsgId: 'wire-before-revoke',
    kind: 'exec',
    payload: 'npm publish',
    ttlSec: 120,
    sessionTag: null,
    verbs: ['approve', 'deny'],
    ts: NOW,
    arrivedAt: NOW,
  });

  const revoke = recordRevoked();
  expect(revoke).toBeDefined();
  if (!revoke) return;
  await revoke(CLAUDE, NOW + 1);

  expect(rows(`SELECT peerId, revokedAt FROM revoked_machine_peers`)).toEqual([
    { peerId: CLAUDE, revokedAt: NOW + 1 },
  ]);
  await expect(db.listApprovals(CLAUDE, NOW + 1)).resolves.toEqual([]);

  // Conversation deletion/recreation cannot erase lifecycle history, and a
  // late or replayed frame from the retired key is refused at persistence.
  await db.deleteChat(CLAUDE);
  await db.upsertChat(CLAUDE, 'Claude Code again');
  await expect(
    db.insertApproval({
      peerId: CLAUDE,
      q: 'q-after-revoke',
      wireMsgId: 'wire-after-revoke',
      kind: 'file',
      payload: '/tmp/release.txt',
      ttlSec: 120,
      sessionTag: null,
      verbs: ['approve', 'deny'],
      ts: NOW + 2,
      arrivedAt: NOW + 2,
    }),
  ).resolves.toBe(false);
  await expect(listPending()!(NOW + 2)).resolves.toEqual([]);
});
