import { IntegrationBindRequest, Ulid } from '@tacendum/shared';
import { LIMITS } from '../ratelimit.js';
import { deleteHumanActivity } from '../activity.js';
import { userRefForLog } from '../opaque-ref.js';
import { errorResult, parseJson, rateLimitedResult, type AuthedHandler } from './http.js';

/**
 * Integration-account lifecycle.
 *
 * Two routes with two different callers, and the asymmetry is the design:
 *
 * - BIND is called by the INTEGRATION, once, because only it knows when the
 * human has handed over their code (`tacendum pair <code>`). It is
 * write-once: an integration that could re-point itself at a new owner
 * would turn a stolen CI credential into a redirection primitive.
 * - REVOKE is called by the OWNER, because revocation is the theft response
 * and the thief holds the integration's own credentials. The owner's app
 * knows the integration's userId as the `from` of its chat — which is why
 * there is deliberately no owner→integrations index (no directory, no
 * Query on the users table).
 *
 * Revocation tombstones the identity key: session revocation alone is not a
 * revocation at all here, because the key on the stolen machine can sign a
 * fresh challenge and mint a new token at will. Self-service teardown
 * stays on DELETE /v1/account and does NOT tombstone — a voluntarily deleted
 * integration's key may register again, starting unbound.
 */

// POST /v1/integrations/bind -> 204
export const integrationBindHandler: AuthedHandler = async (event, deps, auth) => {
  const retry = await deps.rateLimit.take(`intbind:${auth.userId}`, LIMITS.integrationBind);
  if (retry > 0) return rateLimitedResult(retry);

  const parsed = parseJson(event, IntegrationBindRequest);
  if (!parsed.ok) return parsed.result;
  const owner = parsed.data.owner;

  if (owner === auth.userId) {
    return errorResult(400, 'invalid_request', 'an integration cannot own itself');
  }

  // The owner must resolve to a LIVE account. getUserById already refuses
  // claim-prefixed ids, exactly as the send path does; a TOMBSTONED row (a
  // revoked-lost/stolen device) answers the same 404 a never-existing ULID
  // draws — a dead device must never re-acquire an agent, and the refusal
  // must not distinguish "revoked" from "never existed" to the caller.
  // This read is UX; the racing half is the owner
  // liveness ConditionCheck inside bindIntegrationOwner's transaction.
  const ownerRow = await deps.db.getUserById(owner);
  if (!ownerRow || ownerRow.tombstoned === true) {
    return errorResult(404, 'unknown_owner', 'no such account');
  }

  const outcome = await deps.db.bindIntegrationOwner(auth.userId, owner);
  switch (outcome) {
    case 'bound':
    case 'already':
      // Opaque ref only (this line used to carry the
      // integration's raw ULID); who owns which integration stays out of the
      // retained log entirely.
      deps.log('integration_bound', { userRef: userRefForLog(auth.userId, deps.userRefSalt) });
      return { statusCode: 204 };
    case 'owner_conflict':
      return errorResult(409, 'owner_conflict', 'already bound to a different owner');
    case 'not_integration':
      return errorResult(403, 'not_integration', 'only integration accounts bind an owner');
    case 'unknown_owner':
      // The transaction's owner-liveness pin refused (the precheck's racing
      // half): same bytes as the precheck's own 404 — the race must not mint
      // a new refusal shape.
      return errorResult(404, 'unknown_owner', 'no such account');
  }
};

