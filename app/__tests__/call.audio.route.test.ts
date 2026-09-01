import * as native from 'tacendum-call';
import * as calling from '../src/call';
import * as db from '../src/db';
import { messaging } from '../src/messaging';

/**
 * THE OUTPUT ROUTE OF A VIDEO CALL — the half of it that lives above the
 * bridge (`src/call/index.ts`).
 *
 * The reported defect: answering a video call showed the speaker button LIT
 * while the audio came out of the earpiece, on BOTH phones, and toggling the
 * button off and on again fixed it. The trace below is why that is not a
 * JS bug in the ordinary sense and could not be fixed here alone:
 *
 *   1. The route is asked for exactly once, at the moment the call first has
 *      a cid — which on the answering side is while it is still RINGING,
 *      before the person has touched anything and long before CallKit
 *      activates the audio session.
 *   2. Above the bridge, nothing USED to ask again at or after activation —
 *      `callKitAudioActivated` had no subscriber anywhere in `src/`. It has
 *      one now (`startCalling`, src/call/index.ts): activation is the first
 *      moment the route can actually take, so a LIT speaker button is
 *      re-asserted against the now-active session, under the same
 *      the-flag-follows-the-route honesty rule as every other arm. The last
 *      describe block below is that subscriber's contract.
 *
 * So whether the loudspeaker actually happens rests FIRST on the native
 * store-the-desire-and-apply-it-on-`didActivate` path — and on nothing else
 * overwriting the category afterwards, which is exactly what libwebrtc's own
 * `ConfigureAudioSession` was doing. That fix is in
 * `modules/tacendum-call/ios/TacendumCallImpl.swift` and **cannot be reached
 * from jest at all**: category options, audio units and speakers are hardware.
 * The same is true of the three native halves of the dead-audio-at-connect
 * fix (CallKitCenter.swift): the manual-audio gate arming at construction,
 * the CXAnswerCallAction an in-app accept now requests, and `didActivate`'s
 * route-before-unit ordering all live below the bridge, where jest cannot
 * see them. What jest CAN see — and what this file therefore pins — is the
 * JS-observable contract around them. See the header of
 * `applyWebRTCAudioConfiguration` there, and DEVICE VERIFICATION in this
 * task's report.
 *
 * WHAT THIS FILE CAN PROVE is the other half of the same defect, and the half
 * that made it ship: the button claimed a route the device had not taken. The
 * flag was set from `call.video` alone and the bridge call was
 * fire-and-forget, so a refused route left a lit speaker button with nothing
 * to correct it — the group arm (`group.ts`'s `setSpeakerEnabled`) already
 * refuses to do that, and this arm did not.
 */

const SELF = '01HQ5E1F00000000000000000A';
const CID = '01J0000000000000000000000N';
const CID2 = '01J0000000000000000000000P';
const PEER = '01PEERZ3NDEKTSV4RRFFQ69G5F';
const MSG = '01HQMSG000000000000000000A';
const SDP = 'v=0\r\na=fingerprint:sha-256 AA:BB\r\nOFFER';

const sqlite = (
  jest.requireMock('@op-engineering/op-sqlite') as {
    __sqlite: { instances: Map<string, { execute: jest.Mock }>; reset: () => void };
  }
).__sqlite;

let teardown: (() => void) | undefined;

async function flush(): Promise<void> {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}

/** Answer one query shape with rows, leaving every other query alone
 * (`call.wiring.test.ts`'s helper, and the same real `db.ts` underneath). */
function answerWith(match: RegExp, rows: unknown[]): void {
  const instance = sqlite.instances.get('tacendum.sqlite')!;
  const base = instance.execute.getMockImplementation()!;
  instance.execute.mockImplementation(async (sql: unknown, params: unknown) => {
    if (match.test(String(sql))) return { rows };
    return base(sql, params);
  });
}

/** A profile on disk — both of the reads that ask for one. */
function withProfile(): void {
  answerWith(/SELECT key, value FROM profile/, [
    { key: 'userId', value: SELF },
    { key: 'registrationId', value: '42' },
  ]);
  answerWith(/SELECT value FROM profile WHERE key = 'userId'/, [{ value: SELF }]);
}

/** THIS phone places the call. */
async function placed(video: boolean): Promise<void> {
  jest.spyOn(messaging, 'sendCallEnvelope').mockResolvedValue(undefined);
  teardown = await calling.startCalling();
  await calling.callController().placeCall(PEER, CID, video);
}

