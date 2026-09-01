import {
  AGPL_SOURCE_URL_DEFAULT,
  authSignedBytes,
  AUTH_CHALLENGE_TTL_SECONDS,
  AuthChallengeRequest,
  type AuthChallengeResponse,
  AuthRequest,
  type AuthResponse,
  SESSION_TTL_SECONDS,
} from '@tacendum/shared';
import {
  type Handler,
  type HttpResult,
  errorResult,
  json,
  parseJson,
  rateLimitedResult,
} from './http.js';
import { LIMITS } from '../ratelimit.js';
import { sessionTokenDigest } from '../db/data.js';
import { revokeConnectionForSessions } from './session-revoke.js';
import { touchHumanActivity } from '../activity.js';
import { userRefForLog } from '../opaque-ref.js';

/**
 * Keypair-only account authentication.
 *
 * Replaces phone + SMS. The client's libsignal identity key IS the account:
 * it asks for a nonce, signs it with the identity private key that never
 * leaves the Keychain, and the server verifies with libsignal. No phone
 * number, no verification code, no carrier, and no directory anyone can search.
 *
 * WHAT THIS BUYS BEYOND DELETING SMS, stated precisely so nobody overclaims it
 * later. A stolen bearer token can still be abused for its remaining life —
 * it can read queued ciphertext it cannot decrypt, drain one-time prekeys, and
 * delete the account. What it can no longer do is *become* the account,
 * because the identity key is immutable (enforced in `storeKeys`) and
 * minting a fresh token requires the private key. **That property comes from
 * the immutability condition, not from challenge–response.** If the condition
 * is ever weakened, this comment is a lie.
 *
 * These handlers are hosted by their own Lambda (`aws/auth.lambda.ts`) because
 * server-side libsignal carries a 21 MB native binary that would otherwise tax
 * the cold start of every route, including message send. The local adapter
 * runs everything in one process and does not care.
 */

// The verify and its byte helpers live in `identity-verify.ts` —
// a LEAF module (libsignal only), so the app's cross-language vector suite
// can run the server's genuine verify without dragging this file's
// DynamoDB/limits graph into a React Native jest runtime. Re-exported HERE
// so "the auth path's exported verifyIdentitySignature" stays one symbol at
// its original address for every consumer (devices-signed.ts, the suites).
import { concatBytes, publicKeyOf, verifyIdentitySignature } from './identity-verify.js';
export { verifyIdentitySignature } from './identity-verify.js';

/**
 * The exact bytes a client must sign, built by the ONE shared definition
 * (`authSignedBytes` in `@tacendum/shared`) so the server, the CLI and the two
 * app-side implementations cannot drift apart.
 *
 * The domain tag is not decoration: the same identity key also signs signed
 * prekeys, and while today's two messages happen to be unconfusable — a
 * challenge is 32 server-chosen random bytes, a serialized prekey is 33 bytes
 * beginning 0x05 — that is an accident of the current formats, not a rule.
 *
 * The ORIGIN is the part that closes the relay. v1 signed
 * a nonce and nothing else, so the signature was valid at any verifier and a
 * hostile endpoint could have the client sign a challenge it had fetched from
 * the real server, then redeem it here.
 */
function signedBytes(apiOrigin: string, challengeB64: string): Uint8Array<ArrayBuffer> {
  const bytes = authSignedBytes(apiOrigin, challengeB64);
  // Re-home into a guaranteed ArrayBuffer for libsignal — see concatBytes.
  return concatBytes(bytes);
}

