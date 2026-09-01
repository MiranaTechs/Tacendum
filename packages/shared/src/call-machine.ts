import {
  CALL_CONNECT_TIMEOUT_MS,
  CALL_RECONNECT_TIMEOUT_MS,
  CALL_RING_TIMEOUT_MS,
  MAX_ICE_CANDIDATES_PER_CALL,
  OFFER_EXP_SKEW_MS,
  OFFER_MAX_SERVER_AGE_MS,
  OFFER_TTL_MS,
  type CallEndReason,
  type CallEnvelope,
} from './call.js';

/**
 * The call state machine — a pure reducer:
 * `(state, event, now) → { state, effects }`.
 *
 * It imports nothing from `react-native`, nothing from the native module, and
 * nothing from `messaging`. Effects are *data*; the
 * CallService executes them. Two things fall out of that discipline: the
 * entire call protocol is testable without a device or a camera, and the
 * eventual Android port is an adapter rewrite rather than a redesign.
 *
 * `now` is passed in rather than read, so the reducer has no clock of its own
 * and a test can place a call in 2026 without mocking anything.
 *
 * It lives in `shared`, not in `app`, because it is PROTOCOL rather than UI:
 * the CLI signaling gate (§11.2) drives this exact reducer, so the glare rule
 * and the timeout arithmetic that ship are the ones the gate proves. A copy in
 * the CLI would only demonstrate that two of my own implementations agree.
 */

// --- candidates -------------------------------------------------------------

export interface IceCandidate {
  cand: string;
  mid: string;
  idx: number;
}

// --- state ------------------------------------------------------------------

export type CallStateName =
  | 'idle'
  /** Caller: peer connection up, offer enqueued, waiting for ICE to connect. */
  | 'outgoing_connecting'
  /** Caller: the callee's device confirmed it is ringing (a UI state only). */
  | 'outgoing_ringing'
  /** Callee: offer decrypted and validated, CallKit reported, ringing. */
  | 'incoming_ringing'
  /** Callee: user accepted, answer enqueued, ICE in flight. */
  | 'incoming_answering'
  /** Media flowing. */
  | 'connected'
  /** ICE dropped; a restart is in flight and the clock is running. */
  | 'reconnecting'
  /** Terminal envelope sent or received; teardown in progress → idle. */
  | 'ending';

export interface CallContext {
  cid: string;
  peerId: string;
  /** 'out' = we placed it. Also decides who owns ICE restart (§7.6). */
  direction: 'in' | 'out';
  /** Whether WE opened with video. */
  video: boolean;
  /** The peer's announced track state (§5.1 `call.media`). */
  peerAudio: boolean;
  peerVideo: boolean;
  startedAt: number;
  /** Only the originating authority owns a lifecycle report. */
  reportId: string | null;
  /** First authenticated original answer; restart answers never replace it. */
  answeredAt: number | null;
  /** null until ICE connects — "never connected" and "0:00" are different
   * facts and the call log must not conflate them (§10.1). */
  connectedAt: number | null;
  /**
   * The offer SDP, for the callee only.
   *
   * Held because `createAnswer` needs it and the accept can arrive much later
   * than the offer — from a lock screen, after a cold launch. Without it the
   * reducer emitted `createAnswer` with an empty `remoteSdp` and no answer
   * could ever be produced; the gap was invisible until an executor existed
   * to notice (V5). Empty for an outgoing call, which never answers anything.
   */
  remoteOfferSdp: string;
  /** Candidates that arrived before the remote description was set. */
  pendingIce: IceCandidate[];
  /** True once the remote description is applied, so ICE can be added live. */
  remoteReady: boolean;
}

export type CallState =
  | { name: 'idle'; call: null }
  | { name: Exclude<CallStateName, 'idle'>; call: CallContext };

export function idleState(): CallState {
  return { name: 'idle', call: null };
}

// --- events -----------------------------------------------------------------

export type TimerName = 'ring' | 'connect' | 'reconnect';

