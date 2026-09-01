// Containment guards for the build, split out of build.mjs so the
// packaging test can exercise them WITHOUT running a build — and, for the
// output-directory guard, without ever pointing a real `rm -rf` at a real
// directory to prove it is refused.
//
//  1. resolveOutDir — the `TACENDUM_BUILD_OUTDIR` override used to be accepted
//     verbatim and `rm -rf`'d before anything validated it.
//     A stale or mistyped override naming the package root, the
//     repository, the home directory or the filesystem root destroyed it. The
//     override exists ONLY so the packaging test can build into a scratch
//     directory (build.mjs's docblock), and every such directory the tests use
//     lives under the OS temp root — so the override is now accepted only as a
//     proper descendant of that root, validated BEFORE the caller deletes
//     anything, with the four dangerous roots rejected by name for a clear
//     refusal.
//
//  2. assertInputsAttested — esbuild's default resolution follows the ignored
//     workspace symlink node_modules/@tacendum/shared, which can be repointed
//     at untracked source; the bundle would change while resolveCommit still
//     reported the tracked trees clean. build.mjs now
//     hard-aliases the shared specifiers to the tracked packages/shared tree,
//     and this guard is the belt to that braces: every file esbuild reported
//     bundling must realpath INTO one of the attested trees, or the build
//     refuses to emit.
//
//  3. isPackagingRun + assertShipDirIsThisBuild — the override in (1) opened
//     an artifact-integrity bypass: `npm pack`
//     and `npm publish` run this build as `prepack` but tar up the `files`
//     directory — dist/ — no matter where the build wrote. With the override
//     set, every integrity check ran against the scratch directory while npm
//     shipped whatever stale or planted bytes dist/ already held, under this
//     commit's name. So packaging runs refuse the override outright, and,
//     independently, the directory npm will actually pack is verified to be
//     byte-for-byte THIS build's validated output before prepack may succeed.
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, parse, resolve, sep } from 'node:path';

/**
 * Canonical absolute path for `p`, which need not exist yet: realpath the
 * longest existing prefix (defeating the /var -> /private/var symlink on macOS
 * and any other symlinked ancestor) and re-append the not-yet-created tail. A
 * pure string `resolve` would compare two spellings of the same directory as
 * different; a bare `realpathSync` would throw on the scratch subdirectories
 * the build has not created yet.
 *
 * @param {string} p
 * @returns {string}
 */
function canonical(p) {
  const abs = resolve(p);
  const tail = [];
  let cur = abs;
  while (!existsSync(cur)) {
    const parent = dirname(cur);
    if (parent === cur) return abs; // reached the filesystem root; nothing to realpath
    tail.unshift(basename(cur));
    cur = parent;
  }
  const base = realpathSync(cur);
  return tail.length ? join(base, ...tail) : base;
}

/** True when `child` is `root` itself or a path strictly beneath it. */
function within(child, root) {
  return child === root || child.startsWith(root + sep);
}

/**
 * Where the build writes. The default (no override) is the package's own
 * `dist/`, trusted and returned unchecked. An override is validated as a safe
 * scratch location BEFORE it is returned, so the caller's `rm -rf` can never
 * land outside the temp root.
 *
 * @param {string} packageRoot absolute path of packages/cli (build.mjs's dir)
 * @param {Record<string, string | undefined>} env process.env
 * @returns {string} the directory to build into (the caller may delete it)
 */
