/**
 * THE ROUND JOIN, without a screen (§3.2 step 1).
 *
 * `app/src/rounds.ts` is a pure function over an already-built list plus a
 * resolver, so the whole priority order — ref arm before window arm, the
 * tie-breaks, R18's window and R19's n >= 2 — is pinned here at unit level.
 * `ChatThread.rounds.test.tsx` then proves the SCREEN feeds it the right
 * inputs; that suite cannot see most of these branches, because a screen can
 * only show one arrangement of rows at a time.
 *
 * No clock is read here at all: `arrivedAt` is data on the input, so nothing
 * in this file can be hidden by a frozen `now()`.
 */

import {
  ROUND_COPY,
  ROUND_MIN_MEMBERS,
  ROUND_WINDOW_MS,
  roomAnchorKey,
  roundHeaderTestID,
  roundRanges,
  rowKey,
  type RoundItem,
} from '../src/rounds';

const ulid = (tag: string) => (tag + '0'.repeat(26)).slice(0, 26);
const ME = ulid('ME1');
const BEN = ulid('BEN');
const CLAUDE = ulid('CLAWDE');
const CODEX = ulid('CDEX');
const TURN = `${ME}.${ulid('M1')}`;
const TURN2 = `${ME}.${ulid('M2')}`;

/**
 * An inbound agent answer, with everything else at its quiet default.
 *
 * EACH CALL IS A DIFFERENT AGENT unless the case says otherwise, because the
 * header counts DISTINCT AUTHORS: a fixture that means "three agents replied"
 * has to hold three of them. Pass `authorId` to model one agent answering
 * twice, or `authorId: null` for a 1:1 row, where every inbound row is the
 * thread's single peer and so is one identity.
 */
let nextAuthor = 0;
function agent(over: Partial<RoundItem> = {}): RoundItem {
  nextAuthor += 1;
  return {
    msgId: ulid('A'),
    direction: 'in',
    system: false,
    aiSender: true,
    authorId: ulid(`AG${nextAuthor}`),
    arrivedAt: 1_000,
    ...over,
  };
}

/** The human turn a round answers. */
function turn(msgId = TURN, over: Partial<RoundItem> = {}): RoundItem {
  return {
    msgId,
    direction: 'out',
    system: false,
    aiSender: false,
    authorId: ME,
    arrivedAt: null,
    ...over,
  };
}

/** A resolver standing for "this ref resolved against a row I hold". */
const byRef = (map: Record<number, string>) => (_item: RoundItem, i: number) =>
  map[i] ?? null;

const NONE = () => null;

describe('the constants and the copy deck', () => {
  test('the window is ten minutes and the smallest round is two (R18, R19)', () => {
    expect(ROUND_WINDOW_MS).toBe(10 * 60 * 1000);
    expect(ROUND_MIN_MEMBERS).toBe(2);
  });

  test('the deck says brief, detail and full answer — and never "summary"', () => {
    const every = [
      ROUND_COPY.header(2),
      ROUND_COPY.header(3),
      ROUND_COPY.showDetail,
      ROUND_COPY.hideDetail,
    ];
    for (const line of every) {
      expect(line.toLowerCase()).not.toContain('summary');
      expect(line.toLowerCase()).not.toContain('summar');
    }
    expect(ROUND_COPY.header(3)).toBe('3 agents replied');
    expect(ROUND_COPY.showDetail).toBe('Full answer');
    expect(ROUND_COPY.hideDetail).toBe('Hide full answer');
  });

  test('nothing in the deck claims the relay did anything', () => {
    const joined = [
      ROUND_COPY.header(2),
      ROUND_COPY.showDetail,
      ROUND_COPY.hideDetail,
    ]
      .join(' ')
      .toLowerCase();
    for (const forbidden of [
      'audited',
      'stealth',
      'panic',
      'secret',
      'verified',
      'coordinated',
      'ordered',
    ]) {
      expect(joined).not.toContain(forbidden);
    }
  });
});

describe('keys and ids', () => {
  test('rowKey is the list key both the map and the ranges use', () => {
    expect(rowKey('01ABC', 'in')).toBe('01ABC:in');
    expect(rowKey('01ABC', 'out')).toBe('01ABC:out');
  });

  test('the header testID is derived from the anchor key, and splits at the LAST colon', () => {
    expect(roundHeaderTestID(`${TURN}:out`)).toBe(`round-${TURN}-out`);
    // A peer-chosen msgId holding a colon still names the right side.
    expect(roundHeaderTestID('od:d:in')).toBe('round-od:d-in');
    expect(roundHeaderTestID('nocolon')).toBe('round-nocolon');
  });
});

