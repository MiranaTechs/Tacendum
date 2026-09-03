import {
  admitGroupCallInvite,
  admitGroupCallRosterDelta,
  assertComposableGroupCallRoster,
  CALL_RING_TIMEOUT_MS,
  groupCallInviteIsRingable,
  type CallEndReason,
  type GroupCallInviteEnvelope,
  type GroupCallJoinEnvelope,
  type GroupCallLeaveEnvelope,
  type GroupCallSessionView,
} from './call.js';
import type { CallStateName } from './call-machine.js';

/**
 * The small-group call session supervisor — a pure
 * reducer: `groupSessionReducer(state, input, now) → { state, effects }`.
 *
 * It sits ABOVE the per-leg machine, never inside it. Each leg of a
 * small-group call is a complete, ordinary 1:1 call run by its own
 * `callReducer` + `CallService` instance (departure 2); this module owns only
 * the SESSION layer — the roster held from the starter, the epoch, leg
 * lifecycle summaries, offer ordering, the CallKit aggregate — and consumes
 * leg lifecycle as `legStateChanged` facts. Per-leg protocol events
 * (answer/ice/restart/end for a live cid) never pass through here.
 *
 * Like `callReducer`, it imports nothing from `react-native`, nothing from
 * the db, nothing from messaging: effects are DATA and the coordinator
 * executes them, so the whole session protocol is testable without a device,
 * and the CLI drives this exact module rather than a copy.
 * `now` is passed in rather than read, for the same reason it is there.
 *
 * ADMISSION IS DELEGATED, NEVER RE-DERIVED (rule 24). `admitGroupCallInvite`
 * and `admitGroupCallRosterDelta` in `./call.js` are the only code that ranks
 * sids, checks epochs, or enforces caps; this module calls them and acts on
 * the verdict. There is deliberately no comparison of sid orderings and no
 * cap arithmetic anywhere below — a second implementation of either is a
 * defect even when it agrees, because two copies of a security rule is how
 * they drift. A source-level test holds this.
 *
 * Purity has one consequence worth stating: a reducer cannot mint a ULID.
 * The 1:1 machine solved it the same way — `placeCall` carries a caller-
 * minted `cid` — so every input below that can open a leg carries the fresh
 * cid(s) the executor minted for it (`start.cids`, `localAnswer.cids`,
 * `addParticipant.cid`, `reofferTimer.cid`).
 */

// --- constants --------------------------------------------------------------

/**
 * R6: a leg that dies while both ends are still rostered and announced is
 * re-offered by its designated offerer with a FRESH cid at +2 s, then +6 s,
 * then never again — the tile shows "Couldn't connect". Two retries, not
 * more, because re-offers consume the session signalling bucket (§6) like
 * any frame and unbounded retry under churn would starve ICE.
 */
export const GINVITE_REOFFER_DELAYS_MS = [2_000, 6_000] as const;

// --- state ------------------------------------------------------------------

/**
 * The per-leg summary phases, and therefore the tile status lines (§9 renders
 * these verbatim). This is a SUMMARY of a leg service's lifecycle, not a copy
 * of its `CallState` — the leg service owns the call state and all its
 * scratch (departure 2); holding a second full copy here would be exactly the
 * two-sources-of-truth drift the test-debt record documents.
 */
export type LegPhase =
  | 'inviting' // our ginvite/offer sent, nothing back
  | 'ringing' // their call.ringing arrived (tile: "Ringing…")
  | 'unreachable' // local pushSend mirror was empty at send (tile: "Couldn't reach")
  | 'connecting' // answered / answering, ICE in flight
  | 'connected'
  | 'reconnecting'
  | 'failed' // terminal without recovering (tile: "Couldn't connect")
  | 'declined'
  | 'left' // gleave or hangup after connecting
  | 'gone'; // leg fully torn down and removable

export interface LegSummary {
  peerId: string;
  /** The LIVE leg's cid; re-offers mint a fresh one (R6). */
  cid: string;
  phase: LegPhase;
  /**
   * Who offered. Decides per-leg ICE-restart ownership (`direction === 'out'`
   * restarts, `call-machine.ts`) and re-offer ownership (R6): exactly one
   * side of every leg holds 'out', which R1's offer rule guarantees.
   */
  direction: 'in' | 'out';
  /** Re-offers remaining for this pairing; GINVITE_REOFFER_DELAYS_MS.length at leg birth. */
  reoffersLeft: number;
}

/**
 * A held invite: the ratchet-authenticated sender, the envelope, and the
 * server receipt stamp — everything `groupCallInviteIsRingable` needs to
 * re-ask its clocked question at answer time, when the hold may have aged
 * past the offer's life. Referenced by §4.2 as the payload of
 * `openLegAnswer`; defined here because nothing upstream defines it.
 */
export interface StoredGroupOffer {
  /** frame.from of the frame that carried the invite — never a payload field. */
  from: string;
  invite: GroupCallInviteEnvelope;
  serverTs: number;
}

export interface GroupSessionState {
  sid: string;
  /** frame.from of the accepted ginvite (or selfId when we started). Written once. */
  starterId: string;
  selfId: string;
  /** The room this call belongs to; null for ad-hoc picker calls. Carried so
   * the executor can fill the `call_sessions` row (§7) from state alone. */
  roomId: string | null;
  /** ORDERED — index decides who offers (§9.4, R1). Grown only by authority
   * deltas; a sovereign leave shrinks the LIVE set, never this. Removal
   * preserves relative order, which is all the offer rule depends on. */
  roster: readonly string[];
  /** Epoch of the roster held. */
  se: number;
  /** An se+2 authority delta, held-never-dropped (R10). One slot: the starter
   * mints serially, so a second far-future delta can only be a newer one. */
  held: GroupCallJoinEnvelope | GroupCallLeaveEnvelope | null;
  /** Decides the cap (§9.5) — but the cap itself is checked in call.ts only. */
  video: boolean;
  phase: 'ringing' | 'joining' | 'live';
  /** Keyed by peerId — one live leg per peer, as one CallService per leg. */
  legs: Record<string, LegSummary>;
  /** Same-sid join_leg invites that arrived while WE were still ringing (R2):
   * admitted but held, never rung, and critically never answered before the
   * human answers the session. */
  heldOffers: Record<string, StoredGroupOffer>;
  /** The ring we have not yet answered — the starter's own invite, kept so
   * `localAnswer` can hand it to `openLegAnswer`. Null once answered and for
   * sessions we started. */
  starterOffer: StoredGroupOffer | null;
  /**
   * Whether the starter has already re-offered the ring leg once
   * (`inviteWhileLive`'s swap). ONE swap per session: each swap re-arms the
   * leg's 60 s ring timer, so an unbounded swap loop was an unbounded ring —
   * a starter re-offering every 55 s held a phone ringing indefinitely
   * (§6.4's rule, which the 1:1 machine keeps by answering a second offer
   * from a ringing caller busy). Optional so a session row persisted before
   * this field existed restores as "not yet swapped".
   */
  ringSwapped?: boolean;
  /**
   * Who has said "I am in" (or proven it by connecting a leg). R6 refuses to
   * re-offer toward anyone not announced: re-offering an unanswered invite
   * would be a re-RING, and only R2's single ring may ring. The starter is
   * announced by definition (they dialled); self joins the set at answer.
   */
  announced: readonly string[];
  /** The CallKit aggregate (§4.3): N legs, ONE report, one connect, one release. */
  callKit: 'none' | 'reported' | 'connected';
  startedAt: number;
  /** Present only on the starter's authoritative session. */
  reportId: string | null;
  answeredAt: number | null;
  peakConnectedParticipants: number;
  /** First leg connected — the CXCall's connect. Later legs change nothing. */
  connectedAt: number | null;
}

