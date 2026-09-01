import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * INVARIANT HARNESS — a secret handed to this CLI never comes back out.
 *
 * Why a harness and not another test. the log-hygiene rule says message plaintext is
 * never logged or put in an error, and that rule has now been broken and
 * "fixed" three separate times in three different files: the argument parser
 * echoed a rejected flag, the recipient resolver echoed an unrecognised
 * address, and each fix was a SHAPE ALLOWLIST that a differently-shaped secret
 * walked straight through (`--token=…` passed the flag-name test;
 * `AKIAIOSFODNN7EXAMPLE` passed the client-name test). Every one of those was
 * found by a reviewer reading code, and every one shipped because the rule
 * lived in a comment.
 *
 * So this does not test a rule; it tests the PROPERTY, the way an attacker
 * would: run the real binary with a canary in the argument, then search
 * everything the process could have touched — stdout, stderr, the `--json`
 * object, and every byte of every file under $TACENDUM_HOME.
 *
 * HOW THE FIRST VERSION OF THIS FILE LIED. It generated
 * `command filler0 filler1 <canary>` blindly, always against an empty home.
 * Three consequences, each of which let it stay green over a live leak:
 *
 *  - `pair filler0 <canary>` died at `loadProfile('filler0')` — "no such
 *    account" — so the canary in the OWNER slot was never even parsed, and
 *    `pair`'s verbatim `not a user id: <owner>` echo sat unexercised. Any
 *    command whose first act is a profile lookup was only ever tested up to
 *    that lookup.
 *  - it never generated a FLAG-VALUE position, so `--seconds <canary>` (whose
 *    rejection echoes the raw value) was unreachable by construction.
 *  - `call` and `mcp` were missing from the command list entirely.
 *
 * A harness that cannot reach the code it vouches for converts "unproven"
 * into "proven safe". So this version seeds ONE REAL registered account (a
 * genuine `tacendum register` run against a local mock API in beforeAll,
 * copied into each test's home), and drives a per-command argument matrix
 * that puts the canary in EVERY positional slot and EVERY value-flag slot,
 * with valid values everywhere else so parsing gets past its preconditions.
 *
 * The assertion is the OUTCOME only — the canary byte-sequence appears
 * nowhere the process can write. Nothing here asserts how a command fails,
 * which locks it holds, or what order it does things in; a correct refactor
 * of any command passes unchanged.
 *
 * Canary runs stay OFFLINE: their endpoints point at a closed port, so no
 * command can succeed and every run is a failure path — exactly where a value
 * gets interpolated into a message. (The mock API exists only to mint the
 * seed account, and is shut down before the first canary run.)
 */

const CLI = join(process.cwd(), 'packages/cli/src/main.ts');

/** Nothing listens here: canary runs must be failure paths. */
const DEAD_API = 'http://127.0.0.1:9';
const DEAD_WS = 'ws://127.0.0.1:9/ws';

/** Distinct shapes, because every previous leak was a shape that slipped a
 * rule written for a different one. */
const CANARIES = [
  'AKIAIOSFODNN7EXAMPLE',
  'sk-live-9f3a2b1c8d7e6f5a4b3c2d1e0f9a8b7c',
  'top secret...hunter2',
  '--token=CANARYFLAGSHAPED',
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJjYW5hcnkifQ.sig',
] as const;

/**
 * Secrets that are also LEGAL CLIENT NAMES (letters/digits/_/-, ≤32 chars) —
 * the shape that survives `checkedName` and so reaches every store- and
 * account-touching path the other canaries bounce off. Used for the
 * register-then-doctor sequence below, where the trap is precisely that the
 * name got far enough to leave a directory behind.
 */
const NAME_SHAPED_SECRETS = [
  'AKIAIOSFODNN7EXAMPLE',
  'ghp_9f3AB2c8D7e6F5a4b3C2d1E0f9',
] as const;

/**
 * A well-formed user id is deliberately NOT a canary — re-examined in an earlier revision
 * and KEPT, with the residual named honestly this time.
 *
 * The residual: a secret that happens to be exactly 26 characters of Crockford
 * base32, passed in an ADDRESS position, will be echoed — `trust` names the
 * peer it refused, `pair` names a validated owner. That is deliberate product
 * behaviour: a userId is a PUBLIC identifier (the app shows it on the my-code
 * screen, it travels in QR codes, people paste it to each other), naming the
 * refused peer is the useful half of those diagnostics, and no rule inside
 * this CLI can tell a 26-char-Crockford secret from an address, because the
 * address space IS "any 26 chars of Crockford".
 *
 * Why that residual costs almost no detection: every echo site that fires on
 * this shape fires only AFTER `isUserId()` accepted the string as an address —
 * those are the deliberate diagnostics above. An echo site NOT conditioned on
 * address shape (a format string, a rethrown raw argument, a path in a
 * remedy) echoes the other five canary shapes just as readily, and they DO
 * fail this harness. So a sixth 26-char-Crockford canary would only ever fire
 * on the sites we would then have to allowlist — which is how the first
 * version of this file taught its readers to weaken assertions instead of
 * trusting them. The complement test at the bottom pins the diagnostic from
 * the other side, so redaction work cannot quietly over-reach either.
 */
const PUBLIC_ID = 'ABCDEFGHJKMNPQRSTVWXYZ0123';

/** The seeded account: genuinely registered (mock API) in beforeAll. */
const SEEDED = 'bot';
/** What the mock mints for it — 26 chars of Crockford, like the real server. */
const SEEDED_ID = '01HARNESSB0TACCT0000000000';
/** A syntactically valid peer id for slots that need one. Never asserted on. */
const OWNER_ID = '01HARNESS0WNER000000000000';

/**
 * The argument matrix: every command the CLI dispatches, with the canary in
 * each position a value can land — every positional slot AND every value-flag
 * slot (--title, --seconds, --ice, --peer, --limit, --account, --host). Valid
 * values fill the other slots so the run gets PAST preconditions (profile
 * lookups, recipient resolution) instead of dying before the canary is read.
 */
const FORMS: readonly { label: string; args: (c: string) => string[] }[] = [
  { label: 'register <name>', args: (c) => ['register', c] },
  { label: 'pair <name> owner', args: (c) => ['pair', c, OWNER_ID] },
  { label: 'pair bot <owner>', args: (c) => ['pair', SEEDED, c] },
  { label: 'send <from> owner text', args: (c) => ['send', c, OWNER_ID, 'hello'] },
  { label: 'send bot <to> text', args: (c) => ['send', SEEDED, c, 'hello'] },
  { label: 'send bot owner <body>', args: (c) => ['send', SEEDED, OWNER_ID, c] },
  { label: 'send bot owner text <extra>', args: (c) => ['send', SEEDED, OWNER_ID, 'hello', c] },
  { label: 'send bot owner text --title <T>', args: (c) => ['send', SEEDED, OWNER_ID, 'hello', '--title', c] },
  { label: 'listen <name>', args: (c) => ['listen', c] },
  { label: 'listen bot --calls --seconds <N>', args: (c) => ['listen', SEEDED, '--calls', '--seconds', c] },
  { label: 'sync <name>', args: (c) => ['sync', c] },
  { label: 'inbox <name>', args: (c) => ['inbox', c] },
  { label: 'inbox bot --peer <id>', args: (c) => ['inbox', SEEDED, '--peer', c] },
  { label: 'inbox bot --limit <N>', args: (c) => ['inbox', SEEDED, '--limit', c] },
  { label: 'contacts <name>', args: (c) => ['contacts', c] },
  { label: 'doctor <name>', args: (c) => ['doctor', c] },
  { label: 'call <from> owner', args: (c) => ['call', c, OWNER_ID] },
  { label: 'call bot <to>', args: (c) => ['call', SEEDED, c] },
  { label: 'call bot owner --seconds <N>', args: (c) => ['call', SEEDED, OWNER_ID, '--seconds', c] },
  { label: 'call bot owner --ice <N>', args: (c) => ['call', SEEDED, OWNER_ID, '--ice', c] },
  { label: 'calllog <name>', args: (c) => ['calllog', c] },
  { label: 'whoami <name>', args: (c) => ['whoami', c] },
  { label: 'safety <name> owner', args: (c) => ['safety', c, OWNER_ID] },
  { label: 'safety bot <peer>', args: (c) => ['safety', SEEDED, c] },
  { label: 'trust <name> owner', args: (c) => ['trust', c, OWNER_ID] },
  { label: 'trust bot <peer>', args: (c) => ['trust', SEEDED, c] },
  { label: 'mcp --account <name>', args: (c) => ['mcp', '--account', c] },
  { label: 'mcp install --host <host>', args: (c) => ['mcp', 'install', '--host', c] },
  // --write so the account is REQUIRED to resolve (loadProfile) — the failure
  // path — and refused before anything is written to the host config. Plain
  // print mode deliberately emits whatever legal-shaped name it was given
  // (that block IS the product), so it cannot carry this assertion; see the
  // earlier report for the judgement call on that surface.
  { label: 'mcp install --account <name> --write', args: (c) => ['mcp', 'install', '--host', 'codex', '--account', c, '--write'] },
];

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCli(
  args: string[],
  opts: { home: string; api?: string; killAfterMs?: number },
): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', CLI, ...args], {
      env: {
        ...process.env,
        TACENDUM_HOME: opts.home,
        TACENDUM_API: opts.api ?? DEAD_API,
        TACENDUM_WS: DEAD_WS,
        NODE_USE_SYSTEM_CA: '0',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // Never let a command wait on our stdin: several read fd 0 when a body is
    // omitted, and a hanging pipe reads as a hang in the code under test.
    child.stdin.end();
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    // A command that blocks forever (listen) is killed; whatever it printed
    // before that is still searched.
    setTimeout(() => child.kill('SIGKILL'), opts.killAfterMs ?? 6_000);
  });
}

