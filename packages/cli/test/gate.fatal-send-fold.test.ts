import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeCallEnvelope, type CallEnvelope } from '@tacendum/shared';
import { CliError, EXIT } from '../src/exit.js';
import { CallRunner, fixtureSdp, type CallLogRow } from '../src/call.js';

/**
 * A FATAL SEND FAILURE MUST NOT STRAND THE 1:1 RUNNER.
 *
 * An earlier revision's `FATAL_TO_SEND` mirrored the app's MEMBERSHIP but not its
 * AFTERMATH. The app answers a fatal send with
 * `await this.dispatch({type:'localHangup'})` and returns
 * (`app/src/call/service.ts`) — teardown, log row, back to idle. The CLI
 * RETHREW and abandoned every effect after the failing send: `acceptIncoming`
 * emits `[createAnswer, send(call.answer), cancelTimer ring, startTimer
 * connect]`, so the connect timer was never armed and the surviving ring
 * timer is INERT outside the ringing states (`ringTimeout`, call-machine.ts).
 * The machine never reached `ending`, an earlier revision's collapse (gated on the
 * reducer PRODUCING `ending`) could not fire, and the runner sat in
 * `incoming_answering` forever: every later caller was answered
 * `call.end r=busy`, a repeat `accept()` was a no-op, and ZERO log rows were
 * written — the call silently lost. Permanent against a CLI peer: `tacendum
 * call` never announces `call.end` on exit (`dispose()` only clears timers).
 *
 * The triggers are the socket-intact ones an earlier revision's own gate names: the
 * cross-process ratchet lock held past LOCK_WAIT_MS, or store I/O inside
 * `encryptText` — the send fails ONCE and the transport is healthy again.
 *
 * The group executor has folded this exact shape since an earlier revision
 * (`group-call.ts` apply catch → `receiveEnd(cid,'failed_ice')`, "the CLI
 * mirror of the app CallService's fatal-send localHangup"). The 1:1 arm had
 * neither the fold nor a test. Written RED against the earlier tree.
 */

