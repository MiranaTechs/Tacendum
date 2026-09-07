import { type RosterSlot } from '@tacendum/shared/group-fold';
import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { Text } from 'react-native';
import * as db from '../src/db';
import { messaging } from '../src/messaging';
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
const ROOM = ulid('R00M');
const ANA = ulid('ANA');
const CARA = ulid('CARA');
const BEN = ulid('BEN');
const ME = ulid('ME1');
const STRANGER = 'Z'.repeat(18) + 'QRSTWXYZ';
const MSG = `${ANA}.M1`;
const T0 = new Date('2026-09-06T12:00:00').getTime();

const SLOT_ROWS: RosterSlot[] = [
  { memberId: ANA, writerId: ANA, seq: 1, state: 'in' },
  { memberId: CARA, writerId: ANA, seq: 1, state: 'in' },
  { memberId: BEN, writerId: ANA, seq: 1, state: 'in' },
  { memberId: ME, writerId: ANA, seq: 1, state: 'in' },
];

let messageRows: Record<string, unknown>[];
let reactionRows: db.ReactionRow[];
let listeners: Array<() => void>;
let anaName: string;
let directName: string | null;

const reaction = (
  emoji: string,
  reactorId: string,
  direction: 'in' | 'out' = 'in',
): db.ReactionRow => ({
  targetMsgId: MSG,
  targetDirection: 'in',
  direction,
  reactorId,
  emoji,
  ts: T0,
});

