/**
 * Settings → ACCOUNT: the two one-line doors.
 *
 * What these tests hold, and why each matters:
 *
 *  1. THE ROWS EXIST AND ARE LABELED FROM THE DECKS. Both labels ride the
 *     device-noun chokepoints (linkingCopy.ts / accountsCopy.ts), never a
 *     literal in SettingsScreen — asserted by comparing the rendered label
 *     to the deck slot itself, so a future "just inline it" refactor fails
 *     here before it fails the copy sweeps.
 *
 *  2. EACH ROW FIRES ITS OWN CALLBACK AND NOTHING ELSE. The screen does not
 *     navigate itself; App.tsx owns the route — the same inversion every
 *     other screen uses.
 *
 *  3. THE WIRING NAVIGATES, AGAINST THE REAL APP: from the settings route,
 *     pressing each row lands the router on linkedDevices / accountEmail
 *     (read through the dev route probe — the destination screens' own
 *     content is already under its own suites).
 *
 * The failure mode guarded is the Settings.about one: a row silently
 * disappearing in an unrelated refactor — the roster and email surfaces
 * stay fully functional and completely unreachable, which is exactly the
 * deferral this landing closed.
 */
import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import App from '../App';
import { ACCOUNTS_COPY } from '../src/accountsCopy';
import { LINKING_COPY } from '../src/linkingCopy';
import { SettingsScreen } from '../src/screens/SettingsScreen';

async function renderSettings(handlers: {
  onBack?: () => void;
  onOpenLinkedDevices?: () => void;
  onOpenAccountEmail?: () => void;
}): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(
      <SettingsScreen
        onBack={handlers.onBack ?? (() => {})}
        onOpenLinkedDevices={handlers.onOpenLinkedDevices ?? (() => {})}
        onOpenAccountEmail={handlers.onOpenAccountEmail ?? (() => {})}
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

async function enterAccount(
  tree: ReactTestRenderer.ReactTestRenderer,
): Promise<void> {
  await press(tree, 'settings-category-account');
}

describe('Settings → ACCOUNT (screen level)', () => {
  it('renders both entries, labeled from the copy decks — never a literal here', async () => {
    const tree = await renderSettings({});
    await enterAccount(tree);
    const devices = tree.root.findByProps({
      testID: 'settings-linked-devices',
    });
    const email = tree.root.findByProps({ testID: 'settings-account-email' });
    // The label IS the deck slot: linkingCopy.ts owns row 23's words,
    // accountsCopy.ts owns row 29a's. device-noun.test.ts pins the slots'
    // bytes per idiom; this pins that the screen actually reads them.
    // (findByProps lands on the MenuRow composite, whose `label` prop is
    // both the row text and its accessibilityLabel.)
    expect(devices.props.label).toBe(LINKING_COPY.settingsRow);
    expect(email.props.label).toBe(ACCOUNTS_COPY.settingsRow);
  });

  it('the linked-devices row fires its callback, and only its callback', async () => {
    const onBack = jest.fn();
    const onOpenLinkedDevices = jest.fn();
    const onOpenAccountEmail = jest.fn();
    const tree = await renderSettings({
      onBack,
      onOpenLinkedDevices,
      onOpenAccountEmail,
    });
    await enterAccount(tree);
    await press(tree, 'settings-linked-devices');
    expect(onOpenLinkedDevices).toHaveBeenCalledTimes(1);
    expect(onOpenAccountEmail).not.toHaveBeenCalled();
    expect(onBack).not.toHaveBeenCalled();
  });

  it('the email row fires its callback, and only its callback', async () => {
    const onBack = jest.fn();
    const onOpenLinkedDevices = jest.fn();
    const onOpenAccountEmail = jest.fn();
    const tree = await renderSettings({
      onBack,
      onOpenLinkedDevices,
      onOpenAccountEmail,
    });
    await enterAccount(tree);
    await press(tree, 'settings-account-email');
    expect(onOpenAccountEmail).toHaveBeenCalledTimes(1);
    expect(onOpenLinkedDevices).not.toHaveBeenCalled();
    expect(onBack).not.toHaveBeenCalled();
  });
});

// --- the wiring, against the real App ---------------------------------------

type Nav = (route: { name: string; [key: string]: unknown }) => void;
const devNav = () =>
  (globalThis as unknown as Record<string, unknown>).TacendumDevNav as Nav;
const devRoute = () =>
  (globalThis as unknown as Record<string, unknown>).TacendumDevRoute as string;

async function flush(): Promise<void> {
  for (let i = 0; i < 60; i++) await Promise.resolve();
}

describe('Settings → ACCOUNT (App wiring)', () => {
  it('each entry navigates: settings → linkedDevices, settings → accountEmail', async () => {
    let tree!: ReactTestRenderer.ReactTestRenderer;
    await ReactTestRenderer.act(async () => {
      tree = ReactTestRenderer.create(<App />);
    });
    await ReactTestRenderer.act(async () => {
      await flush();
    });

    devNavTo('settings');
    await enterAccount(tree);
    await press(tree, 'settings-linked-devices');
    expect(devRoute()).toBe('linkedDevices');

    devNavTo('settings');
    await enterAccount(tree);
    await press(tree, 'settings-account-email');
    expect(devRoute()).toBe('accountEmail');

    // Unmount inside act: the landing cursor and boot effects tick on past
    // the end of the test otherwise (the App.test.tsx lesson).
    await ReactTestRenderer.act(async () => {
      tree.unmount();
    });

    function devNavTo(name: string): void {
      ReactTestRenderer.act(() => {
        devNav()({ name });
      });
      expect(devRoute()).toBe(name);
    }
  });
});