/**
 * This deployment's Corresponding Source offer (AGPL).
 *
 * Read from the environment rather than injected through `Deps` because it is
 * not a dependency — it is a constant string this build is obliged to state,
 * and threading it through the dependency factory would put it in front of
 * every host that does not owe it. Same module-level `process.env` convention
 * `db/tables.ts` uses, read PER CALL rather than frozen at load so a test can
 * state the deployed case and the fallback case in the same process.
 *
 * WHY A MISCONFIGURED VALUE MUST NOT THROW, where `readTableNames` does.
 * A set-but-empty table name is unrecoverable: the function would issue real
 * requests in a real Region against the local fallback name, so failing at
 * load is the safe answer. This is the opposite shape. exists to protect
 * the users of the service, and the service here is SIGN-IN — refusing to
 * start over a malformed source URL would deny every user the thing the licence
 * is protecting their access to, in order to perfect a notice about it. An
 * unset or empty value therefore falls back to the repo root, which is a
 * truthful offer in its own right, and the deploy pins the exact tag.
 *
 * "Must not take down sign-in" is a claim about ANY misconfiguration, not just
 * an absent one, and the first draft of this function only honoured it for the
 * empty case. It does not hold by itself: Node's `writeHead` rejects a header
 * value containing a character outside the class below with ERR_INVALID_CHAR,
 * so a source URL carrying an em dash or an un-punycoded IDN hostname — both
 * things an operator pastes without noticing — turned every POST /v1/auth and
 * /v1/auth/challenge into a 500. That is the exact outage this comment promised
 * could not happen, caused by the notice rather than prevented by it.
 *
 * So the value is filtered, not merely tested for emptiness: anything Node will
 * not accept in a header falls back to the repo root, on identical reasoning to
 * the whitespace rule. The failure that remains is a less precise offer, which
 * is recoverable and visible; the failure removed is a locked-out user base.
 */
const HEADER_SAFE_VALUE = /^[\t\x20-\x7e\x80-\xff]+$/;

/**
 * Printable ASCII minus SPACE, minus `>`, minus DEL — what may appear between
 * the angle brackets of a `Link` header without changing where the link points.
 *
 * NODE-SAFE IS NOT LINK-SAFE, which is the gap this closes and the header class
 * above does not. RFC 8288 delimits the target with `<`...`>`, so a `>` inside
 * the URL ends it early: `<https://x.example/a>b>; rel="source"` goes out on the
 * wire verbatim (verified — Node has no objection to any of it), and a
 * conforming parser reads the target as `https://x.example/a` and then chokes on
 * the remainder. The offer silently points somewhere else, which for is
 * worse than no offer at all: an absent notice is a bug, a confidently wrong one
 * is a false statement about where the source is. Spaces and raw Latin-1 pass
 * the Node class for the same reason and break the same way.
 */
const LINK_TARGET_SAFE = /^[\x21-\x3d\x3f-\x7e]+$/;

/**
 * The candidate as an absolute http(s) URL safe to interpolate into a `Link`
 * target, or undefined if it is not one.
 *
 * `new URL` does the encoding rather than a hand-rolled escape: it
 * percent-encodes `>` to `%3E`, SPACE to `%20`, and punycodes an IDN hostname,
 * which is exactly the "encode residual illegal characters" step and is far more
 * likely to be right than anything written here. `LINK_TARGET_SAFE` then holds
 * it to account instead of trusting it — if a future URL revision leaves
 * something raw, this refuses the value rather than emitting a broken offer.
 *
 * The protocol check is not decoration. `new URL` is happy with
 * `javascript:alert(1)` and `ftp://...` (both verified), and a offer that
 * is not fetchable over the web is not an offer.
 */
function linkSafeSourceUrl(candidate: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return undefined;
  return LINK_TARGET_SAFE.test(parsed.href) ? parsed.href : undefined;
}

export function sourceOfferUrl(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.TACENDUM_SOURCE_URL?.trim();
  // Both filters, in this order, and the first is not redundant: it is the
  // constraint the BODY field carries (any Node-safe string serialises into
  // JSON), and it is the cheap reject for the values that never had a chance.
  // The second is the constraint the HEADER carries, which is strictly tighter.
  if (!configured || !HEADER_SAFE_VALUE.test(configured)) return AGPL_SOURCE_URL_DEFAULT;
  return linkSafeSourceUrl(configured) ?? AGPL_SOURCE_URL_DEFAULT;
}

/** The Link relation, exported so every test pins the one true string. */
export const SOURCE_LINK_REL = 'source https://tacendum.com/rel/source';

