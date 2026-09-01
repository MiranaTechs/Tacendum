/**
 * The wide two-pane projection.
 *
 * Wide is a PROJECTION of the one Route union, never a second router: the
 * same route state renders one surface on a phone and list-beside-detail on
 * an expanded (≥840dp) window. This file pins the projection's shape and its
 * security truth:
 *
 *  - expanded renders the list pane (ChatList/Calls + the TabBar as the
 *    pane's rail, `selectedPeerId` lighting the open conversation's row)
 *    beside the detail pane; the QuietRoom-seeded empty detail shows when
 *    the route IS a home list;
 *  - The disclosure rule, pinned: the visible thread beside
 *    route.name === 'chats' still discloses — the wide surface holds TWO
 *    routes, one of them named 'chats', and a screenshot names the thread's
 *    peer anyway, because the facts derive from every visible route;
 *  - the cover math holds under two panes (a workspace pane is never
 *    capture-exempt, with or without a call overlay);
 *  - the pre-workspace routes (locked/landing/loading/register) and the
 *    photoViewer stay FULL-WINDOW at every width;
 *  - compact and medium are untouched: one pane, the TabBar as window
 *    chrome, the edge swipe still armed (canGoBack true on a popped route,
 *    where wide pins it false — the swipe is disabled in wide).
 *
 * The fixture is the real App over the real db module, with the recorded
 * op-sqlite mock rebound to Node's real SQLite (the ChatList.rooms harness)
 * so both panes' queries actually run.
 */

jest.mock('../src/ws', () => {
  const handlers: {
    frame?: (f: unknown) => void;
    state?: (s: string) => void;
  } = {};
  const state = { open: true };
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
      return state.open;
    }
  }
  return { WsClient, __ws: { handlers, calls, state } };
});

jest.mock('../src/api', () => ({
  onApiAuthRenewed: jest.fn(() => () => undefined),
  apiAuthChallenge: jest.fn().mockRejectedValue(new Error('network in test')),
  apiAuth: jest.fn().mockRejectedValue(new Error('network in test')),
  apiUploadKeys: jest.fn().mockRejectedValue(new Error('network in test')),
  apiGetPrekeyBundle: jest.fn().mockRejectedValue(new Error('network in test')),
  apiDeleteAccount: jest.fn().mockRejectedValue(new Error('network in test')),
  apiCreateAttachment: jest.fn().mockRejectedValue(new Error('network in test')),
  apiGetAttachmentUrl: jest.fn().mockRejectedValue(new Error('network in test')),
  apiTurnCredentials: jest.fn().mockRejectedValue(new Error('network in test')),
  apiRegisterPushToken: jest.fn().mockRejectedValue(new Error('network in test')),
  uploadBlob: jest.fn().mockRejectedValue(new Error('network in test')),
  downloadBlob: jest.fn().mockRejectedValue(new Error('network in test')),
  apiWsTicket: jest.fn().mockRejectedValue(new Error('network in test')),
}));

jest.mock('../src/decoy', () => ({
  syncDecoyProfile: jest.fn(async () => undefined),
  refreshDecoyTimestamps: jest.fn(async () => undefined),
}));

import React from 'react';
import { Dimensions } from 'react-native';
import ReactTestRenderer from 'react-test-renderer';
import App from '../App';
import * as calling from '../src/call';
import * as db from '../src/db';
import { AUTH_TOKEN_KEY, messaging } from '../src/messaging';
import { CallsScreen } from '../src/screens/CallsScreen';
import { ChatListScreen } from '../src/screens/ChatListScreen';
import { ChatThreadScreen } from '../src/screens/ChatThreadScreen';
import { LockScreen } from '../src/screens/LockScreen';
import { session } from '../src/session';
import { EmptyDetail } from '../src/ui/EmptyDetail';
import { QuietRoom } from '../src/ui/QuietRoom';
import { TabBar } from '../src/ui/TabBar';
import { deriveSurfaceFacts, wideVisibleSurface } from '../src/visibleSurface';

// The App graph loads at suite setup, never inside a test's clock (the
// GroupCallScreen.test.tsx lesson); the render still pays react-native's
// lazy-getter transform cost cold, so the file carries the same ceiling.
jest.setTimeout(120_000);

// --- the real engine, bound under the recorded mock -------------------------

type Row = Record<string, unknown>;
interface Engine {
  prepare(sql: string): { all(...args: unknown[]): Row[] };
  close(): void;
}
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (p: string) => Engine;
};

