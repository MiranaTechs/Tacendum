import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import type { CallMetricDatum, CallMetricStore } from '../src/call-metrics.js';
import { callMetricData, canonicalCallMetricReport, makeMemoryCallMetricStore } from '../src/call-metrics.js';
import { callMetricsHandler } from '../src/handlers/call-metrics.js';
import { makeMemoryDb, makeTestDeps, jsonPost } from './helpers.js';

const groupReport = {
  reportId: '01K2ABCDEF0123456789ABCDEF',
  occurredAt: 1_700_000_000_000,
  scope: 'group',
  media: 'video',
  answered: true,
  connected: true,
  outcome: 'completed',
  setupMs: 4312,
  durationSeconds: 624,
  groupPeakParticipants: 4,
} as const;

const datum = (
  MetricName: string,
  Value: number,
  Unit: 'Count' | 'Milliseconds' | 'Seconds',
  dimensions: Array<[name: 'Scope' | 'Media' | 'Outcome', value: string]>,
) => ({
  MetricName,
  Value,
  Unit,
  Dimensions: dimensions.map(([Name, dimensionValue]) => ({ Name, Value: dimensionValue })),
  Timestamp: new Date(groupReport.occurredAt),
  StorageResolution: 60,
});

function fixture() {
  const deps = makeTestDeps(makeMemoryDb());
  const published: CallMetricDatum[][] = [];
  deps.callMetrics = {
    store: makeMemoryCallMetricStore(),
    publisher: { publish: async data => void published.push([...data]) },
  };
  return { deps, published };
}

