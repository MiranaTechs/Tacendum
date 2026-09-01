import * as native from 'tacendum-call';
import * as calling from '../src/call';
import { messaging } from '../src/messaging';

/**
 * Local media state — mute, camera, speaker, which way the preview faces.
 *
 * None of it lives in the reducer, because none of it is protocol: muting is
 * a fact about this device. That is also why this file exists. `src/call/index.ts`
 * had no test at all, and every defect in this area shared one shape — the
 * flag was set and the thing it described was never done. The speaker flag
 * with no `setSpeaker`, the mute button with no re-render, the camera state
 * the peer was never told about.
 */

const CID = '01J0000000000000000000000N';
const PEER = '01PEERZ3NDEKTSV4RRFFQ69G5F';

let teardown: (() => void) | undefined;

/**
 * Put the module in a live call without a socket, a database or a device.
 *
 * Through `startCalling()` rather than `controller.start()`, because the
 * native event subscriptions live there — including the one. Driving the
 * controller directly leaves them unregistered, which makes any test of a
 * native-event path pass for the wrong reason: it asserts against a listener
 * that was never attached.
 */
async function inCall(video: boolean): Promise<void> {
  jest.spyOn(messaging, 'sendCallEnvelope').mockResolvedValue(undefined);
  teardown = await calling.startCalling();
  await calling.callController().placeCall(PEER, CID, video);
}

beforeEach(() => {
  calling.resetCallingForTests();
  jest.clearAllMocks();
});

afterEach(() => {
  teardown?.();
  teardown = undefined;
  calling.resetCallingForTests();
});

describe('a media change reaches the screen', () => {
  it('hands subscribers a NEW state object, or React renders nothing', async () => {
    // The reducer's state does not change when you mute — mute is not a
    // protocol event — so `notify` was called with the object it already had.
    // `setState` compares by reference, sees no change and bails out of the
    // render entirely: the tracks changed and the buttons did not move.
    await inCall(true);
    // What a mounted `useCallState` is holding right now. React compares the
    // NEXT value against exactly this, so this is the reference that has to
    // change.
    const held = calling.currentStateForTests();
    const seen: unknown[] = [];
    calling.subscribeForTests(s => seen.push(s));

    await calling.toggleMute();

    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toBe(held);
    // Same call, though — a new object, not a new state.
    expect((seen[0] as { call: { cid: string } }).call.cid).toBe(CID);
    expect(calling.localMediaState().muted).toBe(true);
  });
});

describe('the peer is told what our tracks are doing (call.media)', () => {
  it('announces a mute', async () => {
    await inCall(true);
    const sent = messaging.sendCallEnvelope as jest.Mock;
    sent.mockClear();

    await calling.toggleMute();

    const media = sent.mock.calls.find(c => c[1]?.tcm === 'call.media');
    expect(media?.[1]).toMatchObject({ cid: CID, a: false, v: true });
    // Never urgent: it is a courtesy about track state, and waking a sleeping
    // phone for one would make mute a way to ping someone.
    expect(media?.[2]).toMatchObject({ urgent: false });
  });

  it('announces the camera going off', async () => {
    await inCall(true);
    const sent = messaging.sendCallEnvelope as jest.Mock;
    sent.mockClear();

    await calling.toggleVideo();

    const media = sent.mock.calls.find(c => c[1]?.tcm === 'call.media');
    expect(media?.[1]).toMatchObject({ cid: CID, a: true, v: false });
  });

  it('says nothing about which speaker we are listening through', async () => {
    // Where the audio comes out of is this device's business.
    await inCall(true);
    const sent = messaging.sendCallEnvelope as jest.Mock;
    sent.mockClear();

    await calling.toggleSpeaker();

    expect(sent.mock.calls.some(c => c[1]?.tcm === 'call.media')).toBe(false);
  });
});

describe('the speaker', () => {
  it('is actually switched on for a video call, not merely displayed as on', async () => {
    // `speakerOn: true` was set from `call.video` and nothing ever called
    // `setSpeaker`, so a video call showed the speaker lit while the audio
    // came out of the earpiece.
    await inCall(true);
    expect(calling.localMediaState().speakerOn).toBe(true);
    expect(native.setSpeaker).toHaveBeenCalledWith(CID, true);
  });

  it('is left alone for an audio call', async () => {
    await inCall(false);
    expect(calling.localMediaState().speakerOn).toBe(false);
    expect(native.setSpeaker).not.toHaveBeenCalled();
  });
});

