// Pure conversation-list construction: message grouping, synthetic call and
// approval rows, round headers, unread boundaries, and stable list keys.
// Database and envelope imports are type-only. Runtime dependencies flow
// toward rounds, time and constants, never toward screens.
import { type ApprovalRow, type CallLogRow, type MessageRow, type MessageStatus } from '../db';
import { type Envelope } from '../envelope';
import { roundRanges, rowKey, type RoundRange } from '../rounds';
import { clockLabel, sameDay } from '../time';
import { GROUP_WINDOW_MS } from './constants';

export interface ThreadItem {
  row: MessageRow;
  /** Present when this item is a CALL, rendered as a full-width chip. The
   * `row` is then a synthetic placeholder (msgId = cid) that exists only so
   * key extraction and neighbour arithmetic need no second shape — it is
   * never rendered and never written to the database (call
   * signalling never becomes a message row; these are derived at render
   * time from call_log). */
  call?: CallLogRow;
  /** Present when this item is an APPROVAL, rendered as the card — the same
   * synthetic-row scheme as calls, derived at render time from the
   * `approvals` table. An approval never becomes a message row, because its
   * body would hold a command line at rest. */
  approval?: ApprovalRow;
  /** The unread divider: how many messages arrived since the
   * thread was last open. Set on exactly one item, placed above the first
   * of them; `row` is then a placeholder carrying that row's ts. */
  divider?: number;
  /** Present when this item is a ROUND HEADER: the
   * synthetic full-width line over the first answer of a round, produced by
   * the round pass exactly as `divider` is. `row` is then a placeholder
   * carrying the first member's ts, and it is NEVER written to the
   * database — a round is a client-side reading of messages that stand on
   * their own, joined on a reply reference this phone resolved itself. */
  round?: RoundRange;
  /** The row's body, parsed ONCE per data change and carried here so the
   * grouping pass, the quote resolver and the mounted row all read the
   * same answer without repeated parsing. Null for plain text and for the
   * placeholder rows. */
  envelope: Envelope | null;
  firstInGroup: boolean;
  lastInGroup: boolean;
  newDay: boolean;
  /** Last in group AND the next message shows a different clock label. */
  showClock: boolean;
}

/** The list key. Distinct namespaces for chips and the divider: a peer
 * controls their own msgIds and could reuse a cid (or a q) as one,
 * colliding two list keys. Module-level, so the list's key function never
 * re-identifies. */
export function threadKey(item: ThreadItem): string {
  return item.divider != null
    ? 'unread-divider'
    : // A round header's own namespace: its anchor key is
      // built from a peer-chosen msgId, so without one it could collide with
      // the very row it stands over. The placeholder's msgId carries the
      // namespace AND the first member, because the anchor key alone is NOT
      // unique per item: `close()` drops the open round on any outbound,
      // system or non-agent row and the next qualifying row re-opens under
      // the SAME anchor, so one turn answered, interrupted and answered
      // again yields two headers — and two identical keyExtractor values is
      // a VirtualizedList reusing one cell for two different items.
      item.round
      ? item.row.msgId
      : item.approval
        ? `approval:${item.approval.q}`
        : item.call
          ? `call:${item.call.cid}`
          : `${item.row.msgId}:${item.row.direction}`;
}

/** The placeholder behind a call item. Empty body: every envelope parse on it
 * yields null, so message-only code paths fall through harmlessly. */
export function callPlaceholderRow(c: CallLogRow): MessageRow {
  return {
    msgId: c.cid,
    peerId: c.peerId,
    direction: c.direction,
    body: '',
    ts: c.startedAt,
    status: 'sent' as MessageStatus,
    deletedAt: null,
  };
}

/** The placeholder behind an approval card — callPlaceholderRow's scheme:
 * empty body, so message-only code paths fall through harmlessly. */
export function approvalPlaceholderRow(a: ApprovalRow): MessageRow {
  return {
    msgId: `approval:${a.q}`,
    peerId: a.peerId,
    direction: 'in',
    body: '',
    ts: a.ts,
    status: 'received' as MessageStatus,
    deletedAt: null,
  };
}

/** The placeholder behind a round header — `callPlaceholderRow`'s scheme
 * again: empty body, so every envelope parse on it yields null and every
 * message-only path falls through harmlessly. Its ts is the first member's,
 * so a day label above it stays truthful. Never written to the database. */
