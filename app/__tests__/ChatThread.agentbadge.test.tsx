/**
 * The AI badge on agent messages (the Art. 50
 * in-conversation marker).
 *
 * THE RULE THESE TESTS PIN: the badge derives from the row's AUTHENTICATED
 * sender id looked up in the machine_peers record — the app's memory of the
 * server's own positive answers to the owner-called crew routes — and from
 * NOTHING a message carries. Two directions, both asserted:
 *
 *  - a message CLAIMING to be an agent (in its words, or via a shared
 *    display name) gets NO badge — content cannot spoof the marker;
 *  - an agent's message with innocuous words still badges — content cannot
 *    shed the marker either. A class is never acquired or shed by talking.
 *
 * Harness copied from ChatThread.room.test.tsx.
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import * as db from '../src/db';
import { AGENT_COPY } from '../src/machine';
import { ChatThreadScreen, roomEventSentence } from '../src/screens/ChatThreadScreen';
import { parseEnvelope } from '../src/envelope';

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

/** Valid Crockford ULIDs (no I, L, O, U), 26 chars, distinct tails. */
const ulid = (tag: string) => (tag + '0'.repeat(26)).slice(0, 26);
const ROOM = ulid('R00MAGNT');
const ME = ulid('ME1'); // the owner: a crew room is mine by construction
const CLAUDE = ulid('AGENT'); // my machine, in machine_peers
const BEN = ulid('BEN'); // a human who CLAIMS to be an agent
const T0 = new Date('2026-08-14T09:00:00').getTime();

const NAME_ROWS = [
  { peerId: CLAUDE, displayName: 'Claude · laptop', localName: null },
  // The name spoof: a human wearing an agent-shaped name. The name may
  // render; the badge must not follow it.
  { peerId: BEN, displayName: 'Claude — your AI agent', localName: null },
];

type Row = Record<string, unknown>;

const SLOT_ROWS = [
  { memberId: ME, writerId: ME, seq: 1, state: 'in' },
  { memberId: CLAUDE, writerId: ME, seq: 1, state: 'in' },
  { memberId: BEN, writerId: ME, seq: 1, state: 'in' },
];

