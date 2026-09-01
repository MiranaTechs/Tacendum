import {
  admitGroupCallInvite,
  groupCallInviteIsRingable,
  isGroupCallTcm,
  parseCallEnvelope,
  parseGroupCallEnvelope,
  type CallEndReason,
  type CallEnvelope,
  type CallEffect,
  type CallState,
  type GroupCallEnvelope,
  type GroupCallInviteEnvelope,
} from '@tacendum/shared';
import { createPacingBucket } from '@tacendum/shared/pacing';
import {
  groupSessionReducer,
  type GroupSessionInput,
  type GroupSessionState,
  type LegPhase,
  type SessionEffect,
  type StoredGroupOffer,
} from '@tacendum/shared/call-session';
import { CallService, type CallLogRow, type CallMetricSink, type CallNative } from './service';
import type { CallPermission, GroupRouter } from './controller';
import { shortId } from '../person';

/**
 * THE SMALL-GROUP CALL COORDINATOR.
 *
 * `groupSessionReducer` (`@tacendum/shared/call-session`) decides; this file
 * executes — the same split `callReducer`/`CallService` uses one layer down,
 * and for the same two reasons: the session protocol stays verifiable without
 * a device, and the CLI harness drives the identical module rather than a
 * copy.
 *
 * The shape, stated once because everything below assumes it:
 *
 *  - ONE `CallService` PER LEG (departure 2). Each leg of a small-group call
 *    is a complete, ordinary 1:1 call — its own `callReducer`, its own
 *    `pendingSdp`, its own ICE buffer and 40-candidate budget, its own
 *    timers. Nothing in the shipped 1:1 machinery is re-keyed, and the
 *    last-but-one departure degrading to a 1:1 call is free: the session
 *    simply has one leg left.
 *  - ONE CXCALL PER SESSION. The four CallKit effect types are
 *    stripped from every leg by `filterEffects` and the aggregate —
 *    one report, one connect on the first leg, one release on the last — is
 *    derived by the reducer from leg LIFECYCLE. A second CXCall inside a
 *    session is a release blocker, not a glitch.
 *  - THE REDUCER CANNOT MINT A ULID, so this file does: every input that can
 *    open a leg carries executor-minted cids, exactly as `placeCall` carries
 *    a caller-minted cid in the 1:1 machine.
 *  - ADMISSION IS NEVER RE-DERIVED. No sid is compared, no epoch
 *    checked and no cap counted anywhere in this file; `admitGroupCallInvite`
 *    and `admitGroupCallRosterDelta` decide — through the reducer for every
 *    live input, and through ONE direct call to `admitGroupCallInvite` in
 *    `restore` (§ cold restore below), where the offers come off disk and
 *    there is no reducer state yet to ask on their behalf. Asking the judge
 *    directly is not re-deriving; writing a roster check here would be.
 *
 * A `sid` is payload: never logged, never a metric dimension, never
 * in an error string. The same rule a cid already carries.
 */

// --- budgets -----------------------------------------------------------

/**
 * The session signalling bucket. ONE bucket for every group-call frame —
 * ginvites, re-offers, roster deltas, per-leg ICE, per-leg ends.
 *
 * capacity 1 + 6 s × 23/6 per second = **24 frames in any 6-second window**,
 * the same arithmetic as `FANOUT_PACING` (`messaging.ts`) and strictly under
 * the server's `wsSend` (30 burst + 6×5 = 60 per 6 s, `ratelimit.ts:95`). A
 * room-message fan-out running concurrently uses its OWN 24/6 bucket; the two
 * together bound at 48 against that 60 — stated here so nobody "fixes" them
 * into one bucket and nobody widens either.
 *
 * The window bound is pinned as ARITHMETIC as well as behaviour, because the
 * group-chat pair taught that a jittered drain test cannot fail. Call
 * signalling has no jitter (the co-timed burst is a conceded leak), so
 * here the behavioural drain CAN fail too — both are asserted.
 */
export const GROUP_SIGNAL_PACING = {
  capacity: 1,
  refillPerSec: 23 / 6,
  windowSec: 6,
  maxPerWindow: 24,
} as const;

/**
 * The local mirror of the server's `pushSend` bucket (10 burst, 10 per
 * minute, `packages/server/src/ratelimit.ts:118`).
 *
 * CONSULTED, NEVER CONSUMED-AND-BLOCKED: the client cannot see a server-side
 * refusal, so a frame sent while the mirror is empty still goes — the
 * envelope queues server-side, only the WAKE is lost. What the empty mirror
 * buys is honesty on the tile: "Couldn't reach" immediately, instead of
 * "Calling…" forever. A later `call.ringing` from that peer upgrades it (they
 * were online; no push was needed), and the honest upgrade always wins.
 */
export const PUSH_MIRROR_PACING = { capacity: 10, refillPerSec: 10 / 60 } as const;

/**
 * How long a DEPARTED leg's service may go on owning its call before this
 * coordinator stops waiting for it (a liveness hole).
 *
 * `releaseDepartedLegs` refuses to release a service whose reducer still holds
 * a call, and that refusal is right: `CallService.dispose()` is the abrupt
 * seam's method, and running it over a teardown in progress used to abandon
 * the very `closePeerConnection` that teardown exists to perform. But the
 * refusal had no other arm, so "still winding down" and "wound down and stuck"
 * were the same answer — one native close that never resolves kept the
 * service, its cid, its end reason and its skip note resident for the whole
 * session, and starter-authorised remove/add churn grows the unique-peer count
 * without limit while the LIVE roster stays under the cap. That is precisely
 * the unbounded residency the reclamation exists to prevent, arriving through
 * the door the reclamation opened.
 *
 * A DEADLINE, in the idiom the 1:1 path already uses for a hung connect: the
 * machine does not ask whether the peer will ever answer, it arms
 * `CALL_CONNECT_TIMEOUT_MS` (45 s) and ends the call when the answer does not
 * come (`call-machine.ts`). Ten seconds because this bounds a TEARDOWN and not
 * a negotiation — a bridge close, one paced frame and a SQLite row — so it is
 * an order of magnitude beyond anything healthy and well inside the 45 s the
 * same codebase already tolerates for a call that is merely failing to start.
 * Every path it can cut short is idempotent (`close` natively, `closeMedia` in
 * the reducer), so a deadline that fires early costs a redundant bridge call
 * and nothing else.
 */
export const DEPARTED_LEG_TEARDOWN_MS = 10_000;

/** A leg that is finished: its service owns nothing the session still needs.
 * The same set `call-session.ts` calls terminal, named here because a
 * coordinator that guessed at it would release a live peer connection. */
const TERMINAL_LEG_PHASES: ReadonlySet<LegPhase> = new Set<LegPhase>([
  'failed',
  'declined',
  'left',
  'gone',
]);

/** The four effects a leg must never run: N legs are ONE conversation. */
const CALLKIT_EFFECTS: ReadonlySet<CallEffect['type']> = new Set<CallEffect['type']>([
  'reportIncomingCall',
  'reportOutgoingCall',
  'reportConnected',
  'endCallKit',
]);

// --- the surfaces this needs ------------------------------------------------

export interface GroupCallNative extends CallNative {
  /** The twin of `CallNative`'s, and TS will not accept divergence — which is
   * the interface enforcing rule 1 on itself. `cid` names the placeholder this
   * refusal was about; `''` matches whatever is pending for the peer. */
  dismissPendingIncomingCall(peerId: string, reason: string, cid: string): Promise<void>;
  /**
   * The all-or-close-the-leg needs a VERDICT, not the shipped silent
   * `call(cid)?.` no-op: a microphone you cannot silence toward one
   * participant is a live open mic to them while the UI says muted. Returns
   * whether the change was actually applied to that leg.
   */
  setAudioEnabled(cid: string, on: boolean): Promise<boolean>;
  setVideoEnabled(cid: string, on: boolean): Promise<boolean>;
  /**
   * THE DEVICE'S OWN OUTPUT ROUTE — the one media call on this interface that
   * is not per-leg, and the reason it returns nothing to verify.
   *
   * The `cid` is here because the bridge's signature has it, and native throws
   * it away: `TacendumCall.mm` forwards only `on` to `setSpeakerEnabled:`,
   * `TacendumCallImpl.swift` declares no cid parameter at all, and
   * `CallKitCenter.setSpeaker` ends at `overrideOutputAudioPort` on
   * `RTCAudioSession.sharedInstance()` — one route for the process. There is
   * no per-leg verdict to return because there is no per-leg effect.
   */
  setSpeaker(cid: string, on: boolean): Promise<void>;
}

export interface GroupCallTransport {
  sendCallEnvelope(
    peerId: string,
    envelope: CallEnvelope,
    opts: { urgent: boolean },
  ): Promise<void>;
  sendGroupCallEnvelope(
    peerId: string,
    envelope: GroupCallEnvelope,
    opts: { urgent: boolean },
  ): Promise<void>;
}

/** The database, injected, so the coordinator stays testable without SQLite
 * and SQLite stays ignorant of session state. */
export interface GroupCallStore {
  saveSession(row: {
    sid: string;
    roomId: string | null;
    starterId: string;
    roster: string[];
    se: number;
    video: boolean;
    startedAt: number;
  }): Promise<void>;
  loadSession(): Promise<{
    sid: string;
    roomId: string | null;
    starterId: string;
    roster: string[];
    se: number;
    video: boolean;
    startedAt: number;
  } | null>;
  deleteSession(sid: string): Promise<void>;
  saveOffer(offer: {
    cid: string;
    peerId: string;
    sdp: string;
    video: boolean;
    exp: number;
    serverTs: number;
    sid: string;
  }): Promise<void>;
  takeOffersForSession(sid: string): Promise<
    {
      cid: string;
      peerId: string;
      sdp: string;
      video: boolean;
      exp: number;
      serverTs: number;
      sid?: string | null;
    }[]
  >;
  /**
   * Drop every stored offer belonging to a session that is over.
   *
   * `takeOffersForSession` consumes them on the restore path; nothing
   * consumed them on the ORDINARY path, so an answered, declined or ended
   * session left one row per invite holding a peer id, a DTLS fingerprint and
   * a set of candidate addresses until the next app-start prune — which is
   * bounded by the ring TTL from `startedAt` and can therefore be weeks away
   * on a phone that is never force-quit.
   */
  deleteOffersForSession(sid: string): Promise<void>;
  writeLog(row: CallLogRow & { sessionId: string | null; roomId: string | null }): Promise<void>;
}

export interface GroupCallDeps {
  /** This device's account id. Null before registration — no session may start. */
  selfId(): string | null;
  native: GroupCallNative;
  transport: GroupCallTransport;
  store: GroupCallStore;
  displayNameFor(peerId: string): Promise<string>;
  /**
   * The room's LOCAL name for a session started from a room: my rename, else
   * the creator's anchor — '' when the room is nameless, unreadable, or its
   * stored name is the room id in disguise (no surface renders a room's
   * id). Titles the outgoing CXCall, the one surface GroupCallScreen's
   * header cannot reach — a call to "Family" must not be titled by whichever
   * callee happens to be first in the roster. Absent for the CLI, which has
   * no CallKit surface to title.
   */
  roomNameFor?(roomId: string): Promise<string>;
  /** The gate, per LEG: `blocked` refuses the whole session, an
   * `identity_changed` peer's leg is skipped loudly while the rest proceed. */
  mayCall?(peerId: string): Promise<CallPermission>;
  /** Whether WE have blocked this peer. Consulted over the whole roster
   * before anything rings — synchronous, from messaging's in-memory set. */
  isBlockedLocally?(peerId: string): boolean;
  /**
   * WHETHER THE INVITER MAY RING THIS PHONE — silence unknown
   * callers, applied to a session invite.
   *
   * The same dep the 1:1 controller holds, reached through it
   * (`CallController.mayRing`) rather than wired twice, because the rule is
   * about the device and not about a call shape: the published sentence says
   * someone you have never exchanged a message with cannot make your phone
   * ring, and it does not qualify itself by how many people are on the call.
   *
   * Async because answering it reads the database, and it happens on the path
   * of an inbound invite. Optional: absent ⇒ every inviter rings, which is
   * both the pre-V7 behaviour and the CLI's, and is what `call.trace`'s
   * committed snapshot holds.
   */
  mayRing?(peerId: string): Promise<{ ring: boolean; reason?: 'unknown_caller' }>;
  /**
   * THE ROOM'S MEMBERSHIP, FOLDED NOW (the fold, asked at Add time).
   *
   * `addParticipant` used to validate the starter and the cap and nothing
   * else, and the only other gate was a candidate list the UI folded once per
   * room id. Somebody removed from the room mid-call therefore stayed
   * selectable and — the part that matters — was DIALLED, because no layer
   * between the picker and the wire asked the room again. A membership check
   * that is only as fresh as a React effect is not a membership check.
   *
   * Injected rather than read, exactly as `store` is: the coordinator stays
   * testable without SQLite. Null means the room could not be read at all,
   * which refuses — a fold this device cannot perform is not a fold that
   * passed. Absent (no dep) is for the ad-hoc case and the CLI, where there is
   * no room to consult; a session with a null `roomId` never asks.
   */
  roomMembers?(roomId: string): Promise<readonly string[] | null>;
  /** A duress session is network-silent and calls are the
   * loudest thing this app does. Refused before the first effect. */
  inDuress?(): boolean;
  /**
   * A decline the person already made against the VoIP PLACEHOLDER, before
   * this ginvite could decrypt — consumed, one decline per invite.
   *
   * The tombstone is the 1:1 controller's because the placeholder is
   * 1:1-shaped: a VoIP push carries a PEER, never a session, so the decline
   * that CallKit reports names a synthetic cid and nothing else. Without this
   * consult the group path rang a second time for a call the person had
   * already said no to — the exact defect `pushDeclines` was built to end,
   * reappearing because `handles()` routes a ginvite past the code that
   * consults it.
   */
  takePushDecline?(peerId: string): boolean;
  /**
   * The cid of the VoIP placeholder currently ringing for this peer, `''` if
   * unknown — the 1:1 controller's `ringCidFor`, reached through it for the
   * same reason `takePushDecline` and `mayRing` are: the placeholder is
   * 1:1-shaped (a push carries a PEER, never a session), so there is one
   * owner of the fact and this is the seam to it.
   *
   * Optional, and absent ⇒ `''` ⇒ the caller-keyed match, i.e. exactly the
   * behaviour before the cid existed.
   */
  ringCidFor?(peerId: string): string;
  /**
   * A CANCELLATION THIS SESSION COULD NOT CLAIM.
   *
   * Routed to the controller's decided-cancellation path so a cancelled group
   * ring is ended as .remoteEnded ("they hung up") rather than .unanswered
   * ("you ignored them") — the 1:1 `call.end` branch's behavioural twin. The
   * router's `adopted === false` still reports 'not_call' for the same frame;
   * an armed obligation makes that a no-op, so there stays exactly one timer
   * and one reason.
   */
  noteRingCancelled?(peerId: string): void;
  /** The busy rule's cross-shape half: a live 1:1 call makes this device busy to
   * `ginvite`s exactly as a live session makes it busy to 1:1 offers. */
  oneToOneBusy(): boolean;
  ensureCredentials(): Promise<void>;
  /**
   * The design'S PER-PERSON RELAY POLICY, ASKED FOR A SESSION.
   *
   * The same dep the 1:1 controller holds, reached through it
   * (`CallController.relayForSession`) rather than wired twice, because the
   * rule is about a PERSON and not about a call shape — the same argument
   * `mayRing` above makes, and the same seam.
   *
   * `ensureCredentials` was the only thing this coordinator ever called before
   * a leg was opened, and it configures the module with whatever the 1:1
   * controller last decided. So the app-wide switch reached a session and the
   * first-call default and per-person memory did not: a first small-group call
   * with someone this device has never called went DIRECT and disclosed its
   * address to them.
   *
   * ONE KNOB, N LEGS. `configure` sets one `RTCConfiguration` for the whole
   * native module, so the verdict is the OR over the participants and it
   * ratchets up for the life of the session — the controller owns that
   * argument, at `relayForThisSession`. Never called with this device's own
   * id, which would read as "never called yourself" and relay everything.
   *
   * Total by contract (it cannot reject), and awaited rather than fired: the
   * whole point is that it has finished before anything gathers a candidate.
   *
   * Optional. Absent ⇒ exactly today's behaviour, which is the CLI's and what
   * `call.trace`'s committed snapshot holds.
   */
  applyRelayPolicy?(peerIds: readonly string[]): Promise<void>;
  /** The session is over — drop its relay verdict, so the next call decides
   * for itself. Synchronous and total: it forgets a boolean, and deliberately
   * reaches no bridge (`CallController.releaseSessionRelay`). */
  releaseRelayPolicy?(): void;
  /** A fresh ULID. The reducer is pure and cannot mint one, so every input
   * that can open a leg carries executor-minted cids. Async because the app's
   * ULID factory is fed exclusively by the platform RNG (`msgid.ts`) and its
   * entropy pool refills over the native bridge — a synchronous mint here
   * would mean either a weaker source or a starving pool. */
  mintId(): Promise<string>;
  mintReportId(): Promise<string>;
  metrics?: CallMetricSink;
  now(): number;
  /** Injected so the signalling drain is deterministic under a fake clock —
   * the budget test measures frames against a virtual clock, not a jittered
   * real one. */
  delay(ms: number): Promise<void>;
  onChange?(view: GroupCallView | null): void;
}

/** What a leg looks like to the UI (the tile status line the call screen renders). */
export interface GroupLegView {
  peerId: string;
  phase: LegPhase;
  /** Why this leg was never opened at all, when it was not: a blocked peer or
   * one whose safety number changed. Held HERE and not in the session state
   * because it is a fact about this device's relationship with a peer, which
   * the pure module deliberately does not model. */
  skipped: 'blocked' | 'identity_changed' | null;
  /**
   * WHEN THIS COORDINATOR FIRST SAW THIS LEG WAITING, on the coordinator's own
   * clock; null once anything came back (the eight-second "May be offline").
   *
   * The anchor is HERE and not on the screen because the design requires status to
   * derive from coordinator state rather than from a view timer. A screen that
   * stamped its own map answered the question differently after a remount —
   * the same leg, silent for the same twelve seconds, read "Calling…" again
   * because the component was new. The screen may still tick to re-render; the
   * FACT is this field.
   *
   * Cleared the moment the leg leaves `inviting`, so a re-offer (which
   * mints a fresh cid and dials again) starts its own eight seconds rather
   * than inheriting the dead attempt's.
   */
  invitedAt: number | null;
}

