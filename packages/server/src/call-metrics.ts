import type { CallMetricReport } from '@tacendum/shared';

export type CallMetricClaim = 'claimed' | 'published' | 'busy' | 'conflict';

export interface CallMetricClaimInput {
  key: string;
  digest: string;
  now: number;
  leaseUntil: number;
  expiresAt: number;
}

export interface CallMetricStore {
  claim(input: CallMetricClaimInput): Promise<CallMetricClaim>;
  markPublished(input: Pick<CallMetricClaimInput, 'key' | 'digest' | 'leaseUntil'>): Promise<void>;
  release(input: Pick<CallMetricClaimInput, 'key' | 'digest' | 'leaseUntil'>): Promise<void>;
}

export interface CallMetricDatum {
  MetricName: string;
  Dimensions: Array<{ Name: 'Scope' | 'Media' | 'Outcome'; Value: string }>;
  Timestamp: Date;
  Value: number;
  Unit: 'Count' | 'Milliseconds' | 'Seconds';
  StorageResolution: 60;
}

export interface CallMetricPublisher {
  publish(data: readonly CallMetricDatum[]): Promise<void>;
}

interface MemoryRow {
  digest: string;
  leaseUntil: number;
  expiresAt: number;
  published: boolean;
}

/**
 * Process-local store for local development and tests. Production hosts inject
 * a durable conditional store. Its keys are already SHA-256 digests; no raw
 * account or report identifier is retained here.
 */
export function makeMemoryCallMetricStore(): CallMetricStore {
  const rows = new Map<string, MemoryRow>();

  return {
    async claim(input) {
      const existing = rows.get(input.key);
      if (existing && existing.expiresAt <= input.now) rows.delete(input.key);
      const row = rows.get(input.key);
      if (!row) {
        rows.set(input.key, {
          digest: input.digest,
          leaseUntil: input.leaseUntil,
          expiresAt: input.expiresAt,
          published: false,
        });
        return 'claimed';
      }
      if (row.digest !== input.digest) return 'conflict';
      if (row.published) return 'published';
      if (row.leaseUntil > input.now) return 'busy';
      row.leaseUntil = input.leaseUntil;
      row.expiresAt = input.expiresAt;
      return 'claimed';
    },
    async markPublished(input) {
      const row = rows.get(input.key);
      if (!row || row.digest !== input.digest || row.leaseUntil !== input.leaseUntil) {
        throw new Error('call metric claim is no longer owned');
      }
      row.published = true;
    },
    async release(input) {
      const row = rows.get(input.key);
      if (row && !row.published && row.digest === input.digest && row.leaseUntil === input.leaseUntil) {
        row.leaseUntil = 0;
      }
    },
  };
}

/**
 * A retry digest excludes the client-provided report id: that id selects the
 * dedupe row, while this canonical content detects a conflicting reuse of it.
 */
export function canonicalCallMetricReport(report: CallMetricReport): string {
  return JSON.stringify({
    occurredAt: report.occurredAt,
    scope: report.scope,
    media: report.media,
    answered: report.answered,
    connected: report.connected,
    outcome: report.outcome,
    ...(report.setupMs === undefined ? {} : { setupMs: report.setupMs }),
    ...(report.durationSeconds === undefined ? {} : { durationSeconds: report.durationSeconds }),
    ...(report.groupPeakParticipants === undefined
      ? {}
      : { groupPeakParticipants: report.groupPeakParticipants }),
  });
}

export function callMetricData(report: CallMetricReport, timestamp: Date): CallMetricDatum[] {
  const scopeMedia = [
    { Name: 'Scope' as const, Value: report.scope },
    { Name: 'Media' as const, Value: report.media },
  ];
  const data: CallMetricDatum[] = [
    metric('CallAttempts', 1, 'Count', scopeMedia, timestamp),
  ];
  if (report.answered) data.push(metric('CallAnswered', 1, 'Count', scopeMedia, timestamp));
  if (report.connected) {
    data.push(metric('CallConnected', 1, 'Count', scopeMedia, timestamp));
    if (report.outcome === 'completed') {
      data.push(metric('CallCompleted', 1, 'Count', scopeMedia, timestamp));
    }
  }
  data.push(
    metric(
      'CallOutcome',
      1,
      'Count',
      [
        { Name: 'Scope', Value: report.scope },
        { Name: 'Outcome', Value: report.outcome },
      ],
      timestamp,
    ),
  );
  if (report.connected) {
    data.push(metric('CallSetupLatency', report.setupMs!, 'Milliseconds', scopeMedia, timestamp));
    data.push(metric('CallDuration', report.durationSeconds!, 'Seconds', scopeMedia, timestamp));
  }
  if (report.groupPeakParticipants !== undefined) {
    data.push(
      metric(
        'GroupPeakParticipants',
        report.groupPeakParticipants,
        'Count',
        [{ Name: 'Media', Value: report.media }],
        timestamp,
      ),
    );
  }
  return data;
}

function metric(
  MetricName: string,
  Value: number,
  Unit: CallMetricDatum['Unit'],
  Dimensions: CallMetricDatum['Dimensions'],
  Timestamp: Date,
): CallMetricDatum {
  return { MetricName, Value, Unit, Dimensions, Timestamp, StorageResolution: 60 };
}
