/**
 * ROOMS in the chat list.
 *
 * Real-engine harness (messaging.groups.receive.test.ts's): the recorded
 * op-sqlite mock is rebound to Node's real SQLite so every assertion reads
 * actual rows — the delete tests in particular are about what SURVIVES in
 * the outbox, which a recorded mock cannot answer.
 *
 * What this file proves:
 *  - A room row renders with its name and its monogram, and the room's
 *    26-character ULID appears in NO rendered text — not as the title, not
 *    as a fallback (the rule: "No screen renders a room's id").
 *  - Deleting a room routes to `deleteGroup`, NEVER `deleteChat`, asserted
 *    twice: the call itself, and the BEHAVIOUR the routing exists for — the
 *    room's queued fan-out legs (peerId = a MEMBER, localMsgId set) are
 *    gone afterwards, while the member's own 1:1 envelope and the room's
 *    anchor (a local delete keeps the way back) both survive.
 *  - A room's drawer offers no Block: blocking a room is not a thing; members are blocked from their own conversations.
 *  - The empty state no longer promises two seats: the old copy is absent
 *    verbatim, the replacement present.
 *  - The 'New room' entry sits with the list and fires its route.
 */

jest.mock('../src/ws', () => {
  const handlers: {
    frame?: (f: unknown) => void;
    state?: (s: string) => void;
  } = {};
  const state = { open: true };
  const calls = {
    start: jest.fn(),
    stop: jest.fn(),
    send: jest.fn((_frame: unknown) => true),
  };
  class WsClient {
    onFrame(cb: (f: unknown) => void) {
      handlers.frame = cb;
    }
    onState(cb: (s: string) => void) {
      handlers.state = cb;
    }
    start(token: string) {
      calls.start(token);
    }
    stop() {
      calls.stop();
    }
    send(frame: unknown) {
      return calls.send(frame) as boolean;
    }
    get isOpen() {
      return state.open;
    }
  }
  return { WsClient, __ws: { handlers, calls, state } };
});

jest.mock('../src/api', () => ({
  apiUploadKeys: jest.fn().mockRejectedValue(new Error('network in test')),
  apiGetPrekeyBundle: jest.fn().mockRejectedValue(new Error('network in test')),
  apiDeleteAccount: jest.fn().mockRejectedValue(new Error('network in test')),
  apiCreateAttachment: jest.fn().mockRejectedValue(new Error('network in test')),
  apiGetAttachmentUrl: jest.fn().mockRejectedValue(new Error('network in test')),
  uploadBlob: jest.fn().mockRejectedValue(new Error('network in test')),
  downloadBlob: jest.fn().mockRejectedValue(new Error('network in test')),
  apiWsTicket: jest.fn().mockRejectedValue(new Error('network in test')),
}));

jest.mock('../src/decoy', () => ({
  syncDecoyProfile: jest.fn(async () => undefined),
}));

import React from 'react';
import { StyleSheet, Text } from 'react-native';
import ReactTestRenderer from 'react-test-renderer';
import * as db from '../src/db';
import { messaging } from '../src/messaging';
import { ChatListScreen } from '../src/screens/ChatListScreen';
import { createRoom } from '../src/screens/GroupCreateScreen';
import { session } from '../src/session';
import { Avatar } from '../src/ui/Avatar';
import { RoomMark } from '../src/ui/RoomMark';

// --- the real engine, bound under the recorded mock -------------------------

type Row = Record<string, unknown>;
interface Engine {
  prepare(sql: string): { all(...args: unknown[]): Row[] };
  close(): void;
}
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (p: string) => Engine;
};

interface FakeDb {
  name: string;
  execute: jest.Mock;
  close: jest.Mock;
}
const sqlite = jest.requireMock('@op-engineering/op-sqlite') as {
  open: (o: { name: string }) => FakeDb;
  __sqlite: { instances: Map<string, FakeDb>; reset: () => void };
};
const crypto = jest.requireMock('tacendum-crypto') as {
  __keychain: Map<string, string>;
  encryptText: jest.Mock;
  hasSession: jest.Mock;
  randomBytes: jest.Mock;
};
const ws = (
  jest.requireMock('../src/ws') as {
    __ws: { calls: { send: jest.Mock }; state: { open: boolean } };
  }
).__ws;

let engine: Engine;