describe('the local preview mirrors only the front camera', () => {
  it('stops mirroring after a flip to the rear camera', async () => {
    // `switchCamera` swaps the capture DEVICE behind the same RTCVideoTrack,
    // so the native track registry has nothing new to announce and the view
    // is never told. Tracked here or not at all — and `mirror` was a
    // hard-coded prop, so the rear camera showed the world reversed.
    await inCall(true);
    expect(calling.localMediaState().frontCamera).toBe(true);

    await calling.flipCamera();
    expect(calling.localMediaState().frontCamera).toBe(false);
    expect(native.switchCamera).toHaveBeenCalledWith(CID);

    await calling.flipCamera();
    expect(calling.localMediaState().frontCamera).toBe(true);
  });

  it('leaves the preview alone when the flip fails', async () => {
    await inCall(true);
    (native.switchCamera as jest.Mock).mockRejectedValueOnce(new Error('no camera'));

    await expect(calling.flipCamera()).rejects.toThrow();
    expect(calling.localMediaState().frontCamera).toBe(true);
  });
});

/**
 * The design — the thermal table, end to end.
 *
 * The policy is tested purely in call.policy.test.ts. These check the half
 * that the policy cannot: that a device signal actually reaches the encoder,
 * the peer and the screen. The event was declared in the TurboModule spec
 * since V5 and emitted by nothing, so the whole table was unreachable code.
 */
