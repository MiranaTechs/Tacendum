import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'tacendum-reauth-'));
process.env.TACENDUM_HOME = home;
process.env.TACENDUM_API = 'http://reauth.test';

const { FileStores } = await import('../src/stores.js');
const { generateAndStoreKeys } = await import('../src/messaging.js');
const { apiAuthChallenge, apiUploadKeys } = await import('../src/api.js');
const { AuthSession } = await import('../src/session.js');
const { loadProfile, profilePath, saveProfile } = await import('../src/profile.js');
const { CliError, EXIT } = await import('../src/exit.js');

const NAME = 'ci-bot';
const USER_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

const stores = new FileStores(NAME);
const upload = await generateAndStoreKeys(stores);

/**
 * A stand-in server with exactly the behaviour that matters:
 * one live token at a time, 401 for anything else, and a counter per route so
 * a test can assert HOW MANY round trips happened rather than only that the
 * call succeeded.
 */
interface FakeServer {
  live: string;
  /** userId that POST /v1/auth will return. */
  issuesUserId: string;
  /** When set, POST /v1/auth fails with this status (409 = account_conflict). */
  authStatus: number | null;
  /** When true, the authed route 401s no matter which token is presented. */
  alwaysRefuse: boolean;
  /**
   * 1-based index of a `/v1/keys` call whose response is held back, so a
   * second caller's 401 can be made to land AFTER another caller has already
   * renewed. That gap is the whole of the staggered case.
   */
  slowKeysCall: number | null;
  calls: { challenge: number; auth: number; keys: number };
  minted: number;
}

let server: FakeServer;
const realFetch = globalThis.fetch;

