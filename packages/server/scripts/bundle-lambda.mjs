#!/usr/bin/env node
/**
 * bundle-lambda.mjs — the recipient's recipe for the deployed Lambda bundles.
 *
 * WHY THIS FILE EXISTS. The public source tree deliberately excludes `infra/`
 * (design decision: the public repo is a fresh-start tree, and the CDK app
 * stays internal). But the deployed bundling recipe lived ONLY there — inside
 * `infra/lib/tacendum-stack.ts`, as NodejsFunction options — which meant a
 * recipient of the public tree could read every handler and still not be able
 * to produce the executable actually serving the network. AGPL defines
 * Corresponding Source as everything needed to GENERATE the covered
 * executable, "including the scripts to control those activities", and
 * extends the offer to every remote user of the service. That definition
 * puts AuthFn's bundling (the manual libsignal packaging) explicitly in
 * scope. This script IS that control script: it reproduces,
 * option for option, the esbuild invocation the CDK stack performs, for every
 * Lambda the stack deploys from packages/server.
 *
 * THIS IS A BUILD RECIPE, NOT A SECOND DEPLOY SYSTEM. The internal CDK app
 * remains the only deploy path. Nothing here talks to AWS; the output is a
 * directory of bundles a recipient can inspect, diff, or upload by whatever
 * means they choose (memory size, timeout, environment and IAM are deployment
 * configuration, not source — the per-function notes below record the values
 * the internal stack uses so the recipe is complete).
 *
 * MIRRORED OPTIONS (CDK NodejsFunction/bundling option -> esbuild option here;
 * verified against aws-cdk-lib 2.262.0 aws-lambda-nodejs/lib/bundling.js,
 * which shells out to `esbuild --bundle <entry> --target=node22
 * --platform=node --format=esm --outfile=<out>/index.mjs --minify
 * --sourcemap --external:<...> --banner:js=<banner>` with cwd = repo root):
 *
 * entry: packages/server/src/aws/<file> -> entryPoints (same files)
 * handler: 'handler' -> each entry exports `handler`
 * runtime: NODEJS_22_X -> target: 'node22'
 * (NodejsFunction always) -> platform: 'node', bundle: true
 * bundling.format: OutputFormat.ESM -> format: 'esm', outfile index.mjs
 * bundling.minify: true -> minify: true
 * bundling.sourceMap: true (mode DEFAULT) -> sourcemap: true (linked .map)
 * bundling.externalModules: [] -> external: [] (AWS SDK clients
 * are BUNDLED so runtime behavior
 * is pinned by the lockfile, not
 * the Lambda-provided SDK)
 * AuthFn only: ['@signalapp/libsignal-client'] -> external: same (native
 * node binary must not inline)
 * bundling.banner: createRequire shim -> banner.js: identical string
 * projectRoot / depsLockFilePath: repo -> absWorkingDir: repo root (also
 * preserves tsconfig discovery:
 * esbuild finds
 * packages/server/tsconfig.json
 * from the entry path, exactly as
 * the CDK invocation does — no
 * --tsconfig flag either side)
 * (not set by the stack) -> no define/keepNames/mainFields/
 * loader/inject/footer/charset,
 * matching the stack's omissions
 * architecture: ARM_64 -> no esbuild effect (JS is arch-
 * independent); it selects WHICH
 * libsignal prebuild is vendored:
 * prebuilds/linux-arm64 only
 * AuthFn commandHooks.afterBundling -> vendorLibsignal: copies
 * (infra/lib/tacendum-stack.ts AuthFn) node_modules/@signalapp/
 * libsignal-client/{package.json,
 * dist,prebuilds/linux-arm64} and
 * node_modules/node-gyp-build
 * into the bundle, because esbuild
 * cannot inline a package that
 * loads a .node binary and
 * node-gyp-build is its resolver
 *
 * metafile: true is passed HERE and not by the stack — it changes nothing
 * in the emitted index.mjs (the metafile is returned in memory, not
 * written); --verify uses it to prove no forbidden module stayed external
 * and that `handler` is exported.
 *
 * ESBUILD VERSION. The internal workspace pins esbuild 0.28.1 (the version
 * CDK's local bundling resolves); this package pins the same in its
 * devDependencies. Byte-identical output requires the same esbuild version;
 * a different 0.x still produces a correct, buildable bundle. The version
 * actually used is recorded per function in <out>/manifest.json on every run.
 *
 * USAGE (from packages/server):
 * npm run bundle build every deployed bundle into
 * dist/lambda/. Both modes first check the
 * LAMBDAS list against src/aws/*.lambda.ts
 * on disk — a mismatch in either direction
 * is a hard failure, so the list above can
 * never silently fall behind the stack.
 * npm run bundle -- --verify build + assert non-empty, handler
 * exported, externals limited to node
 * builtins (+ libsignal for AuthFn),
 * libsignal vendored for AuthFn. Byte-
 * identity: if any locally synthesized
 * infra/cdk.out assets exist (not in this
 * repository), every bundle built this run MUST
 * match one byte-for-byte — a miss FAILS
 * the verify (recipe drift, or stale
 * assets: re-synth and re-run). With no
 * local cdk.out at all (the public tree has
 * no infra/), that leg is reported as not
 * checkable here — never as passed.
 * npm run bundle -- --only AuthFn build/verify a single function. The
 * manifest keeps describing every bundle
 * still present in dist/lambda: entries for
 * functions not rebuilt this run are
 * carried over, each entry recording the
 * esbuild version and time of its own
 * build.
 */

