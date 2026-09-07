import React from 'react';
import { AccessibilityInfo, Platform, ScrollView, Text } from 'react-native';
import ReactTestRenderer from 'react-test-renderer';
import type { AiWritingResult } from '../src/aiWriting';
import {
  getWritingConnections,
  getWritingRevision,
} from '../src/aiWritingService';
import { WritingAssistant } from '../src/ui/WritingAssistant';

jest.mock('../src/aiWritingService', () => ({
  getWritingConnections: jest.fn(),
  getWritingRevision: jest.fn(),
  saveWritingConnection: jest.fn(),
  removeWritingConnection: jest.fn(),
  selectWritingProvider: jest.fn(),
}));

const CONNECTED = {
  status: 'completed' as const,
  state: {
    selected: 'openai' as const,
    providers: {
      openai: { configured: true },
      anthropic: { configured: false },
    },
  },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>(done => {
      resolve = done;
    }),
    resolve,
  };
}

function control(tree: ReactTestRenderer.ReactTestRenderer, testID: string) {
  return tree.root.findAll(
    node =>
      node.props.testID === testID && typeof node.props.onPress === 'function',
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

async function render(
  overrides: Partial<React.ComponentProps<typeof WritingAssistant>> = {},
) {
  const props: React.ComponentProps<typeof WritingAssistant> = {
    sourceKey: 'peer-a:draft-7',
    onRequest: jest.fn(
      async (): Promise<AiWritingResult> => ({
        status: 'completed',
        text: 'A clearer note.',
      }),
    ),
    onUse: jest.fn(() => true),
    onClose: jest.fn(),
    ...overrides,
  };
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<WritingAssistant {...props} />);
  });
  return { tree, props };
}

beforeEach(() => {
  jest.clearAllMocks();
  (getWritingConnections as jest.Mock).mockResolvedValue(CONNECTED);
  (getWritingRevision as jest.Mock).mockReturnValue(12);
});

test('opening the assistant stays local until a writing action is pressed', async () => {
  const { tree, props } = await render();

  expect(props.onRequest).not.toHaveBeenCalled();
  expect(copy(tree)).toContain('Improve');
  expect(copy(tree)).toContain(
    'Only this draft goes to OpenAI. Review before using.',
  );

  await ReactTestRenderer.act(async () => {
    control(tree, 'writing-action-shorter').props.onPress();
  });

  expect(props.onRequest).toHaveBeenCalledTimes(1);
  expect(props.onRequest).toHaveBeenCalledWith(
    { kind: 'shorter' },
    expect.any(AbortSignal),
  );
});

test('inline connection setup uses the assistant Close action without an inert Done action', async () => {
  (getWritingConnections as jest.Mock).mockResolvedValue({
    status: 'completed',
    state: {
      selected: null,
      providers: {
        openai: { configured: false },
        anthropic: { configured: false },
      },
    },
  });
  const { tree } = await render();

  expect(tree.root.findByProps({ testID: 'writing-close' })).toBeDefined();
  expect(
    tree.root.findAllByProps({ testID: 'writing-connection-done' }),
  ).toHaveLength(0);
});

test('a rapid double press starts only one provider request', async () => {
  const result = deferred<AiWritingResult>();
  const onRequest = jest.fn(() => result.promise);
  const { tree } = await render({ onRequest });
  const press = control(tree, 'writing-action-improve').props.onPress;

  ReactTestRenderer.act(() => {
    press();
    press();
  });
  expect(onRequest).toHaveBeenCalledTimes(1);

  await ReactTestRenderer.act(async () => {
    result.resolve({ status: 'completed', text: 'One result.' });
    await result.promise;
  });
});

test('a completed request is reviewed and adopted only through Use text', async () => {
  const result = deferred<AiWritingResult>();
  const onRequest = jest.fn(() => result.promise);
  const { tree, props } = await render({ onRequest });

  await ReactTestRenderer.act(async () => {
    control(tree, 'writing-action-warmer').props.onPress();
  });
  expect(props.onUse).not.toHaveBeenCalled();
  expect(
    tree.root.findByProps({ testID: 'writing-working' }).props
      .accessibilityLiveRegion,
  ).toBe('polite');

  await ReactTestRenderer.act(async () => {
    result.resolve({
      status: 'completed',
      text: 'Thanks so much for the update.',
    });
    await result.promise;
  });

  expect(copy(tree)).toContain('Thanks so much for the update.');
  expect(props.onUse).not.toHaveBeenCalled();

  await ReactTestRenderer.act(async () => {
    control(tree, 'writing-use').props.onPress();
  });
  expect(props.onUse).toHaveBeenCalledWith('Thanks so much for the update.');
  expect(props.onClose).toHaveBeenCalledTimes(1);
});

