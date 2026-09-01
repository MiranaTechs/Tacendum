/**
 * The WebSocket ticket's DOWNGRADE RULE, driven through the REAL `WsClient`.
 *
 * A dial mints a single-use ticket over HTTPS and puts only that in the socket
 * URL, because a URL is written into proxy logs, access logs and crash
 * reporters and the bearer is good for thirty days on every route.
 *
 * That leaves one question with a security answer: what happens when the mint
 * fails? The first implementation fell back to `?token=` on ANY failure, which
 * hands the original defect to anyone who can break a single request — a 500, a
 * 429, a WAF rule — while the socket host stays up and the client connects
 * happily carrying a month-long credential in a logged URL.
 *
 * So exactly one failure may downgrade: 404, meaning this server predates the
 * route. And since the gates flagged even that as a silent security downgrade
 *, a 404 now refuses with an actionable error unless the
 * operator has explicitly set TACENDUM_ALLOW_TOKEN_IN_URL=1 — and tells them on
 * stderr each time the acknowledged downgrade actually happens.
 *
 * WHY THIS DRIVES `connect()` RATHER THAN RESTATING THE RULE. An earlier version
 * of this file asserted a locally reimplemented predicate — and a review caught
 * that mutating `wsclient.ts` to fall back on every error, or deleting ticket
 * dialling outright, left every test here green. A test that re-implements the
 * thing it is testing tests nothing, which is the exact failure this whole
 * change has already made twice. The stub server and the fake socket are here
 * so the assertions can be about the URL the production code actually dialled.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

/** Every URL the production code has dialled, in order. */
const { dialled, sockets, fake } = vi.hoisted(() => ({
  dialled: [] as string[],
  sockets: [] as Array<{ handlers: Record<string, Array<(...a: unknown[]) => void>> }>,
  // `throwOnConstruct` reproduces the real `ws` failure mode the leak tests
  // below exist for: its constructor throws a SyntaxError that QUOTES the
  // whole dial URL, credential included (verified against ws 8.x:
  // `new WebSocket('ws:///?ticket=SECRET')` throws
  // "Invalid URL: ws:///?ticket=SECRET").
  fake: { throwOnConstruct: false },
}));

vi.mock('ws', () => {
  // Enough of `ws` to let `dial` complete: record the URL, then open on the
  // next tick so the handshake promise resolves.
  class FakeWebSocket {
    handlers: Record<string, Array<(...a: unknown[]) => void>> = {};
    constructor(url: string) {
      if (fake.throwOnConstruct) {
        throw new SyntaxError(`Invalid URL: ${url}`);
      }
      dialled.push(url);
      sockets.push(this);
      setTimeout(() => {
        for (const h of this.handlers.open ?? []) h();
      }, 0);
    }
    on(event: string, cb: (...a: unknown[]) => void) {
      (this.handlers[event] ??= []).push(cb);
      return this;
    }
    // `off` is not optional decoration: `dial`'s `stop()` deregisters all three
    // handshake listeners, so a fake without it throws inside the 'open'
    // callback, the handshake promise never settles, and the test times out at
    // fifteen seconds looking like a hang rather than a missing method.
    off(event: string, cb: (...a: unknown[]) => void) {
      this.handlers[event] = (this.handlers[event] ?? []).filter(h => h !== cb);
      return this;
    }
    removeAllListeners() {
      this.handlers = {};
      return this;
    }
    close() {}
    send() {}
  }
  return { default: FakeWebSocket };
});

let reply: { status: number; body: string } = { status: 200, body: '{}' };
let lastRequest: { url?: string; auth?: string } = {};

/*
 * The stub server is stood up and TACENDUM_API is set at MODULE TOP LEVEL,
 * before `../src/api.js` is imported — not in `beforeAll`.
 *
 * `config.ts` reads `process.env.TACENDUM_API` once, at module evaluation, and
 * a top-level `await import` evaluates during collection, which happens BEFORE
 * any hook runs. Setting the variable in `beforeAll` is therefore too late:
 * `API_BASE` keeps its production default and every request in this file goes
 * to the real api.tacendum.com. That is not a hypothetical — it is what the
 * first version of this file did, and the giveaway was a uniform 404 on cases
 * that stub a 200. (At the time production 404'd; the route has since been
 * verified DEPLOYED — a credential-free POST to /v1/ws-ticket returns 401
 * where a nonexistent sibling returns 404 — so the fail-closed refusal under
 * test here does NOT lock clients out of production, and an accidental hit
 * would now show up as a 401.)
 */
