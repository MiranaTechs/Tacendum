/**
 * The back-navigation detector, run BY PATH: Android's system back must pop the hand-rolled router through
 * `goBack()` — the same `backDestination` the chevron and the edge swipe
 * use — returning true when it navigated and false at a root, where the
 * system may background the app. Before this wiring existed, system back
 * backgrounded the app from EVERY screen.
 *
 * Deliberately `.ts` (no JSX — `React.createElement`), because tooling
 * invokes this file by its exact name and path.
 */

jest.mock('react-native/Libraries/Utilities/Platform', () => ({
  __esModule: true,
  default: {
    OS: 'android',
    select: (spec: Record<string, unknown>) =>
      'android' in spec
        ? spec.android
        : 'native' in spec
          ? spec.native
          : spec.default,
    get constants() {
      return {
        isTesting: true,
        isDisableAnimations: true,
        reactNativeVersion: { major: 0, minor: 86, patch: 0 },
      };
    },
    Version: 35,
    isTesting: true,
    isDisableAnimations: true,
    isTV: false,
    isVision: false,
  },
}));

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
import { BackHandler } from 'react-native';
import ReactTestRenderer from 'react-test-renderer';
import App from '../App';
import * as api from '../src/api';
import { callController, resetCallingForTests } from '../src/call';
import * as db from '../src/db';
import { messaging } from '../src/messaging';
import { session } from '../src/session';
import { CallOverlay } from '../src/screens/CallOverlay';
import { CallScreen } from '../src/screens/CallScreen';

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
    tree = ReactTestRenderer.create(React.createElement(App));
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

test('hardware back pops the router when it can and yields at a root', async () => {
  // Capture the registered handler: on Android the app must wire
  // hardwareBackPress to the router — an unwired handler fails HERE, not on
  // a device (the failure was silent: the app just backgrounded).
  const handlers: Array<() => boolean> = [];
  const addListener = jest
    .spyOn(BackHandler, 'addEventListener')
    .mockImplementation((event, handler) => {
      expect(event).toBe('hardwareBackPress');
      handlers.push(handler as () => boolean);
      return { remove: jest.fn() };
    });

  const tree = await renderApp();
  expect(addListener).toHaveBeenCalledWith(
    'hardwareBackPress',
    expect.any(Function),
  );
  const handler = handlers[handlers.length - 1];

  // Booted to the chat list — a ROOT (backDestination null): the handler
  // must answer false so the system backgrounds the app instead of the
  // press vanishing into a surface that cannot pop.
  expect(currentRoute()).toBe('chats');
  let atRoot!: boolean;
  await ReactTestRenderer.act(async () => {
    atRoot = handler();
  });
  expect(atRoot).toBe(false);
  expect(currentRoute()).toBe('chats');

  // Push one surface (the new-chat FAB), then the branch that must consume
  // the press: back NAVIGATES (newChat pops to chats) and answers true.
  await ReactTestRenderer.act(async () => {
    tree.root.findByProps({ testID: 'new-chat-fab' }).props.onPress();
  });
  expect(currentRoute()).toBe('newChat');

  let navigated!: boolean;
  await ReactTestRenderer.act(async () => {
    navigated = handler();
  });
  expect(navigated).toBe(true);
  expect(currentRoute()).toBe('chats');

  addListener.mockRestore();
});

