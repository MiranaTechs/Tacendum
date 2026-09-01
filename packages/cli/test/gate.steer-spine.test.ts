import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OutSess } from '../src/attend.js';
import type { HostDriver, SteerResult, TurnRequest } from '../src/attend-drivers.js';

/**
 * MID-TURN STEERING, SUPERVISOR SIDE
 * — the steer poller's predicate, the journal-first crash contract, the
 * budget's one-token-per-delivered-steer rule, and the queue semantics for
 * everything the predicate refuses. Proven against a FAKE steering driver
 * (the spine precedent: the supervisor's rails must hold before any real
 * wire exercises them — gate.steer-client.test.ts drives the real client,
 * gate.steer-live.test.ts the real binary); the spool, cursor, journal,
 * bucket and turn lock are all REAL files in a real temp home, and every
 * deadline runs on a MOVING clock (the frozen-clock ruling).
 */

const home = mkdtempSync(join(tmpdir(), 'tacendum-steer-spine-'));
process.env.TACENDUM_HOME = home;
process.env.TACENDUM_API = 'http://steer-spine.test';
process.env.TACENDUM_WS = 'ws://steer-spine.test';

const seams = vi.hoisted(() => ({ driver: null as HostDriver | null }));

vi.mock('../src/attend-drivers.js', async importOriginal => {
  const real = await importOriginal<typeof import('../src/attend-drivers.js')>();
  return {
    ...real,
    driverFor: (host: Parameters<typeof real.driverFor>[0]) =>
      seams.driver ?? real.driverFor(host),
  };
});

const attendMod = await import('../src/attend.js');
const { MID_TURN_MARKER, attendOnce, cmdAttendEnable, saveAttendConfig } = attendMod;
const { MessageLog } = await import('../src/msglog.js');
const { saveProfile } = await import('../src/profile.js');
const { capChatHead, plainForChat } = await import('../src/hooks.js');
const { Reporter } = await import('../src/output.js');

const OWNER = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const OWN_SESSION = 'ffffffff-9999-4999-8999-999999999999';
const THREAD_KEY = '019ffbc9-e0fc-76c2-993a-fe59e971cd74';
const OTHER_KEY = 'bbbbbbbb-2222-4222-8222-222222222222';

let seq = 0;
const mid = (): string => `01HQXB00000000000000${String(++seq).padStart(6, '0')}`.slice(0, 26);

function inRow(text: string, opts: { tcm?: string; ref?: string } = {}) {
  return {
    id: mid(),
    dir: 'in' as const,
    peer: OWNER,
    ts: Date.now(),
    tcm: opts.tcm ?? '',
    text,
    read: false,
    ...(opts.ref ? { ref: opts.ref } : {}),
  };
}

/** An outbound ledger row speaking FOR a session — what makes a reply-ref
 * route to that session (the router's rule 1). */
function outRow(key: string) {
  return {
    id: mid(),
    dir: 'out' as const,
    peer: OWNER,
    ts: Date.now(),
    tcm: '',
    text: '',
    read: true,
    sess: { host: 'codex', key, tag: `s-${key.slice(0, 4)}` },
  };
}

async function poll(cond: () => boolean, ms = 10_000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error('poll timed out');
    await new Promise(r => setTimeout(r, 10));
  }
}

const statePath = (f: string): string => join(home, 'state', 'bot', f);
/** The cursor FILE, raw — the proof style: the watermark is asserted
 * on bytes, never inferred from a reply. */
const cursorBytes = (): string => {
  try {
    return readFileSync(statePath('attend-cursor.json'), 'utf8');
  } catch {
    return '';
  }
};
const cursorFor = (row: { id: string; ts: number }): string =>
  JSON.stringify({ lastId: row.id, lastTs: row.ts });
interface JournalShape {
  upTo?: string;
  steered?: string[];
  midTurn?: string[];
}
const journalFile = (): JournalShape => {
  try {
    return JSON.parse(readFileSync(statePath('attend-journal.json'), 'utf8'));
  } catch {
    return {};
  }
};
const bucketTurns = (): number => {
  try {
    return (JSON.parse(readFileSync(statePath('attend-bucket.json'), 'utf8')) as { turns: number })
      .turns;
  } catch {
    return 0;
  }
};

