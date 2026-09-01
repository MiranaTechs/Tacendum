import { monotonicFactory } from 'ulid';
import { CliError } from './exit.js';
import {
  ICE_BATCH_WINDOW_MS,
  MAX_ICE_CANDIDATES_PER_ENVELOPE,
  callReducer,
  encodeCallEnvelope,
  idleState,
  parseCallEnvelope,
  type CallEffect,
  type CallEndReason,
  type CallEnvelope,
  type CallEvent,
  type CallState,
  type IceCandidate,
} from '@tacendum/shared';

/**
 * The CLI signaling client — the E2EE signaling gate.
 *
 * It performs the **entire call signaling exchange with no media**: a
 * syntactically valid SDP-shaped fixture goes through the real ratchet and the
 * real server, and the peer decrypts it. That proves the encrypted signaling
 * path without a camera, a device, or WebRTC — which matters because the
 * device matrix needs two physical iPhones, and nothing that needs two
 * phones can be a build gate.
 *
 * **It drives the shipping reducer.** `callReducer` is the same function the
 * app will run, imported from `@tacendum/shared` rather than reimplemented, so
 * the glare rule and the timeout arithmetic this gate proves are the ones that
 * ship. A second implementation here would only demonstrate that two of my own
 * copies agree with each other.
 *
 * What is faked, and only this: the SDP. Everything else — the envelopes, the
 * ratchet, the server, the state machine, the ICE batching — is the real thing.
 */

const ulid = monotonicFactory();

/** Field keys whose values are call/peer ids — the only supplied values a
 * CALL line may carry, and only under the grammar check in `emit`. `msgid`
 * joined them for the transport id `sendEnvelope` reports (see `sent`): it is
 * a ULID this process minted, so it belongs under exactly the same grammar
 * check as a cid, and under it a transport that returned anything else prints
 * `redacted` rather than its own bytes. */
const ID_FIELD_KEYS = new Set(['cid', 'from', 'to', 'msgid']);
/** Strict ULID grammar — the same shape `packages/shared` enforces on every
 * wire id (`frames.ts` `Ulid`). */
