import {
  AccountsNotice,
  LINK_OFFER_TTL_SECONDS,
  parseAccountsNoticeTolerant,
  type AccountsNoticeFrame,
  type DeviceClass,
  type LinkOfferInitResponse,
  type PrekeyBundle,
} from '@tacendum/shared';
import { ulid } from 'ulid';
import * as apiModule from './api';
import * as cryptoModule from 'tacendum-crypto';
import * as dbModule from './db';
import { currentToken } from './reauth';
import { DEVICE_SLOT_CLASS, type DeviceSlotClass } from './deviceNoun';

/**
 * The device-linking ceremony, client half —
 * both sides of it, plus the local roster the "Linked devices" screen
 * renders. Screens drive this module; this module drives api + native
 * signing + the local database, and NOTHING here mints a QR payload: the
 * new device shows its EXISTING self-QR (the bare 26-char ULID,
 * `qr.ts selfPayload`) and the scan side reuses the existing scan pipeline.
 * No scheme, no URL, no deep link — enforced by a verify
 * grep.
 *
 * THE STALL IS THE DESIGN (the central property, and the link-ceremony
 * suite's central assertion): a scanned ULID alone NEVER produces a link.
 * The offerer ceremony performs no network mutation until the human
 * confirms the verification code on THIS device (`confirm()` — the scanner
 * is a party to the ceremony, not a camera), and even then it only ever
 * produces an OFFER: the roster moves when the OTHER device's human
 * confirms the same code and its identity key signs the acceptance,
 * verified server-side. An offer nobody accepts stalls and TTLs away.
 *
 * The verification code is the safety-number primitive already in use: derived natively from BOTH identity public keys after the
 * peer's bundle is pinned, displayed as the familiar digit groups. One
 * code, two screens, both confirmed — a substituted self-QR makes the codes
 * disagree and the ceremony dies visibly on either screen. FAIL-CLOSED on
 * the code itself: a null safety number — the native pin
 * store not holding the peer — refuses the ceremony outright on BOTH
 * sides. Two blank codes never disagree, so a missing code must never
 * reach a confirm button.
 *
 * Injected deps, jest-style: the ceremony logic is testable against fakes
 * (the suite's whole point is asserting what NEVER happens — no submit
 * before confirm — which needs call ledgers, not a network).
 */

// The consent-grade copy deck lives in `linkingCopy.ts` — a PURE module the
// device-noun suite loads per idiom — and is re-exported
// here so screens keep one import for ceremony + words.
export { LINKING_COPY } from './linkingCopy';

/* ── deps ─────────────────────────────────────────────────────────── */

export interface LinkingDeps {
  api: {
    getPrekeyBundle(token: string, userId: string): Promise<PrekeyBundle>;
    linkOfferInit(
      token: string,
      body: {
        acceptorUserId: string;
        acceptorClass: DeviceClass;
        offererClass?: DeviceClass;
      },
    ): Promise<LinkOfferInitResponse>;
    linkOfferSubmit(token: string, offerNonce: string, signature: string): Promise<void>;
    linkAccept(token: string, offerNonce: string, signature: string): Promise<void>;
    rosterMutation(
      token: string,
      op: 'unlink' | 'revoke',
      body: {
        groupId: string;
        targetUserId: string;
        targetClass: DeviceClass;
        rosterEpoch: number;
        offerNonce: string;
        expiresAt: number;
        signature: string;
        boundAgents?: string[];
      },
    ): Promise<void>;
  };
  crypto: {
    processPreKeyBundle(bundle: PrekeyBundle, selfUserId: string): Promise<void>;
    safetyNumber(selfUserId: string, peerUserId: string): Promise<string | null>;
    signLinkOp(
      op: 'offer' | 'accept' | 'unlink' | 'revoke' | 'dissolve',
      tuple: {
        groupId: string;
        offererUserId: string;
        acceptorUserId: string;
        subjectIdentityPubKey: string;
        class: DeviceClass;
        rosterEpoch: number;
        offerNonce: string;
        expiresAt: number;
      },
    ): Promise<string>;
    /** The verify half: same preimage family, libsignal
     * verify, client-side. */
    verifyLinkOp(
      identityPubKeyB64: string,
      op: 'offer' | 'accept' | 'unlink' | 'revoke' | 'dissolve',
      tuple: {
        groupId: string;
        offererUserId: string;
        acceptorUserId: string;
        subjectIdentityPubKey: string;
        class: DeviceClass;
        rosterEpoch: number;
        offerNonce: string;
        expiresAt: number;
      },
      signatureB64: string,
    ): Promise<boolean>;
    /** This device's own registered identity public key (null pre-keys). */
    identityPublicKey(): Promise<string | null>;
  };
  db: Pick<
    typeof dbModule,
    | 'loadLinkGroup'
    | 'saveLinkGroup'
    | 'upsertLinkedDevice'
    | 'markLinkedDeviceState'
    | 'listLinkedDevices'
    | 'clearLinkGroup'
    | 'savePendingLinkOffer'
    | 'loadPendingLinkOffer'
    | 'deletePendingLinkOffer'
    | 'savePendingLinkCeremony'
    | 'loadPendingLinkCeremony'
    | 'deletePendingLinkCeremony'
    | 'pristineForLink'
    | 'savePendingLinkMutation'
    | 'listPendingLinkMutations'
    | 'deletePendingLinkMutation'
    | 'listSiblingAgents'
    | 'saveRecoveryNotice'
    | 'loadRecoveryNotice'
    | 'clearUsernameIdentifier'
    | 'saveUsernameNotice'
  >;
  token(): Promise<string | null>;
  selfId(): Promise<string | null>;
  now(): number;
  freshNonce(): string;
}

function defaultDeps(): LinkingDeps {
  return {
    api: {
      getPrekeyBundle: apiModule.apiGetPrekeyBundle,
      linkOfferInit: apiModule.apiLinkOfferInit,
      linkOfferSubmit: apiModule.apiLinkOfferSubmit,
      linkAccept: apiModule.apiLinkAccept,
      rosterMutation: apiModule.apiDeviceRosterMutation,
    },
    crypto: {
      processPreKeyBundle: cryptoModule.processPreKeyBundle,
      safetyNumber: cryptoModule.safetyNumber,
      signLinkOp: cryptoModule.signLinkOp,
      verifyLinkOp: cryptoModule.verifyLinkOp,
      identityPublicKey: cryptoModule.identityPublicKey,
    },
    db: dbModule,
    token: currentToken,
    selfId: async () => (await dbModule.loadProfile())?.userId ?? null,
    now: Date.now,
    freshNonce: () => ulid(),
  };
}

/** This device's own account-slot class (the offering device declares
 * classes at link time). Resolved in deviceNoun.ts from the SAME idiom
 * facts as the noun — an account-slot concept, never a UI/window fact, and the desktop slot is refused in v1 so nothing here can ever
 * produce it. */
export function localDeviceClass(): DeviceSlotClass {
  return DEVICE_SLOT_CLASS;
}

/** The ceremony could not derive a verification code (the native safety
 * number came back null — the peer identity is not in the pin store). A
 * hard refusal, never a blank code region: two blank codes never disagree. */
export class NoVerificationCodeError extends Error {
  constructor() {
    super('no verification code');
    this.name = 'NoVerificationCodeError';
  }
}

/** The served bundle must name the account it was asked for: a bundle for
 * ULID_X carrying a different userId pins the key under the WRONG address
 * while the ceremony would sign the served key — the exact divergence that
 * lets a lying server obtain a certificate over a key no human ever saw. `api.ts` enforces the same check for every
 * caller; this one keeps the property testable against injected fakes. */
function assertBundleNames(bundle: PrekeyBundle, userId: string): void {
  if (bundle.userId !== userId) {
    throw new Error('prekey bundle names the wrong account');
  }
}

