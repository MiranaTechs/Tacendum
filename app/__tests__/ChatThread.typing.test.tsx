/**
 * The subtitle's typing narration: start replaces the
 * subtitle, stop restores it, expiry backstops a lost stop, rooms aggregate
 * by MY names for people, and the composer's keystrokes drive the right
 * sender for the thread's shape. All in-memory — nothing here may touch the
 * database, and the tests would catch a row if one appeared (the sqlite
 * fake serves only the fixtures below).
 */
import type { RosterSlot } from '@tacendum/shared/group-fold';
import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import * as db from '../src/db';
import type { TypingEnvelope } from '../src/envelope';
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

/** Valid Crockford ULIDs (no I, L, O, U), 26 chars, distinct tails. */
const ulid = (tag: string) => (tag + '0'.repeat(26)).slice(0, 26);
const ROOM = ulid('R00MK7CHN');
const ANA = ulid('ANA');
const BEN = ulid('BEN');
const CARA = ulid('CARA');
const ME = ulid('ME1');
const PEER = ulid('PEER1');

const NAME_ROWS = [
  { peerId: ANA, displayName: 'Ana', localName: null },
  { peerId: BEN, displayName: 'Ben', localName: null },
  { peerId: CARA, displayName: 'Cara', localName: null },
  { peerId: PEER, displayName: 'Dawit', localName: null },
];

const SLOT_ROWS: RosterSlot[] = [
  { memberId: ANA, writerId: ANA, seq: 1, state: 'in' },
  { memberId: ME, writerId: ANA, seq: 1, state: 'in' },
  { memberId: BEN, writerId: ANA, seq: 2, state: 'in' },
  { memberId: CARA, writerId: ANA, seq: 1, state: 'in' },
];

