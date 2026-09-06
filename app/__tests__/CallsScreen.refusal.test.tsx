/**
 * THE CALL BUTTON SAYS WHY IT DID NOTHING.
 *
 * `ensurePermissions` returns a written sentence for a denied microphone and
 * `placeCall` throws `CallRefusedError` with a reason enum — and every call
 * site discarded both with `if (!permission.ok) return;` and an empty catch.
 * So the first call a new person placed with the microphone denied did
 * nothing at all, and a redial to a blocked peer left that row's button dead
 * for good.
 *
 * The shell resolves the reason; the screen holds it and renders it as an
 * IN-LAYOUT InlineError under the header. Nothing floats.
 */

jest.mock('../src/db', () => ({
  listAllCalls: jest.fn(),
  listChats: jest.fn(),
}));

import React from 'react';
import { AppState } from 'react-native';
import ReactTestRenderer from 'react-test-renderer';
import { CallRefusedError } from '../src/call';
import * as db from '../src/db';
import { CallsScreen } from '../src/screens/CallsScreen';
import { CALL_REFUSAL, CALL_REFUSAL_FOR } from '../src/callRefusalCopy';

const listAllCalls = db.listAllCalls as jest.MockedFunction<typeof db.listAllCalls>;
const listChats = db.listChats as jest.MockedFunction<typeof db.listChats>;

const T0 = new Date('2026-07-25T12:00:00').getTime();
const CALL = {
  cid: '01CALLB0000000000000000002',
  peerId: 'peer-2',
  direction: 'out' as const,
  kind: 'video' as const,
  state: 'ended' as const,
  reason: 'hangup',
  startedAt: T0,
  connectedAt: T0 + 4_000,
  endedAt: T0 + 34_000,
  lastSeenAt: T0 + 34_000,
  missed: 0,
};

/** Every AppState subscriber the screen registered, so a test can be the OS. */
let appStateListeners: Array<(next: string) => void> = [];

beforeEach(() => {
  jest.clearAllMocks();
  appStateListeners = [];
  jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation(((_type: string, fn: (next: string) => void) => {
      appStateListeners.push(fn);
      return { remove: jest.fn() };
    }) as unknown as typeof AppState.addEventListener);
  listAllCalls.mockResolvedValue([CALL]);
  listChats.mockResolvedValue([
    { peerId: 'peer-2', displayName: '', localName: 'Dawit', avatarB64: null },
  ] as never);
});

const mounted: ReactTestRenderer.ReactTestRenderer[] = [];
afterEach(() => {
  ReactTestRenderer.act(() => {
    for (const t of mounted.splice(0)) t.unmount();
  });
  jest.restoreAllMocks();
});

/** Be the OS: hand every subscriber the app-state the phone just entered. */
async function appState(next: 'active' | 'background' | 'inactive') {
  await ReactTestRenderer.act(async () => {
    for (const fn of appStateListeners) fn(next);
  });
}

async function renderCalls(onCall: jest.Mock) {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <CallsScreen onOpenChat={jest.fn()} onCall={onCall} />,
    );
  });
  await ReactTestRenderer.act(async () => {});
  mounted.push(tree);
  return tree;
}

/** The rendered HOST view, not the component element that produced it: the
 * accessibility props this asserts are the ones the platform sees. */
function notice(tree: ReactTestRenderer.ReactTestRenderer) {
  return (
    tree.root.findAll(
      n => typeof n.type === 'string' && n.props.testID === 'calls-refusal',
    )[0] ?? null
  );
}

function noticeText(tree: ReactTestRenderer.ReactTestRenderer): string | null {
  const box = notice(tree);
  if (!box) return null;
  return box
    .findAll(n => String(n.type) === 'Text')
    .map(n => [n.props.children].flat().join(''))
    .join('');
}

async function press(tree: ReactTestRenderer.ReactTestRenderer) {
  const redial = tree.root.findAll(
    n =>
      typeof n.type !== 'string' &&
      n.props.accessibilityLabel === 'Video call Dawit' &&
      typeof n.props.onPress === 'function',
  )[0]!;
  await ReactTestRenderer.act(async () => {
    redial.props.onPress();
  });
  await ReactTestRenderer.act(async () => {});
}

it('says nothing at all before anyone presses anything', async () => {
  const tree = await renderCalls(jest.fn().mockResolvedValue(null));
  expect(notice(tree)).toBeNull();
});

it('shows the denied-microphone sentence when the shell hands one back', async () => {
  const tree = await renderCalls(jest.fn().mockResolvedValue(CALL_REFUSAL.micDenied));
  await press(tree);
  expect(noticeText(tree)).toBe(CALL_REFUSAL.micDenied);
});

it('is an in-layout alert, never a floating one', async () => {
  const tree = await renderCalls(jest.fn().mockResolvedValue(CALL_REFUSAL.blocked));
  await press(tree);
  const box = notice(tree)!;
  expect(box.props.accessibilityRole).toBe('alert');
  expect(box.props.accessibilityLiveRegion).toBe('polite');
  // Nothing on a security surface hovers: no absolute positioning anywhere
  // between the notice and the screen root.
  let cursor: typeof box | null = box;
  while (cursor) {
    const style = (require('react-native') as typeof import('react-native')).StyleSheet.flatten(
      typeof cursor.props.style === 'function' ? undefined : cursor.props.style,
    ) as { position?: string } | undefined;
    expect(style?.position).not.toBe('absolute');
    cursor = cursor.parent;
  }
});

