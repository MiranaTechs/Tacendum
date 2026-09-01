import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
// @ts-expect-error — a plain-JS build script module; the cli tsconfig
// typechecks src/ only, and the resolver deliberately lives beside build.mjs
// so the script that ships is the code under test.
import { resolveCommit } from '../build-stamp.mjs';
// @ts-expect-error — the same plain-JS story for the build's containment
// guards, which live beside build.mjs so the code that ships is under test.
import {
  assertInputsAttested,
  assertShipDirIsThisBuild,
  isPackagingRun,
  resolveOutDir,
} from '../build-guards.mjs';
import { LICENSE } from '../src/version.js';

/**
 * The publishable-package contract: the gap between "these commands
 * exist" and "this is a product".
 *
 * These assertions pin the manifest facts a stranger's `npm i -g` depends on,
 * and run the build script against a scratch directory to prove the artifact
 * it produces is the one `bin` points at: executable, shebanged, and carrying
 * the licence text. Scratch rather than the real dist/ because parallel test
 * workers may be reading dist/ while this file runs.
 */

const pkgRoot = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

interface Manifest {
  version?: string;
  description?: string;
  license?: string;
  bin?: Record<string, string>;
  files?: string[];
  engines?: { node?: string };
  scripts?: Record<string, string>;
  private?: boolean;
}

const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8')) as Manifest;

describe('package manifest', () => {
  it('carries a real release version, not the 0.0.0 placeholder', () => {
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pkg.version).not.toBe('0.0.0');
    expect(pkg.private).toBeUndefined();
  });

  it('wires both bin names to the built artifact inside the shipped files', () => {
    expect(pkg.bin?.tacendum).toBe('./dist/main.js');
    expect(pkg.bin?.['tacendum-cli']).toBe('./dist/main.js');
    // `files` is the whole ship manifest: dist/ plus npm's automatic
    // package.json + README inclusion, and nothing else — no test/, no src/,
    // no fixture or credential material can reach the tarball through it.
    expect(pkg.files).toEqual(['dist']);
    // The artifact `bin` names must actually get built on pack.
    expect(pkg.scripts?.prepack).toBe('node build.mjs');
  });

  it('states the true Node floor: process.loadEnvFile (config.ts) landed in 20.12', () => {
    expect(pkg.engines?.node).toBe('>=20.12');
  });

  it('declares the licence --version prints and the repo LICENSE contains', () => {
    expect(pkg.license).toBe(LICENSE); // 'AGPL-3.0-only', pinned in version.test.ts
    expect(readFileSync(join(repoRoot, 'LICENSE'), 'utf8')).toContain(
      'GNU AFFERO GENERAL PUBLIC LICENSE',
    );
  });
});

describe('README', () => {
  // npm ships a package-root README automatically; absent, the npm page is
  // blank and the tarball explains nothing.
  const readmePath = join(pkgRoot, 'README.md');

  it('exists and tells a stranger how to install', () => {
    expect(existsSync(readmePath)).toBe(true);
    const readme = readFileSync(readmePath, 'utf8');
    expect(readme).toContain('npm install -g @tacendum/cli');
  });

  it('states the licence and the exit-2 guarantee', () => {
    const readme = readFileSync(readmePath, 'utf8');
    expect(readme).toContain('AGPL-3.0-only');
    // The one behaviour every agent host depends on; the README is where a
    // hook author reads it.
    expect(readme).toContain('**2 is deliberately never used.**');
  });

  // The claims below were each FALSE and each gate-reproduced against the
  // running code (external review). A README is the most-read
  // false-comment surface there is, and this one becomes the npm page, so
  // the corrected wording is pinned: these assertions fail if any claim
  // drifts back toward the flattering lie.
  it('states the TRUE send boundary: owner or crew, not "exactly one person"', () => {
    const readme = readFileSync(readmePath, 'utf8');
    // ws.ts's send predicate: owner, or a fellow INTEGRATION in the crew the
    // owner assembled (sameCrew). Two crewed integrations CAN message each
    // other — reproduced through the real handler — so "one recipient per
    // integration" must not be claimed.
    expect(readme).toContain('crew');
    expect(readme).not.toContain('exactly one person');
    expect(readme).not.toContain('One recipient per integration');
    expect(readme).toContain('never to strangers');
  });

  it('does not call the MCP tools read-only: acknowledge persists read state', () => {
    const readme = readFileSync(readmePath, 'utf8');
    // mcp.ts's own security property is narrower and true: there is no send
    // tool. tacendum_acknowledge_messages writes the read mark and starts
    // the retention clock that purges bodies — not read-only.
    expect(readme).toContain('no send tool');
    expect(readme.toLowerCase()).not.toContain('read-only tools');
  });

  it("run's drop-in claim carries its one exception: child exit 2 becomes 1", () => {
    const readme = readFileSync(readmePath, 'utf8');
    // wrapperExitCode (run.ts): a child exit of 2 is deliberately remapped to
    // 1, so "returns the child's exit code" unqualified is false.
    expect(readme).toContain('a child exit of **2 is reported as 1**');
  });

  it('the exit table matches the code: 3 can mean restore-from-backup, 7 covers the QR wait, 8 covers ws frames', () => {
    const readme = readFileSync(readmePath, 'utf8');
    // keychain.ts: a lost/foreign credential says "restore identity.json from
    // backup" — re-pair is the wrong remedy there, the key IS the account.
    expect(readme).toContain('restore `identity.json` from backup');
    // setup.ts throws EXIT.TIMEOUT when the QR wait ends before ANY frame was
    // accepted — not only after a server accepted a frame.
    expect(readme).toContain("`setup`'s QR wait");
    // wsclient.ts maps the server's `rate_limited` error frame to exit 8 —
    // not only an HTTP 429.
    expect(readme).toContain('`rate_limited` WebSocket error frame');
  });
});