export type CallEvent =
  | { type: 'placeCall'; cid: string; peerId: string; video: boolean; reportId: string | null }
  | {
      type: 'offerReceived';
      cid: string;
      peerId: string;
      sdp: string;
      video: boolean;
      exp: number;
      /** Server-stamped receipt time — the one clock both sides share. */
      serverTs: number;
    }
  | { type: 'answerReceived'; cid: string; sdp: string; video: boolean }
  | { type: 'iceReceived'; cid: string; candidates: IceCandidate[] }
  | { type: 'ringingReceived'; cid: string }
  | { type: 'restartReceived'; cid: string; sdp: string }
  | { type: 'mediaReceived'; cid: string; audio: boolean; video: boolean }
  | { type: 'endReceived'; cid: string; reason: CallEndReason }
  /** `video: false` is "Answer without video" — accept an incoming VIDEO call
   * with the camera off. Absent means accept as offered. */
  | { type: 'localAccept'; video?: boolean }
  | { type: 'localDecline' }
  | { type: 'localHangup' }
  | { type: 'iceStateChanged'; cid: string; ice: 'connected' | 'disconnected' | 'failed' }
  | { type: 'ringTimeout' }
  | { type: 'connectTimeout' }
  | { type: 'reconnectTimeout' }
  | { type: 'networkChanged' }
  | { type: 'incomingReportFailed'; cid: string }
  | { type: 'callKitAnswered' }
  | { type: 'callKitEnded' }
  | { type: 'callKitFailedToActivateAudio' }
  | { type: 'appTerminating' }
  | { type: 'teardownComplete' };

// --- effects ----------------------------------------------------------------

export type CallEffect =
  | { type: 'openCallMetric'; reportId: string; localId: string; media: 'audio' | 'video'; startedAt: number }
  | { type: 'answerCallMetric'; localId: string; answeredAt: number }
  | { type: 'connectCallMetric'; localId: string; connectedAt: number }
  | { type: 'finalizeCallMetric'; localId: string; reason: CallEndReason; endedAt: number }
  | { type: 'discardCallMetric'; localId: string }
  | { type: 'createOffer'; cid: string; withVideo: boolean }
  | { type: 'createAnswer'; cid: string; remoteSdp: string; withVideo: boolean }
  | { type: 'setRemoteAnswer'; cid: string; sdp: string }
  | { type: 'restartIce'; cid: string }
  | { type: 'addIceCandidates'; cid: string; candidates: IceCandidate[] }
  | { type: 'closePeerConnection'; cid: string }
  /**
   * **Contract:** an envelope whose `sdp` is the empty string is a *template*.
   * The reducer decides what is sent, when, and whether it is urgent, but it
   * cannot know an SDP — that comes from the native module. The executor fills
   * `sdp` from the result of the `createOffer` / `createAnswer` / `restartIce`
   * effect emitted immediately before it, and MUST NOT send a template whose
   * SDP it failed to obtain (fail the call instead — an empty SDP on the wire
   * is a call the peer can never connect).
   */
  | { type: 'sendEnvelope'; peerId: string; envelope: CallEnvelope; urgent: boolean }
  | { type: 'startTimer'; timer: TimerName; ms: number }
  | { type: 'cancelTimer'; timer: TimerName }
  /** `hasVideo` mirrors the incoming report's field, and for the same two
   * reasons: it is what CallKit records for the call, and it is what the
   * audio session is configured for. Omitting it made every outgoing video
   * call a voice call to CallKit and put its audio in the earpiece. */
  | { type: 'reportOutgoingCall'; cid: string; peerId: string; hasVideo: boolean }
  | { type: 'reportIncomingCall'; cid: string; peerId: string; hasVideo: boolean }
  | { type: 'reportConnected'; cid: string }
  | { type: 'endCallKit'; cid: string; reason: CallEndReason }
  | { type: 'reportBusy' }
  | {
      type: 'writeLog';
      cid: string;
      peerId: string;
      direction: 'in' | 'out';
      kind: 'audio' | 'video';
      reason: CallEndReason;
      startedAt: number;
      connectedAt: number | null;
      endedAt: number;
      missed: boolean;
    };

export interface Step {
  state: CallState;
  effects: CallEffect[];
}

// --- helpers ----------------------------------------------------------------

