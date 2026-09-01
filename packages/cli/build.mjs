// Build the installable CLI.
//
// Why a build exists at all: `bin` used to point at `src/main.ts` — raw
// TypeScript that only runs under this workspace's tsx loader, so an
// `npm i -g` produced a `tacendum` that died on its first import. The
// licensing review made the point sharper: AGPL §6 obligations attach to the
// thing users actually RECEIVE, and a CLI that cannot be installed is not
// being received. This script produces the thing that can be.
//
// What gets bundled and what does not, and why the line is where it is:
//
//  - `@tacendum/shared` IS bundled in. It is a workspace package with no
//    registry existence — a published tarball that referenced it would be
//    uninstallable everywhere except this monorepo. esbuild inlines its
//    TypeScript source, so the artifact needs nothing the registry cannot
//    provide. It lives in devDependencies for exactly this reason.
//  - `@signalapp/libsignal-client`, `ws`, `ulid`, `zod` stay EXTERNAL. The
//    first ships a native .node addon that cannot be bundled and must be
//    installed for the host platform; the rest are ordinary registry
//    packages, and leaving them external keeps this bundle reviewable — it
//    contains this repo's code and nothing else.
//
// esbuild itself resolves from the workspace root's node_modules (it is
// already there for tsx and vitest). Deliberately NOT added as a
// devDependency here: the lockfile is shared state that concurrent sessions
// own together, and building is a workspace activity — installed copies ship
// `dist/`, they do not run this script.
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { build } from 'esbuild';
import { resolveBuiltAt, resolveCommit } from './build-stamp.mjs';
import {
  assertInputsAttested,
  assertShipDirIsThisBuild,
  isPackagingRun,
  resolveOutDir,
} from './build-guards.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

// Resolved before anything is built, because the first use is a REFUSAL
//: `npm pack`/`npm publish` run this script as `prepack`,
// and a tarball built from a dirty tree carries code the stamped commit does
// not contain — uncommitted edits shipped under a clean commit's name. A
// LOCAL build of a dirty tree stays allowed (`npm run build`, or the test
// rig's env override): iterating on the CLI must not require committing every
// probe, and the artifact cannot misrepresent itself because the stamp says
// `-dirty`. Accepted residual, stated: a pack where git can prove NOTHING
// (a tarball export, no repository) stamps null and is not refused — null
// claims no provenance, which is honest, unlike a bare commit that lies.
const commit = resolveCommit(root);
if (process.env.npm_lifecycle_event === 'prepack' && commit !== null && commit.endsWith('-dirty')) {
  console.error(
    `tacendum build: refusing to pack a dirty tree (stamp would be ${commit}).\n` +
      'Commit the changes under packages/cli, packages/shared or LICENSE first; ' +
      '`npm run build` still works locally and marks the artifact -dirty.',
  );
  process.exit(1);
}

// Where the artifact lands. The env override exists ONLY so the packaging
// test (test/packaging.test.ts) can run this script against a scratch
// directory instead of rewriting the real dist/ while parallel test workers
// may be reading it. An environment variable rather than a flag, for the same
// reason main.ts moved --canary to one: nothing a user types by accident, and
// it reads as test rigging at a glance. Packing always uses the default —
// ENFORCED, not conventional: npm packs
// `files: ["dist"]` wherever the build writes, so an honored override during
// `npm pack`/`npm publish` validated a scratch directory while npm shipped
// whatever dist/ already held. resolveOutDir refuses the override outright on
// packaging runs, and the ship-dir check at the bottom of this script verifies
// dist/ independently of that refusal.
//
// VALIDATED BEFORE THE rm -rf BELOW: the override used to be
// accepted verbatim and recursively deleted before anything checked it, so a
// stale or mistyped value naming the repo, the package, $HOME or / destroyed
// it. resolveOutDir refuses anything that is not a proper descendant of the OS
// temp root (which every scratch directory the tests use is), throwing here
// rather than emptying the wrong tree.
const outDir = resolveOutDir(root, process.env);

// Fresh and EMPTY every build. The build used to
// write into whatever dist/ already held, and `files: ["dist"]` publishes
// that whole directory — so a stale bundle, an old sourcemap, or a scratch
// file somebody parked there rode every tarball under the current commit's
// stamp. Emptying first makes the directory's contents exactly what THIS
// build wrote, and the readdir check after the LICENSE copy pins that as an
// allowlist a reviewer can read.
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

// HARD-ALIAS the shared specifiers to the tracked packages/shared tree.
// Left to itself esbuild resolves `@tacendum/shared` through the
// ignored workspace symlink node_modules/@tacendum/shared, which can be
// repointed at untracked source — the bundle would change while resolveCommit
// still called the tracked trees clean. Aliasing to `../shared` bypasses
// node_modules entirely, and the map is DERIVED from packages/shared's own
// `exports` (falling back to `main`), so it stays exact and in sync: a new
// subpath export is aliased automatically, and esbuild's alias applies to
// subpaths, so a directory alias would misroute the `exports`-mapped ones.
const sharedDir = join(root, '..', 'shared');
const sharedPkg = JSON.parse(readFileSync(join(sharedDir, 'package.json'), 'utf8'));
const SHARED_SPECIFIER = '@tacendum/shared';
const sharedAlias = {};
if (sharedPkg.exports && typeof sharedPkg.exports === 'object') {
  for (const [sub, target] of Object.entries(sharedPkg.exports)) {
    if (typeof target !== 'string') continue;
    const specifier = sub === '.' ? SHARED_SPECIFIER : `${SHARED_SPECIFIER}/${sub.replace(/^\.\//, '')}`;
    sharedAlias[specifier] = join(sharedDir, target);
  }
} else if (typeof sharedPkg.main === 'string') {
  sharedAlias[SHARED_SPECIFIER] = join(sharedDir, sharedPkg.main);
}

