import { describe, expect, it } from 'vitest';
import {
  callReducer,
  idleState,
  type CallEvent,
  type CallState,
} from '../src/call-machine.js';

/**
 * `peerVideo` vs the ICE-restart answer.
 *
 * `restartReceived` replies to a restart with `vid: call.video` — a value
 * written once at accept and never again; camera toggles move only the app
 * layer's `localMedia.videoEnabled` and are announced via `call.media`,
 * which `mediaReceived` folds into `peerVideo`. So on a restart the wire
 * carries STALE accept-time truth, and a receiver that trusts it clobbers
 * the fresh truth it already holds.
 *
 * Device shape of the bug (verified on hardware): B turns the camera off, A
 * correctly shows B's photo; A's phone moves WiFi → LTE; the restart round
 * trip completes and the answer's `vid: true` flips `peerVideo` back on; the
 * photo unmounts and `RTCMTLVideoView` keeps presenting B's last decoded
 * frame — a frozen still of B shown as live video until B toggles again.
 *
 * The rule under test: only the FIRST answer speaks for the callee's camera.
 * The discriminator is `remoteReady` — the per-call latch that says "an
 * answer has already been applied" — NOT `state.name === 'reconnecting'`,
 * because the same clobber walks through the same door as a REDELIVERED
 * first answer while still in `outgoing_connecting`, and as an unsolicited
 * answer to a CALLEE in `reconnecting`. Both are covered below.
 */

const NOW = 1_754_000_000_000;

/** Fold a sequence of events through the reducer, discarding effects. */
function drive(events: CallEvent[], from: CallState = idleState()): CallState {
  let state = from;
  for (const event of events) {
    state = callReducer(state, event, NOW).state;
  }
  return state;
}

const CID = '01JGLARE0000000000000CALLER';
const PEER = 'peer-b';

/** Caller with a live connected call: placed with video, answered with video. */
function connectedCaller(): CallState {
  const state = drive([
    { type: 'placeCall', cid: CID, peerId: PEER, video: true },
    { type: 'answerReceived', cid: CID, sdp: 'answer-sdp', video: true },
    { type: 'iceStateChanged', cid: CID, ice: 'connected' },
  ]);
  expect(state.name).toBe('connected');
  expect(state.call?.peerVideo).toBe(true);
  return state;
}

/** Callee with a live connected call: offered with video, accepted as offered. */
function connectedCallee(): CallState {
  const state = drive([
    {
      type: 'offerReceived',
      cid: CID,
      peerId: PEER,
      sdp: 'offer-sdp',
      video: true,
      exp: NOW + 10_000,
      serverTs: NOW,
    },
    { type: 'localAccept' },
    { type: 'iceStateChanged', cid: CID, ice: 'connected' },
  ]);
  expect(state.name).toBe('connected');
  expect(state.call?.peerVideo).toBe(true);
  return state;
}

describe('peerVideo across an ICE restart', () => {
  it('a restart answer does not clobber camera-off learned via call.media', () => {
    // B turns the camera off: call.media lands, peerVideo goes false.
    let state = drive(
      [{ type: 'mediaReceived', cid: CID, audio: true, video: false }],
      connectedCaller(),
    );
    expect(state.call?.peerVideo).toBe(false);

    // A loses ICE: connected → reconnecting, restart in flight (caller-owned).
    state = drive([{ type: 'iceStateChanged', cid: CID, ice: 'disconnected' }], state);
    expect(state.name).toBe('reconnecting');

    // The callee's restart answer echoes stale accept-time `vid: true`.
    state = drive(
      [{ type: 'answerReceived', cid: CID, sdp: 'restart-answer-sdp', video: true }],
      state,
    );

    // The machine already holds fresher truth than the wire: B's camera is OFF.
    expect(state.name).toBe('reconnecting');
    expect(state.call?.peerVideo).toBe(false);
  });

  it('the first answer still speaks for the camera: answer-without-video lands', () => {
    // "Answer without video" on a video call (§5.1): the FIRST answer's vid
    // is the first word on the callee's camera and must be believed.
    const state = drive([
      { type: 'placeCall', cid: CID, peerId: PEER, video: true },
      { type: 'answerReceived', cid: CID, sdp: 'answer-sdp', video: false },
    ]);
    expect(state.name).toBe('outgoing_connecting');
    expect(state.call?.peerVideo).toBe(false);
  });

  it('a redelivered duplicate answer does not clobber either (why remoteReady, not state.name)', () => {
    // Same clobber, different door: the answer is REDELIVERED (§5.6 — normal,
    // not exceptional) while still in outgoing_connecting, after a call.media
    // already said camera-off. A discriminator keyed on `reconnecting` alone
    // would believe the duplicate; the remoteReady latch refuses it.
    const state = drive([
      { type: 'placeCall', cid: CID, peerId: PEER, video: true },
      { type: 'answerReceived', cid: CID, sdp: 'answer-sdp', video: true },
      { type: 'mediaReceived', cid: CID, audio: true, video: false },
      { type: 'answerReceived', cid: CID, sdp: 'answer-sdp', video: true },
    ]);
    expect(state.name).toBe('outgoing_connecting');
    expect(state.call?.peerVideo).toBe(false);
  });

  it("mirror: a reconnecting CALLEE's view of the caller's camera survives an unsolicited answer", () => {
    // The caller never legitimately sends call.answer, but the reducer
    // accepts one in `reconnecting` regardless of direction. The same latch
    // must keep a hostile or misdelivered answer from flipping the callee's
    // record of the CALLER's camera.
    let state = drive(
      [{ type: 'mediaReceived', cid: CID, audio: true, video: false }],
      connectedCallee(),
    );
    expect(state.call?.peerVideo).toBe(false);

    state = drive([{ type: 'iceStateChanged', cid: CID, ice: 'disconnected' }], state);
    expect(state.name).toBe('reconnecting');

    state = drive(
      [{ type: 'answerReceived', cid: CID, sdp: 'unsolicited-answer', video: true }],
      state,
    );
    expect(state.call?.peerVideo).toBe(false);
  });
});