test('VoiceOver hears both the working state and the completed review', async () => {
  expect(Platform.OS).toBe('ios');
  const announce = jest
    .spyOn(AccessibilityInfo, 'announceForAccessibilityWithOptions')
    .mockImplementation(() => undefined);
  announce.mockClear();
  const result = deferred<AiWritingResult>();
  const { tree } = await render({ onRequest: jest.fn(() => result.promise) });

  await ReactTestRenderer.act(async () => {
    control(tree, 'writing-action-improve').props.onPress();
  });
  expect(announce).toHaveBeenCalledWith('Improving…', { queue: true });

  await ReactTestRenderer.act(async () => {
    result.resolve({ status: 'completed', text: 'Ready to review.' });
    await result.promise;
  });
  expect(announce).toHaveBeenCalledWith(
    'Writing suggestion ready. Review before using.',
    { queue: true },
  );
  announce.mockRestore();
});

test('Translate waits for an explicit language choice and Translate press', async () => {
  const { tree, props } = await render();

  await ReactTestRenderer.act(async () => {
    control(tree, 'writing-action-translate').props.onPress();
  });
  expect(props.onRequest).not.toHaveBeenCalled();

  await ReactTestRenderer.act(async () => {
    control(tree, 'writing-language-es').props.onPress();
  });
  expect(
    control(tree, 'writing-language-es').props.accessibilityState,
  ).toMatchObject({ selected: true });
  expect(props.onRequest).not.toHaveBeenCalled();

  await ReactTestRenderer.act(async () => {
    control(tree, 'writing-translate-submit').props.onPress();
  });
  expect(props.onRequest).toHaveBeenCalledWith(
    { kind: 'translate', language: 'es' },
    expect.any(AbortSignal),
  );
});

test('changing the source cancels the old request and discards its late result', async () => {
  const result = deferred<AiWritingResult>();
  let requestSignal: AbortSignal | undefined;
  const onRequest = jest.fn((_action, signal: AbortSignal) => {
    requestSignal = signal;
    return result.promise;
  });
  const { tree, props } = await render({ onRequest });

  await ReactTestRenderer.act(async () => {
    control(tree, 'writing-action-improve').props.onPress();
  });
  expect(requestSignal?.aborted).toBe(false);

  await ReactTestRenderer.act(async () => {
    tree.update(
      <WritingAssistant
        {...props}
        sourceKey="peer-a:draft-8"
        onRequest={onRequest}
      />,
    );
  });
  expect(requestSignal?.aborted).toBe(true);

  await ReactTestRenderer.act(async () => {
    result.resolve({ status: 'completed', text: 'Stale text.' });
    await result.promise;
  });
  expect(copy(tree)).not.toContain('Stale text.');
});

test('a connection revision change prevents a result from reaching review', async () => {
  const result = deferred<AiWritingResult>();
  const { tree } = await render({ onRequest: jest.fn(() => result.promise) });

  await ReactTestRenderer.act(async () => {
    control(tree, 'writing-action-improve').props.onPress();
  });
  (getWritingRevision as jest.Mock).mockReturnValue(13);
  await ReactTestRenderer.act(async () => {
    result.resolve({ status: 'completed', text: 'Wrong credential revision.' });
    await result.promise;
  });

  expect(copy(tree)).not.toContain('Wrong credential revision.');
  expect(copy(tree)).toContain('The writing connection changed. Try again.');
});

test('a stale Use verdict clears the preview without closing or overwriting', async () => {
  const { tree, props } = await render({ onUse: jest.fn(() => false) });

  await ReactTestRenderer.act(async () => {
    control(tree, 'writing-action-improve').props.onPress();
  });
  expect(copy(tree)).toContain('A clearer note.');

  await ReactTestRenderer.act(async () => {
    control(tree, 'writing-use').props.onPress();
  });

  expect(copy(tree)).not.toContain('A clearer note.');
  expect(copy(tree)).toContain('The draft changed. Try again.');
  expect(props.onClose).not.toHaveBeenCalled();
});

test('a failed request changes nothing and retries only after Retry is pressed', async () => {
  const onRequest = jest
    .fn()
    .mockResolvedValueOnce({ status: 'failed', reason: 'network' })
    .mockResolvedValueOnce({ status: 'completed', text: 'Recovered result.' });
  const { tree, props } = await render({ onRequest });

  await ReactTestRenderer.act(async () => {
    control(tree, 'writing-action-shorter').props.onPress();
  });
  expect(props.onUse).not.toHaveBeenCalled();
  expect(onRequest).toHaveBeenCalledTimes(1);
  expect(copy(tree)).toContain(
    'Couldn’t reach the writing provider. Try again.',
  );

  await ReactTestRenderer.act(async () => {
    control(tree, 'writing-retry').props.onPress();
  });
  expect(onRequest).toHaveBeenCalledTimes(2);
  expect(copy(tree)).toContain('Recovered result.');
});

test('the assistant uses a bounded scroll view that can grow for large text and long results', async () => {
  const { tree } = await render();
  const scroll = tree.root.findByProps({ testID: 'writing-assistant-scroll' });

  expect(scroll.type).toBe(ScrollView);
  expect(scroll.props.style).not.toMatchObject({ height: expect.any(Number) });
  expect(scroll.props.style).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ maxHeight: expect.any(Number) }),
    ]),
  );
});
