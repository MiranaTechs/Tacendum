import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  encodeCallEnvelope,
  encodeGroupCallEnvelope,
  type CallEnvelope,
  type GroupCallInviteEnvelope,
} from '@tacendum/shared';
import { CallRunner, fixtureSdp, type CallLogRow } from '../src/call.js';
import { GroupCallRunner } from '../src/group-call.js';

/**
 * A NON-FATAL SEND FAILURE DEGRADES; IT DOES NOT END THE CALL.
 *
 * The app's executor limits send fatality to the three frames the peer cannot
 * live without — `FATAL_TO_SEND = {call.offer, call.answer, call.restart}`
 * (app/src/call/service.ts) — and DEGRADES everything else: a lost
 * `call.ringing` costs the caller their ringback line, and the phone keeps
 * ringing its full 60 s. The CLI had no such set: `CallRunner.sendEnvelope`
 * rethrew for EVERY frame class, and `GroupCallRunner.apply`'s fold turned
 * ANY escaped throw from a leg-opening effect into `receiveEnd(cid,
 * 'failed_ice')`. So a failed COURTESY ACK — the `call.ringing` inside
 * `receiveOffer`'s effect list — ended the leg, the session's ring-collapse
 * branch released the whole session, `maybeAutoRespond` found nothing left to
 * answer, and the call log recorded `failed_ice missed=false` for a call the
 * operator never got.
 *
 * The socket-intact triggers are real: `withRatchet` takes the cross-process
 * file lock and `acquire` throws when another tacendum process holds it past
 * LOCK_WAIT_MS; a transient store I/O failure inside `encryptText` does the
 * same. Both leave the socket open — the answer would have gone out.
 *
 * Written RED against the ungated fold, with the control alongside.
 */

const ULIDS = {
  self: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  bob: '01ARZ3NDEKTSV4RRFFQ69G5FAW',
  cid: '01BX5ZZKBKACTAV9WEVGEMMVRZ',
  sid: '01BX5ZZKBKACTAV9WEVGEMMVS1',
} as const;

interface Sent {
  peerId: string;
  body: string;
  urgent: boolean;
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

function tcmsOf(sent: Sent[]): string[] {
  return sent.map(s => (JSON.parse(s.body) as { tcm: string }).tcm);
}

/** Wait out the runner's serialized input chain: `legStateChanged` is
 * fire-and-forget onto it (group-call.ts `onState`), so a state assertion
 * straight after an awaited input can race the report it is about. */
function settled(predicate: () => boolean, ms: number, what: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = (): void => {
      if (predicate()) return resolve();
      if (Date.now() - started > ms) return reject(new Error(`TIMED OUT: ${what}`));
      setTimeout(tick, 25);
    };
    tick();
  });
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
  home = mkdtempSync(join(tmpdir(), 'tacendum-nonfatal-'));
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

/**
 * The rig: a working transport with ONE fault, selectable by frame kind —
 * the shape of a lock-budget or store-I/O failure inside one encrypt, with
 * the socket open the whole time.
 */
