/**
 * Render hardening — the peer profile's hero is the LARGEST render of a
 * peer-chosen card in the app, and it read the card straight off the row
 * (`(displayName ?? '').trim()`), bypassing the sanitizer that personName,
 * personRef and monogram all go through. A bidi override or a zero-width
 * run painted verbatim there, and rode into the photo's accessibility label
 * and the "shared with you as" line.
 *
 * Harness follows PeerProfile.blocking.test.tsx: the fake op-sqlite from
 * jest.setup.js answers by SQL fragment, so the screen exercises the real
 * db module. Every hostile character is BUILT from its code point, because
 * the point of these characters is being invisible.
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

const cp = (code: number) => String.fromCodePoint(code);
const RLO = cp(0x202e);
const ZWSP = cp(0x200b);
const LRI = cp(0x2066);
const PDI = cp(0x2069);
const MARKS = new RegExp(`[${RLO}${ZWSP}${LRI}${PDI}]`);

const T0 = new Date('2026-08-28T09:00:00').getTime();
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

/** The card as a hostile peer shared it: reversed, split, isolated. */
const HOSTILE_CARD = `${RLO}Sam${ZWSP} ${LRI}Ruiz${PDI}`;
const CLEAN_CARD = 'Sam Ruiz';

function chatRow(over: Partial<{ displayName: string; localName: string | null; avatarB64: string | null }>) {
  return {
    peerId: PEER,
    displayName: over.displayName ?? HOSTILE_CARD,
    lastMessageAt: T0,
    lastMessageText: 'see you',
    about: null,
    avatarB64: over.avatarB64 ?? null,
    profileVersion: 3,
    safetyCheckedAt: null,
    localName: over.localName ?? null,
    createdAt: T0,
    lastOpenedAt: null,
    identityChangedAt: null,
    safetyMismatchAt: null,
  };
}

let row = chatRow({});

beforeEach(async () => {
  await db.close();
  sqlite.reset();
  db.setWorkspace('real');
  await db.initDb();
  row = chatRow({});

  const instance = sqlite.instances.get('tacendum.sqlite')!;
  const base = instance.execute.getMockImplementation()!;
  instance.execute.mockImplementation(async (sql: string, params?: unknown) => {
    const s = String(sql);
    if (s.includes('FROM blocked_peers')) return { rows: [] };
    if (s.includes('FROM chats')) return { rows: [row] };
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

/** Every string a <Text> paints — what a person actually gets. */
function texts(tree: ReactTestRenderer.ReactTestRenderer): string[] {
  return tree.root.findAllByType(Text).map(n => {
    const kids = n.props.children;
    return Array.isArray(kids) ? kids.join('') : String(kids ?? '');
  });
}

/** Every accessibility label in the tree — what VoiceOver actually gets. */
function labels(tree: ReactTestRenderer.ReactTestRenderer): string[] {
  return tree.root
    .findAll(n => typeof n.props.accessibilityLabel === 'string')
    .map(n => n.props.accessibilityLabel as string);
}

describe('peer profile — the hero paints the sanitized card', () => {
  test('a bidi override and zero-width run in the shared card render stripped in the hero and every label', async () => {
    const tree = await renderProfile();

    const shown = texts(tree);
    // The hero name is the clean form, set as a name — the id paints once,
    // in the Tacendum ID row, never as the hero.
    expect(shown).toContain(CLEAN_CARD);
    expect(shown.filter(s => s === PEER)).toHaveLength(1);
    // Not one painted string carries a mark — the hero, the source note,
    // the safety prose that interpolates the name, all of it.
    for (const s of shown) expect(s).not.toMatch(MARKS);
    for (const l of labels(tree)) expect(l).not.toMatch(MARKS);

    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('a photo label and the "shared with you as" line carry the clean card, even beside my own label', async () => {
    row = chatRow({ localName: `${ZWSP}Mum${RLO}`, avatarB64: 'QUJD' });
    const tree = await renderProfile();

    const shown = texts(tree);
    // My label outranks the card in the hero…
    expect(shown).toContain('Mum');
    // …and their own choice of name is kept beside it, sanitized.
    expect(shown.join('\n')).toContain(`“${CLEAN_CARD}”`);
    expect(shown.join('\n')).not.toContain(HOSTILE_CARD);
    // The photo's accessibility label names the clean label.
    expect(labels(tree)).toContain('Photo of Mum');
    for (const s of shown) expect(s).not.toMatch(MARKS);
    for (const l of labels(tree)) expect(l).not.toMatch(MARKS);

    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('a card that is nothing but marks is no name: the hero falls to the id', async () => {
    row = chatRow({ displayName: `${RLO}${ZWSP}${LRI}${PDI}` });
    const tree = await renderProfile();

    const shown = texts(tree);
    // Twice now: the hero AND the Tacendum ID row.
    expect(shown.filter(s => s === PEER)).toHaveLength(2);
    expect(shown).not.toContain(CLEAN_CARD);
    for (const s of shown) expect(s).not.toMatch(MARKS);

    await ReactTestRenderer.act(() => tree.unmount());
  });
});
