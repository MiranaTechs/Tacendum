import { z } from 'zod';
import { Ulid } from './frames.js';

/**
 * Call signaling envelopes — the whole wire contract for
 * calling, defined once here so the app, the CLI, and the tests cannot drift.
 *
 * These ride INSIDE the Double Ratchet exactly like a photo pointer or a
 * profile card: the server routes opaque ciphertext and never sees an SDP.
 * That is the entire security argument for calls (§3.2) — the DTLS
 * fingerprint inside an offer is authenticated because the offer itself
 * arrived through a session rooted in a TOFU-pinned identity.
 *
 * Two rules shape every schema below. First, an envelope must fit one
 * WebSocket frame after encryption (§5.5), so anything unbounded gets a cap
 * here rather than failing at the transport. Second, a peer must not be able
 * to make us ring forever or flood the ratchet, so expiries are mandatory and
 * candidate batches are bounded.
 */

/**
 * SDP ceiling. The frame budget is 30 000 base64 chars ≈ 22 500 plaintext
 * bytes; base64 inflates by 4/3, so 20 000 chars of SDP plus the envelope's
 * own JSON stays inside it with room for Signal's own framing. A real trimmed
 * offer is ~3.5 KB (§7.3), and the non-trickle fallback worst case is ~18 KB,
 * so this rejects only what the transport would reject anyway — but it does so
 * before a ratchet step is burned on it.
 */
export const MAX_SDP_LENGTH = 20_000;

/** Trickle-ICE batching (§3.6): coalesced in a 150 ms window, at most 10 per
 * envelope, and a hard per-call-per-direction cap so a candidate flood cannot
 * burn the ratchet or exhaust the sender's rate-limit bucket. */
export const MAX_ICE_CANDIDATES_PER_ENVELOPE = 10;
export const MAX_ICE_CANDIDATES_PER_CALL = 40;

// --- timers (§6.4). Every one of them, in one place. ---

/** A phone that was offline for an hour must not ring for a call that ended
 * 59 minutes ago. Set by the caller as an absolute `exp`; enforced by the
 * callee against its own clock. */
export const OFFER_TTL_MS = 60_000;
/** Clock skew the callee forgives on `exp` — the caller's clock is not ours. */
export const OFFER_EXP_SKEW_MS = 30_000;
/** Server-stamped age at which an offer is discarded regardless of `exp`.
 * Server time is the tiebreaker because it is the one clock both sides share. */
export const OFFER_MAX_SERVER_AGE_MS = 90_000;
/** No answer. Matches iOS/GSM convention. */
export const CALL_RING_TIMEOUT_MS = 60_000;
/** Answered but ICE never connected — long enough for a slow TURN allocation
 * on cellular, short enough not to feel broken. */
export const CALL_CONNECT_TIMEOUT_MS = 45_000;
/** ICE lost mid-call: covers a WiFi→LTE handoff plus one restart round trip. */
export const CALL_RECONNECT_TIMEOUT_MS = 30_000;
/** Candidate coalescing window — below human perception. */
export const ICE_BATCH_WINDOW_MS = 150;
/** Hard iOS constraint (§9.4): miss it and iOS terminates the app. */
export const CALLKIT_REPORT_DEADLINE_MS = 5_000;
/** No `call.ringing` yet — caller UI softens to "they may be offline". */
export const RINGING_ACK_GRACE_MS = 8_000;

/**
 * Why a call ended. A closed enum because it drives both the call-log row and
 * the CallKit end-reason mapping — an unrecognised reason would render as a
 * blank row, so an unknown value must fail the parse instead.
 */
export const CALL_END_REASONS = [
  /** A participant tapped End after connecting. */
  'hangup',
  /** Callee explicitly declined. */
  'decline',
  /** Callee was already in another call. */
  'busy',
  /** Rang unanswered past CALL_RING_TIMEOUT_MS — missed on the callee's side. */
  'timeout',
  /** Caller hung up before the callee answered — missed on the callee's side. */
  'cancelled',
  /** ICE never reached connected within budget. */
  'failed_ice',
  /** Connected, then ICE failed and the restart did not recover. */
  'failed_media',
  /** Simultaneous invite; this side yielded (§6.5). No log row either side. */
  'glare_lost',
  /** Offer arrived past its exp — missed, never rung. */
  'expired',
  /** Callee's safety number changed / peer blocked. */
  'blocked',
  /** Peer's app is too old to parse the envelope. */
  'unsupported',
] as const;