const ULIDS = {
  bob: '01ARZ3NDEKTSV4RRFFQ69G5FAW',
  carol: '01ARZ3NDEKTSV4RRFFQ69G5FAX',
  cid: '01BX5ZZKBKACTAV9WEVGEMMVRZ',
  cid2: '01BX5ZZKBKACTAV9WEVGEMMVS2',
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

let msgIdSeq = 0;
const nextMsgId = (): string => {
  msgIdSeq += 1;
  return `01M5G${String(msgIdSeq).padStart(21, '0')}`;
};

/**
 * The reviewer's rig: a real CallRunner over a transport that fails each tcm
 * in `failOnce` exactly once — then healthy. `failWith` swaps the foreign
 * Error for a CliError so the classified-passthrough contract is provable.
 */
function makeRunner(
  failOnce: Set<string>,
  failWith?: () => Error,
): { runner: CallRunner; sent: Sent[]; rows: CallLogRow[] } {
  const sent: Sent[] = [];
  const rows: CallLogRow[] = [];
  const failed = new Set<string>();
  const runner = new CallRunner(
    {
      send: async (peerId, body, urgent) => {
        const tcm = (JSON.parse(body) as { tcm: string }).tcm;
        if (failOnce.has(tcm) && !failed.has(tcm)) {
          failed.add(tcm);
          throw failWith
            ? failWith()
            : new Error('ratchet lock is held by another tacendum process');
        }
        sent.push({ peerId, body, urgent });
        return nextMsgId();
      },
      writeLog: row => {
        rows.push(row);
      },
      now: () => Date.now(),
    },
    'tester',
  );
  return { runner, sent, rows };
}

function endsOf(sent: Sent[]): Array<{ cid: string; r: string }> {
  return sent
    .map(s => JSON.parse(s.body) as { tcm: string; cid: string; r: string })
    .filter(e => e.tcm === 'call.end');
}

let logSpy: ReturnType<typeof vi.spyOn>;
let disposers: Array<{ dispose(): void }>;

beforeEach(() => {
  disposers = [];
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  for (const d of disposers) d.dispose();
  logSpy.mockRestore();
});

describe('the gate repro: transport fails call.answer once, then healthy', () => {
  it('accept still fails its caller, but the runner folds to idle with its log row written', async () => {
    const { runner, sent, rows } = makeRunner(new Set(['call.answer']));
    disposers.push(runner);
    await runner.onBody(ULIDS.bob, offerBody(ULIDS.cid), Date.now());
    expect(runner.stateName).toBe('incoming_ringing');

    // The caller (the frame queue in call-session.ts) still hears about it —
    // with OUR prose, never the foreign error's.
    await expect(runner.accept()).rejects.toThrow(/call signaling send failed \(call\.answer\)/);

    // Pre-fix: 'incoming_answering' forever — connect timer never armed, ring
    // timer inert outside the ringing states, collapse unreachable.
    expect(runner.stateName, 'the runner was stranded in incoming_answering').toBe('idle');

    // The app's aftermath, not only its membership: the log row is written…
    expect(rows, 'the call was silently lost — zero log rows').toHaveLength(1);
    // …with the CALLEE's reason. `localHangup` before `connectedAt` is read by
    // direction (call-machine.ts): the CALLER hanging up is `cancelled`, the
    // CALLEE hanging up is `decline`. This test predates that split and pinned
    // `cancelled` on an INCOMING leg, which is the caller's word — and, worse,
    // `cancelled` is in MISSED_REASONS, so the fold wrote the person a MISSED
    // row for the call they were in the middle of answering. `decline` is not
    // missed, which is why `missed: false` is pinned here and not implied.
    //
    // "Declined" is still not what HAPPENED — the send died on a held ratchet
    // lock, nobody refused anything — but the fold is `localHangup` in both
    // arms, so the CLI says exactly what the app's CallService says for the
    // identical failure, and app/CLI parity is the property this file exists
    // to hold. Giving the fatal-send fold a reason of its own (the group arm's
    // `failed_ice`, say) is a source change to shipped call semantics on both
    // sides and is a deliberate product decision; it is not a test repair.
    expect(rows[0]).toMatchObject({
      cid: ULIDS.cid,
      direction: 'in',
      reason: 'decline',
      missed: false,
    });

    // …and the end is ANNOUNCED (the transport is healthy again), so the
    // caller is not left ringing until their own timeout.
    expect(endsOf(sent)).toContainEqual(expect.objectContaining({ cid: ULIDS.cid, r: 'decline' }));
  });

  it('the daemon is not busy-forever: a later caller RINGS instead of being refused', async () => {
    const { runner, sent } = makeRunner(new Set(['call.answer']));
    disposers.push(runner);
    await runner.onBody(ULIDS.bob, offerBody(ULIDS.cid), Date.now());
    await runner.accept().catch(() => undefined);

    // A repeat accept is a no-op, not a resurrection.
    await runner.accept();
    expect(runner.stateName).toBe('idle');

    // Pre-fix: `call.end r=busy` for every later caller, forever.
    await runner.onBody(ULIDS.carol, offerBody(ULIDS.cid2), Date.now());
    expect(runner.stateName, 'a later caller was answered busy by a dead call').toBe(
      'incoming_ringing',
    );
    expect(endsOf(sent).filter(e => e.r === 'busy')).toEqual([]);
  });
});

describe('the twin entry points of the fatal set', () => {
  it('placeCall: a fatal offer send folds the dial too — rejected caller, idle runner, honest row', async () => {
    const { runner, rows } = makeRunner(new Set(['call.offer']));
    disposers.push(runner);
    await expect(runner.placeCall(ULIDS.bob, false)).rejects.toThrow(
      /call signaling send failed \(call\.offer\)/,
    );
    expect(runner.stateName).toBe('idle');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ direction: 'out', reason: 'cancelled', missed: false });

    // And the runner is reusable: the next dial reaches the wire.
    const cid = await runner.placeCall(ULIDS.bob, false);
    expect(cid).toBeTruthy();
    expect(runner.stateName).toBe('outgoing_connecting');
  });

  it('a CliError passes through classified — the liveness gate’s exit code survives the fold', async () => {
    const { runner } = makeRunner(
      new Set(['call.offer']),
      () =>
        new CliError(
          EXIT.NETWORK,
          'call socket is not open — refusing to touch the ratchet for a frame that cannot be sent',
        ),
    );
    disposers.push(runner);
    let caught: unknown;
    await runner.placeCall(ULIDS.bob, false).catch(err => {
      caught = err;
    });
    expect(caught).toBeInstanceOf(CliError);
    expect((caught as CliError).exitCode).toBe(EXIT.NETWORK);
    expect((caught as CliError).message).toMatch(/call socket is not open/);
    // The fold still happened underneath the classified failure.
    expect(runner.stateName).toBe('idle');
  });

  it('a session-owned leg does NOT self-fold: its fold belongs to the session executor', async () => {
    // The group executor folds an escaped fatal throw with ITS reason
    // taxonomy (`receiveEnd(cid,'failed_ice')` → re-offer / release —
    // group-call.ts apply catch). A leg that hung up on itself first would
    // report its own `localHangup` reason into the session reducer —
    // `decline` on an incoming leg, `cancelled` on an outgoing one — and the
    // repair gate would never see the failure class it keys on.
    const { runner, rows } = makeRunner(new Set(['call.answer']));
    disposers.push(runner);
    runner.onState = () => {};
    await runner.onBody(ULIDS.bob, offerBody(ULIDS.cid), Date.now());
    await expect(runner.accept()).rejects.toThrow(/call signaling send failed/);
    expect(runner.stateName, 'the leg folded itself out from under its session').toBe(
      'incoming_answering',
    );
    expect(rows).toEqual([]);
    // …and the session's fold still lands it exactly where an earlier revision put it.
    await runner.receiveEnd(ULIDS.cid, 'failed_ice');
    expect(runner.stateName).toBe('idle');
    expect(rows.map(r => r.reason)).toEqual(['failed_ice']);
  });
});
