/**
 * Everything the Shared Room Vault says, plus the two pure rules about how it
 * says it (the mask, and how a refusal is worded).
 *
 * Deliberately pure, exactly like safety.ts and blocking.ts: no db, no
 * messaging, no envelope import, and from react-native only `Platform` — a
 * plain constant, imported for the two copy branches whose SUBSTANCE
 * diverges by platform (the clipboard's leak paths and the paste prompt).
 * The device NOUN is `DEVICE_NOUN`, never a branch. A sentence is testable without a screen,
 * and a colour is named as a TOKEN KEY the screen resolves against the live
 * theme — theme.ts owns the values, this file owns the words.
 *
 * THE ONE SENTENCE THIS DECK EXISTS TO KEEP HONEST. A vault is a retention
 * INCREASE. Every other confidentiality feature in this product removes
 * something — the timer deletes, the block discards, the ratchet forgets. This
 * one keeps a credential forever on purpose, and it does it in the same
 * database, under the same lock, as an ordinary message. That must be
 * stated rather than implied, so it is stated here once and
 * rendered everywhere from here.
 */

import { Platform } from 'react-native';
import { DEVICE_NOUN } from './deviceNoun';

/**
 * Theme colour keys this module may name — the SafetyTone / BlockTone contract
 * exactly.
 *
 * `danger` and `dangerWash` are absent for the same reason blocking.ts:52-57
 * gives. Two people editing the same door code without seeing each other is not
 * a fault, and a write that has not reached the other device yet is a thing to
 * do, not a thing gone wrong. Red stays reserved for the irreversible and the
 * alarming; a failed WRITE still reaches `InlineError`, which owns that colour.
 */
export type VaultTone = 'warningMark' | 'warningInk' | 'lineStrong' | 'inkMuted';

/**
 * What stands in for a value that has not been revealed.
 *
 * FIXED WIDTH, NEVER DERIVED FROM THE SECRET. One bullet per character is the
 * obvious implementation and it leaks the length of every credential in the
 * Room to anyone who glances at the screen — which is exactly the audience the
 * masking exists for. A four-digit door code and a 3,000-character SSH key must
 * look identical until someone deliberately asks to see one.
 */
export const MASKED_VALUE = '••••••••';

/**
 * How long a revealed value stays on glass before it re-masks on its own:
 * long enough to read a Wi-Fi key aloud or type a door code into a keypad,
 * short enough that a phone put down mid-visit is not still showing it.
 * Backgrounding re-masks at once, whatever the clock says. */
export const VAULT_REVEAL_MS = 45_000;

/**
 * How long a burst of messaging notifications is coalesced before the vault
 * section re-reads the Room. Every notification — a typing frame, a read
 * mark, a message in some other Room — used to re-read and re-parse the
 * whole thread; one read per quiet beat is the same answer, later by a beat
 * nobody can see. */
export const VAULT_RELOAD_DEBOUNCE_MS = 250;

/**
 * What a vault announcement's body BEGINS with — envelope.ts's sentinel plus
 * the kind, exactly as `encodeEnvelope` writes it (`tcm` is the schema's
 * first key) and exactly as strict as `parseEnvelope`'s own sentinel. The
 * undelivered-item read filters on it BEFORE parsing, so a thread of photos
 * and text costs a prefix compare per row, not a parse. */
export const VAULT_ENVELOPE_PREFIX = '{"tcm":"vault"';

/**
 * The status rule's colour and its label ink, as TOKEN KEYS. Slate once the
 * Room is holding something, the neutral rule when it is not — the same shape
 * `blockStatusTone` and `SAFETY_STATUS` use, so a screen resolves all three
 * the same way.
 */
export function vaultStatusTone(count: number): {
  rule: VaultTone;
  ink: VaultTone;
} {
  return count > 0
    ? { rule: 'warningMark', ink: 'warningInk' }
    : { rule: 'lineStrong', ink: 'inkMuted' };
}

/**
 * The section's copy. One deck, so the peer profile and anything that comes
 * after it cannot describe the same state two different ways.
 */
