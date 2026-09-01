import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AttendConfig } from '../src/attend.js';
import type {
  DriverIo,
  SessionFactory,
  SessionHandle,
  SteerableTurn,
} from '../src/attend-drivers.js';

/**
 * MID-TURN STEERING, CLIENT SIDE — the REAL client
 * and the REAL codex driver against a scripted app-server speaking the
 * MEASURED 0.144.0 steer dialect (live probe, capture kept): `turn/start`'s result carries the live turn id
 * (`result.turn.id`), `turn/started` repeats it, a matching `turn/steer`
 * answers `{turnId}` with the steered text riding in as a userMessage item,
 * and a mismatched `expectedTurnId` answers error -32600 whose MESSAGE
 * EMBEDS BOTH RAW TURN IDS — the quarantine case — with NOTHING delivered.
 *
 * What is pinned here: the frame the client sends (the probe's exact input
 * shape — no `text_elements` member on a steer, unlike `turn/start`), the
 * three-way result mapping (delivered | not-delivered | failed), the two
 * client-side refusals (an outstanding approval ask; a completed turn), the
 * reply being the LAST completed agentMessage (the steered answer — the
 * interrupted partial is dropped), and the seam shape: the spawn-seam
 * drivers never surface a steer at all.
 */

const home = mkdtempSync(join(tmpdir(), 'tacendum-steer-client-'));
process.env.TACENDUM_HOME = home;
process.env.TACENDUM_API = 'http://steer-client.test';
process.env.TACENDUM_WS = 'ws://steer-client.test';

const { driverFor } = await import('../src/attend-drivers.js');

type Frame = Record<string, unknown>;

const THREAD_ID = '019ffbc9-e0fc-76c2-993a-fe59e971cd74';
const TURN_ID = '019ffbc9-e119-7052-9be1-f05ef95a78f0';
/** The probe's wrong-id error, verbatim shape: both raw ids in the text. */
const MISMATCH_MSG = `expected active turn id \`019ff79b-ffff-7fff-bfff-ffffffffffff\` but found \`${TURN_ID}\``;

const OWN_SESSION = 'ffffffff-9999-4999-8999-999999999999';
const appCfg = (over: Partial<AttendConfig> = {}): AttendConfig => ({
  host: 'codex', bin: '/opt/codex', workdir: '/w', caps: ['-s', 'read-only'],
  codexDriver: 'app-server', ownSession: OWN_SESSION, turnsPerHour: 10, ...over,
});

async function poll(cond: () => boolean, ms = 10_000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error('poll timed out');
    await new Promise(r => setTimeout(r, 5));
  }
}

/**
 * A scripted app-server whose turn PARKS until it is steered (or told to
 * finish): handshake, thread, turn/start answered with the measured
 * `{turn: {id, status: 'inProgress'}}` result plus the `turn/started`
 * notification, then the frames each test's script calls for. Everything
 * the client writes is recorded raw, so tests assert the WIRE.
 */
