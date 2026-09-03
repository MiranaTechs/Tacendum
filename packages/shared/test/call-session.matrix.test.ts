import { describe, expect, it } from 'vitest';
import type {
  CallEndReason,
  CallEnvelope,
  GroupCallEnvelope,
} from '../src/call.js';
import {
  callReducer,
  idleState,
  type CallEvent,
  type CallState,
} from '../src/call-machine.js';
import {
  groupSessionReducer,
  type GroupSessionInput,
  type GroupSessionState,
  type SessionEffect,
} from '../src/call-session.js';

/**
 * The matrix: the
 * pure session module composed with N REAL `callReducer` instances, one per
 * leg, with every effect delivered cross-wise as events. Nothing here mocks
 * the leg machine: the glare guard, the restart round trip, the busy path
 * and the timers are the shipped 1:1 reducer, byte-identical.
 *
 * The instrument is calibrated before it measures (§14's risk row): the
 * first block reproduces KNOWN 1:1 behaviours through the harness — restart
 * recovery, the busy refusal, dead-cid redelivery — so a later red scenario
 * indicts the session layer and not the measuring device.
 */

const NOW = 1_700_000_000_000;
const S = '01BX5ZZKBKACTAV9WEVGEMMVS0'; // the starter throughout
const A = '01BX5ZZKBKACTAV9WEVGEMMVS1';
const B = '01BX5ZZKBKACTAV9WEVGEMMVS2';
const C = '01BX5ZZKBKACTAV9WEVGEMMVS3'; // the late joiner
const STRANGER = '01BX5ZZKBKACTAV9WEVGEMMVSZ';
const SID = '01ARZ3NDEKTSV4RRFFQ69G5FAA';
const SID_HIGHER = '01ARZ3NDEKTSV4RRFFQ69G5FZZ';
const SDP = 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\na=fingerprint:sha-256 AA:BB\r\n';

type Frame =
  | { lane: 'group'; from: string; to: string; env: GroupCallEnvelope }
  | { lane: 'leg'; from: string; to: string; env: CallEnvelope };

interface LegBox {
  peerId: string;
  state: CallState;
  pendingSdp: string | null;
}

/** One device: a session reducer plus one REAL callReducer per leg, and the
 * minimal executor between them — the coordinator's shape, as a fixture. */
class Dev {
  session: GroupSessionState | null = null;
  legs = new Map<string, LegBox>(); // keyed by cid, exactly as TacendumCallImpl.calls is
  reoffers = new Map<string, number>(); // peerId → dueAt
  counts = { incoming: 0, outgoing: 0, connected: 0, released: 0 };
  released: CallEndReason[] = [];

  constructor(
    readonly id: string,
    readonly world: World,
  ) {}

  input(input: GroupSessionInput): void {
    const step = groupSessionReducer(this.session, input, this.world.now);
    this.session = step.state;
    for (const effect of step.effects) this.exec(effect);
  }

  private exec(e: SessionEffect): void {
    switch (e.type) {
      case 'openLegDial':
        this.legs.set(e.cid, { peerId: e.peerId, state: idleState(), pendingSdp: null });
        this.leg(e.cid, {
          type: 'placeCall',
          cid: e.cid,
          peerId: e.peerId,
          video: this.session?.video ?? false,
        });
        break;
      case 'openLegRinging':
        this.legs.set(e.cid, { peerId: e.peerId, state: idleState(), pendingSdp: null });
        this.leg(e.cid, {
          type: 'offerReceived',
          cid: e.cid,
          peerId: e.peerId,
          sdp: e.offer.invite.sdp,
          video: e.offer.invite.vid,
          exp: e.offer.invite.exp,
          serverTs: e.offer.serverTs,
        });
        break;
      case 'openLegAnswer':
        if (!this.legs.has(e.cid)) {
          this.legs.set(e.cid, { peerId: e.peerId, state: idleState(), pendingSdp: null });
          this.leg(e.cid, {
            type: 'offerReceived',
            cid: e.cid,
            peerId: e.peerId,
            sdp: e.offer.invite.sdp,
            video: e.offer.invite.vid,
            exp: e.offer.invite.exp,
            serverTs: e.offer.serverTs,
          });
        }
        this.leg(e.cid, { type: 'localAccept' });
        break;
      case 'closeLeg':
        if (e.announce) {
          this.world.queue.push({
            lane: 'leg',
            from: this.id,
            to: e.peerId,
            env: { tcm: 'call.end', cid: e.cid, r: e.reason },
          });
        }
        // Fold the service without a second announcement (endReceived's path).
        this.leg(e.cid, { type: 'endReceived', cid: e.cid, reason: e.reason });
        break;
      case 'sendRosterDelta':
        for (const to of e.to) {
          this.world.queue.push({ lane: 'group', from: this.id, to, env: e.env });
        }
        break;
      case 'reportGroupIncoming':
        this.counts.incoming++;
        break;
      case 'reportGroupOutgoing':
        this.counts.outgoing++;
        break;
      case 'reportGroupConnected':
        this.counts.connected++;
        break;
      case 'releaseGroupCall':
        this.counts.released++;
        this.released.push(e.reason);
        break;
      case 'startReofferTimer':
        this.reoffers.set(e.peerId, this.world.now + e.ms);
        break;
      case 'persistOffer':
      case 'writeSessionRow':
      case 'closeSessionRow':
      case 'legUnreachable':
        break;
    }
  }

