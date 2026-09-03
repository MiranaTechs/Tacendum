import { shortId } from '../person';
import type { CallEnvelope, CallState, IceServer } from '@tacendum/shared';
import {
  OFFER_EXP_SKEW_MS,
  OFFER_MAX_SERVER_AGE_MS,
  offerIsRingable,
  parseCallEnvelope,
} from '@tacendum/shared';
import { CallService, type CallLogRow as ServiceLogRow, type CallMetricSink } from './service';
// NOTE: no import of ./policy here, deliberately. The ring decision arrives
// through `mayRing`, so this file stays testable without a database and the
// policy stays readable without a controller.

/**
 * The wiring.
 *
 * `CallService` executes effects and `callReducer` decides; neither of them
 * knows where an envelope came from or where an ICE candidate goes. This is
 * the object that connects them to the rest of the app: decrypted `call.*`
 * envelopes in from `messaging`, native events in from the module, envelopes
 * back out through the ratchet, and the TURN credential cache that has to be
 * warm before any of it works.
 *
 * It is deliberately the only place those four things meet. `messaging.ts`
 * imports nothing call-related — it just offers `onEnvelope` — and the native
 * module knows nothing about messaging. That seam is what let the entire call
 * protocol be verified from a CLI before any of this existed.
 */

/**
 * How an inbound frame terminally resolved when it was NOT call signalling
 * (the ring-proof fuse). Declared here structurally, like everything else in `CallMessaging`,
 * so the seam stays two independent files: messaging states facts, the
 * controller owns what they mean for a ring.
 */
export type FrameVerdict = 'not_call' | 'undecryptable';

/** The subset of `messaging` this needs. Injected so the controller is
 * testable without a database, a socket, or libsignal. */
export interface CallMessaging {
  onEnvelope(
    listener: (peerId: string, envelope: unknown, meta: { msgId: string; ts: number }) => void,
  ): () => void;
  /**
   * A frame from `peerId` resolved as something that can never ring (the ring-proof rule):
   * garbage ciphertext, or a decrypted payload that is not call signalling.
   * Optional — absent, non-call urgent payloads ring until the native
   * 75-second watchdog, which is the pre-fuse behaviour.
   */
  onFrameVerdict?(listener: (peerId: string, verdict: FrameVerdict) => void): () => void;
  sendCallEnvelope(
    peerId: string,
    envelope: CallEnvelope,
    opts: { urgent?: boolean },
  ): Promise<void>;
}

/** The subset of the native module this needs. */
export interface CallNativeBridge {
  configure(iceServers: IceServer[], relayOnly: boolean): Promise<void>;
  createOffer(cid: string, withVideo: boolean): Promise<string>;
  createAnswer(cid: string, remoteOfferSdp: string, withVideo: boolean): Promise<string>;
  setRemoteAnswer(cid: string, sdp: string): Promise<void>;
  addIceCandidates(cid: string, candidates: { cand: string; mid: string; idx: number }[]): Promise<void>;
  restartIce(cid: string): Promise<string>;
  close(cid: string): Promise<void>;
  reportOutgoingCall(cid: string, handle: string, video: boolean): Promise<void>;
  reportOutgoingConnected(cid: string): Promise<void>;
  reportIncomingCall(
    cid: string,
    peerId: string,
    handle: string,
    displayName: string,
    hasVideo: boolean,
  ): Promise<void>;
  updateIncomingCallDisplay(cid: string, displayName: string): Promise<void>;
  /**
   * End the VoIP placeholder ringing for `peerId`.
   *
   * `cid` NAMES THE PLACEHOLDER THIS DECISION WAS ABOUT — native fires only
   * while `pendingPush` still names both that peer and that cid, so a verdict
   * that lands after the placeholder was replaced is a strict no-op instead of
   * ending a ring it never decided. `''` matches whatever is pending for the
   * peer, which is exactly the pre-cid behaviour and is what a JS build ahead
   * of the binary degrades to.
   */
  dismissPendingIncomingCall(peerId: string, reason: string, cid: string): Promise<void>;
  endCall(cid: string, reason: string): Promise<void>;
  registerForVoipPush(): Promise<void>;
  getVoipToken(): Promise<string>;
}

export interface TurnCredentials {
  iceServers: IceServer[];
  ttlSeconds: number;
}

/**
 * The small-group seam.
 *
 * Consulted from INSIDE `onEnvelope`, which is the entire point: the
 * controller's serialization `queue` is what keeps the reducer's sequential
 * contract true, and a second independent `messaging.onEnvelope` subscriber
 * would carry its own queue and could reorder a session's offer against its
 * own ICE. One subscription, one order, both shapes.
 *
 * `peerId` is the ratchet-authenticated `frame.from` — the writerId rule. No payload field is ever consulted for identity, and
 * `admitGroupCallRosterDelta`'s `from` argument is only ever fed from here.
 */
export interface GroupRouter {
  /** `call.g*`, or a `call.*` frame naming a cid a live session owns. */
  handles(peerId: string, envelope: unknown): boolean;
  /**
   * Resolves with whether the frame was ADOPTED — a live or ringing session
   * exists that claims it, or the frame was a `call.ginvite`, whose branch
   * owns its own placeholder on every path exactly as the 1:1 offer branch
   * does. `false` means the frame was semantically inert: it reduced to
   * nothing, and a VoIP placeholder ringing for its sender has nothing left
   * to become (the group arm of the fuse-defeat class).
   */
  handle(
    peerId: string,
    envelope: unknown,
    meta: { msgId: string; ts: number },
  ): Promise<boolean>;
  /** The busy rule: while a session is live this device is busy to ordinary 1:1
   * offers, and while a 1:1 call is live it is busy to `ginvite`s. Both
   * directions, or a person can be in two conversations at once with one
   * microphone. */
  liveSessionBusy(): boolean;
}

export interface CallControllerDeps {
  messaging: CallMessaging;
  native: CallNativeBridge;
  /** Rejects when no relay is configured; the caller decides what that means. */
  fetchTurnCredentials(): Promise<TurnCredentials>;
  writeLog(row: ServiceLogRow): Promise<void>;
  displayNameFor(peerId: string): Promise<string>;
  /** The design always-relay. Read per call, so toggling it takes effect next call. */
  relayOnly(): boolean;
  /**
   * Whether the call about to start with THIS peer should be relayed.
   *
   * The app-wide switch above answers "every call"; this answers "this call,
   * to this person", which is the promise the product actually makes: the
   * FIRST call with someone new is relayed, so a direct connection never hands
   * a home IP address to someone who has never had it, and afterwards the app
   * follows whatever was chosen for them. The decision itself is
   * `relayForPeer` in ./policy — pure, and tested without a database; this dep
   * is the seam that supplies it with facts and carries its verdict back.
   *
   * Async because answering it reads the call log and the per-peer memory.
   * Consulted in BOTH directions — placing a call and receiving an offer —
   * because both of them gather candidates and both disclose an address.
   *
   * Optional. Absent, the controller behaves exactly as it did before this
   * existed: the app-wide switch and nothing else. `call.trace.test.ts` holds
   * that older behaviour as a committed snapshot, so "absent ⇒ unchanged" is
   * a property with a test rather than an intention.
   */
  relayForPeer?(peerId: string): Promise<boolean>;
  /**
   * Whether this peer may ring the phone. Async because answering it
   * means a database read, and it happens on the path of an incoming offer.
   * Optional: without it every caller rings, which is the pre-V7 behaviour.
   */
  mayRing?(peerId: string): Promise<{ ring: boolean; reason?: 'unknown_caller' }>;
  /**
   * Whether an OUTBOUND call to this peer may start at all.
   *
   * Separate from `mayRing`, which governs whose calls ring THIS phone. This
   * one is checked before the first effect of `placeCall`, so a refused call
   * never reaches the camera. Optional: without it every call proceeds and is
   * refused later at the transport, which is the pre-V7 behaviour.
   */
  mayCall?(peerId: string): Promise<CallPermission>;
  now(): number;
  /** Independently minted from cid, after all outbound preflight. */
  mintReportId(): Promise<string>;
  metrics?: CallMetricSink;
  onStateChange?(state: CallState): void;

  /**
   * Durable copy of a ringing call's offer.
   *
   * The app can be killed between CallKit ringing and the user answering —
   * iOS does this routinely under memory pressure, and the system call UI
   * survives it. Answering then cold-launches the app, which needs the offer
   * SDP to build an answer, and cannot get it again: the ratchet consumed the
   * message key on first decrypt.
   *
   * Optional. Without it a cold-launch answer is dropped, which is the
   * pre-V7 behaviour and a degradation rather than a break.
   */
  saveOffer?(offer: StoredCallOffer): Promise<void>;
  takeOffer?(cid: string): Promise<StoredCallOffer | null>;
  dropOffer?(cid: string): Promise<void>;

  /**
   * THIS DEVICE'S LIVE TRACK STATE, for the one moment the protocol re-asserts
   * a track fact the protocol does not own.
   *
   * `call.media` (`sendMedia`) is the only channel that carries track state,
   * and the reducer deliberately does not model it — muting and the camera are
   * device facts. But `restartReceived` (call-machine.ts) replies to an ICE
   * restart with `vid: call.video`, and `call.video` is written once, at
   * `newContext`, and narrowed once by `acceptIncoming`. A camera toggled
   * mid-call never touches it. So every restart answer re-asserts the camera
   * state the CALL STARTED WITH, and a peer on a build without
   * `answerReceived`'s `remoteReady` gate believes it: their `peerVideo` flips
   * back on over a camera that is off, and the video surface keeps presenting
   * the last decoded frame — a frozen still of this person shown as live video
   * until they toggle again.
   *
   * Read through a dep rather than imported, because the state lives in
   * `index.ts` — which constructs this controller, so importing it back would
   * be a cycle. `localMediaState()` there is the same object.
   *
   * Optional, like every other dep added here. Absent ⇒ NO announce, which is
   * this file's behaviour before it existed; a default would be the same lie
   * told by the fix instead of by the reducer.
   */
  localMedia?(): { muted: boolean; videoEnabled: boolean };

  /**
   * Small-group calls. Absent ⇒ today's behaviour byte-for-byte,
   * which `call.trace.test.ts` holds as a committed snapshot.
   */
  groupRouter?: GroupRouter;
}

/** Why an outbound call was refused before it began. */
export type CallRefusalReason = 'blocked' | 'identity_changed';

export interface CallPermission {
  allowed: boolean;
  reason?: CallRefusalReason;
}

/**
 * Thrown by `placeCall` when the design forbids the call, or when the busy rule does.
 *
 * A distinct type so the UI can tell "you blocked this person" from "their
 * safety number changed" — those need different copy and lead to different
 * places — without parsing an error message. `busy` is the busy-rule refusal: it is
 * not a fact about the peer at all, which is why it is a refusal REASON and
 * not a `CallPermission`.
 */
export class CallRefusedError extends Error {
  constructor(readonly reason: CallRefusalReason | 'busy' = 'blocked') {
    super(
      reason === 'identity_changed'
        ? 'safety number changed'
        : reason === 'busy'
          ? 'already in a call'
          : 'peer is blocked',
    );
    this.name = 'CallRefusedError';
  }
}

/** The parts of a `call.offer` an answer has to be rebuilt from. */
export interface StoredCallOffer {
  cid: string;
  peerId: string;
  sdp: string;
  video: boolean;
  exp: number;
  serverTs: number;
}

/** Refresh a credential when 80% of its life is gone. Waiting for
 * expiry would mean the first call after it lapses fails while the refresh
 * runs, which is the one moment a user is watching. */
const REFRESH_AT = 0.8;

/**
 * The longest call a credential minted NOW is expected to carry (§10.2).
 *
 * `REFRESH_AT` keeps the CACHE fresh; it says nothing about a call that
 * starts with the credential nearly spent. A 12 h credential reused at the
 * 79 % mark starts a call with ~2.5 h of relay life, and a relayed call that
 * outlives its credential loses its media with no signalling failure to
 * explain it. So a call is placed or answered on a credential with at least
 * this much life left, refreshed first when it has less. Four hours is longer
 * than any call this product has seen and well inside the 5/hour mint budget
 * (one extra mint per four-hour call at most).
 */
const MAX_CALL_BOUND_MS = 4 * 3_600_000;

/**
 * How long an inbound `call.end` tombstones its cid.
 *
 * A caller can hang up while this phone is dead; the server then drains the
 * cancellation and the offer it cancels in the same burst, and the live
 * (`call.end`) frame can precede the queued (`call.offer`) one. The offer must
 * then ring nothing and write nothing — the cancel already settled it. Held
 * for as long as an offer can still be ringable by either clock (§6.4), so no
 * ringable copy of the cancelled offer can arrive after the tombstone lapses.
 */
const END_TOMBSTONE_MS = OFFER_MAX_SERVER_AGE_MS + OFFER_EXP_SKEW_MS;
/** A bound on the tombstone set, so a flood of ends cannot grow it. */
const MAX_END_TOMBSTONES = 64;

/**
 * How long to wait for a credential before giving up and calling anyway.
 *
 * `ensureCredentials` is awaited on the SERIALIZED envelope queue, so a
 * request that never returns does not merely delay one call — it stalls every
 * envelope behind it, including the `call.end` that would stop a phone
 * ringing. The API client has no timeout of its own, so this is the only
 * bound.
 *
 * Eight seconds because a call is already an interactive wait: past that, no
 * relay is a better answer than no answer.
 */
const CREDENTIAL_TIMEOUT_MS = 8_000;

