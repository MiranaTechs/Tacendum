/**
 * THE HANDLER THAT RESOLVES THE REASON, AGAINST THE REAL APP.
 *
 * `CallsScreen.refusal.test.tsx` mounts the screen with `onCall` mocked, so
 * it pins where the sentence LANDS and nothing about where it comes from.
 * The part that actually fixes the dead Call button lives in App.tsx —
 * `permission.reason ?? null` instead of `return;`, the `instanceof
 * CallRefusedError` narrowing, `CALL_REFUSAL_FOR[err.reason]`, and the
 * `return null` on a foreign throw — and dropping any of it back to a bare
 * `return null` would restore the exact silent redial this cluster exists to
 * fix while every other suite stayed green. So: the real App, the real
 * `ensurePermissions`, the real `placeCall` refusal, and the notice read off
 * the rendered tree.
 *
 * Harness: App.callsprofile.test.tsx (the ws mock, the finished-account
 * fixture, the dev route probe and the TabBar finder), plus two rows — one
 * finished call and the chat it names — so there is a redial to press.
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
import ReactTestRenderer from 'react-test-renderer';
import App from '../App';
import { resetCallingForTests } from '../src/call';
import { CALL_REFUSAL } from '../src/callRefusalCopy';
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
  hasIdentity: jest.Mock;
  identityPublicKey: jest.Mock;
};
const native = jest.requireMock('tacendum-call') as {
  requestPermissions: jest.Mock;
  createOffer: jest.Mock;
  reportOutgoingCall: jest.Mock;
};

const USER_ID = '01KYDBSSDJSPC9J0E5N2AWMJ5Y';
const PEER_ID = '01KX7A9QZ2000000000000000P';
const T0 = new Date('2026-07-25T12:00:00').getTime();

/** One finished audio call with Dawit, so the Calls tab has a row to redial. */
const CALL_ROW = {
  cid: '01CALLW0000000000000000001',
  peerId: PEER_ID,
  direction: 'out',
  kind: 'audio',
  state: 'ended',
  reason: 'hangup',
  startedAt: T0,
  connectedAt: T0 + 4_000,
  endedAt: T0 + 34_000,
  lastSeenAt: T0 + 34_000,
  missed: 0,
};

/**
 * Peers whose safety number has changed, as the `chats` table would hold
 * them — `messaging.start()` seeds its own Set from this at boot, so a case
 * that puts PEER_ID here is exercising the real identity-change path and not
 * a stub over it.
 */
let identityChangedPeers: string[] = [];

/** A real workspace holding a finished account, one chat and one call. */
function seedRealWorkspaceWithACall(): void {
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
      if (s.includes('FROM call_log')) return { rows: [CALL_ROW] };
      // Narrow, not `includes('FROM chats')`: the chats table also answers
      // `SELECT peerId FROM chats WHERE identityChangedAt IS NOT NULL`, and a
      // broad match handed messaging.start() this row as a changed identity —
      // which made every call in this file refuse for the wrong reason.
      if (s.includes('FROM chats WHERE identityChangedAt IS NOT NULL')) {
        return { rows: identityChangedPeers.map(peerId => ({ peerId })) };
      }
      if (s.includes('FROM chats ORDER BY')) {
        return {
          rows: [
            {
              peerId: PEER_ID,
              displayName: 'Dawit',
              localName: null,
              avatarB64: null,
              lastMessageAt: T0,
              createdAt: T0,
              pinnedAt: null,
            },
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

async function renderApp(): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<App />);
  });
  await ReactTestRenderer.act(async () => {});
  mounted.push(tree);
  return tree;
}

function currentRoute(): string {
  return (globalThis as Record<string, unknown>).TacendumDevRoute as string;
}

function renderedTabBar(
  tree: ReactTestRenderer.ReactTestRenderer,
): ReactTestRenderer.ReactTestInstance {
  return tree.root.find(
    node =>
      (node.props.active === 'chats' || node.props.active === 'calls') &&
      typeof node.props.onSelect === 'function',
  );
}

