import {
  MAX_ICE_CANDIDATES_PER_ENVELOPE,
  type CallEnvelope,
  type IceCandidate,
} from '@tacendum/shared';
import { CallService, type CallLogRow, type CallMetricSink, type CallNative } from '../src/call/service';

/**
 * The call service executes what the reducer decides.
 *
 * The reducer itself is covered exhaustively in call.machine.test.ts and again
 * through a real server by the CLI gate. What is tested HERE is the
 * translation layer, and specifically the three places where a mechanical
 * translation can still be wrong in a way nothing else notices: filling the
 * SDP template, batching ICE, and refusing to put an unconnectable call on the
 * wire.
 */

const OFFER_SDP = 'v=0\r\na=fingerprint:sha-256 AA:BB\r\na=setup:actpass\r\nOFFER';
const ANSWER_SDP = 'v=0\r\na=fingerprint:sha-256 CC:DD\r\na=setup:active\r\nANSWER';

/**
 * TIME ADVANCES HERE, exactly as production wires it (src/call/index.ts:
 * `now: () => Date.now()`). The previous harness pinned `now()` to a frozen
 * constant while individual tests installed fake timers and advanced them —
 * so timers fired under advanced fake time while the reducer read a clock
 * that never moved. Every duration, startedAt/endedAt, expiry and glare
 * computation in callReducer(..., this.deps.now()) was structurally
 * unobservable, which is the exact split-clock pattern that let the
 * ring-deadline bug ship green in call.controller.test.ts.
 *
 * Modern fake timers own `Date.now()`; the epoch below is pinned with
 * `jest.setSystemTime`, and every `advanceTimersByTimeAsync` moves the
 * timers AND the clock together — deterministic, ordered, and independent
 * of the wall clock. One owner: no test installs or restores timers itself.
 */
const EPOCH = 1_800_000_000_000;
beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(EPOCH);
});

interface Harness {
  service: CallService;
  sent: { peerId: string; envelope: CallEnvelope; urgent: boolean }[];
  logs: CallLogRow[];
  native: jest.Mocked<CallNative>;
  now: () => number;
  metrics: jest.Mocked<CallMetricSink>;
}

