/**
 * Everything the app knows about safety numbers that is not a database read or
 * a native call: which state a conversation is in, what that state looks like,
 * what it says, and how a 60-digit number is presented to eyes and to
 * VoiceOver.
 *
 * The thread and the peer profile both show this, and until now each carried
 * its own copy — which is how the same conversation came to describe the
 * same recorded match two different ways, one of them beside a button that
 * CLEARED the record. One module means the two can no longer drift.
 *
 * Deliberately pure: no db, no messaging, no react-native import, so it is
 * unit-testable on its own and cannot pull a screen's worth of dependencies
 * into a test of a sentence. The device is named in the platform's own words
 * via `DEVICE_NOUN`,
 * a plain string constant.
 */

import { DEVICE_NOUN } from './deviceNoun';

/**
 * Precedence matters and is deliberate: changed > deviceAdded > mismatched >
 * none > matched > unchecked. A pending identity change outranks every
 * earlier finding because the number on screen belongs to a superseded key,
 * and a failed comparison outranks a match because the newer, worse answer
 * is the one a person needs to see.
 *
 * `deviceAdded` is its own finding class: the peer
 * added a device whose link certificate VERIFIED under a key this device
 * already pinned — a review item, ranked below 'changed'. An addition that
 * did NOT verify never reaches this state: `deviceAddedStateFor(false)` IS
 * 'changed', because an unprovable device claiming to be your contact is
 * exactly what a changed key is.
 */
/** Theme colour keys this module is allowed to name. */
export type SafetyTone =
  'lineStrong' | 'inkMuted' | 'warningMark' | 'warningInk' | 'pine' | 'danger';

export type SafetyState =
  'changed' | 'deviceAdded' | 'mismatched' | 'none' | 'matched' | 'unchecked';

/** Worst-first — the aggregation order, spelled once. */
export const SAFETY_PRECEDENCE: readonly SafetyState[] = [
  'changed',
  'deviceAdded',
  'mismatched',
  'none',
  'matched',
  'unchecked',
];

/**
 * The state a peer's device addition contributes: below 'changed'
 * when the cross-signature verified, AS 'changed' when it did not — an
 * un-cross-signed sibling is handled exactly like a key change.
 */
export function deviceAddedStateFor(crossSigned: boolean): SafetyState {
  return crossSigned ? 'deviceAdded' : 'changed';
}

/**
 * The chat header's aggregate over a multi-device peer: safety
 * numbers stay PER-DEVICE-PAIR under the hood, and the header shows the
 * WORST state across the peer's devices — the UI never pretends one number
 * covers three devices. Computed per LOCAL device from that device's own
 * pin store (verification state is a local human act, never synced).
 * An empty input is 'none': no pair, no number yet.
 */
export function aggregateSafetyStates(
  states: readonly SafetyState[],
): SafetyState {
  let worst: SafetyState | null = null;
  let worstRank = SAFETY_PRECEDENCE.length;
  for (const state of states) {
    const rank = SAFETY_PRECEDENCE.indexOf(state);
    if (rank !== -1 && rank < worstRank) {
      worst = state;
      worstRank = rank;
    }
  }
  return worst ?? 'none';
}

export function safetyStateFor(input: {
  /** Sending is paused pending review of an identity change. */
  blocked: boolean;
  /** The safety number, or null when no session exists yet. */
  safety: string | null;
  /** When this device recorded a match, or null. */
  checkedAt: number | null;
  /** When this device recorded a MISMATCH, or null. */
  mismatchAt: number | null;
}): SafetyState {
  if (input.blocked) return 'changed';
  if (input.mismatchAt != null) return 'mismatched';
  if (input.safety === null || input.safety === '') return 'none';
  if (input.checkedAt != null) return 'matched';
  return 'unchecked';
}

/**
 * The state's rule colour and its label ink, named as TOKEN KEYS rather than
 * literals: a screen resolves them against the live theme, so the palette has
 * exactly one definition and this module still imports no react-native.
 */
