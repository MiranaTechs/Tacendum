// The refusal type only — erased at compile time, so this file stays pure
// and the device-noun suite can load it without react-native. Taken from the
// call BARREL rather than from `call/controller`, which is the boundary
// `src/call/index.ts` re-exported the class to keep.
import type { CallRefusedError } from './call';

/**
 * WHY A CALL DID NOT HAPPEN.
 *
 * `ensurePermissions` has always returned a written sentence for a denied
 * microphone and `placeCall` has always thrown a reason enum — and every call
 * site discarded both. So the first call a new person placed with the
 * microphone denied did nothing at all: no ring, no error, no screen. The
 * same was true of a redial from the Calls tab to a blocked peer, which made
 * that whole row's button dead.
 *
 * The sentences live here, in one place, for two reasons. A refusal is copy,
 * and copy belongs in a deck the product voice can be read off in one sitting
 * — not spelled inline at three call sites that then drift. And the thrown
 * `Error` message is NEVER what a person reads: `CallRefusedError` carries
 * 'peer is blocked' for a log, and the class stays the contract while the
 * sentence below is what the screen shows.
 *
 * The sentences avoid device-specific nouns. "Settings" is the app's own
 * screen on both platforms.
 */
export const CALL_REFUSAL = {
  /**
   * The one sentence with a second home: `call/index.ts`'s
   * `ensurePermissions` still spells it as a literal, and
   * CallsScreen.refusal.test.tsx asserts the two are byte-identical so they
   * cannot drift.
   */
  micDenied: 'Microphone access is off. Turn it on in Settings to make calls.',
  busy: 'You are already in a call.',
  blocked: 'You blocked them. Unblock them from their profile to call.',
  identityChanged:
    'Their safety number changed. Compare it on their profile before you call.',
} as const;

/**
 * The sentence for a thrown refusal's reason.
 *
 * Total over `CallRefusedError`'s own reason union rather than a `switch`
 * with a default, so a new reason on the class is a COMPILE ERROR here
 * instead of a Call button that goes quiet again.
 */
export const CALL_REFUSAL_FOR: Record<CallRefusedError['reason'], string> = {
  blocked: CALL_REFUSAL.blocked,
  identity_changed: CALL_REFUSAL.identityChanged,
  busy: CALL_REFUSAL.busy,
};
