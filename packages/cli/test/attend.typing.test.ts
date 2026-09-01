import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OutSess, RoomReplyOutcome, TypingChannel } from '../src/attend.js';
import type { HostDriver, TurnRequest } from '../src/attend-drivers.js';

/**
 * TYPING WHILE A TURN RUNS — the
 * cadence, its bounds, and everything it must never do.
 *
 * What this file pins:
 *  1. the ARITHMETIC: refresh + one poll tick stays under the app's expiry,
 *     and the emission rate sits an order of magnitude inside the server's
 *     typing bucket — asserted on the CONSTANTS' relations, never wall time
 *     (the frozen-clock ruling), against the app's and the server's own
 *     source files so a drift on either side turns this file red;
 *  2. a 1:1 turn emits `start` at its first cadence tick, refreshes under
 *     the expiry, and stops exactly once at turn end — on a MOVING clock;
 *  3. ROOM TURNS EMIT NONE, v1, pinned (the channel is never even
 *     minted — red-first: widen the gate in attend.ts and this fails);
 *  4. a mid-turn CRASH leaves no loop: the turnOver bound ends the cadence
 *     even when runTurn THROWS (red-first: move `turnOver = true` off the
 *     finally and this fails);
 *  5. typing failures are CHATTER: a throwing channel never fails, delays
 *     or retries the turn, and nothing about it reaches the phone;
 *  6. a PARKED turn does not claim to be typing — an in-flight approval
 *     pauses the cadence for its whole life;
 *  7. the WIRE FORM through the real channel is byte-identical to the app's
 *     1:1 emission — `{"tcm":"x.typing","state":…}` sealed by the ratchet,
 *     framed as the relay-only `typing` frame on ONE 'send'-role socket per
 *     turn — and it spends no attend turn token.
 *
 * The spool, cursor, journal, bucket and approvals file are REAL files in a
 * temp home (the spine precedent); the driver, the reply transport and —
 * except in the wire tests — the typing channel are seams.
 */

const home = mkdtempSync(join(tmpdir(), 'tacendum-attend-typing-'));
process.env.TACENDUM_HOME = home;
process.env.TACENDUM_API = 'http://attend-typing.test';
process.env.TACENDUM_WS = 'ws://attend-typing.test';

const seams = vi.hoisted(() => ({
  driver: null as HostDriver | null,
  /** The wire tests' recorder. Null (the default) leaves `hasSession` false,
   * which is the real channel's first gate — so a test that forgets a typing
   * fake stays off every socket, exactly as the seam's contract states. */
  wire: null as null | {
    connects: string[];
    frames: { type: string; to: string; msgType: string; payload: string }[];
    sealed: string[];
    closed: number;
    /** What `isOpen()` answers — the liveness gate's lever. */
    open: boolean;
    /** When true, every dial attempt is recorded and refused. */
    connectFail?: boolean;
  },
}));

vi.mock('../src/attend-drivers.js', async importOriginal => {
  const real = await importOriginal<typeof import('../src/attend-drivers.js')>();
  return {
    ...real,
    driverFor: (host: Parameters<typeof real.driverFor>[0]) =>
      seams.driver ?? real.driverFor(host),
  };
});
// The real typing channel's transport, mocked FILE-WIDE: nothing else in
// this file constructs a WsClient or seals bytes (every reply rides the
// sendReply seam), so the mock only ever serves realTypingChannel.
vi.mock('../src/wsclient.js', async importOriginal => {
  const real = await importOriginal<typeof import('../src/wsclient.js')>();
  class FakeWs {
    async connect(_auth: unknown, role?: string): Promise<void> {
      if (seams.wire === null) throw new Error('no wire seam in this test');
      seams.wire.connects.push(role ?? 'listen');
      if (seams.wire.connectFail === true) throw new Error('dial refused');
    }
    isOpen(): boolean {
      return seams.wire?.open === true;
    }
    send(frame: { type: string; to: string; msgType: string; payload: string }): void {
      seams.wire?.frames.push(frame);
    }
    close(): void {
      if (seams.wire !== null) seams.wire.closed += 1;
    }
  }
  return { ...real, WsClient: FakeWs };
});
vi.mock('../src/messaging.js', async importOriginal => {
  const real = await importOriginal<typeof import('../src/messaging.js')>();
  return {
    ...real,
    hasSession: async (): Promise<boolean> => seams.wire !== null,
    encryptText: async (
      _stores: unknown,
      _self: string,
      _to: string,
      body: string,
    ): Promise<{ msgType: string; payload: string }> => {
      seams.wire?.sealed.push(body);
      return { msgType: 'ciphertext', payload: 'SEALED64' };
    },
  };
});