export function roundPlaceholderRow(
  first: MessageRow,
  anchorKey: string,
): MessageRow {
  return {
    // Namespaced by the anchor AND identified by the FIRST MEMBER, which is
    // stable data rather than an index (a requery shifts indices, and this
    // string is the list key). Two rounds can share one anchor; no two can
    // share a first member.
    msgId: `round:${anchorKey}:${rowKey(first.msgId, first.direction)}`,
    peerId: first.peerId,
    direction: 'in',
    body: '',
    ts: first.ts,
    status: 'received' as MessageStatus,
    deletedAt: null,
  };
}

/**
 * Whether a row's AUTHENTICATED sender is an agent — the AI badge's one
 * question, stated ONCE here because two
 * surfaces now ask it: the bubble's badge and spoken attribution, and the
 * round pass's membership test. A round is not a third source of that signal.
 *
 * Two sources and ONLY these two:
 *
 *  - the machine record: the AUTHENTICATED sender — in a room the
 *    row's authorId, in a 1:1 the thread's peer — looked up in
 *    machine_peers, the app's memory of the server's own adopt/revoke
 *    answers. It KEEPS the badge against a lying client that omits the
 *    marker: a class is never shed by silence.
 *  - the row's `ai` column: the sender-claimed in-envelope marker
 *, recorded AT ARRIVAL like `outsider`. It GAINS the
 *    badge on a phone with no record — the paired-never-adopted 1:1, and a
 *    stranger's phone in a room. It is a sender claim, which is the most
 *    the wire can establish without a server record.
 *
 * Never the words, never a shared name, never a render-time body parse — a
 * body that merely LOOKS marked cannot badge a row that arrived unmarked, and
 * cannot join a round either. Inbound only: my own sends are a person typing
 * on this phone.
 */
export function aiSenderOf(
  row: MessageRow,
  ctx: {
    inRoom: boolean;
    isAgentId: (id: string) => boolean;
    peerIsAgent: boolean;
  },
): boolean {
  if (row.direction === 'out') return false;
  if (row.ai === 1) return true;
  return ctx.inRoom
    ? row.authorId != null && ctx.isAgentId(row.authorId)
    : ctx.peerIsAgent;
}

/** The placeholder behind the unread divider — the same scheme: empty body,
 * the first unread row's ts so the day label above it stays truthful. */
export function dividerPlaceholderRow(first: MessageRow): MessageRow {
  return {
    msgId: 'unread-divider',
    peerId: first.peerId,
    direction: 'in',
    body: '',
    ts: first.ts,
    status: 'received' as MessageStatus,
    deletedAt: null,
  };
}

/**
 * Whether a row arrived after the thread was last open — the
 * chat list's unread rule (db.ts, `arrivedAt`), applied per row: THIS
 * phone's arrival clock, never the sender's `ts`; my own sends, relayed
 * history and retracted rows are never new. A row that predates the
 * arrivedAt column falls back to its ts in a 1:1 and to "never" in a room,
 * exactly as the count query does.
 */
export function isUnreadRow(row: MessageRow, window: UnreadWindow): boolean {
  if (row.direction !== 'in' || row.sharedBy || row.deletedAt) return false;
  const arrived = row.arrivedAt ?? (row.authorId != null ? 0 : row.ts);
  return arrived > window.since && arrived <= window.until;
}

/**
 * What the unread divider stands against: the window between the previous
 * open and THIS one, both on this phone's clock.
 *
 * The upper bound is the whole point. Without it the divider was recomputed
 * from the current rows on every requery, so a message arriving WHILE the
 * thread was open — the person sitting at the bottom, reading — counted as
 * unread, grew the line, and made the landing block hand the anchor over and
 * scroll away from the message being read. The divider marks what was unread at open, and
 * nothing that has landed since.
 */
export interface UnreadWindow {
  /** The chat's `lastOpenedAt` as it stood BEFORE this open; 0 for never. */
  since: number;
  /** The moment this open stamped the chat — the same `Date.now()` that went
   * to `markChatOpened`. */
  until: number;
}

