/**
 * ROUNDS ON GLASS (§3.2) — the round header, the full-answer
 * disclosure, and the join the screen feeds them.
 *
 * A ROUND is one human turn plus the agents' answers to it. Nothing about it
 * is on the wire: there is no round id, no round object and no server change.
 * The join key is the §5.3 reply reference that already ships, RESOLVED
 * AGAINST ROWS THIS PHONE HOLDS — which is what makes it authenticated rather
 * than sender-chosen. These cases pin the screen's half of that: which rows
 * it hands `rounds.ts`, where the header lands, and what the disclosure
 * reveals. `rounds.test.ts` pins the priority order itself.
 *
 * THE CASE THAT CANNOT BE SKIPPED is the last one: the same round seen from a
 * NON-OWNER co-member's device, where the human turn is an INBOUND row. The
 * quote box's `ofs`-driven lookup resolves only on the owner's phone; every
 * owner-side case here stays green while that arm silently degrades to the
 * window arm. It is the only case in this file that can see it.
 *
 * Harness copied from ChatThread.aimarker.test.tsx (`installDb`,
 * `renderThread`, the `row()` factory), plus ChatThread.stream.test.tsx's
 * `renderedText` flattener and host-elements-only finder, plus a MOVING fake
 * clock (the frozen-clock ruling): the unread window reads `Date.now()` twice
 * for one open and a frozen reading would hide the arithmetic between them.
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import * as db from '../src/db';
import { ROUND_COPY } from '../src/rounds';
import { ChatThreadScreen } from '../src/screens/ChatThreadScreen';

interface FakeDb {
  name: string;
  execute: jest.Mock;
  close: jest.Mock;
}
const sqlite = (
  jest.requireMock('@op-engineering/op-sqlite') as {
    __sqlite: { instances: Map<string, FakeDb>; reset: () => void };
  }
).__sqlite;

const ulid = (tag: string) => (tag + '0'.repeat(26)).slice(0, 26);
const ROOM = ulid('R00MRND');
const ME = ulid('ME1');
const BEN = ulid('BEN'); // a second HUMAN, and the co-member's own id
const CLAUDE = ulid('CLAWDE');
const CODEX = ulid('CDEX');
const GEMINI = ulid('GEM');
const AGENT_1TO1 = ulid('SBOT');

const T0 = new Date('2026-09-03T09:00:00').getTime();
/** The human turn every room case below answers. */
const TURN = `${ME}.${ulid('M1')}`;

const NAME_ROWS = [
  { peerId: CLAUDE, displayName: 'Claude · laptop', localName: null },
  { peerId: CODEX, displayName: 'Codex', localName: null },
  { peerId: GEMINI, displayName: 'Gemini', localName: null },
  { peerId: BEN, displayName: 'Ben', localName: null },
  { peerId: AGENT_1TO1, displayName: 'Codex', localName: null },
];

const SLOT_ROWS = [
  { memberId: ME, writerId: ME, seq: 1, state: 'in' },
  { memberId: CLAUDE, writerId: ME, seq: 1, state: 'in' },
  { memberId: CODEX, writerId: ME, seq: 1, state: 'in' },
  { memberId: GEMINI, writerId: ME, seq: 1, state: 'in' },
  { memberId: BEN, writerId: ME, seq: 1, state: 'in' },
];

type Row = Record<string, unknown>;

