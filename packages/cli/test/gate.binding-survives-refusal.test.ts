import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * A REFUSAL MUST NOT COST THE OPERATOR STATE THE REFUSAL WAS NOT ABOUT.
 *
 * `loadProfile` learned to refuse a stored token that cannot be an HTTP header
 * (gate.stored-token-leak.test.ts), which is right: the value is unusable and
 * putting it in a header is how it reached stderr. What the remedy did not
 * account for is `tryLoadProfile`, whose whole job is to answer "is there
 * something here?" for the callers that are ASKING rather than requiring — and
 * which turned the new refusal into `null`, i.e. into "there is no profile".
 *
 * `cmdRegister` believes that answer. It carries forward what the account
 * already was ONLY from `previous`, so a `null` means a returning sign-in
 * writes a profile with no `ownerUserId` — and a bound integration silently
 * becomes locally UNBOUND. Nothing says so. `whoami` reports `boundTo: null`,
 * the MCP server stops advertising a send tool because it can no longer see an
 * owner, and the only thing that was ever wrong was a credential the
 * re-registration replaced on the same line.
 *
 * The server's binding is untouched throughout — bind is write-once and the
 * account is still bound — so this is a purely local amnesia, which is the
 * kind that is hardest to diagnose: every server-side check says the pairing
 * is fine.
 *
 * WHAT THIS FILE PINS is the operator's actual path: a bound integration, a
 * profile an older build left with an unusable token, and the one remedy the
 * refusal names. Following that remedy must restore the account completely —
 * not "except for the binding, which you must now discover for yourself and
 * repair with a command the message never mentioned".
 */

const home = mkdtempSync(join(tmpdir(), 'tacendum-gate-bindsurv-'));

/** 26 characters of Crockford base32 each — the alphabet the server mints in,
 * with I, L, O and U absent, so `isUserId` accepts them at the command line. */
const BOT = '01B0TB1NDSVRV1V0RB1NDSVRXY';
const OWNER = '01WNERB1NDSVRV1V0RB1NDSVRZ';

/** What an older build could have left on disk: a token with a line break in
 * it, which Node refuses as a header value. The account around it is intact. */
const LEGACY_TOKEN = 'LEGACYB1ND\nTAIL';

let bound = false;

const server = createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += String(d)));
  req.on('end', () => {
    const json = (status: number, payload: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    if (req.method === 'GET' && req.url === '/health') {
      json(200, { ok: true });
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/auth/challenge') {
      json(200, {
        challenge: Buffer.from('bindsurv-challenge').toString('base64'),
        expiresAt: Math.floor(Date.now() / 1000) + 120,
      });
      return;
    }
    // The SAME userId on every sign-in — one account, returning. That is what
    // makes `cmdRegister`'s inheritance guard (`previous.userId === minted`)
    // applicable at all, so a test where they differed would prove nothing.
    if (req.method === 'POST' && req.url === '/v1/auth') {
      json(200, {
        userId: BOT,
        authToken: `tok-bindsurv-${Math.random().toString(36).slice(2, 10)}`,
        accountClass: 'integration',
      });
      return;
    }
    if (req.method === 'PUT' && req.url === '/v1/keys') {
      json(200, {});
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/integrations/bind') {
      // Write-once, and the server keeps holding it: the binding under test
      // never goes away server-side, so any loss below is purely local.
      const parsed = JSON.parse(body || '{}') as { owner?: string };
      if (parsed.owner !== OWNER) {
        json(400, { error: { code: 'bad_request', detail: 'unexpected owner' } });
        return;
      }
      bound = true;
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === 'GET' && req.url === '/v1/me') {
      json(200, { userId: BOT });
      return;
    }
    json(404, { error: { code: 'not_found', detail: `no route ${req.method} ${req.url}` } });
  });
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
const apiBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

afterAll(() => {
  server.close();
  rmSync(home, { recursive: true, force: true });
});

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

function runCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'packages/cli/src/main.ts', ...args], {
      cwd: repoRoot,
      env: {
        ...process.env,
        TACENDUM_HOME: home,
        TACENDUM_API: apiBase,
        TACENDUM_WS: apiBase.replace('http://', 'ws://'),
        NODE_USE_SYSTEM_CA: '0',
      },
    });
    child.stdin.end();
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

const ACCOUNT = 'bindsurv';
const profileFile = (): string => join(home, ACCOUNT, 'profile.json');

describe('the malformed-token refusal keeps the binding it was never about', () => {
  it('registers a bound integration', async () => {
    const reg = await runCli(['register', ACCOUNT, '--integration']);
    expect(reg.code, `register stderr was:\n${reg.stderr}`).toBe(0);
    const pair = await runCli(['pair', ACCOUNT, OWNER]);
    expect(pair.code, `pair stderr was:\n${pair.stderr}`).toBe(0);
    expect(bound, 'the server never saw the bind — the premise is missing').toBe(true);

    const who = await runCli(['whoami', ACCOUNT, '--json']);
    expect(JSON.parse(who.stdout) as { boundTo?: string }).toMatchObject({ boundTo: OWNER });
  }, 120_000);

  it('is downgraded to the profile an older build would have left', () => {
    const profile = JSON.parse(readFileSync(profileFile(), 'utf8')) as Record<string, unknown>;
    profile.authToken = LEGACY_TOKEN;
    writeFileSync(profileFile(), JSON.stringify(profile, null, 2), { mode: 0o600 });
    const back = JSON.parse(readFileSync(profileFile(), 'utf8')) as Record<string, unknown>;
    expect(back.authToken, 'the fixture did not take').toBe(LEGACY_TOKEN);
    expect(back.ownerUserId, 'the fixture destroyed the very state under test').toBe(OWNER);
  });

  it('refuses the unusable credential, and the remedy is the WHOLE remedy', async () => {
    const r = await runCli(['sync', ACCOUNT]);
    expect(r.code, 'an unusable stored credential must be refused').not.toBe(0);
    const all = `${r.stdout}${r.stderr}`;
    expect(all.toLowerCase(), 'the refusal does not say what to do').toContain('register');
    // Every step the operator must actually take has to be in the message.
    // The test that follows is the one that decides whether `register` alone
    // IS every step; if it ever stops being, this sentence has to grow.
    expect(all, 'the credential was echoed').not.toContain('LEGACYB1ND');
  }, 120_000);

  it('re-registering — the named remedy — restores the account WITH its binding', async () => {
    const reg = await runCli(['register', ACCOUNT]);
    expect(reg.code, `register stderr was:\n${reg.stderr}`).toBe(0);

    const stored = JSON.parse(readFileSync(profileFile(), 'utf8')) as Record<string, unknown>;
    expect(stored.authToken, 'the unusable token survived the remedy').not.toBe(LEGACY_TOKEN);
    expect(
      stored.ownerUserId,
      'the refusal cost the operator the binding, which the refusal was not about',
    ).toBe(OWNER);
    expect(stored.accountClass, 'the account stopped being an integration').toBe('integration');

    // The surface the loss was actually visible on: `whoami` is what an
    // operator (and the MCP server, by the same field) reads to decide whether
    // this integration may send anywhere at all.
    const who = await runCli(['whoami', ACCOUNT, '--json']);
    expect(JSON.parse(who.stdout) as { boundTo?: string | null }).toMatchObject({
      boundTo: OWNER,
    });
  }, 120_000);
});