/**
 * Add `Link: <url>; rel="source https://tacendum.com/rel/source"` to a result.
 *
 * TWO relation tokens, because `rel` is a space-separated list (RFC 8288
 *) serving two different readers. `source` is the de-facto,
 * human-greppable token an AGPL reviewer scans headers for — but it is not
 * an IANA-registered relation, and the RFC requires an unregistered
 * extension relation to be an absolute URI. The second token is that URI,
 * so a strict parser matches it while a human still sees the word. Chosen
 * to close the registry gap.
 *
 * THE ONE IMPLEMENTATION. Both hosts call it — `aws/auth.lambda.ts` on every
 * response it returns, `local/http.ts` on every response for the two auth paths
 * because is owed to a remote USER of the service, and a user who is rate
 * limited, refused, or handed a 500 is no less a user of it. Applying it at
 * those two boundaries rather than at each handler exit is what makes that
 * true of the paths nobody remembers: the 429 above, the 404 for an unknown
 * routeKey, the 413 for an oversized body, the 500 for a thrown handler.
 *
 * WHY ERRORS GET THE HEADER BUT NOT A BODY FIELD, decided rather than
 * overlooked. The success bodies carry `source` as well, because they are typed
 * by `AuthChallengeResponse` / `AuthResponse` and the field belongs to those two
 * shapes alone. Error bodies are built by `errorResult`, the SINGLE constructor
 * behind 34 call sites in 11 handler modules — every route in the system, not
 * these two. Putting `source` there would print an AGPL offer on failures from
 * routes says nothing about, which is the same over-reach as growing a Link
 * header on non-auth routes; putting it there per-route means editing every
 * exit, which is the fragility this boundary exists to avoid. So the offer on
 * an error is the header, which is host-level and therefore complete.
 *
 * Both carriers, not either, on the responses that get both: the body serves a
 * person or a client reading JSON, the header serves anything that never looks
 * at a body — a HEAD, a proxy, a reviewer running `curl -I`. RFC 8288 relation,
 * lowercase name to match the rest of this codebase's headers (HTTP header
 * names are case-insensitive, and HTTP/2 puts them on the wire lowercase).
 *
 * Copies the header map rather than mutating it: `json` hands back a SHARED
 * frozen constant, and writing into it would put a Link header on every JSON
 * response in the process, including routes that must not carry one.
 */
export function withSourceOffer(result: HttpResult, source: string): HttpResult {
  return {
    ...result,
    headers: { ...result.headers, link: `<${source}>; rel="${SOURCE_LINK_REL}"` },
  };
}

/**
 * The routes AGPL reaches, keyed `METHOD PATH`.
 *
 * A LIST, not a prefix test, and deliberately not `startsWith('/v1/auth')`:
 * this is the predicate that decides which responses grow a Link header, and a
 * prefix would silently enrol every future `/v1/auth*` route — including ones
 * that are ordinary bearer-token endpoints with no argument for them.
 *
 * METHOD AND PATH, not path alone, which is how it was first written and was
 * wrong: routing matches on both, so `GET /v1/auth` is not the auth route, it
 * is a 404. Keyed by path only it got the offer anyway (verified: `GET
 * /v1/auth`, `DELETE /v1/auth` and `GET /v1/auth/challenge` all returned a
 * Link-bearing 404) — an offer attached to routes that do not exist, which is
 * the same class of overclaim as putting it on the other eighteen.
 *
 * The key format matches `auth.lambda.ts`'s `routes` table verbatim, so the two
 * hosts spell the same set the same way. The AWS host needs no predicate of its
 * own: AuthFn hosts these two routes and nothing else, so there the function
 * boundary IS the predicate.
 */
export const SOURCE_OFFER_ROUTES: ReadonlySet<string> = new Set([
  'POST /v1/auth/challenge',
  'POST /v1/auth',
]);

/**
 * POST /v1/auth/challenge — issue a nonce for an identity key.
 *
 * Unauthenticated by necessity: proving who you are is the whole point of the
 * next call. A challenge is not a credential — it is a nonce, and reading one
 * gains an attacker nothing without the private key — so this leaks nothing
 * and needs no attempt counter. Per-IP rate limited like register/verify were.
 *
 * Issuing NEVER replaces a pending challenge: each (key, nonce) pair is its
 * own row, so concurrent challenges coexist. The route takes nothing but the
 * PUBLIC identity key, so if issuing overwrote the pending row, anyone who
 * knew a victim's key could clobber their in-flight sign-in at will. Banking
 * nonces is worthless for the same reason reading one is — no private key, no
 * signature — and the 2-minute TTL plus the per-IP limit bound the pile.
 */
