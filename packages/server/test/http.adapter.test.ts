import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { SOURCE_LINK_REL } from '../src/handlers/auth-account.js';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { AGPL_SOURCE_URL_DEFAULT } from '@tacendum/shared';
import { createHttpServer } from '../src/local/http.js';
import type { Deps } from '../src/handlers/http.js';
import { makeMemoryCallMetricStore } from '../src/call-metrics.js';
import { makeMemoryDb, makeTestDeps } from './helpers.js';

/**
 * The HTTP adapter itself (routing, path params, malformed input) — unit tests
 * bypass it, so this exercises the real node:http request path. In particular a
 * malformed percent-encoded URL must be a 400, never a process crash.
 */

let server: Server;
let base: string;
let deps: Deps;
const SESSION_TOKEN = 'local-call-metric-token';
const SESSION_USER = 'local-call-metric-user';

beforeAll(async () => {
  deps = makeTestDeps(makeMemoryDb());
  server = createHttpServer(deps);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  base = `http://localhost:${port}`;
});

afterAll(() => {
  server.close();
});

describe('http adapter', () => {
  it('serves /health', async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('routes DELETE /v1/account behind auth (401 without a token, not 404)', async () => {
    const res = await fetch(`${base}/v1/account`, { method: 'DELETE' });
    expect(res.status).toBe(401);
  });

  it('routes POST /v1/call-metrics behind auth, publishing only the authenticated request', async () => {
    await deps.db.createUser({ userId: SESSION_USER, createdAt: deps.now() });
    await deps.db.createSession({
      token: SESSION_TOKEN,
      userId: SESSION_USER,
      createdAt: deps.now(),
      expiresAt: Math.floor(deps.now() / 1000) + 3600,
    });
    const published: unknown[][] = [];
    deps.callMetrics = {
      store: makeMemoryCallMetricStore(),
      publisher: { publish: async (data) => void published.push([...data]) },
    };
    const body = JSON.stringify({
      reportId: '01K2ABCDEF0123456789ABCDEG',
      occurredAt: deps.now(),
      scope: 'direct',
      media: 'audio',
      answered: false,
      connected: false,
      outcome: 'unanswered',
    });

    const authenticated = await fetch(`${base}/v1/call-metrics`, {
      method: 'POST',
      headers: { authorization: `Bearer ${SESSION_TOKEN}`, 'content-type': 'application/json' },
      body,
    });
    const anonymous = await fetch(`${base}/v1/call-metrics`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });

    expect(authenticated.status).toBe(204);
    expect(anonymous.status).toBe(401);
    expect(published).toHaveLength(1);
  });

  it('does NOT crash on a malformed percent-encoded URL (regression)', async () => {
    // %%%A is invalid UTF-8 percent-encoding -> decodeURIComponent throws.
    const res = await fetch(`${base}/v1/keys/%E0%A4%A`);
    expect([400, 401]).toContain(res.status); // handled, not a dropped socket
    // Server is still alive:
    const health = await fetch(`${base}/health`);
    expect(health.status).toBe(200);
  });

  it('bare "%" in the path is a 400, not a crash', async () => {
    const res = await fetch(`${base}/v1/keys/%`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_request');
    expect((await fetch(`${base}/health`)).status).toBe(200);
  });

  it('404s an unknown route', async () => {
    const res = await fetch(`${base}/nope`);
    expect(res.status).toBe(404);
  });

  it('routes POST /v1/auth/challenge through the real adapter (200)', async () => {
    // The only unauthenticated route the local host still serves, and the one
    // that replaced POST /v1/register when the phone number was deleted
    // A 33-byte 0x05-prefixed key in canonical
    // base64: the DTO validates the shape before anything is stored.
    const identityKey = Buffer.concat([
      Buffer.from([0x05]),
      Buffer.alloc(32, 0x7a),
    ]).toString('base64');
    const res = await fetch(`${base}/v1/auth/challenge`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identityKey }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { challenge: string; expiresAt: number };
    expect(body.challenge).toBeTruthy();
  });

  it('extracts the :userId path param (401 without auth, not 404)', async () => {
    const res = await fetch(`${base}/v1/keys/some-user-id`);
    expect(res.status).toBe(401); // matched the route, failed auth
  });

  it('refuses an oversized body and stays alive', async () => {
    const big = 'x'.repeat(1024 * 1024 + 10);
    // The server rejects with 413; depending on client/socket timing the huge
    // upload may instead surface as a connection error. Either proves refusal —
    // what must hold is that the process survives.
    let status = 0;
    try {
      const res = await fetch(`${base}/v1/auth/challenge`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ identityKey: big }),
      });
      status = res.status;
    } catch {
      status = -1; // connection refused/reset — also an acceptable rejection
    }
    expect([413, -1]).toContain(status);
    expect((await fetch(`${base}/health`)).status).toBe(200);
  });

  it('rejects an oversized bearer token as 401, not 500', async () => {
    const res = await fetch(`${base}/v1/keys/some-user-id`, {
      headers: { authorization: `Bearer ${'A'.repeat(5000)}` },
    });
    expect(res.status).toBe(401);
  });
});

