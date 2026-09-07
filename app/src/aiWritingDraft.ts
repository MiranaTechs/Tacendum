import { liveMentionChips, type MentionChip } from './thread/mentions';
import { AI_WRITING_OUTPUT_MAX } from './aiWriting';

export interface WritingDraftSnapshot {
  peerId: string;
  text: string;
  chips: MentionChip[];
  pending: string | null;
  revision: number;
  providerRevision: number;
}

/** Local identity only. No part of this snapshot is a provider payload. */
export function sameWritingDraft(a: WritingDraftSnapshot, b: WritingDraftSnapshot): boolean {
  return a.peerId === b.peerId && a.text === b.text && a.pending === b.pending &&
    a.revision === b.revision && a.providerRevision === b.providerRevision &&
    a.chips.length === b.chips.length && a.chips.every((chip, i) => {
      const other = b.chips[i]!;
      return chip.id === other.id && chip.name === other.name &&
        chip.start === other.start && chip.end === other.end;
    });
}

/** A generated draft must never become an authenticated control envelope. */
export function isSafeWritingText(text: string): boolean {
  if (!text.trim() || text.length > AI_WRITING_OUTPUT_MAX || text.includes('\uFFFC')) return false;
  try {
    const value: unknown = JSON.parse(text.trim());
    if (value && typeof value === 'object' && !Array.isArray(value) &&
      Object.prototype.hasOwnProperty.call(value, 'tcm')) return false;
  } catch {
    // Ordinary prose is the expected case.
  }
  return true;
}

/**
 * Keep picked mention names and IDs on this device. Tokens are chosen outside
 * the source's namespace and restored only once, in their original order.
 */
export function maskWritingMentions(text: string, chips: MentionChip[]): {
  draft: string;
  restore: (candidate: string) => { text: string; chips: MentionChip[] } | null;
} | null {
  const live = liveMentionChips(text, chips);
  if (live.length !== chips.length) return null;
  let salt = 0;
  while (text.includes(`[[TACENDUM_MENTION_${salt}_`)) salt += 1;
  const prefix = `[[TACENDUM_MENTION_${salt}_`;
  const tokens = live.map((_, i) => `${prefix}${i}]]`);
  let offset = 0;
  let draft = '';
  for (let i = 0; i < live.length; i += 1) {
    const chip = live[i]!;
    if (chip.start < offset) return null;
    draft += text.slice(offset, chip.start) + tokens[i]!;
    offset = chip.end;
  }
  draft += text.slice(offset);
  return {
    draft,
    restore(candidate) {
      if (!isSafeWritingText(candidate)) return null;
      let cursor = 0;
      let restored = '';
      const restoredChips: MentionChip[] = [];
      for (let i = 0; i < tokens.length; i += 1) {
        const token = tokens[i]!;
        const at = candidate.indexOf(token, cursor);
        if (at < 0 || candidate.indexOf(token, at + token.length) >= 0) return null;
        const before = candidate.slice(cursor, at);
        if (before.includes(prefix)) return null;
        restored += before;
        const chip = live[i]!;
        const start = restored.length;
        restored += `@${chip.name}`;
        restoredChips.push({ ...chip, start, end: restored.length });
        cursor = at + token.length;
      }
      const remaining = candidate.slice(cursor);
      if (remaining.includes(prefix)) return null;
      restored += remaining;
      // Refuse invented marker text in other namespaces, while allowing an
      // identical literal token the person already had in their source.
      const markers = restored.match(/\[\[TACENDUM_MENTION_[^\]\r\n]*\]\]/g) ?? [];
      const sourceMarkers = text.match(/\[\[TACENDUM_MENTION_[^\]\r\n]*\]\]/g) ?? [];
      if (markers.length !== sourceMarkers.length ||
        markers.some((marker, i) => marker !== sourceMarkers[i])) return null;
      return isSafeWritingText(restored) ? { text: restored, chips: restoredChips } : null;
    },
  };
}
