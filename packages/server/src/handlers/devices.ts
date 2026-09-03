import { ulid } from 'ulid';
import {
  LINK_OFFER_TTL_SECONDS,
  LinkOfferInitRequest,
  type AccountsNotice,
  type LinkOfferInitResponse,
} from '@tacendum/shared';
import { LIMITS } from '../ratelimit.js';
import { authenticate } from './auth.js';
import { userRefForLog } from '../opaque-ref.js';
import { MESSAGE_TTL_SECONDS } from './ws.js';
import type { UserRecord } from '../db/data.js';
import {
  type AuthedHandler,
  type Deps,
  type Handler,
  type HttpResult,
  errorResult,
  json,
  parseJson,
  rateLimitedResult,
} from './http.js';

/**
 * Device-linking routes, token-path half.
 *
 * This module is deliberately libsignal-free: the INIT leg verifies no
 * signature, so it rides the ordinary HTTP Lambda (route placement — the
 * signature decides the Lambda). Everything that verifies a link-op
 * signature lives in `devices-signed.ts`, which only the auth Lambda hosts.
 */

/**
 * THE collapsed refusal ('s bytes/status discipline, the
 * single-exit pattern) — the ONE exit function every refused case of
 * every accounts-program route returns through. One code, one detail, one
 * status, and `errorResult`'s shared frozen headers, so the refusal for a
 * dark flag, a forged signature, a consumed offer, an occupied slot, a
 * stale epoch, and a membership probe are byte-identical: an attacker who
 * can distinguish any two of them has learned something the caller had no
 * consented right to ask.
 *
 * The two deliberate NON-members of the collapse, named so nobody "fixes"
 * them into it: 429 rate-limit answers (keyed to the CALLER's own budget —
 * they disclose nothing about anyone else, and every route in the system
 * answers them identically) and the bare 401 for a missing/invalid bearer
 * (the caller's own credential state, the standard middleware answer on
 * every authenticated route — while the flag is OFF even that never
 * surfaces, because the flag check runs first).
 */
export function accountsRefusal(): HttpResult {
  return errorResult(403, 'accounts_refused', 'not available');
}

/**
 * Wrap an accounts-program handler: the `feature#accounts` flag is checked
 * FIRST — before auth, before parsing, before rate limits — and OFF (absent,
 * malformed, or deleted) is the collapsed refusal. The
 * dark deploy is dark by construction: while the flag is off, every probe of
 * every accounts route — bearer or no bearer, well-formed or garbage — gets
 * ONE byte-stream, and the same read is the operator's kill switch.
 */
export function accountsRoute(inner: AuthedHandler): Handler {
  const handler: Handler = async (event, deps) => {
    if (!(await deps.db.isAccountsFeatureEnabled())) return accountsRefusal();
    const auth = await authenticate(event, deps);
    if (!auth) return errorResult(401, 'unauthorized', 'missing or invalid bearer token');
    return inner(event, deps, auth);
  };
  // Marked so the HOST adapters can keep the collapse whole for answers the
  // handler never sees: every adapter
  // enforces MAX_BODY_BYTES BEFORE dispatch, and its 413 was a
  // flag-independent "this accounts route is wired" discriminator on a dark
  // deploy — an oversized probe of an accounts route must get the same
  // collapsed bytes as every other probe of it. The adapters test this mark
  // via `isAccountsCollapsedRoute` and answer `accountsRefusal()` themselves;
  // the size ceiling still holds because the handler is still never invoked.
  return Object.assign(handler, { accountsCollapsed: true as const });
}

/**
 * Wrap a PHONE-train handler: `feature#accounts`
 * AND `feature#accounts-phone`, both checked FIRST — before auth, before
 * parsing — and either one absent/OFF is the SAME collapsed refusal. The
 * master flag kills everything; the phone flag keeps this train dark inside
 * a LIVE email-v1 deploy and is the class kill switch (one operator delete).
 * Order is master-first so a fully dark deploy costs one flag read, and the
 * refusal bytes never disclose WHICH gate refused.
 */
