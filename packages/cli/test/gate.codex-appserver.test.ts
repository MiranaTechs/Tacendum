import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * THE LIVE APP-SERVER GATE — one real `accept`
 * and one real `decline` against the INSTALLED codex binary, through the
 * real driver, the real JSON-RPC client and the real duplex session seam,
 * asserting on the artifact the approved command creates. NON-SKIPPABLE BY
 * DESIGN: version skew between this client and the binary fails SILENTLY
 * (the hands-forward names it; SDK 0.3.228 ↔ CLI 2.1.187 shipped an
 * approval that "succeeded" while the tool never ran), so a machine where
 * this cannot run must go RED, not quietly green. There is no skip
 * condition in this file on purpose.
 *
 * COST: two minimal live turns, each one `touch` in a temp dir under an
 * ISOLATED CODEX_HOME — no skills, no MCP servers, no plugins, so the
 * context is the prompt, not the operator's 18k-token global config (the
 * spike measured that bleed; the isolation here is also what production
 * does).
 *
 * AUTH: the operator's real `~/.codex/auth.json` is COPIED (read-only of
 * the real home, which is never written) into the gate's isolated home —
 * the same shape production reaches by its one-time `codex login` into the
 * attend-owned home, and step 0 measured that app-server resolves auth from
 * $CODEX_HOME itself. The copy lives in a mkdtemp and is removed in
 * afterAll. Nothing in this file reads, prints, or asserts on the file's
 * CONTENTS — existence and placement only.
 */

/** The real home — `userInfo()` reads the password database, so the
 * suite-wide `$HOME` pin (vitest.config.ts) does not divert it. */
const REAL_HOME = userInfo().homedir;

/** The installed binary, found the way an operator's shell would find it,
 * with the Herd-nvm fallback because supervised/test environments lose nvm
 * from PATH (the recorded lesson behind `attend enable`'s absolute-path
 * rule). `CODEX_BIN` overrides for machines that keep it elsewhere. */
function resolveCodex(): string {
  const fromEnv = process.env.CODEX_BIN;
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  try {
    const hit = execFileSync('/usr/bin/which', ['codex'], { encoding: 'utf8' }).trim();
    if (hit !== '') return hit;
  } catch {
    /* fall through to the nvm sweep */
  }
  const nvm = join(REAL_HOME, 'Library', 'Application Support', 'Herd', 'config', 'nvm', 'versions', 'node');
  try {
    for (const v of readdirSync(nvm)) {
      const p = join(nvm, v, 'bin', 'codex');
      if (existsSync(p)) return p;
    }
  } catch {
    /* no nvm tree either */
  }
  throw new Error(
    'codex binary not found (PATH, then Herd nvm) — set CODEX_BIN. ' +
      'This gate is non-skippable: a machine that cannot run it must fail, not pass.',
  );
}
const CODEX = resolveCodex();

const home = mkdtempSync(join(tmpdir(), 'tacendum-appserver-gate-'));
process.env.TACENDUM_HOME = home;
process.env.TACENDUM_API = 'http://appserver-gate.test';
process.env.TACENDUM_WS = 'ws://appserver-gate.test';

const { realSession } = await import('../src/attend.js');
const { driverFor } = await import('../src/attend-drivers.js');
const { CODEX_APPSERVER_VERSION } = await import('../src/codex-appserver.js');
import type { AttendConfig } from '../src/attend.js';
import type { DriverIo } from '../src/attend-drivers.js';
import { hostSessionKey } from '../src/hooks.js';

const CODEX_HOME = join(home, 'state', 'gate', 'codex-home');
const WORKDIR = join(home, 'gate-workdir');

afterAll(() => {
  // The copied OAuth token must not outlive the gate.
  rmSync(home, { recursive: true, force: true });
});

/** The gate's isolated, signed-in home — built once, before any turn. */
function signedInHome(): void {
  mkdirSync(CODEX_HOME, { recursive: true, mode: 0o700 });
  mkdirSync(WORKDIR, { recursive: true });
  const real = join(REAL_HOME, '.codex', 'auth.json');
  if (!existsSync(real)) {
    throw new Error(
      'codex is not signed in on this machine (~/.codex/auth.json missing) — ' +
        'the live approval gate cannot run, and it does not skip.',
    );
  }
  const copy = join(CODEX_HOME, 'auth.json');
  copyFileSync(real, copy);
  chmodSync(copy, 0o600);
}

