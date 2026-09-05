import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LICENSE, SOURCE_URL, versionInfo } from '../src/version.js';

/**
 * The values are the contract: AGPL §6 wants source
 * directions where the executable is received, and `--version` is that
 * surface — so the URL and the license id are pinned EXACTLY, not merely
 * present. A typo'd URL discharges nothing.
 */
describe('--version', () => {
  it('pins the AGPL source URL and license id exactly', () => {
    expect(SOURCE_URL).toBe('https://github.com/MiranaTechs/Tacendum');
    expect(LICENSE).toBe('AGPL-3.0-only');
  });

  it('reports the version from this package\'s own manifest', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version: string;
      license: string;
    };
    expect(versionInfo().version).toBe(pkg.version);
    // The manifest and the printed license must not drift apart.
    expect(pkg.license).toBe(LICENSE);
  });

  it('finds a commit when running from a working tree', () => {
    // These tests run from src/ inside the repository, so git can answer;
    // an installed copy answers from the build stamp instead (build.mjs).
    const { commit } = versionInfo();
    expect(commit).toMatch(/^[0-9a-f]{7,40}$/);
  });

  describe('the build stamp parser (external scan)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tacendum-verstamp-'));
    afterAll(() => rmSync(dir, { recursive: true, force: true }));
    const stampAt = (commit: unknown): URL => {
      const p = join(dir, 'build-info.json');
      writeFileSync(p, JSON.stringify({ commit, builtAt: null }));
      return pathToFileURL(p);
    };

    it('surfaces a -dirty stamp instead of filtering it back to null', () => {
      // build.mjs marks a dirty-tree build `<sha>-dirty` precisely so the
      // artifact cannot claim a clean commit. Dropping the marker here would
      // report "provenance unknown" — a SOFTER claim than "a modified
      // abc1234", and softening it is the misrepresentation the marker
      // exists to prevent.
      expect(versionInfo(stampAt('abc1234-dirty')).commit).toBe('abc1234-dirty');
    });

    it('still accepts a clean stamp and still rejects garbage', () => {
      expect(versionInfo(stampAt('abc1234')).commit).toBe('abc1234');
      // A readable-but-invalid stamp is "no commit known", not a git
      // fallback: the fallback is for a MISSING stamp (running from src/).
      expect(versionInfo(stampAt('not-a-hash')).commit).toBeNull();
      expect(versionInfo(stampAt('abc1234-dirty-extra')).commit).toBeNull();
    });
  });
});
