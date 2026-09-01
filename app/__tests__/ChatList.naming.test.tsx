/**
 * The one-time nudge for an EXISTING nameless account.
 *
 * An account registered before the naming moment existed never saw the
 * step, so the chat list's empty state asks once: "What should people call
 * you?" with an entry to the profile screen and a Not now. Either answer
 * settles it — durably, in the workspace's own profile kv — and it never
 * shows again. A named account, or one that already answered, sees nothing.
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import * as db from '../src/db';
import { NAMING_COPY } from '../src/namingCopy';
import { ChatListScreen } from '../src/screens/ChatListScreen';

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

const NAMELESS: db.ProfileRow = {
  userId: '01KYDBSSDJSPC9J0E5N2AWMJ5Y',
  registrationId: 7,
  displayName: '',
  about: '',
  avatarB64: '',
  profileVersion: 0,
};
const NAMED: db.ProfileRow = {
  ...NAMELESS,
  displayName: 'Ada',
  profileVersion: 5,
};

const PEER = '01SAMZ3NDEKTSV4RRFFQ69G5FA';
const T0 = new Date('2026-08-28T09:00:00').getTime();
/** One ordinary conversation, so the list is not empty. */
const CHAT = {
  peerId: PEER,
  displayName: 'Sam',
  lastMessageAt: T0,
  lastMessageText: 'see you',
  about: null,
  avatarB64: null,
  profileVersion: null,
  safetyCheckedAt: null,
  localName: null,
  createdAt: T0,
  lastOpenedAt: null,
  identityChangedAt: null,
  safetyMismatchAt: null,
};

/** The `profile` kv table answered from a map, so a remount sees the answer;
 * `chats` answered from the given rows, so the list can be non-empty. */
function fakeProfileKv(seed: Record<string, string>, chats: unknown[] = []) {
  const kv = new Map(Object.entries(seed));
  const file = sqlite.instances.get('tacendum.sqlite')!;
  const base = file.execute.getMockImplementation()!;
  file.execute.mockImplementation((sql: unknown, params?: unknown[]) => {
    const s = String(sql);
    const p = (params ?? []) as string[];
    if (s.includes('INSERT OR REPLACE INTO profile')) {
      kv.set(p[0]!, p[1]!);
      return { rows: [] };
    }
    if (s.includes('SELECT value FROM profile WHERE key = ?')) {
      const value = kv.get(p[0]!);
      return { rows: value === undefined ? [] : [{ value }] };
    }
    if (s.includes('FROM chats')) return { rows: chats };
    return base(sql, params);
  });
  return kv;
}

beforeEach(async () => {
  await db.close();
  sqlite.reset();
  db.setWorkspace('real');
  await db.initDb();
});

afterEach(async () => {
  await db.close();
});

async function render(
  profile: db.ProfileRow,
  onOpenProfile: jest.Mock = jest.fn(),
): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <ChatListScreen
        profile={profile}
        onOpenChat={jest.fn()}
        onOpenProfile={onOpenProfile}
        onStartChat={jest.fn()}
        onStartRoom={jest.fn()}
      />,
    );
  });
  await ReactTestRenderer.act(async () => {});
  return tree;
}

function byId(tree: ReactTestRenderer.ReactTestRenderer, id: string) {
  return tree.root.findAll(n => n.props.testID === id);
}

/** Every string on screen — the list's render props make toJSON circular. */
function visibleText(tree: ReactTestRenderer.ReactTestRenderer): string {
  return tree.root
    .findAll(n => typeof n.props.children === 'string')
    .map(n => n.props.children as string)
    .join('\n');
}

async function press(tree: ReactTestRenderer.ReactTestRenderer, id: string) {
  const node = byId(tree, id).find(n => n.props.onPress !== undefined);
  if (!node) throw new Error(`no pressable ${id}`);
  await ReactTestRenderer.act(async () => {
    node.props.onPress();
  });
}

async function unmount(tree: ReactTestRenderer.ReactTestRenderer) {
  await ReactTestRenderer.act(() => {
    tree.unmount();
  });
}

