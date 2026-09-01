/**
 * A double-tap on the submit key must not run
 * two concurrent unlocks (the second wiped real data via the old boot
 * catch). The pad latches while a verdict is in flight and after success.
 */
import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import * as lock from '../src/lock';
import { LockScreen } from '../src/screens/LockScreen';

async function render(
  onUnlocked: (v: 'real' | 'duress') => void,
): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<LockScreen onUnlocked={onUnlocked} />);
  });
  return tree;
}

test('a double-tap on submit produces exactly one verify and one unlock', async () => {
  let release!: (v: Awaited<ReturnType<typeof lock.verify>>) => void;
  const verify = jest
    .spyOn(lock, 'verify')
    .mockImplementation(() => new Promise(resolve => (release = resolve)));
  const cooldown = jest
    .spyOn(lock, 'cooldownRemainingMs')
    .mockResolvedValue(0);
  const onUnlocked = jest.fn();
  try {
    const tree = await render(onUnlocked);
    for (const digit of ['1', '2', '3', '4']) {
      await ReactTestRenderer.act(async () => {
        tree.root.findByProps({ testID: `pin-key-${digit}` }).props.onPress();
      });
    }
    const submit = tree.root.findByProps({ testID: 'pin-submit' });
    // Two taps in the same tick — the busy STATE cannot have re-rendered yet,
    // so only a synchronous latch can stop the second.
    await ReactTestRenderer.act(async () => {
      submit.props.onPress();
      submit.props.onPress();
    });
    release({ verdict: 'real' });
    await ReactTestRenderer.act(async () => {});

    expect(verify).toHaveBeenCalledTimes(1);
    expect(onUnlocked).toHaveBeenCalledTimes(1);
  } finally {
    verify.mockRestore();
    cooldown.mockRestore();
  }
});
