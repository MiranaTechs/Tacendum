/**
 * Start a chat: the scanner leads, typing stays available, and success
 * leaves one thing to do.
 *
 *  - The QR hand-off is the lead rail (§4), so the scanner is the first
 *    thing on the page; the field — no longer focused on entry
 *    — is the second way in and says so; the find door follows; your own
 *    ID, which this screen is not about, waits behind "Show my ID".
 *  - On success the ID panel and the rails give way to the naming step, so
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
        onFindByEmail={jest.fn()}
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

test('the scanner leads; then the typed field, then the find door, then the collapsed own ID', async () => {
  const tree = await render();
  expect(
    order(tree, [
      'scan-qr-camera',
      'scan-qr-photo',
      'new-peer-input',
      'start-chat',
      'find-by-email',
      'show-self-id',
    ]),
  ).toEqual([
    'scan-qr-camera',
    'scan-qr-photo',
    'new-peer-input',
    'start-chat',
    'find-by-email',
    'show-self-id',
  ]);
  await unmount(tree);
});

test('your own ID waits behind "Show my ID", and the door says which way it is', async () => {
  const tree = await render();
  for (const id of ['self-user-id', 'copy-self-id', 'share-self-id', 'show-self-qr']) {
    expect(has(tree, id)).toBe(false);
  }
  expect(control(tree, 'show-self-id').props.accessibilityState.expanded).toBe(false);

  await press(tree, 'show-self-id');
  for (const id of ['self-user-id', 'copy-self-id', 'share-self-id', 'show-self-qr']) {
    expect(has(tree, id)).toBe(true);
  }
  expect(control(tree, 'show-self-id').props.accessibilityState.expanded).toBe(true);

  await press(tree, 'show-self-id');
  expect(has(tree, 'self-user-id')).toBe(false);
  await unmount(tree);
});

test('on success the ID panel and the rails give way to the naming step — nothing left to re-submit', async () => {
  const tree = await render();
  await type(tree, PEER_ID);
  await press(tree, 'start-chat');
  await ReactTestRenderer.act(async () => {});
  expect(chatWrites().length).toBe(1);

  // One thing to do: name them.
  expect(has(tree, 'peer-nickname-input')).toBe(true);
  expect(has(tree, 'peer-nickname-save')).toBe(true);
  // And nothing above it that could start the same chat again.
  for (const id of [
    'new-peer-input',
    'start-chat',
    'scan-qr-camera',
    'scan-qr-photo',
    'find-by-email',
    'show-self-id',
  ]) {
    expect(has(tree, id)).toBe(false);
  }
  await unmount(tree);
});