// --- inputs -----------------------------------------------------------------

export type GroupSessionInput =
  | {
      type: 'start';
      sid: string;
      selfId: string;
      roster: readonly string[];
      video: boolean;
      reportId: string;
      roomId?: string | null;
      /** Executor-minted fresh cid per callee (every roster member but self). */
      cids: Readonly<Record<string, string>>;
    }
  | {
      type: 'ginviteReceived';
      /** Ratchet-authenticated frame.from — the writerId rule; never a payload field. */
      from: string;
      selfId: string;
      invite: GroupCallInviteEnvelope;
      /** Server-stamped receipt time — the one clock both sides share (§6.4). */
      serverTs: number;
    }
  | { type: 'gjoinReceived'; from: string; delta: GroupCallJoinEnvelope }
  | { type: 'gleaveReceived'; from: string; delta: GroupCallLeaveEnvelope }
  | {
      type: 'legStateChanged';
      peerId: string;
      cid: string;
      name: CallStateName;
      answeredAt?: number | null;
      /** The terminal reason, required with name 'ending'. A bare state name
       * cannot distinguish "declined" from "failed" from "left", and both the
       * tile phases and R6's re-offer gate turn on that distinction. */
      reason?: CallEndReason;
    }
  /** The coordinator's pushSend mirror was empty when this leg's invite went
   * out (§6): the frame still sent, only the wake was lost. */
  | { type: 'legPushMirrorEmpty'; peerId: string }
  | { type: 'localAnswer'; cids: Readonly<Record<string, string>> }
  | { type: 'localDecline' }
  | { type: 'localHangup' }
  | { type: 'callKitAnswered'; sid: string; cids: Readonly<Record<string, string>> }
  | { type: 'callKitEnded'; sid: string }
  | { type: 'addParticipant'; peerId: string; cid: string }
  | { type: 'reofferTimer'; peerId: string; cid: string };

// --- effects ----------------------------------------------------------------

/**
 * Effects are data, exactly as `CallEffect` is; the coordinator executes them
 * in order. `closeLeg` doubles as "this cid is dead": the executor folds the
 * leg service if one exists and, when `announce`, sends `call.end{cid, r}` —
 * which is how a held offer that never had a service still gets its refusal
 * on the wire (R5, R9).
 */
export type SessionEffect =
  | { type: 'openGroupCallMetric'; reportId: string; localId: string; media: 'audio' | 'video'; startedAt: number }
  | { type: 'answerGroupCallMetric'; localId: string; answeredAt: number }
  | { type: 'connectGroupCallMetric'; localId: string; connectedAt: number }
  | { type: 'peakGroupCallMetric'; localId: string; participants: number }
  | { type: 'finalizeGroupCallMetric'; localId: string; reason: CallEndReason; endedAt: number }
  | { type: 'discardGroupCallMetric'; localId: string }
  | { type: 'openLegDial'; peerId: string; cid: string; kind: 'ginvite' | 'reoffer' }
  /**
   * Open the starter's leg in its ordinary `incoming_ringing` state — the
   * proven 1:1 machinery then owns the ring ack (`call.ringing`), the 60 s
   * ring timer, expiry, and a starter's cancel, none of which this module
   * re-implements. NOT in §4.2's effect list; added because that list has no
   * way to stop ringing — no ring timer, no cancel path — and a peer must
   * not be able to make us ring forever (§6.4). `incoming_ringing` emits no
   * `createAnswer`, so rule 25 holds: no camera before the human answers.
   */
  | { type: 'openLegRinging'; peerId: string; cid: string; offer: StoredGroupOffer }
  /**
   * Accept an offer: ensure the leg service exists and answer it. This is
   * the ONE effect that reaches `createAnswer`, and it is emitted only from
   * `localAnswer`/`callKitAnswered` or for a join_leg into a session the
   * human already answered — rule 25's whole content.
   */
  | { type: 'openLegAnswer'; peerId: string; cid: string; offer: StoredGroupOffer }
  /**
   * Persist an ADMITTED invite's offer for a cold restore. The SDP is what a
   * lock-screen answer needs after the process died, and the ratchet consumed
   * its message key on first decrypt, so the row must be written while the
   * frame is in hand — but only for an invite this module rang, held, swapped
   * or auto-accepted. The coordinator used to persist every ringable invite
   * BEFORE the verdict, so a stranger's SDP, fingerprint and candidate
   * addresses sat in `call_offers` for a call answered busy. Emitted FIRST in
   * its step, ahead of the session row and the CallKit report, so there is no
   * window in which the system shows a call a restore could not answer. Never
   * for a redelivered frame. */
  | { type: 'persistOffer'; offer: StoredGroupOffer }
  | { type: 'closeLeg'; peerId: string; cid: string; reason: CallEndReason; announce: boolean }
  | {
      type: 'sendRosterDelta';
      to: string[];
      env: GroupCallJoinEnvelope | GroupCallLeaveEnvelope;
      /** Never urgent (§6): a roster delta matters only to live participants,
       * who are online by definition — it must not spend the pushSend budget. */
      urgent: false;
    }
  | { type: 'reportGroupIncoming'; sid: string; starterId: string; hasVideo: boolean }
  | { type: 'reportGroupOutgoing'; sid: string }
  | { type: 'reportGroupConnected'; sid: string }
  /** Carries the reason so the executor can write the aggregate history row
   * (R5's missed-style row for decline/timeout/cancelled) — the session has
   * no log-row effect of its own; per-LEG rows are the leg services'. */
  | { type: 'releaseGroupCall'; sid: string; reason: CallEndReason }
  | { type: 'writeSessionRow' }
  /**
   * Delete the persisted row for THIS session, named rather than implied.
   *
   * The sid rides on the effect because of session glare: `supersede` emits
   * the loser's whole teardown and the winner's fresh ring in ONE step, and
   * the state the executor holds by the time it runs these is already the
   * WINNER. An executor that read `state.sid` therefore deleted the winner's
   * row and left the loser's behind — a row naming who was on a call with
   * whom, surviving the call it belonged to. An effect that names its own
   * session cannot be misread that way.
   */
  | { type: 'closeSessionRow'; sid: string }
  | { type: 'startReofferTimer'; peerId: string; ms: number }
  /**
   * Clear the VoIP push placeholder an invite arrived behind, for a refusal
   * that produces no other frame.
   *
   * A ginvite is woken by a VoIP push, and the push rings a full-screen
   * placeholder BEFORE anything can decrypt (§9.4). Most refusals already
   * clear it as a side effect of the frame they send — `closeLeg{busy}`
   * dismisses, and the coordinator dismisses at each refusal it decides
   * itself (blocked, an already-declined placeholder, an expired invite).
   *
   * TWO REFUSALS SEND NOTHING AND DECIDE NOTHING LOCALLY, and both are this
   * module's: an over-cap video roster (`ignore/over_cap`, the cap being
   * call.ts's to refuse) and a glare WINNER that arrived past its life. Both
   * returned no effects at all, so the coordinator had no way to know a
   * dismissal was owed and the placeholder rang until the system watchdog
   * gave up on it. The signal rides the effect list — the verdict channel the
   * coordinator already executes — rather than a second path out of the
   * reducer, because a parallel channel is how two copies of one rule drift.
   */
  | { type: 'dismissRing'; peerId: string }
  | { type: 'legUnreachable'; peerId: string };

