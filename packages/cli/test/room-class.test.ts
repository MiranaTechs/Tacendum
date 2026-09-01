import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const home = mkdtempSync(join(tmpdir(), 'tacendum-room-class-'));
process.env.TACENDUM_HOME = home;

const { cmdRoom, roomAgentAuthorIds } = await import('../src/room-commands.js');
type RoomDelivery = import('../src/room-commands.js').RoomDelivery;
type FanoutLeg = import('../src/send.js').FanoutLeg;
const { FileGroupStore, listRooms } = await import('../src/rooms.js');
const { FileStores } = await import('../src/stores.js');
const { MessageLog } = await import('../src/msglog.js');
const { saveProfile } = await import('../src/profile.js');
const { Reporter } = await import('../src/output.js');
const { applyGroupNew, foldRoster, ownerOnlyPolicy } = await import(
  '@tacendum/shared/group-fold'
);

/**
 * ROSTER-WRITE CARRIES CLASS, CLI writer + consumer half.
 *
 * WRITER (owner only): `room create` and an owner's `room add` set the class
 * for a member the owner's OWN records name an integration — the adopt record
 * (`machine-peers.json`, the app's machine_peers pattern) or a same-home
 * profile whose accountClass is 'integration'. A member the CLI cannot know
 * simply gets no field: absent is safe. Non-owner writes NEVER emit class.
 *
 * CONSUMERS: `roomAgentAuthorIds` becomes marker-record ∨ fold-class, so the
 * The agent-leg exclusion no longer waits for the agent to have spoken; `room show`
 * names the class on the roster line — the anonymous-row defect.
 */

const OWNER = '01AAAAAAAAAAAAAAAAAAAAAAAA';
const HUMAN = '01BBBBBBBBBBBBBBBBBBBBBBBB';
const AGENT = '01CCCCCCCCCCCCCCCCCCCCCCCC';
const AGENT_LOCAL = '01DDDDDDDDDDDDDDDDDDDDDDDD';

saveProfile({
  name: 'owner',
  identityKey: 'test-key',
  userId: OWNER,
  authToken: 'test-token',
  registrationId: 1,
  deviceId: 1,
});
saveProfile({
  name: 'guest',
  identityKey: 'test-key',
  userId: HUMAN,
  authToken: 'test-token',
  registrationId: 1,
  deviceId: 1,
});
// A same-home integration profile — the OTHER thing a CLI owner's disk can
// honestly know (`pair` runs on the integration account, so its profile
// carries the class the server fixed at registration).
saveProfile({
  name: 'int-local',
  identityKey: 'test-key',
  userId: AGENT_LOCAL,
  authToken: 'test-token',
  registrationId: 1,
  deviceId: 1,
  accountClass: 'integration',
  ownerUserId: OWNER,
});

function recordingDeliver(captured: FanoutLeg[][]): RoomDelivery {
  return (async ({ legs }: { legs: FanoutLeg[] }) => {
    captured.push(legs);
    return legs.map(l => ({ to: l.to, msgId: l.msgId, state: 'delivered' as const }));
  }) as RoomDelivery;
}

async function runRoom(argv: string[], deliver: RoomDelivery, json = true): Promise<number> {
  return cmdRoom(argv, new Reporter({ json, plain: true }), deliver);
}

function newestGid(account: string): string {
  const rooms = listRooms(account);
  return rooms[rooms.length - 1]!.groupId;
}

describe('the adopt record — FileStores machine peers (machine_peers pattern)', () => {
  it('records once, first write wins, and reads back', () => {
    const stores = new FileStores('owner');
    stores.recordMachinePeer(AGENT, 1000);
    stores.recordMachinePeer(AGENT, 2000); // append-only: never re-dated
    expect(stores.loadMachinePeers()).toEqual({ [AGENT]: 1000 });
  });

  it('a corrupt record costs the nicety, never the capability', () => {
    const stores = new FileStores('guest');
    mkdirSync(stores.root, { recursive: true });
    writeFileSync(join(stores.root, 'machine-peers.json'), 'not json');
    expect(stores.loadMachinePeers()).toEqual({});
  });
});

