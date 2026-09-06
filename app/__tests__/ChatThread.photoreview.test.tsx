/**
 * A photo gets a look before it sends.
 *
 * The defect this closes: `attachPhoto` called `pickImage` and then
 * `messaging.sendImage` in the same breath. Pick WAS send — no confirm, no
 * preview, no way out — and the only recovery from the wrong photo to the
 * wrong person was "Delete for everyone", which announces itself. The review
 * panel creates a testable decision point between picking and sending.
 *
 * What is pinned here:
 * - a pick shows the review panel in the composer's place and sends NOTHING;
 * - Send sends once, with the picked bytes, and the panel goes;
 * - Discard sends nothing and drops the bytes — there is no second Send;
 * - leaving the conversation, and backgrounding the phone, discard it too;
 * - a camera pick offers "Take another"; a library pick does not;
 * - the size line is the estimator's number, not the sender's word.
 *
 * Harness copied from ChatThread.attach.test.tsx, with the AppState note
 * from ChatThread.read.test.tsx.
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { AppState, BackHandler, StyleSheet, Text } from 'react-native';
import * as db from '../src/db';
import * as media from '../src/media';
import { messaging } from '../src/messaging';
import { ChatThreadScreen } from '../src/screens/ChatThreadScreen';
import {
  NO_PHOTO_REVIEW,
  PHOTO_REVIEW_MAX_HEIGHT,
  discardReview,
  discardUnlessSending,
  offersRetake,
  photoAspect,
  photoBytes,
  photoKilobytes,
  reviewPicked,
  reviewSending,
} from '../src/thread/photoReview';

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

const T0 = new Date('2026-09-05T12:00:00').getTime();
const PEER = 'peer-1';

const THEIRS = {
  msgId: '01THEIRS',
  peerId: PEER,
  direction: 'in',
  body: 'send me the photo',
  ts: T0,
  status: 'received',
  editedAt: null,
  deletedAt: null,
};

/** 4096 base64 characters, no padding: 3072 bytes, exactly 3 KB. */
const BIG = 'A'.repeat(4096);
const PICKED = { base64: BIG, width: 1200, height: 900 };

let appStateListeners: Array<(next: string) => void> = [];
let priorState: unknown;
let pick: jest.SpyInstance;
let sendImage: jest.SpyInstance;
let handlers: Array<() => boolean>;

beforeEach(async () => {
  handlers = [];
  jest
    .spyOn(BackHandler, 'addEventListener')
    .mockImplementation((event, handler) => {
      expect(event).toBe('hardwareBackPress');
      handlers.push(handler as () => boolean);
      return { remove: jest.fn() };
    });
  priorState = AppState.currentState;
  Object.defineProperty(AppState, 'currentState', {
    value: 'active',
    configurable: true,
    writable: true,
  });
  appStateListeners = [];
  jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation(((_type: string, fn: (next: string) => void) => {
      appStateListeners.push(fn);
      return { remove: jest.fn() };
    }) as unknown as typeof AppState.addEventListener);
  pick = jest.spyOn(media, 'pickImage').mockResolvedValue(PICKED);
  sendImage = jest
    .spyOn(messaging, 'sendImage')
    .mockResolvedValue(undefined as never);
  await db.close();
  sqlite.reset();
  db.setWorkspace('real');
  await db.initDb();
  const instance = sqlite.instances.get('tacendum.sqlite')!;
  const base = instance.execute.getMockImplementation()!;
  instance.execute.mockImplementation(async (sql: string, params?: unknown) => {
    if (String(sql).includes('FROM messages')) {
      return { rows: [THEIRS] };
    }
    return base(sql, params);
  });
});

afterEach(async () => {
  jest.restoreAllMocks();
  Object.defineProperty(AppState, 'currentState', {
    value: priorState,
    configurable: true,
    writable: true,
  });
  await db.close();
});

async function renderThread(
  peerId = PEER,
): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <ChatThreadScreen
        peerId={peerId}
        onBack={jest.fn()}
        onOpenPeerProfile={jest.fn()}
        onOpenPhoto={jest.fn()}
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

function has(tree: ReactTestRenderer.ReactTestRenderer, id: string): boolean {
  return byId(tree, id).length > 0;
}