  /** Drive one leg's REAL callReducer and execute its effects. */
  leg(cid: string, event: CallEvent): void {
    const box = this.legs.get(cid);
    if (!box) return;
    const before = box.state.name;
    const step = callReducer(box.state, event, this.world.now);
    box.state = step.state;
    let endReason: CallEndReason | undefined;
    for (const effect of step.effects) {
      switch (effect.type) {
        case 'createOffer':
        case 'createAnswer':
        case 'restartIce':
          // The native module's job, faked to a deterministic string: the
          // template-filling contract (`pendingSdp`) is what matters here.
          box.pendingSdp = `sdp-${cid}-${this.world.seq++}`;
          break;
        case 'sendEnvelope': {
          let env = effect.envelope;
          if ('sdp' in env && env.sdp === '') {
            env = { ...env, sdp: box.pendingSdp ?? 'sdp-missing' };
          }
          if (env.tcm === 'call.offer' && this.session) {
            // The coordinator's rewrite (§4.2): a session leg's offer IS the
            // ginvite — same sdp/vid/exp, plus the session binding and the
            // roster this device holds.
            this.world.queue.push({
              lane: 'group',
              from: this.id,
              to: effect.peerId,
              env: {
                tcm: 'call.ginvite',
                sid: this.session.sid,
                cid: env.cid,
                r: [...this.session.roster],
                sdp: env.sdp,
                vid: env.vid,
                exp: env.exp,
                // The epoch this device holds, exactly as `legSend` composes
                // it: a member added mid-call must start where the starter
                // is, not at 0.
                se: this.session.se,
              },
            });
          } else {
            this.world.queue.push({ lane: 'leg', from: this.id, to: effect.peerId, env });
          }
          break;
        }
        case 'endCallKit':
          // Stripped (§4.5) — but it carries the terminal reason the session
          // input needs, exactly as the real CallService knows it.
          endReason = effect.reason;
          break;
        default:
          // Per-leg CallKit reports: stripped. Timers: fired by the scenario.
          break;
      }
    }
    if (step.state.name !== before) {
      this.input({
        type: 'legStateChanged',
        peerId: box.peerId,
        cid,
        name: step.state.name,
        reason: endReason,
        // The peer's answer, as the coordinator's `onLegState` reports it:
        // the 1:1 machine latches `answeredAt` when their `call.answer` lands
        // and keeps it through `ending`, which is what lets the session count
        // an answered-then-failed leg as proof of presence.
        ...(step.state.call?.answeredAt != null
          ? { answeredAt: step.state.call.answeredAt }
          : {}),
      });
      if (step.state.name === 'ending') {
        this.leg(cid, { type: 'teardownComplete' });
      }
    }
  }

  legTo(peerId: string): { cid: string; box: LegBox } | undefined {
    for (const [cid, box] of this.legs) {
      if (box.peerId === peerId && box.state.name !== 'idle' && box.state.name !== 'ending') {
        return { cid, box };
      }
    }
    return undefined;
  }
}

class World {
  now = NOW;
  seq = 0;
  queue: Frame[] = [];
  heldBack: Frame[] = [];
  devs = new Map<string, Dev>();

  dev(id: string): Dev {
    let dev = this.devs.get(id);
    if (!dev) {
      dev = new Dev(id, this);
      this.devs.set(id, dev);
    }
    return dev;
  }

  /** Deliver until quiet. Frames matching `hold` are parked, not delivered —
   * the §3.6 race is manufactured by holding the authority gjoin back. */
  flush(hold?: (f: Frame) => boolean): void {
    let guard = 0;
    while (this.queue.length > 0) {
      if (guard++ > 10_000) throw new Error('harness runaway');
      const frame = this.queue.shift()!;
      if (hold?.(frame)) {
        this.heldBack.push(frame);
        continue;
      }
      this.deliver(frame);
    }
  }

