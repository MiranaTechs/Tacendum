/**
 * PER-PAIR VERIFICATION MATCH RECORDS (the design row
 * 26b, closed here): the drill-down's device rows carry their OWN
 * matched/mismatch stamp and their own two-outcome comparison, beside the
 * chat-level record the anchor pair keeps. "Verified" becomes something a
 * human can actually achieve device-by-device — and the record lands in
 * `peer_device_safety`, never on the chat row.
 *
 * Harness follows PeerProfile.devices.test.tsx: real db module against the
 * fake op-sqlite, with the reads scripted per test.
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import * as db from '../src/db';
import { messaging } from '../src/messaging';
import { PeerProfileScreen } from '../src/screens/PeerProfileScreen';

const PEER = '01DEVSZ3NDEKTSV4RRFFQ69G5F';
const TABLET = '01DEVSZ3NDEKTSV4RRFFQ69G5G';
const NOW = new Date('2026-08-26T09:00:00').getTime();
const NUMBER =
  '111112222233333444445555566666777778888899999000001111122222';

const ME: db.ProfileRow = {
  userId: '01MEMEZ3NDEKTSV4RRFFQ69G5A',
  registrationId: 7,
  displayName: 'Me',
  about: '',
  avatarB64: '',
  profileVersion: 0,
};

function rows(): db.PeerDeviceDbRow[] {
  return [
    {
      userId: PEER,
      anchorId: PEER,
      class: 'phone',
      state: 'linked',
      identityKeyPub: 'S0VZ',
      certsJson: '',
      updatedAt: NOW,
    },
    {
      userId: TABLET,
      anchorId: PEER,
      class: 'tablet',
      state: 'linked',
      identityKeyPub: 'S0Va',
      certsJson: '',
      updatedAt: NOW,
    },
  ];
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

it('an unchecked pair shows its stamp and both comparison outcomes — writes land on the PAIR record', async () => {
  jest.spyOn(db, 'listPeerDevices').mockImplementation(async () => rows());
  // The sibling pair has a number (comparison is possible); the anchor's is
  // irrelevant here.
  jest
    .spyOn(messaging, 'getSafetyNumber')
    .mockImplementation(async id => (id === TABLET ? NUMBER : null));
  jest
    .spyOn(db, 'getPeerPairSafety')
    .mockResolvedValue({ checkedAt: null, mismatchAt: null });
  const checked = jest.spyOn(db, 'setPeerPairChecked').mockResolvedValue(undefined);
  const setChecked = jest.spyOn(db, 'setSafetyChecked').mockResolvedValue(undefined);

  const tree = await renderScreen();
  const rendered = JSON.stringify(tree.toJSON());
  expect(rendered).toContain('You haven’t checked this pair yet.');

  const match = tree.root
    .findAllByProps({ testID: `peer-device-match-${TABLET}` })
    .find(n => n.props.onPress !== undefined)!;
  await ReactTestRenderer.act(async () => {
    match.props.onPress();
  });
  // The stamp lands on the PAIR record — never on the chat row (the anchor
  // pair's record is the chat's own; a per-device act must not forge it).
  expect(checked).toHaveBeenCalledWith(TABLET, expect.any(Number));
  expect(setChecked).not.toHaveBeenCalled();
  tree.unmount();
});

it('a recorded mismatch renders as the warning it is, with the re-check verb', async () => {
  jest.spyOn(db, 'listPeerDevices').mockImplementation(async () => rows());
  jest
    .spyOn(messaging, 'getSafetyNumber')
    .mockImplementation(async id => (id === TABLET ? NUMBER : null));
  jest
    .spyOn(db, 'getPeerPairSafety')
    .mockResolvedValue({ checkedAt: null, mismatchAt: NOW });

  const tree = await renderScreen();
  const rendered = JSON.stringify(tree.toJSON());
  expect(rendered).toContain('This pair did not match when you compared it.');
  expect(
    tree.root.findAllByProps({ testID: `peer-device-recheck-${TABLET}` }).length,
  ).toBeGreaterThan(0);
  // The two stamp verbs are gone while a record stands.
  expect(
    tree.root.findAllByProps({ testID: `peer-device-match-${TABLET}` }),
  ).toHaveLength(0);
  tree.unmount();
});

it('matching a cross-signed pair RETIRES its deviceAdded review item from the header aggregate', async () => {
  jest.spyOn(db, 'listPeerDevices').mockImplementation(async () => rows());
  jest
    .spyOn(messaging, 'getSafetyNumber')
    .mockImplementation(async id => (id === TABLET ? NUMBER : null));

  // UNREVIEWED: the cross-signed addition is a standing review item — the
  // header aggregate carries 'deviceAdded'.
  jest
    .spyOn(db, 'getPeerPairSafety')
    .mockResolvedValue({ checkedAt: null, mismatchAt: null });
  const before = await renderScreen();
  expect(JSON.stringify(before.toJSON())).toContain('They added a device');
  await ReactTestRenderer.act(async () => {
    before.unmount();
  });

  // REVIEWED: the human compared the pair's own number and it matched —
  // that comparison IS the review, so the review item retires and the
  // header falls back to the pairs' recorded states.
  (db.getPeerPairSafety as jest.Mock).mockResolvedValue({
    checkedAt: NOW,
    mismatchAt: null,
  });
  const after = await renderScreen();
  expect(JSON.stringify(after.toJSON())).not.toContain('They added a device');
  await ReactTestRenderer.act(async () => {
    after.unmount();
  });
});

it('a matched pair shows its date; a pair with no number offers NO comparison verbs', async () => {
  jest.spyOn(db, 'listPeerDevices').mockImplementation(async () => rows());
  jest.spyOn(messaging, 'getSafetyNumber').mockResolvedValue(null);
  jest
    .spyOn(db, 'getPeerPairSafety')
    .mockResolvedValue({ checkedAt: NOW, mismatchAt: null });

  const tree = await renderScreen();
  const rendered = JSON.stringify(tree.toJSON());
  expect(rendered).toContain('You checked this pair and it matched on');
  // No number for the pair ⇒ nothing to compare ⇒ no verbs at all.
  expect(
    tree.root.findAllByProps({ testID: `peer-device-recheck-${TABLET}` }),
  ).toHaveLength(0);
  expect(
    tree.root.findAllByProps({ testID: `peer-device-match-${TABLET}` }),
  ).toHaveLength(0);
  tree.unmount();
});