export function resolveOutDir(packageRoot, env) {
  const override = env.TACENDUM_BUILD_OUTDIR;
  if (override === undefined || override === '') return join(packageRoot, 'dist');

  // NEVER honored while npm is packaging: the
  // tarball is built from `files: ["dist"]` no matter where this build
  // writes, so honoring the override here validated one directory while npm
  // shipped another — stale or planted dist/ bytes under this commit's name.
  // Refused LOUDLY rather than silently ignored: whoever set it is told why
  // now, instead of discovering a mismatched tarball later. Checked before
  // the containment validation below — a packaging run deletes nothing.
  if (isPackagingRun(env)) {
    throw new Error(
      'tacendum build: TACENDUM_BUILD_OUTDIR is set during a packaging run ' +
        `(npm_lifecycle_event=${env.npm_lifecycle_event ?? 'unset'}, ` +
        `npm_command=${env.npm_command ?? 'unset'}), but npm packs dist/ ` +
        '(package.json "files"), not the override — a scratch build here would ' +
        'ship whatever dist/ already held. Unset TACENDUM_BUILD_OUTDIR to pack; ' +
        '`npm run build` still honors it for local scratch builds.',
    );
  }

  const target = canonical(override);
  const named = [
    ['the filesystem root', parse(target).root],
    ['your home directory', canonical(homedir())],
    ['the repository root', canonical(join(packageRoot, '..', '..'))],
    ['the package root', canonical(packageRoot)],
  ];
  for (const [label, forbidden] of named) {
    if (target === forbidden) {
      throw new Error(
        `tacendum build: TACENDUM_BUILD_OUTDIR resolves to ${label} (${target}); ` +
          'refusing to rm -rf it. The override is for scratch build directories only.',
      );
    }
  }

  const temp = canonical(tmpdir());
  if (target === temp) {
    throw new Error(
      `tacendum build: TACENDUM_BUILD_OUTDIR must be a sub-directory of the temp root ` +
        `(${temp}), not the temp root itself; refusing to rm -rf it.`,
    );
  }
  if (!within(target, temp)) {
    throw new Error(
      `tacendum build: TACENDUM_BUILD_OUTDIR must be a scratch directory under the temp ` +
        `root (${temp}); got ${target}. Refusing to rm -rf outside the temp root.`,
    );
  }
  // Safe. Return the ORIGINAL spelling: a passing `target` proves `override`
  // denotes the same in-temp directory, and the caller deleting the original
  // path deletes exactly that.
  return override;
}

/**
 * Refuse to emit if esbuild bundled any file whose realpath escapes the
 * attested trees (packages/cli, packages/shared) — the trees resolveCommit
 * attests and the dirty check covers. With the shared specifiers hard-aliased
 * in build.mjs this cannot fire on a normal build; it is the enforcement that
 * makes the alias load-bearing rather than advisory, catching any future
 * import that resolves through the workspace symlink to untracked source.
 *
 * The build is invoked with `absWorkingDir: packageRoot`, so metafile input
 * keys are relative to `packageRoot` — resolved against it here, then
 * realpathed (the keys name real files esbuild just read).
 *
 * @param {Record<string, unknown>} inputs esbuild metafile `inputs`
 * @param {string} packageRoot absolute path of packages/cli
 * @returns {void} throws on the first escape
 */
export function assertInputsAttested(inputs, packageRoot) {
  const trees = [canonical(packageRoot), canonical(join(packageRoot, '..', 'shared'))];
  const escaped = [];
  for (const key of Object.keys(inputs)) {
    const real = canonical(resolve(packageRoot, key));
    if (!trees.some(tree => within(real, tree))) escaped.push(`${key} -> ${real}`);
  }
  if (escaped.length > 0) {
    throw new Error(
      'tacendum build: bundled inputs escape the attested trees ' +
        `(${trees.join(', ')}): ${escaped.join('; ')}. A shared import resolved to ` +
        'untracked source — refusing to emit a bundle the provenance stamp cannot cover.',
    );
  }
}

/**
 * True when this process is part of an npm packaging run — `npm pack` or
 * `npm publish`, which run the build as `prepack` before assembling the
 * tarball. npm names the lifecycle hook in `npm_lifecycle_event` and the
 * top-level command in `npm_command`; either marker alone is enough, so a
 * runner that sets only one of them (pnpm sets the lifecycle name; npm sets
 * both) is still recognised as packaging.
 *
 * @param {Record<string, string | undefined>} env process.env
 * @returns {boolean}
 */
