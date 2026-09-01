/**
 * The REST seam: 401 → single-flight re-auth → retry once.
 *
 * Driven through the REAL `request()` against a scripted fetch, because the
 * behaviour under test is a property of the transport, not of any one route:
 * every authenticated call in the app inherits it without knowing the word,
 * and the only way to show that is to make the transport answer 401 and watch
 * what leaves the phone.
 *
 * The whole conversation is asserted as an ordered list of requests. A count
 * would hide the two orderings that matter — that the renewal happens BEFORE
 * the retry, and that the retry carries the NEW bearer.
 */

// The profile read that would refuse a userId that moved. Null here: these
// tests are about the transport, and a real db would answer from whichever
// workspace an earlier suite left open.
jest.mock('../src/db', () => ({ loadProfile: jest.fn(async () => null) }));

import { API_BASE } from '../src/config';

type Api = typeof import('../src/api');
type Reauth = typeof import('../src/reauth');

const USER_ID = '01KYDBSSDJSPC9J0E5N2AWMJ5Y';
const IDENTITY_KEY = 'BQ0IDENTITYKEYBASE64';
const CHALLENGE = 'Q0hBTExFTkdF';
const STALE = 'stale-token';
const BUNDLE_ID = 'com.miranatechnologies.tacendum';

interface Wire {
  method: string;
  path: string;
  bearer?: string;
}

let api: Api;
let reauth: Reauth;
let crypto: {
  __keychain: Map<string, string>;
  identityPublicKey: jest.Mock;
  signAuthChallenge: jest.Mock;
};
/** Every request that actually left, in order. */
let wire: Wire[];
/** What the fake server answers, per request. */
let reply: (req: Wire) => { status: number; body?: unknown };
let minted: number;

