import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  findRepoEnvFile,
  loadEnvFileIfPresent,
  resolveEndpoints,
} from '../src/config.js';

// Blocker: the documented "local" workflow silently talked to production —
// a test suite made four unauthenticated POSTs to api.tacendum.com
// believing it was on localhost. These tests pin the three layers
// of the fix: TACENDUM_ENV resolution (typos throw instead of falling
// through to production), checkout-only .env loading (set env wins, foreign
// keys filtered), and the startup line that names the target.

const PROD = { api: 'https://api.tacendum.com', ws: 'wss://ws.tacendum.com' };
const LOCAL = { api: 'http://localhost:8080', ws: 'ws://localhost:8081/ws' };

// Everything here mutates process.env or the module registry; snapshot and
// restore so ordering against the other cli tests (which set TACENDUM_API
// before importing config) cannot matter.
const SAVED_KEYS = ['TACENDUM_ENV', 'TACENDUM_API', 'TACENDUM_WS'] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of SAVED_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of SAVED_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.restoreAllMocks();
});

describe('resolveEndpoints — the matrix', () => {
  it('defaults to production with nothing set (installed-tool rationale)', () => {
    expect(resolveEndpoints({})).toMatchObject(PROD);
  });

  it('TACENDUM_ENV=local selects the local set — both urls at once', () => {
    expect(resolveEndpoints({ TACENDUM_ENV: 'local' })).toMatchObject(LOCAL);
  });

  it('TACENDUM_ENV=aws selects production explicitly', () => {
    expect(resolveEndpoints({ TACENDUM_ENV: 'aws' })).toMatchObject(PROD);
  });

  it('an unknown TACENDUM_ENV throws — never falls through to production', () => {
    expect(() => resolveEndpoints({ TACENDUM_ENV: 'staging' })).toThrow(
      /staging/,
    );
    // The failure names the variable so the fix is obvious from the message.
    expect(() => resolveEndpoints({ TACENDUM_ENV: 'locl' })).toThrow(
      /TACENDUM_ENV/,
    );
  });

  it('empty string means unset — the shell idiom to force defaults past a .env', () => {
    expect(resolveEndpoints({ TACENDUM_ENV: '' })).toMatchObject(PROD);
  });

  it('TACENDUM_API alone overrides the api and leaves ws at its default', () => {
    const r = resolveEndpoints({ TACENDUM_API: 'http://127.0.0.1:9099' });
    expect(r.api).toBe('http://127.0.0.1:9099');
    expect(r.ws).toBe(PROD.ws);
  });

  it('individual overrides beat TACENDUM_ENV — the gates depend on this', () => {
    // scripts/e2e.sh and scripts/e2e-cli.sh export TACENDUM_API/TACENDUM_WS
    // explicitly and must win no matter what a contributor's .env says.
    const r = resolveEndpoints({
      TACENDUM_ENV: 'aws',
      TACENDUM_API: 'http://localhost:18080',
      TACENDUM_WS: 'ws://localhost:18081/ws',
    });
    expect(r.api).toBe('http://localhost:18080');
    expect(r.ws).toBe('ws://localhost:18081/ws');
  });

  it('TACENDUM_WS alone overrides only the socket', () => {
    const r = resolveEndpoints({
      TACENDUM_ENV: 'local',
      TACENDUM_WS: 'ws://localhost:2323/ws',
    });
    expect(r.api).toBe(LOCAL.api);
    expect(r.ws).toBe('ws://localhost:2323/ws');
  });
});

describe('loadEnvFileIfPresent', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tacendum-env-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('a null or absent path is a no-op, not an error', () => {
    expect(() => loadEnvFileIfPresent(null)).not.toThrow();
    expect(() => loadEnvFileIfPresent(join(dir, 'missing.env'))).not.toThrow();
  });

  it('sets unset variables from the file', () => {
    const file = join(dir, '.env');
    writeFileSync(file, 'TACENDUM_ENV=local\n');
    loadEnvFileIfPresent(file);
    expect(process.env.TACENDUM_ENV).toBe('local');
  });

  it('variables already set in the environment win over the file', () => {
    const file = join(dir, '.env');
    writeFileSync(file, 'TACENDUM_ENV=local\nTACENDUM_API=http://file:1\n');
    process.env.TACENDUM_ENV = 'aws';
    loadEnvFileIfPresent(file);
    expect(process.env.TACENDUM_ENV).toBe('aws');
    expect(process.env.TACENDUM_API).toBe('http://file:1');
  });

  it('filters keys the CLI does not own — .env also carries CDK identifiers', () => {
    // vitest reuses forked workers across files and infra tests fall back to
    // process.env (infra/lib/deployment-config.ts); leaking the deploy
    // identifiers out of .env would let the operator's values silently
    // reconfigure those tests.
    const file = join(dir, '.env');
    writeFileSync(
      file,
      'TACENDUM_ENV=local\nTACENDUM_HOSTED_ZONE_ID_CONFIGTEST=Z999\n',
    );
    loadEnvFileIfPresent(file);
    expect(process.env.TACENDUM_ENV).toBe('local');
    expect(process.env.TACENDUM_HOSTED_ZONE_ID_CONFIGTEST).toBeUndefined();
  });
});