test('every pushed surface answers hardware back the way its own visible control does', async () => {
  // The regression this caught: `backDestination` omitted register
  // and photoViewer (hardware back BACKGROUNDED the app from two pushed
  // surfaces) and hardcoded every thread to chats (a Calls-origin thread's
  // chevron goes to calls — back disagreed with the control on screen).
  // Routes are driven through the same dev hook the scripted Verify uses.
  const handlers: Array<() => boolean> = [];
  const addListener = jest
    .spyOn(BackHandler, 'addEventListener')
    .mockImplementation((_event, handler) => {
      handlers.push(handler as () => boolean);
      return { remove: jest.fn() };
    });

  const tree = await renderApp();
  const handler = handlers[handlers.length - 1];
  const devNav = (globalThis as Record<string, unknown>).TacendumDevNav as (
    r: unknown,
  ) => void;
  const back = async (): Promise<boolean> => {
    let consumed!: boolean;
    await ReactTestRenderer.act(async () => {
      consumed = handler();
    });
    return consumed;
  };
  const go = async (route: unknown): Promise<void> => {
    await ReactTestRenderer.act(async () => {
      devNav(route);
    });
  };

  // register pops to landing, exactly where its chevron goes.
  await go({ name: 'register' });
  expect(currentRoute()).toBe('register');
  expect(await back()).toBe(true);
  expect(currentRoute()).toBe('landing');

  // A thread opened from Chats pops to chats…
  await go({ name: 'thread', peerId: USER_ID });
  expect(await back()).toBe(true);
  expect(currentRoute()).toBe('chats');

  // …and a thread opened from Calls respects its origin: back to CALLS.
  await go({ name: 'thread', peerId: USER_ID, from: 'calls' });
  expect(await back()).toBe(true);
  expect(currentRoute()).toBe('calls');

  // photoViewer closes to its thread (its onClose), never backgrounds.
  await go({
    name: 'photoViewer',
    peerId: USER_ID,
    msgId: '01KYDBSSDJSPC9J0E5N2AWMJ5Z',
    direction: 'in',
  });
  expect(currentRoute()).toBe('photoViewer');
  expect(await back()).toBe(true);
  expect(currentRoute()).toBe('thread');

  // The COMPOSED leg the re-gate demanded: Calls → thread → photo → back →
  // back must land on CALLS. The photo is opened through the thread
  // screen's own onOpenPhoto — the real wiring — because the defect was
  // the route BUILDER dropping `from`: a devNav-built photo route with
  // `from` already aboard could never catch it. The first pop must
  // recreate a thread that still knows its origin; only the second pop's
  // destination proves it did.
  await go({ name: 'calls' });
  await go({ name: 'thread', peerId: USER_ID, from: 'calls' });
  const threadScreen = tree.root.findAll(
    node => typeof node.props.onOpenPhoto === 'function',
  )[0];
  expect(threadScreen).toBeDefined();
  await ReactTestRenderer.act(async () => {
    (
      threadScreen.props.onOpenPhoto as (
        msgId: string,
        direction: 'in' | 'out',
      ) => void
    )('01KYDBSSDJSPC9J0E5N2AWMJ5Z', 'in');
  });
  expect(currentRoute()).toBe('photoViewer');
  expect(await back()).toBe(true);
  expect(currentRoute()).toBe('thread');
  expect(await back()).toBe(true);
  expect(currentRoute()).toBe('calls');

  // And landing stays a root: the press is handed to the system.
  await go({ name: 'landing' });
  expect(await back()).toBe(false);
  expect(currentRoute()).toBe('landing');

  addListener.mockRestore();
});

test('visible Back keeps a Calls-origin thread through peer and group profiles', async () => {
  const tree = await renderApp();

  await openCallsThread(tree);
  await ReactTestRenderer.act(async () => {
    renderedThread(tree).props.onOpenPeerProfile();
  });
  expect(currentRoute()).toBe('peerProfile');
  await ReactTestRenderer.act(async () => {
    renderedPeerProfile(tree).props.onBack();
  });
  expect(currentRoute()).toBe('thread');
  await ReactTestRenderer.act(async () => {
    renderedThread(tree).props.onBack();
  });
  expect(currentRoute()).toBe('calls');

  await openCallsThread(tree);
  await ReactTestRenderer.act(async () => {
    renderedThread(tree).props.onOpenGroupProfile();
  });
  expect(currentRoute()).toBe('groupProfile');
  await ReactTestRenderer.act(async () => {
    renderedGroupProfile(tree).props.onBack();
  });
  expect(currentRoute()).toBe('thread');
  await ReactTestRenderer.act(async () => {
    renderedThread(tree).props.onBack();
  });
  expect(currentRoute()).toBe('calls');
});

test('hardware Back keeps a Calls-origin thread through peer, group, and group-member profiles', async () => {
  const handlers: Array<() => boolean> = [];
  const addListener = jest
    .spyOn(BackHandler, 'addEventListener')
    .mockImplementation((_event, handler) => {
      handlers.push(handler as () => boolean);
      return { remove: jest.fn() };
    });
  const tree = await renderApp();
  // The platform's own dispatch (RN BackHandler): NEWEST handler first,
  // stopping at the first `true`. The thread registers its own handler
  // after the router's (its sheets and drawers) and yields with nothing
  // open, so "the last handler" alone is no longer the router.
  const hardwareBack = async (): Promise<boolean> => {
    let consumed!: boolean;
    await ReactTestRenderer.act(async () => {
      consumed = [...handlers].reverse().some(handler => handler());
    });
    return consumed;
  };

  await openCallsThread(tree);
  await ReactTestRenderer.act(async () => {
    renderedThread(tree).props.onOpenPeerProfile();
  });
  expect(await hardwareBack()).toBe(true);
  expect(currentRoute()).toBe('thread');
  expect(await hardwareBack()).toBe(true);
  expect(currentRoute()).toBe('calls');

  await openCallsThread(tree);
  await ReactTestRenderer.act(async () => {
    renderedThread(tree).props.onOpenGroupProfile();
  });
  expect(await hardwareBack()).toBe(true);
  expect(currentRoute()).toBe('thread');
  expect(await hardwareBack()).toBe(true);
  expect(currentRoute()).toBe('calls');

  // A room MEMBER's profile pops back to the ROOM: three consumed presses
  // to Calls, not two. This block used to pin the defect — member profile
  // → 'thread' → 'calls', a 1:1 with someone you only share a room with —
  // and was rewritten deliberately.
  await openCallsThread(tree);
  await ReactTestRenderer.act(async () => {
    renderedThread(tree).props.onOpenGroupProfile();
  });
  await ReactTestRenderer.act(async () => {
    renderedGroupProfile(tree).props.onOpenMember('01KYDBSSDJSPC9J0E5N2AWMJ60');
  });
  expect(currentRoute()).toBe('peerProfile');
  expect(await hardwareBack()).toBe(true);
  expect(currentRoute()).toBe('groupProfile');
  expect(await hardwareBack()).toBe(true);
  expect(currentRoute()).toBe('thread');
  expect(await hardwareBack()).toBe(true);
  expect(currentRoute()).toBe('calls');

  addListener.mockRestore();
});

