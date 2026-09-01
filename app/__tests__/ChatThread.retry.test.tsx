/**
 * Tap-to-retry in the thread. A failed outgoing message keeps the person's
 * words on screen; Try again re-encrypts them as a NEW send — the old
 * ciphertext died with the outbox row and the ratchet has moved on — and the
 * failed row is replaced, never duplicated. The affordance only exists where
 * it can work: a photo whose plain bytes are gone gets no button. VoiceOver
 * hears each state change once, and only once.
 *
 * Harness follows ChatThread.blocking.test.tsx.
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { AccessibilityInfo, Text } from 'react-native';
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

const T0 = new Date('2026-07-25T12:00:00').getTime();
const PEER = 'peer-1';

/** The exact sentences the screen speaks. Announce spies see every notice in
 * the tree (the offline row, inline errors), so assertions count by copy. */
const FAILED_ANNOUNCE =
  'Your message wasn’t sent. Check your connection and try again.';
const RETRY_ANNOUNCE = 'Sending your message again.';
const IDENTITY_SENTENCE = 'Nothing will send until you review this change.';

const THEIRS = {
  msgId: '01THEIRS',
  peerId: PEER,
  direction: 'in',
  body: 'dinner at eight?',
  ts: T0,
  status: 'received',
  editedAt: null,
  deletedAt: null,
};
/** The send the backoff gave up on. */
const MINE_FAILED = {
  msgId: '01MINE',
  peerId: PEER,
  direction: 'out',
  body: 'on my way',
  ts: T0 + 60_000,
  status: 'error',
  editedAt: null,
  deletedAt: null,
};
/** What a successful Try again leaves behind: a fresh pending row. */
const MINE_FRESH = {
  msgId: '01FRESH',
  peerId: PEER,
  direction: 'out',
  body: 'on my way',
  ts: T0 + 120_000,
  status: 'pending',
  editedAt: null,
  deletedAt: null,
};
const PHOTO_BODY = JSON.stringify({
  tcm: 'image',
  att: 'blob-1',
  key: 'a2V5',
  w: 120,
  h: 90,
});
const PHOTO_FAILED = {
  msgId: '01PHOTO',
  peerId: PEER,
  direction: 'out',
  body: PHOTO_BODY,
  ts: T0 + 180_000,
  status: 'error',
  editedAt: null,
  deletedAt: null,
};
/** A reply's body IS its envelope — retry must re-send it verbatim. */
const REPLY_BODY = JSON.stringify({
  tcm: 'reply',
  ref: '01THEIRS',
  ofs: false,
  text: 'nine works',
});
const REPLY_FAILED = {
  msgId: '01REPLY',
  peerId: PEER,
  direction: 'out',
  body: REPLY_BODY,
  ts: T0 + 240_000,
  status: 'error',
  editedAt: null,
  deletedAt: null,
};

/** What the fake tables serve; tests mutate these between requeries. */
let rowsNow: Array<Record<string, unknown>> = [];
let attachmentsNow: Array<Record<string, unknown>> = [];

/** The thread's messaging subscriber, so a test can play notify(). */
let poke: (() => void) | null = null;

beforeEach(async () => {
  await db.close();
  sqlite.reset();
  db.setWorkspace('real');
  await db.initDb();
  rowsNow = [THEIRS, { ...MINE_FAILED }];
  attachmentsNow = [];
  poke = null;

  const instance = sqlite.instances.get('tacendum.sqlite')!;
  const base = instance.execute.getMockImplementation()!;
  instance.execute.mockImplementation(async (sql: string, params?: unknown) => {
    const s = String(sql);
    // listAttachmentMeta and getAttachment both say 'FROM attachments' (the
    // meta query JOINs messages without ever saying 'FROM messages').
    if (s.includes('FROM attachments')) return { rows: attachmentsNow };
    if (s.includes('FROM messages')) return { rows: rowsNow };
    return base(s, params);
  });

  jest.spyOn(messaging, 'isPeerBlocked').mockReturnValue(false);
  jest.spyOn(messaging, 'getSafetyNumber').mockResolvedValue(null);
  jest.spyOn(messaging, 'subscribe').mockImplementation(listener => {
    poke = listener;
    return () => {
      poke = null;
    };
  });
});

