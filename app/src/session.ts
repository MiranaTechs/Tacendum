/**
 * Process-wide session mode. Set exactly once per unlock by
 * App.tsx; consulted by the duress no-op seams (messaging sends, lock
 * mutations, sign-out). Everything else reads the active db workspace and
 * needs no branch.
 */

export type SessionMode = 'real' | 'duress';

/** Session-scoped view of the lock settings shown in the Settings UI. In a
 * duress session, mutations are Keychain no-ops — but the UI must keep
 * telling one consistent story for the whole session, even across Settings
 * remounts (a probing coercer must not see a "disabled" lock snap back).
 * Cleared on every mode change; the next session re-reads the truth. */
export interface LockUiOverride {
  enabled?: boolean;
  autolockSec?: number;
}

let mode: SessionMode = 'real';
let lockUi: LockUiOverride = {};

export const session = {
  get mode(): SessionMode {
    return mode;
  },
  setMode(next: SessionMode): void {
    mode = next;
    lockUi = {};
  },
  get lockUi(): LockUiOverride {
    return lockUi;
  },
  setLockUi(patch: LockUiOverride): void {
    lockUi = { ...lockUi, ...patch };
  },
};