import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { builtinModules, createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(serverRoot, '..', '..');
const entryDir = join(serverRoot, 'src', 'aws');
const outRoot = join(serverRoot, 'dist', 'lambda');

/** The esbuild version the internal deploy path (CDK local bundling) uses. */
const PINNED_ESBUILD = '0.28.1';

/**
 * Identical to the stack's `bundling.banner`: bundled CJS dependencies may
 * call require() at runtime, and ESM output needs one in scope.
 */
const BANNER =
  "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);";

/**
 * Every Lambda the stack deploys from packages/server — one entry per
 * NodejsFunction in infra/lib/tacendum-stack.ts, same construct ids. The
 * `deploy` notes record runtime configuration (not part of the bundle) so the
 * recipe is complete without the internal stack.
 */
const LAMBDAS = [
  { id: 'HttpFn', entry: 'http.lambda.ts', deploy: 'REST API host; 256 MB, 10 s' },
  { id: 'WsFn', entry: 'ws.lambda.ts', deploy: 'WebSocket adapter; 256 MB, 10 s' },
  { id: 'WsAuthorizerFn', entry: 'ws-authorizer.lambda.ts', deploy: '$connect authorizer; 256 MB, 5 s' },
  { id: 'WsDrainFn', entry: 'ws-drain.lambda.ts', deploy: 'post-connect queue drain; 256 MB, 30 s' },
  { id: 'PushFn', entry: 'push.lambda.ts', deploy: 'VoIP push worker; 256 MB, 20 s' },
  { id: 'ReconcileFn', entry: 'reconcile.lambda.ts', deploy: 'quota-ledger reconcile; 256 MB, 10 s' },
  { id: 'UsageMetricsFn', entry: 'usage-metrics.lambda.ts', deploy: 'hourly metrics; 256 MB, 30 s' },
  {
    id: 'AuthFn',
    entry: 'auth.lambda.ts',
    deploy: 'account auth, the AGPL §13-critical function; 512 MB, 10 s',
    external: ['@signalapp/libsignal-client'],
    vendorLibsignal: true,
  },
];

/**
 * Completeness guard: the LAMBDAS list above is hand-maintained, so every run
 * (bundle and verify alike) checks it against reality before building. The
 * naming convention is exact, verified against the stack: every
 * `src/aws/*.lambda.ts` is a NodejsFunction entry in
 * infra/lib/tacendum-stack.ts, and the non-entry helpers in src/aws (deps.ts,
 * gateway.ts, call-metrics.ts) carry no `.lambda.ts` suffix. If a future
 * `*.lambda.ts` is deliberately NOT deployed, add it to an explicit,
 * commented exclusion list here — never let the two sets drift in silence,
 * because a missing entry means the recipe no longer covers a function
 * serving the network.
 */
{
  const discovered = readdirSync(entryDir)
    .filter((f) => f.endsWith('.lambda.ts'))
    .sort();
  const listed = LAMBDAS.map((l) => l.entry).sort();
  const notListed = discovered.filter((f) => !listed.includes(f));
  const notOnDisk = listed.filter((f) => !discovered.includes(f));
  if (notListed.length > 0 || notOnDisk.length > 0) {
    console.error('COMPLETENESS GUARD FAILED: LAMBDAS does not match src/aws/*.lambda.ts.');
    for (const f of notListed) console.error(`  on disk but not in LAMBDAS: src/aws/${f}`);
    for (const f of notOnDisk) console.error(`  in LAMBDAS but not on disk: src/aws/${f}`);
    process.exit(1);
  }
}

const args = process.argv.slice(2);
const verify = args.includes('--verify');
const onlyIx = args.indexOf('--only');
const only = onlyIx >= 0 ? args[onlyIx + 1] : undefined;
if (only && !LAMBDAS.some((l) => l.id === only)) {
  console.error(`Unknown function id '${only}'. Known: ${LAMBDAS.map((l) => l.id).join(', ')}`);
  process.exit(2);
}
const selected = LAMBDAS.filter((l) => !only || l.id === only);

let esbuild;
try {
  esbuild = require('esbuild');
} catch {
  console.error(
    'esbuild is not installed. Run `pnpm install` at the repository root — ' +
      `packages/server pins esbuild ${PINNED_ESBUILD} in devDependencies for exactly this script.`,
  );
  process.exit(2);
}

/** Node builtins, with and without the `node:` prefix — always external on platform=node. */
const BUILTINS = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);

