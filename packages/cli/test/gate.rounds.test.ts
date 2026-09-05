import { beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OutSess, RoomReplyOutcome } from '../src/attend.js';
import type { FanoutLeg } from '../src/send.js';
import type { RoomDelivery } from '../src/room-commands.js';

/**
 * ROUNDS — attend's half, every clause red-first.
 *
 * A ROUND is one human turn plus the agents' answers to it. Each answer is a
 * BRIEF (what a phone shows) and a DETAIL (the full finding, behind a tap,
 * read in full by the sibling agents), written by ONE model in ONE message
 * under ONE ratchet-authenticated sender. The nouns are brief, detail and full
 * answer; "summary" is not one of them (R12), and nothing here may imply the
 * relay orders, attributes or verifies anything.
 *
 * The rulings this file pins:
 *  R2a  a structured mention authored by a KNOWN agent is inert in
 *       `triggers()`, room flag or no room flag;
 *  R2b  reply-once-per-round, on the cursor's round-key LIST (not a
 *       watermark — two rooms interleave);
 *  R3   the answer is a `reply` inside the `grp.msg` wrapper, never a new
 *       kind, `ref` = the human row's §5.3 key, `ofs` false;
 *  R5   the split, and fail-open: an unrecognised shape still answers;
 *  R13  `ROUND_KEY_RE` mirrors `ROOM_REF_RE` — compared by `.source` here,
 *       the one test file that may import both packages;
 *  R14  the brief crosses the SAME funnel at `BRIEF_MAX` instead of
 *       `ATTEND_REPLY_CAP`;
 *  R15  the sibling audience reads the ROOM OWNER's roster classes, never a
 *       sender's own `ai` marker;
 *  R20  the round key is written BEFORE the spawn;
 *  R22  a detail that fails `roundDetailStrict` after truncation is dropped
 *       and the answer is sent brief-only;
 *  R23  controls are normalized, and the COMPOSED wrapper is measured against
 *       `MAX_BODY_BYTES` before the fan-out can refuse it;
 *  R26  rounds is crew-only: a second human in the room and the widening is
 *       off.
 *
 * Same proof posture as gate.room-trigger.test.ts, whose harness this extends
 * verbatim: the spool, cursor, journal, bucket and room files are REAL files
 * in a temp home; only the turn spawn and the two reply transports are seams.
 * The clock MOVES (`now: () => (t += 20)`) — a frozen now() beside advancing
 * timers is what hid two release-blocking defects under a green suite.
 */

const home = mkdtempSync(join(tmpdir(), 'tacendum-rounds-'));
process.env.TACENDUM_HOME = home;
process.env.TACENDUM_API = 'http://rounds.test';
process.env.TACENDUM_WS = 'ws://rounds.test';

const seams = vi.hoisted(() => ({
  /** The fan-out transport under `realSendRoomReply` — faked so the LEDGER
   * minting and the `opts` (`ai`, `siblings`) are observed for real against
   * the real spool. Null means the real `sendRoomMessage`. Every argument
   * forwards: dropping `opts` is exactly how the `ai: true` marker once went
   * unobserved through a whole suite. */
  roomWire: null as
    | ((
        account: string,
        gid: string,
        text: string,
        opts?: { attach?: string | undefined; ai?: boolean; siblings?: boolean },
      ) => {
        m: string; delivered: string[]; skipped: string[]; preSkipped: string[];
        failed: string[]; outcomes: never[]; recipients: number; members: number;
      })
    | null,
}));
vi.mock('../src/room-commands.js', async importOriginal => {
  const real = await importOriginal<typeof import('../src/room-commands.js')>();
  return {
    ...real,
    sendRoomMessage: (async (...args: Parameters<typeof real.sendRoomMessage>) =>
      seams.roomWire !== null
        ? seams.roomWire(args[0], args[1], args[2], args[5])
        : real.sendRoomMessage(...args)) as typeof real.sendRoomMessage,
  };
});

const attendMod = await import('../src/attend.js');
const {
  ATTEND_REPLY_CAP,
  attendOnce,
  boundRoundAnswer,
  cmdAttendRounds,
  cmdAttendTriggers,
  loadAttendConfig,
  realSendRoomReply,
  attendState,
  roomTriggerGate,
  roundKeyOf,
  roundWrapperFits,
  roundsGids,
  roundsPromptBlock,
  saveAttendConfig,
  splitRoundAnswer,
} = attendMod;
const { MessageLog } = await import('../src/msglog.js');
const { saveProfile } = await import('../src/profile.js');
const { Reporter } = await import('../src/output.js');
const { FileGroupStore } = await import('../src/rooms.js');
const { CONTROL_CHARS } = await import('../src/render.js');
const roomCommands = await import('../src/room-commands.js');
const { ROOM_REF_RE, crewMateAgentIds, roomRefAuthor, sendRoomMessage } = roomCommands;
const { capChatHead, plainForChat } = await import('../src/hooks.js');
const { MAX_BODY_BYTES } = await import('../src/send.js');
const { applyGroupNew, applyRosterWrite, ownerOnlyPolicy } = await import(
  '@tacendum/shared/group-fold'
);
const {
  BRIEF_MAX,
  DETAIL_MAX,
  ROUND_KEY_RE,
  capDetail,
  detailTruncationMarker,
  roundKeyAuthor,
  stripWireControls,
} = await import('@tacendum/shared/rounds');

const report = () => new Reporter({ json: false, plain: true });

const OWNER = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const SELF = '01HQXW0000000000000000TEST';
const MATE = '01BX5ZZKBKACTAV9WEVGEMMVRY';
const HUMAN2 = '01CHMAN22AAAAAAAAAAAAAAAAA';
const OUTSIDER = '01CSTRANGERAAAAAAAAAAAAAAA';
const GID = '01GRPAAAAAAAAAAAAAAAAAAAAA';
const M1 = '01MSGAAAAAAAAAAAAAAAAAAAAA';
const M2 = '01MSGBBBBBBBBBBBBBBBBBBBBB';
const OWN_SESSION = 'ffffffff-9999-4999-8999-999999999999';

let seq = 0;
const mid = (): string => `01HQXS00000000000000${String(++seq).padStart(6, '0')}`.slice(0, 26);

const statePath = (file: string): string => join(home, 'state', 'bot', file);
const bucketTurns = (): number =>
  JSON.parse(readFileSync(statePath('attend-bucket.json'), 'utf8')).turns;
const journalBytes = (): string =>
  existsSync(statePath('attend-journal.json'))
    ? readFileSync(statePath('attend-journal.json'), 'utf8')
    : '';
const journalRounds = (): { key: string; split: string; detail: string; ref?: string }[] =>
  journalBytes() === ''
    ? []
    : ((JSON.parse(journalBytes()) as { rounds?: never[] }).rounds ?? []);
const journalClassBlind = (): { gid: string; at: number } | undefined =>
  journalBytes() === ''
    ? undefined
    : (JSON.parse(journalBytes()) as { classBlind?: { gid: string; at: number } }).classBlind;
const cursorRounds = (): string[] =>
  existsSync(statePath('attend-cursor.json'))
    ? ((JSON.parse(readFileSync(statePath('attend-cursor.json'), 'utf8')) as { rounds?: string[] })
        .rounds ?? [])
    : [];

/** A spooled room row, exactly as inbound.ts persists one — `rm` included
 * (R17), which is what makes a §5.3 ref buildable from the spool. */