export const authChallengeHandler: Handler = async (event, deps) => {
  const retry = await deps.rateLimit.take(`auth:${event.sourceIp ?? 'unknown'}`, LIMITS.auth);
  if (retry > 0) return rateLimitedResult(retry);

  const parsed = parseJson(event, AuthChallengeRequest);
  if (!parsed.ok) return parsed.result;

  const identityKey = parsed.data.identityKey;
  if (!publicKeyOf(identityKey)) {
    return errorResult(400, 'invalid_request', 'identityKey is not a valid public key');
  }

  const challenge = deps.newChallenge();
  const expiresAt = Math.floor(deps.now() / 1000) + AUTH_CHALLENGE_TTL_SECONDS;
  await deps.db.putAuthChallenge({ identityKeyPub: identityKey, challenge, expiresAt });

  // The identity key is account identity data, exactly like a phone number
  // was: it stays out of the retained operational log.
  deps.log('auth_challenge_issued');

  // AGPL reaches this response first: it is the one an unauthenticated
  // caller gets, so it is the earliest point the offer can be made. The BODY
  // field is set here because it belongs to this response's declared shape; the
  // matching `Link` header is added by the host, which is the only layer that
  // sees the refusals and 500s this handler never returns from. See
  // `withSourceOffer`.
  const body: AuthChallengeResponse = { challenge, expiresAt, source: sourceOfferUrl() };
  return json(200, body);
};

/**
 * POST /v1/auth — verify the signed challenge, then create or resolve the
 * account and issue a session.
 *
 * Orderings that are each a bug if reversed:
 *  - **Verify before consuming.** A wrong signature must not spend an honest
 *    client's challenge. Unlike a 6-digit code this is not a guessing game —
 *    without the private key no number of attempts helps — so there is nothing
 *    to gain by charging for failures, and plenty to lose in usability.
 *  - **Consume before creating.** The conditional delete is what makes the
 *    challenge single-use; two concurrent calls must not both mint a session.
 *
 * Keys are NOT uploaded here — see the note on `AuthRequest`. The account row
 * carries `identityKeyPub` from the moment it is created, in the same
 * transaction as the claim row, so the ordinary `PUT /v1/keys` route is
 * already pinned to the key that proved the account.
 */
