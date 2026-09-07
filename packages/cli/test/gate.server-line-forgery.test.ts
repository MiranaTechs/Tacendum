import { spawn } from 'node:child_process';
import { chmodSync, cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * A LINE OF THIS PROGRAM'S OUTPUT MUST BE THIS PROGRAM'S
 * OWN WORD, INCLUDING THE LINES A HOSTILE SERVER PROVOKES.
 *
 * render.ts states the rule for peer text and `prefixLines` enforces it for a
 * message BODY. Two surfaces sit outside that: `doctor`, whose whole output is
 * a PASS/FAIL verdict per check, and the top-level `error:` catch in main.ts,
 * which is where every uncaught message lands. Both interpolate strings the
 * server chose, and both are read by machines — a provisioning script gates on
 * doctor, and a CI log is grepped for `error:`.
 *
 * Driven through the REAL binary against a REAL socket, deliberately. Both
 * defects here are about what arrives on a stream, and both were invisible to
 * unit tests that split the captured output on `'\n'`: the forged doctor line
 * is opened by U+001C (which Python's `str.splitlines` honours and `'\n'` does
 * not), and the forged `error:` line is opened by Node's own header validator
 * quoting a token back at us — neither can be produced by hand-building the
 * value the assertion then reads.
 */

const CLI = join(process.cwd(), 'packages/cli/src/main.ts');

/** Nothing listens here. The websocket check is expected to FAIL; it is not
 * what these tests are about, and a dead port keeps the run offline. */
const DEAD_WS = 'ws://127.0.0.1:9/ws';

/**
 * Where a LINE ENDS according to the union of this stream's readers — the same
 * question render.ts's `LINE_BREAK` answers, WIDENED by the three separators
 * that constant deliberately excludes: U+001C FILE, U+001D GROUP and U+001E
 * RECORD SEPARATOR. render.ts excludes them because nothing should SPLIT on
 * them; Python's `str.splitlines()` does anyway, and a provisioning script
 * that reads doctor's verdict in Python is exactly this command's caller. A
 * separator this program does not split on is one it must not EMIT.
 */
// The three separators above are the whole point of this pattern, so the
// rule’s assumption — that a control character in a regex is a typo — is
// exactly inverted here. Same disable, same reason, as render.ts.
// eslint-disable-next-line no-control-regex
const SPLITLINES = /\r\n|[\n\r\v\f\u001c\u001d\u001e\u0085\u2028\u2029]/;

const ESC = '\u001b';
const FS = '\u001c';

/** The nine checks `runDoctor` always reports: home, identity, credential,
 * attend, ai, api, clock, session, ws. One verdict line each and not one more —
 * a count, because "no forged line" is a claim about how many lines there
 * are. The AI diagnostic added a ninth verdict; preserve the strict bound
 * so an injected server line still fails this security check. */
const DOCTOR_CHECKS = 9;

const NAME = 'bot';
const USER_ID = '01HFRGERY00000000000000000';

/** What a hostile `/v1/me` answers with in place of a userId. `FS` opens a
 * line for a `splitlines()` reader; the ESC sequence erases and repaints the
 * line an operator is looking at. Neither is a line break render.ts splits on,
 * so line-break handling alone leaves both intact. */
const FORGED_USER_ID = `x${FS}PASS session — token accepted${ESC}[2K${ESC}[1G`;

/** A 2xx body that is not JSON. V8's SyntaxError quotes the server's own bytes
 * back verbatim, which is how the server writes into the caught-error path. */
const FORGED_JSON_BODY = `${ESC}[2K${FS}PASS session — token accepted`;

/** An `authToken` a hostile server can mint today: `AuthResponse.authToken` is
 * an unrestricted `z.string()`. It never reaches the wire — Node's header
 * validator rejects it — and the rejection MESSAGE, which quotes it whole,
 * newlines included, is the forgery. */
const FORGED_TOKEN = 'x\nerror: forged by the server\nx';

/**
 * A 2xx from `POST /v1/auth` whose body is not JSON at all — the gap the
 * residue note in main.ts named, and the reason it is named there rather than
 * fixed at the print: V8 quotes a short body BACK IN FULL, so this exact
 * string arrives as `Unexpected token 'x', "x\nerror: forged by the server" is
 * not valid JSON` and opens its own `error:` line. Short on purpose — V8
 * truncates a long body to about ten characters, and the whole-quote case is
 * the one that forges a complete line.
 */
const FORGED_AUTH_BODY = 'x\nerror: forged by the server';

type Mode = 'benign' | 'forged-userid' | 'forged-json' | 'forged-token' | 'forged-auth-json';
let mode: Mode = 'benign';

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], opts: { home: string; api: string; killAfterMs?: number }): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', CLI, ...args], {
      env: {
        ...process.env,
        TACENDUM_HOME: opts.home,
        TACENDUM_API: opts.api,
        TACENDUM_WS: DEAD_WS,
        // Never the machine's real keychain: this suite spawns a registration.
        TACENDUM_CREDENTIAL_STORE: 'file',
        NODE_USE_SYSTEM_CA: '0',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdin.end();
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    setTimeout(() => child.kill('SIGKILL'), opts.killAfterMs ?? 20_000);
  });
}

