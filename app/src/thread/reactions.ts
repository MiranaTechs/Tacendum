import type { ReactionRow } from '../db';
import { REACTIONS } from './constants';

export interface ReactionGroup {
  emoji: string;
  count: number;
  includesMine: boolean;
  reactions: ReactionRow[];
}

const familiarOrder = new Map(
  REACTIONS.map((choice, index) => [choice.emoji, index]),
);

/** Fold authenticated per-reactor rows into the compact groups drawn below a
 * message. Ordering is independent of SQLite row order, so a refresh cannot
 * shuffle the pills or the names inside an open detail surface. */
export function groupReactions(rows: readonly ReactionRow[]): ReactionGroup[] {
  // SQLite already keeps one row per authenticated reactor. Fold duplicate
  // snapshots defensively so neither counts nor ownership can be inflated.
  const latest = new Map<string, ReactionRow>();
  for (const row of rows) {
    const key = `${row.direction}:${row.reactorId}`;
    const previous = latest.get(key);
    if (!previous || row.ts > previous.ts ||
      (row.ts === previous.ts && row.emoji < previous.emoji)) latest.set(key, row);
  }
  const grouped = new Map<string, ReactionRow[]>();
  for (const row of latest.values()) {
    if (!row.emoji) continue;
    grouped.set(row.emoji, [...(grouped.get(row.emoji) ?? []), row]);
  }
  return [...grouped.entries()]
    .sort(([a], [b]) => {
      const ai = familiarOrder.get(a);
      const bi = familiarOrder.get(b);
      if (ai !== undefined || bi !== undefined) {
        if (ai === undefined) return 1;
        if (bi === undefined) return -1;
        return ai - bi;
      }
      return a < b ? -1 : a > b ? 1 : 0;
    })
    .map(([emoji, reactions]) => {
      const ordered = [...reactions].sort((a, b) => {
        if (a.direction !== b.direction) return a.direction === 'out' ? -1 : 1;
        if (a.reactorId !== b.reactorId) {
          return a.reactorId < b.reactorId ? -1 : 1;
        }
        return a.ts - b.ts;
      });
      return {
        emoji,
        count: ordered.length,
        includesMine: ordered.some(row => row.direction === 'out'),
        reactions: ordered,
      };
    });
}