test('hardware back on a full-screen live call MINIMIZES it — the invisible route behind the call is not popped', async () => {
  // Before the minimized call, system back during a call
  // popped the route UNDER the full-screen call surface — a navigation the
  // person could not see. Now a connected call answers back by putting
  // itself in the window (consumed: true), and only the NEXT back reaches
  // the router. Pinned on a root (chats): the first press minimizes and is
  // consumed; the second yields to the system as a root always has.
  const handlers: Array<() => boolean> = [];
  const addListener = jest
    .spyOn(BackHandler, 'addEventListener')
    .mockImplementation((_event, handler) => {
      handlers.push(handler as () => boolean);
      return { remove: jest.fn() };
    });
  const sendCallEnvelope = jest
    .spyOn(messaging, 'sendCallEnvelope')
    .mockResolvedValue(undefined);
  const turn = jest
    .spyOn(api, 'apiTurnCredentials')
    .mockRejectedValue(new Error('no relay in tests'));
  const callEvents = (
    jest.requireMock('tacendum-call') as unknown as {
      __call: { emit: (n: string, p: unknown) => void };
    }
  ).__call;
  const PEER = '01HQBBBB00000000000000000A';
  const CID = '01HQCA11000000000000000AAA';
  try {
    const tree = await renderApp();
    const handler = handlers[handlers.length - 1];
    expect(currentRoute()).toBe('chats');

    await ReactTestRenderer.act(async () => {
      await callController().placeCall(PEER, CID, false);
      callEvents.emit('iceState', { cid: CID, state: 'connected' });
      for (let i = 0; i < 60; i++) await Promise.resolve();
    });
    expect(callController().state.name).toBe('connected');
    expect(tree.root.findAllByType(CallScreen)).toHaveLength(1);

    let consumed!: boolean;
    await ReactTestRenderer.act(async () => {
      consumed = handler();
    });
    expect(consumed).toBe(true);
    expect(tree.root.findAllByType(CallScreen)).toHaveLength(0);
    expect(tree.root.findAllByType(CallOverlay)).toHaveLength(1);
    expect(callController().state.name).toBe('connected');
    // The route was not touched.
    expect(currentRoute()).toBe('chats');

    // Minimized, back means what it always meant: chats is a root.
    await ReactTestRenderer.act(async () => {
      consumed = handler();
    });
    expect(consumed).toBe(false);
    expect(currentRoute()).toBe('chats');
    expect(tree.root.findAllByType(CallOverlay)).toHaveLength(1);

    await ReactTestRenderer.act(async () => {
      await callController().hangup();
      for (let i = 0; i < 60; i++) await Promise.resolve();
    });
    expect(tree.root.findAllByType(CallOverlay)).toHaveLength(0);
  } finally {
    addListener.mockRestore();
    sendCallEnvelope.mockRestore();
    turn.mockRestore();
  }
});

test('unmount removes the hardware back subscription', async () => {
  // A leaked subscription outlives the router it pops: after a remount the
  // stale handler still answers, against a routeRef that no longer exists.
  const remove = jest.fn();
  const addListener = jest
    .spyOn(BackHandler, 'addEventListener')
    .mockImplementation(() => ({ remove }));

  const tree = await renderApp();
  expect(addListener).toHaveBeenCalled();
  expect(remove).not.toHaveBeenCalled();
  await ReactTestRenderer.act(async () => {
    mounted.splice(mounted.indexOf(tree), 1);
    tree.unmount();
  });
  expect(remove).toHaveBeenCalled();

  addListener.mockRestore();
});
