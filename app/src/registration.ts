import {
  deleteSecret,
  existingKeysForUpload,
  generateAndStoreKeys,
  getSecret,
  hasIdentity,
  resetProtocolState,
  setSecret,
  signAuthChallenge,
} from 'tacendum-crypto';
import {
  apiAuth,
  apiAuthChallenge,
  apiDeleteAccount,
  apiUploadKeys,
} from './api';
import {
  disposeGroupCall,
  endCallOnQuiesce,
  quiesceCallMetrics,
} from './call';
import * as db from './db';
import * as lock from './lock';
import { AUTH_TOKEN_KEY, messaging, resumeReauth, suspendReauth } from './messaging';
import { session } from './session';
import { API_BASE } from './config';

/**
 * Account lifecycle: keygen (native, PQXDH set) →
 * challenge → sign → POST /v1/auth → PUT /v1/keys → persist profile.
 *
 * There is no phone number anywhere in this file any more, and no verification
 * code: the identity keypair IS the account. `requestCode` and
 * `completeRegistration` are gone with the routes they called.
 */

/**
 * Delete the account: retire it server-side, then leave nothing behind on
 * this device. There is no sign-out — chats exist only here, so "sign out
 * and come back later" was a promise the architecture cannot keep; deletion
 * is the only honest exit.
 *
 * Order matters twice over. Server FIRST: the local wipe runs only once the
 * ID has actually stopped working — offline, this throws and destroys
 * nothing. Then stop the socket so nothing writes during the wipe, clear
 * local state, and only then the identity keys and token.
 */
export async function deleteAccount(): Promise<void> {
  if (session.mode === 'duress') {
    // A coerced "delete it all": the decoy dies
    // convincingly, nothing real is touched, and no packet leaves the phone.
    // No 1:1 call can be live here — the transport refuses every duress
    // frame, so an attempt tears itself down — but the quiesce rule is
    // one rule (endCallOnQuiesce beside every messaging.stop), and a no-op
    // costs nothing.
    await endCallOnQuiesce();
    messaging.stop();
    disposeGroupCall();
    quiesceCallMetrics();
    await db.clearLocalState();
    return;
  }
  // Before the bearer dies, not after. `DELETE /v1/account` revokes it, and any
  // authenticated request already in flight will 401 a moment later — which the
  // REST seam would faithfully "heal" by minting a new session, and `POST
  // /v1/auth` CREATES an account for a known identity key whose user row is
  // gone. The user would be left on the onboarding screen under a no-exit "this
  // account no longer exists" sheet, with an orphan account on the server that
  // nothing on this device can reach. Deletion is the one moment when a 401 is
  // the intended outcome.
  suspendReauth();
  const token = await getSecret(AUTH_TOKEN_KEY);
  if (token) await apiDeleteAccount(token);
  // AFTER the server delete — a deletion that throws offline must leave the
  // call untouched — and BEFORE the socket stops, so the peer's `call.end`
  // is composed while the transport still accepts it and the CXCall does not
  // outlive the account it belonged to (see endCallOnQuiesce).
  await endCallOnQuiesce();
  messaging.stop();
  // Beside the socket, not after the wipe: a live small-group session holds
  // N leg services, a roster and armed timers in MEMORY, none of which
  // `clearLocalState` can reach — and the account they belong to is about to
  // stop existing.
  disposeGroupCall();
  quiesceCallMetrics();
  await db.clearLocalState();
  await resetProtocolState();
  await deleteSecret(AUTH_TOKEN_KEY);
  await lock.clearAll();
  await db.clearDecoyState();
}

/** A duress session is network-silent. A coerced
 * sign-up attempt from the decoy's landing screen must neither reach the
 * server nor overwrite the real auth token — surface it as being offline,
 * which is the plausible truth of a session that never opened a socket. */
function refuseInDuress(): void {
  if (session.mode === 'duress') {
    throw new Error('You appear to be offline. Try again in a bit.');
  }
}

/**
 * Create the account, or sign this device back in.
 *
 * There is no phone number and no code. The libsignal identity keypair IS the
 * account: generate it, ask the server for a nonce, sign the nonce, and the
 * signature proves ownership. One tap, no carrier, nothing to type.
 *
 * ORDER IS INVERTED FROM THE PHONE FLOW, and the inversion is the whole point:
 * keys used to be generated AFTER a session existed, because the session came
 * from an SMS code. Now the keys come first, because they are what the session
 * is issued against.
 *
 * Three things this function must never do, each of which loses an account:
 *  - **Never regenerate an identity that already exists.** A fresh keypair is
 *    a different account; every peer's safety number breaks and the old
 *    account becomes unreachable. `generateAndStoreKeys` is only called when
 *    there is no identity at all (and natively it refuses to overwrite one).
 *  - **Never touch the network in duress mode.** `refuseInDuress` runs FIRST,
 *    ahead of keygen as well as the request — because
 *    generating a keypair under coercion would also be a visible side effect.
 *  - **Never reset a protocol state that has a profile behind it.** The wipe
 *    below is strictly the keys-without-profile case.
 */