/* ── change events (screens subscribe; module is UI-free) ─────────── */

type Listener = () => void;
const rosterListeners = new Set<Listener>();
const pendingOfferListeners = new Set<Listener>();

/**
 * A committed roster mutation whose SIGNED statement peers must now hear
 * (the design/the design in-band notice PRODUCER's
 * feed): the exact op-framed mutation tuple the acting member's identity
 * key signed, plus that signature, byte-for-byte what the server verified.
 * messaging subscribes and fans the `x.acct.notice` envelope to every
 * known peer device inside the ratchet; this module stays UI- and
 * transport-free.
 */
export interface PeerRosterNotice {
  op: 'unlink' | 'revoke' | 'dissolve';
  tuple: {
    groupId: string;
    offererUserId: string;
    acceptorUserId: string;
    subjectIdentityPubKey: string;
    class: DeviceClass;
    rosterEpoch: number;
    offerNonce: string;
    expiresAt: number;
  };
  signature: string;
}

type PeerNoticeListener = (notice: PeerRosterNotice) => void | Promise<void>;
const peerNoticeListeners = new Set<PeerNoticeListener>();
/** Recovery notices (loudness, the client half): fired when a
 * recoveryRequested / -Cancelled /
 * -Completed notice lands, so the linked-devices surface re-reads the
 * stored row without polling. */
const recoveryNoticeListeners = new Set<Listener>();

export function onRosterChanged(listener: Listener): () => void {
  rosterListeners.add(listener);
  return () => rosterListeners.delete(listener);
}

export function onPendingOffer(listener: Listener): () => void {
  pendingOfferListeners.add(listener);
  return () => pendingOfferListeners.delete(listener);
}

export function onRecoveryNotice(listener: Listener): () => void {
  recoveryNoticeListeners.add(listener);
  return () => recoveryNoticeListeners.delete(listener);
}

/** Fires when a `usernameRevoked` notice lands:
 * the username surface re-reads its row and the stored notice. */
const usernameNoticeListeners = new Set<Listener>();
export function onUsernameNotice(listener: Listener): () => void {
  usernameNoticeListeners.add(listener);
  return () => usernameNoticeListeners.delete(listener);
}

export function onPeerRosterNotice(listener: PeerNoticeListener): () => void {
  peerNoticeListeners.add(listener);
  return () => peerNoticeListeners.delete(listener);
}

/** Fan a peer-facing notice to every listener. Returns the listeners'
 * combined completion: the ordinary producers
 * fire-and-forget it, but the DISSOLVE producer awaits it, so its
 * peer-visible statement is durably enqueued before any roster mutation —
 * a rejection there propagates to the awaiting caller instead of being
 * swallowed. Synchronous listener throws are still contained per listener
 * for the fire-and-forget callers' sake. */
function notifyPeerNotice(notice: PeerRosterNotice): Promise<void> {
  const settled: Array<Promise<void>> = [];
  for (const listener of [...peerNoticeListeners]) {
    try {
      const result = listener(notice);
      if (result instanceof Promise) settled.push(result);
    } catch (error) {
      console.warn(
        `[linking] peer-notice listener failed: ${error instanceof Error ? error.name : 'unknown'}`,
      );
    }
  }
  return Promise.all(settled).then(() => undefined);
}

function notify(listeners: Set<Listener>): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch (error) {
      console.warn(
        `[linking] listener failed: ${error instanceof Error ? error.name : 'unknown'}`,
      );
    }
  }
}

/* ── the offerer ceremony (scan side, ULID_A) ─────────────────────── */

export type OffererPhase = 'code' | 'submitting' | 'waiting' | 'linked' | 'failed';

/** The durable record of a submitted-but-uncommitted offer:
 * the offerer is deliberately excluded from the memberLinked fan-out
 * (the ceremony parties already know), so if the scan screen
 * unmounts between submit and the acceptance, this row is the ONLY path by
 * which this device ever learns it is grouped. `reconcilePendingLink`
 * drives it. */
interface PendingOffererCeremony {
  groupId: string;
  rosterEpoch: number;
  offerNonce: string;
  expiresAt: number;
  acceptorUserId: string;
  acceptorClass: DeviceClass;
  /** The joiner's identity key as the ceremony pinned it at begin() — the
   * dual-code human check ran against THIS key, so completion verifies
   * against it, never against whatever a later bundle serves. */
  acceptorIdentityKey: string;
}

/**
 * One completion probe against the joiner's bundle: its `siblings` list
 * names THIS device once the acceptance committed. Shared by the live
 * ceremony's `checkLinked` and by `reconcilePendingLink` (the unmounted
 * case), so the two paths cannot drift. True = linked; the durable pending
 * row is consumed and the local roster stored.
 */
async function completeOffererLink(
  deps: LinkingDeps,
  selfUserId: string,
  pending: PendingOffererCeremony,
): Promise<boolean> {
  const token = await deps.token();
  if (!token) return false;
  const bundle = await deps.api.getPrekeyBundle(token, pending.acceptorUserId);
  assertBundleNames(bundle, pending.acceptorUserId);
  // The served key must BE the key the dual-code ceremony pinned at begin():
  // a different key for the same ULID is the identityChanged class of event,
  // never a completion.
  if (bundle.identityKey !== pending.acceptorIdentityKey) return false;
  const siblings = bundle.siblings ?? [];
  const mine = siblings.find(s => s.userId === selfUserId);
  if (!mine) return false;
  // The roster entry naming THIS device MUST carry the ceremony's certificates
  // — the acceptance we verify below. A certless self entry (a server serving
  // us as a ceremony-less member — the certs-optional change) proves
  // nothing, so completion just keeps stalling, the ceremony's designed answer
  // to a lie.
  if (!mine.certs) return false;
  // CLIENT-VERIFIED COMPLETION (tuple binding hardened at
  // a hardening pass): the roster entry naming THIS device
  // carries the ceremony's certificates — the acceptance IS the joiner's
  // certification of us, so it must verify: signer = the CEREMONY-PINNED
  // joiner key, subject = OUR registered key, and every context field from
  // OUR OWN pending record (group, nonce, epoch, class, expiry) — never
  // from the served certificate, which a lying server could swap for any
  // other ceremony's. A server asserting membership without the genuine
  // acceptance over THIS ceremony's tuple completes nothing — the probe
  // just keeps stalling, which is the ceremony's designed answer to a lie.
  const ownKey = await deps.crypto.identityPublicKey();
  if (ownKey === null) return false;
  const acceptVerified = await deps.crypto.verifyLinkOp(
    pending.acceptorIdentityKey,
    'accept',
    {
      groupId: pending.groupId,
      offererUserId: selfUserId,
      acceptorUserId: pending.acceptorUserId,
      subjectIdentityPubKey: ownKey,
      class: pending.acceptorClass,
      rosterEpoch: pending.rosterEpoch,
      offerNonce: pending.offerNonce,
      expiresAt: pending.expiresAt,
    },
    mine.certs.acceptSig,
  );
  if (!acceptVerified) return false;
  const epoch = bundle.rosterVersion ?? pending.rosterEpoch + 1;
  await deps.db.saveLinkGroup(pending.groupId, epoch);
  const now = deps.now();
  // EXACTLY the two ceremony parties join the local roster: the joiner
  // (verified above; its key is the ceremony-pinned one) and this device.
  // Any OTHER ULID the served list asserts is NOT blanket-linked (a review
  // finding — a server-injected row would become a sibling-sync
  // recipient); in v1's two-occupiable-slot world no third member can
  // exist, and a future member announces itself through the SIGNED
  // memberLinked notice, which verifies or drops.
  await deps.db.upsertLinkedDevice({
    userId: pending.acceptorUserId,
    class: pending.acceptorClass,
    state: 'linked',
    updatedAt: now,
    certsJson: JSON.stringify(mine.certs),
    identityKeyPub: pending.acceptorIdentityKey,
  });
  await deps.db.upsertLinkedDevice({
    userId: selfUserId,
    class: localDeviceClass(),
    state: 'linked',
    updatedAt: now,
    certsJson: JSON.stringify(mine.certs),
    identityKeyPub: ownKey,
  });
  await deps.db.deletePendingLinkCeremony();
  notify(rosterListeners);
  return true;
}

