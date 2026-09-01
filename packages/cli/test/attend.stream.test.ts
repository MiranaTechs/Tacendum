import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StreamEditEnvelope } from '@tacendum/shared';
import type { AttendConfig, OutSess, TypingChannel } from '../src/attend.js';
import type { HostDriver, TurnRequest } from '../src/attend-drivers.js';

/**
 * LIVE-UPDATING REPLIES, THE CLI EMISSION — the
 * anchor/edit/final lifecycle, its gates, and everything it must never do.
 *
 * What this file pins, red-first where the design names a mutation:
 *  1. UN-ATTESTED IS TODAY, byte-identical and permanent: no `streamMinAppBuild`
 *     means the driver never even learns the stream seam exists — one reply,
 *     no anchor, no edits, no journal field (mutation: drop the attestation
 *     check in the arming predicate and this file goes red, because the fake
 *     driver pushes snapshots whenever the seam is offered);
 *  2. the LIFECYCLE on a moving clock: first non-empty snapshot → ONE durable
 *     anchor (rings; msgId journalled BEFORE any x.edit), then only-if-changed
 *     `x.edit {ref, seq++, snapshot}` through the typing channel's `edit`
 *     member, then the durable `{tcm:'edit'}` final with notify:false — and
 *     exactly TWO durable sends for the whole streamed turn;
 *  3. EVERY SNAPSHOT CROSSES THE SAME FUNNEL AS THE FINAL — an intermediate
 *     can never say what the final could not;
 *  4. the CAP silences intermediates, never the final, and typing continues;
 *  5. the FRESH GATE: a stale backlog streams nothing (mutation: drop the
 *     gate and this goes red — same seam-offered argument as 1);
 *  6. a THROWING edit channel is chatter: same answer, same durable sends,
 *     nothing surfaced;
 *  7. a PARKED turn streams nothing: an in-flight approval suppresses the
 *     anchor and every intermediate for its whole life;
 *  8. CRASH → the restart sweep sends the interrupted sentence as the final
 *     edit to the JOURNALLED anchor — never a re-run, never a stuck bubble;
 *  9. a hand-edited `streamMinAppBuild` of the wrong shape reads as
 *     un-attested (the fail-closed posture, verbatim), and the field on
 *     a claude profile arms nothing;
 * 10. `attend enable --stream` writes the attestation, reads the claim back,
 *     and refuses every profile that cannot stream (v1: codex app-server
 *     1:1 only).
 *
 * The spool, cursor, journal, bucket and approvals file are REAL files in a
 * temp home (the spine precedent); the driver, the reply transport and the
 * typing channel are seams — attend.typing.test.ts's exact fixture style.
 */

const home = mkdtempSync(join(tmpdir(), 'tacendum-attend-stream-'));
process.env.TACENDUM_HOME = home;
process.env.TACENDUM_API = 'http://attend-stream.test';
process.env.TACENDUM_WS = 'ws://attend-stream.test';

const seams = vi.hoisted(() => ({
  driver: null as HostDriver | null,
}));

vi.mock('../src/attend-drivers.js', async importOriginal => {
  const real = await importOriginal<typeof import('../src/attend-drivers.js')>();
  return {
    ...real,
    driverFor: (host: Parameters<typeof real.driverFor>[0]) =>
      seams.driver ?? real.driverFor(host),
  };
});

const attendMod = await import('../src/attend.js');
const {
  ATTEND_REPLY_CAP,
  STREAM_EDITS_PER_TURN_MAX,
  STREAM_FRESH_MS,
  attendOnce,
  cmdAttendEnable,
  loadAttendConfig,
  route,
  saveAttendConfig,
} = attendMod;
const { MessageLog } = await import('../src/msglog.js');
const { saveProfile } = await import('../src/profile.js');
const { capChatHead, plainForChat, sessionTag } = await import('../src/hooks.js');
const { Reporter } = await import('../src/output.js');
const { CliError, EXIT } = await import('../src/exit.js');

const OWNER = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const SELF = '01HQXW0000000000000000TEST';
const OWN_SESSION = 'ffffffff-9999-4999-8999-999999999999';
/** The live thread id the fake drivers surface — UUID-shaped so it passes
 * the `hostSessionKey` gate exactly as a real `thread/start` id does. */
const THREAD = 'f1f1f1f1-0000-4000-8000-000000000001';

let seq = 0;
const mid = (): string => `01HQXS00000000000000${String(++seq).padStart(6, '0')}`.slice(0, 26);