export interface GroupSessionStep {
  state: GroupSessionState | null;
  effects: SessionEffect[];
}

// --- offer ordering (R1) ----------------------------------------------------

/**
 * Who offers on the leg between `a` and `b` (§9.4, R1): the starter offers on
 * every starter↔member leg (its ginvite IS the offer — the shipped schema
 * carries sdp); among non-starter pairs the LATER roster index offers to the
 * earlier — deterministic, no wall clock. Every leg therefore has exactly one
 * 'out' side, which is what keeps per-leg ICE-restart ownership
 * (`direction === 'out'`, call-machine.ts) and R6 re-offer ownership
 * well-defined. Symmetric in its arguments by construction.
 */
export function groupLegOfferer(
  roster: readonly string[],
  starterId: string,
  a: string,
  b: string,
): string {
  if (a === starterId) return a;
  if (b === starterId) return b;
  return roster.indexOf(a) > roster.indexOf(b) ? a : b;
}

// --- helpers ----------------------------------------------------------------

/** The session as admission sees it. Built fresh per verdict; never cached. */
function viewOf(state: GroupSessionState): GroupCallSessionView {
  return {
    sid: state.sid,
    starterId: state.starterId,
    roster: state.roster,
    se: state.se,
    video: state.video,
    // A session that has carried media is never in glare (`admitGroupCallInvite`).
    connected: state.connectedAt !== null,
  };
}

const TERMINAL_PHASES: ReadonlySet<LegPhase> = new Set<LegPhase>([
  'failed',
  'declined',
  'left',
  'gone',
]);

/**
 * The reasons R6 repairs. Failure-class only: `busy` is here because the
 * §3.6 late-join race manifests as a busy refusal from an incumbent whose
 * roster has not caught up. Decline, hangup, cancel and ring-timeout are
 * ANSWERS from a person and must never be retried into a re-ring.
 */
const REOFFERABLE: ReadonlySet<CallEndReason> = new Set<CallEndReason>([
  'failed_ice',
  'failed_media',
  'expired',
  'busy',
]);

function terminalPhaseFor(reason: CallEndReason): LegPhase {
  switch (reason) {
    case 'decline':
      return 'declined';
    case 'hangup':
    case 'cancelled':
      return 'left';
    case 'glare_lost':
      return 'gone';
    default:
      return 'failed';
  }
}

/** A dead leg the session still expects to revive: we own the offer, retries
 * remain, and the peer is both rostered and announced (R6's full condition). */
function revivable(state: GroupSessionState, leg: LegSummary): boolean {
  return (
    leg.phase === 'failed' &&
    leg.direction === 'out' &&
    leg.reoffersLeft > 0 &&
    state.roster.includes(leg.peerId) &&
    state.announced.includes(leg.peerId)
  );
}

function freshLeg(peerId: string, cid: string, direction: 'in' | 'out', phase: LegPhase): LegSummary {
  return { peerId, cid, phase, direction, reoffersLeft: GINVITE_REOFFER_DELAYS_MS.length };
}

const NOTHING = (state: GroupSessionState | null): GroupSessionStep => ({
  state,
  effects: [],
});

/**
 * Close-everything effects for a session ending as a whole. `announce` is
 * false when the ends are already on their way from the other side (a
 * starter-out delta, a superseded session's peers hearing glare from the
 * winner's own invites is NOT one of those — glare announces).
 */
function teardownAll(
  state: GroupSessionState,
  reason: CallEndReason,
  announce: boolean,
): SessionEffect[] {
  const effects: SessionEffect[] = [];
  for (const leg of Object.values(state.legs)) {
    if (leg.phase === 'gone') continue;
    effects.push({
      type: 'closeLeg',
      peerId: leg.peerId,
      cid: leg.cid,
      reason: legEndReason(leg, reason),
      announce,
    });
  }
  if (state.starterOffer) {
    effects.push({
      type: 'closeLeg',
      peerId: state.starterOffer.from,
      cid: state.starterOffer.invite.cid,
      reason,
      announce,
    });
  }
  for (const held of Object.values(state.heldOffers)) {
    effects.push({ type: 'closeLeg', peerId: held.from, cid: held.invite.cid, reason, announce });
  }
  return effects;
}

/**
 * What a session-level `hangup` means for ONE leg (the 1:1 machine's own
 * rule, lifted): a leg the peer never answered — still inviting, ringing, or
 * unreachable — is CANCELLED, which is what makes it a missed call on their
 * side (`MISSED_REASONS`, and CallKit's `.unanswered`); a leg they answered
 * is a hangup. Closing a ringing leg with `hangup` logged the starter's
 * pre-answer hangup as a completed call on every callee — no missed row, no
 * badge. Every other reason passes through untouched.
 */
function legEndReason(leg: LegSummary, reason: CallEndReason): CallEndReason {
  if (reason !== 'hangup') return reason;
  return leg.phase === 'inviting' || leg.phase === 'ringing' || leg.phase === 'unreachable'
    ? 'cancelled'
    : 'hangup';
}

/**
 * Every whole-session terminal path funnels through here (the `endCall`
 * doctrine, lifted): release the ONE CXCall exactly once, then close the row.
 * The state collapses to null in the same step — leg teardown belongs to the
 * executor via the `closeLeg` effects already emitted, and a zombie session
 * kept alive to watch it would re-open every admission question for no
 * safety. (§4.2 sketches an 'ending' phase; this is why it has no residency.)
 */
function released(state: GroupSessionState, reason: CallEndReason, now: number): SessionEffect[] {
  const authoritative = state.selfId === state.starterId && state.reportId !== null;
  return [
    ...(authoritative
      ? [reason === 'glare_lost'
          ? { type: 'discardGroupCallMetric' as const, localId: state.sid }
          : { type: 'finalizeGroupCallMetric' as const, localId: state.sid, reason, endedAt: now }]
      : []),
    { type: 'releaseGroupCall', sid: state.sid, reason },
    { type: 'closeSessionRow', sid: state.sid },
  ];
}

/**
 * §5's release-reason rule: a session that never carried media and died of
 * failure releases as `failed_ice` whatever the last leg's particular
 * failure was; anything a person decided (hangup, decline) keeps its name.
 */
function releaseReason(state: GroupSessionState, last: CallEndReason): CallEndReason {
  if (state.connectedAt === null && REOFFERABLE.has(last)) return 'failed_ice';
  return last;
}

