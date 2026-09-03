/**
 * @-mentions on the thread surface (the mentions contract).
 *
 * The rules these pin, each named where it is asserted:
 *  - typing `@` in a ROOM composer offers the FOLDED members — never me,
 *    never someone the fold says is out — matched against the name THIS
 *    phone shows (localName outranking the shared card, personName's rule);
 *  - choosing someone puts ONE mark in `text` and the id in `who`, in TEXT
 *    order whatever order they were picked in — marks and ids derive from
 *    one walk and cannot disagree;
 *  - the wire never carries a name;
 *  - editing into a token demotes it to visible plain text (no envelope);
 *    the chip's ✕ removes token and id together;
 *  - a reply cannot carry a mention: refused loudly at compose (out of
 *    scope by contract), and a 1:1 composer never offers the picker;
 *  - reading: `@<the name this phone uses>`, `@you` for me, unmissable —
 *    never a raw ULID, never raw JSON, surviving mark/id mismatches;
 *  - the bubble's accessibility label SAYS who was mentioned;
 *  - a mention row copies as resolved words and offers no Edit; a failed
 *    outgoing mention retries through fanOut with its stored envelope,
 *    never as sendText of the JSON.
 *
 * Harness copied from ChatThread.room.test.tsx.
 */

import { type RosterSlot } from '@tacendum/shared/group-fold';
import React from 'react';
import { StyleSheet, Text } from 'react-native';
import ReactTestRenderer from 'react-test-renderer';
import * as db from '../src/db';
import { MENTION_MARK } from '../src/envelope';
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
const ANA = ulid('ANA'); // the owner
const BEN = ulid('BEN'); // OUT by his own sovereign write — the fold excludes him
const CARA = ulid('CARA'); // locally renamed 'Sis' — the name THIS phone shows
const ME = ulid('ME1');
/** Nobody this phone knows and nobody in the room — a distinctive tail so
 * the fragment assertion cannot pass on a run of zeroes. */
const STRANGER = 'Z'.repeat(18) + 'QRSTWXYZ';

const T0 = new Date('2026-07-25T12:00:00').getTime();

/** The names THIS phone holds — the only legitimate source of a label.
 * CARA carries a LOCAL name that outranks her shared card (personName's
 * rule), so matching and rendering must both say 'Sis', never 'Cara'. */
const NAME_ROWS = [
  { peerId: ANA, displayName: 'Ana', localName: null },
  { peerId: BEN, displayName: 'Ben', localName: null },
  { peerId: CARA, displayName: 'Cara', localName: 'Sis' },
];

type Row = Record<string, unknown>;

/** Ana the owner in, me in, Cara in — and Ben admitted by Ana but OUT by
 * his own sovereign write, so the picker offering Ben would prove it read
 * slots rather than the fold. */
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
        ? n.props.children
            .map((c: unknown) => (typeof c === 'string' ? c : ''))
            .join('')
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

/** A mention body exactly as the wire carries it: marks and ids, no names. */
const mention = (text: string, who: string[]): string =>
  JSON.stringify({ tcm: 'mention', text, who });

/** Drive the composer like the keyboard would. */
function input(tree: ReactTestRenderer.ReactTestRenderer) {
  return tree.root.findByProps({ testID: 'composer-input' });
}
async function type(
  tree: ReactTestRenderer.ReactTestRenderer,
  text: string,
): Promise<void> {
  await ReactTestRenderer.act(async () => input(tree).props.onChangeText(text));
}
async function caret(
  tree: ReactTestRenderer.ReactTestRenderer,
  at: number,
): Promise<void> {
  await ReactTestRenderer.act(async () =>
    input(tree).props.onSelectionChange({
      nativeEvent: { selection: { start: at, end: at } },
    }),
  );
}
async function press(
  tree: ReactTestRenderer.ReactTestRenderer,
  testID: string,
): Promise<void> {
  await ReactTestRenderer.act(async () =>
    tree.root.findByProps({ testID }).props.onPress(),
  );
}
function has(tree: ReactTestRenderer.ReactTestRenderer, testID: string) {
  return tree.root.findAllByProps({ testID }).length > 0;
}

