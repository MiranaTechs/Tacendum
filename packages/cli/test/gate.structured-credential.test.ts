import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * JSON FRAMING PREVENTS INJECTION, NOT DISCLOSURE.
 *
 * `gate.credential-echo.test.ts` closed the four sinks a server can reach on
 * the HUMAN path, and the fix was to put the redaction inside
 * `sanitizeForTerminal` — the one call every peer- and server-influenced
 * string already made on its way to a stream. That reasoning has a hole the
 * shape of `--json`: a STRUCTURED printer never calls a sanitizer at all. It
 * hands a record to `JSON.stringify`, which escapes control bytes (the
 * injection question) and is perfectly happy to print a session token.
 *
 * THE ROUTE, and it needs no malformed anything: `AuthResponse.userId` is a
 * plain `z.string()` in packages/shared, so a server may answer with the same
 * 43-character value as both `userId` and `authToken`. That value is then a
 * credential this client minted, stored and presents on every request — and it
 * is ALSO the field that `register --json` prints as the command's result,
 * that `whoami --json` prints as the programmatic shape a hook forwards, and
 * that `whoami` prints again on the human path. None of the three crossed the
 * chokepoint.
 *
 * `--json` IS THE SHAPE THAT TRAVELS FURTHEST. It is what a provisioning
 * script captures, what a hook forwards, and what ends up pasted into a
 * ticket. A credential there goes further than one on a terminal, not less
 * far.
 *
 * The assertion is the same one the human gate makes: no eight-character run,
 * anywhere, on either stream. A leak that arrives cut in half is still a leak.
 * And each check is paired with a non-vacuity claim — the command still
 * succeeded and stdout is still parseable JSON — because "the token is absent"
 * is trivially true of a command that printed nothing.
 */

const home = mkdtempSync(join(tmpdir(), 'tacendum-gate-structcred-'));

/**
 * A session token in the shape the server actually mints: 32 random bytes as
 * base64url, 43 characters. Fixed rather than random so a failure is
 * reproducible, and with no English in it so a match cannot be a coincidence.
 */
const TOKEN = 'Zq3Rk8Xv1TbN7wLpD4hJ2msY6ceA0uGfWi5oQxE9rSt';

/** The shortest run this gate treats as a disclosure — the chokepoint's own
 * `CREDENTIAL_RUN`, and below the ten characters V8 quotes. */
const FRAGMENT = 8;

/** The control: an account whose userId is a userId and whose token is a
 * token, i.e. every real install. Nothing about it may be redacted. */
const HEALTHY_USER = '01STRUCTHEALTHY0000000000A';
const HEALTHY_TOKEN = 'Hp7Bn2QjRm4XcV9LkT6sWy1ZdF3gA8uE0oI5rN'.padEnd(43, 'x');

/** Which shape `/v1/auth` answers with; set by each test before it spawns. */
let mode: 'collide' | 'healthy' = 'collide';

