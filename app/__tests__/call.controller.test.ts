import type { CallEnvelope, IceServer } from '@tacendum/shared';
import {
  CallController,
  type CallControllerDeps,
  type CallNativeBridge,
} from '../src/call/controller';
import type { CallLogRow } from '../src/call/service';

/**
 * cids are real ULIDs throughout: the controller parses every inbound envelope
 * through the shipping zod schema, which validates them. A placeholder id is
 * rejected, and the test then silently exercises the rejection path instead of
 * the routing it meant to check.
 *
 * The controller is the wiring: messaging in, reducer in
 * the middle, native module out. Nothing here decides protocol — that is the
 * reducer, tested exhaustively elsewhere — so what these tests cover is the
 * set of ways wiring fails silently: an envelope routed to the wrong event, a
 * relay credential fetched too late to matter, a listener that throws and
 * takes message delivery down with it.
 */

const OFFER_SDP = 'v=0\r\na=fingerprint:sha-256 AA:BB\r\nOFFER';
const ANSWER_SDP = 'v=0\r\na=fingerprint:sha-256 CC:DD\r\nANSWER';
const SERVERS: IceServer[] = [
  { urls: ['stun:turn.tacendum.com:3478'] },
  { urls: ['turn:turn.tacendum.com:3478?transport=udp'], username: 'u', credential: 'c' },
];

/**
 * TIME ADVANCES HERE, exactly as production wires it (src/call/index.ts:
 * `now: () => Date.now()`). The previous harness pinned `now()` to a frozen
 * constant, which structurally hid every deadline-arithmetic defect in the
 * controller: `Math.max(0, deadline - now)` cannot observe a past deadline
 * when `now` never moves, and 1989 green tests missed a release-blocking
 * stale-deadline burn because of it.
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
  controller: CallController;
  sent: { peerId: string; envelope: CallEnvelope; urgent: boolean }[];
  logs: CallLogRow[];
  native: jest.Mocked<CallNativeBridge>;
  deliver: (peerId: string, envelope: unknown, ts?: number) => void;
  /** Simulate messaging reporting that a frame from `peerId` resolved as
   * something that can never ring. */
  verdict: (peerId: string, verdict: 'not_call' | 'undecryptable') => void;
  turnCalls: () => number;
  clock: number;
  /** Test seam: make specific outbound envelopes hang until released. */
  gateSend: (pred: (e: CallEnvelope) => boolean) => () => void;
  /** Test seam: make specific outbound envelopes REJECT, the way a transient
   * send failure does in production. The attempt is still recorded in `sent`
   * — messaging tried, and it is the throw that is under test. */
  failSend: (pred: (e: CallEnvelope) => boolean) => void;
}

function harness(over: Partial<CallControllerDeps> = {}): Harness {
  const { mintReportId = async () => 'REPORT-TEST', ...depsOver } = over;
  const sent: Harness['sent'] = [];
  const logs: CallLogRow[] = [];
  let listener: ((p: string, e: unknown, m: { msgId: string; ts: number }) => void) | null = null;
  let verdictListener:
    | ((p: string, v: 'not_call' | 'undecryptable') => void)
    | null = null;
  let turns = 0;
  const clock = EPOCH;

  let sendGate: { pred: (e: CallEnvelope) => boolean; waiters: (() => void)[] } | null = null;
  let sendFail: ((e: CallEnvelope) => boolean) | null = null;
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
    updateIncomingCallDisplay: jest.fn().mockResolvedValue(undefined),
    dismissPendingIncomingCall: jest.fn().mockResolvedValue(undefined),
    endCall: jest.fn().mockResolvedValue(undefined),
    registerForVoipPush: jest.fn().mockResolvedValue(undefined),
    getVoipToken: jest.fn().mockResolvedValue('token'),
  } as unknown as jest.Mocked<CallNativeBridge>;

  const controller = new CallController({
    messaging: {
      onEnvelope: l => {
        listener = l;
        return () => {
          listener = null;
        };
      },
      onFrameVerdict: l => {
        verdictListener = l;
        return () => {
          verdictListener = null;
        };
      },
      sendCallEnvelope: async (peerId, envelope, opts) => {
        sent.push({ peerId, envelope, urgent: opts.urgent === true });
        if (sendGate && sendGate.pred(envelope)) {
          await new Promise<void>(r => sendGate!.waiters.push(r));
        }
        if (sendFail?.(envelope)) throw new Error('send failed');
      },
    },
    native,
    fetchTurnCredentials: async () => {
      turns += 1;
      return { iceServers: SERVERS, ttlSeconds: 12 * 3600 };
    },
    writeLog: async row => void logs.push(row),
    displayNameFor: async id => `name:${id}`,
    relayOnly: () => false,
    now: () => Date.now(),
    mintReportId,
    ...depsOver,
  });

  created.push(controller);
  return {
    controller,
    sent,
    logs,
    native,
    deliver: (peerId, envelope, ts = Date.now()) =>
      listener?.(peerId, envelope, { msgId: 'm1', ts }),
    verdict: (peerId, verdict) => verdictListener?.(peerId, verdict),
    turnCalls: () => turns,
    clock,
    gateSend: pred => {
      const gate = { pred, waiters: [] as (() => void)[] };
      sendGate = gate;
      return () => {
        sendGate = null;
        for (const w of gate.waiters.splice(0)) w();
      };
    },
    failSend: pred => {
      sendFail = pred;
    },
  };
}

/** Controllers hold the service's real timers; release them or the worker
 * cannot exit and jest reports it as an unrelated-looking leak. */
const created: CallController[] = [];
afterEach(() => {
  // Stop BEFORE restoring real timers: stop() clears fake timer handles,
  // which needs the fake installation still in place.
  for (const c of created.splice(0)) c.stop();
  jest.useRealTimers();
});

function offer(cid: string, exp: number): CallEnvelope {
  return { tcm: 'call.offer', cid, sdp: OFFER_SDP, vid: false, exp };
}

/**
 * The i-th distinct cid, as a REAL 26-character Crockford-base32 ULID.
 *
 * Hand-rolled ids are the reason this file opens with a warning about them:
 * one that is 25 characters, or that uses I/L/O/U, looks right in a diff and
 * is rejected by the envelope schema before routing, so the test quietly
 * exercises the rejection path instead of the behaviour it names.
 */
function cidFor(i: number): string {
  const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let suffix = '';
  let n = i;
  for (let k = 0; k < 4; k++) {
    suffix = CROCKFORD[n % 32] + suffix;
    n = Math.floor(n / 32);
  }
  return `01J${'0'.repeat(19)}${suffix}`;
}

describe('a decline made against the push placeholder', () => {
  // Declining the CallKit placeholder emits callKitEnded with the SYNTHETIC
  // cid — no reducer state addresses it, so the decline used to evaporate:
  // the caller rang out their full timer, and seconds later the decrypted
  // offer RANG THE CALLEE AGAIN for a call they had just refused.

  it('sends the decline frame and does NOT ring again when the offer arrives', async () => {
    const h = harness();
    await h.controller.start();

    // The push rings under a synthetic cid for this peer…
    h.controller.notePushRing('synthetic-cid-1', 'P1');
    // …and the person declines it before anything decrypts.
    await h.controller.onCallKitEnd('synthetic-cid-1');

    // The offer decrypts moments later.
    h.deliver('P1', offer(cidFor(70), h.clock + 60_000));
    await h.controller.whenIdle();

    // No second ring, the caller is TOLD, the pending ring is cleared, and
    // the person can see the call happened.
    expect(h.native.reportIncomingCall).not.toHaveBeenCalled();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatchObject({
      peerId: 'P1',
      envelope: { tcm: 'call.end', r: 'decline' },
      urgent: true,
    });
    expect(h.native.dismissPendingIncomingCall).toHaveBeenCalledWith('P1', 'declined', '');
    expect(h.logs).toHaveLength(1);
    expect(h.logs[0]).toMatchObject({ peerId: 'P1', reason: 'decline', missed: true });
  });

  it('is consumed once — the SAME peer can ring again afterwards', async () => {
    const h = harness();
    await h.controller.start();
    h.controller.notePushRing('synthetic-cid-2', 'P1');
    await h.controller.onCallKitEnd('synthetic-cid-2');
    h.deliver('P1', offer(cidFor(71), h.clock + 60_000));
    await h.controller.whenIdle();
    expect(h.native.reportIncomingCall).not.toHaveBeenCalled();

    // A fresh call from the same person is a fresh question.
    h.deliver('P1', offer(cidFor(72), h.clock + 60_000));
    await h.controller.whenIdle();

    expect(h.native.reportIncomingCall).toHaveBeenCalledTimes(1);
  });

  it('a decline recorded MID-processing declines THIS call and never the next', async () => {
    // The person declines the placeholder while the offer is mid-decrypt —
    // after the early tombstone consult. That decline belongs to the call
    // being processed: it is honoured immediately, consumed, and offer C
    // from the same peer a moment later rings normally.
    const h = harness();
    await h.controller.start();

    // The mid-processing decline is simulated at the display-update await:
    // by then the early consult has passed and the call is adopted.
    h.native.updateIncomingCallDisplay.mockImplementationOnce(async () => {
      h.controller.notePushRing('synthetic-mid', 'P1');
      await h.controller.onCallKitEnd('synthetic-mid');
    });
    h.deliver('P1', offer(cidFor(74), h.clock + 60_000));
    await h.controller.whenIdle();

    // The adopted call was declined — the caller was told.
    expect(
      h.sent.filter(f => (f.envelope as { r?: string }).r === 'decline'),
    ).toHaveLength(1);

    // And the NEXT offer from the same peer rings; the tombstone is gone.
    h.deliver('P1', offer(cidFor(75), h.clock + 60_000));
    await h.controller.whenIdle();
    expect(h.native.reportIncomingCall).toHaveBeenCalledTimes(2);
  });

  it('an end for a cid that was never a push ring declines nothing', async () => {
    const h = harness();
    await h.controller.start();

    // An unaddressed CallKit end with no recorded push ring: release only.
    await h.controller.onCallKitEnd('unknown-cid');
    h.deliver('P1', offer(cidFor(73), h.clock + 60_000));
    await h.controller.whenIdle();

    expect(h.native.reportIncomingCall).toHaveBeenCalledTimes(1);
    expect(h.sent.filter(f => (f.envelope as { r?: string }).r === 'decline')).toHaveLength(0);
  });
});

describe('the ring name is corrected only UPWARD', () => {
  // `displayNameFor` falls back to a shortened ULID when the database holds
  // no name. The ring may already show the mirrored name or the honest
  // placeholder — found live: both phones' rings showed raw ids,
  // because the decrypt-time "correction" overwrote them with the fallback.

  it('a db with no name for the caller leaves the ring display alone', async () => {
    const h = harness({
      displayNameFor: async id => {
        const { shortId } = jest.requireActual('../src/person');
        return shortId(id);
      },
    });
    await h.controller.start();

    h.deliver('P1', offer(cidFor(90), h.clock + 60_000));
    await h.controller.whenIdle();

    expect(h.native.updateIncomingCallDisplay).not.toHaveBeenCalled();
  });

  it('a real name still lands on the ring', async () => {
    const h = harness();
    await h.controller.start();

    h.deliver('P1', offer(cidFor(91), h.clock + 60_000));
    await h.controller.whenIdle();

    expect(h.native.updateIncomingCallDisplay).toHaveBeenCalledWith(
      cidFor(91),
      'name:P1',
    );
  });
});

describe('a suspended teardown survives observer dispatches', () => {
  it('a dispatch that STARTED before the teardown cannot claim its collapse', async () => {
    // The falsification of the first ownership check: B's busy-send dispatch
    // begins while A still rings (so B's captured previous-state is not
    // 'ending'), suspends at its send, and resumes AFTER A's decline put the
    // shared state in 'ending'. Judged by the shared state, B looked like
    // the owner and collapsed the teardown A had suspended. Ownership is
    // judged by B's OWN reducer output now — which never produced 'ending'.
    const h = harness();
    await h.controller.start();
    h.deliver('P1', offer(cidFor(89), h.clock + 60_000));
    await h.controller.whenIdle();

    const pump = async (n = 40) => {
      for (let i = 0; i < n; i++) await Promise.resolve();
    };
    // B must be INSIDE its dispatch (suspended at the busy send) before the
    // decline runs, or B's captured previous-state is already 'ending' and
    // neither check would collapse — the interleaving under test never
    // happens. Two sequential gates: replacing the active gate does not
    // release waiters parked on the previous one.
    const releaseBusy = h.gateSend(e => (e as { r?: string }).r === 'busy');
    h.deliver('P2', offer(cidFor(86), h.clock + 60_000));
    await pump();
    const releaseDecline = h.gateSend(e => (e as { r?: string }).r === 'decline');
    const declining = h.controller.decline();
    await pump();

    // B resumes first, with the shared state now 'ending' under A's
    // suspended teardown…
    releaseBusy();
    await pump();
    // …then A's teardown resumes and must complete its WHOLE effect list.
    releaseDecline();
    await declining;
    await h.controller.whenIdle();

    expect(h.logs.some(r => r.peerId === 'P1' && r.reason === 'decline')).toBe(true);
    expect(h.native.endCall).toHaveBeenCalled();
  });

  it('the decline row lands even when another dispatch passes through mid-teardown', async () => {
    // The review's starvation: a teardown suspends at its ANNOUNCE send;
    // any concurrent dispatch that merely OBSERVES 'ending' used to collapse
    // it to idle at its own tail — and the resumed teardown loop then broke
    // before cancelTimer, closePeerConnection, endCallKit and the LOG ROW.
    // The collapse is ownership-scoped now: only the dispatch that produced
    // the ending transition collapses it.
    const h = harness();
    await h.controller.start();
    h.deliver('P1', offer(cidFor(87), h.clock + 60_000));
    await h.controller.whenIdle();

    // The decline's announce hangs mid-teardown…
    const release = h.gateSend(e => (e as { r?: string }).r === 'decline');
    const declining = h.controller.decline();
    // …while an unrelated caller's offer passes through the machine.
    h.deliver('P2', offer(cidFor(88), h.clock + 60_000));
    await h.controller.whenIdle();

    release();
    await declining;
    await h.controller.whenIdle();

    // The suspended teardown completed its WHOLE effect list.
    expect(h.logs.some(r => r.peerId === 'P1' && r.reason === 'decline')).toBe(true);
    expect(h.native.endCall).toHaveBeenCalled();
  });
});

describe('CallKit refusing the report', () => {
  it('ends the call as BUSY — the caller must not hear ringing nobody can see', async () => {
    // CallKit can refuse to present a ring (an active native phone call,
    // say). The refusal was swallowed as an effect failure, so the machine
    // kept 'ringing' a call with NO UI anywhere: the caller listened to it
    // until the timeout. Busy is the honest answer.
    const h = harness();
    h.native.reportIncomingCall.mockRejectedValueOnce(new Error('active call'));
    await h.controller.start();

    h.deliver('P1', offer(cidFor(95), h.clock + 60_000));
    await h.controller.whenIdle();

    const ends = h.sent.filter(
      f => (f.envelope as { tcm?: string; r?: string }).tcm === 'call.end',
    );
    expect(ends).toHaveLength(1);
    expect(ends[0]!.envelope).toMatchObject({ r: 'busy' });
    expect(h.logs.some(r => r.reason === 'busy')).toBe(true);
  });
});

describe('CallKit refusing the GLARE-ADOPTED call', () => {
  it('ends it as busy from incoming_answering too', async () => {
    // The glare loser adopts the peer's call STRAIGHT into
    // incoming_answering and reports it to CallKit from there. A refusal
    // there is the same ghost call one state later — before this, the
    // reducer only recognised the refusal in incoming_ringing, so the
    // adopted call sailed on with no CallKit ownership and dead audio.
    const h = harness();
    h.native.reportIncomingCall.mockRejectedValueOnce(new Error('releasing previous call'));
    await h.controller.start();

    // Our outgoing invite... (cidFor(10) < cidFor(97), so we LOSE glare)
    await h.controller.placeCall('P1', cidFor(10), false);
    // ...crosses their offer, which wins and is adopted.
    h.deliver('P1', offer(cidFor(97), h.clock + 60_000));
    await h.controller.whenIdle();

    const ends = h.sent.filter(
      f =>
        (f.envelope as { tcm?: string; cid?: string }).tcm === 'call.end' &&
        (f.envelope as { cid?: string }).cid === cidFor(97),
    );
    expect(ends).toHaveLength(1);
    expect(ends[0]!.envelope).toMatchObject({ r: 'busy' });
  });
});

describe('the shield yields to a call already ENDING', () => {
  it('a busy-refused offer during teardown still dismisses its placeholder', async () => {
    // A same-peer call in TEARDOWN must not shield the refused offer's own
    // placeholder. Since the tail collapse became ownership-scoped, B's
    // dispatch genuinely observes A in 'ending' here — the explicit ending
    // clause in the guard is what lets the dismissal fire.
    const h = harness();
    // Park teardown: close() hangs, so the machine RESTS in 'ending'.
    let releaseClose: (() => void) | undefined;
    h.native.close.mockImplementation(
      () => new Promise<void>(r => (releaseClose = r)),
    );
    await h.controller.start();

    h.deliver('P1', offer(cidFor(98), h.clock + 60_000));
    await h.controller.whenIdle();
    // Decline A; its teardown suspends inside close().
    const declining = h.controller.decline();
    // The same peer's redial lands while A is still ending.
    h.deliver('P1', offer(cidFor(99), h.clock + 60_000));
    await h.controller.whenIdle();

    expect(h.native.dismissPendingIncomingCall).toHaveBeenCalledWith('P1', 'declined', '');

    // The machine exposes 'ending' the moment the reducer runs — the effect
    // loop may not even have reached close() yet by assertion time.
    releaseClose?.();
    await declining;
    await h.controller.whenIdle();
  });
});

describe('the native report seam', () => {
  it('a db with no name sends EMPTY strings — never the id — so Swift can consult its mirror', async () => {
    const h = harness({
      displayNameFor: async id => {
        const { shortId } = jest.requireActual('../src/person');
        return shortId(id);
      },
    });
    await h.controller.start();

    h.deliver('P1', offer(cidFor(96), h.clock + 60_000));
    await h.controller.whenIdle();

    expect(h.native.reportIncomingCall).toHaveBeenCalledWith(
      cidFor(96),
      'P1',
      '',
      '',
      false,
    );
  });
});

describe('an offer the reducer refuses cannot leave its placeholder ringing', () => {
  // The two-caller case: P2's VoIP push may have a
  // CallKit placeholder ringing RIGHT NOW; when P2's decrypted offer loses to
  // the machine (busy with P1), every refusal path sends the caller the right
  // frame — but none of them knew about the placeholder, which kept ringing
  // until the watchdog. If the offer did not become the live call, its
  // pending ring has no future.

  it('busy: the losing caller\'s pending ring is dismissed', async () => {
    const h = harness();
    await h.controller.start();

    // P1 rings first and holds the machine.
    h.deliver('P1', offer(cidFor(80), h.clock + 60_000));
    await h.controller.whenIdle();
    expect(h.native.reportIncomingCall).toHaveBeenCalledTimes(1);

    // P2's offer arrives while P1 still rings.
    h.deliver('P2', offer(cidFor(81), h.clock + 60_000));
    await h.controller.whenIdle();

    // No second CallKit report, and P2's placeholder is taken down.
    expect(h.native.reportIncomingCall).toHaveBeenCalledTimes(1);
    expect(h.native.dismissPendingIncomingCall).toHaveBeenCalledWith('P2', 'declined', '');
  });

  it('a live call from the SAME peer shields the placeholder', async () => {
    // A second offer from the peer who is ALREADY ringing (a redial, or the
    // same call re-sent) is refused by the machine — but the pending
    // placeholder for that peer belongs to the LIVE first call. Dismissing
    // it on the loser's behalf would kill the real ring: dismissal is
    // peer-scoped, so it cannot tell A's placeholder from B's. Only a peer
    // with NO live call gets dismissed.
    const h = harness();
    await h.controller.start();

    h.deliver('P1', offer(cidFor(83), h.clock + 60_000));
    await h.controller.whenIdle();
    expect(h.native.reportIncomingCall).toHaveBeenCalledTimes(1);

    // The same peer's second, refused offer.
    h.deliver('P1', offer(cidFor(84), h.clock + 60_000));
    await h.controller.whenIdle();

    expect(h.native.dismissPendingIncomingCall).not.toHaveBeenCalled();
  });

  it('the winning offer is NOT dismissed', async () => {
    const h = harness();
    await h.controller.start();

    h.deliver('P1', offer(cidFor(82), h.clock + 60_000));
    await h.controller.whenIdle();

    expect(h.native.reportIncomingCall).toHaveBeenCalledTimes(1);
    expect(h.native.dismissPendingIncomingCall).not.toHaveBeenCalled();
  });
});

describe('routing envelopes', () => {
  it('rings for an offer and answers it', async () => {
    const h = harness();
    await h.controller.start();
    h.deliver('P1', offer('01J0000000000000000000000A', h.clock + 60_000));
    await h.controller.whenIdle();

    expect(h.native.reportIncomingCall).toHaveBeenCalledWith(
      '01J0000000000000000000000A',
      'P1',
      'name:P1',
      'name:P1',
      false,
    );
    await h.controller.accept();
    const answer = h.sent.find(s => s.envelope.tcm === 'call.answer');
    expect(answer?.envelope.tcm === 'call.answer' && answer.envelope.sdp).toBe(ANSWER_SDP);
  });

  it('ignores a body that is not a call envelope', async () => {
    // messaging hands EVERY envelope to every listener, so a chat message and
    // a reaction both arrive here. Treating one as a call would ring a phone
    // for a text message.
    const h = harness();
    await h.controller.start();
    h.deliver('P1', 'hello there');
    h.deliver('P1', { tcm: 'reaction', emoji: '👍' });
    await h.controller.whenIdle();

    expect(h.native.reportIncomingCall).not.toHaveBeenCalled();
  });

  it('accepts an envelope whether it arrives decoded or as a raw body', async () => {
    const h = harness();
    await h.controller.start();
    h.deliver('P1', JSON.stringify(offer('01J0000000000000000000000G', h.clock + 60_000)));
    await h.controller.whenIdle();
    expect(h.native.reportIncomingCall).toHaveBeenCalled();
  });

  it('does not ring for an expired offer, and logs it missed', async () => {
    const h = harness();
    await h.controller.start();
    h.deliver('P1', offer('01J0000000000000000000000B', h.clock - 600_000), h.clock - 600_000);
    await h.controller.whenIdle();

    expect(h.native.reportIncomingCall).not.toHaveBeenCalled();
    expect(h.logs).toHaveLength(1);
    expect(h.logs[0]!.missed).toBe(true);
  });

  it('corrects the CallKit placeholder once the offer decrypts', async () => {
    // The VoIP push carries no name, so the phone rings as "Incoming call".
    // If this never fired, every call would show that forever.
    const h = harness();
    await h.controller.start();
    h.deliver('P1', offer('01J0000000000000000000000C', h.clock + 60_000));
    await h.controller.whenIdle();
    expect(h.native.updateIncomingCallDisplay).toHaveBeenCalledWith('01J0000000000000000000000C', 'name:P1');
  });
});

