import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const home = mkdtempSync(join(tmpdir(), 'tacendum-rooms-cmd-'));
process.env.TACENDUM_HOME = home;

const { cmdRoom } = await import('../src/room-commands.js');
type RoomDelivery = import('../src/room-commands.js').RoomDelivery;
type FanoutLeg = import('../src/send.js').FanoutLeg;
const { FileGroupStore, listRooms } = await import('../src/rooms.js');
const { saveProfile } = await import('../src/profile.js');
const { Reporter } = await import('../src/output.js');
const { CliError, EXIT } = await import('../src/exit.js');
const { stateDir } = await import('../src/config.js');
const {
  applyGroupNew,
  applyRosterWrite,
  foldRoster,
  ownerOnlyPolicy,
  rosterDigest,
  verdictFor,
} = await import('@tacendum/shared/group-fold');

/**
 * THE ROOM SURFACE, tested against REAL FILES and the
 * REAL shared apply layer — no mocked store, because `rooms.ts` writes actual
 * JSON and asserting against it is what proves the commands and the app share
 * one implementation of the rules rather than two that happen to agree today.
 * The only injected seam is the transport (`RoomDelivery`), which is exactly
 * the seam production injects too.
 *
 * The receiving side of each exchange is simulated the way the inbound path
 * performs it: `applyGroupNew` / `applyRosterWrite` against that client's own
 * store — the identical calls, because that is the entire one-implementation claim.
 */

const ANA = '01ANAANAANAANAANAANAANAANA';
const BEN = '01BENBENBENBENBENBENBENBEN';
const CARA = '01CARACARACARACARACARACARA';
const DAN = '01DANDANDANDANDANDANDANDAN';

for (const [name, userId] of [
  ['ana', ANA],
  ['ben', BEN],
  ['cara', CARA],
] as const) {
  saveProfile({
    name,
    identityKey: 'test-key',
    userId,
    authToken: 'test-token',
    registrationId: 1,
    deviceId: 1,
  });
}

/** A distinct legal ULID per index, for cap tests. */
function memberId(i: number): string {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  return `01MMMMMMMMMMMMMMMMMMMMMMM${alphabet[i] as string}`;
}

/** Transport stub: records every fan-out, answers "delivered" for each leg. */
function recordingDeliver(captured: FanoutLeg[][]): RoomDelivery {
  return (async ({ legs }: { legs: FanoutLeg[] }) => {
    captured.push(legs);
    return legs.map(l => ({ to: l.to, msgId: l.msgId, state: 'delivered' as const }));
  }) as RoomDelivery;
}

/** A transport that must never be reached. */
const forbiddenDeliver: RoomDelivery = (async () => {
  throw new Error('the transport was reached for a write that must not send');
}) as RoomDelivery;

/** Run one room command with a JSON reporter, capturing stdout records. */
async function runRoom(
  argv: string[],
  deliver: RoomDelivery,
): Promise<{ code: number; out: Record<string, unknown>[] }> {
  const writes: string[] = [];
  const spy = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
  try {
    const code = await cmdRoom(argv, new Reporter({ json: true, plain: true }), deliver);
    const out = writes
      .join('')
      .split('\n')
      .filter(line => line.trim() !== '')
      .map(line => JSON.parse(line) as Record<string, unknown>);
    return { code, out };
  } finally {
    spy.mockRestore();
  }
}

function roomFile(account: string, groupId: string): string {
  return join(stateDir(account), 'rooms', `${groupId}.json`);
}

function parseBody(leg: FanoutLeg): Record<string, unknown> {
  return JSON.parse(leg.body) as Record<string, unknown>;
}

const nodeSha = (pre: Uint8Array): Uint8Array => createHash('sha256').update(pre).digest();

/** Seed a client's store the way inbound seeds it: the real apply layer. */
function receiveGroupNew(
  account: string,
  selfId: string,
  groupId: string,
  ownerId: string,
  members: string[],
  seq = 1,
): void {
  const store = FileGroupStore.load(account, groupId);
  applyGroupNew(store, selfId, { writerId: ownerId, members, seq }, ownerOnlyPolicy);
  store.setName('Kitchen');
  store.persist();
}

async function createRoomAsAna(captured: FanoutLeg[][] = []): Promise<string> {
  const { code } = await runRoom(
    ['create', 'ana', 'Kitchen', BEN, CARA],
    recordingDeliver(captured),
  );
  expect(code).toBe(EXIT.OK);
  const rooms = listRooms('ana');
  const created = rooms[rooms.length - 1];
  if (created === undefined) throw new Error('create left no room behind');
  return created.groupId;
}

