import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'tacendum-trust-'));
process.env.TACENDUM_HOME = home;

const { FileStores } = await import('../src/stores.js');

const PEER = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const OTHER = '01BOBBOBBOBBOBBOBBOBBOBBOB';

/**
 * The record that makes `tacendum trust` refusable.
 *
 * `trust` clears the pinned peer identity AND the session — unconditionally,
 * before this existed, and then printed "accepted a new identity for X"
 * whether or not anything had changed. So a typo'd peer name, or simply
 * running it twice, tore down a healthy ratchet and un-pinned a key the
 * operator had already verified out of band, while reporting a safety-number
 * change that never happened. Un-pinning a verified peer is the state a MITM
 * wants a client in; doing it by accident and being told it was deliberate is
 * what these assertions exist to prevent.
 *
 * libsignal raises an identity change in two places (an inbound decrypt in
 * `attachInbound`, an outbound `establishSession` in `cmdSend`) and both are in
 * a process that then exits, while `trust` runs later in a different one — so
 * "pending" has to live on disk, not in memory.
 */
describe('the pending identity-change record', () => {
  it('reports nothing pending on a client that has never seen a change', () => {
    const stores = new FileStores('fresh-client');
    expect(stores.hasIdentityChange(PEER)).toBe(false);
  });

  it('survives the process that recorded it', () => {
    new FileStores('recorder').markIdentityChange(PEER);
    // A DIFFERENT FileStores instance, which is what `tacendum trust` builds:
    // the warning is printed by `listen` and acted on from another shell.
    expect(new FileStores('recorder').hasIdentityChange(PEER)).toBe(true);
  });

  it('is per-peer, so trusting the wrong name is not covered by the right one', () => {
    const stores = new FileStores('per-peer');
    stores.markIdentityChange(PEER);
    expect(stores.hasIdentityChange(OTHER)).toBe(false);
  });

  it('is cleared by acceptance, so a repeat trust has nothing left to accept', () => {
    const stores = new FileStores('repeat');
    stores.markIdentityChange(PEER);
    stores.clearIdentityChange(PEER);
    expect(stores.hasIdentityChange(PEER)).toBe(false);
  });

  it('does not duplicate a peer that warns repeatedly', () => {
    const stores = new FileStores('noisy');
    stores.markIdentityChange(PEER);
    stores.markIdentityChange(PEER);
    stores.clearIdentityChange(PEER);
    // One clear must be enough. If marks accumulated, the second entry would
    // survive and `trust` would stay armed after the change was accepted.
    expect(stores.hasIdentityChange(PEER)).toBe(false);
  });

  it('treats a corrupt record as empty rather than making trust unrunnable', () => {
    const stores = new FileStores('corrupt');
    writeFileSync(join(home, 'corrupt', 'identity-changes.json'), '{not json');
    expect(stores.hasIdentityChange(PEER)).toBe(false);
    // ...and it is still writable afterwards.
    stores.markIdentityChange(PEER);
    expect(stores.hasIdentityChange(PEER)).toBe(true);
  });
});
