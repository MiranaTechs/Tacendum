import type { DeviceClass, GroupMemberCerts, LinkOpTuple } from '@tacendum/shared';
import * as cryptoModule from 'tacendum-crypto';
import * as dbModule from './db';

/**
 * A PEER's device set — the receive half of multi-device: server-attested hint, client-verified truth.
 *
 * The server may ASSERT that a contact has siblings (the bundle's `siblings`
 * list); nothing here believes it. A sibling is auto-accepted only
 * when its link certificate verifies under an identity key this device
 * ALREADY pinned for that contact — the same libsignal verify primitive,
 * client-side (the `verifyLinkOp` entry
 * point). Anything else is held exactly like an identity change: the
 * inbound gate answers 'hold' (messages queued un-acked until the human
 * accepts — the standing contract), no fan-out leg targets it, and the UI
 * warns. This is the anti-silent-add defense the shared identity-key model
 * cannot have, and it is what turns the threat of a
 * compelled server forging rosters into a block-and-warn instead of a silent
 * widening.
 *
 * STATES, terminal rules included:
 *   'linked'   — cross-signed (or human-accepted); a fan-out target.
 *   'pending'  — asserted but unverifiable; block-and-warn, never a target.
 *   'removed'  — a signed unlink notice removed it (amicable).
 *   'revoked'  — a signed revoke notice killed it. TERMINAL like the own-
 *                roster rule: no served roster and no notice
 *                may ever flip 'revoked' back to 'linked'.
 *
 * The ANCHOR of a device set is the contact ULID this device first pinned —
 * the conversation's address. The anchor's own row (`anchorId === userId`)
 * is written at first bundle fetch, which is also the moment the native pin
 * store pins the identity (processPreKeyBundle): the JS row records the SAME
 * key at the SAME TOFU moment, so "an identity key the peer has ALREADY
 * pinned" is a fact this module can check without a native accessor.
 *
 * Deliberately deps-injected like linking.ts: the TOFU decisions are what
 * the device-added suite drives, and they need call ledgers plus a
 * deterministic verify — never a network, never a stubbed verdict.
 */

/* ── deps ─────────────────────────────────────────────────────────── */

export interface PeerDeviceRow {
  userId: string;
  /** The contact this device belongs to; `=== userId` for the contact
   * itself and for any standalone (post-dissolve) device. */
  anchorId: string;
  class: DeviceClass | 'unknown';
  state: 'linked' | 'pending' | 'removed' | 'revoked';
  /** The device's identity public key as pinned at TOFU time (base64). */
  identityKeyPub: string;
  /** The link certificates as served — invalidated (cleared) by a
   * verified dissolve. */
  certsJson: string;
  updatedAt: number;
}

export interface PeerDevicesDeps {
  db: {
    getPeerDevice(userId: string): Promise<PeerDeviceRow | null>;
    listPeerDevices(anchorId: string): Promise<PeerDeviceRow[]>;
    upsertPeerDevice(row: PeerDeviceRow): Promise<void>;
    /** When the ANCHOR is blocked, or null — the roster-keyed block source. */
    peerBlockedAt(peerId: string): Promise<number | null>;
    /** The auto-extension: a blocked contact's cross-signed sibling is
     * born blocked. */
    blockPeer(peerId: string, at: number): Promise<void>;
  };
  crypto: {
    verifyLinkOp(
      identityPubKeyB64: string,
      op: 'offer' | 'accept' | 'unlink' | 'revoke' | 'dissolve',
      tuple: LinkOpTuple,
      signatureB64: string,
    ): Promise<boolean>;
  };
  now(): number;
}

function defaultDeps(): PeerDevicesDeps {
  return {
    db: {
      getPeerDevice: dbModule.getPeerDevice,
      listPeerDevices: dbModule.listPeerDevices,
      upsertPeerDevice: dbModule.upsertPeerDevice,
      peerBlockedAt: dbModule.getBlockedAt,
      blockPeer: dbModule.blockPeer,
    },
    crypto: { verifyLinkOp: cryptoModule.verifyLinkOp },
    now: Date.now,
  };
}

/* ── the TOFU seed ────────────────────────────────────────────────── */

/**
 * Record a contact's own identity at the TOFU moment (first bundle fetch —
 * the same moment processPreKeyBundle pins it natively). Never overwrites a
 * recorded key on its own: a different key for the same ULID is the
 * identityChanged path's business, not a silent re-pin.
 *
 * TWO WAYS PAST THAT RULE, both owned by the accepted-identity-change path:
 * `force` re-pins outright, and a row whose key was UNPINNED
 * (`forgetPeerIdentity` — the empty key) takes the next served key exactly
 * as a first contact would. Either way the row keeps its place in the
 * device set (anchor, class, state, certs): what changed is the key, not
 * the relationship. */