/** Release when the last live leg is gone and nothing is coming back (§4.3). */
function maybeRelease(
  state: GroupSessionState,
  effects: SessionEffect[],
  last: CallEndReason,
  now = state.startedAt,
): GroupSessionStep {
  const legs = Object.values(state.legs);
  const allTerminal =
    legs.length > 0 &&
    legs.every(leg => TERMINAL_PHASES.has(leg.phase)) &&
    !legs.some(leg => revivable(state, leg));
  if (state.phase !== 'ringing' && allTerminal) {
    return { state: null, effects: [...effects, ...released(state, releaseReason(state, last), now)] };
  }
  return { state, effects };
}

function withLeg(state: GroupSessionState, leg: LegSummary): GroupSessionState {
  return { ...state, legs: { ...state.legs, [leg.peerId]: leg } };
}

function announce(state: GroupSessionState, id: string): GroupSessionState {
  if (state.announced.includes(id)) return state;
  return { ...state, announced: [...state.announced, id] };
}

function unannounce(state: GroupSessionState, id: string): GroupSessionState {
  if (!state.announced.includes(id)) return state;
  return { ...state, announced: state.announced.filter(a => a !== id) };
}

/** Sovereign deltas echo the epoch held — advisory there (call.ts) — but the
 * schema floors `se` at 1, and a session still at epoch 0 must not compose an
 * unparseable frame. */
function sovereignEpoch(state: GroupSessionState): number {
  return Math.max(1, state.se);
}

// --- fresh sessions ---------------------------------------------------------

/**
 * Ring for an accepted, ringable ginvite (R2's first half): persist the row
 * FIRST — there must be no window in which the system shows a call the app
 * cannot answer (§4.3, the persist-before-ring ordering `call_offers` uses)
 * — then open the starter's leg ringing, then report the ONE CXCall.
 */
function ringFresh(
  selfId: string,
  from: string,
  invite: GroupCallInviteEnvelope,
  serverTs: number,
  now: number,
): GroupSessionStep {
  const offer: StoredGroupOffer = { from, invite, serverTs };
  const state: GroupSessionState = {
    sid: invite.sid,
    starterId: from, // frame.from of the accepted ginvite — written once, never a payload field
    selfId,
    roomId: null,
    roster: invite.r, // the roster held FROM THE STARTER, at the epoch it asserts
    // The starter's own epoch, when the invite carries it (an invite from
    // a build that predates the field reads 0, which is the only epoch an
    // ORIGINAL member can be at). A member added at epoch k who seeded 0
    // held every later delta forever — see `GroupCallInviteEnvelope.se`.
    se: invite.se ?? 0,
    held: null,
    video: invite.vid,
    phase: 'ringing',
    legs: {},
    heldOffers: {},
    starterOffer: offer,
    announced: [from],
    callKit: 'reported',
    startedAt: now,
    reportId: null,
    answeredAt: null,
    peakConnectedParticipants: 1,
    connectedAt: null,
  };
  return {
    state,
    effects: [
      { type: 'persistOffer', offer },
      { type: 'writeSessionRow' },
      { type: 'openLegRinging', peerId: from, cid: invite.cid, offer },
      { type: 'reportGroupIncoming', sid: invite.sid, starterId: from, hasVideo: invite.vid },
    ],
  };
}

// --- authority roster deltas (R8, R10) --------------------------------------

/**
 * Apply ONE admitted authority delta, then drain the held slot while it keeps
 * admitting (R10: the held delta re-applies when the gap fills). Admission is
 * re-asked of `admitGroupCallRosterDelta` for every drained delta — the held
 * slot never bypasses the only judge.
 */
function applyAuthority(
  state: GroupSessionState,
  first: GroupCallJoinEnvelope | GroupCallLeaveEnvelope,
  // Underscored, not dropped: every step handler here takes the same
  // (state, input, now) shape and the two call sites pass the same `now` they
  // pass everywhere else. This one is pure roster algebra — no timer, no
  // deadline, nothing that reads the clock — so the argument is deliberately
  // unread rather than accidentally forgotten.
  now: number,
): GroupSessionStep {
  const effects: SessionEffect[] = [];
  let cur: GroupSessionState | null = state;
  let delta: GroupCallJoinEnvelope | GroupCallLeaveEnvelope | null = first;

  while (cur !== null && delta !== null) {
    if (delta.tcm === 'call.gleave' && delta.m === cur.starterId) {
      // R8's remote arm: the starter announced OUT ends the session for
      // everyone. Tear every leg down WITHOUT announcing — the per-leg ends
      // are coming from each device's own hangup fan, and echoing would
      // ping-pong — and release the one CXCall.
      return {
        state: null,
        effects: [...effects, ...teardownAll(cur, 'hangup', false), ...released(cur, 'hangup', now)],
      };
    }
    if (delta.tcm === 'call.gleave' && delta.m === cur.selfId) {
      // The starter removed US. Our legs are ours to end, loudly.
      return {
        state: null,
        effects: [...effects, ...teardownAll(cur, 'hangup', true), ...released(cur, 'hangup', now)],
      };
    }

    if (delta.tcm === 'call.gjoin') {
      const roster: readonly string[] = cur.roster.includes(delta.m)
        ? cur.roster
        : [...cur.roster, delta.m];
      cur = { ...cur, roster, se: delta.se };
      // No dial: for a late joiner the JOINER offers to incumbents (R1); the
      // starter's own device dials from `addParticipant`, not from its echo.
    } else {
      const removed = delta.m;
      const leg: LegSummary | undefined = cur.legs[removed];
      if (leg && !TERMINAL_PHASES.has(leg.phase)) {
        // A member removed while still RINGING is cancelled, not hung up on
        // (`legEndReason`): they never answered, so their row is a missed call.
        effects.push({
          type: 'closeLeg',
          peerId: removed,
          cid: leg.cid,
          reason: legEndReason(leg, 'hangup'),
          announce: true,
        });
        cur = withLeg(cur, { ...leg, phase: 'left' });
      }
      const heldFromRemoved = cur.heldOffers[removed];
      if (heldFromRemoved) {
        effects.push({
          type: 'closeLeg',
          peerId: removed,
          cid: heldFromRemoved.invite.cid,
          reason: 'hangup',
          announce: true,
        });
        const heldOffers = { ...cur.heldOffers };
        delete heldOffers[removed];
        cur = { ...cur, heldOffers };
      }
      cur = unannounce(
        { ...cur, roster: cur.roster.filter(id => id !== removed), se: delta.se },
        removed,
      );
    }

    delta = null;
    if (cur.held) {
      const verdict = admitGroupCallRosterDelta(viewOf(cur), cur.starterId, cur.held);
      if (verdict.verdict === 'apply') {
        delta = cur.held;
        cur = { ...cur, held: null };
      } else if (verdict.verdict === 'ignore') {
        // The gap filled and revealed the held delta as a redelivery.
        cur = { ...cur, held: null };
      }
      // 'hold': still beyond the next epoch; it keeps waiting.
    }
  }

  effects.push({ type: 'writeSessionRow' });
  return maybeRelease(cur as GroupSessionState, effects, 'hangup', now);
}

// --- answering (R3) ---------------------------------------------------------