describe('build.mjs artifact', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'tacendum-pack-'));
  afterAll(() => rmSync(outDir, { recursive: true, force: true }));

  it(
    'produces an executable, shebanged bundle carrying the licence text',
    () => {
      execFileSync(process.execPath, [join(pkgRoot, 'build.mjs')], {
        env: { ...process.env, TACENDUM_BUILD_OUTDIR: outDir },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const artifact = join(outDir, 'main.js');
      expect(readFileSync(artifact, 'utf8').startsWith('#!/usr/bin/env node\n')).toBe(true);
      expect(statSync(artifact).mode & 0o111).not.toBe(0);

      // Byte-identical to the repo's authoritative text — `files` ships only
      // dist/, so this copy is the licence a tarball recipient receives.
      expect(readFileSync(join(outDir, 'LICENSE'), 'utf8')).toBe(
        readFileSync(join(repoRoot, 'LICENSE'), 'utf8'),
      );

      const stamp = JSON.parse(readFileSync(join(outDir, 'build-info.json'), 'utf8')) as {
        commit: string | null;
      };
      // In this working tree git can answer (possibly marked -dirty while a
      // developer's edits are in flight); from a tarball export it is null.
      expect(stamp.commit === null || /^[0-9a-f]{7,40}(-dirty)?$/.test(stamp.commit)).toBe(true);
    },
    60_000,
  );
});

