import * as db from '../src/db';

/**
 * Durable aggregate call metrics. The native SQLite mock records statements,
 * so these pin the state transitions that must remain atomic on a phone.
 */
interface FakeDb {
  name: string;
  execute: jest.Mock;
  close: jest.Mock;
}
const sqlite = (
  jest.requireMock('@op-engineering/op-sqlite') as {
    __sqlite: {
      instances: Map<string, FakeDb>;
      reset(): void;
    };
  }
).__sqlite;

function sqlOf(name = 'tacendum.sqlite'): string[] {
  return (sqlite.instances.get(name)?.execute.mock.calls ?? []).map(call =>
    String(call[0]),
  );
}
function callsMatching(re: RegExp, name = 'tacendum.sqlite') {
  return (sqlite.instances.get(name)?.execute.mock.calls ?? []).filter(call =>
    re.test(String(call[0])),
  );
}

const draft = {
  reportId: '01K2ABCDEF0123456789ABCDEF',
  localId: '01K2LOCAL000123456789ABCDE',
  scope: 'direct' as const,
  media: 'audio' as const,
  startedAt: 1_700_000_000_000,
  expiresAt: 1_700_604_800_000,
};
const groupDraft = {
  ...draft,
  localId: '01K2GROUP000123456789ABCDE',
  scope: 'group' as const,
};

beforeEach(async () => {
  await db.close();
  db.setWorkspace('real');
  sqlite.reset();
  await db.initDb();
});

describe('call metric report schema', () => {
  it('creates the lifecycle draft and partial due index', async () => {
    const schema = sqlOf().join('\n');
    expect(schema).toMatch(/CREATE TABLE IF NOT EXISTS call_metric_reports/);
    expect(schema).toMatch(/reportId TEXT PRIMARY KEY/);
    expect(schema).toMatch(/UNIQUE\(scope, localId\)/);
    expect(schema).toMatch(/answeredAt INTEGER/);
    expect(schema).toMatch(/connectedAt INTEGER/);
    expect(schema).toMatch(/endedAt INTEGER/);
    expect(schema).toMatch(/payload TEXT/);
    expect(schema).toMatch(/attempts INTEGER NOT NULL DEFAULT 0 CHECK \(attempts >= 0\)/);
    expect(schema).toMatch(/CREATE INDEX IF NOT EXISTS idx_call_metric_reports_due/);
    expect(schema).toMatch(/WHERE payload IS NOT NULL/);
  });

  it('purges reports from real and decoy workspaces', async () => {
    await db.clearLocalState();
    await db.clearDecoyState();

    expect(sqlOf()).toContain('DELETE FROM call_metric_reports');
    expect(sqlOf('tacendum-decoy.sqlite')).toContain('DELETE FROM call_metric_reports');
  });
});

