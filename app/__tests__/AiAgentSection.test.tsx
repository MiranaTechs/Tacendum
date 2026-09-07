import React from 'react';
import { Text, TextInput } from 'react-native';
import ReactTestRenderer from 'react-test-renderer';
import * as db from '../src/db';
import { messaging } from '../src/messaging';
import { AiAgentSection } from '../src/ui/AiAgentSection';

const PEER = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const NOW = 1_800_000_000_000;
const PREF_Q = '01J8MEAPPR0VAQ4X2C6TKN9RFW';

const STATE: db.AiAgentStateRow = {
  peerId: PEER,
  provider: 'codex',
  project: 'Tacendum',
  projectReceivedAt: NOW,
  capabilities: { notifications: true, approvals: true, tasks: true },
  capabilitiesReceivedAt: NOW,
  context: null,
  contextReceivedAt: null,
  usage: null,
  usageReceivedAt: null,
  lastSourceAt: NOW,
  lastDisplayAt: NOW,
  lastTimeTrusted: true,
  lastReceivedAt: NOW,
  displayName: 'Codex',
  localName: null,
};

const PREFERENCE: db.AiNotifyPreferenceRow = {
  peerId: PEER,
  effectiveRoutine: 'all',
  pendingQ: null,
  requestedRoutine: null,
  requestedAt: null,
  acknowledgedAt: null,
};

beforeEach(() => {
  jest.restoreAllMocks();
  jest.spyOn(db, 'getAiAgentState').mockResolvedValue(STATE);
  jest.spyOn(messaging, 'sendText').mockResolvedValue();
  jest.spyOn(messaging, 'setAiRoutinePreference').mockResolvedValue(PREF_Q);
  jest.spyOn(messaging, 'retryAiRoutinePreference').mockResolvedValue(PREF_Q);
});

async function render(
  state: db.AiAgentStateRow | null = STATE,
  preference: db.AiNotifyPreferenceRow | null = PREFERENCE,
): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(
      <AiAgentSection
        peerId={PEER}
        state={state}
        preference={preference}
        now={NOW}
      />,
    );
  });
  return tree;
}

function control(tree: ReactTestRenderer.ReactTestRenderer, testID: string) {
  return tree.root.findAll(
    node => node.props.testID === testID && typeof node.props.onPress === 'function',
  )[0]!;
}

function copy(tree: ReactTestRenderer.ReactTestRenderer): string {
  return tree.root
    .findAllByType(Text)
    .map(node =>
      Array.isArray(node.props.children)
        ? node.props.children.join('')
        : String(node.props.children ?? ''),
    )
    .join('\n');
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>(done => {
      resolve = done;
    }),
    resolve,
  };
}

test('a quick task opens an editable review and sends only after confirmation', async () => {
  const tree = await render();
  await ReactTestRenderer.act(async () => {
    control(tree, 'peer-ai-task-review-changes').props.onPress();
  });

  expect(messaging.sendText).not.toHaveBeenCalled();
  expect(copy(tree)).toContain('Selected agent · Codex (Codex)');
  expect(copy(tree)).toContain('Captured project · Tacendum');
  const input = tree.root.findByType(TextInput);
  await ReactTestRenderer.act(async () => {
    input.props.onChangeText('Review only the authentication changes.');
  });
  await ReactTestRenderer.act(async () => {
    await control(tree, 'peer-ai-task-send').props.onPress();
  });

  expect(db.getAiAgentState).toHaveBeenCalledWith(PEER);
  expect(messaging.sendText).toHaveBeenCalledWith(
    PEER,
    'Review only the authentication changes.',
  );
  expect(copy(tree)).toContain('Request queued in this conversation.');
});

test('cancel closes the reviewed draft without sending', async () => {
  const tree = await render();
  await ReactTestRenderer.act(async () => {
    control(tree, 'peer-ai-task-explain-failure').props.onPress();
  });
  await ReactTestRenderer.act(async () => {
    control(tree, 'peer-ai-task-cancel').props.onPress();
  });
  expect(tree.root.findAllByProps({ testID: 'peer-ai-task-review' })).toEqual([]);
  expect(messaging.sendText).not.toHaveBeenCalled();
});

