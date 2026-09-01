import { describe, expect, it } from 'vitest';
import {
  CALL_TCMS,
  GROUP_CALL_TCMS,
  GroupCallEnvelope,
  GroupCallInviteEnvelope,
  GroupCallJoinEnvelope,
  GroupCallSessionView,
  SMALL_GROUP_CALL_DEFAULT_VIDEO_PARTICIPANTS,
  SMALL_GROUP_CALL_MAX_PARTICIPANTS,
  SMALL_GROUP_CALL_MAX_VIDEO_PARTICIPANTS,
  admitGroupCallInvite,
  admitGroupCallRosterDelta,
  assertComposableGroupCallRoster,
  encodeGroupCallEnvelope,
  groupCallInviteIsRingable,
  isCallTcm,
  isGroupCallTcm,
  parseCallEnvelope,
  parseGroupCallEnvelope,
  smallGroupCallParticipantCap,
} from '../src/call.js';

/**
 * The small-group call signalling wire:
 * `call.ginvite` / `call.gjoin` / `call.gleave`, the starter's roster
 * authority, the participant caps, and the admission rules. Everything here is pure
 * and clock-free except the ringability check, which is clocked on purpose
 * and separately, exactly as `offerIsRingable` is for 1:1.
 */

// Distinct, lexicographically ordered ULIDs (Crockford base32, 26 chars).
const SID = '01ARZ3NDEKTSV4RRFFQ69G5FAA';
const SID_LOWER = '01ARZ3NDEKTSV4RRFFQ69G5F00'; // < SID: wins session glare
const SID_HIGHER = '01ARZ3NDEKTSV4RRFFQ69G5FZZ'; // > SID: loses session glare
const CID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const STARTER = '01BX5ZZKBKACTAV9WEVGEMMVS0';
const ANA = '01BX5ZZKBKACTAV9WEVGEMMVS1';
const BEN = '01BX5ZZKBKACTAV9WEVGEMMVS2';
const CARA = '01BX5ZZKBKACTAV9WEVGEMMVS3';
const STRANGER = '01BX5ZZKBKACTAV9WEVGEMMVSZ';
const MORE = [
  '01BX5ZZKBKACTAV9WEVGEMMVS4',
  '01BX5ZZKBKACTAV9WEVGEMMVS5',
  '01BX5ZZKBKACTAV9WEVGEMMVS6',
  '01BX5ZZKBKACTAV9WEVGEMMVS7',
];
const SDP = 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\na=fingerprint:sha-256 AA:BB\r\n';

const session = (over: Partial<GroupCallSessionView> = {}): GroupCallSessionView => ({
  sid: SID,
  starterId: STARTER,
  roster: [STARTER, ANA, BEN],
  se: 0,
  video: true,
  ...over,
});

const gjoin = (m: string, se = 1): GroupCallJoinEnvelope => ({
  tcm: 'call.gjoin',
  sid: SID,
  m,
  se,
});

const ginvite = (over: Partial<GroupCallInviteEnvelope> = {}): GroupCallInviteEnvelope => ({
  tcm: 'call.ginvite',
  sid: SID,
  cid: CID,
  r: [STARTER, ANA, BEN],
  sdp: SDP,
  vid: true,
  exp: 1_700_000_000_000,
  ...over,
});

/* ========================================================================== *
 *                                                                            *
 *   THE STARTER OWNS THE ROSTER, AND NOBODY ELSE (§9.4).                     *
 *                                                                            *
 *   This is the security rule the whole wire exists to enforce. Remove the   *
 *   `delta.m !== from` check in `admitGroupCallRosterDelta` and this block   *
 *   goes red. Without it, any participant could name an arbitrary account    *
 *   and cause every other phone in the call to admit — and then dial — a     *
 *   stranger: a small-group call becomes a distributed dialler. The same     *
 *   class of vulnerability the glare `peerId` equality check closed at the   *
 *   leg level, where its absence auto-answered a stranger's offer with       *
 *   camera and mic live.                                                     *
 *                                                                            *
 * ========================================================================== */