describe('owner writes carry class — create', () => {
  it('room create classes a RECORDED machine peer in the grp.new (ic) and in its own store', async () => {
    new FileStores('owner').recordMachinePeer(AGENT, Date.now());
    const captured: FanoutLeg[][] = [];
    expect(await runRoom(['create', 'owner', 'Kitchen', HUMAN, AGENT], recordingDeliver(captured))).toBe(0);
    const gid = newestGid('owner');
    // The wire: every invite leg's grp.new names the agent in ic.
    const bodies = captured.flat().map(l => JSON.parse(l.body) as { tcm: string; ic?: string[] });
    expect(bodies.length).toBeGreaterThan(0);
    for (const b of bodies) {
      expect(b.tcm).toBe('grp.new');
      expect(b.ic).toEqual([AGENT]);
    }
    // The owner's own store: the seed slot is classed, and the fold reads it.
    const store = FileGroupStore.load('owner', gid);
    const fold = foldRoster(OWNER, store.listSlots(), ownerOnlyPolicy);
    expect(fold.classes[AGENT]).toBe('integration');
    expect(fold.classes[HUMAN]).toBeUndefined();
  });

  it('room create classes a member named by a SAME-HOME integration profile', async () => {
    const captured: FanoutLeg[][] = [];
    expect(
      await runRoom(['create', 'owner', 'Local', HUMAN, 'int-local'], recordingDeliver(captured)),
    ).toBe(0);
    const bodies = captured.flat().map(l => JSON.parse(l.body) as { ic?: string[] });
    for (const b of bodies) expect(b.ic).toContain(AGENT_LOCAL);
  });

  it('a room of humans alone carries NO ic — absent is the safe default', async () => {
    const captured: FanoutLeg[][] = [];
    expect(await runRoom(['create', 'guest', 'Humans', OWNER], recordingDeliver(captured))).toBe(0);
    const bodies = captured.flat().map(l => JSON.parse(l.body) as Record<string, unknown>);
    for (const b of bodies) expect('ic' in b).toBe(false);
  });
});

describe('owner writes carry class — add', () => {
  it('an owner ADD of a recorded machine carries c on the roster write and ic on the invite leg', async () => {
    new FileStores('owner').recordMachinePeer(AGENT, Date.now());
    const created: FanoutLeg[][] = [];
    expect(await runRoom(['create', 'owner', 'AddRoom', HUMAN], recordingDeliver(created))).toBe(0);
    const gid = newestGid('owner');
    const captured: FanoutLeg[][] = [];
    expect(await runRoom(['add', 'owner', gid, AGENT], recordingDeliver(captured))).toBe(0);
    const bodies = captured.flat().map(l => JSON.parse(l.body) as Record<string, unknown>);
    const roster = bodies.filter(b => b.tcm === 'grp.roster');
    const invite = bodies.filter(b => b.tcm === 'grp.new');
    expect(roster.length).toBeGreaterThan(0);
    for (const b of roster) expect(b.c).toBe('integration');
    // The brand-new member's own leg is a grp.new snapshot — it carries ic,
    // so the AGENT itself (and anyone folding from the snapshot) learns too.
    expect(invite.length).toBe(1);
    expect(invite[0]!.ic).toContain(AGENT);
    // And the owner's own slot is classed.
    const fold = foldRoster(OWNER, FileGroupStore.load('owner', gid).listSlots(), ownerOnlyPolicy);
    expect(fold.classes[AGENT]).toBe('integration');
  });

  it('adding a HUMAN to a room that already holds a classed agent carries the class into THEIR snapshot — the bootstrap path', async () => {
    // The core scenario: the agent is in the room FIRST, the second human
    // arrives LATER. Their first fold is the grp.new snapshot minted here, so
    // the room's EXISTING classes must ride it (inviteIc's fold-class
    // disjunct) — the added member itself is unclassed, so the other disjunct
    // contributes nothing. Delete the fold-class disjunct and this reddens.
    new FileStores('owner').recordMachinePeer(AGENT, Date.now());
    const created: FanoutLeg[][] = [];
    expect(await runRoom(['create', 'owner', 'LateHuman', AGENT], recordingDeliver(created))).toBe(0);
    const gid = newestGid('owner');
    const NEWCOMER = '01FFFFFFFFFFFFFFFFFFFFFFFF';
    const captured: FanoutLeg[][] = [];
    expect(await runRoom(['add', 'owner', gid, NEWCOMER], recordingDeliver(captured))).toBe(0);
    const bodies = captured.flat().map(l => JSON.parse(l.body) as Record<string, unknown>);
    // The newcomer's leg is the snapshot, and it names the room's agent.
    const invite = bodies.filter(b => b.tcm === 'grp.new');
    expect(invite).toHaveLength(1);
    expect(invite[0]!.ic).toEqual([AGENT]);
    // The human's own roster write carries NO c — nothing was guessed.
    const roster = bodies.filter(b => b.tcm === 'grp.roster');
    expect(roster.length).toBeGreaterThan(0);
    for (const b of roster) expect('c' in b).toBe(false);
  });

  it('an owner ADD of an unknown member carries NO c — the CLI never guesses', async () => {
    const created: FanoutLeg[][] = [];
    expect(await runRoom(['create', 'owner', 'NoGuess', HUMAN], recordingDeliver(created))).toBe(0);
    const gid = newestGid('owner');
    const captured: FanoutLeg[][] = [];
    const STRANGER = '01EEEEEEEEEEEEEEEEEEEEEEEE';
    expect(await runRoom(['add', 'owner', gid, STRANGER], recordingDeliver(captured))).toBe(0);
    const bodies = captured.flat().map(l => JSON.parse(l.body) as Record<string, unknown>);
    for (const b of bodies) expect('c' in b).toBe(false);
  });

  it('a NON-owner self write (accept) carries NO c even from an integration account', async () => {
    // Build guest's copy of an owner room by the receiver's own apply path,
    // then have guest accept: the sovereign write must be classless — class
    // is the owner's statement, and a non-owner lane never counts anyway.
    const gid = '01GGGGGGGGGGGGGGGGGGGGGGGG';
    const store = FileGroupStore.load('guest', gid);
    applyGroupNew(store, HUMAN, { writerId: OWNER, members: [OWNER, HUMAN], seq: 1 });
    store.setName('Accept');
    store.persist();
    new FileStores('guest').recordMachinePeer(HUMAN, Date.now()); // even a (nonsense) record
    const captured: FanoutLeg[][] = [];
    expect(await runRoom(['accept', 'guest', gid], recordingDeliver(captured))).toBe(0);
    const bodies = captured.flat().map(l => JSON.parse(l.body) as Record<string, unknown>);
    expect(bodies.length).toBeGreaterThan(0);
    for (const b of bodies) expect('c' in b).toBe(false);
  });
});

