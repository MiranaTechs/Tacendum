import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { SettingsScreen } from '../src/screens/SettingsScreen';
import * as calling from '../src/call';

/**
 * Settings → CALLS: the app-wide always-relay switch.
 *
 * `setAlwaysRelay` shipped, worked, and was called from NO screen. The
 * published terms and privacy policy both describe "an app-wide always-relay
 * switch that overrides every per-person memory" — a control a person could
 * read about and never find. A setting with no surface is the same defect as a
 * surface with no setting, and neither shows up in a unit test of the piece
 * that does exist.
 *
 * FALSIFIERS, run at authoring time, restored, with what went red:
 *  - have `chooseRelay` set React state and NOT call `setAlwaysRelay`: 3 of 5
 *    fail while the chips still move — exactly the shape of a switch that
 *    appears to work and changes nothing.
 *  - remove the row's testIDs, i.e. no row at all — the shipped state this
 *    file exists to make impossible: 4 of 5 fail.
 *  - drop `testID="settings-relay-note"`: 1 fails, the disclosure.
 */

const keychain = (
  jest.requireMock('tacendum-crypto') as { __keychain: Map<string, string> }
).__keychain;

jest.mock('../src/api', () => ({
  apiDeletePushToken: jest.fn(async () => undefined),
  apiRegisterPushToken: jest.fn(async () => undefined),
  apiTurnCredentials: jest.fn(async () => ({ iceServers: [], ttlSeconds: 3600 })),
}));

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

function selected(
  tree: ReactTestRenderer.ReactTestRenderer,
  testID: string,
): boolean {
  return tree.root.findByProps({ testID }).props.accessibilityState
    .selected as boolean;
}

beforeEach(async () => {
  keychain.clear();
  calling.resetCallingForTests();
  await calling.loadAlwaysRelay();
});

afterEach(() => {
  calling.resetCallingForTests();
});

describe('Settings → CALLS', () => {
  it('offers the switch, and starts from the loaded preference', async () => {
    const tree = await render();
    expect(selected(tree, 'settings-relay-off')).toBe(true);
    expect(selected(tree, 'settings-relay-on')).toBe(false);
  });

  it('turning it on changes what the call module will actually do', async () => {
    // The assertion that matters: not that a chip is highlighted, but that
    // the module the controller reads per call now says yes.
    const tree = await render();
    await press(tree, 'settings-relay-on');

    expect(calling.alwaysRelayEnabled()).toBe(true);
    expect(selected(tree, 'settings-relay-on')).toBe(true);
  });

  it('persists the choice past a relaunch', async () => {
    const tree = await render();
    await press(tree, 'settings-relay-on');

    // The process ends; the module's in-memory value goes with it.
    calling.resetCallingForTests();
    expect(calling.alwaysRelayEnabled()).toBe(false);
    await calling.loadAlwaysRelay();

    expect(calling.alwaysRelayEnabled()).toBe(true);
    expect(keychain.get('tacendum.alwaysRelay')).toBe('1');
  });

  it('turns back off, and that persists too', async () => {
    const tree = await render();
    await press(tree, 'settings-relay-on');
    await press(tree, 'settings-relay-off');

    calling.resetCallingForTests();
    await calling.loadAlwaysRelay();
    expect(calling.alwaysRelayEnabled()).toBe(false);
    expect(keychain.get('tacendum.alwaysRelay')).toBe('0');
  });

  it('states the cost before the switch is thrown, not after', async () => {
    // Every claim in this note is one the Privacy Policy also makes. The
    // three that must survive an edit: relaying costs latency, the relay sees
    // traffic but not content, and the first call is protected either way —
    // without that last one, "Off" reads as "hand my address to strangers".
    const tree = await render();
    const note = tree.root.findByProps({ testID: 'settings-relay-note' }).props
      .children as string;

    expect(note).toMatch(/IP address/);
    expect(note).toMatch(/first call/i);
    expect(note).toMatch(/longer to connect/i);
    expect(note).toMatch(/how much you send/i);
    expect(note).toMatch(/hear none of it/i);
  });
});