function answerSession(
  state: GroupSessionState,
  cids: Readonly<Record<string, string>>,
  now: number,
): GroupSessionStep {
  const offer = state.starterOffer;
  if (!offer) return NOTHING(state);
  const effects: SessionEffect[] = [];
  let next: GroupSessionState = announce(
    { ...state, phase: 'joining', starterOffer: null, heldOffers: {} },
    state.selfId,
  );

  // 1. Answer the starter's leg — its service already exists (it has been
  //    ringing) and holds the offer; carrying it again keeps the effect
  //    uniform with the held-offer answers below.
  effects.push({
    type: 'openLegAnswer',
    peerId: offer.from,
    cid: offer.invite.cid,
    offer,
  });
  next = withLeg(next, freshLeg(offer.from, offer.invite.cid, 'in', 'connecting'));

  // 2. Answer every held offer that is still alive. The hold may have aged
  //    past the offer: `groupCallInviteIsRingable` is the same clocked
  //    question the leg machine itself would ask, so a dropped hold here is
  //    an offer the leg would have refused anyway — and R6 repairs it from
  //    the offerer's side.
  for (const held of Object.values(state.heldOffers)) {
    if (!groupCallInviteIsRingable(held.invite, held.serverTs, now)) continue;
    effects.push({ type: 'openLegAnswer', peerId: held.from, cid: held.invite.cid, offer: held });
    next = announce(
      withLeg(next, freshLeg(held.from, held.invite.cid, 'in', 'connecting')),
      held.from,
    );
  }

  // 3. Broadcast the sovereign self-announce (R4). Load-bearing, not
  //    decorative: it is what tells every incumbent's tiles we joined and
  //    what arms their R6 re-offers toward us. Not urgent (§6).
  const to = state.roster.filter(id => id !== state.selfId);
  effects.push({
    type: 'sendRosterDelta',
    to: to.length > 0 ? to : [state.starterId],
    env: { tcm: 'call.gjoin', sid: state.sid, m: state.selfId, se: sovereignEpoch(state) },
    urgent: false,
  });

  // 4. Offer to every member R1 says WE offer to and whose leg does not
  //    already exist — in practice the lower-index non-starters. The set is
  //    derived from groupLegOfferer, not re-encoded here: one rule, one
  //    encoding, or the two drift (a mutation run caught exactly that).
  for (const member of state.roster) {
    if (member === state.starterId || member === state.selfId) continue;
    if (next.legs[member]) continue; // their offer arrived and was answered
    if (groupLegOfferer(state.roster, state.starterId, state.selfId, member) !== state.selfId) {
      continue; // their pair, their offer — we wait (R1)
    }
    const cid = cids[member];
    if (!cid) {
      // Compose-strict, the call.ts doctrine: a missing cid is OUR bug and
      // must be loud, not a silently unformed leg.
      throw new Error('refusing to answer a small-group call: the executor minted no cid for a dial');
    }
    effects.push({ type: 'openLegDial', peerId: member, cid, kind: 'ginvite' });
    next = withLeg(next, freshLeg(member, cid, 'out', 'inviting'));
  }

  return { state: next, effects };
}

// --- decline (R5) -----------------------------------------------------------

/**
 * Declining is not leaving a call you never joined: `call.end{r:'decline'}`
 * goes out on the starter's leg AND on every held leg (killing those
 * ringbacks at once), and NO gleave is ever sent — the roster still names us.
 * The aggregate missed-style row is the executor's, keyed off the release
 * reason.
 */
function declineSession(state: GroupSessionState, now: number): GroupSessionStep {
  return {
    state: null,
    effects: [...teardownAll(state, 'decline', true), ...released(state, 'decline', now)],
  };
}

// --- hangup / leave (R7, R8) ------------------------------------------------

function hangupSession(state: GroupSessionState, now: number): GroupSessionStep {
  if (state.phase === 'ringing') return declineSession(state, now);
  const effects = teardownAll(state, 'hangup', true);
  const to = state.roster.filter(id => id !== state.selfId);
  const env: GroupCallLeaveEnvelope =
    state.selfId === state.starterId
      ? // R8's local arm: the starter's hangup is an AUTHORITY starter-out —
        // the delta that ends the session for everyone, at the next epoch.
        { tcm: 'call.gleave', sid: state.sid, m: state.starterId, se: state.se + 1 }
      : // A member leaving is sovereign: it may name only itself (R7).
        { tcm: 'call.gleave', sid: state.sid, m: state.selfId, se: sovereignEpoch(state) };
  if (to.length > 0) {
    effects.push({ type: 'sendRosterDelta', to, env, urgent: false });
  }
  return { state: null, effects: [...effects, ...released(state, 'hangup', now)] };
}

// --- the reducer ------------------------------------------------------------

