/**
 * Delete account re-authenticates with the App Lock code when the lock is
 * on. Deletion is the one irreversible verb on this screen, and an unlocked
 * phone handed over for a moment must not be enough to fire it. Rule 16
 * holds: a REAL session accepts only the real verdict (the give-away code
 * opens nothing real); a DURESS session accepts either, and `deleteAccount`
 * itself runs the decoy-wipe branch there. */

jest.mock('react-native-image-picker', () => ({
  launchImageLibrary: jest.fn(),
  launchCamera: jest.fn(),
}));
jest.mock('../src/registration', () => ({
  createOrRestoreAccount: jest.fn(),
  deleteAccount: jest.fn(async () => undefined),
}));

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import type { ProfileRow } from '../src/db';
import * as lock from '../src/lock';
import { ProfileScreen } from '../src/screens/ProfileScreen';
import { session } from '../src/session';

const reg = jest.requireMock('../src/registration') as { deleteAccount: jest.Mock };
const keychain = (
  jest.requireMock('tacendum-crypto') as { __keychain: Map<string, string> }
).__keychain;

const PROFILE: ProfileRow = {
  userId: '01KYDBSSDJSPC9J0E5N2AWMJ5Y',
  registrationId: 7,
  displayName: 'Ana',
  about: '',
  avatarB64: '',
  profileVersion: 1,
};

let onSignedOut: jest.Mock;

async function render(): Promise<ReactTestRenderer.ReactTestRenderer> {
  onSignedOut = jest.fn();
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(
      <ProfileScreen
        profile={PROFILE}
        onBack={jest.fn()}
        onProfileChanged={jest.fn()}
        onOpenSettings={jest.fn()}
        onSignedOut={onSignedOut}
      />,
    );
  });
  return tree;
}

/** The control itself: a Pressable's host View carries no `onPress`. */
function control(tree: ReactTestRenderer.ReactTestRenderer, id: string) {
  return tree.root.find(n => n.props.testID === id && typeof n.props.onPress === 'function');
}

const has = (tree: ReactTestRenderer.ReactTestRenderer, id: string): boolean =>
  tree.root.findAllByProps({ testID: id }).length > 0;

async function press(tree: ReactTestRenderer.ReactTestRenderer, id: string) {
  await ReactTestRenderer.act(async () => {
    control(tree, id).props.onPress();
  });
}

async function typeDigits(tree: ReactTestRenderer.ReactTestRenderer, code: string) {
  for (const digit of code) await press(tree, `pin-key-${digit}`);
}

/** Two taps in the same tick — the `signingOut` STATE cannot have re-rendered
 * yet, so only a synchronous latch can stop the second (the LockScreen
 * precedent, and the same latch one screen over in Settings). */
async function doubleTap(tree: ReactTestRenderer.ReactTestRenderer, id: string) {
  const node = control(tree, id);
  await ReactTestRenderer.act(async () => {
    node.props.onPress();
    node.props.onPress();
  });
}

