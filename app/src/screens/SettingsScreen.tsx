import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  BackHandler,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { ACCOUNT_LIFECYCLE_COPY } from '../accountLifecycleCopy';
import { ACCOUNTS_COPY } from '../accountsCopy';
import { ACCOUNTS_USERNAME_COPY } from '../accountsUsernameCopy';
import { appearanceChoice, setAppearanceChoice } from '../appearance';
import { setupDecoy } from '../decoy';
import * as db from '../db';
import { DEVICE_NOUN } from '../deviceNoun';
import {
  FIELD_VALUES,
  fieldModeActive,
  fieldModeDuressRows,
  recordFieldModeDuressRows,
  setFieldMode,
  type FieldModeState,
} from '../fieldMode';
import { FIELD_MODE_COPY } from '../fieldModeCopy';
import { LINKING_COPY } from '../linkingCopy';
import * as lock from '../lock';
import { LOSS_COPY } from '../lossCopy';
import { messageSoundEnabled, setMessageSound } from '../messageSound';
import { previewLevel, setPreviewLevel, type PreviewLevel } from '../previews';
import { readReceiptsEnabled, setReadReceipts } from '../readReceipts';
import {
  setTypingIndicators,
  typingIndicatorsEnabled,
} from '../typingIndicators';
import {
  alwaysRelayEnabled,
  restorePushTokens,
  setAlwaysRelay,
  setSilenceUnknownCallers,
  silenceUnknownCallersEnabled,
  withdrawPushTokens,
} from '../call';
import { pushTransport } from '../background';
import { pushTokensAllowed } from '../pushConsent';
import { screenSecurity } from '../screenSecurity';
import { session } from '../session';
import { useTheme } from '../theme';
import { USERNAME_UI_ENABLED } from '../usernameUi';
import { PRIVACY_URL, SOURCE_URL, TERMS_URL, VERSION_LABEL } from '../version';
import { ChoiceRow } from '../ui/ChoiceRow';
import { WritingConnection } from '../ui/WritingConnection';
import { InfoDisclosure } from '../ui/InfoDisclosure';
import { PinPad } from '../ui/PinPad';
import {
  InlineError,
  InlineNotice,
  PrimaryButton,
  RuledLabel,
  ScreenHeader,
  TextAction,
} from '../ui/primitives';

/**
 * Minimal Settings surface hosting the App Lock section.
 * Sized to absorb the call settings the call design needs later.
 *
 * Every mutation here goes through seams that are silent no-ops in a duress
 * session: a coerced "change the passcode" or "turn it off"
 * appears to succeed and changes nothing.
 *
 * THE ACCOUNT PIN SECTION IS GONE (cost table row
 * 1). It defended one thing — an SMS code alone taking over an account — and
 * there is no SMS code any more, so the whole section was mechanism guarding a
 * threat that no longer exists. Its two routes are deleted in K6, which is the
 * other half of the reason it had to come out here: a shipped build must not
 * be putting a toggle in front of someone that 404s when they use it.
 *
 * With it goes the last ambiguity between the two PINs this app used to have.
 * "Code" now means one thing: the App Lock code below.
 */

/**
 * Auto-lock help is exported separately for each platform so both versions
 * remain testable even though COPY selects one at module load.
 *
 * iOS keeps the app foregrounded during its photo picker and permission
 * prompts. Android backgrounds it, so immediate auto-lock also locks during
 * those actions. No excursion latch suppresses that lock; the help must
 * describe this behavior and change if the behavior changes.
 * Neither version names a particular kind of device.
 */
export const AUTOLOCK_INFO_LINES = {
  ios:
    'Right away locks Tacendum the moment you leave it. Choosing a photo or ' +
    'answering a system prompt does not count as leaving.',
  android:
    'Right away locks Tacendum the moment you leave it — including while you ' +
    'choose a photo or answer a system prompt, because those hand the screen ' +
    'to another app for a moment. If that gets in your way, one minute is ' +
    'the smaller step.',
} as const;