interface FakeDb {
  name: string;
  execute: jest.Mock;
  close: jest.Mock;
}
const sqlite = jest.requireMock('@op-engineering/op-sqlite') as {
  open: (o: { name: string }) => FakeDb;
  __sqlite: { instances: Map<string, FakeDb>; reset: () => void };
};
const crypto = jest.requireMock('tacendum-crypto') as {
  __keychain: Map<string, string>;
  hasIdentity: jest.Mock;
};
const screensec = (
  jest.requireMock('tacendum-screen-security') as {
    __screensec: {
      emitCaptured: (captured: boolean) => void;
      emitScreenshot: () => void;
    };
  }
).__screensec;

let engine: Engine;

function bindRealEngine(): void {
  engine = new DatabaseSync(':memory:');
  const instance = sqlite.open({ name: 'tacendum.sqlite' });
  instance.execute.mockImplementation(
    async (sql: unknown, params?: unknown[]) => {
      const args = (params ?? []).map(p => (p === undefined ? null : p));
      const rows = engine.prepare(String(sql)).all(...args);
      const changes = engine.prepare('SELECT changes() AS c').all()[0]!
        .c as number;
      return { rows, rowsAffected: changes };
    },
  );
}

// --- ids and fixtures -------------------------------------------------------

const pad = (seed: string): string => (seed + '0'.repeat(26)).slice(0, 26);
const ME = pad('ME');
const PEER = pad('SAM');

const PROFILE: db.ProfileRow = {
  userId: ME,
  registrationId: 7,
  displayName: 'Avery',
  about: '',
  avatarB64: '',
  profileVersion: 0,
};

/** Emits a real dimensions change, as a rotation or Split View drag does
 * (the windowclass.test.ts harness). */
function setWindow(width: number, height: number) {
  Dimensions.set({ window: { width, height, scale: 2, fontScale: 2 } });
}
const initialDimensions = {
  window: { ...Dimensions.get('window') },
  screen: { ...Dimensions.get('screen') },
};

type Nav = (route: { name: string; [key: string]: unknown }) => void;
const devNav = () =>
  (globalThis as unknown as Record<string, unknown>).TacendumDevNav as Nav;

async function flush(): Promise<void> {
  for (let i = 0; i < 60; i++) await Promise.resolve();
}

const mounted: ReactTestRenderer.ReactTestRenderer[] = [];

/** Boots the real App to the chats route: profile on disk, token in the
 * Keychain, no lock — the ordinary signed-in launch. */
async function bootApp(): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(React.createElement(App));
  });
  mounted.push(tree);
  await ReactTestRenderer.act(async () => {
    await flush();
  });
  return tree;
}

function paneCount(
  tree: ReactTestRenderer.ReactTestRenderer,
  testID: string,
): number {
  // Host nodes only: findAll would otherwise return composite+host pairs.
  return tree.root.findAll(
    node => String(node.type) === 'View' && node.props.testID === testID,
  ).length;
}

function coverCount(tree: ReactTestRenderer.ReactTestRenderer): number {
  return tree.root.findAll(node => node.props.testID === 'capture-cover')
    .length;
}

/** The RouteTransition instances, found by composite type name: App.tsx
 * keeps the component private, and the swipe contract (canGoBack) is a prop
 * on it — wide pins it false, compact keeps today's answer. */
function routeTransitions(tree: ReactTestRenderer.ReactTestRenderer) {
  return tree.root.findAll(
    node =>
      typeof node.type === 'function' &&
      (node.type as { name?: string }).name === 'RouteTransition',
  );
}

beforeEach(async () => {
  calling.resetCallingForTests();
  messaging.stop();
  await db.close();
  db.setWorkspace('real');
  session.setMode('real');
  crypto.__keychain.clear();
  crypto.hasIdentity.mockResolvedValue(true);
  sqlite.__sqlite.reset();
  bindRealEngine();
  crypto.__keychain.set(AUTH_TOKEN_KEY, 'token-1');
  // Seed the workspace the boot will reopen: a profile and one conversation.
  await db.initDb();
  await db.saveProfile(PROFILE);
  await db.upsertChat(PEER, 'Sam');
  await db.close();
});

afterEach(async () => {
  await ReactTestRenderer.act(async () => {
    screensec.emitCaptured(false);
  });
  await ReactTestRenderer.act(async () => {
    while (mounted.length) mounted.pop()!.unmount();
  });
  calling.resetCallingForTests();
  jest.restoreAllMocks();
  crypto.hasIdentity.mockResolvedValue(false);
  messaging.stop();
  await db.close();
  engine.close();
  Dimensions.set(initialDimensions);
});

// --- the model: one entry per visible pane ----------------------------------