/** The moving clock (the frozen-clock ruling): `now()` reads an instant every
 * fake sleep advances, plus `advance()` for the window-rollover test. The
 * 2ms real delay yields the loop so a test body can interleave appends with
 * a running pass. */
const clockIo = () => {
  let t = Date.now();
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
    sleep: async (ms: number): Promise<void> => {
      t += ms;
      await new Promise(r => setTimeout(r, 2));
    },
  };
};

const fakeSend = () => {
  const bodies: string[] = [];
  return {
    bodies,
    sendReply: async (b: string, _sess?: OutSess): Promise<string> => {
      bodies.push(b);
      return mid();
    },
  };
};

/**
 * THE FAKE STEERING DRIVER — a codex app-server stand-in that surfaces the
 * steer call the moment its turn "starts", records every steer text and the
 * RAW JOURNAL BYTES at the instant each steer was invoked (the journal-first
 * proof), then parks until the test finishes the turn. Later calls run
 * plainly so multi-pass tests never park twice.
 */
const steeringDriver = (opts: {
  sessionKey?: string;
  steer?: (text: string) => SteerResult | Promise<SteerResult>;
  reply?: string;
  /** Ask once before parking — the approval-collision test's shape. */
  ask?: { payload: string; ttlMs: number; sessionKey?: string };
  /** Surface the steer on the SECOND call too (the late-answer test runs
   * its steering turn after a settling pass). */
  steerOnCall?: number;
}) => {
  const steeredTexts: string[] = [];
  const journalAtSteer: string[] = [];
  const prompts: string[] = [];
  const reqs: TurnRequest[] = [];
  let calls = 0;
  let release: (() => void) | undefined;
  const released = new Promise<void>(r => {
    release = r;
  });
  const driver: HostDriver = {
    host: 'codex',
    async runTurn(req: TurnRequest) {
      calls += 1;
      prompts.push(req.prompt);
      reqs.push(req);
      if (calls !== (opts.steerOnCall ?? 1)) {
        return { stdout: `plain turn ${calls}`, stderr: '', code: 0, refusal: null };
      }
      req.steering?.({
        ...(opts.sessionKey !== undefined ? { sessionKey: opts.sessionKey } : {}),
        steer: async text => {
          steeredTexts.push(text);
          try {
            journalAtSteer.push(readFileSync(statePath('attend-journal.json'), 'utf8'));
          } catch {
            journalAtSteer.push('');
          }
          return opts.steer === undefined ? 'delivered' : opts.steer(text);
        },
      });
      if (opts.ask !== undefined && req.ask !== undefined) {
        await req.ask({
          payload: opts.ask.payload,
          ttlMs: opts.ask.ttlMs,
          kind: 'commandExecution',
          ...(opts.ask.sessionKey !== undefined ? { sessionKey: opts.ask.sessionKey } : {}),
        });
        return { stdout: 'asked and done', stderr: '', code: 0, refusal: null };
      }
      await released;
      return { stdout: opts.reply ?? 'turn reply', stderr: '', code: 0, refusal: null };
    },
  };
  return {
    driver,
    steeredTexts,
    journalAtSteer,
    prompts,
    reqs,
    calls: () => calls,
    finish: () => release?.(),
  };
};

beforeEach(() => {
  rmSync(join(home, 'bot'), { recursive: true, force: true });
  rmSync(join(home, 'state'), { recursive: true, force: true });
  seq = 0;
  seams.driver = null;
  saveProfile({
    name: 'bot', identityKey: 'AAAA', userId: '01HQXW0000000000000000TEST',
    deviceId: 1, authToken: 'tok', registrationId: 1,
    accountClass: 'integration', ownerUserId: OWNER,
  });
  // The steering profile: codex app-server — the ONLY profile the
  // supervisor attaches a steer surface for, and it is DEFAULT-ON there
  // (deliberate): nothing below opts in beyond the driver choice.
  saveAttendConfig('bot', {
    host: 'codex', bin: '/opt/codex', workdir: '/w', caps: ['-s', 'read-only'],
    codexDriver: 'app-server', ownSession: OWN_SESSION, turnsPerHour: 10,
  });
});

