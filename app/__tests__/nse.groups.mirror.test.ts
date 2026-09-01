import * as crypto from 'tacendum-crypto';
import {
  GROUP_NAMES_FILE,
  PEER_NAMES_FILE,
  publishGroupNames,
  retractSelfId,
  SELF_ID_FILE,
} from '../src/nse';
import { armedMarker, PREVIEWS_ARMED_FILE } from '../src/previews';
import { session } from '../src/session';

/**
 * The room-names mirror — REAL ROOM NAMES ON DISK in the
 * shared container, the same disclosure class as the contact list. Three
 * properties keep it honest:
 *
 *  1. Retraction attempts every file whatever happens to any of them.
 *  2. Publishing refuses outside a real session — a duress entry must not
 *     have a late fire-and-forget rebuild what it just deleted.
 *  3. Publishing refuses without a LIVE armed lease. This is the guard the
 *     peer-names mirror gets from messaging's stop() generation and this
 *     mirror cannot (its publishers live in db.ts): a RELOCK keeps
 *     session.mode 'real', so only the lease — disarmed before the relock
 *     retracts — can refuse a write that was in flight across it.
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

describe('publishGroupNames', () => {
  it('writes the map keyed by groupId, dropping rooms with no name', async () => {
    // Precondition, so the refusal tests below cannot pass vacuously: this
    // exact call in this exact state DOES write.
    await publishGroupNames([
      { groupId: 'G1', name: 'Kitchen' },
      { groupId: 'G2', name: '' },
    ]);

    expect(JSON.parse(shared.get(GROUP_NAMES_FILE)!)).toEqual({ G1: 'Kitchen' });
  });

  it('REFUSES outside a real session — a late fire-and-forget cannot rebuild the retracted list', async () => {
    session.setMode('duress');

    await publishGroupNames([{ groupId: 'G1', name: 'Kitchen' }]);

    expect(shared.has(GROUP_NAMES_FILE)).toBe(false);
  });

  it('REFUSES without an armed lease — the write in flight across a relock lands nowhere', async () => {
    // The race this pins: a room commit dispatched its fire-and-forget
    // publish, the owner relocked (mode STAYS 'real' — the mode gate cannot
    // see a relock), disarmPreviews deleted the lease and retractSelfId
    // emptied the mirror. The publish then lands. Without the lease gate the
    // room names would sit in the shared container for the whole locked
    // interval.
    shared.delete(PREVIEWS_ARMED_FILE);

    await publishGroupNames([{ groupId: 'G1', name: 'Kitchen' }]);

    expect(shared.has(GROUP_NAMES_FILE)).toBe(false);
  });

  it("REFUSES on the disarm fallback's overwrite and on an expired lease", async () => {
    // disarmPreviews' second route overwrites with '0' when the delete
    // fails; anything that does not parse as a live lease must read as
    // disarmed here exactly as it does in the extension.
    shared.set(PREVIEWS_ARMED_FILE, '0');
    await publishGroupNames([{ groupId: 'G1', name: 'Kitchen' }]);
    expect(shared.has(GROUP_NAMES_FILE)).toBe(false);

    shared.set(
      PREVIEWS_ARMED_FILE,
      JSON.stringify({ v: 1, deadline: Date.now() - 1 }),
    );
    await publishGroupNames([{ groupId: 'G1', name: 'Kitchen' }]);
    expect(shared.has(GROUP_NAMES_FILE)).toBe(false);
  });
});

describe('retractSelfId', () => {
  it('deletes the room names with the identity and the peer names', async () => {
    shared.set(SELF_ID_FILE, 'ME');
    shared.set(PEER_NAMES_FILE, '{"P1":"Ayana"}');
    shared.set(GROUP_NAMES_FILE, '{"G1":"Kitchen"}');

    await retractSelfId();

    expect(shared.has(SELF_ID_FILE)).toBe(false);
    expect(shared.has(PEER_NAMES_FILE)).toBe(false);
    expect(shared.has(GROUP_NAMES_FILE)).toBe(false);
  });

  it('a failing self-id delete does not spare the room names', async () => {
    shared.set(SELF_ID_FILE, 'ME');
    shared.set(GROUP_NAMES_FILE, '{"G1":"Kitchen"}');
    (crypto.deleteSharedState as jest.Mock).mockImplementation(
      async (name: string) => {
        if (name === SELF_ID_FILE) throw new Error('container unavailable');
        shared.delete(name);
      },
    );

    await expect(retractSelfId()).rejects.toThrow('container unavailable');

    expect(shared.has(GROUP_NAMES_FILE)).toBe(false);
  });

  it('a failing room-names delete still retracts the identity and the peer names', async () => {
    shared.set(SELF_ID_FILE, 'ME');
    shared.set(PEER_NAMES_FILE, '{"P1":"Ayana"}');
    shared.set(GROUP_NAMES_FILE, '{"G1":"Kitchen"}');
    (crypto.deleteSharedState as jest.Mock).mockImplementation(
      async (name: string) => {
        if (name === GROUP_NAMES_FILE) throw new Error('container unavailable');
        shared.delete(name);
      },
    );

    await expect(retractSelfId()).resolves.toBeUndefined();

    expect(shared.has(SELF_ID_FILE)).toBe(false);
    expect(shared.has(PEER_NAMES_FILE)).toBe(false);
  });
});
