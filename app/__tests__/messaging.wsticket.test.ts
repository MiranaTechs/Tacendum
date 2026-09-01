/**
 * The app's DOWNGRADE RULE for WebSocket tickets.
 *
 * A dial mints a single-use ticket over HTTPS and puts only that in the socket
 * URL, because the bearer it replaced is good for thirty days on every route
 * and a URL is written down by every proxy, access log and crash reporter that
 * handles it.
 *
 * Which leaves one question with a security answer: what happens when the mint
 * fails? The first implementation caught everything and returned null, which
 * dials with the bearer — so anyone able to break a single HTTPS request (a
 * 500, a 429, a WAF rule) restored the original defect on demand while the
 * socket host stayed perfectly reachable. A second version kept exactly one
 * downgrade — 404, for servers predating the route — until the transition
 * ended and the branch's only remaining caller was an attacker.
 *
 * NO failure may downgrade. This exercises the REAL `mintWsTicket` — the
 * third argument the service hands `ws.start` — rather than a stand-in for
 * it, because the previous tests injected `null` or a throw directly and so
 * asserted the socket's half of the contract while proving nothing about the
 * half that decides what becomes a `null`.
 */

jest.mock('../src/ws', () => {
  const calls = {
    start: jest.fn((_token: string, _check?: unknown, _mint?: unknown) => undefined),
    stop: jest.fn(),
    suspend: jest.fn(),
    send: jest.fn((_frame: unknown) => true),
    adoptToken: jest.fn((_token: string) => undefined),
  };
  class WsClient {
    onFrame(_cb: (f: unknown) => void) {}
    onState(_cb: (s: string) => void) {}
    start(token: string, check?: unknown, mint?: unknown) {
      calls.start(token, check, mint);
    }
    suspend() {
      calls.suspend();
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

// The factory does NOT re-export ApiRequestError, and does not need to:
// `messaging.ts` imports it as `type ApiRequestError`, which is erased, and the
// rule under test recognises the error by `name` and `status` rather than by
// `instanceof` — deliberately, so a module mock that omits the class cannot
// turn the check itself into a TypeError thrown from inside a catch block.
// Errors are built by `apiError` below, outside any factory, where babel's
// jest-hoist scan cannot mistake a parameter name for an out-of-scope variable.
jest.mock('../src/api', () => {
  return {
    apiWsTicket: jest.fn().mockRejectedValue(new Error('not configured in test')),
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
  };
});

jest.mock('../src/reauth', () => ({
  AUTH_TOKEN_KEY: 'authToken',
  probeAndHeal: jest.fn(async () => ({ verdict: 'blip' })),
  reauthenticate: jest.fn(async () => 'error'),
  currentToken: jest.fn(async () => null),
  accountGone: () => false,
  onAccountGone: () => () => undefined,
  subscribeToken: jest.fn(() => () => undefined),
}));

import * as db from '../src/db';
import { AUTH_TOKEN_KEY, messaging } from '../src/messaging';
import { session } from '../src/session';

const SELF = '01KYDBSSDJSPC9J0E5N2AWMJ5Y';

const sqlite = (
  jest.requireMock('@op-engineering/op-sqlite') as { __sqlite: { reset: () => void } }
).__sqlite;
const crypto = jest.requireMock('tacendum-crypto') as { __keychain: Map<string, string> };
const ws = (
  jest.requireMock('../src/ws') as { __ws: { calls: { start: jest.Mock } } }
).__ws;
const api = jest.requireMock('../src/api') as { apiWsTicket: jest.Mock };

/**
 * An error shaped exactly like the real `ApiRequestError`.
 *
 * The shape still matters even though no status downgrades any more: the 404
 * case below is the regression tripwire for anyone reintroducing an
 * `isNotFound` branch, and it only trips if the error it feeds in is one that
 * branch would actually match — `name` AND `status`, exactly as the real
 * class sets them.
 */
const apiError = (message: string, status: number): Error =>
  Object.assign(new Error(message), { name: 'ApiRequestError', status });

/** The minter the service actually handed the socket. */
function minter(): () => Promise<string | null> {
  const call = ws.calls.start.mock.calls[ws.calls.start.mock.calls.length - 1]!;
  return call[2] as () => Promise<string | null>;
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
  api.apiWsTicket.mockReset();
});

afterEach(async () => {
  messaging.stop();
  await db.close();
});

test('the service hands the socket a minter at all', async () => {
  // Guards every assertion below: if the third argument stops being passed,
  // `minter()` would be undefined and the rest would fail confusingly rather
  // than pointing at the wiring.
  await messaging.start(SELF);
  expect(typeof minter()).toBe('function');
});

test('a minted ticket is returned, and the bearer is what mints it', async () => {
  api.apiWsTicket.mockResolvedValue('tkt-live');
  await messaging.start(SELF);

  await expect(minter()()).resolves.toBe('tkt-live');
  expect(api.apiWsTicket).toHaveBeenCalledWith('stale-token');
});

test('RESUME hands over a minter too, not just the initial start', async () => {
  /*
   * There are two `ws.start` call sites — the initial start, and resume() after
   * the phone comes back from the background. Only the first was covered, and
   * `WsClient.start` REPLACES the minter it holds: dropping the argument from
   * the resume site alone would leave every existing test green while every
   * dial after the first backgrounding went out carrying `?token=` again.
   *
   * That is the whole failure mode of this change in miniature — a path that
   * works until an ordinary lifecycle event, with nothing watching.
   */
  api.apiWsTicket.mockResolvedValue('tkt-after-resume');
  await messaging.start(SELF);

  messaging.pause();
  await messaging.resume();

  // The LAST start is the resume one, and it must carry a working minter.
  expect(ws.calls.start).toHaveBeenCalledTimes(2);
  await expect(minter()()).resolves.toBe('tkt-after-resume');
});

test('404 fails closed too: the transitional downgrade is gone', async () => {
  // This used to be the ONE failure that downgraded, for servers predating
  // the /v1/ws-ticket route. The transition ended: production answers 401
  // for a bad bearer and mints for a good one — it never 404s — so the only
  // thing the branch could still do was hand anyone who can induce a 404
  // (a proxy, a WAF rule, a captive portal) the bearer-in-the-URL defect
  // this whole design removes. A 404 now throws like every other failure,
  // and the dial retries instead of downgrading.
  api.apiWsTicket.mockRejectedValue(apiError('no such route', 404));
  await messaging.start(SELF);

  await expect(minter()()).rejects.toThrow();
});

describe('every other failure fails CLOSED rather than downgrading', () => {
  // Each of these is inducible by someone who can interfere with one HTTPS
  // request while leaving the socket endpoint reachable. Returning null for any
  // of them puts a thirty-day credential into a logged URL — a worse outcome
  // than a failed dial, which simply retries.
  for (const status of [400, 401, 403, 429, 500, 502, 503]) {
    test(`${status} throws`, async () => {
      api.apiWsTicket.mockRejectedValue(apiError(`failed ${status}`, status));
      await messaging.start(SELF);

      await expect(minter()()).rejects.toThrow();
    });
  }

  test('a transport failure with no status throws', async () => {
    // `fetch` rejects with a TypeError for DNS/refused/TLS. It carries no
    // status, so a rule written as "status !== 404" rather than "is a 404"
    // would treat it as benign and downgrade.
    api.apiWsTicket.mockRejectedValue(new TypeError('Network request failed'));
    await messaging.start(SELF);

    await expect(minter()()).rejects.toThrow();
  });

  test('an error that merely LOOKS like a 404 does not downgrade', async () => {
    // Matched on name AND status. A foreign error carrying a 404 field is not
    // an ApiRequestError and must not be treated as one.
    const impostor = Object.assign(new Error('404 somewhere'), { status: 404 });
    api.apiWsTicket.mockRejectedValue(impostor);
    await messaging.start(SELF);

    await expect(minter()()).rejects.toThrow();
  });
});

test('a relock between capture and mint mints nothing at all', async () => {
  /*
   * `mintWsTicket` reads `this.token` at CALL time, and stop() nulls it. The
   * minter is handed to the socket once and invoked later — on every reconnect
   * — so the interesting moment is a relock that lands in between.
   *
   * Rules 13/14 say a stopped service must not hold a live bearer, and rule 15
   * says a duress session's socket reaches nothing. Returning null here is what
   * makes that true of the mint as well as of the dial: a stopped service must
   * not go on minting credentials against the account that just locked.
   */
  api.apiWsTicket.mockResolvedValue('tkt-should-not-happen');
  await messaging.start(SELF);
  const mint = minter();

  messaging.stop();

  await expect(mint()).resolves.toBeNull();
  // …and it never asked the server, because there was nothing to ask with.
  expect(api.apiWsTicket).not.toHaveBeenCalled();
});
