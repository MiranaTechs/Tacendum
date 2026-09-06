import { useEffect, useState } from 'react';
import { alwaysRelayEnabled, silenceUnknownCallersEnabled } from './call';
import {
  fieldModeActive,
  fieldModeDuressRows,
  type FieldModeState,
} from './fieldMode';
import * as lock from './lock';
import { previewLevel } from './previews';
import { screenSecurity } from './screenSecurity';
import { session } from './session';

/**
 * Whether Field Mode is on, for a surface that is not the Settings screen
 * itself. `useReduceMotion`'s shape: a hook that reads a fact the app
 * already holds and re-reads it where it can change.
 *
 * DERIVED, NEVER REMEMBERED — the whole design decision of `fieldMode.ts`,
 * carried to a second address. There is no stored on/off bit anywhere, so
 * this hook computes the same conjunction over the same values the Settings
 * screen renders: `previewLevel()`, `alwaysRelayEnabled()`,
 * `silenceUnknownCallersEnabled()`, `screenSecurity.blankEnabled`, and App
 * Lock's own state. Change any mapped row by hand and both surfaces say Off
 * together. A remembered "on" that disagreed with the rows it describes
 * would be worse than no indicator at all.
 *
 * THE DURESS PRECEDENCE IS SETTINGS' OWN, deliberately, line for line
 * (`SettingsScreen.tsx`): in a coerced session the module's session-scoped
 * shadow answers first, then the getters. In a duress session the mapped
 * rows have already been reset to their defaults before the decoy opens, so
 * the derivation lands on Off — and if the coercer moves the rows
 * themselves, the shadow remembers it and this line agrees with the chip.
 * The line is the same fact at a second address, never a new one, so it can
 * add no discriminator (rule 16).
 *
 * OFF UNTIL THE LOCK ANSWERS. `lock.status()` is a Keychain read, so it
 * lands after the first paint; the hook reports Off until then rather than
 * claiming a posture it has not finished reading. One extra render, in the
 * safe direction.
 *
 * STALENESS IS NOT A PROBLEM HERE, and that is a property of the router
 * rather than of this hook: nothing is keep-alive, so the screens that use
 * it remount on every return from Settings.
 */
export function useFieldModeActive(): boolean {
  const [lockState, setLockState] = useState<{
    enabled: boolean;
    autolockSec: number;
  } | null>(null);

  useEffect(() => {
    let live = true;
    void lock
      .status()
      .then(status => {
        if (!live) return;
        // The session override wins over the Keychain, exactly as Settings
        // reads it: in duress the mutations are Keychain no-ops, and the
        // session must tell ONE story.
        setLockState({
          enabled: session.lockUi.enabled ?? status.enabled,
          autolockSec: session.lockUi.autolockSec ?? status.autolockSec,
        });
      })
      .catch(() => {
        // Unreadable is not "off": leaving it unknown keeps the answer Off,
        // which claims nothing.
      });
    return () => {
      live = false;
    };
  }, []);

  if (lockState === null) return false;

  const duressRows = session.mode === 'duress' ? fieldModeDuressRows() : null;
  const state: FieldModeState = {
    previewLevel: duressRows?.previewLevel ?? previewLevel(),
    relayEveryCall: duressRows?.relayEveryCall ?? alwaysRelayEnabled(),
    silenceUnknownCallers:
      duressRows?.silenceUnknownCallers ?? silenceUnknownCallersEnabled(),
    blankWhileCaptured:
      duressRows?.blankWhileCaptured ?? screenSecurity.blankEnabled,
    lockEnabled: lockState.enabled,
    autolockSec: lockState.autolockSec,
  };
  return fieldModeActive(state);
}