describe('call metric lifecycle writes', () => {
  it('opens a scope-local draft idempotently', async () => {
    await db.openCallMetricReport(draft);
    await db.openCallMetricReport(draft);
    const opens = callsMatching(/INSERT INTO call_metric_reports/);
    expect(opens).toHaveLength(2);
    expect(String(opens[0]![0])).toMatch(/ON CONFLICT\(scope, localId\) DO NOTHING/);
  });

  it('keeps the first answer and connection timestamps', async () => {
    await db.markCallMetricAnswered(draft.localId, draft.startedAt + 100);
    await db.markCallMetricConnected(draft.localId, draft.startedAt + 200);
    const updates = callsMatching(/UPDATE call_metric_reports/).map(call =>
      String(call[0]),
    );
    expect(updates[0]).toMatch(/answeredAt IS NULL/);
    expect(updates[1]).toMatch(/connectedAt IS NULL/);
  });

  it('raises a group connection floor and never lowers a recorded peak', async () => {
    await db.openCallMetricReport(groupDraft);
    await db.markCallMetricConnected(groupDraft.localId, groupDraft.startedAt + 200);
    await db.raiseCallMetricPeak(groupDraft.localId, 6);
    await db.raiseCallMetricPeak(groupDraft.localId, 2);
    const updates = callsMatching(/UPDATE call_metric_reports/).map(call =>
      String(call[0]),
    );
    expect(updates[0]).toMatch(/answeredAt = COALESCE\(answeredAt/);
    expect(updates[0]).toMatch(/groupPeakParticipants.*2/);
    expect(updates.slice(1).join('\n')).toMatch(/MAX\(COALESCE\(groupPeakParticipants, 2\), \?\)/);
  });

  it('does not let a connected report lack an answer timestamp', async () => {
    await db.markCallMetricConnected(draft.localId, draft.startedAt + 200);
    const [connected] = callsMatching(/UPDATE call_metric_reports/);
    expect(String(connected![0])).toMatch(
      /answeredAt = COALESCE\(answeredAt, MAX\(startedAt, \?\)\)/,
    );
  });

  it('serializes every single-statement operation behind terminal finalization', async () => {
    const instance = sqlite.instances.get('tacendum.sqlite')!;
    let releaseSelect!: () => void;
    const selectBlocked = new Promise<void>(resolve => {
      releaseSelect = resolve;
    });
    let selected!: () => void;
    const selectStarted = new Promise<void>(resolve => {
      selected = resolve;
    });
    instance.execute.mockImplementation(async (sql: string) => {
      if (String(sql).includes('FROM call_metric_reports WHERE localId = ?')) {
        selected();
        await selectBlocked;
        return {
          rows: [{
            ...draft,
            answeredAt: null,
            connectedAt: null,
            groupPeakParticipants: null,
            lastSeenAt: draft.startedAt,
          }],
        };
      }
      return { rows: [] };
    });

    const finalizing = db.finalizeCallMetricReport({
      localId: draft.localId,
      endedAt: draft.startedAt + 1,
      reason: 'cancelled',
    });
    await selectStarted;
    const before = instance.execute.mock.calls.length;
    const pending = [
      db.openCallMetricReport(draft),
      db.markCallMetricAnswered(draft.localId, draft.startedAt + 2),
      db.markCallMetricConnected(draft.localId, draft.startedAt + 3),
      db.raiseCallMetricPeak(draft.localId, 2),
      db.touchCallMetricReport(draft.localId, draft.startedAt + 4),
      db.discardCallMetricReport(draft.localId),
      db.listDueCallMetricReports(draft.startedAt),
      db.nextCallMetricAttemptAt(draft.startedAt),
      db.recordCallMetricRetry(draft.reportId, 1, draft.startedAt + 5),
      db.deleteCallMetricReport(draft.reportId),
      db.pruneExpiredCallMetricReports(draft.expiresAt),
    ];
    try {
      await Promise.resolve();
      expect(instance.execute.mock.calls).toHaveLength(before);
    } finally {
      releaseSelect();
    }
    await Promise.all([finalizing, ...pending]);
  });

  it('finalizes an unfinished draft once with a capped canonical payload', async () => {
    const instance = sqlite.instances.get('tacendum.sqlite')!;
    instance.execute.mockImplementation(async (sql: string) => {
      if (String(sql).includes('FROM call_metric_reports') && String(sql).includes('endedAt IS NULL')) {
        return {
          rows: [{
            ...draft,
            answeredAt: draft.startedAt + 100,
            connectedAt: draft.startedAt + 200,
            groupPeakParticipants: null,
            lastSeenAt: draft.startedAt + 200,
          }],
        };
      }
      return { rows: [] };
    });

    await db.finalizeCallMetricReport({
      localId: draft.localId,
      endedAt: draft.startedAt + 90_000_000,
      reason: 'hangup',
    });
    const [update] = callsMatching(/UPDATE call_metric_reports/).slice(-1);
    expect(String(update![0])).toMatch(/WHERE localId = \? AND endedAt IS NULL/);
    const args = update![1] as unknown[];
    const payload = args.find(value => typeof value === 'string' && value.startsWith('{')) as string;
    const report = JSON.parse(payload);
    expect(report.durationSeconds).toBe(86_400);
    expect(report.outcome).toBe('completed');
  });

  it('discards a glare loser without making an outbox payload', async () => {
    await db.discardCallMetricReport(draft.localId);
    const [deletion] = callsMatching(/DELETE FROM call_metric_reports/);
    expect(String(deletion![0])).toMatch(/payload IS NULL/);
  });

  it('reconciles unfinished rows by stage at their last heartbeat', async () => {
    const instance = sqlite.instances.get('tacendum.sqlite')!;
    instance.execute.mockImplementation(async (sql: string) => {
      if (String(sql).includes('FROM call_metric_reports WHERE endedAt IS NULL')) {
        return {
          rows: [
            { ...draft, answeredAt: null, connectedAt: null, groupPeakParticipants: null, lastSeenAt: 11 },
            { ...draft, localId: 'answered', answeredAt: 12, connectedAt: null, groupPeakParticipants: null, lastSeenAt: 13 },
            { ...draft, localId: 'connected', answeredAt: 14, connectedAt: 15, groupPeakParticipants: null, lastSeenAt: 16 },
          ],
        };
      }
      return { rows: [] };
    });
    await db.reconcileCallMetricReports();
    const updates = callsMatching(/UPDATE call_metric_reports/);
    expect(updates.map(call => (call[1] as unknown[])[0])).toEqual([11, 13, 16]);
    expect(updates.map(call => (call[1] as unknown[])[1])).toEqual([
      'unanswered',
      'connection_failed',
      'media_failed',
    ]);
  });
});

describe('call metric durable queue', () => {
  it('serves only due finalized payloads in terminal order, bounded to twenty', async () => {
    await db.listDueCallMetricReports(draft.startedAt);
    const [call] = callsMatching(/FROM call_metric_reports/).slice(-1);
    expect(String(call![0])).toMatch(/payload IS NOT NULL/);
    expect(String(call![0])).toMatch(/nextAttemptAt <= \?/);
    expect(String(call![0])).toMatch(/expiresAt > \?/);
    expect(String(call![0])).toMatch(/ORDER BY endedAt ASC, reportId ASC/);
    expect(String(call![0])).toMatch(/LIMIT \?/);
    expect(call![1]).toEqual([draft.startedAt, draft.startedAt, 20]);
  });

  it('caps invalid and oversized due limits to a positive batch of twenty', async () => {
    await db.listDueCallMetricReports(draft.startedAt, 100);
    await db.listDueCallMetricReports(draft.startedAt, 0);
    await db.listDueCallMetricReports(draft.startedAt, 1.5);
    const calls = callsMatching(/FROM call_metric_reports/).slice(-3);
    expect(calls.map(call => call[1])).toEqual([
      [draft.startedAt, draft.startedAt, 20],
      [draft.startedAt, draft.startedAt, 20],
      [draft.startedAt, draft.startedAt, 20],
    ]);
  });

  it('finds the earliest finalized retry time so a restarted drain can re-arm it', async () => {
    const instance = sqlite.instances.get('tacendum.sqlite')!;
    instance.execute.mockImplementationOnce(async () => ({
      rows: [{ nextAttemptAt: draft.startedAt + 5_000 }],
    }));
    // Removing the durable scheduling boundary must strand this future-only
    // queue rather than letting it depend on an unrelated socket wake.
    await expect(db.nextCallMetricAttemptAt(draft.startedAt)).resolves.toBe(
      draft.startedAt + 5_000,
    );
    const [call] = callsMatching(/FROM call_metric_reports/).slice(-1);
    expect(String(call![0])).toMatch(/payload IS NOT NULL/);
    expect(String(call![0])).toMatch(/nextAttemptAt > \?/);
    expect(String(call![0])).toMatch(/ORDER BY nextAttemptAt ASC/);
    expect(String(call![0])).toMatch(/LIMIT 1/);
    expect(call![1]).toEqual([draft.startedAt]);
  });

  it('records retry schedule, deletes delivered ids, and prunes only queued rows', async () => {
    await db.recordCallMetricRetry(draft.reportId, 3, draft.startedAt + 5_000);
    await db.deleteCallMetricReport(draft.reportId);
    await db.pruneExpiredCallMetricReports(draft.expiresAt);
    const sql = callsMatching(/(UPDATE|DELETE FROM) call_metric_reports/)
      .map(call => String(call[0]))
      .join('\n');
    expect(sql).toMatch(/SET attempts = \?, nextAttemptAt = \?/);
    expect(sql).toMatch(/DELETE FROM call_metric_reports WHERE reportId = \?/);
    expect(sql).toMatch(/expiresAt <= \? AND payload IS NOT NULL/);
  });
});
