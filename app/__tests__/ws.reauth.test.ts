/**
 * The WebSocket seam, asserted through the REAL `ws.ts` state
 * machine and the REAL `reauth.ts` — only the socket and the network are fakes.
 *
 * Mocking the client would have been easier and would have proved nothing: the
 * bug this replaces lives in the state machine itself. `onclose` took no
 * parameter, so the close code was discarded one line before it was usable,
 * and every refusal became an ordinary backoff. On AWS that meant a dead token
 * re-dialled a 403 forever behind a chat list reading "Offline"; on the local
 * adapter — where the upgrade COMPLETES and a 4001 close follows — `onopen`
 * reset the backoff first, producing a one-second hot loop that re-sent the
 * whole outbox each cycle and burned its ten-attempt budget in about ten
 * seconds.
 *
 * Both hosts are exercised, because they fail differently and the client has
 * to survive both without knowing which one it is talking to.
 */

jest.mock('../src/db', () => ({ loadProfile: jest.fn(async () => null) }));

import { API_BASE } from '../src/config';

type Ws = typeof import('../src/ws');
type Reauth = typeof import('../src/reauth');

const USER_ID = '01KYDBSSDJSPC9J0E5N2AWMJ5Y';
const IDENTITY_KEY = 'BQ0IDENTITYKEYBASE64';
const CHALLENGE = 'Q0hBTExFTkdF';
const STALE = 'stale-token';

type Handler = (event?: unknown) => void;

