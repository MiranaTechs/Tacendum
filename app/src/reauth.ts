import {
  getSecret,
  identityPublicKey,
  setSecret,
  signAuthChallenge,
} from 'tacendum-crypto';
import { apiAuth, apiAuthChallenge, apiProbeSession } from './api';
import * as db from './db';
import { session } from './session';
import type { WsAuthOutcome } from './ws';
import { API_BASE } from './config';

/**
 * Re-authentication: the 30-day cliff, and the only path back
 * off it.
 *
 * Sessions last `SESSION_TTL_SECONDS` = 30 days. Until this module existed the
 * app healed exactly one bad state — profile present, token ABSENT — and the
 * state nobody handled was the one that actually happens: token present but
 * expired or revoked. On day 31 every REST call answers 401 and the WebSocket
 * authorizer refuses `$connect`, so the socket backed off to its 30 s ceiling
 * and stayed there. The chat list read "Offline" while the network was fine,
 * forever, with no interaction that could fix it. A silent death, in an app.
 *
 * Keypair accounts make the remedy nearly free: the identity private key IS
 * the account, it is already in the Keychain, and
 * three calls that `createOrRestoreAccount` already makes mint a fresh session
 * with no user interaction — minus the key upload, which would drag prekey
 * replenishment into a code path that has nothing to do with it.
 *
 * FOUR RULES, each of which is a real failure if dropped:
 *
 *  1. **Single-flight.** `POST /v1/auth` revokes every prior session for the
 *     user (`auth-account.ts` `deleteSessionsForUser`), so N racing mints kill
 *     each other: the last one standing invalidates the token every earlier
 *     caller just started using. Sharing one in-flight promise is correctness
 *     here, not politeness.
 *  2. **The stale-bearer check** (`mint` below, and the cheap half in
 *     `reauthenticate`). This exact hole was found in
 *     this exact pattern: two requests whose 401s are staggered by ~250 ms both
 *     minted, because by the time the second one looked, the stored token had
 *     already been replaced and the "has it moved on?" test compared the wrong
 *     pair. A request that failed on a token which has SINCE been replaced must
 *     retry with the new one and mint nothing. Without it, "single-flight"
 *     holds only for perfectly simultaneous callers — the case that never
 *     happens in the field.
 *  3. **A stop condition, not a loop.** `'gone'` is terminal: 403
 *     `identity_tombstoned` (a revoked integration key) and 409
 *     `account_conflict` (an account mid-deletion) mean the signature VERIFIED
 *     and the account is still unusable. A deleted account 401s forever;
 *     retrying it is a self-inflicted DoS on our own auth route.
 *  4. **Duress-silent.** A coerced session issues no packet at all. It must look offline, which is already its cover story.
 *
 * The CLI additionally needs CROSS-PROCESS single-flight (five `tacendum send`
 * processes from one Makefile minted five sessions and four died). The app is
 * one process, so the in-process lock plus the stale-bearer check is
 * sufficient — noted here so nobody later ports the CLI's file-lock machinery
 * across believing it is required.
 */

/**
 * Keychain account for the bearer token.
 *
 * It lives HERE, not in `messaging.ts` where it was declared, because this is
 * the module that owns the credential's lifecycle now — reading it, replacing
 * it, and deciding when it is beyond replacing. `messaging.ts` re-exports it so
 * every existing importer (registration.ts, App.tsx, call/index.ts) keeps its
 * import path; a second copy of the string in a second file is how a Keychain
 * key silently drifts.
 */
export const AUTH_TOKEN_KEY = 'authToken';

/**
 * What a re-auth attempt resolves to.
 *
 * Two of these are the obvious pair; the other two are the states a two-value
 * union has to lie about. A transient failure is not "gone" (latching a dead
 * account over a flaky network is the worst mistake available here) and it is
 * not "ok" either (the caller must not retry a request with the same dead
 * token). Duress is neither: nothing was tried, so nothing failed.
 */
export type ReauthResult =
  /** A fresh token is in the Keychain. Retry with it — once. */
  | 'ok'
  /** Terminal. This account no longer exists; never retry, surface it. */
  | 'gone'
  /** Duress: no packet was sent and nothing was minted.
   * NOT an account problem — a caller must never present it as one. */
  | 'silent'
  /** Transient: offline, rate-limited, an expired challenge, a Keychain that
   * would not read. Nothing was latched; a later attempt may well work. */
  | 'error';