/**
 * Drive the durable pending-offer record to completion outside the scan
 * screen's lifetime: called when the Linked-devices screen
 * opens, and before a solo `confirm()` declares an offererClass. Without
 * this, a person who backgrounds the app between submit and acceptance is
 * server-side grouped while every local surface says otherwise — the
 * roster screen renders a false "alone" sentence, unlink/revoke throw, and
 * the next ceremony is refused for re-declaring a class.
 *
 * Each attempt consumes one of the joiner's one-time prekeys, so callers
 * are user-action-paced (a screen open, a new ceremony), never a poll.
 */
export async function reconcilePendingLink(
  deps: LinkingDeps = defaultDeps(),
): Promise<boolean> {
  const stored = await deps.db.loadPendingLinkCeremony();
  if (!stored) return false;
  let pending: PendingOffererCeremony;
  try {
    pending = JSON.parse(stored.offerJson) as PendingOffererCeremony;
    if (
      typeof pending.acceptorUserId !== 'string' ||
      typeof pending.groupId !== 'string' ||
      typeof pending.acceptorIdentityKey !== 'string' ||
      pending.acceptorIdentityKey === ''
    ) {
      throw new Error('malformed');
    }
  } catch {
    await deps.db.deletePendingLinkCeremony();
    return false;
  }
  if (Math.floor(deps.now() / 1000) >= pending.expiresAt) {
    await deps.db.deletePendingLinkCeremony();
    return false;
  }
  const selfUserId = await deps.selfId();
  if (!selfUserId) return false;
  try {
    return await completeOffererLink(deps, selfUserId, pending);
  } catch {
    return false; // Transient; the row survives for the next surface open.
  }
}

/**
 * The scan side's ceremony, begun AFTER the existing scan pipeline produced
 * a bare ULID (qr.ts `readIdFromCamera` / `readIdFromImage` — the same
 * guards, the same single validator; context supplies semantics). Fetches the joiner's bundle, pins its identity, derives the
 * verification code — and then STOPS. `confirm()` is the only way forward,
 * and it is the human's.
 */
export class OffererCeremony {
  phase: OffererPhase = 'code';
  /** The safety-number string both screens show, from both identity keys.
   * Non-null by construction: `begin()` refuses the ceremony when no code
   * can be derived. */
  readonly code: string;
  readonly acceptorId: string;
  private readonly acceptorIdentityKey: string;
  private readonly selfUserId: string;
  private readonly deps: LinkingDeps;
  private init: LinkOfferInitResponse | null = null;
  // Set at confirm() before any read (checkLinked runs only past it).
  private acceptorClass!: DeviceClass;

  private constructor(
    deps: LinkingDeps,
    selfUserId: string,
    acceptorId: string,
    acceptorIdentityKey: string,
    code: string,
  ) {
    this.deps = deps;
    this.selfUserId = selfUserId;
    this.acceptorId = acceptorId;
    this.acceptorIdentityKey = acceptorIdentityKey;
    this.code = code;
  }

  static async begin(
    scannedId: string,
    deps: LinkingDeps = defaultDeps(),
  ): Promise<OffererCeremony> {
    const token = await deps.token();
    const selfUserId = await deps.selfId();
    if (!token || !selfUserId) throw new Error('no account');
    // Fetch + pin the joiner's identity (keys.ts route; TOFU pin store),
    // then derive ONE code from BOTH identity public keys — the
    // safety-number primitive already in use. Read-only so
    // far as any roster is concerned: nothing here can move a group.
    const bundle = await deps.api.getPrekeyBundle(token, scannedId);
    assertBundleNames(bundle, scannedId);
    await deps.crypto.processPreKeyBundle(bundle, selfUserId);
    const code = await deps.crypto.safetyNumber(selfUserId, scannedId);
    // No code, no ceremony (blocker 1): the dual-code comparison
    // is the ceremony's one human check, and it cannot run against a blank.
    if (code === null) throw new NoVerificationCodeError();
    return new OffererCeremony(deps, selfUserId, scannedId, bundle.identityKey, code);
  }

  /**
   * The human confirmed the code on THIS device (the existing
   * device first). Only now does the ceremony touch the server's linking
   * routes: INIT returns the server-minted tuple, the identity key signs
   * the op-framed offer preimage natively, SUBMIT verifies and stores it.
   * The result is an OFFER — the roster moves only on the other device's
   * signed, confirmed acceptance.
   */
  async confirm(acceptorClass: DeviceSlotClass): Promise<void> {
    if (this.phase !== 'code') throw new Error('ceremony is not awaiting confirmation');
    this.phase = 'submitting';
    try {
      const token = await this.deps.token();
      if (!token) throw new Error('no account');
      this.acceptorClass = acceptorClass;
      let grouped = await this.deps.db.loadLinkGroup();
      if (!grouped) {
        // A committed-but-unrecorded earlier ceremony: reconcile
        // before declaring a solo offererClass the server would refuse.
        await reconcilePendingLink(this.deps);
        grouped = await this.deps.db.loadLinkGroup();
      }
      const init = await this.deps.api.linkOfferInit(token, {
        acceptorUserId: this.acceptorId,
        acceptorClass,
        // First link only: A declares its own slot; a grouped offerer's
        // roster already knows and the server refuses a redundant claim.
        ...(grouped ? {} : { offererClass: localDeviceClass() }),
      });
      this.init = init;
      const signature = await this.deps.crypto.signLinkOp('offer', {
        groupId: init.groupId,
        offererUserId: this.selfUserId,
        acceptorUserId: this.acceptorId,
        // A's signature certifies WHICH key it is pulling into the group
        // (per-op binding: the offer names the ACCEPTOR's registered key).
        subjectIdentityPubKey: this.acceptorIdentityKey,
        class: acceptorClass,
        rosterEpoch: init.rosterEpoch,
        offerNonce: init.offerNonce,
        expiresAt: init.expiresAt,
      });
      await this.deps.api.linkOfferSubmit(token, init.offerNonce, signature);
      // Durable record of the live offer: the completion probe
      // survives the screen — see `reconcilePendingLink`.
      const pending: PendingOffererCeremony = {
        groupId: init.groupId,
        rosterEpoch: init.rosterEpoch,
        offerNonce: init.offerNonce,
        expiresAt: init.expiresAt,
        acceptorUserId: this.acceptorId,
        acceptorClass,
        acceptorIdentityKey: this.acceptorIdentityKey,
      };
      await this.deps.db.savePendingLinkCeremony(JSON.stringify(pending), this.deps.now());
      this.phase = 'waiting';
    } catch (error) {
      this.phase = 'failed';
      throw error;
    }
  }