beforeEach(async () => {
  await db.close();
  sqlite.reset();
  db.setWorkspace('real');
  await db.initDb();
  installRoomDb([]);
});

afterEach(async () => {
  jest.restoreAllMocks();
  await db.close();
});

// --- composing --------------------------------------------------------------

test('typing @ offers the FOLDED members by the names this phone shows — never me, never the sovereign-out member', async () => {
  const tree = await renderThread();
  expect(has(tree, 'mention-picker')).toBe(false);

  await type(tree, '@');
  expect(has(tree, 'mention-picker')).toBe(true);
  // The fold's answer, not the slots': Ana and Cara are in; Ben's sovereign
  // 'out' removes him; and I am not a person I can summon.
  expect(has(tree, `mention-pick-${ANA}`)).toBe(true);
  expect(has(tree, `mention-pick-${CARA}`)).toBe(true);
  expect(has(tree, `mention-pick-${BEN}`)).toBe(false);
  expect(has(tree, `mention-pick-${ME}`)).toBe(false);

  // The row shows MY name for Cara — the one I will read in the bubble too.
  const picker = tree.root.findByProps({ testID: 'mention-picker' });
  const names = picker
    .findAllByType(Text)
    .map(n => String(n.props.children));
  expect(names).toContain('Sis');
  expect(names).not.toContain('Cara');
});

test('the picker filters as I type, against the name THIS phone shows — the shared card does not match once renamed', async () => {
  const tree = await renderThread();

  await type(tree, '@si');
  expect(has(tree, `mention-pick-${CARA}`)).toBe(true);
  expect(has(tree, `mention-pick-${ANA}`)).toBe(false);

  // 'Cara' is her shared card; this phone filed her as 'Sis'. Matching the
  // card would find a person the picker's own row does not name.
  await type(tree, '@cara');
  expect(has(tree, 'mention-picker')).toBe(false);
});

test('choosing someone sends ONE mark and the id — fanOut with a mention envelope that carries no name, never sendText', async () => {
  const fanOut = jest
    .spyOn(messaging, 'fanOut')
    .mockResolvedValue({ localMsgId: `${ME}.MX`, skipped: [] });
  const sendText = jest.spyOn(messaging, 'sendText').mockResolvedValue();
  const tree = await renderThread();

  await type(tree, '@');
  await press(tree, `mention-pick-${ANA}`);
  // The pick wrote the visible token and closed the picker.
  expect(input(tree).props.value).toBe('@Ana ');
  expect(has(tree, 'mention-picker')).toBe(false);
  expect(has(tree, 'mention-chips')).toBe(true);

  await type(tree, '@Ana hello');
  await press(tree, 'composer-send');

  expect(sendText).not.toHaveBeenCalled();
  expect(fanOut).toHaveBeenCalledTimes(1);
  const [target, body, opts] = fanOut.mock.calls[0]! as [
    string,
    string,
    { preview?: string | null },
  ];
  expect(target).toBe(ROOM);
  // The wire: one mark standing where the name was drawn, the id in `who`
  // — and the name NOWHERE. That absence is the entire design.
  expect(JSON.parse(body)).toEqual({
    tcm: 'mention',
    text: `${MENTION_MARK} hello`,
    who: [ANA],
  });
  expect(body).not.toContain('Ana');
  // My own chat list previews the words as I typed them — names resolved.
  expect(opts?.preview).toBe('@Ana hello');
});