export const SAFETY_STATUS: Record<
  SafetyState,
  { rule: SafetyTone; ink: SafetyTone }
> = {
  /** Nothing has happened yet. */
  none: { rule: 'lineStrong', ink: 'inkMuted' },
  /** A thing to do, not a thing gone wrong. */
  unchecked: { rule: 'warningMark', ink: 'warningInk' },
  matched: { rule: 'pine', ink: 'pine' },
  mismatched: { rule: 'danger', ink: 'danger' },
  /** A review item, not an alarm: the addition VERIFIED under a key this
   * device already pinned — warning tones, exactly 'unchecked''s
   * class of thing-to-do. The unverified case never reaches this state
   * (`deviceAddedStateFor(false)` is 'changed'). */
  deviceAdded: { rule: 'warningMark', ink: 'warningInk' },
  changed: { rule: 'danger', ink: 'danger' },
};

/**
 * The number as the twelve five-digit groups it is meant to be read in. The
 * caller lays them out; splitting here means both screens show the same twelve
 * cells at any width and any text size, which is the whole point of a number
 * two people read to each other.
 */
export function safetyGroups(value: string): string[] {
  return value.match(/.{1,5}/g) ?? [];
}

/**
 * The number for VoiceOver. Digits are spaced so the speech synthesiser spells
 * them ("4 5 7 8 2") instead of saying "forty-five thousand seven hundred
 * eighty-two", which cannot be compared with what the other person is reading.
 * Groups are numbered so two people can find their place again.
 */
export function spokenSafetyNumber(value: string): string {
  return safetyGroups(value)
    .map((group, i) => `Group ${i + 1}: ${group.split('').join(' ')}.`)
    .join(' ');
}

/** When something was checked, in the words a person would use. */
export function safetyDate(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const startOfDay = (x: Date) =>
    new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOfDay(now) - startOfDay(d)) / 86400000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return d.toLocaleDateString(
    undefined,
    d.getFullYear() === now.getFullYear()
      ? { month: 'long', day: 'numeric' }
      : { month: 'long', day: 'numeric', year: 'numeric' },
  );
}

/**
 * One copy deck for both screens. Every field exists in every state (null
 * where a state has nothing to say) so a screen can index it by state without
 * a guard per field.
 *
 * `name` is a reference to the person as it should read INSIDE a sentence —
 * pass `personRef(...)`, not `personName(...)`, so an unnamed peer reads
 * "them" rather than an id fragment.
 */
export interface SafetyCopy {
  /** Status line shown beside the state's rule. */
  label: string;
  /** Headline above the body, where the state needs one. */
  title: ((name: string) => string) | null;
  /** The explanation. `date` comes from `safetyDate`. */
  body: (name: string, date?: string) => string;
  /** What the record does and does not do — never implied, always stated. */
  disclosure: ((name: string) => string) | null;
  /** Why nothing is going out. */
  blocked: string | null;
  /** Primary action label, null when there is nothing to do here. */
  action: string | null;
  /** What happens after the action. */
  followUp: string | null;
}

