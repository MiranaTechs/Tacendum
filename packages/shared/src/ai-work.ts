/**
 * Bounded AI work facts shared by the CLI and app. These values are supplied
 * by the authenticated sender inside the existing encrypted envelope; they
 * describe what that sender observed, not relay truth or host health.
 *
 * `work` is always optional on its enclosing envelope. Receive sites use the
 * permissive `aiWorkMetadata` fragment so malformed or future metadata costs
 * only itself and the conversational text still renders. Producers use the
 * strict `AiWorkMetadataSchema` and must never silently discard bad fields.
 *
 * Pure by design: zod only, with no Node or React Native dependency.
 */

import { z } from 'zod';
import { Ulid } from './group-fold.js';

export const AI_WORK_PROVIDERS = ['claude', 'codex', 'gemini', 'cursor'] as const;
export const AI_WORK_EVENT_KINDS = [
  'turn-complete',
  'turn-failed',
  'waiting-for-input',
  'needs-review',
] as const;
export const AI_WORK_APPROVAL_OBSERVATIONS = [
  'answer-received',
  'decision-returned',
  'provider-received',
  'expired',
] as const;
export const AI_WORK_USAGE_UNITS = ['turns', 'tokens', 'usd'] as const;
export const AI_WORK_USAGE_PERIODS = ['turn', 'hour', 'session', 'day', 'week', 'month'] as const;
export const AI_WORK_USAGE_SOURCES = ['local-budget', 'provider-reported'] as const;

export const AI_WORK_PROJECT_MAX = 40;
export const AI_WORK_REPOSITORY_MAX = 80;
export const AI_WORK_BRANCH_MAX = 200;
export const AI_WORK_RESULT_SUMMARY_MAX = 1_000;
export const AI_WORK_USAGE_MAX = 8;
export const AI_WORK_FUTURE_SKEW_MS = 5 * 60 * 1_000;

const wireTimestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const boundedMetric = z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const AiWorkCapabilitiesSchema = z
  .object({
    /** A maintained notification handler or runnable answerer send path is
     * configured for this account. This is configured support, not proof of
     * current reachability or phone display. */
    notifications: z.boolean(),
    /** A validated provider approval bridge is configured for this account. */
    approvals: z.boolean(),
    /** Attend has a recognised runnable answerer configuration. */
    tasks: z.boolean(),
  })
  .strict();
export type AiWorkCapabilities = z.infer<typeof AiWorkCapabilitiesSchema>;

export const AiWorkUsageSchema = z
  .object({
    source: z.enum(AI_WORK_USAGE_SOURCES),
    unit: z.enum(AI_WORK_USAGE_UNITS),
    period: z.enum(AI_WORK_USAGE_PERIODS),
    observedAt: wireTimestamp,
    used: boundedMetric.optional(),
    remaining: boundedMetric.optional(),
    limit: boundedMetric.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.used === undefined && value.remaining === undefined && value.limit === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'usage requires used, remaining, or limit',
      });
    }
  });
export type AiWorkUsage = z.infer<typeof AiWorkUsageSchema>;

const contextEvidence = {
  repository: z.string().min(1).max(AI_WORK_REPOSITORY_MAX).optional(),
  branch: z.string().min(1).max(AI_WORK_BRANCH_MAX).optional(),
  resultSummary: z.string().min(1).max(AI_WORK_RESULT_SUMMARY_MAX).optional(),
};

const observedContext = z
  .object({
    availability: z.enum(['captured', 'stale']),
    capturedAt: wireTimestamp,
    ...contextEvidence,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.repository === undefined &&
      value.branch === undefined &&
      value.resultSummary === undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'captured context requires repository, branch, or resultSummary',
      });
    }
  });

export const AiWorkContextSchema = z.discriminatedUnion('availability', [
  z.object({ availability: z.literal('unavailable') }).strict(),
  observedContext,
]);
export type AiWorkContext = z.infer<typeof AiWorkContextSchema>;

export const AiWorkMetadataSchema = z
  .object({
    provider: z.enum(AI_WORK_PROVIDERS),
    updatedAt: wireTimestamp,
    event: z.enum(AI_WORK_EVENT_KINDS).optional(),
    /** Canonical event identity. Never substitute the four-hex display tag. */
    eventId: Ulid.optional(),
    project: z.string().min(1).max(AI_WORK_PROJECT_MAX).optional(),
    /** Correlates approval facts only; it is not an event identity. */
    requestId: Ulid.optional(),
    /** Human display/grouping hint only. Collisions are expected. */
    runTag: z
      .string()
      .regex(/^s-[0-9a-f]{4}$/)
      .optional(),
    approvalObservation: z.enum(AI_WORK_APPROVAL_OBSERVATIONS).optional(),
    capabilities: AiWorkCapabilitiesSchema.optional(),
    context: AiWorkContextSchema.optional(),
    usage: z.array(AiWorkUsageSchema).min(1).max(AI_WORK_USAGE_MAX).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.event !== undefined && value.eventId === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['eventId'],
        message: 'an event requires a canonical eventId',
      });
    }
    if (value.event === 'needs-review' && value.requestId === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['requestId'],
        message: 'needs-review requires requestId',
      });
    }
    if (value.approvalObservation !== undefined && value.requestId === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['requestId'],
        message: 'an approval observation requires requestId',
      });
    }
  });
export type AiWorkMetadata = z.infer<typeof AiWorkMetadataSchema>;

/** Receiver fragment for optional fields on existing envelopes. */
export const aiWorkMetadata = AiWorkMetadataSchema.optional().catch(undefined);

/**
 * Source clocks are display hints. A value beyond the bounded future-skew
 * allowance is replaced by the authenticated local receipt time and labelled
 * untrusted; it must never drive ordering or deduplication.
 */
export function displayAiWorkTimestamp(
  sourceAt: number,
  receivedAt: number,
): { at: number; trusted: boolean } {
  if (!wireTimestamp.safeParse(receivedAt).success) {
    throw new Error('displayAiWorkTimestamp: receivedAt must be a safe nonnegative integer');
  }
  if (
    !wireTimestamp.safeParse(sourceAt).success ||
    sourceAt > receivedAt + AI_WORK_FUTURE_SKEW_MS
  ) {
    return { at: receivedAt, trusted: false };
  }
  return { at: sourceAt, trusted: true };
}