/**
 * ONE LEG'S OUTCOME FROM A MUTE OR CAMERA FAN (and the call screen's drop attribution).
 *
 * The fan already computes this per leg; it used to keep it. The screen was
 * left to infer which legs a toggle had closed by watching the live set shrink
 * while a promise was outstanding — attribution by TIME WINDOW, which blames
 * an unrelated hangup or ICE failure that happens to land during a toggle on
 * the toggle. Causality is not derivable from a clock, so it is returned.
 */
export interface LegFanOutcome {
  peerId: string;
  /**
   * THE CID THIS FAN ACTUALLY ACTED ON — the leg as the fan snapshotted it,
   * which is not always the leg the peer is on by the time it resolves.
   *
   * A fan walks a snapshot; a peer can abandon their leg and re-offer on a
   * fresh cid inside one `setAudioEnabled` await. Naming the cid is what
   * makes the two `closed` answers below distinguishable to anything reading
   * this: an outcome that identifies only a PERSON cannot say which of their
   * legs it is a report about.
   */
  cid: string;
  /** Whether the track change was actually applied to this leg. */
  applied: boolean;
  /**
   * Whether THIS fan actually closed the leg because it could not be applied.
   * The only legs a screen may name in "…was dropped".
   *
   * THE CLOSE'S OWN VERDICT, NEVER THE FAN'S INTENT. When
   * the peer re-offered mid-fan, `closeLeg`'s cid guard correctly leaves their
   * new leg alone and the close is a no-op — the participant is live. Reporting
   * the intent instead told the person that somebody still in the call had been
   * dropped, which is the same class of untruth the time-window attribution
   * this field replaced was built to end.
   */
  closed: boolean;
}

export interface GroupCallView {
  sid: string;
  /**
   * THIS SESSION'S IDENTITY, AS AN OPAQUE KEY — the bare `sessionIncarnation`
   * counter.
   *
   * A screen that resets its own state when the session changes cannot ask the
   * SID: this device does not mint an inbound session's sid, the remote
   * starter does, so a fresh call can wear a dead one's name and a comparison
   * on it silently reads "same session". The counter moves on every session
   * identity transition — install, end, glare swap — so two sessions can never
   * share a key even when they share a sid.
   *
   * Monotonic, and carrying NO sid content: the composite fence token
   * (`sessionSid`) stays inside this file, because a sid on a published view
   * is a sid one careless render away from a screen.
   */
  sessionKey: number;
  starterId: string;
  selfId: string;
  roomId: string | null;
  roster: readonly string[];
  video: boolean;
  phase: GroupSessionState['phase'];
  legs: GroupLegView[];
  startedAt: number;
  connectedAt: number | null;
  muted: boolean;
  /**
   * WHETHER THIS DEVICE IS PLAYING THROUGH ITS LOUDSPEAKER.
   *
   * Published by the coordinator like `muted`, rather than mirrored by the
   * caller like the camera, because unlike the camera it is DECIDED here: the
   * coordinator makes the bridge call and therefore owns the answer. It is not
   * a report on a fan-out — see `setSpeakerEnabled` for why there is none.
   */
  speakerOn: boolean;
}

/** Thrown by `startGroupCall` when the call may not begin, and by
 * `addParticipant` when the room no longer holds the person being added. */
export class GroupCallRefusedError extends Error {
  constructor(
    readonly reason:
      | 'duress'
      | 'blocked'
      | 'busy'
      | 'credentials'
      | 'not_registered'
      | 'not_member',
  ) {
    super(reason);
    this.name = 'GroupCallRefusedError';
  }
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : 'unknown';
}

/** Envelopes reach us decoded when messaging parsed them and as raw bodies
 * when it did not — the `asCallEnvelope` contract, for both unions. */
function bodyOf(envelope: unknown): string | null {
  if (typeof envelope === 'string') return envelope;
  if (envelope && typeof envelope === 'object' && 'tcm' in envelope) {
    return JSON.stringify(envelope);
  }
  return null;
}

function tcmOf(envelope: unknown): string | null {
  if (typeof envelope === 'string') {
    const match = /^\{"tcm":"([^"]+)"/.exec(envelope);
    return match?.[1] ?? null;
  }
  if (envelope && typeof envelope === 'object' && 'tcm' in envelope) {
    const tcm = (envelope as { tcm: unknown }).tcm;
    return typeof tcm === 'string' ? tcm : null;
  }
  return null;
}

/**
 * An EMPTY, OPAQUE handle to one native CallKit press.
 *
 * The evidence lives in the coordinator's private WeakMap, not on this
 * object. That is the boundary: a ticket can travel from the native callback
 * back into this coordinator, but it carries nothing a wire envelope, a log,
 * persistence or a screen could accidentally learn to serialize.
 */
declare const groupCallKitPressBrand: unique symbol;
export type GroupCallKitPressTicket = Readonly<{
  [groupCallKitPressBrand]: true;
}>;

/** Where one native CallKit press belongs after its captured identity is
 * checked. Only `not-ours` may cross into the ordinary 1:1 controller. */
export type GroupCallKitPressResult = 'claimed' | 'not-ours' | 'stale';

/** Why the native seam asked this coordinator to classify the press. A live
 * match only names what the coordinator holds now; a persisted match can name
 * the cold session whose native sheet raised the press. */
export type GroupCallKitSessionEvidence = 'live' | 'persisted';

interface GroupRestoreOutcome {
  /** Whether a session is now available for the caller to drive. */
  restored: boolean;
  /** Whether restore itself acted on the native/group call. */
  claimed: boolean;
  /** The native aggregate the action belonged to. */
  subject: string | null;
}

export class GroupCallCoordinator implements GroupRouter {
  private state: GroupSessionState | null = null;
  private readonly callKitPresses = new WeakMap<
    GroupCallKitPressTicket,
    {
      generation: number;
      callKitSubject: string | null;
      sessionToken: string | null;
      reportedRingToken: string | null;
    }
  >();
  /** One service per PEER — one live leg per peer, which is what the session
   * state's `legs` record already assumes. */
  private readonly legs = new Map<string, CallService>();
  /** The cid each leg service is currently running, so an `idle` state change
   * (whose `call` is null by then) is still attributable to a leg. */
  private readonly legCid = new Map<string, string>();
  /** The terminal reason, harvested from the `endCallKit` effect on its way
   * to the bin: a bare `CallState` cannot tell "declined" from "failed" from
   * "left", and both the tile phases and the re-offer gate turn on that. */
  private readonly legEndReason = new Map<string, CallEndReason>();
  private readonly skipped = new Map<string, 'blocked' | 'identity_changed'>();
  private readonly reofferTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /**
   * Armed the first time a departed leg is found still winding down; cleared
   * when it is released, whether that release was earned or forced, and when
   * the peer comes back (`ensureLeg`). See `DEPARTED_LEG_TEARDOWN_MS`.
   *
   * KEYED BY PEER, BUT REMEMBERING THE CID. Departure is not
   * permanent — the starter can re-add the same account, and a re-added peer is
   * dialled on a FRESH cid (`addParticipant`, and a re-offer). The old
   * deadline was armed against the leg that would not finish dying; a leg the
   * same peer is now alive on is a different thing entirely, and disposing it
   * closes a live peer connection ten seconds after a successful rejoin.
   */
  private readonly departedDeadlines = new Map<
    string,
    { cid: string; timer: ReturnType<typeof setTimeout> }
  >();
  /**
   * THE MUTE THE FAN HAS ACHIEVED — the only thing `view.muted` may show.
   *
   * Written AFTER the fan-out, never before: The all-or-close-the-leg means a
   * leg that could not be silenced is closed, so every leg still on screen
   * when this is true is genuinely silent. Claiming it early would put a muted
   * glyph over a live microphone for the length of the fan, which is the worst
   * bug this product can ship.
   */
  private muted = false;
  /**
   * THE MUTE THE PERSON ASKED FOR — the session's mute STATE, and the half
   * a review found missing.
   *
   * `muted` above is a report on a fan that has finished, so it is the wrong
   * thing for a leg being born to consult: a participant added after the fan,
   * or a rostered leg opening after it, got a fresh ENABLED audio track and no
   * path reapplied anything. The UI then showed Muted over a live mic — not
   * for a window, but for the rest of the call.
   *
   * Recorded SYNCHRONOUSLY at the top of `setMuted`, before the first await,
   * so a leg opened while the fan is still walking the snapshot binds too. It
   * is deliberately NOT what the view publishes: the intent is what legs must
   * satisfy, the achievement is what a person may be told.
   */
  private mutedIntent = false;
  /**
   * THE CAMERA THE PERSON TURNED OFF, in the same two-field shape and for the
   * same reason: a camera you cannot stop toward one participant is a live
   * camera to them while the UI says off.
   *
   * Only the OFF direction is remembered as a deviation, because a freshly
   * opened leg's tracks are enabled by construction (§ `openLegDial`): the
   * work is turning something off that the new leg turned on, and re-applying
   * "on" to a track that is already on would be a bridge call whose only
   * possible contribution is a new way to fail.
   */
  private cameraOff = false;
  /**
   * THE OUTPUT ROUTE THIS DEVICE CHOSE — local, and the only piece of media
   * state on this object that is not a report on a fan-out.
   *
   * `muted` is written after N bridge calls because mute is a fact about what
   * each leg hears, and one leg that cannot be silenced makes the claim false.
   * The speaker is a fact about this phone's own earpiece, shared by every leg
   * because iOS has exactly one output route (`setSpeakerEnabled` below), so
   * there is no per-leg achievement to wait for and no leg that can contradict
   * it. Written after the single bridge call all the same, for the same reason
   * one layer down: a route that did not change may not be claimed.
   *
   * Reset with the rest of the scratch. The override does not survive CallKit
   * deactivating the audio session at the end of a call, so a `true` inherited
   * by the next session would light the speaker button over an earpiece — the
   * muted-glyph-over-a-live-mic shape, one control across.
   */
  private speakerOn = false;
  /**
   * WHEN EACH LEG FIRST BECAME `inviting`, on this coordinator's clock.
   *
   * The "May be offline" is a fact about the session and must survive the
   * screen being remounted; see `GroupLegView.invitedAt`. Kept beside
   * `skipped` — scratch the pure module deliberately does not model — rather
   * than in the session state, because it is an observation this device made
   * and not a thing the protocol carries.
   *
   * KEYED BY PEER, BUT REMEMBERING THE ATTEMPT. The anchor
   * is cleared when a leg leaves `inviting`, which reads every re-offer that
   * goes through `legs` correctly — and misses the two that do not. A RINGING
   * re-offer swaps `starterOffer.cid` while the peer has no `legs` entry at
   * all, so the derived phase never leaves `inviting` and a brand-new offer
   * inherited the dead one's instant: a call ringing for two seconds reading
   * "May be offline". GLARE is the same shape one scale up — a winner whose
   * roster names the same peer inheriting the loser's wait.
   *
   * So the value carries the cid the wait is ABOUT. A different cid is a
   * different attempt and gets its own eight seconds; the same cid is the same
   * wait and must not be re-stamped, which is the property that keeps a leg
   * making no progress from having its clock reset on every step.
   */
  private readonly legInvitedAt = new Map<string, { cid: string | null; at: number }>();
  /** Whether any LEG wrote its own history row this session. The aggregate
   * row exists for the sessions that produced none — an invite that expired,
   * a ring nobody's leg ever logged — and must never duplicate one. */
  private legLogRows = 0;

  private readonly bucket = createPacingBucket(
    GROUP_SIGNAL_PACING.capacity,
    GROUP_SIGNAL_PACING.refillPerSec,
  );
  private readonly pushMirror = createPacingBucket(
    PUSH_MIRROR_PACING.capacity,
    PUSH_MIRROR_PACING.refillPerSec,
  );

  /**
   * Session inputs, serialized.
   *
   * The reducer is written against a sequential input stream exactly as
   * `callReducer` is, and inputs arrive from three directions at once —
   * envelopes off the controller's queue, leg state changes from N services,
   * and timers. Two interleaved steps would let a leg's `connected` land
   * between an invite's dispatch and its effects.
   */
  private queue: Promise<void> = Promise.resolve();
  /** Outbound sends, serialized, because the pacer is a shared budget: two
   * concurrent sends would each see the same token. */
  private sendChain: Promise<void> = Promise.resolve();

  /**
   * THE GENERATION FENCE — `messaging.ts`'s, not a second mechanism.
   *
   * Every async path here captures `const gen = this.generation` at entry and
   * re-checks `this.stale(gen)` after every await; `dispose()` bumps the
   * counter, so everything in flight dies at its next checkpoint instead of
   * resuming into a workspace that no longer exists. Without it a step that
   * was suspended in an effect — a display-name read, a database write, the
   * pacer's own wait — came back after a relock and carried on: it reported a
   * CXCall, opened media, re-created leg services and appended to the still
   * live send chain, all for a session the relock had already ended.
   *
   * A counter rather than an `AbortSignal` because the seam is synchronous
   * (`dispose()` returns void) and because the app already reads this idiom in
   * one place; two fencing mechanisms in one codebase is how one of them rots.
   */
  private generation = 0;

  private stale(gen: number): boolean {
    return gen !== this.generation;
  }

  /**
   * THE SESSION FENCE — the generation fence's missing half.
   *
   * `generation` moves on `dispose()` and on nothing else, which is correct
   * for what it is: the abrupt seam. But a session ends in two other ways that
   * leave the counter exactly where it was — an ORDINARY end (the reducer
   * collapses `state` to null) and GLARE (the reducer swaps one session for
   * another inside a single output). An async step suspended across either
   * resumed into a workspace that still exists and wrote into it. The step was
   * not abandoned; it was simply about a call that is over.
   *
   * Several residual defects shared that one shape: A's mute fan published
   * B as muted while B's microphone was live, A's room fold dialled a person
   * into B, and A's anchors were handed to B's tiles. Each is a completion
   * writing across a boundary the fence next door cannot see.
   *
   * So every async operation captures `const sid = this.sessionSid()` at entry
   * and re-checks it before touching state or publishing — the same discipline
   * as `stale(gen)`, at the scale a session actually has. Where an operation is
   * LEG-scoped it carries its cid too and the check is (sid, cid); `closeLeg`'s
   * guard is exactly that check, one layer down.
   *
   * Null is a value and not a wildcard: a step that began with no session may
   * only complete with no session.
   *
   * AND THE TOKEN IS AN INCARNATION, NOT THE SID. The
   * sid alone is not a fence, because this device does not mint an inbound
   * session's sid — the REMOTE starter does, and nothing stops a fresh invite
   * reusing a dead session's sid, whether a legitimate re-ring or a hostile
   * replay. Under a sid-value fence that reuse passed X === X, and a stale
   * fan from the dead session published `muted` onto the new ringing one —
   * whose own intent was already reset, so answering it would not have bound
   * the mute to its legs either: the muted-glyph-over-live-mic claim, resur-
   * rected through sid collision. The incarnation counter bumps on every
   * session-identity transition (install, end, glare swap), so two sessions
   * can never share a token even when they share a sid. Callers compare the
   * token opaquely and never parse a sid back out of it.
   */
  private sessionIncarnation = 0;

  private sessionSid(): string | null {
    return this.state ? `${this.sessionIncarnation}:${this.state.sid}` : null;
  }

  /** Bump the incarnation when the session IDENTITY changes — never on an
   * ordinary step that keeps the same session, or every in-flight completion
   * would be aborted by its own session's progress. */
  private bumpIncarnationIfIdentityChanged(next: { sid: string } | null): void {
    // Sid-or-nullness covers every identity transition there is. The sid-reuse
    // case cannot arrive as a same-sid direct swap: an equal-sid invite is a
    // join_leg into the SAME session by the reducer's own glare rule, so a
    // reused sid can only ever arrive after the old session collapsed to null
    // — and both halves of that journey bump.
    if ((next?.sid ?? null) !== (this.state?.sid ?? null)) this.sessionIncarnation++;
  }

  /**
   * THE SID WHOSE CXCALL THIS DEVICE IS CURRENTLY SHOWING — this object's own
   * ledger, and not a thing derived from `state`.
   *
   * A FENCE MUST STOP THE BUILDING, NEVER THE DEMOLISHING. The generation
   * counter above cannot tell one from the other: it abandons whatever step
   * was in flight, and a step in flight is as likely to be tearing a session
   * down as building one up. The reducer collapses the session to null in the
   * SAME step that emits `releaseGroupCall` (`call-session.ts`'s `released`),
   * so the window between the state swap and the release is a window in which
   * `this.state` is already null and the CXCall is still on screen. A
   * `dispose()` landing there read `this.state?.sid`, found nothing, and
   * released nothing; the abandoned step never reached its own release
   * either. iOS went on offering a call that was dead everywhere else — the
   * lock screen showing a conversation nothing could answer, mute or end.
   *
   * Reading `lastSession` instead would fix that case and break its
   * neighbour: `closeSessionRow` runs immediately AFTER `releaseGroupCall`, so
   * a disposal suspended one effect later would release a CXCall that is
   * already gone — two `endCall`s for one conversation.
   *
   * So the release is driven by what this coordinator KNOWS it reported: set
   * immediately before the bridge call that reports it, cleared immediately
   * before the bridge call that releases it. Whoever holds the ledger owes the
   * release, and exactly one of them can hold it.
   */
  private cxCallSid: string | null = null;

  /**
   * THE RING THIS COORDINATOR PUT ON THE SCREEN, as a session token
   * (`sessionSid`) — `cxCallSid`'s doctrine applied to the
   * other question a CallKit press asks.
   *
   * A press names a SID, and a sid is mintable by a remote: this device does
   * not mint an inbound session's, the starter does, so a fresh invite can
   * wear a dead session's name. The only thing a press can honestly answer is
   * the ring this coordinator most recently put on the screen — and only if
   * that ring was already there when the person pressed.
   *
   * DELIBERATELY NOT SET BY THE COLD RESTORE. A restore ADOPTS a sheet
   * reported before this process existed (`callKit: 'reported'` — reporting
   * again would be a second CXCall for one conversation), so this
   * coordinator has put nothing on the screen and the token stays null. That
   * null is load-bearing: it is what tells a cold press that the ring it is
   * about is the one on disk, so a ring that goes UP while the press waits its
   * turn in the queue is visibly not the one the person pressed.
   *
   * Surrendered when the session it names ends (`resetSessionScratch`) and on
   * `dispose()`: a sheet that has been taken down is not one anybody can still
   * be pressing.
   */
  private reportedRingToken: string | null = null;

