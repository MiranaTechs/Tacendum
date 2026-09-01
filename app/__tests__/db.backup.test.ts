/**
 * The message database must not be in the device backup.
 *
 * It is plain SQLite by design — at-rest protection is iOS Data Protection,
 * not app-side crypto — and Data Protection governs readability on a locked
 * phone while saying nothing about the backup service. Only the key store and
 * a QR scratch directory were ever excluded, so an iCloud backup (on by
 * default) contained the whole plaintext message history and every decrypted
 * image in it, at the same time as the published security page said "there is
 * no backup and no recovery, by design".
 *
 * WHAT THESE TESTS ASSERT, AND WHY THE SHAPE MATTERS. An earlier version
 * checked only that an exclusion call was made per database file, which let a
 * per-file suffix list ship for months flagging `-wal`/`-shm` — WAL-mode
 * sidecars these DELETE-journal databases never create — while the sidecar
 * that DOES exist, `<db>-journal` (plaintext page pre-images, persisting as a
 * hot journal after a crash), was never flagged at all. So these tests assert
 * on the SET OF PATHS the exclusion covers: the databases must live INSIDE a
 * directory, the directory must be the flagged thing (iOS propagates the
 * exclusion to everything beneath it), and every sidecar SQLite could ever
 * mint next to a database — present, hot, or future — must be covered by
 * construction. A design that goes back to flagging individual files fails
 * here on the `-journal` path.
 *
 * The keys stay excluded, which is what keeps "lose the phone and the account
 * is gone" true. This is what makes the message text keep the same promise.
 */
import * as db from '../src/db';
import {
  generateDecoyData,
  refreshDecoyTimestamps,
  writeDecoy,
  type Rng,
} from '../src/decoy';

const crypto = jest.requireMock('tacendum-crypto') as {
  __backupExclusion: {
    dir: string;
    excludedPaths: Set<string>;
    failExclusion: boolean;
  };
  prepareDatabaseDirectory: jest.Mock;
};

const sqlite = jest.requireMock('@op-engineering/op-sqlite') as {
  open: jest.Mock;
  __sqlite: { opened: string[]; reset: () => void };
};

/**
 * iOS backup semantics: a file is skipped when it carries the exclusion flag
 * itself OR when ANY ancestor directory does — backupd never descends into an
 * excluded directory. This helper is the property under test: a path is safe
 * only if the flag covers it, however SQLite came to create it.
 */
function covered(path: string): boolean {
  const excluded = crypto.__backupExclusion.excludedPaths;
  let prefix = path;
  while (prefix.length > 0) {
    if (excluded.has(prefix)) return true;
    const cut = prefix.lastIndexOf('/');
    if (cut <= 0) break;
    prefix = prefix.slice(0, cut);
  }
  return false;
}

/** Every file SQLite can mint for a database at this path. `-journal` is the
 * one DELETE mode actually creates (and leaves behind after a crash); -wal and
 * -shm would appear if the journal mode ever changed. All must be covered. */
const SIDECARS = ['', '-journal', '-wal', '-shm'];

beforeEach(async () => {
  await db.close();
  sqlite.__sqlite.reset();
  crypto.__backupExclusion.excludedPaths.clear();
  crypto.__backupExclusion.failExclusion = false;
  crypto.prepareDatabaseDirectory.mockClear();
});

afterEach(async () => {
  await db.close();
  // The workspace is module-level state shared with every other suite in this
  // worker. Leaving it on 'decoy' made unrelated database tests fail against a
  // file they never opened — the tests here pass either way, which is exactly
  // what makes that kind of leak worth undoing explicitly.
  db.setWorkspace('real');
});

test('the real workspace database and EVERY possible sidecar are covered', async () => {
  db.setWorkspace('real');
  await db.initDb();

  const dir = crypto.__backupExclusion.dir;
  for (const suffix of SIDECARS) {
    expect({
      path: `tacendum.sqlite${suffix}`,
      covered: covered(`${dir}/tacendum.sqlite${suffix}`),
    }).toEqual({ path: `tacendum.sqlite${suffix}`, covered: true });
  }
});

