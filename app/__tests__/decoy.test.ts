/**
 * The decoy program's verify: decoy generation shape, garble containment,
 * determinism, freshness drift, and the leak gate (zero derived
 * bytes — the only real data in the decoy file is the user's own profile).
 */
import {
  garbleSentence,
  generateDecoyData,
  refreshDecoyTimestamps,
  writeDecoy,
  type Rng,
} from '../src/decoy';
import { EMOJI, SYLLABLES } from '../src/decoy-corpus';
import type { ProfileRow } from '../src/db';

interface FakeDb {
  name: string;
  execute: jest.Mock;
  close: jest.Mock;
}
const sqlite = (
  jest.requireMock('@op-engineering/op-sqlite') as {
    __sqlite: {
      opened: string[];
      instances: Map<string, FakeDb>;
      reset: () => void;
    };
  }
).__sqlite;

/** Deterministic rng: a fixed linear walk is enough for shape tests. */
function seededRng(seed: number): Rng {
  let state = seed >>> 0;
  return () => {
    // Cosmetic test PRNG (mulberry32) — production uses platform randomness.
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NOW = 1_700_000_000_000;

beforeEach(() => {
  sqlite.reset();
});

describe('generateDecoyData', () => {
  test('produces 6-9 lived-in chats with 8-28 ordered messages each', () => {
    for (const seed of [1, 42, 999]) {
      const data = generateDecoyData(seededRng(seed), NOW);
      expect(data.chats.length).toBeGreaterThanOrEqual(6);
      expect(data.chats.length).toBeLessThanOrEqual(9);
      for (const chat of data.chats) {
        expect(chat.messages.length).toBeGreaterThanOrEqual(8);
        expect(chat.messages.length).toBeLessThanOrEqual(28);
        for (let i = 1; i < chat.messages.length; i++) {
          expect(chat.messages[i].ts).toBeGreaterThan(
            chat.messages[i - 1].ts,
          );
        }
        expect(chat.messages.every(m => m.ts < NOW)).toBe(true);
      }
      const directions = new Set(
        data.chats.flatMap(c => c.messages.map(m => m.direction)),
      );
      expect(directions).toEqual(new Set(['in', 'out']));
    }
  });

  test('newest activity lands 10-120 minutes in the past', () => {
    // Across the WHOLE world: rooms land in the same messages table, so the
    // freshness promise is about the newest row anywhere, not the newest
    // 1:1. Seed 15 is a world whose newest activity is IN a room — chosen so
    // a freshness clock that forgot the rooms cannot pass by riding a chat.
    for (const seed of [7, 15]) {
      const data = generateDecoyData(seededRng(seed), NOW);
      const all = [
        ...data.chats.flatMap(c => c.messages.map(m => m.ts)),
        ...data.rooms.flatMap(r => r.messages.map(m => m.ts)),
        ...data.rooms.flatMap(r => r.events.map(e => e.ts)),
      ];
      const newest = Math.max(...all);
      expect(NOW - newest).toBeGreaterThanOrEqual(10 * 60_000);
      expect(NOW - newest).toBeLessThanOrEqual(120 * 60_000);
    }
  });

  test('chat names are unique and non-empty', () => {
    const data = generateDecoyData(seededRng(3), NOW);
    const names = data.chats.map(c => c.displayName);
    expect(new Set(names).size).toBe(names.length);
    expect(names.every(n => n.trim().length > 0)).toBe(true);
  });

  test('is deterministic for the same randomness', () => {
    expect(generateDecoyData(seededRng(11), NOW)).toEqual(
      generateDecoyData(seededRng(11), NOW),
    );
  });
});

describe('garbleSentence', () => {
  test('every token is corpus syllables, corpus emoji, or a cipher group', () => {
    const syllableWord = new RegExp(`^(${SYLLABLES.join('|')})+[.!?…]?$`);
    const cipherGroup = /^[0-9a-f]{2,4}(·[0-9a-f]{2,4})+$/;
    const rng = seededRng(5);
    for (let i = 0; i < 300; i++) {
      const sentence = garbleSentence(rng);
      expect(sentence.length).toBeGreaterThan(0);
      for (const token of sentence.split(' ')) {
        const ok =
          syllableWord.test(token) ||
          cipherGroup.test(token) ||
          (EMOJI as readonly string[]).includes(token);
        if (!ok) throw new Error(`unexpected token: ${token}`);
      }
    }
  });
});

describe('writeDecoy — the leak gate', () => {
  const me: ProfileRow = {
    // A REAL ULID shape: the room fabrication runs my id through the actual
    // envelope encoder (grp.new `ms`), which refuses anything else — exactly
    // as production would, where userId is always a ULID.
    userId: '01ME0000000000000000000000',
    registrationId: 7,
    displayName: 'OWN_CANARY_NAME',
    about: 'own about',
    avatarB64: '',
    profileVersion: 3,
  };

  test('writes only to the decoy file and clears it first', async () => {
    await writeDecoy(generateDecoyData(seededRng(1), NOW), me);
    expect(sqlite.opened).toEqual(['tacendum-decoy.sqlite']);
    const decoy = sqlite.instances.get('tacendum-decoy.sqlite')!;
    const statements = decoy.execute.mock.calls.map(c => String(c[0]));
    const firstInsert = statements.findIndex(s => s.startsWith('INSERT'));
    const deletes = statements.filter(s => s.startsWith('DELETE FROM'));
    expect(deletes.length).toBeGreaterThan(0);
    expect(statements.indexOf(deletes[0])).toBeLessThan(firstInsert);
    // NAMED, not counted. `deletes.length > 0` was satisfied by any one table,
    // so dropping 'vault_items' from DB_TABLES — which would let a decoy
    // rebuild INHERIT the real credentials — left this gate
    // green. It holds the highest-value strings on the phone; it gets a line.
    expect(deletes).toContain('DELETE FROM vault_items');
    expect(decoy.close).toHaveBeenCalled();
  });

  test('the decoy vault has texture, and it is invented rather than copied', async () => {
    // The vault design asked for this to be decided rather than left: an EMPTY
    // decoy vault is a mild tell, because a coercer who knows the product knows
    // some Rooms have items. Written column for column with the real table, so
    // the two cannot be told apart by shape.
    await writeDecoy(generateDecoyData(seededRng(11), NOW), me);
    const decoy = sqlite.instances.get('tacendum-decoy.sqlite')!;
    const inserts = decoy.execute.mock.calls.filter(c =>
      String(c[0]).includes('INSERT INTO vault_items'),
    );
    expect(inserts.length).toBeGreaterThan(0);
    for (const [sql, params] of inserts) {
      for (const column of [
        'peerId',
        'id',
        'writerId',
        'seq',
        'ackSeq',
        'title',
        'body',
        'updatedAt',
        'deleted',
      ]) {
        expect(String(sql)).toContain(column);
      }
      const [peerId, id, writerId, seq, ackSeq, title, body, updatedAt] =
        params as [string, string, string, number, number, string, string, number];
      expect(id).toHaveLength(26);
      // Both sides write to a real Room's vault, so the decoy's must too.
      expect([peerId, me.userId]).toContain(writerId);
      expect(seq).toBeGreaterThanOrEqual(1);
      expect(ackSeq).toBeLessThan(seq);
      expect(title.length).toBeGreaterThan(0);
      expect(body.length).toBeGreaterThan(0);
      expect(updatedAt).toBeLessThanOrEqual(NOW);
    }
    // At least one Room WITHOUT a vault: an item in every conversation would be
    // as much of a tell as an item in none.
    const rooms = new Set(inserts.map(c => (c[1] as string[])[0]));
    const chatInserts = decoy.execute.mock.calls.filter(c =>
      String(c[0]).includes('INSERT INTO chats'),
    );
    expect(rooms.size).toBeLessThan(chatInserts.length);
  });

  test('no canary from the real workspace can appear — only my own profile crosses', async () => {
    // Real-workspace data exists but the writer must never read it: these
    // canaries live ONLY here; if any shows up in decoy SQL, bytes leaked.
    const PEER_CANARY = 'REAL_PEER_ZINNIA_47';
    const MSG_CANARY = 'REAL_MESSAGE_BODY_MARIGOLD_93';
    const real = {
      name: 'tacendum.sqlite',
      execute: jest.fn(async () => ({
        rows: [{ displayName: PEER_CANARY, body: MSG_CANARY }],
      })),
      close: jest.fn(),
    };
    sqlite.instances.set('tacendum.sqlite', real as unknown as FakeDb);

    await writeDecoy(generateDecoyData(seededRng(2), NOW), me);

    const decoy = sqlite.instances.get('tacendum-decoy.sqlite')!;
    const everything = decoy.execute.mock.calls
      .map(c => JSON.stringify(c))
      .join('\n');
    expect(everything).not.toContain(PEER_CANARY);
    expect(everything).not.toContain(MSG_CANARY);
    expect(real.execute).not.toHaveBeenCalled();

    // My own profile is the one sanctioned copy.
    expect(everything).toContain('OWN_CANARY_NAME');
    const profileWrites = decoy.execute.mock.calls.filter(c =>
      String(c[0]).includes('INTO profile'),
    );
    const nonProfile = decoy.execute.mock.calls
      .filter(c => !String(c[0]).includes('INTO profile'))
      .map(c => JSON.stringify(c))
      .join('\n');
    expect(profileWrites.length).toBeGreaterThan(0);
    expect(nonProfile).not.toContain('OWN_CANARY_NAME');
  });
});

describe('refreshDecoyTimestamps', () => {
  test('shifts everything forward so the newest message is 10-120 min old', async () => {
    const stale = NOW - 40 * 24 * 60 * 60_000;
    const decoy: FakeDb = {
      name: 'tacendum-decoy.sqlite',
      execute: jest.fn(async (sql: string) => {
        if (String(sql).includes('MAX(')) return { rows: [{ newest: stale }] };
        return { rows: [] };
      }),
      close: jest.fn(),
    };
    sqlite.instances.set('tacendum-decoy.sqlite', decoy);

    await refreshDecoyTimestamps(NOW);

    const updates = decoy.execute.mock.calls.filter(c =>
      String(c[0]).startsWith('UPDATE'),
    );
    expect(updates.length).toBeGreaterThan(0);
    // Named tables, not a count: `vault_items` was the one this drift forgot,
    // so every decoy vault item kept the timestamp it was generated with while
    // the conversations around it stayed 10-120 minutes old.
    const drifted = updates.map(c => String(c[0]));
    for (const table of ['messages', 'chats', 'reactions', 'vault_items']) {
      expect(drifted.some(s => s.includes(table))).toBe(true);
    }
    for (const call of updates) {
      const delta = (call[1] as number[])[0];
      const shifted = stale + delta;
      expect(NOW - shifted).toBeGreaterThanOrEqual(10 * 60_000);
      expect(NOW - shifted).toBeLessThanOrEqual(120 * 60_000);
    }
  });

  test('never shifts backwards and no-ops on an empty decoy', async () => {
    const freshEnough = NOW - 5 * 60_000;
    const decoy: FakeDb = {
      name: 'tacendum-decoy.sqlite',
      execute: jest.fn(async (sql: string) => {
        if (String(sql).includes('MAX('))
          return { rows: [{ newest: freshEnough }] };
        return { rows: [] };
      }),
      close: jest.fn(),
    };
    sqlite.instances.set('tacendum-decoy.sqlite', decoy);
    await refreshDecoyTimestamps(NOW);
    expect(
      decoy.execute.mock.calls.some(c => String(c[0]).startsWith('UPDATE')),
    ).toBe(false);

    decoy.execute.mockImplementation(async (sql: string) => {
      if (String(sql).includes('MAX(')) return { rows: [{ newest: null }] };
      return { rows: [] };
    });
    await refreshDecoyTimestamps(NOW);
    expect(
      decoy.execute.mock.calls.some(c => String(c[0]).startsWith('UPDATE')),
    ).toBe(false);
  });
});