export const CallEndReason = z.enum(CALL_END_REASONS);
export type CallEndReason = z.infer<typeof CallEndReason>;

const Sdp = z.string().min(1).max(MAX_SDP_LENGTH, 'sdp too large');

/**
 * Invite. Carries the full SDP offer; the `a=fingerprint` line inside it is
 * the security-relevant field (§3.2). `cid` is minted by the CALLER and
 * identifies this call for its lifetime — including for glare resolution,
 * which compares two cids lexicographically (§6.5).
 */
export const CallOfferEnvelope = z.object({
  tcm: z.literal('call.offer'),
  cid: Ulid,
  sdp: Sdp,
  /** Caller opened with video enabled. A UI hint only — media is authoritative. */
  vid: z.boolean(),
  /** Absolute unix ms after which the callee must not ring (§6.4). */
  exp: z.number().int().positive(),
});
export type CallOfferEnvelope = z.infer<typeof CallOfferEnvelope>;

/** Accept. */
export const CallAnswerEnvelope = z.object({
  tcm: z.literal('call.answer'),
  cid: Ulid,
  sdp: Sdp,
  vid: z.boolean(),
});
export type CallAnswerEnvelope = z.infer<typeof CallAnswerEnvelope>;

/** Trickle ICE, batched (§3.6). `mid`/`idx` are the SDP m-line bindings. */
export const CallIceEnvelope = z.object({
  tcm: z.literal('call.ice'),
  cid: Ulid,
  c: z
    .array(
      z.object({
        cand: z.string().min(1).max(512),
        mid: z.string().max(16),
        idx: z.number().int().nonnegative().max(32),
      }),
    )
    .min(1)
    .max(MAX_ICE_CANDIDATES_PER_ENVELOPE),
});
export type CallIceEnvelope = z.infer<typeof CallIceEnvelope>;

/** Terminal. Sent by whichever side ends it, for every reason incl. decline. */
export const CallEndEnvelope = z.object({
  tcm: z.literal('call.end'),
  cid: Ulid,
  r: CallEndReason,
});
export type CallEndEnvelope = z.infer<typeof CallEndEnvelope>;

/**
 * The callee's device received the offer and is ringing. Purely for the
 * caller's UI ("Ringing…" vs "Calling…") — it never gates state, because a
 * peer that never sends it must still be callable.
 */
export const CallRingingEnvelope = z.object({
  tcm: z.literal('call.ringing'),
  cid: Ulid,
});
export type CallRingingEnvelope = z.infer<typeof CallRingingEnvelope>;

/** Mid-call media toggles. Camera flip is local-only and never announced. */
export const CallMediaEnvelope = z.object({
  tcm: z.literal('call.media'),
  cid: Ulid,
  /** Audio track enabled. */
  a: z.boolean(),
  /** Video track enabled. */
  v: z.boolean(),
  /** Reserved: track kind, for future screen sharing (§1.3). */
  k: z.enum(['cam', 'screen']).optional(),
});
export type CallMediaEnvelope = z.infer<typeof CallMediaEnvelope>;

/** ICE restart after a network change (§7.6). Fresh offer, SAME cid. */
export const CallRestartEnvelope = z.object({
  tcm: z.literal('call.restart'),
  cid: Ulid,
  sdp: Sdp,
});
export type CallRestartEnvelope = z.infer<typeof CallRestartEnvelope>;

export const CallEnvelope = z.discriminatedUnion('tcm', [
  CallOfferEnvelope,
  CallAnswerEnvelope,
  CallIceEnvelope,
  CallEndEnvelope,
  CallRingingEnvelope,
  CallMediaEnvelope,
  CallRestartEnvelope,
]);
export type CallEnvelope = z.infer<typeof CallEnvelope>;

/** Every call `tcm`, for the carrier-envelope check: call signaling never
 * becomes a message row and never touches a chat preview (§5.1). */
export const CALL_TCMS = [
  'call.offer',
  'call.answer',
  'call.ice',
  'call.end',
  'call.ringing',
  'call.media',
  'call.restart',
] as const;

export type CallTcm = (typeof CALL_TCMS)[number];

