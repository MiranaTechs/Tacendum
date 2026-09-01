import { LIMITS } from '../ratelimit.js';
import { sessionTokenDigest } from '../db/data.js';
import { userRefForLog } from '../opaque-ref.js';
import { revokeConnectionForSessions } from './session-revoke.js';
import { type AuthedHandler, bearerToken, json, rateLimitedResult } from './http.js';

/**
 * Session revocation.
 *
 * Sessions last 30 days and, until now, the only way to kill one was to delete
 * the whole account: they are keyed by token digest, so there was nothing to
 * look them up by. A leaked token therefore outlived any remedy short of
 * self-destruction. These two routes close that.
 *
 * Both are idempotent — revoking an already-revoked session is a 200, because
 * the caller's goal ("this credential must not work") is already true and
 * making them distinguish "gone" from "was never there" only invites retries.
 */

/**
 * DELETE /v1/session — sign out: revoke the token that made this call.
 *
 * The caller wipes local state only AFTER this resolves, the same ordering
 * account deletion uses: a client that forgot its token while the server still
 * honours it has strictly less security than one that did neither.
 */
export const deleteSessionHandler: AuthedHandler = async (event, deps, auth) => {
  const retry = await deps.rateLimit.take(`session-revoke:${auth.userId}`, LIMITS.sessionRevoke);
  if (retry > 0) return rateLimitedResult(retry);

  // Present by construction — requireAuth resolved a session from it — but the
  // type is honest that bearerToken can miss, and a 500 here would be absurd.
  const token = bearerToken(event);
  if (token) {
    await deps.db.deleteSession(token);
    // Revoke the SOCKET this session opened, not just the session row.
    // Only this session's own socket — a socket another session holds must
    // survive a single-device sign-out. Deleting the session first means the
    // socket's own $default recheck also refuses from this instant, so a
    // socket the disconnect misses still stops the moment it next speaks.
    await revokeConnectionForSessions(deps, auth.userId, {
      onlyDigest: sessionTokenDigest(token),
    });
  }
  // Opaque ref, not the ULID: the retained log keeps a
  // stable per-user debugging pseudonym; it no longer holds the identity.
  deps.log('session_revoked', { userRef: userRefForLog(auth.userId, deps.userRefSalt) });
  return json(200, {});
};

/**
 * DELETE /v1/sessions/others — revoke every OTHER session for this user and
 * keep the calling one alive. This is the "I lost my old phone" action, and
 * the natural follow-up to setting a registration lock.
 *
 * The count is returned because it is the only feedback that means anything:
 * "2 other devices signed out" tells you something you may not have known,
 * and a bare 200 does not.
 */
export const deleteOtherSessionsHandler: AuthedHandler = async (event, deps, auth) => {
  const retry = await deps.rateLimit.take(`session-revoke:${auth.userId}`, LIMITS.sessionRevoke);
  if (retry > 0) return rateLimitedResult(retry);

  const token = bearerToken(event);
  const revoked = await deps.db.deleteSessionsForUser(auth.userId, token ?? undefined);
  // Tear down the socket any OTHER session opened: there is one routing
  // row per account, so if it belongs to a session that is not the caller's,
  // it is one of the ones just revoked. The caller's own socket — matched by
  // its session digest — is spared, which is the whole point of "others".
  // Present by construction (requireAuth resolved a session from it); guarded
  // so a missing token cannot fall through to tearing down the caller's own.
  if (token) {
    await revokeConnectionForSessions(deps, auth.userId, {
      exceptDigest: sessionTokenDigest(token),
    });
  }
  deps.log('other_sessions_revoked', {
    userRef: userRefForLog(auth.userId, deps.userRefSalt),
    revoked,
  });
  return json(200, { revoked });
};
