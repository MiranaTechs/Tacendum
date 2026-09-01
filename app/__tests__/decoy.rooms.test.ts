/**
 * The decoy workspace fabricates at least one plausible
 * room. An empty rooms list once rooms ship is the tell class the vault design
 * records for an empty vault, and rule 16 forbids it — so these tests hold
 * the fabrication to the real tables' shape: the anchor, two-lane slots
 * carrying writerId, attributed messages from several speakers, my own
 * counters, isolation between the two workspace files, determinism, the
 * freshness drift, and the sign-out wipe.
 *
 * The SQL itself is additionally proved against a real engine in
 * scripts/prove-db.mjs the design (the jest mock records statements without
 * executing them, so column-list mistakes are invisible here by design).
 */
import {
  generateDecoyData,
  refreshDecoyTimestamps,
  writeDecoy,
  type Rng,
} from '../src/decoy';
import * as db from '../src/db';
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

/** Deterministic rng — the same mulberry32 walk decoy.test.ts uses. */
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

const NOW = 1_700_000_000_000;
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

const me: ProfileRow = {
  // A real ULID shape: the fabrication runs my id through the actual
  // envelope encoder (grp.new `ms`), which refuses anything else.
  userId: '01ME0000000000000000000000',
  registrationId: 7,
  displayName: 'OWN_CANARY_NAME',
  about: '',
  avatarB64: '',
  profileVersion: 1,
};

beforeEach(async () => {
  await (db as { close?: () => Promise<void> }).close?.();
  (db as { setWorkspace?: (w: string) => void }).setWorkspace?.('real');
  sqlite.reset();
});

