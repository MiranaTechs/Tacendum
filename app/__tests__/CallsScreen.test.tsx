/**
 * The Calls tab: every finished call, newest first, named and pictured from
 * the chats table at render time — and each row can redial or open the room.
 */

jest.mock('../src/db', () => ({
  listAllCalls: jest.fn(),
  listChats: jest.fn(),
}));

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import * as db from '../src/db';
import { CallsScreen } from '../src/screens/CallsScreen';

const listAllCalls = db.listAllCalls as jest.MockedFunction<typeof db.listAllCalls>;
const listChats = db.listChats as jest.MockedFunction<typeof db.listChats>;

const T0 = new Date('2026-07-25T12:00:00').getTime();

const CALL_A = {
  cid: '01CALLA0000000000000000001',
  peerId: 'peer-1',
  direction: 'in' as const,
  kind: 'audio' as const,
  state: 'ended' as const,
  reason: 'timeout',
  startedAt: T0 + 60_000,
  connectedAt: null,
  endedAt: T0 + 120_000,
  lastSeenAt: T0 + 120_000,
  missed: 1,
};
const CALL_B = {
  cid: '01CALLB0000000000000000002',
  peerId: 'peer-2',
  direction: 'out' as const,
  kind: 'video' as const,
  state: 'ended' as const,
  reason: 'hangup',
  startedAt: T0,
  connectedAt: T0 + 4_000,
  endedAt: T0 + 34_000,
  lastSeenAt: T0 + 34_000,
  missed: 0,
};

beforeEach(() => {
  jest.clearAllMocks();
  listAllCalls.mockResolvedValue([CALL_A, CALL_B]);
  listChats.mockResolvedValue([
    { peerId: 'peer-1', displayName: 'Ayana', localName: '', avatarB64: null },
    { peerId: 'peer-2', displayName: '', localName: 'Dawit', avatarB64: 'QUJD' },
  ] as never);
});

async function renderCalls(over: {
  onOpenChat?: jest.Mock;
  onCall?: jest.Mock;
} = {}): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <CallsScreen
        onOpenChat={over.onOpenChat ?? jest.fn()}
        onCall={over.onCall ?? jest.fn()}
      />,
    );
  });
  await ReactTestRenderer.act(async () => {});
  return tree;
}

function renderedText(tree: ReactTestRenderer.ReactTestRenderer): string {
  return tree.root
    .findAllByType(require('react-native').Text)
    .map(n =>
      Array.isArray(n.props.children)
        ? n.props.children.join('')
        : String(n.props.children ?? ''),
    )
    .join('\n');
}

test('rows carry the NAME, the label, and the duration — never a raw id', async () => {
  const tree = await renderCalls();
  const text = renderedText(tree);

  expect(text).toContain('Ayana');
  expect(text).toContain('Dawit');
  expect(text).toContain('Missed audio call');
  expect(text).toContain('Outgoing video call');
  expect(text).toContain('0:30');
  expect(text).not.toContain('peer-1');
  expect(text).not.toContain('01CALLA');
});

test('the row opens the room; the trailing button redials the same kind', async () => {
  const onOpenChat = jest.fn();
  const onCall = jest.fn();
  const tree = await renderCalls({ onOpenChat, onCall });

  const redial = tree.root
    .findAllByProps({ accessibilityRole: 'button' })
    .find(n => n.props.accessibilityLabel === 'Video call Dawit');
  expect(redial).toBeDefined();
  await ReactTestRenderer.act(async () => {
    redial!.props.onPress();
  });
  expect(onCall).toHaveBeenCalledWith('peer-2', 'video');

  const row = tree.root
    .findAllByProps({ accessibilityRole: 'button' })
    .find(n => String(n.props.accessibilityLabel ?? '').startsWith('Ayana,'));
  expect(row).toBeDefined();
  await ReactTestRenderer.act(async () => {
    row!.props.onPress();
  });
  expect(onOpenChat).toHaveBeenCalledWith('peer-1');
});

test('an empty log says so instead of rendering nothing', async () => {
  listAllCalls.mockResolvedValue([]);
  const tree = await renderCalls();
  expect(renderedText(tree)).toContain('No calls yet');
});

test("the disc gets the RAW stored name — a nameless caller's monogram comes from the id tail, not from '…'", async () => {
  // personName's resolved label is for the Text line; fed to the Avatar it
  // made monogram() slice "…KX7A9QZ2" into "…K". The disc's documented
  // nameless fallback is the id TAIL (person.ts), which needs a null name.
  const { Avatar } = require('../src/ui/Avatar') as typeof import('../src/ui/Avatar');
  listChats.mockResolvedValue([
    { peerId: 'peer-1', displayName: 'Ayana', localName: '', avatarB64: null },
    // peer-2: no chat row at all — a caller this phone never named.
  ] as never);

  const tree = await renderCalls();
  const discs = tree.root.findAllByType(Avatar);
  const byPeer = new Map(discs.map(d => [d.props.peerId as string, d.props]));

  // Named: the raw stored name, not the resolved label (same string here,
  // but the nameless case below is what tells them apart).
  expect(byPeer.get('peer-1')?.displayName).toBe('Ayana');
  // Nameless: NULL, so monogram() takes its documented id-tail path — never
  // the resolved "…"-prefixed label.
  expect(byPeer.get('peer-2')?.displayName ?? null).toBeNull();
});