  /**
   * SIDS WHOSE ROW AND STORED OFFERS ARE OWED A DELETION — `cxCallSid`'s
   * doctrine, applied one field over to persistence (the
   * adjacent leak).
   *
   * `dispose()` had exactly one way to notice an unfinished demolition: a
   * `this.state` of null with a `lastSession` beside it. That reads the
   * ordinary teardown correctly and misreads session glare completely.
   * `supersede` (`call-session.ts`) emits the LOSER's whole teardown and the
   * WINNER's fresh ring in one reducer output, and the reducer's state is the
   * winner from the first effect onward — so a relock inside the loser's
   * teardown found a non-null state, concluded nothing was abandoned, bumped
   * the generation, and fenced off the loser's own `closeSessionRow`. Its row
   * and its stored invites survived the call they belonged to: a roster, a
   * peer id, a DTLS fingerprint and a set of candidate addresses, kept for a
   * session that had already lost.
   *
   * Deliberately NOT a glare special case. The question a fence cannot answer
   * is "was this step demolishing?", and the answer is not derivable from
   * state at all — so it is RECORDED instead. A sid is owed from the moment
   * the reducer EMITS `closeSessionRow` (not from the moment the effect is
   * reached, which is the very thing a fence can prevent), and surrendered
   * only once both deletes have actually happened. `dispose()` then drains
   * whatever is still owed, unconditionally, without asking how the step that
   * owed it came to be abandoned.
   */
  private readonly owedSessionRows = new Set<string>();

  /**
   * The sids whose delete pair is IN HAND, claimed synchronously before the
   * pair's first await and surrendered after both.
   *
   * `owedSessionRows` answers "does anyone still owe this deletion?", which is
   * the question a fence cannot answer. It does not answer "is someone already
   * doing it?" — and `dispose()` needs both. Destruction is unfenced by design
   * (`run`'s `closeSessionRow` has no stale check between its two deletes, and
   * must not have one: a disposal can only ever want stored SDPs gone harder),
   * so a teardown suspended INSIDE the pair resumes after the relock and
   * finishes it. A drain that saw only the ledger started a second, concurrent
   * pair for the same sid.
   *
   * Today that costs nothing: `deleteSession` and `deleteOffersForSession` are
   * SQLite deletes and idempotent. The set exists because the next effect
   * added to that pair — a tombstone, a counter, a secure erase — inherits the
   * race silently, and because "harmless in this store" is not a property this
   * layer gets to assume about the layer below it.
   *
   * The check is SOUND rather than a narrowing: JavaScript runs to completion,
   * so a sid found here is one whose pair is standing at an await inside a
   * function with no early return and no throwing call left in it. It WILL
   * finish. Skipping it is not "hoping someone else does the work" — the whole
   * mistake `owedSessionRows` was written against — it is declining to do work
   * that is provably already in flight.
   */
  private readonly deletingNow = new Set<string>();

  constructor(private readonly deps: GroupCallDeps) {}

  // --- what the UI reads ----------------------------------------------------

  get view(): GroupCallView | null {
    const s = this.state;
    if (!s) return null;
    return {
      sid: s.sid,
      sessionKey: this.sessionIncarnation,
      starterId: s.starterId,
      selfId: s.selfId,
      roomId: s.roomId,
      roster: s.roster,
      video: s.video,
      phase: s.phase,
      legs: s.roster
        .filter(id => id !== s.selfId)
        .map(peerId => ({
          peerId,
          phase: s.legs[peerId]?.phase ?? 'inviting',
          skipped: this.skipped.get(peerId) ?? null,
          invitedAt: this.legInvitedAt.get(peerId)?.at ?? null,
        })),
      startedAt: s.startedAt,
      connectedAt: s.connectedAt,
      muted: this.muted,
      speakerOn: this.speakerOn,
    };
  }

  /** Resolves once every input delivered so far has been handled. For tests
   * and for teardown, which must not race in-flight handling. */
  async whenIdle(): Promise<void> {
    // Looped: a step can enqueue follow-ups (a leg's state change, a skipped
    // dial's terminal report), and one await would return before those ran.
    for (let i = 0; i < 50; i++) {
      const before = this.queue;
      await this.sendChain.catch(() => undefined);
      await before.catch(() => undefined);
      if (this.queue === before) return;
    }
  }

  // --- the router seam ----------------------------------------------

  handles(_peerId: string, envelope: unknown): boolean {
    const tcm = tcmOf(envelope);
    if (!tcm) return false;
    if (isGroupCallTcm(tcm)) return true;
    // A 1:1 call frame naming a cid a live session owns is SESSION traffic:
    // every leg is an ordinary 1:1 call, so its answer, ICE, ringing, media,
    // restart and end all arrive under the shipped 1:1 kinds.
    if (!tcm.startsWith('call.')) return false;
    const cid = this.cidOf(envelope);
    return cid !== null && this.ownsCid(cid);
  }

  liveSessionBusy(): boolean {
    return this.state !== null;
  }

  async handle(
    peerId: string,
    envelope: unknown,
    meta: { msgId: string; ts: number },
  ): Promise<boolean> {
    const gen = this.generation;
    const body = bodyOf(envelope);
    if (!body) return this.state !== null;
    const tcm = tcmOf(envelope);
    if (tcm !== null && isGroupCallTcm(tcm)) {
      const group = parseGroupCallEnvelope(body);
      // A malformed group frame is dropped silently: the `call.` namespace is
      // transport, and a parser refusal here would cost nothing but noise.
      // Dropped, and SAID to be inert when nothing is live (a review
      // finding): the placeholder its `urgent` bit rang has nothing left to wait
      // for, and its arrival already defused the fuse that would have said so.
      if (!group) return this.state !== null;
      await this.handleGroup(peerId, group, meta.ts, gen);
      // ADOPTION, reported to the controller's sweep.
      // A ginvite owns its own placeholder on every path — each refusal in
      // `handleInvite` dismisses (blocked, declined, busy, silenced, expired)
      // and a ring adopts — so it reports adopted unconditionally, exactly as
      // the 1:1 offer branch is excluded from the controller's cleanup. A
      // gjoin/gleave is adopted only if a session now exists to claim it:
      // from idle it reduced to NOTHING, and saying so is what lets the
      // controller end the placeholder it arrived behind.
      return group.tcm === 'call.ginvite' || this.state !== null;
    }
    const call = parseCallEnvelope(body);
    if (!call) return this.state !== null;
    await this.handleLegEnvelope(peerId, call);
    // Claimed because a live session owned the cid (`handles`), so the
    // session is what vouches for it — and if this very frame ended the
    // session, the teardown owns every CXCall it releases.
    return this.state !== null;
  }

  // --- inbound: the three session kinds ------------------------------------

  private async handleGroup(
    from: string,
    envelope: GroupCallEnvelope,
    serverTs: number,
    gen: number,
  ): Promise<void> {
    if (envelope.tcm === 'call.gjoin') {
      await this.dispatch({ type: 'gjoinReceived', from, delta: envelope });
      return;
    }
    if (envelope.tcm === 'call.gleave') {
      // READ BEFORE THE DISPATCH — the 1:1 branch's own trap, exactly
      // (`controller.ts` reads `service.current.call` before its
      // `endReceived`). A leave from the last remaining participant ENDS the
      // session, so a check made afterwards sees `null` for a frame a live
      // session had claimed and files an ordinary hang-up as an ignored ring.
      const claimed = this.state !== null;
      await this.dispatch({ type: 'gleaveReceived', from, delta: envelope });
      // NOTHING CLAIMED IT — the same ambiguity the 1:1 `call.end` branch
      // faces, and the same answer. A leave that reduced to nothing from idle,
      // from a peer whose VoIP placeholder is ringing, is the group shape of
      // "they hung up": it earns the decided-cancellation grace, so CallKit
      // files it .remoteEnded. Routed only through the controller's
      // `adopted === false` it became a 'not_call' guess — .unanswered — and
      // the missed-call row accused the person of ignoring a caller who had
      // already rung off (both arms of the twin).
      if (!claimed) this.deps.noteRingCancelled?.(from);
      return;
    }
    await this.handleInvite(from, envelope, serverTs, gen);
  }

  private async handleInvite(
    from: string,
    invite: GroupCallInviteEnvelope,
    serverTs: number,
    gen: number,
  ): Promise<void> {
    const selfId = this.deps.selfId();
    if (!selfId) return;
    // Duress is network-silent, and a ring is the loudest thing there is.
    if (this.deps.inDuress?.()) return;

    // The design: a roster naming someone this phone has BLOCKED does not ring and
    // does not join — opening a media session to a blocked peer is worse than
    // messaging one, and skipping their leg silently is the omission-tell
    // rule 21 forbids, so the whole session is refused and a row says why.
    const blocked =
      this.deps.isBlockedLocally?.(from) === true ||
      invite.r.some(id => id !== selfId && this.deps.isBlockedLocally?.(id) === true);
    if (blocked) {
      await this.dismissPlaceholder(from, 'declined');
      await this.writeAggregateRow(invite.sid, from, 'in', 'blocked', invite.vid, false);
      return;
    }

    // A decline the person already made against the push placeholder, before
    // this invite could decrypt. Honour it exactly as the 1:1 path does: tell
    // the starter (the frame that was impossible to send from a synthetic
    // cid), clear the ring, write the row — and do NOT ring them again for a
    // call they answered with 'no' seconds ago.
    if (this.state === null && this.deps.takePushDecline?.(from) === true) {
      await this.honourPushDecline(from, invite);
      return;
    }

    // The busy rule's other half: a live 1:1 call makes this device busy to a session,
    // and the refusal travels as the existing `call.end{r:'busy'}` on the
    // offered leg — there is no `call.gbusy` (departure 3).
    if (this.state === null && this.deps.oneToOneBusy()) {
      await this.dismissPlaceholder(from, 'declined');
      await this.send(from, { tcm: 'call.end', cid: invite.cid, r: 'busy' }, true);
      return;
    }

    // Persist BEFORE the reducer, which is what makes the session-keyed repair
    // possible: `call_sessions` alone is not enough to answer with — the
    // SDPs are, and the ratchet consumed its message key on first decrypt.
    // Keyed by `sid`, so the restore takes the starter's offer AND every held
    // one in a single query. Failure is swallowed: no stored offer degrades a
    // cold-launch answer, it does not break the ring.
    if (groupCallInviteIsRingable(invite, serverTs, this.deps.now())) {
      // SILENCE UNKNOWN CALLERS, WITH THE INVITER AS THE CALLER.
      //
      // The 1:1 offer path decides this before anything rings and before any
      // credential is spent (`controller.ts`, the `mayRing` branch). A
      // `ginvite` is routed here by `handles()` before that branch is ever
      // reached, so without this the rule was true of one call shape and
      // false of the other: a stranger who put you in a roster made your
      // phone ring at any hour, which is the one thing the published sentence
      // promises cannot happen.
      //
      // WHOSE HISTORY DECIDES: `from`, and only `from`. It is the
      // ratchet-authenticated writerId — the person reaching you.
      // The roster is PAYLOAD, so a rule that rang whenever any rostered
      // account was known would ring for a stranger who typed a friend's id
      // into `r`; the gate would be forgeable by the one party it exists to
      // stop. The opposite reading — history with EVERY rostered account —
      // cannot be forged, but it silences the ordinary case group calls exist
      // for: a friend who added somebody you have not met. (The blocked check
      // above does scan the roster, and that is not an inconsistency: naming
      // a blocked account in `r` can only ever produce MORE refusal, so the
      // forgery has nowhere to go, and opening media to someone you blocked
      // is a different harm from being rung by someone you do not know.)
      //
      // Only when nothing is live, the guard the push-decline and busy
      // consults above already use. An invite arriving into a running session
      // is a late joiner or a non-starter pair's offer or a
      // re-offer; it rings nothing on its own, it comes from accounts the
      // STARTER's roster admitted rather than from someone reaching you, and
      // silencing it would break a call the person is already in — the
      // friend-of-a-friend leg is exactly the one this must not cut.
      if (this.state === null && this.deps.mayRing) {
        // A THROWN VERDICT IS A SILENT ONE. Every other fallback in this file
        // fails toward keeping the phone working; this one fails toward
        // quiet, for `loadSilenceUnknownCallers`'s reason: a wrongly silenced
        // call leaves a row the person can see and return at a time they
        // choose, and a database that cannot say whether this is a stranger
        // is not a reason to let one ring at 3am. It still dismisses and
        // still writes the row below, so a failure is visible rather than an
        // invite that vanished.
        const permission = await this.deps
          .mayRing(from)
          .catch(() => ({ ring: false }) as { ring: boolean });
        // The read is an await, so a relock can land inside it.
        if (this.stale(gen)) return;
        // …and so can a call the PERSON started. A session that went live
        // under the read is the reducer's busy case, not this one — the 1:1
        // path answers busy before it consults `mayRing` for the same reason.
        if (!permission.ring && this.state === null) {
          // THE PLACEHOLDER, WHICH HAS ALREADY RUNG. The VoIP push arrives
          // before anything can decrypt, so silencing here without dismissing
          // there means the unknown inviter rang the phone anyway and a
          // full-screen ring sits in front of a call that will never happen.
          // ONE dismissal is the whole of it: N legs are one CallKit call
          // and the pending placeholder is matched on the peer that
          // pushed — `pendingPush.from`, the inviter — so there is exactly
          // one, keyed by exactly this id, and no per-leg dismissal exists to
          // miss. A no-op in the ordinary foreground case.
          await this.dismissPlaceholder(from, 'declined');
          // Silencing is not hiding. The person must be able to see the call
          // happened and call back, which is the whole reason the setting can
          // default to ON. `decline` rather than `blocked`, the 1:1 path's
          // wording and its reasoning: the device declined this under a
          // policy its owner set, and a row a person reads should not accuse
          // them of blocking someone they never blocked.
          await this.writeAggregateRow(invite.sid, from, 'in', 'decline', invite.vid, true);
          // AND NOTHING GOES BACK. No decline, no busy, no `call.ringing` —
          // the bare `return` below is the whole response, so a silenced invite is
          // indistinguishable to the inviter from one that reached a phone
          // that was off. Every other refusal in this function tells the
          // sender something; this one must not, or the silence announces
          // itself and the setting becomes a way to probe for it.
          return;
        }
      }
      await this.deps.store
        .saveOffer({
          cid: invite.cid,
          peerId: from,
          sdp: invite.sdp,
          video: invite.vid,
          exp: invite.exp,
          serverTs,
          sid: invite.sid,
        })
        .catch(() => undefined);
      // THE ANSWERING HALF — and its own place, below the ring gate.
      //
      // Answering gathers candidates exactly as dialling does, and this device
      // will build a peer connection to the starter (`openLegAnswer`) and,
      // the moment the human answers, dial every lower-index incumbent the offer rule
      // names. All of those disclose an address, so a rule enforced only when
      // this device STARTS a session protects nobody on the side that receives
      // one.
      //
      // BELOW THE `mayRing` GATE ON PURPOSE. A silenced invite returns before
      // reaching here, and this must not resurrect it: the decision sends
      // nothing, rings nothing and dispatches nothing — it reads two rows per
      // peer and calls `configure` — so a silenced invite stays silent and an
      // admitted one is decided before any of its media exists.
      //
      // WHOSE POLICY IS ASKED: `from`, who is authenticated, plus the roster
      // the invite ASSERTS. The roster is payload and the `mayRing` gate above
      // refuses to trust it — but the two rules fail in opposite directions.
      // A forged `r` can only add ids, an added id can only turn the OR from
      // `false` to `true`, and `true` is MORE relaying: the forgery's only
      // reward is paying for this device's relay hop. It cannot lower the
      // answer below what `from` alone contributes, because `from` is always
      // in the set. (The blocked check at the top of this function scans the
      // asserted roster on the same reasoning.)
      await this.deps.applyRelayPolicy?.([
        from,
        ...invite.r.filter(id => id !== selfId && id !== from),
      ]);
      if (this.stale(gen)) return;
      // Credentials before the reducer sees the invite, exactly as the 1:1
      // offer path does it: an answer built with no relay can only ever find
      // a direct path.
      await this.deps.ensureCredentials().catch(() => undefined);
      // THE LATE TOMBSTONE RECHECK (`controller.ts`'s, applied
      // to the session shape). The placeholder is on screen for the whole of
      // the two awaits above — a database write and a credential fetch that
      // can cross the network — and the person can press the red button at
      // any point in them. Consulted once at the top, the group path rang for
      // a call that had just been refused AND left the tombstone standing to
      // ambush the caller's next attempt. `takePushDecline` consumes, so one
      // decline answers exactly one invite either way.
      if (this.stale(gen)) return;
      if (this.state === null && this.deps.takePushDecline?.(from) === true) {
        await this.honourPushDecline(from, invite);
        return;
      }
    } else if (this.state === null) {
      // An invite past its life never rings, and the person still deserves to
      // see that a call happened — the reducer refuses it before any state
      // exists, so this row is the coordinator's (call-session.ts says so).
      // The placeholder goes with it: the VoIP push rang BEFORE anything could
      // decrypt, so a stale invite that will never ring still has a
      // full-screen ring in front of it with nothing left to end it.
      await this.dismissPlaceholder(from, 'expired');
      await this.writeAggregateRow(invite.sid, from, 'in', 'expired', invite.vid, true);
    }

    // The persist, the credential fetch and the aggregate row above are all
    // awaits, and a relock can land in any of them. Dispatching now would
    // build a session — a ring, a CXCall, a peer connection — on the far side
    // of a teardown that has already happened.
    if (this.stale(gen)) return;
    await this.dispatch({
      type: 'ginviteReceived',
      from,
      selfId,
      invite,
      serverTs,
    });
  }

  /**
   * Honour a decline the person made against the VoIP placeholder.
   *
   * Tell the starter (the frame that was impossible to send from a synthetic
   * cid), clear the ring, write the row — and do NOT ring them again for a
   * call they answered with 'no' seconds ago. One body, two consult sites:
   * before the admission awaits and after them.
   */
  private async honourPushDecline(from: string, invite: GroupCallInviteEnvelope): Promise<void> {
    await this.dismissPlaceholder(from, 'declined');
    await this.send(from, { tcm: 'call.end', cid: invite.cid, r: 'decline' }, true).catch(
      () => undefined,
    );
    await this.writeAggregateRow(invite.sid, from, 'in', 'decline', invite.vid, true);
  }

  /**
   * Clear the VoIP push placeholder this invite rang under.
   *
   * A no-op in the ordinary foreground case (there is nothing pending), and
   * required in every other one: the push arrives before any envelope can
   * decrypt, so EVERY refusal below — blocked, an already-declined
   * placeholder, busy, expired — leaves a full-screen ring in front of a call
   * that will never happen unless this runs. The 1:1 offer path dismisses at
   * each of its refusals for exactly this reason; routing ginvites past that
   * path is what left the group side without it.
   */
  private async dismissPlaceholder(peerId: string, reason: string): Promise<void> {
    // NAMED, not merely peer-keyed: native fires only while `pendingPush`
    // still holds this exact placeholder, so a refusal that lands after the
    // ring was replaced is a no-op rather than the end of a call it was never
    // about. `''` — no dep, or a binary that predates the cid — is the
    // caller-keyed match this shipped with.
    const ringCid = this.deps.ringCidFor?.(peerId) ?? '';
    await this.deps.native
      .dismissPendingIncomingCall(peerId, reason, ringCid)
      .catch(() => undefined);
  }

