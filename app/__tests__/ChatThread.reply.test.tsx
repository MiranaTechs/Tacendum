/**
 * A quote names its author and takes you to the original.
 *
 * The rules pinned here:
 *  - the quote box says WHO wrote the message it quotes — "You" for my own
 *    row, my name for the peer otherwise — resolved the way every other
 *    author label is, never from anything the reply's envelope carries;
 *  - tapping the quote scrolls the list to the quoted row's own index and
 *    flashes that row for a moment, then the flash clears: their row in the
 *    neutral highlight, my own row in the pressed slab (the highlight under
 *    my white words would all but erase them);
 *  - a quote whose original is gone is inert: nothing to scroll to.
 *
 * Harness copied from ChatThread.revise.test.tsx, with a named peer. */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { FlatList, StyleSheet, Text } from 'react-native';
import * as db from '../src/db';
import { ChatThreadScreen } from '../src/screens/ChatThreadScreen';
import { ThemeProvider, themeTokens } from '../src/theme';

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
  status: 'received',
  editedAt: null,
  deletedAt: null,
  ...r,
});

const THEIRS = row({ msgId: '01THEIRS', direction: 'in', body: 'dinner at eight?', ts: T0 });
const MINE = row({
  msgId: '01MINE',
  direction: 'out',
  status: 'sent',
  body: 'make it nine',
  ts: T0 + 60_000,
});
/** My answer to THEIRS. */
const REPLY_OUT = row({
  msgId: '01REPLYOUT',
  direction: 'out',
  status: 'sent',
  body: JSON.stringify({ tcm: 'reply', ref: '01THEIRS', ofs: false, text: 'nine works' }),
  ts: T0 + 120_000,
});
/** Their answer to MINE. */
const REPLY_IN = row({
  msgId: '01REPLYIN',
  direction: 'in',
  body: JSON.stringify({ tcm: 'reply', ref: '01MINE', ofs: false, text: 'fine, nine' }),
  ts: T0 + 180_000,
});
/** An answer to a message this phone no longer has. */
const REPLY_ORPHAN = row({
  msgId: '01ORPHAN',
  direction: 'in',
  body: JSON.stringify({ tcm: 'reply', ref: '01NOSUCH', ofs: true, text: 'as I said' }),
  ts: T0 + 240_000,
});

let scrollToIndex: jest.SpyInstance;

beforeEach(async () => {
  jest.useFakeTimers();
  jest.setSystemTime(T0 + 300_000);
  scrollToIndex = jest
    .spyOn(FlatList.prototype, 'scrollToIndex')
    .mockImplementation(() => {});
  await db.close();
  sqlite.reset();
  db.setWorkspace('real');
  await db.initDb();
  const instance = sqlite.instances.get('tacendum.sqlite')!;
  const base = instance.execute.getMockImplementation()!;
  instance.execute.mockImplementation(async (sql: string, params?: unknown) => {
    const s = String(sql);
    if (s.includes('FROM messages')) {
      return { rows: [THEIRS, MINE, REPLY_OUT, REPLY_IN, REPLY_ORPHAN] };
    }
    if (s.includes('FROM chats')) {
      return {
        rows: [
          {
            peerId: 'peer-1',
            displayName: 'Dawit',
            localName: null,
            lastOpenedAt: T0 + 250_000,
          },
        ],
      };
    }
    return base(sql, params);
  });
});