describe('a delivered steer', () => {
  it('journal-first, one token per delivered steer, consumed row stepped over — cursor bytes prove no skip', async () => {
    const log = new MessageLog('bot');
    const p0 = inRow('start the work');
    log.append(p0);
    const fake = steeringDriver({ reply: 'the steered answer' });
    seams.driver = fake.driver;
    const h = fakeSend();
    const io = { ...clockIo(), sendReply: h.sendReply };

    const run = attendOnce('bot', io);
    // The mid-turn reply, appended while the turn runs; the poller steers it.
    await poll(() => fake.calls() === 1);
    const r = inRow('actually use the staging env');
    log.append(r);
    await poll(() => fake.steeredTexts.length === 1);

    // JOURNAL-FIRST: at the instant the steer left the supervisor, the row
    // id was ALREADY on disk — the write order is the crash contract.
    expect(fake.steeredTexts).toEqual(['actually use the staging env']);
    const atSteer = JSON.parse(fake.journalAtSteer[0] as string) as JournalShape;
    expect(atSteer.steered, 'the id must be journalled BEFORE turn/steer leaves').toContain(r.id);
    expect(atSteer.upTo, 'the live-turn half rides beside it').toBe(p0.id);

    // ONE TURN TOKEN PER DELIVERED STEER (deliberate): 1 + 1.
    expect(bucketTurns()).toBe(2);

    fake.finish();
    expect(await run).toBe('answered');
    expect(h.bodies.at(-1)).toBe('the steered answer');

    // THE CURSOR, ON BYTES: advanced to the row the turn covered —
    // never to the steered row past it.
    expect(cursorBytes()).toBe(cursorFor(p0));
    expect(journalFile().steered, 'the consumed id survives the turn').toContain(r.id);

    // The consumed row is stepped over exactly as an approval-spent row is:
    // silently, no turn, no send — and the cursor file steps past it.
    const sends = h.bodies.length;
    expect(await attendOnce('bot', io)).toBe('stepped');
    expect(cursorBytes()).toBe(cursorFor(r));
    expect(h.bodies.length, 'stepping over a steered row sends nothing').toBe(sends);
    expect(fake.calls(), 'and runs nothing — the text was already delivered').toBe(1);
    expect(journalFile().steered ?? [], 'the stepped id is pruned as spent').not.toContain(r.id);
    expect(await attendOnce('bot', io)).toBe('idle');
  }, 30_000);

  it('a mid-turn reply aimed at ANOTHER session queues — the routeKey gate — and intermediate rows are never skipped', async () => {
    const log = new MessageLog('bot');
    // Two sessions in the ledger: the running turn's thread and another.
    const ownAnswer = outRow(THREAD_KEY);
    const otherAnswer = outRow(OTHER_KEY);
    log.append(ownAnswer);
    log.append(otherAnswer);
    const p0 = inRow('continue please', { tcm: 'reply', ref: ownAnswer.id });
    log.append(p0);
    const fake = steeringDriver({ sessionKey: THREAD_KEY, reply: 'done' });
    seams.driver = fake.driver;
    const h = fakeSend();
    const io = { ...clockIo(), sendReply: h.sendReply };

    const run = attendOnce('bot', io);
    await poll(() => fake.calls() === 1);
    // Mid-turn: one reply for the RUNNING thread (steers), one aimed at the
    // OTHER session (must queue), one more for the running thread (steers).
    const forTurn = inRow('tighten the scope', { tcm: 'reply', ref: ownAnswer.id });
    log.append(forTurn);
    const wrongSession = inRow('and you, do the docs', { tcm: 'reply', ref: otherAnswer.id });
    log.append(wrongSession);
    const forTurn2 = inRow('and add tests', { tcm: 'reply', ref: ownAnswer.id });
    log.append(forTurn2);
    await poll(() => fake.steeredTexts.length === 2);
    expect(fake.steeredTexts).toEqual(['tighten the scope', 'and add tests']);
    expect(
      fake.steeredTexts,
      "another session's reply must never enter this turn",
    ).not.toContain('and you, do the docs');

    fake.finish();
    expect(await run).toBe('answered');
    expect(cursorBytes()).toBe(cursorFor(p0));

    // Next pass: the leading run is the FIRST steered row only — the run
    // breaks at the queued row, so the cursor cannot leap it (bytes).
    expect(await attendOnce('bot', io)).toBe('stepped');
    expect(cursorBytes()).toBe(cursorFor(forTurn));

    // The queued row then runs as its own turn — with the mid-turn marker.
    expect(await attendOnce('bot', io)).toBe('answered');
    expect(cursorBytes()).toBe(cursorFor(wrongSession));
    expect(fake.prompts.at(-1)).toBe(`${MID_TURN_MARKER}\nand you, do the docs`);

    // And the second steered row is stepped last. Nothing was skipped.
    expect(await attendOnce('bot', io)).toBe('stepped');
    expect(cursorBytes()).toBe(cursorFor(forTurn2));
    expect(await attendOnce('bot', io)).toBe('idle');
  }, 30_000);
});