describe('build reproducibility (external scan', () => {
  // The scan built the public artifact twice and got two different checksums:
  // build-info.json embedded the WALL CLOCK, so identical source produced
  // distinguishable artifacts — and nothing refused to pack a tree whose
  // uncommitted edits the stamp then misrepresented as its commit's.
  const scratch = mkdtempSync(join(tmpdir(), 'tacendum-repro-'));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  const sha256 = (p: string): string => createHash('sha256').update(readFileSync(p)).digest('hex');
  const runBuild = (outDir: string, extraEnv: Record<string, string> = {}): void => {
    // Hermetic on the two variables under test: the runner's own npm
    // lifecycle (vitest often runs under `npm test`) and any ambient
    // SOURCE_DATE_EPOCH must not leak into the child.
    const env = { ...process.env, TACENDUM_BUILD_OUTDIR: outDir };
    delete env.npm_lifecycle_event;
    delete env.SOURCE_DATE_EPOCH;
    Object.assign(env, extraEnv);
    execFileSync(process.execPath, [join(pkgRoot, 'build.mjs')], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  };

  it(
    'two builds of the same tree are byte-identical, and builtAt is the commit\'s date',
    () => {
      const a = join(scratch, 'a');
      const b = join(scratch, 'b');
      runBuild(a);
      runBuild(b);
      for (const f of ['main.js', 'LICENSE', 'build-info.json']) {
        expect(sha256(join(a, f)), `${f} must not differ across identical builds`).toBe(
          sha256(join(b, f)),
        );
      }
      // Not merely equal to each other — derived from the COMMIT, so a third
      // build next week still matches: the committer date, never the clock.
      const stamp = JSON.parse(readFileSync(join(a, 'build-info.json'), 'utf8')) as {
        builtAt: string | null;
      };
      const commitDate = execFileSync(
        'git',
        ['-C', pkgRoot, 'show', '-s', '--format=%cI', 'HEAD'],
        { stdio: ['ignore', 'pipe', 'ignore'] },
      )
        .toString()
        .trim();
      expect(stamp.builtAt).toBe(commitDate);
    },
    180_000,
  );

  it(
    'SOURCE_DATE_EPOCH, when a build environment sets it, clamps builtAt',
    () => {
      const c = join(scratch, 'c');
      runBuild(c, { SOURCE_DATE_EPOCH: '0' });
      const stamp = JSON.parse(readFileSync(join(c, 'build-info.json'), 'utf8')) as {
        builtAt: string | null;
      };
      expect(stamp.builtAt).toBe(new Date(0).toISOString());
    },
    90_000,
  );

  it(
    'a dirty tree still builds for local testing but the artifact says so; prepack refuses it',
    () => {
      // The probe is OUR dirt, inside the artifact's inputs, so the outcome
      // does not depend on whatever state the surrounding checkout is in.
      const probe = join(pkgRoot, '.build-dirt-probe');
      writeFileSync(probe, 'uncommitted\n');
      try {
        // Local developer build: allowed — but the stamp cannot claim the
        // clean commit.
        const d = join(scratch, 'd');
        runBuild(d);
        const stamp = JSON.parse(readFileSync(join(d, 'build-info.json'), 'utf8')) as {
          commit: string | null;
        };
        expect(stamp.commit, 'a dirty build must be marked, not misattributed').toMatch(/-dirty$/);

        // The publishable path (npm pack/publish run `prepack`): refused,
        // loudly, before any artifact is produced.
        let refusal: (Error & { status?: number; stderr?: Buffer }) | null = null;
        try {
          runBuild(join(scratch, 'e'), { npm_lifecycle_event: 'prepack' });
        } catch (err) {
          refusal = err as Error & { status?: number; stderr?: Buffer };
        }
        expect(refusal, 'prepack from a dirty tree must fail').not.toBeNull();
        expect(refusal?.status).not.toBe(0);
        expect(String(refusal?.stderr)).toMatch(/dirty/i);
      } finally {
        rmSync(probe, { force: true });
      }
    },
    180_000,
  );
});

describe('build inputs are exactly what the provenance stamp covers', () => {
  // Two ways unstamped bytes could ship under a clean stamp, both found by
  // the pre-publish review:
  //
  //  1. esbuild AUTO-LOADS the nearest tsconfig.json for every file it
  //     bundles, and packages/cli/tsconfig.json extends the repo-root
  //     tsconfig.base.json — a file OUTSIDE resolveCommit's dirty pathspec
  //     (packages/cli, packages/shared, LICENSE). An uncommitted `paths`
  //     mapping there redirects what `@tacendum/shared` RESOLVES TO while
  //     the stamp still claims the clean commit: bytes no reviewer of that
  //     commit ever saw, shipped under its name.
  //  2. the build wrote INTO a retained dist/ and `files: ["dist"]` ships
  //     the whole directory, so anything stale or planted there — an old
  //     bundle, a scratch file with a credential — rode every tarball.
  const scratch = mkdtempSync(join(tmpdir(), 'tacendum-inputs-'));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  it(
    'a stale file already in the output directory does not survive the build',
    () => {
      const out = join(scratch, 'stale-out');
      mkdirSync(out, { recursive: true });
      writeFileSync(join(out, 'stale-scratch.txt'), 'left by an earlier run; would ship\n');
      execFileSync(process.execPath, [join(pkgRoot, 'build.mjs')], {
        env: { ...process.env, TACENDUM_BUILD_OUTDIR: out },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      // The whole ship manifest, exactly: `files: ["dist"]` publishes every
      // byte of this directory, so its contents ARE the allowlist.
      expect(readdirSync(out).sort()).toEqual(['LICENSE', 'build-info.json', 'main.js']);
    },
    60_000,
  );

  it(
    'an uncommitted root-config paths mapping cannot redirect bundled code under a clean stamp',
    () => {
      // A scratch monorepo with the REAL build scripts (the code under test)
      // over a minimal source pair, so the repo checkout is never mutated:
      // the poisoned tsconfig.base.json is the scratch repo's uncommitted
      // dirt, not this one's.
      const home = join(scratch, 'poison-home');
      const cli = join(home, 'packages', 'cli');
      const shared = join(home, 'packages', 'shared');
      mkdirSync(join(cli, 'src'), { recursive: true });
      mkdirSync(join(shared, 'src'), { recursive: true });
      copyFileSync(join(pkgRoot, 'build.mjs'), join(cli, 'build.mjs'));
      copyFileSync(join(pkgRoot, 'build-stamp.mjs'), join(cli, 'build-stamp.mjs'));
      // build.mjs imports its containment guards from here too — the scratch
      // rig runs the real script, so it needs the real module beside it.
      copyFileSync(join(pkgRoot, 'build-guards.mjs'), join(cli, 'build-guards.mjs'));
      copyFileSync(join(repoRoot, 'LICENSE'), join(home, 'LICENSE'));
      writeFileSync(join(cli, 'package.json'), JSON.stringify({ name: 'x', type: 'module' }));
      writeFileSync(
        join(cli, 'src', 'main.ts'),
        "import { MARKER } from '@tacendum/shared';\nconsole.log(MARKER);\n",
      );
      writeFileSync(
        join(shared, 'package.json'),
        JSON.stringify({ name: '@tacendum/shared', type: 'module', main: './src/index.ts' }),
      );
      writeFileSync(join(shared, 'src', 'index.ts'), "export const MARKER = 'legit-shared';\n");
      // The same extends chain the real package carries.
      writeFileSync(join(cli, 'tsconfig.json'), JSON.stringify({ extends: '../../tsconfig.base.json' }));
      writeFileSync(join(home, 'tsconfig.base.json'), JSON.stringify({ compilerOptions: {} }));
      // Enough node_modules for the script and the workspace specifier:
      // esbuild resolved from the scratch root exactly as the comment in
      // build.mjs says it resolves from this one's.
      mkdirSync(join(home, 'node_modules'), { recursive: true });
      symlinkSync(join(repoRoot, 'node_modules', 'esbuild'), join(home, 'node_modules', 'esbuild'));
      mkdirSync(join(home, 'node_modules', '@tacendum'));
      symlinkSync(shared, join(home, 'node_modules', '@tacendum', 'shared'));

      const git = (...args: string[]): string =>
        execFileSync('git', ['-C', home, ...args], { stdio: ['ignore', 'pipe', 'ignore'] })
          .toString()
          .trim();
      git('init', '-q');
      git('add', '-A');
      git(
        '-c', 'user.email=t@test',
        '-c', 'user.name=t',
        '-c', 'commit.gpgsign=false',
        'commit', '-q', '-m', 'clean baseline',
      );

      const runScratchBuild = (out: string): { bundle: string; commit: string | null } => {
        const env = { ...process.env, TACENDUM_BUILD_OUTDIR: out };
        delete env.npm_lifecycle_event;
        execFileSync(process.execPath, [join(cli, 'build.mjs')], {
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        return {
          bundle: readFileSync(join(out, 'main.js'), 'utf8'),
          commit: (JSON.parse(readFileSync(join(out, 'build-info.json'), 'utf8')) as {
            commit: string | null;
          }).commit,
        };
      };

      // Baseline: the committed tree resolves the workspace package and
      // stamps clean — proves the poisoned run below fails for the poison,
      // not because the scratch rig cannot build at all.
      const clean = runScratchBuild(join(scratch, 'poison-out-clean'));
      expect(clean.bundle).toContain('legit-shared');
      expect(clean.commit).toMatch(/^[0-9a-f]{7,40}$/);

      // The attack: an UNCOMMITTED root-config edit redirects the workspace
      // specifier to a file no commit contains.
      writeFileSync(join(home, 'poisoned.ts'), "export const MARKER = 'POISONED-BY-ROOT-CONFIG';\n");
      writeFileSync(
        join(home, 'tsconfig.base.json'),
        JSON.stringify({
          compilerOptions: { baseUrl: '.', paths: { '@tacendum/shared': ['./poisoned.ts'] } },
        }),
      );
      const poisoned = runScratchBuild(join(scratch, 'poison-out-dirty'));
      // The stamp DOES claim the clean commit — tsconfig.base.json and the
      // planted module are outside the dirty pathspec, and widening that
      // pathspec to the whole repo would mark every unrelated app/ edit
      // dirty (see resolveCommit). The bundle is therefore required to be
      // immune instead: a fixed build configuration reads NO on-disk
      // tsconfig, so the mapping cannot reach resolution.
      expect(poisoned.commit).toMatch(/^[0-9a-f]{7,40}$/);
      expect(
        poisoned.bundle.includes('POISONED-BY-ROOT-CONFIG'),
        'an uncommitted root-config mapping steered the bundle while the stamp claimed a clean commit',
      ).toBe(false);
      expect(poisoned.bundle).toContain('legit-shared');
    },
    120_000,
  );
});

describe('build-stamp resolveCommit: the stamp must never name a stranger\'s commit', () => {
  // The review's executed repro: `git -C <dir>` WALKS UPWARD, so a
  // tarball export dropped inside an unrelated repository got stamped with
  // that repository's HEAD. Each guard in resolveCommit gets the scratch
  // layout that only IT catches, so neither can be dropped without a red
  // test here.
  const scratch = mkdtempSync(join(tmpdir(), 'tacendum-stamp-'));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  const git = (dir: string, ...args: string[]): string =>
    execFileSync('git', ['-C', dir, ...args], { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  // -c flags rather than global config: the runner's own git identity (or
  // commit signing) must not leak into or break a scratch commit.
  const commitAll = (repo: string): void => {
    git(repo, 'add', '-A');
    git(
      repo,
      '-c', 'user.email=t@test',
      '-c', 'user.name=t',
      '-c', 'commit.gpgsign=false',
      'commit', '-q', '--allow-empty', '-m', 'x',
    );
  };

  it('stamps the commit when the surrounding repository is this package\'s own home', () => {
    const home = join(scratch, 'home');
    const pkg = join(home, 'packages', 'cli');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, 'build.mjs'), '// stub\n');
    git(home, 'init', '-q');
    commitAll(home);
    expect(resolveCommit(pkg)).toBe(git(home, 'rev-parse', '--short', 'HEAD'));
  });

  it('an export COMMITTED inside an unrelated repository stamps null (the gate\'s repro)', () => {
    // Tracked, so the ls-files guard passes — only the toplevel identity
    // check stands between this layout and a stranger's commit.
    const foreign = join(scratch, 'foreign');
    const pkg = join(foreign, 'vendor', 'export', 'cli');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, 'build.mjs'), '// stub\n');
    git(foreign, 'init', '-q');
    commitAll(foreign);
    expect(git(foreign, 'rev-parse', '--short', 'HEAD')).toMatch(/^[0-9a-f]{7,40}$/);
    expect(resolveCommit(pkg)).toBeNull();
  });

  it('an UNTRACKED export sitting exactly at <root>/packages/cli of a foreign repo stamps null', () => {
    // Two levels deep, so the toplevel check alone would pass — only the
    // tracked-file guard catches this one.
    const lookalike = join(scratch, 'lookalike');
    mkdirSync(lookalike, { recursive: true });
    git(lookalike, 'init', '-q');
    commitAll(lookalike);
    const pkg = join(lookalike, 'packages', 'cli');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, 'build.mjs'), '// stub\n');
    expect(resolveCommit(pkg)).toBeNull();
  });

  it('no repository anywhere above: null, never a throw', () => {
    const bare = join(scratch, 'bare', 'pkg');
    mkdirSync(bare, { recursive: true });
    expect(resolveCommit(bare)).toBeNull();
  });

  it('uncommitted change inside the artifact inputs stamps <sha>-dirty (external scan', () => {
    const home = join(scratch, 'dirty-home');
    const pkg = join(home, 'packages', 'cli');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, 'build.mjs'), '// stub\n');
    git(home, 'init', '-q');
    commitAll(home);
    // Tracked and modified: the artifact esbuild would bundle is not the
    // commit's — a bare stamp here misattributes uncommitted code.
    writeFileSync(join(pkg, 'build.mjs'), '// stub, edited after the commit\n');
    expect(resolveCommit(pkg)).toBe(`${git(home, 'rev-parse', '--short', 'HEAD')}-dirty`);
  });

  it('dirt OUTSIDE the artifact inputs (app code, infra) leaves the stamp clean', () => {
    // The bundle is built from packages/cli + packages/shared + LICENSE. An
    // uncommitted app/ or infra/ edit changes none of the shipped bytes, so
    // marking it dirty would cry wolf on every monorepo build — and a marker
    // that is always on is one nobody reads.
    const home = join(scratch, 'scoped-home');
    const pkg = join(home, 'packages', 'cli');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, 'build.mjs'), '// stub\n');
    git(home, 'init', '-q');
    commitAll(home);
    writeFileSync(join(home, 'unrelated-app-scratch.txt'), 'x\n');
    expect(resolveCommit(pkg)).toBe(git(home, 'rev-parse', '--short', 'HEAD'));
  });
});

