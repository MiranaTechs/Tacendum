import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  encodeCallEnvelope,
  encodeGroupCallEnvelope,
  parseCallEnvelope,
  type CallEndReason,
  type CallEnvelope,
  type GroupCallInviteEnvelope,
} from '@tacendum/shared';
import { CallRunner, fixtureCandidate, fixtureSdp, type CallLogRow } from '../src/call.js';
import { GroupCallRunner } from '../src/group-call.js';

/**
 * GROUP-CALL REMEDIATION: A STALE PER-PEER LEG RUNNER MUST NOT
 * SHADOW THE HELD-OFFER BUFFER.
 *
 * `GroupCallRunner.onBody` admits a frame BY CID (`ownsCid`) and then picked
 * its destination BY PEER with an existence-only test (`const leg =
 * this.legs.get(peerId); if (leg)`). `this.legs` is never pruned — only
 * `dispose()` clears it — and `call-session.ts` builds ONE runner per process,
 * so any peer who ever had a leg in this process permanently captured every
 * later frame for a cid this session owns but has no live leg for: the frame
 * went into the STALE (idle) 1:1 machine, which printed `CALL recv` and
 * discarded it, instead of into `bufferForLeg`, where the leg the answer opens
 * would have drained it.
 *
 * The file's own docblock states the rule the code broke ("By cid, not by
 * 'does a leg object exist for this peer' — the executor's leg map outlives
 * the session that built it"), and the correct predicate already existed as
 * its twin in the `closeLeg` effect: `if (leg && leg.cid === effect.cid)`.
 *
 * Every test here drives the reviewer's cross-session shape with the REAL
 * classes: session A (bob rings, carol's join offer held, we answer, we
 * leave) caches leg runners for bob and carol; session B (fresh sid and cids)
 * holds carol again, and carol acts while held. Each has a fresh-runner
 * control so a failure is attributable to the HISTORY, not to the script.
 *
 * Written RED against the existence-only predicate.
 */

const ULIDS = {
  self: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  bob: '01ARZ3NDEKTSV4RRFFQ69G5FAW',
  carol: '01ARZ3NDEKTSV4RRFFQ69G5FAX',
  sidA: '01BX5ZZKBKACTAV9WEVGEMMVT0',
  bobCidA: '01BX5ZZKBKACTAV9WEVGEMMVT1',
  carolCidA: '01BX5ZZKBKACTAV9WEVGEMMVT2',
  sidB: '01BX5ZZKBKACTAV9WEVGEMMVT3',
  bobCidB: '01BX5ZZKBKACTAV9WEVGEMMVT4',
  carolCidB: '01BX5ZZKBKACTAV9WEVGEMMVT5',
} as const;

const ROSTER = [ULIDS.bob, ULIDS.self, ULIDS.carol] as const;

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

function endBody(cid: string, reason: CallEndReason): string {
  return encodeCallEnvelope({ tcm: 'call.end', cid, r: reason });
}

