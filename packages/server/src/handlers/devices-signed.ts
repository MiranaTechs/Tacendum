import {
  DeviceRosterMutationRequest,
  LinkAcceptRequest,
  LinkOfferSubmitRequest,
  LINK_OFFER_TTL_SECONDS,
  linkOpSignedBytes,
  type AccountsNotice,
  type LinkOp,
} from '@tacendum/shared';
import { LIMITS } from '../ratelimit.js';
import { userRefForLog } from '../opaque-ref.js';
import { verifyIdentitySignature } from './auth-account.js';
import { accountsRefusal, accountsRoute, deliverAccountsNotice } from './devices.js';
import { revokeConnectionForSessions } from './session-revoke.js';
import type { AgentBinding, UserRecord } from '../db/data.js';
import {
  type AuthedHandler,
  type Deps,
  type Handler,
  json,
  parseJson,
  rateLimitedResult,
} from './http.js';

/**
 * Device-linking routes, signed half.
 *
 * Every handler here verifies a libsignal identity signature, so every route
 * here rides the AUTH Lambda beside `auth-account.ts` — the signature
 * decides the Lambda (route placement; the 21 MB libsignal binary stays
 * off the hot path). The verify itself is `verifyIdentitySignature` — the
 * exact call the auth path uses (reuse of existing
 * machinery: no new primitive, no new library, no key derivation) — over the
 * pinned op-framed `tacendum-link-v1` preimages (`linkOpSignedBytes`, byte-pinned by `packages/shared/linkvectors.json`).
 *
 * Refusal discipline: every refused case returns through `accountsRefusal`
 * ONE byte-stream for a forged signature, a consumed or expired offer, a
 * stale epoch, an occupied slot, a non-pristine joiner, a cross-group steal,
 * and the dark flag. 429s and the bare 401 are
 * the two named non-members (see devices.ts).
 */

/** The registered identity key of a live, ceremony-capable user row, or
 * undefined — one shape for "missing", "tombstoned", "no key yet", and
 * "integration-class", all of which collapse upstream. The class
 * arm makes the human-class rule STRUCTURAL on every signed ceremony
 * surface at once — submit, accept, unlink, revoke, actor and target alike:
 * an agent never drives a ceremony and never appears in one, however the
 * request is shaped. The link transaction's own
 * `attribute_not_exists(accountClass)` conditions are the racing half of
 * the same refusal (data.ts, the crew-adopt precedent). */
function registeredKeyOf(user: UserRecord | undefined): string | undefined {
  if (!user || user.tombstoned === true) return undefined;
  if (user.accountClass === 'integration') return undefined;
  return user.identityKeyPub;
}

/**
 * POST /v1/devices/link-offer/submit — the SUBMIT leg. The
 * server rebuilds the offer preimage FROM ITS OWN INIT ROW plus the
 * acceptor's REGISTERED identity key, verifies A's signature against A's
 * REGISTERED key, and only then writes the pending-offer row: a stolen
 * bearer token alone can neither open nor advance a ceremony, and a signed
 * tuple that disagrees with the recorded init row simply fails to verify.
 */
