import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { monotonicFactory } from 'ulid';
import {
  encodeCallEnvelope,
  encodeGroupCallEnvelope,
  parseCallEnvelope,
  parseGroupCallEnvelope,
  type CallEndReason,
  type CallState,
  type GroupCallInviteEnvelope,
} from '@tacendum/shared';
import {
  groupSessionReducer,
  type GroupSessionInput,
  type GroupSessionState,
  type SessionEffect,
  type StoredGroupOffer,
} from '@tacendum/shared/call-session';
import { writeFileAtomic } from './atomic-write.js';
import { CallRunner, isCallTransportBody, type CallLogRow } from './call.js';
import { clientDir } from './config.js';

/**
 * The CLI's small-group call executor.
 *
 * `CallRunner` is to `callReducer` what this class is to
 * `groupSessionReducer`: an executor for a pure reducer that lives in
 * `@tacendum/shared/call-session` and is imported, never re-implemented. The
 * whole point of the CLI gate is that the module the app ships is the module
 * the wire test drives — a second copy here would only prove that two of my
 * own copies agree with each other.
 *
 * THE RULE THAT OUTRANKS EVERYTHING IN THIS FILE, and it is `room-commands.ts`'s
 * rule with the nouns changed: **there is no authority logic here.** Who may
 * grow a roster, whose sid wins a glare, whether an epoch is next, whether a
 * cap is exceeded, whether an invite may ring — every one of those is
 * `admitGroupCallInvite` / `admitGroupCallRosterDelta` / the reducer's, asked
 * and obeyed. There is no comparison of two sids anywhere below, no epoch
 * arithmetic, no cap arithmetic, and no `if` about who sent something. Search
 * this file for `starterId` and you will find it only in a state dump and in
 * a log line. That is the property the e2e group-call harness exists
 * to falsify, and a second copy of the rule here would make that check a test
 * of this file instead of a test of the shipped guard.
 *
 * WHAT THIS FILE DOES OWN: transport (one leg `CallRunner` per peer, the
 * ratcheted send handed in as `GroupCallIo`), the executor-minted ULIDs a pure
 * reducer cannot produce (sid, per-leg cids), timers, the machine-readable
 * `GCALL` contract lines the gate asserts on, and the JSON state dump the gate
 * reads instead of guessing from output.
 *
 * WHAT IS FAKED, and only this — the same doctrine as the 1:1 fake, unchanged: the SDP, and
 * the moment ICE reports connected. Everything else (the envelopes, the
 * ratchet, the server, both reducers, the leg lifecycle) is the real thing.
 */

const ulid = monotonicFactory();

/** Machine-readable output. The gate asserts on these lines, so they are a
 * contract: append fields, never rename or reorder them. Deliberately a
 * different prefix from `CALL`, so a session line and a leg line can never be
 * mistaken for one another by a grep. */
export const GCALL_LOG_PREFIX = 'GCALL';

/**
 * Field keys whose values are wire ids — `CallRunner.emit`'s rule, extended by
 * the two ids the session layer adds (`sid`, and `m` on a roster delta). The
 * grammar re-check is the whole allowance: a ULID is 26 characters of a closed
 * alphabet and cannot carry an account name, a message body or a terminal
 * escape. No other supplied value may ever be a field.
 */
const ID_FIELD_KEYS = new Set(['sid', 'cid', 'from', 'to', 'm', 'msgid']);
const ULID_SHAPE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * How long after an answer this gate pretends ICE reached `connected`.
 *
 * TEST RIGGING, and it is the second of the two fakes named above. There is no
 * peer connection here, so nothing would ever move a leg out of
 * `outgoing_connecting`/`incoming_answering` and the session would never reach
 * `live` — the 45 s connect timer would end every leg as `failed_ice` and the
 * gate would be testing the timeout path forever. Armed from an OBSERVED
 * answer (ours going out, or theirs coming in), never from a timer that fires
 * regardless, so a leg whose answer never crossed the wire still fails.
 */
const ICE_CONNECTED_RIG_MS = 250;

/**
 * The states a leg is left in when an answer it just consumed was ACCEPTED.
 *
 * THE ARM-TIME COMPANION TO `ICE_CONNECTED_RIG_MS`, and the whole of
 * an earlier fix. That constant's docblock says the rig is "armed from
 * an OBSERVED answer … so a leg whose answer never crossed the wire still
 * fails". An earlier revision made that true at FIRE time — `armIce` re-checks the cid —
 * and left both ARM-TIME predicates keyed on the arriving frame's KIND
 * (`tcm === 'call.answer'`), which is not an observation of anything.
 *
 * So an ordinary `call.answer` from the STARTER, for the leg his own ginvite
 * opened, armed the rig while that leg was still in `incoming_ringing` — a
 * frame `answerReceived` correctly discards (`call-machine.ts`: NOTHING
 * outside its accepting states). 250 ms later the leg still held that cid, the
 * fire-time check passed, and `iceStateChanged{connected}` — which promotes
 * ANY non-`ending`, non-`connected` state — connected a call nobody had
 * answered. Measured, that cost three things: `CALL connected` for an
 * unanswered call; an INDEFINITE RING, because the promotion emits
 * `cancelTimer ring`, `ringTimeout` is inert outside the two ringing states,
 * and there is no session-level ring bound — breaking the guarantee stated
 * verbatim in `openLegRinging`'s docblock (`packages/shared/src/
 * call-session.ts`: "that list has no way to stop ringing … and a peer must
 * not be able to make us ring forever"); and a SILENT NON-ANSWER, since
 * `localAccept` is a no-op in `connected`, so a human answering afterwards put
 * no `call.answer` on the wire at all while the session still promoted itself
 * to `live`.
 *
 * THE SET IS DERIVED FROM `answerReceived`, not guessed. It accepts in
 * `outgoing_connecting`, `outgoing_ringing` and `reconnecting`; the state it
 * LEAVES is `reconnecting` for the third and `outgoing_connecting` for the
 * other two ("Stay in outgoing_connecting: 'ringing' was only ever a UI
 * state"). `outgoing_ringing` is therefore deliberately ABSENT: a leg still
 * observed there after consuming an answer is a leg whose answer was NOT
 * taken, and including it would re-open this hole one state along.
 *
 * A POST-STATE, not the frame — which is the model the two `armIce` call sites
 * that were already right have always used (`incoming_answering` in `onState`,
 * and the accept in `openLegAnswer`). Four call sites, one rule now.
 */
const ANSWER_ACCEPTED_STATES: ReadonlySet<string> = new Set([
  'outgoing_connecting',
  'reconnecting',
]);

/**
 * Did the answer this leg just consumed actually land?
 *
 * ONE predicate, called from BOTH sites that used to test the frame's kind —
 * `onBody`'s live-leg route and `drainPending`'s replay — so the twins cannot
 * drift apart again. (`drainPending`'s copy is not independently reachable
 * today, because inbound frames are serialized on `CallSession.queue`; it is
 * fixed anyway, and shares the predicate rather than repeating it, because
 * this log has paid repeatedly for fixing one of two.)
 */
function answerWasAccepted(leg: CallRunner): boolean {
  return ANSWER_ACCEPTED_STATES.has(leg.stateName);
}

