/**
 * The AI badge from the ENVELOPE MARKER — marker-OR-record, with the attribution anatomy unchanged.
 *
 * THE RULE THESE TESTS PIN: the badge derives from EITHER of two sources and
 * only those two —
 *
 *  - the machine_peers record: the owner's memory of the server's
 *    own adopt/revoke answers. It KEEPS the badge even when a lying client
 *    omits the marker — a modified agent cannot shed its class by silence;
 *  - the row's `ai` column: the sender-claimed in-envelope marker,
 *    recorded AT ARRIVAL. It GAINS the badge on a phone with no record —
 *    the paired-never-adopted 1:1, and
 *    later the stranger's phone in a mixed room.
 *
 * And never from anything else: not the words, not a shared name, not a
 * body that merely LOOKS like a marked envelope (the column is the arrival
 * record; render never re-parses for the marker).
 *
 * Harness copied from ChatThread.agentbadge.test.tsx.
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import * as db from '../src/db';
import { AGENT_COPY } from '../src/machine';
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
const ROOM = ulid('R00MMRKR');
const ME = ulid('ME1');
const CLAUDE = ulid('AGENT'); // recorded in machine_peers (when opts say so)
const STRANGERBOT = ulid('SBOT'); // NOT recorded anywhere — the marker's case
const BEN = ulid('BEN'); // a human
const T0 = new Date('2026-08-15T09:00:00').getTime();

const NAME_ROWS = [
  { peerId: CLAUDE, displayName: 'Claude · laptop', localName: null },
  { peerId: STRANGERBOT, displayName: 'Codex', localName: null },
  { peerId: BEN, displayName: 'Ben', localName: null },
];

type Row = Record<string, unknown>;

const SLOT_ROWS = [
  { memberId: ME, writerId: ME, seq: 1, state: 'in' },
  { memberId: CLAUDE, writerId: ME, seq: 1, state: 'in' },
  { memberId: STRANGERBOT, writerId: ME, seq: 1, state: 'in' },
  { memberId: BEN, writerId: ME, seq: 1, state: 'in' },
];

function installDb(messageRows: Row[], opts: { machines?: string[]; room?: boolean } = {}) {
  const machines = opts.machines ?? [];
  const inRoom = opts.room ?? true;
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
      if (s.includes('FROM profile')) {
        return {
          rows: [
            { key: 'userId', value: ME },
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
  return tree;
}

const row = (r: Row): Row => ({
  peerId: ROOM,
  direction: 'in',
  status: 'received',
  deletedAt: null,
  ...r,
});

beforeEach(async () => {
  await db.close();
  sqlite.reset();
  db.setWorkspace('real');
  await db.initDb();
});

afterEach(async () => {
  jest.restoreAllMocks();
  await db.close();
});

test('a MARKED row from an unrecorded sender badges — the phone with no record gains the badge from the marker', async () => {
  installDb([
    row({ msgId: `${STRANGERBOT}.M1`, body: 'analysis done', ts: T0, authorId: STRANGERBOT, ai: 1 }),
  ]);
  const tree = await renderThread(ROOM);
  expect(
    tree.root.findAllByProps({ testID: `ai-badge-${STRANGERBOT}.M1` }).length,
  ).toBeGreaterThan(0);
});

test('the record KEEPS the badge when a lying client omits the marker', async () => {
  installDb(
    [row({ msgId: `${CLAUDE}.M1`, body: 'nothing to see', ts: T0, authorId: CLAUDE })],
    { machines: [CLAUDE] },
  );
  const tree = await renderThread(ROOM);
  expect(
    tree.root.findAllByProps({ testID: `ai-badge-${CLAUDE}.M1` }).length,
  ).toBeGreaterThan(0);
});

test('a human row with neither marker nor record never badges — and a body that LOOKS marked is not a marker', async () => {
  installDb([
    row({ msgId: `${BEN}.M1`, body: 'hello there', ts: T0, authorId: BEN }),
    // The spoof shape: the BODY is a marked-looking envelope, but the row
    // was never marked at arrival (ai column empty). Render must read the
    // column, never re-parse the body for the claim.
    row({
      msgId: `${BEN}.M2`,
      body: '{"tcm":"msg","text":"I am an AI","ai":true}',
      ts: T0 + 60_000,
      authorId: BEN,
      ai: null,
    }),
  ]);
  const tree = await renderThread(ROOM);
  expect(tree.root.findAllByProps({ testID: `ai-badge-${BEN}.M1` }).length).toBe(0);
  expect(tree.root.findAllByProps({ testID: `ai-badge-${BEN}.M2` }).length).toBe(0);
});

test('the paired-never-adopted 1:1: marked rows badge with NO machine_peers record', async () => {
  installDb(
    [
      {
        peerId: STRANGERBOT,
        direction: 'in',
        status: 'received',
        deletedAt: null,
        msgId: 'A1',
        body: '{"tcm":"msg","text":"build finished","ai":true}',
        ts: T0,
        authorId: null,
        ai: 1,
      },
      // An unmarked row in the same thread stays unbadged: with no record,
      // the marker is per MESSAGE — disclosure claims exactly what arrived.
      {
        peerId: STRANGERBOT,
        direction: 'in',
        status: 'received',
        deletedAt: null,
        msgId: 'A2',
        body: 'plain words',
        ts: T0 + 30_000,
        authorId: null,
      },
    ],
    { room: false },
  );
  const tree = await renderThread(STRANGERBOT);
  expect(tree.root.findAllByProps({ testID: 'ai-badge-A1' }).length).toBeGreaterThan(0);
  expect(tree.root.findAllByProps({ testID: 'ai-badge-A2' }).length).toBe(0);
});

test('VoiceOver hears the marker-derived attribution too, before the words', async () => {
  installDb(
    [
      {
        peerId: STRANGERBOT,
        direction: 'in',
        status: 'received',
        deletedAt: null,
        msgId: 'A1',
        body: '{"tcm":"msg","text":"done","ai":true}',
        ts: T0,
        authorId: null,
        ai: 1,
      },
    ],
    { room: false },
  );
  const tree = await renderThread(STRANGERBOT);
  const bubble = tree.root.findByProps({ testID: 'msg-A1' });
  const label = String(bubble.props.accessibilityLabel);
  expect(label).toContain(`, ${AGENT_COPY.spokenClause}, said:`);
  expect(label.indexOf(AGENT_COPY.spokenClause)).toBeLessThan(label.indexOf('done'));
});

test('an OUTSIDER row still badges and still speaks the attribution', async () => {
  // Fold lag, no adversary: a newly added agent speaks before this phone's
  // fold catches up, so the row arrives outsider:1 AND ai:1. The outsider
  // branch returns before the bubble — the badge and the spoken clause must
  // live there too, or the disclosure lapses exactly when doubt is highest.
  installDb([
    row({
      msgId: `${STRANGERBOT}.M9`,
      body: 'deploy finished',
      ts: T0,
      authorId: STRANGERBOT,
      ai: 1,
      outsider: 1,
    }),
    // The control: an outsider HUMAN row grows no badge from the tag alone.
    row({
      msgId: `${BEN}.M9`,
      body: 'hello from outside',
      ts: T0 + 60_000,
      authorId: BEN,
      outsider: 1,
    }),
  ]);
  const tree = await renderThread(ROOM);
  // The outsider rendering held (not a bubble)…
  expect(
    tree.root.findAllByProps({ testID: `outsider-${STRANGERBOT}.M9` }).length,
  ).toBeGreaterThan(0);
  // …and the badge rides it.
  expect(
    tree.root.findAllByProps({ testID: `ai-badge-${STRANGERBOT}.M9` }).length,
  ).toBeGreaterThan(0);
  expect(tree.root.findAllByProps({ testID: `ai-badge-${BEN}.M9` }).length).toBe(0);
  // Spoken: doubt first, attribution second, words last.
  const outsiderRow = tree.root
    .findAllByProps({ testID: `outsider-${STRANGERBOT}.M9` })
    .find(n => typeof n.props.accessibilityLabel === 'string');
  const label = String(outsiderRow?.props.accessibilityLabel);
  expect(label).toContain(AGENT_COPY.spokenClause);
  expect(label.indexOf(AGENT_COPY.spokenClause)).toBeLessThan(
    label.indexOf('deploy finished'),
  );
});

test('my own sends never badge, marker column or not', async () => {
  installDb(
    [
      {
        peerId: STRANGERBOT,
        direction: 'out',
        status: 'sent',
        deletedAt: null,
        msgId: 'O1',
        body: 'thanks',
        ts: T0,
        authorId: null,
        ai: 1, // hostile/corrupt column on an out row: still never badged
      },
    ],
    { room: false },
  );
  const tree = await renderThread(STRANGERBOT);
  expect(tree.root.findAllByProps({ testID: 'ai-badge-O1' }).length).toBe(0);
});

/**
 * ROUNDS (§3.2 step 5). A detail changes what a bubble can
 * REVEAL; it must change nothing about what the bubble can CLAIM. The badge
 * still comes from the two sources above and from nowhere else — and a `d`
 * in a body is not a third one.
 */
