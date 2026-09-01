import { Platform, Settings } from 'react-native';

/**
 * Install marker. The Keychain outlives an app uninstall;
 * NSUserDefaults does not. A boot that finds lock keys in the Keychain but
 * no install marker is a REINSTALL — the data the lock guarded is gone, and
 * demanding a code that protects nothing would brick the fresh start.
 *
 * ANDROID: the heal is iOS-only,
 * forever. Android app data — Keystore key and secret files alike — dies
 * with an uninstall, so a reinstall has nothing to heal. And RN's `Settings`
 * is iOS-only: its Android fallback WARN-AND-RETURNS-NULL instead of
 * throwing, which slipped under the catch below and made every boot read as
 * a fresh install — App.tsx then ran `lock.clearAll()`, silently wiping an
 * enabled app lock on every Android launch. Hence a platform
 * branch, not a Settings shim: constant-false / no-op.
 */

const KEY = 'tacendumInstalled';

export function isFirstRunAfterInstall(): boolean {
  if (Platform.OS === 'android') {
    // Never fresh: uninstall wipes everything the heal exists to clear, and
    // the Settings fallback's null would otherwise read as fresh EVERY boot.
    return false;
  }
  try {
    return Settings.get(KEY) !== 1;
  } catch {
    // If Settings is unavailable, never treat a boot as fresh — clearing a
    // real lock is the worse failure.
    return false;
  }
}

export function markInstalled(): void {
  if (Platform.OS === 'android') {
    // Nothing to mark: the marker only feeds the iOS reinstall heal.
    return;
  }
  try {
    Settings.set({ [KEY]: 1 });
  } catch {
    // best-effort; the next boot tries again
  }
}