test('wideVisibleSurface projects one entry per visible pane; the empty detail contributes none', () => {
  const siblings = { call: { name: 'idle', call: null }, groupCall: null };
  expect(
    wideVisibleSurface({ name: 'chats' }, null, siblings).routes,
  ).toEqual([{ name: 'chats' }]);
  expect(
    wideVisibleSurface(
      { name: 'chats' },
      { name: 'thread', peerId: PEER },
      siblings,
    ).routes,
  ).toEqual([{ name: 'chats' }, { name: 'thread', peerId: PEER }]);
  // The overlay derivation is compact's exactly: calls stay full-window
  // router siblings on every surface.
  expect(
    wideVisibleSurface({ name: 'chats' }, null, {
      call: { name: 'connected', call: {} },
      groupCall: null,
    }).overlays,
  ).toEqual({ call: true, groupCall: false });
});

test('two-pane facts: disclosure names the thread beside a chats route, and the cover math holds', () => {
  const quiet = { call: { name: 'idle', call: null }, groupCall: null };
  const twoPanes = deriveSurfaceFacts(
    wideVisibleSurface({ name: 'chats' }, { name: 'thread', peerId: PEER }, quiet),
  );
  // The point, at the model: the surface holds a route NAMED 'chats'
  // and the disclosure still names the visible thread's peer.
  expect([...twoPanes.screenshotDisclosureTo]).toEqual([PEER]);
  // A workspace pane is never capture-exempt; the lease and push-nav facts
  // answer for BOTH panes.
  expect(twoPanes.captureCoverApplies).toBe(true);
  expect(twoPanes.provesWorkspaceOpen).toBe(true);
  expect(twoPanes.pushNavRedeemable).toBe(true);
  expect(twoPanes.pushNavLandable).toBe(true);

  // The empty detail: nothing routed on glass there — nothing to disclose,
  // and the list pane alone still covers, proves, redeems and lands.
  const emptyDetail = deriveSurfaceFacts(
    wideVisibleSurface({ name: 'chats' }, null, quiet),
  );
  expect([...emptyDetail.screenshotDisclosureTo]).toEqual([]);
  expect(emptyDetail.captureCoverApplies).toBe(true);
  expect(emptyDetail.provesWorkspaceOpen).toBe(true);

  // The design as amended, under two panes: a live call overlay covers, and it
  // adds no disclosure target — a call proves nothing about the verdict.
  const withCall = deriveSurfaceFacts(
    wideVisibleSurface({ name: 'chats' }, { name: 'thread', peerId: PEER }, {
      call: { name: 'connected', call: {} },
      groupCall: null,
    }),
  );
  expect(withCall.captureCoverApplies).toBe(true);
  expect([...withCall.screenshotDisclosureTo]).toEqual([PEER]);
  expect(withCall.provesWorkspaceOpen).toBe(true);
});

// --- the projection, against the real App -----------------------------------

test('expanded projects the list pane beside the detail pane: QuietRoom-seeded empty detail, rail in the pane, selected row lit', async () => {
  setWindow(1024, 768);
  const tree = await bootApp();

  // Boot lands on chats: in wide that is the list beside the EMPTY detail —
  // the QuietRoom-seeded surface — with the TabBar as the
  // list pane's rail.
  expect(paneCount(tree, 'list-pane')).toBe(1);
  expect(paneCount(tree, 'detail-pane')).toBe(1);
  expect(tree.root.findAllByType(ChatListScreen).length).toBe(1);
  const empty = tree.root.findAllByType(EmptyDetail);
  expect(empty.length).toBe(1);
  expect(empty[0].findAllByType(QuietRoom).length).toBe(1);
  expect(tree.root.findByType(TabBar).props.active).toBe('chats');

  // Open the conversation: BOTH panes live — the list stays mounted beside
  // the thread, the empty detail leaves, and the open row wears the
  // selected state (B1's selectedPeerId).
  await ReactTestRenderer.act(async () => {
    devNav()({ name: 'thread', peerId: PEER });
  });
  await ReactTestRenderer.act(async () => {
    await flush();
  });
  expect(tree.root.findAllByType(ChatListScreen).length).toBe(1);
  expect(tree.root.findAllByType(ChatThreadScreen).length).toBe(1);
  expect(tree.root.findAllByType(EmptyDetail).length).toBe(0);
  const selectedRows = tree.root.findAll(
    node =>
      node.props.testID === `chat-${PEER}` &&
      node.props.accessibilityState?.selected === true,
  );
  expect(selectedRows.length).toBeGreaterThan(0);
  // The wide detail pane's transition has the edge swipe DISABLED:
  // the pop still exists — chevron and hardware back — but no drag.
  const transitions = routeTransitions(tree);
  expect(transitions.length).toBe(1);
  expect(transitions[0].props.canGoBack).toBe(false);
});

