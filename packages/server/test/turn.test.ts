import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { TurnCredentialsResponse } from '@tacendum/shared';
import { turnCredentialsHandler } from '../src/handlers/turn.js';
import type { AuthContext, HttpEvent } from '../src/handlers/http.js';
import { makeMemoryDb, makeTestDeps, parseBody, type TestDeps } from './helpers.js';

/**
 * POST /v1/turn-credentials. coturn's `use-auth-secret`
 * scheme: the server mints a short-lived username/credential pair that the
 * relay validates offline with a shared secret — no per-call server call.
 *
 * The security-relevant property is NOT the HMAC (it authorizes relay access
 * and protects no user content, (4)). It is that the username the relay
 * sees is a SALTED HASH of the userId, so relay logs cannot be correlated to
 * the messaging tables.
 */

const AUTH: AuthContext = { userId: 'user-1' };
const OTHER: AuthContext = { userId: 'user-2' };
const SECRET = 'static-auth-secret-for-tests';
const SALT = 'turn-user-salt-for-tests';

function post(): HttpEvent {
  return { method: 'POST', path: '/v1/turn-credentials', headers: {}, body: '{}' };
}

let deps: TestDeps;
beforeEach(() => {
  deps = makeTestDeps(makeMemoryDb());
  deps.turn = {
    urls: [
      'stun:turn.tacendum.com:3478',
      'turn:turn.tacendum.com:3478?transport=udp',
      'turns:turn.tacendum.com:443?transport=tcp',
    ],
    authSecret: SECRET,
    userSalt: SALT,
    ttlSeconds: 12 * 3600,
  };
});

describe('minting', () => {
  it('returns a schema-valid credential set', async () => {
    const result = await turnCredentialsHandler(post(), deps, AUTH);
    expect(result.statusCode).toBe(200);
    const body = TurnCredentialsResponse.parse(parseBody(result.body));
    expect(body.ttlSeconds).toBe(12 * 3600);
    expect(body.iceServers.length).toBeGreaterThan(0);
  });

  it('builds the username as <expiry>:<ref> with the expiry the TTL implies', async () => {
    const result = await turnCredentialsHandler(post(), deps, AUTH);
    const body = parseBody<{ iceServers: { username?: string }[] }>(result.body);
    const username = body.iceServers.find(s => s.username)?.username as string;
    const [expiry, ref] = username.split(':');
    expect(Number(expiry)).toBe(Math.floor(deps.now() / 1000) + 12 * 3600);
    expect(ref).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('computes the credential coturn will compute — HMAC-SHA1 over the username', async () => {
    const result = await turnCredentialsHandler(post(), deps, AUTH);
    const body = parseBody<{ iceServers: { username?: string; credential?: string }[] }>(
      result.body,
    );
    const server = body.iceServers.find(s => s.username)!;
    const expected = createHmac('sha1', SECRET)
      .update(server.username as string)
      .digest('base64');
    expect(server.credential).toBe(expected);
  });

  it('leaves STUN entries credential-free — STUN needs no auth', async () => {
    const result = await turnCredentialsHandler(post(), deps, AUTH);
    const body = parseBody<{ iceServers: { urls: string[]; username?: string }[] }>(
      result.body,
    );
    const stun = body.iceServers.find(s => s.urls.some(u => u.startsWith('stun:')))!;
    expect(stun.username).toBeUndefined();
    expect(stun).not.toHaveProperty('credential');
  });

  it('offers TLS/443 LAST, so it is used only when UDP fails', async () => {
    const result = await turnCredentialsHandler(post(), deps, AUTH);
    const body = parseBody<{ iceServers: { urls: string[] }[] }>(result.body);
    const flat = body.iceServers.flatMap(s => s.urls);
    expect(flat.at(-1)).toContain('turns:');
  });
});

describe('the relay never learns who is calling', () => {
  it('never puts the userId in the username', async () => {
    const result = await turnCredentialsHandler(post(), deps, AUTH);
    expect(result.body).not.toContain(AUTH.userId);
  });

  it('is stable for one user and different for another', async () => {
    const refFor = async (auth: AuthContext) => {
      const r = await turnCredentialsHandler(post(), deps, auth);
      const body = parseBody<{ iceServers: { username?: string }[] }>(r.body);
      return (body.iceServers.find(s => s.username)!.username as string).split(':')[1];
    };
    const a1 = await refFor(AUTH);
    const a2 = await refFor(AUTH);
    const b = await refFor(OTHER);
    // Stable, so the relay can quota per user…
    expect(a1).toBe(a2);
    // …but not linkable across users.
    expect(a1).not.toBe(b);
  });

  it('changes entirely under a different salt, so relay logs cannot be re-linked', async () => {
    const first = await turnCredentialsHandler(post(), deps, AUTH);
    const refA = parseBody<{ iceServers: { username?: string }[] }>(first.body)
      .iceServers.find(s => s.username)!
      .username!.split(':')[1];

    deps.turn = { ...deps.turn!, userSalt: 'a-different-salt' };
    const second = await turnCredentialsHandler(post(), deps, AUTH);
    const refB = parseBody<{ iceServers: { username?: string }[] }>(second.body)
      .iceServers.find(s => s.username)!
      .username!.split(':')[1];

    expect(refA).not.toBe(refB);
  });

  it('logs neither the userId, the secret, the salt, nor the minted values', async () => {
    const result = await turnCredentialsHandler(post(), deps, AUTH);
    const server = parseBody<{
      iceServers: { username?: string; credential?: string }[];
    }>(result.body).iceServers.find(s => s.username)!;

    const dump = JSON.stringify(deps.logs);
    expect(dump).not.toContain(AUTH.userId);
    expect(dump).not.toContain(SECRET);
    expect(dump).not.toContain(SALT);
    // The values themselves, not the word: the username embeds the user ref
    // and the credential is a relay grant.
    expect(dump).not.toContain(server.username);
    expect(dump).not.toContain(server.credential);
  });
});

describe('availability and abuse', () => {
  it('reports turn_unavailable when no relay is provisioned, rather than pretending', async () => {
    deps.turn = null;
    const result = await turnCredentialsHandler(post(), deps, AUTH);
    expect(result.statusCode).toBe(503);
    expect(parseBody<{ error: { code: string } }>(result.body).error.code).toBe(
      'turn_unavailable',
    );
  });

  it('rate-limits mints per user — each one is a relay capability', async () => {
    let limited = 0;
    for (let i = 0; i < 8; i++) {
      const r = await turnCredentialsHandler(post(), deps, AUTH);
      if (r.statusCode === 429) limited++;
    }
    expect(limited).toBeGreaterThan(0);

    // A different user is unaffected by their neighbour's burst.
    const other = await turnCredentialsHandler(post(), deps, OTHER);
    expect(other.statusCode).toBe(200);
  });

  it('recovers after the bucket refills', async () => {
    for (let i = 0; i < 8; i++) await turnCredentialsHandler(post(), deps, AUTH);
    deps.advanceMs(3600_000);
    const after = await turnCredentialsHandler(post(), deps, AUTH);
    expect(after.statusCode).toBe(200);
  });
});