const statePath = (f: string): string => join(home, 'state', 'bot', f);
const journalFile = (): { upTo?: string; streamAnchor?: string } => {
  try {
    return JSON.parse(readFileSync(statePath('attend-journal.json'), 'utf8')) as {
      upTo?: string;
      streamAnchor?: string;
    };
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
const approvalRows = (): { msgId?: string; state: string }[] => {
  try {
    return (
      JSON.parse(readFileSync(statePath('attend-approvals.json'), 'utf8')) as {
        rows: { msgId?: string; state: string }[];
      }
    ).rows;
  } catch {
    return [];
  }
};

function inRow(text: string, opts: { tcm?: string; ref?: string; ts?: number } = {}) {
  return {
    id: mid(),
    dir: 'in' as const,
    peer: OWNER,
    ts: opts.ts ?? Date.now(),
    tcm: opts.tcm ?? '',
    text,
    read: false,
    ...(opts.ref ? { ref: opts.ref } : {}),
  };
}

async function poll(cond: () => boolean, ms = 10_000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error('poll timed out');
    await new Promise(r => setTimeout(r, 5));
  }
}

/** The moving clock (the frozen-clock ruling): now() reads an instant every
 * fake sleep advances; the 2ms real delay yields the loop so the test body
 * can interleave with a running pass. */
const clockIo = () => {
  let t = Date.now();
  return {
    now: () => t,
    sleep: async (ms: number): Promise<void> => {
      t += ms;
      await new Promise(r => setTimeout(r, 2));
    },
  };
};

/** The reply seam, recording bodies AND the notify option — the widened
 * three-parameter shape; two-parameter fakes elsewhere stay assignable. */
const fakeSend = () => {
  const sends: { body: string; id: string; notify?: false }[] = [];
  return {
    sends,
    bodies: () => sends.map(s => s.body),
    sendReply: async (
      b: string,
      _sess?: OutSess,
      opts?: { notify?: boolean },
    ): Promise<string> => {
      const id = mid();
      sends.push({ body: b, id, ...(opts?.notify === false ? { notify: false as const } : {}) });
      return id;
    },
  };
};

/** The typing seam, grown the optional `edit` member — every emission
 * stamped off the SAME clock the pass runs on. */
const streamTypingFake = (
  now: () => number,
  opts: { throwOnEdit?: boolean; noEditMember?: boolean } = {},
) => {
  const events: { state: 'start' | 'stop'; at: number }[] = [];
  const edits: { body: string; at: number }[] = [];
  let minted = 0;
  let closed = 0;
  return {
    events,
    edits,
    minted: () => minted,
    closed: () => closed,
    factory: (_to: string): TypingChannel => {
      minted += 1;
      return {
        send: async (state: 'start' | 'stop'): Promise<void> => {
          events.push({ state, at: now() });
        },
        ...(opts.noEditMember === true
          ? {}
          : {
              edit: async (body: string): Promise<void> => {
                if (opts.throwOnEdit === true) throw new Error('edit transport down');
                edits.push({ body, at: now() });
              },
            }),
        close: (): void => {
          closed += 1;
        },
      };
    },
  };
};

/**
 * A held driver whose snapshots the TEST pushes through the captured
 * `req.stream` — optional chaining on purpose: when the supervisor did not
 * arm the seam, every push is a no-op, which is exactly what makes the
 * attestation and fresh-gate tests RED-FIRST (drop either check in attend.ts
 * and the pushes suddenly flow, the anchor appears, and the single-reply
 * assertions fail).
 */
const streamDriver = (opts: {
  reply?: string;
  failWith?: Error;
  ask?: { payload: string; ttlMs: number; pushBeforeAsk?: string };
} = {}) => {
  let stream: ((s: string) => void) | undefined;
  let offered = false;
  let calls = 0;
  let release: (() => void) | undefined;
  const released = new Promise<void>(r => {
    release = r;
  });
  const driver: HostDriver = {
    host: 'codex',
    async runTurn(req: TurnRequest) {
      calls += 1;
      stream = req.stream;
      offered = req.stream !== undefined;
      // The real app-server driver surfaces the steer call — and the live
      // thread key riding it — BEFORE the first delta (`turn/started`
      // precedes deltas in read order, and thread capture precedes
      // `turn/start` structurally). The fake mirrors that contract, so the
      // anchor's sess gate sees what production sees.
      req.steering?.({ sessionKey: THREAD, steer: async () => 'delivered' as const });
      if (opts.ask !== undefined && req.ask !== undefined) {
        if (opts.ask.pushBeforeAsk !== undefined) req.stream?.(opts.ask.pushBeforeAsk);
        await req.ask({ payload: opts.ask.payload, ttlMs: opts.ask.ttlMs });
      }
      await released;
      if (opts.failWith !== undefined) throw opts.failWith;
      return { stdout: opts.reply ?? 'final answer', stderr: '', code: 0, refusal: null };
    },
  };
  return {
    driver,
    push: (s: string): void => stream?.(s),
    offered: () => offered,
    calls: () => calls,
    finish: () => release?.(),
  };
};

const attestedCfg = (over: Partial<AttendConfig> = {}): void =>
  saveAttendConfig('bot', {
    host: 'codex',
    bin: '/opt/codex',
    workdir: '/w',
    caps: ['-s', 'read-only'],
    codexDriver: 'app-server',
    ownSession: OWN_SESSION,
    turnsPerHour: 10,
    streamMinAppBuild: 42,
    ...over,
  });

const funnel = (text: string): string => capChatHead(plainForChat(text), ATTEND_REPLY_CAP);

const report = () => new Reporter({ json: false, plain: true });

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
  attestedCfg();
});