/**
 * How many frames may wait for a leg that does not exist yet, per peer.
 *
 * A bound, not a tuning knob. The reducer holds a later joiner's offer until a human
 * answers the SESSION, so there is a window in which this session OWNS a cid
 * with no leg runner behind it — and the joiner does not wait, it trickles.
 * Those frames have to go somewhere, and "somewhere" must not be a list a peer
 * can grow: a malicious or broken sender that never gets a leg would otherwise
 * hold unbounded memory for the life of the ring.
 *
 * OLDEST OUT when the cap is hit, which is the honest end to drop: ICE is
 * small and cumulative, and the candidates a peer is still gathering supersede
 * the ones it started with far better than the reverse. Dropping the newest
 * would keep a prefix of a candidate set and throw away the reflexive/relay
 * ones that actually connect.
 */
const MAX_PENDING_LEG_BODIES = 32;

/** One frame waiting for its leg. `tcm` is kept from the parse the routing
 * already did, so the drain can re-apply `onBody`'s answer rule without
 * parsing the body a second time. */
interface PendingLegFrame {
  body: string;
  serverTs: number;
  tcm: string;
}

/** A peer's waiting frames, scoped to the ONE cid they were sent for — the
 * `iceBufferCid` discipline `CallRunner` states for its outbound buffer, in
 * the other direction: candidates gathered for one peer connection are
 * meaningless to another, and replaying them into a later leg would be one
 * call's ICE arriving under a different call's id. */
interface PendingLegFrames {
  cid: string;
  frames: PendingLegFrame[];
  /** How many the cap discarded, so the drain line can say so. */
  dropped: number;
}

/** Where the session-state dump lands. Under `clientDir` because it is
 * protocol state, not chat state, and because the gate needs a path it can
 * read while the process is still running. */
export function groupCallStatePath(name: string): string {
  return join(clientDir(name), 'gcall-state.json');
}

/** One leg of the dumped state — a projection of `LegSummary`, not a copy of
 * a `CallState`: the leg runner owns the call state and holding a second full
 * copy is the two-sources-of-truth drift the plan's own notes warn about. */
export interface GroupCallLegDump {
  peerId: string;
  cid: string;
  phase: string;
  direction: 'in' | 'out';
  reoffersLeft: number;
}

/**
 * What `tacendum gcall <name>` prints and what the gate asserts on.
 *
 * A dump rather than a rendering, deliberately: "every client converged" is a
 * claim about STATE, and a check that reads output can pass on a client that
 * merely printed the right words. `live:false` still carries the last sid and
 * the reason it ended, so "the session ended for everyone" is an assertion
 * about a positive fact rather than about the absence of one.
 */
export interface GroupCallStateDump {
  live: boolean;
  sid: string | null;
  starterId: string | null;
  selfId: string;
  roster: string[];
  announced: string[];
  se: number;
  video: boolean;
  phase: string | null;
  legs: GroupCallLegDump[];
  heldOffers: string[];
  callKit: string | null;
  connected: boolean;
  /** Set only once the session is over — the release reason. */
  endedReason: CallEndReason | null;
}

/**
 * What a server receipt says happened to a frame.
 *
 * `'sent'` — accepted and queued; the recipient was not on a live socket.
 * `'delivered'` — accepted AND written to a live socket of the recipient's.
 *
 * Neither is a claim that the recipient's BUILD did anything with it, and
 * `'delivered'` is not a read receipt: it is the strongest statement the
 * transport can make, and it is the one a silence check about an old build
 * needs, because that build is mute by design and can never confirm anything
 * itself. Mirrors `ReceiptFrame.state` (packages/shared/src/frames.ts).
 */
export type ReceiptKind = 'sent' | 'delivered';

export interface GroupCallIo {
  /** Encrypt `body` to `peerId` and send it, urgent or not. Returns the msgId.
   * Resolving means the ciphertext was WRITTEN to an open socket — nothing
   * here waits for the server, which is what every leg frame wants. */
  send(peerId: string, body: string, urgent: boolean): Promise<string>;
  /**
   * The same send, resolving only once the SERVER acknowledged taking the
   * frame — and bounded, so a silent server resolves `null` rather than
   * hanging the session.
   *
   * WHICH KIND OF ACK, not merely whether there was one. The protocol carries
   * two (`ReceiptFrame.state` in packages/shared): `'sent'` means the server
   * QUEUED the ciphertext for a recipient who is not there, `'delivered'`
   * means it reached a live socket belonging to them. Collapsing both into a
   * boolean is what made the fan-out's `n == of` line read as "everyone got
   * it" when the honest reading is "the server took it for everyone" — and
   * the e2e group-call harness was built on the stronger reading. The two are reported separately now, and each check says
   * which one it is standing on.
   *
   * REQUIRED, not optional, and that is deliberate: an optional ack that fell
   * back to `send` would let a rig satisfy the fan-out claim by simply not
   * implementing it — the exact vacuity this member exists to remove. There
   * are two implementations and both are real.
   */
  sendAcked(
    peerId: string,
    body: string,
    urgent: boolean,
    /** Handed the transport id as soon as the send has one, before the receipt
     * wait. See the `delta_frame` line at the fan-out for what reads it. */
    onMsgId?: (msgId: string) => void,
  ): Promise<ReceiptKind | null>;
  /** Append a terminal call-log row. Per-leg rows only: the session has no
   * log row of its own in this client (the aggregate history row is the
   * app's). */
  writeLog(row: CallLogRow): void | Promise<void>;
  now(): number;
}

export interface GroupCallOptions {
  /** Marker embedded in outgoing SDP, for the plaintext-leak scan. It rides
   * inside the ginvite exactly as it rides inside a 1:1 offer. */
  canary?: string | undefined;
  expOffsetMs?: number | undefined;
  /** Answer the SESSION as soon as it rings — once, not once per leg. */
  autoAnswer?: boolean | undefined;
  autoDecline?: boolean | undefined;
  /** Where the state dump is written. Defaults to `groupCallStatePath`. */
  statePath?: string | undefined;
  /**
   * Where a body that is neither a group envelope nor a frame naming a cid
   * this session owns goes. In practice the account's ordinary 1:1 runner, so
   * a client driving a session still renders chat and still answers a plain
   * call — subject to the interlock below, which refuses a 1:1 offer while
   * a session is live rather than letting it through.
   *
   * It is also the thing that makes this device "busy" in the other
   * direction: a live call on THIS runner refuses an incoming ginvite.
   */
  fallback?: CallRunner | undefined;
}

export class GroupCallRunner {
  private state: GroupSessionState | null = null;
  /**
   * One transport runner per peer, FOR THE LIFE OF THE PROCESS: entries are
   * never deleted (`dispose()` is the only clear), and that is a decision,
   * not an omission. A folded runner returns to `idle` (the ending-collapse
   * in call.ts exists for exactly this) and `ensureLeg` re-uses it, which is
   * what lets the re-offer repair dial a fresh cid out of the same executor
   * — and pruning would orphan the runner's own timers unless the prune also
   * disposed it, killing the late terminal report `maybeRelease` still
   * needs. The price of keeping entries is that EVERY read of this map must
   * be cid-guarded (`closeLeg`'s `leg.cid === cid` predicate — see `onBody`
   * and `armIce`) or provably indifferent to a stale entry; the map is
   * bounded by the distinct peers this process ever opened a leg for, never
   * by traffic.
   */
  private readonly legs = new Map<string, CallRunner>();
  /** The last cid each leg reported under, so a terminal report that arrives
   * with the call context already cleared is still attributable. */
  private readonly legCid = new Map<string, string>();
  /** Frames for a cid this session owns whose leg runner does not exist yet,
   * keyed by peer. See `MAX_PENDING_LEG_BODIES` and `drainPending`. */
  private readonly pendingBodies = new Map<string, PendingLegFrames>();
  private readonly timers = new Set<NodeJS.Timeout>();
  private readonly statePath: string;
  /** Carried past the collapse to null so the dump can still name what ended. */
  private lastSid: string | null = null;
  private lastStarter: string | null = null;
  private endedReason: CallEndReason | null = null;
  private disposed = false;