function press(
  tree: ReactTestRenderer.ReactTestRenderer,
  id: string,
): Promise<void> {
  const node = byId(tree, id).find(n => n.props.onPress);
  if (!node) throw new Error(`no pressable ${id}`);
  return ReactTestRenderer.act(async () => {
    node.props.onPress();
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

async function pressBack(): Promise<boolean> {
  let consumed!: boolean;
  await ReactTestRenderer.act(async () => {
    consumed = handlers[handlers.length - 1]!();
  });
  return consumed;
}

/** Open the attach drawer and choose a source. */
async function attach(
  tree: ReactTestRenderer.ReactTestRenderer,
  source: 'library' | 'camera',
): Promise<void> {
  await press(tree, 'composer-attach');
  await press(tree, `attach-${source}`);
  await ReactTestRenderer.act(async () => {});
}

describe('the estimator and the three states', () => {
  test('the size comes from the base64 length, padding and all', () => {
    // 'PLAIN' is five bytes and 'UExBSU4=' is how they travel.
    expect(photoBytes('UExBSU4=')).toBe(5);
    expect(photoBytes('')).toBe(0);
    expect(photoBytes(BIG)).toBe(3072);
    expect(photoKilobytes(BIG)).toBe(3);
    // A photo smaller than a kilobyte still has a size a person can read.
    expect(photoKilobytes('UExBSU4=')).toBe(1);
  });

  test('a pick becomes a review, a review becomes a send, and nothing else does', () => {
    const reviewing = reviewPicked(PICKED, 'camera');
    expect(reviewing).toEqual({
      kind: 'review',
      picked: PICKED,
      source: 'camera',
    });
    expect(reviewSending(reviewing)).toEqual({
      kind: 'sending',
      picked: PICKED,
      source: 'camera',
    });
    // Nothing to send with nothing picked: the send arm cannot invent bytes.
    expect(reviewSending(NO_PHOTO_REVIEW)).toBe(NO_PHOTO_REVIEW);
    // And a send already under way is not started twice.
    expect(reviewSending(reviewSending(reviewing))).toEqual({
      kind: 'sending',
      picked: PICKED,
      source: 'camera',
    });
    expect(discardReview()).toBe(NO_PHOTO_REVIEW);
  });

  test('only a camera pick still under review offers another take', () => {
    expect(offersRetake(reviewPicked(PICKED, 'camera'))).toBe(true);
    expect(offersRetake(reviewPicked(PICKED, 'library'))).toBe(false);
    expect(offersRetake(reviewSending(reviewPicked(PICKED, 'camera')))).toBe(
      false,
    );
    expect(offersRetake(NO_PHOTO_REVIEW)).toBe(false);
  });

  test('a send under way cannot be discarded, because discarding it is a lie', () => {
    const reviewing = reviewPicked(PICKED, 'library');
    expect(discardUnlessSending(reviewing)).toBe(NO_PHOTO_REVIEW);
    expect(discardUnlessSending(NO_PHOTO_REVIEW)).toBe(NO_PHOTO_REVIEW);
    // The bytes are already going: removing the panel would not stop them,
    // so the control that says "Discard" must not appear to have worked.
    const going = reviewSending(reviewing);
    expect(discardUnlessSending(going)).toBe(going);
  });

  test('the aspect ratio is the photo’s, and never a division by nothing', () => {
    expect(photoAspect(PICKED)).toBeCloseTo(1200 / 900);
    expect(photoAspect({ base64: BIG, width: 900, height: 1200 })).toBeCloseTo(
      0.75,
    );
    // A picker that answered with no dimensions gets a square, not a NaN
    // that would take the whole panel's layout with it.
    expect(photoAspect({ base64: BIG, width: 0, height: 0 })).toBe(1);
    expect(
      photoAspect({ base64: BIG, width: 100, height: Number.NaN }),
    ).toBe(1);
  });
});

test('a pick shows the review in the composer’s place and sends nothing', async () => {
  const tree = await renderThread();
  await attach(tree, 'library');

  expect(pick).toHaveBeenCalledTimes(1);
  expect(has(tree, 'photo-review')).toBe(true);
  // The panel is the composer's, not a modal: while a photo waits for a
  // decision the composer is not there to type into.
  expect(has(tree, 'composer-input')).toBe(false);
  expect(texts(tree)).toContain('Send this photo?');
  expect(texts(tree)).toContain('About 3 KB');
  // The whole point: pick is no longer send.
  expect(sendImage).not.toHaveBeenCalled();

  await ReactTestRenderer.act(() => {
    tree.unmount();
  });
});

test('Send sends the picked bytes once, and the panel goes', async () => {
  const tree = await renderThread();
  await attach(tree, 'library');

  await press(tree, 'photo-review-send');
  await ReactTestRenderer.act(async () => {});

  expect(sendImage).toHaveBeenCalledTimes(1);
  expect(sendImage).toHaveBeenCalledWith(PEER, BIG, 1200, 900);
  expect(has(tree, 'photo-review')).toBe(false);
  expect(has(tree, 'composer-input')).toBe(true);

  await ReactTestRenderer.act(() => {
    tree.unmount();
  });
});

test('Discard sends nothing and drops the bytes', async () => {
  const tree = await renderThread();
  await attach(tree, 'library');

  await press(tree, 'photo-review-discard');
  await ReactTestRenderer.act(async () => {});

  expect(has(tree, 'photo-review')).toBe(false);
  expect(has(tree, 'photo-review-send')).toBe(false);
  expect(sendImage).not.toHaveBeenCalled();
  expect(has(tree, 'composer-input')).toBe(true);

  await ReactTestRenderer.act(() => {
    tree.unmount();
  });
});

/**
 * THE ONE CONTROL ON THIS PANEL THAT COULD LIE. Send is refused while a send
 * is in flight and "Take another" is gone by then, but Discard was an
 * unguarded press: it removed the panel and stopped nothing, so the person
 * who pressed it watched the photo they had just discarded arrive in the
 * thread. The "Preparing photo…" row is up at that exact moment, which is
 * what invites the press.
 */
test('Discard is unavailable while the photo is sending, and stops nothing if pressed', async () => {
  let settle!: () => void;
  sendImage.mockImplementation(
    () =>
      new Promise<void>(resolve => {
        settle = () => resolve();
      }),
  );
  const tree = await renderThread();
  await attach(tree, 'library');
  await press(tree, 'photo-review-send');

  expect(sendImage).toHaveBeenCalledTimes(1);
  expect(has(tree, 'photo-review')).toBe(true);
  const discard = byId(tree, 'photo-review-discard').find(n => n.props.onPress)!;
  expect(discard.props.disabled).toBe(true);
  expect(discard.props.accessibilityState).toEqual({ disabled: true });

  // And a press that lands anyway — one that beat the state to the screen —
  // changes nothing: the send is still the only thing happening, and the
  // panel is still telling the truth about it.
  await ReactTestRenderer.act(async () => {
    discard.props.onPress();
  });
  expect(has(tree, 'photo-review')).toBe(true);
  expect(sendImage).toHaveBeenCalledTimes(1);

  await ReactTestRenderer.act(async () => {
    settle();
  });
  expect(has(tree, 'photo-review')).toBe(false);
  expect(sendImage).toHaveBeenCalledTimes(1);

  await ReactTestRenderer.act(() => {
    tree.unmount();
  });
});

test('the photo draws at up to 200pt, not always at 200pt', async () => {
  const tree = await renderThread();
  await attach(tree, 'library');

  const image = byId(tree, 'photo-review-image')[0]!;
  const style = StyleSheet.flatten(image.props.style)!;
  // A MAXIMUM, as the constant is named. With a fixed height a wide, short
  // photo is letterboxed inside a permanently 200pt frame and the panel
  // cannot give the space back to the size line and the two controls —
  // which is the very reason 200 was chosen over the bubble's 320.
  expect(style.maxHeight).toBe(PHOTO_REVIEW_MAX_HEIGHT);
  expect(style.height).toBeUndefined();
  expect(style.aspectRatio).toBeCloseTo(1200 / 900);
  expect(image.props.resizeMode).toBe('contain');
  // The largest element on the panel is spoken in the deck's words, like
  // every other word here.
  expect(image.props.accessibilityLabel).toBe('The photo you picked');

  await ReactTestRenderer.act(() => {
    tree.unmount();
  });
});

test('Android’s Back answers the photo, and leaves a send alone', async () => {
  const tree = await renderThread();
  await attach(tree, 'library');

  // A photo waiting for a decision is a thing on screen to close, not a
  // reason to leave the conversation.
  expect(await pressBack()).toBe(true);
  expect(has(tree, 'photo-review')).toBe(false);
  expect(sendImage).not.toHaveBeenCalled();
  // With nothing open the thread yields and the router pops, as before.
  expect(await pressBack()).toBe(false);

  await ReactTestRenderer.act(() => {
    tree.unmount();
  });
});

test('Back does not hide a photo that is already going', async () => {
  let settle!: () => void;
  sendImage.mockImplementation(
    () =>
      new Promise<void>(resolve => {
        settle = () => resolve();
      }),
  );
  const tree = await renderThread();
  await attach(tree, 'library');
  await press(tree, 'photo-review-send');

  // Back cannot un-send it either, so it does not pretend to: the press
  // falls through to the router, exactly as it would with nothing open.
  expect(await pressBack()).toBe(false);
  expect(has(tree, 'photo-review')).toBe(true);

  await ReactTestRenderer.act(async () => {
    settle();
  });

  await ReactTestRenderer.act(() => {
    tree.unmount();
  });
});

test('leaving the conversation discards the review', async () => {
  const tree = await renderThread();
  await attach(tree, 'library');
  expect(has(tree, 'photo-review')).toBe(true);

  await ReactTestRenderer.act(async () => {
    tree.update(
      <ChatThreadScreen
        peerId="peer-2"
        onBack={jest.fn()}
        onOpenPeerProfile={jest.fn()}
        onOpenPhoto={jest.fn()}
      />,
    );
  });
  await ReactTestRenderer.act(async () => {});

  // A photo picked for one person must never be sitting in another's
  // composer, and its bytes must not outlive the conversation they were
  // chosen for.
  expect(has(tree, 'photo-review')).toBe(false);
  expect(sendImage).not.toHaveBeenCalled();

  await ReactTestRenderer.act(() => {
    tree.unmount();
  });
});

test('backgrounding the phone discards the review', async () => {
  const tree = await renderThread();
  await attach(tree, 'library');
  expect(has(tree, 'photo-review')).toBe(true);

  await ReactTestRenderer.act(async () => {
    for (const listener of [...appStateListeners]) listener('background');
  });
  await ReactTestRenderer.act(async () => {});

  expect(has(tree, 'photo-review')).toBe(false);
  expect(sendImage).not.toHaveBeenCalled();

  await ReactTestRenderer.act(() => {
    tree.unmount();
  });
});

test('a camera pick offers another take; a library pick does not', async () => {
  const tree = await renderThread();
  await attach(tree, 'camera');
  expect(has(tree, 'photo-review-retake')).toBe(true);
  expect(texts(tree)).toContain('Take another');

  // Another take re-opens the camera, never the library, and replaces the
  // photo under review rather than stacking a second one.
  pick.mockClear();
  await press(tree, 'photo-review-retake');
  await ReactTestRenderer.act(async () => {});
  expect(pick).toHaveBeenCalledTimes(1);
  expect(pick.mock.calls[0]![0]).toBe('camera');
  expect(has(tree, 'photo-review')).toBe(true);
  expect(sendImage).not.toHaveBeenCalled();

  await press(tree, 'photo-review-discard');
  await attach(tree, 'library');
  expect(has(tree, 'photo-review-retake')).toBe(false);

  await ReactTestRenderer.act(() => {
    tree.unmount();
  });
});

test('a cancelled pick leaves the composer alone', async () => {
  pick.mockRejectedValue(new media.PickCancelled('library'));
  const tree = await renderThread();
  await attach(tree, 'library');

  expect(has(tree, 'photo-review')).toBe(false);
  expect(has(tree, 'composer-input')).toBe(true);
  expect(sendImage).not.toHaveBeenCalled();

  await ReactTestRenderer.act(() => {
    tree.unmount();
  });
});