/** Reject after `ms` so a hung request cannot hold the envelope queue. The
 * underlying promise is abandoned rather than cancelled — the API client has
 * no abort — which is acceptable here because its only effect is to populate
 * a cache we will refresh again anyway. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('credential fetch timed out')), ms);
    promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      err => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error('credential fetch failed'));
      },
    );
  });
}

export class CallController {
  private readonly service: CallService;
  private unsubscribe: (() => void) | null = null;
  private credentials: { servers: IceServer[]; expiresAt: number } | null = null;
  private refreshing: Promise<void> | null = null;
  /**
   * Envelope handling, serialized.
   *
   * `messaging` delivers synchronously and each envelope's handling is several
   * awaits deep — a credential fetch, then a dispatch, then whatever effects
   * fall out. Two envelopes arriving together would interleave those, and the
   * reducer is written against a sequential event stream: a `call.ice` landing
   * between an offer's dispatch and its effects would be applied to a call
   * that does not exist yet. The message listener already serializes decrypts
   * for exactly this reason.
   */
  private queue: Promise<void> = Promise.resolve();

  /**
   * Push rings declined before their offer could decrypt.
   *
   * Declining the CallKit placeholder emits `callKitEnded` with the SYNTHETIC
   * cid — the reducer has no call for it, so the decline used to evaporate:
   * no end frame reached the caller (they rang out the full 45 s), and worse,
   * seconds later the offer decrypted into an idle machine and RANG THE
   * CALLEE AGAIN for a call they had just declined. `pushRings` remembers
   * which synthetic cids were push placeholders and for whom;
   * `pushDeclines` remembers a decline for the sixty seconds an offer could
   * still arrive behind it.
   */
  private pushRings = new Map<string, string>();
  private pushDeclines = new Map<string, number>();
  /** cid → when an inbound `call.end` named it (see `END_TOMBSTONE_MS`). */
  private endedCids = new Map<string, number>();
  private static readonly PUSH_DECLINE_WINDOW_MS = 60_000;

  /**
   * Per peer: the cid of the placeholder native says is CURRENTLY RINGING.
   *
   * PUBLISHED BY NATIVE, never inferred here. The push's own cid is the wrong
   * answer: `CallKitCenter`'s `alreadyRinging` branch deliberately leaves
   * `pendingPush` on the FIRST ring while still emitting `voipPush` for the
   * second, so from push #2 onward the cid JS is handed names a throwaway.
   * Tagging a dismissal with it would produce a guard that never matches — a
   * ring stuck to the 75-second watchdog, which is rule 3's twin.
   *
   * `''` when native published nothing (a binary that predates `ringCid`),
   * which degrades every dismissal to the caller-keyed match — today's exact
   * behaviour. Stored verbatim, `''` included: a fallback to the push's own
   * cid would be worse than no tag at all.
   *
   * ONE LIFETIME, ONE DELETION POINT: `forgetPushRingsFor`, beside the notes
   * it belongs to. A cid outliving its notes would name a placeholder that is
   * already gone, and the next dismissal would be refused natively.
   */
  private ringCids = new Map<string, string>();

  /**
   * A DECIDED CANCELLATION waiting out the grace. NOT the speculative fuse.
   *
   * The fuse below is a GUESS: an inert frame arms it, the next inert frame
   * re-arms it, and losing it costs nothing because something will decide
   * again. A `call.end` that named no live call is a DECISION — the frame that
   * made it has already drained, and nothing ever decides it a second time. So
   * every way of losing it is a defect, and the shipped design lost it four
   * ways: a second push re-armed it onto a later ring's clock (which then
   * burned the ring the REDIAL was riding), a group-adopted frame parked it
   * forever, a throwing handler unwound past both parks, and teardown dropped
   * it outright. Each left the placeholder dismissed by nothing.
   *
   * So it is its own record: never parked by arrival, never retired by a push,
   * NEVER RE-ARMED ONTO A NEW CLOCK. It is only HELD — timer paused, deadline
   * untouched — and discharged only by a branch that actually settled the
   * placeholder. `stop()` fires it — unless a frame that OWNS the placeholder
   * is in flight, in which case teardown leaves the record standing for that
   * frame's handler rather than firing into it or dropping it
   * (`fireCancelObligation`).
   *
   * TWO HOLDS, both pausing the same timer and neither moving the deadline:
   * one for the duration of a frame's own handler (`cancelHolds`), and one for
   * a push that lands after the decision was made (`holdCancelForPush`) — the
   * redial riding the very placeholder this decision named, which the cid tag
   * cannot separate because both calls share one placeholder INSTANCE.
   *
   * `ringCid` is captured when the decision is MADE, so a fire that lands
   * after the placeholder was replaced names the old one and no-ops.
   */
  private cancelObligations = new Map<
    string,
    {
      ringCid: string;
      deadline: number;
      timer: ReturnType<typeof setTimeout> | null;
      /** THE PUSH HOLD. A VoIP push that lands AFTER this decision
       * was made is ringing the placeholder this decision named — native's
       * `alreadyRinging` branch deliberately leaves `pendingPush` on the FIRST
       * ring — so the phone may now be ringing for a call this decision knows
       * nothing about. Non-null until that drain SETTLES the placeholder's
       * fate or the ceiling below elapses — not merely until the drain's first
       * frame is delivered, which an earlier version got wrong. */
      pushHold: ReturnType<typeof setTimeout> | null;
      /** ABSOLUTE, and dated from the FIRST post-decision push. Later pushes
       * re-take the hold; none of them may move this. `0` until one lands. */
      pushCeiling: number;
      /** ABSOLUTE, and dated from the DECISION itself: the instant past which
       * a frame hold may no longer PAUSE this countdown (`cancelHolds`). The
       * holds are still counted — nothing about their ownership changes — but
       * a delivery past this no longer stops the clock, and the next handler
       * to end starts it. The aggregate's only bound; see `cancelHolds`. */
      holdCeiling: number;
    }
  >();
  /**
   * Frames from this peer currently being handled. While > 0 the obligation's
   * timer is paused so a fire cannot land in the middle of the offer branch's
   * up-to-8-second credential fetch — the moment at which ending the
   * placeholder would kill the ring the offer is one await from adopting.
   * The DEADLINE never moves, so a peer who stalls buys parking, never time.
   *
   * ONE OWNER, TWO WRITES. This is a COUNT of frames in flight
   * and NOT part of any obligation record: it is incremented at DELIVERY
   * (`holdCancelObligation`, from `start()`'s listener) and decremented in
   * `onEnvelope`'s `finally` (`releaseCancelObligation`), and no third site
   * may write it WHILE THE LISTENER IS LIVE — AND `stop()` IS NOT AN
   * EXCEPTION, because it no longer writes it. An earlier version
   * claimed it was safe to ("it unsubscribes first, so nothing can be counted
   * past it"), and that sentence was false: unsubscribing stops new
   * DELIVERIES, not the handlers already on the queue. Those handlers still
   * reach `armCancelObligation` — `stop()` clears `ringCids` but not
   * `pushRings`, so `peerHasPushRing` is still true — and the fresh obligation
   * then read the cleared count as a FALSE ZERO and started UNPAUSED with the
   * redial's offer queued right behind it. Teardown therefore leaves the
   * counts alone; every entry is still given back by its own handler's
   * `finally`, which is the whole of the ownership rule.
   * `dischargeCancelObligation` and `fireCancelObligation` both
   * used to DELETE the entry, which discarded the shares of every frame
   * already delivered and not yet run — the offer's own handler holds the
   * queue open for seconds while the rest of a drain lands behind it — so the
   * next decision armed at a false depth of zero and started UNPAUSED. The
   * fix is that they no longer touch it; the tests are `a discharge cannot
   * discard the holds of the frames in flight behind it` and the arm-time and
   * release-time guards below.
   *
   * BOUNDED BY A CEILING, NOT BY THE HANDLERS — EXCEPT for the
   * frames that own the placeholder, which the ceiling may not override
   * (`placeholderOwnerHolds` states plainly what that exemption
   * costs, which is that for those two kinds the bound below is gone). The
   * pause
   * cannot become the stuck ring rule 3 forbids — but what stops it is
   * `holdCeiling` on the record, and it had to be added. The old claim here
   * was that the count comes back down on its own, because the decrement is
   * in a `finally` (the throwing case included) and each handler is bounded
   * (the longest await, the credential fetch, carries its own 8-second
   * timeout). That bounds ONE HANDLER. It does not bound the SUM: holds are
   * taken at DELIVERY and given back at HANDLER EXIT, and deliveries overlap
   * handlers, so while frames arrive faster than the queue drains them the
   * count never touches zero and `startCancelTimer` is never called AT ALL.
   * Measured on this suite's own harness, a peer feeding one frame a second
   * into a two-second handler kept a decided cancellation with no countdown
   * of any kind at t = 80 s — past the native watchdog, defect B's shipped
   * behaviour, reached with ordinary frames alone. The test is `the
   * frame-hold pause is BOUNDED — an unending drain cannot hold the ring past
   * its ceiling (the attack)`.
   *
   * A dep that never settles at all wedges the whole envelope queue — no
   * handler ends, so no release ever comes, and the ceiling has nothing to
   * hand the countdown to — which is a larger failure than this one and not
   * something a hold can repair; the native 75-second watchdog is the
   * backstop there, as everywhere here.
   */
  private cancelHolds = new Map<string, number>();
  /**
   * THE SUBSET OF `cancelHolds` THE CEILING MAY NOT OVERRIDE:
   * frames in flight from this peer that OWN the placeholder — a 1:1
   * `call.offer` and a group `call.ginvite`, and nothing else.
   *
   * The ceiling above bounds the aggregate pause, and the way it does that is
   * to let the next handler to END start the countdown with frames still in
   * flight. That countdown's deadline is by then long past, so it is a
   * ZERO-DELAY macrotask started at a handler's exit — and the queue starts
   * the NEXT handler on a microtask. Handler N+1 is therefore already running,
   * already parked in its up-to-eight-second credential fetch, when the fire
   * lands. When handler N+1 is the REDIAL'S OFFER that is the redial defect
   * verbatim: the redial rides the SAME placeholder (native's `alreadyRinging`
   * branch deliberately leaves `pendingPush` on the first ring), so the cid
   * tag matches, and `dismissPendingIncomingCall` clears `pendingAnswered` and
   * abandons the parked rebind. A live ring killed and a tap discarded — and
   * six ordinary two-second group handlers reach it.
   *
   * NO TIMING SEPARATES THE TWO CALLS, because native says they are one. What
   * separates them is a fact only this side has: whether a frame that MAY
   * settle this placeholder is already in flight. So these holds are exempt
   * from the ceiling — and the exemption is stated as "this file does not end
   * the placeholder while one stands", not as "the countdown does not run",
   * because two of the three doors are not that countdown: teardown ends the
   * placeholder with no countdown at all, and the SPECULATIVE
   * fuse is a second countdown that once asked nothing about ownership.
   * `placeholderOwnerInFlight` enumerates all three and the six sites
   * that are deliberately left alone. The sentence once stood while
   * describing only one of them, and both defects were found where it did not
   * reach — a doc that generalises past its code is how this file loses rings.
   *
   * WHAT BOUNDS THE EXEMPTION, HONESTLY, because the sentence that stood here
   * here once was false and the next reader would have trusted it. It said
   * each exempted frame owns the placeholder on EVERY path. The 1:1 arm does:
   * the `call.offer` branch adopts, or dismisses natively at each of its five
   * refusals, and it discharges the obligation either way. THE GROUP ARM DOES
   * NOT. `handleInvite` returns having touched neither the ring nor the record
   * when there is no self id, when the phone is in duress, at each of its four
   * `stale(gen)` returns (a relock or a session change landing inside one of
   * its awaits), and whenever a session is ALREADY LIVE — every refusal there
   * is `state === null`-gated, so a live session takes the invite straight to
   * the dispatch. And `handles()` routes a 1:1 `call.offer` to the coordinator
   * whenever its cid belongs to a live session, where `handleLegEnvelope`
   * never touches the placeholder either; an ICE-restart offer on a group leg
   * therefore takes a hold it cannot honour. So what actually bounds this is
   * weaker than "every path": the FIRST owner frame whose handler does settle
   * the fate ends it, and a handler that throws gives its hold back through
   * `onEnvelope`'s `finally`.
   *
   * SO IT CAN BECOME THE STUCK RING, and that is a disclosed cost rather than
   * an accident. A sustained stream of owner frames whose handlers all take
   * one of the non-settling paths holds this decision with no countdown of any
   * kind — measured on this suite's harness at 30 s of one ginvite a second
   * into a two-second handler with zero dismissals, i.e. out to the native
   * 75-second watchdog. THE OWNERSHIP GUARD WIDENED THAT COST BY EXACTLY NOTHING,
   * though it now applies to the GUESS as well: the same stream already parked
   * the speculative fuse at every arrival (`start()`'s listener parks
   * unconditionally), so a fuse could never burn between those frames either.
   * What is new is only that a fuse armed DURING one of those handlers waits
   * for it instead of firing into it. It is left standing because rule 3 breaks the tie
   * toward the ring and the two sides are not equally reachable: the denial of
   * ring is reached by six ordinary group frames from a group the two people
   * share, while this needs a churning session or a duress lock PLUS an
   * unbroken invite stream. A cap on the exemption would be a fourth escape
   * hatch in this file, and the last two each shipped the defect they were
   * meant to bound.
   *
   * A PURE FUNCTION OF THE ENVELOPE, read at delivery and again at release
   * (`ownsPlaceholder`) rather than remembered between them: a remembered flag
   * is state to lose on the throwing path, which is precisely the path this
   * file has already lost an obligation on twice.
   */
  private placeholderOwnerHolds = new Map<string, number>();

  /**
   * THE RING-PROOF FUSE: a placeholder whose urgent payload proves
   * itself invalid must end PROMPTLY, not at the native 75-second watchdog.
   *
   * `urgent` is a client-set bit on opaque ciphertext, so any unblocked
   * account can ring this phone full-screen with garbage — and the PushKit
   * report obligation means the ring is already up before anything decrypts
   * (CallKitCenter.swift: skipping the report kills the process and, on
   * repeat, revokes VoIP delivery entirely — the fix is never "don't ring").
   * What decides the ring's fate is the frame draining behind the push:
   * messaging reports, through `onFrameVerdict`, every frame that resolved
   * as something that can never ring.
   *
   * EVERY negative outcome for a peer with a noted push ring arms this same
   * short fuse rather than dismissing outright, because the legitimate drain
   * interleaves: "calling you now" texted moments before the call — and just
   * as much a stale `call.answer` or `call.gjoin` from the PREVIOUS call —
   * sits AHEAD of the offer in the queue, and a per-frame dismissal would
   * bounce a genuine ring (worse than bouncing, the native
   * dismiss clears `pendingAnswered` and abandons a parked rebind, so an
   * answer the person already made was lost outright). That covers the
   * frame verdicts messaging reports AND the three inert outcomes decided
   * in the queue itself: a group frame the router did not adopt, a
   * call-shaped frame the strict schema refuses, and a valid control frame
   * no live call matches. Call signalling from that peer PARKS it — at
   * delivery (`start()`, every delivery there IS call signalling) and again
   * when its queued handling begins (`onEnvelope`), because a fuse armed by
   * an EARLIER frame's handler postdates the delivery-time park of a
   * frame already sitting in the queue behind it, and must not burn while
   * that frame's own handling stalls in a credential fetch. Parking stops
   * the countdown; it does not move the deadline — see
   * `ringProofDeadlines` below for why those are different acts. NEITHER
   * PARK CAN SEE A FUSE ARMED WHILE A HANDLER IS ALREADY RUNNING, because
   * both fire at or before a handler's first line and a verdict comes from
   * messaging's drain outside this file's queue; that third window is held
   * by `ringProofOwed` instead — the fuse is not lit at all while a frame
   * that MAY settle the placeholder is in flight. Only a
   * frame that actually settles the placeholder's fate — an offer or
   * invite adopting it, or a branch that dismisses it itself — RETIRES the
   * fuse outright. When the fuse does burn down, the placeholder is ended
   * through the existing native dismiss path, whose own guard makes a late
   * or stale fuse a strict no-op: it only acts while `pendingPush` still
   * names this exact peer, and the rebind clears `pendingPush` the moment
   * a real offer adopts the ring.
   *
   * Two seconds: the drain is serialized decrypts apart — tens of
   * milliseconds between frames — so the legitimate offer lands well inside
   * it, while an attacker's garbage ends ~2 s after it drains instead of
   * 75. Per-peer, bounded by `pushRings` (≤ 8 noted rings).
   */
  private ringProofFuses = new Map<string, ReturnType<typeof setTimeout>>();
  /**
   * THE GRACE IS ABSOLUTE. The first arming for a
   * peer's noted ring captures a deadline — now + 2 s — and no later frame
   * moves it. Without this, park-then-rearm was a renewable lease: every
   * well-formed inert control frame (a stale `call.answer`, an unmatched
   * delta) parked the running fuse at delivery and its inert outcome armed
   * a FRESH two seconds, so an attacker feeding one frame per second kept
   * a garbage ring alive to the native 75-second watchdog — the exact
   * harassment the fuse exists to end. Now a re-arm resumes at whatever
   * remains of the ORIGINAL deadline (clamped at zero), so the drain can
   * interleave as much as it likes and the ring still dies on time.
   *
   * The deadline outlives a park on purpose — that is the whole fix — and
   * is retired only with the fuse's job: adoption by a real 1:1 offer, a
   * branch that dismissed the placeholder itself, a fresh push, or the
   * burn-down. A GROUP-adopted frame only ever PARKS while a note stands:
   * `adopted` is true for every ginvite and for session traffic,
   * so a retire there was a free reset of this deadline, reachable with
   * frames alone — the full enumeration lives at that branch. It
   * must NOT be retired by mere arrival, and it must not linger past the
   * ring it measures: a stale expired deadline would make the next ring's
   * first inert frame burn instantly, re-condemning the queued offer one
   * frame behind it (the queued-offer regression this map must not
   * reintroduce). Two guarantees make that lingering impossible: every
   * path that settles a placeholder's fate retires the deadline WITH the
   * noted rings (`settleRingProof` — a note left behind would let ordinary
   * mid-call chatter arm a fuse whose parked deadline nothing ever owns
   * again), and a NEW noted ring retires whatever somehow remains before
   * its own drain begins (`notePushRing` — a new ring gets a new clock,
   * never a previous ring's).
   */
  private ringProofDeadlines = new Map<string, number>();
  /**
   * Why the fuse for this peer will end the placeholder, if it burns.
   *
   * The reason is not cosmetic: CallKitCenter.dismissPendingIncomingCall maps
   * 'cancelled' to `.remoteEnded` and EVERYTHING ELSE to `.unanswered`, which
   * is the difference between the missed-call entry saying the caller hung up
   * and it saying this phone ignored them. Once a `call.end` defers its
   * dismissal onto this fuse (see the branch), the reason has to travel with
   * the deferral or the deferral quietly relabels the call.
   *
   * 'cancelled' IS NOT ONE OF THESE VALUES ANY MORE. It never belonged: a
   * cancellation is a DECISION and everything in this map is a GUESS, and
   * storing them together is what let a push retire the decision along with
   * the speculation around it. The decision lives in `cancelObligations`,
   * which outranks this map STRUCTURALLY — `armRingProof` early-returns while
   * one stands — instead of by an upgrade rule inside it.
   */
  private ringProofReasons = new Map<string, 'not_call' | 'invalid'>();
  /**
   * A FUSE THIS FILE REFUSED TO LIGHT WHILE A FRAME THAT OWNS
   * THE PLACEHOLDER WAS IN FLIGHT, and owes the moment that frame lets go.
   *
   * THE DEFECT IT CLOSES. `armRingProof`'s burn-down is the SECOND timer aimed
   * at this placeholder — a bare `setTimeout` dismissing the same cid as the
   * decision's countdown — and earlier guards covered only the
   * decision. The two parks cannot cover it: both fire at or before a handler's
   * first line (delivery in `start()`, handler-top in `handleEnvelope`), while
   * a verdict is emitted from messaging's own drain OUTSIDE the serialized
   * queue, so a verdict landing WHILE an owner's handler runs armed a fuse
   * nothing would ever park. The offer branch retires the old deadline at its
   * top (deliberately — a stale one would instant-burn the next ring), so that
   * verdict minted a FRESH two seconds inside a credential fetch bounded at
   * EIGHT. The plain first ring reached it: an offer and one ordinary text in
   * one drain on a phone that just woke, no attacker, no cancellation, no
   * group. The ring the person was looking at ended, CallKit filed .unanswered,
   * and `dismissPendingIncomingCall` cleared `pendingAnswered` and abandoned
   * the parked rebind on its way out.
   *
   * A PARKED FUSE, NOT A DROPPED ONE, and that is the whole of its semantics.
   * The reason and the ABSOLUTE deadline are recorded before the refusal, so
   * nothing is lost and nothing is re-clocked; only the timer is withheld. The
   * owner's release resumes it on whatever is left of the original deadline,
   * floor zero — `Math.max(0, deadline - now)`, which is a macrotask, and the
   * queue starts the next handler on a MICROTASK, so a real offer or invite
   * already queued behind still parks it and wins the door (the queued-offer
   * guarantee, unchanged).
   *
   * AND A PARK CLEARS IT, exactly as a park clears a lit fuse. This set may not
   * become a way for a verdict to survive an act that puts fuses out: the
   * group-adopted branch parks, every arrival parks, `armCancelObligation`
   * parks because a decision outranks a guess, and `retireRingProof` parks
   * because the fate is settled. Left standing through those, a verdict
   * deferred inside a ginvite's handler would burn the instant the coordinator's
   * own ring was reported — and while native's rebind is PARKED (the report
   * verdict still in flight, `CallKitCenter` line 311) `pendingPush` still
   * stands, so that dismissal is not the harmless no-op it is after a rebind:
   * it abandons the rebind and the answer with it. Rule 3 breaks that tie
   * toward the ring. What the deadline's survival guarantees is that the guess
   * is never LOST: the next inert frame resumes it at zero.
   *
   * Bounded by `pushRings` like every other per-peer entry here, cleared with
   * the fuses in `stop()`, and never read for anything but "is one owed".
   */
  private ringProofOwed = new Set<string>();
  private static readonly RING_PROOF_GRACE_MS = 2_000;
  /**
   * How long a decided cancellation waits for the drain a POST-DECISION push
   * triggered. See `holdCancelForPush`.
   *
   * Longer than the grace on purpose, and the two measure different things.
   * The grace waits for a frame that is ALREADY on this device — the offer
   * drained one behind the end — so two seconds is generous. This waits for a
   * frame that is not here yet: the push has to wake JS, `messaging.resume()`
   * has to reconnect a socket that backgrounding paused, and the envelope has
   * to arrive and decrypt. That round trip on a just-woken phone was measured
   * at ~2 s, and a two-second ceiling therefore lost the race at the boundary
   * — which is exactly how re-clocking killed a redial's ring.
   *
   * Overshooting costs a bounded ghost ring: the placeholder of a genuinely
   * cancelled call rings up to this much longer before the dismissal lands.
   * Undershooting costs a LIVE ring plus an answer the person already tapped.
   * Rule 3 forbids both, so the tie goes to the ring, and the overshoot is
   * bounded twice over — the ceiling is absolute and non-renewable, and it
   * only ever DELAYS a dismissal that is already decided and still fires.
   */
  private static readonly CANCEL_PUSH_HOLD_MS = 4_000;
  /**
   * How long FRAME holds may pause a decided cancellation in aggregate,
   * measured from the decision. The bound the sum never had — see
   * `cancelHolds` for what was unbounded and how far it ran.
   *
   * DERIVED, not chosen: it must clear the longest legitimate pause, which is
   * one credential fetch (`CREDENTIAL_TIMEOUT_MS`, the only multi-second
   * await in a handler, and single-flight so a drain pays it once) plus the
   * time a just-woken socket needs to deliver the frame that fetch is for
   * (`CANCEL_PUSH_HOLD_MS`, measured for exactly that). A legitimate drain
   * never reaches this: the offer adopts and DISCHARGES the obligation, and a
   * drain whose count has not touched zero in twelve seconds is not a drain
   * this device is going to catch up with.
   *
   * IT IS NOT A DISMISSAL DEADLINE, and it does not fire anything itself. It
   * ends the PAUSE; the countdown then starts at the next handler's EXIT, on
   * the deadline it has always had. So the overshoot past this is one handler
   * — and, if a push landed just under the wire, that push's own absolute
   * ceiling and the handler behind it. Tens of seconds at the very worst,
   * never the 75-second watchdog.
   *
   * WHAT IT COSTS, STATED PLAINLY: the countdown starts at a handler's exit,
   * but its deadline is by then long past, so the fire is a zero-delay
   * macrotask and the NEXT handler may have started by the time it lands —
   * the queue starts it on a microtask, so it always has. AN EARLIER VERSION CALLED
   * THAT AN ACCEPTED COST AND IT WAS A DEFECT: the next handler can be the
   * REDIAL'S OFFER, and the fire then ends the ring that offer is one await
   * from adopting, which is the one thing this whole path exists to prevent.
   * What is accepted is only the ordinary case. A frame that OWNS the
   * placeholder is exempt from this ceiling entirely
   * (`placeholderOwnerHolds`), so the handler the fire can land in is never
   * one that could have claimed the ring. Under the ceiling nothing changes:
   * the fire cannot reach a handler at all.
   */
  private static readonly CANCEL_HOLD_CEILING_MS =
    CREDENTIAL_TIMEOUT_MS + CallController.CANCEL_PUSH_HOLD_MS;
  private unsubscribeVerdicts: (() => void) | null = null;

  /**
   * Consume a placeholder decline recorded for this peer, if one is still
   * inside the window.
   *
   * PUBLIC because the tombstone is 1:1-shaped and the invites that need it
   * are not: a VoIP push carries a PEER, never a session, so a declined group
   * ring lands here — and a `call.ginvite` is routed to the group coordinator
   * by `handles()` long before the offer path that consults this. The
   * coordinator asks through `takePushDecline`; the answer is consumed either
   * way, so one decline answers one invite and cannot ambush the next.
   */
  /** Remember that the peer ended `cid`, for an offer draining behind it. */
  private tombstoneEnd(cid: string): void {
    this.pruneEndTombstones();
    this.endedCids.delete(cid);
    this.endedCids.set(cid, this.deps.now());
    if (this.endedCids.size > MAX_END_TOMBSTONES) {
      const oldest = this.endedCids.keys().next().value;
      if (oldest !== undefined) this.endedCids.delete(oldest);
    }
  }

  private isEndTombstoned(cid: string): boolean {
    this.pruneEndTombstones();
    return this.endedCids.has(cid);
  }

  private pruneEndTombstones(): void {
    const now = this.deps.now();
    for (const [cid, at] of this.endedCids) {
      if (now - at > END_TOMBSTONE_MS) this.endedCids.delete(cid);
    }
  }

  takePushDecline(peerId: string): boolean {
    const declinedAt = this.pushDeclines.get(peerId);
    if (declinedAt === undefined) return false;
    this.pushDeclines.delete(peerId);
    return this.deps.now() - declinedAt < CallController.PUSH_DECLINE_WINDOW_MS;
  }

  /**
   * Whether this peer may ring the phone.
   *
   * PUBLIC for the reason `takePushDecline` above is: the rule is about the
   * DEVICE, not about the 1:1 call shape. A `call.ginvite` is routed to the
   * group coordinator by `handles()` long before the `call.offer` branch that
   * consults `deps.mayRing`, so a session invite reached the phone with no
   * gate in front of it at all — a stranger who put you in a roster made your
   * phone ring, which is exactly what the published sentence says cannot
   * happen. The coordinator asks through here rather than carrying its own
   * copy of the wiring, so there stays ONE place the facts are read and one
   * rule (`decideRing`) deciding what they mean.
   *
   * Absent dep ⇒ `{ ring: true }`, the pre-V7 behaviour both shapes share.
   */
  async mayRing(peerId: string): Promise<{ ring: boolean; reason?: 'unknown_caller' }> {
    if (!this.deps.mayRing) return { ring: true };
    return this.deps.mayRing(peerId);
  }

  /**
   * DECIDE AND APPLY THE RELAY POLICY FOR A SMALL-GROUP SESSION.
   *
   * PUBLIC for the reason `mayRing` and `takePushDecline` above are: the rule
   * is about this device's relationship with a PERSON, and it does not qualify
   * itself by how many people are on the call. `group.ts` owns no `configure`
   * of its own — it calls `ensureCredentials` and inherits whatever ICE policy
   * the module was last given — so the app-wide switch reached a session (it
   * is read on every `configure`) while the FIRST-CALL DEFAULT and the
   * PER-PERSON MEMORY did not. A first small-group call with someone you have
   * never called went direct and handed them your address, which is precisely
   * what the published sentence says cannot happen.
   *
   * ANY PARTICIPANT'S `true` RELAYS THE WHOLE SESSION, because there is one
   * knob for N legs — see `relayForThisSession` for the argument and for why
   * the answer only ever ratchets up. The caller may pass the whole roster (at
   * the start of a session, or when an invite is admitted) or a single late
   * joiner at the dial site; the effect is the same, and passing one peer is
   * how a session that grows keeps its promise to the person who just arrived.
   * SELF MUST NOT BE PASSED: the policy would read "you have never called
   * yourself", answer `true`, and relay every session ever made.
   *
   * Short-circuits once the answer is `true`, so a session that already relays
   * spends no further reads on its roster, and a failed read RELAYS — both
   * `decideRelayFor`'s reasoning, unchanged.
   *
   * The credential fetch and the push are `placeCall`'s pair, in `placeCall`'s
   * order and for its reasons: decide first so a refresh configures with the
   * right policy the first time, and push afterwards because in production the
   * credential is cached for hours and `configure` is otherwise never reached
   * at all.
   *
   * TOTAL: every failure inside is caught here or below (`relayForPeer`,
   * `ensureCredentials` and `configure` each swallow their own), so no caller
   * has to decide what a thrown relay decision would mean.
   *
   * Absent `relayForPeer` ⇒ no decision and no `configure` of its own, which
   * is the pre-wiring behaviour the CLI and the committed effect trace hold.
   */
  async relayForSession(peerIds: readonly string[]): Promise<void> {
    if (!this.deps.relayForPeer) return;
    for (const peerId of peerIds) {
      if (this.relayForThisSession) break;
      // Only ever ASSIGNED true: a later `false` must not undo an earlier
      // `true`, which is the whole of "any leg relays the session".
      if (await this.deps.relayForPeer(peerId).catch(() => true)) {
        this.relayForThisSession = true;
      }
    }
    await this.ensureCredentials();
    await this.pushRelayPolicy();
  }

  /**
   * The session is over: forget its verdict.
   *
   * The mirror of the `idle` reset `relayForThisCall` gets, and it has to be
   * an explicit call because a session's end is INVISIBLE to the 1:1 machine —
   * no state change of that reducer's ever fires for it, so there is no
   * `onStateChange` hook to hang this on.
   *
   * No `configure` goes with it. Nothing builds a peer connection without
   * first passing through `placeCall`, `onEnvelope`'s offer branch,
   * `rehydrate` or `relayForSession`, and each of those re-decides and pushes;
   * a bridge call during teardown would buy nothing and can fail. A verdict
   * left standing by a missed release would only ever over-relay — the safe
   * direction — but it would claim a relay hop for calls that never asked for
   * one, and an unpredictable policy is not a policy.
   */
  releaseSessionRelay(): void {
    this.relayForThisSession = false;
  }

  /**
   * Called by the voipPush subscription: this synthetic cid rang for `from`.
   *
   * `ringCid` is the cid of the placeholder native says is ACTUALLY RINGING
   * for this caller, which on an `alreadyRinging` push is the FIRST ring's cid
   * and not `cid`. Defaulted so a JS build running ahead of the binary — and
   * every existing caller — degrades to the caller-keyed match.
   */
  notePushRing(cid: string, from: string, ringCid = ''): void {
    if (!from) return;
    // RING PROOF — THE INVARIANT THIS SITE ENFORCES: A NEW RING GETS A NEW CLOCK.
    // A delivered VoIP push IS a new native ring (the PushKit report already
    // fired; skipping it is never an option), so any fuse or absolute
    // deadline still standing from an EARLIER ring of this peer's is retired
    // before this one is noted. Left standing, a stale expired deadline
    // burns this ring's first inert frame at ZERO — `Math.max(0, deadline -
    // now)` in `onFrameVerdict` — condemning the offer draining one frame
    // behind it before it can decrypt, and the native dismiss discards even
    // an answer the person already tapped ("text me, then call me" on a
    // backgrounded phone; no attacker required). The absolute grace
    // is not weakened: inert FRAMES still only resume the original
    // deadline and can never move it. Only a fresh PUSH mints a fresh grace,
    // and a push re-rings the phone natively regardless, so an attacker
    // buys nothing here that the push itself did not already cost them.
    //
    // THE INVARIANT, STATED WHOLE: A NEW RING GETS A NEW CLOCK, AND A DECIDED
    // CANCELLATION IS NOT ON IT. Everything this site retires is SPECULATION —
    // a fuse armed by an inert frame ('not_call'/'invalid') is a guess the next
    // inert frame re-arms, so losing it costs nothing. The decision a
    // `call.end` made is not stored here at all: it lives in
    // `cancelObligations`, names the ring it decided, and keeps that ring's
    // deadline. So a push can neither repeal it nor POSTPONE it onto a later
    // ring's clock.
    //
    // Postponing was the defect, and it is the ordinary path rather than an
    // attack. CallKitCenter reports every announced end, so a caller who
    // cancels while this phone is dead sends a SECOND VoIP push whose
    // `alreadyRinging` branch leaves native `pendingPush` on the FIRST ring —
    // and index.ts turns every such push into a `notePushRing`. Re-armed here,
    // the decision was pushed past the caller's REDIAL push, kept the
    // condemned placeholder alive until the redial was riding it, and then
    // killed that: the ring the person was looking at died for a call that had
    // already ended.
    //
    // `retireRingProof` must NOT touch `cancelObligations` — that is the whole
    // of the fix, and deleting this sentence is how the carry comes back.
    this.retireRingProof(from);
    // Bounded: entries are consumed by decline or superseded by the rebind;
    // anything else is a stale placeholder nobody ever declined.
    if (this.pushRings.size >= 8) {
      const oldest = this.pushRings.keys().next().value;
      if (oldest !== undefined) this.pushRings.delete(oldest);
    }
    this.pushRings.set(cid, from);
    // THE PUBLISHED VALUE, VERBATIM — `''` included. Falling back to `cid`
    // would name a throwaway on every `alreadyRinging` push, and a dismissal
    // naming a throwaway matches nothing: a permanently stuck ring, which is
    // strictly worse than no tag at all.
    this.ringCids.set(from, ringCid);
    // …and a push that lands after a decision was made is not free of it.
    this.holdCancelForPush(from);
  }

  /**
   * A VoIP push landed for a peer whose cancellation is already DECIDED.
   *
   * THE CID TAG CANNOT SEPARATE THESE TWO CALLS, and that is why this exists.
   * A tag separates placeholder INSTANCES; a cancel-then-redial inside the
   * grace produces two logical calls sharing ONE instance, because
   * `CallKitCenter`'s `alreadyRinging` branch deliberately does not replace
   * `pendingPush` (replacing it orphaned the ring that was actually up). So
   * `ringingCid(for:)` publishes the FIRST ring's cid again, the obligation
   * still names it, the guard matches — and the dismissal ends a ring that has
   * been up continuously and that the redial's peer-matched rebind was one
   * socket round trip from adopting. `dismissPendingIncomingCall` clears
   * `pendingAnswered` (an answer already tapped) and abandons the parked
   * rebind on its way out. A live ring killed and a tap discarded: rule 3.
   *
   * The information was already here — index.ts hands every push to
   * `notePushRing` — and merely unused. What it may NOT do is repeal the
   * decision (nothing dismissed, the placeholder rings to the 75-second
   * watchdog) or postpone it onto the new ring's clock (the re-clocking that
   * burned a ring it never decided). It takes a HOLD:
   *
   *   • THE DEADLINE IS UNTOUCHED. Released by a frame, the decision resumes
   *     on the clock it has always had — by then usually in the past, so it
   *     fires at once. This is not the carry: the hold can only delay the
   *     fire, never move the decision onto a later ring's grace.
   *   • RELEASED BY THE DRAIN SETTLING, NOT BY IT STARTING.
   *     What ends this hold early is the redial's offer ADOPTING — which
   *     discharges the whole obligation — and nothing else; a frame merely
   *     being delivered does not, because the frames of one drain arrive in
   *     separate turns and the offer holds nothing yet when the frame ahead
   *     of it is handled. Surrendering the hold to that first frame killed a
   *     live ring 2.3 s inside the ceiling; the argument is at
   *     `holdCancelObligation`.
   *   • BOUNDED, because a hold nothing settles is a stuck ring whenever the
   *     drain never produces an offer — the push may be the cancellation's
   *     OWN (every announced end is urgent), whose frame has already drained.
   *   • THE CEILING IS ABSOLUTE, dated from the FIRST post-decision push. A
   *     later push re-takes the hold but cannot re-date it, or push-then-frame
   *     alternation would walk a cancelled ring to the watchdog — the
   *     renewable lease this file has closed twice already.
   */
  private holdCancelForPush(peerId: string): void {
    const rec = this.cancelObligations.get(peerId);
    if (!rec) return;
    const now = this.deps.now();
    if (rec.pushCeiling === 0) rec.pushCeiling = now + CallController.CANCEL_PUSH_HOLD_MS;
    // Spent. A push arriving past the ceiling holds nothing at all — the
    // decision is already overdue and the next release fires it.
    if (now >= rec.pushCeiling) return;
    if (rec.timer != null) {
      clearTimeout(rec.timer);
      rec.timer = null;
    }
    if (rec.pushHold != null) clearTimeout(rec.pushHold);
    rec.pushHold = setTimeout(() => this.releaseCancelPushHold(peerId), rec.pushCeiling - now);
  }

  /** The ceiling elapsed: the hold is over and the decision resumes on its
   * OWN deadline. THE ONLY WAY OUT OF THIS HOLD other than the record being
   * removed by the act that settles the placeholder's fate — a delivered
   * frame no longer takes it (`holdCancelObligation`).
   *
   * THE FRAME-HOLD GUARD IS THE MIRROR of `armCancelObligation`'s, and it is
   * not the same condition arriving twice: the two holds are independent and
   * the ceiling can elapse while a handler is STILL IN FLIGHT (a push at
   * T0+300 beside an offer stalled in its credential fetch puts the ceiling at
   * T0+4300, mid-fetch). Resumed there, the countdown has a deadline seconds
   * in the past and fires AT ONCE — the live ring ends mid-fetch, with the
   * tapped answer `dismissPendingIncomingCall` clears. The last hold to go
   * starts the countdown; a ceiling is not a hold. */
  private releaseCancelPushHold(peerId: string): void {
    const rec = this.cancelObligations.get(peerId);
    if (!rec || rec.pushHold === null) return;
    clearTimeout(rec.pushHold);
    rec.pushHold = null;
    if ((this.cancelHolds.get(peerId) ?? 0) === 0) this.startCancelTimer(peerId);
  }

  /**
   * ARM THE DECIDED CANCELLATION for `peerId` — the `call.end` branch's
   * deferral, and the group arm's `noteRingCancelled`.
   *
   * FIRST DECISION WINS. A second `call.end` inside the grace is the same
   * decision restated; re-arming on it would be the renewable lease again.
   */
  private armCancelObligation(peerId: string): void {
    if (!peerId || !this.peerHasPushRing(peerId)) return;
    if (this.cancelObligations.has(peerId)) return;
    const now = this.deps.now();
    // THE DECISION INHERITS THE EARLIER OF THE TWO CLOCKS. A fuse already lit
    // by an inert frame must not be EXTENDED by appending a `call.end` — that
    // is the renewable lease the absolute-grace rule closed, re-opened by a
    // new door: one `call.end` per two seconds of garbage would keep a ring
    // alive to the 75-second watchdog with frames alone.
    const speculative = this.ringProofDeadlines.get(peerId);
    const deadline = Math.min(
      now + CallController.RING_PROOF_GRACE_MS,
      speculative ?? Number.POSITIVE_INFINITY,
    );
    // THE DECISION OUTRANKS THE GUESS, structurally: the speculative fuse is
    // put out and its reason dropped, so one timer decides this placeholder's
    // fate and it burns with 'cancelled' — .remoteEnded, "they hung up" —
    // rather than .unanswered, "you ignored them".
    this.parkRingProof(peerId);
    this.ringProofReasons.delete(peerId);
    this.cancelObligations.set(peerId, {
      ringCid: this.ringCids.get(peerId) ?? '',
      deadline,
      timer: null,
      pushHold: null,
      pushCeiling: 0,
      holdCeiling: now + CallController.CANCEL_HOLD_CEILING_MS,
    });
    // THE GUARD IS LOAD-BEARING, and the state it guards is the ONLY state
    // this method is ever reached in. `armCancelObligation` runs from inside
    // `handleEnvelope`, so the delivery-time hold for THIS frame is always
    // outstanding: the depth here is never zero. It is not always ONE, and
    // the drain is not what makes it more — the frames of one drain arrive in
    // turns of their own, a decrypt and a `markSeen` apart (messaging.ts's
    // call branch), so what stands beside this frame is whatever the queue
    // has not caught up with yet. In the ordering the feature exists for
    // ("the caller hung up while this phone was dead, both frames drained
    // together") the offer is one of those, delivered while this end is still
    // being handled. Started unpaused here, the timer fires at +2000 inside
    // the offer branch's up-to-eight-second credential fetch and ends the
    // placeholder the offer is one await from adopting.
    //
    // "ALWAYS OUTSTANDING" WAS NOT ALWAYS TRUE, and this guard
    // read zero anyway: a discharge earlier in the same drain deleted the
    // whole count, so the frames still queued behind it — this one included —
    // had no share left to be seen. The guard is only as good as the count it
    // reads, which is why nothing but the delivery/`finally` pair writes it.
    if ((this.cancelHolds.get(peerId) ?? 0) === 0) this.startCancelTimer(peerId);
  }

  /**
   * Resume (or begin) the obligation's countdown on its ORIGINAL deadline,
   * floor zero.
   *
   * CALLED WITH A FRAME HOLD OUTSTANDING IN EXACTLY ONE STATE, and it is the
   * state the ceiling exists to reach. Two of the three callers still test
   * `cancelHolds` first (`armCancelObligation`, `releaseCancelPushHold`) and
   * arrive only at depth zero. The third, `releaseCancelObligation`, also
   * arrives once `cancelPauseSpent` is true: frames still in flight, the
   * pause spent, the countdown owed. An earlier version wrote "never" here, and
   * could, because nothing bounded the sum — that unboundedness was the
   * stuck-ring twin, and this door is what closes it. A later fix put the
   * door's ONE lock on it, in the body below: those frames still in flight may
   * not include one that owns the placeholder.
   *
   * `pushHold !== null` IS STILL LOAD-BEARING and reachable: a push hold
   * outlives the frame hold taken beside it, so the ordinary release path
   * arrives here with the ceiling still standing (`a push taken DURING a
   * stalled handler outlives that handler's release`).
   *
   * `timer !== null` is an INVARIANT ASSERTION, not a guard, and a later fix
   * NARROWED the reason rather than removing it. It used to read "a delivery
   * clears the timer as it takes its hold, and nothing restarts one above
   * depth zero"; past the ceiling neither half is true — a delivery leaves a
   * running countdown alone, and a release restarts one with frames still in
   * flight. What keeps it unreached is that such a countdown always has a
   * deadline in the past, so it is a zero-delay timer that fires on the next
   * macrotask, and every further release in that window finds the record
   * already gone. Instrumented over the call suites, entry with a countdown
   * running is still 0 of 48. It stays because the cost of being wrong is the
   * stale-timer class this file has already paid for twice — a second
   * `setTimeout` would leak the first handle past `stop()` and fire it
   * against the NEXT ring's record — but nothing may lean on it, and no test
   * pins it: deleting it is green, and the duplicate it prevents would fire a
   * macrotask later against a record the first fire has already removed.
   */
  private startCancelTimer(peerId: string): void {
    const rec = this.cancelObligations.get(peerId);
    if (!rec || rec.timer !== null || rec.pushHold !== null) return;
    // THE CEILING'S ONE LIMIT, and the choke point it is stated at.
    // The two guards above are reached only at depth zero; this one
    // exists for the third caller, `releaseCancelObligation`'s spent arm,
    // which by design starts a countdown WITH FRAMES STILL IN FLIGHT. Its
    // deadline is past, so it fires on the next macrotask — after the queue
    // has already started the next handler on a microtask — and if that
    // handler is the redial's offer, the fire ends the ring it is one await
    // from adopting. A frame that owns the placeholder therefore outranks the
    // ceiling; `placeholderOwnerHolds` carries the whole argument, including
    // what it costs. THE SAME CONDITION IS RESTATED AT `fireCancelObligation`
    // AND AT `armRingProof`, and neither is belt and braces: teardown reaches
    // the dismissal without ever coming through here, and the
    // speculative fuse is a whole second timer that never came through here at
    // all. `placeholderOwnerInFlight` enumerates all three.
    //
    // WHICH MAKES THIS ONE AN OPTIMISATION NOW, AND DELETING IT IS GREEN —
    // said here rather than left for the next reader to discover. The dismissal
    // is refused at the choke point either way; what this saves is a countdown
    // created only to no-op on its next macrotask, once per delivery for as
    // long as the owner frame runs. It stays because "do not start a clock
    // aimed at a ring somebody else already owns" is the honest statement of
    // the rule at the point where the clock is decided, and because a record
    // that never carries a spent handle is one fewer state to reason about.
    if (this.placeholderOwnerInFlight(peerId)) return;
    rec.timer = setTimeout(
      () => this.fireCancelObligation(peerId),
      Math.max(0, rec.deadline - this.deps.now()),
    );
  }

  /**
   * Whether a frame that OWNS this peer's placeholder is being handled right
   * now — the one condition under which this file may not end that
   * placeholder. See `placeholderOwnerHolds` for the whole argument.
   *
   * A METHOD RATHER THAN THE EXPRESSION IT REPLACES, because this rule was once
   * stated at ONE of the paths to the dismissal and the others were the
   * defect — twice running.
   *
   * NINE CALL SITES REACH `dismissPendingIncomingCall`, counted by hand from
   * `grep -n` over this file and `group.ts` (an earlier doc said "those
   * two plus six more" and then listed EIGHT — the miscount was in the sentence
   * that licensed them). THREE OF THE NINE CAN FIRE WITH NO HANDLER OWNING THE
   * RING — two timers and one teardown — and all three consult this. (There are
   * four `setTimeout`s in this file: the credential fetch's, which dismisses
   * nothing; the push hold's, which reaches a dismissal only by calling
   * `startCancelTimer` and is therefore covered by 1; and the two below.)
   *   1. `startCancelTimer`'s countdown — the DECISION's ordinary door, and the
   *      only one that arrives with frames still in flight by design (the
   *      spent-ceiling arm of `releaseCancelObligation`). Refused here, no timer
   *      is created at all, and the release that ends the last owner hold
   *      creates it.
   *   2. `stop()`'s flush — teardown, which uses no countdown and so passed
   *      guard 1 entirely. Refused at `fireCancelObligation`,
   *      the record is LEFT STANDING (teardown must not `clear()` it) and the
   *      owner's own handler settles it or its release fires it.
   *   3. `armRingProof`'s burn-down — the GUESS, and structurally the same
   *      object as 1: a bare `setTimeout` ending the same cid. It consults
   *      `cancelObligations` and `peerHasPushRing` and asked nothing about
   *      ownership until this guard was added, so a verdict arriving mid-handler — from
   *      messaging's drain, OUTSIDE this file's queue, which is why neither park
   *      can see it — burned the ring an offer was one await from adopting.
   *      Refused there, the deadline and reason are recorded and only the timer
   *      waits (`ringProofOwed`).
   * THE OTHER SIX SITES ARE NOT GUARDED AND MUST NOT BE, because every one of
   * them IS a frame's own handler settling the ring it owns — the act these
   * three defer TO. Guarding them would deadlock the deferral against itself.
   * They are: the five refusals inside the `call.offer` branch (busy, expired, a
   * decline made against the placeholder, silenced, the reducer refusing), and
   * the immediate arm of `call.end`. `group.ts`'s `dismissPlaceholder` is the
   * ninth and sits across the seam: also a handler settling its own ring, and
   * reached only from the coordinator's own refusals.
   *
   * SO THE EXEMPTION'S SENTENCE IS NOW TRUE AS WRITTEN at
   * `placeholderOwnerHolds` — "this file does not end the placeholder while one
   * stands" — where it once described only the decision.
   */
  private placeholderOwnerInFlight(peerId: string): boolean {
    return (this.placeholderOwnerHolds.get(peerId) ?? 0) > 0;
  }

  /** The grace elapsed (or teardown flushed it): end the placeholder this
   * decision was about. */
  private fireCancelObligation(peerId: string): void {
    const rec = this.cancelObligations.get(peerId);
    if (!rec) return;
    if (rec.timer != null) {
      clearTimeout(rec.timer);
      // NULLED, not merely cleared, because of the deferral below: a spent
      // handle left in the record would make `startCancelTimer`'s
      // `timer !== null` invariant refuse forever, and the deferred decision
      // would then be a dismissal that never fires — the stuck ring.
      rec.timer = null;
    }
    // AND `rec.pushHold` IS DELIBERATELY NOT MIRRORED HERE, though
    // `startCancelTimer` refuses on both handles (re-derived deliberately,
    // because the asymmetry reads like the half-applied rule 1 it is not). The
    // two differ in exactly the property the paragraph above names. `timer` is
    // SPENT: on the countdown path it has already fired, and nothing but this
    // line would ever null it. `pushHold` is LIVE — `startCancelTimer` will not
    // create a countdown while one stands and `holdCancelForPush` clears any
    // countdown as it takes the hold, so a fire can never reach here with a
    // spent one — and its own firing nulls it (`releaseCancelPushHold`) and
    // starts the countdown. Clearing it here would not fix a stall; it would
    // CUT the push hold short, which would re-ship a reverted defect: the
    // hold exists because the redial's frame is not on this device yet, and
    // surrendering it early killed a live ring 2.3 s inside the ceiling. The
    // deferral therefore costs at most `CANCEL_PUSH_HOLD_MS` of extra ghost
    // ring, which is the bound that constant already advertises.
    // THE SECOND DOOR. `stop()` calls this DIRECTLY, so the
    // exemption stated at `startCancelTimer` was not on this path at all:
    // teardown with the redial's offer parked in its credential fetch ended
    // the ring that offer was one await from adopting, `pendingAnswered` and
    // the parked rebind with it. The redial defect, reached through teardown's
    // flush. `stop()`'s old justification — "a placeholder replaced since is a
    // strict no-op natively" — is exactly the reasoning a later fix
    // demolished: on a cancel-then-redial nothing has been replaced, because
    // `alreadyRinging` keeps `pendingPush` on the FIRST ring.
    //
    // DEFERRED, NEVER DROPPED, and that is the whole of the rule. The record
    // survives this return — teardown no longer clears it — so the frame that
    // owns the placeholder settles it (adopting DISCHARGES the obligation) or,
    // ending any other way, gives its hold back and `releaseCancelObligation`
    // starts the countdown that fires this. Dropping it here would be defect
    // B, which an earlier version shipped; firing it is the defect above. Rule 3
    // forbids both, and the tie it breaks toward the ring is broken by handing
    // the decision to the one handler that can tell the two calls apart.
    if (this.placeholderOwnerInFlight(peerId)) return;
    if (rec.pushHold != null) clearTimeout(rec.pushHold);
    // REMOVED BEFORE SETTLING: `settleRingProof` discharges obligations, and a
    // record still present here would recurse straight back into this method.
    this.cancelObligations.delete(peerId);
    // `cancelHolds` IS NOT TOUCHED HERE EITHER — see
    // `dischargeCancelObligation` for the whole argument. THE REASON THAT USED
    // TO BE GIVEN HERE IS DEAD, both halves of it, and neither fix that
    // killed one came back to say so: it read "a fire only ever runs at depth
    // zero (a frame's delivery clears the timer, and nothing restarts it above
    // zero), and the exception is `stop()`, which clears the count itself a
    // line later". Past the ceiling a release restarts the countdown WITH
    // frames in flight, so a fire at depth > 0 is ordinary; and
    // `stop()` clears nothing now (that clear WAS the false
    // zero). What holds regardless is the ownership rule: the count is not
    // this record's state, and every hold is given back by the handler that
    // took it.
    // One cleanup path, shared with every other settlement — the fuse, the
    // deadline, the notes and the ring cid go together.
    this.settleRingProof(peerId);
    void this.deps.native
      .dismissPendingIncomingCall(peerId, 'cancelled', rec.ringCid)
      .catch(() => undefined);
  }

  /** A frame from this peer is being handled: pause the obligation for the
   * duration of that handler. The deadline is untouched.
   *
   * A DELIVERY DOES NOT TOUCH THE PUSH HOLD. It used to end it
   * here — "the drain answered, and the per-frame hold carries the pause from
   * here on" — on the premise that frames from one drain arrive
   * SYNCHRONOUSLY, so the offer behind an inert frame would already hold the
   * decision before that frame's handler finished. That premise is false:
   * messaging awaits a decrypt and a `markSeen` between frames, so a drain
   * spans many turns and the offer has taken nothing when the frame ahead of
   * it ends. One trailing `call.ice` from the cancelled call, delivered ahead
   * of the redial's offer, therefore put the ceiling out and let the decision
   * fire on its original two seconds — 2.3 s before the ceiling, into a
   * placeholder that had been ringing continuously and that the offer 400 ms
   * behind it was about to adopt. A live ring ended and a tapped answer
   * discarded (`dismissPendingIncomingCall` clears `pendingAnswered`):
   * the redial defect through a different door — a defect, not an accepted
   * bound. The push hold now ends where its
   * own doc says it does — at the ceiling, or with the record when something
   * SETTLES the placeholder's fate. */
  private holdCancelObligation(peerId: string, envelope: unknown): void {
    this.cancelHolds.set(peerId, (this.cancelHolds.get(peerId) ?? 0) + 1);
    const owner = CallController.ownsPlaceholder(envelope);
    if (owner) {
      this.placeholderOwnerHolds.set(peerId, (this.placeholderOwnerHolds.get(peerId) ?? 0) + 1);
    }
    const rec = this.cancelObligations.get(peerId);
    if (!rec) return;
    // PAST THE CEILING AN ORDINARY DELIVERY NO LONGER PAUSES ANYTHING. The
    // hold is still counted above — the count's ownership is not negotiable —
    // but clearing the timer here is what let overlapping deliveries keep the
    // pause alive forever, and a countdown already running must survive them.
    //
    // A FRAME THAT OWNS THE PLACEHOLDER IS NOT ORDINARY and still pauses,
    // ceiling or no ceiling: a countdown left running here is a zero-delay
    // fire aimed at the very handler about to adopt this ring
    // (`placeholderOwnerHolds`).
    if (!owner && this.cancelPauseSpent(peerId)) return;
    if (rec.timer != null) {
      clearTimeout(rec.timer);
      rec.timer = null;
    }
  }

  /** That handler is done — normally or by throwing. Released from a
   * `finally`, because the throwing case is precisely the hazard here.
   *
   * THE LAST HOLD STARTS THE COUNTDOWN — or, past the ceiling, the FIRST
   * handler to end does, with frames still in flight behind it. That second
   * arm is the aggregate's bound: without it a peer whose frames keep
   * overlapping their own handlers is never at depth zero and the decision
   * has no timer at all. Its ONE limit is stated where it is enforced, in
   * `startCancelTimer`: the frames still in flight must not include one that
   * owns the placeholder, or the bound fires into the redial. */
  private releaseCancelObligation(peerId: string, envelope: unknown): void {
    const depth = (this.cancelHolds.get(peerId) ?? 0) - 1;
    if (depth <= 0) this.cancelHolds.delete(peerId);
    else this.cancelHolds.set(peerId, depth);
    if (CallController.ownsPlaceholder(envelope)) {
      const owed = (this.placeholderOwnerHolds.get(peerId) ?? 0) - 1;
      if (owed <= 0) {
        this.placeholderOwnerHolds.delete(peerId);
        // AND THE GUESS IS RESUMED HERE TOO, after the count is
        // written and never before it — `armRingProof` reads that count, so a
        // resume above this line would refuse itself forever. The GUESS and the
        // DECISION are two timers aimed at one placeholder and both are
        // withheld while a frame that may settle it is in flight; this is where
        // both are handed back. `resumeOwedRingProof` is a no-op unless one was
        // actually withheld and nothing parked it since.
        this.resumeOwedRingProof(peerId);
      } else this.placeholderOwnerHolds.set(peerId, owed);
    }
    if (depth <= 0 || this.cancelPauseSpent(peerId)) this.startCancelTimer(peerId);
  }

  /**
   * Whether this frame, when its handler runs, MAY settle the placeholder a
   * VoIP push rang for this caller — adopt it, or dismiss it natively itself.
   *
   * MAY, not WILL, and the difference is the whole of the residual
   * `placeholderOwnerHolds` discloses. This is a pure function of the raw
   * envelope's KIND, so it answers for the frame shape and not for the path
   * the handler will actually take: a `call.ginvite` whose `handleInvite` exits
   * early (duress, a stale generation, a session already live) settles
   * nothing, and a `call.offer` naming a cid a live session owns is routed by
   * `handles()` to the coordinator's leg path, which never touches the
   * placeholder at all. Both still take the hold. It must stay this way — see
   * below on why it cannot consult live state.
   *
   * EXACTLY TWO KINDS, one per ROUTER ARM AS THE ROUTER USUALLY ROUTES THEM: the 1:1 `call.offer`, whose branch owns the placeholder on every
   * path it can take, and the group `call.ginvite`, which `handles()` routes
   * to the coordinator and which `handleInvite` owns at each of its refusals
   * and when it rings — the reason `handle()` reports a ginvite adopted
   * unconditionally. Everything else is signalling that can never claim a
   * ring: leg traffic, roster deltas, `call.gjoin` / `call.gleave`, ICE,
   * answers, ends. `call.end` is deliberately NOT in the set: it is the frame
   * that DECIDES the cancellation, and exempting the decision's own frame
   * would let a flood of them hold the decision past every bound it has (the
   * test is `an unending drain of call.end frames`).
   *
   * Read off the raw envelope, in BOTH the shapes messaging delivers (a JSON
   * string on the wire path, a plain object on the rehydrate and test paths),
   * because it must give the same answer at delivery and at release for the
   * same value — see `placeholderOwnerHolds` for why it is recomputed rather
   * than remembered.
   *
   * AND THAT IS WHY IT MAY NOT ASK THE ROUTER. Narrowing the offer arm with
   * `handles()` would be more accurate at delivery and WRONG at release: a
   * session that ended inside the handler flips the answer between the two
   * reads, and the hold taken is then never given back — a count stuck above
   * zero is a decision with no countdown at all, for the rest of the process.
   * A hold that is slightly too broad is bounded by the handler that took it;
   * a hold that leaks is not bounded by anything.
   */
  private static ownsPlaceholder(envelope: unknown): boolean {
    let tcm: unknown = null;
    if (typeof envelope === 'string') tcm = /^\{"tcm":"([^"]+)"/.exec(envelope)?.[1] ?? null;
    else if (envelope && typeof envelope === 'object' && 'tcm' in envelope) {
      tcm = (envelope as { tcm: unknown }).tcm;
    }
    return tcm === 'call.offer' || tcm === 'call.ginvite';
  }

  /** Whether this peer's decided cancellation has exhausted its absolute
   * pause: TRUE once frame holds may no longer stop its countdown.
   *
   * ONE READING OF ONE ABSOLUTE INSTANT, deliberately: a spent pause cannot
   * come back, because `holdCeiling` is fixed when the decision is made and
   * nothing re-dates it. Anything else would be the renewable lease this file
   * has closed three times. */
  private cancelPauseSpent(peerId: string): boolean {
    const rec = this.cancelObligations.get(peerId);
    return rec != null && this.deps.now() >= rec.holdCeiling;
  }

  /** The placeholder's fate was settled by the act that settles it — an offer
   * adopting, or a branch dismissing natively. The obligation is DISCHARGED,
   * never merely paused: nothing is left aimed at a live call. */
  private dischargeCancelObligation(peerId: string): void {
    const rec = this.cancelObligations.get(peerId);
    if (!rec) return;
    if (rec.timer != null) clearTimeout(rec.timer);
    if (rec.pushHold != null) clearTimeout(rec.pushHold);
    this.cancelObligations.delete(peerId);
    // `cancelHolds` IS DELIBERATELY NOT TOUCHED. It is not this
    // record's state: it is a COUNT of this peer's frames IN FLIGHT, owned by
    // the delivery/`finally` pair (`holdCancelObligation` /
    // `releaseCancelObligation`) and written by nothing else. Deleting the
    // entry here discarded the shares of every frame already delivered and not
    // yet run — a whole drain's worth, since the offer's own handler holds the
    // queue open for up to eight seconds while the rest of it lands — so the
    // NEXT `call.end` armed at depth ZERO and started its timer UNPAUSED, and
    // that timer fired inside the handler of a frame one await from adopting
    // the placeholder: a live ring ended and a tapped answer discarded
    // (`dismissPendingIncomingCall` clears `pendingAnswered`). Denial of ring,
    // reached through the very hold that exists to prevent it.
    //
    // AND THE OTHER DIRECTION IS SAFE: leaving the count alone cannot strand
    // it. Every increment is taken at delivery and given back in
    // `onEnvelope`'s `finally` — the throwing case included — so the count
    // returns to zero on its own, and the last release starts the countdown
    // (`releaseCancelObligation`). A discharge is not a licence to forget how
    // many handlers are running; nothing here knows which frame, if any, the
    // caller is.
  }

  /**
   * The cid of the placeholder native says is ringing for this peer, `''` if
   * none is known.
   *
   * PUBLIC for the reason `takePushDecline` and `mayRing` are: a VoIP push
   * carries a PEER, so the placeholder is 1:1-shaped even when the call
   * behind it is a session, and the group coordinator's own refusals dismiss
   * that same placeholder. One place the fact is kept.
   */
  ringCidFor(peerId: string): string {
    return this.ringCids.get(peerId) ?? '';
  }

  /**
   * The GROUP arm's entry to the decided-cancellation path the 1:1 `call.end`
   * branch uses.
   *
   * A `call.gleave` no live session claimed, from a peer whose placeholder is
   * ringing, is the group shape of "they hung up" — the same ambiguity the
   * 1:1 branch faces and the same answer. Routed through the router's
   * `adopted === false` alone it became a 'not_call' guess, so CallKit filed
   * a cancelled group ring as .unanswered: the missed-call row accused the
   * person of ignoring a caller who had rung off.
   */
  noteRingCancelled(peerId: string): void {
    this.armCancelObligation(peerId);
  }

  /**
   * Ring proof: a frame from `peerId` resolved as something that can never ring.
   * Arms the ring-proof fuse — see `ringProofFuses` for the full argument.
   * The single arming point: messaging's verdicts land here through the
   * subscription, and the queue's own inert outcomes (an unadopted group
   * frame, a refused parse, an unmatched control frame) call it directly
   * rather than dismissing on the spot, so there is exactly one timing
   * mechanism deciding a placeholder's fate and one grace it must survive.
   *
   * PUBLIC for the same reason `notePushRing` is: the wiring may drive it
   * directly, and the tests do. Gated on a noted push ring so ordinary
   * foreground chatter never crosses the bridge; the native dismiss guard
   * (`pendingPush` must still name this peer) is the authority either way,
   * which is what makes a stale JS-side note harmless.
   */
  onFrameVerdict(peerId: string, verdict: FrameVerdict): void {
    // A distinguishable reason per proof: 'invalid' — the ciphertext never
    // decrypted; 'not_call' — it decrypted to something that is not a call.
    // Both map to .unanswered natively; the split is for the log line and the
    // tests. There is no third reason here any more: a cancellation is a
    // DECISION and never a verdict, so it does not ride this fuse at all —
    // see `cancelObligations`.
    this.armRingProof(peerId, verdict === 'undecryptable' ? 'invalid' : 'not_call');
  }

  /** Ring proof: arm (or re-arm) the ring-proof fuse for `peerId`, recording WHY it
   * will end the placeholder. The single implementation behind both entry
   * points — messaging's verdicts via `onFrameVerdict`, and the `call.end`
   * branch, whose dismissal is deferred onto this same grace. */
  private armRingProof(peerId: string, reason: 'not_call' | 'invalid'): void {
    if (!peerId) return;
    // A GUESS NEVER OUTRANKS A DECISION. With an obligation standing there is
    // already exactly one timer aimed at this placeholder, carrying the reason
    // a frame actually decided. Arming here would duplicate the dismissal and
    // — worse — relabel a cancellation .unanswered if it won the race.
    if (this.cancelObligations.has(peerId)) return;
    if (!this.peerHasPushRing(peerId)) return;
    if (!this.ringProofReasons.has(peerId)) {
      this.ringProofReasons.set(peerId, reason);
    }
    if (this.ringProofFuses.has(peerId)) return;
    // THE INVARIANT: the grace period is absolute. The FIRST arming for
    // this ring fixes the deadline; every later arming resumes at whatever
    // is left of it, floor zero. A frame's arrival may park the countdown
    // (so the offer queued right behind an inert frame still gets its
    // handler before the burn — the queued-offer guarantee), but nothing that merely arrives
    // moves the deadline. Only a real 1:1 offer taking the ring — never a
    // group-adopted frame, which parks — retires it mid-drain, via
    // `retireRingProof`. So a stream of inert control frames buys an
    // attacker parking, never time.
    const now = this.deps.now();
    let deadline = this.ringProofDeadlines.get(peerId);
    if (deadline === undefined) {
      deadline = now + CallController.RING_PROOF_GRACE_MS;
      this.ringProofDeadlines.set(peerId, deadline);
    }
    // CAPTURED AT ARM TIME, not read inside the timer. Two reasons, and both
    // are silent reverts if this moves: the burn-down below spends the notes
    // (`forgetPushRingsFor`) BEFORE it dismisses, so a read there comes back
    // '' and every dismissal degrades to the caller-keyed match; and a fuse
    // that somehow survived into a NEW placeholder would then name the new one
    // instead of no-opping against the old. A re-arm after a park re-captures
    // the same value, because anything that could change it retired the fuse.
    // THE GUESS'S OWN DOOR. Recorded ABOVE this line and
    // withheld below it: the reason and the absolute deadline stand (so nothing
    // is dropped and no later arming can mint a fresh grace), and only the
    // timer waits. A frame that MAY settle this placeholder is being handled
    // right now, and this fuse's burn-down ends that placeholder with the same
    // native call the decision's countdown makes — `pendingAnswered` cleared,
    // parked rebind abandoned. `releaseCancelObligation` resumes it when the
    // last such hold goes; `ringProofOwed` carries the whole argument,
    // including why a park in between cancels it.
    if (this.placeholderOwnerInFlight(peerId)) {
      this.ringProofOwed.add(peerId);
      return;
    }
    const ringCid = this.ringCids.get(peerId) ?? '';
    const timer = setTimeout(() => {
      this.ringProofFuses.delete(peerId);
      this.ringProofDeadlines.delete(peerId);
      const why = this.ringProofReasons.get(peerId) ?? 'not_call';
      this.ringProofReasons.delete(peerId);
      // The noted rings this fuse resolved are spent: the placeholder is
      // being ended, so no decline against it can ever need them — and a
      // stale entry must not keep re-arming fuses for ordinary traffic.
      this.forgetPushRingsFor(peerId);
      // No-op unless `pendingPush` still names this peer AND this exact
      // placeholder (CallKitCenter.dismissPendingIncomingCall's guard).
      void this.deps.native
        .dismissPendingIncomingCall(peerId, why, ringCid)
        .catch(() => undefined);
    }, Math.max(0, deadline - now));
    this.ringProofFuses.set(peerId, timer);
  }

  /**
   * The last frame that owned this placeholder has let go — light
   * the fuse it was holding back, if one is owed and nothing has parked it since.
   *
   * ON THE ORIGINAL DEADLINE, never a fresh one. `armRingProof` mints only when
   * `ringProofDeadlines` has no entry, and an owed fuse always has one: the
   * deferral records the deadline BEFORE it refuses, and every path that deletes
   * a deadline parks first (`retireRingProof`) or clears this set with the fuses
   * (`stop()`). So a resume is arithmetic on an absolute instant — usually
   * already past, hence a zero-delay macrotask — and an owner flood buys the
   * ring parking, never time.
   */
  private resumeOwedRingProof(peerId: string): void {
    if (!this.ringProofOwed.delete(peerId)) return;
    this.armRingProof(peerId, this.ringProofReasons.get(peerId) ?? 'not_call');
  }

  /** Ring proof: call signalling from this peer arrived — PARK the fuse so the frame
   * gets its handler before any burn. Parking stops the countdown only; the
   * absolute deadline in `ringProofDeadlines` stands, so an inert frame that
   * parked the fuse re-arms it with the time that was left, not a fresh
   * grace. Arrival is never proof the ring is live — only a real 1:1
   * offer's adoption is, and that retires the fuse through
   * `retireRingProof`; a group-adopted frame parks exactly as arrival
   * does, deadline intact. */
  private parkRingProof(peerId: string): void {
    const timer = this.ringProofFuses.get(peerId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.ringProofFuses.delete(peerId);
    }
    // A FUSE WITHHELD IS PARKED BY THE SAME ACTS THAT PARK A LIT ONE.
    // Without this the deferral would be a fuse that survives arrival,
    // adoption and the decision itself — strictly more burning than the file has
    // ever done, and reachable at the worst instant there is (see
    // `ringProofOwed`). The deadline is untouched here, as always, so the guess
    // is deferred by the park rather than destroyed by it.
    this.ringProofOwed.delete(peerId);
  }

  /** Ring proof: the placeholder's fate is settled — a real offer or invite adopted
   * it, or the branch that owns it dismissed it natively itself. The fuse's
   * job is over, deadline and all. The deadline MUST go here and not linger:
   * left behind expired, it would make the first inert frame of this peer's
   * NEXT ring burn instantly, which is the queued-offer regression
   * all over again. */
  private retireRingProof(peerId: string): void {
    // IT MUST NOT TOUCH `cancelObligations`. This is called by `notePushRing`
    // and by the offer branch's top, neither of which has settled anything: a
    // decision retired here would be a decision dropped, or — worse, and what
    // shipped — carried onto the next ring's clock and burned against a ring
    // it never decided. Only `dischargeCancelObligation` may remove one, and
    // only from a branch that actually settled the placeholder.
    this.parkRingProof(peerId);
    this.ringProofDeadlines.delete(peerId);
    // The reason travels with the deadline, never with the timer: a PARK must
    // keep it (the frame that parked has not settled anything, and the fuse it
    // resumes must burn with the reason it was armed with), a RETIRE must drop
    // it, or the peer's next ring inherits the previous ring's label.
    this.ringProofReasons.delete(peerId);
  }

  /** RING PROOF — THE INVARIANT: every piece of per-peer ring state — the noted
   * rings (the `peerHasPushRing` gate), the fuse, and the absolute deadline
   * — measures exactly ONE pending placeholder, and none of it may outlive
   * the ring it measured. Called at every point a placeholder's fate is
   * SETTLED: adopted by a real offer, dismissed by the branch that owned it
   * (busy/expired/silenced/refused), declined by the person, or cancelled
   * by the caller's `call.end`. The burn-down has always done exactly this
   * pairing (`forgetPushRingsFor` beside the deadline delete); settlement
   * must too, because a note left behind after adoption held
   * `peerHasPushRing` true for the rest of the process — so ordinary
   * mid-call chatter (EVERY non-call payload is a 'not_call' verdict) armed
   * a fuse whose deadline, parked by the call's own live signalling and
   * skipped by the live-match sweep, was ORPHANED: hours stale, it burned
   * the peer's NEXT legitimate ring at zero before its offer could decrypt,
   * natively discarding an answer the person had already tapped
   * (CallKitCenter clears `pendingAnswered` and abandons the parked
   * rebind). */
  private settleRingProof(peerId: string): void {
    this.retireRingProof(peerId);
    // THE OBLIGATION IS DISCHARGED BY THE ACT THAT DISCHARGES IT. Every caller
    // of this method is a branch that has just dismissed the placeholder
    // natively or adopted it, so the fate it was waiting to decide is decided;
    // left standing, its timer would fire into a LIVE call.
    this.dischargeCancelObligation(peerId);
    this.forgetPushRingsFor(peerId);
  }

  /** Ring proof: does this peer still have a VoIP placeholder noted? The membership
   * `onFrameVerdict` reads — the gate that keeps ordinary foreground call
   * traffic off the dismiss bridge. */
  private peerHasPushRing(peerId: string): boolean {
    for (const from of this.pushRings.values()) {
      if (from === peerId) return true;
    }
    return false;
  }

  /** Ring proof: the placeholder for this peer is being ended, so its noted rings are
   * spent — the exact cleanup the fuse performs when it burns down. */
  private forgetPushRingsFor(peerId: string): void {
    for (const [cid, from] of [...this.pushRings]) {
      if (from === peerId) this.pushRings.delete(cid);
    }
    // ONE LIFETIME, ONE DELETION POINT. The ring cid measures exactly the
    // placeholder these notes measure. Left behind, the peer's next dismissal
    // — an end arriving with no note at all, which is the JS-restart path —
    // would name a placeholder that is already gone, native would refuse it,
    // and the ring would stick to the 75-second watchdog.
    this.ringCids.delete(peerId);
  }

  constructor(private readonly deps: CallControllerDeps) {
    this.service = new CallService({
      native: deps.native,
      transport: {
        sendCallEnvelope: (peerId, envelope, opts) =>
          deps.messaging.sendCallEnvelope(peerId, envelope, { urgent: opts.urgent }),
      },
      writeLog: deps.writeLog,
      displayNameFor: deps.displayNameFor,
      now: deps.now,
      metrics: deps.metrics,
      onStateChange: state => {
        // The per-peer verdict belongs to ONE call. Left standing it
        // would be consulted by whatever ran next — including a small-group
        // session, which configures nothing of its own and would silently
        // inherit a 1:1 call's answer.
        if (state.name === 'idle') this.relayForThisCall = false;
        // The stored offer exists only to survive being killed WHILE RINGING.
        // Once the machine is idle the call is over one way or another, so the
        // SDP is dead weight — and it is the kind of dead weight that carries
        // a DTLS fingerprint and candidate addresses.
        //
        // Keyed off idle rather off `ending` so it outlives teardown: a
        // teardown that crashes halfway should still leave the boot sweep
        // something to find, and `pruneCallOffers` bounds it either way.
        if (state.name === 'idle' && this.ringingOfferCid) {
          const cid = this.ringingOfferCid;
          this.ringingOfferCid = null;
          void this.deps.dropOffer?.(cid).catch(() => undefined);
        }
        deps.onStateChange?.(state);
      },
    });
  }

  /** The cid whose offer is currently persisted, so it can be dropped when
   * the call ends without re-reading the table. */
  private ringingOfferCid: string | null = null;

  /**
   * The per-peer verdict for the call being set up.
   *
   * Held for the call rather than passed down because the thing it has to
   * reach is `configure`, which sets ONE `RTCConfiguration` for the peer
   * connection the reducer will build several effects later — on the inbound
   * path, up to a whole ring-timeout later, when the person taps answer. It is
   * re-decided at the start of every call and cleared at idle, so no call
   * inherits the previous one's policy.
   */
  private relayForThisCall = false;

  /**
   * The per-peer verdict for the small-group SESSION being set up.
   *
   * A SEPARATE FIELD, deliberately not folded into `relayForThisCall`. That
   * one is cleared the moment the 1:1 machine reaches `idle`, and a session
   * runs on leg services that machine knows nothing about — so a transition it
   * makes for unrelated reasons would silently downgrade a LIVE session's
   * policy, and the next connection opened under it (a re-offer, a late
   * joiner's dial) would be built direct. Two fields, two lifetimes;
   * `effectiveRelayOnly` takes whichever of them says relay.
   *
   * ONE KNOB, N ANSWERS — and this field is the answer. A session is N
   * pairwise legs to N different people, and `configure` sets ONE
   * `RTCConfiguration` for the whole module (`TacendumCallImpl.swift`:
   * `configuration` is module state, read by `makeCall` when a peer connection
   * is built). There is no per-connection seam to reach. So the session's
   * policy is the OR over its participants: if ANY of them warrants a relay,
   * every leg is relayed. Relaying a leg that did not need it costs latency
   * and relay bandwidth; NOT relaying one that did costs somebody their home
   * address to a person who has never had it, and a default may not make that
   * trade. The published sentence must be read the same way — see
   * `relayForSession`.
   *
   * MONOTONE FOR THE LIFE OF THE SESSION, never re-decided downward. A session
   * grows and shrinks: someone is added, someone leaves, a re-offer mints a
   * fresh cid. Recomputing the OR over the CURRENT roster could answer `false`
   * after the person who made it `true` has left, and the next connection built
   * would be direct — to somebody this session had already decided to protect.
   * Monotonicity is also what makes the shared knob safe against interleaving:
   * anything that calls `configure` mid-session (a credential refresh, the
   * settings toggle) recomputes `effectiveRelayOnly`, and under a ratchet that
   * can only ever carry the same answer or a stronger one.
   *
   * Cleared by `releaseSessionRelay`, and only when the session is over.
   */
  private relayForThisSession = false;

  /** What `configure` was last told about the ICE policy, so the per-call
   * re-apply is a no-op when a credential refresh has just pushed the same
   * answer. null until anything has been configured at all. */
  private appliedRelayOnly: boolean | null = null;

  /**
   * The policy to hand `configure` right now.
   *
   * The app-wide switch is a DEMAND and wins unconditionally: a person who
   * turned it on asked for a relay hop on every call, and no per-peer memory
   * may weaken that (`relayForPeer` says the same thing about `global`).
   *
   * The per-peer verdict is a DEFAULT, and it degrades to direct when there is
   * no relay to route through — `.relay` with an empty ICE server list gathers
   * no candidates at all, so honouring it there would not protect an address,
   * it would produce a call that rings and can never connect. The published
   * policy names this exact case: with no relay configured the app places a
   * direct call. The app-wide switch keeps its harder answer instead —
   * `placeCall` refuses outright rather than silently going direct.
   *
   * The SESSION verdict sits beside the 1:1 one rather than replacing it, and
   * either is enough: the two are decided on different paths with different
   * lifetimes, and only one of them can be live at a time anyway (the busy rule makes
   * this device busy to a 1:1 offer while a session runs, and busy to a
   * `ginvite` while a call runs). Taken as an OR so that neither path can be
   * weakened by the other's stale `false`.
   */
  private effectiveRelayOnly(): boolean {
    if (this.deps.relayOnly()) return true;
    return (this.relayForThisCall || this.relayForThisSession) && this.credentials !== null;
  }

  /**
   * Decide, before any credential is spent or any effect runs, whether this
   * call is relayed. Sets no policy on its own — `pushRelayPolicy` does that
   * once the credential state is known.
   *
   * A failed read RELAYS. Every other fallback in this file fails toward
   * keeping the phone working; this one fails toward not disclosing an
   * address, because a database hiccup is not a reason to hand someone's IP
   * to a stranger, and the degradation above means it can never strand a call
   * that has no relay available anyway.
   */
  private async decideRelayFor(peerId: string): Promise<void> {
    if (!this.deps.relayForPeer) return;
    this.relayForThisCall = await this.deps.relayForPeer(peerId).catch(() => true);
  }

  /**
   * Push the decided policy to the native module.
   *
   * Needed because `configure` is otherwise only reached by a credential
   * REFRESH, and a cached credential is good for hours: without this, the
   * first call of the day would set the policy and every call after it would
   * inherit that one's answer. Skipped when nothing changed, so a call that
   * refreshed its credential a moment ago does not configure twice, and
   * skipped entirely when the per-peer seam is absent so the pre-wiring effect
   * trace is unchanged.
   */
  private async pushRelayPolicy(): Promise<void> {
    if (!this.deps.relayForPeer) return;
    const relayOnly = this.effectiveRelayOnly();
    if (this.appliedRelayOnly === relayOnly) return;
    this.appliedRelayOnly = relayOnly;
    await this.deps.native
      .configure(this.credentials?.servers ?? [], relayOnly)
      .catch(() => undefined);
  }

  get state(): CallState {
    return this.service.current;
  }

  /** Resolves once every envelope delivered so far has been handled. Exists
   * for tests and for teardown, which must not race in-flight handling. */
  whenIdle(): Promise<void> {
    return this.queue;
  }

  /** Subscribe to envelopes and register for VoIP wakes. Idempotent. */
  async start(): Promise<void> {
    if (!this.unsubscribe) {
      this.unsubscribe = this.deps.messaging.onEnvelope((peerId, envelope, meta) => {
        // Ring proof: everything delivered here is call signalling — messaging's
        // emitEnvelope fires only from its two call branches — so arrival
        // PARKS this peer's ring-proof fuse. Done HERE, synchronously at
        // delivery, not only inside the queued handler: the queue can be
        // held up whole seconds by a credential fetch, and a fuse must
        // never outrun the offer that already arrived to claim the ring.
        // Parking only — arrival is not adoption, and the absolute
        // deadline stands, so an inert frame that parked the fuse re-arms
        // it with the time that was left. The handler parks AGAIN when
        // this frame's turn comes (onEnvelope), for the fuses this park
        // cannot see: the ones a frame AHEAD of this one arms later, from
        // inside the queue.
        this.parkRingProof(peerId);
        // …and HOLD the decided cancellation for as long as this frame's own
        // handling takes. Held rather than parked: the deadline stands, the
        // record is untouchable, and the `finally` in `onEnvelope` releases it
        // however that handling ends. A fire landing inside the offer branch's
        // credential fetch would end the placeholder the offer is one await
        // from adopting.
        this.holdCancelObligation(peerId, envelope);
        // Advisory by contract: a throwing listener must never break message
        // delivery, persistence, or the ack for anyone else.
        this.queue = this.queue
          .then(() => this.onEnvelope(peerId, envelope, meta.ts, meta.msgId))
          .catch((err: unknown) => {
            // Name only — never the message, and never the peer id. See the
            // same reasoning in service.ts.
            console.warn(
              `[call] envelope handling failed: ${err instanceof Error ? err.name : 'unknown'}`,
            );
          });
      });
    }
    // Ring proof: NOT routed through the serialized envelope queue, deliberately —
    // a verdict only arms or ignores a timer, orders against nothing, and
    // the queue's whole point is to serialize reducer dispatches, which this
    // never makes.
    if (!this.unsubscribeVerdicts && this.deps.messaging.onFrameVerdict) {
      this.unsubscribeVerdicts = this.deps.messaging.onFrameVerdict(
        (peerId, verdict) => this.onFrameVerdict(peerId, verdict),
      );
    }
    // Registration is what produces the token the server needs to wake this
    // device; without it a call to a backgrounded phone never rings.
    await this.deps.native.registerForVoipPush().catch(() => undefined);
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.unsubscribeVerdicts?.();
    this.unsubscribeVerdicts = null;
    // A DECIDED CANCELLATION IS AN OBLIGATION, NOT A TIMER. Teardown FIRES
    // it rather than dropping it — dropping it left the placeholder dismissed
    // by nothing, ringing to the 75-second watchdog after the caller had hung
    // up. Ordered BEFORE the clears below, and before `service.dispose()`, so
    // the dismissal is issued while the bridge is still the one this
    // controller was using.
    //
    // "FIRING IS SAFE BECAUSE IT NAMES THE RING IT DECIDED: A PLACEHOLDER
    // REPLACED SINCE IS A STRICT NO-OP NATIVELY" — THAT SENTENCE WAS FALSE,
    // and it stood here for three rounds. On the cancel-then-redial this whole
    // path exists for, the placeholder is NOT replaced: `alreadyRinging`
    // deliberately keeps `pendingPush` on the first ring, so the cid matches
    // and the dismissal lands on a ring that has been up continuously. The
    // limit is stated once, at `fireCancelObligation`, because that is the
    // only place both this flush and the countdown pass through.
    for (const peerId of [...this.cancelObligations.keys()]) this.fireCancelObligation(peerId);
    // AND THE RECORDS ARE NOT CLEARED. `fireCancelObligation` removes each one
    // it actually fires; what survives is exactly the set it DEFERRED to a
    // frame that owns the placeholder, and clearing them here would turn that
    // deferral into a drop — the stuck ring, which is the same defect as the
    // fire, pointing the other way. Teardown unsubscribes but does not stop
    // the handlers already on the queue: each still runs, still settles its
    // own placeholder or gives its hold back, and the release then fires what
    // is owed. The counts below are left alone for the same reason;
    // `cancelHolds` states the ownership rule.
    // THE COUNTS ARE NOT CLEARED HERE, and that is the
    // ownership rule `cancelHolds` states rather than an exception to it.
    // `stop()` unsubscribes, so no NEW frame is delivered — but the handlers
    // already on the queue keep running, and each one still gives its hold
    // back through `onEnvelope`'s `finally`. Clearing here was the third
    // writer the declaration forbids, and it produced a FALSE ZERO: a queued
    // `call.end` arming after teardown read depth zero, started its countdown
    // UNPAUSED with a redial's offer sitting in the queue right behind it, and
    // fired into that offer's credential fetch — this file's oldest defect,
    // reached through teardown. Left alone, the counts drain themselves.
    for (const timer of this.ringProofFuses.values()) clearTimeout(timer);
    this.ringProofFuses.clear();
    // WITH THE FUSES, NOT WITH THE OBLIGATIONS. An owed fuse is
    // a GUESS, and teardown has always dropped guesses and fired decisions —
    // the deadline it would resume against is cleared on the next line, so a
    // handler still running past `stop()` must not re-light one against a ring
    // this controller no longer measures.
    this.ringProofOwed.clear();
    this.ringProofDeadlines.clear();
    this.ringProofReasons.clear();
    this.ringCids.clear();
    this.endedCids.clear();
    this.service.dispose();
  }

  // --- inbound ------------------------------------------------------------

  /**
   * A decrypted envelope from `messaging`.
   *
   * `messaging` hands every envelope to every listener, so the first job is to
   * ignore the ones that are not calls — and to do it without throwing, since
   * a listener that throws must never break delivery for anyone else.
   */
  private async onEnvelope(
    peerId: string,
    envelope: unknown,
    serverTs: number,
    msgId = '',
  ): Promise<void> {
    try {
      await this.handleEnvelope(peerId, envelope, serverTs, msgId);
    } catch (err) {
      // THE RELEASE-ON-THROW ARM. A throw in `router.handle` — or anywhere below —
      // unwinds past BOTH parks (the delivery-time one in `start()` and the
      // one at the top of the handler), and without this the speculative fuse
      // stays parked forever: a garbage ring surviving to the 75-second
      // watchdog, which is a stuck ring and just as much a defect as a
      // suppressed one. Resumed on the ORIGINAL deadline, so a peer whose
      // frames throw buys parking, never time.
      //
      // A `catch`+rethrow rather than the `finally` below, deliberately: a
      // NORMAL exit whose outcome was adoption must not re-arm anything.
      if (this.ringProofDeadlines.has(peerId)) {
        this.armRingProof(peerId, this.ringProofReasons.get(peerId) ?? 'not_call');
      }
      throw err;
    } finally {
      // Release-on-throw: the hold taken at delivery is released however this handler ends.
      // A `finally`, because the throwing case is exactly the one that lost
      // the obligation.
      this.releaseCancelObligation(peerId, envelope);
    }
  }

  /** The body `onEnvelope` guards. Split out so the guard can wrap it without
   * re-indenting every branch — the two are one unit. */
  private async handleEnvelope(
    peerId: string,
    envelope: unknown,
    serverTs: number,
    msgId = '',
  ): Promise<void> {
    // Ring proof: the second park point, and it cannot be folded into the one in
    // `start()`. That one fires at DELIVERY and cannot see the future: a
    // frame already delivered behind this one had its park then, and a
    // fuse armed afterwards — by an EARLIER frame's inert outcome below —
    // postdates it. Handlers run in delivery order, so parking every such
    // fuse when this frame's handling BEGINS keeps the invariant start()
    // states (a fuse must never outrun call signalling that already
    // arrived) true even when this frame's own handling stalls whole
    // seconds in a credential fetch. A park, not a retire: the absolute
    // deadline stands until this frame's outcome below decides the
    // placeholder's fate, exactly once it is known.
    this.parkRingProof(peerId);
    // The small-group seam, checked FIRST and inside this queue.
    // Absent or uninterested ⇒ the 1:1 path below, unchanged.
    const router = this.deps.groupRouter;
    if (router?.handles(peerId, envelope)) {
      const adopted = await router.handle(peerId, envelope, { msgId, ts: serverTs });
      // The fuse's GROUP arm (the 1:1 arm's fix, mirrored). A
      // valid urgent call.gjoin/gleave parked the fuse the moment it was
      // delivered, was claimed here, reduced to NOTHING from idle — and this
      // return used to run before the 1:1 arm's cleanup below ever could, so
      // the reported placeholder rang to the native 75-second watchdog. The
      // router now says whether a live/ringing session adopted the frame; a
      // ginvite reports adopted unconditionally because its branch owns its
      // own placeholder on every path, exactly as the offer branch below
      // does. An unadopted frame ARMS THE FUSE rather than dismissing here: a stale delta from a session long over
      // drains one frame ahead of the invite whose push is ringing, and an
      // immediate dismissal ended the placeholder that invite was about to
      // adopt — natively abandoning a parked rebind and any answer already
      // made against it. The fuse loses to the very next frame's arrival —
      // but only its countdown: the deadline is absolute, and a re-arm
      // resumes it. With nothing behind it, it burns and dismisses.
      // Report-first is untouched: the report fired natively on the push,
      // and the burn-down dismiss is the same peer-guarded native no-op the
      // verdict path uses once a real call has adopted the ring.
      if (adopted) {
        // Group adoption PARKS while a 1:1
        // push note still stands — it must not RETIRE. `adopted` is true
        // for EVERY ginvite and for any gjoin/gleave a live session claims,
        // so this branch is reachable at will by a peer who merely holds a
        // session open — and retiring here deleted the absolute deadline
        // while the surviving note kept `peerHasPushRing` true, handing
        // the next inert frame a FRESH two seconds: alternating adopted
        // group frames with inert ones faster than the grace kept a
        // garbage placeholder ringing to the 75-second watchdog with
        // frames alone, the exact renewable lease the absolute-grace fix closed. Parking
        // clears the fuse (a ginvite one frame behind a stale delta still
        // wins the door) but the deadline stands, so a
        // later inert frame resumes the remainder. The NOTE survives
        // deliberately: spending it here would gate off the fuse of a
        // garbage 1:1 placeholder coexisting with a live session — the
        // watchdog regression the absolute-grace fix was built against. Once the ring's
        // fate truly settles (a real offer adopts, a fresh push re-rings,
        // the burn-down fires), note and deadline go together.
        //
        // THE INVARIANT — every path that deletes a 1:1 grace deadline
        // (which is what lets a later frame mint a fresh one), and why no
        // inert frame reaches any of them:
        //   1. `notePushRing` — a DELIVERED VoIP push, which already
        //      re-rang the phone natively: a new ring gets a new clock.
        //   2. The `call.offer` branch top — a schema-valid offer, the
        //      frame the grace exists to hold the door for.
        //   3. `settleRingProof`'s callers — busy, expired, tombstoned,
        //      silenced, refused, adopted, `call.end`, the person's own
        //      decline: each a settled fate, none of them inert.
        //   4. The burn-down — the grace ELAPSING, which spends the notes
        //      too, so no further grace can be minted without a new push.
        //   5. `stop()` — teardown.
        //   6. HERE — only when NO note stands, i.e. when no inert frame
        //      could mint against the deleted deadline anyway
        //      (`onFrameVerdict`'s gate), so the retire is pure cleanup of
        //      a deadline nothing owns (a note evicted at the cap).
        // An inert frame reaches only `onFrameVerdict` — mint-if-absent,
        // else resume the remainder, floor zero — and the parks. It can
        // never reset or extend a grace.
        if (this.peerHasPushRing(peerId)) this.parkRingProof(peerId);
        else this.retireRingProof(peerId);
      } else {
        this.onFrameVerdict(peerId, 'not_call');
      }
      return;
    }

    const call = this.asCallEnvelope(envelope);
    if (!call) {
      // The fuse's third arm (same class): messaging classified this
      // frame as call traffic — its delivery parked any armed fuse, and no
      // 'not_call' verdict will ever fire for it — but the strict schema
      // here refuses it. Between the two parsers nobody owned the ring, so
      // this outcome arms the fuse; immediate dismissal condemned the offer
      // one frame behind it (as above).
      this.onFrameVerdict(peerId, 'not_call');
      return;
    }

    switch (call.tcm) {
      case 'call.offer': {
        // Ring proof: a REAL offer — the frame the fuse was holding the door for.
        // Retire the fuse AND its absolute deadline now, BEFORE the long
        // awaits below (saveOffer, credentials — up to 8 s), so a verdict
        // landing mid-branch arms a fresh grace instead of resuming a
        // deadline that belongs to a drain this offer already won; an
        // expired deadline left standing would instant-burn this peer's
        // next ring (the queued-offer regression). The noted rings are NOT spent yet: until the
        // rebind, a decline of the placeholder still arrives under the
        // SYNTHETIC cid and is matched through `pushRings` (`onCallKitEnd`).
        // This branch owns the placeholder on every path — each one adopts
        // it, or dismisses it natively and returns — and each path spends
        // the notes at the moment it settles that fate (`settleRingProof`).
        // …and it does NOT discharge a decided cancellation. The obligation is
        // HELD for this branch's duration by the delivery-time hold and
        // released in the guard's `finally`, so if any of the awaits below
        // throws it still fires; it is discharged only by this branch's own
        // dismissal or its adoption, both of which go through
        // `settleRingProof`. Taking it away at the top — the symmetric-looking
        // move — re-opens the release-on-throw defect on a new door: `mayRing`, `writeLog` and
        // `dispatch` can all throw before the first dismissal, and the
        // obligation would be gone with nothing left to fire it.
        this.retireRingProof(peerId);
        // AN OFFER THE PEER ALREADY CANCELLED. The live `call.end` for this
        // cid beat the queued offer out of the server (see `END_TOMBSTONE_MS`):
        // it settled the placeholder's fate and the call is over. Ringing it
        // now would ring a phone for a call nobody is placing, and writing a
        // row would file a second event for one call. Dropped whole,
        // whatever the push-ring state — the `call.end` branch already owns
        // the placeholder, and the dismissal here is the belt on that.
        if (this.isEndTombstoned(call.cid)) {
          await this.deps.native
            .dismissPendingIncomingCall(peerId, 'cancelled', this.ringCidFor(peerId))
            .catch(() => undefined);
          this.settleRingProof(peerId);
          return;
        }
        // EACH OF THE FIVE DISMISSALS BELOW NAMES THE PLACEHOLDER IT IS
        // ENDING (`ringCidFor`), read at the moment of the dismissal and
        // always BEFORE that path's `settleRingProof`. This is where the cid
        // tag earns its keep on the 1:1 arm: every one of them sits behind
        // awaits — `mayRing`, `saveOffer`, `ensureCredentials`, up to eight
        // seconds — during which a push can mint a different placeholder. THE
        // RING VERDICT (§10.6), read before the first row this branch can
        // write. Every refusal below — busy, expired, silenced — leaves a
        // missed row, and the row's poster (`index.ts`) makes a sound for one
        // that carries no verdict: keyed on `missed` alone, a stranger the
        // policy silenced could chime the phone through the busy row or a
        // self-expired offer. The ORDER of the refusals is
        // unchanged — busy is still answered before the policy is acted on —
        // only the read moved up, so each row can say whether its caller
        // could have rung.
        const permission = await this.mayRing(peerId);
        // The busy-rule half that protects a live session from a stray 1:1 offer.
        // Answered here rather than by the reducer because the reducer models
        // one call and knows nothing about the session that owns the
        // microphone — its `reportBusy` path would never fire, and the caller
        // would ring out the full 45 seconds against a device that is
        // already in a call.
        if (router?.liveSessionBusy()) {
          await this.deps.native
            .dismissPendingIncomingCall(peerId, 'declined', this.ringCidFor(peerId))
            .catch(() => undefined);
          await this.deps.messaging
            .sendCallEnvelope(peerId, { tcm: 'call.end', cid: call.cid, r: 'busy' }, { urgent: true })
            .catch(() => undefined);
          // AND A ROW. The reducer's own busy refusal writes one (the
          // callee's missed call); this refusal is decided a layer up, on the
          // session's behalf, and used to leave the Calls tab silent about a
          // person who tried to reach this phone during a group call.
          await this.deps
            .writeLog({
              cid: call.cid,
              peerId,
              direction: 'in',
              kind: call.vid ? 'video' : 'audio',
              reason: 'busy',
              startedAt: serverTs,
              connectedAt: null,
              endedAt: this.deps.now(),
              missed: true,
              // A caller the policy would have silenced gets the row and
              // nothing audible.
              silenced: !permission.ring,
            })
            .catch(() => undefined);
          // Ring proof: fate settled — busy, placeholder dismissed above. The notes
          // are spent with it (`settleRingProof`'s invariant).
          this.settleRingProof(peerId);
          return;
        }
        // A stale offer must take its placeholder with it. Redelivery on a
        // late open replays the offer with its ORIGINAL server timestamp; the
        // reducer already refuses to ring it, but its expired branch only
        // writes the log row — and if the caller's cancel never reached the
        // queue (killed mid-hangup), the VoIP placeholder would ring on with
        // nothing left to end it.
        if (!offerIsRingable(call, serverTs, this.deps.now())) {
          await this.deps.native
            .dismissPendingIncomingCall(peerId, 'expired', this.ringCidFor(peerId))
            .catch(() => undefined);
          if (!permission.ring) {
            // A silenced caller's stale offer never reaches the reducer.
            // `exp` is the caller's own field, so a stranger can post an
            // offer that is already expired and reach the reducer's missed
            // row — and its notice — without ever meeting the ring gate.
            // The row is written here instead, carrying the verdict,
            // exactly as the silenced branch below writes its own; the
            // reducer's expired branch does nothing else.
            await this.deps.writeLog({
              cid: call.cid,
              peerId,
              direction: 'in',
              kind: call.vid ? 'video' : 'audio',
              reason: 'expired',
              startedAt: serverTs,
              connectedAt: null,
              endedAt: this.deps.now(),
              missed: true,
              silenced: true,
            });
          } else {
            // Still dispatched: the reducer's expired branch is what writes the
            // missed-call row, and the person deserves to see the call existed.
            await this.service.dispatch({
              type: 'offerReceived',
              cid: call.cid,
              peerId,
              sdp: call.sdp,
              video: call.vid,
              exp: call.exp,
              serverTs,
            });
          }
          // Ring proof: fate settled — expired, placeholder dismissed above. The
          // notes are spent with it (`settleRingProof`'s invariant).
          this.settleRingProof(peerId);
          return;
        }
        // A decline the person already made, against the placeholder, before
        // this offer could decrypt. Honour it: tell the caller (the frame
        // that was impossible to send from the synthetic cid), clear any
        // pending ring, log the decline — and do NOT ring the callee again
        // for a call they answered with 'no' seconds ago.
        if (this.takePushDecline(peerId)) {
          await this.deps.native
            .dismissPendingIncomingCall(peerId, 'declined', this.ringCidFor(peerId))
            .catch(() => undefined);
          try {
            await this.deps.messaging.sendCallEnvelope(
              peerId,
              { tcm: 'call.end', cid: call.cid, r: 'decline' },
              { urgent: true },
            );
          } catch {
            // The caller still times out on their own ring timer; the
            // decline is best-effort, the not-ringing-again is not.
          }
          await this.deps.writeLog({
            cid: call.cid,
            peerId,
            direction: 'in',
            kind: call.vid ? 'video' : 'audio',
            reason: 'decline',
            startedAt: serverTs,
            connectedAt: null,
            endedAt: this.deps.now(),
            missed: true,
          });
          // Ring proof: fate settled — declined before decrypt, placeholder
          // dismissed above. The notes are spent with it (`settleRingProof`).
          this.settleRingProof(peerId);
          return;
        }
        // Silence unknown callers, decided BEFORE anything rings and
        // before any credential is spent — the verdict was read above, ahead
        // of the busy and expired refusals, so their rows carry it too. A
        // silenced call still leaves a missed-call row — the person can see
        // it happened and call back — but the phone never makes a sound, and
        // the caller learns nothing about whether it was silenced or simply
        // unanswered.
        if (!permission.ring) {
          // The VoIP push has ALREADY rung a placeholder by the time this
          // decision runs — the push arrives before anything can decrypt, so
          // silencing here without dismissing there means the unknown caller
          // rang the phone anyway and the full-screen ring just sits. No-op
          // when nothing is pending (the ordinary foreground case).
          await this.deps.native
            .dismissPendingIncomingCall(peerId, 'declined', this.ringCidFor(peerId))
            .catch(() => undefined);
          await this.deps.writeLog({
            cid: call.cid,
            peerId,
            direction: 'in',
            kind: call.vid ? 'video' : 'audio',
            // `decline` rather than `blocked`: the device declined this on
            // the person's behalf under a policy they set, which is a
            // different fact from a peer they explicitly blocked, and the
            // row a person reads should not accuse them of blocking someone
            // they never did.
            reason: 'decline',
            startedAt: serverTs,
            connectedAt: null,
            endedAt: this.deps.now(),
            missed: true,
            // "Never makes a sound" includes the missed-call notice:
            // the row is the evidence, not a chime.
            silenced: true,
          });
          // Ring proof: fate settled — silenced, placeholder dismissed above. The
          // notes are spent with it (`settleRingProof`'s invariant).
          this.settleRingProof(peerId);
          return;
        }

        // Credentials BEFORE the reducer sees the offer: accepting a call with
        // no relay configured produces a peer connection that can only ever
        // find a direct path, which is exactly the ~20% of calls that need a
        // relay most.
        // BEFORE the reducer, because the reducer's first act is to make the
        // phone ring, and a ring the app cannot substantiate after being
        // killed is the situation the design forbids. Writing it first means the
        // durable copy always exists at least as early as the system UI does.
        //
        // Failure is swallowed: no stored offer degrades a lock-screen answer
        // after a kill, which is strictly better than refusing the call.
        // `ringingOfferCid` is NOT retargeted here: the reducer may refuse
        // this offer (busy), and pointing the idle sweep at the refused cid
        // left the LIVE call's row — a DTLS fingerprint and candidate
        // addresses — in `call_offers` until the next launch. The row is
        // adopted below, or dropped inline on refusal.
        if (this.deps.saveOffer) {
          await this.deps
            .saveOffer({
              cid: call.cid,
              peerId,
              sdp: call.sdp,
              video: call.vid,
              exp: call.exp,
              serverTs,
            })
            .catch(() => undefined);
        }

        // THE ANSWERING HALF. Answering gathers candidates exactly as
        // placing does, and a `.all` answer offers this phone's host address
        // to whoever called — so a rule enforced only on the outbound side
        // protects the caller from the callee and nobody from anybody else.
        // Decided here, before the ring, because `createAnswer` runs whenever
        // the person taps and the policy has to already be in place.
        await this.decideRelayFor(peerId);
        await this.ensureCredentials(MAX_CALL_BOUND_MS);
        await this.pushRelayPolicy();
        await this.service.dispatch({
          type: 'offerReceived',
          cid: call.cid,
          peerId,
          sdp: call.sdp,
          video: call.vid,
          exp: call.exp,
          serverTs,
        });
        // THE REDUCER MAY HAVE REFUSED — busy with another call, or the
        // offer crossed its expiry during the awaits above. Every refusal
        // sends the caller the right frame, but none of them knew a VoIP
        // placeholder might still be ringing for this peer: two callers in
        // quick succession left the loser's placeholder ringing until the
        // watchdog. If this offer did not become the live call, its
        // pending ring has no future.
        const adopted = this.service.current.call;
        if (adopted?.cid !== call.cid) {
          // The refused offer's row goes NOW, keyed by its own cid, so the
          // live call's row keeps its owner and is dropped at idle as before.
          if (this.deps.saveOffer) {
            void this.deps.dropOffer?.(call.cid).catch(() => undefined);
          }
          // …unless the machine's live call is from THIS peer. The external
          // review's interleaving: adopted call A is declined during the
          // awaits above, the same peer redials, offer B is adopted by a
          // concurrent handler — and A's continuation, resuming here, would
          // dismiss B's perfectly valid ring. A placeholder is dismissed
          // only when this peer has no live call to own it.
          //
          // A same-peer call in TEARDOWN does not shield: with the tail
          // collapse ownership-scoped (service.ts), this guard CAN now
          // observe 'ending' — and a call being torn down has no claim on a
          // placeholder, which by then belongs to the refused offer and must
          // go, or it rings until the watchdog for a caller who already
          // heard busy.
          if (adopted?.peerId !== peerId || this.service.current.name === 'ending') {
            await this.deps.native
              .dismissPendingIncomingCall(peerId, 'declined', this.ringCidFor(peerId))
              .catch(() => undefined);
          }
          // A decline recorded WHILE this offer was processing applied to
          // THIS call — the placeholder the person declined was this offer's.
          // Left standing, it would auto-decline the peer's NEXT offer for
          // up to sixty seconds (found by review).
          this.pushDeclines.delete(peerId);
          // Ring proof: fate settled — refused (and dismissed above, unless the same
          // peer's LIVE call owns the placeholder, whose own adoption already
          // spent these notes). Spend them either way (`settleRingProof`).
          this.settleRingProof(peerId);
          return;
        }
        // Adopted: this cid's row is the one the idle sweep drops.
        if (this.deps.saveOffer) this.ringingOfferCid = call.cid;
        // Ring proof: ADOPTION SPENDS THE NOTED RINGS — the second half of the
        // retire at the top of this branch, and the settlement half of
        // `settleRingProof`'s invariant. The rebind has cleared native
        // `pendingPush`, so post-rebind CallKit events carry the REAL cid
        // and no decline can need the synthetic note again. A note left
        // standing here held `peerHasPushRing` true for the rest of the
        // process: every later NON-call payload from this peer — any text
        // message — armed a fuse mid-call, whose deadline, parked by the
        // call's own live signalling and skipped by the live-match sweep
        // below, was ORPHANED, and hours stale it burned this peer's next
        // legitimate ring at zero before its offer could decrypt.
        this.settleRingProof(peerId);
        // The VoIP wake rang under a placeholder because the push carries no
        // name; now that it has decrypted, say who it is — but ONLY if
        // the database actually knows. `displayNameFor` falls back to a
        // shortened ULID, and the ring may already be showing the mirrored
        // name or the honest placeholder; "correcting" either to a raw id is
        // a downgrade dressed as an update.
        const ringName = await this.deps.displayNameFor(peerId);
        if (ringName !== shortId(peerId)) {
          await this.deps.native
            .updateIncomingCallDisplay(call.cid, ringName)
            .catch(() => undefined);
        }
        // The person may have declined the PLACEHOLDER during the awaits
        // above — after the early tombstone consult, before adoption. That
        // decline was for this call: honour it now, and consume it so it
        // cannot ambush the peer's next offer.
        if (this.pushDeclines.has(peerId)) {
          this.pushDeclines.delete(peerId);
          await this.service.dispatch({ type: 'localDecline' });
        }
        break;
      }

      case 'call.answer':
        await this.service.dispatch({
          type: 'answerReceived',
          cid: call.cid,
          sdp: call.sdp,
          video: call.vid,
        });
        break;

      case 'call.ice':
        await this.service.dispatch({
          type: 'iceReceived',
          cid: call.cid,
          candidates: call.c,
        });
        break;

      case 'call.ringing':
        await this.service.dispatch({ type: 'ringingReceived', cid: call.cid });
        break;

      case 'call.end': {
        // Remembered FIRST, whatever else this frame turns out to mean: an
        // offer for this cid draining behind it is already cancelled.
        this.tombstoneEnd(call.cid);
        // A cancellation can beat its own offer's ring teardown: the caller
        // hung up while this phone was dead, both frames drained together,
        // and if the offer's ring never got adopted (or the end raced it),
        // the placeholder from the VoIP push keeps ringing a call that is
        // already over. Dismissing the pending push ring is a no-op in every
        // ordinary case; `endReceived` still does the real work.
        //
        // WHICH placeholder, though. Read BEFORE the dispatch below, because
        // that dispatch clears `service.current.call` and the answer would
        // change underfoot.
        const live = this.service.current.call;
        const namesLiveCall = live?.cid === call.cid && live.peerId === peerId;
        if (!namesLiveCall && this.peerHasPushRing(peerId)) {
          // The arm the earlier sweep missed. An end naming
          // a cid this device has never run is INDISTINGUISHABLE from the
          // cancellation of the still-undecrypted offer that is ringing right
          // now: the push carries no cid, because the real one is inside the
          // ciphertext by design, so the placeholder is peer-keyed and both
          // frames name the same peer. Dismissing on the spot therefore ended
          // the placeholder of the offer draining ONE FRAME BEHIND it —
          // natively clearing `pendingAnswered` (an answer the person had
          // already tapped) and abandoning the parked rebind (a call that then
          // never re-rings), the two losses the sweep below calls worse than
          // bouncing. The ordinary trigger is a missed call then a redial to a
          // phone that was offline, with both in one drain; no attacker needed.
          //
          // So it takes the SAME two-second grace every other inert frame
          // gets, and loses to the offer or ginvite behind it. But it takes it
          // as an OBLIGATION rather than as a fuse: this is a DECISION, not a
          // guess, so nothing may repeal it (a second push), postpone it (a
          // second push, again — the redial-killing defect), park it (an
          // adopted group frame), lose it (a throwing handler) or drop it
          // (teardown). It carries 'cancelled', so CallKit still reports
          // .remoteEnded rather than relabelling this a call nobody answered.
          //
          // THE GATE, NOT A TRAP ANY MORE: `peerHasPushRing` still decides
          // whether this path is even about a placeholder — with no note there
          // is nothing here to end, and the immediate dismissal below is
          // right. What is no longer true is the old warning that spending the
          // notes would silently disarm the deferral: the obligation does not
          // depend on the notes standing after it is armed. They must still
          // stand for `onCallKitEnd` to match a decline made during the grace,
          // which is why nothing is spent here.
          this.armCancelObligation(peerId);
        } else {
          // Either this end names the call this device is actually running —
          // not ambiguous at all — or there is no noted ring for this peer, in
          // which case there is no offer-behind-it hazard this side can even
          // see and the native state is the authority (a JS restart between
          // the push and this drain loses the note but not the placeholder).
          // Both keep the immediate dismissal exactly as it was.
          //
          // Ring proof: this path settled the placeholder's fate itself, so the fuse
          // retires with it — same reasoning as the offer branch above, and
          // same stale-deadline hazard if it lingered. The notes are spent
          // with it too: the ring they measured is over, and a note left
          // standing would keep arming fuses on this peer's ordinary traffic
          // (`settleRingProof`'s invariant).
          //
          // ORDERING (O1): the ring cid is read BEFORE `settleRingProof`,
          // which clears it. Read after, it comes back '' and this silently
          // reverts to the caller-keyed match — a revert with no failing test
          // is a revert that ships.
          const ringCid = this.ringCidFor(peerId);
          this.settleRingProof(peerId);
          await this.deps.native
            .dismissPendingIncomingCall(peerId, 'cancelled', ringCid)
            .catch(() => undefined);
        }
        await this.service.dispatch({ type: 'endReceived', cid: call.cid, reason: call.r });
        break;
      }

      case 'call.media':
        await this.service.dispatch({
          type: 'mediaReceived',
          cid: call.cid,
          audio: call.a,
          video: call.v,
        });
        break;

      case 'call.restart': {
        await this.service.dispatch({ type: 'restartReceived', cid: call.cid, sdp: call.sdp });
        // ONE FRAME BEHIND THE ANSWER, on the channel that owns track state.
        //
        // The answer the dispatch just sent carries `vid: call.video` — the
        // camera state this call STARTED with (see `localMedia` in the deps
        // above for why it can never be anything else). This corrects it for
        // a peer whose build does not yet ignore a restart answer's `vid`.
        //
        // AFTER, never before: both frames go out through the same per-peer
        // `sendCallEnvelope`, messaging encrypts at compose time and the
        // outbox flushes in that same order, so an announce composed first
        // would be overwritten by the very value it exists to correct. The
        // `await` above runs the reducer's effects to completion — the send
        // included — before this line is reached.
        //
        // GUARDED TO WHAT THE REDUCER ACCEPTS. `restartReceived` answers only
        // in `connected` and `reconnecting`; everywhere else it returns
        // NOTHING, and that guard exists because an unsolicited restart must
        // not reach the callee's device before they have agreed to anything.
        // A guard on one path is not a guard: without this the announce
        // replied to a restart delivered while the phone was still RINGING
        // under the same cid — one frame back per frame sent, from a device
        // whose owner has not answered.
        //
        // The other two doors are already shut and this does not re-shut them.
        // A restart naming a DIFFERENT call is stopped by `sendMedia`'s cid
        // check, and so is a call this dispatch itself tore down — when the
        // answer cannot be produced or cannot be sent, `sendEnvelope` hangs
        // the call up and the machine is back at `idle` with no call by the
        // time this line runs. Reading the state after the dispatch rather
        // than before is therefore not what closes those; it is just the
        // honest reading, and an accepted restart returns its state unchanged
        // so the two are identical on the path that matters.
        //
        // ADDRESSED TO THE CALL'S PEER, NOT TO THIS FRAME'S SENDER. The
        // reducer cannot make that mistake — `send()` (call-machine.ts)
        // builds `{ peerId: call.peerId }` out of the context — while
        // `peerId` here is `handleEnvelope`'s argument, whoever put this
        // frame on the wire. `restartReceived` compares the cid and nothing
        // else, so a restart from a third party naming the live cid is still
        // answered TO THE PEER: a correction addressed to the sender would
        // never reach the person who just believed the stale `vid`, and would
        // hand someone who is not in the call the confirmation that the cid
        // is live, that this device is on a call, and its exact microphone
        // and camera state. The CID still comes from the envelope — that is
        // what `sendMedia`'s temporal guard compares, and substituting the
        // live call's cid would announce under a restart the reducer refused
        // for naming a different call.
        //
        // BEST-EFFORT, like the only other caller (`announceMedia`,
        // index.ts). A throw here unwinds past the ring-proof sweep at the bottom of
        // this handler — the only thing that ends a placeholder this frame
        // did not adopt — while `onEnvelope`'s catch re-arms nothing, because
        // a noted push ring carries no deadline to resume. A cosmetic
        // correction that fails to send must not be able to leave someone's
        // ring standing to the 75-second watchdog.
        //
        // READ AS THE UNION, not destructured: `CallState` pairs `call: null`
        // with `name: 'idle'` and a `CallContext` with every other name, so
        // the state check below is what proves there is a call to name a peer
        // from. Pulled apart into two consts that lose sight of each other,
        // the compiler asks for a null check that only the type system's own
        // invariant could ever fail — and a redundant guard is a guard no
        // test can hold.
        const live = this.service.current;
        const media = this.deps.localMedia?.();
        if (media && (live.name === 'connected' || live.name === 'reconnecting')) {
          await this.sendMedia(
            live.call.peerId,
            call.cid,
            !media.muted,
            media.videoEnabled,
          ).catch(() => undefined);
        }
        break;
      }
    }

    // A VALID non-offer control frame cannot keep a placeholder
    // ringing to the 75-second watchdog. call.answer/ice/ringing/media/restart
    // cannot create a call from idle — the reducer returns NOTHING — and because
    // each is a well-formed call envelope, messaging emits no 'not_call' verdict
    // and hands it straight here, so nothing arms the ring-proof fuse. Worse, a
    // frame arriving at all parks (start(), and the top of this handler) any
    // fuse a preceding frame armed. The proof the ring is invalid is THIS frame,
    // delivered and semantically inert: if this peer still has a pending push
    // ring and no live call adopted it, ARM THE FUSE (dismissing here
    // immediately ended the placeholder of the offer one frame
    // behind: an old call.answer queued before the new offer took the new
    // call's ring, its parked rebind and any answer already made down with it;
    // the grace is the same two seconds the verdict path has always given the
    // legitimate drain to catch up). With nothing behind it, the fuse burns
    // and dismisses — the immediate-dismissal guarantee deferred, not repealed.
    //
    // Report-first is untouched: reportNewIncomingCall already fired natively on
    // the push, long before any JS ran. The burn-down dismiss is a native no-op
    // once a real offer cleared `pendingPush`, so a genuinely live call is never
    // disturbed — the cid/peer match below is the JS-side belt to that native
    // suspenders. The offer branch owns its own placeholder (each of its paths
    // adopts, or dismisses and returns) and call.end SETTLES OR ARMS FOR
    // ITSELF, so both are excluded here. call.end's exclusion is no longer the
    // "it already dismissed" it once was: it dismisses immediately only when it
    // names the live call or no ring is noted, and otherwise arms this very
    // fuse — with 'cancelled', the reason this sweep cannot supply.
    if (
      call.tcm !== 'call.offer' &&
      call.tcm !== 'call.end' &&
      this.peerHasPushRing(peerId)
    ) {
      const live = this.service.current.call;
      if (!(live && live.cid === call.cid && live.peerId === peerId)) {
        this.onFrameVerdict(peerId, 'not_call');
      }
    }
  }

  /** Envelopes reach us already decoded when messaging parsed them, and as raw
   * bodies when it did not. Accept both rather than depending on which. */
  private asCallEnvelope(envelope: unknown): CallEnvelope | null {
    if (typeof envelope === 'string') return parseCallEnvelope(envelope);
    if (envelope && typeof envelope === 'object' && 'tcm' in envelope) {
      const tcm = (envelope as { tcm: unknown }).tcm;
      if (typeof tcm === 'string' && tcm.startsWith('call.')) {
        return parseCallEnvelope(JSON.stringify(envelope));
      }
    }
    return null;
  }

  // --- native events ------------------------------------------------------

  /**
   * A local candidate the module gathered. Batched by the service.
   *
   * `cid` names the peer connection that gathered it. A candidate for any
   * other cid — a dead small-group leg's late gathering, a call that ended
   * while the module was still gathering — is dropped rather than queued
   * under whatever 1:1 call happens to be live. Optional only for callers
   * that predate the check (the CLI gate); the app always passes it.
   */
  onLocalIceCandidate(candidate: { cand: string; mid: string; idx: number }, cid?: string): void {
    if (cid !== undefined && this.service.current.call?.cid !== cid) return;
    this.service.queueLocalIce(candidate);
  }

  async onIceStateChanged(cid: string, state: string): Promise<void> {
    if (state === 'connected' || state === 'completed') {
      await this.service.dispatch({ type: 'iceStateChanged', cid, ice: 'connected' });
    } else if (state === 'failed') {
      await this.service.dispatch({ type: 'iceStateChanged', cid, ice: 'failed' });
    } else if (state === 'disconnected') {
      await this.service.dispatch({ type: 'iceStateChanged', cid, ice: 'disconnected' });
    }
  }

  /**
   * CallKit says the user answered.
   *
   * The cid is CHECKED rather than discarded. CallKit can hold a call this
   * reducer knows nothing about — one reported from a VoIP push whose offer
   * never arrived, or one left over from a previous state — and forwarding
   * that blindly would answer or, worse, END whichever unrelated call happens
   * to be live now.
   */
  async onCallKitAnswer(cid?: string): Promise<void> {
    if (!this.addresses(cid)) {
      // CallKit is answering a call this reducer has never heard of. The
      // ordinary cause is not an error: the app was killed while ringing and
      // has just been cold-launched BY this answer, so the machine is idle and
      // the offer only exists in SQLite.
      //
      // Returning here — which is what this did — meant the user answered, the
      // system showed a connected call, and nothing happened. No audio, no
      // envelope, no end. They sat listening to silence until one side hung up.
      if (cid && (await this.rehydrate(cid))) {
        await this.service.dispatch({ type: 'callKitAnswered' });
      }
      return;
    }
    await this.service.dispatch({ type: 'callKitAnswered' });
  }

  /**
   * Rebuild a ringing call from its stored offer so a cold-launch answer has
   * something to answer.
   *
   * Returns false when there is nothing to rebuild from, in which case the
   * CallKit call is released rather than left showing a connection that will
   * never carry audio.
   */
  private async rehydrate(cid: string): Promise<boolean> {
    const stored = await this.deps.takeOffer?.(cid).catch(() => null);
    if (!stored) {
      await this.deps.native.endCall(cid, 'failed_media').catch(() => undefined);
      return false;
    }
    // An offer that expired while the phone was off cannot be answered — the
    // caller gave up long ago — and replaying it would ring a call into a
    // peer that has already torn down.
    if (stored.exp <= this.deps.now()) {
      await this.deps.native.endCall(cid, 'timeout').catch(() => undefined);
      return false;
    }
    // Credentials first, exactly as the live offer path does: an answer built
    // with no relay can only find a direct path. And the verdict with
    // them: this IS the answering path after a kill — the whole call, offer to
    // answer, happens here — so a policy decided only in `onEnvelope` would be
    // missing from every lock-screen answer.
    await this.decideRelayFor(stored.peerId);
    await this.ensureCredentials(MAX_CALL_BOUND_MS);
    await this.pushRelayPolicy();
    await this.service.dispatch({
      type: 'offerReceived',
      cid: stored.cid,
      peerId: stored.peerId,
      sdp: stored.sdp,
      video: stored.video,
      exp: stored.exp,
      serverTs: stored.serverTs,
    });
    // `takeOffer` already consumed the row, so nothing is left to drop.
    this.ringingOfferCid = null;
    return this.service.current.call?.cid === cid;
  }

  async onCallKitEnd(cid?: string): Promise<void> {
    if (!this.addresses(cid)) {
      // Declining a PUSH PLACEHOLDER lands here: the only cid CallKit has is
      // the synthetic one, which no reducer state ever addresses. The person
      // just said no to this caller — remember it, so the offer that decrypts
      // moments later is answered with a decline frame instead of a second
      // ring.
      if (cid) {
        const from = this.pushRings.get(cid);
        if (from) {
          this.pushDeclines.set(from, this.deps.now());
          // Ring proof: the person just ended this placeholder themselves — the most
          // final settling of its fate there is. Settlement spends the
          // declined note, any sibling notes for this peer, the fuse and the
          // deadline together, so none of them outlives the ring they
          // measured (`settleRingProof`'s invariant; a sibling note left
          // behind would keep `peerHasPushRing` true and re-arm fuses for
          // ordinary traffic, exactly as the burn-down guards against with
          // the same `forgetPushRingsFor`).
          this.settleRingProof(from);
        }
      }
      // A CallKit call we have no state for. Release it so the system UI does
      // not keep showing a call nothing can dismiss, but do not touch the
      // live one.
      if (cid) await this.deps.native.endCall(cid, 'cancelled').catch(() => undefined);
      return;
    }
    await this.service.dispatch({ type: 'callKitEnded' });
  }

  /** True when a native event names the call this reducer is actually running.
   * An event with no cid is trusted, for callers that cannot supply one. */
  private addresses(cid: string | undefined): boolean {
    if (!cid) return true;
    return this.service.current.call?.cid === cid;
  }

  async onNetworkChanged(): Promise<void> {
    await this.service.dispatch({ type: 'networkChanged' });
  }

  // --- outbound -----------------------------------------------------------

  /** Place a call. Throws if no relay is reachable AND the caller asked for
   * always-relay, because that combination cannot connect and failing here is
   * more honest than ringing a phone that can never answer. */
  async placeCall(peerId: string, cid: string, video: boolean): Promise<void> {
    // BEFORE anything: The design says a blocked peer and a peer whose safety number
    // changed cannot be called. That was true only at the transport seam, and
    // by the time an envelope is refused the reducer has already emitted
    // `createOffer` — which starts the CAMERA and MICROPHONE — and
    // `reportOutgoingCall`, which puts a call on the lock screen. So calling
    // someone you had blocked lit your camera, spent a TURN credential,
    // flashed a CallKit call, and then wrote a log row saying `cancelled`, as
    // though you had hung up on yourself.
    //
    // Checked here rather than in the reducer because it is a fact about this
    // device's relationship with a peer, which the reducer deliberately does
    // not model, and it must be checked before the FIRST effect runs.
    // The busy rule's OUTBOUND half, and it belongs beside the gate for the
    // same reason that one does: before the first effect, therefore before
    // the camera and before a CXCall. A live small-group session owns this
    // device's microphone; placing a 1:1 call over it would start a second
    // CallService, a second CallKit call and a second capture while N legs
    // are still transmitting. The inbound half has been enforced since the
    // seam landed (`onEnvelope`'s busy answer) — half of a both-directions
    // rule is not the rule.
    if (this.deps.groupRouter?.liveSessionBusy() === true) {
      throw new CallRefusedError('busy');
    }

    const refusal = await this.deps.mayCall?.(peerId);
    if (refusal && !refusal.allowed) {
      throw new CallRefusedError(refusal.reason);
    }

    // decided BEFORE the credential fetch so the refresh configures with
    // the right policy first time, and before the first effect so the answer
    // is settled by the time anything gathers a candidate.
    await this.decideRelayFor(peerId);
    await this.ensureCredentials(MAX_CALL_BOUND_MS);
    if (this.deps.relayOnly() && !this.credentials) {
      throw new Error('always-relay is on but no relay is available');
    }
    // After the refusal, so a call that never happens configures nothing, and
    // before the dispatch, because the dispatch's first effect is
    // `createOffer` — the moment the policy stops being changeable for this
    // call.
    await this.pushRelayPolicy();
    const reportId = await this.deps.mintReportId();
    await this.service.dispatch({ type: 'placeCall', cid, peerId, video, reportId });
  }

  /** @param opts `{video: false}` is "Answer without video" — it has to reach
   * the reducer, or the camera starts anyway. */
  async accept(opts: { video?: boolean } = {}): Promise<void> {
    await this.service.dispatch({ type: 'localAccept', video: opts.video ?? true });
  }

  /**
   * Announce our track state to the peer (the design `call.media`).
   *
   * Not routed through the reducer: it describes THIS device's tracks, which
   * the reducer deliberately does not model, and it has no effect on any
   * transition. Guarded on the cid so a toggle racing a hangup cannot send
   * under a call that has ended.
   *
   * AND ON THE ADDRESSEE, which the cid check never was: a cid guard is
   * TEMPORAL. It could afford to be while the only caller was `announceMedia`
   * (index.ts), which reads `call.peerId` off the live context two lines
   * earlier. The `call.restart` branch is the first caller that can be handed
   * an id that arrived on the wire, and the reducer's own `send()` is
   * incapable of addressing anyone but `call.peerId` whoever a frame came
   * from. This makes that structural property true here too, rather than true
   * by every caller's good manners.
   */
  async sendMedia(peerId: string, cid: string, audio: boolean, video: boolean): Promise<void> {
    const live = this.service.current.call;
    if (!live || live.cid !== cid || live.peerId !== peerId) return;
    await this.deps.messaging.sendCallEnvelope(
      peerId,
      { tcm: 'call.media', cid, a: audio, v: video },
      { urgent: false },
    );
  }

  async decline(): Promise<void> {
    await this.service.dispatch({ type: 'localDecline' });
  }

  async hangup(): Promise<void> {
    await this.service.dispatch({ type: 'localHangup' });
  }

  // --- TURN credentials ---------------------------------------------------

  /**
   * Make sure the module has usable relay credentials.
   *
   * Single-flight: an incoming offer and a foreground refresh can land at the
   * same moment, and two concurrent mints would both spend the per-user rate
   * limit for one call's worth of benefit.
   */
  async ensureCredentials(minRemainingMs = 0): Promise<void> {
    // `minRemainingMs` is the life the CALLER needs, over and above the cache
    // rule: a call about to start asks for `MAX_CALL_BOUND_MS`, everything
    // else (a warm-up on a VoIP wake, a settings toggle) asks for nothing.
    if (this.credentials && this.deps.now() + minRemainingMs < this.credentials.expiresAt) return;
    if (this.refreshing) return this.refreshing;

    this.refreshing = (async () => {
      try {
        const { iceServers, ttlSeconds } = await withTimeout(
          this.deps.fetchTurnCredentials(),
          CREDENTIAL_TIMEOUT_MS,
        );
        this.credentials = {
          servers: iceServers,
          expiresAt: this.deps.now() + ttlSeconds * 1000 * REFRESH_AT,
        };
        this.appliedRelayOnly = this.effectiveRelayOnly();
        await this.deps.native.configure(iceServers, this.appliedRelayOnly);
      } catch {
        // No relay is a DEGRADED state, not a failure: a direct call still
        // works for most networks, and refusing to place one because the
        // credential endpoint is down would turn a partial outage into a
        // total one. `placeCall` refuses only when always-relay is on.
        this.credentials = null;
        this.appliedRelayOnly = this.effectiveRelayOnly();
        await this.deps.native.configure([], this.appliedRelayOnly).catch(() => undefined);
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  /** True when the module currently holds relay credentials. */
  get hasRelay(): boolean {
    return this.credentials !== null;
  }

  /**
   * Re-apply the ICE policy to the native module immediately.
   *
   * `iceTransportPolicy` is set only inside `configure`, which only runs
   * during a credential refresh — so turning "always relay" ON left host
   * candidates being offered for up to the remaining cache life, which is
   * hours. The setting appeared to work and did nothing, which is the worst
   * kind of privacy control.
   */
  async applyRelayPolicy(): Promise<void> {
    if (!this.credentials) {
      await this.ensureCredentials();
      return;
    }
    this.appliedRelayOnly = this.effectiveRelayOnly();
    await this.deps.native.configure(this.credentials.servers, this.appliedRelayOnly);
  }
}