export function accountsPhoneRoute(inner: AuthedHandler): Handler {
  const handler: Handler = async (event, deps) => {
    if (!(await deps.db.isAccountsFeatureEnabled())) return accountsRefusal();
    if (!(await deps.db.isAccountsPhoneFeatureEnabled())) return accountsRefusal();
    const auth = await authenticate(event, deps);
    if (!auth) return errorResult(401, 'unauthorized', 'missing or invalid bearer token');
    return inner(event, deps, auth);
  };
  // The same host-adapter collapse mark accountsRoute carries: an oversized
  // probe of a dark phone route answers the collapsed bytes, never a 413.
  return Object.assign(handler, { accountsCollapsed: true as const });
}

/**
 * Wrap a USERNAME-class handler (the
 * accountsPhoneRoute pattern, third class): `feature#accounts` AND
 * `feature#accounts-username`, both checked FIRST — before auth, before
 * parsing — and either one absent/OFF is the SAME collapsed refusal. The
 * sub-flag keeps the class dark inside a LIVE deploy, is the class kill
 * switch, AND is the K_id rotation-window brake (mixed-fleet pin:
 * the operator deletes it for a rotation and restores it after convergence).
 * Master-first, so a fully dark deploy costs one flag read and the refusal
 * bytes never disclose WHICH gate refused.
 */
export function accountsUsernameRoute(inner: AuthedHandler): Handler {
  const handler: Handler = async (event, deps) => {
    if (!(await deps.db.isAccountsFeatureEnabled())) return accountsRefusal();
    if (!(await deps.db.isAccountsUsernameFeatureEnabled())) return accountsRefusal();
    const auth = await authenticate(event, deps);
    if (!auth) return errorResult(401, 'unauthorized', 'missing or invalid bearer token');
    return inner(event, deps, auth);
  };
  // The same host-adapter collapse mark: an oversized or malformed probe of
  // a dark username route answers the collapsed bytes, never a 413.
  return Object.assign(handler, { accountsCollapsed: true as const });
}

/** True iff a mounted handler is an accounts-program route (wrapped by
 * `accountsRoute`/`accountsPhoneRoute`), whose every pre-dispatch refusal a
 * host adapter owes the collapsed byte-stream instead of an adapter-shaped
 * error. */
export function isAccountsCollapsedRoute(handler: Handler): boolean {
  return (handler as { accountsCollapsed?: boolean }).accountsCollapsed === true;
}

/** A user row that can take part in a ceremony: exists, is not tombstoned,
 * holds a registered identity key, and is not an integration (agents never
 * occupy device slots — the transaction-level
 * `attribute_not_exists(accountClass)` conditions landed at in
 * `linkDeviceToGroup`, and this stays the handler's precheck arm of the
 * same refusal). */
function ceremonyEligible(user: UserRecord | undefined): user is UserRecord & { identityKeyPub: string } {
  return (
    user !== undefined &&
    user.tombstoned !== true &&
    user.identityKeyPub !== undefined &&
    user.accountClass !== 'integration'
  );
}

/**
 * POST /v1/devices/link-offer — the INIT leg. Authenticated,
 * no signature: ULID_A names who it scanned and which slot the joiner takes,
 * and the server mints/returns the tuple A must sign — the existing group's
 * groupId + current epoch when A is grouped, or a freshly minted groupId +
 * epoch 0 for a first link — recorded in a TTL'd init row keyed to A (the
 * challenge-row shape), so the submit leg verifies A's signature against
 * what the SERVER chose. A minted-but-unused groupId is a name, not state.
 */