describe('the attestation gate (red-first: never-attested = today, forever)', () => {
  it('un-attested codex app-server: the driver is never offered the seam, and one byte-identical reply leaves', async () => {
    attestedCfg({ streamMinAppBuild: undefined });
    new MessageLog('bot').append(inRow('do the work'));
    const fake = streamDriver({ reply: 'the answer' });
    seams.driver = fake.driver;
    const h = fakeSend();
    const clock = clockIo();
    const typing = streamTypingFake(clock.now);
    const io = { ...clock, sendReply: h.sendReply, typing: typing.factory };

    const run = attendOnce('bot', io);
    await poll(() => fake.calls() === 1);
    // The pushes below are the mutation trap: with the attestation check in
    // place `req.stream` was undefined and these are no-ops; drop the check
    // and they mint an anchor, which fails every assertion after them.
    fake.push('half a ');
    fake.push('half a thought');
    await new Promise(r => setTimeout(r, 60)); // many fake cadence ticks
    expect(fake.offered(), 'an un-attested turn never learns the seam exists').toBe(false);
    expect(h.sends, 'nothing may leave mid-turn').toEqual([]);
    expect(journalFile().streamAnchor, 'no anchor is ever journalled').toBeUndefined();

    fake.finish();
    expect(await run).toBe('answered');
    expect(h.sends).toEqual([{ body: 'the answer', id: h.sends[0]?.id as string }]);
    expect(typing.edits).toEqual([]);
    expect(journalFile().streamAnchor).toBeUndefined();
  }, 30_000);

  it('a malformed attestation reads as un-attested (fail closed), and the field on a claude profile arms nothing', async () => {
    // the exact posture: shape-checked where it is read, so a hand
    // edit (a float, a string) degrades to the path every build renders.
    attestedCfg({ streamMinAppBuild: 4.5 });
    new MessageLog('bot').append(inRow('do the work'));
    let fake = streamDriver({ reply: 'the answer' });
    seams.driver = fake.driver;
    let h = fakeSend();
    let run = attendOnce('bot', { ...clockIo(), sendReply: h.sendReply });
    await poll(() => fake.calls() === 1);
    fake.push('never emitted');
    fake.finish();
    expect(await run).toBe('answered');
    expect(fake.offered()).toBe(false);
    expect(h.bodies()).toEqual(['the answer']);

    // And the host/driver clauses: the field hand-planted on a claude
    // profile is a claim nothing reads — claude cannot stream (v1).
    saveAttendConfig('bot', {
      host: 'claude', bin: '/opt/agent', workdir: '/w', caps: ['--permission-mode', 'plan'],
      ownSession: OWN_SESSION, turnsPerHour: 10, streamMinAppBuild: 42,
    });
    new MessageLog('bot').append(inRow('more work'));
    fake = streamDriver({ reply: 'claude answer' });
    seams.driver = { ...fake.driver, host: 'claude' };
    h = fakeSend();
    run = attendOnce('bot', { ...clockIo(), sendReply: h.sendReply });
    await poll(() => fake.calls() === 1);
    fake.push('never emitted either');
    fake.finish();
    expect(await run).toBe('answered');
    expect(fake.offered()).toBe(false);
    expect(h.bodies()).toEqual(['claude answer']);
  }, 30_000);
});

describe('the lifecycle (moving clock): anchor → x.edit intermediates → durable final', () => {
  it('first non-empty snapshot mints ONE ringing anchor, journalled before any edit; intermediates are only-if-changed seq++ x.edit; the final is {tcm:edit} with notify:false — two durable sends, one token', async () => {
    new MessageLog('bot').append(inRow('write the essay'));
    const fake = streamDriver({ reply: 'The answer is 42, truly — final.' });
    seams.driver = fake.driver;
    const h = fakeSend();
    const clock = clockIo();
    const typing = streamTypingFake(clock.now);
    const io = { ...clock, sendReply: h.sendReply, typing: typing.factory };

    const run = attendOnce('bot', io);
    await poll(() => fake.offered());

    // THE ANCHOR: the first non-empty snapshot, durable, ringing (no
    // notify:false), journalled BEFORE any x.edit exists.
    fake.push('The answer is');
    await poll(() => h.sends.length >= 1);
    const anchor = h.sends[0] as { body: string; id: string; notify?: false };
    expect(anchor.body).toBe('The answer is');
    expect(anchor.notify, 'the anchor is the reply’s only banner — it rings').toBeUndefined();
    expect(journalFile().streamAnchor, 'journalled before any edit emission').toBe(anchor.id);
    expect(typing.edits, 'no edit may precede the journalled anchor').toEqual([]);

    // INTERMEDIATES: full snapshots, later-wins seq, ref = the anchor.
    fake.push('The answer is 42');
    await poll(() => typing.edits.length === 1);
    const first = StreamEditEnvelope.parse(JSON.parse((typing.edits[0] as { body: string }).body));
    // `ai:true` on every frame — an x.edit is only ever
    // agent-authored, and the marker rides the strict composer.
    expect(first).toEqual({ tcm: 'x.edit', ref: anchor.id, seq: 1, text: 'The answer is 42', ai: true });

    // ONLY-IF-CHANGED: the same snapshot again emits nothing.
    fake.push('The answer is 42');
    await new Promise(r => setTimeout(r, 60)); // many fake cadence ticks
    expect(typing.edits).toHaveLength(1);

    fake.push('The answer is 42, truly');
    await poll(() => typing.edits.length === 2);
    const second = StreamEditEnvelope.parse(JSON.parse((typing.edits[1] as { body: string }).body));
    expect(second.seq).toBe(2);
    expect(second.ref).toBe(anchor.id);
    expect(second.text).toBe('The answer is 42, truly');

    // THE DURABLE FINAL: {tcm:'edit'} on the anchor, notify:false — and the
    // whole streamed turn spent exactly TWO durable sends and ONE token.
    fake.finish();
    expect(await run).toBe('answered');
    expect(h.sends).toHaveLength(2);
    const final = h.sends[1] as { body: string; notify?: false };
    expect(final.notify, 'the final must not ring a phone the anchor already rang').toBe(false);
    expect(JSON.parse(final.body)).toEqual({
      tcm: 'edit',
      ref: anchor.id,
      text: 'The answer is 42, truly — final.',
      // The Art. 50 marker: envelope bodies are marked ungated —
      // a KNOWN kind's unknown field is invisible to every shipped parser.
      ai: true,
    });
    expect(final.body.startsWith('{"tcm":'), 'the envelope leads with the routing sentinel').toBe(
      true,
    );
    expect(journalFile().streamAnchor, 'a finalized anchor leaves the journal').toBeUndefined();
    expect(bucketTurns()).toBe(1);
    expect(typing.minted(), 'edits ride the turn’s ONE typing channel').toBe(1);
    expect(typing.closed()).toBe(1);
  }, 30_000);

  it('every snapshot crosses the SAME funnel as the final — markdown degrades and the cap truncates before anything is emitted', async () => {
    new MessageLog('bot').append(inRow('write it up'));
    const fake = streamDriver({ reply: 'done' });
    seams.driver = fake.driver;
    const h = fakeSend();
    const clock = clockIo();
    const typing = streamTypingFake(clock.now);
    const io = { ...clock, sendReply: h.sendReply, typing: typing.factory };

    const run = attendOnce('bot', io);
    await poll(() => fake.offered());

    // A snapshot the chat degrader must REWRITE: what leaves is the funnel's
    // output, never the model's raw markdown.
    const raw = '# Findings\n\n```bash\nrm -rf /tmp/x\n```\nplain tail';
    expect(funnel(raw)).not.toBe(raw); // the premise: the funnel changes it
    fake.push(raw);
    await poll(() => h.sends.length >= 1);
    expect((h.sends[0] as { body: string }).body).toBe(funnel(raw));

    // A snapshot past the reply cap: the emitted text is the funnel's
    // truncation, so an intermediate can never say what the final could not.
    const long = raw + ' ' + 'x'.repeat(ATTEND_REPLY_CAP * 2);
    fake.push(long);
    await poll(() => typing.edits.length === 1);
    const edit = StreamEditEnvelope.parse(JSON.parse((typing.edits[0] as { body: string }).body));
    expect(edit.text).toBe(funnel(long));
    expect(edit.text.length).toBeLessThanOrEqual(ATTEND_REPLY_CAP);

    fake.finish();
    expect(await run).toBe('answered');
  }, 30_000);

  it('the cap silences INTERMEDIATES, never the final — and typing keeps refreshing past it', async () => {
    new MessageLog('bot').append(inRow('the long one'));
    const fake = streamDriver({ reply: 'the capped turn still ends whole' });
    seams.driver = fake.driver;
    const h = fakeSend();
    const clock = clockIo();
    const typing = streamTypingFake(clock.now);
    const io = { ...clock, sendReply: h.sendReply, typing: typing.factory };

    const run = attendOnce('bot', io);
    await poll(() => fake.offered());
    fake.push('seed');
    await poll(() => h.sends.length >= 1); // the anchor

    for (let i = 1; i <= STREAM_EDITS_PER_TURN_MAX; i += 1) {
      fake.push(`chunk ${i}`);
      await poll(() => typing.edits.length >= i);
    }
    expect(typing.edits).toHaveLength(STREAM_EDITS_PER_TURN_MAX);
    const lastSeq = StreamEditEnvelope.parse(
      JSON.parse((typing.edits.at(-1) as { body: string }).body),
    ).seq;
    expect(lastSeq).toBe(STREAM_EDITS_PER_TURN_MAX);

    // Past the cap: intermediates fall SILENT — no error, no reply — while
    // typing refreshes continue (the indicator is the honest signal left).
    const typingAtCap = typing.events.filter(e => e.state === 'start').length;
    fake.push('over the cap 1');
    fake.push('over the cap 2');
    await new Promise(r => setTimeout(r, 60)); // many fake refresh windows
    expect(typing.edits).toHaveLength(STREAM_EDITS_PER_TURN_MAX);
    expect(
      typing.events.filter(e => e.state === 'start').length,
      'typing must continue past the cap',
    ).toBeGreaterThan(typingAtCap);

    // The FINAL is never capped: the durable edit still lands.
    fake.finish();
    expect(await run).toBe('answered');
    const final = h.sends.at(-1) as { body: string; notify?: false };
    expect(final.notify).toBe(false);
    expect(JSON.parse(final.body)).toMatchObject({
      tcm: 'edit',
      text: 'the capped turn still ends whole',
    });
  }, 60_000);
});

