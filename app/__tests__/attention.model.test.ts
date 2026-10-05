import type { AiWorkEventRow, PendingApprovalSummaryRow } from '../src/db';
import {
  ATTENTION_EVENT_COPY,
  attentionDeadlineLabel,
  buildAttentionSections,
  buildWorkAttentionSections,
} from '../src/attention';

const NOW = 1_800_000_000_000;

function approval(
  over: Partial<PendingApprovalSummaryRow> &
    Pick<PendingApprovalSummaryRow, 'peerId' | 'q' | 'deadline'>,
): PendingApprovalSummaryRow {
  return {
    kind: 'other',
    sessionTag: null,
    ts: NOW,
    arrivedAt: NOW,
    displayName: null,
    localName: null,
    machine: false,
    ...over,
  };
}

test('groups by authenticated source while preserving deadline order', () => {
  const rows = [
    approval({
      peerId: 'agent-b-12345678',
      q: 'q-b-first',
      deadline: NOW + 10_000,
      kind: 'file',
      displayName: 'Codex',
      machine: true,
    }),
    approval({
      peerId: 'agent-a-87654321',
      q: 'q-a',
      deadline: NOW + 20_000,
      localName: 'Build Mac',
    }),
    approval({
      peerId: 'agent-b-12345678',
      q: 'q-b-second',
      deadline: NOW + 30_000,
      kind: 'exec',
      displayName: 'Codex',
      machine: true,
    }),
  ];

  expect(buildAttentionSections(rows)).toEqual([
    expect.objectContaining({
      peerId: 'agent-b-12345678',
      title: 'Codex',
      sourceLabel: 'AI agent',
      data: [rows[0], rows[2]],
    }),
    expect.objectContaining({
      peerId: 'agent-a-87654321',
      title: 'Build Mac',
      sourceLabel: 'Room',
      data: [rows[1]],
    }),
  ]);
});

test('deadline copy is compact, bounded, and never negative', () => {
  expect(attentionDeadlineLabel(NOW - 1, NOW)).toBe('Due now');
  expect(attentionDeadlineLabel(NOW + 29_900, NOW)).toBe('0:29 left');
  expect(attentionDeadlineLabel(NOW + 3_661_000, NOW)).toBe('1:01:01 left');
});

function work(
  over: Partial<AiWorkEventRow> & Pick<AiWorkEventRow, 'peerId' | 'eventId' | 'receivedAt'>,
): AiWorkEventRow {
  return {
    wireMsgId: `wire-${over.eventId}`,
    provider: 'claude',
    event: 'turn-complete',
    project: 'Tacendum',
    projectReceivedAt: NOW,
    requestId: null,
    runTag: 's-7c2e',
    originKind: 'message',
    sourceRef: `wire-${over.eventId}`,
    sourceAt: over.receivedAt,
    displayAt: over.receivedAt,
    timeTrusted: true,
    displayName: 'Claude Code',
    localName: null,
    context: null,
    ...over,
  };
}

test('prioritizes action-needed reports, then groups in local receive order', () => {
  const rows = [
    work({ peerId: 'agent-a', eventId: 'event-2', receivedAt: NOW + 2 }),
    work({
      peerId: 'agent-b',
      eventId: 'event-3',
      receivedAt: NOW + 3,
      provider: 'codex',
      project: null,
      displayName: 'Codex',
      event: 'turn-failed',
    }),
    work({
      peerId: 'agent-a',
      eventId: 'event-1',
      receivedAt: NOW + 1,
      event: 'waiting-for-input',
    }),
  ];

  expect(buildWorkAttentionSections(rows, [])).toEqual([
    expect.objectContaining({
      key: 'agent-b:codex:',
      title: 'Codex',
      sourceLabel: 'Codex · Project unavailable',
      data: [rows[1]],
    }),
    expect.objectContaining({
      key: 'agent-a:claude:Tacendum',
      title: 'Claude Code',
      sourceLabel: 'Claude · Tacendum',
      data: [rows[2], rows[0]],
    }),
  ]);
  expect(ATTENTION_EVENT_COPY['waiting-for-input']).toBe(
    'Reported waiting for input',
  );
});

test('an exact pending approval suppresses only its duplicate needs-review event', () => {
  const q = 'same-q';
  const pending = approval({ peerId: 'agent-a', q, deadline: NOW + 10_000 });
  const rows = [
    work({
      peerId: 'agent-a',
      eventId: 'event-review',
      receivedAt: NOW + 2,
      event: 'needs-review',
      requestId: q,
    }),
    work({
      peerId: 'agent-a',
      eventId: 'event-other-run',
      receivedAt: NOW + 1,
      event: 'waiting-for-input',
      requestId: null,
    }),
  ];

  expect(buildWorkAttentionSections(rows, [pending])[0]!.data).toEqual([rows[1]]);
});
