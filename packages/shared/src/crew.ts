import { z } from 'zod';
import { Ulid } from './frames.js';

/**
 * Crew scoping: an operator's integration accounts, and only
 * the ones the operator personally adopted, may message each other and the
 * operator.
 *
 * A NEW module rather than a section of dto.ts, deliberately: shared
 * additions land in their own module plus one barrel line, so no other
 * shared file is edited.
 */

/**
 * POST /v1/crew/adopt — the owner names one of their integrations into the
 * crew. Owner-called only: adoption is an admission decision,
 * and an integration — an injectable node — can never be an admission
 * authority. A bare ULID, never a URL or scheme (the standing
 * QR guardrail).
 */
export const CrewAdoptRequest = z.object({
  member: Ulid,
});
export type CrewAdoptRequest = z.infer<typeof CrewAdoptRequest>;

/**
 * How many integrations one owner may adopt, enforced in the adopt
 * transaction's condition — not in a handler read, so concurrent adopts
 * cannot both pass.
 *
 * COUNTED PER GROUP: a grouped owner's slots
 * are 8 across the WHOLE device group — the adopt transaction sums every
 * member's own count under pinned conditions, and the link transaction
 * conditions on the merged total, so neither adoption nor linking can mint
 * a 3-device owner 24 slots. A solo owner is the degenerate one-member sum.
 *
 * The number is a blast-radius ceiling, not a product limit: every crew
 * member can message every other, so N members are N(N-1) directed channels
 * an injected one can shout down, and 8 keeps that a room rather than a
 * botnet. Raising it is a one-line change; removing it is not an option.
 */
export const CREW_MAX_MEMBERS = 8;