function makeGroupRunner(failTcms: Set<string>): {
  group: GroupCallRunner;
  sent: Sent[];
  rows: CallLogRow[];
  statePath: string;
} {
  const sent: Sent[] = [];
  const rows: CallLogRow[] = [];
  const io = {
    send: async (peerId: string, body: string, urgent: boolean) => {
      const tcm = (JSON.parse(body) as { tcm: string }).tcm;
      if (failTcms.has(tcm)) throw new Error('ratchet lock is held by another tacendum process');
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
    writeLog: (row: CallLogRow) => {
      rows.push(row);
    },
    now: () => Date.now(),
  };
  const statePath = join(home, `gcall-state-${msgIdSeq}.json`);
  const group = new GroupCallRunner(io, ULIDS.self, 'tester', {
    statePath,
    autoAnswer: true,
  });
  runners.push(group);
  return { group, sent, rows, statePath };
}

describe('the fold is gated on the app’s fatal-frame set', () => {
  it('CONTROL: with a healthy transport the auto-answered session goes live', async () => {
    const { group, sent } = makeGroupRunner(new Set());
    await group.onBody(
      ULIDS.bob,
      ginviteBody(ULIDS.sid, ULIDS.cid, [ULIDS.bob, ULIDS.self]),
      Date.now(),
    );
    expect(group.live).toBe(true);
    expect(tcmsOf(sent)).toContain('call.ringing');
    expect(tcmsOf(sent)).toContain('call.answer');
  });

  it('a failed call.ringing send does NOT destroy the incoming session', async () => {
    const { group, sent, rows } = makeGroupRunner(new Set(['call.ringing']));
    await group.onBody(
      ULIDS.bob,
      ginviteBody(ULIDS.sid, ULIDS.cid, [ULIDS.bob, ULIDS.self]),
      Date.now(),
    );

    // Pre-fix: the fold ran ahead of `maybeAutoRespond`, `receiveEnd` folded
    // the ringing leg, the ring-collapse branch released the session, and
    // this client answered NOTHING while logging `failed_ice missed=false`.
    // (A short drain first: the fold's `legStateChanged` rides the serialized
    // chain, so pre-fix the release lands a beat after `onBody` resolves —
    // asserting immediately would go red for the wrong reason.)
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(group.live, 'a failed courtesy ack released the whole session').toBe(true);
    expect(
      tcmsOf(sent),
      'call.answer was never attempted — the fold beat the auto-answer to it',
    ).toContain('call.answer');
    expect(
      rows.filter(r => r.reason === 'failed_ice'),
      'a call the operator never got was logged as a connection failure',
    ).toEqual([]);
    // The degrade is LOUD, not silent: the leg names the failed send.
    expect(out.some(l => l.startsWith('CALL send_failed ') && l.includes('tcm=call.ringing'))).toBe(
      true,
    );
  });

  it('a genuinely fatal failure still folds: call.answer down ends the leg and releases', async () => {
    const { group, sent, statePath } = makeGroupRunner(new Set(['call.answer']));
    await group.onBody(
      ULIDS.bob,
      ginviteBody(ULIDS.sid, ULIDS.cid, [ULIDS.bob, ULIDS.self]),
      Date.now(),
    );
    // The answer IS the call as far as the starter is concerned: its send
    // failing must still fold the leg so the session releases rather than
    // sitting live around a leg that can never join.
    expect(tcmsOf(sent)).toContain('call.ringing');
    await settled(
      () => !group.live,
      2_000,
      'a dead answer path left the session live forever',
    );
    // The dump agrees: `persist()` wrote the terminal snapshot.
    const dump = JSON.parse(readFileSync(statePath, 'utf8')) as { live: boolean };
    expect(dump.live).toBe(false);
  });

  it('the 1:1 runner mirrors the degrade: a failed ringing send keeps the call ringing', async () => {
    const sent: Sent[] = [];
    const runner = new CallRunner(
      {
        send: async (peerId, body, urgent) => {
          const tcm = (JSON.parse(body) as { tcm: string }).tcm;
          if (tcm === 'call.ringing') throw new Error('ratchet lock is held');
          sent.push({ peerId, body, urgent });
          return nextMsgId();
        },
        writeLog: () => undefined,
        now: () => Date.now(),
      },
      'tester',
    );
    runners.push(runner);
    // Pre-fix this REJECTED out of `onBody` — the throw aborted the effect
    // list after the send, so the ring timer was never armed and the caller
    // (the frame queue) printed a processing error over a live call.
    await expect(
      runner.onBody(ULIDS.bob, offerBody(ULIDS.cid), Date.now()),
    ).resolves.toBe(true);
    expect(runner.stateName, 'a failed courtesy ack must not touch the ring').toBe(
      'incoming_ringing',
    );
    // And an accept afterwards still answers — the call survived.
    await runner.accept();
    expect(tcmsOf(sent)).toContain('call.answer');
  });
});
