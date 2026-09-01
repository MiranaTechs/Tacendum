import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  encodeCallEnvelope,
  encodeGroupCallEnvelope,
  type CallEndReason,
  type CallEnvelope,
  type GroupCallInviteEnvelope,
} from '@tacendum/shared';
import { CallRunner, fixtureSdp, type CallLogRow } from '../src/call.js';
import { GroupCallRunner } from '../src/group-call.js';

/**
 * A CLI CALL LEG MUST LEAVE `ending`.
 *
 * `ending` is a TEARDOWN state, not a terminal one: the only exit the shared
 * machine has is `teardownComplete` (call-machine.ts), and nothing in this
 * executor dispatched it — the app's executor has carried the collapse since
 * its own one-call-per-launch round (app/src/call/service.ts, whose comment
 * describes THIS defect verbatim), and the CLI executor never did. So a
 * runner that took one call stayed in `ending` for the life of the object:
 * every later `placeCall` reduced to `reportBusy` with ZERO frames sent,
 * every later foreign offer was answered `call.end{r:'busy'}`, `ensureLeg`
 * handed the session the same stuck runner, and `oneToOneBusy()` reported a
 * torn-down call as busy forever.
 *
 * Three shipped surfaces, three tests, plus the one the re-offer repair depends on:
 * `revivable()` requires `phase === 'failed'`, produced only by
 * `legStateChanged{'ending'}` — so EVERY revivable leg necessarily had a
 * runner already stuck in `ending`, and the re-offer repair could never put
 * a ginvite on the wire under any input.
 *
 * Written RED against the pre-collapse runner.
 */

const ULIDS = {
  self: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  bob: '01ARZ3NDEKTSV4RRFFQ69G5FAW',
  cidA: '01BX5ZZKBKACTAV9WEVGEMMVRZ',
  cidB: '01BX5ZZKBKACTAV9WEVGEMMVS0',
  gcid: '01BX5ZZKBKACTAV9WEVGEMMVS2',
  sid: '01BX5ZZKBKACTAV9WEVGEMMVS1',
} as const;

interface Sent {
  peerId: string;
  body: string;
  urgent: boolean;
}

function offerBody(cid: string): string {
  const envelope: CallEnvelope = {
    tcm: 'call.offer',
    cid,
    sdp: fixtureSdp('offer', cid),
    vid: false,
    exp: Date.now() + 60_000,
  };
  return encodeCallEnvelope(envelope);
}

function endBody(cid: string, reason: CallEndReason): string {
  return encodeCallEnvelope({ tcm: 'call.end', cid, r: reason });
}

function ginviteBody(sid: string, cid: string, roster: readonly string[]): string {
  const invite: GroupCallInviteEnvelope = {
    tcm: 'call.ginvite',
    sid,
    cid,
    r: [...roster],
    sdp: fixtureSdp('offer', cid),
    vid: false,
    exp: Date.now() + 60_000,
  };
  return encodeGroupCallEnvelope(invite);
}

/** Parsed `tcm`s of every body a rig transport carried, in order. */
function tcmsOf(sent: Sent[]): string[] {
  return sent.map(s => (JSON.parse(s.body) as { tcm: string }).tcm);
}

let out: string[];
let logSpy: ReturnType<typeof vi.spyOn>;
let home: string;
let runners: { dispose(): void }[];

beforeEach(() => {
  out = [];
  runners = [];
  logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    out.push(args.map(a => String(a)).join(' '));
  });
  home = mkdtempSync(join(tmpdir(), 'tacendum-endcollapse-'));
});

afterEach(() => {
  for (const runner of runners) runner.dispose();
  logSpy.mockRestore();
  rmSync(home, { recursive: true, force: true });
});

let msgIdSeq = 0;
const nextMsgId = (): string => {
  msgIdSeq += 1;
  return `01M5G${String(msgIdSeq).padStart(21, '0')}`;
};

function makeCallRunner(): { runner: CallRunner; sent: Sent[] } {
  const sent: Sent[] = [];
  const runner = new CallRunner(
    {
      send: async (peerId, body, urgent) => {
        sent.push({ peerId, body, urgent });
        return nextMsgId();
      },
      writeLog: () => undefined,
      now: () => Date.now(),
    },
    'tester',
  );
  runners.push(runner);
  return { runner, sent };
}

function makeGroupRunner(options: { autoAnswer?: boolean } = {}): {
  group: GroupCallRunner;
  fallback: CallRunner;
  sent: Sent[];
} {
  const sent: Sent[] = [];
  const io = {
    send: async (peerId: string, body: string, urgent: boolean) => {
      sent.push({ peerId, body, urgent });
      return nextMsgId();
    },
    sendAcked: async (
      peerId: string,
      body: string,
      urgent: boolean,
      onMsgId?: (msgId: string) => void,
    ) => {
      sent.push({ peerId, body, urgent });
      onMsgId?.(nextMsgId());
      return 'delivered' as const;
    },
    writeLog: (_row: CallLogRow) => undefined,
    now: () => Date.now(),
  };
  const fallback = new CallRunner(
    { send: io.send, writeLog: io.writeLog, now: io.now },
    'tester',
  );
  runners.push(fallback);
  const group = new GroupCallRunner(io, ULIDS.self, 'tester', {
    statePath: join(home, 'gcall-state.json'),
    fallback,
    ...(options.autoAnswer ? { autoAnswer: true } : {}),
  });
  runners.push(group);
  return { group, fallback, sent };
}

/** Resolve once `predicate` holds, polling; reject after `ms` so a red run
 * fails by name instead of hanging vitest. */