describe('device pressure reaches the call', () => {
  function pressure(over: Partial<{ state: string; lowPower: boolean; battery: number | null }> = {}) {
    (native as unknown as { __call: { emit: (n: string, p: unknown) => void } }).__call.emit(
      'devicePressure',
      // An object, not a JSON string: the jest mock stands in for the module's
      // JS facade, which has already parsed the bridge payload through zod.
      { state: 'nominal', lowPower: false, battery: 0.8, ...over },
    );
  }

  it('caps the encoder when the phone gets hot', async () => {
    await inCall(true);
    (native.applyVideoCap as jest.Mock).mockClear();

    pressure({ state: 'serious' });
    await Promise.resolve();
    await Promise.resolve();

    expect(native.applyVideoCap).toHaveBeenCalledWith(CID, 640, 24);
    expect(calling.localMediaState().pressureNotice).toBe('Reduced quality');
  });

  it('stops the camera at .critical AND tells the peer', async () => {
    // Without the announce the other end watches a frozen last frame and
    // concludes the call has broken.
    await inCall(true);
    const sent = messaging.sendCallEnvelope as jest.Mock;
    sent.mockClear();

    pressure({ state: 'critical' });
    await new Promise<void>(resolve => setTimeout(() => resolve(), 0));

    expect(native.setVideoEnabled).toHaveBeenCalledWith(CID, false);
    expect(calling.localMediaState().videoEnabled).toBe(false);
    const media = sent.mock.calls.find(c => c[1]?.tcm === 'call.media');
    expect(media?.[1]).toMatchObject({ cid: CID, v: false });
    expect(calling.localMediaState().pressureNotice).toBe('Video paused to cool down');
  });

  it('leaves a voice call entirely alone', async () => {
    await inCall(false);
    (native.applyVideoCap as jest.Mock).mockClear();

    pressure({ state: 'critical', battery: 0.01 });
    await new Promise<void>(resolve => setTimeout(() => resolve(), 0));

    expect(calling.localMediaState().pressureNotice).toBeNull();
    expect(calling.localMediaState().offerVoice).toBe(false);
    expect(native.setVideoEnabled).not.toHaveBeenCalledWith(CID, false);
  });

  it('lets a tap restore quality under Low Power Mode', async () => {
    await inCall(true);
    (native.applyVideoCap as jest.Mock).mockClear();

    pressure({ lowPower: true });
    await new Promise<void>(resolve => setTimeout(() => resolve(), 0));
    expect(native.applyVideoCap).toHaveBeenCalledWith(CID, 640, 24);
    expect(calling.localMediaState().pressureNotice).toBe('Low Power Mode');
    expect(calling.localMediaState().pressureRestorable).toBe(true);

    (native.applyVideoCap as jest.Mock).mockClear();
    await calling.restoreVideoQuality();

    expect(native.applyVideoCap).toHaveBeenCalledWith(CID, 0, 0);
    expect(calling.localMediaState().pressureNotice).toBeNull();
    expect(calling.localMediaState().pressureRestorable).toBe(false);
  });

  it('keeps the heat cap through a restore tap', async () => {
    // The tap answers Low Power Mode — a preference. A hot phone is a fact,
    // and the cap that answers it must survive any tap.
    await inCall(true);
    pressure({ state: 'serious', lowPower: true });
    await new Promise<void>(resolve => setTimeout(() => resolve(), 0));
    (native.applyVideoCap as jest.Mock).mockClear();

    await calling.restoreVideoQuality();

    expect(native.applyVideoCap).toHaveBeenCalledWith(CID, 640, 24);
    expect(calling.localMediaState().pressureNotice).toBe('Reduced quality');
  });

  it('forgets the restore when the next call starts', async () => {
    // The tap was an answer about THIS call. The next call re-asks: a phone
    // still in Low Power Mode starts capped again.
    await inCall(true);
    pressure({ lowPower: true });
    await new Promise<void>(resolve => setTimeout(() => resolve(), 0));
    await calling.restoreVideoQuality();
    expect(calling.localMediaState().pressureNotice).toBeNull();

    await calling.callController().hangup();
    (native.applyVideoCap as jest.Mock).mockClear();
    const CID2 = '01J0000000000000000000000P';
    await calling.callController().placeCall(PEER, CID2, true);
    await new Promise<void>(resolve => setTimeout(() => resolve(), 0));

    expect(native.applyVideoCap).toHaveBeenCalledWith(CID2, 640, 24);
    expect(calling.localMediaState().pressureNotice).toBe('Low Power Mode');
    expect(calling.localMediaState().pressureRestorable).toBe(true);
  });

  it('re-applies the cap when the call connects — the ring-time cap hit no peer connection', async () => {
    // At dial/ring time the native peer connection does not exist yet
    // (createOffer/createAnswer builds it later, in a Task), so the
    // start-of-call applyVideoCap lands in the native module's silent no-op
    // guard. `connected` is the first state that PROVES the connection
    // exists; the cap must land again there, or a Low Power phone runs the
    // whole call at the full 4.5 Mbps it asked the OS not to spend.
    await inCall(true);
    pressure({ lowPower: true });
    await new Promise<void>(resolve => setTimeout(() => resolve(), 0));
    (native.applyVideoCap as jest.Mock).mockClear();

    await calling.callController().onIceStateChanged(CID, 'connected');
    await new Promise<void>(resolve => setTimeout(() => resolve(), 0));

    expect(native.applyVideoCap).toHaveBeenCalledWith(CID, 640, 24);
  });

  it('re-issues the critical video-off when the call connects', async () => {
    // The ring-time disable lands on a peer connection that does not exist
    // yet, and the native side starts the camera ENABLED when the answer
    // builds it. If the disable is only edge-triggered on localMedia, the
    // connected re-apply skips it — and the camera transmits behind a UI,
    // a notice, and a peer-facing call.media that all say video is off.
    await inCall(true);
    pressure({ state: 'critical' });
    await new Promise<void>(resolve => setTimeout(() => resolve(), 0));
    expect(calling.localMediaState().videoEnabled).toBe(false);
    (native.setVideoEnabled as jest.Mock).mockClear();

    await calling.callController().onIceStateChanged(CID, 'connected');
    await new Promise<void>(resolve => setTimeout(() => resolve(), 0));

    expect(native.setVideoEnabled).toHaveBeenCalledWith(CID, false);
  });

  it('honors Low Power Mode being re-asserted after a restore tap', async () => {
    // The tap answered ONE Low Power episode. Turning LPM off and back on is
    // the owner asking again, and the new request outranks the old answer.
    await inCall(true);
    pressure({ lowPower: true });
    await new Promise<void>(resolve => setTimeout(() => resolve(), 0));
    await calling.restoreVideoQuality();
    expect(calling.localMediaState().pressureNotice).toBeNull();

    pressure({ lowPower: false });
    await new Promise<void>(resolve => setTimeout(() => resolve(), 0));
    (native.applyVideoCap as jest.Mock).mockClear();
    pressure({ lowPower: true });
    await new Promise<void>(resolve => setTimeout(() => resolve(), 0));

    expect(native.applyVideoCap).toHaveBeenCalledWith(CID, 640, 24);
    expect(calling.localMediaState().pressureNotice).toBe('Low Power Mode');
    expect(calling.localMediaState().pressureRestorable).toBe(true);
  });

  it('does not let a pressure decision for a DEAD call touch the next one', async () => {
    // applyPressure suspends across the native bridge. If the call it was
    // deciding for ends while it is suspended, its continuation must not
    // write that decision over the next call's media state.
    await inCall(true);
    let release: () => void = () => undefined;
    (native.applyVideoCap as jest.Mock).mockImplementationOnce(
      () => new Promise<void>(resolve => { release = resolve; }),
    );
    pressure({ state: 'critical' });
    await Promise.resolve();

    await calling.callController().hangup();
    pressure({ state: 'nominal' });
    const CID2 = '01J0000000000000000000000Q';
    await calling.callController().placeCall(PEER, CID2, true);
    release();
    await new Promise<void>(resolve => setTimeout(() => resolve(), 0));

    expect(calling.localMediaState().videoEnabled).toBe(true);
    expect(calling.localMediaState().pressureNotice).toBeNull();
  });

  it('offers voice on a flat battery without taking it', async () => {
    await inCall(true);
    pressure({ battery: 0.05 });
    await new Promise<void>(resolve => setTimeout(() => resolve(), 0));

    expect(calling.localMediaState().offerVoice).toBe(true);
    // Still sending video: the offer is the whole action.
    expect(calling.localMediaState().videoEnabled).toBe(true);

    await calling.switchToVoice();
    expect(calling.localMediaState().videoEnabled).toBe(false);
    expect(native.setVideoEnabled).toHaveBeenCalledWith(CID, false);
  });

  it('monitors only while a call is up', async () => {
    expect(native.startMonitoringPressure).not.toHaveBeenCalled();
    await inCall(true);
    expect(native.startMonitoringPressure).toHaveBeenCalled();
  });
});

