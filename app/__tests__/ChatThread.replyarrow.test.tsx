/**
 * The visible reply arrow beside inbound bubbles — the WhatsApp affordance.
 *
 * The rules these pin, each named where it is asserted:
 *  - the arrow rides every inbound CONTENT kind — text, photo, file, voice
 *    note, location, and a reply itself — because a photo is a message too;
 *  - it never appears on my own sends ("each message that comes to you");
 *  - it never appears on rows that are not messages: screenshot, timer and
 *    vault notices, room events, the outsider row, tombstones, error rows;
 *  - it calls the SAME `startReply` the rail's Reply calls, proven by
 *    comparing the composer chip both routes produce;
 *  - it is withdrawn with everything else when the peer is blocked;
 *  - it speaks what it replies to, and its touch target reaches 44pt.
 *
 * 1:1 harness follows ChatThread.revise.test.tsx; the room harness follows
 * ChatThread.room.test.tsx.
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { StyleSheet, Text } from 'react-native';
import type { RosterSlot } from '@tacendum/shared/group-fold';
import * as db from '../src/db';
import { messaging } from '../src/messaging';
import { ChatThreadScreen } from '../src/screens/ChatThreadScreen';

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

type Row = Record<string, unknown>;

const row = (r: Row): Row => ({
  peerId: 'peer-1',
  direction: 'in',
  status: 'received',
  editedAt: null,
  deletedAt: null,
  ...r,
});

/** Every inbound CONTENT kind, in one thread. A photo is a message too. */
const IN_TEXT = row({ msgId: '01INTEXT', body: 'dinner at eight?', ts: T0 });
const IN_PHOTO = row({
  msgId: '01INPHOTO',
  body: JSON.stringify({ tcm: 'image', att: 'blob-1', key: 'a2V5', w: 120, h: 90 }),
  ts: T0 + 60_000,
});
const IN_FILE = row({
  msgId: '01INFILE',
  body: JSON.stringify({
    tcm: 'file',
    att: 'blob-2',
    key: 'a2V5',
    name: 'lease.pdf',
    size: 4096,
    mime: 'application/pdf',
  }),
  ts: T0 + 120_000,
});
const IN_VOICE = row({
  msgId: '01INVOICE',
  body: JSON.stringify({ tcm: 'voice', att: 'blob-3', key: 'a2V5', dur: 9 }),
  ts: T0 + 180_000,
});
const IN_LOC = row({
  msgId: '01INLOC',
  body: JSON.stringify({ tcm: 'loc', lat: 37.33182, lng: -122.03118 }),
  ts: T0 + 240_000,
});
const IN_REPLY = row({
  msgId: '01INREPLY',
  body: JSON.stringify({ tcm: 'reply', ref: '01INTEXT', ofs: false, text: 'yes' }),
  ts: T0 + 300_000,
});

/** My own sends — words and a photo, so absence is proven for both shapes. */
const OUT_TEXT = row({
  msgId: '01OUTTEXT',
  direction: 'out',
  body: 'on my way',
  ts: T0 + 360_000,
  status: 'sent',
});
const OUT_PHOTO = row({
  msgId: '01OUTPHOTO',
  direction: 'out',
  body: JSON.stringify({ tcm: 'image', att: 'blob-4', key: 'a2V5', w: 120, h: 90 }),
  ts: T0 + 420_000,
  status: 'sent',
});

/** Rows that are not messages: events, not things you reply to. */
const IN_SHOT = row({
  msgId: '01INSHOT',
  body: JSON.stringify({ tcm: 'shot' }),
  ts: T0 + 480_000,
});
const IN_TIMER = row({
  msgId: '01INTIMER',
  body: JSON.stringify({ tcm: 'timer', s: 3600, v: 1 }),
  ts: T0 + 540_000,
});
const IN_VAULT = row({
  msgId: '01INVAULT',
  body: JSON.stringify({
    tcm: 'vault',
    op: 'set',
    id: '0'.repeat(26),
    title: 'Wi-Fi',
    body: 'hunter2',
    n: 1,
    k: 1,
  }),
  ts: T0 + 600_000,
});
const IN_GONE = row({
  msgId: '01INGONE',
  body: '',
  ts: T0 + 660_000,
  deletedAt: T0 + 670_000,
});
const IN_ERROR = row({
  msgId: '01INERROR',
  body: '',
  ts: T0 + 720_000,
  status: 'error',
});