const COPY = {
  title: 'Settings',
  categories: [
    {
      id: 'account',
      title: 'Account',
      summary: USERNAME_UI_ENABLED
        ? 'Email, username and linked devices'
        : 'Email and linked devices',
    },
    {
      id: 'privacy',
      title: 'Privacy & security',
      summary: 'Field Mode, App Lock, screen sharing and links',
    },
    {
      id: 'chats',
      title: 'Rooms & calls',
      summary: 'Receipts, typing indicators and call privacy',
    },
    {
      id: 'notifications',
      title: 'Notifications',
      summary: 'Message previews and sounds',
    },
    {
      id: 'appearance',
      title: 'Appearance',
      summary: 'Light, dark or automatic',
    },
    {
      id: 'writing',
      title: 'Writing assistant',
      summary: 'Choose how you rewrite and translate',
    },
    {
      id: 'about',
      title: 'About',
      summary: 'Policies, source code, licenses and version',
    },
  ],
  // The two account entries. The LABELS live in the
  // linking/accounts copy decks — the device-noun chokepoints — never here.
  accountSection: 'ACCOUNT',
  linkedDevicesRow: LINKING_COPY.settingsRow,
  accountEmailRow: ACCOUNTS_COPY.settingsRow,
  // The username door: rendered ONLY under the
  // build-pinned USERNAME_UI_ENABLED — a dark binary has neither the door
  // nor the room. Label from the username deck, never a literal here.
  accountUsernameRow: ACCOUNTS_USERNAME_COPY.settingsRow,
  lockSection: 'APP LOCK',
  lockStatusLoading: 'Loading App Lock…',
  lockStatusFailed: 'Couldn’t load App Lock settings. Try again.',
  retry: 'Retry',
  enableRow: 'Turn on App Lock',
  changeRow: 'Change code',
  resetDecoysRow: 'Rebuild decoy rooms',
  /** Lock now. Not destructive, so it sits above the irreversible
   * row and needs no confirmation — but it DOES end a call, and a control
   * that takes something away without saying so is the defect this deck
   * spends most of its length avoiding. */
  lockNowRow: 'Lock now',
  lockNowNote: 'Locking now also ends a call in progress.',
  disableRow: 'Turn off App Lock',
  autolockLabel: 'Auto-lock',
  autolockOptions: [
    { label: 'Right away', value: 0 },
    { label: '1 min', value: 60 },
    { label: '5 min', value: 300 },
  ],
  /** The ⓘ beside Auto-lock. Its label says what the disclosure is
   * ABOUT, the house rule for every ⓘ in this app. */
  autolockInfoLabel: 'When Tacendum locks itself',
  autolockInfo: [
    Platform.OS === 'android'
      ? AUTOLOCK_INFO_LINES.android
      : AUTOLOCK_INFO_LINES.ios,
    // True on both platforms, so it is not an arm: the timed choices are a
    // grace period, not a weaker lock, and the sentence says the lock still
    // happens either way.
    'One minute and five minutes give you that long to come back without ' +
      'typing your code again. Tacendum locks on its own either way.',
  ],
  enterPrompt: 'Choose a code — 4 to 10 digits',
  confirmPrompt: 'Enter the same code again',
  currentPrompt: 'Enter your current code',
  mismatch: 'The codes didn’t match. Start over.',
  wrong: 'Wrong code.',
  cooldown: 'Too many tries. Wait a bit, then try again.',
  explainTitle: 'One code, two doors',
  // The device is named in the platform's own words via the token wherever
  // a sentence names it. The forgotten-code cost is the TRUE one: there is
  // no sign-out (registration.ts — the keypair IS the account, and it lives
  // only here), so a forgotten code means delete-and-reinstall, which also
  // loses this identity. The old sentence promised a door that does not
  // exist.
  explain: `Unlock with your code and Tacendum opens your rooms. Enter the same code backwards and it opens a decoy instead — invented people, unreadable messages — while your real rooms stay sealed.\n\nThere is no way to recover a forgotten code. You would have to delete and reinstall Tacendum on this ${DEVICE_NOUN}, which also loses this identity — nobody can restore it.`,
  confirmEnable: 'Turn on App Lock',
  confirmChange: 'Use this code',
  /** What the commit control says while `setupDecoy()` fabricates the whole
   * decoy workspace. The ellipsis is the character, matching
   * `namingCopy`'s 'Saving…' and LinkedDevices' 'Working…'. */
  commitBusy: 'Setting up…',
  enabled: 'App Lock is on.',
  changed: 'Code changed.',
  disabled: 'App Lock is off.',
  decoysRebuilt: 'Decoy rooms rebuilt.',
  cancel: 'Cancel',
  /** The way out of a step you only READ. 'Cancel' is right on the PIN
   * steps, where a person started something that can be abandoned; on the
   * Licences notice and the loss page nothing was started, and asking
   * someone to cancel a thing they did not start misstates the action.
   * 'Done' simply returns from the read-only page. */
  done: 'Done',
  failed: 'Something went wrong. Nothing was changed — try again.',
  /** A row's write failed: the chip has already snapped back, so the
   * sentence says only what is true. */
  settingFailed: 'That change did not save. Nothing was changed — try again.',
  /**
   * The one ⓘ label every row's teaching paragraph sits behind: the
   * paragraph explains the row it hangs under. */
  infoLabel: 'What this changes',
  shotLabel: 'Screenshots and recordings',
  /** The link disclosure. `linkRuns.stripTracking` makes the
   * address that OPENS differ from the address that is SHOWN — a good
   * difference, and one a person must be TOLD about rather than discover,
   * because an app quietly editing an address before opening it is exactly
   * the kind of thing this product refuses to do silently. One line, beside
   * the section's other teaching copy. */
  linksLabel: 'Links',
  linksNote:
    'Tacendum takes the tracking tags off a link before it opens — the ones ' +
    'that tell a site which message you came from. The rest of the address ' +
    'is untouched, and the link you see is the one you were sent.',
  screenSection: 'SCREEN',
  blankLabel: 'Hide messages while the screen is shared or recorded',
  blankOptions: [
    { label: 'On', value: true },
    { label: 'Off', value: false },
  ],
  // The label says "Apple", not "notifications", because the
  // switch is not about whether notifications appear — it is about whether a
  // token identifying this device sits on our server at all. Someone who
  // declined the notification prompt still has one, which is precisely the
  // surprise this control exists to undo.
  //
  // The Android label stays "a push service" across BOTH build states: on the websocket-only build no
  // push service is involved and no token exists — the switch is the
  // standing rule over wake tokens, honored by never registering one; on the
  // FCM build (google-services.json present at compile time) the push
  // service is Google's and the note below names it. One label, because the
  // RULE the switch states is the same rule either way.
  pushLabel:
    Platform.OS === 'android'
      ? `Let a push service wake this ${DEVICE_NOUN}`
      : `Let Apple wake this ${DEVICE_NOUN}`,
  pushOptions: [
    { label: 'On', value: true },
    { label: 'Off', value: false },
  ],
  // The cost, stated before the switch is thrown rather than discovered
  // afterwards by a missed call.
  //
  // The Android arm asks the BINARY which truth to tell:
  // `pushTransport()` reads a native constant compiled from the same
  // file-presence check that wired Firebase in, so an FCM build describes
  // Google's token and its deletion, and a websocket-only build keeps the
  // no-token sentence that has always been true of it. Consent-grade copy
  // must describe the running app, never an intention — this branch is how the
  // conditional is stated to the person it affects.
  pushNote:
    Platform.OS === 'android'
      ? pushTransport() === 'fcm'
        ? `Google gives this ${DEVICE_NOUN} a token that lets Tacendum be woken while it is closed — a call can ring and a message can announce itself even when the ${DEVICE_NOUN} has cut Tacendum’s own connection. The token identifies this ${DEVICE_NOUN} and is stored on our servers; it never carries your words, because the wake carries no content at all — messages and calls themselves still arrive only over Tacendum’s own connection. Turning this off deletes that token from our servers, and none may be registered again while it stays off. Calls will then ring and messages announce themselves only while Tacendum’s own connection is up.`
        : `No push service wakes this ${DEVICE_NOUN}: there is no Google service in the app, and no token identifying this ${DEVICE_NOUN} sits on our servers. Messages and calls arrive over Tacendum’s own connection — the ongoing “Connected” notification is that connection at work. This switch is the standing rule for wake tokens: while it is off, none may ever be registered for this ${DEVICE_NOUN}.`
      : `Apple gives every ${DEVICE_NOUN} a token that lets a call ring it while Tacendum is closed, whether or not you allowed notifications. Turning this off deletes that token from our servers. Calls will only reach you while the app is open, and messages will arrive with no notification.`,
  /** The consent-grade one-liner that stays VISIBLE under the push chips:
   * what Off does to the token, per binary — the paragraph above moves
   * behind the row's ⓘ. The websocket-only Android build has no token to
   * delete, so its sentence states the standing rule instead. */
  pushConsent:
    Platform.OS === 'android'
      ? pushTransport() === 'fcm'
        ? `Off deletes the token that lets Google wake this ${DEVICE_NOUN} from our servers.`
        : `No token identifying this ${DEVICE_NOUN} sits on our servers; while this is off, none may be registered.`
      : `Off deletes the token that lets Apple wake this ${DEVICE_NOUN} from our servers.`,
  pushFailed:
    'The token was not deleted. Nothing changed on our side — try again.',
  aboutSection: 'ABOUT',
  privacyRow: 'Privacy policy',
  termsRow: 'Terms',
  sourceRow: 'Source code',
  licensesRow: 'Open-source licenses',
  versionPrefix: 'Version ',
  licensesTitle: 'Licenses',
  // The notice that has to travel with the binary. Two things it must say and
  // does: that the whole program is AGPL-3.0-only, and — the part COPYING.iOS
  // exists to make unmissable — that Mirana's App Store permission covers
  // Mirana's own code and CANNOT reach libsignal, which Signal owns. Softening
  // that second sentence would make this notice misleading, which is worse
  // than omitting it.
  licensesBody:
    'Tacendum is free software, licensed under the GNU Affero General Public License version 3.\n\n' +
    'The complete corresponding source for this exact build is linked from the previous screen. It is the tag this binary was compiled from, not a moving branch.\n\n' +
    // Each store's build names ITS grant and ITS file — COPYING.Android
    // is the Play-channel mirror of COPYING.iOS.
    (Platform.OS === 'android'
      ? 'Mirana Technologies Inc. grants an additional permission under AGPL section 7 for distribution through Google Play. That permission reaches only material whose copyright Mirana holds. It does not and cannot cover libsignal, which is copyright Signal Messenger, LLC and licensed AGPL-3.0 — see COPYING.Android in the source tree.\n\n'
      : 'Mirana Technologies Inc. grants an additional permission under AGPL section 7 for distribution through the Apple App Store. That permission reaches only material whose copyright Mirana holds. It does not and cannot cover libsignal, which is copyright Signal Messenger, LLC and licensed AGPL-3.0 — see COPYING.iOS in the source tree.\n\n') +
    'This program comes with ABSOLUTELY NO WARRANTY, to the extent permitted by law.\n\n' +
    'Third-party components, each under its own license:\n\n' +
    '• libsignal — Signal Messenger, LLC (AGPL-3.0)\n' +
    '• WebRTC — The WebRTC project authors (BSD-3-Clause)\n' +
    '• React Native — Meta Platforms, Inc. (MIT)\n' +
    '• op-sqlite — OP Engineering (MIT)\n' +
    '• SQLite — public domain\n\n' +
    'Full texts ship in the source tree.',
  receiptsLabel: 'Read receipts',
  chatsSection: 'ROOMS',
  receiptOptions: [
    { label: 'On', value: true },
    { label: 'Off', value: false },
  ],
  // The honest distinction. Sent and delivered are things the server saw
  // because it carried the message; read is something only the other device
  // can say, and it says something about a person rather than a delivery.
  // Turning it off stops yours going out — theirs keep arriving, exactly as
  // every other messenger behaves, and saying so avoids the assumption that
  // this is a mutual switch.
  receiptsNote:
    'Sent and delivered are facts about the network. Read is a fact about ' +
    'you — it tells someone you opened their message. Turn this off and ' +
    'yours stop going out; theirs still arrive.',
  typingLabel: 'Typing indicators',
  typingOptions: [
    { label: 'On', value: true },
    { label: 'Off', value: false },
  ],
  // The receipts note's shape of honesty: sending only, never mutual. The
  // server cannot read the state, but it can see that typing-class frames
  // flow — say nothing stronger than the truth.
  typingNote:
    'Typing shows someone you are writing to them before you have sent ' +
    'anything. Turn this off and yours stop going out; theirs still arrive.',
  // The honest sentence — and it is a DIFFERENT honesty on each platform, so
  // this is one of the few places the copy has to branch.
  //
  // iOS cannot block a screenshot, so it discloses one after the fact. Android
  // can block it, so it does, always, with no setting to weaken — and the
  // disclosure then becomes unreachable exactly BECAUSE the stronger
  // protection is on. That inversion has to be said out loud here: a person
  // who read the iOS sentence and moved to an Android phone would otherwise
  // assume the notice still fires and read its silence as "nobody screenshots
  // me", when the truth is that nobody can.
  shotNote:
    Platform.OS === 'android'
      ? `Screenshots and screen recordings are blocked on this ${DEVICE_NOUN}. The system refuses them, and anything that captures the screen anyway records a blank. Nothing is announced in the room, because there is nothing to announce — prevented, not disclosed.`
      : `Screenshots can’t be blocked on ${DEVICE_NOUN}. When one is taken in a room, the room says so — on both sides.`,
  callsSection: 'CALLS',
  // "Every call", not "always relay": the switch is about what happens to
  // calls, and the word "relay" only means something to someone who has read
  // the note below it. The note is where the machinery gets named.
  relayLabel: 'Relay every call',
  relayOptions: [
    { label: 'On', value: true },
    { label: 'Off', value: false },
  ],
  /** The consent-grade one-liner that stays VISIBLE under the relay chips:
   * the IP disclosure, which is the cost of Off. The full note below —
   * including the first-call protection — sits behind the ⓘ. */
  relayConsent:
    'Off: after your first call with someone, later calls may go direct and show the other person’s device your IP address.',
  // The cost of turning it ON and the protection that holds when it is OFF,
  // both stated before the switch is thrown. The middle sentence is the one
  // that must not be left out: the first call with someone new is relayed
  // whatever this says, so nobody reads "Off" as "my address is handed to
  // strangers". And the last sentence is the limit — our own relay machine
  // sees an address on nearly every call either way, which the Privacy Policy
  // says at length and this row must not quietly contradict.
  relayNote:
    'A direct call connects faster and sounds better, and it shows the other ' +
    'person’s device your IP address — roughly, where you are. Your first call with ' +
    'someone new is relayed whichever way this is set, so a stranger never ' +
    'learns it from you. Turn this on and every later call is relayed too: ' +
    'calls take longer to connect, quality can suffer, and our relay carries ' +
    'the media — it sees when you call and how much you send, and it can ' +
    'hear none of it, because the media is encrypted and the relay has no ' +
    'key. Our relay machine observes your address on nearly every call in ' +
    'any case; what this decides is whether the person you are calling does.',
  // The design. The label names the RULE the app actually applies — a message, not
  // a scanned code — because "unknown caller" invites everyone to guess at a
  // different definition, and someone who scanned a QR code an hour ago would
  // guess wrong.
  silenceLabel: 'Silence calls from people you’ve never messaged',
  silenceOptions: [
    { label: 'On', value: true },
    { label: 'Off', value: false },
  ],
  // Three things this has to say before it is switched, and one it must not.
  // It must say what "never messaged" means, or someone reads it as a
  // stranger-detector; it must say the call is still visible, or the setting
  // reads as dropping calls on the floor; and it must say what turning it off
  // buys the person on the other end. What it must NOT say is that a silenced
  // caller can tell — they cannot, which is why this is safe to leave on.
  silenceNote:
    `Someone you have never exchanged a message with cannot make this ${DEVICE_NOUN} ` +
    'ring. Their call still arrives and still appears in Calls as a missed ' +
    'call you can return, so you choose when to answer rather than being ' +
    'woken at 3am. Scanning someone’s code is not enough on its own: send or ' +
    'receive one message and their calls ring like anyone else’s. Turn this ' +
    `off and anyone holding your Tacendum ID can ring this ${DEVICE_NOUN} at any hour.`,
  notificationsSection: 'NOTIFICATIONS',
  previewLabel: 'Show in notifications',
  // Ordered most-to-least revealing, so the row reads as a dial rather than a
  // set of unrelated choices. 'Name only' sits in the middle because it is
  // both the default and the answer most people actually want.
  previewOptions: [
    { label: 'Name and message', value: 'full' as const },
    { label: 'Name only', value: 'sender' as const },
    { label: 'Nothing', value: 'none' as const },
  ],
  // What this setting cannot do is as important as what it can, and none of
  // these limits are obvious from the outside — each one otherwise reads as a
  // bug the first time it happens.
  // The Android limits are DIFFERENT limits, not reworded
  // ones: there is no push to rewrite, so this phone raises its
  // own notifications from its own connection, and a locked workspace
  // delivers nothing at all — where iOS keeps receiving through the
  // extension. Saying the iOS sentence there would promise wake-ups that
  // cannot happen.
  // The Android arm branches on the binary's own push truth, exactly as
  // pushNote does: the websocket-only build's "nothing
  // arrives while the workspace is locked" is FALSE of an FCM build, where a
  // wake can raise the generic banner behind a locked workspace — the iOS
  // NSE posture, arrived at by policy.
  previewNote:
    Platform.OS === 'android'
      ? pushTransport() === 'fcm'
        ? `Your ${DEVICE_NOUN} decrypts the message to show it — Tacendum’s servers ` +
          'never can, and no words ever ride a push: a push only wakes this ' +
          `${DEVICE_NOUN}, which raises its own notification from its own connection. ` +
          'While the workspace is locked, a wake can say only “New message”, ' +
          'and previews stop entirely while App Lock is on or a duress code ' +
          'has been used.'
        : `Your ${DEVICE_NOUN} decrypts the message to show it — Tacendum’s servers never ` +
          `can, and they send no notifications at all: this ${DEVICE_NOUN} raises its ` +
          'own, from its own connection. Nothing arrives while the workspace is ' +
          'locked, and previews stop entirely while App Lock is on or a duress ' +
          'code has been used.'
      : `Your ${DEVICE_NOUN} decrypts the message to show it — Tacendum’s servers never ` +
        `can, so they only ever send “New message”. Previews need the ${DEVICE_NOUN} to ` +
        'have been unlocked at least once since it last started, and they stop ' +
        'entirely while App Lock is on or a duress code has been used.',
  // The message chime. Below the push row because it
  // is the narrower switch: that one decides whether Apple holds a token,
  // this one only whether a message that already reaches this device makes
  // a sound. Default ON, like typing indicators, and for the same reason: a
  // messenger that arrives silently reads as broken, not private.
  soundLabel: 'Message sounds',
  soundOptions: [
    { label: 'On', value: true },
    { label: 'Off', value: false },
  ],
  // Three limits, each of which otherwise reads as a bug: the device's own
  // settings and its silent switch outrank this (Off here can only
  // subtract, never add); nothing plays during a call or for the
  // conversation being read; and calls are not covered — they ring on their
  // own. The Android sentence is a different truth, not a reworded one: its notification sound is the system's
  // channel setting, which this switch cannot reach — the devices lane owns
  // that parity — so the copy promises only what the binary does.
  soundNote:
    Platform.OS === 'android'
      ? 'A short tone when a message arrives while Tacendum is open — not ' +
        'for the room you have open, and never during a call. ' +
        `Sounds for messages that arrive while Tacendum is closed follow this ${DEVICE_NOUN}’s ` +
        'notification settings for Tacendum, which this switch does not change. ' +
        'Calls ring on their own.'
      : 'A short tone when a message arrives while Tacendum is open, and the ' +
        'sound on its notifications while it is closed — not for the ' +
        'room you have open, and never during a call. Your ' +
        `${DEVICE_NOUN}’s notification settings and its silent switch decide first: ` +
        'Off here only takes a sound away. Calls ring on their own.',
  /**
   * Android notification channels control sounds and vibration outside the
   * app. This screen controls only its in-app tone; users manage channel
   * behavior in system settings.
   *
   * Linking.openSettings() opens the app-info page, so the adjacent help
   * directs users to Notifications from there. Keep the wording aligned
   * with that destination rather than promising a direct channel page.
   * The copy remains available to both platform test suites while the
   * control renders only on Android.
   */
  notifSettingsRow: 'Notification settings',
  /* The door first, because that is the only part of this note the row above
   * does not already say: `soundNote`'s Android arm two rows up has already
   * told this reader that closed-app sounds follow the system's own settings
   * for Tacendum. Repeating that in full here made the note read like a
   * second copy of the same paragraph and buried the one new fact, which is
   * where the button lands. */
  notifSettingsNote:
    'Opens Tacendum’s settings, where notifications are listed — sounds, ' +
    'vibration and how loudly a notification arrives are set there, not here.',
  ringLabel: 'Calls that take over the screen',
  /* NO THIRD SENTENCE. The draft ended 'The button above opens the setting.'
   * and it was false: the button above is `openSettings()`, which lands on
   * the app-info page, while the full-screen ring is the USE_FULL_SCREEN_INTENT
   * app-op behind its own special-app-access page — the app's own Kotlin
   * carries a separate intent for it (`CallNotifications.kt`, the ring's
   * 'Allow full-screen ring' action). Sending a reader to the button above
   * would land them where the setting is not, and would contradict the note
   * two rows up on the same screen. If the sharper door is wanted it rides
   * the booked `sendIntent` device check, with its own row and its own
   * sentence — not with this wording. */
  ringFullScreenNote:
    'An incoming call takes over the screen only if the system allows it. ' +
    'Without that, a call arrives as a banner you tap.',
  appearanceSection: 'APPEARANCE',
  appearanceLabel: 'Theme',
  appearanceOptions: [
    { label: 'Light', value: 'light' },
    { label: 'Dark', value: 'dark' },
    {
      label: `Match ${DEVICE_NOUN}`,
      value: 'system',
    },
  ],
} as const;