describe('roomAnchorKey — the side comes from the AUTHOR, never from ofs', () => {
  test("my own turn resolves to my OUT row on the owner's phone", () => {
    expect(roomAnchorKey(TURN, ME)).toBe(`${TURN}:out`);
  });

  test("the SAME ref resolves to an IN row on a co-member's phone", () => {
    // The defect this rule exists for: with an `ofs`-driven lookup this side
    // silently missed and the authoritative arm degraded to the window arm.
    expect(roomAnchorKey(TURN, BEN)).toBe(`${TURN}:in`);
  });

  test('an unknown self id resolves inbound rather than guessing outbound', () => {
    expect(roomAnchorKey(TURN, null)).toBe(`${TURN}:in`);
  });

  test('a ref that is not a round key is refused outright', () => {
    expect(roomAnchorKey('01BARE', ME)).toBeNull();
    expect(roomAnchorKey(`${ME}.${ME}.${ME}`, ME)).toBeNull();
    expect(roomAnchorKey(TURN.toLowerCase(), ME)).toBeNull();
    expect(roomAnchorKey('', ME)).toBeNull();
  });
});

describe('the ref arm', () => {
  test('three answers to one turn are one round of three', () => {
    const items = [
      turn(),
      agent({ msgId: `${CLAUDE}.1` }),
      agent({ msgId: `${CODEX}.1` }),
      agent({ msgId: `${BEN}.1` }),
    ];
    const anchor = `${TURN}:out`;
    expect(
      roundRanges(items, byRef({ 1: anchor, 2: anchor, 3: anchor })),
    ).toEqual([{ anchorKey: anchor, first: 1, last: 3, n: 3 }]);
  });

  test('a round of ONE gets no range at all (R19)', () => {
    const items = [turn(), agent()];
    expect(roundRanges(items, byRef({ 1: `${TURN}:out` }))).toEqual([]);
  });

  test('two different resolving refs inside one run start two rounds', () => {
    const items = [
      turn(),
      agent(),
      agent(),
      turn(TURN2),
      agent(),
      agent(),
    ];
    expect(
      roundRanges(
        items,
        byRef({
          1: `${TURN}:out`,
          2: `${TURN}:out`,
          4: `${TURN2}:out`,
          5: `${TURN2}:out`,
        }),
      ),
    ).toEqual([
      { anchorKey: `${TURN}:out`, first: 1, last: 2, n: 2 },
      { anchorKey: `${TURN2}:out`, first: 4, last: 5, n: 2 },
    ]);
  });

  test('two refs that disagree with NO outbound row between them still split', () => {
    const items = [turn(), agent(), agent(), agent(), agent()];
    expect(
      roundRanges(
        items,
        byRef({
          1: `${TURN}:out`,
          2: `${TURN}:out`,
          3: `${TURN2}:in`,
          4: `${TURN2}:in`,
        }),
      ),
    ).toEqual([
      { anchorKey: `${TURN}:out`, first: 1, last: 2, n: 2 },
      { anchorKey: `${TURN2}:in`, first: 3, last: 4, n: 2 },
    ]);
  });

  test('the ref arm has NO window: two hours apart is still one round', () => {
    const items = [
      turn(),
      agent({ arrivedAt: 1_000 }),
      agent({ arrivedAt: 1_000 + 2 * 60 * 60 * 1000 }),
    ];
    const anchor = `${TURN}:out`;
    expect(roundRanges(items, byRef({ 1: anchor, 2: anchor }))).toEqual([
      { anchorKey: anchor, first: 1, last: 2, n: 2 },
    ]);
  });

  test('the ref arm places a member with NO arrival clock at all', () => {
    const items = [turn(), agent({ arrivedAt: null }), agent({ arrivedAt: null })];
    const anchor = `${TURN}:out`;
    expect(roundRanges(items, byRef({ 1: anchor, 2: anchor }))).toEqual([
      { anchorKey: anchor, first: 1, last: 2, n: 2 },
    ]);
  });

  test('a clockless ref member does not blind the window arm behind it', () => {
    // The defect: the ref arm overwrote the open round's last stamp with a
    // clockless member's null, so the ref-less row behind it had nothing to
    // measure against and fell out of a round the ref arm had already made.
    // The rule is the one stated for the ref-less case — a missing column
    // does not get to destroy grouping — so the last stamp that EXISTED is
    // kept. (A round whose FIRST member is clockless still has no stamp at
    // all, and a later row does not join it: there is nothing to measure,
    // and joining on nothing is the guess this file refuses.)
    const items = [
      turn(),
      agent({ arrivedAt: 1_000 }),
      agent({ arrivedAt: null }),
      agent({ arrivedAt: 1_000 + 60_000 }),
    ];
    expect(
      roundRanges(items, byRef({ 1: `${TURN}:out`, 2: `${TURN}:out` })),
    ).toEqual([{ anchorKey: `${TURN}:out`, first: 1, last: 3, n: 3 }]);
  });

  test('a ref that resolves to NOTHING this phone holds falls to the window arm', () => {
    // The resolver answering null IS "the ref did not resolve" — the ref is
    // matched against rows, never trusted as a label.
    const items = [
      turn(),
      agent({ arrivedAt: 1_000 }),
      agent({ arrivedAt: 2_000 }),
    ];
    expect(roundRanges(items, NONE)).toEqual([
      { anchorKey: `${TURN}:out`, first: 1, last: 2, n: 2 },
    ]);
  });
});