function bindRealEngine(): void {
  engine = new DatabaseSync(':memory:');
  const instance = sqlite.open({ name: 'tacendum.sqlite' });
  instance.execute.mockImplementation(
    async (sql: unknown, params?: unknown[]) => {
      const args = (params ?? []).map(p => (p === undefined ? null : p));
      const rows = engine.prepare(String(sql)).all(...args);
      const changes = engine.prepare('SELECT changes() AS c').all()[0]!
        .c as number;
      return { rows, rowsAffected: changes };
    },
  );
}

const q = (sql: string, ...args: unknown[]): Row[] =>
  engine.prepare(sql).all(...args);

// --- ids and fixtures -------------------------------------------------------

const pad = (seed: string): string => (seed + '0'.repeat(26)).slice(0, 26);
const ME = pad('ME');
const BEN = pad('BEN');
const CARA = pad('CARA');

const PROFILE: db.ProfileRow = {
  userId: ME,
  registrationId: 7,
  displayName: '',
  about: '',
  avatarB64: '',
  profileVersion: 0,
};

async function flush(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

async function render(
  element: React.ReactElement,
): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(element);
  });
  await ReactTestRenderer.act(async () => {
    await flush();
  });
  return tree;
}

function byId(tree: ReactTestRenderer.ReactTestRenderer, id: string) {
  return tree.root.findAll(n => n.props.testID === id);
}

/**
 * The resolved style of the HOST node carrying this testID. A Pressable's
 * own style prop is a function; the host View underneath holds the resolved
 * array, and that is the style a person's screen actually gets.
 */
function hostStyle(
  tree: ReactTestRenderer.ReactTestRenderer,
  id: string,
  // Annotated because StyleSheet.flatten widens an `unknown` argument to
  // `unknown`, and these assertions read named properties off it.
): Record<string, number | string | undefined> {
  const resolved = byId(tree, id)
    .map(n => n.props.style as unknown)
    .filter(s => s !== undefined && typeof s !== 'function');
  expect(resolved.length).toBeGreaterThan(0);
  return StyleSheet.flatten(
    resolved[resolved.length - 1] as Parameters<typeof StyleSheet.flatten>[0],
  ) as Record<string, number | string | undefined>;
}

/** Every string any <Text> in the tree renders, joined. testIDs and props
 * are NOT in here — this is what a person (or VoiceOver) actually gets. */
function renderedText(tree: ReactTestRenderer.ReactTestRenderer): string {
  return tree.root
    .findAllByType(require('react-native').Text)
    .map(n =>
      Array.isArray(n.props.children)
        ? n.props.children
            .map((c: unknown) => (typeof c === 'string' ? c : ''))
            .join('')
        : typeof n.props.children === 'string'
          ? n.props.children
          : '',
    )
    .join('\n');
}

function listScreen(overrides: Partial<Record<'onStartRoom' | 'onOpenChat', jest.Mock>> = {}) {
  return (
    <ChatListScreen
      profile={PROFILE}
      onOpenChat={overrides.onOpenChat ?? jest.fn()}
      onOpenProfile={jest.fn()}
      onStartChat={jest.fn()}
      onStartRoom={overrides.onStartRoom ?? jest.fn()}
    />
  );
}

/** A room with queued fan-out legs: created for real, then one fanOut while
 * the socket is closed, so the legs SIT in the outbox instead of draining. */
async function roomWithQueuedLegs(): Promise<string> {
  await db.upsertChat(BEN, 'Ben');
  await db.upsertChat(CARA, 'Cara');
  const { groupId } = await createRoom(ME, 'Kitchen', [BEN, CARA]);
  await flush();
  ws.state.open = false;
  await messaging.fanOut(groupId, 'the queued message');
  await flush();
  return groupId;
}

beforeEach(async () => {
  messaging.stop();
  await db.close();
  crypto.__keychain.clear();
  sqlite.__sqlite.reset();
  crypto.encryptText.mockReset();
  crypto.encryptText.mockResolvedValue({ msgType: 'ciphertext', payload: 'AAAA' });
  crypto.hasSession.mockReset();
  crypto.hasSession.mockResolvedValue(true);
  // The suite-wide randomBytes stub returns the SAME bytes every call, so two
  // fan-out legs would mint the same wire id and trip the real engine's
  // UNIQUE(outbox.msgId) — a collision the real RNG cannot produce. Distinct
  // entropy per call, still deterministic.
  let entropyCounter = 0;
  crypto.randomBytes.mockImplementation(async (count: number) => {
    const out = new Uint8Array(count);
    for (let i = 0; i < count; i++) out[i] = entropyCounter++ * 37 % 251;
    return out;
  });
  ws.calls.send.mockClear();
  ws.state.open = true;
  session.setMode('real');
  db.setWorkspace('real');
  bindRealEngine();
  crypto.__keychain.set('authToken', 'token-1');
  await db.initDb();
  await messaging.start(ME);
  await flush();
  ws.calls.send.mockClear();
});