const steerServer = (opts: {
  /** How turn/steer is answered: the measured success, the measured
   * mismatch error, or SILENCE followed by child death (the maybe-
   * delivered shape). */
  steerAnswer: 'ok' | 'mismatch' | 'silent-exit';
  /** Omit the id from turn/start's RESULT so `turn/started` is the only
   * source — both are measured carriers and either must suffice. */
  turnIdOnNotificationOnly?: boolean;
  /** Serve one commandExecution approval right after the turn starts (the
   * park a steer must refuse to ride over). */
  approvalFirst?: boolean;
  /** The pre-steer partial text and the steered answer. */
  partial?: string;
  steered?: string;
}) => {
  const wrote: Frame[] = [];
  const spawned: { argv: string[]; env: Readonly<Record<string, string>> | undefined }[] = [];
  let lineCb: ((line: string) => void) | undefined;
  let exitCb: ((code: number | null) => void) | undefined;
  const emit = (obj: Frame): void => queueMicrotask(() => lineCb?.(JSON.stringify(obj)));

  const completeSteered = (): void => {
    // The measured post-steer sequence: the interrupted agentMessage
    // COMPLETES with its partial text, the steered text rides in as a
    // userMessage, and the steered answer is the LAST completed
    // agentMessage — then the turn completes.
    emit({
      method: 'item/completed',
      params: {
        item: { type: 'agentMessage', id: 'msg_1', text: opts.partial ?? '1\n2', phase: 'final_answer', memoryCitation: null },
        threadId: THREAD_ID, turnId: TURN_ID, completedAtMs: 2,
      },
    });
    emit({
      method: 'item/completed',
      params: {
        item: { type: 'agentMessage', id: 'msg_2', text: opts.steered ?? 'steered-p43', phase: 'final_answer', memoryCitation: null },
        threadId: THREAD_ID, turnId: TURN_ID, completedAtMs: 3,
      },
    });
    finishTurn('completed');
  };
  const finishTurn = (status: 'completed' | 'failed'): void => {
    emit({
      method: 'turn/completed',
      params: {
        threadId: THREAD_ID,
        turn: { id: TURN_ID, items: [], itemsView: 'notLoaded', status, error: null, startedAt: 1, completedAt: 2, durationMs: 1000 },
      },
    });
  };

  const handle = (f: Frame): void => {
    const { id, method } = f;
    if (typeof method === 'string' && id !== undefined) {
      if (method === 'initialize') {
        emit({ id, result: { userAgent: 'codex/0.144.0', codexHome: '/isolated', platformFamily: 'unix', platformOs: 'macos' } });
      } else if (method === 'thread/start') {
        emit({ id, result: { thread: { id: THREAD_ID } } });
      } else if (method === 'turn/start') {
        // The measured result — the whole point is that it was being
        // discarded. One variant withholds it to prove the notification
        // fallback.
        emit({
          id,
          result: opts.turnIdOnNotificationOnly === true
            ? {}
            : { turn: { id: TURN_ID, items: [], itemsView: 'notLoaded', status: 'inProgress' } },
        });
        emit({ method: 'turn/started', params: { threadId: THREAD_ID, turn: { id: TURN_ID, status: 'inProgress' } } });
        if (opts.approvalFirst === true) {
          emit({
            method: 'item/commandExecution/requestApproval',
            id: 0,
            params: { threadId: THREAD_ID, turnId: TURN_ID, itemId: 'exec-1', command: 'touch x', cwd: '/w' },
          });
        }
      } else if (method === 'turn/steer') {
        if (opts.steerAnswer === 'ok') {
          emit({ id, result: { turnId: TURN_ID } });
          completeSteered();
        } else if (opts.steerAnswer === 'mismatch') {
          // The quarantine case: RAW TURN IDS in the error message. Then
          // the turn completes UNHARMED with the full un-steered answer.
          emit({ id, error: { code: -32600, message: MISMATCH_MSG } });
          emit({
            method: 'item/completed',
            params: {
              item: { type: 'agentMessage', id: 'msg_1', text: 'the full un-steered answer', phase: 'final_answer', memoryCitation: null },
              threadId: THREAD_ID, turnId: TURN_ID, completedAtMs: 2,
            },
          });
          finishTurn('completed');
        } else {
          // No answer at all: the child dies with the request in flight.
          queueMicrotask(() => exitCb?.(1));
        }
      }
      return;
    }
    if (id !== undefined) {
      // The client answering our approval request (its own id space).
      completeSteered();
    }
  };

  const session: SessionHandle = {
    write(line) {
      wrote.push(JSON.parse(line) as Frame);
      queueMicrotask(() => handle(JSON.parse(line) as Frame));
    },
    onLine(cb) { lineCb = cb; },
    onExit(cb) { exitCb = cb; },
    kill() { queueMicrotask(() => exitCb?.(0)); },
  };
  const factory: SessionFactory = (argv, _cwd, env) => {
    spawned.push({ argv, env });
    return session;
  };
  const io: DriverIo = {
    spawn: async () => { throw new Error('the app-server driver must never use the spawn seam'); },
    session: factory,
  };
  return { io, wrote, spawned };
};