/**
 * The quality indicator.
 *
 * `CallScreen` has taken a `quality` prop since V5 and nothing ever passed
 * one, so every call — however bad — showed one bar. Same family as the rest
 * of this file: the control existed, the number behind it did not.
 */
describe('the quality indicator is fed a real number', () => {
  it('samples only while connected, and stops when the call ends', async () => {
    jest.useFakeTimers();
    try {
      await inCall(true);
      // Dialling is not connected: there is no media to measure yet, and a
      // sample now would paint a bar for a call that has not started.
      jest.advanceTimersByTime(10_000);
      expect(native.sampleQuality).not.toHaveBeenCalled();

      await calling.callController().onIceStateChanged(CID, 'connected');
      jest.advanceTimersByTime(3_000);
      expect(native.sampleQuality).toHaveBeenCalledWith(CID);

      (native.sampleQuality as jest.Mock).mockClear();
      await calling.callController().hangup();
      jest.advanceTimersByTime(30_000);
      // A timer that outlived the call would poll a peer connection that no
      // longer exists, every three seconds, forever.
      expect(native.sampleQuality).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('starts optimistic rather than at one bar', async () => {
    // An indicator that opens on "poor" and climbs is worse than none: the
    // first frame is what the person reads.
    await inCall(false);
    expect(calling.localMediaState().quality).toBe(3);
  });

  it('never lets the stats themselves cross the bridge', async () => {
    // The native side returns a LEVEL. `getStats` output carries candidate
    // addresses — the other person's IP — so the strongest version of "it
    // never leaves the device" is one where no payload crosses at all.
    await inCall(true);
    await calling.callController().onIceStateChanged(CID, 'connected');
    expect(native.getStats).not.toHaveBeenCalled();
  });
});
