/**
 * HOW THIS CHAT STARTED.
 *
 * `chats.introducedBy` has been written since the discovery work and read in
 * exactly one place — the thread's server-introduced banner. So a chat you
 * scanned in person and one a stranger's email lookup opened looked identical
 * everywhere a person actually decides how much to trust a row.
 *
 * One flat line, on the surface where that decision is being made. Flat is
 * the point: this is CONTEXT, not a warning — the warning shape is already
 * taken by the discovery provenance notice in the thread, and a second alarm
 * for the same fact would teach people to ignore both.
 *
 * A null origin renders NOTHING. An inbound-created row and a row that
 * predates the column are both null, and the profile cannot tell which — so
 * it says nothing rather than guessing, which is the same rule the banner
 * itself follows.
 *
 * THE OPEN TAXONOMY, AND WHY NO CLASS IS NAMED. `introducedBy` is
 * deliberately open ('discovery' bare or 'discovery-<class>'), and the class
 * values are spelled in db.ts and nowhere else. So the line asks
 * `db.serverIntroduced` for the family rather than matching class strings: a
 * class this build has never heard of still earns an honest sentence instead
 * of silence. The bare 'discovery' mark is not the email class either — it is
 * made once for BOTH shipped lookup classes, email and phone — so the line
 * says the server made the introduction and stops there. Naming a class the
 * mark does not record would be a claim about who vouched for an account.
 *
 * Harness follows PeerProfile.blocking.test.tsx: the fake op-sqlite answers by
 * SQL fragment, so the screen runs the real db module.
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { Text } from 'react-native';
import * as db from '../src/db';
import { messaging } from '../src/messaging';
import { PeerProfileScreen } from '../src/screens/PeerProfileScreen';

interface FakeDb {
  name: string;
  execute: jest.Mock;
  close: jest.Mock;
}
const sqlite = (
  jest.requireMock('@op-engineering/op-sqlite') as {
    __sqlite: { instances: Map<string, FakeDb>; reset: () => void };
  }
).__sqlite;

const T0 = new Date('2026-07-23T09:00:00').getTime();
const PEER = '01SAMZ3NDEKTSV4RRFFQ69G5FA';
const SAFETY = '4'.repeat(60);

const ME: db.ProfileRow = {
  userId: '01KYDBSSDJSPC9J0E5N2AWMJ5Y',
  registrationId: 7,
  displayName: 'Nat',
  about: '',
  avatarB64: '',
  profileVersion: 1,
};

/** The one column this file varies. */
const origin: { by: string | null } = { by: null };

beforeEach(async () => {
  await db.close();
  sqlite.reset();
  db.setWorkspace('real');
  await db.initDb();
  origin.by = null;

  const instance = sqlite.instances.get('tacendum.sqlite')!;
  const base = instance.execute.getMockImplementation()!;
  instance.execute.mockImplementation(async (sql: string, params?: unknown) => {
    const s = String(sql);
    if (s.includes('FROM blocked_peers')) return { rows: [] };
    if (s.includes('FROM chats')) {
      return {
        rows: [
          {
            peerId: PEER,
            displayName: 'Sam',
            lastMessageAt: T0,
            lastMessageText: 'see you',
            about: null,
            avatarB64: null,
            profileVersion: null,
            safetyCheckedAt: null,
            localName: null,
            createdAt: T0,
            lastOpenedAt: null,
            identityChangedAt: null,
            safetyMismatchAt: null,
            introducedBy: origin.by,
          },
        ],
      };
    }
    return base(s, params);
  });

  jest.spyOn(messaging, 'getSafetyNumber').mockResolvedValue(SAFETY);
  jest.spyOn(messaging, 'isPeerBlocked').mockReturnValue(false);
});

afterEach(async () => {
  await db.close();
  jest.restoreAllMocks();
});

async function renderProfile(): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <PeerProfileScreen peerId={PEER} me={ME} onBack={jest.fn()} />,
    );
  });
  await ReactTestRenderer.act(async () => {});
  return tree;
}

function texts(tree: ReactTestRenderer.ReactTestRenderer): string[] {
  return tree.root.findAllByType(Text).map(n => {
    const kids = n.props.children;
    return Array.isArray(kids) ? kids.join('') : String(kids ?? '');
  });
}

/** The line itself, or null when the screen said nothing. */
async function lineFor(by: string | null): Promise<string | null> {
  origin.by = by;
  const tree = await renderProfile();
  const nodes = tree.root.findAll(
    n => n.props.testID === 'peer-origin' && typeof n.type === 'string',
  );
  const said = nodes.length === 0 ? null : String(nodes[0]!.props.children);
  await ReactTestRenderer.act(() => tree.unmount());
  return said;
}

test('a code you scanned says so', async () => {
  expect(await lineFor('qr')).toBe(
    'You started this room by scanning their code.',
  );
});

test('an ID you typed says so', async () => {
  expect(await lineFor('manual')).toBe(
    'You started this room by typing their ID.',
  );
});

test('the bare discovery mark says the SERVER introduced them, never which class', async () => {
  // 'discovery' is the FAMILY mark, not the email class: accounts.ts makes it
  // once for both shipped classes (email and phone), and DiscoveryScreen
  // passes it for everything that is not the username class. So a sentence
  // naming email would tell a person they found someone by email when they
  // found them by a phone number — today only prevented by phoneUi.ts's pin,
  // which flips on its own train. The family sentence is true of all of
  // them, so the bare mark falls to it like any other lookup class.
  expect(await lineFor('discovery')).toBe('You found them by looking them up.');
});

test('the username class says the server introduced them, without naming the class', async () => {
  // The class value is spelled in db.ts alone (the kind-spelling rule), so
  // this reads it from there rather than repeating the literal.
  expect(await lineFor(db.DISCOVERY_USERNAME_INTRODUCED)).toBe(
    'You found them by looking them up.',
  );
});

test('a lookup class this build has never heard of still earns the honest sentence', async () => {
  // The taxonomy is open by design: a new discovery class must not fall
  // silently into "we cannot say", because the server DID make the
  // introduction and that is the whole fact the line carries.
  expect(await lineFor('discovery-somethingnew')).toBe(
    'You found them by looking them up.',
  );
});

test('a null origin says NOTHING — the profile cannot prove which it was', async () => {
  expect(await lineFor(null)).toBeNull();
});

test('a value that is not an introduction at all says nothing either', async () => {
  expect(await lineFor('sms')).toBeNull();
});

test('it is one line above the safety section, not a section of its own', async () => {
  origin.by = 'qr';
  const tree = await renderProfile();
  const all = texts(tree);

  const origin_i = all.indexOf('You started this room by scanning their code.');
  const safety_i = all.indexOf('Safety number');
  expect(origin_i).toBeGreaterThanOrEqual(0);
  expect(safety_i).toBeGreaterThanOrEqual(0);
  // Under the identity sheet, above safety: the place a person is already
  // deciding how much to trust this row.
  expect(origin_i).toBeLessThan(safety_i);

  // One line, not a section: no heading of its own on a 2,000-line screen.
  const headings = tree.root
    .findAll(n => n.props.accessibilityRole === 'header')
    .map(n => String(n.props.children ?? ''));
  expect(headings).not.toContain('You started this room by scanning their code.');

  await ReactTestRenderer.act(() => tree.unmount());
});