export const SAFETY_COPY: Record<SafetyState, SafetyCopy> = {
  none: {
    label: 'No number yet',
    title: null,
    body: name =>
      `You and ${name} will share a safety number once one of you sends a message. Comparing it is how you confirm you’re talking to the right person — and that nobody is in between.`,
    disclosure: null,
    blocked: null,
    action: null,
    followUp: null,
  },
  unchecked: {
    label: 'You haven’t checked this yet',
    title: null,
    body: name =>
      `Compare these numbers with ${name} in person or on a phone call. If every group matches, nobody is in the middle of this chat.`,
    disclosure: null,
    blocked: null,
    action: 'They match',
    followUp: null,
  },
  matched: {
    label: 'You marked this as matching',
    title: null,
    // The date is always available at the real call site (the record IS a
    // timestamp), but the sentence degrades rather than forcing a caller to
    // invent one.
    body: (name, date) =>
      `You checked these and they matched${
        date ? ` on ${date}` : ''
      }. This number should stay the same for as long as this conversation exists — check again whenever you like.`,
    disclosure: name =>
      `Only this ${DEVICE_NOUN} remembers this. ${name} isn’t told, and nothing changes about how your messages are sent.`,
    blocked: null,
    action: 'Compare again',
    followUp: null,
  },
  deviceAdded: {
    label: 'They added a device',
    title: null,
    /*
     * The CROSS-SIGNED case only: one of the keys this device already
     * pinned for them signed the new device in, so the innocent reading is
     * real here — unlike 'changed', where it is impossible. Each device pair
     * keeps its own safety number, and the drill-down says so instead of
     * pretending one number covers several devices.
     */
    /*
     * "Knew", never "verified": the vouching key is one this
     * device PINNED at first use — TOFU — unless a human actually compared
     * numbers. Claiming verification would launder first-use trust into a
     * human act that may never have happened.
     */
    body: name =>
      `${name} linked a new device to their account, and a device this one already knew for them vouched for it. Each of their devices has its own safety number with this one — compare the new one whenever you like.`,
    disclosure: () =>
      'Their devices share an account, not a key. Nothing about your existing safety numbers changed.',
    blocked: null,
    action: null,
    followUp: null,
  },
  mismatched: {
    label: `Did not match on this ${DEVICE_NOUN}`,
    title: null,
    body: () =>
      'The numbers you compared were different. That can happen if one of you was looking at the wrong conversation — or if someone is intercepting this one. Compare again in person before you send anything private.',
    disclosure: null,
    blocked: null,
    action: 'Compare again',
    followUp: null,
  },
  changed: {
    label: 'Needs review',
    title: name => `${name}’s safety number changed.`,
    /*
     * THE INNOCENT READING IS IMPOSSIBLE HERE, so it must not be offered.
     *
     * This copy used to lead with "that usually means they reinstalled
     * Tacendum or set up a new phone", on the theory that offering both
     * readings is fairer than only the alarming one. That theory was right in
     * general and WRONG for this product, because in this design a reinstall
     * cannot produce a changed safety number:
     *
     *   - an account IS a keypair, and the server refuses to change an
     *     account's identity key (`storeKeys` condition, 409
     *     identity_key_immutable) — a new key mints a NEW userId;
     *   - the identity keypair is a file in the App Group protocol store,
     *     excluded from backup, destroyed with the app container on uninstall;
     *   - so reinstalling, restoring, or moving phones produces a NEW CONTACT
     *     with a new id and a permanently silent old thread — never a changed
     *     number on this one.
     *
     * This state fires only when the SAME userId presents a DIFFERENT key,
     * which no honest event in this system can cause. The remaining
     * explanations are all hostile. Leading with a benign one made "Accept
     * change" the obvious move and quietly defeated the single control that
     * stands between the user and an interception.
     */
    body: () =>
      'This is not supposed to happen. Reinstalling or getting a new device would make them a new contact with a new ID — it would not change the number here. Someone may be trying to read this conversation. Check with them on a call you place yourself, or in person, before you accept.',
    disclosure: null,
    blocked: 'Nothing will send until you review this change.',
    action: 'Accept change',
    followUp:
      'A new safety number appears after you accept the change and send a message.',
  },
};

/**
 * What a safety number actually is. Nowhere in the app has ever said where the
 * number comes from, why both devices show the same one, or what a difference
 * would mean — without that, "compare these" is an instruction to perform a
 * ritual rather than a check someone can reason about.
 */
export const SAFETY_EXPLAINER: string[] = [
  'A safety number is built from both of your devices’ keys. The same pair of devices always shows the same number, and no one else can produce it.',
  'It does not change on its own. If either of you reinstalls Tacendum or moves to a new device, that person becomes a NEW contact with a new ID — the number on an existing conversation stays the same.',
  'So if your two devices show different numbers, or the number on an existing conversation changes, someone may be sitting between you. Don’t send anything private until you can compare again in person.',
];