  /**
   * One completion probe (the screen paces these; the re-fetch site):
   * the joiner's bundle grows `siblings` naming THIS device once the
   * acceptance committed. True = linked, roster stored locally. Bounded by
   * the offer's own expiry — after it, the ceremony reports failure.
   * NOTE the honest cost: every probe consumes one of the joiner's
   * one-time prekeys (GET /v1/keys is an atomic consume), which is why the
   * screen's pacing backs off — see LinkDeviceScreen's budget arithmetic.
   */
  async checkLinked(): Promise<boolean> {
    if (this.phase !== 'waiting' || !this.init) return this.phase === 'linked';
    if (Math.floor(this.deps.now() / 1000) >= this.init.expiresAt) {
      this.phase = 'failed';
      await this.deps.db.deletePendingLinkCeremony();
      return false;
    }
    const token = await this.deps.token();
    if (!token) return false;
    const linked = await completeOffererLink(this.deps, this.selfUserId, {
      groupId: this.init.groupId,
      rosterEpoch: this.init.rosterEpoch,
      offerNonce: this.init.offerNonce,
      expiresAt: this.init.expiresAt,
      acceptorUserId: this.acceptorId,
      acceptorClass: this.acceptorClass,
      acceptorIdentityKey: this.acceptorIdentityKey,
    });
    if (linked) this.phase = 'linked';
    return linked;
  }
}

/* ── the acceptor ceremony (new-device side, ULID_B) ──────────────── */

export type LinkOfferNotice = Extract<AccountsNotice, { kind: 'linkOffer' }>;

export type AcceptorPhase = 'code' | 'accepting' | 'linked' | 'failed';

export class AcceptorCeremony {
  phase: AcceptorPhase = 'code';
  readonly offer: LinkOfferNotice;
  /** The same code the offerer's screen shows — derived independently from
   * both identity public keys. Non-null by construction:
   * `open()` refuses when no code can be derived (fail-closed). */
  readonly code: string;
  private readonly offererIdentityKey: string;
  private readonly selfUserId: string;
  private readonly deps: LinkingDeps;

  private constructor(
    deps: LinkingDeps,
    selfUserId: string,
    offer: LinkOfferNotice,
    offererIdentityKey: string,
    code: string,
  ) {
    this.deps = deps;
    this.selfUserId = selfUserId;
    this.offer = offer;
    this.offererIdentityKey = offererIdentityKey;
    this.code = code;
  }

  /**
   * Open the newest live pending offer for display, or null when there is
   * none: expired, unparseable, and mis-addressed rows are dropped AND the
   * next-newest row is tried (one stale late offer must never
   * mask a live earlier one), a NON-PRISTINE device refuses to even show
   * the ceremony (client half — the server's transaction
   * conditions are the enforcement; this is the honest local mirror, and
   * the screen renders `LINKING_COPY.notPristine`), and an offer naming a
   * slot class this device is NOT answers 'class_mismatch' — B's signature
   * asserts the class about ITSELF, and a device does not sign a statement
   * about itself that it can see is false.
   */
  static async open(
    deps: LinkingDeps = defaultDeps(),
  ): Promise<AcceptorCeremony | 'not_pristine' | 'class_mismatch' | null> {
    const token = await deps.token();
    const selfUserId = await deps.selfId();
    if (!token || !selfUserId) return null;
    for (;;) {
      const stored = await deps.db.loadPendingLinkOffer();
      if (!stored) return null;
      let offer: LinkOfferNotice;
      try {
        const parsed = AccountsNotice.parse(JSON.parse(stored.noticeJson));
        if (parsed.kind !== 'linkOffer') throw new Error('not an offer');
        offer = parsed;
      } catch {
        await deps.db.deletePendingLinkOffer(stored.offerNonce);
        continue;
      }
      if (Math.floor(deps.now() / 1000) >= offer.expiresAt) {
        await deps.db.deletePendingLinkOffer(stored.offerNonce);
        continue;
      }
      if (offer.acceptorUserId !== selfUserId) {
        // Stored for an account this install no longer is — dead weight
        // that would otherwise be re-read forever.
        await deps.db.deletePendingLinkOffer(stored.offerNonce);
        continue;
      }
      if (!(await deps.db.pristineForLink())) return 'not_pristine';
      if (offer.acceptorClass !== localDeviceClass()) return 'class_mismatch';
      const bundle = await deps.api.getPrekeyBundle(token, offer.offererUserId);
      assertBundleNames(bundle, offer.offererUserId);
      // CLIENT-VERIFIED TRUTH: the offer signature is verified HERE, before any confirm
      // surface exists — signer = the offerer's served-and-pinned identity
      // key, subject = THIS device's own registered key (the offer preimage
      // names the acceptor's key). A forged or foreign
      // `offerSig` — the ASCII string "OFFERSIG" included — is dead weight:
      // the row reaps and the next-newest offer is tried, exactly like an
      // expired one. The dual-code human check remains; this puts the
      // cryptographic half back where "client-verified truth" promised it.
      const ownKey = await deps.crypto.identityPublicKey();
      if (ownKey === null) return null; // no identity yet — nothing to link
      const offerVerified = await deps.crypto.verifyLinkOp(
        bundle.identityKey,
        'offer',
        {
          groupId: offer.groupId,
          offererUserId: offer.offererUserId,
          acceptorUserId: offer.acceptorUserId,
          subjectIdentityPubKey: ownKey,
          class: offer.acceptorClass,
          rosterEpoch: offer.rosterEpoch,
          offerNonce: offer.offerNonce,
          expiresAt: offer.expiresAt,
        },
        offer.offerSig,
      );
      if (!offerVerified) {
        await deps.db.deletePendingLinkOffer(stored.offerNonce);
        continue;
      }
      await deps.crypto.processPreKeyBundle(bundle, selfUserId);
      const code = await deps.crypto.safetyNumber(selfUserId, offer.offererUserId);
      // No code, no confirm surface (blocker 1). The offer row is
      // kept: a transient native degradation must not consume it.
      if (code === null) throw new NoVerificationCodeError();
      return new AcceptorCeremony(deps, selfUserId, offer, bundle.identityKey, code);
    }
  }

  /**
   * The human compared the two screens and confirmed on the NEW device
   * (the confirmation is mutual by construction). B's
   * identity key signs the op-framed acceptance natively; the server
   * verifies BOTH signatures and the transaction's conditions decide.
   */
  async accept(): Promise<void> {
    if (this.phase !== 'code') throw new Error('ceremony is not awaiting confirmation');
    // Defense in depth behind open()'s check: the class in the tuple is an
    // assertion about THIS device, and this device does not sign a false one.
    if (this.offer.acceptorClass !== localDeviceClass()) {
      throw new Error('offer names a class this device is not');
    }
    this.phase = 'accepting';
    try {
      const token = await this.deps.token();
      if (!token) throw new Error('no account');
      const signature = await this.deps.crypto.signLinkOp('accept', {
        groupId: this.offer.groupId,
        offererUserId: this.offer.offererUserId,
        acceptorUserId: this.selfUserId,
        // B's signature certifies WHICH key invited it (the
        // acceptance names the OFFERER's registered key).
        subjectIdentityPubKey: this.offererIdentityKey,
        class: this.offer.acceptorClass,
        rosterEpoch: this.offer.rosterEpoch,
        offerNonce: this.offer.offerNonce,
        expiresAt: this.offer.expiresAt,
      });
      await this.deps.api.linkAccept(token, this.offer.offerNonce, signature);
      // Committed. Learn the roster (classes + certs) from this device's OWN
      // bundle: its `siblings` list is exactly the group's other members.
      // Costs one of our own one-time prekeys, once per ceremony — the only
      // roster read the server serves, and bounded by construction.
      await this.deps.db.saveLinkGroup(this.offer.groupId, this.offer.rosterEpoch + 1);
      const now = this.deps.now();
      // This device's own row: the roster this screen renders
      // includes "This device", exactly as the offerer's side does — two
      // members, one ceremony, one list on both screens.
      await this.deps.db.upsertLinkedDevice({
        userId: this.selfUserId,
        class: this.offer.acceptorClass,
        state: 'linked',
        updatedAt: now,
        certsJson: '',
        identityKeyPub: (await this.deps.crypto.identityPublicKey()) ?? '',
      });
      try {
        const own = await this.deps.api.getPrekeyBundle(token, this.selfUserId);
        assertBundleNames(own, this.selfUserId);
        for (const sibling of own.siblings ?? []) {
          // ONLY the ceremony counterpart joins from the served list: its
          // identity was pinned and code-checked by THIS ceremony. Any
          // other served ULID is not blanket-linked (an
          // injected row would become a sibling-sync recipient);
          // a genuine third member announces itself through the SIGNED
          // memberLinked notice, which verifies or drops.
          if (sibling.userId !== this.offer.offererUserId) continue;
          await this.deps.db.upsertLinkedDevice({
            userId: sibling.userId,
            class: sibling.class,
            state: 'linked',
            updatedAt: now,
            certsJson: JSON.stringify(sibling.certs),
            // The offerer's key the ceremony itself pinned.
            identityKeyPub: this.offererIdentityKey,
          });
        }
        if (own.rosterVersion !== undefined) {
          await this.deps.db.saveLinkGroup(this.offer.groupId, own.rosterVersion);
        }
      } catch {
        // The link is committed either way; the roster fills in from
        // notices and later fetches. Loudness, never correctness.
      }
      await this.deps.db.deletePendingLinkOffer(this.offer.offerNonce);
      this.phase = 'linked';
      notify(rosterListeners);
      notify(pendingOfferListeners);
    } catch (error) {
      this.phase = 'failed';
      throw error;
    }
  }

