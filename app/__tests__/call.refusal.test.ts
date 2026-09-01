import type { CallEnvelope, IceServer } from '@tacendum/shared';
import {
  CallController,
  type CallControllerDeps,
  type CallNativeBridge,
} from '../src/call/controller';
import type { CallLogRow } from '../src/call/service';

/**
 * What happens when the transport REFUSES to send.
 *
 * Two product rules make `messaging.sendCallEnvelope` throw rather than send:
 * a duress session is network-silent and calls are the
 * loudest thing this app can do, and a blocked peer must never be able to make
 * this phone ring or have theirs rung. Both are enforced inside
 * messaging, below the call layer, which is right — but it means the call
 * layer has to cope with a send that simply fails.
 *
 * The failure mode being guarded against is not a crash. It is a call that
 * sits in `outgoing_connecting` with nothing on the wire, showing "Calling…"
 * until the 45-second connect timeout fires. Nothing is broken, nothing is
 * logged, and the person watches a phone pretend to dial.
 */

const SERVERS: IceServer[] = [{ urls: ['stun:turn.tacendum.com:3478'] }];
const CID = '01J0000000000000000000000A';

function harness(sendCallEnvelope: CallControllerDeps['messaging']['sendCallEnvelope']) {
  const logs: CallLogRow[] = [];
  const native = {
    configure: jest.fn().mockResolvedValue(undefined),
    createOffer: jest.fn().mockResolvedValue('v=0\r\nOFFER'),
    createAnswer: jest.fn().mockResolvedValue('v=0\r\nANSWER'),
    setRemoteAnswer: jest.fn().mockResolvedValue(undefined),
    addIceCandidates: jest.fn().mockResolvedValue(undefined),
    restartIce: jest.fn().mockResolvedValue('v=0\r\nOFFER'),
    close: jest.fn().mockResolvedValue(undefined),
    reportOutgoingCall: jest.fn().mockResolvedValue(undefined),
    reportOutgoingConnected: jest.fn().mockResolvedValue(undefined),
    reportIncomingCall: jest.fn().mockResolvedValue(undefined),
    updateIncomingCallDisplay: jest.fn().mockResolvedValue(undefined),
    dismissPendingIncomingCall: jest.fn().mockResolvedValue(undefined),
    endCall: jest.fn().mockResolvedValue(undefined),
    registerForVoipPush: jest.fn().mockResolvedValue(undefined),
    getVoipToken: jest.fn().mockResolvedValue('t'),
  } as unknown as jest.Mocked<CallNativeBridge>;

  const controller = new CallController({
    messaging: { onEnvelope: () => () => undefined, sendCallEnvelope },
    native,
    fetchTurnCredentials: async () => ({ iceServers: SERVERS, ttlSeconds: 43200 }),
    writeLog: async row => void logs.push(row),
    displayNameFor: async id => id,
    relayOnly: () => false,
    now: () => 1_800_000_000_000,
    mintReportId: async () => 'REPORT-REFUSAL',
  });
  created.push(controller);
  return { controller, native, logs };
}

const created: CallController[] = [];
afterEach(() => {
  for (const c of created.splice(0)) c.stop();
});

describe('a call the transport will not carry', () => {
  it('does not sit pretending to dial when the offer cannot be sent', async () => {
    // Duress and blocked both land here. The call must end promptly rather
    // than showing "Calling…" until the connect timeout.
    const { controller, native } = harness(async () => {
      throw new Error('messaging unavailable');
    });
    await controller.placeCall('P1', CID, false);

    expect(native.endCall).toHaveBeenCalled();
    expect(controller.state.name).not.toBe('outgoing_connecting');
  });

  it('releases CallKit, so no undismissable call is left on screen', async () => {
    // CallKit was told about an outgoing call before the send was attempted.
    // If nothing ends it, the system UI keeps a call the user cannot dismiss
    // and the NEXT call is refused as "already active".
    const { controller, native } = harness(async () => {
      throw new Error('blocked');
    });
    await controller.placeCall('P1', CID, false);
    expect(native.reportOutgoingCall).toHaveBeenCalled();
    expect(native.endCall).toHaveBeenCalled();
  });

  it('closes the peer connection it opened', async () => {
    const { controller, native } = harness(async () => {
      throw new Error('blocked');
    });
    await controller.placeCall('P1', CID, false);
    expect(native.close).toHaveBeenCalledWith(CID);
  });

  it('still succeeds when the transport works', async () => {
    // The guard must not fire on a healthy call — a check that ends every
    // call would pass the three assertions above and break the product.
    const sent: CallEnvelope[] = [];
    const { controller, native } = harness(async (_peerId, envelope) => {
      sent.push(envelope);
    });
    await controller.placeCall('P1', CID, false);

    expect(sent.some(e => e.tcm === 'call.offer')).toBe(true);
    expect(native.endCall).not.toHaveBeenCalled();
    expect(controller.state.name).toBe('outgoing_connecting');
  });
});