describe('the crash boundary (red-first on a moving clock)', () => {
  it('a kill between journal-write and steer-send: restart says maybe-delivered, never re-runs, and the cursor loses nothing', async () => {
    const log = new MessageLog('bot');
    const p0 = inRow('start the work');
    log.append(p0);
    // The steer call REJECTING is the crash lever: the client's contract is
    // "never rejects", so a rejection unwinds the pass exactly as a dying
    // sendReply does — after the journal write, before any send confirmed.
    const fake = steeringDriver({
      steer: () => {
        throw new Error('SIGKILL between journal and steer');
      },
    });
    seams.driver = fake.driver;
    const h0 = fakeSend();
    const io0 = { ...clockIo(), sendReply: h0.sendReply };
    const run = attendOnce('bot', io0);
    await poll(() => fake.calls() === 1);
    const r = inRow('change of plan');
    log.append(r);
    await poll(() => fake.steeredTexts.length === 1);
    fake.finish();
    await expect(run).rejects.toThrow('SIGKILL');

    // The dead pass left the contract on disk: live turn + journalled id.
    expect(journalFile().upTo).toBe(p0.id);
    expect(journalFile().steered).toContain(r.id);
    expect(cursorBytes(), 'the cursor never moved mid-turn').toBe('');

    // RESTART: the interrupted sentence names the maybe-delivered reply.
    const fake2 = steeringDriver({ reply: 'later turn' });
    seams.driver = fake2.driver;
    const h = fakeSend();
    const io = { ...clockIo(), sendReply: h.sendReply };
    expect(await attendOnce('bot', io)).toBe('interrupted');
    const told = h.bodies.at(-1) as string;
    expect(told).toContain('A turn was interrupted before it reported back');
    expect(told).toContain('A reply you sent while it ran may or may not have reached it');
    expect(told, 'the sentence names the reply, never its text').not.toContain(
      'change of plan',
    );
    expect(cursorBytes()).toBe(cursorFor(p0));

    // The maybe-delivered row is stepped over — NEVER handed to a second
    // delivery — and the account then goes quiet.
    expect(await attendOnce('bot', io)).toBe('stepped');
    expect(cursorBytes()).toBe(cursorFor(r));
    expect(
      fake2.prompts.every(p => !p.includes('change of plan')),
      'a maybe-delivered message must never re-run',
    ).toBe(true);
    expect(await attendOnce('bot', io)).toBe('idle');
  }, 30_000);

  it('a SIGKILL mid-turn on a host that cannot steer still MARKS the arrival: the interrupted branch records it into midTurn', async () => {
    // the contract is "every claude and codex-exec mid-turn arrival" is
    // marked — including the ones a crash orphans. Before the fix, midTurn
    // ids were computed only in settleTurn (which a SIGKILL never reaches),
    // so a row that arrived while the dead turn ran was delivered by the
    // next pass with NO marker: pre-crash words reading as fresh ones, the
    // exact dishonesty the marker exists to prevent.
    saveAttendConfig('bot', {
      host: 'claude', bin: '/opt/agent', workdir: '/w', caps: [],
      ownSession: OWN_SESSION, turnsPerHour: 10,
    });
    const log = new MessageLog('bot');
    const p0 = inRow('start the work');
    log.append(p0);
    const r = inRow('arrived while it ran');
    log.append(r);
    // The exact state a SIGKILL mid-turn leaves: a live journal naming the
    // turn, the cursor untouched, and r pending — arrived while the dead
    // turn ran, never steered (claude cannot steer), never settled.
    mkdirSync(join(home, 'state', 'bot'), { recursive: true, mode: 0o700 });
    writeFileSync(
      statePath('attend-journal.json'),
      JSON.stringify({ upTo: p0.id, startedAt: Date.now() - 60_000 }),
    );

    const h = fakeSend();
    const prompts: string[] = [];
    const io = {
      ...clockIo(),
      sendReply: h.sendReply,
      runTurn: async (_argv: string[], _cwd: string, prompt: string) => {
        prompts.push(prompt);
        return { stdout: 'later answer', stderr: '', code: 0 };
      },
    };
    expect(await attendOnce('bot', io)).toBe('interrupted');
    expect(h.bodies.at(-1)).toContain('A turn was interrupted before it reported back');
    expect(cursorBytes()).toBe(cursorFor(p0));
    expect(
      journalFile().midTurn,
      'the arrival must survive the crash into the retiring journal’s midTurn',
    ).toContain(r.id);

    // The next pass delivers it WITH the marker — stale words say so.
    expect(await attendOnce('bot', io)).toBe('answered');
    expect(prompts[0]).toBe(`${MID_TURN_MARKER}\narrived while it ran`);
  }, 30_000);
});