const linkOfferSubmitHandler: AuthedHandler = async (event, deps, auth) => {
  const retry = await deps.rateLimit.take(`linkoffer:${auth.userId}`, LIMITS.linkOffer);
  if (retry > 0) return rateLimitedResult(retry);

  const parsed = parseJson(event, LinkOfferSubmitRequest);
  if (!parsed.ok) return accountsRefusal();
  const { offerNonce, signature } = parsed.data;

  const nowSeconds = Math.floor(deps.now() / 1000);
  const init = await deps.db.getLinkOfferInit(offerNonce, nowSeconds);
  // Absent, consumed, or expired-but-unreaped (explicit expiresAt — TTL
  // reaping is never the enforcement): one collapsed answer.
  if (!init) return accountsRefusal();
  // The init row is keyed to A: only the account that opened
  // the ceremony may sign it forward.
  if (init.offererUserId !== auth.userId) return accountsRefusal();

  const offerer = await deps.db.getUserById(auth.userId);
  const offererKey = registeredKeyOf(offerer);
  if (!offererKey) return accountsRefusal();
  const acceptor = await deps.db.getUserById(init.acceptorUserId);
  const acceptorKey = registeredKeyOf(acceptor);
  // Pristineness RE-check (precheck arm; the raceable classes
  // are refused by the link transaction's condition).
  if (!acceptorKey || acceptor?.groupId !== undefined) return accountsRefusal();

  // The offer preimage: subject = the ACCEPTOR's registered key — A's
  // signature certifies WHICH key it is pulling into the group (release-pinned).
  const preimage = linkOpSignedBytes('offer', {
    groupId: init.groupId,
    offererUserId: init.offererUserId,
    acceptorUserId: init.acceptorUserId,
    subjectIdentityPubKey: acceptorKey,
    class: init.acceptorClass,
    rosterEpoch: init.rosterEpoch,
    offerNonce: init.offerNonce,
    expiresAt: init.expiresAt,
  });
  if (!verifyIdentitySignature(offererKey, preimage, signature)) return accountsRefusal();

  // Signature verified — NOW the pending-offer row may exist ('s
  // ordering), single-use-consuming the init row in the same transaction.
  if ((await deps.db.promoteLinkOfferInit(offerNonce, signature, nowSeconds)) !== 'promoted') {
    return accountsRefusal();
  }

  // Delivery to ULID_B rides the existing durable queue + wake path. Best-effort: the offer row is the ceremony's state,
  // and a lost notice costs a stalled ceremony that TTLs away, never a
  // half-linked group. The notice dies with the offer it announces.
  await deliverAccountsNotice(
    deps,
    init.acceptorUserId,
    init.offererUserId,
    {
      kind: 'linkOffer',
      groupId: init.groupId,
      offererUserId: init.offererUserId,
      acceptorUserId: init.acceptorUserId,
      acceptorClass: init.acceptorClass,
      rosterEpoch: init.rosterEpoch,
      offerNonce: init.offerNonce,
      expiresAt: init.expiresAt,
      offerSig: signature,
    },
    init.expiresAt,
  );

  deps.log('link_offer_created', { userRef: userRefForLog(auth.userId, deps.userRefSalt) });
  return json(200, {});
};

/**
 * POST /v1/devices/link-accept (7). ULID_B's acceptance over
 * the same tuple, subject = the OFFERER's registered key; verified with the
 * same libsignal verify, then the one link TransactWrite whose conditions
 * (class slot, epoch, cap, pristineness, single-use consume) are the
 * authorization — a lost race is a refusal, never a precheck bypass.
 */
const linkAcceptHandler: AuthedHandler = async (event, deps, auth) => {
  const retry = await deps.rateLimit.take(`linkaccept:${auth.userId}`, LIMITS.linkAccept);
  if (retry > 0) return rateLimitedResult(retry);

  const parsed = parseJson(event, LinkAcceptRequest);
  if (!parsed.ok) return accountsRefusal();
  const { offerNonce, signature } = parsed.data;

  const nowSeconds = Math.floor(deps.now() / 1000);
  const offer = await deps.db.getLinkOffer(offerNonce, nowSeconds);
  if (!offer) return accountsRefusal();
  // Cross-group steal: an acceptance for a ULID the offer never named is
  // the same collapsed refusal as an unknown nonce.
  if (offer.acceptorUserId !== auth.userId) return accountsRefusal();

  const acceptor = await deps.db.getUserById(auth.userId);
  const acceptorKey = registeredKeyOf(acceptor);
  if (!acceptorKey) return accountsRefusal();
  const offerer = await deps.db.getUserById(offer.offererUserId);
  const offererKey = registeredKeyOf(offerer);
  if (!offererKey) return accountsRefusal();

  // The acceptance preimage: same tuple, op-framed 'accept', subject = the
  // OFFERER's registered key — B's signature certifies WHICH key invited it.
  const preimage = linkOpSignedBytes('accept', {
    groupId: offer.groupId,
    offererUserId: offer.offererUserId,
    acceptorUserId: offer.acceptorUserId,
    subjectIdentityPubKey: offererKey,
    class: offer.acceptorClass,
    rosterEpoch: offer.rosterEpoch,
    offerNonce: offer.offerNonce,
    expiresAt: offer.expiresAt,
  });
  if (!verifyIdentitySignature(acceptorKey, preimage, signature)) return accountsRefusal();

  const linked = await deps.db.linkDeviceToGroup({
    offerNonce,
    acceptSig: signature,
    nowSeconds,
    linkedAtMs: deps.now(),
  });
  // desktop_reserved, offer_consumed/expired, stale_epoch, class_occupied,
  // group_full, already_grouped, unknown_member: every one is a membership
  // fact the caller has no consented right to distinguish.
  if (linked !== 'linked') return accountsRefusal();

  // Every EXISTING member learns a device joined — the two
  // ceremony parties already know. Best-effort; the roster is committed.
  // SIGNED since: the notice carries the ceremony's own
  // certificates plus the joiner's registered key, so a member's local
  // roster moves only on a signature verifying under a key it already
  // holds — never on this server's word alone.
  const group = await deps.db.getAccountGroup(offer.groupId);
  if (group) {
    const notice: AccountsNotice = {
      kind: 'memberLinked',
      groupId: offer.groupId,
      userId: offer.acceptorUserId,
      class: offer.acceptorClass,
      rosterEpoch: group.epoch,
      identityKeyPub: acceptorKey,
      certs: {
        offerSig: offer.offerSig,
        acceptSig: signature,
        groupId: offer.groupId,
        offererUserId: offer.offererUserId,
        acceptorUserId: offer.acceptorUserId,
        class: offer.acceptorClass,
        rosterEpoch: offer.rosterEpoch,
        offerNonce: offer.offerNonce,
        expiresAt: offer.expiresAt,
      },
    };
    for (const member of group.members) {
      if (member.userId === offer.acceptorUserId || member.userId === offer.offererUserId) continue;
      await deliverAccountsNotice(deps, member.userId, offer.acceptorUserId, notice);
    }
  }

  deps.log('device_linked', { userRef: userRefForLog(auth.userId, deps.userRefSalt) });
  return json(200, {});
};