describe('generateDecoyData — the fabricated room', () => {
  test('every world has at least one room: anchor, slots and attributed messages all present', () => {
    for (const seed of [1, 7, 23, 42, 999]) {
      const data = generateDecoyData(seededRng(seed), NOW);
      // Precondition BEFORE the rules: an empty rooms array must fail here,
      // not slip through a vacuous for-loop below.
      expect(data.rooms.length).toBeGreaterThanOrEqual(1);
      for (const room of data.rooms) {
        expect(room.groupId).toMatch(ULID);
        expect(room.name.trim().length).toBeGreaterThan(0);

        // The anchor's owner sits in the founding roster.
        expect(room.founders).toContain(room.owner);
        expect(room.founders).toContain('me');

        // Slots: every founder holds an owner-lane 'in' row at the grp.new's
        // single seq, and the owner's own row is the merged one-row lane.
        expect(room.slots.length).toBeGreaterThan(0);
        for (const founder of room.founders) {
          const slot = room.slots.find(
            s => s.memberId === founder && s.writerId === room.owner,
          );
          expect(slot).toBeDefined();
          expect(slot!.state).toBe('in');
          expect(slot!.seq).toBe(1);
        }
        const merged = room.slots.filter(
          s => s.memberId === room.owner && s.writerId === room.owner,
        );
        expect(merged).toHaveLength(1);
        // Founding slots were applied in ONE transaction: one shared instant.
        const foundingTimes = new Set(
          room.slots.filter(s => s.seq === 1 && s.writerId === room.owner)
            .map(s => s.updatedAt),
        );
        expect(foundingTimes.size).toBe(1);

        // Messages: attributed, ordered, several speakers — not a monologue.
        expect(room.messages.length).toBeGreaterThanOrEqual(5);
        const authors = new Set(room.messages.map(m => m.author));
        expect(authors.size).toBeGreaterThanOrEqual(3);
        for (let i = 1; i < room.messages.length; i++) {
          expect(room.messages[i].ts).toBeGreaterThan(room.messages[i - 1].ts);
        }
        // Each author's sq is their own counter: 1..k in thread order.
        const perAuthor = new Map<string, number>();
        for (const m of room.messages) {
          const expected = (perAuthor.get(m.author) ?? 0) + 1;
          expect(m.sq).toBe(expected);
          perAuthor.set(m.author, expected);
        }

        // The room's history starts with its own creation, written by the
        // owner at the owner's first counter value.
        expect(room.events[0].tcm).toBe('grp.new');
        expect(room.events[0].writer).toBe(room.owner);
        expect(room.events[0].seq).toBe(1);
        expect(room.events[0].ts).toBeLessThan(room.messages[0].ts);
      }
    }
  });

  test('only the two real lanes ever appear, and every recorded life event is announced', () => {
    // Sweep enough seeds that the optional textures (a sovereign leave, a
    // mid-life add, the timer residue, a member never DM’d) all occur — and
    // hold every occurrence to the consistency a real room cannot violate.
    let sawSovereign = false;
    let sawAdd = false;
    let sawTimer = false;
    let sawStranger = false;
    let sawSecondRoom = false;
    for (let seed = 1; seed <= 80; seed++) {
      const data = generateDecoyData(seededRng(seed), NOW);
      const peerIds = new Set(data.chats.map(c => c.peerId));
      if (data.rooms.length > 1) sawSecondRoom = true;
      for (const room of data.rooms) {
        for (const slot of room.slots) {
          // Two lanes only: authority (writerId = owner) or the
          // member's own sovereign row. Anything else is a row the real
          // apply path can never store — a decoy carrying one is a probe.
          expect(
            slot.writerId === room.owner || slot.writerId === slot.memberId,
          ).toBe(true);
          expect(slot.seq).toBeGreaterThanOrEqual(1);
        }
        for (const slot of room.slots) {
          if (slot.writerId !== slot.memberId || slot.memberId === room.owner) {
            continue;
          }
          sawSovereign = true;
          // A sovereign row here is a departure, and a departure that no row
          // of the thread announces would contradict the room's own story.
          expect(slot.state).toBe('out');
          const leave = room.events.find(
            e =>
              e.tcm === 'grp.roster' &&
              e.writer === slot.memberId &&
              e.member === slot.memberId &&
              e.state === 'out',
          );
          expect(leave).toBeDefined();
          expect(leave!.seq).toBe(slot.seq);
          expect(leave!.ts).toBe(slot.updatedAt);
          // Their voice stops at the door.
          for (const m of room.messages) {
            if (m.author === slot.memberId) {
              expect(m.ts).toBeLessThan(leave!.ts);
            }
          }
        }
        for (const slot of room.slots) {
          if (slot.writerId !== room.owner || slot.seq <= 1) continue;
          sawAdd = true;
          const add = room.events.find(
            e =>
              e.tcm === 'grp.roster' &&
              e.writer === room.owner &&
              e.member === slot.memberId &&
              e.state === 'in',
          );
          expect(add).toBeDefined();
          expect(add!.seq).toBe(slot.seq);
          // Added mid-life means absent from the founding ms — and silent
          // before the add ("no history from before they joined").
          expect(room.founders).not.toContain(slot.memberId);
          for (const m of room.messages) {
            if (m.author === slot.memberId) {
              expect(m.ts).toBeGreaterThanOrEqual(add!.ts);
            }
          }
        }
        for (const s of room.settings) {
          sawTimer = true;
          // The only honest residue is a timer toggled off: a LIVE timer
          // would demand expiry stamps the fabricated messages do not carry.
          expect(s.disappearSec).toBe(0);
          const sets = room.events.filter(
            e => e.tcm === 'grp.set' && e.writer === s.writerId,
          );
          expect(sets.length).toBe(2);
          expect(sets[0].seconds).toBeGreaterThan(0);
          expect(sets[1].seconds).toBe(0);
          expect(sets[1].seq).toBe(s.seq);
          // No fabricated message sits inside the on-window, because a real
          // one there would have expired or carry a stamp.
          for (const m of room.messages) {
            const inside = m.ts >= sets[0].ts && m.ts <= sets[1].ts;
            expect(inside).toBe(false);
          }
        }
        for (const f of room.founders) {
          if (f !== 'me' && !peerIds.has(f)) sawStranger = true;
        }
        // MY counters mirror MY writes exactly.
        const myMessages = room.messages.filter(m => m.author === 'me').length;
        const msgCounter = room.counters.find(c => c.scope === 'msg');
        expect(msgCounter?.seq ?? 0).toBe(myMessages);
        const myWrites =
          room.events.filter(e => e.writer === 'me').length;
        const writerCounter = room.counters.find(c => c.scope === 'writer');
        expect(writerCounter?.seq ?? 0).toBe(myWrites);
        if (room.owner === 'me') {
          expect(writerCounter?.seq ?? 0).toBeGreaterThanOrEqual(1);
        }
      }
    }
    expect(sawSovereign).toBe(true);
    expect(sawAdd).toBe(true);
    expect(sawTimer).toBe(true);
    expect(sawStranger).toBe(true);
    expect(sawSecondRoom).toBe(true);
  });

  test('the owner is sometimes me and sometimes not', () => {
    const owners = new Set<string>();
    for (let seed = 1; seed <= 40; seed++) {
      for (const room of generateDecoyData(seededRng(seed), NOW).rooms) {
        owners.add(room.owner === 'me' ? 'me' : 'other');
      }
    }
    // A person who is only ever the creator of every room they are in — or
    // never the creator of any — is its own small implausibility.
    expect(owners).toEqual(new Set(['me', 'other']));
  });

  test('fabrication is deterministic for a seed and differs across seeds', () => {
    expect(generateDecoyData(seededRng(17), NOW)).toEqual(
      generateDecoyData(seededRng(17), NOW),
    );
    const a = generateDecoyData(seededRng(1), NOW);
    const b = generateDecoyData(seededRng(2), NOW);
    expect(a.rooms.map(r => r.groupId)).not.toEqual(
      b.rooms.map(r => r.groupId),
    );
  });
});

