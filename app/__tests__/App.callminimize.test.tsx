/**
 * The MINIMIZED 1:1 call, against the real App (the request:
 * "i should be able to go back to the chat from a video call — while the
 * video call is on, minimized on the top right corner and moveable as well,
 * similar to whatsapp").
 *
 * What the App owns and this file pins:
 *  - minimize swaps the full `CallScreen` for the small `CallOverlay` in the
 *    SAME slot, the call keeps going, and the route underneath — which a call
 *    never changed — is on glass and navigable; a tap restores the screen;
 *  - the window is a call on glass to the visible-surface model: the capture
 *    cover applies over it exactly as over the full screen;
 *  - the window NEVER renders on the locked route: the full screen — the
 *    surface proven over the lock — comes back for the frames a call has
 *    there, and it offers no minimize;
 *  - a relock ends a minimized call and dismisses the window, through the
 *    same `endCallOnQuiesce` funnel as the full screen;
 *  - End from the window ends the call; the NEXT call starts full screen;
 *  - a ringing call cannot minimize (its ringback lives on the full screen);
 *  - a duress session never gets the window: a call the machine enters there
 *    keeps the full screen and offers no minimize (`callOverlayAllowed` refuses duress outright).
 *
 * Harness: App.relockcall.test.tsx's (the lock, the spied transport, the
 * native call events) with back.android.test.ts's seeded real profile so an
 * unlock lands on the chat list. No fake timers: every clock here is the
 * machine's own, and nothing asserts on a duration.
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
  return { WsClient, __ws: { handlers, calls } };
});

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { AppState } from 'react-native';
import App, { CALL_OVERLAY_SURFACE } from '../App';
import * as native from 'tacendum-call';
import * as api from '../src/api';
import * as calling from '../src/call';
import * as db from '../src/db';
import { messaging } from '../src/messaging';
import { session } from '../src/session';
import { CallScreen } from '../src/screens/CallScreen';
import { CallOverlay } from '../src/screens/CallOverlay';
import { deriveSurfaceFacts, type SurfaceRouteName } from '../src/visibleSurface';

jest.setTimeout(120_000);

test('every route decides the window: `full` is exactly the set that proves no workspace', () => {
  // The gate is a Record over the route union (a new route refuses to
  // compile without a row); THIS pins that the rows agree with the
  // visible-surface model's NO_WORKSPACE in both directions — a route the
  // model says proves no open workspace gets the full screen, and every
  // route that proves one may carry the window. A denylist could drift from
  // that set silently; a Record cannot, and this cannot let it.
  const names = Object.keys(CALL_OVERLAY_SURFACE) as SurfaceRouteName[];
  expect(names.length).toBeGreaterThan(5);
  for (const name of names) {
    const proves = deriveSurfaceFacts({
      routes: [{ name }],
      overlays: { call: false, groupCall: false },
    }).provesWorkspaceOpen;
    expect([name, CALL_OVERLAY_SURFACE[name]]).toEqual([name, proves ? 'window' : 'full']);
  }
  expect(names.filter(n => CALL_OVERLAY_SURFACE[n] === 'full').sort()).toEqual(
    ['landing', 'loading', 'locked', 'recover', 'register'],
  );
});

/** REAL Crockford ULIDs — the shipped zod schemas validate every id. */
const PEER = '01HQBBBB00000000000000000A';
const CID = '01HQCA11000000000000000AAA';
const CID2 = '01HQCA11000000000000000AAB';
const USER_ID = '01KYDBSSDJSPC9J0E5N2AWMJ5Y';

const crypto = jest.requireMock('tacendum-crypto') as {
  __keychain: Map<string, string>;
  hasIdentity: jest.Mock;
  identityPublicKey: jest.Mock;
};
interface FakeDb {
  name: string;
  execute: jest.Mock;
  close: jest.Mock;
}
const sqlite = (
  jest.requireMock('@op-engineering/op-sqlite') as {
    __sqlite: { reset: () => void; opened: string[]; instances: Map<string, FakeDb> };
  }
).__sqlite;
const callEvents = (
  native as unknown as { __call: { emit: (n: string, p: unknown) => void } }
).__call;
const screensec = (
  jest.requireMock('tacendum-screen-security') as {
    __screensec: { emitCaptured: (captured: boolean) => void };
  }
).__screensec;