export type SettingsSection =
  | 'account'
  | 'privacy'
  | 'chats'
  | 'notifications'
  | 'appearance'
  | 'writing'
  | 'about';

type Flow =
  | { step: 'menu' }
  | { step: 'current'; next: 'change' | 'disable' | 'reset' }
  | { step: 'enter'; mode: 'enable' | 'change' }
  | { step: 'confirm'; mode: 'enable' | 'change'; first: string }
  | { step: 'explain'; mode: 'enable' | 'change'; code: string }
  | { step: 'licenses' }
  | { step: 'loss' };

interface Props {
  onBack: () => void;
  /** Gives the owning route transition the same guarded back operation used
   * by this screen's header and Android hardware Back. */
  backHandlerRef?: React.MutableRefObject<(() => boolean) | null>;
  /** Restores a category after an account child route returns to Settings. */
  initialSection?: SettingsSection;
  /** Lets the owning router preserve the category across child routes. */
  onSectionChange?: (section: SettingsSection | null) => void;
  /** Opens the linked-devices roster (the one Settings
   * entry that route was waiting on). */
  onOpenLinkedDevices: () => void;
  /** Opens the email + discoverability surface (the
   * second deferred entry, same pattern). */
  onOpenAccountEmail: () => void;
  /** Opens the username surface. Optional
   * because its row renders ONLY under the build pin: App.tsx always
   * passes it, and a dark binary never renders the row that would call
   * it. */
  onOpenAccountUsername?: () => void;
  /**
   * App.tsx supplies the same relock() used for background locking, so this
   * action ends calls, closes the workspace, restores the database target
   * and routes to the lock screen through the existing teardown.
   * Render the row only when the callback exists: a visible control must
   * have an action, including when this screen is mounted independently.
   */
  onLockNow?: () => void;
}