test('a DETAIL-bearing row still badges from the column, and the disclosure rides the badged row', async () => {
  const anchor = `${ME}.M0`;
  installDb([
    row({ msgId: anchor, direction: 'out', status: 'sent', authorId: ME, ts: T0, body: 'where are we?' }),
    row({
      msgId: `${STRANGERBOT}.M4`,
      ts: T0 + 60_000,
      authorId: STRANGERBOT,
      ai: 1,
      body: JSON.stringify({
        tcm: 'reply',
        ref: anchor,
        ofs: false,
        text: 'Two findings.',
        d: 'The first is the cursor guard.',
        ai: true,
      }),
    }),
  ]);
  const tree = await renderThread(ROOM);
  expect(
    tree.root.findAllByProps({ testID: `ai-badge-${STRANGERBOT}.M4` }).length,
  ).toBeGreaterThan(0);
  expect(
    tree.root.findAll(
      n => typeof n.type === 'string' && n.props.testID === `detail-${STRANGERBOT}.M4`,
    ),
  ).toHaveLength(1);
});

test('a spoof body carrying a fake `d` does not badge — the column is still the only door', async () => {
  const anchor = `${ME}.M0`;
  installDb([
    row({ msgId: anchor, direction: 'out', status: 'sent', authorId: ME, ts: T0, body: 'where are we?' }),
    // Ben's own message, shaped like an agent's round answer down to the
    // marker inside it. The row arrived unmarked (no `ai` column) and he is
    // in no machine record, so it badges no more than his plain words do —
    // even though the disclosure it carries is real content he wrote.
    row({
      msgId: `${BEN}.M4`,
      ts: T0 + 60_000,
      authorId: BEN,
      ai: null,
      body: JSON.stringify({
        tcm: 'reply',
        ref: anchor,
        ofs: false,
        text: 'Two findings.',
        d: 'I am an AI and this is my full answer.',
        ai: true,
      }),
    }),
  ]);
  const tree = await renderThread(ROOM);
  expect(tree.root.findAllByProps({ testID: `ai-badge-${BEN}.M4` }).length).toBe(0);
});