/**
 * THIS phone is rung — the arm the report is actually about ("the same goes
 * for person B's phone").
 *
 * Through the REAL envelope path (`messaging.onEnvelope`, which is what
 * `startCalling` subscribes), not by dispatching to the reducer: the speaker
 * request under test is raised by `notify`, and `notify` only runs for a
 * state that arrived the way production's does.
 */
async function rung(video: boolean): Promise<void> {
  jest.spyOn(messaging, 'sendCallEnvelope').mockResolvedValue(undefined);
  jest.spyOn(messaging, 'onEnvelope');
  teardown = await calling.startCalling();
  // An unknown caller is silenced by default, and a silenced call
  // never reaches the state this file is about.
  await calling.setSilenceUnknownCallers(false);
  const listener = (messaging.onEnvelope as jest.Mock).mock.calls.at(-1)![0] as (
    peerId: string,
    envelope: unknown,
    meta: { msgId: string; ts: number },
  ) => void;
  listener(
    PEER,
    { tcm: 'call.offer', cid: CID, sdp: SDP, vid: video, exp: Date.now() + 60_000 },
    { msgId: MSG, ts: Date.now() },
  );
  await flush();
}

beforeEach(async () => {
  calling.resetCallingForTests();
  jest.clearAllMocks();
  await db.close();
  sqlite.reset();
  db.setWorkspace('real');
  await db.initDb();
  jest.spyOn(messaging, 'sendGroupCallEnvelope').mockResolvedValue(undefined);
});

afterEach(async () => {
  teardown?.();
  teardown = undefined;
  calling.resetCallingForTests();
  jest.restoreAllMocks();
  await db.close();
});

describe('when the route is asked for, on both phones', () => {
  it('asks while the call is still RINGING, which is before any session exists', async () => {
    // The precondition for the whole native defect. `overrideOutputAudioPort`
    // and `.defaultToSpeaker` mean nothing on a session that is not active,
    // and this is the only moment JS ever asks: by the time CallKit activates
    // one, the request is already minutes old in machine terms and lives only
    // as the desire CallKitCenter stored.
    await rung(true);

    expect(calling.currentStateForTests().name).toBe('incoming_ringing');
    expect(native.setSpeaker).toHaveBeenCalledWith(CID, true);
  });

  it('does not ask again when the call is answered', async () => {
    // Documented, not desired: `notify` raises the request on a CHANGE of
    // cid, and answering keeps the cid. The next chance to get the route
    // right is ACTIVATION (the last describe block); everything between
    // belongs to native.
    await rung(true);
    const atRing = (native.setSpeaker as jest.Mock).mock.calls.length;

    await calling.callController().accept({ video: true });
    await flush();

    expect(calling.currentStateForTests().name).toBe('incoming_answering');
    expect((native.setSpeaker as jest.Mock).mock.calls.length).toBe(atRing);
  });

  it('asks on the CALLING side too, before the call is even connected', async () => {
    await placed(true);

    expect(native.setSpeaker).toHaveBeenCalledWith(CID, true);
    const asked = (native.setSpeaker as jest.Mock).mock.invocationCallOrder[0];
    const connected = (native.reportOutgoingConnected as jest.Mock).mock.invocationCallOrder[0];
    expect(connected === undefined || asked < connected).toBe(true);
  });

  it('asks for nothing at all on a voice call', async () => {
    // The route a voice call wants IS the default one, which is why this
    // defect is a video-call defect: the earpiece is where an audio call was
    // always going to land, so nothing was ever overwritten.
    await rung(false);

    expect(calling.localMediaState().speakerOn).toBe(false);
    expect(native.setSpeaker).not.toHaveBeenCalled();
  });
});