test('marks and ids stay in TEXT order even when the second mention is inserted before the first', async () => {
  const fanOut = jest
    .spyOn(messaging, 'fanOut')
    .mockResolvedValue({ localMsgId: `${ME}.MX`, skipped: [] });
  const tree = await renderThread();

  // 'one two', then an @ in the middle, answered with Sis…
  await type(tree, 'one two');
  await caret(tree, 4);
  await type(tree, 'one @two');
  await press(tree, `mention-pick-${CARA}`);
  expect(input(tree).props.value).toBe('one @Sis two');
  // …then an @ at the very front, answered with Ana — picked SECOND,
  // standing FIRST.
  await caret(tree, 0);
  await type(tree, '@one @Sis two');
  await press(tree, `mention-pick-${ANA}`);
  expect(input(tree).props.value).toBe('@Ana one @Sis two');

  await press(tree, 'composer-send');
  const body = JSON.parse(fanOut.mock.calls[0]![1] as string) as {
    text: string;
    who: string[];
  };
  // The Nth mark is the Nth id, in the order the READER meets them — the
  // ordinal contract. Insertion order [CARA, ANA] must not survive.
  expect(body.text).toBe(`${MENTION_MARK} one ${MENTION_MARK} two`);
  expect(body.who).toEqual([ANA, CARA]);
});

test('editing into the token demotes the mention to the visible plain text — no envelope, no ghost id', async () => {
  const fanOut = jest
    .spyOn(messaging, 'fanOut')
    .mockResolvedValue({ localMsgId: `${ME}.MX`, skipped: [] });
  const tree = await renderThread();

  await type(tree, '@');
  await press(tree, `mention-pick-${ANA}`);
  await type(tree, '@Ana'); // backspace the pad space: token intact, chip kept
  expect(has(tree, 'mention-chips')).toBe(true);
  await type(tree, '@An'); // backspace INTO the token: visibly no longer Ana
  expect(has(tree, 'mention-chips')).toBe(false);

  await type(tree, '@An hi');
  await press(tree, 'composer-send');
  // Exactly the characters on screen, as plain text — what the person can
  // SEE is what travels; nobody is silently summoned.
  expect(fanOut).toHaveBeenCalledWith(ROOM, '@An hi');
});

test('the chip’s ✕ removes the token and its id together', async () => {
  const fanOut = jest
    .spyOn(messaging, 'fanOut')
    .mockResolvedValue({ localMsgId: `${ME}.MX`, skipped: [] });
  const tree = await renderThread();

  await type(tree, '@');
  await press(tree, `mention-pick-${ANA}`);
  await type(tree, '@Ana hi');
  await press(tree, 'mention-chip-remove-0');

  // Text and id left together — a ✕ that kept the words would still leak
  // the name as text on send; one that kept the id would summon invisibly.
  expect(input(tree).props.value).toBe('hi');
  expect(has(tree, 'mention-chips')).toBe(false);

  await press(tree, 'composer-send');
  expect(fanOut).toHaveBeenCalledWith(ROOM, 'hi');
});

test('a reply cannot carry a mention: refused loudly at compose, nothing sent, and the picker stays shut while replying', async () => {
  const fanOut = jest
    .spyOn(messaging, 'fanOut')
    .mockResolvedValue({ localMsgId: `${ME}.MX`, skipped: [] });
  const sendReply = jest.spyOn(messaging, 'sendReply').mockResolvedValue();
  installRoomDb([
    row({ msgId: `${CARA}.M1`, body: 'soup tonight?', ts: T0, authorId: CARA }),
  ]);
  const tree = await renderThread();

  await type(tree, '@');
  await press(tree, `mention-pick-${ANA}`);

  const bubble = tree.root.findByProps({ testID: `msg-${CARA}.M1` });
  await ReactTestRenderer.act(async () => bubble.props.onLongPress());
  await press(tree, `reply-${CARA}.M1`);
  expect(has(tree, 'composer-chip')).toBe(true);

  await press(tree, 'composer-send');
  // The refusal, in the composer's own error surface — and NOTHING went
  // out: flattening the chip into literal text would put my private name
  // for Ana on every phone in the room.
  expect(renderedText(tree)).toContain(
    'A reply can’t carry an @-mention yet. Remove the mention, or send it as its own message.',
  );
  expect(fanOut).not.toHaveBeenCalled();
  expect(sendReply).not.toHaveBeenCalled();
  // The words survive the refusal.
  expect(input(tree).props.value).toBe('@Ana ');

  // And while a reply holds the composer, typing @ arms nothing.
  await type(tree, '@Ana @');
  expect(has(tree, 'mention-picker')).toBe(false);
});