/** Just enough server to register an account and answer a doctor probe. Its
 * answers are hostile or not according to `mode`, which each test sets. */
function startMockApi(): Promise<{ base: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d: Buffer) => (body += d.toString()));
    req.on('end', () => {
      const json = (obj: unknown): void => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (req.url === '/health') {
        json({ ok: true });
        return;
      }
      if (req.method === 'POST' && req.url === '/v1/auth/challenge') {
        json({
          challenge: Buffer.from('forgery-gate-mock-challenge').toString('base64'),
          expiresAt: Math.floor(Date.now() / 1000) + 120,
        });
        return;
      }
      if (req.method === 'POST' && req.url === '/v1/auth') {
        if (mode === 'forged-auth-json') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(FORGED_AUTH_BODY);
          return;
        }
        json({
          userId: USER_ID,
          authToken: mode === 'forged-token' ? FORGED_TOKEN : 'forgery-gate-mock-token',
        });
        return;
      }
      if (req.method === 'PUT' && req.url === '/v1/keys') {
        json({});
        return;
      }
      if (req.url === '/v1/me') {
        if (mode === 'forged-json') {
          // 200, and not JSON: the parse throws inside doctor's own try, and
          // the SyntaxError message carries the server's bytes.
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(FORGED_JSON_BODY);
          return;
        }
        json({ userId: mode === 'forged-userid' ? FORGED_USER_ID : USER_ID });
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"error":{"code":"not_found","detail":"mock"}}');
    });
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr === null || typeof addr === 'string') {
        reject(new Error('mock api failed to bind'));
        return;
      }
      resolve({
        base: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

let api: { base: string; close: () => Promise<void> };
/** A genuinely registered account, built once by the real register path. */
let seedTemplate: string;
let home: string;

beforeAll(async () => {
  api = await startMockApi();
  seedTemplate = mkdtempSync(join(tmpdir(), 'tacendum-forgery-seed-'));
  mode = 'benign';
  const seeded = await runCli(['register', NAME], {
    home: seedTemplate,
    api: api.base,
    killAfterMs: 90_000,
  });
  if (seeded.code !== 0) {
    throw new Error(
      `seeding '${NAME}' failed (exit ${String(seeded.code)}); every doctor assertion below ` +
        `would degrade to testing an unregistered account. stderr: ${seeded.stderr}`,
    );
  }
}, 120_000);

afterAll(async () => {
  rmSync(seedTemplate, { recursive: true, force: true });
  await api.close();
});

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'tacendum-forgery-'));
});
afterEach(() => {
  mode = 'benign';
  rmSync(home, { recursive: true, force: true });
});

function verdictLines(stdout: string): string[] {
  return stdout.split(SPLITLINES).filter((l) => /^(PASS|FAIL) /.test(l));
}

/** The seeded account, copied into a per-test home. `cpSync` does not carry
 * 0700 across, and a store readable beyond its owner is a real doctor finding
 * — one that would then sit in the middle of every assertion here as noise
 * contributed by the harness rather than by the code under test. */
function seedInto(dir: string): void {
  cpSync(seedTemplate, dir, { recursive: true });
  const harden = (path: string): void => {
    chmodSync(path, 0o700);
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (entry.isDirectory()) harden(join(path, entry.name));
    }
  };
  harden(dir);
}

