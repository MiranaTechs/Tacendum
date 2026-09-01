/**
 * The boot-gating verify: boot gating. With the lock enabled, boot stops
 * at the lock screen before ANY workspace opens; the reversed code opens the
 * decoy world and never touches the real file, crypto, or the wire.
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
import ReactTestRenderer from 'react-test-renderer';
import App from '../App';
import { resetCallingForTests } from '../src/call';
import * as db from '../src/db';
import { messaging } from '../src/messaging';
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
  encryptText: jest.Mock;
};
const ws = (
  jest.requireMock('../src/ws') as {
    __ws: { calls: { start: jest.Mock } };
  }
).__ws;

/** Every rendered tree is tracked so afterEach can unmount it. */
const mounted: ReactTestRenderer.ReactTestRenderer[] = [];

/** The wire. This file asserted on the socket and on crypto but never on
 * REST, which is how `PUT /v1/push-token` went out of a coerced session for
 * as long as it did: the db latch hid the workspace half of that boot leak
 * and nothing at all was watching the network half. */
const realFetch = globalThis.fetch;
const fetchMock = jest.fn(async () => ({
  ok: true,
  status: 200,
  json: async () => ({}),
  text: async () => '',
}));
afterAll(() => {
  globalThis.fetch = realFetch;
});

async function renderApp(): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<App />);
  });
  mounted.push(tree);
  return tree;
}

// The landing cursor loops forever and the boot effect resolves
// asynchronously. A tree left mounted keeps ticking past the end of the test
// and touches a torn-down environment, failing the run even though every
// assertion passed.
afterEach(async () => {
  await ReactTestRenderer.act(async () => {
    while (mounted.length) mounted.pop()!.unmount();
    (crypto as unknown as { hasIdentity: jest.Mock }).hasIdentity.mockResolvedValue(false);
});
});

async function press(
  tree: ReactTestRenderer.ReactTestRenderer,
  testID: string,
): Promise<void> {
  await ReactTestRenderer.act(async () => {
    tree.root.findByProps({ testID }).props.onPress();
  });
}

