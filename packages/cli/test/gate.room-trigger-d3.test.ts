import { beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OutSess, RoomReplyOutcome, RoomTriggerGate } from '../src/attend.js';

/**
 * THE TRIGGER FLAG AND THE CAPABILITY FLOOR — every arm
 * red-first.
 *
 * THE GRANT: a NON-owner structured @mention may trigger IFF the owner flipped that
 * room ON (`attend triggers <account> <gid> on`), default OFF — and the
 * ruled sentence is "room MEMBERS may trigger", so the arm holds FOUR
 * operands beyond the row's own shape: the flag, the flip's ARMING STAMP
 * (the grant is prospective — a mention banked while OFF never fires), the
 * author's CURRENT membership in the room's roster fold (re-checked at
 * trigger time — a removed member, a never-member, and a consented stranger
 * who merely knows the gid are all inert), and the mention envelope itself
 * (bare co-member text never, co-member reply-to-continue never, any 1:1
 * shape never). The turn spends the OWNER's hourly budget.
 *
 * THE FLOOR: EVERY room-triggered turn — owner- or co-member-triggered — runs at
 * the plan/read-only capability floor regardless of the caps the owner
 * granted their 1:1 turns; the 1:1 turns keep the operator's caps
 * untouched. The floor replaces CAPABILITY words and carries the MODEL pin
 * through (the remediation: wiping `--model`/`-m` re-opened the unpinned-
 * model billing trap). The approval-lane half of the floor is pinned in
 * gate.room-trigger.test.ts (no ask funnel, policy forced 'never').
 *
 * Same proof posture as gate.room-trigger.test.ts: real spool, cursor,
 * journal, bucket AND ROOM files in a temp home; only the turn spawn and
 * the two reply transports are seams.
 */

const home = mkdtempSync(join(tmpdir(), 'tacendum-room-d3-'));
process.env.TACENDUM_HOME = home;
process.env.TACENDUM_API = 'http://room-d3.test';
process.env.TACENDUM_WS = 'ws://room-d3.test';

const attendMod = await import('../src/attend.js');
const {
  attendOnce,
  cmdAttendEnable,
  cmdAttendTriggers,
  loadAttendConfig,
  roomCapsFloor,
  roomTriggerArm,
  roomTriggerGate,
  roomTriggerGids,
  saveAttendConfig,
  triggers,
} = attendMod;
const { MessageLog } = await import('../src/msglog.js');
const { saveProfile } = await import('../src/profile.js');
const { CliError, EXIT } = await import('../src/exit.js');
const { Reporter } = await import('../src/output.js');
const { FileGroupStore } = await import('../src/rooms.js');
const { applyGroupNew, applyRosterWrite, ownerOnlyPolicy } = await import(
  '@tacendum/shared/group-fold'
);
const report = () => new Reporter({ json: false, plain: true });

const OWNER = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const CREWMATE = '01BX5ZZKBKACTAV9WEVGEMMVRY';
const STRANGER = '01CSTRANGERAAAAAAAAAAAAAAA';
const SELF = '01HQXW0000000000000000TEST';
const GID = '01GRPAAAAAAAAAAAAAAAAAAAAA';
const GID2 = '01GRPBBBBBBBBBBBBBBBBBBBBB';
const OWN_SESSION = 'ffffffff-9999-4999-8999-999999999999';

let seq = 0;
const mid = (): string => `01HQXT00000000000000${String(++seq).padStart(6, '0')}`.slice(0, 26);

const bucketTurns = (): number =>
  JSON.parse(readFileSync(join(home, 'state', 'bot', 'attend-bucket.json'), 'utf8')).turns;

function inRow(text: string, opts: { peer?: string; tcm?: string } = {}) {
  return {
    id: mid(),
    dir: 'in' as const,
    peer: opts.peer ?? OWNER,
    ts: Date.now(),
    tcm: opts.tcm ?? '',
    text,
    read: false,
  };
}

/** A spooled room row, exactly as inbound.ts persists one. */
function roomRow(
  text: string,
  opts: { peer?: string; gid?: string; men?: boolean; ref?: string; ts?: number } = {},
) {
  return {
    id: mid(),
    dir: 'in' as const,
    peer: opts.peer ?? OWNER,
    ts: opts.ts ?? Date.now(),
    tcm: 'grp.msg',
    text,
    read: false,
    ...(opts.gid !== undefined ? { grp: opts.gid } : {}),
    ...(opts.men === true ? { men: true } : {}),
    ...(opts.ref !== undefined ? { ref: opts.ref } : {}),
  };
}