  /** The codes disagreed, or the human declined: the ceremony dies visibly. No server call — the un-accepted offer is single-use
   * and TTLs away against nothing. */
  async decline(): Promise<void> {
    await this.deps.db.deletePendingLinkOffer(this.offer.offerNonce);
    notify(pendingOfferListeners);
  }
}

/* ── inbound notices (messaging routes 'accounts' frames here) ────── */

/** 'stored' — applied or persisted; 'dropped' — malformed, expired, replayed
 * or implausible (acked, never applied); 'ignored' — a WELL-FORMED notice
 * of a kind this build does not know (the
 * tolerant-unknown-kind fallback): acked and tolerated, never a parse
 * failure, never applied. Every outcome acks — the caller cannot tell them
 * apart and must not: a future kind is not poison. */
export type NoticeOutcome = 'stored' | 'dropped' | 'ignored';

const B64_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_LOOKUP = new Map([...B64_ALPHABET].map((c, i) => [c, i] as const));

/** Decode a notice payload (base64 of `AccountsNotice` JSON). Hermes ships
 * `atob`; the fallback is the same pure decode the tacendum-crypto facade
 * carries (an encoding transform, not cryptography). The payload is ASCII
 * by construction — ULIDs, class enums, integers, base64 signatures, all
 * zod-validated right after — so the latin1/utf8 distinction cannot arise,
 * and a payload that somehow isn't ASCII fails the parse below. */
function b64ToJsonText(b64: string): string {
  const g = globalThis as { atob?: (data: string) => string };
  if (typeof g.atob === 'function') return g.atob(b64);
  const clean = b64.replace(/=+$/, '');
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const char of clean) {
    const value = B64_LOOKUP.get(char);
    if (value === undefined) throw new Error('invalid base64 payload');
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out += String.fromCharCode((buffer >> bits) & 0xff);
    }
  }
  return out;
}

/**
 * One server-minted accounts notice off the durable queue
 * (`AccountsNoticeFrame`). Returns 'stored' or
 * 'dropped' — either way the caller acks (a malformed or expired notice
 * redelivered forever would be a poison row; the offer's durable copy is
 * written BEFORE the ack, so a crash loses nothing).
 *
 * EPOCH MONOTONICITY: the member* notices carry no
 * signature on the wire — the schema gap is a known ledgered item — so
 * the one check the client CAN make, it makes: a notice whose rosterEpoch
 * is behind local truth is a replay and is dropped, never applied. Ack
 * ordering makes redelivery routine, and a `memberLinked` redelivered
 * after a revoke would otherwise resurrect the revoked row in the roster
 * UI. A 'revoked' row never flips back to 'linked' at all: the tombstoned
 * key can never re-auth, so no honest notice can re-link that ULID.
 */
