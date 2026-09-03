import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The store's test-only primitives — `createUser`, `putConnection`,
 * `putPushToken`, `putLinkOffer`, `getUserByIdentityKeyClaim`,
 * `releaseCrewSlot` — live on `TestOnlyDataLayer`, off the production
 * `DataLayer`, and are reachable only through `makeTestOnlyDataLayer`. The
 * type split is what keeps a handler holding `Deps.db` from naming them; this
 * scan is what keeps a future host or handler from reaching around the type
 * by building the wide store itself. `db/data.ts` defines them and is the one
 * file excused. */

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const EXCUSED = new Set(['db/data.ts']);
const CALLS = /\.(createUser|putConnection|putPushToken|putLinkOffer|getUserByIdentityKeyClaim|releaseCrewSlot)\(/;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (name.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('the test-only store surface never reaches production source', () => {
  const files = walk(SRC)
    .map((full) => relative(SRC, full))
    .filter((rel) => !EXCUSED.has(rel))
    .sort();

  it('scans a real source tree', () => {
    expect(files.length).toBeGreaterThan(20);
    expect(files).toContain('aws/deps.ts');
    expect(files).toContain('handlers/keys.ts');
  });

  it('no file under src/ names makeTestOnlyDataLayer', () => {
    const offenders = files.filter((rel) => readFileSync(join(SRC, rel), 'utf8').includes('makeTestOnlyDataLayer'));
    expect(offenders).toEqual([]);
  });

  it('no file under src/ calls one of the six test-only primitives', () => {
    const offenders = files.filter((rel) => CALLS.test(readFileSync(join(SRC, rel), 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('the dead deletePushTokenIfMatches is gone from the store entirely', () => {
    const data = readFileSync(join(SRC, 'db/data.ts'), 'utf8');
    expect(data.includes('deletePushTokenIfMatches')).toBe(false);
  });
});
