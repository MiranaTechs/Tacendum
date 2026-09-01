import { LIMITS } from '../ratelimit.js';
import { deleteHumanActivity } from '../activity.js';
import { userRefForLog } from '../opaque-ref.js';
import { revokeConnectionForSessions } from './session-revoke.js';
import {
  type AuthedHandler,
  bearerToken,
  type HttpResult,
  json,
  rateLimitedResult,
} from './http.js';

/**
 * The one refusal this route makes shaped once so
 * its two emitters — the read-time check and the delete-leg backstop — cannot
 * drift apart. `crew_not_empty` is in the standard error shape but not in
 * ApiErrorCode — same deliberate deferral as `cap_reached`:
 * dto.ts is deliberately untouched here.
 */
function crewNotEmptyResult(count: number): HttpResult {
  return {
    statusCode: 409,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      error: {
        code: 'crew_not_empty',
        detail:
          `this account owns a crew with ${count} adopted member${count === 1 ? '' : 's'}; ` +
          'revoke each adopted agent by its ULID (DELETE /v1/integrations/{userId}) before deleting the account',
      },
    }),
  };
}

/**
 * DELETE /v1/account — the account stops existing: queued ciphertext purged,
 * prekey pool gone, identity key freed for a fresh registration, calling token
 * dead.
 *
 * Deletion order is content -> identity -> session, so a crash mid-way leaves
 * a still-authenticated, retryable account — never a half-dead one that can
 * no longer finish the job. Every step is idempotent (the retry re-runs all
 * of them).
 *
 * One refusal precedes all of it: a HUMAN owner holding a live crew answers
 * `409 crew_not_empty` — see the comment at the
 * check for why refusing, not cascading, is the only enforceable shape. The
 * check is enforced twice: read-time for the message and the early exit, and
 * again as a condition ON the user-row delete itself, so an adopt committing
 * between the two cannot slip an owner deletion past the refusal.
 *
 * Every session for the user goes, not just the calling one — the user index
 * added for session revocation closed the old "siblings lapse by TTL"
 * residual, which had left a deleted account reachable for up to 30 days by
 * any other token it had issued.
 *
 * A live WebSocket is torn down, not merely unrouted: its connection row
 * is deleted (stopping inbound) and its transport is best-effort disconnected,
 * and its own $default recheck refuses the moment the sessions are gone — so a
 * deleted account's socket cannot keep sending. Attachment blobs age out on the
 * bucket lifecycle; they are E2EE ciphertext whose keys died with the chats.
 */
