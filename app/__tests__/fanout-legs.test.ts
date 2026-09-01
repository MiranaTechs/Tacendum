/**
 * DEVICE FAN-OUT LEGS — the
 * anchor: a send to a 3-device peer from a 2-device account produces
 * exactly 4 envelopes (3 peer legs + 1 sibling leg), each a DISTINCT
 * session, sharing ONE message id; a revoked member gets ZERO legs. Plus
 * the two shape rules that keep the shipped wire honest: an ungrouped peer
 * with no siblings is byte-identical to today's single bare leg, and the
 * named `recipient_revoked` refusal teaches the roster so the next
 * fan-out excludes the dead device.
 */

import {
  buildDeviceLegs,
  deviceFanoutTargets,
  handleLegRefusal,
  type DeviceFanoutDeps,
} from '../src/deviceFanout';
import { parseEnvelope } from '../src/envelope';
import type { PeerDeviceRow, PeerDevicesDeps } from '../src/peerDevices';
import type { LinkedDeviceRow } from '../src/db';

const SELF = '01HQSSSS00000000000000000S';
const OWN_TABLET = '01HQTTTT00000000000000000T';
const ALICE = '01HQAAAA00000000000000000A';
const ALICE_TABLET = '01HQBBBB00000000000000000B';
const ALICE_DESK = '01HQCCCC00000000000000000C';
const MSG_ID = '01HQMMMM00000000000000000M';
const NOW = 1_756_000_000_000;

interface FakeWorld {
  peerRows: Map<string, PeerDeviceRow>;
  ownRows: LinkedDeviceRow[];
  encrypted: Array<{ self: string; to: string; plaintext: string }>;
}

function fakeDeps(): { deps: DeviceFanoutDeps; world: FakeWorld } {
  const world: FakeWorld = { peerRows: new Map(), ownRows: [], encrypted: [] };
  const peers: PeerDevicesDeps = {
    db: {
      getPeerDevice: async id => world.peerRows.get(id) ?? null,
      listPeerDevices: async anchorId =>
        [...world.peerRows.values()].filter(r => r.anchorId === anchorId),
      upsertPeerDevice: async row => {
        world.peerRows.set(row.userId, { ...row });
      },
      peerBlockedAt: async () => null,
      blockPeer: async () => undefined,
    },
    crypto: { verifyLinkOp: async () => true },
    now: () => NOW,
  };
  const deps: DeviceFanoutDeps = {
    peers,
    ownDevices: async () => [...world.ownRows],
    crypto: {
      encryptText: async (self, to, plaintext) => {
        world.encrypted.push({ self, to, plaintext });
        // A distinct "session" per address: the payload names the pair, so
        // two legs sharing a session would be visible as equal payloads.
        return { msgType: 'ciphertext', payload: `sealed(${self}->${to})#${world.encrypted.length}` };
      },
    },
  };
  return { deps, world };
}

function seedPeerDevice(
  world: FakeWorld,
  userId: string,
  anchorId: string,
  state: PeerDeviceRow['state'],
): void {
  world.peerRows.set(userId, {
    userId,
    anchorId,
    class: 'phone',
    state,
    identityKeyPub: 'S0VZ',
    certsJson: '',
    updatedAt: NOW,
  });
}

function seedOwnSibling(world: FakeWorld, userId: string, state: LinkedDeviceRow['state']): void {
  world.ownRows.push({
    userId,
    class: 'tablet',
    state,
    updatedAt: NOW,
    certsJson: '',
    identityKeyPub: 'S0VZ',
  });
}

