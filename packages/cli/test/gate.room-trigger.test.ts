import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AttendConfig, OutSess, RoomReplyOutcome } from '../src/attend.js';
import type { HostDriver, TurnRequest } from '../src/attend-drivers.js';

/**
 * THE ROOM TRIGGER PREDICATE — every arm red-first.
 *
 * The design rulings this file pins:
 *  1. structured mention only — the predicate reads the mention envelope's
 *     `who[]` (spooled as the `men` flag); rendered text NEVER triggers;
 *  2. agent-to-agent chaining refused v1 — `peer === owner` DOES NOT MOVE,
 *     and the crew-mate test here is the security boundary of the phase;
 *  3. spool metadata (`grp` + `men`) on grp.msg rows only;
 *  5. room replies keep ATTEND_REPLY_CAP; no CLI mention-compose surface.
 *
 * Proven against fake io seams exactly as attend.test.ts proves the 1:1
 * predicate: the spool, cursor, journal, bucket and room-session store are
 * REAL files in a temp home; only the turn spawn and the two reply
 * transports are seams.
 */

const home = mkdtempSync(join(tmpdir(), 'tacendum-room-trigger-'));
process.env.TACENDUM_HOME = home;
process.env.TACENDUM_API = 'http://room-trigger.test';
process.env.TACENDUM_WS = 'ws://room-trigger.test';

// The driver seam, for the steer pins only: everything else in
// attend-drivers is the real module (the steer-spine file's exact shape).
const seams = vi.hoisted(() => ({
  driver: null as HostDriver | null,
  // The fan-out transport under `realSendRoomReply` — faked so the LEDGER
  // MINTING is exercised for real against the real spool (the wire is
  // send.ts's suite's problem). Null means the real sendRoomMessage.
  //
  // The fake takes EVERY argument the real one takes. Its first life took
  // `(account, gid, text)` and the passthrough below forwarded only those
  // three — which silently DROPPED the opts argument, so the `{ ai: true }`
  // `realSendRoomReply` passes was never observed by anything in this suite
  // and a mutation deleting it stayed green (the consent remediation's F6).
  roomWire: null as
    | ((
        account: string,
        gid: string,
        text: string,
        opts?: { attach?: string | undefined; ai?: boolean },
      ) => {
        m: string; delivered: string[]; skipped: string[]; preSkipped: string[];
        failed: string[]; outcomes: never[]; recipients: number; members: number;
      })
    | null,
}));
vi.mock('../src/attend-drivers.js', async importOriginal => {
  const real = await importOriginal<typeof import('../src/attend-drivers.js')>();
  return {
    ...real,
    driverFor: (host: Parameters<typeof real.driverFor>[0]) =>
      seams.driver ?? real.driverFor(host),
  };
});
vi.mock('../src/room-commands.js', async importOriginal => {
  const real = await importOriginal<typeof import('../src/room-commands.js')>();
  return {
    ...real,
    // ALL arguments forward — the deliver/status defaults still apply (an
    // explicit undefined engages a default parameter), and the opts reach
    // whichever half is live: the fake records them, the real one marks.
    sendRoomMessage: (async (...args: Parameters<typeof real.sendRoomMessage>) =>
      seams.roomWire !== null
        ? seams.roomWire(args[0], args[1], args[2], args[5])
        : real.sendRoomMessage(...args)) as typeof real.sendRoomMessage,
  };
});

const attendMod = await import('../src/attend.js');
const {
  ATTEND_REPLY_CAP, MID_TURN_MARKER, attendOnce, realSendRoomReply, route, saveAttendConfig,
  triggers,
} = attendMod;
const { MessageLog } = await import('../src/msglog.js');
const { saveProfile } = await import('../src/profile.js');

const OWNER = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const CREWMATE = '01BX5ZZKBKACTAV9WEVGEMMVRY';
const SELF = '01HQXW0000000000000000TEST';
const GID = '01GRPAAAAAAAAAAAAAAAAAAAAA';
const GID2 = '01GRPBBBBBBBBBBBBBBBBBBBBB';
const M1 = '01MSGAAAAAAAAAAAAAAAAAAAAA';
const OWN_SESSION = 'ffffffff-9999-4999-8999-999999999999';

let seq = 0;
const mid = (): string => `01HQXR00000000000000${String(++seq).padStart(6, '0')}`.slice(0, 26);

const statePath = (file: string): string => join(home, 'state', 'bot', file);
const bucketTurns = (): number =>
  JSON.parse(readFileSync(statePath('attend-bucket.json'), 'utf8')).turns;

function inRow(text: string, opts: { peer?: string; tcm?: string; ref?: string } = {}) {
  return {
    id: mid(),
    dir: 'in' as const,
    peer: opts.peer ?? OWNER,
    ts: Date.now(),
    tcm: opts.tcm ?? '',
    text,
    read: false,
    ...(opts.ref ? { ref: opts.ref } : {}),
  };
}

/** A spooled room row, exactly as inbound.ts persists one. */
function roomRow(
  text: string,
  opts: { peer?: string; gid?: string; men?: boolean; ref?: string; red?: boolean } = {},
) {
  return {
    id: mid(),
    dir: 'in' as const,
    peer: opts.peer ?? OWNER,
    ts: Date.now(),
    tcm: 'grp.msg',
    text,
    read: false,
    ...(opts.gid !== undefined ? { grp: opts.gid } : {}),
    ...(opts.men === true ? { men: true } : {}),
    ...(opts.ref !== undefined ? { ref: opts.ref } : {}),
    ...(opts.red === true ? { red: true } : {}),
  };
}

/** The out-ledger row the room reply transport mints: the compound row
 * key `${selfUserId}.${m}`, carrying the room. */