export const authHandler: Handler = async (event, deps) => {
  const retry = await deps.rateLimit.take(`auth:${event.sourceIp ?? 'unknown'}`, LIMITS.auth);
  if (retry > 0) return rateLimitedResult(retry);

  const parsed = parseJson(event, AuthRequest);
  if (!parsed.ok) return parsed.result;

  const { identityKey, challenge, signature } = parsed.data;

  const publicKey = publicKeyOf(identityKey);
  if (!publicKey) {
    return errorResult(400, 'invalid_request', 'identityKey is not a valid public key');
  }

  const record = await deps.db.getAuthChallenge(identityKey, challenge);
  // No pending challenge for this (key, nonce) pair: a single generic answer,
  // so this cannot be used to ask which keys have a challenge out.
  if (!record) {
    return errorResult(401, 'invalid_challenge', 'unknown or already-used challenge');
  }

  // Checked here, not left to DynamoDB TTL: TTL deletion lags by up to 48
  // hours, so an expired row is routinely still readable.
  const nowSeconds = Math.floor(deps.now() / 1000);
  if (record.expiresAt < nowSeconds) {
    await deps.db.consumeAuthChallengeIfMatches(identityKey, record.challenge);
    return errorResult(401, 'challenge_expired', 'challenge expired; request a new one');
  }

  // The ONE verify (see verifyIdentitySignature): the link routes ride this
  // same call, so drift between "auth's verify" and "the ceremony's verify"
  // is structurally impossible.
  const verified = verifyIdentitySignature(
    identityKey,
    signedBytes(deps.apiOrigin, challenge),
    signature,
  );
  if (!verified) {
    deps.log('auth_signature_rejected');
    return errorResult(401, 'invalid_signature', 'signature does not verify');
  }

  // Atomic single-use. A read-then-delete would let two concurrent callers
  // both pass the check above; the loser here is indistinguishable from a
  // replay, which is what it is.
  const consumed = await deps.db.consumeAuthChallengeIfMatches(identityKey, challenge);
  if (!consumed) {
    return errorResult(401, 'invalid_challenge', 'unknown or already-used challenge');
  }

  const resolution = await deps.db.getOrCreateUserByIdentityKey(
    identityKey,
    deps.newUserId(),
    deps.now(),
    parsed.data.accountClass,
  );
  if (resolution.kind === 'conflict') {
    // Claim row resolves but the user row is gone — only reachable after a
    // partially-failed deletion. Answered rather than papered over: deleting
    // the claim and recreating here would let a lost race mint a SECOND
    // account for one key, destroying the invariant the claim row exists for.
    deps.log('auth_account_conflict');
    return errorResult(409, 'account_conflict', 'account is mid-deletion; register again');
  }
  if (resolution.kind === 'tombstoned') {
    // The key was revoked by its integration's owner.
    // 403, not 401: the signature verified — the CALLER is authentic, the KEY
    // is dead — so a client must not treat this as "retry with fresh auth".
    deps.log('auth_tombstoned_refused');
    return errorResult(403, 'identity_tombstoned', 'this identity key has been revoked');
  }
  const user = resolution.user;
  if (resolution.created) {
    // The mint counter the CloudWatch account-creation alarm reads
    // Class and ULID only — the identity key stays
    // out of the retained log, same rule as auth_challenge_issued.
    deps.log('account_created', {
      class: parsed.data.accountClass ?? 'human',
    });
  }

  const authToken = deps.newAuthToken();
  await deps.db.createSession({
    token: authToken,
    userId: user.userId,
    createdAt: deps.now(),
    expiresAt: nowSeconds + SESSION_TTL_SECONDS,
  });

  // Proving the key supersedes every earlier session, same as verify did for
  // the phone: one install, one ULID (an account group
  // is a grouping of per-install accounts, never a shared identity), so a
  // token from a previous holder of THIS key has no legitimate claim once
  // the key proves itself again. Per-ULID the supersede stays exactly right
  // under grouping: a sibling device is its own ULID with its own sessions,
  // untouched by this line. After the new session exists, and never allowed
  // to fail the sign-in that just succeeded.
  try {
    const revoked = await deps.db.deleteSessionsForUser(user.userId, authToken);
    // Opaque ref, not the ULID: the retained log keeps a
    // stable per-user debugging pseudonym; it no longer holds the identity.
    if (revoked > 0)
      deps.log('prior_sessions_revoked', {
        userRef: userRefForLog(user.userId, deps.userRefSalt),
        revoked,
      });
    // Tear down the socket the OLD install opened too: the new session
    // has no socket yet, so anything holding the account's routing row belongs
    // to a session just revoked. `exceptDigest` of the new token spares a
    // socket the new session somehow already owns (it does not, but the guard
    // costs nothing and states the intent). Inside the same try: a superseding
    // sign-in must never fail over a socket teardown.
    await revokeConnectionForSessions(deps, user.userId, {
      exceptDigest: sessionTokenDigest(authToken),
    });
  } catch {
    deps.log('prior_session_revoke_failed', {
      userRef: userRefForLog(user.userId, deps.userRefSalt),
    });
  }

  await touchHumanActivity(user, deps);

  deps.log('auth_success', { userRef: userRefForLog(user.userId, deps.userRefSalt) });
  const response: AuthResponse = {
    userId: user.userId,
    authToken,
    // The row is the authority on the class, so the row is what is reported.
    ...(user.accountClass ? { accountClass: user.accountClass } : {}),
    // Repeated here and not left to the challenge response: a client that
    // already holds a challenge can reach this route without seeing that one,
    // and offer is owed to the user of the service, not to a request.
    // The `Link` header that accompanies it is the host's, not this handler's.
    source: sourceOfferUrl(),
  };
  return json(200, response);
};