const ONE_TO_ONE_ROWS = [
  IN_TEXT,
  IN_PHOTO,
  IN_FILE,
  IN_VOICE,
  IN_LOC,
  IN_REPLY,
  OUT_TEXT,
  OUT_PHOTO,
  IN_SHOT,
  IN_TIMER,
  IN_VAULT,
  IN_GONE,
  IN_ERROR,
];

/** When the fake `blocked_peers` table says this iPhone blocked them. */
const blockedAt: { at: number | null } = { at: null };

function installDb(messageRows: Row[]) {
  const instance = sqlite.instances.get('tacendum.sqlite')!;
  const base = instance.execute.getMockImplementation()!;
  instance.execute.mockImplementation(async (sql: string, params?: unknown) => {
    const s = String(sql);
    if (s.includes('FROM blocked_peers')) {
      return {
        rows:
          blockedAt.at === null
            ? []
            : [{ peerId: 'peer-1', blockedAt: blockedAt.at }],
      };
    }
    if (s.includes('FROM messages')) return { rows: messageRows };
    return base(s, params);
  });
}

beforeEach(async () => {
  await db.close();
  sqlite.reset();
  db.setWorkspace('real');
  await db.initDb();
  blockedAt.at = null;
  installDb(ONE_TO_ONE_ROWS);
  // Resolved inside act() or not at all: without this the safety-number
  // lookup lands after the test body and trips the act() warning.
  jest.spyOn(messaging, 'getSafetyNumber').mockResolvedValue(null);
});

afterEach(async () => {
  jest.restoreAllMocks();
  await db.close();
});

async function renderThread(
  props: Partial<React.ComponentProps<typeof ChatThreadScreen>> = {},
): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <ChatThreadScreen
        peerId="peer-1"
        onBack={jest.fn()}
        onOpenPeerProfile={jest.fn()}
        onOpenPhoto={jest.fn()}
        {...props}
      />,
    );
  });
  await ReactTestRenderer.act(async () => {});
  return tree;
}

function byId(tree: ReactTestRenderer.ReactTestRenderer, id: string) {
  return tree.root.findAll(n => n.props.testID === id);
}

/** The composer chip's rendered lines — what either reply route arms. */
function chipTexts(tree: ReactTestRenderer.ReactTestRenderer): string[] {
  const chip = byId(tree, 'composer-chip')[0];
  return chip
    .findAllByType(Text)
    .map(n =>
      Array.isArray(n.props.children)
        ? n.props.children.join('')
        : String(n.props.children ?? ''),
    );
}

async function press(
  tree: ReactTestRenderer.ReactTestRenderer,
  id: string,
): Promise<void> {
  await ReactTestRenderer.act(async () => {
    byId(tree, id)[0].props.onPress();
  });
}

test('every inbound content kind carries the reply arrow — a photo is a message too', async () => {
  const tree = await renderThread();
  for (const id of [
    '01INTEXT',
    '01INPHOTO',
    '01INFILE',
    '01INVOICE',
    '01INLOC',
    '01INREPLY',
  ]) {
    expect(byId(tree, `reply-arrow-${id}`).length).toBeGreaterThan(0);
  }
  await ReactTestRenderer.act(() => tree.unmount());
});

test('my own sends never grow the arrow', async () => {
  const tree = await renderThread();
  // The bubbles themselves are in the tree — absence is not vacuous.
  expect(byId(tree, 'msg-01OUTTEXT').length).toBeGreaterThan(0);
  expect(byId(tree, 'msg-01OUTPHOTO').length).toBeGreaterThan(0);
  expect(byId(tree, 'reply-arrow-01OUTTEXT').length).toBe(0);
  expect(byId(tree, 'reply-arrow-01OUTPHOTO').length).toBe(0);
  await ReactTestRenderer.act(() => tree.unmount());
});

test('rows that are not messages never grow the arrow', async () => {
  const tree = await renderThread();
  // Each system row is proven present under its own testID first, so the
  // arrow's absence cannot be the row simply not rendering.
  const systems: Array<[string, string]> = [
    ['shot-01INSHOT', 'reply-arrow-01INSHOT'],
    ['timer-01INTIMER', 'reply-arrow-01INTIMER'],
    ['vault-01INVAULT', 'reply-arrow-01INVAULT'],
    ['tombstone-01INGONE', 'reply-arrow-01INGONE'],
    ['error-01INERROR', 'reply-arrow-01INERROR'],
  ];
  for (const [present, absent] of systems) {
    expect(byId(tree, present).length).toBeGreaterThan(0);
    expect(byId(tree, absent).length).toBe(0);
  }
  await ReactTestRenderer.act(() => tree.unmount());
});

