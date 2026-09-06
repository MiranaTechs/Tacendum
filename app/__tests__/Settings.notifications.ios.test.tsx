/**
 * The notification-settings door is ANDROID
 * ONLY, and this is the pin that keeps it that way.
 *
 * Its note says sounds and vibration are set in the system settings and that
 * Tacendum cannot change them after the first launch. That is a statement
 * about Android notification channels — on iOS the sound switch on this very
 * screen does govern the extension's banner sound, so the sentence would be
 * false and the row would be a door to a page that answers a question this
 * platform does not have.
 *
 * jest's default Platform is iOS, so this suite needs no mock: it is the
 * platform the app ships as, asserting an absence.
 */
import React from 'react';
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
}

const has = (testID: string): boolean =>
  tree.root.findAllByProps({ testID }).length > 0;
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

test('no notification-settings row, no note, no ring ⓘ on iOS', async () => {
  await render();
  expect(has('settings-notification-settings')).toBe(false);
  expect(has('settings-ring-info')).toBe(false);
  expect(rendered()).not.toContain('Notification settings');
  expect(rendered()).not.toContain('are set in the system settings');
});

test('the NOTIFICATIONS section this platform DOES own is still all there', async () => {
  // The falsifier for the absence above: a suite that rendered nothing at
  // all would pass every assertion in the first case.
  await render();
  expect(has('settings-preview-full')).toBe(true);
  expect(has('settings-push-on')).toBe(true);
  expect(has('settings-sound-on')).toBe(true);
});
