/**
 * Pane-width adoption: the thread lays out against
 * its PANE, never its window.
 *
 * The regression this pins is the tablet probe row's observed defect:
 * fed the WINDOW's width on a 2560px tablet, the thread railed its bubbles
 * to opposite edges of the glass — `viewportWidth` carried the wrong fact.
 * Under the wide shell the thread renders in a pane narrower than its
 * window, so the bubble measure must derive from the pane's width
 * (usePaneWidth), and in compact — where no pane claims the subtree — the
 * hook answers exactly the window width the screen has always read, so the
 * phone layout is unchanged by construction.
 *
 * Harness follows ChatThread.blocking.test.tsx.
 */

import React from 'react';
import { Dimensions, StyleSheet } from 'react-native';
import ReactTestRenderer from 'react-test-renderer';
import * as db from '../src/db';
import { messaging } from '../src/messaging';
import { ChatThreadScreen } from '../src/screens/ChatThreadScreen';
import { themeTokens } from '../src/theme';
import { QrPanel } from '../src/ui/QrPanel';
import { PaneWidthProvider } from '../src/windowClass';

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
const PEER = 'peer-1';

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

const t = themeTokens();

/** What the bubble measure must be for a given viewport width — the same
 * Math.min the screen ships, restated so a change to either side breaks. */
function bubbleMaxFor(viewport: number): number {
  return Math.min(t.layout.bubbleMaxWidth, viewport * t.layout.bubbleMaxRatio);
}

const initialDimensions = {
  window: { ...Dimensions.get('window') },
  screen: { ...Dimensions.get('screen') },
};

function setWindow(width: number, height: number) {
  Dimensions.set({
    window: { width, height, scale: 2, fontScale: 2 },
    screen: { width, height, scale: 2, fontScale: 2 },
  });
}

beforeEach(async () => {
  await db.close();
  sqlite.reset();
  db.setWorkspace('real');
  await db.initDb();

  const instance = sqlite.instances.get('tacendum.sqlite')!;
  const base = instance.execute.getMockImplementation()!;
  instance.execute.mockImplementation(async (sql: string, params?: unknown) => {
    const s = String(sql);
    if (s.includes('FROM blocked_peers')) return { rows: [] };
    if (s.includes('FROM messages')) return { rows: [THEIRS] };
    return base(s, params);
  });

  jest.spyOn(messaging, 'isPeerBlocked').mockReturnValue(false);
  jest.spyOn(messaging, 'getSafetyNumber').mockResolvedValue(null);
});

afterEach(async () => {
  await db.close();
  jest.restoreAllMocks();
  Dimensions.set(initialDimensions);
});

async function render(
  element: React.ReactElement,
): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(element);
  });
  await ReactTestRenderer.act(async () => {});
  return tree;
}

function thread(): React.ReactElement {
  return (
    <ChatThreadScreen
      peerId={PEER}
      onBack={jest.fn()}
      onOpenPeerProfile={jest.fn()}
      onOpenPhoto={jest.fn()}
    />
  );
}

/** The message bubble's flattened style, from its host node. */
function bubbleStyle(
  tree: ReactTestRenderer.ReactTestRenderer,
): Record<string, unknown> {
  const host = tree.root.findAll(
    n => n.props.testID === `msg-${THEIRS.msgId}` && typeof n.type === 'string',
  )[0];
  return StyleSheet.flatten(host.props.style) as Record<string, unknown>;
}

describe('the thread lays out against its pane', () => {
  test('THE BUBBLE-RAIL REGRESSION: an expanded window, a narrow pane — the bubble measures the pane', async () => {
    // An expanded (≥840dp) window whose shell has claimed a 320pt pane for
    // this subtree. Previously the bubble read the WINDOW — the tablet defect.
    setWindow(1280, 800);
    const tree = await render(
      <PaneWidthProvider width={320}>{thread()}</PaneWidthProvider>,
    );

    const style = bubbleStyle(tree);
    expect(style.maxWidth).toBeCloseTo(bubbleMaxFor(320)); // 249.6, the pane's measure
    // Stated both ways so the failure mode is unmistakable: the window's
    // answer (min(292, 1280·0.78) = the 292 cap) is exactly what the
    // pre-adoption screen produced here.
    expect(style.maxWidth).not.toBe(bubbleMaxFor(1280));

    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('compact is sacred: with no pane, the measure is the window answer it always was', async () => {
    // 340pt sits under bubbleMaxWidth/ratio, so the ratio term is live —
    // a constant could not satisfy this.
    setWindow(340, 700);
    const tree = await render(thread());

    expect(bubbleStyle(tree).maxWidth).toBeCloseTo(bubbleMaxFor(340)); // 265.2

    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('compact at a phone width where the point cap wins: still the shipped 292', async () => {
    setWindow(750, 1334);
    const tree = await render(thread());

    expect(bubbleStyle(tree).maxWidth).toBe(t.layout.bubbleMaxWidth);

    await ReactTestRenderer.act(() => tree.unmount());
  });
});

describe('QrPanel sizes its square against its pane', () => {
  test('a narrow pane inside a wide window shrinks the square to the pane, floored at scannable', async () => {
    // The panel's own formula: min(QR_SIDE, max(QR_SIDE_MIN, width - 80)).
    // At a 180pt pane that is the 120pt floor; the WINDOW answer would be
    // the full 176pt square.
    setWindow(1280, 800);
    const tree = await render(
      <PaneWidthProvider width={180}>
        <QrPanel id="01KYDBSSDJSPC9J0E5N2AWMJ5Y" />
      </PaneWidthProvider>,
    );

    const image = tree.root.findAll(
      n => n.props.testID === 'self-qr-image' && typeof n.type === 'string',
    )[0];
    const style = StyleSheet.flatten(image.props.style) as {
      width: number;
      height: number;
    };
    expect(style.width).toBe(120);
    expect(style.height).toBe(120);

    await ReactTestRenderer.act(() => tree.unmount());
  });
});
