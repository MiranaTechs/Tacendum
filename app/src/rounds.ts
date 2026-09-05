/**
 * ROUNDS on the phone — the join, as a pure function (§3.2).
 *
 * A ROUND is one human turn plus the agents' answers to it. The wire carries
 * NO round id and no round object: the join key is the reply reference that
 * already ships (§5.3's `${authorId}.${m}`), matched against rows this phone
 * already holds. That is the whole point — the key is AUTHENTICATED because
 * it resolves to a row whose sender the ratchet already vouched for, never
 * because a sender labelled it. A round is a client-side reading of messages
 * that stand on their own; nothing about it reaches the relay, and the relay
 * sees N independent 1:1 legs whatever this file decides.
 *
 * No React, no `db` import, no clock of its own: it takes an already-built
 * list and a resolver and returns index ranges, so the whole priority order
 * below is testable without mounting a screen.
 *
 * TWO ARMS, in priority order (§3.2):
 *
 *  1. THE REF ARM — authoritative, and with NO window. An answer composed as
 *     a `reply` whose `ref` resolves through the caller's row map belongs to
 *     the round anchored at that row. An authenticated ref outranks any
 *     clock (R18), so two answers minutes apart still share a round.
 *  2. THE WINDOW ARM — the fallback for the bare `msg` answers an attend turn
 *     still composes when nothing carries a resolving ref (in a ROOM: see the
 *     author rule below). A maximal run of consecutive inbound agent rows,
 *     each within `ROUND_WINDOW_MS` of the previous by **`arrivedAt`** — this
 *     phone's own arrival clock, never `ts`, which is the sender's and which
 *     a sender chooses. Its anchor is the nearest preceding outbound row.
 *
 * And the tie-breaks that decide everything else, each one normative:
 *
 *  - MEMBERSHIP REQUIRES `aiSender`, which the caller derives from the `ai`
 *    column or the machine record and never from body text (`machine.ts`
 *    records why). A human's reply to the same anchor is not a member.
 *  - ONLY INBOUND ROWS JOIN. The human's turn is the anchor, never a member.
 *  - A NON-QUALIFYING ROW ENDS A RUN: system rows, outbound rows and non-agent
 *    inbound rows all break it.
 *  - REF BEATS WINDOW. Two resolving refs that disagree start two rounds; a
 *    row with no ref beside ref-carrying rows joins theirs — the window arm
 *    supplies membership, the ref arm supplies the anchor.
 *  - n COUNTS DISTINCT AUTHORS, NEVER ROWS. The header says "N agents
 *    replied", so N has to be a count of AGENTS: one agent that answers
 *    twice inside the window is one agent. Counting rows made that sentence
 *    false on the product's most ordinary path — a 1:1 attend thread, where
 *    every inbound row is the SAME single peer, so "2 agents replied" stood
 *    over one agent's two messages. A 1:1 therefore has no rounds at all
 *    (one peer, one identity, nothing to announce); the window arm's real
 *    subject is a ROOM whose agents compose bare `msg` answers.
 *  - n >= 2 (R19). A round of one gets no header: a header over a single
 *    bubble is noise, and "1 agent replied" is a sentence nobody needs.
 */

import { roundKeyAuthor } from '@tacendum/shared/rounds';

/**
 * The window arm's reach (R18): ten minutes on THIS phone's arrival clock.
 * The ref arm has no window at all, deliberately — see the header.
 */
export const ROUND_WINDOW_MS = 10 * 60 * 1000;

/** The smallest round that earns a header (R19). */
export const ROUND_MIN_MEMBERS = 2;

/**
 * Every word this feature puts on glass, in one deck, `as const` — so the
 * copy scanners see it and the tests match by IDENTITY rather than by a
 * re-typed literal that could drift from what ships.
 *
 * The nouns are fixed by §2: BRIEF, DETAIL, FULL ANSWER. Never
 * "summary" — the brief is written by the model, and on the fail-open path it
 * is a clipped first paragraph, so calling it a summary would claim a reading
 * that never happened. Nothing here says the relay ordered, attributed,
 * verified or coordinated anything, because it did none of those.
 */
