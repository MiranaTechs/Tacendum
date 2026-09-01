/**
 * The wiring: messaging is what puts the socket's auth check
 * and the token cache in place. Without these three lines the whole WebSocket
 * seam is dead code that no shipped build ever reaches — the failure mode a
 * unit test of `ws.ts` alone cannot see.
 *
 * The second half matters just as much and is easier to miss: this service
 * keeps its OWN copy of the bearer for every REST call it makes (prekey
 * fetches, attachment uploads and downloads, profile cards). A renewal that
 * updated only the Keychain would leave each of those presenting a revoked
 * token, 401ing, being rescued by the stale-bearer check, and paying a wasted
 * round trip — forever, because nothing would ever refresh the copy.
 */

jest.mock('../src/ws', () => {
  const calls = {
    start: jest.fn((_token: string, _check?: unknown) => undefined),
    stop: jest.fn(),
    send: jest.fn((_frame: unknown) => true),
    adoptToken: jest.fn((_token: string) => undefined),
  };
  class WsClient {
    onFrame(_cb: (f: unknown) => void) {}
    onState(_cb: (s: string) => void) {}
    start(token: string, check?: unknown) {
      calls.start(token, check);
    }
    adoptToken(token: string) {
      calls.adoptToken(token);
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

jest.mock('../src/api', () => ({
  apiAuthChallenge: jest.fn().mockRejectedValue(new Error('network in test')),
  apiAuth: jest.fn().mockRejectedValue(new Error('network in test')),
  apiUploadKeys: jest.fn().mockRejectedValue(new Error('network in test')),
  apiGetPrekeyBundle: jest.fn().mockRejectedValue(new Error('network in test')),
  apiDeleteAccount: jest.fn().mockRejectedValue(new Error('network in test')),
  apiCreateAttachment: jest.fn().mockRejectedValue(new Error('network in test')),
  apiGetAttachmentUrl: jest.fn().mockRejectedValue(new Error('network in test')),
  apiProbeSession: jest.fn().mockRejectedValue(new Error('network in test')),
  uploadBlob: jest.fn().mockRejectedValue(new Error('network in test')),
  downloadBlob: jest.fn().mockRejectedValue(new Error('network in test')),
}));

// The `(token: string) => void` annotations a reader would expect inside this
// factory are absent on purpose: babel-plugin-jest-hoist parses the factory
// body for out-of-scope references and reads a generic's parameter name as one
// ("Invalid variable access: token"). Types are recovered at the use sites.
jest.mock('../src/reauth', () => {
  const tokenListeners = new Set<Function>();
  const unsubscribe = jest.fn(() => undefined);
  return {
    AUTH_TOKEN_KEY: 'authToken',
    probeAndHeal: jest.fn(async () => ({ verdict: 'blip' })),
    reauthenticate: jest.fn(async () => 'error'),
    currentToken: jest.fn(async () => null),
    accountGone: () => false,
    onAccountGone: () => () => undefined,
    // The returned function DEREGISTERS, as the real one does. A stub that
    // only counted calls would let this suite pass while a token delivered
    // after stop() still reached a quiesced service — the mock would be
    // asserting about itself.
    subscribeToken: jest.fn(listener => {
      tokenListeners.add(listener);
      return () => {
        unsubscribe();
        tokenListeners.delete(listener);
      };
    }),
    __reauth: {
      unsubscribe,
      emitToken(next: string) {
        for (const listener of tokenListeners) listener(next);
      },
      reset() {
        tokenListeners.clear();
        unsubscribe.mockClear();
      },
    },
  };
});

import * as db from '../src/db';
import { AUTH_TOKEN_KEY, messaging } from '../src/messaging';
import { session } from '../src/session';

const SELF = '01KYDBSSDJSPC9J0E5N2AWMJ5Y';

const sqlite = (
  jest.requireMock('@op-engineering/op-sqlite') as {
    __sqlite: { reset: () => void };
  }
).__sqlite;
const crypto = jest.requireMock('tacendum-crypto') as {
  __keychain: Map<string, string>;
};
const ws = (
  jest.requireMock('../src/ws') as {
    __ws: { calls: { start: jest.Mock; stop: jest.Mock; adoptToken: jest.Mock } };
  }
).__ws;
const reauth = jest.requireMock('../src/reauth') as {
  probeAndHeal: jest.Mock;
  subscribeToken: jest.Mock;
  __reauth: {
    unsubscribe: jest.Mock;
    emitToken: (token: string) => void;
    reset: () => void;
  };
};

/** The check the client would call on a close it could not explain. */
function authCheck(): () => Promise<unknown> {
  const [, check] = ws.calls.start.mock.calls[ws.calls.start.mock.calls.length - 1]!;
  return check as () => Promise<unknown>;
}

beforeEach(async () => {
  messaging.stop();
  await db.close();
  db.setWorkspace('real');
  session.setMode('real');
  crypto.__keychain.clear();
  crypto.__keychain.set(AUTH_TOKEN_KEY, 'stale-token');
  sqlite.reset();
  ws.calls.start.mockClear();
  ws.calls.stop.mockClear();
  ws.calls.adoptToken.mockClear();
  reauth.probeAndHeal.mockClear();
  reauth.subscribeToken.mockClear();
  reauth.__reauth.reset();
});

afterEach(async () => {
  messaging.stop();
  await db.close();
});

test('start() hands the socket a check bound to the live bearer', async () => {
  await messaging.start(SELF);

  const [token, check] = ws.calls.start.mock.calls[0]!;
  expect(token).toBe('stale-token');
  expect(typeof check).toBe('function');

  await authCheck()();
  // Read at call time, not captured at start: whatever the current bearer is
  // when the socket falls over is what gets probed.
  expect(reauth.probeAndHeal).toHaveBeenCalledWith('stale-token');
});

test('a renewal reaches the REST bearer this service caches', async () => {
  await messaging.start(SELF);

  reauth.__reauth.emitToken('fresh-1');
  await authCheck()();

  expect(reauth.probeAndHeal).toHaveBeenLastCalledWith('fresh-1');
});

test('a renewal reaches the SOCKET too, not only this service', async () => {
  await messaging.start(SELF);

  reauth.__reauth.emitToken('fresh-1');

  // The hole: with only the line above under test,
  // deleting `this.ws.adoptToken(next)` from messaging.start() left every suite
  // green while the socket went on dialling a bearer `POST /v1/auth` had
  // revoked. The REST cache and the socket cache are two halves of one
  // credential, and nothing else in the app pins the second half.
  expect(ws.calls.adoptToken).toHaveBeenCalledWith('fresh-1');
});

test('a renewal after stop() reaches neither cache', async () => {
  await messaging.start(SELF);
  messaging.stop();

  reauth.__reauth.emitToken('fresh-after-stop');

  // Same rule as the REST bearer below: a stopped service holds no live
  // credential, and handing one to the socket would be the rules 13/14
  // violation by a different door.
  expect(ws.calls.adoptToken).not.toHaveBeenCalled();
});

test('a token delivered after stop() never re-arms the service', async () => {
  await messaging.start(SELF);
  expect(reauth.subscribeToken).toHaveBeenCalledTimes(1);
  const check = authCheck();

  messaging.stop();
  reauth.__reauth.emitToken('fresh-after-stop');

  // A renewal that lands after a relock must not put a live bearer back into a
  // quiesced service — that is precisely the shape the quiesce rules
  // forbid, and it is why the unsubscribe runs in stop() rather than being
  // left to the next start() to tidy up.
  await check();
  expect(reauth.probeAndHeal).toHaveBeenLastCalledWith(null);
  expect(reauth.__reauth.unsubscribe).toHaveBeenCalledTimes(1);
});
