import type { CallEnvelope, IceServer } from '@tacendum/shared';
import {
  CallController,
  type CallControllerDeps,
  type CallNativeBridge,
} from '../src/call/controller';
import { GroupCallCoordinator } from '../src/call/group';
import type { CallLogRow } from '../src/call/service';

/**
 * THE 1:1 REGRESSION NET FOR THE GROUP-CALL SEAMS.
 *
 * `filterEffects` (service.ts) and `groupRouter` (controller.ts) are two hooks
 * cut into shipped 1:1 code so that small-group calls can reuse it. The
 * stated risk is that they leak behaviour into the 1:1 path, and the
 * mitigation is this file: a byte-level trace of a whole 1:1 call — every
 * native call, every envelope, every log row, in order, with arguments —
 * recorded through the wired controller BEFORE the seams existed and asserted
 * against the committed snapshot after.
 *
 * The trace is deliberately at the SEAM of the process, not inside it: what
 * a peer sees (envelopes), what the system sees (CallKit + peer connection),
 * and what the person sees afterwards (the log row). A seam that changed any
 * of those changed the call. A snapshot diff on this file is a stop-and-state
 * event, never a "just update the snapshot" one.
 *
 * Falsifying case, run at authoring time: hard-code `filterEffects` in
 * CallService to strip the four CallKit effect types unconditionally. The
 * `reportIncomingCall`, `reportOutgoingConnected` and `endCall` lines vanish
 * from the traces; three of the four snapshots here fail, and 26 cases across
 * `call.service.test.ts` and `call.controller.test.ts` fail with them.
 * Restored. (The fourth snapshot is the refused-call trace: it is empty by
 * design — a refusal crosses no boundary at all — so it cannot move.)
 *
 * THE CONTROLLER HERE IS WIRED WITH A REAL `GroupCallCoordinator`, which it
 * was not when this file was written — and that omission is how a blocker
 * escaped. "The wired controller" means the one production builds: `index.ts`
 * always passes `groupRouter`, so a harness that left it undefined was
 * measuring a configuration nothing ships, and `placeCall`'s missing busy-rule
 * consult was invisible to the very snapshot whose job is to see the seams.
 * The coordinator has NO live session in any trace below, so every line it
 * could contribute is a line the 1:1 path was never supposed to produce: its
 * four edges push into this same trace, so a leak is a snapshot diff rather
 * than a field report.
 */

const OFFER_SDP = 'v=0\r\na=fingerprint:sha-256 AA:BB\r\nOFFER';
const ANSWER_SDP = 'v=0\r\na=fingerprint:sha-256 CC:DD\r\nANSWER';
const SERVERS: IceServer[] = [
  { urls: ['stun:turn.tacendum.com:3478'] },
  { urls: ['turn:turn.tacendum.com:3478?transport=udp'], username: 'u', credential: 'c' },
];

const PEER = '01HQ0000000000000000000001';
const SELF = '01HQ0000000000000000000009';
const CID_IN = '01HQ000000000000000000000A';
const CID_OUT = '01HQ000000000000000000000B';
const CLOCK = 1_800_000_000_000;

/** One ordered list of everything that crossed a boundary. */
type Trace = string[];

interface Harness {
  controller: CallController;
  trace: Trace;
  deliver: (peerId: string, envelope: unknown, ts?: number) => void;
}

/** Stable rendering: arguments included, but ordered by the JSON the code
 * itself produced, so a reordered field is a diff and a renamed one is too. */
function line(kind: string, ...args: unknown[]): string {
  return `${kind}(${args.map(a => JSON.stringify(a)).join(', ')})`;
}