test('a 1:1 composer never opens the picker — @ there is prose', async () => {
  installRoomDb([]); // no anchor: BEN's thread is a person's
  const tree = await renderThread({ peerId: BEN });
  await type(tree, '@');
  expect(has(tree, 'mention-picker')).toBe(false);
  await type(tree, '@a');
  expect(has(tree, 'mention-picker')).toBe(false);
});

test('Dynamic Type cannot clip the picker: rows are floors, names ellipsize, and VoiceOver hears "Mention Ana"', async () => {
  const tree = await renderThread();
  await type(tree, '@');

  const pick = tree.root.findByProps({ testID: `mention-pick-${ANA}` });
  expect(pick.props.accessibilityLabel).toBe('Mention Ana');
  // minHeight, never height: scaled text grows the row instead of being
  // sliced by it (the room header's own XXL rule).
  const style = StyleSheet.flatten(
    (pick.props.style as (s: { pressed: boolean }) => unknown)({
      pressed: false,
    }) as Parameters<typeof StyleSheet.flatten>[0],
  ) as Record<string, number | string | undefined>;
  expect(style.minHeight).toBe(44);
  expect(style.height).toBeUndefined();
  // The name ellipsizes on its one line rather than clipping, and SCALES —
  // pinning the letters still would defeat the point of a name list.
  const name = pick
    .findAllByType(Text)
    .find(n => n.props.children === 'Ana')!;
  expect(name.props.numberOfLines).toBe(1);
  expect(name.props.allowFontScaling).not.toBe(false);
});

// --- reading ----------------------------------------------------------------

test('an inbound mention renders @-names this phone uses — @you for me, set apart by more than colour — and never a ULID', async () => {
  const msgId = `${CARA}.M2`;
  installRoomDb([
    row({
      msgId,
      body: mention(`${MENTION_MARK} lunch? ${MENTION_MARK}`, [ME, ANA]),
      ts: T0,
      authorId: CARA,
    }),
  ]);
  const tree = await renderThread();

  // The two spans, resolved through THIS phone's names: me as @you —
  // unmissable, the point of the feature — and Ana as my name for her.
  const spanText = (id: string) =>
    tree.root
      .findByProps({ testID: id })
      .findAllByType(Text)
      .map(n =>
        Array.isArray(n.props.children)
          ? n.props.children.join('')
          : String(n.props.children ?? ''),
      )
      .join('');
  expect(spanText(`mention-${msgId}-0`)).toBe('@you');
  expect(spanText(`mention-${msgId}-2`)).toBe('@Ana');

  // Not colour alone: the span carries weight, and @you carries a wash too.
  const self = tree.root.findByProps({ testID: `mention-${msgId}-0` });
  const selfStyle = StyleSheet.flatten(
    self.props.style as Parameters<typeof StyleSheet.flatten>[0],
  ) as Record<string, unknown>;
  expect(selfStyle.fontWeight).toBe('600');
  expect(selfStyle.backgroundColor).toBeDefined();

  // No rendered text carries a raw ULID (the no-raw-id rule, still binding).
  const text = renderedText(tree);
  expect(text).not.toContain(ME);
  expect(text).not.toContain(ANA);
  expect(text).not.toContain(ROOM);

  // The label SAYS who was mentioned — a distinction only colour carries is
  // not a distinction for everyone.
  const bubble = tree.root.findByProps({ testID: `msg-${msgId}` });
  expect(bubble.props.accessibilityLabel).toContain(
    'Sis, said: @you lunch? @Ana',
  );
  expect(bubble.props.accessibilityLabel).toContain('mentions you and Ana');
});