const result = await build({
  entryPoints: [join(root, 'src', 'main.ts')],
  outfile: join(outDir, 'main.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20', // matches the workspace's engines field
  external: Object.keys(pkg.dependencies ?? {}),
  alias: sharedAlias,
  // Pin esbuild's working directory so metafile input keys are relative to the
  // package root regardless of the cwd `npm pack` runs this from — the
  // attestation below resolves them against `root`. Entry, outfile and alias
  // are all absolute, so this changes no output byte (verified byte-identical).
  absWorkingDir: root,
  // The bundled-input manifest the attestation check reads. Not written to
  // disk (not in `files`), inspected in-process only.
  metafile: true,
  banner: { js: '#!/usr/bin/env node' },
  logLevel: 'warning',
  // FIXED build configuration — esbuild must read NO on-disk tsconfig.
  // Left to itself, esbuild auto-loads the nearest
  // tsconfig.json for every file it bundles: this package's and
  // packages/shared's, both of which extend the repo-root tsconfig.base.json
  // — a file OUTSIDE resolveCommit's dirty pathspec. An uncommitted `paths`
  // mapping there redirected `@tacendum/shared` to an arbitrary on-disk file
  // while the stamp still claimed the clean commit (reproduced in
  // packaging.test.ts): bytes no reviewer of that commit ever saw, shipped
  // under its name. Widening the dirty pathspec instead was rejected — the
  // tsconfigs legitimately change for editor/typecheck reasons that alter no
  // shipped byte, and a stamp that cries dirty on those is one nobody reads.
  // So the resolution-relevant options are pinned HERE, in the tracked build
  // script the pathspec already covers. The pinned values reproduce what the
  // on-disk chain provided when this was frozen (verified byte-identical);
  // tsc, not esbuild, remains the type authority, so the rest of
  // tsconfig.base.json still governs `npm run typecheck` exactly as before.
  tsconfigRaw: {
    compilerOptions: {
      target: 'ES2022',
      useDefineForClassFields: true,
      verbatimModuleSyntax: true,
      strict: true,
    },
  },
});

// Every file esbuild reported bundling must realpath INTO the attested trees.
// The alias above is what keeps this true on a normal build;
// this is the enforcement that makes it load-bearing — a shared import that
// ever resolved through the workspace symlink to untracked source stops the
// build here, before any executable bit or stamp is written.
assertInputsAttested(result.metafile.inputs, root);

// The shebang is only half of executability.
chmodSync(join(outDir, 'main.js'), 0o755);

// The commit stamp `--version` reads (see src/version.ts). Written at build
// time because an installed copy has no .git to ask — and asking git at
// RUNTIME from an installed location would report whatever repository the
// binary happens to be sitting in, which is somebody else's history. That
// same walk-upward hazard applies at BUILD time too: a tarball export built
// inside an unrelated repository must stamp null, not that repository's
// commit — resolveCommit (build-stamp.mjs, resolved above the refusal) owns
// the proofs that the repo git finds is actually this one.
//
// `builtAt` is DERIVED (commit date, or SOURCE_DATE_EPOCH), never the wall
// clock: the clock made every build of the same commit checksum-distinct,
// and "same source, same bytes" is the property that lets anyone verify a
// published tarball against the tree it names. The
// derivation and its precedence live on resolveBuiltAt.
writeFileSync(
  join(outDir, 'build-info.json'),
  `${JSON.stringify({ commit, builtAt: resolveBuiltAt(root, commit) })}\n`,
);

// The licence text must travel with the artifact. `files` ships only `dist/`,
// and npm's automatic LICENSE inclusion only looks at the package root, where
// this monorepo keeps no copy — the authoritative text is the repo root's
// LICENSE (AGPL-3.0-only), and a second checked-in copy is a drift risk. So
// the build copies it into dist/, and the tarball carries it from there.
// Deliberately NOT wrapped in try/catch, unlike the git stamp above: a build
// that cannot find the licence text must fail loudly, because packing it
// anyway would produce a tarball that claims AGPL-3.0-only in its manifest
// while conveying none of the licence's text.
copyFileSync(join(root, '..', '..', 'LICENSE'), join(outDir, 'LICENSE'));

// The ship manifest, verified rather than assumed: `files: ["dist"]` conveys
// every byte of this directory, so this build refuses to finish if the
// directory holds anything the three writes above did not put there —
// something racing the emptied directory, or a future edit that starts
// emitting an extra artifact without deciding it SHOULD ship.
const SHIPPED = ['LICENSE', 'build-info.json', 'main.js'];
const present = readdirSync(outDir).sort();
if (present.join('\n') !== SHIPPED.join('\n')) {
  console.error(
    `tacendum build: ${outDir} holds [${present.join(', ')}] but the ship ` +
      `allowlist is [${SHIPPED.join(', ')}] — refusing to leave a publishable ` +
      'directory carrying bytes this build cannot account for.',
  );
  process.exit(1);
}

// Packaging backstop: every check above
// inspected OUTDIR, but npm tars `files: ["dist"]` regardless of where the
// build wrote. When this run is going to produce a tarball, the directory npm
// will actually pack must be provably THIS build's validated output — present,
// exactly the allowlist, stamped with this build's commit, byte-identical to
// outDir. Deliberately independent of resolveOutDir's packaging refusal (which
// makes outDir dist/ on these runs): if that refusal is ever lost, this check
// still fails the prepack instead of letting stale bytes ship.
if (isPackagingRun(process.env)) {
  try {
    assertShipDirIsThisBuild(root, outDir, pkg.files, SHIPPED, commit);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

console.log(`built ${join(outDir, 'main.js')} (commit ${commit ?? 'unknown'})`);