  releaseHeld(): void {
    this.queue.push(...this.heldBack);
    this.heldBack = [];
  }

  private deliver(frame: Frame): void {
    const dev = this.devs.get(frame.to);
    if (!dev) return; // nobody home — the honest network
    if (frame.lane === 'group') {
      const env = frame.env;
      if (env.tcm === 'call.ginvite') {
        dev.input({
          type: 'ginviteReceived',
          from: frame.from,
          selfId: dev.id,
          invite: env,
          serverTs: this.now,
        });
      } else if (env.tcm === 'call.gjoin') {
        dev.input({ type: 'gjoinReceived', from: frame.from, delta: env });
      } else {
        dev.input({ type: 'gleaveReceived', from: frame.from, delta: env });
      }
      return;
    }
    const env = frame.env;
    if (!dev.legs.has(env.cid)) return; // dead-cid redelivery: dropped (§5.6)
    switch (env.tcm) {
      case 'call.answer':
        dev.leg(env.cid, { type: 'answerReceived', cid: env.cid, sdp: env.sdp, video: env.vid });
        break;
      case 'call.ringing':
        dev.leg(env.cid, { type: 'ringingReceived', cid: env.cid });
        break;
      case 'call.end':
        dev.leg(env.cid, { type: 'endReceived', cid: env.cid, reason: env.r });
        break;
      case 'call.ice':
        dev.leg(env.cid, { type: 'iceReceived', cid: env.cid, candidates: env.c });
        break;
      case 'call.media':
        dev.leg(env.cid, { type: 'mediaReceived', cid: env.cid, audio: env.a, video: env.v });
        break;
      case 'call.restart':
        dev.leg(env.cid, { type: 'restartReceived', cid: env.cid, sdp: env.sdp });
        break;
      case 'call.offer':
        dev.leg(env.cid, {
          type: 'offerReceived',
          cid: env.cid,
          peerId: frame.from,
          sdp: env.sdp,
          video: env.vid,
          exp: env.exp,
          serverTs: this.now,
        });
        break;
    }
  }

  /** Fire due re-offer timers, minting the fresh cid the coordinator would. */
  advance(ms: number): void {
    this.now += ms;
    for (const dev of this.devs.values()) {
      for (const [peerId, dueAt] of [...dev.reoffers]) {
        if (dueAt <= this.now) {
          dev.reoffers.delete(peerId);
          dev.input({ type: 'reofferTimer', peerId, cid: this.mint() });
        }
      }
    }
    this.flush();
  }

  mint(): string {
    return `01HRNSCID${(this.seq++).toString(36).toUpperCase().padStart(17, '0')}`;
  }

  /** ICE connects on both ends of the one leg a pair shares. */
  connect(aId: string, bId: string): void {
    const a = this.dev(aId);
    const b = this.dev(bId);
    const legA = a.legTo(bId);
    const legB = b.legTo(aId);
    if (!legA || !legB || legA.cid !== legB.cid) {
      throw new Error(`no common live leg between ${aId} and ${bId}`);
    }
    a.leg(legA.cid, { type: 'iceStateChanged', cid: legA.cid, ice: 'connected' });
    b.leg(legB.cid, { type: 'iceStateChanged', cid: legB.cid, ice: 'connected' });
    this.flush();
  }
}

function mintCids(world: World, dev: Dev): Record<string, string> {
  const cids: Record<string, string> = {};
  for (const member of dev.session?.roster ?? []) {
    if (member !== dev.id) cids[member] = world.mint();
  }
  return cids;
}

function startCall(world: World, roster: string[]): void {
  // Every rostered device exists up front — `deliver` treats an unknown
  // device as a silent network drop, which is a semantics the vanish
  // scenario wants and a fixture accident everywhere else.
  for (const member of roster) world.dev(member);
  const starter = world.dev(roster[0]!);
  const cids: Record<string, string> = {};
  for (const member of roster) if (member !== starter.id) cids[member] = world.mint();
  starter.input({
    type: 'start',
    reportId: '01ARZ3NDEKTSV4RRFFQ69G5FAR',
    sid: SID,
    selfId: starter.id,
    roster,
    video: false,
    cids,
  });
  world.flush();
}

function answer(world: World, id: string): void {
  const dev = world.dev(id);
  dev.input({ type: 'localAnswer', cids: mintCids(world, dev) });
  world.flush();
}

/** The standard fixture: a fully connected 3-way audio call, S the starter. */
function threeWay(): World {
  const world = new World();
  startCall(world, [S, A, B]);
  answer(world, A);
  answer(world, B);
  world.connect(S, A);
  world.connect(S, B);
  world.connect(B, A);
  return world;
}

