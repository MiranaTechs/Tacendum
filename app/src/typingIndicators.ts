import { getSecret, setSecret } from 'tacendum-crypto';

/**
 * Whether this device tells people you are typing to them.
 *
 * Typing state reports on a PERSON at finer time resolution than anything
 * else this app emits: it says someone is holding their phone, in one
 * specific conversation, composing, right now. Read receipts' reasoning
 * (readReceipts.ts) applies with more force, so it gets the same switch.
 *
 * **Defaults ON.** It is what people expect a messenger to do, and an
 * indicator that silently never appears reads as a broken app rather than
 * a private one. The toggle is the escape hatch, not the default posture.
 *
 * Stored in the Keychain rather than SQLite, like read receipts: it must
 * survive a workspace wipe and must not live in the decoy database.
 */

const KEY = 'tacendum.typingIndicators';

let enabled = true;

/** Synchronous, because it is consulted on the send path. */
export function typingIndicatorsEnabled(): boolean {
  return enabled;
}

/**
 * Re-read the persisted choice. Called at init and on every REAL unlock, so
 * a duress-session value can never bleed into a real one.
 *
 * A failed read fails to the DEFAULT rather than to off: a Keychain hiccup
 * must not silently change what the other side has learned to expect.
 */
export async function loadTypingIndicators(): Promise<void> {
  try {
    enabled = (await getSecret(KEY)) !== '0';
  } catch {
    enabled = true;
  }
}

export async function setTypingIndicators(on: boolean): Promise<void> {
  enabled = on;
  await setSecret(KEY, on ? '1' : '0');
}

/**
 * A duress session shows the DEFAULT, not the owner's real choice — same
 * rule as read receipts. Nothing is sent from a decoy session regardless
 * (sendTypingState refuses on `session.mode`); this is only about what the
 * settings screen displays.
 */
export function resetTypingIndicatorsForDuress(): void {
  enabled = true;
}
