import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { GroupCallInviteEnvelope } from '../src/call.js';
import {
  GINVITE_REOFFER_DELAYS_MS,
  groupLegOfferer,
  groupSessionReducer,
  type GroupSessionInput,
  type GroupSessionState,
  type SessionEffect,
} from '../src/call-session.js';

/**
 * The session layer, pure. The eleven rules of
 * the session contract are the spec AND this test list: every rule has a named test that goes
 * red when the rule is removed, and each block documents the mutation that
 * was actually run against it. The composed session×N-callReducer scenarios
 * live in call-session.matrix.test.ts; this file proves the reducer alone.
 */

// Distinct, lexicographically ordered ULIDs (Crockford base32, 26 chars).
const SID = '01ARZ3NDEKTSV4RRFFQ69G5FAA';
const SID_LOWER = '01ARZ3NDEKTSV4RRFFQ69G5F00'; // < SID: wins session glare
const SID_HIGHER = '01ARZ3NDEKTSV4RRFFQ69G5FZZ'; // > SID: loses session glare
const STARTER = '01BX5ZZKBKACTAV9WEVGEMMVS0';
const ANA = '01BX5ZZKBKACTAV9WEVGEMMVS1';
const ME = '01BX5ZZKBKACTAV9WEVGEMMVS2';
const BEN = '01BX5ZZKBKACTAV9WEVGEMMVS3';
const CARA = '01BX5ZZKBKACTAV9WEVGEMMVS4';
const DEE = '01BX5ZZKBKACTAV9WEVGEMMVS5';
const EVE = '01BX5ZZKBKACTAV9WEVGEMMVS6';
const STRANGER = '01BX5ZZKBKACTAV9WEVGEMMVSZ';

const CID_RING = '01ARZ3NDEKTSV4RRFFQ69G5FA1'; // the starter's ginvite / ring leg
const CID_HELD = '01ARZ3NDEKTSV4RRFFQ69G5FA2'; // BEN's held join_leg offer
const CID_ANA = '01ARZ3NDEKTSV4RRFFQ69G5FA3'; // our dial to ANA at answer
const CID_A = '01ARZ3NDEKTSV4RRFFQ69G5FA4'; // starter-side dial to ANA
const CID_B = '01ARZ3NDEKTSV4RRFFQ69G5FA5'; // starter-side dial to BEN
const CID_B2 = '01ARZ3NDEKTSV4RRFFQ69G5FA6'; // re-offer cids
const CID_B3 = '01ARZ3NDEKTSV4RRFFQ69G5FA7';
const CID_GLARE = '01ARZ3NDEKTSV4RRFFQ69G5FA8';
const CID_CARA = '01ARZ3NDEKTSV4RRFFQ69G5FA9';
const REPORT = '01ARZ3NDEKTSV4RRFFQ69G5FAR';

const SDP = 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\na=fingerprint:sha-256 AA:BB\r\n';
const NOW = 1_700_000_000_000;
const ROSTER4 = [STARTER, ANA, ME, BEN];

const invite = (over: Partial<GroupCallInviteEnvelope> = {}): GroupCallInviteEnvelope => ({
  tcm: 'call.ginvite',
  sid: SID,
  cid: CID_RING,
  r: ROSTER4,
  sdp: SDP,
  vid: true,
  exp: NOW + 60_000,
  ...over,
});

const rcv = (state: GroupSessionState | null, input: GroupSessionInput, now = NOW) =>
  groupSessionReducer(state, input, now);

const ofType = <T extends SessionEffect['type']>(
  effects: SessionEffect[],
  type: T,
): Extract<SessionEffect, { type: T }>[] =>
  effects.filter((e): e is Extract<SessionEffect, { type: T }> => e.type === type);

/** Incoming ring: the starter's ginvite accepted and ringing. */
function ringing() {
  return rcv(null, {
    type: 'ginviteReceived',
    from: STARTER,
    selfId: ME,
    invite: invite(),
    serverTs: NOW,
  });
}

/** Ringing, plus BEN's join_leg offer held (R2). BEN's envelope asserts a
 * FORGED roster — held admission must read only the starter's. */
function held() {
  const ring = ringing();
  return rcv(ring.state, {
    type: 'ginviteReceived',
    from: BEN,
    selfId: ME,
    invite: invite({ cid: CID_HELD, r: [STRANGER, BEN, ME] }),
    serverTs: NOW,
  });
}

/** The session answered (R3): starter + held legs answered, ANA dialled. */
function answered() {
  return rcv(held().state, { type: 'localAnswer', cids: { [ANA]: CID_ANA } });
}

/** Starter-side session: we started an audio 3-way with ANA and BEN. */
function started() {
  return rcv(null, {
    type: 'start',
    sid: SID,
    selfId: STARTER,
    roster: [STARTER, ANA, BEN],
    video: false,
    reportId: REPORT,
    cids: { [ANA]: CID_A, [BEN]: CID_B },
  });
}

describe('authoritative group metric lifecycle', () => {
  it('latches the first answer before ICE, preserves it across repeats, then finalizes failed ICE', () => {
    let step = rcv(null, {
      type: 'start', sid: SID, selfId: STARTER, roster: [STARTER, ANA],
      video: false, reportId: REPORT, cids: { [ANA]: CID_A },
    });
    step = rcv(step.state, {
      type: 'legStateChanged', peerId: ANA, cid: CID_A, name: 'outgoing_connecting', answeredAt: NOW + 1,
    }, NOW + 2);
    expect(step.state?.answeredAt).toBe(NOW + 1);
    expect(step.effects).toEqual([
      { type: 'answerGroupCallMetric', localId: SID, answeredAt: NOW + 1 },
    ]);
    step = rcv(step.state, {
      type: 'legStateChanged', peerId: ANA, cid: CID_A, name: 'outgoing_connecting', answeredAt: NOW + 9,
    }, NOW + 10);
    expect(step.state?.answeredAt).toBe(NOW + 1);
    expect(ofType(step.effects, 'answerGroupCallMetric')).toEqual([]);
    step = rcv(step.state, {
      type: 'legStateChanged', peerId: ANA, cid: CID_A, name: 'ending', reason: 'failed_ice',
    }, NOW + 11);
    expect(ofType(step.effects, 'finalizeGroupCallMetric')).toEqual([
      { type: 'finalizeGroupCallMetric', localId: SID, reason: 'failed_ice', endedAt: NOW + 11 },
    ]);
  });

  it('opens, latches answer/connect/peak, and finalizes only for the starter', () => {
    let step = rcv(null, {
      type: 'start', sid: SID, selfId: STARTER, roster: [STARTER, ANA, BEN],
      video: false, reportId: REPORT, cids: { [ANA]: CID_A, [BEN]: CID_B },
    });
    expect(ofType(step.effects, 'openGroupCallMetric')).toEqual([
      { type: 'openGroupCallMetric', reportId: REPORT, localId: SID, media: 'audio', startedAt: NOW },
    ]);
    step = rcv(step.state, {
      type: 'legStateChanged', peerId: ANA, cid: CID_A, name: 'connected', answeredAt: NOW + 1,
    }, NOW + 2);
    expect(ofType(step.effects, 'answerGroupCallMetric')).toEqual([
      { type: 'answerGroupCallMetric', localId: SID, answeredAt: NOW + 1 },
    ]);
    expect(ofType(step.effects, 'connectGroupCallMetric')).toEqual([
      { type: 'connectGroupCallMetric', localId: SID, connectedAt: NOW + 2 },
    ]);
    expect(ofType(step.effects, 'peakGroupCallMetric')).toEqual([
      { type: 'peakGroupCallMetric', localId: SID, participants: 2 },
    ]);
    step = rcv(step.state, { type: 'legStateChanged', peerId: BEN, cid: CID_B, name: 'connected' }, NOW + 3);
    expect(ofType(step.effects, 'peakGroupCallMetric')).toEqual([
      { type: 'peakGroupCallMetric', localId: SID, participants: 3 },
    ]);
    step = rcv(step.state, { type: 'localHangup' }, NOW + 4);
    expect(ofType(step.effects, 'finalizeGroupCallMetric')).toEqual([
      { type: 'finalizeGroupCallMetric', localId: SID, reason: 'hangup', endedAt: NOW + 4 },
    ]);
  });

  it('gives inbound/member sessions no metric authority', () => {
    const inbound = ringing();
    expect(inbound.state?.reportId).toBeNull();
    expect(inbound.effects.filter(effect => effect.type.endsWith('GroupCallMetric'))).toEqual([]);
  });

  it('discards authoritative glare before its release teardown', () => {
    const step = rcv(started().state, {
      type: 'ginviteReceived',
      from: CARA,
      selfId: STARTER,
      invite: invite({ sid: SID_LOWER, cid: CID_GLARE, r: [CARA, STARTER] }),
      serverTs: NOW,
    });
    expect(ofType(step.effects, 'discardGroupCallMetric')).toEqual([
      { type: 'discardGroupCallMetric', localId: SID },
    ]);
    expect(step.effects.findIndex(effect => effect.type === 'discardGroupCallMetric')).toBeLessThan(
      step.effects.findIndex(effect => effect.type === 'releaseGroupCall'),
    );
  });
});

