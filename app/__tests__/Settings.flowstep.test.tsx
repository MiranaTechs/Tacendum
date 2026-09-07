/**
 * The three Settings bugs that only show on the SUB-STEPS.
 *
 * (a) The `APP LOCK` RuledLabel is not gated on `flow.step`, while the sheet
 * under it is — so tapping "Open-source licenses" prints a section
 * heading for a feature you are not looking at across the top of the
 * AGPL notice. The FIELD MODE block immediately above is gated
 * correctly, which is what makes this an oversight rather than a design.
 * (b) The confirmation `InlineNotice` sits outside the same guard, so a
 * stale "App Lock is on." paints over the PIN flow and the Licenses
 * view — a sentence about a step you have already left.
 * (c) The commit control is a raw Pressable with a static label, while
 * `commit` awaits `setupDecoy()` — which fabricates a whole decoy
 * workspace. The person taps and nothing visibly happens for as long as
 * that takes.
 */
import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import * as decoy from '../src/decoy';
import { SettingsScreen } from '../src/screens/SettingsScreen';
import { session } from '../src/session';

const keychain = (
  jest.requireMock('tacendum-crypto') as { __keychain: Map<string, string> }
).__keychain;

let tree: ReactTestRenderer.ReactTestRenderer;

async function render(): Promise<void> {
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(
      <SettingsScreen
        onBack={() => {}}
        onOpenLinkedDevices={() => {}}
        onOpenAccountEmail={() => {}}
      />,
    );
  });
}

/** The testID lands on the composite AND its host node once a control is a
 * shared primitive, so every read names the node that carries the prop. */
const propOf = (testID: string, prop: string): unknown => {
  const node = tree.root
    .findAllByProps({ testID })
    .find(n => n.props[prop] !== undefined);
  if (!node) throw new Error(`no node with testID ${testID} carries ${prop}`);
  return node.props[prop];
};

async function press(testID: string): Promise<void> {
  await ReactTestRenderer.act(async () => {
    (propOf(testID, 'onPress') as () => void)();
  });
}

async function typeCode(code: string): Promise<void> {
  for (const digit of code) await press(`pin-key-${digit}`);
  await press('pin-submit');
}

const rendered = (): string => JSON.stringify(tree.toJSON());

beforeEach(() => {
  keychain.clear();
  session.setMode('real');
});

afterEach(async () => {
  await ReactTestRenderer.act(async () => {
    tree?.unmount();
  });
});

test('the Licenses page is the Licenses page — no APP LOCK heading over it', async () => {
  await render();
  await press('settings-category-privacy');
  expect(rendered()).toContain('APP LOCK');
  await press('settings-back');
  await press('settings-category-about');
  await press('settings-licenses');

  expect(rendered()).toContain('Licenses');
  expect(rendered()).not.toContain('APP LOCK');
});

test('a stale confirmation does not paint over the PIN flow or the Licenses view', async () => {
  // The decoy is a whole fabricated workspace and this suite has no
  // database; the notice is what is under test, not the generation.
  const setup = jest.spyOn(decoy, 'setupDecoy').mockResolvedValue(undefined);
  try {
    await render();
    await press('settings-category-privacy');
    await press('settings-lock-enable');
    await typeCode('111222');
    await typeCode('111222');
    await press('settings-lock-commit');
    // The notice belongs to the Privacy category where it was earned.
    expect(rendered()).toContain('App Lock is on.');

    await press('settings-lock-change');
    expect(rendered()).not.toContain('App Lock is on.');

    // …and it is gone from the licenses step too, which is reached from the
    // category the notice IS allowed to paint on.
    await press('settings-pin-cancel');
    expect(rendered()).toContain('App Lock is on.');
    await press('settings-back');
    await press('settings-category-about');
    await press('settings-licenses');
    expect(rendered()).not.toContain('App Lock is on.');
  } finally {
    setup.mockRestore();
  }
});

test('the commit control says it is working while the decoy is being built', async () => {
  let release!: () => void;
  const setup = jest
    .spyOn(decoy, 'setupDecoy')
    .mockImplementation(
      () => new Promise<void>(resolve => (release = resolve)),
    );
  try {
    await render();
    await press('settings-category-privacy');
    await press('settings-lock-enable');
    await typeCode('111222');
    await typeCode('111222');

    const before = propOf('settings-lock-commit', 'accessibilityState') as {
      busy?: boolean;
    };
    expect(before.busy).toBe(false);

    await press('settings-lock-commit');
    const during = propOf('settings-lock-commit', 'accessibilityState') as {
      busy?: boolean;
    };
    expect(during.busy).toBe(true);
    expect(rendered()).toContain('Setting up…');

    await ReactTestRenderer.act(async () => {
      release();
    });
    expect(setup).toHaveBeenCalledTimes(1);
  } finally {
    setup.mockRestore();
  }
});