const ULID_SHAPE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** How a structured body announces itself (mirrors the app's envelope layer). */
const ENVELOPE_SENTINEL = '{"tcm":';

/**
 * Envelopes whose delivery a call cannot survive — the app's set, mirrored
 * (`app/src/call/service.ts`, FATAL_TO_SEND), membership and all.
 *
 * The offer and the answer ARE the call as far as the peer is concerned; a
 * restart is what recovers one. If any of the three cannot be sent, the other
 * end will never know this call exists, so the send failure must FAIL the
 * caller (`sendEnvelope` rethrows). Everything else DEGRADES, exactly as the
 * app degrades it: a lost `call.ringing` costs the caller their ringback
 * line and the phone keeps ringing its 60 s; a `call.end` that cannot go out
 * is moot — we are ending regardless, and the teardown effects after it (the
 * timers, the log row) must still run. Before this set existed the CLI
 * rethrew for EVERY frame class, and the session fold in group-call.ts —
 * written as "the CLI mirror of the app CallService's fatal-send
 * localHangup" — was therefore ungated: a failed courtesy ack ended the leg,
 * and an incoming small-group call died on it.
 *
 * Membership is judged on the REDUCER's envelope (`envelope.tcm`), exactly as
 * the app judges it — so a leg offer the session seam rewrites into a
 * `call.ginvite` is still the fatal frame it is.
 */
const FATAL_TO_SEND: ReadonlySet<string> = new Set([
  'call.offer',
  'call.answer',
  'call.restart',
]);

/**
 * THE TRANSPORT NAMESPACE, and the rule that goes with it: everything under
 * `call.` is signalling, decided on this PREFIX, before any parse.
 *
 * `render.ts` states it for rendering and `app/src/envelope.ts` states it for
 * the app; this is the same rule for the CLI's call runner, which is where it
 * was missing. A carrier decided AFTER parsing is a carrier that turns noisy
 * the day the shape changes — and that day arrived with `call.ginvite`.
 */
const CALL_NAMESPACE = 'call.';

/**
 * The `tcm` a body CLAIMS, read without requiring the whole body to parse.
 *
 * Character class, and the reason for it, are `render.ts`'s verbatim (which
 * carries the app's for the same reason): a kind this regex fails to
 * recognise never reaches the namespace routing, so a realistic future name
 * like `call.g-invite2` would be narrated by every build that predates it,
 * and by then it is unfixable because the old builds are the problem. Three
 * copies of one regex is a real smell and is recorded as one here as it is
 * there.
 */
const DECLARED_TCM = /^\{"tcm":"([a-z][a-z0-9._-]{0,31})"/;

/** The kind a body claims, '' when it claims none this build will route on. */
export function declaredTcm(body: string): string {
  return DECLARED_TCM.exec(body)?.[1] ?? '';
}

/**
 * Whether a body is CALL TRANSPORT — by namespace, before parse, so a shape
 * this build has never seen is transport too. Exported because
 * `group-call.ts` routes on exactly the same question and a second copy of
 * the predicate is how the two would drift.
 */
export function isCallTransportBody(body: string): boolean {
  return declaredTcm(body).startsWith(CALL_NAMESPACE);
}

/** Machine-readable output. The e2e script asserts on these lines, so they are
 * a contract: append fields, never rename or reorder them. */
export const CALL_LOG_PREFIX = 'CALL';

export interface CallIo {
  /** Encrypt `body` to `peerId` and send it, urgent or not. Returns the msgId. */
  send(peerId: string, body: string, urgent: boolean): Promise<string>;
  /** Append a terminal call-log row. A pinned check asserts none is written for
   * a tampered offer, so this must be the ONLY place a row appears.
   *
   * May be async. The declared type says so OUT LOUD because the old `void`
   * return quietly accepted an async callback too — TypeScript's void-return
   * exception — and the executor discarded the promise, so a rejecting writer
   * was an unhandled rejection: `CALL logged` printed, then the process died.
   * The executor now awaits this, and a failure is reported as `log_failed`
   * instead of being fatal. */
  writeLog(row: CallLogRow): void | Promise<void>;
  now(): number;
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

/**
 * A fixture SDP: syntactically shaped like the real thing, carrying the four
 * lines the design calls security-relevant, and nothing that could be mistaken for a
 * working session description.
 *
 * `a=fingerprint` is the line the whole E2EE claim rests on — it binds the
 * DTLS-SRTP keys to the ratcheted envelope — so the gate carries one even
 * though nothing here performs a handshake. When V5 replaces this with a real
 * offer, the SDP-trimming test asserts these four lines survive byte-for-byte.
 */
export function fixtureSdp(kind: 'offer' | 'answer', marker: string, canary?: string): string {
  const fp = Array.from({ length: 32 }, (_, i) =>
    ((i * 7 + kind.length) % 256).toString(16).padStart(2, '0').toUpperCase(),
  ).join(':');
  return [
    'v=0',
    `o=- ${marker} 2 IN IP4 127.0.0.1`,
    's=-',
    't=0 0',
    'a=group:BUNDLE 0',
    'm=audio 9 UDP/TLS/RTP/SAVPF 111',
    'c=IN IP4 0.0.0.0',
    // The four security-relevant lines.
    `a=fingerprint:sha-256 ${fp}`,
    `a=setup:${kind === 'offer' ? 'actpass' : 'active'}`,
    `a=ice-ufrag:${marker.slice(0, 8)}`,
    `a=ice-pwd:${marker}${marker}`.slice(0, 40),
    'a=mid:0',
    'a=sendrecv',
    'a=rtpmap:111 opus/48000/2',
    // The plaintext-leak canary. It rides INSIDE the SDP, so
    // it is inside the ratcheted envelope; if it ever surfaces in server
    // stdout, in log output, or in a stored `messages.payload`, the signaling
    // path is not end-to-end encrypted and the whole design claim is false.
    ...(canary ? [`a=x-tacendum-canary:${canary}`] : []),
  ].join('\r\n');
}

/** A trickle candidate, shaped like a real one. */
export function fixtureCandidate(index: number): IceCandidate {
  return {
    cand: `candidate:${index} 1 udp ${2113937151 - index} 192.0.2.${(index % 254) + 1} ${40000 + index} typ host`,
    mid: '0',
    idx: 0,
  };
}

/**
 * Drives one CLI participant's call state.
 *
 * Outbound ICE is BATCHED here rather than in the reducer, because batching is
 * an executor concern: the contract gives a 150 ms window and at most
 * MAX_ICE_CANDIDATES_PER_ENVELOPE per envelope. The discipline, stated once
 * and enforced everywhere including the drain tail: a full envelope's worth
 * goes the moment it exists; anything less waits out its window. The tail
 * used to violate this — after a send it drained whatever had accumulated
 * IMMEDIATELY, so a slow first send turned a burst of 12 into [10,1,1]:
 * three envelopes, a partial one sent with no window, contradicting the
 * packing check. The one deliberate exception is an explicit `flushIce()` call,
 * which is a drain-now API (`trickle` and the tests use it as such) and
 * sends a partial batch without waiting.
 *
 * The buffer is SCOPED TO ITS CALL by cid. Candidates are only meaningful to
 * the peer connection they were gathered for; `state.call` at flush time is
 * not necessarily the call that queued them — a glare loser ADOPTS the
 * winner's call (same peer, different cid) without ever passing through
 * idle, and `ending` still carries the dead call's context so teardown
 * effects can address it. Unscoped, a buffered candidate outlived its call
 * and went out under whichever cid was current: ICE for a call whose
 * `call.end` was already on the wire, or one call's candidate reassigned to
 * another — a connectivity fault and an information leak between two calls.
 */
export class CallRunner {
  private state: CallState = idleState();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private iceBuffer: IceCandidate[] = [];
  /** The call the buffered candidates were gathered for. `flushIce` refuses
   * to send them under any other cid — see the class doc. */
  private iceBufferCid: string | null = null;
  private iceFlush: NodeJS.Timeout | null = null;
  /** Envelope counts, so the gate can assert on batching from either side. */
  readonly sentIceEnvelopes = { count: 0, candidates: 0 };
  readonly recvIceEnvelopes = { count: 0, candidates: 0 };

  /**
   * Test affordances, and they exist ONLY here.
   *
   * The CLI is a proof client — it is never shipped to anyone — so it is the
   * right place to keep the knobs the acceptance gate needs and the product
   * must not have. `expOffsetMs` backdates an offer's expiry so the stale-invite check
   * can prove a stale invite does not ring, without the script sleeping for
   * the ninety seconds the real timers require. `canary` embeds a marker in
   * the SDP for the plaintext-leak scan.
   */
  expOffsetMs = 0;
  canary: string | undefined;

  /**
   * THE SESSION SEAMS, and they are two hooks, not a
   * second state machine.
   *
   * A small-group call is N ordinary 1:1 legs, so `group-call.ts` runs
   * one of THESE per leg rather than teaching this class about sessions. It
   * needs exactly two things this class did not expose:
   *
   *  - `onEnvelope` — a leg's outgoing `call.offer` IS the session's
   *    `call.ginvite` (`app/src/call/group.ts` legSend). The rewrite
   *    happens on the way to the wire, AFTER `fillTemplate`, so the ginvite
   *    carries the same fixture SDP and the same canary the 1:1 gate scans
   *    for. It returns an already-encoded body plus the tcm to report,
   *    because a group envelope is deliberately NOT in `CallEnvelope`'s union
   *    (call.ts's forward-compatibility story) and must not be smuggled into
   *    this file's types.
   *  - `onState` — the leg's lifecycle, which the session reducer consumes as
   *    `legStateChanged` facts. The terminal REASON travels with it: a bare
   *    state name cannot tell "declined" from "failed" from "left", and both
   *    the tile phases and the re-offer gate turn on that distinction.
   *
   * Both are undefined for every 1:1 caller, and this class decides nothing
   * about sessions with them: it does not know what a sid is, it never ranks
   * one, and it never consults a roster. That stays in @tacendum/shared.
   */
  onEnvelope: ((envelope: CallEnvelope) => { tcm: string; body: string }) | undefined;
  onState: ((state: CallState, reason: CallEndReason | undefined) => void) | undefined;

  /** Harvested from the `endCallKit` effect of the step being run, so
   * `onState` can carry it. Reset per step: a stale reason attached to a
   * later, non-terminal transition would misreport a live leg as dead. */
  private endReason: CallEndReason | undefined;

  constructor(
    private readonly io: CallIo,
    /** Historically an account label printed as `self=` on every CALL line.
     * The hygiene rule at `emit` retired it — an account name is a supplied
     * value and must never reach a log line — and nothing consumed it:
     * the e2e call harness attributes lines by log FILE, not by field, and asserts
     * on cids only. The parameter survives so call sites need not change. */
    _selfLabel: string,
  ) {}

  get stateName(): string {
    return this.state.name;
  }

  get cid(): string | null {
    return this.state.call?.cid ?? null;
  }

  /**
   * The ONE gate every CALL line passes through, and the rule it enforces:
   * a field value is either
   *
   *   - something WE computed — an enum name, a count, a boolean, a timer
   *     name — passed through as-is; or
   *   - a call/peer id, printable ONLY because the wire schema already
   *     constrains every id to strict ULID grammar: 26 chars of a closed
   *     alphabet, incapable of carrying an account name, a message body, or
   *     a terminal escape. The grammar is re-checked here as defense in
   *     depth, so a value that reached an id-class key WITHOUT passing that
   *     schema (a raw transport from-address, a test fixture) prints as
   *     `redacted` rather than raw.
   *
   * No other supplied value — an account label, free text a user, peer, or
   * server chose — may ever be a field. `self=<account name>` was removed
   * from every line under this rule. Failure lines go further and carry only
   * ours-values: they are not part of the e2e contract, so they have no
   * reason to carry an id at all.
   */
  private emit(event: string, fields: Record<string, string | number | boolean>): void {
    const parts = Object.entries(fields).map(([k, v]) => {
      const s = String(v);
      const safe = !ID_FIELD_KEYS.has(k) || ULID_SHAPE.test(s) ? s : 'redacted';
      return `${k}=${safe}`;
    });
    console.log([CALL_LOG_PREFIX, event, ...parts].join(' '));
  }

  /** Apply an event and execute what falls out of it. */
  private async step(event: CallEvent): Promise<void> {
    const previousName = this.state.name;
    const { state, effects } = callReducer(this.state, event, this.io.now());
    this.state = state;
    this.endReason = undefined;
    try {
      for (const effect of effects) await this.run(effect);
    } finally {
      // In a `finally`, deliberately: `sendEnvelope` rethrows a failed
      // signalling send, and the state transition has ALREADY happened by
      // then. A session that only heard about transitions whose effects all
      // succeeded would hold a leg live forever whenever its `call.end` could
      // not go out — the leg is dead either way, and the session is the thing
      // that has to know.
      this.onState?.(this.state, this.endReason);

      // `ending` is a TEARDOWN state, not a terminal one: the shared machine's
      // ONLY exit from it is `teardownComplete` (call-machine.ts), and nothing
      // in this executor dispatched it. The app's executor has carried this
      // collapse since its own one-call-per-launch round
      // (app/src/call/service.ts — whose comment describes this exact defect);
      // it landed there and on the shared matrix executor, never here. The
      // consequence was one call per PROCESS: the runner sat in `ending`
      // forever, the machine turned every later `placeCall` into `reportBusy`
      // and answered every later foreign offer `call.end{r:'busy'}`, so
      // `listen --calls` refused every caller after the first, `ensureLeg`
      // (group-call.ts) handed the session the same stuck runner — which is
      // why the re-offer could never put a ginvite on the wire — and
      // `oneToOneBusy()` reported a torn-down call as busy forever.
      //
      // Mirrored from the app's collapse, ownership gate included: only the
      // step whose reducer PRODUCED the ending transition collapses it, proven
      // by THIS step's LOCAL `state` — a concurrent step that merely OBSERVED
      // `ending` must not null the call out from under the teardown that owns
      // it (the app's comment carries the interleaving that forced this). The
      // shared-state conditions then confirm the ending call this step
      // produced is still the live one. Inside the `finally` for the same
      // reason `onState` is: a teardown whose announce send threw must still
      // return to idle, or the runner is stranded exactly as before. Recurses
      // exactly once — `teardownComplete` from `ending` produces no effects,
      // and from anywhere else it is a no-op.
      //
      // The ICE buffer dies with its call before the collapse, as the app
      // clears its per-call scratch before dispatching: `iceBufferCid` already
      // refuses to send these under another cid, and dropping them here is
      // what stops the buffer outliving the call at all.
      if (
        state.name === 'ending' &&
        previousName !== 'ending' &&
        event.type !== 'teardownComplete' &&
        this.state.name === 'ending' &&
        this.state.call?.cid === state.call?.cid
      ) {
        this.dropIceBuffer();
        await this.step({ type: 'teardownComplete' });
      }
    }
  }

  // --- outbound ---------------------------------------------------------

  /**
   * `cid` is optional and minted here for an ordinary 1:1 call, because the
   * caller mints it (glare compares two caller-minted cids).
   *
   * A SESSION supplies its own. That is not a nicety: the session reducer
   * holds `legs[peerId].cid` and matches every `legStateChanged` against it,
   * so a leg that minted a second cid of its own reports under an id the
   * session does not recognise and every one of its transitions is discarded
   * as "a replaced or folded leg finishing its teardown". Caught by the
   * in-process smoke before this reached the wire: the dialled legs sat at
   * `inviting` forever while the answered ones connected, and the session
   * never reached `live` — a mesh that looked half-built from one side only.
   */
  async placeCall(peerId: string, video: boolean, cid: string = ulid()): Promise<string> {
    await this.step({ type: 'placeCall', cid, peerId, video, reportId: null });
    return cid;
  }

  async accept(): Promise<void> {
    await this.step({ type: 'localAccept' });
  }

  async hangup(): Promise<void> {
    await this.step({ type: 'localHangup' });
  }

  async decline(): Promise<void> {
    await this.step({ type: 'localDecline' });
  }

  /**
   * Adopt an offer that arrived on a SESSION envelope.
   *
   * A `call.ginvite` IS this leg's offer — same sdp/vid/exp contract as
   * `call.offer`, plus the session binding this class must never see. The
   * session executor unwraps it and hands the leg exactly the offer the 1:1
   * machine already knows how to ring, expire and answer, so no ring timer,
   * no expiry rule and no `createAnswer` ordering is reimplemented for groups.
   *
   * NOT a re-parse of a synthesised `call.offer` body: that would print
   * `CALL recv tcm=call.offer` for a frame the wire never carried, and the
   * gate's contract lines have to describe what actually happened.
   */
  async receiveOffer(
    peerId: string,
    cid: string,
    sdp: string,
    video: boolean,
    exp: number,
    serverTs: number,
  ): Promise<void> {
    await this.step({ type: 'offerReceived', cid, peerId, sdp, video, exp, serverTs });
  }

  /**
   * Fold this leg because the SESSION decided it is over — a starter's
   * departure, a glare loss, a busy refusal. `endReceived` tears down without
   * announcing, which is right here for the same reason it is right on the
   * wire: the session executor has already sent (or deliberately withheld)
   * the `call.end`, and a leg echoing its own end back would ping-pong.
   */
  async receiveEnd(cid: string, reason: CallEndReason): Promise<void> {
    await this.step({ type: 'endReceived', cid, reason });
  }

  /**
   * The call outbound ICE may still be produced for. `ending` deliberately
   * fails this test: the reducer keeps the dead call's context in that state
   * so teardown effects can address it, but its `call.end` is already on the
   * wire — a candidate sent after it is exactly the post-end leak the gate
   * reproduced.
   */
  private liveCall(): CallState['call'] {
    if (this.state.name === 'idle' || this.state.name === 'ending') return null;
    return this.state.call;
  }

  private dropIceBuffer(): void {
    this.iceBuffer = [];
    this.iceBufferCid = null;
    if (this.iceFlush) {
      clearTimeout(this.iceFlush);
      this.iceFlush = null;
    }
  }

  /** Queue a local candidate for the next batch — the CURRENT call's batch. */
  queueIce(candidate: IceCandidate): void {
    const call = this.liveCall();
    if (!call) return;
    if (this.iceBufferCid !== call.cid) {
      // Whatever is buffered was gathered for a different call — one that
      // has ended or lost glare. It must not ride out under this one.
      this.dropIceBuffer();
      this.iceBufferCid = call.cid;
    }
    this.iceBuffer.push(candidate);
    // A full envelope goes immediately; a partial one waits out the window.
    if (this.iceBuffer.length >= MAX_ICE_CANDIDATES_PER_ENVELOPE) {
      void this.flushIce();
      return;
    }
    this.iceFlush ??= setTimeout(() => void this.flushIce(), ICE_BATCH_WINDOW_MS);
  }

  async flushIce(): Promise<void> {
    if (this.iceFlush) {
      clearTimeout(this.iceFlush);
      this.iceFlush = null;
    }
    if (this.iceBuffer.length === 0) return;
    const call = this.liveCall();
    if (!call || call.cid !== this.iceBufferCid) {
      // The call these candidates were gathered for is gone — ended, or
      // replaced by a glare adoption — and a candidate is meaningless (and a
      // cross-call leak) under any other cid. Dropped, never reassigned.
      this.dropIceBuffer();
      return;
    }
    const batch = this.iceBuffer.splice(0, MAX_ICE_CANDIDATES_PER_ENVELOPE);
    const envelope: CallEnvelope = { tcm: 'call.ice', cid: call.cid, c: batch };
    this.sentIceEnvelopes.count += 1;
    this.sentIceEnvelopes.candidates += batch.length;
    // Captured BEFORE the await: two flushes can overlap, and reading the
    // shared counter afterwards made both envelopes report "envelopes=2",
    // which reads as a duplicate send rather than the first of two.
    const index = this.sentIceEnvelopes.count;
    try {
      await this.io.send(call.peerId, encodeCallEnvelope(envelope), false);
      this.emit('ice_sent', { cid: call.cid, n: batch.length, envelopes: index });
    } catch {
      // ICE trickle is best-effort: a lost batch degrades connectivity, it
      // does not end the call. And `queueIce` fires this method with `void`,
      // so a rejection escaping here is an unhandled rejection — process
      // death for a `listen --calls` daemon. Sends against a closed socket
      // REJECT now (they used to dissolve into false success), and
      // a failed prekey-bundle fetch could reject here all along. The batch
      // is dropped rather than requeued — against a dead transport a requeue
      // only grows — and the error object is deliberately not inspected or
      // logged: a transport error message can embed peer- or server-supplied
      // text. No cid either: a failure line is not part of the e2e contract,
      // so it carries only ours-values (the rule at `emit`). The counter
      // above stays incremented: rolling the shared count back would corrupt
      // the index a concurrent overlapping flush has already captured, so
      // `sentIceEnvelopes` counts attempts.
      this.emit('ice_send_failed', { n: batch.length, envelopes: index });
    }
    // The drain tail obeys the same discipline as `queueIce` (the class doc's
    // rule): another FULL envelope's worth keeps draining now; a partial tail
    // waits out its window rather than going immediately — it may still grow.
    if (this.iceBuffer.length >= MAX_ICE_CANDIDATES_PER_ENVELOPE) {
      await this.flushIce();
    } else if (this.iceBuffer.length > 0) {
      this.iceFlush ??= setTimeout(() => void this.flushIce(), ICE_BATCH_WINDOW_MS);
    }
  }

  // --- inbound ----------------------------------------------------------

  /**
   * Handle a decrypted body from `peerId`.
   *
   * Returns true when the body was CALL TRANSPORT, so the caller knows not to
   * render it as a chat message: call signaling never becomes a message row.
   *
   * NAMESPACE FIRST, PARSE SECOND — and both halves of that were wrong here
   * until a review named it.
   *
   * A `call.*` body this build cannot parse is SILENT: acked, never rung,
   * never narrated. That is not leniency, it is the forward-compatibility
   * contract the whole `call.` namespace exists to keep — `render.ts` and
   * `app/src/envelope.ts` route on the prefix before parsing for exactly this
   * reason, and `packages/shared`'s own note on `GroupCallEnvelope` says a
   * separate union is what makes "an old build receiving `call.ginvite` stays
   * silent and rings nothing" a property tests can hold rather than a hope
   * about builds we cannot patch. This method used to print `CALL unsupported`
   * instead, which made that property false on the newest build shipped: the
   * suite then asserted the noise, codifying the defect (the pinned requirement
   * is "prints nothing").
   *
   * And a body that is NOT under `call.` is not this class's business at all.
   * It used to answer "handled" for every structured body it failed to parse —
   * a reply, a photo, a reaction — which is how `listen --calls` once acked
   * chat away, and which is why `gate.callsession-output.test.ts` had to
   * carry a KNOWN RAW SITE exemption for the raw peer id this method printed
   * over it. Answering false hands it back to the caller, which renders and
   * spools it exactly as plain `listen` does.
   */
  async onBody(peerId: string, body: string, serverTs: number): Promise<boolean> {
    if (!body.startsWith(ENVELOPE_SENTINEL)) return false;
    if (!isCallTransportBody(body)) return false;

    const envelope = parseCallEnvelope(body);
    // Transport this build cannot read: acked by the caller, and silent.
    if (!envelope) return true;

    // Every well-formed envelope announces itself exactly once. Checks 1 and 2
    // assert on this directly rather than inferring arrival from a downstream
    // effect, which would pass just as happily had the envelope never
    // decrypted. Emitting it twice would also inflate the gate's ICE counts,
    // which is how the duplicate was caught.
    this.emit('recv', { tcm: envelope.tcm, cid: envelope.cid, from: peerId });

    switch (envelope.tcm) {
      case 'call.offer':
        await this.step({
          type: 'offerReceived',
          cid: envelope.cid,
          peerId,
          sdp: envelope.sdp,
          video: envelope.vid,
          exp: envelope.exp,
          serverTs,
        });
        break;
      case 'call.answer':
        await this.step({
          type: 'answerReceived',
          cid: envelope.cid,
          sdp: envelope.sdp,
          video: envelope.vid,
        });
        break;
      case 'call.ice':
        this.recvIceEnvelopes.count += 1;
        this.recvIceEnvelopes.candidates += envelope.c.length;
        this.emit('ice_recv', {
          cid: envelope.cid,
          n: envelope.c.length,
          envelopes: this.recvIceEnvelopes.count,
          total: this.recvIceEnvelopes.candidates,
        });
        await this.step({ type: 'iceReceived', cid: envelope.cid, candidates: envelope.c });
        break;
      case 'call.ringing':
        await this.step({ type: 'ringingReceived', cid: envelope.cid });
        break;
      case 'call.end':
        await this.step({ type: 'endReceived', cid: envelope.cid, reason: envelope.r });
        break;
      case 'call.media':
        await this.step({
          type: 'mediaReceived',
          cid: envelope.cid,
          audio: envelope.a,
          video: envelope.v,
        });
        break;
      case 'call.restart':
        await this.step({ type: 'restartReceived', cid: envelope.cid, sdp: envelope.sdp });
        break;
    }
    return true;
  }

  /** Pretend ICE reached `connected`, so the gate can drive a call to media
   * without a peer connection. */
  async iceConnected(): Promise<void> {
    const call = this.state.call;
    if (!call) return;
    await this.step({ type: 'iceStateChanged', cid: call.cid, ice: 'connected' });
  }

  // --- effects ----------------------------------------------------------

  private async run(effect: CallEffect): Promise<void> {
    switch (effect.type) {
      case 'sendEnvelope': {
        // The reducer emits envelopes whose `sdp` is a TEMPLATE (empty
        // string) because it cannot know an SDP. Filling it is the executor's
        // job, and the contract is explicit that a template whose SDP could
        // not be obtained must never go on the wire.
        const envelope = this.fillTemplate(effect.envelope);
        if (!envelope) {
          this.emit('send_aborted', { tcm: effect.envelope.tcm, reason: 'no_sdp' });
          return;
        }
        // The session seam, applied AFTER the template is filled so a ginvite
        // carries the same SDP (and the same canary) a 1:1 offer would. A
        // rewrite that returned the tcm alone would leave the emitted `sent`
        // line describing a frame that never went out, so the hook returns
        // the body it wants sent and the name it wants reported, together.
        const wire = this.onEnvelope
          ? this.onEnvelope(envelope)
          : { tcm: envelope.tcm as string, body: encodeCallEnvelope(envelope) };
        let msgId: string;
        try {
          msgId = await this.io.send(effect.peerId, wire.body, effect.urgent);
        } catch (err) {
          // The third site of the same rule the ICE and timer paths follow:
          // a foreign transport error is never rethrown as-is — its message
          // can embed peer- or server-supplied text, and `main` prints a
          // rejection's message verbatim onto stderr and into `--json`.
          this.emit('send_failed', { tcm: wire.tcm, urgent: effect.urgent });
          // THE FATAL/NON-FATAL SPLIT (FATAL_TO_SEND above; the app's rule
          // and the app's membership). A NON-fatal frame degrades: the line
          // above is the record, the remaining effects of this transition
          // run — the ring timer a `call.ringing` precedes, the log row a
          // `call.end` precedes — and the caller does not fail over a frame
          // the call can live without. Judged on the reducer's envelope, so
          // the ginvite rewrite stays fatal (it IS the leg's offer).
          if (!FATAL_TO_SEND.has(envelope.tcm)) return;
          // THE APP'S AFTERMATH, not only its membership. The app answers a fatal send with
          // `dispatch({type:'localHangup'})` and returns
          // (app/src/call/service.ts) — teardown, log row, back to idle.
          // Rethrowing ALONE abandoned every effect after the failing send:
          // an accept's connect timer was never armed (`startTimer connect`
          // follows the send in `acceptIncoming`'s list), the surviving
          // ring timer is inert outside the ringing states, the reducer
          // never PRODUCED `ending` so the collapse in `step`'s finally
          // could not fire — and the runner sat in `incoming_answering`
          // answering every later caller `call.end r=busy`, with zero log
          // rows, permanently against a CLI peer (`dispose()` only clears
          // timers; `tacendum call` never announces `call.end` on exit).
          // The hangup announces the end — that send degrading on the same
          // dead transport is fine, `call.end` is not in the set — writes
          // the row, cancels every timer, and the `ending` its own step
          // produces collapses to idle in that step's finally.
          //
          // ONLY for a free-standing 1:1 runner. A session-owned leg
          // (`onState` set) defers to the SESSION executor's fold — the
          // apply catch in group-call.ts, which turns an escaped fatal
          // throw into `receiveEnd(cid,'failed_ice')` in the session's own
          // reason taxonomy. A leg that hung up on itself first would
          // report `cancelled` into the session reducer, whose re-offer
          // repair and release logic key on the failure class.
          // Guarded so a fold that itself failed cannot replace the
          // classified error below — the caller's rejection is the
          // contract, the fold is the aftermath.
          if (this.onState === undefined) {
            await this.step({ type: 'localHangup' }).catch(() => undefined);
          }
          // A FATAL frame still fails the caller — unlike the app's
          // executor, whose caller is a UI event loop with nothing to fail,
          // `placeCall` is a command whose rejection is pinned (the
          // liveness gate pins CliError's "call socket is not open" and the
          // NETWORK exit) and the daemon's frame queue prints the
          // classified line. But the only foreign object allowed through is
          // a CliError, this package's own classified error whose prose its
          // own construction sites wrote. Anything else (a ws internal, fs,
          // a libsignal wrap) is replaced with OUR prose, which names only
          // the envelope kind WE chose.
          throw err instanceof CliError
            ? err
            : new Error(`call signaling send failed (${wire.tcm})`);
        }
        this.emit('sent', {
          tcm: wire.tcm,
          cid: envelope.cid,
          urgent: effect.urgent,
          // THE TRANSPORT ID THIS FRAME WAS MINTED UNDER (an earlier review), and it is the only client-side fact that can bind a
          // leak scan to the row it is about.
          //
          // The gates' leak sections collect their subject from the server's
          // queue: everything for the recipient that was not there before the
          // dial. That read is EVENTUALLY CONSISTENT (`queued_msgids` issues a
          // plain Query against DynamoDB Local), so the before-set can miss a
          // recent row R and the first nonempty post-read can return while the
          // offer is still delayed — at which point the dump scans R, every
          // check goes green, and the frame under test was never examined.
          // Nothing observable in the queue can tell one ciphertext from
          // another; only the SENDER knows which msgId its offer got, and
          // `sendEncrypted` (call-session.ts) has always returned it. It was
          // simply thrown away here.
          //
          // A msgId is not a secret: it is a ULID this process minted, it is
          // the row's primary key, it already travels in every `receipt` and
          // `ack` frame, and `tamper.ts` prints one on stdout. It rides the
          // same id-class grammar check as `cid` (ID_FIELD_KEYS above).
          //
          // ONE SITE COVERS BOTH GATES: a small-group leg's `call.offer` IS
          // the session's ginvite (`onEnvelope`, group-call.ts), so the
          // ginvite's line is this line with a rewritten `tcm`.
          //
          // PLACED BEFORE `canary`, which is not cosmetic: both gates anchor
          // on `^CALL sent … canary=true$` with the canary at end of line.
          msgid: msgId,
          // THE CANARY POSITIVE CONTROL (an earlier review), and it exists only
          // under the rig: `this.canary` is undefined outside the acceptance
          // gates, so no field appears on a shipped surface.
          //
          // Both gates scan for the marker's ABSENCE — not in the server's
          // stdout, not in any stored payload. That is equally true of a
          // marker that never reached an SDP at all: the canary is injected by
          // a TEST HOOK (an env var, unvalidated by construction), so renaming
          // it, or breaking the options chain that carries it into a leg,
          // silently omits the `a=x-tacendum-canary` line and every absence
          // scan goes green having looked for a string that was never sent.
          // This says, about the body that is going on the wire THIS instant,
          // whether the marker is in it. The VALUE is a boolean we computed —
          // never the marker — which is `emit`'s rule, and it is asked of
          // `wire.body` rather than the envelope so a rewriting `onEnvelope`
          // (the ginvite seam) is covered by the same assertion.
          ...(this.canary !== undefined && 'sdp' in envelope
            ? { canary: wire.body.includes(this.canary) }
            : {}),
        });
        break;
      }
      case 'reportIncomingCall':
        this.emit('ringing', {
          cid: effect.cid,
          from: effect.peerId,
          video: effect.hasVideo,
        });
        break;
      case 'reportOutgoingCall':
        this.emit('calling', { cid: effect.cid, to: effect.peerId });
        break;
      case 'reportConnected':
        this.emit('connected', { cid: effect.cid });
        break;
      case 'endCallKit':
        // Harvested on the way past — this effect is the ONLY place the
        // terminal reason exists in the leg's output, and `onState` needs it
        // (see the seam docblock).
        this.endReason = effect.reason;
        this.emit('ended', { cid: effect.cid, reason: effect.reason });
        break;
      case 'reportBusy':
        this.emit('busy', {});
        break;
      case 'writeLog':
        try {
          // Awaited even though a sync writer returns nothing: the declared
          // `void` return also accepted an ASYNC callback (TypeScript's
          // void-return exception), and discarding its promise left the
          // rejection unowned — `CALL logged` printed, then the process died
          // one microtask later under strict unhandled-rejection mode. The
          // await observes a sync throw and an async rejection alike.
          await this.io.writeLog({
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
        } catch {
          // Not rethrown — a lost log row must not kill a `listen --calls`
          // daemon — and the error object is not logged: a writer failure
          // carries a filesystem path built from the account name. The row
          // is lost and this line says so; `logged` below is only printed
          // for a row that was actually written, because a pinned check
          // asserts on its presence as proof the row exists.
          this.emit('log_failed', { reason: effect.reason, missed: effect.missed });
          break;
        }
        this.emit('logged', {
          cid: effect.cid,
          reason: effect.reason,
          missed: effect.missed,
        });
        break;
      case 'addIceCandidates':
        this.emit('ice_applied', { cid: effect.cid, n: effect.candidates.length });
        break;
      case 'startTimer': {
        const existing = this.timers.get(effect.timer);
        if (existing) clearTimeout(existing);
        const handle = setTimeout(() => {
          this.timers.delete(effect.timer);
          const map = {
            ring: 'ringTimeout',
            connect: 'connectTimeout',
            reconnect: 'reconnectTimeout',
          } as const;
          // Not `void`: a timer-driven step has no awaiting caller, so a
          // rejection out of it is an unhandled rejection — process death.
          // The trigger is currently LATENT, not live (an earlier revision): each
          // expiry reduces to `endCall` with announce=true, but `call.end`
          // is not in FATAL_TO_SEND any more, so a failed send of it
          // DEGRADES inside `run` rather than throwing, and every other
          // effect `endCall` emits either has its own catch (`writeLog`) or
          // cannot throw — no timer-driven step can currently reject
          // through its own effects, and the rewritten gate test asserts
          // `timer_failed`'s absence. The backstop stays anyway: what a
          // rejection here costs is the PROCESS, and the reachable residue
          // is a foreign seam — a session leg's `onState` hook throwing out
          // of `step`'s finally on a timer expiry — plus whatever a future
          // round adds to a timer transition's effect list. One ours-values
          // line is the right price for never dying to that class. The
          // error object is not logged — a transport error can embed peer-
          // or server-supplied text; the timer name is ours, and it is the
          // ONLY field: a failure line carries no supplied value (rule at
          // `emit`).
          this.step({ type: map[effect.timer] }).catch(() => {
            this.emit('timer_failed', { timer: effect.timer });
          });
        }, effect.ms);
        // A pending call timer must not hold the process open on its own.
        handle.unref?.();
        this.timers.set(effect.timer, handle);
        break;
      }
      case 'cancelTimer': {
        const handle = this.timers.get(effect.timer);
        if (handle) clearTimeout(handle);
        this.timers.delete(effect.timer);
        break;
      }
      case 'createOffer':
      case 'createAnswer':
      case 'restartIce':
      case 'setRemoteAnswer':
      case 'closePeerConnection':
        // No media in this gate. The SDP those effects would have produced is
        // supplied by fillTemplate below.
        break;
    }
  }

  /** SDP marker for the current call, so a fixture is traceable to its cid. */
  private marker(): string {
    return this.state.call?.cid ?? 'nocall';
  }

  /**
   * Fill a template envelope's SDP. Returns null when the envelope needed an
   * SDP and none could be produced — the executor must then NOT send it.
   */
  private fillTemplate(envelope: CallEnvelope): CallEnvelope | null {
    const call = this.state.call;
    switch (envelope.tcm) {
      case 'call.offer':
        if (!call) return null;
        // `exp` is the reducer's, deliberately: it is computed from the same
        // `now` the rest of that step used, and recomputing it here would let
        // the offer's lifetime drift from the state it was minted alongside.
        // `expOffsetMs` is zero outside the acceptance gate.
        return {
          ...envelope,
          sdp: fixtureSdp('offer', this.marker(), this.canary),
          exp: envelope.exp + this.expOffsetMs,
        };
      case 'call.answer':
        if (!call) return null;
        return { ...envelope, sdp: fixtureSdp('answer', this.marker(), this.canary) };
      case 'call.restart':
        if (!call) return null;
        return { ...envelope, sdp: fixtureSdp('offer', this.marker(), this.canary) };
      default:
        return envelope;
    }
  }

  /** Release timers so a CLI process can exit. */
  dispose(): void {
    for (const handle of this.timers.values()) clearTimeout(handle);
    this.timers.clear();
    this.dropIceBuffer();
  }
}
