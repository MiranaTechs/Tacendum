/**
 * THE CALLER-OWNED STATE READ (fix/username-discovery, 2026-10-08 — the
 * contract the four lanes build on).
 *
 * The field report: on a linked sibling (the iPad, a reinstalled
 * phone) the app reads as if the account were never set up, because the
 * server never echoes a name (§4.9) and the device-local rows
 * are the only readable home of the username and the verified email. The
 * eligibility read cannot be widened — builds 31-33 parse it `.strict()`
 * with no OTA — so a NEW route, `GET /v1/identifiers/state`, carries the
 * account group's own facts: verified identifier, email/phone linked, a
 * username held, the cool-down's end. Never a name, never anything about
 * another party.
 *
 * Two layers, each proved here:
 *
 *  1. THE WIRE (api.apiIdentifierState), driven through the REAL
 *     `request()` against a scripted fetch, the api.serverahead discipline:
 *     the route, the bearer, no body; the strict parse (a rider field is a
 *     ServerAheadError, never stripped); and the FOUR resolutions — 'state'
 *     on 200, 'absent' on 404 (TODAY'S production server, fef7a0dc, has no
 *     such route and the app must keep working against it until the
 *     new server deploys), 'refused' on every other http answer, 'failed' on
 *     a transport failure (no network, the deadline, a duress session).
 *
 *  2. THE MODULE (accountsUsername.getIdentifierState), deps-injected like
 *     every verb in that module: the state route first; 'absent' falls back
 *     to the legacy eligibility read with the three sibling facts null (=
 *     unknown); refused and failed stay distinguishable (U3: a 403 is not a
 *     connection problem); the 60 s cache, its invalidation, the stale
 *     guard, single-flight, and the account/session keys.
 */

// The profile read that would refuse a userId that moved. Null here: these
// tests are about the transport and the module, and a real db would answer
// from whichever workspace an earlier suite left open.
jest.mock('../src/db', () => ({ loadProfile: jest.fn(async () => null) }));

import {
  IdentifierStateResponse,
  USERNAME_RENAME_COOLDOWN_SECONDS,
  type UsernameEligibilityResponse,
} from '@tacendum/shared';
import { API_BASE } from '../src/config';
import * as api from '../src/api';
import {
  ApiRequestError,
  REQUEST_TIMEOUT_MS,
  ServerAheadError,
  type IdentifierStateRead,
} from '../src/api';
import * as accountsUsername from '../src/accountsUsername';
import {
  IDENTIFIER_STATE_CACHE_MS,
  getIdentifierState,
  invalidateIdentifierState,
  type IdentifierState,
  type IdentifierStateDeps,
} from '../src/accountsUsername';
import { resumeAccountRequests, suspendAccountRequests } from '../src/accountLifecycle';
import * as reauth from '../src/reauth';
import { session } from '../src/session';

const STATE_PATH = '/v1/identifiers/state';
const ELIGIBILITY_PATH = '/v1/identifiers/username/eligibility';

/** A served answer exactly as the shared schema requires it. */
const SERVED = {
  hasVerifiedIdentifier: true,
  emailLinked: true,
  phoneLinked: false,
  holdsUsername: true,
  usernameCooldownUntil: 1_760_000_000,
  usernameSince: 1_759_900_000,
  emailSince: 1_759_800_000,
  usernameFindable: true,
  emailFindable: false,
};

interface Wire {
  method: string;
  path: string;
  bearer?: string;
  body?: string;
}

let answers: Record<string, { status: number; body: unknown }>;
/** Every request that actually left, in order. */
let wire: Wire[];