function harness(overrides: Partial<CallNative> = {}, metricsOverrides: Partial<CallMetricSink> = {}): Harness {
  const sent: Harness['sent'] = [];
  const logs: CallLogRow[] = [];

  const native = {
    configure: jest.fn().mockResolvedValue(undefined),
    createOffer: jest.fn().mockResolvedValue(OFFER_SDP),
    createAnswer: jest.fn().mockResolvedValue(ANSWER_SDP),
    setRemoteAnswer: jest.fn().mockResolvedValue(undefined),
    addIceCandidates: jest.fn().mockResolvedValue(undefined),
    restartIce: jest.fn().mockResolvedValue(OFFER_SDP),
    close: jest.fn().mockResolvedValue(undefined),
    reportOutgoingCall: jest.fn().mockResolvedValue(undefined),
    reportOutgoingConnected: jest.fn().mockResolvedValue(undefined),
    reportIncomingCall: jest.fn().mockResolvedValue(undefined),
    endCall: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as jest.Mocked<CallNative>;
  const metrics = {
    open: jest.fn().mockResolvedValue(undefined),
    answered: jest.fn().mockResolvedValue(undefined),
    connected: jest.fn().mockResolvedValue(undefined),
    peak: jest.fn().mockResolvedValue(undefined),
    finalize: jest.fn().mockResolvedValue(undefined),
    discard: jest.fn().mockResolvedValue(undefined),
    ...metricsOverrides,
  } as jest.Mocked<CallMetricSink>;

  const service = new CallService({
    native,
    transport: {
      sendCallEnvelope: async (peerId, envelope, opts) => {
        sent.push({ peerId, envelope, urgent: opts.urgent });
      },
    },
    writeLog: async row => void logs.push(row),
    displayNameFor: async id => `name:${id}`,
    now: () => Date.now(),
    metrics,
  });

  created.push(service);
  return { service, sent, logs, native, now: () => Date.now(), metrics };
}

/** Every service started here, so its timers can be released. A live connect
 * timer keeps the jest worker alive for 45 seconds and reports as a leak. */
const created: CallService[] = [];

function candidate(i: number): IceCandidate {
  return { cand: `candidate:${i} 1 udp 100 192.0.2.1 4000 typ host`, mid: '0', idx: 0 };
}

afterEach(() => {
  // Dispose BEFORE restoring real timers: dispose() clears fake timer
  // handles, which needs the fake installation still in place.
  for (const s of created.splice(0)) s.dispose();
  jest.useRealTimers();
});

describe('the SDP template contract', () => {
  it('runs metric failures without blocking the signalling effects', async () => {
    const h = harness({}, { open: jest.fn().mockRejectedValue(new Error('metric failed')) });
    await h.service.dispatch({
      type: 'placeCall', cid: 'C1', peerId: 'P1', video: false, reportId: 'R1',
    });

    expect(h.metrics.open).toHaveBeenCalledWith({
      reportId: 'R1', localId: 'C1', scope: 'direct', media: 'audio', startedAt: EPOCH,
    });
    expect(h.native.createOffer).toHaveBeenCalledWith('C1', false);
    expect(h.sent.some(sent => sent.envelope.tcm === 'call.offer')).toBe(true);
  });

  it('fills the offer with the SDP the native module produced', async () => {
    // The reducer emits `sdp: ''` because it cannot know an SDP. If this
    // translation is wrong the peer receives an empty session description and
    // the call can never connect — with no error anywhere.
    const h = harness();
    await h.service.dispatch({ type: 'placeCall', cid: 'C1', peerId: 'P1', video: false, reportId: null });

    const offer = h.sent.find(s => s.envelope.tcm === 'call.offer');
    expect(offer).toBeTruthy();
    expect(offer!.envelope.tcm === 'call.offer' && offer!.envelope.sdp).toBe(OFFER_SDP);
  });

  it('hands CallKit the call kind, which is what decides the audio route', async () => {
    // A mechanical translation that was NOT being made: the effect carries
    // the call's video-ness and this executor dropped it on the floor, so
    // every outgoing call reached the native side as audio. Downstream that
    // is the audio session category — a video call configured without
    // `.defaultToSpeaker` activates on the earpiece.
    const video = harness();
    await video.service.dispatch({ type: 'placeCall', cid: 'C1', peerId: 'P1', video: true, reportId: null });
    expect(video.native.reportOutgoingCall).toHaveBeenCalledWith('C1', 'name:P1', true);

    const audio = harness();
    await audio.service.dispatch({ type: 'placeCall', cid: 'C2', peerId: 'P1', video: false, reportId: null });
    expect(audio.native.reportOutgoingCall).toHaveBeenCalledWith('C2', 'name:P1', false);
  });

  it('sends the offer urgent — it is the frame that wakes a sleeping phone', async () => {
    const h = harness();
    await h.service.dispatch({ type: 'placeCall', cid: 'C1', peerId: 'P1', video: false, reportId: null });
    const sentOffer = h.sent.find(s => s.envelope.tcm === 'call.offer');
    expect(sentOffer!.urgent).toBe(true);
  });

  it('fills the answer from createAnswer, not from the offer', async () => {
    const h = harness();
    await h.service.dispatch({
      type: 'offerReceived',
      cid: 'C2',
      peerId: 'P1',
      sdp: OFFER_SDP,
      video: false,
      exp: h.now() + 60_000,
      serverTs: h.now(),
    });
    await h.service.dispatch({ type: 'localAccept' });

    const answer = h.sent.find(s => s.envelope.tcm === 'call.answer');
    expect(answer!.envelope.tcm === 'call.answer' && answer!.envelope.sdp).toBe(ANSWER_SDP);
    expect(h.native.createAnswer).toHaveBeenCalledWith('C2', OFFER_SDP, false);
  });

  it('does NOT send an envelope whose SDP could not be produced', async () => {
    // An empty SDP on the wire is a call the peer can never connect. The
    // reducer's contract says a template whose SDP failed must not be sent;
    // the call fails instead, which is loud and recoverable.
    const h = harness({ createOffer: jest.fn().mockRejectedValue(new Error('no camera')) });
    await h.service.dispatch({ type: 'placeCall', cid: 'C1', peerId: 'P1', video: true, reportId: null });

    const offers = h.sent.filter(s => s.envelope.tcm === 'call.offer');
    expect(offers).toHaveLength(0);
    // ...and it ended rather than sitting in a state nothing will ever leave.
    expect(h.native.endCall).toHaveBeenCalled();
  });

  it('never reuses a stale SDP for a later template', async () => {
    // If the pending SDP were not cleared, a failed createAnswer could send
    // the PREVIOUS call's offer as this call's answer — which would hand the
    // peer a fingerprint for a session that no longer exists.
    const h = harness({ createAnswer: jest.fn().mockRejectedValue(new Error('boom')) });
    await h.service.dispatch({ type: 'placeCall', cid: 'C1', peerId: 'P1', video: false, reportId: null });
    await h.service.dispatch({ type: 'endReceived', cid: 'C1', reason: 'decline' });
    await h.service.dispatch({
      type: 'offerReceived',
      cid: 'C2',
      peerId: 'P1',
      sdp: OFFER_SDP,
      video: false,
      exp: h.now() + 60_000,
      serverTs: h.now(),
    });
    await h.service.dispatch({ type: 'localAccept' });

    const answers = h.sent.filter(s => s.envelope.tcm === 'call.answer');
    expect(answers).toHaveLength(0);
  });
});

describe('ICE batching', () => {
  it('packs a full envelope immediately and the remainder after the window', async () => {
    const h = harness();
    await h.service.dispatch({ type: 'placeCall', cid: 'C1', peerId: 'P1', video: false, reportId: null });

    for (let i = 0; i < 12; i++) h.service.queueLocalIce(candidate(i));
    await jest.advanceTimersByTimeAsync(500);
    await h.service.flushIce();

    const ice = h.sent.filter(s => s.envelope.tcm === 'call.ice');
    expect(ice.length).toBeLessThanOrEqual(2);
    const total = ice.reduce(
      (n, s) => n + (s.envelope.tcm === 'call.ice' ? s.envelope.c.length : 0),
      0,
    );
    expect(total).toBe(12);
  });

  it('never exceeds the per-envelope cap', async () => {
    const h = harness();
    await h.service.dispatch({ type: 'placeCall', cid: 'C1', peerId: 'P1', video: false, reportId: null });
    for (let i = 0; i < 34; i++) h.service.queueLocalIce(candidate(i));
    await jest.advanceTimersByTimeAsync(500);
    await h.service.flushIce();

    for (const s of h.sent) {
      if (s.envelope.tcm === 'call.ice') {
        expect(s.envelope.c.length).toBeLessThanOrEqual(MAX_ICE_CANDIDATES_PER_ENVELOPE);
      }
    }
  });

  it('sends ICE non-urgent — only the offer and the end may wake a phone', async () => {
    const h = harness();
    await h.service.dispatch({ type: 'placeCall', cid: 'C1', peerId: 'P1', video: false, reportId: null });
    h.service.queueLocalIce(candidate(0));
    await jest.advanceTimersByTimeAsync(500);

    for (const s of h.sent) {
      if (s.envelope.tcm === 'call.ice') expect(s.urgent).toBe(false);
    }
  });

  it('drops candidates gathered when there is no call', () => {
    // Late candidates after teardown must not resurrect a dead cid.
    const h = harness();
    h.service.queueLocalIce(candidate(0));
    expect(h.sent.filter(s => s.envelope.tcm === 'call.ice')).toHaveLength(0);
  });
});

describe('teardown', () => {
  it('closes the peer connection, ends CallKit, and writes exactly one row', async () => {
    const h = harness();
    await h.service.dispatch({ type: 'placeCall', cid: 'C1', peerId: 'P1', video: false, reportId: null });
    await h.service.dispatch({ type: 'endReceived', cid: 'C1', reason: 'decline' });

    expect(h.native.close).toHaveBeenCalledWith('C1');
    expect(h.native.endCall).toHaveBeenCalledWith('C1', 'decline');
    expect(h.logs).toHaveLength(1);
    expect(h.logs[0]!.reason).toBe('decline');
  });

  it('completes teardown even when one effect throws', async () => {
    // A failed close must not strand the call with CallKit still showing and
    // no log row — the user would see a call that cannot be dismissed.
    const h = harness({ close: jest.fn().mockRejectedValue(new Error('already gone')) });
    await h.service.dispatch({ type: 'placeCall', cid: 'C1', peerId: 'P1', video: false, reportId: null });
    await h.service.dispatch({ type: 'endReceived', cid: 'C1', reason: 'hangup' });

    expect(h.native.endCall).toHaveBeenCalled();
    expect(h.logs).toHaveLength(1);
  });

  it('uses the display name for CallKit, never the raw peer id', async () => {
    const h = harness();
    await h.service.dispatch({
      type: 'offerReceived',
      cid: 'C2',
      peerId: 'P1',
      sdp: OFFER_SDP,
      video: true,
      exp: h.now() + 60_000,
      serverTs: h.now(),
    });
    // Both the handle AND the label are the name now. The full-screen CallKit
    // UI shows the HANDLE; only the banner shows the label, so a handle of
    // `handle:P1` meant the screen someone reads while deciding whether to
    // answer announced a raw id.
    expect(h.native.reportIncomingCall).toHaveBeenCalledWith('C2', 'P1', 'name:P1', 'name:P1', true);
  });
});

describe('the app can make more than one call (found by review)', () => {
  /**
   * `ending` is a TEARDOWN state, and only `teardownComplete` leaves it —
   * which nothing dispatched. The machine therefore sat in `ending` forever
   * with `call` non-null: the full-screen call UI stayed mounted showing
   * "Ending…", its hangup button was a no-op, every later outgoing call got
   * `reportBusy`, and every later incoming offer was auto-answered `busy`.
   * One call per app launch, then unreachable until the app was killed.
   *
   * The machine test asserted the transition EXISTS. Nothing asserted that
   * anything triggers it, and no test placed a second call after a first —
   * which is precisely the shape of a vacuous pass.
   */
  it('returns to idle after a call ends', async () => {
    const h = harness();
    await h.service.dispatch({ type: 'placeCall', cid: 'C1', peerId: 'P1', video: false, reportId: null });
    await h.service.dispatch({ type: 'endReceived', cid: 'C1', reason: 'hangup' });
    expect(h.service.current.name).toBe('idle');
    expect(h.service.current.call).toBeNull();
  });

  it('places a SECOND call after the first one ended', async () => {
    const h = harness();
    await h.service.dispatch({ type: 'placeCall', cid: 'C1', peerId: 'P1', video: false, reportId: null });
    await h.service.dispatch({ type: 'endReceived', cid: 'C1', reason: 'hangup' });

    await h.service.dispatch({ type: 'placeCall', cid: 'C2', peerId: 'P1', video: false, reportId: null });
    expect(h.service.current.name).toBe('outgoing_connecting');
    const offers = h.sent.filter(s => s.envelope.tcm === 'call.offer');
    expect(offers).toHaveLength(2);
  });

  it('rings for an incoming call after an earlier one ended', async () => {
    // The other half of the trap: a phone that had made one call could never
    // be reached again.
    const h = harness();
    await h.service.dispatch({ type: 'placeCall', cid: 'C1', peerId: 'P1', video: false, reportId: null });
    await h.service.dispatch({ type: 'endReceived', cid: 'C1', reason: 'hangup' });

    await h.service.dispatch({
      type: 'offerReceived',
      cid: 'C3',
      peerId: 'P1',
      sdp: OFFER_SDP,
      video: false,
      exp: h.now() + 60_000,
      serverTs: h.now(),
    });
    expect(h.native.reportIncomingCall).toHaveBeenCalled();
    expect(h.service.current.name).toBe('incoming_ringing');
  });

  it('does not carry ICE from a dead call into the next one', async () => {
    // The buffer is stamped with whatever call is current when it flushes, so
    // leftovers would be sent under the NEXT call's cid.
    const h = harness();
    await h.service.dispatch({ type: 'placeCall', cid: 'C1', peerId: 'P1', video: false, reportId: null });
    h.service.queueLocalIce(candidate(0));
    await h.service.dispatch({ type: 'endReceived', cid: 'C1', reason: 'hangup' });
    await h.service.dispatch({ type: 'placeCall', cid: 'C2', peerId: 'P1', video: false, reportId: null });
    await jest.advanceTimersByTimeAsync(500);
    await h.service.flushIce();

    const forSecond = h.sent.filter(
      s => s.envelope.tcm === 'call.ice' && s.envelope.cid === 'C2',
    );
    expect(forSecond).toHaveLength(0);
  });
});

describe('an expired invite', () => {
  it('writes a missed row and never reports an incoming call', async () => {
    // Ringing for a call that ended an hour ago is the one thing the receive
    // path must never do.
    const h = harness();
    await h.service.dispatch({
      type: 'offerReceived',
      cid: 'C9',
      peerId: 'P1',
      sdp: OFFER_SDP,
      video: false,
      exp: h.now() - 600_000,
      serverTs: h.now() - 600_000,
    });

    expect(h.native.reportIncomingCall).not.toHaveBeenCalled();
    expect(h.logs).toHaveLength(1);
    expect(h.logs[0]!.missed).toBe(true);
    expect(h.logs[0]!.reason).toBe('expired');
  });
});

describe('trickle ICE never overtakes the offer it belongs to', () => {
  it('holds candidates gathered before the offer goes out, then sends them behind it', async () => {
    // Native gathers the moment setLocalDescription completes; the offer is
    // composed only after `reportOutgoingCall`, which awaits a name read.
    // With that read slow, a burst of candidates used to reach the transport
    // AHEAD of `call.offer` — and the callee's idle reducer dropped them.
    let releaseName: () => void = () => undefined;
    const held = new Promise<void>(resolve => {
      releaseName = resolve;
    });
    const h = harness();
    (h.service as unknown as { deps: { displayNameFor: (id: string) => Promise<string> } }).deps.displayNameFor =
      async id => {
        await held;
        return `name:${id}`;
      };

    const dispatch = h.service.dispatch({
      type: 'placeCall', cid: 'C1', peerId: 'P1', video: false, reportId: null,
    });
    // createOffer resolved (mock is immediate); the name read is now parked.
    await Promise.resolve();
    await Promise.resolve();
    // A full envelope's worth, which flushes IMMEDIATELY by the batching rule…
    for (let i = 0; i < MAX_ICE_CANDIDATES_PER_ENVELOPE; i++) h.service.queueLocalIce(candidate(i));
    // …and the window elapsing besides.
    await jest.advanceTimersByTimeAsync(500);
    expect(h.sent.filter(s => s.envelope.tcm === 'call.ice')).toHaveLength(0);

    releaseName();
    await dispatch;
    await jest.advanceTimersByTimeAsync(500);
    await h.service.flushIce();

    const tcms = h.sent.map(s => s.envelope.tcm);
    expect(tcms.indexOf('call.offer')).toBeGreaterThanOrEqual(0);
    expect(tcms.indexOf('call.ice')).toBeGreaterThan(tcms.indexOf('call.offer'));
    const total = h.sent.reduce(
      (n, s) => n + (s.envelope.tcm === 'call.ice' ? s.envelope.c.length : 0),
      0,
    );
    expect(total).toBe(MAX_ICE_CANDIDATES_PER_ENVELOPE);
  });

  it('the callee holds its candidates until the answer has gone out', async () => {
    let releaseSend: () => void = () => undefined;
    const held = new Promise<void>(resolve => {
      releaseSend = resolve;
    });
    const sent: { envelope: CallEnvelope }[] = [];
    const native = {
      configure: jest.fn().mockResolvedValue(undefined),
      createOffer: jest.fn().mockResolvedValue(OFFER_SDP),
      createAnswer: jest.fn().mockResolvedValue(ANSWER_SDP),
      setRemoteAnswer: jest.fn().mockResolvedValue(undefined),
      addIceCandidates: jest.fn().mockResolvedValue(undefined),
      restartIce: jest.fn().mockResolvedValue(OFFER_SDP),
      close: jest.fn().mockResolvedValue(undefined),
      reportOutgoingCall: jest.fn().mockResolvedValue(undefined),
      reportOutgoingConnected: jest.fn().mockResolvedValue(undefined),
      reportIncomingCall: jest.fn().mockResolvedValue(undefined),
      endCall: jest.fn().mockResolvedValue(undefined),
    } as unknown as CallNative;
    const service = new CallService({
      native,
      transport: {
        sendCallEnvelope: async (_peerId, envelope) => {
          if (envelope.tcm === 'call.answer') await held;
          sent.push({ envelope });
        },
      },
      writeLog: async () => undefined,
      displayNameFor: async id => `name:${id}`,
      now: () => Date.now(),
    });
    created.push(service);
    await service.dispatch({
      type: 'offerReceived', cid: 'C2', peerId: 'P1', sdp: OFFER_SDP, video: false,
      exp: Date.now() + 60_000, serverTs: Date.now(),
    });
    const accept = service.dispatch({ type: 'localAccept' });
    await Promise.resolve();
    await Promise.resolve();
    service.queueLocalIce(candidate(0));
    await jest.advanceTimersByTimeAsync(500);
    expect(sent.map(s => s.envelope.tcm)).not.toContain('call.ice');

    releaseSend();
    await accept;
    await jest.advanceTimersByTimeAsync(500);
    await service.flushIce();
    const tcms = sent.map(s => s.envelope.tcm);
    expect(tcms.indexOf('call.ice')).toBeGreaterThan(tcms.indexOf('call.answer'));
  });
});
