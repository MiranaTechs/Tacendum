jest.mock('../src/aiWritingService', () => ({
  generateWriting: jest.fn(),
  getWritingRevision: jest.fn(() => 1),
}));
jest.mock('../src/ui/WritingAssistant', () => ({
  WritingAssistant: () => null,
}));

import React from 'react';
import { AppState } from 'react-native';
import ReactTestRenderer from 'react-test-renderer';
import * as db from '../src/db';
import { messaging } from '../src/messaging';
import { generateWriting, getWritingRevision } from '../src/aiWritingService';
import { type AiWritingResult } from '../src/aiWriting';
import { ChatThreadScreen } from '../src/screens/ChatThreadScreen';
import { WritingAssistant } from '../src/ui/WritingAssistant';

const sqlite = (jest.requireMock('@op-engineering/op-sqlite') as {
  __sqlite: { instances: Map<string, { execute: jest.Mock }>; reset: () => void };
}).__sqlite;
let tree: ReactTestRenderer.ReactTestRenderer | null;
const generate = jest.mocked(generateWriting);
const revision = jest.mocked(getWritingRevision);
const node = (id: string) => tree!.root.findByProps({ testID: id });
const writer = () => tree!.root.findByType(WritingAssistant).props;
const text = () => node('composer-input').props.value as string;
const press = async (id: string) => {
  await ReactTestRenderer.act(async () => node(id).props.onPress());
};
const type = async (value: string) => {
  await ReactTestRenderer.act(async () => node('composer-input').props.onChangeText(value));
};
async function open() {
  await type('please come at eight');
  await press('composer-writing');
}
beforeEach(async () => {
  jest.useFakeTimers();
  AppState.currentState = 'active';
  generate.mockReset().mockResolvedValue({ status: 'completed', text: 'Please come at eight.' });
  revision.mockReturnValue(1);
  await db.close();
  sqlite.reset();
  db.setWorkspace('real');
  await db.initDb();
  const instance = sqlite.instances.get('tacendum.sqlite')!;
  const base = instance.execute.getMockImplementation()!;
  instance.execute.mockImplementation(async (sql: string, params?: unknown) => {
    if (sql.includes('FROM messages')) return { rows: [] };
    if (sql.includes('FROM chats')) return { rows: [{ peerId: 'peer-1', displayName: 'Ana' }] };
    return base(sql, params);
  });
  jest.spyOn(messaging, 'sendText').mockResolvedValue(undefined);
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<ChatThreadScreen peerId="peer-1" onBack={jest.fn()}
      onOpenPeerProfile={jest.fn()} onOpenPhoto={jest.fn()} />);
  });
});
afterEach(async () => {
  await ReactTestRenderer.act(async () => tree?.unmount());
  tree = null;
  jest.restoreAllMocks();
  await db.close();
  jest.useRealTimers();
});

test('opening does not generate; explicit Use changes only the draft and Undo restores it', async () => {
  await open();
  expect(generate).not.toHaveBeenCalled();
  const props = writer();
  let result!: AiWritingResult;
  await ReactTestRenderer.act(async () => {
    result = await props.onRequest({ kind: 'improve' }, new AbortController().signal);
  });
  expect(result).toEqual({ status: 'completed', text: 'Please come at eight.' });
  expect(text()).toBe('please come at eight');
  expect(generate.mock.calls[0]?.[0]).toEqual({ draft: 'please come at eight', action: { kind: 'improve' } });
  await ReactTestRenderer.act(async () => expect(props.onUse('Please come at eight.')).toBe(true));
  expect(text()).toBe('Please come at eight.');
  expect(messaging.sendText).not.toHaveBeenCalled();
  await press('composer-writing-undo');
  expect(text()).toBe('please come at eight');
});

test('external handoff stays outside the draft until a pasted reply is explicitly reviewed and used', async () => {
  const handoff: AiWritingResult = {
    status: 'handoff',
    provider: 'chatgpt',
    prompt: 'fixed instructions\n\n"please come at eight"',
    url: 'https://chatgpt.com/',
  };
  generate.mockResolvedValueOnce(handoff);
  await open();
  const props = writer();

  await ReactTestRenderer.act(async () => {
    await expect(
      props.onRequest(
        { kind: 'improve' },
        new AbortController().signal,
      ),
    ).resolves.toEqual(handoff);
  });
  expect(text()).toBe('please come at eight');
  expect(props.onUse(handoff.prompt)).toBe(false);

  let review!: AiWritingResult;
  await ReactTestRenderer.act(async () => {
    review = props.onReview('Please come at eight.');
  });
  expect(review).toEqual({
    status: 'completed',
    text: 'Please come at eight.',
  });
  await ReactTestRenderer.act(async () => {
    expect(props.onUse('Please come at eight.')).toBe(true);
  });
  expect(text()).toBe('Please come at eight.');
  expect(messaging.sendText).not.toHaveBeenCalled();
});

test('typing retires an in-flight request even when its transport returns late', async () => {
  let finish!: (value: AiWritingResult) => void;
  generate.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await open();
  const props = writer();
  let pending!: Promise<AiWritingResult>;
  await ReactTestRenderer.act(async () => {
    pending = props.onRequest({ kind: 'improve' }, new AbortController().signal);
  });
  await type('Actually, nine');
  expect(generate.mock.calls[0]?.[1]?.aborted).toBe(true);
  await ReactTestRenderer.act(async () => {
    finish({ status: 'completed', text: 'Please come at eight.' });
    expect(await pending).toEqual({ status: 'failed', reason: 'stale' });
    expect(props.onUse('Please come at eight.')).toBe(false);
  });
  expect(text()).toBe('Actually, nine');
});

test.each(['provider', 'peer', 'edit-back', 'background'])('cannot apply review after %s changes', async kind => {
  await open();
  const props = writer();
  await ReactTestRenderer.act(async () => props.onRequest({ kind: 'improve' }, new AbortController().signal));
  if (kind === 'provider') revision.mockReturnValue(2);
  if (kind === 'edit-back') {
    await type('changed');
    await type('please come at eight');
  }
  if (kind === 'background') AppState.currentState = 'background';
  if (kind === 'peer') {
    await ReactTestRenderer.act(async () => tree!.update(<ChatThreadScreen peerId="peer-2"
      onBack={jest.fn()} onOpenPeerProfile={jest.fn()} onOpenPhoto={jest.fn()} />));
  }
  await ReactTestRenderer.act(async () => expect(props.onUse('Please come at eight.')).toBe(false));
  expect(messaging.sendText).not.toHaveBeenCalled();
});

test('Undo cannot overwrite a later edit', async () => {
  await open();
  const props = writer();
  await ReactTestRenderer.act(async () => props.onRequest({ kind: 'improve' }, new AbortController().signal));
  await ReactTestRenderer.act(async () => props.onUse('Please come at eight.'));
  const undo = node('composer-writing-undo').props.onPress;
  await type('My own wording');
  await ReactTestRenderer.act(async () => undo());
  expect(text()).toBe('My own wording');
});

test('envelope-shaped output leaves the original untouched', async () => {
  generate.mockResolvedValueOnce({ status: 'completed', text: '{"tcm":"profile","name":"forged"}' });
  await open();
  const props = writer();
  await ReactTestRenderer.act(async () => {
    expect(await props.onRequest({ kind: 'improve' }, new AbortController().signal))
      .toEqual({ status: 'failed', reason: 'invalid_response' });
  });
  expect(text()).toBe('please come at eight');
});