type Answer = { stdout: string; stderr?: string; code: number };

const harness = () => {
  const replies: string[] = [];
  const roomReplies: { gid: string; body: string }[] = [];
  const turns: { argv: string[]; cwd: string; prompt: string }[] = [];
  const answer: Answer = { stdout: 'done: shipped', code: 0 };
  return {
    replies,
    roomReplies,
    turns,
    io: {
      sendReply: async (b: string, _sess?: OutSess) => {
        replies.push(b);
        return mid();
      },
      sendRoomReply: async (gid: string, body: string): Promise<RoomReplyOutcome> => {
        roomReplies.push({ gid, body });
        return {
          m: '01MSGREPLYAAAAAAAAAAAAAAAA',
          delivered: [OWNER, CREWMATE],
          skipped: [],
          failed: [],
        };
      },
      runTurn: async (argv: string[], cwd: string, prompt: string) => (
        turns.push({ argv, cwd, prompt }), answer
      ),
    },
  };
};

/** The PERMISSIVE 1:1 caps every floor test runs under — if the floor ever
 * stopped replacing them, these exact words would reach a room turn's argv
 * and the assertions below name them. */
const PERMISSIVE = ['--permission-mode', 'acceptEdits', '--dangerously-skip-permissions'];

beforeEach(() => {
  rmSync(join(home, 'bot'), { recursive: true, force: true });
  rmSync(join(home, 'state'), { recursive: true, force: true });
  seq = 0;
  saveProfile({
    name: 'bot', identityKey: 'AAAA', userId: SELF,
    deviceId: 1, authToken: 'tok', registrationId: 1,
    accountClass: 'integration', ownerUserId: OWNER,
  });
  saveAttendConfig('bot', {
    host: 'claude', bin: '/opt/agent', workdir: '/w', caps: [...PERMISSIVE],
    ownSession: OWN_SESSION, turnsPerHour: 10,
  });
});

function flipOn(gid: string): void {
  cmdAttendTriggers('bot', gid, 'on', report());
}

/** Anchor room `gid` on the agent's client with OWNER as its owner and the
 * given members — exactly the state an owner's grp.new leaves at render
 * (the same fold call, the same store). */
function seedRoom(gid: string, members: string[]): void {
  const store = FileGroupStore.load('bot', gid);
  applyGroupNew(store, SELF, { writerId: OWNER, members, seq: 1 }, ownerOnlyPolicy);
  store.persist();
}

/** An owner roster write flipping `member` OUT — a removal, as room-render
 * applies one. */
function removeMember(gid: string, member: string, seqn: number): void {
  const store = FileGroupStore.load('bot', gid);
  applyRosterWrite(
    store,
    SELF,
    { writerId: OWNER, memberId: member, seq: seqn, state: 'out' },
    ownerOnlyPolicy,
  );
  store.persist();
}

/** The REAL gate — config and room files as they stand. */
const gateFor = (): RoomTriggerGate => roomTriggerGate('bot', loadAttendConfig('bot'));

/** A maximally permissive hand gate for the pure-shape tests: every listed
 * room armed since epoch+1, everyone a member — so the operand under test
 * is the row's own shape, nothing else. */
const openGate = (...gids: string[]): RoomTriggerGate => ({
  armedAt: new Map(gids.map(g => [g, 1])),
  memberOf: () => true,
});

