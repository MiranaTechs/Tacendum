import { shortId } from '../person';
import {
  callReducer,
  idleState,
  type CallEffect,
  type CallEndReason,
  type CallEnvelope,
  type CallEvent,
  type CallState,
  type IceCandidate,
  type IceServer,
  ICE_BATCH_WINDOW_MS,
  MAX_ICE_CANDIDATES_PER_ENVELOPE,
  MAX_ICE_CANDIDATES_PER_CALL,
} from '@tacendum/shared';

/**
 * The call service: it executes what the reducer decides.
 *
 * The split is the whole design. `callReducer` is pure — it holds the protocol
 * and can be tested exhaustively without a device — and this file is the only
 * place that touches the native module, the clock, or the network. Effects are
 * *data* the reducer emits; running them is a mechanical translation with no
 * decisions of its own.
 *
 * Two consequences fall out, and both were the point: the call protocol is
 * verifiable on a laptop (the CLI gate at the design drives this same reducer), and
 * an Android port is an adapter rewrite rather than a redesign.
 */

/** The native surface this service needs. Injected, so the tests are real
 * tests of this file rather than tests of a mocking framework. */
export interface CallNative {
  configure(iceServers: IceServer[], relayOnly: boolean): Promise<void>;
  createOffer(cid: string, withVideo: boolean): Promise<string>;
  createAnswer(cid: string, remoteOfferSdp: string, withVideo: boolean): Promise<string>;
  setRemoteAnswer(cid: string, sdp: string): Promise<void>;
  addIceCandidates(cid: string, candidates: IceCandidate[]): Promise<void>;
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
  endCall(cid: string, reason: string): Promise<void>;
}

export interface CallLogRow {
  cid: string;
  peerId: string;
  direction: 'in' | 'out';
  kind: 'audio' | 'video';
  reason: CallEndReason;
  startedAt: number;
  connectedAt: number | null;
  endedAt: number;
  missed: boolean;
}

export interface CallTransport {
  /** Ratcheted send. Throws for a blocked peer and in duress (messaging.ts). */
  sendCallEnvelope(peerId: string, envelope: CallEnvelope, opts: { urgent: boolean }): Promise<void>;
}

/** The lifecycle writer is injected so call signalling never depends on it. */
export interface CallMetricSink {
  open(input: { reportId: string; localId: string; scope: 'direct' | 'group'; media: 'audio' | 'video'; startedAt: number }): Promise<void>;
  answered(localId: string, at: number): Promise<void>;
  connected(localId: string, at: number): Promise<void>;
  peak(localId: string, participants: number): Promise<void>;
  finalize(localId: string, reason: CallEndReason, endedAt: number): Promise<void>;
  discard(localId: string): Promise<void>;
}

export interface CallServiceDeps {
  native: CallNative;
  transport: CallTransport;
  writeLog(row: CallLogRow): Promise<void>;
  /**
   * What CallKit shows.
   *
   * There used to be a second `handleFor` returning the opaque id, on the
   * reasoning that a Tacendum identity is not a phone number so the handle
   * should be the id and the NAME should be the label. That reasoning was
   * wrong in practice: the full-screen incoming-call UI shows the HANDLE, and
   * only the banner shows the label — so a correct-looking notification sat
   * above a full screen announcing a raw ULID.
   *
   * There is no addressable handle to preserve. The id is not something a
   * person can dial or recognise, and CallKit keys the call by UUID
   * internally, so nothing depended on it being there.
   */
  /** Async because the name lives in SQLite, not in memory. Both call sites
   * are already inside `await`ed effect execution. */
  displayNameFor(peerId: string): Promise<string>;
  now(): number;
  onStateChange?(state: CallState): void;
  metrics?: CallMetricSink;
  /**
   * Last look at the reducer's output before this service runs it
   * (the designed hook, verbatim).
   *
   * Absent ⇒ identity, which is the whole safety argument: every shipped 1:1
   * path runs without ever touching this, and a byte-level trace of a full
   * 1:1 call is snapshotted on both sides of the seam
   * (`app/__tests__/call.trace.test.ts`) so a leak shows as a diff rather
   * than as a field report.
   *
   * Its ONE caller is the small-group coordinator, which runs one of these
   * services per leg and strips the four CallKit effect types
   * (`reportIncomingCall`, `reportOutgoingCall`, `reportConnected`,
   * `endCallKit`): N legs are ONE conversation and must be ONE CXCall (rule
   * 26), and the session derives that aggregate from leg LIFECYCLE — so a
   * stripped effect carries no information the session does not already
   * hold. It is a filter and not a rewrite on purpose: a hook that could
   * ADD effects would let a caller drive the native module through a path
   * the reducer never authorised.
   *
   * Applied before `onStateChange` fires, which is also load-bearing: the
   * terminal reason lives only on `endCallKit`, and the coordinator reads it
   * there so its `legStateChanged` can say *why* a leg ended.
   */
  filterEffects?(effects: CallEffect[]): CallEffect[];
}