/**
 * The AGPL source offer, ON THE WIRE.
 *
 * Here rather than in auth-account.test.ts because the header is the LOCAL
 * HOST's, not the handlers' — the handlers only set the body field on their two
 * success shapes, and the whole reason the header lives at the boundary is to
 * reach the refusals no handler returns from. That boundary is `send` ->
 * `res.writeHead`, which unit tests bypass entirely, and writeHead is also the
 * thing that throws on a bad header value. Both properties below are therefore
 * only observable against a real node:http response.
 *
 * These run LAST in the file on purpose: the auth bucket is per-IP and every
 * request here shares localhost's, so anything appended after them inherits a
 * partly-spent bucket.
 */
describe('the AGPL source offer on the wire', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const LINK = `<${AGPL_SOURCE_URL_DEFAULT}>; rel="${SOURCE_LINK_REL}"`;
  const identityKey = Buffer.concat([Buffer.from([0x05]), Buffer.alloc(32, 0x6b)]).toString(
    'base64',
  );
  const postJson = (path: string, body: unknown): Promise<Response> =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('rides a successful challenge as both a Link header and a body field', async () => {
    const res = await postJson('/v1/auth/challenge', { identityKey });

    expect(res.status).toBe(200);
    expect(res.headers.get('link')).toBe(LINK);
    expect(((await res.json()) as { source?: string }).source).toBe(AGPL_SOURCE_URL_DEFAULT);
  });

  it('rides a REFUSED sign-in too, because a rejected caller is still a remote user', async () => {
    // The finding this exists for: the offer used to be added at the two
    // success exits, so every one of the eleven refusals in auth-account.ts
    // shipped without it — and a caller who never gets past 401 is precisely
    // the remote user is written about. Nothing but the boundary makes
    // this true, which is why it is asserted through the boundary.
    // A REAL challenge first, then a bad signature over it. The earlier version
    // of this test invented a challenge that had never been issued, so it was
    // refused as `invalid_challenge` before verification was ever reached — it
    // passed, it asserted a 401, and the 401 was not the one in its name. The
    // error code is now pinned so it cannot drift back.
    const issued = (await (await postJson('/v1/auth/challenge', { identityKey })).json()) as {
      challenge: string;
    };
    const res = await postJson('/v1/auth', {
      identityKey,
      challenge: issued.challenge,
      signature: Buffer.alloc(64, 0x22).toString('base64'),
    });

    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('invalid_signature');
    expect(res.headers.get('link')).toBe(LINK);
  });

  it('does not appear on the eighteen routes AGPL says nothing about', async () => {
    // The other half of the scoping decision, and the reason the predicate is a
    // two-entry list rather than a `/v1/auth` prefix test: an offer printed on
    // routes it was never made for is a claim nobody checked.
    expect((await fetch(`${base}/health`)).headers.get('link')).toBeNull();
    expect((await fetch(`${base}/v1/keys/some-user-id`)).headers.get('link')).toBeNull();
    expect((await fetch(`${base}/nope`)).headers.get('link')).toBeNull();

    // DISCRIMINATING, which the three above are not on their own: none of them
    // starts with `/v1/auth`, so this test used to pass just as well against a
    // `startsWith('/v1/auth')` predicate. A path under the auth prefix that is
    // not an auth route is the case that separates the two.
    expect((await fetch(`${base}/v1/auth/challenge/extra`)).headers.get('link')).toBeNull();
    expect((await fetch(`${base}/v1/authorize`)).headers.get('link')).toBeNull();

    // And the METHOD half, which a path-keyed predicate also got wrong: routing
    // matches method AND path, so `GET /v1/auth` is a 404, not the auth route.
    // Keyed on path alone it was handed an offer anyway (verified before the
    // fix: `GET /v1/auth`, `GET /v1/auth/challenge` and `DELETE /v1/auth` all
    // returned a Link-bearing 404).
    for (const [method, path] of [
      ['GET', '/v1/auth'],
      ['GET', '/v1/auth/challenge'],
      ['DELETE', '/v1/auth'],
    ] as const) {
      const res = await fetch(`${base}${path}`, { method });
      expect(res.status, `${method} ${path}`).toBe(404);
      expect(res.headers.get('link'), `${method} ${path}`).toBeNull();
    }
  });

  it('survives a source URL Node cannot put in a header, instead of 500ing sign-in', async () => {
    // Verified as a live defect before the filter existed: an em dash in
    // TACENDUM_SOURCE_URL made writeHead throw ERR_INVALID_CHAR, and every call
    // on both auth routes became a 500 — sign-in taken down BY the licence
    // notice. The value is read per request, so stubbing it here reaches the
    // running server.
    vi.stubEnv('TACENDUM_SOURCE_URL', 'https://github.com/MiranaTechs/Tacendum/tree/v1.2.3—rc1');

    const res = await postJson('/v1/auth/challenge', { identityKey });

    expect(res.status).toBe(200);
    expect(res.headers.get('link')).toBe(LINK);
    expect((await fetch(`${base}/health`)).status).toBe(200);
  });

  it('puts a configured release tag on the wire verbatim', async () => {
    const tagged = 'https://github.com/MiranaTechs/Tacendum/tree/v9.9.9';
    vi.stubEnv('TACENDUM_SOURCE_URL', tagged);

    const res = await postJson('/v1/auth/challenge', { identityKey });

    expect(res.status).toBe(200);
    expect(res.headers.get('link')).toBe(`<${tagged}>; rel="${SOURCE_LINK_REL}"`);
  });
});
