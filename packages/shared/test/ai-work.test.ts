import { describe, expect, it } from 'vitest';
import {
  AI_WORK_BRANCH_MAX,
  AI_WORK_FUTURE_SKEW_MS,
  AI_WORK_PROJECT_MAX,
  AI_WORK_REPOSITORY_MAX,
  AI_WORK_RESULT_SUMMARY_MAX,
  AI_WORK_USAGE_MAX,
  AiWorkMetadataSchema,
  aiWorkMetadata,
  displayAiWorkTimestamp,
} from '../src/ai-work.js';
import { AgentTextEnvelope, composeAgentText } from '../src/ai-origin.js';
import { ApprovalRequestEnvelope } from '../src/approval-envelope.js';

const EVENT_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const REQUEST_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAW';

describe('AI work metadata', () => {
  it('accepts a bounded, source-backed event without normalising its values', () => {
    const metadata = {
      provider: 'claude' as const,
      updatedAt: 1_725_000_000_000,
      event: 'needs-review' as const,
      eventId: EVENT_ID,
      project: 'Tacendum',
      requestId: REQUEST_ID,
      runTag: 's-1a2b',
      approvalObservation: 'answer-received' as const,
      capabilities: { notifications: true, approvals: true, tasks: true },
      context: {
        availability: 'captured' as const,
        capturedAt: 1_724_999_999_000,
        repository: 'natln/Tacendum',
        branch: 'feature/chat-review',
        resultSummary: 'The provider stopped at an approval boundary.',
      },
      usage: [
        {
          source: 'local-budget' as const,
          unit: 'turns' as const,
          period: 'hour' as const,
          observedAt: 1_725_000_000_000,
          used: 3,
          remaining: 7,
          limit: 10,
        },
        {
          source: 'provider-reported' as const,
          unit: 'tokens' as const,
          period: 'turn' as const,
          observedAt: 1_725_000_000_000,
          used: 12.5,
        },
      ],
    };

    expect(AiWorkMetadataSchema.parse(metadata)).toEqual(metadata);
  });

  it('accepts an honest capability or usage snapshot without inventing an event', () => {
    const snapshot = {
      provider: 'codex' as const,
      updatedAt: 1_725_000_000_000,
      capabilities: { notifications: true, approvals: false, tasks: false },
      context: { availability: 'unavailable' as const },
      usage: [
        {
          source: 'local-budget' as const,
          unit: 'turns' as const,
          period: 'hour' as const,
          observedAt: 1_725_000_000_000,
          remaining: 10,
        },
      ],
    };

    expect(AiWorkMetadataSchema.parse(snapshot)).toEqual(snapshot);
  });

  it('requires canonical event identity and approval correlation where the fact needs it', () => {
    const base = { provider: 'codex', updatedAt: 1 };

    expect(AiWorkMetadataSchema.safeParse({ ...base, event: 'turn-complete' }).success).toBe(false);
    expect(
      AiWorkMetadataSchema.safeParse({ ...base, event: 'turn-complete', eventId: 's-1234' })
        .success,
    ).toBe(false);
    expect(
      AiWorkMetadataSchema.safeParse({ ...base, event: 'needs-review', eventId: EVENT_ID }).success,
    ).toBe(false);
    expect(
      AiWorkMetadataSchema.safeParse({ ...base, approvalObservation: 'decision-returned' }).success,
    ).toBe(false);
  });

  it('keeps runTag display-only and accepts repeated tags on distinct canonical events', () => {
    const first = AiWorkMetadataSchema.parse({
      provider: 'codex',
      updatedAt: 10,
      event: 'turn-complete',
      eventId: EVENT_ID,
      runTag: 's-cafe',
    });
    const second = AiWorkMetadataSchema.parse({
      provider: 'codex',
      updatedAt: 11,
      event: 'turn-complete',
      eventId: REQUEST_ID,
      runTag: 's-cafe',
    });

    expect(first.eventId).not.toBe(second.eventId);
    expect(first.runTag).toBe(second.runTag);
  });

  it('drops only malformed optional metadata at the receive fragment', () => {
    expect(aiWorkMetadata.parse(undefined)).toBeUndefined();
    expect(aiWorkMetadata.parse({ provider: 'future-provider', updatedAt: 1 })).toBeUndefined();
    expect(
      aiWorkMetadata.parse({ provider: 'codex', updatedAt: 1, futureField: true }),
    ).toBeUndefined();
    expect(
      aiWorkMetadata.parse({ provider: 'codex', updatedAt: 1, event: 'future-event' }),
    ).toBeUndefined();
  });

  it('keeps old-client message meaning when optional msg/approval work is malformed', () => {
    const msg = AgentTextEnvelope.parse({
      tcm: 'msg',
      text: 'The answer remains visible.',
      ai: true,
      work: { provider: 'future-provider', updatedAt: 1 },
    });
    const approval = ApprovalRequestEnvelope.parse({
      tcm: 'x.approval',
      q: REQUEST_ID,
      k: 'exec',
      p: 'touch result.txt\ncwd: /tmp',
      x: 540,
      a: ['approve', 'deny'],
      ai: true,
      work: { provider: 'codex', updatedAt: 1, futureField: true },
    });

    expect(msg).toMatchObject({ text: 'The answer remains visible.', work: undefined });
    expect(approval).toMatchObject({ p: 'touch result.txt\ncwd: /tmp', work: undefined });
  });

  it('composes valid msg work strictly and refuses to silently drop producer mistakes', () => {
    const work = {
      provider: 'claude' as const,
      updatedAt: 1,
      event: 'turn-complete' as const,
      eventId: EVENT_ID,
    };
    expect(JSON.parse(composeAgentText('Done.', undefined, work))).toEqual({
      tcm: 'msg',
      text: 'Done.',
      ai: true,
      work,
    });
    expect(() =>
      composeAgentText('Done.', undefined, {
        provider: 'claude',
        updatedAt: 1,
        event: 'turn-complete',
      } as never),
    ).toThrow(/work metadata/);
  });

  it('refuses oversized strings, noncanonical run tags, and unsafe timestamps', () => {
    const base = { provider: 'codex', updatedAt: 1 };
    for (const value of [
      { ...base, project: 'p'.repeat(AI_WORK_PROJECT_MAX + 1) },
      {
        ...base,
        context: {
          availability: 'captured',
          capturedAt: 1,
          repository: 'r'.repeat(AI_WORK_REPOSITORY_MAX + 1),
        },
      },
      {
        ...base,
        context: {
          availability: 'captured',
          capturedAt: 1,
          branch: 'b'.repeat(AI_WORK_BRANCH_MAX + 1),
        },
      },
      {
        ...base,
        context: {
          availability: 'captured',
          capturedAt: 1,
          resultSummary: 's'.repeat(AI_WORK_RESULT_SUMMARY_MAX + 1),
        },
      },
      { ...base, runTag: 's-CAFE' },
      { ...base, updatedAt: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      expect(AiWorkMetadataSchema.safeParse(value).success).toBe(false);
    }
  });

  it('requires captured/stale evidence and bounded, meaningful usage observations', () => {
    const base = { provider: 'codex', updatedAt: 1 };
    expect(
      AiWorkMetadataSchema.safeParse({
        ...base,
        context: { availability: 'captured', capturedAt: 1 },
      }).success,
    ).toBe(false);
    expect(
      AiWorkMetadataSchema.safeParse({
        ...base,
        context: { availability: 'stale', capturedAt: 1, branch: 'main' },
      }).success,
    ).toBe(true);
    expect(
      AiWorkMetadataSchema.safeParse({
        ...base,
        usage: [{ source: 'local-budget', unit: 'turns', period: 'hour', observedAt: 1 }],
      }).success,
    ).toBe(false);
    expect(
      AiWorkMetadataSchema.safeParse({
        ...base,
        usage: Array.from({ length: AI_WORK_USAGE_MAX + 1 }, () => ({
          source: 'local-budget',
          unit: 'turns',
          period: 'hour',
          observedAt: 1,
          remaining: 1,
        })),
      }).success,
    ).toBe(false);
    for (const used of [-1, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      expect(
        AiWorkMetadataSchema.safeParse({
          ...base,
          usage: [
            {
              source: 'provider-reported',
              unit: 'usd',
              period: 'month',
              observedAt: 1,
              used,
            },
          ],
        }).success,
      ).toBe(false);
    }
  });

  it('clamps future or invalid source clocks to receipt time and marks them untrusted', () => {
    const receivedAt = 1_725_000_000_000;
    expect(displayAiWorkTimestamp(receivedAt - 86_400_000, receivedAt)).toEqual({
      at: receivedAt - 86_400_000,
      trusted: true,
    });
    expect(displayAiWorkTimestamp(receivedAt + AI_WORK_FUTURE_SKEW_MS, receivedAt)).toEqual({
      at: receivedAt + AI_WORK_FUTURE_SKEW_MS,
      trusted: true,
    });
    expect(displayAiWorkTimestamp(receivedAt + AI_WORK_FUTURE_SKEW_MS + 1, receivedAt)).toEqual({
      at: receivedAt,
      trusted: false,
    });
    expect(displayAiWorkTimestamp(Number.NaN, receivedAt)).toEqual({
      at: receivedAt,
      trusted: false,
    });
    expect(() => displayAiWorkTimestamp(receivedAt, Number.NaN)).toThrow(/receivedAt/);
  });
});