test('a Calls-origin thread shows the Calls list in the pane — the same origin its Back control reads', async () => {
  setWindow(1024, 768);
  const tree = await bootApp();
  await ReactTestRenderer.act(async () => {
    devNav()({ name: 'thread', peerId: PEER, from: 'calls' });
  });
  await ReactTestRenderer.act(async () => {
    await flush();
  });
  expect(tree.root.findAllByType(CallsScreen).length).toBe(1);
  expect(tree.root.findAllByType(ChatListScreen).length).toBe(0);
  expect(tree.root.findByType(TabBar).props.active).toBe('calls');
});

test("the visible thread beside route.name === 'chats' still discloses", async () => {
  const spy = jest
    .spyOn(messaging, 'sendScreenshotNotice')
    .mockResolvedValue(undefined);
  setWindow(1024, 768);
  const tree = await bootApp();
  await ReactTestRenderer.act(async () => {
    devNav()({ name: 'thread', peerId: PEER });
  });
  await ReactTestRenderer.act(async () => {
    await flush();
  });
  // The nightmare configuration the rule exists for: a route named 'chats' IS on
  // glass (the list pane), beside the visible thread.
  expect(tree.root.findAllByType(ChatListScreen).length).toBe(1);
  expect(tree.root.findAllByType(ChatThreadScreen).length).toBe(1);

  await ReactTestRenderer.act(async () => {
    screensec.emitScreenshot();
  });
  expect(spy).toHaveBeenCalledTimes(1);
  expect(spy).toHaveBeenCalledWith(PEER);

  // The list beside the EMPTY detail discloses nothing: no conversation
  // content is on glass, and a notice would manufacture false evidence.
  await ReactTestRenderer.act(async () => {
    devNav()({ name: 'chats' });
  });
  await ReactTestRenderer.act(async () => {
    screensec.emitScreenshot();
  });
  expect(spy).toHaveBeenCalledTimes(1);
});

test('the capture cover blanks the whole window over two panes — a workspace pane is never exempt', async () => {
  setWindow(1024, 768);
  const tree = await bootApp();
  await ReactTestRenderer.act(async () => {
    devNav()({ name: 'thread', peerId: PEER });
  });
  await ReactTestRenderer.act(async () => {
    screensec.emitCaptured(true);
  });
  expect(coverCount(tree)).toBeGreaterThan(0);
  // The empty-detail state too: the LIST is conversation content.
  await ReactTestRenderer.act(async () => {
    devNav()({ name: 'chats' });
  });
  expect(coverCount(tree)).toBeGreaterThan(0);
  await ReactTestRenderer.act(async () => {
    screensec.emitCaptured(false);
  });
  expect(coverCount(tree)).toBe(0);
});

test('pre-workspace surfaces stay full-window in wide: the lock screen on an iPad is the lock screen', async () => {
  setWindow(1024, 768);
  const tree = await bootApp();
  await ReactTestRenderer.act(async () => {
    devNav()({ name: 'locked' });
  });
  expect(tree.root.findAllByType(LockScreen).length).toBe(1);
  expect(paneCount(tree, 'list-pane')).toBe(0);
  expect(paneCount(tree, 'detail-pane')).toBe(0);
  expect(tree.root.findAllByType(ChatListScreen).length).toBe(0);
});

test('compact and medium keep the one-pane shell: no list pane, window-chrome TabBar, edge swipe still armed', async () => {
  // Compact: a phone.
  setWindow(390, 844);
  const compactTree = await bootApp();
  expect(paneCount(compactTree, 'list-pane')).toBe(0);
  expect(compactTree.root.findAllByType(ChatListScreen).length).toBe(1);
  expect(compactTree.root.findAllByType(EmptyDetail).length).toBe(0);
  expect(compactTree.root.findByType(TabBar).props.active).toBe('chats');
  await ReactTestRenderer.act(async () => {
    devNav()({ name: 'thread', peerId: PEER });
  });
  await ReactTestRenderer.act(async () => {
    await flush();
  });
  // One pane: the thread replaces the list, exactly as before the wide shell…
  expect(compactTree.root.findAllByType(ChatListScreen).length).toBe(0);
  expect(compactTree.root.findAllByType(ChatThreadScreen).length).toBe(1);
  // …and the swipe contract is untouched: a popped route can go back.
  const compactTransitions = routeTransitions(compactTree);
  expect(compactTransitions.length).toBe(1);
  expect(compactTransitions[0].props.canGoBack).toBe(true);
  await ReactTestRenderer.act(async () => {
    while (mounted.length) mounted.pop()!.unmount();
  });

  // Medium (600–839dp): the compact layout — an 834pt-wide 11"
  // iPad portrait window renders exactly the phone shell.
  setWindow(834, 1194);
  const mediumTree = await bootApp();
  expect(paneCount(mediumTree, 'list-pane')).toBe(0);
  expect(mediumTree.root.findAllByType(EmptyDetail).length).toBe(0);
  expect(mediumTree.root.findAllByType(ChatListScreen).length).toBe(1);
});