const attendMod = await import('../src/attend.js');
const {
  APP_TYPING_EXPIRY_MS,
  ATTEND_POLL_MS,
  ATTEND_REPLY_CAP,
  ATTEND_TYPING_REFRESH_MS,
  STREAM_EDITS_PER_TURN_MAX,
  STREAM_FRESH_MS,
  attendOnce,
  saveAttendConfig,
} = attendMod;
const { MAX_STREAM_EDIT_TEXT_CHARS } = await import('@tacendum/shared');
const { MessageLog } = await import('../src/msglog.js');
const { saveProfile } = await import('../src/profile.js');
// The two sides this cadence must honour, read from THEIR OWN source files —
// a resize on either side turns the arithmetic tests red here, which is the
// pin the mirrored constant in attend.ts needs to stay honest.
const { TYPING_EXPIRY_MS } = await import('../../../app/src/typing.js');
const { LIMITS } = await import('../../server/src/ratelimit.js');

const OWNER = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const SELF = '01HQXW0000000000000000TEST';
const GID = '01GRPAAAAAAAAAAAAAAAAAAAAA';
const OWN_SESSION = 'ffffffff-9999-4999-8999-999999999999';

let seq = 0;
const mid = (): string => `01HQXT00000000000000${String(++seq).padStart(6, '0')}`.slice(0, 26);

const statePath = (f: string): string => join(home, 'state', 'bot', f);
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

/** A spooled room row, exactly as inbound.ts persists one. */
function roomRow(text: string) {
  return {
    id: mid(),
    dir: 'in' as const,
    peer: OWNER,
    ts: Date.now(),
    tcm: 'grp.msg',
    text,
    read: false,
    grp: GID,
    men: true,
  };
}