const server = createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += String(d)));
  req.on('end', () => {
    void body;
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
        challenge: Buffer.from('structcred-challenge').toString('base64'),
        expiresAt: Math.floor(Date.now() / 1000) + 120,
      });
      return;
    }
    // THE WHOLE FIXTURE: one value, answered as both fields. Nothing is
    // malformed — this token is presentable, and every request below succeeds
    // with it. `healthy` is the control: two different values, as on every
    // real install.
    if (req.method === 'POST' && req.url === '/v1/auth') {
      json(
        200,
        mode === 'healthy'
          ? { userId: HEALTHY_USER, authToken: HEALTHY_TOKEN }
          : { userId: TOKEN, authToken: TOKEN },
      );
      return;
    }
    if (req.method === 'PUT' && req.url === '/v1/keys') {
      json(200, {});
      return;
    }
    if (req.method === 'GET' && req.url === '/v1/me') {
      json(200, { userId: mode === 'healthy' ? HEALTHY_USER : TOKEN });
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

function expectNoCredential(where: string, r: { stdout: string; stderr: string }): void {
  const all = `${r.stdout}\n${r.stderr}`;
  expect(all, `${where}: the whole credential was echoed`).not.toContain(TOKEN);
  for (let i = 0; i + FRAGMENT <= TOKEN.length; i++) {
    const run = TOKEN.slice(i, i + FRAGMENT);
    expect(
      all,
      `${where}: a ${FRAGMENT}-character run of the credential (offset ${i}) was echoed`,
    ).not.toContain(run);
  }
}

const ACCOUNT = 'structcred';

describe('a credential cannot reach output through a STRUCTURED printer', () => {
  it('register --json does not print a userId that is the bearer', async () => {
    mode = 'collide';
    const r = await runCli(['register', ACCOUNT, '--json']);
    expect(r.code, `register stderr was:\n${r.stderr}`).toBe(0);
    expectNoCredential('register --json', r);
    // NOT VACUOUS on three counts: the fixture took, the command still emits
    // its result, and that result is still machine-readable — a redaction that
    // broke `--json` for every consumer would be a different defect, not a fix.
    expect(
      (JSON.parse(readFileSync(join(home, ACCOUNT, 'profile.json'), 'utf8')) as {
        authToken: string;
      }).authToken,
      'the fixture did not take — every check here would prove nothing',
    ).toBe(TOKEN);
    const record = JSON.parse(r.stdout.trim()) as { ok?: boolean; action?: string };
    expect(record.ok, 'the --json result stopped being valid JSON').toBe(true);
    expect(record.action).toBe('registered');
  }, 120_000);

  it('whoami --json — the shape a hook forwards — does not print it either', async () => {
    const r = await runCli(['whoami', ACCOUNT, '--json']);
    expect(r.code, `whoami stderr was:\n${r.stderr}`).toBe(0);
    expectNoCredential('whoami --json', r);
    const record = JSON.parse(r.stdout.trim()) as { name?: string; userId?: string };
    expect(record.name, 'the --json shape lost its account name').toBe(ACCOUNT);
    expect(record.userId, 'the userId field vanished instead of being redacted').toBeTruthy();
  }, 120_000);

  it('whoami on the human path does not print it either', async () => {
    const r = await runCli(['whoami', ACCOUNT]);
    expect(r.code, `whoami stderr was:\n${r.stderr}`).toBe(0);
    expectNoCredential('whoami', r);
    // The human path is still the pretty two-space JSON both e2e gates parse,
    // and it still carries the identity key that is the reason it differs from
    // `--json` at all.
    const record = JSON.parse(r.stdout.trim()) as { identityKey?: string; class?: string };
    expect(record.identityKey, 'the human path lost the identity key').toBeTruthy();
    expect(record.class).toBe('human');
  }, 120_000);

  it('a HEALTHY account is untouched — the false-positive direction is not free', async () => {
    // The chokepoint now runs over every serialized record, and a redactor
    // that ate ordinary ULIDs would make `whoami` useless on every correct
    // install. Here the userId is a userId and the token is a token, as they
    // are everywhere outside this file's fixture.
    mode = 'healthy';
    const reg = await runCli(['register', 'structhealthy', '--json']);
    expect(reg.code, `register stderr was:\n${reg.stderr}`).toBe(0);
    expect(
      (JSON.parse(reg.stdout.trim()) as { userId?: string }).userId,
      'a healthy userId was redacted — this belt eats the thing it is meant to protect',
    ).toBe(HEALTHY_USER);

    const who = await runCli(['whoami', 'structhealthy', '--json']);
    expect(who.code, `whoami stderr was:\n${who.stderr}`).toBe(0);
    expect(who.stdout, 'a marker appeared on a healthy install').not.toContain('withheld');
    expect((JSON.parse(who.stdout.trim()) as { userId?: string }).userId).toBe(HEALTHY_USER);

    const human = await runCli(['whoami', 'structhealthy']);
    expect(human.stdout, 'a marker appeared on the human path of a healthy install').not.toContain(
      'withheld',
    );
    expect((JSON.parse(human.stdout.trim()) as { userId?: string }).userId).toBe(HEALTHY_USER);
  }, 120_000);
});
