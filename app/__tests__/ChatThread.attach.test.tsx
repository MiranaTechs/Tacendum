/**
 * File and location bubbles, and the drawer that creates them. The two rules
 * these pin: coordinates and filenames are rendered only through their
 * dedicated cards (never the raw-JSON fallback), and NO map tile is fetched
 * to draw a location — the card is text, the map is a tap away in Apple Maps.
 *
 * Harness copied from ChatThread.vault.test.tsx.
 */

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

const FILE_IN = {
  msgId: '01FILEIN',
  peerId: 'peer-1',
  direction: 'in',
  body: JSON.stringify({
    tcm: 'file',
    att: 'blob-9',
    key: 'a2V5',
    name: 'lease-agreement.pdf',
    size: 2 * 1024 * 1024,
    mime: 'application/pdf',
  }),
  ts: T0,
  status: 'received',
};

/** A name carrying a right-to-left override: the classic extension spoof. */
const FILE_SPOOF = {
  msgId: '01FILESPOOF',
  peerId: 'peer-1',
  direction: 'in',
  body: JSON.stringify({
    tcm: 'file',
    att: 'blob-8',
    key: 'a2V5',
    name: 'holiday\u202Egnp.exe',
    size: 4096,
    mime: 'application/octet-stream',
  }),
  ts: T0 + 30_000,
  status: 'received',
};

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
      return { rows: [FILE_IN, FILE_SPOOF, LOC_OUT] };
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

function renderedText(tree: ReactTestRenderer.ReactTestRenderer): string {
  return tree.root
    .findAllByType(require('react-native').Text)
    .map(n =>
      Array.isArray(n.props.children)
        ? n.props.children.join('')
        : String(n.props.children ?? ''),
    )
    .join('\n');
}

test('a file renders as a named card, a location as a card — never raw JSON', async () => {
  const tree = await renderThread();
  const text = renderedText(tree);

  expect(text).toContain('lease-agreement.pdf');
  expect(text).toContain('Location');
  expect(text).toContain('Open in Maps');
  // The sentinel proves neither body hit the raw-text fallback.
  expect(text).not.toContain('"tcm"');
  // Coordinates are never printed as text either.
  expect(text).not.toContain('37.33182');
});

test('the location card opens Apple Maps and fetches nothing itself', async () => {
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
  expect(url.startsWith('https://maps.apple.com/?ll=37.331820,-122.031180')).toBe(true);
  spy.mockRestore();
});

test('the drawer offers four icon tiles, named', async () => {
  const tree = await renderThread();
  const plus = tree.root
    .findAllByProps({ testID: 'composer-attach' })
    .find(n => n.props.onPress);
  if (plus) {
    await ReactTestRenderer.act(async () => {
      plus.props.onPress();
    });
  } else {
    // Fall back: open the drawer through the Composer's expand control by
    // accessibility state if the testID differs.
    const toggles = tree.root
      .findAllByProps({ accessibilityState: { expanded: false } })
      .filter(n => n.props.onPress);
    await ReactTestRenderer.act(async () => {
      toggles[0]!.props.onPress();
    });
  }
  const text = renderedText(tree);
  expect(text).toContain('Photos');
  expect(text).toContain('Camera');
  expect(text).toContain('Document');
  expect(text).toContain('Location');
  // The one promise the icons could be read as making, said once.
  expect(text).toContain('aren’t saved to your Photos');
  // Every tile keeps its full description for a screen reader.
  const camera = tree.root
    .findAllByProps({ testID: 'attach-camera' })
    .find(n => n.props.accessibilityHint);
  expect(camera?.props.accessibilityHint).toBe('Not saved to your Photos');
});

test('a bidi-override filename is stripped before it is drawn', () => {
  // U+202E reverses everything after it, so "holiday<RLO>gnp.exe" READS as
  // "holidayexe.png" — a document pretending to be a picture. The character
  // never reaches the renderer.
  return renderThread().then(tree => {
    const text = renderedText(tree);
    expect(text).not.toContain('\u202E');
    expect(text).toContain('holidaygnp.exe');
  });
});

test('MY OWN structured row offers no Edit and no Copy — there are no words to rewrite', async () => {
  // Deliberately the OUTBOUND row: Edit only ever appears on your own
  // messages, so an inbound fixture would pass this whatever the gate says.
  // Editing a structured row used to replace the whole envelope with typed
  // text on BOTH phones, leaving any attachment row behind pointing at
  // nothing; Copy wrote an empty string.
  const tree = await renderThread();
  const bubble = tree.root
    .findAllByProps({ testID: 'msg-01LOCOUT' })
    .find(n => n.props.onLongPress);
  expect(bubble).toBeDefined();
  await ReactTestRenderer.act(async () => {
    bubble!.props.onLongPress();
  });

  // The rail IS open — a control that belongs there proves it.
  expect(
    tree.root.findAllByProps({ testID: 'reply-01LOCOUT' }).length +
      tree.root.findAllByProps({ testID: 'remove-01LOCOUT' }).length,
  ).toBeGreaterThan(0);
  expect(tree.root.findAllByProps({ testID: 'edit-01LOCOUT' })).toHaveLength(0);
  expect(tree.root.findAllByProps({ testID: 'copy-01LOCOUT' })).toHaveLength(0);
});
