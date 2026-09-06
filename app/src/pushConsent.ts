import { getSecret, setSecret } from 'tacendum-crypto';
import { session } from './session';

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
 * What a DURESS session shows and toggles — the `messageSound.ts` shape, for
 * the same reason and with more at stake.
 *
 * Never written to the Keychain: the owner's stored choice must survive a
 * coerced session untouched, and the decoy must still appear to work (rule
 * 16), so a coerced tap moves this shadow and nothing else. A duress session
 * therefore reads the DEFAULT rather than the owner's value — which is the
 * point, because the row's own note says what Off deletes, and a decoy
 * showing Off would say the owner had already withdrawn.
 *
 * The real value is kept in `allowed` beside it rather than being overwritten
 * on duress entry: nothing in a coerced session may reach the network anyway
 * (`api.ts` refuses, and the registration verdict is `real: false`), so the
 * safest thing for the real path to hold is the truth.
 */
let duressChoice = true;

/**
 * Synchronous, because `uploadPushTokens` consults it on a path that must not
 * await a Keychain read before deciding to do nothing.
 */
export function pushTokensAllowed(): boolean {
  return session.mode === 'duress' ? duressChoice : allowed;
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
  // A duress session never touches the Keychain — not to read it either, the
  // `loadMessageSound` line (messageSound.ts:126-131). The decoy stands on its
  // own shadow (rule 16: a coercer's Off must still read Off when they come
  // back to the row) and only a REAL load may reset it. App.tsx's real unlock
  // arm is the one caller today; `loadMessageSound` grew this same line when a
  // second caller appeared, which is the mistake this is here to not repeat.
  if (session.mode === 'duress') return;
  try {
    allowed = (await getSecret(KEY)) !== '0';
  } catch {
    allowed = true;
  }
  // A real session opening resets the decoy's shadow, so the next coerced
  // session starts from the default rather than from the last coercer's taps
  // (`loadMessageSound`'s rule). This function is called only on the REAL
  // unlock arm (App.tsx:983), so it is the honest place for it.
  duressChoice = true;
}

/**
 * Record the choice. Writing only — the caller is responsible for the
 * server-side delete and for stopping any armed retry, because those can fail
 * independently and the UI needs to report on them separately.
 *
 * A COERCED TAP MOVES THE SHADOW AND STOPS THERE. The Keychain write below is
 * what makes a locked phone stop ringing, and the owner would have no reason
 * to look at the row again — so a session opened with the reversed code must
 * not be able to reach it. The value still moves in memory, because the chip
 * must follow the tap exactly as it does in a real session (rule 16).
 */
export async function setPushTokensAllowed(on: boolean): Promise<void> {
  if (session.mode === 'duress') {
    duressChoice = on;
    return;
  }
  allowed = on;
  await setSecret(KEY, on ? '1' : '0');
}

/**
 * Entering a duress session shows the DEFAULT, never the owner's real choice
 * — the `resetReadReceiptsForDuress` family, called from App.tsx's duress
 * arm beside the rest of them.
 *
 * It matters here more than in its siblings: without it the decoy shows
 * whatever the owner had chosen, and an Off in that row is a fact about the
 * owner's phone that a coercer can read straight off the screen.
 */
export function resetPushConsentForDuress(): void {
  duressChoice = true;
}