describe('the speaker button may not claim a route the device did not take', () => {
  it('does not light on an ANSWERED video call whose route was refused', async () => {
    (native.setSpeaker as jest.Mock).mockRejectedValueOnce(new Error('no route'));

    await rung(true);
    await flush();

    expect(calling.localMediaState().speakerOn).toBe(false);
  });

  it('does not light on a PLACED video call whose route was refused', async () => {
    (native.setSpeaker as jest.Mock).mockRejectedValueOnce(new Error('no route'));

    await placed(true);
    await flush();

    expect(calling.localMediaState().speakerOn).toBe(false);
  });

  it('leaves the button alone when a mid-call tap is refused', async () => {
    await placed(false);
    expect(calling.localMediaState().speakerOn).toBe(false);
    (native.setSpeaker as jest.Mock).mockRejectedValueOnce(new Error('no route'));

    // Swallowed, like the group arm's: `App.tsx` calls this as
    // `void toggleSpeaker()`, so a rejection is an unhandled one and the
    // person still gets no explanation. The button telling the truth is the
    // whole remedy available here.
    await expect(calling.toggleSpeaker()).resolves.toBeUndefined();

    expect(calling.localMediaState().speakerOn).toBe(false);
  });

  it('still lights, and re-renders, when the tap is taken', async () => {
    // The other direction, so a fix cannot be "never light the button".
    await placed(false);
    const seen: unknown[] = [];
    calling.subscribeForTests(s => seen.push(s));

    await calling.toggleSpeaker();

    expect(native.setSpeaker).toHaveBeenLastCalledWith(CID, true);
    expect(calling.localMediaState().speakerOn).toBe(true);
    expect(seen).toHaveLength(1);
  });

  it('lets a refusal that outlives its call correct only that call', async () => {
    // A bridge call outlives a hangup (`setSpeakerEnabled`'s rule in
    // group.ts). Writing the flag unconditionally in the failure path would
    // darken the NEXT call's button over a route that call took perfectly.
    let refuse: (e: unknown) => void = () => undefined;
    (native.setSpeaker as jest.Mock).mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          refuse = reject;
        }),
    );

    await placed(true);
    expect(calling.localMediaState().speakerOn).toBe(true);

    await calling.callController().hangup();
    await calling.callController().placeCall(PEER, CID2, true);
    await flush();
    expect(calling.localMediaState().speakerOn).toBe(true);

    refuse(new Error('the first call is long over'));
    await flush();

    expect(calling.localMediaState().speakerOn).toBe(true);
  });

  it('leaves the NEXT call alone when a tap is taken after this one is over', async () => {
    // The same rule in the other direction: the tap SUCCEEDS, but by the time
    // the bridge answers, the call it was tapped in is gone and the next one
    // has chosen its own route. Writing the flag unconditionally would darken
    // the new call's button over a loudspeaker it is genuinely using.
    await placed(true);
    let take: () => void = () => undefined;
    (native.setSpeaker as jest.Mock).mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          take = resolve;
        }),
    );

    const tap = calling.toggleSpeaker();
    await flush();
    await calling.callController().hangup();
    await calling.callController().placeCall(PEER, CID2, true);
    await flush();
    expect(calling.localMediaState().speakerOn).toBe(true);

    take();
    await tap;

    expect(calling.localMediaState().speakerOn).toBe(true);
  });

  it('leaves the NEXT call alone when a drop to voice lands too late', async () => {
    await placed(true);
    let take: () => void = () => undefined;
    (native.setSpeaker as jest.Mock).mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          take = resolve;
        }),
    );

    const drop = calling.switchToVoice();
    await flush();
    await calling.callController().hangup();
    await calling.callController().placeCall(PEER, CID2, true);
    await flush();

    take();
    await drop;

    expect(calling.localMediaState().speakerOn).toBe(true);
  });

  it('darkens the button when dropping to voice, only if the earpiece took it', async () => {
    await placed(true);
    expect(calling.localMediaState().speakerOn).toBe(true);
    (native.setSpeaker as jest.Mock).mockRejectedValueOnce(new Error('no route'));

    await calling.switchToVoice();

    // The camera IS off — `setVideoEnabled` is a track fact and it was
    // applied. The ROUTE was refused, so the button still says loudspeaker,
    // because that is what the device is still doing.
    expect(calling.localMediaState().videoEnabled).toBe(false);
    expect(calling.localMediaState().speakerOn).toBe(true);
  });
});

describe('the GROUP arm of the same twin', () => {
  /**
   * A session's speaker goes through
   * `groupCall().setSpeakerEnabled` — a different path from the 1:1
   * `native.setSpeaker` above, ending at the SAME native
   * `setSpeakerEnabled:` and therefore at the same libwebrtc overwrite.
   *
   * Its honesty about a refused route was already right (`group.ts`, "a
   * button that lights on a rejected bridge call is telling the person their
   * call is coming out of a speaker that it is not coming out of"), which is
   * where the 1:1 rule above was taken from. Guarded here so the two arms
   * cannot drift apart again.
   */
  async function inSession(): Promise<void> {
    jest.spyOn(messaging, 'sendCallEnvelope').mockResolvedValue(undefined);
    withProfile();
    teardown = await calling.startCalling();
    await calling.adoptWorkspaceForCalling();
    await calling.startGroupCall([PEER], false);
    await calling.groupCall().whenIdle();
  }

  it('does not light the session speaker on a refused route', async () => {
    await inSession();
    expect(calling.groupCallView()?.speakerOn).toBe(false);
    (native.setSpeaker as jest.Mock).mockRejectedValueOnce(new Error('no route'));

    await calling.toggleGroupSpeaker();

    expect(calling.groupCallView()?.speakerOn).toBe(false);
  });

  it('lights it when the route is taken', async () => {
    await inSession();

    await calling.toggleGroupSpeaker();

    expect(calling.groupCallView()?.speakerOn).toBe(true);
  });
});