function harness(over: Partial<CallControllerDeps> = {}): Harness {
  const trace: Trace = [];
  let listener: ((p: string, e: unknown, m: { msgId: string; ts: number }) => void) | null =
    null;

  const nativeFn = (name: string, result: unknown = undefined) =>
    jest.fn(async (...args: unknown[]) => {
      trace.push(line(`native.${name}`, ...args));
      return result;
    });

  const native = {
    configure: nativeFn('configure'),
    createOffer: nativeFn('createOffer', OFFER_SDP),
    createAnswer: nativeFn('createAnswer', ANSWER_SDP),
    setRemoteAnswer: nativeFn('setRemoteAnswer'),
    addIceCandidates: nativeFn('addIceCandidates'),
    restartIce: nativeFn('restartIce', OFFER_SDP),
    close: nativeFn('close'),
    reportOutgoingCall: nativeFn('reportOutgoingCall'),
    reportOutgoingConnected: nativeFn('reportOutgoingConnected'),
    reportIncomingCall: nativeFn('reportIncomingCall'),
    updateIncomingCallDisplay: nativeFn('updateIncomingCallDisplay'),
    dismissPendingIncomingCall: nativeFn('dismissPendingIncomingCall'),
    endCall: nativeFn('endCall'),
    registerForVoipPush: nativeFn('registerForVoipPush'),
    getVoipToken: nativeFn('getVoipToken', 'token'),
  } as unknown as jest.Mocked<CallNativeBridge>;

  /**
   * The real coordinator, wired as production wires it and idle throughout.
   *
   * Every edge traces. Nothing below starts a session, so a `group.*` line in
   * any snapshot means a 1:1 call reached the session layer — which is
   * precisely the leak the risk 1 names, and precisely what an absent
   * router could never show.
   */
  const groupRouter = new GroupCallCoordinator({
    selfId: () => SELF,
    native: {
      ...(native as unknown as CallNativeBridge),
      // Three parameters, exactly as the bridge takes them: `cid` names the
      // placeholder the refusal was about, and a fake that dropped it would
      // hide a revert to the caller-keyed match from the one test in this
      // repo that reads the whole call as a committed transcript.
      dismissPendingIncomingCall: async (peerId: string, reason: string, cid: string) => {
        trace.push(line('group.dismissPendingIncomingCall', peerId, reason, cid));
      },
      setAudioEnabled: async (cid: string, on: boolean) => {
        trace.push(line('group.setAudioEnabled', cid, on));
        return true;
      },
      setVideoEnabled: async (cid: string, on: boolean) => {
        trace.push(line('group.setVideoEnabled', cid, on));
        return true;
      },
      setSpeaker: async (cid: string, on: boolean) => {
        trace.push(line('group.setSpeaker', cid, on));
      },
    },
    transport: {
      sendCallEnvelope: async (peerId, envelope, opts) => {
        trace.push(line('group.send', peerId, envelope, opts));
      },
      sendGroupCallEnvelope: async (peerId, envelope, opts) => {
        trace.push(line('group.sendGroup', peerId, envelope, opts));
      },
    },
    store: {
      saveSession: async row => void trace.push(line('group.saveSession', row)),
      loadSession: async () => {
        trace.push(line('group.loadSession'));
        return null;
      },
      deleteSession: async sid => void trace.push(line('group.deleteSession', sid)),
      saveOffer: async offer => void trace.push(line('group.saveOffer', offer)),
      takeOffersForSession: async sid => {
        trace.push(line('group.takeOffersForSession', sid));
        return [];
      },
      deleteOffersForSession: async sid =>
        void trace.push(line('group.deleteOffersForSession', sid)),
      writeLog: async row => void trace.push(line('group.log', row)),
    },
    displayNameFor: async id => `name:${id}`,
    oneToOneBusy: () => false,
    ensureCredentials: async () => void trace.push(line('group.ensureCredentials')),
    mintId: async () => {
      trace.push(line('group.mintId'));
      return '01HQ00000000000000000000ZZ';
    },
    mintReportId: async () => 'REPORT-GROUP',
    now: () => CLOCK,
    delay: async () => undefined,
  });

  const controller = new CallController({
    groupRouter,
    messaging: {
      onEnvelope: l => {
        listener = l;
        return () => {
          listener = null;
        };
      },
      sendCallEnvelope: async (peerId, envelope, opts) => {
        trace.push(line('send', peerId, envelope, { urgent: opts.urgent === true }));
      },
    },
    native,
    fetchTurnCredentials: async () => {
      trace.push(line('turn.fetch'));
      return { iceServers: SERVERS, ttlSeconds: 12 * 3600 };
    },
    writeLog: async (row: CallLogRow) => {
      trace.push(line('log', row));
    },
    displayNameFor: async id => `name:${id}`,
    relayOnly: () => false,
    mintReportId: async () => 'REPORT-CONTROLLER',
    now: () => CLOCK,
    saveOffer: async offer => {
      trace.push(line('db.saveOffer', offer));
    },
    takeOffer: async cid => {
      trace.push(line('db.takeOffer', cid));
      return null;
    },
    dropOffer: async cid => {
      trace.push(line('db.dropOffer', cid));
    },
    onStateChange: state => {
      trace.push(line('state', state.name, state.call?.cid ?? null));
    },
    ...over,
  });

  created.push(controller);
  return {
    controller,
    trace,
    deliver: (peerId, envelope, ts = CLOCK) =>
      listener?.(peerId, envelope, { msgId: 'm1', ts }),
  };
}