function install(): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const path = url.replace('http://reauth.test', '');
    const bearer = String(
      (init?.headers as Record<string, string> | undefined)?.authorization ?? '',
    ).replace('Bearer ', '');

    if (path === '/v1/auth/challenge') {
      server.calls.challenge += 1;
      return new Response(
        JSON.stringify({
          challenge: Buffer.from('nonce').toString('base64'),
          expiresAt: Math.floor(Date.now() / 1000) + 120,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (path === '/v1/auth') {
      server.calls.auth += 1;
      if (server.authStatus !== null) {
        return new Response(
          JSON.stringify({ error: { code: 'account_conflict', detail: 'mid-deletion' } }),
          { status: server.authStatus, headers: { 'content-type': 'application/json' } },
        );
      }
      server.minted += 1;
      server.live = `fresh-${server.minted}`;
      return new Response(JSON.stringify({ userId: server.issuesUserId, authToken: server.live }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (path === '/v1/keys') {
      server.calls.keys += 1;
      if (server.calls.keys === server.slowKeysCall) {
        await new Promise(resolve => setTimeout(resolve, 60));
      }
      if (server.alwaysRefuse || bearer !== server.live) {
        return new Response(
          JSON.stringify({ error: { code: 'unauthorized', detail: 'missing or invalid bearer token' } }),
          { status: 401, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`unexpected request ${path}`);
  }) as typeof fetch;
}

function reset(storedToken = 'expired-30-days-ago'): void {
  server = {
    live: 'live-0',
    issuesUserId: USER_ID,
    authStatus: null,
    alwaysRefuse: false,
    slowKeysCall: null,
    calls: { challenge: 0, auth: 0, keys: 0 },
    minted: 0,
  };
  saveProfile({
    name: NAME,
    identityKey: upload.identityKey,
    userId: USER_ID,
    authToken: storedToken,
    registrationId: upload.registrationId,
    deviceId: 1,
  });
}

beforeEach(() => {
  reset();
  install();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

/**
 * The item the design plan calls "the one that decides whether this product works at
 * all". Sessions last 30 days; without renewal every integration installed
 * today stops working on day 31, silently, because a Makefile and a cron line
 * both discard stderr.
 */
describe('C3 transparent re-auth on 401', () => {
  it('renews a dead token and completes the call the caller made', async () => {
    await apiUploadKeys(new AuthSession(NAME, stores), upload);

    // One refusal, one renewal, one success — not a loop.
    expect(server.calls.keys).toBe(2);
    expect(server.calls.auth).toBe(1);
    // Persisted, or the next process starts with the dead token again.
    expect(loadProfile(NAME).authToken).toBe('fresh-1');
    expect(readFileSync(profilePath(NAME), 'utf8')).toContain('fresh-1');
  });

  /**
   * an earlier review: THE MINT RE-SAVED A SNAPSHOT.
   *
   * `AuthSession` reads `profile.json` once, in its constructor, and `mint()`
   * used to persist `{ ...this.profile, authToken }` — that construction-time
   * snapshot with one field swapped — through `saveProfile`, which is a WHOLE
   * RECORD overwrite. Any field an external write added in between was gone:
   * the profile came back as this holder remembered it, plus the new token.
   *
   * `ownerUserId` is the field that costs something. It is what tells the MCP
   * surface this integration is paired at all, `pair` writes it with exactly
   * the merge this test now demands (`main.ts`: `saveProfile({
   * ...loadProfile(name), ownerUserId: owner })`), and the server's binding is
   * write-once — so the machine forgets a pairing every check on the server
   * still says is fine, which is the worst shape of failure to diagnose. The
   * token is preserved by that external write, so `adoptFromDisk` sees no
   * change and does not refresh the snapshot either.
   *
   * NO HOLDER SPANS THAT WINDOW TODAY — all twelve `new AuthSession(` sites
   * are per-command, `cmdListen` has no reconnect and exits from `onClose`,
   * and `attend` builds a fresh session per reply — which is why this is
   * hardening rather than a bug report. It is the same hardening `cmdPair` and
   * `setup.ts` already carry, and the reason to apply it here is that
   * "unreachable" is a property of today's twelve call sites, not of this
   * class.
   */
  it('a token-preserving external write survives the mint — only authToken is merged', async () => {
    const OWNER = '01ARZ3NDEKTSV4RRFFQ69G5FAW';
    // The holder takes its snapshot HERE, before the external write.
    const auth = new AuthSession(NAME, stores);

    // …and `tacendum pair` lands while it is alive: it merges `ownerUserId`
    // into whatever is on disk and leaves the token exactly as it found it,
    // so nothing about this write is visible to `adoptFromDisk`.
    saveProfile({ ...loadProfile(NAME), accountClass: 'integration', ownerUserId: OWNER });

    await apiUploadKeys(auth, upload);

    const after = loadProfile(NAME);
    // The premise: a mint really happened, so the save under test really ran.
    expect(server.calls.auth, 'no mint occurred — the assertion below is vacuous').toBe(1);
    expect(after.authToken).toBe('fresh-1');
    // The finding, in the two fields the external write added.
    expect(after.ownerUserId, 'the mint erased the pairing this machine records').toBe(OWNER);
    expect(after.accountClass, 'the mint erased the account class').toBe('integration');
  });

  it('does the renewal ONCE for concurrent callers (single-flight)', async () => {
    // The REST prekey fetch and the WS dial can 401 within milliseconds of
    // each other, and every successful auth revokes the previous session — so
    // two concurrent mints would leave one caller holding a token the server
    // had already killed.
    const auth = new AuthSession(NAME, stores);
    await Promise.all([
      apiUploadKeys(auth, upload),
      apiUploadKeys(auth, upload),
      apiUploadKeys(auth, upload),
    ]);
    expect(server.calls.auth).toBe(1);
    expect(auth.reauthCount).toBe(1);
  });

  it('does the renewal ONCE for STAGGERED callers too, not just simultaneous ones', async () => {
    // The single-flight lock is cleared in `finally`, so on its own it only
    // ever covered 401s landing in the SAME TICK — which is not what the test
    // above's own comment describes ("within milliseconds of each other").
    //
    // Here both requests present the same dead bearer, but the second one's
    // 401 comes back after the first has already renewed. `mint()`'s
    // disk-adoption guard cannot catch that: by then `this.profile.authToken`
    // equals what is on disk, so it sees no change and signs a second
    // challenge. And since every successful auth REVOKES the previous session,
    // that second mint kills the token the first caller just adopted.
    // Measured before the fix: reauthCount = 2.
    server.slowKeysCall = 2;
    const auth = new AuthSession(NAME, stores);
    await Promise.all([apiUploadKeys(auth, upload), apiUploadKeys(auth, upload)]);

    expect(auth.reauthCount).toBe(1);
    expect(server.calls.auth).toBe(1);
    // Four attempts at the authed route: two refusals, two retries. Both
    // retries must have used the SAME token, which is what one mint means.
    expect(server.calls.keys).toBe(4);
  });

  it('retries exactly once — a second 401 is a real failure, not a loop', async () => {
    server.alwaysRefuse = true;
    const err = await apiUploadKeys(new AuthSession(NAME, stores), upload).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).exitCode).toBe(EXIT.AUTH);
    // Two attempts at the authed route, one renewal. Nothing more.
    expect(server.calls.keys).toBe(2);
    expect(server.calls.auth).toBe(1);
  });

  it('refuses to adopt a NEW userId for the same identity key', async () => {
    // `getOrCreateUserByIdentityKey` will CREATE an account for a known key
    // whose user row is gone — exactly what DELETE /v1/account leaves behind.
    // Adopting it would corrupt every ProtocolAddress in sessions/ and
    // identities/, which are keyed by userId.
    server.issuesUserId = '01BOBBOBBOBBOBBOBBOBBOBBOB';
    const err = await apiUploadKeys(new AuthSession(NAME, stores), upload).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).exitCode).toBe(EXIT.AUTH);
    expect((err as CliError).slug).toBe('account_gone');
    // Nothing was overwritten.
    expect(loadProfile(NAME).userId).toBe(USER_ID);
    expect(loadProfile(NAME).authToken).toBe('expired-30-days-ago');
  });

  it('does not loop on a 409 account_conflict', async () => {
    server.authStatus = 409;
    const err = await apiUploadKeys(new AuthSession(NAME, stores), upload).then(
      () => null,
      (e: unknown) => e,
    );
    expect((err as CliError).exitCode).toBe(EXIT.AUTH);
    expect(server.calls.auth).toBe(1);
  });

  it('adopts a token another process already wrote, with zero round trips', async () => {
    // Every successful auth revokes every prior session for that user, so two
    // long-lived CLIs under one client name would invalidate each other
    // forever. The file is the shared point of truth.
    const auth = new AuthSession(NAME, stores);
    server.live = 'written-by-the-other-process';
    saveProfile({ ...loadProfile(NAME), authToken: 'written-by-the-other-process' });

    await apiUploadKeys(auth, upload);
    expect(server.calls.auth).toBe(0);
    expect(server.calls.challenge).toBe(0);
    expect(auth.token()).toBe('written-by-the-other-process');
  });

  it('leaves a plain string token unrenewable', async () => {
    // A fixed credential opts out of renewal by construction; the union keeps
    // that choice explicit for callers that need it.
    const err = await apiUploadKeys('expired-30-days-ago', upload).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CliError);
    expect(server.calls.auth).toBe(0);
    expect(server.calls.keys).toBe(1);
  });
});

/**
 * `fetch` has no default timeout, and this one is not awaited in isolation.
 *
 * `call-session.ts` reaches `request()` from inside `sendEncrypted`, which
 * holds `sendChain` while it runs — so a request that never answers does not
 * cost one message, it wedges every later send in the process, silently and
 * forever. A group-call gate run ended that way: a client up, connected, and
 * emitting nothing, killed by the harness after a minute of it.
 *
 * The clock is faked so the budget can be spent in a millisecond, and the
 * stand-in `fetch` HONOURS THE ABORT SIGNAL — a mock that ignored it would
 * prove only that a signal was passed, not that anything acts on one.
 */
describe('the request budget: one stalled round trip must not wedge the process', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A server that accepts the request and then says nothing, ever. */
  function installSilentServer(): void {
    globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return; // unbounded: the pre-fix shape, and it hangs
        signal.addEventListener('abort', () =>
          reject(signal.reason ?? new Error('aborted')),
        );
      })) as typeof fetch;
  }

  /** A server that answers headers immediately, then never finishes the body. */
  function installStalledBodyServer(): void {
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      const signal = init?.signal;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          if (!signal) return; // unbounded: a missing signal makes the test fail
          const abort = () => controller.error(signal.reason ?? new Error('aborted'));
          if (signal.aborted) abort();
          else signal.addEventListener('abort', abort, { once: true });
        },
      });
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
  }

  it('abandons a request that never answers, and says TIMEOUT', async () => {
    vi.useFakeTimers();
    installSilentServer();

    // Settled through a recorder rather than awaited: an await against the
    // unbounded shape never returns, and a test that hangs reports nothing.
    let settled: unknown = 'PENDING';
    const call = apiUploadKeys(new AuthSession(NAME, stores), upload).then(
      value => (settled = value),
      (err: unknown) => (settled = err),
    );

    // Nine seconds in, the budget is not spent and the request still stands —
    // the bound must not be an early hangup.
    await vi.advanceTimersByTimeAsync(9_000);
    expect(settled).toBe('PENDING');

    // …and past ten it bites.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(settled).toBeInstanceOf(CliError);
    expect((settled as InstanceType<typeof CliError>).exitCode).toBe(EXIT.TIMEOUT);
    // Our prose and our number — never the runtime's abort message.
    expect((settled as Error).message).toContain('timed out after 10000ms');
    await call;
  });

  it('abandons a response whose headers arrive but whose body never finishes', async () => {
    vi.useFakeTimers();
    installStalledBodyServer();

    // Record settlement so the broken implementation fails by this test's
    // name after the fake clock moves, instead of hanging on the stalled body.
    let settled: unknown = 'PENDING';
    const call = apiAuthChallenge(upload.identityKey).then(
      value => (settled = value),
      (err: unknown) => (settled = err),
    );

    await vi.advanceTimersByTimeAsync(9_000);
    expect(settled).toBe('PENDING');

    await vi.advanceTimersByTimeAsync(2_000);
    expect(settled).toBeInstanceOf(CliError);
    expect((settled as InstanceType<typeof CliError>).exitCode).toBe(EXIT.TIMEOUT);
    expect((settled as Error).message).toContain('timed out after 10000ms');
    await call;
  });

  it('leaves a request that ANSWERS untouched — the budget is not a ceiling on success', async () => {
    // The body-consuming control. A bound that only rejected every response
    // after reading it would make the stalled-body test pass for the wrong
    // reason; this pins the ordinary headers-plus-JSON path by name.
    vi.useFakeTimers();
    install();

    let settled: unknown = 'PENDING';
    const call = apiAuthChallenge(upload.identityKey).then(
      value => (settled = value),
      (err: unknown) => (settled = err),
    );
    await vi.advanceTimersByTimeAsync(1);
    await call;

    expect(settled).toMatchObject({ challenge: 'bm9uY2U=' });
  });
});
