import {
  callReducer,
  idleState,
  type CallEffect,
  type CallEvent,
  type CallState,
} from '@tacendum/shared';
import { CALL_END_REASONS } from '@tacendum/shared';

/**
 * The call state machine is a PURE reducer — no timers, no
 * native imports, no I/O — precisely so every row of the table, every
 * timeout, and both sides of glare can be proven here, on a laptop, with no
 * device and no camera. If a call misbehaves in the field, the bug is in the
 * adapter or it is in this table, and this file decides which.
 */

const NOW = 1_700_000_000_000;
const CID_A = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const CID_B = '01BRZ3NDEKTSV4RRFFQ69G5FAV'; // lexicographically greater
const PEER = '01PEERZ3NDEKTSV4RRFFQ69G5F';

function drive(
  state: CallState,
  events: CallEvent[],
  now = NOW,
): { state: CallState; effects: CallEffect[] } {
  let current = state;
  let effects: CallEffect[] = [];
  for (const event of events) {
    const step = callReducer(current, event, now);
    current = step.state;
    effects = step.effects;
  }
  return { state: current, effects };
}

const place: Extract<CallEvent, { type: 'placeCall' }> = {
  type: 'placeCall',
  cid: CID_A,
  peerId: PEER,
  video: true,
  reportId: null,
};
type OfferEvent = Extract<CallEvent, { type: 'offerReceived' }>;
const offer = (
  cid = CID_A,
  exp = NOW + 60_000,
  serverTs = NOW,
): OfferEvent => ({
  type: 'offerReceived',
  cid,
  peerId: PEER,
  sdp: 'v=0',
  video: true,
  exp,
  serverTs,
});

function sent(effects: CallEffect[]): CallEffect[] {
  return effects.filter(e => e.type === 'sendEnvelope');
}
function envelopeTcms(effects: CallEffect[]): string[] {
  return sent(effects).map(e => (e as { envelope: { tcm: string } }).envelope.tcm);
}
function effectTypes(effects: CallEffect[]): string[] {
  return effects.map(e => e.type);
}