describe('writeDecoy — the room, column for column', () => {
  function roomInserts(decoy: FakeDb, table: string): [string, unknown[]][] {
    return decoy.execute.mock.calls
      .filter(c => String(c[0]).includes(`INTO ${table}`))
      .map(c => [String(c[0]), c[1] as unknown[]]);
  }

  test('writes the four tables and the thread with the real columns populated', async () => {
    const data = generateDecoyData(seededRng(3), NOW);
    expect(data.rooms.length).toBeGreaterThanOrEqual(1); // the fixture can fail
    await writeDecoy(data, me);
    const decoy = sqlite.instances.get('tacendum-decoy.sqlite')!;

    const groups = roomInserts(decoy, 'groups');
    expect(groups.length).toBe(data.rooms.length);
    const roomIds = new Set<string>();
    for (const [sql, params] of groups) {
      for (const column of ['groupId', 'ownerId', 'name']) {
        expect(sql).toContain(column);
      }
      const [groupId, ownerId, name] = params as [string, string, string];
      expect(groupId).toMatch(ULID);
      expect(ownerId).toMatch(ULID);
      expect(String(name).trim().length).toBeGreaterThan(0);
      roomIds.add(groupId);
    }
    const ownerOf = new Map(
      groups.map(([, p]) => [p[0] as string, p[1] as string]),
    );

    const members = roomInserts(decoy, 'group_members');
    expect(members.length).toBeGreaterThan(0);
    for (const [sql, params] of members) {
      for (const column of [
        'groupId',
        'memberId',
        'writerId',
        'seq',
        'state',
        'updatedAt',
      ]) {
        expect(sql).toContain(column);
      }
      const [groupId, memberId, writerId, seq, state, updatedAt] = params as [
        string,
        string,
        string,
        number,
        string,
        number,
      ];
      expect(roomIds.has(groupId)).toBe(true);
      expect(memberId).toMatch(ULID);
      // The two-lane structure, resolved to REAL ids: the writer is the
      // room's owner or the member themself, nobody else, ever.
      expect([ownerOf.get(groupId), memberId]).toContain(writerId);
      expect(seq).toBeGreaterThanOrEqual(1);
      expect(['in', 'out']).toContain(state);
      expect(updatedAt).toBeLessThanOrEqual(NOW);
    }
    // Every room's roster includes me, and the owner's merged row exists.
    for (const groupId of roomIds) {
      const rows = members.filter(([, p]) => p[0] === groupId);
      expect(rows.some(([, p]) => p[1] === me.userId)).toBe(true);
      const owner = ownerOf.get(groupId)!;
      expect(
        rows.filter(([, p]) => p[1] === owner && p[2] === owner),
      ).toHaveLength(1);
    }

    for (const [sql, params] of roomInserts(decoy, 'group_settings')) {
      for (const column of ['groupId', 'writerId', 'seq', 'disappearSec']) {
        expect(sql).toContain(column);
      }
      expect(roomIds.has(params[0] as string)).toBe(true);
    }
    for (const [sql, params] of roomInserts(decoy, 'group_counters')) {
      for (const column of ['groupId', 'scope', 'seq']) {
        expect(sql).toContain(column);
      }
      expect(roomIds.has(params[0] as string)).toBe(true);
      expect(['writer', 'msg']).toContain(params[1] as string);
    }

    // The thread: every room row is attributed; speech rows carry the
    // `${authorId}.${m}` key and the author's own sq; machinery rows are
    // parseable grp.* envelopes exactly as the receive path stores them.
    const messageRows = roomInserts(decoy, 'messages')
      .filter(([, p]) => roomIds.has(p[1] as string));
    expect(messageRows.length).toBeGreaterThan(0);
    let speech = 0;
    for (const [sql, params] of messageRows) {
      expect(sql).toContain('authorId');
      expect(sql).toContain('sq');
      const [msgId, , direction, body, ts, status, authorId, sq] = params as [
        string,
        string,
        string,
        string,
        number,
        string,
        string,
        number | null,
      ];
      expect(authorId).toMatch(ULID);
      expect(direction).toBe(authorId === me.userId ? 'out' : 'in');
      expect(status).toBe(direction === 'out' ? 'delivered' : 'received');
      expect(ts).toBeLessThanOrEqual(NOW);
      if (String(body).startsWith('{"tcm":"grp.')) {
        // Machinery: mine parent to `${selfId}.${id}` with sq = the write's
        // n; everyone else's carry the bare wire id and no sq.
        if (direction === 'out') {
          expect(msgId.startsWith(`${me.userId}.`)).toBe(true);
          expect(sq).toBeGreaterThanOrEqual(1);
        } else {
          expect(msgId).toMatch(ULID);
          expect(sq).toBeNull();
        }
      } else {
        speech++;
        expect(msgId.startsWith(`${authorId}.`)).toBe(true);
        expect(msgId.slice(authorId.length + 1)).toMatch(ULID);
        expect(sq).toBeGreaterThanOrEqual(1);
      }
    }
    expect(speech).toBeGreaterThan(0);

    // The conversation rows: kind='group', a groupName, createdAt at the
    // room's start — before every message of the thread.
    const chatRows = roomInserts(decoy, 'chats')
      .filter(([sql]) => sql.includes('kind'));
    expect(chatRows.length).toBe(data.rooms.length);
    for (const [sql, params] of chatRows) {
      expect(sql).toContain(`'group'`);
      expect(sql).toContain('groupName');
      expect(sql).toContain('createdAt');
      const [groupId, lastMessageAt, lastMessageText, createdAt, groupName] =
        params as [string, number, string, number, string];
      expect(roomIds.has(groupId)).toBe(true);
      expect(String(groupName).trim().length).toBeGreaterThan(0);
      expect(String(lastMessageText).length).toBeGreaterThan(0);
      expect(createdAt).toBeLessThan(lastMessageAt);
      for (const [, p] of messageRows) {
        if (p[1] === groupId) expect(createdAt).toBeLessThanOrEqual(p[4] as number);
      }
    }
  });

  test('clears the four room tables before rebuilding — named, like vault_items', async () => {
    await writeDecoy(generateDecoyData(seededRng(4), NOW), me);
    const decoy = sqlite.instances.get('tacendum-decoy.sqlite')!;
    const statements = decoy.execute.mock.calls.map(c => String(c[0]));
    const deletes = statements.filter(s => s.startsWith('DELETE FROM'));
    const firstInsert = statements.findIndex(s => s.startsWith('INSERT'));
    for (const table of [
      'groups',
      'group_members',
      'group_settings',
      'group_counters',
    ]) {
      const at = statements.indexOf(`DELETE FROM ${table}`);
      expect(deletes).toContain(`DELETE FROM ${table}`);
      // Cleared BEFORE anything lands: a decoy rebuild must never inherit
      // the previous decoy's rooms, let alone anything else's.
      expect(at).toBeGreaterThanOrEqual(0);
      expect(at).toBeLessThan(firstInsert);
    }
  });
});