/**
 * Reasons the callee never saw, or never got the chance to answer. These are
 * the rows a person needs to notice — everything else is a call that happened.
 */
const MISSED_REASONS: ReadonlySet<CallEndReason> = new Set<CallEndReason>([
  'timeout',
  'cancelled',
  'expired',
]);

/** Glare bookkeeping is not a call and must never appear in a thread (§6.5). */
function isLoggable(reason: CallEndReason): boolean {
  return reason !== 'glare_lost';
}

function newContext(fields: {
  cid: string;
  peerId: string;
  direction: 'in' | 'out';
  video: boolean;
  now: number;
  /** Explicit authority: null means this leg must never report metrics. */
  reportId: string | null;
  remoteOfferSdp?: string;
}): CallContext {
  return {
    cid: fields.cid,
    peerId: fields.peerId,
    direction: fields.direction,
    video: fields.video,
    peerAudio: true,
    peerVideo: fields.video,
    startedAt: fields.now,
    reportId: fields.reportId,
    answeredAt: null,
    connectedAt: null,
    remoteOfferSdp: fields.remoteOfferSdp ?? '',
    pendingIce: [],
    remoteReady: false,
  };
}

function send(
  call: CallContext,
  envelope: CallEnvelope,
  urgent = false,
): CallEffect {
  return { type: 'sendEnvelope', peerId: call.peerId, envelope, urgent };
}

function logRow(
  call: CallContext,
  reason: CallEndReason,
  now: number,
): CallEffect[] {
  if (!isLoggable(reason)) return [];
  return [
    {
      type: 'writeLog',
      cid: call.cid,
      peerId: call.peerId,
      direction: call.direction,
      kind: call.video || call.peerVideo ? 'video' : 'audio',
      reason,
      startedAt: call.startedAt,
      connectedAt: call.connectedAt,
      endedAt: now,
      // Only the receiving side can miss a call.
      missed: call.direction === 'in' && MISSED_REASONS.has(reason),
    },
  ];
}

/**
 * Every terminal path funnels through here so teardown can never be partial:
 * close the peer connection, release CallKit, cancel every timer, write the
 * row. `announce` is false when the peer is the one who told US it ended —
 * echoing an end back would ping-pong.
 */
function endCall(
  call: CallContext,
  reason: CallEndReason,
  now: number,
  announce: boolean,
): Step {
  const effects: CallEffect[] = [];
  if (announce) {
    effects.push(
      send(call, { tcm: 'call.end', cid: call.cid, r: reason }, true),
    );
  }
  if (call.direction === 'out' && call.reportId !== null) {
    effects.push(
      reason === 'glare_lost'
        ? { type: 'discardCallMetric', localId: call.cid }
        : { type: 'finalizeCallMetric', localId: call.cid, reason, endedAt: now },
    );
  }
  effects.push(
    { type: 'cancelTimer', timer: 'ring' },
    { type: 'cancelTimer', timer: 'connect' },
    { type: 'cancelTimer', timer: 'reconnect' },
    { type: 'closePeerConnection', cid: call.cid },
    { type: 'endCallKit', cid: call.cid, reason },
    ...logRow(call, reason, now),
  );
  return { state: { name: 'ending', call }, effects };
}

const NOTHING = (state: CallState): Step => ({ state, effects: [] });

/** Events that name a call must match the one we are handling, or be ignored.
 * A redelivered frame for a dead cid is normal, not exceptional (§5.6). */
function addressesThisCall(event: CallEvent, call: CallContext): boolean {
  return !('cid' in event) || event.cid === call.cid;
}

// --- the reducer ------------------------------------------------------------