describe('the -32600 arm', () => {
  it('provably undelivered: un-journalled, token refunded, re-presented exactly once — with the mid-turn marker', async () => {
    const log = new MessageLog('bot');
    const p0 = inRow('start the work');
    log.append(p0);
    const fake = steeringDriver({ steer: () => 'not-delivered', reply: 'unsteered reply' });
    seams.driver = fake.driver;
    const h = fakeSend();
    const io = { ...clockIo(), sendReply: h.sendReply };
    const run = attendOnce('bot', io);
    await poll(() => fake.calls() === 1);
    const r = inRow('too late for this turn');
    log.append(r);
    await poll(() => fake.steeredTexts.length === 1);

    // The journal held the id at send time (the order is unconditional)…
    const atSteer = JSON.parse(fake.journalAtSteer[0] as string) as JournalShape;
    expect(atSteer.steered).toContain(r.id);
    // …and the provably-undelivered answer took it back off and refunded
    // the token: the bucket bills DELIVERED steers only.
    await poll(() => !(journalFile().steered ?? []).includes(r.id));
    expect(bucketTurns()).toBe(1);

    fake.finish();
    expect(await run).toBe('answered');
    expect(cursorBytes()).toBe(cursorFor(p0));

    // Re-presented EXACTLY once: the next pass runs it as an ordinary turn,
    // marked as a mid-turn arrival; then nothing remains.
    expect(await attendOnce('bot', io)).toBe('answered');
    expect(fake.calls()).toBe(2);
    expect(fake.prompts[1]).toBe(`${MID_TURN_MARKER}\ntoo late for this turn`);
    expect(cursorBytes()).toBe(cursorFor(r));
    expect(await attendOnce('bot', io)).toBe('idle');
    expect(fake.calls(), 'once means once').toBe(2);
  }, 30_000);
});