export async function recordPeerIdentity(
  userId: string,
  identityKeyPub: string,
  deps: PeerDevicesDeps = defaultDeps(),
  opts: { force?: boolean } = {},
): Promise<void> {
  const existing = await deps.db.getPeerDevice(userId);
  if (existing && existing.identityKeyPub !== '' && !opts.force) return;
  await deps.db.upsertPeerDevice({
    userId,
    anchorId: existing?.anchorId ?? userId,
    class: existing?.class ?? 'unknown',
    state: existing?.state ?? 'linked',
    identityKeyPub,
    certsJson: existing?.certsJson ?? '',
    updatedAt: deps.now(),
  });
}

/**
 * UNPIN a contact's recorded key — the roster half of accepting a changed
 * safety number. The native TOFU pin is cleared by `resetPeer`; this row is
 * what verifies a signed `x.acct.notice` from the contact and what vouches
 * for their cross-signed siblings, and a key the human just retired must do
 * neither. An empty key is refused by every verifier here
 * (`applyPeerMutationNotice` drops, `applyServedRoster` does not trust it),
 * so the failure direction while unpinned is the safe one, and the next
 * served bundle re-pins through `recordPeerIdentity`'s empty-key path. A
 * no-op for an unknown contact: there is nothing to forget. */
export async function forgetPeerIdentity(
  userId: string,
  deps: PeerDevicesDeps = defaultDeps(),
): Promise<void> {
  const existing = await deps.db.getPeerDevice(userId);
  if (!existing || existing.identityKeyPub === '') return;
  await deps.db.upsertPeerDevice({
    ...existing,
    identityKeyPub: '',
    updatedAt: deps.now(),
  });
}

/* ── cross-signature verification ──────────────────────────── */

/**
 * Verify one link certificate as a statement about `candidate`'s key by a
 * key in `trustedKeys` (the per-op bindings): the offer's subject
 * is the ACCEPTOR's key, the acceptance's subject is the OFFERER's — so a
 * candidate that is the cert's acceptor is proven by the offerer's
 * signature, and a candidate that is its offerer by the acceptor's. Either
 * direction binds the candidate's ACTUAL key under a key the peer already
 * trusts, which is what "a certificate proves WHICH key was approved even
 * against a lying server" means.
 */
async function certProvesCandidate(
  deps: PeerDevicesDeps,
  trustedKeys: ReadonlyMap<string, string>,
  candidate: { userId: string; identityKeyPub: string },
  certs: GroupMemberCerts | undefined,
): Promise<boolean> {
  // A ceremony-less member (a solo-attach or recovery-attached
  // device) is served WITHOUT certs, honestly: there is nothing
  // to verify, so it cannot auto-accept and routes to block-and-warn ('pending')
  // exactly as an unverifiable cross-signature does. Absence beats forged bytes.
  if (!certs) return false;
  const tuple: LinkOpTuple = {
    groupId: certs.groupId,
    offererUserId: certs.offererUserId,
    acceptorUserId: certs.acceptorUserId,
    subjectIdentityPubKey: candidate.identityKeyPub,
    class: certs.class,
    rosterEpoch: certs.rosterEpoch,
    offerNonce: certs.offerNonce,
    expiresAt: certs.expiresAt,
  };
  if (certs.acceptorUserId === candidate.userId) {
    const signerKey = trustedKeys.get(certs.offererUserId);
    if (!signerKey) return false;
    return deps.crypto.verifyLinkOp(signerKey, 'offer', tuple, certs.offerSig);
  }
  if (certs.offererUserId === candidate.userId) {
    const signerKey = trustedKeys.get(certs.acceptorUserId);
    if (!signerKey) return false;
    return deps.crypto.verifyLinkOp(signerKey, 'accept', tuple, certs.acceptSig);
  }
  return false;
}

/* ── the served roster (bundle `siblings`) ──────────────────── */

/** One sibling as the caller resolved it: the certs come from the served
 * roster; the identity key comes from the SIBLING's own bundle (fetched to
 * establish its session — the key the certificate must actually bind). */
export interface ServedSibling {
  userId: string;
  class: DeviceClass;
  /** Optional by design: the ceremony-less member classes carry
   * no certificate. An absent cert is block-and-warn, never an auto-accept. */
  certs?: GroupMemberCerts;
  identityKeyPub: string;
}