export const ROUND_COPY = {
  /** The synthetic header over a round. Only ever called with n >= 2. */
  header: (n: number) => `${n} agents replied`,
  /** The disclosure, collapsed — what a tap will reveal. */
  showDetail: 'Full answer',
  /** The disclosure, expanded — what a tap will put away. */
  hideDetail: 'Hide full answer',
} as const;

/** A row's list key. One shape, used by the map, the ranges and the screen. */
export function rowKey(msgId: string, direction: 'in' | 'out'): string {
  return `${msgId}:${direction}`;
}

/**
 * The header's testID, derived from the anchor key so the id and the key can
 * never disagree (§3.9's `round-${anchorMsgId}-${anchorDirection}`). Split at
 * the LAST separator: a msgId is a ULID or `${ULID}.${ULID}`, but it is
 * peer-chosen and one could hold a colon.
 */
export function roundHeaderTestID(anchorKey: string): string {
  const cut = anchorKey.lastIndexOf(':');
  return cut < 0
    ? `round-${anchorKey}`
    : `round-${anchorKey.slice(0, cut)}-${anchorKey.slice(cut + 1)}`;
}

/**
 * Which stored row a ROOM reply reference names, as a list key — or null when
 * the ref is not a round key at all.
 *
 * THE BUG THIS EXISTS FOR (§3.2). `ChatThreadScreen`'s `quotedFor` resolves a
 * reply's side from `ofs`: `authoredByMe = envelope.ofs === (row.direction ===
 * 'out')`, so an inbound reply with `ofs:false` is looked up as `:out`. On the
 * OWNER's phone the human turn IS an out row and that resolves. On any other
 * room member's phone the same human turn is an INBOUND row, the `:out` lookup
 * misses, and the authoritative arm silently degrades to the window arm — with
 * every owner-side test still green.
 *
 * `ofs` is a 1:1 anti-spoof bit, and a room ref already subsumes it: the room
 * ref NAMES ITS AUTHOR outright. So the side is decided by the author, and the
 * caller must still check the key against rows it holds — a ref is matched
 * against rows, never trusted as a label.
 */
export function roomAnchorKey(
  ref: string,
  selfUserId: string | null,
): string | null {
  const author = roundKeyAuthor(ref);
  if (author === null) return null;
  return `${ref}:${author === selfUserId ? 'out' : 'in'}`;
}

/** One row, as the join needs to see it. Nothing here is sender-supplied. */
export interface RoundItem {
  msgId: string;
  direction: 'in' | 'out';
  /** Renders as a full-width system line, a call chip or an approval card —
   * an event in the conversation, not speech, so it ends a run. */
  system: boolean;
  /** The `ai` column or the machine record (never body text): the ONLY
   * membership test. */
  aiSender: boolean;
  /** The AUTHENTICATED author — a room row's `authorId` column, null on a
   * 1:1 row where the sender is the thread's one peer. Never a body field,
   * exactly like `aiSender`. The header counts DISTINCT values of this, so
   * one agent answering twice is one agent (see the header's note). */
  authorId: string | null;
  /** THIS phone's arrival clock, or null on a row that predates the column.
   * Never `ts`: that is the sender's clock. */
  arrivedAt: number | null;
}

/** One round, as index range over the list it was computed from. */
export interface RoundRange {
  /** `${msgId}:${direction}` of the human turn this round answers. */
  anchorKey: string;
  /** Index of the first member — where the header goes, in LIST order. */
  first: number;
  /** Index of the last member. */
  last: number;
  /** How many DISTINCT AUTHORS the members have — what the header counts,
   * and never the member count. Always >= 2. */
  n: number;
}

/** One author's identity for counting. A 1:1 row carries no author because
 * the thread has exactly one peer, so every such row is the SAME identity —
 * which is the honest reading, and the reason a 1:1 grows no header. */