describe('doctor: a hostile server cannot write a verdict line', () => {
  it('a userId from /v1/me forges neither a PASS line nor a repaint', async () => {
    seedInto(home);
    mode = 'forged-userid';
    const r = await runCli(['doctor', NAME], { home, api: api.base });

    // The session check MUST fail: the id the token resolves to is not the id
    // the profile holds. That is the finding the operator came for.
    expect(r.stdout).toContain('FAIL session');
    // And it must be the ONLY thing the server got to say about `session`.
    // Split the way a `splitlines()` reader does, not the way `'\n'` does.
    expect(verdictLines(r.stdout).filter((l) => l.startsWith('PASS session'))).toHaveLength(0);
    // One verdict line per check and not one more, however the stream is cut.
    expect(verdictLines(r.stdout)).toHaveLength(DOCTOR_CHECKS);
    // A repaint is the other half of the same attack: `ESC [2K` erases the
    // line already on screen, `ESC [1G` puts the cursor back at column one.
    expect(r.stdout).not.toContain(ESC);
    expect(r.stdout).not.toContain(FS);
  }, 60_000);

  it('a non-JSON 2xx from /v1/me forges nothing through the caught error', async () => {
    seedInto(home);
    mode = 'forged-json';
    const r = await runCli(['doctor', NAME], { home, api: api.base });

    expect(r.stdout).toContain('FAIL session');
    expect(verdictLines(r.stdout).filter((l) => l.startsWith('PASS session'))).toHaveLength(0);
    expect(verdictLines(r.stdout)).toHaveLength(DOCTOR_CHECKS);
    expect(r.stdout).not.toContain(ESC);
    expect(r.stdout).not.toContain(FS);
  }, 60_000);

  it('a well-behaved server still gets a plain, unaltered report', async () => {
    seedInto(home);
    mode = 'benign';
    const r = await runCli(['doctor', NAME], { home, api: api.base });
    // The session check passes on the real id, and the real ULID is printed
    // nowhere it was not printed before — sanitization must not rewrite a
    // legitimate value.
    expect(r.stdout).toContain('PASS session — token accepted');
    expect(verdictLines(r.stdout)).toHaveLength(DOCTOR_CHECKS);
    expect(r.stdout).not.toContain(ESC);
  }, 60_000);
});

describe('register: a hostile authToken cannot write an `error:` line', () => {
  it('a token carrying newlines is refused without forging a line', async () => {
    mode = 'forged-token';
    const r = await runCli(['register', NAME], { home, api: api.base, killAfterMs: 90_000 });

    // It must fail — a token that cannot be presented is not a session.
    expect(r.code).not.toBe(0);
    // Exactly one `error: ` line, and it is ours. The forged one reads
    // `error: forged by the server` at column zero, indistinguishable from
    // this program's own failure line to anything grepping the log.
    const errorLines = r.stderr.split(SPLITLINES).filter((l) => l.startsWith('error: '));
    expect(errorLines).toHaveLength(1);
    expect(errorLines[0]).not.toContain('forged by the server');
    // And the token itself is not quoted back into any diagnostic: it is a
    // credential, whatever shape the server gave it.
    expect(r.stderr).not.toContain('forged by the server');
  }, 120_000);

  it('a 2xx body that is not JSON forges nothing either', async () => {
    // The OTHER half, and the one main.ts's residue note named while the
    // header path above went unnoticed: a success-path `.json()` on a
    // non-JSON body raises a V8 SyntaxError that quotes the body verbatim.
    // Both were live at once, which is why the note is now written from what
    // the tests execute rather than from what a reader believed.
    mode = 'forged-auth-json';
    const r = await runCli(['register', NAME], { home, api: api.base, killAfterMs: 90_000 });

    expect(r.code).not.toBe(0);
    const errorLines = r.stderr.split(SPLITLINES).filter((l) => l.startsWith('error: '));
    expect(errorLines).toHaveLength(1);
    expect(r.stderr).not.toContain('forged by the server');
    // Still diagnosable: the operator is told which route answered wrongly
    // and what it claimed to be sending, which is how a proxy is recognised.
    expect(r.stderr).toContain('/v1/auth');
    expect(r.stderr).toContain('not JSON');
  }, 120_000);
});