function roomRow(
  text: string,
  opts: {
    peer?: string; gid?: string; men?: boolean; ref?: string; rm?: string; ai?: boolean;
    ts?: number;
  } = {},
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
    ...(opts.rm !== undefined ? { rm: opts.rm } : {}),
    ...(opts.ai === true ? { ai: true } : {}),
  };
}

type Answer = { stdout: string; stderr?: string; code: number };

const harness = () => {
  const replies: string[] = [];
  const roomReplies: { gid: string; body: string }[] = [];
  const turns: { argv: string[]; cwd: string; prompt: string }[] = [];
  let answer: Answer = { stdout: 'done: shipped', code: 0 };
  return {
    replies, roomReplies, turns,
    setAnswer: (a: Answer) => { answer = a; },
    io: {
      sendReply: async (b: string, _sess?: OutSess) => (replies.push(b), mid()),
      sendRoomReply: async (gid: string, body: string): Promise<RoomReplyOutcome> => {
        roomReplies.push({ gid, body });
        return { m: M2, delivered: [OWNER, MATE], skipped: [], failed: [] };
      },
      runTurn: async (argv: string[], cwd: string, prompt: string) =>
        (turns.push({ argv, cwd, prompt }), answer),
    },
  };
};

/** A MOVING clock (the frozen-clock ruling): now() advances on every read, so
 * no deadline arithmetic can hide behind a pinned instant. */
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

/** Anchor room `gid` on the agent's client: OWNER owns it, `members` are in
 * it, and `integrations` are the ids the OWNER's roster write CLASSES — the
 * one authority the sibling audience reads (R15). */
function seedRoom(
  gid: string,
  members: string[],
  integrations: string[] = [SELF],
  writerId: string = OWNER,
): void {
  const store = FileGroupStore.load('bot', gid);
  applyGroupNew(store, SELF, { writerId, members, seq: 1, integrations }, ownerOnlyPolicy);
  store.persist();
}

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

const roundsOn = (gid: string): void => cmdAttendRounds('bot', gid, 'on', report());
const flipTriggers = (gid: string): void => cmdAttendTriggers('bot', gid, 'on', report());

function recordingDeliver(captured: FanoutLeg[][]): RoomDelivery {
  return (async ({ legs }: { legs: FanoutLeg[] }) => {
    captured.push(legs);
    return legs.map(l => ({ to: l.to, msgId: l.msgId, state: 'delivered' as const }));
  }) as RoomDelivery;
}

/** Who a room send actually addressed, through the REAL fan-out machinery
 * (fold verdict, sq, rd, `roomContentRecipients`, `mintLegs`) with only the
 * transport faked. */
async function legsOf(gid: string, opts: { ai?: boolean; siblings?: boolean }): Promise<string[]> {
  const captured: FanoutLeg[][] = [];
  await sendRoomMessage('bot', gid, 'an answer', recordingDeliver(captured), undefined, opts);
  return captured.flat().map(l => l.to).sort();
}

