/**
 * `buildItems` and its key extractor, tested DIRECTLY for the first time
 *. This is ~210 lines of pure function that has
 * been reachable only through a mounted thread since it was written: every
 * question about a round header's placement, a divider's slot or a list key
 * has cost a render.
 *
 * The collision case is the one that matters most. A peer controls their own
 * msgIds and could reuse a call's cid or an approval's q as one; two
 * identical keyExtractor values is a VirtualizedList drawing one cell for two
 * different items.
 *
 * Falsifier (CONTRIBUTING.md:76-80): run against deliberately broken
 * predicates before it was believed — see the commit body.
 */
import type { ApprovalRow, CallLogRow, MessageRow } from '../src/db';
import type { Envelope } from '../src/envelope';
import { rowKey } from '../src/rounds';
import {
  approvalPlaceholderRow,
  buildItems,
  callPlaceholderRow,
  threadKey,
  type ThreadItem,
} from '../src/thread/items';

const DAY = 24 * 60 * 60 * 1000;
/** A fixed midday so no case straddles a day boundary by accident. */
const T0 = Date.UTC(2026, 8, 5, 12, 0, 0);

const msg = (
  over: Partial<MessageRow> & Pick<MessageRow, 'msgId'>,
): MessageRow => ({
  peerId: 'room1',
  direction: 'in',
  body: '',
  ts: T0,
  status: 'received',
  ...over,
});

const call = (over: Partial<CallLogRow> & Pick<CallLogRow, 'cid'>): CallLogRow =>
  ({
    peerId: 'room1',
    direction: 'in',
    kind: 'audio',
    reason: null,
    startedAt: T0,
    connectedAt: null,
    endedAt: T0,
    missed: 1,
    ...over,
  }) as CallLogRow;

const approval = (
  over: Partial<ApprovalRow> & Pick<ApprovalRow, 'q'>,
): ApprovalRow =>
  ({
    peerId: 'room1',
    ts: T0,
    ...over,
  }) as ApprovalRow;

/** What buildItems needs about rounds and cannot derive: who is an agent,
 * and which stored row a reply reference resolves to. */
interface RoundHooks {
  aiSender: (row: MessageRow) => boolean;
  anchorKey: (row: MessageRow, envelope: Envelope | null) => string | null;
}

/** Defaulted to "nobody is an agent, nothing resolves". */
const noRounds: RoundHooks = {
  aiSender: () => false,
  anchorKey: () => null,
};

/** buildItems' five parallel arrays, sized to the rows. */
const build = (
  rows: MessageRow[],
  over: {
    callAt?: (CallLogRow | undefined)[];
    approvalAt?: (ApprovalRow | undefined)[];
    envelopes?: (Envelope | null)[];
    unreadWindow?: { since: number; until: number } | null;
    round?: RoundHooks;
  } = {},
): ThreadItem[] =>
  buildItems(
    rows,
    over.callAt ?? rows.map(() => undefined),
    over.approvalAt ?? rows.map(() => undefined),
    over.envelopes ?? rows.map(() => null),
    over.unreadWindow ?? null,
    over.round ?? noRounds,
  );

describe('grouping is by direction, author, clock and day', () => {
  test('two inbound rows a minute apart are one group', () => {
    const items = build([
      msg({ msgId: 'm1', ts: T0 }),
      msg({ msgId: 'm2', ts: T0 + 60_000 }),
    ]);
    expect(items.map(i => [i.firstInGroup, i.lastInGroup])).toEqual([
      [true, false],
      [false, true],
    ]);
  });

  test('a gap wider than the window breaks the group', () => {
    const items = build([
      msg({ msgId: 'm1', ts: T0 }),
      msg({ msgId: 'm2', ts: T0 + 6 * 60_000 }),
    ]);
    expect(items.map(i => i.firstInGroup)).toEqual([true, true]);
  });

  test('a NEGATIVE gap from a skewed clock never groups', () => {
    // Two devices with skewed clocks produce a gap that passes any upper
    // bound; the non-negative test is what stops minutes-apart rows merging.
    const items = build([
      msg({ msgId: 'm1', ts: T0 }),
      msg({ msgId: 'm2', ts: T0 - 60_000 }),
    ]);
    expect(items.map(i => i.firstInGroup)).toEqual([true, true]);
  });

  test('in a room, two inbound rows from two PEOPLE are two groups', () => {
    const items = build([
      msg({ msgId: 'm1', authorId: 'ana' }),
      msg({ msgId: 'm2', ts: T0 + 1000, authorId: 'ben' }),
    ]);
    expect(items.map(i => i.firstInGroup)).toEqual([true, true]);
  });

  test('a direction change breaks the group; one clock label serves both', () => {
    // Groups end at every direction change, so a quick exchange inside one
    // minute would otherwise print the same label four times: the row whose
    // NEXT row reads the same clock yields its label to it.
    const items = build([
      msg({ msgId: 'm1', direction: 'in' }),
      msg({ msgId: 'm2', ts: T0 + 1000, direction: 'out' }),
    ]);
    expect(items.map(i => i.lastInGroup)).toEqual([true, true]);
    expect(items.map(i => i.showClock)).toEqual([false, true]);
  });

  test('a direction change across a minute keeps both clocks', () => {
    const items = build([
      msg({ msgId: 'm1', direction: 'in' }),
      msg({ msgId: 'm2', ts: T0 + 90_000, direction: 'out' }),
    ]);
    expect(items.map(i => i.showClock)).toEqual([true, true]);
  });

  test('a new day is marked on the first row of it, and on the first row at all', () => {
    const items = build([
      msg({ msgId: 'm1', ts: T0 }),
      msg({ msgId: 'm2', ts: T0 + DAY }),
    ]);
    expect(items.map(i => i.newDay)).toEqual([true, true]);
  });
});