describe('relay credentials', () => {
  it('fetches them BEFORE the reducer sees an offer', async () => {
    // Accepting with no relay configured yields a peer connection that can
    // only find a direct path — exactly the calls that need a relay most.
    const h = harness();
    await h.controller.start();
    h.deliver('P1', offer('01J0000000000000000000000D', h.clock + 60_000));
    await h.controller.whenIdle();

    expect(h.native.configure).toHaveBeenCalledWith(SERVERS, false);
    const configureOrder = h.native.configure.mock.invocationCallOrder[0]!;
    const ringOrder = h.native.reportIncomingCall.mock.invocationCallOrder[0]!;
    expect(configureOrder).toBeLessThan(ringOrder);
  });

  it('mints once for concurrent callers, not once each', async () => {
    // The endpoint is rate-limited per user; two mints for one call's worth of
    // benefit spends that budget for nothing.
    const h = harness();
    await Promise.all([
      h.controller.ensureCredentials(),
      h.controller.ensureCredentials(),
      h.controller.ensureCredentials(),
    ]);
    expect(h.turnCalls()).toBe(1);
  });

  it('reuses a live credential rather than re-minting', async () => {
    const h = harness();
    await h.controller.ensureCredentials();
    await h.controller.ensureCredentials();
    expect(h.turnCalls()).toBe(1);
  });

  it('degrades to direct calling when no relay is configured', async () => {
    // A 503 means no relay exists. Refusing to call at all would turn a
    // partial outage into a total one.
    const h = harness({
      fetchTurnCredentials: async () => {
        throw new Error('turn_unavailable');
      },
    });
    await h.controller.ensureCredentials();
    expect(h.controller.hasRelay).toBe(false);
    await expect(h.controller.placeCall('P1', '01J0000000000000000000000E', false)).resolves.toBeUndefined();
  });

  it('refuses to place a call when always-relay is on and no relay exists', async () => {
    // That combination cannot connect. Failing here is more honest than
    // ringing a phone that can never answer.
    const h = harness({
      relayOnly: () => true,
      fetchTurnCredentials: async () => {
        throw new Error('turn_unavailable');
      },
    });
    await expect(h.controller.placeCall('P1', '01J0000000000000000000000F', false)).rejects.toThrow('always-relay');
  });

  it('passes the always-relay flag through to the module', async () => {
    const h = harness({ relayOnly: () => true });
    await h.controller.ensureCredentials();
    expect(h.native.configure).toHaveBeenCalledWith(SERVERS, true);
  });
});

describe('silencing unknown callers is ENFORCED, not merely decided', () => {
  it('does not ring, and leaves a missed row the person can act on', async () => {
    // The policy is worth nothing if the controller consults it and rings
    // anyway. A silenced call still leaves evidence — the person can see it
    // happened and call back — but the phone makes no sound.
    const h = harness({ mayRing: async () => ({ ring: false, reason: 'unknown_caller' }) });
    await h.controller.start();
    h.deliver('P1', offer('01J0000000000000000000000A', h.clock + 60_000));
    await h.controller.whenIdle();

    expect(h.native.reportIncomingCall).not.toHaveBeenCalled();
    expect(h.logs).toHaveLength(1);
    expect(h.logs[0]!.missed).toBe(true);
    expect(h.logs[0]!.direction).toBe('in');
  });

  it('spends no relay credential on a call it will not ring', async () => {
    // Minting is rate-limited per user; a stranger who cannot ring the phone
    // must not be able to drain that budget by dialling repeatedly.
    const h = harness({ mayRing: async () => ({ ring: false, reason: 'unknown_caller' }) });
    await h.controller.start();
    h.deliver('P1', offer('01J0000000000000000000000B', h.clock + 60_000));
    await h.controller.whenIdle();
    expect(h.turnCalls()).toBe(0);
  });

  it('rings normally when the policy allows it', async () => {
    // The control: a guard that silenced everything would pass both tests
    // above and break every call.
    const h = harness({ mayRing: async () => ({ ring: true }) });
    await h.controller.start();
    h.deliver('P1', offer('01J0000000000000000000000C', h.clock + 60_000));
    await h.controller.whenIdle();
    expect(h.native.reportIncomingCall).toHaveBeenCalled();
  });
});

describe('a ring bomb (V7 item 4)', () => {
  it('rings ONCE for thirty invites, and answers the rest busy', async () => {
    // The bound is the state machine, not a rate limit: once a call is live,
    // every other offer is answered `busy` rather than rung. That matters
    // because a server-side limit bounds how many offers ARRIVE, while this
    // bounds how many times the phone makes a sound — which is the thing a
    // person actually experiences.
    const h = harness();
    await h.controller.start();

    for (let i = 0; i < 30; i++) {
      h.deliver('P1', offer(cidFor(i), h.clock + 60_000));
    }
    await h.controller.whenIdle();

    expect(h.native.reportIncomingCall).toHaveBeenCalledTimes(1);
    // The others are told, so the caller sees "Busy" rather than ringing out.
    const busy = h.sent.filter(s => s.envelope.tcm === 'call.end');
    // EXACTLY 29, not "more than zero". The previous count was unbounded
    // below, and it was hiding the fact that this test had been running four
    // offers rather than thirty: the ids it generated were 25 characters, so
    // the ULID schema dropped 26 of them before the controller ever saw one.
    // A flood test that silently tests a trickle passes for the wrong reason.
    expect(busy).toHaveLength(29);
    for (const b of busy) {
      expect(b.envelope.tcm === 'call.end' && b.envelope.r).toBe('busy');
    }
  });

  it('never wakes the phone with an urgent frame for a busy answer', async () => {
    // `urgent` is the bit that wakes a sleeping device. Sending it for "busy"
    // would let a flood wake a phone thirty times while ringing it once,
    // which defeats the bound above.
    const h = harness();
    await h.controller.start();
    h.deliver('P1', offer('01J0000000000000000000000A', h.clock + 60_000));
    h.deliver('P1', offer('01J0000000000000000000000B', h.clock + 60_000));
    await h.controller.whenIdle();

    for (const s of h.sent) {
      if (s.envelope.tcm === 'call.end' && s.envelope.r === 'busy') {
        expect(s.urgent).toBe(false);
      }
    }
  });
});

describe('a hung credential fetch (found by review)', () => {
  it('does not stall the envelope queue forever', async () => {
    // ensureCredentials is awaited on the SERIALIZED queue, so a request that
    // never returns stalls every envelope behind it — including the call.end
    // that would stop a phone ringing. The API client has no timeout of its
    // own, so the controller is the only bound.
    const h = harness({ fetchTurnCredentials: () => new Promise(() => {}) });
    const pending = h.controller.ensureCredentials();
    await jest.advanceTimersByTimeAsync(10_000);
    await expect(pending).resolves.toBeUndefined();
    // ...and it degraded rather than failed: a call can still go direct.
    expect(h.controller.hasRelay).toBe(false);
  });
});

describe('outbound ICE is bounded (found by review)', () => {
  it('stops sending after the per-call cap', async () => {
    // The cap was enforced only on the inbound buffer. `gatherContinually`
    // on a flapping network produces candidates indefinitely, each batch
    // costing a ratchet step and a slice of the send budget for connectivity
    // settled long ago.
    const h = harness();
    await h.controller.start();
    await h.controller.placeCall('P1', '01J0000000000000000000000D', false);
    for (let i = 0; i < 200; i++) {
      h.controller.onLocalIceCandidate({ cand: `candidate:${i}`, mid: '0', idx: 0 });
    }
    await jest.advanceTimersByTimeAsync(1000);

    const total = h.sent
      .filter(s => s.envelope.tcm === 'call.ice')
      .reduce((n, s) => n + (s.envelope.tcm === 'call.ice' ? s.envelope.c.length : 0), 0);
    expect(total).toBeLessThanOrEqual(40);
    expect(total).toBeGreaterThan(0);
  });
});

describe('lifecycle', () => {
  it('registers for VoIP push on start — without it a locked phone never rings', async () => {
    const h = harness();
    await h.controller.start();
    expect(h.native.registerForVoipPush).toHaveBeenCalled();
  });

  it('starts even if VoIP registration fails', async () => {
    // No push means no wake for a backgrounded app; it does not mean calling
    // is broken in the foreground, so this must not throw.
    const h = harness();
    (h.native.registerForVoipPush as jest.Mock).mockRejectedValue(new Error('no entitlement'));
    await expect(h.controller.start()).resolves.toBeUndefined();
  });

  it('stops listening after stop()', async () => {
    const h = harness();
    await h.controller.start();
    h.controller.stop();
    h.deliver('P1', offer('01J0000000000000000000000H', h.clock + 60_000));
    await h.controller.whenIdle();
    expect(h.native.reportIncomingCall).not.toHaveBeenCalled();
  });

  it('maps ICE connected through to the reducer', async () => {
    const h = harness();
    await h.controller.start();
    await h.controller.placeCall('P1', '01J0000000000000000000000J', false);
    await h.controller.onIceStateChanged('01J0000000000000000000000J', 'connected');
    expect(h.controller.state.name).toBe('connected');
  });
});

/**
 * The killed-while-ringing case.
 *
 * iOS reclaims a backgrounded app freely, and the CallKit UI outlives it —
 * the phone keeps ringing with the app gone. Answering then cold-launches
 * into a process with no reducer state and no way to get the offer back: the
 * ratchet consumed the message key on first decrypt, so the server's copy is
 * undecryptable (packages/cli/test/redelivery.test.ts). The decrypted offer in
 * SQLite is the only thing that makes that answer possible.
 */
describe('answering after the app was killed', () => {
  const CID = '01J0000000000000000000000K';

  function stored(over: Partial<{ exp: number; video: boolean }> = {}) {
    return {
      cid: CID,
      peerId: 'P1',
      sdp: OFFER_SDP,
      video: false,
      exp: 1_800_000_000_000 + 60_000,
      serverTs: 1_800_000_000_000,
      ...over,
    };
  }

  it('persists the offer before the phone rings, not after', async () => {
    // Ordering is the whole guarantee. If the ring came first there would be a
    // window — short, but exactly the window iOS kills apps in — where the
    // system shows a call the app could never answer.
    const order: string[] = [];
    const h = harness({
      saveOffer: async () => void order.push('save'),
    });
    h.native.reportIncomingCall.mockImplementation(async () => void order.push('ring'));
    await h.controller.start();
    h.deliver('P1', offer(CID, h.clock + 60_000));
    await h.controller.whenIdle();

    expect(order).toEqual(['save', 'ring']);
  });

  it('rebuilds the call from the stored offer and answers it', async () => {
    const h = harness({ takeOffer: async cid => (cid === CID ? stored() : null) });
    await h.controller.start();

    // No offer was ever delivered to THIS process — the state machine is idle,
    // exactly as it would be one millisecond after a cold launch.
    expect(h.controller.state.name).toBe('idle');
    await h.controller.onCallKitAnswer(CID);

    const answer = h.sent.find(s => s.envelope.tcm === 'call.answer');
    expect(answer?.envelope.tcm === 'call.answer' && answer.envelope.sdp).toBe(ANSWER_SDP);
    expect(h.native.createAnswer).toHaveBeenCalledWith(CID, OFFER_SDP, false);
  });

  it('releases the CallKit call when there is no stored offer', async () => {
    // Better an ended call than a connected one that carries no audio: the
    // person can see it failed and call back, instead of saying hello into
    // silence.
    const h = harness({ takeOffer: async () => null });
    await h.controller.start();
    await h.controller.onCallKitAnswer(CID);

    expect(h.native.endCall).toHaveBeenCalledWith(CID, 'failed_media');
    expect(h.sent.some(s => s.envelope.tcm === 'call.answer')).toBe(false);
  });

  it('refuses a stored offer that expired while the phone was off', async () => {
    const h = harness({ takeOffer: async () => stored({ exp: 1_800_000_000_000 - 1 }) });
    await h.controller.start();
    await h.controller.onCallKitAnswer(CID);

    expect(h.native.endCall).toHaveBeenCalledWith(CID, 'timeout');
    expect(h.sent.some(s => s.envelope.tcm === 'call.answer')).toBe(false);
  });

  it('does not disturb a live call when CallKit names a different one', async () => {
    // The guard this replaced returned early for ANY unknown cid. It has to
    // keep doing that for the case it was written for — a second CallKit call
    // must not answer the one actually running.
    const other = '01J0000000000000000000000L';
    const taken: string[] = [];
    const h = harness({
      takeOffer: async cid => {
        taken.push(cid);
        return null;
      },
    });
    await h.controller.start();
    h.deliver('P1', offer(CID, h.clock + 60_000));
    await h.controller.whenIdle();

    await h.controller.onCallKitAnswer(other);

    expect(taken).toEqual([other]);
    expect(h.controller.state.name).toBe('incoming_ringing');
    expect(h.controller.state.call?.cid).toBe(CID);
  });

  it('drops the stored offer once the call is over', async () => {
    // The row holds an SDP: a DTLS fingerprint and, without always-relay,
    // candidate addresses. Keeping it past the call it belonged to is the
    // kind of leftover the threat model is written against.
    const dropped: string[] = [];
    const h = harness({
      saveOffer: async () => undefined,
      dropOffer: async cid => void dropped.push(cid),
    });
    await h.controller.start();
    h.deliver('P1', offer(CID, h.clock + 60_000));
    await h.controller.whenIdle();
    expect(dropped).toEqual([]);

    h.deliver('P1', { tcm: 'call.end', cid: CID, r: 'hangup' });
    await h.controller.whenIdle();

    expect(h.controller.state.name).toBe('idle');
    expect(dropped).toEqual([CID]);
  });
});

/**
 * The design — a call that must not happen must not start.
 *
 * The refusal existed only at the transport seam, where `encryptAndEnqueue`
 * throws. By then the reducer has already emitted `createOffer`, which turns
 * on the camera and microphone, and `reportOutgoingCall`, which puts a call on
 * the lock screen. So calling someone you had blocked lit your camera, spent a
 * TURN credential, flashed a CallKit call and then wrote a log row reading
 * `cancelled` — indistinguishable from having hung up on yourself, with
 * nothing anywhere saying why.
 */
describe('refusing an outbound call before the camera', () => {
  const CID = '01J0000000000000000000000P';

  it('never reaches the camera, CallKit or a relay credential', async () => {
    const mintReportId = jest.fn(async () => 'REPORT-REFUSED');
    const h = harness({
      mayCall: async () => ({ allowed: false, reason: 'blocked' as const }),
      mintReportId,
    });
    await h.controller.start();

    await expect(h.controller.placeCall('P1', CID, true)).rejects.toThrow(/blocked/i);

    expect(h.native.createOffer).not.toHaveBeenCalled();
    expect(h.native.reportOutgoingCall).not.toHaveBeenCalled();
    // Not even a credential: minting one for a call that cannot happen tells
    // the server a call was attempted.
    expect(h.turnCalls()).toBe(0);
    expect(h.controller.state.name).toBe('idle');
    expect(h.sent).toHaveLength(0);
    expect(mintReportId).not.toHaveBeenCalled();
  });

  it('mints an independent report id only after preflight and forwards it to metrics', async () => {
    const mintReportId = jest.fn(async () => 'REPORT-AUTHORITY');
    const metrics = {
      open: jest.fn().mockResolvedValue(undefined), answered: jest.fn(), connected: jest.fn(), peak: jest.fn(),
      finalize: jest.fn(), discard: jest.fn(),
    };
    const h = harness({ mintReportId, metrics });
    await h.controller.start();
    await h.controller.placeCall('P1', CID, false);
    expect(mintReportId).toHaveBeenCalledTimes(1);
    expect(metrics.open).toHaveBeenCalledWith(expect.objectContaining({
      reportId: 'REPORT-AUTHORITY', localId: CID, scope: 'direct',
    }));
  });

  it('distinguishes a block from a changed safety number', async () => {
    // Different causes, different copy, different next steps — one is undone
    // by unblocking, the other by verifying an identity.
    const h = harness({
      mayCall: async () => ({ allowed: false, reason: 'identity_changed' as const }),
    });
    await h.controller.start();

    const err = await h.controller.placeCall('P1', CID, true).then(
      () => null,
      (e: unknown) => e,
    );
    expect((err as { name: string }).name).toBe('CallRefusedError');
    expect((err as { reason: string }).reason).toBe('identity_changed');
  });

  it('leaves an ordinary call alone', async () => {
    const h = harness({ mayCall: async () => ({ allowed: true }) });
    await h.controller.start();
    await h.controller.placeCall('P1', CID, false);
    expect(h.native.createOffer).toHaveBeenCalled();
    expect(h.controller.state.name).toBe('outgoing_connecting');
  });
});

describe('CallKit announces a NAME, not an id', () => {
  const CID = '01J0000000000000000000000Q';

  it('passes the resolved display name through to reportIncomingCall', async () => {
    // This was `personName(peerId)` with no names supplied, so it always fell
    // through to `shortId` and every incoming call announced a fragment of a
    // ULID. The lock screen is also the one place a stranger holding the phone
    // reads it, which makes a raw id the worst of both: meaningless to the
    // owner and an identifier to anyone else.
    const h = harness({ displayNameFor: async id => `Friendly ${id}` });
    await h.controller.start();
    h.deliver('P1', offer(CID, h.clock + 60_000));
    await h.controller.whenIdle();

    // BOTH arguments are the name. CallKit's full-screen incoming UI shows the
    // handle and only the banner shows the label — so passing the id as the
    // handle produced exactly the reported symptom: a correct notification
    // above a full screen announcing a ULID.
    expect(h.native.reportIncomingCall).toHaveBeenCalledWith(
      CID,
      'P1',
      'Friendly P1',
      'Friendly P1',
      false,
    );
    // Never the raw id in a DISPLAY position. The peerId argument (index 1)
    // legitimately carries it now — it is the rebind's correlation key, not
    // something CallKit shows — so the assertion names the two fields that
    // actually reach the screen.
    const args = h.native.reportIncomingCall.mock.calls[0] as string[];
    expect(args[2]).toBe('Friendly P1');
    expect(args[3]).toBe('Friendly P1');
  });

  it('corrects the placeholder with the same name once the offer decrypts', async () => {
    const h = harness({ displayNameFor: async id => `Friendly ${id}` });
    await h.controller.start();
    h.deliver('P1', offer(CID, h.clock + 60_000));
    await h.controller.whenIdle();

    expect(h.native.updateIncomingCallDisplay).toHaveBeenCalledWith(CID, 'Friendly P1');
  });
});

// ---------------------------------------------------------------------------
// A stranger's garbage `urgent` ciphertext must not ring for 75 seconds.
// ---------------------------------------------------------------------------