export function groupSessionReducer(
  state: GroupSessionState | null,
  input: GroupSessionInput,
  now: number,
): GroupSessionStep {
  if (state === null) return fromIdle(input, now);

  switch (input.type) {
    case 'start':
      // R11's in-module half: one session per device, by construction — the
      // state holds exactly one. The coordinator refuses earlier and louder;
      // this is the backstop. (The cross-shape interlock against live 1:1
      // calls lives in the coordinator too — this module never sees 1:1 state.)
      return NOTHING(state);

    case 'ginviteReceived':
      return inviteWhileLive(state, input, now);

    case 'gjoinReceived': {
      const verdict = admitGroupCallRosterDelta(viewOf(state), input.from, input.delta);
      if (verdict.verdict === 'ignore') {
        // THE verdict this module exists to obey. A non-starter naming anyone
        // (or a stranger naming themself) changes NOTHING — no state, no
        // effects, no dial. Re-deciding it here would be a second copy of the
        // rule that stops a small-group call becoming a distributed dialler.
        return NOTHING(state);
      }
      if (verdict.verdict === 'hold') {
        return NOTHING({ ...state, held: input.delta });
      }
      if (input.from === state.starterId) {
        return applyAuthority(state, input.delta, now);
      }
      // Sovereign self-announce (R4): the peer is IN. If our designated-offer
      // leg toward them already died — their held copy of our offer expired,
      // or our earlier tries exhausted while they rang — this announce is the
      // signal to try again, with a fresh retry budget: they only just
      // arrived, so no prior failure was really "theirs".
      {
        let next = announce(state, input.delta.m);
        const leg: LegSummary | undefined = next.legs[input.delta.m];
        const firstAnnounce = !state.announced.includes(input.delta.m);
        if (firstAnnounce && leg && leg.direction === 'out' && leg.phase === 'failed') {
          next = withLeg(next, { ...leg, reoffersLeft: GINVITE_REOFFER_DELAYS_MS.length });
          return {
            state: next,
            effects: [{ type: 'startReofferTimer', peerId: input.delta.m, ms: 0 }],
          };
        }
        return NOTHING(next);
      }
    }

    case 'gleaveReceived': {
      const verdict = admitGroupCallRosterDelta(viewOf(state), input.from, input.delta);
      if (verdict.verdict === 'ignore') {
        // The distributed-hangup twin of the dialler: a non-starter's
        // gleave{m: starter} must not end anyone's call. Ignored means
        // NOTHING — asserted byte-for-byte in the tests.
        return NOTHING(state);
      }
      if (verdict.verdict === 'hold') {
        return NOTHING({ ...state, held: input.delta });
      }
      if (input.from === state.starterId) {
        return applyAuthority(state, input.delta, now);
      }
      // Sovereign leave: the peer takes themself out of the LIVE set. The
      // roster — the starter's assertion — does not shrink, so a returner is
      // still a join_leg and never a stranger. Their ends are en route from
      // their own hangup fan; announcing ours back would ping-pong.
      {
        const effects: SessionEffect[] = [];
        let next = unannounce(state, input.delta.m);
        const leg: LegSummary | undefined = next.legs[input.delta.m];
        if (leg && !TERMINAL_PHASES.has(leg.phase)) {
          effects.push({ type: 'closeLeg', peerId: leg.peerId, cid: leg.cid, reason: 'hangup', announce: false });
          next = withLeg(next, { ...leg, phase: 'left' });
        }
        if (next.heldOffers[input.delta.m]) {
          const heldOffers = { ...next.heldOffers };
          delete heldOffers[input.delta.m];
          next = { ...next, heldOffers };
        }
        return maybeRelease(next, effects, 'hangup', now);
      }
    }

    case 'legStateChanged':
      return legChanged(state, input, now);

    case 'legPushMirrorEmpty': {
      const leg = state.legs[input.peerId];
      // Only an un-acked dial can be "couldn't reach"; any later signal from
      // the peer (ringing, an answer) has already proven them reachable, and
      // §5 requires the honest upgrade to win.
      if (!leg || leg.phase !== 'inviting') return NOTHING(state);
      return {
        state: withLeg(state, { ...leg, phase: 'unreachable' }),
        effects: [{ type: 'legUnreachable', peerId: input.peerId }],
      };
    }

    case 'localAnswer':
      if (state.phase !== 'ringing') return NOTHING(state);
      return answerSession(state, input.cids, now);

    case 'callKitAnswered':
      // The sid rides the CallKit round trip (departure 8: the CXCall is
      // keyed by sid); a stale answer for a dead session must not answer this one.
      if (input.sid !== state.sid || state.phase !== 'ringing') return NOTHING(state);
      return answerSession(state, input.cids, now);

    case 'localDecline':
      if (state.phase !== 'ringing') return NOTHING(state);
      return declineSession(state, now);

    case 'localHangup':
      return hangupSession(state, now);

    case 'callKitEnded':
      if (input.sid !== state.sid) return NOTHING(state);
      // The system red button: a decline while ringing, a hangup once joined
      // — the same mapping the 1:1 machine gives callKitEnded.
      return hangupSession(state, now);

    case 'addParticipant': {
      // Starter only (R1: the starter offers on starter↔member legs; a
      // member's Add affordance does not exist, §9). Growth is judged by the
      // ONLY judge: we compose the authority delta we are about to send and
      // ask admission whether we may apply it — the cap refusal (over_cap)
      // comes from call.ts, never from arithmetic here.
      if (state.selfId !== state.starterId || state.phase === 'ringing') return NOTHING(state);
      if (state.roster.includes(input.peerId)) return NOTHING(state);
      const delta: GroupCallJoinEnvelope = {
        tcm: 'call.gjoin',
        sid: state.sid,
        m: input.peerId,
        se: state.se + 1,
      };
      const verdict = admitGroupCallRosterDelta(viewOf(state), state.selfId, delta);
      if (verdict.verdict !== 'apply') return NOTHING(state);
      const to = state.roster.filter(id => id !== state.selfId);
      const next = withLeg(
        { ...state, roster: [...state.roster, input.peerId], se: delta.se },
        freshLeg(input.peerId, input.cid, 'out', 'inviting'),
      );
      const effects: SessionEffect[] = [{ type: 'writeSessionRow' }];
      if (to.length > 0) effects.push({ type: 'sendRosterDelta', to, env: delta, urgent: false });
      effects.push({ type: 'openLegDial', peerId: input.peerId, cid: input.cid, kind: 'ginvite' });
      return { state: next, effects };
    }

    case 'reofferTimer': {
      const leg = state.legs[input.peerId];
      if (
        state.phase === 'ringing' ||
        !leg ||
        !revivable(state, leg)
      ) {
        // The world moved while the timer ran — the peer left, was removed,
        // or the leg recovered. A re-offer now would dial someone the session
        // no longer expects; check the whole condition again, not the half
        // that was true when the timer started.
        return NOTHING(state);
      }
      return {
        state: withLeg(state, {
          ...leg,
          cid: input.cid,
          phase: 'inviting',
          reoffersLeft: leg.reoffersLeft - 1,
        }),
        effects: [{ type: 'openLegDial', peerId: input.peerId, cid: input.cid, kind: 'reoffer' }],
      };
    }
  }
}

// --- no session -------------------------------------------------------------

function fromIdle(input: GroupSessionInput, now: number): GroupSessionStep {
  switch (input.type) {
    case 'start': {
      // Compose-strict (call.ts's split): OUR malformed roster is a bug in
      // this build and must be loud — the cap and shape checks live in
      // call.ts, asked here, never re-derived.
      const roster = assertComposableGroupCallRoster(input.roster, input.video);
      if (!roster.includes(input.selfId)) {
        throw new Error('refusing to start a small-group call whose roster omits this device');
      }
      const legs: Record<string, LegSummary> = {};
      const dials: SessionEffect[] = [];
      for (const peerId of roster) {
        if (peerId === input.selfId) continue;
        const cid = input.cids[peerId];
        if (!cid) {
          throw new Error('refusing to start a small-group call: the executor minted no cid for a callee');
        }
        legs[peerId] = freshLeg(peerId, cid, 'out', 'inviting');
        dials.push({ type: 'openLegDial', peerId, cid, kind: 'ginvite' });
      }
      const state: GroupSessionState = {
        sid: input.sid,
        starterId: input.selfId,
        selfId: input.selfId,
        roomId: input.roomId ?? null,
        roster,
        se: 0,
        held: null,
        video: input.video,
        phase: 'joining',
        legs,
        heldOffers: {},
        starterOffer: null,
        announced: [input.selfId],
        callKit: 'reported',
        startedAt: now,
        reportId: input.reportId,
        answeredAt: null,
        peakConnectedParticipants: 1,
        connectedAt: null,
      };
      return {
        state,
        effects: [
          {
            type: 'openGroupCallMetric' as const,
            reportId: input.reportId,
            localId: input.sid,
            media: input.video ? 'video' as const : 'audio' as const,
            startedAt: now,
          },
          { type: 'writeSessionRow' },
          { type: 'reportGroupOutgoing', sid: input.sid },
          ...dials,
        ],
      };
    }

    case 'ginviteReceived': {
      const verdict = admitGroupCallInvite(null, input.from, input.invite);
      if (verdict.verdict !== 'ring') {
        // Refused by the ONLY judge — in practice an over-cap video roster,
        // which is the one verdict `admitGroupCallInvite` can return with no
        // live session to compare against. It sends nothing, so the push
        // placeholder in front of it has nothing else to end it.
        return { state: null, effects: [{ type: 'dismissRing', peerId: input.from }] };
      }
      // Ringability is the separate, CLOCKED question admission refuses to
      // answer (call.ts): an offer past its life must never ring a phone.
      // The missed-row for an expired invite is the coordinator's to write —
      // it holds the same serverTs and the same exported predicate.
      if (!groupCallInviteIsRingable(input.invite, input.serverTs, now)) {
        return NOTHING(null);
      }
      return ringFresh(input.selfId, input.from, input.invite, input.serverTs, now);
    }

    default:
      // Everything else addresses a session that no longer exists — a
      // redelivered delta for a dead sid is normal, not exceptional.
      return NOTHING(null);
  }
}