describe('the steer call off the measured frames', () => {
  it('surfaces once the turn is live, sends the probe-exact frame, and {turnId} resolves delivered; the reply is the steered answer', async () => {
    const s = steerServer({ steerAnswer: 'ok', partial: '1\n2', steered: 'steered-p43' });
    let surfaced: SteerableTurn | undefined;
    const run = driverFor('codex').runTurn(
      {
        cfg: appCfg(), route: { kind: 'own' }, prompt: 'Count from 1 to 40', account: 'bot',
        steering: t => { surfaced = t; },
      },
      s.io,
    );
    await poll(() => surfaced !== undefined);
    // The surface carries the thread id the turn runs as — the same
    // frame-borne value TurnResult.sessionKey carries at turn end.
    expect(surfaced?.sessionKey).toBe(THREAD_ID);

    const got = await (surfaced as SteerableTurn).steer('Stop counting. Reply steered-p43');
    expect(got).toBe('delivered');

    // THE WIRE, probe-exact: threadId, the LIVE turn id captured off
    // turn/start's result as expectedTurnId, and the capture's input shape —
    // one text item, NO text_elements member (turn/start carries one; the
    // measured steer input does not).
    const steer = s.wrote.find(f => f.method === 'turn/steer');
    expect(steer).toBeDefined();
    expect(steer!.params).toEqual({
      threadId: THREAD_ID,
      expectedTurnId: TURN_ID,
      input: [{ type: 'text', text: 'Stop counting. Reply steered-p43' }],
    });

    // The reply semantics the plan states: the LAST completed agentMessage
    // is the steered answer; the interrupted partial is dropped.
    const res = await run;
    expect(res.code).toBe(0);
    expect(res.stdout).toBe('steered-p43');
    expect(res.stdout).not.toContain('1\n2');
    expect(res.sessionKey).toBe(THREAD_ID);
  });

  it('captures the live turn id from turn/started when the result withholds it — both measured carriers suffice', async () => {
    const s = steerServer({ steerAnswer: 'ok', turnIdOnNotificationOnly: true });
    let surfaced: SteerableTurn | undefined;
    const run = driverFor('codex').runTurn(
      { cfg: appCfg(), route: { kind: 'own' }, prompt: 'p', account: 'bot', steering: t => { surfaced = t; } },
      s.io,
    );
    await poll(() => surfaced !== undefined);
    expect(await (surfaced as SteerableTurn).steer('go left')).toBe('delivered');
    const steer = s.wrote.find(f => f.method === 'turn/steer');
    expect((steer!.params as Frame).expectedTurnId).toBe(TURN_ID);
    await run;
  });

  it('an error frame resolves not-delivered — measured -32600, and BY RULING every error — and the raw ids in its message reach nothing', async () => {
    const s = steerServer({ steerAnswer: 'mismatch' });
    let surfaced: SteerableTurn | undefined;
    const run = driverFor('codex').runTurn(
      { cfg: appCfg(), route: { kind: 'own' }, prompt: 'p', account: 'bot', steering: t => { surfaced = t; } },
      s.io,
    );
    await poll(() => surfaced !== undefined);
    const got = await (surfaced as SteerableTurn).steer('too late');
    expect(got, 'an answered error is provably undelivered — never a throw').toBe('not-delivered');

    // The turn completes UNHARMED (the probe's measured shape), and the
    // WireFailure quarantine holds: the error message embeds both raw turn
    // ids, and neither appears anywhere the supervisor can see.
    const res = await run;
    expect(res.code).toBe(0);
    expect(res.stdout).toBe('the full un-steered answer');
    expect(res.stdout).not.toContain('019ff79b-ffff-7fff-bfff-ffffffffffff');
    expect(JSON.stringify(res)).not.toContain('019ff79b-ffff-7fff-bfff-ffffffffffff');
  });

  it('a child death with the steer in flight resolves failed — maybe-delivered, the arm the journal answers for', async () => {
    const s = steerServer({ steerAnswer: 'silent-exit' });
    let surfaced: SteerableTurn | undefined;
    const run = driverFor('codex').runTurn(
      { cfg: appCfg(), route: { kind: 'own' }, prompt: 'p', account: 'bot', steering: t => { surfaced = t; } },
      s.io,
    );
    await poll(() => surfaced !== undefined);
    const got = await (surfaced as SteerableTurn).steer('are you there');
    expect(got, 'no answer is not "not delivered" — it is unconfirmed').toBe('failed');
    const res = await run;
    expect(res.code, 'a dead child under a live turn is a failed turn').not.toBe(0);
  });

  it('a steer while an approval ask is outstanding is refused UNSENT — steer-during-park is unmeasured and forbidden at both layers', async () => {
    const s = steerServer({ steerAnswer: 'ok', approvalFirst: true });
    let surfaced: SteerableTurn | undefined;
    let duringAsk: string | undefined;
    const run = driverFor('codex').runTurn(
      {
        cfg: appCfg(), route: { kind: 'own' }, prompt: 'p', account: 'bot',
        steering: t => { surfaced = t; },
        ask: async () => {
          await poll(() => surfaced !== undefined);
          duringAsk = await (surfaced as SteerableTurn).steer('while parked');
          return 'deny';
        },
      },
      s.io,
    );
    const res = await run;
    expect(duringAsk).toBe('not-delivered');
    expect(
      s.wrote.some(f => f.method === 'turn/steer'),
      'refused means NOTHING left the process — provably undelivered',
    ).toBe(false);
    expect(res.code).toBe(0);
  });

  it('a steer after turn/completed is refused unsent — the turn-over end condition, client side', async () => {
    const s = steerServer({ steerAnswer: 'ok' });
    let surfaced: SteerableTurn | undefined;
    const run = driverFor('codex').runTurn(
      { cfg: appCfg(), route: { kind: 'own' }, prompt: 'p', account: 'bot', steering: t => { surfaced = t; } },
      s.io,
    );
    await poll(() => surfaced !== undefined);
    expect(await (surfaced as SteerableTurn).steer('first')).toBe('delivered');
    const res = await run;
    expect(res.code).toBe(0);
    const frames = s.wrote.filter(f => f.method === 'turn/steer').length;
    expect(await (surfaced as SteerableTurn).steer('after the turn')).toBe('not-delivered');
    expect(s.wrote.filter(f => f.method === 'turn/steer').length, 'nothing new on the wire').toBe(
      frames,
    );
  });
});

