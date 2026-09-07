import React from 'react';
import { AppState, Text, TextInput, type AppStateStatus } from 'react-native';
import ReactTestRenderer from 'react-test-renderer';
import {
  getWritingConnections,
  removeWritingConnection,
  saveWritingConnection,
  selectWritingProvider,
} from '../src/aiWritingService';
import { WritingConnection } from '../src/ui/WritingConnection';

jest.mock('../src/aiWritingService', () => ({
  getWritingConnections: jest.fn(),
  saveWritingConnection: jest.fn(),
  removeWritingConnection: jest.fn(),
  selectWritingProvider: jest.fn(),
}));

const EMPTY = {
  status: 'completed' as const,
  state: {
    selected: null,
    providers: {
      openai: { configured: false },
      anthropic: { configured: false },
    },
  },
};

const OPENAI_SAVED = {
  status: 'completed' as const,
  state: {
    selected: 'openai' as const,
    providers: {
      openai: { configured: true },
      anthropic: { configured: false },
    },
  },
};

function control(tree: ReactTestRenderer.ReactTestRenderer, testID: string) {
  return tree.root.findAll(
    node =>
      node.props.testID === testID && typeof node.props.onPress === 'function',
  )[0]!;
}

function controlState(
  tree: ReactTestRenderer.ReactTestRenderer,
  testID: string,
) {
  return tree.root.findAll(
    node =>
      node.props.testID === testID &&
      node.props.accessibilityState !== undefined,
  )[0]!.props.accessibilityState;
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
  props: React.ComponentProps<typeof WritingConnection> = {},
) {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<WritingConnection {...props} />);
  });
  return tree;
}

beforeEach(() => {
  jest.clearAllMocks();
  (getWritingConnections as jest.Mock).mockResolvedValue(EMPTY);
  (saveWritingConnection as jest.Mock).mockResolvedValue(OPENAI_SAVED);
  (removeWritingConnection as jest.Mock).mockResolvedValue(EMPTY);
  (selectWritingProvider as jest.Mock).mockResolvedValue(OPENAI_SAVED);
});

test('connection setup explains direct draft processing and separate API billing before save', async () => {
  const tree = await render();
  const words = copy(tree);

  expect(words).toContain('Your draft goes directly to OpenAI or Claude');
  expect(words).toContain(
    'API billing is separate from ChatGPT and Claude subscriptions',
  );
  expect(saveWritingConnection).not.toHaveBeenCalled();
});

test('an empty connection panel can be dismissed without entering a key', async () => {
  const onDone = jest.fn();
  const tree = await render({ onDone });

  await ReactTestRenderer.act(async () => {
    control(tree, 'writing-connection-done').props.onPress();
  });
  expect(onDone).toHaveBeenCalledTimes(1);
  expect(saveWritingConnection).not.toHaveBeenCalled();
});

test('a denied connection read accepts no key and offers an explicit retry', async () => {
  (getWritingConnections as jest.Mock)
    .mockResolvedValueOnce({ status: 'failed', reason: 'not_allowed' })
    .mockResolvedValueOnce(EMPTY);
  const tree = await render();

  expect(copy(tree)).toContain(
    'Writing connections are unavailable. Try again.',
  );
  expect(
    tree.root.findAllByProps({ testID: 'writing-key-input' }),
  ).toHaveLength(0);

  await ReactTestRenderer.act(async () => {
    await control(tree, 'writing-connection-retry').props.onPress();
  });
  expect(tree.root.findByProps({ testID: 'writing-key-input' })).toBeDefined();
  expect(getWritingConnections).toHaveBeenCalledTimes(2);
});

test('saving requires an explicit provider key and never exposes a saved key', async () => {
  const onChanged = jest.fn();
  const onDone = jest.fn();
  const tree = await render({ onChanged, onDone });
  const input = tree.root.findByProps({ testID: 'writing-key-input' });

  expect(input.type).toBe(TextInput);
  expect(input.props.secureTextEntry).toBe(true);
  expect(input.props.value).toBe('');
  expect(controlState(tree, 'writing-key-save')).toMatchObject({
    disabled: true,
  });

  await ReactTestRenderer.act(async () => {
    input.props.onChangeText('  sk-user-secret  ');
  });
  await ReactTestRenderer.act(async () => {
    await control(tree, 'writing-key-save').props.onPress();
  });

  expect(saveWritingConnection).toHaveBeenCalledWith(
    'openai',
    'sk-user-secret',
  );
  expect(onChanged).toHaveBeenCalledTimes(1);
  expect(onDone).toHaveBeenCalledTimes(1);
  await ReactTestRenderer.act(async () => {
    control(tree, 'writing-replace-key').props.onPress();
  });
  expect(
    tree.root.findByProps({ testID: 'writing-key-input' }).props.value,
  ).toBe('');
  expect(copy(tree)).not.toContain('sk-user-secret');
});

test('a rapid double press starts only one secure key save', async () => {
  let finish!: (value: typeof OPENAI_SAVED) => void;
  const pending = new Promise<typeof OPENAI_SAVED>(resolve => {
    finish = resolve;
  });
  (saveWritingConnection as jest.Mock).mockReturnValue(pending);
  const tree = await render();
  await ReactTestRenderer.act(async () => {
    tree.root
      .findByProps({ testID: 'writing-key-input' })
      .props.onChangeText('sk-one-write');
  });
  const save = control(tree, 'writing-key-save').props.onPress;

  ReactTestRenderer.act(() => {
    void save();
    void save();
  });
  expect(saveWritingConnection).toHaveBeenCalledTimes(1);

  await ReactTestRenderer.act(async () => {
    finish(OPENAI_SAVED);
    await pending;
  });
});

