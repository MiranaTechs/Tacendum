// The commit stamp's resolver, split out of build.mjs so the packaging test
// can point it at scratch repositories without running a whole build.
//
// Why the guards exist: `git -C <dir>` does not
// stop at <dir> — it WALKS UPWARD until it finds a .git. So a tarball export
// that happened to sit anywhere inside somebody else's repository resolved
// THAT repository's HEAD, and build-info.json named a stranger's commit as
// this build's provenance. A provenance stamp that can silently claim someone
// else's history is worse than no stamp, so a commit is now stamped only when
// two proofs both hold, each catching a case the other misses:
//
//  1. the repository git found is rooted exactly where this monorepo's root
//     would be, packageRoot/../.. — defeats an export committed at any other
//     depth of a foreign repository;
//  2. build.mjs itself is TRACKED by that repository (`ls-files
//     --error-unmatch`) — defeats an export that merely SITS at
//     <root>/packages/cli of a foreign repository without being part of it.
//
// Accepted residual, named so nobody rediscovers it: a foreign repository
// that deliberately COMMITS this package at its own packages/cli passes both
// checks and stamps its own commit — but that commit's tree genuinely
// contains these sources, which is exactly what a provenance stamp claims.
//
// Everything failing — no git binary, no repository, a mismatch — answers
// null, the honest stamp for "not built from a checkout of this repo".
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';

function git(dir, args) {
  return execFileSync('git', ['-C', dir, ...args], {
    stdio: ['ignore', 'pipe', 'ignore'],
  })
    .toString()
    .trim();
}

/**
 * The short commit to stamp into build-info.json — suffixed `-dirty` when the
 * artifact's inputs carry uncommitted changes — or null when the build is not
 * provably running from a checkout of this package's own repository.
 *
 * The `-dirty` half is the external scan (2026-08-10): a bare stamp from
 * a dirty tree attributes whatever was sitting uncommitted in the working
 * copy to a commit that does not contain it, so a tarball can silently carry
 * code no reviewer of that commit ever saw. Scope matters in a monorepo,
 * though: the bundle is built from packages/cli (bundling packages/shared)
 * plus the repo LICENSE it copies in, so only dirt under THOSE paths marks
 * the stamp — an uncommitted app/ or infra/ edit changes none of the shipped
 * bytes, and a marker that fires on every unrelated edit is one nobody
 * reads. The residual this scope used to accept — repo-root config
 * (tsconfig.base.json, reached through both packages' `extends`) steering
 * esbuild's output while dirt there ships unmarked — is CLOSED from the
 * other side: build.mjs pins `tsconfigRaw`, so
 * esbuild reads no on-disk tsconfig at all and the root config is no longer
 * a build input. The pathspec below therefore still names every effective
 * input; packaging.test.ts proves an uncommitted root-config `paths`
 * mapping can no longer reach the bundle.
 *
 * @param {string} packageRoot absolute path of packages/cli (build.mjs's dir)
 * @returns {string | null}
 */
export function resolveCommit(packageRoot) {
  try {
    // realpath BOTH sides: on macOS the temp tree is reached via a symlink
    // (/var -> /private/var), and git reports the physical path while the
    // caller may hold the symlinked one — a string compare of the two
    // spellings of the same directory must not read as "different repo".
    const toplevel = realpathSync(git(packageRoot, ['rev-parse', '--show-toplevel']));
    if (toplevel !== realpathSync(join(packageRoot, '..', '..'))) return null;
    git(packageRoot, ['ls-files', '--error-unmatch', 'build.mjs']);
    const raw = git(packageRoot, ['rev-parse', '--short', 'HEAD']);
    if (!/^[0-9a-f]{7,40}$/.test(raw)) return null;
    // Pathspecs relative to the toplevel (`-C toplevel`), never absolute: the
    // realpath quirk above applies to pathspec comparison inside git too.
    // `status` is lenient about pathspecs that match nothing, so a scratch
    // layout without packages/shared or LICENSE answers cleanly.
    const dirt = git(toplevel, [
      'status',
      '--porcelain',
      '--',
      'packages/cli',
      'packages/shared',
      'LICENSE',
    ]);
    return dirt === '' ? raw : `${raw}-dirty`;
  } catch {
    return null;
  }
}

/**
 * What build-info.json's `builtAt` says, chosen so that identical source
 * yields identical bytes: the wall clock made every build
 * of the same commit checksum-distinct, which is exactly what a reproducible
 * artifact must not be. In precedence order:
 *
 *  1. SOURCE_DATE_EPOCH — the reproducible-builds.org contract; a build
 *     environment that sets it owns the timestamp outright.
 *  2. The COMMIT's committer date (`%cI`) — a fact of the source, so a
 *     rebuild next year still lands on the same bytes. Used for `-dirty`
 *     builds too: the marker on the commit stamp already says the tree
 *     drifted, and a wall clock here would un-reproduce dev builds.
 *  3. null — no provable commit, no honest time to claim.
 *
 * @param {string} packageRoot absolute path of packages/cli
 * @param {string | null} commit resolveCommit's answer for the same root
 * @returns {string | null}
 */
export function resolveBuiltAt(packageRoot, commit) {
  const clamp = process.env.SOURCE_DATE_EPOCH;
  if (clamp !== undefined && /^\d+$/.test(clamp)) {
    return new Date(Number(clamp) * 1000).toISOString();
  }
  if (commit === null) return null;
  try {
    return git(packageRoot, ['show', '-s', '--format=%cI', 'HEAD']);
  } catch {
    return null;
  }
}
