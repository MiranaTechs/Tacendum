/**
 * CALL-ENABLED COMMANDS COULD NOT RENEW CREDENTIALS.
 *
 * `CallSession` passed `profile.authToken` — a fixed string, which the
 * Credential union (api.ts) defines as "never renew" — to both `WsClient`
 * and the prekey fetch. So when the stored token hit its 30-day expiry,
 * `tacendum call` and `tacendum listen --calls` died at the ws-ticket mint
 * with EXIT.AUTH while plain `send` and `listen` renewed transparently:
 * the day-31 failure, but only for the call-enabled commands.
 *
 * These tests drive the REAL `CallSession.connect()` and `placeCall()`
 * against a fake server with the renewal contract (one live token, 401 for
 * anything else, every successful auth revokes the last) — not a locally
 * restated predicate, because a test that re-implements the credential
 * plumbing it is testing would stay green through the exact revert it
 * exists to catch. Reverting either call site to the string makes the
 * corresponding test fail with the AUTH error users saw.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PrekeyBundle } from '@tacendum/shared';

const { dialled, sent } = vi.hoisted(() => ({
  dialled: [] as string[],
  sent: [] as string[],
}));

vi.mock('ws', () => {
  // Enough of `ws` for a dial to complete: record the URL, open on the next
  // tick, capture outgoing frames. `off` is load-bearing — `dial`'s `stop()`
  // deregisters its handshake listeners, and a fake without it hangs the
  // handshake promise instead of failing (see ws-ticket-fallback.test.ts).
  class FakeWebSocket {
    handlers: Record<string, Array<(...a: unknown[]) => void>> = {};
    constructor(url: string) {
      dialled.push(url);
      setTimeout(() => {
        for (const h of this.handlers.open ?? []) h();
      }, 0);
    }
    on(event: string, cb: (...a: unknown[]) => void) {
      (this.handlers[event] ??= []).push(cb);
      return this;
    }
    off(event: string, cb: (...a: unknown[]) => void) {
      this.handlers[event] = (this.handlers[event] ?? []).filter(h => h !== cb);
      return this;
    }
    removeAllListeners() {
      this.handlers = {};
      return this;
    }
    close() {}
    send(data: string) {
      sent.push(data);
    }
  }
  return { default: FakeWebSocket };
});

// Set BEFORE the src imports below: config.ts snapshots TACENDUM_API at module
// evaluation, and a top-level `await import` evaluates during collection.
const home = mkdtempSync(join(tmpdir(), 'tacendum-callcreds-'));
const previousHome = process.env.TACENDUM_HOME;
const previousApi = process.env.TACENDUM_API;
process.env.TACENDUM_HOME = home;
process.env.TACENDUM_API = 'http://callcreds.test';

const { FileStores } = await import('../src/stores.js');
const { generateAndStoreKeys } = await import('../src/messaging.js');
const { CallSession } = await import('../src/call-session.js');
const { saveProfile } = await import('../src/profile.js');

const CALLER = 'cs-caller';
const CALLER_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const PEER_ID = '01BOBBOBBOBBOBBOBBOBBOBBOB';

const callerStores = new FileStores(CALLER);
const callerUpload = await generateAndStoreKeys(callerStores);
// A REAL peer bundle, so establishSession and the offer's encrypt run through
// libsignal for real instead of a stub proving only that a mock
// was called.
const peerUpload = await generateAndStoreKeys(new FileStores('cs-peer'));
const peerBundle: PrekeyBundle = {
  userId: PEER_ID,
  registrationId: peerUpload.registrationId,
  identityKey: peerUpload.identityKey,
  signedPrekey: peerUpload.signedPrekey,
  kyberPrekey: peerUpload.kyberPrekey,
  oneTimePrekey: peerUpload.oneTimePrekeys[0],
};

/** The renewal contract, same shape as reauth.test.ts: one live token, 401 for any
 * other bearer, counters so a test can assert renewal HAPPENED. */
let server: {
  live: string;
  calls: { challenge: number; auth: number; ticket: number; keys: number };
  minted: number;
};

const realFetch = globalThis.fetch;

