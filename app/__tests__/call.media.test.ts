import { AppState, type AppStateStatus } from 'react-native';
import * as native from 'tacendum-call';
import * as calling from '../src/call';
import * as db from '../src/db';
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

  it('does not let a late flip change the next call’s preview', async () => {
    const nextCid = '01J0000000000000000000000Q';
    await inCall(true);
    let finish: () => void = () => undefined;
    (native.switchCamera as jest.Mock).mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          finish = resolve;
        }),
    );

    const oldFlip = calling.flipCamera();
    await flush();
    await calling.callController().hangup();
    await calling.callController().placeCall(PEER, nextCid, true);
    expect(calling.localMediaState().frontCamera).toBe(true);

    finish();
    await oldFlip;

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

  it('stops sampling when the calling integration is torn down', async () => {
    jest.useFakeTimers();
    try {
      await inCall(false);
      await calling.callController().onIceStateChanged(CID, 'connected');
      (native.sampleQuality as jest.Mock).mockClear();

      teardown?.();
      teardown = undefined;
      await jest.advanceTimersByTimeAsync(30_000);

      expect(native.sampleQuality).not.toHaveBeenCalled();
      expect(calling.localMediaState()).toMatchObject({
        quality: -1,
        qualityStatus: 'unavailable',
      });
    } finally {
      calling.resetCallingForTests();
      jest.useRealTimers();
    }
  });

  it('starts as checking instead of claiming a measurement', async () => {
    // Connected has not supplied a packet sample yet. Three bars here would
    // claim a good connection from absence of evidence; one bar would make
    // the same mistake in the other direction.
    await inCall(false);
    expect(calling.localMediaState()).toMatchObject({
      quality: -1,
      qualityStatus: 'checking',
    });
  });

  it('shows explicit unknown when native has no packets yet', async () => {
    jest.useFakeTimers();
    try {
      (native.sampleQuality as jest.Mock).mockResolvedValueOnce(-1);
      await inCall(false);
      await calling.callController().onIceStateChanged(CID, 'connected');

      await jest.advanceTimersByTimeAsync(3_000);

      expect(calling.localMediaState()).toMatchObject({
        quality: -1,
        qualityStatus: 'unavailable',
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it.each([0, 4, 2.5, Number.NaN])(
    'rejects malformed native level %p instead of drawing bars',
    async level => {
      jest.useFakeTimers();
      try {
        (native.sampleQuality as jest.Mock).mockResolvedValueOnce(level);
        await inCall(false);
        await calling.callController().onIceStateChanged(CID, 'connected');

        await jest.advanceTimersByTimeAsync(3_000);

        expect(calling.localMediaState()).toMatchObject({
          quality: -1,
          qualityStatus: 'unavailable',
        });
      } finally {
        jest.useRealTimers();
      }
    },
  );

  it('accepts only the three measured levels', async () => {
    jest.useFakeTimers();
    try {
      (native.sampleQuality as jest.Mock)
        .mockResolvedValueOnce(1)
        .mockResolvedValueOnce(2)
        .mockResolvedValueOnce(3);
      await inCall(false);
      await calling.callController().onIceStateChanged(CID, 'connected');

      for (const expected of [1, 2, 3]) {
        await jest.advanceTimersByTimeAsync(3_000);
        expect(calling.localMediaState()).toMatchObject({
          quality: expected,
          qualityStatus: 'measured',
        });
      }
    } finally {
      jest.useRealTimers();
    }
  });

  it('clears a prior good reading when the next sample fails', async () => {
    jest.useFakeTimers();
    try {
      (native.sampleQuality as jest.Mock)
        .mockResolvedValueOnce(3)
        .mockRejectedValueOnce(new Error('stats unavailable'));
      await inCall(false);
      await calling.callController().onIceStateChanged(CID, 'connected');

      await jest.advanceTimersByTimeAsync(3_000);
      expect(calling.localMediaState().quality).toBe(3);
      await jest.advanceTimersByTimeAsync(3_000);

      expect(calling.localMediaState()).toMatchObject({
        quality: -1,
        qualityStatus: 'unavailable',
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('marks one hung sample unavailable without overlapping it or accepting its late answer', async () => {
    jest.useFakeTimers();
    try {
      let finishOld: (level: number) => void = () => undefined;
      (native.sampleQuality as jest.Mock)
        .mockImplementationOnce(
          () =>
            new Promise<number>(resolve => {
              finishOld = resolve;
            }),
        )
        .mockResolvedValueOnce(2);
      await inCall(false);
      await calling.callController().onIceStateChanged(CID, 'connected');

      await jest.advanceTimersByTimeAsync(3_000);
      expect(native.sampleQuality).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(3_000);
      expect(native.sampleQuality).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(2_000);
      expect(calling.localMediaState()).toMatchObject({
        quality: -1,
        qualityStatus: 'unavailable',
      });

      await jest.advanceTimersByTimeAsync(1_000);
      expect(native.sampleQuality).toHaveBeenCalledTimes(1);

      finishOld(3);
      await flush();
      expect(calling.localMediaState()).toMatchObject({
        quality: -1,
        qualityStatus: 'unavailable',
      });

      await jest.advanceTimersByTimeAsync(3_000);
      expect(native.sampleQuality).toHaveBeenCalledTimes(2);
      expect(calling.localMediaState().quality).toBe(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('invalidates an old sample across reconnect and starts the new lifetime checking', async () => {
    jest.useFakeTimers();
    try {
      let finishOld: (level: number) => void = () => undefined;
      (native.sampleQuality as jest.Mock)
        .mockImplementationOnce(
          () =>
            new Promise<number>(resolve => {
              finishOld = resolve;
            }),
        )
        .mockResolvedValueOnce(1);
      await inCall(false);
      await calling.callController().onIceStateChanged(CID, 'connected');
      await jest.advanceTimersByTimeAsync(3_000);

      await calling.callController().onIceStateChanged(CID, 'disconnected');
      expect(calling.localMediaState()).toMatchObject({
        quality: -1,
        qualityStatus: 'unavailable',
      });
      await calling.callController().onIceStateChanged(CID, 'connected');
      expect(calling.localMediaState()).toMatchObject({
        quality: -1,
        qualityStatus: 'checking',
      });

      await jest.advanceTimersByTimeAsync(3_000);
      expect(native.sampleQuality).toHaveBeenCalledTimes(1);
      finishOld(3);
      await flush();

      // The old lifetime's answer retires the native request but cannot paint
      // this one. Its next scheduled tick is the first safe retry.
      expect(calling.localMediaState().quality).toBe(-1);
      await jest.advanceTimersByTimeAsync(3_000);
      expect(calling.localMediaState().quality).toBe(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('bounds checking after reconnect while one same-cid native request never settles', async () => {
    jest.useFakeTimers();
    try {
      (native.sampleQuality as jest.Mock).mockImplementationOnce(
        () => new Promise<number>(() => undefined),
      );
      await inCall(false);
      await calling.callController().onIceStateChanged(CID, 'connected');
      await jest.advanceTimersByTimeAsync(3_000);

      await calling.callController().onIceStateChanged(CID, 'disconnected');
      await calling.callController().onIceStateChanged(CID, 'connected');
      expect(calling.localMediaState().qualityStatus).toBe('checking');

      await jest.advanceTimersByTimeAsync(8_000);

      expect(native.sampleQuality).toHaveBeenCalledTimes(1);
      expect(calling.localMediaState()).toMatchObject({
        quality: -1,
        qualityStatus: 'unavailable',
      });
    } finally {
      teardown?.();
      teardown = undefined;
      calling.resetCallingForTests();
      jest.useRealTimers();
    }
  });

  it('lets a new cid sample while rejecting the ended call’s delayed result', async () => {
    jest.useFakeTimers();
    try {
      const nextCid = '01J0000000000000000000000T';
      let finishOld: (level: number) => void = () => undefined;
      (native.sampleQuality as jest.Mock)
        .mockImplementationOnce(
          () =>
            new Promise<number>(resolve => {
              finishOld = resolve;
            }),
        )
        .mockResolvedValueOnce(2);
      await inCall(false);
      await calling.callController().onIceStateChanged(CID, 'connected');
      await jest.advanceTimersByTimeAsync(3_000);

      await calling.callController().hangup();
      await calling.callController().placeCall(PEER, nextCid, false);
      await calling.callController().onIceStateChanged(nextCid, 'connected');
      await jest.advanceTimersByTimeAsync(3_000);

      expect(native.sampleQuality).toHaveBeenLastCalledWith(nextCid);
      expect(calling.localMediaState()).toMatchObject({
        quality: 2,
        qualityStatus: 'measured',
      });

      finishOld(3);
      await flush();
      expect(calling.localMediaState().quality).toBe(2);
    } finally {
      calling.resetCallingForTests();
      jest.useRealTimers();
    }
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

// ---------------------------------------------------------------------------
// The local mirror versus what the tracks actually do.
// ---------------------------------------------------------------------------

const CID_IN = '01J0000000000000000000000R';
const OFFER_SDP = 'v=0\r\na=fingerprint:sha-256 AA:BB\r\nOFFER';

async function flush(): Promise<void> {
  for (let i = 0; i < 60; i++) await Promise.resolve();
}

/**
 * Ring this phone with a 1:1 offer, through messaging's envelope listener —
 * the seam production delivers on — and settle the controller.
 */
async function ringing(video: boolean, chat: Partial<db.ChatRow> = {}): Promise<void> {
  jest.spyOn(messaging, 'onEnvelope');
  jest.spyOn(messaging, 'sendCallEnvelope').mockResolvedValue(undefined);
  // Someone this phone has HISTORY with (§10.6): the ring rule silences an
  // unknown caller, and this file has no database to hold a chat row.
  jest
    .spyOn(db, 'getChat')
    .mockResolvedValue({ peerId: PEER, lastMessageAt: Date.now(), ...chat } as db.ChatRow);
  teardown = await calling.startCalling();
  const listener = (messaging.onEnvelope as jest.Mock).mock.calls.at(-1)![0] as (
    peerId: string,
    envelope: unknown,
    meta: { msgId: string; ts: number },
  ) => void;
  listener(
    PEER,
    { tcm: 'call.offer', cid: CID_IN, sdp: OFFER_SDP, vid: video, exp: Date.now() + 60_000 },
    { msgId: '01HQMSG000000000000000000B', ts: Date.now() },
  );
  await flush();
  await calling.callController().whenIdle();
  expect(calling.currentStateForTests().name).toBe('incoming_ringing');
}

/**
 * An offer from someone this phone has NO history with (§10.6, the default
 * ON): the controller silences it and writes the missed row on the person's
 * behalf. The row write fails here exactly as in `ringing` — no database —
 * which is the locked phone's own case.
 */
async function silencedOffer(): Promise<void> {
  jest.spyOn(messaging, 'onEnvelope');
  jest.spyOn(messaging, 'sendCallEnvelope').mockResolvedValue(undefined);
  jest.spyOn(db, 'getChat').mockResolvedValue(null);
  teardown = await calling.startCalling();
  const listener = (messaging.onEnvelope as jest.Mock).mock.calls.at(-1)![0] as (
    peerId: string,
    envelope: unknown,
    meta: { msgId: string; ts: number },
  ) => void;
  listener(
    PEER,
    { tcm: 'call.offer', cid: CID_IN, sdp: OFFER_SDP, vid: false, exp: Date.now() + 60_000 },
    { msgId: '01HQMSG000000000000000000C', ts: Date.now() },
  );
  await flush();
  await calling.callController().whenIdle();
}

describe('the camera toggle honours the native verdict', () => {
  it('does not claim a camera the call never negotiated', async () => {
    // An audio call has no video m-line and no local video track;
    // `setVideoEnabled` answers `false`. The flag used to flip anyway: a
    // black preview here, and `call.media{v:true}` to a peer whose whole
    // screen then became a black video surface.
    await inCall(false);
    const sent = messaging.sendCallEnvelope as jest.Mock;
    sent.mockClear();
    (native.setVideoEnabled as jest.Mock).mockResolvedValueOnce(false);

    await calling.toggleVideo();

    expect(calling.localMediaState().videoEnabled).toBe(false);
    expect(sent.mock.calls.some(c => c[1]?.tcm === 'call.media')).toBe(false);
  });

  it('still turns a negotiated camera off and on', async () => {
    await inCall(true);
    await calling.toggleVideo();
    expect(calling.localMediaState().videoEnabled).toBe(false);
    await calling.toggleVideo();
    expect(calling.localMediaState().videoEnabled).toBe(true);
  });
});

describe('"Answer without video" re-derives the mirror', () => {
  it('says the camera is off for a video invite answered as audio', async () => {
    // The reset is keyed on the cid, and the cid does not change between the
    // ring and the answer — so the mirror kept saying "camera on" for a call
    // whose answer never started it: "Turn camera off" over a black preview,
    // Flip enabled, and a tap straight into a black far end.
    await ringing(true);
    expect(calling.localMediaState().videoEnabled).toBe(true);
    (native.setSpeaker as jest.Mock).mockClear();

    await calling.callController().accept({ video: false });
    await flush();

    expect(calling.callController().state.call?.video).toBe(false);
    expect(calling.localMediaState().videoEnabled).toBe(false);
    // The route follows: an audio answer is heard at the ear.
    expect(native.setSpeaker).toHaveBeenCalledWith(CID_IN, false);
    expect(calling.localMediaState().speakerOn).toBe(false);
  });

  it('keeps the camera on for a video invite answered with video', async () => {
    await ringing(true);
    await calling.callController().accept();
    await flush();
    expect(calling.callController().state.call?.video).toBe(true);
    expect(calling.localMediaState().videoEnabled).toBe(true);
  });
});

describe('backgrounding a video call tells the peer (§6.6)', () => {
  let onAppState: ((next: AppStateStatus) => void) | null = null;
  let remove: jest.Mock;
  let restore: () => void = () => undefined;

  beforeEach(() => {
    onAppState = null;
    remove = jest.fn();
    const capture = ((type: string, handler: (next: AppStateStatus) => void) => {
      if (type === 'change') onAppState = handler;
      return { remove };
    }) as unknown as typeof AppState.addEventListener;
    // The preset already mocks `addEventListener`; a `mockRestore` on an
    // existing jest.fn would wipe its implementation for every later test
    // in this file, so the original implementation is put back by hand.
    const add = AppState.addEventListener as unknown as jest.Mock;
    if (jest.isMockFunction(add)) {
      const original = add.getMockImplementation();
      add.mockImplementation(capture);
      restore = () => void add.mockImplementation(original);
    } else {
      const spy = jest.spyOn(AppState, 'addEventListener').mockImplementation(capture);
      restore = () => spy.mockRestore();
    }
  });

  afterEach(() => {
    restore();
  });

  it('disables the camera and announces v:false on background, restores it on return', async () => {
    // iOS interrupts the capture session in the background; nothing told the
    // peer, who watched a frozen frame under "Connected".
    await inCall(true);
    expect(onAppState).not.toBeNull();
    const sent = messaging.sendCallEnvelope as jest.Mock;
    sent.mockClear();
    (native.setVideoEnabled as jest.Mock).mockClear();

    onAppState!('background');
    await flush();

    expect(native.setVideoEnabled).toHaveBeenCalledWith(CID, false);
    expect(calling.localMediaState().videoEnabled).toBe(false);
    let media = sent.mock.calls.find(c => c[1]?.tcm === 'call.media');
    expect(media?.[1]).toMatchObject({ cid: CID, v: false });

    sent.mockClear();
    onAppState!('active');
    await flush();

    expect(native.setVideoEnabled).toHaveBeenCalledWith(CID, true);
    expect(calling.localMediaState().videoEnabled).toBe(true);
    media = sent.mock.calls.find(c => c[1]?.tcm === 'call.media');
    expect(media?.[1]).toMatchObject({ cid: CID, v: true });
  });

  it('leaves a camera the person turned off alone, and restores nothing', async () => {
    await inCall(true);
    await calling.toggleVideo();
    expect(calling.localMediaState().videoEnabled).toBe(false);
    (native.setVideoEnabled as jest.Mock).mockClear();

    onAppState!('background');
    await flush();
    onAppState!('active');
    await flush();

    expect(native.setVideoEnabled).not.toHaveBeenCalled();
    expect(calling.localMediaState().videoEnabled).toBe(false);
  });

  it('restores only the call that was paused, never the next one', async () => {
    await inCall(true);
    onAppState!('background');
    await flush();
    await calling.callController().hangup();
    const CID2 = '01J0000000000000000000000S';
    await calling.callController().placeCall(PEER, CID2, false);
    (native.setVideoEnabled as jest.Mock).mockClear();

    onAppState!('active');
    await flush();

    expect(native.setVideoEnabled).not.toHaveBeenCalled();
    expect(calling.localMediaState().videoEnabled).toBe(false);
  });

  it('is a no-op with no call up', async () => {
    jest.spyOn(messaging, 'sendCallEnvelope').mockResolvedValue(undefined);
    teardown = await calling.startCalling();
    onAppState!('background');
    await flush();
    expect(native.setVideoEnabled).not.toHaveBeenCalled();
  });

  it('removes its listener when calling stops', async () => {
    await inCall(true);
    teardown?.();
    teardown = undefined;
    expect(remove).toHaveBeenCalled();
  });
});

describe('mute honours the native verdict', () => {
  it('a connected call whose track refused the change claims nothing', async () => {
    await inCall(true);
    await calling.callController().onIceStateChanged(CID, 'connected');
    const sent = messaging.sendCallEnvelope as jest.Mock;
    sent.mockClear();
    (native.setAudioEnabled as jest.Mock).mockResolvedValueOnce(false);

    const result = await calling.toggleMute();

    expect(result).toBe('refused');
    expect(calling.localMediaState().muted).toBe(false);
    expect(sent.mock.calls.some(c => c[1]?.tcm === 'call.media')).toBe(false);
  });

  it('a reconnecting call whose live track refused mute stays visibly and actually live', async () => {
    // This call already had media. `reconnecting` is not the pre-track window:
    // accepting `false` as queued intent here put a muted button over the
    // unchanged live microphone and told the peer it was muted.
    await inCall(true);
    await calling.callController().onIceStateChanged(CID, 'connected');
    await calling.callController().onIceStateChanged(CID, 'disconnected');
    const sent = messaging.sendCallEnvelope as jest.Mock;
    sent.mockClear();
    (native.setAudioEnabled as jest.Mock).mockResolvedValueOnce(false);

    const result = await calling.toggleMute();

    expect(result).toBe('refused');
    expect(calling.localMediaState().muted).toBe(false);
    expect(sent.mock.calls.some(c => c[1]?.tcm === 'call.media')).toBe(false);
  });

  it('a mute before the track exists is kept as intent and landed when the track is born', async () => {
    // The CallKit Mute tapped right after answering a video call lands
    // inside the camera-enumeration window, before `addLocalMedia` has
    // installed the audio track: native answers `false`. The flag used to
    // flip and the announce go out, and the track installed a moment later
    // came up ENABLED — a muted UI over a live microphone.
    let release: (sdp: string) => void = () => undefined;
    (native.createOffer as jest.Mock).mockImplementationOnce(
      () =>
        new Promise<string>(resolve => {
          release = resolve;
        }),
    );
    jest.spyOn(messaging, 'sendCallEnvelope').mockResolvedValue(undefined);
    teardown = await calling.startCalling();
    const placing = calling.callController().placeCall(PEER, CID, true);
    await flush();
    expect(calling.currentStateForTests().name).toBe('outgoing_connecting');

    (native.setAudioEnabled as jest.Mock).mockResolvedValueOnce(false);
    await calling.toggleMute();
    // The intent is kept — CallKit and the button agree with what was asked…
    expect(calling.localMediaState().muted).toBe(true);
    (native.setAudioEnabled as jest.Mock).mockClear();

    // …and the moment the track exists, it is landed on it.
    release(OFFER_SDP);
    await placing;
    await flush();
    expect(native.setAudioEnabled).toHaveBeenCalledWith(CID, false);
  });

  it('the CallKit mute button goes through the same verdict', async () => {
    await inCall(true);
    await calling.callController().onIceStateChanged(CID, 'connected');
    (native.setAudioEnabled as jest.Mock).mockResolvedValueOnce(false);

    (native as unknown as { __call: { emit: (n: string, p: unknown) => void } }).__call.emit(
      'callKitMute',
      { cid: CID, muted: true },
    );
    await flush();

    expect(calling.localMediaState().muted).toBe(false);
  });

  it('a camera intent is landed on the born track as well', async () => {
    let release: (sdp: string) => void = () => undefined;
    (native.createOffer as jest.Mock).mockImplementationOnce(
      () =>
        new Promise<string>(resolve => {
          release = resolve;
        }),
    );
    jest.spyOn(messaging, 'sendCallEnvelope').mockResolvedValue(undefined);
    teardown = await calling.startCalling();
    const placing = calling.callController().placeCall(PEER, CID, true);
    await flush();
    // The camera turned off while the track was still being built: the
    // verdict is `true` here (the mock's default) but the point is the
    // re-apply — the same level-triggered rule `applyPressure` follows.
    await calling.toggleVideo();
    expect(calling.localMediaState().videoEnabled).toBe(false);
    (native.setVideoEnabled as jest.Mock).mockClear();

    release(OFFER_SDP);
    await placing;
    await flush();
    expect(native.setVideoEnabled).toHaveBeenCalledWith(CID, false);
  });

  it('returns the camera verdict and never changes the selected audio route', async () => {
    await inCall(true);
    (native.setSpeaker as jest.Mock).mockClear();
    (native.setVideoEnabled as jest.Mock).mockResolvedValueOnce(false);

    const refused = await calling.toggleVideo();

    expect(refused).toBe('refused');
    expect(calling.localMediaState().videoEnabled).toBe(true);
    expect(native.setSpeaker).not.toHaveBeenCalled();

    (native.setVideoEnabled as jest.Mock).mockResolvedValueOnce(true);
    const applied = await calling.toggleVideo();

    expect(applied).toBe('applied');
    expect(calling.localMediaState().videoEnabled).toBe(false);
    expect(native.setSpeaker).not.toHaveBeenCalled();
  });
});

describe('a missed call posts a notice', () => {
  let post: jest.SpyInstance;

  beforeEach(() => {
    // Through the seam: the module mock predates the method, and a copy of
    // the namespace is what this file holds.
    post = jest.spyOn(calling.missedCallBridge, 'post').mockResolvedValue(undefined);
  });

  afterEach(() => {
    post.mockRestore();
    jest.useRealTimers();
  });

  it('posts "Missed call" with the name this device holds when the ring runs out — with or without a row', async () => {
    // No database here, so the row write fails; the notice must not.
    jest.useFakeTimers();
    await ringing(false, { displayName: 'Dana', localName: '' });

    await jest.advanceTimersByTimeAsync(61_000);
    await flush();
    await calling.callController().whenIdle();

    expect(calling.currentStateForTests().name).toBe('idle');
    expect(post).toHaveBeenCalledWith(PEER, 'Dana');
  });

  it('sends an EMPTY name when it knows none — never a raw id fragment', async () => {
    // '' lets native fall back to the name mirror the ring itself paints
    // from; a short id on the lock screen would name nobody the owner
    // recognises and identify them to anyone else.
    jest.useFakeTimers();
    await ringing(false);

    await jest.advanceTimersByTimeAsync(61_000);
    await flush();
    await calling.callController().whenIdle();

    expect(post).toHaveBeenCalledWith(PEER, '');
  });

  it('posts nothing for a call the person declined', async () => {
    await ringing(false);
    await calling.callController().decline();
    await flush();
    await calling.callController().whenIdle();
    expect(post).not.toHaveBeenCalled();
  });

  it('posts NOTHING for a silenced stranger — the row is the evidence, the phone stays quiet', async () => {
    // The notice is audible and lock-screen visible (`content.sound =
    // .default`, IMPORTANCE_DEFAULT). Keyed on `missed` alone it fired for
    // the row the silence policy writes on a stranger's behalf — the exact
    // interrupt §10.6 closes, once per offer, for anyone holding the id.
    await silencedOffer();

    expect(calling.currentStateForTests().name).toBe('idle');
    expect(native.reportIncomingCall).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it('posts nothing for an outgoing call nobody answered', async () => {
    jest.useFakeTimers();
    jest.spyOn(messaging, 'sendCallEnvelope').mockResolvedValue(undefined);
    teardown = await calling.startCalling();
    await calling.callController().placeCall(PEER, CID, false);
    await jest.advanceTimersByTimeAsync(61_000);
    await flush();
    await calling.callController().whenIdle();
    expect(post).not.toHaveBeenCalled();
  });
});
