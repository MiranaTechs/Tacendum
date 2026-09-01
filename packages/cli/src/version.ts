import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * What `tacendum --version` says, and why it says more than a number
 *.
 *
 * This CLI links libsignal, which is AGPL-3.0-only, and AGPL §6 attaches its
 * obligations to the thing users actually RECEIVE: whoever gets the executable
 * must be pointed at the source. A LICENSE file in a repository does not
 * travel with `npm i -g`; `--version` is the one surface every installed copy
 * has, so the source URL rides on it. One line, and it discharges the CLI half
 * of that obligation.
 */
export const SOURCE_URL = 'https://github.com/MiranaTechs/Tacendum';
export const LICENSE = 'AGPL-3.0-only';

export interface VersionInfo {
  version: string;
  /**
   * Short commit hash — suffixed `-dirty` when the build stamp says the tree
   * had uncommitted changes — or null when
   * neither a build stamp nor git can say.
   */
  commit: string | null;
}

/** A short-or-full git hash; anything else is treated as "no commit known". */
const COMMIT_RE = /^[0-9a-f]{7,40}$/;

/**
 * What the BUILD STAMP may say: a hash, or a hash build.mjs marked `-dirty`
 * because the tree it bundled had uncommitted changes. The marker must
 * SURFACE in `--version`, not be filtered back into null here — null reads as
 * "provenance unknown", which is a softer claim than "provenance known to be
 * a modified <hash>", and softening it is exactly the misrepresentation the
 * marker exists to prevent. Live git output (the fallback below) never
 * carries the suffix, so COMMIT_RE stays strict there.
 */
const STAMP_RE = /^[0-9a-f]{7,40}(-dirty)?$/;

/**
 * Version from this package's own manifest; commit from whichever of two
 * sources exists.
 *
 * The relative paths hold in BOTH lives this module leads: running from
 * `src/` under tsx, `../package.json` is the package manifest and there is no
 * build stamp, so the commit comes from `git` (we are, by definition, in the
 * working tree). Running from the bundled `dist/main.js`, `../package.json`
 * is the same file and `build-info.json` sits beside the bundle, written by
 * `build.mjs` — because an installed copy has no `.git` to ask, and shelling
 * out to git on some unrelated directory's history would happily report a
 * STRANGER'S commit as ours.
 *
 * `stampUrl` exists ONLY so version.test.ts can hand a scratch stamp and pin
 * what this parser accepts; every production caller takes the default beside the module.
 */
export function versionInfo(
  stampUrl: URL = new URL('./build-info.json', import.meta.url),
): VersionInfo {
  const moduleDir = dirname(fileURLToPath(import.meta.url));

  let version = 'unknown';
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version?: string;
    };
    if (typeof pkg.version === 'string' && pkg.version) version = pkg.version;
  } catch {
    // A CLI that cannot find its own manifest should still answer --version.
  }

  let commit: string | null = null;
  try {
    const stamp = JSON.parse(readFileSync(stampUrl, 'utf8')) as { commit?: unknown };
    if (typeof stamp.commit === 'string' && STAMP_RE.test(stamp.commit)) commit = stamp.commit;
  } catch {
    // No build stamp — running from source. Ask git, anchored to THIS module's
    // directory (never the caller's cwd, which could be any repository).
    try {
      const raw = execFileSync('git', ['-C', moduleDir, 'rev-parse', '--short', 'HEAD'], {
        stdio: ['ignore', 'pipe', 'ignore'],
      })
        .toString()
        .trim();
      if (COMMIT_RE.test(raw)) commit = raw;
    } catch {
      // No git either. `commit: null` is the honest answer.
    }
  }

  return { version, commit };
}