describe('room create', () => {
  it('anchors through applyGroupNew and fans one grp.new per invited member', async () => {
    const captured: FanoutLeg[][] = [];
    const gid = await createRoomAsAna(captured);

    // The store, as the SHARED layer folded it: Ana is the owner because she
    // is the writerId of the accepted grp.new, and she is IN from the clamp.
    const store = FileGroupStore.load('ana', gid);
    expect(store.getOwner()).toBe(ANA);
    expect(store.getName()).toBe('Kitchen');
    expect(store.isPresent()).toBe(true);
    const fold = foldRoster(ANA, store.listSlots(), ownerOnlyPolicy);
    expect(fold.members).toEqual([ANA, BEN, CARA].sort());

    // One leg per member, none to self, each body the SAME validated grp.new.
    expect(captured).toHaveLength(1);
    const legs = captured[0] as FanoutLeg[];
    expect(legs.map(l => l.to).sort()).toEqual([BEN, CARA].sort());
    for (const leg of legs) {
      expect(parseBody(leg)).toMatchObject({
        tcm: 'grp.new',
        g: gid,
        nm: 'Kitchen',
        ms: [ANA, BEN, CARA],
        n: 1,
      });
      // CSPRNG wire ids at the surface: ULID-shaped, first char 0-7.
      expect(leg.msgId).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
    }
  });

  it('clamps the creator out of the member arguments rather than double-seating them', async () => {
    const captured: FanoutLeg[][] = [];
    const { code } = await runRoom(
      ['create', 'ana', 'Selfie', ANA, BEN],
      recordingDeliver(captured),
    );
    expect(code).toBe(EXIT.OK);
    // Ana is in ms exactly once and gets no leg.
    const legs = captured[0] as FanoutLeg[];
    expect(legs.map(l => l.to)).toEqual([BEN]);
    expect((parseBody(legs[0] as FanoutLeg) as { ms: string[] }).ms).toEqual([ANA, BEN]);
  });

  it('refuses a roster past GROUP_MAX_MEMBERS before anything is anchored or sent', async () => {
    const before = listRooms('ana').length;
    const twelve = Array.from({ length: 12 }, (_, i) => memberId(i));
    await expect(
      runRoom(['create', 'ana', 'Crowd', ...twelve], forbiddenDeliver),
    ).rejects.toMatchObject({ exitCode: EXIT.USAGE });
    expect(listRooms('ana').length).toBe(before);
  });
});

describe('answering an invitation (the shared apply layer, not a screen handler)', () => {
  it('accept writes MY sovereign `in` slot and fans it to the folded members', async () => {
    const gid = await createRoomAsAna();
    receiveGroupNew('ben', BEN, gid, ANA, [ANA, BEN, CARA]);

    const captured: FanoutLeg[][] = [];
    const { code } = await runRoom(['accept', 'ben', gid], recordingDeliver(captured));
    expect(code).toBe(EXIT.OK);

    // The durable evidence of the answer IS the sovereign slot — the same
    // fact `room show` reports as "answered".
    const store = FileGroupStore.load('ben', gid);
    expect(store.getSlot(BEN, BEN)).toMatchObject({ memberId: BEN, writerId: BEN, state: 'in' });

    const legs = captured[0] as FanoutLeg[];
    expect(legs.map(l => l.to).sort()).toEqual([ANA, CARA].sort());
    for (const leg of legs) {
      expect(parseBody(leg)).toMatchObject({ tcm: 'grp.roster', g: gid, m: BEN, s: 'in' });
    }
  });

  it('decline writes MY sovereign `out`, hides the room, and every store folding it drops me', async () => {
    const gid = await createRoomAsAna();
    receiveGroupNew('cara', CARA, gid, ANA, [ANA, BEN, CARA]);

    const captured: FanoutLeg[][] = [];
    const { code } = await runRoom(['decline', 'cara', gid], recordingDeliver(captured));
    expect(code).toBe(EXIT.OK);

    const store = FileGroupStore.load('cara', gid);
    expect(store.getSlot(CARA, CARA)).toMatchObject({ state: 'out' });
    expect(store.isPresent()).toBe(false);

    const legs = captured[0] as FanoutLeg[];
    expect(legs.map(l => l.to).sort()).toEqual([ANA, BEN].sort());
    const body = parseBody(legs[0] as FanoutLeg) as { m: string; s: string; n: number };
    expect(body).toMatchObject({ tcm: 'grp.roster', g: gid, m: CARA, s: 'out' });

    // Convergence through the REAL apply layer: Ana's store receives Cara's
    // write exactly as inbound applies it, and Cara folds out — sovereign,
    // so not even the owner could undo it.
    const ana = FileGroupStore.load('ana', gid);
    const applied = applyRosterWrite(
      ana,
      ANA,
      { memberId: CARA, writerId: CARA, seq: body.n, state: 'out' },
      ownerOnlyPolicy,
    );
    expect(applied).toMatchObject({ outcome: 'applied', lane: 'self' });
    expect(
      verdictFor(foldRoster(ANA, ana.listSlots(), ownerOnlyPolicy), CARA),
    ).toBe('out');
  });

  it('refuses to answer for a room this client does not hold', async () => {
    await expect(
      runRoom(['accept', 'ben', '01ZZZZZZZZZZZZZZZZZZZZZZZZ'], forbiddenDeliver),
    ).rejects.toMatchObject({ exitCode: EXIT.USAGE });
  });
});