/** Open the Calls tab and press the one row's redial disc. */
async function pressRedial(tree: ReactTestRenderer.ReactTestRenderer) {
  await ReactTestRenderer.act(async () => {
    renderedTabBar(tree).props.onSelect('calls');
  });
  await ReactTestRenderer.act(async () => {});
  expect(currentRoute()).toBe('calls');

  const redial = tree.root.find(
    n =>
      typeof n.type !== 'string' &&
      n.props.accessibilityLabel === 'Audio call Dawit' &&
      typeof n.props.onPress === 'function',
  );
  await ReactTestRenderer.act(async () => {
    redial.props.onPress();
  });
  await ReactTestRenderer.act(async () => {});
}

/** What the in-layout notice under the header says, or null if there is none. */
function noticeText(tree: ReactTestRenderer.ReactTestRenderer): string | null {
  const box = tree.root.findAll(
    n => typeof n.type === 'string' && n.props.testID === 'calls-refusal',
  )[0];
  if (!box) return null;
  return box
    .findAll(n => String(n.type) === 'Text')
    .map(n => [n.props.children].flat().join(''))
    .join('');
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
  identityChangedPeers = [];
  sqlite.reset();
  seedRealWorkspaceWithACall();
  fetchMock.mockClear();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  native.requestPermissions.mockClear();
  native.createOffer.mockClear();
});

afterEach(async () => {
  await ReactTestRenderer.act(async () => {
    while (mounted.length) mounted.pop()!.unmount();
  });
  jest.restoreAllMocks();
  crypto.hasIdentity.mockResolvedValue(false);
  crypto.identityPublicKey.mockResolvedValue(null);
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

test('a denied microphone reaches the screen instead of dying in the handler', async () => {
  // THE FINDING the whole cluster is named for: `if (!permission.ok) return;`
  // threw the written sentence away, so the redial rang nothing and said
  // nothing. This drives the REAL ensurePermissions through the native
  // permission mock — nothing about the refusal is stubbed above it.
  native.requestPermissions.mockResolvedValueOnce({ camera: 'denied', mic: 'denied' });
  const tree = await renderApp();
  await pressRedial(tree);

  expect(native.requestPermissions).toHaveBeenCalledTimes(1);
  expect(noticeText(tree)).toBe(CALL_REFUSAL.micDenied);
  // And the call genuinely did not happen: no offer, so no camera, no
  // microphone and no CallKit call behind the sentence.
  expect(native.createOffer).not.toHaveBeenCalled();
});

test("a blocked peer's redial says so, rather than staying dead", async () => {
  // The other arm: `placeCall` throws `CallRefusedError` before its first
  // effect, and the handler maps the CLASS to a sentence. The Error's own
  // message ('peer is blocked') is written for a log and is never what is
  // rendered — the assertion below would catch it being passed through.
  jest.spyOn(messaging, 'isBlockedLocally').mockReturnValue(true);
  const tree = await renderApp();
  await pressRedial(tree);

  expect(noticeText(tree)).toBe(CALL_REFUSAL.blocked);
  expect(noticeText(tree)).not.toBe('peer is blocked');
  expect(native.createOffer).not.toHaveBeenCalled();
});

test('a changed safety number is named, and points at the profile', async () => {
  // Seeded on disk and read by messaging.start(), not stubbed: this is the
  // arm that sends somebody somewhere, and it must not be the arm that says
  // 'peer is blocked' by accident.
  identityChangedPeers = [PEER_ID];
  const tree = await renderApp();
  await pressRedial(tree);

  expect(noticeText(tree)).toBe(CALL_REFUSAL.identityChanged);
  expect(native.createOffer).not.toHaveBeenCalled();
});

test('a call that is allowed to happen says nothing at all', async () => {
  // The falsifier for all three cases above: a handler that always resolved
  // a sentence would pass them and fail here.
  const tree = await renderApp();
  await pressRedial(tree);

  expect(native.requestPermissions).toHaveBeenCalledTimes(1);
  expect(noticeText(tree)).toBeNull();
  // …and it is silent because the call HAPPENED, not because the handler
  // swallowed something: the offer is the first effect past the refusal
  // gate. (The `sendEnvelope failed: ServerAheadError` warning below it is
  // this harness's stubbed socket, and is what proves the dispatch ran.)
  expect(native.createOffer).toHaveBeenCalled();
});