export function isCallTcm(tcm: string): tcm is CallTcm {
  return (CALL_TCMS as readonly string[]).includes(tcm);
}

/** How a structured body announces itself (mirrors the app's envelope layer). */
const ENVELOPE_SENTINEL = '{"tcm":';

/**
 * Strict parse; null for anything that is not a well-formed call envelope.
 * Callers must treat null as "not a call" and never as "an empty call" — an
 * unparseable body that claims to be an envelope renders as unsupported
 * (§5.1), it does not ring a phone.
 */
export function parseCallEnvelope(body: string): CallEnvelope | null {
  if (!body.startsWith(ENVELOPE_SENTINEL)) return null;
  try {
    const parsed = CallEnvelope.safeParse(JSON.parse(body));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function encodeCallEnvelope(envelope: CallEnvelope): string {
  return JSON.stringify(envelope);
}

/**
 * Whether an offer may still ring, given the callee's clock and the
 * server-stamped receipt time (§6.4). Both bounds are enforced: `exp` with
 * skew tolerance, and an absolute server-age cap so a caller with a wildly
 * wrong clock cannot hold a phone ringing.
 */
export function offerIsRingable(
  offer: CallOfferEnvelope,
  serverTs: number,
  now: number,
): boolean {
  if (now > offer.exp + OFFER_EXP_SKEW_MS) return false;
  if (now - serverTs > OFFER_MAX_SERVER_AGE_MS) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Small-group calls.
//
// Everything below is ADDITIVE, and the 1:1 contract above is deliberately
// not widened: `CallEnvelope`, `CALL_TCMS` and `parseCallEnvelope` stay
// exactly the union an old build ships, because that union not knowing
// `call.g*` IS the forward-compatibility story. The `call.` namespace is
// routed as transport BEFORE parsing (`app/src/envelope.ts` —
// `isCarrierEnvelope` reads the declared tcm and returns true for the whole
// namespace), so a build that cannot parse these kinds treats them as silent
// signalling: it never rings, never renders a row, and the starter simply
// sees no `call.ringing` (§9.4). Honest failure, no crash, no raw JSON.
//
// A separate tcm per kind rather than optional fields on `CallOfferEnvelope`,
// deliberately: an old build must not half-join a small-group call as a 1:1.
// ---------------------------------------------------------------------------

/**
 * The participant ceilings (§9.5): 4 with video by default, 5 hard cap with
 * video, 6 audio-only. Provisional until G11 measures them, and honest about
 * being arithmetic — mesh uplink and simultaneous hardware encodes set the
 * wall, not signalling. Past the ceiling the UI says so plainly rather than
 * degrading: the Add button disables at the cap with "Calls hold five
 * people. For more, use the room." Nothing in this design enables more, and
 * no copy may imply it does.
 */
export const SMALL_GROUP_CALL_DEFAULT_VIDEO_PARTICIPANTS = 4;
export const SMALL_GROUP_CALL_MAX_VIDEO_PARTICIPANTS = 5;
/** The audio-only ceiling — the widest any roster can legally be, which is
 * why it is also the schema bound on the peer-supplied roster array below. */
export const SMALL_GROUP_CALL_MAX_PARTICIPANTS = 6;

/** The one place the video/audio cap split is decided (§9.5). */
export function smallGroupCallParticipantCap(video: boolean): number {
  return video
    ? SMALL_GROUP_CALL_MAX_VIDEO_PARTICIPANTS
    : SMALL_GROUP_CALL_MAX_PARTICIPANTS;
}

/**
 * THE ROSTER, composed strictly and parsed permissively — `RosterDigest`'s
 * pattern (`group-envelope.ts`), applied to the array that matters most in
 * this file. Bounded AT THE SCHEMA because a peer-supplied roster is an array
 * that will be iterated to open media legs — the same reasoning
 * `GroupNewEnvelope.ms` documents: an unbounded roster from the network
 * drives unbounded work before anything downstream trims it. Duplicates are
 * refused for the same reason a bound exists: a repeated id is a repeated
 * leg.
 */
export const GroupCallRoster = z
  .array(Ulid)
  .min(1)
  .max(SMALL_GROUP_CALL_MAX_PARTICIPANTS)
  .refine(roster => new Set(roster).size === roster.length, {
    message: 'a small-group call roster may not repeat an id',
  });

/**
 * The receive-side shape. `.catch([])` turns ANY malformed roster — a bad id,
 * a duplicate, an oversize array, a non-array — into an EMPTY one rather than
 * into a lost frame, and the failure direction is chosen deliberately: an
 * empty roster dials NOBODY extra, so the invite degrades to the one leg the
 * ratchet already authenticates (its sender's) and never to more dialling.
 * §5.5's rule is that a parser refusal costs the whole message, and on a
 * one-way ratchet that loss is permanent; the roster is worth losing, the
 * invite is not.
 */
const WireGroupCallRoster = GroupCallRoster.catch([]);

/**
 * Refuse to COMPOSE a roster that is malformed or over the cap for its mode.
 * The send path calls this before encoding; the parser never does — it has
 * `.catch` instead. A bad roster of our own making is a bug in this build and
 * should be loud, whereas a bad roster of a peer's making must never cost the
 * frame (the `assertComposableRd` split, for the same reason).
 */
export function assertComposableGroupCallRoster(
  roster: readonly string[],
  video: boolean,
): string[] {
  const parsed = GroupCallRoster.safeParse(roster);
  if (!parsed.success) {
    throw new Error(
      `refusing to compose a small-group call roster: ${parsed.error.issues[0]?.message ?? 'malformed'}`,
    );
  }
  const cap = smallGroupCallParticipantCap(video);
  if (parsed.data.length > cap) {
    throw new Error(
      `refusing to compose a small-group call roster of ${parsed.data.length} with video; the cap is ${cap} (§9.5)`,
    );
  }
  return parsed.data;
}

/**
 * The starter invites someone to a small-group call (§9.4). This IS the offer
 * for that leg — the same sdp/vid/exp contract as `call.offer` — plus the
 * session binding and the roster the starter asserts.
 *
 * The payload lists members, but ROSTER AUTHORITY is `frame.from`,
 * authenticated by the ratchet and never taken from any payload field (the
 * `writerId` rule): the `frame.from` of the ginvite this device ACCEPTS is
 * that session's starter for its whole life, exactly as the `frame.from` of
 * an accepted `grp.new` is that room's owner forever. You accepted a call
 * from S, so you accepted S's roster — and nobody else's
 * (`admitGroupCallRosterDelta`). If S leaves, the session cannot grow; when S
 * hangs up, the call ends for everyone. An explicable limit, stated in the
 * UI.
 *
 * A late joiner also sends `call.ginvite{sid}` to each incumbent — the
 * joiner always offers (§9.4) — and the incumbent admits it against the
 * roster it holds FROM THE STARTER, never against the roster this envelope
 * asserts (`admitGroupCallInvite`).
 */
export const GroupCallInviteEnvelope = z.object({
  tcm: z.literal('call.ginvite'),
  /** Session id, a ULID minted by the starter. Session glare resolves on it:
   * the LOWER sid wins the session, evaluated identically by every device
   * with no coordination. */
  sid: Ulid,
  /** THIS LEG's call id. Each leg is a complete, ordinary 1:1 call, which is
   * the whole §9.1 move — the reducer is never made multi-party. */
  cid: Ulid,
  /** The roster the sender asserts, INCLUDING the sender — the
   * `GroupNewEnvelope.ms` convention. ORDERED: index decides who offers to
   * whom for the initial set (later index offers to earlier), deterministic
   * with no wall clock (§9.4). */
  r: WireGroupCallRoster,
  sdp: Sdp,
  vid: z.boolean(),
  /** Absolute unix ms after which the callee must not ring — the same
   * contract, skew forgiveness and server-age backstop as `call.offer.exp`
   * (§6.4), enforced by `groupCallInviteIsRingable`. */
  exp: z.number().int().positive(),
  /**
   * The session epoch the sender holds (§9.4), so a participant added
   * MID-CALL starts at the epoch the starter is at rather than at 0.
   *
   * Without it a late-added member seeded `se: 0` while the starter was at
   * `k ≥ 1`, and every later authority delta (`se: k+1`) was held forever as
   * "from the future": the next Add was never applied (so the second-added
   * person was refused `busy` by the first), a Remove never took, and the
   * starter's own hangup never ended the call for late joiners.
   *
   * OPTIONAL, and additive: an old build's `z.object` strips the key and
   * seeds 0 as it always did, and an old build's invite (no key) parses here
   * and seeds 0 — the only epoch an original member can be at. Advisory
   * from a non-starter (a joiner's leg offer), authoritative only in the one
   * place a starter's invite is accepted (`ringFresh`).
   */
  se: z.number().int().min(0).optional(),
});
export type GroupCallInviteEnvelope = z.infer<typeof GroupCallInviteEnvelope>;

/**
 * A roster delta: an account is announced IN (§9.4). Two lanes, told apart by
 * the AUTHENTICATED sender and never by anything in the payload:
 *
 *  - from the STARTER — an authority write. Only the starter grows the
 *    roster, ordered by the session epoch `se`.
 *  - from anyone else — a SOVEREIGN self-announce, "I am in": it may name
 *    only its own sender, and only one the starter already named.
 *
 * Everything else is IGNORED, and that ignore is the security property this
 * file exists to enforce: without it, any participant could name an
 * arbitrary account and cause every phone in the call to admit — and dial —
 * a stranger. The same class of vulnerability the glare `peerId` equality
 * check closed at the leg level (`call-machine.ts`), lifted to the session.
 */
export const GroupCallJoinEnvelope = z.object({
  tcm: z.literal('call.gjoin'),
  sid: Ulid,
  /** The account said to be in. WHO may say it is decided by `frame.from`
   * alone — `admitGroupCallRosterDelta`, never this field. */
  m: Ulid,
  /** Session epoch. Minted by the starter, +1 per authority delta; the
   * ginvite's asserted roster is epoch 0. A self-announce echoes the epoch it
   * holds — advisory there, never authoritative. */
  se: z.number().int().min(1),
});
export type GroupCallJoinEnvelope = z.infer<typeof GroupCallJoinEnvelope>;

/**
 * A roster delta: an account is announced OUT — a participant leaving (self,
 * always allowed once admitted) or the starter removing someone (authority).
 * Same two lanes, same admission, same ignore for everyone else: a
 * non-starter must not be able to EJECT a third party any more than dial one
 * in. The starter announcing the starter out ends the session for everyone —
 * §9.4's rule, stated in the UI as "When the person who started the call
 * leaves, the call ends for everyone."
 */
export const GroupCallLeaveEnvelope = z.object({
  tcm: z.literal('call.gleave'),
  sid: Ulid,
  m: Ulid,
  se: z.number().int().min(1),
});
export type GroupCallLeaveEnvelope = z.infer<typeof GroupCallLeaveEnvelope>;

/**
 * A SEPARATE union from `CallEnvelope`, deliberately and permanently: the
 * 1:1 union is byte-for-byte what every already-shipped build parses with,
 * so leaving it untouched is what makes "an old build receiving
 * `call.ginvite` stays silent and rings nothing" a property the
 * tests can hold, rather than a hope about builds we cannot patch.
 */
export const GroupCallEnvelope = z.discriminatedUnion('tcm', [
  GroupCallInviteEnvelope,
  GroupCallJoinEnvelope,
  GroupCallLeaveEnvelope,
]);
export type GroupCallEnvelope = z.infer<typeof GroupCallEnvelope>;

/** The three small-group kinds. All inside the `call.` namespace — that
 * prefix, checked before any parse, is what keeps them silent on builds that
 * predate them. */
export const GROUP_CALL_TCMS = ['call.ginvite', 'call.gjoin', 'call.gleave'] as const;

export type GroupCallTcm = (typeof GROUP_CALL_TCMS)[number];

export function isGroupCallTcm(tcm: string): tcm is GroupCallTcm {
  return (GROUP_CALL_TCMS as readonly string[]).includes(tcm);
}

/**
 * Strict parse; null for anything that is not a well-formed small-group call
 * envelope — the `parseCallEnvelope` contract exactly: null means "not one of
 * these", never "an empty one". Note the asymmetry inside it: an unknown or
 * ill-typed KIND costs the envelope (null), but a malformed ROSTER inside a
 * well-formed ginvite costs only the roster (`WireGroupCallRoster.catch`) —
 * compose-strict, parse-permissive.
 */
export function parseGroupCallEnvelope(body: string): GroupCallEnvelope | null {
  if (!body.startsWith(ENVELOPE_SENTINEL)) return null;
  try {
    const parsed = GroupCallEnvelope.safeParse(JSON.parse(body));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function encodeGroupCallEnvelope(envelope: GroupCallEnvelope): string {
  return JSON.stringify(envelope);
}

/**
 * Whether a small-group invite may still ring — `offerIsRingable`'s two
 * bounds applied to the ginvite, same constants, same reasoning (§6.4): `exp`
 * with skew forgiveness, plus the absolute server-age backstop so a starter
 * with a wildly wrong clock cannot hold a phone ringing.
 */
export function groupCallInviteIsRingable(
  invite: GroupCallInviteEnvelope,
  serverTs: number,
  now: number,
): boolean {
  if (now > invite.exp + OFFER_EXP_SKEW_MS) return false;
  if (now - serverTs > OFFER_MAX_SERVER_AGE_MS) return false;
  return true;
}

/**
 * What a device holds about its live small-group call session, as admission
 * needs to see it. Everything here was established at accept time from
 * ratchet-authenticated inputs; nothing in it is ever overwritten from a
 * payload field.
 */
export interface GroupCallSessionView {
  /** The live session's id — the accepted ginvite's `sid`. */
  sid: string;
  /** The ratchet-authenticated `frame.from` of the ginvite this device
   * ACCEPTED. Written once, the roster authority for the session's life. */
  starterId: string;
  /** The roster held FROM THE STARTER, including the starter. ORDERED —
   * index decides who offers to whom (§9.4). */
  roster: readonly string[];
  /** Epoch of the roster held. The accepted ginvite's roster is epoch 0;
   * authority deltas advance it one at a time. */
  se: number;
  /** Whether this session negotiates video — it decides the cap (§9.5). */
  video: boolean;
  /**
   * Whether the live session has carried media on at least one leg. A
   * session that has CONNECTED is never in glare: glare is two invites
   * crossing in flight, and a call that is already up crossed nothing.
   * Absent reads as false, the only value a view built before this field
   * existed could hold.
   */
  connected?: boolean;
}

export type GroupCallRosterVerdict =
  | { verdict: 'apply' }
  /** An authority delta from the future (`se` beyond the next). Held, never
   * dropped: HERE an authority exists to order deltas, which is exactly why
   * hold-never-drop is right here and was deleted from the room fold. */
  | { verdict: 'hold' }
  | {
      verdict: 'ignore';
      reason:
        | 'wrong_session'
        | 'not_the_starter'
        | 'not_in_roster'
        | 'stale_epoch'
        | 'over_cap';
    };

/**
 * ROSTER AUTHORITY, ENFORCED — the rule this wire exists for.
 *
 * A `call.gjoin` from a non-starter naming an unknown account is IGNORED:
 * without this check, any participant could name an arbitrary account and
 * turn a small-group call into a distributed dialler — every other phone in
 * the call admits, and then dials, a stranger. Authority over who is in the
 * call belongs to the STARTER and to nobody else, exactly as room roster
 * authority belongs to the owner (`grp.roster`'s authority/sovereign split),
 * and exactly as the glare `peerId` equality check keeps a stranger's offer
 * from being auto-answered at the leg level.
 *
 * `from` is the ratchet-authenticated `frame.from` of the frame that carried
 * `delta` — NEVER a payload field (the `writerId` rule,
 * `app/src/envelope.ts:240-244`).
 *
 * The lanes, in the order they are decided:
 *  - wrong `sid`: not this session's delta at all.
 *  - non-starter: may announce only THEMSELF (`m === from`), and only if the
 *    starter already named them. Anything else — a stranger, or even another
 *    legitimate member — is ignored: authority is not divisible.
 *  - starter: epoch-ordered (`se` exactly one ahead applies; behind is a
 *    redelivery and ignored; further ahead is held). Growth past the mode's
 *    cap is refused — a refused authority delta leaves the epoch unconsumed,
 *    so a starter that overruns the cap stalls its own session's roster
 *    lane, which is the correct failure: the alternative is a phone doing
 *    unbounded leg work (§9.5).
 */
export function admitGroupCallRosterDelta(
  session: GroupCallSessionView,
  from: string,
  delta: GroupCallJoinEnvelope | GroupCallLeaveEnvelope,
): GroupCallRosterVerdict {
  if (delta.sid !== session.sid) {
    return { verdict: 'ignore', reason: 'wrong_session' };
  }
  const named = session.roster.includes(delta.m);
  if (from !== session.starterId) {
    // THE CHECK. A non-starter speaks for exactly one account: its own.
    if (delta.m !== from) return { verdict: 'ignore', reason: 'not_the_starter' };
    // And even about itself, only once the starter has named it — otherwise
    // "I am in" from any account with a session would grow every roster.
    if (!named) return { verdict: 'ignore', reason: 'not_in_roster' };
    return { verdict: 'apply' };
  }
  // Authority lane. `se` at or behind the held epoch is a queue redelivery of
  // something already applied; beyond next is held for the gap to fill.
  if (delta.se <= session.se) return { verdict: 'ignore', reason: 'stale_epoch' };
  if (delta.se > session.se + 1) return { verdict: 'hold' };
  if (delta.tcm === 'call.gjoin' && !named) {
    const cap = smallGroupCallParticipantCap(session.video);
    if (session.roster.length + 1 > cap) {
      return { verdict: 'ignore', reason: 'over_cap' };
    }
  }
  return { verdict: 'apply' };
}

export type GroupCallInviteVerdict =
  /** No live session (or this invite wins it): a fresh small-group call. Ring
   * — subject to `groupCallInviteIsRingable`, which is a separate, clocked
   * question this clock-free function refuses to answer. */
  | { verdict: 'ring' }
  /** Session glare, lower `sid` wins: abandon EVERY leg of
   * the live session and admit this invite in its place. */
  | { verdict: 'supersede' }
  /** Same session, sender already in the roster held from the starter: a late
   * joiner's leg. Accepted silently — a new leg, no ring. */
  | { verdict: 'join_leg' }
  /** Refused through the existing path: `call.end{r:'busy'}` (§9.4). */
  | { verdict: 'busy' }
  /** Dropped without an answer. Over the cap fails CLOSED to silence: refusing
   * to ring is the safe side, and the starter's UI already softens a missing
   * `call.ringing` to "they may be offline" — the same honest failure an old
   * build produces. */
  | { verdict: 'ignore'; reason: 'over_cap' };

/**
 * Admission for an inbound `call.ginvite`, clock-free (no wall clock may
 * decide ordering — `app/src/envelope.ts:213-231`; expiry is
 * `groupCallInviteIsRingable`'s separate job).
 *
 * The late-join rule is the roster authority again, from the other side: the
 * incumbent checks the sender against the roster it holds FROM THE STARTER —
 * never against the roster the invite asserts, which on a late join is
 * advisory. A stranger's leg into a live session gets `busy`, not a silent
 * admit, no matter what roster their envelope claims.
 */
export function admitGroupCallInvite(
  live: GroupCallSessionView | null,
  from: string,
  invite: GroupCallInviteEnvelope,
): GroupCallInviteVerdict {
  // §9.5's hard cap, enforced where the roster arrives. A video invite wider
  // than the video cap is from a non-conforming build; fail closed.
  if (invite.vid && invite.r.length > SMALL_GROUP_CALL_MAX_VIDEO_PARTICIPANTS) {
    return { verdict: 'ignore', reason: 'over_cap' };
  }
  if (live === null) return { verdict: 'ring' };
  if (invite.sid === live.sid) {
    return live.roster.includes(from)
      ? { verdict: 'join_leg' }
      : { verdict: 'busy' };
  }
  // Two different sessions: one total order over two ULIDs, evaluated
  // identically by every device, no coordination.
  //
  // BUT ONLY WHEN GLARE IS POSSIBLE. "Lower sid wins" is the tie-break for
  // two honest starters whose invites crossed in flight, and it must not
  // become a way for ANY account to end a call: a ULID's leading characters
  // are a timestamp, so a forged `sid: '0000…'` always sorts first. Two
  // gates, both about whether this can be glare at all:
  //  - the live session has NOT connected. A call already carrying media
  //    crossed nothing; an invite arriving into it is a second call, and
  //    a second call is busy.
  //  - `from` is in the roster held from the starter. Glare is between the
  //    people on the call — a starter who invited the sender, or a member
  //    both starters rostered — never a stranger, whatever sid they mint.
  // A stranger, or anyone into a connected session, is simply busy — the
  // same refusal a same-sid stranger gets, through the same frame.
  if (live.connected === true || !live.roster.includes(from)) {
    return { verdict: 'busy' };
  }
  return invite.sid < live.sid ? { verdict: 'supersede' } : { verdict: 'busy' };
}
