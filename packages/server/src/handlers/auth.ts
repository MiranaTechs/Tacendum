import {
  type AuthContext,
  type AuthedHandler,
  type Deps,
  type Handler,
  type HttpEvent,
  bearerToken,
  errorResult,
} from './http.js';

export interface AuthenticateOptions {
  /**
   * Admit a valid, unexpired, UNREVOKED session whose user row is ABSENT.
   * Exactly one route sets this — DELETE /v1/account, through
   * `deleteAccountRoute` (handlers/account.ts) — because the deletion
   * cascade deletes the user row FIRST and sweeps the userId-keyed residue
   * after it, with sessions last, so a crash mid-sweep leaves the caller
   * authenticated to re-run the sequence. The absent-row refusal below would
   * otherwise answer that retry 401, stranding queued
   * ciphertext, prekeys, consent edges and the push token with no path to
   * finish.
   *
   * Safe to admit ONLY there: the cascade is purely destructive and keyed by
   * the session's own userId — a ULID that is never re-minted — so an
   * absent-row caller can reach nothing but its own residue. A TOMBSTONED
   * row still refuses regardless: that record is a revocation's enforcement.
   */
  allowAbsentRow?: boolean;
}

/**
 * Resolve the caller from a bearer token. Returns the auth context on a valid,
 * unexpired session; null otherwise. No token, unknown token, and expired token
 * are all indistinguishable to the caller (always 401 upstream).
 */
export async function authenticate(
  event: HttpEvent,
  deps: Deps,
  opts: AuthenticateOptions = {},
): Promise<AuthContext | null> {
  const token = bearerToken(event);
  if (!token) return null;
  // Our tokens are 43 chars (32 bytes b64url). Reject absurd lengths before
  // they reach DynamoDB, where an oversized key would throw (500) not miss.
  if (token.length > 512) return null;

  const session = await deps.db.getSession(token);
  if (!session) return null;

  const nowSeconds = Math.floor(deps.now() / 1000);
  if (session.expiresAt < nowSeconds) return null;

  // Read-time revocation enforcement:
  // a session whose account row is revoked-with-tombstone is refused HERE,
  // at validation — the same discipline as the explicit expiresAt check
  // above, because session deletion is CLEANUP a crash may have skipped and
  // reaping is never the enforcement. One strongly consistent, projection-
  // thin GetItem per authenticated request is the priced cost of "a stolen
  // device's already-issued bearer token stops working the instant the
  // roster transaction commits". Indistinguishable from any other 401 —
  // no oracle.
  //
  // And a row that is ABSENT refuses too: a session that survived a racy
  // account deletion, or any session of a revoked integration (whose row is
  // deleted, not tombstoned), used to keep working for up to 30 days on
  // every route that never reads the user row — attachment mints, TURN
  // credentials, WS tickets, reports, /v1/me. No row, no account, no
  // session. A freshly registered account is written before its first
  // session is minted, and this read is strongly consistent, so its first
  // request still authenticates.
  //
  // The one exception is the deletion route's crashed-sweep retry, which
  // opts in with `allowAbsentRow` (see AuthenticateOptions) — absent only;
  // tombstoned refuses on every route.
  const state = await deps.db.userAccountState(session.userId);
  if (state === 'tombstoned') return null;
  if (state === 'absent' && opts.allowAbsentRow !== true) return null;

  return { userId: session.userId };
}

/** Wrap a handler so it only runs for authenticated callers. */
export function requireAuth(handler: AuthedHandler, opts: AuthenticateOptions = {}): Handler {
  return async (event, deps) => {
    const auth = await authenticate(event, deps, opts);
    if (!auth) {
      return errorResult(401, 'unauthorized', 'missing or invalid bearer token');
    }
    return handler(event, deps, auth);
  };
}