function json(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function installScriptedFetch(): jest.Mock {
  const mock = jest.fn(
    async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
      const path = String(url).slice(API_BASE.length);
      const record: Wire = { method: init?.method ?? 'GET', path };
      if (init?.headers?.authorization !== undefined) record.bearer = init.headers.authorization;
      if (init?.body !== undefined) record.body = init.body;
      wire.push(record);
      // TODAY'S production shape for an unknown route: API Gateway's HTTP API
      // answers 404 {"message":"Not Found"} for a routeKey it does not hold.
      const answer = answers[path] ?? { status: 404, body: { message: 'Not Found' } };
      return json(answer.status, answer.body);
    },
  );
  (globalThis as unknown as { fetch: unknown }).fetch = mock;
  return mock;
}

beforeEach(() => {
  answers = {};
  wire = [];
  installScriptedFetch();
  session.setMode('real');
  invalidateIdentifierState();
});

afterEach(() => {
  session.setMode('real');
  jest.restoreAllMocks();
  jest.useRealTimers();
});

/* ── 1. the wire ──────────────────────────────────────────────────── */

describe('apiIdentifierState: GET /v1/identifiers/state through the real request()', () => {
  test('a 200 in the strict shape resolves to {kind: "state"} — GET, the bearer, no body, authenticated exactly like the eligibility read', async () => {
    answers[STATE_PATH] = { status: 200, body: SERVED };
    answers[ELIGIBILITY_PATH] = { status: 200, body: { hasVerifiedIdentifier: true } };
    await expect(api.apiIdentifierState('tok')).resolves.toEqual({ kind: 'state', value: SERVED });
    await api.apiUsernameEligibility('tok');
    expect(wire).toEqual([
      { method: 'GET', path: STATE_PATH, bearer: 'Bearer tok' },
      { method: 'GET', path: ELIGIBILITY_PATH, bearer: 'Bearer tok' },
    ]);
    // The two reads differ in nothing but the path.
    const { path: a, ...stateShape } = wire[0]!;
    const { path: b, ...eligibilityShape } = wire[1]!;
    expect(a).not.toBe(b);
    expect(stateShape).toEqual(eligibilityShape);
  });

  test('TODAY’S production server has no such route: a 404 is {kind: "absent"}, never a throw — API Gateway’s body and the router’s not_found alike', async () => {
    // The scripted default IS the API Gateway answer ({"message":"Not Found"}).
    await expect(api.apiIdentifierState('tok')).resolves.toEqual({ kind: 'absent' });
    // The Lambda/local router's own 404 for an unknown routeKey.
    answers[STATE_PATH] = {
      status: 404,
      body: { error: { code: 'not_found', detail: 'GET /v1/identifiers/state' } },
    };
    await expect(api.apiIdentifierState('tok')).resolves.toEqual({ kind: 'absent' });
    expect(wire.map(w => w.path)).toEqual([STATE_PATH, STATE_PATH]);
  });

  test('every other http answer is {kind: "refused"}: the frozen 403, a 429, a 5xx — an answer from the server is never a connection problem (U3)', async () => {
    for (const [status, body] of [
      [403, { error: { code: 'accounts_refused', detail: 'refused' } }],
      [429, { error: { code: 'rate_limited', detail: 'slow down' } }],
      [503, { error: { code: 'internal', detail: 'busy' } }],
      [500, 'not even json'],
    ] as const) {
      answers[STATE_PATH] = { status, body };
      await expect(api.apiIdentifierState('tok')).resolves.toEqual({ kind: 'refused' });
    }
  });

  test('no network is {kind: "failed"} — RN’s TypeError, the shape the duress chokepoint borrows', async () => {
    (globalThis as unknown as { fetch: unknown }).fetch = jest.fn(async () => {
      throw new TypeError('Network request failed');
    });
    await expect(api.apiIdentifierState('tok')).resolves.toEqual({ kind: 'failed' });
  });

  test('the deadline is {kind: "failed"} too — ApiTimeoutError is a transport failure, deliberately not an ApiRequestError', async () => {
    jest.useFakeTimers();
    (globalThis as unknown as { fetch: unknown }).fetch = jest.fn(
      (_url: string, init?: { signal?: AbortSignal }) =>
        new Promise<never>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })),
          );
        }),
    );
    const call = api.apiIdentifierState('tok');
    await jest.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    await expect(call).resolves.toEqual({ kind: 'failed' });
  });

  test('a duress session sends nothing and reads as {kind: "failed"} — indistinguishable from offline', async () => {
    session.setMode('duress');
    await expect(api.apiIdentifierState('tok')).resolves.toEqual({ kind: 'failed' });
    expect(wire).toEqual([]);
  });

  test('the parse is STRICT: a rider field is a ServerAheadError naming the DTO (never silently stripped); a missing or retyped fact names the field', async () => {
    answers[STATE_PATH] = { status: 200, body: { ...SERVED, username: 'alice' } };
    const rider = await api.apiIdentifierState('tok').catch((err: unknown) => err);
    expect(rider).toBeInstanceOf(ServerAheadError);
    expect((rider as ServerAheadError).dto).toBe('IdentifierStateResponse');
    expect((rider as Error).message).not.toContain('alice');

    const withoutHeld = Object.fromEntries(
      Object.entries(SERVED).filter(([field]) => field !== 'holdsUsername'),
    );
    answers[STATE_PATH] = { status: 200, body: withoutHeld };
    await expect(api.apiIdentifierState('tok')).rejects.toMatchObject({
      name: 'ServerAheadError',
      dto: 'IdentifierStateResponse',
      fields: ['holdsUsername'],
    });

    answers[STATE_PATH] = { status: 200, body: { ...SERVED, usernameCooldownUntil: 1.5 } };
    await expect(api.apiIdentifierState('tok')).rejects.toMatchObject({
      name: 'ServerAheadError',
      fields: ['usernameCooldownUntil'],
    });
    // The same shape the shared schema pins — one source of truth.
    expect(IdentifierStateResponse.safeParse({ ...SERVED, username: 'alice' }).success).toBe(false);
  });
});

