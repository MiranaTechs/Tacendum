/**
 * What edit / retract / reply look like in the room: an edited message says
 * so, a retracted one leaves a mark instead of a hole, and a reply shows what
 * it answers. The rail only offers what authorship allows.
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { Text } from 'react-native';
import * as db from '../src/db';
import { ChatThreadScreen } from '../src/screens/ChatThreadScreen';

interface FakeDb {
  name: string;
  execute: jest.Mock;
  close: jest.Mock;
}
const sqlite = (
  jest.requireMock('@op-engineering/op-sqlite') as {
    __sqlite: {
      instances: Map<string, FakeDb>;
      reset: () => void;
    };
  }
).__sqlite;

const T0 = new Date('2026-07-25T12:00:00').getTime();

const THEIRS = {
  msgId: '01THEIRS',
  peerId: 'peer-1',
  direction: 'in',
  body: 'dinner at eight?',
  ts: T0,
  status: 'received',
  editedAt: null,
  deletedAt: null,
};
const MINE_EDITED = {
  msgId: '01MINE',
  peerId: 'peer-1',
  direction: 'out',
  body: 'make it nine',
  ts: T0 + 60_000,
  status: 'sent',
  editedAt: T0 + 120_000,
  deletedAt: null,
};
const MINE_GONE = {
  msgId: '01GONE',
  peerId: 'peer-1',
  direction: 'out',
  body: '',
  ts: T0 + 180_000,
  status: 'sent',
  editedAt: null,
  deletedAt: T0 + 200_000,
};
const REPLY = {
  msgId: '01REPLY',
  peerId: 'peer-1',
  direction: 'out',
  body: JSON.stringify({
    tcm: 'reply',
    ref: '01THEIRS',
    ofs: false,
    text: 'nine works',
  }),
  ts: T0 + 240_000,
  status: 'sent',
  editedAt: null,
  deletedAt: null,
};

// A message THEY retracted: exercises the inbound sentence. This peer has no
// name, so personRef falls back to the pronoun 'them'.
const THEIRS_GONE = {
  msgId: '01THEIRSGONE',
  peerId: 'peer-1',
  direction: 'in',
  body: '',
  ts: T0 + 420_000,
  status: 'received',
  editedAt: null,
  deletedAt: T0 + 430_000,
};
// The spoof: a peer claims (ofs:true) that MY '01MINE' row is their own
// message. msgIds are sender-chosen, so the collision is theirs to make.
const IN_SPOOF = {
  msgId: '01SPOOF',
  peerId: 'peer-1',
  direction: 'in',
  body: JSON.stringify({
    tcm: 'reply',
    ref: '01MINE',
    ofs: true,
    text: 'as I said',
  }),
  ts: T0 + 480_000,
  status: 'received',
  editedAt: null,
  deletedAt: null,
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
      return {
        rows: [THEIRS, MINE_EDITED, MINE_GONE, REPLY, THEIRS_GONE, IN_SPOOF],
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

function texts(tree: ReactTestRenderer.ReactTestRenderer): string[] {
  return tree.root
    .findAllByType(Text)
    .map(n =>
      Array.isArray(n.props.children)
        ? n.props.children.join('')
        : String(n.props.children ?? ''),
    );
}

function byId(tree: ReactTestRenderer.ReactTestRenderer, id: string) {
  return tree.root.findAll(n => n.props.testID === id);
}

async function openRail(
  tree: ReactTestRenderer.ReactTestRenderer,
  msgId: string,
): Promise<void> {
  await ReactTestRenderer.act(async () => {
    byId(tree, `msg-${msgId}`)[0].props.onLongPress();
  });
}

test('an edited message says so; an untouched one does not', async () => {
  const tree = await renderThread();
  expect(texts(tree).some(s => s.includes('Edited'))).toBe(true);
  // The marker belongs to the edited row only.
  expect(texts(tree).filter(s => s.includes('Edited')).length).toBe(1);
  await ReactTestRenderer.act(() => tree.unmount());
});

test('a retracted message leaves a mark, never a hole, and never its words', async () => {
  const tree = await renderThread();
  expect(byId(tree, 'tombstone-01GONE').length).toBeGreaterThan(0);
  expect(texts(tree).some(s => /deleted/i.test(s))).toBe(true);
  await ReactTestRenderer.act(() => tree.unmount());
});

test('a reply shows the words it answers, and never its own envelope JSON', async () => {
  const tree = await renderThread();
  const all = texts(tree);
  expect(all.some(s => s === 'nine works')).toBe(true);
  expect(byId(tree, 'quote-01REPLY').length).toBeGreaterThan(0);
  // The quoted original is visible above the answer.
  expect(all.some(s => s.includes('dinner at eight?'))).toBe(true);
  expect(all.some(s => s.includes('{"tcm"'))).toBe(false);
  await ReactTestRenderer.act(() => tree.unmount());
});

test('a reply never leaks its envelope to VoiceOver or the clipboard', async () => {
  const Clipboard = require('react-native').Clipboard;
  const setString = jest.spyOn(Clipboard, 'setString').mockImplementation(() => {});
  const tree = await renderThread();

  // The bubble's spoken label is built from the body; for a reply the body IS
  // the envelope, so a raw interpolation reads JSON aloud.
  const labels = tree.root
    .findAll(n => typeof n.props.accessibilityLabel === 'string')
    .map(n => n.props.accessibilityLabel as string);
  expect(labels.some(l => l.includes('{"tcm"'))).toBe(false);
  expect(labels.some(l => l.includes('nine works'))).toBe(true);

  await openRail(tree, '01REPLY');
  await ReactTestRenderer.act(async () => {
    byId(tree, 'copy-01REPLY')[0].props.onPress();
  });
  expect(setString).toHaveBeenCalledWith('nine works');

  setString.mockRestore();
  await ReactTestRenderer.act(() => tree.unmount());
});

test('editing a reply starts from its words, not its envelope', async () => {
  const tree = await renderThread();
  await openRail(tree, '01REPLY');
  await ReactTestRenderer.act(async () => {
    byId(tree, 'edit-01REPLY')[0].props.onPress();
  });
  expect(byId(tree, 'composer-input')[0].props.value).toBe('nine works');
  await ReactTestRenderer.act(() => tree.unmount());
});

test('a tombstone is transparent to grouping and grammatical for anyone', async () => {
  const tree = await renderThread();
  const all = texts(tree);
  // personRef's unnamed fallback is 'them' — sentence-initial it must become
  // 'They', the same guard the screenshot notice needed.
  expect(all.some(s => /^them /.test(s))).toBe(false);
  // The message before a tombstone keeps its own clock: a retraction prints
  // no time of its own, so swallowing its neighbour's leaves a run unstamped.
  expect(all.some(s => /^\d{1,2}:\d{2}/.test(s))).toBe(true);
  await ReactTestRenderer.act(() => tree.unmount());
});

function quoteText(
  tree: ReactTestRenderer.ReactTestRenderer,
  msgId: string,
): string {
  const box = byId(tree, `quote-${msgId}`)[0];
  const node = box.findAllByType(Text)[0];
  return Array.isArray(node.props.children)
    ? node.props.children.join('')
    : String(node.props.children ?? '');
}

test('a quote resolves to the message it answers, in the quote box itself', async () => {
  const tree = await renderThread();
  expect(quoteText(tree, '01REPLY')).toBe('dinner at eight?');
  await ReactTestRenderer.act(() => tree.unmount());
});

test('a peer cannot point at my row and have my words read as theirs', async () => {
  const tree = await renderThread();
  // They claimed '01MINE' was their own. There is no such 'in' row, so the
  // quote degrades — it must never surface MY message as what they wrote.
  expect(quoteText(tree, '01SPOOF')).not.toBe('make it nine');
  await ReactTestRenderer.act(() => tree.unmount());
});

test('the rail offers Edit only on my own words', async () => {
  const tree = await renderThread();

  await openRail(tree, '01MINE');
  expect(byId(tree, 'edit-01MINE').length).toBeGreaterThan(0);
  expect(byId(tree, 'reply-01MINE').length).toBeGreaterThan(0);

  await openRail(tree, '01THEIRS');
  expect(byId(tree, 'edit-01THEIRS').length).toBe(0);
  expect(byId(tree, 'reply-01THEIRS').length).toBeGreaterThan(0);

  await ReactTestRenderer.act(() => tree.unmount());
});

test('deleting my own message offers both sides; theirs offers only mine', async () => {
  const tree = await renderThread();

  await openRail(tree, '01MINE');
  await ReactTestRenderer.act(async () => {
    byId(tree, 'delete-01MINE')[0].props.onPress();
  });
  expect(byId(tree, 'delete-everyone-01MINE').length).toBeGreaterThan(0);
  expect(byId(tree, 'delete-mine-01MINE').length).toBeGreaterThan(0);

  await openRail(tree, '01THEIRS');
  await ReactTestRenderer.act(async () => {
    byId(tree, 'delete-01THEIRS')[0].props.onPress();
  });
  // Nothing I can retract on their phone — their words are theirs.
  expect(byId(tree, 'delete-everyone-01THEIRS').length).toBe(0);
  expect(byId(tree, 'delete-mine-01THEIRS').length).toBeGreaterThan(0);

  await ReactTestRenderer.act(() => tree.unmount());
});

test('choosing Edit arms the composer with the original words', async () => {
  const tree = await renderThread();
  await openRail(tree, '01MINE');
  await ReactTestRenderer.act(async () => {
    byId(tree, 'edit-01MINE')[0].props.onPress();
  });
  expect(byId(tree, 'composer-chip').length).toBeGreaterThan(0);
  expect(byId(tree, 'composer-input')[0].props.value).toBe('make it nine');
  await ReactTestRenderer.act(() => tree.unmount());
});

test('an edit never eats what you were already writing', async () => {
  const tree = await renderThread();
  await ReactTestRenderer.act(async () => {
    byId(tree, 'composer-input')[0].props.onChangeText('half a thought');
  });

  await openRail(tree, '01MINE');
  await ReactTestRenderer.act(async () => {
    byId(tree, 'edit-01MINE')[0].props.onPress();
  });
  expect(byId(tree, 'composer-input')[0].props.value).toBe('make it nine');

  // Backing out returns the words that were there — an edit borrows the
  // composer, it does not empty it.
  await ReactTestRenderer.act(async () => {
    byId(tree, 'composer-chip-cancel')[0].props.onPress();
  });
  expect(byId(tree, 'composer-input')[0].props.value).toBe('half a thought');

  await ReactTestRenderer.act(() => tree.unmount());
});

test('leaving mid-edit never strands the old message as a draft', async () => {
  const tree = await renderThread();
  await openRail(tree, '01MINE');
  await ReactTestRenderer.act(async () => {
    byId(tree, 'edit-01MINE')[0].props.onPress();
  });

  // Unmount while the composer still holds the message being rewritten.
  await ReactTestRenderer.act(() => tree.unmount());
  await ReactTestRenderer.act(async () => {});

  const instance = sqlite.instances.get('tacendum.sqlite')!;
  const draftWrites = instance.execute.mock.calls.filter(c =>
    String(c[0]).includes('INTO drafts'),
  );
  // The message's own words must never be persisted as something you were
  // writing — they would come back later looking like a new message.
  expect(
    draftWrites.some(c => String(c[1]).includes('make it nine')),
  ).toBe(false);
});

test('choosing Reply arms the composer without touching the draft', async () => {
  const tree = await renderThread();
  await openRail(tree, '01THEIRS');
  await ReactTestRenderer.act(async () => {
    byId(tree, 'reply-01THEIRS')[0].props.onPress();
  });
  expect(byId(tree, 'composer-chip').length).toBeGreaterThan(0);
  expect(byId(tree, 'composer-input')[0].props.value).toBe('');
  await ReactTestRenderer.act(() => tree.unmount());
});
