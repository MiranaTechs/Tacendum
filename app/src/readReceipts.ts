import { getSecret, setSecret } from 'tacendum-crypto';
import { session } from './session';

/**
 * Whether this device tells people their messages have been read.
 *
 * The other two statuses are observations the server makes anyway: it routed
 * the bytes, so it knows a message was sent and delivered. "Read" is different
 * in kind — it reports on a PERSON. It says someone picked up their phone,
 * opened this conversation, and looked. That is worth being able to switch
 * off, and every messenger that treats privacy seriously lets you.
 *
 * **Defaults ON.** The feature is what people expect from the tick they can
 * already see, and a status that silently never arrives is its own confusion.
 * The toggle is the escape hatch, not the default posture.
 *
 * Stored in the Keychain rather than SQLite, like the screen-security setting:
 * it must survive a workspace wipe and must not live in the decoy database.
 */

const KEY = 'tacendum.readReceipts';

let enabled = true;

/** Synchronous, because it is consulted on the send path. */
export function readReceiptsEnabled(): boolean {
  return enabled;
}

/**
 * Re-read the persisted choice. Called at init and on every REAL unlock, so a
 * duress-session value can never bleed into a real one.
 *
 * A failed read fails to the DEFAULT rather than to off: a Keychain hiccup
 * should not silently stop a status the other side is waiting for.
 */
export async function loadReadReceipts(): Promise<void> {
  try {
    enabled = (await getSecret(KEY)) !== '0';
  } catch {
    enabled = true;
  }
}

/**
 * A COERCED TAP MOVES THE ROW AND WRITES NOTHING. The reading half of rule 16
 * was already here — `resetReadReceiptsForDuress` shows the default when the
 * decoy opens — and the writing half was not: a tap in a coerced session
 * durably changed the owner's real preference, and the owner had no way to
 * learn it had moved. The in-memory value still follows the tap, because a
 * chip that refused to move would be its own tell, and it is safe to let it:
 * App.tsx re-reads this on every REAL unlock, so the move lives exactly as
 * long as the session that made it.
 */
export async function setReadReceipts(on: boolean): Promise<void> {
  enabled = on;
  if (session.mode === 'duress') return;
  await setSecret(KEY, on ? '1' : '0');
}

/**
 * A duress session shows the DEFAULT, not the owner's real choice.
 *
 * Same rule as screen security: the real preference is real state and stays
 * sealed. Nothing is sent from a decoy session regardless — `sendReadReceipt`
 * refuses on `session.mode` before it reaches this — so this is only about
 * what the settings screen displays.
 */
export function resetReadReceiptsForDuress(): void {
  enabled = true;
}
