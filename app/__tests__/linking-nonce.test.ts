/**
 * THE NONCE'S RANDOMNESS (the proof pass, 2026-10-08 — a shipped defect
 * since 1.1 (33)).
 *
 * linking.ts drew every offer nonce from the `ulid` package's default
 * generator, which hunts for `globalThis.crypto` at first use. Hermes has
 * none and the app installs no polyfill (PLAN §7 rule 1 forbids a JS-side
 * RNG), so on a real device every unlink, every "Lost or stolen — revoke"
 * and the downgrade's dissolve threw `ULIDError: Failed to find a reliable
 * PRNG (PRNG_DETECT)` BEFORE any request left — the roster screen rendered
 * the LINK refusal over an unlink, a lost tablet's slot could never be
 * freed, and "Go back to anonymous" removed the email, failed on the
 * dissolve and said so on every retry. Jest never saw it: Node provides
 * crypto, so the default generator found one here and nowhere else.
 *
 * This suite is the device's world: no `globalThis.crypto`, and the
 * package's own `ulid()` throwing exactly as it does on Hermes. The nonce
 * now comes from msgid's ULID factory over the NATIVE RNG (tacendum-crypto
 * randomBytes — the source every message id already uses), so the three
 * verbs sign and send with no PRNG detection in the path.
 */

import * as cryptoModule from 'tacendum-crypto';
import {
  dissolveGrouping,
  mutateRoster,
  nativeLinkNonce,
  type LinkingDeps,
} from '../src/linking';

// The device: the package's default generator finds nothing to draw from.
jest.mock('ulid', () => {
  const actual = jest.requireActual('ulid') as typeof import('ulid');
  return {
    ...actual,
    ulid: () => {
      throw new Error('Failed to find a reliable PRNG (PRNG_DETECT)');
    },
  };
});

const SELF = '01HQSELF000000000000000000';
const THIRD = '01HQTHIRD00000000000000000';
const GROUP = '01HQGROUP00000000000000000';
const NOW_MS = 1_756_000_000_000;
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

interface DeviceRow {
  userId: string;
  class: 'phone' | 'tablet';
  state: 'linked' | 'unlinked' | 'revoked';
  updatedAt: number;
  certsJson: string;
}
interface DeviceState {
  group: { groupId: string; rosterEpoch: number } | null;
  devices: DeviceRow[];
}

/** Deps with NO `freshNonce`: the module must draw its own, as the app does. */
function deviceDeps(): {
  deps: LinkingDeps;
  signed: Array<{ op: string; offerNonce: unknown }>;
  mutations: string[];
  state: DeviceState;
} {
  const signed: Array<{ op: string; offerNonce: unknown }> = [];
  const mutations: string[] = [];
  const state: DeviceState = {
    group: { groupId: GROUP, rosterEpoch: 4 },
    devices: [
      { userId: SELF, class: 'phone', state: 'linked', updatedAt: NOW_MS, certsJson: '' },
      { userId: THIRD, class: 'tablet', state: 'linked', updatedAt: NOW_MS, certsJson: '' },
    ],
  };
  const deps: LinkingDeps = {
    api: {
      getPrekeyBundle: async (_t, userId) => ({
        userId,
        registrationId: 7,
        identityKey: `IDKEY+${userId.slice(-4)}`,
        signedPrekey: { keyId: 1, pub: 'AA==', sig: 'AA==' },
        kyberPrekey: { keyId: 1, pub: 'AA==', sig: 'AA==' },
        rosterVersion: 4,
      }),
      linkOfferInit: async () => {
        throw new Error('not in this suite');
      },
      linkOfferSubmit: async () => undefined,
      linkAccept: async () => undefined,
      rosterMutation: async (_t, op) => {
        mutations.push(op);
      },
    },
    crypto: {
      processPreKeyBundle: async () => undefined,
      safetyNumber: async () => null,
      signLinkOp: async (op, tuple) => {
        signed.push({ op, offerNonce: tuple.offerNonce });
        return `sig(${op}:${tuple.offerNonce})`;
      },
      verifyLinkOp: async () => true,
      identityPublicKey: async () => `IDKEY+${SELF.slice(-4)}`,
    },
    db: {
      loadLinkGroup: async () => state.group,
      saveLinkGroup: async (groupId, rosterEpoch) => {
        state.group = { groupId, rosterEpoch };
      },
      upsertLinkedDevice: async () => undefined,
      markLinkedDeviceState: async (userId, deviceState, updatedAt) => {
        state.devices = state.devices.map(d =>
          d.userId === userId ? { ...d, state: deviceState, updatedAt } : d,
        );
      },
      listLinkedDevices: async () => [...state.devices],
      clearLinkGroup: async () => {
        state.group = null;
        state.devices = [];
      },
      savePendingLinkOffer: async () => undefined,
      loadPendingLinkOffer: async () => null,
      deletePendingLinkOffer: async () => undefined,
      savePendingLinkCeremony: async () => undefined,
      loadPendingLinkCeremony: async () => null,
      deletePendingLinkCeremony: async () => undefined,
      pristineForLink: async () => false,
      savePendingLinkMutation: async () => undefined,
      listPendingLinkMutations: async () => [],
      deletePendingLinkMutation: async () => undefined,
      listSiblingAgents: async () => [],
      saveRecoveryNotice: async () => undefined,
      loadRecoveryNotice: async () => null,
      clearUsernameIdentifier: async () => undefined,
      saveUsernameNotice: async () => undefined,
    },
    token: async () => 'bearer',
    selfId: async () => SELF,
    now: () => NOW_MS,
    // No freshNonce on purpose: the module's own source is under test.
  };
  return { deps, signed, mutations, state };
}

