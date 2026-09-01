/**
 * Agent labeling in the room roster.
 *
 * The rules these pin:
 *  - a member recorded in machine_peers renders NAMED WITH ITS ATTRIBUTION —
 *    the stored name plus the owner attribution ("Claude · laptop" + "Your AI
 *    agent") — derived from the member's cryptographic id looked up in the
 *    record, never from any name or word a payload shared;
 *  - a human member wearing an agent-shaped display name gets NO agent badge
 *    (the spoof direction);
 *  - identity-pin parity: the agent's row keeps the SAME safety-state line a
 *    human member's row carries — the badge adds to the member row, it
 *    replaces nothing and it is not a safety claim.
 *
 * Harness follows GroupProfile.test.tsx / ChatThread.room.test.tsx.
 */

import React from 'react';
import { Text } from 'react-native';
import ReactTestRenderer from 'react-test-renderer';
import * as db from '../src/db';
import { AGENT_COPY } from '../src/machine';
import { messaging } from '../src/messaging';
import { GroupProfileScreen } from '../src/screens/GroupProfileScreen';

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
const ROOM = ulid('R00MAGNT');
const ME = ulid('ME1');
const CLAUDE = ulid('AGENT'); // recorded machine
const BEN = ulid('BEN'); // human, agent-shaped display name (the spoof)
const T0 = new Date('2026-08-14T09:00:00').getTime();

const ME_PROFILE: db.ProfileRow = {
  userId: ME,
  registrationId: 7,
  displayName: 'Nat',
  about: '',
  avatarB64: '',
  profileVersion: 1,
};

const chatRow = (peerId: string, displayName: string) => ({
  peerId,
  displayName,
  localName: null,
  about: null,
  avatarB64: null,
  profileVersion: null,
  lastMessageAt: T0,
  lastMessageText: '',
  safetyCheckedAt: null,
  createdAt: T0,
  lastOpenedAt: null,
  identityChangedAt: null,
  safetyMismatchAt: null,
});

function installDb(opts: { machines?: string[] } = {}) {
  const machines = opts.machines ?? [CLAUDE];
  const instance = sqlite.instances.get('tacendum.sqlite')!;
  const base = instance.execute.getMockImplementation()!;
  instance.execute.mockImplementation(
    async (sql: string, params?: unknown[]) => {
      const s = String(sql);
      if (s.includes('FROM machine_peers')) {
        return { rows: machines.map(peerId => ({ peerId })) };
      }
      if (s.includes('SELECT groupId, ownerId, name FROM groups')) {
        return params?.[0] === ROOM
          ? { rows: [{ groupId: ROOM, ownerId: ME, name: 'Crew' }] }
          : { rows: [] };
      }
      if (s.includes('FROM group_members')) {
        return params?.[0] === ROOM
          ? {
              rows: [
                { memberId: ME, writerId: ME, seq: 1, state: 'in' },
                { memberId: CLAUDE, writerId: ME, seq: 1, state: 'in' },
                { memberId: BEN, writerId: ME, seq: 1, state: 'in' },
              ],
            }
          : { rows: [] };
      }
      if (s.includes('FROM chats') && s.includes('ORDER BY')) {
        return {
          rows: [
            chatRow(CLAUDE, 'Claude · laptop'),
            // The spoof: a human whose shared name wears the agent shape.
            chatRow(BEN, 'Claude — your AI agent'),
          ],
        };
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

async function mount(): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <GroupProfileScreen
        groupId={ROOM}
        me={ME_PROFILE}
        onBack={jest.fn()}
        onOpenMember={jest.fn()}
      />,
    );
  });
  await ReactTestRenderer.act(async () => {});
  return tree;
}

beforeEach(async () => {
  await db.close();
  sqlite.reset();
  db.setWorkspace('real');
  await db.initDb();
  // A number exists for every member, so the state line is 'unchecked' — the
  // realistic resting state — for human and machine alike.
  jest
    .spyOn(messaging, 'getSafetyNumber')
    .mockResolvedValue('1234567890'.repeat(6));
  installDb();
});