test('the arrow arms exactly the composer state the rail Reply arms', async () => {
  const tree = await renderThread();

  // Route one: the long-press rail.
  await ReactTestRenderer.act(async () => {
    byId(tree, 'msg-01INTEXT')[0].props.onLongPress();
  });
  await press(tree, 'reply-01INTEXT');
  const viaRail = chipTexts(tree);
  await press(tree, 'composer-chip-cancel');
  expect(byId(tree, 'composer-chip').length).toBe(0);

  // Route two: the arrow. Same chip, word for word — one startReply.
  await press(tree, 'reply-arrow-01INTEXT');
  expect(chipTexts(tree)).toEqual(viaRail);
  // Replying borrows the composer without touching the draft.
  expect(byId(tree, 'composer-input')[0].props.value).toBe('');

  await ReactTestRenderer.act(() => tree.unmount());
});

test('the arrow names what it replies to, for words and for things', async () => {
  const tree = await renderThread();
  const label = (id: string) =>
    byId(tree, `reply-arrow-${id}`)[0].props.accessibilityLabel as string;
  // This peer has no name, so personRef falls back to the pronoun 'them'.
  expect(label('01INTEXT')).toBe('Reply to them: dinner at eight?');
  expect(label('01INPHOTO')).toBe('Reply to them: Photo');
  expect(label('01INFILE')).toBe('Reply to them: Document');
  expect(label('01INVOICE')).toBe('Reply to them: Voice message');
  expect(label('01INLOC')).toBe('Reply to them: Location');
  expect(byId(tree, 'reply-arrow-01INTEXT')[0].props.accessibilityRole).toBe(
    'button',
  );
  await ReactTestRenderer.act(() => tree.unmount());
});

test('the touch target reaches 44pt even though the glyph is smaller', async () => {
  const tree = await renderThread();
  const arrow = byId(tree, 'reply-arrow-01INTEXT')[0];
  const style = StyleSheet.flatten(
    typeof arrow.props.style === 'function'
      ? arrow.props.style({ pressed: false })
      : arrow.props.style,
  );
  const slop = arrow.props.hitSlop as {
    top: number;
    bottom: number;
    left: number;
    right: number;
  };
  expect(style.width! + slop.left + slop.right).toBeGreaterThanOrEqual(44);
  expect(style.height! + slop.top + slop.bottom).toBeGreaterThanOrEqual(44);
  await ReactTestRenderer.act(() => tree.unmount());
});

test('a block withdraws the arrow with everything else', async () => {
  blockedAt.at = T0 + 900_000;
  jest.spyOn(messaging, 'isPeerBlocked').mockReturnValue(true);
  const tree = await renderThread();
  expect(byId(tree, 'msg-01INTEXT').length).toBeGreaterThan(0);
  expect(byId(tree, 'reply-arrow-01INTEXT').length).toBe(0);
  await ReactTestRenderer.act(() => tree.unmount());
});

// ---------------------------------------------------------------------------
// The room: same arrow, same absence rules, subject from the authenticated
// author. Harness follows ChatThread.room.test.tsx.
// ---------------------------------------------------------------------------

/** Valid Crockford ULIDs (no I, L, O, U), 26 chars, distinct tails. */
const ulid = (tag: string) => (tag + '0'.repeat(26)).slice(0, 26);
const ROOM = ulid('R00MK7CHN');
const ANA = ulid('ANA'); // the owner
const BEN = ulid('BEN');
const DAN = ulid('DAN'); // outsider: the roster said out at arrival
const ME = ulid('ME1');

const NAME_ROWS = [
  { peerId: ANA, displayName: 'Ana', localName: null },
  { peerId: BEN, displayName: 'Ben', localName: null },
  { peerId: DAN, displayName: 'Dan', localName: null },
];

const SLOT_ROWS: RosterSlot[] = [
  { memberId: ANA, writerId: ANA, seq: 1, state: 'in' },
  { memberId: ME, writerId: ANA, seq: 1, state: 'in' },
  { memberId: BEN, writerId: ANA, seq: 1, state: 'in' },
];

const roomRow = (r: Row): Row => ({
  peerId: ROOM,
  direction: 'in',
  status: 'received',
  editedAt: null,
  deletedAt: null,
  ...r,
});

