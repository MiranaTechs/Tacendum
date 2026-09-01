/**
 * The foreground lock check fails CLOSED (the lock design meets the
 * fail-closed rule).
 *
 * On every background→active edge the app asks `lock.status()` whether an
 * autolock is owed. That read is the verdict the whole branch turns on, and
 * an earlier revision caught a rejection into `{enabled: false}` — so ANY
 * secret-storage error (an iOS Keychain hiccup, the Android Keystore store
 * throwing on a present-but-unreadable value) resumed the workspace and the
 * transport, bypassing an elapsed autolock. A Keychain error must not
 * unlock, on either platform: a rejection now RELOCKS — workspace closed,
 * socket down — and the cost is one lock-screen tap once the store answers
 * again.
 *
 * This file runs the branch under the default (iOS) platform on purpose:
 * the branch is shared, and the fail-closed rule is platform-blind.
 */

jest.mock('../src/ws', () => {
  const calls = {
    start: jest.fn(),
    stop: jest.fn(),
    send: jest.fn((_frame: unknown) => true),
    running: false,
  };
  class WsClient {
    onFrame(_cb: (f: unknown) => void) {}
    onState(_cb: (s: string) => void) {}
    start(token: string) {
      calls.running = true;
      calls.start(token);
    }
    stop() {
      calls.running = false;
      calls.stop();
    }
    suspend() {
      calls.running = false;
      calls.stop();
    }
    send(frame: unknown) {
      return calls.send(frame) as boolean;
    }
    get isOpen() {
      return false;
    }
  }
  return { WsClient, __ws: { calls } };
});

jest.mock('../src/registration', () => ({
  createOrRestoreAccount: jest.fn(),
}));

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { AppState } from 'react-native';
import App from '../App';
import { resetCallingForTests } from '../src/call';
import * as db from '../src/db';
import { messaging } from '../src/messaging';
import { createOrRestoreAccount } from '../src/registration';
import { session } from '../src/session';

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
  getSecret: jest.Mock;
  hasIdentity: jest.Mock;
  identityPublicKey: jest.Mock;
};
const ws = jest.requireMock('../src/ws') as {
  __ws: {
    calls: { start: jest.Mock; stop: jest.Mock; running: boolean };
  };
};
const createOrRestoreAccountMock =
  createOrRestoreAccount as jest.MockedFunction<typeof createOrRestoreAccount>;

const USER_ID = '01KYDBSSDJSPC9J0E5N2AWMJ5Y';
const PROFILE: db.ProfileRow = {
  userId: USER_ID,
  registrationId: 7,
  displayName: 'Me',
  about: '',
  avatarB64: '',
  profileVersion: 3,
};

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

/** A real workspace holding a finished account (back.android's fixture). */
function seedRealWorkspaceWithProfile(): void {
  const instance: FakeDb = {
    name: 'tacendum.sqlite',
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
  };
  sqlite.instances.set('tacendum.sqlite', instance);
}

const mounted: ReactTestRenderer.ReactTestRenderer[] = [];
/** Every AppState subscriber the app registered, so the test can be the OS. */
let appStateListeners: ((next: string) => void)[] = [];

async function flush(): Promise<void> {
  for (let i = 0; i < 60; i++) await Promise.resolve();
}

async function renderApp(): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<App />);
  });
  mounted.push(tree);
  return tree;
}

async function press(
  tree: ReactTestRenderer.ReactTestRenderer,
  testID: string,
): Promise<void> {
  await ReactTestRenderer.act(async () => {
    tree.root.findByProps({ testID }).props.onPress();
  });
}

async function transition(state: 'background' | 'active'): Promise<void> {
  await ReactTestRenderer.act(async () => {
    for (const listener of [...appStateListeners]) listener(state);
    await flush();
  });
}

function currentRoute(): string {
  return (globalThis as Record<string, unknown>).TacendumDevRoute as string;
}

/** The jest.setup factory's own read, restorable after the failure leg. */
const healthyGetSecret = async (key: string): Promise<string | null> =>
  crypto.__keychain.get(key) ?? null;