function outRoomRow(m: string, gid: string) {
  const rec = {
    id: `${SELF}.${m}`,
    dir: 'out' as const,
    peer: OWNER,
    ts: Date.now(),
    tcm: 'grp.msg',
    text: '',
    read: true,
    grp: gid,
  };
  new MessageLog('bot').append(rec);
  return rec;
}

type Answer = { stdout: string; stderr?: string; code: number };

const harness = () => {
  const replies: string[] = [];
  const replySess: (OutSess | undefined)[] = [];
  const roomReplies: { gid: string; body: string }[] = [];
  const turns: { argv: string[]; cwd: string; prompt: string }[] = [];
  let answer: Answer = { stdout: 'done: shipped', code: 0 };
  let roomAnswer: RoomReplyOutcome | (() => RoomReplyOutcome) = {
    m: '01MSGREPLYAAAAAAAAAAAAAAAA',
    delivered: [OWNER, CREWMATE],
    skipped: [],
    failed: [],
  };
  return {
    replies, replySess, roomReplies, turns,
    setAnswer: (a: Answer) => { answer = a; },
    setRoomAnswer: (a: RoomReplyOutcome | (() => RoomReplyOutcome)) => { roomAnswer = a; },
    io: {
      sendReply: async (b: string, sess?: OutSess) => {
        replies.push(b);
        replySess.push(sess);
        return mid();
      },
      sendRoomReply: async (gid: string, body: string): Promise<RoomReplyOutcome> => {
        roomReplies.push({ gid, body });
        return typeof roomAnswer === 'function' ? roomAnswer() : roomAnswer;
      },
      runTurn: async (argv: string[], cwd: string, prompt: string) =>
        (turns.push({ argv, cwd, prompt }), answer),
    },
  };
};

/** A MOVING clock (the frozen-clock ruling): now() advances on every read,
 * so no deadline arithmetic can hide behind a pinned instant. */
const movingClock = () => {
  let t = Date.now();
  return {
    now: () => (t += 20),
    sleep: async (ms: number): Promise<void> => {
      t += ms;
      await new Promise(r => setTimeout(r, 2));
    },
  };
};

async function poll(cond: () => boolean, ms = 10_000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error('poll timed out');
    await new Promise(r => setTimeout(r, 10));
  }
}

beforeEach(() => {
  rmSync(join(home, 'bot'), { recursive: true, force: true });
  rmSync(join(home, 'state'), { recursive: true, force: true });
  seq = 0;
  seams.driver = null;
  saveProfile({
    name: 'bot', identityKey: 'AAAA', userId: SELF,
    deviceId: 1, authToken: 'tok', registrationId: 1,
    accountClass: 'integration', ownerUserId: OWNER,
  });
  saveAttendConfig('bot', {
    host: 'claude', bin: '/opt/agent', workdir: '/w', caps: ['--permission-mode', 'plan'],
    ownSession: OWN_SESSION, turnsPerHour: 10,
  });
});

describe('the predicate — every arm, red-first', () => {
  it('a structured owner mention triggers a room turn, answered INTO the room', async () => {
    const h = harness();
    new MessageLog('bot').append(roomRow('[crew] @you ship it', { gid: GID, men: true }));
    expect(await attendOnce('bot', h.io)).toBe('answered');
    expect(h.turns).toHaveLength(1);
    expect(h.roomReplies).toHaveLength(1);
    expect(h.roomReplies[0]?.gid).toBe(GID);
    expect(h.roomReplies[0]?.body).toBe('done: shipped');
    // The answer went into the ROOM, not down the 1:1 funnel.
    expect(h.replies).toEqual([]);
  });

  it('THE SECURITY BOUNDARY: a crew-mate-authored mention NEVER triggers (peer === owner does not move)', async () => {
    const h = harness();
    const row = roomRow('[crew] @you do evil', { peer: CREWMATE, gid: GID, men: true });
    new MessageLog('bot').append(row);
    expect(triggers(row, OWNER, SELF)).toBe(false);
    expect(await attendOnce('bot', h.io)).toBe('idle');
    expect(h.turns, 'a crew-mate must never start a turn').toHaveLength(0);
    expect(h.roomReplies).toHaveLength(0);
    expect(h.replies).toHaveLength(0);
  });

  it('bare owner room chatter never triggers (mentions-self required)', async () => {
    const h = harness();
    const row = roomRow('[crew] just thinking out loud', { gid: GID });
    new MessageLog('bot').append(row);
    expect(triggers(row, OWNER, SELF)).toBe(false);
    expect(await attendOnce('bot', h.io)).toBe('idle');
    expect(h.turns).toHaveLength(0);
  });

  it('plain-text "@name" never counts — the trigger is the structured who[], not rendered text', async () => {
    const h = harness();
    const row = roomRow('[crew] hey @bot please build', { gid: GID });
    new MessageLog('bot').append(row);
    expect(triggers(row, OWNER, SELF)).toBe(false);
    expect(await attendOnce('bot', h.io)).toBe('idle');
    expect(h.turns).toHaveLength(0);
  });

  it('a grp.msg row without the grp metadata (an older build wrote it) fails closed', async () => {
    const h = harness();
    const row = roomRow('[crew] @you from before the metadata', { men: true });
    new MessageLog('bot').append(row);
    expect(triggers(row, OWNER, SELF)).toBe(false);
    expect(await attendOnce('bot', h.io)).toBe('idle');
  });

  it('a redacted or empty room row never triggers', async () => {
    const h = harness();
    new MessageLog('bot').append(roomRow('was here', { gid: GID, men: true, red: true }));
    new MessageLog('bot').append(roomRow('', { gid: GID, men: true }));
    expect(await attendOnce('bot', h.io)).toBe('idle');
    expect(h.turns).toHaveLength(0);
  });

  it('reply-to-continue: a room reply to a room ledger row this attend wrote, SAME grp, triggers into that room', async () => {
    const h = harness();
    outRoomRow(M1, GID);
    new MessageLog('bot').append(
      roomRow('[crew] and now deploy it', { gid: GID, ref: `${SELF}.${M1}` }),
    );
    expect(await attendOnce('bot', h.io)).toBe('answered');
    expect(h.turns).toHaveLength(1);
    expect(h.roomReplies[0]?.gid).toBe(GID);
  });

  it('CROSS-ROOM: a reply in room A naming room B\'s ledger row must not continue — the honest answer, no turn', async () => {
    const h = harness();
    outRoomRow(M1, GID); // attend spoke in room GID…
    new MessageLog('bot').append(
      roomRow('[other] continue please', { gid: GID2, ref: `${SELF}.${M1}` }), // …reply arrives in GID2
    );
    expect(await attendOnce('bot', h.io)).toBe('ended');
    expect(h.turns, 'no turn may run on a cross-room ref').toHaveLength(0);
    expect(h.roomReplies).toHaveLength(0);
    expect(h.replies, 'the owner is answered honestly, 1:1').toHaveLength(1);
  });

  it('BROKEN MINTING: a self-aimed room ref that resolves to nothing answers ended honestly — never a guess, never silence', async () => {
    const h = harness();
    // No ledger row exists (the minting the mutation breaks).
    new MessageLog('bot').append(
      roomRow('[crew] continue please', { gid: GID, ref: `${SELF}.${M1}` }),
    );
    expect(await attendOnce('bot', h.io)).toBe('ended');
    expect(h.turns).toHaveLength(0);
    expect(h.replies).toHaveLength(1);
  });

  it("a room reply to a CREW-MATE's message never triggers — the ref is not aimed at this attend", async () => {
    const h = harness();
    const row = roomRow('[crew] good point', { gid: GID, ref: `${CREWMATE}.${M1}` });
    new MessageLog('bot').append(row);
    expect(triggers(row, OWNER, SELF)).toBe(false);
    expect(await attendOnce('bot', h.io)).toBe('idle');
  });
});