function installDb(
  messageRows: Row[],
  opts: {
    machines?: string[];
    room?: boolean;
    /** Whose phone this is — the co-member case flips it to BEN. */
    self?: string;
    /** The chat's stamp BEFORE this open; absent means no chat row at all,
     * which is how every case below keeps the unread divider off glass. */
    lastOpenedAt?: number;
  } = {},
) {
  const machines = opts.machines ?? [];
  const inRoom = opts.room ?? true;
  const self = opts.self ?? ME;
  const instance = sqlite.instances.get('tacendum.sqlite')!;
  const base = instance.execute.getMockImplementation()!;
  instance.execute.mockImplementation(
    async (sql: string, params?: unknown[]) => {
      const s = String(sql);
      if (s.includes('FROM messages')) return { rows: messageRows };
      if (s.includes('FROM machine_peers')) {
        return { rows: machines.map(peerId => ({ peerId })) };
      }
      if (s.includes('SELECT groupId, ownerId, name FROM groups')) {
        return inRoom && params?.[0] === ROOM
          ? { rows: [{ groupId: ROOM, ownerId: ME, name: 'Crew' }] }
          : { rows: [] };
      }
      if (s.includes('FROM group_members')) {
        return inRoom && params?.[0] === ROOM ? { rows: SLOT_ROWS } : { rows: [] };
      }
      if (s.includes('FROM chats') && s.includes('ORDER BY')) {
        return { rows: NAME_ROWS };
      }
      // getChat: the unread window's lower bound. Absent by default.
      if (s.includes('FROM chats WHERE peerId = ?')) {
        return opts.lastOpenedAt === undefined
          ? { rows: [] }
          : {
              rows: [
                {
                  peerId: params?.[0],
                  displayName: 'Crew',
                  localName: null,
                  lastOpenedAt: opts.lastOpenedAt,
                },
              ],
            };
      }
      if (s.includes('FROM profile')) {
        return {
          rows: [
            { key: 'userId', value: self },
            { key: 'registrationId', value: '7' },
          ],
        };
      }
      return base(sql, params);
    },
  );
}

async function renderThread(
  peerId: string,
): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <ChatThreadScreen
        peerId={peerId}
        onBack={jest.fn()}
        onOpenPeerProfile={jest.fn()}
        onOpenPhoto={jest.fn()}
      />,
    );
  });
  await ReactTestRenderer.act(async () => {});
  await ReactTestRenderer.act(async () => {});
  return tree;
}

const row = (r: Row): Row => ({
  peerId: ROOM,
  direction: 'in',
  status: 'received',
  deletedAt: null,
  ...r,
});

/** An agent's round answer: a `reply` quoting the human turn, brief + detail
 * in one message under one sender — exactly the §3.2 composition. */
function answer(
  author: string,
  m: string,
  brief: string,
  detail: string | null,
  over: Row = {},
): Row {
  return row({
    msgId: `${author}.${ulid(m)}`,
    authorId: author,
    ai: 1,
    body: JSON.stringify({
      tcm: 'reply',
      ref: TURN,
      ofs: false,
      text: brief,
      ...(detail === null ? {} : { d: detail }),
      ai: true,
    }),
    ...over,
  });
}

/** Every string on glass, flattened (ChatThread.stream.test.tsx). */
function renderedText(tree: ReactTestRenderer.ReactTestRenderer): string {
  return tree.root
    .findAllByType(require('react-native').Text)
    .map(n =>
      Array.isArray(n.props.children)
        ? n.props.children
            .map((c: unknown) => (typeof c === 'string' ? c : ''))
            .join('')
        : String(n.props.children ?? ''),
    )
    .join('\n');
}

/** Host elements only (`type` is a string): a composite and its host node
 * both carry the testID, and counting both would double every hit. */
function hosts(tree: ReactTestRenderer.ReactTestRenderer, id: string) {
  return tree.root.findAll(
    n => typeof n.type === 'string' && n.props.testID === id,
  );
}

/** A round header's LIST KEY. Namespaced by the anchor and identified by the
 * FIRST MEMBER, because two rounds can share one anchor and a keyExtractor
 * must be unique per ITEM (ChatThreadScreen:roundPlaceholderRow). */
const roundKeyFor = (anchorKey: string, firstMsgId: string) =>
  `round:${anchorKey}:${firstMsgId}:in`;

/** The list's keys, in list order — where the header actually landed. */
function listKeys(tree: ReactTestRenderer.ReactTestRenderer): string[] {
  const list = tree.root.findAll(
    n =>
      n.props.testID === 'thread-list' &&
      typeof n.props.keyExtractor === 'function',
  )[0]!;
  return (list.props.data as unknown[]).map((item, i) =>
    (list.props.keyExtractor as (it: unknown, ix: number) => string)(item, i),
  );
}