describe('roster changes go through applyRosterWrite — the CLI holds no rules', () => {
  it("a non-owner's add is DECLINED by the apply layer: nothing stored, nothing sent, exit REFUSED", async () => {
    const gid = await createRoomAsAna();
    receiveGroupNew('ben', BEN, gid, ANA, [ANA, BEN, CARA]);
    const before = readFileSync(roomFile('ben', gid), 'utf8');

    await expect(
      runRoom(['add', 'ben', gid, DAN], forbiddenDeliver),
    ).rejects.toMatchObject({ exitCode: EXIT.REFUSED });
    // Byte-identical store: a declined write is not room traffic.
    expect(readFileSync(roomFile('ben', gid), 'utf8')).toBe(before);
  });

  it("the owner's add of a BRAND-NEW member carries the room to them (grp.new) and the write to everyone else", async () => {
    const captured: FanoutLeg[][] = [];
    const gid = await createRoomAsAna();

    const { code } = await runRoom(['add', 'ana', gid, DAN], recordingDeliver(captured));
    expect(code).toBe(EXIT.OK);

    const legs = captured[captured.length - 1] as FanoutLeg[];
    expect(legs.map(l => l.to).sort()).toEqual([BEN, CARA, DAN].sort());
    const danLeg = legs.find(l => l.to === DAN) as FanoutLeg;
    // A bare authority write with no anchor is DROPPED on arrival and
    // an Add's healing write never comes — so the new member's leg must be
    // the room itself, at the same n.
    expect(parseBody(danLeg)).toMatchObject({
      tcm: 'grp.new',
      g: gid,
      nm: 'Kitchen',
      n: 2,
    });
    expect((parseBody(danLeg) as { ms: string[] }).ms).toContain(DAN);
    for (const leg of legs.filter(l => l.to !== DAN)) {
      expect(parseBody(leg)).toMatchObject({ tcm: 'grp.roster', g: gid, m: DAN, s: 'in', n: 2 });
    }
    // And the owner's own store folds them in — via the shared layer.
    const store = FileGroupStore.load('ana', gid);
    expect(verdictFor(foldRoster(ANA, store.listSlots(), ownerOnlyPolicy), DAN)).toBe('in');
  });

  it('a re-added leaver gets the bare roster write, and their sovereign out still wins the fold', async () => {
    const captured: FanoutLeg[][] = [];
    const gid = await createRoomAsAna();
    // Ben's sovereign departure, applied as inbound applies it.
    const ana = FileGroupStore.load('ana', gid);
    applyRosterWrite(
      ana,
      ANA,
      { memberId: BEN, writerId: BEN, seq: 5, state: 'out' },
      ownerOnlyPolicy,
    );
    ana.persist();

    const { code } = await runRoom(['add', 'ana', gid, BEN], recordingDeliver(captured));
    expect(code).toBe(EXIT.OK);
    const legs = captured[captured.length - 1] as FanoutLeg[];
    const benLeg = legs.find(l => l.to === BEN) as FanoutLeg;
    // He HAS slots, so no grp.new: rejoin semantics — the invitation back.
    expect(parseBody(benLeg)).toMatchObject({ tcm: 'grp.roster', m: BEN, s: 'in' });
    // And the CLI did not overrule the fold: only Ben's own `in` readmits him.
    const after = FileGroupStore.load('ana', gid);
    expect(verdictFor(foldRoster(ANA, after.listSlots(), ownerOnlyPolicy), BEN)).toBe('out');
  });

  it('remove fans to the REMOVED member too — never a silent omission', async () => {
    const captured: FanoutLeg[][] = [];
    const gid = await createRoomAsAna();

    const { code } = await runRoom(['remove', 'ana', gid, BEN], recordingDeliver(captured));
    expect(code).toBe(EXIT.OK);
    const legs = captured[captured.length - 1] as FanoutLeg[];
    expect(legs.map(l => l.to).sort()).toEqual([BEN, CARA].sort());
    const store = FileGroupStore.load('ana', gid);
    expect(verdictFor(foldRoster(ANA, store.listSlots(), ownerOnlyPolicy), BEN)).toBe('out');
  });

  it('leave is my sovereign out, fanned to the members who remain', async () => {
    const gid = await createRoomAsAna();
    receiveGroupNew('ben', BEN, gid, ANA, [ANA, BEN, CARA]);

    const captured: FanoutLeg[][] = [];
    const { code } = await runRoom(['leave', 'ben', gid], recordingDeliver(captured));
    expect(code).toBe(EXIT.OK);
    const store = FileGroupStore.load('ben', gid);
    expect(store.getSlot(BEN, BEN)).toMatchObject({ state: 'out' });
    expect(verdictFor(foldRoster(ANA, store.listSlots(), ownerOnlyPolicy), BEN)).toBe('out');
    const legs = captured[0] as FanoutLeg[];
    expect(legs.map(l => l.to).sort()).toEqual([ANA, CARA].sort());
  });
});

