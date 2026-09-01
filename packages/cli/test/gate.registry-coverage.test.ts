import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * THE CHOKEPOINT IS A REGISTRY, AND A REGISTRY THAT WAS NEVER FILLED REDACTS
 * NOTHING.
 *
 * Every "a credential cannot reach output" argument in this package rests on
 * `redactCredentials`, which removes runs of values `guardCredential` was told
 * about. There are exactly two places a value is registered: the mint (api.ts)
 * and `loadProfile` (profile.ts). A command that reaches a printer WITHOUT
 * passing through either runs its whole life with an EMPTY registry, and every
 * sanitizer on its path is a no-op wearing the name of a guard.
 *
 * The existing coverage missed this because it staged its own secret: it
 * called `guardCredential` by hand and then exercised a printer, which proves
 * the redactor works and proves nothing about whether the command under test
 * ever calls it. Both defects below were found by asking a different question
 * — WHAT DOES THE REAL COMMAND DO IN ITS OWN FRESH PROCESS — so both tests
 * here spawn the real binary and stage nothing inside it.
 *
 *  2a. `calllog` never loaded the profile. A hostile server may mint a bearer
 *      equal to a peer's 26-character user id (`AuthResponse.authToken` and
 *      `userId` are both plain `z.string()`, and nothing forbids the
 *      collision); the first completed call stores that id in a row, and
 *      `calllog` printed it back whole.
 *  2b. `JSON.parse` ran BEFORE the registration. A corrupt or legacy profile
 *      holding an unquoted bearer made V8's `SyntaxError` quote TEN characters
 *      of the file, which main.ts printed while the registry was still empty.
 *
 * THE ASSERTION IS ABOUT FRAGMENTS. Eight characters of a base64url token is
 * a string that occurs by chance about once in 2.8e14: it identifies the
 * credential, confirms a guess about it, and correlates one machine's logs
 * with another's. `gate.credential-echo.test.ts` sets the same bound and says
 * the same thing.
 */

const home = mkdtempSync(join(tmpdir(), 'tacendum-registry-'));

afterAll(() => rmSync(home, { recursive: true, force: true }));

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

function runCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'packages/cli/src/main.ts', ...args], {
      cwd: repoRoot,
      env: { ...process.env, TACENDUM_HOME: home, NODE_USE_SYSTEM_CA: '0' },
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

const FRAGMENT = 8;

/** Every 8-character window of `secret` that appears in `text`. */
function fragmentsOf(text: string, secret: string): string[] {
  const hits: string[] = [];
  for (let i = 0; i + FRAGMENT <= secret.length; i++) {
    const run = secret.slice(i, i + FRAGMENT);
    if (text.includes(run)) hits.push(run);
  }
  return hits;
}

describe('2a. calllog — a command whose own process never loaded the profile', () => {
  /**
   * The collision, in the shape the server can actually produce it: a bearer
   * that IS a legal 26-character user id. Nothing here is malformed — this is
   * a value `POST /v1/auth` is free to answer with.
   */
  const COLLIDING = '0KRSTV1TBN7WLPD4HJ2MSY6CEA';

  it('does not print a bearer that a completed call stored as a peer id', async () => {
    const name = 'clogleak';
    const dir = join(home, name);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(dir, 'profile.json'),
      JSON.stringify({
        name,
        identityKey: 'IDKEYMARKERBASE64==',
        userId: '01CLOGLEAK00000000000000A',
        authToken: COLLIDING,
        registrationId: 7,
        deviceId: 1,
      }),
      { mode: 0o600 },
    );
    // A terminal call row exactly as `CallRunner` writes one, with the peer
    // field holding the value the server also handed us as a bearer.
    writeFileSync(
      join(dir, 'calls.jsonl'),
      `${JSON.stringify({
        cid: '01CLOGCID000000000000000A',
        peer: COLLIDING,
        direction: 'out',
        reason: 'hangup',
        missed: false,
        ts: 1_770_000_000_000,
      })}\n`,
      { mode: 0o600 },
    );

    const r = await runCli(['calllog', name]);
    expect(r.code, `calllog stderr was:\n${r.stderr}`).toBe(0);
    const out = `${r.stdout}${r.stderr}`;

    // THE LEAK.
    expect(
      fragmentsOf(out, COLLIDING),
      'calllog printed the bearer — its process never filled the redaction registry',
    ).toEqual([]);

    // …AND THE ROW IS STILL A ROW. A redaction that destroyed the document
    // would satisfy the line above and break every consumer: `calllog` is
    // JSONL, and the e2e call harness counts its lines.
    const rows = r.stdout.split('\n').filter(Boolean);
    expect(rows).toHaveLength(1);
    const parsed = JSON.parse(rows[0]!) as Record<string, unknown>;
    expect(Object.keys(parsed)).toHaveLength(6);
    expect(parsed.cid).toBe('01CLOGCID000000000000000A');
    expect(parsed.reason).toBe('hangup');
  }, 120_000);

  it('still prints an ordinary row untouched (the liveness control)', async () => {
    const name = 'clogclean';
    const dir = join(home, name);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(dir, 'profile.json'),
      JSON.stringify({
        name,
        identityKey: 'IDKEYMARKERBASE64==',
        userId: '01CLOGCLEAN0000000000000A',
        authToken: 'Hp7Bn2QjRm4XcV9LkT6sWy1ZdF3gA8uE0oJ5rNxxxxx',
        registrationId: 7,
        deviceId: 1,
      }),
      { mode: 0o600 },
    );
    const row = {
      cid: '01CLOGCID000000000000000B',
      peer: '01PEER00000000000000000AB',
      direction: 'in',
      reason: 'declined',
      missed: false,
      ts: 1_770_000_000_001,
    };
    writeFileSync(join(dir, 'calls.jsonl'), `${JSON.stringify(row)}\n`, { mode: 0o600 });

    const r = await runCli(['calllog', name]);
    expect(r.code, `calllog stderr was:\n${r.stderr}`).toBe(0);
    expect(JSON.parse(r.stdout.trim()) as unknown).toEqual(row);
  }, 120_000);
});

