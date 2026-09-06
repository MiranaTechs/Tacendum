/**
 * Find in this conversation.
 *
 * The hole this closes was the top row of the gap matrix: a messenger whose
 * whole history lives on one device, with no way to find a message in it.
 * `grep -n "search" ChatThreadScreen.tsx` was empty, there is no FTS table,
 * and the date dividers are inert — so the only way to a message from three
 * weeks ago was to scroll.
 *
 * The rules pinned here:
 * - the magnifier sits in the header's right group BEFORE the call glyphs,
 * and does not scale with the type size (the back chevron's reason:
 * scaling an icon only breaks its 44pt target);
 * - pressing it swaps the whole header for the find bar, whose field
 * carries the three theming props every field in this app carries, plus
 * the input hygiene a lookup field needs;
 * - under two letters nothing is asked of the database and the bar says so;
 * - THE REFINEMENT IS NOT OPTIONAL: a body is sometimes an envelope, so a
 * three-letter query LIKE-matches inside an image's key material. SQL is
 * a prefilter; `displayText` decides;
 * - stepping calls the same reveal a tapped quote calls, and the reading
 * moves with it;
 * - closing find leaves the list where the last match left it;
 * - opening find closes the rail, and Android's Back closes find before it
 * leaves the conversation.
 *
 * The word is FIND, never Search: this makes no lookup either, and the
 * ⓘ says where it looks.
 *
 * Harness copied from ChatThread.reply.test.tsx (the scroll spy) with the
 * back-handler capture from ChatThread.back.test.tsx.
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import {
  BackHandler,
  Dimensions,
  FlatList,
  StyleSheet,
  Text,
  TextInput,
} from 'react-native';
import Svg from 'react-native-svg';
import * as db from '../src/db';
import { messaging } from '../src/messaging';
import { ChatThreadScreen } from '../src/screens/ChatThreadScreen';
import { themeTokens } from '../src/theme';
import {
  FIND_DEBOUNCE_MS,
  FIND_LIMIT,
  FIND_MIN_QUERY,
  findQueryReady,
  refineFindRows,
  stepFindCursor,
} from '../src/thread/find';

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
const PEER = 'peer-1';

type Row = Record<string, unknown>;
const row = (r: Row): Row => ({
  peerId: PEER,
  status: 'received',
  editedAt: null,
  deletedAt: null,
  ...r,
});

const A = row({
  msgId: '01AAA',
  direction: 'in',
  body: 'the door code is 4419',
  ts: T0,
});
const B = row({
  msgId: '01BBB',
  direction: 'out',
  status: 'sent',
  body: 'which door?',
  ts: T0 + 60_000,
});
/**
 * A photo, whose stored body is an envelope carrying key material. 'door'
 * appears INSIDE the key, so SQL's LIKE returns this row and the refinement
 * has to throw it away — a "result" that is a fragment of a photo's key is
 * the exact defect the prefilter comment warns about.
 */
const PHOTO = row({
  msgId: '01CCC',
  direction: 'in',
  body: JSON.stringify({
    tcm: 'image',
    att: 'blob-1',
    key: 'a2door2V5',
    w: 100,
    h: 80,
  }),
  ts: T0 + 120_000,
});
const D = row({
  msgId: '01DDD',
  direction: 'out',
  status: 'sent',
  body: 'thanks',
  ts: T0 + 180_000,
});

const ALL = [A, B, PHOTO, D];
/** What the prefilter answers for 'door', newest first. */
const PREFILTERED = [PHOTO, B, A];

let scrollToIndex: jest.SpyInstance;
let handlers: Array<() => boolean>;
let findSql: string | null;
let findParams: unknown[] | null;
let findRows: Row[];

