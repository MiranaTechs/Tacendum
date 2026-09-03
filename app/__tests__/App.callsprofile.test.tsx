/**
 * The Calls tab's profile door, against the real App. `CallsScreen` gained
 * `profile` / `onOpenProfile` and the shared `HomeHeader` renders its door
 * only when both are given — and the App's one `<CallsScreen>` passed
 * neither, so the door the screen's own unit test proves never rendered in
 * the shipped app: Profile and Settings stayed unreachable from the Calls
 * tab. This pins the wiring, not the screen.
 *
 * Harness: back.groupmember.test.tsx (the ws mock, the finished-account
 * fixture, the dev route probe and the TabBar finder). */

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

function profileDoors(
  tree: ReactTestRenderer.ReactTestRenderer,
): ReactTestRenderer.ReactTestInstance[] {
  return tree.root.findAll(
    node =>
      node.props.testID === 'home-profile-door' &&
      typeof node.props.onPress === 'function',
  );
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

test('the Calls tab renders the profile door, and it opens the profile', async () => {
  const tree = await renderApp();
  expect(currentRoute()).toBe('chats');
  // The control: the Chats tab's door, which always shipped.
  expect(profileDoors(tree)).toHaveLength(1);

  await ReactTestRenderer.act(async () => {
    renderedTabBar(tree).props.onSelect('calls');
  });
  expect(currentRoute()).toBe('calls');

  // THE FINDING: the App's one <CallsScreen> passed no profile and no
  // handler, so nothing rendered here.
  const doors = profileDoors(tree);
  expect(doors).toHaveLength(1);
  expect(doors[0]!.props.accessibilityLabel).toBe('Open your profile');

  await ReactTestRenderer.act(async () => {
    doors[0]!.props.onPress();
  });
  expect(currentRoute()).toBe('profile');
});