describe('THE STARTER OWNS THE ROSTER — a call.gjoin from a non-starter naming an unknown account is IGNORED', () => {
  it('IGNORES a gjoin from a member naming a STRANGER — the "any member can make your phone dial anyone" case', () => {
    // Ana is a legitimate participant. She names an account the starter never
    // admitted. If this ever becomes 'apply', every phone in the call dials
    // the stranger.
    expect(admitGroupCallRosterDelta(session(), ANA, gjoin(STRANGER))).toEqual({
      verdict: 'ignore',
      reason: 'not_the_starter',
    });
  });

  it('the SAME claim from the STARTER applies — proving the ignore discriminates on authority, not on the account', () => {
    // Same envelope shape, same unknown account, correct epoch. Only the
    // authenticated sender differs. This control is what makes the test above
    // bite on the authority check rather than on the stranger's id.
    expect(admitGroupCallRosterDelta(session(), STARTER, gjoin(STRANGER))).toEqual({
      verdict: 'apply',
    });
  });

  it('a non-starter may not name ANYONE else — even another legitimate member. Authority is not divisible', () => {
    expect(admitGroupCallRosterDelta(session(), ANA, gjoin(BEN))).toEqual({
      verdict: 'ignore',
      reason: 'not_the_starter',
    });
  });

  it('a participant may announce only THEMSELF, and only once the starter has named them', () => {
    // Sovereign lane, the legitimate half of gjoin: Ben says "I am in".
    expect(admitGroupCallRosterDelta(session(), BEN, gjoin(BEN))).toEqual({
      verdict: 'apply',
    });
    // A stranger saying "I am in" about themself is still a stranger: the
    // starter never named them, so there is nothing for them to be in.
    expect(admitGroupCallRosterDelta(session(), STRANGER, gjoin(STRANGER))).toEqual({
      verdict: 'ignore',
      reason: 'not_in_roster',
    });
  });

  it('a non-starter cannot EJECT a third party with call.gleave any more than dial one in', () => {
    const gleave = { tcm: 'call.gleave' as const, sid: SID, m: BEN, se: 1 };
    expect(admitGroupCallRosterDelta(session(), ANA, gleave)).toEqual({
      verdict: 'ignore',
      reason: 'not_the_starter',
    });
    // But anyone may take themself out, always.
    expect(admitGroupCallRosterDelta(session(), BEN, { ...gleave, m: BEN })).toEqual({
      verdict: 'apply',
    });
    // And the starter may remove anyone — authority, at the next epoch.
    expect(admitGroupCallRosterDelta(session(), STARTER, gleave)).toEqual({
      verdict: 'apply',
    });
  });

  it('the sender is the ratchet-authenticated frame.from, so the payload cannot vote: m is never consulted for authority', () => {
    // Ana forges m = STARTER. If admission ever read authority out of the
    // payload instead of out of `from`, this would apply.
    expect(admitGroupCallRosterDelta(session(), ANA, gjoin(STARTER))).toEqual({
      verdict: 'ignore',
      reason: 'not_the_starter',
    });
  });
});

describe('roster-delta admission — session binding and epoch ordering (§9.4)', () => {
  it('a delta for a different sid is not this session’s delta at all', () => {
    const wrong = { ...gjoin(CARA), sid: SID_HIGHER };
    expect(admitGroupCallRosterDelta(session(), STARTER, wrong)).toEqual({
      verdict: 'ignore',
      reason: 'wrong_session',
    });
  });

  it('authority deltas apply at exactly se+1; a redelivery is ignored; the future is HELD, never dropped', () => {
    const view = session({ se: 3 });
    expect(admitGroupCallRosterDelta(view, STARTER, gjoin(CARA, 4))).toEqual({
      verdict: 'apply',
    });
    // The queue redelivers: an epoch already applied must not re-apply.
    expect(admitGroupCallRosterDelta(view, STARTER, gjoin(CARA, 3))).toEqual({
      verdict: 'ignore',
      reason: 'stale_epoch',
    });
    // Out-of-order arrival: hold for the gap to fill. Hold-never-drop is
    // right HERE because an authority exists to order deltas.
    expect(admitGroupCallRosterDelta(view, STARTER, gjoin(CARA, 5))).toEqual({
      verdict: 'hold',
    });
  });

  it('a sovereign self-announce is not epoch-gated — leaving and announcing must always work', () => {
    // Ben echoes an epoch the device has long passed; his own announcement
    // still counts. The epoch orders the AUTHORITY lane only.
    expect(admitGroupCallRosterDelta(session({ se: 9 }), BEN, gjoin(BEN, 1))).toEqual({
      verdict: 'apply',
    });
  });
});

