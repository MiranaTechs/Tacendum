import { detailText, displayText } from './envelope';
import type { MentionChip } from './thread/mentions';

/** Long enough to carry useful evidence, small enough to leave room for the
 * visible instruction and mention envelope inside the ordinary message cap. */
export const SECOND_OPINION_CONTEXT_MAX = 1_200;

export interface SecondOpinionAgentFact {
  peerId: string;
  /** Current folded roster membership, never a historical slot. */
  inRoom: boolean;
  /** Existing room attribution: owner class, first-hand AI marker or an
   * adopted machine record. This fact alone never says the agent can run. */
  recognizedInRoom: boolean;
  /** Source-backed configured capability from the current AI state row. */
  tasksConfigured: boolean;
  /** An agent this account adopted. Revoked agents never reach this model
   * because callers intersect with listAiAgentStates first. */
  owned: boolean;
  consent: 'consented' | 'refused' | 'undecided';
}

/** Targets that may receive a reviewed room mention right now. The source
 * author is excluded so this action cannot ask one agent to trigger itself. */
export function eligibleSecondOpinionTargetIds(
  sourceAuthorId: string,
  facts: readonly SecondOpinionAgentFact[],
): string[] {
  return facts
    .filter(
      fact =>
        fact.peerId !== sourceAuthorId &&
        fact.inRoom &&
        fact.recognizedInRoom &&
        fact.tasksConfigured &&
        (fact.owned || fact.consent === 'consented'),
    )
    .map(fact => fact.peerId);
}

export interface SecondOpinionNamedTarget {
  peerId: string;
  name: string;
}

export interface SecondOpinionDraft {
  draft: string;
  chips: MentionChip[];
  contextWasClipped: boolean;
}

/**
 * Build the exact editable text the person reviews. Names are local display
 * text backed by mention chips: mentionWire replaces them with ids before the
 * room send, so a private alias never reaches another member. The answer is
 * copied as visible context, not summarized or interpreted.
 */
export function buildSecondOpinionDraft(
  targets: readonly SecondOpinionNamedTarget[],
  sourceBody: string,
): SecondOpinionDraft | null {
  if (targets.length === 0) return null;
  const brief = displayText(sourceBody).trim();
  if (brief.length === 0) return null;
  const detail = detailText(sourceBody)?.trim() ?? '';
  const context = detail.length > 0 ? `${brief}\n\nFull answer:\n${detail}` : brief;
  const contextWasClipped = context.length > SECOND_OPINION_CONTEXT_MAX;
  const shownContext = contextWasClipped
    ? `${context.slice(0, SECOND_OPINION_CONTEXT_MAX - 1).trimEnd()}…`
    : context;

  const chips: MentionChip[] = [];
  let mentions = '';
  for (const target of targets) {
    if (mentions.length > 0) mentions += ' ';
    const start = mentions.length;
    mentions += `@${target.name}`;
    chips.push({
      id: target.peerId,
      name: target.name,
      start,
      end: mentions.length,
    });
  }

  return {
    draft:
      `${mentions} Please give a second opinion on this agent answer. ` +
      `Review only; do not change files.\n\n` +
      `${contextWasClipped ? 'Context excerpt shared:' : 'Context shared:'}\n` +
      shownContext,
    chips,
    contextWasClipped,
  };
}

/** The reviewed mention remains valid only while every selected target is
 * still eligible. A partial pass could leak context to an unconsented agent. */
export function selectedSecondOpinionTargetsAreCurrent(
  selected: readonly string[],
  eligible: readonly string[],
): boolean {
  if (selected.length === 0) return false;
  const current = new Set(eligible);
  return new Set(selected).size === selected.length && selected.every(id => current.has(id));
}