function until(predicate: () => boolean, ms: number, what: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = (): void => {
      if (predicate()) return resolve();
      if (Date.now() - started > ms) return reject(new Error(`TIMED OUT: ${what}`));
      setTimeout(tick, 50);
    };
    tick();
  });
}

describe('the runner returns to idle after teardown', () => {
  it('a second INBOUND call rings instead of being refused busy', async () => {
    const { runner, sent } = makeCallRunner();

    // Call #1, end to end: ring, answer, connect, peer hangs up.
    await runner.onBody(ULIDS.bob, offerBody(ULIDS.cidA), Date.now());
    expect(runner.stateName).toBe('incoming_ringing');
    await runner.accept();
    await runner.iceConnected();
    expect(runner.stateName).toBe('connected');
    await runner.onBody(ULIDS.bob, endBody(ULIDS.cidA, 'hangup'), Date.now());

    // THE COLLAPSE: teardown ran to completion inside that step, so the
    // machine must be back at idle — not camped in `ending` forever.
    expect(runner.stateName, 'the runner never left `ending` after teardown').toBe('idle');

    // Call #2 from the same peer, a fresh cid. Pre-fix the machine answered
    // it `call.end{r:'busy'}` — `listen --calls` refusing every caller after
    // the first.
    const before = sent.length;
    await runner.onBody(ULIDS.bob, offerBody(ULIDS.cidB), Date.now());
    expect(runner.stateName, 'a second caller was refused by a torn-down call').toBe(
      'incoming_ringing',
    );
    const later = tcmsOf(sent.slice(before));
    expect(later, 'the dead call answered the new offer busy').not.toContain('call.end');
    expect(out.filter(l => l.startsWith('CALL ringing ')).length).toBe(2);
  });

  it('a second OUTBOUND call sends frames instead of reporting busy', async () => {
    const { runner, sent } = makeCallRunner();

    // Call #1: dial, then hang up before anyone answers.
    await runner.placeCall(ULIDS.bob, false, ULIDS.cidA);
    await runner.hangup();
    expect(runner.stateName, 'the runner never left `ending` after its own hangup').toBe('idle');

    // Call #2 must actually reach the wire.
    const before = sent.length;
    await runner.placeCall(ULIDS.bob, false, ULIDS.cidB);
    const later = tcmsOf(sent.slice(before));
    expect(later, 'placeCall #2 put no frames on the wire').toContain('call.offer');
    expect(out.some(l => l.startsWith('CALL busy')), 'placeCall #2 reduced to reportBusy').toBe(
      false,
    );
    expect(runner.stateName).toBe('outgoing_connecting');
  });

  it('a revivable leg’s re-offer ginvite actually reaches the wire', async () => {
    const { group, sent } = makeGroupRunner();

    // Start a two-party session; the dial goes out as a ginvite.
    await group.start([ULIDS.self, ULIDS.bob], false);
    await until(() => tcmsOf(sent).includes('call.ginvite'), 2_000, 'first ginvite');
    const firstGinvites = tcmsOf(sent).filter(t => t === 'call.ginvite').length;
    expect(firstGinvites).toBe(1);

    // bob refuses busy — the late-join race's shape, and a REOFFERABLE
    // reason: the leg goes `failed`, the session arms the 2 s re-offer.
    const legCid = (JSON.parse(sent[0]?.body ?? '{}') as { cid?: string }).cid ?? '';
    await group.onBody(ULIDS.bob, endBody(legCid, 'busy'), Date.now());
    expect(out.some(l => l.startsWith('GCALL reoffer_armed ')), 'no re-offer was armed').toBe(true);

    // The repair fires ~2 s out. Pre-fix: `leg_dial kind=reoffer` printed,
    // then `CALL busy` — the stuck runner refused its own session's dial and
    // RE-OFFER GINVITES ON THE WIRE stayed 0 forever.
    await until(
      () => out.some(l => l.startsWith('GCALL leg_dial ') && l.includes('kind=reoffer')),
      4_000,
      'the re-offer dial',
    );
    await until(
      () => tcmsOf(sent).filter(t => t === 'call.ginvite').length >= 2,
      2_000,
      'the re-offer ginvite reaching the wire',
    );
    expect(
      out.some(l => l.startsWith('CALL busy')),
      'the stuck runner refused its own session’s re-offer dial',
    ).toBe(false);
  }, 15_000);

  it('oneToOneBusy: a ginvite after a completed 1:1 call rings instead of busy', async () => {
    const { group, fallback, sent } = makeGroupRunner({ autoAnswer: false });

    // The fallback runner takes one complete 1:1 call.
    await fallback.onBody(ULIDS.bob, offerBody(ULIDS.cidA), Date.now());
    await fallback.accept();
    await fallback.iceConnected();
    await fallback.onBody(ULIDS.bob, endBody(ULIDS.cidA, 'hangup'), Date.now());
    expect(fallback.stateName, 'the 1:1 runner never left `ending`').toBe('idle');

    // A session invite arrives. Pre-fix `oneToOneBusy()` saw `ending !==
    // idle` and refused it `busy` — a `--group` listener that took one 1:1
    // call refused every later ginvite.
    const before = sent.length;
    await group.onBody(ULIDS.bob, ginviteBody(ULIDS.sid, ULIDS.gcid, [ULIDS.bob, ULIDS.self]), Date.now());
    expect(
      tcmsOf(sent.slice(before)),
      'a torn-down 1:1 call refused the session invite busy',
    ).not.toContain('call.end');
    expect(out.some(l => l.startsWith('GCALL ringing ')), 'the session never rang').toBe(true);
  });
});
