/**
 * Relock during a live 1:1 call.
 *
 * The seam the plans were silent about: relock stops messaging — the call's
 * signalling path — while the peer connection and the CXCall survive. The
 * result was a call that looked alive to the user and to CallKit but whose
 * hangup, ICE restarts and the peer's own end could never travel.
 *
 * The decided behaviour (argued at `disposeGroupCall` in src/call/index.ts):
 * a relock ENDS a live 1:1 call, through the reducer's own terminal funnel,
 * BEFORE the socket dies — so the peer is told, the CXCall is released, media
 * is closed and the log row is written. The group session already went this
 * way at every quiesce seam; one microphone, one rule.
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
import App from '../App';
import * as native from 'tacendum-call';
import * as api from '../src/api';
import * as calling from '../src/call';
import * as db from '../src/db';
import { callMetricDrain, callMetricLifecycle } from '../src/call/metrics';
import { messaging } from '../src/messaging';
import { session } from '../src/session';
import * as badge from '../src/badge';

/** REAL Crockford ULIDs — the shipped zod schemas validate every id. */
const PEER = '01HQBBBB00000000000000000A';
const CID = '01HQCA11000000000000000AAA';

const crypto = jest.requireMock('tacendum-crypto') as {
  __keychain: Map<string, string>;
  hasIdentity: jest.Mock;
};
interface FakeDb {
  execute: jest.Mock;
  close: jest.Mock;
}

const sqlite = (
  jest.requireMock('@op-engineering/op-sqlite') as {
    __sqlite: { reset: () => void; instances: Map<string, FakeDb> };
  }
).__sqlite;
const callEvents = (
  native as unknown as { __call: { emit: (n: string, p: unknown) => void } }
).__call;

const mounted: ReactTestRenderer.ReactTestRenderer[] = [];
/** Every AppState subscriber the app registered, so a test can be the OS. */
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
  return tree;
}

async function press(
  tree: ReactTestRenderer.ReactTestRenderer,
  testID: string,
): Promise<void> {
  await ReactTestRenderer.act(async () => {
    tree.root.findByProps({ testID }).props.onPress();
  });
}

async function transition(state: 'background' | 'active'): Promise<void> {
  await ReactTestRenderer.act(async () => {
    for (const listener of [...appStateListeners]) listener(state);
    await flush();
  });
}

beforeEach(async () => {
  calling.resetCallingForTests();
  messaging.stop();
  await db.close();
  db.setWorkspace('real');
  session.setMode('real');
  crypto.__keychain.clear();
  crypto.hasIdentity.mockResolvedValue(true);
  sqlite.reset();
  jest.clearAllMocks();

  appStateListeners = [];
  jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation(((_type: string, fn: (next: string) => void) => {
      appStateListeners.push(fn);
      return { remove: jest.fn() };
    }) as unknown as typeof AppState.addEventListener);

  // The transport, spied exactly as call.wiring.test.ts spies it: this file
  // is about the LIFECYCLE seam, not about the ratchet.
  jest.spyOn(messaging, 'sendCallEnvelope').mockResolvedValue(undefined);
  jest.spyOn(messaging, 'stop');
  // No relay in this fixture, decided instantly — the real path would wait
  // out an 8-second credential timeout against jest's dead fetch.
  jest
    .spyOn(api, 'apiTurnCredentials')
    .mockRejectedValue(new Error('no relay in tests'));

  // A lock with autolock 0: ANY background→active round trip relocks.
  crypto.__keychain.set('lock.enabled', '1');
  crypto.__keychain.set('lock.passcode', '123456');
});

afterEach(async () => {
  await ReactTestRenderer.act(async () => {
    while (mounted.length) mounted.pop()!.unmount();
  });
  calling.resetCallingForTests();
  jest.restoreAllMocks();
  crypto.hasIdentity.mockResolvedValue(false);
  await db.close();
});

