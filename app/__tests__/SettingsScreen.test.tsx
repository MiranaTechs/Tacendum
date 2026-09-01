/**
 * The Settings App Lock flows, hardened: the mismatch
 * error must actually render; enabling must generate the decoy BEFORE
 * enabling the lock (and surface a failure); duress mutations must persist
 * for the session so a probing coercer sees a consistent story.
 */
import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import * as decoy from '../src/decoy';
import * as lock from '../src/lock';
import { SettingsScreen } from '../src/screens/SettingsScreen';
import { session } from '../src/session';

const keychain = (
  jest.requireMock('tacendum-crypto') as { __keychain: Map<string, string> }
).__keychain;

async function render(): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<SettingsScreen
      onBack={() => {}}
      onOpenLinkedDevices={() => {}}
      onOpenAccountEmail={() => {}}
    />);
  });
  return tree;
}

async function press(
  tree: ReactTestRenderer.ReactTestRenderer,
  testID: string,
): Promise<void> {
  await ReactTestRenderer.act(async () => {
    tree.root.findByProps({ testID }).props.onPress();
  });
}

async function typeCode(
  tree: ReactTestRenderer.ReactTestRenderer,
  code: string,
): Promise<void> {
  for (const digit of code) await press(tree, `pin-key-${digit}`);
  await press(tree, 'pin-submit');
}

beforeEach(() => {
  keychain.clear();
  session.setMode('real');
});

test('a confirm-code mismatch shows its error instead of silently restarting', async () => {
  const tree = await render();
  await press(tree, 'settings-lock-enable');
  await typeCode(tree, '111222');
  await typeCode(tree, '111333'); // mismatch

  const error = tree.root.findAllByProps({ testID: 'settings-pin-error' });
  expect(error.length).toBeGreaterThan(0);
});

test('enable generates the decoy before enabling the lock; a decoy failure enables nothing', async () => {
  const setup = jest
    .spyOn(decoy, 'setupDecoy')
    .mockRejectedValueOnce(new Error('sqlite full'));
  try {
    const tree = await render();
    await press(tree, 'settings-lock-enable');
    await typeCode(tree, '111222');
    await typeCode(tree, '111222');
    await press(tree, 'settings-lock-commit');

    expect(setup).toHaveBeenCalled();
    expect(keychain.has('lock.enabled')).toBe(false);
    expect(keychain.has('lock.passcode')).toBe(false);
    expect(
      tree.root.findAllByProps({ testID: 'settings-commit-error' }).length,
    ).toBeGreaterThan(0);
  } finally {
    setup.mockRestore();
  }
});

test('a duress "disable" stays disabled across a Settings remount in the same session', async () => {
  await lock.setup('123456');
  session.setMode('duress');

  const first = await render();
  await press(first, 'settings-lock-disable');
  await typeCode(first, '654321'); // the code the coercer knows
  // The real Keychain is untouched…
  expect(keychain.get('lock.enabled')).toBe('1');

  // …but a fresh Settings mount in the SAME session must keep the story.
  const second = await render();
  expect(
    second.root.findAllByProps({ testID: 'settings-lock-enable' }).length,
  ).toBeGreaterThan(0);
});