export interface SiblingFinding {
  userId: string;
  class: DeviceClass;
  /** 'accepted' surfaces the inline notice; 'unverified' is block-and-warn. */
  outcome: 'accepted' | 'unverified';
}

/**
 * Apply one served roster for a contact. Returns only what is NEW — the
 * findings the UI surfaces ("added a tablet" / the warning) — and applies
 * the rules: cross-signed ⇒ 'linked' (auto-accept, chains allowed: a
 * device certified by a device certified by the anchor verifies in the same
 * pass); unverifiable ⇒ 'pending' (the identityChanged hold); a 'revoked'
 * or 'removed' row NEVER resurrects; a blocked anchor's newly accepted
 * sibling is BORN BLOCKED (the roster-keyed auto-extension).
 */
export async function applyServedRoster(
  args: { anchorId: string; siblings: readonly ServedSibling[] },
  deps: PeerDevicesDeps = defaultDeps(),
): Promise<SiblingFinding[]> {
  const known = await deps.db.listPeerDevices(args.anchorId);
  const trustedKeys = new Map<string, string>();
  for (const row of known) {
    if (row.state === 'linked' && row.identityKeyPub !== '') {
      trustedKeys.set(row.userId, row.identityKeyPub);
    }
  }
  const knownById = new Map(known.map(r => [r.userId, r]));
  const findings: SiblingFinding[] = [];
  const anchorBlockedAt = await deps.db.peerBlockedAt(args.anchorId);
  // Fixpoint pass so a chain (anchor certifies B, B certifies C) resolves
  // regardless of served order; ≤3 members bounds this to a trivial loop.
  const pendingEval = args.siblings.filter(s => {
    const row = knownById.get(s.userId);
    // Terminal states never resurrect; an already-linked row is old news.
    return !row || row.state === 'pending';
  });
  const evaluated = new Set<string>();
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const sibling of pendingEval) {
      if (evaluated.has(sibling.userId)) continue;
      if (
        await certProvesCandidate(deps, trustedKeys, sibling, sibling.certs)
      ) {
        evaluated.add(sibling.userId);
        progressed = true;
        trustedKeys.set(sibling.userId, sibling.identityKeyPub);
        await deps.db.upsertPeerDevice({
          userId: sibling.userId,
          anchorId: args.anchorId,
          class: sibling.class,
          state: 'linked',
          identityKeyPub: sibling.identityKeyPub,
          certsJson: sibling.certs ? JSON.stringify(sibling.certs) : '',
          updatedAt: deps.now(),
        });
        // Report only a NEW acceptance (a pending row upgrading counts —
        // that is the moment the inline notice belongs to).
        findings.push({ userId: sibling.userId, class: sibling.class, outcome: 'accepted' });
        if (anchorBlockedAt != null) {
          // The design: the block keys on the roster and auto-extends — rotating
          // device ULIDs inside a group evades nothing.
          await deps.db.blockPeer(sibling.userId, deps.now());
        }
      }
    }
  }
  for (const sibling of pendingEval) {
    if (evaluated.has(sibling.userId)) continue;
    const row = knownById.get(sibling.userId);
    if (row?.state === 'pending') continue; // already held; nothing new
    await deps.db.upsertPeerDevice({
      userId: sibling.userId,
      anchorId: args.anchorId,
      class: sibling.class,
      state: 'pending',
      identityKeyPub: sibling.identityKeyPub,
      certsJson: sibling.certs ? JSON.stringify(sibling.certs) : '',
      updatedAt: deps.now(),
    });
    findings.push({ userId: sibling.userId, class: sibling.class, outcome: 'unverified' });
  }
  return findings;
}

/** The human reviewed the warning and accepted the device — the ONLY way
 * out of the 'pending' hold, exactly like accepting a key change. The
 * roster-keyed block extension applies here too: accepting a blocked
 * contact's device does not unblock them. */
export async function acceptPeerDevice(
  userId: string,
  deps: PeerDevicesDeps = defaultDeps(),
): Promise<void> {
  const row = await deps.db.getPeerDevice(userId);
  if (!row || row.state !== 'pending') return;
  await deps.db.upsertPeerDevice({ ...row, state: 'linked', updatedAt: deps.now() });
  if ((await deps.db.peerBlockedAt(row.anchorId)) != null) {
    await deps.db.blockPeer(userId, deps.now());
  }
}

/* ── signed peer-facing mutation notices (in-band) ─────── */