test('a notifications-only integration explains the disabled task actions', async () => {
  const tree = await render({
    ...STATE,
    capabilities: { notifications: true, approvals: false, tasks: false },
  });
  const action = tree.root.findByProps({ testID: 'peer-ai-task-review-changes' });
  expect(action.props.accessibilityState).toEqual({ disabled: true });
  expect(copy(tree)).toContain('Owner-directed tasks are not configured');
  expect(copy(tree)).toContain('tacendum doctor');
  expect(copy(tree)).toContain('tacendum attend enable <account>');
});

test('configured capabilities are stated individually without an online claim', async () => {
  const tree = await render({
    ...STATE,
    capabilities: { notifications: true, approvals: false, tasks: true },
  });
  expect(copy(tree)).toContain('Notifications · Configured');
  expect(copy(tree)).toContain('Approval requests · Unavailable');
  expect(copy(tree)).toContain('Owner tasks · Configured');
  expect(copy(tree)).not.toContain('Online');
});

test('routine notification changes stay pending until the exact agent ack is loaded', async () => {
  const tree = await render();
  expect(copy(tree)).toContain(
    'Quiet completions show the finished response once without an alert or live preview.',
  );
  await ReactTestRenderer.act(async () => {
    await control(tree, 'peer-ai-notify-quiet').props.onPress();
  });
  expect(messaging.setAiRoutinePreference).toHaveBeenCalledWith(PEER, 'quiet');
  expect(copy(tree)).toContain('must acknowledge it before this changes');
  expect(
    tree.root.findByProps({ testID: 'peer-ai-notify-all' }).props
      .accessibilityState,
  ).toMatchObject({ selected: true });

  await ReactTestRenderer.act(async () => {
    tree.update(
      <AiAgentSection
        peerId={PEER}
        state={STATE}
        preference={{
          ...PREFERENCE,
          effectiveRoutine: 'quiet',
          acknowledgedAt: NOW,
        }}
        now={NOW}
      />,
    );
  });
  expect(
    tree.root.findByProps({ testID: 'peer-ai-notify-quiet' }).props
      .accessibilityState,
  ).toMatchObject({ selected: true });
  expect(copy(tree)).toContain('Applied by agent');
});

test('a pending notification request offers an explicit exact-q retry', async () => {
  const tree = await render(STATE, {
    ...PREFERENCE,
    pendingQ: PREF_Q,
    requestedRoutine: 'quiet',
    requestedAt: NOW - 60_000,
  });
  expect(copy(tree)).toContain('Waiting for Codex to apply Quiet completions');
  expect(copy(tree)).toContain(
    'The agent must be listening to apply this setting. On its computer, run tacendum doctor and follow the listener setup instructions.',
  );
  await ReactTestRenderer.act(async () => {
    await control(tree, 'peer-ai-notify-retry').props.onPress();
  });
  expect(messaging.retryAiRoutinePreference).toHaveBeenCalledWith(PEER);
  expect(messaging.setAiRoutinePreference).not.toHaveBeenCalled();
});

test('only a current local exhausted turn budget disables new tasks', async () => {
  const exhausted = {
    ...STATE,
    usage: [
      {
        source: 'local-budget' as const,
        unit: 'turns' as const,
        period: 'hour' as const,
        observedAt: NOW,
        used: 10,
        remaining: 0,
        limit: 10,
      },
    ],
    usageReceivedAt: NOW,
  };
  const current = await render(exhausted);
  expect(copy(current)).toContain('A current local turn limit is reached.');
  expect(
    current.root.findByProps({ testID: 'peer-ai-task-review-changes' }).props
      .accessibilityState,
  ).toEqual({ disabled: true });

  const stale = await render({
    ...exhausted,
    usage: [{ ...exhausted.usage[0]!, observedAt: NOW - 10 * 60_000 }],
  });
  expect(copy(stale)).toContain('Stale');
  expect(
    stale.root.findByProps({ testID: 'peer-ai-task-review-changes' }).props
      .accessibilityState,
  ).toEqual({ disabled: false });
});

test('a changed target is shown for review again and nothing sends', async () => {
  (db.getAiAgentState as jest.Mock).mockResolvedValueOnce({
    ...STATE,
    project: 'Other project',
  });
  const tree = await render();
  await ReactTestRenderer.act(async () => {
    control(tree, 'peer-ai-task-summarize-changes').props.onPress();
  });
  await ReactTestRenderer.act(async () => {
    await control(tree, 'peer-ai-task-send').props.onPress();
  });

  expect(messaging.sendText).not.toHaveBeenCalled();
  expect(copy(tree)).toContain('reported project/capabilities changed');
});