beforeEach(() => {
  keychain.clear();
  session.setMode('real');
  reg.deleteAccount.mockClear();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('with App Lock on', () => {
  test('the confirm panel asks for the code; "Delete my account" waits for it, and its keypad submit says what it does', async () => {
    await lock.setup('123456');
    const tree = await render();
    expect(has(tree, 'pin-submit')).toBe(false);
    await press(tree, 'profile-sign-out');
    expect(has(tree, 'pin-submit')).toBe(true);
    expect(JSON.stringify(tree.toJSON())).toContain('Enter your code to delete.');
    expect(control(tree, 'pin-submit').props.accessibilityLabel).toBe('Delete my account');
    expect(control(tree, 'profile-sign-out-confirm').props.disabled).toBe(true);
    await typeDigits(tree, '1234');
    expect(control(tree, 'profile-sign-out-confirm').props.disabled).toBe(false);
    tree.unmount();
  });

  test('a REAL session refuses a wrong code and the give-away code alike; the real code deletes', async () => {
    await lock.setup('123456');
    const tree = await render();
    await press(tree, 'profile-sign-out');

    await typeDigits(tree, '111111');
    await press(tree, 'profile-sign-out-confirm');
    expect(reg.deleteAccount).not.toHaveBeenCalled();
    expect(has(tree, 'sign-out-error')).toBe(true);
    expect(JSON.stringify(tree.toJSON())).toContain('Wrong code.');

    await typeDigits(tree, '654321'); // the duress code is not the real code
    await press(tree, 'pin-submit');
    expect(reg.deleteAccount).not.toHaveBeenCalled();
    expect(onSignedOut).not.toHaveBeenCalled();

    await typeDigits(tree, '123456');
    await press(tree, 'pin-submit');
    expect(reg.deleteAccount).toHaveBeenCalledTimes(1);
    expect(onSignedOut).toHaveBeenCalledTimes(1);
    tree.unmount();
  });

  test('a DURESS session accepts either code (rule 16): the coerced delete looks like it worked', async () => {
    await lock.setup('123456');
    session.setMode('duress');
    const tree = await render();
    await press(tree, 'profile-sign-out');
    await typeDigits(tree, '654321');
    await press(tree, 'profile-sign-out-confirm');
    // `deleteAccount` runs its decoy-wipe branch in duress (registration.ts);
    // this screen only has to hand the verb on as if nothing were unusual.
    expect(reg.deleteAccount).toHaveBeenCalledTimes(1);
    expect(onSignedOut).toHaveBeenCalledTimes(1);
    tree.unmount();
  });

  test('a cooldown verdict is said as a cooldown, and deletes nothing', async () => {
    await lock.setup('123456');
    jest.spyOn(lock, 'verify').mockResolvedValue({ verdict: 'cooldown', retryInMs: 30_000 });
    const tree = await render();
    await press(tree, 'profile-sign-out');
    await typeDigits(tree, '1111');
    await press(tree, 'profile-sign-out-confirm');
    expect(reg.deleteAccount).not.toHaveBeenCalled();
    expect(JSON.stringify(tree.toJSON())).toContain('Too many tries.');
    tree.unmount();
  });

  test('a double-tap on the keypad submit runs exactly one verify, and deletes once', async () => {
    await lock.setup('123456');
    let release!: (verdict: lock.LockVerdict) => void;
    const verify = jest
      .spyOn(lock, 'verify')
      .mockImplementation(() => new Promise(resolve => (release = resolve)));
    try {
      const tree = await render();
      await press(tree, 'profile-sign-out');
      await typeDigits(tree, '123456');
      await doubleTap(tree, 'pin-submit');
      release({ verdict: 'real' });
      await ReactTestRenderer.act(async () => {});

      // Two verifies would burn two of the five free attempts on one
      // mistyped code — and, on the right one, delete twice.
      expect(verify).toHaveBeenCalledTimes(1);
      expect(reg.deleteAccount).toHaveBeenCalledTimes(1);
      expect(onSignedOut).toHaveBeenCalledTimes(1);
      tree.unmount();
    } finally {
      verify.mockRestore();
    }
  });
});

describe('with App Lock off', () => {
  test('no keypad: the confirm deletes as before', async () => {
    const tree = await render();
    await press(tree, 'profile-sign-out');
    expect(has(tree, 'pin-submit')).toBe(false);
    expect(control(tree, 'profile-sign-out-confirm').props.disabled).toBe(false);
    await press(tree, 'profile-sign-out-confirm');
    expect(reg.deleteAccount).toHaveBeenCalledTimes(1);
    expect(onSignedOut).toHaveBeenCalledTimes(1);
    tree.unmount();
  });

  test('a double-tap on the confirm deletes exactly once', async () => {
    const tree = await render();
    await press(tree, 'profile-sign-out');
    await doubleTap(tree, 'profile-sign-out-confirm');
    expect(reg.deleteAccount).toHaveBeenCalledTimes(1);
    expect(onSignedOut).toHaveBeenCalledTimes(1);
    tree.unmount();
  });
});
