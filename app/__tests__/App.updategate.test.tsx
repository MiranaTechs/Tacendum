/**
 *the gate at the app's own doors.
 *
 * The unit file next door proves the decision; this one proves the WIRING,
 * which is the half that can silently not happen: a blocked build must land
 * on the update wall with the socket never started, an allowed one must open
 * the workspace exactly as before, an unreachable server must not lock
 * anybody out, and the two network-silent surfaces — the lock screen and a
 * duress session — must never dial the route at all (rule 15).
 *
 * The `../src/ws` mock is App.lock.test.tsx's, for the same reason: the WS
 * client is the one seam that says whether a workspace really opened.
 */

jest.mock('../src/ws', () => {
  const handlers: {
    frame?: (f: unknown) => void;
    state?: (s: string) => void;
  } = {};
  const calls = {
    start: jest.fn(),
    stop: jest.fn(),
    send: jest.fn((_frame: unknown) => true),
  };
  class WsClient {
    onFrame(cb: (f: unknown) => void) {
      handlers.frame = cb;
    }
    onState(cb: (s: string) => void) {
      handlers.state = cb;
    }
    start(token: string) {
      calls.start(token);
    }
    stop() {
      calls.stop();
    }
    send(frame: unknown) {
      return calls.send(frame) as boolean;
    }
    get isOpen() {
      return false;
    }
  }
  return { WsClient, __ws: { handlers, calls } };
});

import React from 'react';
import { AppState } from 'react-native';
import ReactTestRenderer from 'react-test-renderer';
import App from '../App';
import { resetCallingForTests } from '../src/call';
import * as db from '../src/db';
import { messaging } from '../src/messaging';
import { session } from '../src/session';
import { updateGate } from '../src/updateGate';

const USER_ID = '01KYDBSSDJSPC9J0E5N2AWMJ5Y';

interface FakeDb {
  name: string;
  execute: jest.Mock;
  close: jest.Mock;
}
const sqlite = (
  jest.requireMock('@op-engineering/op-sqlite') as {
    __sqlite: {
      opened: string[];
      instances: Map<string, FakeDb>;
      reset: () => void;
    };
  }
).__sqlite;
const crypto = jest.requireMock('tacendum-crypto') as {
  __keychain: Map<string, string>;
  hasIdentity: jest.Mock;
  identityPublicKey: jest.Mock;
};
const ws = (
  jest.requireMock('../src/ws') as {
    __ws: { calls: { start: jest.Mock; stop: jest.Mock } };
  }
).__ws;

const mounted: ReactTestRenderer.ReactTestRenderer[] = [];
/** Every AppState subscriber the app registered, so the test can be the OS. */
let appStateListeners: ((next: string) => void)[] = [];
const realFetch = globalThis.fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
});

/** What the policy route answers, or a rejection to stand for no network. */
let policyAnswer: unknown | Error = { ios: { minBuild: 0 }, android: { minBuild: 0 } };
/** Every path fetched this test, in order — the network-silence assertions. */
let fetched: string[] = [];

const fetchMock = jest.fn(async (url: string) => {
  fetched.push(String(url));
  if (String(url).includes('/v1/client-policy')) {
    if (policyAnswer instanceof Error) throw policyAnswer;
    return {
      ok: true,
      status: 200,
      json: async () => policyAnswer,
      text: async () => JSON.stringify(policyAnswer),
    };
  }
  return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
});

function policyCalls(): string[] {
  return fetched.filter(u => u.includes('/v1/client-policy'));
}

