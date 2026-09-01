import type { DataLayer } from '../db/data.js';

/**
 * The WebSocket session guard: is the session
 * behind this digest still live?
 *
 * Revoking a session deletes the connection row and best-effort disconnects
 * the socket — but a socket can outlive that: the DeleteConnection is
 * in-flight, throttled, or lands after a frame the socket already sent, and on
 * a host with no management channel wired there is no proactive disconnect at
 * all. So the socket's OWN frames — and every live delivery and drain slice
 * aimed at it — are checked against the session that opened it.
 *
 * ASYMMETRIC BY DESIGN, because the two verdicts carry different risk:
 *
 * - "inactive" is MONOTONIC. A session row is only ever created whole and
 * deleted — `createSession` is its sole writer and nothing extends
 * `expiresAt` — and a digest is SHA-256 over 32 fresh random bytes, so a
 * digest once observed gone-or-expired can never legitimately answer
 * "active" again. Caching a negative is therefore fail-CLOSED at any TTL.
 * Entries are held for `NEGATIVE_CACHE_MS` purely to bound memory; losing
 * one costs a single re-read that observes "inactive" again.
 *
 * - "active" is NOT monotonic — it is falsified by the very revocation this
 * guard enforces. The first shape of this cache held positives for 60 s,
 * which read back as: a session revoked at T kept SENDING and RECEIVING as
 * the victim for up to a minute after "sign out" answered 200. That window
 * was the price of keeping a sessions GetItem off the hot send path
 * and it was the wrong trade for a security product — the moment
 * revocation matters most is right after a device is stolen, which is
 * exactly when a minute is an eternity. Positives are now NEVER cached:
 * every `active` call for a live session is one strongly consistent
 * point GetItem (`getSessionByDigest`).
 *
 * WORST-CASE EXPOSURE, stated exactly: once a revoke's session delete
 * commits, the next guarded action re-reads and refuses. The only frames a
 * revoked session can still land are those already past the guard when the
 * delete committed — bounded by requests concurrently in flight (single
 * milliseconds of handler latency), not by any policy window. That residue is
 * irreducible under ANY per-frame check-then-act design and is the bound we
 * accept. The one path that checks on a cadence instead of per action states
 * its own bound where it does it: a drain slice re-checks every
 * `DRAIN_SESSION_RECHECK_MS` (5 s — handlers/ws.ts), so a socket revoked
 * mid-drain receives for at most ~5 s more.
 *
 * WHAT THE READ COSTS, so the trade is auditable in arithmetic rather
 * than vibes: the wsSend limiter caps a socket at 5 frames/s sustained
 * (LIMITS.wsSend), so this adds at most 5 strongly consistent GetItems/s per
 * flat-out socket — ~432k reads/day ≈ $0.05/day at on-demand pricing — plus
 * one read per live delivery, on a send path already making ~5 sequential
 * DynamoDB calls. ~2–5 ms of added latency per frame buys the end of the
 * revocation window. Correctness outranks a GetItem here.
 */

/** How long an observed-inactive digest is remembered before the entry is
 * dropped (memory bound only — NOT a correctness window; see above). */
export const NEGATIVE_CACHE_MS = 60 * 60 * 1000;

/** Hard cap on remembered negatives per container. Each entry requires a
 * digest that actually reached a frame or a delivery — a real, once-valid
 * connection — so the cap is generous; evicting the oldest merely re-prices
 * its next probe at one read. */
const MAX_NEGATIVE_ENTRIES = 4096;

export interface SessionGuard {
  /**
   * Is the session behind this digest still live at `nowMs`? A positive
   * answer is freshly read every time (strongly consistent); a negative
   * answer may be served from the monotonic negative cache. Deliberately
   * keyed by DIGEST, because that is what the socket carries — the plaintext
   * token never rides a frame.
   */
  active(sessionDigest: string, nowMs: number): Promise<boolean>;
}

/**
 * A session guard over one DataLayer. Module-scoped by both hosts (like the
 * management clients and the rate limiter) so the negative cache spans warm
 * invocations rather than resetting every call.
 */
export function makeSessionGuard(db: DataLayer): SessionGuard {
  // digest -> epoch ms after which the remembered negative is dropped.
  const inactive = new Map<string, number>();

  return {
    async active(sessionDigest, nowMs) {
      const evictAtMs = inactive.get(sessionDigest);
      if (evictAtMs !== undefined) {
        if (nowMs < evictAtMs) return false;
        inactive.delete(sessionDigest);
      }
      const session = await db.getSessionByDigest(sessionDigest);
      // Gone OR expired is inactive — the guard subsumes the 30-day TTL, so a
      // socket cannot outlive its session's natural end either.
      const live = session !== undefined && session.expiresAt >= Math.floor(nowMs / 1000);
      if (!live) {
        if (inactive.size >= MAX_NEGATIVE_ENTRIES) {
          // Maps iterate in insertion order; dropping the oldest is enough.
          const oldest = inactive.keys().next().value;
          if (oldest !== undefined) inactive.delete(oldest);
        }
        inactive.set(sessionDigest, nowMs + NEGATIVE_CACHE_MS);
      }
      return live;
    },
  };
}
