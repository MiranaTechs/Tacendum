/**
 * THE DEVICE NOUN — the one word user-visible copy uses to name the device it
 * is running on.
 *
 * The first pass branched every device-naming sentence on `Platform.OS`,
 * which was truthful for exactly as long as each platform meant one idiom:
 * "this iPhone" on iOS, "this phone" on Android. Android tablets install
 * today and the iPad family flip is staged, so a
 * per-PLATFORM word now names a device the copy cannot see: "your history
 * lives on this phone" on a Galaxy Tab is wrong in the way this module exists to
 * prevent. This module is the single point of resolution — copy interpolates
 * `DEVICE_NOUN` and never hardcodes a device noun again, so a third platform
 * or a new idiom is one line here instead of another fork at sixty sites
 * (android.copy.divergences.test.ts enforces exactly that).
 *
 * IDIOM-DRIVEN, NEVER WINDOW-DRIVEN — windowClass.ts's rule, inverted, on
 * purpose. The window class asks "how wide is this window right now" and must
 * ignore what the hardware is; the noun asks "what is this device called"
 * and must ignore how wide the window happens to be. A tablet with a
 * phone-width Split View pane is still a tablet, and consent copy that
 * renamed the device on every resize would be describing the window, not the
 * thing the person can lose, block someone on, or have taken from them.
 *
 * How each platform answers:
 *  - iOS: the interface idiom, from `Platform.isPad`. Apple's own two words,
 *    "iPhone" and "iPad" — the rule of speaking the platform's language.
 *  - Android: the classic sw600dp cut, from the SCREEN's smaller dimension in
 *    dp (`Dimensions.get('screen')` — the display, not the app window, so
 *    multi-window cannot flip it). Android has no branded noun, so the
 *    platform's own words are "phone" and "tablet".
 *  - Anything else (no such build ships today — desktop is deferred): "device", the noun that is never wrong, merely vague.
 *
 * A PLAIN CONSTANT, resolved once at module load, exactly like the
 * `Platform.OS` branches it replaces: the copy decks (blocking.ts,
 * safety.ts, vault.ts…) are module-scope constants, so the noun must be one
 * too. A foldable that boots on its cover screen keeps "phone" for the life
 * of the process — acceptable, and honest either way for a device that is
 * both things at once.
 *
 * Grammar contract, kept by every consumer: the noun is a bare singular that
 * follows an article or determiner already in the sentence ("this iPhone",
 * "A lost phone", "every iPad"), never sentence-initial, and uppercases
 * whole ("THIS IPHONE") for the Menlo captions. No current string needs
 * an a/an choice against the noun itself.
 */

import { Dimensions, Platform } from 'react-native';

export type DeviceNoun = 'iPhone' | 'iPad' | 'phone' | 'tablet' | 'device';

/** The Material/Android sw600dp tablet cut, in dp. Deliberately NOT
 * theme.ts's windowClass.mediumMin even though both are 600: that one
 * classifies a WINDOW and may drift with layout design; this one classifies
 * HARDWARE and follows Android's smallest-width convention. */
const TABLET_MIN_SMALLEST_DP = 600;

function resolveDeviceNoun(): DeviceNoun {
  if (Platform.OS === 'ios') return Platform.isPad ? 'iPad' : 'iPhone';
  if (Platform.OS === 'android') {
    const { width, height } = Dimensions.get('screen');
    return Math.min(width, height) >= TABLET_MIN_SMALLEST_DP
      ? 'tablet'
      : 'phone';
  }
  return 'device';
}

/** The word for "the device this copy is rendering on", mid-sentence form. */
export const DEVICE_NOUN: DeviceNoun = resolveDeviceNoun();

/* ── the account-slot class ─────────────── */

/** The two device-slot classes a v1 ceremony can occupy (desktop is a schema
 * reservation the server refuses). Defined HERE, in
 * the one module allowed to spell device nouns, because the values ARE
 * nouns and the copy sweeps rightly refuse them anywhere else. NOT a
 * rendering-model enum: the UI stays width-class-driven
 * — these name the SLOT a device occupies in an
 * account group, never how a window lays out. */
export type DeviceSlotClass = 'phone' | 'tablet';
export const DEVICE_SLOT_CLASSES: readonly DeviceSlotClass[] = ['phone', 'tablet'];

/** THIS device's slot class — the same idiom facts as the noun (an iPad or
 * an sw600dp Android is the tablet slot; everything else the phone slot),
 * resolved once at module load like the noun itself. Consumed by the
 * linking ceremony's class declaration and nothing
 * else — rendering keeps reading the window class, never this. */
export const DEVICE_SLOT_CLASS: DeviceSlotClass =
  DEVICE_NOUN === 'iPad' || DEVICE_NOUN === 'tablet' ? 'tablet' : 'phone';
