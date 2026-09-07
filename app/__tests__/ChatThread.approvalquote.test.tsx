import React from 'react';
import { FlatList, Text } from 'react-native';
import ReactTestRenderer from 'react-test-renderer';
import * as db from '../src/db';
import { messaging } from '../src/messaging';
import { ChatThreadScreen } from '../src/screens/ChatThreadScreen';

const sqlite = (
  jest.requireMock('@op-engineering/op-sqlite') as {
    __sqlite: {
      instances: Map<string, { execute: jest.Mock }>;
      reset: () => void;
    };
  }
).__sqlite;

const T0 = new Date('2026-09-02T12:00:00').getTime();
const WIRE = '01APPROVALWIRE000000000001';
const Q = '01J8MEAPPR0VAQ4X2C6TKN9RFV';
let messages: Record<string, unknown>[];
let approvals: Record<string, unknown>[];
let scroll: jest.SpyInstance;

function reply(overrides: Record<string, unknown> = {}) {
  return {
    peerId: 'peer-1',
    msgId: '01ANSWER',
    direction: 'out',
    body: JSON.stringify({
      tcm: 'reply',
      ref: WIRE,
      ofs: false,
      text: 'approve',
    }),
    ts: T0 + 1000,
    status: 'sent',
    editedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

beforeEach(async () => {
  jest.useFakeTimers();
  jest.setSystemTime(T0 + 2000);
  scroll = jest
    .spyOn(FlatList.prototype, 'scrollToIndex')
    .mockImplementation(() => {});
  jest.spyOn(messaging, 'getSafetyNumber').mockResolvedValue(null);
  messages = [reply()];
  approvals = [
    {
      peerId: 'peer-1',
      q: Q,
      wireMsgId: WIRE,
      kind: 'exec',
      payload: '{"private":"command arguments"}',
      payloadBytes: 31,
      ttlSec: 600,
      sessionTag: 's-7c2e',
      verbs: '["approve","deny"]',
      ts: T0,
      arrivedAt: T0,
      state: 'answered',
      answerVerb: 'approve',
      settledAt: T0 + 1000,
    },
  ];
  await db.close();
  sqlite.reset();
  db.setWorkspace('real');
  await db.initDb();
  const instance = sqlite.instances.get('tacendum.sqlite')!;
  const base = instance.execute.getMockImplementation()!;
  instance.execute.mockImplementation(async (sql: string, params?: unknown) => {
    if (sql.includes('FROM messages')) return { rows: messages };
    if (sql.includes('FROM approvals')) return { rows: approvals };
    if (sql.includes('FROM chats'))
      return {
        rows: [
          {
            peerId: 'peer-1',
            displayName: 'Studio Mac',
            localName: null,
            lastOpenedAt: T0 + 2000,
          },
        ],
      };
    return base(sql, params);
  });
});

afterEach(async () => {
  jest.restoreAllMocks();
  await db.close();
  jest.useRealTimers();
});

async function renderThread() {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(
      <ChatThreadScreen
        peerId="peer-1"
        onBack={jest.fn()}
        onOpenPeerProfile={jest.fn()}
        onOpenPhoto={jest.fn()}
      />,
    );
  });
  await ReactTestRenderer.act(async () => {});
  return tree;
}

function quote(tree: ReactTestRenderer.ReactTestRenderer) {
  return tree.root.findAll(n => n.props.testID === 'quote-01ANSWER')[0]!;
}

function quoteText(tree: ReactTestRenderer.ReactTestRenderer) {
  return quote(tree)
    .findAllByType(Text)
    .map(n => n.props.children)
    .join(' ');
}

test.each([
  ['exec', 'Run a command'],
  ['file', 'Change files'],
  ['other', 'Requested action'],
])(
  'an answer quotes its %s request without exposing command data',
  async (kind, label) => {
    approvals[0]!.kind = kind;
    const tree = await renderThread();
    expect(quoteText(tree)).toBe(`Studio Mac ${label}`);
    expect(quoteText(tree)).not.toContain('private');
    expect(quote(tree).props.accessibilityRole).toBe('button');
    await ReactTestRenderer.act(() => tree.unmount());
  },
);