afterEach(async () => {
  messaging.stop();
  await db.close();
  engine.close();
  session.setMode('real');
  db.setWorkspace('real');
});

// ---------------------------------------------------------------------------

describe('a room row', () => {
  test('renders its name and its monogram, and the room ULID reaches no rendered text', async () => {
    await db.upsertChat(BEN, 'Ben');
    const { groupId } = await createRoom(ME, 'Kitchen', [BEN]);
    await flush();

    const tree = await render(listScreen());

    // Fixture sanity first: the row itself is on screen.
    expect(byId(tree, `chat-${groupId}`).length).toBeGreaterThan(0);

    const text = renderedText(tree);
    expect(text).toContain('Kitchen'); // the name
    expect(text).toContain('KI'); // the monogram, from the name
    expect(text).toContain('New room'); // the preview line
    // The rule, taken literally: no rendered text carries the
    // room's id — not whole, and not shortId's "…" + 8-character tail.
    expect(text).not.toContain(groupId);
    expect(text).not.toContain(groupId.slice(-8));

    await ReactTestRenderer.act(() => {
      tree.unmount();
    });
  });

  test('a whitespace-only wire name falls to the fallback word, never the room id', async () => {
    // The wire schema's min(1) accepts " " from a hostile composer, and
    // personName's trim would then degrade the row title to the room's
    // shortId — the violation the thread header and the invite compose
    // already defend against. The row must say the fallback word instead.
    await db.upsertChat(BEN, 'Ben');
    const { groupId } = await createRoom(ME, 'Kitchen', [BEN]);
    q(`UPDATE groups SET name = ' ' WHERE groupId = ?`, groupId);
    await flush();

    const tree = await render(listScreen());

    expect(byId(tree, `chat-${groupId}`).length).toBeGreaterThan(0);
    const text = renderedText(tree);
    expect(text).toContain('Room');
    expect(text).not.toContain(groupId);
    expect(text).not.toContain(groupId.slice(-8));

    await ReactTestRenderer.act(() => {
      tree.unmount();
    });
  });

  test('offers Delete room but never Block in its drawer', async () => {
    await db.upsertChat(BEN, 'Ben');
    const { groupId } = await createRoom(ME, 'Kitchen', [BEN]);
    await flush();

    const tree = await render(listScreen());
    await ReactTestRenderer.act(async () => {
      byId(tree, `chat-${groupId}`)[0].props.onLongPress();
    });

    expect(byId(tree, `chat-delete-${groupId}`).length).toBeGreaterThan(0);
    expect(byId(tree, `chat-block-${groupId}`).length).toBe(0);
    // The person's own row still offers both — the absence above is the
    // room's, not a broken drawer.
    await ReactTestRenderer.act(async () => {
      byId(tree, `chat-${BEN}`)[0].props.onLongPress();
    });
    expect(byId(tree, `chat-block-${BEN}`).length).toBeGreaterThan(0);

    await ReactTestRenderer.act(() => {
      tree.unmount();
    });
  });
});