afterEach(async () => {
  jest.restoreAllMocks();
  await db.close();
});

test('a recorded machine renders named with its attribution; a human with an agent-shaped name gets no badge', async () => {
  const tree = await mount();
  // The agent's row: name + the attribution badge.
  expect(
    tree.root.findAllByProps({ testID: `agent-badge-${CLAUDE}` }).length,
  ).toBeGreaterThan(0);
  // The spoofing human's row: the shared name may render as a name, but the
  // badge derives from the id in the record — never from the name's shape.
  expect(tree.root.findAllByProps({ testID: `agent-badge-${BEN}` }).length).toBe(
    0,
  );
  // And I am not an agent either.
  expect(tree.root.findAllByProps({ testID: `agent-badge-${ME}` }).length).toBe(
    0,
  );
});

test('identity-pin parity: the agent’s row keeps the safety-state line a human row carries — the badge is not a safety claim', async () => {
  const tree = await mount();
  // Same state surface for both classes of member: the machinery that pins a
  // human's identity pins the agent's, unforked.
  expect(
    tree.root.findAllByProps({ testID: `member-state-${CLAUDE}` }).length,
  ).toBeGreaterThan(0);
  expect(
    tree.root.findAllByProps({ testID: `member-state-${BEN}` }).length,
  ).toBeGreaterThan(0);
  // The badge never says "verified" or borrows a checked state's vocabulary.
  const badge = tree.root.findByProps({ testID: `agent-badge-${CLAUDE}` });
  const badgeText = badge
    .findAllByType(Text)
    .concat(badge.type === Text ? [badge] : [])
    .map(n => String(n.props.children))
    .join('');
  expect(badgeText.toLowerCase()).not.toContain('verified');
  expect(badgeText).toBe(AGENT_COPY.rosterBadge);
});

test('VoiceOver hears the attribution in the member row label', async () => {
  const tree = await mount();
  const open = tree.root.findByProps({ testID: `member-open-${CLAUDE}` });
  expect(String(open.props.accessibilityLabel)).toContain(
    AGENT_COPY.attributed('Claude · laptop'),
  );
  // The spoofing human's label: his shared name may SAY "your AI agent" —
  // names are words — but the screen adds no attribution on top, so the
  // doubled form (his name run through attributed()) must never appear.
  const human = tree.root.findByProps({ testID: `member-open-${BEN}` });
  expect(String(human.props.accessibilityLabel)).not.toContain(
    AGENT_COPY.attributed('Claude — your AI agent'),
  );
});

test('teaching copy behind the roster ⓘ says what the tag means — only when an agent is present', async () => {
  const tree = await mount();
  // Behind the existing roster disclosure, the house pattern (ⓘ, in place).
  const allText = tree.root
    .findAllByType(Text)
    .map(n =>
      Array.isArray(n.props.children)
        ? (n.props.children as unknown[]).join('')
        : String(n.props.children ?? ''),
    )
    .join('\n');
  // The disclosure body only mounts once expanded; open it and assert the
  // line is wired into the roster info lines.
  const info = tree.root.findAll(
    n =>
      n.props?.testID === 'room-roster-info' &&
      typeof n.props?.onPress === 'function',
  )[0]!;
  await ReactTestRenderer.act(async () => info.props.onPress());
  const expanded = tree.root
    .findAllByType(Text)
    .map(n => String(n.props.children ?? ''))
    .join('\n');
  expect(expanded).toContain(AGENT_COPY.rosterInfo);
  expect(allText).toBeDefined();

  // A roster without a recorded machine teaches nothing about agents.
  installDb({ machines: [] });
  const plain = await mount();
  const plainInfo = plain.root.findAll(
    n =>
      n.props?.testID === 'room-roster-info' &&
      typeof n.props?.onPress === 'function',
  )[0]!;
  await ReactTestRenderer.act(async () => plainInfo.props.onPress());
  const plainText = plain.root
    .findAllByType(Text)
    .map(n => String(n.props.children ?? ''))
    .join('\n');
  expect(plainText).not.toContain(AGENT_COPY.rosterInfo);
});

