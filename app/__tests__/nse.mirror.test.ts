import * as crypto from 'tacendum-crypto';
import {
  BLOCKED_FILE,
  PEER_NAMES_FILE,
  publishBlockedPeers,
  publishPeerNames,
  retractSelfId,
  SELF_ID_FILE,
} from '../src/nse';
import { armedMarker, PREVIEWS_ARMED_FILE } from '../src/previews';
import { session } from '../src/session';

/**
 * The peer-names mirror is REAL NAMES ON DISK in the shared container — the
 * contact list, readable by anything in the App Group. Three properties keep
 * it from leaking through a duress session or a relock:
 *
 *  1. Retraction attempts BOTH files whatever happens to either, names first.
 *  2. Publishing refuses outside a real session, checked at the WRITE — every
 *     publisher is fire-and-forget, so a write that began in a real session
 *     can land after the duress entry retracted the mirror.
 *  3. Publishing refuses without a LIVE armed lease, the group mirror's gate
 *     applied here too: a RELOCK keeps session.mode 'real', so only the
 *     lease — disarmed before the relock retracts — can refuse a
 *     setLocalName publish that was in flight across it.
 */

const shared = (crypto as unknown as { __sharedState: Map<string, string> })
  .__sharedState;

/** A real, armed session — the state in which publishing is permitted. */
function armRealSession(): void {
  session.setMode('real');
  shared.set(PREVIEWS_ARMED_FILE, armedMarker(Date.now()));
}

beforeEach(() => {
  jest.clearAllMocks();
  shared.clear();
  armRealSession();
});

afterEach(() => {
  session.setMode('real');
});

describe('publishPeerNames', () => {
  it('writes the map in a real armed session, dropping empty names', async () => {
    // Precondition, so the refusal tests below cannot pass vacuously: this
    // exact call in this exact state DOES write.
    await publishPeerNames([
      { peerId: 'P1', name: 'Ayana' },
      { peerId: 'P2', name: '' },
    ]);

    expect(JSON.parse(shared.get(PEER_NAMES_FILE)!)).toEqual({ P1: 'Ayana' });
  });

  it('REFUSES outside a real session — a late fire-and-forget cannot rebuild the retracted list', async () => {
    // The race this pins: publishNames() was dispatched from the real
    // session, the person entered duress while it awaited, and the write
    // lands after retractSelfId emptied the mirror. The mode check at the
    // write is what stops the contact list reappearing on the lock screen
    // one incoming call at a time.
    session.setMode('duress');

    await publishPeerNames([{ peerId: 'P1', name: 'Ayana' }]);

    expect(shared.has(PEER_NAMES_FILE)).toBe(false);
  });

  it('REFUSES without an armed lease — a rename racing a relock leaves peer-names absent', async () => {
    // The race this pins: setLocalName dispatched its fire-and-forget
    // publish from db.ts (which has no access to messaging's stop()
    // generation), the owner relocked — mode STAYS 'real', so the mode gate
    // cannot see it — disarmPreviews deleted the lease and retractSelfId
    // emptied the mirror. The publish then lands. Without the lease gate the
    // whole contact list would sit in the shared container for the locked
    // interval, and every VoIP ring would name its caller in exactly the
    // state the retraction exists to keep nameless.
    shared.delete(PREVIEWS_ARMED_FILE);

    await publishPeerNames([{ peerId: 'P1', name: 'Ayana' }]);

    expect(shared.has(PEER_NAMES_FILE)).toBe(false);
  });
});

describe('the blocked-peers mirror', () => {
  /*
   * TWO native readers parse this file, neither of which the jest suite can
   * reach: `PreviewPolicy.blocked()` (the NSE, before attributing an alert
   * push) and `CallKitCenter.blockedPeers()` (before letting a VoIP push
   * ring the lock screen full-screen). Both split on '\n' and drop empty
   * lines, so the WRITER's format is the contract — these tests are the
   * JS-reachable half of the blocked-caller gate, pinning the exact bytes
   * the Swift side was written against.
   */
  it('writes newline-separated ids — the exact shape both native readers split on', async () => {
    await publishBlockedPeers(['P1', 'P2']);

    expect(shared.get(BLOCKED_FILE)).toBe('P1\nP2');
  });

  it('is rewritten whole, so an unblock takes effect in both readers', async () => {
    await publishBlockedPeers(['P1', 'P2']);
    await publishBlockedPeers(['P2']);

    expect(shared.get(BLOCKED_FILE)).toBe('P2');
  });

  it('publishes WITHOUT the session/lease gates the name mirrors have', async () => {
    // Deliberate asymmetry, pinned so nobody "harmonises" it away: the name
    // mirrors are a disclosure (real names on disk) and so refuse outside an
    // armed real session, but this mirror is a REFUSAL LIST — it discloses
    // nothing a push's own payload does not already carry, and gating it
    // would mean a block made moments before a relock never reaches the one
    // state where the native readers need it.
    session.setMode('duress');
    shared.delete(PREVIEWS_ARMED_FILE);

    await publishBlockedPeers(['P1']);

    expect(shared.get(BLOCKED_FILE)).toBe('P1');
  });

  it('SURVIVES retractSelfId — a blocked caller stays blocked on a locked phone', async () => {
    // Relock and duress retract the NAME mirrors, and must NOT retract this
    // one: the locked phone is exactly where the VoIP blocked-gate does its
    // work, and deleting the list there would un-block every caller in the
    // one state the victim cannot intervene in.
    shared.set(SELF_ID_FILE, 'ME');
    shared.set(PEER_NAMES_FILE, '{"P1":"Ayana"}');
    await publishBlockedPeers(['P9']);

    await retractSelfId();

    expect(shared.has(SELF_ID_FILE)).toBe(false);
    expect(shared.has(PEER_NAMES_FILE)).toBe(false);
    expect(shared.get(BLOCKED_FILE)).toBe('P9');
  });
});

describe('retractSelfId', () => {
  it('deletes the identity AND the names', async () => {
    shared.set(SELF_ID_FILE, 'ME');
    shared.set(PEER_NAMES_FILE, '{"P1":"Ayana"}');

    await retractSelfId();

    expect(shared.has(SELF_ID_FILE)).toBe(false);
    expect(shared.has(PEER_NAMES_FILE)).toBe(false);
  });

  it('a failing self-id delete does not spare the names', async () => {
    // The old order deleted self-id FIRST: one thrown error and the contact
    // list — the more sensitive of the two — was never even attempted.
    shared.set(SELF_ID_FILE, 'ME');
    shared.set(PEER_NAMES_FILE, '{"P1":"Ayana"}');
    (crypto.deleteSharedState as jest.Mock).mockImplementation(
      async (name: string) => {
        if (name === SELF_ID_FILE) throw new Error('container unavailable');
        shared.delete(name);
      },
    );

    await expect(retractSelfId()).rejects.toThrow('container unavailable');

    expect(shared.has(PEER_NAMES_FILE)).toBe(false);
  });

  it('a failing names delete still retracts the identity', async () => {
    shared.set(SELF_ID_FILE, 'ME');
    shared.set(PEER_NAMES_FILE, '{"P1":"Ayana"}');
    (crypto.deleteSharedState as jest.Mock).mockImplementation(
      async (name: string) => {
        if (name === PEER_NAMES_FILE) throw new Error('container unavailable');
        shared.delete(name);
      },
    );

    await expect(retractSelfId()).resolves.toBeUndefined();

    expect(shared.has(SELF_ID_FILE)).toBe(false);
  });
});
