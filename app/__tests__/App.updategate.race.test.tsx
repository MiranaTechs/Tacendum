/**
 * The update gate's races: what happens when the answer comes back to a
 * DIFFERENT app than the one that asked.
 *
 * The file next door proves the wiring with the question and the answer next
 * to each other. Every defect proved here lives in the gap between them: the
 * policy fetch can take seconds, and in those seconds an autolock can relock
 * the phone, a coerced unlock can open the decoy world, and a notification
 * tap consumed a moment earlier can still be resolving. Each of the three
 * continuations used to navigate anyway, and the worst of them turned the
 * wall's one control into a real-workspace unlock under coercion.
 *
 * The `../src/ws` mock is App.lock.test.tsx's, for the same reason: the WS
 * client is the one seam that says whether a workspace really opened.
 */

jest.mock('../src/ws', () => {
  const calls = {
    start: jest.fn(),
    stop: jest.fn(),
    send: jest.fn((_frame: unknown) => true),
  };
  class WsClient {
    onFrame(_cb: (f: unknown) => void) {}
    onState(_cb: (s: string) => void) {}
    start(token: string) {
      calls.start(token);
    }
    stop() {
      calls.stop();
    }
    suspend() {
      calls.stop();
    }
    resume() {}
    send(frame: unknown) {
      return calls.send(frame) as boolean;
    }
    get isOpen() {
      return false;
    }
  }
  return { WsClient, __ws: { calls } };
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
const PEER_ID = '01KYDBSSDJSPC9J0E5N2AWMJ6Z';

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
  readSharedState: jest.Mock;
  deleteSharedState: jest.Mock;
};

const mounted: ReactTestRenderer.ReactTestRenderer[] = [];
/** Every AppState subscriber the app registered, so the test can be the OS. */
let appStateListeners: ((next: string) => void)[] = [];
const realFetch = globalThis.fetch;

/**
 * A policy request that answers only when the test says so, and answers with
 * a floor this build cannot meet. Returns the release.
 */
function parkPolicyFetch(minBuild: number): () => void {
  let release!: () => void;
  const held = new Promise<void>(r => {
    release = r;
  });
  globalThis.fetch = (async (url: string) => {
    if (String(url).includes('/v1/client-policy')) {
      await held;
      const body = { ios: { minBuild }, android: { minBuild } };
      return {
        ok: true,
        status: 200,
        json: async () => body,
        text: async () => JSON.stringify(body),
      };
    }
    return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
  }) as unknown as typeof fetch;
  return release;
}

/** A real workspace holding a finished, named account (App.lock's fixture). */
function seedWorkspaceWithProfile(name: string): void {
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

/** A real workspace with NO profile: the unlock lands on the landing screen. */
function seedEmptyWorkspace(name: string): void {
  sqlite.instances.set(name, {
    name,
    execute: jest.fn(async (sql: string) => {
      const s = String(sql);
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

/** The lock, with autolock at "Right away" so a background edge relocks. */
function enableInstantLock(): void {
  crypto.__keychain.set('lock.enabled', '1');
  crypto.__keychain.set('lock.passcode', '123456');
  crypto.__keychain.set('lock.autolockSec', '0');
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

async function enterCode(
  tree: ReactTestRenderer.ReactTestRenderer,
  code: readonly string[],
): Promise<void> {
  for (const key of code) await press(tree, `pin-key-${key}`);
  await press(tree, 'pin-submit');
  await ReactTestRenderer.act(flushMicrotasks);
}

async function transition(state: 'background' | 'active'): Promise<void> {
  await ReactTestRenderer.act(async () => {
    for (const fn of [...appStateListeners]) fn(state);
    await flushMicrotasks();
  });
}

const route = () =>
  (globalThis as Record<string, unknown>).TacendumDevRoute as string;

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
  seedWorkspaceWithProfile('tacendum.sqlite');
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    json: async () => ({}),
    text: async () => '',
  })) as unknown as typeof fetch;
  appStateListeners = [];
  jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation(((_type: string, fn: (next: string) => void) => {
      appStateListeners.push(fn);
      return { remove: jest.fn() };
    }) as unknown as typeof AppState.addEventListener);
});

afterEach(async () => {
  await ReactTestRenderer.act(async () => {
    while (mounted.length) mounted.pop()!.unmount();
  });
  jest.restoreAllMocks();
});

afterAll(() => {
  globalThis.fetch = realFetch;
  crypto.identityPublicKey.mockResolvedValue(null);
  crypto.hasIdentity.mockResolvedValue(false);
});

test('a relock during the Get started check does not lose the lock screen', async () => {
  enableInstantLock();
  sqlite.instances.delete('tacendum.sqlite');
  seedEmptyWorkspace('tacendum.sqlite');

  const tree = await renderApp();
  await ReactTestRenderer.act(flushMicrotasks);
  expect(route()).toBe('locked');
  await enterCode(tree, ['1', '2', '3', '4', '5', '6']);
  expect(route()).toBe('landing');

  // The check point dials, and parks.
  const release = parkPolicyFetch(0);
  await press(tree, 'landing-get-started');
  expect(route()).toBe('landing');

  // Autolock elapses while the fetch is in flight.
  await transition('background');
  await transition('active');
  expect(route()).toBe('locked');

  // The answer arrives to a locked app. Navigating on it would dismiss the
  // lock screen with no unlock behind it.
  await ReactTestRenderer.act(async () => {
    release();
    await flushMicrotasks();
  });
  expect(route()).toBe('locked');
  expect(
    tree.root.findAllByProps({ testID: 'lock-screen' }).length,
  ).toBeGreaterThan(0);
});

test('a duress session that begins mid-check is never shown the wall', async () => {
  enableInstantLock();
  seedWorkspaceWithProfile('tacendum-decoy.sqlite');

  const tree = await renderApp();
  await ReactTestRenderer.act(flushMicrotasks);
  await enterCode(tree, ['1', '2', '3', '4', '5', '6']);
  expect(session.mode).toBe('real');
  expect(route()).toBe('chats');

  const release = parkPolicyFetch(999);
  const now = jest
    .spyOn(Date, 'now')
    .mockReturnValue(Date.now() + 7 * 60 * 60 * 1000);
  try {
    // Foreground: the six hour throttle is spent, so the check dials.
    await transition('active');
    // The phone leaves and comes back; autolock relocks it mid-fetch.
    await transition('background');
    await transition('active');
  } finally {
    now.mockRestore();
  }
  expect(route()).toBe('locked');

  // The duress code opens the decoy world while the answer is still out.
  await enterCode(tree, ['6', '5', '4', '3', '2', '1']);
  expect(session.mode).toBe('duress');
  expect(route()).toBe('chats');

  await ReactTestRenderer.act(async () => {
    release();
    await flushMicrotasks();
  });
  // A decoy that showed the wall would announce that it is the decoy, and
  // the wall's only control opens the REAL workspace.
  expect(session.mode).toBe('duress');
  expect(route()).toBe('chats');
  expect(tree.root.findAllByProps({ testID: 'update-required' })).toHaveLength(
    0,
  );
});

test('the wall refuses to open the real workspace from a duress session', async () => {
  enableInstantLock();
  seedWorkspaceWithProfile('tacendum-decoy.sqlite');

  const tree = await renderApp();
  await ReactTestRenderer.act(flushMicrotasks);
  await enterCode(tree, ['6', '5', '4', '3', '2', '1']);
  expect(session.mode).toBe('duress');

  // The wall is put up directly: no reachable path raises it over a decoy
  // any more, and this is what stands if some later one does. `checkNow`
  // short-circuits to 'ok' in duress, so the recheck is guaranteed NOT to
  // come back blocked and the branch behind it would unlock the real world.
  await ReactTestRenderer.act(async () => {
    (
      globalThis as unknown as Record<string, (r: { name: string }) => void>
    ).TacendumDevNav({ name: 'updateRequired' });
    await flushMicrotasks();
  });
  expect(route()).toBe('updateRequired');

  await press(tree, 'update-check-again');
  await ReactTestRenderer.act(flushMicrotasks);
  expect(session.mode).toBe('duress');
  expect(route()).toBe('updateRequired');
});

test('a push tap redeemed after the wall is up does not open a thread on it', async () => {
  // No lock: the foreground edge resumes rather than relocks. This case never
  // touches the tree directly, so the renderer is left to the afterEach unmount.
  await renderApp();
  await ReactTestRenderer.act(flushMicrotasks);
  expect(route()).toBe('chats');

  // A banner tapped while the app was merely backgrounded. The shared-state
  // read is held so the redemption is still in flight when the wall arrives.
  const later = Date.now() + 7 * 60 * 60 * 1000;
  let releaseNav!: () => void;
  const navHeld = new Promise<void>(r => {
    releaseNav = r;
  });
  crypto.readSharedState.mockImplementation(async (name: string) => {
    if (name === 'pending-nav') {
      await navHeld;
      return `${later} ${PEER_ID}`;
    }
    return null;
  });
  crypto.deleteSharedState.mockImplementation(async () => undefined);

  globalThis.fetch = (async (url: string) => {
    if (String(url).includes('/v1/client-policy')) {
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

  const now = jest.spyOn(Date, 'now').mockReturnValue(later);
  try {
    await transition('background');
    await transition('active');
    // The wall is up while the tap redemption is still outstanding.
    expect(route()).toBe('updateRequired');
    await ReactTestRenderer.act(async () => {
      releaseNav();
      await flushMicrotasks();
    });
  } finally {
    now.mockRestore();
  }
  // What the wall is worth: nothing else is reachable from it.
  expect(route()).toBe('updateRequired');
});

/**
 * The same defect the wall's "Check again" had, at the other check point:
 * the answer can take seconds, and for all of them "Get started" sat there
 * looking pressable and doing nothing. A person waiting on a door with no
 * feedback presses it again.
 */
function getStartedButton(tree: ReactTestRenderer.ReactTestRenderer) {
  return tree.root
    .findAllByProps({ testID: 'landing-get-started' })
    .find(n => typeof n.props.accessibilityState === 'object')!;
}

test('"Get started" says it is checking, then opens registration', async () => {
  sqlite.instances.delete('tacendum.sqlite');
  seedEmptyWorkspace('tacendum.sqlite');
  const tree = await renderApp();
  await ReactTestRenderer.act(flushMicrotasks);
  expect(route()).toBe('landing');
  expect(getStartedButton(tree).props.accessibilityLabel).toBe('Get started');

  // The check dials and parks: the in-flight state is observable at all only
  // because the answer is held.
  const release = parkPolicyFetch(0);
  await press(tree, 'landing-get-started');
  expect(route()).toBe('landing');
  expect(getStartedButton(tree).props.accessibilityLabel).toBe('Checking…');
  expect(getStartedButton(tree).props.accessibilityState.busy).toBe(true);
  expect(getStartedButton(tree).props.accessibilityState.disabled).toBe(true);

  await ReactTestRenderer.act(async () => {
    release();
    await flushMicrotasks();
  });
  expect(route()).toBe('register');
});

test('"Get started" that comes back blocked stops being busy and shows the wall', async () => {
  sqlite.instances.delete('tacendum.sqlite');
  seedEmptyWorkspace('tacendum.sqlite');
  const tree = await renderApp();
  await ReactTestRenderer.act(flushMicrotasks);
  expect(route()).toBe('landing');

  const release = parkPolicyFetch(999);
  await press(tree, 'landing-get-started');
  expect(getStartedButton(tree).props.accessibilityState.busy).toBe(true);

  await ReactTestRenderer.act(async () => {
    release();
    await flushMicrotasks();
  });
  expect(route()).toBe('updateRequired');
});

test('a check that ends on the landing screen leaves the button pressable again', async () => {
  // A relock lands while the check is out, so the continuation returns
  // without navigating. The busy flag must not survive that: the landing
  // screen this person comes back to would have a dead button on it.
  enableInstantLock();
  sqlite.instances.delete('tacendum.sqlite');
  seedEmptyWorkspace('tacendum.sqlite');
  const tree = await renderApp();
  await ReactTestRenderer.act(flushMicrotasks);
  expect(route()).toBe('locked');
  await enterCode(tree, ['1', '2', '3', '4', '5', '6']);
  expect(route()).toBe('landing');

  const release = parkPolicyFetch(0);
  await press(tree, 'landing-get-started');
  expect(getStartedButton(tree).props.accessibilityState.busy).toBe(true);

  await transition('background');
  await transition('active');
  expect(route()).toBe('locked');
  await ReactTestRenderer.act(async () => {
    release();
    await flushMicrotasks();
  });
  expect(route()).toBe('locked');

  await enterCode(tree, ['1', '2', '3', '4', '5', '6']);
  expect(route()).toBe('landing');
  expect(getStartedButton(tree).props.accessibilityState.busy).toBe(false);
  expect(getStartedButton(tree).props.accessibilityLabel).toBe('Get started');
});