export function callReducer(
  state: CallState,
  event: CallEvent,
  now: number,
): Step {
  if (state.name === 'idle') return fromIdle(state, event, now);

  const call = state.call;

  // Two events legitimately carry a cid that is NOT the live call's — they
  // are about starting a *different* call — so they are answered before the
  // "is this addressed to us" guard, which would otherwise silently drop them.
  if (event.type === 'placeCall') {
    return { state, effects: [{ type: 'reportBusy' }] };
  }
  if (event.type === 'offerReceived' && event.cid !== call.cid) {
    // Glare: their invite crossed ours in flight (§6.5).
    //
    // `event.peerId === call.peerId` is the whole definition of glare and was
    // missing. Without it ANY offer arriving while you dialled was resolved as
    // glare, and the loser branch auto-answers: dial Alice, have Bob's offer
    // land in the same second, and Bob's call is accepted with no ring, no
    // prompt and no chance to decline — camera and microphone live to someone
    // you were not calling. It needs no collusion with Alice, only that Bob
    // guesses you are on the phone, and it beats the unknown-caller policy
    // because that runs in the controller for calls that RING.
    //
    // Two people cannot glare on a call they are not both party to, so the
    // check is also just what glare means.
    if (
      event.peerId === call.peerId &&
      (state.name === 'outgoing_connecting' || state.name === 'outgoing_ringing')
    ) {
      return resolveGlare(state, call, event, now);
    }
    // Otherwise we are simply busy, and they deserve to know at once rather
    // than listening to a ringback until their own timeout fires.
    return {
      state,
      effects: [
        {
          type: 'sendEnvelope',
          peerId: event.peerId,
          envelope: { tcm: 'call.end', cid: event.cid, r: 'busy' },
          urgent: false,
        },
      ],
    };
  }

  if (!addressesThisCall(event, call)) return NOTHING(state);

  switch (event.type) {
    // --- terminal, from anywhere -------------------------------------------
    case 'endReceived':
      return state.name === 'ending'
        ? NOTHING(state)
        : endCall(call, event.reason, now, false);

    case 'localHangup':
    case 'callKitEnded': {
      if (state.name === 'ending') return NOTHING(state);
      // Before the callee answered, "I hung up" is a cancellation — that is
      // what makes it a MISSED call on their side rather than a completed one.
      const reason: CallEndReason = call.connectedAt ? 'hangup' : 'cancelled';
      return endCall(call, reason, now, true);
    }

    case 'appTerminating':
      return state.name === 'ending'
        ? NOTHING(state)
        : endCall(call, call.connectedAt ? 'hangup' : 'cancelled', now, true);

    case 'callKitFailedToActivateAudio':
      // A call with no audio route is not a call. Fail it loudly.
      return state.name === 'ending'
        ? NOTHING(state)
        : endCall(call, 'failed_media', now, true);

    case 'teardownComplete':
      return state.name === 'ending' ? NOTHING(idleState()) : NOTHING(state);

    // --- media negotiation --------------------------------------------------
    case 'ringingReceived':
      if (state.name !== 'outgoing_connecting') return NOTHING(state);
      return {
        state: { name: 'outgoing_ringing', call },
        effects: [{ type: 'startTimer', timer: 'ring', ms: CALL_RING_TIMEOUT_MS }],
      };

    case 'answerReceived': {
      // `reconnecting` belongs here with the two outgoing states: it is where
      // the side that SENT a `call.restart` waits, and the reply to a restart
      // is an ordinary `call.answer`. Without it the restarting device threw
      // away the very answer it had asked for, so the round trip could never
      // complete and every mid-call network change still ended in
      // `failed_media` when the 30-second window expired — the other half of
      // the bug whose callee side was fixed in `restartReceived` below.
      //
      // `connected` is deliberately NOT accepted: an unsolicited answer for a
      // call already carrying media is not a recovery, and applying a remote
      // description to a healthy connection would renegotiate it for free.
      if (
        state.name !== 'outgoing_connecting' &&
        state.name !== 'outgoing_ringing' &&
        state.name !== 'reconnecting'
      ) {
        return NOTHING(state);
      }
      // Every outbound leg needs the answer timestamp: group legs deliberately
      // carry `reportId: null` so they cannot create direct metric rows, but
      // their authoritative session still has to observe the remote answer.
      // Reporting authority controls only the effect, never the lifecycle
      // fact stored on the call context.
      const firstAnswer = call.direction === 'out' && call.answeredAt === null;
      const reportAnswer = firstAnswer && call.reportId !== null;
      const next: CallContext = {
        ...call,
        remoteReady: true,
        pendingIce: [],
        // Only the FIRST answer speaks for the callee's camera. A restart
        // answer echoes `vid: call.video` (`restartReceived` below), which is
        // written at accept and never again — camera toggles move only the
        // app layer's `localMedia.videoEnabled` and are announced via
        // `call.media`, which `mediaReceived` folds into `peerVideo`. So a
        // later answer's `vid` is STALER than what this machine already
        // holds, and believing it flipped `peerVideo` back on after the peer
        // turned their camera off: their photo unmounted and the video
        // surface kept presenting the last decoded frame — a frozen still
        // shown as live video until the peer toggled again. `remoteReady` is
        // the discriminator rather than `state.name === 'reconnecting'`
        // because it is the per-call latch for "an answer has already been
        // applied": it also refuses a REDELIVERED first answer still in
        // `outgoing_connecting`, and an unsolicited answer to a callee —
        // the same clobber through other doors.
        peerVideo: call.remoteReady ? call.peerVideo : event.video,
        // `answeredAt` is a SEPARATE latch and deliberately not unified with
        // `remoteReady` above: it is scoped to the outbound leg only (see
        // `firstAnswer`), whereas `remoteReady` spans both directions so it
        // can also refuse an unsolicited answer to a callee. They agree on
        // the outbound leg — `remoteReady` is written true here and at accept,
        // `answeredAt` starts null and is written once — so the two latches
        // coincide where they overlap and neither can be derived from the
        // other where they do not.
        answeredAt: firstAnswer ? now : call.answeredAt,
      };
      const effects: CallEffect[] = [
        ...(reportAnswer
          ? [{ type: 'answerCallMetric', localId: call.cid, answeredAt: now } as CallEffect]
          : []),
        { type: 'setRemoteAnswer', cid: call.cid, sdp: event.sdp },
      ];
      if (call.pendingIce.length > 0) {
        effects.push({
          type: 'addIceCandidates',
          cid: call.cid,
          candidates: call.pendingIce,
        });
      }
      // Stay in outgoing_connecting: "ringing" was only ever a UI state, and
      // the call is not connected until ICE says so.
      //
      // Except when reconnecting, which must stay reconnecting. Forcing
      // `outgoing_connecting` there would cancel nothing but would relabel a
      // recovering call as one that is still dialling — wrong on the screen,
      // and flatly false for an INCOMING call that lost ICE, which has
      // direction 'in' and never dialled anything. ICE moves it to
      // `connected` either way.
      if (state.name === 'reconnecting') {
        return { state: { name: 'reconnecting', call: next }, effects };
      }
      return { state: { name: 'outgoing_connecting', call: next }, effects };
    }

    case 'restartReceived': {
      /**
       * A restart is only meaningful for a call that has ALREADY connected —
       * it is how a live call survives a network change (§7.6). Accepting one
       * in any other state was a way for the caller to reach into the
       * callee's device before they had agreed to anything:
       *
       *   offer, then immediately restart with the same cid → the reducer
       *   emits `createAnswer` → the executor builds the peer connection and
       *   adds local media → the CAMERA starts and ICE gathering begins →
       *   the callee's host candidates are sent to the caller.
       *
       * All while the phone is still ringing and nobody has answered. The
       * microphone was safe because the audio unit waits for CallKit's
       * `didActivate` (§7.4); the camera had no equivalent gate, and the
       * candidates are the callee's IP addresses.
       *
       * `connected` and `reconnecting` are the only states where a restart
       * has anything to restart.
       */
      if (state.name !== 'connected' && state.name !== 'reconnecting') {
        return NOTHING(state);
      }
      return {
        state,
        effects: [
          { type: 'createAnswer', cid: call.cid, remoteSdp: event.sdp, withVideo: call.video },
          // ...and SEND it. Without this the answer was produced, stored in
          // the executor's `pendingSdp`, and consumed by nothing: the peer
          // that restarted got no reply, the restart never completed, and
          // every mid-call network change ended in `failed_media` after the
          // 30-second reconnect window. A recovery path that cannot recover.
          send(call, { tcm: 'call.answer', cid: call.cid, sdp: '', vid: call.video }),
        ],
      };
    }

    case 'iceReceived': {
      if (state.name === 'ending') return NOTHING(state);
      if (call.remoteReady) {
        return {
          state,
          effects: event.candidates.length
            ? [{ type: 'addIceCandidates', cid: call.cid, candidates: event.candidates }]
            : [],
        };
      }
      // Buffer until there is a remote description to attach them to, bounded
      // so a candidate flood cannot grow this state without limit (§3.6).
      const room = MAX_ICE_CANDIDATES_PER_CALL - call.pendingIce.length;
      if (room <= 0) return NOTHING(state);
      return NOTHING({
        ...state,
        call: {
          ...call,
          pendingIce: [...call.pendingIce, ...event.candidates.slice(0, room)],
        },
      });
    }

    case 'mediaReceived':
      if (state.name === 'ending') return NOTHING(state);
      return NOTHING({
        ...state,
        call: { ...call, peerAudio: event.audio, peerVideo: event.video },
      });

    // --- accepting ----------------------------------------------------------
    case 'localAccept':
      if (state.name !== 'incoming_ringing') return NOTHING(state);
      return acceptIncoming(call, now, event.video ?? true);

    // Answering from the CallKit UI or the lock screen takes the call as
    // offered: the system UI has no audio-only affordance to honour.
    case 'callKitAnswered':
      if (state.name !== 'incoming_ringing') return NOTHING(state);
      return acceptIncoming(call, now);

    case 'localDecline':
      if (state.name !== 'incoming_ringing') return NOTHING(state);
      return endCall(call, 'decline', now, true);

    case 'incomingReportFailed':
      // CallKit REFUSED to present the ring — an active native call, say.
      // Found by review: the refusal was swallowed as an effect failure, so
      // the machine kept ringing a call the callee could not see — the
      // caller heard ringing until the timeout, answered by nobody, ever.
      // Busy is the honest signal: this device cannot take the call.
      // `incoming_answering` too: a glare loser adopts the peer's call
      // STRAIGHT into that state (§6.5) and reports it to CallKit from
      // there — a refusal there is the same ghost call, one state later.
      if (
        (state.name !== 'incoming_ringing' && state.name !== 'incoming_answering') ||
        call.cid !== event.cid
      ) {
        return NOTHING(state);
      }
      return endCall(call, 'busy', now, true);

    // --- connection lifecycle -----------------------------------------------
    case 'iceStateChanged': {
      if (state.name === 'ending') return NOTHING(state);
      if (event.ice === 'connected') {
        if (state.name === 'connected') return NOTHING(state);
        const next: CallContext = { ...call, connectedAt: call.connectedAt ?? now };
        return {
          state: { name: 'connected', call: next },
          effects: [
            ...(call.direction === 'out' && call.reportId !== null && call.connectedAt === null
              ? [{ type: 'connectCallMetric', localId: call.cid, connectedAt: now } as CallEffect]
              : []),
            { type: 'cancelTimer', timer: 'ring' },
            { type: 'cancelTimer', timer: 'connect' },
            { type: 'cancelTimer', timer: 'reconnect' },
            { type: 'reportConnected', cid: call.cid },
          ],
        };
      }
      if (state.name !== 'connected') return NOTHING(state);
      return {
        state: { name: 'reconnecting', call },
        effects: [
          { type: 'startTimer', timer: 'reconnect', ms: CALL_RECONNECT_TIMEOUT_MS },
          // Restart HERE, not only on `networkChanged`.
          //
          // §7.6 specified the restart as a response to a network change, and
          // the transition for it exists and is tested — but nothing in the
          // app ever dispatches `networkChanged`. There is no network
          // observer, and no dependency that would provide one. So the entire
          // recovery path was unreachable in the shipping build: a call that
          // lost ICE sat in `reconnecting` doing nothing until the 30-second
          // timeout ended it as `failed_media`.
          //
          // Losing ICE IS the observation. It is also a better one than a
          // network-interface event, which fires on changes that cost the
          // call nothing. `networkChanged` stays as a second trigger for a
          // future observer; both are idempotent enough, because this only
          // fires on the single `connected` → `reconnecting` edge.
          //
          // Still only the caller (§7.6) — a fixed initiator is what stops the
          // two ends restarting at each other.
          ...(call.direction === 'out'
            ? ([
                { type: 'restartIce', cid: call.cid },
                send(call, { tcm: 'call.restart', cid: call.cid, sdp: '' }),
              ] as CallEffect[])
            : []),
        ],
      };
    }

    case 'networkChanged': {
      if (state.name !== 'reconnecting') return NOTHING(state);
      // A fixed initiator avoids restart glare entirely (§7.6): the side that
      // sent the original offer owns every restart.
      if (call.direction !== 'out') return NOTHING(state);
      return {
        state,
        effects: [
          { type: 'restartIce', cid: call.cid },
          send(call, { tcm: 'call.restart', cid: call.cid, sdp: '' }),
        ],
      };
    }

    // --- timers -------------------------------------------------------------
    case 'ringTimeout':
      if (state.name === 'ending') return NOTHING(state);
      if (state.name === 'incoming_ringing' || state.name === 'outgoing_ringing') {
        return endCall(call, 'timeout', now, true);
      }
      return NOTHING(state);

    case 'connectTimeout':
      if (state.name === 'ending' || state.name === 'connected') return NOTHING(state);
      return endCall(call, 'failed_ice', now, true);

    case 'reconnectTimeout':
      if (state.name !== 'reconnecting') return NOTHING(state);
      return endCall(call, 'failed_media', now, true);

    case 'offerReceived':
      // Handled above, before the addressing guard. Reaching here means the
      // cid matches the live call — a redelivery, which §9.5 dedupes to
      // nothing. (`placeCall` is narrowed out entirely by the early return.)
      return NOTHING(state);
  }
}

