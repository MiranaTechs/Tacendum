/**
 * Voice notes in the room.
 *
 * The rules these pin: a voice note is a THING, not words (no Edit, no
 * Copy); its bytes are loaded on tap rather than held in list state; the mic
 * takes the send position only when there is nothing to send; and a
 * recording becomes a PREVIEW, never a send — nothing leaves the phone until
 * the person taps send on something they could have heard first.
 *
 * Harness copied from ChatThread.attach.test.tsx.
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
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

const audio = jest.requireMock('tacendum-audio') as {
  __audio: {
    result: { dataB64: string; durationSec: number };
    played: string[];
    cancelled: number;
    started: number;
    recording: Error | null;
    emitRecordingFinished: (r: unknown) => void;
    emitPlaybackProgress: (v: number) => void;
    emitPlaybackFinished: () => void;
    decodedSeconds: number;
  };
  startRecording: jest.Mock;
  stopRecording: jest.Mock;
  cancelRecording: jest.Mock;
  startPlayback: jest.Mock;
};

const T0 = new Date('2026-07-25T12:00:00').getTime();

const VOICE_IN = {
  msgId: '01VOICEIN',
  peerId: 'peer-1',
  direction: 'in',
  body: JSON.stringify({ tcm: 'voice', att: 'blob-7', key: 'a2V5', dur: 95 }),
  ts: T0,
  status: 'received',
};

const VOICE_OUT = {
  msgId: '01VOICEOUT',
  peerId: 'peer-1',
  direction: 'out',
  body: JSON.stringify({ tcm: 'voice', att: 'blob-8', key: 'a2V5', dur: 4 }),
  ts: T0 + 60_000,
  status: 'sent',
};

beforeEach(async () => {
  await db.close();
  sqlite.reset();
  db.setWorkspace('real');
  await db.initDb();
  audio.__audio.played.length = 0;
  audio.__audio.cancelled = 0;
  audio.__audio.started = 0;
  audio.__audio.recording = null;
  jest.clearAllMocks();
  const instance = sqlite.instances.get('tacendum.sqlite')!;
  const base = instance.execute.getMockImplementation()!;
  instance.execute.mockImplementation(async (sql: string, params?: unknown) => {
    if (String(sql).includes('FROM messages')) {
      return { rows: [VOICE_IN, VOICE_OUT] };
    }
    if (String(sql).includes('FROM attachments') && String(sql).includes('dataB64')) {
      return { rows: [{ msgId: '01VOICEIN', direction: 'in', state: 'ready', dataB64: 'YXVkaW8=' }] };
    }
    return base(sql, params);
  });
});

afterEach(async () => {
  await db.close();
});

async function renderThread(): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <ChatThreadScreen
        peerId="peer-1"
        onBack={jest.fn()}
        onOpenPeerProfile={jest.fn()}
        onOpenPhoto={jest.fn()}
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

function press(tree: ReactTestRenderer.ReactTestRenderer, testID: string) {
  const node = tree.root.findAllByProps({ testID }).find(n => n.props.onPress);
  if (!node) throw new Error(`no pressable ${testID}`);
  return ReactTestRenderer.act(async () => {
    node.props.onPress();
  });
}

test('a voice note renders as a duration, never as raw JSON', async () => {
  const tree = await renderThread();
  const text = renderedText(tree);

  expect(text).toContain('1:35'); // 95 seconds
  expect(text).toContain('0:04');
  expect(text).toContain('Voice message');
  expect(text).not.toContain('"tcm"');
  expect(text).not.toContain('blob-7');
});

test('the mic holds the send position only while there is nothing to send', async () => {
  const tree = await renderThread();
  expect(tree.root.findAllByProps({ testID: 'composer-mic' }).length).toBeGreaterThan(0);
  expect(tree.root.findAllByProps({ testID: 'composer-send' })).toHaveLength(0);

  const input = tree.root
    .findAllByProps({ testID: 'composer-input' })
    .find(n => n.props.onChangeText);
  await ReactTestRenderer.act(async () => {
    input!.props.onChangeText('typing');
  });

  // Typing hands the slot back — the mic must never displace a real send.
  expect(tree.root.findAllByProps({ testID: 'composer-mic' })).toHaveLength(0);
  expect(tree.root.findAllByProps({ testID: 'composer-send' }).length).toBeGreaterThan(0);
});

test('a recording becomes a PREVIEW and sends nothing on its own', async () => {
  const sendVoice = jest.spyOn(messaging, 'sendVoice').mockResolvedValue(undefined);
  const tree = await renderThread();

  await press(tree, 'composer-mic');
  expect(audio.startRecording).toHaveBeenCalledWith(300);
  // Recording is not sending.
  expect(sendVoice).not.toHaveBeenCalled();

  await press(tree, 'voice-stop');
  // Stopping is STILL not sending — the preview is the whole point.
  expect(audio.stopRecording).toHaveBeenCalled();
  expect(sendVoice).not.toHaveBeenCalled();
  expect(renderedText(tree)).toContain('Ready to send');

  await press(tree, 'voice-send');
  expect(sendVoice).toHaveBeenCalledWith('peer-1', 'YXVkaW8=', 3);
  sendVoice.mockRestore();
});

test('discarding a take deletes it natively and sends nothing', async () => {
  const sendVoice = jest.spyOn(messaging, 'sendVoice').mockResolvedValue(undefined);
  const tree = await renderThread();

  await press(tree, 'composer-mic');
  await press(tree, 'voice-stop');
  await press(tree, 'voice-discard');

  expect(audio.cancelRecording).toHaveBeenCalled();
  expect(sendVoice).not.toHaveBeenCalled();
  expect(renderedText(tree)).not.toContain('Ready to send');
  sendVoice.mockRestore();
});

test('playing a note loads its bytes on tap — they are never held in list state', async () => {
  const tree = await renderThread();
  // Nothing is fetched merely by rendering the thread.
  expect(audio.startPlayback).not.toHaveBeenCalled();

  await press(tree, 'voice-01VOICEIN-in');

  expect(audio.startPlayback).toHaveBeenCalledWith('YXVkaW8=');
});

test('a voice row offers no Edit and no Copy — there are no words to rewrite', async () => {
  const tree = await renderThread();
  const bubble = tree.root
    .findAllByProps({ testID: 'msg-01VOICEOUT' })
    .find(n => n.props.onLongPress);
  await ReactTestRenderer.act(async () => {
    bubble!.props.onLongPress();
  });

  expect(tree.root.findAllByProps({ testID: 'edit-01VOICEOUT' })).toHaveLength(0);
  expect(tree.root.findAllByProps({ testID: 'copy-01VOICEOUT' })).toHaveLength(0);
});

test('a playing note counts up and fills its track — and stops when it ends', async () => {
  // The decoder agrees with the claim here; the disagreement case is its own
  // test below.
  audio.__audio.decodedSeconds = 95;
  const tree = await renderThread();
  // Idle: the bubble shows the LENGTH.
  expect(renderedText(tree)).toContain('1:35');

  await press(tree, 'voice-01VOICEIN-in');
  // The toggle's async work (load bytes -> startPlayback -> mark playing)
  // settles a tick after the press resolves.
  await ReactTestRenderer.act(async () => {});
  await ReactTestRenderer.act(async () => {
    audio.__audio.emitPlaybackProgress(12);
  });

  // Playing: the number is how far IN you are, with the length beside it.
  const text = renderedText(tree);
  expect(text).toContain('0:12');
  expect(text).toContain('1:35');

  // The fill is a real percentage of the way through, not a fixed bar.
  const fills = tree.root
    .findAllByType(require('react-native').View)
    .map(n => n.props.style)
    .flat(2)
    .filter(x => x && typeof x === 'object' && typeof x.width === 'string');
  expect(fills.some(f => f.width !== '0%')).toBe(true);

  // Finishing resets it — a stale play head must not sit on a quiet row.
  await ReactTestRenderer.act(async () => {
    audio.__audio.emitPlaybackFinished();
  });
  expect(renderedText(tree)).toContain('1:35');
  expect(renderedText(tree)).not.toContain('0:12');
});

test('the DECODED length replaces a sender\'s claim on first play', async () => {
  // A peer can claim any duration inside the schema's bounds. The decoder
  // is the only thing that knows the truth, so the moment this device plays
  // the note, the bubble stops repeating the claim.
  audio.__audio.decodedSeconds = 7;
  const tree = await renderThread();
  expect(renderedText(tree)).toContain('1:35'); // the claim, 95s

  await press(tree, 'voice-01VOICEIN-in');
  await ReactTestRenderer.act(async () => {});
  await ReactTestRenderer.act(async () => {
    audio.__audio.emitPlaybackFinished();
  });

  const text = renderedText(tree);
  expect(text).toContain('0:07'); // the truth
  expect(text).not.toContain('1:35');
});

test('opening a conversation lands on the newest message, however late content arrives', async () => {
  // THE BUG THIS PINS. The scroll-to-bottom was a one-shot on the first
  // content-size change, but a thread arrives in stages — messages, then
  // call chips, then attachment metadata that resizes rows. The single
  // scroll landed at the bottom of a PARTIAL list and every later stage
  // pushed the newest message out of view, so opening a conversation showed
  // its middle behind a "Latest messages" button.
  const tree = await renderThread();
  const list = tree.root.findByProps({ testID: 'thread-list' });
  const scrollToEnd = jest.fn();
  // The list's imperative handle is what the screen scrolls with.
  (list.instance as unknown as { scrollToEnd: unknown }).scrollToEnd = scrollToEnd;

  // Three loading stages, each followed by the position report the list
  // emits as it grows. Those reports say "not near the bottom" — because
  // the content just got taller under a scroll the APP performed — and
  // reading them as intent is exactly what stranded the view mid-thread.
  await ReactTestRenderer.act(async () => {
    list.props.onContentSizeChange(0, 400);
    list.props.onScroll({
      nativeEvent: {
        contentOffset: { y: 0 },
        contentSize: { height: 900 },
        layoutMeasurement: { height: 600 },
      },
    });
    list.props.onContentSizeChange(0, 900);
    list.props.onScroll({
      nativeEvent: {
        contentOffset: { y: 0 },
        contentSize: { height: 1400 },
        layoutMeasurement: { height: 600 },
      },
    });
    list.props.onContentSizeChange(0, 1400);
  });

  // Every stage re-pins, not just the first — nobody dragged.
  expect(scrollToEnd.mock.calls.length).toBeGreaterThanOrEqual(3);
  // And the jump control is not offered for a thread nobody scrolled.
  expect(tree.root.findAllByProps({ testID: 'jump-latest' })).toHaveLength(0);
});

test('once the person drags, the thread stops following and offers the jump', async () => {
  const tree = await renderThread();
  const list = tree.root.findByProps({ testID: 'thread-list' });
  const scrollToEnd = jest.fn();
  (list.instance as unknown as { scrollToEnd: unknown }).scrollToEnd = scrollToEnd;

  await ReactTestRenderer.act(async () => {
    list.props.onScrollBeginDrag();
    list.props.onScroll({
      nativeEvent: {
        contentOffset: { y: 0 },
        contentSize: { height: 2000 },
        layoutMeasurement: { height: 600 },
      },
    });
  });

  // Control has been handed over: new content must not yank the view.
  scrollToEnd.mockClear();
  await ReactTestRenderer.act(async () => {
    list.props.onContentSizeChange(0, 2600);
  });
  expect(scrollToEnd).not.toHaveBeenCalled();
  expect(tree.root.findAllByProps({ testID: 'jump-latest' }).length).toBeGreaterThan(0);
});

test('tapping the jump control re-anchors, so late content does not slide away again', async () => {
  // The case where the two halves of the anchor genuinely differ. After a
  // drag, atBottom is false. Tapping "Latest messages" scrolls to the end
  // and takes the anchor BACK — so a stage of content still loading re-pins
  // rather than stranding the person a second time, before any scroll event
  // has refreshed atBottom.
  const tree = await renderThread();
  const list = tree.root.findByProps({ testID: 'thread-list' });
  const scrollToEnd = jest.fn();
  (list.instance as unknown as { scrollToEnd: unknown }).scrollToEnd = scrollToEnd;

  await ReactTestRenderer.act(async () => {
    list.props.onScrollBeginDrag();
    list.props.onScroll({
      nativeEvent: {
        contentOffset: { y: 0 },
        contentSize: { height: 2000 },
        layoutMeasurement: { height: 600 },
      },
    });
  });
  expect(tree.root.findAllByProps({ testID: 'jump-latest' }).length).toBeGreaterThan(0);

  await press(tree, 'jump-latest');
  scrollToEnd.mockClear();

  // Content still arriving, and no scroll event yet to refresh atBottom.
  await ReactTestRenderer.act(async () => {
    list.props.onContentSizeChange(0, 2600);
  });
  expect(scrollToEnd).toHaveBeenCalled();
});

test('the jump bar stands down while a message is selected — it was covering the rail', async () => {
  // Reported from a device: long-press a message near the bottom and the
  // "Latest messages" bar sat on top of the rail's Reply / Copy / Delete —
  // and the only way to see past it, scrolling, is exactly what dismisses
  // the rail. The actions were not awkward to reach, they were unreachable:
  // every way of uncovering them destroyed the thing being uncovered.
  const tree = await renderThread();
  const list = tree.root.findByProps({ testID: 'thread-list' });

  // Scroll away so the bar is showing, the precondition without which this
  // test would pass for the wrong reason.
  await ReactTestRenderer.act(async () => {
    list.props.onScrollBeginDrag();
    list.props.onScroll({
      nativeEvent: {
        contentOffset: { y: 0 },
        contentSize: { height: 2000 },
        layoutMeasurement: { height: 600 },
      },
    });
  });
  expect(
    tree.root.findAllByProps({ testID: 'jump-latest' }).length,
  ).toBeGreaterThan(0);

  // Select a message: the bar goes.
  await ReactTestRenderer.act(async () => {
    tree.root
      .findAllByProps({ testID: 'msg-01VOICEIN' })[0]!
      .props.onLongPress();
  });
  expect(tree.root.findAllByProps({ testID: 'jump-latest' })).toHaveLength(0);

  // And it comes back when the selection ends — `showJump` was never
  // disturbed underneath, so nothing about the scroll position needs
  // recomputing.
  await ReactTestRenderer.act(async () => {
    tree.root
      .findAllByProps({ testID: 'msg-01VOICEIN' })[0]!
      .props.onLongPress();
  });
  expect(
    tree.root.findAllByProps({ testID: 'jump-latest' }).length,
  ).toBeGreaterThan(0);
});

test('the mic leaves the send slot while a take is recording or waiting, and a double tap starts one take', async () => {
  // The mic was gated on "nothing to send" only, so it stayed live under
  // the recording bar — and a tap there started a second take over the one
  // in progress, or over a finished take waiting to be sent.
  const tree = await renderThread();
  const mic = tree.root
    .findAllByProps({ testID: 'composer-mic' })
    .find(n => n.props.onPress);
  expect(mic).toBeDefined();

  // Two taps inside one frame: one recorder.
  await ReactTestRenderer.act(async () => {
    mic!.props.onPress();
    mic!.props.onPress();
  });
  expect(audio.startRecording).toHaveBeenCalledTimes(1);

  // Recording: the slot holds no mic.
  expect(tree.root.findAllByProps({ testID: 'composer-mic' })).toHaveLength(0);
  expect(tree.root.findAllByProps({ testID: 'voice-stop' }).length).toBeGreaterThan(0);

  await press(tree, 'voice-stop');
  // A take waiting to be sent: still no mic — nothing can overwrite it.
  expect(renderedText(tree)).toContain('Ready to send');
  expect(tree.root.findAllByProps({ testID: 'composer-mic' })).toHaveLength(0);

  await press(tree, 'voice-discard');
  // Discarded: the recorder is free and the mic is back.
  expect(tree.root.findAllByProps({ testID: 'composer-mic' }).length).toBeGreaterThan(0);
});

test('a playback tick repaints the playing row and no other bubble', async () => {
  // The play head reached every row, so the
  // 4 Hz progress tick re-rendered every visible bubble. Text bubbles run
  // the link tokenizer on every paint, which makes it the honest counter
  // for "was this bubble repainted".
  const links = jest.requireActual('../src/linkRuns') as typeof import('../src/linkRuns');
  const tokenize = jest.spyOn(links, 'linkRuns');
  const TEXT_A = {
    msgId: '01TEXTA',
    peerId: 'peer-1',
    direction: 'in',
    body: 'a few words',
    ts: T0 + 120_000,
    status: 'received',
  };
  const TEXT_B = {
    msgId: '01TEXTB',
    peerId: 'peer-1',
    direction: 'out',
    body: 'a few more',
    ts: T0 + 180_000,
    status: 'sent',
  };
  const instance = sqlite.instances.get('tacendum.sqlite')!;
  const current = instance.execute.getMockImplementation()!;
  instance.execute.mockImplementation(async (sql: string, params?: unknown) => {
    if (String(sql).includes('FROM messages')) {
      return { rows: [VOICE_IN, VOICE_OUT, TEXT_A, TEXT_B] };
    }
    return current(sql, params);
  });
  audio.__audio.decodedSeconds = 95;
  const tree = await renderThread();
  expect(tree.root.findAllByProps({ testID: 'msg-01TEXTA' }).length).toBeGreaterThan(0);

  await press(tree, 'voice-01VOICEIN-in');
  await ReactTestRenderer.act(async () => {});
  const painted = tokenize.mock.calls.length;
  expect(painted).toBeGreaterThan(0);

  await ReactTestRenderer.act(async () => {
    audio.__audio.emitPlaybackProgress(12);
  });
  // The playing row moved on…
  expect(renderedText(tree)).toContain('0:12');
  // …and no text bubble was painted for it.
  expect(tokenize.mock.calls.length).toBe(painted);
  tokenize.mockRestore();
});