describe('callMetricsHandler', () => {
  it('publishes the exact completed group metric batch once', async () => {
    const { deps, published } = fixture();

    const result = await callMetricsHandler(jsonPost(groupReport), deps, { userId: 'U1' });

    expect(result).toEqual({ statusCode: 204 });
    expect(published).toEqual([
      [
        datum('CallAttempts', 1, 'Count', [['Scope', 'group'], ['Media', 'video']]),
        datum('CallAnswered', 1, 'Count', [['Scope', 'group'], ['Media', 'video']]),
        datum('CallConnected', 1, 'Count', [['Scope', 'group'], ['Media', 'video']]),
        datum('CallCompleted', 1, 'Count', [['Scope', 'group'], ['Media', 'video']]),
        datum('CallOutcome', 1, 'Count', [['Scope', 'group'], ['Outcome', 'completed']]),
        datum('CallSetupLatency', 4312, 'Milliseconds', [['Scope', 'group'], ['Media', 'video']]),
        datum('CallDuration', 624, 'Seconds', [['Scope', 'group'], ['Media', 'video']]),
        datum('GroupPeakParticipants', 4, 'Count', [['Media', 'video']]),
      ],
    ]);
  });

  it('emits only attempt and outcome for an attempted-only report', async () => {
    const { deps, published } = fixture();
    const report = {
      ...groupReport,
      reportId: '01K2ABCDEF0123456789ABCDEG',
      scope: 'direct',
      answered: false,
      connected: false,
      outcome: 'unanswered',
      setupMs: undefined,
      durationSeconds: undefined,
      groupPeakParticipants: undefined,
    };

    await callMetricsHandler(jsonPost(report), deps, { userId: 'U1' });

    expect(published[0]?.map(metric => metric.MetricName)).toEqual(['CallAttempts', 'CallOutcome']);
  });

  it('uses occurredAt only inside the accepted event-time window', async () => {
    const { deps, published } = fixture();
    const current = 1_700_000_000_000;
    const reports = [
      { ...groupReport, occurredAt: current - 7 * 24 * 60 * 60 * 1000 },
      { ...groupReport, reportId: '01K2ABCDEF0123456789ABCDEG', occurredAt: current - 7 * 24 * 60 * 60 * 1000 - 1 },
      { ...groupReport, reportId: '01K2ABCDEF0123456789ABCDEH', occurredAt: current + 5 * 60 * 1000 + 1 },
    ];

    for (const report of reports) await callMetricsHandler(jsonPost(report), deps, { userId: 'U1' });

    expect(published.map(batch => batch[0]?.Timestamp.getTime())).toEqual([
      reports[0]?.occurredAt,
      current,
      current,
    ]);
  });

  it('does not claim or publish an invalid body', async () => {
    const { deps, published } = fixture();

    const result = await callMetricsHandler(jsonPost({ ...groupReport, peerId: 'U1' }), deps, {
      userId: 'U1',
    });

    expect(result.statusCode).toBe(400);
    expect(published).toEqual([]);
  });

  it('takes the per-account call-metrics limit before publication', async () => {
    const { deps, published } = fixture();
    const buckets: string[] = [];
    deps.rateLimit = { take: async bucket => (buckets.push(bucket), 0) };

    await callMetricsHandler(jsonPost(groupReport), deps, { userId: 'U1' });

    expect(buckets).toEqual(['call-metrics:U1']);
    expect(published).toHaveLength(1);
  });

  it('does not publish the same canonical report twice after a completed claim', async () => {
    const { deps, published } = fixture();

    expect(await callMetricsHandler(jsonPost(groupReport), deps, { userId: 'U1' })).toEqual({ statusCode: 204 });
    expect(await callMetricsHandler(jsonPost(groupReport), deps, { userId: 'U1' })).toEqual({ statusCode: 204 });
    expect(published).toHaveLength(1);
  });

  it('refuses a reused report ID whose content differs', async () => {
    const { deps } = fixture();
    await callMetricsHandler(jsonPost(groupReport), deps, { userId: 'U1' });

    const result = await callMetricsHandler(jsonPost({ ...groupReport, durationSeconds: 625 }), deps, {
      userId: 'U1',
    });

    expect(result).toMatchObject({ statusCode: 409 });
    expect(result.body).toContain('invalid_request');
  });

  it('returns unavailable while a lease is live and reclaims an expired pending report', async () => {
    const { deps, published } = fixture();
    const store = deps.callMetrics!.store;
    const key = createHash('sha256').update(`U1\0${groupReport.reportId}`).digest('hex');
    const digest = createHash('sha256').update(canonicalCallMetricReport(groupReport)).digest('hex');
    const input = { key, digest, now: 1_700_000_000, leaseUntil: 1_700_000_030, expiresAt: 1_700_691_200 };
    expect(await store.claim(input)).toBe('claimed');
    const result = await callMetricsHandler(jsonPost(groupReport), deps, { userId: 'U1' });
    expect(result).toEqual({ statusCode: 503 });
    expect(published).toEqual([]);

    deps.advanceMs(30_000);
    expect(await callMetricsHandler(jsonPost(groupReport), deps, { userId: 'U1' })).toEqual({ statusCode: 204 });
    expect(published).toHaveLength(1);
  });

  it('releases a failed publication so the report can be retried', async () => {
    const { deps, published } = fixture();
    let fail = true;
    deps.callMetrics!.publisher = {
      publish: async data => {
        if (fail) throw new Error('publisher down');
        published.push([...data]);
      },
    };

    expect((await callMetricsHandler(jsonPost(groupReport), deps, { userId: 'U1' })).statusCode).toBe(503);
    fail = false;
    expect(await callMetricsHandler(jsonPost(groupReport), deps, { userId: 'U1' })).toEqual({ statusCode: 204 });
    expect(published).toHaveLength(1);
  });

  it('returns unavailable when mark-published fails and its row is reclaimable', async () => {
    const { deps, published } = fixture();
    const real = makeMemoryCallMetricStore();
    let failMark = true;
    const store: CallMetricStore = {
      claim: input => real.claim(input),
      markPublished: async input => {
        if (failMark) {
          failMark = false;
          throw new Error('store down');
        }
        await real.markPublished(input);
      },
      release: async () => { throw new Error('release down'); },
    };
    deps.callMetrics = { store, publisher: { publish: async data => void published.push([...data]) } };

    expect((await callMetricsHandler(jsonPost(groupReport), deps, { userId: 'U1' })).statusCode).toBe(503);
    expect((await callMetricsHandler(jsonPost(groupReport), deps, { userId: 'U1' })).statusCode).toBe(503);
    deps.advanceMs(30_000);
    expect(await callMetricsHandler(jsonPost(groupReport), deps, { userId: 'U1' })).toEqual({ statusCode: 204 });
    expect(published).toHaveLength(2);
  });

  it('keeps account and report identifiers out of canonical payloads and dimensions', () => {
    const canonical = canonicalCallMetricReport(groupReport);
    const dimensions = callMetricData(groupReport, new Date(groupReport.occurredAt)).flatMap(
      metric => metric.Dimensions.map(dimension => dimension.Value),
    );

    expect(canonical).not.toContain(groupReport.reportId);
    expect(canonical).not.toContain('U1');
    expect(dimensions).not.toContain(groupReport.reportId);
    expect(dimensions).not.toContain('U1');
  });

  it('returns a payload-free unavailable result when the host lacks call-metrics capability', async () => {
    const { deps } = fixture();
    delete deps.callMetrics;

    expect(await callMetricsHandler(jsonPost(groupReport), deps, { userId: 'U1' })).toEqual({ statusCode: 503 });
  });

  it('canonicalizes equivalent optional properties independently of object key order', () => {
    const reordered = {
      durationSeconds: groupReport.durationSeconds,
      groupPeakParticipants: groupReport.groupPeakParticipants,
      outcome: groupReport.outcome,
      reportId: groupReport.reportId,
      setupMs: groupReport.setupMs,
      media: groupReport.media,
      scope: groupReport.scope,
      connected: groupReport.connected,
      answered: groupReport.answered,
      occurredAt: groupReport.occurredAt,
    };

    expect(canonicalCallMetricReport(reordered)).toBe(canonicalCallMetricReport(groupReport));
  });
});
