import {
  deleteSecret,
  existingKeysForUpload,
  generateAndStoreKeys,
  getSecret,
  hasIdentity,
  identityPublicKey,
  resetProtocolState,
  setSecret,
  signAuthChallenge,
} from 'tacendum-crypto';
import { LOW_PREKEY_THRESHOLD } from '@tacendum/shared';
import {
  apiAuth,
  apiAuthChallenge,
  apiDeleteAccount,
  apiUploadKeys,
} from './api';
import {
  bindCallingAccount,
  clearCallingAccount,
  disposeGroupCall,
  endCallOnQuiesce,
  quiesceCallMetrics,
} from './call';
import * as db from './db';
import * as lock from './lock';
import { AUTH_TOKEN_KEY, messaging, resumeReauth, suspendReauth } from './messaging';
import { session } from './session';
import { API_BASE } from './config';
import { clearWritingConnections, invalidateWritingSession } from './aiWritingService';
import { accountGone, reportAccountGone, resetAccountReauth } from './reauth';

/**
 * Account lifecycle: keygen (native, PQXDH set) →
 * challenge → sign → POST /v1/auth → PUT /v1/keys → persist profile.
 *
 * There is no phone number anywhere in this file any more, and no verification
 * code: the identity keypair IS the account. `requestCode` and
 * `completeRegistration` are gone with the routes they called.
 */

/** Durable across crashes and iOS reinstalls; never cleared by install healing. */
export const ACCOUNT_DELETION_KEY = 'accountDeletion';
type DeletionRecord = { phase: 'requested' | 'confirmed' | 'local-only'; userId: string | null };

export class AccountCleanupPendingError extends Error {
  constructor() {
    super('account_cleanup_pending');
    this.name = 'AccountCleanupPendingError';
  }
}

async function deletionRecord(): Promise<DeletionRecord | null> {
  const value = await getSecret(ACCOUNT_DELETION_KEY);
  if (value === null) return null;
  const record: unknown = JSON.parse(value);
  if (typeof record !== 'object' || record === null ||
      !('phase' in record) || !['requested', 'confirmed', 'local-only'].includes(String(record.phase)) ||
      !('userId' in record) || (record.userId !== null && typeof record.userId !== 'string')) {
    throw new AccountCleanupPendingError();
  }
  return record as DeletionRecord;
}

export async function hasPendingAccountDeletion(): Promise<boolean> {
  return (await getSecret(ACCOUNT_DELETION_KEY)) !== null;
}

function authFailure(error: unknown, status: number, code?: string): boolean {
  const e = error as { name?: string; status?: number; code?: string } | null;
  return e?.name === 'ApiRequestError' && e.status === status &&
    (code === undefined || e.code === code);
}

/** Renewal for an explicit deletion only, with get-or-create disabled server-side. */
async function deletionToken(userId: string | null): Promise<string> {
  if (!userId) throw new Error('account_deletion_auth_required');
  refuseInDuress();
  const identityKey = await identityPublicKey();
  if (!identityKey) throw new IdentityLostError();
  refuseInDuress();
  const { challenge } = await apiAuthChallenge(identityKey);
  refuseInDuress();
  const signature = await signAuthChallenge(challenge, API_BASE);
  refuseInDuress();
  let response;
  try {
    response = await apiAuth(identityKey, challenge, signature, userId);
  } catch (error) {
    refuseInDuress();
    // These uniform refusals also cover a mismatched LIVE account or a revoked
    // key. They prove only that this identity cannot renew, never that DELETE
    // succeeded. Keep the bearer/intent until an explicit local fresh start.
    if (authFailure(error, 409, 'account_gone') ||
        authFailure(error, 409, 'account_conflict') ||
        authFailure(error, 403, 'identity_tombstoned')) reportAccountGone();
    throw error;
  }
  refuseInDuress();
  if (response.userId !== userId) throw new AccountMismatchError();
  await setSecret(AUTH_TOKEN_KEY, response.authToken);
  return response.authToken;
}

/**
 * Erase only after remote deletion is confirmed. Each independent operation
 * runs even if another fails; a failed essential wipe retains the marker and
 * blocks setup until a later retry finishes it. Installation preferences
 * (screen sharing and update policy) deliberately survive.
 */