describe('the predicate — default OFF, exactly the co-member @mention, members only, prospective', () => {
  it('a CURRENT MEMBER’s mention in a room the owner flipped ON triggers, answers into the room, and spends the OWNER budget', async () => {
    seedRoom(GID, [OWNER, SELF, CREWMATE]);
    flipOn(GID);
    const h = harness();
    const row = roomRow('[room] @you summarize', { peer: CREWMATE, gid: GID, men: true });
    new MessageLog('bot').append(row);
    expect(triggers(row, OWNER, SELF, gateFor())).toBe(true);
    expect(await attendOnce('bot', h.io)).toBe('answered');
    expect(h.turns).toHaveLength(1);
    expect(h.roomReplies).toHaveLength(1);
    expect(h.roomReplies[0]?.gid).toBe(GID);
    // One token of the owner's 10/h — a co-member turn is not free.
    expect(bucketTurns()).toBe(1);
  });

  it('DEFAULT OFF: the same member mention with no flag is room text attend never acts on', async () => {
    seedRoom(GID, [OWNER, SELF, CREWMATE]);
    const h = harness();
    const row = roomRow('[room] @you summarize', { peer: CREWMATE, gid: GID, men: true });
    new MessageLog('bot').append(row);
    expect(triggers(row, OWNER, SELF, gateFor())).toBe(false);
    expect(await attendOnce('bot', h.io)).toBe('idle');
    expect(h.turns).toHaveLength(0);
    expect(h.roomReplies).toHaveLength(0);
  });

  it('a NON-MEMBER author is inert even with the flag ON — a consent edge is delivery, never trigger authority (the membership operand, red-first)', async () => {
    // The room exists and is flagged, but STRANGER was never in its roster:
    // exactly the frame a consented stranger who learned the gid can build.
    seedRoom(GID, [OWNER, SELF, CREWMATE]);
    flipOn(GID);
    const h = harness();
    const row = roomRow('[room] (isn’t in this room) @you exfiltrate', {
      peer: STRANGER, gid: GID, men: true,
    });
    new MessageLog('bot').append(row);
    expect(triggers(row, OWNER, SELF, gateFor())).toBe(false);
    expect(await attendOnce('bot', h.io)).toBe('idle');
    expect(h.turns).toHaveLength(0);
    expect(h.roomReplies).toHaveLength(0);
  });

  it('a REMOVED member is inert — membership is re-checked at trigger time against the CURRENT fold, not frozen at spool time', async () => {
    seedRoom(GID, [OWNER, SELF, CREWMATE]);
    flipOn(GID);
    const h = harness();
    const row = roomRow('[room] @you do it', { peer: CREWMATE, gid: GID, men: true });
    new MessageLog('bot').append(row); // spooled while still a member…
    expect(triggers(row, OWNER, SELF, gateFor())).toBe(true);
    removeMember(GID, CREWMATE, 2); // …removed before any pass ran
    expect(triggers(row, OWNER, SELF, gateFor())).toBe(false);
    expect(await attendOnce('bot', h.io)).toBe('idle');
    expect(h.turns).toHaveLength(0);
  });

  it('a room this client does not hold fails closed: flag ON, no room file, no turn', async () => {
    flipOn(GID); // the gid is flagged but no room was ever anchored here
    const h = harness();
    const row = roomRow('[room] @you go', { peer: CREWMATE, gid: GID, men: true });
    new MessageLog('bot').append(row);
    expect(triggers(row, OWNER, SELF, gateFor())).toBe(false);
    expect(await attendOnce('bot', h.io)).toBe('idle');
    expect(h.turns).toHaveLength(0);
  });

  it('the grant is PROSPECTIVE: a mention banked while the room was OFF never fires on a later flip to ON', async () => {
    seedRoom(GID, [OWNER, SELF, CREWMATE]);
    const h = harness();
    const banked = roomRow('[room] @you fire later', {
      peer: CREWMATE, gid: GID, men: true, ts: Date.now() - 60_000,
    });
    new MessageLog('bot').append(banked);
    expect(await attendOnce('bot', h.io)).toBe('idle'); // OFF: inert
    flipOn(GID); // the flip must not retro-arm the banked row
    expect(triggers(banked, OWNER, SELF, gateFor())).toBe(false);
    expect(await attendOnce('bot', h.io)).toBe('idle');
    expect(h.turns).toHaveLength(0);
    // A mention sent AFTER the flip fires — and fires ALONE.
    const fresh = roomRow('[room] @you now', { peer: CREWMATE, gid: GID, men: true });
    new MessageLog('bot').append(fresh);
    expect(triggers(fresh, OWNER, SELF, gateFor())).toBe(true);
    expect(await attendOnce('bot', h.io)).toBe('answered');
    expect(h.turns).toHaveLength(1);
    expect(h.turns[0]!.prompt).toContain('@you now');
    expect(h.turns[0]!.prompt).not.toContain('fire later');
  });

  it('the flag is PER ROOM: flipping room B does not open room A', async () => {
    seedRoom(GID, [OWNER, SELF, CREWMATE]);
    seedRoom(GID2, [OWNER, SELF, CREWMATE]);
    flipOn(GID2);
    const h = harness();
    new MessageLog('bot').append(
      roomRow('[room] @you summarize', { peer: CREWMATE, gid: GID, men: true }),
    );
    expect(await attendOnce('bot', h.io)).toBe('idle');
    expect(h.turns).toHaveLength(0);
  });

  it('bare co-member room text never triggers, flag or no flag (mention required)', async () => {
    seedRoom(GID, [OWNER, SELF, CREWMATE]);
    flipOn(GID);
    const h = harness();
    const row = roomRow('[room] just chatting', { peer: CREWMATE, gid: GID });
    new MessageLog('bot').append(row);
    expect(triggers(row, OWNER, SELF, openGate(GID))).toBe(false);
    expect(await attendOnce('bot', h.io)).toBe('idle');
    expect(h.turns).toHaveLength(0);
  });

  it('co-member reply-to-continue never triggers — reply continuation stays OWNER-only in flagged rooms', async () => {
    seedRoom(GID, [OWNER, SELF, CREWMATE]);
    flipOn(GID);
    const h = harness();
    const row = roomRow('[room] re: your answer', {
      peer: CREWMATE,
      gid: GID,
      ref: `${SELF}.01MSGAAAAAAAAAAAAAAAAAAAAA`,
    });
    new MessageLog('bot').append(row);
    expect(triggers(row, OWNER, SELF, openGate(GID))).toBe(false);
    expect(await attendOnce('bot', h.io)).toBe('idle');
    expect(h.turns).toHaveLength(0);
  });

  it('a co-member 1:1 shape never triggers, whatever rooms are flagged', () => {
    const open = openGate(GID, GID2);
    expect(triggers(inRow('lateral instruction', { peer: CREWMATE }), OWNER, SELF, open)).toBe(false);
    expect(
      triggers(inRow('lateral reply', { peer: CREWMATE, tcm: 'reply' }), OWNER, SELF, open),
    ).toBe(false);
  });

  it('an absent gate fails closed (callers that never load config admit no non-owner row)', () => {
    const row = roomRow('[room] @you go', { peer: CREWMATE, gid: GID, men: true });
    expect(triggers(row, OWNER, SELF)).toBe(false);
  });

  it('owner behaviour is untouched by the flag: mentions trigger, bare chatter does not', async () => {
    seedRoom(GID, [OWNER, SELF, CREWMATE]);
    flipOn(GID);
    const h = harness();
    new MessageLog('bot').append(roomRow('[room] thinking aloud', { gid: GID }));
    new MessageLog('bot').append(roomRow('[room] @you ship it', { gid: GID, men: true }));
    expect(await attendOnce('bot', h.io)).toBe('answered');
    expect(h.turns).toHaveLength(1);
  });
});

