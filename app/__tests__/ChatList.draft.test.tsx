/**
 * A draft you left shows on the row.
 *
 * The `drafts` table has shipped since the composer did, drafts survive a
 * force-quit, and `getDraft` had exactly two callers — neither of them this
 * list. So a conversation with an unsent message looked identical to one
 * without, and the message you started at a bus stop was gone from view the
 * moment you left the thread.
 *
 * What this file holds:
 * - the prefix renders in the preview slot, in pine, with the draft after
 * it, and the WORD leads the row's spoken label so colour is never the
 * only channel;
 * - it comes from ONE whole-table read per refresh (`db.listDrafts`), read
 * beside `unreadCounts`, and it FAILS QUIET — the posture the unread mark
 * already takes;
 * - the blocked-row status outranks it. A row that is discarding what this
 * person sends has one thing to say, and it is not "Draft";
 * - and news outranks the draft in the SENTENCE without taking the draft
 * out of it: "you started replying and then more arrived" is an ordinary
 * state, and on that row the preview slot is already showing the draft.
 * The two channels must not disagree about what the row is showing.
 */

import React from 'react';
import { Text } from 'react-native';
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
  userId: '01DRFDBSSDJSPC9J0E5N2AWMJ5',
  registrationId: 7,
  displayName: 'Nat',
  about: '',
  avatarB64: '',
  profileVersion: 1,
};

function chatRow(peerId: string, name: string) {
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
    pinnedAt: null,
  };
}
type ChatRows = ReturnType<typeof chatRow>[];

const state: {
  chats: ChatRows;
  drafts: { peerId: string; text: string }[];
  blocked: { peerId: string }[];
  unread: { peerId: string; n: number }[];
  /** When true, `listDrafts` rejects — the quiet-failure case. */
  draftsFail: boolean;
} = { chats: [], drafts: [], blocked: [], unread: [], draftsFail: false };

const recorder = () => sqlite.instances.get('tacendum.sqlite')!;