describe('route + continuity', () => {
  it('a room row routes {kind: room, gid} — the routeKey groups per room', () => {
    const row = roomRow('[crew] @you hi', { gid: GID, men: true });
    new MessageLog('bot').append(row);
    expect(route('bot', [row], Date.now(), 'claude')).toEqual({ kind: 'room', gid: GID });
  });

  it('a room run and a 1:1 run NEVER merge — the leading run stops at the boundary', async () => {
    const h = harness();
    const log = new MessageLog('bot');
    const r1 = roomRow('[crew] @you first', { gid: GID, men: true });
    const r2 = roomRow('[crew] @you second', { gid: GID, men: true });
    const d1 = inRow('a bare 1:1 message');
    log.append(r1); log.append(r2); log.append(d1);

    expect(await attendOnce('bot', h.io)).toBe('answered');
    expect(h.turns, 'one turn for the contiguous same-room run').toHaveLength(1);
    expect(h.turns[0]?.prompt).toBe('[crew] @you first\n\n[crew] @you second');
    expect(h.roomReplies).toHaveLength(1);
    expect(h.replies, 'the 1:1 remainder is NOT answered by the room turn').toHaveLength(0);

    expect(await attendOnce('bot', h.io)).toBe('answered');
    expect(h.turns).toHaveLength(2);
    expect(h.turns[1]?.prompt).toBe('a bare 1:1 message');
    expect(h.replies, 'the 1:1 answer takes the 1:1 funnel').toHaveLength(1);
    expect(h.roomReplies, 'and never the room path').toHaveLength(1);
  });

  it('two rooms never share a turn — the routeKey is per-gid', async () => {
    const h = harness();
    const log = new MessageLog('bot');
    log.append(roomRow('[a] @you one', { gid: GID, men: true }));
    log.append(roomRow('[b] @you two', { gid: GID2, men: true }));
    expect(await attendOnce('bot', h.io)).toBe('answered');
    expect(h.turns).toHaveLength(1);
    expect(h.roomReplies[0]?.gid).toBe(GID);
    expect(await attendOnce('bot', h.io)).toBe('answered');
    expect(h.roomReplies[1]?.gid).toBe(GID2);
  });

  it('claude: a pinned PER-ROOM session (ownSession analog, keyed by gid) — minted once, resumed after, never the own session', async () => {
    const h = harness();
    new MessageLog('bot').append(roomRow('[crew] @you start', { gid: GID, men: true }));
    expect(await attendOnce('bot', h.io)).toBe('answered');
    const sessions = JSON.parse(
      readFileSync(statePath('attend-room-sessions.json'), 'utf8'),
    ) as Record<string, { key?: string; started?: boolean }>;
    const key = sessions[GID]?.key as string;
    expect(key, 'a per-room session key is minted and persisted').toBeTruthy();
    expect(key).not.toBe(OWN_SESSION);
    expect(h.turns[0]?.argv, 'first room turn CREATES the pinned session').toContain(
      `--session-id=${key}`,
    );

    new MessageLog('bot').append(roomRow('[crew] @you again', { gid: GID, men: true }));
    expect(await attendOnce('bot', h.io)).toBe('answered');
    expect(h.turns[1]?.argv, 'the second room turn RESUMES the same session').toContain(
      `--resume=${key}`,
    );

    // A second room gets its own pin — rooms never share a transcript.
    new MessageLog('bot').append(roomRow('[b] @you other room', { gid: GID2, men: true }));
    expect(await attendOnce('bot', h.io)).toBe('answered');
    const after = JSON.parse(
      readFileSync(statePath('attend-room-sessions.json'), 'utf8'),
    ) as Record<string, { key?: string }>;
    expect(after[GID2]?.key).toBeTruthy();
    expect(after[GID2]?.key).not.toBe(key);

    // And the OWN session's flag was never touched by room observation.
    const cfg = JSON.parse(readFileSync(join(home, 'bot', 'attend.json'), 'utf8')) as {
      ownSessionStarted?: boolean;
    };
    expect(cfg.ownSessionStarted, 'room turns must not write the own-session flag').toBeUndefined();
  });

  it('codex exec: a room turn is FRESH per turn — no resume target, nothing stored', async () => {
    saveAttendConfig('bot', {
      host: 'codex', bin: '/opt/codex', workdir: '/w', caps: ['-s', 'read-only'],
      ownSession: OWN_SESSION, turnsPerHour: 10,
    });
    const h = harness();
    new MessageLog('bot').append(roomRow('[crew] @you go', { gid: GID, men: true }));
    expect(await attendOnce('bot', h.io)).toBe('answered');
    expect(h.turns[0]?.argv.join(' ')).not.toContain('resume');
    new MessageLog('bot').append(roomRow('[crew] @you more', { gid: GID, men: true }));
    expect(await attendOnce('bot', h.io)).toBe('answered');
    expect(h.turns[1]?.argv.join(' ')).not.toContain('resume');
    expect(existsSync(statePath('attend-room-sessions.json')), 'exec stores no room key').toBe(false);
  });
});

