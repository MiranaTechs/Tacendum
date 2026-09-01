import { createHash } from 'node:crypto';
import type { UserRecord } from './db/data.js';
import type { Deps } from './handlers/http.js';
import { activityActorRef } from './opaque-ref.js';

const ACTIVITY_TTL_SECONDS = 35 * 24 * 3600;
const ACTIVITY_TOMBSTONE_TTL_SECONDS = 5 * 60;

export const ACTIVITY_TOUCH_TIMEOUT_MS = 500;

export interface ActivityRecord {
  actorHash: string;
  activityDay: string;
  activityHourActor: string;
  expiresAt: number;
}

export interface ActivityTombstone {
  actorHash: string;
  expiresAt: number;
}

/**
 * The table key for whatever actor id the data layer is handed. UNSALTED on
 * purpose at THIS layer: the salting happens upstream, in `touchHumanActivity`
 * / `deleteHumanActivity`, which hand the data layer `activityActorRef(userId,
 * salt)` instead of the raw userId (domain
 * separation per a design decision — the stored key is now
 * SHA-256(HMAC-SHA256(HMAC-SHA256(salt, 'activity-key'), userId)[..16]),
 * irreversible without the server-held salt and unjoinable to the STUN and
 * log ref spaces, which derive under their own keys — opaque-ref.ts). Was:
 * SHA-256 of the raw userId — deterministic, so anyone compelling this table
 * plus the users table could hash every known userId and join.
 *
 * METRICS DISCONTINUITY, stated plainly: rows written before the salting are
 * keyed under the old unsalted hash and are not addressable under the new
 * key. They age out on the 35-day TTL. Until they do, a user active across
 * the transition counts as TWO actors, so DailyActiveUsers /
 * WeeklyActiveUsers / MonthlyActiveUsers (usage-metrics.ts) read high — a
 * one-time hump that drains over ≤35 days. Deletion of the OLD rows on
 * account delete is likewise not possible without the old key; they die on
 * the same TTL.
 */
function actorHash(actorId: string): string {
  return createHash('sha256').update(actorId).digest('hex');
}

export function activityRecord(userId: string, nowMs: number): ActivityRecord {
  const hash = actorHash(userId);
  const hour = new Date(nowMs).toISOString().slice(0, 13);
  return {
    actorHash: hash,
    activityDay: hour.slice(0, 10),
    activityHourActor: `${hour}#${hash}`,
    expiresAt: Math.floor(nowMs / 1000) + ACTIVITY_TTL_SECONDS,
  };
}

export function activityTombstone(userId: string, nowMs: number): ActivityTombstone {
  return {
    actorHash: actorHash(userId),
    expiresAt: Math.floor(nowMs / 1000) + ACTIVITY_TOMBSTONE_TTL_SECONDS,
  };
}

export async function touchHumanActivity(
  user: UserRecord | undefined,
  deps: Pick<Deps, 'db' | 'log' | 'now' | 'userRefSalt'>,
  signal?: AbortSignal,
): Promise<void> {
  if (!user || user.accountClass === 'integration') return;
  if (!deps.userRefSalt) {
    // Fail open, counted: activity is telemetry, and the opaque-ref posture
    // is that no ref is ever computed without its key (turn.ts answers
    // turn_unavailable in the same state). Writing the raw or unsalted id
    // instead would be the leak this fix removes. The count makes a
    // deployment that is silently losing its DAU/WAU/MAU findable — on the
    // WebSocket adapter this requires TURN_USER_SALT_ARN, which infra wires
    // alongside the turn context (tacendum-stack.ts).
    deps.log('activity_touch_skipped_unsalted');
    return;
  }
  const ownedSignal = signal ?? AbortSignal.timeout(ACTIVITY_TOUCH_TIMEOUT_MS);
  try {
    await deps.db.touchActivity(activityActorRef(user.userId, deps.userRefSalt), deps.now(), ownedSignal);
  } catch {
    deps.log('activity_touch_failed');
  }
}

/**
 * The deletion mirror of `touchHumanActivity`, and the ONLY other producer of
 * the activity table's actor id — both live in this module so the keying can
 * never diverge. Callers (account deletion, integration revoke) used to call
 * `db.deleteActivity(userId, ...)` directly; routed here so the tombstone
 * lands under the same salted key the touch wrote.
 */
export async function deleteHumanActivity(
  userId: string,
  deps: Pick<Deps, 'db' | 'log' | 'now' | 'userRefSalt'>,
): Promise<void> {
  if (!deps.userRefSalt) {
    // Without the salt the rows cannot be addressed at all — they are keyed
    // by the salted id — so nothing that was written salted is reachable to
    // erase. Counted for the same reason as the touch skip; the rows this
    // leaves behind die on the 35-day TTL.
    deps.log('activity_delete_skipped_unsalted');
    return;
  }
  await deps.db.deleteActivity(activityActorRef(userId, deps.userRefSalt), deps.now());
}