test('the DECOY workspace database and every sidecar are covered too', async () => {
  // The decoy exists so a coerced unlock shows a plausible, empty history. A
  // decoy database recoverable from an iCloud backup — or a decoy-named
  // journal file, whose NAME alone proves the feature is armed — defeats the
  // entire point of having one.
  db.setWorkspace('decoy');
  await db.initDb();

  const dir = crypto.__backupExclusion.dir;
  for (const suffix of SIDECARS) {
    expect({
      path: `tacendum-decoy.sqlite${suffix}`,
      covered: covered(`${dir}/tacendum-decoy.sqlite${suffix}`),
    }).toEqual({ path: `tacendum-decoy.sqlite${suffix}`, covered: true });
  }
});

test('the flagged thing is the CONTAINING DIRECTORY, not a list of files', async () => {
  // This is the by-construction property. A hot journal is created during a
  // write and persists after a crash; per-file flagging can only reach files
  // that exist at open time, and (verified against SQLite 3.51) the next open
  // does not even reliably unlink a recovered journal. A flag on the directory
  // covers whatever SQLite creates in it, whenever it creates it.
  db.setWorkspace('real');
  await db.initDb();

  expect(
    crypto.__backupExclusion.excludedPaths.has(crypto.__backupExclusion.dir),
  ).toBe(true);
});

test('the database is opened INSIDE the excluded directory', async () => {
  // Excluding one directory while opening the database in another would pass
  // every coverage assertion above and protect nothing.
  db.setWorkspace('real');
  await db.initDb();

  expect(sqlite.open).toHaveBeenCalledWith({
    name: 'tacendum.sqlite',
    location: crypto.__backupExclusion.dir,
  });
});

test('the directory is prepared BEFORE the database is opened', async () => {
  // Ordering is the migration guarantee: prepare moves a legacy database from
  // the old Library-root location into the directory. If open() ran first,
  // SQLite would mint a fresh empty file at the new path and the migration
  // would refuse to overwrite it — every existing install would look wiped.
  db.setWorkspace('real');
  await db.initDb();

  const prepared = crypto.prepareDatabaseDirectory.mock.invocationCallOrder[0];
  const opened = sqlite.open.mock.invocationCallOrder[0];
  expect(prepared).toBeDefined();
  expect(opened).toBeDefined();
  expect(prepared).toBeLessThan(opened);
});

test('initDb prepares BOTH database families, not just the active one', async () => {
  // The decoy migrates out of the old backed-up location on the first launch
  // of the build that knows better — not on the first duress unlock, which for
  // most owners (exactly the population the decoy exists for) never happens.
  db.setWorkspace('real');
  await db.initDb();

  const prepared = crypto.prepareDatabaseDirectory.mock.calls.map(c => c[0]);
  expect(prepared).toContain('tacendum.sqlite');
  expect(prepared).toContain('tacendum-decoy.sqlite');
});

/**
 * The decoy must be covered from the moment it EXISTS, not from the first
 * duress unlock. `conn()` only ever opens the decoy during an actual duress
 * unlock — but the file is CREATED much earlier, by the short-lived side
 * connections below (App Lock setup, sign-out clearing, freshness drift). A
 * user who turns on App Lock and is never coerced — plausibly most users —
 * would otherwise carry a decoy in their iCloud backup for as long as they
 * own the phone.
 */
