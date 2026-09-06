/**
 * STARTING A CHAT YOU ALREADY HAVE OPENS IT.
 *
 * The scanner's most likely repeat use is scanning a friend again — at a
 * party, on a second device, because someone asked. Until build 27 that path
 * upserted the row it already had and then asked "Who is this?" with an empty
 * field, about someone named months ago. `saveName` only writes a non-empty
 * field, so nothing was clobbered; the QUESTION was wrong, and a question
 * nobody can answer usefully is the same defect as a control that does
 * nothing.
 *
 * The second half is not cosmetic. A room's conversation row IS its ULID
 * (`pushnav.ts`), so typing or scanning a room id used to `upsertChat` a
 * PERSON-shaped row over a room — the shape `ChatListScreen` already routes
 * around when it deletes, because it "would strand queued fan-out legs".
 *
 * Harness: the real `db` over the recorded op-sqlite fake (so an INSERT is
 * evidence and its absence is evidence too), with the two READS this feature
 * turns on stubbed, because the fake answers every SELECT with no rows.
 */

jest.mock('react-native-image-picker', () => ({
  launchImageLibrary: jest.fn(),
  launchCamera: jest.fn(),
}));

jest.mock('../src/db', () => {
  const actual = jest.requireActual('../src/db');
  return {
    ...actual,
    getChat: jest.fn(async () => null),
    getGroup: jest.fn(async () => null),
  };
});

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import * as db from '../src/db';
import { StartChatScreen } from '../src/screens/StartChatScreen';

const dbMock = db as unknown as {
  getChat: jest.Mock;
  getGroup: jest.Mock;
};

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
const ROOM_ID = '01JQZ8N4H3KDEKTSV4RRFFQ69G';

/** Every `INSERT INTO chats` the screen issued — the only honest evidence of
 * a write, because the fake answers every SELECT with no rows. Statement and
 * parameters both, because on this path what the write CANNOT do (restate an
 * origin, rename a row) is the property under test. */
function chatWrites(): { sql: string; params: unknown[] }[] {
  const writes: { sql: string; params: unknown[] }[] = [];
  for (const inst of sqlite.instances.values()) {
    for (const call of inst.execute.mock.calls) {
      const sql = String(call[0]);
      if (sql.includes('INSERT INTO chats')) {
        writes.push({ sql, params: (call[1] ?? []) as unknown[] });
      }
    }
  }
  return writes;
}

function chatInserts(): number {
  return chatWrites().length;
}

beforeEach(async () => {
  await db.close();
  sqlite.reset();
  db.setWorkspace('real');
  await db.initDb();
  dbMock.getChat.mockReset().mockResolvedValue(null);
  dbMock.getGroup.mockReset().mockResolvedValue(null);
});

afterEach(async () => {
  await db.close();
});

async function render(
  onOpenChat: jest.Mock,
): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <StartChatScreen
        profile={PROFILE}
        onBack={jest.fn()}
        onOpenChat={onOpenChat}
        onFindByEmail={jest.fn()}
      />,
    );
  });
  await ReactTestRenderer.act(async () => {});
  return tree;
}

function byId(tree: ReactTestRenderer.ReactTestRenderer, id: string) {
  return tree.root.findAll(
    n => n.props.testID === id && typeof n.type === 'string',
  );
}

function control(tree: ReactTestRenderer.ReactTestRenderer, id: string) {
  return tree.root.find(
    n => n.props.testID === id && typeof n.props.onPress === 'function',
  );
}

/** Type an id and press the button — the whole commit path. */
async function start(
  tree: ReactTestRenderer.ReactTestRenderer,
  id: string,
): Promise<void> {
  await ReactTestRenderer.act(async () => {
    byId(tree, 'new-peer-input')[0]!.props.onChangeText(id);
  });
  await ReactTestRenderer.act(async () => {
    control(tree, 'start-chat').props.onPress();
  });
  await ReactTestRenderer.act(async () => {});
}

async function unmount(tree: ReactTestRenderer.ReactTestRenderer) {
  await ReactTestRenderer.act(() => {
    tree.unmount();
  });
}