beforeEach(async () => {
  jest.useFakeTimers();
  jest.setSystemTime(T0 + 240_000);
  scrollToIndex = jest
    .spyOn(FlatList.prototype, 'scrollToIndex')
    .mockImplementation(() => {});
  handlers = [];
  jest
    .spyOn(BackHandler, 'addEventListener')
    .mockImplementation((event, handler) => {
      expect(event).toBe('hardwareBackPress');
      handlers.push(handler as () => boolean);
      return { remove: jest.fn() };
    });
  // A session exists, so the safety panel opens with the comparison shape.
  jest.spyOn(messaging, 'getSafetyNumber').mockResolvedValue('4'.repeat(60));
  findSql = null;
  findParams = null;
  findRows = PREFILTERED;
  await db.close();
  sqlite.reset();
  db.setWorkspace('real');
  await db.initDb();
  const instance = sqlite.instances.get('tacendum.sqlite')!;
  const base = instance.execute.getMockImplementation()!;
  instance.execute.mockImplementation(async (sql: string, params?: unknown) => {
    const s = String(sql);
    // The find query is the only one that LIKEs a body.
    if (s.includes('body LIKE')) {
      findSql = s;
      findParams = params as unknown[];
      return { rows: findRows };
    }
    if (s.includes('FROM messages')) return { rows: ALL };
    if (s.includes('FROM chats')) {
      return {
        rows: [
          {
            peerId: PEER,
            displayName: 'Dawit',
            localName: null,
            lastOpenedAt: T0 + 200_000,
            // Introduced by the server and never verified, so the thread
            // carries the provenance line — the one door to the safety
            // panel that needs no identity change. Find has to close it.
            introducedBy: 'discovery',
            safetyCheckedAt: null,
          },
        ],
      };
    }
    return base(sql, params);
  });
});

afterEach(async () => {
  jest.restoreAllMocks();
  await db.close();
  jest.useRealTimers();
});

async function renderThread(): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <ChatThreadScreen
        peerId={PEER}
        onBack={jest.fn()}
        onOpenPeerProfile={jest.fn()}
        onOpenPhoto={jest.fn()}
        // Wired, so the header carries all three trailing targets — which
        // is the case the ordering and the Dynamic Type argument are about.
        onStartCall={jest.fn()}
      />,
    );
  });
  await ReactTestRenderer.act(async () => {});
  await ReactTestRenderer.act(async () => {});
  return tree;
}

function byId(tree: ReactTestRenderer.ReactTestRenderer, id: string) {
  return tree.root.findAll(n => n.props.testID === id);
}
const has = (tree: ReactTestRenderer.ReactTestRenderer, id: string) =>
  byId(tree, id).length > 0;

function press(
  tree: ReactTestRenderer.ReactTestRenderer,
  id: string,
): Promise<void> {
  return ReactTestRenderer.act(async () => {
    tree.root
      .find(n => n.props.testID === id && typeof n.props.onPress === 'function')
      .props.onPress();
  });
}

function texts(tree: ReactTestRenderer.ReactTestRenderer): string {
  return tree.root
    .findAllByType(Text)
    .map(n =>
      Array.isArray(n.props.children)
        ? n.props.children.join('')
        : String(n.props.children ?? ''),
    )
    .join('\n');
}

function field(tree: ReactTestRenderer.ReactTestRenderer) {
  return tree.root
    .findAllByType(TextInput)
    .find(n => n.props.testID === 'thread-find-field')!;
}

/** Type into the find field and let the debounce fire. */
async function type(
  tree: ReactTestRenderer.ReactTestRenderer,
  value: string,
): Promise<void> {
  await ReactTestRenderer.act(async () => {
    field(tree).props.onChangeText(value);
  });
  await ReactTestRenderer.act(async () => {
    jest.advanceTimersByTime(FIND_DEBOUNCE_MS + 10);
  });
  await ReactTestRenderer.act(async () => {});
}

async function pressBack(): Promise<boolean> {
  let consumed!: boolean;
  await ReactTestRenderer.act(async () => {
    consumed = handlers[handlers.length - 1]!();
  });
  return consumed;
}

// ------------------------------------------------------------- the algebra