describe('the fresh gate (red-first: a drained backlog streams nothing)', () => {
  it('a trigger older than STREAM_FRESH_MS runs the turn without streaming — one plain reply, no anchor, no edits', async () => {
    new MessageLog('bot').append(
      inRow('queued while attend was down', { ts: Date.now() - STREAM_FRESH_MS - 60_000 }),
    );
    const fake = streamDriver({ reply: 'the backlog answer' });
    seams.driver = fake.driver;
    const h = fakeSend();
    const clock = clockIo();
    const typing = streamTypingFake(clock.now);
    const io = { ...clock, sendReply: h.sendReply, typing: typing.factory };

    const run = attendOnce('bot', io);
    await poll(() => fake.calls() === 1);
    // The mutation trap again: drop the fresh gate in the arming predicate
    // and this push mints an anchor, failing the single-reply assertion.
    fake.push('a bubble nobody is watching');
    await new Promise(r => setTimeout(r, 60));
    expect(fake.offered(), 'a stale trigger never arms the seam').toBe(false);
    fake.finish();
    expect(await run).toBe('answered');
    expect(h.bodies()).toEqual(['the backlog answer']);
    expect(typing.edits).toEqual([]);
    expect(journalFile().streamAnchor).toBeUndefined();
  }, 30_000);
});