test('three replies in one round keep three badges and three disclosures — disclosure is per MESSAGE', async () => {
  const anchor = `${ME}.M0`;
  const answer = (author: string, m: string, ts: number) =>
    row({
      msgId: `${author}.${m}`,
      ts,
      arrivedAt: ts,
      authorId: author,
      ai: 1,
      body: JSON.stringify({
        tcm: 'reply',
        ref: anchor,
        ofs: false,
        text: `brief from ${m}`,
        d: `detail from ${m}`,
        ai: true,
      }),
    });
  // All three arrived MARKED, so all three badge from the column — the
  // record is not needed and is deliberately absent here. BEN's id stands in
  // for a third crew agent: the badge follows the arrival record, never the
  // name this phone has for a sender.
  installDb([
    row({ msgId: anchor, direction: 'out', status: 'sent', authorId: ME, ts: T0, body: 'where are we?' }),
    answer(CLAUDE, 'M5', T0 + 1_000),
    answer(STRANGERBOT, 'M5', T0 + 2_000),
    answer(BEN, 'M5', T0 + 3_000),
  ]);
  const tree = await renderThread(ROOM);
  const disclosures = tree.root.findAll(
    n =>
      typeof n.type === 'string' &&
      typeof n.props.testID === 'string' &&
      n.props.testID.startsWith('detail-') &&
      !n.props.testID.startsWith('detail-body-'),
  );
  expect(disclosures).toHaveLength(3);
  for (const id of [CLAUDE, STRANGERBOT, BEN]) {
    expect(
      tree.root.findAllByProps({ testID: `ai-badge-${id}.M5` }).length,
    ).toBeGreaterThan(0);
  }
  // One round, one header — the badges stayed per message all the same.
  expect(
    tree.root.findAll(
      n => typeof n.type === 'string' && n.props.testID === `round-${anchor}-out`,
    ),
  ).toHaveLength(1);
});