  // --- inbound: ordinary 1:1 frames on a session leg ------------------------

  private async handleLegEnvelope(peerId: string, call: CallEnvelope): Promise<void> {
    const service = this.legs.get(peerId);
    if (!service || service.current.call?.cid !== call.cid) {
      // A frame for a cid this session no longer runs is a replaced or folded
      // leg finishing its teardown — normal, not exceptional.
      return;
    }
    switch (call.tcm) {
      case 'call.answer':
        await service.dispatch({ type: 'answerReceived', cid: call.cid, sdp: call.sdp, video: call.vid });
        break;
      case 'call.ice':
        await service.dispatch({ type: 'iceReceived', cid: call.cid, candidates: call.c });
        break;
      case 'call.ringing':
        await service.dispatch({ type: 'ringingReceived', cid: call.cid });
        break;
      case 'call.end':
        await service.dispatch({ type: 'endReceived', cid: call.cid, reason: call.r });
        break;
      case 'call.media':
        await service.dispatch({ type: 'mediaReceived', cid: call.cid, audio: call.a, video: call.v });
        break;
      case 'call.restart':
        await service.dispatch({ type: 'restartReceived', cid: call.cid, sdp: call.sdp });
        break;
      case 'call.offer':
        // A bare 1:1 offer can never address a session leg: a leg is opened by
        // a `ginvite` and re-opened by another one (a re-offer mints a fresh cid, so
        // it cannot match a live one either). Ignored rather than routed.
        break;
    }
  }

  // --- outbound -------------------------------------------------------------

  /**
   * Start a small-group call (the starter's ginvite IS the offer on
   * every starter↔member leg).
   *
   * Every refusal below happens BEFORE the first effect, therefore before the
   * camera, before a TURN credential is spent, and before anything is on the
   * wire — the `placeCall` lesson, applied to N legs at once.
   */
  async startGroupCall(
    others: readonly string[],
    video: boolean,
    roomId: string | null = null,
  ): Promise<string> {
    const gen = this.generation;
    const selfId = this.deps.selfId();
    if (!selfId) throw new GroupCallRefusedError('not_registered');
    if (this.deps.inDuress?.()) throw new GroupCallRefusedError('duress');
    if (this.state !== null || this.deps.oneToOneBusy()) {
      throw new GroupCallRefusedError('busy');
    }
    for (const peerId of others) {
      if (this.deps.isBlockedLocally?.(peerId) === true) {
        throw new GroupCallRefusedError('blocked');
      }
    }
    // THE WHOLE ROSTER AT ONCE, and BEFORE the credential fetch so the
    // refresh below configures with the decided policy the first time
    // (`placeCall`'s ordering, and its reason). Every leg of this session is a
    // pairwise call to somebody, and the first one with a person who has never
    // had this device's address must not be the one that gives it to them.
    //
    // Self is filtered out for the reason the dep spells out: asking the
    // policy about your own id reads as "never called", which would relay
    // every session ever started. `others` is the caller's list and may
    // contain it — `roster` below filters it for the same reason.
    await this.deps.applyRelayPolicy?.(others.filter(id => id !== selfId));
    // The decision reads the call log and the per-peer memory, so a relock can
    // land in it exactly as it can in the fetch below.
    if (this.stale(gen)) throw new GroupCallRefusedError('not_registered');
    try {
      await this.deps.ensureCredentials();
    } catch {
      throw new GroupCallRefusedError('credentials');
    }

    // ORDERED, self first: the roster's order is the offer rule, and the
    // starter is index 0 by construction on the device that starts.
    const roster = [selfId, ...others.filter(id => id !== selfId)];
    const cids: Record<string, string> = {};
    for (const peerId of roster) {
      if (peerId !== selfId) cids[peerId] = await this.deps.mintId();
    }
    const sid = await this.deps.mintId();
    const reportId = await this.deps.mintReportId();
    // The credential fetch above crosses the network and every mint crosses
    // the native bridge for entropy; a relock lands in the middle of that
    // routinely. Starting the session now would ring N people from a
    // workspace that has already been torn down — the refusal is the honest
    // one, because a disposed coordinator has no account to call from.
    if (this.stale(gen)) throw new GroupCallRefusedError('not_registered');
    await this.dispatch({ type: 'start', sid, selfId, roster, video, roomId, cids, reportId });
    return sid;
  }

  /** The human answered in-app. */
  async answer(): Promise<void> {
    const gen = this.generation;
    // THE SESSION THE PRESS WAS MADE IN (see `sessionSid`). Every cid crosses
    // the native bridge for entropy, and a session can end — the starter
    // leaves, glare is lost — inside any of those mints, under an unmoved
    // generation. `localAnswer` names no session at all, so a press that
    // resumed one session later answers whatever is ringing NOW: `createAnswer`
    // opens the microphone and the camera into a call the human never saw,
    // let alone consented to.
    const tok = this.sessionSid();
    const cids = await this.answerCids();
    if (this.stale(gen)) return;
    if (this.sessionSid() !== tok) return;
    // FENCED IN THE SLOT AS WELL AS HERE. The check above is made at ENQUEUE
    // time, and the queue is as wide as its longest effect: an input already
    // sitting in it can install a different session between this line and the
    // moment `localAnswer` — which names no session — actually runs.
    await this.dispatchIfSession({ type: 'localAnswer', cids }, tok);
  }

  /** The human refused in-app. */
  async decline(): Promise<void> {
    // THE SESSION THE PRESS WAS MADE IN, carried into the slot the input runs
    // in (see `dispatchIfSession`). `localDecline` names no session, so a
    // press queued behind a glare win refuses the call that REPLACED the one
    // the person was looking at.
    await this.dispatchIfSession({ type: 'localDecline' }, this.sessionSid());
  }

  /** End for me. For a non-starter that is leaving; for the starter it
   * ends the session for everyone — the confirm is the UI's. */
  async hangup(): Promise<void> {
    // The same, and this one is the louder half: End on the call still on the
    // screen tore down its successor — a call this device had only just
    // started ringing for.
    await this.dispatchIfSession({ type: 'localHangup' }, this.sessionSid());
  }

  /**
   * Attribute a native press NOW, before its handler asks SQLite whether the
   * CXCall names a session (the native seam).
   *
   * A cold press on A can wait in that read while B installs with A's sid and
   * reports its own ring. Reading only after the await attributes A's button
   * to B. The returned object is deliberately empty; its evidence stays in
   * `callKitPresses` and is consumed exactly once below.
   */
  captureCallKitPress(): GroupCallKitPressTicket {
    const ticket = Object.freeze({}) as GroupCallKitPressTicket;
    this.callKitPresses.set(ticket, {
      generation: this.generation,
      // The raw native aggregate is classification only; the opaque tokens
      // beside it are what prove that aggregate still belongs to this session.
      callKitSubject: this.cxCallSid ?? this.state?.sid ?? null,
      sessionToken: this.sessionSid(),
      reportedRingToken: this.reportedRingToken,
    });
    return ticket;
  }

  private takeCallKitPress(ticket: GroupCallKitPressTicket): {
    generation: number;
    callKitSubject: string | null;
    sessionToken: string | null;
    reportedRingToken: string | null;
  } | null {
    const press = this.callKitPresses.get(ticket) ?? null;
    this.callKitPresses.delete(ticket);
    return press;
  }

  async onCallKitAnswer(
    sid: string,
    ticket: GroupCallKitPressTicket,
    evidence: GroupCallKitSessionEvidence = 'live',
  ): Promise<GroupCallKitPressResult> {
    const press = this.takeCallKitPress(ticket);
    // NO CAPTURE EVIDENCE MEANS NO GROUP CLAIM. A forged or already-consumed
    // ticket cannot prove this id was ours, so swallowing it would strand a
    // genuine 1:1 green button.
    if (!press) return 'not-ours';
    const gen = press.generation;
    // THE RING THIS COORDINATOR HAD ON THE SCREEN WHEN THE PRESS ARRIVED
    // (extended to the native-event seam). Null on a
    // cold launch: the sheet outlived the process, and the restore below
    // adopts it rather than reporting a second one.
    const ring = press.reportedRingToken;
    // PERSISTENCE COMPLETES A COLD TICKET. Its three null identity fields mean
    // only that no coordinator survived to witness the native sheet; the row
    // naming this sid is the missing ownership evidence. Live evidence is not
    // interchangeable: it may be B, installed under A's reusable sid while
    // SQLite was pending. Treating both answers as one boolean either releases
    // B's native aggregate through 1:1 or swallows a real cold 1:1 press.
    const coldPersistedOwner =
      evidence === 'persisted' &&
      press.callKitSubject === null &&
      press.sessionToken === null &&
      press.reportedRingToken === null;
    const groupOwnedPress = press.callKitSubject === sid || coldPersistedOwner;

    if (this.stale(gen)) {
      // A group-owned sheet invalidated by disposal is STALE, never a 1:1
      // press. Without ticket or persisted ownership there is no such claim.
      if (groupOwnedPress) return 'stale';
      return 'not-ours';
    }
    if (this.sessionSid() !== press.sessionToken) {
      // A changed incarnation makes an owned press STALE. With neither live
      // nor persisted ownership, this id never belonged to the group path.
      if (groupOwnedPress) return 'stale';
      return 'not-ours';
    }
    if (this.reportedRingToken !== ring) {
      // A replaced native ring makes its old button STALE. With neither
      // captured nor persisted ownership, the cold 1:1 race must fall through.
      if (groupOwnedPress) return 'stale';
      return 'not-ours';
    }

    let restoreClaimed = false;
    // A cold launch by a lock-screen answer: the machine is empty and the
    // session exists only in SQLite.
    //
    // AND THE PRESS CARRIES ITS OWN OWNERSHIP IN, because `evidence` is a
    // SNAPSHOT read at the seam and this callback has been asleep since. A
    // `live` match read there can name a session that installed under this
    // remotely minted sid AFTER the button was pressed and has torn down
    // again before the handler ran: that leaves every identity field null on
    // both sides, so each comparison above passes for want of anything to
    // compare, and a genuine cold 1:1 press walks into a restore it has no
    // provenance for. Restore then found no row of its own, released the
    // person's incoming call as `failed_media` and reported `claimed` — and
    // `claimed` is exactly what stops the ordinary 1:1 handler from running,
    // so the green button dismissed the call instead of opening it.
    if (this.state === null) {
      const restored = await this.restoreOutcome(sid, { owned: groupOwnedPress });
      restoreClaimed = restored.claimed;
      if (!restored.restored) {
        // Cleanup performed while refusing restore owns the press; otherwise
        // a group-owned press went stale and an unowned cold ticket is 1:1.
        if (restoreClaimed) return 'claimed';
        if (groupOwnedPress) return 'stale';
        return 'not-ours';
      }
    }
    // AND THE RESTORE MAY HAVE FOUND SOMEBODY ELSE'S CALL. `restore` answers
    // true for a session it merely FOUND live — a step that ran while it
    // waited its turn in the queue may already have built one — and it
    // compares no sid on that path. A press names a sid, and a sid is
    // mintable by a remote, so the fresh session it found can wear the name of
    // the row still sitting on disk: the incarnation check below then compares
    // the usurper against itself and passes.
    //
    // So the press is attributed to the RING instead. Two things must hold and
    // neither is derivable from a name:
    //
    // A LIVE identity refusal below is STALE when the captured sheet belonged
    // to this group, but NOT OURS when capture recorded another owner and the
    // real 1:1 handler must still get the press. A cold restore may already
    // have consumed offers or released the old CXCall, and that work remains
    // CLAIMED even if the identity moves before the button reaches `step`;
    // sending it through 1:1 as well would handle one press twice.
    if (this.stale(gen)) {
      // Restore work already performed is CLAIMED. Without it, an owned press
      // is stale after disposal; an unowned ticket still belongs to 1:1.
      if (restoreClaimed) return 'claimed';
      if (groupOwnedPress) return 'stale';
      return 'not-ours';
    }
    if (this.state?.sid !== sid) {
      // A restore that acted remains CLAIMED. A group-owned press whose session
      // moved is STALE; an unrelated id was never ours.
      if (restoreClaimed) return 'claimed';
      if (groupOwnedPress) return 'stale';
      return 'not-ours';
    }
    //  - the ring must not have gone up while this press was queued. A ring
    //    reported after the person pressed is one they never saw, whatever it
    //    is called;
    if (this.reportedRingToken !== ring) {
      // A restore that acted is CLAIMED. Otherwise a replaced owned ring is
      // STALE, while an unowned cold press is the genuine 1:1 fall-through.
      if (restoreClaimed) return 'claimed';
      if (groupOwnedPress) return 'stale';
      return 'not-ours';
    }
    //  - and where this coordinator is the one showing a ring, it must be
    //    THIS session's and not an older incarnation's.
    if (ring !== null && ring !== this.sessionSid()) {
      // A ring captured for this id but no longer naming the live incarnation
      // is STALE; an unowned ticket is not this coordinator's press.
      if (restoreClaimed) return 'claimed';
      if (groupOwnedPress) return 'stale';
      return 'not-ours';
    }
    // A live press carries its incarnation from the native callback. A cold
    // press carries null and adopts the incarnation restore just installed.
    if (press.sessionToken !== null && press.sessionToken !== this.sessionSid()) {
      // A moved live incarnation makes its captured button STALE. A ticket
      // for another id never belonged to this group session.
      if (restoreClaimed) return 'claimed';
      if (groupOwnedPress) return 'stale';
      return 'not-ours';
    }
    // Refusing is safe in both cases: the sheet this press was made on is
    // gone, and pressing the live one is a thing the person can still do.
    //
    // A LIVE TOKEN IS NEVER RE-READ AFTER RESTORE. Only a cold press carries
    // null and adopts the incarnation the restore installed; treating null as
    // a wildcard for a press made over an existing ring would answer its
    // same-sid successor.
    //
    // And the sid in the dispatch is no fence, whatever it looks like: this
    // device does not mint an inbound sid, the remote starter does, so a fresh
    // invite may wear a dead session's name and the reducer's own
    // `input.sid === state.sid` admits it. A press held across the mint would
    // then answer the session that arrived AFTER it — the microphone opened
    // into a call by a button pressed before that call existed.
    const tok = press.sessionToken ?? this.sessionSid();
    const cids = await this.answerCids();
    if (this.stale(gen)) {
      // Restore work is already CLAIMED; otherwise disposal made a captured
      // group answer STALE, while a non-owner remains 1:1.
      if (restoreClaimed) return 'claimed';
      if (groupOwnedPress) return 'stale';
      return 'not-ours';
    }
    if (this.sessionSid() !== tok) {
      // The mint crossed an incarnation boundary. An owned green button is
      // STALE there; only an unowned ticket may reach 1:1.
      if (restoreClaimed) return 'claimed';
      if (groupOwnedPress) return 'stale';
      return 'not-ours';
    }
    // …and fenced in the slot too, for `answer()`'s reason: the sid the input
    // carries is no fence (a remote mints it), so the queue's width has to be
    // covered by the incarnation or by nothing.
    const acted = await this.dispatchIfSession({ type: 'callKitAnswered', sid, cids }, tok);
    // A reducer action or prior restore work CLAIMS the press. A refused
    // group-owned input is STALE; only a never-owned id falls through.
    if (acted || restoreClaimed) return 'claimed';
    if (groupOwnedPress) return 'stale';
    return 'not-ours';
  }

  async onCallKitEnd(
    sid: string,
    ticket: GroupCallKitPressTicket,
    evidence: GroupCallKitSessionEvidence = 'live',
  ): Promise<GroupCallKitPressResult> {
    const press = this.takeCallKitPress(ticket);
    // NO CAPTURE EVIDENCE MEANS NO GROUP CLAIM. A missing or consumed ticket
    // must not swallow a genuine 1:1 red button.
    if (!press) return 'not-ours';
    const gen = press.generation;
    // Symmetric with Answer: only a fully cold ticket may borrow ownership
    // from persistence. A live-only match can be the session that usurped the
    // id during SQLite and is never evidence about the red button already hit.
    const coldPersistedOwner =
      evidence === 'persisted' &&
      press.callKitSubject === null &&
      press.sessionToken === null &&
      press.reportedRingToken === null;
    const groupOwnedPress = press.callKitSubject === sid || coldPersistedOwner;

    if (this.stale(gen)) {
      // Disposal makes a group-owned red button STALE. With neither captured
      // nor persisted ownership, the coordinator must leave the press to 1:1.
      if (groupOwnedPress) return 'stale';
      return 'not-ours';
    }
    if (this.sessionSid() !== press.sessionToken) {
      // A moved incarnation makes its owned press STALE; an unowned ticket
      // means this id was never the group's.
      if (groupOwnedPress) return 'stale';
      return 'not-ours';
    }
    if (this.reportedRingToken !== press.reportedRingToken) {
      // A replaced ring makes its owned red button STALE. An unowned cold press
      // is the 1:1 race and still needs the ordinary handler.
      if (groupOwnedPress) return 'stale';
      return 'not-ours';
    }

    let restoreClaimed = false;
    // Symmetric with the answer above, and for the same reason: after a cold
    // launch the machine is empty and the session exists only in SQLite. An
    // end that found nothing to end left the row, the stored offers and the
    // CXCall behind — and the starter ringing out their full timeout for a
    // call the person had already refused.
    //
    // RESTORED SILENTLY. `ring: false` suppresses the one effect that opens
    // the starter's leg, because opening it puts the 1:1 machine into
    // `incoming_ringing` — whose reducer emits `call.ringing`. A phone
    // answering the lock-screen red button was therefore telling the caller
    // "I am here, ringing" one frame before telling them "declined": a
    // presence announcement from a device that was asleep, with a refusal
    // stapled to it. The decline itself does not need the leg — `teardownAll`
    // closes the starter offer and every held one by cid, and `closeLeg`
    // announces without a service.
    //
    // AND CARRYING THE SAME OWNERSHIP, for the answer's reason: a `live`
    // snapshot that has evaporated by the time this red button is classified
    // is not evidence that the id was ever a group sid, and the restore below
    // must not release a 1:1 call this coordinator never held. Both buttons
    // reach the same cleanup, so both must prove the same thing.
    if (this.state === null) {
      const restored = await this.restoreOutcome(sid, {
        ring: false,
        owned: groupOwnedPress,
      });
      restoreClaimed = restored.claimed;
      if (!restored.restored) {
        // Restore cleanup CLAIMS what it released. Without cleanup, a
        // group-owned press is stale and an unowned ticket belongs to 1:1.
        if (restoreClaimed) return 'claimed';
        if (groupOwnedPress) return 'stale';
        return 'not-ours';
      }
    }
    if (this.stale(gen)) {
      // Completed restore work remains CLAIMED. Otherwise disposal makes an
      // owned press STALE and leaves a never-owned id to 1:1.
      if (restoreClaimed) return 'claimed';
      if (groupOwnedPress) return 'stale';
      return 'not-ours';
    }
    if (this.state?.sid !== sid) {
      // A restore that acted is CLAIMED. A moved group owner is STALE; an
      // unowned id was never ours.
      if (restoreClaimed) return 'claimed';
      if (groupOwnedPress) return 'stale';
      return 'not-ours';
    }
    if (this.reportedRingToken !== press.reportedRingToken) {
      // A restore that acted is CLAIMED. Otherwise a changed owned ring is
      // STALE, while an unowned cold press must reach 1:1.
      if (restoreClaimed) return 'claimed';
      if (groupOwnedPress) return 'stale';
      return 'not-ours';
    }
    if (
      press.reportedRingToken !== null &&
      press.reportedRingToken !== this.sessionSid()
    ) {
      // The captured ring names a dead incarnation. If it owned this id the
      // press is STALE; otherwise it never belonged to this group path.
      if (restoreClaimed) return 'claimed';
      if (groupOwnedPress) return 'stale';
      return 'not-ours';
    }
    if (
      press.sessionToken !== null &&
      press.sessionToken !== this.sessionSid()
    ) {
      // The live session moved after capture. Its old red button is STALE;
      // only a ticket for some other id can be not ours.
      if (restoreClaimed) return 'claimed';
      if (groupOwnedPress) return 'stale';
      return 'not-ours';
    }
    const tok = press.sessionToken ?? this.sessionSid();
    // FENCED IN THE EXECUTION SLOT. The raw sid in `callKitEnded` proves
    // nothing: a remote starter mints it, so B can wear A's exact name. A
    // stale red-button input that never began demolishing A must not demolish
    // B when it finally reaches the queue.
    const acted = await this.dispatchIfSession({ type: 'callKitEnded', sid }, tok);
    // A reducer action or restore cleanup CLAIMS the press. A refused
    // group-owned input is STALE; only a never-owned id falls through.
    if (acted || restoreClaimed) return 'claimed';
    if (groupOwnedPress) return 'stale';
    return 'not-ours';
  }