describe('the seam shape: spawn-seam drivers never surface a steer', () => {
  const spawnSeam = () => {
    const io: DriverIo = {
      spawn: async () => ({ stdout: 'done', stderr: '', code: 0 }),
    };
    return io;
  };

  it('the claude driver never invokes a steering callback — claude -p closes stdin at spawn (measured)', async () => {
    let called = 0;
    const res = await driverFor('claude').runTurn(
      {
        cfg: { host: 'claude', bin: '/opt/agent', workdir: '/w', caps: ['--permission-mode', 'plan'], ownSession: OWN_SESSION, turnsPerHour: 10 },
        route: { kind: 'own' }, prompt: 'p', account: 'bot',
        steering: () => { called += 1; },
      },
      spawnSeam(),
    );
    expect(called, 'no steer capability may surface from a spawn-seam driver').toBe(0);
    expect(res.code).toBe(0);
  });

  it('the codex EXEC driver never invokes one either — same spawn shape, same absence of a channel', async () => {
    let called = 0;
    const res = await driverFor('codex').runTurn(
      {
        cfg: appCfg({ codexDriver: 'exec' }), route: { kind: 'own' }, prompt: 'p', account: 'bot',
        steering: () => { called += 1; },
      },
      spawnSeam(),
    );
    expect(called).toBe(0);
    expect(res.code).toBe(0);
  });
});