describe('the budget — one ordinary token per room turn, on a MOVING clock', () => {
  it('a room turn spends exactly one token', async () => {
    const h = harness();
    const io = { ...h.io, ...movingClock() };
    new MessageLog('bot').append(roomRow('[crew] @you count me', { gid: GID, men: true }));
    expect(await attendOnce('bot', io)).toBe('answered');
    expect(bucketTurns()).toBe(1);
  });

  it('an exhausted budget answers honestly and the room row queues — no silent drop', async () => {
    saveAttendConfig('bot', {
      host: 'claude', bin: '/opt/agent', workdir: '/w', caps: [],
      ownSession: OWN_SESSION, turnsPerHour: 1,
    });
    const h = harness();
    const io = { ...h.io, ...movingClock() };
    new MessageLog('bot').append(inRow('use up the hour'));
    expect(await attendOnce('bot', io)).toBe('answered');
    new MessageLog('bot').append(roomRow('[crew] @you over budget', { gid: GID, men: true }));
    expect(await attendOnce('bot', io)).toBe('throttled');
    expect(h.turns).toHaveLength(1);
    expect(h.replies.at(-1)).toContain('hourly turn limit');
  });
});

describe('prompt scope v1 — the owner\'s triggering rows ONLY', () => {
  it('the prompt is exactly the triggering rows — no room history rides along', async () => {
    const h = harness();
    const log = new MessageLog('bot');
    // Room context that must NOT enter the prompt: crew-mate chatter and
    // bare owner chatter, both spooled, neither triggering.
    log.append(roomRow('[crew] crew-mate context', { peer: CREWMATE, gid: GID }));
    log.append(roomRow('[crew] owner context', { gid: GID }));
    const t = roomRow('[crew] @you just this', { gid: GID, men: true });
    log.append(t);
    expect(await attendOnce('bot', h.io)).toBe('answered');
    expect(h.turns[0]?.prompt).toBe('[crew] @you just this');
  });
});