describe('outgoing call', () => {
  it('opens exactly one authoritative metric before media/signalling effects', () => {
    const reportId = '01REPORTZ3NDEKTSV4RRFFQ69G5FAV';
    const { state, effects } = drive(idleState(), [{ ...place, reportId }]);

    expect(state.call).toMatchObject({ reportId, answeredAt: null, video: true });
    expect(effects[0]).toEqual({
      type: 'openCallMetric',
      reportId,
      localId: CID_A,
      media: 'video',
      startedAt: NOW,
    });
    expect(effects.filter(effect => effect.type === 'openCallMetric')).toHaveLength(1);
  });

  it('treats an explicit outbound null report id as non-authoritative', () => {
    let step = callReducer(idleState(), { ...place, reportId: null }, NOW);
    expect(step.state.call?.reportId).toBeNull();
    expect(step.effects.some(effect => effect.type.endsWith('CallMetric'))).toBe(false);

    // A group leg is non-authoritative for direct reporting but its session
    // needs this fact to emit the aggregate answered lifecycle exactly once.
    step = callReducer(
      step.state,
      { type: 'answerReceived', cid: CID_A, sdp: 'v=0', video: true },
      NOW + 10,
    );
    expect(step.state.call?.answeredAt).toBe(NOW + 10);
    expect(step.effects.some(effect => effect.type === 'answerCallMetric')).toBe(false);
  });

  it('records first answer and connection once, then finalizes at reducer time', () => {
    const reportId = '01REPORTZ3NDEKTSV4RRFFQ69G5FAV';
    let step = callReducer(idleState(), { ...place, reportId }, NOW);
    step = callReducer(step.state, { type: 'answerReceived', cid: CID_A, sdp: 'v=0', video: true }, NOW + 10);
    expect(step.state.call?.answeredAt).toBe(NOW + 10);
    expect(step.effects).toContainEqual({ type: 'answerCallMetric', localId: CID_A, answeredAt: NOW + 10 });

    step = callReducer(step.state, { type: 'iceStateChanged', cid: CID_A, ice: 'connected' }, NOW + 20);
    expect(step.effects).toContainEqual({ type: 'connectCallMetric', localId: CID_A, connectedAt: NOW + 20 });
    step = callReducer(step.state, { type: 'localHangup' }, NOW + 30);
    expect(step.effects[1]).toEqual({
      type: 'finalizeCallMetric', localId: CID_A, reason: 'hangup', endedAt: NOW + 30,
    });
  });

  it('never records direct metrics for incoming calls', () => {
    const { state, effects } = drive(idleState(), [offer()]);
    expect(state.call).toMatchObject({ reportId: null, answeredAt: null });
    expect(effects.some(effect => effect.type.endsWith('CallMetric'))).toBe(false);
  });

  it('idle + placeCall → outgoing_connecting, offers urgently and arms the connect timeout', () => {
    const { state, effects } = drive(idleState(), [place]);
    expect(state.name).toBe('outgoing_connecting');
    expect(state.call?.cid).toBe(CID_A);
    expect(state.call?.direction).toBe('out');
    expect(envelopeTcms(effects)).toContain('call.offer');
    // The urgent bit is what wakes a sleeping phone; nothing else sets it.
    expect(sent(effects).every(e => (e as { urgent: boolean }).urgent)).toBe(true);
    expect(effectTypes(effects)).toContain('createOffer');
    expect(effectTypes(effects)).toContain('reportOutgoingCall');
    expect(
      effects.some(e => e.type === 'startTimer' && e.timer === 'connect'),
    ).toBe(true);
  });

  it('tells CallKit the outgoing call has video, because the audio route follows it', () => {
    // The field was absent, so the executor passed nothing and the native
    // side hard-coded `false`. Two live consequences: CallKit filed every
    // outgoing video call under voice, and the audio session was configured
    // WITHOUT `.defaultToSpeaker` — so a video call you placed came up on the
    // earpiece under a speaker button that already said "on".
    const { effects } = drive(idleState(), [place]); // `place` is a VIDEO call
    const report = effects.find(e => e.type === 'reportOutgoingCall');
    expect(report).toEqual({
      type: 'reportOutgoingCall',
      cid: CID_A,
      peerId: PEER,
      hasVideo: true,
    });
  });

  it('…and says audio when the call is audio, so a voice call keeps the earpiece', () => {
    // The other direction matters as much: `.defaultToSpeaker` on a voice
    // call would put a private conversation on the loudspeaker of a phone
    // held to someone's ear.
    const { effects } = drive(idleState(), [{ ...place, video: false }]);
    const report = effects.find(e => e.type === 'reportOutgoingCall');
    expect(report && 'hasVideo' in report && report.hasVideo).toBe(false);
  });

  it('stamps an expiry the callee can enforce', () => {
    const { effects } = drive(idleState(), [place]);
    const offerEnvelope = sent(effects)[0] as {
      envelope: { tcm: string; exp: number };
    };
    expect(offerEnvelope.envelope.tcm).toBe('call.offer');
    expect(offerEnvelope.envelope.exp).toBe(NOW + 60_000);
  });

  it('outgoing_connecting + ringingReceived → outgoing_ringing and arms the ring timeout', () => {
    const { state, effects } = drive(idleState(), [
      place,
      { type: 'ringingReceived', cid: CID_A },
    ]);
    expect(state.name).toBe('outgoing_ringing');
    expect(effects.some(e => e.type === 'startTimer' && e.timer === 'ring')).toBe(
      true,
    );
  });

  it('answerReceived applies the remote description and flushes ICE buffered before it', () => {
    const { state, effects } = drive(idleState(), [
      place,
      { type: 'iceReceived', cid: CID_A, candidates: [{ cand: 'c1', mid: '0', idx: 0 }] },
      { type: 'ringingReceived', cid: CID_A },
      { type: 'answerReceived', cid: CID_A, sdp: 'v=0', video: true },
    ]);
    // The caller stays in outgoing_connecting until ICE actually connects —
    // "ringing" is a UI state only (the design footnote).
    expect(state.name).toBe('outgoing_connecting');
    expect(effectTypes(effects)).toContain('setRemoteAnswer');
    expect(effectTypes(effects)).toContain('addIceCandidates');
    expect(state.call?.pendingIce).toHaveLength(0);
  });

  it('ICE that arrives before the remote description is buffered, not dropped', () => {
    const { state, effects } = drive(idleState(), [
      place,
      { type: 'iceReceived', cid: CID_A, candidates: [{ cand: 'c1', mid: '0', idx: 0 }] },
    ]);
    expect(state.call?.pendingIce).toHaveLength(1);
    expect(effectTypes(effects)).not.toContain('addIceCandidates');
  });

  it('ICE for a stale cid is discarded without touching the live call', () => {
    const { state, effects } = drive(idleState(), [
      place,
      { type: 'iceReceived', cid: CID_B, candidates: [{ cand: 'x', mid: '0', idx: 0 }] },
    ]);
    expect(state.call?.pendingIce).toHaveLength(0);
    expect(effects).toHaveLength(0);
  });

  it('caps buffered ICE per call so a flood cannot grow state without bound', () => {
    const many: CallEvent[] = Array.from({ length: 12 }, () => ({
      type: 'iceReceived' as const,
      cid: CID_A,
      candidates: Array.from({ length: 10 }, (_, i) => ({
        cand: `c${i}`,
        mid: '0',
        idx: 0,
      })),
    }));
    const { state } = drive(idleState(), [place, ...many]);
    expect(state.call!.pendingIce.length).toBeLessThanOrEqual(40);
  });
});