describe('a send to a 3-device peer from a 2-device account', () => {
  it('produces exactly 4 envelopes — 3 peer legs + 1 sibling leg — in distinct sessions sharing one message id', async () => {
    const { deps, world } = fakeDeps();
    seedPeerDevice(world, ALICE, ALICE, 'linked');
    seedPeerDevice(world, ALICE_TABLET, ALICE, 'linked');
    seedPeerDevice(world, ALICE_DESK, ALICE, 'linked');
    seedOwnSibling(world, SELF, 'linked'); // own row: never a leg
    seedOwnSibling(world, OWN_TABLET, 'linked');

    const legs = await buildDeviceLegs(
      { selfUserId: SELF, anchorId: ALICE, body: 'hello', msgId: MSG_ID, ts: NOW },
      deps,
    );
    expect(legs).toHaveLength(4);
    expect(legs.filter(l => l.kind === 'peer').map(l => l.to).sort()).toEqual(
      [ALICE, ALICE_TABLET, ALICE_DESK].sort(),
    );
    expect(legs.filter(l => l.kind === 'sibling').map(l => l.to)).toEqual([OWN_TABLET]);

    // Each leg a DISTINCT session: four addresses, four distinct seals.
    const addresses = world.encrypted.map(e => e.to);
    expect(new Set(addresses).size).toBe(4);
    expect(new Set(legs.map(l => l.payload)).size).toBe(4);

    // ONE message id, shared: every peer leg's dev.msg carries m = MSG_ID,
    // and the sibling transcript names the same id.
    for (const record of world.encrypted) {
      const envelope = parseEnvelope(record.plaintext);
      if (record.to === OWN_TABLET) {
        expect(envelope?.tcm).toBe('x.acct.sync');
        if (envelope?.tcm === 'x.acct.sync') {
          expect(envelope.k).toBe('transcript');
          expect((envelope.d as { msgId: string }).msgId).toBe(MSG_ID);
          expect((envelope.d as { body: string }).body).toBe('hello');
          expect((envelope.d as { peerId: string }).peerId).toBe(ALICE);
        }
      } else {
        expect(envelope?.tcm).toBe('dev.msg');
        if (envelope?.tcm === 'dev.msg') {
          expect(envelope.m).toBe(MSG_ID);
          expect(envelope.b).toBe('hello');
        }
      }
    }
  });

  it('a revoked member gets ZERO legs', async () => {
    const { deps, world } = fakeDeps();
    seedPeerDevice(world, ALICE, ALICE, 'linked');
    seedPeerDevice(world, ALICE_TABLET, ALICE, 'revoked');
    seedPeerDevice(world, ALICE_DESK, ALICE, 'linked');
    seedOwnSibling(world, OWN_TABLET, 'linked');
    const legs = await buildDeviceLegs(
      { selfUserId: SELF, anchorId: ALICE, body: 'hello', msgId: MSG_ID, ts: NOW },
      deps,
    );
    expect(legs.map(l => l.to)).not.toContain(ALICE_TABLET);
    expect(legs.filter(l => l.kind === 'peer')).toHaveLength(2);
  });

  it('a pending (unverified) device gets no leg either — block-and-warn is not a target', async () => {
    const { deps, world } = fakeDeps();
    seedPeerDevice(world, ALICE, ALICE, 'linked');
    seedPeerDevice(world, ALICE_TABLET, ALICE, 'pending');
    const targets = await deviceFanoutTargets(SELF, ALICE, deps);
    expect(targets.peerDevices).toEqual([ALICE]);
  });
});

describe('the pre-accounts wire stays byte-identical', () => {
  it('an ungrouped peer with no sender siblings is ONE bare leg — no wrapper', async () => {
    const { deps, world } = fakeDeps();
    // No peer_devices rows at all: the peer was never seen grouped.
    const legs = await buildDeviceLegs(
      { selfUserId: SELF, anchorId: ALICE, body: 'hello', msgId: MSG_ID, ts: NOW },
      deps,
    );
    expect(legs).toHaveLength(1);
    expect(legs[0]).toMatchObject({ to: ALICE, kind: 'peer' });
    // Byte-identical: the plaintext IS the body, no dev.msg, no id.
    expect(world.encrypted).toEqual([
      expect.objectContaining({ self: SELF, to: ALICE, plaintext: 'hello' }),
    ]);
  });
});