/**
 * Envelopes whose delivery a call cannot survive.
 *
 * The offer and the answer ARE the call as far as the peer is concerned; a
 * restart is what recovers one. If any of the three cannot be sent, the other
 * end will never know this call exists, so pretending to dial is a lie the UI
 * would tell for 45 seconds.
 */
const FATAL_TO_SEND: ReadonlySet<string> = new Set([
  'call.offer',
  'call.answer',
  'call.restart',
]);

/** A name safe to log: never the message, which is where a cid, an SDP, or a
 * candidate address would be if one leaked into it. */
function errorName(err: unknown): string {
  return err instanceof Error ? err.name : 'unknown';
}

export class CallService {
  private state: CallState = idleState();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  /**
   * SDP produced by the effect immediately preceding a `sendEnvelope`
   * template.
   *
   * The reducer emits `createOffer` and then a `call.offer` whose `sdp` is the
   * empty string, because a reducer cannot know an SDP. This holds the real
   * one between those two effects. If it is missing when the template comes
   * up, the envelope is NOT sent and the call fails — an empty SDP on the wire
   * is a call the peer can never connect, and the contract in the reducer says
   * so explicitly.
   */
  private pendingSdp: string | null = null;
  private iceBuffer: IceCandidate[] = [];
  private iceFlush: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deps: CallServiceDeps) {}

  get current(): CallState {
    return this.state;
  }

  /** Install relay credentials. Must precede the first call. */
  configure(iceServers: IceServer[], relayOnly: boolean): Promise<void> {
    return this.deps.native.configure(iceServers, relayOnly);
  }

  // --- driving the machine ------------------------------------------------

  async dispatch(event: CallEvent): Promise<void> {
    // THE OWNER IS GONE.
    //
    // `dispose()` is the abrupt seam — a relock, an account deletion, the
    // teardown `startCalling` returns, a small-group session torn down under
    // its legs. It used to release timers and nothing else, which was enough
    // for the 1:1 shape it was written for: there, the only caller was the
    // app itself and nobody was mid-dispatch when it ran.
    //
    // The small-group coordinator runs one of these per leg and awaits an
    // entire `dispatch()` from inside its own fenced effect loop. So a leg
    // suspended in `createOffer` when the coordinator disposes came back and
    // carried on: it composed a send, armed a connect timer, and wrote a log
    // row for a session that no longer existed anywhere. The coordinator's
    // fence could not see it, because the fence is one layer up.
    //
    // Checked at entry and again after every await in the loop below, which
    // is where disposal lands.
    if (this.disposed) return;
    const previousCid = this.state.call?.cid ?? null;
    const previousName = this.state.name;
    const { state, effects: produced } = callReducer(this.state, event, this.deps.now());
    // The seam. Absent ⇒ identity — literally the same array object,
    // so the no-filter path is not merely equivalent, it is unchanged.
    const effects = this.deps.filterEffects ? this.deps.filterEffects(produced) : produced;
    const runningCid = state.call?.cid ?? null;
    this.state = state;

    // Per-call scratch state, reset whenever the CALL changes.
    //
    // The `ending` block below does this too, but `ending` is not the only way
    // to leave a call: glare abandons our outgoing call and adopts the
    // peer's in a single transition, straight from `outgoing_connecting` to
    // `incoming_answering`. Candidates gathered for the abandoned cid were
    // still in the buffer and were flushed under the ADOPTED cid — candidates
    // describing paths to a peer connection that no longer exists — and
    // `iceSentThisCall` carried over, so the adopted call started part-way
    // through its own budget.
    if (runningCid !== previousCid) {
      this.pendingSdp = null;
      this.iceBuffer = [];
      this.iceSentThisCall = 0;
    }

    this.deps.onStateChange?.(state);
    for (const effect of effects) {
      if (this.disposed) return;
      try {
        await this.run(effect);
      } catch (err) {
        // One failed effect must not strand the call in a half-torn-down
        // state with the rest of its teardown unrun. Report and continue;
        // the terminal paths are ordered so the important ones come first.
        //
        // The effect TYPE and the error's name only. Logging the error object
        // would put whatever the native module put in its message into the
        // log — which has included a cid, and could include an SDP or a
        // candidate address, i.e. the other person's IP (addendum 8).
        console.warn(`[call] effect ${effect.type} failed: ${errorName(err)}`);
      }

      // A fatal send (see `run`) re-enters `dispatch` from INSIDE this loop
      // and tears the call down completely before returning here. The effects
      // still queued belong to a call that no longer exists, and running them
      // acts on it: a `startTimer` arms a connect timeout that will later fire
      // against whatever call is live by then, and a `reportOutgoingCall`
      // hands CallKit a call nothing can end.
      //
      // Compared by cid rather than by "is idle", so it also covers a
      // re-entrant transition that swaps one call for another.
      if ((this.state.call?.cid ?? null) !== runningCid) break;
    }
    if (this.disposed) return;

    // `ending` is a TEARDOWN state, not a terminal one: the reducer waits in
    // it until the executor confirms the peer connection is closed and
    // CallKit released, and only `teardownComplete` returns it to idle.
    //
    // Nothing dispatched that. The consequence was one call per app launch —
    // the machine sat in `ending` forever with `call` non-null, so the
    // full-screen call UI stayed mounted showing "Ending…", its hangup button
    // was a no-op, every later outgoing call got `reportBusy`, and every later
    // incoming offer was auto-answered `busy`. The user was unreachable until
    // they killed the app.
    //
    // The machine test asserted the transition EXISTS. It never asserted that
    // anything triggers it, and no test placed a second call after a first —
    // which is exactly the shape of a vacuous pass.
    //
    // Guarded against re-entry: `teardownComplete` from `ending` produces no
    // further effects, so this recurses exactly once.
    // OWNERSHIP, not observation: only the dispatch whose reducer PRODUCED
    // the ending transition collapses it. The old condition fired for ANY
    // dispatch that merely observed 'ending' — and with two effect loops
    // interleaved (a teardown suspended at its announce send while another
    // dispatch's loop resumed), the observer's eager collapse nulled the
    // call out from under the suspended teardown, which then broke out of
    // its loop before cancelTimer, closePeerConnection, endCallKit and the
    // log row. A hung-up call could keep its peer connection; a busy or
    // decline row could vanish.
    // Ownership is proven by THIS dispatch's reducer output — the LOCAL
    // `state`, not the shared `this.state`. The shared read was falsifiable:
    // a dispatch that started while the call was still ringing (previousName
    // captured non-ending) could resume after a concurrent teardown began
    // and find this.state 'ending' — passing the old check and collapsing a
    // transition it never produced, under the suspended teardown that did.
    // The shared-state conditions then merely confirm the ending call this
    // dispatch produced is still the live one.
    if (
      state.name === 'ending' &&
      previousName !== 'ending' &&
      event.type !== 'teardownComplete' &&
      this.state.name === 'ending' &&
      this.state.call?.cid === state.call?.cid
    ) {
      this.pendingSdp = null;
      // Candidates gathered for the call that just died must not be sent
      // under the NEXT call's cid.
      this.iceBuffer = [];
      this.iceSentThisCall = 0;
      await this.dispatch({ type: 'teardownComplete' });
    }

    // A CallKit report refusal noted mid-loop (see the reportIncomingCall
    // effect). Handled HERE, sequentially, after this dispatch's effects have
    // fully settled — the recursion terminates because the flag is consumed
    // before re-entering and the teardown it triggers cannot set it again.
    const refusedCid = this.reportFailedCid;
    if (refusedCid !== null) {
      this.reportFailedCid = null;
      if (this.state.call?.cid === refusedCid) {
        await this.dispatch({ type: 'incomingReportFailed', cid: refusedCid });
      }
    }
  }

  /** cid whose CallKit report was refused mid-effects; consumed by dispatch's tail. */
  private reportFailedCid: string | null = null;

  /** How many we have SENT for the current call. Reset per call. */
  private iceSentThisCall = 0;

  /** A local candidate the native module gathered. Batched. */
  queueLocalIce(candidate: IceCandidate): void {
    if (!this.state.call) return;
    // The cap was enforced only on the INBOUND buffer. Outbound was
    // unbounded, and `gatherContinually` on a flapping network keeps
    // producing candidates indefinitely — each batch costing a ratchet step
    // and a slice of the per-user send budget for connectivity that was
    // settled long ago.
    if (this.iceSentThisCall + this.iceBuffer.length >= MAX_ICE_CANDIDATES_PER_CALL) return;
    this.iceBuffer.push(candidate);
    if (this.iceBuffer.length >= MAX_ICE_CANDIDATES_PER_ENVELOPE) {
      void this.flushIce();
      return;
    }
    this.iceFlush ??= setTimeout(() => void this.flushIce(), ICE_BATCH_WINDOW_MS);
  }

  /**
   * Send the buffered candidates.
   *
   * Serialized against itself with `iceSending`: two overlapping sends each
   * advance the Double Ratchet, and if they interleave the peer rejects the
   * second as a duplicate counter and silently loses those candidates. That
   * is not hypothetical — it is exactly what the CLI gate caught (the design
   * check 3), where twelve candidates became ten and looked like a batching
   * bug rather than a ratchet one.
   */
  private iceSending: Promise<void> = Promise.resolve();

  async flushIce(): Promise<void> {
    if (this.iceFlush) {
      clearTimeout(this.iceFlush);
      this.iceFlush = null;
    }
    // A LOOP inside one chained task, not recursion into flushIce().
    // Recursing would re-enter the chain and await the very task doing the
    // awaiting — a deadlock that presents as ICE simply never being sent, and
    // therefore as a call that rings and then never connects.
    const run = this.iceSending.then(async () => {
      for (;;) {
        const call = this.state.call;
        if (!call || this.iceBuffer.length === 0) return;
        const batch = this.iceBuffer.splice(0, MAX_ICE_CANDIDATES_PER_ENVELOPE);
        this.iceSentThisCall += batch.length;
        await this.deps.transport.sendCallEnvelope(
          call.peerId,
          { tcm: 'call.ice', cid: call.cid, c: batch },
          { urgent: false },
        );
      }
    });
    this.iceSending = run.catch(() => undefined);
    return run;
  }

  // --- effects ------------------------------------------------------------

  private async run(effect: CallEffect): Promise<void> {
    const { native, transport, deps } = { native: this.deps.native, transport: this.deps.transport, deps: this.deps };

    switch (effect.type) {
      case 'openCallMetric':
        await deps.metrics?.open({
          reportId: effect.reportId,
          localId: effect.localId,
          scope: 'direct',
          media: effect.media,
          startedAt: effect.startedAt,
        });
        break;

      case 'answerCallMetric':
        await deps.metrics?.answered(effect.localId, effect.answeredAt);
        break;

      case 'connectCallMetric':
        await deps.metrics?.connected(effect.localId, effect.connectedAt);
        break;

      case 'finalizeCallMetric':
        await deps.metrics?.finalize(effect.localId, effect.reason, effect.endedAt);
        break;

      case 'discardCallMetric':
        await deps.metrics?.discard(effect.localId);
        break;

      case 'createOffer':
        this.pendingSdp = await native.createOffer(effect.cid, effect.withVideo);
        break;

      case 'createAnswer':
        this.pendingSdp = await native.createAnswer(
          effect.cid,
          effect.remoteSdp,
          effect.withVideo,
        );
        break;

      case 'restartIce':
        this.pendingSdp = await native.restartIce(effect.cid);
        break;

      case 'setRemoteAnswer':
        await native.setRemoteAnswer(effect.cid, effect.sdp);
        break;

      case 'addIceCandidates':
        await native.addIceCandidates(effect.cid, effect.candidates);
        break;

      case 'closePeerConnection':
        await native.close(effect.cid);
        break;

      case 'sendEnvelope': {
        const envelope = this.fillTemplate(effect.envelope);
        if (!envelope) {
          // The SDP this template needed was never produced. Sending an empty
          // one would put an unconnectable call on the wire, so fail the call
          // instead — loudly, and through the same terminal path as any other
          // failure so the log row and CallKit teardown still happen.
          await this.dispatch({ type: 'localHangup' });
          return;
        }
        try {
          await transport.sendCallEnvelope(effect.peerId, envelope, { urgent: effect.urgent });
        } catch (err) {
          // A send can be REFUSED rather than merely fail: a duress session is
          // network-silent and a blocked peer must never
          // be rung, and messaging enforces both by throwing.
          //
          // For the frames that establish a call, a refusal is terminal — the
          // peer will never hear about this call, so continuing means the
          // person watches "Calling…" until the 45-second connect timeout
          // while CallKit shows a call they cannot dismiss and the next call
          // is refused as "already active".
          if (FATAL_TO_SEND.has(envelope.tcm)) {
            await this.dispatch({ type: 'localHangup' });
            return;
          }
          // Everything else degrades. A dropped ICE batch costs a candidate,
          // not the call, and an `end` that cannot be sent is moot — we are
          // ending regardless.
          throw err;
        }
        break;
      }

      case 'reportOutgoingCall':
        await native.reportOutgoingCall(
          effect.cid,
          await deps.displayNameFor(effect.peerId),
          effect.hasVideo,
        );
        break;

      case 'reportIncomingCall': {
        // One lookup, and the peerId rides along as the rebind's correlation
        // key: the VoIP push rang this call under a synthetic cid, and the
        // native side matches on the caller to re-key that ring rather than
        // start a second one.
        //
        // The name crosses this seam only when the database actually KNOWS
        // one. displayNameFor's fallback is a shortened ULID, and passing it
        // here had the native side stamp it over the placeholder — or over
        // the mirror name the push path had already shown — making the
        // controller's guarded later correction moot. Empty string means
        // "you decide": the native side consults its mirror, then keeps an
        // honest placeholder.
        const name = await deps.displayNameFor(effect.peerId);
        const known = name !== shortId(effect.peerId);
        try {
          await native.reportIncomingCall(
            effect.cid,
            effect.peerId,
            known ? name : '',
            known ? name : '',
            effect.hasVideo,
          );
        } catch (err) {
          // CallKit refused the ring. Swallowing this left the machine
          // ringing a call the callee cannot see. FLAGGED, not dispatched:
          // an inline re-entry would let this transition's remaining effects
          // run against a call being torn down, and a microtask interleaves
          // two effect loops — the first one's eager teardownComplete then
          // nulls the call out from under the second, which broke out of its
          // loop before the log row. The tail of dispatch() picks the flag
          // up once this loop has fully settled.
          console.warn(`[call] reportIncomingCall refused: ${errorName(err)}`);
          this.reportFailedCid = effect.cid;
        }
        break;
      }

      case 'reportConnected':
        await native.reportOutgoingConnected(effect.cid);
        break;

      case 'endCallKit':
        await native.endCall(effect.cid, effect.reason);
        break;

      case 'reportBusy':
        // Nothing to show: the incoming call was answered with `busy` by the
        // reducer and the peer is being told. Surfacing a second UI here
        // would announce a call the user never had.
        break;

      case 'writeLog':
        await deps.writeLog({
          cid: effect.cid,
          peerId: effect.peerId,
          direction: effect.direction,
          kind: effect.kind,
          reason: effect.reason,
          startedAt: effect.startedAt,
          connectedAt: effect.connectedAt,
          endedAt: effect.endedAt,
          missed: effect.missed,
        });
        break;

      case 'startTimer': {
        // A dispatch suspended mid-loop can resume AFTER a concurrent
        // teardown already ran its cancelTimer effects — arming here then
        // leaves a stale timer that fires into whatever call is live later.
        // A call in teardown has no future for any timer to serve.
        if (this.state.name === 'ending') break;
        const existing = this.timers.get(effect.timer);
        if (existing) clearTimeout(existing);
        const map = {
          ring: 'ringTimeout',
          connect: 'connectTimeout',
          reconnect: 'reconnectTimeout',
        } as const;
        this.timers.set(
          effect.timer,
          setTimeout(() => {
            this.timers.delete(effect.timer);
            void this.dispatch({ type: map[effect.timer] });
          }, effect.ms),
        );
        break;
      }

      case 'cancelTimer': {
        const handle = this.timers.get(effect.timer);
        if (handle) clearTimeout(handle);
        this.timers.delete(effect.timer);
        break;
      }
    }
  }

  /**
   * Fill a template envelope's SDP from the effect that ran just before it.
   * Returns null when an SDP was required and none was produced.
   */
  private fillTemplate(envelope: CallEnvelope): CallEnvelope | null {
    switch (envelope.tcm) {
      case 'call.offer':
      case 'call.answer':
      case 'call.restart': {
        const sdp = this.pendingSdp;
        this.pendingSdp = null;
        if (!sdp) return null;
        return { ...envelope, sdp };
      }
      default:
        return envelope;
    }
  }

  /**
   * Whether the owner has torn this service down.
   *
   * ONE-WAY. A disposed service is never revived: the 1:1 controller builds a
   * new one per controller and the small-group coordinator builds a new one
   * per leg, and both drop the reference in the same breath as the dispose.
   */
  private disposed = false;

  /**
   * Release timers, close the peer connection, and STOP.
   *
   * THE DEMOLITION IS PERFORMED HERE, NOT DELEGATED (the disposed-flag
   * defect). An earlier fix taught this method to stop the
   * effect loop, which is what stopped a leg abandoned by a relock from arming
   * timers and composing sends. But a leg's OWN teardown runs in that same
   * loop, and `endCall` (`call-machine.ts`) announces first and closes the
   * peer connection three effects later — while `dispatch` publishes the
   * `ending` state through `onStateChange` BEFORE running any of it.
   *
   * So the small-group coordinator heard "this leg is over", found it was the
   * last one, released the session, and `resetSessionScratch()` disposed this
   * service; the announce, suspended in the pacer the whole time, then resumed
   * into the new `disposed` check and returned before `closePeerConnection`.
   * An ORDINARY hangup could leave a live peer connection carrying audio with
   * nothing anywhere still holding its cid. The stop was correct and it had
   * eaten the demolition, which is the fence-vs-demolition lesson arriving one
   * layer down: a fence must stop the BUILDING, never the DEMOLISHING — so the
   * demolition moves to the side of the fence that cannot be stopped.
   *
   * IDEMPOTENT BY CONTRACT, at both ends. The reducer's own `closeMedia`
   * (`closePeerConnection`) still closes this cid on every teardown that
   * completes, and the coordinator closes the cids it can name at its abrupt
   * seam; `close` is idempotent natively (`TacendumCallImpl.closeCall` removes
   * from a dictionary and marks a tombstone), so the overlap costs a bridge
   * call and buys the case where neither of the others runs.
   *
   * Fire-and-forget because this seam is synchronous — none of the callers may
   * wait on the bridge.
   *
   * AND THE CALLERS DIFFER BY OWNER.
   * For a
   * small-group LEG service the callers are: a relock, an account deletion and
   * the `startCalling` teardown (each via `disposeGroupCall()`, which sits
   * beside `messaging.stop()` and reaches every leg through the coordinator),
   * plus the coordinator's own ROUTINE paths — `resetSessionScratch()` when a
   * session ends and `releaseDepartedLegs()` when a member leaves. Routine
   * disposal is the common case; the quiesce seams are the abrupt one. For
   * the 1:1 service — the one `CallController` owns — there
   * is exactly ONE production caller: `CallController.stop()`, from the teardown
   * `startCalling` returns (`index.ts`), i.e. component unmount. Relock and
   * account deletion still do not reach THIS method — and by design
   * that is fine rather than open: those seams end a live 1:1 call through
   * the reducer's own terminal funnel instead (`endCallOnQuiesce`, `index.ts`,
   * dispatched BEFORE `messaging.stop()`), so the announce, the media close,
   * the CallKit release and the log row all run on the ordinary path. The
   * close below remains what it always was: the abrupt-seam backstop for a
   * service disposed mid-teardown.
   */
  dispose(): void {
    this.disposed = true;
    for (const handle of this.timers.values()) clearTimeout(handle);
    this.timers.clear();
    if (this.iceFlush) clearTimeout(this.iceFlush);
    this.iceFlush = null;
    // Read from the reducer's state, which is the only place that knows which
    // cid this service currently owns. Null once teardown has completed — a
    // routine departure therefore costs no bridge call at all.
    const cid = this.state.call?.cid ?? null;
    if (!cid) return;
    try {
      void this.deps.native.close(cid).catch(() => undefined);
    } catch {
      // A bridge that throws synchronously must not stop the rest of the
      // teardown. (For a leg service the caller is often a phone that has just
      // relocked; for the 1:1 service it is process teardown — see above.)
    }
  }
}
