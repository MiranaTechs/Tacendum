/**
 * A different conversation is a different thread INSTANCE.
 *
 * THE DEFECT THIS FILE EXISTS FOR. The router rendered `<ChatThreadScreen>`
 * un-keyed, so a thread→thread route change — the wide shell's list pane, a
 * foreground push-notification redemption — REUSED the mounted instance with
 * a new `peerId`. Its per-peer reset effect never covered the composer: A's
 * half-typed draft stayed in the input and the debounce then persisted it
 * under B; a reply chip captured in A would send `sendReply(B, A.msgId…)`;
 * a photo that failed to A would retry to B. Words meant for one person,
 * addressed to another.
 *
 * Pinned against the REAL App and its real router (back.android.test.ts's
 * harness), because the fix is the router's: `key={route.peerId}` on the
 * thread element, so React unmounts A's instance and mounts B's fresh. */

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
  hasIdentity: jest.Mock;
  identityPublicKey: jest.Mock;
};

/** REAL Crockford ULIDs — the shipped zod schemas validate every id. */
const USER_ID = '01KYDBSSDJSPC9J0E5N2AWMJ5Y';
const PEER_A = '01HQBBBB00000000000000000A';
const PEER_B = '01HQBBBB00000000000000000B';
const MSG_A = '01MSGFROMA00000000000000001';

const T0 = new Date('2026-09-02T12:00:00').getTime();

/** One inbound message in A's thread — the thing a reply would quote. */
const ROW_A = {
  msgId: MSG_A,
  peerId: PEER_A,
  direction: 'in',
  body: 'lunch tomorrow?',
  ts: T0,
  status: 'received',
  editedAt: null,
  deletedAt: null,
  expiresAt: null,
  authorId: null,
  sq: null,
  outsider: null,
  sharedBy: null,
  ai: null,
};

/** A real workspace holding a finished account, so the app lands on chats. */
function seedRealWorkspaceWithProfile(): void {
  const instance: FakeDb = {
    name: 'tacendum.sqlite',
    execute: jest.fn(async (sql: string, params?: unknown[]) => {
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
      // The thread's own list query, answered PER PEER: A has a message, B
      // has none — so anything from A showing up in B's thread is a leak,
      // never a coincidence of fixtures.
      if (s.includes('FROM messages') && s.includes('ORDER BY ts, msgId')) {
        return { rows: params?.[0] === PEER_A ? [ROW_A] : [] };
      }
      return { rows: [] };
    }),
    close: jest.fn(),
  };
  sqlite.instances.set('tacendum.sqlite', instance);
}

const mounted: ReactTestRenderer.ReactTestRenderer[] = [];

async function flush(): Promise<void> {
  for (let i = 0; i < 60; i++) await Promise.resolve();
}

async function renderApp(): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<App />);
  });
  mounted.push(tree);
  await ReactTestRenderer.act(async () => {
    await flush();
  });
  return tree;
}

type Nav = (route: { name: string; [key: string]: unknown }) => void;
const devNav = () =>
  (globalThis as unknown as Record<string, unknown>).TacendumDevNav as Nav;
const currentRoute = () =>
  (globalThis as unknown as Record<string, unknown>).TacendumDevRoute as string;

async function go(route: { name: string; [key: string]: unknown }) {
  await ReactTestRenderer.act(async () => {
    devNav()(route);
    await flush();
  });
}

/** The mounted thread, by the props only it carries. */
function renderedThread(
  tree: ReactTestRenderer.ReactTestRenderer,
): ReactTestRenderer.ReactTestInstance {
  return tree.root.find(
    node =>
      typeof node.props.onOpenPeerProfile === 'function' &&
      typeof node.props.onOpenGroupProfile === 'function',
  );
}

function composerInput(
  tree: ReactTestRenderer.ReactTestRenderer,
): ReactTestRenderer.ReactTestInstance {
  const node = tree.root
    .findAllByProps({ testID: 'composer-input' })
    .find(n => n.props.onChangeText);
  if (!node) throw new Error('no composer input on glass');
  return node;
}

async function press(
  tree: ReactTestRenderer.ReactTestRenderer,
  testID: string,
): Promise<void> {
  const node = tree.root.findAllByProps({ testID }).find(n => n.props.onPress);
  if (!node) throw new Error(`no pressable ${testID}`);
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

test('switching thread to thread mounts a fresh composer: no draft, no reply chip, nothing persisted under the new peer', async () => {
  const setDraft = jest.spyOn(db, 'setDraft');
  const tree = await renderApp();
  expect(currentRoute()).toBe('chats');

  await go({ name: 'thread', peerId: PEER_A });
  expect(currentRoute()).toBe('thread');
  expect(renderedThread(tree).props.peerId).toBe(PEER_A);

  // Half a sentence for A…
  await ReactTestRenderer.act(async () => {
    composerInput(tree).props.onChangeText('see you at noon');
    await flush();
  });
  expect(composerInput(tree).props.value).toBe('see you at noon');

  // …answering one of A's messages.
  const bubble = tree.root
    .findAllByProps({ testID: `msg-${MSG_A}` })
    .find(n => n.props.onLongPress);
  expect(bubble).toBeDefined();
  await ReactTestRenderer.act(async () => {
    bubble!.props.onLongPress();
    await flush();
  });
  await press(tree, `reply-${MSG_A}`);
  expect(tree.root.findAllByProps({ testID: 'composer-chip' }).length).toBeGreaterThan(0);

  // The route changes UNDER the mounted thread, exactly as the wide shell's
  // list pane and a foreground push redemption do.
  await go({ name: 'thread', peerId: PEER_B });
  expect(renderedThread(tree).props.peerId).toBe(PEER_B);

  // B's composer is empty and answering nothing.
  expect(composerInput(tree).props.value).toBe('');
  expect(tree.root.findAllByProps({ testID: 'composer-chip' })).toHaveLength(0);
  // And A's message is not on B's glass.
  expect(tree.root.findAllByProps({ testID: `msg-${MSG_A}` })).toHaveLength(0);

  // Past the draft debounce: A's words were saved for A on the way out, and
  // NEVER written under B.
  await ReactTestRenderer.act(async () => {
    await new Promise<void>(resolve => setTimeout(() => resolve(), 600));
    await flush();
  });
  const byPeer = setDraft.mock.calls.map(([peerId, text]) => [peerId, text]);
  expect(byPeer).toContainEqual([PEER_A, 'see you at noon']);
  expect(byPeer.filter(([peerId]) => peerId === PEER_B)).toEqual([]);
});
