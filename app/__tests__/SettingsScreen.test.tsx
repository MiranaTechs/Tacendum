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

/* ──an optimistic chip whose write fails snaps back ─────── */

describe('a failed setting write reverts the chip and says so', () => {
  const selected = (tree: ReactTestRenderer.ReactTestRenderer, testID: string): boolean =>
    tree.root.findByProps({ testID }).props.accessibilityState.selected as boolean;

  test('read receipts: the chip goes back to On and an inline error sits under the row', async () => {
    const readReceipts = require('../src/readReceipts') as typeof import('../src/readReceipts');
    const write = jest
      .spyOn(readReceipts, 'setReadReceipts')
      .mockRejectedValueOnce(new Error('keychain unavailable'));
    try {
      const tree = await render();
      expect(selected(tree, 'settings-receipts-on')).toBe(true);
      await press(tree, 'settings-receipts-off');

      expect(write).toHaveBeenCalledWith(false);
      expect(selected(tree, 'settings-receipts-on')).toBe(true);
      expect(selected(tree, 'settings-receipts-off')).toBe(false);
      expect(tree.root.findAllByProps({ testID: 'settings-receipts-error' }).length).toBeGreaterThan(0);
      expect(readReceipts.readReceiptsEnabled()).toBe(true);
    } finally {
      write.mockRestore();
    }
  });

  test('a later successful write clears the error', async () => {
    const readReceipts = require('../src/readReceipts') as typeof import('../src/readReceipts');
    const write = jest
      .spyOn(readReceipts, 'setReadReceipts')
      .mockRejectedValueOnce(new Error('keychain unavailable'));
    try {
      const tree = await render();
      await press(tree, 'settings-receipts-off');
      expect(tree.root.findAllByProps({ testID: 'settings-receipts-error' }).length).toBeGreaterThan(0);
      await press(tree, 'settings-receipts-off');
      expect(selected(tree, 'settings-receipts-off')).toBe(true);
      expect(tree.root.findAllByProps({ testID: 'settings-receipts-error' })).toHaveLength(0);
    } finally {
      write.mockRestore();
    }
  });

  test('auto-lock: a failed write puts the previous choice back, in state and in the session override', async () => {
    await lock.setup('123456');
    const write = jest.spyOn(lock, 'setAutolock').mockRejectedValueOnce(new Error('keychain unavailable'));
    try {
      const tree = await render();
      expect(selected(tree, 'settings-autolock-0')).toBe(true);
      await press(tree, 'settings-autolock-300');
      expect(selected(tree, 'settings-autolock-0')).toBe(true);
      expect(selected(tree, 'settings-autolock-300')).toBe(false);
      expect(session.lockUi.autolockSec ?? 0).toBe(0);
      expect(tree.root.findAllByProps({ testID: 'settings-autolock-error' }).length).toBeGreaterThan(0);
    } finally {
      write.mockRestore();
    }
  });
});

/* ──teaching paragraphs behind the ⓘ, under their rows ── */

describe('the teaching paragraphs sit behind a ⓘ under their own row', () => {
  const text = (tree: ReactTestRenderer.ReactTestRenderer): string => JSON.stringify(tree.toJSON());
  /** The ⓘ's testID lands on the disclosure composite first, so the press
   * names the node that actually carries onPress. */
  const openInfo = async (tree: ReactTestRenderer.ReactTestRenderer, testID: string) => {
    const node = tree.root.findAllByProps({ testID }).find(n => n.props.onPress !== undefined)!;
    await ReactTestRenderer.act(async () => {
      node.props.onPress();
    });
  };

  test('receipts, typing, previews and the screenshot note ship closed and open in place', async () => {
    const tree = await render();
    const closed = text(tree);
    expect(closed).not.toContain('Read is a fact about');
    expect(closed).not.toContain('Typing shows someone you are writing');
    expect(closed).not.toContain('decrypts the message to show it');
    expect(closed).not.toContain('Screenshots can’t be blocked');

    await openInfo(tree, 'settings-receipts-info');
    expect(text(tree)).toContain('Read is a fact about');
    await openInfo(tree, 'settings-typing-info');
    expect(text(tree)).toContain('Typing shows someone you are writing');
    await openInfo(tree, 'settings-preview-info');
    expect(text(tree)).toContain('decrypts the message to show it');
    await openInfo(tree, 'settings-shot-info');
    expect(text(tree)).toContain('Screenshots can’t be blocked');
  });

  test('the consent-grade one-liners stay visible: the push token and the relay IP disclosure', async () => {
    const tree = await render();
    const push = tree.root.findByProps({ testID: 'settings-push-note' }).props.children as string;
    expect(push).toContain('deletes the token');
    const relay = tree.root.findByProps({ testID: 'settings-relay-note' }).props.children as string;
    expect(relay).toContain('IP address');
  });
});