describe('the room signal (a person is a circle; a room is a walled square)', () => {
  /** One room and one person, side by side — the mixed list the signal
   * exists for. Returns the room's id. */
  async function mixedList(): Promise<string> {
    await db.upsertChat(BEN, 'Ben');
    const { groupId } = await createRoom(ME, 'Kitchen', [BEN]);
    await flush();
    return groupId;
  }

  test('a room row wears the RoomMark and no disc; a person row wears the disc and no mark', async () => {
    const groupId = await mixedList();
    const tree = await render(listScreen());

    // Preconditions: BOTH rows are actually on screen. Absences asserted
    // below must not be able to pass over a fixture that rendered nothing.
    const roomRow = byId(tree, `chat-${groupId}`)[0];
    const personRow = byId(tree, `chat-${BEN}`)[0];
    expect(roomRow).toBeTruthy();
    expect(personRow).toBeTruthy();

    // The room: the walled square, carrying the NAME's monogram —
    // and no person disc anywhere in its row.
    expect(roomRow.findAllByType(RoomMark).length).toBe(1);
    expect(roomRow.findAllByType(Avatar).length).toBe(0);
    const monogram = roomRow
      .findByType(RoomMark)
      .findAllByType(Text)
      .map(n => n.props.children)
      .join('');
    expect(monogram).toBe('KI');

    // The person: the disc, and no mark. Without this half, painting the
    // mark on EVERY row would pass — and distinguish nothing.
    expect(personRow.findAllByType(Avatar).length).toBe(1);
    expect(personRow.findAllByType(RoomMark).length).toBe(0);

    await ReactTestRenderer.act(() => {
      tree.unmount();
    });
  });

  test('VoiceOver hears the word: a room row is announced as a room; a quiet person row stays label-free, unchanged', async () => {
    const groupId = await mixedList();
    const tree = await render(listScreen());

    const roomRow = byId(tree, `chat-${groupId}`)[0];
    const personRow = byId(tree, `chat-${BEN}`)[0];
    expect(roomRow).toBeTruthy();
    expect(personRow).toBeTruthy();
    // Precondition: the fresh room's preview line is on screen, so the
    // label asserted next is built from parts this fixture actually holds.
    expect(renderedText(tree)).toContain('New room');

    // The mark is visual only; the WORD travels in the label.
    expect(roomRow.props.accessibilityLabel).toBe('Kitchen, room, New room');
    // A quiet 1:1 row carries no label at all — its Text children already
    // read correctly — exactly as before rooms existed.
    expect(personRow.props.accessibilityLabel).toBeUndefined();

    await ReactTestRenderer.act(() => {
      tree.unmount();
    });
  });

  test('an unread room still says room, ahead of the news', async () => {
    const groupId = await mixedList();
    // A room row EXACTLY as the receive path writes one, which is the whole
    // point: the id is the composite `${author}.${m}`, and `seen` holds the
    // WIRE id, so no `seen` row can ever match this one.
    //
    // The previous fixture inserted a bare id into BOTH tables — a 1:1 shape
    // the room path never produces — and so it passed against a query that
    // could not count a single real room message. The masking fixture is the
    // bug: rooms showed no unread count in production for the whole life of
    // the feature, and this test said they did.
    q(
      `INSERT INTO messages (msgId, peerId, direction, body, ts, status, authorId, arrivedAt)
       VALUES (?, ?, 'in', 'soup?', ?, 'received', ?, ?)`,
      `${BEN}.01UNREADMSG0000000000000`,
      groupId,
      Date.now(),
      BEN,
      Date.now(),
    );

    // Precondition: the fixture actually produces unreadness — the decoy
    // lesson, asserted before the rule. A seed the unread query cannot see
    // would let the plain-label branch pass as this test.
    await expect(db.unreadCounts()).resolves.toMatchObject({ [groupId]: 1 });

    const tree = await render(listScreen());
    const label = byId(tree, `chat-${groupId}`)[0].props
      .accessibilityLabel as string;
    expect(label).toContain('Kitchen, room, new messages');

    await ReactTestRenderer.act(() => {
      tree.unmount();
    });
  });

  test('Dynamic Type XXL cannot clip the row: the row is a floor, the mark a fixed box whose letters hold still', async () => {
    const groupId = await mixedList();
    const tree = await render(listScreen());

    const roomRow = byId(tree, `chat-${groupId}`)[0];
    // Precondition: this is the room's row, wearing the mark.
    expect(roomRow.findAllByType(RoomMark).length).toBe(1);

    // The row: minHeight, never height — scaled text grows the row instead
    // of being sliced by it.
    const rowStyle = hostStyle(tree, `chat-${groupId}`);
    expect(rowStyle.minHeight).toBe(72);
    expect(rowStyle.height).toBeUndefined();

    // The mark's monogram does not scale: fixed letters in a fixed box
    // cannot clip at any accessibility size (Avatar's own contract).
    const markText = roomRow.findByType(RoomMark).findByType(Text);
    expect(markText.props.allowFontScaling).toBe(false);

    // The name ellipsizes on its single line rather than clipping.
    const nameText = roomRow
      .findAllByType(Text)
      .find(n => n.props.children === 'Kitchen');
    expect(nameText).toBeTruthy();
    expect(nameText!.props.numberOfLines).toBe(1);

    await ReactTestRenderer.act(() => {
      tree.unmount();
    });
  });
});