describe('a system row is transparent to the group it sits beside', () => {
  test('a timer notice does not swallow its neighbour’s clock', () => {
    const timer: Envelope = { tcm: 'timer', s: 0 } as Envelope;
    const items = build(
      [
        msg({ msgId: 'm1' }),
        msg({ msgId: 'm2', ts: T0 + 1000 }),
        msg({ msgId: 'm3', ts: T0 + 2000 }),
      ],
      { envelopes: [null, timer, null] },
    );
    // m1 is last in its (broken) group and the next row prints no clock, so
    // m1 keeps its own label rather than losing it to the notice.
    expect(items[0]!.showClock).toBe(true);
    expect(items[0]!.firstInGroup).toBe(true);
    expect(items[2]!.firstInGroup).toBe(true);
  });

  test('a retracted row is a system row too', () => {
    const items = build([
      msg({ msgId: 'm1' }),
      msg({ msgId: 'm2', ts: T0 + 1000, deletedAt: T0 + 5 }),
      msg({ msgId: 'm3', ts: T0 + 2000 }),
    ]);
    expect(items[0]!.showClock).toBe(true);
    expect(items[2]!.firstInGroup).toBe(true);
  });
});

describe('calls and approvals are derived rows, never message rows', () => {
  test('the call placeholder is empty-bodied, so every envelope parse yields null', () => {
    const c = call({ cid: 'c1', startedAt: T0 + 42 });
    const placeholder = callPlaceholderRow(c);
    expect(placeholder.msgId).toBe('c1');
    expect(placeholder.body).toBe('');
    expect(placeholder.ts).toBe(T0 + 42);
    expect(placeholder.deletedAt).toBeNull();
  });

  test('the approval placeholder is namespaced by its question', () => {
    const a = approval({ q: 'q1', ts: T0 + 7 });
    const placeholder = approvalPlaceholderRow(a);
    expect(placeholder.msgId).toBe('approval:q1');
    expect(placeholder.body).toBe('');
    expect(placeholder.direction).toBe('in');
    expect(placeholder.ts).toBe(T0 + 7);
  });

  test('the item carries the row it was handed AND the derived record', () => {
    const c = call({ cid: 'c1' });
    const a = approval({ q: 'q1' });
    const items = build(
      [callPlaceholderRow(c), approvalPlaceholderRow(a)],
      { callAt: [c, undefined], approvalAt: [undefined, a] },
    );
    expect(items).toHaveLength(2);
    expect(items[0]!.call).toBe(c);
    expect(items[1]!.approval).toBe(a);
    // Both are events, so neither joins a direction run.
    expect(items.map(i => i.firstInGroup)).toEqual([true, true]);
    expect(items.map(i => i.lastInGroup)).toEqual([true, true]);
  });

  test('a call between two messages does not swallow the earlier clock', () => {
    const c = call({ cid: 'c1', startedAt: T0 + 1000 });
    const items = build(
      [
        msg({ msgId: 'm1', ts: T0 }),
        callPlaceholderRow(c),
        msg({ msgId: 'm2', ts: T0 + 2000 }),
      ],
      { callAt: [undefined, c, undefined] },
    );
    expect(items[0]!.showClock).toBe(true);
    expect(items[2]!.firstInGroup).toBe(true);
  });
});

