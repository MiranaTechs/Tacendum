import { ConsentWriteRequest, Ulid } from '@tacendum/shared';
import { LIMITS } from '../ratelimit.js';
import {
  errorResult,
  parseJson,
  rateLimitedResult,
  type AuthedHandler,
} from './http.js';

/**
 * Pairwise consent edges: the authenticated human
 * writes and deletes the directed (self -> agent) edge that the ws send,
 * inbox and typing arms enforce. Two routes, and deliberately NOTHING else:
 *
 * - THERE IS NO READ ROUTE. Nobody — not the edge's own writer, not
 * the agent's owner — can list who consented to what. The machine.ts
 * stance (the server refuses crew enumeration even to the owner) extends
 * to this table verbatim: a client that wants to render its own consents
 * keeps its own record of the answers it received, exactly as
 * machine_peers records adopt answers. The storage shape backs this up —
 * no index exists to serve the query (shared/src/tables.ts).
 *
 * - THE WRITE ANSWERS A UNIFORM 204 for ANY well-formed ULID:
 * success, nonexistent target, non-integration target, self, and
 * over-cap are indistinguishable on the wire — in bytes AND in time,
 * because the target row is never read: an inert edge is cheaper and
 * quieter than a validated one, and the ws predicate re-reads both live
 * rows fail-closed at every enforcement point anyway. (One inert shape
 * is also never STORED: a self-edge — decided by comparing the caller's
 * own two values, no read, same 204 — because it could only ever burn a
 * cap slot.) The ONLY distinguishable refusal is the quota's 429, taken
 * FIRST (the intsend quota-before-anything precedent) so each probe of
 * the non-oracle still costs a token. Over-cap is therefore SILENTLY
 * LOSSY — the accepted price of uniformity,
 * documented in shared/src/consent.ts, never
 * "fixed" with a distinguishable answer.
 *
 * - DELETION IS EQUALLY UNIFORM: any well-formed ULID answers 204 whether
 * or not an edge existed. Its quota is SEPARATE and roomier (the
 * sessionRevoke reasoning): revocation is the panic action, and a caller
 * who just drained their write budget experimenting must not find the
 * one control that stops delivery rate-limited behind it.
 *
 * The caller-side refusals below (integration-class caller, deleted caller)
 * are about the CALLER, whose class the caller already knows — they answer
 * nothing about any target and so cost the uniformity nothing. An
 * integration writing consent edges would be an injectable node minting
 * authorization state ('s rule, one hop over), and although the
 * ws predicate's human-class guard makes such an edge inert, the write is
 * refused loudly so the mistake is learned at develop time.
 *
 * The log lines carry the OUTCOME and no parties — an improvement on the
 * crew_adopted precedent (which retains opaque refs of both ends): the
 * consent graph's parties never enter the retained log at all.
 */

// POST /v1/consent -> 204 (uniform)
export const consentWriteHandler: AuthedHandler = async (event, deps, auth) => {
  // Quota FIRST, before the body is even parsed: the refusal it prices is
  // the one distinguishable answer this route has.
  const retry = await deps.rateLimit.take(`consent:${auth.userId}`, LIMITS.consentWrite);
  if (retry > 0) return rateLimitedResult(retry);

  const parsed = parseJson(event, ConsentWriteRequest);
  if (!parsed.ok) return parsed.result;
  const agent = parsed.data.agent;

  // The caller reads (defence in depth — see the header). They sit BEFORE
  // the write and do not vary by target.
  const caller = await deps.db.getUserById(auth.userId);
  if (!caller) {
    return errorResult(403, 'unknown_owner', 'caller does not resolve to an account');
  }
  if (caller.accountClass === 'integration') {
    return errorResult(
      403,
      'integration_forbidden',
      'an integration can never write consent edges',
    );
  }

  // A SELF-edge is never stored: it can
  // admit nothing (consentAdmits needs a human AND an integration on one
  // row — one account cannot be both), so storing it only burned one of the
  // 16 cap slots on a row no predicate can ever read. binds the
  // ANSWER, not the storage: the 204 below is byte-identical, and the
  // comparison consults only the caller's own two values — the target row
  // is still never read, so nothing about any OTHER account is taught in
  // bytes or in time. (The caller's own id is the one target a caller
  // cannot learn anything about.)
  const outcome =
    agent === auth.userId
      ? ('self' as const)
      : await deps.db.writeConsentEdge(auth.userId, agent, deps.now());
  // Outcome only, NO parties (the header's stance): the retained
  // log must not become the consent graph the route refuses to serve.
  deps.log('consent_write', { outcome });
  // written | already | cap_reached | contended | self — ONE answer.
  // The over-cap loss is silent by design (and since the cap counts per
  // GROUP); 'contended' is a lost count pin, equally
  // silent and retryable. The log line above is the operator's only window.
  return { statusCode: 204 };
};

// DELETE /v1/consent/{agentId} -> 204 (uniform; the deletion half)
export const consentDeleteHandler: AuthedHandler = async (event, deps, auth) => {
  const retry = await deps.rateLimit.take(`consentdel:${auth.userId}`, LIMITS.consentDelete);
  if (retry > 0) return rateLimitedResult(retry);

  const agent = event.pathParameters?.agentId;
  // Shape refusal, not an oracle: a malformed path is the caller's own
  // request being malformed, the same 400 every route answers — and the
  // ULID gate is also what keeps the `#count` control key unaddressable.
  if (!agent || !Ulid.safeParse(agent).success) {
    return errorResult(400, 'invalid_request', 'agentId must be a ULID');
  }

  const caller = await deps.db.getUserById(auth.userId);
  if (!caller) {
    return errorResult(403, 'unknown_owner', 'caller does not resolve to an account');
  }
  if (caller.accountClass === 'integration') {
    return errorResult(
      403,
      'integration_forbidden',
      'an integration can never write consent edges',
    );
  }

  await deps.db.deleteConsentEdge(auth.userId, agent);
  deps.log('consent_delete');
  // Existed or not: 204 either way — deletion teaches nothing about what
  // was there and the next send is refused (the semantic, carried
  // by hasConsentEdge's strongly consistent read).
  return { statusCode: 204 };
};
