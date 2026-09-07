/**
 * A link offer that lands OFF a home surface is shown at the next natural
 * moment.
 *
 * The notice-time hop to the confirm surface fires only when chats/calls is
 * on glass at that instant; an offer that arrived mid-thread, in Settings or
 * on Profile sat in the durable `link_pending_offer` row, unread, until its
 * ten minutes ran out. App.tsx now re-reads the row (through the
 * `pendingOfferWaiting` probe — no fetch, no pin, no signature check) when a
 * home surface next comes on glass, and hops if an offer is still live.
 *
 * ONE-SHOT, by design and pinned here: the confirm surface's chevron and its
 * Close controls (not-pristine, class-mismatch, no-code, failed) leave the
 * row in place, so a re-read on every return to chats would re-open the
 * surface until the offer expired — a ten-minute trap. The hop is armed by
 * boot (a row may predate the process) and by each landing notice, and is
 * spent by the hop that serves it or by a probe that finds nothing.
 *
 * Harness: App.foreground.failclosed.test.tsx (ws mock, the finished-account
 * fixture, the dev route probe), with the linking module's two doors spied:
 * `onPendingOffer` so the test can be the landing notice, and
 * `pendingOfferWaiting` so it can be the durable row. */

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
  hasPendingAccountDeletion: jest.fn(async () => false),
  clearStaleInstallationCredentials: jest.fn(async () => undefined),
  createOrRestoreAccount: jest.fn(),
}));

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import App from '../App';
import { resetCallingForTests } from '../src/call';
import * as db from '../src/db';
import * as linking from '../src/linking';
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
  hasIdentity: jest.Mock;
  identityPublicKey: jest.Mock;
};

const USER_ID = '01KYDBSSDJSPC9J0E5N2AWMJ5Y';
const PEER = '01HQBBBB00000000000000000A';

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
/** Every pending-offer listener App registered, so the test can be the notice. */
let offerListeners: Array<() => void> = [];
let waiting: jest.SpyInstance<
  Promise<boolean>,
  Parameters<typeof linking.pendingOfferWaiting>
>;

async function flush(): Promise<void> {
  for (let i = 0; i < 60; i++) await Promise.resolve();
}

async function renderApp(): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<App />);
  });
  mounted.push(tree);
  await ReactTestRenderer.act(flush);
  return tree;
}

function currentRoute(): string {
  return (globalThis as Record<string, unknown>).TacendumDevRoute as string;
}

async function go(route: unknown): Promise<void> {
  const devNav = (globalThis as Record<string, unknown>).TacendumDevNav as (
    r: unknown,
  ) => void;
  await ReactTestRenderer.act(async () => {
    devNav(route);
    await flush();
  });
}

/** The landing notice: linking's own `notify(pendingOfferListeners)`. */
async function offerLands(): Promise<void> {
  await ReactTestRenderer.act(async () => {
    for (const listener of [...offerListeners]) listener();
    await flush();
  });
}

const has = (
  tree: ReactTestRenderer.ReactTestRenderer,
  testID: string,
): boolean => tree.root.findAllByProps({ testID }).length > 0;

async function press(
  tree: ReactTestRenderer.ReactTestRenderer,
  testID: string,
): Promise<void> {
  const node = tree.root
    .findAllByProps({ testID })
    .find(n => typeof n.props.onPress === 'function')!;
  await ReactTestRenderer.act(async () => {
    node.props.onPress();
    await flush();
  });
}

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
  crypto.__keychain.clear();
  crypto.__keychain.set('authToken', 'token-for-this-test');
  crypto.hasIdentity.mockResolvedValue(true);
  crypto.identityPublicKey.mockResolvedValue('BQ0IDENTITYKEYBASE64');
  sqlite.reset();
  seedRealWorkspaceWithProfile();
  fetchMock.mockClear();
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  offerListeners = [];
  jest.spyOn(linking, 'onPendingOffer').mockImplementation(listener => {
    offerListeners.push(listener);
    return () => {
      offerListeners = offerListeners.filter(l => l !== listener);
    };
  });
  // Nothing durable is waiting unless a test says so.
  waiting = jest.spyOn(linking, 'pendingOfferWaiting').mockResolvedValue(false);
});

afterEach(async () => {
  await ReactTestRenderer.act(async () => {
    while (mounted.length) mounted.pop()!.unmount();
  });
  jest.restoreAllMocks();
  crypto.hasIdentity.mockResolvedValue(false);
  crypto.identityPublicKey.mockResolvedValue(null);
  await db.close();
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

test('an offer that lands mid-thread is shown when chats next comes on glass — never stolen from under a hand', async () => {
  const tree = await renderApp();
  expect(currentRoute()).toBe('chats');

  await go({ name: 'thread', peerId: PEER });
  expect(currentRoute()).toBe('thread');

  // The notice lands while the thread is open: the durable row now holds a
  // live offer, and the hand on the thread is left alone.
  waiting.mockResolvedValue(true);
  await offerLands();
  expect(currentRoute()).toBe('thread');

  // The next arrival at a home surface reads the row and hops.
  await go({ name: 'chats' });
  expect(currentRoute()).toBe('linkConfirm');
  expect(has(tree, 'link-confirm-back')).toBe(true);
});

test('with nothing waiting, the arrival at chats stays on chats', async () => {
  await renderApp();
  await go({ name: 'thread', peerId: PEER });
  await offerLands();
  await go({ name: 'chats' });
  expect(currentRoute()).toBe('chats');
});

test('closing the confirm surface does NOT re-open it: the hop is one per offer, not one per return to chats', async () => {
  const tree = await renderApp();
  await go({ name: 'thread', peerId: PEER });
  waiting.mockResolvedValue(true);
  await offerLands();
  await go({ name: 'chats' });
  expect(currentRoute()).toBe('linkConfirm');

  // The chevron leaves the row in place (only decline/accept consume it) —
  // and the row still answers "waiting" — yet Back lands on chats and STAYS.
  const probesBefore = waiting.mock.calls.length;
  await press(tree, 'link-confirm-back');
  expect(currentRoute()).toBe('chats');
  await ReactTestRenderer.act(flush);
  expect(currentRoute()).toBe('chats');
  expect(waiting.mock.calls.length).toBe(probesBefore);

  // A NEW notice re-arms it, as it always did on a home surface.
  await offerLands();
  expect(currentRoute()).toBe('linkConfirm');
});

test('a notice landing ON a home surface still hops at once, and the way back is not a loop', async () => {
  const tree = await renderApp();
  waiting.mockResolvedValue(true);
  await offerLands();
  expect(currentRoute()).toBe('linkConfirm');

  await press(tree, 'link-confirm-back');
  await ReactTestRenderer.act(flush);
  expect(currentRoute()).toBe('chats');
});