function authorIdentity(item: RoundItem): string {
  return item.authorId ?? '';
}

/** A finite arrival stamp, or null — a guess is not a clock. */
function arrivedOf(item: RoundItem): number | null {
  const at = item.arrivedAt;
  return typeof at === 'number' && Number.isFinite(at) ? at : null;
}

/**
 * The rounds in a list, in list order.
 *
 * `resolveAnchor` is the REF ARM: given a member, it returns the list key of
 * the row that member answers — or null when the row carries no reply ref,
 * when the ref is malformed, or (the load-bearing case) when the ref does not
 * resolve against rows this phone holds. The caller owns that lookup because
 * the caller owns the row map; this function owns the priority order.
 */
export function roundRanges(
  items: readonly RoundItem[],
  resolveAnchor: (item: RoundItem, index: number) => string | null,
): RoundRange[] {
  const ranges: RoundRange[] = [];
  /** The round being accumulated. `members` holds the DISTINCT AUTHORS seen
   * so far, because that — not the row count — is what the header says out
   * loud. `at` is the last member's arrival stamp that HAD one. */
  let open: {
    anchorKey: string;
    first: number;
    last: number;
    members: Set<string>;
    at: number | null;
  } | null = null;
  /** The nearest preceding outbound row — the window arm's anchor. */
  let windowAnchor: string | null = null;

  const close = (): void => {
    // R19 counted in AGENTS: two answers from one author are one agent
    // answering twice, and no header claims otherwise.
    if (open !== null && open.members.size >= ROUND_MIN_MEMBERS) {
      ranges.push({
        anchorKey: open.anchorKey,
        first: open.first,
        last: open.last,
        n: open.members.size,
      });
    }
    open = null;
  };

  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    // A system row is an event, not speech: it ends a run and can never be
    // an anchor (the human turn a round answers is a message).
    if (item.system) {
      close();
      continue;
    }
    if (item.direction === 'out') {
      close();
      windowAnchor = rowKey(item.msgId, 'out');
      continue;
    }
    if (!item.aiSender) {
      close();
      continue;
    }
    const refAnchor = resolveAnchor(item, i);
    if (refAnchor !== null) {
      // The ref arm: no window, and a DIFFERENT resolving ref starts a new
      // round rather than widening this one.
      if (open !== null && open.anchorKey === refAnchor) {
        open.last = i;
        open.members.add(authorIdentity(item));
        // KEEP the last stamp that existed: a ref-placed member with no
        // arrival clock must not blind the window arm for the rows behind
        // it. Overwriting `at` with null there destroyed the whole round —
        // the same "grouping on a guess in the other direction" the ref-less
        // case below refuses.
        open.at = arrivedOf(item) ?? open.at;
      } else {
        close();
        open = {
          anchorKey: refAnchor,
          first: i,
          last: i,
          members: new Set([authorIdentity(item)]),
          at: arrivedOf(item),
        };
      }
      continue;
    }
    const arrived = arrivedOf(item);
    // No ref and no arrival clock: not placed, and NOT a break either — the
    // rows on either side of it may still be one round, and losing that to a
    // missing column would be grouping on a guess in the other direction.
    if (arrived === null) continue;
    if (
      open !== null &&
      open.at !== null &&
      arrived - open.at >= 0 &&
      arrived - open.at < ROUND_WINDOW_MS
    ) {
      // The window arm supplies membership; whatever anchored the open round
      // (a resolved ref, or the preceding outbound row) supplies the anchor.
      open.last = i;
      open.members.add(authorIdentity(item));
      open.at = arrived;
      continue;
    }
    close();
    // Nothing outbound before it: there is no human turn on this phone to
    // anchor a round to, so there is no round.
    if (windowAnchor === null) continue;
    open = {
      anchorKey: windowAnchor,
      first: i,
      last: i,
      members: new Set([authorIdentity(item)]),
      at: arrived,
    };
  }
  close();
  return ranges;
}