/* ========================================================================== *
 *  R1 — WHO OFFERS. The starter offers on every starter↔member leg; among    *
 *  other pairs the LATER roster index offers to the EARLIER. Every leg gets  *
 *  exactly one 'out' side, because ICE-restart and re-offer ownership key    *
 *  on direction === 'out'.                                                   *
 *                                                                            *
 *  Mutations run: (a) delete the starter override in groupLegOfferer — the   *
 *  starter-pair assertion fails; (b) flip the index comparison > to < — the  *
 *  later-offers-to-earlier assertion fails; (c) return `a` unconditionally   *
 *  — the argument-symmetry assertion fails. All three went red.              *
 * ========================================================================== */
describe('R1 — who offers: starter on starter legs, later index to earlier, exactly one out side per pair', () => {
  it('property: over many rosters, no pair ever both-offers or neither-offers', () => {
    const pool = [STARTER, ANA, ME, BEN, CARA, DEE];
    let seed = 0xdecaf;
    const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
    for (let run = 0; run < 1_000; run++) {
      const shuffled = [...pool].sort(() => rnd() - 0.5);
      const roster = shuffled.slice(0, 2 + Math.floor(rnd() * 5));
      const starterId = roster[0]!;
      for (let i = 0; i < roster.length; i++) {
        for (let j = i + 1; j < roster.length; j++) {
          const a = roster[i]!;
          const b = roster[j]!;
          const offerer = groupLegOfferer(roster, starterId, a, b);
          // Exactly one offerer, identical from both ends of the pair: this
          // is what "no pair both-offers or neither-offers" means, because
          // each end derives its own direction from this function.
          expect(offerer === a || offerer === b).toBe(true);
          expect(groupLegOfferer(roster, starterId, b, a)).toBe(offerer);
          if (a === starterId || b === starterId) {
            expect(offerer).toBe(starterId);
          } else {
            expect(offerer).toBe(roster[j]); // later index offers to earlier
          }
        }
      }
    }
  });

  it('the reducer agrees with the function: starter dials out on every leg', () => {
    const { state } = started();
    expect(state?.legs[ANA]?.direction).toBe('out');
    expect(state?.legs[BEN]?.direction).toBe('out');
  });

  it('a member holds in-legs from the starter and every later index, and out-legs to earlier non-starters', () => {
    const { state } = answered();
    // ME is index 2 of [STARTER, ANA, ME, BEN].
    expect(state?.legs[STARTER]?.direction).toBe('in'); // starter offered
    expect(state?.legs[BEN]?.direction).toBe('in'); // BEN (index 3) offered to us
    expect(state?.legs[ANA]?.direction).toBe('out'); // we (2) offer to ANA (1)
    for (const leg of Object.values(state!.legs)) {
      const expected = groupLegOfferer(ROSTER4, STARTER, ME, leg.peerId);
      expect(leg.direction).toBe(expected === ME ? 'out' : 'in');
    }
  });
});

/* ========================================================================== *
 *  R2 — RING EXACTLY ONCE PER SESSION. The first ringable accepted ginvite   *
 *  rings; every further same-sid invite while ringing is admitted but HELD   *
 *  — never a second ring, and critically never an answer before the human   *
 *  answers: `createAnswer` starts the camera, so answering a held leg        *
 *  pre-accept is the pre-answer-camera bug class the 1:1 restart guard       *
 *  closed.                                                                   *
 *                                                                            *
 *  Mutation run: made the join_leg-while-ringing branch answer immediately   *
 *  (emit openLegAnswer instead of holding) — six tests went red: the "no     *
 *  answer effect of any kind" assertions here, both ring-collapse tests      *
 *  (a prematurely-answered leg survives the ring dying), and the matrix's    *
 *  expired-held scenario (a dead offer got answered).                        *
 * ========================================================================== */
describe('R2 — ring once; held offers are never rung and never answered before the human answers', () => {
  it('the first ringable invite rings exactly once, and only after the row is written', () => {
    const { state, effects } = ringing();
    const reports = ofType(effects, 'reportGroupIncoming');
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ sid: SID, starterId: STARTER, hasVideo: true });
    // Persist-before-ring (§4.3): no window where the system shows a call
    // the app cannot answer.
    expect(effects.findIndex(e => e.type === 'writeSessionRow')).toBeLessThan(
      effects.findIndex(e => e.type === 'reportGroupIncoming'),
    );
    expect(state?.phase).toBe('ringing');
    expect(state?.callKit).toBe('reported');
  });

  it('a second same-sid invite while ringing is admitted but HELD: no ring, no answer, no dial', () => {
    const step = held();
    expect(step.effects).toEqual([]); // nothing — not a ring, not an answer
    expect(step.state?.heldOffers[BEN]?.invite.cid).toBe(CID_HELD);
    // The forged roster in BEN's envelope bought nothing: the roster held
    // from the starter is untouched.
    expect(step.state?.roster).toEqual(ROSTER4);
  });

  it('no answer effect of ANY kind exists before localAnswer, and the held leg is answered only after it', () => {
    const preAnswer = [...ringing().effects, ...held().effects];
    expect(ofType(preAnswer, 'openLegAnswer')).toHaveLength(0);
    expect(ofType(preAnswer, 'openLegDial')).toHaveLength(0);
    const post = answered();
    const answers = ofType(post.effects, 'openLegAnswer').map(e => e.cid);
    expect(answers).toContain(CID_RING);
    expect(answers).toContain(CID_HELD);
  });

  it('a redelivered copy of the ringing invite changes nothing (§5.6)', () => {
    const ring = ringing();
    const again = rcv(ring.state, {
      type: 'ginviteReceived',
      from: STARTER,
      selfId: ME,
      invite: invite(),
      serverTs: NOW,
    });
    expect(again.effects).toEqual([]);
    expect(again.state).toEqual(ring.state);
  });

  it('an invite past its life never rings — no session, no effects', () => {
    const step = rcv(null, {
      type: 'ginviteReceived',
      from: STARTER,
      selfId: ME,
      invite: invite({ exp: NOW - 120_000 }),
      serverTs: NOW - 120_000,
    });
    expect(step.state).toBeNull();
    expect(step.effects).toEqual([]);
  });
});

/* ========================================================================== *
 *  R3 — ANSWERING: answer the starter's leg and every live held offer,       *
 *  broadcast the sovereign self-announce, and offer to every lower-index     *
 *  non-starter member. An expired held offer is dropped — R6 repairs it      *
 *  from the offerer's side.                                                  *
 *                                                                            *
 *  Mutation run: deleted the sendRosterDelta broadcast — this block's        *
 *  broadcast assertions failed AND the matrix expired-held-offer scenario    *
 *  failed: the offerer never learns the slow answerer is in, so R6 never     *
 *  arms and the pair stays permanently unformed. (The late-join RACE         *
 *  survives on busy-evidence alone; the slow answer does not.)               *
 * ========================================================================== */