export function SettingsScreen({
  onBack,
  backHandlerRef,
  initialSection,
  onSectionChange,
  onOpenLinkedDevices,
  onOpenAccountEmail,
  onOpenAccountUsername,
  onLockNow,
}: Props) {
  const t = useTheme();
  /**
   * FIELD MODE in a DURESS session. `fieldMode.ts` writes nothing
   * there, so the four rows a coerced tap moves live in React state alone —
   * and React state does not survive closing Settings and opening it again,
   * while every one of those rows DOES survive in a real session. That
   * difference is visible in two taps, so the module keeps a session-scoped
   * copy and the row states below are seeded from it. `null` means the decoy
   * has not moved them and its own values (App.tsx reset them on the way in)
   * are what the screen shows.
   */
  const duressRows = session.mode === 'duress' ? fieldModeDuressRows() : null;
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [lockStatusFailed, setLockStatusFailed] = useState(false);
  const [autolockSec, setAutolockSec] = useState(0);
  const [flow, setFlow] = useState<Flow>({ step: 'menu' });
  const [section, setSection] = useState<SettingsSection | null>(
    initialSection ?? null,
  );
  const scrollRef = useRef<ScrollView>(null);
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /**
   * Synchronous submit latch for the App Lock flow: a double-tap lands before
   * the `busy` STATE has re-rendered, so both taps see `busy === false`. Here
   * that burnt two of the five free attempts on one mis-typed code, or ran
   * `setupDecoy()` twice — two writers each DELETE-then-INSERTing into the
   * same decoy tables. The LockScreen latch, for the reason it gives ("two
   * concurrent unlocks nearly wiped real data"). Checked and set before
   * `setBusy`, cleared in `finally`. */
  const busyRef = useRef(false);
  const [blankEnabled, setBlankEnabled] = useState(
    () => duressRows?.blankWhileCaptured ?? screenSecurity.blankEnabled,
  );
  const [receipts, setReceipts] = useState(readReceiptsEnabled);
  const [typing, setTyping] = useState(typingIndicatorsEnabled);
  const [preview, setPreview] = useState<PreviewLevel>(
    () => duressRows?.previewLevel ?? previewLevel(),
  );
  const [appearance, setAppearance] = useState(appearanceChoice);
  // Read synchronously from the loaded preference; the
  // Keychain read happens at init and on every real unlock.
  const [pushAllowed, setPushAllowed] = useState(pushTokensAllowed());
  const [pushBusy, setPushBusy] = useState(false);
  const [pushFailed, setPushFailed] = useState(false);
  // The design. Read synchronously from the loaded preference, like the push row
  // above: the Keychain read happens at init and on every real unlock.
  const [relayAll, setRelayAll] = useState(
    () => duressRows?.relayEveryCall ?? alwaysRelayEnabled(),
  );
  // Read the loaded setting for the same reason: the Keychain read
  // happens at init and on every real unlock, so the row starts from the
  // loaded preference rather than from this component's idea of the default.
  const [silenceUnknown, setSilenceUnknown] = useState(
    () => duressRows?.silenceUnknownCallers ?? silenceUnknownCallersEnabled(),
  );
  // The message chime. Read synchronously from the loaded preference like
  // the rows above: messaging.start() loads it on every real unlock, before
  // this sheet can be reached, and a duress session shows its own shadow.
  // No re-read on mount — a read landing after a tap would revert the chip
  // to the file's old value, and there is nothing newer to learn.
  const [sound, setSound] = useState(messageSoundEnabled);
  /**
   * FIELD MODE is DERIVED, in BOTH modes — one predicate, computed below from
   * the six values this screen already holds, so changing any mapped row by
   * hand moves the Field Mode chip for free and the two can never disagree.
   * A chip that is remembered while the rows it describes are not is the one
   * shape that must never ship: it is unreachable in a real session, so it
   * would tell a coercer which session they are in.
   */
  /** Field Mode is five writes behind one chip: the re-entrancy latch the
   * single-write rows do not need (the `submitPin`/`commit` idiom). Without
   * it a fast On-then-Off interleaves — the Off pass can read the snapshot
   * and delete the key while the On pass is still setting — and lands the
   * rows at the field values with no record of what was there. */
  const fieldBusyRef = useRef(false);
  const [fieldBusy, setFieldBusy] = useState(false);

  const lockStatusReadRef = useRef(0);
  const loadLockStatus = useCallback(() => {
    const owner = ++lockStatusReadRef.current;
    setEnabled(null);
    setLockStatusFailed(false);
    void lock
      .status()
      .then(s => {
        if (lockStatusReadRef.current !== owner) return;
        // The session override wins over the Keychain: in duress, mutations
        // are Keychain no-ops, but the session must tell ONE story.
        setEnabled(session.lockUi.enabled ?? s.enabled);
        setAutolockSec(session.lockUi.autolockSec ?? s.autolockSec);
      })
      .catch(() => {
        if (lockStatusReadRef.current === owner) setLockStatusFailed(true);
      });
  }, []);

  useEffect(() => {
    loadLockStatus();
    return () => {
      lockStatusReadRef.current += 1;
    };
  }, [loadLockStatus]);

  /**
   * Keep the coerced session's copy of the four mapped rows current (rule
   * 16). Every one of these rows survives a Settings remount in a real
   * session — through its module's in-memory mirror, or through
   * `session.lockUi` for auto-lock — so in duress they must survive too, and
   * this shadow is the only place they can. Driven off the row values rather
   * than off the Field Mode tap, so a row the coercer changes BY HAND is
   * remembered as well and the chip cannot come back On over it. A no-op in a
   * real session.
   */
  useEffect(() => {
    if (session.mode !== 'duress') return;
    recordFieldModeDuressRows({
      previewLevel: preview,
      relayEveryCall: relayAll,
      silenceUnknownCallers: silenceUnknown,
      blankWhileCaptured: blankEnabled,
    });
  }, [preview, relayAll, silenceUnknown, blankEnabled]);

  const resetScroll = () => {
    scrollRef.current?.scrollTo({ y: 0, animated: false });
  };

  const toFlow = (next: Flow) => {
    setValue('');
    setError(null);
    setFlow(next);
    resetScroll();
  };

  /**
   * Settings is one router surface with a small navigation stack of its own:
   * home → category → optional sub-step. Account routes leave this component,
   * so the owner can mirror the selected category through `onSectionChange`
   * and hand it back through `initialSection` on return.
   */
  const sectionRef = useRef(section);
  sectionRef.current = section;
  const changeSection = (next: SettingsSection | null) => {
    toFlow({ step: 'menu' });
    setSection(next);
    onSectionChange?.(next);
  };

  useEffect(() => {
    const next = initialSection ?? null;
    if (sectionRef.current === next) return;
    setFlow({ step: 'menu' });
    setValue('');
    setError(null);
    setSection(next);
    resetScroll();
  }, [initialSection]);

  /** Read by the system-back handler, which is registered once and must see
   * the current sub-step, category and callbacks at the moment of the press. */
  const flowRef = useRef(flow);
  const toFlowRef = useRef(toFlow);
  const changeSectionRef = useRef(changeSection);
  flowRef.current = flow;
  toFlowRef.current = toFlow;
  changeSectionRef.current = changeSection;

  const backWithinSettings = (): boolean => {
    // setupDecoy and the Field Mode batch are security writes. Keep their
    // owning surface mounted until each operation reaches its own `finally`.
    if (busyRef.current || fieldBusyRef.current) return true;
    if (flowRef.current.step !== 'menu') {
      toFlowRef.current({ step: 'menu' });
      return true;
    }
    if (sectionRef.current !== null) {
      changeSectionRef.current(null);
      return true;
    }
    return false;
  };
  const backWithinSettingsRef = useRef(backWithinSettings);
  backWithinSettingsRef.current = backWithinSettings;

  const handleHeaderBack = () => {
    if (!backWithinSettings()) onBack();
  };

  useEffect(() => {
    // Android and the route edge gesture follow the same visible stack as the
    // header. Mid-write presses are consumed so a security operation cannot
    // outlive its surface.
    const handler = () => backWithinSettingsRef.current();
    if (backHandlerRef) backHandlerRef.current = handler;
    const subscription = BackHandler.addEventListener(
      'hardwareBackPress',
      handler,
    );
    return () => {
      if (backHandlerRef?.current === handler) backHandlerRef.current = null;
      subscription.remove();
    };
  }, [backHandlerRef]);

  /**
   * Hand a policy or source URL to the system browser.
   *
   * Swallowed rather than surfaced. These four rows are reference links, and
   * the only realistic failure is a device with no handler for https — at
   * which point an error banner in Settings helps nobody and a red box on a
   * screen someone opened to read a licence is worse than the silence. The
   * URLs are compile-time constants (version.ts), so there is no malformed
   * input to report.
   */
  const openExternal = async (url: string) => {
    try {
      await Linking.openURL(url);
    } catch {
      // Intentionally silent — see above.
    }
  };

  /**
   * Open the system's own settings page for Tacendum.
   *
   * Swallowed the way `openExternal` above is swallowed, and for the same
   * reason: the only realistic failure is a system with no such page, at
   * which point an error banner on a settings screen helps nobody. The note
   * under the row already says what this opens, so a silent no-op is the
   * quietest possible wrong answer rather than a lie.
   */
  const openSystemSettings = async () => {
    try {
      await Linking.openSettings();
    } catch {
      // Intentionally silent — see above.
    }
  };

  const submitPin = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      if (flow.step === 'current') {
        const result = await lock.verify(value);
        if (result.verdict === 'fail') return setError(COPY.wrong);
        if (result.verdict === 'cooldown') return setError(COPY.cooldown);
        // The give-away code is not the current code: in a REAL session
        // only the real verdict opens the change / disable / rebuild
        // doors — otherwise whoever holds the duress code could change
        // the real lock. A DURESS session keeps accepting both, as
        // everything here does: the coerced change must look
        // like it worked.
        if (session.mode === 'real' && result.verdict !== 'real')
          return setError(COPY.wrong);
        if (flow.next === 'change')
          return toFlow({ step: 'enter', mode: 'change' });
        if (flow.next === 'reset') {
          await setupDecoy();
          setNotice(COPY.decoysRebuilt);
          return toFlow({ step: 'menu' });
        }
        // disable
        await lock.disable();
        // Never from a duress session: this would delete the decoy world out
        // from under the active session (and the real user's configuration).
        if (session.mode === 'real') await db.clearDecoyState();
        setEnabled(false);
        session.setLockUi({ enabled: false });
        setNotice(COPY.disabled);
        return toFlow({ step: 'menu' });
      }
      if (flow.step === 'enter') {
        const invalid = lock.validateCode(value);
        if (invalid) return setError(invalid);
        return toFlow({ step: 'confirm', mode: flow.mode, first: value });
      }
      if (flow.step === 'confirm') {
        if (value !== flow.first) {
          // Not toFlow — it clears the error, and the user must SEE why they
          // were bounced back to the first entry step.
          setFlow({ step: 'enter', mode: flow.mode });
          setError(COPY.mismatch);
          return;
        }
        return toFlow({ step: 'explain', mode: flow.mode, code: value });
      }
    } catch {
      setError(COPY.failed);
    } finally {
      setValue('');
      setBusy(false);
      busyRef.current = false;
    }
  };

  const commit = async () => {
    if (flow.step !== 'explain' || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      if (flow.mode === 'enable') {
        // Decoy FIRST: the lock must never come up guarding a world whose
        // decoy half failed to generate.
        await setupDecoy();
        await lock.setup(flow.code);
        await lock.setAutolock(autolockSec);
        setEnabled(true);
        session.setLockUi({ enabled: true, autolockSec });
        setNotice(COPY.enabled);
      } else {
        await lock.setup(flow.code);
        setNotice(COPY.changed);
      }
      toFlow({ step: 'menu' });
    } catch {
      setError(COPY.failed);
    } finally {
      setBusy(false);
      busyRef.current = false;
    }
  };

  /**
   * The optimistic rows whose write can throw: the chip moves with the
   * finger, and a failed write puts it
   * back where it was and says so under the row — instead of a flipped
   * chip over an unchanged preference and an unhandled rejection. The
   * modules that never reject (sound, relay, silence) keep their plain
   * optimistic shape.
   */
  type RowKey =
    'autolock' | 'screensec' | 'receipts' | 'typing' | 'preview' | 'fieldmode';
  const [rowError, setRowError] = useState<RowKey | null>(null);
  const rowErrorFor = (row: RowKey): string | null =>
    rowError === row ? COPY.settingFailed : null;
  const persist = async (
    row: RowKey,
    write: () => Promise<void>,
    revert: () => void,
  ): Promise<void> => {
    setRowError(null);
    try {
      await write();
    } catch {
      revert();
      setRowError(row);
    }
  };

  const chooseAutolock = async (sec: number) => {
    const previous = autolockSec;
    const previousUi = session.lockUi.autolockSec;
    setAutolockSec(sec); // session-scoped truth; identical in both modes
    session.setLockUi({ autolockSec: sec });
    await persist(
      'autolock',
      () => lock.setAutolock(sec),
      () => {
        setAutolockSec(previous);
        session.setLockUi({ autolockSec: previousUi });
      },
    );
  };

  const chooseBlank = async (nextEnabled: boolean) => {
    const previous = blankEnabled;
    setBlankEnabled(nextEnabled);
    await persist(
      'screensec',
      () => screenSecurity.setBlankEnabled(nextEnabled),
      () => {
        setBlankEnabled(previous);
        // The live policy moved before the Keychain write refused: put it
        // back too (best effort — the store already refused once).
        void screenSecurity.setBlankEnabled(previous).catch(() => undefined);
      },
    );
  };

  /**
   * Turn the push-token row on or off.
   *
   * Optimistic on the switch, honest on failure. The preference is written
   * first inside `withdrawPushTokens`, so a delete that fails still leaves
   * the person withdrawn — the next upload is suppressed either way and the
   * row lapses on its own TTL. What the error says is therefore narrow and
   * true: the token was not deleted, not "nothing happened".
   */
  const choosePush = async (next: boolean) => {
    setPushBusy(true);
    setPushFailed(false);
    try {
      if (next) await restorePushTokens();
      else await withdrawPushTokens();
      setPushAllowed(next);
    } catch {
      // The preference moved even though the network step did not, so the
      // switch must reflect the preference rather than snapping back.
      setPushAllowed(pushTokensAllowed());
      setPushFailed(true);
    } finally {
      setPushBusy(false);
    }
  };

  const chooseReceipts = async (nextEnabled: boolean) => {
    const previous = receipts;
    setReceipts(nextEnabled);
    await persist(
      'receipts',
      () => setReadReceipts(nextEnabled),
      () => {
        setReceipts(previous);
        void setReadReceipts(previous).catch(() => undefined);
      },
    );
  };

  const chooseTyping = async (nextEnabled: boolean) => {
    const previous = typing;
    setTyping(nextEnabled);
    await persist(
      'typing',
      () => setTypingIndicators(nextEnabled),
      () => {
        setTyping(previous);
        void setTypingIndicators(previous).catch(() => undefined);
      },
    );
  };

  /**
   * The app-wide always-relay switch.
   *
   * Optimistic like the rows around it, and `setAlwaysRelay` does the ordering
   * that matters: the live policy reaches the native module before the
   * Keychain write, so the switch can never be showing "On" over calls that
   * are still going direct.
   */
  const chooseRelay = async (next: boolean) => {
    setRelayAll(next);
    await setAlwaysRelay(next);
  };

  /**
   * Silence unknown callers.
   *
   * Optimistic like every row here, and the in-memory value moves before the
   * Keychain write — so the very next offer to arrive is judged by what the
   * screen is showing, even if the write is still in flight or fails outright.
   */
  const chooseSilence = async (next: boolean) => {
    setSilenceUnknown(next);
    await setSilenceUnknownCallers(next);
  };

  const choosePreview = async (next: PreviewLevel) => {
    // Optimistic, like every other row here: the control must not lag behind
    // the finger over a file write. A failed write leaves the previous value
    // on disk — so the chip goes back to it and says so, rather than a row
    // that silently disagrees with what the notification will do.
    const previous = preview;
    setPreview(next);
    await persist(
      'preview',
      () => setPreviewLevel(next),
      () => {
        setPreview(previous);
        void setPreviewLevel(previous).catch(() => undefined);
      },
    );
  };

  /**
   * Message sounds. Optimistic like every row here, and the in-memory value
   * moves before the file write — so the very next arrival is judged by
   * what the screen is showing. In duress the write is a no-op and the row
   * still flips: `setMessageSound` keeps a session-scoped shadow.
   * It never rejects (a failed write leaves the choice standing in memory),
   * so the `void` below drops nothing.
   */
  const chooseSound = async (next: boolean) => {
    setSound(next);
    await setMessageSound(next);
  };

  /**
   * FIELD MODE, derived (fieldMode.ts): the five mapped controls plus App
   * Lock's own state, read from the values this screen already renders. No
   * `useState` mirror — a mirror is exactly the thing that can disagree with
   * the settings the switch claims to describe.
   */
  const fieldState: FieldModeState = {
    previewLevel: preview,
    relayEveryCall: relayAll,
    silenceUnknownCallers: silenceUnknown,
    blankWhileCaptured: blankEnabled,
    lockEnabled: enabled === true,
    autolockSec,
  };
  const fieldOn = fieldModeActive(fieldState);

  /**
   * The one tap, and ONE path through it. Optimistic like every row here:
   * turning it ON moves the five rows to their field values before the writes
   * land, turning it OFF waits for the snapshot to say what to put back
   * (guessing would be the one thing the restore promise cannot afford). A
   * failed write reverts all five and says so under the row, through the same
   * `persist` seam.
   *
   * In duress `setFieldMode` touches no store at all and returns the same
   * five values a real tap would land on, so the rows move identically and
   * the module's session-scoped shadow (seeded into this screen's state at
   * mount) keeps them moved across a Settings remount.
   */
  const chooseFieldMode = async (next: boolean) => {
    // Tapping the chip that is already selected changes nothing — and must
    // not re-snapshot the field values over the record of what was there
    // before Field Mode was turned on.
    if (next === fieldOn || fieldBusyRef.current) return;
    const previous = {
      preview,
      relayAll,
      silenceUnknown,
      blankEnabled,
      autolockSec,
    };
    const previousUi = session.lockUi.autolockSec;
    const applyRows = (s: FieldModeState) => {
      setPreview(s.previewLevel);
      setRelayAll(s.relayEveryCall);
      setSilenceUnknown(s.silenceUnknownCallers);
      setBlankEnabled(s.blankWhileCaptured);
      setAutolockSec(s.autolockSec);
      // The session-scoped copy this screen re-reads on EVERY mount, which
      // `chooseAutolock` and `commit` keep in step for exactly this reason.
      // Without it the Auto-lock row reads "5 min" over a Keychain holding
      // 0 the moment Settings is reopened — and the derived chip, reading
      // that stale 300, reads Off over settings that are all at their field
      // values.
      if (s.lockEnabled) session.setLockUi({ autolockSec: s.autolockSec });
    };
    if (next) {
      applyRows({
        previewLevel: FIELD_VALUES.previewLevel,
        relayEveryCall: FIELD_VALUES.relayEveryCall,
        silenceUnknownCallers: FIELD_VALUES.silenceUnknownCallers,
        blankWhileCaptured: FIELD_VALUES.blankWhileCaptured,
        lockEnabled: fieldState.lockEnabled,
        autolockSec: fieldState.lockEnabled
          ? FIELD_VALUES.autolockSec
          : previous.autolockSec,
      });
    }
    fieldBusyRef.current = true;
    setFieldBusy(true);
    try {
      await persist(
        'fieldmode',
        async () => {
          applyRows(await setFieldMode(next, fieldState));
        },
        () => {
          setPreview(previous.preview);
          setRelayAll(previous.relayAll);
          setSilenceUnknown(previous.silenceUnknown);
          setBlankEnabled(previous.blankEnabled);
          setAutolockSec(previous.autolockSec);
          if (fieldState.lockEnabled) {
            session.setLockUi({ autolockSec: previousUi });
          }
        },
      );
    } finally {
      fieldBusyRef.current = false;
      setFieldBusy(false);
    }
  };

  const pinPrompt =
    flow.step === 'current'
      ? COPY.currentPrompt
      : flow.step === 'confirm'
        ? COPY.confirmPrompt
        : COPY.enterPrompt;

  const sectionCopy = section
    ? COPY.categories.find(item => item.id === section)
    : undefined;
  const headerTitle =
    flow.step === 'licenses'
      ? COPY.licensesTitle
      : flow.step === 'loss'
        ? LOSS_COPY.title
        : flow.step !== 'menu'
          ? 'App Lock'
          : (sectionCopy?.title ?? COPY.title);
  const headerBackLabel =
    flow.step !== 'menu'
      ? `Back to ${sectionCopy?.title ?? COPY.title}`
      : section
        ? 'Back to Settings'
        : 'Back';

  return (
    <View style={styles.container} testID="settings-screen">
      <ScreenHeader
        title={headerTitle}
        onBack={handleHeaderBack}
        backLabel={headerBackLabel}
        testIDBack="settings-back"
      />
      <ScrollView
        ref={scrollRef}
        contentContainerStyle={[
          styles.content,
          { paddingHorizontal: t.layout.gutter },
        ]}
      >
        {/* The reading column: capped at contentMax
            like Register/Profile, so a medium/expanded pane hands this
            screen an honest width instead of stretching every row across
            the glass. Width-only; on phones the cap never engages. */}
        <View style={[styles.column, { maxWidth: t.layout.contentMax }]}>
          {flow.step === 'menu' && section === null ? (
            <SettingsSheet>
              {COPY.categories.map((item, index) => (
                <React.Fragment key={item.id}>
                  {index > 0 ? <RowRule /> : null}
                  <MenuRow
                    label={item.title}
                    detail={item.summary}
                    testID={`settings-category-${item.id}`}
                    first={index === 0}
                    onPress={() => changeSection(item.id)}
                  />
                </React.Fragment>
              ))}
            </SettingsSheet>
          ) : null}

          {flow.step === 'menu' && section === 'account' ? (
            <>
              {/* THE ACCOUNT LEAD (V1, 2026-10-08): a fact true in every
                  state — it reads no identifier row and no eligibility, and
                  must not: the local rows are empty on a linked sibling. It
                  carries both facts (what needs a verified email, what needs
                  none), so the separate no-verification line below renders
                  only in a pin-OFF binary, where this lead is absent. */}
              {USERNAME_UI_ENABLED ? (
                <Text
                  testID="settings-account-verification-note"
                  style={[
                    t.type.body,
                    styles.categoryLead,
                    styles.detailStart,
                    { color: t.color.inkBody },
                  ]}
                >
                  {ACCOUNTS_USERNAME_COPY.verificationSummary}
                </Text>
              ) : (
                <Text
                  testID="settings-account-without-verification"
                  style={[
                    t.type.compactBody,
                    styles.categoryNote,
                    styles.detailStart,
                    { color: t.color.inkMuted },
                  ]}
                >
                  {ACCOUNTS_USERNAME_COPY.withoutVerification}
                </Text>
              )}
              <SettingsSheet>
                <MenuRow
                  label={COPY.linkedDevicesRow}
                  testID="settings-linked-devices"
                  first
                  onPress={onOpenLinkedDevices}
                />
                <RowRule />
                <MenuRow
                  label={COPY.accountEmailRow}
                  testID="settings-account-email"
                  onPress={onOpenAccountEmail}
                />
                {USERNAME_UI_ENABLED ? (
                  <>
                    <RowRule />
                    <MenuRow
                      label={COPY.accountUsernameRow}
                      testID="settings-account-username"
                      onPress={() => onOpenAccountUsername?.()}
                    />
                  </>
                ) : null}
              </SettingsSheet>
              <View style={styles.sectionInfo}>
                <InfoDisclosure
                  label={ACCOUNT_LIFECYCLE_COPY.title}
                  lines={[
                    ACCOUNT_LIFECYCLE_COPY.summary,
                    ...ACCOUNT_LIFECYCLE_COPY.details,
                  ]}
                  testID="settings-account-lifecycle-info"
                />
              </View>
            </>
          ) : null}

          {flow.step === 'menu' && section === 'privacy' ? (
            <>
              {enabled !== null ? (
                <>
                  <RuledLabel
                    heading
                    label={FIELD_MODE_COPY.sectionLabel}
                    marginTop={24}
                    marginBottom={12}
                  />
                  <SettingsSheet>
                    <ChoiceRow
                      label={FIELD_MODE_COPY.label}
                      options={FIELD_MODE_COPY.options}
                      value={fieldOn}
                      onChange={next => void chooseFieldMode(next)}
                      disabled={fieldBusy}
                      testIDPrefix="settings-fieldmode"
                      note={
                        enabled
                          ? `${FIELD_MODE_COPY.consent} ${FIELD_MODE_COPY.consentAutolock}`
                          : FIELD_MODE_COPY.consent
                      }
                      info={{
                        label: COPY.infoLabel,
                        lines: FIELD_MODE_COPY.infoLines,
                      }}
                      error={rowErrorFor('fieldmode')}
                    />
                    {!enabled ? (
                      <Text
                        testID="settings-fieldmode-needslock"
                        style={[
                          t.type.compactBody,
                          styles.needsLock,
                          { color: t.color.inkMuted },
                        ]}
                      >
                        {FIELD_MODE_COPY.needsLock}
                      </Text>
                    ) : null}
                  </SettingsSheet>
                </>
              ) : null}

              <RuledLabel
                heading
                label={COPY.lockSection}
                marginTop={enabled === null ? 24 : 32}
                marginBottom={12}
              />
              {notice ? (
                <InlineNotice message={notice} tone="pine" marginTop={0} />
              ) : null}
              <SettingsSheet>
                {enabled === null ? (
                  <View style={styles.lockStatus}>
                    {lockStatusFailed ? (
                      <>
                        <InlineError
                          message={COPY.lockStatusFailed}
                          testID="settings-lock-status-error"
                          marginTop={0}
                        />
                        <TextAction
                          label={COPY.retry}
                          testID="settings-lock-status-retry"
                          onPress={loadLockStatus}
                        />
                      </>
                    ) : (
                      <Text
                        testID="settings-lock-status-loading"
                        style={[
                          t.type.compactBody,
                          styles.lockStatusLoading,
                          { color: t.color.inkMuted },
                        ]}
                      >
                        {COPY.lockStatusLoading}
                      </Text>
                    )}
                  </View>
                ) : !enabled ? (
                  <MenuRow
                    label={COPY.enableRow}
                    testID="settings-lock-enable"
                    onPress={() => toFlow({ step: 'enter', mode: 'enable' })}
                    first
                  />
                ) : (
                  <>
                    <MenuRow
                      label={COPY.changeRow}
                      testID="settings-lock-change"
                      onPress={() =>
                        toFlow({ step: 'current', next: 'change' })
                      }
                      first
                    />
                    <RowRule />
                    <ChoiceRow
                      label={COPY.autolockLabel}
                      options={COPY.autolockOptions}
                      value={autolockSec}
                      onChange={sec => void chooseAutolock(sec)}
                      testIDPrefix="settings-autolock"
                      info={{
                        label: COPY.autolockInfoLabel,
                        lines: COPY.autolockInfo,
                      }}
                      error={rowErrorFor('autolock')}
                    />
                    <RowRule />
                    <MenuRow
                      label={COPY.resetDecoysRow}
                      testID="settings-lock-reset-decoys"
                      onPress={() => toFlow({ step: 'current', next: 'reset' })}
                    />
                    {onLockNow ? (
                      <>
                        <RowRule />
                        <MenuRow
                          label={COPY.lockNowRow}
                          testID="settings-lock-now"
                          onPress={onLockNow}
                        />
                        <Text
                          testID="settings-lock-now-note"
                          style={[
                            t.type.compactBody,
                            styles.rowNote,
                            { color: t.color.inkMuted },
                          ]}
                        >
                          {COPY.lockNowNote}
                        </Text>
                      </>
                    ) : null}
                    <RowRule />
                    <MenuRow
                      label={COPY.disableRow}
                      testID="settings-lock-disable"
                      onPress={() =>
                        toFlow({ step: 'current', next: 'disable' })
                      }
                      danger
                    />
                  </>
                )}
                <RowRule />
                <MenuRow
                  label={LOSS_COPY.row}
                  testID="settings-loss"
                  onPress={() => toFlow({ step: 'loss' })}
                />
              </SettingsSheet>
              {enabled ? (
                <View style={styles.sectionInfo}>
                  <InfoDisclosure
                    label={COPY.explainTitle}
                    lines={[COPY.explain]}
                    testID="settings-lock-info"
                  />
                </View>
              ) : null}

              <RuledLabel
                heading
                label={COPY.screenSection}
                marginTop={32}
                marginBottom={12}
              />
              <SettingsSheet>
                <ChoiceRow
                  label={COPY.blankLabel}
                  options={COPY.blankOptions}
                  value={blankEnabled}
                  onChange={next => void chooseBlank(next)}
                  testIDPrefix="settings-screensec"
                  error={rowErrorFor('screensec')}
                />
              </SettingsSheet>
              <View style={styles.sectionInfo}>
                <InfoDisclosure
                  label={COPY.shotLabel}
                  lines={[COPY.shotNote]}
                  testID="settings-shot-info"
                />
                <InfoDisclosure
                  label={COPY.linksLabel}
                  lines={[COPY.linksNote]}
                  testID="settings-links-info"
                />
              </View>
            </>
          ) : null}

          {flow.step === 'menu' && section === 'chats' ? (
            <>
              <RuledLabel
                heading
                label={COPY.chatsSection}
                marginTop={24}
                marginBottom={12}
              />
              <SettingsSheet>
                <ChoiceRow
                  label={COPY.receiptsLabel}
                  options={COPY.receiptOptions}
                  value={receipts}
                  onChange={next => void chooseReceipts(next)}
                  testIDPrefix="settings-receipts"
                  info={{ label: COPY.infoLabel, lines: [COPY.receiptsNote] }}
                  error={rowErrorFor('receipts')}
                />
                <ChoiceRow
                  label={COPY.typingLabel}
                  options={COPY.typingOptions}
                  value={typing}
                  onChange={next => void chooseTyping(next)}
                  testIDPrefix="settings-typing"
                  info={{ label: COPY.infoLabel, lines: [COPY.typingNote] }}
                  error={rowErrorFor('typing')}
                />
              </SettingsSheet>

              <RuledLabel
                heading
                label={COPY.callsSection}
                marginTop={32}
                marginBottom={12}
              />
              <SettingsSheet>
                <ChoiceRow
                  label={COPY.relayLabel}
                  options={COPY.relayOptions}
                  value={relayAll}
                  onChange={next => void chooseRelay(next)}
                  testIDPrefix="settings-relay"
                  note={COPY.relayConsent}
                  info={{ label: COPY.infoLabel, lines: [COPY.relayNote] }}
                />
                <ChoiceRow
                  label={COPY.silenceLabel}
                  options={COPY.silenceOptions}
                  value={silenceUnknown}
                  onChange={next => void chooseSilence(next)}
                  testIDPrefix="settings-silence"
                  info={{ label: COPY.infoLabel, lines: [COPY.silenceNote] }}
                />
              </SettingsSheet>
            </>
          ) : null}

          {flow.step === 'menu' && section === 'notifications' ? (
            <>
              <SettingsSheet top>
                <ChoiceRow
                  label={COPY.previewLabel}
                  options={COPY.previewOptions}
                  value={preview}
                  onChange={next => void choosePreview(next)}
                  testIDPrefix="settings-preview"
                  info={{ label: COPY.infoLabel, lines: [COPY.previewNote] }}
                  error={rowErrorFor('preview')}
                />
                <ChoiceRow
                  label={COPY.pushLabel}
                  options={COPY.pushOptions}
                  value={pushAllowed}
                  onChange={next => void choosePush(next)}
                  disabled={pushBusy}
                  testIDPrefix="settings-push"
                  note={COPY.pushConsent}
                  info={{ label: COPY.infoLabel, lines: [COPY.pushNote] }}
                  error={pushFailed ? COPY.pushFailed : null}
                />
                <ChoiceRow
                  label={COPY.soundLabel}
                  options={COPY.soundOptions}
                  value={sound}
                  onChange={next => void chooseSound(next)}
                  testIDPrefix="settings-sound"
                  info={{ label: COPY.infoLabel, lines: [COPY.soundNote] }}
                />
                {Platform.OS === 'android' ? (
                  <>
                    <RowRule />
                    <MenuRow
                      label={COPY.notifSettingsRow}
                      testID="settings-notification-settings"
                      onPress={() => void openSystemSettings()}
                    />
                    <Text
                      testID="settings-notification-settings-note"
                      style={[
                        t.type.compactBody,
                        styles.rowNote,
                        { color: t.color.inkMuted },
                      ]}
                    >
                      {COPY.notifSettingsNote}
                    </Text>
                  </>
                ) : null}
              </SettingsSheet>
              {Platform.OS === 'android' ? (
                <View style={styles.sectionInfo}>
                  <InfoDisclosure
                    label={COPY.ringLabel}
                    lines={[COPY.ringFullScreenNote]}
                    testID="settings-ring-info"
                  />
                </View>
              ) : null}
            </>
          ) : null}

          {flow.step === 'menu' && section === 'appearance' ? (
            <SettingsSheet top>
              <ChoiceRow
                label={COPY.appearanceLabel}
                options={COPY.appearanceOptions}
                value={appearance}
                onChange={next => {
                  setAppearanceChoice(next);
                  setAppearance(next);
                }}
                testIDPrefix="settings-appearance"
              />
            </SettingsSheet>
          ) : null}

          {flow.step === 'menu' && section === 'writing' ? (
            <View style={styles.detailStart}>
              <WritingConnection
                showHeading={false}
                onDone={() => changeSection(null)}
              />
            </View>
          ) : null}

          {flow.step === 'menu' && section === 'about' ? (
            <>
              <SettingsSheet top>
                <MenuRow
                  label={COPY.privacyRow}
                  testID="settings-privacy"
                  first
                  onPress={() => void openExternal(PRIVACY_URL)}
                />
                <RowRule />
                <MenuRow
                  label={COPY.termsRow}
                  testID="settings-terms"
                  onPress={() => void openExternal(TERMS_URL)}
                />
                <RowRule />
                <MenuRow
                  label={COPY.sourceRow}
                  testID="settings-source"
                  onPress={() => void openExternal(SOURCE_URL)}
                />
                <RowRule />
                <MenuRow
                  label={COPY.licensesRow}
                  testID="settings-licenses"
                  onPress={() => toFlow({ step: 'licenses' })}
                />
              </SettingsSheet>
              <Text
                testID="settings-version"
                style={[
                  t.type.timeStatus,
                  styles.versionLine,
                  { color: t.color.inkMuted },
                ]}
              >
                {COPY.versionPrefix}
                {VERSION_LABEL}
              </Text>
            </>
          ) : null}

          {flow.step === 'licenses' ? (
            <View style={styles.pinFlow}>
              <Text style={[t.type.sectionTitle, { color: t.color.inkStrong }]}>
                {COPY.licensesTitle}
              </Text>
              <Text
                testID="settings-licenses-body"
                style={[
                  t.type.body,
                  styles.explain,
                  { color: t.color.inkBody },
                ]}
              >
                {COPY.licensesBody}
              </Text>
              <DoneLink onPress={() => toFlow({ step: 'menu' })} />
            </View>
          ) : null}

          {flow.step === 'loss' ? (
            <View style={styles.pinFlow}>
              <Text style={[t.type.sectionTitle, { color: t.color.inkStrong }]}>
                {LOSS_COPY.title}
              </Text>
              <View testID="settings-loss-body">
                {LOSS_COPY.lines.map(line => (
                  <Text
                    key={line}
                    style={[
                      t.type.body,
                      styles.lossLine,
                      { color: t.color.inkBody },
                    ]}
                  >
                    {line}
                  </Text>
                ))}
              </View>
              <View style={styles.sectionInfo}>
                <InfoDisclosure
                  label={LOSS_COPY.infoLabel}
                  lines={LOSS_COPY.infoLines}
                  testID="settings-loss-info"
                />
              </View>
              <DoneLink onPress={() => toFlow({ step: 'menu' })} />
            </View>
          ) : null}

          {flow.step === 'current' ||
          flow.step === 'enter' ||
          flow.step === 'confirm' ? (
            <View style={styles.pinFlow}>
              <Text
                style={[t.type.body, styles.prompt, { color: t.color.inkBody }]}
                testID="settings-pin-prompt"
              >
                {pinPrompt}
              </Text>
              {error ? (
                <InlineError message={error} testID="settings-pin-error" />
              ) : null}
              <PinPad
                value={value}
                onChange={next => {
                  setError(null);
                  setValue(next);
                }}
                onSubmit={() => void submitPin()}
                disabled={busy}
              />
              <CancelLink onPress={() => toFlow({ step: 'menu' })} />
            </View>
          ) : null}

          {flow.step === 'explain' ? (
            <View style={styles.pinFlow}>
              <Text style={[t.type.sectionTitle, { color: t.color.inkStrong }]}>
                {COPY.explainTitle}
              </Text>
              {error ? (
                <InlineError message={error} testID="settings-commit-error" />
              ) : null}
              <Text
                style={[
                  t.type.body,
                  styles.explain,
                  { color: t.color.inkBody },
                ]}
              >
                {COPY.explain}
              </Text>
              <PrimaryButton
                label={
                  flow.mode === 'enable'
                    ? COPY.confirmEnable
                    : COPY.confirmChange
                }
                busy={busy}
                busyLabel={COPY.commitBusy}
                onPress={() => void commit()}
                testID="settings-lock-commit"
              />
              <CancelLink onPress={() => toFlow({ step: 'menu' })} />
            </View>
          ) : null}
        </View>
      </ScrollView>
    </View>
  );
}

