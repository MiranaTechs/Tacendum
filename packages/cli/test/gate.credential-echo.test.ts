import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * A CREDENTIAL MAY NOT REACH OUTPUT BY ANY ROUTE, INCLUDING AN AUTHENTICATED
 * ANSWER.
 *
 * `gate.stored-token-leak.test.ts` covers the leak the runtime causes: Node
 * refuses a malformed header value by QUOTING IT BACK, and the belt that was
 * built for it guards the TRANSPORT EXCEPTION path — the `catch` in api.ts,
 * and doctor's `me.json()` catch. That belt is a `text.includes(secret)` test
 * at two sinks, and this file is the three ways past it that a server needs no
 * privilege to take. The token here is a WELL-FORMED one this client minted
 * and presented; nothing is malformed, nothing is refused by a header
 * validator, and the exceptional path is never taken:
 *
 *   1. A 500 whose `{error:{detail}}` is the bearer. `request()` copies that
 *      detail into a `CliError` message (sanitized, but a credential is not
 *      made safe by having its line breaks flattened), which main.ts prints as
 *      `error: …` on stderr and as `error.message` under `--json`.
 *   2. A 2xx whose CONTENT-TYPE is the bearer. `requestJson`'s
 *      not-JSON refusal names the content-type, bounded at 64 — and a session
 *      token is 43 characters, so the bound cuts nothing.
 *   3. `/v1/me` answering with the bearer, twice over:
 *        a. as the body, which is not JSON, so V8's `SyntaxError` quotes the
 *           first TEN characters of it back — and the old belt compared a
 *           SIXTEEN-character probe, so it returned false and doctor printed
 *           the partial secret;
 *        b. as `userId`, which doctor prints in full through a 64-character
 *           field bound, in the one command an operator runs when they already
 *           suspect something is wrong.
 *
 * THE ASSERTION IS ABOUT FRAGMENTS, NOT ABOUT THE WHOLE VALUE. A leak that
 * arrives cut in half is still a leak: the token is 43 characters of base64url
 * over a 64-symbol alphabet, so an eight-character run is a string that occurs
 * by chance about once in 2.8e14 — it identifies this credential, it confirms
 * a guess about it, and it is enough to correlate one machine's logs with
 * another's. Every check below scans stdout and stderr TOGETHER for every
 * 8-character window of the token; which stream a credential is printed on
 * changes nothing about whether it was printed.
 */

const home = mkdtempSync(join(tmpdir(), 'tacendum-gate-credecho-'));

/**
 * A session token in the shape the server actually mints: 32 random bytes as
 * base64url, 43 characters. Fixed rather than random so a failure is
 * reproducible, and chosen with no English in it so a match cannot be a
 * coincidence in ordinary transport prose.
 */
const TOKEN = 'Zq3Rk8Xv1TbN7wLpD4hJ2msY6ceA0uGfWi5oQxE9rSt';

/**
 * The shortest run of a credential this gate treats as a disclosure.
 *
 * Must not exceed what the redaction belt promises, and must not exceed the
 * shortest quote a runtime actually produces — V8 truncates the snippet in a
 * JSON `SyntaxError` at ten characters, which is exactly the size the previous
 * 16-character probe was blind to.
 */
const FRAGMENT = 8;

const USER_ID = '01CREDECH0CREDECH0CREDECH0';