function fromIdle(state: CallState, event: CallEvent, now: number): Step {
  switch (event.type) {
    case 'placeCall': {
      const call = newContext({
        cid: event.cid,
        peerId: event.peerId,
        direction: 'out',
        video: event.video,
        now,
        reportId: event.reportId,
      });
      return {
        state: { name: 'outgoing_connecting', call },
        effects: [
          ...(call.reportId !== null
            ? [{
                type: 'openCallMetric' as const,
                reportId: call.reportId,
                localId: call.cid,
                media: call.video ? 'video' as const : 'audio' as const,
                startedAt: now,
              }]
            : []),
          { type: 'createOffer', cid: call.cid, withVideo: event.video },
          { type: 'reportOutgoingCall', cid: call.cid, peerId: call.peerId, hasVideo: event.video },
          // Urgent: this is the frame that wakes a sleeping phone (§5.3).
          send(
            call,
            {
              tcm: 'call.offer',
              cid: call.cid,
              sdp: '',
              vid: event.video,
              exp: now + OFFER_TTL_MS,
            },
            true,
          ),
          { type: 'startTimer', timer: 'connect', ms: CALL_CONNECT_TIMEOUT_MS },
        ],
      };
    }

    case 'offerReceived': {
      const call = newContext({
        cid: event.cid,
        peerId: event.peerId,
        direction: 'in',
        video: event.video,
        now,
        reportId: null,
        remoteOfferSdp: event.sdp,
      });
      // Ringing a phone for a call that is already over is the one thing this
      // must never do — a device offline for an hour would otherwise ring for
      // an invite that expired 59 minutes ago (§6.4).
      const expired =
        now > event.exp + OFFER_EXP_SKEW_MS ||
        now - event.serverTs > OFFER_MAX_SERVER_AGE_MS;
      if (expired) {
        return {
          state: idleState(),
          effects: logRow(call, 'expired', now),
        };
      }
      return {
        state: { name: 'incoming_ringing', call },
        effects: [
          {
            type: 'reportIncomingCall',
            cid: call.cid,
            peerId: call.peerId,
            hasVideo: event.video,
          },
          send(call, { tcm: 'call.ringing', cid: call.cid }),
          { type: 'startTimer', timer: 'ring', ms: CALL_RING_TIMEOUT_MS },
        ],
      };
    }

    default:
      // Everything else addresses a call that no longer exists.
      return NOTHING(state);
  }
}