/* ── 2. the module ────────────────────────────────────────────────── */

const NOW_MS = 1_759_950_000_000;
const UNKNOWN = {
  holdsUsername: null,
  emailLinked: null,
  phoneLinked: null,
  cooldownUntil: null,
  usernameSince: null,
  emailSince: null,
  usernameFindable: null,
  emailFindable: null,
};
const REFUSAL = () => new ApiRequestError('refused', 403, 'accounts_refused');
const TRANSPORT = () => new TypeError('Network request failed');

interface Scripted {
  deps: IdentifierStateDeps;
  identifierState: jest.Mock<Promise<IdentifierStateRead>, [string]>;
  usernameEligibility: jest.Mock<Promise<UsernameEligibilityResponse>, [string]>;
  token: jest.Mock<Promise<string | null>, []>;
  clock: { now: number };
}

function scripted(
  stateRead: IdentifierStateRead | (() => Promise<IdentifierStateRead>) = { kind: 'state', value: SERVED },
  eligibility: UsernameEligibilityResponse | (() => Promise<UsernameEligibilityResponse>) = {
    hasVerifiedIdentifier: true,
  },
): Scripted {
  const clock = { now: NOW_MS };
  const identifierState = jest.fn(
    async (_token: string): Promise<IdentifierStateRead> =>
      typeof stateRead === 'function' ? stateRead() : stateRead,
  );
  const usernameEligibility = jest.fn(
    async (_token: string): Promise<UsernameEligibilityResponse> =>
      typeof eligibility === 'function' ? eligibility() : eligibility,
  );
  const token = jest.fn(async (): Promise<string | null> => 'tok');
  return {
    deps: { api: { identifierState, usernameEligibility }, token, now: () => clock.now },
    identifierState,
    usernameEligibility,
    token,
    clock,
  };
}