  /**
   * Session inputs are applied STRICTLY ONE AT A TIME.
   *
   * Not tidiness: a leg's `onState` fires from inside an effect this class is
   * already executing (a `closeLeg` folds a leg, which transitions it, which
   * reports back). Applied re-entrantly, the second reducer call would read
   * the state the first one is halfway through replacing, and a roster or an
   * epoch would silently fork. The same discipline `CallSession` applies to
   * inbound frames and to its send chain, for the same reason.
   */
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly io: GroupCallIo,
    /** THIS device's user id. Never a payload field — it is read from the
     * local profile by the caller and handed in. */
    readonly selfId: string,
    /** This machine's account name, for the dump path only. */
    name: string,
    private readonly options: GroupCallOptions = {},
  ) {
    this.statePath = options.statePath ?? groupCallStatePath(name);
  }

  get live(): boolean {
    return this.state !== null;
  }

  get sid(): string | null {
    return this.state?.sid ?? null;
  }

  get phase(): string | null {
    return this.state?.phase ?? null;
  }

  // --- output ---------------------------------------------------------------

  /**
   * The ONE gate every GCALL line passes through — `CallRunner.emit`'s rule,
   * verbatim, over the session's id set.
   *
   * HUMAN-SHAPED UNDER `--json` TOO, and that is a recorded exemption rather
   * than an oversight: the global `--json` contract does not cover a live call
   * session, for the reasons written where the contract is stated (the docblock
   * on `HELP` in main.ts). A machine consumer reads `tacendum gcall <name>` for
   * this session's state and `tacendum calllog <name>` for its terminal rows.
   * Changing what this prints means changing `CallRunner.emit` and
   * `CallSession.render` in the same breath, or the mode becomes a mixed
   * stream that no reader can take.
   */
  private emit(event: string, fields: Record<string, string | number | boolean>): void {
    const parts = Object.entries(fields).map(([k, v]) => {
      const s = String(v);
      const safe = !ID_FIELD_KEYS.has(k) || ULID_SHAPE.test(s) ? s : 'redacted';
      return `${k}=${safe}`;
    });
    console.log([GCALL_LOG_PREFIX, event, ...parts].join(' '));
  }

  // --- the state dump -------------------------------------------------------

  snapshot(): GroupCallStateDump {
    const s = this.state;
    if (s === null) {
      return {
        live: false,
        sid: this.lastSid,
        starterId: this.lastStarter,
        selfId: this.selfId,
        roster: [],
        announced: [],
        se: 0,
        video: false,
        phase: null,
        legs: [],
        heldOffers: [],
        callKit: null,
        connected: false,
        endedReason: this.endedReason,
      };
    }
    return {
      live: true,
      sid: s.sid,
      starterId: s.starterId,
      selfId: s.selfId,
      roster: [...s.roster],
      announced: [...s.announced],
      se: s.se,
      video: s.video,
      phase: s.phase,
      legs: Object.values(s.legs).map(leg => ({
        peerId: leg.peerId,
        cid: leg.cid,
        phase: leg.phase,
        direction: leg.direction,
        reoffersLeft: leg.reoffersLeft,
      })),
      heldOffers: Object.keys(s.heldOffers),
      callKit: s.callKit,
      connected: s.connectedAt !== null,
      endedReason: null,
    };
  }

  /**
   * Persist the dump after every applied input.
   *
   * Written on EVERY change rather than only on `writeSessionRow`, because the
   * gate reads this file while the process is alive and a dump that lagged the
   * state would make a green check a claim about the past. A failed write is
   * swallowed with a line rather than thrown: a lost dump must not kill a
   * listening daemon, and the line is what stops it being silent.
   */
  private persist(): void {
    try {
      writeFileAtomic(this.statePath, `${JSON.stringify(this.snapshot())}\n`, { mode: 0o600 });
    } catch {
      // No error object and no path: an fs message quotes the path, and the
      // path embeds the account name (`call-session.ts`'s reasoning).
      this.emit('state_write_failed', {});
    }
  }

  // --- dispatch -------------------------------------------------------------

  private dispatch(input: GroupSessionInput): Promise<void> {
    const next = this.chain.then(() => this.apply(input));
    // The chain must survive a failed input, or one error wedges every
    // subsequent one for the life of the process.
    this.chain = next.catch(() => undefined);
    return next;
  }

  private async apply(input: GroupSessionInput): Promise<void> {
    if (this.disposed) return;
    const before = this.state?.sid ?? null;
    const { state, effects } = groupSessionReducer(this.state, input, this.io.now());
    // The state is adopted BEFORE the effects run, exactly as the app's
    // coordinator does it: an effect that dispatches back (a folded leg
    // reporting terminal) must see the state the reducer just decided, never
    // the one it replaced.
    this.state = state;
    // …and the buffers die HERE, with the identity that owned them — the
    // coordinator's `bumpIncarnationIfIdentityChanged`, over this map. The
    // sweep below cannot stand in for it: session glare replaces the loser and
    // rings the winner inside ONE reducer step, so the winner's leg-opening
    // effect drains BEFORE any sweep runs, and `drainPending` validates peer
    // and cid — neither of which says which session they belonged to. A peer
    // that reuses a dead session's cid (costless, and hostile peers are in the
    // threat model) had its own buffered `call.end` replayed into the leg the
    // winner had just opened. A new session starts with an empty buffer.
    if ((state?.sid ?? null) !== before) this.pendingBodies.clear();
    if (state) {
      this.lastSid = state.sid;
      this.lastStarter = state.starterId;
      // A live session is not an ended one. Reset here rather than at `start`,
      // because glare's supersede releases the loser and rings the winner
      // inside ONE input: a reason left over from the collapse would label the
      // client that is now live as finished.
      this.endedReason = null;
    }
    for (const effect of effects) {
      // THE FENCE, the app twin's `stale(gen)` in this class's one-generation
      // form: `dispose` clears the legs and timers mid-await, and an effect
      // run after it would re-open a leg for a runner that is finished.
      if (this.disposed) return;
      try {
        await this.run(effect);
      } catch {
        /*
         * ONE FAILED EFFECT MUST NOT CANCEL ITS SIBLINGS — the guard the app's twin executor has carried since
         * its own round (app/src/call/group.ts, `step`: "One failed effect
         * must not strand a session half-torn-down with the rest of its
         * teardown unrun"), mirrored here with the same semantics: report
         * and continue.
         *
         * Unguarded, this loop was the strand: `CallRunner.sendEnvelope`
         * rethrows a failed signalling send (deliberately — for a 1:1
         * `placeCall` the caller must fail, and a dead transport must still
         * exit NETWORK), so ONE peer whose send rejected — a prekey 404 for
         * a brand-new user, an UntrustedIdentity — aborted every effect
         * after it. Peers later in the roster were never dialled, no
         * `legStateChanged` could ever arrive for them, `maybeRelease`
         * could never see all legs terminal, and the sweep and the persist
         * below were skipped for this input: `live:true phase:joining`
         * forever, with the dump naming a cid for a ginvite never composed.
         *
         * THE ERROR OBJECT IS DELIBERATELY NOT PRINTED: a foreign transport
         * error can embed peer- or server-supplied text (`sendEnvelope`'s
         * own rule), and `emit`'s contract is ours-values and grammar-checked
         * ids only. The effect type and the leg are the observable; the
         * send path has already printed its own classified `send_failed`
         * line before rethrowing.
         */
        const named: Record<string, string | number | boolean> = { effect: effect.type };
        if ('peerId' in effect) named.to = effect.peerId;
        if ('cid' in effect) named.cid = effect.cid;
        this.emit('effect_failed', named);
        /*
         * AND THE FAILING LEG STILL REACHES A TERMINAL STATE — the CLI
         * mirror of the app CallService's fatal-send `localHangup`, and the
         * GATE that mirror requires lives one level down: `CallRunner`'s
         * `sendEnvelope` rethrows ONLY for the app's FATAL_TO_SEND set
         * (offer/answer/restart — call.ts) and DEGRADES everything else, so
         * the only send failure that can escape a leg-opening effect into
         * this catch is one the call could not have survived. The 1:1 machine
         * emits `startTimer connect` AFTER the send in the same effect list,
         * so a leg whose opening send threw has NO timer armed:
         * caught-and-continued alone, it would sit at `inviting` forever and
         * `maybeRelease` — which needs every leg terminal — could never
         * release the session. Fold it (`receiveEnd` tears down without
         * announcing: there is nothing to announce to a peer the transport
         * cannot reach), and its `legStateChanged` drives the reducer's
         * terminal phase, the re-offer repair where the leg is revivable —
         * reachable since an earlier fix returned a torn-down
         * runner to idle, so the repair's fresh dial actually leaves this
         * executor — and the release when nothing is. `failed_ice` is the
         * pre-connect failure class `releaseReason` already folds these
         * into.
         */
        if (
          effect.type === 'openLegDial' ||
          effect.type === 'openLegRinging' ||
          effect.type === 'openLegAnswer'
        ) {
          const leg = this.legs.get(effect.peerId);
          if (leg) await leg.receiveEnd(effect.cid, 'failed_ice').catch(() => undefined);
        }
      }
    }
    // After the effects, so a drain that just consumed a buffer is not swept
    // out from under itself. Ownership decay WITHIN one session only — the
    // session-identity change is handled above, before any effect runs.
    this.sweepPending();
    this.persist();
  }

  // --- effects --------------------------------------------------------------

  private async run(effect: SessionEffect): Promise<void> {
    switch (effect.type) {
      case 'openLegDial': {
        const leg = this.ensureLeg(effect.peerId);
        this.emit('leg_dial', { to: effect.peerId, cid: effect.cid, kind: effect.kind });
        // THE SESSION'S cid, not one the leg mints: the reducer matches every
        // `legStateChanged` against `legs[peerId].cid`, so a leg under any
        // other id reports into a void (see `CallRunner.placeCall`).
        await leg.placeCall(effect.peerId, this.state?.video ?? false, effect.cid);
        await this.drainPending(effect.peerId, effect.cid, leg);
        break;
      }

      case 'openLegRinging': {
        const leg = this.ensureLeg(effect.peerId);
        this.emit('leg_ringing', { from: effect.peerId, cid: effect.cid });
        await this.offerToLeg(leg, effect.peerId, effect.offer);
        await this.drainPending(effect.peerId, effect.cid, leg);
        break;
      }

      case 'openLegAnswer': {
        const leg = this.ensureLeg(effect.peerId);
        // The offer is handed over again even for a leg that has been ringing
        // — the 1:1 machine dedupes a redelivered offer for the live cid to
        // nothing, which is what makes this uniform with the held
        // offers that never had a leg at all.
        await this.offerToLeg(leg, effect.peerId, effect.offer);
        // BEFORE the accept, not after: `acceptIncoming` flushes whatever
        // candidates the call is holding the moment the remote description
        // exists, so a held joiner's early trickle rides out with our answer
        // instead of waiting for the next envelope to arrive.
        await this.drainPending(effect.peerId, effect.cid, leg);
        this.emit('leg_answer', { from: effect.peerId, cid: effect.cid });
        await leg.accept();
        // We just put an answer on the wire; see ICE_CONNECTED_RIG_MS.
        this.armIce(effect.peerId, effect.cid);
        break;
      }

      case 'closeLeg': {
        /*
         * THE DECISION LINE COMES FIRST, before the work that carries it out.
         *
         * It reports the reducer's VERDICT — this cid is closed, for this
         * reason, and an announcement is or is not owed — not the outcome of
         * the send below. Those are two different facts and this line was only
         * ever about the first one; printing it last merely made it hostage to
         * the second.
         *
         * Which is how a hung gate run came to be undiagnosable. The executor
         * awaits a send here, and `io.send` is an unbounded await on the one
         * send chain (`call-session.ts`): when one stalled, this line never
         * printed, and the log could not distinguish "the effect never ran"
         * from "the effect ran and the send is wedged" — the two hypotheses
         * that needed telling apart. Ordered this way they are: a `leg_closed`
         * followed by silence is a wedged send; no line at all means the
         * effect was never reached. `announce=true` with no `leg_close_sent`
         * after it says the same thing in one more place.
         */
        this.emit('leg_closed', {
          to: effect.peerId,
          cid: effect.cid,
          reason: effect.reason,
          announce: effect.announce,
        });
        if (effect.announce) {
          // Sent by the EXECUTOR rather than by the leg, which is what lets a
          // held offer that never had a leg still get its refusal on the wire
          // — and what lets a close carry a reason the 1:1 machine
          // has no local event for (`busy`, `glare_lost`).
          const sentMsgId = await this.io
            .send(
              effect.peerId,
              encodeCallEnvelope({ tcm: 'call.end', cid: effect.cid, r: effect.reason }),
              true,
            )
            .catch(() => null);
          // Its OWN line rather than a field on the decision above, which has
          // already printed and must not be re-stated with a different meaning.
          // Best-effort is still the rule — a refusal that cannot reach the
          // peer costs them a ring timeout and is not worth failing the
          // teardown for — so this reports the loss instead of raising it.
          // `cid` alone on the failure arm: a failure line carries no supplied
          // value (`emit`'s rule), and the cid is ours, ULID-shaped, and
          // printed by the decision line directly above, which is what pairs
          // the two.
          //
          // AND THE SUCCESS ARM NAMES THE TRANSPORT ID. This send is the executor's own — it does not go
          // through `CallRunner`, so it never produced the `CALL sent …
          // msgid=` line the 1:1 frames produce, and its row reached the
          // recipient's queue anonymously. The group gate's leak section binds
          // its scan to the set of msgIds its sender printed; a frame this
          // section stored and nobody named is a stored payload the scan can
          // omit while still calling itself complete. `leg_close_sent` is the
          // line the comment above this effect already promised ("`announce=
          // true` with no `leg_close_sent` after it says the same thing in one
          // more place") and did not emit.
          if (sentMsgId === null) this.emit('leg_close_send_failed', { cid: effect.cid });
          else {
            this.emit('leg_close_sent', {
              to: effect.peerId,
              cid: effect.cid,
              msgid: sentMsgId,
            });
          }
        }
        const leg = this.legs.get(effect.peerId);
        if (leg && leg.cid === effect.cid) {
          await leg.receiveEnd(effect.cid, effect.reason).catch(() => undefined);
        }
        break;
      }

      case 'sendRosterDelta': {
        const body = encodeGroupCallEnvelope(effect.env);
        /*
         * `n` COUNTS SERVER-ACKED SENDS, not attempted ones.
         *
         * It used to count resolutions of `send`, which resolves as soon as
         * the ciphertext has been written to an open socket — and that write
         * is void, callback-free and reports nothing (`WsClient.send`). So the
         * gate's `n == of` check proved the fan-out had been ATTEMPTED for
         * everyone, which is not what a reader takes it to mean, and a server
         * that dropped or refused every one of them still scored a full house.
         *
         * Started TOGETHER and awaited together, rather than one at a time:
         * the ratchet still serializes the encrypts (each `sendAcked` chains
         * onto the one send chain the moment it is called, so the order below
         * is the order on the wire), but the WAITS overlap. Awaited in series
         * a fan-out would cost one ack timeout PER recipient — several dead
         * seconds during which this session's inputs are blocked — instead of
         * one for the whole delta.
         *
         * Best-effort per recipient, unchanged: a delta that cannot reach one
         * live participant must still reach the others, so a rejection is
         * folded to `null` and never inspected — the error object can embed
         * peer- or server-supplied text. `null`, not `false`, and the word
         * matters at this line: `sendAcked` answers `ReceiptKind | null`, so
         * the fold has to land on the value the timeout and the closed socket
         * already produce, or the counts below would be reading a third thing.
         * This comment said `false` for a round, describing a boolean the
         * signature stopped having when the receipt kind stopped collapsing
         *.
         */
        /*
         * AND EACH COPY NAMES ITS TRANSPORT ID, on its own line, the moment
         * the send has one.
         *
         * `delta_sent` below is an AGGREGATE — one line per delta, carrying
         * counts — so it cannot carry the per-recipient ids, and a roster
         * delta therefore reached every recipient's server-side queue without
         * anything naming the row. The gates' leak sections bind their scan to
         * "every msgId this section's sender printed"; its subject is a
         * ginvite (which does print one, through `CallRunner`) followed by a
         * `call.gleave` (which did not), and a stored gleave carries this
         * session's `sid` — the very value that section proves nobody can see.
         * A set that silently omits it is a scan that never examined it.
         *
         * PRINTED AS IT IS MINTED rather than after the fan-out settles, which
         * is this file's own doctrine one effect up: a line printed after the
         * work is hostage to the work, and `sendAcked` waits on a receipt.
         */
        const acks = await Promise.all(
          effect.to.map(to =>
            this.io
              .sendAcked(to, body, effect.urgent, msgId =>
                this.emit('delta_frame', {
                  tcm: effect.env.tcm,
                  sid: effect.env.sid,
                  to,
                  msgid: msgId,
                }),
              )
              .catch(() => null),
          ),
        );
        const sent = acks.filter(kind => kind !== null).length;
        /*
         * `d` COUNTS THE RECIPIENTS WHOSE COPY REACHED A LIVE SOCKET, and it
         * exists because `n` was being read as if it already meant that.
         *
         * `n` is the server's acceptance count: a recipient who is offline
         * acks exactly as fast as one who is listening, because the receipt is
         * posted the moment the ciphertext is QUEUED. That is the right
         * barrier for ORDERING — it is a fact about the server, and the server
         * is what governs what anyone is handed — and it is not a delivery.
         * the e2e group-call harness read a full `n` as "the frame was handed to
         * him", which the protocol does carry (`state: 'delivered'`) and which
         * this line had been throwing away.
         *
         * Two numbers rather than one, because both claims have a customer:
         * `n` for "the server took it, so anything composed after this is
         * behind it", `d` for "it reached that participant's socket".
         */
        const delivered = acks.filter(kind => kind === 'delivered').length;
        this.emit('delta_sent', {
          tcm: effect.env.tcm,
          sid: effect.env.sid,
          m: effect.env.m,
          se: effect.env.se,
          n: sent,
          d: delivered,
          of: effect.to.length,
        });
        break;
      }

      case 'reportGroupIncoming':
        this.emit('ringing', {
          sid: effect.sid,
          from: effect.starterId,
          video: effect.hasVideo,
        });
        break;

      case 'reportGroupOutgoing':
        this.emit('calling', { sid: effect.sid });
        break;

      case 'reportGroupConnected':
        this.emit('connected', { sid: effect.sid });
        break;

      case 'releaseGroupCall':
        this.endedReason = effect.reason;
        this.emit('released', { sid: effect.sid, reason: effect.reason });
        break;

      case 'writeSessionRow':
        // The CLI's "row" IS the dump `apply` writes after every input; this
        // effect only says so out loud, so a reader of the output can see the
        // persist-before-ring ordering the reducer imposes.
        this.emit('row_written', {});
        break;

      case 'closeSessionRow':
        // There is no `call_sessions` table in this client, so there is no row
        // to delete — the LIVE record is the dump, and `persist()` replaces it
        // with a terminal `live:false` snapshot at the end of this same input.
        // Deliberately replaced rather than removed: the pinned check asserts that
        // "no client believes the session lives" ON THE JSON STATE DUMPS, and
        // a check satisfied by a missing file is satisfied equally by a client
        // that never started. The dump is a proof-client artifact and is
        // documented as one; the sid rides the EFFECT (never `state.sid`)
        // because a glare supersede tears the loser down in the same step that
        // rings the winner, which is the reducer's own note.
        this.emit('row_closed', { sid: effect.sid });
        break;

      case 'startReofferTimer': {
        // A fresh cid per re-offer, minted here because a pure reducer
        // cannot mint a ULID.
        const cid = ulid();
        const handle = setTimeout(() => {
          this.timers.delete(handle);
          void this.dispatch({ type: 'reofferTimer', peerId: effect.peerId, cid });
        }, effect.ms);
        handle.unref?.();
        this.timers.add(handle);
        this.emit('reoffer_armed', { to: effect.peerId, ms: effect.ms });
        break;
      }

      case 'dismissRing':
        // No VoIP placeholder at a terminal; the line exists so a refusal that
        // sends nothing and decides nothing locally is still OBSERVABLE — the
        // exact reason the effect was added to the reducer.
        this.emit('ring_dismissed', { from: effect.peerId });
        break;

      case 'legUnreachable':
        this.emit('leg_unreachable', { to: effect.peerId });
        break;
    }
  }

  // --- frames that arrive before their leg -----------------------------------

  /**
   * Hold a frame for a cid this session OWNS but has no leg runner for.
   *
   * The window: an admitted `join_leg` offer is HELD until a human
   * answers the session (opening a leg would start the camera), so
   * between the offer and the answer the joiner's cid is owned by
   * `state.heldOffers` and by nothing that can receive a frame. The joiner
   * trickles anyway — correctly; it has an offer out. Those frames used to
   * fall through to the 1:1 fallback, which printed a `CALL recv` line about a
   * group frame and dropped the candidates on the floor, so the leg the answer
   * opened a moment later began with none of the candidates already gathered
   * for it.
   *
   * Buffered, never routed: nothing here is applied to any state, and the
   * frames are replayed through the SAME `leg.onBody` path they would have
   * taken had the leg existed. Bounded by `MAX_PENDING_LEG_BODIES`.
   */
  private bufferForLeg(
    peerId: string,
    cid: string,
    tcm: string,
    body: string,
    serverTs: number,
  ): void {
    const held = this.pendingBodies.get(peerId);
    if (!held || held.cid !== cid) {
      // A different cid replaces the buffer wholesale, exactly as a newer held
      // offer replaces an older one in the reducer: the superseded cid's frames
      // describe a peer connection neither side will ever build.
      this.pendingBodies.set(peerId, { cid, frames: [{ body, serverTs, tcm }], dropped: 0 });
      return;
    }
    held.frames.push({ body, serverTs, tcm });
    if (held.frames.length > MAX_PENDING_LEG_BODIES) {
      held.frames.shift();
      held.dropped += 1;
    }
  }

  /**
   * A leg now exists for `cid` — replay what waited for it, in arrival order.
   *
   * Called from every leg-opening effect rather than only from the held-offer
   * answer, because the hold is not the only way a frame can outrun its leg:
   * the reducer adopts a leg into `state.legs` BEFORE the executor's effect
   * runs `ensureLeg`, so a frame that arrives inside that gap is owned and
   * legless too.
   *
   * The buffer is consumed either way — a leg opened under a DIFFERENT cid
   * means the frames' call is gone, and replaying them would be one call's ICE
   * arriving under another call's id.
   */
  private async drainPending(peerId: string, cid: string, leg: CallRunner): Promise<void> {
    const held = this.pendingBodies.get(peerId);
    if (!held) return;
    this.pendingBodies.delete(peerId);
    if (held.cid !== cid) return;
    // One line per drain, not one per frame: the count is peer-controlled, and
    // a line per buffered frame would hand a flooding peer the log. Silent
    // buffering with no line at all is the other failure — `dropped` is how a
    // gate sees the cap bite.
    this.emit('pending_drained', {
      from: peerId,
      cid,
      n: held.frames.length,
      dropped: held.dropped,
    });
    for (const frame of held.frames) {
      await leg.onBody(peerId, frame.body, frame.serverTs).catch(() => undefined);
      // The same rule `onBody` applies to a live leg, and now literally the
      // same predicate: an answer the leg TOOK, not a frame that called itself
      // one (see ICE_CONNECTED_RIG_MS and `answerWasAccepted`).
      if (frame.tcm === 'call.answer' && answerWasAccepted(leg)) this.armIce(peerId, cid);
    }
  }

  /**
   * Drop every buffer whose cid this session no longer owns.
   *
   * Ownership decay inside ONE session's life, which is all this is left
   * covering now that a change of session identity clears the map outright in
   * `apply`: the starter removed the peer, the ring collapsed under the held
   * offers, or the answer found the hold aged past its offer and skipped it —
   * that last one emits no `closeLeg` at all, which is exactly the kind of
   * path a per-effect hook misses. ONE rule for all of them rather than a hook
   * in each.
   */
  private sweepPending(): void {
    for (const [peerId, held] of this.pendingBodies) {
      if (!this.ownsCid(peerId, held.cid)) this.pendingBodies.delete(peerId);
    }
  }

  private async offerToLeg(
    leg: CallRunner,
    peerId: string,
    offer: StoredGroupOffer,
  ): Promise<void> {
    await leg.receiveOffer(
      peerId,
      offer.invite.cid,
      offer.invite.sdp,
      offer.invite.vid,
      offer.invite.exp,
      offer.serverTs,
    );
  }

  // --- legs -----------------------------------------------------------------

  private ensureLeg(peerId: string): CallRunner {
    const existing = this.legs.get(peerId);
    if (existing) return existing;
    const leg = new CallRunner(
      {
        send: (to, body, urgent) => this.io.send(to, body, urgent),
        writeLog: row => this.io.writeLog(row),
        now: () => this.io.now(),
      },
      this.selfId,
    );
    leg.canary = this.options.canary;
    leg.expOffsetMs = this.options.expOffsetMs ?? 0;

    /**
     * THE ONE REWRITE: a leg's `call.offer` IS the session's ginvite.
     *
     * Everything else — answer, ICE, ringing, media, restart, end — travels as
     * the ordinary 1:1 kind it already is, which is why no leg needed a new
     * envelope and why the e2e call harness still describes every leg.
     *
     * `r` is the roster this device HOLDS (`[...s.roster]`, the app's own
     * expression), not a roster composed here: composing one would be this
     * file deciding who is in the call.
     */
    leg.onEnvelope = envelope => {
      const s = this.state;
      if (envelope.tcm !== 'call.offer' || s === null) {
        return { tcm: envelope.tcm as string, body: encodeCallEnvelope(envelope) };
      }
      const invite: GroupCallInviteEnvelope = {
        tcm: 'call.ginvite',
        sid: s.sid,
        cid: envelope.cid,
        r: [...s.roster],
        sdp: envelope.sdp,
        vid: envelope.vid,
        exp: envelope.exp,
      };
      return { tcm: invite.tcm, body: encodeGroupCallEnvelope(invite) };
    };

    leg.onState = (state: CallState, reason: CallEndReason | undefined) => {
      const cid = state.call?.cid ?? this.legCid.get(peerId);
      if (state.call?.cid) this.legCid.set(peerId, state.call.cid);
      if (!cid) return;
      // Fire-and-forget onto the serialized chain, the app's `void
      // this.dispatch(...)`: this callback runs INSIDE an effect the executor
      // is already awaiting, so awaiting it here would deadlock the chain
      // against itself.
      void this.dispatch({
        type: 'legStateChanged',
        peerId,
        cid,
        name: state.name,
        ...(reason ? { reason } : {}),
      });
      // Our answer is on its way out — see ICE_CONNECTED_RIG_MS.
      if (state.name === 'incoming_answering') this.armIce(peerId, cid);
    };

    this.legs.set(peerId, leg);
    return leg;
  }

  /** Pretend ICE reached connected on this leg shortly after an answer was
   * observed. The only wall-clock rigging in the file, and it is armed by an
   * observation rather than by the passage of time (see ICE_CONNECTED_RIG_MS).
   *
   * `cid` NAMES THE CALL WHOSE ANSWER WAS OBSERVED, and the fire-time check is
   * `closeLeg`'s predicate again, for the same reason as `onBody`'s: the leg
   * map is never pruned, and `iceConnected()` addresses whatever call the
   * runner holds AT FIRE TIME — `iceStateChanged{connected}` promotes any
   * non-ending state, an unanswered `incoming_ringing` included. Keyed by peer
   * alone, a timer armed by a dead session's answer connected the NEXT
   * session's still-ringing leg on the same runner, an answer never having
   * crossed the wire — the invariant this constant's own docblock states. A
   * runner on a different cid (or idle: `leg.cid` is null) means the armed
   * answer's call is gone, and the rig must die with it.
   *
   * AND EVERY CALLER ARMS ON AN OBSERVED TRANSITION, never on a frame kind:
   * `openLegAnswer` after the accept, `onState` on
   * `incoming_answering`, and the two inbound routes through
   * `answerWasAccepted`. A fire-time check cannot save a rig that was armed by
   * a frame the leg discarded — the leg still holds the cid, so the check
   * passes and a ringing call is promoted. */
  private armIce(peerId: string, cid: string): void {
    const handle = setTimeout(() => {
      this.timers.delete(handle);
      const leg = this.legs.get(peerId);
      if (!leg || leg.cid !== cid) return;
      void leg.iceConnected().catch(() => undefined);
    }, ICE_CONNECTED_RIG_MS);
    handle.unref?.();
    this.timers.add(handle);
  }

  // --- inbound --------------------------------------------------------------

  /**
   * Handle a decrypted body from `peerId`.
   *
   * Returns true when the body was CALL TRANSPORT — a session envelope, a
   * frame naming a cid this session owns, or something under the `call.`
   * namespace this build cannot read — so the caller knows not to render it as
   * a chat message. Nothing here decides anything about the session's
   * CONTENTS; it decides only where the bytes go, plus the one busy refusal
   * put at this seam and nowhere else.
   *
   * THE ORDER, and the reason each step is where it is:
   *
   *  1. A session envelope. The busy rule's second half sits inside it: a live 1:1 call
   *     makes this device busy to a `ginvite`, refused with the existing
   *     `call.end{r:'busy'}` on the offered leg (there is no `call.gbusy` —
   *     departure 3), and the session reducer never sees the invite at all.
   *  2. A frame whose cid THIS SESSION OWNS, to that peer's leg. By cid, not
   *     by "does a leg object exist for this peer" — the executor's leg map
   *     outlives the session that built it, so peer-keyed routing handed a
   *     later, unrelated 1:1 offer to a stale group leg, which then adopted
   *     it into the mesh (an earlier review).
   *  2b. …and when the cid is owned but no leg exists yet — the reducer holds a
   *     joiner's offer until a human answers — the frame WAITS for its leg
   *     rather than falling through. Falling through cost the candidates a
   *     joiner trickled behind its held offer, and narrated a group frame in
   *     1:1 words on the way (`bufferForLeg`).
   *  3. The busy rule's first half: any other `call.offer` while a session is live is a
   *     stray, answered `busy`. Refused HERE rather than by the 1:1 reducer
   *     for the app's own reason — that reducer models one call and knows
   *     nothing about the session holding the microphone, so its `reportBusy`
   *     path would never fire and the caller would ring out the full 45
   *     seconds against a device that is already in a call.
   *  4. Everything else to the account's ordinary 1:1 runner, unchanged.
   */
  async onBody(peerId: string, body: string, serverTs: number): Promise<boolean> {
    if (!body.startsWith('{"tcm":')) return false;

    const envelope = parseGroupCallEnvelope(body);
    if (envelope) {
      // `peerId` is the ratchet-authenticated `frame.from`, and it is passed
      // straight through as `from` — the writerId rule. Nothing below reads a
      // sender out of a payload field, and the reducer's admission is the only
      // thing that decides what a sender may do.
      this.emit('recv', { tcm: envelope.tcm, sid: envelope.sid, from: peerId });
      switch (envelope.tcm) {
        case 'call.ginvite':
          // The busy rule, the half that protects a live 1:1 CALL from a session. Only
          // when we hold NO session: with one live, admission is the only
          // judge of a second invite (glare, join_leg, over-cap) and a
          // busy here would pre-empt it. That is the app's condition
          // verbatim (`group.ts`: `this.state === null && oneToOneBusy()`).
          if (this.state === null && this.oneToOneBusy()) {
            await this.refuseBusy(peerId, envelope.cid);
            break;
          }
          await this.dispatch({
            type: 'ginviteReceived',
            from: peerId,
            selfId: this.selfId,
            invite: envelope,
            serverTs,
          });
          await this.maybeAutoRespond();
          break;
        case 'call.gjoin':
          await this.dispatch({ type: 'gjoinReceived', from: peerId, delta: envelope });
          break;
        case 'call.gleave':
          await this.dispatch({ type: 'gleaveReceived', from: peerId, delta: envelope });
          break;
      }
      return true;
    }

    // Parsed once and shared by the two decisions below. A body that does not
    // parse as a 1:1 envelope owns no cid and cannot be an offer, so it falls
    // straight through to the fallback — where the namespace rule keeps it
    // silent if it is `call.*` (see `CallRunner.onBody`). Parsed rather than
    // string-matched so a malformed body can arm and adopt nothing.
    const call = parseCallEnvelope(body);

    if (call && this.ownsCid(peerId, call.cid)) {
      // BY CID AT THE DESTINATION TOO, not only at admission — `closeLeg`'s
      // own predicate (`leg && leg.cid === effect.cid`), because the leg map
      // outlives every session and is never pruned (see `ensureLeg`): an
      // existence-only test here handed a held joiner's frames to the STALE
      // runner a finished session cached for that peer, whose idle 1:1
      // machine narrated and then discarded them. A cached runner that does
      // not hold THIS cid is no more a destination than no runner at all, so
      // the mismatch falls through to the same buffer-or-refuse aftermath below.
      const leg = this.legs.get(peerId);
      if (leg && leg.cid === call.cid) {
        const handled = await leg.onBody(peerId, body, serverTs);
        // Their answer arrived AND THE LEG TOOK IT. The kind alone is not an
        // observation: `answerReceived` discards an answer outside its
        // accepting states, and arming on the frame connected a leg still
        // ringing (see ICE_CONNECTED_RIG_MS and `answerWasAccepted`).
        if (call.tcm === 'call.answer' && answerWasAccepted(leg)) this.armIce(peerId, call.cid);
        return handled;
      }
      // Owned, but the leg that would receive it does not exist yet (the
      // held offer, in practice). HELD HERE and returned as transport, which
      // is also what stops the fallback narrating a group frame as a 1:1 one.
      // An offer is the exception: under an owned cid it is a redelivery the
      // reducer already holds — replaying it into the leg would hand
      // the leg an offer it was opened with, and refusing it is the call
      // below, not this buffer's.
      if (call.tcm !== 'call.offer') {
        this.bufferForLeg(peerId, call.cid, call.tcm, body, serverTs);
        return true;
      }
    }

    // The busy rule, the half that protects a live SESSION from a stray 1:1 offer.
    if (call?.tcm === 'call.offer' && this.state !== null) {
      await this.refuseBusy(peerId, call.cid);
      return true;
    }

    // Neither a session envelope, nor a frame this session owns, nor a stray
    // invite. The account's ordinary 1:1 runner answers for it, so chat still
    // renders and a plain call still works around a session.
    if (this.options.fallback) return this.options.fallback.onBody(peerId, body, serverTs);
    // No 1:1 runner underneath (unit rigs only). The namespace still decides,
    // and it decides SILENTLY: `call.*` is transport whether or not this build
    // can parse it, and anything else was never this class's to claim.
    return isCallTransportBody(body);
  }

  /**
   * Does THIS SESSION own `cid`, for THIS peer?
   *
   * `app/src/call/group.ts`'s `ownsCid`, narrowed to the sender — which it can
   * be here because the answer picks `legs.get(peerId)`, and a cid belonging
   * to some OTHER peer's leg must never route a frame into this one's. The
   * three places a cid lives are the three the app names: the live leg, a held
   * join_leg offer, and the starter's own invite while we are still
   * ringing. That last one is load-bearing, not defensive: `ringFresh` opens
   * the leg RUNNER through `openLegRinging` while leaving `state.legs` empty
   * until the human answers, so a starter's ICE arriving mid-ring is owned by
   * `starterOffer` and by nothing else.
   */
  private ownsCid(peerId: string, cid: string): boolean {
    const s = this.state;
    if (!s) return false;
    if (s.legs[peerId]?.cid === cid) return true;
    if (s.heldOffers[peerId]?.invite.cid === cid) return true;
    if (s.starterId === peerId && s.starterOffer?.invite.cid === cid) return true;
    return false;
  }

  /**
   * the other input: is the ordinary 1:1 runner in a call?
   *
   * `callController().state.name !== 'idle'` — the app's expression
   * (`call/index.ts`, "the two shapes are one microphone"), over the runner
   * this session was handed. `ending` counts as busy on purpose: the teardown
   * is on the wire and the microphone is not free yet.
   */
  private oneToOneBusy(): boolean {
    const fallback = this.options.fallback;
    return fallback !== undefined && fallback.stateName !== 'idle';
  }

  /**
   * The refusal, in both directions: `call.end{r:'busy'}` on the OFFERED
   * cid, sent by the EXECUTOR because there is no leg to send it from — and
   * deliberately the same frame for a stray 1:1 offer and for a ginvite,
   * because `call.gbusy` was refused at design time (departure 3) and a
   * caller that cannot parse groups must still learn it was refused.
   *
   * Best-effort, like every other executor send: a refusal that cannot reach
   * the caller costs them a ring timeout, which is a degradation and not a
   * reason to fail the session. The GCALL line is what stops it being silent.
   */
  private async refuseBusy(peerId: string, cid: string): Promise<void> {
    this.emit('busy', { from: peerId, cid });
    await this.io
      .send(peerId, encodeCallEnvelope({ tcm: 'call.end', cid, r: 'busy' }), true)
      .catch(() => undefined);
  }

  /** The rule: a session is answered ONCE, by a person, not once per leg.
   * The auto-answer rigging therefore lives at the session, not on each leg. */
  private async maybeAutoRespond(): Promise<void> {
    if (this.state?.phase !== 'ringing') return;
    if (this.options.autoDecline) {
      await this.decline();
      return;
    }
    if (this.options.autoAnswer) await this.answer();
  }

  // --- local actions --------------------------------------------------------

  /**
   * Start a small-group call. `roster` must include this device — the reducer
   * refuses otherwise, and refusing there rather than here is the point.
   *
   * The sid and one cid per callee are minted HERE because a pure reducer
   * cannot mint a ULID; `placeCall` carries its cid for exactly the same
   * reason.
   */
  async start(
    roster: readonly string[],
    video: boolean,
    roomId: string | null = null,
  ): Promise<string> {
    const sid = ulid();
    const cids: Record<string, string> = {};
    for (const peerId of roster) if (peerId !== this.selfId) cids[peerId] = ulid();
    const reportId = ulid();
    await this.dispatch({
      type: 'start',
      sid,
      selfId: this.selfId,
      roster,
      video,
      reportId,
      roomId,
      cids,
    });
    return sid;
  }

  /** Answer the ringing session. A cid is minted for every other member: the
   * reducer picks which of them THIS device offers to and refuses loudly
   * if a cid it needs is missing, so minting the superset is the cheap side. */
  async answer(): Promise<void> {
    const s = this.state;
    if (!s) return;
    const cids: Record<string, string> = {};
    for (const peerId of s.roster) if (peerId !== this.selfId) cids[peerId] = ulid();
    await this.dispatch({ type: 'localAnswer', cids });
  }

  async decline(): Promise<void> {
    await this.dispatch({ type: 'localDecline' });
  }

  /**
   * Leave. Sovereign for a member, an AUTHORITY starter-out for the starter —
   * a distinction the reducer makes and this method does not: it dispatches
   * one input either way.
   */
  async leave(): Promise<void> {
    if (!this.state) return;
    await this.dispatch({ type: 'localHangup' });
  }

  /** The starter adds a member mid-call. Refused by the reducer for a
   * non-starter, which is why there is no check here. */
  async addParticipant(peerId: string): Promise<void> {
    await this.dispatch({ type: 'addParticipant', peerId, cid: ulid() });
  }

  dispose(): void {
    this.disposed = true;
    for (const handle of this.timers) clearTimeout(handle);
    this.timers.clear();
    for (const leg of this.legs.values()) leg.dispose();
    this.legs.clear();
    // Nothing will ever open a leg for these again, and `apply` — the sweep's
    // home — returns early once disposed.
    this.pendingBodies.clear();
  }
}