describe('the unread divider marks what was unread AT OPEN', () => {
  const window = { since: T0 - 1000, until: T0 + 1000 };

  test('it lands above the first unread row and counts every one of them', () => {
    const items = build(
      [
        msg({ msgId: 'old', ts: T0 - 5000, arrivedAt: T0 - 5000 }),
        msg({ msgId: 'n1', ts: T0, arrivedAt: T0 }),
        msg({ msgId: 'n2', ts: T0 + 500, arrivedAt: T0 + 500 }),
      ],
      { unreadWindow: window },
    );
    expect(items).toHaveLength(4);
    expect(items[1]!.divider).toBe(2);
    expect(items[2]!.row.msgId).toBe('n1');
  });

  test('a row that arrived WHILE the thread was open is being read, not waiting', () => {
    // Without the upper bound this grew the line
    // and scrolled away from the message the person was reading.
    const items = build(
      [msg({ msgId: 'later', ts: T0 + 9000, arrivedAt: T0 + 9000 })],
      { unreadWindow: window },
    );
    expect(items.some(i => i.divider != null)).toBe(false);
  });

  test('my own sends and relayed history are never new', () => {
    const items = build(
      [
        msg({ msgId: 'mine', direction: 'out', arrivedAt: T0 }),
        msg({ msgId: 'relayed', arrivedAt: T0, sharedBy: 'ana' }),
      ],
      { unreadWindow: window },
    );
    expect(items.some(i => i.divider != null)).toBe(false);
  });

  test('no window means no divider — none is drawn against a guess', () => {
    const items = build([msg({ msgId: 'n1', ts: T0, arrivedAt: T0 })], {
      unreadWindow: null,
    });
    expect(items.some(i => i.divider != null)).toBe(false);
  });

  test('the divider takes the day label, so the date reads above the line', () => {
    const items = build(
      [
        msg({ msgId: 'old', ts: T0 - DAY, arrivedAt: T0 - DAY }),
        msg({ msgId: 'n1', ts: T0, arrivedAt: T0 }),
      ],
      { unreadWindow: window },
    );
    expect(items[1]!.divider).toBe(1);
    expect(items[1]!.newDay).toBe(true);
    expect(items[2]!.newDay).toBe(false);
  });
});

describe('a round header stands over the first answer of a round', () => {
  /** A human turn, then two different agents answering it. */
  const rows = [
    msg({ msgId: 'human', direction: 'out', authorId: null }),
    msg({ msgId: 'a1', ts: T0 + 1000, authorId: 'agent-a', ai: 1 }),
    msg({ msgId: 'a2', ts: T0 + 2000, authorId: 'agent-b', ai: 1 }),
  ];
  const round = {
    aiSender: (r: MessageRow) => r.ai === 1,
    anchorKey: (r: MessageRow) =>
      r.msgId === 'a1' || r.msgId === 'a2' ? rowKey('human', 'out') : null,
  };

  test('the header is emitted once, above the first member, counting AUTHORS', () => {
    const items = build(rows, { round });
    expect(items).toHaveLength(4);
    expect(items[1]!.round?.n).toBe(2);
    expect(items[1]!.round?.anchorKey).toBe('human:out');
    expect(items[2]!.row.msgId).toBe('a1');
    expect(items.filter(i => i.round).length).toBe(1);
  });

  test('the header breaks the run, so the first answer keeps its own label', () => {
    const items = build(rows, { round });
    expect(items[2]!.firstInGroup).toBe(true);
  });

  test('a 1:1 grows no header — every authorId is null, so it is one author', () => {
    const solo = [
      msg({ msgId: 'human', direction: 'out' }),
      msg({ msgId: 'a1', ts: T0 + 1000, ai: 1 }),
      msg({ msgId: 'a2', ts: T0 + 2000, ai: 1 }),
    ];
    const items = build(solo, {
      round: {
        aiSender: (r: MessageRow) => r.ai === 1,
        anchorKey: (r: MessageRow) =>
          r.msgId === 'human' ? null : rowKey('human', 'out'),
      },
    });
    expect(items.some(i => i.round)).toBe(false);
  });

  test('the header takes the day label, so the date reads above the line', () => {
    // Whichever full-width line lands first takes the date with it: the eye
    // reads the date, then the line, then the message — never the line
    // wedged between a date and its first row.
    const overnight = [
      msg({ msgId: 'human', ts: T0 - DAY, direction: 'out' }),
      { ...rows[1]!, ts: T0 },
      { ...rows[2]!, ts: T0 + 1000 },
    ];
    const items = build(overnight, { round });
    expect(items[1]!.round).toBeDefined();
    expect(items[1]!.newDay).toBe(true);
    expect(items[2]!.row.msgId).toBe('a1');
    expect(items[2]!.newDay).toBe(false);
  });

  test('with a divider AND a header on a new day, only the divider carries it', () => {
    const overnight = [
      msg({ msgId: 'human', ts: T0 - DAY, direction: 'out' }),
      { ...rows[1]!, ts: T0, arrivedAt: T0 },
      { ...rows[2]!, ts: T0 + 1000, arrivedAt: T0 + 1000 },
    ];
    const items = build(overnight, {
      round,
      unreadWindow: { since: T0 - 500, until: T0 + 5000 },
    });
    expect(items[1]!.divider).toBe(2);
    expect(items[1]!.newDay).toBe(true);
    expect(items[2]!.round).toBeDefined();
    expect(items[2]!.newDay).toBe(false);
    expect(items[3]!.newDay).toBe(false);
  });

  test('when a divider and a header land on one row, the DIVIDER wins the slot', () => {
    const arrived = [
      rows[0]!,
      { ...rows[1]!, arrivedAt: T0 + 1000 },
      { ...rows[2]!, arrivedAt: T0 + 2000 },
    ];
    const items = build(arrived, {
      round,
      unreadWindow: { since: T0 + 500, until: T0 + 5000 },
    });
    // human, divider, header, a1, a2
    expect(items).toHaveLength(5);
    expect(items[1]!.divider).toBe(2);
    expect(items[2]!.round).toBeDefined();
    expect(items[3]!.row.msgId).toBe('a1');
    // Only one of the two takes the date with it.
    expect(items[2]!.newDay).toBe(false);
  });
});