describe('the decoy file is covered the moment it exists', () => {
  /** Deterministic rng (mulberry32), same shape as decoy.test.ts — cosmetic. */
  function seededRng(seed: number): Rng {
    let state = seed >>> 0;
    return () => {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const me: db.ProfileRow = {
    // A real ULID shape: the decoy's room fabrication
    // runs my id through the actual envelope encoder, which refuses anything
    // else — exactly as production, where userId is always a ULID.
    userId: '01ME0000000000000000000000',
    registrationId: 7,
    displayName: 'me',
    about: '',
    avatarB64: '',
    profileVersion: 1,
  };

  test('App Lock setup (writeDecoy) — with NO duress unlock', async () => {
    // This is the path SettingsScreen.commit runs when App Lock is enabled:
    // setupDecoy -> writeDecoy, in a REAL session, over a side connection that
    // never touches conn(). The workspace stays 'real' throughout and initDb
    // is never called with 'decoy' — the gap the duress-path tests above
    // cannot see.
    db.setWorkspace('real');
    await writeDecoy(generateDecoyData(seededRng(1), Date.now()), me);

    const dir = crypto.__backupExclusion.dir;
    expect(sqlite.open).toHaveBeenCalledWith({
      name: 'tacendum-decoy.sqlite',
      location: dir,
    });
    expect(covered(`${dir}/tacendum-decoy.sqlite`)).toBe(true);
    expect(covered(`${dir}/tacendum-decoy.sqlite-journal`)).toBe(true);
  });

  test('clearDecoyState (sign-out / registration) covers it too', async () => {
    // open() creates the file when it is missing, so whichever side
    // connection reaches the decoy first is its creation site.
    await db.clearDecoyState();

    const dir = crypto.__backupExclusion.dir;
    expect(sqlite.open).toHaveBeenCalledWith({
      name: 'tacendum-decoy.sqlite',
      location: dir,
    });
    expect(covered(`${dir}/tacendum-decoy.sqlite`)).toBe(true);
  });

  test('freshness drift (refreshDecoyTimestamps) re-asserts the coverage', async () => {
    await refreshDecoyTimestamps();

    const dir = crypto.__backupExclusion.dir;
    expect(sqlite.open).toHaveBeenCalledWith({
      name: 'tacendum-decoy.sqlite',
      location: dir,
    });
    expect(covered(`${dir}/tacendum-decoy.sqlite`)).toBe(true);
  });

  test('a failing flag write does not break decoy creation', async () => {
    // Same posture as conn(): the flag is hardening, not correctness, and a
    // decoy that failed to generate because a filesystem attribute could not
    // be set would break App Lock setup outright.
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      crypto.__backupExclusion.failExclusion = true;

      await expect(
        writeDecoy(generateDecoyData(seededRng(2), Date.now()), me),
      ).resolves.toBeUndefined();
      expect(crypto.prepareDatabaseDirectory).toHaveBeenCalledWith(
        'tacendum-decoy.sqlite',
      );
    } finally {
      warn.mockRestore();
    }
  });
});

test('a failure to set the flag does not stop the database opening — but is no longer silent', async () => {
  // Deliberate: the flag is hardening, not correctness. A database that opened
  // fine must not fail because a filesystem attribute could not be written —
  // that would turn a privacy improvement into an outage. But the OLD code
  // also swallowed the failure at every layer (the native Bool was discarded,
  // the promise resolved as success, the JS catch saw nothing), so a device
  // whose backups quietly included everything was indistinguishable from a
  // healthy one. Now the failure comes back as `excluded: false` and is
  // warned about — visibly, and without naming a file (by design, and a
  // log line naming the decoy would prove the decoy is armed).
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    crypto.__backupExclusion.failExclusion = true;

    db.setWorkspace('real');
    await expect(db.initDb()).resolves.not.toThrow();

    // …the app is still usable, which is the actual claim…
    await expect(db.loadProfile()).resolves.toBeDefined();

    // …and someone can now see it happened.
    expect(warn).toHaveBeenCalled();
    for (const call of warn.mock.calls) {
      // No database filename in the warning: 'decoy' in a device log would
      // itself be the leak the exclusion exists to prevent.
      expect(String(call[0])).not.toMatch(/sqlite|decoy|tacendum\./);
    }
  } finally {
    warn.mockRestore();
  }
});

test('a directory that cannot be prepared fails the open LOUDLY', async () => {
  // The one case that must not fall back: if the migration cannot run, opening
  // at the new path would mint a fresh empty database and every existing
  // conversation would appear wiped. "Cannot open" is recoverable and loud;
  // "everything is gone" is silent and looks permanent.
  crypto.prepareDatabaseDirectory.mockImplementationOnce(() => {
    throw new Error('database directory unavailable');
  });

  db.setWorkspace('real');
  await expect(db.initDb()).rejects.toThrow('database directory unavailable');
});