export function isPackagingRun(env) {
  return (
    env.npm_lifecycle_event === 'prepack' ||
    env.npm_command === 'pack' ||
    env.npm_command === 'publish'
  );
}

/**
 * The pack-time backstop to resolveOutDir's packaging refusal, so the
 * invariant — the bytes npm packs are exactly the bytes this build produced
 * and validated — holds even if that refusal is ever lost: after the build,
 * the directory npm will ACTUALLY tar (`files: ["dist"]`) must exist, hold
 * exactly the allowlisted outputs, carry this build's commit stamp, keep the
 * executable bit, and match the build's output byte for byte. On the normal
 * packaging path outDir IS that directory and every comparison is trivially
 * true; the moment they drift apart — a re-honored override, a future build
 * writing elsewhere — prepack fails instead of producing a tarball.
 *
 * @param {string} packageRoot absolute path of packages/cli
 * @param {string} outDir where THIS build wrote and validated
 * @param {unknown} files package.json's `files` — the npm ship manifest
 * @param {string[]} shipped the allowlisted artifact names build.mjs wrote
 * @param {string | null} commit this build's provenance stamp
 * @returns {void} throws with the reason a tarball must not be produced
 */
export function assertShipDirIsThisBuild(packageRoot, outDir, files, shipped, commit) {
  // `files` and the build's output directory have no mechanical single
  // source of truth (`files` is an npm pattern list, not a directory), so
  // they are pinned against each other here instead: any edit to `files`
  // fails every future pack until this guard is updated with it — the two
  // can no longer drift apart silently.
  if (!Array.isArray(files) || files.length !== 1 || files[0] !== 'dist') {
    throw new Error(
      `tacendum build: package.json "files" is ${JSON.stringify(files)} but this guard ` +
        'verifies exactly ["dist"] — update assertShipDirIsThisBuild together with any ' +
        '"files" change, or the tarball ships bytes no build validated.',
    );
  }
  const shipDir = join(packageRoot, files[0]);

  let present;
  try {
    present = readdirSync(shipDir).sort();
  } catch {
    throw new Error(
      `tacendum build: ${shipDir} is missing or unreadable after the build — npm packs ` +
        'exactly that directory (`files: ["dist"]`), so there is nothing valid to ship.',
    );
  }
  const expected = [...shipped].sort();
  if (present.join('\n') !== expected.join('\n')) {
    throw new Error(
      `tacendum build: ${shipDir} holds [${present.join(', ')}] but the ship allowlist ` +
        `is [${expected.join(', ')}] — refusing to pack a directory this build cannot ` +
        'account for.',
    );
  }

  // Stamp before bytes, for the diagnostic: the common failure is a stale
  // earlier build, and "carries <old> but this build is <new>" names it.
  let stamped;
  try {
    stamped = JSON.parse(readFileSync(join(shipDir, 'build-info.json'), 'utf8')).commit ?? null;
  } catch {
    throw new Error(
      `tacendum build: ${join(shipDir, 'build-info.json')} is not a readable stamp — ` +
        'refusing to pack an artifact whose provenance cannot be checked.',
    );
  }
  if (stamped !== commit) {
    throw new Error(
      `tacendum build: ${shipDir} carries build stamp ${stamped ?? 'null'} but this ` +
        `build is ${commit ?? 'null'} — a stale artifact must not ship under this pack.`,
    );
  }

  for (const name of expected) {
    if (!readFileSync(join(outDir, name)).equals(readFileSync(join(shipDir, name)))) {
      throw new Error(
        `tacendum build: ${join(shipDir, name)} differs from what this build produced ` +
          `and validated in ${outDir} — refusing to pack bytes this build cannot vouch for.`,
      );
    }
  }

  if ((statSync(join(shipDir, 'main.js')).mode & 0o111) === 0) {
    throw new Error(
      `tacendum build: ${join(shipDir, 'main.js')} is not executable — the bin entries ` +
        'point at it, so the packed CLI would not run.',
    );
  }
}