/** Every field of a dump, with the check that decides it is that field. */
const DUMP_FIELDS: Record<string, (v: unknown) => boolean> = {
  live: isBool,
  sid: isStringOrNull,
  starterId: isStringOrNull,
  selfId: (v) => typeof v === 'string',
  roster: isStringArray,
  announced: isStringArray,
  se: (v) => typeof v === 'number' && Number.isFinite(v),
  video: isBool,
  phase: isStringOrNull,
  legs: (v) => Array.isArray(v) && v.every(isLegDump),
  heldOffers: isStringArray,
  callKit: isStringOrNull,
  connected: isBool,
  endedReason: isStringOrNull,
};

function isBool(v: unknown): boolean {
  return typeof v === 'boolean';
}
function isStringOrNull(v: unknown): boolean {
  return v === null || typeof v === 'string';
}
function isStringArray(v: unknown): boolean {
  return Array.isArray(v) && v.every((e) => typeof e === 'string');
}
function isLegDump(v: unknown): boolean {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const leg = v as Record<string, unknown>;
  return (
    typeof leg.peerId === 'string' &&
    typeof leg.cid === 'string' &&
    typeof leg.phase === 'string' &&
    (leg.direction === 'in' || leg.direction === 'out') &&
    typeof leg.reoffersLeft === 'number'
  );
}