beforeEach(async () => {
  messageRows = [
    {
      msgId: MSG,
      peerId: ROOM,
      direction: 'in',
      body: 'Tea is ready',
      ts: T0,
      status: 'received',
      authorId: ANA,
      deletedAt: null,
    },
  ];
  reactionRows = [
    reaction('❤️', ANA),
    reaction('❤️', CARA),
    reaction('❤️', ME, 'out'),
    reaction('👍', STRANGER),
  ];
  listeners = [];
  anaName = 'Ana';
  directName = null;
  jest.spyOn(messaging, 'subscribe').mockImplementation(listener => {
    listeners.push(listener);
    return () => {};
  });
  await db.close();
  sqlite.reset();
  db.setWorkspace('real');
  await db.initDb();
  const instance = sqlite.instances.get('tacendum.sqlite')!;
  const base = instance.execute.getMockImplementation()!;
  instance.execute.mockImplementation(async (sql: string, params?: unknown[]) => {
    const s = String(sql);
    if (s.includes('FROM reactions')) return { rows: reactionRows.map(r => ({ ...r })) };
    if (s.includes('FROM messages')) return { rows: messageRows.map(r => ({ ...r })) };
    if (s.includes('SELECT groupId, ownerId, name FROM groups')) {
      return params?.[0] === ROOM
        ? { rows: [{ groupId: ROOM, ownerId: ANA, name: 'Kitchen' }] }
        : { rows: [] };
    }
    if (s.includes('FROM group_members')) {
      return params?.[0] === ROOM ? { rows: SLOT_ROWS } : { rows: [] };
    }
    if (s.includes('FROM chats') && s.includes('ORDER BY')) {
      return {
        rows: [
          { peerId: ANA, displayName: anaName, localName: null },
          { peerId: CARA, displayName: 'Cara', localName: 'Sis' },
          { peerId: BEN, displayName: 'Ben', localName: null },
        ],
      };
    }
    if (s.includes('FROM chats')) {
      return { rows: [{ peerId: params?.[0] ?? ROOM, displayName: directName, localName: null }] };
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
  });
});

afterEach(async () => {
  jest.restoreAllMocks();
  await db.close();
});

async function renderThread(peerId = ROOM) {
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

async function press(tree: ReactTestRenderer.ReactTestRenderer, testID: string) {
  const node = tree.root
    .findAllByProps({ testID })
    .find(n => typeof n.props.onPress === 'function');
  await ReactTestRenderer.act(async () => node!.props.onPress());
}

function words(node: ReactTestRenderer.ReactTestInstance): string {
  return node
    .findAllByType(Text)
    .map(text =>
      Array.isArray(text.props.children)
        ? text.props.children.join('')
        : String(text.props.children ?? ''),
    )
    .join('\n');
}

async function refresh() {
  await ReactTestRenderer.act(async () => {
    for (const listener of listeners) listener();
    await new Promise<void>(resolve => setTimeout(resolve, 120));
  });
  await ReactTestRenderer.act(async () => {});
}

test('same emoji rows render as one count pill and disclose known people without ids', async () => {
  const tree = await renderThread();
  const hearts = tree.root.findByProps({ testID: `reaction-group-${MSG}-❤️` });
  expect(words(hearts)).toContain('❤️');
  expect(words(hearts)).toContain('3');
  expect(hearts.props.accessibilityLabel).toBe(
    'Heart, 3 reactions, including you. Show who reacted',
  );
  expect(tree.root.findAll(n => n.props.testID === `reaction-group-${MSG}-👍` && typeof n.type === 'string')).toHaveLength(1);

  await press(tree, `reaction-group-${MSG}-❤️`);
  const detail = tree.root.findByProps({ testID: `reaction-details-${MSG}` });
  const detailWords = words(detail);
  expect(detailWords).toContain('You');
  expect(detailWords).toContain('Ana');
  expect(detailWords).toContain('Sis');
  expect(detailWords).not.toContain(ANA);
  expect(detailWords).not.toContain(CARA);
  expect(tree.root.findAllByProps({ testID: `reaction-change-${MSG}` })).not.toHaveLength(0);
  expect(tree.root.findAllByProps({ testID: `reaction-remove-${MSG}` })).not.toHaveLength(0);
  await ReactTestRenderer.act(() => tree.unmount());
});

test('a reaction from outside the current roster is named Someone and offers no remove action', async () => {
  const tree = await renderThread();
  await press(tree, `reaction-group-${MSG}-👍`);
  const detail = tree.root.findByProps({ testID: `reaction-details-${MSG}` });
  expect(words(detail)).toContain('Someone');
  expect(words(detail)).not.toContain(STRANGER);
  expect(tree.root.findAllByProps({ testID: `reaction-remove-${MSG}` })).toHaveLength(0);
  expect(tree.root.findAllByProps({ testID: `reaction-add-${MSG}` })).not.toHaveLength(0);
  await ReactTestRenderer.act(() => tree.unmount());
});

test('Remove retracts only my reaction through the existing exact-message API', async () => {
  const sendReaction = jest.spyOn(messaging, 'sendReaction').mockResolvedValue();
  const tree = await renderThread();
  await press(tree, `reaction-group-${MSG}-❤️`);
  await press(tree, `reaction-remove-${MSG}`);
  expect(sendReaction).toHaveBeenCalledWith(ROOM, MSG, 'in', '');
  await ReactTestRenderer.act(() => tree.unmount());
});

test('an open people panel refreshes attribution, then closes when its exact message disappears', async () => {
  const tree = await renderThread();
  await press(tree, `reaction-group-${MSG}-❤️`);
  expect(words(tree.root.findByProps({ testID: `reaction-details-${MSG}` }))).toContain('Sis');

  reactionRows = [
    reaction('❤️', ANA),
    reaction('❤️', BEN),
    reaction('❤️', ME, 'out'),
    reaction('👍', STRANGER),
  ];
  await refresh();
  const updated = words(tree.root.findByProps({ testID: `reaction-details-${MSG}` }));
  expect(updated).toContain('Ben');
  expect(updated).not.toContain('Sis');

  messageRows = [];
  await refresh();
  expect(tree.root.findAllByProps({ testID: `reaction-details-${MSG}` })).toHaveLength(0);
  await ReactTestRenderer.act(() => tree.unmount());
});


test.each([ANA, `…${ANA.slice(-8)}`])('raw or shortened current participant names stay Someone (%s)', async unsafe => {
  anaName = unsafe;
  const tree = await renderThread();
  await press(tree, `reaction-group-${MSG}-❤️`);
  const detail = words(tree.root.findByProps({ testID: `reaction-details-${MSG}` }));
  expect(detail).toContain('Someone');
  expect(detail).not.toContain(unsafe);
  await ReactTestRenderer.act(() => tree.unmount());
});

test('Change opens the existing picker without sending; a choice uses the exact message', async () => {
  const send = jest.spyOn(messaging, 'sendReaction').mockResolvedValue();
  const tree = await renderThread();
  await press(tree, `reaction-group-${MSG}-❤️`);
  await press(tree, `reaction-change-${MSG}`);
  expect(tree.root.findAllByProps({ testID: `reaction-details-${MSG}` })).toHaveLength(0);
  expect(send).not.toHaveBeenCalled();
  await press(tree, 'react-👍');
  expect(send).toHaveBeenCalledWith(ROOM, MSG, 'in', '👍');
  await ReactTestRenderer.act(() => tree.unmount());
});

test.each(['retracted', 'redacted', 'blocked'])('details disappear when the target becomes %s', async reason => {
  const blocked = jest.spyOn(messaging, 'isPeerBlocked').mockReturnValue(false);
  const tree = await renderThread();
  await press(tree, `reaction-group-${MSG}-❤️`);
  if (reason === 'retracted') reactionRows = [reaction('👍', ANA)];
  if (reason === 'redacted') messageRows[0] = { ...messageRows[0], deletedAt: T0 + 1, body: '' };
  if (reason === 'blocked') blocked.mockReturnValue(true);
  await refresh();
  expect(tree.root.findAllByProps({ testID: `reaction-details-${MSG}` })).toHaveLength(0);
  await ReactTestRenderer.act(() => tree.unmount());
});

test('switching peers clears the open panel even when message ids collide', async () => {
  const tree = await renderThread();
  await press(tree, `reaction-group-${MSG}-❤️`);
  await ReactTestRenderer.act(async () => tree.update(
    <ChatThreadScreen peerId={BEN} onBack={jest.fn()} onOpenPeerProfile={jest.fn()} onOpenPhoto={jest.fn()} />,
  ));
  expect(tree.root.findAllByProps({ testID: `reaction-details-${MSG}` })).toHaveLength(0);
  await ReactTestRenderer.act(() => tree.unmount());
});


test.each(['You', 'you', 'THEM', ' them '])('an incoming room reaction cannot claim the local subject label %s', async unsafe => {
  anaName = unsafe;
  reactionRows = [reaction('❤️', ANA)];
  const tree = await renderThread();
  await press(tree, `reaction-group-${MSG}-❤️`);
  const detail = words(tree.root.findByProps({ testID: `reaction-details-${MSG}` }));
  expect(detail).toContain('Someone');
  expect(detail).not.toMatch(/^(you|them)$/im);
  expect(tree.root.findAllByProps({ testID: `reaction-remove-${MSG}` })).toHaveLength(0);
  await ReactTestRenderer.act(() => tree.unmount());
});

test('a direct chat reaction uses the same reserved subject-label fallback', async () => {
  directName = 'You';
  messageRows = messageRows.map(row => ({ ...row, peerId: ANA }));
  reactionRows = [reaction('❤️', '')];
  const tree = await renderThread(ANA);
  await press(tree, `reaction-group-${MSG}-❤️`);
  const detail = words(tree.root.findByProps({ testID: `reaction-details-${MSG}` }));
  expect(detail).toContain('Someone');
  expect(detail).not.toMatch(/^you$/im);
  expect(tree.root.findAllByProps({ testID: `reaction-remove-${MSG}` })).toHaveLength(0);
  await ReactTestRenderer.act(() => tree.unmount());
});
