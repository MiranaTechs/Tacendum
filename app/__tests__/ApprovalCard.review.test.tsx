import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { Text } from 'react-native';
import type { ApprovalRow } from '../src/db';
import { ApprovalCard } from '../src/ui/ApprovalCard';

const NOW = 1_000_000;
const PAYLOAD =
  '{"tool_name":"Bash","tool_input":{"command":"git status --short","description":"Check working changes"},"cwd":"/work/repo"}';

function approval(over: Partial<ApprovalRow> = {}): ApprovalRow {
  return {
    peerId: 'peer-1',
    q: 'request-1',
    wireMsgId: 'wire-1',
    kind: 'exec',
    payload: PAYLOAD,
    payloadBytes: PAYLOAD.length,
    ttlSec: 600,
    sessionTag: null,
    verbs: ['approve', 'deny'],
    ts: NOW,
    arrivedAt: NOW,
    state: 'pending',
    answerVerb: null,
    settledAt: null,
    ...over,
  } as ApprovalRow;
}

const hosts = (tree: ReactTestRenderer.ReactTestRenderer, id: string) =>
  tree.root.findAll(n => typeof n.type === 'string' && n.props.testID === id);
const host = (tree: ReactTestRenderer.ReactTestRenderer, id: string) =>
  hosts(tree, id)[0]!;
const texts = (tree: ReactTestRenderer.ReactTestRenderer) =>
  tree.root.findAllByType(Text).map(n => n.props.children);
async function press(tree: ReactTestRenderer.ReactTestRenderer, id: string) {
  const control = tree.root.findAll(
    n => n.props.testID === id && typeof n.props.onPress === 'function',
  )[0]!;
  await ReactTestRenderer.act(() => control.props.onPress());
}
async function renderCard(a = approval(), busy = false) {
  const answer = jest.fn();
  let tree!: ReactTestRenderer.ReactTestRenderer;
  const element = (row: ApprovalRow, now = NOW, working = busy) => (
    <ApprovalCard
      approval={row}
      now={now}
      busy={working}
      onAnswer={answer}
      testID="card"
    />
  );
  await ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(element(a));
  });
  return {
    tree,
    answer,
    update: async (row: ApprovalRow, now = NOW, working = busy) => {
      await ReactTestRenderer.act(() =>
        tree.update(element(row, now, working)),
      );
    },
  };
}

test('a command preview cannot approve until the exact request is exposed', async () => {
  const { tree, answer } = await renderCard();
  expect(texts(tree)).toContain('Check working changes');
  expect(texts(tree)).toContain('git status --short');
  expect(texts(tree)).not.toContain(PAYLOAD);
  expect(host(tree, 'card-approve').props.accessibilityState.disabled).toBe(
    true,
  );
  // Even a direct callback cannot bypass the review guard.
  await press(tree, 'card-approve');
  expect(answer).not.toHaveBeenCalled();
  await press(tree, 'card-details');
  const exact = host(tree, 'card-payload').findAllByType(Text)[0]!;
  expect(exact.props.children).toBe(PAYLOAD);
  expect(exact.props.selectable).toBe(true);
  expect(exact.props.numberOfLines).toBeUndefined();
  expect(host(tree, 'card-approve').props.accessibilityState.disabled).toBe(
    false,
  );
  await press(tree, 'card-approve');
  expect(answer).toHaveBeenCalledWith('approve');
  await press(tree, 'card-details');
  expect(host(tree, 'card-approve').props.accessibilityState.disabled).toBe(
    true,
  );
});

test('review belongs to the exact request, never a recycled row or changed payload', async () => {
  const { tree, update } = await renderCard();
  await press(tree, 'card-details');
  await update(approval({ q: 'request-2' }));
  expect(host(tree, 'card-approve').props.accessibilityState.disabled).toBe(
    true,
  );
  await press(tree, 'card-details');
  await update(approval({ q: 'request-2', payload: 'another command' }));
  expect(host(tree, 'card-approve').props.accessibilityState.disabled).toBe(
    true,
  );
});