describe('R3 — answering: held offers drain, the sovereign announce goes out, lower indexes get our offer', () => {
  it('answers the starter first, then held offers, then announces, then dials — each leg through its own service', () => {
    const { state, effects } = answered();
    const types = effects.map(e => e.type);
    expect(types).toEqual([
      'openLegAnswer', // the starter's leg
      'openLegAnswer', // BEN's held leg
      'sendRosterDelta', // sovereign "I am in"
      'openLegDial', // our offer to ANA (index 1 < our 2, non-starter)
    ]);
    expect(state?.phase).toBe('joining');
    expect(state?.heldOffers).toEqual({});
    expect(state?.starterOffer).toBeNull();
  });

  it('the sovereign announce names SELF, floors the epoch at 1, is never urgent, and goes to the whole roster', () => {
    const delta = ofType(answered().effects, 'sendRosterDelta')[0]!;
    expect(delta.env).toEqual({ tcm: 'call.gjoin', sid: SID, m: ME, se: 1 });
    expect(delta.urgent).toBe(false);
    expect(delta.to).toEqual([STARTER, ANA, BEN]);
  });

  it('dials exactly the lower-index non-starter members, with executor-minted cids', () => {
    const dials = ofType(answered().effects, 'openLegDial');
    expect(dials).toEqual([{ type: 'openLegDial', peerId: ANA, cid: CID_ANA, kind: 'ginvite' }]);
  });

  it('a held offer whose exp has passed is dropped, not answered — the offerer re-offers (R6)', () => {
    const ring = ringing();
    const stale = rcv(ring.state, {
      type: 'ginviteReceived',
      from: BEN,
      selfId: ME,
      invite: invite({ cid: CID_HELD, exp: NOW + 1_000 }),
      serverTs: NOW,
    });
    // Answer two minutes later: the starter's own offer is answered by the
    // leg service holding it; the held one is past exp + skew and is dropped.
    const late = rcv(stale.state, { type: 'localAnswer', cids: { [ANA]: CID_ANA } }, NOW + 120_000);
    const answers = ofType(late.effects, 'openLegAnswer').map(e => e.cid);
    expect(answers).toContain(CID_RING);
    expect(answers).not.toContain(CID_HELD);
  });

  it('compose-strict: a missing executor cid for a required dial is loud, not a silently unformed leg', () => {
    expect(() => rcv(held().state, { type: 'localAnswer', cids: {} })).toThrow(/minted no cid/);
  });

  it('callKitAnswered is the same answer, but only for the sid it names', () => {
    const wrong = rcv(held().state, { type: 'callKitAnswered', sid: SID_HIGHER, cids: {} });
    expect(wrong.effects).toEqual([]);
    expect(wrong.state?.phase).toBe('ringing');
    const right = rcv(held().state, {
      type: 'callKitAnswered',
      sid: SID,
      cids: { [ANA]: CID_ANA },
    });
    expect(right.state?.phase).toBe('joining');
  });
});

/* ========================================================================== *
 *  R4 — THE SOVEREIGN SELF-ANNOUNCE IS LOAD-BEARING: it is what arms R6      *
 *  re-offers toward the announcer. And its admission is DELEGATED: a         *
 *  non-starter's delta naming anyone else changes NOTHING.                   *
 *                                                                            *
 *   ████ THE DELEGATION TEST. Remove the delegation to                       *
 *   ████ admitGroupCallRosterDelta — or re-derive `from !== starterId`      *
 *   ████ locally and get it subtly wrong — and a member's gjoin naming a    *
 *   ████ stranger would grow this session's roster: every phone in the      *
 *   ████ call admits, then DIALS, the stranger. A small-group call becomes  *
 *   ████ a distributed dialler. Mutation run: bypassed the verdict and      *
 *   ████ applied every gjoin — both assertions below failed loudly.         *
 * ========================================================================== */
describe("R4 — sovereign announces arm re-offers; a non-starter's delta changes NOTHING", () => {
  it("a member's gjoin naming a STRANGER leaves state AND effects byte-identical to nothing", () => {
    const live = answered();
    const step = rcv(live.state, {
      type: 'gjoinReceived',
      from: ANA,
      delta: { tcm: 'call.gjoin', sid: SID, m: STRANGER, se: 1 },
    });
    expect(step.effects).toEqual([]);
    expect(step.state).toEqual(live.state); // deep-equal: not one field moved
    expect(step.state?.roster).not.toContain(STRANGER);
  });

  it("a stranger's self-announce is equally nothing — the starter never named them", () => {
    const live = answered();
    const step = rcv(live.state, {
      type: 'gjoinReceived',
      from: STRANGER,
      delta: { tcm: 'call.gjoin', sid: SID, m: STRANGER, se: 1 },
    });
    expect(step.effects).toEqual([]);
    expect(step.state).toEqual(live.state);
  });

  it('a first announce from a peer whose designated-offer leg died re-arms R6 with a fresh budget', () => {
    // We started; BEN's leg failed before BEN ever announced (their hold on
    // our offer expired while they rang). failed_ice toward an unannounced
    // peer must NOT re-offer — that would re-ring someone who never answered.
    const start = started();
    const dead = rcv(start.state, {
      type: 'legStateChanged',
      peerId: BEN,
      cid: CID_B,
      name: 'ending',
      reason: 'failed_ice',
    });
    expect(ofType(dead.effects, 'startReofferTimer')).toHaveLength(0);
    // Then BEN announces "I am in": the pair should now form — immediately.
    const announced = rcv(dead.state, {
      type: 'gjoinReceived',
      from: BEN,
      delta: { tcm: 'call.gjoin', sid: SID, m: BEN, se: 1 },
    });
    expect(ofType(announced.effects, 'startReofferTimer')).toEqual([
      { type: 'startReofferTimer', peerId: BEN, ms: 0 },
    ]);
    expect(announced.state?.legs[BEN]?.reoffersLeft).toBe(GINVITE_REOFFER_DELAYS_MS.length);
    // A redelivered announce is not a second trigger.
    const again = rcv(announced.state, {
      type: 'gjoinReceived',
      from: BEN,
      delta: { tcm: 'call.gjoin', sid: SID, m: BEN, se: 1 },
    });
    expect(again.effects).toEqual([]);
  });
});

/* ========================================================================== *
 *  R5 — DECLINE: end the starter's leg AND every held leg, release, and      *
 *  never, ever send a gleave — declining is not leaving a call you never     *
 *  joined.                                                                   *
 *                                                                            *
 *  Mutation run: made decline broadcast a sovereign gleave — the             *
 *  "no roster delta" assertion failed.                                       *
 * ========================================================================== */
describe('R5 — decline kills every ringback at once and sends no gleave', () => {
  it('declining a held session ends the starter leg and the held leg, then releases once', () => {
    const step = rcv(held().state, { type: 'localDecline' });
    expect(step.state).toBeNull();
    const closes = ofType(step.effects, 'closeLeg');
    expect(closes).toHaveLength(2);
    expect(closes.map(c => c.cid).sort()).toEqual([CID_RING, CID_HELD].sort());
    for (const close of closes) {
      expect(close.reason).toBe('decline');
      expect(close.announce).toBe(true); // the refusal must reach both diallers
    }
    expect(ofType(step.effects, 'releaseGroupCall')).toEqual([
      { type: 'releaseGroupCall', sid: SID, reason: 'decline' },
    ]);
    expect(ofType(step.effects, 'closeSessionRow')).toHaveLength(1);
    // NEVER a gleave: the roster still names us and the starter may not
    // re-ring us; leaving is a thing only participants do.
    expect(ofType(step.effects, 'sendRosterDelta')).toHaveLength(0);
  });

  it('hangup and callKitEnded while ringing are the same decline', () => {
    for (const input of [
      { type: 'localHangup' } as const,
      { type: 'callKitEnded', sid: SID } as const,
    ]) {
      const step = rcv(held().state, input);
      expect(step.state).toBeNull();
      expect(ofType(step.effects, 'closeLeg').every(c => c.reason === 'decline')).toBe(true);
      expect(ofType(step.effects, 'sendRosterDelta')).toHaveLength(0);
    }
  });
});