/* ========================================================================== *
 *  CALIBRATION — the harness must reproduce known 1:1 behaviour before any   *
 *  group scenario counts (§14: the instrument is checked before it           *
 *  measures).                                                                *
 * ========================================================================== */
describe('calibration: the harness reproduces known 1:1 behaviour through real callReducers', () => {
  it('a connected leg survives an ICE drop via the restart round trip, owned by the out side', () => {
    const world = new World();
    startCall(world, [S, A]);
    answer(world, A);
    world.connect(S, A);
    const sLeg = world.dev(S).legTo(A)!;
    expect(sLeg.box.state.name).toBe('connected');

    // The out side (S dialled) loses ICE: reconnecting + call.restart out.
    world.dev(S).leg(sLeg.cid, { type: 'iceStateChanged', cid: sLeg.cid, ice: 'disconnected' });
    expect(world.dev(S).session?.legs[A]?.phase).toBe('reconnecting');
    world.flush(); // A answers the restart; S applies the answer
    world.dev(S).leg(sLeg.cid, { type: 'iceStateChanged', cid: sLeg.cid, ice: 'connected' });
    world.flush();
    expect(world.dev(S).legTo(A)?.box.state.name).toBe('connected');
    expect(world.dev(S).session?.legs[A]?.phase).toBe('connected');
    // The CXCall connected ONCE; recovery is not a second connect (§4.3).
    expect(world.dev(S).counts.connected).toBe(1);
  });

  it("a stranger's ginvite into a live session meets busy and changes nothing", () => {
    const world = new World();
    startCall(world, [S, A]);
    answer(world, A);
    world.connect(S, A);
    const before = world.dev(S).session;
    world.queue.push({
      lane: 'group',
      from: STRANGER,
      to: S,
      env: {
        tcm: 'call.ginvite',
        sid: SID_HIGHER,
        cid: world.mint(),
        r: [STRANGER, S],
        sdp: SDP,
        vid: false,
        exp: NOW + 60_000,
      },
    });
    world.flush();
    expect(world.dev(S).session).toEqual(before);
    // The refusal left as call.end{busy} — queued toward the stranger, whose
    // absent device is exactly the point.
    expect(world.dev(S).counts.released).toBe(0);
  });

  it('a call.end for a cid nobody owns is dropped on the floor', () => {
    const world = threeWay();
    world.queue.push({
      lane: 'leg',
      from: STRANGER,
      to: A,
      env: { tcm: 'call.end', cid: world.mint(), r: 'hangup' },
    });
    world.flush();
    expect(world.dev(A).session?.phase).toBe('live');
    expect(world.dev(A).counts.released).toBe(0);
  });
});

/* ========================================================================== *
 *  THE 3-WAY FULL JOIN — convergence, R1's directions across devices, and    *
 *  §4.3's aggregate counted on every device.                                 *
 * ========================================================================== */
describe('3-way full join', () => {
  it('all three devices converge on one sid with N(N−1)/2 connected legs and R1 directions', () => {
    const world = threeWay();
    for (const id of [S, A, B]) {
      expect(world.dev(id).session?.sid).toBe(SID);
      expect(world.dev(id).session?.phase).toBe('live');
    }
    // Exactly one 'out' side per pair, on the R1-designated offerer.
    const pairs: Array<[string, string]> = [
      [S, A],
      [S, B],
      [B, A],
    ];
    for (const [x, y] of pairs) {
      const dx = world.dev(x).session!.legs[y]!;
      const dy = world.dev(y).session!.legs[x]!;
      expect(dx.phase).toBe('connected');
      expect(dy.phase).toBe('connected');
      expect([dx.direction, dy.direction].sort()).toEqual(['in', 'out']);
    }
    // The starter offered on its legs; B (later index) offered to A.
    expect(world.dev(S).session?.legs[A]?.direction).toBe('out');
    expect(world.dev(S).session?.legs[B]?.direction).toBe('out');
    expect(world.dev(B).session?.legs[A]?.direction).toBe('out');
    expect(world.dev(A).session?.legs[B]?.direction).toBe('in');
    // §4.3 on every device: ONE report, ZERO releases so far — and the
    // CONNECT report is the starter's alone: it is
    // `reportOutgoingCall(with:connectedAt:)`, and an incoming session's
    // CXCall was connected by its answer (the callee counts here were 1
    // and were rewritten deliberately).
    expect(world.dev(S).counts).toEqual({ incoming: 0, outgoing: 1, connected: 1, released: 0 });
    expect(world.dev(A).counts).toEqual({ incoming: 1, outgoing: 0, connected: 0, released: 0 });
    expect(world.dev(B).counts).toEqual({ incoming: 1, outgoing: 0, connected: 0, released: 0 });
    // The aggregate's own connect latch is what the callees keep.
    expect(world.dev(A).session?.connectedAt).not.toBeNull();
    expect(world.dev(B).session?.connectedAt).not.toBeNull();
  });

  it('the ring ack reaches the starter tile: legs show "ringing" before anyone answers', () => {
    const world = new World();
    startCall(world, [S, A, B]);
    expect(world.dev(S).session?.legs[A]?.phase).toBe('ringing');
    expect(world.dev(S).session?.legs[B]?.phase).toBe('ringing');
  });

  it('R8 end-to-end: the starter hangs up and every device releases exactly once', () => {
    const world = threeWay();
    world.dev(S).input({ type: 'localHangup' });
    world.flush();
    for (const id of [S, A, B]) {
      expect(world.dev(id).session).toBeNull();
      expect(world.dev(id).counts.released).toBe(1);
      expect(world.dev(id).released).toEqual(['hangup']);
    }
  });
});