test('the renderer survives a mismatch: extra marks drop, extra ids are ignored, a stranger degrades to the short fragment — never JSON, never a ULID', async () => {
  installRoomDb([
    // More marks than ids: the second mark draws nothing; the words survive.
    row({
      msgId: `${ANA}.M3`,
      body: mention(`a ${MENTION_MARK} b ${MENTION_MARK} c`, [CARA]),
      ts: T0,
      authorId: ANA,
    }),
    // More ids than marks: the surplus id names nobody on screen.
    row({
      msgId: `${ANA}.M4`,
      body: mention(`x ${MENTION_MARK} y`, [ANA, CARA]),
      ts: T0 + 60_000,
      authorId: ANA,
    }),
    // An id naming nobody this phone knows: the fragment, never the ULID.
    row({
      msgId: `${ANA}.M5`,
      body: mention(`ping ${MENTION_MARK}`, [STRANGER]),
      ts: T0 + 120_000,
      authorId: ANA,
    }),
  ]);
  const tree = await renderThread();
  const text = renderedText(tree);

  // Everything readable rendered; nothing structural leaked.
  expect(text).toContain('@Sis');
  expect(text).toContain('ping');
  expect(text).not.toContain('{"tcm"');
  expect(text).not.toContain(MENTION_MARK);
  expect(text).not.toContain(STRANGER);
  expect(text).toContain(`@…${STRANGER.slice(-8)}`);
  // M3 draws exactly ONE mention span; M4's surplus id draws none for Sis…
  expect(has(tree, `mention-${ANA}.M3-1`)).toBe(true);
  expect(has(tree, `mention-${ANA}.M3-3`)).toBe(false);
  // …so '@Ana' from the surplus id must not appear in M4's bubble.
  const m4 = tree.root.findByProps({ testID: `msg-${ANA}.M4` });
  expect(
    m4
      .findAllByType(Text)
      .map(n =>
        Array.isArray(n.props.children)
          ? n.props.children.join('')
          : String(n.props.children ?? ''),
      )
      .join(''),
  ).not.toContain('@Sis');
});

test('a mention row copies as resolved words and offers Reply but never Edit — a plain row keeps Edit, so the absence is the mention’s', async () => {
  const Clipboard = require('react-native').Clipboard;
  const setString = jest
    .spyOn(Clipboard, 'setString')
    .mockImplementation(() => {});
  const mentionId = `${ME}.M6`;
  const plainId = `${ME}.M7`;
  installRoomDb([
    row({
      msgId: mentionId,
      direction: 'out',
      status: 'sent',
      body: mention(`lunch ${MENTION_MARK}?`, [ANA]),
      ts: T0,
      authorId: ME,
    }),
    row({
      msgId: plainId,
      direction: 'out',
      status: 'sent',
      body: 'plain words',
      ts: T0 + 60_000,
      authorId: ME,
    }),
  ]);
  const tree = await renderThread();

  const bubble = tree.root.findByProps({ testID: `msg-${mentionId}` });
  await ReactTestRenderer.act(async () => bubble.props.onLongPress());
  // Reply stands; Edit is withheld — an edit's wire carries only words, so
  // rewriting would strip `who` (mentions-in-edits are the contract's
  // deferred question, same as replies).
  expect(has(tree, `reply-${mentionId}`)).toBe(true);
  expect(has(tree, `edit-${mentionId}`)).toBe(false);
  // Copy hands over the words as READ — names resolved, no bare marks.
  await press(tree, `copy-${mentionId}`);
  expect(setString).toHaveBeenCalledWith('lunch @Ana?');

  // The plain row still offers Edit, so the absence above is the mention's.
  const plain = tree.root.findByProps({ testID: `msg-${plainId}` });
  await ReactTestRenderer.act(async () => plain.props.onLongPress());
  expect(has(tree, `edit-${plainId}`)).toBe(true);
});