/* ========================================================================== *
 *  R6 — A LEG THAT FAILS WHILE THE SESSION LIVES is re-offered by its        *
 *  designated offerer with a fresh cid at +2 s then +6 s, then stops.        *
 *  Failure-class reasons only; a decline or a ring-timeout is an answer      *
 *  from a person and is never retried.                                       *
 *                                                                            *
 *  Mutation run: set the retry budget to 0 at leg birth — this ladder test   *
 *  failed AND the matrix late-join race became a permanent hole.             *
 * ========================================================================== */
describe('R6 — bounded re-offers with fresh cids: +2 s, +6 s, then "Couldn\'t connect"', () => {
  function announcedStart() {
    return rcv(started().state, {
      type: 'gjoinReceived',
      from: BEN,
      delta: { tcm: 'call.gjoin', sid: SID, m: BEN, se: 1 },
    });
  }

  it('walks the delay ladder and stops when the budget is spent', () => {
    let step = rcv(announcedStart().state, {
      type: 'legStateChanged',
      peerId: BEN,
      cid: CID_B,
      name: 'ending',
      reason: 'failed_ice',
    });
    expect(ofType(step.effects, 'startReofferTimer')).toEqual([
      { type: 'startReofferTimer', peerId: BEN, ms: 2_000 },
    ]);
    step = rcv(step.state, { type: 'reofferTimer', peerId: BEN, cid: CID_B2 });
    expect(ofType(step.effects, 'openLegDial')).toEqual([
      { type: 'openLegDial', peerId: BEN, cid: CID_B2, kind: 'reoffer' },
    ]);
    expect(step.state?.legs[BEN]).toMatchObject({ cid: CID_B2, phase: 'inviting', reoffersLeft: 1 });

    step = rcv(step.state, {
      type: 'legStateChanged',
      peerId: BEN,
      cid: CID_B2,
      name: 'ending',
      reason: 'failed_ice',
    });
    expect(ofType(step.effects, 'startReofferTimer')).toEqual([
      { type: 'startReofferTimer', peerId: BEN, ms: 6_000 },
    ]);
    step = rcv(step.state, { type: 'reofferTimer', peerId: BEN, cid: CID_B3 });
    expect(step.state?.legs[BEN]?.reoffersLeft).toBe(0);

    // Third failure: the budget is spent. The tile shows "Couldn't connect".
    step = rcv(step.state, {
      type: 'legStateChanged',
      peerId: BEN,
      cid: CID_B3,
      name: 'ending',
      reason: 'failed_ice',
    });
    expect(ofType(step.effects, 'startReofferTimer')).toHaveLength(0);
    expect(step.state?.legs[BEN]?.phase).toBe('failed');
  });

  it('a busy refusal counts as presence (the §3.6 race) and arms the repair toward an unannounced peer', () => {
    const step = rcv(started().state, {
      type: 'legStateChanged',
      peerId: BEN,
      cid: CID_B,
      name: 'ending',
      reason: 'busy',
    });
    // Only a live device says busy — that IS the announcement the late-join
    // race swallowed. Without this, a joiner waits on announces the
    // incumbents broadcast before it existed.
    expect(ofType(step.effects, 'startReofferTimer')).toEqual([
      { type: 'startReofferTimer', peerId: BEN, ms: 2_000 },
    ]);
    expect(step.state?.announced).toContain(BEN);
  });

  it('a person\'s answer is never retried: decline and ring-timeout re-offer nothing', () => {
    for (const reason of ['decline', 'timeout'] as const) {
      const step = rcv(announcedStart().state, {
        type: 'legStateChanged',
        peerId: BEN,
        cid: CID_B,
        name: 'ending',
        reason,
      });
      expect(ofType(step.effects, 'startReofferTimer')).toHaveLength(0);
    }
  });

  it('a re-offer timer that outlived its world dials nobody', () => {
    // BEN's leg failed with a re-offer pending, then BEN sovereign-left.
    let step = rcv(announcedStart().state, {
      type: 'legStateChanged',
      peerId: BEN,
      cid: CID_B,
      name: 'ending',
      reason: 'failed_ice',
    });
    step = rcv(step.state, {
      type: 'gleaveReceived',
      from: BEN,
      delta: { tcm: 'call.gleave', sid: SID, m: BEN, se: 1 },
    });
    const fired = rcv(step.state, { type: 'reofferTimer', peerId: BEN, cid: CID_B2 });
    expect(fired.effects).toEqual([]);
  });
});

/* ========================================================================== *
 *  R7 — DROP AND DEGRADE: a leaver's legs close and the session continues;   *
 *  the last-but-one departure leaves an ordinary 1:1 leg under the SAME      *
 *  session — same sid, same CXCall, no release, no re-report.                *
 *                                                                            *
 *  Mutation run: made the sovereign-leave branch release unconditionally —   *
 *  the no-release assertion failed.                                          *
 * ========================================================================== */
describe('R7 — a departure closes their legs; the last-but-one degrades to a live 1:1 under the same sid', () => {
  function threeWayLive() {
    let step = started();
    step = rcv(step.state, { type: 'legStateChanged', peerId: ANA, cid: CID_A, name: 'connected' });
    const first = step;
    step = rcv(step.state, { type: 'legStateChanged', peerId: BEN, cid: CID_B, name: 'connected' });
    return { state: step.state, firstConnect: first };
  }

  it('a sovereign gleave closes only the leaver, without announcing (their ends are en route)', () => {
    const { state } = threeWayLive();
    const step = rcv(state, {
      type: 'gleaveReceived',
      from: ANA,
      delta: { tcm: 'call.gleave', sid: SID, m: ANA, se: 1 },
    });
    expect(ofType(step.effects, 'closeLeg')).toEqual([
      { type: 'closeLeg', peerId: ANA, cid: CID_A, reason: 'hangup', announce: false },
    ]);
    // The degrade: one leg left, same sid, the CXCall untouched.
    expect(ofType(step.effects, 'releaseGroupCall')).toHaveLength(0);
    expect(step.state?.sid).toBe(SID);
    expect(step.state?.callKit).toBe('connected');
    expect(step.state?.legs[BEN]?.phase).toBe('connected');
    // The roster does NOT shrink — it is the starter's assertion, and a
    // returning ANA is a join_leg, never a stranger.
    expect(step.state?.roster).toContain(ANA);
  });

  it('when the last remaining peer leaves, the session releases exactly once', () => {
    const { state } = threeWayLive();
    const one = rcv(state, {
      type: 'gleaveReceived',
      from: ANA,
      delta: { tcm: 'call.gleave', sid: SID, m: ANA, se: 1 },
    });
    const done = rcv(one.state, {
      type: 'gleaveReceived',
      from: BEN,
      delta: { tcm: 'call.gleave', sid: SID, m: BEN, se: 1 },
    });
    expect(done.state).toBeNull();
    expect(ofType(done.effects, 'releaseGroupCall')).toEqual([
      { type: 'releaseGroupCall', sid: SID, reason: 'hangup' },
    ]);
    expect(ofType(done.effects, 'closeSessionRow')).toHaveLength(1);
  });
});