// --- invites into a live session (R2, R9) -----------------------------------

function inviteWhileLive(
  state: GroupSessionState,
  input: Extract<GroupSessionInput, { type: 'ginviteReceived' }>,
  now: number,
): GroupSessionStep {
  const { from, invite, serverTs } = input;
  const verdict = admitGroupCallInvite(viewOf(state), from, invite);

  switch (verdict.verdict) {
    case 'ignore':
    case 'ring':
      // 'ignore' is the over-cap refusal; 'ring' is unreachable against a live
      // session (the verdict type is shared with the no-session case) and
      // ringing a second session over a live one would break R2 and R11 at
      // once. Both refuse, both send nothing — and the invite still arrived
      // behind a VoIP placeholder that nothing else will clear.
      return { state, effects: [{ type: 'dismissRing', peerId: from }] };

    case 'busy':
      // Refused through the existing path: `call.end{r:'busy'}` on the
      // offered cid, live session untouched. No `call.gbusy` exists
      // (departure 3).
      return {
        state,
        effects: [{ type: 'closeLeg', peerId: from, cid: invite.cid, reason: 'busy', announce: true }],
      };

    case 'supersede': {
      // R9: session glare, and this side lost. A stale losing frame must not
      // kill a healthy call, so the clocked bound applies here exactly as it
      // does to a fresh ring — an invite past its life supersedes nothing.
      // The live session is untouched; the placeholder the stale winner's own
      // push rang is not, and only this says so.
      if (!groupCallInviteIsRingable(invite, serverTs, now)) {
        return { state, effects: [{ type: 'dismissRing', peerId: from }] };
      }
      // Abandon EVERY leg with glare_lost (suppressed from logs by
      // isLoggable), release OUR CXCall, and only then process the winner as
      // fresh — the order is the rule: the loser must be gone before the
      // winner rings.
      const teardown = [
        ...teardownAll(state, 'glare_lost', true),
        ...released(state, 'glare_lost', now),
      ];
      const fresh = ringFresh(state.selfId, from, invite, serverTs, now);
      return { state: fresh.state, effects: [...teardown, ...fresh.effects] };
    }

    case 'join_leg': {
      // Same session, sender already in the roster held from the starter.
      const liveLeg: LegSummary | undefined = state.legs[from];
      const redelivered =
        liveLeg?.cid === invite.cid ||
        state.heldOffers[from]?.invite.cid === invite.cid ||
        state.starterOffer?.invite.cid === invite.cid;
      if (redelivered) return NOTHING(state); // §5.6: a redelivered frame is normal

      if (state.phase === 'ringing') {
        if (from === state.starterId && state.starterOffer) {
          // The starter re-offered the ring leg itself (our ringing ack was
          // lost, or their first try died). Swap the offer under the SAME
          // session and the SAME CXCall: fold the old ringing leg silently
          // and ring the new cid internally — no second reportGroupIncoming,
          // because R2 rings a session once, not once per offer.
          //
          // ONCE, AND ONLY WITHIN THE ORIGINAL RING. Each swap re-arms the
          // leg's 60 s ring timer, so a starter re-offering every 55 s held
          // the phone ringing without bound. A second swap, or any swap
          // past the deadline the first ring set, is answered busy on the
          // fresh cid and the ring already up runs out on its own clock.
          const pastDeadline = now >= state.startedAt + CALL_RING_TIMEOUT_MS;
          if (state.ringSwapped === true || pastDeadline) {
            return {
              state,
              effects: [
                { type: 'closeLeg', peerId: from, cid: invite.cid, reason: 'busy', announce: true },
              ],
            };
          }
          const offer: StoredGroupOffer = { from, invite, serverTs };
          return {
            state: { ...state, starterOffer: offer, ringSwapped: true },
            effects: [
              { type: 'persistOffer', offer },
              {
                type: 'closeLeg',
                peerId: from,
                cid: state.starterOffer.invite.cid,
                reason: 'expired',
                announce: false,
              },
              { type: 'openLegRinging', peerId: from, cid: invite.cid, offer },
            ],
          };
        }
        // R2's second half, the one that closed a camera bug class before it
        // existed: admitted but HELD. No answer effect of any kind until the
        // human answers the session — `createAnswer` starts the camera, and
        // rule 25 forbids it while we ring. A newer offer from the same peer
        // replaces the older hold; the superseded cid dies on their side.
        const held: StoredGroupOffer = { from, invite, serverTs };
        return {
          state: { ...state, heldOffers: { ...state.heldOffers, [from]: held } },
          effects: [{ type: 'persistOffer', offer: held }],
        };
      }

      // The session is answered, so a member's leg is auto-accepted — the
      // human consented to the CALL; each leg inside it needs no second ring.
      if (!groupCallInviteIsRingable(invite, serverTs, now)) return NOTHING(state);
      const effects: SessionEffect[] = [];
      let next = announce(state, from);
      if (liveLeg && !TERMINAL_PHASES.has(liveLeg.phase)) {
        // A fresh cid from a peer with a live leg means THEY have abandoned
        // that leg (R6 re-offers mint fresh cids). Fold ours quietly and
        // adopt theirs; announcing an end at a peer who already moved on
        // would only race their new offer.
        effects.push({
          type: 'closeLeg',
          peerId: from,
          cid: liveLeg.cid,
          reason: 'failed_media',
          announce: false,
        });
      }
      const offer: StoredGroupOffer = { from, invite, serverTs };
      next = withLeg(next, freshLeg(from, invite.cid, 'in', 'connecting'));
      effects.push({ type: 'persistOffer', offer });
      effects.push({ type: 'openLegAnswer', peerId: from, cid: invite.cid, offer });
      return { state: next, effects };
    }
  }
}

// --- leg lifecycle (§4.3, R6, R7) -------------------------------------------

