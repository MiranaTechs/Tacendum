/**
 * Pin a conversation, and mark one unread.
 *
 * Two affordances the data has always supported and the list has never
 * offered. What this file holds:
 *
 * - the drawer's ORDER: reversible above irreversible, so Pin and Mark
 * unread sit above Block and Delete — the doctrine the drawer already
 * states in its own comment;
 * - the pinned MARK: a glyph in the unread gutter, hidden from assistive
 * tech and frozen against Dynamic Type, with the WORD in the row's label.
 * Two channels, never the glyph alone;
 * - Mark unread is WITHHELD when the conversation has nothing inbound
 * to mark, because `markChatUnread` is a silent no-op there and a control
 * that does nothing is the same defect as one that claims something;
 * - no cap, and the screen sorts nothing — the order comes from
 * `listChats` and the list renders it as given;
 * - NO COUNT, ever.
 *
 * Harness: the recorded op-sqlite fake, with a lever per statement.
 */

import React from 'react';
import { Text, View } from 'react-native';
import ReactTestRenderer from 'react-test-renderer';
import * as db from '../src/db';
import { ChatListScreen } from '../src/screens/ChatListScreen';
import { themeTokens } from '../src/theme';

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
const keychain = (
  jest.requireMock('tacendum-crypto') as { __keychain: Map<string, string> }
).__keychain;

const theme = themeTokens();
const T0 = new Date('2026-09-01T09:00:00').getTime();
const SAM = '01SAMZ3NDEKTSV4RRFFQ69G5FA';
const KIM = '01KIMZ3NDEKTSV4RRFFQ69G5FB';

const PROFILE: db.ProfileRow = {
  userId: '01PINDBSSDJSPC9J0E5N2AWMJ5',
  registrationId: 7,
  displayName: 'Nat',
  about: '',
  avatarB64: '',
  profileVersion: 1,
};

/**
 * A FRESH ACCOUNT PER CASE, and it is not decoration.
 *
 * The screen remembers, in module scope for the life of the process, which
 * conversations it has proven have something inbound — that memo is what
 * stops a drawer re-reading a whole conversation every time it opens. It is
 * forgotten on a change of account, so opening each case under its own id is
 * how a case starts from an empty memory instead of from the one above it.
 * Without this, the withholding case below would inherit an answer.
 */
const ACCOUNT_TAIL = '23456789ABCDEFGHJKMN';
let accountSeq = 0;
let profile: db.ProfileRow = PROFILE;
function nextProfile(): db.ProfileRow {
  const tail = ACCOUNT_TAIL[accountSeq++ % ACCOUNT_TAIL.length]!;
  return { ...PROFILE, userId: PROFILE.userId.slice(0, -1) + tail };
}

function chatRow(
  peerId: string,
  name: string,
  pinnedAt: number | null = null,
) {
  return {
    peerId,
    displayName: name,
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
    pinnedAt,
  };
}
type ChatRows = ReturnType<typeof chatRow>[];

const state: {
  chats: ChatRows;
  unread: { peerId: string; n: number }[];
  blocked: { peerId: string }[];
  /** What `listMessages` answers for the peer it is asked about. */
  messages: Record<string, { direction: string }[]>;
} = { chats: [], unread: [], blocked: [], messages: {} };

/** Every statement the screen ran, for the write assertions. */
const recorder = () => sqlite.instances.get('tacendum.sqlite')!;

beforeEach(async () => {
  await db.close();
  sqlite.reset();
  db.setWorkspace('real');
  await db.initDb();
  state.chats = [chatRow(SAM, 'Sam')];
  state.unread = [];
  state.blocked = [];
  state.messages = {};
  profile = nextProfile();
  keychain.set('lockNudge.dismissed', '1');

  const instance = recorder();
  const base = instance.execute.getMockImplementation()!;
  instance.execute.mockImplementation(
    async (sql: string, params?: unknown[]) => {
      const s = String(sql);
      if (s.includes('FROM chats ORDER BY')) return { rows: state.chats };
      if (s.includes('COUNT(*) AS n')) return { rows: state.unread };
      if (s.includes('FROM blocked_peers')) return { rows: state.blocked };
      if (s.includes('FROM messages WHERE peerId = ? ORDER BY ts, msgId')) {
        return { rows: state.messages[String(params?.[0])] ?? [] };
      }
      return base(s, params);
    },
  );
});

