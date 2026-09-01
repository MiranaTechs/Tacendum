/**
 * Blocking from the chat list — the route that matters most, because reaching
 * the peer profile means opening the thread, and the thread is where outbound
 * beacons originate.
 *
 * Every assertion here is about what the list does NOT do: it does not call
 * messaging.blockPeer when the confirmation is cancelled, it does not offer
 * Delete on a blocked row, and it does not claim a block was saved when the
 * write failed.
 *
 * Harness follows ChatThread.revise.test.tsx: the fake op-sqlite from
 * jest.setup.js answers by SQL fragment, so the screen exercises the real db
 * module rather than a stubbed one.
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { AccessibilityInfo, Text } from 'react-native';
import { BLOCK_COPY as BLOCK } from '../src/blocking';
import * as db from '../src/db';
import { messaging } from '../src/messaging';
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

const T0 = new Date('2026-07-23T09:00:00').getTime();

const PROFILE: db.ProfileRow = {
  userId: '01KYDBSSDJSPC9J0E5N2AWMJ5Y',
  registrationId: 7,
  displayName: '',
  about: '',
  avatarB64: '',
  profileVersion: 0,
};

const SAM = '01SAMZ3NDEKTSV4RRFFQ69G5FA';
const MIRA = '01MIRAZ3NDEKTSV4RRFFQ69G5F';

function chatRow(peerId: string, name: string, lastMessageAt: number | null) {
  return {
    peerId,
    displayName: name,
    lastMessageAt,
    lastMessageText: lastMessageAt === null ? null : 'see you',
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
}

/** Who the fake `blocked_peers` table answers with on the next read. */
const blockedRows: { ids: string[] } = { ids: [] };
/** What the fake `chats` table answers with on the next read. */
const chatRows: { rows: ReturnType<typeof chatRow>[] } = { rows: [] };

beforeEach(async () => {
  await db.close();
  sqlite.reset();
  db.setWorkspace('real');
  await db.initDb();
  blockedRows.ids = [];
  chatRows.rows = [chatRow(SAM, 'Sam', T0)];

  const instance = sqlite.instances.get('tacendum.sqlite')!;
  const base = instance.execute.getMockImplementation()!;
  instance.execute.mockImplementation(async (sql: string, params?: unknown) => {
    const s = String(sql);
    if (s.includes('FROM blocked_peers')) {
      return { rows: blockedRows.ids.map(peerId => ({ peerId })) };
    }
    if (s.includes('FROM chats')) return { rows: chatRows.rows };
    return base(s, params);
  });
});