describe('chatter isolation and suppression', () => {
  it('a throwing edit channel never fails the turn: same answer, same two durable sends, nothing surfaced', async () => {
    new MessageLog('bot').append(inRow('do the work'));
    const fake = streamDriver({ reply: 'the whole answer' });
    seams.driver = fake.driver;
    const h = fakeSend();
    const clock = clockIo();
    const typing = streamTypingFake(clock.now, { throwOnEdit: true });
    const io = { ...clock, sendReply: h.sendReply, typing: typing.factory };

    const run = attendOnce('bot', io);
    await poll(() => fake.offered());
    fake.push('the whole');
    await poll(() => h.sends.length >= 1); // the anchor still goes — it is durable
    fake.push('the whole answer in progress');
    fake.push('the whole answer in progress, still');
    await new Promise(r => setTimeout(r, 60)); // attempts made, all swallowed
    expect(typing.edits).toEqual([]);

    fake.finish();
    expect(await run).toBe('answered');
    expect(h.sends).toHaveLength(2); // anchor + durable final, exactly
    const final = h.sends[1] as { body: string; notify?: false };
    expect(final.notify).toBe(false);
    expect(JSON.parse(final.body)).toMatchObject({ tcm: 'edit', text: 'the whole answer' });
    expect(
      h.bodies().some(b => /edit transport|error|fail/i.test(b) && !b.startsWith('{"tcm":')),
      'nothing about the channel failure may reach the phone',
    ).toBe(false);
  }, 30_000);

  it('a channel WITHOUT the edit member streams no intermediates — the durable anchor and final still carry the reply', async () => {
    new MessageLog('bot').append(inRow('do the work'));
    const fake = streamDriver({ reply: 'the answer' });
    seams.driver = fake.driver;
    const h = fakeSend();
    const clock = clockIo();
    const typing = streamTypingFake(clock.now, { noEditMember: true });
    const io = { ...clock, sendReply: h.sendReply, typing: typing.factory };

    const run = attendOnce('bot', io);
    await poll(() => fake.offered());
    fake.push('the');
    await poll(() => h.sends.length >= 1);
    fake.push('the answer forming');
    await new Promise(r => setTimeout(r, 60));
    expect(typing.edits).toEqual([]);
    fake.finish();
    expect(await run).toBe('answered');
    expect(h.sends).toHaveLength(2);
    expect(JSON.parse((h.sends[1] as { body: string }).body)).toMatchObject({ tcm: 'edit' });
  }, 30_000);

  it('an in-flight approval suppresses the stream for its whole life: no anchor while parked, emission resumes after the decision', async () => {
    new MessageLog('bot').append(inRow('deploy it'));
    const fake = streamDriver({
      reply: 'done after approval',
      ask: { payload: 'make deploy', ttlMs: 3_600_000, pushBeforeAsk: 'early partial' },
    });
    seams.driver = fake.driver;
    const h = fakeSend();
    const clock = clockIo();
    const typing = streamTypingFake(clock.now);
    const io = { ...clock, sendReply: h.sendReply, typing: typing.factory };

    const run = attendOnce('bot', io);
    await poll(() => approvalRows()[0]?.state === 'pending');
    // The snapshot existed BEFORE the park (pushBeforeAsk), and the park
    // spins the shared cadence for a long fake while — yet no anchor may
    // leave: a parked turn is the model waiting on the HUMAN.
    await new Promise(r => setTimeout(r, 60));
    expect(h.sends).toHaveLength(1); // the approval prompt, and nothing else
    expect((h.sends[0] as { body: string }).body).toContain('Approval needed');
    expect(journalFile().streamAnchor).toBeUndefined();

    const cardMsgId = approvalRows()[0]?.msgId as string;
    new MessageLog('bot').append(inRow('approve', { tcm: 'reply', ref: cardMsgId }));
    // The decision unparks the turn; the next cadence tick mints the anchor
    // from the snapshot that waited.
    await poll(() => h.sends.some(s => s.body === 'early partial'));
    fake.finish();
    expect(await run).toBe('answered');
    const final = h.sends.at(-1) as { body: string; notify?: false };
    expect(final.notify).toBe(false);
    expect(JSON.parse(final.body)).toMatchObject({ tcm: 'edit', text: 'done after approval' });
  }, 30_000);
});

/**
 * THE INTERLEAVED ASK (device demo, build 9) — red-first.
 *
 * The live run's timeline: anchor minted → the approval ask sent BELOW it →
 * owner approves → the turn's final landed as the {tcm:'edit'} on the anchor
 * ABOVE the card — so at the thread's tail nothing new appeared and the
 * owner read "no response". The rule under test: the final rides the edit
 * only while the anchor is still the LAST thing this turn put in the
 * conversation; any durable send after it (today: exactly the approval ask)
 * turns the final into a NEW ordinary reply at the tail, and the anchor
 * keeps its own opening words.
 *
 * The other direction is already pinned above: the lifecycle suite (no
 * interleave → the {tcm:'edit'} final, two durable sends) and the parked-ask
 * test (ask BEFORE the anchor → the anchor is still last → the edit stands).
 */