describe('the budget (bucket = 1 + delivered steers)', () => {
  it('an empty bucket refuses the steer and the row queues — never a silent drop', async () => {
    saveAttendConfig('bot', {
      host: 'codex', bin: '/opt/codex', workdir: '/w', caps: ['-s', 'read-only'],
      codexDriver: 'app-server', ownSession: OWN_SESSION, turnsPerHour: 2,
    });
    const log = new MessageLog('bot');
    const p0 = inRow('start the work');
    log.append(p0);
    const fake = steeringDriver({ reply: 'ok' });
    seams.driver = fake.driver;
    const h = fakeSend();
    const io = { ...clockIo(), sendReply: h.sendReply };
    const run = attendOnce('bot', io);
    await poll(() => fake.calls() === 1);
    const r1 = inRow('first correction');
    log.append(r1);
    await poll(() => fake.steeredTexts.length === 1);
    expect(bucketTurns(), 'turn + delivered steer').toBe(2);

    // The bucket is now at its ceiling: the second mid-turn row must QUEUE.
    const r2 = inRow('second correction');
    log.append(r2);
    // Give the poller several cadences to prove it refuses rather than races.
    for (let i = 0; i < 5; i += 1) await new Promise(res => setTimeout(res, 15));
    expect(fake.steeredTexts, 'broke ⇒ queue, never a delivery past the brake').toEqual([
      'first correction',
    ]);
    fake.finish();
    expect(await run).toBe('answered');
    expect(bucketTurns()).toBe(2);

    // The queued row is still owed a turn — QUEUED means the next pass owns
    // it under its own token, and after the window rolls it gets one, the
    // mid-turn marker riding the prompt.
    expect(await attendOnce('bot', io)).toBe('stepped'); // r1, consumed
    io.advance(60 * 60 * 1000 + 1);
    expect(await attendOnce('bot', io)).toBe('answered');
    expect(fake.prompts.at(-1)).toBe(`${MID_TURN_MARKER}\nsecond correction`);
    expect(cursorBytes()).toBe(cursorFor(r2));
  }, 30_000);
});