describe('incoming call', () => {
  it('idle + offerReceived → incoming_ringing, reports to CallKit and answers "ringing"', () => {
    const { state, effects } = drive(idleState(), [offer()]);
    expect(state.name).toBe('incoming_ringing');
    expect(state.call?.direction).toBe('in');
    expect(effectTypes(effects)).toContain('reportIncomingCall');
    expect(envelopeTcms(effects)).toContain('call.ringing');
    expect(effects.some(e => e.type === 'startTimer' && e.timer === 'ring')).toBe(
      true,
    );
  });

  it('does NOT ring for an offer past its expiry — it logs a missed call instead', () => {
    const { state, effects } = drive(idleState(), [
      offer(CID_A, NOW - 120_000),
    ]);
    expect(state.name).toBe('idle');
    expect(effectTypes(effects)).not.toContain('reportIncomingCall');
    expect(envelopeTcms(effects)).not.toContain('call.ringing');
    const log = effects.find(e => e.type === 'writeLog');
    expect(log).toMatchObject({ reason: 'expired', missed: true });
  });

  it('does NOT ring for an offer the server queued too long ago', () => {
    const stale = offer(CID_A, NOW + 60_000, NOW - 120_000);
    const { state, effects } = drive(idleState(), [stale]);
    expect(state.name).toBe('idle');
    expect(effectTypes(effects)).not.toContain('reportIncomingCall');
  });

  it('accepting creates the answer and flushes ICE queued while ringing', () => {
    const { state, effects } = drive(idleState(), [
      offer(),
      { type: 'iceReceived', cid: CID_A, candidates: [{ cand: 'c1', mid: '0', idx: 0 }] },
      { type: 'localAccept' },
    ]);
    expect(state.name).toBe('incoming_answering');
    expect(effectTypes(effects)).toContain('createAnswer');
    expect(envelopeTcms(effects)).toContain('call.answer');
    expect(effectTypes(effects)).toContain('addIceCandidates');
  });

  it('a CallKit answer is the same event as an in-app accept', () => {
    const viaCallKit = drive(idleState(), [offer(), { type: 'callKitAnswered' }]);
    const viaTap = drive(idleState(), [offer(), { type: 'localAccept' }]);
    expect(viaCallKit.state.name).toBe(viaTap.state.name);
    expect(envelopeTcms(viaCallKit.effects)).toEqual(
      envelopeTcms(viaTap.effects),
    );
  });

  it('declining ends the call with `decline` and writes a non-missed row', () => {
    const { state, effects } = drive(idleState(), [
      offer(),
      { type: 'localDecline' },
    ]);
    expect(state.name).toBe('ending');
    const end = sent(effects)[0] as { envelope: { tcm: string; r: string } };
    expect(end.envelope).toMatchObject({ tcm: 'call.end', r: 'decline' });
    expect(effects.find(e => e.type === 'writeLog')).toMatchObject({
      reason: 'decline',
      missed: false,
    });
  });

  it('ringing out ends with `timeout` and writes a MISSED row', () => {
    const { state, effects } = drive(idleState(), [
      offer(),
      { type: 'ringTimeout' },
    ]);
    expect(state.name).toBe('ending');
    expect(effects.find(e => e.type === 'writeLog')).toMatchObject({
      reason: 'timeout',
      missed: true,
    });
  });

  it('a second offer with a different cid while ringing is answered busy, and does not disturb the live call', () => {
    const { state, effects } = drive(idleState(), [offer(CID_A), offer(CID_B)]);
    expect(state.name).toBe('incoming_ringing');
    expect(state.call?.cid).toBe(CID_A);
    const end = sent(effects)[0] as { envelope: { cid: string; r: string } };
    expect(end.envelope).toMatchObject({ cid: CID_B, r: 'busy' });
  });

  it('a redelivered offer for the SAME cid changes nothing (dedupe)', () => {
    const once = drive(idleState(), [offer(CID_A)]);
    const twice = callReducer(once.state, offer(CID_A), NOW);
    expect(twice.state).toEqual(once.state);
    expect(twice.effects).toHaveLength(0);
  });
});