describe('reply fan-out', () => {
  it('the room reply keeps ATTEND_REPLY_CAP (2,000 ≪ MAX_GROUP_BODY)', async () => {
    const h = harness();
    h.setAnswer({ stdout: 'y'.repeat(5_000), code: 0 });
    new MessageLog('bot').append(roomRow('[crew] @you write a lot', { gid: GID, men: true }));
    expect(await attendOnce('bot', h.io)).toBe('answered');
    expect(h.roomReplies[0]?.body.length).toBeLessThanOrEqual(ATTEND_REPLY_CAP);
  });

  it('partial fan-out failure: the journal records the debt, the owner is told 1:1, and NOTHING retries', async () => {
    const h = harness();
    h.setRoomAnswer({ m: M1, delivered: [OWNER], skipped: [], failed: [CREWMATE] });
    new MessageLog('bot').append(roomRow('[crew] @you fan out', { gid: GID, men: true }));
    expect(await attendOnce('bot', h.io)).toBe('answered');
    expect(h.roomReplies, 'the fan-out ran ONCE — refused legs are never retried').toHaveLength(1);
    expect(h.replies, 'the owner is told 1:1 through the funnel — never silence').toHaveLength(1);
    expect(h.replies[0]).toContain('did not reach');
    // The debt was settled in-pass: the journal holds no residue.
    const j = existsSync(statePath('attend-journal.json'))
      ? (JSON.parse(readFileSync(statePath('attend-journal.json'), 'utf8')) as {
          roomDebt?: unknown;
        })
      : {};
    expect(j.roomDebt).toBeUndefined();
    // Rule 4: the raw room id never reaches the phone.
    expect(h.replies[0]).not.toContain(GID);
  });

  it('a crash between the fan-out and the notice still tells the owner ONCE — the journal debt survives the crash', async () => {
    const h = harness();
    // The crash shape: the debt is on disk, the notice never left.
    mkdirSync(join(home, 'state', 'bot'), { recursive: true });
    writeFileSync(
      statePath('attend-journal.json'),
      JSON.stringify({ roomDebt: { gid: GID, failed: [CREWMATE], skipped: 0, at: Date.now() } }),
    );
    expect(await attendOnce('bot', h.io)).toBe('idle');
    expect(h.replies).toHaveLength(1);
    expect(h.replies[0]).toContain('did not reach');
    const j = existsSync(statePath('attend-journal.json'))
      ? (JSON.parse(readFileSync(statePath('attend-journal.json'), 'utf8')) as {
          roomDebt?: unknown;
        })
      : {};
    expect(j.roomDebt, 'told once — the debt is cleared').toBeUndefined();
  });

  it('a crash WITH the notice in flight re-tells on restart: AT-LEAST-once, never silence — and the legs never re-run', async () => {
    // The debt notice is clear-AFTER-send on purpose: the crash window
    // between the reply and the journal clear duplicates one advisory
    // sentence, and the opposite order (clear-before-send) risks SILENCE —
    // a debt the owner never hears about. This test pins the chosen
    // direction: it turns red on any "exactly-once" rework that clears the
    // debt before the notice lands.
    mkdirSync(join(home, 'state', 'bot'), { recursive: true, mode: 0o700 });
    writeFileSync(
      statePath('attend-journal.json'),
      JSON.stringify({ roomDebt: { gid: GID, failed: [CREWMATE], skipped: 0, at: Date.now() } }),
    );
    // First pass: the process dies with the notice in flight — sent (maybe),
    // never cleared.
    const first: string[] = [];
    const dying = {
      sendReply: async (b: string): Promise<string> => {
        first.push(b);
        throw new Error('SIGKILL with the notice in flight');
      },
    };
    await expect(attendOnce('bot', dying)).rejects.toThrow('SIGKILL');
    expect(first).toHaveLength(1);
    const mid1 = JSON.parse(readFileSync(statePath('attend-journal.json'), 'utf8')) as {
      roomDebt?: unknown;
    };
    expect(mid1.roomDebt, 'the debt survives until the notice provably left').toBeDefined();

    // Restart: the owner hears it AGAIN — the duplicate is the tolerated
    // direction — the debt clears, and the legs are never re-fanned.
    const h = harness();
    expect(await attendOnce('bot', h.io)).toBe('idle');
    expect(h.replies).toHaveLength(1);
    expect(h.replies[0]).toContain('did not reach');
    expect(h.roomReplies, 'a debt is never a retry of the legs').toHaveLength(0);
    const after = existsSync(statePath('attend-journal.json'))
      ? (JSON.parse(readFileSync(statePath('attend-journal.json'), 'utf8')) as {
          roomDebt?: unknown;
        })
      : {};
    expect(after.roomDebt).toBeUndefined();
  });

  it('a fold refusal (not in the room any more) is answered honestly 1:1 — nothing into the room', async () => {
    const h = harness();
    h.setRoomAnswer({ delivered: [], skipped: [], failed: [], refused: 'not-in-room' });
    new MessageLog('bot').append(roomRow('[crew] @you left behind', { gid: GID, men: true }));
    expect(await attendOnce('bot', h.io)).toBe('answered');
    expect(h.replies).toHaveLength(1);
    expect(h.replies[0]).toContain('not in that room');
  });

  it('a failed room turn is an honest 1:1 excuse — the room never sees machinery noise', async () => {
    const h = harness();
    h.setAnswer({ stdout: '', stderr: 'boom', code: 1 });
    new MessageLog('bot').append(roomRow('[crew] @you break', { gid: GID, men: true }));
    expect(await attendOnce('bot', h.io)).toBe('failed');
    expect(h.roomReplies).toHaveLength(0);
    expect(h.replies).toHaveLength(1);
    expect(h.replies[0]).toContain('turn failed');
  });

  it('an empty answer posts nothing to the room and says so 1:1', async () => {
    const h = harness();
    h.setAnswer({ stdout: '', code: 0 });
    new MessageLog('bot').append(roomRow('[crew] @you say nothing', { gid: GID, men: true }));
    expect(await attendOnce('bot', h.io)).toBe('answered');
    expect(h.roomReplies).toHaveLength(0);
    expect(h.replies[0]).toBe('Turn finished, no output.');
  });
});

/**
 * THE LEDGER MINT: the real room reply transport writes the
 * `${selfUserId}.${m}` outbound row — the compound row key the owner's phone
 * will send back as the reply ref — carrying `grp` for the SAME-grp clause.
 * The fan-out wire is faked; the spool write and the join it enables are
 * real. Break the minting and reply-to-continue can only resolve `ended`,
 * which is exactly what this test turns red on.
 */
describe('the room reply mints the ledger row reply-to-continue joins on', () => {
  it('after a real-transport room reply, the compound ref resolves BACK to the same room', async () => {
    const M = '01MSGM1NTAAAAAAAAAAAAAAAAA'; // Crockford-valid: no I/L/O/U
    const seen: Array<{ attach?: string | undefined; ai?: boolean } | undefined> = [];
    seams.roomWire = (_account, _gid, _text, opts) => {
      seen.push(opts);
      return {
        m: M, delivered: [OWNER, CREWMATE], skipped: [], preSkipped: [], failed: [],
        outcomes: [], recipients: 2, members: 3,
      };
    };
    try {
      const out = await realSendRoomReply('bot', GID, 'the answer');
      expect(out.m).toBe(M);
      // The Art. 50 marker rides the lane (the F6 passthrough fix):
      // the agent's one marking site hands `{ ai: true }` to the fan-out.
      expect(seen).toEqual([{ ai: true }]);
      const row = new MessageLog('bot')
        .read({ dir: 'out' })
        .find(r => r.id === `${SELF}.${M}`);
      expect(row, 'the compound row key is minted on the out ledger').toBeDefined();
      expect(row!.grp).toBe(GID);
      expect(row!.sess, 'no session key rides a room ledger row').toBeUndefined();

      // The join, end to end: the owner's room reply carrying that ref
      // routes back INTO the same room…
      const cont = roomRow('[crew] and then?', { gid: GID, ref: `${SELF}.${M}` });
      expect(triggers(cont, OWNER, SELF)).toBe(true);
      expect(route('bot', [cont], Date.now(), 'claude')).toEqual({ kind: 'room', gid: GID });
      // …and a 1:1 reply carrying it CANNOT resume anything through the
      // ledger's session path (hostSessionKey gating unchanged).
      const direct = inRow('continue?', { tcm: 'reply', ref: `${SELF}.${M}` });
      expect(route('bot', [direct], Date.now(), 'claude')).toEqual({ kind: 'ended' });
    } finally {
      seams.roomWire = null;
    }
  });
});

