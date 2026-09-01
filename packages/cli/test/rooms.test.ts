import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'tacendum-rooms-'));
process.env.TACENDUM_HOME = home;

const { FileGroupStore, listRooms } = await import('../src/rooms.js');
const { applyGroupNew, applyRosterWrite, applyGroupDel, foldRoster, ownerOnlyPolicy } =
  await import('@tacendum/shared/group-fold');

// Crockford base32 — no I, L, O, U. An illegal letter would be filtered by
// the id guard and the test would be asserting about the filter instead.
const ROOM = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const ROOM2 = '01BQBBQBBQBBQBBQBBQBBQBBQB';
const ANA = '01CCCCCCCCCCCCCCCCCCCCCCCC';
const BEN = '01DDDDDDDDDDDDDDDDDDDDDDDD';
const CARA = '01EEEEEEEEEEEEEEEEEEEEEEEE';

const roomFile = (client: string, groupId: string): string =>
  join(home, 'state', client, 'rooms', `${groupId}.json`);

/**
 * The CLI's room state.
 *
 * What these tests are FOR: this store holds no rules, and that is the
 * property worth defending. Every decision about who may write what lives in
 * `@tacendum/shared/group-fold`, because two implementations of a convergence
 * rule is a divergence no protocol work can repair — and the app/CLI split is
 * exactly where one would hide. So the tests below drive the store through
 * the REAL apply functions rather than asserting on setters: if the store
 * ever started deciding something, the fold's verdict and the file would stop
 * agreeing, and that is what these would catch.
 */
