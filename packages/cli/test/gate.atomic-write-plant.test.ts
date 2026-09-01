/**
 * An external scan: `writeFileAtomic` staged its temp file at
 * `<target>.<pid>.tmp` — a name anything on the machine can compute — and
 * opened it with `'w'`, which FOLLOWS a pre-planted symlink and truncates
 * whatever it points at. The temp lives in the same 0700 user-owned directory
 * as its target, so there is no cross-user exploit path; what the name cost
 * anyway was the guarantee that the bytes about to become key material were
 * written to a file THIS call created. `saveProfile` carried a second inline
 * copy of the same pattern for the auth token.
 *
 * The repair has to hold on TWO axes at once, and this file pins both:
 *
 *  - REFUSAL: the temp is opened O_CREAT|O_EXCL|O_NOFOLLOW under a random
 *    suffix, so a planted file or symlink — wherever it points — answers
 *    EEXIST instead of being followed, and nothing this module didn't create
 *    is ever written through or deleted.
 *  - AVAILABILITY: the naive repair (O_EXCL on the PID name) makes a strand
 *    from a crashed process fatal — a recycled pid then collides with its
 *    corpse and every future write of that target fails forever. The random
 *    suffix is what makes O_EXCL safe to hold: a stale strand can never share
 *    a name with a future write. The strand itself is cleaned up on failure
 *    when this process is alive to do it, and swept by the owners of the
 *    directories it can appear in (msglog's lock-custody sweeps, hooks'
 *    mtime-gated queue sweep) when it is not.
 *
 * The crypto mock below pins the suffix ONLY where a test must pre-place a
 * file at the exact path the next write will stage — planting is the attack,
 * and an attacker does not get to know the name. Everything else runs real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { takePersistenceFailure, writeFileAtomic } from '../src/atomic-write.js';
import { saveProfile, type Profile } from '../src/profile.js';
import { clientDir } from '../src/config.js';

const state = vi.hoisted(() => ({
  /** When set (12 hex chars = 6 bytes), writeFileAtomic's suffix draw becomes
   * deterministic so a test can plant at the exact staging path. */
  fixedHex: undefined as string | undefined,
  /** Every path openSync was asked for — real openSync still runs. */
  opened: [] as string[],
}));

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    randomBytes: ((size: number, cb?: unknown) => {
      if (state.fixedHex !== undefined && size === 6 && cb === undefined) {
        return Buffer.from(state.fixedHex, 'hex');
      }
      return (actual.randomBytes as (s: number, c?: unknown) => Buffer)(size, cb);
    }) as typeof actual.randomBytes,
  };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    openSync: ((...args: Parameters<typeof actual.openSync>) => {
      state.opened.push(String(args[0]));
      return actual.openSync(...args);
    }) as typeof actual.openSync,
  };
});

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'tacendum-plant-'));
  process.env.TACENDUM_HOME = home;
  state.fixedHex = undefined;
  state.opened.length = 0;
});
afterEach(() => {
  delete process.env.TACENDUM_HOME;
  state.fixedHex = undefined;
  // This file's deliberate failures are recorded in the module-level
  // persistence slot; drain it so no other suite inherits an armed record.
  takePersistenceFailure();
  rmSync(home, { recursive: true, force: true });
});

describe('the temp name is not a rendezvous', () => {
  it('mints an unpredictable suffix: never the pid, fresh per write', () => {
    const target = join(home, 'a.json');
    writeFileAtomic(target, 'one');
    writeFileAtomic(target, 'two');
    const temps = state.opened.filter((p) => p.startsWith(`${target}.`) && p.endsWith('.tmp'));
    expect(temps).toHaveLength(2);
    for (const t of temps) {
      // The pid is the whole finding: computable by anything on the machine.
      expect(t).not.toBe(`${target}.${process.pid}.tmp`);
      expect(t).toMatch(/\.[0-9a-f]{12}\.tmp$/);
    }
    // Fresh entropy per write, not per process: a name that repeats within
    // one process is a name a stale strand can still collide with.
    expect(temps[0]).not.toBe(temps[1]);
    expect(readFileSync(target, 'utf8')).toBe('two');
  });
});

describe('a planted file at the staging path is refused, never followed', () => {
  it('symlink: EEXIST, the symlink target is never written through', () => {
    state.fixedHex = 'aaaabbbbcccc';
    const target = join(home, 'b.json');
    const victim = join(home, 'victim.txt');
    writeFileSync(victim, 'SECRET-ORIGINAL');
    const plant = `${target}.aaaabbbbcccc.tmp`;
    symlinkSync(victim, plant);

    expect(() => writeFileAtomic(target, 'attacker-visible bytes')).toThrow(/EEXIST|ELOOP/);
    // Nothing followed the link, nothing was published, and the planted
    // entry — which this call did NOT create — was not deleted either.
    expect(readFileSync(victim, 'utf8')).toBe('SECRET-ORIGINAL');
    expect(existsSync(target)).toBe(false);
    expect(lstatSync(plant).isSymbolicLink()).toBe(true);
  });

  it('regular file: EEXIST, the squatter is left exactly as planted', () => {
    state.fixedHex = 'aaaabbbbcccc';
    const target = join(home, 'b2.json');
    const plant = `${target}.aaaabbbbcccc.tmp`;
    writeFileSync(plant, 'squatter');

    expect(() => writeFileAtomic(target, 'x')).toThrow(/EEXIST/);
    expect(readFileSync(plant, 'utf8')).toBe('squatter');
    expect(existsSync(target)).toBe(false);
  });

  it('saveProfile stages through the same refusal (the inline copy is gone)', () => {
    state.fixedHex = 'eeeeffff0000';
    const victim = join(home, 'victim-profile.txt');
    writeFileSync(victim, 'ORIGINAL');
    const dir = clientDir('planttest');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const target = join(dir, 'profile.json');
    symlinkSync(victim, `${target}.eeeeffff0000.tmp`);

    const profile = {
      name: 'planttest',
      identityKey: 'AA==',
      userId: 'u_1',
      authToken: 'tok',
      registrationId: 1,
      deviceId: 1,
    } as Profile;
    expect(() => saveProfile(profile)).toThrow(/EEXIST|ELOOP/);
    expect(readFileSync(victim, 'utf8')).toBe('ORIGINAL');
    expect(existsSync(target)).toBe(false);
  });
});

describe('the availability half the naive repair breaks', () => {
  it('a strand under a recycled pid does not black-hole the target', () => {
    // GREEN before this change and after it; RED against the naive repair
    // (O_EXCL kept on the PID name), which is this test's job to forbid —
    // captured as the mutation proof in the fixing commit.
    const target = join(home, 'c.json');
    writeFileSync(`${target}.${process.pid}.tmp`, 'strand from a crashed twin of this pid');
    writeFileAtomic(target, 'fresh');
    expect(readFileSync(target, 'utf8')).toBe('fresh');
  });

  it('a failed rename cleans its temp up instead of stranding key material', () => {
    const target = join(home, 'd.json');
    // Squat the TARGET with a directory: the temp opens fine, the rename
    // fails EISDIR — the write path's own failure, not a planted temp.
    mkdirSync(target);
    expect(() => writeFileAtomic(target, 'x')).toThrow();
    expect(readdirSync(home).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });
});