async function poll(cond: () => boolean, ms = 10_000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error('poll timed out');
    await new Promise(r => setTimeout(r, 10));
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

/** The typing seam's recorder: every emission stamped off the SAME clock the
 * pass runs on, so cadence assertions are fake-clock arithmetic. */
const typingFake = (now: () => number, opts: { throwOnSend?: boolean } = {}) => {
  const events: { state: 'start' | 'stop'; at: number }[] = [];
  const targets: string[] = [];
  let minted = 0;
  let closed = 0;
  return {
    events,
    targets,
    minted: () => minted,
    closed: () => closed,
    factory: (to: string): TypingChannel => {
      minted += 1;
      targets.push(to);
      return {
        send: async (state: 'start' | 'stop'): Promise<void> => {
          if (opts.throwOnSend === true) throw new Error('typing transport down');
          events.push({ state, at: now() });
        },
        close: (): void => {
          closed += 1;
        },
      };
    },
  };
};

/** A driver whose turn stays LIVE until the test releases it — the shape
 * every cadence assertion needs — optionally steering, asking or dying. */
const heldDriver = (opts: {
  host?: 'claude' | 'codex';
  reply?: string;
  surfaceSteer?: boolean;
  ask?: { payload: string; ttlMs: number };
  failWith?: Error;
} = {}) => {
  const steered: string[] = [];
  let calls = 0;
  let release: (() => void) | undefined;
  const released = new Promise<void>(r => {
    release = r;
  });
  const driver: HostDriver = {
    host: opts.host ?? 'claude',
    async runTurn(req: TurnRequest) {
      calls += 1;
      if (calls > 1) return { stdout: `plain turn ${calls}`, stderr: '', code: 0, refusal: null };
      if (opts.surfaceSteer === true) {
        req.steering?.({
          steer: async text => {
            steered.push(text);
            return 'delivered';
          },
        });
      }
      if (opts.ask !== undefined && req.ask !== undefined) {
        const d = await req.ask({ payload: opts.ask.payload, ttlMs: opts.ask.ttlMs });
        return { stdout: `decision:${d}`, stderr: '', code: 0, refusal: null };
      }
      await released;
      if (opts.failWith !== undefined) throw opts.failWith;
      return { stdout: opts.reply ?? 'turn done', stderr: '', code: 0, refusal: null };
    },
  };
  return { driver, steered, calls: () => calls, finish: () => release?.() };
};

beforeEach(() => {
  rmSync(join(home, 'bot'), { recursive: true, force: true });
  rmSync(join(home, 'state'), { recursive: true, force: true });
  seq = 0;
  seams.driver = null;
  seams.wire = null;
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

describe('the arithmetic (asserted on constants, never wall time)', () => {
  it("the mirrored expiry IS the app's, refresh sits at half of it, and the worst gap stays under it", () => {
    // The mirror in attend.ts must equal the app's own constant — the app
    // package is not importable from src, so the TEST is the tie.
    expect(APP_TYPING_EXPIRY_MS).toBe(TYPING_EXPIRY_MS);
    expect(ATTEND_TYPING_REFRESH_MS).toBeLessThanOrEqual(TYPING_EXPIRY_MS / 2);
    // The refresh threshold is crossed between poll ticks, so the WORST
    // inter-frame gap is refresh + one full tick — and it must stay under
    // the receiver's expiry or a live turn's indicator flickers.
    expect(ATTEND_TYPING_REFRESH_MS + ATTEND_POLL_MS).toBeLessThan(TYPING_EXPIRY_MS);
  });

  it("the emission rate sits 10x inside the server's typing bucket, and the burst holds start + stop", () => {
    // One frame per refresh threshold is the sustained ceiling this cadence
    // can produce; the server's own bucket (typing:<sender>) must dwarf it.
    const worstPerSec = 1000 / ATTEND_TYPING_REFRESH_MS;
    expect(worstPerSec).toBeLessThanOrEqual(LIMITS.typing.refillPerSec / 10);
    // Turn end may put a `stop` right behind a `start`: two tokens of burst
    // is the floor this pattern needs; the bucket holds 15.
    expect(LIMITS.typing.capacity).toBeGreaterThanOrEqual(2);
  });

  it("stream edits plus typing refreshes hold 4x headroom in the SAME bucket, the ratchet-burn cap stays small against libsignal's jump ceiling, and every funneled snapshot composes", () => {
    // THE RATE DECISION's arithmetic,
    // asserted on the constants so a resize on any side turns this red:
    // one x.edit per poll tick (0.5/s) plus one typing refresh per
    // threshold (0.134/s) against the server's sustained refill (3/s) —
    // the named 4.7x headroom, floored here at 4x.
    const streamPerSec = 1000 / ATTEND_POLL_MS;
    const typingPerSec = 1000 / ATTEND_TYPING_REFRESH_MS;
    expect((streamPerSec + typingPerSec) * 4).toBeLessThanOrEqual(LIMITS.typing.refillPerSec);
    // The plan's guards, pinned by value: a drifted constant is a decision
    // nobody re-made.
    expect(STREAM_EDITS_PER_TURN_MAX).toBe(300);
    expect(STREAM_FRESH_MS).toBe(600_000);
    // THE RATCHET-BURN BOUND: the worst UNWITNESSED turn — the cap's edits
    // plus the typing refreshes sharing the span those edits take at one
    // per tick — must stay a small fraction (≤2%) of libsignal's 25 000
    // forward-jump ceiling (MAX_FORWARD_JUMPS, libsignal-client), so sealed
    // frames an offline owner never saw can never wedge their ratchet.
    const capSpanMs = STREAM_EDITS_PER_TURN_MAX * ATTEND_POLL_MS;
    const worstSealedFrames = STREAM_EDITS_PER_TURN_MAX + capSpanMs / ATTEND_TYPING_REFRESH_MS;
    expect(worstSealedFrames).toBeLessThanOrEqual(25_000 * 0.02);
    // EVERY FUNNELED SNAPSHOT COMPOSES: the reply funnel's cap (UTF-16
    // units) sits inside the envelope's text cap counted in the same unit,
    // so `composeStreamEdit` can never refuse a snapshot the funnel passed
    // on size — the only compose refusal left is the leading sentinel.
    expect(ATTEND_REPLY_CAP).toBeLessThanOrEqual(MAX_STREAM_EDIT_TEXT_CHARS);
  });
});

describe('a 1:1 turn says it is typing (moving clock)', () => {
  it('start at the first tick, refreshed under the expiry, stopped exactly once at turn end — and no turn token spent on any of it', async () => {
    new MessageLog('bot').append(inRow('start the work'));
    const fake = heldDriver({ reply: 'the answer' });
    seams.driver = fake.driver;
    const h = fakeSend();
    const clock = clockIo();
    const typing = typingFake(clock.now);
    const io = { ...clock, sendReply: h.sendReply, typing: typing.factory };

    const run = attendOnce('bot', io);
    await poll(() => typing.events.filter(e => e.state === 'start').length >= 3);

    // Every emission aims at the OWNER — the only 1:1 the turn speaks to.
    expect(typing.targets).toEqual([OWNER]);
    const starts = typing.events.filter(e => e.state === 'start');
    // Refreshes ride the poll grid: each gap is at least the threshold and
    // at most the threshold plus two ticks — fake-clock arithmetic, and
    // every gap under the app's expiry so the indicator never flickers.
    for (let i = 1; i < starts.length; i += 1) {
      const gap = (starts[i] as { at: number }).at - (starts[i - 1] as { at: number }).at;
      expect(gap).toBeGreaterThanOrEqual(ATTEND_TYPING_REFRESH_MS);
      expect(gap).toBeLessThanOrEqual(ATTEND_TYPING_REFRESH_MS + 2 * ATTEND_POLL_MS);
      expect(gap).toBeLessThan(APP_TYPING_EXPIRY_MS);
    }

    fake.finish();
    expect(await run).toBe('answered');
    // Exactly one stop, and it is the LAST emission — the loop's epilogue,
    // sequenced before the pass's replies by the awaited loop.
    expect(typing.events.filter(e => e.state === 'stop')).toHaveLength(1);
    expect(typing.events.at(-1)?.state).toBe('stop');
    expect(typing.closed()).toBe(1);
    // Chatter below the brake: ONE turn token for the whole affair, and
    // nothing typing-shaped in what reached the phone.
    expect(bucketTurns()).toBe(1);
    expect(h.bodies).toEqual(['the answer']);
  }, 30_000);

  it('one cadence loop serves typing AND the steer scan — both work in the same turn', async () => {
    saveAttendConfig('bot', {
      host: 'codex', bin: '/opt/codex', workdir: '/w', caps: ['-s', 'read-only'],
      codexDriver: 'app-server', ownSession: OWN_SESSION, turnsPerHour: 10,
    });
    const log = new MessageLog('bot');
    log.append(inRow('start the work'));
    const fake = heldDriver({ host: 'codex', surfaceSteer: true, reply: 'steered answer' });
    seams.driver = fake.driver;
    const h = fakeSend();
    const clock = clockIo();
    const typing = typingFake(clock.now);
    const io = { ...clock, sendReply: h.sendReply, typing: typing.factory };

    const run = attendOnce('bot', io);
    await poll(() => typing.events.some(e => e.state === 'start'));
    log.append(inRow('use the staging env'));
    await poll(() => fake.steered.length === 1);
    expect(fake.steered).toEqual(['use the staging env']);

    fake.finish();
    expect(await run).toBe('answered');
    expect(typing.events.at(-1)?.state).toBe('stop');
    // The budget saw the turn and the delivered steer — typing added zero.
    expect(bucketTurns()).toBe(2);
  }, 30_000);
});

describe('room turns emit none (v1, pinned)', () => {
  it('a room turn never even mints a typing channel', async () => {
    new MessageLog('bot').append(roomRow('[crew] @you ship it'));
    const fake = heldDriver({ reply: 'shipped' });
    seams.driver = fake.driver;
    const h = fakeSend();
    const clock = clockIo();
    const typing = typingFake(clock.now);
    const roomReplies: { gid: string; body: string }[] = [];
    const io = {
      ...clock,
      sendReply: h.sendReply,
      sendRoomReply: async (gid: string, body: string): Promise<RoomReplyOutcome> => {
        roomReplies.push({ gid, body });
        return { m: '01MSGREPLYAAAAAAAAAAAAAAAA', delivered: [OWNER], skipped: [], failed: [] };
      },
      typing: typing.factory,
    };

    const run = attendOnce('bot', io);
    await poll(() => fake.calls() === 1);
    // Let the cadence loop run well past several refresh thresholds.
    await new Promise(r => setTimeout(r, 60));
    expect(typing.minted(), 'a room turn must never mint a typing channel').toBe(0);
    expect(typing.events).toEqual([]);

    fake.finish();
    expect(await run).toBe('answered');
    expect(typing.minted()).toBe(0);
    expect(typing.closed()).toBe(0);
    expect(roomReplies).toHaveLength(1);
  }, 30_000);
});

describe('the turnOver bound: no loop outlives the turn', () => {
  it('a turn that THROWS still ends the cadence: one stop, one close, and not another emission afterwards', async () => {
    new MessageLog('bot').append(inRow('start the work'));
    const fake = heldDriver({ failWith: new Error('SIGKILL mid-turn') });
    seams.driver = fake.driver;
    const h = fakeSend();
    const clock = clockIo();
    const typing = typingFake(clock.now);
    const io = { ...clock, sendReply: h.sendReply, typing: typing.factory };

    const run = attendOnce('bot', io);
    await poll(() => typing.events.some(e => e.state === 'start'));
    fake.finish();
    await expect(run).rejects.toThrow('SIGKILL mid-turn');

    // The loop self-terminates on the turnOver bound the runTurn finally
    // set, closing the channel on its way out.
    await poll(() => typing.closed() === 1);
    const settled = typing.events.length;
    // A leaked loop on this fake clock would cross a refresh threshold and
    // emit again within a few real milliseconds — give it many.
    await new Promise(r => setTimeout(r, 60));
    expect(typing.events.length, 'no emission may follow the crashed turn').toBe(settled);
    expect(typing.events.filter(e => e.state === 'stop')).toHaveLength(1);
    expect(typing.events.at(-1)?.state).toBe('stop');
  }, 30_000);
});

describe('typing is chatter: never fails the turn, never leaks', () => {
  it('a channel that throws on every send changes nothing: same answer, same replies, no failure surfaced', async () => {
    new MessageLog('bot').append(inRow('start the work'));
    const fake = heldDriver({ reply: 'the answer' });
    seams.driver = fake.driver;
    const h = fakeSend();
    const clock = clockIo();
    const typing = typingFake(clock.now, { throwOnSend: true });
    const io = { ...clock, sendReply: h.sendReply, typing: typing.factory };

    const run = attendOnce('bot', io);
    await poll(() => fake.calls() === 1);
    // Give the cadence several chances to attempt (and swallow) emissions.
    await new Promise(r => setTimeout(r, 60));
    fake.finish();
    expect(await run).toBe('answered');
    expect(h.bodies, 'nothing about the failure may reach the phone').toEqual(['the answer']);
    expect(typing.minted()).toBe(1);
    expect(typing.closed()).toBe(1);
    expect(typing.events).toEqual([]);
  }, 30_000);

  it('a parked turn does not claim to be typing: an in-flight approval pauses the cadence for its whole life', async () => {
    new MessageLog('bot').append(inRow('do the deploy'));
    const fake = heldDriver({ ask: { payload: 'make deploy', ttlMs: 3_600_000 } });
    seams.driver = fake.driver;
    const h = fakeSend();
    const clock = clockIo();
    const typing = typingFake(clock.now);
    const io = { ...clock, sendReply: h.sendReply, typing: typing.factory };

    const run = attendOnce('bot', io);
    await poll(() => approvalRows()[0]?.state === 'pending');
    // The park spins the shared cadence for a long fake while; not one
    // typing frame may leave (the model is waiting on the HUMAN).
    await new Promise(r => setTimeout(r, 60));
    const cardMsgId = approvalRows()[0]?.msgId as string;
    new MessageLog('bot').append(inRow('approve', { tcm: 'reply', ref: cardMsgId }));
    expect(await run).toBe('answered');

    expect(typing.events, 'a parked turn never says typing').toEqual([]);
    expect(typing.closed()).toBe(1);
  }, 30_000);
});

describe('the wire form, through the REAL channel (byte-compat with the app)', () => {
  it("seals the app's exact 1:1 envelope bytes, frames them as relay-only `typing`, and holds ONE 'send'-role socket for the whole turn", async () => {
    seams.wire = { connects: [], frames: [], sealed: [], closed: 0, open: true };
    new MessageLog('bot').append(inRow('start the work'));
    const fake = heldDriver({ reply: 'the answer' });
    seams.driver = fake.driver;
    const h = fakeSend();
    // NO typing seam: the pass mints realTypingChannel, whose transport is
    // the mocked WsClient/ratchet above.
    const io = { ...clockIo(), sendReply: h.sendReply };

    const run = attendOnce('bot', io);
    await poll(() => (seams.wire as NonNullable<typeof seams.wire>).frames.length >= 2);
    fake.finish();
    expect(await run).toBe('answered');

    const wire = seams.wire as NonNullable<typeof seams.wire>;
    // THE BYTES: the app's own 1:1 form — `room` absent — start while the
    // turn ran, stop at its end, nothing else ever sealed. `ai:true` rides
    // every frame: the chatter is agent-authored, the field is
    // invisible to every shipped build (TypingEnvelope strips unknown keys).
    expect(wire.sealed[0]).toBe('{"tcm":"x.typing","state":"start","ai":true}');
    expect(wire.sealed.at(-1)).toBe('{"tcm":"x.typing","state":"stop","ai":true}');
    expect(wire.sealed.every(b => b === '{"tcm":"x.typing","state":"start","ai":true}' || b === '{"tcm":"x.typing","state":"stop","ai":true}')).toBe(true);
    // THE FRAME: relay-only `typing` toward the owner — never a durable
    // `send` (no msgId, no receipt, no queue row).
    for (const f of wire.frames) {
      expect(f).toEqual({ type: 'typing', to: OWNER, msgType: 'ciphertext', payload: 'SEALED64' });
    }
    // ONE socket, 'send' role (never the routing row), closed at turn end.
    expect(wire.connects).toEqual(['send']);
    expect(wire.closed).toBeGreaterThanOrEqual(1);
  }, 30_000);

  it('a socket that dies mid-turn costs ZERO further advances — the liveness gate refuses before the ratchet (send.ts owns the rule)', async () => {
    seams.wire = { connects: [], frames: [], sealed: [], closed: 0, open: true };
    new MessageLog('bot').append(inRow('start the work'));
    const fake = heldDriver({ reply: 'the answer' });
    seams.driver = fake.driver;
    const h = fakeSend();
    const io = { ...clockIo(), sendReply: h.sendReply };

    const run = attendOnce('bot', io);
    const wire = seams.wire as NonNullable<typeof seams.wire>;
    await poll(() => wire.sealed.length >= 1);
    // The socket dies under the turn. From here on, `ws.send` would drop
    // frames silently — so every further advance would be a skipped key the
    // owner's ratchet absorbs for a frame nobody can receive. The gate must
    // refuse BEFORE encryptText, permanently for the turn.
    wire.open = false;
    const advancesAtDeath = wire.sealed.length;
    await new Promise(r => setTimeout(r, 60)); // many fake refresh windows
    expect(wire.sealed.length, 'a dead transport costs zero advances').toBe(advancesAtDeath);

    fake.finish();
    expect(await run).toBe('answered');
    // The stop is refused too — the channel died with the socket — and the
    // turn never noticed any of it.
    expect(wire.sealed.length).toBe(advancesAtDeath);
    expect(wire.frames.length).toBe(advancesAtDeath);
    expect(wire.closed).toBeGreaterThanOrEqual(1);
    expect(h.bodies).toEqual(['the answer']);
  }, 30_000);

  it('a dial that FAILS costs zero advances and is not re-hammered: one attempt, then dead for the turn', async () => {
    seams.wire = { connects: [], frames: [], sealed: [], closed: 0, open: false, connectFail: true };
    new MessageLog('bot').append(inRow('start the work'));
    const fake = heldDriver({ reply: 'the answer' });
    seams.driver = fake.driver;
    const h = fakeSend();
    const io = { ...clockIo(), sendReply: h.sendReply };

    const run = attendOnce('bot', io);
    const wire = seams.wire as NonNullable<typeof seams.wire>;
    await poll(() => wire.connects.length === 1);
    await new Promise(r => setTimeout(r, 60)); // many fake refresh windows
    fake.finish();
    expect(await run).toBe('answered');
    expect(wire.connects, 'one refusal ends the chatter — no redial storm').toEqual(['send']);
    expect(wire.sealed, 'a refused socket costs zero ratchet advances').toEqual([]);
    expect(wire.frames).toEqual([]);
    expect(h.bodies).toEqual(['the answer']);
  }, 30_000);

  it('with no ratchet session the channel stays entirely off the wire — typing never bootstraps X3DH', async () => {
    // seams.wire stays null: the mocked hasSession answers false, which is
    // also every OTHER test fixture's real state — the gate this test pins
    // is what keeps a fakeless test off the network.
    new MessageLog('bot').append(inRow('start the work'));
    const fake = heldDriver({ reply: 'the answer' });
    seams.driver = fake.driver;
    const h = fakeSend();
    const io = { ...clockIo(), sendReply: h.sendReply };

    const run = attendOnce('bot', io);
    await poll(() => fake.calls() === 1);
    await new Promise(r => setTimeout(r, 60));
    fake.finish();
    expect(await run).toBe('answered');
    expect(h.bodies).toEqual(['the answer']);
    // Nothing dialled, nothing sealed: the wire recorder was never touched
    // (it is null — the mocked transport throws if constructed-and-used,
    // and no rejection surfaced anywhere).
  }, 30_000);
});
