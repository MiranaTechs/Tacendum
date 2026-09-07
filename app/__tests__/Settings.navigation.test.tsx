import React from 'react';
import { BackHandler, Text } from 'react-native';
import ReactTestRenderer from 'react-test-renderer';
import * as decoy from '../src/decoy';
import * as lock from '../src/lock';
import { SettingsScreen } from '../src/screens/SettingsScreen';
import { session } from '../src/session';

jest.mock('../src/aiWritingService', () => ({
  getWritingConnections: jest.fn(async () => ({
    status: 'completed',
    state: {
      mode: 'external',
      externalProvider: 'chatgpt',
      selected: null,
      providers: {
        openai: { configured: false },
        anthropic: { configured: false },
      },
    },
  })),
  removeWritingConnection: jest.fn(),
  saveWritingConnection: jest.fn(),
  selectExternalWritingProvider: jest.fn(),
  selectWritingProvider: jest.fn(),
}));

const keychain = (
  jest.requireMock('tacendum-crypto') as { __keychain: Map<string, string> }
).__keychain;

const CATEGORY_IDS = [
  'settings-category-account',
  'settings-category-privacy',
  'settings-category-chats',
  'settings-category-notifications',
  'settings-category-appearance',
  'settings-category-writing',
  'settings-category-about',
] as const;

let backHandlers: Array<() => boolean>;

beforeEach(() => {
  keychain.clear();
  session.setMode('real');
  backHandlers = [];
  jest
    .spyOn(BackHandler, 'addEventListener')
    .mockImplementation((_event, handler) => {
      backHandlers.push(handler as () => boolean);
      return { remove: jest.fn() };
    });
});

afterEach(() => {
  jest.restoreAllMocks();
});

async function render(
  props: Partial<React.ComponentProps<typeof SettingsScreen>> = {},
): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(
      <SettingsScreen
        onBack={() => {}}
        onOpenLinkedDevices={() => {}}
        onOpenAccountEmail={() => {}}
        {...props}
      />,
    );
  });
  return tree;
}

function control(
  tree: ReactTestRenderer.ReactTestRenderer,
  testID: string,
): ReactTestRenderer.ReactTestInstance {
  const node = tree.root
    .findAllByProps({ testID })
    .find(item => typeof item.props.onPress === 'function');
  if (!node) throw new Error(`No pressable ${testID}`);
  return node;
}

function button(
  tree: ReactTestRenderer.ReactTestRenderer,
  testID: string,
): ReactTestRenderer.ReactTestInstance {
  const node = tree.root
    .findAllByProps({ testID })
    .find(item => item.props.accessibilityRole === 'button');
  if (!node) throw new Error(`No accessible button ${testID}`);
  return node;
}

async function press(
  tree: ReactTestRenderer.ReactTestRenderer,
  testID: string,
): Promise<void> {
  await ReactTestRenderer.act(async () => {
    control(tree, testID).props.onPress();
  });
}