function install(): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input).replace('http://callcreds.test', '');
    const bearer = String(
      (init?.headers as Record<string, string> | undefined)?.authorization ?? '',
    ).replace('Bearer ', '');
    const json = (status: number, body: unknown): Response =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    const refuse = (): Response =>
      json(401, { error: { code: 'unauthorized', detail: 'missing or invalid bearer token' } });

    if (path === '/v1/auth/challenge') {
      server.calls.challenge += 1;
      return json(200, {
        challenge: Buffer.from('nonce').toString('base64'),
        expiresAt: Math.floor(Date.now() / 1000) + 120,
      });
    }
    if (path === '/v1/auth') {
      server.calls.auth += 1;
      server.minted += 1;
      server.live = `fresh-${server.minted}`;
      return json(200, { userId: CALLER_ID, authToken: server.live });
    }
    if (path === '/v1/ws-ticket') {
      server.calls.ticket += 1;
      if (bearer !== server.live) return refuse();
      return json(200, { ticket: `tkt-${server.calls.ticket}`, expiresAt: 1 });
    }
    if (path === `/v1/keys/${PEER_ID}`) {
      server.calls.keys += 1;
      if (bearer !== server.live) return refuse();
      return json(200, peerBundle);
    }
    throw new Error(`unexpected request ${path}`);
  }) as typeof fetch;
}

function reset(storedToken: string): void {
  server = {
    live: 'live-0',
    calls: { challenge: 0, auth: 0, ticket: 0, keys: 0 },
    minted: 0,
  };
  saveProfile({
    name: CALLER,
    identityKey: callerUpload.identityKey,
    userId: CALLER_ID,
    authToken: storedToken,
    registrationId: callerUpload.registrationId,
    deviceId: 1,
  });
  dialled.length = 0;
  sent.length = 0;
}

beforeEach(() => {
  install();
});
afterEach(() => {
  globalThis.fetch = realFetch;
});
afterAll(() => {
  if (previousHome === undefined) delete process.env.TACENDUM_HOME;
  else process.env.TACENDUM_HOME = previousHome;
  if (previousApi === undefined) delete process.env.TACENDUM_API;
  else process.env.TACENDUM_API = previousApi;
});

describe('call-enabled commands renew credentials like everything else', () => {
  it('connect() renews a dead token instead of failing — the day-31 dial', async () => {
    // The stored token expired while nobody was calling. Before the fix this
    // rejected EXIT.AUTH at the ws-ticket mint: the mint's 401 reached
    // WsClient.connect as a handshake refusal, but the credential was a
    // string, so the renewal branch was unreachable by construction.
    reset('expired-30-days-ago');
    const session = new CallSession(CALLER);
    try {
      await session.connect();
    } finally {
      session.close();
    }

    // One refusal, one mint, one successful dial — not a loop.
    expect(server.calls.auth).toBe(1);
    expect(server.calls.ticket).toBe(2);
    expect(dialled).toHaveLength(1);
    expect(dialled[0]).toContain('ticket=');
    // The dead token never reached a URL, renewed or not.
    expect(dialled[0]).not.toContain('expired-30-days-ago');
  });

  it('placeCall renews when the prekey fetch is refused mid-session', async () => {
    // Connect while the token is still live, THEN revoke it — the shape of a
    // second process under the same name having minted (every successful auth
    // revokes the last). This isolates the prekey-fetch call site: a partial
    // revert that fixes only the dial would still fail here.
    reset('live-0');
    const session = new CallSession(CALLER);
    try {
      await session.connect();
      expect(server.calls.auth).toBe(0); // the token was good; nothing minted

      server.live = 'revoked-by-another-process';
      await session.runner.placeCall(PEER_ID, false);
    } finally {
      session.close();
    }

    // One 401, one mint, one retry that succeeded.
    expect(server.calls.auth).toBe(1);
    expect(server.calls.keys).toBe(2);
    // The offer actually went out, through the real ratchet: first contact,
    // so the envelope is a prekey message addressed to the peer.
    const frames = sent.map(f => JSON.parse(f) as { type: string; to?: string; msgType?: string });
    const offer = frames.find(f => f.type === 'send');
    expect(offer).toBeDefined();
    expect(offer?.to).toBe(PEER_ID);
    expect(offer?.msgType).toBe('prekey');
  });
});