/* ========================================================================== *
 *  R8 — THE STARTER LEAVES ⇒ THE SESSION ENDS FOR EVERYONE. Locally the      *
 *  hangup fans call.end to every live leg AND broadcasts the authority       *
 *  gleave; remotely, applying a starter-out delta tears everything down.     *
 *                                                                            *
 *   ████ THE MOST IMPORTANT FALSIFIER IN THIS PHASE. Remove the authority-   *
 *   ████ lane check — accept any gleave whose PAYLOAD names the starter —   *
 *   ████ and ANY member can end everyone's call: the distributed-hangup     *
 *   ████ twin of the distributed dialler. Mutation run: matched on         *
 *   ████ delta.m === starterId instead of the admitted verdict — the first  *
 *   ████ test below failed (the call died), exactly as it must.             *
 * ========================================================================== */
describe("R8 — starter-out ends the session for everyone; a member's forgery ends nothing", () => {
  it("a NON-STARTER's gleave naming the starter changes NOTHING — state and effects both", () => {
    const live = answered();
    const step = rcv(live.state, {
      type: 'gleaveReceived',
      from: ANA,
      delta: { tcm: 'call.gleave', sid: SID, m: STARTER, se: 1 },
    });
    expect(step.effects).toEqual([]);
    expect(step.state).toEqual(live.state); // the call did not so much as flinch
  });

  it('remote arm: the authority starter-out closes every leg unannounced and releases the CXCall', () => {
    const live = answered();
    const step = rcv(live.state, {
      type: 'gleaveReceived',
      from: STARTER,
      delta: { tcm: 'call.gleave', sid: SID, m: STARTER, se: 1 },
    });
    expect(step.state).toBeNull();
    const closes = ofType(step.effects, 'closeLeg');
    expect(closes.length).toBeGreaterThanOrEqual(3); // starter, BEN, ANA legs
    // The ends are coming from every device's own fan — echoing would ping-pong.
    expect(closes.every(c => c.announce === false)).toBe(true);
    expect(ofType(step.effects, 'releaseGroupCall')).toHaveLength(1);
  });

  it('local arm: the starter\'s hangup fans ends to every live leg and broadcasts the authority gleave at se+1', () => {
    const step = rcv(started().state, { type: 'localHangup' });
    expect(step.state).toBeNull();
    const closes = ofType(step.effects, 'closeLeg');
    expect(closes.map(c => c.peerId).sort()).toEqual([ANA, BEN].sort());
    expect(closes.every(c => c.announce === true && c.reason === 'hangup')).toBe(true);
    expect(ofType(step.effects, 'sendRosterDelta')).toEqual([
      {
        type: 'sendRosterDelta',
        to: [ANA, BEN],
        env: { tcm: 'call.gleave', sid: SID, m: STARTER, se: 1 },
        urgent: false,
      },
    ]);
    expect(ofType(step.effects, 'releaseGroupCall')).toHaveLength(1);
  });

  it('a non-starter hangup is a sovereign leave naming only itself', () => {
    const step = rcv(answered().state, { type: 'localHangup' });
    expect(step.state).toBeNull();
    const delta = ofType(step.effects, 'sendRosterDelta')[0]!;
    expect(delta.env).toEqual({ tcm: 'call.gleave', sid: SID, m: ME, se: 1 });
  });

  it('the starter removing US ends our session; removing another closes one leg and the call continues', () => {
    const live = answered();
    const ejected = rcv(live.state, {
      type: 'gleaveReceived',
      from: STARTER,
      delta: { tcm: 'call.gleave', sid: SID, m: ME, se: 1 },
    });
    expect(ejected.state).toBeNull();
    const other = rcv(live.state, {
      type: 'gleaveReceived',
      from: STARTER,
      delta: { tcm: 'call.gleave', sid: SID, m: ANA, se: 1 },
    });
    expect(other.state).not.toBeNull();
    expect(other.state?.roster).not.toContain(ANA);
    expect(ofType(other.effects, 'releaseGroupCall')).toHaveLength(0);
  });
});

/* ========================================================================== *
 *  R9 — SESSION GLARE: lower sid wins; the loser abandons EVERY leg with     *
 *  glare_lost and releases its CXCall BEFORE processing the winner as a      *
 *  fresh ring. The ordering IS delegated: this module never compares sids.   *
 *                                                                            *
 *  Mutation run (§4.6): flipped the comparison in admitGroupCallInvite       *
 *  (`<` → `>`) as a scratch mutation and ran this property — it failed on    *
 *  the first pair: both ends converged on the HIGHER sid, which the oracle   *
 *  (lower wins — the rule every shipped device already evaluates) rejects.   *
 *  call.ts was then restored and PROVEN byte-identical (cmp + git status).   *
 * ========================================================================== */
describe('R9 — session glare: the loser abandons every leg, releases, then rings the winner fresh', () => {
  it('supersede closes legs, held offers and the ring itself with glare_lost, in loser-first order', () => {
    const step = rcv(held().state, {
      type: 'ginviteReceived',
      from: CARA,
      selfId: ME,
      invite: invite({ sid: SID_LOWER, cid: CID_GLARE, r: [CARA, ME] }),
      serverTs: NOW,
    });
    const closes = ofType(step.effects, 'closeLeg');
    expect(closes.map(c => c.cid).sort()).toEqual([CID_RING, CID_HELD].sort());
    expect(closes.every(c => c.reason === 'glare_lost' && c.announce === true)).toBe(true);
    expect(ofType(step.effects, 'releaseGroupCall')).toEqual([
      { type: 'releaseGroupCall', sid: SID, reason: 'glare_lost' },
    ]);
    // The loser is gone BEFORE the winner rings.
    const releaseAt = step.effects.findIndex(e => e.type === 'releaseGroupCall');
    const reportAt = step.effects.findIndex(e => e.type === 'reportGroupIncoming');
    expect(releaseAt).toBeLessThan(reportAt);
    for (const close of closes) {
      expect(step.effects.indexOf(close)).toBeLessThan(releaseAt);
    }
    // AND THE ROW THAT IS DELETED IS THE LOSER'S. This step returns the
    // WINNER as its state, so an executor that read `state.sid` here would
    // delete the winner's row and leave the loser's behind — a persisted
    // roster outliving the call it belonged to. The effect names its own
    // session so that cannot be misread.
    expect(ofType(step.effects, 'closeSessionRow')).toEqual([
      { type: 'closeSessionRow', sid: SID },
    ]);
    expect(step.state).toMatchObject({ sid: SID_LOWER, starterId: CARA, phase: 'ringing' });
  });

  it('busy: a higher-sid invite gets call.end{busy} on its cid and the live session is untouched', () => {
    const live = answered();
    const step = rcv(live.state, {
      type: 'ginviteReceived',
      from: CARA,
      selfId: ME,
      invite: invite({ sid: SID_HIGHER, cid: CID_GLARE, r: [CARA, ME] }),
      serverTs: NOW,
    });
    expect(step.effects).toEqual([
      { type: 'closeLeg', peerId: CARA, cid: CID_GLARE, reason: 'busy', announce: true },
    ]);
    expect(step.state).toEqual(live.state);
  });

  it('a stale losing frame supersedes nothing — one expired queue entry must not kill a live call', () => {
    const live = answered();
    const step = rcv(live.state, {
      type: 'ginviteReceived',
      from: CARA,
      selfId: ME,
      invite: invite({ sid: SID_LOWER, cid: CID_GLARE, r: [CARA, ME], exp: NOW - 120_000 }),
      serverTs: NOW - 120_000,
    });
    // The live call is untouched — but the stale winner's own VoIP push rang
    // a placeholder on the way in, and this refusal sends no frame that could
    // clear it. The dismissal is the ONE thing this path emits.
    expect(step.effects).toEqual([{ type: 'dismissRing', peerId: CARA }]);
    expect(step.state).toEqual(live.state);
  });

  it('PROPERTY: 10 000 simultaneous-start pairs converge on the same surviving sid at both ends', () => {
    const CROCK = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    let seed = 0xc0ffee;
    const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
    const randUlid = () =>
      Array.from({ length: 26 }, () => CROCK[Math.floor(rnd() * 32)]).join('');

    for (let i = 0; i < 10_000; i++) {
      const sidX = randUlid();
      const sidY = randUlid();
      if (sidX === sidY) continue; // 1 in 32^26 — not this decade
      const winner = sidX < sidY ? sidX : sidY; // the ORACLE compares; the module may not
      const cidX = randUlid();
      const cidY = randUlid();

      // X started sidX at ME∪BEN's expense... each end started its own
      // session with the other in the roster, and the invites crossed.
      const x = rcv(null, {
        type: 'start', sid: sidX, selfId: ME, roster: [ME, BEN], video: false, reportId: REPORT,
        cids: { [BEN]: cidX },
      });
      const y = rcv(null, {
        type: 'start', sid: sidY, selfId: BEN, roster: [BEN, ME], video: false, reportId: REPORT,
        cids: { [ME]: cidY },
      });
      const xStep = rcv(x.state, {
        type: 'ginviteReceived', from: BEN, selfId: ME,
        invite: invite({ sid: sidY, cid: cidY, r: [BEN, ME], vid: false }),
        serverTs: NOW,
      });
      const yStep = rcv(y.state, {
        type: 'ginviteReceived', from: ME, selfId: BEN,
        invite: invite({ sid: sidX, cid: cidX, r: [ME, BEN], vid: false }),
        serverTs: NOW,
      });

      // Both ends hold the winner, with no coordination.
      expect(xStep.state?.sid).toBe(winner);
      expect(yStep.state?.sid).toBe(winner);

      // The cid the WINNER refuses is the one on the invite it received —
      // the loser's dial toward it.
      const [loser, loserSid, loserInviteCid] =
        winner === sidX ? [yStep, sidY, cidY] : [xStep, sidX, cidX];
      const winnerStep = winner === sidX ? xStep : yStep;
      // The loser abandoned EVERY leg with glare_lost and released exactly once.
      const closes = ofType(loser.effects, 'closeLeg');
      expect(closes.some(c => c.reason === 'glare_lost')).toBe(true);
      expect(closes.every(c => c.reason === 'glare_lost')).toBe(true);
      expect(ofType(loser.effects, 'releaseGroupCall')).toEqual([
        { type: 'releaseGroupCall', sid: loserSid, reason: 'glare_lost' },
      ]);
      expect(ofType(loser.effects, 'reportGroupIncoming')[0]?.sid).toBe(winner);
      // The winner refused the loser's invite through the busy path and kept
      // its own session whole.
      expect(ofType(winnerStep.effects, 'closeLeg')).toEqual([
        {
          type: 'closeLeg',
          peerId: winner === sidX ? BEN : ME,
          cid: loserInviteCid,
          reason: 'busy',
          announce: true,
        },
      ]);
    }
  });
});