afterEach(async () => {
  keychain.clear();
  jest.restoreAllMocks();
  await db.close();
});

async function renderList(): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <ChatListScreen
        profile={profile}
        onOpenChat={jest.fn()}
        onOpenProfile={jest.fn()}
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
function has(tree: ReactTestRenderer.ReactTestRenderer, id: string): boolean {
  return byId(tree, id).length > 0;
}
function control(tree: ReactTestRenderer.ReactTestRenderer, id: string) {
  return tree.root.find(
    n => n.props.testID === id && typeof n.props.onPress === 'function',
  );
}
async function press(
  tree: ReactTestRenderer.ReactTestRenderer,
  id: string,
): Promise<void> {
  await ReactTestRenderer.act(async () => {
    control(tree, id).props.onPress();
  });
}
/** Open a row's drawer the way a long press does, and settle the reads it
 * starts. */
async function openDrawer(
  tree: ReactTestRenderer.ReactTestRenderer,
  peerId: string,
): Promise<void> {
  await ReactTestRenderer.act(async () => {
    byId(tree, `chat-${peerId}`)[0]!.props.onLongPress();
  });
  await ReactTestRenderer.act(async () => {});
}
/** Open a row's drawer and stop there, with the read it started still in
 * flight — the state the drawer actually paints in first. */
function openDrawerUnsettled(
  tree: ReactTestRenderer.ReactTestRenderer,
  peerId: string,
): void {
  // Synchronous `act`, deliberately: the async form drains the microtask
  // queue, which is exactly the read this case needs to catch in flight.
  ReactTestRenderer.act(() => {
    byId(tree, `chat-${peerId}`)[0]!.props.onLongPress();
  });
}
/** The drawer's rows, in the order they are painted. */
function drawerOrder(
  tree: ReactTestRenderer.ReactTestRenderer,
  peerId: string,
): string[] {
  return byId(tree, `chat-drawer-${peerId}`)[0]!
    .findAll(n =>
      /^chat-(pin|unpin|markunread|markunread-hold|block|delete)-/.test(
        String(n.props.testID ?? ''),
      ),
    )
    .map(n => String(n.props.testID))
    .filter((id, i, all) => all.indexOf(id) === i);
}
/** Everything one row renders, as text. */
function rowText(
  tree: ReactTestRenderer.ReactTestRenderer,
  peerId: string,
): string {
  return byId(tree, `chat-${peerId}`)[0]!
    .findAllByType(Text)
    .map(n => {
      const kids = n.props.children;
      return Array.isArray(kids)
        ? kids.map((c: unknown) => (typeof c === 'string' ? c : '')).join('')
        : typeof kids === 'string'
          ? kids
          : '';
    })
    .join('\n');
}