afterEach(async () => {
  await db.close();
  jest.restoreAllMocks();
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

/** A testID reaches several nodes of one element; presence is the question. */
function has(tree: ReactTestRenderer.ReactTestRenderer, id: string): boolean {
  return byId(tree, id).length > 0;
}

async function press(
  tree: ReactTestRenderer.ReactTestRenderer,
  id: string,
): Promise<void> {
  await ReactTestRenderer.act(async () => {
    byId(tree, id)[0].props.onPress();
  });
}

/** Open the row's action drawer the way a long press does. */
async function openDrawer(
  tree: ReactTestRenderer.ReactTestRenderer,
  peerId: string,
): Promise<void> {
  await ReactTestRenderer.act(async () => {
    byId(tree, `chat-${peerId}`)[0].props.onLongPress();
  });
}

function texts(tree: ReactTestRenderer.ReactTestRenderer): string[] {
  return tree.root.findAllByType(Text).map(n => {
    const kids = n.props.children;
    return Array.isArray(kids) ? kids.join('') : String(kids ?? '');
  });
}

describe('chat list — blocking', () => {
  test('the drawer offers Block above Delete: reversible before irreversible', async () => {
    const tree = await renderList();
    await openDrawer(tree, SAM);

    // One testID reaches several nodes of the same element, so the order is
    // read from the first appearance of each.
    const order: string[] = [];
    for (const node of tree.root.findAll(
      n =>
        n.props.testID === `chat-block-${SAM}` ||
        n.props.testID === `chat-delete-${SAM}`,
    )) {
      if (!order.includes(node.props.testID)) order.push(node.props.testID);
    }
    expect(order).toEqual([`chat-block-${SAM}`, `chat-delete-${SAM}`]);

    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('Block opens a confirmation carrying the exact question and consequence', async () => {
    const tree = await renderList();
    await openDrawer(tree, SAM);
    await press(tree, `chat-block-${SAM}`);

    const panel = byId(tree, `chat-block-panel-${SAM}`);
    expect(panel.length).toBeGreaterThan(0);
    expect(panel[0].props.accessibilityRole).toBe('alert');
    const shown = texts(tree);
    expect(shown).toContain(BLOCK.confirmQuestion);
    expect(shown).toContain(BLOCK.confirmBody);
    // The honest half: nothing here may claim they were stopped from sending.
    expect(BLOCK.confirmBody).toContain('discarded as it arrives');

    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('Cancel writes nothing at all', async () => {
    const block = jest
      .spyOn(messaging, 'blockPeer')
      .mockResolvedValue(undefined);
    const tree = await renderList();
    await openDrawer(tree, SAM);
    await press(tree, `chat-block-${SAM}`);
    await press(tree, `chat-block-cancel-${SAM}`);

    expect(block).not.toHaveBeenCalled();
    expect(has(tree, `chat-block-panel-${SAM}`)).toBe(false);

    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('Confirm blocks exactly once, for exactly that peer, and announces it', async () => {
    const block = jest
      .spyOn(messaging, 'blockPeer')
      .mockResolvedValue(undefined);
    const announce = jest
      .spyOn(AccessibilityInfo, 'announceForAccessibilityWithOptions')
      .mockImplementation(() => {});

    const tree = await renderList();
    await openDrawer(tree, SAM);
    await press(tree, `chat-block-${SAM}`);
    await press(tree, `chat-block-confirm-${SAM}`);

    expect(block).toHaveBeenCalledTimes(1);
    expect(block).toHaveBeenCalledWith(SAM);
    // Queued, so it survives the drawer leaving the tree.
    expect(announce).toHaveBeenCalledWith(BLOCK.blockedAnnounce, {
      queue: true,
    });

    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('after blocking, the row’s own Unblock is live rather than stuck busy', async () => {
    // The row survives a block (unlike a delete, where it leaves the list), so
    // the pending flag has to clear or the way back is disabled forever.
    jest.spyOn(messaging, 'blockPeer').mockImplementation(async () => {
      blockedRows.ids = [SAM];
    });

    const tree = await renderList();
    await openDrawer(tree, SAM);
    await press(tree, `chat-block-${SAM}`);
    await press(tree, `chat-block-confirm-${SAM}`);

    await openDrawer(tree, SAM);
    const unblock = byId(tree, `chat-unblock-${SAM}`).find(
      n => n.props.accessibilityRole === 'button',
    );
    expect(unblock).toBeDefined();
    expect(unblock!.props.accessibilityState).toEqual({ disabled: false });

    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('a blocked row says Blocked where the time was — even with no messages', async () => {
    blockedRows.ids = [SAM];
    chatRows.rows = [chatRow(SAM, 'Sam', null), chatRow(MIRA, 'Mira', T0)];

    const tree = await renderList();
    const shown = texts(tree);
    // The word takes the timestamp's place. A frozen relative time would tell
    // the row's owner the person went quiet, when this iPhone is discarding
    // what they send.
    expect(shown).toContain(BLOCK.rowStatus);
    // The unblocked row keeps its clock.
    expect(shown.filter(s => s === BLOCK.rowStatus).length).toBe(1);

    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('a blocked row offers Unblock and no Delete, with the reason stated', async () => {
    blockedRows.ids = [SAM];
    const tree = await renderList();
    await openDrawer(tree, SAM);

    expect(has(tree, `chat-unblock-${SAM}`)).toBe(true);
    // Deleting cannot remove the block (it is its own table, by design), so a
    // Delete here would strand a block with no surface left to reverse it.
    expect(has(tree, `chat-delete-${SAM}`)).toBe(false);
    expect(has(tree, `chat-block-${SAM}`)).toBe(false);
    expect(texts(tree)).toContain(BLOCK.drawerBlockedNote);

    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('Unblock calls messaging once and announces the restoration', async () => {
    blockedRows.ids = [SAM];
    const unblock = jest
      .spyOn(messaging, 'unblockPeer')
      .mockResolvedValue(true);
    const announce = jest
      .spyOn(AccessibilityInfo, 'announceForAccessibilityWithOptions')
      .mockImplementation(() => {});

    const tree = await renderList();
    await openDrawer(tree, SAM);
    await press(tree, `chat-unblock-${SAM}`);

    expect(unblock).toHaveBeenCalledTimes(1);
    expect(unblock).toHaveBeenCalledWith(SAM);
    expect(announce).toHaveBeenCalledWith(BLOCK.unblockedAnnounce, {
      queue: true,
    });

    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('the blocked row is announced as blocked, ahead of unread', async () => {
    blockedRows.ids = [SAM];
    const tree = await renderList();
    const row = byId(tree, `chat-${SAM}`)[0];
    expect(row.props.accessibilityLabel).toBe(BLOCK.rowLabel('Sam', 'see you'));

    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('a failed write says so, and leaves the row unblocked', async () => {
    jest
      .spyOn(messaging, 'blockPeer')
      .mockRejectedValue(new Error('disk is full'));

    const tree = await renderList();
    await openDrawer(tree, SAM);
    await press(tree, `chat-block-${SAM}`);
    await press(tree, `chat-block-confirm-${SAM}`);

    expect(has(tree, `chat-block-error-${SAM}`)).toBe(true);
    expect(texts(tree)).toContain(BLOCK.failed);
    // Nothing was recorded, so nothing may claim to be: the time column still
    // holds a timestamp, not the word.
    expect(texts(tree)).not.toContain(BLOCK.rowStatus);

    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('a failed unblock’s notice does not come back when the drawer is reopened', async () => {
    // The row is a FlatList cell: closing the drawer unmounts nothing, so a
    // failure left in state would render again — and InlineError announces on
    // mount, telling VoiceOver about an attempt the person did not just make.
    blockedRows.ids = [SAM];
    jest
      .spyOn(messaging, 'unblockPeer')
      .mockRejectedValue(new Error('disk is full'));
    const announce = jest
      .spyOn(AccessibilityInfo, 'announceForAccessibilityWithOptions')
      .mockImplementation(() => {});

    const tree = await renderList();
    await openDrawer(tree, SAM);
    await press(tree, `chat-unblock-${SAM}`);
    expect(has(tree, `chat-unblock-error-${SAM}`)).toBe(true);
    expect(announce).toHaveBeenCalledWith(BLOCK.failed, { queue: true });

    announce.mockClear();
    // The dismissal a long press performs, then the drawer opened again.
    await openDrawer(tree, SAM);
    await openDrawer(tree, SAM);

    expect(has(tree, `chat-unblock-error-${SAM}`)).toBe(false);
    expect(texts(tree)).not.toContain(BLOCK.failed);
    expect(announce).not.toHaveBeenCalled();
    // The way back is still offered, so the failure cost nothing but itself.
    expect(has(tree, `chat-unblock-${SAM}`)).toBe(true);

    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('a failed block’s notice does not come back when the confirmation is reopened', async () => {
    jest
      .spyOn(messaging, 'blockPeer')
      .mockRejectedValue(new Error('disk is full'));

    const tree = await renderList();
    await openDrawer(tree, SAM);
    await press(tree, `chat-block-${SAM}`);
    await press(tree, `chat-block-confirm-${SAM}`);
    expect(has(tree, `chat-block-error-${SAM}`)).toBe(true);

    // Out of the confirmation, back to the drawer, and into it again.
    await press(tree, `chat-block-cancel-${SAM}`);
    await openDrawer(tree, SAM);
    await press(tree, `chat-block-${SAM}`);

    expect(has(tree, `chat-block-error-${SAM}`)).toBe(false);
    expect(texts(tree)).not.toContain(BLOCK.failed);

    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('a failed delete’s notice does not come back either', async () => {
    // Same defect, same root: the notice belongs to the attempt, and the row
    // outlives every step of its drawer.
    jest.spyOn(db, 'deleteChat').mockRejectedValue(new Error('disk is full'));

    const tree = await renderList();
    await openDrawer(tree, SAM);
    await press(tree, `chat-delete-${SAM}`);
    await press(tree, `chat-delete-confirm-${SAM}`);
    expect(has(tree, `chat-delete-error-${SAM}`)).toBe(true);

    await press(tree, `chat-keep-${SAM}`);
    await openDrawer(tree, SAM);
    await press(tree, `chat-delete-${SAM}`);

    expect(has(tree, `chat-delete-error-${SAM}`)).toBe(false);

    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('blocking one person does not touch anybody else’s row', async () => {
    blockedRows.ids = [SAM];
    chatRows.rows = [chatRow(SAM, 'Sam', T0), chatRow(MIRA, 'Mira', T0)];

    const tree = await renderList();
    expect(byId(tree, `chat-${MIRA}`)[0].props.accessibilityLabel).toBe(
      undefined,
    );
    await openDrawer(tree, MIRA);
    expect(has(tree, `chat-delete-${MIRA}`)).toBe(true);
    expect(has(tree, `chat-block-${MIRA}`)).toBe(true);

    await ReactTestRenderer.act(() => tree.unmount());
  });

  // The warning must be VISIBLE, not VoiceOver-only, and
  // it must survive a relaunch: the stale flag is durable, this list is the
  // first screen back, and a person who cannot hear an announcement was the
  // only one being told their lock screen disagrees with their block list.
  test('a stale notification mirror renders a visible persistent warning', async () => {
    jest
      .spyOn(messaging, 'isBlockNotificationMirrorStale')
      .mockReturnValue(true);

    const tree = await renderList();

    expect(has(tree, 'block-mirror-stale')).toBe(true);
    expect(texts(tree)).toContain(BLOCK.mirrorStale);

    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('a healthy mirror renders no warning at all', async () => {
    jest
      .spyOn(messaging, 'isBlockNotificationMirrorStale')
      .mockReturnValue(false);

    const tree = await renderList();

    expect(has(tree, 'block-mirror-stale')).toBe(false);
    expect(texts(tree)).not.toContain(BLOCK.mirrorStale);

    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('an unblock that could not reach the lock screen says so instead of announcing plain success', async () => {
    blockedRows.ids = [SAM];
    jest.spyOn(messaging, 'unblockPeer').mockImplementation(async () => {
      // The awaited reconcile inside unblockPeer is what turned the flag
      // stale before resolve; the screen reads it at exactly that point.
      jest
        .spyOn(messaging, 'isBlockNotificationMirrorStale')
        .mockReturnValue(true);
      return false;
    });
    const announce = jest
      .spyOn(AccessibilityInfo, 'announceForAccessibilityWithOptions')
      .mockImplementation(() => {});
    // The preset already mocks this method, so spyOn hands back one shared
    // mock whose calls ACCUMULATE across tests — an earlier success
    // announcement would defeat the not-called assertion below.
    announce.mockClear();

    const tree = await renderList();
    await openDrawer(tree, SAM);
    await press(tree, `chat-unblock-${SAM}`);

    expect(announce).toHaveBeenCalledWith(BLOCK.partialUnblockMirror, {
      queue: true,
    });
    expect(announce).not.toHaveBeenCalledWith(BLOCK.unblockedAnnounce, {
      queue: true,
    });
    // And the standing warning is on screen, visibly.
    expect(has(tree, 'block-mirror-stale')).toBe(true);

    await ReactTestRenderer.act(() => tree.unmount());
  });
});