/* ========================================================================== *
 *  R10 — EPOCHS: authority deltas apply at exactly se+1; se+2 is HELD in     *
 *  one slot and re-applies when the gap fills; sovereign announces are       *
 *  never epoch-gated. All verdicts from admitGroupCallRosterDelta —          *
 *  executed, never re-decided.                                               *
 * ========================================================================== */
describe('R10 — epochs: hold-never-drop, one slot, drained through the same admission', () => {
  /** An AUDIO session (cap 6): the epoch tests grow a roster of four to six,
   * which the video cap of five would rightly refuse — the first draft of
   * this test proved the delegation by tripping over it. */
  function answeredAudio() {
    const ring = rcv(null, {
      type: 'ginviteReceived',
      from: STARTER,
      selfId: ME,
      invite: invite({ vid: false }),
      serverTs: NOW,
    });
    return rcv(ring.state, { type: 'localAnswer', cids: { [ANA]: CID_ANA } });
  }

  it('an se+2 delta is held without touching the roster, and re-applies when se+1 lands', () => {
    const live = answeredAudio(); // se 0, roster of 4
    const future = rcv(live.state, {
      type: 'gjoinReceived',
      from: STARTER,
      delta: { tcm: 'call.gjoin', sid: SID, m: CARA, se: 2 },
    });
    expect(future.effects).toEqual([]);
    expect(future.state?.roster).toEqual(ROSTER4);
    expect(future.state?.held).toMatchObject({ m: CARA, se: 2 });

    const filled = rcv(future.state, {
      type: 'gjoinReceived',
      from: STARTER,
      delta: { tcm: 'call.gjoin', sid: SID, m: DEE, se: 1 },
    });
    expect(filled.state?.roster).toEqual([...ROSTER4, DEE, CARA]); // appended in epoch order
    expect(filled.state?.se).toBe(2);
    expect(filled.state?.held).toBeNull();
  });

  it('a second far-future delta replaces the held one — the starter mints serially, so newer wins', () => {
    const live = answered();
    const first = rcv(live.state, {
      type: 'gjoinReceived',
      from: STARTER,
      delta: { tcm: 'call.gjoin', sid: SID, m: CARA, se: 2 },
    });
    const second = rcv(first.state, {
      type: 'gjoinReceived',
      from: STARTER,
      delta: { tcm: 'call.gjoin', sid: SID, m: DEE, se: 3 },
    });
    expect(second.state?.held).toMatchObject({ m: DEE, se: 3 });
  });

  it('a redelivered (stale) authority delta is nothing', () => {
    const live = answered();
    const applied = rcv(live.state, {
      type: 'gjoinReceived',
      from: STARTER,
      delta: { tcm: 'call.gjoin', sid: SID, m: CARA, se: 1 },
    });
    const stale = rcv(applied.state, {
      type: 'gjoinReceived',
      from: STARTER,
      delta: { tcm: 'call.gjoin', sid: SID, m: CARA, se: 1 },
    });
    expect(stale.effects).toEqual([]);
    expect(stale.state).toEqual(applied.state);
  });

  it('a sovereign announce is never epoch-gated — leaving and announcing must always work', () => {
    const live = answered();
    const step = rcv(live.state, {
      type: 'gjoinReceived',
      from: ANA,
      delta: { tcm: 'call.gjoin', sid: SID, m: ANA, se: 9 },
    });
    expect(step.state?.announced).toContain(ANA);
  });
});

/* ========================================================================== *
 *  R11 — ONE CALL PER DEVICE. This module's half: one session by             *
 *  construction (a second start is refused; a stranger's invite into a live  *
 *  session meets busy). The cross-shape interlock — a live 1:1 busying       *
 *  ginvites and vice versa — lives in the coordinator (§4.5                  *
 *  liveSessionBusy), which is the only place that can see both shapes.       *
 * ========================================================================== */
describe('R11 — one session per device; strangers meet busy', () => {
  it('a second start while a session lives changes nothing', () => {
    const live = answered();
    const step = rcv(live.state, {
      type: 'start',
      sid: SID_LOWER,
      selfId: ME,
      roster: [ME, CARA],
      video: false,
      reportId: REPORT,
      cids: { [CARA]: CID_CARA },
    });
    expect(step.effects).toEqual([]);
    expect(step.state).toEqual(live.state);
  });

  it("a stranger's ginvite into a live session gets busy, never a leg", () => {
    const live = answered();
    const step = rcv(live.state, {
      type: 'ginviteReceived',
      from: STRANGER,
      selfId: ME,
      invite: invite({ cid: CID_GLARE, r: [STRANGER, STARTER, ANA, ME] }),
      serverTs: NOW,
    });
    expect(step.effects).toEqual([
      { type: 'closeLeg', peerId: STRANGER, cid: CID_GLARE, reason: 'busy', announce: true },
    ]);
    expect(step.state?.legs[STRANGER]).toBeUndefined();
  });
});

