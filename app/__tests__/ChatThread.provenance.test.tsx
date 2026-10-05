/**
 * THE DISCOVERY PROVENANCE LINE. A chat
 * the SERVER introduced — a discovery lookup resolved the person — used to
 * be indistinguishable from one a friend introduced by handing over a QR.
 * The thread now says so, in one quiet line, until this phone has recorded
 * a safety-number match: after that the person has done the one thing that
 * makes the server's introduction beside the point.
 *
 * What these pin:
 *  - a discovery-introduced, unverified chat renders the line, verbatim;
 *  - a QR-introduced chat, a typed one, and a row that predates provenance
 *    (the migration's NULL) render nothing — the reminder is about WHO
 *    introduced the account, and none of those was the server;
 *  - a recorded match clears it — through the real safety panel, the real
 *    `setSafetyChecked` write, and the real re-read of the row;
 *  - a discovery chat already verified starts without it.
 *
 * Harness follows ChatThread.blocking.test.tsx.
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { StyleSheet, Text } from 'react-native';
import * as db from '../src/db';
import { messaging } from '../src/messaging';
import { ChatThreadScreen } from '../src/screens/ChatThreadScreen';
import { themeTokens } from '../src/theme';

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

const T0 = new Date('2026-07-25T12:00:00').getTime();
const PEER = '01HQZZZZ00000000000000000A';

const LINE =
  'You found this account through the server. Verify the safety number in person to be sure.';

const THEIRS = {
  msgId: '01THEIRS',
  peerId: PEER,
  direction: 'in',
  body: 'dinner at eight?',
  ts: T0,
  status: 'received',
  editedAt: null,
  deletedAt: null,
};

/** The one chats row the thread reads — mutable, so a write can land on it
 * exactly as it would on disk. */
let chatRow: Record<string, unknown>;

function seedChat(overrides: Record<string, unknown>) {
  chatRow = {
    peerId: PEER,
    displayName: null,
    lastMessageAt: T0,
    lastMessageText: 'dinner at eight?',
    about: null,
    avatarB64: null,
    profileVersion: null,
    safetyCheckedAt: null,
    localName: 'alice@example.com',
    createdAt: T0,
    lastOpenedAt: null,
    identityChangedAt: null,
    safetyMismatchAt: null,
    disappearSec: null,
    disappearVersion: null,
    introducedBy: null,
    ...overrides,
  };
}

/** Every `UPDATE chats SET safetyCheckedAt` the screen issued. */
const checkedWrites: unknown[][] = [];

beforeEach(async () => {
  await db.close();
  sqlite.reset();
  db.setWorkspace('real');
  await db.initDb();
  checkedWrites.length = 0;
  seedChat({});

  const instance = sqlite.instances.get('tacendum.sqlite')!;
  const base = instance.execute.getMockImplementation()!;
  instance.execute.mockImplementation(async (sql: string, params?: unknown) => {
    const s = String(sql);
    if (s.includes('FROM chats WHERE peerId')) return { rows: [chatRow] };
    if (s.includes('UPDATE chats SET safetyCheckedAt')) {
      const p = (params ?? []) as unknown[];
      checkedWrites.push(p);
      chatRow.safetyCheckedAt = p[0];
      return { rows: [] };
    }
    if (s.includes('FROM messages')) return { rows: [THEIRS] };
    return base(s, params);
  });

  jest.spyOn(messaging, 'isPeerBlocked').mockReturnValue(false);
  // A session exists, so the safety state is 'unchecked' and the panel
  // offers the comparison the line asks for.
  jest.spyOn(messaging, 'getSafetyNumber').mockResolvedValue('4'.repeat(60));
});

afterEach(async () => {
  await db.close();
  jest.restoreAllMocks();
});

async function renderThread(): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <ChatThreadScreen
        peerId={PEER}
        onBack={jest.fn()}
        onOpenPeerProfile={jest.fn()}
        onOpenPhoto={jest.fn()}
      />,
    );
  });
  await ReactTestRenderer.act(async () => {});
  return tree;
}

function byId(tree: ReactTestRenderer.ReactTestRenderer, id: string) {
  return tree.root.findAll(n => n.props.testID === id);
}

/** A testID reaches several nodes of one element; presence is the question. */
function has(tree: ReactTestRenderer.ReactTestRenderer, id: string): boolean {
  return byId(tree, id).length > 0;
}

function texts(tree: ReactTestRenderer.ReactTestRenderer): string[] {
  return tree.root.findAllByType(Text).map(n => {
    const kids = n.props.children;
    return Array.isArray(kids) ? kids.join('') : String(kids ?? '');
  });
}

/** The control itself: a Pressable's host View carries no `onPress`. */
function press(tree: ReactTestRenderer.ReactTestRenderer, id: string) {
  return ReactTestRenderer.act(async () => {
    tree.root
      .find(n => n.props.testID === id && typeof n.props.onPress === 'function')
      .props.onPress();
  });
}

async function unmount(tree: ReactTestRenderer.ReactTestRenderer) {
  await ReactTestRenderer.act(() => {
    tree.unmount();
  });
}

describe('a chat the server introduced', () => {
  test('renders the line, verbatim, while the safety number is unverified', async () => {
    seedChat({ introducedBy: 'discovery' });
    const tree = await renderThread();

    expect(has(tree, 'provenance-notice')).toBe(true);
    expect(texts(tree)).toContain(LINE);
    await unmount(tree);
  });

  test('starts without the line when a match was already recorded', async () => {
    seedChat({ introducedBy: 'discovery', safetyCheckedAt: T0 + 1 });
    const tree = await renderThread();

    expect(has(tree, 'provenance-notice')).toBe(false);
    expect(texts(tree)).not.toContain(LINE);
    await unmount(tree);
  });

  test('the line clears the moment this phone records a match', async () => {
    seedChat({ introducedBy: 'discovery' });
    const tree = await renderThread();
    expect(has(tree, 'provenance-notice')).toBe(true);

    // The line's own affordance opens the panel; the panel's primary asks
    // for the comparison; "They match" records it. Every step is the real
    // control the person would press.
    await press(tree, 'provenance-compare');
    expect(has(tree, 'safety-number')).toBe(true);
    // The digits are text two people read aloud: charcoal, never forest
    // (forest marks an action).
    const digits = tree.root
      .findAll(n => n.props.testID === 'safety-number' && typeof n.type === 'string')[0]!
      .findAll(n => typeof n.type === 'string' && /^[0-9 ]+$/.test(String(n.props.children)));
    expect(digits.length).toBeGreaterThan(0);
    for (const group of digits) {
      expect(StyleSheet.flatten(group.props.style).color).toBe(themeTokens().color.inkStrong);
    }
    await press(tree, 'safety-primary');
    await press(tree, 'safety-match');
    await ReactTestRenderer.act(async () => {});

    expect(checkedWrites).toHaveLength(1);
    expect(typeof checkedWrites[0]![0]).toBe('number');
    expect(has(tree, 'provenance-notice')).toBe(false);
    expect(texts(tree)).not.toContain(LINE);
    await unmount(tree);
  });
});

describe('a chat the server did NOT introduce', () => {
  test.each([
    ['a QR hand-off', 'qr'],
    ['a typed id', 'manual'],
    ['a row that predates provenance (the migration NULL)', null],
  ])('%s renders nothing', async (_label, introducedBy) => {
    seedChat({ introducedBy });
    const tree = await renderThread();

    expect(has(tree, 'provenance-notice')).toBe(false);
    expect(texts(tree)).not.toContain(LINE);
    await unmount(tree);
  });
});
