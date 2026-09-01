import { createHash } from 'node:crypto';
import { CallMetricReport } from '@tacendum/shared';
import { callMetricData, canonicalCallMetricReport } from '../call-metrics.js';
import { LIMITS } from '../ratelimit.js';
import { errorResult, parseJson, rateLimitedResult, type AuthedHandler } from './http.js';

const LEASE_SECONDS = 30;
const TTL_SECONDS = 8 * 24 * 60 * 60;
const MAX_PAST_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_FUTURE_MS = 5 * 60 * 1000;

export const callMetricsHandler: AuthedHandler = async (event, deps, auth) => {
  const retry = await deps.rateLimit.take(`call-metrics:${auth.userId}`, LIMITS.callMetrics);
  if (retry > 0) return rateLimitedResult(retry);
  if (!deps.callMetrics) return { statusCode: 503 };

  const parsed = parseJson(event, CallMetricReport);
  if (!parsed.ok) return parsed.result;
  const report = parsed.data;
  const nowMs = deps.now();
  const now = Math.floor(nowMs / 1000);
  const leaseUntil = now + LEASE_SECONDS;
  const key = sha256(`${auth.userId}\0${report.reportId}`);
  const digest = sha256(canonicalCallMetricReport(report));
  const claim = await deps.callMetrics.store.claim({
    key,
    digest,
    now,
    leaseUntil,
    expiresAt: now + TTL_SECONDS,
  });
  if (claim === 'conflict') return errorResult(409, 'invalid_request', 'report ID conflicts with prior content');
  if (claim === 'published') return { statusCode: 204 };
  if (claim === 'busy') return { statusCode: 503 };

  const timestamp =
    report.occurredAt < nowMs - MAX_PAST_MS || report.occurredAt > nowMs + MAX_FUTURE_MS
      ? new Date(nowMs)
      : new Date(report.occurredAt);
  const claimInput = { key, digest, leaseUntil };
  try {
    await deps.callMetrics.publisher.publish(callMetricData(report, timestamp));
    await deps.callMetrics.store.markPublished(claimInput);
    return { statusCode: 204 };
  } catch {
    try {
      await deps.callMetrics.store.release(claimInput);
    } catch {
      // A lease expiry makes a failed claim recoverable even when the release fails.
    }
    return { statusCode: 503 };
  }
};

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
