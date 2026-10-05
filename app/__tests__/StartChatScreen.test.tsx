/**
 * Start a chat: one smart field leads, Scan sits under it, and success leaves
 * one thing to do (build 33; the scanner-first layout before it).
 *
 *  - The field that understands an ID, a username or an email is the first
 *    control; Scan their QR code sits under it behind an "or" rule, the photo
 *    link under that, then the ⓘ, then My ID — collapsed. No button shows
 *    until there is something a press can act on.
 *  - On success the field and the rails give way to the naming step, so
 *    there is nothing left above it to re-submit.
 *
 * Harness follows StartChat.field.test.tsx: the fake op-sqlite stub records
 * every write, so a chat that was started exactly once is provable. */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import * as db from '../src/db';
import { StartChatScreen } from '../src/screens/StartChatScreen';

jest.mock('react-native-image-picker', () => ({
  launchImageLibrary: jest.fn(),
  launchCamera: jest.fn(),
}));

const sqlite = (
  jest.requireMock('@op-engineering/op-sqlite') as {
    __sqlite: {
      reset: () => void;
      instances: Map<string, { execute: jest.Mock }>;
    };
  }
).__sqlite;

const PROFILE: db.ProfileRow = {
  userId: '01KYDBSSDJSPC9J0E5N2AWMJ5Y',
  registrationId: 7,
  displayName: '',
  about: '',
  avatarB64: '',
  profileVersion: 0,
};

const PEER_ID = '01BX5ZZKBKACTAV9WEVGEMMVRZ';

/** Every `INSERT INTO chats` the screen has actually issued. */
function chatWrites(): string[] {
  const out: string[] = [];
  for (const inst of sqlite.instances.values()) {
    for (const call of inst.execute.mock.calls) {
      const sql = String(call[0]);
      if (sql.includes('INSERT INTO chats')) out.push(sql);
    }
  }
  return out;
}

beforeEach(async () => {
  await db.close();
  sqlite.reset();
  db.setWorkspace('real');
  await db.initDb();
});

afterEach(async () => {
  jest.restoreAllMocks();
  await db.close();
});

async function render(): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <StartChatScreen
        profile={PROFILE}
        onBack={jest.fn()}
        onOpenChat={jest.fn()}
        onOpenAccountEmail={jest.fn()}
      />,
    );
  });
  await ReactTestRenderer.act(async () => {});
  return tree;
}

/** Host nodes only — a testID on a composite also lands on the host it renders. */
function hosts(tree: ReactTestRenderer.ReactTestRenderer, id: string) {
  return tree.root.findAll(
    n => n.props.testID === id && typeof n.type === 'string',
  );
}

function has(tree: ReactTestRenderer.ReactTestRenderer, id: string): boolean {
  return hosts(tree, id).length > 0;
}

/** The control itself: a Pressable's host View carries no `onPress`. */
function control(tree: ReactTestRenderer.ReactTestRenderer, id: string) {
  return tree.root.findAll(
    n => n.props.testID === id && typeof n.props.onPress === 'function',
  )[0]!;
}

async function press(tree: ReactTestRenderer.ReactTestRenderer, id: string) {
  await ReactTestRenderer.act(async () => {
    control(tree, id).props.onPress();
  });
}

async function type(tree: ReactTestRenderer.ReactTestRenderer, text: string) {
  await ReactTestRenderer.act(async () => {
    tree.root
      .findAll(
        n =>
          n.props.testID === 'new-peer-input' &&
          typeof n.props.onChangeText === 'function',
      )[0]!
      .props.onChangeText(text);
  });
}

/** The page's controls in the order they are laid out. */
function order(tree: ReactTestRenderer.ReactTestRenderer, ids: string[]) {
  return tree.root
    .findAll(n => typeof n.type === 'string' && ids.includes(n.props.testID))
    .map(n => n.props.testID as string);
}

async function unmount(tree: ReactTestRenderer.ReactTestRenderer) {
  await ReactTestRenderer.act(() => {
    tree.unmount();
  });
}

// Rewritten for build 33: one smart field leads, no button shows until
// there is something to act on, and the find door is gone (find runs
// inline from the same field).
test('one smart field leads; then Scan, the photo link, the ⓘ and the collapsed My ID — and no button while empty', async () => {
  const tree = await render();
  expect(
    order(tree, [
      'new-peer-input',
      'scan-qr-camera',
      'scan-qr-photo',
      'start-chat-info',
      'show-self-id',
    ]),
  ).toEqual([
    'new-peer-input',
    'scan-qr-camera',
    'scan-qr-photo',
    'start-chat-info',
    'show-self-id',
  ]);
  expect(has(tree, 'start-chat')).toBe(false);
  expect(has(tree, 'discovery-search')).toBe(false);
  expect(has(tree, 'find-by-email')).toBe(false);
  await unmount(tree);
});

// Rewritten for build 33: one disclosure for the ID and the QR, so
// `show-self-qr` is gone and the QR image joins the list once it is open.
test('your own ID waits behind My ID, and the door says which way it is', async () => {
  const tree = await render();
  for (const id of ['self-user-id', 'copy-self-id', 'share-self-id', 'self-qr-image']) {
    expect(has(tree, id)).toBe(false);
  }
  expect(control(tree, 'show-self-id').props.accessibilityState.expanded).toBe(false);

  await press(tree, 'show-self-id');
  for (const id of ['self-user-id', 'copy-self-id', 'share-self-id', 'self-qr-image']) {
    expect(has(tree, id)).toBe(true);
  }
  expect(control(tree, 'show-self-id').props.accessibilityState.expanded).toBe(true);

  await press(tree, 'show-self-id');
  expect(has(tree, 'self-user-id')).toBe(false);
  expect(has(tree, 'self-qr-image')).toBe(false);
  await unmount(tree);
});

test('on success the field and the rails give way to the naming step — nothing left to re-submit', async () => {
  const tree = await render();
  await type(tree, PEER_ID);
  await press(tree, 'start-chat');
  await ReactTestRenderer.act(async () => {});
  expect(chatWrites().length).toBe(1);

  // One thing to do: name them.
  expect(has(tree, 'peer-nickname-input')).toBe(true);
  expect(has(tree, 'peer-nickname-save')).toBe(true);
  // And nothing above it that could start the same chat again. (The list
  // moved with build 33: the find door is gone, Find and the ⓘ joined it.)
  for (const id of [
    'new-peer-input',
    'start-chat',
    'discovery-search',
    'scan-qr-camera',
    'scan-qr-photo',
    'start-chat-info',
    'show-self-id',
  ]) {
    expect(has(tree, id)).toBe(false);
  }
  await unmount(tree);
});