/* ========================================================================== *
 *  LATE JOIN, WITH THE §3.6 CROSS-PAIR RACE — the canonical R6 falsifier     *
 *  proven: deliver the joiner's ginvite before the authority gjoin, and      *
 *  without re-offers the leg NEVER forms.                                    *
 *                                                                            *
 *  Mutation run: GINVITE_REOFFER_DELAYS_MS = [] (retries 0 at leg birth) —   *
 *  this test failed with C↔A permanently unformed while every other leg      *
 *  lived. The race would be a shipping defect, not a curiosity.              *
 * ========================================================================== */
describe('late join and the cross-pair race', () => {
  it('an unraced late join forms every leg: the joiner offers to every non-starter incumbent', () => {
    const world = threeWay();
    world.dev(C); // C's device exists before the starter dials it
    world.dev(S).input({ type: 'addParticipant', peerId: C, cid: world.mint() });
    world.flush();
    answer(world, C);
    world.connect(S, C);
    world.connect(C, A);
    world.connect(C, B);
    for (const id of [S, A, B]) {
      expect(world.dev(id).session?.roster).toEqual([S, A, B, C]);
      expect(world.dev(id).session?.legs[C]?.phase).toBe('connected');
    }
    // C was rung once, like anybody (§4.3); the connect report is the
    // starter's, and C's aggregate latched its own connect.
    expect(world.dev(C).counts).toEqual({ incoming: 1, outgoing: 0, connected: 0, released: 0 });
    expect(world.dev(C).session?.connectedAt).not.toBeNull();
    // C's legs: starter offered to C; C offers to both non-starter incumbents.
    expect(world.dev(C).session?.legs[S]?.direction).toBe('in');
    expect(world.dev(C).session?.legs[A]?.direction).toBe('out');
    expect(world.dev(C).session?.legs[B]?.direction).toBe('out');
  });

  it('the race: an incumbent that sees the joiner before the roster delta busies it; re-offers repair the leg', () => {
    const world = threeWay();
    world.dev(C);
    // Hold S's authority gjoin to A hostage — the two queues nothing orders.
    const holdGjoinToA = (f: Frame) =>
      f.lane === 'group' && f.env.tcm === 'call.gjoin' && f.to === A && f.from === S;
    world.dev(S).input({ type: 'addParticipant', peerId: C, cid: world.mint() });
    world.flush(holdGjoinToA);
    world.dev(C).input({ type: 'localAnswer', cids: mintCids(world, world.dev(C)) });
    world.flush(holdGjoinToA);

    // A, whose roster never named C, refused the leg: busy. C's leg died and
    // the +2 s repair is armed — the busy itself was the proof A is live.
    expect(world.dev(A).session?.roster).toEqual([S, A, B]);
    expect(world.dev(C).session?.legs[A]?.phase).toBe('failed');
    expect(world.dev(C).reoffers.has(A)).toBe(true);
    // Meanwhile B (delta delivered) already answered C's offer.
    world.connect(C, B);
    world.connect(S, C);

    // First re-offer at +2 s: STILL raced — the delta remains undelivered.
    world.advance(2_000);
    world.flush(holdGjoinToA);
    expect(world.dev(C).session?.legs[A]?.phase).toBe('failed');

    // The delta finally lands; the +6 s re-offer meets a roster that names C.
    world.releaseHeld();
    world.flush();
    expect(world.dev(A).session?.roster).toEqual([S, A, B, C]);
    world.advance(6_000);
    world.connect(C, A);
    expect(world.dev(C).session?.legs[A]?.phase).toBe('connected');
    expect(world.dev(A).session?.legs[C]?.phase).toBe('connected');
    // Still ONE CXCall per device throughout the repair.
    expect(world.dev(C).counts.incoming).toBe(1);
    expect(world.dev(A).counts.incoming).toBe(1);
    expect(world.dev(A).counts.released).toBe(0);
  });
});