describe('carriers go BARE', () => {
  const READ_RECEIPT = '{"tcm":"read","ids":["01HQMMMM00000000000000000M"]}';

  it('a carrier to a grouped peer: bare per-device legs, no dev.msg wrapper, NO transcript sibling leg', async () => {
    const { deps, world } = fakeDeps();
    seedPeerDevice(world, ALICE, ALICE, 'linked');
    seedPeerDevice(world, ALICE_TABLET, ALICE, 'linked');
    seedOwnSibling(world, OWN_TABLET, 'linked');
    const legs = await buildDeviceLegs(
      { selfUserId: SELF, anchorId: ALICE, body: READ_RECEIPT, msgId: MSG_ID, ts: NOW },
      deps,
    );
    // Two peer-device legs, zero sibling legs: a read receipt is not a
    // transcript, and a sibling materialising an 'out' row for one would
    // write a raw carrier line into the thread.
    expect(legs.map(l => l.kind)).toEqual(['peer', 'peer']);
    // Every leg carries the BARE carrier — the receive path's pre-switch
    // arms (read receipts, x.acct.*) see exactly the shape they handle.
    for (const record of world.encrypted) {
      expect(record.plaintext).toBe(READ_RECEIPT);
    }
  });
});

describe('a revoked-at-bootstrap leg is recorded and skipped, not fatal', () => {
  it('recipient_revoked from a device leg records the tombstone and the rest still compose', async () => {
    const { deps, world } = fakeDeps();
    seedPeerDevice(world, ALICE, ALICE, 'linked');
    seedPeerDevice(world, ALICE_TABLET, ALICE, 'linked');
    const failing: DeviceFanoutDeps = {
      ...deps,
      crypto: {
        encryptText: async (self, to, plaintext) => {
          if (to === ALICE_TABLET) {
            throw Object.assign(new Error('recipient_revoked'), {
              code: 'recipient_revoked',
            });
          }
          return deps.crypto.encryptText(self, to, plaintext);
        },
      },
    };
    const legs = await buildDeviceLegs(
      { selfUserId: SELF, anchorId: ALICE, body: 'hello', msgId: MSG_ID, ts: NOW },
      failing,
    );
    expect(legs.map(l => l.to)).toEqual([ALICE]);
    expect(world.peerRows.get(ALICE_TABLET)?.state).toBe('revoked');
  });

  it('a revoked ANCHOR with living siblings still yields the survivors’ legs', async () => {
    const { deps, world } = fakeDeps();
    seedPeerDevice(world, ALICE, ALICE, 'revoked');
    seedPeerDevice(world, ALICE_TABLET, ALICE, 'linked');
    const legs = await buildDeviceLegs(
      { selfUserId: SELF, anchorId: ALICE, body: 'hello', msgId: MSG_ID, ts: NOW },
      deps,
    );
    expect(legs.map(l => l.to)).toEqual([ALICE_TABLET]);
    expect(legs[0]!.kind).toBe('peer');
  });
});

describe('stale-roster refresh on the named error', () => {
  it('recipient_revoked teaches the roster: the next fan-out excludes the dead device', async () => {
    const { deps, world } = fakeDeps();
    seedPeerDevice(world, ALICE, ALICE, 'linked');
    seedPeerDevice(world, ALICE_TABLET, ALICE, 'linked');
    const err = Object.assign(new Error('recipient_revoked'), {
      code: 'recipient_revoked',
    });
    expect(await handleLegRefusal(ALICE_TABLET, err, deps)).toBe(true);
    expect(world.peerRows.get(ALICE_TABLET)?.state).toBe('revoked');
    const targets = await deviceFanoutTargets(SELF, ALICE, deps);
    expect(targets.peerDevices).toEqual([ALICE]);
  });

  it('any other error is not this module’s to swallow', async () => {
    const { deps, world } = fakeDeps();
    seedPeerDevice(world, ALICE_TABLET, ALICE, 'linked');
    expect(await handleLegRefusal(ALICE_TABLET, new Error('offline'), deps)).toBe(false);
    expect(world.peerRows.get(ALICE_TABLET)?.state).toBe('linked');
  });
});