// Two ways the fresh-build remediation could ship or destroy code it never
// validated. Co-located here because both drive the real build.mjs,
// which this file already spawns — its heavy classification (vitest.config.ts)
// covers node:child_process, and a separate fast-project file would not.
describe('resolveOutDir refuses to hand a caller a directory it must not rm -rf (NEW HIGH 10)', () => {
  // build.mjs used to `rm -rf` TACENDUM_BUILD_OUTDIR verbatim before anything
  // validated it, so a stale or mistyped value naming the repo, the package,
  // $HOME or / destroyed it. The override is only ever pointed at a scratch
  // directory under the OS temp root, so that is now the sole shape accepted —
  // validated BEFORE any deletion. Exercised through the validator directly, so
  // proving a dangerous path is refused never risks a real directory.
  it('defaults to the package dist/ when no override is set', () => {
    expect(resolveOutDir(pkgRoot, {})).toBe(join(pkgRoot, 'dist'));
    expect(resolveOutDir(pkgRoot, { TACENDUM_BUILD_OUTDIR: '' })).toBe(join(pkgRoot, 'dist'));
  });

  it('accepts a proper descendant of the temp root (the only legitimate override)', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'tacendum-outdir-ok-'));
    try {
      // Returned as given: existing scratch dir, and a not-yet-created child.
      expect(resolveOutDir(pkgRoot, { TACENDUM_BUILD_OUTDIR: scratch })).toBe(scratch);
      const child = join(scratch, 'sub', 'out');
      expect(resolveOutDir(pkgRoot, { TACENDUM_BUILD_OUTDIR: child })).toBe(child);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('refuses the repository root, the package root, $HOME and the filesystem root by name', () => {
    for (const dangerous of [repoRoot, pkgRoot, homedir(), '/']) {
      expect(
        () => resolveOutDir(pkgRoot, { TACENDUM_BUILD_OUTDIR: dangerous }),
        `must refuse ${dangerous}`,
      ).toThrow(/refusing to rm -rf|temp root/i);
    }
  });

  it('refuses the temp root itself — only a sub-directory of it is a scratch dir', () => {
    expect(() => resolveOutDir(pkgRoot, { TACENDUM_BUILD_OUTDIR: tmpdir() })).toThrow(
      /not the temp root itself/i,
    );
  });

  it('refuses a populated directory that merely exists but is not under the temp root', () => {
    // packages/ is real and outside the temp root — pre-fix this was rm -rf'd.
    expect(() =>
      resolveOutDir(pkgRoot, { TACENDUM_BUILD_OUTDIR: join(repoRoot, 'packages') }),
    ).toThrow(/under the temp\s*root/i);
  });

  it('resolves .. and symlinks before judging, so a temp path escaping via .. is refused', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'tacendum-outdir-escape-'));
    try {
      // Lexically under temp, but climbs out to the repo once normalised.
      const escaping = join(scratch, '..', '..', '..', '..', '..', '..', '..', '..', 'etc');
      expect(() => resolveOutDir(pkgRoot, { TACENDUM_BUILD_OUTDIR: escaping })).toThrow();
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe('the build refuses a dangerous override end-to-end, and deletes nothing (NEW HIGH 10)', () => {
  // A uniquely-named, disposable directory OUTSIDE the temp root — under the
  // package itself, which is never a valid override, so it is refused
  // deterministically regardless of where the sandbox's temp and home roots
  // sit. Even if the guard were broken, only this test's own throwaway dir
  // could be lost; when the guard holds, the sentinel proves nothing was
  // deleted.
  const guarded = mkdtempSync(join(pkgRoot, '.build-guard-scratch-'));
  afterAll(() => rmSync(guarded, { recursive: true, force: true }));

  it(
    'exits non-zero and leaves the populated directory intact',
    () => {
      const sentinel = join(guarded, 'DO-NOT-DELETE.txt');
      writeFileSync(sentinel, 'a mistaken override must not cost this file\n');

      let failed = false;
      try {
        execFileSync(process.execPath, [join(pkgRoot, 'build.mjs')], {
          env: { ...process.env, TACENDUM_BUILD_OUTDIR: guarded },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch {
        failed = true;
      }
      expect(failed, 'build must refuse a non-temp override').toBe(true);
      expect(existsSync(sentinel), 'the refused directory must be untouched').toBe(true);
      expect(readFileSync(sentinel, 'utf8')).toContain('must not cost this file');
    },
    60_000,
  );
});

describe('assertInputsAttested refuses inputs that escape the attested trees (MEDIUM 3)', () => {
  it('passes when every input is inside packages/cli or packages/shared', () => {
    expect(() =>
      assertInputsAttested(
        { 'src/main.ts': {}, '../shared/src/index.ts': {}, '../shared/src/frames.ts': {} },
        pkgRoot,
      ),
    ).not.toThrow();
  });

  it('throws when an input realpaths outside both trees', () => {
    // `../evil.ts` resolves to packages/evil.ts — inside the repo, outside the
    // two attested trees — exactly the shape a repointed workspace symlink to
    // untracked source would produce.
    expect(() => assertInputsAttested({ 'src/main.ts': {}, '../evil.ts': {} }, pkgRoot)).toThrow(
      /escape the attested trees/i,
    );
    expect(() => assertInputsAttested({ '/etc/passwd': {} }, pkgRoot)).toThrow(
      /escape the attested trees/i,
    );
  });
});

describe('the bundle ignores a repointed workspace symlink (MEDIUM 3)', () => {
  // A scratch monorepo with the REAL build scripts over a minimal source pair,
  // so the repo checkout is never mutated. node_modules/@tacendum/shared is
  // repointed at a poison module; the hard alias must resolve the tracked tree
  // regardless, and the bundle must carry the legit shared code.
  const scratch = mkdtempSync(join(tmpdir(), 'tacendum-symlink-'));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  it(
    'builds the tracked packages/shared, never the symlink target',
    () => {
      const home = join(scratch, 'home');
      const cli = join(home, 'packages', 'cli');
      const shared = join(home, 'packages', 'shared');
      const poison = join(home, 'poison');
      mkdirSync(join(cli, 'src'), { recursive: true });
      mkdirSync(join(shared, 'src'), { recursive: true });
      mkdirSync(join(poison, 'src'), { recursive: true });
      copyFileSync(join(pkgRoot, 'build.mjs'), join(cli, 'build.mjs'));
      copyFileSync(join(pkgRoot, 'build-stamp.mjs'), join(cli, 'build-stamp.mjs'));
      copyFileSync(join(pkgRoot, 'build-guards.mjs'), join(cli, 'build-guards.mjs'));
      copyFileSync(join(repoRoot, 'LICENSE'), join(home, 'LICENSE'));
      writeFileSync(join(cli, 'package.json'), JSON.stringify({ name: 'x', type: 'module' }));
      writeFileSync(
        join(cli, 'src', 'main.ts'),
        "import { MARKER } from '@tacendum/shared';\nconsole.log(MARKER);\n",
      );
      // A real `exports` map, so the alias is derived from it exactly as the
      // shipped package's is.
      writeFileSync(
        join(shared, 'package.json'),
        JSON.stringify({ name: '@tacendum/shared', type: 'module', exports: { '.': './src/index.ts' } }),
      );
      writeFileSync(join(shared, 'src', 'index.ts'), "export const MARKER = 'legit-shared';\n");
      // The poison the symlink will point at.
      writeFileSync(
        join(poison, 'package.json'),
        JSON.stringify({ name: '@tacendum/shared', type: 'module', exports: { '.': './src/index.ts' } }),
      );
      writeFileSync(join(poison, 'src', 'index.ts'), "export const MARKER = 'POISONED-BY-SYMLINK';\n");

      mkdirSync(join(home, 'node_modules', '@tacendum'), { recursive: true });
      symlinkSync(join(repoRoot, 'node_modules', 'esbuild'), join(home, 'node_modules', 'esbuild'));
      // THE ATTACK: the ignored workspace symlink points at the poison, not the
      // tracked package.
      symlinkSync(poison, join(home, 'node_modules', '@tacendum', 'shared'));

      const out = join(scratch, 'out');
      execFileSync(process.execPath, [join(cli, 'build.mjs')], {
        env: { ...process.env, TACENDUM_BUILD_OUTDIR: out },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const bundle = readFileSync(join(out, 'main.js'), 'utf8');
      expect(bundle).toContain('legit-shared');
      expect(bundle.includes('POISONED-BY-SYMLINK')).toBe(false);
    },
    120_000,
  );
});

describe('packaging never honors TACENDUM_BUILD_OUTDIR (artifact-integrity bypass, external review', () => {
  // The bypass, reproduced against HEAD before the fix: `TACENDUM_BUILD_OUTDIR=<scratch>
  // npm pack` ran prepack, which built and validated the SCRATCH directory —
  // clean-output recreation, readdir allowlist, input attestation, stamp, all
  // of it — while npm tarred `files: ["dist"]`, shipping a stale bundle and a
  // planted dist/STALE-MARKER.txt under the current commit's name. The
  // invariant now enforced by construction: the bytes npm packs are exactly
  // the bytes this build produced and validated, for this commit.
  const scratch = mkdtempSync(join(tmpdir(), 'tacendum-shipdir-'));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  it('isPackagingRun recognises prepack / pack / publish and nothing else', () => {
    expect(isPackagingRun({ npm_lifecycle_event: 'prepack' })).toBe(true);
    expect(isPackagingRun({ npm_command: 'pack' })).toBe(true);
    expect(isPackagingRun({ npm_command: 'publish' })).toBe(true);
    expect(isPackagingRun({})).toBe(false);
    // The shapes ordinary local and test runs actually carry.
    expect(isPackagingRun({ npm_lifecycle_event: 'build', npm_command: 'run-script' })).toBe(false);
    expect(isPackagingRun({ npm_command: 'exec' })).toBe(false);
  });

  it('resolveOutDir refuses the override on every packaging shape, loudly naming why', () => {
    const out = join(scratch, 'refused-out');
    for (const ctx of [
      { npm_lifecycle_event: 'prepack' },
      { npm_command: 'pack' },
      { npm_command: 'publish' },
    ]) {
      expect(
        () => resolveOutDir(pkgRoot, { TACENDUM_BUILD_OUTDIR: out, ...ctx }),
        `must refuse the override under ${JSON.stringify(ctx)}`,
      ).toThrow(/packaging run/i);
    }
  });

  it('a packaging run WITHOUT the override still lands on dist/, and local scratch builds still work', () => {
    // Requirement pair: packing stays on the shipped directory; the
    // developer ergonomics the override exists for are preserved outside
    // packaging.
    expect(resolveOutDir(pkgRoot, { npm_lifecycle_event: 'prepack' })).toBe(join(pkgRoot, 'dist'));
    const out = join(scratch, 'dev-out');
    expect(
      resolveOutDir(pkgRoot, {
        TACENDUM_BUILD_OUTDIR: out,
        npm_lifecycle_event: 'build',
        npm_command: 'run-script',
      }),
    ).toBe(out);
  });

  describe('assertShipDirIsThisBuild: the directory npm packs must BE this build', () => {
    // A fabricated build-output pair: `home` plays packages/cli (the guard
    // derives the ship dir as home/dist), `out` plays the directory the build
    // wrote and validated. Every failure shape gets its own fresh pair.
    const SHIPPED = ['LICENSE', 'build-info.json', 'main.js'];
    const COMMIT = 'abc1234';
    let n = 0;
    const makePair = (): { home: string; out: string; dist: string } => {
      const home = join(scratch, `pair-${n++}`);
      const out = join(home, 'out');
      const dist = join(home, 'dist');
      for (const dir of [out, dist]) {
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'LICENSE'), 'licence text\n');
        writeFileSync(join(dir, 'build-info.json'), `{"commit":"${COMMIT}","builtAt":null}\n`);
        writeFileSync(join(dir, 'main.js'), '#!/usr/bin/env node\nconsole.log(1);\n');
        chmodSync(join(dir, 'main.js'), 0o755);
      }
      return { home, out, dist };
    };

    it('passes when dist/ is byte-identical, stamped with this build, and executable', () => {
      const { home, out } = makePair();
      expect(() => assertShipDirIsThisBuild(home, out, ['dist'], SHIPPED, COMMIT)).not.toThrow();
    });

    it('refuses a `files` manifest it does not verify — the pin that stops silent drift', () => {
      const { home, out } = makePair();
      for (const files of [undefined, [], ['dist', 'extra'], ['lib']]) {
        expect(
          () => assertShipDirIsThisBuild(home, out, files, SHIPPED, COMMIT),
          `must refuse files=${JSON.stringify(files)}`,
        ).toThrow(/"files"/);
      }
    });

    it('refuses an absent dist/ — a build that leaves nothing to pack must fail the pack', () => {
      const { home, out, dist } = makePair();
      rmSync(dist, { recursive: true, force: true });
      expect(() => assertShipDirIsThisBuild(home, out, ['dist'], SHIPPED, COMMIT)).toThrow(
        /missing or unreadable/i,
      );
    });

    it('refuses a dist/ carrying anything beyond the allowlist (the planted-file shape)', () => {
      const { home, out, dist } = makePair();
      writeFileSync(join(dist, 'STALE-MARKER.txt'), 'parked by an earlier run\n');
      expect(() => assertShipDirIsThisBuild(home, out, ['dist'], SHIPPED, COMMIT)).toThrow(
        /ship allowlist/i,
      );
    });

    it("refuses a stale stamp — dist/ from an earlier commit names both commits in the refusal", () => {
      const { home, out, dist } = makePair();
      writeFileSync(join(dist, 'build-info.json'), '{"commit":"0ldc0de","builtAt":null}\n');
      expect(() => assertShipDirIsThisBuild(home, out, ['dist'], SHIPPED, COMMIT)).toThrow(
        /stale artifact|carries build stamp/i,
      );
    });

    it('refuses byte drift under a matching stamp — a tampered bundle cannot ride a clean stamp', () => {
      const { home, out, dist } = makePair();
      writeFileSync(join(dist, 'main.js'), '#!/usr/bin/env node\nconsole.log("tampered");\n');
      chmodSync(join(dist, 'main.js'), 0o755);
      expect(() => assertShipDirIsThisBuild(home, out, ['dist'], SHIPPED, COMMIT)).toThrow(
        /differs from what this build produced/i,
      );
    });

    it('refuses a dist/main.js that lost its executable bit', () => {
      const { home, out, dist } = makePair();
      chmodSync(join(dist, 'main.js'), 0o644);
      expect(() => assertShipDirIsThisBuild(home, out, ['dist'], SHIPPED, COMMIT)).toThrow(
        /not executable/i,
      );
    });
  });
});

describe('the bypass end to end: prepack with the override refuses; without it, dist/ is rebuilt (external review', () => {
  // The pre-fix reproduction, now required to FAIL: a scratch monorepo with
  // the REAL build scripts, a stale dist/ parked exactly as an attacker (or
  // an earlier build) would leave it, and a prepack run with the override
  // set. Scratch rather than this checkout so the outcome does not depend on
  // whatever state the surrounding tree is in, and dist/ is gitignored in
  // the rig as it is in the real repo — the parked dist must NOT trip the
  // dirty-tree refusal, or this test would pass for the wrong reason.
  const scratch = mkdtempSync(join(tmpdir(), 'tacendum-packbypass-'));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  it(
    'override + prepack exits non-zero naming the override; a plain prepack replaces the stale dist/',
    () => {
      const home = join(scratch, 'home');
      const cli = join(home, 'packages', 'cli');
      const shared = join(home, 'packages', 'shared');
      mkdirSync(join(cli, 'src'), { recursive: true });
      mkdirSync(join(shared, 'src'), { recursive: true });
      copyFileSync(join(pkgRoot, 'build.mjs'), join(cli, 'build.mjs'));
      copyFileSync(join(pkgRoot, 'build-stamp.mjs'), join(cli, 'build-stamp.mjs'));
      copyFileSync(join(pkgRoot, 'build-guards.mjs'), join(cli, 'build-guards.mjs'));
      copyFileSync(join(repoRoot, 'LICENSE'), join(home, 'LICENSE'));
      // `files` present because the ship-dir guard reads it on packaging runs.
      writeFileSync(
        join(cli, 'package.json'),
        JSON.stringify({ name: 'x', type: 'module', files: ['dist'] }),
      );
      writeFileSync(join(cli, '.gitignore'), 'dist/\n');
      writeFileSync(
        join(cli, 'src', 'main.ts'),
        "import { MARKER } from '@tacendum/shared';\nconsole.log(MARKER);\n",
      );
      writeFileSync(
        join(shared, 'package.json'),
        JSON.stringify({ name: '@tacendum/shared', type: 'module', main: './src/index.ts' }),
      );
      writeFileSync(join(shared, 'src', 'index.ts'), "export const MARKER = 'legit-shared';\n");
      mkdirSync(join(home, 'node_modules', '@tacendum'), { recursive: true });
      symlinkSync(join(repoRoot, 'node_modules', 'esbuild'), join(home, 'node_modules', 'esbuild'));
      symlinkSync(shared, join(home, 'node_modules', '@tacendum', 'shared'));

      const git = (...args: string[]): string =>
        execFileSync('git', ['-C', home, ...args], { stdio: ['ignore', 'pipe', 'ignore'] })
          .toString()
          .trim();
      git('init', '-q');
      git('add', '-A');
      git(
        '-c', 'user.email=t@test',
        '-c', 'user.name=t',
        '-c', 'commit.gpgsign=false',
        'commit', '-q', '-m', 'clean baseline',
      );

      // The parked stale dist/ the pre-fix tarball shipped.
      const dist = join(cli, 'dist');
      mkdirSync(dist, { recursive: true });
      writeFileSync(join(dist, 'STALE-MARKER.txt'), 'stale bytes an earlier run parked\n');

      const runPrepack = (extraEnv: Record<string, string>): void => {
        const env = { ...process.env, npm_lifecycle_event: 'prepack' };
        delete env.TACENDUM_BUILD_OUTDIR;
        Object.assign(env, extraEnv);
        execFileSync(process.execPath, [join(cli, 'build.mjs')], {
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      };

      // THE BYPASS SHAPE: prepack with the override. Pre-fix this succeeded,
      // validated the scratch directory, and npm shipped the stale dist/.
      const out = join(scratch, 'override-out');
      let refusal: (Error & { status?: number; stderr?: Buffer }) | null = null;
      try {
        runPrepack({ TACENDUM_BUILD_OUTDIR: out });
      } catch (err) {
        refusal = err as Error & { status?: number; stderr?: Buffer };
      }
      expect(refusal, 'prepack with the override must fail').not.toBeNull();
      expect(refusal?.status).not.toBe(0);
      expect(String(refusal?.stderr)).toMatch(/TACENDUM_BUILD_OUTDIR/);
      expect(String(refusal?.stderr)).toMatch(/packaging run/i);
      // Refused BEFORE building or deleting anything: no scratch output was
      // created, and the parked dist/ was not touched.
      expect(existsSync(out)).toBe(false);
      expect(existsSync(join(dist, 'STALE-MARKER.txt'))).toBe(true);

      // The honest packaging path: no override. The build must land on
      // dist/, replace the stale contents wholesale, and stamp THIS commit —
      // after which the ship-dir guard has verified dist/ is this build.
      runPrepack({});
      expect(readdirSync(dist).sort()).toEqual(['LICENSE', 'build-info.json', 'main.js']);
      const stamp = JSON.parse(readFileSync(join(dist, 'build-info.json'), 'utf8')) as {
        commit: string | null;
      };
      expect(stamp.commit).toBe(git('rev-parse', '--short', 'HEAD'));
      expect(statSync(join(dist, 'main.js')).mode & 0o111).not.toBe(0);
      expect(readFileSync(join(dist, 'main.js'), 'utf8')).toContain('legit-shared');
    },
    120_000,
  );
});