async function press(
  tree: ReactTestRenderer.ReactTestRenderer,
  id: string,
): Promise<void> {
  await ReactTestRenderer.act(async () => {
    tree.root.findAll(n => n.props.testID === id && n.props.onPress)[0]!
      .props.onPress();
  });
}

let clock = T0;

beforeEach(async () => {
  // MOVING, never frozen: one open reads Date.now() for the divider's upper
  // bound and again for the stamp it writes, and a frozen reading would hide
  // every ordering fact between them.
  clock = T0;
  jest.spyOn(Date, 'now').mockImplementation(() => (clock += 20));
  await db.close();
  sqlite.reset();
  db.setWorkspace('real');
  await db.initDb();
});

afterEach(async () => {
  jest.restoreAllMocks();
  await db.close();
});

describe('the header', () => {
  test('three answers to one human turn render ONE header reading "3 agents replied"', async () => {
    installDb([
      row({ msgId: TURN, direction: 'out', status: 'sent', authorId: ME, ts: T0, body: 'Where are we?' }),
      answer(CLAUDE, 'A1', 'Two findings.', 'The first is the cursor guard.', { ts: T0 + 1_000, arrivedAt: T0 + 1_000 }),
      answer(CODEX, 'A2', 'One blocker.', 'The blocker is the wire budget.', { ts: T0 + 2_000, arrivedAt: T0 + 2_000 }),
      answer(GEMINI, 'A3', 'Nothing to add.', 'Read both and agree with them.', { ts: T0 + 3_000, arrivedAt: T0 + 3_000 }),
    ]);
    const tree = await renderThread(ROOM);
    const header = hosts(tree, `round-${TURN}-out`);
    expect(header).toHaveLength(1);
    expect(header[0]!.props.accessibilityLabel).toBe(ROUND_COPY.header(3));
    expect(renderedText(tree)).toContain(ROUND_COPY.header(3));
    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('the header sits before the FIRST answer, and after the turn it answers', async () => {
    installDb([
      row({ msgId: TURN, direction: 'out', status: 'sent', authorId: ME, ts: T0, body: 'Where are we?' }),
      answer(CLAUDE, 'A1', 'Two findings.', null, { ts: T0 + 1_000, arrivedAt: T0 + 1_000 }),
      answer(CODEX, 'A2', 'One blocker.', null, { ts: T0 + 2_000, arrivedAt: T0 + 2_000 }),
    ]);
    const tree = await renderThread(ROOM);
    const keys = listKeys(tree);
    expect(keys).toEqual([
      `${TURN}:out`,
      roundKeyFor(`${TURN}:out`, `${CLAUDE}.${ulid('A1')}`),
      `${CLAUDE}.${ulid('A1')}:in`,
      `${CODEX}.${ulid('A2')}:in`,
    ]);
    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('a round of ONE gets no header at all (R19)', async () => {
    installDb([
      row({ msgId: TURN, direction: 'out', status: 'sent', authorId: ME, ts: T0, body: 'Where are we?' }),
      answer(CLAUDE, 'A1', 'Two findings.', 'The whole answer.', { ts: T0 + 1_000, arrivedAt: T0 + 1_000 }),
    ]);
    const tree = await renderThread(ROOM);
    expect(hosts(tree, `round-${TURN}-out`)).toHaveLength(0);
    expect(renderedText(tree)).not.toContain('replied');
    // The disclosure is per MESSAGE, so it is still there.
    expect(hosts(tree, `detail-${CLAUDE}.${ulid('A1')}`)).toHaveLength(1);
    await ReactTestRenderer.act(() => tree.unmount());
  });

  test("a HUMAN's reply to the same turn is not a member", async () => {
    installDb([
      row({ msgId: TURN, direction: 'out', status: 'sent', authorId: ME, ts: T0, body: 'Where are we?' }),
      answer(CLAUDE, 'A1', 'Two findings.', null, { ts: T0 + 1_000, arrivedAt: T0 + 1_000 }),
      // Ben quotes the same turn. Same ref, no `ai` column, no record: he
      // never joins, and he ends the run behind him.
      row({
        msgId: `${BEN}.${ulid('B1')}`,
        authorId: BEN,
        ts: T0 + 2_000,
        arrivedAt: T0 + 2_000,
        body: JSON.stringify({ tcm: 'reply', ref: TURN, ofs: false, text: 'me too' }),
      }),
      answer(CODEX, 'A2', 'One blocker.', null, { ts: T0 + 3_000, arrivedAt: T0 + 3_000 }),
    ]);
    const tree = await renderThread(ROOM);
    expect(hosts(tree, `round-${TURN}-out`)).toHaveLength(0);
    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('the unread divider wins the slot when both land on the same row', async () => {
    installDb(
      [
        row({ msgId: TURN, direction: 'out', status: 'sent', authorId: ME, ts: T0 - 10_000, body: 'Where are we?' }),
        answer(CLAUDE, 'A1', 'Two findings.', null, { ts: T0 - 5_000, arrivedAt: T0 - 5_000 }),
        answer(CODEX, 'A2', 'One blocker.', null, { ts: T0 - 4_000, arrivedAt: T0 - 4_000 }),
      ],
      { lastOpenedAt: T0 - 60_000 },
    );
    const tree = await renderThread(ROOM);
    const keys = listKeys(tree);
    // Divider, THEN header, THEN the row the divider points at — a collapsed
    // round must never hide the first thing a person came back to read.
    expect(keys.indexOf('unread-divider')).toBeGreaterThanOrEqual(0);
    const headerKey = roundKeyFor(`${TURN}:out`, `${CLAUDE}.${ulid('A1')}`);
    expect(keys.indexOf('unread-divider')).toBeLessThan(
      keys.indexOf(headerKey),
    );
    expect(keys.indexOf(headerKey)).toBeLessThan(
      keys.indexOf(`${CLAUDE}.${ulid('A1')}:in`),
    );
    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('skewed sender clocks interleave and the round leaves the order alone', async () => {
    // Three agents, three clocks. The list is ordered by ts as it always was;
    // the round pass reads that order and never re-sorts it.
    installDb([
      row({ msgId: TURN, direction: 'out', status: 'sent', authorId: ME, ts: T0, body: 'Where are we?' }),
      answer(GEMINI, 'A3', 'Nothing to add.', null, { ts: T0 + 1_000, arrivedAt: T0 + 3_000 }),
      answer(CLAUDE, 'A1', 'Two findings.', null, { ts: T0 + 2_000, arrivedAt: T0 + 1_000 }),
      answer(CODEX, 'A2', 'One blocker.', null, { ts: T0 + 3_000, arrivedAt: T0 + 2_000 }),
    ]);
    const tree = await renderThread(ROOM);
    expect(listKeys(tree)).toEqual([
      `${TURN}:out`,
      roundKeyFor(`${TURN}:out`, `${GEMINI}.${ulid('A3')}`),
      `${GEMINI}.${ulid('A3')}:in`,
      `${CLAUDE}.${ulid('A1')}:in`,
      `${CODEX}.${ulid('A2')}:in`,
    ]);
    await ReactTestRenderer.act(() => tree.unmount());
  });
});

describe('the full answer', () => {
  const A1 = `${CLAUDE}.${ulid('A1')}`;
  const A2 = `${CODEX}.${ulid('A2')}`;
  const BRIEF_1 = 'Two findings.';
  const DETAIL_1 = 'The cursor guard writes the round key before the spawn.';
  const DETAIL_2 = 'The wire budget holds only once controls are normalised.';

  function installRound() {
    installDb([
      row({ msgId: TURN, direction: 'out', status: 'sent', authorId: ME, ts: T0, body: 'Where are we?' }),
      answer(CLAUDE, 'A1', BRIEF_1, DETAIL_1, { ts: T0 + 1_000, arrivedAt: T0 + 1_000 }),
      answer(CODEX, 'A2', 'One blocker.', DETAIL_2, { ts: T0 + 2_000, arrivedAt: T0 + 2_000 }),
    ]);
  }

  test('the BRIEF is on glass and the detail is collapsed', async () => {
    installRound();
    const tree = await renderThread(ROOM);
    const text = renderedText(tree);
    expect(text).toContain(BRIEF_1);
    expect(text).not.toContain(DETAIL_1);
    expect(text).toContain(ROUND_COPY.showDetail);
    expect(hosts(tree, `detail-${A1}`)).toHaveLength(1);
    expect(hosts(tree, `detail-body-${A1}`)).toHaveLength(0);
    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('tapping one row reveals THAT row and only that row', async () => {
    installRound();
    const tree = await renderThread(ROOM);
    await press(tree, `detail-${A1}`);
    expect(hosts(tree, `detail-body-${A1}`)).toHaveLength(1);
    expect(hosts(tree, `detail-body-${A2}`)).toHaveLength(0);
    const text = renderedText(tree);
    expect(text).toContain(DETAIL_1);
    expect(text).not.toContain(DETAIL_2);
    // And the brief did not go anywhere: they are one message.
    expect(text).toContain(BRIEF_1);
    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('tapping again puts it away, and the label says which way it goes', async () => {
    installRound();
    const tree = await renderThread(ROOM);
    const toggle = () =>
      tree.root.findAll(
        n => typeof n.type === 'string' && n.props.testID === `detail-${A1}`,
      )[0]!;
    expect(toggle().props.accessibilityLabel).toBe(ROUND_COPY.showDetail);
    expect(toggle().props.accessibilityState).toEqual({ expanded: false });
    await press(tree, `detail-${A1}`);
    expect(toggle().props.accessibilityLabel).toBe(ROUND_COPY.hideDetail);
    expect(toggle().props.accessibilityState).toEqual({ expanded: true });
    await press(tree, `detail-${A1}`);
    expect(hosts(tree, `detail-body-${A1}`)).toHaveLength(0);
    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('a message with no detail grows no disclosure', async () => {
    installDb([
      row({ msgId: TURN, direction: 'out', status: 'sent', authorId: ME, ts: T0, body: 'Where are we?' }),
      answer(CLAUDE, 'A1', 'Two findings.', null, { ts: T0 + 1_000, arrivedAt: T0 + 1_000 }),
    ]);
    const tree = await renderThread(ROOM);
    expect(hosts(tree, `detail-${A1}`)).toHaveLength(0);
    expect(renderedText(tree)).not.toContain(ROUND_COPY.showDetail);
    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('the bubble carries the disclosure as an accessibility ACTION — the bubble is one element', async () => {
    installRound();
    const tree = await renderThread(ROOM);
    const bubble = tree.root.findAll(
      n => n.props.testID === `msg-${A1}` && n.props.accessibilityActions,
    )[0]!;
    const actions = bubble.props.accessibilityActions as {
      name: string;
      label: string;
    }[];
    const detail = actions.find(a => a.name === 'detail');
    expect(detail?.label).toBe(ROUND_COPY.showDetail);
    await ReactTestRenderer.act(async () => {
      bubble.props.onAccessibilityAction({
        nativeEvent: { actionName: 'detail' },
      });
    });
    expect(hosts(tree, `detail-body-${A1}`)).toHaveLength(1);
    await ReactTestRenderer.act(() => tree.unmount());
  });
});

describe('the window arm — the bare `msg` answers a round still has to hold', () => {
  /**
   * The window arm's subject is a ROOM whose agents answer with bare `msg`
   * rows carrying no reply ref: distinct authors, this phone's own arrival
   * clock, and the nearest preceding outbound row for an anchor.
   *
   * It is NOT a 1:1 — the last case here pins why. Every 1:1 inbound row is
   * the thread's ONE peer, so two of them are one agent answering twice, and
   * a header reading "2 agents replied" over them would be a false sentence
   * about who spoke. The count is of AGENTS (rounds.ts, `authorIdentity`).
   */
  const OUT = ulid('MINE1');

  function roomTurn(rows: Row[], opts: { machines?: string[] } = {}) {
    installDb(
      [
        row({
          msgId: OUT,
          direction: 'out',
          status: 'sent',
          authorId: ME,
          ts: T0,
          body: 'status?',
        }),
        ...rows,
      ],
      opts,
    );
  }

  /** A bare `msg` answer: no ref at all, so only the window arm can place it. */
  const bare = (
    author: string,
    m: string,
    text: string,
    arrivedAt: number | null,
    ts: number,
  ): Row =>
    row({
      msgId: `${author}.${ulid(m)}`,
      authorId: author,
      ai: 1,
      body: JSON.stringify({ tcm: 'msg', text, ai: true }),
      ts,
      arrivedAt,
    });

  test('two agents answering inside the window are one round under my own turn', async () => {
    roomTurn([
      bare(CLAUDE, 'B1', 'build is green', T0 + 60_000, T0 + 60_000),
      bare(CODEX, 'B2', 'tests are green', T0 + 120_000, T0 + 120_000),
    ]);
    const tree = await renderThread(ROOM);
    const header = hosts(tree, `round-${OUT}-out`);
    expect(header).toHaveLength(1);
    expect(header[0]!.props.accessibilityLabel).toBe(ROUND_COPY.header(2));
    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('an eleven-minute gap breaks it (R18)', async () => {
    roomTurn([
      bare(CLAUDE, 'B1', 'build is green', T0 + 60_000, T0 + 60_000),
      bare(
        CODEX,
        'B2',
        'tests are green',
        T0 + 60_000 + 11 * 60_000,
        T0 + 60_000 + 11 * 60_000,
      ),
    ]);
    const tree = await renderThread(ROOM);
    expect(hosts(tree, `round-${OUT}-out`)).toHaveLength(0);
    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('a null arrivedAt does not join the window arm — no grouping on a guess', async () => {
    roomTurn([
      bare(CLAUDE, 'B1', 'build is green', T0 + 60_000, T0 + 60_000),
      bare(GEMINI, 'B2', 'no clock on this one', null, T0 + 90_000),
      bare(CODEX, 'B3', 'tests are green', T0 + 120_000, T0 + 120_000),
    ]);
    const tree = await renderThread(ROOM);
    const header = hosts(tree, `round-${OUT}-out`);
    expect(header).toHaveLength(1);
    // Two agents, not three: the clockless row is on glass and is not counted.
    expect(header[0]!.props.accessibilityLabel).toBe(ROUND_COPY.header(2));
    expect(renderedText(tree)).toContain('no clock on this one');
    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('TWO RUNS UNDER ONE ANCHOR are two headers with two DISTINCT list keys', async () => {
    // `close()` drops the open round on the gap and the next answer re-opens
    // under the same unchanged window anchor, so one outbound row carries two
    // rounds. The anchor key alone is therefore not unique per item, and two
    // identical keyExtractor values are one VirtualizedList cell serving two
    // different headers.
    roomTurn([
      bare(CLAUDE, 'B1', 'build is green', T0 + 60_000, T0 + 60_000),
      bare(CODEX, 'B2', 'tests are green', T0 + 120_000, T0 + 120_000),
      bare(CLAUDE, 'B3', 'deploy is out', T0 + 13 * 60_000, T0 + 13 * 60_000),
      bare(CODEX, 'B4', 'smoke is clean', T0 + 14 * 60_000, T0 + 14 * 60_000),
    ]);
    const tree = await renderThread(ROOM);
    expect(hosts(tree, `round-${OUT}-out`)).toHaveLength(2);
    const keys = listKeys(tree);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.filter(k => k.startsWith('round:'))).toEqual([
      roundKeyFor(`${OUT}:out`, `${CLAUDE}.${ulid('B1')}`),
      roundKeyFor(`${OUT}:out`, `${CLAUDE}.${ulid('B3')}`),
    ]);
    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('a 1:1 has ONE peer, so two answers from it are never "2 agents replied"', async () => {
    // The default attend configuration, and the reason the count is of
    // AUTHORS: a turn answer and a follow-up ping from the same agent are one
    // agent answering twice. Both messages are on glass; no header claims
    // two agents spoke.
    installDb(
      [
        {
          peerId: AGENT_1TO1,
          direction: 'out',
          status: 'sent',
          deletedAt: null,
          msgId: OUT,
          body: 'status?',
          ts: T0,
          authorId: null,
        },
        {
          peerId: AGENT_1TO1,
          direction: 'in',
          status: 'received',
          deletedAt: null,
          msgId: ulid('B1'),
          body: JSON.stringify({ tcm: 'msg', text: 'build is green', ai: true }),
          ts: T0 + 60_000,
          arrivedAt: T0 + 60_000,
          authorId: null,
          ai: 1,
        },
        {
          peerId: AGENT_1TO1,
          direction: 'in',
          status: 'received',
          deletedAt: null,
          msgId: ulid('B2'),
          body: JSON.stringify({ tcm: 'msg', text: 'tests are green', ai: true }),
          ts: T0 + 120_000,
          arrivedAt: T0 + 120_000,
          authorId: null,
          ai: 1,
        },
      ],
      { room: false, machines: [AGENT_1TO1] },
    );
    const tree = await renderThread(AGENT_1TO1);
    expect(hosts(tree, `round-${OUT}-out`)).toHaveLength(0);
    const text = renderedText(tree);
    expect(text).not.toContain('replied');
    expect(text).toContain('build is green');
    expect(text).toContain('tests are green');
    await ReactTestRenderer.act(() => tree.unmount());
  });
});

describe("a co-member's device — the ref arm's own failure mode", () => {
  /**
   * THE CASE THE OWNER-SIDE SUITE CANNOT SEE. Ben is in the room; the human
   * turn is his ROOM-MATE's, so on his phone it is an INBOUND row. The ref
   * `${ME}.${m}` must resolve to `${TURN}:in`.
   *
   * `ChatThreadScreen`'s quote resolver would ask for `${TURN}:out` here
   * (`ofs:false` on an inbound reply reads as "theirs" and looks up the out
   * side), miss, and hand the round to the window arm. So the arrival clocks
   * below are deliberately ELEVEN MINUTES apart: the window arm cannot make
   * this round, and only the ref arm can.
   */
  test('the round still resolves, and it resolves by REF and not by the clock', async () => {
    installDb(
      [
        row({ msgId: TURN, authorId: ME, ts: T0, arrivedAt: T0, body: 'Where are we?' }),
        answer(CLAUDE, 'A1', 'Two findings.', 'The whole finding.', {
          ts: T0 + 1_000,
          arrivedAt: T0 + 1_000,
        }),
        answer(CODEX, 'A2', 'One blocker.', null, {
          ts: T0 + 2_000,
          arrivedAt: T0 + 1_000 + 11 * 60_000,
        }),
      ],
      { self: BEN },
    );
    const tree = await renderThread(ROOM);
    const header = hosts(tree, `round-${TURN}-in`);
    expect(header).toHaveLength(1);
    expect(header[0]!.props.accessibilityLabel).toBe(ROUND_COPY.header(2));
    // The out-side key is nobody's anchor on this phone.
    expect(hosts(tree, `round-${TURN}-out`)).toHaveLength(0);
    // And the disclosure works the same on a device that owns nothing here.
    await press(tree, `detail-${CLAUDE}.${ulid('A1')}`);
    expect(renderedText(tree)).toContain('The whole finding.');
    await ReactTestRenderer.act(() => tree.unmount());
  });
});