beforeEach(async () => {
  await db.close();
  sqlite.reset();
  db.setWorkspace('real');
  await db.initDb();
  state.chats = [chatRow(SAM, 'Sam')];
  state.drafts = [];
  state.blocked = [];
  state.unread = [];
  state.draftsFail = false;
  keychain.set('lockNudge.dismissed', '1');

  const instance = recorder();
  const base = instance.execute.getMockImplementation()!;
  instance.execute.mockImplementation(
    async (sql: string, params?: unknown[]) => {
      const s = String(sql);
      if (s.includes('FROM chats ORDER BY')) return { rows: state.chats };
      if (s.includes('FROM drafts')) {
        if (state.draftsFail) throw new Error('drafts unreadable');
        return { rows: state.drafts };
      }
      if (s.includes('FROM blocked_peers')) return { rows: state.blocked };
      if (s.includes('COUNT(*) AS n')) return { rows: state.unread };
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
        profile={PROFILE}
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
function rowTexts(
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

describe('a draft on the row', () => {
  test('the prefix leads the preview slot, in pine, with the draft after it', async () => {
    state.drafts = [{ peerId: SAM, text: 'about tomorrow' }];
    const tree = await renderList();

    const prefix = byId(tree, `draft-prefix-${SAM}`)[0];
    expect(prefix).toBeTruthy();
    expect(prefix!.props.children).toBe('Draft');
    const style = prefix!.props.style as
      | { color?: string }
      | { color?: string }[];
    const colours = (Array.isArray(style) ? style : [style]).map(s => s?.color);
    expect(colours).toContain(theme.color.pine);

    // The words are on the row, and the message it replaced is not.
    expect(rowTexts(tree, SAM)).toContain('about tomorrow');
    expect(rowTexts(tree, SAM)).not.toContain('see you');

    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('the word leads the spoken label, so colour is not the only channel', async () => {
    state.drafts = [{ peerId: SAM, text: 'about tomorrow' }];
    const tree = await renderList();
    expect(String(byId(tree, `chat-${SAM}`)[0]!.props.accessibilityLabel)).toBe(
      'Sam, draft, about tomorrow',
    );
    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('an unread row with a draft speaks the draft, not the message it replaced', async () => {
    // You started replying, and then more arrived. The preview slot is
    // already showing the draft, so the incoming text is painted nowhere —
    // handing it to VoiceOver describes a row that is not on screen.
    state.unread = [{ peerId: SAM, n: 2 }];
    state.drafts = [{ peerId: SAM, text: 'about tomorrow' }];
    const tree = await renderList();

    // Precondition: the slot really did go to the draft.
    expect(byId(tree, `draft-prefix-${SAM}`).length).toBeGreaterThan(0);
    expect(rowTexts(tree, SAM)).not.toContain('see you');

    const label = String(byId(tree, `chat-${SAM}`)[0]!.props.accessibilityLabel);
    // News still leads — an arrival is about them.
    expect(label).toContain('new messages');
    // And what follows is what the row is showing.
    expect(label).toContain('Draft, about tomorrow');
    expect(label).not.toContain('see you');

    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('an unread row with no draft still speaks its preview', async () => {
    state.unread = [{ peerId: SAM, n: 2 }];
    const tree = await renderList();
    expect(String(byId(tree, `chat-${SAM}`)[0]!.props.accessibilityLabel)).toBe(
      'Sam, new messages, see you',
    );
    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('a row without a draft is untouched', async () => {
    state.chats = [chatRow(SAM, 'Sam'), chatRow(KIM, 'Kim')];
    state.drafts = [{ peerId: SAM, text: 'about tomorrow' }];
    const tree = await renderList();

    expect(byId(tree, `draft-prefix-${KIM}`).length).toBe(0);
    expect(rowTexts(tree, KIM)).toContain('see you');
    // A quiet row still carries no label at all — unchanged from before
    // drafts existed.
    expect(byId(tree, `chat-${KIM}`)[0]!.props.accessibilityLabel).toBeUndefined();

    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('the draft never outranks the blocked-row status', async () => {
    state.blocked = [{ peerId: SAM }];
    state.drafts = [{ peerId: SAM, text: 'about tomorrow' }];
    const tree = await renderList();

    // Precondition: this row really is blocked.
    expect(rowTexts(tree, SAM)).toContain('Blocked');
    // The status owns the row, and the label is the blocking deck's.
    expect(byId(tree, `draft-prefix-${SAM}`).length).toBe(0);
    expect(
      String(byId(tree, `chat-${SAM}`)[0]!.props.accessibilityLabel),
    ).not.toContain('draft');

    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('one whole-table read per refresh, never one per row', async () => {
    state.chats = [chatRow(SAM, 'Sam'), chatRow(KIM, 'Kim')];
    recorder().execute.mockClear();
    const tree = await renderList();

    const reads = recorder()
      .execute.mock.calls.map((c: unknown[]) => String(c[0]))
      .filter((s: string) => s.includes('FROM drafts'));
    expect(reads.length).toBe(1);
    // And it carries no peer id: it is the whole table, in the unreadCounts
    // shape, so it does not add to the N the refresh just stopped paying.
    expect(reads[0]).not.toContain('peerId = ?');

    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('a failed read is silent: the list still works', async () => {
    state.draftsFail = true;
    const tree = await renderList();

    // Marks are an enhancement; so is this. The row renders its preview.
    expect(byId(tree, `chat-${SAM}`).length).toBeGreaterThan(0);
    expect(rowTexts(tree, SAM)).toContain('see you');
    expect(byId(tree, `draft-prefix-${SAM}`).length).toBe(0);

    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('a multi-line draft is collapsed onto the one line the row has', async () => {
    state.drafts = [{ peerId: SAM, text: '  first line\n\nsecond line  ' }];
    const tree = await renderList();
    expect(rowTexts(tree, SAM)).toContain('first line second line');
    await ReactTestRenderer.act(() => tree.unmount());
  });
});