describe('the matcher', () => {
  test('two letters is the floor, and whitespace is not a letter', () => {
    expect(FIND_MIN_QUERY).toBe(2);
    expect(findQueryReady('')).toBe(false);
    expect(findQueryReady('d')).toBe(false);
    expect(findQueryReady('  d  ')).toBe(false);
    expect(findQueryReady('do')).toBe(true);
  });

  test('the refinement reads WORDS, so key material never counts', () => {
    const kept = refineFindRows(
      PREFILTERED as unknown as db.MessageRow[],
      'door',
    );
    expect(kept.map(r => r.msgId)).toEqual(['01BBB', '01AAA']);
  });

  test('a reply, a room wrapper and a mention are all read through', () => {
    const reply = row({
      msgId: '01REPLY',
      direction: 'in',
      body: JSON.stringify({
        tcm: 'reply',
        ref: '01AAA',
        ofs: false,
        text: 'the door is locked',
      }),
      ts: T0,
    });
    const roomed = row({
      msgId: '01ROOM',
      direction: 'in',
      body: JSON.stringify({
        tcm: 'grp.msg',
        g: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
        m: '01ARZ3NDEKTSV4RRFFQ69G5FAW',
        rd: 'AAAAAAAAAAA',
        sq: 1,
        b: 'meet at the door',
      }),
      ts: T0,
    });
    const mention = row({
      msgId: '01MENTION',
      direction: 'in',
      // One U+FFFC mark, one id: the wire never carries a name, so the
      // words a person can find are the ones the resolver draws.
      body: JSON.stringify({
        tcm: 'mention',
        text: 'ask ￼ about it',
        who: ['01ARZ3NDEKTSV4RRFFQ69G5FAV'],
      }),
      ts: T0,
    });
    const rows = [reply, roomed] as unknown as db.MessageRow[];
    expect(refineFindRows(rows, 'door').map(r => r.msgId)).toEqual([
      '01REPLY',
      '01ROOM',
    ]);
    // A mention resolves through the injected resolver, so a query matches
    // the NAME this phone shows and never the mark or the id.
    expect(
      refineFindRows([mention] as unknown as db.MessageRow[], 'ana', () => 'Ana')
        .length,
    ).toBe(1);
    expect(
      refineFindRows([mention] as unknown as db.MessageRow[], 'ana').length,
    ).toBe(0);
  });

  test('case folds both ways', () => {
    const rows = [A] as unknown as db.MessageRow[];
    expect(refineFindRows(rows, 'DOOR').length).toBe(1);
    expect(refineFindRows(rows, 'DoOr').length).toBe(1);
  });

  test('the cursor clamps at both ends rather than wrapping', () => {
    expect(stepFindCursor(0, 3, 1)).toBe(1);
    expect(stepFindCursor(2, 3, 1)).toBe(2);
    expect(stepFindCursor(0, 3, -1)).toBe(0);
    expect(stepFindCursor(0, 0, 1)).toBe(0);
  });
});

// -------------------------------------------------------------- the screen

test('the magnifier sits before the call glyphs and does not scale', async () => {
  const tree = await renderThread();
  const control = byId(tree, 'thread-find').find(n => n.props.onPress);
  expect(control).toBeDefined();
  expect(control!.props.accessibilityLabel).toBe('Find in this conversation');

  // DRAWN, at a fixed size — house line art like the call glyphs beside it,
  // not a character in the mono face. `⌕` (U+2315) is absent from Roboto
  // Mono, so a typographic magnifier is a tofu box on any device whose
  // fallback chain misses it, and no jest run can see that. A fixed
  // width/height gives a stronger scaling guarantee than
  // `allowFontScaling={false}`: a drawing has no font to scale with.
  const art = control!.findAllByType(Svg);
  expect(art).toHaveLength(1);
  expect(art[0]!.props.width).toBe(22);
  expect(art[0]!.props.height).toBe(22);
  expect(art[0]!.props.accessibilityElementsHidden).toBe(true);
  expect(control!.findAllByType(Text)).toHaveLength(0);

  // Before the call glyphs, left to right: the header's trailing group is
  // rendered in array order, so Find must appear first in the tree.
  const order = tree.root
    .findAll(
      n =>
        typeof n.props.testID === 'string' &&
        ['thread-find', 'start-call-audio', 'start-call'].includes(
          n.props.testID,
        ) &&
        typeof n.props.onPress === 'function',
    )
    .map(n => n.props.testID);
  expect(order).toEqual(['thread-find', 'start-call-audio', 'start-call']);

  await ReactTestRenderer.act(() => tree.unmount());
});