afterEach(async () => {
  await db.close();
  jest.restoreAllMocks();
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

function texts(tree: ReactTestRenderer.ReactTestRenderer): string[] {
  return tree.root.findAllByType(Text).map(n => {
    const kids = n.props.children;
    return Array.isArray(kids) ? kids.join('') : String(kids ?? '');
  });
}

/** Outlives REFRESH_DEBOUNCE_MS, so a poked notify has requeried by now. */
function settle(): Promise<void> {
  return ReactTestRenderer.act(async () => {
    await new Promise<void>(resolve => setTimeout(() => resolve(), 150));
  });
}

/** How many times one exact sentence was announced. */
function said(announce: jest.SpyInstance, sentence: string): number {
  return announce.mock.calls.filter(c => c[0] === sentence).length;
}

function spyAnnounce(): jest.SpyInstance {
  const spy = jest
    .spyOn(AccessibilityInfo, 'announceForAccessibilityWithOptions')
    .mockImplementation(() => {});
  // React Native's jest preset ships AccessibilityInfo already mocked, so
  // spyOn hands every test the SAME fn — with the previous test's calls
  // still on it, beyond restoreAllMocks' reach. Counting starts at zero.
  spy.mockClear();
  return spy;
}

describe('chat thread — tap to retry', () => {
  test('Try again replaces the failed row with a fresh send, never a second copy', async () => {
    const announce = spyAnnounce();
    // What the real sendText does from the thread's seat: a new pending row
    // exists and messaging notifies its subscribers.
    const sendText = jest
      .spyOn(messaging, 'sendText')
      .mockImplementation(async () => {
        rowsNow = [...rowsNow, MINE_FRESH];
        poke?.();
      });
    const remove = jest
      .spyOn(db, 'deleteMessage')
      .mockImplementation(async (msgId: string) => {
        rowsNow = rowsNow.filter(r => r.msgId !== msgId);
      });

    const tree = await renderThread();
    expect(has(tree, 'retry-01MINE')).toBe(true);

    await ReactTestRenderer.act(async () => {
      byId(tree, 'retry-01MINE')[0].props.onPress();
    });
    await settle();

    // A new send, re-encrypted from the plaintext the local echo kept.
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledWith(PEER, 'on my way');
    // Send first, delete second: a second failure must never cost the words.
    expect(remove).toHaveBeenCalledWith('01MINE', 'out');
    expect(sendText.mock.invocationCallOrder[0]).toBeLessThan(
      remove.mock.invocationCallOrder[0],
    );

    // Replaced, not duplicated: the failed row is gone, the words appear once,
    // and the replacement reads as ordinary sending — no scary interim state.
    expect(has(tree, 'error-01MINE')).toBe(false);
    expect(has(tree, 'retry-01MINE')).toBe(false);
    expect(texts(tree).filter(x => x === 'on my way')).toHaveLength(1);
    expect(has(tree, 'msg-01FRESH')).toBe(true);
    expect(has(tree, 'status-01FRESH-pending')).toBe(true);

    // The control VoiceOver stood on is gone; that is said exactly once, and
    // the requery that painted the replacement adds nothing.
    expect(said(announce, RETRY_ANNOUNCE)).toBe(1);

    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('a double-tap on Try again sends the message once, not twice', async () => {
    // The send is a multi-await window and the control stays mounted for all
    // of it — on the slow link that caused the failure, a second tap lands
    // easily. Only the handler's own guard can hold.
    let releaseSend!: () => void;
    const sendText = jest.spyOn(messaging, 'sendText').mockImplementation(
      () =>
        new Promise<never>(resolve => {
          releaseSend = () => {
            rowsNow = [...rowsNow, MINE_FRESH];
            poke?.();
            resolve(undefined as never);
          };
        }),
    );
    const remove = jest
      .spyOn(db, 'deleteMessage')
      .mockImplementation(async (msgId: string) => {
        rowsNow = rowsNow.filter(r => r.msgId !== msgId);
      });

    const tree = await renderThread();
    await ReactTestRenderer.act(async () => {
      byId(tree, 'retry-01MINE')[0].props.onPress();
      byId(tree, 'retry-01MINE')[0].props.onPress();
    });
    await ReactTestRenderer.act(async () => {
      releaseSend();
    });
    await settle();

    // One fresh send, one cleanup, one copy of the words on screen.
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(texts(tree).filter(x => x === 'on my way')).toHaveLength(1);

    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('a cleanup failure after a successful re-send never claims the send failed', async () => {
    const announce = spyAnnounce();
    const sendText = jest
      .spyOn(messaging, 'sendText')
      .mockImplementation(async () => {
        rowsNow = [...rowsNow, MINE_FRESH];
        poke?.();
      });
    // The send succeeded; then the delete of the old failed row hits a db
    // error (a relock closing the connection mid-tap).
    jest
      .spyOn(db, 'deleteMessage')
      .mockRejectedValue(new Error('database closed'));

    const tree = await renderThread();
    await ReactTestRenderer.act(async () => {
      byId(tree, 'retry-01MINE')[0].props.onPress();
    });
    await settle();

    // The message is on its way: no failure banner about a send that worked,
    // and the retry sentence is still spoken once.
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(has(tree, 'send-error')).toBe(false);
    expect(said(announce, RETRY_ANNOUNCE)).toBe(1);
    // The fresh pending row is painted; the stale failed row is residue for
    // a later requery, not a claimed failure.
    expect(has(tree, 'msg-01FRESH')).toBe(true);

    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('a reply retry re-sends its envelope verbatim, keeping the quote', async () => {
    rowsNow = [THEIRS, { ...REPLY_FAILED }];
    const sendText = jest
      .spyOn(messaging, 'sendText')
      .mockResolvedValue(undefined as never);
    jest
      .spyOn(db, 'deleteMessage')
      .mockImplementation(async (msgId: string) => {
        rowsNow = rowsNow.filter(r => r.msgId !== msgId);
      });

    const tree = await renderThread();
    // The failed bubble shows the reply's words, never its JSON.
    expect(texts(tree)).toContain('nine works');

    await ReactTestRenderer.act(async () => {
      byId(tree, 'retry-01REPLY')[0].props.onPress();
    });
    await settle();

    // The body IS the envelope: re-sent whole, the recipient re-parses the
    // quote, and previewFor keeps rendering it as its words everywhere.
    expect(sendText).toHaveBeenCalledWith(PEER, REPLY_BODY);

    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('a blocked peer refuses the retry: nothing sent, nothing removed', async () => {
    // A block landing mid-flight: the db has not repainted interactionsOff
    // yet, so the control is still up — the handler's own guard must hold.
    jest.spyOn(messaging, 'isBlockedLocally').mockReturnValue(true);
    const sendText = jest
      .spyOn(messaging, 'sendText')
      .mockResolvedValue(undefined as never);
    const remove = jest.spyOn(db, 'deleteMessage');

    const tree = await renderThread();
    expect(has(tree, 'retry-01MINE')).toBe(true);

    await ReactTestRenderer.act(async () => {
      byId(tree, 'retry-01MINE')[0].props.onPress();
    });
    await settle();

    expect(sendText).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(has(tree, 'error-01MINE')).toBe(true);

    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('an identity change landing between paint and tap stops the retry cold', async () => {
    const sendText = jest
      .spyOn(messaging, 'sendText')
      .mockResolvedValue(undefined as never);
    const remove = jest.spyOn(db, 'deleteMessage');

    const tree = await renderThread();
    expect(has(tree, 'retry-01MINE')).toBe(true);

    // The safety number changes AFTER the control painted. The tap consults
    // messaging at tap time, exactly as a fresh sendText would.
    (messaging.isPeerBlocked as jest.Mock).mockReturnValue(true);
    await ReactTestRenderer.act(async () => {
      byId(tree, 'retry-01MINE')[0].props.onPress();
    });
    await settle();

    expect(sendText).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(has(tree, 'error-01MINE')).toBe(true);

    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('when the ratchet itself refuses, the fresh-send sentence appears and the words stay', async () => {
    // Deeper than the tap-time guard: messaging discovers the identity change
    // during the send, exactly as a fresh sendText would.
    const sendText = jest
      .spyOn(messaging, 'sendText')
      .mockRejectedValue(
        new Error('safety number changed — verify and accept it before sending'),
      );
    const remove = jest.spyOn(db, 'deleteMessage');

    const tree = await renderThread();
    await ReactTestRenderer.act(async () => {
      byId(tree, 'retry-01MINE')[0].props.onPress();
    });
    await settle();

    expect(sendText).toHaveBeenCalledTimes(1);
    // The delete never ran: the failed row still holds the person's words.
    expect(remove).not.toHaveBeenCalled();
    expect(has(tree, 'error-01MINE')).toBe(true);
    // Same copy as a fresh send meeting the same wall.
    expect(has(tree, 'send-error')).toBe(true);
    expect(texts(tree)).toContain(IDENTITY_SENTENCE);

    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('a photo whose bytes are gone gets no Try again — Remove stays', async () => {
    rowsNow = [THEIRS, { ...PHOTO_FAILED }];
    attachmentsNow = []; // removed with the message, or never stored

    const tree = await renderThread();
    expect(has(tree, 'error-01PHOTO')).toBe(true);
    expect(texts(tree)).toContain('Not sent.');
    expect(has(tree, 'retry-01PHOTO')).toBe(false);
    expect(has(tree, 'remove-01PHOTO')).toBe(true);
    await ReactTestRenderer.act(() => tree.unmount());

    // A failed download row is not bytes either.
    attachmentsNow = [
      { msgId: '01PHOTO', direction: 'out', state: 'failed', dataB64: null, w: 120, h: 90 },
    ];
    const failedTree = await renderThread();
    expect(has(failedTree, 'retry-01PHOTO')).toBe(false);
    await ReactTestRenderer.act(() => failedTree.unmount());

    // With the plain bytes still on this iPhone, the control returns.
    attachmentsNow = [
      { msgId: '01PHOTO', direction: 'out', state: 'ready', dataB64: 'UExBSU4=', w: 120, h: 90 },
    ];
    const readyTree = await renderThread();
    expect(has(readyTree, 'retry-01PHOTO')).toBe(true);
    await ReactTestRenderer.act(() => readyTree.unmount());
  });

  test('a photo retry re-runs the whole pipeline from the stored bytes', async () => {
    rowsNow = [THEIRS, { ...PHOTO_FAILED }];
    attachmentsNow = [
      { msgId: '01PHOTO', direction: 'out', state: 'ready', dataB64: 'UExBSU4=', w: 120, h: 90 },
    ];
    const sendImage = jest
      .spyOn(messaging, 'sendImage')
      .mockResolvedValue(undefined as never);
    const remove = jest
      .spyOn(db, 'deleteMessage')
      .mockImplementation(async (msgId: string) => {
        rowsNow = rowsNow.filter(r => r.msgId !== msgId);
      });

    const tree = await renderThread();
    await ReactTestRenderer.act(async () => {
      byId(tree, 'retry-01PHOTO')[0].props.onPress();
    });
    await settle();

    // Fresh blobEncrypt + upload + pointer — the old presigned blob may be
    // gone, so the pointer in the failed row is never trusted.
    expect(sendImage).toHaveBeenCalledWith(PEER, 'UExBSU4=', 120, 90);
    expect(remove).toHaveBeenCalledWith('01PHOTO', 'out');

    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('exhaustion arriving over the notify path is announced once, and only once', async () => {
    const announce = spyAnnounce();
    rowsNow = [THEIRS, { ...MINE_FAILED, status: 'pending' }];

    const tree = await renderThread();
    // While messaging quietly retries, the row keeps its ordinary pending
    // look — no failed state, no announcement.
    expect(has(tree, 'status-01MINE-pending')).toBe(true);
    expect(has(tree, 'error-01MINE')).toBe(false);
    expect(texts(tree)).not.toContain('Not sent.');
    expect(said(announce, FAILED_ANNOUNCE)).toBe(0);

    // The backoff gives up: messaging marks the row failed and notifies.
    rowsNow = [THEIRS, { ...MINE_FAILED }];
    await ReactTestRenderer.act(async () => {
      poke?.();
    });
    await settle();

    expect(has(tree, 'error-01MINE')).toBe(true);
    expect(has(tree, 'retry-01MINE')).toBe(true);
    expect(said(announce, FAILED_ANNOUNCE)).toBe(1);

    // Requeries keep coming — receipts, reactions, downloads. The bad news
    // is never read twice.
    await ReactTestRenderer.act(async () => {
      poke?.();
    });
    await settle();
    await ReactTestRenderer.act(async () => {
      poke?.();
    });
    await settle();
    expect(said(announce, FAILED_ANNOUNCE)).toBe(1);

    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('a message already failed when the thread opened is not announced', async () => {
    const announce = spyAnnounce();
    const tree = await renderThread();

    // The bubble is on screen for VoiceOver to read in place; a spoken alert
    // about old news would fire on every visit to the conversation.
    expect(has(tree, 'error-01MINE')).toBe(true);
    expect(has(tree, 'retry-01MINE')).toBe(true);
    expect(said(announce, FAILED_ANNOUNCE)).toBe(0);

    await ReactTestRenderer.act(() => tree.unmount());
  });
});
