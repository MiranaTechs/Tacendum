import { CREW_MAX_MEMBERS, CrewAdoptRequest } from '@tacendum/shared';
import { LIMITS } from '../ratelimit.js';
import { userRefForLog } from '../opaque-ref.js';
import {
  errorResult,
  parseJson,
  rateLimitedResult,
  type AuthedHandler,
  type HttpResult,
} from './http.js';

/**
 * Crew adoption.
 *
 * One route, and it is OWNER-called — the mirror image of the bind in
 * integrations.ts, and the asymmetry is again the design:
 *
 * - BIND is called by the INTEGRATION, because only it knows when the human
 * has handed over their code.
 * - ADOPT is called by the OWNER, because adoption is an ADMISSION decision:
 * it grants the member reachability to every other crew member. The parent
 * of an integration is a language model, and an injectable node can never
 * be an admission authority — so no integration ever admits
 * another, however it is prompted.
 *
 * The integration-class refusal below is defence in depth: adoptCrewMember's
 * owner-side condition (`attribute_not_exists(accountClass)`) already refuses
 * an integration-class owner inside the transaction, so a bug here widens
 * nothing. The handler still refuses explicitly so the caller gets a clear
 * 403 naming the rule, not a transaction cancellation dressed up as one.
 *
 * The crewId is minted HERE, server-side (deps.newUserId — a ULID), and used
 * only when the owner has no crew yet: a client-chosen scope is a scope an
 * attacker can choose.
 */

/**
 * Crew outcomes with no honest ApiErrorCode: `cap_reached` and
 * `crew_contended` are crew vocabulary, and dto.ts — the enum's home — is
 * deliberately untouched. Emitted locally in the same
 * `{ error: { code, detail } }` shape every other error uses; they join
 * ApiErrorCode when a client-lane change needs to parse them.
 */
type CrewErrorCode = 'cap_reached' | 'crew_contended';

function crewErrorResult(
  statusCode: number,
  code: CrewErrorCode,
  detail: string,
  headers: Record<string, string> = {},
): HttpResult {
  return {
    statusCode,
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ error: { code, detail } }),
  };
}

// POST /v1/crew/adopt -> 204
export const crewAdoptHandler: AuthedHandler = async (event, deps, auth) => {
  // Limit first, as bind does: probing this route costs a token before it
  // answers anything.
  const retry = await deps.rateLimit.take(`crewadopt:${auth.userId}`, LIMITS.crewAdopt);
  if (retry > 0) return rateLimitedResult(retry);

  const parsed = parseJson(event, CrewAdoptRequest);
  if (!parsed.ok) return parsed.result;
  const member = parsed.data.member;

  if (member === auth.userId) {
    return errorResult(400, 'invalid_request', 'an owner cannot adopt themselves');
  }

  // Defence in depth (see the header): the transaction refuses an
  // integration-class owner too; this read exists so the refusal arrives as
  // the rule and not as a cancelled transaction. It sits BEFORE the member
  // lookup so an integration cannot use this route's 404 as an
  // account-existence oracle.
  const caller = await deps.db.getUserById(auth.userId);
  if (!caller) {
    // Authenticated but gone: a partially-deleted account's token can outlive
    // its row. There is no owner to adopt into.
    return errorResult(403, 'unknown_owner', 'caller does not resolve to an account');
  }
  if (caller.accountClass === 'integration') {
    return errorResult(403, 'integration_forbidden', 'an integration can never adopt crew members');
  }

  // getUserById already refuses claim-prefixed ids, exactly as the send path
  // does.
  const memberRow = await deps.db.getUserById(member);
  if (!memberRow) {
    return errorResult(404, 'not_found', 'no such account');
  }

  const outcome = await deps.db.adoptCrewMember(auth.userId, member, deps.newUserId());
  switch (outcome) {
    case 'adopted':
    case 'already':
      // BOTH ends of the ownership edge as opaque refs (this line used to
      // put the owner→member edge in raw ULIDs into a
      // 3-month log). The crewId itself stays out of the retained log — it
      // is a scope handle, and nothing about operating the crew requires
      // logging it.
      deps.log('crew_adopted', {
        ownerRef: userRefForLog(auth.userId, deps.userRefSalt),
        memberRef: userRefForLog(member, deps.userRefSalt),
      });
      return { statusCode: 204 };
    case 'cap_reached':
      return crewErrorResult(
        409,
        'cap_reached',
        `crew is full (max ${CREW_MAX_MEMBERS}); revoke a member to free a slot`,
      );
    case 'not_integration':
    case 'owner_conflict':
    case 'crew_conflict':
      // ONE code for "not an integration", "bound to someone else", and "in
      // someone else's crew" — the same collapse the revoke handler makes:
      // distinguishing them would let any authenticated caller probe which
      // ids are integrations and whose they are.
      return errorResult(403, 'not_integration_owner', 'not an integration you own');
    case 'unknown_owner':
      // The transaction's own injectable-node rule fired: the caller's row
      // vanished (or turned integration-class) between the read above and the
      // transaction. This is the condition the handler check is the depth OF.
      return errorResult(403, 'unknown_owner', 'caller does not resolve to a human account');
    case 'crew_contended':
      // NOT a terminal refusal, and deliberately not mapped onto one: the
      // data layer already retried once, so landing here means a concurrent
      // adopt moved the owner's crewId twice — pure transient contention on
      // state the caller is allowed to write. Nothing about the REQUEST is
      // wrong; the identical call against quiet state succeeds. 503 with
      // Retry-After says exactly that, where a 4xx would teach clients to
      // give up on an adopt that would work one second later.
      return crewErrorResult(
        503,
        'crew_contended',
        'a concurrent adopt moved the crew; retry',
        { 'retry-after': '1' },
      );
  }
};