const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

/**
 * Mirror of the stack's AuthFn afterBundling hooks. Package locations are
 * resolved through Node rather than assuming a hoisted layout, then copied
 * with symlinks dereferenced so a pnpm store link becomes real files.
 */
function vendorLibsignal(fnOutDir) {
  const libsignalPkg = dirname(
    require.resolve('@signalapp/libsignal-client/package.json', { paths: [serverRoot] }),
  );
  const gypBuildPkg = dirname(
    require.resolve('node-gyp-build/package.json', { paths: [serverRoot, libsignalPkg] }),
  );
  const dest = join(fnOutDir, 'node_modules', '@signalapp', 'libsignal-client');
  mkdirSync(join(dest, 'prebuilds'), { recursive: true });
  cpSync(join(libsignalPkg, 'package.json'), join(dest, 'package.json'), { dereference: true });
  cpSync(join(libsignalPkg, 'dist'), join(dest, 'dist'), { recursive: true, dereference: true });
  // Only linux-arm64: the Lambda is arm64 Linux. If the architecture in the
  // stack ever changes, this must change with it (same warning as the stack).
  cpSync(join(libsignalPkg, 'prebuilds', 'linux-arm64'), join(dest, 'prebuilds', 'linux-arm64'), {
    recursive: true,
    dereference: true,
  });
  cpSync(gypBuildPkg, join(fnOutDir, 'node_modules', 'node-gyp-build'), {
    recursive: true,
    dereference: true,
  });
}

