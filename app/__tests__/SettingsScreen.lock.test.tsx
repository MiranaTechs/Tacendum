/**
 * The Settings App Lock flow:
 *
 *  - the PIN steps and the final commit need the SYNCHRONOUS
 *    re-entrancy latch LockScreen already carries. A double-tap lands before
 *    the `busy` STATE has re-rendered, so both taps see `busy === false`; here
 *    that burnt two of the five free attempts on one mis-typed code, or ran
 *    `setupDecoy()` twice — two writers each DELETE-then-INSERTing into the
 *    same decoy tables.
 *  - the consent copy on the explain step promised a sign-out that
 *    does not exist. A forgotten code means delete-and-reinstall, which also
 *    loses this identity — and the sentence must say so. */
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
    tree = ReactTestRenderer.create(
      <SettingsScreen
        onBack={() => {}}
        onOpenLinkedDevices={() => {}}
        onOpenAccountEmail={() => {}}
      />,
    );
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

async function typeDigits(
  tree: ReactTestRenderer.ReactTestRenderer,
  code: string,
): Promise<void> {
  for (const digit of code) await press(tree, `pin-key-${digit}`);
}

/** Two taps in the same tick — the busy STATE cannot have re-rendered yet,
 * so only a synchronous latch can stop the second. */
async function doubleTap(
  tree: ReactTestRenderer.ReactTestRenderer,
  testID: string,
): Promise<void> {
  const node = tree.root.findByProps({ testID });
  await ReactTestRenderer.act(async () => {
    node.props.onPress();
    node.props.onPress();
  });
}

beforeEach(() => {
  keychain.clear();
  session.setMode('real');
});

test('a double-tap on the PIN submit runs exactly one verify', async () => {
  await lock.setup('123456');
  let release!: (v: Awaited<ReturnType<typeof lock.verify>>) => void;
  const verify = jest
    .spyOn(lock, 'verify')
    .mockImplementation(() => new Promise(resolve => (release = resolve)));
  try {
    const tree = await render();
    await press(tree, 'settings-lock-change');
    await typeDigits(tree, '123456');
    await doubleTap(tree, 'pin-submit');
    release({ verdict: 'real' });
    await ReactTestRenderer.act(async () => {});

    expect(verify).toHaveBeenCalledTimes(1);
  } finally {
    verify.mockRestore();
  }
});

test('a double-tap on "Turn on App Lock" generates the decoy exactly once', async () => {
  let release!: () => void;
  const setup = jest
    .spyOn(decoy, 'setupDecoy')
    .mockImplementation(() => new Promise<void>(resolve => (release = resolve)));
  try {
    const tree = await render();
    await press(tree, 'settings-lock-enable');
    await typeDigits(tree, '111222');
    await press(tree, 'pin-submit');
    await typeDigits(tree, '111222');
    await press(tree, 'pin-submit');
    await doubleTap(tree, 'settings-lock-commit');
    release();
    await ReactTestRenderer.act(async () => {});

    expect(setup).toHaveBeenCalledTimes(1);
    expect(keychain.get('lock.enabled')).toBe('1');
  } finally {
    setup.mockRestore();
  }
});

test('the explain step names the reinstall cost and never promises a sign-out', async () => {
  const tree = await render();
  await press(tree, 'settings-lock-enable');
  await typeDigits(tree, '111222');
  await press(tree, 'pin-submit');
  await typeDigits(tree, '111222');
  await press(tree, 'pin-submit');

  const rendered = JSON.stringify(tree.toJSON());
  expect(rendered).toContain('There is no way to recover a forgotten code.');
  expect(rendered).toContain('delete and reinstall Tacendum');
  expect(rendered).toContain('nobody can restore it');
  expect(rendered).not.toMatch(/sign out/i);
});

/* ──the give-away code is not the current code ─────────── */

describe('the "current code" step and the duress verdict', () => {
  test('a REAL session refuses the reversed code on "Change code" — it is not the current code', async () => {
    await lock.setup('123456');
    const tree = await render();
    await press(tree, 'settings-lock-change');
    await typeDigits(tree, '654321'); // the give-away code
    await press(tree, 'pin-submit');

    expect(tree.root.findAllByProps({ testID: 'settings-pin-error' }).length).toBeGreaterThan(0);
    expect(JSON.stringify(tree.toJSON())).toContain('Wrong code.');
    // Still on the "current code" step: the change door did not open.
    expect(tree.root.findByProps({ testID: 'settings-pin-prompt' }).props.children).toBe(
      'Enter your current code',
    );
    expect(keychain.get('lock.passcode')).toBe('123456');
  });

  test('a REAL session refuses the reversed code on "Turn off App Lock" — nothing is disabled', async () => {
    await lock.setup('123456');
    const tree = await render();
    await press(tree, 'settings-lock-disable');
    await typeDigits(tree, '654321');
    await press(tree, 'pin-submit');

    expect(tree.root.findAllByProps({ testID: 'settings-pin-error' }).length).toBeGreaterThan(0);
    expect(keychain.get('lock.enabled')).toBe('1');
  });

  test('a DURESS session keeps accepting both codes (rule 16): the coerced change looks like it worked', async () => {
    await lock.setup('123456');
    session.setMode('duress');
    const tree = await render();
    await press(tree, 'settings-lock-change');
    await typeDigits(tree, '654321');
    await press(tree, 'pin-submit');

    expect(tree.root.findAllByProps({ testID: 'settings-pin-error' })).toHaveLength(0);
    expect(tree.root.findByProps({ testID: 'settings-pin-prompt' }).props.children).toBe(
      'Choose a code — 4 to 10 digits',
    );
    // …and the real code opens the same door in duress, exactly as before.
    const second = await render();
    await press(second, 'settings-lock-change');
    await typeDigits(second, '123456');
    await press(second, 'pin-submit');
    expect(second.root.findAllByProps({ testID: 'settings-pin-error' })).toHaveLength(0);
  });
});
