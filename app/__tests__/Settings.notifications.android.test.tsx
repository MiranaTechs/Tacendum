/**
 * An Android door where the copy already points.
 *
 * Five notification channels are created in Kotlin, and a channel's sound,
 * vibration and importance CANNOT be changed by the app after creation. That
 * is exactly why the Android arm of the sound note promises only the in-app
 * tone and points at the system's own settings for Tacendum — and then
 * offers no way to get there. This adds the row, the note that says what it
 * opens, and one ⓘ about the full-screen ring the call module owes a
 * Settings line for.
 *
 * WHAT SHIPS IS `Linking.openSettings()`, and the sentence says so. That
 * call lands on the app-info page, not the channel page; the sharper
 * `sendIntent('android.settings.APP_NOTIFICATION_SETTINGS', …)` upgrade
 * needs a device to confirm the extra key lands, so it is booked as a device
 * check and the softened sentence is the shipped default rather than a
 * choice made in flight.
 */

jest.mock('react-native/Libraries/Utilities/Platform', () => ({
  __esModule: true,
  default: {
    OS: 'android',
    select: (spec: Record<string, unknown>) =>
      'android' in spec
        ? spec.android
        : 'native' in spec
          ? spec.native
          : spec.default,
    Version: 35,
    isTesting: true,
  },
}));

// A PHONE's screen, explicitly (P3): the deck resolves its device noun over
// the screen's smaller dimension, and the preset's default Dimensions mock
// would classify as a tablet.
jest.mock('react-native/Libraries/Utilities/Dimensions', () => ({
  __esModule: true,
  default: {
    get: () => ({ width: 393, height: 852, scale: 3, fontScale: 1 }),
    set: jest.fn(),
    addEventListener: jest.fn(() => ({ remove: jest.fn() })),
  },
}));

import React from 'react';
import { Linking } from 'react-native';
import ReactTestRenderer from 'react-test-renderer';
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
  await press('settings-category-notifications');
}

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

const rendered = (): string => JSON.stringify(tree.toJSON());

beforeEach(() => {
  keychain.clear();
  session.setMode('real');
});

afterEach(async () => {
  await ReactTestRenderer.act(async () => {
    tree?.unmount();
  });
  jest.restoreAllMocks();
});

test('the row is there, and it opens the settings the note names', async () => {
  const open = jest
    .spyOn(Linking, 'openSettings')
    .mockResolvedValue(undefined as unknown as void);
  await render();

  expect(rendered()).toContain('Notification settings');
  await press('settings-notification-settings');
  expect(open).toHaveBeenCalledTimes(1);
});

test('the note says where the button lands, not where we wish it landed', async () => {
  await render();
  const note = rendered();
  // The softened sentence LEADS, because it is the load-bearing half: it is
  // the only part of the note that says what the button does.
  expect(note).toContain(
    'Opens Tacendum’s settings, where notifications are listed',
  );
  expect(note).toContain(
    'sounds, vibration and how loudly a notification arrives are set there, not here',
  );
  expect(note).not.toMatch(/opens the channel|takes you to the channel/i);
  // …and it no longer opens by restating what the Message sounds note two
  // rows above already tells an Android reader about the system settings.
  expect(note).not.toContain('are set in the system settings, not here');
});

test('the full-screen ring is disclosed, behind the ⓘ', async () => {
  await render();
  expect(rendered()).not.toContain('takes over the screen only if the system');
  await press('settings-ring-info');
  const open = rendered();
  expect(open).toContain(
    'An incoming call takes over the screen only if the system allows it.',
  );
  expect(open).toContain('a call arrives as a banner you tap');
  // AND IT STOPS THERE. The button above is `openSettings()`, which lands on
  // the app-info page; the full-screen ring is a separate special-app-access
  // permission (this app's own Kotlin carries a dedicated intent for it), so
  // "The button above opens the setting" sent a reader somewhere the setting
  // is not — and contradicted the note two lines up on the same screen.
  expect(open).not.toContain('The button above opens the setting');
  expect(open).not.toMatch(/the button above/i);
});

test('it sits at the FOOT of NOTIFICATIONS, under the rows it cannot change', async () => {
  await render();
  const tree_ = rendered();
  // The row is a door out of the app, so it goes last: everything above it
  // is a setting this screen owns, and it is the one that admits what it
  // does not.
  expect(tree_.indexOf('Notification settings')).toBeGreaterThan(
    tree_.indexOf('Message sounds'),
  );
  expect(tree_.indexOf('Notification settings')).toBeLessThan(
    tree_.indexOf('Calls that take over the screen'),
  );
  expect(
    tree.root.findAllByProps({ testID: 'settings-appearance-light' }),
  ).toHaveLength(0);
});