/* ========================================================================== *
 *  DROP AND DEGRADE (R7) — the last-but-one departure leaves an ordinary     *
 *  1:1 leg under the SAME session: same sid, same CXCall, no release.        *
 * ========================================================================== */
describe('drop and degrade to 1:1', () => {
  it('a member leaves; the survivors keep one leg, one sid, and their CXCall', () => {
    const world = threeWay();
    world.dev(A).input({ type: 'localHangup' });
    world.flush();
    // A is gone and released its own call exactly once.
    expect(world.dev(A).session).toBeNull();
    expect(world.dev(A).counts.released).toBe(1);
    // S and B degrade to a live 1:1 leg under the same session — no release,
    // no re-report, the same sid.
    for (const id of [S, B]) {
      expect(world.dev(id).session?.sid).toBe(SID);
      expect(world.dev(id).counts.released).toBe(0);
      expect(world.dev(id).counts.incoming + world.dev(id).counts.outgoing).toBe(1);
    }
    expect(world.dev(S).session?.legs[B]?.phase).toBe('connected');
    expect(world.dev(B).session?.legs[S]?.phase).toBe('connected');

    // When the last peer leaves, the survivors release — once.
    world.dev(B).input({ type: 'localHangup' });
    world.flush();
    expect(world.dev(S).session).toBeNull();
    expect(world.dev(S).counts.released).toBe(1);
    expect(world.dev(B).counts.released).toBe(1);
  });
});

/* ========================================================================== *
 *  §5 — A SILENT STARTER VANISH IS NOT A STARTER-OUT: only an ANNOUNCED      *
 *  starter departure ends the session. Inferring death from silence would    *
 *  let one dropped frame end a healthy call. Asserted as DIFFERENT           *
 *  outcomes, per the failure-mode table.                                     *
 * ========================================================================== */
describe('silent starter vanish vs announced starter-out', () => {
  it('the starter crashing kills only its legs; the survivors keep talking, unable to grow', () => {
    const world = threeWay();
    // S goes silent. Its legs to A and B rot and time out — no frames flow.
    for (const id of [A, B]) {
      const leg = world.dev(id).legTo(S)!;
      world.dev(id).leg(leg.cid, { type: 'iceStateChanged', cid: leg.cid, ice: 'disconnected' });
      world.dev(id).leg(leg.cid, { type: 'reconnectTimeout' });
    }
    world.flush();
    // The session LIVES: A↔B still carries media, nobody released.
    for (const id of [A, B]) {
      expect(world.dev(id).session?.sid).toBe(SID);
      expect(world.dev(id).session?.legs[S]?.phase).toBe('failed');
      expect(world.dev(id).counts.released).toBe(0);
    }
    expect(world.dev(A).session?.legs[B]?.phase).toBe('connected');
    expect(world.dev(B).session?.legs[A]?.phase).toBe('connected');
    // Neither device re-offers toward S: those legs are the STARTER's to
    // offer (direction 'in' here), so R6 ownership leaves them dead.
    expect(world.dev(A).reoffers.size).toBe(0);
    expect(world.dev(B).reoffers.size).toBe(0);
  });

  it('the announced starter-out — same topology, opposite outcome — ends it for everyone', () => {
    const world = threeWay();
    world.dev(S).input({ type: 'localHangup' });
    world.flush();
    expect(world.dev(A).session).toBeNull();
    expect(world.dev(B).session).toBeNull();
  });
});

/* ========================================================================== *
 *  R3's EXPIRED HELD OFFER, REPAIRED BY R4+R6 — the canonical falsifier      *
 *  for the sovereign broadcast: a slow answer expires the held offer, the    *
 *  offerer's leg dies unanswered, and ONLY the answerer's "I am in" tells    *
 *  the offerer the pair is worth re-forming.                                 *
 *                                                                            *
 *  Mutation run: deleted the sendRosterDelta broadcast from answerSession —  *
 *  B never learns A announced, the revival gate stays closed, and this test  *
 *  fails with B↔A permanently unformed. R6 is untriggerable without R4,     *
 *  exactly as designed.                                                      *
 * ========================================================================== */