describe('roomAgentAuthorIds — marker-record ∨ fold-class', () => {
  it('a CLASS-ONLY agent (never spoken) is in the set — exclusion no longer waits for speech', () => {
    const gid = '01HHHHHHHHHHHHHHHHHHHHHHHH';
    const store = FileGroupStore.load('guest', gid);
    applyGroupNew(store, HUMAN, {
      writerId: OWNER,
      members: [OWNER, HUMAN, AGENT],
      seq: 1,
      integrations: [AGENT],
    });
    store.setName('ClassOnly');
    store.persist();
    expect(roomAgentAuthorIds('guest', gid)).toEqual(new Set([AGENT]));
  });

  it('a MARKER-ONLY agent (spoken AI-marked, unclassed roster) stays in the set — the pre-field rooms keep working', () => {
    const gid = '01JJJJJJJJJJJJJJJJJJJJJJJJ';
    const store = FileGroupStore.load('guest', gid);
    applyGroupNew(store, HUMAN, { writerId: OWNER, members: [OWNER, HUMAN, AGENT], seq: 1 });
    store.setName('MarkerOnly');
    store.persist();
    new MessageLog('guest').append({
      id: '01AGENTROW0000000000000001',
      dir: 'in',
      peer: AGENT,
      ts: Date.now(),
      tcm: 'grp.msg',
      text: 'hi',
      read: true,
      grp: gid,
      ai: true,
    });
    expect(roomAgentAuthorIds('guest', gid)).toEqual(new Set([AGENT]));
  });

  it('humans are NEVER in the set — class comes only from the owner slot, and none was written', () => {
    const gid = '01KKKKKKKKKKKKKKKKKKKKKKKK';
    const store = FileGroupStore.load('guest', gid);
    applyGroupNew(store, HUMAN, { writerId: OWNER, members: [OWNER, HUMAN], seq: 1 });
    store.setName('HumansOnly');
    store.persist();
    expect(roomAgentAuthorIds('guest', gid)).toEqual(new Set());
  });
});

describe('room show names the class — the anonymous-row defect', () => {
  it('the classed member’s roster line says it is an AI agent; --json lists it', async () => {
    const gid = '01MMMMMMMMMMMMMMMMMMMMMMMM';
    const store = FileGroupStore.load('guest', gid);
    applyGroupNew(store, HUMAN, {
      writerId: OWNER,
      members: [OWNER, HUMAN, AGENT],
      seq: 1,
      integrations: [AGENT],
    });
    store.setName('ShowRoom');
    store.persist();

    const lines: string[] = [];
    const plain = new Reporter({ json: false, plain: true });
    const origLine = plain.line.bind(plain);
    plain.line = ((obj: unknown, text: string) => {
      lines.push(text);
      return origLine(obj, '');
    }) as typeof plain.line;
    expect(await cmdRoom(['show', 'guest', gid], plain)).toBe(0);
    const agentLine = lines.find(l => l.includes(AGENT) && !l.startsWith('room ') && !l.startsWith('owner '));
    expect(agentLine).toContain('AI agent');
    const humanLine = lines.find(l => l.includes(HUMAN) && !l.startsWith('room ') && !l.startsWith('owner '));
    expect(humanLine).not.toContain('AI agent');

    const emitted: unknown[] = [];
    const json = new Reporter({ json: true, plain: true });
    const origEmit = json.emit.bind(json);
    json.emit = ((obj: unknown, text: string) => {
      emitted.push(obj);
      return origEmit(obj, text);
    }) as typeof json.emit;
    expect(await cmdRoom(['show', 'guest', gid], json)).toBe(0);
    expect((emitted[0] as { agents?: string[] }).agents).toEqual([AGENT]);
  });
});