describe('approval non-collision', () => {
  it('with an approval pending, a bare mid-park row neither steers nor is consumed; approve settles; the bare row runs next pass', async () => {
    const log = new MessageLog('bot');
    const p0 = inRow('do the deploy');
    log.append(p0);
    const fake = steeringDriver({
      ask: { payload: 'make deploy', ttlMs: 3_600_000 },
    });
    seams.driver = fake.driver;
    const h = fakeSend();
    const io = { ...clockIo(), sendReply: h.sendReply };
    const run = attendOnce('bot', io);

    // Wait for the card, then interleave TWO bare rows — one of them
    // spelling a VERB — and the real ref-carrying answer.
    await poll(() => h.bodies.some(b => b.includes('make deploy')));
    const approvals = (): { rows: { msgId?: string; state: string; decision?: string }[] } =>
      JSON.parse(readFileSync(statePath('attend-approvals.json'), 'utf8'));
    await poll(() => approvals().rows[0]?.state === 'pending');
    // The sharpest ref-split probe: a bare row whose WHOLE TEXT is a verb.
    // Without the exact-ref filter it would decide the authorization.
    log.append(inRow('deny'));
    const bare = inRow('unrelated question about the docs');
    log.append(bare);
    const cardMsgId = approvals().rows[0]?.msgId as string;
    log.append(inRow('approve', { tcm: 'reply', ref: cardMsgId }));

    expect(await run).toBe('answered');
    // The ref'd approve decided the approval — the ref split held from the
    // park's side: the bare 'deny' decided NOTHING.
    expect(approvals().rows[0]?.decision, 'a bare row must never decide an authorization').toBe(
      'approve',
    );
    expect(approvals().rows[0]?.state).toBe('done');
    expect(
      h.bodies.filter(b => b.includes('Reply approve or deny')),
      'no bare row was consumed as an unrecognised verb either',
    ).toHaveLength(0);
    // …and from the steer's side: NOTHING was steered while an ask was in
    // flight — steer-during-park is unmeasured and therefore forbidden.
    expect(fake.steeredTexts).toEqual([]);

    // The bare row was neither steered nor consumed: it runs next pass as
    // its own turn (the spent approve decider is stepped separately), and
    // the account then goes quiet.
    let sawBare = false;
    let out = '';
    for (let i = 0; i < 6 && out !== 'idle'; i += 1) {
      out = await attendOnce('bot', io);
      sawBare ||= fake.prompts.some(p => p.includes('unrelated question about the docs'));
    }
    expect(sawBare, 'the bare row is owed its own turn').toBe(true);
    expect(out).toBe('idle');
  }, 30_000);

  it("a LATE approve naming a settled card routes like the turn's own thread and still must not steer — the answer channel is never a prompt", async () => {
    // Pass 1: an approval asked FOR the thread, approved, settled.
    const log = new MessageLog('bot');
    log.append(inRow('do the deploy'));
    const asker = steeringDriver({
      ask: { payload: 'make deploy', ttlMs: 3_600_000, sessionKey: THREAD_KEY },
    });
    seams.driver = asker.driver;
    const h = fakeSend();
    const io = { ...clockIo(), sendReply: h.sendReply };
    const run1 = attendOnce('bot', io);
    const approvals = (): { rows: { msgId?: string; state: string }[] } =>
      JSON.parse(readFileSync(statePath('attend-approvals.json'), 'utf8'));
    await poll(() => approvals().rows[0]?.state === 'pending');
    const cardMsgId = approvals().rows[0]?.msgId as string;
    // The card's OUTBOUND ledger row, as realSendReply writes it (the fake
    // send seam records bodies only): id = the wire msgId, sess = the asking
    // thread. This is exactly what makes a reply-ref to the card resolve.
    log.append({
      id: cardMsgId, dir: 'out' as const, peer: OWNER, ts: Date.now(), tcm: '', text: '',
      read: true, sess: { host: 'codex', key: THREAD_KEY, tag: 's-card' },
    });
    log.append(inRow('approve', { tcm: 'reply', ref: cardMsgId }));
    expect(await run1).toBe('answered');
    expect(await attendOnce('bot', io)).toBe('stepped'); // the decider row

    // Pass 2: a steering turn runs ON THAT THREAD; a stray late 'approve'
    // naming the settled card arrives mid-turn. Its ref resolves to the
    // card's ledger row — the very thread running — so ONLY the
    // answer-channel exclusion keeps the word "approve" out of the model.
    const ownAnswer = outRow(THREAD_KEY);
    log.append(ownAnswer);
    const t2 = inRow('continue please', { tcm: 'reply', ref: ownAnswer.id });
    log.append(t2);
    const steerer = steeringDriver({ sessionKey: THREAD_KEY, reply: 'done', steerOnCall: 1 });
    seams.driver = steerer.driver;
    const run2 = attendOnce('bot', io);
    await poll(() => steerer.calls() === 1);
    log.append(inRow('approve', { tcm: 'reply', ref: cardMsgId }));
    for (let i = 0; i < 5; i += 1) await new Promise(res => setTimeout(res, 15));
    expect(
      steerer.steeredTexts,
      'an approval answer — even a late one — must never become a steer',
    ).toEqual([]);
    steerer.finish();
    expect(await run2).toBe('answered');

    // The late answer then gets its honest sentence, not a turn.
    expect(await attendOnce('bot', io)).toBe('approval-stale');
    expect(h.bodies.at(-1)).toMatch(/already answered/);
  }, 30_000);
});