/** A workspace holding a finished account, so an unlock lands on chats. */
function seedProfile(file: string): void {
  const instance: FakeDb = {
    name: file,
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
  sqlite.instances.set(file, instance);
}

const mounted: ReactTestRenderer.ReactTestRenderer[] = [];
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
  await ReactTestRenderer.act(async () => {
    await flush();
  });
  return tree;
}

async function press(
  tree: ReactTestRenderer.ReactTestRenderer,
  testID: string,
): Promise<void> {
  await ReactTestRenderer.act(async () => {
    tree.root.findByProps({ testID }).props.onPress();
    await flush();
  });
}

async function transition(state: 'background' | 'active'): Promise<void> {
  await ReactTestRenderer.act(async () => {
    for (const listener of [...appStateListeners]) listener(state);
    await flush();
  });
}

type Nav = (route: { name: string; [key: string]: unknown }) => void;
const devNav = () =>
  (globalThis as unknown as Record<string, unknown>).TacendumDevNav as Nav;
const currentRoute = () =>
  (globalThis as unknown as Record<string, unknown>).TacendumDevRoute as string;

async function unlock(tree: ReactTestRenderer.ReactTestRenderer, code: string): Promise<void> {
  for (const key of code.split('')) {
    await press(tree, `pin-key-${key}`);
  }
  await press(tree, 'pin-submit');
  await ReactTestRenderer.act(async () => {
    await flush();
  });
}

async function connectedCall(cid = CID): Promise<void> {
  await ReactTestRenderer.act(async () => {
    await calling.callController().placeCall(PEER, cid, false);
    callEvents.emit('iceState', { cid, state: 'connected' });
    await flush();
  });
  expect(calling.callController().state.name).toBe('connected');
}

const fullScreens = (tree: ReactTestRenderer.ReactTestRenderer) =>
  tree.root.findAllByType(CallScreen).length;
const windows = (tree: ReactTestRenderer.ReactTestRenderer) =>
  tree.root.findAllByType(CallOverlay).length;
/** Whether the minimize control is on glass. Presence, not a count: the
 * Pressable and the host views it renders all carry the testID. */
const minimizeOffered = (tree: ReactTestRenderer.ReactTestRenderer) =>
  tree.root.findAll(n => n.props.testID === 'call-minimize').length > 0;
const coverCount = (tree: ReactTestRenderer.ReactTestRenderer) =>
  tree.root.findAll(n => n.props.testID === 'capture-cover').length;
/** The chat list, by the props only it carries. */
const chatList = (tree: ReactTestRenderer.ReactTestRenderer) =>
  tree.root.findAll(
    n => typeof n.props.onStartChat === 'function' && typeof n.props.onOpenChat === 'function',
  ).length;

const realFetch = globalThis.fetch;
const fetchMock = jest.fn(async () => ({
  ok: true,
  status: 200,
  json: async () => ({}),
  text: async () => '',
}));

