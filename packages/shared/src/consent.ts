import { z } from 'zod';
import { Ulid } from './frames.js';

/**
 * Pairwise consent edges: a human M
 * writes a server-stored DIRECTED edge (M -> A) authorizing integration A to
 * exchange frames with M. Global, never room-scoped — the server holds no
 * room object of any kind and
 * deliberately refuses to mint one. Room-scoping stays client-side.
 *
 * A NEW module rather than a section of dto.ts, on crew.ts's exact
 * precedent: shared additions land in their own module plus one barrel line,
 * so no other plan's shared file is edited.
 */

/**
 * POST /v1/consent — the authenticated human names ONE integration they are
 * choosing to share with. A bare ULID, never a URL or scheme (the standing
 * QR guardrail). ANY well-formed ULID draws a uniform
 * 204 behind a quota — success, nonexistent target, non-integration target
 * and over-cap are indistinguishable on the wire, so the route teaches
 * nothing about which accounts exist or what class they are.
 */
export const ConsentWriteRequest = z.object({
  agent: Ulid,
});
export type ConsentWriteRequest = z.infer<typeof ConsentWriteRequest>;

/**
 * How many consent edges one human may hold, enforced inside the write
 * transaction's condition — never in a handler read, so concurrent writes
 * cannot both pass (the CREW_MAX_MEMBERS precedent).
 *
 * COUNTED PER GROUP: a grouped human's slots
 * are 16 across the WHOLE device group — the write transaction sums every
 * member's own `#count` under pinned conditions, and the link transaction
 * conditions on the merged total. A solo human is the one-member sum.
 *
 * The number is a blast-radius ceiling, not a product limit: every edge lets
 * one integration deliver to this human at the integration send quota, and
 * every edge is one directed row the relay durably stores about this human's
 * associations. Sixteen covers a human sitting in several
 * agent-bearing rooms (each room adds at most a handful of agents under
 * owner-only admission) while keeping the stored graph per human
 * bounded. Raising it is a one-line change; removing it is not an option.
 *
 * THE OVER-CAP ANSWER IS STILL THE UNIFORM 204 — a distinguishable
 * "cap reached" would let a caller measure another account's... nothing,
 * actually: the cap is the CALLER's own. It stays uniform anyway because
 * uniformity is priced above ergonomics (over-cap stays
 * indistinguishable), which makes an over-cap write SILENTLY LOSSY: the
 * edge is not stored and the wire does not say so. That is the accepted price
 * of uniformity, recorded here rather than fixed
 * with a distinguishable answer. A client that must know can observe
 * delivery (the thing consent actually gates) instead of the route.
 */
export const CONSENT_MAX_EDGES = 16;