const server = createServer((req, res) => {
  lastRequest = { url: req.url, auth: req.headers.authorization };
  res.writeHead(reply.status, { 'content-type': 'application/json' });
  res.end(reply.body);
});
await new Promise<void>(resolve => {
  server.listen(0, '127.0.0.1', resolve);
});
const previousApi = process.env.TACENDUM_API;
const previousWs = process.env.TACENDUM_WS;
process.env.TACENDUM_API = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
process.env.TACENDUM_WS = 'ws://127.0.0.1:1';

const { apiWsTicket } = await import('../src/api.js');
const { WsClient } = await import('../src/wsclient.js');
const { CliError, EXIT } = await import('../src/exit.js');
// The SNAPSHOT the production code actually uses, not the mutable environment.
const { API_BASE } = await import('../src/config.js');

afterAll(async () => {
  // Restored so a later file in the same worker inherits nothing from here.
  if (previousApi === undefined) delete process.env.TACENDUM_API;
  else process.env.TACENDUM_API = previousApi;
  if (previousWs === undefined) delete process.env.TACENDUM_WS;
  else process.env.TACENDUM_WS = previousWs;
  await new Promise<void>(resolve => {
    server.close(() => resolve());
  });
});

beforeEach(() => {
  dialled.length = 0;
  sockets.length = 0;
  fake.throwOnConstruct = false;
  // A deterministic baseline: the opt-in must come from the test that means it,
  // never from the ambient environment of whoever ran the suite.
  delete process.env.TACENDUM_ALLOW_TOKEN_IN_URL;
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete process.env.TACENDUM_ALLOW_TOKEN_IN_URL;
});

it('the code under test is pointed at the stub, not at production', () => {
  // Asserts the SNAPSHOTTED base, because that is what `request()` builds URLs
  // from. Checking `process.env` instead would stay green if the import order
  // ever regressed such that config.ts evaluated before the assignment above —
  // which is precisely the failure being guarded, and it would then send every
  // request in this file to the live API.
  expect(API_BASE).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
});

describe('minting a ticket', () => {
  it('sends the bearer in the Authorization HEADER, never in the URL', async () => {
    const ticket = 'abc-DEF_123';
    reply = { status: 200, body: JSON.stringify({ ticket, expiresAt: 1 }) };

    expect(await apiWsTicket('bearer-value')).toBe(ticket);
    expect(lastRequest.auth).toBe('Bearer bearer-value');
    expect(lastRequest.url).toBe('/v1/ws-ticket');
    expect(lastRequest.url).not.toContain('bearer-value');
  });

  it('accepts a base64url ticket, which is what the server actually mints', async () => {
    // `randomBytes(32).toString('base64url')` yields `-` and `_`. Validating
    // against standard base64 rejected 73.5% of real tickets, and the client
    // then quietly dialled with the bearer instead.
    reply = { status: 200, body: JSON.stringify({ ticket: 'aB3-_xyz', expiresAt: 1 }) };
    await expect(apiWsTicket('bearer-value')).resolves.toBe('aB3-_xyz');
  });

  const cases: Array<[number, string]> = [
    [404, 'route missing — the one benign case, an old server'],
    [429, 'rate limited — attacker-inducible, must NOT downgrade'],
    [500, 'server error — must NOT downgrade'],
    [503, 'unavailable — must NOT downgrade'],
  ];
  for (const [status, why] of cases) {
    it(`carries ${status} through to CliError.status (${why})`, async () => {
      reply = { status, body: JSON.stringify({ error: { code: 'x', detail: 'y' } }) };
      await expect(apiWsTicket('bearer-value')).rejects.toSatisfy(
        (err: unknown) => err instanceof CliError && err.status === status,
      );
    });
  }
});