/**
 * The Dynamic Type criterion, as the three assertions jest can actually
 * make. Whether a 320pt window at XXL
 * clips is a device reading, and it is booked; what is checkable here is
 * that the controls are FIXED and the title is the thing that yields — so
 * the controls cannot be what clips.
 */
test('at an accessibility text size all three trailing targets survive', async () => {
  const before = {
    window: { ...Dimensions.get('window') },
    screen: { ...Dimensions.get('screen') },
  };
  const small = { width: 320, height: 568, scale: 2, fontScale: 3.1 };
  Dimensions.set({ window: small, screen: small });
  try {
    const tree = await renderThread();
    // (a) the glyph is drawn at a fixed size — asserted above; (c) all three
    // targets are still in the tree at 3.1×, none dropped by a width guard.
    expect(has(tree, 'thread-find')).toBe(true);
    expect(has(tree, 'start-call-audio')).toBe(true);
    expect(has(tree, 'start-call')).toBe(true);

    // (b) the header's centre yields to the trailing group rather than
    // pushing it off: `headerCenter` is `flex: 1`, so the title compresses.
    const title = tree.root.find(
      n =>
        n.props.testID === 'thread-peer-header' &&
        typeof n.props.onPress === 'function',
    );
    const centre = title.parent!.parent!;
    expect(StyleSheet.flatten(centre.props.style)?.flex).toBe(1);

    await ReactTestRenderer.act(() => tree.unmount());
  } finally {
    Dimensions.set(before);
  }
});

test('pressing it swaps the whole header for the find bar, dressed for this theme', async () => {
  const tree = await renderThread();
  expect(has(tree, 'thread-find-bar')).toBe(false);

  await press(tree, 'thread-find');
  expect(has(tree, 'thread-find-bar')).toBe(true);
  // The header is gone, not merely covered: its back control and the call
  // glyphs go with it, so there are never two rows of chrome.
  expect(has(tree, 'thread-back')).toBe(false);
  expect(has(tree, 'start-call-audio')).toBe(false);

  const t = themeTokens();
  const input = field(tree).props;
  // The three theming props every field in this app carries.
  expect(input.keyboardAppearance).toBe(t.scheme);
  expect(input.selectionColor).toBe(t.color.pine);
  expect(input.placeholderTextColor).toBe(t.color.inkMuted);
  // And the hygiene a lookup field needs.
  expect(input.autoCorrect).toBe(false);
  expect(input.autoCapitalize).toBe('none');
  expect(input.returnKeyType).toBe('search');
  expect(input.placeholder).toBe('Find a message');
  expect(
    StyleSheet.flatten(input.style)?.minHeight,
  ).toBeGreaterThanOrEqual(t.layout.touchTarget);

  await ReactTestRenderer.act(() => tree.unmount());
});

test('under two letters nothing is asked of the database, and the bar says so', async () => {
  const tree = await renderThread();
  await press(tree, 'thread-find');
  await type(tree, 'd');

  expect(findSql).toBeNull();
  expect(texts(tree)).toContain('Type two or more letters.');

  await ReactTestRenderer.act(() => tree.unmount());
});

test('the refinement throws away a photo whose KEY matched, and counts what is left', async () => {
  const tree = await renderThread();
  await press(tree, 'thread-find');
  await type(tree, 'door');

  // The prefilter returned three rows, one of them a photo whose key
  // contains the query.
  expect(findSql).not.toBeNull();
  expect(findParams).toEqual([PEER, PEER, '%door%', '%door%', FIND_LIMIT]);
  // Deleted rows never reach the caller: the exclusion is in the SQL.
  expect(findSql).toContain('deletedAt IS NULL');
  // Two real matches, and the newest of them is the one on screen.
  expect(texts(tree)).toContain('1 of 2');

  await ReactTestRenderer.act(() => tree.unmount());
});