export async function handleAccountsNoticeFrame(
  frame: AccountsNoticeFrame,
  deps: LinkingDeps = defaultDeps(),
): Promise<NoticeOutcome> {
  // THE TOLERANT PARSE (the client half, shipped early
  // so the store fleet can absorb kinds minted after it):
  // a malformed frame drops as ever; a well-formed notice of a kind this
  // build does not know is IGNORED — acked, never applied, never a parse
  // failure that would read as poison. No OTA exists, so this fallback is
  // what lets a later server speak first and a later build render second.
  let parsed: ReturnType<typeof parseAccountsNoticeTolerant>;
  try {
    parsed = parseAccountsNoticeTolerant(JSON.parse(b64ToJsonText(frame.payload)));
  } catch {
    return 'dropped';
  }
  if (parsed.outcome === 'malformed') return 'dropped';
  if (parsed.outcome === 'unknown') return 'ignored';
  const notice: AccountsNotice = parsed.notice;
  const nowSeconds = Math.floor(deps.now() / 1000);
  switch (notice.kind) {
    case 'linkOffer': {
      //, with two refusals BEFORE anything is shown: an offer
      // already past its explicit expiry, and — the client pristineness
      // half — an offer to a lived-in device. The latter is dropped
      // silently rather than surfaced: a lived-in standalone account
      // cannot be pulled into someone's group, and rendering
      // a confirm surface that can only fail would teach people to tap
      // through refusals.
      if (nowSeconds >= notice.expiresAt) return 'dropped';
      const selfUserId = await deps.selfId();
      if (!selfUserId || notice.acceptorUserId !== selfUserId) return 'dropped';
      if (!(await deps.db.pristineForLink())) return 'dropped';
      await deps.db.savePendingLinkOffer(
        notice.offerNonce,
        JSON.stringify(notice),
        deps.now(),
      );
      notify(pendingOfferListeners);
      return 'stored';
    }
    case 'memberLinked': {
      const group = await deps.db.loadLinkGroup();
      if (!group || group.groupId !== notice.groupId) return 'dropped';
      // OUTER/INNER BINDING: every outer field
      // that controls the apply must BE a signed field. The certificate's
      // tuple is what the signature covers, so the outer groupId/class/
      // member ULID must equal the certificate's own — an old valid
      // certificate re-wrapped with a different class, group, or member is
      // a forgery, not a redelivery.
      if (
        notice.certs.groupId !== notice.groupId ||
        notice.certs.class !== notice.class ||
        notice.certs.acceptorUserId !== notice.userId
      ) {
        return 'dropped';
      }
      // Replay guard ON THE SIGNED EPOCH: the commit the
      // certificate belongs to left the roster at certs.rosterEpoch + 1, so
      // anything behind local truth is a replay — the UNSIGNED outer epoch
      // decides nothing, so an inflated outer epoch cannot smuggle an old
      // certificate past this guard to re-link an unlinked member. Equal is
      // allowed (redelivery is designed-for; the apply is idempotent).
      if (notice.certs.rosterEpoch + 1 < group.rosterEpoch) return 'dropped';
      const existing = (await deps.db.listLinkedDevices()).find(
        d => d.userId === notice.userId,
      );
      if (existing?.state === 'revoked') return 'dropped';
      // SIGNATURE VERIFICATION: the roster moves only on
      // the OFFERER's certificate verifying under a key THIS device already
      // holds — subject = the joiner's key the notice names. Server word
      // alone moves nothing, so a replayed/forged memberLinked resurrects
      // nothing even on a fresh install with no local epoch.
      const selfIdForLink = await deps.selfId();
      const rows = await deps.db.listLinkedDevices();
      const offererKey =
        notice.certs.offererUserId === selfIdForLink
          ? await deps.crypto.identityPublicKey()
          : rows.find(
              d => d.userId === notice.certs.offererUserId && d.state === 'linked',
            )?.identityKeyPub || null;
      if (!offererKey) return 'dropped';
      const linkVerified = await deps.crypto.verifyLinkOp(
        offererKey,
        'offer',
        {
          groupId: notice.certs.groupId,
          offererUserId: notice.certs.offererUserId,
          acceptorUserId: notice.certs.acceptorUserId,
          subjectIdentityPubKey: notice.identityKeyPub,
          class: notice.certs.class,
          rosterEpoch: notice.certs.rosterEpoch,
          offerNonce: notice.certs.offerNonce,
          expiresAt: notice.certs.expiresAt,
        },
        notice.certs.offerSig,
      );
      if (!linkVerified) return 'dropped';
      await deps.db.upsertLinkedDevice({
        userId: notice.userId,
        class: notice.class,
        state: 'linked',
        updatedAt: deps.now(),
        certsJson: JSON.stringify(notice.certs),
        identityKeyPub: notice.identityKeyPub,
      });
      // The epoch advances by the SIGNED value only.
      await deps.db.saveLinkGroup(
        group.groupId,
        Math.max(group.rosterEpoch, notice.certs.rosterEpoch + 1),
      );
      notify(rosterListeners);
      return 'stored';
    }
    case 'memberUnlinked':
    case 'memberRevoked': {
      const group = await deps.db.loadLinkGroup();
      if (!group || group.groupId !== notice.groupId) return 'dropped';
      // Replay guard ON THE SIGNED EPOCH, and
      // doubly load-bearing here: the self-named branch below is a
      // destructive local wipe, and a stale replay must never reach it.
      // The mutation the signature covers acted at signedRosterEpoch and
      // left the roster at signedRosterEpoch + 1; the UNSIGNED outer
      // rosterEpoch decides nothing, so an inflated outer epoch cannot
      // carry an old signed self-unlink past this guard to the wipe. Equal
      // (signed + 1 == local) is allowed — redelivery is designed-for.
      if (notice.signedRosterEpoch + 1 < group.rosterEpoch) return 'dropped';
      const selfUserId = await deps.selfId();
      // SIGNATURE VERIFICATION: the ACTING member's
      // op-framed signature must verify under that member's key as THIS
      // device holds it — a removal (the self-named destructive wipe
      // included) on server word alone verifies against nothing and drops.
      const memberRows = await deps.db.listLinkedDevices();
      const actorKey =
        notice.actingUserId === selfUserId
          ? await deps.crypto.identityPublicKey()
          : memberRows.find(
              d => d.userId === notice.actingUserId && d.state === 'linked',
            )?.identityKeyPub || null;
      if (!actorKey) return 'dropped';
      const mutationVerified = await deps.crypto.verifyLinkOp(
        actorKey,
        notice.kind === 'memberRevoked' ? 'revoke' : 'unlink',
        {
          groupId: notice.groupId,
          offererUserId: notice.actingUserId,
          acceptorUserId: notice.userId,
          subjectIdentityPubKey: notice.subjectIdentityPubKey,
          class: notice.class,
          rosterEpoch: notice.signedRosterEpoch,
          offerNonce: notice.offerNonce,
          expiresAt: notice.expiresAt,
        },
        notice.signature,
      );
      if (!mutationVerified) return 'dropped';
      const state = notice.kind === 'memberRevoked' ? 'revoked' : 'unlinked';
      if (selfUserId && notice.userId === selfUserId) {
        // THIS device left the group (a sibling unlinked it, or an
        // amicable self-unlink's own notice echoing back): the group state
        // goes; the account continues standalone — which it always was.
        await deps.db.clearLinkGroup();
      } else {
        await deps.db.markLinkedDeviceState(notice.userId, state, deps.now());
        // The epoch advances by the SIGNED value only.
        await deps.db.saveLinkGroup(
          group.groupId,
          Math.max(group.rosterEpoch, notice.signedRosterEpoch + 1),
        );
      }
      notify(rosterListeners);
      return 'stored';
    }
    case 'recoveryRequested': {
      // LOUDNESS notices (the client half). These are NOT
      // authorization — the 72 h
      // delay, the member cancel, and the completion transaction's
      // conditions are all server-enforced; they are the human-facing
      // signal, and the requested one above all carries the CANCEL
      // capability: any surviving member can kill the pending recovery and
      // the cancel WINS. Stored durably (latest state wins) and rendered by
      // the linked-devices surface; server-word by necessity — nobody has
      // pinned the recovering key yet, and the honesty is that the
      // recovered device still arrives everywhere as an un-cross-signed
      // NEW key (block-and-warn).
      //
      // TWO GUARDS, because "latest state wins"
      // must mean the latest state of THIS account's grouping, never
      // whichever frame arrived last:
      //  - a notice naming a group this device KNOWS it is not in is a
      //    former group's (or a misdelivery) and drops — a lazily-created
      //    solo group is the accepted gap: it has no local group row and
      //    no way to learn its server-minted id (the wire is uniform), so
      //    its notices are accepted on server word, the necessity stated
      //    above (leaving a group clears the stored notice — clearLinkGroup);
      //  - a 'requested' whose completesAt is not LATER than a stored
      //    TERMINAL state's is a stale replay of that same attempt (a
      //    fresh attempt's 72 h horizon is strictly later) and must not
      //    resurrect a banner the cancel already settled.
      if (!(await recoveryNoticeGroupPlausible(notice.groupId, deps))) {
        return 'dropped';
      }
      const standing = await deps.db.loadRecoveryNotice();
      if (
        standing !== null &&
        standing.groupId === notice.groupId &&
        (standing.kind === 'cancelled' || standing.kind === 'completed') &&
        standing.completesAt !== null &&
        notice.completesAt <= standing.completesAt
      ) {
        return 'dropped';
      }
      await deps.db.saveRecoveryNotice({
        kind: 'requested',
        groupId: notice.groupId,
        class: notice.class,
        completesAt: notice.completesAt,
        receivedAt: deps.now(),
      });
      notify(recoveryNoticeListeners);
      return 'stored';
    }
    case 'recoveryCompleted': {
      if (!(await recoveryNoticeGroupPlausible(notice.groupId, deps))) {
        return 'dropped';
      }
      await deps.db.saveRecoveryNotice({
        kind: 'completed',
        groupId: notice.groupId,
        class: notice.class,
        // The attempt's horizon is PRESERVED through its terminal state: it is what identifies the attempt, so a stale
        // 'requested' replay can be recognized and dropped above.
        completesAt: await standingCompletesAt(notice.groupId, deps),
        receivedAt: deps.now(),
      });
      // The recovered member itself reaches this device's roster through
      // the ordinary signals (its own bundle fetch, sibling sync) as a
      // ceremony-less certless member — block-and-warn by construction.
      notify(recoveryNoticeListeners);
      return 'stored';
    }
    case 'recoveryCancelled': {
      if (!(await recoveryNoticeGroupPlausible(notice.groupId, deps))) {
        return 'dropped';
      }
      await deps.db.saveRecoveryNotice({
        kind: 'cancelled',
        groupId: notice.groupId,
        class: null,
        completesAt: await standingCompletesAt(notice.groupId, deps),
        receivedAt: deps.now(),
      });
      notify(recoveryNoticeListeners);
      return 'stored';
    }
    case 'usernameRevoked': {
      // Operator revocation: the operator detached this
      // account's NAME — kind only, reasonless on the wire by design. Two
      // local facts follow, in every binary (the arming order's client
      // half — a pin-OFF build holds no name to clear and shows nothing,
      // but it must never drop the frame as unparseable): the local
      // username row goes (the server refuses every lookup of it now, and
      // a name this device keeps rendering as held would be a lie), and
      // the notice is stored for the username surface to render with its
      // fixed copy (accountsUsernameCopy.ts) under USERNAME_UI_ENABLED.
      // Server-word by necessity and honestly so: it is LOUDNESS about a
      // tombstone that already stands, never authorization — nothing here
      // touches the account, its messages, its other identifiers, or its
      // consent; and no plausibility gate applies, because the notice
      // names nothing (no groupId) that could be checked.
      await deps.db.clearUsernameIdentifier();
      await deps.db.saveUsernameNotice({ receivedAt: deps.now() });
      notify(usernameNoticeListeners);
      return 'stored';
    }
  }
}

