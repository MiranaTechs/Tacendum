/**
 * Android's system back closes what is OPEN on the thread before it leaves
 * the thread.
 *
 * THE DEFECT THIS FILE EXISTS FOR. The router's own handler (`App.tsx`) pops
 * through `backDestination` on every press, and the thread had no say:
 * a person who had just opened the call picker, the safety panel, a reaction
 * rail, a drawer or a reply chip and pressed Back — the reflex that
 * dismisses an overlay on every Android app — was thrown out of the
 * conversation instead, with whatever they had started still armed on the
 * unmounted screen. The thread now subscribes AFTER the router — the router
 * subscribed once at app mount (`goBack` has no dependencies) and the thread
 * mounts in a later commit, and RN asks the most recent subscriber first —
 * closes the topmost thing and consumes the press; with nothing open it
 * yields, and the router pops exactly as before.
 *
 * The order pinned here, outermost first: call picker → safety panel →
 * reaction rail → attach/emoji drawer → composer chip. Each step is a test;
 * one test walks three of them stacked.
 *
 * The handler is CAPTURED, not fired through the native mock: `back.android
 * .test.ts` established that the registration itself is the thing to prove
 * (an unwired handler failed silently on a device), and it makes the return
 * value — the half of the contract the router depends on — assertable.
 *
 * Harness: the 1:1 half from ChatThread.revise/provenance.test.tsx, the room
 * half from ChatThread.groupcall.test.tsx. */

import { foldRoster, type RosterSlot } from '@tacendum/shared/group-fold';
import { SMALL_GROUP_CALL_MAX_PARTICIPANTS } from '@tacendum/shared';
import React from 'react';
import { BackHandler } from 'react-native';
import ReactTestRenderer from 'react-test-renderer';
import * as db from '../src/db';
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

// ---------------------------------------------------------------- 1:1 half

const PEER = 'peer-1';

type Row = Record<string, unknown>;
const row = (r: Row): Row => ({
  peerId: PEER,
  status: 'received',
  editedAt: null,
  deletedAt: null,
  ...r,
});

const THEIRS = row({ msgId: '01THEIRS', direction: 'in', body: 'dinner at eight?', ts: T0 });
const MINE = row({
  msgId: '01MINE',
  direction: 'out',
  status: 'sent',
  body: 'make it nine',
  ts: T0 + 60_000,
});

/** A chat the server introduced and this phone never verified, so the
 * thread carries the provenance line whose own control opens the safety
 * panel — the one door to the panel that needs no identity change. */
const CHAT_ROW: Row = {
  peerId: PEER,
  displayName: null,
  lastMessageAt: T0,
  lastMessageText: 'make it nine',
  about: null,
  avatarB64: null,
  profileVersion: null,
  safetyCheckedAt: null,
  localName: 'alice@example.com',
  createdAt: T0,
  lastOpenedAt: null,
  identityChangedAt: null,
  safetyMismatchAt: null,
  disappearSec: null,
  disappearVersion: null,
  introducedBy: 'discovery',
};

function installPeerDb() {
  const instance = sqlite.instances.get('tacendum.sqlite')!;
  const base = instance.execute.getMockImplementation()!;
  instance.execute.mockImplementation(async (sql: string, params?: unknown) => {
    const s = String(sql);
    if (s.includes('FROM chats WHERE peerId')) return { rows: [CHAT_ROW] };
    if (s.includes('FROM messages')) return { rows: [THEIRS, MINE] };
    return base(s, params);
  });
  jest.spyOn(messaging, 'isPeerBlocked').mockReturnValue(false);
  // A session exists, so the panel offers the comparison rather than
  // the "no session yet" shape.
  jest.spyOn(messaging, 'getSafetyNumber').mockResolvedValue('4'.repeat(60));
}

// --------------------------------------------------------------- room half

/** Valid Crockford ULIDs (no I, L, O, U), 26 chars, distinct tails. */
const ulid = (tag: string) => (tag + '0'.repeat(26)).slice(0, 26);
const ROOM = ulid('R00MK7CHN');
const ME = ulid('ME1');
const OWNER = ulid('ANA');
const MEMBERS = ['BEN', 'CARA', 'DEE', 'EVE', 'FAY', 'GEM', 'HAN', 'JAY', 'KAT', 'MAX'].map(ulid);
const NAME_OF = new Map<string, string>([
  [OWNER, 'Ana'],
  ...MEMBERS.map((id, i) => [id, `M${i}`] as [string, string]),
]);

/** A room too big for a call: owner, me and ten others. */
function overCapRoom(): { members: string[]; slots: RosterSlot[] } {
  const slots: RosterSlot[] = [
    { memberId: OWNER, writerId: OWNER, seq: 1, state: 'in' },
    { memberId: ME, writerId: OWNER, seq: 1, state: 'in' },
    ...MEMBERS.map((id, i) => ({
      memberId: id,
      writerId: OWNER,
      seq: i + 2,
      state: 'in' as const,
    })),
  ];
  return { members: [...foldRoster(OWNER, slots).members], slots };
}