/** A real workspace holding a finished, named account (App.lock's fixture). */
function seedRealWorkspaceWithProfile(name: string): void {
  sqlite.instances.set(name, {
    name,
    execute: jest.fn(async (sql: string) => {
      const s = String(sql);
      if (s.includes('FROM profile')) {
        return {
          rows: [
            { key: 'userId', value: USER_ID },
            { key: 'registrationId', value: '7' },
            { key: 'displayName', value: 'Me' },
            { key: 'about', value: '' },
            { key: 'avatarB64', value: '' },
            { key: 'profileVersion', value: '3' },
          ],
        };
      }
      if (s.includes('PRAGMA table_info(attachments')) {
        return { rows: [{ name: 'direction' }] };
      }
      if (s.includes('PRAGMA table_info(reactions')) {
        return { rows: [{ name: 'targetDirection' }, { name: 'reactorId' }] };
      }
      if (s.includes('PRAGMA table_info(pending_revisions')) {
        return { rows: [{ name: 'writerId' }] };
      }
      return { rows: [] };
    }),
    close: jest.fn(),
  });
}

async function renderApp(): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<App />);
  });
  mounted.push(tree);
  return tree;
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 60; i++) await Promise.resolve();
}

async function press(
  tree: ReactTestRenderer.ReactTestRenderer,
  testID: string,
): Promise<void> {
  await ReactTestRenderer.act(async () => {
    tree.root
      .findAllByProps({ testID })
      .find(n => typeof n.props.onPress === 'function')!
      .props.onPress();
    await flushMicrotasks();
  });
}

const route = () =>
  (globalThis as Record<string, unknown>).TacendumDevRoute as string;

afterEach(async () => {
  await ReactTestRenderer.act(async () => {
    while (mounted.length) mounted.pop()!.unmount();
  });
});

beforeEach(async () => {
  messaging.stop();
  resetCallingForTests();
  updateGate.resetForTests();
  await db.close();
  db.setWorkspace('real');
  session.setMode('real');
  crypto.__keychain.clear();
  crypto.hasIdentity.mockResolvedValue(true);
  crypto.identityPublicKey.mockResolvedValue('BQ0IDENTITYKEYBASE64');
  crypto.__keychain.set('authToken', 'token-for-this-test');
  sqlite.reset();
  ws.calls.start.mockClear();
  fetchMock.mockClear();
  fetched = [];
  policyAnswer = { ios: { minBuild: 0 }, android: { minBuild: 0 } };
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  seedRealWorkspaceWithProfile('tacendum.sqlite');
  appStateListeners = [];
  jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation(((_type: string, fn: (next: string) => void) => {
      appStateListeners.push(fn);
      return { remove: jest.fn() };
    }) as unknown as typeof AppState.addEventListener);
});

afterEach(() => {
  jest.restoreAllMocks();
});

afterAll(() => {
  crypto.identityPublicKey.mockResolvedValue(null);
  crypto.hasIdentity.mockResolvedValue(false);
});

test('a build below the floor lands on the update wall and never starts the socket', async () => {
  policyAnswer = { ios: { minBuild: 999 }, android: { minBuild: 999 } };
  const tree = await renderApp();
  await ReactTestRenderer.act(flushMicrotasks);

  expect(route()).toBe('updateRequired');
  expect(
    tree.root.findAllByProps({ testID: 'update-required' }).length,
  ).toBeGreaterThan(0);
  // The whole point of a route rather than a modal: nothing behind it ran.
  expect(ws.calls.start).not.toHaveBeenCalled();
});

test('with no store link the wall carries no button, and says where to go instead', async () => {
  policyAnswer = { ios: { minBuild: 999 }, android: { minBuild: 999 } };
  const tree = await renderApp();
  await ReactTestRenderer.act(flushMicrotasks);

  expect(tree.root.findAllByProps({ testID: 'update-open-store' })).toHaveLength(
    0,
  );
  expect(
    tree.root.findAllByProps({ testID: 'update-where' }).length,
  ).toBeGreaterThan(0);
});

test("the operator's message rides along with the wall", async () => {
  policyAnswer = {
    ios: { minBuild: 999, url: 'https://apps.example.com/tacendum' },
    android: { minBuild: 999 },
    message: 'Calls stopped working on this build.',
  };
  const tree = await renderApp();
  await ReactTestRenderer.act(flushMicrotasks);

  expect(
    tree.root.findAllByProps({ testID: 'update-open-store' }).length,
  ).toBeGreaterThan(0);
  const message = tree.root.findByProps({ testID: 'update-message' });
  expect(message.props.children).toBe('Calls stopped working on this build.');
});