describe('findRepoEnvFile', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tacendum-root-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // `name` defaults to the real root package identity; foreign-monorepo
  // tests pass their own to model a stranger's tree.
  function makeRepo(root: string, name = 'tacendum'): void {
    mkdirSync(join(root, 'packages', 'cli'), { recursive: true });
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n');
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name }));
  }

  it('walks up to a Tacendum checkout root and returns its .env', () => {
    makeRepo(dir);
    writeFileSync(join(dir, '.env'), 'TACENDUM_ENV=local\n');
    const nested = join(dir, 'packages', 'cli', 'src');
    mkdirSync(nested, { recursive: true });
    expect(findRepoEnvFile(nested)).toBe(join(dir, '.env'));
  });

  it('returns null when the checkout root has no .env', () => {
    makeRepo(dir);
    expect(findRepoEnvFile(join(dir, 'packages', 'cli'))).toBeNull();
  });

  it('a workspace file alone is not a checkout — installed copies inside a stranger monorepo load nothing', () => {
    writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'packages:\n');
    writeFileSync(join(dir, '.env'), 'TACENDUM_ENV=local\n');
    const nested = join(dir, 'node_modules', '@tacendum', 'cli', 'dist');
    mkdirSync(nested, { recursive: true });
    expect(findRepoEnvFile(nested)).toBeNull();
  });

  // An external review reproduced this exact shape:
  // a HOST monorepo that has BOTH structural markers — pnpm-workspace.yaml
  // and its own packages/cli — with @tacendum/cli installed under its
  // node_modules. The two-marker test accepted the host as "the checkout"
  // and loaded the host's .env, breaking the promised production default
  // for installed copies.
  it('a foreign monorepo with BOTH markers still loads nothing from node_modules', () => {
    makeRepo(dir, 'someone-elses-product');
    writeFileSync(join(dir, '.env'), 'TACENDUM_ENV=local\n');
    const installed = join(dir, 'node_modules', '@tacendum', 'cli', 'dist');
    mkdirSync(installed, { recursive: true });
    expect(findRepoEnvFile(installed)).toBeNull();
  });

  it('node_modules is rejected even under a root that claims our name', () => {
    // The name check alone would pass here; only the node_modules-segment
    // check refuses. Models an install nested inside a packages/cli — the
    // lexical "under packages/cli" test is satisfied.
    makeRepo(dir, 'tacendum');
    writeFileSync(join(dir, '.env'), 'TACENDUM_ENV=local\n');
    const installed = join(
      dir, 'packages', 'cli', 'node_modules', '@tacendum', 'cli', 'dist',
    );
    mkdirSync(installed, { recursive: true });
    expect(findRepoEnvFile(installed)).toBeNull();
  });

  it('a module outside the candidate root\'s own packages/cli proves nothing', () => {
    // Both markers present, correct-looking .env, module under apps/tool —
    // only the "this module lives under packages/cli" check refuses.
    makeRepo(dir, 'someone-elses-product');
    writeFileSync(join(dir, '.env'), 'TACENDUM_ENV=local\n');
    const elsewhere = join(dir, 'apps', 'tool', 'dist');
    mkdirSync(elsewhere, { recursive: true });
    expect(findRepoEnvFile(elsewhere)).toBeNull();
  });

  it('both markers under packages/cli but a foreign root identity is refused', () => {
    // Only the package-name check refuses this one: a stranger's monorepo
    // whose own CLI source imports an installed @tacendum/cli would present
    // exactly this shape after bundling.
    makeRepo(dir, 'someone-elses-product');
    writeFileSync(join(dir, '.env'), 'TACENDUM_ENV=local\n');
    const nested = join(dir, 'packages', 'cli', 'src');
    mkdirSync(nested, { recursive: true });
    expect(findRepoEnvFile(nested)).toBeNull();
  });

  it('a root with no package.json at all is refused, not crashed on', () => {
    mkdirSync(join(dir, 'packages', 'cli', 'src'), { recursive: true });
    writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'packages:\n');
    writeFileSync(join(dir, '.env'), 'TACENDUM_ENV=local\n');
    expect(findRepoEnvFile(join(dir, 'packages', 'cli', 'src'))).toBeNull();
  });
});

describe('module startup', () => {
  it('an invalid TACENDUM_ENV fails the import — loudly, at startup', async () => {
    process.env.TACENDUM_ENV = 'produciton'; // the typo that must not reach prod
    vi.resetModules();
    // Silence the would-be startup line; the import must die before it.
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await expect(import('../src/config.js')).rejects.toThrow(/produciton/);
  });

  it('emits one stderr line naming the resolved api host', async () => {
    process.env.TACENDUM_API = 'http://127.0.0.1:9099';
    vi.resetModules();
    const write = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    await import('../src/config.js');
    const lines = write.mock.calls
      .map((c) => String(c[0]))
      .filter((s) => s.startsWith('tacendum: api '));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('127.0.0.1:9099');
  });
});
