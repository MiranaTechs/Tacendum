/**
 * Settings → ABOUT: the four rows that discharge obligations, not features.
 *
 * Three separate requirements land on this one section, and every one of
 * them is invisible in normal use — nobody opens Settings to read a licence,
 * so nobody notices when the rows stop working:
 *
 *  - App Store guideline 5.1.1(i) wants the privacy policy reachable INSIDE
 *    the app, not only in App Store Connect metadata.
 *  - AGPL the design requires equivalent source access at the place the binary is
 *    distributed, for THE VERSION CONVEYED. `version.test.ts` pins the URL
 *    to the build; this file proves the row that opens it exists and fires.
 *  - The licence notice has to travel with the binary and be readable
 *    offline — a screen that fetched it would show nothing on a plane.
 *
 * The failure mode these tests guard is a row silently disappearing during
 * an unrelated Settings refactor: the screen still renders, App Lock still
 * works, and the only symptom is a rejection or a licence violation months
 * later.
 */
import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { SettingsScreen } from '../src/screens/SettingsScreen';
import {
  PRIVACY_URL,
  SOURCE_URL,
  TERMS_URL,
  VERSION_LABEL,
} from '../src/version';

// Spy on the real module rather than a `jest.mock` factory: the factory is
// hoisted above the file and may not close over anything, and RN's Linking
// works fine under the test renderer. Same idiom as ChatThread.attach.test.
const { Linking } = require('react-native') as {
  Linking: { openURL: (url: string) => Promise<boolean> };
};
const openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);

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

beforeEach(() => {
  openURL.mockClear();
  openURL.mockResolvedValue(true);
});

describe('Settings → ABOUT', () => {
  it.each([
    ['settings-privacy', PRIVACY_URL],
    ['settings-terms', TERMS_URL],
    ['settings-source', SOURCE_URL],
  ])('%s opens %s', async (testID, url) => {
    const tree = await render();
    await press(tree, testID);
    expect(openURL).toHaveBeenCalledWith(url);
  });

  it('shows the build it actually is', async () => {
    // The string a bug report quotes and App Review asks about. Derived from
    // the same constant SOURCE_URL is built from, so a version bump cannot
    // move one without the other.
    const tree = await render();
    const line = tree.root.findByProps({ testID: 'settings-version' });
    expect(String(line.props.children.join(''))).toContain(VERSION_LABEL);
  });

  it('carries the licence notice offline, with the libsignal limit intact', async () => {
    const tree = await render();
    await press(tree, 'settings-licenses');

    const body = tree.root.findByProps({ testID: 'settings-licenses-body' })
      .props.children as string;

    expect(body).toContain('GNU Affero General Public License version 3');
    // COPYING.iOS exists to make this unmissable: Mirana's App Store
    // permission  reaches Mirana's own code and CANNOT reach
    // libsignal, which Signal owns. A notice that omitted this would be
    // actively misleading — worse than no notice.
    expect(body).toContain('libsignal');
    expect(body).toMatch(/does not and cannot cover libsignal/i);
    expect(body).toContain('Signal Messenger, LLC');
    expect(body).toContain('NO WARRANTY');
    // No network call to render it.
    expect(openURL).not.toHaveBeenCalled();
  });

  it('returns to the menu from the licence screen', async () => {
    const tree = await render();
    await press(tree, 'settings-licenses');
    expect(
      tree.root.findAllByProps({ testID: 'settings-licenses-body' }).length,
    ).toBeGreaterThan(0);

    // Shared with the PIN flows — CancelLink carries one testID for every
    // screen it backs out of.
    await press(tree, 'settings-pin-cancel');

    expect(
      tree.root.findAllByProps({ testID: 'settings-licenses-body' }),
    ).toHaveLength(0);
    expect(
      tree.root.findAllByProps({ testID: 'settings-privacy' }).length,
    ).toBeGreaterThan(0);
  });

  it('a link that cannot open does not break the screen', async () => {
    // Reference links, not actions. The realistic failure is a device with
    // no https handler, and a red error box on a screen someone opened to
    // read a licence helps nobody.
    openURL.mockRejectedValueOnce(new Error('no handler'));
    const tree = await render();

    await expect(press(tree, 'settings-privacy')).resolves.toBeUndefined();
    expect(
      tree.root.findAllByProps({ testID: 'settings-terms' }).length,
    ).toBeGreaterThan(0);
  });
});