/**
 * The identity key on this device is gone and the profile it belonged to is
 * still here. There is nothing to retry: the key cannot be regenerated, the
 * server's claim row binds the account to it forever, and any way of
 * restoring one would be a way of being handed someone's account by asking
 * convincingly enough. This is a TERMINAL state, and throwing it — instead of
 * quietly minting a fresh keypair and rebinding the profile — is the fix for
 * the worst thing the old code did: a backup restore to a new phone (SQLite
 * is backed up, the protocol store is deliberately not) presented every old
 * chat intact under a brand-new account, while every peer still pinned the
 * dead key and the messages went nowhere.
 */
export class IdentityLostError extends Error {
  constructor() {
    super('identity_lost');
    this.name = 'IdentityLostError';
  }
}

/**
 * The identity on disk resolves to a different account than the profile
 * claims. Same terminal posture as IdentityLostError, and thrown BEFORE the
 * token or profile is written: silently rebinding the profile to whichever
 * account the key answers for is how two mismatched halves become one wrong
 * whole.
 */
export class AccountMismatchError extends Error {
  constructor() {
    super('account_mismatch');
    this.name = 'AccountMismatchError';
  }
}

export async function createOrRestoreAccount(): Promise<db.ProfileRow> {
  refuseInDuress();
  // An account is about to exist again, so the deletion-time suspension is
  // over. Clearing it HERE rather than at the end of `deleteAccount` is
  // deliberate: the window that must stay closed is the whole gap between the
  // delete and the next registration, including a process that is killed in
  // between and relaunched into onboarding.
  resumeReauth();

  const existingProfile = await db.loadProfile();
  const identityExists = await hasIdentity();

  // A profile with no identity behind it is a dead account, and saying so is
  // the only honest answer. Guarded FIRST, before anything can be minted or
  // written: the old behaviour here generated a fresh keypair and silently
  // overwrote the profile's userId, which severed every contact while showing
  // all the old chats intact.
  if (!identityExists && existingProfile !== null) {
    throw new IdentityLostError();
  }

  // THE RESET BRANCH THAT USED TO LIVE HERE IS GONE, and with it the one
  // place the app destroyed an identity. It existed because of a claim that
  // turned out to be false — "the upload payload cannot be reconstructed from
  // the store". The CLI has reconstructed it since keypair accounts shipped
  // (`existingKeysForUpload`), every stored record carries its public half
  // and signature, and the native port below does the same. So an identity
  // with no profile is not a dead end to be wiped: authenticate it — the
  // server answers a known key with its existing userId and an unknown one
  // with a fresh account — re-upload its keys, and rebuild the profile.
  //
  // That matters because this state stopped being "strictly the
  // never-finished first install" the day the protocol store moved to the App
  // Group container: SQLite and the keystore now have different deletion and
  // backup lifecycles, and a reinstall can legitimately land here holding a
  // live, fully-registered, recoverable identity.
  const keys = identityExists
    ? await existingKeysForUpload()
    : await generateAndStoreKeys();

  const { challenge } = await apiAuthChallenge(keys.identityKey);
  // The private key never leaves the Keychain; only the signature comes back.
  const signature = await signAuthChallenge(challenge, API_BASE);
  const { userId, authToken } = await apiAuth(keys.identityKey, challenge, signature);

  // Before the token write, before the upload, before the profile: nothing
  // may be mutated on the strength of an identity that answers for a
  // different account than the one on disk.
  if (existingProfile !== null && existingProfile.userId !== userId) {
    throw new AccountMismatchError();
  }

  // ALWAYS uploaded, minted or not, and BEFORE the token is persisted. PUT
  // /v1/keys is an upsert conditioned on the same identity key, so for a
  // fully-provisioned account this is a no-op-shaped refresh — and for the
  // crash window where auth succeeded but the upload never ran, it is the
  // difference between an account peers can reach and one whose bundle 404s
  // forever. Nothing is rotated: consumed one-time prekeys are gone with
  // their private halves and only the survivors are re-advertised, so no
  // queued ciphertext is stranded.
  //
  // The ordering is the durability argument. Fail here and nothing local has
  // changed, so the next attempt redoes everything; write the token first and
  // a failed upload would leave a device that authenticates perfectly and
  // never repairs its bundle — the boot heal keys off a MISSING token, so
  // nothing would ever run this again. The reverse crash (upload lands,
  // token write dies) re-uploads idempotently on the retry.
  await apiUploadKeys(authToken, keys);
  await setSecret(AUTH_TOKEN_KEY, authToken);

  const profile: db.ProfileRow =
    existingProfile !== null
      ? { ...existingProfile, userId }
      : {
          userId,
          // The real value from the store, minted or rebuilt — never 0. The
          // registrationId rides inside every session this device builds, and
          // a profile that lies about it survives until something compares.
          registrationId: keys.registrationId,
          // A new account has no card yet; version 0 means "nothing to share".
          displayName: '',
          about: '',
          avatarB64: '',
          profileVersion: 0,
        };
  await db.saveProfile(profile);
  return profile;
}