/* ========================================================================== *
 *  THE REFUSALS THAT SEND NOTHING (round-2 gate, partial 4).                 *
 *                                                                            *
 *  A ginvite is woken by a VoIP push, and the push rings a full-screen       *
 *  placeholder before anything can decrypt. Most refusals clear it as a side  *
 *  effect of the frame they send — closeLeg{busy} dismisses on its way out —  *
 *  but two of this module's refuse in total silence: an over-cap video        *
 *  roster, and a glare WINNER that arrived past its life. Both returned no    *
 *  effects at all, so the coordinator had nothing to act on and the           *
 *  placeholder rang on.                                                      *
 *                                                                            *
 *  Mutation run: dropped the dismissRing from the over-cap branch — this      *
 *  block's first test and the coordinator's `an over-cap video invite         *
 *  dismisses the ring it arrived behind` both went red. Dropped it from the   *
 *  stale-supersede branch — R9's stale-frame test and the coordinator's       *
 *  glare-winner test went red.                                               *
 * ========================================================================== */
describe('a refusal that sends no frame still clears the ring it arrived behind', () => {
  it('an over-cap video invite with no session is refused WITH a dismissal', () => {
    // The cap is call.ts's (`ignore/over_cap`) and is never re-derived here;
    // what is decided here is that a silent refusal still owes a dismissal.
    const step = rcv(null, {
      type: 'ginviteReceived',
      from: STARTER,
      selfId: ME,
      invite: invite({ vid: true, r: [STARTER, ANA, ME, BEN, CARA, DEE] }),
      serverTs: NOW,
    });
    expect(step.state).toBeNull();
    expect(step.effects).toEqual([{ type: 'dismissRing', peerId: STARTER }]);
  });

  it('and the same invite arriving into a LIVE session, which refuses it too', () => {
    const live = answered();
    const step = rcv(live.state, {
      type: 'ginviteReceived',
      from: EVE,
      selfId: ME,
      invite: invite({
        sid: SID_LOWER,
        cid: CID_GLARE,
        vid: true,
        r: [EVE, STARTER, ANA, ME, BEN, CARA],
      }),
      serverTs: NOW,
    });
    // Refused by the cap BEFORE glare is even considered — a wider-than-cap
    // roster does not get to supersede a healthy call by sorting low.
    expect(step.state).toEqual(live.state);
    expect(step.effects).toEqual([{ type: 'dismissRing', peerId: EVE }]);
  });

  it('an invite past its life is still the coordinator\'s to dismiss, not this module\'s', () => {
    // The boundary, stated so nobody "fixes" it into a second dismissal: an
    // expired invite with no session is refused on RINGABILITY, which the
    // coordinator asks itself (it holds the same serverTs and the same
    // exported predicate) and already dismisses with the honest 'expired'
    // reason. Emitting one here too would dismiss the same ring twice.
    const step = rcv(null, {
      type: 'ginviteReceived',
      from: STARTER,
      selfId: ME,
      invite: invite({ exp: NOW - 120_000 }),
      serverTs: NOW - 120_000,
    });
    expect(step.state).toBeNull();
    expect(step.effects).toEqual([]);
  });
});

/* ========================================================================== *
 *  §4.3 — THE CALLKIT AGGREGATE: N legs, exactly ONE report, ONE connected   *
 *  transition (on the FIRST leg), ONE release (when the last leg is gone).   *
 *                                                                            *
 *  Mutation run: emitted reportGroupConnected on every connected leg (guard  *
 *  widened to callKit !== 'none') — six tests went red, including every      *
 *  matrix scenario that counts per-device aggregates. Made sovereign leaves  *
 *  release unconditionally — R7's no-release-on-degrade assertions failed.   *
 * ========================================================================== */
describe('CallKit aggregate — one report, one connect, one release across a whole session', () => {
  it('callee lifecycle: ring → answer → two legs connect → everyone leaves = 1/1/1', () => {
    const all: SessionEffect[] = [];
    let state: GroupSessionState | null = null;
    const step = (input: GroupSessionInput, now = NOW) => {
      const s = groupSessionReducer(state, input, now);
      state = s.state;
      all.push(...s.effects);
      return s;
    };

    step({ type: 'ginviteReceived', from: STARTER, selfId: ME, invite: invite(), serverTs: NOW });
    step({
      type: 'ginviteReceived',
      from: BEN,
      selfId: ME,
      invite: invite({ cid: CID_HELD }),
      serverTs: NOW,
    });
    step({ type: 'localAnswer', cids: { [ANA]: CID_ANA } });
    step({ type: 'legStateChanged', peerId: STARTER, cid: CID_RING, name: 'connected' });
    const second = step({ type: 'legStateChanged', peerId: BEN, cid: CID_HELD, name: 'connected' });
    expect(second.effects).toEqual([]); // later legs connecting emit NOTHING
    step({ type: 'legStateChanged', peerId: ANA, cid: CID_ANA, name: 'connected' });
    // Everyone hangs up on us, leg by leg; only the LAST one releases.
    step({ type: 'legStateChanged', peerId: STARTER, cid: CID_RING, name: 'ending', reason: 'hangup' });
    step({ type: 'legStateChanged', peerId: BEN, cid: CID_HELD, name: 'ending', reason: 'hangup' });
    step({ type: 'legStateChanged', peerId: ANA, cid: CID_ANA, name: 'ending', reason: 'hangup' });

    expect(ofType(all, 'reportGroupIncoming')).toHaveLength(1);
    expect(ofType(all, 'reportGroupOutgoing')).toHaveLength(0);
    expect(ofType(all, 'reportGroupConnected')).toHaveLength(1);
    expect(ofType(all, 'releaseGroupCall')).toHaveLength(1);
    expect(state).toBeNull();
  });

  it('starter lifecycle: one outgoing report before any leg exists, connect on the first leg only', () => {
    const start = started();
    expect(ofType(start.effects, 'reportGroupOutgoing')).toEqual([
      { type: 'reportGroupOutgoing', sid: SID },
    ]);
    expect(start.effects.findIndex(e => e.type === 'reportGroupOutgoing')).toBeLessThan(
      start.effects.findIndex(e => e.type === 'openLegDial'),
    );
    const first = rcv(start.state, {
      type: 'legStateChanged', peerId: ANA, cid: CID_A, name: 'connected',
    });
    expect(ofType(first.effects, 'reportGroupConnected')).toHaveLength(1);
    expect(first.state?.connectedAt).toBe(NOW);
    const second = rcv(first.state, {
      type: 'legStateChanged', peerId: BEN, cid: CID_B, name: 'connected',
    });
    expect(second.effects).toEqual([
      { type: 'peakGroupCallMetric', localId: SID, participants: 3 },
    ]);
  });

  it('a session no leg of which ever connected releases as failed_ice (§5)', () => {
    let step = started();
    step = rcv(step.state, {
      type: 'legStateChanged', peerId: ANA, cid: CID_A, name: 'ending', reason: 'failed_ice',
    });
    expect(ofType(step.effects, 'releaseGroupCall')).toHaveLength(0); // BEN still dialling
    step = rcv(step.state, {
      type: 'legStateChanged', peerId: BEN, cid: CID_B, name: 'ending', reason: 'expired',
    });
    expect(step.state).toBeNull();
    // The particular failures differ; the aggregate is one honest fact —
    // this call never carried media and it was nobody's decision.
    expect(ofType(step.effects, 'releaseGroupCall')).toEqual([
      { type: 'releaseGroupCall', sid: SID, reason: 'failed_ice' },
    ]);
  });

  it('a session that rang out unanswered releases as timeout — a missed call, not a network fault', () => {
    let step = started();
    step = rcv(step.state, {
      type: 'legStateChanged', peerId: ANA, cid: CID_A, name: 'ending', reason: 'timeout',
    });
    step = rcv(step.state, {
      type: 'legStateChanged', peerId: BEN, cid: CID_B, name: 'ending', reason: 'timeout',
    });
    expect(step.state).toBeNull();
    expect(ofType(step.effects, 'releaseGroupCall')).toEqual([
      { type: 'releaseGroupCall', sid: SID, reason: 'timeout' },
    ]);
  });
});

