/**
 * THE the design PER-DEVICE DRILL-DOWN: a contact whose
 * account spans devices gets a "Their devices" section — each device
 * listed with its own standing from THIS device's TOFU record
 * (peer_devices), the pending hold worded as the refusal it is — and the
 * ordinary single-device contact sees nothing at all.
 *
 * Harness follows PeerProfile.machine.test.tsx (fake op-sqlite from
 * jest.setup.js): the peer_devices reads go through the real db module
 * against scripted rows.
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import * as db from '../src/db';
import { PeerProfileScreen } from '../src/screens/PeerProfileScreen';

const PEER = '01DEVSZ3NDEKTSV4RRFFQ69G5F';
const TABLET = '01DEVSZ3NDEKTSV4RRFFQ69G5G';
const NOW = new Date('2026-08-26T09:00:00').getTime();

const ME: db.ProfileRow = {
  userId: '01MEMEZ3NDEKTSV4RRFFQ69G5A',
  registrationId: 7,
  displayName: 'Me',
  about: '',
  avatarB64: '',
  profileVersion: 0,
};

function deviceRow(userId: string, state: 'linked' | 'pending' | 'revoked'): db.PeerDeviceDbRow {
  return {
    userId,
    anchorId: PEER,
    class: 'tablet',
    state,
    identityKeyPub: 'S0VZ',
    certsJson: '',
    updatedAt: NOW,
  };
}

async function renderScreen(): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(
      <PeerProfileScreen peerId={PEER} me={ME} onBack={() => undefined} />,
    );
  });
  return tree;
}

afterEach(() => {
  jest.restoreAllMocks();
});

it('a single-device contact shows NO devices section', async () => {
  jest
    .spyOn(db, 'listPeerDevices')
    .mockImplementation(async () => [
      { ...deviceRow(PEER, 'linked'), anchorId: PEER, userId: PEER },
    ]);
  const tree = await renderScreen();
  expect(tree.root.findAllByProps({ testID: `peer-device-${PEER}` })).toHaveLength(0);
  expect(
    JSON.stringify(tree.toJSON()).includes('Their devices'),
  ).toBe(false);
  tree.unmount();
});

it('a cross-signed sibling is listed as vouched-for; a pending one as the hold it is', async () => {
  jest
    .spyOn(db, 'listPeerDevices')
    .mockImplementation(async () => [
      { ...deviceRow(PEER, 'linked'), userId: PEER },
      deviceRow(TABLET, 'linked'),
    ]);
  const tree = await renderScreen();
  expect(tree.root.findAllByProps({ testID: `peer-device-${TABLET}` })).not.toHaveLength(0);
  const rendered = JSON.stringify(tree.toJSON());
  expect(rendered).toContain('Their devices');
  expect(rendered).toContain('Vouched for by a device you already knew.');
  // Per-pair honesty: the UI never pretends one number covers all.
  expect(rendered).toContain('Safety numbers are between two devices.');
  tree.unmount();

  jest
    .spyOn(db, 'listPeerDevices')
    .mockImplementation(async () => [
      { ...deviceRow(PEER, 'linked'), userId: PEER },
      deviceRow(TABLET, 'pending'),
    ]);
  const held = await renderScreen();
  expect(JSON.stringify(held.toJSON())).toContain(
    'Not vouched for — nothing sends or arrives until you review it.',
  );
  held.unmount();
});

it('a revoked device has left the set — zero rows, zero mention', async () => {
  jest
    .spyOn(db, 'listPeerDevices')
    .mockImplementation(async () => [
      { ...deviceRow(PEER, 'linked'), userId: PEER },
      deviceRow(TABLET, 'revoked'),
    ]);
  const tree = await renderScreen();
  expect(tree.root.findAllByProps({ testID: `peer-device-${TABLET}` })).toHaveLength(0);
  tree.unmount();
});