test('a relock during a connected 1:1 call ends it: peer told before the socket dies, CallKit released, media closed', async () => {
  const tree = await renderApp();
  // Real unlock. (No profile row is seeded — the 1:1 call machine does not
  // consult the profile, and fewer fixtures is fewer ways to hang.)
  for (const key of ['1', '2', '3', '4', '5', '6']) {
    await press(tree, `pin-key-${key}`);
  }
  await press(tree, 'pin-submit');

  // A connected outgoing call: dial, then let ICE succeed.
  await ReactTestRenderer.act(async () => {
    await calling.callController().placeCall(PEER, CID, false);
    callEvents.emit('iceState', { cid: CID, state: 'connected' });
    await flush();
  });
  expect(calling.callController().state.name).toBe('connected');

  // Background keeps the socket (the call is its signalling path)…
  await transition('background');
  // …and foregrounding past the autolock relocks.
  await transition('active');
  await ReactTestRenderer.act(async () => {
    await flush();
  });

  // The relock itself ran.
  expect(tree.root.findAllByProps({ testID: 'lock-screen' }).length).toBeGreaterThan(0);

  // THE INVARIANT. A call cannot outlive its signalling path:
  // 1. The peer is told — and told BEFORE messaging stops, or the frame can
  //    never leave.
  const sends = (messaging.sendCallEnvelope as jest.Mock).mock.calls;
  const end = sends.find(c => c[1]?.tcm === 'call.end' && c[1]?.cid === CID);
  expect(end).toBeDefined();
  expect(end![0]).toBe(PEER);
  expect(end![1].r).toBe('hangup');
  const endOrder = (messaging.sendCallEnvelope as jest.Mock).mock.invocationCallOrder[
    sends.indexOf(end!)
  ];
  const stopOrder = (messaging.stop as jest.Mock).mock.invocationCallOrder[0];
  expect(endOrder).toBeLessThan(stopOrder);
  // 2. The CXCall is released — no call on the lock screen that nothing can
  //    drive — and the peer connection is closed, so the microphone dies with
  //    the workspace.
  expect(native.endCall).toHaveBeenCalledWith(CID, 'hangup');
  expect(native.close).toHaveBeenCalledWith(CID);
  // 3. The machine is idle: the next unlock starts clean.
  expect(calling.callController().state.name).toBe('idle');
});

test('relock revokes the singleton metric heartbeat and drain before closing SQLite', async () => {
  // Mutations caught: omit lifecycle deactivation from relock, omit drain
  // deactivation, or move either operation below db.close(). The real
  // singleton is deliberate: the bug is an ownership gap between App and the
  // process-wide call wiring, not CallMetricLifecycle in isolation.
  const tree = await renderApp();
  for (const key of ['1', '2', '3', '4', '5', '6']) {
    await press(tree, `pin-key-${key}`);
  }
  await press(tree, 'pin-submit');
  await ReactTestRenderer.act(flush);

  callMetricLifecycle.deactivate();
  callMetricDrain.deactivate();
  jest.useFakeTimers({
    // Only the metric heartbeat needs a fake clock. LockScreen/React Native
    // legitimately use the other timer families while rendering the relock.
    doNotFake: [
      'Date',
      'performance',
      'queueMicrotask',
      'nextTick',
      'setImmediate',
      'clearImmediate',
      'setTimeout',
      'clearTimeout',
      'requestAnimationFrame',
      'cancelAnimationFrame',
    ],
  });
  const setIntervalSpy = jest.spyOn(globalThis, 'setInterval');
  const clearIntervalSpy = jest.spyOn(globalThis, 'clearInterval');
  try {
    await callMetricDrain.activate();
    const staleDrainNudge = callMetricDrain.captureNudge();
    await callMetricLifecycle.open({
      reportId: '01K2ABCDEF0123456789ABCDEH',
      localId: 'real-workspace-before-relock',
      scope: 'group',
      media: 'audio',
      startedAt: Date.now(),
    });
    const heartbeat = setIntervalSpy.mock.results.at(-1)?.value;
    expect(heartbeat).toBeDefined();
    expect(callMetricDrain.activeReal).toBe(true);

    const real = sqlite.instances.get('tacendum.sqlite')!;
    let atClose: { heartbeatCleared: boolean; drainActive: boolean } | undefined;
    real.close.mockImplementationOnce(() => {
      atClose = {
        heartbeatCleared: clearIntervalSpy.mock.calls.some(
          call => call[0] === heartbeat,
        ),
        drainActive: callMetricDrain.activeReal,
      };
    });

    await transition('background');
    await transition('active');
    await ReactTestRenderer.act(flush);

    expect(atClose).toEqual({ heartbeatCleared: true, drainActive: false });
    const beforeStaleNudge = real.execute.mock.calls.length;
    staleDrainNudge();
    await flush();
    expect(real.execute.mock.calls).toHaveLength(beforeStaleNudge);
  } finally {
    callMetricDrain.deactivate();
    callMetricLifecycle.deactivate();
    setIntervalSpy.mockRestore();
    clearIntervalSpy.mockRestore();
    jest.useRealTimers();
  }
});