/** RN's WebSocket, minus the network. `fail()` is how each host refuses. */
class FakeSocket {
  static OPEN = 1;
  static instances: FakeSocket[] = [];
  onopen: Handler | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: Handler | null = null;
  onclose: ((event?: { code?: number; reason?: string }) => void) | null = null;
  readyState = 0;
  /** When this dial happened, on the fake-timer clock. The backoff test reads
   * the gaps between consecutive dials — the delay itself, not a count, is
   * what distinguishes exponential backoff from a hot loop. */
  createdAt = Date.now();
  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }
  close() {
    this.readyState = 3;
  }
  send(_data: string) {}

  /** The upgrade succeeded. */
  open() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }
  /** AWS: the authorizer denied, so the upgrade was refused with 403 and RN
   * reports 1006 with the response text — no open ever happened. */
  refusedUpgrade() {
    this.readyState = 3;
    this.onclose?.({ code: 1006, reason: 'received bad response code from server 403' });
  }
  /** Local adapter: the upgrade completed, $connect authenticated, and only
   * then did the server close 4001. */
  closedUnauthorized() {
    this.open();
    this.readyState = 3;
    this.onclose?.({ code: 4001, reason: 'unauthorized' });
  }
  /** An ordinary drop: no code worth reading. */
  dropped() {
    this.readyState = 3;
    this.onclose?.({ code: 1006, reason: 'network went away' });
  }
}
(globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeSocket;

interface Wire {
  method: string;
  path: string;
  bearer?: string;
}

let ws: Ws;
let reauth: Reauth;
let crypto: {
  __keychain: Map<string, string>;
  identityPublicKey: jest.Mock;
};
let wire: Wire[];
let probeStatus: number;
let authReply: { status: number; body: unknown };
let minted: number;
/** The device has no network at all — every request fails to reach anyone. */
let offline: boolean;

/** Drain the microtask queue. The whole probe → mint → reconnect chain is
 * promises, so this is what "the decision has been made" looks like. */
async function settle(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

function lastSocket(): FakeSocket {
  return FakeSocket.instances[FakeSocket.instances.length - 1]!;
}

/** Mirrors how messaging wires the two together: the check reads the CURRENT
 * bearer at call time, and the token subscription keeps that bearer in step
 * with the Keychain. */
function startClient(): InstanceType<Ws['WsClient']> {
  const client = new ws.WsClient();
  let bearer = STALE;
  reauth.subscribeToken(next => {
    bearer = next;
    // The socket's own copy, exactly as messaging.ts does it. Leaving this out
    // is the bug the last two tests in this file exist to hold down.
    client.adoptToken(next);
  });
  client.start(bearer, () => reauth.probeAndHeal(bearer));
  return client;
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.resetModules();
  crypto = jest.requireMock('tacendum-crypto');
  reauth = jest.requireActual('../src/reauth') as Reauth;
  ws = jest.requireActual('../src/ws') as Ws;

  FakeSocket.instances.length = 0;
  wire = [];
  minted = 0;
  offline = false;
  probeStatus = 401;
  authReply = { status: 200, body: {} };
  crypto.__keychain.clear();
  crypto.__keychain.set(reauth.AUTH_TOKEN_KEY, STALE);
  crypto.identityPublicKey.mockResolvedValue(IDENTITY_KEY);

  (globalThis as unknown as { fetch: unknown }).fetch = jest.fn(
    async (url: string, init: { method: string; headers?: Record<string, string> }) => {
      const path = String(url).slice(API_BASE.length);
      wire.push({
        method: init.method,
        path,
        bearer: init.headers?.authorization?.replace('Bearer ', ''),
      });
      // Recorded first, then thrown: the attempt is what the offline tests
      // assert on, and a request that never left the device still happened.
      if (offline) throw new TypeError('Network request failed');
      const answer =
        path === '/v1/me'
          ? { status: probeStatus, body: { userId: USER_ID } }
          : path === '/v1/auth/challenge'
            ? { status: 200, body: { challenge: CHALLENGE, expiresAt: 0 } }
            : path === '/v1/auth'
              ? {
                  status: authReply.status,
                  body:
                    authReply.status === 200
                      ? { userId: USER_ID, authToken: `fresh-${++minted}` }
                      : authReply.body,
                }
              : { status: 404, body: {} };
      return {
        ok: answer.status >= 200 && answer.status < 300,
        status: answer.status,
        json: async () => answer.body,
      } as unknown as Response;
    },
  );
});

afterEach(() => {
  jest.useRealTimers();
});

test('AWS: a refused upgrade probes, re-auths, and reconnects immediately', async () => {
  const client = startClient();
  expect(FakeSocket.instances).toHaveLength(1);
  expect(lastSocket().url).toContain(STALE);

  lastSocket().refusedUpgrade();
  await settle();

  // One cheap authenticated question, then the renewal, in that order.
  expect(wire.map(r => r.path)).toEqual([
    '/v1/me',
    '/v1/auth/challenge',
    '/v1/auth',
  ]);
  expect(wire[0]!.bearer).toBe(STALE);

  // Re-auth THEN reconnect (ordering note): `POST /v1/auth` revokes every
  // prior session, so a socket dialled before the mint is dead on arrival.
  expect(FakeSocket.instances).toHaveLength(2);
  expect(lastSocket().url).toContain('fresh-1');
  // And without waiting out a backoff — a refusal is not congestion. The chat
  // list is offline for one round trip, not for thirty seconds.
  //
  // The one armed timer is the new dial's WATCHDOG (ws.ts `armDialWatchdog`),
  // not a queued reconnect, and the advance below is what tells them apart: a
  // reauthed verdict resets the backoff to its 1 s base, so a queued reconnect
  // would have fired nineteen times inside this window and produced a third
  // socket. It produces none.
  expect(jest.getTimerCount()).toBe(1);
  await jest.advanceTimersByTimeAsync(19_000);
  expect(FakeSocket.instances).toHaveLength(2);

  client.stop();
});

test('local adapter: an open socket closed 4001 heals the same way', async () => {
  const states: string[] = [];
  const client = new ws.WsClient();
  client.onState(s => states.push(s));
  let bearer = STALE;
  reauth.subscribeToken(next => {
    bearer = next;
  });
  client.start(bearer, () => reauth.probeAndHeal(bearer));

  // The dev host opens FIRST and refuses a moment later, which is why "never
  // opened" cannot be the only trigger.
  lastSocket().closedUnauthorized();
  await settle();

  expect(wire.map(r => r.path)).toEqual([
    '/v1/me',
    '/v1/auth/challenge',
    '/v1/auth',
  ]);
  expect(FakeSocket.instances).toHaveLength(2);
  expect(lastSocket().url).toContain('fresh-1');
  // Exactly one re-dial — not the one-per-second loop the reset-on-open used
  // to produce against a revoked token.
  expect(states).toEqual(['connecting', 'open', 'closed', 'connecting']);

  client.stop();
});

test('a blip is left to the backoff, and is probed only once', async () => {
  probeStatus = 200; // the credential is fine; the network was not

  const client = startClient();
  lastSocket().dropped();
  await settle();

  // Probed, believed, nothing minted, no immediate re-dial.
  expect(wire.map(r => r.path)).toEqual(['/v1/me']);
  expect(FakeSocket.instances).toHaveLength(1);

  await jest.advanceTimersByTimeAsync(1000);
  expect(FakeSocket.instances).toHaveLength(2);
  expect(lastSocket().url).toContain(STALE); // same token: nothing was wrong with it

  // The second failure does NOT probe again. Once per failure episode, never
  // per retry, or the disambiguation becomes its own hammer on /v1/me.
  lastSocket().dropped();
  await settle();
  await jest.advanceTimersByTimeAsync(2000);
  expect(wire.map(r => r.path)).toEqual(['/v1/me']);
  expect(FakeSocket.instances).toHaveLength(3);

  client.stop();
});

test('a tombstoned account stops the socket for good', async () => {
  authReply = {
    status: 403,
    body: {
      error: { code: 'identity_tombstoned', detail: 'this identity key has been revoked' },
    },
  };

  const client = startClient();
  lastSocket().refusedUpgrade();
  await settle();

  expect(reauth.accountGone()).toBe(true);
  // No reconnect now…
  expect(FakeSocket.instances).toHaveLength(1);
  // …and none later. This is the state that used to reconnect forever: a
  // deleted account 401s every time, so a timer would have re-dialled a 403
  // every thirty seconds for as long as the app stayed open.
  await jest.advanceTimersByTimeAsync(5 * 60_000);
  expect(FakeSocket.instances).toHaveLength(1);
  expect(jest.getTimerCount()).toBe(0);

  client.stop();
});

test('stop() during a probe does not resurrect the socket', async () => {
  const client = startClient();
  lastSocket().refusedUpgrade();
  // A relock (or a sign-out) lands while the check is deciding.
  client.stop();
  await settle();

  // The renewal may have completed — it is a Keychain write, harmless — but
  // nothing dials. A stopped client that re-opened behind a lock screen is
  // precisely what the quiesce rules forbid.
  expect(FakeSocket.instances).toHaveLength(1);
  await jest.advanceTimersByTimeAsync(60_000);
  expect(FakeSocket.instances).toHaveLength(1);
});

test('a session that lived earns a fresh probe when it later expires', async () => {
  probeStatus = 200;
  const client = startClient();

  // Episode one: a blip. The probe budget for it is spent.
  lastSocket().refusedUpgrade();
  await settle();
  expect(wire.map(r => r.path)).toEqual(['/v1/me']);

  // A healthy connection follows, up for hours, and then the network goes
  // away. NOT interrogated: it opened and it lasted, so authorization is not
  // in question and a probe here would be the hammer the rule forbids.
  await jest.advanceTimersByTimeAsync(1000);
  lastSocket().open();
  jest.setSystemTime(Date.now() + 3 * 60 * 60_000);
  lastSocket().dropped();
  await settle();
  expect(wire.map(r => r.path)).toEqual(['/v1/me']);

  // …but it did buy back the budget, and this is the episode that needs it:
  // an app running since before the token died, refused on the next dial. A
  // one-probe-per-process rule would strand exactly this session.
  probeStatus = 401;
  await jest.advanceTimersByTimeAsync(2000);
  lastSocket().refusedUpgrade();
  await settle();

  expect(wire.map(r => r.path)).toEqual([
    '/v1/me',
    '/v1/me',
    '/v1/auth/challenge',
    '/v1/auth',
  ]);
  expect(lastSocket().url).toContain('fresh-1');

  client.stop();
});

test('a renewal on the REST path reaches the socket, which never dials the revoked bearer', async () => {
  const client = startClient();
  lastSocket().open();
  await settle();
  expect(lastSocket().url).toContain(STALE);

  // Somewhere else in the app an ordinary REST call 401s and heals itself. `POST /v1/auth` revokes every prior session —
  // including the credential this socket is holding.
  await reauth.reauthenticate(STALE);
  await settle();
  expect(minted).toBe(1);

  // The live socket is deliberately left alone: its authorization was bound
  // once at `$connect` and still holds, so tearing it down would be churn for
  // its own sake.
  expect(FakeSocket.instances).toHaveLength(1);

  // Then the ordinary drop — API Gateway's 2 h cap, a tunnel, anything. THIS is
  // where the bug lived: the redial presented the revoked bearer, was refused,
  // and the probe (which asks about the CURRENT token) answered 200 and called
  // it a blip. A loop that ended only when the app restarted.
  lastSocket().dropped();
  await jest.advanceTimersByTimeAsync(1000);

  expect(FakeSocket.instances).toHaveLength(2);
  expect(lastSocket().url).toContain('fresh-1');
  expect(lastSocket().url).not.toContain(STALE);

  client.stop();
});

test('a probe spent while offline is refunded, so the expiry that follows still heals', async () => {
  // The device has no network: the socket cannot dial and the probe cannot ask.
  offline = true;
  const client = startClient();

  lastSocket().refusedUpgrade();
  await settle();
  // It asked — and learned nothing, because nobody answered.
  expect(wire.map(r => r.path)).toEqual(['/v1/me']);
  expect(minted).toBe(0);

  // The network comes back. By now the 30-day session really has expired, so
  // this refusal is the real thing rather than the tunnel.
  offline = false;
  probeStatus = 401;
  await jest.advanceTimersByTimeAsync(1000);
  lastSocket().refusedUpgrade();
  await settle();

  // The refund is the whole point. Spending the episode's one probe on a
  // question nobody answered would leave this second refusal unexamined, and
  // the app would back off blindly against a dead token — the exact day-31
  // strand the feature exists to prevent, now reachable through any prior
  // spell of offline.
  expect(wire.map(r => r.path)).toEqual([
    '/v1/me',
    '/v1/me',
    '/v1/auth/challenge',
    '/v1/auth',
  ]);
  expect(lastSocket().url).toContain('fresh-1');

  client.stop();
});

test('a fresh token that is refused too stops the mint loop', async () => {
  const client = startClient();
  lastSocket().refusedUpgrade();
  await settle();
  expect(minted).toBe(1);
  expect(lastSocket().url).toContain('fresh-1');

  // The server issues a token its own authorizer then rejects — replication
  // lag, deployment skew, a clock. Answering that with probe + challenge +
  // auth + dial at zero delay, forever, each mint revoking the last, is a
  // self-inflicted DoS on our own auth route. `api.ts` calls this shape "a
  // server-side truth, not a token problem" and retries exactly once; the
  // socket has to agree.
  lastSocket().refusedUpgrade();
  await settle();
  expect(minted).toBe(2);
  expect(FakeSocket.instances).toHaveLength(2);
  expect(jest.getTimerCount()).toBeGreaterThan(0);

  // The episode's probe stays spent, so the refusal after the backoff costs
  // nothing at all — no probe, no challenge, no mint.
  await jest.advanceTimersByTimeAsync(30_000);
  const before = wire.length;
  lastSocket().refusedUpgrade();
  await settle();
  expect(wire).toHaveLength(before);
  expect(minted).toBe(2);

  client.stop();
});

test('a stop() and a fresh start() are not steered by the old auth check', async () => {
  let release!: (outcome: import('../src/ws').WsAuthOutcome) => void;
  const client = new ws.WsClient();
  client.start(STALE, () => new Promise(resolve => {
    release = resolve;
  }));
  lastSocket().refusedUpgrade();
  await settle();
  // The probe is now hanging, which an offline fetch does for tens of seconds.

  // A relock, then a real unlock.
  client.stop();
  client.start('fresh-token', async () => ({ verdict: 'blip', conclusive: true }));

  // The new session dials immediately. Before the epoch existed, the old
  // session's `authPending` was still set and suppressed this dial entirely:
  // a fresh unlock sat on "Offline" behind a probe belonging to a session that
  // no longer existed.
  expect(lastSocket().url).toContain('fresh-token');

  // And when the dead probe finally answers — with the most damaging verdict it
  // has — that answer must land on nothing.
  release({ verdict: 'gone' });
  await settle();
  lastSocket().refusedUpgrade();
  await settle();
  await jest.advanceTimersByTimeAsync(2000);
  expect(lastSocket().url).toContain('fresh-token');

  client.stop();
});

test.each([403, 429, 500])(
  'a probe answered %i is conclusive: the server spoke, so the probe is spent',
  async status => {
    // The offline test above proves an UNANSWERED probe is refunded. This is
    // the other edge of the same blade, and it used to cut the wrong way: "the
    // server answered" was implemented as "returned 401", so a 403 from a WAF,
    // a 429 from our own rate limiter or a 5xx from a cold gateway THREW, was
    // classified as unanswered, and was refunded — handing a rate-limiting
    // server a probe per retry against the route that was already struggling.
    // None of these statuses says the bearer is dead, but every one of them
    // proves the server was reached, and that is the only question the probe
    // was asking.
    probeStatus = status;
    const client = startClient();

    lastSocket().refusedUpgrade();
    await settle();

    // Asked once, answered, believed: not an auth failure, so nothing minted
    // and no immediate re-dial — the ordinary backoff owns the retry.
    expect(wire.map(r => r.path)).toEqual(['/v1/me']);
    expect(minted).toBe(0);
    expect(FakeSocket.instances).toHaveLength(1);

    // And the episode's one probe is SPENT. The next refusal goes to the
    // backoff without a second question — unlike the transport-rejection case,
    // where nobody answered and the refund is what keeps day 31 healable.
    await jest.advanceTimersByTimeAsync(1000);
    expect(FakeSocket.instances).toHaveLength(2);
    lastSocket().refusedUpgrade();
    await settle();
    await jest.advanceTimersByTimeAsync(2000);
    expect(wire.map(r => r.path)).toEqual(['/v1/me']);
    expect(minted).toBe(0);

    client.stop();
  },
);

test('refunded probes on the 4001 path ride the backoff, not a one-second loop', async () => {
  // The hammer the refund almost built: on the local adapter the upgrade
  // COMPLETES and close(4001) lands milliseconds later, so `onopen` runs on
  // every retry. While the device is offline each probe is (correctly)
  // inconclusive and refunded — and when `onopen` also reset the backoff, the
  // two together produced a dial + probe every single second, ~60 an hour of
  // battery and radio for as long as the spell lasted. The fix under test:
  // opening proves nothing, only a connection that LASTS HEALTHY_MS resets the
  // backoff, so a refunded probe retries on a schedule that grows.
  offline = true;
  const client = startClient();

  // A minute of an offline device whose every dial opens and dies 4001.
  for (let second = 0; second < 60; second++) {
    const socket = lastSocket();
    if (socket.readyState === 0) socket.closedUnauthorized();
    await settle();
    await jest.advanceTimersByTimeAsync(1000);
  }

  // Still trying — an inconclusive failure is not terminal…
  expect(FakeSocket.instances.length).toBeGreaterThanOrEqual(4);
  // …but on a budget. Every request was the probe (nothing minted blind), and
  // the whole minute cost a handful of them, not sixty.
  expect(new Set(wire.map(r => r.path))).toEqual(new Set(['/v1/me']));
  expect(minted).toBe(0);
  expect(wire.length).toBeLessThanOrEqual(8);

  // The gaps between dials are the actual claim: each wait strictly longer
  // than the one before it, reaching seconds — exponential backoff surviving
  // an `onopen` on every cycle.
  const dials = FakeSocket.instances.map(s => s.createdAt);
  const gaps = dials.slice(1).map((at, i) => at - dials[i]!);
  expect(gaps.length).toBeGreaterThanOrEqual(4);
  for (let i = 1; i < gaps.length; i++) {
    expect(gaps[i]!).toBeGreaterThan(gaps[i - 1]!);
  }
  expect(gaps[gaps.length - 1]!).toBeGreaterThanOrEqual(8000);

  client.stop();
});

test('adoptToken after stop() adopts nothing: a relock is not permission to dial', async () => {
  // The subscription that delivers renewed bearers is torn down with
  // messaging, but teardown is not atomic with the last REST heal: a renewal
  // that resolves during a relock can still hand its token to a client whose
  // stop() already ran. A stopped client that dials on it has re-opened a
  // socket behind the lock screen — exactly what the quiesce rules forbid,
  // with the fresh credential making the dial WORK.
  const client = startClient();
  client.stop();

  client.adoptToken('fresh-after-relock');
  await settle();

  expect(FakeSocket.instances).toHaveLength(1);
  expect(jest.getTimerCount()).toBe(0);
  await jest.advanceTimersByTimeAsync(60_000);
  expect(FakeSocket.instances).toHaveLength(1);
});

test('adoptToken after the terminal latch never puts the socket back on the air', async () => {
  // Once `gone` has latched, every ratchet session and pinned identity on this
  // device is keyed to an account that no longer exists — the app is showing a
  // terminal sheet saying so. A bearer that arrives afterwards (a stale
  // publish, a subscriber that outlived its teardown) must not quietly turn
  // "this account no longer exists" back into a dialling socket: whatever that
  // token belongs to, it is not the account this device's state is keyed by.
  authReply = {
    status: 403,
    body: {
      error: { code: 'identity_tombstoned', detail: 'this identity key has been revoked' },
    },
  };
  const client = startClient();
  lastSocket().refusedUpgrade();
  await settle();
  expect(reauth.accountGone()).toBe(true);
  expect(FakeSocket.instances).toHaveLength(1);

  client.adoptToken('token-from-somewhere-else');
  await settle();
  await jest.advanceTimersByTimeAsync(60_000);

  expect(FakeSocket.instances).toHaveLength(1);
  expect(jest.getTimerCount()).toBe(0);

  client.stop();
});

test('a token adopted while a reconnect timer is armed dials once, not twice', async () => {
  // adoptToken jumps the backoff queue — a credential this socket has never
  // presented deserves an immediate dial, not the dead token's ceiling. But
  // jumping the queue means the queued timer must be REVOKED: left armed, it
  // fires after the immediate dial and connect()s again, and now two sockets
  // race for the same registration — the server sees a connect storm and the
  // client's handlers are wired to whichever socket lost.
  probeStatus = 200; // the drop below is a genuine blip, conclusively probed
  const client = startClient();
  lastSocket().refusedUpgrade();
  await settle();
  // In backoff: one socket so far, one reconnect timer pending.
  expect(FakeSocket.instances).toHaveLength(1);
  expect(jest.getTimerCount()).toBe(1);

  // A REST call elsewhere heals its own 401; the renewal publishes and the
  // messaging wiring hands the fresh bearer to the socket mid-backoff.
  await reauth.reauthenticate(STALE);

  // Exactly ONE new dial, immediately, with the new token — and the armed
  // timer is gone, so nothing fires behind it.
  expect(FakeSocket.instances).toHaveLength(2);
  expect(lastSocket().url).toContain('fresh-1');
  // One armed timer, and it is the new dial's watchdog rather than the timer
  // that was revoked: adoptToken resets the backoff to 1 s, so a surviving
  // reconnect would fire inside the window below and produce the third socket
  // this test exists to refuse. (The window stops short of the 20 s watchdog
  // on purpose — this is a claim about the queue, not about the deadline.)
  expect(jest.getTimerCount()).toBe(1);
  await jest.advanceTimersByTimeAsync(19_000);
  expect(FakeSocket.instances).toHaveLength(2);

  client.stop();
});

test('an authCheck that throws is inconclusive: contained, refunded, retried', async () => {
  // The check is injected, and an injected function can throw for reasons that
  // have nothing to do with the credential — a subscriber bug, a rejected
  // import, a Keychain wrapper mid-teardown. Two things must be true: the
  // throw is contained (an unhandled rejection inside `onclose` handling takes
  // the whole client down with it), and it is scored as LEARNED NOTHING — the
  // probe refunded — because a question that crashed was never answered.
  // Treating it as spent would leave the next, real refusal unexamined: the
  // day-31 strand reachable through any transient bug in the check itself.
  let checks = 0;
  const client = new ws.WsClient();
  let bearer = STALE;
  reauth.subscribeToken(next => {
    bearer = next;
    client.adoptToken(next);
  });
  client.start(bearer, () => {
    checks += 1;
    if (checks === 1) return Promise.reject(new Error('subscriber bug'));
    return reauth.probeAndHeal(bearer);
  });

  lastSocket().refusedUpgrade();
  await settle();

  // Contained: no mint, no crash, an ordinary backoff timer and nothing else.
  expect(minted).toBe(0);
  expect(wire).toHaveLength(0);
  expect(jest.getTimerCount()).toBe(1);

  // Refunded: the next refusal runs the check again, and this time it heals.
  await jest.advanceTimersByTimeAsync(1000);
  lastSocket().refusedUpgrade();
  await settle();

  expect(checks).toBe(2);
  expect(wire.map(r => r.path)).toEqual(['/v1/me', '/v1/auth/challenge', '/v1/auth']);
  expect(lastSocket().url).toContain('fresh-1');

  client.stop();
});

describe('the socket URL carries a ticket, never the bearer', () => {
  // The regression this whole change exists to prevent. A URL
  // is written into proxy logs, access logs and crash reporters; what used to
  // go there was a thirty-day credential good on every authenticated route.
  test('a dial with a minter sends ?ticket= and no token at all', async () => {
    const client = new ws.WsClient();
    let minted = 0;
    client.start(STALE, undefined, async () => `tkt-${++minted}`);
    await settle();

    const url = lastSocket().url;
    expect(url).toContain('ticket=tkt-1');
    expect(url).not.toContain('token=');
    expect(url).not.toContain(STALE);

    client.stop();
  });

  test('every reconnect mints a FRESH ticket', async () => {
    // A cached ticket is a credential with extra steps, which is the thing
    // being removed. Single-use also means a replayed one is simply refused,
    // so reuse would break reconnection outright.
    const client = new ws.WsClient();
    let minted = 0;
    client.start(STALE, undefined, async () => `tkt-${++minted}`);
    await settle();
    expect(lastSocket().url).toContain('ticket=tkt-1');

    lastSocket().dropped();
    await jest.advanceTimersByTimeAsync(1000);
    await settle();

    expect(lastSocket().url).toContain('ticket=tkt-2');
    expect(minted).toBe(2);

    client.stop();
  });

  test('a minter that returns null falls back to the transitional token path', async () => {
    // NULL is the deliberate, narrow signal — the caller decided this is the
    // benign case (a server that predates the route, or no bearer at all).
    // Temporary: the server accepts ?token= for one deploy so a running client
    // is not cut off by the server updating first.
    const client = new ws.WsClient();
    client.start(STALE, undefined, async () => null);
    await settle();

    expect(lastSocket().url).toContain(`token=${STALE}`);
    client.stop();
  });

  test('a minter that THROWS does not dial at all, and never with the bearer', async () => {
    /*
     * THE DOWNGRADE AN ATTACKER COULD FORCE.
     *
     * This used to be `.catch(() => null)`: any mint failure fell through to
     * putting the thirty-day bearer in the socket URL. So anyone able to break
     * that one request — a 5xx, a 429, a WAF block on the HTTP host — got the
     * original defect back on demand, while the socket host stayed up and the
     * client happily connected. Failing the dial and retrying is the only safe
     * answer; a connection is not worth the credential it would cost.
     */
    const before = FakeSocket.instances.length;
    const client = new ws.WsClient();
    let calls = 0;
    client.start(STALE, undefined, async () => {
      calls++;
      throw new Error('mint unavailable');
    });
    await settle();

    expect(FakeSocket.instances.length).toBe(before);

    // …and it must RETRY rather than give up, or a transient 500 would strand
    // the socket until something else happened to restart it.
    await jest.advanceTimersByTimeAsync(5000);
    await settle();
    expect(calls).toBeGreaterThan(1);

    // Whatever it retried, it never dialled carrying the bearer.
    for (const s of FakeSocket.instances.slice(before)) {
      expect(s.url).not.toContain(STALE);
    }

    client.stop();
  });

  test('a minter whose answer no longer PARSES retries from the backoff ceiling, not the base, and says so by name', async () => {
    /*
     * The server is ahead of this build: no schedule of re-dials reaches
     * it. It must still retry — a server rollback or an update under a live
     * process both heal it — but a stale client dialling every second is a
     * ticket-minting hammer against `/v1/ws-ticket` with no possible
     * success, so the next dial waits the ceiling (30 s × the jitter band),
     * and the state is readable as the thing it is.
     */
    const before = FakeSocket.instances.length;
    const client = new ws.WsClient();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    // When each mint was asked for, on the fake clock: the GAPS are the
    // assertion, because the delay is jittered inside [0.5, 1.5) of the
    // base — a count at a fixed instant would pass or fail on the draw.
    const mints: number[] = [];
    client.start(STALE, undefined, async () => {
      mints.push(Date.now());
      throw Object.assign(new Error('update Tacendum: the server answered WsTicketResponse in a shape this version cannot read'), {
        name: 'ServerAheadError',
      });
    });
    await settle();
    expect(FakeSocket.instances.length).toBe(before);
    expect(mints).toHaveLength(1);
    expect(client.serverAhead).toBe(true);
    // Said once, by name — no ticket, no bearer, no body in the line.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('server ahead of client');
    expect(String(warn.mock.calls[0]![0])).not.toContain(STALE);

    // The ordinary schedule would have re-minted inside 1.5 s (base 1 s ×
    // jitter < 1.5); the ceiling's band is [15 s, 45 s).
    await jest.advanceTimersByTimeAsync(14_999);
    await settle();
    expect(mints).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(30_001);
    await settle();
    expect(mints.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < mints.length; i++) {
      const gap = mints[i]! - mints[i - 1]!;
      expect(gap).toBeGreaterThanOrEqual(15_000);
      expect(gap).toBeLessThan(45_000);
    }
    // Still ahead, still said only once, still no socket.
    expect(client.serverAhead).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(FakeSocket.instances.length).toBe(before);

    warn.mockRestore();
    client.stop();
  });

  test('a mint that parses again clears the server-ahead state', async () => {
    const client = new ws.WsClient();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    let calls = 0;
    client.start(STALE, undefined, async () => {
      calls++;
      if (calls === 1) {
        throw Object.assign(new Error('update Tacendum'), { name: 'ServerAheadError' });
      }
      return `tkt-${calls}`;
    });
    await settle();
    expect(client.serverAhead).toBe(true);
    const before = FakeSocket.instances.length;
    await jest.advanceTimersByTimeAsync(45_001);
    await settle();
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(client.serverAhead).toBe(false);
    expect(FakeSocket.instances.slice(before).some(s => s.url.includes('ticket=tkt-2'))).toBe(true);
    warn.mockRestore();
    client.stop();
  });

  test('a stop() during the mint does not produce a socket afterwards', async () => {
    // The mint is async and the dial happens in its continuation, so a relock
    // mid-mint must not be followed by a connection appearing a moment later.
    const before = FakeSocket.instances.length;
    const client = new ws.WsClient();
    let release!: (t: string) => void;
    client.start(STALE, undefined, () => new Promise<string>(r => { release = r; }));

    client.stop();
    release('tkt-late');
    await settle();

    expect(FakeSocket.instances).toHaveLength(before);
  });
});