describe('connect, reconnect, teardown', () => {
  const connected = () =>
    drive(idleState(), [
      place,
      { type: 'ringingReceived', cid: CID_A },
      { type: 'answerReceived', cid: CID_A, sdp: 'v=0', video: true },
      { type: 'iceStateChanged', cid: CID_A, ice: 'connected' },
    ]);

  it('ICE connected → connected, cancels the ring/connect timers, reports to CallKit', () => {
    const { state, effects } = connected();
    expect(state.name).toBe('connected');
    expect(state.call?.connectedAt).toBe(NOW);
    expect(effectTypes(effects)).toContain('reportConnected');
    const cancelled = effects.filter(e => e.type === 'cancelTimer');
    expect(cancelled.length).toBeGreaterThan(0);
  });

  it('connected + ICE disconnected → reconnecting with a bounded recovery window', () => {
    const { state, effects } = drive(connected().state, [
      { type: 'iceStateChanged', cid: CID_A, ice: 'disconnected' },
    ]);
    expect(state.name).toBe('reconnecting');
    expect(
      effects.some(e => e.type === 'startTimer' && e.timer === 'reconnect'),
    ).toBe(true);
  });

  it('only the CALLER restarts ICE on a network change — a fixed initiator avoids restart glare', () => {
    const asCaller = drive(connected().state, [
      { type: 'iceStateChanged', cid: CID_A, ice: 'disconnected' },
      { type: 'networkChanged' },
    ]);
    expect(envelopeTcms(asCaller.effects)).toContain('call.restart');

    const calleeConnected = drive(idleState(), [
      offer(),
      { type: 'localAccept' },
      { type: 'iceStateChanged', cid: CID_A, ice: 'connected' },
      { type: 'iceStateChanged', cid: CID_A, ice: 'disconnected' },
      { type: 'networkChanged' },
    ]);
    expect(envelopeTcms(calleeConnected.effects)).not.toContain('call.restart');
  });

  it('recovers to connected when ICE comes back', () => {
    const { state } = drive(connected().state, [
      { type: 'iceStateChanged', cid: CID_A, ice: 'disconnected' },
      { type: 'iceStateChanged', cid: CID_A, ice: 'connected' },
    ]);
    expect(state.name).toBe('connected');
  });

  it('exhausting the reconnect window ends with failed_media', () => {
    const { state, effects } = drive(connected().state, [
      { type: 'iceStateChanged', cid: CID_A, ice: 'disconnected' },
      { type: 'reconnectTimeout' },
    ]);
    expect(state.name).toBe('ending');
    const end = sent(effects)[0] as { envelope: { r: string } };
    expect(end.envelope.r).toBe('failed_media');
  });

  it('never connecting at all ends with failed_ice, not failed_media', () => {
    const { effects } = drive(idleState(), [place, { type: 'connectTimeout' }]);
    const end = sent(effects)[0] as { envelope: { r: string } };
    expect(end.envelope.r).toBe('failed_ice');
  });

  it('hanging up after connecting records a duration; hanging up before does not', () => {
    const after = drive(connected().state, [{ type: 'localHangup' }], NOW + 5_000);
    expect(after.effects.find(e => e.type === 'writeLog')).toMatchObject({
      reason: 'hangup',
      connectedAt: NOW,
    });

    const before = drive(idleState(), [place, { type: 'localHangup' }]);
    const log = before.effects.find(e => e.type === 'writeLog') as {
      connectedAt: number | null;
      reason: string;
    };
    // "0:00" and "never connected" are different facts.
    expect(log.connectedAt).toBeNull();
    expect(log.reason).toBe('cancelled');
  });

  it('tears down the peer connection and CallKit on every terminal path', () => {
    for (const terminal of [
      { type: 'localHangup' } as CallEvent,
      { type: 'endReceived', cid: CID_A, reason: 'hangup' } as CallEvent,
      { type: 'callKitEnded' } as CallEvent,
    ]) {
      const { state, effects } = drive(connected().state, [terminal]);
      expect(state.name).toBe('ending');
      expect(effectTypes(effects)).toContain('closePeerConnection');
      expect(effectTypes(effects)).toContain('endCallKit');
    }
  });

  it('returns to idle once teardown completes', () => {
    const { state } = drive(connected().state, [
      { type: 'localHangup' },
      { type: 'teardownComplete' },
    ]);
    expect(state).toEqual(idleState());
  });

  it('a mid-call media toggle updates the peer\'s track state without changing state', () => {
    const { state } = drive(connected().state, [
      { type: 'mediaReceived', cid: CID_A, audio: true, video: false },
    ]);
    expect(state.name).toBe('connected');
    expect(state.call?.peerVideo).toBe(false);
    expect(state.call?.peerAudio).toBe(true);
  });
});

describe('every CallEndReason produces a coherent terminal', () => {
  it.each(CALL_END_REASONS)('handles endReceived(%s)', reason => {
    const start = drive(idleState(), [place]).state;
    const { state, effects } = drive(start, [
      { type: 'endReceived', cid: CID_A, reason },
    ]);
    expect(state.name).toBe('ending');
    // glare_lost is deliberately invisible: it is bookkeeping, not a call.
    const log = effects.find(e => e.type === 'writeLog');
    if (reason === 'glare_lost') expect(log).toBeUndefined();
    else expect(log).toMatchObject({ reason });
    // A received end never echoes another end back — that would ping-pong.
    expect(envelopeTcms(effects)).not.toContain('call.end');
  });
});