const ROOM_ROWS: Row[] = [
  roomRow({
    msgId: 'W1',
    body: JSON.stringify({
      tcm: 'grp.new',
      g: ROOM,
      nm: 'Kitchen',
      ms: [ANA, ME, BEN],
      n: 1,
    }),
    ts: T0,
    authorId: ANA,
  }),
  roomRow({
    msgId: `${BEN}.M1`,
    body: 'hello there',
    ts: T0 + 60_000,
    authorId: BEN,
  }),
  roomRow({
    msgId: `${BEN}.P1`,
    body: JSON.stringify({ tcm: 'image', att: 'blob-5', key: 'a2V5', w: 120, h: 90 }),
    ts: T0 + 120_000,
    authorId: BEN,
  }),
  roomRow({
    msgId: 'W2',
    body: JSON.stringify({ tcm: 'grp.roster', g: ROOM, m: DAN, s: 'in', n: 2 }),
    ts: T0 + 180_000,
    authorId: ANA,
  }),
  roomRow({
    msgId: `${DAN}.M1`,
    body: 'wait, what happened?',
    ts: T0 + 240_000,
    authorId: DAN,
    outsider: 1,
  }),
  roomRow({
    msgId: 'MINE.M1',
    direction: 'out',
    body: 'welcome',
    ts: T0 + 300_000,
    status: 'sent',
  }),
];

function installRoomDb(messageRows: Row[]) {
  const instance = sqlite.instances.get('tacendum.sqlite')!;
  const base = instance.execute.getMockImplementation()!;
  instance.execute.mockImplementation(
    async (sql: string, params?: unknown[]) => {
      const s = String(sql);
      if (s.includes('FROM messages')) return { rows: messageRows };
      if (s.includes('SELECT groupId, ownerId, name FROM groups')) {
        return params?.[0] === ROOM
          ? { rows: [{ groupId: ROOM, ownerId: ANA, name: 'Kitchen' }] }
          : { rows: [] };
      }
      if (s.includes('FROM group_members')) {
        return params?.[0] === ROOM ? { rows: SLOT_ROWS } : { rows: [] };
      }
      if (s.includes('FROM chats') && s.includes('ORDER BY')) {
        return { rows: NAME_ROWS };
      }
      if (s.includes('FROM profile')) {
        return {
          rows: [
            { key: 'userId', value: ME },
            { key: 'registrationId', value: '7' },
          ],
        };
      }
      return base(sql, params);
    },
  );
}

test('in a room the arrow rides member bubbles only — never events, the outsider row, or my sends', async () => {
  installRoomDb(ROOM_ROWS);
  const tree = await renderThread({ peerId: ROOM });

  // Member content, words and a photo alike.
  expect(byId(tree, `reply-arrow-${BEN}.M1`).length).toBeGreaterThan(0);
  expect(byId(tree, `reply-arrow-${BEN}.P1`).length).toBeGreaterThan(0);

  // Events, the outsider's framed row, and my own bubble: present, arrowless.
  expect(byId(tree, 'room-event-W1').length).toBeGreaterThan(0);
  expect(byId(tree, 'room-event-W2').length).toBeGreaterThan(0);
  expect(byId(tree, `outsider-${DAN}.M1`).length).toBeGreaterThan(0);
  expect(byId(tree, 'msg-MINE.M1').length).toBeGreaterThan(0);
  expect(byId(tree, 'reply-arrow-W1').length).toBe(0);
  expect(byId(tree, 'reply-arrow-W2').length).toBe(0);
  expect(byId(tree, `reply-arrow-${DAN}.M1`).length).toBe(0);
  expect(byId(tree, 'reply-arrow-MINE.M1').length).toBe(0);

  await ReactTestRenderer.act(() => tree.unmount());
});

test('in a room the arrow arms the composer against the authenticated author', async () => {
  installRoomDb(ROOM_ROWS);
  const tree = await renderThread({ peerId: ROOM });

  // The label speaks the author the roster authenticated, never the room.
  expect(
    byId(tree, `reply-arrow-${BEN}.M1`)[0].props.accessibilityLabel,
  ).toBe('Reply to Ben: hello there');

  await press(tree, `reply-arrow-${BEN}.M1`);
  const chip = chipTexts(tree);
  expect(chip.some(s => s === 'Replying to Ben')).toBe(true);
  expect(chip.some(s => s === 'hello there')).toBe(true);

  await ReactTestRenderer.act(() => tree.unmount());
});