describe('the caps: 4 video by default, 5 hard, 6 audio-only (§9.5)', () => {
  it('match the designed values and stay in order', () => {
    expect(SMALL_GROUP_CALL_DEFAULT_VIDEO_PARTICIPANTS).toBe(4);
    expect(SMALL_GROUP_CALL_MAX_VIDEO_PARTICIPANTS).toBe(5);
    expect(SMALL_GROUP_CALL_MAX_PARTICIPANTS).toBe(6);
    expect(smallGroupCallParticipantCap(true)).toBe(5);
    expect(smallGroupCallParticipantCap(false)).toBe(6);
  });

  it('the starter cannot grow a video session past 5 or an audio session past 6', () => {
    const fullVideo = session({ roster: [STARTER, ANA, BEN, CARA, MORE[0]] });
    expect(admitGroupCallRosterDelta(fullVideo, STARTER, gjoin(STRANGER))).toEqual({
      verdict: 'ignore',
      reason: 'over_cap',
    });
    // The same sixth head is legal audio-only.
    const fullAudio = session({
      roster: [STARTER, ANA, BEN, CARA, MORE[0]],
      video: false,
    });
    expect(admitGroupCallRosterDelta(fullAudio, STARTER, gjoin(STRANGER))).toEqual({
      verdict: 'apply',
    });
    expect(
      admitGroupCallRosterDelta(
        session({ roster: [STARTER, ANA, BEN, CARA, MORE[0], MORE[1]], video: false }),
        STARTER,
        gjoin(STRANGER),
      ),
    ).toEqual({ verdict: 'ignore', reason: 'over_cap' });
  });

  it('re-announcing someone already in a full roster is not growth and still applies', () => {
    const full = session({ roster: [STARTER, ANA, BEN, CARA, MORE[0]] });
    expect(admitGroupCallRosterDelta(full, STARTER, gjoin(ANA))).toEqual({
      verdict: 'apply',
    });
  });

  it('a video ginvite wider than the hard cap is dropped without ringing — fail closed, never fail into more dialling', () => {
    const six = [STARTER, ANA, BEN, CARA, MORE[0], MORE[1]];
    expect(admitGroupCallInvite(null, STARTER, ginvite({ r: six, vid: true }))).toEqual({
      verdict: 'ignore',
      reason: 'over_cap',
    });
    expect(admitGroupCallInvite(null, STARTER, ginvite({ r: six, vid: false }))).toEqual({
      verdict: 'ring',
    });
  });
});

describe('a malformed roster must not cost the whole frame (§5.5) — and must never buy extra dialling', () => {
  const inviteBodyWith = (r: unknown): string =>
    JSON.stringify({ tcm: 'call.ginvite', sid: SID, cid: CID, r, sdp: SDP, vid: true, exp: 1 });

  it('an OVERSIZE roster parses with an empty one: the frame survives, nobody extra gets dialled', () => {
    // Bounded at the schema because a peer-supplied array will be iterated to
    // open legs — GroupCallRoster caps what any downstream loop can see.
    const seven = [STARTER, ANA, BEN, CARA, ...MORE].slice(0, 7);
    const parsed = parseGroupCallEnvelope(inviteBodyWith(seven));
    expect(parsed).not.toBeNull();
    expect(parsed).toMatchObject({ tcm: 'call.ginvite', r: [] });
  });

  it('one bad id, a duplicate, or a non-array all collapse the roster and only the roster', () => {
    for (const r of [
      [STARTER, ANA, 'not-a-ulid'],
      [STARTER, ANA, ANA],
      'not-an-array',
      42,
    ]) {
      const parsed = parseGroupCallEnvelope(inviteBodyWith(r));
      expect(parsed).not.toBeNull();
      expect(parsed).toMatchObject({ r: [] });
    }
  });

  it('a full legal roster of six is accepted verbatim', () => {
    const six = [STARTER, ANA, BEN, CARA, MORE[0], MORE[1]];
    expect(parseGroupCallEnvelope(inviteBodyWith(six))).toMatchObject({ r: six });
  });

  it('compose-strict: our own send path throws where the parser forgives', () => {
    expect(() => assertComposableGroupCallRoster([STARTER, ANA, 'nope'], false)).toThrow(
      /refusing to compose/,
    );
    expect(() => assertComposableGroupCallRoster([STARTER, ANA, ANA], false)).toThrow(
      /refusing to compose/,
    );
    expect(() =>
      assertComposableGroupCallRoster([STARTER, ANA, BEN, CARA, MORE[0], MORE[1], MORE[2]], false),
    ).toThrow(/refusing to compose/);
    // The mode cap binds the composer too: six heads with video is refused...
    expect(() =>
      assertComposableGroupCallRoster([STARTER, ANA, BEN, CARA, MORE[0], MORE[1]], true),
    ).toThrow(/the cap is 5/);
    // ...while five with video and six audio-only are the legal maxima.
    expect(assertComposableGroupCallRoster([STARTER, ANA, BEN, CARA, MORE[0]], true)).toEqual([
      STARTER, ANA, BEN, CARA, MORE[0],
    ]);
    expect(
      assertComposableGroupCallRoster([STARTER, ANA, BEN, CARA, MORE[0], MORE[1]], false),
    ).toHaveLength(6);
  });
});