describe('getIdentifierState: the state route first, the legacy read as the fallback', () => {
  test('a state answer: source "state", eligibility from the shared boolean, the three facts, and the cool-down converted from the wire’s seconds to this module’s milliseconds', async () => {
    const s = scripted();
    const state = await getIdentifierState(s.deps);
    expect(state).toEqual<IdentifierState>({
      source: 'state',
      eligibility: 'eligible',
      holdsUsername: true,
      emailLinked: true,
      phoneLinked: false,
      cooldownUntil: SERVED.usernameCooldownUntil * 1000,
      usernameSince: SERVED.usernameSince * 1000,
      emailSince: SERVED.emailSince * 1000,
      usernameFindable: true,
      emailFindable: false,
    });
    expect(s.identifierState).toHaveBeenCalledWith('tok');
    expect(s.usernameEligibility).not.toHaveBeenCalled();
    // The arithmetic every cool-down sentence will do: wire seconds + the
    // 30-day pin, read back on this module's Date.now() scale.
    const renamedAtSeconds = SERVED.usernameCooldownUntil - USERNAME_RENAME_COOLDOWN_SECONDS;
    expect(state.cooldownUntil).toBe((renamedAtSeconds + USERNAME_RENAME_COOLDOWN_SECONDS) * 1000);
  });

  test('a state answer without a possession proof is "needs_verification"; a null cool-down stays null; false facts stay false (not unknown)', async () => {
    const s = scripted({
      kind: 'state',
      value: {
        hasVerifiedIdentifier: false,
        emailLinked: false,
        phoneLinked: false,
        holdsUsername: false,
        usernameCooldownUntil: null,
        usernameSince: null,
        emailSince: null,
        usernameFindable: null,
        emailFindable: null,
      },
    });
    await expect(getIdentifierState(s.deps)).resolves.toEqual<IdentifierState>({
      source: 'state',
      eligibility: 'needs_verification',
      holdsUsername: false,
      emailLinked: false,
      phoneLinked: false,
      cooldownUntil: null,
      usernameSince: null,
      emailSince: null,
      usernameFindable: null,
      emailFindable: null,
    });
  });

  test('"absent" (today’s production server) falls back to the legacy eligibility read: source "legacy", the three facts UNKNOWN (null), eligibility from the boolean', async () => {
    const eligible = scripted({ kind: 'absent' }, { hasVerifiedIdentifier: true });
    await expect(getIdentifierState(eligible.deps)).resolves.toEqual<IdentifierState>({
      source: 'legacy',
      eligibility: 'eligible',
      ...UNKNOWN,
    });
    expect(eligible.identifierState).toHaveBeenCalledTimes(1);
    expect(eligible.usernameEligibility).toHaveBeenCalledWith('tok');

    invalidateIdentifierState();
    const unverified = scripted({ kind: 'absent' }, { hasVerifiedIdentifier: false });
    await expect(getIdentifierState(unverified.deps)).resolves.toEqual<IdentifierState>({
      source: 'legacy',
      eligibility: 'needs_verification',
      ...UNKNOWN,
    });
  });

  test('refused vs failed on the STATE leg stay distinguishable (U3), facts unknown, and neither falls back to the legacy read', async () => {
    const refused = scripted({ kind: 'refused' });
    await expect(getIdentifierState(refused.deps)).resolves.toEqual<IdentifierState>({
      source: 'state',
      eligibility: 'refused',
      ...UNKNOWN,
    });
    expect(refused.usernameEligibility).not.toHaveBeenCalled();

    const failed = scripted({ kind: 'failed' });
    await expect(getIdentifierState(failed.deps)).resolves.toEqual<IdentifierState>({
      source: 'state',
      eligibility: 'failed',
      ...UNKNOWN,
    });
    expect(failed.usernameEligibility).not.toHaveBeenCalled();
  });

  test('refused vs failed on the LEGACY leg: an ApiRequestError is "refused", a transport error is "failed", both source "legacy"', async () => {
    const refused = scripted({ kind: 'absent' }, async () => {
      throw REFUSAL();
    });
    await expect(getIdentifierState(refused.deps)).resolves.toEqual<IdentifierState>({
      source: 'legacy',
      eligibility: 'refused',
      ...UNKNOWN,
    });
    const failed = scripted({ kind: 'absent' }, async () => {
      throw TRANSPORT();
    });
    await expect(getIdentifierState(failed.deps)).resolves.toEqual<IdentifierState>({
      source: 'legacy',
      eligibility: 'failed',
      ...UNKNOWN,
    });
  });

  test('a server AHEAD of this build on the state route (the strict parse threw) degrades to the legacy read, which every shipped build can still parse', async () => {
    const s = scripted(async () => {
      throw new ServerAheadError('IdentifierStateResponse', ['nextYearsField']);
    });
    await expect(getIdentifierState(s.deps)).resolves.toEqual<IdentifierState>({
      source: 'legacy',
      eligibility: 'eligible',
      ...UNKNOWN,
    });
    expect(s.usernameEligibility).toHaveBeenCalledTimes(1);
  });

  test('no token: "failed" before any wire call', async () => {
    const s = scripted();
    s.token.mockResolvedValue(null);
    await expect(getIdentifierState(s.deps)).resolves.toEqual<IdentifierState>({
      source: 'state',
      eligibility: 'failed',
      ...UNKNOWN,
    });
    expect(s.identifierState).not.toHaveBeenCalled();
    expect(s.usernameEligibility).not.toHaveBeenCalled();
  });
});