describe('a push placeholder whose urgent payload proves itself invalid', () => {
  // The VoIP push rings BEFORE anything decrypts (the report is a
  // PushKit obligation), so the ring's legitimacy is only decided by the
  // frames that drain behind it. When the frame from the pending caller
  // resolves as something that can never ring — garbage ciphertext, or a
  // decrypted payload that is not call signalling — the placeholder must end
  // promptly through the existing dismiss path instead of waiting out the
  // native 75-second watchdog.

  it('ends the placeholder shortly after the pending peer’s frame fails decrypt', async () => {
    const h = harness();
    await h.controller.start();

    h.controller.notePushRing('synthetic-f4-1', 'P1');
    h.verdict('P1', 'undecryptable');
    await jest.advanceTimersByTimeAsync(2_500);

    expect(h.native.dismissPendingIncomingCall).toHaveBeenCalledWith('P1', 'invalid', '');
  });

  it('ends the placeholder when the urgent payload decrypts to a NON-call message', async () => {
    const h = harness();
    await h.controller.start();

    h.controller.notePushRing('synthetic-f4-2', 'P1');
    h.verdict('P1', 'not_call');
    await jest.advanceTimersByTimeAsync(2_500);

    expect(h.native.dismissPendingIncomingCall).toHaveBeenCalledWith('P1', 'not_call', '');
  });

  it('does NOT end anything for a peer with no pending push ring', async () => {
    const h = harness();
    await h.controller.start();

    // Ordinary foreground chatter: no push placeholder was ever noted.
    h.verdict('P1', 'not_call');
    await jest.advanceTimersByTimeAsync(2_500);

    expect(h.native.dismissPendingIncomingCall).not.toHaveBeenCalled();
  });

  it('a non-call frame draining AHEAD of the real offer does not kill the ring', async () => {
    // The legitimate interleaving: "calling you now" texted moments before
    // the call, both queued while the phone was dead, draining in order. The
    // text resolves first — the fuse it arms must be defused by the offer
    // that follows, and the ring must proceed.
    const h = harness();
    await h.controller.start();

    h.controller.notePushRing('synthetic-f4-3', 'P1');
    h.verdict('P1', 'not_call');
    h.deliver('P1', offer(cidFor(90), h.clock + 60_000));
    await h.controller.whenIdle();
    await jest.advanceTimersByTimeAsync(2_500);

    expect(h.native.reportIncomingCall).toHaveBeenCalledTimes(1);
    expect(h.native.dismissPendingIncomingCall).not.toHaveBeenCalledWith('P1', 'not_call', '');
    expect(h.native.dismissPendingIncomingCall).not.toHaveBeenCalledWith('P1', 'invalid', '');
  });

  it('stop() disarms a live fuse', async () => {
    const h = harness();
    await h.controller.start();

    h.controller.notePushRing('synthetic-f4-4', 'P1');
    h.verdict('P1', 'undecryptable');
    h.controller.stop();
    await jest.advanceTimersByTimeAsync(2_500);

    expect(h.native.dismissPendingIncomingCall).not.toHaveBeenCalled();
  });

  // A VALID non-offer call frame emits no 'not_call' verdict (it IS
  // a call envelope) and cannot create a call from idle — the reducer returns
  // NOTHING. Its mere arrival also defuses any fuse a preceding non-call frame
  // armed. So a correctly-encrypted call.ringing / call.answer / call.ice /
  // call.media / call.restart with an arbitrary cid left the VoIP placeholder
  // ringing until the native 75-second watchdog. The proof is the frame
  // itself: an unmatched control frame arms the fuse, and with nothing
  // arriving behind it the fuse burns and dismisses the ring (a later fix moved
  // the dismissal from immediate to the grace — the offer one frame behind a
  // stale control frame must still be able to adopt).

  it('ends the placeholder when a valid call.ringing for an unknown cid drains behind the push', async () => {
    const h = harness();
    await h.controller.start();

    // The VoIP push rang a placeholder for P1 and noted it.
    h.controller.notePushRing('synthetic-sweep-a', 'P1');
    // A correctly-encrypted call.ringing with an arbitrary cid: a valid call
    // envelope, so no 'not_call' verdict is ever emitted by messaging — the
    // unmatched-control sweep itself arms the fuse.
    h.deliver('P1', { tcm: 'call.ringing', cid: cidFor(700) });
    await h.controller.whenIdle();
    await jest.advanceTimersByTimeAsync(2_500);

    expect(h.native.dismissPendingIncomingCall).toHaveBeenCalledWith('P1', 'not_call', '');
  });

  it('ends the placeholder for every non-offer control kind, not only call.ringing', async () => {
    const h = harness();
    await h.controller.start();

    // call.answer names a cid no reducer state addresses — from idle it cannot
    // adopt the ring any more than call.ringing can.
    h.controller.notePushRing('synthetic-sweep-b', 'P1');
    h.deliver('P1', { tcm: 'call.answer', cid: cidFor(701), sdp: ANSWER_SDP, vid: false });
    await h.controller.whenIdle();
    await jest.advanceTimersByTimeAsync(2_500);

    expect(h.native.dismissPendingIncomingCall).toHaveBeenCalledWith('P1', 'not_call', '');
  });

  it('a valid call.ringing may not defuse a fuse and then leave the ring standing', async () => {
    const h = harness();
    await h.controller.start();

    h.controller.notePushRing('synthetic-sweep-c', 'P1');
    // A non-call frame arms the 2-second fuse…
    h.verdict('P1', 'not_call');
    // …and a valid call.ringing defuses it (onEnvelope defuses on arrival).
    // The placeholder must still be taken down — the arriving frame proved the
    // ring invalid, it did not prove it live.
    h.deliver('P1', { tcm: 'call.ringing', cid: cidFor(702) });
    await h.controller.whenIdle();
    await jest.advanceTimersByTimeAsync(2_500);

    expect(h.native.dismissPendingIncomingCall).toHaveBeenCalledWith('P1', 'not_call', '');
  });

  it('does NOT dismiss a control frame that names the ADOPTED live call', async () => {
    // The guard against over-reach: once a real offer adopts the ring, its own
    // follow-on frames (ringing, ice, media) must not tear it down.
    const h = harness();
    await h.controller.start();

    h.controller.notePushRing('synthetic-sweep-d', 'P1');
    const cid = cidFor(703);
    h.deliver('P1', offer(cid, h.clock + 60_000));
    await h.controller.whenIdle();
    h.native.dismissPendingIncomingCall.mockClear();

    // A call.ringing naming the LIVE call's cid — matched, so no dismissal.
    h.deliver('P1', { tcm: 'call.ringing', cid });
    await h.controller.whenIdle();

    expect(h.native.dismissPendingIncomingCall).not.toHaveBeenCalled();
  });

  it('does NOT dismiss for a peer with no pending push ring (ordinary foreground chatter)', async () => {
    // The gate that keeps everyday call traffic off the dismiss bridge: with no
    // VoIP placeholder ever noted, a stray control frame changes nothing.
    const h = harness();
    await h.controller.start();

    h.deliver('P1', { tcm: 'call.ringing', cid: cidFor(704) });
    await h.controller.whenIdle();

    expect(h.native.dismissPendingIncomingCall).not.toHaveBeenCalled();
  });

  // The third arm of the same class: a delivered envelope that DECODES TO NO
  // CALL at all. Its very delivery defused any armed fuse (onEnvelope defuses
  // on arrival, before parsing), no verdict will ever fire for it (messaging
  // already classified it as call traffic), and the parse-refusal return used
  // to leave the placeholder with nothing left to end it but the watchdog.
  // The refusal arms the fuse; unanswered, the fuse ends the ring.
  it('a call-shaped frame that decodes to no call cannot leave the placeholder ringing', async () => {
    const h = harness();
    await h.controller.start();

    h.controller.notePushRing('synthetic-r2-badcall', 'P1');
    // Claims the call.offer tcm, carries none of its fields: messaging's
    // looser envelope union admits it, the controller's strict schema refuses
    // it, and between the two of them nobody owned the ring.
    h.deliver('P1', { tcm: 'call.offer' });
    await h.controller.whenIdle();
    await jest.advanceTimersByTimeAsync(2_500);

    expect(h.native.dismissPendingIncomingCall).toHaveBeenCalledWith('P1', 'not_call', '');
  });

  // The earlier sweeps overreached. Older
  // QUEUED traffic drains AHEAD of the offer whose push is ringing: the exact
  // interleaving the fuse's two-second grace exists for (`ringProofFuses`),
  // and which the sweeps skipped by dismissing IMMEDIATELY. Natively that
  // dismissal clears `pendingAnswered` and abandons a parked rebind
  // (CallKitCenter.dismissPendingIncomingCall), so a stale call.answer from
  // the PREVIOUS call could end the NEW call's placeholder — losing an
  // already-made answer outright, or forcing a visible re-ring. An inert
  // outcome must arm the SAME grace fuse the verdict path uses, and lose to
  // any offer that arrives before it burns.

  it('an old call.answer draining ahead of the new offer must not end its placeholder', async () => {
    const h = harness();
    await h.controller.start();

    h.controller.notePushRing('synthetic-r3-a', 'P1');
    // Stale signalling from the previous call, queued while the phone was
    // dead, drains first…
    h.deliver('P1', { tcm: 'call.answer', cid: cidFor(710), sdp: ANSWER_SDP, vid: false });
    // …and the offer whose push rang the placeholder is right behind it.
    h.deliver('P1', offer(cidFor(711), h.clock + 60_000));
    await h.controller.whenIdle();
    await jest.advanceTimersByTimeAsync(2_500);

    expect(h.native.dismissPendingIncomingCall).not.toHaveBeenCalledWith('P1', 'not_call', '');
    expect(h.native.reportIncomingCall).toHaveBeenCalledTimes(1);
    expect(h.controller.state.name).toBe('incoming_ringing');
  });

  it('a malformed call frame draining ahead of the offer must not end its placeholder', async () => {
    const h = harness();
    await h.controller.start();

    h.controller.notePushRing('synthetic-r3-b', 'P1');
    // Decodes to no call at all — but the ring it
    // condemns belongs to the offer one frame behind it.
    h.deliver('P1', { tcm: 'call.offer' });
    h.deliver('P1', offer(cidFor(712), h.clock + 60_000));
    await h.controller.whenIdle();
    await jest.advanceTimersByTimeAsync(2_500);

    expect(h.native.dismissPendingIncomingCall).not.toHaveBeenCalledWith('P1', 'not_call', '');
    expect(h.native.reportIncomingCall).toHaveBeenCalledTimes(1);
  });

  it('a fuse armed by an inert handler after the offer was DELIVERED dies when its handling starts', async () => {
    // The invariant start() documents — a fuse must never outrun the offer
    // that already arrived to defuse it — for fuses armed INSIDE the queue.
    // Both frames are delivered before the inert one is handled, so the
    // offer's delivery-time defuse fires before any fuse exists; the offer's
    // own handling then stalls in the credential fetch, longer than the
    // grace. The fuse must die when the offer's handler STARTS, not survive
    // until the fetch returns.
    const released: (() => void)[] = [];
    const h = harness({
      fetchTurnCredentials: () =>
        new Promise(resolve => {
          released.push(() => resolve({ iceServers: SERVERS, ttlSeconds: 12 * 3600 }));
        }),
    });
    await h.controller.start();

    h.controller.notePushRing('synthetic-r3-c', 'P1');
    h.deliver('P1', { tcm: 'call.answer', cid: cidFor(713), sdp: ANSWER_SDP, vid: false });
    h.deliver('P1', offer(cidFor(714), h.clock + 60_000));
    // Burn well past the grace while the offer's handler sits in the fetch.
    await jest.advanceTimersByTimeAsync(2_500);
    expect(h.native.dismissPendingIncomingCall).not.toHaveBeenCalledWith('P1', 'not_call', '');

    for (const release of released.splice(0)) release();
    await h.controller.whenIdle();
    expect(h.native.reportIncomingCall).toHaveBeenCalledTimes(1);
  });

  it('with nothing behind it, an inert frame still ends the placeholder — at the fuse, not the watchdog', async () => {
    // The standing guarantee, kept: the grace defers the dismissal, it must
    // not repeal it.
    const h = harness();
    await h.controller.start();

    h.controller.notePushRing('synthetic-r3-d', 'P1');
    h.deliver('P1', { tcm: 'call.answer', cid: cidFor(715), sdp: ANSWER_SDP, vid: false });
    await h.controller.whenIdle();
    await jest.advanceTimersByTimeAsync(2_500);

    expect(h.native.dismissPendingIncomingCall).toHaveBeenCalledWith('P1', 'not_call', '');
  });

  // The arm the earlier fix MISSED. Every other inbound kind was moved onto the fuse
  // above; `call.end` was excluded on the argument that it "already
  // dismisses" — but WHICH placeholder it dismisses was never checked. The
  // dismissal is peer-keyed, and the placeholder's real cid is inside the
  // ciphertext by design (the push carries none), so a `call.end` naming a
  // cid this device has never run is INDISTINGUISHABLE from the cancellation
  // of the still-undecrypted offer that is ringing. Draining one frame ahead
  // of that offer, it ended the offer's placeholder — clearing
  // `pendingAnswered` and abandoning the parked rebind natively, the exact
  // two losses this describe block exists to prevent. No attacker needed:
  // this is the ordinary missed-call-then-redial on a phone that was offline,
  // where the timed-out call's end sits ahead of the redial's offer in one
  // drain.

  it('an old call.end draining ahead of the new offer must not end its placeholder', async () => {
    const h = harness();
    await h.controller.start();

    h.controller.notePushRing('synthetic-r3-e', 'P1');
    // The PREVIOUS call's cancellation, queued while the phone was dead…
    h.deliver('P1', { tcm: 'call.end', cid: cidFor(716), r: 'timeout' });
    // …and the redial whose push is ringing right now is one frame behind it.
    h.deliver('P1', offer(cidFor(717), h.clock + 60_000));
    await h.controller.whenIdle();
    await jest.advanceTimersByTimeAsync(2_500);

    expect(h.native.dismissPendingIncomingCall).not.toHaveBeenCalled();
    expect(h.native.reportIncomingCall).toHaveBeenCalledTimes(1);
    expect(h.controller.state.name).toBe('incoming_ringing');
  });

  it('with nothing behind it, a stale call.end still ends the placeholder — as .remoteEnded', async () => {
    // The standing guarantee for this branch, kept: the grace defers the
    // dismissal, it must not repeal it. And the REASON has to survive the
    // deferral — CallKitCenter.dismissPendingIncomingCall maps 'cancelled'
    // to .remoteEnded and everything else to .unanswered, so a fuse that
    // burned with the fuse's own default would mislabel a call the caller
    // genuinely hung up as one this phone ignored.
    const h = harness();
    await h.controller.start();

    h.controller.notePushRing('synthetic-r3-f', 'P1');
    h.deliver('P1', { tcm: 'call.end', cid: cidFor(718), r: 'cancelled' });
    await h.controller.whenIdle();
    await jest.advanceTimersByTimeAsync(2_500);

    expect(h.native.dismissPendingIncomingCall).toHaveBeenCalledWith('P1', 'cancelled', '');
  });

  it('a call.end naming the LIVE call still settles it at once', async () => {
    // An end that names the call this device is actually running keeps the
    // immediate path. (Natively a no-op — the rebind cleared `pendingPush`
    // when the offer adopted the ring — which is why the JS-side settle is
    // what matters here.)
    //
    // WHAT THIS DOES NOT PROVE, contrary to its title: the offer here ADOPTS,
    // adoption spends the notes (`settleRingProof`), so `peerHasPushRing`
    // is already false when the end runs and the immediate path is taken by
    // the SECOND conjunct. `!namesLiveCall` is dead weight in this test —
    // deleting it from the controller leaves this green. The conjunct is
    // pinned by 'an end naming the LIVE call settles at once even with a
    // ring noted behind it' below; leave this one as the plain shape.
    const h = harness();
    await h.controller.start();

    h.controller.notePushRing('synthetic-r3-g', 'P1');
    const cid = cidFor(719);
    h.deliver('P1', offer(cid, h.clock + 60_000));
    await h.controller.whenIdle();
    expect(h.controller.state.name).toBe('incoming_ringing');

    h.deliver('P1', { tcm: 'call.end', cid, r: 'cancelled' });
    await h.controller.whenIdle();

    expect(h.controller.state.name).toBe('idle');
    expect(h.native.dismissPendingIncomingCall).toHaveBeenCalledWith('P1', 'cancelled', '');
  });

  // ── The round after. Three of the four claims the branch above makes were
  // pinned by nothing at all: the test directly above CANNOT reach the
  // `!namesLiveCall` conjunct (adoption SPENDS the notes, so the second
  // conjunct decides it), the `peerHasPushRing` gate could be deleted for the
  // spec's unconditional `else` with the suite still green, and the deferred
  // dismissal could be repealed outright by a second push. Each test below
  // names exactly one of them and fails when it alone is removed.

  it('a second same-peer push may not repeal a deferred cancellation', async () => {
    // THE SHIPPED REGRESSION. `notePushRing` retires whatever ring state
    // stands, on the invariant that a new ring gets a new CLOCK. That is
    // right for a fuse armed by SPECULATION — an inert frame's 'not_call',
    // which the next inert frame re-arms — and wrong for the SETTLED verdict
    // a `call.end` parks on that same fuse, because nothing ever decides it a
    // second time: the frame that made the decision has already drained.
    //
    // Reachable without an attacker. CallKitCenter reports every announced
    // end, so a caller cancelling (or timing out) while this phone was dead
    // sends a SECOND VoIP push; its `alreadyRinging` branch deliberately
    // leaves native `pendingPush` pointed at the FIRST ring and still emits
    // `voipPush` upward, which src/call/index.ts turns into `notePushRing`.
    // The ring that survives natively is then exactly the one JS has just
    // lost the ability to end, and it rings to the 75-second watchdog after
    // the caller hung up.
    const h = harness();
    await h.controller.start();

    h.controller.notePushRing('synthetic-p4-a', 'P1');
    // The cancellation of a cid this device never ran: deferred, not repealed.
    h.deliver('P1', { tcm: 'call.end', cid: cidFor(720), r: 'cancelled' });
    await h.controller.whenIdle();
    await jest.advanceTimersByTimeAsync(300);
    expect(h.native.dismissPendingIncomingCall).not.toHaveBeenCalled();

    // …and the end's own push reaches JS 300 ms into that grace.
    h.controller.notePushRing('synthetic-p4-b', 'P1');

    // It does NOT fire on the spot — see the sibling test: firing here would
    // reinstate the very defect the deferral closes, because this push may
    // equally be a REDIAL's, whose offer is one frame behind it.
    await jest.advanceTimersByTimeAsync(1_699);
    expect(h.native.dismissPendingIncomingCall).not.toHaveBeenCalled();

    // …AND IT IS NOT POSTPONED ONTO THE NEW RING'S CLOCK EITHER. This half
    // used to read `advance(1_900) → not called; advance(200) → called`,
    // i.e. the ORIGINAL deadline plus the push's own fresh two seconds — and
    // that re-clocking IS the redial-killing defect: pushed past the redial's
    // own push, the fire lands on the placeholder the redial is riding.
    //
    // The push HOLDS instead: the decision's own deadline (t+2000) passes
    // without a fire, because the phone is now ringing that same placeholder
    // for a call this decision knows nothing about and the redial's offer is
    // still in flight. The hold's ceiling is the bound, and the decision is
    // still the decision that fires — .remoteEnded, on the ring it named.
    await jest.advanceTimersByTimeAsync(1);
    expect(h.native.dismissPendingIncomingCall).not.toHaveBeenCalled();

    // 300 (the push) + 4000 (the ceiling) — reached, then one flush for the
    // resumed countdown, which is a macrotask and not a second grace.
    await jest.advanceTimersByTimeAsync(2_301);
    expect(h.native.dismissPendingIncomingCall).toHaveBeenCalledWith('P1', 'cancelled', '');
  });

  it('the redial behind that second push still takes the ring', async () => {
    // The other direction, and the reason the deferred decision is RE-ARMED
    // on the new ring's clock rather than fired at the push: the second
    // same-peer push is just as likely to be the redial's own offer push, and
    // dismissing on the spot would kill the ring it had only just announced.
    const h = harness();
    await h.controller.start();

    h.controller.notePushRing('synthetic-p4-c', 'P1');
    h.deliver('P1', { tcm: 'call.end', cid: cidFor(721), r: 'timeout' });
    await h.controller.whenIdle();
    await jest.advanceTimersByTimeAsync(300);

    h.controller.notePushRing('synthetic-p4-d', 'P1');
    h.deliver('P1', offer(cidFor(722), h.clock + 60_000));
    await h.controller.whenIdle();
    await jest.advanceTimersByTimeAsync(5_000);

    expect(h.native.dismissPendingIncomingCall).not.toHaveBeenCalled();
    expect(h.native.reportIncomingCall).toHaveBeenCalledTimes(1);
    expect(h.controller.state.name).toBe('incoming_ringing');
  });

  it('an end naming the LIVE call settles at once even with a ring noted behind it', async () => {
    // The `!namesLiveCall` conjunct, ALONE. The older sibling test cannot
    // reach it: its offer adopts, adoption calls `settleRingProof`, and by
    // the time its `call.end` runs `peerHasPushRing('P1')` is already false —
    // so the immediate path is taken by the SECOND conjunct and the
    // correlation the branch turns on is never consulted. Here a second
    // same-peer push re-notes a ring WHILE the call is live (the caller's own
    // urgent end push, or a verify probe), so both conjuncts are live and
    // only the cid/peer correlation can decide.
    const h = harness();
    await h.controller.start();

    h.controller.notePushRing('synthetic-live-a', 'P1');
    const cid = cidFor(723);
    h.deliver('P1', offer(cid, h.clock + 60_000));
    await h.controller.whenIdle();
    expect(h.controller.state.name).toBe('incoming_ringing');

    h.controller.notePushRing('synthetic-live-b', 'P1');
    h.deliver('P1', { tcm: 'call.end', cid, r: 'cancelled' });
    await h.controller.whenIdle();

    // IMMEDIATE: not one timer has been advanced. An end that names the call
    // this device is actually running is not ambiguous, and deferring it
    // would leave the ring up for two seconds after the caller hung up.
    expect(h.native.dismissPendingIncomingCall).toHaveBeenCalledWith('P1', 'cancelled', '');
    expect(h.controller.state.name).toBe('idle');
  });

  it('an end with NO noted ring dismisses at once — a JS restart lost the note, not the ring', async () => {
    // The `peerHasPushRing` gate, ALONE — the deliberate deviation from the
    // spec's unconditional `else`, which a later round would otherwise
    // "simplify back" in silence. With no note, `armRingProof` early-returns,
    // so deferring here arms NOTHING and the placeholder is dismissed by
    // nothing at all: a ring stuck to the native 75-second watchdog, strictly
    // worse than the stale-end defect the deferral closes. A JS restart
    // between the VoIP push and this drain loses the note; the native
    // placeholder survives it, which is why the immediate dismiss is right.
    const h = harness();
    await h.controller.start();

    h.deliver('P1', { tcm: 'call.end', cid: cidFor(724), r: 'cancelled' });
    await h.controller.whenIdle();

    expect(h.native.dismissPendingIncomingCall).toHaveBeenCalledWith('P1', 'cancelled', '');
    await jest.advanceTimersByTimeAsync(5_000);
    expect(h.native.dismissPendingIncomingCall).toHaveBeenCalledTimes(1);
  });

  it('an end behind an inert frame supersedes the guess and ends .remoteEnded', async () => {
    // THE DECISION OUTRANKS THE GUESS — structurally now, not by an upgrade
    // rule inside the fuse's reason map. The end puts the speculative fuse out
    // and takes over, INHERITING its deadline (it may never extend one — that
    // is the renewable lease the absolute-grace round closed). What it must
    // not lose is the label: CallKitCenter maps 'cancelled' to .remoteEnded
    // and everything else to .unanswered, and without this the missed-call row
    // says this phone ignored a caller who had hung up.
    const h = harness();
    await h.controller.start();

    h.controller.notePushRing('synthetic-upgrade', 'P1');
    h.deliver('P1', { tcm: 'call.answer', cid: cidFor(725), sdp: ANSWER_SDP, vid: false });
    h.deliver('P1', { tcm: 'call.end', cid: cidFor(726), r: 'cancelled' });
    await h.controller.whenIdle();
    await jest.advanceTimersByTimeAsync(2_500);

    expect(h.native.dismissPendingIncomingCall).toHaveBeenCalledWith('P1', 'cancelled', '');
    expect(h.native.dismissPendingIncomingCall).not.toHaveBeenCalledWith('P1', 'not_call', '');
  });

  it('a decided cancellation discharged by ADOPTION cannot relabel the peer’s next ring', async () => {
    // The mechanism this test was written against — a 'cancelled' left behind
    // in `ringProofReasons` by the retire adoption performs — is gone with the
    // value itself. The PROPERTY survives structurally, and is now
    // `dischargeCancelObligation` inside `settleRingProof`: adoption removes
    // the record, so nothing of the old decision can outrank, relabel or
    // duplicate the fuse the peer's NEXT ring arms for itself. Left standing,
    // an ignored call would be filed .remoteEnded — "they hung up".
    const h = harness();
    await h.controller.start();

    h.controller.notePushRing('synthetic-label-a', 'P1');
    h.deliver('P1', { tcm: 'call.end', cid: cidFor(727), r: 'cancelled' });
    h.deliver('P1', offer(cidFor(728), h.clock + 60_000));
    await h.controller.whenIdle();
    expect(h.controller.state.name).toBe('incoming_ringing');
    expect(h.native.dismissPendingIncomingCall).not.toHaveBeenCalled();

    // A fresh ring for the same peer, ended by a fuse of its OWN.
    h.controller.notePushRing('synthetic-label-b', 'P1');
    h.verdict('P1', 'not_call');
    await jest.advanceTimersByTimeAsync(2_500);

    expect(h.native.dismissPendingIncomingCall).toHaveBeenCalledWith('P1', 'not_call', '');
    expect(h.native.dismissPendingIncomingCall).not.toHaveBeenCalledWith('P1', 'cancelled', '');
  });
});

// ---------------------------------------------------------------------------
// THE DECIDED CANCELLATION — a `call.end` that named no live call.
//
// It is NOT the speculative fuse and no longer rides it. A fuse armed by an
// inert frame is a GUESS the next inert frame re-arms, so postponing it,
// parking it or dropping it costs nothing. A cancellation is a DECISION: the
// frame that made it has already drained, so nothing ever decides it again,
// and every way of losing it leaves the placeholder dismissed by nothing —
// ringing to the native 75-second watchdog after the caller hung up.
//
// It is also the half that cannot be repaired by naming the ring. A cid tag
// separates placeholder INSTANCES; it cannot separate two logical calls that
// share one instance, which is exactly what a cancel-then-redial inside the
// grace produces (native's `alreadyRinging` branch deliberately leaves
// `pendingPush` on the FIRST ring). The property that fixes that one is here:
// a decision fires on the clock of the ring it decided and is never re-armed
// onto a later ring's.
// ---------------------------------------------------------------------------

