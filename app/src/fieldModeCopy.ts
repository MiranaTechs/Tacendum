import { Platform } from 'react-native';

/**
 * The Field Mode copy deck (`fieldMode.ts` is the logic; this is every word
 * the row shows).
 *
 * Its own file, the `accountsCopy.ts` / `linkingCopy.ts` rule: a deck a test
 * can assert against by IDENTITY, so a sentence cannot be re-typed slightly
 * differently in a test and quietly diverge from what ships.
 *
 * THE RULES THIS DECK IS WRITTEN UNDER, each one checkable and each one
 * pinned by `__tests__/fieldMode.settings.test.tsx`:
 *
 *  - AN AFFORDANCE IS A CLAIM. Every effect named below is a control that
 *    exists in this build and that this switch actually moves. Nothing here
 *    describes disappearing messages: that timer is per conversation and
 *    agreed with the other person, there is no global control, and no row
 *    exists for it.
 *  - NO PROTECTIVE ADJECTIVE. The list of what changes IS the claim. There is
 *    no word here about seizure, extraction, a compelled unlock, or being
 *    unreachable — this switch sets five preferences and nothing else can be
 *    promised on its behalf. The name is "Field Mode" and never anything
 *    dramatic.
 *  - NO DEVICE NOUN. `DEVICE_NOUN` and the literals it stands in for are
 *    deliberately absent: the Android copy sweep walks every string under
 *    `app/src`, and a device-naming template here would need a new
 *    Android copy-divergence row. Sentences are
 *    written round the noun instead ("this app", "the screen", "your
 *    notifications").
 *  - THE RESTORE SENTENCE IS EXACT, INCLUDING WHERE IT DOES NOT HOLD. Off
 *    puts back the settings that were in force when Field Mode was turned
 *    on — and because the chip is DERIVED, it can read On for somebody who
 *    set those four values by hand and never tapped it, with no snapshot
 *    anywhere. `fieldMode.clearFieldMode` then lands on the shipped defaults,
 *    which for that person means undoing two settings they chose
 *    deliberately. The behaviour is right; an unconditional promise about it
 *    would not be, so the ⓘ names the case.
 *  - THE NOTIFICATION EFFECT IS STATED AS SHIPPED. `previewLevel: 'none'`
 *    does not suppress the notification: it still arrives and reads
 *    "New message" (`previews.ts` levels table; `TacendumNSE/PreviewPolicy.swift`
 *    "beyond \"New message\""). "Notifications show nothing" would read as
 *    "no notification appears", and the person this switch is for would find
 *    out otherwise from a banner lighting up in front of somebody.
 *
 * The screenshot line is INFORMATIONAL and platform-branched: both platforms
 * are always-on and unsettable, in opposite directions, and Field Mode turned
 * on neither. Saying so is the only honest thing a Field Mode row can do with
 * the subject. Both arms are exported so the copy tests can walk the one that
 * did not compile into this process's deck.
 */

/**
 * The screenshot sentence, per platform, named rather than inlined: the
 * ternary below resolves at import time, so a test running as one platform
 * can never see the other arm through `FIELD_MODE_COPY`.
 */
export const FIELD_MODE_SCREENSHOT_LINES = {
  ios:
    'Screenshots cannot be blocked. When one is taken in a conversation, ' +
    'the conversation says so — on both sides. That is always true, with ' +
    'Field Mode on or off.',
  android:
    'Screenshots and screen recordings are refused by the system, so ' +
    'nothing is announced in a conversation — there is nothing to ' +
    'announce. That is always true, with Field Mode on or off.',
} as const;

export const FIELD_MODE_COPY = {
  sectionLabel: 'FIELD MODE',
  label: 'Field Mode',
  options: [
    { label: 'On', value: true },
    { label: 'Off', value: false },
  ],
  /** The consent-grade one-liner that stays VISIBLE under the chips: what
   * the one tap does, and that Off undoes it. */
  consent:
    'On: notifications say only “New message”, every call goes through ' +
    'the relay, calls from people you have never messaged stay silent, and ' +
    'messages are covered while the screen is shared or recorded. Off puts ' +
    'back the settings that were in force when you turned it on.',
  /** Appended to the line above only while App Lock is on, because only then
   * does Field Mode touch auto-lock. */
  consentAutolock: 'With App Lock on, it also sets Auto-lock to Right away.',
  /** The unactionable status under the row when App Lock is off. Not a link
   * and not a chip: turning App Lock on needs the code ceremony, which a
   * switch cannot honestly stand in for. */
  needsLock:
    'Auto-lock is not part of this while App Lock is off — there is nothing ' +
    'to lock. Turning Field Mode on still does everything else.',
  infoLines: [
    'Field Mode is not a separate mode. It is one tap that moves settings ' +
      'that already exist on this screen, and Off puts each of them back the ' +
      'way it was when you turned it on.',
    'On sets four of them: notifications say only “New message” — not the ' +
      'sender’s name, not a word of the message; every call goes through the ' +
      'relay instead of connecting directly; calls from people you have ' +
      'never exchanged a message with arrive silently and appear in Calls as ' +
      'missed; and messages are covered while the screen is shared or ' +
      'recorded. When App Lock is on, Auto-lock is set to Right away as ' +
      'well. The costs are the ones each of those rows already names: ' +
      'relayed calls take longer to connect and can sound worse, and a ' +
      'banner no longer tells you who messaged you.',
    'It reads On only while all of those are still set that way. Change any ' +
      'one of them by hand and it reads Off again — this switch describes ' +
      'those settings, it does not outrank them.',
    'If Field Mode was never turned on here — you had set these yourself, ' +
      'or the record of what was there is gone — then there is nothing to ' +
      'put back, and Off returns them to their original defaults.',
    Platform.OS === 'android'
      ? FIELD_MODE_SCREENSHOT_LINES.android
      : FIELD_MODE_SCREENSHOT_LINES.ios,
  ],
} as const;