/** CDK-synthesized bundles, if a local cdk.out exists (not part of this repository). */
function cdkArtifacts() {
  const found = new Map(); // sha256 of index.mjs -> asset dir name
  for (const dir of ['cdk.out', ...readdirSync(join(repoRoot, 'infra'), { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith('cdk.out.'))
    .map((d) => d.name)]) {
    const base = join(repoRoot, 'infra', dir);
    if (!existsSync(base)) continue;
    for (const asset of readdirSync(base)) {
      const candidate = join(base, asset, 'index.mjs');
      if (asset.startsWith('asset.') && existsSync(candidate)) {
        found.set(sha256(candidate), join(dir, asset));
      }
    }
  }
  return found;
}

const failures = [];
/** Bundles built by THIS run — the only ones byte-identity may judge. */
const built = [];
const manifestPath = join(outRoot, 'manifest.json');
const manifest = {
  generatedBy: 'packages/server/scripts/bundle-lambda.mjs',
  pinnedEsbuildVersion: PINNED_ESBUILD,
  target: 'node22',
  functions: {},
};

/**
 * --only rebuilds one function, but the manifest describes every bundle
 * present in dist/lambda — so on --only runs the existing manifest's entries
 * for the OTHER functions are carried over verbatim (each entry records the
 * esbuild version and timestamp of its own build, which is why there is no
 * top-level esbuildVersion: after a merge a single value could lie about
 * half the bundles). An entry whose bundle no longer exists on disk is
 * dropped rather than described falsely.
 */
if (only && existsSync(manifestPath)) {
  try {
    const previous = JSON.parse(readFileSync(manifestPath, 'utf8'));
    for (const [id, info] of Object.entries(previous.functions ?? {})) {
      if (id === only) continue;
      if (!existsSync(join(outRoot, id, 'index.mjs'))) {
        console.warn(`manifest: dropping ${id} — dist/lambda/${id}/index.mjs no longer exists`);
        continue;
      }
      manifest.functions[id] = info;
    }
  } catch {
    console.warn('manifest: existing manifest.json is unreadable; this run\'s manifest describes only what it built');
  }
}

if (esbuild.version !== PINNED_ESBUILD) {
  console.warn(
    `WARNING: esbuild ${esbuild.version} != pinned ${PINNED_ESBUILD} (the version the internal ` +
      'deploy path uses). The bundle is still valid source output, but byte-for-byte comparison ' +
      'against a deployed artifact requires the pinned version.',
  );
}

for (const fn of selected) {
  const entry = join(entryDir, fn.entry);
  if (!existsSync(entry)) {
    failures.push(`${fn.id}: entry ${entry} does not exist`);
    continue;
  }
  const fnOutDir = join(outRoot, fn.id);
  rmSync(fnOutDir, { recursive: true, force: true });
  mkdirSync(fnOutDir, { recursive: true });
  const outfile = join(fnOutDir, 'index.mjs');

  const result = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    outfile,
    minify: true,
    sourcemap: true,
    external: fn.external ?? [],
    banner: { js: BANNER },
    absWorkingDir: repoRoot,
    metafile: true,
    logLevel: 'warning',
  });

  if (fn.vendorLibsignal) vendorLibsignal(fnOutDir);

  const bytes = statSync(outfile).size;
  const outKey = Object.keys(result.metafile.outputs).find((k) => k.endsWith('index.mjs'));
  const output = result.metafile.outputs[outKey];
  const outHash = sha256(outfile);
  built.push({ id: fn.id, sha256: outHash });
  manifest.functions[fn.id] = {
    entry: `packages/server/src/aws/${fn.entry}`,
    external: fn.external ?? [],
    deploy: fn.deploy,
    bytes,
    sha256: outHash,
    esbuildVersion: esbuild.version,
    builtAt: new Date().toISOString(),
  };
  console.log(`${fn.id}: ${outfile} (${bytes} bytes)`);

  if (!verify) continue;

  // 1. Non-empty output and its linked source map.
  if (bytes === 0) failures.push(`${fn.id}: empty bundle`);
  if (!existsSync(`${outfile}.map`)) failures.push(`${fn.id}: missing index.mjs.map`);

  // 2. The Lambda handler contract: the module must export `handler`.
  if (!output.exports.includes('handler')) {
    failures.push(`${fn.id}: bundle does not export 'handler' (exports: ${output.exports.join(', ')})`);
  }

  // 3. No forbidden externals: everything the bundle imports at runtime must
  //    be a node builtin or a module this recipe deliberately vendors. An
  //    unexpected external would mean the deployed function depends on
  //    something the recipient's rebuild cannot resolve.
  const allowed = new Set(fn.external ?? []);
  for (const imp of output.imports.filter((i) => i.external)) {
    if (!BUILTINS.has(imp.path) && !allowed.has(imp.path)) {
      failures.push(`${fn.id}: forbidden external '${imp.path}'`);
    }
  }

  // 4. AuthFn: the vendored native module tree the afterBundling hooks produce.
  if (fn.vendorLibsignal) {
    const lib = join(fnOutDir, 'node_modules', '@signalapp', 'libsignal-client');
    const prebuild = join(lib, 'prebuilds', 'linux-arm64');
    if (!existsSync(join(lib, 'package.json'))) failures.push(`${fn.id}: libsignal package.json not vendored`);
    if (!existsSync(join(lib, 'dist'))) failures.push(`${fn.id}: libsignal dist/ not vendored`);
    const hasNode = existsSync(prebuild) && readdirSync(prebuild).some((f) => f.endsWith('.node'));
    if (!hasNode) failures.push(`${fn.id}: no linux-arm64 .node prebuild vendored`);
    if (!existsSync(join(fnOutDir, 'node_modules', 'node-gyp-build'))) {
      failures.push(`${fn.id}: node-gyp-build not vendored`);
    }
  }
}