function installRoomDb(slots: RosterSlot[]) {
  const instance = sqlite.instances.get('tacendum.sqlite')!;
  const base = instance.execute.getMockImplementation()!;
  instance.execute.mockImplementation(async (sql: string, params?: unknown[]) => {
    const s = String(sql);
    if (s.includes('FROM messages')) return { rows: [] };
    if (s.includes('SELECT groupId, ownerId, name FROM groups')) {
      return params?.[0] === ROOM
        ? { rows: [{ groupId: ROOM, ownerId: OWNER, name: 'Kitchen' }] }
        : { rows: [] };
    }
    if (s.includes('FROM group_members')) {
      return params?.[0] === ROOM ? { rows: slots } : { rows: [] };
    }
    if (s.includes('FROM chats') && s.includes('ORDER BY')) {
      return {
        rows: [...NAME_OF].map(([peerId, displayName]) => ({
          peerId,
          displayName,
          localName: null,
        })),
      };
    }
    if (s.includes('FROM profile')) {
      return {
        rows: [
          { key: 'userId', value: ME },
          { key: 'registrationId', value: '7' },
        ],
      };
    }
    return base(sql, params);
  });
}

// ----------------------------------------------------------------- harness

/** Every hardwareBackPress handler registered while a test ran, in order,
 * with the `remove` each one was handed. */
let handlers: Array<{ handler: () => boolean; remove: jest.Mock }>;

beforeEach(async () => {
  await db.close();
  sqlite.reset();
  db.setWorkspace('real');
  await db.initDb();
  handlers = [];
  jest.spyOn(BackHandler, 'addEventListener').mockImplementation((event, handler) => {
    expect(event).toBe('hardwareBackPress');
    const remove = jest.fn();
    handlers.push({ handler: handler as () => boolean, remove });
    return { remove };
  });
});

afterEach(async () => {
  jest.restoreAllMocks();
  await db.close();
});

async function renderThread(
  props: Partial<React.ComponentProps<typeof ChatThreadScreen>> = {},
): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <ChatThreadScreen
        peerId={PEER}
        onBack={jest.fn()}
        onOpenPeerProfile={jest.fn()}
        onOpenPhoto={jest.fn()}
        {...props}
      />,
    );
  });
  await ReactTestRenderer.act(async () => {});
  return tree;
}

/** The thread's own handler — the most recent registration, exactly the one
 * RN would ask first. */
function threadHandler(): () => boolean {
  expect(handlers.length).toBeGreaterThan(0);
  return handlers[handlers.length - 1]!.handler;
}

/** One system back press, answered by the thread. */
async function pressBack(): Promise<boolean> {
  let consumed!: boolean;
  await ReactTestRenderer.act(async () => {
    consumed = threadHandler()();
  });
  return consumed;
}

function byId(tree: ReactTestRenderer.ReactTestRenderer, id: string) {
  return tree.root.findAll(n => n.props.testID === id);
}
const has = (tree: ReactTestRenderer.ReactTestRenderer, id: string) =>
  byId(tree, id).length > 0;

/** The control itself: a Pressable's host View carries no `onPress`. */
function press(tree: ReactTestRenderer.ReactTestRenderer, id: string) {
  return ReactTestRenderer.act(async () => {
    tree.root
      .find(n => n.props.testID === id && typeof n.props.onPress === 'function')
      .props.onPress();
  });
}

function longPress(tree: ReactTestRenderer.ReactTestRenderer, msgId: string) {
  return ReactTestRenderer.act(async () => {
    tree.root
      .find(
        n => n.props.testID === `msg-${msgId}` && typeof n.props.onLongPress === 'function',
      )
      .props.onLongPress();
  });
}

const railOpen = (tree: ReactTestRenderer.ReactTestRenderer) =>
  has(tree, 'react-❤️');

function drawerExpanded(tree: ReactTestRenderer.ReactTestRenderer, id: string): boolean {
  const control = tree.root.find(
    n => n.props.testID === id && typeof n.props.onPress === 'function',
  );
  return control.props.accessibilityState.expanded === true;
}

function draftValue(tree: ReactTestRenderer.ReactTestRenderer): string {
  return tree.root.find(
    n => n.props.testID === 'composer-input' && typeof n.props.onChangeText === 'function',
  ).props.value as string;
}

async function unmount(tree: ReactTestRenderer.ReactTestRenderer) {
  await ReactTestRenderer.act(() => {
    tree.unmount();
  });
}

// ------------------------------------------------------------------- tests

test('subscribes on mount, yields with nothing open, and unsubscribes on unmount', async () => {
  installPeerDb();
  const onBack = jest.fn();
  const tree = await renderThread({ onBack });
  const registration = handlers[handlers.length - 1]!;

  // Nothing open: the press is NOT consumed, so the router pops. The thread
  // never navigates itself — that stays the router's job.
  expect(await pressBack()).toBe(false);
  expect(onBack).not.toHaveBeenCalled();

  await unmount(tree);
  expect(registration.remove).toHaveBeenCalledTimes(1);
});

