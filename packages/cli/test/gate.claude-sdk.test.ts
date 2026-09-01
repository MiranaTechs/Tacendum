import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * THE LIVE CLAUDE SDK GATE — one real allow
 * and one real deny through `canUseTool`, against the INSTALLED Agent SDK
 * and the operator's own claude binary, through the real driver and the
 * real ask seam. This is the CI arm the version pin demands: SDK↔CLI skew
 * fails SILENTLY, so every version bump must re-run
 * an allow/deny round-trip, not re-read a comment.
 *
 * SKIPS LOUDLY — the RULED exception to gate.codex-appserver's
 * non-skippable shape, and gate.steer-live's precedent: the sdk mode is
 * OPT-IN and API-KEY-ONLY, so a machine with no
 * ANTHROPIC_API_KEY is not a broken machine, it is the default one — the
 * codex gate has no equivalent state. What must never be quiet is the
 * skipping itself: the reason is the test title AND a console.warn, so a
 * run that skipped cannot read as a run that proved.
 *
 * COST when live: two minimal haiku turns (the model is pinned in caps —
 * the SDK's unset default was measured at $0.21 for a hello-world), each
 * one shell write in a temp workdir.
 */

const home = mkdtempSync(join(tmpdir(), 'tacendum-claude-sdk-gate-'));
process.env.TACENDUM_HOME = home;
process.env.TACENDUM_API = 'http://claude-sdk-gate.test';
process.env.TACENDUM_WS = 'ws://claude-sdk-gate.test';

const { driverFor } = await import('../src/attend-drivers.js');
const { CLAUDE_SDK_INSTALL_STEP, CLAUDE_SDK_PACKAGE, CLAUDE_SDK_VERSION } = await import(
  '../src/claude-sdk.js'
);
const { hostSessionKey } = await import('../src/hooks.js');
import type { AttendConfig } from '../src/attend.js';
import type { DriverIo } from '../src/attend-drivers.js';

/** The real home — `userInfo()` reads the password database, so the
 * suite-wide `$HOME` pin (vitest.config.ts) does not divert it. */
const REAL_HOME = userInfo().homedir;

/** The installed SDK, by RESOLUTION (never an import at collection time —
 * the absence arm must stay cheap and side-effect-free). The version is
 * read from the package.json beside the resolved entry, because the
 * package's exports map does not expose ./package.json. */
const sdk = ((): { installed: false } | { installed: true; version: string } => {
  try {
    const entry = createRequire(import.meta.url).resolve(CLAUDE_SDK_PACKAGE);
    const pkg = JSON.parse(readFileSync(join(dirname(entry), 'package.json'), 'utf8')) as {
      version?: string;
    };
    return { installed: true, version: typeof pkg.version === 'string' ? pkg.version : '' };
  } catch {
    return { installed: false };
  }
})();

/** The operator's claude binary, found the way an operator's shell would
 * find it, with the Herd-nvm fallback (the recorded lesson behind `attend
 * enable`'s absolute-path rule). `CLAUDE_BIN` overrides. */
function resolveClaude(): string | undefined {
  const fromEnv = process.env.CLAUDE_BIN;
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  try {
    const hit = execFileSync('/usr/bin/which', ['claude'], { encoding: 'utf8' }).trim();
    if (hit !== '') return hit;
  } catch {
    /* fall through */
  }
  for (const guess of ['/opt/homebrew/bin/claude', '/usr/local/bin/claude']) {
    if (existsSync(guess)) return guess;
  }
  const nvm = join(REAL_HOME, 'Library', 'Application Support', 'Herd', 'config', 'nvm', 'versions', 'node');
  try {
    for (const v of readdirSync(nvm)) {
      const p = join(nvm, v, 'bin', 'claude');
      if (existsSync(p)) return p;
    }
  } catch {
    /* no nvm tree either */
  }
  return undefined;
}
const CLAUDE = resolveClaude();

const KEY = process.env.ANTHROPIC_API_KEY;
const keyPresent = typeof KEY === 'string' && KEY.trim() !== '';

/** Why the live arms cannot run here, spelled out — empty means they can. */
const missing: string[] = [];
if (!sdk.installed) {
  missing.push(`the Claude Agent SDK is not installed (operator step: ${CLAUDE_SDK_INSTALL_STEP})`);
} else if (sdk.version !== CLAUDE_SDK_VERSION) {
  missing.push(
    `installed SDK ${sdk.version} != tested ${CLAUDE_SDK_VERSION} — an unverified pair must ` +
      'not be live-run; re-verify and bump the constant',
  );
}
if (!keyPresent) {
  missing.push('ANTHROPIC_API_KEY is not set — the sdk mode is API-key-only');
}
if (CLAUDE === undefined) {
  missing.push('no claude binary found (CLAUDE_BIN, PATH, homebrew, Herd nvm)');
}
const LIVE = missing.length === 0;

const WORKDIR = join(home, 'gate-workdir');

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

/**
 * THE VERSION PIN, asserted whenever the SDK is present at all — the
 * codex-appserver gate's canary shape: a bump must FAIL here until someone
 * re-proves the allow/deny round-trip on the new pair, because the failure
 * mode of assuming it is silent.
 */
describe('gate: the SDK↔driver version pin', () => {
  it.skipIf(!sdk.installed)(
    'the installed SDK is the version the driver’s shapes are keyed to — a bump re-verifies, never assumes',
    () => {
      expect(
        sdk.installed ? sdk.version : '(absent)',
        `installed ${CLAUDE_SDK_PACKAGE} != tested ${CLAUDE_SDK_VERSION}. Re-read the shapes ` +
          'claude-sdk.ts vouches for (apiKeySource union, PermissionResult, PermissionMode) ' +
          'against the new sdk.d.ts, bump CLAUDE_SDK_VERSION, and let THIS gate prove the ' +
          'allow/deny round-trip still holds. The failure mode of skipping that is silent.',
      ).toBe(CLAUDE_SDK_VERSION);
    },
  );
  it.skipIf(sdk.installed)('SKIPPED LOUDLY: the SDK is absent, so there is no pair to pin', ctx => {
    console.warn(
      `[gate.claude-sdk] version pin SKIPPED: the SDK is not installed ` +
        `(${CLAUDE_SDK_INSTALL_STEP}).`,
    );
    ctx.skip();
  });
});

if (!LIVE) {
  describe('gate: claude sdk allow/deny against the installed SDK — SKIPPED', () => {
    it(`SKIPPED LOUDLY: ${missing.join('; ')}`, ctx => {
      console.warn(
        `[gate.claude-sdk] LIVE ARMS SKIPPED:\n - ${missing.join('\n - ')}\n` +
          'The measured canUseTool allow/deny round-trip was NOT re-proven on this machine.',
      );
      ctx.skip();
    });
  });
} else {
  const BIN = CLAUDE as string;

  const cfg: AttendConfig = {
    host: 'claude',
    bin: BIN,
    workdir: WORKDIR,
    // default mode + haiku: the measured approval-producing pair on the
    // cheap model — a shell WRITE escalates under 'default' and parks in
    // canUseTool.
    caps: ['--permission-mode', 'default', '--model', 'haiku'],
    claudeDriver: 'sdk',
    ownSession: '7d9f7c3a-1b2e-4c5d-8e9f-0a1b2c3d4e5f',
    turnsPerHour: 10,
  };

  const io: DriverIo = {
    spawn: async () => {
      throw new Error('the sdk mode must never use the spawn seam');
    },
    // No sdkImport: the REAL lazy import, the thing the licence ruling ships.
  };

  describe('gate: claude sdk allow/deny against the installed SDK', () => {
    it(
      'a real approval APPROVED from the ask seam runs the tool — the artifact exists',
      async () => {
        mkdirSync(WORKDIR, { recursive: true });
        const artifact = join(WORKDIR, 'approved-p25.txt');
        rmSync(artifact, { force: true });
        const payloads: string[] = [];
        const res = await driverFor('claude').runTurn(
          {
            cfg,
            route: { kind: 'own' },
            prompt: 'Run this exact bash command: echo hi > approved-p25.txt. Then reply with just: done',
            account: 'gate',
            ask: async a => {
              payloads.push(a.payload);
              return 'approve';
            },
          },
          io,
        );
        expect(payloads.length, 'the turn must ask before it may write').toBeGreaterThanOrEqual(1);
        // The exact protocol payload, not model prose: the command names the file.
        expect(payloads.join('\n')).toContain('approved-p25.txt');
        expect(existsSync(artifact), 'approve must release the parked tool').toBe(true);
        expect(res.code).toBe(0);
        expect(res.stdout, 'the reply is the result text').not.toBe('');
        // The captured session id is a typed field, well-formed, and never
        // in the reply channel.
        expect(res.sessionKey).toBeDefined();
        expect(hostSessionKey(res.sessionKey)).toBe(res.sessionKey);
        expect(res.stdout).not.toContain(res.sessionKey as string);
      },
      300_000,
    );

    it(
      'a real approval DENIED does not run it — and the deny is the fixed sentence, not an error path',
      async () => {
        mkdirSync(WORKDIR, { recursive: true });
        const artifact = join(WORKDIR, 'denied-p25.txt');
        rmSync(artifact, { force: true });
        let asked = 0;
        const res = await driverFor('claude').runTurn(
          {
            cfg,
            route: { kind: 'own' },
            prompt: 'Run this exact bash command: echo hi > denied-p25.txt. Then reply with just: done',
            account: 'gate',
            ask: async () => {
              asked += 1;
              return 'deny';
            },
          },
          io,
        );
        expect(asked).toBeGreaterThanOrEqual(1);
        expect(existsSync(artifact), 'deny must keep the tool unexecuted').toBe(false);
        expect(res.code, 'the model narrates a deny; the turn completes').toBe(0);
        expect(res.stdout).not.toBe('');
      },
      300_000,
    );
  });
}