/**
 * @param withVideo what the USER chose. "Answer without video" on a video
 * call has to reach the SDP — the camera is started by `addLocalMedia`, which
 * is driven by the `createAnswer` effect's `withVideo`, so a screen that
 * offers the choice and then answers as offered turns the camera on anyway.
 * Never upgrades: accepting an audio call cannot add video.
 */
function acceptIncoming(call: CallContext, _now: number, withVideo = true): Step {
  const video = call.video && withVideo;
  const accepted: CallContext = { ...call, video };
  const effects: CallEffect[] = [
    { type: 'createAnswer', cid: call.cid, remoteSdp: call.remoteOfferSdp, withVideo: video },
    send(call, { tcm: 'call.answer', cid: call.cid, sdp: '', vid: video }),
    { type: 'cancelTimer', timer: 'ring' },
    { type: 'startTimer', timer: 'connect', ms: CALL_CONNECT_TIMEOUT_MS },
  ];
  if (call.pendingIce.length > 0) {
    effects.push({
      type: 'addIceCandidates',
      cid: call.cid,
      candidates: call.pendingIce,
    });
  }
  return {
    state: {
      name: 'incoming_answering',
      call: { ...accepted, remoteReady: true, pendingIce: [] },
    },
    effects,
  };
}

/**
 * Simultaneous invites (§6.5). Both sides compare the two cids and the LARGER
 * one wins — a rule that is symmetric, needs no round trip, and cannot favour
 * the same person forever the way comparing userIds would. ULIDs are
 * time-ordered with random low bits, so ties are effectively impossible.
 *
 * The side holding the smaller cid abandons its own outgoing call and adopts
 * the winner. It auto-accepts rather than ringing: this user already tapped
 * Call on this person, so asking them again would be theatre.
 */