describe('isolation — the two workspace files never share a room', () => {
  test('fabrication opens only the decoy file; a seeded real workspace is never read or written', async () => {
    const real: FakeDb = {
      name: 'tacendum.sqlite',
      execute: jest.fn(async () => ({
        rows: [{ groupId: 'REAL_ROOM_CANARY', ownerId: 'REAL_OWNER_CANARY' }],
      })),
      close: jest.fn(),
    };
    sqlite.instances.set('tacendum.sqlite', real);

    await writeDecoy(generateDecoyData(seededRng(5), NOW), me);

    expect(sqlite.opened).toEqual(['tacendum-decoy.sqlite']);
    expect(real.execute).not.toHaveBeenCalled();
    const decoy = sqlite.instances.get('tacendum-decoy.sqlite')!;
    const everything = decoy.execute.mock.calls
      .map(c => JSON.stringify(c))
      .join('\n');
    expect(everything).not.toContain('REAL_ROOM_CANARY');
    expect(everything).not.toContain('REAL_OWNER_CANARY');
  });

  test('a real-workspace room write reaches only the real file', async () => {
    await db.initDb();
    const store = await db.loadGroupStore('01REALROOM0000000000000000');
    store.setOwner('01REALOWNER000000000000000');
    store.putSlot({
      memberId: '01REALMEMBER00000000000000',
      writerId: '01REALOWNER000000000000000',
      seq: 1,
      state: 'in',
    });
    store.setPresent(true);
    await store.persist();

    expect(sqlite.opened).toEqual(['tacendum.sqlite']);
    expect(sqlite.instances.has('tacendum-decoy.sqlite')).toBe(false);
    const real = sqlite.instances.get('tacendum.sqlite')!;
    const statements = real.execute.mock.calls.map(c => String(c[0]));
    expect(statements.some(s => s.includes('INTO group_members'))).toBe(true);
  });
});