  // --- native events, routed by cid ----------------------------------------

  /**
   * A local candidate the module gathered, routed to the leg that gathered it.
   *
   * Routed BY CID and not broadcast: both native ICE events carry one
   * (`IceCandidateEvent`, `IceStateEvent`), and each leg's `CallService` owns
   * its own 40-candidate budget and its own batching window. Handing every
   * leg every candidate would describe paths to peer connections that do not
   * exist and would spend N budgets for one leg's connectivity.
   *
   * Returns whether this session claimed the event, so the 1:1 controller
   * keeps handling everything it does today.
   */
  onLocalIceCandidate(cid: string, candidate: { cand: string; mid: string; idx: number }): boolean {
    const service = this.legFor(cid);
    if (!service) return false;
    service.queueLocalIce(candidate);
    return true;
  }

  async onIceStateChanged(cid: string, state: string): Promise<boolean> {
    const service = this.legFor(cid);
    if (!service) return false;
    if (state === 'connected' || state === 'completed') {
      await service.dispatch({ type: 'iceStateChanged', cid, ice: 'connected' });
    } else if (state === 'failed') {
      await service.dispatch({ type: 'iceStateChanged', cid, ice: 'failed' });
    } else if (state === 'disconnected') {
      await service.dispatch({ type: 'iceStateChanged', cid, ice: 'disconnected' });
    }
    return true;
  }

  private legFor(cid: string): CallService | null {
    for (const service of this.legs.values()) {
      if (service.current.call?.cid === cid) return service;
    }
    return null;
  }

  /**
   * Starter-only growth (the cap is `call.ts`'s to refuse).
   *
   * AND, FOR A ROOM CALL, A MEMBER OF THE ROOM AS THE ROOM STANDS NOW.
   *
   * The reducer judges the starter, the epoch and the cap; it has never had a
   * roster to judge against, because a room is chat state and the session
   * knows only its own participants. The candidate list the picker offers was
   * therefore the ONLY membership check in the path, and it was folded once
   * per `groupRoomId` — so a person removed from the room ten minutes into the
   * call stayed selectable and could be dialled into it.
   *
   * The fold is one database read on a press the person just made, and it is
   * asked HERE rather than only in the picker because the picker is a screen:
   * it can be stale, it can be reused, and it cannot be the boundary. The
   * refusal is a THROW rather than a quiet return — a silent no-op would look
   * exactly like a slow dial to whoever pressed the button.
   */
  async addParticipant(peerId: string): Promise<void> {
    const gen = this.generation;
    // THE SESSION THIS ADD WAS PRESSED IN (see `sessionSid`). The fold and the
    // mint below are both awaits, and a session can end — ordinarily, or by
    // losing glare — inside either. A membership answer is an answer about ONE
    // room at ONE moment for ONE call; carrying it into the next call dials a
    // person nobody in that call asked for, judged against a room it has
    // nothing to do with.
    const sid = this.sessionSid();
    const roomId = this.state?.roomId ?? null;
    if (roomId !== null && this.deps.roomMembers) {
      const members = await this.deps.roomMembers(roomId).catch(() => null);
      // The fold is a database read; a relock lands in it, and a dial built on
      // the far side of one belongs to a workspace that no longer exists.
      if (this.stale(gen)) return;
      // …and so does a dial built on the far side of the call itself ending.
      // Returning rather than throwing, exactly as the generation fence does:
      // there is no refusal to show, because the screen that would show it
      // belongs to a session that is over.
      if (this.sessionSid() !== sid) return;
      // A room this device cannot read is not a room that said yes. Refusing
      // on null is the safe direction: the cost is an Add that must be tried
      // again, and the alternative is dialling on the strength of a failure.
      if (members === null || !members.includes(peerId)) {
        // No peer id and no sid in the message — the reason is the
        // whole content, and the UI already knows what to do with a refusal.
        throw new GroupCallRefusedError('not_member');
      }
    }
    const cid = await this.deps.mintId();
    if (this.stale(gen)) return;
    // The mint crosses the native bridge for entropy — the same window one
    // await later, and the ad-hoc path's only one.
    if (this.sessionSid() !== sid) return;
    // In the slot as well, and for the identical reason: this
    // check is made at enqueue time, and an input already in the queue can
    // install a different call before the Add reaches its own turn.
    await this.dispatchIfSession({ type: 'addParticipant', peerId, cid }, sid);
  }

  /**
   * Cids for an answer: one for every roster member this device might have to
   * offer to. Over-supplied deliberately — the reducer takes only the ones the offer rule
   * says are ours, and a MISSING cid is a loud throw there (compose-strict),
   * so supplying the superset is what keeps that throw impossible.
   */
  private async answerCids(): Promise<Record<string, string>> {
    const s = this.state;
    if (!s) return {};
    const cids: Record<string, string> = {};
    for (const peerId of s.roster) {
      if (peerId === s.selfId) continue;
      cids[peerId] = await this.deps.mintId();
    }
    return cids;
  }

  // --- cold restore --------------------------------------------

  /**
   * Rebuild the SESSION — not one leg — from SQLite.
   *
   * The bug this exists against is precise: `takeOffer(cid)` restores exactly
   * the offer whose cid CallKit happens to name, so a phone killed mid-ring in
   * a three-way call and answered from the lock screen came back holding one
   * leg and silently dropped the rest. The offers are taken BY SESSION, the
   * state is rebuilt whole, and the answer flow then runs normally: the starter's leg is
   * answered, every live held offer is answered, the sovereign `gjoin` goes
   * out and the offers to lower-index incumbents are made.
   *
   * AND EVERY OFFER IS RE-ADMITTED HERE (the distributed-dialler class, one
   * layer down). An invite is persisted as soon as it is ringable — before
   * the reducer's verdict, because the SDP is what a cold answer needs and
   * the ratchet consumed its message key on first decrypt — so the table
   * holds invites this device REFUSED live as well as the ones it admitted.
   * A non-rostered account that knows the sid was answered busy while the app
   * ran and, without this, became an answered media leg the moment the phone
   * was killed and the call answered from the lock screen. So the persisted
   * roster goes back to the same judge (`admitGroupCallInvite`, never a
   * roster check written here) and only `join_leg` is rebuilt.
   *
   * A refused offer is DROPPED, not answered and not refused again: it was
   * already told `busy` on the live path, and a restore that emitted fresh
   * frames at an account the roster does not name would tell a stranger this
   * phone came back.
   *
   * SERIALIZED AGAINST ITSELF AND AGAINST `step`.
   * `flushPendingEvents` hands JS everything CallKit raised before the process
   * existed, synchronously, and each handler starts its own async task. This
   * function sets no state until several awaits in, so two of them both saw a
   * null session and both entered `takeOffersForSession` — a SELECT followed
   * by a DELETE with no transaction around it. The loser came back holding an
   * empty offer list, concluded there was nothing to rebuild, and released as
   * `failed_media` the CXCall the winner had just answered. The latch below
   * makes the second caller await the FIRST's outcome instead of racing the
   * same rows; the body runs inside the coordinator's own queue, so a restore
   * can no longer interleave with a step either.
   *
   * `ring: false` restores the state without opening the ringing leg, for the
   * cold END path — see `onCallKitEnd`.
   *
   * `owned: false` says the caller cannot prove the named aggregate was ever
   * this device's group call. It changes nothing when the row is here — the
   * row is the provenance, and finding it is the whole job — and it is what
   * keeps the no-row cleanup below from firing on somebody else's 1:1 call.
   */
  private restoring: Promise<GroupRestoreOutcome> | null = null;

  async restore(
    sid?: string,
    opts: { ring?: boolean; owned?: boolean } = {},
  ): Promise<boolean> {
    return (await this.restoreOutcome(sid, opts)).restored;
  }

  private async restoreOutcome(
    sid?: string,
    opts: { ring?: boolean; owned?: boolean } = {},
  ): Promise<GroupRestoreOutcome> {
    const inflight = this.restoring;
    if (inflight) {
      const outcome = await inflight.catch(() => null);
      // Answered from the winner's outcome, never by reading the rows again:
      // they are gone by now, and a second pass would tear the call down.
      const sameSubject = sid === undefined || outcome?.subject === sid;
      return {
        restored: this.state !== null,
        // The first restore owns only the aggregate it acted on. An overlapping
        // press for another id still belongs to its ordinary 1:1 owner.
        claimed: sameSubject && outcome?.claimed === true,
        subject: sameSubject ? outcome?.subject ?? null : null,
      };
    }
    if (this.state) return { restored: true, claimed: false, subject: null };
    const gen = this.generation;
    const run = this.enqueue(async () => {
      if (this.stale(gen)) return { restored: false, claimed: false, subject: null };
      // Re-checked inside the queue: a step that ran while this call was
      // waiting its turn may already have built the session.
      //
      // AND "THE SESSION" IS NOT NECESSARILY YOURS. This answers "is there a
      // call to drive?", which is all a restore can honestly answer — the
      // session it found may be a fresh ring wearing the same name, because a
      // remote mints inbound sids. Whoever asked on behalf of a PRESS owes the
      // further check (`onCallKitAnswer`); nothing here can make a
      // sid mean more than it does.
      if (this.state) return { restored: true, claimed: false, subject: null };
      return this.restoreLocked(sid, opts.ring !== false, opts.owned !== false, gen);
    });
    this.restoring = run;
    try {
      return await run;
    } finally {
      if (this.restoring === run) this.restoring = null;
    }
  }

  private async restoreLocked(
    sid: string | undefined,
    ring: boolean,
    owned: boolean,
    gen: number,
  ): Promise<GroupRestoreOutcome> {
    const selfId = this.deps.selfId();
    if (!selfId) return { restored: false, claimed: false, subject: null };
    const row = await this.deps.store.loadSession().catch(() => null);
    if (!row || (sid !== undefined && row.sid !== sid)) {
      // Nothing to rebuild from. Release the CXCall rather than leave the
      // system showing a call that will never carry audio — `rehydrate`'s
      // doctrine, one layer up.
      //
      // AND ONLY FOR AN AGGREGATE THIS DEVICE IS KNOWN TO HAVE HELD. Ending a
      // CallKit call is the right answer for a group sid this coordinator
      // owned and the wrong one for a 1:1 cid it never owned, and the name
      // cannot tell them apart: a remote starter mints the sid, so a group
      // session can wear a 1:1 call's id. The row was the last piece of
      // provenance available down here and it is not here, so the caller's is
      // all there is — a ticket that named this aggregate when the button was
      // pressed, or a row that named it when the press was classified. An
      // unowned press releases nothing and claims nothing: it is somebody
      // else's incoming call, and the 1:1 handler it falls through to still
      // has media to open for it.
      if (sid !== undefined && owned) {
        await this.deps.native.endCall(sid, 'failed_media').catch(() => undefined);
        return { restored: false, claimed: true, subject: sid };
      }
      return { restored: false, claimed: false, subject: null };
    }
    if (this.stale(gen)) return { restored: false, claimed: false, subject: null };
    const offers = await this.deps.store.takeOffersForSession(row.sid).catch(() => []);
    if (this.stale(gen)) return { restored: false, claimed: true, subject: row.sid };
    const starter = offers.find(o => o.peerId === row.starterId);
    if (!starter) {
      await this.deps.native.endCall(row.sid, 'failed_media').catch(() => undefined);
      await this.deps.store.deleteSession(row.sid).catch(() => undefined);
      return { restored: false, claimed: true, subject: row.sid };
    }
    if (starter.exp <= this.deps.now()) {
      // The ring aged out while the phone was off; the starter gave up long
      // ago and replaying it would dial into a peer that has torn down.
      await this.deps.native.endCall(row.sid, 'timeout').catch(() => undefined);
      await this.deps.store.deleteSession(row.sid).catch(() => undefined);
      return { restored: false, claimed: true, subject: row.sid };
    }
    // THE VERDICT, ON THE COLD PATH. This IS the answering side after a kill — the
    // whole call, from a ring restored out of SQLite to `createAnswer` and the answer-time
    // offers, happens on the far side of this function — so a verdict decided
    // only in `handleInvite` would be missing from every lock-screen answer a
    // killed app gives, which is a large share of the answers a phone gives at
    // all. The PERSISTED roster, which is the one admission is about to judge.
    await this.deps.applyRelayPolicy?.(row.roster.filter(id => id !== selfId));
    if (this.stale(gen)) return { restored: false, claimed: true, subject: row.sid };
    await this.deps.ensureCredentials().catch(() => undefined);
    if (this.stale(gen)) return { restored: false, claimed: true, subject: row.sid };

    const asStored = (o: (typeof offers)[number]): StoredGroupOffer => ({
      from: o.peerId,
      invite: {
        tcm: 'call.ginvite',
        sid: row.sid,
        cid: o.cid,
        r: [...row.roster],
        sdp: o.sdp,
        vid: o.video,
        exp: o.exp,
      },
      serverTs: o.serverTs,
    });
    // The session as admission sees it, built from the row that survived the
    // kill — the roster the starter asserted, at the epoch this device held.
    const view = {
      sid: row.sid,
      starterId: row.starterId,
      roster: row.roster,
      se: row.se,
      video: row.video,
    };
    const admitted = (offer: (typeof offers)[number]): boolean =>
      admitGroupCallInvite(view, offer.peerId, asStored(offer).invite).verdict === 'join_leg';
    if (!admitted(starter)) {
      // The persisted roster does not name its own starter. Nothing here can
      // be trusted to rebuild a call from, so nothing is.
      await this.deps.native.endCall(row.sid, 'failed_media').catch(() => undefined);
      await this.deps.store.deleteSession(row.sid).catch(() => undefined);
      return { restored: false, claimed: true, subject: row.sid };
    }
    const heldOffers: Record<string, StoredGroupOffer> = {};
    for (const offer of offers) {
      if (offer.cid === starter.cid) continue;
      if (!admitted(offer)) continue;
      heldOffers[offer.peerId] = asStored(offer);
    }
    const starterOffer = asStored(starter);
    this.bumpIncarnationIfIdentityChanged({ sid: row.sid });
    this.state = {
      sid: row.sid,
      starterId: row.starterId,
      selfId,
      roomId: row.roomId,
      roster: row.roster,
      se: row.se,
      held: null,
      video: row.video,
      phase: 'ringing',
      legs: {},
      heldOffers,
      starterOffer,
      announced: [row.starterId],
      // CallKit is ALREADY showing this call — it survived the kill; that is
      // what a cold-launch answer means. Reporting again would be a second
      // CXCall for one conversation.
      callKit: 'reported',
      startedAt: row.startedAt,
      reportId: null,
      answeredAt: null,
      peakConnectedParticipants: 1,
      connectedAt: null,
    };
    // …and this coordinator now OWES its release, exactly as if it had
    // reported it: `callKit: 'reported'` is a claim about the world, and a
    // relock during the restored ring must take that CXCall down with it.
    this.cxCallSid = row.sid;
    // Re-open the ringing leg so the proven 1:1 machinery owns the ring ack
    // and the 60 s ring timer again: without it a peer could hold this phone
    // ringing forever after a restore.
    //
    // NOT ON THE END PATH. `incoming_ringing` emits `call.ringing` as its
    // first act, so a cold decline that opened this leg announced this
    // device's presence to the caller before refusing them — and the ring
    // timer it arms has nothing to time, because the very next input ends the
    // session. The state is restored either way; only the leg-open effect is
    // suppressed, which is the smallest thing that can be.
    if (ring) {
      await this.run(
        {
          type: 'openLegRinging',
          peerId: row.starterId,
          cid: starter.cid,
          offer: starterOffer,
        },
        gen,
      );
      if (this.stale(gen)) return { restored: false, claimed: true, subject: row.sid };
    }
    // The restore writes `this.state` directly rather than through `step`, so
    // the anchor has to be stamped here too — a session rebuilt from SQLite is
    // still a session whose tiles need to know how long they have waited.
    this.syncInvitedAt();
    this.notify();
    return { restored: true, claimed: true, subject: row.sid };
  }

  // --- mute / camera fan-out (the all-or-close-the-leg) --------------------