describe('invite admission — late join, strangers, and session glare (§9.4)', () => {
  it('with no live session, a well-formed invite rings', () => {
    expect(admitGroupCallInvite(null, STARTER, ginvite())).toEqual({ verdict: 'ring' });
  });

  it('a late joiner already in the roster held FROM THE STARTER is a silent new leg — no ring', () => {
    expect(admitGroupCallInvite(session(), BEN, ginvite())).toEqual({ verdict: 'join_leg' });
  });

  it("a stranger's leg into a live session is refused with busy, whatever roster their envelope asserts", () => {
    // The stranger writes themself (and the whole call) into their own r.
    // Admission reads the roster held from the starter, never the payload.
    const forged = ginvite({ r: [STRANGER, STARTER, ANA, BEN] });
    expect(admitGroupCallInvite(session(), STRANGER, forged)).toEqual({ verdict: 'busy' });
  });

  it('session glare: the lower sid wins on every device, with no coordination', () => {
    expect(admitGroupCallInvite(session(), CARA, ginvite({ sid: SID_LOWER }))).toEqual({
      verdict: 'supersede',
    });
    expect(admitGroupCallInvite(session(), CARA, ginvite({ sid: SID_HIGHER }))).toEqual({
      verdict: 'busy',
    });
  });
});

describe('schema round-trips and strictness', () => {
  it('round-trips every small-group kind', () => {
    const envelopes: GroupCallEnvelope[] = [
      ginvite(),
      { tcm: 'call.gjoin', sid: SID, m: ANA, se: 1 },
      { tcm: 'call.gleave', sid: SID, m: ANA, se: 2 },
    ];
    for (const envelope of envelopes) {
      expect(parseGroupCallEnvelope(encodeGroupCallEnvelope(envelope))).toEqual(envelope);
    }
  });

  it('requires ULIDs for sid, cid and m', () => {
    expect(parseGroupCallEnvelope(JSON.stringify({ ...ginvite(), sid: 'nope' }))).toBeNull();
    expect(parseGroupCallEnvelope(JSON.stringify({ ...ginvite(), cid: 'nope' }))).toBeNull();
    expect(
      parseGroupCallEnvelope(JSON.stringify({ tcm: 'call.gjoin', sid: SID, m: 'nope', se: 1 })),
    ).toBeNull();
  });

  it('requires an expiry on the invite and a positive epoch on deltas', () => {
    const { exp: _exp, ...noExp } = ginvite();
    expect(parseGroupCallEnvelope(JSON.stringify(noExp))).toBeNull();
    expect(
      parseGroupCallEnvelope(JSON.stringify({ tcm: 'call.gjoin', sid: SID, m: ANA, se: 0 })),
    ).toBeNull();
  });

  it('caps the SDP with the same ceiling as a 1:1 offer', () => {
    expect(
      parseGroupCallEnvelope(JSON.stringify(ginvite({ sdp: 'v='.padEnd(20_001, 'x') }))),
    ).toBeNull();
  });

  it('rejects unknown kinds, the old 1:1 kinds, and non-envelope bodies', () => {
    expect(parseGroupCallEnvelope(JSON.stringify({ tcm: 'call.gfuture', sid: SID }))).toBeNull();
    expect(
      parseGroupCallEnvelope(JSON.stringify({ tcm: 'call.offer', cid: CID, sdp: SDP, vid: true, exp: 1 })),
    ).toBeNull();
    expect(parseGroupCallEnvelope('hello there')).toBeNull();
  });

  it('applies the same two ringability bounds as a 1:1 offer (§6.4)', () => {
    const invite = ginvite({ exp: 1_000_000 });
    expect(groupCallInviteIsRingable(invite, 995_000, 1_000_000)).toBe(true);
    expect(groupCallInviteIsRingable(invite, 1_020_000, 1_029_999)).toBe(true); // inside skew
    expect(groupCallInviteIsRingable(invite, 1_030_001, 1_030_001)).toBe(false); // past exp+skew
    expect(groupCallInviteIsRingable(invite, 900_000, 990_001)).toBe(false); // server-age cap
  });
});