describe('a slow answer: the held offer expires, and the announce is what re-forms the pair', () => {
  it('B re-offers toward A only because A announced; the leg forms on the repair', () => {
    const world = new World();
    startCall(world, [S, A, B]);
    answer(world, B); // B answers first and offers to A, who is still ringing
    world.connect(S, B);
    expect(world.dev(A).session?.heldOffers[B]).toBeDefined();

    // A answers 100 s later — past OFFER_TTL (60 s) plus the 30 s skew
    // forgiveness. The held offer is dropped, not answered: answering a dead
    // offer would produce a leg the other side already gave up on.
    world.now += 100_000;
    answer(world, A);
    world.connect(S, A);
    expect(world.dev(A).session?.legs[B]).toBeUndefined();

    // B's unanswered offer times out. The peer is rostered AND announced
    // (A's sovereign gjoin) — so the repair arms.
    const bLeg = world.dev(B).legTo(A)!;
    world.dev(B).leg(bLeg.cid, { type: 'connectTimeout' });
    world.flush();
    expect(world.dev(B).reoffers.has(A)).toBe(true);
    world.advance(2_000);
    world.connect(B, A);
    expect(world.dev(B).session?.legs[A]?.phase).toBe('connected');
    expect(world.dev(A).session?.legs[B]?.phase).toBe('connected');
  });
});

/* ========================================================================== *
 *  A LEG FAILURE MID-SESSION (R6 end-to-end): one pair's ICE dies, the       *
 *  designated offerer re-offers with a fresh cid, and the mesh re-forms      *
 *  without any other pair noticing.                                          *
 * ========================================================================== */
describe('one flapping pair repairs itself without touching the rest of the mesh', () => {
  it('B↔A dies past the reconnect window; B (the offerer) re-offers; the leg re-forms', () => {
    const world = threeWay();
    const bLeg = world.dev(B).legTo(A)!;
    const aLeg = world.dev(A).legTo(B)!;
    const oldCid = bLeg.cid;
    // Both ends lose ICE and the 30 s window expires (failed_media).
    world.dev(B).leg(bLeg.cid, { type: 'iceStateChanged', cid: bLeg.cid, ice: 'disconnected' });
    world.dev(A).leg(aLeg.cid, { type: 'iceStateChanged', cid: aLeg.cid, ice: 'disconnected' });
    world.dev(B).leg(bLeg.cid, { type: 'reconnectTimeout' });
    world.dev(A).leg(aLeg.cid, { type: 'reconnectTimeout' });
    world.flush();
    // Only the offerer re-offers — one repair, not a glare of two.
    expect(world.dev(B).reoffers.has(A)).toBe(true);
    expect(world.dev(A).reoffers.size).toBe(0);
    world.advance(2_000);
    world.connect(B, A);
    const reformed = world.dev(B).session?.legs[A];
    expect(reformed?.phase).toBe('connected');
    expect(reformed?.cid).not.toBe(oldCid); // a FRESH cid — never a resurrected one
    // The untouched pairs never noticed, and nobody's CXCall moved.
    expect(world.dev(S).session?.legs[A]?.phase).toBe('connected');
    expect(world.dev(S).session?.legs[B]?.phase).toBe('connected');
    expect(world.dev(S).counts.connected).toBe(1); // the starter's ONE connect
    for (const id of [S, A, B]) {
      expect(world.dev(id).counts.released).toBe(0);
    }
  });
});

/* ========================================================================== *
 *  Composed scenarios for the behaviours the pure tests cannot show alone.  *
 *  Each went red against the modules that preceded them.                     *
 * ========================================================================== */