/**
 * Session/socket/push teardown for a removed device — CLEANUP, never the
 * enforcement: the roster/tombstone transaction has
 * already committed, auth refuses the tombstoned key, bearer-session
 * validation refuses the tombstoned row at read time, and sends to it
 * refuse at enqueue. Every step is idempotent and re-driven by retrying the
 * mutation call, so a crash between transaction and teardown converges.
 */
export async function teardownRemovedDevice(
  deps: Deps,
  targetUserId: string,
  agentIds: readonly string[],
): Promise<void> {
  await deps.db.deleteSessionsForUser(targetUserId);
  // No digest filter: every socket the removed device holds is torn down
  // (the machinery of session.ts / auth-account.ts:418-444).
  await revokeConnectionForSessions(deps, targetUserId, {});
  await deps.db.deletePushToken(targetUserId);
  for (const agentId of agentIds) {
    // The agents' USER rows and idkey claims were tombstoned in the roster
    // transaction (normal path) or by `tombstoneAgentBindings` (completion
    // path) — the enforcement in either case; their sessions/sockets are
    // cleanup like the victim's own.
    await deps.db.deleteSessionsForUser(agentId);
    await revokeConnectionForSessions(deps, agentId, {});
  }
}

/** The two mutation strengths behind one implementation — they differ
 * only in the op frame, the data-layer transaction, and revoke's extra
 * enforcement (agent-binding tombstones, idempotent completion). */
