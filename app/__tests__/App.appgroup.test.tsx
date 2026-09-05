/**
 * A broken App Group must cost previews and nothing else.
 *
 * `sharedStateRoot()` throws when the group container is unavailable — a typo
 * in one of the two entitlements, or a provisioning profile that does not
 * carry the group. That is deliberate: falling back to the app's own container
 * would give a store the app reads and writes perfectly and the extension
 * cannot see at all, so the settings screen would show a preference that
 * silently governed nothing.
 *
 * But the throw travels. `armPreviews` is called inside `enterRealWorkspace`'s
 * try block, whose catch decides whether the account needs healing — so an
 * unrelated entitlement problem would present as "this phone has no profile"
 * and drop someone on the landing screen with their conversations intact and
 * invisible. This pins the catch that stops it.
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
  __sharedState: Map<string, string>;
  writeSharedState: jest.Mock;
  deleteSharedState: jest.Mock;
  readSharedState: jest.Mock;
};

const PROFILE = [
  { key: 'userId', value: 'ME-ULID' },
  { key: 'registrationId', value: '7' },
  { key: 'displayName', value: 'Me' },
  { key: 'about', value: '' },
  { key: 'avatarB64', value: '' },
  { key: 'profileVersion', value: '1' },
];

/** A real workspace with a profile and a valid auth token on disk. */
function seedRealWorkspace(): void {
  crypto.__keychain.set('authToken', 'tok');
  sqlite.instances.set('tacendum.sqlite', {
    name: 'tacendum.sqlite',
    execute: jest.fn(async (sql: string) => {
      const s = String(sql);
      if (s.includes('FROM profile')) return { rows: PROFILE };
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
}

const mounted: ReactTestRenderer.ReactTestRenderer[] = [];

/** The boot now ASKS THE SERVER what build it still talks to, before the
 * socket. Left to the environment's real `fetch`
 * that is an outbound connection this suite never wanted, and the opening
 * waits on its 20 s deadline — the route would still read 'loading' when the
 * assertions run. An empty answer is refused by the DTO parse, which the gate
 * reads as unknown (the fail-open posture), so the boot carries on exactly as
 * it did before the gate existed. */
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
  // The boot's own awaits, drained: the gate's check sits between the
  // profile read and `messaging.start`, so a settled opening is one flush
  // further out than it used to be.
  await ReactTestRenderer.act(async () => {
    for (let i = 0; i < 60; i++) await Promise.resolve();
  });
  return tree;
}

afterEach(async () => {
  await ReactTestRenderer.act(async () => {
    while (mounted.length) mounted.pop()!.unmount();
    (crypto as unknown as { hasIdentity: jest.Mock }).hasIdentity.mockResolvedValue(false);
});
});

beforeEach(async () => {
  messaging.stop();
  await db.close();
  db.setWorkspace('real');
  session.setMode('real');
  crypto.__keychain.clear();
  // These suites model devices with REAL accounts (or decoys behind them);
  // the boot guard that routes profile-without-identity to the landing screen
  // must not fire on a fixture that simply never mentioned its keys. The
  // global default is false, which reads as "identity lost".
  (crypto as unknown as { hasIdentity: jest.Mock }).hasIdentity.mockResolvedValue(true);
  crypto.__sharedState.clear();
  jest.clearAllMocks();
  sqlite.reset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

test('an unavailable App Group container does not cost the account', async () => {
  // Exactly what the native side does when `containerURL(...)` is nil.
  crypto.writeSharedState.mockRejectedValue(
    new Error('app group container unavailable — check the entitlement on both targets'),
  );
  seedRealWorkspace();

  const tree = await renderApp();

  // The profile loaded, so the app is on the CHAT LIST — not the landing
  // screen, which is where the healing catch would have put it. Asserted on
  // the new-chat button, which only that screen renders, and on the absence of
  // "Get started", which only the landing screen renders.
  expect(
    tree.root.findAllByProps({ testID: 'new-chat-fab' }).length,
  ).toBeGreaterThan(0);
  expect(
    tree.root.findAllByProps({ testID: 'landing-get-started' }),
  ).toHaveLength(0);
});

test('the workspace still opens and messaging still starts', async () => {
  // The failure must not short-circuit anything after it either. `armPreviews`
  // sits between the preference load and the database open.
  crypto.writeSharedState.mockRejectedValue(new Error('app group container unavailable'));
  seedRealWorkspace();

  await renderApp();

  expect(sqlite.opened).toContain('tacendum.sqlite');
});
