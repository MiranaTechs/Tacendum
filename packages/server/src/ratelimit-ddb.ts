import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { RateLimiter, RateLimitOpts } from './ratelimit.js';
import { TABLES, TABLE_ENV_VARS } from '@tacendum/shared';

/**
 * DynamoDB-backed rate limiter.
 *
 * The in-memory token bucket means "limit × warm containers" under Lambda —
 * a ceiling that quietly rises with load, which is exactly when it matters.
 * This one is a FIXED-WINDOW counter over a shared table, chosen over a
 * durable token bucket deliberately: `ADD` is a single atomic write with no
 * read-modify-write race, so two containers admitting concurrently cannot
 * lose updates and the hot path costs one WCU with no retry loop. The price
 * is the well-known window-edge artifact — a burst that straddles a boundary
 * can pass up to 2× capacity across it. Accepted: every LIMITS entry keeps
 * its meaning as a sustained rate, and the edge case is bounded and brief.
 *
 * Window length = capacity / refillPerSec (the bucket's own drain time), so
 * each LIMITS entry translates without renumbering: `wsSend` (30, 5/sec)
 * becomes 30 per 6-second window; `auth` (30, 30/min) becomes 30 per minute.
 */

interface WindowRow {
  n?: number;
}

function tableName(): string {
  return process.env[TABLE_ENV_VARS.rateBuckets] ?? TABLES.rateBuckets;
}

export function makeDdbRateLimiter(
  doc: DynamoDBDocumentClient,
  now: () => number = () => Date.now(),
): RateLimiter {
  return {
    async take(bucket: string, opts: RateLimitOpts): Promise<number> {
      const windowMs = Math.max(1000, Math.round((opts.capacity / opts.refillPerSec) * 1000));
      const t = now();
      const windowStart = t - (t % windowMs);
      const windowEnd = windowStart + windowMs;
      const key = `${bucket}#${windowStart}`;

      const res = await doc.send(
        new UpdateCommand({
          TableName: tableName(),
          Key: { bucket: key },
          // One atomic write, no prior read. The TTL is set once per row and
          // gives DynamoDB an hour's grace past the window to reap it.
          UpdateExpression: 'ADD n :one SET expiresAt = if_not_exists(expiresAt, :exp)',
          ExpressionAttributeValues: {
            ':one': 1,
            ':exp': Math.floor(windowEnd / 1000) + 3600,
          },
          ReturnValues: 'UPDATED_NEW',
        }),
      );

      const count = (res.Attributes as WindowRow | undefined)?.n ?? 1;
      if (count <= opts.capacity) return 0;
      // Over budget: the honest retry-after is the start of the next window.
      return Math.max(1, Math.ceil((windowEnd - t) / 1000));
    },
  };
}