describe('the CLI room store, behind the shared apply interface', () => {
  it('a room the client does not hold reports no owner — which is what the fold reads as absent', () => {
    const store = FileGroupStore.load('none', ROOM);
    expect(store.getOwner()).toBeUndefined();
    expect(store.listSlots()).toEqual([]);
  });

  it('accepting a grp.new through the REAL apply anchors the owner and lands the roster', () => {
    const store = FileGroupStore.load('accept', ROOM);
    const result = applyGroupNew(
      store,
      BEN,
      { writerId: ANA, members: [ANA, BEN, CARA], seq: 1 },
      ownerOnlyPolicy,
    );
    expect(result.outcome).toBe('accepted');
    store.setName('Kitchen');
    store.persist();

    // The anchor is frame.from, forever — never a payload field.
    expect(store.getOwner()).toBe(ANA);
    const fold = foldRoster(ANA, store.listSlots(), ownerOnlyPolicy);
    expect([...fold.members].sort()).toEqual([ANA, BEN, CARA].sort());

    // And it survives a reload, because a CLI process is not a phone that
    // keeps its state in memory between commands.
    const again = FileGroupStore.load('accept', ROOM);
    expect(again.getOwner()).toBe(ANA);
    expect(again.getName()).toBe('Kitchen');
    expect(
      [...foldRoster(ANA, again.listSlots(), ownerOnlyPolicy).members].sort(),
    ).toEqual([ANA, BEN, CARA].sort());
  });

  it('a NON-owner roster write is declined by the fold, and the store records nothing', () => {
    const store = FileGroupStore.load('declined', ROOM);
    applyGroupNew(store, BEN, { writerId: ANA, members: [ANA, BEN], seq: 1 }, ownerOnlyPolicy);
    const before = store.listSlots().length;

    // Cara is not the owner and is writing about someone else: the one thing
    // the owner-only policy exists to refuse. The store must not "helpfully"
    // store it anyway — the whole design is that this file keeps no opinion.
    const result = applyRosterWrite(
      store,
      BEN,
      { memberId: BEN, writerId: CARA, seq: 9, state: 'out' },
      ownerOnlyPolicy,
    );
    expect(result.outcome).toBe('declined');
    expect(store.listSlots().length).toBe(before);
    expect(foldRoster(ANA, store.listSlots(), ownerOnlyPolicy).members).toContain(BEN);
  });

  it('persist is the ONLY write: an apply that throws mid-way leaves the file untouched', () => {
    const store = FileGroupStore.load('atomic', ROOM);
    applyGroupNew(store, BEN, { writerId: ANA, members: [ANA, BEN], seq: 1 }, ownerOnlyPolicy);
    store.persist();
    const onDisk = readFileSync(roomFile('atomic', ROOM), 'utf8');

    // Mutate in memory and never persist — the CLI has no transaction to roll
    // back, so "load, mutate, write once" is how it reaches the guarantee the
    // app gets from SQLite.
    const live = FileGroupStore.load('atomic', ROOM);
    live.putSlot({ memberId: CARA, writerId: ANA, seq: 5, state: 'in' });
    live.setName('never written');
    expect(readFileSync(roomFile('atomic', ROOM), 'utf8')).toBe(onDisk);
  });

  it('a counted grp.del purges the room and removes the file — twice, without throwing', () => {
    const store = FileGroupStore.load('purge', ROOM);
    applyGroupNew(store, BEN, { writerId: ANA, members: [ANA, BEN], seq: 1 }, ownerOnlyPolicy);
    store.persist();
    expect(existsSync(roomFile('purge', ROOM))).toBe(true);

    const first = FileGroupStore.load('purge', ROOM);
    expect(applyGroupDel(first, { writerId: ANA, seq: 2 })).toBe('purged');
    first.persist();
    expect(existsSync(roomFile('purge', ROOM))).toBe(false);

    // Later traffic for a purged room is discarded QUIETLY. A replayed
    // grp.del reaching a room that is already gone must not throw — a crash
    // here would turn a straggler frame into a broken client.
    const second = FileGroupStore.load('purge', ROOM);
    second.clear();
    expect(() => second.persist()).not.toThrow();
  });

  it('one unreadable slot is dropped; the rest of the room survives', () => {
    // Plain JSON in a directory a user can edit. Losing a whole room to one
    // bad line is the worse outcome, so the file is strict and the slots are
    // permissive — and a mangled slot must never reach the fold wearing
    // valid types.
    mkdirSync(join(home, 'state', 'salvage', 'rooms'), { recursive: true });
    writeFileSync(
      roomFile('salvage', ROOM),
      JSON.stringify({
        ownerId: ANA,
        name: 'Kitchen',
        present: true,
        slots: [
          { memberId: BEN, writerId: ANA, seq: 1, state: 'in' },
          { memberId: 'not-a-ulid', writerId: ANA, seq: 2, state: 'in' },
          { memberId: CARA, writerId: ANA, seq: 3, state: 'sideways' },
        ],
        settings: [],
      }),
    );
    const store = FileGroupStore.load('salvage', ROOM);
    expect(store.getOwner()).toBe(ANA);
    expect(store.listSlots()).toEqual([
      { memberId: BEN, writerId: ANA, seq: 1, state: 'in' },
    ]);
  });

  it('a corrupt file reads as a room the client does not hold, rather than crashing', () => {
    mkdirSync(join(home, 'state', 'corrupt', 'rooms'), { recursive: true });
    writeFileSync(roomFile('corrupt', ROOM), 'this is not json{{{');
    const store = FileGroupStore.load('corrupt', ROOM);
    expect(store.getOwner()).toBeUndefined();
  });

  it('a group id that is not a ULID never reaches the filesystem', () => {
    // Group ids arrive from the wire. `../` in one would be a write outside
    // the state compartment, so the id is refused before it is interpolated.
    expect(() => FileGroupStore.load('evil', '../../etc/passwd')).toThrow(/not a room id/);
    expect(() => FileGroupStore.load('evil', '')).toThrow(/not a room id/);
  });

  it('listRooms reports only rooms whose anchor actually landed', () => {
    const held = FileGroupStore.load('listing', ROOM);
    applyGroupNew(held, BEN, { writerId: ANA, members: [ANA, BEN], seq: 1 }, ownerOnlyPolicy);
    held.setName('Kitchen');
    held.persist();

    // A file with no owner is a room this client does not hold — listing it
    // would offer the user a room they cannot act on.
    mkdirSync(join(home, 'state', 'listing', 'rooms'), { recursive: true });
    writeFileSync(
      roomFile('listing', ROOM2),
      JSON.stringify({ name: 'ghost', present: true, slots: [], settings: [] }),
    );

    expect(listRooms('listing')).toEqual([
      { groupId: ROOM, ownerId: ANA, name: 'Kitchen', present: true },
    ]);
    expect(listRooms('nobody')).toEqual([]);
  });

  it('a local delete keeps the anchor and the slots; only presence goes', () => {
    const store = FileGroupStore.load('localdel', ROOM);
    applyGroupNew(store, BEN, { writerId: ANA, members: [ANA, BEN], seq: 1 }, ownerOnlyPolicy);
    store.persist();

    const local = FileGroupStore.load('localdel', ROOM);
    local.setPresent(false);
    local.persist();

    // The room's state outlives its content, so later traffic can recreate
    // the conversation — the precedent deleteChat already sets. A local
    // delete that dropped the slots would silently re-join on the next frame
    // with a roster it no longer had.
    const after = FileGroupStore.load('localdel', ROOM);
    expect(after.isPresent()).toBe(false);
    expect(after.getOwner()).toBe(ANA);
    expect(after.listSlots().length).toBeGreaterThan(0);
  });
});
