import React, { useEffect, useState } from 'react';
import {
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { ACCOUNTS_COPY } from '../accountsCopy';
import { ACCOUNTS_USERNAME_COPY } from '../accountsUsernameCopy';
import { appearanceChoice, setAppearanceChoice } from '../appearance';
import { setupDecoy } from '../decoy';
import * as db from '../db';
import { DEVICE_NOUN } from '../deviceNoun';
import { LINKING_COPY } from '../linkingCopy';
import * as lock from '../lock';
import { messageSoundEnabled, setMessageSound } from '../messageSound';
import {
  previewLevel,
  setPreviewLevel,
  type PreviewLevel,
} from '../previews';
import { readReceiptsEnabled, setReadReceipts } from '../readReceipts';
import { setTypingIndicators, typingIndicatorsEnabled } from '../typingIndicators';
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
import {
  PRIVACY_URL,
  SOURCE_URL,
  TERMS_URL,
  VERSION_LABEL,
} from '../version';
import { PinPad } from '../ui/PinPad';
import { InlineError, InlineNotice, RuledLabel, ScreenHeader } from '../ui/primitives';

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

const COPY = {
  title: 'Settings',
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
  enableRow: 'Turn on App Lock',
  changeRow: 'Change code',
  resetDecoysRow: 'Rebuild decoy conversations',
  disableRow: 'Turn off App Lock',
  autolockLabel: 'Auto-lock',
  autolockOptions: [
    { label: 'Right away', sec: 0 },
    { label: '1 min', sec: 60 },
    { label: '5 min', sec: 300 },
  ],
  enterPrompt: 'Choose a code — 4 to 10 digits',
  confirmPrompt: 'Enter the same code again',
  currentPrompt: 'Enter your current code',
  mismatch: 'The codes didn’t match. Start over.',
  wrong: 'Wrong code.',
  cooldown: 'Too many tries. Wait a bit, then try again.',
  explainTitle: 'One code, two doors',
  // The device is named in the
  // platform's own words via the token wherever a sentence names it.
  explain: `Unlock with your code and Tacendum opens your conversations. Enter the same code backwards and it opens a decoy instead — invented people, unreadable messages — while your real conversations stay sealed.\n\nThere is no way to recover a forgotten code. You would have to sign out, and message history on this ${DEVICE_NOUN} cannot be restored.`,
  confirmEnable: 'Turn on App Lock',
  confirmChange: 'Use this code',
  enabled: 'App Lock is on.',
  changed: 'Code changed.',
  disabled: 'App Lock is off.',
  decoysRebuilt: 'Decoy conversations rebuilt.',
  cancel: 'Cancel',
  failed: 'Something went wrong. Nothing was changed — try again.',
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
      ? `Screenshots and screen recordings are blocked on this ${DEVICE_NOUN}. The system refuses them, and anything that captures the screen anyway records a blank. Nothing is announced in the conversation, because there is nothing to announce — prevented, not disclosed.`
      : `Screenshots can’t be blocked on ${DEVICE_NOUN}. When one is taken in a conversation, the conversation says so — on both sides.`,
  callsSection: 'CALLS',
  // "Every call", not "always relay": the switch is about what happens to
  // calls, and the word "relay" only means something to someone who has read
  // the note below it. The note is where the machinery gets named.
  relayLabel: 'Relay every call',
  relayOptions: [
    { label: 'On', value: true },
    { label: 'Off', value: false },
  ],
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
        'for the conversation you are reading, and never during a call. ' +
        `Sounds for messages that arrive while Tacendum is closed follow this ${DEVICE_NOUN}’s ` +
        'notification settings for Tacendum, which this switch does not change. ' +
        'Calls ring on their own.'
      : 'A short tone when a message arrives while Tacendum is open, and the ' +
        'sound on its notifications while it is closed — not for the ' +
        'conversation you are reading, and never during a call. Your ' +
        `${DEVICE_NOUN}’s notification settings and its silent switch decide first: ` +
        'Off here only takes a sound away. Calls ring on their own.',
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

type Flow =
  | { step: 'menu' }
  | { step: 'current'; next: 'change' | 'disable' | 'reset' }
  | { step: 'enter'; mode: 'enable' | 'change' }
  | { step: 'confirm'; mode: 'enable' | 'change'; first: string }
  | { step: 'explain'; mode: 'enable' | 'change'; code: string }
  | { step: 'licenses' };

interface Props {
  onBack: () => void;
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
}

export function SettingsScreen({
  onBack,
  onOpenLinkedDevices,
  onOpenAccountEmail,
  onOpenAccountUsername,
}: Props) {
  const t = useTheme();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [autolockSec, setAutolockSec] = useState(0);
  const [flow, setFlow] = useState<Flow>({ step: 'menu' });
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [blankEnabled, setBlankEnabled] = useState(screenSecurity.blankEnabled);
  const [receipts, setReceipts] = useState(readReceiptsEnabled);
  const [typing, setTyping] = useState(typingIndicatorsEnabled);
  const [preview, setPreview] = useState<PreviewLevel>(previewLevel);
  const [appearance, setAppearance] = useState(appearanceChoice);
  // Read synchronously from the loaded preference; the
  // Keychain read happens at init and on every real unlock.
  const [pushAllowed, setPushAllowed] = useState(pushTokensAllowed());
  const [pushBusy, setPushBusy] = useState(false);
  const [pushFailed, setPushFailed] = useState(false);
  // The design. Read synchronously from the loaded preference, like the push row
  // above: the Keychain read happens at init and on every real unlock.
  const [relayAll, setRelayAll] = useState(alwaysRelayEnabled);
  // read the same way and for the same reason: the Keychain read
  // happens at init and on every real unlock, so the row starts from the
  // loaded preference rather than from this component's idea of the default.
  const [silenceUnknown, setSilenceUnknown] = useState(
    silenceUnknownCallersEnabled,
  );
  // The message chime. Read synchronously from the loaded preference like
  // the rows above: messaging.start() loads it on every real unlock, before
  // this sheet can be reached, and a duress session shows its own shadow.
  // No re-read on mount — a read landing after a tap would revert the chip
  // to the file's old value, and there is nothing newer to learn.
  const [sound, setSound] = useState(messageSoundEnabled);

  useEffect(() => {
    void lock.status().then(s => {
      // The session override wins over the Keychain: in duress, mutations
      // are Keychain no-ops, but the session must tell ONE story.
      setEnabled(session.lockUi.enabled ?? s.enabled);
      setAutolockSec(session.lockUi.autolockSec ?? s.autolockSec);
    });
  }, []);

  const toFlow = (next: Flow) => {
    setValue('');
    setError(null);
    setFlow(next);
  };

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

  const submitPin = async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (flow.step === 'current') {
        const result = await lock.verify(value);
        if (result.verdict === 'fail') return setError(COPY.wrong);
        if (result.verdict === 'cooldown') return setError(COPY.cooldown);
        if (flow.next === 'change') return toFlow({ step: 'enter', mode: 'change' });
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
    }
  };

  const commit = async () => {
    if (flow.step !== 'explain' || busy) return;
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
    }
  };

  const chooseAutolock = async (sec: number) => {
    setAutolockSec(sec); // session-scoped truth; identical in both modes
    session.setLockUi({ autolockSec: sec });
    await lock.setAutolock(sec);
  };

  const chooseBlank = async (nextEnabled: boolean) => {
    setBlankEnabled(nextEnabled);
    await screenSecurity.setBlankEnabled(nextEnabled);
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
    setReceipts(nextEnabled);
    await setReadReceipts(nextEnabled);
  };

  const chooseTyping = async (nextEnabled: boolean) => {
    setTyping(nextEnabled);
    await setTypingIndicators(nextEnabled);
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
    // on disk and the next launch shows it again, which is the honest
    // outcome — the alternative is a row that silently disagrees with what
    // the notification will actually do.
    setPreview(next);
    await setPreviewLevel(next);
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

  const pinPrompt =
    flow.step === 'current'
      ? COPY.currentPrompt
      : flow.step === 'confirm'
        ? COPY.confirmPrompt
        : COPY.enterPrompt;

  return (
    <View style={styles.container} testID="settings-screen">
      <ScreenHeader title={COPY.title} onBack={onBack} testIDBack="settings-back" />
      <ScrollView
        contentContainerStyle={[styles.content, { paddingHorizontal: t.layout.gutter }]}
      >
        {/* The reading column: capped at contentMax
            like Register/Profile, so a medium/expanded pane hands this
            screen an honest width instead of stretching every row across
            the glass. Width-only; on phones the cap never engages. */}
        <View style={[styles.column, { maxWidth: t.layout.contentMax }]}>
          <RuledLabel label={COPY.lockSection} marginTop={24} marginBottom={12} />
          {notice ? <InlineNotice message={notice} tone="pine" marginTop={0} /> : null}

          {flow.step === 'menu' && enabled !== null && (
            <View
              style={[
                styles.sheet,
                {
                  marginHorizontal: -t.layout.gutter,
                  backgroundColor: t.color.paperSheet,
                  borderColor: t.color.lineSoft,
                  borderTopWidth: t.hairline,
                  borderBottomWidth: t.hairline,
                },
              ]}
            >
              {!enabled ? (
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
                    onPress={() => toFlow({ step: 'current', next: 'change' })}
                    first
                  />
                  <RowRule />
                  <View style={[styles.autolockRow, { minHeight: t.layout.rowHeight }]}>
                    <Text style={[t.type.rowTitle, { color: t.color.inkStrong }]}>
                      {COPY.autolockLabel}
                    </Text>
                    <View style={styles.autolockChoices}>
                      {COPY.autolockOptions.map(option => {
                        const selected = autolockSec === option.sec;
                        return (
                          <Pressable
                            key={option.sec}
                            accessibilityRole="button"
                            accessibilityState={{ selected }}
                            testID={`settings-autolock-${option.sec}`}
                            // 44pt effective without enlarging the visual.
                            hitSlop={{ top: 5, bottom: 5 }}
                            onPress={() => void chooseAutolock(option.sec)}
                            style={[
                              styles.chip,
                              {
                                borderRadius: t.radius.button,
                                backgroundColor: selected
                                  ? t.color.pineWash
                                  : 'transparent',
                                borderWidth: t.hairline,
                                borderColor: selected
                                  ? t.color.pineLine
                                  : t.color.lineSoft,
                              },
                            ]}
                          >
                            <Text
                              style={[
                                t.type.buttonCompact,
                                { color: selected ? t.color.pine : t.color.inkMuted },
                              ]}
                            >
                              {option.label}
                            </Text>
                          </Pressable>
                        );
                      })}
                    </View>
                  </View>
                  <RowRule />
                  <MenuRow
                    label={COPY.resetDecoysRow}
                    testID="settings-lock-reset-decoys"
                    onPress={() => toFlow({ step: 'current', next: 'reset' })}
                  />
                  <RowRule />
                  <MenuRow
                    label={COPY.disableRow}
                    testID="settings-lock-disable"
                    onPress={() => toFlow({ step: 'current', next: 'disable' })}
                    danger
                  />
                </>
              )}
            </View>
          )}

          {flow.step === 'menu' && (
            <>
              {/* The two account entries:
                  each row is the ONE Settings door to a surface that already
                  landed — routes, screens, back mapping and DEPTH already live
                  in App.tsx; each entry here is exactly one line. */}
              <RuledLabel
                label={COPY.accountSection}
                marginTop={32}
                marginBottom={12}
              />
              <View
                style={[
                  styles.sheet,
                  {
                    marginHorizontal: -t.layout.gutter,
                    backgroundColor: t.color.paperSheet,
                    borderColor: t.color.lineSoft,
                    borderTopWidth: t.hairline,
                    borderBottomWidth: t.hairline,
                  },
                ]}
              >
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
                {/* THE USERNAME DOOR, dark behind the
                    build pin exactly as the surface it opens is. */}
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
              </View>

              <RuledLabel
                label={COPY.screenSection}
                marginTop={32}
                marginBottom={12}
              />
              <View
                style={[
                  styles.sheet,
                  {
                    marginHorizontal: -t.layout.gutter,
                    backgroundColor: t.color.paperSheet,
                    borderColor: t.color.lineSoft,
                    borderTopWidth: t.hairline,
                    borderBottomWidth: t.hairline,
                  },
                ]}
              >
                <View
                  style={[styles.autolockRow, { minHeight: t.layout.rowHeight }]}
                >
                  <Text style={[t.type.rowTitle, { color: t.color.inkStrong }]}>
                    {COPY.blankLabel}
                  </Text>
                  <View style={styles.autolockChoices}>
                    {COPY.blankOptions.map(option => {
                      const selected = blankEnabled === option.value;
                      return (
                        <Pressable
                          key={option.label}
                          accessibilityRole="button"
                          accessibilityState={{ selected }}
                          testID={`settings-screensec-${option.value ? 'on' : 'off'}`}
                          // 44pt effective without enlarging the visual.
                          hitSlop={{ top: 5, bottom: 5 }}
                          onPress={() => void chooseBlank(option.value)}
                          style={[
                            styles.chip,
                            {
                              borderRadius: t.radius.button,
                              backgroundColor: selected
                                ? t.color.pineWash
                                : 'transparent',
                              borderWidth: t.hairline,
                              borderColor: selected
                                ? t.color.pineLine
                                : t.color.lineSoft,
                            },
                          ]}
                        >
                          <Text
                            style={[
                              t.type.buttonCompact,
                              {
                                color: selected
                                  ? t.color.pine
                                  : t.color.inkMuted,
                              },
                            ]}
                          >
                            {option.label}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                </View>
                <View
                  style={[styles.autolockRow, { minHeight: t.layout.rowHeight }]}
                >
                  <Text style={[t.type.rowTitle, { color: t.color.inkStrong }]}>
                    {COPY.receiptsLabel}
                  </Text>
                  <View style={styles.autolockChoices}>
                    {COPY.receiptOptions.map(option => {
                      const selected = receipts === option.value;
                      return (
                        <Pressable
                          key={option.label}
                          accessibilityRole="button"
                          accessibilityState={{ selected }}
                          testID={`settings-receipts-${option.value ? 'on' : 'off'}`}
                          hitSlop={{ top: 5, bottom: 5 }}
                          onPress={() => void chooseReceipts(option.value)}
                          style={[
                            styles.chip,
                            {
                              borderRadius: t.radius.button,
                              backgroundColor: selected
                                ? t.color.pineWash
                                : 'transparent',
                              borderWidth: t.hairline,
                              borderColor: selected
                                ? t.color.pineLine
                                : t.color.lineSoft,
                            },
                          ]}
                        >
                          <Text
                            style={[
                              t.type.buttonCompact,
                              {
                                color: selected ? t.color.pine : t.color.inkMuted,
                              },
                            ]}
                          >
                            {option.label}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                </View>
                <View
                  style={[styles.autolockRow, { minHeight: t.layout.rowHeight }]}
                >
                  <Text style={[t.type.rowTitle, { color: t.color.inkStrong }]}>
                    {COPY.typingLabel}
                  </Text>
                  <View style={styles.autolockChoices}>
                    {COPY.typingOptions.map(option => {
                      const selected = typing === option.value;
                      return (
                        <Pressable
                          key={option.label}
                          accessibilityRole="button"
                          accessibilityState={{ selected }}
                          testID={`settings-typing-${option.value ? 'on' : 'off'}`}
                          hitSlop={{ top: 5, bottom: 5 }}
                          onPress={() => void chooseTyping(option.value)}
                          style={[
                            styles.chip,
                            {
                              borderRadius: t.radius.button,
                              backgroundColor: selected
                                ? t.color.pineWash
                                : 'transparent',
                              borderWidth: t.hairline,
                              borderColor: selected
                                ? t.color.pineLine
                                : t.color.lineSoft,
                            },
                          ]}
                        >
                          <Text
                            style={[
                              t.type.buttonCompact,
                              {
                                color: selected ? t.color.pine : t.color.inkMuted,
                              },
                            ]}
                          >
                            {option.label}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                </View>
              </View>
              <Text
                style={[
                  t.type.compactBody,
                  styles.sectionNote,
                  { color: t.color.inkMuted },
                ]}
              >
                {COPY.receiptsNote}
              </Text>
              <Text
                style={[
                  t.type.compactBody,
                  styles.sectionNote,
                  { color: t.color.inkMuted },
                ]}
              >
                {COPY.typingNote}
              </Text>
              <Text
                style={[
                  t.type.compactBody,
                  styles.sectionNote,
                  { color: t.color.inkMuted },
                ]}
              >
                {COPY.shotNote}
              </Text>

              {/* The design. Its own section rather than a row under SCREEN: this one
                  is about what leaves the phone over the network, not about
                  what is on the glass. */}
              <RuledLabel
                label={COPY.callsSection}
                marginTop={32}
                marginBottom={12}
              />
              <View
                style={[
                  styles.sheet,
                  {
                    marginHorizontal: -t.layout.gutter,
                    backgroundColor: t.color.paperSheet,
                    borderColor: t.color.lineSoft,
                    borderTopWidth: t.hairline,
                    borderBottomWidth: t.hairline,
                  },
                ]}
              >
                <View
                  style={[styles.autolockRow, { minHeight: t.layout.rowHeight }]}
                >
                  <Text style={[t.type.rowTitle, { color: t.color.inkStrong }]}>
                    {COPY.relayLabel}
                  </Text>
                  <View style={styles.autolockChoices}>
                    {COPY.relayOptions.map(option => {
                      const selected = relayAll === option.value;
                      return (
                        <Pressable
                          key={option.label}
                          accessibilityRole="button"
                          accessibilityState={{ selected }}
                          testID={`settings-relay-${option.value ? 'on' : 'off'}`}
                          hitSlop={{ top: 5, bottom: 5 }}
                          onPress={() => void chooseRelay(option.value)}
                          style={[
                            styles.chip,
                            {
                              borderRadius: t.radius.button,
                              backgroundColor: selected
                                ? t.color.pineWash
                                : 'transparent',
                              borderWidth: t.hairline,
                              borderColor: selected
                                ? t.color.pineLine
                                : t.color.lineSoft,
                            },
                          ]}
                        >
                          <Text
                            style={[
                              t.type.buttonCompact,
                              {
                                color: selected
                                  ? t.color.pine
                                  : t.color.inkMuted,
                              },
                            ]}
                          >
                            {option.label}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                </View>
                {/* in this sheet rather than its own section: both rows
                    decide what a call is allowed to do to this phone, and the
                    SCREEN section above is the precedent for two rows sharing a
                    sheet with their notes stacked below in the same order. */}
                <View
                  style={[styles.autolockRow, { minHeight: t.layout.rowHeight }]}
                >
                  <Text style={[t.type.rowTitle, { color: t.color.inkStrong }]}>
                    {COPY.silenceLabel}
                  </Text>
                  <View style={styles.autolockChoices}>
                    {COPY.silenceOptions.map(option => {
                      const selected = silenceUnknown === option.value;
                      return (
                        <Pressable
                          key={option.label}
                          accessibilityRole="button"
                          accessibilityState={{ selected }}
                          testID={`settings-silence-${option.value ? 'on' : 'off'}`}
                          hitSlop={{ top: 5, bottom: 5 }}
                          onPress={() => void chooseSilence(option.value)}
                          style={[
                            styles.chip,
                            {
                              borderRadius: t.radius.button,
                              backgroundColor: selected
                                ? t.color.pineWash
                                : 'transparent',
                              borderWidth: t.hairline,
                              borderColor: selected
                                ? t.color.pineLine
                                : t.color.lineSoft,
                            },
                          ]}
                        >
                          <Text
                            style={[
                              t.type.buttonCompact,
                              {
                                color: selected
                                  ? t.color.pine
                                  : t.color.inkMuted,
                              },
                            ]}
                          >
                            {option.label}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                </View>
              </View>
              <Text
                testID="settings-relay-note"
                style={[
                  t.type.compactBody,
                  styles.sectionNote,
                  { color: t.color.inkMuted },
                ]}
              >
                {COPY.relayNote}
              </Text>
              <Text
                testID="settings-silence-note"
                style={[
                  t.type.compactBody,
                  styles.sectionNote,
                  { color: t.color.inkMuted },
                ]}
              >
                {COPY.silenceNote}
              </Text>

              <RuledLabel
                label={COPY.notificationsSection}
                marginTop={32}
                marginBottom={12}
              />
              <View
                style={[
                  styles.sheet,
                  {
                    marginHorizontal: -t.layout.gutter,
                    backgroundColor: t.color.paperSheet,
                    borderColor: t.color.lineSoft,
                    borderTopWidth: t.hairline,
                    borderBottomWidth: t.hairline,
                  },
                ]}
              >
                <View
                  style={[styles.autolockRow, { minHeight: t.layout.rowHeight }]}
                >
                  <Text style={[t.type.rowTitle, { color: t.color.inkStrong }]}>
                    {COPY.previewLabel}
                  </Text>
                  <View style={styles.autolockChoices}>
                    {COPY.previewOptions.map(option => {
                      const selected = preview === option.value;
                      return (
                        <Pressable
                          key={option.value}
                          accessibilityRole="button"
                          accessibilityState={{ selected }}
                          testID={`settings-preview-${option.value}`}
                          hitSlop={{ top: 5, bottom: 5 }}
                          onPress={() => void choosePreview(option.value)}
                          style={[
                            styles.chip,
                            {
                              borderRadius: t.radius.button,
                              backgroundColor: selected
                                ? t.color.pineWash
                                : 'transparent',
                              borderWidth: t.hairline,
                              borderColor: selected
                                ? t.color.pineLine
                                : t.color.lineSoft,
                            },
                          ]}
                        >
                          <Text
                            style={[
                              t.type.buttonCompact,
                              {
                                color: selected
                                  ? t.color.pine
                                  : t.color.inkMuted,
                              },
                            ]}
                          >
                            {option.label}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                </View>
                {/* Below the preview control because it is the
                    broader switch: previews decide what a notification SHOWS,
                    this decides whether Apple holds a token for this device at
                    all. */}
                <View
                  style={[styles.autolockRow, { minHeight: t.layout.rowHeight }]}
                >
                  <Text style={[t.type.rowTitle, { color: t.color.inkStrong }]}>
                    {COPY.pushLabel}
                  </Text>
                  <View style={styles.autolockChoices}>
                    {COPY.pushOptions.map(option => {
                      const selected = pushAllowed === option.value;
                      return (
                        <Pressable
                          key={option.label}
                          accessibilityRole="button"
                          accessibilityState={{ selected, disabled: pushBusy }}
                          testID={`settings-push-${option.value ? 'on' : 'off'}`}
                          hitSlop={{ top: 5, bottom: 5 }}
                          disabled={pushBusy}
                          onPress={() => void choosePush(option.value)}
                          style={[
                            styles.chip,
                            {
                              borderRadius: t.radius.button,
                              backgroundColor: selected
                                ? t.color.pineWash
                                : 'transparent',
                              borderWidth: t.hairline,
                              borderColor: selected
                                ? t.color.pineLine
                                : t.color.lineSoft,
                            },
                          ]}
                        >
                          <Text
                            style={[
                              t.type.buttonCompact,
                              {
                                color: selected
                                  ? t.color.pine
                                  : t.color.inkMuted,
                              },
                            ]}
                          >
                            {option.label}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                </View>
                {/* The message chime. Below the push row, the
                    outer authority: that one decides whether a wake reaches
                    this device at all, this only whether a message that
                    does makes a sound. */}
                <View
                  style={[styles.autolockRow, { minHeight: t.layout.rowHeight }]}
                >
                  <Text style={[t.type.rowTitle, { color: t.color.inkStrong }]}>
                    {COPY.soundLabel}
                  </Text>
                  <View style={styles.autolockChoices}>
                    {COPY.soundOptions.map(option => {
                      const selected = sound === option.value;
                      return (
                        <Pressable
                          key={option.label}
                          accessibilityRole="button"
                          accessibilityState={{ selected }}
                          testID={`settings-sound-${option.value ? 'on' : 'off'}`}
                          hitSlop={{ top: 5, bottom: 5 }}
                          onPress={() => void chooseSound(option.value)}
                          style={[
                            styles.chip,
                            {
                              borderRadius: t.radius.button,
                              backgroundColor: selected
                                ? t.color.pineWash
                                : 'transparent',
                              borderWidth: t.hairline,
                              borderColor: selected
                                ? t.color.pineLine
                                : t.color.lineSoft,
                            },
                          ]}
                        >
                          <Text
                            style={[
                              t.type.buttonCompact,
                              {
                                color: selected
                                  ? t.color.pine
                                  : t.color.inkMuted,
                              },
                            ]}
                          >
                            {option.label}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                </View>
              </View>
              <Text
                testID="settings-push-note"
                style={[
                  t.type.compactBody,
                  styles.sectionNote,
                  { color: t.color.inkMuted },
                ]}
              >
                {COPY.pushNote}
              </Text>
              {pushFailed ? (
                <InlineError message={COPY.pushFailed} testID="settings-push-error" />
              ) : null}
              <Text
                style={[
                  t.type.compactBody,
                  styles.sectionNote,
                  { color: t.color.inkMuted },
                ]}
              >
                {COPY.previewNote}
              </Text>
              <Text
                testID="settings-sound-note"
                style={[
                  t.type.compactBody,
                  styles.sectionNote,
                  { color: t.color.inkMuted },
                ]}
              >
                {COPY.soundNote}
              </Text>

              <RuledLabel
                label={COPY.appearanceSection}
                marginTop={32}
                marginBottom={12}
              />
              <View
                style={[
                  styles.sheet,
                  {
                    marginHorizontal: -t.layout.gutter,
                    backgroundColor: t.color.paperSheet,
                    borderColor: t.color.lineSoft,
                    borderTopWidth: t.hairline,
                    borderBottomWidth: t.hairline,
                  },
                ]}
              >
                <View
                  style={[styles.autolockRow, { minHeight: t.layout.rowHeight }]}
                >
                  <Text style={[t.type.rowTitle, { color: t.color.inkStrong }]}>
                    {COPY.appearanceLabel}
                  </Text>
                  <View style={styles.autolockChoices}>
                    {COPY.appearanceOptions.map(option => {
                      const selected = appearance === option.value;
                      return (
                        <Pressable
                          key={option.value}
                          accessibilityRole="button"
                          accessibilityState={{ selected }}
                          testID={`settings-appearance-${option.value}`}
                          hitSlop={{ top: 5, bottom: 5 }}
                          onPress={() => {
                            setAppearanceChoice(option.value);
                            setAppearance(option.value);
                          }}
                          style={[
                            styles.chip,
                            {
                              borderRadius: t.radius.button,
                              backgroundColor: selected
                                ? t.color.pineWash
                                : 'transparent',
                              borderWidth: t.hairline,
                              borderColor: selected
                                ? t.color.pineLine
                                : t.color.lineSoft,
                            },
                          ]}
                        >
                          <Text
                            style={[
                              t.type.buttonCompact,
                              {
                                color: selected
                                  ? t.color.pine
                                  : t.color.inkMuted,
                              },
                            ]}
                          >
                            {option.label}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                </View>
              </View>

              <RuledLabel
                label={COPY.aboutSection}
                marginTop={32}
                marginBottom={12}
              />
              <View
                style={[
                  styles.sheet,
                  {
                    marginHorizontal: -t.layout.gutter,
                    backgroundColor: t.color.paperSheet,
                    borderColor: t.color.lineSoft,
                    borderTopWidth: t.hairline,
                    borderBottomWidth: t.hairline,
                  },
                ]}
              >
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
              </View>
              {/*
                The version is here rather than in a row of its own because it
                is a fact, not an action — and because a bug report, an App
                Review note and the source link above all have to agree on
                which build is being discussed. SOURCE_URL is derived from the
                same constant this line prints (version.ts), so they cannot
                drift apart.
              */}
              <Text
                testID="settings-version"
                // Mono, matching the other small factual readouts in the app
                // (timestamps, safety numbers). A version string is a thing you
                // transcribe into a bug report, not prose.
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
          )}

          {flow.step === 'licenses' && (
            <View style={styles.pinFlow}>
              <Text style={[t.type.sectionTitle, { color: t.color.inkStrong }]}>
                {COPY.licensesTitle}
              </Text>
              {/*
                Offline on purpose. This text is the NOTICE that has to travel
                with the binary; a screen that fetched it would show nothing on
                a plane, and "your licence terms require a network" is not a
                defensible reading of AGPL the design.
              */}
              <Text
                testID="settings-licenses-body"
                style={[t.type.body, styles.explain, { color: t.color.inkBody }]}
              >
                {COPY.licensesBody}
              </Text>
              <CancelLink onPress={() => toFlow({ step: 'menu' })} />
            </View>
          )}

          {(flow.step === 'current' ||
            flow.step === 'enter' ||
            flow.step === 'confirm') && (
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
          )}

          {flow.step === 'explain' && (
            <View style={styles.pinFlow}>
              <Text style={[t.type.sectionTitle, { color: t.color.inkStrong }]}>
                {COPY.explainTitle}
              </Text>
              {error ? (
                <InlineError message={error} testID="settings-commit-error" />
              ) : null}
              <Text
                style={[t.type.body, styles.explain, { color: t.color.inkBody }]}
              >
                {COPY.explain}
              </Text>
              <Pressable
                accessibilityRole="button"
                testID="settings-lock-commit"
                disabled={busy}
                onPress={() => void commit()}
                style={({ pressed }) => [
                  styles.commit,
                  {
                    minHeight: t.layout.buttonHeight,
                    borderRadius: t.radius.button,
                    backgroundColor: pressed ? t.color.pinePressed : t.color.pine,
                  },
                ]}
              >
                <Text style={[t.type.button, { color: t.color.onPine }]}>
                  {flow.mode === 'enable' ? COPY.confirmEnable : COPY.confirmChange}
                </Text>
              </Pressable>
              <CancelLink onPress={() => toFlow({ step: 'menu' })} />
            </View>
          )}
        </View>
      </ScrollView>
    </View>
  );
}

function MenuRow({
  label,
  onPress,
  testID,
  first,
  danger,
}: {
  label: string;
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
      <Text
        style={[
          t.type.rowTitle,
          { color: danger ? t.color.danger : t.color.inkStrong },
        ]}
      >
        {label}
      </Text>
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

function CancelLink({ onPress }: { onPress: () => void }) {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={COPY.cancel}
      testID="settings-pin-cancel"
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
        {COPY.cancel}
      </Text>
    </Pressable>
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
  },
  autolockRow: {
    paddingHorizontal: 16,
    paddingVertical: 5,
    gap: 8,
  },
  // Vertical padding here (not on the row) so the chips' hitSlop has parent
  // bounds to land in — RN hitSlop never extends past the parent view.
  autolockChoices: { flexDirection: 'row', gap: 8, paddingVertical: 5 },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pinFlow: { marginTop: 16, alignItems: 'center' },
  sectionNote: { marginTop: 10 },
  prompt: { marginBottom: 16, textAlign: 'center' },
  explain: { marginTop: 12, marginBottom: 24 },
  versionLine: { marginTop: 12, textAlign: 'center' },
  commit: {
    alignSelf: 'stretch',
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancel: {
    marginTop: 16,
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