/* -------------------------------------------------------------------------- *
 * The compat requirement: "an old build receiving call.ginvite stays silent and rings
 * nothing." An old build is a binary we cannot patch, so the property has to
 * be structural, and it rests on exactly two facts held below:
 *
 *  1. the shipped 1:1 contract — CallEnvelope / parseCallEnvelope /
 *     CALL_TCMS, byte-identical in an old build — does NOT recognise the new
 *     kinds, so nothing downstream of a parse can ring;
 *  2. every new kind lives inside the `call.` NAMESPACE, which the app routes
 *     as transport BEFORE parsing (`isCarrierEnvelope`,
 *     `app/src/envelope.ts:703`), so the unparseable frame is silent
 *     signalling — never a message row, never a preview, never "Unsupported
 *     message".
 * -------------------------------------------------------------------------- */
describe('an old build receiving call.ginvite stays silent and rings nothing', () => {
  it('the shipped 1:1 union — exactly what an old build parses with — returns null for every small-group kind', () => {
    const bodies = [
      encodeGroupCallEnvelope(ginvite()),
      encodeGroupCallEnvelope({ tcm: 'call.gjoin', sid: SID, m: ANA, se: 1 }),
      encodeGroupCallEnvelope({ tcm: 'call.gleave', sid: SID, m: ANA, se: 1 }),
    ];
    for (const body of bodies) {
      // null means "not a call" and never "an empty call" (parseCallEnvelope's
      // contract) — nothing to dispatch, nothing to ring.
      expect(parseCallEnvelope(body)).toBeNull();
    }
    for (const tcm of GROUP_CALL_TCMS) {
      expect(isCallTcm(tcm)).toBe(false);
    }
  });

  it('every small-group kind is inside the call. namespace, so transport-before-parse silences it on builds that predate it', () => {
    // Mirror of the app's routing (app/src/envelope.ts): the declared tcm is
    // read with /^\{"tcm":"([a-z][a-z0-9._-]{0,31})"/ and a `call.` prefix is
    // a carrier BEFORE any schema runs. Both halves are asserted: the names
    // fit the namespace, and the encoded bytes actually open with it.
    const DECLARED_TCM = /^\{"tcm":"([a-z][a-z0-9._-]{0,31})"/;
    for (const tcm of GROUP_CALL_TCMS) {
      expect(tcm.startsWith('call.')).toBe(true);
    }
    const encoded: GroupCallEnvelope[] = [
      ginvite(),
      { tcm: 'call.gjoin', sid: SID, m: ANA, se: 1 },
      { tcm: 'call.gleave', sid: SID, m: ANA, se: 1 },
    ];
    for (const envelope of encoded) {
      const body = encodeGroupCallEnvelope(envelope);
      const declared = DECLARED_TCM.exec(body)?.[1];
      expect(declared).toBe(envelope.tcm);
      expect(declared?.startsWith('call.')).toBe(true);
    }
  });

  it('the two tcm sets are disjoint — a kind in both would make an old build parse it, which is exactly what must not happen', () => {
    for (const tcm of GROUP_CALL_TCMS) {
      expect((CALL_TCMS as readonly string[]).includes(tcm)).toBe(false);
    }
    for (const tcm of CALL_TCMS) {
      expect(isGroupCallTcm(tcm)).toBe(false);
    }
  });
});