describe('the 60 s cache and invalidateIdentifierState()', () => {
  test('a landed answer is served from memory for IDENTIFIER_STATE_CACHE_MS and re-read at the boundary', async () => {
    // RE-CUT 2026-10-08 (the gate pass): 60 s → 2 s. A minute-long app-wide
    // memory replayed the reported symptoms (the claim form, the attach
    // form, the false "verify an email first" door) for up to a minute after
    // a sibling's change, a link completion or a revocation; what remains
    // folds one screen's own back-to-back reads into one wire call.
    expect(IDENTIFIER_STATE_CACHE_MS).toBe(2_000);
    const s = scripted();
    const first = await getIdentifierState(s.deps);
    s.clock.now = NOW_MS + IDENTIFIER_STATE_CACHE_MS - 1;
    await expect(getIdentifierState(s.deps)).resolves.toBe(first);
    expect(s.identifierState).toHaveBeenCalledTimes(1);
    s.clock.now = NOW_MS + IDENTIFIER_STATE_CACHE_MS;
    await getIdentifierState(s.deps);
    expect(s.identifierState).toHaveBeenCalledTimes(2);
  });

  test('invalidateIdentifierState() forces the next read to the wire — what every claim / rename / unlink / consent / attach / remove calls', async () => {
    const s = scripted();
    await getIdentifierState(s.deps);
    await getIdentifierState(s.deps);
    expect(s.identifierState).toHaveBeenCalledTimes(1);
    invalidateIdentifierState();
    await getIdentifierState(s.deps);
    expect(s.identifierState).toHaveBeenCalledTimes(2);
  });

  test('a legacy answer is cached the same way: the second read inside the window touches neither route', async () => {
    const s = scripted({ kind: 'absent' });
    await getIdentifierState(s.deps);
    await getIdentifierState(s.deps);
    expect(s.identifierState).toHaveBeenCalledTimes(1);
    expect(s.usernameEligibility).toHaveBeenCalledTimes(1);
  });

  test('"refused" and "failed" are NEVER cached — Retry must reach the wire', async () => {
    const refused = scripted({ kind: 'refused' });
    await getIdentifierState(refused.deps);
    await getIdentifierState(refused.deps);
    expect(refused.identifierState).toHaveBeenCalledTimes(2);

    const failed = scripted({ kind: 'absent' }, async () => {
      throw TRANSPORT();
    });
    await getIdentifierState(failed.deps);
    await getIdentifierState(failed.deps);
    expect(failed.identifierState).toHaveBeenCalledTimes(2);
    expect(failed.usernameEligibility).toHaveBeenCalledTimes(2);
  });

  test('single-flight: concurrent reads share ONE wire call and resolve to the same answer', async () => {
    const s = scripted();
    const [a, b, c] = await Promise.all([
      getIdentifierState(s.deps),
      getIdentifierState(s.deps),
      getIdentifierState(s.deps),
    ]);
    expect(s.identifierState).toHaveBeenCalledTimes(1);
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  test('an invalidation DURING a read: the answer still resolves, but it is not kept — a claim that landed while the read was out must not hide behind a stale window', async () => {
    let release!: (read: IdentifierStateRead) => void;
    let armed!: () => void;
    const onWire = new Promise<void>(resolve => {
      armed = resolve;
    });
    const s = scripted(
      () =>
        new Promise<IdentifierStateRead>(resolve => {
          release = resolve;
          armed();
        }),
    );
    const pending = getIdentifierState(s.deps);
    // The read is OUT (the token was awaited, the wire call made) when the
    // claim lands and the module is told so.
    await onWire;
    invalidateIdentifierState();
    release({ kind: 'state', value: SERVED });
    await expect(pending).resolves.toMatchObject({ source: 'state', holdsUsername: true });
    // The next read goes to the wire again.
    const after = scripted();
    await getIdentifierState(after.deps);
    expect(after.identifierState).toHaveBeenCalledTimes(1);
  });

  test('a new identity (the account request generation moved) never reads the old account’s answer', async () => {
    const s = scripted();
    await getIdentifierState(s.deps);
    suspendAccountRequests();
    resumeAccountRequests();
    await getIdentifierState(s.deps);
    expect(s.identifierState).toHaveBeenCalledTimes(2);
  });

  test('a duress session never reads the real session’s answer, and the real session never reads the duress one', async () => {
    const s = scripted();
    await getIdentifierState(s.deps);
    session.setMode('duress');
    await getIdentifierState(s.deps);
    expect(s.identifierState).toHaveBeenCalledTimes(2);
    // Back in the real session, its own (still fresh) answer serves again.
    session.setMode('real');
    await getIdentifierState(s.deps);
    expect(s.identifierState).toHaveBeenCalledTimes(2);
  });
});

describe('the default deps wire the real api and the real token', () => {
  test('getIdentifierState() with no arguments reads api.apiIdentifierState with currentToken(), and falls back to api.apiUsernameEligibility on "absent"', async () => {
    jest.spyOn(reauth, 'currentToken').mockResolvedValue('bearer');
    const stateSpy = jest
      .spyOn(api, 'apiIdentifierState')
      .mockResolvedValue({ kind: 'state', value: SERVED });
    const eligibilitySpy = jest
      .spyOn(api, 'apiUsernameEligibility')
      .mockResolvedValue({ hasVerifiedIdentifier: false });

    await expect(accountsUsername.getIdentifierState()).resolves.toMatchObject({
      source: 'state',
      eligibility: 'eligible',
      holdsUsername: true,
    });
    expect(stateSpy).toHaveBeenCalledWith('bearer');
    expect(eligibilitySpy).not.toHaveBeenCalled();

    invalidateIdentifierState();
    stateSpy.mockResolvedValue({ kind: 'absent' });
    await expect(accountsUsername.getIdentifierState()).resolves.toEqual<IdentifierState>({
      source: 'legacy',
      eligibility: 'needs_verification',
      ...UNKNOWN,
    });
    expect(eligibilitySpy).toHaveBeenCalledWith('bearer');
  });

  test('the legacy read itself is untouched: getUsernameEligibility still answers from the eligibility route alone', async () => {
    jest.spyOn(reauth, 'currentToken').mockResolvedValue('bearer');
    const stateSpy = jest.spyOn(api, 'apiIdentifierState');
    jest.spyOn(api, 'apiUsernameEligibility').mockResolvedValue({ hasVerifiedIdentifier: true });
    await expect(accountsUsername.getUsernameEligibility()).resolves.toBe('eligible');
    expect(stateSpy).not.toHaveBeenCalled();
  });
});