/** Which shape the mock server answers with, set by each test before it spawns. */
let mode: 'plain' | 'detail500' | 'ctype' | 'me-body' | 'me-userid' = 'plain';

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
        challenge: Buffer.from('credecho-challenge').toString('base64'),
        expiresAt: Math.floor(Date.now() / 1000) + 120,
      });
      return;
    }
    // A WELL-FORMED token, deliberately: every leak below happens with a
    // credential this client is perfectly able to present.
    if (req.method === 'POST' && req.url === '/v1/auth') {
      json(200, { userId: USER_ID, authToken: TOKEN });
      return;
    }
    if (req.method === 'PUT' && req.url === '/v1/keys') {
      json(200, {});
      return;
    }
    if (req.method === 'GET' && req.url === '/v1/me') {
      if (mode === 'me-body') {
        // Not JSON. V8 quotes the first ten bytes of it back inside its
        // SyntaxError, which doctor then reports as a failed token check.
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(TOKEN);
        return;
      }
      if (mode === 'me-userid') {
        json(200, { userId: TOKEN });
        return;
      }
      json(200, { userId: USER_ID });
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/ws-ticket') {
      if (mode === 'detail500') {
        // The server's own free text, on an AUTHENTICATED route, echoed into
        // the CLI's error by `request()`.
        json(500, {
          error: { code: 'internal', detail: `upstream rejected Bearer ${TOKEN}` },
        });
        return;
      }
      if (mode === 'ctype') {
        res.writeHead(200, { 'content-type': TOKEN });
        res.end('this is not json');
        return;
      }
      json(200, { ticket: 'tkt-credecho', expiresAt: Math.floor(Date.now() / 1000) + 60 });
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

/**
 * The one assertion this file makes: no run of the credential, anywhere, on
 * either stream. Every window is checked rather than the whole value, because
 * every sink below truncates at a different length and a leak that arrives cut
 * is still a leak.
 */
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

const ACCOUNT = 'credecho';

describe('a credential cannot reach output through an authenticated answer', () => {
  it('registers an ordinary account and stores the minted token', async () => {
    mode = 'plain';
    const reg = await runCli(['register', ACCOUNT]);
    expect(reg.code, `register stderr was:\n${reg.stderr}`).toBe(0);
    expectNoCredential('register', reg);
    expect(
      (JSON.parse(readFileSync(join(home, ACCOUNT, 'profile.json'), 'utf8')) as {
        authToken: string;
      }).authToken,
      'the fixture did not take — every test below would prove nothing',
    ).toBe(TOKEN);
  }, 120_000);

  it('a 500 whose detail quotes the bearer does not print it', async () => {
    mode = 'detail500';
    const r = await runCli(['sync', ACCOUNT]);
    expectNoCredential('sync (500 detail)', r);
    expect(r.code, 'the command must fail — the server said 500').not.toBe(0);
    // NOT VACUOUS: the failure is still diagnosable. The operator keeps the
    // route, the status and the server's error CODE; only the credential the
    // server chose to quote back is gone.
    const all = `${r.stdout}${r.stderr}`;
    expect(all, 'the diagnosis lost the route').toContain('/v1/ws-ticket');
    expect(all, 'the diagnosis lost the status').toContain('500');
  }, 120_000);

  it('says the same under --json, where the message becomes a field', async () => {
    mode = 'detail500';
    const r = await runCli(['sync', ACCOUNT, '--json']);
    expectNoCredential('sync --json (500 detail)', r);
    // The --json error object is what a hook or a CI step forwards, so it is a
    // different renderer over the same message and must be checked as one.
    expect(r.stderr, 'the --json error object never rendered').toContain('"ok":false');
  }, 120_000);

  it('a content-type header that is the bearer does not print it', async () => {
    mode = 'ctype';
    const r = await runCli(['sync', ACCOUNT]);
    expectNoCredential('sync (content-type)', r);
    expect(r.code, 'the command must fail — the body was not JSON').not.toBe(0);
    expect(`${r.stdout}${r.stderr}`, 'the diagnosis lost its subject').toContain('not JSON');
  }, 120_000);

  it('doctor does not print the ten characters V8 quotes out of a bad body', async () => {
    mode = 'me-body';
    const r = await runCli(['doctor', ACCOUNT]);
    expectNoCredential('doctor (/v1/me body)', r);
    expect(`${r.stdout}${r.stderr}`, 'the session check never rendered').toContain('session');
  }, 120_000);

  it('doctor does not print a userId that is the bearer', async () => {
    mode = 'me-userid';
    const r = await runCli(['doctor', ACCOUNT]);
    expectNoCredential('doctor (/v1/me userId)', r);
    // NOT VACUOUS: the mismatch is still reported — that finding is the whole
    // point of the check, and it survives without the value.
    expect(`${r.stdout}${r.stderr}`, 'the session mismatch was not reported').toContain(
      'the profile says',
    );
  }, 120_000);

  it('doctor --json carries no credential either', async () => {
    mode = 'me-userid';
    const r = await runCli(['doctor', ACCOUNT, '--json']);
    expectNoCredential('doctor --json (/v1/me userId)', r);
  }, 120_000);
});