test('an unavailable answerer leaves the draft editable and reports failure', async () => {
  (messaging.sendText as jest.Mock).mockRejectedValueOnce(new Error('offline'));
  const tree = await render();
  await ReactTestRenderer.act(async () => {
    control(tree, 'peer-ai-task-review-changes').props.onPress();
  });
  await ReactTestRenderer.act(async () => {
    await control(tree, 'peer-ai-task-send').props.onPress();
  });

  expect(copy(tree)).toContain('The request wasn’t queued.');
  expect(tree.root.findByType(TextInput).props.editable).toBe(true);
});

test('a same-tick double tap starts only one target check and one send', async () => {
  const read = deferred<db.AiAgentStateRow | null>();
  (db.getAiAgentState as jest.Mock).mockReturnValueOnce(read.promise);
  const tree = await render();
  await ReactTestRenderer.act(async () => {
    control(tree, 'peer-ai-task-review-changes').props.onPress();
  });
  const send = control(tree, 'peer-ai-task-send');
  await ReactTestRenderer.act(async () => {
    send.props.onPress();
    send.props.onPress();
  });
  expect(db.getAiAgentState).toHaveBeenCalledTimes(1);

  await ReactTestRenderer.act(async () => {
    read.resolve(STATE);
    await read.promise;
  });
  expect(messaging.sendText).toHaveBeenCalledTimes(1);
});

test('task choices and cancel cannot replace an in-flight reviewed request', async () => {
  const sending = deferred<void>();
  (messaging.sendText as jest.Mock).mockReturnValueOnce(sending.promise);
  const tree = await render();
  await ReactTestRenderer.act(async () => {
    control(tree, 'peer-ai-task-review-changes').props.onPress();
  });
  const original = tree.root.findByType(TextInput).props.value;

  await ReactTestRenderer.act(async () => {
    control(tree, 'peer-ai-task-send').props.onPress();
    await Promise.resolve();
  });
  expect(messaging.sendText).toHaveBeenCalledTimes(1);
  expect(
    tree.root.findByProps({ testID: 'peer-ai-task-explain-failure' }).props
      .accessibilityState,
  ).toEqual({ disabled: true });

  await ReactTestRenderer.act(async () => {
    // Invoke the callbacks directly as a same-tick race would. The ref gate,
    // rather than Pressable alone, must protect the reviewed request.
    control(tree, 'peer-ai-task-explain-failure').props.onPress();
    control(tree, 'peer-ai-task-cancel').props.onPress();
  });
  expect(tree.root.findByType(TextInput).props.value).toBe(original);
  expect(tree.root.findAllByProps({ testID: 'peer-ai-task-review' }).length).toBeGreaterThan(0);

  await ReactTestRenderer.act(async () => {
    sending.resolve();
    await sending.promise;
  });
  expect(copy(tree)).toContain('Request queued in this conversation.');
});

test('a target read completing after peer switch cannot send or paint old status', async () => {
  const read = deferred<db.AiAgentStateRow | null>();
  (db.getAiAgentState as jest.Mock).mockReturnValueOnce(read.promise);
  const tree = await render();
  await ReactTestRenderer.act(async () => {
    control(tree, 'peer-ai-task-review-changes').props.onPress();
  });
  await ReactTestRenderer.act(async () => {
    control(tree, 'peer-ai-task-send').props.onPress();
  });

  const other = { ...STATE, peerId: 'agent-b', displayName: 'Claude' };
  await ReactTestRenderer.act(async () => {
    tree.update(
      <AiAgentSection
        peerId="agent-b"
        state={other}
        preference={{ ...PREFERENCE, peerId: 'agent-b' }}
        now={NOW}
      />,
    );
  });
  await ReactTestRenderer.act(async () => {
    read.resolve(STATE);
    await read.promise;
  });

  expect(messaging.sendText).not.toHaveBeenCalled();
  expect(copy(tree)).not.toContain('Request queued in this conversation.');
  expect(tree.root.findAllByProps({ testID: 'peer-ai-task-review' })).toEqual([]);
});

test('a state row for another peer cannot render controls under this profile', async () => {
  const tree = await render({ ...STATE, peerId: 'agent-b' });
  expect(tree.toJSON()).toBeNull();
});

test('no source-backed integration state renders no agent controls', async () => {
  const tree = await render(null);
  expect(tree.toJSON()).toBeNull();
});
