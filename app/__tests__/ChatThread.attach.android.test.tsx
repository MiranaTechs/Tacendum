/**
 * The location card under the REAL Android Platform.
 *
 * ChatThread.attach.test.tsx pins the iOS behaviour: the card opens
 * `https://maps.apple.com/?ll=…` and fetches nothing itself. On Android that
 * URL would open a BROWSER — and the request would tell Apple's server where
 * your contact is — so the Android branch composes a `geo:` URI instead and
 * hands it to whatever maps app the phone has. This suite pins that branch
 * with the same harness (copied from ChatThread.attach.test.tsx, which copied
 * it from ChatThread.vault.test.tsx).
 */

jest.mock('react-native/Libraries/Utilities/Platform', () => ({
  __esModule: true,
  default: {
    OS: 'android',
    select: (spec: Record<string, unknown>) =>
      'android' in spec
        ? spec.android
        : 'native' in spec
          ? spec.native
          : spec.default,
    Version: 35,
    isTesting: true,
  },
}));

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

const T0 = new Date('2026-07-25T12:00:00').getTime();

const LOC_OUT = {
  msgId: '01LOCOUT',
  peerId: 'peer-1',
  direction: 'out',
  body: JSON.stringify({ tcm: 'loc', lat: 37.33182, lng: -122.03118 }),
  ts: T0 + 60_000,
  status: 'sent',
};

beforeEach(async () => {
  await db.close();
  sqlite.reset();
  db.setWorkspace('real');
  await db.initDb();
  const instance = sqlite.instances.get('tacendum.sqlite')!;
  const base = instance.execute.getMockImplementation()!;
  instance.execute.mockImplementation(async (sql: string, params?: unknown) => {
    if (String(sql).includes('FROM messages')) {
      return { rows: [LOC_OUT] };
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

test('the location card opens a geo: URI — no Apple host, no browser, no tile fetch', async () => {
  const { Linking } = require('react-native');
  const spy = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
  const tree = await renderThread();

  const card = tree.root
    .findAllByProps({ accessibilityLabel: 'Shared location, opens in Maps' })
    .find(n => n.props.onPress);
  expect(card).toBeDefined();
  await ReactTestRenderer.act(async () => {
    card!.props.onPress();
  });

  expect(spy).toHaveBeenCalledTimes(1);
  const url = spy.mock.calls[0]![0] as string;
  // The exact composition: coordinates twice (point and query), the label
  // URL-encoded, and NOTHING resembling a web URL.
  expect(url).toBe(
    'geo:37.331820,-122.031180?q=37.331820,-122.031180(Shared%20location)',
  );
  expect(url).not.toContain('maps.apple.com');
  expect(url.startsWith('http')).toBe(false);
  spy.mockRestore();
});