function legChanged(
  state: GroupSessionState,
  input: Extract<GroupSessionInput, { type: 'legStateChanged' }>,
  now: number,
): GroupSessionStep {
  const { peerId, cid, name } = input;

  if (state.phase === 'ringing') {
    // Pre-answer the only leg service alive is the starter's ringing leg
    // (openLegRinging). Its terminal report is the ring collapsing under us:
    // the starter cancelled, the 60 s ring timer fired, or the offer expired
    // — all owned by the proven 1:1 machine, not re-implemented here. The
    // held ringbacks are closed loudly so held joiners stop dialling a
    // session that no longer exists.
    if (
      state.starterOffer &&
      cid === state.starterOffer.invite.cid &&
      name === 'ending'
    ) {
      const reason = input.reason ?? 'cancelled';
      const closes: SessionEffect[] = [];
      for (const held of Object.values(state.heldOffers)) {
        closes.push({
          type: 'closeLeg',
          peerId: held.from,
          cid: held.invite.cid,
          reason,
          announce: true,
        });
      }
      return { state: null, effects: [...closes, ...released(state, reason, now)] };
    }
    return NOTHING(state);
  }

  const leg = state.legs[peerId];
  // A report for a cid this session no longer tracks is a replaced or folded
  // leg finishing its teardown — normal, not exceptional.
  if (!leg || leg.cid !== cid) return NOTHING(state);

  // A direct leg observes the original authenticated answer before ICE can
  // connect. The session owns that fact, so latch it before interpreting the
  // leg state; a failed ICE negotiation is still an answered group call.
  const authoritative = state.selfId === state.starterId && state.reportId !== null;
  const observedAnswerAt = input.answeredAt;
  const firstAnswer =
    authoritative && state.answeredAt === null && typeof observedAnswerAt === 'number';
  const answeredState = firstAnswer ? { ...state, answeredAt: observedAnswerAt } : state;
  const answerEffects: SessionEffect[] = firstAnswer
    ? [{ type: 'answerGroupCallMetric', localId: state.sid, answeredAt: observedAnswerAt }]
    : [];
  const withAnswer = (next: GroupSessionState, effects: SessionEffect[] = []): GroupSessionStep =>
    answerEffects.length === 0
      ? { state: next, effects }
      : { state: next, effects: [...answerEffects, ...effects] };

  switch (name) {
    case 'connected': {
      let next = announce(withLeg(answeredState, { ...leg, phase: 'connected' }), peerId);
      const current =
        1 +
        Object.values(next.legs).filter(
          candidate => candidate.phase === 'connected' || candidate.phase === 'reconnecting',
        ).length;
      const peak = Math.max(next.peakConnectedParticipants, current);
      next = { ...next, peakConnectedParticipants: peak };
      const metrics: SessionEffect[] = authoritative
        ? [
            ...(next.connectedAt === null
              ? [{ type: 'connectGroupCallMetric' as const, localId: next.sid, connectedAt: now }]
              : []),
            ...(peak > state.peakConnectedParticipants
              ? [{ type: 'peakGroupCallMetric' as const, localId: next.sid, participants: peak }]
              : []),
          ]
        : [];
      // §4.3: connect on the FIRST leg. Later legs connecting emit nothing —
      // the CXCall connected when the call became real, not N times.
      //
      // The CallKit CONNECT report is the STARTER's alone: it is
      // `reportOutgoingCall(with:connectedAt:)`, a fact about an outgoing
      // call, and an incoming session's CXCall was connected by its answer.
      // Issuing it for an incoming session filed the wrong transition
      // against CallKit's bookkeeping (and grew `outgoingConnected` with an
      // incoming UUID); the aggregate's own `connectedAt`/`phase` latch is
      // unchanged either way.
      if (next.callKit === 'reported') {
        next = {
          ...next,
          callKit: 'connected',
          connectedAt: next.connectedAt ?? now,
          phase: 'live',
        };
        const report: SessionEffect[] =
          state.starterId === state.selfId
            ? [{ type: 'reportGroupConnected', sid: state.sid }]
            : [];
        return withAnswer(next, [...metrics, ...report]);
      }
      return withAnswer(next, metrics);
    }

    case 'outgoing_ringing':
      // Their device acked the ring — the honest upgrade from "Couldn't
      // reach" or "Calling…" (§5): they were reachable after all.
      return withAnswer(withLeg(answeredState, { ...leg, phase: 'ringing' }));

    case 'outgoing_connecting':
      // The dial's first report, and also the caller's state after an answer
      // arrives (the 1:1 machine deliberately stays there until ICE).
      // Preserve the more specific phases this module already knows.
      if (leg.phase === 'inviting' || leg.phase === 'unreachable' || leg.phase === 'ringing') {
        return withAnswer(answeredState);
      }
      return withAnswer(withLeg(answeredState, { ...leg, phase: 'connecting' }));

    case 'incoming_ringing':
    case 'incoming_answering':
      return withAnswer(withLeg(answeredState, { ...leg, phase: 'connecting' }));

    case 'reconnecting':
      return withAnswer(withLeg(answeredState, { ...leg, phase: 'reconnecting' }));

    case 'ending': {
      const reason = input.reason ?? 'failed_media';
      const updated: LegSummary = { ...leg, phase: terminalPhaseFor(reason) };
      let next = withLeg(answeredState, updated);
      // A busy refusal is EVIDENCE OF PRESENCE: only a device live in a
      // session sends one, and in the §3.6 late-join race it is precisely
      // the incumbent whose roster has not caught up with ours. Count it as
      // their announcement, or the joiner would wait forever on an announce
      // the incumbents broadcast before it existed — and the race would be
      // a permanent hole instead of a two-re-offer repair.
      if (reason === 'busy') next = announce(next, peerId);
      // AND SO IS AN ANSWER. A leg the peer ANSWERED — `answeredAt` on the
      // report (the 1:1 machine latches it when their `call.answer` lands),
      // or a summary already past `connecting` — proved their presence as
      // surely as a busy does, so a first-attempt ICE failure on it is R6's
      // to repair even when no `gjoin` from them has arrived. Incumbents
      // broadcast their sovereign announce once, at their own answer, BEFORE
      // a late joiner exists; without this the joiner↔incumbent leg that
      // failed before its first connect stayed "Couldn't connect" for the
      // rest of the call, and the incumbent (direction 'in') could not repair
      // it either. The summary alone is not enough: an out-leg's phase stays
      // `ringing` through the peer's answer (the more specific phase is kept
      // until ICE connects), so the answer itself is what must be read.
      if (
        typeof input.answeredAt === 'number' ||
        leg.phase === 'connecting' ||
        leg.phase === 'reconnecting'
      ) {
        next = announce(next, peerId);
      }
      const effects: SessionEffect[] = [];
      // R6: the designated offerer repairs a failed leg — and only failures.
      // The delay ladder indexes off the retries already spent, so the first
      // repair waits 2 s and the second 6 s (GINVITE_REOFFER_DELAYS_MS).
      if (REOFFERABLE.has(reason) && revivable(next, updated)) {
        const ms =
          GINVITE_REOFFER_DELAYS_MS[GINVITE_REOFFER_DELAYS_MS.length - updated.reoffersLeft] ??
          GINVITE_REOFFER_DELAYS_MS[0];
        effects.push({ type: 'startReofferTimer', peerId, ms });
      }
      const released = maybeRelease(next, [...answerEffects, ...effects], reason, now);
      return released;
    }

    case 'idle':
      // The service finished tearing down. 'failed' is STICKY through it:
      // the teardown completing must erase neither the "Couldn't connect"
      // tile nor a pending R6 repair — whether a re-offer fires cannot be
      // decided by how quickly a peer connection closes. (The matrix caught
      // exactly this: a fast teardown turned every repair into a no-op.)
      if (leg.phase === 'failed') return withAnswer(answeredState);
      // Otherwise 'gone' rather than deletion, so a late redelivery for the
      // cid stays attributable and ignorable.
      return maybeRelease(withLeg(answeredState, { ...leg, phase: 'gone' }), answerEffects, 'hangup', now);

    default:
      return NOTHING(state);
  }
}