  /**
   * ALL-OR-CLOSE-THE-LEG. A toggle applies per leg; any leg that reports
   * failure is retried once and then CLOSED (`failed_media`).
   *
   * A microphone you cannot silence toward one participant is a live open mic
   * to them while the UI says muted — this product's worst bug class. Closing that
   * leg is louder and safer than either a partial mute or a UI revert, both of
   * which leave the person believing something false about their own hardware.
   */
  async setMuted(muted: boolean): Promise<LegFanOutcome[]> {
    // THE SESSION THIS PRESS BELONGS TO. A fan is N bridge calls long and a
    // call can end inside any of them.
    const sid = this.sessionSid();
    // THE INTENT FIRST, before the first await. See `mutedIntent`: a leg
    // opened while this fan is walking its snapshot must bind to the mute the
    // person just asked for, and the snapshot cannot contain it.
    this.mutedIntent = muted;
    const outcomes = await this.fanTrack('audio', !muted);
    // …AND THE ACHIEVEMENT IS PUBLISHED ONLY TO THE SESSION THAT EARNED IT
    // (see `sessionSid`). An unconditional write here is how a fan belonging
    // to a call that has already ended put a muted glyph over the NEXT call's
    // live microphone: `mutedIntent` is reset with the rest of the scratch, so
    // the new session's legs are genuinely unmuted and this claim would be
    // false in the one direction that matters.
    if (this.sessionSid() !== sid) return outcomes;
    this.muted = muted;
    this.notify();
    return outcomes;
  }

  async setVideoEnabled(on: boolean): Promise<LegFanOutcome[]> {
    this.cameraOff = !on;
    return this.fanTrack('video', on);
  }

  /**
   * THE LOUDSPEAKER — and DELIBERATELY NOT A FAN-OUT.
   *
   * Group calls ship audio only ("v1 scope, cut to the launch
   * date"), which makes this control load-bearing rather than a convenience: a
   * five-person audio call with no way off the earpiece is the feature reading
   * as broken.
   *
   * WHY IT IS NOT `fanTrack`. Mute and camera fan because they are PER-LEG
   * protocol facts — a microphone this device cannot silence toward one
   * participant is a live open mic to that participant, so the design closes their leg
   * rather than let the UI claim a mute it does not hold. The speaker is not
   * that kind of fact. `setSpeaker(cid, on)` takes a cid and native discards
   * it (see `GroupCallNative.setSpeaker`): every leg already plays out of the
   * one route `RTCAudioSession.sharedInstance()` owns, and the route-change
   * event agrees — `AudioRouteEvent` carries no cid, and its own note says
   * CallKit activates ONE audio session for the device, not one per call.
   *
   * So a fan here would be N identical writes to the same global — and, far
   * worse, all-or-close-the-leg would DROP A PARTICIPANT because an earpiece
   * declined to become a loudspeaker. Nothing about that participant's media
   * is wrong. Ending their call over this device's own output choice would be
   * a larger untruth than the one the fan rule exists to prevent.
   *
   * ONE CALL, ADDRESSED WITH THE SID, because the sid is this session's
   * device-facing identity: the aggregate CXCall (the one CXCall for N
   * legs) that `reportOutgoingCall` and `endCall` already name. The audio
   * session belongs to that CXCall, not to any leg — so even though native
   * ignores the argument, the one this passes is the true handle rather than
   * an arbitrary leg's cid.
   */
  async setSpeakerEnabled(on: boolean): Promise<void> {
    const s = this.state;
    if (!s) return;
    const sid = this.sessionSid();
    try {
      await this.deps.native.setSpeaker(s.sid, on);
    } catch {
      // The route did not change, so nothing may say it did. A button that
      // lights on a rejected bridge call is telling the person their call is
      // coming out of a speaker that it is not coming out of.
      return;
    }
    // PUBLISHED ONLY TO THE SESSION THAT ASKED — `setMuted`'s discipline, at
    // the one-await scale this needs it. A bridge call outlives a hangup, and
    // an unconditional write would light the NEXT call's speaker button over a
    // route that call never chose.
    if (this.sessionSid() !== sid) return;
    this.speakerOn = on;
    this.notify();
  }

  /**
   * Apply one track change to one leg, retried once.
   *
   * The retry is the transient-failure allowance the design names; the VERDICT it
   * returns is the applied one the native adapter passes through, never a
   * resolved promise read as success.
   */
  private async applyTrack(
    kind: 'audio' | 'video',
    cid: string,
    on: boolean,
    gen: number,
  ): Promise<boolean> {
    const apply = async (): Promise<boolean> => {
      try {
        return kind === 'audio'
          ? await this.deps.native.setAudioEnabled(cid, on)
          : await this.deps.native.setVideoEnabled(cid, on);
      } catch {
        return false;
      }
    };
    const first = await apply();
    if (first || this.stale(gen)) return first;
    return apply();
  }

  private async fanTrack(kind: 'audio' | 'video', on: boolean): Promise<LegFanOutcome[]> {
    const gen = this.generation;
    const s = this.state;
    const outcomes: LegFanOutcome[] = [];
    if (!s) return outcomes;
    // THE SESSION THE SNAPSHOT BELONGS TO. Every leg below is one of A's cids;
    // resuming into session B would spend bridge calls on connections that no
    // longer exist and — far worse — reach `closeLeg` with A's cid inside B,
    // putting a `call.end` for a dead call on B's wire.
    const sid = this.sessionSid();
    for (const leg of Object.values(s.legs)) {
      if (leg.phase === 'gone' || leg.phase === 'failed' || leg.phase === 'declined') continue;
      if (this.stale(gen) || this.sessionSid() !== sid) return outcomes;
      const applied = await this.applyTrack(kind, leg.cid, on, gen);
      if (this.stale(gen) || this.sessionSid() !== sid) return outcomes;
      if (applied) {
        outcomes.push({ peerId: leg.peerId, cid: leg.cid, applied: true, closed: false });
        continue;
      }
      // CALLED DIRECTLY RATHER THAN THROUGH `run`, for its ANSWER. `run` is a
      // void effect dispatcher and this is the one site that needs the close's
      // verdict rather than its intent — the peer may have abandoned this cid
      // and re-offered while the apply above was awaiting, in which case the
      // cid guard inside `closeLeg` is right to do nothing and this fan closed
      // nobody. `run`'s only work for this effect is the call below plus a
      // stale check the loop has already made.
      const closed = await this.closeLeg(leg.peerId, leg.cid, 'failed_media', true, gen);
      // RECORDED AS THIS FAN'S DOING, which is the whole point of returning
      // anything: the screen names these people and nobody else, so an
      // unrelated hangup landing in the same second is not blamed on a button
      // — and a close that never happened names nobody at all.
      outcomes.push({ peerId: leg.peerId, cid: leg.cid, applied: false, closed });
    }
    return outcomes;
  }

  /**
   * BIND A NEWLY OPENED LEG TO THE SESSION'S CURRENT TRACK STATE.
   *
   * Session mute is STATE, not an event. `setMuted` fans across the legs that
   * exist and stops there, so every path that opens a leg afterwards has to
   * re-ask — a dial from `addParticipant`, a re-offer's dial, and the
   * answer that adopts a member's fresh offer. Called after the leg's media
   * exists, because there is no track to silence before it does.
   *
   * ONLY THE DEVIATIONS. A fresh leg's tracks are enabled by construction, so
   * "unmuted" and "camera on" need no call at all; what needs one is a track
   * the session has turned OFF.
   *
   * ALL-OR-CLOSE-THE-LEG, unchanged: a leg that cannot be silenced is closed,
   * exactly as one the fan could not silence is. A late leg is not a
   * second-class one, and the alternative is the open mic the rule exists
   * against.
   */
  private async bindLegTracks(peerId: string, cid: string, gen: number): Promise<void> {
    const kinds: ('audio' | 'video')[] = [];
    if (this.mutedIntent) kinds.push('audio');
    // Asked of the SESSION's own video flag as well: an audio call has no
    // camera track, and `setVideoEnabled` on one can only ever answer false —
    // which would close a healthy leg for failing to turn off something that
    // was never on.
    if (this.cameraOff && this.state?.video === true) kinds.push('video');
    for (const kind of kinds) {
      if (this.stale(gen)) return;
      const applied = await this.applyTrack(kind, cid, false, gen);
      if (this.stale(gen)) return;
      if (applied) continue;
      await this.run(
        { type: 'closeLeg', peerId, cid, reason: 'failed_media', announce: true },
        gen,
      );
      return;
    }
  }

  // --- the step -------------------------------------------------------------

  /**
   * Chain one unit of session work onto the queue.
   *
   * `restore()` goes through here too, which is the point: a cold launch
   * flushes every CallKit event CallKit raised before JS existed, each handler
   * starts its own async task, and a restore that ran outside this queue let
   * two of them race the non-transactional select-and-delete of the session's
   * stored offers.
   */
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * `dispatch`, FENCED WHERE THE INPUT RUNS.
   *
   * A press is not an envelope: it is made against what is on the screen, and
   * `decline`, `hangup` and `localAnswer` name no session at all. Checking the
   * session at enqueue time leaves the whole width of the queue open — one
   * long-running effect on session A is enough for a glare winner queued
   * behind it to install before the press ahead of it executes, and the press
   * then demolishes the SUCCESSOR. That is not the demolition `dispose()`
   * owns and must be allowed to finish: the stale input never began tearing A
   * down, it tore B down first.
   *
   * So the token travels with the input and is compared in the execution slot,
   * which is the only place the answer cannot go stale between the asking and
   * the acting. Null is a value and not a wildcard, exactly as everywhere else
   * the session fence is read.
   */
  private dispatchIfSession(input: GroupSessionInput, tok: string | null): Promise<boolean> {
    return this.dispatch(input, { tok });
  }

  private dispatch(
    input: GroupSessionInput,
    fence?: { tok: string | null },
  ): Promise<boolean> {
    // Captured at ENQUEUE time, not at execution time: an input queued before
    // a relock must not run after it. `messaging.ts` captures at the same
    // point, for the same reason.
    const gen = this.generation;
    return this.enqueue(async () => {
      if (this.stale(gen)) return false;
      // …and the SESSION fence the other way round: captured at the press and
      // read here, in the slot (see `dispatchIfSession`).
      if (fence && this.sessionSid() !== fence.tok) return false;
      await this.step(input, gen);
      return true;
    }).catch((err: unknown) => {
      // Name only — never the message, which is where a sid, a cid or an
      // SDP would be if one leaked into it.
      console.warn(`[groupcall] input ${input.type} failed: ${errorName(err)}`);
      // Once `step` began, the group machine owns the input even if one of its
      // effects failed. Falling through here would let the 1:1 machine act on
      // the same native press as well.
      return true;
    });
  }

  private async step(input: GroupSessionInput, gen: number): Promise<void> {
    const { state, effects } = groupSessionReducer(this.state, input, this.deps.now());
    const ended = this.state !== null && state === null;
    // The release effects run AFTER the reducer has collapsed the state to
    // null (a zombie session kept alive to watch its own teardown would
    // re-open every admission question for no safety), so the last state is
    // kept for exactly as long as those effects need to name it.
    if (this.state) this.lastSession = this.state;
    this.bumpIncarnationIfIdentityChanged(state);
    this.state = state;
    // CLAIMED AT EMISSION, not at execution (see `owedSessionRows`). The whole
    // failure this ledger answers is an effect the fence never let run, so a
    // claim made inside `run` would be made only on the paths that did not
    // need it.
    for (const effect of effects) {
      if (effect.type === 'closeSessionRow') this.owedSessionRows.add(effect.sid);
    }
    // Stamped from the state the reducer just produced and BEFORE the notify
    // that publishes it, so the first view a leg appears in already carries
    // its anchor. A screen that saw `invitedAt: null` on the opening frame
    // would have exactly the gap the anchor exists to close.
    this.syncInvitedAt();
    this.notify();
    for (const effect of effects) {
      // THE FENCE, checked before every effect and again after the one that
      // just awaited: disposal is what stands between a relocked phone and a
      // half-run effect list that reports a CXCall and opens a microphone.
      if (this.stale(gen)) return;
      try {
        await this.run(effect, gen);
      } catch (err) {
        // One failed effect must not strand a session half-torn-down with the
        // rest of its teardown unrun — the `CallService` rule, one layer up.
        console.warn(`[groupcall] effect ${effect.type} failed: ${errorName(err)}`);
      }
      if (this.stale(gen)) return;
      // SESSION GLARE, mid-step. `supersede` emits the loser's whole teardown
      // and then the winner's fresh ring inside ONE reducer output, so the
      // boundary between two sessions falls HERE — after the loser's row is
      // closed and before the winner's first effect opens a leg. Reset the
      // scratch on that boundary, or the loser's leg services, its re-offer
      // timers, its mute flag and its log-row counter all cross into a call
      // they were never part of: a phone that muted the losing call came back
      // "muted" in the winning one against a live microphone.
      if (
        effect.type === 'closeSessionRow' &&
        this.state !== null &&
        this.state.sid !== effect.sid
      ) {
        this.resetSessionScratch();
        // AND THE WINNER IS RE-STAMPED AND RE-PUBLISHED ON THE SPOT.
        //
        // `syncInvitedAt`/`notify` ran at the top of this step — with the
        // winner already in `state` and the LOSER's anchors still in the map —
        // and the reset above then cleared the map without telling anyone. So
        // the winner's tiles were published carrying the losing call's "waiting
        // since" and afterwards carried none at all, until some later input
        // happened to re-stamp them. Both halves are wrong in the same
        // direction: a fresh ring that reads "May be offline", then a ring that
        // can never say it.
        //
        // Here rather than inside `resetSessionScratch`, because that method is
        // also the ORDINARY end's — where the state is null, there is nothing
        // to stamp, and the notify that matters is the release's.
        this.syncInvitedAt();
        this.notify();
      }
    }
    if (this.stale(gen)) return;
    if (ended) {
      this.resetSessionScratch();
      // THE SESSION'S RELAY VERDICT GOES WITH THE SESSION, and HERE
      // rather than inside `resetSessionScratch`, which is also the GLARE
      // boundary's: at that boundary the winner's own admission has already
      // decided its policy (`handleInvite` runs before the reducer emits
      // `supersede`), and releasing there would drop a verdict that belongs to
      // the call now ringing. `ended` is false at that boundary — the reducer
      // hands back the winner, not null — which is exactly the distinction.
      this.deps.releaseRelayPolicy?.();
    } else this.releaseDepartedLegs();
  }

  /**
   * Release the `CallService` of anyone the roster no longer names, once
   * their leg is finished.
   *
   * A session's cost must be bounded by its LIVE roster, not by every account
   * that has ever been in it: starter-authorised remove/add churn keeps the
   * live set under the cap while the unique-peer count grows without limit,
   * and every departed peer's service, cid, end reason and skip note sat
   * resident until the whole session ended. Terminal-only, because a service
   * still winding down owns the peer connection its own teardown is closing.
   */
  private releaseDepartedLegs(): void {
    const s = this.state;
    if (!s) return;
    for (const peerId of [...this.legs.keys()]) {
      if (s.roster.includes(peerId)) continue;
      const leg = s.legs[peerId];
      if (leg && !TERMINAL_LEG_PHASES.has(leg.phase)) continue;
      const service = this.legs.get(peerId);
      // AND THE SERVICE ITSELF MUST BE DONE, not merely the session's opinion
      // of it. The check above reads `LegPhase`, which the reducer sets from a
      // `legStateChanged` the service emits BEFORE running its own teardown
      // effects — so a leg could be 'left' in the session while its service
      // was still awaiting `closePeerConnection` and its history row.
      //
      // BUT NOT FOREVER. This wait had no second arm, so a teardown that never
      // settles was indistinguishable from one that is nearly done, and the
      // residency this whole method exists to bound became unbounded again.
      // The deadline below is the answer, and it is deliberately armed rather
      // than checked: `releaseDepartedLegs` runs only at the end of a step, and
      // a session whose last input has already arrived would never look again.
      if (service && service.current.call !== null) {
        this.armDepartedDeadline(peerId, service.current.call.cid);
        continue;
      }
      this.releaseLeg(peerId);
    }
  }

  /** One shot per departed peer: re-arming on every later step would push the
   * deadline out indefinitely for exactly the leg that is not making progress. */
  private armDepartedDeadline(peerId: string, cid: string): void {
    if (this.departedDeadlines.has(peerId)) return;
    const gen = this.generation;
    this.departedDeadlines.set(peerId, {
      cid,
      timer: setTimeout(() => {
        this.departedDeadlines.delete(peerId);
        // `dispose()` clears these timers, so this is belt and braces — but a
        // forced release reaches native media, and the fence is cheap.
        if (this.stale(gen)) return;
        // AND THE SAME FENCE ONE SCALE DOWN. Ten seconds is long
        // enough for the peer to be removed, re-added and dialled again, and
        // the leg standing here then is the RECOVERY — a live peer connection
        // on a cid this timer was never armed against. `ensureLeg` already
        // cancels on the way in; this is the arm that survives an ordering
        // where the timer was already queued when the re-dial landed.
        //
        // A null current cid is NOT recovery: it is the stuck leg having
        // finished its teardown with nothing left to notice (the residency
        // this deadline exists to bound), so it still releases.
        const current = this.legs.get(peerId)?.current.call?.cid ?? null;
        if (current !== null && current !== cid) return;
        this.releaseLeg(peerId);
      }, DEPARTED_LEG_TEARDOWN_MS),
    });
  }

  /**
   * Drop one leg's scratch and dispose its service.
   *
   * The forced path and the earned path are the SAME path, which is the point:
   * `CallService.dispose()` closes the cid its reducer still owns (`service.ts`),
   * so a leg released on the deadline takes its peer connection with
   * it and a leg released because it finished costs no bridge call at all. A
   * separate "force" branch here would be a second demolition to keep correct.
   */
  private releaseLeg(peerId: string): void {
    this.legs.get(peerId)?.dispose();
    this.legs.delete(peerId);
    this.legCid.delete(peerId);
    this.legEndReason.delete(peerId);
    this.skipped.delete(peerId);
    const timer = this.reofferTimers.get(peerId);
    if (timer) {
      clearTimeout(timer);
      this.reofferTimers.delete(peerId);
    }
    this.clearDepartedDeadline(peerId);
  }

  /** Disarm a peer's departed deadline, wherever the reason came from: the leg
   * was released, or the peer is back and a new leg is being opened for them
   * (`ensureLeg`). */
  private clearDepartedDeadline(peerId: string): void {
    const deadline = this.departedDeadlines.get(peerId);
    if (deadline) {
      clearTimeout(deadline.timer);
      this.departedDeadlines.delete(peerId);
    }
  }