/** Recovery-notice group validation, shared by the three recovery-notice kinds:
 * when this device HOLDS a group row, the notice must name that group; a
 * device with no local group row (the lazy solo-attach class, or a fresh
 * install) cannot validate and accepts on server word — the stated
 * necessity, bounded by clearLinkGroup dropping the stored notice whenever
 * a group is left. */
async function recoveryNoticeGroupPlausible(
  groupId: string,
  deps: LinkingDeps,
): Promise<boolean> {
  const group = await deps.db.loadLinkGroup();
  return group === null || group.groupId === groupId;
}

/** The stored attempt's completesAt, carried into a terminal state so the
 * attempt stays identifiable. */
async function standingCompletesAt(
  groupId: string,
  deps: LinkingDeps,
): Promise<number | null> {
  const standing = await deps.db.loadRecoveryNotice();
  return standing !== null && standing.groupId === groupId
    ? standing.completesAt
    : null;
}

/* ── roster mutations (the Linked-devices screen's verbs) ───── */

/** True when an api error is the forwarding-hint 404 for an
 * already-tombstoned ULID (`recipient_revoked`). */
function isRecipientRevoked(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === 'recipient_revoked';
}

/**
 * Unlink (amicable) or revoke (lost/stolen) one member. The acting
 * member's identity key signs the FULL op-framed mutation tuple natively
 * — subject = the target's REGISTERED identity key, fetched fresh so the
 * signature names WHICH key it removes — and the server's epoch condition
 * is the authorization. A refusal is the collapsed 403; the screen renders
 * `LINKING_COPY.refused` and refreshes.
 *
 * Two hardenings ride the bundle fetch:
 *  - STALENESS RECOVERY: the served `rosterVersion` IS this group's current
 *    epoch (the signal — the target is a member of OUR group), so the
 *    signature binds the freshest truth. One dropped fan-out notice can
 *    therefore never wedge unlink/revoke behind a permanently stale local
 *    epoch.
 *  - COMPLETION SIGNAL: a 404 `recipient_revoked` for the target means the
 *    removal already COMMITTED server-side — enforcement is the record
 *    (auth refuses the tombstoned key, enqueue refuses the ULID) —
 *    so local truth follows it instead of throwing forever. The remaining
 *    server-side teardown is idempotent cleanup; the byte-identical
 *    permitted re-drive needs the original signed request
 *    persisted, which is ledgered rather than silently absent.
 */
export async function mutateRoster(
  op: 'unlink' | 'revoke',
  target: { userId: string; class: DeviceClass },
  deps: LinkingDeps = defaultDeps(),
): Promise<void> {
  const token = await deps.token();
  const selfUserId = await deps.selfId();
  if (!token || !selfUserId) throw new Error('no account');
  const group = await deps.db.loadLinkGroup();
  if (!group) throw new Error('not linked');
  // The preimage's subject: the target's REGISTERED key, served fresh.
  let bundle: PrekeyBundle;
  try {
    bundle = await deps.api.getPrekeyBundle(token, target.userId);
  } catch (error) {
    if (isRecipientRevoked(error) && target.userId !== selfUserId) {
      // Already tombstoned: the mutation this call wanted has happened.
      // Record it and let the roster reflect the truth.
      await deps.db.markLinkedDeviceState(target.userId, 'revoked', deps.now());
      notify(rosterListeners);
      return;
    }
    throw error;
  }
  assertBundleNames(bundle, target.userId);
  const rosterEpoch =
    bundle.rosterVersion !== undefined && bundle.rosterVersion > group.rosterEpoch
      ? bundle.rosterVersion
      : group.rosterEpoch;
  if (rosterEpoch !== group.rosterEpoch) {
    await deps.db.saveLinkGroup(group.groupId, rosterEpoch);
  }
  const offerNonce = deps.freshNonce();
  // The mutation's own explicit expiry, comfortably inside the
  // server-capped ceiling (one link-offer TTL from now).
  const expiresAt = Math.floor(deps.now() / 1000) + Math.floor(LINK_OFFER_TTL_SECONDS / 2);
  const signedTuple = {
    groupId: group.groupId,
    offererUserId: selfUserId,
    acceptorUserId: target.userId,
    subjectIdentityPubKey: bundle.identityKey,
    class: target.class,
    rosterEpoch,
    offerNonce,
    expiresAt,
  };
  const signature = await deps.crypto.signLinkOp(op, signedTuple);
  // `boundAgents` (the design binding fate): a revoke names the
  // victim's integration-class accounts from the machine-peers roster
  // sibling sync recorded for that device — local truth the server refuses
  // to enumerate. The server verifies each is an integration OWNED by the
  // target; an empty list simply omits the field.
  const boundAgents =
    op === 'revoke' ? await deps.db.listSiblingAgents(target.userId) : [];
  const body = {
    groupId: group.groupId,
    targetUserId: target.userId,
    targetClass: target.class,
    rosterEpoch,
    offerNonce,
    expiresAt,
    signature,
    ...(boundAgents.length > 0 ? { boundAgents } : {}),
  };
  // PERSIST BEFORE SEND (the permitted re-drive):
  // the signed request is stored byte-identical so a crash between the
  // server's committed transaction and its teardown can be re-driven with
  // the SAME signed tuple inside its explicit expiry —
  // `redrivePendingMutations` is the driver; the epoch condition keeps the
  // replay harmless (single-use for roster effect).
  await deps.db.savePendingLinkMutation({
    offerNonce,
    op,
    bodyJson: JSON.stringify(body),
    createdAt: deps.now(),
    expiresAt,
  });
  try {
    await deps.api.rosterMutation(token, op, body);
  } catch (error) {
    // A REFUSED revoke naming agents retries once WITHOUT them (fix
    // pass): the agent list rides OUTSIDE the signed tuple by design, and
    // a stale synced entry — an agent the target no longer owns — must not
    // wedge the lost/stolen kill switch behind the collapsed refusal. The
    // completion path may still name agents on a later re-drive. Only a
    // definite server refusal retries; transports rethrow.
    const status = (error as { status?: number } | null)?.status;
    if (
      boundAgents.length > 0 &&
      typeof status === 'number' &&
      status >= 400 &&
      status < 500 &&
      !isRecipientRevoked(error)
    ) {
      const bare = { ...body };
      delete (bare as { boundAgents?: string[] }).boundAgents;
      await deps.db.savePendingLinkMutation({
        offerNonce,
        op,
        bodyJson: JSON.stringify(bare),
        createdAt: deps.now(),
        expiresAt,
      });
      await deps.api.rosterMutation(token, op, bare);
    } else {
      throw error;
    }
  }
  await deps.db.deletePendingLinkMutation(offerNonce);
  const now = deps.now();
  if (target.userId === selfUserId) {
    // Unlinking THIS device: the leaver wipes its group state locally and
    // continues standalone.
    await deps.db.clearLinkGroup();
  } else {
    await deps.db.markLinkedDeviceState(
      target.userId,
      op === 'unlink' ? 'unlinked' : 'revoked',
      now,
    );
    await deps.db.saveLinkGroup(group.groupId, rosterEpoch + 1);
  }
  notify(rosterListeners);
  // The SIGNED statement peers must hear: the committed
  // mutation's exact tuple + signature feeds the in-band notice fan-out.
  // Fire-and-forget HERE by design (the persisted re-drive is the
  // durability); the dissolve producer alone awaits its notice.
  void notifyPeerNotice({ op, tuple: signedTuple, signature }).catch(() => undefined);
}

