/**
 * Back from a ROOM MEMBER's profile returns to the room. GroupProfile's
 * onOpenMember pushed `peerProfile` with only the member's id, and
 * backDestination('peerProfile') always popped to `thread:<peerId>` — so
 * Back from the profile of a member you had never messaged opened a
 * stranger's empty 1:1 thread, and the room left the path. The route now
 * carries `via` (the room it was opened from) and pops back to it; a
 * profile opened from a thread itself still pops to that thread, exactly as
 * before.
 *
 * Harness: back.android.test.ts (the ws mock, the finished-account fixture,
 * the dev route probe and the same finders), minus its Android platform
 * mock — this is the visible Back control, which is platform-blind; the
 * hardware press is pinned over there. */

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

const USER_ID = '01KYDBSSDJSPC9J0E5N2AWMJ5Y';
/** A member of the room — someone this phone has never messaged 1:1. */
const MEMBER = '01KYDBSSDJSPC9J0E5N2AWMJ60';

/** A real workspace holding a finished account (App.reauth's fixture). */
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

async function renderApp(): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<App />);
  });
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

function renderedCalls(
  tree: ReactTestRenderer.ReactTestRenderer,
): ReactTestRenderer.ReactTestInstance {
  return tree.root.find(
    node =>
      typeof node.props.onOpenChat === 'function' &&
      typeof node.props.onCall === 'function',
  );
}

function renderedThread(
  tree: ReactTestRenderer.ReactTestRenderer,
): ReactTestRenderer.ReactTestInstance {
  return tree.root.find(
    node =>
      typeof node.props.onOpenPeerProfile === 'function' &&
      typeof node.props.onOpenGroupProfile === 'function',
  );
}

function renderedPeerProfile(
  tree: ReactTestRenderer.ReactTestRenderer,
): ReactTestRenderer.ReactTestInstance {
  return tree.root.find(
    node =>
      typeof node.props.peerId === 'string' &&
      node.props.me !== undefined &&
      typeof node.props.onBack === 'function',
  );
}

function renderedGroupProfile(
  tree: ReactTestRenderer.ReactTestRenderer,
): ReactTestRenderer.ReactTestInstance {
  return tree.root.find(
    node =>
      typeof node.props.groupId === 'string' &&
      typeof node.props.onOpenMember === 'function' &&
      typeof node.props.onBack === 'function',
  );
}

async function openCallsThread(
  tree: ReactTestRenderer.ReactTestRenderer,
  peerId: string = USER_ID,
): Promise<void> {
  if (currentRoute() !== 'calls') {
    await ReactTestRenderer.act(async () => {
      renderedTabBar(tree).props.onSelect('calls');
    });
  }
  await ReactTestRenderer.act(async () => {
    renderedCalls(tree).props.onOpenChat(peerId);
  });
  expect(currentRoute()).toBe('thread');
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
  crypto.hasIdentity.mockResolvedValue(false);
  crypto.identityPublicKey.mockResolvedValue(null);
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

test("Back from a room member's profile returns to the ROOM, then its thread, then Calls — never into a 1:1 with the member", async () => {
  const tree = await renderApp();

  await openCallsThread(tree);
  await ReactTestRenderer.act(async () => {
    renderedThread(tree).props.onOpenGroupProfile();
  });
  expect(currentRoute()).toBe('groupProfile');

  await ReactTestRenderer.act(async () => {
    renderedGroupProfile(tree).props.onOpenMember(MEMBER);
  });
  expect(currentRoute()).toBe('peerProfile');
  expect(renderedPeerProfile(tree).props.peerId).toBe(MEMBER);

  // THE FINDING: Back lands on the same room's profile, not on thread:<MEMBER>.
  await ReactTestRenderer.act(async () => {
    renderedPeerProfile(tree).props.onBack();
  });
  expect(currentRoute()).toBe('groupProfile');
  expect(renderedGroupProfile(tree).props.groupId).toBe(USER_ID);

  // And the rest of the path is the room's own: its thread, then Calls,
  // the origin the thread was opened from.
  await ReactTestRenderer.act(async () => {
    renderedGroupProfile(tree).props.onBack();
  });
  expect(currentRoute()).toBe('thread');
  expect(renderedThread(tree).props.peerId).toBe(USER_ID);

  await ReactTestRenderer.act(async () => {
    renderedThread(tree).props.onBack();
  });
  expect(currentRoute()).toBe('calls');
});

test('a profile opened from the thread itself still pops to that thread (no room in the path)', async () => {
  const tree = await renderApp();

  await openCallsThread(tree);
  await ReactTestRenderer.act(async () => {
    renderedThread(tree).props.onOpenPeerProfile();
  });
  expect(currentRoute()).toBe('peerProfile');
  expect(renderedPeerProfile(tree).props.peerId).toBe(USER_ID);

  await ReactTestRenderer.act(async () => {
    renderedPeerProfile(tree).props.onBack();
  });
  expect(currentRoute()).toBe('thread');
  expect(renderedThread(tree).props.peerId).toBe(USER_ID);

  await ReactTestRenderer.act(async () => {
    renderedThread(tree).props.onBack();
  });
  expect(currentRoute()).toBe('calls');
});