  /**
   * Stamp — once — when each rostered peer started waiting with nothing back.
   *
   * Walks the ROSTER and derives the phase the way `view` does, because those
   * two must agree: a roster member this device does not offer to (the offer rule gives
   * their leg to somebody else) has no `legs` entry and reads `inviting`, and
   * a stamp keyed off `legs` alone would leave that tile counting from nothing
   * forever. Once per ATTEMPT rather than once per peer (see `legInvitedAt`):
   * re-stamping on every step would reset the clock on exactly the leg that is
   * not making progress, and never re-stamping hands a brand-new offer the
   * wait of the one it replaced.
   */
  private syncInvitedAt(): void {
    const s = this.state;
    if (!s) {
      this.legInvitedAt.clear();
      return;
    }
    const at = this.deps.now();
    for (const peerId of s.roster) {
      if (peerId === s.selfId) continue;
      const phase = s.legs[peerId]?.phase ?? 'inviting';
      if (phase === 'inviting') {
        const cid = this.attemptCid(s, peerId);
        const held = this.legInvitedAt.get(peerId);
        // ONCE PER ATTEMPT, not once per peer. `held.cid !== cid` is a NEW
        // offer for the same waiting tile — a ringing re-offer, or a glare
        // winner that happens to name the same person — and it starts its own
        // eight seconds. Re-stamping on the same cid would reset the clock on
        // exactly the leg that is not making progress; not re-stamping on a
        // new one hands a fresh attempt a dead attempt's wait.
        //
        // A cid of null is a peer this device does not offer to (the offer rule gives
        // their leg to somebody else) and never re-stamps: there is no
        // attempt to notice changing, and treating "unknown" as "new" would
        // reset that tile's clock on every step.
        if (!held) this.legInvitedAt.set(peerId, { cid, at });
        else if (cid !== null && held.cid !== cid) this.legInvitedAt.set(peerId, { cid, at });
      } else {
        // Rang, connected or died: no longer waiting. Cleared so a
        // re-offer starts its own eight seconds.
        this.legInvitedAt.delete(peerId);
      }
    }
    for (const peerId of [...this.legInvitedAt.keys()]) {
      if (!s.roster.includes(peerId)) this.legInvitedAt.delete(peerId);
    }
  }

  /**
   * WHICH ATTEMPT A WAITING TILE IS WAITING ON.
   *
   * The same three places the session keeps a cid for a peer, in the order
   * `view` derives its phase from: the live leg if there is one, then the
   * ringing starter's offer, then a held one. Pre-answer there is no `legs`
   * entry for anybody — the ring is a service, not a summary — which is
   * precisely why a peer-keyed anchor could not see a ringing re-offer.
   */
  private attemptCid(s: GroupSessionState, peerId: string): string | null {
    const leg = s.legs[peerId];
    if (leg) return leg.cid;
    if (s.starterOffer?.from === peerId) return s.starterOffer.invite.cid;
    return s.heldOffers[peerId]?.invite.cid ?? null;
  }

  private notify(): void {
    this.deps.onChange?.(this.view);
  }

  // --- effects --------------------------------------------------------------

  private async run(effect: SessionEffect, gen: number): Promise<void> {
    // Nothing below may start on a generation that is already gone: `run` is
    // reached from `step`, from `restore` and from the mute fan-out, and each
    // of those can be suspended at the moment `dispose()` lands.
    if (this.stale(gen)) return;
    switch (effect.type) {
      case 'openGroupCallMetric':
        await this.deps.metrics?.open({
          reportId: effect.reportId, localId: effect.localId, scope: 'group',
          media: effect.media, startedAt: effect.startedAt,
        });
        break;

      case 'answerGroupCallMetric':
        await this.deps.metrics?.answered(effect.localId, effect.answeredAt);
        break;

      case 'connectGroupCallMetric':
        await this.deps.metrics?.connected(effect.localId, effect.connectedAt);
        break;

      case 'peakGroupCallMetric':
        await this.deps.metrics?.peak(effect.localId, effect.participants);
        break;

      case 'finalizeGroupCallMetric':
        await this.deps.metrics?.finalize(effect.localId, effect.reason, effect.endedAt);
        break;

      case 'discardGroupCallMetric':
        await this.deps.metrics?.discard(effect.localId);
        break;

      case 'openLegDial':
        await this.openLegDial(effect.peerId, effect.cid, gen);
        break;

      case 'openLegRinging': {
        // The starter's leg enters the 1:1 machine's OWN `incoming_ringing`
        // state, which emits `call.ringing`, arms the 60 s ring timer and
        // emits no `createAnswer` — so rule 25 holds: no camera before the
        // human answers.
        const service = this.ensureLeg(effect.peerId);
        await service.dispatch(this.offerEvent(effect.peerId, effect.offer));
        break;
      }

      case 'openLegAnswer': {
        const service = this.ensureLeg(effect.peerId);
        if (service.current.call?.cid !== effect.cid) {
          await service.dispatch(this.offerEvent(effect.peerId, effect.offer));
          if (this.stale(gen)) return;
        }
        // THE one effect that reaches `createAnswer`, and it is emitted only
        // after the human answered the session.
        await service.dispatch({ type: 'localAccept', video: this.state?.video ?? false });
        if (this.stale(gen)) return;
        // `createAnswer` is where this leg's media comes into existence, so
        // this is the first moment its tracks can be bound to a mute the
        // session is already under.
        await this.bindLegTracks(effect.peerId, effect.cid, gen);
        break;
      }

      case 'closeLeg':
        await this.closeLeg(effect.peerId, effect.cid, effect.reason, effect.announce, gen);
        break;

      case 'sendRosterDelta':
        for (const to of effect.to) {
          if (this.stale(gen)) return;
          await this.send(to, effect.env, effect.urgent);
        }
        break;

      case 'dismissRing':
        // The reducer's own refusals that send nothing (an over-cap video
        // roster, a glare winner past its life): the placeholder they arrived
        // behind is a full-screen ring with nothing left to end it.
        await this.dismissPlaceholder(effect.peerId, 'declined');
        break;

      case 'reportGroupIncoming': {
        // The CXCall is keyed by `sid` (departure 8): `CallKitCenter.uuidByCid`
        // maps an arbitrary STRING to a UUID, so the session reports itself
        // and no native mapping change is needed. The name crosses this seam
        // only when the database knows one — an empty string means "you
        // decide", and the native side keeps its honest placeholder rather
        // than announcing a raw ULID. `displayNameFor` never returns '' on
        // success — its fallback IS the shortened ULID — so the promise above
        // needs the 1:1 seam's known-name filter (service.ts's `known`
        // check), or the ID it promises never to announce is exactly what
        // rings full-screen for a starter with no stored name.
        const resolved = await this.deps.displayNameFor(effect.starterId).catch(() => '');
        const name = resolved !== shortId(effect.starterId) ? resolved : '';
        // A name read is a database read, and a relock closes the database.
        // Reporting here after disposal is a full-screen incoming call on a
        // phone that has already locked.
        if (this.stale(gen)) return;
        // CLAIMED BEFORE THE BRIDGE CALL, not after: a `dispose()` landing
        // inside the report must find a sid to release, and bridge calls
        // reach the native side in issue order, so the release it fires
        // arrives behind the report it is releasing.
        this.cxCallSid = effect.sid;
        // AND THE RING IS ATTRIBUTED TO THE SESSION THAT IS RINGING (see
        // `reportedRingToken`). Taken here rather than at emission because
        // `step` installs the state before it runs a single effect, so this
        // is already the ringing session's token — and taken after the fence
        // above, because a ring that was never reported is not a ring a press
        // may be about.
        this.reportedRingToken = this.sessionSid();
        await this.deps.native.reportIncomingCall(
          effect.sid,
          effect.starterId,
          name,
          name,
          effect.hasVideo,
        );
        break;
      }

      case 'reportGroupOutgoing': {
        const s = this.state;
        // The handle is the call's name on the lock screen and dynamic
        // island — the one surface GroupCallScreen's header cannot reach.
        // The room's local name when the session belongs to a room, else the
        // KNOWN callee names in the header's own idiom ("Ana and 2 others"),
        // else a plain noun. Never a ULID (the incoming doctrine), and
        // never selfId — my own name is not who the call is with. Unlike the
        // incoming paths, `reportOutgoingCall` has no native mirror or
        // placeholder, so the last-resort constant must be supplied HERE:
        // an empty handle renders blank.
        let name = '';
        if (s?.roomId) {
          name = (await this.deps.roomNameFor?.(s.roomId).catch(() => '')) ?? '';
          // The no-raw-id belt behind the dep's own guard: a stored "name" that is
          // the room's id in disguise must not become the one surface that
          // renders a room ULID. Checked here too because the dep is
          // injected — the CLI or a future wiring may not carry the guard.
          if (name === s.roomId) name = '';
        }
        if (!name && s) {
          const others = s.roster.filter(id => id !== s.selfId);
          const known: string[] = [];
          for (const id of others) {
            const resolved = await this.deps.displayNameFor(id).catch(() => '');
            if (resolved && resolved !== shortId(id)) known.push(resolved);
          }
          // Named from the known, counted from the roster: "Ana and 2
          // others" must count the call's seats, not this phone's address
          // book, or the label understates who is on the call.
          name =
            known.length === 0
              ? ''
              : others.length === 1
                ? known[0]!
                : others.length === 2 && known.length === 2
                  ? `${known[0]} and ${known[1]}`
                  : `${known[0]} and ${others.length - 1} ${
                      others.length - 1 === 1 ? 'other' : 'others'
                    }`;
        }
        if (!name) name = 'Group call';
        if (this.stale(gen)) return;
        this.cxCallSid = effect.sid;
        // `false`, and not `view.video`: this reports the SESSION to CallKit,
        // and a group session ships audio only (the video ceiling is not
        // implemented — the tiles carry no video surface). Claiming video
        // here would put the wrong kind in Recents and configure the session
        // for a camera nothing is sending.
        await this.deps.native.reportOutgoingCall(effect.sid, name, false);
        break;
      }

      case 'reportGroupConnected':
        await this.deps.native.reportOutgoingConnected(effect.sid);
        break;

      case 'releaseGroupCall':
        // The ledger is surrendered BEFORE the bridge call, so a `dispose()`
        // landing inside it does not release the same CXCall a second time.
        // Rule 26 counts a second CXCall for one conversation as a release
        // blocker whichever path it arrives from.
        if (this.cxCallSid === effect.sid) this.cxCallSid = null;
        await this.deps.native.endCall(effect.sid, effect.reason).catch(() => undefined);
        if (this.stale(gen)) return;
        // THE AGGREGATE ROW, and only when no leg wrote its own: a session
        // that never opened a leg (an expired invite, a ring the person
        // declined before any service existed) still happened, and the person
        // deserves to see it. Per-leg rows are the leg services'.
        if (this.legLogRows === 0 && this.state === null) {
          const s = this.lastSession;
          if (s) {
            await this.writeAggregateRow(
              s.sid,
              s.starterId,
              s.starterId === s.selfId ? 'out' : 'in',
              effect.reason,
              s.video,
              effect.reason === 'timeout' ||
                effect.reason === 'cancelled' ||
                effect.reason === 'expired',
              s.roomId,
            );
          }
        }
        break;

      case 'writeSessionRow': {
        const s = this.state;
        if (!s) break;
        await this.deps.store.saveSession({
          sid: s.sid,
          roomId: s.roomId,
          starterId: s.starterId,
          roster: [...s.roster],
          se: s.se,
          video: s.video,
          startedAt: s.startedAt,
        });
        break;
      }

      case 'closeSessionRow': {
        // CLAIMED HERE, synchronously, before the first await — the whole
        // window is the one in which a `dispose()` cannot tell an abandoned
        // debt from one already being paid (see `deletingNow`).
        this.deletingNow.add(effect.sid);
        try {
          // `effect.sid`, never `this.state.sid`: on session glare the state is
          // ALREADY the winner by the time this runs, so reading it deleted the
          // winner's row and left the loser's — a persisted roster outliving
          // the call it belonged to.
          await this.deps.store.deleteSession(effect.sid).catch(() => undefined);
          // And the offers with it. A session's stored invites hold peer ids,
          // DTLS fingerprints and candidate addresses; the boot prune bounds
          // them by the ring TTL, which on a phone that is never force-quit is
          // no bound at all. NOT fenced: deleting stored SDPs is the one thing
          // a disposal can only ever want more of, and the row is already gone.
          await this.deps.store.deleteOffersForSession(effect.sid).catch(() => undefined);
        } finally {
          // Released in a `finally` and not after the awaits: the claim is what
          // makes a disposal stand down, so a store that throws past the
          // `catch` above must not leave a sid claimed by nobody — that would
          // be the leak this whole ledger exists against, wearing the fix's
          // clothes.
          this.deletingNow.delete(effect.sid);
        }
        // SURRENDERED only now, with both deletes behind us. Handing it back
        // any earlier — at the top of this case, or between the two deletes —
        // would hand back a debt that is still outstanding, which is the exact
        // mistake the CXCall ledger next door is shaped to avoid.
        this.owedSessionRows.delete(effect.sid);
        break;
      }

      case 'startReofferTimer': {
        // Idempotent per peer: a terminal report can reach the reducer twice
        // (once from the close this coordinator drove, once from the leg
        // service finishing its teardown), and two timers would mean two
        // dials against a two-retry budget.
        const existing = this.reofferTimers.get(effect.peerId);
        if (existing) clearTimeout(existing);
        const peerId = effect.peerId;
        // THE SESSION THAT ARMED IT, captured at ARM time because the effect
        // belongs to the session that emitted it and to no other. Once the
        // callback below deletes its own handle, `clearTimeout` can no longer
        // reach it from any teardown, and this token is the only thing left
        // standing between a dead session's timer and a live session's
        // two-retry budget: A ends the ordinary way, B installs with that same
        // peer waiting on a repair, and A's timer dials a leg B never
        // scheduled — out of B's budget, on a cid B did not choose.
        const tok = this.sessionSid();
        this.reofferTimers.set(
          peerId,
          setTimeout(() => {
            this.reofferTimers.delete(peerId);
            // A FRESH cid per re-offer: reusing the dead leg's would ask
            // the peer to revive a call their own machine has already torn
            // down, and glare compares cids.
            void (async () => {
              if (this.stale(gen) || this.sessionSid() !== tok) return;
              const cid = await this.deps.mintId();
              // The mint crosses the native bridge for entropy; a relock can
              // land inside it, and `dispatch` would otherwise re-arm a dial.
              if (this.stale(gen) || this.sessionSid() !== tok) return;
              void this.dispatch({ type: 'reofferTimer', peerId, cid });
            })();
          }, effect.ms),
        );
        break;
      }

      case 'legUnreachable':
        // Nothing to do beyond the state change the reducer already made:
        // the tile reads `LegPhase` and the copy is the call screen's. Kept as an effect
        // so a future surface (a chip, a retry affordance) has a hook.
        break;
    }
  }

  /** The last session state seen, so the release effects — which run after
   * the reducer has already collapsed the state to null — can still name the
   * session they are closing. */
  private lastSession: GroupSessionState | null = null;

  private offerEvent(
    peerId: string,
    offer: StoredGroupOffer,
  ): Parameters<CallService['dispatch']>[0] {
    return {
      type: 'offerReceived',
      cid: offer.invite.cid,
      peerId,
      sdp: offer.invite.sdp,
      video: offer.invite.vid,
      exp: offer.invite.exp,
      serverTs: offer.serverTs,
    };
  }

  /**
   * Open an outgoing leg — but never to someone this device may not call.
   *
   * The gate is HERE, at the dial site, and not once at session start:
   * re-offers and a late joiner's arrival both reach this same effect, so a
   * check anywhere else would be a check with holes. A blocked or
   * identity-changed peer's leg is skipped LOUDLY — the tile names them and
   * every other leg proceeds — which is the room decision applied to calls: the naive 1:1 refusal would kill the whole
   * session over one member.
   */
  private async openLegDial(peerId: string, cid: string, gen: number): Promise<void> {
    const permission = await this.deps.mayCall?.(peerId).catch(() => undefined);
    // The permission answer is two database reads. A dial that resumed past a
    // relock would create a `CallService`, a peer connection and a ginvite.
    if (this.stale(gen)) return;
    if (permission && !permission.allowed) {
      this.skipped.set(peerId, permission.reason === 'identity_changed' ? 'identity_changed' : 'blocked');
      // Reported as an ordinary terminal leg so the session's own release
      // arithmetic stays in one place — the reducer counts terminal legs, and
      // a leg that was never opened is as terminal as one that failed.
      void this.dispatch({
        type: 'legStateChanged',
        peerId,
        cid,
        name: 'ending',
        reason: 'blocked',
      });
      return;
    }
    this.skipped.delete(peerId);
    // The design AT THE DIAL SITE, which is where a session that GROWS keeps its
    // promise. The roster-wide decision at the session's start cannot know
    // about somebody who arrives ten minutes in, and every way one can arrive
    // — the starter's Add, another member's `gjoin` admitted as a roster
    // delta, a re-offer to a peer who never came up — reaches this one
    // effect. The `mayCall` gate above is here for exactly the same reason
    // ("a check anywhere else would be a check with holes").
    //
    // AND IT CAN BE HONOURED, which is the part that is not obvious with a
    // process-wide knob and connections already open. `configure` does not
    // touch a live `RTCPeerConnection`; the native module stores the policy
    // and `makeCall` reads it when a connection is BUILT. So raising the
    // session's answer here relays the leg that is about to be built — the
    // newcomer's — while the incumbents' connections keep the policy they were
    // built under, which is right: they already have whatever address they
    // were going to get, and the newcomer never does. It only ever raises
    // (`relayForThisSession` is monotone), so no leg opened later than this
    // one can be weakened by it either.
    await this.deps.applyRelayPolicy?.([peerId]);
    // Two rows read per peer, and a relock lands in a database read as easily
    // as in the permission one above.
    if (this.stale(gen)) return;
    const service = this.ensureLeg(peerId);
    await service.dispatch({
      type: 'placeCall',
      cid,
      peerId,
      video: this.state?.video ?? false,
      reportId: null,
    });
    if (this.stale(gen)) return;
    // `placeCall` runs `createOffer`, which is where this leg's tracks are
    // born — enabled, whatever the session is currently under. Every dial
    // reaches here: `addParticipant`'s, answer-time offers, and the
    // re-offer. That is why the binding is at the dial site and not at the one
    // place a participant happens to be added.
    await this.bindLegTracks(peerId, cid, gen);
  }

