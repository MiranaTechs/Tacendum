import type { Deps } from './http.js';

/**
 * Tear down the live WebSocket a revoked session opened.
 *
 * There is one connection row per account. When sessions are revoked, this
 * reads that row and — if it belongs to a session that was just revoked —
 * deletes it (stopping all inbound routing to the socket) and best-effort
 * disconnects the transport (stopping the socket from sending before its own
 * `$default` recheck fires).
 *
 * The socket→session binding is the `sessionDigest` the connection row carries
 * (written at `$connect` from the ticket that opened it). The three shapes of
 * revocation ask three different questions of it:
 *
 * - `onlyDigest` — "this exact session signed out" (`DELETE /v1/session`).
 * Tear the socket down only if it is the one THIS session opened; a socket
 * another session holds is untouched.
 * - `exceptDigest` — "everything but me" (`DELETE /v1/sessions/others`, and a
 * new sign-in superseding the old). Tear the socket down unless it is the
 * caller's own.
 * - neither — "all of them" (account deletion). Tear it down unconditionally.
 *
 * A row with no `sessionDigest` is torn down by EVERY shape, `onlyDigest`
 * included. Every legitimately-written row carries the digest of the session
 * that opened it (digestless dials are refused — ws.ts), so a digestless
 * row cannot be another live session's socket: it is a socket no revocation
 * could ever match, and the safe direction for a revoke is to close what it
 * cannot vouch for, not to leave the one unrevocable socket standing.
 *
 * `deleteConnection` is conditional on the connectionId, so a reconnect racing
 * the revoke keeps its fresh row. The transport disconnect is best-effort and
 * never throws into the caller — a revoke's success is the session row being
 * gone, which the caller already did.
 */
export async function revokeConnectionForSessions(
  deps: Deps,
  userId: string,
  match: { onlyDigest?: string; exceptDigest?: string } = {},
): Promise<void> {
  const conn = await deps.db.getConnection(userId);
  if (!conn) return;

  if (match.onlyDigest !== undefined && conn.sessionDigest !== undefined) {
    // Sign out THIS session: only its own socket goes — except a digestless
    // row, which cannot be ANY live session's socket and always goes.
    if (conn.sessionDigest !== match.onlyDigest) return;
  } else if (match.exceptDigest !== undefined) {
    // Everything but the caller's: a socket whose digest IS the caller's
    // survives; anything else (including an unmatchable legacy row) goes.
    if (conn.sessionDigest === match.exceptDigest) return;
  }

  await deps.db.deleteConnection(userId, conn.connectionId);
  if (deps.disconnectSocket === undefined) {
    // FIRST-USE LOUDNESS (part 3): this revoke needed the transport hang-up
    // and the host has none wired. On AWS that means the HTTP/Auth function
    // is missing `WS_API_DOMAIN`/`WS_API_STAGE` (aws/deps.ts) — a production
    // deployment should never see this line (WS_DISCONNECT_REQUIRED=1 makes
    // the absence fatal at cold start), so its appearance is an alarm, not
    // telemetry. Enforcement still holds: the row above is gone, and the
    // per-frame session guard refuses the socket's next frame and its next
    // delivery (session-guard.ts states the residual bound).
    deps.log('ws_disconnector_unwired', { missing: 'WS_API_DOMAIN,WS_API_STAGE' });
    return;
  }
  try {
    await deps.disconnectSocket(conn.connectionId);
  } catch {
    // Best-effort: the row is already gone, which stops inbound routing, and
    // the socket's own recheck stops it sending. A failed hang-up is not the
    // caller's problem.
    deps.log('ws_disconnect_on_revoke_failed');
  }
}