let byteIdentityChecked = false;
if (verify) {
  // 5. Byte-identity against locally synthesized CDK assets. When any local
  //    infra/cdk.out assets exist (not part of this repository), every bundle built
  //    THIS run must match one byte-for-byte, and a miss is a FAILURE: it
  //    means either the recipe drifted from the stack or the synthesized
  //    assets are stale — both are red until a fresh `cdk synth` and a re-run
  //    agree. With no local cdk.out at all (the public tree has no infra/),
  //    byte-identity simply cannot be checked here, and it is reported as
  //    exactly that — an unchecked leg is never announced as passed.
  const assets = existsSync(join(repoRoot, 'infra')) ? cdkArtifacts() : new Map();
  if (assets.size > 0) {
    byteIdentityChecked = true;
    for (const { id, sha256: hash } of built) {
      const match = assets.get(hash);
      if (match) {
        console.log(`${id}: byte-identical to infra/${match}`);
      } else {
        failures.push(
          `${id}: matches NO synthesized CDK asset byte-for-byte — recipe drift, stale infra/cdk.out ` +
            `(re-synth and re-run)${esbuild.version === PINNED_ESBUILD ? '' : `, or esbuild ${esbuild.version} != pinned ${PINNED_ESBUILD}`}`,
        );
      }
    }
  } else {
    console.log(
      'Byte-identity not checkable here: no local infra/cdk.out assets to compare against ' +
        '(expected in the public tree and in CI; run this where cdk.out exists to verify).',
    );
  }
}

// Stable manifest order regardless of what this run rebuilt.
manifest.functions = Object.fromEntries(
  LAMBDAS.filter((l) => l.id in manifest.functions).map((l) => [l.id, manifest.functions[l.id]]),
);
mkdirSync(outRoot, { recursive: true });
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Manifest: ${manifestPath} (esbuild ${esbuild.version})`);

if (failures.length > 0) {
  console.error(`\nVERIFY FAILED:\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
if (verify) {
  console.log(
    byteIdentityChecked
      ? 'Verify passed, including byte-identity against synthesized CDK assets.'
      : 'Verify passed; byte-identity was NOT checkable here (see above).',
  );
}