/**
 * THE FOREIGN AGENT'S ROW. A runtime test showed a stranger's roster rendering someone
 * else's agent as a bare shortened id beside an unnamed human —
 * indistinguishable. The owner's roster write now carries the class, so the
 * row gains the badge and an attribution naming WHOSE agent it is, from the
 * fold's class record — never from a name's shape.
 */
const ANA = ulid('ANA'); // a FOREIGN room owner

function installForeignDb() {
  // A stranger's phone: owner ANA, no machine record, the agent NEVER heard
  // (no ai rows) — only the owner's classed roster slot names it.
  const instance = sqlite.instances.get('tacendum.sqlite')!;
  const base = instance.execute.getMockImplementation()!;
  instance.execute.mockImplementation(
    async (sql: string, params?: unknown[]) => {
      const s = String(sql);
      if (s.includes('FROM machine_peers')) return { rows: [] };
      if (s.includes('DISTINCT authorId FROM messages')) return { rows: [] };
      if (s.includes('FROM agent_consent')) return { rows: [] };
      if (s.includes('SELECT groupId, ownerId, name FROM groups')) {
        return params?.[0] === ROOM
          ? { rows: [{ groupId: ROOM, ownerId: ANA, name: 'Crew' }] }
          : { rows: [] };
      }
      if (s.includes('FROM group_members')) {
        return params?.[0] === ROOM
          ? {
              rows: [
                { memberId: ANA, writerId: ANA, seq: 1, state: 'in', class: null },
                { memberId: ME, writerId: ANA, seq: 1, state: 'in', class: null },
                { memberId: CLAUDE, writerId: ANA, seq: 1, state: 'in', class: 'integration' },
                { memberId: BEN, writerId: ANA, seq: 1, state: 'in', class: null },
              ],
            }
          : { rows: [] };
      }
      if (s.includes('FROM chats') && s.includes('ORDER BY')) {
        return {
          rows: [
            chatRow(ANA, 'Ana'),
            chatRow(CLAUDE, 'Claude · laptop'),
            chatRow(BEN, 'Ben'),
          ],
        };
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

test('a roster-CLASSED foreign agent gets the badge and the owner attribution — zero ai rows, zero machine record', async () => {
  installForeignDb();
  const tree = await mount();
  // The badge, driven by machines ∨ rosterClass — here rosterClass alone.
  expect(
    tree.root.findAllByProps({ testID: `agent-badge-${CLAUDE}` }).length,
  ).toBeGreaterThan(0);
  // The unclassed human beside it stays badge-free.
  expect(tree.root.findAllByProps({ testID: `agent-badge-${BEN}` }).length).toBe(0);
  // The spoken attribution names WHOSE agent it is — the room owner's, from
  // the fold's writer (the "Claude — Nat's agent" anatomy).
  const open = tree.root.findByProps({ testID: `member-open-${CLAUDE}` });
  const label = String(open.props.accessibilityLabel);
  expect(label).toContain(AGENT_COPY.foreignAttributed('Claude · laptop', 'Ana'));
});

test('the roster ⓘ teaches the FOREIGN tag too — with the sanctioned sentence, not an overclaim', async () => {
  installForeignDb();
  const tree = await mount();
  const info = tree.root.findAll(
    n =>
      n.props?.testID === 'room-roster-info' &&
      typeof n.props?.onPress === 'function',
  )[0]!;
  await ReactTestRenderer.act(async () => info.props.onPress());
  const expanded = tree.root
    .findAllByType(Text)
    .map(n => String(n.props.children ?? ''))
    .join('\n');
  expect(expanded).toContain(AGENT_COPY.foreignRosterInfo);
});
