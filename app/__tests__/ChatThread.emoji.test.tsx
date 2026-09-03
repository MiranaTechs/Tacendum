/**
 * An emoji-only message is drawn large and without a bubble — the messenger
 * convention: "👍" is a gesture, not a sentence, and a sentence-sized glyph
 * in a bubble reads as a typo.
 *
 * The rules pinned here:
 *  - one to three emoji, and nothing else, render at the display size with
 *    no bubble surface (no fill, no edge);
 *  - words beside an emoji, or four or more emoji, keep the ordinary bubble;
 *  - a flag (two regional indicators) is one emoji; a skin-toned or
 *    joined sequence is one emoji;
 *  - the delivery tick still rides an outbound jumbo row.
 *
 * Harness copied from ChatThread.revise.test.tsx. */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { StyleSheet, Text } from 'react-native';
import * as db from '../src/db';
import { ChatThreadScreen } from '../src/screens/ChatThreadScreen';
import { TickGlyph } from '../src/ui/TickGlyph';
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

const T0 = new Date('2026-09-02T12:00:00').getTime();

type Row = Record<string, unknown>;
const row = (r: Row): Row => ({
  peerId: 'peer-1',
  direction: 'in',
  status: 'received',
  editedAt: null,
  deletedAt: null,
  ...r,
});

const ONE = row({ msgId: '01ONE', body: '👍', ts: T0 });
const THREE = row({ msgId: '01THREE', body: '😂🔥❤️', ts: T0 + 1 });
const FLAG = row({ msgId: '01FLAG', body: '🇪🇹', ts: T0 + 2 });
const TONED = row({ msgId: '01TONED', body: '👋🏽 👨‍👩‍👧', ts: T0 + 3 });
const MINE = row({
  msgId: '01MINE',
  direction: 'out',
  status: 'delivered',
  body: '🙏',
  ts: T0 + 4,
});
/** An edited jumbo send: the "edited" mark rides the same transparent
 * surface the tick does. */
const MINE_EDITED = row({
  msgId: '01MINEEDIT',
  direction: 'out',
  status: 'read',
  body: '🎉',
  ts: T0 + 4.5,
  editedAt: T0 + 5,
});
/** The control: an outbound row on the ordinary pine slab, where the inks
 * must stay the on-pine pair. */
const MINE_WORDS = row({
  msgId: '01MINEWORDS',
  direction: 'out',
  status: 'sent',
  body: 'on my way',
  ts: T0 + 4.75,
  editedAt: T0 + 5,
});
const WORDS = row({ msgId: '01WORDS', body: 'hi 👍', ts: T0 + 5 });
const FOUR = row({ msgId: '01FOUR', body: '👍👍👍👍', ts: T0 + 6 });
const PLAIN = row({ msgId: '01PLAIN', body: 'see you', ts: T0 + 7 });

beforeEach(async () => {
  await db.close();
  sqlite.reset();
  db.setWorkspace('real');
  await db.initDb();
  const instance = sqlite.instances.get('tacendum.sqlite')!;
  const base = instance.execute.getMockImplementation()!;
  instance.execute.mockImplementation(async (sql: string, params?: unknown) => {
    if (String(sql).includes('FROM messages')) {
      return {
        rows: [
          ONE,
          THREE,
          FLAG,
          TONED,
          MINE,
          MINE_EDITED,
          MINE_WORDS,
          WORDS,
          FOUR,
          PLAIN,
        ],
      };
    }
    return base(sql, params);
  });
});

afterEach(async () => {
  await db.close();
});

async function renderThread(): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <ChatThreadScreen
        peerId="peer-1"
        onBack={jest.fn()}
        onOpenPeerProfile={jest.fn()}
        onOpenPhoto={jest.fn()}
      />,
    );
  });
  await ReactTestRenderer.act(async () => {});
  return tree;
}

/** The bubble host view and the Text carrying the message's words. */
function bubble(tree: ReactTestRenderer.ReactTestRenderer, msgId: string, words: string) {
  const host = tree.root
    .findAll(n => n.props.testID === `msg-${msgId}`)
    .find(n => typeof n.type === 'string')!;
  const text = host
    .findAllByType(Text)
    .find(n => {
      const c = n.props.children;
      return c === words || (Array.isArray(c) && c.join('') === words);
    })!;
  return {
    surface: StyleSheet.flatten(host.props.style),
    type: StyleSheet.flatten(text.props.style),
  };
}