// DELETE /v1/integrations/{userId} -> 204
export const integrationRevokeHandler: AuthedHandler = async (event, deps, auth) => {
  const retry = await deps.rateLimit.take(`acct-delete:${auth.userId}`, LIMITS.accountDelete);
  if (retry > 0) return rateLimitedResult(retry);

  const target = event.pathParameters?.userId;
  // A ULID or a 400: the value is a users-table key on the next line, and an
  // oversized one threw there (500). Shape refusal is not an oracle — it is
  // the caller's own request being malformed.
  if (!target || !Ulid.safeParse(target).success) {
    return errorResult(400, 'invalid_request', 'integration userId must be a ULID');
  }

  const row = await deps.db.getUserById(target);
  if (!row) {
    // A COMPLETED revoke also lands here on repeat, indistinguishable from a
    // never-existing id (the claim row is keyed by identity key, which died
    // with the user row). 404 is honest for both. The idempotency that is
    // actually load-bearing — retrying a crash mid-revoke — works because the
    // user row is deleted LAST: a partial revoke still resolves here and
    // re-runs every step.
    return errorResult(404, 'not_found', 'no such integration');
  }
  if (row.accountClass !== 'integration' || row.ownerUserId !== auth.userId) {
    // One code for "not an integration" and "not yours": distinguishing them
    // would let any authenticated caller probe which ids are integrations.
    return errorResult(403, 'not_integration_owner', 'not an integration you own');
  }

  // Tombstone FIRST. A revoke racing the stolen key's re-auth must lose at
  // the claim row — after this line the key cannot mint anything, and every
  // later step is cleanup. Each step is idempotent; a crash mid-way is
  // finished by the retry.
  if (row.identityKeyPub !== undefined) {
    await deps.db.tombstoneIdentityKey(row.identityKeyPub);
  }
  // Routed through activity.ts so the tombstone is keyed under the same
  // salted actor id a touch would have written. For an
  // integration account this is belt-and-braces — integrations are skipped
  // by the touch — but the keying must have exactly one producer.
  await deleteHumanActivity(target, deps);
  await deps.db.deleteSessionsForUser(target);
  await deps.db.deleteOneTimePrekeys(target);
  await deps.db.purgeQueuedMessages(target);
  await deps.db.deletePushToken(target);
  const connection = await deps.db.getConnection(target);
  if (connection) {
    await deps.db.deleteConnection(target, connection.connectionId);
  }
  // The user row goes LAST, and the claim row STAYS (no identityKeyPub in
  // the claim bag) — the surviving tombstoned claim is the whole point
  // Row-delete-last is what makes a crash-retry work: a partial
  // revoke still resolves the row above and re-runs every idempotent step.
  // For an ADOPTED member the row delete and the owner's slot release are ONE
  // transaction. The previous shape — unconditional delete, then a release ordered
  // "fail-closed" after it — weighed a crash between the two steps and chose
  // the burned slot, but never weighed two CONCURRENT revokes of the same
  // member: both pre-read the row above, the unconditional delete succeeded
  // twice, and both decremented — a widening past CREW_MAX_MEMBERS, the exact
  // failure the ordering thought it was avoiding. Ordering cannot fix a race
  // between two whole executions; atomicity can. The loser's transaction now
  // cancels on the member row being gone and releases nothing, which also
  // retires the crash-retry slot leak the old ordering had accepted.
  // And which branch this is cannot come from the read alone.
  // `crewId` only ever goes absent→present, so an adopt committing
  // between the read above and the delete below would send a now-adopted member
  // down the no-release path: row gone, `crewCount` never decremented, a slot
  // leaked with no ULID left to revoke it. Repeat it to the cap and the owner
  // can neither adopt nor delete their own account, permanently — which is the
  // lockout the crew-not-empty refusal assumes is unreachable. So the no-release
  // delete carries `attribute_not_exists(crewId)` and a refusal routes here to
  // the atomic path instead of riding through.
  if (row.crewId !== undefined) {
    // row.ownerUserId === auth.userId here — the 403 guard above proved it.
    await deps.db.deleteCrewMemberAndReleaseSlot(target, auth.userId);
  } else if ((await deps.db.deleteUser(target, {}, { requireNoCrewId: true })) === 'crew_appeared') {
    // Adopted in the gap. The adopt can only have bound it to THIS owner (the
    // member condition refuses a different one), so auth.userId is still the
    // right owner to credit. Bounded — a crewId is never cleared.
    await deps.db.deleteCrewMemberAndReleaseSlot(target, auth.userId);
  }

  // Opaque ref of the REVOKED integration, never its ULID.
  deps.log('integration_revoked', { userRef: userRefForLog(target, deps.userRefSalt) });
  return { statusCode: 204 };
};
