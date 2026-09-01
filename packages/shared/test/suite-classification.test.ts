/**
 * The vitest fast/heavy split holds only while its classification is true —
 * this file is what keeps it true (vitest.config.ts).
 *
 * THE ROT THIS PREVENTS, both directions:
 *
 *  - A NEW test that spawns real children lands in the fast project by
 *    default and inherits a 15s cap sized for pure CPU work. It passes alone,
 *    passes on a quiet machine, and starts flaking the week the suite grows.
 *    Nothing about adding such a test touches vitest.config.ts,
 *    so nothing prompts anyone to look there.
 *
 *  - A RENAMED heavy file rots the other way: the allowlist entry matches
 *    nothing, vitest collects the renamed file into fast via the general
 *    include, and no error is produced anywhere — an allowlist that silently
 *    stopped matching is indistinguishable from one that was never needed.
 *
 * WHAT IS DELIBERATELY NOT ASSERTED. DynamoDB usage (group 1) and CDK synth
 * (group 2) have no single greppable signature worth pinning — the server
 * files reach the real db through layers this test would have to understand,
 * and infra/ is claimed wholesale by a directory glob that cannot rot per
 * file. The child_process import IS a reliable signature for group 3, the
 * group that actually produced the misclassification.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..', '..');
const CONFIG = readFileSync(join(ROOT, 'vitest.config.ts'), 'utf8');

/** The explicit file entries of the heavy list (globs handled separately). */
const heavyFileEntries = [...CONFIG.matchAll(/'((?:packages|infra)\/[^']+\.test\.ts)'/g)]
  .map((m) => m[1]!)
  .filter((p) => !p.includes('*'));

/** Everything the fast project can collect from the two CLI/server test dirs. */
function testFilesUnder(dir: string): string[] {
  return readdirSync(join(ROOT, dir))
    .filter((f) => f.endsWith('.test.ts') && !f.startsWith('harness.'))
    .map((f) => `${dir}/${f}`);
}

describe('vitest suite classification (the heavy allowlist)', () => {
  it('every explicit heavy entry names a file that exists', () => {
    // The rename-rot check. An entry matching nothing is not an error to
    // vitest — the file just quietly runs in the wrong project.
    for (const entry of heavyFileEntries) {
      expect(existsSync(join(ROOT, entry)), `${entry} listed in vitest.config.ts heavy but does not exist`).toBe(
        true,
      );
    }
    // And the list is non-empty, or the regex above rotted instead.
    expect(heavyFileEntries.length).toBeGreaterThan(10);
  });

  it('no fast-project file imports node:child_process', () => {
    // Group 3's signature. A file that imports it and does not spawn is
    // possible in principle; none exists today, and if one appears the right
    // move is almost always the heavy list anyway — a mocked child_process
    // belongs to the harness style, not the fast suite.
    const infraGlobbed = (f: string) => f.startsWith('infra/'); // heavy wholesale
    const integrationGlobbed = (f: string) => /\.integration\.test\.ts$/.test(f);

    const fastFiles = [
      ...testFilesUnder('packages/cli/test'),
      ...testFilesUnder('packages/server/test'),
      ...testFilesUnder('packages/shared/test'),
    ].filter(
      (f) => !heavyFileEntries.includes(f) && !infraGlobbed(f) && !integrationGlobbed(f),
    );
    expect(fastFiles.length).toBeGreaterThan(20);

    const offenders = fastFiles.filter((f) =>
      /from ['"]node:child_process['"]|require\(['"]node:child_process['"]\)/.test(
        readFileSync(join(ROOT, f), 'utf8'),
      ),
    );
    expect(
      offenders,
      `these files import node:child_process but are not in vitest.config.ts's heavy list — ` +
        `they will run under the fast project's 15s cap and flake under load`,
    ).toEqual([]);
  });
});