describe('what WsClient actually dials', () => {
  // These drive the real `connect()` -> `dial()`. Mutating wsclient.ts to
  // downgrade on any error, or to stop minting at all, fails them.

  it('puts the TICKET in the URL and the bearer nowhere in it', async () => {
    reply = { status: 200, body: JSON.stringify({ ticket: 'tkt-XYZ_1', expiresAt: 1 }) };

    await new WsClient().connect('bearer-value');

    expect(dialled).toHaveLength(1);
    expect(dialled[0]).toContain('ticket=tkt-XYZ_1');
    expect(dialled[0]).not.toContain('token=');
    expect(dialled[0]).not.toContain('bearer-value');
  });

  it('REFUSES on 404 without the opt-in: told, not silently downgraded', async () => {
    // The defect this closes: the pre-ticket fallback used to engage
    // silently, so an operator on an old server had a 30-day bearer in their
    // intermediary logs and no way to know. Now the dial fails with an error
    // that names both remedies (upgrade, or opt in) — and carries no token.
    reply = { status: 404, body: JSON.stringify({ error: { code: 'not_found', detail: 'no route' } }) };

    const failure = await new WsClient().connect('bearer-value').then(
      () => undefined,
      (err: unknown) => err,
    );

    expect(failure).toBeInstanceOf(CliError);
    expect((failure as InstanceType<typeof CliError>).status).toBe(404);
    expect((failure as Error).message).toContain('TACENDUM_ALLOW_TOKEN_IN_URL');
    expect((failure as Error).message).not.toContain('bearer-value');
    expect(dialled).toHaveLength(0);
  });

  it('downgrades to ?token= on 404 when the operator has opted in — and says so on stderr', async () => {
    // the design plan's transition window, kept: a pre-ticket server is still
    // reachable, but only by explicit acknowledgement, and each downgraded dial
    // announces itself (without the credential) so the exposure is in the
    // transcript, not just in the operator's memory of setting a variable.
    reply = { status: 404, body: JSON.stringify({ error: { code: 'not_found', detail: 'no route' } }) };
    process.env.TACENDUM_ALLOW_TOKEN_IN_URL = '1';
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await new WsClient().connect('bearer-value');

    expect(dialled).toHaveLength(1);
    expect(dialled[0]).toContain('token=bearer-value');
    const written = stderr.mock.calls.map(args => String(args[0])).join('');
    expect(written).toContain('TACENDUM_ALLOW_TOKEN_IN_URL');
    expect(written).not.toContain('bearer-value');
  });

  for (const value of ['0', 'true', 'yes', '']) {
    it(`treats TACENDUM_ALLOW_TOKEN_IN_URL=${JSON.stringify(value)} as NOT opted in`, async () => {
      // Only the exact value '1' acknowledges the downgrade. Loose truthiness
      // would make `=0` — somebody's attempt to turn it OFF — put the bearer in
      // the URL, which is the worst possible reading of that intent.
      reply = { status: 404, body: '{}' };
      process.env.TACENDUM_ALLOW_TOKEN_IN_URL = value;

      await expect(new WsClient().connect('bearer-value')).rejects.toThrow();
      expect(dialled).toHaveLength(0);
    });
  }

  for (const status of [429, 500, 503]) {
    it(`opting in does NOT widen the downgrade beyond 404 (still refuses on ${status})`, async () => {
      // The opt-in acknowledges ONE thing: this server predates the route. It
      // must not also hand an attacker the on-demand downgrade — break one
      // mint request with a 429/500 and harvest the bearer from the URL.
      reply = { status, body: '{}' };
      process.env.TACENDUM_ALLOW_TOKEN_IN_URL = '1';

      await expect(new WsClient().connect('bearer-value')).rejects.toThrow();
      expect(dialled).toHaveLength(0);
    });
  }

  for (const status of [400, 401, 403, 429, 500, 502, 503]) {
    it(`refuses to dial at all on ${status}`, async () => {
      // The security property: a failed dial is better than a dial carrying a
      // thirty-day credential in a URL that gets logged. If this ever starts
      // dialling, the bearer is back in the query string.
      reply = { status, body: JSON.stringify({ error: { code: 'x', detail: 'y' } }) };

      await expect(new WsClient().connect('bearer-value')).rejects.toThrow();
      expect(dialled).toHaveLength(0);
    });
  }

  it('never lets the bearer reach a URL on any failure status', async () => {
    // The invariant behind every case above, asserted once over all of them so
    // a newly added status cannot quietly opt out of it.
    for (const status of [400, 401, 403, 429, 500, 502, 503]) {
      reply = { status, body: '{}' };
      await new WsClient().connect('bearer-value').catch(() => undefined);
    }
    expect(dialled.join('|')).not.toContain('bearer-value');
  });
});