export const VAULT = {
  title: 'Vault',

  /** Beside the status rule. A count, not a boast. */
  status: (count: number) =>
    count === 0 ? 'Nothing here yet' : count === 1 ? '1 item' : `${count} items`,

  /**
   * The empty state INVITES rather than apologises: it names the thing the
   * feature is for, in the words people actually use for it, and it does not
   * say "empty", "no items", or "nothing to see".
   */
  invite:
    'The Wi-Fi password, the door code, the case reference — the things you two keep asking each other for. Put one here and it stays put instead of scrolling away.',
  addFirst: 'Add the first item',
  add: 'Add an item',

  /* ── composer ─────────────────────────────────────────── */
  composeTitle: 'New item',
  editTitle: 'Edit item',
  nameLabel: 'Name',
  namePlaceholder: 'Wi-Fi',
  valueLabel: 'Value',
  valuePlaceholder: 'The thing you keep re-typing',
  /** Live, on both fields, from the first character. */
  counter: (used: number, max: number) => `${used}/${max}`,
  /** Replaces the counter once the cap is passed, so the number to fix is the
   * one on screen rather than a subtraction the person has to do. */
  over: (by: number) => `${by} over`,
  save: 'Save',
  cancel: 'Cancel',

  /* ── a row ────────────────────────────────────────────── */
  /** The action says how long: a reveal is a window, not
   * a switch, and the person should know that before tapping. */
  show: `Show for ${VAULT_REVEAL_MS / 1000} s`,
  hide: 'Hide',
  /**
   * What VoiceOver reads in place of a masked value. The bullets themselves
   * would be read as punctuation, and the value must not be in this string —
   * an accessibility label is spoken out loud in the room.
   */
  hidden: 'Value hidden',
  showLabel: (name: string) => `Show the value of ${name}`,
  hideLabel: (name: string) => `Hide the value of ${name}`,
  copy: 'Copy',
  copyLabel: (name: string) => `Copy the value of ${name}`,
  /** Said after a copy, because the pasteboard is the one place this app
   * hands a credential to software it does not control. */
  copied: 'Copied. Tacendum clears the pasteboard in a minute.',
  edit: 'Edit',
  editLabel: (name: string) => `Edit ${name}`,
  remove: 'Remove',
  removeLabel: (name: string) => `Remove ${name}`,

  /** The confirm names its consequence, and never repeats the word that
   * opened it (ProfileScreen.tsx:761-763). */
  removeQuestion: (name: string) => `Remove “${name}” from the vault?`,
  removeBody:
    'It goes from both devices, and the value is cleared from this one. The notice in the room stays until it is removed there or the timer takes it.',
  removeConfirm: 'Remove from both devices',

  /* ── contested ───────── */
  contested: 'You both changed this',
  contestedBody:
    'Neither device had seen the other’s change, so both values are still here. Nothing was thrown away.',
  contestedChoose:
    'Keep one. It replaces the other on both devices, and the one you do not keep is cleared.',
  yours: 'Your value',
  theirs: (who: string) => `${who}’s value`,
  keep: 'Keep this one',

  /**
   * The contested row's spoken labels, and why they are not `showLabel`.
   *
   * Passing "Your value" into `showLabel` produced "Show the value of Your
   * value" — and, worse, the same four labels on every contested item in the
   * Room, so VoiceOver could not tell one disagreement from another. These take
   * the side AND the item, in a form that reads inside a sentence: "Show your
   * value for Wi-Fi".
   */
  yoursSpoken: 'your value',
  theirsSpoken: (who: string) => `${who}’s value`,
  showSlotLabel: (whose: string, name: string) => `Show ${whose} for ${name}`,
  hideSlotLabel: (whose: string, name: string) => `Hide ${whose} for ${name}`,
  keepLabel: (whose: string, name: string) => `Keep ${whose} for ${name}`,

  /* ── a write that never reached them ─── */
  unsent: 'Not on their device',
  unsentBody:
    'This is saved here, but the change never reached them — they still have whatever they had before. Sending again repairs it.',
  retry: 'Send again',
  retryLabel: (name: string) => `Send ${name} again`,
  /**
   * WHY A CONTESTED ITEM IS NOT OFFERED "Send again". The stored value of a
   * contested item is the collapse's deterministic winner, which is a value
   * NOBODY was shown — re-sending it would publish it to both devices and let
   * the loser's copy be blanked, which is the silent coin flip the panel above
   * exists to prevent. Keeping one of the two IS a write, so it repairs the
   * delivery and the disagreement in the same frame.
   */
  unsentContested:
    'Keeping one of the two values above is what reaches their device.',

  /* ── a REMOVAL that never reached them ─────────────────── */
  /**
   * The item is gone from this device, so there is no row to hang this on and
   * no name left to put in it — a tombstone keeps the counter and drops the
   * title with the value. What is left to say is the part that matters:
   * "Remove from both devices" did not do both.
   */
  removeUnsent: 'A removal never reached them',
  removeUnsentBody:
    'You removed an item here, but the change never reached their device, so their copy is still there. Sending again removes it on both.',
  retryRemoval: 'Remove there too',

  /* ── failures ─────────────────────────────────────────── */
  failed: 'Tacendum couldn’t save that. Try again.',
  removeFailed: 'Tacendum couldn’t remove that. Try again.',
  blocked:
    'You blocked this person, so nothing is sent from this room. The vault stays as it is until you unblock.',
  /**
   * The one failure that is not the app's fault and not a retry. The send path
   * throws this rather than swallowing it (messaging.ts:1147-1149) precisely
   * because a vault write is the last thing that should go quietly to a key
   * nobody has checked, so the sentence points at the section that can fix it —
   * which on this screen is directly above.
   */
  safetyChanged:
    'Their safety number changed. Check it under Safety number above and accept the change before saving anything here.',

  /* ── disclosure ───────────────────────────────────────── */
  explainToggle: 'What this is',
} as const;