function rosterMutationHandler(op: Extract<LinkOp, 'unlink' | 'revoke'>): AuthedHandler {
  return async (event, deps, auth) => {
    const retry = await deps.rateLimit.take(`rostermut:${auth.userId}`, LIMITS.rosterMutation);
    if (retry > 0) return rateLimitedResult(retry);

    const parsed = parseJson(event, DeviceRosterMutationRequest);
    if (!parsed.ok) return accountsRefusal();
    const req = parsed.data;
    // Only revoke names agents: an unlink is amicable and the binding rides
    // with the departing device (binding fate).
    if (op === 'unlink' && req.boundAgents !== undefined) return accountsRefusal();

    const nowSeconds = Math.floor(deps.now() / 1000);
    // The mutation signature's own explicit expiry, checked at verification
    // (release-pinned) — the clock, never a reaper. Bounded ABOVE by the pinned
    // link-offer TTL (a signer-chosen expiry had NO server ceiling,
    // so a captured signed mutation carrying expiresAt = now + 20 years was a
    // multi-year replay capability). A mutation valid for longer than one offer
    // TTL from now is refused, so a captured signature replays for at most that
    // window — and only ever at the epoch it bound, which the transaction
    // condition still decides.
    if (req.expiresAt <= nowSeconds || req.expiresAt > nowSeconds + LINK_OFFER_TTL_SECONDS) {
      return accountsRefusal();
    }

    const actor = await deps.db.getUserById(auth.userId);
    const actorKey = registeredKeyOf(actor);
    if (!actorKey) return accountsRefusal();
    const target = await deps.db.getUserById(req.targetUserId);
    // The target ROW must exist even for the idempotent completion (the
    // tombstoned row is exactly what it leaves behind); its registered key
    // is the preimage's subject — a mutation names WHICH key it removes.
    if (!target?.identityKeyPub) return accountsRefusal();
    // The TARGET side of the human-class rule, explicit: `registeredKeyOf` covers the ACTOR, but the target's key
    // is read raw here because the completion path must accept a TOMBSTONED
    // target — so the class arm is applied by hand. An integration can never
    // be a roster member (the link conditions) nor carry the completion
    // marker (`formerGroupId` is written only for members), but the module
    // header's claim — an agent never APPEARS in a ceremony, however the
    // request is shaped — must hold structurally, not by construction alone.
    if (target.accountClass === 'integration') return accountsRefusal();

    const group = await deps.db.getAccountGroup(req.groupId);
    const targetMember = group?.members.find((m) => m.userId === req.targetUserId);
    if (targetMember) {
      // The roster knows the target's slot; a request that disagrees signed
      // the wrong tuple.
      if (targetMember.class !== req.targetClass) return accountsRefusal();
    } else if (
      op !== 'revoke' ||
      target.tombstoned !== true ||
      target.formerGroupId !== req.groupId ||
      // AUTHORIZATION ON THE COMPLETION PATH (the idempotent-
      // completion branch performed none). When the target has already left
      // the roster, the roster TransactWrite — whose `contains(memberIds,
      //actor)` condition is the ONLY place membership is enforced —
      // does NOT run, so a stranger holding just the tombstoned ULID + groupId
      // could otherwise drive teardown, forged-notice fan-out, and a
      // membership oracle on a third party's account. The acting member's
      // presence in the SURVIVING roster is therefore checked HERE, in the
      // handler: only a member who outlived the revoke may complete it. (The
      // legitimate crash-window retry is exactly such a survivor — the revoke
      // removed the target, never the actor.)
      !group?.members.some((m) => m.userId === auth.userId)
    ) {
      // Not in the roster and not the marker a COMMITTED revoke leaves
      // behind (tombstoned + formerGroupId, written only by the revoke
      // transaction) driven by a surviving member: nothing here is
      // completable. An amicable unlink leaves no such marker by design — its
      // leaver is a cooperating standalone account that can sign itself out —
      // so only revoke gets the idempotent-completion path.
      return accountsRefusal();
    }

    //every roster mutation carries a fresh identity-key signature by
    // the ACTING member over the op-framed preimage — offerer = actor,
    // acceptor = target, subject = the TARGET's registered key. Verified
    // against the actor's REGISTERED key: a stolen bearer session alone
    // never mutates a roster.
    const preimage = linkOpSignedBytes(op, {
      groupId: req.groupId,
      offererUserId: auth.userId,
      acceptorUserId: req.targetUserId,
      subjectIdentityPubKey: target.identityKeyPub,
      class: req.targetClass,
      rosterEpoch: req.rosterEpoch,
      offerNonce: req.offerNonce,
      expiresAt: req.expiresAt,
    });
    if (!verifyIdentitySignature(actorKey, preimage, req.signature)) return accountsRefusal();

    // Revoke only: resolve the named agents, refusing any that is not an
    // integration OWNED BY the target — naming anyone else's agent is a probe,
    // answered with the same collapsed bytes. DEDUP first (a
    // duplicated ULID produced two transaction operations on ONE item, which
    // DynamoDB rejects with a ValidationException — a 500 that breaks the
    // one-byte-stream refusal and leaks an "is X an integration owned by Y"
    // discriminator). Distinct ULIDs only, order preserved.
    const agents: AgentBinding[] = [];
    const seenAgents = new Set<string>();
    for (const agentId of req.boundAgents ?? []) {
      if (seenAgents.has(agentId)) continue;
      seenAgents.add(agentId);
      const agent = await deps.db.getUserById(agentId);
      if (
        !agent ||
        agent.accountClass !== 'integration' ||
        agent.ownerUserId !== req.targetUserId ||
        agent.identityKeyPub === undefined
      ) {
        return accountsRefusal();
      }
      agents.push({ userId: agentId, identityKeyPub: agent.identityKeyPub });
    }
    const agentIds = agents.map((a) => a.userId);

    const input = {
      groupId: req.groupId,
      actingUserId: auth.userId,
      targetUserId: req.targetUserId,
      rosterEpoch: req.rosterEpoch,
      // The caller's clock stamps a last-exit username tombstone.
      nowMs: deps.now(),
    };
    if (targetMember) {
      const result =
        op === 'unlink'
          ? await deps.db.unlinkDeviceFromGroup(input)
          : await deps.db.revokeDeviceFromGroup({ ...input, agents });
      if (result !== (op === 'unlink' ? 'unlinked' : 'revoked')) {
        // The condition refused (stale epoch, removed actor, a racing
        // mutation) — check ONE thing before collapsing: a concurrent
        // retry of THIS SAME revoke may have just committed, in which case
        // the call still owes the agent tombstones this retry names (the
        // committed call may have omitted them) AND the teardown (idempotent
        // completion).
        if (op === 'revoke') {
          const after = await deps.db.getUserById(req.targetUserId);
          if (after?.tombstoned === true && after.formerGroupId === req.groupId) {
            if ((await deps.db.tombstoneAgentBindings(agents)) === 'binding_conflict') {
              return accountsRefusal();
            }
            await teardownRemovedDevice(deps, req.targetUserId, agentIds);
            deps.log('device_revoked', { userRef: userRefForLog(auth.userId, deps.userRefSalt) });
            return json(200, {});
          }
        }
        return accountsRefusal();
      }
    } else if (op === 'revoke') {
      // Marker branch (targetMember undefined; membership already checked): the
      // roster transaction committed EARLIER and is not re-run here, so any
      // agents THIS retry names — which the committed call may have omitted —
      // are tombstoned now, before teardown (the record is the
      // enforcement, teardown is re-driven cleanup).
      if ((await deps.db.tombstoneAgentBindings(agents)) === 'binding_conflict') {
        return accountsRefusal();
      }
    }
    // Either the transaction just committed (agents tombstoned in-band), or
    // (revoke) the marker proved an earlier one did and the agent tombstones +
    // teardown remain: run the idempotent cleanup — re-driven by every retry
    //.
    await teardownRemovedDevice(deps, req.targetUserId, agentIds);

    // The survivors learn, in-band, from the durable queue (loud
    // device-list discipline; the SIGNED peer-facing notices are the
    // client's). Best-effort — the record is already the enforcement.
    // SIGNED since: the acting member's own op-framed
    // signature rides the notice with its full preimage context, so a
    // sibling verifies the removal against the acting member's key it
    // already holds — a forged or replayed removal on server word alone
    // verifies against nothing.
    const signedFields = {
      actingUserId: auth.userId,
      subjectIdentityPubKey: target.identityKeyPub,
      offerNonce: req.offerNonce,
      expiresAt: req.expiresAt,
      signedRosterEpoch: req.rosterEpoch,
      signature: req.signature,
    };
    const after = await deps.db.getAccountGroup(req.groupId);
    if (after) {
      const notice: AccountsNotice = {
        kind: op === 'unlink' ? 'memberUnlinked' : 'memberRevoked',
        groupId: req.groupId,
        userId: req.targetUserId,
        class: req.targetClass,
        rosterEpoch: after.epoch,
        ...signedFields,
      };
      for (const member of after.members) {
        if (member.userId === auth.userId) continue;
        await deliverAccountsNotice(deps, member.userId, req.targetUserId, notice);
      }
    }
    // The amicable leaver itself is told too — it lives on as a standalone
    // account whose UI should say what happened. A revoked row is dead and
    // gets nothing (sends to it refuse at enqueue, its own rule).
    if (op === 'unlink' && auth.userId !== req.targetUserId) {
      await deliverAccountsNotice(deps, req.targetUserId, auth.userId, {
        kind: 'memberUnlinked',
        groupId: req.groupId,
        userId: req.targetUserId,
        class: req.targetClass,
        rosterEpoch: (after?.epoch ?? req.rosterEpoch) + (after ? 0 : 1),
        ...signedFields,
      });
    }

    deps.log(op === 'unlink' ? 'device_unlinked' : 'device_revoked', {
      userRef: userRefForLog(auth.userId, deps.userRefSalt),
    });
    return json(200, {});
  };
}

// The wrapped routes (flag FIRST, then bearer auth — devices.ts): what the
// local adapter and the AUTH Lambda host mount.
export const linkOfferSubmitRoute: Handler = accountsRoute(linkOfferSubmitHandler);
export const linkAcceptRoute: Handler = accountsRoute(linkAcceptHandler);
export const deviceUnlinkRoute: Handler = accountsRoute(rosterMutationHandler('unlink'));
export const deviceRevokeRoute: Handler = accountsRoute(rosterMutationHandler('revoke'));