test('saved means configured and does not claim the provider verified it', async () => {
  (getWritingConnections as jest.Mock).mockResolvedValue(OPENAI_SAVED);
  const tree = await render();
  const words = copy(tree);

  expect(words).toContain('OpenAI');
  expect(words).toContain('Saved');
  expect(words).not.toMatch(/verified|connected successfully/i);
  await ReactTestRenderer.act(async () => {
    control(tree, 'writing-replace-key').props.onPress();
  });
  expect(
    tree.root.findByProps({ testID: 'writing-key-input' }).props.value,
  ).toBe('');
});

test('choosing a different provider clears the key before it can be saved', async () => {
  const tree = await render();
  const input = tree.root.findByProps({ testID: 'writing-key-input' });

  await ReactTestRenderer.act(async () => {
    input.props.onChangeText('sk-openai-only');
    control(tree, 'writing-provider-anthropic').props.onPress();
  });

  expect(
    tree.root.findByProps({ testID: 'writing-key-input' }).props.value,
  ).toBe('');
  expect(
    control(tree, 'writing-provider-anthropic').props.accessibilityState,
  ).toMatchObject({ selected: true });
  expect(saveWritingConnection).not.toHaveBeenCalled();
});

test('select and remove update saved metadata only after the storage verdict', async () => {
  const BOTH_SAVED = {
    status: 'completed' as const,
    state: {
      selected: 'openai' as const,
      providers: {
        openai: { configured: true },
        anthropic: { configured: true },
      },
    },
  };
  (getWritingConnections as jest.Mock).mockResolvedValue(BOTH_SAVED);
  (selectWritingProvider as jest.Mock).mockResolvedValue({
    ...BOTH_SAVED,
    state: { ...BOTH_SAVED.state, selected: 'anthropic' as const },
  });
  (removeWritingConnection as jest.Mock).mockResolvedValue({
    status: 'completed',
    state: {
      selected: 'openai',
      providers: {
        openai: { configured: true },
        anthropic: { configured: false },
      },
    },
  });
  const onChanged = jest.fn();
  const tree = await render({ onChanged });

  await ReactTestRenderer.act(async () => {
    control(tree, 'writing-provider-anthropic').props.onPress();
  });
  await ReactTestRenderer.act(async () => {
    await control(tree, 'writing-use-anthropic').props.onPress();
  });
  expect(
    control(tree, 'writing-provider-anthropic').props.accessibilityState,
  ).toMatchObject({ selected: true });

  await ReactTestRenderer.act(async () => {
    await control(tree, 'writing-remove-anthropic').props.onPress();
  });
  expect(copy(tree)).not.toContain('Claude\nSaved');
  expect(onChanged).toHaveBeenCalledTimes(2);
});

test('backgrounding clears a typed key and retires an in-flight save result', async () => {
  let appStateHandler: ((state: AppStateStatus) => void) | undefined;
  const addListener = jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation(
      (_event: string, handler: (state: AppStateStatus) => void) => {
        appStateHandler = handler;
        return { remove: jest.fn() } as never;
      },
    );
  let resolveSave!: (value: typeof OPENAI_SAVED) => void;
  const pendingSave = new Promise<typeof OPENAI_SAVED>(done => {
    resolveSave = done;
  });
  (saveWritingConnection as jest.Mock).mockReturnValue(pendingSave);
  const onChanged = jest.fn();
  const onDone = jest.fn();
  const tree = await render({ onChanged, onDone });

  await ReactTestRenderer.act(async () => {
    tree.root
      .findByProps({ testID: 'writing-key-input' })
      .props.onChangeText('sk-must-disappear');
  });
  ReactTestRenderer.act(() => {
    void control(tree, 'writing-key-save').props.onPress();
  });
  ReactTestRenderer.act(() => {
    appStateHandler?.('background');
  });
  expect(
    tree.root.findAllByProps({ testID: 'writing-key-input' }),
  ).toHaveLength(0);
  expect(onDone).toHaveBeenCalledTimes(1);

  await ReactTestRenderer.act(async () => {
    resolveSave(OPENAI_SAVED);
    await pendingSave;
  });
  expect(onChanged).not.toHaveBeenCalled();
  expect(onDone).toHaveBeenCalledTimes(1);
  addListener.mockRestore();
});

test('backgrounding a pending connection read leaves an explicit recovery path', async () => {
  let appStateHandler: ((state: AppStateStatus) => void) | undefined;
  const addListener = jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation(
      (_event: string, handler: (state: AppStateStatus) => void) => {
        appStateHandler = handler;
        return { remove: jest.fn() } as never;
      },
    );
  let resolveRead!: (value: typeof EMPTY) => void;
  const pendingRead = new Promise<typeof EMPTY>(resolve => {
    resolveRead = resolve;
  });
  (getWritingConnections as jest.Mock).mockReturnValue(pendingRead);
  const tree = await render();

  ReactTestRenderer.act(() => {
    appStateHandler?.('background');
  });
  expect(
    tree.root.findAllByProps({ testID: 'writing-connection-loading' }),
  ).toHaveLength(0);
  expect(
    tree.root.findByProps({ testID: 'writing-connection-retry' }),
  ).toBeDefined();

  await ReactTestRenderer.act(async () => {
    resolveRead(EMPTY);
    await pendingRead;
    appStateHandler?.('active');
  });
  expect(
    tree.root.findByProps({ testID: 'writing-connection-retry' }),
  ).toBeDefined();
  addListener.mockRestore();
});
