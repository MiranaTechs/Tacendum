import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CallLogRow } from '../src/call.js';
import { GroupCallRunner } from '../src/group-call.js';

/**
 * ONE FAILED LEG SEND MUST NOT STRAND THE WHOLE SESSION.
 *
 * `GroupCallRunner.apply` ran `for (const effect of effects) await
 * this.run(effect)` with no per-effect guard, and the state was already
 * adopted above the loop. `CallRunner.sendEnvelope` rethrows a failed
 * signalling send, so ONE peer whose send rejects — an `apiGetPrekeyBundle`
 * 404 for a brand-new user, an `UntrustedIdentity` from `establishSession` —
 * aborted the remaining effect list: peers later in the roster got no
 * `ensureLeg`, no ring, no timer; no `legStateChanged` ever arrived for them;
 * `maybeRelease` could never see all legs terminal; `sweepPending`/`persist`
 * were skipped for the input. The gate's 50-second run ended
 * `live:true phase:joining legs=[bob:inviting, carol:inviting]` with carol
 * never dialled and the failing leg armed with no timer (`startTimer connect`
 * is emitted AFTER the send in the same effect list).
 *
 * The app's twin executor has carried the guard since its own round
 * (app/src/call/group.ts, `step`): every effect runs in its own try/catch —
 * "One failed effect must not strand a session half-torn-down with the rest
 * of its teardown unrun" — with the failure REPORTED, never swallowed. These
 * tests pin the CLI mirror against the REAL classes, in the gate's exact
 * scenario. Written RED against the unguarded loop.
 */

const ULIDS = {
  self: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  bob: '01ARZ3NDEKTSV4RRFFQ69G5FAW',
  carol: '01ARZ3NDEKTSV4RRFFQ69G5FAX',
} as const;

/** The foreign transport detail that must never reach a log line: `emit`'s
 * rule is fields are ours-values or grammar-checked ids, and the app's twin
 * logs only the effect type for the same reason (an SDP or a candidate
 * address — the other person's IP — has ridden native error text before). */
const FOREIGN_DETAIL = 'SECRET-transport-detail-77aQ prekey 404 for bob';

interface Sent {
  peerId: string;
  body: string;
  urgent: boolean;
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
  home = mkdtempSync(join(tmpdir(), 'tacendum-effect-guard-'));
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

function makeGroup(): { group: GroupCallRunner; sent: Sent[]; failPeers: Set<string> } {
  const sent: Sent[] = [];
  const failPeers = new Set<string>();
  const io = {
    send: async (peerId: string, body: string, urgent: boolean) => {
      // The gate's fault: the transport refuses THIS peer only. The others'
      // sends are healthy, which is what makes an aborted sibling visible.
      if (failPeers.has(peerId)) throw new Error(FOREIGN_DETAIL);
      sent.push({ peerId, body, urgent });
      return nextMsgId();
    },
    sendAcked: async (
      peerId: string,
      body: string,
      urgent: boolean,
      onMsgId?: (msgId: string) => void,
    ) => {
      if (failPeers.has(peerId)) throw new Error(FOREIGN_DETAIL);
      sent.push({ peerId, body, urgent });
      onMsgId?.(nextMsgId());
      return 'delivered' as const;
    },
    writeLog: (_row: CallLogRow) => undefined,
    now: () => Date.now(),
  };
  const group = new GroupCallRunner(io, ULIDS.self, 'tester', {
    statePath: join(home, 'gcall-state.json'),
  });
  runners.push(group);
  return { group, sent, failPeers };
}

/** Poll for a condition the chained `legStateChanged` dispatches produce
 * AFTER the input that queued them settles — bounded, so a stranded session
 * fails by name instead of hanging vitest. */
async function until(what: string, cond: () => boolean, ms = 3_000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) {
      throw new Error(`timed out waiting for ${what}; output was:\n${out.join('\n')}`);
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

describe('a failed leg send cannot cancel its sibling effects', () => {
  it('carol is dialled when bob’s send fails, the failure is named, and bob’s leg still reaches terminal', async () => {
    const { group, sent, failPeers } = makeGroup();
    failPeers.add(ULIDS.bob);

    await group.start([ULIDS.self, ULIDS.bob, ULIDS.carol], false);

    // THE SIBLING SURVIVES: carol's ginvite went out even though bob's
    // dial — earlier in the roster, earlier in the effect list — threw.
    expect(
      sent.some(s => s.peerId === ULIDS.carol),
      `carol was never dialled; output:\n${out.join('\n')}`,
    ).toBe(true);

    // THE FAILURE IS OBSERVABLE, on the session's own prefix, naming the
    // effect and the leg — a caught-and-swallowed error is not a fix.
    expect(
      out.some(l => l.startsWith(`GCALL effect_failed effect=openLegDial to=${ULIDS.bob}`)),
      `no line names bob's failed dial; output:\n${out.join('\n')}`,
    ).toBe(true);

    // …and it obeys the emitter rules: no foreign error text on any line.
    expect(out.join('\n')).not.toContain('SECRET-transport');

    // THE FAILING LEG STILL REACHES A TERMINAL STATE — the property that
    // lets `maybeRelease` complete. Unguarded, bob sat at `inviting` with no
    // timer armed (startTimer connect is behind the send that threw) and the
    // session could never end.
    await until('bob’s leg to fold terminal', () => {
      const bob = group.snapshot().legs.find(l => l.peerId === ULIDS.bob);
      return bob?.phase === 'failed';
    });

    // The session itself stays live — carol was reached and may yet answer.
    expect(group.live).toBe(true);
  });

  it('when every leg’s send fails the session ends instead of sitting live:true forever', async () => {
    const { group, failPeers } = makeGroup();
    failPeers.add(ULIDS.bob);
    failPeers.add(ULIDS.carol);

    await group.start([ULIDS.self, ULIDS.bob, ULIDS.carol], false);

    // Both legs fold terminal, nothing is revivable (nobody ever announced),
    // so `maybeRelease` releases: the gate's stranded shape was live:true
    // phase:joining at t=50s with no timer armed on either leg.
    await until('the session to release', () => !group.live);
    expect(
      out.some(l => /^GCALL released sid=\S+ reason=\S+$/.test(l)),
      `no released line; output:\n${out.join('\n')}`,
    ).toBe(true);
  });

  it('liveness: a healthy transport takes the guard’s happy path untouched', async () => {
    const { group, sent } = makeGroup();

    await group.start([ULIDS.self, ULIDS.bob, ULIDS.carol], false);

    expect(sent.some(s => s.peerId === ULIDS.bob)).toBe(true);
    expect(sent.some(s => s.peerId === ULIDS.carol)).toBe(true);
    // No failure line, no fold: both legs are inviting, the session is live.
    expect(out.filter(l => l.includes('effect_failed'))).toEqual([]);
    const phases = group.snapshot().legs.map(l => l.phase);
    expect(phases).toEqual(['inviting', 'inviting']);
    expect(group.live).toBe(true);
  });
});
