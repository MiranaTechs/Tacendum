import { RegisterPushTokenRequest } from '@tacendum/shared';
import { LIMITS } from '../ratelimit.js';
import { errorResult, parseJson, rateLimitedResult, type AuthedHandler } from './http.js';

/**
 * VoIP push-token registration.
 *
 * A device token is the capability to make someone's phone ring, so this
 * surface is deliberately minimal and **write-only**: a client can write and
 * delete exactly one row — its own — and there is NO read route at all. A
 * readable token store would be a harvesting primitive, and nothing in the
 * system needs to read a token except the push sender, which runs server-side.
 *
 * One row per user: multi-device is out of scope. When it arrives this gains a
 * deviceId sort key, which is an additive change.
 */

/** A token nobody has refreshed in a quarter belongs to an app that is gone.
 * The client re-PUTs on every launch, so this only reaps the dead. */
const TOKEN_TTL_SECONDS = 90 * 24 * 3600;

// PUT /v1/push-token -> 204
export const registerPushTokenHandler: AuthedHandler = async (event, deps, auth) => {
  const retry = await deps.rateLimit.take(`push-token:${auth.userId}`, LIMITS.pushToken);
  if (retry > 0) return rateLimitedResult(retry);

  // Integration accounts have no phone to wake and no business holding a
  // wake capability: a notifier that can register a
  // push token is a notifier that can be made to ring something.
  const caller = await deps.db.getUserById(auth.userId);
  if (caller?.accountClass === 'integration') {
    return errorResult(403, 'integration_forbidden', 'integrations cannot register push tokens');
  }

  const parsed = parseJson(event, RegisterPushTokenRequest);
  if (!parsed.ok) return parsed.result;

  // ANDROID: one FCM token serves both wake lanes,
  // so this branch is a plain replace with no merge — there is no second
  // token whose racing PUT the iOS merge below exists to protect. No `env`
  // is stored because FCM has no sandbox/production host split; the row is
  // keyed by the AUTHENTICATED userId exactly as below, and the platform
  // discriminator is what routes it to the FCM lane instead of APNs
  // (push/route.ts).
  if (parsed.data.platform === 'android') {
    await deps.db.mergePushToken({
      userId: auth.userId,
      platform: 'android',
      fcmToken: parsed.data.fcmToken,
      bundleId: parsed.data.bundleId,
      updatedAt: deps.now(),
      expiresAt: Math.floor(deps.now() / 1000) + TOKEN_TTL_SECONDS,
    });
    // Platform only — the token itself is never logged, same as the
    // iOS arm below.
    deps.log('push_token_registered', { platform: 'android' });
    return { statusCode: 204 };
  }

  // A REGISTRATION NEVER DOWNGRADES THE ROW. The client's first upload of a
  // launch races APNs: the alert token lands a beat after the permission
  // prompt resolves, so launches routinely register the VoIP token alone —
  // and a whole-row replace was ERASING the alert token the previous session
  // had registered. Notifications that worked exactly once, then never.
  //
  // The merge is a single conditional UpdateItem, NOT a read-then-write. The
  // first version read the row here and 500'd in production: this handler's
  // role deliberately holds no GetItem on the token table — a token is the
  // capability to ring a phone, and the register path has no business
  // reading anyone's. The UpdateItem shape keeps that posture (it is a
  // write-class operation), and as a bonus it is atomic, so two rotations
  // racing cannot resurrect each other's stale halves.
  //
  // The row is keyed by the AUTHENTICATED userId and never by anything in
  // the body — the request has no userId field, and adding one would be the
  // whole vulnerability. This is the only place the key is chosen.
  await deps.db.mergePushToken({
    userId: auth.userId,
    ...(parsed.data.voipToken ? { voipToken: parsed.data.voipToken } : {}),
    ...(parsed.data.alertToken ? { alertToken: parsed.data.alertToken } : {}),
    env: parsed.data.env,
    bundleId: parsed.data.bundleId,
    updatedAt: deps.now(),
    expiresAt: Math.floor(deps.now() / 1000) + TOKEN_TTL_SECONDS,
  });

  // Environment only. The token itself is never logged: log access
  // must not become the ability to ring someone's phone.
  deps.log('push_token_registered', { platform: 'ios', env: parsed.data.env });
  return { statusCode: 204 };
};

// DELETE /v1/push-token -> 204
export const deletePushTokenHandler: AuthedHandler = async (_event, deps, auth) => {
  const retry = await deps.rateLimit.take(`push-token:${auth.userId}`, LIMITS.pushToken);
  if (retry > 0) return rateLimitedResult(retry);

  // Idempotent: logout may retry, and "there was nothing to delete" is the
  // same successful outcome as "there was". Never reveals which it was.
  await deps.db.deletePushToken(auth.userId);
  deps.log('push_token_deleted');
  return { statusCode: 204 };
};