/**
 * ROOMS QUEUE, NEVER STEER — pinned red-first even though it also
 * falls out of the routeKey inequality, because room rows now reach the
 * steer poller's pendingRows.
 */
describe('rooms QUEUE, never steer', () => {
  // `sessionKey` matters: the real codex app-server client surfaces the live
  // thread key on the steer call, and it is exactly that key entering
  // `runningKeys` that once made an owner 1:1 DM route-eligible into a ROOM
  // turn — a fake that omits it leaves attend's runningKeys.add path
  // untested (a review note).
  const steeringDriver = (opts: { reply?: string; sessionKey?: string } = {}) => {
    const steeredTexts: string[] = [];
    const prompts: string[] = [];
    let calls = 0;
    let release: (() => void) | undefined;
    const released = new Promise<void>(r => { release = r; });
    const driver: HostDriver = {
      host: 'codex',
      async runTurn(req: TurnRequest) {
        calls += 1;
        prompts.push(req.prompt);
        if (calls !== 1) {
          return { stdout: `turn ${calls} reply`, stderr: '', code: 0, refusal: null };
        }
        req.steering?.({
          ...(opts.sessionKey !== undefined ? { sessionKey: opts.sessionKey } : {}),
          steer: async text => {
            steeredTexts.push(text);
            return 'delivered';
          },
        });
        await released;
        return { stdout: opts.reply ?? 'first reply', stderr: '', code: 0, refusal: null };
      },
    };
    return { driver, steeredTexts, prompts, calls: () => calls, finish: () => release?.() };
  };

  beforeEach(() => {
    saveAttendConfig('bot', {
      host: 'codex', bin: '/opt/codex', workdir: '/w', caps: ['-s', 'read-only'],
      codexDriver: 'app-server', ownSession: OWN_SESSION, turnsPerHour: 10,
    });
  });

  it('a room row arriving during a live 1:1 turn QUEUES — never steers — and the next pass answers it into the room, marked', async () => {
    const h = harness();
    const fake = steeringDriver();
    seams.driver = fake.driver;
    const log = new MessageLog('bot');
    log.append(inRow('start the 1:1 work'));
    const clock = movingClock();
    const io = { ...h.io, ...clock };
    const run = attendOnce('bot', io);
    await poll(() => fake.calls() === 1);

    const r = roomRow('[crew] @you mid-turn room words', { gid: GID, men: true });
    log.append(r);
    // Give the poller several cadences to (wrongly) steer it.
    await new Promise(res => setTimeout(res, 150));
    fake.finish();
    expect(await run).toBe('answered');
    expect(fake.steeredTexts, 'a room row must NEVER ride turn/steer').toEqual([]);
    expect(bucketTurns(), 'no steer token was spent on it').toBe(1);

    // The queued room row is answered by the NEXT pass, into the room,
    // marked as having arrived mid-turn (the MID_TURN_MARKER path).
    expect(await attendOnce('bot', io)).toBe('answered');
    expect(fake.prompts[1]).toBe(`${MID_TURN_MARKER}\n[crew] @you mid-turn room words`);
    expect(h.roomReplies).toHaveLength(1);
    expect(h.roomReplies[0]?.gid).toBe(GID);
  }, 30_000);

  it('a SAME-ROOM row arriving during a live room turn also queues — steering is a 1:1-only surface', async () => {
    const h = harness();
    const fake = steeringDriver();
    seams.driver = fake.driver;
    const log = new MessageLog('bot');
    log.append(roomRow('[crew] @you the room turn', { gid: GID, men: true }));
    const io = { ...h.io, ...movingClock() };
    const run = attendOnce('bot', io);
    await poll(() => fake.calls() === 1);

    log.append(roomRow('[crew] @you while you work', { gid: GID, men: true }));
    await new Promise(res => setTimeout(res, 150));
    fake.finish();
    expect(await run).toBe('answered');
    expect(fake.steeredTexts, 'same room, same rule: QUEUE').toEqual([]);

    expect(await attendOnce('bot', io)).toBe('answered');
    expect(fake.prompts[1]).toBe(`${MID_TURN_MARKER}\n[crew] @you while you work`);
  }, 30_000);

  it('a PRIVATE 1:1 DM can never steer a ROOM turn: the room turn attaches no steer surface, the DM queues un-consumed and is answered as its own turn', async () => {
    // THE RELEASE BLOCKER'S EXACT SHAPE (adversarial an earlier review): a
    // codex app-server room turn resumes its stored thread T, the driver
    // surfaces sessionKey=T on the steer call, and the ledger holds a
    // 1:1 out row carrying sess.key=T (the shape an OLDER build's room-turn
    // excuse left behind — current code writes no such row, but real ledgers
    // keep history). An owner DM ref'ing that row then resolves to
    // session:T, which IS in runningKeys — so without the head.kind guard
    // the private DM rides turn/steer into the ROOM turn, its content shapes
    // an answer every member reads, and the journal consumes it so it is
    // never answered 1:1. Steering is a 1:1-only surface in
    // v1: a room turn must attach NO steering at all.
    const THREAD_KEY = '019ffbc9-e0fc-76c2-993a-fe59e971cd74';
    const log = new MessageLog('bot');
    mkdirSync(join(home, 'state', 'bot'), { recursive: true, mode: 0o700 });
    writeFileSync(
      statePath('attend-room-sessions.json'),
      JSON.stringify({ [GID]: { key: THREAD_KEY } }),
    );
    const old = {
      id: mid(), dir: 'out' as const, peer: OWNER, ts: Date.now(), tcm: '', text: '',
      read: true, sess: { host: 'codex', key: THREAD_KEY, tag: 's-old' },
    };
    log.append(old);

    const h = harness();
    const fake = steeringDriver({ sessionKey: THREAD_KEY });
    seams.driver = fake.driver;
    log.append(roomRow('[crew] @you run the room turn', { gid: GID, men: true }));
    const io = { ...h.io, ...movingClock() };
    const run = attendOnce('bot', io);
    await poll(() => fake.calls() === 1);

    const dm = inRow('private: the credentials are in ~/.env.prod', { ref: old.id });
    log.append(dm);
    // Give the poller several cadences to (wrongly) steer it.
    await new Promise(res => setTimeout(res, 150));
    fake.finish();
    expect(await run).toBe('answered');

    // Not steered, not consumed, no steer token spent.
    expect(fake.steeredTexts, 'a private DM must NEVER ride turn/steer into a ROOM turn').toEqual(
      [],
    );
    const j = existsSync(statePath('attend-journal.json'))
      ? (JSON.parse(readFileSync(statePath('attend-journal.json'), 'utf8')) as {
          steered?: string[]; midTurn?: string[];
        })
      : {};
    expect(j.steered ?? [], 'the DM is never journal-consumed').not.toContain(dm.id);
    expect(j.midTurn ?? [], 'it queued as a mid-turn arrival instead').toContain(dm.id);
    expect(bucketTurns(), 'no steer token was spent on it').toBe(1);
    // The room turn's answer went into the room; nothing 1:1 yet.
    expect(h.roomReplies).toHaveLength(1);
    expect(h.replies).toHaveLength(0);

    // The next pass answers the DM as ITS OWN turn, 1:1, marked as mid-turn.
    expect(await attendOnce('bot', io)).toBe('answered');
    expect(fake.calls()).toBe(2);
    expect(fake.prompts[1]).toBe(`${MID_TURN_MARKER}\nprivate: the credentials are in ~/.env.prod`);
    expect(h.replies, 'answered 1:1 — never into the room').toHaveLength(1);
    expect(h.roomReplies, 'the room never sees the DM turn').toHaveLength(1);
  }, 30_000);
});