const cfg: AttendConfig = {
  host: 'codex',
  bin: CODEX,
  workdir: WORKDIR,
  // workspace-write + the driver's `untrusted` policy is the measured
  // approval-producing pair: the touch below escalates and
  // parks until answered.
  caps: ['-s', 'workspace-write'],
  codexDriver: 'app-server',
  ownSession: '7d9f7c3a-1b2e-4c5d-8e9f-0a1b2c3d4e5f',
  turnsPerHour: 10,
};

const io: DriverIo = {
  spawn: async () => {
    throw new Error('the app-server driver must never use the spawn seam');
  },
  session: (argv, cwd, env) => realSession(CODEX, argv, cwd, env),
};

describe('gate: codex app-server against the installed binary', () => {
  it('the installed binary is the version the vendored schema is keyed to — a bump re-verifies, never assumes', () => {
    const version = execFileSync(CODEX, ['--version'], { encoding: 'utf8' }).trim();
    expect(
      version,
      `installed codex (${version}) != vendored schema version (${CODEX_APPSERVER_VERSION}). ` +
        'Regenerate the vendored types (codex app-server generate-ts), re-read the dialect ' +
        'quirks in codex-appserver.ts against fresh captures, bump CODEX_APPSERVER_VERSION, ' +
        'and let THIS gate prove the accept/decline round-trip still holds. The failure mode ' +
        'of skipping that is silent.',
    ).toContain(CODEX_APPSERVER_VERSION);
  });

  it('app-server --help still lacks -s/--sandbox and --ignore-user-config, and still takes --strict-config', () => {
    // The caps translation exists BECAUSE these flags are absent on this
    // surface (measured 2026-08-13). A release that adds them must be
    // noticed — the translation table would deserve rethinking — rather
    // than assumed away; and a release that drops --strict-config breaks
    // the driver's argv outright.
    const help = execFileSync(CODEX, ['app-server', '--help'], { encoding: 'utf8' });
    expect(help).not.toContain('--sandbox');
    expect(/^\s*-s[,\s]/m.test(help), 'a short -s option appeared on app-server').toBe(false);
    expect(help).not.toContain('--ignore-user-config');
    expect(help).toContain('--strict-config');
  });

  it(
    'a real approval APPROVED from the ask seam runs the command — the artifact exists',
    async () => {
      signedInHome();
      const artifact = join(WORKDIR, 'approved-p22.txt');
      rmSync(artifact, { force: true });
      const payloads: string[] = [];
      const res = await driverFor('codex').runTurn(
        {
          cfg,
          route: { kind: 'own' },
          prompt: 'Run the command: touch approved-p22.txt',
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
      expect(payloads.join('\n')).toContain('approved-p22.txt');
      expect(existsSync(artifact), 'approve must release the parked command').toBe(true);
      expect(res.code).toBe(0);
      expect(res.stdout, 'the reply is the completed agentMessage text').not.toBe('');
      // The own-session key arrives on a frame and is a well-formed
      // host key; it must not have leaked into the reply channel.
      expect(res.sessionKey).toBeDefined();
      expect(hostSessionKey(res.sessionKey)).toBe(res.sessionKey);
      expect(res.stdout).not.toContain(res.sessionKey as string);
    },
    300_000,
  );

  it(
    'a real approval DECLINED does not run it — and a decline is not an error path',
    async () => {
      signedInHome();
      const artifact = join(WORKDIR, 'denied-p22.txt');
      rmSync(artifact, { force: true });
      let asked = 0;
      const res = await driverFor('codex').runTurn(
        {
          cfg,
          route: { kind: 'own' },
          prompt: 'Run the command: touch denied-p22.txt',
          account: 'gate',
          ask: async () => {
            asked += 1;
            return 'deny';
          },
        },
        io,
      );
      expect(asked).toBeGreaterThanOrEqual(1);
      expect(existsSync(artifact), 'deny must keep the command unexecuted').toBe(false);
      // Measured on 0.144.0 and re-proven here on every run: the model
      // narrates the refusal and the turn COMPLETES.
      expect(res.code).toBe(0);
      expect(res.stdout).not.toBe('');
    },
    300_000,
  );
});