describe('the naming nudge in the empty state', () => {
  test('a nameless, unsettled account is asked once — with the teaching copy behind the ⓘ', async () => {
    fakeProfileKv({});
    const tree = await render(NAMELESS);
    expect(byId(tree, 'naming-nudge').length).toBeGreaterThan(0);
    const text = visibleText(tree);
    expect(text).toContain(NAMING_COPY.title);
    expect(text).toContain(NAMING_COPY.nudgeAdd);
    expect(text).toContain(NAMING_COPY.skip);
    expect(text).not.toContain(NAMING_COPY.infoLines[0]);
    await press(tree, 'naming-nudge-info');
    expect(visibleText(tree)).toContain(NAMING_COPY.infoLines[0]);
    await unmount(tree);
  });

  test('Not now settles it durably: gone now, and gone on the next mount', async () => {
    fakeProfileKv({});
    const tree = await render(NAMELESS);
    await press(tree, 'naming-nudge-skip');
    expect(byId(tree, 'naming-nudge').length).toBe(0);
    expect(await db.getNamingSettled()).toBe(true);
    await unmount(tree);

    const again = await render(NAMELESS);
    expect(byId(again, 'naming-nudge').length).toBe(0);
    await unmount(again);
  });

  test('Add a name is the profile-screen entry, and counts as the one showing', async () => {
    fakeProfileKv({});
    const onOpenProfile = jest.fn();
    const tree = await render(NAMELESS, onOpenProfile);
    await press(tree, 'naming-nudge-add');
    expect(onOpenProfile).toHaveBeenCalledTimes(1);
    expect(byId(tree, 'naming-nudge').length).toBe(0);
    expect(await db.getNamingSettled()).toBe(true);
    await unmount(tree);
  });

  test('a named account is never nudged', async () => {
    fakeProfileKv({});
    const tree = await render(NAMED);
    expect(byId(tree, 'naming-nudge').length).toBe(0);
    await unmount(tree);
  });

  test('an account that already answered is never nudged again', async () => {
    fakeProfileKv({ namingSettled: '1' });
    const tree = await render(NAMELESS);
    expect(byId(tree, 'naming-nudge').length).toBe(0);
    await unmount(tree);
  });
});

/**
 * The gap: the EXISTING nameless account — the population the
 * nudge exists for — already has conversations, so a nudge that lived only
 * in the empty state never reached it. It heads the list now.
 */
describe('the naming nudge heads a list that already has conversations', () => {
  test('a nameless, unsettled account WITH a chat is asked, beside its rows', async () => {
    fakeProfileKv({}, [CHAT]);
    const tree = await render(NAMELESS);
    expect(byId(tree, `chat-${PEER}`).length).toBeGreaterThan(0);
    expect(byId(tree, 'naming-nudge').length).toBeGreaterThan(0);
    const text = visibleText(tree);
    expect(text).toContain(NAMING_COPY.title);
    expect(text).toContain(NAMING_COPY.nudgeAdd);
    expect(text).toContain(NAMING_COPY.skip);
    await unmount(tree);
  });

  test('Not now settles it there too: gone now, gone on the next mount', async () => {
    fakeProfileKv({}, [CHAT]);
    const tree = await render(NAMELESS);
    await press(tree, 'naming-nudge-skip');
    expect(byId(tree, 'naming-nudge').length).toBe(0);
    expect(byId(tree, `chat-${PEER}`).length).toBeGreaterThan(0);
    expect(await db.getNamingSettled()).toBe(true);
    await unmount(tree);

    const again = await render(NAMELESS);
    expect(byId(again, 'naming-nudge').length).toBe(0);
    await unmount(again);
  });

  test('Add a name is the profile-screen entry there too, and counts as the one showing', async () => {
    fakeProfileKv({}, [CHAT]);
    const onOpenProfile = jest.fn();
    const tree = await render(NAMELESS, onOpenProfile);
    await press(tree, 'naming-nudge-add');
    expect(onOpenProfile).toHaveBeenCalledTimes(1);
    expect(byId(tree, 'naming-nudge').length).toBe(0);
    expect(await db.getNamingSettled()).toBe(true);
    await unmount(tree);
  });

  test('a named account with chats is never nudged', async () => {
    fakeProfileKv({}, [CHAT]);
    const tree = await render(NAMED);
    expect(byId(tree, `chat-${PEER}`).length).toBeGreaterThan(0);
    expect(byId(tree, 'naming-nudge').length).toBe(0);
    await unmount(tree);
  });
});