afterEach(async () => {
  jest.restoreAllMocks();
  await db.close();
  jest.useRealTimers();
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
  await ReactTestRenderer.act(async () => {});
  return tree;
}

function byId(tree: ReactTestRenderer.ReactTestRenderer, id: string) {
  return tree.root.findAll(n => n.props.testID === id);
}

function textOf(node: ReactTestRenderer.ReactTestInstance): string {
  const t = node.findAllByType(Text)[0]!;
  return Array.isArray(t.props.children)
    ? t.props.children.join('')
    : String(t.props.children ?? '');
}

/** The quoted row's bubble background, flattened from the host view. */
function bubbleBackground(
  tree: ReactTestRenderer.ReactTestRenderer,
  msgId: string,
): string | undefined {
  const host = byId(tree, `msg-${msgId}`).find(n => typeof n.type === 'string');
  return StyleSheet.flatten(host?.props.style)?.backgroundColor as string | undefined;
}

/** The flash layer drawn over a row's own surface, or null when none is. */
function flashLayer(
  tree: ReactTestRenderer.ReactTestRenderer,
  msgId: string,
): { backgroundColor?: string; position?: string } | null {
  const host = byId(tree, `msg-flash-${msgId}`).find(n => typeof n.type === 'string');
  return host ? StyleSheet.flatten(host.props.style) : null;
}

/** WCAG contrast of two #RRGGBB colours (parseInt, never bitwise). */
function contrast(a: string, b: string): number {
  const luminance = (hex: string): number => {
    const [r, g, bl] = [1, 3, 5].map(i => {
      const v = parseInt(hex.slice(i, i + 2), 16) / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** An `rgba(r,g,b,a)` over an opaque #RRGGBB, as #RRGGBB. */
function composite(rgba: string, under: string): string {
  const [r, g, b, a] = rgba.slice(5, -1).split(',').map(Number) as [number, number, number, number];
  return `#${[r, g, b]
    .map((top, i) =>
      Math.round(top * a + parseInt(under.slice(1 + i * 2, 3 + i * 2), 16) * (1 - a))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')
    .toUpperCase()}`;
}

test('the quote names its author: the peer by my name for them, me as "You"', async () => {
  const tree = await renderThread();
  expect(textOf(byId(tree, 'quote-author-01REPLYOUT')[0]!)).toBe('Dawit');
  expect(textOf(byId(tree, 'quote-author-01REPLYIN')[0]!)).toBe('You');
  // Nothing to name when the original is gone — and never the envelope.
  expect(byId(tree, 'quote-author-01ORPHAN')).toHaveLength(0);
  await ReactTestRenderer.act(() => tree.unmount());
});

test('tapping the quote scrolls to the quoted row and flashes it, then the flash clears', async () => {
  const tree = await renderThread();
  const t = themeTokens();
  // Their row is white: it flashes the neutral highlight.
  const highlight = t.color.pineWash;
  expect(flashLayer(tree, '01THEIRS')).toBeNull();

  await ReactTestRenderer.act(async () => {
    byId(tree, 'quote-01REPLYOUT')[0]!.props.onPress();
  });
  // THEIRS is the first row in the list.
  expect(scrollToIndex).toHaveBeenCalledWith(
    expect.objectContaining({ index: 0, viewPosition: 0.5 }),
  );
  // RE-CUT for build 33: the highlight is a layer OVER the bubble's
  // own white, which stays; it used to replace the fill.
  expect(flashLayer(tree, '01THEIRS')).toMatchObject({
    position: 'absolute',
    backgroundColor: highlight,
  });
  expect(bubbleBackground(tree, '01THEIRS')).toBe(t.color.paperSheet);

  await ReactTestRenderer.act(async () => {
    jest.advanceTimersByTime(1000);
  });
  expect(flashLayer(tree, '01THEIRS')).toBeNull();
  expect(bubbleBackground(tree, '01THEIRS')).toBe(t.color.paperSheet);
  await ReactTestRenderer.act(() => tree.unmount());
});

// Added for build 33: in dark the flash replaced the incoming sheet
// (#232323) with the translucent highlight over the thread's ground, which
// came out #212121, DARKER than the bubble at rest (1.02:1), the one moment
// it was meant to stand out.
test('in dark, their flashed row steps UP from its sheet: the highlight is drawn over it, never in its place', async () => {
  const d = themeTokens('dark');
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <ThemeProvider mode="dark">
        <ChatThreadScreen
          peerId="peer-1"
          onBack={jest.fn()}
          onOpenPeerProfile={jest.fn()}
          onOpenPhoto={jest.fn()}
        />
      </ThemeProvider>,
    );
  });
  await ReactTestRenderer.act(async () => {});
  await ReactTestRenderer.act(async () => {});

  await ReactTestRenderer.act(async () => {
    byId(tree, 'quote-01REPLYOUT')[0]!.props.onPress();
  });
  expect(bubbleBackground(tree, '01THEIRS')).toBe(d.color.paperSheet);
  expect(flashLayer(tree, '01THEIRS')?.backgroundColor).toBe(d.color.pineWash);
  const flashed = composite(d.color.pineWash, d.color.paperSheet);
  // Lighter than the resting sheet (away from the dark page), and at least
  // the 1.05:1 the highlight is held to everywhere else.
  expect(contrast(flashed, d.color.paperSheet)).toBeGreaterThanOrEqual(1.05);
  expect(contrast(flashed, d.color.paperGround)).toBeGreaterThan(
    contrast(d.color.paperSheet, d.color.paperGround),
  );
  // The falsifier: the old in-place fill, the highlight over the ground.
  expect(contrast(composite(d.color.pineWash, d.color.paperGround), d.color.paperSheet)).toBeLessThan(1.05);
  await ReactTestRenderer.act(() => tree.unmount());
});

test('their reply to my message scrolls to MY row, by the composite key', async () => {
  const tree = await renderThread();
  const t = themeTokens();
  // My own words rest on the forest slab.
  expect(bubbleBackground(tree, '01MINE')).toBe(t.color.bubbleOut);

  await ReactTestRenderer.act(async () => {
    byId(tree, 'quote-01REPLYIN')[0]!.props.onPress();
  });
  expect(scrollToIndex).toHaveBeenCalledWith(
    expect.objectContaining({ index: 1, viewPosition: 0.5 }),
  );
  // MY row flashes the pressed slab, never the neutral highlight: the
  // highlight under white words would all but erase them for the very
  // moment the flash exists to find them.
  expect(bubbleBackground(tree, '01MINE')).toBe(t.color.bubbleOutPressed);
  expect(bubbleBackground(tree, '01MINE')).not.toBe(t.color.pineWash);
  // …and no highlight layer over the slab.
  expect(flashLayer(tree, '01MINE')).toBeNull();

  await ReactTestRenderer.act(async () => {
    jest.advanceTimersByTime(1000);
  });
  expect(bubbleBackground(tree, '01MINE')).toBe(t.color.bubbleOut);
  await ReactTestRenderer.act(() => tree.unmount());
});

test('a quote of a message this phone no longer has is inert', async () => {
  const tree = await renderThread();
  const quote = byId(tree, 'quote-01ORPHAN')[0]!;
  expect(quote.props.onPress).toBeUndefined();
  expect(scrollToIndex).not.toHaveBeenCalled();
  await ReactTestRenderer.act(() => tree.unmount());
});