test('closes an open reaction rail and consumes the press', async () => {
  installPeerDb();
  const tree = await renderThread();
  await longPress(tree, '01THEIRS');
  expect(railOpen(tree)).toBe(true);

  expect(await pressBack()).toBe(true);
  expect(railOpen(tree)).toBe(false);
  // Now empty-handed: the next press is the router's.
  expect(await pressBack()).toBe(false);
  await unmount(tree);
});

test('closes an open attach drawer', async () => {
  installPeerDb();
  const tree = await renderThread();
  await press(tree, 'composer-attach');
  expect(drawerExpanded(tree, 'composer-attach')).toBe(true);
  expect(has(tree, 'attach-library')).toBe(true);

  expect(await pressBack()).toBe(true);
  expect(drawerExpanded(tree, 'composer-attach')).toBe(false);
  expect(has(tree, 'attach-library')).toBe(false);
  expect(await pressBack()).toBe(false);
  await unmount(tree);
});

test('closes an open emoji drawer', async () => {
  installPeerDb();
  const tree = await renderThread();
  await press(tree, 'composer-emoji');
  expect(drawerExpanded(tree, 'composer-emoji')).toBe(true);

  expect(await pressBack()).toBe(true);
  expect(drawerExpanded(tree, 'composer-emoji')).toBe(false);
  expect(await pressBack()).toBe(false);
  await unmount(tree);
});

test('cancels the composer chip the way its ✕ does — an edit gives the shelved draft back', async () => {
  installPeerDb();
  const tree = await renderThread();
  await ReactTestRenderer.act(async () => {
    tree.root
      .find(n => n.props.testID === 'composer-input' && typeof n.props.onChangeText === 'function')
      .props.onChangeText('half a thought');
  });
  await longPress(tree, '01MINE');
  await press(tree, 'edit-01MINE');
  expect(has(tree, 'composer-chip')).toBe(true);
  expect(draftValue(tree)).toBe('make it nine');

  // Back is the chip's cancel, not a bare "forget the chip": the words the
  // edit borrowed the composer from come back with it.
  expect(await pressBack()).toBe(true);
  expect(has(tree, 'composer-chip')).toBe(false);
  expect(draftValue(tree)).toBe('half a thought');
  expect(await pressBack()).toBe(false);
  await unmount(tree);
});

test('closes the safety panel before a rail that is also open', async () => {
  installPeerDb();
  const tree = await renderThread();
  await press(tree, 'provenance-compare');
  expect(has(tree, 'safety-number')).toBe(true);
  await longPress(tree, '01THEIRS');
  expect(railOpen(tree)).toBe(true);

  expect(await pressBack()).toBe(true);
  expect(has(tree, 'safety-number')).toBe(false);
  expect(railOpen(tree)).toBe(true);

  expect(await pressBack()).toBe(true);
  expect(railOpen(tree)).toBe(false);
  expect(await pressBack()).toBe(false);
  await unmount(tree);
});

test('stacked: rail, then drawer, then chip, then the router', async () => {
  installPeerDb();
  const tree = await renderThread();
  // A reply chip (its rail closes on pick), then a drawer, then a rail on
  // top: three things open, nested outermost-last.
  await longPress(tree, '01THEIRS');
  await press(tree, 'reply-01THEIRS');
  expect(has(tree, 'composer-chip')).toBe(true);
  await press(tree, 'composer-attach');
  await longPress(tree, '01THEIRS');
  expect(railOpen(tree)).toBe(true);
  expect(drawerExpanded(tree, 'composer-attach')).toBe(true);

  expect(await pressBack()).toBe(true);
  expect(railOpen(tree)).toBe(false);
  expect(drawerExpanded(tree, 'composer-attach')).toBe(true);
  expect(has(tree, 'composer-chip')).toBe(true);

  expect(await pressBack()).toBe(true);
  expect(drawerExpanded(tree, 'composer-attach')).toBe(false);
  expect(has(tree, 'composer-chip')).toBe(true);

  expect(await pressBack()).toBe(true);
  expect(has(tree, 'composer-chip')).toBe(false);

  expect(await pressBack()).toBe(false);
  await unmount(tree);
});

test('closes the call picker first, ahead of a drawer', async () => {
  const { members, slots } = overCapRoom();
  expect(members.length).toBeGreaterThan(SMALL_GROUP_CALL_MAX_PARTICIPANTS);
  installRoomDb(slots);
  const onStartRoomCall = jest.fn();
  const tree = await renderThread({ peerId: ROOM, onStartRoomCall });
  await press(tree, 'start-call-audio');
  expect(has(tree, 'call-picker')).toBe(true);
  await press(tree, 'composer-attach');
  expect(drawerExpanded(tree, 'composer-attach')).toBe(true);

  expect(await pressBack()).toBe(true);
  expect(has(tree, 'call-picker')).toBe(false);
  expect(drawerExpanded(tree, 'composer-attach')).toBe(true);
  expect(onStartRoomCall).not.toHaveBeenCalled();

  expect(await pressBack()).toBe(true);
  expect(drawerExpanded(tree, 'composer-attach')).toBe(false);
  expect(await pressBack()).toBe(false);
  await unmount(tree);
});