test('a call that ends while backgrounded pauses the socket EVEN behind the lock route (the immortal-incumbent client half)', async () => {
  // The post-call pause (App.tsx, the `prevCallName` effect) shipped guarded
  // by `session.mode === 'real' && route !== 'locked'` — the RESUME guard,
  // transposed (the commit said "same guards as the original"; the original
  // backgrounding pause has none). Behind the lock the skip left the socket
  // open for iOS to freeze, and the server's incumbent probe then found the
  // frozen socket alive forever (a live incident). The reachable
  // locked window is a real verdict's opening still in flight when a
  // backgrounded call ends; this test forces that route state through the
  // dev nav rather than racing the opening. The mutation caught: re-adding
  // either half of the old guard AROUND pause() fails the pause expectation
  // below. The badge sync deliberately KEEPS that guard — it reads
  // conversation state, which the lock route must not — so the same run also
  // asserts syncBadge stays silent behind the lock.
  const tree = await renderApp();
  for (const key of ['1', '2', '3', '4', '5', '6']) {
    await press(tree, `pin-key-${key}`);
  }
  await press(tree, 'pin-submit');

  // A connected outgoing call, exactly as the relock case dials it.
  await ReactTestRenderer.act(async () => {
    await calling.callController().placeCall(PEER, CID, false);
    callEvents.emit('iceState', { cid: CID, state: 'connected' });
    await flush();
  });
  expect(calling.callController().state.name).toBe('connected');

  // Background with the call live: the listener keeps the socket (it is the
  // call's signalling path), so any pause() recorded below is the post-call
  // effect's own.
  await transition('background');
  // The effect reads `AppState.currentState` directly; an own property
  // shadows the prototype getter (the App.screensec pattern).
  Object.defineProperty(AppState, 'currentState', {
    value: 'background',
    configurable: true,
  });
  try {
    // Behind the lock route, still backgrounded.
    const nav = (globalThis as unknown as Record<string, unknown>)
      .TacendumDevNav as (r: { name: string }) => void;
    await ReactTestRenderer.act(async () => {
      nav({ name: 'locked' });
      await flush();
    });
    expect(
      tree.root.findAllByProps({ testID: 'lock-screen' }).length,
    ).toBeGreaterThan(0);

    const pause = jest.spyOn(messaging, 'pause');
    const sync = jest.spyOn(badge, 'syncBadge').mockResolvedValue(undefined);
    await ReactTestRenderer.act(async () => {
      await calling.callController().hangup();
      await flush();
    });
    expect(calling.callController().state.name).toBe('idle');
    // THE INVARIANT: the call's end revisits the keep-the-socket decision no
    // matter which route is showing. pause() itself self-guards on the token,
    // so calling it behind the lock is rule 14's own direction — never a dial.
    expect(pause).toHaveBeenCalled();
    // AND ONLY the socket decision goes unconditional: the badge sync reads
    // `db.unreadCounts` — conversation state — which the lock route must not
    // compute (clearBadge's contract). Behind the lock it stays unrun.
    expect(sync).not.toHaveBeenCalled();
    sync.mockRestore();
  } finally {
    delete (AppState as unknown as Record<string, unknown>).currentState;
  }
});