/** Every byte under $TACENDUM_HOME, so a leak into a file counts too. */
function allFileBytes(dir: string): string {
  let out = '';
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const st = statSync(path);
    if (st.isDirectory()) out += allFileBytes(path);
    else out += readFileSync(path, 'latin1');
  }
  return out;
}

/**
 * Just enough server to let a real `tacendum register` succeed: challenge,
 * auth, key upload. It exists so the seed account is produced by the real
 * registration code path (real identity key, real prekeys, real profile.json)
 * rather than by hand-written files that would drift from the real format.
 */
function startMockApi(): Promise<{ base: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d: Buffer) => (body += d.toString()));
    req.on('end', () => {
      const respond = (obj: unknown): void => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (req.method === 'POST' && req.url === '/v1/auth/challenge') {
        respond({
          challenge: Buffer.from('harness-canary-mock-challenge').toString('base64'),
          expiresAt: Math.floor(Date.now() / 1000) + 120,
        });
        return;
      }
      if (req.method === 'POST' && req.url === '/v1/auth') {
        respond({
          userId: SEEDED_ID,
          authToken: 'harness-mock-token',
          ...(body.includes('"integration"') ? { accountClass: 'integration' } : {}),
        });
        return;
      }
      if (req.method === 'PUT' && req.url === '/v1/keys') {
        respond({});
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
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

/** The seeded home, built once by a real registration and copied per test. */
let seedTemplate: string;
let home: string;

beforeAll(async () => {
  seedTemplate = mkdtempSync(join(tmpdir(), 'tacendum-canary-seed-'));
  const mock = await startMockApi();
  try {
    // Key generation takes real time; only the seed run gets a long leash.
    const r = await runCli(['register', SEEDED, '--integration'], {
      home: seedTemplate,
      api: mock.base,
      killAfterMs: 45_000,
    });
    if (r.code !== 0) {
      throw new Error(
        `seeding the '${SEEDED}' account failed (exit ${String(r.code)}) — every ` +
          `precondition-gated form below would silently regress to testing the ` +
          `profile lookup. stderr: ${r.stderr}`,
      );
    }
  } finally {
    await mock.close();
  }
}, 60_000);

afterAll(() => rmSync(seedTemplate, { recursive: true, force: true }));

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'tacendum-canary-'));
  cpSync(seedTemplate, home, { recursive: true });
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('a secret handed to the CLI never comes back out', () => {
  for (const canary of CANARIES) {
    for (const form of FORMS) {
      it(`${form.label} does not echo ${canary.slice(0, 14)}…`, async () => {
        const args = form.args(canary);
        const r = await runCli(args, { home });

        const haystack = `${r.stdout}\n${r.stderr}\n${allFileBytes(home)}`;
        // The canary is the argument, so a naive "not.toContain" would be
        // wrong if the CLI legitimately echoed a value it had accepted and
        // stored — but nothing here is a legitimate address or body: the
        // endpoints are dead, so no command can succeed, and every one of
        // these runs is a failure path. Anything that appears did so in a
        // diagnostic.
        expect(
          haystack.includes(canary),
          `leaked into output/files by: tacendum ${args.join(' ')}\n` +
            `stdout: ${r.stdout.slice(0, 300)}\nstderr: ${r.stderr.slice(0, 300)}`,
        ).toBe(false);

        // Exit 2 is Claude Code's blocking hook code and must never appear.
        expect(r.code, 'exit 2 is forbidden').not.toBe(2);
      }, 30_000);
    }
  }
});

describe('a failed registration must not launder the name into later output', () => {
  // The earlier release-blocker: `FileStores`' constructor creates the client directory
  // BEFORE any network call, so `register "$SECRET"` against an unreachable
  // API leaves the directory behind — and doctor's old "directory exists,
  // therefore the name was registered" test then echoed the secret in its
  // paths and remedies. The property: nothing a failed registration leaves
  // on disk may promote the name into any later command's output.
  for (const secret of NAME_SHAPED_SECRETS) {
    it(`register-then-doctor never echoes ${secret.slice(0, 10)}…`, async () => {
      const reg = await runCli(['register', secret], { home });
      // Guard the scenario, not the mechanism: the API is a closed port, so a
      // zero exit would mean this test no longer exercises a FAILED
      // registration and its verdict is vacuous.
      expect(reg.code, 'registration against a dead API must fail').not.toBe(0);

      const doc = await runCli(['doctor', secret], { home });
      const haystack =
        `${reg.stdout}\n${reg.stderr}\n${doc.stdout}\n${doc.stderr}\n` + allFileBytes(home);
      expect(
        haystack.includes(secret),
        `a failed registration laundered the name into output\n` +
          `register stderr: ${reg.stderr.slice(0, 300)}\n` +
          `doctor stdout: ${doc.stdout.slice(0, 400)}\ndoctor stderr: ${doc.stderr.slice(0, 300)}`,
      ).toBe(false);
    }, 60_000);
  }
});

describe('--json output is machine-clean on the same inputs', () => {
  for (const canary of CANARIES.slice(0, 3)) {
    it(`send --json does not carry ${canary.slice(0, 14)}…`, async () => {
      const r = await runCli(['send', SEEDED, canary, '--json'], { home });
      expect(`${r.stdout}${r.stderr}`.includes(canary)).toBe(false);
      // Whatever it printed on stdout must still be parseable JSON, or a
      // caller branching on it gets prose instead.
      const line = r.stdout.trim().split('\n').filter(Boolean).pop();
      if (line) expect(() => JSON.parse(line) as unknown).not.toThrow();
    }, 30_000);
  }
});

describe('redaction must not over-reach the diagnostics it protects', () => {
  it('trust names the peer it refused — a user id is public', async () => {
    // The complement of the property above, asserted so the redaction work
    // cannot quietly strip the diagnostics that make these errors worth
    // reading. See the PUBLIC_ID note for why this shape is echoable at all.
    const r = await runCli(['trust', SEEDED, PUBLIC_ID], { home });
    expect(r.stderr).toContain(PUBLIC_ID);
  }, 30_000);

  it('doctor renders the placeholder rather than printing nothing', async () => {
    // This assertion used to be its own opposite: "the seeded account has a
    // profile, so its name must NOT degrade to <name>". That encoded the
    // provenance premise the gate later killed — the local client name is
    // caller-chosen and never sent anywhere, so nothing can certify it and
    // doctor now redacts unconditionally.
    //
    // But the guard it provided was real and still needed. Without it, the
    // leak assertions above go VACUOUS the day someone makes doctor print no
    // name-bearing text at all: "output does not contain the secret" is
    // trivially true of output that contains no account text. So the witness
    // moves from "the real name appears" to "the redaction ran": a report on
    // a named account must show the placeholder, which is only reachable
    // through the same formatter the canaries traverse.
    const r = await runCli(['doctor', SEEDED], { home });
    expect(r.stdout).toContain('<name>');
    expect(r.stdout).not.toContain(SEEDED);
  }, 30_000);
});
