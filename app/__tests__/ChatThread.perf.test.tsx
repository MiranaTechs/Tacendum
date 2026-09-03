/**
 * Each message envelope is parsed ONCE per data change (the parse-once
 * slice).
 *
 * THE DEFECT THIS FILE EXISTS FOR. The thread parsed every row's body three
 * times over on each requery — in the grouping pass, in the quote resolver,
 * and again inside every mounted row — and a thread requeries on every
 * receipt, reaction and download tick. The parsed envelope now rides on the
 * list item, keyed by the row's identity and body, so an unchanged row is
 * never parsed again.
 *
 * Counted through the module export the screen calls: envelope.ts's own
 * internal parses (isCarrierEnvelope, displayText) are not this seam and are
 * not counted — only what the SCREEN asks for.
 *
 * Harness copied from ChatThread.timer.test.tsx. */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import * as db from '../src/db';
import * as envelope from '../src/envelope';
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

const T0 = new Date('2026-09-02T12:00:00').getTime();

const TEXT_IN = {
  msgId: '01TEXTIN',
  peerId: 'peer-1',
  direction: 'in',
  body: 'see the garden',
  ts: T0,
  status: 'received',
};
const TEXT_OUT = {
  msgId: '01TEXTOUT',
  peerId: 'peer-1',
  direction: 'out',
  body: 'which garden?',
  ts: T0 + 60_000,
  status: 'sent',
};
/** Answers TEXT_OUT — the quote resolver's parse. */
const REPLY_IN = {
  msgId: '01REPLYIN',
  peerId: 'peer-1',
  direction: 'in',
  body: JSON.stringify({ tcm: 'reply', ref: '01TEXTOUT', ofs: false, text: 'the one by the river' }),
  ts: T0 + 120_000,
  status: 'received',
};
const VOICE_IN = {
  msgId: '01VOICEIN',
  peerId: 'peer-1',
  direction: 'in',
  body: JSON.stringify({ tcm: 'voice', att: 'blob-7', key: 'a2V5', dur: 95 }),
  ts: T0 + 180_000,
  status: 'received',
};
const ROWS = [TEXT_IN, TEXT_OUT, REPLY_IN, VOICE_IN];

beforeEach(async () => {
  await db.close();
  sqlite.reset();
  db.setWorkspace('real');
  await db.initDb();
  const instance = sqlite.instances.get('tacendum.sqlite')!;
  const base = instance.execute.getMockImplementation()!;
  instance.execute.mockImplementation(async (sql: string, params?: unknown) => {
    if (String(sql).includes('FROM messages')) {
      // Fresh objects every time, as the real store returns them.
      return { rows: ROWS.map(r => ({ ...r })) };
    }
    return base(sql, params);
  });
});

afterEach(async () => {
  jest.restoreAllMocks();
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

/** The screen's parses of the fixture bodies — the seam under test. */
function fixtureParses(parse: jest.SpyInstance): number {
  const bodies = new Set(ROWS.map(r => r.body));
  return parse.mock.calls.filter(([body]) => bodies.has(body as string)).length;
}

test('one mount parses each row once, quote and bubble included', async () => {
  const parse = jest.spyOn(envelope, 'parseEnvelope');
  const tree = await renderThread();
  // Everything is on glass — the parses below were not skipped by skipping
  // the rows.
  for (const r of ROWS) {
    expect(tree.root.findAllByProps({ testID: `msg-${r.msgId}` }).length).toBeGreaterThan(0);
  }
  expect(tree.root.findAllByProps({ testID: 'quote-01REPLYIN' }).length).toBeGreaterThan(0);

  expect(fixtureParses(parse)).toBe(ROWS.length);

  await ReactTestRenderer.act(() => {
    tree.unmount();
  });
});

test('a requery that changes nothing parses nothing', async () => {
  // The screen's change subscription, captured so the test can signal it
  // (the ChatThread.scrollpin.test.tsx seam).
  const changeListeners: Array<() => void> = [];
  jest.spyOn(messaging, 'subscribe').mockImplementation(cb => {
    changeListeners.push(cb);
    return () => {};
  });
  const parse = jest.spyOn(envelope, 'parseEnvelope');
  const tree = await renderThread();
  const after = fixtureParses(parse);
  expect(changeListeners.length).toBeGreaterThan(0);

  // The store signals (a receipt, a reaction, a download): the thread
  // requeries and gets the same rows back as fresh objects.
  await ReactTestRenderer.act(async () => {
    for (const cb of changeListeners) cb();
  });
  await ReactTestRenderer.act(async () => {
    await new Promise<void>(resolve => setTimeout(() => resolve(), 120)); // past REFRESH_DEBOUNCE_MS
  });
  await ReactTestRenderer.act(async () => {});

  expect(fixtureParses(parse)).toBe(after);

  await ReactTestRenderer.act(() => {
    tree.unmount();
  });
});
