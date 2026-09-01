/**
 * The room thread.
 *
 * The rules these pin, each named where it is asserted:
 *  - membership announcements render as attributed system rows, counted and
 *    declined alike, with every SUBJECT derived from the authenticated
 *    authorId — never a payload field, never bubble position;
 *  - an outsider's message is visibly tagged and attributed, structurally
 *    distinct from a member's bubble, and never dropped;
 *  - the grp.* kinds sit in buildItems' `system` set, so an announcement
 *    row does not swallow a neighbouring bubble's clock — the regression
 *    that set exists to prevent, tested directly;
 *  - the composer fans out through `fanOut`, never `sendText`;
 *  - no rendered text contains the room's id.
 *
 * Harness copied from ChatThread.attach.test.tsx.
 */

import { foldRoster, type RosterSlot } from '@tacendum/shared/group-fold';
import React from 'react';
import { StyleSheet, Text } from 'react-native';
import ReactTestRenderer from 'react-test-renderer';
import * as db from '../src/db';
import { messaging } from '../src/messaging';
import { ChatThreadScreen } from '../src/screens/ChatThreadScreen';
import { clockLabel } from '../src/time';
import { Avatar } from '../src/ui/Avatar';
import { RoomMark } from '../src/ui/RoomMark';

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
const ANA = ulid('ANA'); // the owner (grp.new's sender, forever)
const BEN = ulid('BEN');
const CARA = ulid('CARA');
const DAN = ulid('DAN'); // outsider: the roster said out at arrival
const EVE = ulid('EVE'); // shared the display name "You" — a forgery attempt
const ME = ulid('ME1');

const T0 = new Date('2026-07-25T12:00:00').getTime();

/** The names THIS phone holds — the only legitimate source of a label. */
const NAME_ROWS = [
  { peerId: ANA, displayName: 'Ana', localName: null },
  { peerId: BEN, displayName: 'Ben', localName: null },
  { peerId: CARA, displayName: 'Cara', localName: null },
  { peerId: DAN, displayName: 'Dan', localName: null },
  { peerId: EVE, displayName: 'You', localName: null },
];

type Row = Record<string, unknown>;

/**
 * The stored roster slots the header's people count folds: Ana the
 * owner in, me in, Cara in — and Ben, admitted by Ana but OUT by his own
 * sovereign write, so a naive slot count (5) and a naive member count (4)
 * both differ from the fold's answer (3). A count that skipped the fold
 * cannot match.
 */
const SLOT_ROWS: RosterSlot[] = [
  { memberId: ANA, writerId: ANA, seq: 1, state: 'in' },
  { memberId: ME, writerId: ANA, seq: 1, state: 'in' },
  { memberId: BEN, writerId: ANA, seq: 2, state: 'in' },
  { memberId: BEN, writerId: BEN, seq: 1, state: 'out' },
  { memberId: CARA, writerId: ANA, seq: 1, state: 'in' },
];

