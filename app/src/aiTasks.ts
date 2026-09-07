import type { AiAgentStateRow } from './db';

export const AI_TASK_PROMPT_MAX = 2_000;
export const AI_TASK_NAME_MAX = 40;
export const AI_SAVED_TASK_MAX = 12;

export interface AiTaskTemplateInput {
  name: string;
  prompt: string;
}

/** One normalization boundary shared by UI and storage. The saved bytes are
 * the same trimmed words the reviewed send flow would place on the wire. */
export function normalizeAiTaskTemplate(
  name: string,
  prompt: string,
): AiTaskTemplateInput | null {
  const normalized = { name: name.trim(), prompt: prompt.trim() };
  if (
    normalized.name.length === 0 ||
    normalized.name.length > AI_TASK_NAME_MAX ||
    normalized.prompt.length === 0 ||
    normalized.prompt.length > AI_TASK_PROMPT_MAX
  ) {
    return null;
  }
  return normalized;
}

export const AI_QUICK_TASKS = [
  {
    id: 'review-changes',
    label: 'Review changes',
    prompt:
      'Review the current changes. Explain significant risks and cite the files or evidence you used. Do not change files.',
  },
  {
    id: 'explain-failure',
    label: 'Explain a failing check',
    prompt:
      'Explain the current failing check. Identify the root cause and suggest the smallest fix. Do not change files.',
  },
  {
    id: 'summarize-changes',
    label: 'Summarize changes',
    prompt:
      'Summarize the current changes, grouped by user-visible behavior, and cite the files you inspected. Do not change files.',
  },
] as const;

export type AiQuickTaskId = (typeof AI_QUICK_TASKS)[number]['id'];

export function canStartAiTask(state: AiAgentStateRow | null): boolean {
  return state?.capabilities?.tasks === true;
}

function sameReportedContext(
  reviewed: AiAgentStateRow['context'],
  current: AiAgentStateRow['context'],
): boolean {
  const availability = reviewed?.availability ?? null;
  if (availability !== (current?.availability ?? null)) return false;
  if (availability !== 'captured' && availability !== 'stale') return true;
  if (
    reviewed === null ||
    reviewed.availability === 'unavailable' ||
    current === null ||
    current.availability === 'unavailable'
  ) {
    return false;
  }
  return (
    reviewed.repository === current.repository &&
    reviewed.branch === current.branch
  );
}

/**
 * The confirmation belongs to the peer/provider/project shown when it was
 * opened. Re-reading before send prevents an async capability or project
 * change from turning a reviewed request into one addressed under different
 * facts. Project remains display context; it is never sent as an authority
 * over the host's working directory.
 */
export function sameAiTaskTarget(
  reviewed: AiAgentStateRow,
  current: AiAgentStateRow | null,
): boolean {
  return (
    current !== null &&
    current.peerId === reviewed.peerId &&
    current.provider === reviewed.provider &&
    current.project === reviewed.project &&
    sameReportedContext(reviewed.context, current.context) &&
    current.capabilities?.tasks === true
  );
}