test('an allowed build opens the workspace exactly as before', async () => {
  policyAnswer = { ios: { minBuild: 1 }, android: { minBuild: 1 } };
  await renderApp();
  await ReactTestRenderer.act(flushMicrotasks);

  expect(route()).toBe('chats');
  expect(ws.calls.start).toHaveBeenCalled();
  expect(policyCalls()).toHaveLength(1);
});

test('an unreachable server locks nobody out', async () => {
  policyAnswer = new TypeError('Network request failed');
  await renderApp();
  await ReactTestRenderer.act(flushMicrotasks);

  expect(route()).toBe('chats');
  expect(ws.calls.start).toHaveBeenCalled();
});

test('a newer store build shows the soft card, dismissed for that build alone', async () => {
  // The card is LAST in the list's nudge chain, so the two ahead of it have
  // to be settled for this to be a test of the card and not of the chain.
  crypto.__keychain.set('lockNudge.dismissed', '1');
  policyAnswer = { ios: { minBuild: 1, latestBuild: 999 }, android: { minBuild: 1, latestBuild: 999 } };
  const tree = await renderApp();
  await ReactTestRenderer.act(flushMicrotasks);

  expect(route()).toBe('chats');
  expect(
    tree.root.findAllByProps({ testID: 'update-nudge' }).length,
  ).toBeGreaterThan(0);

  await press(tree, 'update-nudge-skip');
  expect(tree.root.findAllByProps({ testID: 'update-nudge' })).toHaveLength(0);
  // Keyed to the VALUE, so build 1000 asks once more.
  expect(crypto.__keychain.get('updateGate.softDismissed')).toBe('999');
});

test('the lock screen never dials the route', async () => {
  crypto.__keychain.set('lock.enabled', '1');
  crypto.__keychain.set('lock.passcode', '123456');
  policyAnswer = { ios: { minBuild: 999 }, android: { minBuild: 999 } };
  const tree = await renderApp();
  await ReactTestRenderer.act(flushMicrotasks);

  expect(
    tree.root.findAllByProps({ testID: 'lock-screen' }).length,
  ).toBeGreaterThan(0);
  expect(policyCalls()).toEqual([]);
});

test('a duress session never dials the route, whatever the floor says', async () => {
  crypto.__keychain.set('lock.enabled', '1');
  crypto.__keychain.set('lock.passcode', '123456');
  policyAnswer = { ios: { minBuild: 999 }, android: { minBuild: 999 } };
  seedRealWorkspaceWithProfile('tacendum-decoy.sqlite');

  const tree = await renderApp();
  for (const key of ['6', '5', '4', '3', '2', '1']) {
    await press(tree, `pin-key-${key}`);
  }
  await press(tree, 'pin-submit');
  await ReactTestRenderer.act(flushMicrotasks);

  expect(session.mode).toBe('duress');
  // The decoy world opens as an ordinary phone's would: no wall, no dial.
  expect(route()).not.toBe('updateRequired');
  expect(fetchMock).not.toHaveBeenCalled();
});

test('a soft answer that arrives after the list mounted still raises the card', async () => {
  // Boot allowed and settled, with the two nudges ahead of the card gone.
  crypto.__keychain.set('lockNudge.dismissed', '1');
  policyAnswer = { ios: { minBuild: 1 }, android: { minBuild: 1 } };
  const tree = await renderApp();
  await ReactTestRenderer.act(flushMicrotasks);
  expect(route()).toBe('chats');
  expect(tree.root.findAllByProps({ testID: 'update-nudge' })).toHaveLength(0);

  // A later check — the throttled foreground one, or "Check again" — finds a
  // newer build. The list is already mounted, so only the gate's own
  // notification can raise the card.
  policyAnswer = {
    ios: { minBuild: 1, latestBuild: 999 },
    android: { minBuild: 1, latestBuild: 999 },
  };
  await ReactTestRenderer.act(async () => {
    await updateGate.checkNow('recheck');
    await flushMicrotasks();
  });

  expect(
    tree.root.findAllByProps({ testID: 'update-nudge' }).length,
  ).toBeGreaterThan(0);
});