/**
 * THE SESS LEAK CLOSED: a ROOM turn's 1:1 side
 * messages — failure excuses, 'Turn finished, no output.', refused-post
 * notices, approval cards — must carry NO session key. `realSendReply` writes
 * `sess` onto the 1:1 out ledger verbatim, and routeIn's ref arm and 2-hour
 * live-window arm resolve exactly that field — so a room thread key on any of
 * these rows lets an ordinary 1:1 reply (or a bare message in the window)
 * quietly RESUME the room transcript through the ledger path, the precise
 * confusion realSendRoomReply's own no-sess rule exists to kill. A reply to a
 * sessionless machinery row resolves the honest `ended` answer instead (the
 * codex-exec rule), and a bare 1:1 message keeps the documented own-session
 * default.
 */
describe('a ROOM turn’s 1:1 side messages carry NO session key', () => {
  const THREAD_KEY = '019ffbc9-e0fc-76c2-993a-fe59e971cd74';

  it('codex app-server: the captured thread key stays in the room store — never on the excuse or no-output rows', async () => {
    saveAttendConfig('bot', {
      host: 'codex', bin: '/opt/codex', workdir: '/w', caps: ['-s', 'read-only'],
      codexDriver: 'app-server', ownSession: OWN_SESSION, turnsPerHour: 10,
    });
    const h = harness();
    // Turn 1: fresh room turn captures T but FAILS — the 1:1 excuse must be
    // sessionless even though the driver just reported T.
    seams.driver = {
      host: 'codex',
      async runTurn() {
        return { stdout: '', stderr: 'boom', code: 1, refusal: null, sessionKey: THREAD_KEY };
      },
    };
    new MessageLog('bot').append(roomRow('[crew] @you try', { gid: GID, men: true }));
    expect(await attendOnce('bot', h.io)).toBe('failed');
    expect(h.replies[0]).toContain('turn failed');
    expect(
      h.replySess[0],
      'a room turn’s 1:1 excuse must not speak for the room thread',
    ).toBeUndefined();
    // The captured key still became the ROOM's stored continuity.
    const stored = JSON.parse(
      readFileSync(statePath('attend-room-sessions.json'), 'utf8'),
    ) as Record<string, { key?: string }>;
    expect(stored[GID]?.key).toBe(THREAD_KEY);

    // Turn 2: resumes the stored thread; empty output — the no-output notice
    // is sessionless too, even with the route KNOWING the key up front.
    const routes: unknown[] = [];
    seams.driver = {
      host: 'codex',
      async runTurn(req: TurnRequest) {
        routes.push(req.route);
        return { stdout: '', stderr: '', code: 0, refusal: null, sessionKey: THREAD_KEY };
      },
    };
    new MessageLog('bot').append(roomRow('[crew] @you again', { gid: GID, men: true }));
    expect(await attendOnce('bot', h.io)).toBe('answered');
    expect(routes[0], 'the room continuity itself is untouched').toEqual({
      kind: 'session', host: 'codex', key: THREAD_KEY,
    });
    expect(h.replies[1]).toBe('Turn finished, no output.');
    expect(h.replySess[1], 'the resumed room thread key never rides a 1:1 row').toBeUndefined();
  });

  it('claude: the pinned per-room session key never rides a 1:1 excuse row', async () => {
    const h = harness();
    h.setAnswer({ stdout: '', stderr: 'boom', code: 1 });
    new MessageLog('bot').append(roomRow('[crew] @you break', { gid: GID, men: true }));
    expect(await attendOnce('bot', h.io)).toBe('failed');
    expect(h.replies[0]).toContain('turn failed');
    expect(h.replySess[0], 'the pinned room key must not reach the 1:1 ledger').toBeUndefined();
    // The pin itself still exists — continuity lives in the room store ONLY.
    const stored = JSON.parse(
      readFileSync(statePath('attend-room-sessions.json'), 'utf8'),
    ) as Record<string, { key?: string }>;
    expect(stored[GID]?.key).toBeTruthy();
  });

  it('a room turn carries NO approval capability: the driver receives no ask funnel, the policy is forced to never, and no card is ever minted (the consent remediation)', async () => {
    saveAttendConfig('bot', {
      host: 'codex', bin: '/opt/codex', workdir: '/w', caps: ['-s', 'read-only'],
      codexDriver: 'app-server', codexApprovalPolicy: 'untrusted',
      ownSession: OWN_SESSION, turnsPerHour: 10,
    });
    // The old shape of this test had the driver CALL req.ask on a room turn
    // and asserted the resulting card was sessionless. That card no longer
    // exists to be sessionless: the ruled sentence is "non-owner-visible
    // output never meets write capability", and the approval lane IS the
    // capability that lets a turn out of its sandbox — so a room turn is
    // spawned with no ask funnel at all, and the operator's own
    // `codexApprovalPolicy` is overridden to 'never' for the spawn (the
    // host must not solicit what nothing can answer). Red-first: reverting
    // either half turns these assertions red.
    const reqs: TurnRequest[] = [];
    seams.driver = {
      host: 'codex',
      async runTurn(req: TurnRequest) {
        reqs.push(req);
        return { stdout: 'done: shipped', stderr: '', code: 0, refusal: null, sessionKey: THREAD_KEY };
      },
    };
    const h = harness();
    new MessageLog('bot').append(roomRow('[crew] @you deploy', { gid: GID, men: true }));
    expect(await attendOnce('bot', h.io)).toBe('answered');
    expect(reqs).toHaveLength(1);
    expect(
      reqs[0]!.ask,
      'a room turn must not carry the ask funnel — the approval lane is write capability',
    ).toBeUndefined();
    expect(
      reqs[0]!.cfg.codexApprovalPolicy,
      "the operator's approval policy is floored to 'never' for the room spawn",
    ).toBe('never');
    // No approval journal row was minted and no 1:1 card left the process.
    const journal = existsSync(statePath('attend-approvals.json'))
      ? (JSON.parse(readFileSync(statePath('attend-approvals.json'), 'utf8')) as {
          rows: unknown[];
        })
      : { rows: [] };
    expect(journal.rows).toHaveLength(0);
    expect(h.replies).toHaveLength(0);
    expect(h.roomReplies[0]?.body).toBe('done: shipped');
  });

  it('the 1:1 control: an owner 1:1 turn still carries the ask funnel and the operator’s own policy', async () => {
    saveAttendConfig('bot', {
      host: 'codex', bin: '/opt/codex', workdir: '/w', caps: ['-s', 'read-only'],
      codexDriver: 'app-server', codexApprovalPolicy: 'untrusted',
      ownSession: OWN_SESSION, turnsPerHour: 10,
    });
    const reqs: TurnRequest[] = [];
    seams.driver = {
      host: 'codex',
      async runTurn(req: TurnRequest) {
        reqs.push(req);
        return { stdout: 'done', stderr: '', code: 0, refusal: null };
      },
    };
    const h = harness();
    new MessageLog('bot').append(inRow('do the thing'));
    expect(await attendOnce('bot', h.io)).toBe('answered');
    expect(reqs).toHaveLength(1);
    expect(reqs[0]!.ask, 'the 1:1 approval surface is untouched').toBeTypeOf('function');
    expect(reqs[0]!.cfg.codexApprovalPolicy).toBe('untrusted');
  });
});