/** The naming takeover is on screen. */
function asking(tree: ReactTestRenderer.ReactTestRenderer): boolean {
  return byId(tree, 'peer-nickname-input').length > 0;
}

test('a friend you have already named opens straight into the chat', async () => {
  dbMock.getChat.mockResolvedValue({
    peerId: PEER_ID,
    localName: 'Mum',
    displayName: null,
  });
  const onOpenChat = jest.fn();
  const tree = await render(onOpenChat);

  await start(tree, PEER_ID);

  expect(onOpenChat).toHaveBeenCalledWith(PEER_ID);
  expect(asking(tree)).toBe(false);
  await unmount(tree);
});

test('scanning a named friend still fills in a provenance mark the row never had', async () => {
  // The row an INBOUND message opened carries introducedBy NULL, and so does
  // one that predates the column. `db.upsertChat` documents the fill-in as
  // deliberate — it "fills in only where nothing was recorded" — and this is
  // now the one path that can perform it for those rows, because the peer
  // profile has started SAYING how a chat began.
  dbMock.getChat.mockResolvedValue({
    peerId: PEER_ID,
    localName: 'Mum',
    displayName: null,
    introducedBy: null,
  });
  const tree = await render(jest.fn());

  await start(tree, PEER_ID);

  const writes = chatWrites();
  expect(writes.length).toBe(1);
  // The typed path's own mark, handed to the upsert.
  expect(writes[0]!.params[3]).toBe('manual');
  // And what the write must NOT do. No display name is offered, so the row's
  // own name cannot be touched; and the statement COALESCEs the column the
  // other way round, so a chat that already recorded an origin keeps it —
  // a re-scan can fill a hole, never restate a beginning.
  expect(writes[0]!.params[1]).toBeNull();
  expect(writes[0]!.sql).toContain(
    'introducedBy = COALESCE(chats.introducedBy, excluded.introducedBy)',
  );
  await unmount(tree);
});

test('a chat that exists without a name still asks, prefilled with the name they shared', async () => {
  dbMock.getChat.mockResolvedValue({
    peerId: PEER_ID,
    localName: null,
    displayName: 'Sam',
  });
  const onOpenChat = jest.fn();
  const tree = await render(onOpenChat);

  await start(tree, PEER_ID);

  // This is the case where asking HELPS: the row has no name of my own on it.
  expect(asking(tree)).toBe(true);
  expect(byId(tree, 'peer-nickname-input')[0]!.props.value).toBe('Sam');
  expect(onOpenChat).not.toHaveBeenCalled();
  await unmount(tree);
});

test('a chat with neither name asks with an empty field, exactly as before', async () => {
  dbMock.getChat.mockResolvedValue({
    peerId: PEER_ID,
    localName: null,
    displayName: null,
  });
  const tree = await render(jest.fn());

  await start(tree, PEER_ID);

  expect(asking(tree)).toBe(true);
  expect(byId(tree, 'peer-nickname-input')[0]!.props.value).toBe('');
  await unmount(tree);
});

test('a room ULID opens the room and never writes a person-shaped row over it', async () => {
  dbMock.getGroup.mockResolvedValue({
    groupId: ROOM_ID,
    ownerId: PROFILE.userId,
    name: 'Kitchen',
  });
  const onOpenChat = jest.fn();
  const tree = await render(onOpenChat);

  await start(tree, ROOM_ID);

  expect(onOpenChat).toHaveBeenCalledWith(ROOM_ID);
  expect(asking(tree)).toBe(false);
  // THE POINT: a room's row is its ULID, and a person-shaped row landing on
  // top of one is what strands queued fan-out legs.
  expect(chatInserts()).toBe(0);
  // A room is a room before it is a chat: the room read decides alone.
  expect(dbMock.getGroup).toHaveBeenCalledWith(ROOM_ID);
  await unmount(tree);
});

test('someone new is still a new chat: the row is written and the name is asked for', async () => {
  const onOpenChat = jest.fn();
  const tree = await render(onOpenChat);

  await start(tree, PEER_ID);

  expect(chatInserts()).toBe(1);
  expect(asking(tree)).toBe(true);
  expect(onOpenChat).not.toHaveBeenCalled();
  await unmount(tree);
});