describe('the route is re-asserted when CallKit activates the session', () => {
  /**
   * `callKitAudioActivated` IS `didActivate` reaching JS — the one moment at
   * which a route request stops being a stored desire and starts being a
   * physical fact. The subscriber re-asserts a LIT button against the
   * now-active session; beyond re-landing a request that was lost between
   * the cid-mint and activation, the route kick it produces is what forces
   * libwebrtc to re-initialize an audio unit that a same-instant start
   * failure left wedged (the field defect: a video call silent both ways
   * under a lit speaker button until a human toggled it).
   */
  function activated(): void {
    (native as unknown as { __call: { emit: (n: string, p: unknown) => void } }).__call.emit(
      'callKitAudioActivated',
      {},
    );
  }

  it('asks again for the loudspeaker on an ANSWERED video call', async () => {
    await rung(true);
    await calling.callController().accept({ video: true });
    await flush();
    const before = (native.setSpeaker as jest.Mock).mock.calls.length;

    activated();
    await flush();

    expect((native.setSpeaker as jest.Mock).mock.calls.length).toBe(before + 1);
    expect(native.setSpeaker).toHaveBeenLastCalledWith(CID, true);
    expect(calling.localMediaState().speakerOn).toBe(true);
  });

  it('asks again on a PLACED video call', async () => {
    await placed(true);
    const before = (native.setSpeaker as jest.Mock).mock.calls.length;

    activated();
    await flush();

    expect((native.setSpeaker as jest.Mock).mock.calls.length).toBe(before + 1);
    expect(native.setSpeaker).toHaveBeenLastCalledWith(CID, true);
  });

  it('still asks for nothing on a voice call, even at activation', async () => {
    // Requirement, not accident: the earpiece is the category DEFAULT, so an
    // audio call's route needs no bridge call at any moment — including this
    // one. Re-asserting `false` here would break the "asks for nothing at
    // all" contract above for zero routing benefit.
    await rung(false);

    activated();
    await flush();

    expect(calling.localMediaState().speakerOn).toBe(false);
    expect(native.setSpeaker).not.toHaveBeenCalled();
  });

  it('asks for nothing when no 1:1 call is live', async () => {
    // A session's activation belongs to the group arm; an idle activation
    // belongs to nobody. `current.call` is null in both.
    teardown = await calling.startCalling();

    activated();
    await flush();

    expect(native.setSpeaker).not.toHaveBeenCalled();
  });

  it('darkens the button when the re-assert is refused', async () => {
    // The flag follows the ROUTE (`toggleSpeaker`'s rule): a re-assert the
    // bridge refuses means the loudspeaker did NOT survive activation, and a
    // button still lit over the earpiece is the original lie again.
    await placed(true);
    expect(calling.localMediaState().speakerOn).toBe(true);
    (native.setSpeaker as jest.Mock).mockRejectedValueOnce(new Error('no route'));

    activated();
    await flush();

    expect(calling.localMediaState().speakerOn).toBe(false);
  });

  it('leaves the NEXT call alone when a refused re-assert outlives its call', async () => {
    // The bridge-call-outlives-a-hangup rule, on this arm too: the refusal
    // belongs to the call that was activating, never to the one that
    // replaced it.
    await placed(true);
    let refuse: (e: unknown) => void = () => undefined;
    (native.setSpeaker as jest.Mock).mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          refuse = reject;
        }),
    );

    activated();
    await flush();
    await calling.callController().hangup();
    await calling.callController().placeCall(PEER, CID2, true);
    await flush();
    expect(calling.localMediaState().speakerOn).toBe(true);

    refuse(new Error('the first call is long over'));
    await flush();

    expect(calling.localMediaState().speakerOn).toBe(true);
  });
});