function resolveGlare(
  state: CallState,
  ours: CallContext,
  event: Extract<CallEvent, { type: 'offerReceived' }>,
  now: number,
): Step {
  if (ours.cid > event.cid) {
    // We win: kill their invite, keep ours untouched.
    return {
      state,
      effects: [
        {
          type: 'sendEnvelope',
          peerId: event.peerId,
          envelope: { tcm: 'call.end', cid: event.cid, r: 'glare_lost' },
          urgent: false,
        },
      ],
    };
  }

  // We lose: abandon ours (no log row — this was never a call), adopt theirs.
  // Their SDP comes along, because the very next thing this does is accept —
  // and an accept with no offer to answer produces nothing.
  const theirs = newContext({
    cid: event.cid,
    peerId: event.peerId,
    direction: 'in',
    video: event.video,
    now,
    reportId: null,
    remoteOfferSdp: event.sdp,
  });
  const accepted = acceptIncoming(theirs, now);
  return {
    state: accepted.state,
    effects: [
      send(ours, { tcm: 'call.end', cid: ours.cid, r: 'glare_lost' }),
      ...(ours.reportId !== null ? [{ type: 'discardCallMetric' as const, localId: ours.cid }] : []),
      { type: 'closePeerConnection', cid: ours.cid },
      // OUR CallKit call must be released, and by OUR cid.
      //
      // `reportOutgoingCall(ours.cid)` created a CallKit call under a UUID
      // minted for that cid. Ending only the adopted call would mint a fresh
      // UUID for a call CallKit had never been told about, leaving the
      // original alive: a system-level active-call UI — green pill, an entry
      // in the phone's call list — that no in-app action could dismiss and
      // that survived until the app was killed.
      //
      // No log row: glare bookkeeping is not a call and must never appear in
      // a thread (§6.5), which `isLoggable` already enforces.
      { type: 'endCallKit', cid: ours.cid, reason: 'glare_lost' },
      { type: 'cancelTimer', timer: 'connect' },
      // The adopted call is reported to CallKit as an INCOMING one, because
      // that is what it now is. Without this, every later effect naming
      // `theirs.cid` — the connect report, the eventual end — addresses a UUID
      // CallKit has never seen, so its timers and its UI are wrong for the
      // only call actually running.
      {
        type: 'reportIncomingCall',
        cid: theirs.cid,
        peerId: theirs.peerId,
        hasVideo: event.video,
      },
      ...accepted.effects,
    ],
  };
}
