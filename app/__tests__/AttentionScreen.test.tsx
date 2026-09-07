jest.mock('../src/db', () => ({
  listPendingApprovalSummaries: jest.fn(),
  listRecentAiWorkEvents: jest.fn(),
  listAiAgentStates: jest.fn(),
}));

import React from 'react';
import { SectionList, StyleSheet, Text } from 'react-native';
import ReactTestRenderer from 'react-test-renderer';
import * as db from '../src/db';
import { AttentionScreen } from '../src/screens/AttentionScreen';

const listPending = db.listPendingApprovalSummaries as jest.MockedFunction<
  typeof db.listPendingApprovalSummaries
>;
const listEvents = db.listRecentAiWorkEvents as jest.MockedFunction<
  typeof db.listRecentAiWorkEvents
>;
const listStates = db.listAiAgentStates as jest.MockedFunction<
  typeof db.listAiAgentStates
>;
const NOW = 1_800_000_000_000;
const PEER = 'agent-000000000000000000001';
const Q = '01ATTENTIONREQUEST000000001';
const PENDING: db.PendingApprovalSummaryRow = {
  peerId: PEER,
  q: Q,
  kind: 'exec',
  sessionTag: 's-7c2e',
  ts: NOW - 1_000,
  arrivedAt: NOW - 1_000,
  deadline: NOW + 59_000,
  displayName: 'Claude Code',
  localName: null,
  machine: true,
};

let mounted: ReactTestRenderer.ReactTestRenderer[] = [];

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
  jest.clearAllMocks();
  mounted = [];
  listPending.mockResolvedValue([PENDING]);
  listEvents.mockResolvedValue([]);
  listStates.mockResolvedValue([]);
});

afterEach(async () => {
  for (const tree of mounted) {
    await ReactTestRenderer.act(() => tree.unmount());
  }
  jest.useRealTimers();
});

async function renderScreen(
  onOpenApproval = jest.fn(),
  onOpenConversation = jest.fn(),
): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(
      <AttentionScreen
        onBack={jest.fn()}
        onOpenApproval={onOpenApproval}
        onOpenConversation={onOpenConversation}
      />,
    );
    await Promise.resolve();
  });
  mounted.push(tree);
  return tree;
}

function text(tree: ReactTestRenderer.ReactTestRenderer): string {
  return tree.root
    .findAllByType(Text)
    .map(node =>
      Array.isArray(node.props.children)
        ? node.props.children.join('')
        : String(node.props.children ?? ''),
    )
    .join('\n');
}

test('a row names durable facts only and opens its exact peer and request id', async () => {
  const onOpen = jest.fn();
  const tree = await renderScreen(onOpen);

  expect(text(tree)).toContain('Claude Code');
  expect(text(tree)).toContain('AI agent');
  expect(text(tree)).toContain('Run a command');
  expect(text(tree)).toContain('0:59 left');
  expect(text(tree)).not.toContain('npm test');

  const row = tree.root.findByProps({ testID: `attention-${PEER}-${Q}` });
  expect(row.props.accessibilityLabel).toContain('Claude Code');
  await ReactTestRenderer.act(async () => row.props.onPress());
  expect(onOpen).toHaveBeenCalledWith(PEER, Q);

  const list = tree.root.findByType(SectionList);
  expect(StyleSheet.flatten(list.props.style)).toEqual(
    expect.objectContaining({ maxWidth: 520 }),
  );

  const source = tree.root.findByProps({ testID: `attention-source-${PEER}` });
  expect(source.props.numberOfLines).toBe(1);
  expect(StyleSheet.flatten(source.parent?.props.style)).toEqual(
    expect.objectContaining({ flexDirection: 'column' }),
  );
});

test('shows a labelled loading state until durable reads answer', async () => {
  listPending.mockReturnValue(new Promise(() => {}));
  const tree = await renderScreen();
  expect(tree.root.findByProps({ testID: 'attention-loading' }).props.accessibilityLabel)
    .toBe('Loading requests that need attention');
  expect(text(tree)).not.toContain('You’re caught up');
});