const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');

beforeAll(() => {
  // Hermes: no WebCrypto at all.
  Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true, writable: true });
});

afterAll(() => {
  if (cryptoDescriptor) Object.defineProperty(globalThis, 'crypto', cryptoDescriptor);
});

beforeEach(() => {
  (cryptoModule.randomBytes as jest.Mock).mockClear();
});

describe('the roster verbs draw their nonce from the native RNG, never from the ulid package’s PRNG detection', () => {
  it('the device’s world holds: no globalThis.crypto, and ulid() throws PRNG_DETECT', () => {
    expect(typeof (globalThis as { crypto?: unknown }).crypto).toBe('undefined');
    const { ulid } = jest.requireMock('ulid') as { ulid: () => string };
    expect(() => ulid()).toThrow(/PRNG_DETECT/);
  });

  it('nativeLinkNonce is a Crockford ULID from tacendum-crypto randomBytes, fresh each time', async () => {
    const a = await nativeLinkNonce();
    const b = await nativeLinkNonce();
    expect(a).toMatch(ULID_RE);
    expect(b).toMatch(ULID_RE);
    expect(a).not.toBe(b);
    expect(cryptoModule.randomBytes).toHaveBeenCalled();
  });

  it('mutateRoster("unlink") signs a native-RNG nonce and the request leaves', async () => {
    const { deps, signed, mutations, state } = deviceDeps();
    await expect(mutateRoster('unlink', { userId: THIRD, class: 'tablet' }, deps)).resolves.toBeUndefined();
    expect(signed).toHaveLength(1);
    expect(signed[0]!.op).toBe('unlink');
    expect(signed[0]!.offerNonce).toMatch(ULID_RE);
    expect(mutations).toEqual(['unlink']);
    expect(state.devices.find(d => d.userId === THIRD)?.state).toBe('unlinked');
  });

  it('mutateRoster("revoke") — "Lost or stolen — revoke" — frees the slot the same way', async () => {
    const { deps, signed, mutations, state } = deviceDeps();
    await expect(mutateRoster('revoke', { userId: THIRD, class: 'tablet' }, deps)).resolves.toBeUndefined();
    expect(signed[0]!.op).toBe('revoke');
    expect(signed[0]!.offerNonce).toMatch(ULID_RE);
    expect(mutations).toEqual(['revoke']);
    expect(state.devices.find(d => d.userId === THIRD)?.state).toBe('revoked');
  });

  it('dissolveGrouping — the downgrade’s dissolve — signs the statement and every unlink with native nonces, all distinct', async () => {
    const { deps, signed, mutations, state } = deviceDeps();
    await expect(dissolveGrouping(deps)).resolves.toBeUndefined();
    // The dissolve statement, then one unlink per other member, then this
    // device's own: three signatures, three fresh nonces.
    expect(signed.map(s => s.op)).toEqual(['dissolve', 'unlink', 'unlink']);
    for (const s of signed) expect(s.offerNonce).toMatch(ULID_RE);
    expect(new Set(signed.map(s => String(s.offerNonce))).size).toBe(3);
    expect(mutations).toEqual(['unlink', 'unlink']);
    expect(state.group).toBeNull();
  });

  it('an injected freshNonce still wins (the suites that pin a nonce), sync or async', async () => {
    const { deps, signed } = deviceDeps();
    const pinned: LinkingDeps = { ...deps, freshNonce: () => '01HQNNNN00000000000000000N' };
    await mutateRoster('unlink', { userId: THIRD, class: 'tablet' }, pinned);
    expect(signed[0]!.offerNonce).toBe('01HQNNNN00000000000000000N');
    const later: LinkingDeps = { ...deps, freshNonce: async () => '01HQNNNN00000000000000000P' };
    await mutateRoster('revoke', { userId: THIRD, class: 'tablet' }, later);
    expect(signed[1]!.offerNonce).toBe('01HQNNNN00000000000000000P');
  });
});