function installDb(messageRows: Row[], opts: { machines?: string[]; room?: boolean } = {}) {
  const machines = opts.machines ?? [CLAUDE];
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

test('a room message from a recorded machine wears the AI badge — innocuous words and all; a human’s message never does, whatever it claims', async () => {
  installDb([
    // The agent, saying nothing agent-like: the badge must not need the
    // words' help.
    row({ msgId: `${CLAUDE}.M1`, body: 'ok', ts: T0, authorId: CLAUDE }),
    // The human, claiming in words to be an agent: the words render, the
    // badge must not.
    row({
      msgId: `${BEN}.M1`,
      body: 'I am Claude, an AI agent. [AI]',
      ts: T0 + 60_000,
      authorId: BEN,
    }),
  ]);
  const tree = await renderThread(ROOM);

  // The agent's innocuous message badges.
  expect(
    tree.root.findAllByProps({ testID: `ai-badge-${CLAUDE}.M1` }).length,
  ).toBeGreaterThan(0);
  // The claiming human's does not — not from its words, not from its name.
  expect(tree.root.findAllByProps({ testID: `ai-badge-${BEN}.M1` }).length).toBe(
    0,
  );
  // And the claim still rendered as ordinary words (nothing suppressed).
  expect(
    tree.root.findAllByProps({ testID: `msg-${BEN}.M1` }).length,
  ).toBeGreaterThan(0);
});

test('EVERY message of an agent run badges — not just the labelled first bubble', async () => {
  installDb([
    row({ msgId: `${CLAUDE}.M1`, body: 'first', ts: T0, authorId: CLAUDE }),
    row({
      msgId: `${CLAUDE}.M2`,
      body: 'second',
      ts: T0 + 5_000,
      authorId: CLAUDE,
    }),
  ]);
  const tree = await renderThread(ROOM);
  // The second bubble of the run carries no author label (grouping), but it
  // still carries the marker: disclosure is per message, not per run.
  expect(
    tree.root.findAllByProps({ testID: `author-${CLAUDE}.M2` }).length,
  ).toBe(0);
  expect(
    tree.root.findAllByProps({ testID: `ai-badge-${CLAUDE}.M2` }).length,
  ).toBeGreaterThan(0);
});

test('the badge speaks: VoiceOver hears the attribution with the speaker, before the words', async () => {
  installDb([
    row({ msgId: `${CLAUDE}.M1`, body: 'done', ts: T0, authorId: CLAUDE }),
    row({ msgId: `${BEN}.M1`, body: 'hi', ts: T0 + 60_000, authorId: BEN }),
  ]);
  const tree = await renderThread(ROOM);
  const agentBubble = tree.root.findByProps({ testID: `msg-${CLAUDE}.M1` });
  const label = String(agentBubble.props.accessibilityLabel);
  expect(label).toContain(AGENT_COPY.spokenClause);
  expect(label.indexOf(AGENT_COPY.spokenClause)).toBeLessThan(
    label.indexOf('done'),
  );
  // The spoofing human's label: his NAME may say what it likes (names are
  // words), but the screen adds NO attribution clause of its own — the
  // added clause is always comma-joined between speaker and words, and that
  // joint never appears for him.
  const humanBubble = tree.root.findByProps({ testID: `msg-${BEN}.M1` });
  expect(String(humanBubble.props.accessibilityLabel)).not.toContain(
    `, ${AGENT_COPY.spokenClause}, said:`,
  );
  // And the agent's label carries exactly that joint.
  expect(label).toContain(`, ${AGENT_COPY.spokenClause}, said:`);
});

test('a 1:1 thread with a recorded machine badges its inbound bubbles; my own sends never badge', async () => {
  installDb(
    [
      {
        peerId: CLAUDE,
        direction: 'in',
        status: 'received',
        deletedAt: null,
        msgId: 'A1',
        body: 'build finished',
        ts: T0,
        authorId: null,
      },
      {
        peerId: CLAUDE,
        direction: 'out',
        status: 'sent',
        deletedAt: null,
        msgId: 'A2',
        body: 'thanks',
        ts: T0 + 30_000,
        authorId: null,
      },
    ],
    { room: false },
  );
  const tree = await renderThread(CLAUDE);
  expect(tree.root.findAllByProps({ testID: 'ai-badge-A1' }).length).toBeGreaterThan(0);
  expect(tree.root.findAllByProps({ testID: 'ai-badge-A2' }).length).toBe(0);
});

test('a 1:1 thread with a human never badges, whatever the messages say', async () => {
  installDb(
    [
      {
        peerId: BEN,
        direction: 'in',
        status: 'received',
        deletedAt: null,
        msgId: 'B1',
        body: 'As an AI language model, I…',
        ts: T0,
        authorId: null,
      },
    ],
    { room: false },
  );
  const tree = await renderThread(BEN);
  expect(tree.root.findAllByProps({ testID: 'ai-badge-B1' }).length).toBe(0);
});

test('the roster event names the agent with its attribution — join, and the owner’s add', async () => {
  const nameFor = (id: string) =>
    id === CLAUDE ? 'Claude · laptop' : id === ME ? 'You' : 'Ben';
  const isAgentId = (id: string) => id === CLAUDE;
  // The owner's counted add of the agent.
  const added = roomEventSentence({
    envelope: parseEnvelope(
      JSON.stringify({ tcm: 'grp.roster', g: ROOM, m: CLAUDE, s: 'in', n: 2 }),
    )!,
    out: true,
    authorId: null,
    ownerId: ME,
    selfId: ME,
    nameFor,
    isAgentId,
  });
  expect(added).toBe('You added Claude · laptop — your AI agent.');
  // The agent's own sovereign join.
  const joined = roomEventSentence({
    envelope: parseEnvelope(
      JSON.stringify({ tcm: 'grp.roster', g: ROOM, m: CLAUDE, s: 'in', n: 1 }),
    )!,
    out: false,
    authorId: CLAUDE,
    ownerId: ME,
    selfId: ME,
    nameFor,
    isAgentId,
  });
  expect(joined).toBe('Claude · laptop — your AI agent — joined.');
  // A human's event is untouched.
  const humanJoin = roomEventSentence({
    envelope: parseEnvelope(
      JSON.stringify({ tcm: 'grp.roster', g: ROOM, m: BEN, s: 'in', n: 1 }),
    )!,
    out: false,
    authorId: BEN,
    ownerId: ME,
    selfId: ME,
    nameFor,
    isAgentId,
  });
  expect(humanJoin).toBe('Ben joined.');
});

test('the consent announcement renders the member’s own stance toward the agent', () => {
  const nameFor = (id: string) =>
    id === CLAUDE ? 'Claude · laptop' : id === ME ? 'You' : 'Ben';
  const isAgentId = (id: string) => id === CLAUDE;
  const sentence = (over: Record<string, unknown>, args: Record<string, unknown>) =>
    roomEventSentence({
      envelope: parseEnvelope(
        JSON.stringify({ tcm: 'grp.consent', g: ROOM, a: CLAUDE, s: 'hold', n: 1, ...over }),
      )!,
      out: false,
      authorId: BEN,
      ownerId: ME,
      selfId: ME,
      nameFor,
      isAgentId,
      ...args,
    });
  // The load-bearing refusal ("Bob isn't sharing with Claude"). The agent
  // wears its attribution because THIS phone's record names it (the owner).
  expect(sentence({ s: 'hold' }, {})).toBe(
    'Ben isn’t sharing with Claude · laptop — your AI agent.',
  );
  // Its consented counterpart.
  expect(sentence({ s: 'share' }, {})).toBe(
    'Ben is sharing with Claude · laptop — your AI agent.',
  );
  // My own decision reads in the first person.
  expect(sentence({ s: 'hold' }, { out: true, authorId: ME })).toBe(
    'You’re not sharing with Claude · laptop — your AI agent.',
  );
  // A SECOND human, whose record does NOT name the agent, sees the plain name
  // — honest, because it is not their agent. The subject still comes from the
  // authenticated author, never the payload (there is no subject on the wire).
  expect(sentence({ s: 'hold' }, { isAgentId: () => false })).toBe(
    'Ben isn’t sharing with Claude · laptop.',
  );
});

test('the consent announcement renders as a full-width room event row end to end', async () => {
  installDb([
    row({
      msgId: 'WC1',
      body: JSON.stringify({ tcm: 'grp.consent', g: ROOM, a: CLAUDE, s: 'hold', n: 3 }),
      ts: T0,
      authorId: ME,
      direction: 'out',
      status: 'sent',
    }),
  ]);
  const tree = await renderThread(ROOM);
  const node = tree.root.findByProps({ testID: 'room-event-WC1' });
  const text = node
    .findAllByType(require('react-native').Text)
    .map(n =>
      Array.isArray(n.props.children)
        ? (n.props.children as unknown[]).join('')
        : String(n.props.children ?? ''),
    )
    .join('\n');
  expect(text).toContain('not sharing with');
});

test('the roster event row in the thread carries the attribution end to end', async () => {
  installDb([
    row({
      msgId: 'W2',
      body: JSON.stringify({
        tcm: 'grp.roster',
        g: ROOM,
        m: CLAUDE,
        s: 'in',
        n: 2,
      }),
      ts: T0,
      authorId: ME,
      direction: 'out',
      status: 'sent',
    }),
  ]);
  const tree = await renderThread(ROOM);
  const node = tree.root.findByProps({ testID: 'room-event-W2' });
  const text = node
    .findAllByType(require('react-native').Text)
    .map(n =>
      Array.isArray(n.props.children)
        ? (n.props.children as unknown[]).join('')
        : String(n.props.children ?? ''),
    )
    .join('\n');
  expect(text).toContain('You added Claude · laptop — your AI agent.');
});