describe('the interleaved ask: the final lands at the tail, never hidden above the card', () => {
  /** streamDriver's shape with the ask under TEST control: the test releases
   * it only after the anchor exists — the live demo's exact order. */
  const interleaveDriver = (opts: { reply: string; payload: string }) => {
    let stream: ((s: string) => void) | undefined;
    let calls = 0;
    let askNow: (() => void) | undefined;
    const askGate = new Promise<void>(r => {
      askNow = r;
    });
    let release: (() => void) | undefined;
    const released = new Promise<void>(r => {
      release = r;
    });
    let decision: string | undefined;
    const driver: HostDriver = {
      host: 'codex',
      async runTurn(req: TurnRequest) {
        calls += 1;
        stream = req.stream;
        req.steering?.({ sessionKey: THREAD, steer: async () => 'delivered' as const });
        await askGate;
        decision = await req.ask?.({ payload: opts.payload, ttlMs: 3_600_000 });
        await released;
        return { stdout: opts.reply, stderr: '', code: 0, refusal: null };
      },
    };
    return {
      driver,
      push: (s: string): void => stream?.(s),
      calls: () => calls,
      ask: () => askNow?.(),
      decision: () => decision,
      finish: () => release?.(),
    };
  };

  it('an approval asked AFTER the anchor makes the final a NEW ringing reply; the anchor keeps its words and leaves the journal', async () => {
    new MessageLog('bot').append(inRow('create demo.txt'));
    const fake = interleaveDriver({
      reply: 'Created demo.txt with the demo line.',
      payload: 'write demo.txt',
    });
    seams.driver = fake.driver;
    const h = fakeSend();
    const clock = clockIo();
    const typing = streamTypingFake(clock.now);
    const io = { ...clock, sendReply: h.sendReply, typing: typing.factory };

    const run = attendOnce('bot', io);
    await poll(() => fake.calls() === 1);

    // The anchor first — the turn's opening snapshot, durable.
    fake.push('I will create demo.txt with the demo line.');
    await poll(() => h.sends.length >= 1);
    const anchor = h.sends[0] as { id: string; body: string };
    expect(journalFile().streamAnchor).toBe(anchor.id);

    // THEN the ask: the approval row lands BELOW the anchor in the thread.
    fake.ask();
    await poll(() => approvalRows()[0]?.state === 'pending');
    expect(h.sends).toHaveLength(2);
    expect((h.sends[1] as { body: string }).body).toContain('Approval needed');

    // The owner approves; the turn finishes.
    const cardMsgId = approvalRows()[0]?.msgId as string;
    new MessageLog('bot').append(inRow('approve', { tcm: 'reply', ref: cardMsgId }));
    await poll(() => fake.decision() === 'approve');
    fake.finish();
    expect(await run).toBe('answered');

    // THE FIX, pinned (red before: the last send was the {tcm:'edit'} onto
    // the anchor, notify:false — invisible at the tail): the final is a NEW
    // plain reply, and it RINGS, because at the tail it is genuinely new.
    const final = h.sends.at(-1) as { body: string; notify?: false };
    expect(final.body).toBe('Created demo.txt with the demo line.');
    expect(final.body.startsWith('{"tcm":'), 'the final is prose, not a carrier').toBe(false);
    expect(final.notify, 'a genuinely new tail message rings').toBeUndefined();
    expect(
      h.bodies().filter(b => b.startsWith('{"tcm":"edit"')),
      'no durable edit may land on an anchor the turn already wrote past',
    ).toEqual([]);

    // The anchor stands on its own opening words — the honest first message
    // of the turn — and its journal debt is retired with the decision made
    // here, so no restart sweep can paint an edit over it.
    expect(anchor.body).toBe('I will create demo.txt with the demo line.');
    expect(journalFile().streamAnchor).toBeUndefined();
    // Exactly three durable rows: the anchor, the ask, the tail final.
    expect(h.sends).toHaveLength(3);
  }, 30_000);
});

describe('crash → restart (the journal rails)', () => {
  it('a pass that dies after the anchor leaves owes it the interrupted sentence AS the final edit — and no loop outlives the dead turn', async () => {
    const log = new MessageLog('bot');
    log.append(inRow('start the long job'));
    const fake = streamDriver({ failWith: new Error('SIGKILL mid-turn') });
    seams.driver = fake.driver;
    const h = fakeSend();
    const clock = clockIo();
    const typing = streamTypingFake(clock.now);
    const io = { ...clock, sendReply: h.sendReply, typing: typing.factory };

    const run = attendOnce('bot', io);
    await poll(() => fake.offered());
    fake.push('the job is half');
    await poll(() => h.sends.length >= 1);
    const anchor = h.sends[0] as { id: string };
    expect(journalFile().streamAnchor).toBe(anchor.id);
    fake.finish();
    await expect(run).rejects.toThrow('SIGKILL mid-turn');

    // No emission may follow the crashed turn (the turnOver bound covers
    // the stream tenant exactly as it covers typing — one loop, one bound).
    await poll(() => typing.closed() === 1);
    const editsAtDeath = typing.edits.length;
    fake.push('a push after death');
    await new Promise(r => setTimeout(r, 60));
    expect(typing.edits.length).toBe(editsAtDeath);

    // THE RESTART SWEEP: the journalled anchor gets the interrupted
    // sentence as its durable final — the bubble tells the truth instead of
    // holding half a thought forever — and nothing is re-run.
    const h2 = fakeSend();
    const out = await attendOnce('bot', { ...clockIo(), sendReply: h2.sendReply });
    expect(out).toBe('interrupted');
    expect(fake.calls(), 'the interrupted turn is answered, never re-run').toBe(1);
    expect(h2.sends).toHaveLength(1);
    const final = h2.sends[0] as { body: string; notify?: false };
    expect(final.notify).toBe(false);
    const parsed = JSON.parse(final.body) as { tcm: string; ref: string; text: string };
    expect(parsed.tcm).toBe('edit');
    expect(parsed.ref).toBe(anchor.id);
    expect(parsed.text).toContain('A turn was interrupted before it reported back');
    expect(journalFile().streamAnchor, 'the consumed anchor leaves the journal').toBeUndefined();
  }, 30_000);

  it('a crash with NO journalled anchor keeps today’s interrupted reply byte-identical', async () => {
    attestedCfg({ streamMinAppBuild: undefined });
    new MessageLog('bot').append(inRow('start the job'));
    const fake = streamDriver({ failWith: new Error('SIGKILL mid-turn') });
    seams.driver = fake.driver;
    const h = fakeSend();
    const run = attendOnce('bot', { ...clockIo(), sendReply: h.sendReply });
    await poll(() => fake.calls() === 1);
    fake.finish();
    await expect(run).rejects.toThrow('SIGKILL mid-turn');

    const h2 = fakeSend();
    expect(await attendOnce('bot', { ...clockIo(), sendReply: h2.sendReply })).toBe('interrupted');
    expect(h2.bodies()).toEqual([
      'A turn was interrupted before it reported back — it may have partly run. ' +
        'Nothing was re-run. Send it again if you want it retried.',
    ]);
  }, 30_000);
});