describe('lifecycle — drift keeps the room; sign-out removes it', () => {
  test('refreshDecoyTimestamps drifts the roster clock and createdAt with the thread, and deletes nothing', async () => {
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

    const statements = decoy.execute.mock.calls.map(c => String(c[0]));
    // Named, not counted — the vault taught this lesson:
    // the roster's applied-at must move with the announcement rows, and the
    // room's createdAt with its accepted grp.new.
    expect(
      statements.some(s => s.includes('UPDATE group_members SET updatedAt')),
    ).toBe(true);
    expect(
      statements.some(s => s.includes('UPDATE chats SET createdAt')),
    ).toBe(true);
    for (const call of decoy.execute.mock.calls) {
      const sql = String(call[0]);
      expect(sql.startsWith('DELETE')).toBe(false);
      expect(sql.startsWith('DROP')).toBe(false);
      if (sql.startsWith('UPDATE')) {
        const delta = (call[1] as number[])[0];
        const shifted = stale + delta;
        expect(NOW - shifted).toBeGreaterThanOrEqual(10 * 60_000);
        expect(NOW - shifted).toBeLessThanOrEqual(120 * 60_000);
      }
    }
  });

  test('sign-out wipes the four room tables with everything else', async () => {
    // The wipe list itself (a table missing from DB_TABLES survives sign-out
    // and leaks rooms across a decoy rebuild)…
    for (const table of [
      'groups',
      'group_members',
      'group_settings',
      'group_counters',
    ]) {
      expect(db.DB_TABLES).toContain(table);
    }
    // …and the wipe actually issuing the deletes against the ACTIVE
    // workspace — in a duress session, the decoy file, so a duress sign-out
    // clears the fabricated room too. (That the rows actually go is proved
    // on the real engine in scripts/prove-db.mjs the design.)
    db.setWorkspace('decoy');
    await db.initDb();
    await db.clearLocalState();
    const decoy = sqlite.instances.get('tacendum-decoy.sqlite')!;
    const statements = decoy.execute.mock.calls.map(c => String(c[0]));
    for (const table of [
      'groups',
      'group_members',
      'group_settings',
      'group_counters',
    ]) {
      expect(statements).toContain(`DELETE FROM ${table}`);
    }
    await db.close();
    db.setWorkspace('real');
  });
});