describe('what never reaches an error message (an earlier review)', () => {
  // The gate's headline: the opt-in path leaked the token it exists to
  // protect. `ws` rejects an unusable URL by THROWING a SyntaxError that
  // quotes the whole dial URL — credential included — and that throw
  // propagated to stderr and into the --json error object. These tests pin
  // the two halves of the fix (validate before a credential exists; replace
  // any constructor throw with fixed prose) and extend the same rule to the
  // server-chosen fields of an error frame.

  it('refuses an unusable WebSocket endpoint BEFORE any credential exists to leak', async () => {
    // TACENDUM_WS='ws:///' is the gate's black-box repro: against the real
    // `ws`, the constructor throws "Invalid URL: ws:///?ticket=..." — so the
    // dial must fail while the URL is still credential-free, before a
    // single-use ticket has even been minted for it. WS_URL is snapshotted at
    // config evaluation, so the module graph is re-imported fresh under the
    // bad value; CliError identity differs across graphs, which is why the
    // assertions are structural rather than instanceof.
    reply = { status: 200, body: JSON.stringify({ ticket: 'CANARY_TKT', expiresAt: 1 }) };
    const goodWs = process.env.TACENDUM_WS;
    try {
      process.env.TACENDUM_WS = 'ws:///';
      vi.resetModules();
      const { WsClient: FreshWsClient } = await import('../src/wsclient.js');
      lastRequest = {};

      const failure = await new FreshWsClient().connect('bearer-value').then(
        () => undefined,
        (err: unknown) => err,
      );

      expect(failure).toBeInstanceOf(Error);
      const msg = (failure as Error).message;
      expect(msg).not.toContain('bearer-value');
      expect(msg).not.toContain('CANARY_TKT');
      expect(msg).not.toContain('ws:///');
      // The remedy is named without the value being echoed.
      expect(msg).toContain('TACENDUM_WS');
      expect(dialled).toHaveLength(0);
      // No mint happened: the ticket was not spent on an undialable endpoint.
      expect(lastRequest.url).toBeUndefined();
    } finally {
      process.env.TACENDUM_WS = goodWs;
      vi.resetModules();
    }
  });

  it('replaces a WebSocket constructor throw with fixed prose — the dial URL never enters an error', async () => {
    // Belt to the validation's braces: even when the endpoint LOOKED valid,
    // anything the constructor throws quotes the URL, which by then carries
    // the ticket. The fake reproduces ws 8.x's exact throw shape.
    reply = { status: 200, body: JSON.stringify({ ticket: 'CANARY_TKT', expiresAt: 1 }) };
    fake.throwOnConstruct = true;

    const failure = await new WsClient().connect('bearer-value').then(
      () => undefined,
      (err: unknown) => err,
    );

    expect(failure).toBeInstanceOf(CliError);
    const msg = (failure as Error).message;
    expect(msg).not.toContain('CANARY_TKT');
    expect(msg).not.toContain('bearer-value');
    expect(msg).not.toContain('Invalid URL');
    expect(msg).not.toContain('127.0.0.1');
  });

  it('keeps server-chosen error-frame code and detail OUT of the rejection message', async () => {
    // `frame.code` and `frame.detail` are plain z.string()s the server picks.
    // Control-byte stripping and truncation do not redact a credential or an
    // account name a server reflects back, and this message reaches stderr
    // and --json. Unrecognized codes still classify (EXIT.ERROR) — they are
    // just not echoed.
    reply = { status: 200, body: JSON.stringify({ ticket: 't1', expiresAt: 1 }) };
    const client = new WsClient();
    await client.connect('bearer-value');

    const wait = client.waitFor(() => false, 5_000);
    const socket = sockets[0];
    const frame = JSON.stringify({
      type: 'error',
      code: 'CANARY_CODE_abc',
      detail: 'CANARY_DETAIL_xyz',
    });
    for (const h of socket.handlers.message ?? []) h(frame);

    const failure = await wait.then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(failure).toBeInstanceOf(CliError);
    expect((failure as InstanceType<typeof CliError>).exitCode).toBe(EXIT.ERROR);
    const msg = (failure as Error).message;
    expect(msg).not.toContain('CANARY_CODE');
    expect(msg).not.toContain('CANARY_DETAIL');
  });

  it('still echoes and classifies a code that matches this build\'s own table', async () => {
    // The guard against overcorrection: when the code string-matches one of
    // our own literals, the bytes shown are ours — the server merely selected
    // among them — and the exit code still carries the classification.
    reply = { status: 200, body: JSON.stringify({ ticket: 't2', expiresAt: 1 }) };
    const client = new WsClient();
    await client.connect('bearer-value');

    const wait = client.waitFor(() => false, 5_000);
    const socket = sockets[0];
    const frame = JSON.stringify({ type: 'error', code: 'unknown_recipient', detail: 'x' });
    for (const h of socket.handlers.message ?? []) h(frame);

    const failure = await wait.then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(failure).toBeInstanceOf(CliError);
    expect((failure as InstanceType<typeof CliError>).exitCode).toBe(EXIT.RECIPIENT);
    expect((failure as Error).message).toContain('unknown_recipient');
  });
});
