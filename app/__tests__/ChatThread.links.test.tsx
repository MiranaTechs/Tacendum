/**
 * Web addresses in a message are tappable.
 *
 * THE DEFECT THIS FILE EXISTS FOR. The bubble printed its words as one plain
 * <Text>: an address someone sent could be selected and copied, nothing
 * more. Now a declared address — a scheme, or a `www.` host — is a nested
 * link that opens through Linking. Nothing is fetched or previewed: the
 * address leaves this phone only when the person taps it.
 *
 * Harness copied from ChatThread.timer.test.tsx. */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import * as db from '../src/db';
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

const T0 = new Date('2026-09-02T12:00:00').getTime();

const LINK_IN = {
  msgId: '01LINKIN',
  peerId: 'peer-1',
  direction: 'in',
  body: 'see https://example.com/menu. now',
  ts: T0,
  status: 'received',
};
const WWW_OUT = {
  msgId: '01WWWOUT',
  peerId: 'peer-1',
  direction: 'out',
  body: 'www.tacendum.com',
  ts: T0 + 60_000,
  status: 'sent',
};
const BARE_IN = {
  msgId: '01BAREIN',
  peerId: 'peer-1',
  direction: 'in',
  body: 'example.com is words',
  ts: T0 + 120_000,
  status: 'received',
};

const realFetch = globalThis.fetch;
const fetchMock = jest.fn();

beforeEach(async () => {
  await db.close();
  sqlite.reset();
  db.setWorkspace('real');
  await db.initDb();
  fetchMock.mockClear();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  const instance = sqlite.instances.get('tacendum.sqlite')!;
  const base = instance.execute.getMockImplementation()!;
  instance.execute.mockImplementation(async (sql: string, params?: unknown) => {
    if (String(sql).includes('FROM messages')) {
      return { rows: [LINK_IN, WWW_OUT, BARE_IN] };
    }
    return base(sql, params);
  });
});

afterEach(async () => {
  jest.restoreAllMocks();
  await db.close();
});

afterAll(() => {
  globalThis.fetch = realFetch;
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

/** Every rendered link, by the role the screen reader announces — one per
 * address (the test renderer reports a composite AND a host node for each
 * <Text>, so the pair is folded on its label). */
function links(tree: ReactTestRenderer.ReactTestRenderer) {
  const seen = new Set<string>();
  return tree.root
    .findAll(
      n =>
        n.props.accessibilityRole === 'link' && typeof n.props.onPress === 'function',
    )
    .filter(n => {
      const label = String(n.props.children);
      if (seen.has(label)) return false;
      seen.add(label);
      return true;
    });
}

test('a declared address is a link that opens through Linking; a bare domain is words', async () => {
  const { Linking } = require('react-native');
  const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
  const tree = await renderThread();

  const found = links(tree);
  const labels = found.map(n => String(n.props.children));
  expect(labels).toContain('https://example.com/menu');
  expect(labels).toContain('www.tacendum.com');
  // The bare domain is not offered as a link, and the sentence around the
  // address stays ordinary words: two links on this glass, not three.
  expect(found).toHaveLength(2);
  expect(labels.some(l => l.includes('example.com is words'))).toBe(false);

  await ReactTestRenderer.act(async () => {
    found.find(n => String(n.props.children) === 'https://example.com/menu')!.props.onPress();
  });
  expect(open).toHaveBeenCalledWith('https://example.com/menu');

  await ReactTestRenderer.act(async () => {
    found.find(n => String(n.props.children) === 'www.tacendum.com')!.props.onPress();
  });
  expect(open).toHaveBeenLastCalledWith('https://www.tacendum.com');

  // Nothing about rendering or tapping an address fetches anything.
  expect(fetchMock).not.toHaveBeenCalled();
  await ReactTestRenderer.act(() => {
    tree.unmount();
  });
});

test('the words around an address are still printed, so the sentence reads whole', async () => {
  const tree = await renderThread();
  const texts = tree.root
    .findAllByType(require('react-native').Text)
    .map(n =>
      Array.isArray(n.props.children)
        ? n.props.children
            .map((c: unknown) => (typeof c === 'string' ? c : ''))
            .join('')
        : String(n.props.children ?? ''),
    );
  // The outer bubble text holds the plain runs; the link is its own node.
  expect(texts.some(s => s.startsWith('see ') && s.endsWith('. now'))).toBe(true);
  await ReactTestRenderer.act(() => {
    tree.unmount();
  });
});

/**
 * The rotor route. The bubble is ONE accessible element — that is
 * what flattens the nested link's own tap out of the tree, and why the quote
 * already needs an action of its own. Without a matching action for the
 * address, a screen-reader user could hear the link and had no way to open
 * it. */
test('every address in a bubble is offered to VoiceOver as an action that opens it', async () => {
  const { Linking } = require('react-native');
  const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
  const tree = await renderThread();

  const bubble = tree.root
    .findAll(n => n.props.testID === 'msg-01LINKIN')
    .find(n => Array.isArray(n.props.accessibilityActions))!;
  const actions = bubble.props.accessibilityActions as Array<{
    name: string;
    label: string;
  }>;
  const link = actions.find(a => a.label === 'Open https://example.com/menu');
  expect(link).toBeDefined();

  await ReactTestRenderer.act(async () => {
    bubble.props.onAccessibilityAction({
      nativeEvent: { actionName: link!.name },
    });
  });
  expect(open).toHaveBeenCalledWith('https://example.com/menu');

  // A bubble with no address grows no such action.
  const plain = tree.root
    .findAll(n => n.props.testID === 'msg-01BAREIN')
    .find(n => Array.isArray(n.props.accessibilityActions))!;
  expect(
    (plain.props.accessibilityActions as Array<{ label: string }>).some(a =>
      a.label.startsWith('Open '),
    ),
  ).toBe(false);

  await ReactTestRenderer.act(() => {
    tree.unmount();
  });
});