function has(
  tree: ReactTestRenderer.ReactTestRenderer,
  testID: string,
): boolean {
  return tree.root.findAllByProps({ testID }).length > 0;
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

async function hardwareBack(): Promise<boolean> {
  let consumed = false;
  await ReactTestRenderer.act(async () => {
    consumed = [...backHandlers].reverse().some(handler => handler());
  });
  return consumed;
}

test('the Settings home is seven accessible category rows, without mounted detail controls', async () => {
  const tree = await render();

  expect(
    CATEGORY_IDS.map(testID => button(tree, testID).props.accessibilityRole),
  ).toEqual(Array(7).fill('button'));
  expect(copy(tree)).toContain('Privacy & security');
  expect(copy(tree)).toContain('Chats & calls');
  expect(
    button(tree, 'settings-category-account').props.accessibilityHint,
  ).toMatch(/email|username/i);
  expect(has(tree, 'settings-lock-enable')).toBe(false);
  expect(has(tree, 'settings-account-email')).toBe(false);
  expect(has(tree, 'settings-preview-full')).toBe(false);
});

test('a category mounts only its controls and header back returns through home', async () => {
  const onBack = jest.fn();
  const onSectionChange = jest.fn();
  const tree = await render({ onBack, onSectionChange });

  await press(tree, 'settings-category-privacy');
  expect(has(tree, 'settings-lock-enable')).toBe(true);
  expect(has(tree, 'settings-screensec-on')).toBe(true);
  expect(has(tree, 'settings-account-email')).toBe(false);
  expect(onSectionChange).toHaveBeenLastCalledWith('privacy');

  await press(tree, 'settings-back');
  expect(has(tree, 'settings-category-privacy')).toBe(true);
  expect(has(tree, 'settings-lock-enable')).toBe(false);
  expect(onSectionChange).toHaveBeenLastCalledWith(null);
  expect(onBack).not.toHaveBeenCalled();

  await press(tree, 'settings-back');
  expect(onBack).toHaveBeenCalledTimes(1);
});

test('App Lock returns to Privacy while Writing assistant opens directly and returns home', async () => {
  const tree = await render();

  await press(tree, 'settings-category-privacy');
  await press(tree, 'settings-lock-enable');
  expect(has(tree, 'settings-pin-cancel')).toBe(true);
  await press(tree, 'settings-back');
  expect(has(tree, 'settings-lock-enable')).toBe(true);
  expect(has(tree, 'settings-category-privacy')).toBe(false);
  await press(tree, 'settings-back');

  await press(tree, 'settings-category-writing');
  expect(has(tree, 'writing-connection')).toBe(true);
  expect(
    tree.root.findAll(
      node => node.type === Text && node.props.accessibilityRole === 'header',
    ),
  ).toHaveLength(1);
  await press(tree, 'writing-connection-done');
  expect(has(tree, 'writing-connection')).toBe(false);
  expect(has(tree, 'settings-category-writing')).toBe(true);

  await press(tree, 'settings-category-writing');
  await press(tree, 'settings-back');
  expect(has(tree, 'writing-connection')).toBe(false);
  expect(has(tree, 'settings-category-writing')).toBe(true);
});

test('Android back mirrors header back and a busy App Lock commit cannot be escaped', async () => {
  let release!: () => void;
  jest
    .spyOn(decoy, 'setupDecoy')
    .mockImplementation(
      () => new Promise<void>(resolve => (release = resolve)),
    );
  const backHandlerRef: React.MutableRefObject<(() => boolean) | null> = {
    current: null,
  };
  const tree = await render({ backHandlerRef });

  expect(backHandlerRef.current).toBe(backHandlers[0]);

  await press(tree, 'settings-category-privacy');
  await press(tree, 'settings-lock-enable');
  for (const digit of '111222') await press(tree, `pin-key-${digit}`);
  await press(tree, 'pin-submit');
  for (const digit of '111222') await press(tree, `pin-key-${digit}`);
  await press(tree, 'pin-submit');
  await press(tree, 'settings-lock-commit');

  expect(await hardwareBack()).toBe(true);
  expect(backHandlerRef.current?.()).toBe(true);
  await press(tree, 'settings-back');
  expect(has(tree, 'settings-lock-commit')).toBe(true);

  await ReactTestRenderer.act(async () => release());
  expect(has(tree, 'settings-lock-commit')).toBe(false);
  expect(has(tree, 'settings-lock-change')).toBe(true);
  expect(await hardwareBack()).toBe(true);
  expect(has(tree, 'settings-category-privacy')).toBe(true);

  await ReactTestRenderer.act(async () => tree.unmount());
  expect(backHandlerRef.current).toBe(null);
});

test('a failed App Lock status read keeps independent privacy controls available and can retry', async () => {
  const status = jest
    .spyOn(lock, 'status')
    .mockRejectedValueOnce(new Error('Keychain unavailable'))
    .mockResolvedValueOnce({ enabled: false, autolockSec: 0 });
  const tree = await render();

  await press(tree, 'settings-category-privacy');
  expect(has(tree, 'settings-lock-status-error')).toBe(true);
  expect(has(tree, 'settings-lock-status-retry')).toBe(true);
  expect(has(tree, 'settings-fieldmode-on')).toBe(false);
  expect(has(tree, 'settings-lock-enable')).toBe(false);
  expect(has(tree, 'settings-screensec-on')).toBe(true);
  expect(has(tree, 'settings-shot-info')).toBe(true);
  expect(has(tree, 'settings-links-info')).toBe(true);
  expect(has(tree, 'settings-loss')).toBe(true);

  await press(tree, 'settings-lock-status-retry');
  expect(status).toHaveBeenCalledTimes(2);
  expect(has(tree, 'settings-lock-status-error')).toBe(false);
  expect(has(tree, 'settings-lock-enable')).toBe(true);
  expect(has(tree, 'settings-fieldmode-off')).toBe(true);
});

test('an initial Account section explains verification and deletion outcomes', async () => {
  const tree = await render({ initialSection: 'account' });
  const words = copy(tree);

  expect(words).toMatch(/Verify an email address.*set a username.*search/i);
  expect(words).toContain('Tacendum ID or QR code');
  expect(words).toContain('Deleting your account and starting again');
  expect(words).not.toContain('Other people keep their copies');

  await press(tree, 'settings-account-lifecycle-info');
  const opened = copy(tree);
  expect(opened).toContain('even on the same device');
  expect(opened).toContain('Other people keep their copies of your messages');
  expect(opened).toContain('Other linked devices keep their own accounts');
  expect(opened).toContain(
    'Restarting, updating or offloading Tacendum keeps your ID',
  );
});