describe('the drawer grows two reversible rows', () => {
  test('Pin sits above Block and Delete, and writes the moment', async () => {
    state.messages[SAM] = [{ direction: 'in' }];
    const tree = await renderList();
    await openDrawer(tree, SAM);

    expect(has(tree, `chat-pin-${SAM}`)).toBe(true);
    expect(control(tree, `chat-pin-${SAM}`).props.accessibilityLabel).toBe(
      'Pin to the top',
    );

    // Reversible above irreversible: the drawer's own stated doctrine. The
    // order is read off the rendered tree, not assumed.
    const order = byId(tree, `chat-drawer-${SAM}`)[0]!
      .findAll(n => typeof n.props.testID === 'string')
      .map(n => String(n.props.testID))
      .filter(id => /^chat-(pin|unpin|markunread|block|delete)-/.test(id));
    expect(order.indexOf(`chat-pin-${SAM}`)).toBeLessThan(
      order.indexOf(`chat-block-${SAM}`),
    );
    expect(order.indexOf(`chat-markunread-${SAM}`)).toBeLessThan(
      order.indexOf(`chat-block-${SAM}`),
    );
    expect(order.indexOf(`chat-block-${SAM}`)).toBeLessThan(
      order.indexOf(`chat-delete-${SAM}`),
    );

    recorder().execute.mockClear();
    await press(tree, `chat-pin-${SAM}`);
    const writes = recorder()
      .execute.mock.calls.map((c: unknown[]) => String(c[0]))
      .filter((s: string) => s.includes('UPDATE chats SET pinnedAt'));
    expect(writes.length).toBe(1);
    // A moment, not a flag — and the drawer closes behind it.
    const at = (
      recorder().execute.mock.calls.find((c: unknown[]) =>
        String(c[0]).includes('UPDATE chats SET pinnedAt'),
      ) as unknown[]
    )[1] as unknown[];
    expect(typeof at[0]).toBe('number');
    expect(has(tree, `chat-pin-${SAM}`)).toBe(false);

    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('an already-pinned row offers Unpin, which writes null', async () => {
    state.chats = [chatRow(SAM, 'Sam', T0)];
    state.messages[SAM] = [{ direction: 'in' }];
    const tree = await renderList();
    await openDrawer(tree, SAM);

    expect(has(tree, `chat-pin-${SAM}`)).toBe(false);
    expect(control(tree, `chat-unpin-${SAM}`).props.accessibilityLabel).toBe(
      'Unpin',
    );

    recorder().execute.mockClear();
    await press(tree, `chat-unpin-${SAM}`);
    const call = recorder().execute.mock.calls.find((c: unknown[]) =>
      String(c[0]).includes('UPDATE chats SET pinnedAt'),
    ) as unknown[];
    expect((call[1] as unknown[])[0]).toBeNull();

    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('Mark unread rolls the clock back through the db, and says so', async () => {
    state.messages[SAM] = [{ direction: 'out' }, { direction: 'in' }];
    const tree = await renderList();
    await openDrawer(tree, SAM);

    expect(control(tree, `chat-markunread-${SAM}`).props.accessibilityLabel).toBe(
      'Mark unread',
    );

    recorder().execute.mockClear();
    await press(tree, `chat-markunread-${SAM}`);
    const marks = recorder()
      .execute.mock.calls.map((c: unknown[]) => String(c[0]))
      .filter((s: string) => s.includes('SET lastOpenedAt = COALESCE'));
    expect(marks.length).toBe(1);
    expect(has(tree, `chat-markunread-${SAM}`)).toBe(false);

    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('with nothing inbound the row is withheld, not greyed', async () => {
    // A conversation you started where they never replied. markChatUnread is
    // a no-op there, so offering it would be a control that does nothing.
    state.messages[SAM] = [{ direction: 'out' }, { direction: 'out' }];
    const tree = await renderList();
    await openDrawer(tree, SAM);

    expect(has(tree, `chat-markunread-${SAM}`)).toBe(false);
    // The falsifier: the drawer DID open, and its other rows are all there.
    expect(has(tree, `chat-pin-${SAM}`)).toBe(true);
    expect(has(tree, `chat-delete-${SAM}`)).toBe(true);

    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('nothing in the drawer moves while the answer is on its way', async () => {
    // The read behind Mark unread lands AFTER the drawer paints. Inserting
    // the row then pushed Block and Delete down 44pt under a finger already
    // travelling; collapsing a placeholder then would pull Delete up into
    // where Block had been. So the space is held from the first paint and
    // for as long as this opening lasts.
    state.messages[SAM] = [{ direction: 'in' }];
    const tree = await renderList();
    openDrawerUnsettled(tree, SAM);

    const before = drawerOrder(tree, SAM);
    expect(before).toEqual([
      `chat-pin-${SAM}`,
      `chat-markunread-hold-${SAM}`,
      `chat-block-${SAM}`,
      `chat-delete-${SAM}`,
    ]);
    // The held space is space and nothing else: no words, and VoiceOver is
    // never handed an empty control.
    const hold = byId(tree, `chat-markunread-hold-${SAM}`)[0]!;
    expect(hold.props.onPress).toBeUndefined();
    expect(hold.props.accessibilityElementsHidden).toBe(true);
    expect(hold.props.importantForAccessibility).toBe('no-hide-descendants');

    // The answer lands, in the space that was already there.
    await ReactTestRenderer.act(async () => {});
    expect(drawerOrder(tree, SAM)).toEqual([
      `chat-pin-${SAM}`,
      `chat-markunread-${SAM}`,
      `chat-block-${SAM}`,
      `chat-delete-${SAM}`,
    ]);

    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('the held space survives a NO answer too, so nothing moves either way', async () => {
    state.messages[SAM] = [{ direction: 'out' }];
    const tree = await renderList();
    openDrawerUnsettled(tree, SAM);
    expect(has(tree, `chat-markunread-hold-${SAM}`)).toBe(true);

    await ReactTestRenderer.act(async () => {});
    // Withheld — and Block and Delete are still where the
    // finger last saw them.
    expect(has(tree, `chat-markunread-${SAM}`)).toBe(false);
    expect(drawerOrder(tree, SAM)).toEqual([
      `chat-pin-${SAM}`,
      `chat-markunread-hold-${SAM}`,
      `chat-block-${SAM}`,
      `chat-delete-${SAM}`,
    ]);

    // Closed and opened again: the answer is in hand for this mount, so the
    // drawer paints its final shape at once — no held space, no row, and
    // Block and Delete in the same two places they have been throughout.
    await ReactTestRenderer.act(async () => {
      byId(tree, `chat-${SAM}`)[0]!.props.onLongPress();
    });
    openDrawerUnsettled(tree, SAM);
    expect(has(tree, `chat-markunread-hold-${SAM}`)).toBe(false);
    expect(has(tree, `chat-markunread-${SAM}`)).toBe(false);
    expect(drawerOrder(tree, SAM)).toEqual([
      `chat-pin-${SAM}`,
      `chat-block-${SAM}`,
      `chat-delete-${SAM}`,
    ]);

    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('a conversation is read once for this answer, not once per drawer', async () => {
    // db.listMessages selects every column of every message in the
    // conversation — bodies included — to compute one boolean, on the screen
    // this release just took from N+4 reads to 4.
    state.messages[SAM] = [{ direction: 'in' }];
    const tree = await renderList();
    recorder().execute.mockClear();

    const reads = () =>
      recorder()
        .execute.mock.calls.map((c: unknown[]) => String(c[0]))
        .filter((sql: string) =>
          sql.includes('FROM messages WHERE peerId = ? ORDER BY ts, msgId'),
        );

    await openDrawer(tree, SAM);
    expect(reads().length).toBe(1);
    expect(has(tree, `chat-markunread-${SAM}`)).toBe(true);

    // Close it, and a whole new mount — the return from a conversation.
    await ReactTestRenderer.act(() => tree.unmount());
    const again = await renderList();
    await openDrawer(again, SAM);

    expect(reads().length).toBe(1);
    // And the row is offered from the first paint of that drawer.
    expect(has(again, `chat-markunread-${SAM}`)).toBe(true);
    expect(has(again, `chat-markunread-hold-${SAM}`)).toBe(false);

    await ReactTestRenderer.act(() => again.unmount());
  });

  test('a NO answer is never remembered: the next drawer asks again', async () => {
    // The asymmetry that keeps the memo honest. A conversation that has
    // received something cannot un-receive it, but a conversation with
    // nothing inbound can receive something at any moment — that is what an
    // arrival is.
    state.messages[SAM] = [{ direction: 'out' }];
    const tree = await renderList();
    recorder().execute.mockClear();
    const reads = () =>
      recorder()
        .execute.mock.calls.map((c: unknown[]) => String(c[0]))
        .filter((sql: string) =>
          sql.includes('FROM messages WHERE peerId = ? ORDER BY ts, msgId'),
        );

    await openDrawer(tree, SAM);
    expect(reads().length).toBe(1);
    expect(has(tree, `chat-markunread-${SAM}`)).toBe(false);
    await ReactTestRenderer.act(() => tree.unmount());

    // They answered while you were away.
    state.messages[SAM] = [{ direction: 'out' }, { direction: 'in' }];
    const again = await renderList();
    await openDrawer(again, SAM);
    expect(reads().length).toBe(2);
    expect(has(again, `chat-markunread-${SAM}`)).toBe(true);

    await ReactTestRenderer.act(() => again.unmount());
  });

  test('an unread conversation needs no read to answer the question', async () => {
    // Already unread means inbound by definition, so the row is offered
    // without asking the messages table anything.
    state.unread = [{ peerId: SAM, n: 1 }];
    state.messages[SAM] = [];
    const tree = await renderList();
    recorder().execute.mockClear();
    await openDrawer(tree, SAM);

    expect(has(tree, `chat-markunread-${SAM}`)).toBe(true);
    expect(
      recorder()
        .execute.mock.calls.map((c: unknown[]) => String(c[0]))
        .filter((s: string) => s.includes('FROM messages WHERE peerId = ?')),
    ).toEqual([]);

    await ReactTestRenderer.act(() => tree.unmount());
  });
});

describe('a pinned conversation you then blocked', () => {
  test('can still be unpinned, from the drawer blocking leaves it', async () => {
    // listChats sorts pinned rows first whatever else is true of them, so
    // without this the person sits at the top of your home screen for good
    // and the only way back is unblock, unpin, block again.
    state.chats = [chatRow(SAM, 'Sam', T0), chatRow(KIM, 'Kim')];
    state.blocked = [{ peerId: SAM }];
    const tree = await renderList();
    await openDrawer(tree, SAM);

    // Precondition: this really is the blocked drawer — the one whose whole
    // subject is unblocking, with no Block and no Delete in it.
    expect(has(tree, `chat-unblock-${SAM}`)).toBe(true);
    expect(has(tree, `chat-block-${SAM}`)).toBe(false);
    expect(has(tree, `chat-delete-${SAM}`)).toBe(false);
    // And no Mark unread: a row that is discarding what this person sends
    // has one thing to offer, and the unpin is only here because the
    // pinning outlives the blocking.
    expect(has(tree, `chat-markunread-${SAM}`)).toBe(false);

    const unpin = control(tree, `chat-unpin-${SAM}`);
    expect(unpin.props.accessibilityLabel).toBe('Unpin');

    recorder().execute.mockClear();
    await press(tree, `chat-unpin-${SAM}`);
    const call = recorder().execute.mock.calls.find((c: unknown[]) =>
      String(c[0]).includes('UPDATE chats SET pinnedAt'),
    )!;
    expect(call).toBeTruthy();
    expect((call[1] as unknown[])[0]).toBeNull();

    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('an unpinned blocked row offers the pin, above the unblock', async () => {
    state.blocked = [{ peerId: SAM }];
    const tree = await renderList();
    await openDrawer(tree, SAM);

    const order = byId(tree, `chat-drawer-${SAM}`)[0]!
      .findAll(n => typeof n.props.testID === 'string')
      .map(n => String(n.props.testID))
      .filter(id => /^chat-(pin|unpin|unblock)-/.test(id));
    expect(order.indexOf(`chat-pin-${SAM}`)).toBeGreaterThanOrEqual(0);
    expect(order.indexOf(`chat-pin-${SAM}`)).toBeLessThan(
      order.indexOf(`chat-unblock-${SAM}`),
    );

    await ReactTestRenderer.act(() => tree.unmount());
  });
});

describe('the pinned row itself', () => {
  test('wears a mark in the gutter, hidden from VoiceOver and frozen against Dynamic Type', async () => {
    state.chats = [chatRow(SAM, 'Sam', T0), chatRow(KIM, 'Kim')];
    const tree = await renderList();

    const mark = byId(tree, `pin-mark-${SAM}`)[0];
    expect(mark).toBeTruthy();
    // A glyph in a 56pt row cannot be allowed to grow without limit — the
    // "…" precedent in this same file.
    expect(mark!.props.allowFontScaling).toBe(false);
    // Visual only: the row is ONE element and the word rides its label.
    expect(mark!.props.accessibilityElementsHidden).toBe(true);
    expect(mark!.props.importantForAccessibility).toBe('no-hide-descendants');
    // In the muted ink: the forest dot in this column means unread.
    expect(
      byId(tree, `pin-mark-${SAM}`).some(
        n =>
          (n.props.style as { color?: string } | undefined)?.color ===
            theme.color.inkMuted ||
          (Array.isArray(n.props.style) &&
            n.props.style.some(
              (s: { color?: string } | undefined) =>
                s?.color === theme.color.inkMuted,
            )),
      ),
    ).toBe(true);

    // The unpinned row wears nothing: a mark on every row distinguishes
    // nothing.
    expect(has(tree, `pin-mark-${KIM}`)).toBe(false);

    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('the WORD is in the label, so the glyph is never the only channel', async () => {
    state.chats = [chatRow(SAM, 'Sam', T0)];
    const tree = await renderList();
    expect(String(byId(tree, `chat-${SAM}`)[0]!.props.accessibilityLabel)).toContain(
      'Sam, pinned',
    );
    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('the unread dot outranks the mark in the one column they share', async () => {
    state.chats = [chatRow(SAM, 'Sam', T0)];
    state.unread = [{ peerId: SAM, n: 1 }];
    const tree = await renderList();

    // The gutter is 12pt wide and holds one thing. News outranks placement.
    expect(has(tree, `pin-mark-${SAM}`)).toBe(false);
    // …and the pinned word still travels, alongside the news.
    const label = String(byId(tree, `chat-${SAM}`)[0]!.props.accessibilityLabel);
    expect(label).toContain('pinned');
    expect(label).toContain('new messages');

    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('no count is ever rendered', async () => {
    state.unread = [{ peerId: SAM, n: 37 }];
    const tree = await renderList();

    // The mark is there…
    const gutter = byId(tree, `chat-${SAM}`)[0]!.findAllByType(View);
    expect(gutter.length).toBeGreaterThan(0);
    // …and the number is nowhere in the row's text.
    expect(rowText(tree, SAM)).not.toContain('37');

    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('the screen re-sorts nothing — the order is the one listChats gave', async () => {
    // No cap and no client-side rule: pinned-first is one ORDER BY, proved
    // against a real engine in prove-db. The screen's job is to not undo it.
    state.chats = [chatRow(KIM, 'Kim', T0), chatRow(SAM, 'Sam')];
    const tree = await renderList();
    const rendered = tree.root
      .findAll(n => /^chat-01/.test(String(n.props.testID ?? '')))
      .map(n => String(n.props.testID))
      .filter(id => /^chat-[0-9A-Z]{26}$/.test(id));
    expect(rendered[0]).toBe(`chat-${KIM}`);
    expect(rendered[rendered.length - 1]).toBe(`chat-${SAM}`);

    await ReactTestRenderer.act(() => tree.unmount());
  });
});