function iceBody(cid: string, n: number, base = 0): string {
  return encodeCallEnvelope({
    tcm: 'call.ice',
    cid,
    c: Array.from({ length: n }, (_, i) => fixtureCandidate(base + i)),
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
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
  home = mkdtempSync(join(tmpdir(), 'tacendum-gc3-stale-'));
});

afterEach(() => {
  for (const runner of runners) runner.dispose();
  logSpy.mockRestore();
  rmSync(home, { recursive: true, force: true });
});

let msgIdSeq = 0;
const nextMsgId = (): string => {
  msgIdSeq += 1;
  return `01M5H${String(msgIdSeq).padStart(21, '0')}`;
};

let statePathSeq = 0;

function makeGroupRunner(): { group: GroupCallRunner; sent: Sent[] } {
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
  statePathSeq += 1;
  const group = new GroupCallRunner(io, ULIDS.self, 'tester', {
    statePath: join(home, `gcall-state-${statePathSeq}.json`),
    fallback,
  });
  runners.push(group);
  runners.push(fallback);
  return { group, sent };
}

/**
 * Session A, run to completion: bob rings us (his own leg offer riding the
 * ginvite), carol's join offer is HELD behind the ring, we answer — which
 * opens leg runners for BOTH of them — and we leave. The runners fold to
 * idle, but the executor's leg map keeps both objects: that cache is the
 * hazard under test.
 */
async function sessionA(group: GroupCallRunner): Promise<void> {
  await group.onBody(ULIDS.bob, ginviteBody(ULIDS.sidA, ULIDS.bobCidA, ROSTER), Date.now());
  await group.onBody(ULIDS.carol, ginviteBody(ULIDS.sidA, ULIDS.carolCidA, ROSTER), Date.now());
  await group.answer();
  await group.leave();
  expect(group.live, 'the premise is missing — session A did not end').toBe(false);
}

/** …and let session A's 250 ms ICE-rig timers fire against the folded (idle)
 * legs, so nothing of A's is still pending when session B begins. The armIce
 * test below deliberately SKIPS this settle — the pending timer is its
 * subject. */
async function sessionASettled(group: GroupCallRunner): Promise<void> {
  await sessionA(group);
  await sleep(320);
}

/** Session B: the same roster rings again under a fresh sid and fresh cids,
 * and carol's join offer is held exactly as in A. */
async function ringB(group: GroupCallRunner): Promise<void> {
  await group.onBody(ULIDS.bob, ginviteBody(ULIDS.sidB, ULIDS.bobCidB, ROSTER), Date.now());
  await group.onBody(ULIDS.carol, ginviteBody(ULIDS.sidB, ULIDS.carolCidB, ROSTER), Date.now());
  expect(group.snapshot().phase).toBe('ringing');
  expect(group.snapshot().heldOffers).toEqual([ULIDS.carol]);
}

function framesTo(sent: Sent[], peerId: string, tcm: string): CallEnvelope[] {
  return sent
    .filter(s => s.peerId === peerId)
    .map(s => parseCallEnvelope(s.body))
    .filter((e): e is CallEnvelope => e !== null && e.tcm === tcm);
}

/** peer:tcm per outbound frame, for whole-run comparison against a control. */
function frameSeq(sent: Sent[]): string[] {
  return sent.map(s => {
    const parsed = JSON.parse(s.body) as { tcm: string };
    const who =
      s.peerId === ULIDS.bob ? 'bob' : s.peerId === ULIDS.carol ? 'carol' : 'other';
    return `${who}:${parsed.tcm}`;
  });
}

// ---------------------------------------------------------------------------
describe('a cached session-A leg must not capture session-B frames', () => {
  it('ICE trickled behind the held offer reaches the buffer, not the stale leg', async () => {
    const { group } = makeGroupRunner();
    await sessionASettled(group);
    await ringB(group);

    const hold = out.length;
    const handled = await group.onBody(
      ULIDS.carol,
      iceBody(ULIDS.carolCidB, 2, 40),
      Date.now(),
    );
    expect(handled).toBe(true);
    // Held means held: the stale session-A runner must neither narrate nor
    // consume it. Pre-fix this slice holds `CALL recv tcm=call.ice` and
    // `CALL ice_recv` — the candidates dying inside the GROUP leg, which is
    // why the e2e's fallback-absence assertion cannot see this defect.
    expect(out.slice(hold), 'the held frame was routed somewhere').toEqual([]);

    await group.answer();

    expect(
      out.some(l =>
        l.startsWith(
          `GCALL pending_drained from=${ULIDS.carol} cid=${ULIDS.carolCidB} n=1 dropped=0`,
        ),
      ),
      `no drain for the held frame:\n${out.join('\n')}`,
    ).toBe(true);
    expect(
      out.some(l => l.startsWith(`CALL ice_applied cid=${ULIDS.carolCidB} n=2`)),
      `the candidates never reached the leg the answer opened:\n${out.join('\n')}`,
    ).toBe(true);
  });

  it('CONTROL: a fresh runner on the identical session-B script drains the same way', async () => {
    // Byte-identical session-B traffic against a runner with NO session-A
    // history — proves the assertions above test the cache, not the script.
    const { group } = makeGroupRunner();
    await ringB(group);

    const hold = out.length;
    await group.onBody(ULIDS.carol, iceBody(ULIDS.carolCidB, 2, 40), Date.now());
    expect(out.slice(hold)).toEqual([]);

    await group.answer();

    expect(
      out.some(l =>
        l.startsWith(
          `GCALL pending_drained from=${ULIDS.carol} cid=${ULIDS.carolCidB} n=1 dropped=0`,
        ),
      ),
    ).toBe(true);
    expect(out.some(l => l.startsWith(`CALL ice_applied cid=${ULIDS.carolCidB} n=2`))).toBe(true);
  });

  it('the busy rule still refuses a redelivered offer under the held cid — never a ring', async () => {
    const { group, sent } = makeGroupRunner();
    await sessionASettled(group);
    await ringB(group);
    out.length = 0;
    sent.length = 0;

    const handled = await group.onBody(ULIDS.carol, offerBody(ULIDS.carolCidB), Date.now());

    expect(handled).toBe(true);
    // The refusal is the busy rule's, exactly as for a runner with no cache: GCALL busy
    // plus call.end{r:'busy'} on the offered cid.
    expect(
      out.some(l => l.startsWith(`GCALL busy from=${ULIDS.carol} cid=${ULIDS.carolCidB}`)),
      `the refusal became contingent on the runner cache:\n${out.join('\n')}`,
    ).toBe(true);
    const ends = framesTo(sent, ULIDS.carol, 'call.end');
    expect(ends).toHaveLength(1);
    expect(ends[0]!.tcm === 'call.end' && ends[0]!.r).toBe('busy');
    expect(ends[0]!.cid).toBe(ULIDS.carolCidB);
    // …and the stale leg adopted nothing: no 1:1 ring narrated, no
    // call.ringing sent to the offerer.
    expect(out.some(l => l.startsWith('CALL recv tcm=call.offer'))).toBe(false);
    expect(out.some(l => l.startsWith('CALL ringing'))).toBe(false);
    expect(framesTo(sent, ULIDS.carol, 'call.ringing')).toEqual([]);
  });

  it('CONTROL: the same stray offer on a fresh runner gets the same busy', async () => {
    const { group, sent } = makeGroupRunner();
    await ringB(group);
    out.length = 0;
    sent.length = 0;

    await group.onBody(ULIDS.carol, offerBody(ULIDS.carolCidB), Date.now());

    expect(
      out.some(l => l.startsWith(`GCALL busy from=${ULIDS.carol} cid=${ULIDS.carolCidB}`)),
    ).toBe(true);
    const ends = framesTo(sent, ULIDS.carol, 'call.end');
    expect(ends).toHaveLength(1);
    expect(ends[0]!.tcm === 'call.end' && ends[0]!.r).toBe('busy');
  });

  it('a joiner WITHDRAWING her held offer is honored — no answer to a leg she left', async () => {
    const { group, sent } = makeGroupRunner();
    await sessionASettled(group);
    await ringB(group);
    out.length = 0;
    sent.length = 0;

    // Carol withdraws: a conforming client cancelling its held join offer.
    await group.onBody(ULIDS.carol, endBody(ULIDS.carolCidB, 'cancelled'), Date.now());
    await group.answer();

    // The withdrawal was buffered under her cid and drained into the leg the
    // answer opened BEFORE the accept, so the leg folds and no call.answer
    // goes to the peer who already left. Pre-fix the stale runner swallowed
    // the end and the answer went out anyway.
    expect(
      framesTo(sent, ULIDS.carol, 'call.answer'),
      `answered a leg the peer already withdrew:\n${frameSeq(sent).join(', ')}`,
    ).toEqual([]);
    expect(
      out.some(l =>
        l.startsWith(`GCALL pending_drained from=${ULIDS.carol} cid=${ULIDS.carolCidB} n=1`),
      ),
      `the withdrawal never reached the buffer:\n${out.join('\n')}`,
    ).toBe(true);
  });

  it('the whole session-B outbound sequence matches a fresh runner frame for frame', async () => {
    const subject = makeGroupRunner();
    const control = makeGroupRunner();
    await sessionASettled(subject.group);
    subject.sent.length = 0;

    const script = async (g: GroupCallRunner): Promise<void> => {
      await ringB(g);
      await g.onBody(ULIDS.carol, endBody(ULIDS.carolCidB, 'cancelled'), Date.now());
      await g.answer();
    };
    await script(subject.group);
    await script(control.group);

    // The reviewer's frame-list repro: the stale run sends an extra
    // call.answer. Sequence equality holds it to zero drift of ANY kind.
    expect(frameSeq(subject.sent)).toEqual(frameSeq(control.sent));
    // Non-vacuity: the control really did answer bob and fan the join out.
    expect(frameSeq(control.sent)).toContain('bob:call.answer');
    expect(frameSeq(control.sent).filter(f => f.endsWith(':call.gjoin')).length).toBeGreaterThan(0);
  });

  it('a session-A ICE-rig timer cannot fake-connect a session-B leg', async () => {
    // armIce is the OTHER peer-keyed existence-only lookup (rule-a sweep of
    // this finding): the 250 ms timer captured only the peerId, and
    // `iceConnected()` addresses whatever call the runner holds at fire time
    // — `iceStateChanged{connected}` promotes ANY non-ending state, an
    // unanswered `incoming_ringing` included (call-machine.ts). So a timer
    // armed by session A's observed answer could report session B's
    // still-ringing leg as connected, an answer having never crossed the wire.
    const { group } = makeGroupRunner();
    await sessionA(group); // NO settle: A's timers are still pending…
    await ringB(group); // …when B's bob leg opens, ringing, on the SAME runner.
    out.length = 0;
    await sleep(320); // A's timers fire inside this window.

    expect(
      out.filter(l => l.startsWith('CALL connected')),
      'a dead session’s rig timer connected a leg nobody answered',
    ).toEqual([]);
    expect(group.snapshot().phase).toBe('ringing');

    // Non-vacuity: the rig still works when THIS session observes an answer.
    await group.answer();
    await sleep(320);
    expect(out.some(l => l.startsWith(`CALL connected cid=${ULIDS.bobCidB}`))).toBe(true);
  });
});