describe('membership and the things that break a run', () => {
  test('a HUMAN reply to the same anchor is not a member, and ends the run', () => {
    const items = [
      turn(),
      agent(),
      agent({ msgId: `${BEN}.1`, aiSender: false }),
      agent(),
    ];
    const anchor = `${TURN}:out`;
    expect(
      roundRanges(items, byRef({ 1: anchor, 2: anchor, 3: anchor })),
    ).toEqual([]);
  });

  test('only INBOUND rows join — my own send is the anchor, never a member', () => {
    const items = [
      turn(),
      agent(),
      { ...turn(ulid('MINE')), arrivedAt: 5_000 },
      agent(),
    ];
    const anchor = `${TURN}:out`;
    expect(
      roundRanges(items, byRef({ 1: anchor, 2: anchor, 3: anchor })),
    ).toEqual([]);
  });

  test('a system row ends a run — an event is not speech', () => {
    const items = [
      turn(),
      agent(),
      agent({ system: true }),
      agent(),
      agent(),
    ];
    const anchor = `${TURN}:out`;
    expect(
      roundRanges(items, byRef({ 1: anchor, 3: anchor, 4: anchor })),
    ).toEqual([{ anchorKey: anchor, first: 3, last: 4, n: 2 }]);
  });
});

describe('the window arm', () => {
  test('bare answers inside the window group under the preceding outbound row', () => {
    const items = [
      turn(),
      agent({ arrivedAt: 1_000 }),
      agent({ arrivedAt: 1_000 + 60_000 }),
      agent({ arrivedAt: 1_000 + 120_000 }),
    ];
    expect(roundRanges(items, NONE)).toEqual([
      { anchorKey: `${TURN}:out`, first: 1, last: 3, n: 3 },
    ]);
  });

  test('an eleven-minute gap breaks it (R18)', () => {
    const items = [
      turn(),
      agent({ arrivedAt: 1_000 }),
      agent({ arrivedAt: 1_000 + 11 * 60_000 }),
    ];
    expect(roundRanges(items, NONE)).toEqual([]);
  });

  test('exactly the window is out; one millisecond under is in', () => {
    const at = (gap: number) => [
      turn(),
      agent({ arrivedAt: 1_000 }),
      agent({ arrivedAt: 1_000 + gap }),
    ];
    expect(roundRanges(at(ROUND_WINDOW_MS), NONE)).toEqual([]);
    expect(roundRanges(at(ROUND_WINDOW_MS - 1), NONE)).toHaveLength(1);
  });

  test('a NEGATIVE gap never groups — skewed arrival clocks are not a run', () => {
    const items = [
      turn(),
      agent({ arrivedAt: 500_000 }),
      agent({ arrivedAt: 400_000 }),
    ];
    expect(roundRanges(items, NONE)).toEqual([]);
  });

  test('a null arrivedAt does not join, and does not break the round around it', () => {
    const items = [
      turn(),
      agent({ arrivedAt: 1_000 }),
      agent({ arrivedAt: null }),
      agent({ arrivedAt: 1_000 + 60_000 }),
    ];
    expect(roundRanges(items, NONE)).toEqual([
      { anchorKey: `${TURN}:out`, first: 1, last: 3, n: 2 },
    ]);
  });

  test('a non-finite arrivedAt is treated as no clock, not as zero', () => {
    const items = [
      turn(),
      agent({ arrivedAt: 1_000 }),
      agent({ arrivedAt: Number.NaN }),
    ];
    expect(roundRanges(items, NONE)).toEqual([]);
  });

  test('with nothing outbound before them there is no round to anchor', () => {
    const items = [agent({ arrivedAt: 1_000 }), agent({ arrivedAt: 2_000 })];
    expect(roundRanges(items, NONE)).toEqual([]);
  });

  test('the window arm re-anchors on the NEXT outbound row', () => {
    const items = [
      turn(),
      agent({ arrivedAt: 1_000 }),
      agent({ arrivedAt: 2_000 }),
      turn(TURN2),
      agent({ arrivedAt: 3_000 }),
      agent({ arrivedAt: 4_000 }),
    ];
    expect(roundRanges(items, NONE)).toEqual([
      { anchorKey: `${TURN}:out`, first: 1, last: 2, n: 2 },
      { anchorKey: `${TURN2}:out`, first: 4, last: 5, n: 2 },
    ]);
  });
});