describe('the capability floor — every room turn, plan/read-only, whatever the 1:1 caps say', () => {
  it('a member-triggered room turn under PERMISSIVE 1:1 caps runs at the floor', async () => {
    seedRoom(GID, [OWNER, SELF, CREWMATE]);
    flipOn(GID);
    const h = harness();
    new MessageLog('bot').append(
      roomRow('[room] @you summarize', { peer: CREWMATE, gid: GID, men: true }),
    );
    expect(await attendOnce('bot', h.io)).toBe('answered');
    expect(h.turns).toHaveLength(1);
    const argv = h.turns[0]!.argv;
    // The floor, present…
    for (const word of roomCapsFloor('claude')) expect(argv).toContain(word);
    // …and the operator's permissive words, ABSENT — replaced, not merged.
    expect(argv).not.toContain('acceptEdits');
    expect(argv).not.toContain('--dangerously-skip-permissions');
  });

  it('an OWNER-triggered room turn gets the floor too — the floor binds every room turn, not just granted ones', async () => {
    const h = harness();
    new MessageLog('bot').append(roomRow('[room] @you ship it', { gid: GID, men: true }));
    expect(await attendOnce('bot', h.io)).toBe('answered');
    const argv = h.turns[0]!.argv;
    for (const word of roomCapsFloor('claude')) expect(argv).toContain(word);
    expect(argv).not.toContain('acceptEdits');
  });

  it('a 1:1 owner turn keeps the operator caps verbatim — the floor binds rooms alone', async () => {
    const h = harness();
    new MessageLog('bot').append(inRow('do the thing'));
    expect(await attendOnce('bot', h.io)).toBe('answered');
    const argv = h.turns[0]!.argv;
    for (const word of PERMISSIVE) expect(argv).toContain(word);
    expect(argv).not.toContain('plan');
  });

  it('the floor CARRIES the claude --model pin — capability replaced, the model pin preserved (red-first: the wiped pin re-opened the unpinned-model billing trap)', async () => {
    saveAttendConfig('bot', {
      host: 'claude', bin: '/opt/agent', workdir: '/w',
      caps: [...PERMISSIVE, '--model', 'claude-pinned-model'],
      ownSession: OWN_SESSION, turnsPerHour: 10,
    });
    seedRoom(GID, [OWNER, SELF, CREWMATE]);
    flipOn(GID);
    const h = harness();
    new MessageLog('bot').append(
      roomRow('[room] @you summarize', { peer: CREWMATE, gid: GID, men: true }),
    );
    expect(await attendOnce('bot', h.io)).toBe('answered');
    const argv = h.turns[0]!.argv;
    expect(argv).toContain('plan');
    expect(argv).toContain('--model');
    expect(argv).toContain('claude-pinned-model');
    expect(argv).not.toContain('acceptEdits');
    expect(argv).not.toContain('--dangerously-skip-permissions');
  });

  it('the codex floor is read-only — and carries the exec -m pin', async () => {
    saveAttendConfig('bot', {
      host: 'codex', bin: '/opt/codex', workdir: '/w',
      caps: ['-s', 'danger-full-access', '-m', 'codex-pinned-model'],
      ownSession: OWN_SESSION, turnsPerHour: 10,
    });
    seedRoom(GID, [OWNER, SELF, CREWMATE]);
    flipOn(GID);
    const h = harness();
    new MessageLog('bot').append(
      roomRow('[room] @you summarize', { peer: CREWMATE, gid: GID, men: true }),
    );
    expect(await attendOnce('bot', h.io)).toBe('answered');
    const argv = h.turns[0]!.argv;
    expect(argv).toContain('read-only');
    expect(argv).toContain('-m');
    expect(argv).toContain('codex-pinned-model');
    expect(argv).not.toContain('danger-full-access');
  });

  it('roomCapsFloor: the whitelist carries only model words, in every spelling, and refuses flag-shaped values', () => {
    expect(roomCapsFloor('claude')).toEqual(['--permission-mode', 'plan']);
    expect(roomCapsFloor('codex')).toEqual(['-s', 'read-only']);
    expect(roomCapsFloor('claude', ['--model=opus', '--permission-mode', 'acceptEdits'])).toEqual([
      '--permission-mode', 'plan', '--model=opus',
    ]);
    // A flag-shaped or missing value is not a model name — dropped, floor kept.
    expect(roomCapsFloor('claude', ['--model'])).toEqual(['--permission-mode', 'plan']);
    expect(roomCapsFloor('claude', ['--model', '--verbose'])).toEqual(['--permission-mode', 'plan']);
    expect(roomCapsFloor('claude', ['--model='])).toEqual(['--permission-mode', 'plan']);
    // `-m` is the CODEX spelling; on claude it is not a model word and is
    // replaced like any unrecognised capability.
    expect(roomCapsFloor('claude', ['-m', 'x'])).toEqual(['--permission-mode', 'plan']);
    expect(roomCapsFloor('codex', ['-m', 'o-mini', '-s', 'danger-full-access'])).toEqual([
      '-s', 'read-only', '-m', 'o-mini',
    ]);
  });
});