function json(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/** 401 as the server actually shapes it (`handlers/auth.ts`). */
function unauthorized(): { status: number; body: unknown } {
  return {
    status: 401,
    body: {
      error: { code: 'unauthorized', detail: 'missing or invalid bearer token' },
    },
  };
}

beforeEach(() => {
  jest.resetModules();
  crypto = jest.requireMock('tacendum-crypto');
  reauth = jest.requireActual('../src/reauth') as Reauth;
  api = jest.requireActual('../src/api') as Api;

  wire = [];
  minted = 0;
  crypto.__keychain.clear();
  crypto.__keychain.set(reauth.AUTH_TOKEN_KEY, STALE);
  crypto.identityPublicKey.mockResolvedValue(IDENTITY_KEY);

  // The default server: a 30-day-old session. Everything authenticated is
  // refused; the two auth routes work, because the identity key still does.
  reply = req => {
    if (req.path === '/v1/auth/challenge') {
      return { status: 200, body: { challenge: CHALLENGE, expiresAt: 0 } };
    }
    if (req.path === '/v1/auth') {
      return { status: 200, body: { userId: USER_ID, authToken: `fresh-${++minted}` } };
    }
    return req.bearer && req.bearer.startsWith('fresh-')
      ? { status: 200, body: {} }
      : unauthorized();
  };

  (globalThis as unknown as { fetch: unknown }).fetch = jest.fn(
    async (url: string, init: { method: string; headers?: Record<string, string> }) => {
      const req: Wire = {
        method: init.method,
        path: String(url).slice(API_BASE.length),
        bearer: init.headers?.authorization?.replace('Bearer ', ''),
      };
      wire.push(req);
      const answer = reply(req);
      return json(answer.status, answer.body ?? {});
    },
  );
});

test('a 401 renews and retries the same request once, with the new bearer', async () => {
  await api.apiRegisterPushToken(STALE, BUNDLE_ID, 'aabb');

  expect(wire).toEqual([
    // The call that hit the cliff…
    { method: 'PUT', path: '/v1/push-token', bearer: STALE },
    // …the renewal, off the identity key already in the Keychain…
    { method: 'POST', path: '/v1/auth/challenge', bearer: undefined },
    { method: 'POST', path: '/v1/auth', bearer: undefined },
    // …and the same call again, on the token that now exists. The caller —
    // `uploadPushTokens`, in this case — never learns any of it happened.
    { method: 'PUT', path: '/v1/push-token', bearer: 'fresh-1' },
  ]);
  expect(crypto.__keychain.get(reauth.AUTH_TOKEN_KEY)).toBe('fresh-1');
});

test('four calls that 401 together produce exactly one POST /v1/auth', async () => {
  // Day 31 of an install is not one request failing. It is the prekey fetch,
  // the attachment download, the push registration and the profile card all
  // discovering it at once — and since every auth revokes the previous
  // session, four mints would leave three of these holding dead tokens.
  await Promise.all([
    api.apiRegisterPushToken(STALE, BUNDLE_ID, 'aabb'),
    api.apiDeleteAccount(STALE).catch(() => undefined),
    api.apiRegisterPushToken(STALE, BUNDLE_ID, 'ccdd'),
    api.apiRegisterPushToken(STALE, BUNDLE_ID, 'eeff'),
  ]);

  expect(wire.filter(r => r.path === '/v1/auth')).toHaveLength(1);
  expect(wire.filter(r => r.path === '/v1/auth/challenge')).toHaveLength(1);
  // Every one of them retried, and every retry carried the ONE new token.
  const retries = wire.filter(r => r.bearer?.startsWith('fresh-'));
  expect(retries).toHaveLength(4);
  expect(new Set(retries.map(r => r.bearer))).toEqual(new Set(['fresh-1']));
});

test('a second 401 on a fresh token is surfaced, not looped on', async () => {
  reply = req => {
    if (req.path === '/v1/auth/challenge') {
      return { status: 200, body: { challenge: CHALLENGE, expiresAt: 0 } };
    }
    if (req.path === '/v1/auth') {
      return { status: 200, body: { userId: USER_ID, authToken: `fresh-${++minted}` } };
    }
    return unauthorized(); // even the freshly minted token is refused
  };

  await expect(api.apiRegisterPushToken(STALE, BUNDLE_ID, 'aabb')).rejects.toMatchObject({
    name: 'ApiRequestError',
    status: 401,
  });

  // Twice, never three times. A second 401 seconds after a signed challenge is
  // a server-side truth (revoked, deleted, clock skew); looping on it turns a
  // dead session into a self-inflicted DoS on our own auth route.
  expect(wire.filter(r => r.path === '/v1/push-token')).toHaveLength(2);
  expect(wire.filter(r => r.path === '/v1/auth')).toHaveLength(1);
});

test('a tombstoned identity stops: the call fails and nothing tries again', async () => {
  reply = req => {
    if (req.path === '/v1/auth/challenge') {
      return { status: 200, body: { challenge: CHALLENGE, expiresAt: 0 } };
    }
    if (req.path === '/v1/auth') {
      return {
        status: 403,
        body: {
          error: {
            code: 'identity_tombstoned',
            detail: 'this identity key has been revoked',
          },
        },
      };
    }
    return unauthorized();
  };

  await expect(api.apiRegisterPushToken(STALE, BUNDLE_ID, 'aabb')).rejects.toMatchObject({
    status: 401,
  });
  expect(reauth.accountGone()).toBe(true);

  // The next call still fails — but it does not go near the auth route, which
  // is the difference between a dead account and a hammer.
  wire.length = 0;
  await expect(api.apiRegisterPushToken(STALE, BUNDLE_ID, 'aabb')).rejects.toMatchObject({
    status: 401,
  });
  expect(wire).toEqual([{ method: 'PUT', path: '/v1/push-token', bearer: STALE }]);
});

test('the WS probe reads the 401 instead of healing it', async () => {
  // The probe is asking whether THIS bearer is alive. Healing it underneath
  // the socket would hand back 200 while the socket still holds the dead
  // token — the socket would then reconnect with it and be refused again.
  expect(await api.apiProbeSession(STALE)).toBe(401);

  expect(wire).toEqual([{ method: 'GET', path: '/v1/me', bearer: STALE }]);
  expect(crypto.__keychain.get(reauth.AUTH_TOKEN_KEY)).toBe(STALE);
});

test('an unauthenticated route never triggers a renewal', async () => {
  // `apiAuth` itself answers 401 for a stale challenge. If that could recurse
  // into re-auth, a bad clock would become an unbounded auth loop.
  reply = () => unauthorized();

  await expect(api.apiAuthChallenge(IDENTITY_KEY)).rejects.toMatchObject({ status: 401 });

  expect(wire).toEqual([
    { method: 'POST', path: '/v1/auth/challenge', bearer: undefined },
  ]);
});

test.each([403, 429, 500])('the probe reports a %i answer as an answer, not a failure', async status => {
  // "The server answered" was once implemented as "returned 401": every other
  // error status threw, and the socket classified the throw as UNANSWERED and
  // refunded its probe. So a 403 from a WAF rule, a 429 from our own rate
  // limiter, a 502 from a cold gateway — the statuses a struggling deployment
  // actually produces — each bought the socket another probe against the route
  // that was already struggling. None of them says the bearer is dead; all of
  // them prove the server was reached, which is the only question the caller
  // asked. The status comes back as a value, and the socket spends its probe.
  reply = req =>
    req.path === '/v1/me'
      ? { status, body: { error: { code: 'upstream', detail: 'not about the bearer' } } }
      : unauthorized();

  expect(await api.apiProbeSession(STALE)).toBe(status);

  // Still a diagnosis, never a treatment: one request, no renewal, the
  // Keychain untouched.
  expect(wire).toEqual([{ method: 'GET', path: '/v1/me', bearer: STALE }]);
  expect(crypto.__keychain.get(reauth.AUTH_TOKEN_KEY)).toBe(STALE);
});

test('the probe still propagates a genuine transport failure', async () => {
  // The one case that IS unanswered: the request never produced a response at
  // all. This must keep throwing, because the throw is the socket's refund
  // signal (ws.ts, `WsAuthOutcome.conclusive`) — flattening it into a status
  // would make a subway tunnel look like a server that answered, and the
  // episode's probe would be spent on a question nobody heard.
  reply = () => {
    throw new TypeError('Network request failed');
  };

  await expect(api.apiProbeSession(STALE)).rejects.toThrow('Network request failed');

  // The attempt happened — the failure is the transport's, not a refusal.
  expect(wire).toEqual([{ method: 'GET', path: '/v1/me', bearer: STALE }]);
});

test('a duress session sends nothing at all, through any route', async () => {
  // the duress rule at the transport boundary: "Duress sessions are
  // network-silent. No socket, no REST call, no push registration."
  //
  // Every caller had its own guard, and two did not: `uploadPushTokens` and the
  // TURN fetch are mounted for the app's whole lifetime and reached `request()`
  // without ever consulting the mode, so a coerced phone emitted
  // `PUT /v1/push-token` at startup and on every APNs rotation. Guarding here
  // is what makes the rule true for all ten callers instead of the eight that
  // remembered.
  const session = (jest.requireActual('../src/session') as typeof import('../src/session'))
    .session;
  session.setMode('duress');

  await expect(api.apiGetPrekeyBundle(STALE, USER_ID)).rejects.toThrow(
    'Network request failed',
  );
  await expect(
    api.apiRegisterPushToken(STALE, BUNDLE_ID, 'voip-token', 'sandbox'),
  ).rejects.toThrow('Network request failed');
  await expect(api.apiCreateAttachment(STALE, 10)).rejects.toThrow('Network request failed');

  // Not one packet, and no renewal either — a coerced session must not even
  // discover whether its own bearer is still good.
  expect(wire).toEqual([]);
  expect(crypto.__keychain.get(reauth.AUTH_TOKEN_KEY)).toBe(STALE);

  session.setMode('real');
});

test('the duress refusal is indistinguishable from being offline', async () => {
  const session = (jest.requireActual('../src/session') as typeof import('../src/session'))
    .session;
  session.setMode('duress');

  // The shape is load-bearing twice over. A `TypeError('Network request
  // failed')` is precisely what RN's fetch throws with no network, so no caller
  // and no screen can tell a guarded session from a phone in a tunnel — which
  // is the entire cover story.
  await expect(api.apiGetPrekeyBundle(STALE, USER_ID)).rejects.toBeInstanceOf(TypeError);

  // And it must NOT be an ApiRequestError, which is the trap: `apiProbeSession`
  // turns one of those into a status, so the socket would read a coerced
  // session as proof of a LIVE credential and spend its probe on it. Here the
  // throw propagates, which is the refund signal.
  await expect(api.apiProbeSession(STALE)).rejects.toThrow('Network request failed');
  await expect(api.apiProbeSession(STALE)).rejects.toBeInstanceOf(TypeError);

  expect(wire).toEqual([]);
  session.setMode('real');
});