export const linkOfferInitHandler: AuthedHandler = async (event, deps, auth) => {
  const retry = await deps.rateLimit.take(`linkoffer:${auth.userId}`, LIMITS.linkOffer);
  if (retry > 0) return rateLimitedResult(retry);

  const parsed = parseJson(event, LinkOfferInitRequest);
  // Parse failures collapse too (unlike ordinary routes): a zod issue list
  // would disclose the request shape of a route the caller may only be
  // probing, and every listed REFUSED case must be one byte-stream.
  if (!parsed.ok) return accountsRefusal();
  const { acceptorUserId, acceptorClass, offererClass } = parsed.data;

  //the desktop slot is a schema reservation ONLY in v1. The link
  // transaction refuses it too refusing at init as well means no
  // ceremony is ever half-run against a slot that cannot exist yet.
  if (acceptorClass === 'desktop' || offererClass === 'desktop') return accountsRefusal();
  if (acceptorUserId === auth.userId) return accountsRefusal();

  const offerer = await deps.db.getUserById(auth.userId);
  if (!ceremonyEligible(offerer)) return accountsRefusal();
  const acceptor = await deps.db.getUserById(acceptorUserId);
  // The step-1 pristineness PRECHECK (groupId absent). UX only — the
  // raceable classes are refused by the link transaction's
  // attribute_not_exists(groupId) condition.
  if (!ceremonyEligible(acceptor) || acceptor.groupId !== undefined) return accountsRefusal();
  // THE RECIPIENT-KEYED CEILING: ceremonies aimed at THIS acceptor, taken
  // here and again at submit. The offerer's bucket above bounds one
  // attacker; this bounds what N free identities can do to one victim's row.
  // Collapsed refusal, never a 429 — the key is not the caller's own
  // (LIMITS.linkOfferRecipient).
  if (
    (await deps.rateLimit.take(`linkoffer-rcpt:${acceptorUserId}`, LIMITS.linkOfferRecipient)) >
    0
  ) {
    return accountsRefusal();
  }

  let groupId: string;
  let rosterEpoch: number;
  let declaredOffererClass: typeof offererClass = undefined;
  if (offerer.groupId !== undefined) {
    // Grouped offerer: the roster knows its class; declaring one is a
    // malformed ceremony, refused rather than ignored.
    if (offererClass !== undefined) return accountsRefusal();
    const group = await deps.db.getAccountGroup(offerer.groupId);
    if (!group) return accountsRefusal();
    // The offerer must appear in the AUTHORITATIVE roster: a user row still naming a groupId is a pointer, never
    // membership — a stale nonmember could otherwise open a ceremony against
    // a group it left, at the group's CURRENT epoch, which the accept-time
    // epoch pin would then happily admit. Precheck arm; the racing half is
    // the link transaction's own `contains(memberIds,:off)` condition.
    if (!group.members.some((m) => m.userId === auth.userId)) return accountsRefusal();
    groupId = offerer.groupId;
    rosterEpoch = group.epoch;
  } else {
    // First link: A declares its own slot (self-declared-class rule —
    // there is no classless member state), and the two classes must differ.
    if (offererClass === undefined || offererClass === acceptorClass) return accountsRefusal();
    groupId = ulid();
    rosterEpoch = 0;
    declaredOffererClass = offererClass;
  }

  const offerNonce = ulid();
  const nowSeconds = Math.floor(deps.now() / 1000);
  const expiresAt = nowSeconds + LINK_OFFER_TTL_SECONDS;
  const put = await deps.db.putLinkOfferInit(
    {
      offerNonce,
      groupId,
      offererUserId: auth.userId,
      acceptorUserId,
      acceptorClass,
      ...(declaredOffererClass !== undefined ? { offererClass: declaredOffererClass } : {}),
      rosterEpoch,
      expiresAt,
    },
    nowSeconds,
  );
  if (put !== 'created') return accountsRefusal();

  // Opaque ref only — no ULID and no groupId reaches the retained log.
  deps.log('link_offer_init', { userRef: userRefForLog(auth.userId, deps.userRefSalt) });
  const body: LinkOfferInitResponse = { groupId, rosterEpoch, offerNonce, expiresAt };
  return json(200, body);
};