describe('2b. a profile that will not parse never quotes its own bytes', () => {
  /**
   * A 43-character bearer in the shape the server mints, sitting at the very
   * front of a file that is not JSON — which is what an older build writing an
   * unquoted value, or a truncated write, leaves behind. V8 quotes the first
   * ten characters of its input in a JSON `SyntaxError`.
   */
  const BEARER = 'Zq3Rk8Xv1TbN7wLpD4hJ2msY6ceA0uGfWi5oQxE9rSt';

  it('prints no fragment of a bearer sitting in a corrupt profile', async () => {
    const name = 'parseleak';
    const dir = join(home, name);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, 'profile.json'), `${BEARER}\n{"name":"parseleak"}`, { mode: 0o600 });

    // `whoami` is the shortest path from disk to a printer; every
    // account-taking command reaches `loadProfile` the same way.
    const r = await runCli(['whoami', name]);
    expect(r.code, 'a profile that does not parse must be refused').not.toBe(0);
    const out = `${r.stdout}${r.stderr}`;

    expect(
      fragmentsOf(out, BEARER),
      "the parse error quoted the file's bytes, and the registry was empty when it printed",
    ).toEqual([]);

    // …AND IT IS STILL A DIAGNOSIS. Removing the quotation must not remove the
    // finding: a reader has to learn that the file is the problem.
    expect(out).toMatch(/profile\.json/);
    expect(out).toMatch(/not valid JSON|truncated|corrupt/i);
  }, 120_000);

  it('the same command under --json also carries no fragment', async () => {
    const name = 'parseleak';
    const r = await runCli(['whoami', name, '--json']);
    expect(r.code).not.toBe(0);
    const out = `${r.stdout}${r.stderr}`;
    expect(fragmentsOf(out, BEARER)).toEqual([]);
    // `--json` is the shape a hook forwards, so the failure must still be one
    // object. (The endpoint banner config.ts writes on start-up is the line
    // before it; the record is the last.)
    const last = r.stderr.trim().split('\n').pop() ?? '';
    const record = JSON.parse(last) as { ok: boolean; error: { message: string } };
    expect(record.ok).toBe(false);
    expect(fragmentsOf(record.error.message, BEARER)).toEqual([]);
  }, 120_000);
});