function installRoomDb(messageRows: Row[]) {
  const instance = sqlite.instances.get('tacendum.sqlite')!;
  const base = instance.execute.getMockImplementation()!;
  instance.execute.mockImplementation(
    async (sql: string, params?: unknown[]) => {
      const s = String(sql);
      if (s.includes('FROM messages')) return { rows: messageRows };
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

const row = (r: Row): Row => ({
  peerId: ROOM,
  direction: 'in',
  status: 'received',
  deletedAt: null,
  ...r,
});

/** The fixture room: creation, talk, a counted add, a leave, two declined
 * writes, a timer slot, and one outsider message. */
const ROOM_ROWS: Row[] = [
  row({
    msgId: 'W1',
    body: JSON.stringify({
      tcm: 'grp.new',
      g: ROOM,
      nm: 'Kitchen',
      ms: [ANA, ME, BEN, CARA],
      n: 1,
    }),
    ts: T0,
    authorId: ANA,
  }),
  row({
    msgId: `${BEN}.M1`,
    // A payload trying to smuggle a name: it may render as WORDS, but it
    // must never become a label.
    body: 'hello from {"name":"Mallory"}',
    ts: T0 + 60_000,
    authorId: BEN,
  }),
  row({
    msgId: `${CARA}.M1`,
    body: 'cara here',
    ts: T0 + 61_000,
    authorId: CARA,
  }),
  row({
    msgId: `${EVE}.M1`,
    body: 'call me You',
    ts: T0 + 62_000,
    authorId: EVE,
  }),
  row({
    msgId: 'W2',
    body: JSON.stringify({ tcm: 'grp.roster', g: ROOM, m: BEN, s: 'in', n: 2 }),
    ts: T0 + 120_000,
    authorId: ANA,
  }),
  row({
    msgId: 'W3',
    body: JSON.stringify({ tcm: 'grp.roster', g: ROOM, m: BEN, s: 'out', n: 1 }),
    ts: T0 + 180_000,
    authorId: BEN,
  }),
  row({
    msgId: 'W4',
    body: JSON.stringify({ tcm: 'grp.roster', g: ROOM, m: BEN, s: 'out', n: 3 }),
    ts: T0 + 240_000,
    authorId: CARA,
  }),
  row({
    msgId: 'W5',
    body: JSON.stringify({ tcm: 'grp.del', g: ROOM, n: 4 }),
    ts: T0 + 300_000,
    authorId: CARA,
  }),
  row({
    msgId: 'W6',
    body: JSON.stringify({ tcm: 'grp.set', g: ROOM, s: 3600, n: 5 }),
    ts: T0 + 360_000,
    authorId: CARA,
  }),
  row({
    msgId: `${DAN}.M1`,
    body: 'wait, what happened?',
    ts: T0 + 420_000,
    authorId: DAN,
    outsider: 1,
  }),
];

beforeEach(async () => {
  await db.close();
  sqlite.reset();
  db.setWorkspace('real');
  await db.initDb();
  installRoomDb(ROOM_ROWS);
});

afterEach(async () => {
  jest.restoreAllMocks();
  await db.close();
});

test('membership announcements are attributed system sentences — counted, sovereign, and declined alike', async () => {
  const tree = await renderThread();
  const text = renderedText(tree);

  // Counted (the owner's lane) and sovereign (the self lane).
  expect(text).toContain('Ana started this room.');
  expect(text).toContain('Ana added Ben.');
  expect(text).toContain('Ben left.');
  // Declined, attributed, never silent — and the sentence names the
  // one writer whose roster writes count.
  expect(text).toContain(
    'Cara tried to remove Ben. Only Ana can change who’s in this room.',
  );
  expect(text).toContain(
    'Cara tried to delete this room for everyone. Only Ana can do that.',
  );
  // The applied timer announcement.
  expect(text).toContain('Cara set disappearing messages to 1 hour.');

  // Announcements are rows, not bubbles: none of the grp.* rows renders as
  // a message bubble.
  for (const id of ['W1', 'W2', 'W3', 'W4', 'W5', 'W6']) {
    expect(
      tree.root.findAllByProps({ testID: `room-event-${id}` }).length,
    ).toBeGreaterThan(0);
    expect(tree.root.findAllByProps({ testID: `msg-${id}` }).length).toBe(0);
  }
});

test('the author label is the authenticated authorId’s name — never a payload field, never a self-chosen "You"', async () => {
  const tree = await renderThread();

  const labelText = (msgId: string): string => {
    const nodes = tree.root.findAllByProps({ testID: `author-${msgId}` });
    expect(nodes.length).toBeGreaterThan(0);
    return String(nodes[0]!.props.children);
  };

  expect(labelText(`${BEN}.M1`)).toBe('Ben');
  expect(labelText(`${CARA}.M1`)).toBe('Cara');
  // The words a payload smuggled render as words, never as a label.
  const allLabels = tree.root
    .findAll(n => String(n.props?.testID ?? '').startsWith('author-'))
    .map(n => String(n.props.children));
  expect(allLabels).not.toContain('Mallory');
  // A person who shared the name "You" may not forge my own voice: the
  // label degrades to their id fragment.
  expect(labelText(`${EVE}.M1`)).not.toBe('You');
  expect(labelText(`${EVE}.M1`)).toContain(EVE.slice(-8));
});

test('an outsider row is tagged, attributed, and structurally distinct from a member’s bubble — and its words are not dropped', async () => {
  const tree = await renderThread();
  const text = renderedText(tree);

  // Tagged and attributed (the sentence shape).
  expect(text).toContain('Dan isn’t in this room.');
  // Never silently dropped: the words are real conversation.
  expect(text).toContain('wait, what happened?');
  // Structurally distinct: an outsider row exists, and no member-bubble
  // node was rendered for that message.
  expect(
    tree.root.findAllByProps({ testID: `outsider-${DAN}.M1` }).length,
  ).toBeGreaterThan(0);
  expect(tree.root.findAllByProps({ testID: `msg-${DAN}.M1` }).length).toBe(0);
  // And a member's message from the same render IS a bubble, so the
  // distinction cannot pass vacuously.
  expect(
    tree.root.findAllByProps({ testID: `msg-${BEN}.M1` }).length,
  ).toBeGreaterThan(0);
});

test('a membership announcement does not swallow a neighbouring bubble’s clock', async () => {
  // The exact defect the `system` set exists to prevent: a bubble
  // whose NEXT row is a same-minute announcement keeps its clock label,
  // because a system row prints no clock of its own. If grp.roster were
  // missing from the set, showClock would see an ordinary neighbour with an
  // identical clock label and print nothing.
  installRoomDb([
    row({
      msgId: `${ME}.M9`,
      direction: 'out',
      status: 'sent',
      body: 'mine',
      ts: T0,
      authorId: ME,
    }),
    row({
      msgId: 'W9',
      body: JSON.stringify({
        tcm: 'grp.roster',
        g: ROOM,
        m: CARA,
        s: 'in',
        n: 6,
      }),
      ts: T0 + 10_000,
      authorId: ANA,
    }),
  ]);
  const tree = await renderThread();
  expect(renderedText(tree)).toContain(clockLabel(T0));
});

test('two same-direction bubbles from different authors do not group — each speaker keeps their label', async () => {
  installRoomDb([
    row({ msgId: `${BEN}.M2`, body: 'one', ts: T0, authorId: BEN }),
    row({ msgId: `${CARA}.M2`, body: 'two', ts: T0 + 5_000, authorId: CARA }),
  ]);
  const tree = await renderThread();
  // Both are firstInGroup, so both carry author labels — grouping by
  // direction alone would have hidden Cara's.
  expect(
    tree.root.findAllByProps({ testID: `author-${BEN}.M2` }).length,
  ).toBeGreaterThan(0);
  expect(
    tree.root.findAllByProps({ testID: `author-${CARA}.M2` }).length,
  ).toBeGreaterThan(0);
});

test('the header names the room, opens the room profile, and no rendered text contains the room id', async () => {
  const onOpenGroupProfile = jest.fn();
  const onOpenPeerProfile = jest.fn();
  const onStartCall = jest.fn();
  const tree = await renderThread({
    onOpenGroupProfile,
    onOpenPeerProfile,
    onStartCall,
  });
  const text = renderedText(tree);

  expect(text).toContain('Kitchen');
  expect(text).toContain('Room');
  // The two-seat commitment may not appear over a roster.
  expect(text).not.toContain('Just you two');
  // No screen renders a room's id.
  expect(text).not.toContain(ROOM);

  // The name opens the ROOM's surface, not a two-person profile.
  const header = tree.root.findByProps({ testID: 'thread-room-header' });
  await ReactTestRenderer.act(async () => header.props.onPress());
  expect(onOpenGroupProfile).toHaveBeenCalled();
  expect(onOpenPeerProfile).not.toHaveBeenCalled();

  // No call controls in a room, even with the handler offered.
  expect(tree.root.findAllByProps({ testID: 'start-call' }).length).toBe(0);
  expect(tree.root.findAllByProps({ testID: 'start-call-audio' }).length).toBe(0);
});

test('the room header wears the RoomMark and counts its people from the FOLD — and VoiceOver hears all three', async () => {
  // Precondition, the decoy lesson: this fixture's slots actually fold to 3
  // — Ben's sovereign out subtracting him is what separates "folded" from
  // "counted the rows". A seed the fold cannot distinguish would let a
  // naive count pass as this test.
  expect(foldRoster(ANA, SLOT_ROWS).members).toEqual(
    [ANA, CARA, ME].sort(),
  );

  const tree = await renderThread();
  const header = tree.root.findByProps({ testID: 'thread-room-header' });

  // The signal: the walled square, not the person disc, in the same slot.
  expect(header.findAllByType(RoomMark).length).toBe(1);
  expect(header.findAllByType(Avatar).length).toBe(0);

  // The count, in the header's own words — and NOT the unfolded 4 or 5.
  const text = renderedText(tree);
  expect(text).toContain('Room · 3 people');
  expect(text).not.toContain('4 people');
  expect(text).not.toContain('5 people');

  // VoiceOver: the name, the word, the count; the action moves to the hint.
  expect(header.props.accessibilityLabel).toBe('Kitchen, room, 3 people');
  expect(header.props.accessibilityHint).toBe('Opens room details');
});

test('a 1:1 header is unchanged: the circle, "Just you two", and no room vocabulary anywhere', async () => {
  installRoomDb([]); // no anchor for BEN, so this thread is a person's
  const tree = await renderThread({ peerId: BEN });

  // Precondition: this rendered as a 1:1 — the peer header, not the room's.
  const header = tree.root.findByProps({ testID: 'thread-peer-header' });
  expect(
    tree.root.findAllByProps({ testID: 'thread-room-header' }).length,
  ).toBe(0);

  // The circle, and no mark anywhere on the screen.
  expect(header.findAllByType(Avatar).length).toBe(1);
  expect(tree.root.findAllByType(RoomMark).length).toBe(0);

  // The two-seat commitment stands, and the room's word appears nowhere.
  const text = renderedText(tree);
  expect(text).toContain('Just you two');
  expect(text).not.toMatch(/\bRoom\b/);
  expect(text).not.toMatch(/\d+ (person|people)/);

  // The label is today's exactly; the room hint does not leak across.
  expect(header.props.accessibilityLabel).toBe('Open their profile');
  expect(header.props.accessibilityHint).toBeUndefined();
});

test('Dynamic Type XXL cannot clip the room header: a floor-height control and a fixed-box mark', async () => {
  const tree = await renderThread();
  const header = tree.root.findByProps({ testID: 'thread-room-header' });
  // Precondition: the room header, wearing the mark.
  const mark = header.findByType(RoomMark);

  // The header control is a floor, never a ceiling: scaled text grows it.
  const style = StyleSheet.flatten(
    (header.props.style as (s: { pressed: boolean }) => unknown)({
      pressed: false,
    }) as Parameters<typeof StyleSheet.flatten>[0],
  ) as Record<string, number | string | undefined>;
  expect(style.minHeight).toBe(44);
  expect(style.height).toBeUndefined();

  // The mark's monogram holds still inside its fixed box — letters that do
  // not scale cannot clip against the walls (Avatar's own contract).
  const markText = mark.findByType(Text);
  expect(markText.props.allowFontScaling).toBe(false);

  // The room name ellipsizes on its one line rather than clipping.
  const nameText = header
    .findAllByType(Text)
    .find(n => n.props.children === 'Kitchen');
  expect(nameText).toBeTruthy();
  expect(nameText!.props.numberOfLines).toBe(1);
});

test('the composer fans out — fanOut with the room id, never sendText — and carries the full 1:1 set: attach drawer and mic', async () => {
  const fanOut = jest
    .spyOn(messaging, 'fanOut')
    .mockResolvedValue({ localMsgId: `${ME}.MX`, skipped: [] });
  const sendText = jest.spyOn(messaging, 'sendText').mockResolvedValue();

  const tree = await renderThread();
  // Every send path underneath is room-aware now,
  // so the room composer offers everything the 1:1 composer offers: the +
  // drawer (photos, camera, document, location) and the microphone.
  expect(
    tree.root.findAllByProps({ testID: 'composer-attach' }).length,
  ).toBeGreaterThan(0);
  expect(
    tree.root.findAllByProps({ testID: 'composer-mic' }).length,
  ).toBeGreaterThan(0);

  const input = tree.root.findByProps({ testID: 'composer-input' });
  await ReactTestRenderer.act(async () =>
    input.props.onChangeText('hello room'),
  );
  const send = tree.root.findByProps({ testID: 'composer-send' });
  await ReactTestRenderer.act(async () => send.props.onPress());

  expect(fanOut).toHaveBeenCalledWith(ROOM, 'hello room');
  expect(sendText).not.toHaveBeenCalled();
});

test('a room reply rides sendReply with the row’s own composite key, and the chip names the AUTHENTICATED author', async () => {
  const sendReply = jest.spyOn(messaging, 'sendReply').mockResolvedValue();
  const fanOut = jest
    .spyOn(messaging, 'fanOut')
    .mockResolvedValue({ localMsgId: `${ME}.MX`, skipped: [] });

  const tree = await renderThread();
  const bubble = tree.root.findByProps({ testID: `msg-${BEN}.M1` });
  await ReactTestRenderer.act(async () => bubble.props.onLongPress());
  await ReactTestRenderer.act(async () =>
    tree.root.findByProps({ testID: `reply-${BEN}.M1` }).props.onPress(),
  );

  // The chip's subject is the row's authenticated authorId — my name for
  // Ben — never the room's own ref.
  const chip = tree.root.findByProps({ testID: 'composer-chip' });
  expect(renderedText(tree)).toContain('Replying to Ben');
  expect(chip).toBeTruthy();

  const input = tree.root.findByProps({ testID: 'composer-input' });
  await ReactTestRenderer.act(async () => input.props.onChangeText('me too'));
  await ReactTestRenderer.act(async () =>
    tree.root.findByProps({ testID: 'composer-send' }).props.onPress(),
  );

  // The SAME branch as a 1:1 reply: sendReply (room-aware underneath),
  // addressed by the composite row key — never a bare fanOut of the text,
  // which would flatten the answer into an unthreaded message.
  expect(sendReply).toHaveBeenCalledWith(ROOM, `${BEN}.M1`, 'in', 'me too');
  expect(fanOut).not.toHaveBeenCalled();
});

test('rooms send no read receipts, and the identity-change skip banner names who is not receiving', async () => {
  // RN's jest mock leaves AppState.currentState as a mock FUNCTION, which
  // the screen's foreground guard reads as "not active" — so without this
  // the receipt is suppressed by the wrong gate and the assertion below
  // passes vacuously (the fixture never reaches the code under test).
  const { AppState } = require('react-native');
  const priorState = AppState.currentState;
  Object.defineProperty(AppState, 'currentState', {
    value: 'active',
    configurable: true,
    writable: true,
  });

  const receipt = jest.spyOn(messaging, 'sendReadReceipt').mockResolvedValue();
  const skipped = jest
    .spyOn(messaging, 'skippedInRoom')
    .mockReturnValue([BEN]);
  const tree = await renderThread();

  // The design: the room never dials the receipt path at all — even foregrounded,
  // with unread rows on screen.
  expect(receipt).not.toHaveBeenCalled();
  Object.defineProperty(AppState, 'currentState', {
    value: priorState,
    configurable: true,
    writable: true,
  });

  // The design: the skip is loud, named, and the composer stays (no hard pause).
  // With an empty draft the send slot legitimately holds the mic now that
  // rooms record voice notes too, so "the composer stays" is the input.
  expect(skipped).toHaveBeenCalledWith(ROOM);
  const text = renderedText(tree);
  expect(text).toContain(
    'Ben isn’t receiving messages in this room until you review their safety number change.',
  );
  expect(
    tree.root.findAllByProps({ testID: 'composer-input' }).length,
  ).toBeGreaterThan(0);
});

test('the owner’s identity-change banner is one sentence louder — roster changes wait too', async () => {
  jest.spyOn(messaging, 'skippedInRoom').mockReturnValue([ANA]);
  const tree = await renderThread();
  const text = renderedText(tree);
  expect(text).toContain(
    'Ana isn’t receiving messages in this room until you review their safety number change.',
  );
  expect(text).toContain(
    'They run this room, so changes to who’s in it also wait until you review.',
  );
});

test('the room rail carries the 1:1 set — react fans through sendReaction with the row key; reply offered on theirs; edit and "For everyone" only on MINE', async () => {
  const sendReaction = jest
    .spyOn(messaging, 'sendReaction')
    .mockResolvedValue();
  const myRow = row({
    msgId: `${ME}.M9`,
    direction: 'out',
    status: 'sent',
    body: 'my own words',
    ts: T0 + 500_000,
    authorId: ME,
  });
  installRoomDb([...ROOM_ROWS, myRow]);
  const tree = await renderThread();

  // A MEMBER's bubble: react and reply are live; edit and the cross-phone
  // delete stay withheld — their words are theirs, in a room as in a 1:1.
  const bubble = tree.root.findByProps({ testID: `msg-${BEN}.M1` });
  await ReactTestRenderer.act(async () => bubble.props.onLongPress());
  await ReactTestRenderer.act(async () =>
    tree.root.findByProps({ testID: 'react-❤️' }).props.onPress(),
  );
  // The SAME branch as 1:1: sendReaction (room-aware underneath), addressed
  // by the row's composite key — the id every member's phone shares.
  expect(sendReaction).toHaveBeenCalledWith(ROOM, `${BEN}.M1`, 'in', '❤️');
  await ReactTestRenderer.act(async () => bubble.props.onLongPress());
  expect(
    tree.root.findAllByProps({ testID: `reply-${BEN}.M1` }).length,
  ).toBeGreaterThan(0);
  expect(tree.root.findAllByProps({ testID: `edit-${BEN}.M1` }).length).toBe(0);
  await ReactTestRenderer.act(async () =>
    tree.root.findByProps({ testID: `delete-${BEN}.M1` }).props.onPress(),
  );
  expect(
    tree.root.findAllByProps({ testID: `delete-everyone-${BEN}.M1` }).length,
  ).toBe(0);
  // The local act stays too.
  expect(
    tree.root.findAllByProps({ testID: `delete-mine-${BEN}.M1` }).length,
  ).toBeGreaterThan(0);

  // MY OWN bubble: the full strip — reply, edit, and the cross-phone
  // retraction, each riding a room-aware path underneath.
  const mine = tree.root.findByProps({ testID: `msg-${ME}.M9` });
  await ReactTestRenderer.act(async () => mine.props.onLongPress());
  expect(
    tree.root.findAllByProps({ testID: `edit-${ME}.M9` }).length,
  ).toBeGreaterThan(0);
  await ReactTestRenderer.act(async () =>
    tree.root.findByProps({ testID: `delete-${ME}.M9` }).props.onPress(),
  );
  expect(
    tree.root.findAllByProps({ testID: `delete-everyone-${ME}.M9` }).length,
  ).toBeGreaterThan(0);
});

test('retract-for-everyone on my own room row dials sendDelete with the composite key', async () => {
  const sendDelete = jest.spyOn(messaging, 'sendDelete').mockResolvedValue();
  installRoomDb([
    ...ROOM_ROWS,
    row({
      msgId: `${ME}.M9`,
      direction: 'out',
      status: 'sent',
      body: 'take this back',
      ts: T0 + 500_000,
      authorId: ME,
    }),
  ]);
  const tree = await renderThread();
  const mine = tree.root.findByProps({ testID: `msg-${ME}.M9` });
  await ReactTestRenderer.act(async () => mine.props.onLongPress());
  await ReactTestRenderer.act(async () =>
    tree.root.findByProps({ testID: `delete-${ME}.M9` }).props.onPress(),
  );
  await ReactTestRenderer.act(async () =>
    tree.root.findByProps({ testID: `delete-everyone-${ME}.M9` }).props.onPress(),
  );
  expect(sendDelete).toHaveBeenCalledWith(ROOM, `${ME}.M9`);
});

test('a room screenshot notice names WHO by the authenticated author — never peerRef, never a payload field, never a self-chosen "You"', async () => {
  installRoomDb([
    // Precondition: an ordinary bubble proves the room renders room-wise
    // (author labels wired), so the shot assertions below cannot pass on a
    // thread that quietly fell back to the 1:1 path.
    row({ msgId: `${BEN}.M1`, body: 'hello', ts: T0, authorId: BEN }),
    row({
      msgId: `${BEN}.S1`,
      body: '{"tcm":"shot"}',
      ts: T0 + 30_000,
      authorId: BEN,
    }),
    // A payload trying to smuggle a subject beside its tcm: zod strips it,
    // and the sentence must come from authorId regardless.
    row({
      msgId: `${CARA}.S1`,
      body: '{"tcm":"shot","name":"Mallory"}',
      ts: T0 + 60_000,
      authorId: CARA,
    }),
    // Eve shared the display name "You": the forged outgoing sentence.
    row({
      msgId: `${EVE}.S1`,
      body: '{"tcm":"shot"}',
      ts: T0 + 90_000,
      authorId: EVE,
    }),
    // My own notice in a room still reads as my own act.
    row({
      msgId: `${ME}.S1`,
      direction: 'out',
      status: 'sent',
      body: '{"tcm":"shot"}',
      ts: T0 + 120_000,
      authorId: ME,
    }),
  ]);
  const tree = await renderThread();

  // Precondition first: the room really renders authenticated author labels.
  expect(
    tree.root.findAllByProps({ testID: `author-${BEN}.M1` }).length,
  ).toBeGreaterThan(0);

  const shotSentence = (msgId: string): string => {
    const nodes = tree.root.findAllByProps({ testID: `shot-${msgId}` });
    expect(nodes.length).toBeGreaterThan(0);
    return renderedTextOf(nodes[0]!);
  };

  // Named by the authenticated sender, exactly as the design requires.
  expect(shotSentence(`${BEN}.S1`)).toContain('Ben took a screenshot.');
  // The smuggled payload name renders NOWHERE; Cara's row is still Cara's.
  expect(shotSentence(`${CARA}.S1`)).toContain('Cara took a screenshot.');
  expect(renderedText(tree)).not.toContain('Mallory');
  // A self-chosen "You" cannot forge my voice: the label degrades to the id
  // fragment (nameFor's guard), so the sentence still names SOMEONE — and
  // never the outgoing sentence.
  const eve = shotSentence(`${EVE}.S1`);
  expect(eve).not.toContain('You took a screenshot.');
  expect(eve).toContain(EVE.slice(-8));
  // My own row keeps the outgoing sentence.
  expect(shotSentence(`${ME}.S1`)).toContain('You took a screenshot.');
  // And the 1:1 fallback ('They…', peerRef) appears nowhere: every room
  // subject came through the authenticated path.
  expect(renderedText(tree)).not.toContain('They took a screenshot.');
});

/**
 * History sharing in the thread. Two surfaces: the
 * announcement everyone sees, and the second-hand marker on a relayed row.
 */
test('the room is TOLD when history is shared, by name and by extent', async () => {
  installRoomDb([
    ...ROOM_ROWS,
    row({
      msgId: 'W-HIST',
      body: JSON.stringify({ tcm: 'grp.hist', g: ROOM, n: 9, to: CARA, c: 50 }),
      ts: T0 + 600_000,
      authorId: ANA, // the owner: a counted share
    }),
  ]);
  const text = renderedText(await renderThread());
  // Rule 3: the authors could not consent, because their words were already
  // sent. Being told is the one thing they get, so it is not optional.
  expect(text).toContain('Ana shared 50 earlier messages with Cara.');
});

test('a NON-OWNER share renders declined and attributed, exactly as a roster write does', async () => {
  installRoomDb([
    ...ROOM_ROWS,
    row({
      msgId: 'W-HIST2',
      body: JSON.stringify({ tcm: 'grp.hist', g: ROOM, n: 9, to: CARA, c: 1 }),
      ts: T0 + 600_000,
      authorId: BEN, // not the owner
    }),
  ]);
  const text = renderedText(await renderThread());
  expect(text).toContain(
    'Ben tried to share 1 earlier message with Cara. Only Ana can share this room’s history.',
  );
});

test('a relayed row is visibly second-hand and names the RELAYER, not just the author', async () => {
  installRoomDb([
    ...ROOM_ROWS,
    row({
      msgId: `${BEN}.RELAYED`,
      body: 'what Ben said before I arrived',
      ts: T0 + 700_000,
      authorId: BEN,
      sharedBy: ANA,
    }),
  ]);
  const tree = await renderThread();

  // The tag names Ana FIRST: the transcript arrived over ANA's ratchet, so
  // Ana is the only party here whose identity was actually established. Ben's
  // authorship is Ana's claim about Ben, and the sentence says so.
  const tag = tree.root.findByProps({ testID: `shared-tag-${BEN}.RELAYED` });
  const tagText = String(tag.props.children);
  expect(tagText).toContain('Ana shared this');
  expect(tagText).toContain('Ben wrote it, if Ana’s copy is right');

  // The message itself renders as an ORDINARY bubble underneath. The tag
  // annotates it; it does not replace it.
  tree.root.findByProps({ testID: `msg-${BEN}.RELAYED` });
  expect(renderedText(tree)).toContain('what Ben said before I arrived');
});

test('a relayed PHOTO is still a photo — the relay annotates content, it does not degrade it', async () => {
  // The defect this pins: relayed rows once rendered through a text-only
  // block, so every relayed image, file, voice note and location came out as
  // 'Unsupported message — update Tacendum'. A newcomer handed a room's
  // history would have been told to update their app once per photo.
  installRoomDb([
    ...ROOM_ROWS,
    row({
      msgId: `${BEN}.RELAYIMG`,
      body: JSON.stringify({ tcm: 'image', att: 'blob-1', key: 'a2V5', w: 100, h: 80 }),
      ts: T0 + 800_000,
      authorId: BEN,
      sharedBy: ANA,
    }),
  ]);
  const tree = await renderThread();
  const node = tree.root.findByProps({ testID: `shared-${BEN}.RELAYIMG` });
  const text = renderedTextOf(node);
  expect(text).toContain('Ana shared this');
  expect(text).not.toContain('Unsupported message');
  // It went through the image branch, the same one a first-hand photo uses
  // (one content switch, no second copy for rooms).

});

test('a relayed row keeps its ORIGINAL clock — when it was said is the point of history', async () => {
  // Found by mutation: listing relayed rows among the full-width system rows
  // passed the whole suite, and system rows print NO clock. Shared history
  // without timestamps is a wall of undated text — the one thing a newcomer
  // needs from it is when things were said.
  const said = T0 + 700_000;
  installRoomDb([
    ...ROOM_ROWS,
    row({
      msgId: `${BEN}.RELAYED`,
      body: 'what Ben said before I arrived',
      ts: said,
      authorId: BEN,
      sharedBy: ANA,
    }),
  ]);
  const tree = await renderThread();
  const node = tree.root.findByProps({ testID: `shared-${BEN}.RELAYED` });
  const expected = new Date(said).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  });
  expect(renderedTextOf(node)).toContain(expected);
});

test('the second-hand claim reaches VoiceOver as its own utterance, before the message', async () => {
  installRoomDb([
    ...ROOM_ROWS,
    row({
      msgId: `${BEN}.RELAYED`,
      body: 'what Ben said before I arrived',
      ts: T0 + 700_000,
      authorId: BEN,
      sharedBy: ANA,
    }),
  ]);
  const tree = await renderThread();
  // A provenance warning that arrives AFTER the content has been read out is
  // a warning that came too late, so the tag carries its own label rather
  // than relying on the bubble's.
  const tag = tree.root.findByProps({ testID: `shared-tag-${BEN}.RELAYED` });
  expect(tag.props.accessibilityLabel).toContain('Ana shared this');
  expect(tag.props.accessible).toBe(true);
});



/** All Text content under one node, joined — for per-row sentences. */
function renderedTextOf(node: ReactTestRenderer.ReactTestInstance): string {
  return node
    .findAllByType(require('react-native').Text)
    .map(n =>
      Array.isArray(n.props.children)
        ? n.props.children.join('')
        : String(n.props.children ?? ''),
    )
    .join('\n');
}

/**
 * THE PRE-CONSENT TEACHING LINE. A runtime test showed a stranger staring at three
 * unanswered @mentions with no hint the agent never heard them: the server's
 * refusal (correct) was invisible to the person it protects. In a room
 * whose roster class (∨ marker) says an agent is present and THIS member's
 * consent is undecided or refused, the thread now renders one quiet local
 * line — the room-skip banner's shape — naming the agent and pointing at the
 * room's settings. LOCAL render only: no envelope, no announcement (consent
 * announcements stay decision-time). It disappears the moment consent is
 * 'consented'.
 */
describe('the pre-consent teaching line', () => {
  const AGENT = ulid('AGT');

  function installConsentDb(opts: {
    consent?: 'consented' | 'refused';
    classed?: boolean;
    machine?: boolean;
  } = {}) {
    const instance = sqlite.instances.get('tacendum.sqlite')!;
    const base = instance.execute.getMockImplementation()!;
    instance.execute.mockImplementation(
      async (sql: string, params?: unknown[]) => {
        const s = String(sql);
        if (s.includes('FROM machine_peers')) {
          return { rows: opts.machine === true ? [{ peerId: AGENT }] : [] };
        }
        if (s.includes('DISTINCT authorId FROM messages')) return { rows: [] };
        if (s.includes('FROM agent_consent')) {
          return {
            rows:
              opts.consent !== undefined && params?.[0] === AGENT
                ? [{ state: opts.consent }]
                : [],
          };
        }
        if (s.includes('FROM messages')) return { rows: [] };
        if (s.includes('SELECT groupId, ownerId, name FROM groups')) {
          return params?.[0] === ROOM
            ? { rows: [{ groupId: ROOM, ownerId: ANA, name: 'Kitchen' }] }
            : { rows: [] };
        }
        if (s.includes('FROM group_members')) {
          return params?.[0] === ROOM
            ? {
                rows: [
                  { memberId: ANA, writerId: ANA, seq: 1, state: 'in', class: null },
                  { memberId: ME, writerId: ANA, seq: 1, state: 'in', class: null },
                  {
                    memberId: AGENT,
                    writerId: ANA,
                    seq: 1,
                    state: 'in',
                    class: opts.classed === false ? null : 'integration',
                  },
                ],
              }
            : { rows: [] };
        }
        if (s.includes('FROM chats') && s.includes('ORDER BY')) {
          return {
            rows: [
              { peerId: ANA, displayName: 'Ana', localName: null },
              { peerId: AGENT, displayName: 'Claude', localName: null },
            ],
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
      },
    );
  }

  test('UNDECIDED: the line renders, names the agent, and points at the room’s settings', async () => {
    installConsentDb({});
    const tree = await renderThread();
    const hint = tree.root.findByProps({ testID: 'room-consent-hint' });
    const text = renderedTextOf(hint);
    expect(text).toContain('Claude');
    expect(text.toLowerCase()).toContain('hear');
    expect(text.toLowerCase()).toContain('settings');
  });

  test('REFUSED: the line still renders — the silence is explained, the choice named as changeable', async () => {
    installConsentDb({ consent: 'refused' });
    const tree = await renderThread();
    const hint = tree.root.findByProps({ testID: 'room-consent-hint' });
    expect(renderedTextOf(hint).toLowerCase()).toContain('settings');
  });

  test('m4: the line HEDGES — a local record the code lets drift must not assert server truth', async () => {
    // setRoomConsent writes the SERVER EDGE first and swallows a failed
    // local-record write ("the edge stands; only this client's local record
    // is poorer"), and another device of this account keeps its own record —
    // so 'undecided' here can coexist with a live edge. The line may say what
    // this iPhone knows and how sure it is; it must not flatly assert
    // non-delivery it cannot verify (there is no route to ask).
    installConsentDb({});
    const undecided = renderedTextOf(
      (await renderThread()).root.findByProps({ testID: 'room-consent-hint' }),
    );
    expect(undecided).toMatch(/likely|probably|may not/i);
    expect(undecided).not.toContain('Claude can’t hear you');
    installConsentDb({ consent: 'refused' });
    const refused = renderedTextOf(
      (await renderThread()).root.findByProps({ testID: 'room-consent-hint' }),
    );
    expect(refused).toMatch(/shouldn’t|likely|probably/i);
    expect(refused).not.toContain('Claude can’t hear you');
  });

  test('CONSENTED: the line disappears', async () => {
    installConsentDb({ consent: 'consented' });
    const tree = await renderThread();
    expect(tree.root.findAllByProps({ testID: 'room-consent-hint' }).length).toBe(0);
  });

  test('no classed/heard agent ⇒ no line — the hint never guesses from names', async () => {
    installConsentDb({ classed: false });
    const tree = await renderThread();
    expect(tree.root.findAllByProps({ testID: 'room-consent-hint' }).length).toBe(0);
  });

  test('this account’s OWN machine ⇒ no line — the owner clause needs no edge', async () => {
    installConsentDb({ machine: true });
    const tree = await renderThread();
    expect(tree.root.findAllByProps({ testID: 'room-consent-hint' }).length).toBe(0);
  });
});
