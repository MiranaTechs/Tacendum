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
 * AN ERROR MAY NEVER REPRODUCE A CREDENTIAL.
 *
 * `checkedSessionToken` (api.ts) guards the MINT: the token `POST /v1/auth`
 * answers with is refused unless it can be a header value. That check covers
 * exactly one of the two ways a token reaches an `authorization` header, and
 * the other one is older. `main.ts` saves the profile BEFORE the key upload,
 * and every later command reads the token back off disk — so a profile
 * written by a build that predates the mint check holds whatever that build
 * was handed, forever, and no amount of guarding the mint reaches it.
 *
 * WHAT THAT COSTS, end to end, and it is the reason this file exists rather
 * than an assertion bolted onto the forgery gate: Node validates header
 * values, and `Headers.append` reports an invalid one by QUOTING THE VALUE
 * BACK — `Headers.append: "Bearer LEGACY_SECRET\nTAIL" is an invalid header
 * value.` That rejection is raised by `fetch` before a socket exists, so it
 * lands in the transport catch that exists for DNS and refused connections.
 * `sanitizeServerField` flattens the newline and preserves every other byte,
 * so the CLI printed `LEGACY_SECRET TAIL` — the credential itself, verbatim,
 * with only its line break turned into a space — onto stderr and into the
 * `--json` error object, i.e. into CI logs and Claude Code hook logs. And it
 * called the failure NETWORK, which tells a cron wrapper to retry a fault
 * that will recur identically forever.
 *
 * THE TOKEN IS NEVER THE SUBJECT OF THE ASSERTION — its ABSENCE is. Every
 * check below scans the whole of stdout and stderr for the secret in each
 * shape it could survive in: raw, line-flattened (what the sanitizer would
 * have made of it), and the bare distinctive word (what a partial quote would
 * leave). A leak that changed shape is still a leak.
 */

const home = mkdtempSync(join(tmpdir(), 'tacendum-gate-tokleak-'));

/**
 * A token an older build could have written, and the exact shape that turns a
 * header rejection into a disclosure: a secret, a line break, and a tail. The
 * break is what makes Node refuse it; the SECRET is what must never be shown
 * whether it is refused or not.
 */
const LEGACY_SECRET = 'LEGACY_SECRET';
const LEGACY_TOKEN = `${LEGACY_SECRET}\nTAIL`;
/** What `sanitizeServerField` would leave of it — the leak as actually printed. */
const LEGACY_FLATTENED = `${LEGACY_SECRET} TAIL`;

const REG_USER_ID = '01LEGACYB0TLEGACYB0TLEGACY';