it('revives the dead redial: a blocked peer is told why', async () => {
  const tree = await renderCalls(jest.fn().mockResolvedValue(CALL_REFUSAL_FOR.blocked));
  await press(tree);
  expect(noticeText(tree)).toBe(
    'You blocked them. Unblock them from their profile to call.',
  );
});

it('says nothing when the call goes through', async () => {
  const onCall = jest.fn().mockResolvedValue(null);
  const tree = await renderCalls(onCall);
  await press(tree);
  expect(onCall).toHaveBeenCalledWith('peer-2', 'video');
  expect(notice(tree)).toBeNull();
});

it('clears the last refusal on the next attempt', async () => {
  const onCall = jest
    .fn()
    .mockResolvedValueOnce(CALL_REFUSAL.busy)
    .mockResolvedValueOnce(null);
  const tree = await renderCalls(onCall);
  await press(tree);
  expect(noticeText(tree)).toBe(CALL_REFUSAL.busy);
  await press(tree);
  expect(notice(tree)).toBeNull();
});

it('says the same thing when the rotor action places the call', async () => {
  // Two entry points, one notice: a person who never leaves the row must not
  // get the silent version.
  const tree = await renderCalls(jest.fn().mockResolvedValue(CALL_REFUSAL.identityChanged));
  const row = tree.root.findAll(
    n =>
      typeof n.type !== 'string' &&
      String(n.props.accessibilityLabel ?? '').startsWith('Dawit,'),
  )[0]!;
  await ReactTestRenderer.act(async () => {
    row.props.onAccessibilityAction({ nativeEvent: { actionName: 'call-back' } });
  });
  await ReactTestRenderer.act(async () => {});
  expect(noticeText(tree)).toBe(CALL_REFUSAL.identityChanged);
});

it('shows nothing if the shell throws instead of resolving', async () => {
  // The shell owns the refusal contract. A thrown error is a bug, not a
  // sentence, and the screen must not render an Error's message — which is
  // written for a log ('peer is blocked'), not for a person.
  const tree = await renderCalls(jest.fn().mockRejectedValue(new Error('peer is blocked')));
  await press(tree);
  expect(notice(tree)).toBeNull();
});

it('the deck and ensurePermissions cannot drift apart', async () => {
  // The literal still lives in call/index.ts (moving it is owed to the
  // cluster that owns that file). Byte equality here is what keeps the two
  // homes one sentence.
  const native = require('tacendum-call') as {
    requestPermissions: jest.Mock;
  };
  native.requestPermissions.mockResolvedValueOnce({ camera: 'denied', mic: 'denied' });
  const { ensurePermissions } = require('../src/call') as typeof import('../src/call');
  await expect(ensurePermissions(false)).resolves.toEqual({
    ok: false,
    video: false,
    reason: CALL_REFUSAL.micDenied,
  });
});

it('maps every thrown reason to its own sentence, and none to an Error message', () => {
  expect(CALL_REFUSAL_FOR).toEqual({
    blocked: CALL_REFUSAL.blocked,
    identity_changed: CALL_REFUSAL.identityChanged,
    busy: CALL_REFUSAL.busy,
  });
  // Against the CLASS, not a regex: the old guard anchored two of its three
  // alternatives with `$`, and every deck sentence ends in a full stop, so
  // two thirds of it could never match and the Error messages it named were
  // not actually being kept out. Built from the constructor, so a reworded
  // Error message cannot slip past this either.
  for (const reason of ['blocked', 'identity_changed', 'busy'] as const) {
    const logText = new CallRefusedError(reason).message;
    expect(logText).not.toBe('');
    expect(CALL_REFUSAL_FOR[reason]).not.toBe(logText);
    // …and the deck sentence is a SENTENCE, which is what an Error message
    // written for a log never is: 'peer is blocked' is lowercase and
    // unpunctuated. (Not `not.toContain`: 'safety number changed' is a
    // legitimate clause inside the deck's own sentence.)
    expect(CALL_REFUSAL_FOR[reason]).toMatch(/^[A-Z].*\.$/s);
    expect(logText).not.toMatch(/^[A-Z].*\.$/s);
  }
});

it('drops the refusal when the app comes back — the person may have just fixed it', async () => {
  // The micDenied sentence's own instruction is "Turn it on in Settings".
  // Somebody who follows it leaves the app, grants the microphone, and comes
  // back to find 'Microphone access is off.' still sitting under the header,
  // now false — and false for exactly as long as they are acting on it. The
  // tab is not unmounted by that trip the way a tab switch unmounts it.
  const tree = await renderCalls(jest.fn().mockResolvedValue(CALL_REFUSAL.micDenied));
  await press(tree);
  expect(noticeText(tree)).toBe(CALL_REFUSAL.micDenied);

  await appState('active');
  expect(notice(tree)).toBeNull();
});

it('keeps the refusal while the phone is only pocketed', async () => {
  // The falsifier for the case above: clearing on ANY app-state event would
  // pass it, and would take the sentence down under a notification shade.
  const tree = await renderCalls(jest.fn().mockResolvedValue(CALL_REFUSAL.blocked));
  await press(tree);
  await appState('background');
  await appState('inactive');
  expect(noticeText(tree)).toBe(CALL_REFUSAL.blocked);
});