test('a settled receipt collapses the request but can reveal all original whitespace', async () => {
  const payload = '  echo first\n\techo second  \n';
  const pending = approval({ payload, payloadBytes: payload.length });
  const { tree, update } = await renderCard(pending);
  await press(tree, 'card-details');
  await update({
    ...pending,
    state: 'answered',
    answerVerb: 'approve',
    settledAt: NOW,
  });
  expect(hosts(tree, 'card-payload')).toHaveLength(0);
  expect(hosts(tree, 'card-approve')).toHaveLength(0);
  await press(tree, 'card-details');
  expect(
    host(tree, 'card-payload').findAllByType(Text)[0]!.props.children,
  ).toBe(payload);
});

test('deny stays available before review, and busy or expired requests cannot answer', async () => {
  const a = approval();
  const { tree, answer, update } = await renderCard(a);
  await press(tree, 'card-deny');
  expect(answer).toHaveBeenCalledWith('deny');
  answer.mockClear();
  await press(tree, 'card-details');
  await update(a, NOW, true);
  await press(tree, 'card-approve');
  await press(tree, 'card-deny');
  expect(answer).not.toHaveBeenCalled();
  await update(a, NOW + 600_000);
  expect(hosts(tree, 'card-approve')).toHaveLength(0);
  expect(hosts(tree, 'card-deny')).toHaveLength(0);
});

test.each(['x'.repeat(17 * 1024), 'bad\uD800text'])(
  'unrenderable payloads never offer review or approval',
  async payload => {
    const { tree } = await renderCard(
      approval({ payload, payloadBytes: payload.length }),
    );
    expect(hosts(tree, 'card-refusal')).toHaveLength(1);
    expect(hosts(tree, 'card-details')).toHaveLength(0);
    expect(hosts(tree, 'card-approve')).toHaveLength(0);
    expect(hosts(tree, 'card-deny')).toHaveLength(1);
  },
);

test('unknown wrapper fields cannot masquerade as the command preview', async () => {
  const payload =
    '{"description":"Misleading instructions","command":"not a recognised wrapper"}';
  const { tree } = await renderCard(approval({ payload }));
  expect(texts(tree)).not.toContain('Misleading instructions');
  expect(texts(tree)).not.toContain('not a recognised wrapper');
  await press(tree, 'card-details');
  expect(
    host(tree, 'card-payload').findAllByType(Text)[0]!.props.children,
  ).toBe(payload);
});

test('only declared recognised verbs can be sent after review', async () => {
  const { tree } = await renderCard(
    approval({ verbs: ['deny', 'edit:rm -rf'] }),
  );
  await press(tree, 'card-details');
  expect(hosts(tree, 'card-approve')).toHaveLength(0);
  expect(hosts(tree, 'card-deny')).toHaveLength(1);
});

test('redaction discards the old review even if the original row is later restored', async () => {
  const settled = approval({
    state: 'answered',
    answerVerb: 'deny',
    settledAt: NOW,
  });
  const { tree, update } = await renderCard(settled);
  await press(tree, 'card-details');
  await update({ ...settled, payload: '' });
  await update(settled);
  expect(hosts(tree, 'card-payload')).toHaveLength(0);
});

test('agent context is collapsed and cannot substitute for reviewing the request', async () => {
  const { tree, answer } = await renderCard(
    approval({
      work: {
        provider: 'claude',
        updatedAt: NOW,
        requestId: 'request-1',
        context: {
          availability: 'captured',
          capturedAt: NOW,
          repository: 'team/repository',
        },
      },
    }),
  );
  expect(texts(tree)).not.toContain('team/repository');
  await press(tree, 'card-context-toggle');
  expect(texts(tree)).toContain('team/repository');
  expect(hosts(tree, 'card-payload')).toHaveLength(0);
  await press(tree, 'card-approve');
  expect(answer).not.toHaveBeenCalled();
});