describe('glare — simultaneous invites', () => {
  it('the larger cid wins, and the smaller-cid side yields to the winner', () => {
    // We placed CID_A; their offer carries the greater CID_B, so we yield.
    const { state, effects } = drive(idleState(), [place, offer(CID_B)]);
    expect(state.call?.cid).toBe(CID_B);
    expect(state.call?.direction).toBe('in');
    // We had already tapped Call, so we clearly want to talk to this person:
    // auto-accept rather than ring.
    expect(state.name).toBe('incoming_answering');
    const ends = sent(effects).filter(
      e => (e as { envelope: { tcm: string } }).envelope.tcm === 'call.end',
    ) as { envelope: { cid: string; r: string } }[];
    expect(ends[0].envelope).toMatchObject({ cid: CID_A, r: 'glare_lost' });
  });

  it('the larger-cid side keeps its own call and rejects the loser', () => {
    const placeB: CallEvent = { ...place, cid: CID_B };
    const { state, effects } = drive(idleState(), [placeB, offer(CID_A)]);
    expect(state.name).toBe('outgoing_connecting');
    expect(state.call?.cid).toBe(CID_B);
    const end = sent(effects)[0] as { envelope: { cid: string; r: string } };
    expect(end.envelope).toMatchObject({ cid: CID_A, r: 'glare_lost' });
  });

  it('both sides compute the SAME winner from the same two ids, over 10 000 pairs', () => {
    // Symmetry is the whole point: no round trip, no tiebreak negotiation.
    let seed = 12345;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const ULID_CHARS = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    const ulid = () =>
      Array.from({ length: 26 }, () =>
        ULID_CHARS[Math.floor(rand() * ULID_CHARS.length)],
      ).join('');

    for (let i = 0; i < 10_000; i++) {
      const mine = ulid();
      const theirs = ulid();
      if (mine === theirs) continue;

      // Me: I placed `mine`, their offer carries `theirs`.
      const me = drive(idleState(), [
        { type: 'placeCall', cid: mine, peerId: PEER, video: true, reportId: null },
        { ...(offer(theirs) as object) } as CallEvent,
      ]);
      // Them: they placed `theirs`, my offer carries `mine`.
      const them = drive(idleState(), [
        { type: 'placeCall', cid: theirs, peerId: PEER, video: true, reportId: null },
        { ...(offer(mine) as object) } as CallEvent,
      ]);

      const expected = mine > theirs ? mine : theirs;
      expect(me.state.call?.cid).toBe(expected);
      expect(them.state.call?.cid).toBe(expected);
      // Exactly one side ends up incoming and one outgoing — never both the same.
      expect(me.state.call?.direction).not.toBe(them.state.call?.direction);
    }
  });
});

describe('refusals and robustness', () => {
  it('placing a call while one is live is refused without sending anything', () => {
    const busy = drive(idleState(), [place]).state;
    const { state, effects } = drive(busy, [
      { type: 'placeCall', cid: CID_B, peerId: PEER, video: false, reportId: null },
    ]);
    expect(state).toEqual(busy);
    expect(sent(effects)).toHaveLength(0);
    expect(effectTypes(effects)).toContain('reportBusy');
  });

  it('ignores every event addressed to a cid we are not handling', () => {
    const live = drive(idleState(), [place]).state;
    for (const event of [
      { type: 'answerReceived', cid: CID_B, sdp: 'v=0', video: true },
      { type: 'endReceived', cid: CID_B, reason: 'hangup' },
      { type: 'ringingReceived', cid: CID_B },
      { type: 'mediaReceived', cid: CID_B, audio: false, video: false },
      { type: 'restartReceived', cid: CID_B, sdp: 'v=0' },
    ] as CallEvent[]) {
      const step = callReducer(live, event, NOW);
      expect(step.state).toEqual(live);
      expect(step.effects).toHaveLength(0);
    }
  });

  it('ignores call events entirely while idle', () => {
    for (const event of [
      { type: 'answerReceived', cid: CID_A, sdp: 'v=0', video: true },
      { type: 'iceReceived', cid: CID_A, candidates: [] },
      { type: 'ringTimeout' },
      { type: 'localHangup' },
      { type: 'iceStateChanged', cid: CID_A, ice: 'connected' },
    ] as CallEvent[]) {
      const step = callReducer(idleState(), event, NOW);
      expect(step.state.name).toBe('idle');
      expect(step.effects).toHaveLength(0);
    }
  });

  it('a timeout that fires after the call already ended does nothing', () => {
    const ended = drive(idleState(), [place, { type: 'localHangup' }]).state;
    const step = callReducer(ended, { type: 'ringTimeout' }, NOW);
    expect(step.effects).toHaveLength(0);
  });

  it('app termination ends the call so the peer is not left listening to nothing', () => {
    const live = drive(idleState(), [place]).state;
    const { effects } = drive(live, [{ type: 'appTerminating' }]);
    expect(envelopeTcms(effects)).toContain('call.end');
    expect(effectTypes(effects)).toContain('closePeerConnection');
  });

  it('a CallKit audio-activation failure fails the call loudly rather than silently', () => {
    const live = drive(idleState(), [offer(), { type: 'localAccept' }]).state;
    const { state, effects } = drive(live, [
      { type: 'callKitFailedToActivateAudio' },
    ]);
    expect(state.name).toBe('ending');
    const end = sent(effects)[0] as { envelope: { r: string } };
    expect(end.envelope.r).toBe('failed_media');
  });

  it('is pure: the same input twice yields identical output and never mutates its input', () => {
    const live = drive(idleState(), [place]).state;
    const snapshot = JSON.parse(JSON.stringify(live));
    const first = callReducer(live, { type: 'ringingReceived', cid: CID_A }, NOW);
    const second = callReducer(live, { type: 'ringingReceived', cid: CID_A }, NOW);
    expect(first).toEqual(second);
    expect(live).toEqual(snapshot);
  });
});