beforeEach(async () => {
  calling.resetCallingForTests();
  messaging.stop();
  await db.close();
  db.setWorkspace('real');
  session.setMode('real');
  crypto.__keychain.clear();
  crypto.hasIdentity.mockResolvedValue(true);
  crypto.identityPublicKey.mockResolvedValue('BQ0IDENTITYKEYBASE64');
  sqlite.reset();
  seedProfile('tacendum.sqlite');
  jest.clearAllMocks();
  fetchMock.mockClear();
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  appStateListeners = [];
  jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation(((_type: string, fn: (next: string) => void) => {
      appStateListeners.push(fn);
      return { remove: jest.fn() };
    }) as unknown as typeof AppState.addEventListener);

  // The transport, spied as App.relockcall.test.tsx spies it: this file is
  // about what is ON GLASS, not about the ratchet or the relay.
  jest.spyOn(messaging, 'sendCallEnvelope').mockResolvedValue(undefined);
  jest.spyOn(messaging, 'stop');
  jest
    .spyOn(api, 'apiTurnCredentials')
    .mockRejectedValue(new Error('no relay in tests'));

  // A lock with autolock 0: ANY background→active round trip relocks.
  crypto.__keychain.set('lock.enabled', '1');
  crypto.__keychain.set('lock.passcode', '123456');
  crypto.__keychain.set('authToken', 'token-for-this-test');
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
  crypto.identityPublicKey.mockResolvedValue(null);
  await db.close();
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

test('minimize puts the call in a window over the chat, which stays usable; a tap restores it', async () => {
  const tree = await renderApp();
  await unlock(tree, '123456');
  expect(currentRoute()).toBe('chats');

  await connectedCall();
  // Full screen, offering minimize, no window yet.
  expect(fullScreens(tree)).toBe(1);
  expect(windows(tree)).toBe(0);
  expect(minimizeOffered(tree)).toBe(true);

  await press(tree, 'call-minimize');
  // The window replaces the screen; the call is untouched.
  expect(fullScreens(tree)).toBe(0);
  expect(windows(tree)).toBe(1);
  expect(calling.callController().state.name).toBe('connected');
  // The route a call never changed is what the person is back on — and it
  // is rendered, not merely named: the chat list is on glass.
  expect(currentRoute()).toBe('chats');
  expect(chatList(tree)).toBe(1);

  // Navigating with the window up: it follows the person to the thread.
  await ReactTestRenderer.act(async () => {
    devNav()({ name: 'thread', peerId: PEER });
    await flush();
  });
  expect(currentRoute()).toBe('thread');
  expect(windows(tree)).toBe(1);
  expect(fullScreens(tree)).toBe(0);

  // THE WINDOW IS A CALL ON GLASS: a capture covers it exactly as it
  // covers the full screen — the other person's face in a corner is still
  // the other person's face.
  await ReactTestRenderer.act(async () => {
    screensec.emitCaptured(true);
  });
  expect(coverCount(tree)).toBeGreaterThan(0);
  await ReactTestRenderer.act(async () => {
    screensec.emitCaptured(false);
  });
  expect(coverCount(tree)).toBe(0);

  // Tap: the full screen is back, the route beneath still the thread.
  await press(tree, 'call-overlay');
  expect(fullScreens(tree)).toBe(1);
  expect(windows(tree)).toBe(0);
  expect(currentRoute()).toBe('thread');
  expect(calling.callController().state.name).toBe('connected');
});

test('the window never renders on the locked route — the full screen, the surface proven there, comes back and offers no minimize', async () => {
  const tree = await renderApp();
  await unlock(tree, '123456');
  await connectedCall();
  await press(tree, 'call-minimize');
  expect(windows(tree)).toBe(1);

  // Force the route the way the regression does. The call is still
  // live (this is not a relock — that case is below); only the route moved.
  await ReactTestRenderer.act(async () => {
    devNav()({ name: 'locked' });
    await flush();
  });
  expect(tree.root.findAllByProps({ testID: 'lock-screen' }).length).toBeGreaterThan(0);
  expect(windows(tree)).toBe(0);
  expect(fullScreens(tree)).toBe(1);
  // Nothing to minimize TO behind the lock.
  expect(minimizeOffered(tree)).toBe(false);

  // Back on a workspace route, the person's choice stands: the window returns.
  await ReactTestRenderer.act(async () => {
    devNav()({ name: 'chats' });
    await flush();
  });
  expect(windows(tree)).toBe(1);
  expect(fullScreens(tree)).toBe(0);
});

test('a relock ends a minimized call and its window through the same funnel as the full screen', async () => {
  const tree = await renderApp();
  await unlock(tree, '123456');
  await connectedCall();
  await press(tree, 'call-minimize');
  expect(windows(tree)).toBe(1);

  await transition('background');
  await transition('active');
  await ReactTestRenderer.act(async () => {
    await flush();
  });

  expect(tree.root.findAllByProps({ testID: 'lock-screen' }).length).toBeGreaterThan(0);
  // Rule 14: the call cannot outlive its signalling path — the peer was
  // told, BEFORE the socket died, and the machine is idle…
  const sends = (messaging.sendCallEnvelope as jest.Mock).mock.calls;
  const end = sends.find(c => c[1]?.tcm === 'call.end' && c[1]?.cid === CID);
  expect(end).toBeDefined();
  const endOrder = (messaging.sendCallEnvelope as jest.Mock).mock.invocationCallOrder[
    sends.indexOf(end!)
  ];
  expect(endOrder).toBeLessThan((messaging.stop as jest.Mock).mock.invocationCallOrder[0]);
  expect(native.close).toHaveBeenCalledWith(CID);
  expect(calling.callController().state.name).toBe('idle');
  // …and nothing of the call is on glass: no window, no full screen.
  expect(windows(tree)).toBe(0);
  expect(fullScreens(tree)).toBe(0);
});

test('End from the window ends the call; the next call starts full screen', async () => {
  const tree = await renderApp();
  await unlock(tree, '123456');
  await connectedCall();
  await press(tree, 'call-minimize');
  expect(windows(tree)).toBe(1);

  await press(tree, 'call-overlay-end');
  expect(calling.callController().state.name).toBe('idle');
  expect(windows(tree)).toBe(0);
  expect(fullScreens(tree)).toBe(0);
  expect(currentRoute()).toBe('chats');

  // "Minimized" was a fact about THAT call: the next one is full screen from
  // its first frame (reset at render on the cid change, not in an effect).
  await connectedCall(CID2);
  expect(fullScreens(tree)).toBe(1);
  expect(windows(tree)).toBe(0);
  expect(minimizeOffered(tree)).toBe(true);
});

test('the peer ending the call dismisses the window too', async () => {
  const tree = await renderApp();
  await unlock(tree, '123456');
  await connectedCall();
  await press(tree, 'call-minimize');
  expect(windows(tree)).toBe(1);

  await ReactTestRenderer.act(async () => {
    await calling.callController().hangup();
    await flush();
  });
  expect(calling.callController().state.name).toBe('idle');
  expect(windows(tree)).toBe(0);
  expect(fullScreens(tree)).toBe(0);
});

test('a call that is still connecting cannot minimize — its ringback lives on the full screen', async () => {
  const tree = await renderApp();
  await unlock(tree, '123456');
  await ReactTestRenderer.act(async () => {
    await calling.callController().placeCall(PEER, CID, false);
    await flush();
  });
  expect(calling.callController().state.name).toBe('outgoing_connecting');
  expect(fullScreens(tree)).toBe(1);
  expect(minimizeOffered(tree)).toBe(false);
  expect(windows(tree)).toBe(0);
});

test('a duress session never gets the window: a call there keeps the full screen and offers no minimize', async () => {
  // Rule 15: the decoy workspace never carries a REAL session's call —
  // relock ends it before any verdict. A call the machine will still enter
  // under duress (the transport is dead on a device, but the machine does
  // not know that) gets exactly what it got before this train: the full
  // screen. `callOverlayAllowed` refuses duress outright, so neither the
  // window nor the control that leads to it exists in a coerced session —
  // a window over the decoy chat list would advertise a call the coercer
  // could not otherwise see.
  seedProfile('tacendum-decoy.sqlite');
  const tree = await renderApp();
  await unlock(tree, '654321');
  expect(session.mode).toBe('duress');
  expect(currentRoute()).toBe('chats');

  await ReactTestRenderer.act(async () => {
    await calling
      .callController()
      .placeCall(PEER, CID, false)
      .catch(() => undefined);
    callEvents.emit('iceState', { cid: CID, state: 'connected' });
    await flush();
  });
  expect(windows(tree)).toBe(0);
  expect(minimizeOffered(tree)).toBe(false);
  if (calling.callController().state.name !== 'idle') {
    // The machine entered the call: it is the full screen, and only that.
    expect(fullScreens(tree)).toBe(1);
    await ReactTestRenderer.act(async () => {
      await calling.callController().hangup();
      await flush();
    });
  }
  expect(calling.callController().state.name).toBe('idle');
  expect(windows(tree)).toBe(0);
  expect(fullScreens(tree)).toBe(0);
});