async function finishAccountDeletion(): Promise<void> {
  invalidateWritingSession();
  await endCallOnQuiesce().catch(() => undefined);
  messaging.stop();
  disposeGroupCall();
  quiesceCallMetrics();
  // A reused PushKit/FCM token must no longer belong to the retiring account.
  // Failure retains the confirmed deletion marker and blocks fresh setup.
  refuseInDuress();
  await clearCallingAccount();
  let incomplete = false;
  for (const clear of [
    () => db.clearLocalState(),
    () => resetProtocolState(),
    () => deleteSecret(AUTH_TOKEN_KEY),
    () => deleteSecret(PREKEY_REPLENISHED_AT_KEY),
    () => deleteSecret('recovery.request'),
  ]) {
    try { refuseInDuress(); await clear(); } catch { incomplete = true; }
  }
  // Provider cleanup reports refused writes as a value. Owner binding makes
  // that residue unusable by a future identity; preserve the existing
  // best-effort contract independently of the essential identity/data wipes.
  refuseInDuress();
  try { await clearWritingConnections(); } catch { /* owner-bound residue */ }
  // The existing AD-1 contract: refused lock/decoy residues are inert and
  // must not be reported as a server failure after an account was deleted.
  refuseInDuress();
  await lock.clearAll().catch(() => undefined);
  refuseInDuress();
  await db.clearDecoyState().catch(() => undefined);
  if (incomplete) throw new AccountCleanupPendingError();
  try { await deleteSecret(ACCOUNT_DELETION_KEY); }
  catch { throw new AccountCleanupPendingError(); }
  resetAccountReauth();
}

/** A surviving Keychain bearer cannot restore a deleted protocol identity. */
export async function clearStaleInstallationCredentials(): Promise<boolean> {
  const identityPresent = await hasIdentity();
  if (identityPresent || await hasPendingAccountDeletion()) return identityPresent;
  await deleteSecret(AUTH_TOKEN_KEY);
  await deleteSecret(PREKEY_REPLENISHED_AT_KEY);
  await deleteSecret('recovery.request');
  return false;
}

let deletionFlight: Promise<void> | null = null;

/** Server first, durable intent before the first destructive request. */
export function deleteAccount(): Promise<void> {
  if (session.mode === 'duress') return deleteDecoyAccount();
  if (deletionFlight) return deletionFlight;
  const task = deleteRealAccount();
  deletionFlight = task;
  const settled = () => { if (deletionFlight === task) deletionFlight = null; };
  void task.then(settled, settled);
  return task;
}

async function deleteDecoyAccount(): Promise<void> {
  invalidateWritingSession();
  await endCallOnQuiesce();
  messaging.stop();
  disposeGroupCall();
  quiesceCallMetrics();
  await db.clearLocalState();
}

async function deleteRealAccount(): Promise<void> {
  // Await the renewal already in flight BEFORE reading its final bearer.
  await suspendReauth();
  let confirmed = false;
  try {
    refuseInDuress();
    let record = await deletionRecord();
    if (!record) {
      record = { phase: 'requested', userId: (await db.loadProfile())?.userId ?? null };
      await setSecret(ACCOUNT_DELETION_KEY, JSON.stringify(record));
    }
    confirmed = record.phase !== 'requested';
    if (!confirmed) {
      let token = await getSecret(AUTH_TOKEN_KEY);
      if (!token) token = await deletionToken(record.userId);
      try {
        refuseInDuress();
        await apiDeleteAccount(token);
      } catch (error) {
        if (!authFailure(error, 401)) throw error;
        token = await deletionToken(record.userId);
        refuseInDuress();
        await apiDeleteAccount(token);
      }
      confirmed = true;
      // If this write fails, the pre-request intent still records the ID and
      // a retry may finish deletion. Do not wipe its proof prematurely.
      refuseInDuress();
      await setSecret(ACCOUNT_DELETION_KEY, JSON.stringify({ ...record, phase: 'confirmed' }));
    }
    refuseInDuress();
    await finishAccountDeletion();
  } catch (error) {
    if (!confirmed) resumeReauth();
    // A transport failure does not establish whether DELETE reached the
    // server. The caller says it could not confirm deletion, never "nothing
    // was deleted". No local wipe runs without the affirmative proof above.
    if (confirmed) throw new AccountCleanupPendingError();
    throw error;
  }
}