/** The one in-flight mint every concurrent caller joins. */
let inflight: Promise<ReauthResult> | null = null;
/** Terminal latch. Once true, no further packet is ever sent. */
let gone = false;
/** The newest token THIS module minted — the cheap half of rule 2. */
let lastMinted: string | null = null;

/** Set across `DELETE /v1/account`, cleared when an account exists again. */
let suspended = false;

const goneListeners = new Set<() => void>();
const tokenListeners = new Set<(token: string) => void>();

/**
 * Rule 15, asked again rather than once.
 *
 * The guard at `reauthenticate()`'s entry only covers a session that was
 * ALREADY coerced. A mint has four awaits in it — the Keychain, the native
 * signer, and two round trips — and the app can relock and be duress-unlocked
 * across any of them. A coerced phone that emits `POST /v1/auth` because a real
 * session started the request thirty seconds ago is exactly as compromised as
 * one that never had a guard at all, so every packet and the token write are
 * each preceded by this question.
 */
function duress(): boolean {
  return session.mode === 'duress';
}

/** Hand a credential to the two in-memory caches (`MessagingService.token`,
 * `WsClient.token`). Advisory: a throwing subscriber must never break a
 * renewal that already succeeded. */
function publishToken(token: string): void {
  for (const listener of tokenListeners) {
    try {
      listener(token);
    } catch {
      // See above.
    }
  }
}

/**
 * Stop re-auth entirely while the account is being deleted, and resume when one
 * exists again (`registration.ts`).
 *
 * `DELETE /v1/account` revokes the bearer, but authenticated requests already in
 * flight cannot be recalled. Each one 401s a moment later, `request()` heals it,
 * and the heal calls `POST /v1/auth` — which for a known identity key whose user
 * row is gone CREATES A NEW ACCOUNT. The device then finds a userId it does not
 * recognise and latches the terminal state, so the user is left staring at "this
 * account no longer exists" on top of the onboarding screen they were just sent
 * to, with an orphan account on the server. Deletion is the one moment when a
 * 401 means "as intended" rather than "heal me".
 */
export function suspendReauth(): void {
  suspended = true;
}

export function resumeReauth(): void {
  suspended = false;
}

/** True once the account behind this device has been proven unrecoverable. */
export function accountGone(): boolean {
  return gone;
}

/** Fires once, when `accountGone()` first becomes true. App.tsx renders the
 * terminal state from it: the alternative is an app that looks merely offline
 * while it is in fact signed in as nobody. */
export function onAccountGone(listener: () => void): () => void {
  goneListeners.add(listener);
  return () => goneListeners.delete(listener);
}

/**
 * Fires after every successful mint.
 *
 * There are TWO cached copies of the credential in this app — `WsClient.token`
 * and `MessagingService.token` — and the Keychain is the third. A re-auth that
 * updates only the Keychain leaves messaging presenting a revoked bearer on
 * every prekey fetch and every attachment call: each one 401s, is rescued by
 * the stale-bearer check, and costs a wasted round trip forever. Messaging
 * subscribes in `start()` and unsubscribes in `stop()`.
 */
export function subscribeToken(listener: (token: string) => void): () => void {
  tokenListeners.add(listener);
  return () => tokenListeners.delete(listener);
}

/** The bearer to present right now, straight from the Keychain (the one point
 * of truth — `createOrRestoreAccount` and App.tsx's boot heal also write it). */
export async function currentToken(): Promise<string | null> {
  try {
    return await getSecret(AUTH_TOKEN_KEY);
  } catch {
    // A Keychain read can fail on a device that has not been unlocked since
    // boot (the item is AfterFirstUnlockThisDeviceOnly). Absence, not damage.
    return null;
  }
}

/**
 * Mint a fresh session, or answer why not. Single-flight across every caller.
 *
 * `presented` is the bearer that ACTUALLY FAILED — not "the current token",
 * which is the confusion rule 2 exists to prevent. Pass null only when there
 * was no bearer to fail (nothing to compare, so nothing to skip).
 *
 * DELIBERATELY NOT `async`. An `await` anywhere above the `inflight` check
 * would let two callers that 401 in the same tick both observe `null` and both
 * start a mint — the exact race single-flight exists to prevent, and the one
 * the server punishes hardest, since the second mint revokes the first's token.
 */