describe('room delete — the two acts', () => {
  it('local delete hides the conversation, keeps the state, sends nothing', async () => {
    const gid = await createRoomAsAna();
    const { code } = await runRoom(['delete', 'ana', gid], forbiddenDeliver);
    expect(code).toBe(EXIT.OK);
    const store = FileGroupStore.load('ana', gid);
    expect(store.isPresent()).toBe(false);
    expect(store.getOwner()).toBe(ANA); // the anchor survives its content
    expect(existsSync(roomFile('ana', gid))).toBe(true);
  });

  it("a NON-owner's --everyone is declined by applyGroupDel: file intact, nothing sent, exit REFUSED", async () => {
    const gid = await createRoomAsAna();
    receiveGroupNew('ben', BEN, gid, ANA, [ANA, BEN, CARA]);
    const before = readFileSync(roomFile('ben', gid), 'utf8');

    await expect(
      runRoom(['delete', 'ben', gid, '--everyone'], forbiddenDeliver),
    ).rejects.toMatchObject({ exitCode: EXIT.REFUSED });
    expect(readFileSync(roomFile('ben', gid), 'utf8')).toBe(before);
  });

  it("the owner's --everyone purges the store whole and fans one grp.del per member", async () => {
    const captured: FanoutLeg[][] = [];
    const gid = await createRoomAsAna();

    const { code } = await runRoom(['delete', 'ana', gid, '--everyone'], recordingDeliver(captured));
    expect(code).toBe(EXIT.OK);
    // The FULL purge: a purged room leaves no file.
    expect(existsSync(roomFile('ana', gid))).toBe(false);
    expect(listRooms('ana').some(r => r.groupId === gid)).toBe(false);

    const legs = captured[captured.length - 1] as FanoutLeg[];
    expect(legs.map(l => l.to).sort()).toEqual([BEN, CARA].sort());
    for (const leg of legs) {
      expect(parseBody(leg)).toMatchObject({ tcm: 'grp.del', g: gid });
    }
  });
});