const t = themeTokens();

test('one to three emoji alone: display size, no fill, no edge', async () => {
  const tree = await renderThread();
  for (const [id, words] of [
    ['01ONE', '👍'],
    ['01THREE', '😂🔥❤️'],
    ['01FLAG', '🇪🇹'],
    ['01TONED', '👋🏽 👨‍👩‍👧'],
    ['01MINE', '🙏'],
  ] as const) {
    const b = bubble(tree, id, words);
    expect(b.type.fontSize).toBe(t.type.display.fontSize);
    expect(b.surface.backgroundColor).toBe('transparent');
    expect(b.surface.borderColor).toBe('transparent');
  }
  await ReactTestRenderer.act(() => tree.unmount());
});

test('words beside an emoji, or four emoji, keep the ordinary bubble', async () => {
  const tree = await renderThread();
  for (const [id, words] of [
    ['01WORDS', 'hi 👍'],
    ['01FOUR', '👍👍👍👍'],
    ['01PLAIN', 'see you'],
  ] as const) {
    const b = bubble(tree, id, words);
    expect(b.type.fontSize).toBe(t.type.message.fontSize);
    expect(b.surface.backgroundColor).toBe(t.color.paperSheet);
  }
  await ReactTestRenderer.act(() => tree.unmount());
});

test('the delivery tick still rides an outbound jumbo row', async () => {
  const tree = await renderThread();
  expect(
    tree.root.findAll(n => n.props.testID === 'status-01MINE-delivered').length,
  ).toBeGreaterThan(0);
  await ReactTestRenderer.act(() => tree.unmount());
});

/**
 * THE GATE'S DEFECT. The jumbo surface goes transparent, but the tick and
 * the "edited" mark kept their ON-PINE inks: near-white on the off-white
 * thread ground in light mode, and the READ tick — the one state the glyph
 * exists to distinguish — invisible in both. The photo status already
 * solves exactly this for a paper-coloured surface; a jumbo row is the same
 * problem. */
test('an outbound jumbo row inks its tick for paper, not for pine', async () => {
  const tree = await renderThread();
  const status = tree.root
    .findAll(n => n.props.testID === 'status-01MINE-delivered')
    .find(n => typeof n.type !== 'string')!;
  const tick = status.findByType(TickGlyph);
  expect(tick.props.color).toBe(t.color.inkMuted);
  expect(tick.props.readColor).toBe(t.color.pine);

  // The ordinary pine bubble is untouched: on pine the inks must stay on-pine.
  const plain = tree.root
    .findAll(n => n.props.testID === 'status-01PLAIN-received')
    .find(n => typeof n.type !== 'string');
  expect(plain).toBeUndefined(); // inbound rows draw no tick
  await ReactTestRenderer.act(() => tree.unmount());
});

test('the "edited" mark on a jumbo send is inked for paper too', async () => {
  const tree = await renderThread();
  const mark = tree.root
    .findAll(n => n.props.testID === 'edited-01MINEEDIT')
    .find(n => typeof n.type === 'string')!;
  expect(StyleSheet.flatten(mark.props.style).color).toBe(t.color.inkMuted);
  await ReactTestRenderer.act(() => tree.unmount());
});

test('an ordinary outbound bubble still inks its tick and mark for pine', async () => {
  const tree = await renderThread();
  const status = tree.root
    .findAll(n => n.props.testID === 'status-01MINEWORDS-sent')
    .find(n => typeof n.type !== 'string')!;
  const tick = status.findByType(TickGlyph);
  expect(tick.props.color).toBe(t.color.onBubbleOut);
  expect(tick.props.readColor).toBe(t.color.onPine);
  const mark = tree.root
    .findAll(n => n.props.testID === 'edited-01MINEWORDS')
    .find(n => typeof n.type === 'string')!;
  expect(StyleSheet.flatten(mark.props.style).color).toBe(t.color.onBubbleOut);
  await ReactTestRenderer.act(() => tree.unmount());
});