beforeEach(async () => {
  messaging.stop();
  // EVERY CASE IN THIS FILE IS A LAUNCH, so the call module's process-lifetime
  // state has to be a launched process's. It holds three latches that outlive
  // a component — the push-registration verdict, this device's account id, and
  // the coordinator — and one boot leaving them set is one boot deciding what
  // the next boot is allowed to do. The duress case is the one that showed it:
  // it ran after a real boot, inherited that boot's `real` verdict, and
  // registered the owner's push token out of a coerced session while the file
  // was, on paper, testing that it could not.
  resetCallingForTests();
  // THIS LINE USED TO BE A MASK, AND IS NOT ANY MORE — the difference is in
  // src/db.ts, not here. `close()` latches the db module shut, and while it is
  // latched every db call on the boot path throws into its own
  // `.catch(() => undefined)`. `closedLatch` used to initialize to FALSE, so
  // a launched process was never in this state: on a real cold start the boot
  // path lazily opened `tacendum.sqlite` and wrote to it three times before
  // any verdict, and on the duress arm it opened the real file BEFORE the
  // decoy — while `expect(sqlite.opened).toHaveLength(0)` below passed,
  // proving only that the setup had closed the door. The latch now
  // initializes to TRUE, so a cold process and a relocked one are the same
  // state and this line reproduces it faithfully instead of inventing it.
  //
  // The independent check is App.coldstart.lock.test.tsx, which asserts the
  // same invariants from a fresh module registry and therefore never touches
  // `close()` at all. If that file ever goes red, do not trust this one.
  await db.close();
  db.setWorkspace('real');
  session.setMode('real');
  crypto.__keychain.clear();
  // These suites model devices with REAL accounts (or decoys behind them);
  // the boot guard that routes profile-without-identity to the landing screen
  // must not fire on a fixture that simply never mentioned its keys. The
  // global default is false, which reads as "identity lost".
  (crypto as unknown as { hasIdentity: jest.Mock }).hasIdentity.mockResolvedValue(true);
  sqlite.reset();
  ws.calls.start.mockClear();
  fetchMock.mockClear();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

test('without a lock, boot never shows the lock screen', async () => {
  const tree = await renderApp();
  expect(tree.root.findAllByProps({ testID: 'lock-screen' })).toHaveLength(0);
});

test('with the lock enabled, boot stops at the lock screen with no workspace open', async () => {
  crypto.__keychain.set('lock.enabled', '1');
  crypto.__keychain.set('lock.passcode', '123456');
  const tree = await renderApp();
  expect(
    tree.root.findAllByProps({ testID: 'lock-screen' }).length,
  ).toBeGreaterThan(0);
  expect(sqlite.opened).toHaveLength(0);
});

test('the reversed code opens the decoy world and never the real one', async () => {
  crypto.__keychain.set('lock.enabled', '1');
  crypto.__keychain.set('lock.passcode', '123456');
  // A device with a real account behind the lock: the bearer the push
  // registration would spend exists, so a leak would actually be sendable.
  crypto.__keychain.set('authToken', 'real-owner-token');
  // Seed a decoy profile so the decoy boot lands on the chat list.
  const decoyProfile = [
    { key: 'userId', value: 'ME-ULID' },
    { key: 'registrationId', value: '7' },
    { key: 'displayName', value: 'Me' },
    { key: 'about', value: '' },
    { key: 'avatarB64', value: '' },
    { key: 'profileVersion', value: '1' },
  ];
  sqlite.instances.set('tacendum-decoy.sqlite', {
    name: 'tacendum-decoy.sqlite',
    execute: jest.fn(async (sql: string) => {
      const s = String(sql);
      if (s.includes('FROM profile')) return { rows: decoyProfile };
      if (s.includes('PRAGMA table_info(attachments')) {
        return { rows: [{ name: 'direction' }] };
      }
      if (s.includes('PRAGMA table_info(reactions')) {
        // BOTH columns the rebuild loop checks. An answer missing one reads as
        // 'old shape on disk', so initSchema drops the table and re-enters
        // itself forever — a 4 GB heap death, not a red test, which is why a
        // stale mock here is so expensive to diagnose.
        return { rows: [{ name: 'targetDirection' }, { name: 'reactorId' }] };
      }
      if (s.includes('PRAGMA table_info(pending_revisions')) {
        return { rows: [{ name: 'writerId' }] };
      }
      return { rows: [] };
    }),
    close: jest.fn(),
  });

  const tree = await renderApp();
  for (const key of ['6', '5', '4', '3', '2', '1']) {
    await press(tree, `pin-key-${key}`);
  }
  await press(tree, 'pin-submit');

  expect(tree.root.findAllByProps({ testID: 'lock-screen' })).toHaveLength(0);
  expect(sqlite.opened).toContain('tacendum-decoy.sqlite');
  expect(sqlite.opened).not.toContain('tacendum.sqlite');
  expect(ws.calls.start).not.toHaveBeenCalled();
  expect(crypto.encryptText).not.toHaveBeenCalled();
  // Rule 15 in full: "no socket, no REST call, no push registration". The
  // first two were checked here for a long time; the third was not, and it was
  // the one that fired — from the boot path, before this code was even typed,
  // so `api.ts`'s duress guard never got a chance to refuse it.
  expect(fetchMock).not.toHaveBeenCalled();
  expect(session.mode).toBe('duress');
});

test('a transient unlock failure never wipes the real workspace', async () => {
  // The old catch-all wiped ALL local state on ANY boot error. With a lock
  // in front, a transient failure (here: the socket refuses once) must leave
  // every byte and every lock key intact and fall back to the lock screen.
  crypto.__keychain.set('lock.enabled', '1');
  crypto.__keychain.set('lock.passcode', '123456');
  crypto.__keychain.set('authToken', 'tok');
  const profileRows = [
    { key: 'userId', value: 'ME-REAL' },
    { key: 'registrationId', value: '7' },
  ];
  sqlite.instances.set('tacendum.sqlite', {
    name: 'tacendum.sqlite',
    execute: jest.fn(async (sql: string) => {
      const s = String(sql);
      if (s.includes('FROM profile')) return { rows: profileRows };
      if (s.includes('PRAGMA table_info(attachments'))
        return { rows: [{ name: 'direction' }] };
      // BOTH columns the rebuild loop checks, and pending_revisions too. An
      // answer missing one reads as 'old shape on disk', so initSchema drops
      // the table and re-enters itself forever — a 4 GB heap death rather
      // than a red test, which is what makes a stale mock here so expensive
      // to find. This file carries TWO connection mocks; the second one is
      // easy to miss precisely because it is written without braces.
      if (s.includes('PRAGMA table_info(reactions'))
        return { rows: [{ name: 'targetDirection' }, { name: 'reactorId' }] };
      if (s.includes('PRAGMA table_info(pending_revisions'))
        return { rows: [{ name: 'writerId' }] };
      return { rows: [] };
    }),
    close: jest.fn(),
  });
  ws.calls.start.mockImplementationOnce(() => {
    throw new Error('transient socket refusal');
  });

  const tree = await renderApp();
  for (const key of ['1', '2', '3', '4', '5', '6']) {
    await press(tree, `pin-key-${key}`);
  }
  await press(tree, 'pin-submit');

  const real = sqlite.instances.get('tacendum.sqlite')!;
  // UNBOUNDED deletes, which is what a wipe is: `clearLocalState` issues
  // `DELETE FROM <table>` with no WHERE, once per table. The bounded ones are
  // a different thing entirely — `adoptWorkspaceForCalling` prunes expired
  // call offers and stale call-session rows by TTL on every real unlock, as
  // the boot path always did, and counting those as "wiped" would make this
  // test fail on ordinary housekeeping. The distinction is the WHERE clause,
  // so that is what is matched on rather than the verb.
  const wipes = real.execute.mock.calls
    .map(c => String(c[0]))
    .filter(s => s.startsWith('DELETE FROM') && !/\bWHERE\b/i.test(s));
  expect(wipes).toEqual([]);
  expect(crypto.__keychain.get('lock.enabled')).toBe('1');
  expect(crypto.__keychain.get('lock.passcode')).toBe('123456');
  expect(
    tree.root.findAllByProps({ testID: 'lock-screen' }).length,
  ).toBeGreaterThan(0);
});

test('a reinstall with orphaned Keychain lock keys boots unlocked and clears them', async () => {
  // The Keychain outlives an app uninstall; the SQLite data it guarded does
  // not. First boot after a reinstall must clear the stale lock rather than
  // demand a code that protects nothing.
  const install = jest.requireMock('../src/install') as {
    __install: { firstRun: boolean };
  };
  install.__install.firstRun = true;
  crypto.__keychain.set('lock.enabled', '1');
  crypto.__keychain.set('lock.passcode', '123456');

  const tree = await renderApp();

  expect(tree.root.findAllByProps({ testID: 'lock-screen' })).toHaveLength(0);
  expect(crypto.__keychain.has('lock.enabled')).toBe(false);
  expect(crypto.__keychain.has('lock.passcode')).toBe(false);
});

test('the real code opens the real workspace', async () => {
  crypto.__keychain.set('lock.enabled', '1');
  crypto.__keychain.set('lock.passcode', '123456');
  const tree = await renderApp();
  for (const key of ['1', '2', '3', '4', '5', '6']) {
    await press(tree, `pin-key-${key}`);
  }
  await press(tree, 'pin-submit');

  expect(tree.root.findAllByProps({ testID: 'lock-screen' })).toHaveLength(0);
  expect(sqlite.opened).toContain('tacendum.sqlite');
  expect(sqlite.opened).not.toContain('tacendum-decoy.sqlite');
  expect(session.mode).toBe('real');
});