describe('the decided cancellation', () => {
  /** A noted ring whose placeholder native published as `ringCid`, then a
   * `call.end` naming a cid this device has never run — the ambiguous case,
   * the one the grace exists for. */
  async function armed(ringCid = 's1', n = 760): Promise<Harness> {
    const h = harness();
    await h.controller.start();
    h.controller.notePushRing(`synthetic-oblig-${n}`, 'P1', ringCid);
    h.deliver('P1', { tcm: 'call.end', cid: cidFor(n), r: 'cancelled' });
    await h.controller.whenIdle();
    return h;
  }

  it('fires on its own clock, never re-armed onto the next push’s', async () => {
    // The shipped carry re-armed the decision on every later
    // push's clock, so a stream of pushes walked the fire forward without
    // limit. The deadline is the decision's own and nothing moves it — a push
    // may only HOLD it (below), and the hold has a ceiling of its own that a
    // second push cannot raise.
    const h = await armed('s1', 760);
    await jest.advanceTimersByTimeAsync(300);
    h.controller.notePushRing('synthetic-oblig-760b', 'P1', 's1');
    await jest.advanceTimersByTimeAsync(700);
    // The SECOND post-decision push. Under the carry this alone bought another
    // full grace; here it re-takes a hold whose ceiling was fixed at 300+4000.
    h.controller.notePushRing('synthetic-oblig-760c', 'P1', 's1');

    // 300 (the first post-decision push) + 4000 (the ceiling).
    await jest.advanceTimersByTimeAsync(3_300);
    expect(h.native.dismissPendingIncomingCall).not.toHaveBeenCalled();
    // The ceiling elapsing RESUMES the decision on the deadline it has always
    // had — by now long past — so the fire is one macrotask behind it. A
    // flush, not a second grace.
    await jest.advanceTimersByTimeAsync(1);
    expect(h.native.dismissPendingIncomingCall).toHaveBeenCalledWith('P1', 'cancelled', 's1');
    expect(h.native.dismissPendingIncomingCall).toHaveBeenCalledTimes(1);
  });

  it('THE REDIAL: a push riding the same placeholder is not killed inside the hold', async () => {
    // The cid tag cannot separate
    // these two calls, because THE REDIAL RIDES THE SAME PLACEHOLDER:
    // `CallKitCenter`'s `alreadyRinging` branch deliberately does not replace
    // `pendingPush`, so `ringingCid(for:)` publishes s1 again and the phone has
    // been ringing continuously on s1 the whole time. Fired at its bare
    // deadline the decision therefore ends a LIVE ring — one whose peer-matched
    // rebind was about to adopt it for the redial — clearing `pendingAnswered`
    // (an answer already tapped) and abandoning the parked rebind.
    //
    // The push is not allowed to repeal or postpone the decision. It takes a
    // bounded HOLD, and the redial's offer discharges it by adopting.
    const h = await armed('s1', 772);
    await jest.advanceTimersByTimeAsync(300);
    h.controller.notePushRing('synthetic-oblig-772b', 'P1', 's1');

    // The redial's offer needs a socket round-trip on a just-woken phone, and
    // lands AFTER the decision's own deadline (measured at ~2 s).
    await jest.advanceTimersByTimeAsync(2_000);
    expect(h.native.dismissPendingIncomingCall).not.toHaveBeenCalled();
    h.deliver('P1', offer(cidFor(773), Date.now() + 60_000));
    await h.controller.whenIdle();
    expect(h.controller.state.name).toBe('incoming_ringing');

    await jest.advanceTimersByTimeAsync(60_000);
    expect(h.native.dismissPendingIncomingCall).not.toHaveBeenCalled();
  });

  it('the hold is BOUNDED — a push with nothing behind it still ends the ring', async () => {
    // Rule 3's twin. A hold released only by a frame is a stuck ring whenever
    // the push turns out to be the cancellation's own (every announced end is
    // urgent, so the caller's hang-up pushes too) and no frame follows it. The
    // ceiling is absolute and dated from the FIRST post-decision push.
    const h = await armed('s1', 774);
    await jest.advanceTimersByTimeAsync(300);
    h.controller.notePushRing('synthetic-oblig-774b', 'P1', 's1');

    await jest.advanceTimersByTimeAsync(4_000);
    expect(h.native.dismissPendingIncomingCall).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(h.native.dismissPendingIncomingCall).toHaveBeenCalledWith('P1', 'cancelled', 's1');
  });

  it('a frame behind the push does NOT release the hold — the CEILING does, onto the ORIGINAL deadline', async () => {
    // ROUND TWELVE REVERSED THIS TEST'S FIRST HALF, and the half it kept is
    // the half that was ever true. A frame arriving behind the push is not
    // the drain answering: the offer it is ahead of has not been delivered
    // yet and will not be for turns, so surrendering the ceiling to it killed
    // live rings (`an inert frame in the drain may not hand the push hold to
    // the offer behind it`). As written before, this test delivered its frame
    // at t = 2500 — AFTER the decision's own deadline, where resuming and
    // holding are indistinguishable — so it passed either way and was the
    // only thing pinning the release. Rule 2, again.
    //
    // What stands: the ceiling ends the hold, and the decision then resumes
    // on the deadline it has always had, by then in the past, so it fires at
    // once rather than serving a second grace.
    const h = await armed('s1', 782);
    await jest.advanceTimersByTimeAsync(300);
    h.controller.notePushRing('synthetic-oblig-782b', 'P1', 's1');
    await jest.advanceTimersByTimeAsync(2_200);
    expect(h.native.dismissPendingIncomingCall).not.toHaveBeenCalled();

    h.deliver('P1', { tcm: 'reaction', emoji: '👍' });
    await h.controller.whenIdle();
    await jest.advanceTimersByTimeAsync(0);
    expect(h.native.dismissPendingIncomingCall).not.toHaveBeenCalled();

    // 300 + 4000 — the ceiling, untouched by the frame — and then the fire is
    // one macrotask behind it, not one grace.
    await jest.advanceTimersByTimeAsync(1_800);
    expect(h.native.dismissPendingIncomingCall).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(h.native.dismissPendingIncomingCall).toHaveBeenCalledWith('P1', 'cancelled', 's1');
    expect(h.native.dismissPendingIncomingCall).toHaveBeenCalledTimes(1);
  });

  it('a push taken DURING a stalled handler outlives that handler’s release', async () => {
    // The two holds are independent and the push hold is the longer one. A
    // redial's push landing while an earlier frame is still in its handler is
    // ordinary — the push resumes the socket, and the frame ahead of the
    // redial's offer is exactly what the drain delivers first. When that
    // handler releases its own hold the countdown must STILL not start: the
    // deadline is already past, so it would fire on the spot and kill the ring
    // the push has just announced.
    let settle: ((v: boolean) => void) | undefined;
    const router = {
      handles: jest.fn(() => true),
      handle: jest.fn(
        () =>
          new Promise<boolean>(res => {
            settle = res;
          }),
      ),
      liveSessionBusy: () => false,
    };
    const h = harness({ groupRouter: router });
    await h.controller.start();
    h.controller.notePushRing('synthetic-oblig-786', 'P1', 's1');
    router.handles.mockReturnValue(false);
    h.deliver('P1', { tcm: 'call.end', cid: cidFor(786), r: 'cancelled' });
    await h.controller.whenIdle();

    // A frame from this peer takes the ORDINARY hold and stalls…
    router.handles.mockReturnValue(true);
    await jest.advanceTimersByTimeAsync(100);
    h.deliver('P1', { tcm: 'call.gleave' });
    await jest.advanceTimersByTimeAsync(200);
    // …and the redial's push lands inside that stall: t = 300, ceiling 4300.
    h.controller.notePushRing('synthetic-oblig-786b', 'P1', 's1');
    // The stalled handler finishes without adopting, releasing ITS hold only.
    await jest.advanceTimersByTimeAsync(200);
    settle?.(false);
    await h.controller.whenIdle();

    await jest.advanceTimersByTimeAsync(3_800);
    expect(h.native.dismissPendingIncomingCall).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(h.native.dismissPendingIncomingCall).toHaveBeenCalledWith('P1', 'cancelled', 's1');
  });

  it('the ceiling is spent once — push, frame, push cannot walk it forward', async () => {
    // The renewable lease, third door. Alternating a push with an inert frame
    // re-takes the hold on every push; if each re-dated the ceiling, a caller
    // could keep a cancelled placeholder ringing to the 75-second watchdog with
    // pushes alone. A push landing after the ceiling has passed holds nothing.
    const h = await armed('s1', 783);
    await jest.advanceTimersByTimeAsync(300);
    h.controller.notePushRing('synthetic-oblig-783b', 'P1', 's1');
    await jest.advanceTimersByTimeAsync(4_100);
    expect(h.native.dismissPendingIncomingCall).toHaveBeenCalledTimes(1);

    // …and a push after the fire cannot resurrect anything either.
    h.controller.notePushRing('synthetic-oblig-783c', 'P1', 's1');
    await jest.advanceTimersByTimeAsync(10_000);
    expect(h.native.dismissPendingIncomingCall).toHaveBeenCalledTimes(1);
  });

  it('names the ring it decided, so a placeholder minted after it is safe', async () => {
    // Constraint 1, the JS half: the cid is captured when the decision is MADE.
    // Read at fire time it would name whatever is ringing then — which is the
    // stale-verdict-burns-a-new-ring class stated as an implementation detail.
    const h = await armed('s1', 761);
    await jest.advanceTimersByTimeAsync(500);
    h.controller.notePushRing('synthetic-oblig-761b', 'P1', 's2');
    await jest.advanceTimersByTimeAsync(4_001);

    expect(h.native.dismissPendingIncomingCall).toHaveBeenCalledWith('P1', 'cancelled', 's1');
  });

  it('survives a group frame adopting on top of it', async () => {
    // Group adoption PARKS the speculative fuse (deliberately), and
    // the shipped deferral lived on that fuse — so one adopted group frame
    // inside the grace parked the cancellation and nothing ever re-armed it.
    // Reachable by anyone holding a session open.
    const router = {
      handles: jest.fn(() => false),
      handle: jest.fn(async () => true),
      liveSessionBusy: () => false,
    };
    const h = harness({ groupRouter: router });
    await h.controller.start();
    h.controller.notePushRing('synthetic-oblig-762', 'P1', 's1');
    h.deliver('P1', { tcm: 'call.end', cid: cidFor(762), r: 'cancelled' });
    await h.controller.whenIdle();

    await jest.advanceTimersByTimeAsync(500);
    router.handles.mockReturnValue(true);
    h.deliver('P1', { tcm: 'call.gjoin' });
    await h.controller.whenIdle();

    await jest.advanceTimersByTimeAsync(1_600);
    expect(h.native.dismissPendingIncomingCall).toHaveBeenCalledWith('P1', 'cancelled', 's1');
  });

  it('survives a throwing router', async () => {
    // A throw below the two parks unwinds past both of them, so the
    // deferral stayed parked forever — a stuck ring, which is rule 3's twin
    // and just as much a defect as a suppressed one.
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const router = {
      handles: jest.fn(() => false),
      handle: jest.fn(async () => true),
      liveSessionBusy: () => false,
    };
    const h = harness({ groupRouter: router });
    await h.controller.start();
    h.controller.notePushRing('synthetic-oblig-763', 'P1', 's1');
    h.deliver('P1', { tcm: 'call.end', cid: cidFor(763), r: 'cancelled' });
    await h.controller.whenIdle();

    await jest.advanceTimersByTimeAsync(500);
    router.handles.mockReturnValue(true);
    router.handle.mockRejectedValue(new Error('boom'));
    h.deliver('P1', { tcm: 'call.gjoin' });
    await h.controller.whenIdle();

    await jest.advanceTimersByTimeAsync(1_600);
    expect(h.native.dismissPendingIncomingCall).toHaveBeenCalledWith('P1', 'cancelled', 's1');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('a throwing router does not strand the speculative fuse either', async () => {
    // THE OTHER ARM, and the reason the resume is a `catch`+rethrow rather
    // than a `finally`: a NORMAL exit whose outcome was adoption must not
    // re-arm, an abnormal one must.
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const router = {
      handles: jest.fn(() => false),
      handle: jest.fn(async () => true),
      liveSessionBusy: () => false,
    };
    const h = harness({ groupRouter: router });
    await h.controller.start();
    h.controller.notePushRing('synthetic-oblig-764', 'P1', 's1');
    h.verdict('P1', 'not_call');

    await jest.advanceTimersByTimeAsync(500);
    router.handles.mockReturnValue(true);
    router.handle.mockRejectedValue(new Error('boom'));
    h.deliver('P1', { tcm: 'call.gjoin' });
    await h.controller.whenIdle();

    await jest.advanceTimersByTimeAsync(1_600);
    expect(h.native.dismissPendingIncomingCall).toHaveBeenCalledWith('P1', 'not_call', 's1');
    warn.mockRestore();
  });

  it('does not fire while a frame is queued behind a stalled handler', async () => {
    // The HOLD. A frame delivered into the queue pauses the obligation for the
    // duration of its own handling — the offer branch can sit up to eight
    // seconds in a credential fetch, and a fire landing inside it would end the
    // placeholder the offer is one await away from adopting. The deadline is
    // untouched: a stalling peer buys parking, never time.
    const gate: (() => void)[] = [];
    const h = harness({
      fetchTurnCredentials: () =>
        new Promise(res => {
          gate.push(() => res({ iceServers: SERVERS, ttlSeconds: 12 * 3600 }));
        }),
    });
    await h.controller.start();
    h.controller.notePushRing('synthetic-oblig-765', 'P1', 's1');
    h.deliver('P1', { tcm: 'call.end', cid: cidFor(765), r: 'cancelled' });
    await h.controller.whenIdle();

    await jest.advanceTimersByTimeAsync(100);
    h.deliver('P1', offer(cidFor(766), Date.now() + 60_000));
    await jest.advanceTimersByTimeAsync(3_000);
    expect(h.native.dismissPendingIncomingCall).not.toHaveBeenCalled();

    for (const g of gate.splice(0)) g();
    await h.controller.whenIdle();
    await jest.advanceTimersByTimeAsync(5_000);
    expect(h.native.dismissPendingIncomingCall).not.toHaveBeenCalled();
    expect(h.controller.state.name).toBe('incoming_ringing');
  });

  it('is ARMED paused when the offer beside it is already queued', async () => {
    // THE ARM-TIME HALF of the hold, and the state the test above cannot
    // reach: it awaits `whenIdle()` before delivering the offer, so the
    // obligation is always armed at hold depth ZERO and the guard on the arm
    // is never the thing that keeps the timer off.
    //
    // `armCancelObligation` is only ever reached from inside `handleEnvelope`,
    // so a hold is ALWAYS outstanding when it runs — and in the one production
    // ordering this whole feature exists for ("the caller hung up while this
    // phone was dead, both frames drained together") the offer is delivered
    // SYNCHRONOUSLY beside the end, before either handler runs, so the depth
    // is 2. Start the timer unpaused there and it fires at +2000 inside the
    // offer branch's up-to-eight-second credential fetch, ending the
    // placeholder the offer is one await from adopting.
    const gate: (() => void)[] = [];
    const h = harness({
      fetchTurnCredentials: () =>
        new Promise(res => {
          gate.push(() => res({ iceServers: SERVERS, ttlSeconds: 12 * 3600 }));
        }),
    });
    await h.controller.start();
    h.controller.notePushRing('synthetic-oblig-784', 'P1', 's1');
    // One drain, both frames, NO `whenIdle()` between them.
    h.deliver('P1', { tcm: 'call.end', cid: cidFor(784), r: 'cancelled' });
    h.deliver('P1', offer(cidFor(785), Date.now() + 60_000));

    await jest.advanceTimersByTimeAsync(6_000);
    expect(h.native.dismissPendingIncomingCall).not.toHaveBeenCalled();

    for (const g of gate.splice(0)) g();
    await h.controller.whenIdle();
    await jest.advanceTimersByTimeAsync(5_000);
    expect(h.native.dismissPendingIncomingCall).not.toHaveBeenCalled();
    expect(h.controller.state.name).toBe('incoming_ringing');
  });

  it('stop() fires a decided cancellation instead of dropping it', async () => {
    // Teardown DROPPED it — the placeholder was then dismissed by nothing
    // and rang to the 75-second watchdog after the caller hung up. Firing is
    // safe precisely because it names the ring it decided: a placeholder
    // replaced since is a strict no-op natively.
    const h = await armed('s1', 767);
    h.controller.stop();

    expect(h.native.dismissPendingIncomingCall).toHaveBeenCalledWith('P1', 'cancelled', 's1');
    await jest.advanceTimersByTimeAsync(5_000);
    expect(h.native.dismissPendingIncomingCall).toHaveBeenCalledTimes(1);
  });

  it('stop() takes the push hold down with the obligation', async () => {
    // A hold is a TIMER, and every timer in this file has to die with the ring
    // it measured. Left behind it outlives its own record and finds the NEXT
    // one — see the sibling test below for what it then does to it.
    const h = await armed('s1', 787);
    await jest.advanceTimersByTimeAsync(300);
    h.controller.notePushRing('synthetic-oblig-787b', 'P1', 's1');
    // …and a second push REPLACES that hold rather than stacking beside it.
    // Both are due at the same absolute ceiling, so a leaked one is invisible
    // to every timing assertion in this file — and survives `stop()`, which
    // can only cancel the handle the record still points at.
    await jest.advanceTimersByTimeAsync(300);
    h.controller.notePushRing('synthetic-oblig-787c', 'P1', 's1');
    expect(jest.getTimerCount()).toBe(1);

    h.controller.stop();
    expect(h.native.dismissPendingIncomingCall).toHaveBeenCalledWith('P1', 'cancelled', 's1');
    expect(jest.getTimerCount()).toBe(0);
  });

  it('a hold discharged by the person’s DECLINE cannot release the next ring early', async () => {
    // THE STALE-TIMER CLASS, reached where no frame can clear the hold on the
    // way past. Every other discharge runs inside `handleEnvelope`, so the
    // delivery-time hold has already put the push hold out; a lock-screen
    // decline arrives from CallKit, outside the queue entirely. Left running,
    // that timer fires against the record standing LATER — releasing the next
    // ring's hold onto a deadline already in the past, which is the
    // redial-killing defect reintroduced one call on.
    const h = harness();
    await h.controller.start();
    h.controller.notePushRing('synthetic-oblig-793', 'P1', 's1');
    h.deliver('P1', { tcm: 'call.end', cid: cidFor(793), r: 'cancelled' });
    await h.controller.whenIdle();

    await jest.advanceTimersByTimeAsync(100);
    h.controller.notePushRing('synthetic-oblig-793b', 'P1', 's1');
    // The person declines the placeholder from the lock screen: the branch
    // settles the ring — and must take the hold with it.
    await jest.advanceTimersByTimeAsync(100);
    await h.controller.onCallKitEnd('synthetic-oblig-793b');
    expect(h.native.dismissPendingIncomingCall).not.toHaveBeenCalled();

    // The same peer rings and cancels again: a new hold, ceiling 500 + 4000.
    // The stale one, if it survived, is due at 100 + 4000.
    await jest.advanceTimersByTimeAsync(100);
    h.controller.notePushRing('synthetic-oblig-793c', 'P1', 's2');
    await jest.advanceTimersByTimeAsync(100);
    h.deliver('P1', { tcm: 'call.end', cid: cidFor(794), r: 'cancelled' });
    await h.controller.whenIdle();
    await jest.advanceTimersByTimeAsync(100);
    h.controller.notePushRing('synthetic-oblig-793d', 'P1', 's2');

    await jest.advanceTimersByTimeAsync(4_000);
    expect(h.native.dismissPendingIncomingCall).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(h.native.dismissPendingIncomingCall).toHaveBeenCalledWith('P1', 'cancelled', 's2');
  });

  it('a discharged hold cannot release the peer’s NEXT ring early', async () => {
    // THE STALE-TIMER CLASS, on the newest timer in the file. Discharge deletes
    // the record; if it leaves the hold's timer running, that timer fires later
    // against whatever record stands then — and `releaseCancelPushHold` would
    // dutifully release the NEXT ring's hold and let its decision fire on a
    // deadline already in the past. That is the redial-killing defect,
    // reintroduced one call later by a timer nobody cancelled.
    const h = harness();
    await h.controller.start();
    h.controller.notePushRing('synthetic-oblig-788', 'P1', 's1');
    h.deliver('P1', { tcm: 'call.end', cid: cidFor(788), r: 'cancelled' });
    await h.controller.whenIdle();

    // A hold, then the redial's offer adopting — which discharges it.
    await jest.advanceTimersByTimeAsync(100);
    h.controller.notePushRing('synthetic-oblig-788b', 'P1', 's1');
    await jest.advanceTimersByTimeAsync(100);
    h.deliver('P1', offer(cidFor(789), Date.now() + 60_000));
    await h.controller.whenIdle();
    expect(h.controller.state.name).toBe('incoming_ringing');

    // The SAME peer rings again and cancels again, earning a hold of its own
    // whose ceiling is 500 + 4000. The stale one, if it survived, is due at
    // 100 + 4000 — a full half-second earlier.
    await jest.advanceTimersByTimeAsync(100);
    h.controller.notePushRing('synthetic-oblig-788c', 'P1', 's2');
    await jest.advanceTimersByTimeAsync(100);
    h.deliver('P1', { tcm: 'call.end', cid: cidFor(790), r: 'cancelled' });
    await h.controller.whenIdle();
    await jest.advanceTimersByTimeAsync(100);
    h.controller.notePushRing('synthetic-oblig-788d', 'P1', 's2');

    await jest.advanceTimersByTimeAsync(4_000);
    expect(h.native.dismissPendingIncomingCall).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(h.native.dismissPendingIncomingCall).toHaveBeenCalledWith('P1', 'cancelled', 's2');
  });

  it('cannot outlive the ring it measured', async () => {
    // The obligation always carries a clock, and the branch that settles
    // the placeholder's fate discharges it — so an adopted offer takes it with
    // the notes rather than leaving a timer aimed at a live call.
    const h = await armed('s1', 768);
    await jest.advanceTimersByTimeAsync(100);
    h.deliver('P1', offer(cidFor(769), Date.now() + 60_000));
    await h.controller.whenIdle();
    expect(h.controller.state.name).toBe('incoming_ringing');

    await jest.advanceTimersByTimeAsync(60_000);
    expect(h.native.dismissPendingIncomingCall).not.toHaveBeenCalled();
  });

  it('inherits the earlier deadline of a fuse already lit', async () => {
    // The renewable lease the absolute-grace round closed, re-opened by a new
    // door: appending a `call.end` to a stream of garbage would EXTEND the
    // ring if the decision minted its own two seconds. It takes the earlier of
    // the two clocks instead.
    const h = harness();
    await h.controller.start();
    h.controller.notePushRing('synthetic-oblig-770', 'P1', 's1');
    h.verdict('P1', 'not_call');

    await jest.advanceTimersByTimeAsync(1_500);
    h.deliver('P1', { tcm: 'call.end', cid: cidFor(770), r: 'cancelled' });
    await h.controller.whenIdle();

    await jest.advanceTimersByTimeAsync(499);
    expect(h.native.dismissPendingIncomingCall).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(h.native.dismissPendingIncomingCall).toHaveBeenCalledWith('P1', 'cancelled', 's1');
  });

  it('a speculative verdict cannot outrank it', async () => {
    // Ranking is STRUCTURAL now, not a value in the fuse's reason map: an
    // armed obligation makes `armRingProof` a no-op, so there is exactly one
    // timer and one reason and the guess can neither duplicate the decision
    // nor relabel it .unanswered.
    const h = await armed('s1', 771);
    await jest.advanceTimersByTimeAsync(500);
    h.verdict('P1', 'not_call');
    await jest.advanceTimersByTimeAsync(2_000);

    expect(h.native.dismissPendingIncomingCall).toHaveBeenCalledTimes(1);
    expect(h.native.dismissPendingIncomingCall).toHaveBeenCalledWith('P1', 'cancelled', 's1');
  });

  it('a verdict that armed between delivery and handling is put out, not run alongside', async () => {
    // The window `a speculative verdict cannot outrank it` cannot reach
    // either. Verdicts bypass the queue, so one landing AFTER this frame's
    // delivery park and BEFORE its handler leaves a fuse armed and UNPARKED
    // when the decision arrives. Both timers then sit on the same deadline and
    // the fuse — created first — fires first: the ring is ended .unanswered a
    // beat before the cancellation that decided it, and the missed-call row
    // says this phone ignored a caller who had hung up. The decision puts the
    // guess out rather than racing it.
    const h = harness();
    await h.controller.start();
    h.controller.notePushRing('synthetic-oblig-780', 'P1', 's1');
    h.deliver('P1', { tcm: 'call.end', cid: cidFor(780), r: 'cancelled' });
    h.verdict('P1', 'not_call');
    await h.controller.whenIdle();
    await jest.advanceTimersByTimeAsync(2_500);

    expect(h.native.dismissPendingIncomingCall).toHaveBeenCalledTimes(1);
    expect(h.native.dismissPendingIncomingCall).toHaveBeenCalledWith('P1', 'cancelled', 's1');
  });

  it('a second cancellation cannot restart the clock of the first', async () => {
    // FIRST DECISION WINS. A second `call.end` inside the grace is the same
    // decision restated, and letting it re-arm would make the obligation the
    // renewable lease the absolute-grace round closed — one end frame per
    // second and the placeholder rings on to the 75-second watchdog, which is
    // precisely the stuck ring this whole mechanism exists to bound. Note it
    // cannot be caught by the `min()` either: the obligation writes no
    // speculative deadline, so a re-arm would mint a fresh two seconds.
    const h = await armed('s1', 778);
    await jest.advanceTimersByTimeAsync(1_500);
    h.deliver('P1', { tcm: 'call.end', cid: cidFor(779), r: 'cancelled' });
    await h.controller.whenIdle();

    await jest.advanceTimersByTimeAsync(499);
    expect(h.native.dismissPendingIncomingCall).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(h.native.dismissPendingIncomingCall).toHaveBeenCalledWith('P1', 'cancelled', 's1');
  });

  it('a verdict landing while the decision is HELD cannot burn the ring first', async () => {
    // The other half of ranking, and the half `a speculative verdict cannot
    // outrank it` cannot reach. Verdicts do not go through the queue — they
    // arm on arrival — so one landing while a frame's handler holds the
    // obligation lights a fuse that is NOT held, and it fires first: the ring
    // ends mid-handler, labelled .unanswered, for a call the caller hung up,
    // and the offer stalled in the credential fetch loses the placeholder it
    // was about to adopt. `armRingProof`'s obligation early-return is what
    // makes a guess unable to do that.
    const gate: (() => void)[] = [];
    const h = harness({
      fetchTurnCredentials: () =>
        new Promise(res => {
          gate.push(() => res({ iceServers: SERVERS, ttlSeconds: 12 * 3600 }));
        }),
    });
    await h.controller.start();
    h.controller.notePushRing('synthetic-oblig-776', 'P1', 's1');
    h.deliver('P1', { tcm: 'call.end', cid: cidFor(776), r: 'cancelled' });
    await h.controller.whenIdle();

    // The redial's offer arrives and stalls, holding the decision…
    await jest.advanceTimersByTimeAsync(100);
    h.deliver('P1', offer(cidFor(777), Date.now() + 60_000));
    await jest.advanceTimersByTimeAsync(100);
    // …and a frame verdict lands inside that stall.
    h.verdict('P1', 'not_call');
    await jest.advanceTimersByTimeAsync(10_000);
    expect(h.native.dismissPendingIncomingCall).not.toHaveBeenCalled();

    for (const g of gate.splice(0)) g();
    await h.controller.whenIdle();
    expect(h.controller.state.name).toBe('incoming_ringing');
    expect(h.native.dismissPendingIncomingCall).not.toHaveBeenCalled();
  });

  it('the immediate call.end path names the ring it dismisses', async () => {
    // ORDERING (O1): the cid is read BEFORE `settleRingProof`, which clears it.
    // Read after, it degrades to '' and silently reverts to the peer-keyed
    // match — a revert with no failing test is a revert that ships.
    const h = harness();
    await h.controller.start();
    h.controller.notePushRing('synthetic-oblig-772', 'P1', 's1');
    const cid = cidFor(772);
    h.deliver('P1', offer(cid, h.clock + 60_000));
    await h.controller.whenIdle();
    expect(h.controller.state.name).toBe('incoming_ringing');

    // A ring noted AFTER adoption, so both conjuncts of the immediate path are
    // live and only the cid/peer correlation can decide.
    h.controller.notePushRing('synthetic-oblig-772b', 'P1', 's9');
    h.deliver('P1', { tcm: 'call.end', cid, r: 'cancelled' });
    await h.controller.whenIdle();

    expect(h.native.dismissPendingIncomingCall).toHaveBeenCalledWith('P1', 'cancelled', 's9');
  });

  it('a burning speculative fuse names the ring it was armed against', async () => {
    // The cid is captured at ARM time on this arm too. Read inside the timer
    // it would come back '' — the burn-down spends the notes before it
    // dismisses — which is a silent revert to the peer-keyed match.
    const h = harness();
    await h.controller.start();
    h.controller.notePushRing('synthetic-oblig-773', 'P1', 's1');
    h.verdict('P1', 'not_call');
    await jest.advanceTimersByTimeAsync(2_000);

    expect(h.native.dismissPendingIncomingCall).toHaveBeenCalledWith('P1', 'not_call', 's1');
  });

  it('a settled ring’s cid cannot name a later dismissal', async () => {
    // ONE LIFETIME, ONE DELETION POINT. Adoption spends the notes; the cid goes
    // with them. Left behind, the peer's NEXT dismissal — an end with no note
    // at all, the JS-restart path — would name a placeholder that is already
    // gone, native would refuse it, and the ring would stick to the 75-second
    // watchdog. That is rule 3's twin, not a smaller version of it.
    const h = harness();
    await h.controller.start();
    h.controller.notePushRing('synthetic-oblig-774', 'P1', 's1');
    const cid = cidFor(774);
    h.deliver('P1', offer(cid, h.clock + 60_000));
    await h.controller.whenIdle();
    expect(h.controller.state.name).toBe('incoming_ringing');

    h.deliver('P1', { tcm: 'call.end', cid, r: 'cancelled' });
    await h.controller.whenIdle();

    expect(h.native.dismissPendingIncomingCall).toHaveBeenCalledWith('P1', 'cancelled', '');
  });

  it('degrades to the caller-keyed match when native publishes no ring cid', async () => {
    // CONSTRAINT 5, the JS half. A JS build ahead of the binary sees no
    // `ringCid`; the note stores '' verbatim and every dismissal degrades to
    // exactly today's peer-keyed behaviour. Falling back to the push's OWN cid
    // would be worse than useless: on an `alreadyRinging` push that names a
    // throwaway, and the dismissal would never match — a permanently stuck ring.
    const h = harness();
    await h.controller.start();
    h.controller.notePushRing('synthetic-oblig-775', 'P1');
    h.deliver('P1', { tcm: 'call.end', cid: cidFor(775), r: 'cancelled' });
    await h.controller.whenIdle();
    await jest.advanceTimersByTimeAsync(2_000);

    expect(h.native.dismissPendingIncomingCall).toHaveBeenCalledWith('P1', 'cancelled', '');
  });

  it('a discharge cannot discard the holds of the frames in flight behind it', async () => {
    // ROUND ELEVEN — denial of ring through the OTHER hold, and the counter's
    // own invariant. `cancelHolds` is a COUNT of this peer's frames in flight:
    // incremented at DELIVERY (`start()`), decremented in `onEnvelope`'s
    // `finally`, and owned by that pair alone. A discharge that DELETED the
    // whole entry threw away the shares of every frame already delivered and
    // not yet run, so the next decision read depth ZERO and started its timer
    // UNPAUSED — the exact state the arm-time guard exists to prevent, reached
    // from the other side, and a fire landing inside a handler that is one
    // await from adopting the placeholder.
    //
    // EVERY STEP IS AN ORDINARY PATH, and none of them is synchronous batch
    // delivery: messaging awaits a decrypt and a `markSeen` between frames, so
    // what holds the queue open while the rest of the drain lands is the
    // OFFER'S OWN HANDLER (its credential fetch budgets up to eight seconds),
    // and the window the caller's next push lands in is the display-name
    // update that follows the adoption.
    const creds: (() => void)[] = [];
    let releaseDisplay: (() => void) | undefined;
    let settleGroup: ((v: boolean) => void) | undefined;
    const router = {
      handles: jest.fn((_p: string, e: unknown) => (e as { tcm?: string }).tcm === 'call.gjoin'),
      handle: jest.fn(
        () =>
          new Promise<boolean>(res => {
            settleGroup = res;
          }),
      ),
      liveSessionBusy: () => false,
    };
    const h = harness({
      groupRouter: router,
      fetchTurnCredentials: () =>
        new Promise(res => {
          creds.push(() => res({ iceServers: SERVERS, ttlSeconds: 12 * 3600 }));
        }),
    });
    h.native.updateIncomingCallDisplay.mockImplementationOnce(
      () =>
        new Promise<void>(r => {
          releaseDisplay = r;
        }),
    );
    await h.controller.start();
    h.controller.notePushRing('synthetic-oblig-795', 'P1', 's1');
    h.deliver('P1', { tcm: 'call.end', cid: cidFor(795), r: 'cancelled' });
    await h.controller.whenIdle();

    // The redial's offer arrives and stalls in the credential fetch…
    await jest.advanceTimersByTimeAsync(100);
    h.deliver('P1', offer(cidFor(796), Date.now() + 60_000));
    await jest.advanceTimersByTimeAsync(20);
    // …and the rest of the drain lands behind it, each frame taking a hold of
    // its own that only its own handler may give back.
    h.deliver('P1', { tcm: 'call.end', cid: cidFor(797), r: 'cancelled' });
    h.deliver('P1', { tcm: 'call.gjoin' });

    // The offer ADOPTS — discharging the decision — and stalls again on the
    // display-name update, the first await after that discharge.
    for (const c of creds.splice(0)) c();
    await jest.advanceTimersByTimeAsync(20);
    expect(h.controller.state.name).toBe('incoming_ringing');
    expect(releaseDisplay).toBeDefined();
    // The caller's next push lands in that window and re-notes the ring.
    h.controller.notePushRing('synthetic-oblig-795b', 'P1', 's2');
    releaseDisplay?.();
    await jest.advanceTimersByTimeAsync(20);

    // The queue moves on: the stale end decides a SECOND cancellation, and the
    // group frame behind it is still in its handler, holding it.
    await jest.advanceTimersByTimeAsync(2_500);
    expect(h.native.dismissPendingIncomingCall).not.toHaveBeenCalled();

    // …and the share it must not discard is not a stuck ring either: the
    // handler finishes, the last hold goes back, and the decision fires on the
    // deadline it has always had.
    settleGroup?.(true);
    await h.controller.whenIdle();
    await jest.advanceTimersByTimeAsync(1);
    expect(h.native.dismissPendingIncomingCall).toHaveBeenCalledWith('P1', 'cancelled', 's2');
    expect(h.native.dismissPendingIncomingCall).toHaveBeenCalledTimes(1);
  });

  it('the ceiling elapsing under a STANDING frame hold does not start the countdown', async () => {
    // THE MIRROR OF THE ARM-TIME GUARD, on the release side. The two holds are
    // independent, so a push hold can expire while a frame hold still stands —
    // `a push taken DURING a stalled handler outlives that handler's release`
    // already reaches that state, but settles its handler ~3.8 s before the
    // ceiling, so the ceiling never elapses under the frame hold and the guard
    // is never the thing keeping the timer off.
    //
    // Here it is: decision at T0, the redial's offer stalled in the credential
    // fetch from T0+50 (up to eight seconds is its budget), a further urgent
    // frame's push at T0+300 taking the push hold BESIDE the standing frame
    // hold, and the absolute ceiling elapsing at T0+4300 with that handler
    // still in flight. Started there, the countdown resumes on a deadline
    // already 2.3 s in the past and fires AT ONCE — ending the live ring
    // mid-fetch, clearing `pendingAnswered` with it.
    const creds: (() => void)[] = [];
    const h = harness({
      fetchTurnCredentials: () =>
        new Promise(res => {
          creds.push(() => res({ iceServers: SERVERS, ttlSeconds: 12 * 3600 }));
        }),
    });
    await h.controller.start();
    h.controller.notePushRing('synthetic-oblig-798', 'P1', 's1');
    h.deliver('P1', { tcm: 'call.end', cid: cidFor(798), r: 'cancelled' });
    await h.controller.whenIdle();

    await jest.advanceTimersByTimeAsync(50);
    h.deliver('P1', offer(cidFor(799), Date.now() + 60_000));
    await jest.advanceTimersByTimeAsync(250);
    // THE TIMER COUNTS ARE THE PROOF THIS TEST REACHES THE BRANCH IT NAMES.
    // Without them it passes vacuously: delete the push below and there is no
    // ceiling to elapse, no release to guard, and the frame hold alone keeps
    // the decision quiet — green for a reason that has nothing to do with the
    // guard. The +1 is the push hold being taken beside the standing frame
    // hold; the return to `pending` is that ceiling actually elapsing.
    const pending = jest.getTimerCount();
    h.controller.notePushRing('synthetic-oblig-798b', 'P1', 's1');
    expect(jest.getTimerCount()).toBe(pending + 1);

    // Past the ceiling (300 + 4000) with the frame hold still outstanding.
    await jest.advanceTimersByTimeAsync(4_100);
    expect(jest.getTimerCount()).toBe(pending);
    expect(h.native.dismissPendingIncomingCall).not.toHaveBeenCalled();

    for (const c of creds.splice(0)) c();
    await h.controller.whenIdle();
    await jest.advanceTimersByTimeAsync(1);
    expect(h.controller.state.name).toBe('incoming_ringing');
    expect(h.native.dismissPendingIncomingCall).not.toHaveBeenCalled();
  });

  it('an inert frame in the drain may not hand the push hold to the offer behind it', async () => {
    // ROUND TWELVE, and round ten's defect through a different door. The push
    // hold used to end at the DELIVERY of any frame, on a premise stated at
    // the release and false: that "frames from one drain arrive
    // synchronously", so the offer behind an inert frame would already hold
    // the decision before that frame's handler ended. It does not — messaging
    // awaits a decrypt and a `markSeen` between frames (the call branch in
    // messaging.ts), so a drain spans many turns and one trailing `call.ice`
    // from the CANCELLED call, delivered ahead of the redial's offer, put the
    // hold out, resumed the countdown on the original 2 s deadline and
    // dismissed 2.3 s BEFORE the ceiling — on a placeholder that had been
    // ringing continuously and that the offer 400 ms behind it was about to
    // adopt. `dismissPendingIncomingCall` clears `pendingAnswered` and
    // abandons the parked rebind, so a tap made in that window is discarded.
    //
    // THE CONTROL IS `THE REDIAL: a push riding the same placeholder is not
    // killed inside the hold` above: the identical trace with this one inert
    // frame removed, which has always passed. One inert frame was the whole
    // difference.
    const h = await armed('s1', 801);
    await jest.advanceTimersByTimeAsync(300);
    // The redial's push swaps the countdown for the hold — one timer either
    // way, ceiling 300 + 4000.
    const held = jest.getTimerCount();
    h.controller.notePushRing('synthetic-oblig-801b', 'P1', 's1');
    expect(jest.getTimerCount()).toBe(held);

    // The drain that push woke delivers the cancelled call's last trickled
    // candidate FIRST: schema-valid, matching no call this device ever ran,
    // and handled in a turn of its own well before the offer arrives.
    await jest.advanceTimersByTimeAsync(1_000);
    h.deliver('P1', {
      tcm: 'call.ice',
      cid: cidFor(801),
      c: [{ cand: 'candidate:1 1 udp 1 10.0.0.1 5000 typ host', mid: '0', idx: 0 }],
    });
    // THIS COUNT IS THE PROOF THE TEST PRESSES WHERE ITS TITLE SAYS, read
    // synchronously at DELIVERY and before the handler runs: that is the
    // instant the release lived at, and the defect leaves NO timer standing
    // here at all — the hold destroyed, the countdown not yet restarted.
    expect(jest.getTimerCount()).toBe(held);
    await h.controller.whenIdle();
    // The frame's own handler has come and gone; the hold is still the thing
    // standing between the decision and the ring.
    expect(jest.getTimerCount()).toBe(held);

    // Past the decision's own deadline (2000), inside the ceiling (4300).
    await jest.advanceTimersByTimeAsync(1_100);
    expect(h.native.dismissPendingIncomingCall).not.toHaveBeenCalled();

    // The redial's offer finishes crossing the just-woken socket and adopts
    // the SAME placeholder — the ring never broke.
    h.deliver('P1', offer(cidFor(802), Date.now() + 60_000));
    await h.controller.whenIdle();
    expect(h.controller.state.name).toBe('incoming_ringing');
    await jest.advanceTimersByTimeAsync(60_000);
    expect(h.native.dismissPendingIncomingCall).not.toHaveBeenCalled();
  });

  it('the frame-hold pause is BOUNDED — an unending drain cannot hold the ring past its ceiling (the attack)', async () => {
    // RULE 3's TWIN, and the bound the aggregate never had. Each frame hold
    // is taken at DELIVERY and given back at its HANDLER'S EXIT, and those
    // overlap: while frames keep arriving faster than the queue drains them
    // the count never touches zero, so the countdown was never started AT ALL
    // and a cancelled placeholder rang on to the native 75-second watchdog —
    // defect B's shipped behaviour, reached with frames alone. Bounding one
    // handler (the credential fetch's own 8-second timeout) does not bound
    // the SUM, which is what the declaration used to claim.
    //
    // The frames here route to the group coordinator, whose `handle` is the
    // one production await this suite already models as multi-second
    // (`a push taken DURING a stalled handler outlives that handler's
    // release`, and the two ring-proof park tests). Every frame is one an
    // unblocked account can send.
    const router = {
      handles: jest.fn(() => true),
      handle: jest.fn(
        () =>
          new Promise<boolean>(res => {
            setTimeout(() => res(false), 2_000);
          }),
      ),
      liveSessionBusy: () => false,
    };
    const h = harness({ groupRouter: router });
    await h.controller.start();
    h.controller.notePushRing('synthetic-oblig-803', 'P1', 's1');
    router.handles.mockReturnValue(false);
    h.deliver('P1', { tcm: 'call.end', cid: cidFor(803), r: 'cancelled' });
    await h.controller.whenIdle();
    router.handles.mockReturnValue(true);

    /** One frame a second, each handler taking two: every delivery lands with
     * the previous handler still in flight, so the count never returns to
     * zero. */
    const flood = async (seconds: number): Promise<void> => {
      for (let i = 0; i < seconds; i++) {
        h.deliver('P1', { tcm: 'call.gleave' });
        await jest.advanceTimersByTimeAsync(1_000);
      }
    };

    // INSIDE THE CEILING the pause is the legitimate one this hold exists for
    // — a handler may be one await from adopting the placeholder — and this
    // half is what stops the bound from being a denial of ring.
    await flood(11);
    expect(h.native.dismissPendingIncomingCall).not.toHaveBeenCalled();

    // PAST IT the pause is spent: the next handler to end starts the
    // countdown even with frames still in flight, and the deadline is long
    // gone, so the decision fires. Not suppressed, not rate-limited — the
    // dismissal that was always going to happen, bounded.
    await flood(3);
    expect(h.native.dismissPendingIncomingCall).toHaveBeenCalledWith('P1', 'cancelled', 's1');
    expect(h.native.dismissPendingIncomingCall).toHaveBeenCalledTimes(1);
  });

  it('the spent ceiling may not fire into the REDIAL OFFER already queued behind it', async () => {
    // ROUND THIRTEEN, and round ten's defect through the door round twelve
    // opened. Past the ceiling the countdown is handed back AT A HANDLER'S
    // EXIT with a deadline long in the past, so `Math.max(0, …)` makes it a
    // ZERO-DELAY macrotask — and the queue starts the next handler on a
    // MICROTASK. Handler N+1 is therefore already running, already parked in
    // its credential fetch, when the fire lands; and handler N+1 can be the
    // REDIAL'S OFFER. It rides the same placeholder (`alreadyRinging` leaves
    // native `pendingPush` on the first ring), so the cid matches, and
    // `dismissPendingIncomingCall` clears `pendingAnswered` and abandons the
    // parked rebind: a ring that had been up continuously dies and a tap
    // already made is discarded.
    //
    // NOTHING EXOTIC REACHES IT: six ordinary two-second group handlers, the
    // same model the attack test above uses, every frame one an unblocked
    // account can send. On a phone it is a handful
    // of session frames from a group A and B share sitting in B's backlog.
    const creds: (() => void)[] = [];
    const router = {
      handles: jest.fn((_p: string, e: unknown) => (e as { tcm?: string }).tcm === 'call.gleave'),
      handle: jest.fn(
        () =>
          new Promise<boolean>(res => {
            setTimeout(() => res(false), 2_000);
          }),
      ),
      liveSessionBusy: () => false,
    };
    const h = harness({
      groupRouter: router,
      fetchTurnCredentials: () =>
        new Promise(res => {
          creds.push(() => res({ iceServers: SERVERS, ttlSeconds: 12 * 3600 }));
        }),
    });
    await h.controller.start();
    h.controller.notePushRing('synthetic-oblig-805', 'P1', 's1');
    h.deliver('P1', { tcm: 'call.end', cid: cidFor(805), r: 'cancelled' });
    await h.controller.whenIdle();

    // Six group frames from that peer, each delivered just before the previous
    // handler ends, so the count never touches zero and nothing is ever spent
    // inside the ceiling.
    h.deliver('P1', { tcm: 'call.gleave' });
    for (let i = 0; i < 5; i++) {
      await jest.advanceTimersByTimeAsync(1_900);
      h.deliver('P1', { tcm: 'call.gleave' });
      await jest.advanceTimersByTimeAsync(100);
    }
    // t = 10 000; handler #6 runs [10 000, 12 000]. The redial's offer lands
    // and waits in the queue behind it, holding the decision as it does.
    await jest.advanceTimersByTimeAsync(1_900);
    h.deliver('P1', offer(cidFor(806), Date.now() + 60_000));
    expect(h.native.dismissPendingIncomingCall).not.toHaveBeenCalled();

    // Handler #6 ends at 12 000 — the ceiling, exactly — and hands back a
    // countdown whose deadline is 10 s gone.
    await jest.advanceTimersByTimeAsync(101);
    // THIS IS THE BRANCH-REACH PROOF, and it is why the assertion below is not
    // vacuous: the offer's handler HAS started and IS parked in the credential
    // fetch at the instant the zero-delay fire lands. Without it the test
    // could pass for the wrong reason (an offer that never got that far).
    expect(creds.length).toBe(1);
    expect(h.controller.state.name).toBe('idle');
    expect(h.native.dismissPendingIncomingCall).not.toHaveBeenCalled();

    // …and the ring it adopts is the one that has been up all along.
    for (const c of creds.splice(0)) c();
    await h.controller.whenIdle();
    expect(h.controller.state.name).toBe('incoming_ringing');
    await jest.advanceTimersByTimeAsync(60_000);
    expect(h.native.dismissPendingIncomingCall).not.toHaveBeenCalled();
  });

  it('THE GROUP ARM twin: the spent ceiling may not fire into the redial GINVITE behind it', async () => {
    // RULE 1 — BOTH ARMS. The 1:1 `call.offer` is not the only frame that owns
    // the placeholder: `handles()` routes a `call.ginvite` to the coordinator,
    // and `handleInvite` owns its placeholder on every path of its own
    // (blocked, declined, busy, silenced, expired each dismiss; a ring
    // adopts) — which is exactly why `handle()` reports a ginvite adopted
    // unconditionally. So a group redial rides the condemned placeholder the
    // same way a 1:1 redial does, and the ceiling must not fire into it
    // either.
    //
    // The DECISION here is the group one too: an unclaimed `call.gleave`
    // calling `noteRingCancelled` from inside its own handler, which is
    // where `group.ts` calls it.
    let settleInvite: ((v: boolean) => void) | undefined;
    let armed = false;
    const router = {
      handles: jest.fn((_p: string, e: unknown) => {
        const tcm = (e as { tcm?: string }).tcm;
        return tcm === 'call.gleave' || tcm === 'call.ginvite';
      }),
      handle: jest.fn((p: string, e: unknown) => {
        if ((e as { tcm?: string }).tcm === 'call.ginvite') {
          return new Promise<boolean>(res => {
            settleInvite = res;
          });
        }
        if (!armed) {
          armed = true;
          h.controller.noteRingCancelled(p);
        }
        return new Promise<boolean>(res => {
          setTimeout(() => res(false), 2_000);
        });
      }),
      liveSessionBusy: () => false,
    };
    const h = harness({ groupRouter: router });
    await h.controller.start();
    h.controller.notePushRing('synthetic-oblig-807', 'P1', 's1');

    // The decision, made by the group arm, from inside the first handler.
    h.deliver('P1', { tcm: 'call.gleave' });
    await jest.advanceTimersByTimeAsync(2_000);

    // Five more, each delivered just before the previous handler ends.
    for (let i = 0; i < 5; i++) {
      h.deliver('P1', { tcm: 'call.gleave' });
      await jest.advanceTimersByTimeAsync(1_900);
    }
    // The redial's INVITE lands with the last handler still in flight and
    // waits in the queue behind it.
    h.deliver('P1', { tcm: 'call.ginvite' });
    expect(h.native.dismissPendingIncomingCall).not.toHaveBeenCalled();

    // Past the ceiling (12 000 from the decision, which was made at 2 000)
    // with the invite's own handler now running.
    await jest.advanceTimersByTimeAsync(12_500);
    expect(settleInvite).toBeDefined();
    expect(h.native.dismissPendingIncomingCall).not.toHaveBeenCalled();

    // AND IT IS A HOLD, NOT A SUPPRESSION (rule 3's twin): the invite's
    // handler ends without settling the placeholder, and the decision that was
    // always going to fire fires — on the deadline it has always had.
    settleInvite?.(true);
    await h.controller.whenIdle();
    await jest.advanceTimersByTimeAsync(1);
    expect(h.native.dismissPendingIncomingCall).toHaveBeenCalledWith('P1', 'cancelled', 's1');
    expect(h.native.dismissPendingIncomingCall).toHaveBeenCalledTimes(1);
  });

  it('a DELIVERY that owns the placeholder puts out a countdown the spent ceiling already started', async () => {
    // THE OTHER HALF OF THE EXEMPTION, and the state that makes it necessary.
    // Past the ceiling the countdown can already be RUNNING when the redial's
    // offer is delivered — it is a zero-delay macrotask, and messaging hands
    // the next frame over between a `markSeen` and a decrypt, which is a
    // microtask boundary. Left running, it fires into the handler that is
    // about to adopt the ring. So past the ceiling an ordinary delivery no
    // longer pauses anything, but a delivery that OWNS the placeholder still
    // does.
    let settleGroup: ((v: boolean) => void) | undefined;
    const creds: (() => void)[] = [];
    const router = {
      handles: jest.fn((_p: string, e: unknown) => (e as { tcm?: string }).tcm === 'call.gleave'),
      handle: jest.fn(
        () =>
          new Promise<boolean>(res => {
            settleGroup = res;
          }),
      ),
      liveSessionBusy: () => false,
    };
    const h = harness({
      groupRouter: router,
      fetchTurnCredentials: () =>
        new Promise(res => {
          creds.push(() => res({ iceServers: SERVERS, ttlSeconds: 12 * 3600 }));
        }),
    });
    await h.controller.start();
    h.controller.notePushRing('synthetic-oblig-808', 'P1', 's1');
    h.deliver('P1', { tcm: 'call.end', cid: cidFor(808), r: 'cancelled' });
    await h.controller.whenIdle();

    // One group handler stalls across the whole ceiling, so the count never
    // reaches zero and no countdown has ever been started.
    h.deliver('P1', { tcm: 'call.gleave' });
    await jest.advanceTimersByTimeAsync(12_100);
    expect(h.native.dismissPendingIncomingCall).not.toHaveBeenCalled();
    const quiet = jest.getTimerCount();

    // It ends. Past the ceiling with the count back at zero the countdown is
    // handed back on a deadline 10 s gone — a zero-delay macrotask, PENDING.
    settleGroup?.(false);
    await h.controller.whenIdle();
    expect(jest.getTimerCount()).toBe(quiet + 1);

    // THE PRESS, and the counts are its branch-reach proof: the redial's offer
    // is delivered in that window, before the macrotask runs, and the delivery
    // has to put the countdown out. `quiet` again is that happening.
    h.deliver('P1', offer(cidFor(809), Date.now() + 60_000));
    expect(jest.getTimerCount()).toBe(quiet);

    await jest.advanceTimersByTimeAsync(1);
    expect(creds.length).toBe(1);
    expect(h.native.dismissPendingIncomingCall).not.toHaveBeenCalled();
    for (const c of creds.splice(0)) c();
    await h.controller.whenIdle();
    expect(h.controller.state.name).toBe('incoming_ringing');
    expect(h.native.dismissPendingIncomingCall).not.toHaveBeenCalled();
  });

  it('teardown does not forget the frames in flight, so a decision armed AFTER it still waits for the offer behind it', async () => {
    // ROUND TWELVE WROTE THAT `stop()` COULD CLEAR THE COUNT BECAUSE "IT
    // UNSUBSCRIBES FIRST, SO NOTHING CAN BE COUNTED PAST IT". Unsubscribing
    // stops new DELIVERIES; it does not stop the handlers already on the
    // queue. Those still reach `armCancelObligation` (`stop()` clears the ring
    // cids but not the notes, so the gate is still open), and the fresh
    // obligation read the cleared count as a FALSE ZERO — the exact state the
    // arm-time guard exists to prevent — and started UNPAUSED with the
    // redial's offer sitting in the queue right behind it. It then fired into
    // that offer's credential fetch: this file's oldest defect, reached
    // through teardown.
    //
    // THE TRIGGER, NAMED CORRECTLY (round fourteen — the previous wording said
    // "the person relocks, or the calling screen unmounts", and NEITHER seam
    // stops the controller). Relock runs `endCallOnQuiesce()` → `messaging
    // .stop()` → `disposeGroupCall()`; the controller is untouched, and the
    // calling screen has no teardown of its own. The ONE production caller is
    // the function `startCalling()` returns (src/call/index.ts), installed in
    // `AppContent`'s dep-less mount effect: the JS root going away, with a
    // drain still on the queue carrying a stale cancellation and the redial's
    // offer. Narrow, and not nil — and the state below is what the count is
    // for either way.
    let settleGroup: ((v: boolean) => void) | undefined;
    const creds: (() => void)[] = [];
    const router = {
      handles: jest.fn((_p: string, e: unknown) => (e as { tcm?: string }).tcm === 'call.gleave'),
      handle: jest.fn(
        () =>
          new Promise<boolean>(res => {
            settleGroup = res;
          }),
      ),
      liveSessionBusy: () => false,
    };
    const h = harness({
      groupRouter: router,
      fetchTurnCredentials: () =>
        new Promise(res => {
          creds.push(() => res({ iceServers: SERVERS, ttlSeconds: 12 * 3600 }));
        }),
    });
    await h.controller.start();
    h.controller.notePushRing('synthetic-oblig-810', 'P1', 's1');

    // A stalled group handler holds the queue open, with the stale `call.end`
    // and the redial's offer queued behind it in that order.
    h.deliver('P1', { tcm: 'call.gleave' });
    await jest.advanceTimersByTimeAsync(10);
    h.deliver('P1', { tcm: 'call.end', cid: cidFor(810), r: 'cancelled' });
    h.deliver('P1', offer(cidFor(811), Date.now() + 60_000));
    await jest.advanceTimersByTimeAsync(10);

    // Teardown. No obligation exists yet, so this is not `stop()`'s flush
    // path — it is the count it used to take with it.
    h.controller.stop();
    expect(h.native.dismissPendingIncomingCall).not.toHaveBeenCalled();

    // The stalled handler ends; the end runs AFTER teardown and arms, and the
    // offer's handler starts behind it and parks in the credential fetch.
    settleGroup?.(false);
    await jest.advanceTimersByTimeAsync(2_500);
    // The branch-reach proof: the offer IS mid-fetch, and past the grace.
    expect(creds.length).toBe(1);
    expect(h.native.dismissPendingIncomingCall).not.toHaveBeenCalled();

    // AND IT IS A HOLD, NOT A SUPPRESSION: the handler ends, and the decision
    // teardown armed still fires.
    for (const c of creds.splice(0)) c();
    await h.controller.whenIdle();
    await jest.advanceTimersByTimeAsync(1);
    expect(h.native.dismissPendingIncomingCall).toHaveBeenCalledTimes(1);
  });

  it('…and it waits for the ORDINARY frames in flight too, not only the offer', async () => {
    // THE SAME TEARDOWN FALSE ZERO, pinned on the plain `cancelHolds` half.
    // The test above cannot see it alone: the offer it queues is an owner
    // frame, so the owner guard shields the arm whether or not the count was
    // forgotten. With no owner frame in flight, the count IS the guard — and a
    // decision armed after teardown at a false depth of zero fires two seconds
    // later straight through a handler that is still running.
    const settlers: ((v: boolean) => void)[] = [];
    const router = {
      handles: jest.fn((_p: string, e: unknown) => (e as { tcm?: string }).tcm === 'call.gleave'),
      handle: jest.fn(
        () =>
          new Promise<boolean>(res => {
            settlers.push(res);
          }),
      ),
      liveSessionBusy: () => false,
    };
    const h = harness({ groupRouter: router });
    await h.controller.start();
    h.controller.notePushRing('synthetic-oblig-812', 'P1', 's1');

    h.deliver('P1', { tcm: 'call.gleave' });
    await jest.advanceTimersByTimeAsync(10);
    h.deliver('P1', { tcm: 'call.end', cid: cidFor(812), r: 'cancelled' });
    h.deliver('P1', { tcm: 'call.gleave' });
    await jest.advanceTimersByTimeAsync(10);

    h.controller.stop();
    expect(h.native.dismissPendingIncomingCall).not.toHaveBeenCalled();

    // The first handler ends; the end arms behind it, and the second group
    // handler is still in flight when the grace elapses.
    settlers.shift()?.(false);
    await jest.advanceTimersByTimeAsync(2_500);
    expect(settlers).toHaveLength(1);
    expect(h.native.dismissPendingIncomingCall).not.toHaveBeenCalled();

    // Not suppressed: the last hold goes back and the decision fires.
    settlers.shift()?.(false);
    await h.controller.whenIdle();
    await jest.advanceTimersByTimeAsync(1);
    expect(h.native.dismissPendingIncomingCall).toHaveBeenCalledTimes(1);
  });

  it('the owner holds of frames delivered BEFORE the decision was made still count', async () => {
    // THE FEATURE'S MAIN PATH, and until this round nothing pinned it: both
    // redial tests above arm the obligation FIRST and deliver the offer ten
    // seconds later, so neither can see an owner frame delivered while
    // `cancelObligations` is still empty — which is the ordering the whole
    // thing exists for ("the caller hung up while this phone was dead, both
    // frames drained together"). Moving the owner increment one line down, to
    // below `holdCancelObligation`'s `if (!rec) return`, was GREEN.
    //
    // The ordering is the one this file's comments describe throughout: a
    // stalled handler holds the queue open — the coordinator's awaits, or a
    // credential fetch — while the REST of the drain lands behind it. The
    // decision is therefore armed after the frames that own its placeholder
    // were already delivered.
    //
    // It carries the second unpinned one too: `releaseCancelObligation`
    // DELETING the owner count instead of decrementing it. Two owner frames
    // are in flight here, and the first to end must give back one hold, not
    // both.
    const settlers: { tcm: string; res: (v: boolean) => void }[] = [];
    const creds: (() => void)[] = [];
    const router = {
      handles: jest.fn((_p: string, e: unknown) => {
        const tcm = (e as { tcm?: string }).tcm;
        return tcm === 'call.gleave' || tcm === 'call.ginvite';
      }),
      handle: jest.fn(
        (_p: string, e: unknown) =>
          new Promise<boolean>(res => {
            settlers.push({ tcm: (e as { tcm?: string }).tcm ?? '', res });
          }),
      ),
      liveSessionBusy: () => false,
    };
    const h = harness({
      groupRouter: router,
      fetchTurnCredentials: () =>
        new Promise(res => {
          creds.push(() => res({ iceServers: SERVERS, ttlSeconds: 12 * 3600 }));
        }),
    });
    await h.controller.start();
    h.controller.notePushRing('synthetic-oblig-817', 'P1', 's1');

    // A stalled group handler holds the queue open…
    h.deliver('P1', { tcm: 'call.gleave' });
    await jest.advanceTimersByTimeAsync(10);
    // …while the rest of the drain lands behind it: the cancellation, the
    // redial's INVITE and the redial's OFFER, all delivered with no obligation
    // in existence yet. Both owner holds are taken here or never.
    h.deliver('P1', { tcm: 'call.end', cid: cidFor(817), r: 'cancelled' });
    h.deliver('P1', { tcm: 'call.ginvite' });
    h.deliver('P1', offer(cidFor(818), Date.now() + 60_000));
    await jest.advanceTimersByTimeAsync(10);
    expect(settlers).toHaveLength(1);

    // The stalled handler ends and the cancellation is decided behind it.
    settlers.shift()?.res(false);
    await jest.advanceTimersByTimeAsync(10);
    expect(settlers.map(s => s.tcm)).toEqual(['call.ginvite']);

    // The invite's own handler now stalls across the whole ceiling, so the
    // count never touches zero and no countdown has been started at all.
    await jest.advanceTimersByTimeAsync(12_200);
    expect(h.native.dismissPendingIncomingCall).not.toHaveBeenCalled();

    // It ends PAST the ceiling — the spent-ceiling arm, which starts the
    // countdown with frames still in flight — and the frame still in flight is
    // the redial's offer, whose hold was taken before the decision existed.
    settlers.shift()?.res(true);
    await jest.advanceTimersByTimeAsync(1);
    // Branch-reach proof, before the outcome: the offer's handler is running
    // and parked in the credential fetch.
    expect(creds.length).toBe(1);
    expect(h.controller.state.name).toBe('idle');
    expect(h.native.dismissPendingIncomingCall).not.toHaveBeenCalled();

    // …and the ring it adopts is the one that has been up all along.
    for (const c of creds.splice(0)) c();
    await h.controller.whenIdle();
    expect(h.controller.state.name).toBe('incoming_ringing');
    await jest.advanceTimersByTimeAsync(60_000);
    expect(h.native.dismissPendingIncomingCall).not.toHaveBeenCalled();
  });

  it('an unending drain of call.end frames is bounded — the decision frame does not own the ring', async () => {
    // THE OTHER EDGE OF THE EXEMPT SET, and the direction the attack test
    // above cannot see: it proves that making EVERY frame an owner is caught,
    // and adding exactly one more kind was green. The kind that matters is
    // `call.end`, because it is the frame that DECIDES the cancellation, so
    // exempting it would let the very traffic the decision is made of hold the
    // decision past every bound it has — the stuck ring, reached by a peer
    // repeating the one frame this whole path is about.
    //
    // These ends route to the coordinator, not to the 1:1 branch, exactly as
    // production routes them: `handles()` claims any `call.` frame whose cid
    // belongs to a live session, and a leg's end is ordinary session traffic.
    // That is also what gives them the multi-second handler the overlap needs.
    const SESSION_CID = cidFor(819);
    const router = {
      handles: jest.fn((_p: string, e: unknown) => (e as { cid?: string }).cid === SESSION_CID),
      handle: jest.fn(
        () =>
          new Promise<boolean>(res => {
            setTimeout(() => res(false), 2_000);
          }),
      ),
      liveSessionBusy: () => false,
    };
    const h = harness({ groupRouter: router });
    await h.controller.start();
    h.controller.notePushRing('synthetic-oblig-820', 'P1', 's1');
    h.deliver('P1', { tcm: 'call.end', cid: cidFor(821), r: 'cancelled' });
    await h.controller.whenIdle();

    /** One a second into a two-second handler: every delivery lands with the
     * previous handler still in flight, so the count never returns to zero. */
    const flood = async (seconds: number): Promise<void> => {
      for (let i = 0; i < seconds; i++) {
        h.deliver('P1', { tcm: 'call.end', cid: SESSION_CID, r: 'cancelled' });
        await jest.advanceTimersByTimeAsync(1_000);
      }
    };

    await flood(11);
    expect(h.native.dismissPendingIncomingCall).not.toHaveBeenCalled();

    await flood(3);
    expect(h.native.dismissPendingIncomingCall).toHaveBeenCalledWith('P1', 'cancelled', 's1');
    expect(h.native.dismissPendingIncomingCall).toHaveBeenCalledTimes(1);
  });

  it('TEARDOWN may not fire the decision into the REDIAL OFFER already in flight', async () => {
    // ROUND FOURTEEN, and rule 1's lesson restated: round thirteen put the
    // owner exemption in `startCancelTimer` only, and `stop()` does not use a
    // countdown. Its flush calls `fireCancelObligation` DIRECTLY, so the
    // dismissal reached the bridge with the redial's offer parked in its
    // credential fetch — round ten's defect verbatim, through the one door the
    // exemption did not cover. `stop()`'s own justification ("a placeholder
    // replaced since is a strict no-op natively") is the argument round
    // thirteen demolished: on a cancel-then-redial the placeholder is NOT
    // replaced — native's `alreadyRinging` branch keeps `pendingPush` on the
    // first ring — so the cid matches, `pendingAnswered` is cleared and the
    // parked rebind is abandoned.
    //
    // The trigger is the JS root going away with a drain in flight: the only
    // production `stop()` is the teardown `startCalling()` returns
    // (src/call/index.ts), installed in a mount effect with no deps in
    // `AppContent`. NOT a relock — that seam runs `endCallOnQuiesce()` and
    // `messaging.stop()` and never stops the controller — and the two tests
    // above said otherwise until this round.
    const creds: (() => void)[] = [];
    const h = harness({
      fetchTurnCredentials: () =>
        new Promise(res => {
          creds.push(() => res({ iceServers: SERVERS, ttlSeconds: 12 * 3600 }));
        }),
    });
    await h.controller.start();
    h.controller.notePushRing('synthetic-oblig-813', 'P1', 's1');

    // The cancellation is decided, and its countdown is running.
    h.deliver('P1', { tcm: 'call.end', cid: cidFor(813), r: 'cancelled' });
    await h.controller.whenIdle();

    // The redial's offer — the frame that owns this very placeholder — is
    // delivered and its handler is now parked in the credential fetch.
    h.deliver('P1', offer(cidFor(814), Date.now() + 60_000));
    await jest.advanceTimersByTimeAsync(1);
    // THE BRANCH-REACH PROOF, asserted BEFORE the outcome: without it this
    // could pass for the wrong reason (an offer that never got that far).
    expect(creds.length).toBe(1);
    expect(h.controller.state.name).toBe('idle');
    expect(h.native.dismissPendingIncomingCall).not.toHaveBeenCalled();

    h.controller.stop();
    expect(h.native.dismissPendingIncomingCall).not.toHaveBeenCalled();

    // AND IT IS A DEFERRAL, NOT A DROP (rule 3's twin). The handler that owns
    // the placeholder finishes and ends it itself — teardown disposed the
    // service under it, so the offer cannot be adopted and its own refusal
    // path dismisses. The ring does not survive teardown; it survives only for
    // as long as the frame that might have claimed it is still running.
    for (const c of creds.splice(0)) c();
    await h.controller.whenIdle();
    await jest.advanceTimersByTimeAsync(2_100);
    // ONE dismissal, and it is the OWNER'S OWN — the offer branch's
    // reducer-refused path, since the disposed service could not adopt it. The
    // deferred decision then finds nothing left to end (that path discharges
    // it), which is the deferral working: the frame that owns the ring is the
    // one that ends it. The empty cid is the pre-existing post-teardown
    // caller-keyed dismissal (`stop()` clears the ring cids), untouched by
    // this round and asserted here so the next change to it is visible.
    expect(h.native.dismissPendingIncomingCall).toHaveBeenCalledWith('P1', 'declined', '');
    expect(h.native.dismissPendingIncomingCall).toHaveBeenCalledTimes(1);
  });

  it('THE GROUP ARM twin: teardown defers to the GINVITE in flight, and the deferral still fires', async () => {
    // RULE 1 — BOTH ARMS, and this one carries the half the 1:1 arm cannot:
    // the invite's handler ends WITHOUT settling the placeholder (the router
    // reports it adopted, the coordinator's own refusals having been skipped),
    // so nothing but the deferred obligation is left to end the ring. If
    // teardown drops the record instead of leaving it — which is what
    // `cancelObligations.clear()` did, one line under the flush — the
    // placeholder rings to the 75-second watchdog with nothing aimed at it.
    // Suppressing the fire and dropping the record are the same defect twice
    // over: denial of ring one way, the stuck ring the other.
    let settleInvite: ((v: boolean) => void) | undefined;
    const router = {
      handles: jest.fn((_p: string, e: unknown) => (e as { tcm?: string }).tcm === 'call.ginvite'),
      handle: jest.fn(
        () =>
          new Promise<boolean>(res => {
            settleInvite = res;
          }),
      ),
      liveSessionBusy: () => false,
    };
    const h = harness({ groupRouter: router });
    await h.controller.start();
    h.controller.notePushRing('synthetic-oblig-815', 'P1', 's1');

    h.deliver('P1', { tcm: 'call.end', cid: cidFor(815), r: 'cancelled' });
    await h.controller.whenIdle();

    h.deliver('P1', { tcm: 'call.ginvite' });
    await jest.advanceTimersByTimeAsync(1);
    expect(settleInvite).toBeDefined();
    expect(h.native.dismissPendingIncomingCall).not.toHaveBeenCalled();

    h.controller.stop();
    expect(h.native.dismissPendingIncomingCall).not.toHaveBeenCalled();

    // The invite's handler ends without settling the placeholder, and the
    // decision teardown could not fire fires — on the deadline it has always
    // had, naming the ring it decided.
    settleInvite?.(true);
    await h.controller.whenIdle();
    await jest.advanceTimersByTimeAsync(2_100);
    expect(h.native.dismissPendingIncomingCall).toHaveBeenCalledWith('P1', 'cancelled', 's1');
    expect(h.native.dismissPendingIncomingCall).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// THE TWO PARKS, PINNED SEPARATELY.
//
// A frame's arrival parks this peer's speculative fuse at TWO points — once
// synchronously at delivery (`start()`'s listener) and once at the top of its
// own handler (`handleEnvelope`). They look redundant and are not, and until
// this block deleting BOTH was green: a `call.ginvite` draining one frame
// behind an inert frame, its handler stalled in the coordinator's awaits, had
// its placeholder dismissed mid-handling — an earlier round's HIGH finding,
// verbatim.
//
// The window each one owns is the window the other cannot see:
//   • DELIVERY parks fuses armed while an EARLIER frame's handler is still
//     running. This frame's handler has not begun and may not for seconds, so
//     its own handler-top park is unreachable.
//   • HANDLER-TOP parks fuses armed AFTER this frame was delivered — its
//     delivery park has already run and cannot see them.
// Verdicts are what arm inside those windows: they bypass the queue entirely.
// ---------------------------------------------------------------------------

describe('the two ring-proof parks', () => {
  /** A router whose `handle` hangs until released, one deferred per frame. */
  function stallingRouter() {
    const pending: { resolve: (v: boolean) => void; reject: (e: Error) => void }[] = [];
    return {
      pending,
      router: {
        handles: jest.fn(() => true),
        handle: jest.fn(
          () =>
            new Promise<boolean>((resolve, reject) => {
              pending.push({ resolve, reject });
            }),
        ),
        liveSessionBusy: () => false,
      },
    };
  }

  it('DELIVERY: a frame that has arrived parks a fuse lit while the queue is stalled', async () => {
    const { pending, router } = stallingRouter();
    const h = harness({ groupRouter: router });
    await h.controller.start();
    h.controller.notePushRing('synthetic-park-790', 'P1', 's1');

    // Frame A is in its handler, stalled in the coordinator's awaits.
    h.deliver('P1', { tcm: 'call.gleave' });
    await jest.advanceTimersByTimeAsync(0);
    expect(pending).toHaveLength(1);

    // A verdict lights the fuse from OUTSIDE the queue, mid-stall.
    h.verdict('P1', 'not_call');
    // The invite arrives behind it. Its handler cannot start — A owns the
    // queue — so only its DELIVERY park can put this fuse out.
    h.deliver('P1', { tcm: 'call.ginvite' });

    await jest.advanceTimersByTimeAsync(2_500);
    expect(h.native.dismissPendingIncomingCall).not.toHaveBeenCalled();
  });

  it('HANDLER-TOP: a frame parks a fuse lit after its own delivery', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { pending, router } = stallingRouter();
    const h = harness({ groupRouter: router });
    await h.controller.start();
    h.controller.notePushRing('synthetic-park-791', 'P1', 's1');

    h.deliver('P1', { tcm: 'call.gleave' });
    await jest.advanceTimersByTimeAsync(0);
    // The invite is delivered NOW, so its delivery park runs before the fuse
    // below exists and can never see it.
    h.deliver('P1', { tcm: 'call.ginvite' });
    h.verdict('P1', 'not_call');

    // A throws — the one exit that neither adopts (which parks) nor settles,
    // so the fuse is still lit and unparked when the invite's handler begins.
    pending[0].reject(new Error('boom'));
    await jest.advanceTimersByTimeAsync(0);
    expect(pending).toHaveLength(2);

    await jest.advanceTimersByTimeAsync(2_500);
    expect(h.native.dismissPendingIncomingCall).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// THE SECOND TIMER AIMED AT THIS PLACEHOLDER (round fifteen).
//
// Round thirteen exempted the frame that owns the ring from the DECISION's
// countdown; round fourteen found the decision's other door (teardown) and
// moved the guard to `fireCancelObligation`, where both meet. Neither touched
// the GUESS. `armRingProof`'s burn-down is a bare `setTimeout` — structurally
// the same object as the countdown — that dismisses the same placeholder by the
// same cid, and it consults `cancelObligations` and `peerHasPushRing` and
// nothing else.
//
// The two parks cannot cover it. Both fire at or before a handler's first line
// (delivery, and handler-top), and a verdict is emitted from messaging's own
// drain OUTSIDE the serialized queue — so a verdict that lands WHILE an owner's
// handler runs arms a fuse nothing will ever park. The offer branch retires the
// old deadline at its top, deliberately, so that verdict mints a FRESH two
// seconds — inside a credential fetch bounded at EIGHT.
//
// On a phone, with no attacker and no cancellation: A calls B, B's phone wakes
// on the push, and the drain carries the offer plus one ordinary text ("calling
// you now" — EVERY non-call payload is a 'not_call' verdict). The offer's
// handler is in its TURN fetch on a radio that just woke. At +2 s the ring the
// person is looking at ends, CallKit files .unanswered, a tap already made is
// discarded (`pendingAnswered`), the parked rebind is abandoned — and the call
// re-rings from scratch seconds later.
// ---------------------------------------------------------------------------

describe('the speculative fuse and the frame that OWNS the ring', () => {
  it('a verdict landing INSIDE the offer’s credential fetch may not burn the ring it is one await from adopting', async () => {
    const creds: (() => void)[] = [];
    const h = harness({
      fetchTurnCredentials: () =>
        new Promise(res => {
          creds.push(() => res({ iceServers: SERVERS, ttlSeconds: 12 * 3600 }));
        }),
    });
    await h.controller.start();
    // The plain FIRST ring — no `call.end` anywhere in this trace, so no
    // decision stands and `cancelObligations` (the fuse's only interlock) is
    // empty. The notes are unspent until adoption, so `peerHasPushRing` is
    // true and `ringCidFor` still names the live placeholder.
    h.controller.notePushRing('synthetic-fuse-840', 'P1', 's1');

    h.deliver('P1', offer(cidFor(840), Date.now() + 60_000));
    await jest.advanceTimersByTimeAsync(1);
    // THE BRANCH-REACH PROOF, asserted BEFORE the outcome: the handler is
    // genuinely parked in `ensureCredentials`, not somewhere adjacent.
    expect(creds.length).toBe(1);
    expect(h.controller.state.name).toBe('idle');

    // …and the ordinary text message from the same caller drains behind the
    // offer. Its verdict bypasses the queue entirely.
    h.verdict('P1', 'not_call');
    await jest.advanceTimersByTimeAsync(2_500);
    expect(h.native.dismissPendingIncomingCall).not.toHaveBeenCalled();

    // The radio comes back and the offer adopts the ring it always owned.
    for (const c of creds.splice(0)) c();
    await h.controller.whenIdle();
    await jest.advanceTimersByTimeAsync(2_500);
    expect(h.native.dismissPendingIncomingCall).not.toHaveBeenCalled();
    expect(h.native.reportIncomingCall).toHaveBeenCalledTimes(1);
    expect(h.controller.state.name).toBe('incoming_ringing');
  });

  it('THE GROUP ARM twin: a verdict landing inside the GINVITE’s handler, and the deferral still fires', async () => {
    // RULE 1's other arm, and it carries the half the 1:1 arm cannot: this
    // invite is REFUSED by the coordinator, so nothing settles the placeholder
    // and the deferred verdict is the only thing left aimed at it. Suppressing
    // the burn and dropping it are the same defect twice over — denial of ring
    // one way, the stuck ring the other.
    let settleInvite: ((v: boolean) => void) | undefined;
    const router = {
      handles: jest.fn((_p: string, e: unknown) => (e as { tcm?: string }).tcm === 'call.ginvite'),
      handle: jest.fn(
        () =>
          new Promise<boolean>(res => {
            settleInvite = res;
          }),
      ),
      liveSessionBusy: () => false,
    };
    const h = harness({ groupRouter: router });
    await h.controller.start();
    h.controller.notePushRing('synthetic-fuse-841', 'P1', 's1');

    h.deliver('P1', { tcm: 'call.ginvite' });
    await jest.advanceTimersByTimeAsync(1);
    expect(settleInvite).toBeDefined();

    h.verdict('P1', 'not_call');
    await jest.advanceTimersByTimeAsync(2_500);
    expect(h.native.dismissPendingIncomingCall).not.toHaveBeenCalled();

    // The coordinator refuses the invite — it claimed nothing, so the
    // placeholder's fate is exactly what the verdict said it was.
    settleInvite?.(false);
    await h.controller.whenIdle();
    await jest.advanceTimersByTimeAsync(1);
    expect(h.native.dismissPendingIncomingCall).toHaveBeenCalledWith('P1', 'not_call', 's1');
    expect(h.native.dismissPendingIncomingCall).toHaveBeenCalledTimes(1);
  });

  it('the REASON travels with the deferral — a withheld fuse does not relabel the call', async () => {
    // The reason is not cosmetic anywhere else in this file and it is not here
    // either: it is the log line that says whether the ciphertext never
    // decrypted or decrypted to something that was not a call. A resume that
    // supplied its own default would silently relabel every deferred burn.
    let settleInvite: ((v: boolean) => void) | undefined;
    const router = {
      handles: jest.fn((_p: string, e: unknown) => (e as { tcm?: string }).tcm === 'call.ginvite'),
      handle: jest.fn(
        () =>
          new Promise<boolean>(res => {
            settleInvite = res;
          }),
      ),
      liveSessionBusy: () => false,
    };
    const h = harness({ groupRouter: router });
    await h.controller.start();
    h.controller.notePushRing('synthetic-fuse-845', 'P1', 's1');

    h.deliver('P1', { tcm: 'call.ginvite' });
    await jest.advanceTimersByTimeAsync(1);
    expect(settleInvite).toBeDefined();
    h.verdict('P1', 'undecryptable');
    await jest.advanceTimersByTimeAsync(2_500);
    expect(h.native.dismissPendingIncomingCall).not.toHaveBeenCalled();

    settleInvite?.(false);
    await h.controller.whenIdle();
    await jest.advanceTimersByTimeAsync(1);
    expect(h.native.dismissPendingIncomingCall).toHaveBeenCalledWith('P1', 'invalid', 's1');
  });

  it('an ADOPTED invite PARKS the withheld fuse, exactly as it parks a lit one — and does not destroy it', async () => {
    // THE OTHER DIRECTION, and the reason the deferral is a park rather than a
    // fuse that survives everything. `adopted` is true for every ginvite, and
    // the coordinator's own ring is reported through native's rebind — which is
    // PARKED while the placeholder's report verdict is still in flight, so
    // `pendingPush` still stands and a dismissal landing there is NOT the
    // harmless no-op it is after the rebind completes: it abandons the rebind
    // and the answer with it. A verdict deferred inside that handler must
    // therefore be put out by the adoption, exactly as a lit fuse is.
    let settleInvite: ((v: boolean) => void) | undefined;
    const router = {
      handles: jest.fn((_p: string, e: unknown) => (e as { tcm?: string }).tcm === 'call.ginvite'),
      handle: jest.fn(
        () =>
          new Promise<boolean>(res => {
            settleInvite = res;
          }),
      ),
      liveSessionBusy: () => false,
    };
    const h = harness({ groupRouter: router });
    await h.controller.start();
    h.controller.notePushRing('synthetic-fuse-843', 'P1', 's1');

    h.deliver('P1', { tcm: 'call.ginvite' });
    await jest.advanceTimersByTimeAsync(1);
    expect(settleInvite).toBeDefined();
    h.verdict('P1', 'not_call');
    await jest.advanceTimersByTimeAsync(2_500);

    settleInvite?.(true);
    await h.controller.whenIdle();
    await jest.advanceTimersByTimeAsync(2_500);
    expect(h.native.dismissPendingIncomingCall).not.toHaveBeenCalled();

    // …AND NOT A DROP. The absolute deadline outlives the park, so the next
    // inert frame resumes it at zero — the guess was deferred by the adoption,
    // never destroyed by it.
    h.verdict('P1', 'not_call');
    await jest.advanceTimersByTimeAsync(1);
    expect(h.native.dismissPendingIncomingCall).toHaveBeenCalledWith('P1', 'not_call', 's1');
  });

  it('TEARDOWN drops the withheld GUESS — it does not MINT a fresh grace after stop()', async () => {
    // Teardown fires DECISIONS and drops GUESSES, which is the whole of
    // `cancelObligations` vs the fuse, and `stop()` clears the absolute
    // deadlines to do it. A withheld fuse surviving that clear would reach
    // `armRingProof` with no deadline standing and MINT one — a fresh two
    // seconds, clocked after the controller stopped, ending a ring it no longer
    // measures with an empty cid.
    //
    // The THROWING exit is what isolates it. Every other owner exit either
    // parks (adoption, and the 1:1 branch's own settlement) or arms again from
    // inside the handler (`adopted === false`, a refused parse) — and those
    // arm post-teardown today, unchanged by this round, because `stop()`
    // unsubscribes but does not stop the handlers already on the queue. A throw
    // reaches neither: `onEnvelope`'s catch re-arms only while a deadline
    // stands, and teardown has just cleared them all.
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    let failInvite: ((e: Error) => void) | undefined;
    const router = {
      handles: jest.fn((_p: string, e: unknown) => (e as { tcm?: string }).tcm === 'call.ginvite'),
      handle: jest.fn(
        () =>
          new Promise<boolean>((_res, rej) => {
            failInvite = rej;
          }),
      ),
      liveSessionBusy: () => false,
    };
    const h = harness({ groupRouter: router });
    await h.controller.start();
    h.controller.notePushRing('synthetic-fuse-844', 'P1', 's1');

    h.deliver('P1', { tcm: 'call.ginvite' });
    await jest.advanceTimersByTimeAsync(1);
    expect(failInvite).toBeDefined();
    h.verdict('P1', 'not_call');

    h.controller.stop();
    failInvite?.(new Error('boom'));
    await h.controller.whenIdle();
    await jest.advanceTimersByTimeAsync(2_500);
    expect(h.native.dismissPendingIncomingCall).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('CONTROL: the same offer drain WITHOUT the mid-flight verdict rings normally', async () => {
    // Green before and after: proof the two above fail for the verdict and not
    // for the stall, and that the fix does not delay an ordinary first ring.
    const creds: (() => void)[] = [];
    const h = harness({
      fetchTurnCredentials: () =>
        new Promise(res => {
          creds.push(() => res({ iceServers: SERVERS, ttlSeconds: 12 * 3600 }));
        }),
    });
    await h.controller.start();
    h.controller.notePushRing('synthetic-fuse-842', 'P1', 's1');

    h.deliver('P1', offer(cidFor(842), Date.now() + 60_000));
    await jest.advanceTimersByTimeAsync(1);
    expect(creds.length).toBe(1);

    await jest.advanceTimersByTimeAsync(2_500);
    for (const c of creds.splice(0)) c();
    await h.controller.whenIdle();

    expect(h.native.dismissPendingIncomingCall).not.toHaveBeenCalled();
    expect(h.native.reportIncomingCall).toHaveBeenCalledTimes(1);
    expect(h.controller.state.name).toBe('incoming_ringing');
  });
});

// ---------------------------------------------------------------------------
// A stale absolute deadline must not condemn
// the peer's NEXT ring.
// ---------------------------------------------------------------------------

describe('a stale ring-proof deadline from a previous call', () => {
  // The mechanism, end to end. Adoption retires the deadline but the noted
  // push ring survives it, so after one push-originated call
  // `peerHasPushRing(P)` stays true for the rest of the process. Any
  // mid-call NON-call payload from P — every text message is a 'not_call'
  // verdict (messaging.ts: the shape is the verdict) — then passes that
  // stale gate and fixes a FRESH absolute deadline. The call's own live
  // signalling parks the fuse (at delivery and at the handler), and the
  // live-match sweep declines to re-arm, so the deadline is ORPHANED: no
  // timer owns it, nothing retires it. The peer's next legitimate ring
  // inherits it hours later: the first inert frame draining ahead of the
  // offer arms at Math.max(0, stalePastDeadline - now) = 0 and burns before
  // the offer can decrypt — and the native dismiss clears `pendingAnswered`
  // and abandons the parked rebind (CallKitCenter), discarding even an
  // answer the person had ALREADY TAPPED. The trigger is ordinary: "text
  // me, then call me" on a backgrounded phone. No attacker required.

  it('an adopted call, mid-call chatter, then a later ring: the second ring survives its drain', async () => {
    const h = harness();
    await h.controller.start();

    // A push-originated call from P1, adopted normally.
    h.controller.notePushRing('synthetic-stale-1', 'P1');
    const cid1 = cidFor(720);
    h.deliver('P1', offer(cid1, Date.now() + 60_000));
    await h.controller.whenIdle();
    expect(h.native.reportIncomingCall).toHaveBeenCalledTimes(1);

    // Mid-call, P1's non-call payload (a text) resolves as 'not_call'…
    h.verdict('P1', 'not_call');
    // …and 100 ms later ordinary live-call signalling drains, parking
    // whatever fuse that verdict armed.
    await jest.advanceTimersByTimeAsync(100);
    h.deliver('P1', { tcm: 'call.ringing', cid: cid1 });
    await h.controller.whenIdle();

    // The call ends normally.
    await h.controller.onCallKitEnd(cid1);
    await h.controller.whenIdle();
    expect(h.controller.state.name).toBe('idle');

    // Hours pass.
    await jest.advanceTimersByTimeAsync(3_600_000);
    h.native.dismissPendingIncomingCall.mockClear();
    h.native.reportIncomingCall.mockClear();

    // P1 legitimately rings again — "text me, then call me": the push is
    // noted, the text drains one frame ahead of the offer…
    h.controller.notePushRing('synthetic-stale-2', 'P1');
    h.verdict('P1', 'not_call');
    // …and the offer is 50 ms behind it.
    await jest.advanceTimersByTimeAsync(50);
    const cid2 = cidFor(721);
    h.deliver('P1', offer(cid2, Date.now() + 60_000));
    await h.controller.whenIdle();
    // Give the full grace after adoption: a surviving fuse would burn here.
    await jest.advanceTimersByTimeAsync(2_500);

    // The legitimate second ring was NOT dismissed — not in the 50 ms before
    // its offer arrived, and not afterwards…
    expect(h.native.dismissPendingIncomingCall).not.toHaveBeenCalledWith('P1', 'not_call', '');
    expect(h.native.dismissPendingIncomingCall).not.toHaveBeenCalledWith('P1', 'invalid', '');
    // …and it adopted normally.
    expect(h.native.reportIncomingCall).toHaveBeenCalledTimes(1);
    expect(h.controller.state.name).toBe('incoming_ringing');
    expect(h.controller.state.call?.cid).toBe(cid2);
  });

  it('CONTROL: the same drain for a peer with no prior call rings normally', async () => {
    // Passes both BEFORE and AFTER the fix: proof the advancing-clock
    // harness did not change what the sequence means, and that the fix does
    // not delay or damage an ordinary first ring (the standing guarantee).
    const h = harness();
    await h.controller.start();

    h.controller.notePushRing('synthetic-stale-3', 'P2');
    h.verdict('P2', 'not_call');
    await jest.advanceTimersByTimeAsync(50);
    const cid = cidFor(722);
    h.deliver('P2', offer(cid, Date.now() + 60_000));
    await h.controller.whenIdle();
    await jest.advanceTimersByTimeAsync(2_500);

    expect(h.native.dismissPendingIncomingCall).not.toHaveBeenCalledWith('P2', 'not_call', '');
    expect(h.native.reportIncomingCall).toHaveBeenCalledTimes(1);
    expect(h.controller.state.name).toBe('incoming_ringing');
    expect(h.controller.state.call?.cid).toBe(cid);
  });
});

// ---------------------------------------------------------------------------
// The group arm must not hand out a free reset of the absolute grace.
// ---------------------------------------------------------------------------

describe('a group-adopted frame and the absolute grace', () => {
  // `adopted` is true for EVERY `call.ginvite`, and for any gjoin/gleave a
  // live session claims — a peer who merely holds a session open can reach
  // the group-adopted branch at will. When that branch RETIRED the ring
  // proof, it deleted the absolute deadline while the surviving 1:1 push
  // note kept `peerHasPushRing` true, so the next inert frame minted a
  // FRESH two seconds: alternating ginvite / inert faster than the grace
  // kept a garbage placeholder ringing to the native 75-second watchdog,
  // with frames only — exactly the renewable lease the absolute-grace fix closed. The
  // branch must PARK instead while a note stands: the fuse clears (a
  // ginvite one frame behind a stale delta still wins the door), but the
  // deadline survives, so a later inert frame resumes the remainder.

  /** A router whose group arm always adopts: the stand-in for a peer who
   * holds a live session (gjoin/gleave adopted) or sends ginvites (adopted
   * unconditionally). The stub keeps the timing under this file's control;
   * the shipped coordinator's own verdicts are pinned in call.group.test.ts. */
  function adoptingRouter() {
    return {
      handles: (_p: string, e: unknown) =>
        typeof e === 'object' &&
        e !== null &&
        typeof (e as { tcm?: unknown }).tcm === 'string' &&
        (e as { tcm: string }).tcm.startsWith('call.g'),
      handle: async () => true,
      liveSessionBusy: () => false,
    };
  }

  it('an adopted group frame PARKS: a later inert frame resumes the remainder, never a fresh grace', async () => {
    const h = harness({ groupRouter: adoptingRouter() });
    await h.controller.start();

    h.controller.notePushRing('synthetic-fb1-a', 'P1');
    // The first inert frame fixes the deadline at now + 2000…
    h.verdict('P1', 'not_call');
    await jest.advanceTimersByTimeAsync(1_500);

    // …an adopted group frame lands at +1500: it may clear the FUSE, but
    // the deadline must stand.
    h.deliver('P1', { tcm: 'call.ginvite' });
    await h.controller.whenIdle();

    await jest.advanceTimersByTimeAsync(400);
    // At +1900 another inert frame arms — it must get the 100 ms remainder
    // of the ORIGINAL deadline, not a fresh two seconds.
    h.verdict('P1', 'not_call');
    await jest.advanceTimersByTimeAsync(200);

    // +2100: past the original deadline. The ring is dead ON TIME.
    expect(h.native.dismissPendingIncomingCall).toHaveBeenCalledWith('P1', 'not_call', '');
  });

  it('alternating adopted group frames and inert frames cannot outrun the grace (the attack)', async () => {
    // The re-gate's exact attack, all frames from one peer holding a live
    // 1:1 push placeholder: inert frame, adopted group frame, repeat, each
    // under two seconds apart. With the retire in place this looped forever
    // — the fuse never burned. The grace is absolute: the ring must be dead
    // shortly after the first deadline, no matter how the drain interleaves.
    const h = harness({ groupRouter: adoptingRouter() });
    await h.controller.start();

    h.controller.notePushRing('synthetic-fb1-b', 'P1');
    for (let i = 0; i < 4; i++) {
      h.verdict('P1', 'not_call');
      await jest.advanceTimersByTimeAsync(1_000);
      h.deliver('P1', { tcm: 'call.ginvite' });
      await h.controller.whenIdle();
      await jest.advanceTimersByTimeAsync(1_000);
    }

    // Eight seconds of frames-only pressure against a 2-second grace.
    expect(h.native.dismissPendingIncomingCall).toHaveBeenCalledWith('P1', 'not_call', '');
  });

  it('adoption SPENDS the notes: mid-call chatter after a 1:1 adoption arms nothing', async () => {
    // Pins the settle AT THE ADOPTION SITE specifically. Without it the note
    // survives adoption, and the first non-call payload from the peer — any
    // text — arms a fuse mid-call; with no live signalling arriving behind
    // it to park it, the fuse burns and the dismiss bridge is crossed for a
    // call that is genuinely live. (The front-door retire in notePushRing
    // cannot rescue this: no new push is involved.)
    const h = harness();
    await h.controller.start();

    h.controller.notePushRing('synthetic-fb1-c', 'P1');
    h.deliver('P1', offer(cidFor(730), Date.now() + 60_000));
    await h.controller.whenIdle();
    expect(h.native.reportIncomingCall).toHaveBeenCalledTimes(1);

    // Mid-call, a text from the same peer resolves as 'not_call' — and
    // nothing else arrives to park whatever it might arm.
    h.verdict('P1', 'not_call');
    await jest.advanceTimersByTimeAsync(2_500);

    expect(h.native.dismissPendingIncomingCall).not.toHaveBeenCalled();
  });

  it('a deadline surviving a parked group adoption cannot condemn the peer\'s NEXT ring', async () => {
    // Pins the front-door retire in notePushRing specifically. The park
    // above deliberately leaves the deadline standing (and the note with
    // it); the ONE thing that may mint a fresh clock is a fresh push, and
    // notePushRing must retire the stale remains first — or the next ring's
    // first inert frame resumes an hours-expired deadline at ZERO and burns
    // before the offer one frame behind it can decrypt (the shape above).
    const h = harness({ groupRouter: adoptingRouter() });
    await h.controller.start();

    // Ring one: an inert frame fixes the deadline, an adopted group frame
    // parks the fuse — deadline and note survive, deliberately.
    h.controller.notePushRing('synthetic-fb1-d', 'P1');
    h.verdict('P1', 'not_call');
    h.deliver('P1', { tcm: 'call.ginvite' });
    await h.controller.whenIdle();

    // An hour passes; the parked deadline is long expired.
    await jest.advanceTimersByTimeAsync(3_600_000);
    h.native.dismissPendingIncomingCall.mockClear();
    h.native.reportIncomingCall.mockClear();

    // Ring two — "text me, then call me": a new push, its text draining
    // 50 ms ahead of its offer.
    h.controller.notePushRing('synthetic-fb1-e', 'P1');
    h.verdict('P1', 'not_call');
    await jest.advanceTimersByTimeAsync(50);
    h.deliver('P1', offer(cidFor(731), Date.now() + 60_000));
    await h.controller.whenIdle();
    await jest.advanceTimersByTimeAsync(2_500);

    // The second ring survived its drain and adopted normally.
    expect(h.native.dismissPendingIncomingCall).not.toHaveBeenCalledWith('P1', 'not_call', '');
    expect(h.native.reportIncomingCall).toHaveBeenCalledTimes(1);
    expect(h.controller.state.name).toBe('incoming_ringing');
    expect(h.controller.state.call?.cid).toBe(cidFor(731));
  });
});

/**
 * THE STALE `vid` ON A RESTART ANSWER — the transmitting half.
 *
 * `restartReceived` (call-machine.ts) replies to an ICE restart with
 * `send(call, { tcm: 'call.answer', ..., vid: call.video })`, and `call.video`
 * is written once — at `newContext` (placeCall / offerReceived / the glare
 * adopt) and narrowed once more by `acceptIncoming`'s "Answer without video".
 * Nothing moves it afterwards. A camera toggle moves only `localMedia
 * .videoEnabled` in index.ts and announces itself through `call.media`, which
 * is the ONLY channel that carries track state (`sendMedia` is the one
 * `tcm: 'call.media'` producer in the tree).
 *
 * So every restart answer re-asserts the camera state the call STARTED with.
 * The receiving half was closed in `answerReceived` — a restart answer's `vid`
 * is ignored once `remoteReady` latches — but that fix lives on the peer's
 * device and does nothing for a peer on an older build. They fold the stale
 * `vid: true`, `peerVideo` flips back on, the photo unmounts, and the video
 * surface keeps presenting the LAST DECODED FRAME: a frozen still of that
 * person, shown as live video, until they toggle their camera again.
 *
 * The remedy is one frame behind the answer, on the channel that owns track
 * state. It is guarded to exactly what the reducer accepts — see below.
 */
describe('a restart answer is corrected by the media announce behind it', () => {
  /** A connected 1:1 call placed WITH video, so `call.video` is true and a
   * restart answer's `vid` is the stale value under test. */
  async function connectedVideoCall(
    over: Partial<CallControllerDeps> = {},
  ): Promise<Harness> {
    const h = harness(over);
    await h.controller.start();
    await h.controller.placeCall('P1', cidFor(760), true);
    await h.controller.onIceStateChanged(cidFor(760), 'connected');
    expect(h.controller.state.name).toBe('connected');
    h.sent.splice(0);
    return h;
  }

  it('follows the answer with the CURRENT track state, not the one the call started with', async () => {
    // The camera was turned off mid-call and the microphone muted: neither
    // fact is in `call.video`, and both belong in the announce.
    const h = await connectedVideoCall({
      localMedia: () => ({ muted: true, videoEnabled: false }),
    });

    h.deliver('P1', { tcm: 'call.restart', cid: cidFor(760), sdp: OFFER_SDP });
    await h.controller.whenIdle();

    const answer = h.sent.findIndex(s => s.envelope.tcm === 'call.answer');
    const announce = h.sent.findIndex(s => s.envelope.tcm === 'call.media');
    // The answer still carries the stale `vid` — that is protocol, and an old
    // peer will believe it. What matters is that the truth arrives behind it.
    expect(h.sent[answer]?.envelope).toMatchObject({ tcm: 'call.answer', vid: true });
    // ONE FRAME BEHIND, never ahead: an announce that overtook the answer
    // would be overwritten by the very value it exists to correct. Both
    // frames are enqueued through the same per-peer send in this order, and
    // messaging encrypts at compose time and flushes in that same order.
    expect(answer).toBeGreaterThanOrEqual(0);
    expect(announce).toBeGreaterThan(answer);
    expect(h.sent[announce]).toEqual({
      peerId: 'P1',
      envelope: { tcm: 'call.media', cid: cidFor(760), a: false, v: false },
      urgent: false,
    });
  });

  it('announces from RECONNECTING too — the state a restart most often lands in', async () => {
    // `restartReceived` accepts `connected` AND `reconnecting`, and the second
    // is not the rare arm: one network change drops ICE on both phones, so the
    // side receiving a peer's restart is very often already reconnecting and
    // restarting on its own account. A guard written as `connected` alone
    // passes every test that only ever gets there through `connected`, and
    // leaves the announce missing in the commoner half of the defect.
    const h = await connectedVideoCall({
      localMedia: () => ({ muted: false, videoEnabled: false }),
    });
    // ICE drops: this device moves to reconnecting and restarts on its own.
    await h.controller.onIceStateChanged(cidFor(760), 'disconnected');
    expect(h.controller.state.name).toBe('reconnecting');
    h.sent.splice(0);

    // …and the peer's restart crosses ours.
    h.deliver('P1', { tcm: 'call.restart', cid: cidFor(760), sdp: OFFER_SDP });
    await h.controller.whenIdle();

    expect(h.controller.state.name).toBe('reconnecting');
    expect(h.sent.filter(s => s.envelope.tcm === 'call.media')).toEqual([
      {
        peerId: 'P1',
        envelope: { tcm: 'call.media', cid: cidFor(760), a: true, v: false },
        urgent: false,
      },
    ]);
  });

  it('announces nothing while the phone is still RINGING — the reducer refused the restart', async () => {
    // PARTIAL MIRROR. `restartReceived` answers only in `connected` and
    // `reconnecting`; every other state returns NOTHING, and that guard is
    // there because a restart accepted while ringing was a way for the caller
    // to start the callee's camera and gather their host candidates before
    // anybody had agreed to anything. An announce hung off the dispatch with
    // no guard of its own reopens that door one crack: the frame is smaller,
    // but it is still this device answering an unsolicited restart before the
    // human has, and it is still one reply per frame the caller cares to send.
    const h = harness({ localMedia: () => ({ muted: false, videoEnabled: true }) });
    await h.controller.start();
    h.deliver('P1', offer(cidFor(761), Date.now() + 60_000));
    await h.controller.whenIdle();
    expect(h.controller.state.name).toBe('incoming_ringing');
    h.sent.splice(0);

    // Same peer, the LIVE cid — `addressesThisCall` passes, so the only thing
    // standing between this frame and a reply is the state guard.
    h.deliver('P1', { tcm: 'call.restart', cid: cidFor(761), sdp: OFFER_SDP });
    await h.controller.whenIdle();

    expect(h.sent).toEqual([]);
  });

  // --- WHO THE CORRECTION IS ADDRESSED TO ---------------------------------
  //
  // The reducer one line above CANNOT get this wrong: `send()` (call-machine
  // .ts) builds `{ peerId: call.peerId }` out of the context, so its
  // `call.answer` goes to the person in the call whoever the frame arrived
  // from. `handleEnvelope`'s `peerId` argument is a different thing — the
  // SENDER — and the announce is that answer's correction. Addressed
  // anywhere but where the answer went, it corrects nothing.

  it('addresses the correction to the CALL’s peer, not to whoever sent the restart', async () => {
    const h = await connectedVideoCall({
      localMedia: () => ({ muted: false, videoEnabled: false }),
    });

    // A frame from someone who is NOT in this call, naming the live cid. The
    // reducer takes it: `addressesThisCall` compares the cid and nothing else,
    // and `restartReceived` never looks at who sent anything. So the answer
    // goes out — to P1, because that is who the context names.
    h.deliver('P2', { tcm: 'call.restart', cid: cidFor(760), sdp: OFFER_SDP });
    await h.controller.whenIdle();

    expect(h.sent.filter(s => s.envelope.tcm === 'call.answer').map(s => s.peerId)).toEqual(['P1']);
    // The correction must follow the answer. Sent to the FRAME'S sender
    // instead, P1 — who just believed a stale `vid: true` — is never told
    // otherwise, and the defect the announce exists to close stays open on
    // the one path where the addressing is not a no-op.
    expect(h.sent.filter(s => s.envelope.tcm === 'call.media')).toEqual([
      {
        peerId: 'P1',
        envelope: { tcm: 'call.media', cid: cidFor(760), a: true, v: false },
        urgent: false,
      },
    ]);
    // …and nothing at all goes back to the sender. A `call.media` to P2 tells
    // a party who is not in the call that the cid they named is the live one,
    // that this device is on a call, and its exact microphone and camera
    // state — an echo the call machine's own `send()` is structurally
    // incapable of producing.
    expect(h.sent.filter(s => s.peerId === 'P2')).toEqual([]);
  });

  it('a correction that fails to send may not strand a placeholder ringing', async () => {
    // The announce is BEST-EFFORT, and `announceMedia` (index.ts), the only
    // other caller of `sendMedia`, swallows for exactly that reason. Allowed
    // to throw from here it unwinds past the unmatched-control sweep at the bottom of
    // `handleEnvelope` — the only thing that ends a placeholder this frame
    // did not adopt — and `onEnvelope`'s catch re-arms nothing, because a
    // noted push ring carries no deadline to resume. A transient failure on a
    // cosmetic correction then leaves someone else's ring standing to the
    // native 75-second watchdog: the STUCK RING, bought with a frame that had
    // nothing to do with it.
    const h = await connectedVideoCall({
      localMedia: () => ({ muted: false, videoEnabled: false }),
    });
    h.controller.notePushRing('synthetic-announce', 'P2');
    h.failSend(e => e.tcm === 'call.media');

    h.deliver('P2', { tcm: 'call.restart', cid: cidFor(760), sdp: OFFER_SDP });
    await h.controller.whenIdle();
    await jest.advanceTimersByTimeAsync(2_500);

    expect(h.native.dismissPendingIncomingCall).toHaveBeenCalledWith('P2', 'not_call', '');
  });

  // THE REFUSED STATES — ALL OF THEM.
  //
  // `restartReceived` answers in `connected` and `reconnecting`. The other
  // five non-idle states return NOTHING, and an announce hung off the
  // dispatch must refuse the same five or it is a reply this device makes to
  // an unsolicited restart. Two were pinned above (`incoming_ringing`,
  // `ending`); these are the three that were not, and none of them is
  // unreachable — each is a state this device sits in while the other side
  // ALREADY HOLDS THE CID, so a restart naming it is a frame they can send at
  // will. "Unreachable" and "unenforced" look identical from a green suite.

  it('announces nothing from OUTGOING_CONNECTING — the callee holds the cid before it answers', async () => {
    const h = harness({ localMedia: () => ({ muted: false, videoEnabled: true }) });
    await h.controller.start();
    await h.controller.placeCall('P1', cidFor(762), true);
    expect(h.controller.state.name).toBe('outgoing_connecting');
    h.sent.splice(0);

    h.deliver('P1', { tcm: 'call.restart', cid: cidFor(762), sdp: OFFER_SDP });
    await h.controller.whenIdle();

    expect(h.sent.filter(s => s.envelope.tcm === 'call.media')).toEqual([]);
  });

  it('announces nothing from OUTGOING_RINGING — the callee is ringing and has answered nothing', async () => {
    const h = harness({ localMedia: () => ({ muted: false, videoEnabled: true }) });
    await h.controller.start();
    await h.controller.placeCall('P1', cidFor(763), true);
    h.deliver('P1', { tcm: 'call.ringing', cid: cidFor(763) });
    await h.controller.whenIdle();
    expect(h.controller.state.name).toBe('outgoing_ringing');
    h.sent.splice(0);

    h.deliver('P1', { tcm: 'call.restart', cid: cidFor(763), sdp: OFFER_SDP });
    await h.controller.whenIdle();

    expect(h.sent.filter(s => s.envelope.tcm === 'call.media')).toEqual([]);
  });

  it('announces nothing from INCOMING_ANSWERING — accepted, but no media is flowing yet', async () => {
    const h = harness({ localMedia: () => ({ muted: false, videoEnabled: true }) });
    await h.controller.start();
    h.deliver('P1', offer(cidFor(764), Date.now() + 60_000));
    await h.controller.whenIdle();
    await h.controller.accept();
    await h.controller.whenIdle();
    expect(h.controller.state.name).toBe('incoming_answering');
    h.sent.splice(0);

    h.deliver('P1', { tcm: 'call.restart', cid: cidFor(764), sdp: OFFER_SDP });
    await h.controller.whenIdle();

    expect(h.sent.filter(s => s.envelope.tcm === 'call.media')).toEqual([]);
  });

  it('announces nothing for a restart naming a DIFFERENT call', async () => {
    // The state guard cannot see this one: the machine stays `connected`,
    // because `addressesThisCall` dropped the frame before `restartReceived`
    // ever ran. What refuses it is that the ENVELOPE's cid is what gets
    // passed to `sendMedia` — read the live call's cid instead, "since it is
    // the same one anyway", and this device answers a restart the reducer
    // refused, under a cid the sender only had to make up.
    const h = await connectedVideoCall({
      localMedia: () => ({ muted: false, videoEnabled: false }),
    });

    h.deliver('P1', { tcm: 'call.restart', cid: cidFor(766), sdp: OFFER_SDP });
    await h.controller.whenIdle();

    expect(h.controller.state.name).toBe('connected');
    expect(h.sent).toEqual([]);
  });

  it('announces nothing when the dispatch itself tore the call down', async () => {
    // The sixth refused state, and the only one the frame did not ARRIVE in:
    // `createAnswer` fails, the executor hangs the call up, and by the time
    // the announce line runs there is no call at all. The comment says this
    // door is "already shut" by `sendMedia`'s cid check — a claim about a
    // door nobody had tried, until here.
    const h = await connectedVideoCall({
      localMedia: () => ({ muted: false, videoEnabled: false }),
    });
    h.controller.notePushRing('synthetic-torn', 'P2');
    h.native.createAnswer.mockRejectedValueOnce(new Error('no peer connection'));

    h.deliver('P2', { tcm: 'call.restart', cid: cidFor(760), sdp: OFFER_SDP });
    await h.controller.whenIdle();

    expect(h.controller.state.call).toBeNull();
    expect(h.sent.filter(s => s.envelope.tcm === 'call.media')).toEqual([]);
    // …and REFUSED, not merely thrown out of. Reaching for the peer of a call
    // that is gone raises before the send rather than after it, so "no
    // `call.media` went out" is true of the crash too — and the crash takes
    // the unmatched-control sweep below with it. The placeholder is what tells the two
    // apart.
    await jest.advanceTimersByTimeAsync(2_500);
    expect(h.native.dismissPendingIncomingCall).toHaveBeenCalledWith('P2', 'not_call', '');
  });

  it('announces nothing for a call already ENDING', async () => {
    // The other half of the same mirror, and the one a cid check alone cannot
    // catch: `ending` still holds the call, so `sendMedia`'s cid guard passes.
    const h = await connectedVideoCall({
      localMedia: () => ({ muted: false, videoEnabled: false }),
    });
    const release = h.gateSend(e => e.tcm === 'call.end');
    void h.controller.hangup();
    await Promise.resolve();
    expect(h.controller.state.name).toBe('ending');

    h.deliver('P1', { tcm: 'call.restart', cid: cidFor(760), sdp: OFFER_SDP });
    await h.controller.whenIdle();
    release();
    await h.controller.whenIdle();

    expect(h.sent.filter(s => s.envelope.tcm === 'call.media')).toEqual([]);
  });

  it('is inert without the dep — the pre-existing behaviour, byte for byte', async () => {
    // `localMedia` is optional for the reason every other added dep here is:
    // a harness that does not wire it must get exactly the controller it had.
    // Absent means NO announce rather than a default one — a guessed
    // `videoEnabled: false` would be the same lie this closes, told by the
    // fix instead of by the reducer.
    const h = await connectedVideoCall();
    h.controller.notePushRing('synthetic-nodep', 'P2');

    h.deliver('P2', { tcm: 'call.restart', cid: cidFor(760), sdp: OFFER_SDP });
    await h.controller.whenIdle();

    expect(h.sent.some(s => s.envelope.tcm === 'call.answer')).toBe(true);
    expect(h.sent.filter(s => s.envelope.tcm === 'call.media')).toEqual([]);
    // SKIPPED, not crashed on. Without the dep there is nothing to read
    // `muted` off, and reading it anyway raises before the send — which
    // leaves "no `call.media` went out" just as true, and the unmatched-control sweep
    // below just as skipped. Same discriminator as the torn-down case.
    await jest.advanceTimersByTimeAsync(2_500);
    expect(h.native.dismissPendingIncomingCall).toHaveBeenCalledWith('P2', 'not_call', '');
  });
});

/**
 * `sendMedia` DEFENDS ITS OWN ASSUMPTION.
 *
 * Its doc says what its cid check is for — "so a toggle racing a hangup
 * cannot send under a call that has ended" — and that is a TEMPORAL guard,
 * never an identity one. It could afford to be: for the whole life of this
 * file it had exactly one caller, `announceMedia` (index.ts), which reads
 * `call.peerId` off the live context two lines earlier. The restart branch is
 * the first caller that can be handed an id that came off the wire, and a
 * function whose only defence is "every caller is careful" is one caller away
 * from not having a defence at all.
 */
describe('sendMedia and the addressee it never used to check', () => {
  it('refuses an addressee who is not the live call’s peer', async () => {
    const h = harness();
    await h.controller.start();
    await h.controller.placeCall('P1', cidFor(765), true);
    await h.controller.onIceStateChanged(cidFor(765), 'connected');
    expect(h.controller.state.name).toBe('connected');
    h.sent.splice(0);

    // The cid is the LIVE one, so the temporal guard is satisfied and it is
    // the only guard there was.
    await h.controller.sendMedia('P2', cidFor(765), true, true);
    expect(h.sent).toEqual([]);

    // …and the peer of the call is still told, unchanged.
    await h.controller.sendMedia('P1', cidFor(765), true, true);
    expect(h.sent).toEqual([
      {
        peerId: 'P1',
        envelope: { tcm: 'call.media', cid: cidFor(765), a: true, v: true },
        urgent: false,
      },
    ]);
  });
});