function installRoomDb() {
  const instance = sqlite.instances.get('tacendum.sqlite')!;
  const base = instance.execute.getMockImplementation()!;
  instance.execute.mockImplementation(
    async (sql: string, params?: unknown[]) => {
      const s = String(sql);
      if (s.includes('FROM messages')) return { rows: [] };
      if (s.includes('SELECT groupId, ownerId, name FROM groups')) {
        return params?.[0] === ROOM
          ? { rows: [{ groupId: ROOM, ownerId: ANA, name: 'Kitchen' }] }
          : { rows: [] };
      }
      if (s.includes('FROM group_members')) {
        return params?.[0] === ROOM ? { rows: SLOT_ROWS } : { rows: [] };
      }
      if (s.includes('FROM chats') && s.includes('ORDER BY')) {
        return { rows: NAME_ROWS };
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
    },
  );
}

function install1to1Db() {
  const instance = sqlite.instances.get('tacendum.sqlite')!;
  const base = instance.execute.getMockImplementation()!;
  instance.execute.mockImplementation(
    async (sql: string, params?: unknown[]) => {
      const s = String(sql);
      if (s.includes('FROM messages')) return { rows: [] };
      if (s.includes('SELECT groupId, ownerId, name FROM groups')) {
        return { rows: [] };
      }
      if (s.includes('FROM group_members')) return { rows: [] };
      if (s.includes('FROM chats') && s.includes('ORDER BY')) {
        return { rows: NAME_ROWS };
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
    },
  );
}

async function renderThread(
  props: Partial<React.ComponentProps<typeof ChatThreadScreen>> = {},
): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <ChatThreadScreen
        peerId={ROOM}
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

let typingListener:
  | ((peerId: string, envelope: TypingEnvelope, ts: number) => void)
  | undefined;

beforeEach(async () => {
  await db.close();
  sqlite.reset();
  db.setWorkspace('real');
  await db.initDb();
  typingListener = undefined;
  jest.spyOn(messaging, 'onTyping').mockImplementation(listener => {
    typingListener = listener;
    return () => {
      typingListener = undefined;
    };
  });
  jest.spyOn(messaging, 'sendTypingState').mockResolvedValue(undefined);
  jest.spyOn(messaging, 'sendRoomTypingState').mockResolvedValue(undefined);
});

afterEach(async () => {
  jest.restoreAllMocks();
  await db.close();
});

async function emitTyping(from: string, envelope: TypingEnvelope): Promise<void> {
  await ReactTestRenderer.act(async () => {
    typingListener?.(from, envelope, 1);
  });
}

describe('1:1 typing display', () => {
  test('start replaces the subtitle; stop restores it', async () => {
    // "Just you two" also captions the empty-thread hero (ui/QuietRoom.tsx),
    // which typing must NOT touch — so the assertion counts surfaces: two at
    // rest (subtitle + hero), one while typing (hero only).
    const justYouTwos = (tree: ReactTestRenderer.ReactTestRenderer) =>
      renderedText(tree).split('Just you two').length - 1;
    install1to1Db();
    const tree = await renderThread({ peerId: PEER });
    expect(justYouTwos(tree)).toBe(2);

    await emitTyping(PEER, { tcm: 'x.typing', state: 'start' });
    expect(renderedText(tree)).toContain('typing…');
    expect(justYouTwos(tree)).toBe(1);

    await emitTyping(PEER, { tcm: 'x.typing', state: 'stop' });
    expect(justYouTwos(tree)).toBe(2);
    expect(renderedText(tree)).not.toContain('typing…');
  });

  test('typing from someone else, or room-scoped typing, is ignored in a 1:1', async () => {
    install1to1Db();
    const tree = await renderThread({ peerId: PEER });

    await emitTyping(ulid('STRANGER'), { tcm: 'x.typing', state: 'start' });
    await emitTyping(PEER, { tcm: 'x.typing', state: 'start', room: ROOM });

    expect(renderedText(tree)).not.toContain('typing…');
  });

  test('the indicator expires on its own at TYPING_EXPIRY_MS', async () => {
    // Mount under REAL timers (the screen's boot path settles on promises);
    // fake timers go on only for the expiry clock, BEFORE the typing event,
    // so the prune timeout and its Date.now() land on the same fake clock.
    install1to1Db();
    const tree = await renderThread({ peerId: PEER });
    jest.useFakeTimers();
    try {
      await emitTyping(PEER, { tcm: 'x.typing', state: 'start' });
      expect(renderedText(tree)).toContain('typing…');

      await ReactTestRenderer.act(async () => {
        await jest.advanceTimersByTimeAsync(15_000 + 100);
      });
      expect(renderedText(tree)).not.toContain('typing…');
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('room typing display', () => {
  test('one, two, and many typists aggregate by name', async () => {
    installRoomDb();
    const tree = await renderThread();

    await emitTyping(BEN, { tcm: 'x.typing', state: 'start', room: ROOM });
    expect(renderedText(tree)).toContain('Ben is typing…');

    await emitTyping(CARA, { tcm: 'x.typing', state: 'start', room: ROOM });
    expect(renderedText(tree)).toContain('Ben and Cara are typing…');

    await emitTyping(ANA, { tcm: 'x.typing', state: 'start', room: ROOM });
    expect(renderedText(tree)).toContain('Several people are typing…');
  });

  test('typing scoped to a DIFFERENT room is ignored', async () => {
    installRoomDb();
    const tree = await renderThread();
    await emitTyping(BEN, { tcm: 'x.typing', state: 'start', room: ulid('XTRAR00M') });
    expect(renderedText(tree)).not.toContain('typing…');
  });
});

describe('composer wiring', () => {
  test('a human keystroke signals start; clearing signals stop; a 1:1 uses the 1:1 sender', async () => {
    install1to1Db();
    const tree = await renderThread({ peerId: PEER });
    const input = tree.root.findByProps({ testID: 'composer-input' });

    await ReactTestRenderer.act(async () => input.props.onChangeText('hel'));
    expect(messaging.sendTypingState).toHaveBeenCalledWith(PEER, 'start');
    expect(messaging.sendRoomTypingState).not.toHaveBeenCalled();

    await ReactTestRenderer.act(async () => input.props.onChangeText(''));
    expect(messaging.sendTypingState).toHaveBeenCalledWith(PEER, 'stop');
  });

  test('in a room the room sender carries the signal', async () => {
    installRoomDb();
    const tree = await renderThread();
    const input = tree.root.findByProps({ testID: 'composer-input' });

    await ReactTestRenderer.act(async () => input.props.onChangeText('hel'));
    expect(messaging.sendRoomTypingState).toHaveBeenCalledWith(ROOM, 'start');
    expect(messaging.sendTypingState).not.toHaveBeenCalled();
  });
});