const server = createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += String(d)));
  req.on('end', () => {
    void body;
    const json = (status: number, payload: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    if (req.method === 'POST' && req.url === '/v1/auth/challenge') {
      json(200, {
        challenge: Buffer.from('tokleak-challenge').toString('base64'),
        expiresAt: Math.floor(Date.now() / 1000) + 120,
      });
      return;
    }
    // A WELL-FORMED token at the mint, deliberately. The defect under test is
    // not a hostile server — that one `checkedSessionToken` already refuses —
    // it is a profile on disk that a PAST build wrote. So registration here is
    // entirely ordinary, and the legacy value is planted afterwards, which is
    // the only way this machine could actually come to hold one.
    if (req.method === 'POST' && req.url === '/v1/auth') {
      json(200, { userId: REG_USER_ID, authToken: 'tok-legacy-gate' });
      return;
    }
    if (req.method === 'PUT' && req.url === '/v1/keys') {
      json(200, {});
      return;
    }
    if (req.method === 'GET' && req.url === '/v1/me') {
      json(200, { userId: REG_USER_ID });
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/ws-ticket') {
      json(200, { ticket: 'tkt-legacy-gate', expiresAt: Math.floor(Date.now() / 1000) + 60 });
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
 * The one assertion this file makes, in the three shapes a leak can wear.
 * Applied to stdout and stderr TOGETHER: which stream a credential is printed
 * on changes nothing about whether it was printed.
 */
function expectNoCredential(where: string, r: { stdout: string; stderr: string }): void {
  const all = `${r.stdout}\n${r.stderr}`;
  expect(all, `${where}: the raw stored token was echoed`).not.toContain(LEGACY_TOKEN);
  expect(all, `${where}: the token was echoed with its break flattened`).not.toContain(
    LEGACY_FLATTENED,
  );
  // The broadest of the three, and the one that survives a future sanitizer
  // that mangles the token differently: the secret WORD may not appear at all.
  expect(all, `${where}: the credential appeared in the output`).not.toContain(LEGACY_SECRET);
}

const ACCOUNT = 'legacybot';

describe('a token an older build stored can never reach an error message', () => {
  it('registers, then is downgraded to a profile such a build would have written', async () => {
    const reg = await runCli(['register', ACCOUNT]);
    expect(reg.code, `register stderr was:\n${reg.stderr}`).toBe(0);

    // THE DOWNGRADE. This is precisely what `main.ts` leaves behind when the
    // save at line 222 lands and the key upload afterwards does not, on a
    // build with no mint check: a complete, ordinary profile whose token is
    // not a header value.
    const path = join(home, ACCOUNT, 'profile.json');
    const profile = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    profile.authToken = LEGACY_TOKEN;
    writeFileSync(path, JSON.stringify(profile, null, 2), { mode: 0o600 });
    expect(
      (JSON.parse(readFileSync(path, 'utf8')) as { authToken: string }).authToken,
      'the fixture did not take — the tests below would prove nothing',
    ).toBe(LEGACY_TOKEN);
  }, 120_000);

  it('doctor refuses without quoting it, and says what to do', async () => {
    // doctor.ts reads profile.json itself — its own `JSON.parse`, its own
    // `authorization: Bearer ${token}` — so it is a second, independent path
    // to the same header, and it is the command an operator runs BECAUSE they
    // already suspect something is wrong.
    const r = await runCli(['doctor', ACCOUNT]);
    expectNoCredential('doctor', r);
    // NOT VACUOUS: the session check has to have actually run and reported.
    expect(`${r.stdout}${r.stderr}`, 'the session check never rendered').toContain('session');
    // ACTIONABLE: the operator's remedy for a stored token that cannot be
    // presented is to register again, and the output must say so.
    expect(`${r.stdout}${r.stderr}`.toLowerCase()).toContain('register');
    // WHICH LAYER ANSWERED, pinned. doctor checks the token as it loads it and
    // reports THAT; the withholding belt further down would also keep the
    // credential off the screen, so without this the two are indistinguishable
    // and removing the load check would go unnoticed.
    expect(
      `${r.stdout}${r.stderr}`,
      'doctor diagnosed the header rejection instead of the stored token that caused it',
    ).toContain('older build');
  }, 120_000);

  it('an authed command refuses without quoting it, and does not call it a network fault', async () => {
    // `sync` takes the ordinary authed path: AuthSession loads the profile,
    // the ws dial mints a ticket over REST, and api.ts puts the stored token
    // in an `authorization` header. That is the line the leak came out of.
    const r = await runCli(['sync', ACCOUNT]);
    expectNoCredential('sync', r);
    expect(r.code, 'a credential this client cannot present is not a transient network fault').not.toBe(
      4,
    );
    expect(r.code, 'the command must fail, not proceed with an unusable credential').not.toBe(0);
    // WHICH LAYER ANSWERED. The transport's own backstop would also refuse
    // this without echoing anything, so a message-blind assertion here cannot
    // tell the load check from its safety net. The load check is the one that
    // refuses BEFORE a header is ever composed, and it is the one that can
    // name the cause — a profile an older build wrote — rather than the
    // symptom.
    expect(
      `${r.stdout}${r.stderr}`,
      'the refusal came from the transport backstop, not the load check',
    ).toContain('older build');
  }, 120_000);

  it('is refused by the transport itself, even when nothing validated it first', async () => {
    // THE BACKSTOP, tested WITHOUT the load check in front of it.
    //
    // The refusal in profile.ts is the fix; this is the property that makes a
    // leak impossible rather than unlikely. `request()` is handed a token
    // directly here — the fixed-credential arm of `Credential`, which no
    // profile and no load check stands in front of — which is exactly the
    // shape a future caller would have if it acquired a token from somewhere
    // new. The transport must refuse it on its own.
    process.env.TACENDUM_API = apiBase;
    const { apiWsTicket } = await import('../src/api.js');
    const { EXIT } = await import('../src/exit.js');

    const err = await apiWsTicket(LEGACY_TOKEN).then(
      () => null,
      (e: unknown) => e as { message: string; exitCode: number },
    );
    expect(err, 'the transport accepted a token that cannot be a header value').not.toBeNull();
    expect(err!.message, 'the transport quoted the credential').not.toContain(LEGACY_SECRET);
    // Classified as what it is. NETWORK would tell a CI step to retry a
    // request that was never sent and never can be.
    expect(err!.exitCode, 'a credential that cannot be presented is not a network fault').toBe(
      EXIT.AUTH,
    );
  }, 120_000);

  it('says the same thing under --json, where the message becomes a field', async () => {
    // The `--json` error object is the shape a hook or CI step forwards, and
    // it is a different renderer from the stderr one. A refusal that is clean
    // on one and quotes the credential on the other is still a disclosure.
    const r = await runCli(['sync', ACCOUNT, '--json']);
    expectNoCredential('sync --json', r);
  }, 120_000);
});
