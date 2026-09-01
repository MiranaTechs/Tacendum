/**
 * THE ROW SEMANTICS:
 *
 *  - a per-pair verification stamp is a human act ABOUT A KEY: replacing a
 *    peer device's recorded key invalidates that pair's stamp in the same
 *    write path, before the upsert, so no caller can skip it;
 *  - leaving the group takes the stored recovery notice with it — a
 *    notice names THE GROUPING, and a former group's claim must not
 *    survive to resurrect;
 *  - `account_identifier` carries `restoredAt` — the recovery-restored
 *    placeholder marker — through save and load.
 *
 * Harness follows db.blocking.test.ts: the fake op-sqlite records
 * statements; assertions read the SQL and its parameters by position.
 */
import * as db from '../src/db';

interface FakeDb {
  name: string;
  execute: jest.Mock;
  close: jest.Mock;
}
const sqliteModule = jest.requireMock('@op-engineering/op-sqlite') as {
  open: (o: { name: string }) => FakeDb;
  __sqlite: {
    opened: string[];
    instances: Map<string, FakeDb>;
    reset: () => void;
  };
};
const sqlite = sqliteModule.__sqlite;

const REAL = 'tacendum.sqlite';
const DEVICE = '01DEVSZ3NDEKTSV4RRFFQ69G5G';

function calls(name = REAL): Array<[string, unknown[]]> {
  return (sqlite.instances.get(name)?.execute.mock.calls ?? []).map(c => [
    String(c[0]),
    (c[1] ?? []) as unknown[],
  ]);
}
/** Statements issued from this point on. */
function since(name = REAL): () => Array<[string, unknown[]]> {
  const mark = calls(name).length;
  return () => calls(name).slice(mark);
}

beforeEach(async () => {
  await db.close();
  sqlite.reset();
  db.setWorkspace('real');
  await db.initDb();
});

afterEach(async () => {
  await db.close();
});

describe('per-pair stamps die with the key they were made against', () => {
  it('an upsert carrying a key runs the key-change invalidation BEFORE the row write, guarded on a DIFFERENT recorded key', async () => {
    const after = since();
    await db.upsertPeerDevice({
      userId: DEVICE,
      anchorId: DEVICE,
      class: 'tablet',
      state: 'linked',
      identityKeyPub: 'NEWKEY',
      certsJson: '',
      updatedAt: 1,
    });
    const run = after();
    const wipeIdx = run.findIndex(([sql]) =>
      sql.includes('DELETE FROM peer_device_safety'),
    );
    const upsertIdx = run.findIndex(([sql]) =>
      sql.includes('INSERT OR REPLACE INTO peer_devices'),
    );
    expect(wipeIdx).toBeGreaterThanOrEqual(0);
    expect(upsertIdx).toBeGreaterThan(wipeIdx);
    const [wipeSql, wipeParams] = run[wipeIdx]!;
    // The guard is IN the statement: only a standing row whose recorded,
    // non-empty key DIFFERS from the incoming one clears the stamp — a
    // same-key redelivery or a first sighting deletes nothing.
    expect(wipeSql).toMatch(/EXISTS/);
    expect(wipeSql).toMatch(/identityKeyPub != ''/);
    expect(wipeSql).toMatch(/identityKeyPub != \?/);
    expect(wipeParams).toEqual([DEVICE, DEVICE, 'NEWKEY']);
  });

  it('an upsert carrying NO key asserts nothing and clears nothing', async () => {
    const after = since();
    await db.upsertPeerDevice({
      userId: DEVICE,
      anchorId: DEVICE,
      class: 'tablet',
      state: 'pending',
      identityKeyPub: '',
      certsJson: '',
      updatedAt: 1,
    });
    expect(
      after().filter(([sql]) => sql.includes('DELETE FROM peer_device_safety')),
    ).toEqual([]);
  });

  it('clearPeerPairSafety drops exactly the one pair row (the acceptIdentityChange reset)', async () => {
    const after = since();
    await db.clearPeerPairSafety(DEVICE);
    const wipes = after().filter(([sql]) =>
      sql.includes('DELETE FROM peer_device_safety'),
    );
    expect(wipes).toHaveLength(1);
    expect(wipes[0]![0]).toMatch(/WHERE userId = \?/);
    expect(wipes[0]![1]).toEqual([DEVICE]);
  });
});

