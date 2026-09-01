jest.mock('../src/ws', () => {
  // FAITHFUL to the real client's teardown semantics — the same mock
  // inbox.drain.test.ts uses, and for the same reason: real `stop()` clears
  // the frame/state handlers and real `suspend()` keeps them, so a mock that
  // treats them alike hides a pause/resume cycle that leaves the socket deaf.
  const handlers: {
    frame?: (f: unknown) => void;
    state?: (s: string) => void;
  } = {};
  const state = { open: false };
  const calls = {
    start: jest.fn(),
    stop: jest.fn(),
    suspend: jest.fn(),
    send: jest.fn((_frame: unknown) => state.open),
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
      handlers.frame = undefined;
      handlers.state = undefined;
    }
    suspend() {
      calls.suspend();
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
  apiUploadKeys: jest.fn(),
  apiGetPrekeyBundle: jest.fn().mockResolvedValue({}),
  apiCreateAttachment: jest.fn(),
  apiGetAttachmentUrl: jest.fn(),
  uploadBlob: jest.fn(),
  downloadBlob: jest.fn(),
}));

import { Platform } from 'react-native';
import {
  applyDeviceIdle,
  deviceIsIdle,
  socketSurvivesBackground,
} from '../src/background';
import * as db from '../src/db';
import { messaging } from '../src/messaging';
import { session } from '../src/session';

/**
 * THE DOZE PAUSE POLICY, pinned where it can actually be attributed.
 *
 * The device leg in the device-verification harness forces the emulator into
 * deep idle, sends a probe, and proves the END-TO-END contract: nothing
 * user-visible is delivered while the device is idle, and the probe arrives on
 * wake. What that leg explicitly CANNOT do is say WHY the phone was silent —
 * Doze suspends an app's network access on its own, so the platform produces
 * exactly the same silence from an app that never pauses anything. A leg that
 * passes either way is not evidence about our policy.
 *
 * So the attribution lives here, and it is device-free because the policy is:
 * the platform publishes an idle transition, and the decision — pause the
 * socket, resume it on wake — is JavaScript. Both branches are pinned below,
 * together with the two guards that keep the edges honest and the platform
 * divergence that makes the whole design possible (backgrounding must NOT close
 * the socket on Android, or the foreground service would be holding up a
 * connection the app closes on its way out).
 */

interface FakeDb {
  name: string;
  execute: jest.Mock;
  close: jest.Mock;
}
const sqlite = (
  jest.requireMock('@op-engineering/op-sqlite') as {
    __sqlite: { instances: Map<string, FakeDb>; reset: () => void };
  }
).__sqlite;

const crypto = jest.requireMock('tacendum-crypto') as {
  __keychain: Map<string, string>;
  __sharedState: Map<string, string>;
  __inbox: Map<string, unknown>;
  hasSession: jest.Mock;
};

const ws = (
  jest.requireMock('../src/ws') as {
    __ws: {
      calls: { start: jest.Mock; stop: jest.Mock; suspend: jest.Mock };
      state: { open: boolean };
    };
  }
).__ws;

const ME = '01MEZ3NDEKTSV4RRFFQ69G5FAV';

async function settle(turns = 60): Promise<void> {
  for (let i = 0; i < turns; i++) await Promise.resolve();
}

/** `Platform.OS` is a plain property on RN's Platform object, so the test can
 * stand on either side of the divergence rather than describing one of them. */
function setPlatform(os: 'android' | 'ios'): void {
  Object.defineProperty(Platform, 'OS', { value: os, configurable: true });
}

const REAL_OS = Platform.OS;

beforeEach(async () => {
  setPlatform('android');
  messaging.stop();
  session.setMode('real');
  sqlite.reset();
  await db.close();
  db.setWorkspace('real');
  await db.initDb();
  crypto.__keychain.clear();
  crypto.__sharedState.clear();
  crypto.__inbox.clear();
  jest.clearAllMocks();
  crypto.__keychain.set('authToken', 'tok');
  crypto.hasSession.mockResolvedValue(true);
  ws.state.open = false;
});

afterEach(() => {
  messaging.stop();
  setPlatform(REAL_OS as 'android' | 'ios');
});

test('the idle signal pauses the socket, and the wake reopens it', async () => {
  await messaging.start(ME);
  await settle();
  jest.clearAllMocks();

  // THE IDLE HALF. The socket is told to pause, which is what makes "nothing
  // is delivered while idle" a property of this app rather than a property of
  // the platform's own network suspension.
  applyDeviceIdle(true);
  expect(ws.calls.suspend).toHaveBeenCalledTimes(1);
  expect(ws.calls.start).not.toHaveBeenCalled();
  expect(deviceIsIdle()).toBe(true);

  // THE WAKE HALF. `resume` drains the spool before it dials, so the dial
  // lands a few turns later.
  applyDeviceIdle(false);
  await settle();
  expect(ws.calls.start).toHaveBeenCalledTimes(1);
  expect(deviceIsIdle()).toBe(false);
});

test('while idle nothing re-dials: a repeated idle signal is not a second pause', async () => {
  await messaging.start(ME);
  await settle();
  jest.clearAllMocks();

  applyDeviceIdle(true);
  // The service republishes the current state whenever it starts, so a second
  // "idle" for the same idle is a normal event — and it must not re-suspend a
  // socket that is already suspended, nor dial one.
  applyDeviceIdle(true);
  await settle();
  expect(ws.calls.suspend).toHaveBeenCalledTimes(1);
  expect(ws.calls.start).not.toHaveBeenCalled();
});

test('a wake that follows no idle of ours dials nothing', async () => {
  await messaging.start(ME);
  await settle();
  jest.clearAllMocks();

  // The socket is up and the app never paused it. A stray "not idle" — the
  // state the service publishes on every start — must not be read as
  // permission to open a second one.
  applyDeviceIdle(false);
  await settle();
  expect(ws.calls.start).not.toHaveBeenCalled();
  expect(ws.calls.suspend).not.toHaveBeenCalled();
});

test('backgrounding does NOT close the socket on Android, but idle still does', async () => {
  await messaging.start(ME);
  await settle();
  jest.clearAllMocks();

  expect(socketSurvivesBackground()).toBe(true);
  // The foreground service exists to keep this socket up while the app is
  // away; a pause here would close the very connection it is holding open,
  // and background delivery would be impossible on a platform with no push.
  messaging.pause();
  expect(ws.calls.suspend).not.toHaveBeenCalled();

  // The divergence is scoped to that ONE signal: the device going to sleep
  // still takes the socket down.
  applyDeviceIdle(true);
  expect(ws.calls.suspend).toHaveBeenCalledTimes(1);
});

test('on iOS the same call still pauses — the branch is real, not vacuous', async () => {
  await messaging.start(ME);
  await settle();
  jest.clearAllMocks();

  setPlatform('ios');
  expect(socketSurvivesBackground()).toBe(false);
  messaging.pause();
  expect(ws.calls.suspend).toHaveBeenCalledTimes(1);
});

test('the policy is uninstalled with the session', async () => {
  await messaging.start(ME);
  await settle();

  messaging.stop();
  jest.clearAllMocks();

  // A relock ended the session. An idle transition that lands afterwards
  // belongs to nobody: pausing here would suspend whatever the NEXT workspace
  // has opened.
  applyDeviceIdle(true);
  await settle();
  expect(ws.calls.suspend).not.toHaveBeenCalled();
  expect(ws.calls.start).not.toHaveBeenCalled();
});