test('tapping an approval quote returns to the request card, including through VoiceOver', async () => {
  const tree = await renderThread();
  await ReactTestRenderer.act(async () => {
    quote(tree).props.onPress?.();
  });
  expect(scroll).toHaveBeenLastCalledWith(
    expect.objectContaining({ index: 0, viewPosition: 0.5 }),
  );
  scroll.mockClear();
  const bubble = tree.root.findAll(n => n.props.testID === 'msg-01ANSWER')[0]!;
  expect(bubble.props.accessibilityActions).toEqual(
    expect.arrayContaining([expect.objectContaining({ name: 'reveal' })]),
  );
  await ReactTestRenderer.act(async () => {
    bubble.props.onAccessibilityAction({
      nativeEvent: { actionName: 'reveal' },
    });
  });
  expect(scroll).toHaveBeenLastCalledWith(
    expect.objectContaining({ index: 0, viewPosition: 0.5 }),
  );
  await ReactTestRenderer.act(() => tree.unmount());
});

test.each([
  ['out', true],
  ['in', false],
])(
  'a %s reply claiming my own message cannot borrow an incoming approval',
  async (direction, ofs) => {
    messages = [
      reply({
        direction,
        body: JSON.stringify({ tcm: 'reply', ref: WIRE, ofs, text: 'approve' }),
      }),
    ];
    const tree = await renderThread();
    expect(quoteText(tree)).toBe('Original message');
    expect(quote(tree).props.onPress).toBeUndefined();
    await ReactTestRenderer.act(() => tree.unmount());
  },
);

test('an approval belonging to another peer cannot supply quote context', async () => {
  approvals[0]!.peerId = 'other-peer';
  const tree = await renderThread();
  expect(quoteText(tree)).toBe('Original message');
  expect(quote(tree).props.onPress).toBeUndefined();
  await ReactTestRenderer.act(() => tree.unmount());
});

test('a real message with the same wire ID retains its own quote and navigation', async () => {
  messages.unshift(
    reply({
      msgId: WIRE,
      direction: 'in',
      body: 'Real message',
      ts: T0 - 1000,
    }),
  );
  const tree = await renderThread();
  expect(quoteText(tree)).toBe('Studio Mac Real message');
  await ReactTestRenderer.act(async () => {
    quote(tree).props.onPress?.();
  });
  expect(scroll).toHaveBeenLastCalledWith(
    expect.objectContaining({ index: 0, viewPosition: 0.5 }),
  );
  await ReactTestRenderer.act(() => tree.unmount());
});

test('a cleared approval still gives its answer a safe, useful context', async () => {
  approvals[0]!.payload = '';
  const tree = await renderThread();
  expect(quoteText(tree)).toBe('Studio Mac Run a command');
  await ReactTestRenderer.act(() => tree.unmount());
});

test('memoized reply rows receive no approval payload or work data to retain after redaction', async () => {
  const tree = await renderThread();
  const request = tree.root.findAll(n => n.props.quotedApproval)[0]!.props
    .quotedApproval;
  expect(request.payload).toBeUndefined();
  expect(request.work).toBeUndefined();
  expect(request.sessionTag).toBeUndefined();
  await ReactTestRenderer.act(() => tree.unmount());
});

test('a deleted message cannot be replaced by a same-ID approval quote', async () => {
  messages.unshift(
    reply({
      msgId: WIRE,
      direction: 'in',
      body: '',
      ts: T0 - 1000,
      deletedAt: T0,
    }),
  );
  const tree = await renderThread();
  expect(quoteText(tree)).toBe('Studio Mac Original message');
  expect(quote(tree).props.onPress).toBeUndefined();
  await ReactTestRenderer.act(() => tree.unmount());
});