function SettingsSheet({
  children,
  top,
}: {
  children: React.ReactNode;
  top?: boolean;
}) {
  const t = useTheme();
  return (
    <View
      style={[
        styles.sheet,
        top ? styles.detailStart : null,
        {
          marginHorizontal: -t.layout.gutter,
          backgroundColor: t.color.paperSheet,
          borderColor: t.color.lineSoft,
          borderTopWidth: t.hairline,
          borderBottomWidth: t.hairline,
        },
      ]}
    >
      {children}
    </View>
  );
}

function MenuRow({
  label,
  detail,
  onPress,
  testID,
  first,
  danger,
}: {
  label: string;
  detail?: string;
  onPress: () => void;
  testID: string;
  first?: boolean;
  danger?: boolean;
}) {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={detail}
      testID={testID}
      onPress={onPress}
      style={({ pressed }) => [
        styles.menuRow,
        {
          minHeight: t.layout.rowHeight,
          paddingHorizontal: t.layout.gutter,
          backgroundColor: pressed ? t.color.paperInset : 'transparent',
          marginTop: first ? 0 : undefined,
        },
      ]}
    >
      <View style={styles.menuRowText}>
        <Text
          style={[
            t.type.rowTitle,
            { color: danger ? t.color.danger : t.color.inkStrong },
          ]}
        >
          {label}
        </Text>
        {detail ? (
          <Text
            style={[
              t.type.compactBody,
              styles.menuRowDetail,
              { color: t.color.inkMuted },
            ]}
          >
            {detail}
          </Text>
        ) : null}
      </View>
      <Text style={[t.type.iconGlyph, { color: t.color.inkMuted }]}>›</Text>
    </Pressable>
  );
}

