/**
 * The lock-wipe fix, pinned at its root.
 *
 * RN's `Settings` is iOS-only; its Android fallback WARN-AND-RETURNS-NULL
 * instead of throwing, so `Settings.get(KEY) !== 1` answered true on every
 * Android boot — and App.tsx then ran `lock.clearAll()`, silently wiping an
 * enabled app lock on every launch. The fix is a platform branch, not a
 * Settings shim: on Android the marker is constant-false (uninstall wipes
 * the data the reinstall heal exists to clear, so there is nothing to heal)
 * and `markInstalled()` no-ops. This suite runs the REAL module (the global
 * jest.setup mock is unmocked) under an Android Platform.
 */

jest.unmock('../src/install');

// The REAL RN Settings module throws at require in jest (its TurboModule is
// absent); the failure being pinned is the SHIPPED Android fallback, which
// answers null WITHOUT throwing — so model exactly that.
jest.mock('react-native/Libraries/Settings/Settings', () => ({
  __esModule: true,
  default: { get: jest.fn(() => null), set: jest.fn() },
}));

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

import { isFirstRunAfterInstall, markInstalled } from '../src/install';

const settings = (
  jest.requireMock('react-native/Libraries/Settings/Settings') as {
    default: { get: jest.Mock; set: jest.Mock };
  }
).default;

test('an Android boot NEVER reads as a fresh install', () => {
  // The mocked Settings answers null without throwing — the exact fallback
  // shape that made `get(KEY) !== 1` read true every boot. The branch
  // must answer false WITHOUT even consulting it.
  expect(isFirstRunAfterInstall()).toBe(false);
  // Every boot, not just the first ask — the defect fired on EVERY launch.
  expect(isFirstRunAfterInstall()).toBe(false);
  expect(settings.get).not.toHaveBeenCalled();
});

test('markInstalled is a no-op on Android — nothing to mark, nothing written', () => {
  markInstalled();

  expect(settings.set).not.toHaveBeenCalled();
  // And the marker stays constant-false afterwards: there is no state.
  expect(isFirstRunAfterInstall()).toBe(false);
});