beforeEach(() => {
  rmSync(join(home, 'bot'), { recursive: true, force: true });
  rmSync(join(home, 'state'), { recursive: true, force: true });
  seq = 0;
  seams.roomWire = null;
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

describe('the split (§3.4) — the grammar, on RAW stdout', () => {
  it('FORMATTED: BRIEF line(s), a separator, then the detail', () => {
    const out = 'BRIEF: the build is green\nBRIEF: nothing to do\n---\nthe long finding\nline two';
    expect(splitRoundAnswer(out)).toEqual({
      brief: 'the build is green nothing to do',
      detail: 'the long finding\nline two',
      how: 'formatted',
    });
  });

  it('HALF-FORMATTED: BRIEF line(s) with no separator — the rest is the detail', () => {
    const split = splitRoundAnswer('BRIEF: it failed\nhere is why\nand more');
    expect(split.how).toBe('half');
    expect(split.brief).toBe('it failed');
    expect(split.detail).toBe('here is why\nand more');
  });

  it('HALF-FORMATTED with nothing after it: no detail survives the bounds', () => {
    const bound = boundRoundAnswer(splitRoundAnswer('BRIEF: all done\n'));
    expect(bound.brief).toBe('all done');
    expect(bound.detail).toBeUndefined();
    expect(bound.state).toBe('none');
  });

  it('FAIL-OPEN (R5): an unrecognised shape still answers — first paragraph, WHOLE output as detail', () => {
    const out = 'I looked at the failing test.\nIt is the clock.\n\nThe rest of the reasoning.';
    const split = splitRoundAnswer(out);
    expect(split.how).toBe('derived');
    expect(split.brief).toBe('I looked at the failing test.\nIt is the clock.');
    expect(split.detail, 'the WHOLE output, never the remainder').toBe(out);
  });

  it('a lowercase "brief:" is PROSE and must not match — the case rule, red-first', () => {
    const split = splitRoundAnswer('brief: I looked at the failing test\nmore words');
    expect(split.how, 'a case-insensitive match would capture prose').toBe('derived');
    expect(split.brief).toBe('brief: I looked at the failing test\nmore words');
  });

  it('up to three spaces of indent are tolerated, four are not', () => {
    expect(splitRoundAnswer('   BRIEF: indented\n---\nbody').how).toBe('formatted');
    expect(splitRoundAnswer('    BRIEF: too far\n---\nbody').how).toBe('derived');
  });

  it('a separator of FOUR or more hyphens still separates', () => {
    const split = splitRoundAnswer('BRIEF: yes\n------\nthe detail');
    expect(split.how).toBe('formatted');
    expect(split.detail).toBe('the detail');
  });

  it('blank lines between the last BRIEF line and the separator are dropped', () => {
    const split = splitRoundAnswer('BRIEF: yes\n\n\n---\nthe detail');
    expect(split.how).toBe('formatted');
    expect(split.detail).toBe('the detail');
  });

  it('leading blank lines are skipped before the first BRIEF line', () => {
    expect(splitRoundAnswer('\n\nBRIEF: yes\n---\nd').how).toBe('formatted');
  });

  it('empty stdout yields an empty brief and no detail (step 9 is the caller’s emptiness gate)', () => {
    const bound = boundRoundAnswer(splitRoundAnswer(''));
    expect(bound.brief).toBe('');
    expect(bound.detail).toBeUndefined();
  });

  it('RULE 10: a detail equal to the brief is dropped — a disclosure over the same words is a lie about there being more', () => {
    const bound = boundRoundAnswer(splitRoundAnswer('BRIEF: one line\n---\none line'));
    expect(bound.brief).toBe('one line');
    expect(bound.detail).toBeUndefined();
    expect(bound.state).toBe('none');
  });

  it('STEP 7b: a bare BRIEF: line then --- then a finding DERIVES the brief — the answer is never dropped', () => {
    // Delete the fallback and this answer vanishes while the turn still
    // records ANSWERED under at-most-once: the finding is lost and never
    // re-run. That is the defect this case exists for.
    const bound = boundRoundAnswer(splitRoundAnswer('BRIEF:\n---\nthe finding.\n\nmore detail'));
    expect(bound.brief, 'derived from the detail’s first paragraph').toBe('the finding.');
    expect(bound.detail).toBe('the finding.\n\nmore detail');
    expect(bound.how, 'and the derivation is recorded as derived, never as a summary').toBe(
      'derived',
    );
  });
});

describe('the bounds (§3.4, R14/R23) — the brief funnel and the visible cut', () => {
  it('a 400-unit brief is clipped to BRIEF_MAX, not to ATTEND_REPLY_CAP', () => {
    const long = 'w '.repeat(400);
    const bound = boundRoundAnswer(splitRoundAnswer(`BRIEF: ${long}\n---\nthe detail`));
    expect(bound.brief.length).toBeLessThanOrEqual(BRIEF_MAX);
    expect(BRIEF_MAX, 'the round path is strictly TIGHTER than the ruled reply budget').toBeLessThan(
      ATTEND_REPLY_CAP,
    );
  });

  it('a 5 000-unit detail is truncated WITH THE VISIBLE MARKER — never silently', () => {
    const bound = boundRoundAnswer(
      splitRoundAnswer(`BRIEF: long one\n---\n${'d'.repeat(5000)}`),
    );
    expect(bound.detail?.length).toBeLessThanOrEqual(DETAIL_MAX);
    expect(bound.detail?.endsWith(detailTruncationMarker())).toBe(true);
    expect(bound.state).toBe('truncated');
  });

  it('the truncation marker is BYTE-STABLE through the chat degrader', () => {
    const marker = detailTruncationMarker();
    expect(capChatHead(plainForChat(marker), ATTEND_REPLY_CAP)).toBe(marker);
  });

  it('R23: 3 000 CONTROL characters compose a wrapper UNDER MAX_BODY_BYTES — the strip restores the budget', () => {
    const ESC = '\u001b';
    const brief = 'q'.repeat(200);
    const composed = (detail: string): string =>
      JSON.stringify({ tcm: 'reply', ref: `${OWNER}.${M1}`, ofs: false, text: brief, d: detail });
    // RAW: `JSON.stringify` escapes each control as six characters inside and
    // seven wire bytes once the wrapper re-escapes the backslash. That is the
    // overflow this normalization exists to prevent, and it happens INSIDE the
    // fan-out, where the refusal is reported to the owner as `no-room` for a
    // turn already recorded ANSWERED.
    expect(roundWrapperFits(composed(ESC.repeat(3000))), 'raw controls overflow').toBe(false);
    // NORMALIZED: the same answer through the composer's own cap. Delete the
    // strip and the composed body is the raw one above.
    const bound = boundRoundAnswer(
      splitRoundAnswer(`BRIEF: ${brief}\n---\n${(ESC + 'x').repeat(1500)}`),
    );
    expect(bound.detail, 'the words survive, the controls do not').toBe('x'.repeat(1500));
    expect(roundWrapperFits(composed(bound.detail as string))).toBe(true);
    // And an all-control detail normalizes to nothing, which the strict
    // fragment then refuses outright (R22).
    expect(capDetail(ESC.repeat(3000))).toBe('');
  });

  it('a detail that normalizes to nothing is DROPPED (R22), and the brief still goes', () => {
    const bound = boundRoundAnswer(
      splitRoundAnswer(`BRIEF: it worked\n---\n${'\u0000'.repeat(50)}`),
    );
    expect(bound.brief).toBe('it worked');
    expect(bound.detail).toBeUndefined();
  });

  it('a detail that survives as a leading ENVELOPE SENTINEL is refused by the STRICT fragment', () => {
    const bound = boundRoundAnswer(splitRoundAnswer('BRIEF: careful\n---\n{"tcm":"reply"}'));
    expect(bound.detail, 'a rendered forgery primitive never rides the disclosure').toBeUndefined();
    expect(bound.state).toBe('dropped');
  });

  // COMPOSE-STRICT ON `text`, not only on `d`. `ReplyEnvelope.text` IS
  // `bodyText`, which refuses a string beginning `{"tcm":` — so a BRIEF of
  // that shape composed anyway makes `parseEnvelope` return null on every
  // phone and loses the brief, the detail AND the reply linkage for a turn
  // already recorded ANSWERED, with no retry. R22 guards `d`; these guard the
  // field that decides whether the envelope parses at all.
  it('a BRIEF beginning with the ENVELOPE SENTINEL is re-derived from the detail — the finding is not lost', () => {
    const bound = boundRoundAnswer(
      splitRoundAnswer('BRIEF: {"tcm":"reply"} is the shape\n---\nthe finding, at length'),
    );
    expect(bound.brief, 'step 7b runs again rather than dropping the answer').toBe(
      'the finding, at length',
    );
    expect(bound.brief.startsWith('{"tcm":')).toBe(false);
    expect(bound.unsendable).toBeUndefined();
    expect(bound.how).toBe('derived');
  });

  it('a BRIEF beginning with the SENTINEL whose derivation is refused too is UNSENDABLE — never composed', () => {
    const bound = boundRoundAnswer(splitRoundAnswer('BRIEF: {"tcm":"reply"}'));
    expect(bound.unsendable, 'no envelope may be composed from a body the receiver refuses').toBe(
      true,
    );
    expect(bound.brief).toBe('');
  });
});

describe('the mirrors (R13) — one shape, two packages, drift made visible', () => {
  it('ROUND_KEY_RE mirrors ROOM_REF_RE, source for source', () => {
    expect(ROUND_KEY_RE.source).toBe(ROOM_REF_RE.source);
    expect(ROUND_KEY_RE.flags).toBe(ROOM_REF_RE.flags);
  });

  it('roundKeyAuthor and roomRefAuthor answer identically on the same inputs', () => {
    for (const ref of [`${OWNER}.${M1}`, OWNER, `${OWNER}.${M1}.${M2}`, 'nope', '']) {
      expect(roundKeyAuthor(ref)).toBe(roomRefAuthor(ref));
    }
  });

  it('stripWireControls removes exactly the CLI’s CONTROL_CHARS set, and keeps \\n and \\t', () => {
    // `WIRE_CONTROL_CHARS` is module-private in the shared package, so the pin
    // is BEHAVIOURAL rather than a `.source` compare: for every code point the
    // CLI's own sanitizer touches, the two must agree.
    for (let code = 0; code <= 0x9f; code += 1) {
      const ch = String.fromCharCode(code);
      expect(stripWireControls(ch), `U+${code.toString(16)}`).toBe(ch.replace(CONTROL_CHARS, ''));
    }
    expect(stripWireControls('a\nb\tc')).toBe('a\nb\tc');
  });
});

describe('the prompt block (§3.3) — byte-stable, and the AUTHOR on every quoted row', () => {
  const block = roundsPromptBlock({
    roomLabel: 'Kitchen',
    members: [
      { label: 'you', agent: true },
      { label: 'ana', agent: false },
      { label: 'codex', agent: true },
    ],
    asks: [{ label: 'ana', text: '[Kitchen] please look at the failing test' }],
    siblings: [{ label: 'codex', brief: 'the clock is frozen', detail: 'the whole finding' }],
  });

  it('is BYTE-IDENTICAL through the chat funnel — the MID_TURN_MARKER discipline', () => {
    expect(capChatHead(plainForChat(block), ATTEND_REPLY_CAP)).toBe(block);
  });

  it('names the room, the members with their agent labels, and every author', () => {
    expect(block).toContain('[room: Kitchen]');
    expect(block).toContain('[members: you (AI agent), ana, codex (AI agent)]');
    expect(block).toContain('[ana asked:]');
    expect(block).toContain('[codex (AI agent) already answered:]');
    expect(block).toContain('the whole finding');
  });

  it('is in §3.3’s ORDER — room, members, asks, siblings, format — pinned by index, not by containment', () => {
    const at = (needle: string): number => {
      const i = block.indexOf(needle);
      expect(i, needle).toBeGreaterThanOrEqual(0);
      return i;
    };
    // A sibling's answer is only legible AFTER the question it answers; the
    // human/sibling distinction is the one thing a round is made of.
    expect(at('[room: Kitchen]')).toBeLessThan(at('[members: '));
    expect(at('[members: ')).toBeLessThan(at('[ana asked:]'));
    expect(at('[ana asked:]')).toBeLessThan(at('[codex (AI agent) already answered:]'));
    expect(at('[codex (AI agent) already answered:]')).toBeLessThan(at('[format:'));
  });

  it('states the format in ONE physical line whose hyphens survive the degrader', () => {
    const format = block.split('\n').filter(l => l.startsWith('[format:'));
    expect(format).toHaveLength(1);
    expect(format[0]).toContain('(---)');
    expect(format[0]).toContain(String(BRIEF_MAX));
    // A BARE `---` line would be deleted by plainForChat before the model saw
    // the instruction telling it to write one.
    expect(block.split('\n').some(l => /^[ \t]{0,3}-{3,}[ \t]*$/.test(l))).toBe(false);
  });

  it('never says "summary" and never claims the relay did anything', () => {
    expect(block.toLowerCase()).not.toContain('summary');
    for (const word of ['audited', 'secret', 'stealth', 'panic']) {
      expect(block.toLowerCase()).not.toContain(word);
    }
  });
});

describe('the composition (R3, §3.2) — a reply inside the wrapper, ref to the human turn', () => {
  it('a rounds room answer is a `reply` whose ref is ${humanPeer}.${rm} and whose ofs is false', async () => {
    seedRoom(GID, [OWNER, SELF, MATE], [SELF, MATE]);
    roundsOn(GID);
    const h = harness();
    h.setAnswer({ stdout: 'BRIEF: the clock is frozen\n---\nthe whole finding, at length', code: 0 });
    new MessageLog('bot').append(roomRow('[Kitchen] @you look', { gid: GID, men: true, rm: M1 }));
    expect(await attendOnce('bot', { ...h.io, ...movingClock() })).toBe('answered');
    expect(h.roomReplies).toHaveLength(1);
    const inner = JSON.parse(h.roomReplies[0]?.body as string) as Record<string, unknown>;
    expect(inner.tcm).toBe('reply');
    expect(inner.ref).toBe(`${OWNER}.${M1}`);
    expect(inner.ofs, 'the quoted message is the HUMAN’s, never the replier’s').toBe(false);
    expect(inner.text).toBe('the clock is frozen');
    expect(inner.d).toBe('the whole finding, at length');
    expect(journalRounds()).toEqual([
      { key: `${OWNER}.${M1}`, split: 'formatted', detail: 'sent' },
    ]);
  });

  it('the marker rides BOTH the wrapper and the inner — one marking site, unchanged', async () => {
    seedRoom(GID, [OWNER, SELF], [SELF]);
    roundsOn(GID);
    const seen: { text: string; opts?: { ai?: boolean; siblings?: boolean } }[] = [];
    seams.roomWire = (_a, _g, text, opts) => {
      seen.push({ text, ...(opts === undefined ? {} : { opts }) });
      return {
        m: M2, delivered: [OWNER], skipped: [], preSkipped: [], failed: [],
        outcomes: [], recipients: 1, members: 2,
      };
    };
    const h = harness();
    // No `sendRoomReply` seam here: the answer must reach `realSendRoomReply`
    // and, through it, the observed `opts`.
    const io = { sendReply: h.io.sendReply, runTurn: h.io.runTurn };
    h.setAnswer({ stdout: 'BRIEF: done\n---\nthe finding', code: 0 });
    new MessageLog('bot').append(roomRow('[Kitchen] @you go', { gid: GID, men: true, rm: M1 }));
    expect(await attendOnce('bot', { ...io, ...movingClock() })).toBe('answered');
    expect(seen[0]?.opts?.ai, 'the Art. 50 marker is the room lane’s one option').toBe(true);
    const { markAgentBody } = await import('../src/ai-origin.js');
    const marked = JSON.parse(markAgentBody(seen[0]?.text as string, false)) as { ai?: boolean };
    expect(marked.ai, 'the envelope arm marks the inner too').toBe(true);
  });

  it('NO `rm` on the triggering row: bare text exactly as today, and the journal says ref-unavailable — never a guessed ref', async () => {
    seedRoom(GID, [OWNER, SELF], [SELF]);
    roundsOn(GID);
    const h = harness();
    h.setAnswer({ stdout: 'BRIEF: done\n---\nthe finding', code: 0 });
    new MessageLog('bot').append(roomRow('[Kitchen] @you go', { gid: GID, men: true }));
    expect(await attendOnce('bot', { ...h.io, ...movingClock() })).toBe('answered');
    expect(h.roomReplies[0]?.body, 'today’s bare funnelled text').toBe(
      'BRIEF: done\n\nthe finding',
    );
    expect(journalRounds()[0]?.ref).toBe('unavailable');
  });

  it('a SENTINEL-headed brief never reaches the transport as an envelope `text` (compose-strict)', async () => {
    seedRoom(GID, [OWNER, SELF], [SELF]);
    roundsOn(GID);
    const h = harness();
    // The named case: ordinary model output quoting a Tacendum envelope. The
    // derivation rescues it, so the answer still goes and the DETAIL is not
    // lost with the brief — what must never happen is an inner whose `text`
    // begins with the sentinel, which no phone can parse.
    h.setAnswer({ stdout: 'BRIEF: {"tcm":"reply"} is the shape\n---\nthe finding', code: 0 });
    new MessageLog('bot').append(roomRow('[Kitchen] @you go', { gid: GID, men: true, rm: M1 }));
    expect(await attendOnce('bot', { ...h.io, ...movingClock() })).toBe('answered');
    const inner = JSON.parse(h.roomReplies[0]?.body as string) as { text?: string };
    expect(inner.text).toBe('the finding');
    expect(inner.text?.startsWith('{"tcm":')).toBe(false);
    expect(journalRounds()[0]?.split).toBe('derived');
  });

  it('a brief this build cannot put on the wire at all sends TODAY’S BARE TEXT and journals `unsendable`', async () => {
    seedRoom(GID, [OWNER, SELF], [SELF]);
    roundsOn(GID);
    const h = harness();
    // No detail to derive from, so there is nothing sentinel-free to compose.
    h.setAnswer({ stdout: 'BRIEF: {"tcm":"reply"}', code: 0 });
    new MessageLog('bot').append(roomRow('[Kitchen] @you go', { gid: GID, men: true, rm: M1 }));
    expect(await attendOnce('bot', { ...h.io, ...movingClock() })).toBe('answered');
    expect(h.roomReplies[0]?.body, 'the words outrank the shape').toBe('BRIEF: {"tcm":"reply"}');
    expect(journalRounds()[0]?.ref).toBe('unsendable');
    expect(journalRounds()[0]?.key).toBe(`${OWNER}.${M1}`);
  });

  it('a room with rounds OFF answers byte-identically to before — bare text, no `d`, no journal line', async () => {
    seedRoom(GID, [OWNER, SELF], [SELF]);
    const h = harness();
    h.setAnswer({ stdout: 'BRIEF: done\n---\nthe finding', code: 0 });
    new MessageLog('bot').append(roomRow('[Kitchen] @you go', { gid: GID, men: true, rm: M1 }));
    expect(await attendOnce('bot', { ...h.io, ...movingClock() })).toBe('answered');
    expect(h.roomReplies[0]?.body).toBe('BRIEF: done\n\nthe finding');
    expect(journalRounds()).toEqual([]);
    expect(cursorRounds(), 'and no round key is recorded for an unflagged room').toEqual([]);
  });

  // NAMED FOR WHAT IT PROVES. The case as originally specified is "a composer
  // forced over MAX_BODY_BYTES sends brief-only with detail-dropped"; that
  // arm is UNREACHABLE THROUGH THIS FUNNEL BY ARITHMETIC and is therefore not
  // what this case asserts. The brief is capped at BRIEF_MAX (280) and the
  // detail at DETAIL_MAX (3 000), so the worst composed wrapper is
  // (280 + 3 000) x 4 + ~273 = 13 393 bytes against MAX_BODY_BYTES = 16 384.
  // What this case proves is the pair R23 exists for: the WORST answer a
  // model can write still leaves the transport a body under the cap, and the
  // owner is told nothing false about a turn already recorded ANSWERED. The
  // re-compose branch itself is exercised at the predicate
  // (`roundWrapperFits`, the next case) and is deliberately left as an
  // unreachable belt — recorded in the phase Outcome rather than dressed up
  // as covered.
  it('R23 IN THE WORST CASE THE FUNNEL ALLOWS: the transport never sees an over-cap body, and no false room refusal', async () => {
    seedRoom(GID, [OWNER, SELF], [SELF]);
    roundsOn(GID);
    const h = harness();
    // 3 000 units of `"` is the 4-bytes-per-unit worst case; with a 2 000-unit
    // brief the composed wrapper crosses MAX_BODY_BYTES, which the fan-out
    // would refuse as EXIT.USAGE and this pass would report to the owner as
    // "not in that room any more" — for a turn already recorded ANSWERED.
    h.setAnswer({
      stdout: `BRIEF: ${'"'.repeat(1990)}\n---\n${'"'.repeat(3000)}`,
      code: 0,
    });
    new MessageLog('bot').append(roomRow('[Kitchen] @you go', { gid: GID, men: true, rm: M1 }));
    expect(await attendOnce('bot', { ...h.io, ...movingClock() })).toBe('answered');
    const body = h.roomReplies[0]?.body as string;
    expect(Buffer.byteLength(body, 'utf8')).toBeLessThanOrEqual(MAX_BODY_BYTES);
    expect(roundWrapperFits(body), 'the WRAPPER, not just the inner, fits').toBe(true);
    expect(h.replies, 'and the owner is told nothing false about the room').toEqual([]);
  });

  it('an over-cap composed wrapper is measured on the FINAL bytes, marker included', () => {
    // `capDetail` bounds the detail, so the only way past the budget is a
    // brief the funnel let through — which is exactly why the composer
    // measures rather than trusting the two caps to multiply out.
    const huge = JSON.stringify({
      tcm: 'reply', ref: `${OWNER}.${M1}`, ofs: false,
      text: '"'.repeat(2000), d: '"'.repeat(DETAIL_MAX),
    });
    expect(roundWrapperFits(huge)).toBe(false);
    const brief = JSON.stringify({
      tcm: 'reply', ref: `${OWNER}.${M1}`, ofs: false, text: '"'.repeat(2000),
    });
    expect(roundWrapperFits(brief)).toBe(true);
  });
});

describe('the once-per-round guard (R2b/R20)', () => {
  it('two spool rows of ONE round produce exactly one turn and exactly one token', async () => {
    seedRoom(GID, [OWNER, SELF], [SELF]);
    roundsOn(GID);
    const h = harness();
    const io = { ...h.io, ...movingClock() };
    new MessageLog('bot').append(roomRow('[Kitchen] @you go', { gid: GID, men: true, rm: M1 }));
    expect(await attendOnce('bot', io)).toBe('answered');
    expect(h.turns).toHaveLength(1);
    expect(bucketTurns()).toBe(1);
    // The same round key arrives again — a redelivery recovered from the
    // quarantine, a spool row re-presented. One human turn, one answer.
    new MessageLog('bot').append(roomRow('[Kitchen] @you go', { gid: GID, men: true, rm: M1 }));
    expect(await attendOnce('bot', io)).toBe('round-done');
    expect(h.turns, 'no second turn').toHaveLength(1);
    expect(h.roomReplies, 'no second answer').toHaveLength(1);
    expect(bucketTurns(), 'and no second token').toBe(1);
  });

  it('the key is on the CURSOR, so the guard survives a process restart', async () => {
    seedRoom(GID, [OWNER, SELF], [SELF]);
    roundsOn(GID);
    const h = harness();
    new MessageLog('bot').append(roomRow('[Kitchen] @you go', { gid: GID, men: true, rm: M1 }));
    expect(await attendOnce('bot', { ...h.io, ...movingClock() })).toBe('answered');
    // Re-read from DISK, never re-derived: a fresh process sees exactly this.
    expect(cursorRounds()).toContain(`${OWNER}.${M1}`);
    const h2 = harness();
    new MessageLog('bot').append(roomRow('[Kitchen] @you go', { gid: GID, men: true, rm: M1 }));
    expect(await attendOnce('bot', { ...h2.io, ...movingClock() })).toBe('round-done');
    expect(h2.turns).toHaveLength(0);
  });

  it('a DIFFERENT round in the same room still answers — a list, never a watermark', async () => {
    seedRoom(GID, [OWNER, SELF], [SELF]);
    roundsOn(GID);
    const h = harness();
    const io = { ...h.io, ...movingClock() };
    new MessageLog('bot').append(roomRow('[Kitchen] @you one', { gid: GID, men: true, rm: M1 }));
    expect(await attendOnce('bot', io)).toBe('answered');
    new MessageLog('bot').append(roomRow('[Kitchen] @you two', { gid: GID, men: true, rm: M2 }));
    expect(await attendOnce('bot', io)).toBe('answered');
    expect(h.turns).toHaveLength(2);
    expect(cursorRounds()).toEqual([`${OWNER}.${M1}`, `${OWNER}.${M2}`]);
  });

  it('TWO human rows in ONE batch record BOTH keys — a redelivery of the FIRST is still guarded', async () => {
    seedRoom(GID, [OWNER, SELF], [SELF]);
    roundsOn(GID);
    const h = harness();
    const io = { ...h.io, ...movingClock() };
    const log = new MessageLog('bot');
    // One route, one leading run, ONE turn — and that turn answers both rows.
    log.append(roomRow('[Kitchen] @you first', { gid: GID, men: true, rm: M1 }));
    log.append(roomRow('[Kitchen] @you second', { gid: GID, men: true, rm: M2 }));
    expect(await attendOnce('bot', io)).toBe('answered');
    expect(h.turns, 'one batch, one turn').toHaveLength(1);
    expect(cursorRounds().sort()).toEqual([`${OWNER}.${M1}`, `${OWNER}.${M2}`].sort());
    // The FIRST row alone comes back — a quarantine recovery, a re-presented
    // spool row. Keying on `last` alone would spawn a second turn here and
    // post a second answer to a message already answered.
    log.append(roomRow('[Kitchen] @you first', { gid: GID, men: true, rm: M1 }));
    expect(await attendOnce('bot', io)).toBe('round-done');
    expect(h.turns, 'no second turn').toHaveLength(1);
    expect(h.roomReplies, 'no second answer').toHaveLength(1);
  });

  it('roundKeyOf is null without `rm` or without `grp` — a row this build cannot key it does not claim to dedupe', () => {
    expect(roundKeyOf(roomRow('x', { gid: GID, rm: M1 }))).toBe(`${OWNER}.${M1}`);
    expect(roundKeyOf(roomRow('x', { gid: GID }))).toBeNull();
    expect(roundKeyOf(roomRow('x', { rm: M1 }))).toBeNull();
  });

  it('the key is written BEFORE the spawn (R20): a turn that dies mid-run leaves the round answered', async () => {
    seedRoom(GID, [OWNER, SELF], [SELF]);
    roundsOn(GID);
    const h = harness();
    const io = {
      ...h.io,
      ...movingClock(),
      runTurn: async (): Promise<never> => {
        // The key must already be on disk at the moment of the spawn.
        expect(cursorRounds()).toContain(`${OWNER}.${M1}`);
        throw new Error('the laptop lid closed');
      },
    };
    new MessageLog('bot').append(roomRow('[Kitchen] @you go', { gid: GID, men: true, rm: M1 }));
    await expect(attendOnce('bot', io)).rejects.toThrow();
    expect(cursorRounds()).toContain(`${OWNER}.${M1}`);
  });
});

describe('the class clause (R2a) — an agent-authored mention starts no turn', () => {
  it('a mention authored by a CLASSED agent is inert in an ARMED room', async () => {
    seedRoom(GID, [OWNER, SELF, MATE], [SELF, MATE]);
    flipTriggers(GID);
    roundsOn(GID);
    const h = harness();
    new MessageLog('bot').append(
      roomRow('[Kitchen] @you chain this', { peer: MATE, gid: GID, men: true, rm: M1 }),
    );
    expect(await attendOnce('bot', { ...h.io, ...movingClock() })).toBe('idle');
    expect(h.turns, 'delete the clause and this goes green — the mutation is caught').toHaveLength(
      0,
    );
    expect(h.roomReplies).toHaveLength(0);
  });

  it('a HUMAN co-member’s mention in the same armed room still triggers — the clause is about class, not about non-owners', async () => {
    seedRoom(GID, [OWNER, SELF, HUMAN2], [SELF]);
    flipTriggers(GID);
    const h = harness();
    new MessageLog('bot').append(
      roomRow('[Kitchen] @you please look', { peer: HUMAN2, gid: GID, men: true, rm: M1 }),
    );
    expect(await attendOnce('bot', { ...h.io, ...movingClock() })).toBe('answered');
    expect(h.turns).toHaveLength(1);
  });

  // THE FAIL-CLOSED DIRECTION, EXERCISED. The clause's own comment says a
  // class read this client cannot complete answers "agent" and refuses the
  // turn. That branch was unreachable while the gate read the PRUNING reader
  // (`roomAgentAuthorIds`), which swallows every failure into ∅ — and ∅ means
  // `has(peer)` false, i.e. fail-OPEN, the exact opposite of the documented
  // direction. `roomAgentAuthorIdsStrict` is what makes it reachable.
  it('a room whose OWN RECORD will not read answers AGENT for everybody — fail-closed, and it is reported', () => {
    const seen: { gid: string; blind: boolean }[] = [];
    // No `seedRoom`: the room store has no owner, so the class read cannot
    // complete. HUMAN2 is not an agent anywhere, and is still refused.
    const gate = roomTriggerGate(
      'bot',
      { roomTriggers: [GID], roomTriggerArmedAt: { [GID]: 1 } },
      (gid, blind) => seen.push({ gid, blind }),
    );
    expect(gate.agentAuthor?.(GID, HUMAN2), 'fail-CLOSED to true').toBe(true);
    expect(seen, 'the gid alone, and the outcome — no peer, no text, no length').toEqual([
      { gid: GID, blind: true },
    ]);
    // Memoized: one read per gid per sweep, one report per gid per sweep.
    expect(gate.agentAuthor?.(GID, OUTSIDER)).toBe(true);
    expect(seen).toHaveLength(1);
  });

  it('a room that DOES read answers by class, and reports the CLEAR read — the note can be retracted', () => {
    seedRoom(GID, [OWNER, SELF, HUMAN2, MATE], [SELF, MATE]);
    const seen: { gid: string; blind: boolean }[] = [];
    const gate = roomTriggerGate(
      'bot',
      { roomTriggers: [GID], roomTriggerArmedAt: { [GID]: 1 } },
      (gid, blind) => seen.push({ gid, blind }),
    );
    expect(gate.agentAuthor?.(GID, HUMAN2)).toBe(false);
    expect(gate.agentAuthor?.(GID, MATE)).toBe(true);
    expect(seen).toEqual([{ gid: GID, blind: false }]);
  });

  it('the blind read lands in the journal as a gid and a stamp, and a later CLEAR read retracts it', async () => {
    flipTriggers(GID);
    const h = harness();
    const log = new MessageLog('bot');
    // Pass 1: the room is not anchored on this client, so the class read is
    // blind. The mention is refused and the operator gets the one signal.
    log.append(roomRow('[Kitchen] @you look', { peer: HUMAN2, gid: GID, men: true, rm: M1 }));
    expect(await attendOnce('bot', { ...h.io, ...movingClock() })).toBe('idle');
    expect(h.turns).toHaveLength(0);
    const blind = journalClassBlind();
    expect(blind?.gid).toBe(GID);
    expect(typeof blind?.at).toBe('number');
    expect(Object.keys(blind ?? {}).sort(), 'rule 4: a gid and a stamp, nothing else').toEqual([
      'at',
      'gid',
    ]);
    // Pass 2: the room reads. A note that never retracts turns a transient
    // error into a permanent signal pointing at a room readable for weeks.
    seedRoom(GID, [OWNER, SELF, HUMAN2], [SELF]);
    log.append(roomRow('[Kitchen] @you look again', { peer: HUMAN2, gid: GID, men: true, rm: M2 }));
    expect(await attendOnce('bot', { ...h.io, ...movingClock() })).toBe('answered');
    expect(journalClassBlind(), 'the clear read retracted it').toBeUndefined();
  });

  it('a member the MARKER half alone calls an agent is also refused — the union is what triggers reads', async () => {
    seedRoom(GID, [OWNER, SELF, MATE], [SELF]);
    flipTriggers(GID);
    const log = new MessageLog('bot');
    // One AI-marked row from MATE teaches the marker half.
    log.append(roomRow('[Kitchen] hello', { peer: MATE, gid: GID, ai: true, rm: M2 }));
    log.append(roomRow('[Kitchen] @you chain', { peer: MATE, gid: GID, men: true, rm: M1 }));
    const h = harness();
    expect(await attendOnce('bot', { ...h.io, ...movingClock() })).toBe('idle');
    expect(h.turns).toHaveLength(0);
  });
});

describe('the sibling audience (§3.6, R15/R26) — legs, on the REAL fan-out', () => {
  it('KEPT when rounds is on, PRUNED when it is off — the pair is the proof', async () => {
    seedRoom(GID, [OWNER, SELF, MATE], [SELF, MATE]);
    expect(await legsOf(GID, { ai: true })).toEqual([OWNER]);
    expect(await legsOf(GID, { ai: true, siblings: true })).toEqual([MATE, OWNER].sort());
  });

  it('a room owned by SOMEBODY ELSE keeps the pruning even with the flag on (R15)', async () => {
    seedRoom(GID, [OUTSIDER, SELF, MATE], [SELF, MATE], OUTSIDER);
    expect(crewMateAgentIds('bot', GID)).toEqual(new Set());
    // The pruning holds entire: MATE is a classed agent this frame neither
    // addresses nor owns, so it loses its leg exactly as it would with the
    // flag off. Only the human keeps one.
    expect(await legsOf(GID, { ai: true, siblings: true })).toEqual([OUTSIDER]);
  });

  it('A SECOND HUMAN keeps the pruning (R26), and removing them widens again — the pair proves the clause', async () => {
    seedRoom(GID, [OWNER, SELF, MATE, HUMAN2], [SELF, MATE]);
    expect(crewMateAgentIds('bot', GID), 'crew-only: a co-member’s D4 edge is per agent').toEqual(
      new Set(),
    );
    expect(await legsOf(GID, { ai: true, siblings: true })).toEqual([HUMAN2, OWNER].sort());
    removeMember(GID, HUMAN2, 2);
    expect(crewMateAgentIds('bot', GID)).toEqual(new Set([MATE]));
    expect(await legsOf(GID, { ai: true, siblings: true })).toEqual([MATE, OWNER].sort());
  });

  it('the MARKER half alone never widens: an ai-marked member with no fold class is not a sibling', async () => {
    seedRoom(GID, [OWNER, SELF, MATE], [SELF]);
    new MessageLog('bot').append(roomRow('[Kitchen] hi', { peer: MATE, gid: GID, ai: true }));
    expect(crewMateAgentIds('bot', GID), 'a sender’s own claim can never buy a leg').toEqual(
      new Set(),
    );
    expect(await legsOf(GID, { ai: true, siblings: true })).toEqual([OWNER]);
  });

  it('NO HUMAN LEG IS EVER TOUCHED in either direction', async () => {
    seedRoom(GID, [OWNER, SELF, MATE], [SELF, MATE]);
    expect(await legsOf(GID, { ai: true })).toContain(OWNER);
    expect(await legsOf(GID, { ai: true, siblings: true })).toContain(OWNER);
  });

  it('realSendRoomReply asks for siblings exactly when the room’s flag is on', async () => {
    seedRoom(GID, [OWNER, SELF, MATE], [SELF, MATE]);
    const seen: (boolean | undefined)[] = [];
    seams.roomWire = (_a, _g, _t, opts) => {
      seen.push(opts?.siblings);
      return {
        m: M2, delivered: [OWNER], skipped: [], preSkipped: [], failed: [],
        outcomes: [], recipients: 1, members: 3,
      };
    };
    await realSendRoomReply('bot', GID, 'an answer');
    expect(seen[0], 'off by default').toBeUndefined();
    roundsOn(GID);
    await realSendRoomReply('bot', GID, 'an answer');
    expect(seen[1]).toBe(true);
  });
});

describe('the flag surface (§3.9) — attend rounds', () => {
  it('on, off, and the read-back all go through the ONE reader', () => {
    expect([...roundsGids(loadAttendConfig('bot'))]).toEqual([]);
    cmdAttendRounds('bot', GID, 'on', report());
    expect([...roundsGids(loadAttendConfig('bot'))]).toEqual([GID]);
    cmdAttendRounds('bot', GID, 'off', report());
    expect([...roundsGids(loadAttendConfig('bot'))]).toEqual([]);
  });

  it('an idempotent re-`on` keeps the ORIGINAL stamp — a re-statement must not re-date a grant', () => {
    cmdAttendRounds('bot', GID, 'on', report());
    const first = loadAttendConfig('bot')?.roundsArmedAt?.[GID] as number;
    expect(first).toBeGreaterThan(0);
    cmdAttendRounds('bot', GID, 'on', report());
    expect(loadAttendConfig('bot')?.roundsArmedAt?.[GID]).toBe(first);
  });

  it('fails closed on a hand edit: a gid with no stamp reads as OFF', () => {
    saveAttendConfig('bot', {
      ...(loadAttendConfig('bot') as NonNullable<ReturnType<typeof loadAttendConfig>>),
      rounds: [GID],
    });
    expect([...roundsGids(loadAttendConfig('bot'))]).toEqual([]);
  });

  it('`attend status` states the rounds grant, through the composer’s OWN reader', () => {
    // The precedent (2026-08-15): the D3 grant was "the only grant
    // absent from status". Rounds is the second durable, per-room,
    // operator-granted capability and it changes who this agent's answers are
    // DELIVERED to. Gids only — the same value `attend rounds` already prints.
    cmdAttendRounds('bot', GID, 'on', report());
    expect(attendState('bot').roundsRooms).toEqual([...roundsGids(loadAttendConfig('bot'))].sort());
    expect(attendState('bot').roundsRooms).toEqual([GID]);
    cmdAttendRounds('bot', GID, 'off', report());
    expect(attendState('bot').roundsRooms, 'OFF is the default and status says so').toEqual([]);
  });

  it('refuses a non-gid without echoing it, and refuses a missing verb', () => {
    expect(() => cmdAttendRounds('bot', 'not-a-gid', 'on', report())).toThrow(/Crockford base32/);
    expect(() => cmdAttendRounds('bot', GID, 'maybe', report())).toThrow(/usage/);
  });

  it('the on-copy states the widening WITH its condition, and never says summary', () => {
    let said = '';
    const capture = { emit: (_j: unknown, text: string) => { said = text; } } as unknown as
      Parameters<typeof cmdAttendRounds>[3];
    cmdAttendRounds('bot', GID, 'on', capture);
    expect(said).toContain('brief');
    expect(said).toContain('detail');
    expect(said).toContain('second person');
    expect(said.toLowerCase()).not.toContain('summary');
    expect(said.toLowerCase()).not.toContain('audited');
  });
});

describe('rule 4 — the prompt, the brief and the detail reach the host and nowhere else', () => {
  it('no byte of the fixture appears in the journal file, the reporter output or stderr', async () => {
    seedRoom(GID, [OWNER, SELF, MATE], [SELF, MATE]);
    roundsOn(GID);
    const HUMAN_WORDS = 'ZZFIXTUREHUMANWORDS';
    const BRIEF = 'ZZFIXTUREBRIEFWORDS';
    const DETAIL = 'ZZFIXTUREDETAILWORDS';
    const SIBLING = 'ZZFIXTURESIBLINGWORDS';
    const log = new MessageLog('bot');
    log.append(roomRow(`[Kitchen] ${SIBLING}`, { peer: MATE, gid: GID, ai: true, rm: M2 }));
    log.append(roomRow(`[Kitchen] ${HUMAN_WORDS}`, { gid: GID, men: true, rm: M1 }));
    const h = harness();
    h.setAnswer({ stdout: `BRIEF: ${BRIEF}\n---\n${DETAIL}`, code: 0 });
    const sinks: string[] = [];
    const spies = [
      vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void sinks.push(a.join(' '))),
      vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void sinks.push(a.join(' '))),
      vi.spyOn(process.stdout, 'write').mockImplementation(((c: string) => (sinks.push(String(c)), true)) as never),
      vi.spyOn(process.stderr, 'write').mockImplementation(((c: string) => (sinks.push(String(c)), true)) as never),
    ];
    try {
      expect(await attendOnce('bot', { ...h.io, ...movingClock() })).toBe('answered');
    } finally {
      for (const s of spies) s.mockRestore();
    }
    // The prompt DID carry all of it — otherwise this proves nothing.
    const prompt = h.turns[0]?.prompt as string;
    for (const word of [HUMAN_WORDS, SIBLING]) expect(prompt).toContain(word);
    expect(prompt).toContain('[format:');
    // And no sink but the host saw a byte of it.
    const out = sinks.join('\n');
    for (const word of [HUMAN_WORDS, BRIEF, DETAIL, SIBLING, '[format:', '[members:']) {
      expect(journalBytes(), `journal must not carry ${word}`).not.toContain(word);
      expect(out, `output must not carry ${word}`).not.toContain(word);
    }
    // What the journal DOES carry is the classification and the round key.
    expect(journalRounds()[0]?.split).toBe('formatted');
    expect(journalBytes()).not.toContain('summary');
  });

  it('the prompt block carries the sibling’s brief with its AUTHOR, and never reaches back past the arming stamp', async () => {
    seedRoom(GID, [OWNER, SELF, MATE], [SELF, MATE]);
    const log = new MessageLog('bot');
    // Banked BEFORE the flip: sent under the old audience rule, so it is
    // never read as context by anybody.
    log.append(roomRow('[Kitchen] ZZOLDSIBLINGWORDS', { peer: MATE, gid: GID, ai: true, ts: 1000 }));
    roundsOn(GID);
    log.append(roomRow('[Kitchen] ZZNEWSIBLINGWORDS', { peer: MATE, gid: GID, ai: true }));
    log.append(roomRow('[Kitchen] ZZASKWORDS', { gid: GID, men: true, rm: M1 }));
    const h = harness();
    expect(await attendOnce('bot', { ...h.io, ...movingClock() })).toBe('answered');
    const prompt = h.turns[0]?.prompt as string;
    expect(prompt).toContain('ZZNEWSIBLINGWORDS');
    expect(prompt, 'a row banked while rounds was OFF is never context').not.toContain(
      'ZZOLDSIBLINGWORDS',
    );
    expect(prompt).toContain('[room: ');
    expect(prompt).toContain(' asked:]');
  });

  /** Arm rounds by hand at an EARLY stamp. `cmdAttendRounds` stamps `now`,
   * and `MessageLog.append` clamps a future `ts` to now, so a window whose
   * lower bound is the arming stamp leaves no room to place a row BEFORE the
   * ask and AFTER the arming. The hand-written stamp is the same shape the
   * one parser reads (`roundsArm`) — the flag surface's own tests pin that. */
  const armRoundsAt = (gid: string, at: number): void => {
    const cfg = loadAttendConfig('bot') as NonNullable<ReturnType<typeof loadAttendConfig>>;
    saveAttendConfig('bot', { ...cfg, rounds: [gid], roundsArmedAt: { [gid]: at } });
  };

  it('the sibling window is floored at THIS round: a PREVIOUS round’s answers are not "already answered"', async () => {
    seedRoom(GID, [OWNER, SELF, MATE], [SELF, MATE]);
    armRoundsAt(GID, 1000);
    const t = Date.now();
    const log = new MessageLog('bot');
    // Banked well before this round's ask (and after the arming stamp, so the
    // arming floor is NOT what excludes it): an answer to an OLDER question.
    log.append(roomRow('[Kitchen] ZZLASTROUNDWORDS', { peer: MATE, gid: GID, ai: true, ts: t - 3_600_000 }));
    log.append(roomRow('[Kitchen] ZZASKWORDS', { gid: GID, men: true, rm: M1, ts: t - 5_000 }));
    log.append(roomRow('[Kitchen] ZZTHISROUNDWORDS', { peer: MATE, gid: GID, ai: true, ts: t - 1_000 }));
    const h = harness();
    expect(await attendOnce('bot', { ...h.io, ...movingClock() })).toBe('answered');
    const prompt = h.turns[0]?.prompt as string;
    expect(prompt, 'a sibling row from THIS round is context').toContain('ZZTHISROUNDWORDS');
    expect(
      prompt,
      'a PREVIOUS round’s answer must not be shown as answering this question',
    ).not.toContain('ZZLASTROUNDWORDS');
  });

  it('a sibling row inside the SKEW tolerance still counts — a crew-mate’s clock may trail', async () => {
    seedRoom(GID, [OWNER, SELF, MATE], [SELF, MATE]);
    armRoundsAt(GID, 1000);
    const t = Date.now();
    const log = new MessageLog('bot');
    log.append(roomRow('[Kitchen] ZZASKWORDS', { gid: GID, men: true, rm: M1, ts: t - 5_000 }));
    // Stamped 10 s BEFORE the ask on ITS machine — inside the tolerance.
    log.append(roomRow('[Kitchen] ZZSKEWEDWORDS', { peer: MATE, gid: GID, ai: true, ts: t - 15_000 }));
    const h = harness();
    expect(await attendOnce('bot', { ...h.io, ...movingClock() })).toBe('answered');
    expect(h.turns[0]?.prompt).toContain('ZZSKEWEDWORDS');
  });

  // THE HAND-OFF, WITH A TRIPWIRE. The sibling `detail` is read through a
  // widening cast until `MessageRecord.detail` lands; if that field is named
  // anything else the cast reads undefined FOREVER and nothing fails.
  // This case fails loudly if the prompt stops carrying a row's `detail`, and
  // it pins §3.3's "clipped to DETAIL_MAX" at the same time.
  it('a spooled row’s `detail` reaches the block, CLIPPED to DETAIL_MAX (§3.3) — the tripwire', async () => {
    seedRoom(GID, [OWNER, SELF, MATE], [SELF, MATE]);
    armRoundsAt(GID, 1000);
    const t = Date.now();
    const log = new MessageLog('bot');
    log.append(roomRow('[Kitchen] ZZASKWORDS', { gid: GID, men: true, rm: M1, ts: t - 5_000 }));
    log.append({
      ...roomRow('[Kitchen] ZZSIBBRIEF', { peer: MATE, gid: GID, ai: true, ts: t - 1_000 }),
      // `append` stringifies the record whole, so an extra key survives — the
      // field that lands later, present ahead of it.
      detail: `ZZDETAILHEAD${'d'.repeat(DETAIL_MAX * 2)}`,
    } as unknown as Parameters<MessageLog['append']>[0]);
    const h = harness();
    expect(await attendOnce('bot', { ...h.io, ...movingClock() })).toBe('answered');
    const prompt = h.turns[0]?.prompt as string;
    expect(prompt, 'the sibling’s DETAIL is context, not only its brief').toContain('ZZDETAILHEAD');
    expect(prompt).toContain('ZZSIBBRIEF');
    const line = prompt.split('\n').find(l => l.startsWith('ZZDETAILHEAD')) ?? '';
    expect(line.length, 'the assertion below must not pass vacuously').toBeGreaterThan(0);
    expect(line.length, 'clipped at the site, by the composer’s own capDetail').toBeLessThanOrEqual(
      DETAIL_MAX,
    );
  });
});