describe('attend enable --stream (the attestation surface)', () => {
  const enableOpts = (over: Record<string, unknown> = {}) => ({
    bin: process.execPath, // an executable file wherever this suite runs
    workdir: tmpdir(),
    ...over,
  });

  it('writes the floor, and enable reads the claim back as an ATTESTATION with its failure mode named', () => {
    const human: string[] = [];
    const rep = report();
    rep.emit = (_r: Record<string, unknown>, h: string) => void human.push(h);
    cmdAttendEnable(
      'bot',
      enableOpts({ host: 'codex', driver: 'app-server', streamMinAppBuild: 42 }),
      rep,
    );
    expect(loadAttendConfig('bot')!.streamMinAppBuild).toBe(42);
    const said = human.join('\n');
    expect(said).toContain('STREAM');
    expect(said).toContain('app build 42');
    expect(said).toContain('ATTESTATION');
    expect(said).toContain('cannot check');
    expect(said).toContain('re-run enable without');
    expect(said).toContain('--stream');
  });

  it('un-stated stays absent — never invented, and enable does not mention streaming unasked', () => {
    const human: string[] = [];
    const rep = report();
    rep.emit = (_r: Record<string, unknown>, h: string) => void human.push(h);
    cmdAttendEnable('bot', enableOpts({ host: 'codex', driver: 'app-server' }), rep);
    expect(loadAttendConfig('bot')!.streamMinAppBuild).toBeUndefined();
    expect(human.join('\n')).not.toContain('STREAM');
  });

  it('refuses every profile that cannot stream (v1: codex app-server only), and the zero/float shapes', () => {
    const refuse = (opts: Record<string, unknown>, why: RegExp): void => {
      try {
        // The sdk seams let the claude-sdk case reach the --stream check
        // instead of dying earlier on the module/key preconditions — the
        // refusal under test must be --stream's own.
        cmdAttendEnable('bot', enableOpts(opts), report(), {
          sdkPresent: () => true,
          env: { ANTHROPIC_API_KEY: 'sk-test' },
        });
        expect.unreachable(`must refuse: ${JSON.stringify(Object.keys(opts))}`);
      } catch (err) {
        expect(err).toBeInstanceOf(CliError);
        expect((err as InstanceType<typeof CliError>).exitCode).toBe(EXIT.USAGE);
        expect((err as Error).message).toMatch(why);
      }
    };
    refuse({ streamMinAppBuild: 42 }, /--stream applies only/); // default host is claude
    refuse({ host: 'claude', driver: 'sdk', streamMinAppBuild: 42 }, /--stream applies only/);
    refuse({ host: 'codex', streamMinAppBuild: 42 }, /--stream applies only/); // exec default
    refuse({ host: 'codex', driver: 'exec', streamMinAppBuild: 42 }, /--stream applies only/);
    refuse({ host: 'codex', driver: 'app-server', streamMinAppBuild: 0 }, /--stream expects/);
    refuse({ host: 'codex', driver: 'app-server', streamMinAppBuild: 4.5 }, /--stream expects/);
    // Nothing above may have rewritten the profile: the beforeEach config
    // (bin /opt/codex) survives untouched — a refused enable that had
    // written anything would carry this suite's process.execPath bin.
    expect(loadAttendConfig('bot')?.bin).toBe('/opt/codex');
  });
});

/**
 * THE ANCHOR SPEAKS FOR THE LIVE THREAD — red-first.
 *
 * The streamed anchor is the ONLY bubble the operator sees mid-turn, so its
 * ledger row is the reply surface: a long-press reply carries ref = the
 * anchor's msgId, and routeIn resolves that ref through the row's `sess`.
 * A sessionless anchor row therefore broke the natural gesture twice over:
 * mid-stream the reply routed carry:<anchorId> ∉ runningKeys (queued, while
 * a BARE text steered), and post-turn it fell to the carry fallback forever
 * (the sess-bearing row belonged to the invisible final-edit carrier msgId
 * nothing ever refs). The fix rides the key the pass already trusts — the
 * thread key `steering` surfaced into runningKeys — onto the anchor's row.
 */

/** The reply seam grown realSendReply's LEDGER half: the routing row, with
 * the sess exactly as handed — which is what lets routeIn (and the steer
 * poller's routeKey check) see what a real pass would see. */
const ledgerSend = () => {
  const sends: { body: string; id: string; sess?: OutSess; notify?: false }[] = [];
  return {
    sends,
    sendReply: async (
      b: string,
      sess?: OutSess,
      opts?: { notify?: boolean },
    ): Promise<string> => {
      const id = mid();
      sends.push({
        body: b,
        id,
        ...(sess ? { sess } : {}),
        ...(opts?.notify === false ? { notify: false as const } : {}),
      });
      new MessageLog('bot').append({
        id,
        dir: 'out',
        peer: OWNER,
        ts: Date.now(),
        tcm: '',
        text: '',
        read: true,
        ...(sess ? { sess } : {}),
      });
      return id;
    },
  };
};

/** streamDriver's shape grown the app-server driver's OTHER mid-turn seam:
 * `steering` surfaced with the live thread key before the first snapshot —
 * the measured wire order (`turn/started` precedes the first delta, and
 * thread capture precedes `turn/start` structurally). Steer texts are
 * recorded; routes and prompts are captured for the post-turn resume pin. */
const steeringStreamDriver = (opts: { reply?: string; threadKey?: string } = {}) => {
  let stream: ((s: string) => void) | undefined;
  const steered: string[] = [];
  const routes: unknown[] = [];
  const prompts: string[] = [];
  let calls = 0;
  let release: (() => void) | undefined;
  const released = new Promise<void>(r => {
    release = r;
  });
  const driver: HostDriver = {
    host: 'codex',
    async runTurn(req: TurnRequest) {
      calls += 1;
      routes.push(req.route);
      prompts.push(req.prompt);
      stream = req.stream;
      req.steering?.({
        ...(opts.threadKey !== undefined ? { sessionKey: opts.threadKey } : {}),
        steer: async (text: string) => {
          steered.push(text);
          return 'delivered' as const;
        },
      });
      await released;
      return {
        stdout: opts.reply ?? 'final answer',
        stderr: '',
        code: 0,
        refusal: null,
        ...(opts.threadKey !== undefined ? { sessionKey: opts.threadKey } : {}),
      };
    },
  };
  return {
    driver,
    push: (s: string): void => stream?.(s),
    steered,
    routes,
    prompts,
    calls: () => calls,
    finish: () => release?.(),
  };
};

