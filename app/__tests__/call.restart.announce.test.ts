import * as calling from '../src/call';
import { messaging } from '../src/messaging';

/**
 * THE WIRING OF THE RESTART ANNOUNCE — the half `call.controller.test.ts`
 * structurally cannot see.
 *
 * The controller reads this device's live track state through an OPTIONAL dep
 * (`localMedia`), so every one of its own tests supplies it and every one of
 * them passes whether or not `src/call/index.ts` does. Delete
 * `localMedia: () => localMedia` from the construction site there and the fix
 * is inert in the only build that ships, with a green suite over it: a harness
 * in a state production never reaches proves nothing.
 *
 * So this file drives `startCalling()` — the real wiring, the real
 * `messaging.onEnvelope` subscription, the real `localMedia` object that
 * `toggleVideo` replaces — and asserts the frame that leaves the device.
 *
 * What it is about: `restartReceived` (call-machine.ts) answers an ICE restart
 * with `vid: call.video`, which is written once when the call is created or
 * accepted and never again. A camera turned off mid-call moves only
 * `localMedia.videoEnabled`. The receiving half was closed in `answerReceived`
 * — a restart answer's `vid` is ignored once `remoteReady` latches — but that
 * lives on the PEER's device, so a peer on an older build still folds the
 * stale value: their `peerVideo` flips back on over a camera that is off, and
 * the renderer keeps presenting the last decoded frame. A frozen still of this
 * person, shown as live video, until they toggle again.
 */

const CID = '01J0000000000000000000000N';
const PEER = '01PEERZ3NDEKTSV4RRFFQ69G5F';
const MSG = '01HQMSG000000000000000000A';
const SDP = 'v=0\r\na=fingerprint:sha-256 AA:BB\r\nRESTART';

type EnvelopeListener = (
  peerId: string,
  envelope: unknown,
  meta: { msgId: string; ts: number },
) => void;

let teardown: (() => void) | undefined;

async function flush(): Promise<void> {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}

/** Every `call.media` this device has put on the wire, oldest first. */
function announced(): { a: boolean; v: boolean }[] {
  return (messaging.sendCallEnvelope as jest.Mock).mock.calls
    .map(c => c[1] as { tcm: string; a: boolean; v: boolean })
    .filter(e => e.tcm === 'call.media')
    .map(({ a, v }) => ({ a, v }));
}

beforeEach(() => {
  calling.resetCallingForTests();
  jest.clearAllMocks();
});

afterEach(() => {
  teardown?.();
  teardown = undefined;
  calling.resetCallingForTests();
  jest.restoreAllMocks();
});

describe('a peer’s ICE restart, answered by the shipped wiring', () => {
  it('puts THIS device’s current camera state on the wire behind the answer', async () => {
    jest.spyOn(messaging, 'sendCallEnvelope').mockResolvedValue(undefined);
    jest.spyOn(messaging, 'onEnvelope');
    teardown = await calling.startCalling();

    // A VIDEO call, connected. `call.video` is now true for the rest of its
    // life — this is the value a restart answer will keep re-asserting.
    await calling.callController().placeCall(PEER, CID, true);
    await calling.callController().onIceStateChanged(CID, 'connected');
    expect(calling.currentStateForTests().name).toBe('connected');

    // The camera goes off. Only `localMedia` moves; `call.video` cannot.
    await calling.toggleVideo();
    expect(calling.localMediaState().videoEnabled).toBe(false);
    expect(calling.currentStateForTests().call?.video).toBe(true);

    // Forget the toggle's own announce — what is under test is the frame the
    // RESTART produces, with no toggle anywhere near it.
    (messaging.sendCallEnvelope as jest.Mock).mockClear();

    const listener = (messaging.onEnvelope as jest.Mock).mock.calls.at(-1)![0] as EnvelopeListener;
    listener(PEER, { tcm: 'call.restart', cid: CID, sdp: SDP }, { msgId: MSG, ts: Date.now() });
    await flush();

    // The answer went out carrying the stale `vid` — that is the protocol, and
    // an old peer will believe it. The correction is the frame behind it.
    const kinds = (messaging.sendCallEnvelope as jest.Mock).mock.calls.map(
      c => (c[1] as { tcm: string }).tcm,
    );
    expect(kinds.indexOf('call.media')).toBeGreaterThan(kinds.indexOf('call.answer'));
    expect(announced()).toEqual([{ a: true, v: false }]);
  });

  it('says the camera is ON when it was turned on mid-call — the other direction of the same staleness', async () => {
    // The camera-OFF case above cannot tell a LIVE `false` from a STALE one:
    // `call.video` is false for an audio call and `localMedia.videoEnabled`
    // starts false at module scope, so every wrong source agrees with the
    // right answer by accident. Here they disagree — the only value that is
    // `true` is the one read from the live object at the moment the restart
    // lands. (It is also the mirror symptom: the peer showing a camera as off
    // while it is live.)
    jest.spyOn(messaging, 'sendCallEnvelope').mockResolvedValue(undefined);
    jest.spyOn(messaging, 'onEnvelope');
    teardown = await calling.startCalling();

    await calling.callController().placeCall(PEER, CID, false);
    await calling.callController().onIceStateChanged(CID, 'connected');
    await calling.toggleVideo();
    expect(calling.localMediaState().videoEnabled).toBe(true);
    expect(calling.currentStateForTests().call?.video).toBe(false);
    (messaging.sendCallEnvelope as jest.Mock).mockClear();

    const listener = (messaging.onEnvelope as jest.Mock).mock.calls.at(-1)![0] as EnvelopeListener;
    listener(PEER, { tcm: 'call.restart', cid: CID, sdp: SDP }, { msgId: MSG, ts: Date.now() });
    await flush();

    expect(announced()).toEqual([{ a: true, v: true }]);
  });

  it('says MUTED when this device is muted — the announce is not the camera alone', async () => {
    jest.spyOn(messaging, 'sendCallEnvelope').mockResolvedValue(undefined);
    jest.spyOn(messaging, 'onEnvelope');
    teardown = await calling.startCalling();

    await calling.callController().placeCall(PEER, CID, true);
    await calling.callController().onIceStateChanged(CID, 'connected');
    await calling.toggleMute();
    expect(calling.localMediaState().muted).toBe(true);
    (messaging.sendCallEnvelope as jest.Mock).mockClear();

    const listener = (messaging.onEnvelope as jest.Mock).mock.calls.at(-1)![0] as EnvelopeListener;
    listener(PEER, { tcm: 'call.restart', cid: CID, sdp: SDP }, { msgId: MSG, ts: Date.now() });
    await flush();

    // `a` is "audio is LIVE", so a muted microphone is `a: false`. Sending
    // `!muted` inverted here would tell the peer the opposite of the truth on
    // a channel their UI renders directly.
    expect(announced()).toEqual([{ a: false, v: true }]);
  });
});