export function reauthenticate(presented?: string | null): Promise<ReauthResult> {
  if (session.mode === 'duress') {
    // Rule 15, and it is the first line for the same reason `refuseInDuress`
    // is the first line of createOrRestoreAccount: nothing below may run, not
    // even a Keychain read, because a coerced session's whole story is that
    // this phone is offline.
    return Promise.resolve('silent');
  }
  if (gone) return Promise.resolve('gone');
  // Mid-deletion: a 401 here is the intended outcome, not something to heal.
  if (suspended) return Promise.resolve('silent');
  // Cheap half of the stale-bearer check: this caller failed on a token we
  // have already replaced, so it needs a retry, not a mint. Synchronous on
  // purpose — see the note above about awaits before the single-flight check.
  if (presented && lastMinted && lastMinted !== presented) {
    return Promise.resolve('ok');
  }
  if (inflight) return inflight;

  const flight = mint(presented ?? null);
  inflight = flight;
  // Cleared when it settles, not when it succeeds: a FAILED renewal that
  // stayed pinned as "in flight" would answer every later caller with the same
  // stale failure for the life of the process. `mint` never rejects, so this
  // handler cannot produce an unhandled rejection.
  void flight.finally(() => {
    if (inflight === flight) inflight = null;
  });
  return flight;
}

/** The mint itself. Total by construction — every failure becomes a verdict,
 * because a rejection here would propagate into `request()`'s catch and be
 * reported as whatever the original call was doing. */
async function mint(presented: string | null): Promise<ReauthResult> {
  try {
    // Authoritative half of the stale-bearer check. The Keychain rather than
    // `lastMinted`, because `createOrRestoreAccount()` and App.tsx's boot heal
    // write this key too and never come through here — a caller holding a
    // token from before one of those must retry, not mint.
    const current = await currentToken();
    if (presented !== null && current !== null && current !== presented) {
      // Someone else — `createOrRestoreAccount`, App.tsx's boot heal, an
      // earlier mint — already replaced this credential. Tell the caches, or
      // messaging and the socket go on presenting the token that just lost,
      // burning a 401 round trip on every call until a real mint happens.
      publishToken(current);
      return 'ok';
    }
    if (duress()) return 'silent';

    const identityKey = await identityPublicKey();
    if (identityKey === null) {
      // Nothing to prove ownership with. NOT terminal: this is also what an
      // unreadable Keychain looks like, and latching "your account is gone"
      // over a transient read is the one mistake this module must never make.
      // A genuinely identity-less install has no token to have 401'd anyway.
      return 'error';
    }

    if (duress()) return 'silent';
    const { challenge } = await apiAuthChallenge(identityKey);
    // The private key never crosses the bridge; only the signature comes back.
    const signature = await signAuthChallenge(challenge, API_BASE);
    if (duress()) return 'silent';
    const { userId, authToken } = await apiAuth(identityKey, challenge, signature);
    if (duress()) return 'silent';

    // `getOrCreateUserByIdentityKey` will happily CREATE an account for a known
    // key whose user row is gone — which is exactly what `DELETE /v1/account`
    // leaves behind. A new userId therefore does not mean "signed in", it means
    // the account this device belongs to no longer exists: every ratchet
    // session and pinned identity in the native store is keyed by the OLD
    // userId, so adopting this token would address all of them to a stranger.
    // Terminal, and nothing is written — not even the token we were just handed.
    let selfUserId: string | null = null;
    try {
      selfUserId = (await db.loadProfile())?.userId ?? null;
    } catch {
      // The database is closed behind the lock screen, so the continuity check
      // CANNOT RUN — and the first draft let that mean "accepted". Fail closed
      // instead: 'error' is transient, the next attempt runs with the workspace
      // open, and nothing is written in the meantime. Failing open here is
      // worse than it sounds, because the relock that closes the database is
      // the same event most likely to be racing a server-side deletion: the
      // check that exists to stop a stranger's token being adopted would be
      // disabled by exactly the sequence it guards against.
      return 'error';
    }
    if (selfUserId !== null && selfUserId !== userId) return latchGone();

    await setSecret(AUTH_TOKEN_KEY, authToken);
    lastMinted = authToken;
    publishToken(authToken);
    return 'ok';
  } catch (err) {
    const failure = apiStatus(err);
    // 403 `identity_tombstoned` and 409 `account_conflict` are the two answers
    // that mean "the signature verified and the account is STILL unusable" —
    // a revoked integration key, or an account mid-deletion. Retrying either is
    // the infinite loop. Everything else (401 on a stale challenge, 429, 5xx,
    // a dead network) is transient by construction.
    //
    // The CODE is checked, not just the status, and that is not pedantry: a WAF
    // rule, an API Gateway resource policy or any middlebox in front of this
    // route can answer 403 with no body at all. Latching on the status alone
    // would mount the no-exit "this account no longer exists" screen over a
    // network appliance having an opinion — the one mistake this module must
    // never make, made permanent for the life of the process.
    if (failure?.status === 403 && failure.code === 'identity_tombstoned') return latchGone();
    if (failure?.status === 409 && failure.code === 'account_conflict') return latchGone();
    return 'error';
  }
}