export const deleteAccountHandler: AuthedHandler = async (event, deps, auth) => {
  const retry = await deps.rateLimit.take(`acct-delete:${auth.userId}`, LIMITS.accountDelete);
  if (retry > 0) return rateLimitedResult(retry);

  // The caller's row is read FIRST — before ANY destructive step — because a
  // human owner with a live crew must be REFUSED here, and a refusal that arrives after the queue
  // purge is not a refusal. Deleting the owner used to leave every adopted
  // member holding a dead `ownerUserId` and an intact `crewId`: member→member
  // traffic still passed the crew predicate, and NOBODY could ever revoke
  // them — revoke demands `row.ownerUserId === auth.userId`, the owner is
  // gone, and a re-registered operator mints a brand-new ULID.
  // Refuse rather than cascade, because cascade is impossible BY DESIGN:
  // there is deliberately no owner→members index and no `Query` on the users
  // table (pinned in the deployment's security tests), so the server
  // cannot enumerate a crew to tear it down. Refusing is the only enforceable
  // option, and it is honest — the operator adopted each member by ULID and
  // revokes each by ULID. Human branch only; an integration's self-delete
  // (which never owns a crew) is untouched.
  // This read is the good error message and the reason no destructive work
  // happens for an owner who plainly holds a crew — but it is a READ, and the
  // delete it gates comes later: the enforcement itself is the conditioned
  // delete leg below (`requireEmptyCrew`), which closes the gap an adopt
  // could otherwise commit into.
  const user = await deps.db.getUserById(auth.userId);
  if (user && user.accountClass !== 'integration' && (user.crewCount ?? 0) > 0) {
    return crewNotEmptyResult(user.crewCount ?? 0);
  }

  // The ROW GOES FIRST, before any purge. The
  // `requireEmptyCrew` backstop below can still refuse — and a refusal that has
  // already destroyed the caller's queued ciphertext is a 409 that ate their
  // data. Ordering it this way means a refused deletion destroys NOTHING.
  // Idempotency survives the move because sessions still go LAST (a crash
  // mid-sweep leaves the caller authenticated to re-run the sequence) and
  // because every purge below is EITHER keyed by userId alone (activity,
  // queue, consent edges, prekeys, push, code rows — the hintless retry
  // reaches all of them) OR fused into the row-delete transaction itself
  // (roster/group/claims/recovery via deleteGroupedUser; the solo path's
  // pending-recovery row via the pendingRecoveryGroupId hint:
  // hints that lived only in the deleted row must die WITH
  // the row, not after it). The one non-transactional hint-dependent walk —
  // pending link-offer rows — is physically TTL-bounded (sessions table),
  // stated below.
  if (user) {
    if (user.accountClass === 'integration') {
      if (user.identityKeyPub !== undefined) {
        // Integration self-delete TOMBSTONES the key instead of freeing it.
        // Freeing it was
        // the escape hatch from the class: a thief holding the bot's key could
        // self-delete, re-register the same key WITHOUT accountClass, and shed
        // the binding, the quota, and the owner's ability to revoke. A legit
        // teardown loses nothing — integration keys are free to mint, so "this
        // key is done" is the correct meaning of deleting the account.
        await deps.db.tombstoneIdentityKey(user.identityKeyPub);
      }
      // Which branch this is MUST NOT be decided by the read above alone.
      // `crewId` only ever goes absent→present, so an adopt
      // committing between that read and this delete would send a now-adopted
      // member down the no-release path: row gone, owner's `crewCount` never
      // decremented, slot leaked with no ULID left to revoke it. Eight of those
      // and the operator is capped out of adopting AND refused account deletion
      // forever — the exact lockout `requireEmptyCrew` assumes cannot happen.
      // So the no-release delete is CONDITIONED on the crewId still being
      // absent, and a refusal sends us to the atomic path instead.
      if (user.crewId !== undefined && user.ownerUserId !== undefined) {
        // An ADOPTED member's row delete and its owner's slot release are ONE
        // transaction: the old delete-then-release ordering let two concurrent
        // teardowns of this member both decrement — a widening past
        // CREW_MAX_MEMBERS. The transaction's attribute_exists on the member
        // row makes the release exactly-once by construction; see
        // integrations.ts for the full argument.
        await deps.db.deleteCrewMemberAndReleaseSlot(auth.userId, user.ownerUserId);
      } else if ((await deps.db.deleteUser(auth.userId, {}, { requireNoCrewId: true })) === 'crew_appeared') {
        // Adopted in the gap. Re-read for the owner the adopt just wrote, then
        // take the atomic path so the slot is released exactly once. Bounded: a
        // crewId is never cleared, so this cannot bounce back.
        const adopted = await deps.db.getUserById(auth.userId);
        if (adopted?.ownerUserId !== undefined) {
          await deps.db.deleteCrewMemberAndReleaseSlot(auth.userId, adopted.ownerUserId);
        }
      }
    } else {
      // Keyed off the account's identity key, which is the only claim namespace
      // there is now the phone is gone. Safe to
      // key off precisely because the key is IMMUTABLE and is written at account
      // birth in the same transaction as the claim — so what is read here is
      // necessarily the string the claim row is filed under. Leave the claim
      // behind and the key resolves to a user row that is gone, which its owner
      // hits as a 409 on their next sign-in.
      // `requireEmptyCrew` is the read-time check's backstop: an adopt committing between that read and this delete
      // would otherwise remove the owner row anyway and mint the exact
      // ownerless, unrevokable crew the refusal exists to prevent. Human
      // branch only — an integration never owns a crew, and its teardown
      // must never be refused over one.
      // A GROUPED member takes the FUSED path:
      // deleting one member runs that member's ordinary sweep PLUS the
      // amicable-unlink roster transaction — group row updated (epoch bump)
      // or, for the LAST member, deleted along with every identifier claim
      // its reverse list names and the pending recovery row — all ONE
      // TransactWrite with the row delete, so a crew_not_empty refusal (the
      // same backstop, riding the row's own Delete condition) still
      // destroys NOTHING, roster included. The group, its identifier
      // claims, its discovery consent, and every OTHER member survive a
      // non-last member's deletion untouched apart from the roster change.
      // NO signed notice fans out: deletion is bearer-authorized — no
      // identity key exists server-side to sign a memberUnlinked notice,
      // and clients move their rosters only on signatures verifying under
      // keys they hold — so survivors converge on the served
      // rosterVersion signals (bundle fetch, sibling sync), the
      // migration-note class.
      let plainDelete = user.groupId === undefined;
      if (user.groupId !== undefined) {
        const grouped = await deps.db.deleteGroupedUser(
          auth.userId,
          user.groupId,
          {
            ...(user.identityKeyPub !== undefined ? { identityKeyPub: user.identityKeyPub } : {}),
          },
          // The caller's clock stamps a last-exit username tombstone.
          deps.now(),
        );
        if (grouped === 'crew_not_empty') {
          // Same refusal as the solo path's, same guarantee: the fused
          // transaction cancelled whole — roster, row, and claim untouched.
          const raced = await deps.db.getUserById(auth.userId);
          return crewNotEmptyResult(Math.max(1, raced?.crewCount ?? 0));
        }
        if (grouped === 'unknown_group') {
          // The pointer dangles (the group dissolved under a raced last-exit
          // this row missed) — the ordinary solo delete reaps the row and
          // the stale groupId attribute with it.
          plainDelete = true;
        } else if (grouped === 'stale') {
          const raced = await deps.db.getUserById(auth.userId);
          if (raced === undefined) {
            // A concurrent retry of this same deletion won — row work done.
          } else if (raced.groupId === undefined) {
            // A raced unlink already took this member off the roster; the
            // row is solo now and the ordinary path finishes it.
            plainDelete = true;
          } else {
            // Contention past the bounded retry must never masquerade as
            // success or refusal (the data-layer's own transact rule): the
            // idempotent caller retries the whole deletion.
            throw new Error('account deletion: grouped roster removal contended past the bound');
          }
        }
      }
      if (plainDelete) {
        const outcome = await deps.db.deleteUser(
          auth.userId,
          {
            ...(user.identityKeyPub !== undefined ? { identityKeyPub: user.identityKeyPub } : {}),
            // The pending-recovery row rides the SAME transaction:
            // the reverse pointer exists only in the row
            // this delete takes, so a crash between the delete and the purge
            // below left a hintless retry with no path to the recovery row.
            ...(user.recoveryGroupId !== undefined
              ? { pendingRecoveryGroupId: user.recoveryGroupId }
              : {}),
          },
          { requireEmptyCrew: true },
        );
        if (outcome === 'crew_not_empty') {
          // Refused at the row: the crew appeared AFTER the read above, so the
          // count is re-read for the message. `max(1, …)` because the refusal
          // itself proves at least one member existed at the delete — a row
          // that has since emptied (or vanished) must not produce "0 members".
          // NOTHING has been destroyed at this point — that is why the purges
          // moved below this block. The caller keeps
          // their queued ciphertext, their prekeys and their socket, and retries
          // once they have revoked their agents.
          const raced = await deps.db.getUserById(auth.userId);
          return crewNotEmptyResult(Math.max(1, raced?.crewCount ?? 0));
        }
      }
    }
  }
  // Only now that the row is gone (or was already) is it safe to destroy the
  // rest. Keyed by userId, so a retry whose row has already vanished still
  // completes them.
  // Activity rows go with the rest of the destructive sweep, NOT before the
  // guarded delete: the refusal-destroys-nothing rule applies to them identically — a
  // `crew_not_empty` refusal must not have already erased the caller's
  // activity history.
  // Routed through activity.ts so the tombstone is keyed under the SAME
  // salted actor id the touch wrote: rows written salted
  // are only addressable salted.
  await deleteHumanActivity(auth.userId, deps);
  await deps.db.purgeQueuedMessages(auth.userId);
  // Consent edges the caller WROTE go with the
  // rest of the destructive sweep: a directed association edge must not
  // outlive the account that asserted it. Same placement argument as its
  // neighbours (after the guarded row delete, keyed by userId, idempotent).
  // Edges other humans wrote TOWARD this account are not findable from here
  // that lookup is the agentId enumeration refuses to build — so
  // they remain, inert (the ws arms re-read both live rows and this row is
  // gone), until their writers delete them — a stated residual.
  await deps.db.purgeConsentEdges(auth.userId);
  await deps.db.deleteOneTimePrekeys(auth.userId);
  // The push-token row, which nothing here used to touch.
  // It was the worst residual deletion left behind, on two counts. It is an
  // APPLE DEVICE IDENTIFIER bound to the account id, so it is exactly the
  // kind of "associated personal data" App Store guideline 5.1.1(v) requires
  // deletion to reach; and it is a CAPABILITY — a live token is the power to
  // make that phone ring. Leaving it to lapse meant a deleted account's
  // device stayed ringable, in principle, for up to the 90-day liveness TTL.
  // "It expires eventually" is not deletion.
  // Placed here, in the destructive sweep, for the same reason as its
  // neighbours: after the guarded user-row delete, so a `crew_not_empty`
  // refusal never erases anything, and before sessions, so a caller whose
  // sweep dies halfway still holds a working token to retry with. The
  // underlying delete is unconditional and keyed by userId alone, so the
  // retry is idempotent and needs no read — which matters, because this
  // role deliberately CANNOT read the table (the grant is Put/Update/Delete
  // only, so a token can be written and destroyed but never fetched).
  await deps.db.deletePushToken(auth.userId);
  // The accounts-program cascade, AUDITED WHOLE — every row class the program created, each either in
  // this sweep, TTL'd with its explicit expiry refused at every read, or a
  // stated permanent tombstone; NOTHING joins the unreaped-forever class the
  // legacy phone claims sit. The enumeration, so the next class
  // cannot ship unplaced:
  // - group# rows: the fused deleteGroupedUser transaction above (survivor
  // update, or last-member delete with the identifierRefs claim walk —
  // full versioned keys, so rotation-window claims die identically);
  // - emailhash# claim rows + the discovery consent ON them: die with the
  // identifier unlink, the last member's exit, or the lazy-solo dissolve
  // (data.ts unlinkIdentifierClass);
  // - recovery# rows: the last-member exit transaction, the SOLO row
  // delete's own fused transaction (the pendingRecoveryGroupId hint —
  // fused so no crash window can strand one), the purge below
  // as the idempotent backstop, + the reap-at-refusing-read
  // (completion/cancel past expiresAt); a LIVE cancel and a replacement
  // both clear the displaced device's reverse pointer;
  // - emailcode# rows: BOTH purpose slots below + reap-at-refusing-read +
  // the sessions-table TTL backstop;
  // - linkoffer#/linkinit# rows: the reverse-pointer walk below (this
  // member's pending ceremonies die with it); merely-expired rows are
  // TTL'd with the explicit expiresAt refused at accept;
  // - emailsupp#/emailcool# shadows: ADDRESS-keyed, so unreachable from
  // any userId — reaped at their own reading walks past their explicit
  // clocks (send leg / attach walk), never here;
  // - revoked-device and revoked-agent tombstones (user row + idkey#):
  // stated PERMANENT (the tombstone class — the record is the
  // enforcement; a human's self-deletion, this path, frees its key
  // instead);
  // - bound-but-unadopted integrations of a deleted owner: NOT reachable —
  // the no-enumeration rule forbids the owner→integrations index and this route carries
  // no body to name them — so the fate is the RECORDED bounded residual:
  // the agent keeps its bearer,
  // writer-deletable consent-edge reach, and same-crew traffic; its
  // owner-directed sends 404 forever (the ULID is gone, never
  // re-minted) and group reach fails closed on the owner read;
  // - peer-device/machine rosters: CLIENT-side stores (E2EE sync payloads);
  // no server row class exists for them — nothing to sweep;
  // - rate-limit windows keyed by ULID or groupId: TTL'd, the stated
  // reset-button class.
  // the slice (the caller's pending verification-code rows, any pending
  // recovery it opened as the recovering device via the `recoveryGroupId`
  // reverse pointer, and the sole-member solo-group backstop): hints come
  // from the pre-delete read. Idempotency, stated EXACTLY (the
  // blanket "re-driven by the retry" claim was false for the hinted
  // classes, whose hints lived only in the now-deleted row): the code rows
  // are userId-keyed and the hintless retry still clears them; the pending
  // recovery row is FUSED into the row-delete transaction above, so no
  // crash window exists for it (this purge's recovery leg is the
  // idempotent backstop, a no-op on the fused path); grouped/lazy-solo
  // group state is fused likewise (deleteGroupedUser / the unlink reap).
  // Only the linkOfferNonces walk below is genuinely hint-dependent and
  // non-transactional: its crash residue is BOUNDED PHYSICALLY by the
  // sessions-table TTL (the one store here with a real TTL attribute),
  // with the rows' explicit expiresAt refused at every read meanwhile —
  // the stated class, never unreaped-forever.
  await deps.db.purgeIdentifierArtifactsForUser(
    auth.userId,
    {
      ...(user?.groupId !== undefined ? { groupId: user.groupId } : {}),
      ...(user?.recoveryGroupId !== undefined ? { recoveryGroupId: user.recoveryGroupId } : {}),
    },
    deps.now(),
  );
  // the slice: every pending link-offer/init row this account is a party
  // to, found through its own linkOfferNonces reverse set (the
  // reverse pointers, written for exactly this walk) — key-addressed
  // deletes, never a Query. The counterparty's pointer to a swept nonce
  // becomes the stated dead-pointer residue and dies with that row; the
  // hintless crash-retry leaves merely-expired rows to the sessions TTL
  // (their explicit expiry already refuses them at every read).
  if (user?.linkOfferNonces !== undefined && user.linkOfferNonces.size > 0) {
    await deps.db.purgeLinkOffersForUser([...user.linkOfferNonces]);
  }
  // The connection row AND the live socket. Every session is about to be
  // gone, so any socket the account holds is revoked unconditionally: the row
  // delete stops inbound routing and the transport disconnect hangs the socket
  // up, closing the residual where a deleted account's socket kept sending.
  // The old code deleted only the row, which left the socket itself alive.
  await revokeConnectionForSessions(deps, auth.userId);
  // Sessions last: while any token still works the caller can retry a partial
  // deletion, and killing our own credential first would strand the rest.
  await deps.db.deleteSessionsForUser(auth.userId);
  const token = bearerToken(event);
  if (token) {
    // Belt and braces: the index is eventually consistent, so a session
    // created moments ago may not have appeared in the query above. The
    // calling token is the one we can always name directly.
    await deps.db.deleteSession(token);
  }
  // Opaque ref only — this line used to carry the raw
  // ULID. The identity key is account identity data and stays out of the
  // retained log for the same reason the phone number did.
  deps.log('account_deleted', { userRef: userRefForLog(auth.userId, deps.userRefSalt) });
  return json(200, {});
};