test('each step calls the same reveal a tapped quote calls, and the reading moves', async () => {
  const tree = await renderThread();
  await press(tree, 'thread-find');
  await type(tree, 'door');

  // The newest match is B, the second row of the conversation.
  expect(scrollToIndex).toHaveBeenLastCalledWith(
    expect.objectContaining({ index: 1, viewPosition: 0.5 }),
  );

  await press(tree, 'thread-find-next');
  expect(texts(tree)).toContain('2 of 2');
  expect(scrollToIndex).toHaveBeenLastCalledWith(
    expect.objectContaining({ index: 0, viewPosition: 0.5 }),
  );

  await press(tree, 'thread-find-previous');
  expect(texts(tree)).toContain('1 of 2');
  expect(scrollToIndex).toHaveBeenLastCalledWith(
    expect.objectContaining({ index: 1, viewPosition: 0.5 }),
  );

  await ReactTestRenderer.act(() => tree.unmount());
});

test('nothing matching says so, in the product’s own words', async () => {
  findRows = [PHOTO];
  const tree = await renderThread();
  await press(tree, 'thread-find');
  await type(tree, 'door');

  expect(texts(tree)).toContain('No message here matches that.');
  expect(texts(tree)).not.toContain('1 of');

  await ReactTestRenderer.act(() => tree.unmount());
});

/**
 * A FALSE NEGATIVE IS A LIE, and the cheapest one to ship: `ready` flips on
 * the second character, but the matches cannot answer until the debounce has
 * fired and the database has come back. Between those two moments the bar
 * knows nothing about this query and must say nothing about it. A premature
 * empty result would falsely claim that no message matches.
 */
test('nothing is claimed about a query the database has not answered yet', async () => {
  const tree = await renderThread();
  await press(tree, 'thread-find');

  // Two letters typed, and the debounce deliberately NOT advanced.
  await ReactTestRenderer.act(async () => {
    field(tree).props.onChangeText('do');
  });
  expect(findSql).toBeNull();
  expect(texts(tree)).not.toContain('No message here matches that.');
  // Nor the floor's sentence: two letters is not below the floor.
  expect(texts(tree)).not.toContain('Type two or more letters.');

  // And a refinement does not leave the old count standing over the new
  // query: 'door' answered 2, 'doorway' has answered nothing.
  await type(tree, 'door');
  expect(texts(tree)).toContain('1 of 2');
  await ReactTestRenderer.act(async () => {
    field(tree).props.onChangeText('doorway');
  });
  expect(texts(tree)).not.toContain('1 of 2');
  expect(texts(tree)).not.toContain('No message here matches that.');
  // And the steppers do not walk the old query's rows behind the hidden
  // reading: a scroll to a match with no count to explain it is the same
  // false claim in another form.
  for (const id of ['thread-find-next', 'thread-find-previous']) {
    const stepper = byId(tree, id).find(n => n.props.onPress)!;
    expect(stepper.props.disabled).toBe(true);
    expect(stepper.props.accessibilityState).toEqual({ disabled: true });
  }

  await ReactTestRenderer.act(() => tree.unmount());
});

/**
 * Two queries are in flight whenever one outlives the 400 ms that separates
 * it from the next — a long thread, or two letters that LIKE-match most
 * rows. The debounce's cleanup can cancel a timer; it cannot cancel a read
 * already issued, so the answer has to say which question it answers.
 */
test('a slow answer never overwrites the newer one', async () => {
  const gates: Array<(rows: Row[]) => void> = [];
  const instance = sqlite.instances.get('tacendum.sqlite')!;
  const previous = instance.execute.getMockImplementation()!;
  instance.execute.mockImplementation(async (sql: string, params?: unknown) => {
    if (String(sql).includes('body LIKE')) {
      return await new Promise(resolve => {
        gates.push(rows => resolve({ rows }));
      });
    }
    return previous(sql, params);
  });

  const tree = await renderThread();
  await press(tree, 'thread-find');
  await type(tree, 'door');
  expect(gates).toHaveLength(1);
  await type(tree, 'thanks');
  expect(gates).toHaveLength(2);

  // The newer question is answered first.
  await ReactTestRenderer.act(async () => {
    gates[1]!([D]);
  });
  expect(texts(tree)).toContain('1 of 1');

  // Then the older one arrives — and is dropped, not rendered: the field
  // says 'thanks', so a reading of "1 of 2" would be answering for 'door'.
  await ReactTestRenderer.act(async () => {
    gates[0]!(PREFILTERED);
  });
  expect(texts(tree)).toContain('1 of 1');
  expect(texts(tree)).not.toContain('1 of 2');

  await ReactTestRenderer.act(() => tree.unmount());
});