describe('leaving the group clears the grouping-shaped residue', () => {
  it('clearLinkGroup deletes the stored recovery notice beside the roster', async () => {
    const after = since();
    await db.clearLinkGroup();
    const sql = after().map(([s]) => s);
    expect(sql.some(s => s.includes('DELETE FROM link_group'))).toBe(true);
    expect(sql.some(s => s.includes('DELETE FROM linked_devices'))).toBe(true);
    expect(sql.some(s => s.includes('DELETE FROM recovery_notice'))).toBe(true);
  });
});

describe('the restored-placeholder marker rides the identifier row', () => {
  it('saveAccountIdentifier binds restoredAt as its own parameter', async () => {
    const after = since();
    await db.saveAccountIdentifier({
      email: 'a@b.co',
      verifiedAt: 5,
      discoverable: false,
      pendingEmail: null,
      pendingRequestedAt: null,
      restoredAt: 9,
    });
    const writes = after().filter(([sql]) =>
      sql.includes('INSERT OR REPLACE INTO account_identifier'),
    );
    expect(writes).toHaveLength(1);
    expect(writes[0]![0]).toMatch(/restoredAt/);
    // The row leads with its CLASS (one row per kind — the
    // per-class migration): the email accessor writes the email row.
    expect(writes[0]![1]).toEqual(['email', 'a@b.co', 5, 0, null, null, 9]);
  });

  it('a fresh file is born per-class with restoredAt; an earlier-era file REBUILDS with the row carried', async () => {
    // The fresh half: the CREATE carries the per-class shape.
    const create = calls()
      .map(([s]) => s)
      .find(s => s.includes('CREATE TABLE IF NOT EXISTS account_identifier'));
    expect(create).toBeDefined();
    expect(create).toMatch(/kind TEXT PRIMARY KEY/);
    expect(create).toMatch(/restoredAt INTEGER/);

    // The earlier-era half: PRAGMA answering the OLD columns (key/email…,
    // restoredAt still absent — an older file) must drive the ALTER
    // and then the rebuild that carries the one row to kind='email'.
    await db.close();
    sqlite.reset();
    const inst = sqliteModule.open({ name: REAL });
    const base = inst.execute.getMockImplementation()!;
    inst.execute.mockImplementation(((sql: unknown, params?: unknown[]) => {
      const s = String(sql);
      if (s.includes('PRAGMA table_info(account_identifier')) {
        return {
          rows: ['key', 'email', 'verifiedAt', 'discoverable', 'pendingEmail', 'pendingRequestedAt'].map(
            name => ({ name }),
          ),
        };
      }
      if (s.includes('PRAGMA table_info(recovery_local')) {
        return {
          rows: ['key', 'email', 'groupId', 'completesAt', 'verifiedAt'].map(name => ({ name })),
        };
      }
      return base(sql, params);
    }) as never);
    db.setWorkspace('real');
    await db.initDb();
    const sql = calls().map(([s]) => s);
    expect(
      sql.some(s => s.includes('ALTER TABLE account_identifier ADD COLUMN restoredAt')),
    ).toBe(true);
    expect(
      sql.some(s => s.includes('ALTER TABLE account_identifier RENAME TO account_identifier_ac8')),
    ).toBe(true);
    const carry = sql.find(s => s.includes('FROM account_identifier_ac8'));
    expect(carry).toBeDefined();
    expect(carry).toMatch(/SELECT 'email', email/);
    expect(sql.some(s => s.includes('DROP TABLE account_identifier_ac8'))).toBe(true);
    // recovery_local rides the same discipline: the started recovery
    // defaults to 'email' — the only kind that could have started one.
    const recoveryCarry = sql.find(s => s.includes('FROM recovery_local_ac8'));
    expect(recoveryCarry).toBeDefined();
    expect(recoveryCarry).toMatch(/SELECT 'recovery', 'email', email/);
  });
});