describe('the offer SDP survives until the accept (found at V5)', () => {
  /**
   * REGRESSION. `acceptIncoming` emitted `createAnswer` with `remoteSdp: ''`
   * because CallContext never kept the offer, so no answer could ever be
   * produced. Invisible for two phases: the reducer tests asserted the effect
   * was EMITTED, and nothing existed yet that had to act on it. It surfaced
   * the moment an executor did.
   *
   * The accept can arrive long after the offer — from a lock screen, after a
   * cold launch — so the SDP has to live in the call's state, not in whatever
   * handled the envelope.
   */
  it('gives createAnswer the SDP the offer arrived with', () => {
    const offer = 'v=0\r\na=fingerprint:sha-256 AA:BB\r\na=setup:actpass\r\nOFFERBODY';
    const t = 1_800_000_000_000;
    const rung = callReducer(
      idleState(),
      {
        type: 'offerReceived',
        cid: '01J0000000000000000000000B',
        peerId: 'peer-1',
        sdp: offer,
        video: false,
        exp: t + 60_000,
        serverTs: t,
      },
      t,
    );
    const accepted = callReducer(rung.state, { type: 'localAccept' }, t + 1000);
    const createAnswer = accepted.effects.find(e => e.type === 'createAnswer');
    expect(createAnswer).toBeTruthy();
    expect(createAnswer!.type === 'createAnswer' && createAnswer!.remoteSdp).toBe(offer);
  });

  it('carries it through a lost glare, where the accept is automatic', () => {
    const t = 1_800_000_000_000;
    const theirOffer = 'v=0\r\na=fingerprint:sha-256 CC:DD\r\nTHEIRS';
    // Ours must lose, so theirs has to sort higher.
    const ourCid = '01J0000000000000000000000A';
    const theirCid = '01J0000000000000000000000Z';
    const placed = callReducer(
      idleState(),
      { type: 'placeCall', cid: ourCid, peerId: 'peer-1', video: false, reportId: null },
      t,
    );
    const glare = callReducer(
      placed.state,
      {
        type: 'offerReceived',
        cid: theirCid,
        peerId: 'peer-1',
        sdp: theirOffer,
        video: false,
        exp: t + 60_000,
        serverTs: t,
      },
      t + 10,
    );
    const createAnswer = glare.effects.find(e => e.type === 'createAnswer');
    // The glare loser must answer the winner.
    expect(createAnswer).toBeTruthy();
    expect(createAnswer!.type === 'createAnswer' && createAnswer!.remoteSdp).toBe(theirOffer);
  });
});

describe('a restart cannot reach into a phone that has not answered', () => {
  /**
   * FOUND BY REVIEW, security-relevant.
   *
   * `restartReceived` was accepted in any non-`ending` state, including
   * `incoming_ringing`. A caller could send an offer and then immediately a
   * restart with the same cid: the reducer emitted `createAnswer`, the
   * executor built the peer connection and added local media, and the CAMERA
   * started and ICE gathering began — sending the callee's host candidates,
   * i.e. their IP addresses, to the caller.
   *
   * All while the phone was still ringing and nobody had agreed to anything.
   * The microphone was safe because the audio unit waits for CallKit's
   * didActivate; the camera had no equivalent gate.
   */
  const RT = 1_800_000_000_000;
  const RCID = '01J0000000000000000000000B';

  function ringingState(): CallState {
    return callReducer(
      idleState(),
      {
        type: 'offerReceived',
        cid: RCID,
        peerId: 'peer-1',
        sdp: 'v=0\r\nOFFER',
        video: true,
        exp: RT + 60_000,
        serverTs: RT,
      },
      RT,
    ).state;
  }

  it('ignores a restart while the phone is still ringing', () => {
    const step = callReducer(
      ringingState(),
      { type: 'restartReceived', cid: RCID, sdp: 'v=0\r\nEVIL' },
      RT,
    );
    expect(step.effects).toHaveLength(0);
  });

  it('starts no camera and gathers no candidates before the answer', () => {
    // The concrete harm: `createAnswer` is what causes addLocalMedia.
    const step = callReducer(
      ringingState(),
      { type: 'restartReceived', cid: RCID, sdp: 'v=0\r\nEVIL' },
      RT,
    );
    expect(step.effects.some(e => e.type === 'createAnswer')).toBe(false);
  });

  it('still honours a restart once the call is connected', () => {
    // The control. A gate that rejected every restart would pass both tests
    // above and break recovery from every network change.
    const connected = callReducer(
      callReducer(ringingState(), { type: 'localAccept' }, RT).state,
      { type: 'iceStateChanged', cid: RCID, ice: 'connected' },
      RT,
    ).state;
    const step = callReducer(
      connected,
      { type: 'restartReceived', cid: RCID, sdp: 'v=0\r\nNEW' },
      RT,
    );
    expect(step.effects.some(e => e.type === 'createAnswer')).toBe(true);
  });
});