/**
 * Fan one server-minted accounts notice to a member's DURABLE queue and make
 * the same wake decision the offline-send path makes (/7; — delivery rides the existing queue/wake path). Best-effort BY
 * CONTRACT: the roster transaction is the enforcement and has already
 * committed (or the offer row already exists); a failed notice costs
 * loudness, never correctness, so nothing here throws into the caller.
 *
 * The wake draws the SAME message-wake buckets the WS send path draws, IN THE
 * SAME ORDER (`pushmsg:` sender, then `pushmsg-pair:` fair-share, then
 * `pushmsg-rcpt:` recipient ceiling — `wakeRecipient`, ws.ts): ceremony
 * notices share the abuse budget of ordinary messages instead of minting a
 * fresh channel, and the pair bucket keeps one sender from draining a
 * recipient's shared banner ceiling out from under everyone else (the
 * pair-before-recipient ordering rule: dropping the pair bucket
 * would re-open that denial-of-notification).
 */
export async function deliverAccountsNotice(
  deps: Deps,
  recipientId: string,
  aboutUserId: string,
  notice: AccountsNotice,
  expiresAtSeconds?: number,
): Promise<void> {
  const nowMs = deps.now();
  const msgId = ulid();
  const payload = Buffer.from(JSON.stringify(notice), 'utf8').toString('base64');
  try {
    await deps.db.enqueueMessage(
      {
        recipientId,
        msgId,
        senderId: aboutUserId,
        type: 'accounts',
        payload,
        ts: nowMs,
        // A link-offer notice dies with the offer it announces; membership
        // notices keep the ordinary message TTL.
        expiresAt: expiresAtSeconds ?? Math.floor(nowMs / 1000) + MESSAGE_TTL_SECONDS,
      },
      // Server-minted bookkeeping must never grant a relationship —
      // and revoke notices are ATTRIBUTED to the revoked (tombstoned) member
      // without that device acting, so the sender-side commit-time tombstone
      // check is skipped for exactly this caller (the
      // recipient-side check still holds).
      { establishesCorrespondence: false, serverMinted: true },
    );
  } catch {
    deps.log('accounts_notice_enqueue_failed');
    return;
  }
  try {
    // The sender-side buckets key on the ABOUT member's GROUP where one
    // exists — the same collapse `wakeRecipient` applies to ordinary message
    // wakes (charging the individual `aboutUserId` would give every
    // linked sibling an independent notice-wake budget beside the ONE
    // collapsed budget the ws path enforces, and "no sender-side budget
    // multiplies" is pinned). Resolved from the about-user's row: a solo,
    // tombstoned, or already-removed member has no `groupId` and keys
    // per-ULID, exactly as `wakeRecipient` does without group context. The
    // read runs only when the flag admitted the route, never on a dark probe.
    const about = await deps.db.getUserById(aboutUserId);
    const senderScope = about?.groupId ?? aboutUserId;
    if ((await deps.rateLimit.take(`pushmsg:${senderScope}`, LIMITS.pushMessage)) > 0) return;
    // The (about, recipient) PAIR bucket — each sender's fair share of the
    // recipient ceiling, taken BEFORE it (the ws.ts ordering rule): a sender
    // its own pair budget refused must never drain the shared one. Sender
    // side group-collapsed like `pushmsg` above; recipient side stays the
    // device ULID (it protects one physical device's attention, per-device
    // by design).
    if (
      (await deps.rateLimit.take(
        `pushmsg-pair:${senderScope}:${recipientId}`,
        LIMITS.pushMessagePair,
      )) > 0
    ) {
      return;
    }
    if ((await deps.rateLimit.take(`pushmsg-rcpt:${recipientId}`, LIMITS.pushMessageRecipient)) > 0)
      return;
    const token = await deps.db.getPushToken(recipientId);
    if (!token) return;
    await deps.push.notify(token, {
      from: aboutUserId,
      ts: nowMs,
      msgId,
      msgType: 'accounts',
      payload,
    });
  } catch {
    deps.log('accounts_notice_wake_failed');
  }
}

// The wrapped INIT route (flag FIRST, then bearer auth): what the local
// adapter and the ordinary HTTP Lambda host mount — libsignal-free.
export const linkOfferInitRoute: Handler = accountsRoute(linkOfferInitHandler);
