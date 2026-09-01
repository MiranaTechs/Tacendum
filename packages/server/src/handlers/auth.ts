import {
  type AuthContext,
  type AuthedHandler,
  type Deps,
  type Handler,
  type HttpEvent,
  bearerToken,
  errorResult,
} from './http.js';

/**
 * Resolve the caller from a bearer token. Returns the auth context on a valid,
 * unexpired session; null otherwise. No token, unknown token, and expired token
 * are all indistinguishable to the caller (always 401 upstream).
 */
export async function authenticate(
  event: HttpEvent,
  deps: Deps,
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
  if (await deps.db.isUserTombstoned(session.userId)) return null;

  return { userId: session.userId };
}

/** Wrap a handler so it only runs for authenticated callers. */
export function requireAuth(handler: AuthedHandler): Handler {
  return async (event, deps) => {
    const auth = await authenticate(event, deps);
    if (!auth) {
      return errorResult(401, 'unauthorized', 'missing or invalid bearer token');
    }
    return handler(event, deps, auth);
  };
}