describe('the two effects nobody consumed (found by review)', () => {
  const GT = 1_800_000_000_000;

  it('releases OUR CallKit call when we lose a glare', () => {
    // Ending only the adopted call minted a fresh UUID for a call CallKit had
    // never seen, leaving the original alive: a system-level active-call UI
    // that no in-app action could dismiss, surviving until the app was killed.
    const ourCid = '01J0000000000000000000000A';
    const theirCid = '01J0000000000000000000000Z';
    const placed = callReducer(
      idleState(),
      { type: 'placeCall', cid: ourCid, peerId: 'peer-1', video: false, reportId: null },
      GT,
    );
    const glare = callReducer(
      placed.state,
      {
        type: 'offerReceived',
        cid: theirCid,
        peerId: 'peer-1',
        sdp: 'v=0\r\nTHEIRS',
        video: false,
        exp: GT + 60_000,
        serverTs: GT,
      },
      GT + 10,
    );

    const ended = glare.effects.filter(e => e.type === 'endCallKit');
    expect(ended.some(e => e.type === 'endCallKit' && e.cid === ourCid)).toBe(true);
    // ...and the adopted call is introduced to CallKit, so later effects
    // naming it address a UUID CallKit actually knows.
    expect(
      glare.effects.some(e => e.type === 'reportIncomingCall' && e.cid === theirCid),
    ).toBe(true);
  });

  it('SENDS the answer it creates for an ICE restart', () => {
    // The answer was produced, stored, and consumed by nothing — so the peer
    // got no reply, the restart never completed, and every mid-call network
    // change ended in failed_media after the reconnect window.
    const cid = '01J0000000000000000000000C';
    const ringing = callReducer(
      idleState(),
      {
        type: 'offerReceived',
        cid,
        peerId: 'peer-1',
        sdp: 'v=0\r\nOFFER',
        video: false,
        exp: GT + 60_000,
        serverTs: GT,
      },
      GT,
    ).state;
    const connected = callReducer(
      callReducer(ringing, { type: 'localAccept' }, GT).state,
      { type: 'iceStateChanged', cid, ice: 'connected' },
      GT,
    ).state;

    const step = callReducer(connected, { type: 'restartReceived', cid, sdp: 'v=0\r\nNEW' }, GT);
    const sent = step.effects.filter(e => e.type === 'sendEnvelope');
    expect(sent.some(e => e.type === 'sendEnvelope' && e.envelope.tcm === 'call.answer')).toBe(
      true,
    );
    // The template contract: an empty sdp the executor fills from createAnswer.
    const answer = sent.find(
      e => e.type === 'sendEnvelope' && e.envelope.tcm === 'call.answer',
    );
    expect(answer!.type === 'sendEnvelope' && answer!.envelope.tcm === 'call.answer' && answer!.envelope.sdp).toBe('');
  });
});

describe('glare is between TWO PARTIES, not any two calls', () => {
  const OTHER = '01OTHERZ3NDEKTSV4RRFFQ69G5';

  it('treats a stranger’s offer during a dial as busy, not as glare', () => {
    // The glare branch AUTO-ANSWERS the winner — that is the point of it, and
    // it is safe only because both cids belong to the same conversation. With
    // no peer check, anyone whose offer landed while you were dialling someone
    // else won on a cid comparison and was accepted: no ring, no prompt, no
    // chance to decline, camera and microphone live to a person you were not
    // calling. CID_B is chosen deliberately — it is the greater id, so it
    // WOULD have won.
    const { state, effects } = drive(idleState(), [
      place,
      { ...offer(CID_B), peerId: OTHER },
    ]);

    expect(state.name).toBe('outgoing_connecting');
    expect(state.call?.cid).toBe(CID_A);
    expect(state.call?.peerId).toBe(PEER);
    // Nothing was answered: no answer built, so no camera and no local media.
    expect(effectTypes(effects)).not.toContain('createAnswer');
    const end = sent(effects)[0] as { envelope: { cid: string; r: string } };
    expect(end.envelope).toMatchObject({ cid: CID_B, r: 'busy' });
  });

  it('still resolves glare normally when it IS the same person', () => {
    // The guard must not cost the case it is guarding.
    const { state } = drive(idleState(), [place, offer(CID_B)]);
    expect(state.name).toBe('incoming_answering');
    expect(state.call?.cid).toBe(CID_B);
  });
});

