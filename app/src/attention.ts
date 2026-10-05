import type {
  AiWorkEventRow,
  ApprovalKind,
  PendingApprovalSummaryRow,
} from './db';
import { personName, spokenPersonName } from './person';

/** Fixed UI copy; no sender-controlled prose is promoted into the inbox. */
export const ATTENTION_KIND_COPY: Record<ApprovalKind, string> = {
  exec: 'Run a command',
  file: 'Change files',
  other: 'Requested action',
};

export const ATTENTION_EVENT_COPY: Record<AiWorkEventRow['event'], string> = {
  'turn-complete': 'Reported turn finished',
  'turn-failed': 'Reported turn failed',
  'waiting-for-input': 'Reported waiting for input',
  'needs-review': 'Reported review requested',
};

const PROVIDER_COPY: Record<AiWorkEventRow['provider'], string> = {
  claude: 'Claude',
  codex: 'Codex',
  gemini: 'Gemini',
  cursor: 'Cursor',
};

function eventPriority(event: AiWorkEventRow['event']): number {
  return event === 'turn-complete' ? 1 : 0;
}

export interface AttentionSection {
  peerId: string;
  title: string;
  spokenTitle: string;
  /** Historical server-confirmed class, not an online/connected claim. */
  sourceLabel: 'AI agent' | 'Room';
  data: PendingApprovalSummaryRow[];
}

export interface WorkAttentionSection {
  key: string;
  peerId: string;
  title: string;
  spokenTitle: string;
  sourceLabel: string;
  data: AiWorkEventRow[];
}

/**
 * Group an already-small durable inbox by authenticated sender. Sorting is
 * repeated here so a caller cannot accidentally turn query completion order
 * into visual priority. Request identity remains `(peerId, q)` throughout.
 */
export function buildAttentionSections(
  input: readonly PendingApprovalSummaryRow[],
): AttentionSection[] {
  const ordered = [...input].sort(
    (a, b) =>
      a.deadline - b.deadline ||
      b.arrivedAt - a.arrivedAt ||
      a.peerId.localeCompare(b.peerId) ||
      a.q.localeCompare(b.q),
  );
  const byPeer = new Map<string, AttentionSection>();
  for (const row of ordered) {
    let section = byPeer.get(row.peerId);
    if (!section) {
      section = {
        peerId: row.peerId,
        title: personName(row.peerId, row.displayName, row.localName),
        spokenTitle: spokenPersonName(
          row.peerId,
          row.displayName,
          row.localName,
        ),
        sourceLabel: row.machine ? 'AI agent' : 'Room',
        data: [],
      };
      byPeer.set(row.peerId, section);
    }
    section.data.push(row);
  }
  return [...byPeer.values()];
}

/**
 * Recent reports grouped by authenticated integration and captured project.
 * Reports that may warrant attention precede routine completions, then local
 * receipt order drives both groups and rows. This is presentation priority,
 * never a claim that a historical report is still live. A matching
 * needs-review event is omitted only while its exact (peer,q) approval card
 * is already present; unrelated parallel runs remain independent because
 * runTag is not identity.
 */
export function buildWorkAttentionSections(
  input: readonly AiWorkEventRow[],
  pending: readonly PendingApprovalSummaryRow[],
): WorkAttentionSection[] {
  const pendingKeys = new Set(pending.map(row => `${row.peerId}:${row.q}`));
  const ordered = [...input]
    .filter(
      row =>
        !(
          row.event === 'needs-review' &&
          row.requestId !== null &&
          pendingKeys.has(`${row.peerId}:${row.requestId}`)
        ),
    )
    .sort(
      (a, b) =>
        eventPriority(a.event) - eventPriority(b.event) ||
        b.receivedAt - a.receivedAt ||
        a.peerId.localeCompare(b.peerId) ||
        a.eventId.localeCompare(b.eventId),
    );
  const sections = new Map<string, WorkAttentionSection>();
  for (const row of ordered) {
    const project = row.project ?? '';
    const key = `${row.peerId}:${row.provider}:${project}`;
    let section = sections.get(key);
    if (!section) {
      section = {
        key,
        peerId: row.peerId,
        title: personName(row.peerId, row.displayName, row.localName),
        spokenTitle: spokenPersonName(
          row.peerId,
          row.displayName,
          row.localName,
        ),
        sourceLabel: `${PROVIDER_COPY[row.provider]} · ${
          row.project ?? 'Project unavailable'
        }`,
        data: [],
      };
      sections.set(key, section);
    }
    section.data.push(row);
  }
  return [...sections.values()];
}

/** The same compact countdown grammar as ApprovalCard, with no negatives. */
export function attentionDeadlineLabel(deadline: number, now: number): string {
  if (deadline <= now) return 'Due now';
  const total = Math.max(0, Math.floor((deadline - now) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const two = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${two(m)}:${two(s)} left` : `${m}:${two(s)} left`;
}