describe('a late-added member follows the roster from the epoch they joined at', () => {
  it('late join → a SECOND Add → the starter hangs up: every device applies every delta and releases', () => {
    // Before the epoch rode the ginvite, C seeded 0 while S was at 1: the Add
    // of D (se 2) was held forever on C, D's leg offer to C was refused busy
    // (D was not in C's roster), and S's starter-out (se 3) never ended C's
    // call. This test is that repro, composed.
    const D = '01BX5ZZKBKACTAV9WEVGEMMVS4';
    const world = threeWay();
    world.dev(C);
    world.dev(D);
    world.dev(S).input({ type: 'addParticipant', peerId: C, cid: world.mint() });
    world.flush();
    answer(world, C);
    world.connect(S, C);
    world.connect(C, A);
    world.connect(C, B);
    expect(world.dev(C).session?.se).toBe(1);

    world.dev(S).input({ type: 'addParticipant', peerId: D, cid: world.mint() });
    world.flush();
    // C, added at epoch 1, applies the epoch-2 Add instead of holding it.
    expect(world.dev(C).session?.held).toBeNull();
    expect(world.dev(C).session?.roster).toEqual([S, A, B, C, D]);
    answer(world, D);
    world.connect(S, D);
    world.connect(D, A);
    world.connect(D, B);
    world.connect(D, C); // D (index 4) offers to C (index 3); C admits a rostered joiner
    for (const id of [S, A, B, C]) {
      expect(world.dev(id).session?.roster).toEqual([S, A, B, C, D]);
      expect(world.dev(id).session?.legs[D]?.phase).toBe('connected');
    }
    expect(world.dev(D).session?.se).toBe(2);
    expect(world.dev(C).session?.se).toBe(2);

    // The starter hangs up: the authority starter-out at se 3 ends it for
    // EVERYONE, the late joiners included.
    world.dev(S).input({ type: 'localHangup' });
    world.flush();
    for (const id of [S, A, B, C, D]) {
      expect(world.dev(id).session).toBeNull();
      expect(world.dev(id).counts.released).toBe(1);
      expect(world.dev(id).released).toEqual(['hangup']);
    }
  });

  it("the starter's Remove of a member applies on a late-added member instead of being held", () => {
    // The reducer has no starter-side Remove input — the authority delta is
    // composed on the wire, and `applyAuthority`'s remove arm is its remote
    // half — so it is composed here exactly as the starter's device would
    // send it: `call.gleave{m: B}` at the next epoch, to every other member.
    // Before the epoch rode the ginvite, C (seeded 0 while S was at 1) held
    // it forever: B stayed on C's call after the starter removed them.
    const world = threeWay();
    world.dev(C);
    world.dev(S).input({ type: 'addParticipant', peerId: C, cid: world.mint() });
    world.flush();
    answer(world, C);
    world.connect(S, C);
    world.connect(C, A);
    world.connect(C, B);
    expect(world.dev(C).session?.se).toBe(1);
    expect(world.dev(C).session?.legs[B]?.phase).toBe('connected');

    const remove = { tcm: 'call.gleave' as const, sid: SID, m: B, se: 2 };
    for (const to of [A, B, C]) {
      world.queue.push({ lane: 'group', from: S, to, env: remove });
    }
    world.flush();

    // C applied the epoch-2 Remove instead of holding it: B's leg is closed
    // (folded to its departed phase once the teardown ran), nothing is held.
    expect(world.dev(C).session?.se).toBe(2);
    expect(world.dev(C).session?.held).toBeNull();
    expect(['left', 'gone']).toContain(world.dev(C).session?.legs[B]?.phase);
    expect(['left', 'gone']).toContain(world.dev(A).session?.legs[B]?.phase);
    // B, removed by the starter, released; the call goes on for the rest.
    expect(world.dev(B).session).toBeNull();
    expect(world.dev(B).counts.released).toBe(1);
    for (const id of [A, C]) expect(world.dev(id).session).not.toBeNull();
  });
});

describe('a joiner↔incumbent leg that fails before its first connect is repaired', () => {
  it("the joiner's connect timeout toward an incumbent who ANSWERED arms R6, and the re-offer forms the leg", () => {
    // A answered C's offer (call.answer landed on C's leg) but never sent C a
    // gjoin — incumbents announce once, at their own answer, before C
    // existed. ICE then fails to connect: the 45 s connect timeout ends the
    // leg `failed_ice`. Before this rule the leg was not `revivable` (A was
    // never `announced` on C) and stayed "Couldn't connect" for the call.
    const world = threeWay();
    world.dev(C);
    world.dev(S).input({ type: 'addParticipant', peerId: C, cid: world.mint() });
    world.flush();
    answer(world, C);
    world.connect(S, C);
    world.connect(C, B);
    const cLeg = world.dev(C).legTo(A)!;
    expect(cLeg.box.state.name).toBe('outgoing_connecting'); // answered, ICE in flight
    expect(world.dev(C).session?.announced).not.toContain(A);

    world.dev(C).leg(cLeg.cid, { type: 'connectTimeout' });
    world.flush();
    expect(world.dev(C).session?.legs[A]?.phase).toBe('failed');
    expect(world.dev(A).session?.legs[C]?.phase).toBe('failed');
    // THE REPAIR ARMS — on the offerer, and only there.
    expect(world.dev(C).reoffers.has(A)).toBe(true);
    expect(world.dev(A).reoffers.size).toBe(0);

    world.advance(2_000);
    world.connect(C, A);
    expect(world.dev(C).session?.legs[A]?.phase).toBe('connected');
    expect(world.dev(A).session?.legs[C]?.phase).toBe('connected');
    expect(world.dev(C).session?.legs[A]?.cid).not.toBe(cLeg.cid);
    // Still one CXCall each throughout.
    expect(world.dev(C).counts.incoming).toBe(1);
    expect(world.dev(A).counts.released).toBe(0);
  });
});