test('closing find leaves the list where the last match left it', async () => {
  const tree = await renderThread();
  await press(tree, 'thread-find');
  await type(tree, 'door');
  await press(tree, 'thread-find-next');

  scrollToIndex.mockClear();
  await press(tree, 'thread-find-close');

  // The bar is gone and the header is back — and nothing scrolled: jumping
  // to the end would throw away the thing the person just found.
  expect(has(tree, 'thread-find-bar')).toBe(false);
  expect(has(tree, 'thread-back')).toBe(true);
  expect(scrollToIndex).not.toHaveBeenCalled();

  await ReactTestRenderer.act(() => tree.unmount());
});

test('the ⓘ says where this looks, and it is teaching copy behind a disclosure', async () => {
  const tree = await renderThread();
  await press(tree, 'thread-find');

  const about = byId(tree, 'thread-find-about').find(n => n.props.onPress);
  expect(about).toBeDefined();
  expect(about!.props.accessibilityLabel).toBe('What this looks at');
  // Closed to begin with: teaching copy is behind the ⓘ, never in front.
  expect(texts(tree)).not.toContain('Only the messages already here.');

  await ReactTestRenderer.act(async () => {
    about!.props.onPress();
  });
  expect(texts(tree)).toContain('Only the messages already here.');
  expect(texts(tree)).toContain('Nothing is sent anywhere to find them.');

  await ReactTestRenderer.act(() => tree.unmount());
});

test('opening find closes the rail, and the panels hung off the header', async () => {
  const tree = await renderThread();
  await ReactTestRenderer.act(async () => {
    tree.root
      .find(
        n =>
          n.props.testID === 'msg-01AAA' &&
          typeof n.props.onLongPress === 'function',
      )
      .props.onLongPress();
  });
  expect(has(tree, 'react-❤️')).toBe(true);

  // The safety panel is attached UNDER the header, so find replacing the
  // header would leave it hanging off a bar that is no longer there.
  await press(tree, 'provenance-compare');
  await ReactTestRenderer.act(async () => {});
  expect(has(tree, 'safety-number')).toBe(true);

  await press(tree, 'thread-find');
  expect(has(tree, 'react-❤️')).toBe(false);
  expect(has(tree, 'safety-number')).toBe(false);

  await ReactTestRenderer.act(() => tree.unmount());
});

test('switching conversations takes find with it', async () => {
  const tree = await renderThread();
  await press(tree, 'thread-find');
  await type(tree, 'door');
  expect(texts(tree)).toContain('1 of 2');

  await ReactTestRenderer.act(async () => {
    tree.update(
      <ChatThreadScreen
        peerId="peer-2"
        onBack={jest.fn()}
        onOpenPeerProfile={jest.fn()}
        onOpenPhoto={jest.fn()}
        onStartCall={jest.fn()}
      />,
    );
  });
  await ReactTestRenderer.act(async () => {});

  // Not reachable through today's router, which keys this screen on the
  // peer — and pinned anyway, beside the photo review that joined the same
  // reset for the same reason: one conversation's query, count and rows
  // must never stand over another's messages.
  expect(has(tree, 'thread-find-bar')).toBe(false);
  expect(texts(tree)).not.toContain('1 of 2');

  await ReactTestRenderer.act(() => tree.unmount());
});

test('Android’s Back closes find before it leaves the conversation', async () => {
  const tree = await renderThread();
  await press(tree, 'thread-find');
  expect(has(tree, 'thread-find-bar')).toBe(true);

  expect(await pressBack()).toBe(true);
  expect(has(tree, 'thread-find-bar')).toBe(false);

  // With nothing open the thread yields and the router pops, exactly as
  // before — one case added to the existing handler, never a fourth one.
  expect(await pressBack()).toBe(false);

  await ReactTestRenderer.act(() => tree.unmount());
});
