import {
  RECOVERY_DISCOVERY_COOLDOWN_SECONDS,
  RecoveryCompleteRequest,
  authSignedBytes,
  type AccountsNotice,
} from '@tacendum/shared';
import { LIMITS } from '../ratelimit.js';
import { userRefForLog } from '../opaque-ref.js';
import { verifyIdentitySignature } from './auth-account.js';
import { concatBytes } from './identity-verify.js';
import { accountsRefusal, accountsRoute, deliverAccountsNotice } from './devices.js';
import { teardownRemovedDevice } from './devices-signed.js';
import { type AuthedHandler, type Handler, json, parseJson, rateLimitedResult } from './http.js';

/**
 * Recovery completion — the recovery-attach (route
 * placement: THIS is the one recovery leg that verifies a libsignal identity
 * signature, so it alone rides the auth Lambda beside the binary).
 *
 * What the signature proves, and which signature it is: the recovering
 * device signs a FRESH v2 audience-bound auth challenge with its REGISTERED
 * identity key — `authSignedBytes(origin, challenge)`, the EXACT preimage
 * domain and the exact machinery registration and link-acceptance already
 * ride. No new primitive,
 * no new preimage domain, no key derivation — and the property holds
 * for this verb too: a stolen bearer token alone can never complete a
 * recovery, because completing one demands live possession of the private
 * key behind the account it attaches.
 *
 * What AUTHORIZES the attach is not the signature — it is the recovery
 * guards, enforced as transaction conditions in `completeRecovery`: the
 * emailed code proved the identifier days earlier (the pending row is that
 * proof), the 72 h delay has elapsed on the transaction's own clock check,
 * and no surviving member cancelled (the cancel WINS under DynamoDB's
 * serialization). The signature is what binds the CALLER to the key the
 * group is about to trust-on-first-use.
 *
 * The incumbent case is the NORMAL case: a declared slot still holding
 * the lost phone completes as the replace transaction — tombstone the
 * incumbent + its idkey claim + attach the recovered device, ONE
 * TransactWrite — and the incumbent's teardown re-drives as idempotent
 * cleanup, exactly the revoke discipline (the record is the enforcement).
 */
const recoveryCompleteHandler: AuthedHandler = async (event, deps, auth) => {
  const retry = await deps.rateLimit.take(`recovery:${auth.userId}`, LIMITS.recoveryComplete);
  if (retry > 0) return rateLimitedResult(retry);
  const parsed = parseJson(event, RecoveryCompleteRequest);
  if (!parsed.ok) return accountsRefusal();
  const { groupId, challenge, signature } = parsed.data;

  const caller = await deps.db.getUserById(auth.userId);
  // The class arm is the: an agent never drives a recovery ceremony —
  // the identifierEligible rule every token-path recovery leg already
  // applies, enforced here on the signed leg too, with the transaction's
  // `attribute_not_exists(accountClass)` condition (completeRecovery) as the
  // racing half of the same refusal.
  if (
    !caller ||
    caller.tombstoned === true ||
    caller.identityKeyPub === undefined ||
    caller.accountClass === 'integration'
  ) {
    return accountsRefusal();
  }
  // The fresh possession proof: a pending challenge for the CALLER'S
  // REGISTERED key, unexpired by the explicit clock check, verified with the
  // one shared verify, then consumed atomically single-use — byte-for-byte
  // the auth path's discipline (verify before consuming; consume before
  // acting).
  const record = await deps.db.getAuthChallenge(caller.identityKeyPub, challenge);
  if (!record) return accountsRefusal();
  const nowSeconds = Math.floor(deps.now() / 1000);
  if (record.expiresAt < nowSeconds) {
    await deps.db.consumeAuthChallengeIfMatches(caller.identityKeyPub, challenge);
    return accountsRefusal();
  }
  const preimage = concatBytes(authSignedBytes(deps.apiOrigin, challenge));
  if (!verifyIdentitySignature(caller.identityKeyPub, preimage, signature)) {
    return accountsRefusal();
  }
  if (!(await deps.db.consumeAuthChallengeIfMatches(caller.identityKeyPub, challenge))) {
    return accountsRefusal();
  }

  // THE PHONE KILL SWITCH DOMINATES THIS SHARED PATH: the pending row recorded its identifier
  // class AT BIRTH from the claim-key prefix that proved the code (never
  // client-asserted), and a phone-class row REFUSES completion with the
  // collapsed bytes while `feature#accounts-phone` is absent — a pending
  // phone recovery can never complete after the phone flag is pulled. The
  // row is left INTACT (this is a refusal, not a cancel: the flag returning
  // lets it complete, and the surviving member's cancel still lands
  // meanwhile — the cancel leg is master-flag-only on purpose). Email-class
  // rows — including every previous row, which reads as email — are
  // untouched by this gate. The wire above carried no identifier field to
  // consult: the ROW is the only authority.
  const pendingRow = await deps.db.getRecoveryPending(groupId);
  // The flag read runs UNCONDITIONALLY (`&&` short-circuit
  // made the strongly-consistent GetItem fire only for phone-class rows, so
  // a caller naming an arbitrary groupId could read "a phone-class pending
  // recovery exists for this group" off one GetItem of latency — a
  // class-shaped side channel on a uniformity-bound shared path; one unconditional
  // read removes it for the cost of one GetItem per completion).
  const phoneFeatureEnabled = await deps.db.isAccountsPhoneFeatureEnabled();
  if (pendingRow?.identifierClass === 'phone' && !phoneFeatureEnabled) {
    return accountsRefusal();
  }

  const result = await deps.db.completeRecovery({
    groupId,
    newUserId: auth.userId,
    nowSeconds,
    linkedAtMs: deps.now(),
    // The 7-day discovery cool-down, stamped on the claim rows as schema
    // (read-time rule — no cron, no activation machine).
    discoverableAfter: nowSeconds + RECOVERY_DISCOVERY_COOLDOWN_SECONDS,
  });
  // canceled, not_ready, gone, stale: each is a fact about someone else's
  // account state — one collapsed byte-stream (the cancel, in particular,
  // must not be distinguishable from "no such recovery" to the device the
  // survivors just refused).
  if (result.outcome !== 'completed') return accountsRefusal();

  // Cleanup, never enforcement: the replaced
  // incumbent's row + idkey claim were tombstoned IN the transaction above;
  // its sessions, socket, and push row are re-drivable teardown.
  if (result.incumbent) {
    await teardownRemovedDevice(deps, result.incumbent.userId, []);
  }
  // loudness: the surviving members learn, in-band, from the durable
  // queue. Server-word by necessity (nobody has pinned the new key yet) —
  // the recovered device still arrives at every peer and sibling as an
  // un-cross-signed NEW key with the full TOFU ceremony.
  const notice: AccountsNotice = {
    kind: 'recoveryCompleted',
    groupId,
    userId: auth.userId,
    class: result.deviceClass,
    rosterEpoch: result.rosterEpoch,
  };
  for (const survivor of result.survivors) {
    await deliverAccountsNotice(deps, survivor, auth.userId, notice);
  }
  deps.log('recovery_completed', { userRef: userRefForLog(auth.userId, deps.userRefSalt) });
  return json(200, {});
};

// The wrapped route (flag FIRST, then bearer auth — devices.ts): what the
// local adapter and the AUTH Lambda host mount.
export const recoveryCompleteRoute: Handler = accountsRoute(recoveryCompleteHandler);
