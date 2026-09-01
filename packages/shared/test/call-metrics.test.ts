import { describe, expect, it } from 'vitest';
import { CallMetricReport } from '../src/dto.js';

const direct = {
  reportId: '01K2ABCDEF0123456789ABCDEF',
  occurredAt: 1_786_662_000_000,
  scope: 'direct',
  media: 'video',
  answered: true,
  connected: true,
  outcome: 'completed',
  setupMs: 4_312,
  durationSeconds: 624,
} as const;

describe('CallMetricReport', () => {
  it('accepts the minimal completed direct report and strips nothing', () => {
    expect(CallMetricReport.parse(direct)).toEqual(direct);
  });

  it.each([
    [{ ...direct, connected: true, answered: false }, 'connected requires answered'],
    [
      {
        ...direct,
        connected: false,
        outcome: 'completed',
        setupMs: undefined,
        durationSeconds: undefined,
      },
      'completed requires connected',
    ],
    [{ ...direct, connected: false }, 'setup and duration are forbidden before connection'],
    [{ ...direct, setupMs: undefined }, 'connected requires setup'],
    [{ ...direct, durationSeconds: undefined }, 'connected requires duration'],
    [{ ...direct, groupPeakParticipants: 2 }, 'group peak is forbidden for direct calls'],
    [{ ...direct, scope: 'group', groupPeakParticipants: undefined }, 'connected group requires a peak'],
    [
      {
        ...direct,
        scope: 'group',
        connected: false,
        outcome: 'unanswered',
        setupMs: undefined,
        durationSeconds: undefined,
        groupPeakParticipants: 2,
      },
      'unconnected group calls cannot have a peak',
    ],
    [
      { ...direct, scope: 'group', media: 'video', groupPeakParticipants: 6 },
      'video group peak is bounded by the shipped cap',
    ],
    [{ ...direct, setupMs: 120_001 }, 'setup is bounded'],
    [{ ...direct, durationSeconds: 86_401 }, 'duration is bounded'],
  ])('%s is rejected: %s', value => {
    expect(CallMetricReport.safeParse(value).success).toBe(false);
  });

  it.each([
    ['audio', 2, 6],
    ['video', 2, 5],
  ] as const)('accepts connected %s group peaks from %s through %s', (media, min, max) => {
    for (const peak of [min, max]) {
      expect(
        CallMetricReport.safeParse({ ...direct, scope: 'group', media, groupPeakParticipants: peak })
          .success,
      ).toBe(true);
    }
  });

  it.each([
    'completed',
    'declined',
    'busy',
    'unanswered',
    'connection_failed',
    'media_failed',
    'blocked',
    'unsupported',
  ] as const)('accepts the allowed %s outcome', outcome => {
    expect(CallMetricReport.safeParse({ ...direct, outcome }).success).toBe(true);
  });

  it.each(['audio', 'video'] as const)(
    'accepts an unconnected %s group report with no peak',
    media => {
      expect(
        CallMetricReport.safeParse({
          ...direct,
          scope: 'group',
          media,
          connected: false,
          outcome: 'unanswered',
          setupMs: undefined,
          durationSeconds: undefined,
        }).success,
      ).toBe(true);
    },
  );

  it('rejects unknown keys and free-form outcomes', () => {
    expect(CallMetricReport.safeParse({ ...direct, peerId: 'secret' }).success).toBe(false);
    expect(CallMetricReport.safeParse({ ...direct, outcome: 'other' }).success).toBe(false);
  });
});
