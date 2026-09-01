import { getSecret, setSecret } from 'tacendum-crypto';

/**
 * Whether this device may hold a push-token row on the server.
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT THE NOTIFICATION SETTING. iOS issues a
 * PushKit token without asking anyone. It is independent of the notification
 * prompt, the app registers for it at launch, and it is uploaded with
 * whatever else exists — so a person who DECLINED notifications still had a
 * VoIP token on our server, tied to their account id, and no way to take it
 * back short of deleting the account. The published privacy policy admitted
 * exactly that. App Store guideline 5.1.1(ii) asks for consent to collection
 * and an understandable way to withdraw it; this is the withdrawal.
 *
 * **Defaults ON**, and that is a deliberate choice rather than an oversight:
 * the token is what makes a locked phone ring, so defaulting off would break
 * calls for everyone in order to serve the minority who want no token at all.
 * The disclosure sits in Settings beside the switch, which is where a person
 * who cares will look, and the policy page carries it for everyone else.
 *
 * Stored in the Keychain, like `readReceipts` and the screen-security
 * setting, for the same two reasons: it must survive a workspace wipe, and it
 * must not live in the decoy database where a duress session could see — or
 * change — it.
 */

const KEY = 'tacendum.pushTokens';

let allowed = true;

/**
 * Synchronous, because `uploadPushTokens` consults it on a path that must not
 * await a Keychain read before deciding to do nothing.
 */
export function pushTokensAllowed(): boolean {
  return allowed;
}

/**
 * Re-read the persisted choice. Called at init and on every REAL unlock, so a
 * duress session's value can never bleed into a real one.
 *
 * A failed read fails to the DEFAULT (allowed) rather than to off. The
 * alternative — a Keychain hiccup silently stopping calls from ringing a
 * locked phone — is a worse failure than the one it would be guarding
 * against, and it would be invisible: the whole push path swallows its own
 * errors by design.
 */
export async function loadPushConsent(): Promise<void> {
  try {
    allowed = (await getSecret(KEY)) !== '0';
  } catch {
    allowed = true;
  }
}

/**
 * Record the choice. Writing only — the caller is responsible for the
 * server-side delete and for stopping any armed retry, because those can fail
 * independently and the UI needs to report on them separately.
 */
export async function setPushTokensAllowed(on: boolean): Promise<void> {
  allowed = on;
  await setSecret(KEY, on ? '1' : '0');
}
