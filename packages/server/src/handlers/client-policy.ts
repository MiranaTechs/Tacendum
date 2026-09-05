import type { ClientPolicyResponse } from '@tacendum/shared';
import { LIMITS } from '../ratelimit.js';
import { rateLimitedResult, type Handler, type HttpResult } from './http.js';

/**
 * How long a client may treat this answer as current. Five minutes is the
 * span between "an operator raised the floor" and "the last cached phone
 * learns of it", and it is bounded on the other side by the fact that a phone
 * asks at most three times a day anyway: a shorter TTL would buy no reaction
 * time worth the requests.
 */
const CACHE_SECONDS = 300;

/**
 * `TACENDUM_MIN_BUILD_IOS` / `TACENDUM_MIN_BUILD_ANDROID`, read the way
 * `sourceOfferUrl` reads its own variable (handlers/auth-account.ts): a value
 * that is absent or does not parse is not an error, it is no floor.
 *
 * A PLAIN DECIMAL INTEGER and nothing else. `Number()` alone would accept
 * '1e3', '0x19', ' ' (zero) and '25.5'. Every one of them is a value an operator
 * meant as something and would get as something else, on a variable whose job
 * is to lock a fleet out of its own workspace.
 */
function envMinBuild(raw: string | undefined): number {
  const trimmed = raw?.trim();
  if (!trimmed || !/^\d+$/.test(trimmed)) return 0;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) ? value : 0;
}

export function envClientPolicy(env: NodeJS.ProcessEnv = process.env): ClientPolicyResponse {
  return {
    ios: { minBuild: envMinBuild(env.TACENDUM_MIN_BUILD_IOS) },
    android: { minBuild: envMinBuild(env.TACENDUM_MIN_BUILD_ANDROID) },
  };
}

/**
 * `GET /v1/client-policy`: the minimum build we serve.
 *
 * WHY IT IS UNAUTHENTICATED. The question is asked before there is anybody to
 * ask it: at the landing screen, before registration, on a phone with no
 * account. Requiring a token would leave the one client that most needs the
 * answer, a build too old to be trusted with a workspace, unable to get it.
 *
 * WHAT THAT COSTS, stated plainly: this route discloses the minimum build we
 * accept, to anyone who asks. It is the same sentence for every caller, it
 * varies with nothing about the caller, and it is a number we intend to put
 * on the App Store anyway. It takes NO identifier in, returns none, and logs
 * none.
 *
 * THE ONE PER-CALLER FACT IS THE SOURCE IP, AND IT IS STORED. The bucket
 * below is not an in-memory counter in production: `makeDdbRateLimiter`
 * (ratelimit-ddb.ts) writes `clientPolicy:<sourceIp>#<windowStart>` as the
 * PARTITION KEY of a row in the rate-buckets table, holding a count and a
 * TTL of the window's end plus an hour. So for roughly an hour past each
 * minute in which a phone asked, the table durably records that SOME caller
 * at that address asked, and how often. That is exactly the retention and
 * exactly the shape the auth per-IP buckets already carry
 * (`auth:<sourceIp>`, handlers/auth-account.ts), and it is disclosed in
 * docs/§3.3 beside them. Nothing else on this path holds the
 * address: it is never logged, never in the body, and never joined to an
 * account, because there is no account here to join it to.
 *
 * FAIL OPEN, EVERY WAY. An absent row, a malformed row and an unparseable env
 * value all answer a zero floor. The failure mode being avoided is the one
 * that cannot be recovered from a console: a typo that locks an installed
 * fleet out of its own messages, with no OTA path to take it back.
 */
export const clientPolicyHandler: Handler = async (event, deps) => {
  // Per-IP, because there is no principal. The route-level API
  // Gateway throttle in the stack is the aggregate half of the same ceiling;
  // neither alone is enough, since one is per-caller and blind to the fleet
  // and the other is per-fleet and blind to the caller.
  const retry = await deps.rateLimit.take(
    `clientPolicy:${event.sourceIp ?? 'unknown'}`,
    LIMITS.clientPolicy,
  );
  if (retry > 0) return rateLimitedResult(retry);

  // The ROW WINS whenever it is well formed, and `getClientPolicy` already
  // answers `undefined` for both "absent" and "malformed", so the env is the
  // fallback for a deploy that has no row yet, never a second opinion layered
  // over one that does.
  // With neither, `envClientPolicy` answers a zero floor on both platforms,
  // which gates nothing. That is the shipped default.
  const body: ClientPolicyResponse = (await deps.db.getClientPolicy()) ?? envClientPolicy();

  // NOT `json()`: that helper hands every caller one FROZEN headers object, so
  // this route's own Cache-Control has to be built here rather than added to
  // the shared one.
  const result: HttpResult = {
    statusCode: 200,
    headers: { 'content-type': 'application/json', 'cache-control': `max-age=${CACHE_SECONDS}` },
    body: JSON.stringify(body),
  };
  // No log line, deliberately. See the header comment: there is nothing to
  // record here that is both true of one caller and allowed to be written
  // down.
  return result;
};
