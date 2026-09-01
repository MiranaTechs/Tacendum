/**
 * Chat avatars are part of the persistent storage ledger.
 *
 * The storage ceiling (messaging.AUTO_FETCH_STORAGE_CEILING) is measured from
 * the disk itself at session start. It used to measure only the attachments
 * table, so a peer's avatar — written to chats.avatarB64, one blob buffered
 * whole — grew the disk uncounted. "One per peer" is no bound when accounts
 * are free: a Sybil roster of maximum-size faces walks past the ceiling.
 *
 * setPeerAvatar now returns the NET change in stored avatar bytes so the
 * in-memory ledger can advance by the REPLACEMENT delta — an overwrite of the
 * same peer's face must charge the difference, never the full new length, or
 * a peer could reinflate the ledger by re-sending under a new version.
 */
import * as db from '../src/db';

interface FakeDb {
  name: string;
  execute: jest.Mock;
  close: jest.Mock;
}
const sqlite = (
  jest.requireMock('@op-engineering/op-sqlite') as {
    __sqlite: {
      instances: Map<string, FakeDb>;
      reset: () => void;
    };
  }
).__sqlite;

/** Make the real workspace answer setPeerAvatar's two queries with a known
 * prior avatar length and a known UPDATE outcome. Installed AFTER initDb, so
 * the schema build ran under the default stub and only setPeerAvatar's own
 * SELECT/UPDATE are steered here. */
function driveAvatar(oldLen: number, rowsAffected: number): void {
  const instance = sqlite.instances.get('tacendum.sqlite')!;
  instance.execute.mockImplementation(async (sql: string) => {
    const s = String(sql);
    if (s.startsWith('SELECT') && s.includes('length(avatarB64)')) {
      return { rows: [{ len: oldLen }] };
    }
    if (s.includes('UPDATE chats SET avatarB64')) {
      return { rowsAffected };
    }
    return { rows: [] };
  });
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

describe('setPeerAvatar returns the replacement delta for the storage ledger', () => {
  test('a first avatar (this peer held none) charges its full length', async () => {
    driveAvatar(0, 1);
    const delta = await db.setPeerAvatar('peer-1', 'x'.repeat(1000), 5);
    expect(delta).toBe(1000);
  });

  test('overwriting a peer avatar charges the DIFFERENCE, never the full new length', async () => {
    // The peer already holds 600 bytes; a 1000-byte replacement adds 400.
    // Charging 1000 here is the double-charge the ledger forbids — it would let
    // a peer walk the ledger up by re-sending the same face each version.
    driveAvatar(600, 1);
    const delta = await db.setPeerAvatar('peer-1', 'x'.repeat(1000), 6);
    expect(delta).toBe(400);
  });

  test('a smaller replacement frees bytes (a negative delta)', async () => {
    driveAvatar(1000, 1);
    const delta = await db.setPeerAvatar('peer-1', 'x'.repeat(200), 7);
    expect(delta).toBe(-800);
  });

  test('the version gate refusing a stale card charges nothing', async () => {
    // rowsAffected 0: a newer profileVersion is on the row, the UPDATE matched
    // nothing, the bytes are unchanged.
    driveAvatar(600, 0);
    const delta = await db.setPeerAvatar('peer-1', 'x'.repeat(1000), 3);
    expect(delta).toBe(0);
  });
});