function RowRule() {
  const t = useTheme();
  return (
    <View
      style={{
        marginLeft: t.layout.gutter,
        height: t.hairline,
        backgroundColor: t.color.lineSoft,
      }}
    />
  );
}

/**
 * The quiet link that leaves a step. One shape, two words: the PIN steps back
 * OUT of something a person started, and the two read-only steps (the
 * Licences notice, the loss page) are simply finished with. The testIDs stay
 * distinct so a suite can tell which one a step is offering.
 */
function StepLink({
  label,
  testID,
  onPress,
}: {
  label: string;
  testID: string;
  onPress: () => void;
}) {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      testID={testID}
      onPress={onPress}
      style={({ pressed }) => [
        styles.cancel,
        {
          minHeight: t.layout.touchTarget,
          borderRadius: t.radius.button,
          backgroundColor: pressed ? t.color.pineWash : 'transparent',
        },
      ]}
    >
      <Text style={[t.type.buttonCompact, { color: t.color.pine }]}>
        {label}
      </Text>
    </Pressable>
  );
}

function CancelLink({ onPress }: { onPress: () => void }) {
  return (
    <StepLink
      label={COPY.cancel}
      testID="settings-pin-cancel"
      onPress={onPress}
    />
  );
}

function DoneLink({ onPress }: { onPress: () => void }) {
  return (
    <StepLink label={COPY.done} testID="settings-step-done" onPress={onPress} />
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { paddingBottom: 48, alignItems: 'center' },
  /** Full width until contentMax caps it — the Register/Profile pattern. */
  column: { width: '100%' },
  sheet: {},
  menuRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 10,
  },
  menuRowText: { flex: 1, paddingRight: 12 },
  menuRowDetail: { marginTop: 2 },
  categoryLead: { marginBottom: 8 },
  categoryNote: { marginBottom: 16 },
  detailStart: { marginTop: 24 },
  lockStatus: { paddingHorizontal: 10, paddingTop: 10 },
  lockStatusLoading: { paddingHorizontal: 6, paddingBottom: 10 },
  pinFlow: { marginTop: 16, alignItems: 'center' },
  /** The section-level ⓘ under a sheet (the screenshot truth). */
  sectionInfo: { marginTop: 10 },
  /** The unactionable "needs App Lock" status under the Field Mode row —
   * inside the sheet, aligned with ChoiceRow's own horizontal padding. */
  // marginTop is the house spacing for a line hung under a row's content
  // (`sectionInfo` below); without it this sits flush against the ⓘ that
  // ends the ChoiceRow.
  needsLock: { paddingHorizontal: 16, paddingBottom: 10, marginTop: 10 },
  /** A note hung under a MenuRow inside a sheet (Lock now's cost). Aligned
   * with ChoiceRow's own horizontal padding, like `needsLock` above — the
   * two are the same idiom and must not drift apart. */
  rowNote: { paddingHorizontal: 16, paddingBottom: 10, marginTop: 2 },
  prompt: { marginBottom: 16, textAlign: 'center' },
  explain: { marginTop: 12, marginBottom: 24 },
  /** One paragraph of the loss page. The same rhythm as `explain` above,
   * split per line because these are four separate claims and reading them
   * as one block hides that. */
  lossLine: { marginTop: 16 },
  versionLine: { marginTop: 12, textAlign: 'center' },
  cancel: {
    marginTop: 16,
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