/**
 * Is this document the thing this program writes?
 *
 * A PARSE IS NOT A VALIDATION, and the gap between the two was a false
 * negative with a gate on the other end of it. `readGroupCallState` used to
 * CAST whatever `JSON.parse` returned — `{}`, `7`, `[]`, `null` — to
 * `GroupCallStateDump`, and `cmdGroupCallState` refused only the null. So
 * replacing a client's `gcall-state.json` with `{}` made `gcall` exit 0 and
 * print `{}`, and the e2e group-call harness — "does carol's state name the session
 * she was not supposed to learn?" — found no sid in it and declared success,
 * over a document that says nothing about any session at all. Every other
 * negative built on this command has the same hole.
 *
 * THE SHAPE IS DECIDABLE BECAUSE THERE IS EXACTLY ONE WRITER. `snapshot()`
 * emits every field on both of its arms and `writeState` puts the whole object
 * through `writeFileAtomic`, so a partial document did not come from this
 * program — and a document this program did not write is precisely what a
 * negative assertion must not be allowed to rest on. Unknown EXTRA keys are
 * tolerated (a newer build's dump read by an older one is a compatibility
 * question, not a corruption); missing or mistyped ones are not.
 */
function isGroupCallStateDump(value: unknown): value is GroupCallStateDump {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const dump = value as Record<string, unknown>;
  for (const [field, ok] of Object.entries(DUMP_FIELDS)) {
    if (!Object.hasOwn(dump, field) || !ok(dump[field])) return false;
  }
  return true;
}

/**
 * Read a client's dumped session state, or null when it holds none.
 *
 * NULL MEANS "NO ANSWER", and the caller (main.ts `cmdGroupCallState`) tells
 * the two apart by asking whether the file EXISTS: absent file plus null is a
 * client that never held a session; present file plus null is a refusal. A
 * document that parses but is not a dump now takes the second road rather than
 * being cast into the first.
 */
export function readGroupCallState(name: string): GroupCallStateDump | null {
  const path = groupCallStatePath(name);
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return isGroupCallStateDump(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