describe('ref beats window (the mixed case)', () => {
  test('a ref-less answer beside ref-carrying ones joins THEIR anchor', () => {
    // The window arm supplies membership, the ref arm supplies the anchor —
    // note the anchor is the ref's row (:in), not the preceding out row.
    const items = [
      turn(),
      agent({ arrivedAt: 1_000 }),
      agent({ arrivedAt: 2_000 }),
    ];
    expect(roundRanges(items, byRef({ 1: `${TURN}:in` }))).toEqual([
      { anchorKey: `${TURN}:in`, first: 1, last: 2, n: 2 },
    ]);
  });

  test('a ref-less answer out of the window starts its own round instead', () => {
    const items = [
      turn(),
      agent({ arrivedAt: 1_000 }),
      agent({ arrivedAt: 1_000 + 11 * 60_000 }),
      agent({ arrivedAt: 1_000 + 11 * 60_000 + 1_000 }),
    ];
    expect(roundRanges(items, byRef({ 1: `${TURN}:in` }))).toEqual([
      { anchorKey: `${TURN}:out`, first: 2, last: 3, n: 2 },
    ]);
  });
});

describe('n counts AGENTS, not messages', () => {
  /**
   * The header says "N agents replied", so N has to be a count of agents.
   * Counting member ROWS made that sentence false wherever one agent sent
   * two messages inside the window — a turn answer plus a follow-up ping,
   * two status lines — and it made it false BY DEFAULT in a 1:1, where every
   * inbound row is the thread's one peer. A count that overclaims attribution
   * is the one thing this product cannot put on glass.
   */
  test('two answers from ONE author are one agent replying twice — no round', () => {
    const items = [
      turn(),
      agent({ authorId: CLAUDE, arrivedAt: 1_000 }),
      agent({ authorId: CLAUDE, arrivedAt: 1_000 + 60_000 }),
    ];
    expect(roundRanges(items, NONE)).toEqual([]);
  });

  test('the same is true through the REF arm — an authenticated ref is not a second agent', () => {
    const items = [
      turn(),
      agent({ authorId: CLAUDE }),
      agent({ authorId: CLAUDE }),
    ];
    const anchor = `${TURN}:out`;
    expect(roundRanges(items, byRef({ 1: anchor, 2: anchor }))).toEqual([]);
  });

  test('a 1:1 thread has ONE peer, so it has no rounds at all', () => {
    // Every 1:1 row carries no author, because the sender IS the thread's
    // peer. Three bare answers from that one agent are one agent answering
    // three times, and "3 agents replied" would be a false sentence.
    const items = [
      turn(ulid('MINE'), { authorId: null }),
      agent({ authorId: null, arrivedAt: 1_000 }),
      agent({ authorId: null, arrivedAt: 1_000 + 60_000 }),
      agent({ authorId: null, arrivedAt: 1_000 + 120_000 }),
    ];
    expect(roundRanges(items, NONE)).toEqual([]);
  });

  test('three rows from two agents are a round of TWO, spanning all three', () => {
    const items = [
      turn(),
      agent({ authorId: CLAUDE, arrivedAt: 1_000 }),
      agent({ authorId: CODEX, arrivedAt: 1_000 + 60_000 }),
      agent({ authorId: CLAUDE, arrivedAt: 1_000 + 120_000 }),
    ];
    expect(roundRanges(items, NONE)).toEqual([
      { anchorKey: `${TURN}:out`, first: 1, last: 3, n: 2 },
    ]);
  });
});