describe('the seam shape and the marker', () => {
  it('the supervisor attaches a steer surface for the app-server profile ONLY', async () => {
    const probe = (): ReturnType<typeof steeringDriver> => steeringDriver({ reply: 'x' });
    // claude: no steering member at the seam at all.
    saveAttendConfig('bot', {
      host: 'claude', bin: '/opt/agent', workdir: '/w', caps: ['--permission-mode', 'plan'],
      ownSession: OWN_SESSION, turnsPerHour: 10,
    });
    new MessageLog('bot').append(inRow('hello'));
    let fake = probe();
    seams.driver = fake.driver;
    const io = { ...clockIo(), sendReply: fakeSend().sendReply };
    fake.finish();
    expect(await attendOnce('bot', io)).toBe('answered');
    expect('steering' in (fake.reqs[0] as TurnRequest)).toBe(false);

    // codex EXEC: same absence — the opt-out is the driver word, not luck.
    saveAttendConfig('bot', {
      host: 'codex', bin: '/opt/codex', workdir: '/w', caps: ['-s', 'read-only'],
      codexDriver: 'exec', ownSession: OWN_SESSION, turnsPerHour: 10,
    });
    new MessageLog('bot').append(inRow('hello again'));
    fake = probe();
    seams.driver = fake.driver;
    fake.finish();
    expect(await attendOnce('bot', io)).toBe('answered');
    expect('steering' in (fake.reqs[0] as TurnRequest)).toBe(false);

    // app-server: present — and default-on, no field beyond the driver.
    saveAttendConfig('bot', {
      host: 'codex', bin: '/opt/codex', workdir: '/w', caps: ['-s', 'read-only'],
      codexDriver: 'app-server', ownSession: OWN_SESSION, turnsPerHour: 10,
    });
    new MessageLog('bot').append(inRow('hello a third time'));
    fake = probe();
    seams.driver = fake.driver;
    fake.finish();
    expect(await attendOnce('bot', io)).toBe('answered');
    expect(typeof (fake.reqs[0] as TurnRequest).steering).toBe('function');
  }, 30_000);

  it('the marker is byte-stable through the funnel and appears EXACTLY on mid-turn rows', async () => {
    // Byte-stability: the funnel neither rewrites nor clips it, so wherever
    // the line travels it arrives as these bytes or not at all.
    expect(capChatHead(plainForChat(MID_TURN_MARKER))).toBe(MID_TURN_MARKER);

    // A claude profile — no steering anywhere — still marks queued
    // mid-turn arrivals: the "and say so" half of the honest sentence.
    saveAttendConfig('bot', {
      host: 'claude', bin: '/opt/agent', workdir: '/w', caps: ['--permission-mode', 'plan'],
      ownSession: OWN_SESSION, turnsPerHour: 10,
    });
    const log = new MessageLog('bot');
    log.append(inRow('first prompt'));
    const fake = steeringDriver({ reply: 'first answer' });
    seams.driver = fake.driver;
    const io = { ...clockIo(), sendReply: fakeSend().sendReply };
    const run = attendOnce('bot', io);
    await poll(() => fake.calls() === 1);
    const during = inRow('came in during the turn');
    log.append(during);
    fake.finish();
    expect(await run).toBe('answered');

    // The mid-turn arrival is marked…
    expect(await attendOnce('bot', io)).toBe('answered');
    expect(fake.prompts[1]).toBe(`${MID_TURN_MARKER}\ncame in during the turn`);

    // …and a row that arrived at REST is not: exactly on mid-turn rows.
    log.append(inRow('came in at rest'));
    expect(await attendOnce('bot', io)).toBe('answered');
    expect(fake.prompts[2]).toBe('came in at rest');
  }, 30_000);
});

describe('the enable copy states the default', () => {
  const enableSaid = (opts: Record<string, unknown>): string => {
    const human: string[] = [];
    const rep = report();
    rep.emit = (_r: Record<string, unknown>, h: string) => void human.push(h);
    cmdAttendEnable('bot', { bin: process.execPath, workdir: tmpdir(), ...opts }, rep);
    return human.join('\n');
  };
  const report = () => new Reporter({ json: false, plain: true });

  it('app-server: steering is stated plainly — on, mid-turn, and the dropped partial named; never "steers everywhere"', () => {
    const said = enableSaid({ host: 'codex', driver: 'app-server' });
    expect(said).toContain('Replies sent while a turn runs STEER it');
    expect(said, 'the reply semantics are the honest sentence').toContain(
      'the partial answer it interrupted is dropped',
    );
    expect(said, 'the other hosts are named as queue-and-say-so').toContain(
      'arrive at the next turn instead, marked as such',
    );
  });

  it('codex exec: next-turn delivery stated, steering scoped to the app-server driver', () => {
    const said = enableSaid({ host: 'codex' });
    expect(said).toContain('arrive at the NEXT turn');
    expect(said).toContain('only the app-server driver steers a running turn');
    expect(said).not.toContain('STEER it:');
  });

  it('claude: next-turn delivery stated', () => {
    const said = enableSaid({ host: 'claude' });
    expect(said).toContain('arrive at the next turn, marked as having arrived mid-turn');
    expect(said).not.toContain('STEER it:');
  });
});