export function buildItems(
  rows: MessageRow[],
  callAt: (CallLogRow | undefined)[],
  approvalAt: (ApprovalRow | undefined)[],
  /** `rows[i]`'s parsed body — the caller's once-per-row parse. */
  envelopes: (Envelope | null)[],
  /** The open's unread window, or null while unknown — no divider is drawn
   * against a guess. */
  unreadWindow: UnreadWindow | null,
  /** What the round pass needs and cannot derive here:
   * who is an agent, and which stored row a reply reference resolves to. */
  round: {
    aiSender: (row: MessageRow) => boolean;
    /** The anchor's list key, or null when the row carries no reply ref or
     * the ref does not resolve against rows this phone holds. */
    anchorKey: (row: MessageRow, envelope: Envelope | null) => string | null;
  },
): ThreadItem[] {
    // Screenshot notices render as full-width system rows that ignore every
    // grouping flag — so they must be transparent to direction runs, like the
    // date divider: a bubble next to one keeps its own clock and margins.
    // Rows that render as full-width system lines print no clock and ignore
    // every grouping flag, so they must be transparent to direction runs —
    // otherwise a neighbour loses the timestamp this one never shows.
    const system = rows.map((r, i) => {
      if (callAt[i]) return true;
      // An approval card is full-width and prints no clock, so it must be
      // grouping-transparent — the same defect class the vault line above
      // records: missing from this list, the symptom shows on the NEIGHBOUR.
      if (approvalAt[i]) return true;
      if (r.deletedAt) return true;
      // An outsider row renders full-width and tagged,
      // so it is grouping-transparent for the same reason the notices are.
      if (r.outsider) return true;
      // A relayed history row is deliberately NOT here: this list is about
      // rows that render through the full-width ruled line below, and a
      // relayed row renders as an ordinary bubble with a provenance line
      // above it.
      //
      // Adding it would not suppress its clock — I asserted that in an
      // earlier version of this comment and a mutation proved it false. The
      // flag governs GROUPING, so listing it would only make it transparent
      // to direction runs. Left out because the claim it makes would be
      // untrue, not because the alternative breaks anything.
      const tcm = envelopes[i]?.tcm;
      // All of these render through the full-width ruled line below, so all
      // of them must be listed here. A timer notice missing from this list
      // would have swallowed a neighbouring bubble's clock label — the same
      // defect shot rows were fixed for, and the reason that fix left a test
      // behind. A vault notice is the third of the same shape, and it is the
      // easiest step in the whole feature to forget because the symptom shows
      // up on the NEIGHBOUR, not on the row you added. The four room kinds
      // (grp.new, grp.roster, grp.set, plus the declined
      // grp.del row) are four more chances at exactly that defect, which is
      // why the plan calls this line out by name.
      return (
        tcm === 'shot' ||
        tcm === 'timer' ||
        tcm === 'vault' ||
        tcm === 'grp.new' ||
        tcm === 'grp.roster' ||
        tcm === 'grp.set' ||
        tcm === 'grp.del' ||
        tcm === 'grp.hist' ||
        // The consent announcement renders through the same full-width
        // ruled line, so it must be grouping-transparent too, or a neighbour
        // bubble loses the clock this row never prints.
        tcm === 'grp.consent'
      );
    });
    // The unread divider: above the first inbound MESSAGE
    // that arrived after the previous open AND BEFORE THIS ONE, counting
    // every such row — a message that lands while the thread is up is being
    // read, not waiting to be read. Events
    // (the system rows above), calls and approval cards are not messages a
    // person has yet to read, so they neither count nor carry the line.
    const unread = rows.map(
      (r, i) =>
        unreadWindow !== null &&
        !system[i] &&
        !callAt[i] &&
        !approvalAt[i] &&
        isUnreadRow(r, unreadWindow),
    );
    const firstUnread = unread.indexOf(true);
    const unreadCount = unread.filter(Boolean).length;
    // THE ROUND PASS. Computed over ROWS, before any item
    // is pushed, so the ranges index the same list the grouping flags were
    // computed from. Calls and approval cards join `system` here for the
    // reason they join it above: they are events, they break a run, and they
    // are never the human turn a round answers.
    const rounds = roundRanges(
      rows.map((r, i) => ({
        msgId: r.msgId,
        direction: r.direction,
        system: system[i] || !!callAt[i] || !!approvalAt[i],
        aiSender: round.aiSender(r),
        // The AUTHENTICATED author, beside `aiSender` and from the same kind
        // of source — the row's column, never the body. The header counts
        // DISTINCT values of it, so one agent answering twice is one agent
        // and a 1:1 (every authorId null, one peer) grows no header at all.
        authorId: r.authorId ?? null,
        arrivedAt: r.arrivedAt ?? null,
      })),
      (_item, i) => round.anchorKey(rows[i]!, envelopes[i] ?? null),
    );
    /** Row index → the round that STARTS there, so the header can be emitted
     * in one pass beside the divider. */
    const roundAt = new Map<number, RoundRange>();
    for (const r of rounds) roundAt.set(r.first, r);
    const items: ThreadItem[] = [];
    rows.forEach((row, i) => {
      const prev = rows[i - 1];
      const next = rows[i + 1];
      // A non-negative delta is required as well as a small one: two devices
      // with skewed clocks can produce a negative gap, which passes any
      // upper bound and groups messages that are minutes apart.
      const before = prev ? row.ts - prev.ts : -1;
      const after = next ? next.ts - row.ts : -1;
      const groupedBefore =
        !!prev &&
        !system[i] &&
        !system[i - 1] &&
        // A round header stands between them: the run
        // ends here, so the first answer of a round keeps its own author
        // label and its own corner instead of being tucked under a bubble
        // the header has already separated it from.
        !roundAt.has(i) &&
        prev.direction === row.direction &&
        // In a room, direction alone lies: two inbound neighbours can be two
        // different PEOPLE, and grouping them would hide the second author's
        // label. authorId is null on every 1:1 row, so this clause is inert
        // outside rooms.
        (prev.authorId ?? null) === (row.authorId ?? null) &&
        before >= 0 &&
        before < GROUP_WINDOW_MS &&
        sameDay(prev.ts, row.ts);
      const groupedAfter =
        !!next &&
        !system[i] &&
        !system[i + 1] &&
        // The same break, seen from the row above it — so THIS row is last in
        // its group and keeps the clock label the header never prints.
        !roundAt.has(i + 1) &&
        next.direction === row.direction &&
        (next.authorId ?? null) === (row.authorId ?? null) &&
        after >= 0 &&
        after < GROUP_WINDOW_MS &&
        sameDay(next.ts, row.ts);
      const lastInGroup = !groupedAfter;
      const newDay = !prev || !sameDay(prev.ts, row.ts);
      // Whichever full-width line lands here FIRST takes the day label with
      // it, so the eye reads the date, then the line, then the message.
      let dayTaken = false;
      if (i === firstUnread) {
        // The divider takes the day label with it, so the eye reads the
        // date, then "N new messages", then the message — never the line
        // wedged between a date and its first row. Grouping is untouched:
        // the flags below were computed from the rows, not from the items.
        items.push({
          row: dividerPlaceholderRow(row),
          envelope: null,
          divider: unreadCount,
          firstInGroup: true,
          lastInGroup: true,
          newDay,
          showClock: false,
        });
        dayTaken = true;
      }
      const roundHere = roundAt.get(i);
      if (roundHere) {
        // THE DIVIDER WINS THE SLOT: when both land on the
        // same row the divider is emitted first, then the header, then the
        // row. A round must never hide the row the divider points at — which
        // is also why the BRIEFS are visible by default and only the details
        // are collapsed.
        items.push({
          row: roundPlaceholderRow(row, roundHere.anchorKey),
          envelope: null,
          round: roundHere,
          firstInGroup: true,
          lastInGroup: true,
          newDay: dayTaken ? false : newDay,
          showClock: false,
        });
        dayTaken = true;
      }
      items.push({
        row,
        call: callAt[i],
        approval: approvalAt[i],
        envelope: envelopes[i] ?? null,
        firstInGroup: !groupedBefore,
        lastInGroup,
        newDay: dayTaken ? false : newDay,
        // Groups end at every direction change, so a quick exchange inside
        // one minute otherwise prints the same clock label four times. A
        // system row prints no clock, so it never suppresses a neighbor's.
        showClock:
          lastInGroup &&
          (!next ||
            system[i + 1] ||
            clockLabel(next.ts) !== clockLabel(row.ts)),
      });
    });
    return items;
  }