describe('deleting a room', () => {
  test('routes to deleteGroup, never deleteChat — and the queued legs are GONE, while 1:1 envelopes and the way back survive', async () => {
    const groupId = await roomWithQueuedLegs();
    // A member's own 1:1 envelope, queued alongside — the row a wrong
    // cascade would take with it.
    await messaging.sendText(BEN, 'a 1:1 that must survive');
    await flush();

    // Fixture sanity: the legs exist BEFORE the delete, or this test could
    // pass over an empty outbox without ever reaching the code under test.
    // Four now, not two: the grp.new invitations are room-scoped fan-out
    // legs themselves (fanOutMembership replaced the sendText seam), so the
    // room owns the two invite legs AND the two message legs.
    const legsBefore = q(
      `SELECT msgId FROM outbox WHERE localMsgId IS NOT NULL`,
    );
    expect(legsBefore.length).toBe(4); // two invite legs + two message legs
    // Ben's only 1:1 envelope is the text above — the invitation no longer
    // rides the 1:1 seam, which is exactly what lets it die with the room.
    expect(
      q(`SELECT msgId FROM outbox WHERE peerId = ? AND localMsgId IS NULL`, BEN)
        .length,
    ).toBe(1);

    const deleteGroupSpy = jest.spyOn(db, 'deleteGroup');
    const deleteChatSpy = jest.spyOn(db, 'deleteChat');

    const tree = await render(listScreen());
    await ReactTestRenderer.act(async () => {
      byId(tree, `chat-${groupId}`)[0].props.onLongPress();
    });
    await ReactTestRenderer.act(async () => {
      byId(tree, `chat-delete-${groupId}`)[0].props.onPress();
    });
    await ReactTestRenderer.act(async () => {
      byId(tree, `chat-delete-confirm-${groupId}`)[0].props.onPress();
      await flush();
    });

    // The call: deleteGroup, and deleteChat NOT EVEN ONCE — the purge gate's
    // exact debt (deleteChat on a room id spares the legs).
    expect(deleteGroupSpy).toHaveBeenCalledWith(groupId);
    expect(deleteChatSpy).not.toHaveBeenCalled();

    // The behaviour the routing exists for: every queued leg is gone —
    // message legs and invitation legs alike…
    expect(q(`SELECT msgId FROM outbox WHERE localMsgId IS NOT NULL`)).toEqual(
      [],
    );
    // …the member's own 1:1 envelope still stands…
    expect(
      q(`SELECT msgId FROM outbox WHERE peerId = ? AND localMsgId IS NULL`, BEN)
        .length,
    ).toBe(1);
    // …the conversation is gone from the list…
    expect(q(`SELECT peerId FROM chats WHERE peerId = ?`, groupId)).toEqual([]);
    expect(q(`SELECT msgId FROM messages WHERE peerId = ?`, groupId)).toEqual(
      [],
    );
    // …and the anchor + roster survive: a LOCAL delete keeps the way
    // back (the room returns on new traffic while I am still in it).
    expect(
      q(`SELECT ownerId FROM groups WHERE groupId = ?`, groupId),
    ).toEqual([{ ownerId: ME }]);
    expect(
      q(`SELECT COUNT(*) AS n FROM group_members WHERE groupId = ?`, groupId),
    ).toEqual([{ n: 3 }]);

    deleteGroupSpy.mockRestore();
    deleteChatSpy.mockRestore();
    await ReactTestRenderer.act(() => {
      tree.unmount();
    });
  });
});

describe('the empty state and the room entry', () => {
  test('no longer promises two seats, in the product’s own words', async () => {
    const tree = await render(listScreen());

    const text = renderedText(tree);
    // Fixture sanity: this IS the empty state.
    expect(text).toContain('Nobody else is here yet');
    expect(text).toContain('This seat is yours');
    // The three two-seat sentences, gone verbatim.
    expect(text).not.toContain('One seat is yours');
    expect(text).not.toContain('The other seat is empty');
    expect(text).not.toContain('waiting for one other person');

    await ReactTestRenderer.act(() => {
      tree.unmount();
    });
  });

  test('the New room entry sits with the list and fires its route', async () => {
    await db.upsertChat(BEN, 'Ben');
    const onStartRoom = jest.fn();
    const tree = await render(listScreen({ onStartRoom }));

    const entry = byId(tree, 'new-room');
    expect(entry.length).toBeGreaterThan(0);
    await ReactTestRenderer.act(async () => {
      entry[0].props.onPress();
    });
    expect(onStartRoom).toHaveBeenCalled();

    await ReactTestRenderer.act(() => {
      tree.unmount();
    });
  });
});