/* -------------------------------------------------------------------------- *
 *  The pre-answer ring is owned by the proven 1:1 machine (openLegRinging):  *
 *  its cancel, timeout and expiry surface here as the ring collapsing.       *
 * -------------------------------------------------------------------------- */
describe('the ring collapses honestly: cancel and timeout release and kill held ringbacks', () => {
  for (const reason of ['cancelled', 'timeout'] as const) {
    it(`starter-leg ${reason} while ringing releases with ${reason} and closes held legs loudly`, () => {
      const step = rcv(held().state, {
        type: 'legStateChanged',
        peerId: STARTER,
        cid: CID_RING,
        name: 'ending',
        reason,
      });
      expect(step.state).toBeNull();
      expect(ofType(step.effects, 'closeLeg')).toEqual([
        { type: 'closeLeg', peerId: BEN, cid: CID_HELD, reason, announce: true },
      ]);
      expect(ofType(step.effects, 'releaseGroupCall')).toEqual([
        { type: 'releaseGroupCall', sid: SID, reason },
      ]);
    });
  }
});

describe('"Couldn\'t reach" (§5/§6): the mirror-empty tile state, upgraded honestly by a ringing ack', () => {
  it('mirror-empty marks an inviting leg unreachable; their ringing ack upgrades it', () => {
    const start = started();
    const flagged = rcv(start.state, { type: 'legPushMirrorEmpty', peerId: ANA });
    expect(flagged.effects).toEqual([{ type: 'legUnreachable', peerId: ANA }]);
    expect(flagged.state?.legs[ANA]?.phase).toBe('unreachable');
    const upgraded = rcv(flagged.state, {
      type: 'legStateChanged', peerId: ANA, cid: CID_A, name: 'outgoing_ringing',
    });
    expect(upgraded.state?.legs[ANA]?.phase).toBe('ringing');
  });

  it('a peer already past inviting cannot become unreachable — reachability was proven', () => {
    const start = started();
    const rung = rcv(start.state, {
      type: 'legStateChanged', peerId: ANA, cid: CID_A, name: 'outgoing_ringing',
    });
    const step = rcv(rung.state, { type: 'legPushMirrorEmpty', peerId: ANA });
    expect(step.effects).toEqual([]);
    expect(step.state?.legs[ANA]?.phase).toBe('ringing');
  });
});

describe('addParticipant — starter only, appended at the END, judged by the one admission function', () => {
  it('the starter adds: authority delta to incumbents, one dial, roster grows at the tail', () => {
    const step = rcv(started().state, { type: 'addParticipant', peerId: CARA, cid: CID_CARA });
    expect(step.state?.roster).toEqual([STARTER, ANA, BEN, CARA]);
    expect(step.state?.se).toBe(1);
    expect(ofType(step.effects, 'sendRosterDelta')).toEqual([
      {
        type: 'sendRosterDelta',
        to: [ANA, BEN],
        env: { tcm: 'call.gjoin', sid: SID, m: CARA, se: 1 },
        urgent: false,
      },
    ]);
    expect(ofType(step.effects, 'openLegDial')).toEqual([
      { type: 'openLegDial', peerId: CARA, cid: CID_CARA, kind: 'ginvite' },
    ]);
    expect(step.state?.legs[CARA]?.direction).toBe('out'); // starter offers on starter↔member legs
  });

  it('a non-starter cannot add, and a duplicate is nothing', () => {
    const member = rcv(answered().state, { type: 'addParticipant', peerId: CARA, cid: CID_CARA });
    expect(member.effects).toEqual([]);
    const dup = rcv(started().state, { type: 'addParticipant', peerId: ANA, cid: CID_CARA });
    expect(dup.effects).toEqual([]);
  });

  it('growth past the cap is refused BY DELEGATION — the over_cap verdict, not arithmetic here', () => {
    // A video session at the hard video cap of five.
    const full = rcv(null, {
      type: 'start',
      sid: SID,
      selfId: STARTER,
      roster: [STARTER, ANA, ME, BEN, CARA],
      video: true,
      reportId: REPORT,
      cids: { [ANA]: CID_A, [ME]: CID_B, [BEN]: CID_B2, [CARA]: CID_B3 },
    });
    const step = rcv(full.state, { type: 'addParticipant', peerId: EVE, cid: CID_GLARE });
    expect(step.effects).toEqual([]);
    expect(step.state?.roster).toHaveLength(5);
  });
});

describe('compose-strict starts (the call.ts doctrine: our own bad compose is loud)', () => {
  it('refuses a roster that omits this device, and a callee with no minted cid', () => {
    expect(() =>
      rcv(null, {
        type: 'start', sid: SID, selfId: ME, roster: [STARTER, ANA], video: false, reportId: REPORT,
        cids: { [STARTER]: CID_A, [ANA]: CID_B },
      }),
    ).toThrow(/omits this device/);
    expect(() =>
      rcv(null, {
        type: 'start', sid: SID, selfId: ME, roster: [ME, ANA], video: false, reportId: REPORT, cids: {},
      }),
    ).toThrow(/minted no cid/);
  });

  it('delegates roster shape and cap to assertComposableGroupCallRoster', () => {
    expect(() =>
      rcv(null, {
        type: 'start', sid: SID, selfId: ME, roster: [ME, ANA, ANA], video: false, reportId: REPORT,
        cids: { [ANA]: CID_A },
      }),
    ).toThrow(/refusing to compose/);
    expect(() =>
      rcv(null, {
        type: 'start', sid: SID, selfId: ME,
        roster: [ME, ANA, BEN, CARA, DEE, EVE], video: true, reportId: REPORT,
        cids: { [ANA]: CID_A, [BEN]: CID_B, [CARA]: CID_B2, [DEE]: CID_B3, [EVE]: CID_GLARE },
      }),
    ).toThrow(/the cap is 5/);
  });
});

describe('stale CallKit round trips address only the session they name (departure 8)', () => {
  it('callKitEnded for a dead sid ends nothing', () => {
    const live = answered();
    const step = rcv(live.state, { type: 'callKitEnded', sid: SID_HIGHER });
    expect(step.effects).toEqual([]);
    expect(step.state).toEqual(live.state);
  });
});

/* -------------------------------------------------------------------------- *
 *  ADMISSION IS DELEGATED, NOT RE-DERIVED (rule 24) — held at the SOURCE     *
 *  level, because behavioural tests cannot distinguish a faithful copy from  *
 *  the original until the copy drifts, and then it is too late. Crude, and   *
 *  meant to be: the module may not name the cap constants, may not compare   *
 *  sid orderings, and may import from exactly its two permitted files.       *
 * -------------------------------------------------------------------------- */
describe('delegation, held at the source level', () => {
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../src/call-session.ts'),
    'utf8',
  );

  it('never names a cap constant — caps live in call.ts alone', () => {
    expect(src.includes('SMALL_GROUP_CALL')).toBe(false);
    expect(src.includes('smallGroupCallParticipantCap')).toBe(false);
  });

  it('never orders sids — glare ranking is admitGroupCallInvite\'s alone', () => {
    expect(/\bsid\s*[<>]/.test(src)).toBe(false);
    expect(/\.sid\s*[<>]/.test(src)).toBe(false);
  });

  it('imports only from ./call.js and ./call-machine.js, and does consult both admission functions', () => {
    const specifiers = [...src.matchAll(/from\s+'([^']+)'/g)].map(m => m[1]);
    expect(new Set(specifiers)).toEqual(new Set(['./call.js', './call-machine.js']));
    expect(src).toMatch(/admitGroupCallInvite\(/);
    expect(src).toMatch(/admitGroupCallRosterDelta\(/);
    expect(src).toMatch(/groupCallInviteIsRingable\(/);
    expect(src).toMatch(/assertComposableGroupCallRoster\(/);
  });
});
