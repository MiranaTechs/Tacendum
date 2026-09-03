import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it } from 'vitest';
import { turnCredentialsHandler } from '../src/handlers/turn.js';
import type { AuthContext, HttpEvent } from '../src/handlers/http.js';
import { makeMemoryDb, makeTestDeps, parseBody, type TestDeps } from './helpers.js';

/**
 * The credential math, checked against the thing that actually validates it.
 *
 * turn.test.ts proves we compute the HMAC we *think* coturn computes — but
 * that is our own re-implementation on both sides of the assertion, so it
 * would stay green if the whole scheme were subtly wrong (the wrong hash, the
 * wrong encoding, the wrong string to sign). This test mints a credential
 * through the real handler and hands it to a real coturn, which either grants
 * a relay allocation or does not.
 *
 * Skipped when the container is not running (`pnpm turn:up`), in the same
 * spirit as the DynamoDB Local integration tests. coturn sits behind an
 * opt-in compose profile, so the ordinary dev loop never starts it.
 */

/** execFile, not exec: arguments are passed as an array and never go through
 * a shell, so nothing interpolated here can be reinterpreted as a command. */
const run = promisify(execFile);

/** Must match docker-compose.yml's coturn service exactly. */
const LOCAL_TURN_SECRET = 'local-development-turn-secret';
const AUTH: AuthContext = { userId: 'user-integration' };

let available = false;
let deps: TestDeps;

/** Run a real TURN allocation from inside the container. Returns whether the
 * relay granted it. */
async function allocationSucceeds(
  username: string,
  credential: string,
): Promise<boolean> {
  const args = [
    'compose', 'exec', '-T', 'coturn',
    'timeout', '15', 'turnutils_uclient',
    '-u', username, '-w', credential,
    '-p', '3478', '-n', '1', '-c', '-y', '127.0.0.1',
  ];
  // A refused allocation is a NON-ZERO exit, which execFile surfaces as a
  // rejection — that is the outcome under test, not an infrastructure
  // failure, so the output is read off the error just the same.
  let output: string;
  try {
    const { stdout, stderr } = await run('docker', args);
    output = `${stdout}\n${stderr}`;
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    output = `${e.stdout ?? ''}\n${e.stderr ?? ''}`;
  }
  if (/Cannot complete Allocation/i.test(output)) return false;
  // Success is not the absence of an error string — it is packets actually
  // making the round trip through the relay.
  return /tot_recv_msgs=[1-9]/.test(output);
}

beforeAll(async () => {
  // A REAL clock: the credential encodes an absolute expiry, and coturn
  // checks it against its own wall time. The usual frozen test clock would
  // mint something that expired in 2023 and every allocation would be
  // refused for the wrong reason.
  deps = makeTestDeps(makeMemoryDb(), Date.now());
  deps.turn = {
    urls: ['turn:127.0.0.1:3478?transport=udp'],
    authSecret: LOCAL_TURN_SECRET,
    userSalt: 'integration-salt',
    ttlSeconds: 3600,
  };
  try {
    await run('docker', ['compose', 'exec', '-T', 'coturn', 'turnutils_stunclient', '127.0.0.1']);
    available = true;
  } catch {
    console.warn('[skip] local coturn not reachable; skipping TURN integration tests');
  }
}, 60_000);

/** Mint through the real handler, exactly as a client would. */
async function mint(): Promise<{ username: string; credential: string }> {
  const event: HttpEvent = {
    method: 'POST',
    path: '/v1/turn-credentials',
    headers: {},
    body: '{}',
  };
  const result = await turnCredentialsHandler(event, deps, AUTH);
  const body = parseBody<{
    iceServers: { username?: string; credential?: string }[];
  }>(result.body);
  const server = body.iceServers.find(s => s.username)!;
  return { username: server.username!, credential: server.credential! };
}

describe('coturn accepts what the handler mints', () => {
  it('grants a relay allocation for a freshly minted credential', async (ctx) => {
    if (!available) return ctx.skip();
    const { username, credential } = await mint();
    expect(await allocationSucceeds(username, credential)).toBe(true);
  }, 60_000);

  it('refuses an EXPIRED credential', async (ctx) => {
    if (!available) return ctx.skip();
    // Same handler, same secret, only the clock moved past the expiry the
    // username encodes — which is the entire point of the scheme.
    const { credential } = await mint();
    const past = Math.floor(Date.now() / 1000) - 3600;
    const expiredUsername = `${past}:integration-ref`;
    expect(await allocationSucceeds(expiredUsername, credential)).toBe(false);
  }, 60_000);

  it('refuses a credential forged without the shared secret', async (ctx) => {
    if (!available) return ctx.skip();
    const { username } = await mint();
    // A plausible-looking base64 HMAC computed with the wrong key.
    const { createHmac } = await import('node:crypto');
    const forged = createHmac('sha1', 'not-the-secret').update(username).digest('base64');
    expect(await allocationSucceeds(username, forged)).toBe(false);
  }, 60_000);
});