describe('ICE restart completes end to end', () => {
  it('the restarting side APPLIES the answer it asked for', () => {
    // The callee's half was fixed earlier — it now sends `call.answer` in
    // reply to a restart. The caller then threw that answer away, because
    // `answerReceived` was gated to the two outgoing states and a restarting
    // call sits in `reconnecting`. Recovery could not complete from either
    // end, so every mid-call network change still died at the 30-second
    // reconnect timeout.
    const { state: connected } = drive(idleState(), [
      place,
      { type: 'answerReceived', cid: CID_A, sdp: 'v=0/answer', video: true },
      { type: 'iceStateChanged', cid: CID_A, ice: 'connected' },
    ]);
    expect(connected.name).toBe('connected');

    const { state: dropped } = drive(connected, [
      { type: 'iceStateChanged', cid: CID_A, ice: 'disconnected' },
    ]);
    expect(dropped.name).toBe('reconnecting');

    const { state, effects } = drive(dropped, [
      { type: 'answerReceived', cid: CID_A, sdp: 'v=0/restarted', video: true },
    ]);

    const applied = effects.find(e => e.type === 'setRemoteAnswer');
    expect(applied).toMatchObject({ cid: CID_A, sdp: 'v=0/restarted' });
    // Still reconnecting — ICE decides when it is connected again, and an
    // incoming call that lost ICE must not be relabelled as outgoing.
    expect(state.name).toBe('reconnecting');
    expect(state.call?.direction).toBe('out');
  });

  it('ignores an unsolicited answer on a healthy call', () => {
    const { state: connected } = drive(idleState(), [
      place,
      { type: 'answerReceived', cid: CID_A, sdp: 'v=0/answer', video: true },
      { type: 'iceStateChanged', cid: CID_A, ice: 'connected' },
    ]);
    const { effects } = drive(connected, [
      { type: 'answerReceived', cid: CID_A, sdp: 'v=0/again', video: true },
    ]);
    expect(effectTypes(effects)).not.toContain('setRemoteAnswer');
  });
});

describe('"Answer without video"', () => {
  it('answers with the camera OFF, and tells the peer so', () => {
    // Both buttons on the incoming screen called the same accept(), and the
    // reducer had no way to express the choice — so the camera came on for
    // someone who had just declined it. `withVideo` is what drives
    // addLocalMedia natively, so it is the only thing that actually gates the
    // camera.
    const { state, effects } = drive(idleState(), [
      offer(CID_A),
      { type: 'localAccept', video: false },
    ]);

    expect(state.name).toBe('incoming_answering');
    expect(effects.find(e => e.type === 'createAnswer')).toMatchObject({
      withVideo: false,
    });
    const answer = sent(effects)[0] as { envelope: { tcm: string; vid: boolean } };
    expect(answer.envelope).toMatchObject({ tcm: 'call.answer', vid: false });
    // The context follows, so the UI does not offer a camera toggle for a
    // call that negotiated no video m-line.
    expect(state.call?.video).toBe(false);
  });

  it('accepts as offered by default, and cannot ADD video to an audio call', () => {
    const withVideo = drive(idleState(), [offer(CID_A), { type: 'localAccept' }]);
    expect(withVideo.effects.find(e => e.type === 'createAnswer')).toMatchObject({
      withVideo: true,
    });

    const audioOnly = drive(idleState(), [
      { ...offer(CID_A), video: false },
      { type: 'localAccept', video: true },
    ]);
    expect(audioOnly.effects.find(e => e.type === 'createAnswer')).toMatchObject({
      withVideo: false,
    });
  });
});

describe('losing ICE actually starts the recovery', () => {
  function connectedOut() {
    return drive(idleState(), [
      place,
      { type: 'answerReceived', cid: CID_A, sdp: 'v=0/answer', video: true },
      { type: 'iceStateChanged', cid: CID_A, ice: 'connected' },
    ]).state;
  }

  it('the caller restarts ICE the moment the connection drops', () => {
    // `networkChanged` was the only trigger for a restart, and nothing in the
    // app dispatches it — there is no network observer and no dependency that
    // provides one. So a call that lost ICE waited out the full 30 seconds and
    // died as `failed_media`, with the recovery code present, tested, and
    // unreachable.
    const { state, effects } = drive(connectedOut(), [
      { type: 'iceStateChanged', cid: CID_A, ice: 'disconnected' },
    ]);

    expect(state.name).toBe('reconnecting');
    expect(effectTypes(effects)).toContain('restartIce');
    expect(envelopeTcms(effects)).toContain('call.restart');
    // The reconnect deadline is still armed: a restart that does not take must
    // still end the call rather than hang in `reconnecting` forever.
    expect(effects).toContainEqual(
      expect.objectContaining({ type: 'startTimer', timer: 'reconnect' }),
    );
  });

  it('the CALLEE restarts nothing — a fixed initiator is what avoids restart glare', () => {
    const connectedIn = drive(idleState(), [
      offer(CID_A),
      { type: 'localAccept' },
      { type: 'iceStateChanged', cid: CID_A, ice: 'connected' },
    ]).state;
    expect(connectedIn.call?.direction).toBe('in');

    const { state, effects } = drive(connectedIn, [
      { type: 'iceStateChanged', cid: CID_A, ice: 'disconnected' },
    ]);

    expect(state.name).toBe('reconnecting');
    expect(effectTypes(effects)).not.toContain('restartIce');
    expect(envelopeTcms(effects)).not.toContain('call.restart');
  });
});