test('EVERY seam that stops messaging first ends a live 1:1 call (the disposeGroupCall scan, applied to its twin)', () => {
  // The group half of this rule is already encoded in call.wiring.test.ts:
  // every `messaging.stop();` must sit beside `disposeGroupCall()`. This is
  // the same scan for the 1:1 half — the codebase's signature defect is a fix
  // landing on one side of a twin, and these seams live in App.tsx and
  // registration.ts, which have no unit harness of their own.
  const fs = jest.requireActual<{
    readdirSync(
      path: string,
      opts: { withFileTypes: true },
    ): { name: string; isDirectory(): boolean }[];
    readFileSync(path: string, encoding: string): string;
  }>('fs');
  const testPath = expect.getState().testPath ?? '';
  const appDir = testPath.slice(0, testPath.lastIndexOf('/__tests__/'));
  const files: string[] = [`${appDir}/App.tsx`];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name)) files.push(full);
    }
  };
  walk(`${appDir}/src`);

  const offenders: string[] = [];
  for (const file of files) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((text, i) => {
      // A STATEMENT, not a mention: a comment line cannot match this.
      if (!/^\s*messaging\.stop\(\);\s*$/.test(text)) return;
      // BEFORE the stop, because the end frame has to be composed while the
      // transport still accepts it (disposeGroupCall's window looks after).
      const window = lines.slice(Math.max(0, i - 12), i + 1).join('\n');
      if (!window.includes('endCallOnQuiesce()')) {
        offenders.push(`${file}:${i + 1}`);
      }
    });
  }
  expect(offenders).toEqual([]);
  // And the scan is not vacuous: those seams exist.
  expect(
    files.filter(f => /^\s*messaging\.stop\(\);\s*$/m.test(fs.readFileSync(f, 'utf8'))).length,
  ).toBeGreaterThanOrEqual(2);
});

test('backgrounding during a live GROUP session keeps the socket; the session ending while backgrounded pauses it', async () => {
  // The backgrounding handler consulted the 1:1 machine only: a live
  // small-group session — N legs on the same socket — was paused under,
  // and every ICE restart, hangup, gleave and call.end stopped until the
  // 30 s reconnect window expired. The post-call pause had the same blind
  // spot in the other direction: nothing revisited the decision when the
  // SESSION ended while backgrounded. Mutations caught: restore the bare
  // `callRef.current.name === 'idle'` at the backgrounding site (the first
  // expectation fails); drop the `groupSessionKey` effect (the last does).
  const SELF = '01HQ5E1F00000000000000000A';
  const tree = await renderApp();
  for (const key of ['1', '2', '3', '4', '5', '6']) {
    await press(tree, `pin-key-${key}`);
  }
  await press(tree, 'pin-submit');
  await ReactTestRenderer.act(flush);

  // A live group session through the REAL coordinator and wiring: this
  // device starts a call to PEER. The transport and the block checks are
  // spied exactly as call.wiring.test.ts spies them.
  jest.spyOn(messaging, 'sendGroupCallEnvelope').mockResolvedValue(undefined);
  jest.spyOn(messaging, 'isBlockedLocally').mockReturnValue(false);
  jest.spyOn(messaging, 'isPeerBlocked').mockReturnValue(false);
  calling.setSelfAccountId(SELF);
  await ReactTestRenderer.act(async () => {
    await calling.startGroupCall([PEER], false);
    await calling.groupCall().whenIdle();
    await flush();
  });
  expect(calling.groupCallView()).not.toBeNull();
  expect(calling.callController().state.name).toBe('idle');

  const pause = jest.spyOn(messaging, 'pause');
  // Background with the session live: the socket is its signalling path.
  await transition('background');
  expect(pause).not.toHaveBeenCalled();

  // The session ends while still backgrounded: the skipped pause is taken.
  Object.defineProperty(AppState, 'currentState', {
    value: 'background',
    configurable: true,
  });
  try {
    await ReactTestRenderer.act(async () => {
      await calling.groupCall().hangup();
      await calling.groupCall().whenIdle();
      await flush();
    });
    expect(calling.groupCallView()).toBeNull();
    expect(pause).toHaveBeenCalled();
  } finally {
    delete (AppState as unknown as Record<string, unknown>).currentState;
    calling.setSelfAccountId(null);
  }
});