test('the quote box of a reply-to-a-mention resolves names — never the words with the marks dropped', async () => {
  const mentionId = `${CARA}.M3`;
  const replyId = `${CARA}.M4`;
  installRoomDb([
    row({
      msgId: mentionId,
      body: mention(`${MENTION_MARK} lunch? ${MENTION_MARK}`, [CARA, ME]),
      ts: T0,
      authorId: CARA,
    }),
    // CARA answering her own mention ("as I said ↑"): ofs TRUE is the
    // replier's claim that the quoted row is her own, which quotedFor maps
    // to my 'in' copy — the resolvable reply-to-a-mention shape.
    row({
      msgId: replyId,
      body: JSON.stringify({
        tcm: 'reply',
        ref: mentionId,
        ofs: true,
        text: 'yes please',
      }),
      ts: T0 + 60_000,
      authorId: CARA,
    }),
  ]);
  const tree = await renderThread();
  const box = tree.root.findByProps({ testID: `quote-${replyId}` });
  // The quoted WORDS are the box's last text: the
  // author's name stands above them.
  const boxTexts = box.findAllByType(Text);
  const node = boxTexts[boxTexts.length - 1]!;
  const text = Array.isArray(node.props.children)
    ? node.props.children.join('')
    : String(node.props.children ?? '');
  // @Sis — CARA by the LOCAL name this phone shows (it outranks her card) —
  // and @you for me: the same resolution every sibling surface already
  // injects. Resolver-less, the marks drop and the quote reads " lunch? ".
  expect(text).toBe('@Sis lunch? @you');
});

test('the reply chip previews a mention with names resolved, not with the marks dropped', async () => {
  const mentionId = `${CARA}.M5`;
  installRoomDb([
    row({
      msgId: mentionId,
      body: mention(`${MENTION_MARK} lunch? ${MENTION_MARK}`, [CARA, ME]),
      ts: T0,
      authorId: CARA,
    }),
  ]);
  const tree = await renderThread();
  const bubble = tree.root.findByProps({ testID: `msg-${mentionId}` });
  await ReactTestRenderer.act(async () => bubble.props.onLongPress());
  await press(tree, `reply-${mentionId}`);
  expect(has(tree, 'composer-chip')).toBe(true);
  // Scoped to the CHIP: the bubble behind it resolves already, so a
  // whole-tree read would pass on the bubble's words alone.
  const chip = tree.root.findByProps({ testID: 'composer-chip' });
  const chipText = chip
    .findAllByType(Text)
    .map(n =>
      Array.isArray(n.props.children)
        ? n.props.children.join('')
        : String(n.props.children ?? ''),
    )
    .join('\n');
  expect(chipText).toContain('@Sis lunch? @you');
});

test('a failed outgoing mention shows resolved words and retries through fanOut with its stored envelope — never sendText of the JSON', async () => {
  const fanOut = jest
    .spyOn(messaging, 'fanOut')
    .mockResolvedValue({ localMsgId: `${ME}.MX`, skipped: [] });
  const sendText = jest.spyOn(messaging, 'sendText').mockResolvedValue();
  const failedId = `${ME}.M8`;
  const body = mention(`hi ${MENTION_MARK}`, [ANA]);
  installRoomDb([
    row({
      msgId: failedId,
      direction: 'out',
      status: 'error',
      body,
      ts: T0,
      authorId: ME,
    }),
  ]);
  const tree = await renderThread();

  // The failed bubble shows the words with names resolved — the vault
  // retry bug's shape (raw {"tcm": JSON beside a Try again) must not
  // return wearing an @.
  const errorNode = tree.root.findByProps({ testID: `error-${failedId}` });
  const errorText = errorNode
    .findAllByType(Text)
    .map(n =>
      Array.isArray(n.props.children)
        ? n.props.children.join('')
        : String(n.props.children ?? ''),
    )
    .join('\n');
  expect(errorText).toContain('hi @Ana');
  expect(errorText).not.toContain('{"tcm"');

  await press(tree, `retry-${failedId}`);
  await ReactTestRenderer.act(async () => {});
  // The stored envelope rides the room path it came from. sendText here
  // would fan my names out as literal message text.
  expect(fanOut).toHaveBeenCalledWith(ROOM, body);
  expect(sendText).not.toHaveBeenCalled();
});