  /**
   * Close one leg, and SAY WHETHER IT CLOSED.
   *
   * The cid guard at the bottom has always been right: a peer who re-offered
   * is running a different cid by now, and ending their live leg because an
   * older one failed would drop somebody who is in the call. What was missing
   * is that the guard's verdict never left this function, so `fanTrack` — the
   * one caller whose answer a person reads — reported the intent instead.
   *
   * `true` means a leg on that cid is now down, or there was no service left
   * to take down and the announce above was the whole close (a held offer that
   * never had one). `false` means this call changed nothing: either
   * the fence stopped it, or the peer had already moved to another cid.
   */
  private async closeLeg(
    peerId: string,
    cid: string,
    reason: CallEndReason,
    announce: boolean,
    gen: number,
  ): Promise<boolean> {
    if (announce) {
      // Sent by the COORDINATOR rather than by the leg, which is what lets a
      // held offer that never had a service still get its refusal on the wire
      // — and what lets a close carry a reason the 1:1 machine has
      // no local event for (`busy`, `glare_lost`).
      await this.send(peerId, { tcm: 'call.end', cid, r: reason }, true).catch(() => undefined);
      if (this.stale(gen)) return false;
    }
    if (reason === 'busy') {
      // A busy close is the reducer REFUSING an invite (`inviteWhileLive`),
      // which is the one close that answers a ring rather than ending a leg
      // — and a ring arrives behind a VoIP placeholder. The caller has been
      // told; the full-screen ring in front of it has nothing left to end it.
      await this.dismissPlaceholder(peerId, 'declined');
      if (this.stale(gen)) return false;
    }
    const service = this.legs.get(peerId);
    // THE (peer, cid) CHECK — the session fence at leg scale. A service whose
    // reducer has moved to another cid belongs to a leg this close was never
    // about.
    if (service && service.current.call?.cid !== cid) return false;
    if (service) {
      // `endReceived` tears down without announcing — the frame above is the
      // announcement — and still writes the leg's own history row.
      await service.dispatch({ type: 'endReceived', cid, reason });
    }
    return true;
  }

  // --- leg services ---------------------------------------------------------

  private ensureLeg(peerId: string): CallService {
    // THE PEER IS BACK. Every path into this method is a new leg
    // being opened for `peerId` — a dial, a ring, an answer — so any deadline
    // armed while they were off the roster is now aimed at a call that is being
    // replaced rather than one that is stuck. Disarmed HERE and not in
    // `releaseDepartedLegs`, which skips a re-added peer before it ever looks at
    // a timer. `releaseDepartedLegs` re-arms if they depart again.
    this.clearDepartedDeadline(peerId);
    const existing = this.legs.get(peerId);
    if (existing) return existing;
    /**
     * THE FENCE, THREADED DOWN ONE LAYER.
     *
     * `openLegDial`, `openLegRinging` and `openLegAnswer` each await an
     * ENTIRE `CallService.dispatch()`. That is a second effect loop, with its
     * own awaits, running below the coordinator's fence and invisible to it —
     * so a leg suspended in `createOffer` when the relock lands resumes,
     * reaches its `sendEnvelope`, and calls back into `legSend`. `legSend`
     * used to read `this.generation` at the moment the frame was composed,
     * which by then was the NEW one: the leg walked through the fence
     * carrying a real SDP, and because the session was gone `legSend` no
     * longer recognised the frame as a leg offer and put a bare `call.offer`
     * on the wire — a 1:1 call placed by a workspace that no longer existed.
     *
     * Captured HERE, at leg creation, because that is the moment the
     * coordinator decides this leg belongs to this generation. Nothing the
     * service does afterwards can re-read its way out of it.
     *
     * The other half is `CallService.dispose()`, which now stops the loop
     * itself (`service.ts`) — this is the backstop for a frame already in
     * flight when it does.
     */
    const gen = this.generation;
    const tok = this.sessionSid();
    const service = new CallService({
      native: this.deps.native,
      transport: {
        sendCallEnvelope: (to, envelope, opts) =>
          this.legSend(peerId, to, envelope, opts, gen, tok),
      },
      writeLog: async row => {
        this.legLogRows += 1;
        const s = this.state ?? this.lastSession;
        await this.deps.store.writeLog({
          ...row,
          sessionId: s?.sid ?? null,
          roomId: s?.roomId ?? null,
        });
      },
      displayNameFor: id => this.deps.displayNameFor(id),
      now: () => this.deps.now(),
      // Group legs share the session's writer so their explicitly-null
      // authority is enforced at the real CallService boundary too.
      metrics: this.deps.metrics,
      // The seam. The four CallKit effects are stripped and DISCARDED —
      // the aggregate is derived from lifecycle, so a stripped effect carries
      // no information the session does not already hold. The
      // terminal reason is harvested on the way past, because it exists
      // nowhere else in the leg's output.
      filterEffects: effects => {
        for (const effect of effects) {
          if (effect.type === 'endCallKit') this.legEndReason.set(peerId, effect.reason);
        }
        return effects.filter(e => !CALLKIT_EFFECTS.has(e.type));
      },
      onStateChange: state => this.onLegState(peerId, state),
    });
    this.legs.set(peerId, service);
    return service;
  }

  /**
   * A leg's outbound frame.
   *
   * `call.offer` becomes `call.ginvite`: the ginvite IS the leg offer (the
   * shipped schema carries `sdp`), plus the session binding and the roster
   * this device asserts. Everything else — answer, ICE, ringing, media,
   * restart, end — travels as the ordinary 1:1 kind it already is, which is
   * why no leg needed a new envelope and why the CLI's 1:1 gate still
   * describes every leg.
   */
  private async legSend(
    peerId: string,
    to: string,
    envelope: CallEnvelope,
    opts: { urgent: boolean },
    gen: number,
    tok: string | null,
  ): Promise<void> {
    // The leg's generation AND session, captured when the leg was created
    // (`ensureLeg`) — never the coordinator's clocks at composition time.
    // Glare installs B before A's services finish tearing down; re-reading the
    // token here gave A's late timeout B's incarnation and let its empty push
    // mirror paint B's healthy fresh leg "Couldn't reach".
    if (this.stale(gen)) return;
    const s = this.state;
    if (envelope.tcm === 'call.offer' && s) {
      await this.send(
        to,
        {
          tcm: 'call.ginvite',
          sid: s.sid,
          cid: envelope.cid,
          r: [...s.roster],
          sdp: envelope.sdp,
          vid: envelope.vid,
          exp: envelope.exp,
        },
        true,
        peerId,
        gen,
        tok,
      );
      return;
    }
    await this.send(to, envelope, opts.urgent, peerId, gen, tok);
  }

  private onLegState(peerId: string, state: CallState): void {
    const cid = state.call?.cid ?? this.legCid.get(peerId);
    if (state.call?.cid) this.legCid.set(peerId, state.call.cid);
    if (!cid) return;
    const reason = state.name === 'ending' ? this.legEndReason.get(peerId) : undefined;
    void this.dispatch({
      type: 'legStateChanged',
      peerId,
      cid,
      name: state.name,
      ...(state.call?.answeredAt != null ? { answeredAt: state.call.answeredAt } : {}),
      ...(reason ? { reason } : {}),
    });
  }

  // --- sending, paced --------------------------------------------------

  /**
   * Every group-call frame leaves through here, and through ONE bucket.
   *
   * Serialized against itself because the bucket is a shared budget: two
   * concurrent sends would each observe the same token and both admit. The
   * wait is a real wait rather than a refusal — signalling cannot be dropped,
   * only spread — which is what makes the 24-per-6 s bound a property of the
   * wire and not of a queue somewhere.
   */
  private send(
    peerId: string,
    envelope: CallEnvelope | GroupCallEnvelope,
    urgent: boolean,
    legPeer?: string,
    // The chain outlives any one caller, so the fence is captured where the
    // frame is composed: a send queued behind a full bucket must not leave the
    // device seconds later, from a workspace that has since been torn down.
    //
    // A LEG PASSES ITS OWN GENERATION AND SESSION. Every other caller is
    // already inside a checked coordinator body and composes on these clocks
    // by definition; a leg's frame is composed by a `CallService` effect loop
    // the coordinator does not own, so composition time is the wrong clock and
    // the leg's creation time is the right one (`ensureLeg`).
    gen: number = this.generation,
    tok: string | null = this.sessionSid(),
  ): Promise<void> {
    // THE MIRROR BELONGS TO THE SESSION WHOSE FRAME EXHAUSTED IT.
    // The chain can sit in its pacing wait while that session ends and a new
    // one installs with the same peer. A peer-only input dispatched on the far
    // side would paint the successor "Couldn't reach" on the dead session's
    // evidence, so the incarnation is carried beside `gen`, from the clock
    // that owns this frame.
    const run = this.sendChain.then(async () => {
      if (this.stale(gen)) return;
      const wait = this.bucket.msUntilAvailable(this.deps.now());
      if (wait > 0) await this.deps.delay(wait);
      if (this.stale(gen)) return;
      this.bucket.tryTake(this.deps.now());
      if (urgent && !this.pushMirror.tryTake(this.deps.now()) && legPeer) {
        // The frame STILL SENDS — only the wake is lost, because the envelope
        // queues server-side. What the empty mirror changes is the tile:
        // "Couldn't reach" now, instead of "Calling…" until the ring timeout.
        void this.dispatchIfSession({ type: 'legPushMirrorEmpty', peerId: legPeer }, tok);
      }
      if (isGroupCallTcm(envelope.tcm)) {
        await this.deps.transport.sendGroupCallEnvelope(
          peerId,
          envelope as GroupCallEnvelope,
          { urgent },
        );
        return;
      }
      await this.deps.transport.sendCallEnvelope(peerId, envelope as CallEnvelope, { urgent });
    });
    this.sendChain = run.catch(() => undefined);
    return run;
  }

  // --- bookkeeping ----------------------------------------------------------

  private cidOf(envelope: unknown): string | null {
    if (typeof envelope === 'string') {
      const match = /"cid":"([^"]+)"/.exec(envelope);
      return match?.[1] ?? null;
    }
    if (envelope && typeof envelope === 'object' && 'cid' in envelope) {
      const cid = (envelope as { cid: unknown }).cid;
      return typeof cid === 'string' ? cid : null;
    }
    return null;
  }

  private ownsCid(cid: string): boolean {
    const s = this.state;
    if (!s) return false;
    if (s.starterOffer?.invite.cid === cid) return true;
    for (const held of Object.values(s.heldOffers)) {
      if (held.invite.cid === cid) return true;
    }
    for (const leg of Object.values(s.legs)) {
      if (leg.cid === cid) return true;
    }
    return false;
  }

  private async writeAggregateRow(
    sid: string,
    peerId: string,
    direction: 'in' | 'out',
    reason: CallEndReason,
    video: boolean,
    missed: boolean,
    roomId: string | null = null,
  ): Promise<void> {
    const at = this.deps.now();
    await this.deps.store
      .writeLog({
        // The session's own id doubles as the row's cid: there is no leg to
        // name, and a row keyed by anything else could not be grouped with
        // the per-leg rows a later attempt at the same session writes.
        cid: sid,
        peerId,
        direction,
        kind: video ? 'video' : 'audio',
        reason,
        startedAt: at,
        connectedAt: null,
        endedAt: at,
        missed,
        sessionId: sid,
        roomId,
      })
      .catch(() => undefined);
  }

  private resetSessionScratch(): void {
    for (const service of this.legs.values()) service.dispose();
    this.legs.clear();
    this.legCid.clear();
    this.legEndReason.clear();
    this.skipped.clear();
    for (const timer of this.reofferTimers.values()) clearTimeout(timer);
    this.reofferTimers.clear();
    // The whole session is gone, so every departed leg's deadline is moot —
    // and the services those deadlines would have forced have just been
    // disposed above, which performs the same close.
    for (const deadline of this.departedDeadlines.values()) clearTimeout(deadline.timer);
    this.departedDeadlines.clear();
    this.muted = false;
    // BOTH HALVES OF THE MUTE, and the camera with them. The intent is what a
    // new leg binds to, so a session that inherited it would open its first
    // leg silent against a microphone nobody muted — the mirror image of the
    // glare bug the comment in `step` describes, and just as wrong.
    this.mutedIntent = false;
    this.cameraOff = false;
    // AND THE OUTPUT ROUTE. CallKit deactivates the audio session when the
    // call ends and `configureAudioSession` builds the next one from scratch,
    // so the override this flag reports is gone. Carrying `true` into the next
    // session would light the speaker button over an earpiece — a claim about
    // the person's own hardware that is simply false.
    this.speakerOn = false;
    this.legInvitedAt.clear();
    this.legLogRows = 0;
    this.lastSession = null;
    // THE RING GOES WITH THE SESSION. Called on an ordinary end and at the
    // glare boundary, and both are right: the winner reports its own ring
    // AFTER that boundary (`supersede` emits the loser's whole teardown
    // first), so a token surrendered here is only ever a dead session's.
    this.reportedRingToken = null;
  }

  /**
   * Release timers, leg services and the session itself.
   *
   * Called from the app's quiesce seams — the same ones that stop messaging:
   * relock, account deletion, and the teardown `startCalling` returns. A
   * coordinator that survived one of those kept a live roster, N `CallService`
   * instances, the paced send chain and every armed re-offer timer across a
   * workspace switch — so a timer could fire after a duress unlock and reach
   * native media creation, and a later real account could inherit stale busy
   * state.
   *
   * The subscribers are told, because the UI's copy of the session outlives
   * this object otherwise: a locked phone must not come back showing a call
   * that no longer exists anywhere.
   *
   * TWO THINGS BEYOND THE SCRATCH, and both were blockers:
   *
   *  - THE GENERATION IS BUMPED FIRST, before anything else runs. Disposal is
   *    synchronous and the coordinator is usually suspended in an await when
   *    it lands; clearing the maps only made the resumed effect build the
   *    session again — a CXCall reported, media opened, ginvites appended to
   *    the still-live send chain, all after the workspace was gone.
   *  - EVERY LIVE LEG'S PEER CONNECTION IS CLOSED. In the 1:1 path the only
   *    thing that ever closes native media is the reducer's `closeMedia`
   *    effect (`service.ts`), and a relock emits no reducer input at all — so
   *    somebody above the reducer has to close.
   *
   *    Today that somebody is `CallService.dispose()` for the cid the
   *    service still owns, and this method only for the cids no service can
   *    still name (see the capture below). The split is not tidiness: a
   *    service disposed mid-teardown is exactly the case where the reducer's
   *    own close never runs, and it is reached from `resetSessionScratch()` on
   *    an ORDINARY session end as well as from here — a path this method never
   *    sees.
   *
   *    Fire-and-forget because this seam is synchronous and the alternative is
   *    a locked phone waiting on the bridge; `close` is idempotent natively.
   *
   * AND THE CXCALL GOES WITH THEM. The fence has one edge the old code did
   * not: an effect list abandoned mid-teardown may never reach its
   * `releaseGroupCall`, which would leave the system showing a call nothing
   * can drive. Releasing here is `rehydrate`'s doctrine applied to the abrupt
   * seam — the same reason `restore` releases rather than leave a CXCall it
   * cannot answer.
   *
   * WHICH IS WHY EVERYTHING BELOW IS READ BEFORE THE GENERATION MOVES
   * A fence stops the building and cannot be taught to
   * spare the demolishing — `run` has five separate checkpoints and a
   * per-effect exemption would have to be right at every one of them, against
   * scratch this method is about to clear, which is a fix that mostly
   * executes no-ops and looks like it worked. So `dispose()` does not HOPE
   * the abandoned step reaches its teardown: it captures the CXCall it owes
   * (`cxCallSid`, this object's own ledger — see the field), the live cids,
   * and every session row still owed a deletion (`owedSessionRows`, the same
   * doctrine one field over — and the reason glare needs no special case
   * here), and then owns all three outright.
   *
   * Fire-and-forget because this seam is synchronous and the alternative is a
   * locked phone waiting on the bridge; `close` is idempotent natively and
   * the row deletions are `catch`-swallowed.
   */
  dispose(): void {
    // --- captured BEFORE the generation moves ---
    const cxSid = this.cxCallSid;
    // ONLY THE CIDS NO SERVICE CAN STILL NAME. `CallService.dispose()` now
    // closes its own live cid (`service.ts`), and `resetSessionScratch()`
    // below disposes every leg — so closing `service.current.call.cid` here
    // too would be a second bridge call for the same connection on every
    // relock. What a service cannot name is the cid of a call its reducer has
    // already collapsed, which this coordinator still remembers in `legCid`.
    const liveCids: string[] = [];
    for (const [peerId, service] of this.legs) {
      if (service.current.call !== null) continue;
      const cid = this.legCid.get(peerId);
      if (cid) liveCids.push(cid);
    }
    // EVERY SID STILL OWED A DELETION (`owedSessionRows`). A row left behind
    // is a dead call that a later cold launch would rebuild and ring — holding
    // a roster, a peer id, a DTLS fingerprint and candidate addresses until it
    // did — and the step that owed it can be abandoned in more ways than one.
    // `lastSession` joins the drain rather than replacing it: it is the older,
    // narrower reading (a session the reducer has already collapsed whose
    // teardown is still in flight) and it costs nothing to keep, because the
    // set de-duplicates the ordinary case where both name the same sid.
    const owed = new Set(this.owedSessionRows);
    if (this.state === null && this.lastSession) owed.add(this.lastSession.sid);

    this.generation++;
    this.cxCallSid = null;
    // The CXCall is about to be released below, so the ring it was showing is
    // nothing a later press can be about either.
    this.reportedRingToken = null;
    this.owedSessionRows.clear();

    if (cxSid) void this.deps.native.endCall(cxSid, 'hangup').catch(() => undefined);
    for (const cid of liveCids) {
      try {
        void this.deps.native.close(cid).catch(() => undefined);
      } catch {
        // A bridge that throws synchronously must not stop the relock: the
        // rest of the teardown matters more than one leg's close.
      }
    }
    for (const sid of owed) {
      // …EXCEPT the pairs already in hand (`deletingNow`). A sid
      // claimed there belongs to a teardown standing at an await inside the
      // delete pair, which run-to-completion guarantees will finish it. Two
      // concurrent pairs for one sid is free today and will not stay free.
      if (this.deletingNow.has(sid)) continue;
      void this.deps.store.deleteSession(sid).catch(() => undefined);
      void this.deps.store.deleteOffersForSession(sid).catch(() => undefined);
    }
    this.resetSessionScratch();
    // The other end of a session, and the one no reducer ever sees: a relock,
    // a sign-out, a workspace teardown. `step`'s `ended` branch never runs for
    // these, so without this line a verdict decided for a call that was
    // demolished mid-ring would outlive it.
    this.deps.releaseRelayPolicy?.();
    this.bumpIncarnationIfIdentityChanged(null);
    this.state = null;
    this.notify();
  }

  /** Test seam: how many leg services are resident. The bound is the LIVE
   * roster, not every peer the session has ever named (the retention). */
  get residentLegs(): number {
    return this.legs.size;
  }
}