const realFetch = globalThis.fetch;
const fetchMock = jest.fn(async () => ({
  ok: true,
  status: 200,
  json: async () => ({}),
  text: async () => '',
}));

beforeEach(async () => {
  messaging.stop();
  resetCallingForTests();
  await db.close();
  db.setWorkspace('real');
  session.setMode('real');
  crypto.getSecret.mockImplementation(healthyGetSecret);
  crypto.__keychain.clear();
  crypto.__keychain.set('authToken', 'token-for-this-test');
  // A lock whose autolock is an hour: a quick round trip owes NO relock, so
  // any relock the failure leg observes is the fail-closed branch itself.
  crypto.__keychain.set('lock.enabled', '1');
  crypto.__keychain.set('lock.passcode', '123456');
  crypto.__keychain.set('lock.autolockSec', '3600');
  crypto.hasIdentity.mockResolvedValue(true);
  crypto.identityPublicKey.mockResolvedValue('BQ0IDENTITYKEYBASE64');
  createOrRestoreAccountMock.mockReset().mockRejectedValue(new Error('unused'));
  sqlite.reset();
  seedRealWorkspaceWithProfile();
  ws.__ws.calls.start.mockClear();
  ws.__ws.calls.stop.mockClear();
  ws.__ws.calls.running = false;
  fetchMock.mockClear();
  globalThis.fetch = fetchMock as unknown as typeof fetch;

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
  crypto.getSecret.mockImplementation(healthyGetSecret);
  crypto.hasIdentity.mockResolvedValue(false);
  crypto.identityPublicKey.mockResolvedValue(null);
  await db.close();
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

test('a lock.status() rejection on foreground relocks instead of resuming the workspace', async () => {
  const stopSpy = jest.spyOn(messaging, 'stop');
  const resumeSpy = jest.spyOn(messaging, 'resume');

  const tree = await renderApp();
  expect(currentRoute()).toBe('locked');
  for (const key of ['1', '2', '3', '4', '5', '6']) {
    await press(tree, `pin-key-${key}`);
  }
  await press(tree, 'pin-submit');
  await ReactTestRenderer.act(flush);
  expect(currentRoute()).toBe('chats');

  // CONTROL LEG: with the Keychain healthy and an hour of autolock, a quick
  // round trip resumes the workspace — no relock owed, transport back up.
  stopSpy.mockClear();
  resumeSpy.mockClear();
  await transition('background');
  await transition('active');
  expect(currentRoute()).toBe('chats');
  expect(resumeSpy).toHaveBeenCalled();
  expect(stopSpy).not.toHaveBeenCalled();

  // FAILURE LEG: the same round trip, but the status read rejects (the
  // enabled flag is unreadable — the Android store now throws on a present-
  // but-unreadable value, and the iOS Keychain has always been able to
  // error). Unknown must read as LOCKED: the app relocks and nothing
  // resumes.
  stopSpy.mockClear();
  resumeSpy.mockClear();
  crypto.getSecret.mockImplementation(async (key: string) => {
    if (key === 'lock.enabled') throw new Error('keychain sealed');
    return crypto.__keychain.get(key) ?? null;
  });
  await transition('background');
  await transition('active');
  await ReactTestRenderer.act(flush);

  expect(currentRoute()).toBe('locked');
  expect(
    tree.root.findAllByProps({ testID: 'lock-screen' }).length,
  ).toBeGreaterThan(0);
  // The relock quiesced the transport, and nothing dialed it back up.
  expect(stopSpy).toHaveBeenCalled();
  expect(resumeSpy).not.toHaveBeenCalled();
});

test('a foreground lock.status() rejection invalidates the cold-boot healing opening', async () => {
  const healingStartReached = deferred<void>();
  const releaseHealingStart = deferred<void>();
  let enabledReads = 0;
  let healingStartParked = false;
  crypto.__keychain.delete('authToken');
  crypto.__keychain.delete('lock.enabled');
  crypto.getSecret.mockImplementation(async (key: string) => {
    if (key === 'lock.enabled') {
      enabledReads += 1;
      if (enabledReads === 2) throw new Error('keychain sealed');
    }
    return crypto.__keychain.get(key) ?? null;
  });
  createOrRestoreAccountMock.mockImplementation(async () => {
    crypto.__keychain.set('authToken', 'healed-token');
    return PROFILE;
  });
  const realDb = sqlite.instances.get('tacendum.sqlite')!;
  const execute = realDb.execute;
  realDb.execute = jest.fn(async (...args: unknown[]) => {
    if (
      !healingStartParked &&
      String(args[0]).includes(
        'SELECT peerId FROM chats WHERE identityChangedAt IS NOT NULL',
      )
    ) {
      healingStartParked = true;
      healingStartReached.resolve();
      await releaseHealingStart.promise;
    }
    return execute(...args);
  });
  const stopSpy = jest.spyOn(messaging, 'stop');
  const resumeSpy = jest.spyOn(messaging, 'resume');

  const tree = await renderApp();
  await ReactTestRenderer.act(async () => {
    await healingStartReached.promise;
  });
  expect(currentRoute()).toBe('loading');
  expect(createOrRestoreAccountMock).toHaveBeenCalledTimes(1);

  stopSpy.mockClear();
  resumeSpy.mockClear();
  ws.__ws.calls.start.mockClear();
  await transition('background');
  await transition('active');

  await ReactTestRenderer.act(async () => {
    releaseHealingStart.resolve();
    await flush();
    await flush();
  });

  expect(currentRoute()).toBe('locked');
  expect(
    tree.root.findAllByProps({ testID: 'lock-screen' }).length,
  ).toBeGreaterThan(0);
  expect(stopSpy).toHaveBeenCalled();
  expect(resumeSpy).not.toHaveBeenCalled();
  // The stale start crossed the first relock and briefly revived the socket.
  // The coordinator owns that continuation, waits for it, then relocks once
  // more so the final transport state is down.
  expect(ws.__ws.calls.start).toHaveBeenCalledTimes(1);
  expect(ws.__ws.calls.running).toBe(false);
  expect(ws.__ws.calls.stop.mock.invocationCallOrder.at(-1)).toBeGreaterThan(
    ws.__ws.calls.start.mock.invocationCallOrder.at(-1)!,
  );
});

test('a foreground lock.status() rejection invalidates an opening still on the locked route', async () => {
  const openingRead = deferred<void>();
  const openingReadReached = deferred<void>();
  let enabledReads = 0;
  let readParked = false;
  crypto.getSecret.mockImplementation(async (key: string) => {
    if (key === 'lock.enabled') {
      enabledReads += 1;
      if (enabledReads === 2) throw new Error('keychain sealed');
    }
    if (key === 'tacendum.readReceipts' && !readParked) {
      readParked = true;
      openingReadReached.resolve();
      await openingRead.promise;
    }
    return crypto.__keychain.get(key) ?? null;
  });
  const stopSpy = jest.spyOn(messaging, 'stop');
  const resumeSpy = jest.spyOn(messaging, 'resume');

  const tree = await renderApp();
  expect(currentRoute()).toBe('locked');
  for (const key of ['1', '2', '3', '4', '5', '6']) {
    await press(tree, `pin-key-${key}`);
  }
  await press(tree, 'pin-submit');
  await ReactTestRenderer.act(async () => {
    await openingReadReached.promise;
  });
  expect(currentRoute()).toBe('locked');

  stopSpy.mockClear();
  resumeSpy.mockClear();
  ws.__ws.calls.start.mockClear();
  await transition('background');
  await transition('active');
  await ReactTestRenderer.act(async () => {
    openingRead.resolve();
    await flush();
    await flush();
  });

  expect(currentRoute()).toBe('locked');
  expect(
    tree.root.findAllByProps({ testID: 'lock-screen' }).length,
  ).toBeGreaterThan(0);
  expect(stopSpy).toHaveBeenCalled();
  expect(resumeSpy).not.toHaveBeenCalled();
  expect(ws.__ws.calls.start).not.toHaveBeenCalled();
});
