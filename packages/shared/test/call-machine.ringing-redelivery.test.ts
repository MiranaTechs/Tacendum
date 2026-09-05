import { describe, expect, it } from 'vitest';
import { CALL_RING_TIMEOUT_MS } from '../src/call.js';
import {
  callReducer,
  idleState,
  type CallEffect,
  type CallEvent,
  type CallState,
} from '../src/call-machine.js';

/**
 * A `call.ringing` that arrives BEHIND the answer it preceded.
 *
 * `ringingReceived` swaps the clocks: it cancels the 45 s connect deadline
 * armed at `placeCall` and arms the 60 s ring deadline instead, because once
 * the callee's device is ringing "the offer never reached anyone" is no
 * longer the question being asked. `answerReceived` then swaps them back —
 * the callee picked up, so the honest deadline is again "answered but ICE
 * never connected".
 *
 * The signalling order is not guaranteed. A redelivered or simply late
 * `call.ringing` can land after the answer, and the machine stays in
 * `outgoing_connecting` across both, so the state guard alone lets it run a
 * second time: it cancels the connect timer `answerReceived` had just armed
 * and arms a ring timer for a call that is already answered. The call then
 * has no connect deadline at all, and the ring deadline that replaced it
 * fires 60 s later on a live negotiation.
 *
 * `remoteReady` is the per-call latch for "an answer has already been
 * applied" — the same discriminator `answerReceived` uses to refuse a
 * redelivered answer — so it is what decides here too.
 */

const NOW = 1_754_000_000_000;
const CID = '01JGRING0000000000000CALLER';
const PEER = 'peer-b';

/** Fold a sequence through the reducer, keeping the LAST step's effects. */
function drive(
  events: CallEvent[],
  from: CallState = idleState(),
): { state: CallState; effects: CallEffect[] } {
  let state = from;
  let effects: CallEffect[] = [];
  for (const event of events) {
    const step = callReducer(state, event, NOW);
    state = step.state;
    effects = step.effects;
  }
  return { state, effects };
}

describe('a late call.ringing behind the answer', () => {
  it('changes nothing once the answer has been applied', () => {
    const { state, effects } = drive([
      { type: 'placeCall', cid: CID, peerId: PEER, video: false },
      { type: 'answerReceived', cid: CID, sdp: 'answer-sdp', video: false },
      { type: 'ringingReceived', cid: CID },
    ]);
    expect(state.name).toBe('outgoing_connecting');
    expect(state.call?.remoteReady).toBe(true);
    // The connect deadline `answerReceived` just armed must survive: cancel
    // it here and the call runs unbounded until the ring timer kills it.
    expect(effects).toEqual([]);
  });

  it('still swaps the clocks for the ringing that arrives FIRST', () => {
    const { state, effects } = drive([
      { type: 'placeCall', cid: CID, peerId: PEER, video: false },
      { type: 'ringingReceived', cid: CID },
    ]);
    expect(state.name).toBe('outgoing_ringing');
    expect(effects).toEqual([
      { type: 'cancelTimer', timer: 'connect' },
      { type: 'startTimer', timer: 'ring', ms: CALL_RING_TIMEOUT_MS },
    ]);
  });
});