/**
 * One signed unlink/revoke/dissolve notice, received in-band from a peer's
 * device (the client half the server comment promised: "the SIGNED
 * peer-facing notices are the client's"). Verified against the ACTING
 * member's key as THIS device pinned it — server not consulted, server not
 * trusted — then applied:
 *
 *   unlink/revoke — the target leaves the contact's device set; fan-out
 *                   stops addressing it ("peers drop the device from
 *                   that contact's device set and stop fanning out to it").
 *   dissolve      — the peer-visible downgrade: the association drops,
 *                   every cached certificate for the group is invalidated
 *                   (the epoch moved), and the devices become the unrelated
 *                   standalone contacts they now are.
 *
 * 'dropped' for anything unverifiable: an unknown sender, an unpinned
 * acting member, a signature that does not verify. A forged notice moves
 * nothing.
 */
export async function applyPeerMutationNotice(
  args: {
    senderDeviceId: string;
    op: 'unlink' | 'revoke' | 'dissolve';
    tuple: LinkOpTuple;
    signature: string;
  },
  deps: PeerDevicesDeps = defaultDeps(),
): Promise<'applied' | 'dropped'> {
  const sender = await deps.db.getPeerDevice(args.senderDeviceId);
  if (!sender || sender.state !== 'linked') return 'dropped';
  // The acting member (tuple.offererUserId — the mutation binding)
  // must be a device this peer already pinned as linked in the SAME set.
  const actor = await deps.db.getPeerDevice(args.tuple.offererUserId);
  if (
    !actor ||
    actor.state !== 'linked' ||
    actor.anchorId !== sender.anchorId ||
    actor.identityKeyPub === ''
  ) {
    return 'dropped';
  }
  const verified = await deps.crypto.verifyLinkOp(
    actor.identityKeyPub,
    args.op,
    args.tuple,
    args.signature,
  );
  if (!verified) return 'dropped';

  if (args.op === 'dissolve') {
    // Every device of the set becomes its own standalone contact; the
    // cached certificates are invalidated with the association.
    const rows = await deps.db.listPeerDevices(actor.anchorId);
    for (const row of rows) {
      await deps.db.upsertPeerDevice({
        ...row,
        anchorId: row.userId,
        certsJson: '',
        updatedAt: deps.now(),
      });
    }
    return 'applied';
  }

  const target = await deps.db.getPeerDevice(args.tuple.acceptorUserId);
  if (!target || target.anchorId !== actor.anchorId) return 'dropped';
  await deps.db.upsertPeerDevice({
    ...target,
    state: args.op === 'unlink' ? 'removed' : 'revoked',
    updatedAt: deps.now(),
  });
  return 'applied';
}

/* ── what the send and receive paths read ─────────────────────────── */

/**
 * The devices a fan-out addresses for this contact: the anchor plus
 * every cross-signed sibling. A 'pending' device gets nothing (unverified),
 * a 'removed' or 'revoked' one gets ZERO legs — ever. Stable order: the
 * anchor first, then siblings by ULID.
 */
export async function fanoutDeviceSet(
  anchorId: string,
  deps: PeerDevicesDeps = defaultDeps(),
): Promise<string[]> {
  const rows = await deps.db.listPeerDevices(anchorId);
  const siblings = rows
    .filter(r => r.state === 'linked' && r.userId !== anchorId)
    .map(r => r.userId)
    .sort();
  const anchorRow = rows.find(r => r.userId === anchorId);
  // An unknown anchor still gets its leg — the pre-accounts path unchanged.
  return anchorRow == null || anchorRow.state === 'linked'
    ? [anchorId, ...siblings]
    : siblings.length > 0
      ? siblings
      : [];
}

/**
 * The inbound gate: 'hold' for a device in the 'pending' state —
 * messages from it stay queued UN-ACKED until the human accepts, exactly
 * the identityChanged contract — 'deliver' for everything else
 * (an unknown sender is an ordinary stranger conversation, not this
 * module's business).
 */
export async function inboundGateFor(
  senderId: string,
  deps: PeerDevicesDeps = defaultDeps(),
): Promise<'hold' | 'deliver'> {
  const row = await deps.db.getPeerDevice(senderId);
  return row?.state === 'pending' ? 'hold' : 'deliver';
}

/** The anchor (conversation address) a device ULID maps to, or the id
 * itself when unknown — how a sibling's leg lands in the contact's thread. */
export async function anchorFor(
  senderId: string,
  deps: PeerDevicesDeps = defaultDeps(),
): Promise<string> {
  const row = await deps.db.getPeerDevice(senderId);
  return row?.anchorId ?? senderId;
}