/**
 * NO PHANTOM ROOM KEY: the room pinned-key arm
 * used to match ANY claudeDriver other than 'sdk', so a hand-edited
 * attend.json naming a driver this build does not recognise minted AND STORED
 * a per-room session key for a turn the driver dispatch then refused — and a
 * later repair to `sdk` resumed that phantom UUID forever (the SDK has no
 * no-conversation recovery arm). The driver must be validated BEFORE any key
 * is minted or stored: a refusing turn leaves no room-session state.
 */
describe('an unrecognised claudeDriver mints no room session key', () => {
  it('the refusing turn stores NOTHING — no phantom key to wedge the room after repair', async () => {
    saveAttendConfig('bot', {
      host: 'claude', bin: '/opt/agent', workdir: '/w', caps: [],
      claudeDriver: 'daemon' as AttendConfig['claudeDriver'],
      ownSession: OWN_SESSION, turnsPerHour: 10,
    });
    const h = harness();
    new MessageLog('bot').append(roomRow('[crew] @you go', { gid: GID, men: true }));
    expect(await attendOnce('bot', h.io)).toBe('failed');
    expect(h.replies).toHaveLength(1);
    expect(h.roomReplies).toHaveLength(0);
    expect(
      existsSync(statePath('attend-room-sessions.json')),
      'a turn that refused must not have stored a session key',
    ).toBe(false);
  });
});