/**
 * TIER ONE — the consequence, always visible, above the controls
 * (RegisterScreen's consent card states its consequence above the button it
 * arms the same way). Two sentences only: what keeping a thing here
 * costs, and what leaves the app when Copy is tapped. Neither is optional
 * reading, so neither goes behind the toggle.
 */
export const VAULT_CONSEQUENCE: string[] = [
  'Anything here is kept until one of you removes it — including when messages in this room disappear on a timer.',
  // Each platform's sentence names its
  // own clipboard and its own leak path — iOS has Universal Clipboard across
  // an iCloud account; Android has no cross-device pasteboard of its own, but
  // the keyboard and the pasted-into app read it, and some devices sync it.
  // A substance branch, so Platform stays; the noun rides the token.
  Platform.OS === 'android'
    ? 'Copy puts the value on the clipboard, where the keyboard and the app you paste into can read it — and some devices sync the clipboard to your other devices. Tacendum clears it a minute later.'
    : `Copy puts the value on the ${DEVICE_NOUN} pasteboard, where every app on this ${DEVICE_NOUN} and every device signed in to the same iCloud account can read it. Tacendum clears it a minute later.`,
];

/**
 * TIER TWO — "what this is", behind the QrPanel affordance
 * (RegisterScreen's "How this works" toggle is the same idiom). The
 * design verbatim in substance: the
 * temptation to oversell a vault is exactly where a privacy product loses
 * trust, so the limits are written plainly and the word "secure" appears
 * nowhere.
 *
 * The last line is V3's answer to the fourth thing V1 deferred. The
 * announcement row in the chat IS the envelope, credential included — it is
 * the vault's write-ahead log and the only durable second copy once the ack
 * has destroyed the server's, so blanking it would trade a crash-recovery path
 * for a partial cleanup. The decision is to keep the row and say so.
 */
export const VAULT_LIMITS: string[] = [
  `An item is stored and sent exactly like a message: same encryption, same database, same lock on this ${DEVICE_NOUN}. The vault adds organisation and the mask on this screen — not a stronger lock.`,
  `It is not a password manager. Nothing fills in for you, nothing watches for breaches, and there is no separate password. If this ${DEVICE_NOUN} is lost the vault goes with it; there is no recovery key.`,
  'Anything either of you can read, either of you can keep. They can copy a value out, write it down, or photograph the screen, and nothing here can reach it afterwards.',
  'Saving or removing an item also leaves a short notice in the room. That notice still carries the value inside it until it is removed there or a disappearing-message timer takes it.',
  // The check-before-clear is the same on both platforms; what differs is the
  // system's own behaviour around the read. iOS can ASK and be refused;
  // Android never asks — it silently withholds another app's clipboard from a
  // background read (the fail-closed path pasteboard.ts already takes) and
  // may show its own "read the clipboard" notice.
  Platform.OS === 'android'
    ? 'Clearing the clipboard checks what is on it first, so it never wipes something you copied in the meantime. If you copied something else since, that check cannot see it and nothing is cleared: the newer value stays where you put it.'
    : 'Clearing the pasteboard checks what is on it first, so it never wipes something you copied in the meantime. That check is a read, so iOS may ask “Tacendum wants to paste” about a minute after a Copy — that prompt is this. Say no and nothing is cleared: the value stays on the pasteboard until something else replaces it.',
];

/**
 * How a refusal from the send path is worded, per field and per reason.
 *
 * `VaultItemRefusedError` already carries `field`, `reason` and `limit` and
 * never carries the value (messaging.ts:170-184). This turns those three into
 * the sentence, so the screen renders the refusal against the box it names
 * instead of putting one shrug under both. The caps are NOT re-implemented
 * here: the send path is the only thing that decides, and this only reads its
 * answer.
 */
export function vaultRefusal(
  field: 'title' | 'body',
  reason: 'empty' | 'too-long' | 'envelope',
  limit: number,
): string {
  if (reason === 'empty') {
    return field === 'title'
      ? 'Give it a name, so you can find it again.'
      : 'There is nothing to save yet.';
  }
  if (reason === 'envelope') {
    return field === 'title'
      ? 'A name can’t start with {"tcm": — Tacendum reads that as message structure, not text.'
      : 'A value can’t start with {"tcm": — Tacendum reads that as message structure, not text.';
  }
  return field === 'title'
    ? `That name is too long. The limit is ${limit} characters.`
    : `That value is too long. The limit is ${limit} characters — room for an SSH key, but not for a file.`;
}