describe('room send — the fan-out', () => {
  it('one grp.msg per folded member through the transport, one m for all legs, a correct rd', async () => {
    const gid = await createRoomAsAna();
    receiveGroupNew('ben', BEN, gid, ANA, [ANA, BEN, CARA]);

    const captured: FanoutLeg[][] = [];
    const { code, out } = await runRoom(
      ['send', 'ben', gid, 'hello rooms'],
      recordingDeliver(captured),
    );
    expect(code).toBe(EXIT.OK);

    const legs = captured[0] as FanoutLeg[];
    expect(legs.map(l => l.to).sort()).toEqual([ANA, CARA].sort());

    const bodies = legs.map(parseBody) as { tcm: string; g: string; m: string; rd: string; sq: number; b: string }[];
    for (const body of bodies) {
      expect(body.tcm).toBe('grp.msg');
      expect(body.g).toBe(gid);
      expect(body.b).toBe('hello rooms');
      expect(body.sq).toBe(1);
    }
    // `m` minted ONCE for all legs — it is what makes a future
    // reaction or edit mean the same thing on every phone.
    expect(new Set(bodies.map(b => b.m)).size).toBe(1);
    // `rd` is the digest of THIS sender's folded roster state — owner first,
    // then members ascending — computed by the one shared implementation.
    const store = FileGroupStore.load('ben', gid);
    const fold = foldRoster(ANA, store.listSlots(), ownerOnlyPolicy);
    expect(bodies[0]?.rd).toBe(rosterDigest(ANA, fold.members, nodeSha));

    // Per-leg wire-id visibility under --json (DoD item 5: the e2e asserts
    // the prefix property over the real wire, and this record is how).
    const emitted = out[out.length - 1] as { legs?: { to: string; msgId: string }[] };
    expect(emitted.legs?.map(l => l.msgId).sort()).toEqual(legs.map(l => l.msgId).sort());
  });

  it('sq increments per (author, room) across sends', async () => {
    const gid = await createRoomAsAna();
    receiveGroupNew('ben', BEN, gid, ANA, [ANA, BEN, CARA]);

    const captured: FanoutLeg[][] = [];
    await runRoom(['send', 'ben', gid, 'one'], recordingDeliver(captured));
    await runRoom(['send', 'ben', gid, 'two'], recordingDeliver(captured));
    const first = parseBody((captured[0] as FanoutLeg[])[0] as FanoutLeg) as { sq: number };
    const second = parseBody((captured[1] as FanoutLeg[])[0] as FanoutLeg) as { sq: number };
    expect(first.sq).toBe(1);
    expect(second.sq).toBe(2);
  });

  it('refuses to send when the FOLD says this client is out — the verdict is the shared layer’s', async () => {
    const gid = await createRoomAsAna();
    receiveGroupNew('ben', BEN, gid, ANA, [ANA, BEN, CARA]);
    await runRoom(['leave', 'ben', gid], recordingDeliver([]));

    await expect(
      runRoom(['send', 'ben', gid, 'still here?'], forbiddenDeliver),
    ).rejects.toMatchObject({ exitCode: EXIT.REFUSED });
  });

  it('refuses a room this client does not hold, and never echoes a malformed room id', async () => {
    await expect(
      runRoom(['send', 'ana', '01YYYYYYYYYYYYYYYYYYYYYYYY', 'hi'], forbiddenDeliver),
    ).rejects.toMatchObject({ exitCode: EXIT.USAGE });

    const canary = 'hunter2-secret-value';
    try {
      await runRoom(['send', 'ana', canary, 'hi'], forbiddenDeliver);
      expect.unreachable('a malformed room id must refuse');
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as Error).message).not.toContain(canary);
      expect((err as CliError).exitCode).toBe(EXIT.USAGE);
    }
  });
});

describe('room list and show read the fold, not a second bookkeeping', () => {
  it('show reports the folded members, the owner, and whether the invitation was answered', async () => {
    const gid = await createRoomAsAna();
    receiveGroupNew('ben', BEN, gid, ANA, [ANA, BEN, CARA]);

    const unanswered = await runRoom(['show', 'ben', gid], forbiddenDeliver);
    expect(unanswered.out[0]).toMatchObject({
      groupId: gid,
      ownerId: ANA,
      you: 'in',
      answered: false,
      members: [ANA, BEN, CARA].sort(),
    });

    await runRoom(['accept', 'ben', gid], recordingDeliver([]));
    const answered = await runRoom(['show', 'ben', gid], forbiddenDeliver);
    expect(answered.out[0]).toMatchObject({ answered: true });
  });

  it('show annotates people with stored names — ids first, names as the contacts-style suffix', async () => {
    const gid = await createRoomAsAna();
    receiveGroupNew('ben', BEN, gid, ANA, [ANA, BEN, CARA]);
    const { FileStores } = await import('../src/stores.js');
    new FileStores('ben').setPeerName(ANA, 'Ana Owner');

    // Human mode, not JSON: the annotation is a reading nicety and the JSON
    // shape above deliberately does not carry it.
    const writes: string[] = [];
    const spy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: unknown) => {
        writes.push(String(chunk));
        return true;
      });
    try {
      await cmdRoom(
        ['show', 'ben', gid],
        new Reporter({ json: false, plain: true }),
        forbiddenDeliver,
      );
    } finally {
      spy.mockRestore();
    }
    const text = writes.join('');
    // Named: the id stays primary (the copy-pasteable command argument).
    expect(text).toContain(`${ANA}  "Ana Owner"  (owner)`);
    // Unnamed: the bare id, exactly as before.
    expect(text).toContain(`  ${CARA}\n`);
  });

  it('list shows present rooms only', async () => {
    const gid = await createRoomAsAna();
    const before = await runRoom(['list', 'ana'], forbiddenDeliver);
    expect(before.out.some(r => r.groupId === gid)).toBe(true);
    await runRoom(['delete', 'ana', gid], forbiddenDeliver);
    const after = await runRoom(['list', 'ana'], forbiddenDeliver);
    expect(after.out.some(r => r.groupId === gid)).toBe(false);
  });
});