describe('threadKey gives every namespace its own space', () => {
  test('a message key carries its direction, so in and out never collide', () => {
    const item = (row: MessageRow): ThreadItem =>
      ({ row, envelope: null }) as ThreadItem;
    expect(threadKey(item(msg({ msgId: 'x', direction: 'in' })))).toBe('x:in');
    expect(threadKey(item(msg({ msgId: 'x', direction: 'out' })))).toBe('x:out');
  });

  test('a peer reusing a cid or a q as a msgId still gets distinct keys', () => {
    const rows = [
      msg({ msgId: 'shared', direction: 'in' }),
      msg({ msgId: 'call-row', ts: T0 + 1000 }),
      msg({ msgId: 'appr-row', ts: T0 + 2000 }),
    ];
    const items = build(rows, {
      callAt: [undefined, call({ cid: 'shared' }), undefined],
      approvalAt: [undefined, undefined, approval({ q: 'shared' })],
    });
    const keys = items.map(threadKey);
    expect(keys).toEqual(['shared:in', 'call:shared', 'approval:shared']);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test('two rounds under ONE anchor produce two distinct header keys', () => {
    // close() drops an open round on any outbound row and the next
    // qualifying row reopens under the SAME anchor: one turn answered,
    // interrupted, answered again. Two identical keys would be a
    // VirtualizedList reusing one cell for two different items.
    const rows = [
      msg({ msgId: 'human', direction: 'out' }),
      msg({ msgId: 'a1', ts: T0 + 1000, authorId: 'agent-a', ai: 1 }),
      msg({ msgId: 'a2', ts: T0 + 2000, authorId: 'agent-b', ai: 1 }),
      msg({ msgId: 'me', ts: T0 + 3000, direction: 'out' }),
      msg({ msgId: 'b1', ts: T0 + 4000, authorId: 'agent-a', ai: 1 }),
      msg({ msgId: 'b2', ts: T0 + 5000, authorId: 'agent-b', ai: 1 }),
    ];
    const items = build(rows, {
      round: {
        aiSender: (r: MessageRow) => r.ai === 1,
        anchorKey: (r: MessageRow) =>
          r.ai === 1 ? rowKey('human', 'out') : null,
      },
    });
    const headers = items.filter(i => i.round);
    expect(headers).toHaveLength(2);
    expect(headers[0]!.round!.anchorKey).toBe(headers[1]!.round!.anchorKey);
    const keys = items.map(threadKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test('every key in a mixed list is unique', () => {
    const rows = [
      msg({ msgId: 'm1', ts: T0 - DAY, arrivedAt: T0 - DAY }),
      msg({ msgId: 'm2', ts: T0, arrivedAt: T0 }),
      msg({ msgId: 'm3', ts: T0 + 1000 }),
      msg({ msgId: 'm4', ts: T0 + 2000 }),
    ];
    const items = build(rows, {
      callAt: [undefined, undefined, call({ cid: 'c9' }), undefined],
      approvalAt: [undefined, undefined, undefined, approval({ q: 'q9' })],
      unreadWindow: { since: T0 - 100, until: T0 + 100 },
    });
    const keys = items.map(threadKey);
    expect(keys).toContain('unread-divider');
    expect(new Set(keys).size).toBe(keys.length);
  });
});