/**
 * Re-drive persisted signed roster mutations (the
 * byte-identical completion re-drive): each stored request is re-sent AS
 * SIGNED, never rebuilt, never re-signed. Within its explicit expiry the
 * server permits the same signed tuple to complete the
 * idempotent teardown; the epoch condition makes the replay harmless. An
 * expired row reaps; a still-refused live row survives for the next
 * surface open. User-action-paced like `reconcilePendingLink` — the
 * Linked-devices screen drives it on open.
 */
export async function redrivePendingMutations(
  deps: LinkingDeps = defaultDeps(),
): Promise<void> {
  const stored = await deps.db.listPendingLinkMutations();
  if (stored.length === 0) return;
  const token = await deps.token();
  if (!token) return;
  const nowSeconds = Math.floor(deps.now() / 1000);
  for (const row of stored) {
    if (nowSeconds >= row.expiresAt) {
      // Past the signature's own expiry the server refuses the tuple; the
      // record is stale weight. If the mutation committed, the roster and
      // teardown already reflect it (the notice path); if it never left,
      // there is nothing to complete.
      await deps.db.deletePendingLinkMutation(row.offerNonce);
      continue;
    }
    let body: Parameters<LinkingDeps['api']['rosterMutation']>[2];
    try {
      body = JSON.parse(row.bodyJson) as typeof body;
    } catch {
      await deps.db.deletePendingLinkMutation(row.offerNonce);
      continue;
    }
    try {
      await deps.api.rosterMutation(token, row.op, body);
      await deps.db.deletePendingLinkMutation(row.offerNonce);
      await deps.db.markLinkedDeviceState(
        body.targetUserId,
        row.op === 'unlink' ? 'unlinked' : 'revoked',
        deps.now(),
      );
      notify(rosterListeners);
      // Feed the peer notice too — the wire body carries the
      // whole signed tuple except the subject key, which the target's own
      // roster row holds when this device ever learned it. Missing key =
      // no notice from this path; peers still learn from the bundle and
      // `recipient_revoked` signals (best-effort, like the server's own).
      const targetRow = (await deps.db.listLinkedDevices()).find(
        d => d.userId === body.targetUserId,
      );
      const selfForNotice = await deps.selfId();
      if (targetRow?.identityKeyPub && selfForNotice) {
        void notifyPeerNotice({
          op: row.op,
          tuple: {
            groupId: body.groupId,
            offererUserId: selfForNotice,
            acceptorUserId: body.targetUserId,
            subjectIdentityPubKey: targetRow.identityKeyPub,
            class: body.targetClass,
            rosterEpoch: body.rosterEpoch,
            offerNonce: body.offerNonce,
            expiresAt: body.expiresAt,
          },
          signature: body.signature,
        }).catch(() => undefined);
      }
    } catch (error) {
      if (isRecipientRevoked(error)) {
        // Already tombstoned server-side: complete locally, exactly the
        // mutateRoster completion signal.
        await deps.db.deletePendingLinkMutation(row.offerNonce);
        await deps.db.markLinkedDeviceState(body.targetUserId, 'revoked', deps.now());
        notify(rosterListeners);
        continue;
      }
      // Transient or refused-at-this-epoch: the row survives inside its
      // expiry for the next drive.
    }
  }
}

/**
 * THE DISSOLVE PRODUCER (the downgrade flow):
 * the one flow that SIGNS a dissolve. Two halves, in the order:
 *
 *  1. The peer-visible statement FIRST, over the still-intact roster: this
 *     device's identity key signs the op-framed dissolve tuple (per-op
 *     bindings — acting = target = self, subject = its own registered key,
 *     class = its own slot) and the signed statement feeds the in-band
 *     fan-out (`x.acct.notice`): peers verify it against the key they
 *     pinned, drop the sibling association, and invalidate the group's
 *     cached certificates. No server route carries this — the producer is
 *     client-side by design, inside the ratchets.
 *
 *  2. The server half walks the roster down with the LANDED amicable
 *     verb — every other member unlinked by this device's signature, this device last — because the last
 *     member's exit is the transaction that deletes the group row AND every
 *     identifier claim its reverse list names (only the last member's
 *     exit takes the identifiers with it). The server sweep owns the
 *     residual audit; this flow uses only routes that exist.
 *
 * Throws on a refused leg: the screen states plainly that whatever was
 * already removed stays removed and the rest can be retried — a downgrade
 * is capability-shrinking at every step, so a partial one is never worse
 * than where it stopped.
 */
export async function dissolveGrouping(
  deps: LinkingDeps = defaultDeps(),
): Promise<void> {
  const selfUserId = await deps.selfId();
  if (!selfUserId) throw new Error('no account');
  const group = await deps.db.loadLinkGroup();
  // Never ceremonially grouped as far as this device knows: nothing to
  // dissolve from here (a lazily-created solo group has no local roster;
  // its identifier half is the caller's own unlink call).
  if (!group) return;
  const ownKey = await deps.crypto.identityPublicKey();
  if (ownKey === null) throw new Error('no identity');
  const rows = await deps.db.listLinkedDevices();
  const ownClass =
    rows.find(d => d.userId === selfUserId && d.state === 'linked')?.class ??
    localDeviceClass();
  const offerNonce = deps.freshNonce();
  const expiresAt =
    Math.floor(deps.now() / 1000) + Math.floor(LINK_OFFER_TTL_SECONDS / 2);
  const tuple = {
    groupId: group.groupId,
    offererUserId: selfUserId,
    acceptorUserId: selfUserId,
    subjectIdentityPubKey: ownKey,
    class: ownClass,
    rosterEpoch: group.rosterEpoch,
    offerNonce,
    expiresAt,
  };
  const signature = await deps.crypto.signLinkOp('dissolve', tuple);
  // AWAITED: the peer-visible statement must be
  // DURABLE before the roster starts coming down — the messaging listener
  // enqueues one outbox row per peer leg, and awaiting it here means every
  // leg is on disk (and flushes across restarts) before the first unlink
  // leaves. A failure here throws, so a downgrade that could not state
  // itself does not dissolve anything — the screen's partial-downgrade copy
  // covers the retry. Residual, named: process death INSIDE the enqueue
  // loop still loses the un-enqueued legs; those peers learn from the
  // bundle/`recipient_revoked` signals (bounded posture).
  await notifyPeerNotice({ op: 'dissolve', tuple, signature });
  const others = rows.filter(
    d => d.state === 'linked' && d.userId !== selfUserId,
  );
  for (const member of others) {
    await mutateRoster('unlink', { userId: member.userId, class: member.class }, deps);
  }
  await mutateRoster('unlink', { userId: selfUserId, class: ownClass }, deps);
}

/** The roster as the "Linked devices" screen shows it: only members still
 * IN the group — a revoked or unlinked device has disappeared from the
 * roster (its history row survives for the loud device-list discipline). */
export async function currentRoster(
  deps: LinkingDeps = defaultDeps(),
): Promise<dbModule.LinkedDeviceRow[]> {
  const rows = await deps.db.listLinkedDevices();
  return rows.filter(row => row.state === 'linked');
}