const created: CallController[] = [];
afterEach(() => {
  for (const c of created.splice(0)) c.stop();
});

function offer(cid: string): CallEnvelope {
  return { tcm: 'call.offer', cid, sdp: OFFER_SDP, vid: false, exp: CLOCK + 60_000 };
}

describe('a whole 1:1 call, traced (the group-call seam regression net)', () => {
  it('incoming: offer → ring → accept → ice → connected → hangup', async () => {
    const h = harness();
    await h.controller.start();
    // `start()` registers for VoIP wakes; that line is real but is not part of
    // the call, so the trace is taken from here.
    h.trace.length = 0;

    h.deliver(PEER, offer(CID_IN));
    await h.controller.whenIdle();
    await h.controller.accept();
    h.controller.onLocalIceCandidate({ cand: 'candidate:1 1 udp 1 10.0.0.1 1 typ host', mid: '0', idx: 0 });
    await h.controller.whenIdle();
    h.deliver(PEER, {
      tcm: 'call.ice',
      cid: CID_IN,
      c: [{ cand: 'candidate:2 1 udp 1 10.0.0.2 1 typ host', mid: '0', idx: 0 }],
    });
    await h.controller.whenIdle();
    await h.controller.onIceStateChanged(CID_IN, 'connected');
    await h.controller.hangup();
    await h.controller.whenIdle();

    expect(h.trace).toMatchSnapshot();
  });

  it('outgoing: place → ringing → answer → ice → connected → peer ends', async () => {
    const h = harness();
    await h.controller.start();
    h.trace.length = 0;

    await h.controller.placeCall(PEER, CID_OUT, false);
    h.controller.onLocalIceCandidate({ cand: 'candidate:1 1 udp 1 10.0.0.1 1 typ host', mid: '0', idx: 0 });
    h.deliver(PEER, { tcm: 'call.ringing', cid: CID_OUT });
    await h.controller.whenIdle();
    h.deliver(PEER, { tcm: 'call.answer', cid: CID_OUT, sdp: ANSWER_SDP, vid: false });
    await h.controller.whenIdle();
    await h.controller.onIceStateChanged(CID_OUT, 'connected');
    h.deliver(PEER, { tcm: 'call.end', cid: CID_OUT, r: 'hangup' });
    await h.controller.whenIdle();

    expect(h.trace).toMatchSnapshot();
  });

  it('a refused outbound call and a busy inbound one leave the same trace', async () => {
    // The two paths a seam could most plausibly re-route: the pre-camera
    // refusal (mayCall) and the reducer's busy answer to a second offer.
    const h = harness({
      mayCall: async () => ({ allowed: false, reason: 'blocked' as const }),
    });
    await h.controller.start();
    h.trace.length = 0;
    await expect(h.controller.placeCall(PEER, CID_OUT, false)).rejects.toThrow();
    expect(h.trace).toMatchSnapshot();

    const g = harness();
    await g.controller.start();
    g.trace.length = 0;
    g.deliver(PEER, offer(CID_IN));
    await g.controller.whenIdle();
    g.deliver('01HQ0000000000000000000002', offer('01HQ000000000000000000000C'));
    await g.controller.whenIdle();
    expect(g.trace).toMatchSnapshot();
  });
});