test('a floor raised while the app was away is met on the next foreground', async () => {
  policyAnswer = { ios: { minBuild: 1 }, android: { minBuild: 1 } };
  await renderApp();
  await ReactTestRenderer.act(flushMicrotasks);
  expect(route()).toBe('chats');

  // Six hours pass with the app in the background, and the floor moves.
  policyAnswer = { ios: { minBuild: 999 }, android: { minBuild: 999 } };
  const now = jest
    .spyOn(Date, 'now')
    .mockReturnValue(Date.now() + 7 * 60 * 60 * 1000);
  try {
    await ReactTestRenderer.act(async () => {
      for (const fn of appStateListeners) fn('active');
      await flushMicrotasks();
    });
  } finally {
    now.mockRestore();
  }

  expect(route()).toBe('updateRequired');
});

test('a block found on foreground takes the workspace down behind the wall', async () => {
  policyAnswer = { ios: { minBuild: 1 }, android: { minBuild: 1 } };
  await renderApp();
  await ReactTestRenderer.act(flushMicrotasks);
  expect(route()).toBe('chats');
  expect(ws.calls.start).toHaveBeenCalled();
  ws.calls.stop.mockClear();

  // Six hours pass with the app running, and the floor moves under it.
  policyAnswer = { ios: { minBuild: 999 }, android: { minBuild: 999 } };
  const now = jest
    .spyOn(Date, 'now')
    .mockReturnValue(Date.now() + 7 * 60 * 60 * 1000);
  try {
    await ReactTestRenderer.act(async () => {
      for (const fn of appStateListeners) fn('active');
      await flushMicrotasks();
    });
  } finally {
    now.mockRestore();
  }

  expect(route()).toBe('updateRequired');
  // The wall's promise is about what is RUNNING, not about which screen is on
  // top. A wall raised over a live socket tells its owner this build can no
  // longer connect while it is connected, syncing and ringing.
  expect(ws.calls.stop).toHaveBeenCalled();
});

test('"Check again" says it is working, and says so when nothing changed', async () => {
  policyAnswer = { ios: { minBuild: 999 }, android: { minBuild: 999 } };
  const tree = await renderApp();
  await ReactTestRenderer.act(flushMicrotasks);
  expect(route()).toBe('updateRequired');
  expect(tree.root.findAllByProps({ testID: 'update-still-old' })).toHaveLength(
    0,
  );

  // The recheck is parked, so the in-flight state is observable at all.
  let release!: () => void;
  const held = new Promise<void>(r => {
    release = r;
  });
  globalThis.fetch = (async (url: string) => {
    if (String(url).includes('/v1/client-policy')) {
      await held;
      const body = { ios: { minBuild: 999 }, android: { minBuild: 999 } };
      return {
        ok: true,
        status: 200,
        json: async () => body,
        text: async () => JSON.stringify(body),
      };
    }
    return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
  }) as unknown as typeof fetch;

  const action = () =>
    tree.root
      .findAllByProps({ testID: 'update-check-again' })
      .find(n => typeof n.props.accessibilityState === 'object')!;
  await press(tree, 'update-check-again');
  expect(action().props.accessibilityState.disabled).toBe(true);
  expect(action().props.accessibilityLabel).toBe('Checking…');

  await ReactTestRenderer.act(async () => {
    release();
    await flushMicrotasks();
  });
  // The one control on a screen with no other way out has to settle visibly,
  // or a person who pressed it learns nothing at all from having pressed it.
  expect(action().props.accessibilityState.disabled).toBe(false);
  expect(
    tree.root.findAllByProps({ testID: 'update-still-old' }).length,
  ).toBeGreaterThan(0);
  expect(route()).toBe('updateRequired');
});