/** An explicit local fresh start for an unusable identity, after unlock. */
export async function clearGoneAccount(): Promise<void> {
  refuseInDuress();
  const gone = accountGone();
  // Also offers a way out after reinstall removed the identity files but a
  // deletion intent survived in Keychain. The UI explicitly says the remote
  // deletion is unconfirmed before consenting to abandon that local proof.
  if (!gone && await hasIdentity()) throw new Error('account_not_gone');
  await suspendReauth();
  refuseInDuress();
  await setSecret(ACCOUNT_DELETION_KEY, JSON.stringify({
    phase: 'local-only', userId: null,
  }));
  await finishAccountDeletion();
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
 *  - **Never silently rebind an existing profile.** An explicit deletion or
 *    confirmed local fresh start must finish before a new identity is made.
 */
/**
 * The identity key on this device is gone and the profile it belonged to is
 * still here. There is nothing to retry: the key cannot be regenerated, the
 * server's claim row binds the account to it forever, and any way of
 * restoring one would be a way of being handed someone's account by asking
 * convincingly enough. This is a TERMINAL state, and throwing it — instead of
 * quietly minting a fresh keypair and rebinding the profile — is the fix for
 * the worst thing the old code did: a stale database restored to a new phone without its protocol store presented every old
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

/* ── ONE-TIME PREKEY REPLENISHMENT ──────────── */

/** Keychain key under which the last successful replenishment is stamped
 * (epoch ms as a decimal string). A preference, not a secret; it lives
 * beside the other preferences the Keychain keeps. */
export const PREKEY_REPLENISHED_AT_KEY = 'prekeyReplenishedAt';
/** The scheduled cadence: one fresh batch a day. */
export const PREKEY_REPLENISH_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** The floor between two uploads whatever the reason — the server budgets
 * `PUT /v1/keys` at 5 burst / 10 per hour per account, and a client that
 * answers every low-pool signal with an upload would spend it on itself.
 * One per hour from the signal path is ample: a batch is 100 keys against
 * a drain floor of 30 fetches a day per target. */
export const PREKEY_REPLENISH_MIN_GAP_MS = 60 * 60 * 1000;
/** Re-exported so the trigger and the test read one number. */
export { LOW_PREKEY_THRESHOLD };

/**
 * Mint a FRESH batch of one-time prekeys and re-advertise the pool.
 *
 * The pool used to be uploaded exactly once, at `register()`. Every inbound
 * session bootstrap consumes one server-side (the per-target drain floor is
 * 30 fetches a day, so any ULID-holder could empty it in days), and once it
 * was empty every new session to this device was signed-prekey-only, for
 * the life of the install — initial-message forward secrecy degraded to
 * the long-lived signed prekey. `lowPrekeyCount` existed on the bundle DTO
 * with no consumer.
 *
 * `existingKeysForUpload` is the mint (native, both platforms): fresh
 * one-time prekeys at ids the store has never used, old private halves KEPT
 * so ciphertext already built against them still decrypts, and the signed
 * and kyber prekeys re-advertised from their stored records. PUT /v1/keys
 * replaces the server's pool wholesale with keys nobody has been handed.
 * Signed-prekey rotation is a follow-up; nothing here rotates it.
 *
 * `reason` is `'schedule'` (the daily pass from messaging.start) or `'low'`
 * (a served bundle for THIS device said the pool is under
 * LOW_PREKEY_THRESHOLD); the second waits only the hourly floor. Returns
 * whether an upload happened; a failed upload throws and leaves the stamp
 * untouched, so the next start asks again. Never runs in duress (a duress
 * session is network-silent) and never without an
 * identity (there is nothing to mint from).
 */
export async function replenishPrekeys(
  token: string,
  opts: { reason?: 'schedule' | 'low'; now?: number } = {},
): Promise<'uploaded' | 'skipped'> {
  if (session.mode === 'duress') return 'skipped';
  if (!(await hasIdentity())) return 'skipped';
  const now = opts.now ?? Date.now();
  const last = Number(await getSecret(PREKEY_REPLENISHED_AT_KEY)) || 0;
  const gap =
    opts.reason === 'low' ? PREKEY_REPLENISH_MIN_GAP_MS : PREKEY_REPLENISH_INTERVAL_MS;
  const since = now - last;
  // A stamp from the FUTURE (the clock went backwards) proves nothing and
  // does not hold the upload back.
  if (last > 0 && since >= 0 && since < gap) return 'skipped';
  const keys = await existingKeysForUpload();
  await apiUploadKeys(token, keys);
  await setSecret(PREKEY_REPLENISHED_AT_KEY, String(now));
  return 'uploaded';
}

export async function createOrRestoreAccount(): Promise<db.ProfileRow> {
  refuseInDuress();
  if (await hasPendingAccountDeletion()) await deleteAccount();
  refuseInDuress();
  // An account is about to exist again, so the deletion-time suspension is
  // over. Clearing it HERE rather than at the end of `deleteAccount` is
  // deliberate: the window that must stay closed is the whole gap between the
  // delete and the next registration, including a process that is killed in
  // between and relaunched into onboarding.
  resumeReauth();

  const existingProfile = await db.loadProfile();
  const identityExists = await hasIdentity();
  refuseInDuress();

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

  refuseInDuress();
  const { challenge } = await apiAuthChallenge(keys.identityKey);
  refuseInDuress();
  // The private key stays in the native protocol store; only the signature comes back.
  const signature = await signAuthChallenge(challenge, API_BASE);
  refuseInDuress();
  let authenticated;
  try {
    authenticated = await apiAuth(keys.identityKey, challenge, signature, existingProfile?.userId);
  } catch (error) {
    refuseInDuress();
    if (authFailure(error, 409, 'account_gone') || authFailure(error, 409, 'account_conflict') ||
        authFailure(error, 403, 'identity_tombstoned')) reportAccountGone();
    throw error;
  }
  refuseInDuress();
  const { userId, authToken } = authenticated;

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
  refuseInDuress();
  await setSecret(AUTH_TOKEN_KEY, authToken);
  refuseInDuress();

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
  refuseInDuress();
  await bindCallingAccount(userId);
  refuseInDuress();
  return profile;
}