function latchGone(): 'gone' {
  gone = true;
  for (const listener of goneListeners) {
    try {
      listener();
    } catch {
      // Advisory, same as above: a throwing subscriber must not turn a
      // terminal verdict into an exception on the caller's path.
    }
  }
  return 'gone';
}

/**
 * HTTP status of an `ApiRequestError`, by NAME rather than `instanceof`.
 *
 * Same reason `messaging.ts`'s `isNotFound` does it: a jest module mock of
 * `./api` that omits the class would turn the check itself into a TypeError
 * thrown from inside a catch block, converting a clean verdict into a crash on
 * the failure path. `ApiRequestError` sets `name` in its constructor.
 */
function apiStatus(err: unknown): { status: number; code?: string } | undefined {
  if (err instanceof Error && err.name === 'ApiRequestError') {
    const e = err as Error & { status?: number; code?: string };
    return e.status === undefined ? undefined : { status: e.status, code: e.code };
  }
  return undefined;
}

/**
 * A blip we could not verify: no network, no bearer to ask with, a duress
 * session that must not ask. The socket refunds its probe for these, because
 * an unanswered question is not evidence (see `WsAuthOutcome.conclusive`).
 */
const BLIP: WsAuthOutcome = { verdict: 'blip' };
/** A blip the server confirmed: the credential is live, so the probe is spent. */
const LIVE: WsAuthOutcome = { verdict: 'blip', conclusive: true };
const GONE: WsAuthOutcome = { verdict: 'gone' };

/**
 * Disambiguate a WebSocket that would not stay connected.
 *
 * A refused upgrade carries no readable status in React Native: on AWS the
 * authorizer denies before the upgrade and RN reports close code 1006 with a
 * human-readable reason string; on the local adapter the upgrade COMPLETES and
 * a `close(4001, 'unauthorized')` follows milliseconds later. Neither is a
 * status code the client can branch on with confidence, and guessing wrong in
 * either direction is bad: treat a blip as an auth failure and every subway
 * tunnel mints a session; treat an auth failure as a blip and we are back to
 * backing off forever.
 *
 * So the socket asks one cheap authenticated question instead — `GET /v1/me`,
 * which exists precisely to exercise the bearer middleware end to end — and
 * believes the answer. `ws.ts` calls this at most once per failure episode
 * (and once more after a re-auth), never per retry, or the probe becomes its
 * own hammer.
 */
export async function probeAndHeal(presented: string | null): Promise<WsAuthOutcome> {
  // Rule 15 again. A duress session never starts messaging, so this is
  // unreachable today — but "unreachable today" is not a property, and a blip
  // verdict keeps the socket backing off silently, which IS the cover story.
  if (session.mode === 'duress') return BLIP;
  if (gone) return GONE;

  const token = presented ?? (await currentToken());
  // No credential at all: re-auth is not what this socket is missing, and
  // minting one here would race App.tsx's own boot heal.
  if (!token) return BLIP;

  let status: number;
  try {
    status = await apiProbeSession(token);
  } catch {
    // The probe itself could not reach the server — which is the strongest
    // possible evidence that the close WAS a network blip.
    return BLIP;
  }
  // 200 (or anything else the route can answer) means the credential is live;
  // whatever closed the socket, it was not authorization. This is the ONE path
  // that answers the question it was asked, so it is the one that spends the
  // probe.
  if (status !== 401) return LIVE;

  const outcome = await reauthenticate(token);
  if (outcome === 'gone') return GONE;
  if (outcome !== 'ok') return BLIP;
  const fresh = await currentToken();
  return fresh ? { verdict: 'reauthed', token: fresh } : BLIP;
}