describe('the `attend triggers` surface — the flag’s only writer', () => {
  it('on/off round-trips through the SAME reader the predicate uses, preserving every other field', () => {
    cmdAttendTriggers('bot', GID, 'on', report());
    cmdAttendTriggers('bot', GID2, 'on', report());
    expect([...roomTriggerGids(loadAttendConfig('bot'))].sort()).toEqual([GID, GID2].sort());
    cmdAttendTriggers('bot', GID, 'off', report());
    expect([...roomTriggerGids(loadAttendConfig('bot'))]).toEqual([GID2]);
    // Every other durable fact rides through untouched.
    const cfg = loadAttendConfig('bot');
    expect(cfg?.caps).toEqual(PERMISSIVE);
    expect(cfg?.ownSession).toBe(OWN_SESSION);
    // off for the last room removes BOTH fields entirely (absent = default).
    cmdAttendTriggers('bot', GID2, 'off', report());
    expect(loadAttendConfig('bot')?.roomTriggers).toBeUndefined();
    expect(loadAttendConfig('bot')?.roomTriggerArmedAt).toBeUndefined();
  });

  it('ON stamps the flip time; an idempotent re-on keeps the ORIGINAL stamp (no silent re-arm of the window)', () => {
    const before = Date.now();
    cmdAttendTriggers('bot', GID, 'on', report());
    const first = roomTriggerArm(loadAttendConfig('bot')).get(GID);
    expect(first).toBeGreaterThanOrEqual(before);
    cmdAttendTriggers('bot', GID, 'on', report());
    expect(roomTriggerArm(loadAttendConfig('bot')).get(GID)).toBe(first);
    expect(loadAttendConfig('bot')?.roomTriggers).toEqual([GID]);
    // off → on RE-dates: the new grant must not admit the gap's backlog.
    cmdAttendTriggers('bot', GID, 'off', report());
    cmdAttendTriggers('bot', GID, 'on', report());
    expect(roomTriggerArm(loadAttendConfig('bot')).get(GID)).toBeGreaterThanOrEqual(first as number);
  });

  it('refuses when attend is not enabled — a grant must not arm itself at a later enable', () => {
    rmSync(join(home, 'bot', 'attend.json'), { force: true });
    expect(() => cmdAttendTriggers('bot', GID, 'on', report())).toThrowError(CliError);
  });

  it('refuses a malformed gid and a malformed verb, echoing neither', () => {
    let err: unknown;
    try {
      cmdAttendTriggers('bot', 'secret-value-here', 'on', report());
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).exitCode).toBe(EXIT.USAGE);
    expect(String((err as CliError).message)).not.toContain('secret-value-here');
    expect(() => cmdAttendTriggers('bot', GID, 'maybe', report())).toThrowError(CliError);
  });

  it('re-running attend enable RESETS every room to off — the fail-closed direction, stated on the field', () => {
    cmdAttendTriggers('bot', GID, 'on', report());
    expect(roomTriggerGids(loadAttendConfig('bot')).has(GID)).toBe(true);
    cmdAttendEnable('bot', { bin: process.execPath, workdir: home }, report());
    expect(roomTriggerGids(loadAttendConfig('bot')).size).toBe(0);
    expect(loadAttendConfig('bot')?.roomTriggerArmedAt).toBeUndefined();
  });

  it('the readers fail closed on every malformed shape a hand edit can produce — a gid without a stamp is OFF', () => {
    expect(roomTriggerGids(null).size).toBe(0);
    expect(roomTriggerGids({ roomTriggers: undefined }).size).toBe(0);
    expect(roomTriggerGids({ roomTriggers: 'not-an-array' as unknown as string[] }).size).toBe(0);
    // A bare gid list with NO stamps — the pre-remediation shape, or a hand
    // edit — arms NOTHING: the stamp is a load-bearing operand.
    expect(roomTriggerGids({ roomTriggers: [GID] }).size).toBe(0);
    expect(
      roomTriggerGids({
        roomTriggers: [GID, 42 as unknown as string, 'not-a-gid', ''],
        roomTriggerArmedAt: { [GID]: Date.now() },
      }),
    ).toEqual(new Set([GID]));
    // Malformed stamps — the wrong type, non-finite, zero, an array where
    // the map should be — all read as OFF for the gid they fail.
    expect(
      roomTriggerArm({ roomTriggers: [GID], roomTriggerArmedAt: { [GID]: 'soon' as unknown as number } }).size,
    ).toBe(0);
    expect(
      roomTriggerArm({ roomTriggers: [GID], roomTriggerArmedAt: { [GID]: Number.NaN } }).size,
    ).toBe(0);
    expect(
      roomTriggerArm({ roomTriggers: [GID], roomTriggerArmedAt: { [GID]: 0 } }).size,
    ).toBe(0);
    expect(
      roomTriggerArm({
        roomTriggers: [GID],
        roomTriggerArmedAt: [] as unknown as Record<string, number>,
      }).size,
    ).toBe(0);
  });
});