test('a failed read clears rows, explains the error, and Retry really requeries', async () => {
  listPending
    .mockRejectedValueOnce(new Error('closed'))
    .mockResolvedValueOnce([]);
  const tree = await renderScreen();

  expect(text(tree)).toContain('Requests couldn’t be loaded. Try again.');
  const retry = tree.root.findByProps({ testID: 'attention-retry' });
  await ReactTestRenderer.act(async () => {
    retry.props.onPress();
    await Promise.resolve();
  });

  expect(listPending).toHaveBeenCalledTimes(2);
  expect(text(tree)).toContain('You’re caught up');
  expect(text(tree)).not.toContain('Requests couldn’t be loaded. Try again.');
});

test('a request leaves the actionable list when its deadline passes on screen', async () => {
  listPending
    .mockResolvedValueOnce([{ ...PENDING, deadline: NOW + 1_000 }])
    .mockResolvedValueOnce([]);
  const tree = await renderScreen();
  expect(text(tree)).toContain('Waiting for a decision');

  await ReactTestRenderer.act(async () => {
    jest.advanceTimersByTime(1_020);
    await Promise.resolve();
  });

  expect(listPending).toHaveBeenCalledTimes(2);
  expect(text(tree)).not.toContain('Waiting for a decision');
  expect(text(tree)).toContain('You’re caught up');
});

test('the empty state stays truthful without inferring whether an agent is active', async () => {
  listPending.mockResolvedValue([]);
  const tree = await renderScreen();
  expect(text(tree)).toContain('You’re caught up');
  expect(text(tree)).toContain('Set up an AI connection');
  expect(text(tree)).toContain('tacendum setup claude-code');
});

test('recent structured reports follow approvals and open their source conversation', async () => {
  const onOpenConversation = jest.fn();
  listEvents.mockResolvedValue([
    {
      peerId: PEER,
      eventId: '01J8MEAPPR0VAQ4X2C6TKN9RFW',
      wireMsgId: 'wire-event',
      provider: 'claude',
      event: 'waiting-for-input',
      project: 'Tacendum',
      projectReceivedAt: NOW,
      requestId: null,
      runTag: 's-7c2e',
      originKind: 'message',
      sourceRef: 'wire-event',
      sourceAt: NOW - 2_000,
      displayAt: NOW - 2_000,
      timeTrusted: true,
      receivedAt: NOW - 1_000,
      displayName: 'Claude Code',
      localName: null,
      context: {
        availability: 'captured',
        capturedAt: NOW - 3_000,
        resultSummary: 'Choose how to resolve the lint warning.',
      },
    },
  ]);
  const tree = await renderScreen(jest.fn(), onOpenConversation);

  const copy = text(tree);
  expect(copy.indexOf('Run a command')).toBeLessThan(
    copy.indexOf('Reported waiting for input'),
  );
  expect(copy).toContain('Agent report · Choose how to resolve the lint warning.');
  const row = tree.root.findByProps({
    testID: `attention-work-${PEER}-01J8MEAPPR0VAQ4X2C6TKN9RFW`,
  });
  await ReactTestRenderer.act(async () => row.props.onPress());
  expect(onOpenConversation).toHaveBeenCalledWith(PEER);
});

test('a notifications-only capability snapshot replaces generic setup inference', async () => {
  listPending.mockResolvedValue([]);
  listStates.mockResolvedValue([
    {
      peerId: PEER,
      provider: 'claude',
      project: null,
      projectReceivedAt: null,
      capabilities: { notifications: true, approvals: false, tasks: false },
      capabilitiesReceivedAt: NOW,
      context: null,
      contextReceivedAt: null,
      usage: null,
      usageReceivedAt: null,
      lastSourceAt: NOW,
      lastDisplayAt: NOW,
      lastTimeTrusted: true,
      lastReceivedAt: NOW,
      displayName: 'Claude Code',
      localName: null,
    },
  ]);
  const tree = await renderScreen();

  expect(text(tree)).toContain(
    'Your configured connection can report updates. Interactive approvals and tasks are not configured.',
  );
  expect(text(tree)).not.toContain('tacendum setup claude-code');
});