describe('the anchor speaks for the live thread (red-first)', () => {
  it('mid-stream, a reply to the streaming bubble STEERS the running turn — the anchor row carries the live sess', async () => {
    new MessageLog('bot').append(inRow('write the essay'));
    const fake = steeringStreamDriver({ reply: 'the essay, finished', threadKey: THREAD });
    seams.driver = fake.driver;
    const h = ledgerSend();
    const clock = clockIo();
    const typing = streamTypingFake(clock.now);
    const io = { ...clock, sendReply: h.sendReply, typing: typing.factory };

    const run = attendOnce('bot', io);
    await poll(() => fake.calls() === 1);
    fake.push('The essay so far');
    await poll(() => h.sends.length >= 1);
    const anchor = h.sends[0] as { id: string; sess?: OutSess };

    // The natural gesture: reply to the bubble that is visibly being
    // written. With the sess on the anchor row it routes session:<key> ∈
    // runningKeys and rides turn/steer — red before the fix (carry route,
    // silently queued behind a turn it was aimed at).
    new MessageLog('bot').append(inRow('tighten the ending', { tcm: 'reply', ref: anchor.id }));
    await poll(() => fake.steered.length === 1, 6_000);
    expect(fake.steered).toEqual(['tighten the ending']);

    // The row itself: the anchor speaks for the thread the turn RUNS AS —
    // the same frame-borne key, through the same hostSessionKey gate.
    expect(anchor.sess).toEqual({ host: 'codex', key: THREAD, tag: sessionTag(THREAD) });

    fake.finish();
    expect(await run).toBe('answered');
  }, 30_000);

  it('post-turn, a reply to the anchor RESUMES the thread — the session route, never the carry fallback', async () => {
    new MessageLog('bot').append(inRow('write the essay'));
    const fake = steeringStreamDriver({ reply: 'the essay, finished', threadKey: THREAD });
    seams.driver = fake.driver;
    const h = ledgerSend();
    const clock = clockIo();
    const typing = streamTypingFake(clock.now);

    const run = attendOnce('bot', { ...clock, sendReply: h.sendReply, typing: typing.factory });
    await poll(() => fake.calls() === 1);
    fake.push('The essay so far');
    await poll(() => h.sends.length >= 1);
    const anchor = h.sends[0] as { id: string };
    fake.finish();
    expect(await run).toBe('answered');

    // The operator replies to the finished bubble — the anchor's msgId is
    // the only id their phone can ref. Red before the fix: the anchor row
    // had no sess, so this routed carry and re-ran fresh, forever.
    new MessageLog('bot').append(inRow('and another thing', { tcm: 'reply', ref: anchor.id }));
    const fake2 = steeringStreamDriver({ reply: 'continued in-thread', threadKey: THREAD });
    seams.driver = fake2.driver;
    const h2 = ledgerSend();
    const run2 = attendOnce('bot', { ...clockIo(), sendReply: h2.sendReply });
    await poll(() => fake2.calls() === 1);
    fake2.finish();
    expect(await run2).toBe('answered');
    expect(fake2.routes[0], 'the reply resumes the captured thread').toEqual({
      kind: 'session',
      host: 'codex',
      key: THREAD,
    });
    expect(
      (fake2.prompts[0] as string).includes('[replying to'),
      'a resumed thread needs no carry context line',
    ).toBe(false);
  }, 30_000);

  it('the carry fallback still owns rows that genuinely have no session: never steered mid-turn, carry-routed after', async () => {
    // A notify-shaped out row — the sessionless shape every MCP notify/ask
    // row and hook-without-session row is born with. The anchor gate must not touch it.
    const log = new MessageLog('bot');
    const notifyId = mid();
    log.append({
      id: notifyId,
      dir: 'out' as const,
      peer: OWNER,
      ts: Date.now(),
      tcm: '',
      text: '',
      read: true,
    });

    log.append(inRow('write the essay'));
    const fake = steeringStreamDriver({ reply: 'the essay, finished', threadKey: THREAD });
    seams.driver = fake.driver;
    const h = ledgerSend();
    const clock = clockIo();
    const typing = streamTypingFake(clock.now);
    const run = attendOnce('bot', { ...clock, sendReply: h.sendReply, typing: typing.factory });
    await poll(() => fake.calls() === 1);
    fake.push('The essay so far');
    await poll(() => h.sends.length >= 1);

    // Mid-turn, a reply to the SESSIONLESS row must not ride turn/steer —
    // carry:<id> ∉ runningKeys even while the live thread key is in it.
    const replyRow = inRow('follow up on that notification', { tcm: 'reply', ref: notifyId });
    log.append(replyRow);
    await new Promise(r => setTimeout(r, 60)); // many fake cadence ticks
    expect(fake.steered, 'a sessionless ref never steers the running turn').toEqual([]);

    fake.finish();
    expect(await run).toBe('answered');

    // Post-turn the same reply routes carry — the fallback the sessionless
    // shape is owed, byte-identical to before the anchor gate.
    expect(route('bot', [replyRow], Date.now(), 'codex')).toEqual({
      kind: 'carry',
      refId: notifyId,
      refText: '',
    });
  }, 30_000);
});
