import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CALL_RING_TIMEOUT_MS,
  encodeCallEnvelope,
  encodeGroupCallEnvelope,
  parseCallEnvelope,
  type CallEnvelope,
  type GroupCallInviteEnvelope,
} from '@tacendum/shared';
import { CallRunner, fixtureSdp, type CallLogRow } from '../src/call.js';
import { GroupCallRunner } from '../src/group-call.js';

/**
 * GROUP-CALL REMEDIATION: `armIce` MUST BE ARMED BY AN ANSWER
 * THE LEG ACCEPTED, NOT BY THE ARRIVING FRAME'S KIND.
 *
 * An earlier revision gave `armIce` a FIRE-TIME cid check and left both ARM-TIME
 * predicates keyed on `tcm === 'call.answer'` (`group-call.ts` `onBody`, and
 * its twin in `drainPending`). That is the same partial mirror one level
 * deeper: the membership was fixed, the ARMING was not.
 *
 * The hole: on a leg still in `incoming_ringing` — the state `openLegRinging`
 * leaves the starter's leg in until a human answers — `answerReceived` is
 * NOTHING (`call-machine.ts`: the accepting states are `outgoing_connecting`,
 * `outgoing_ringing` and `reconnecting`, and nothing else). The reducer
 * correctly discards the frame. The rig armed anyway, and 250 ms later the leg
 * still held that cid, so an earlier revision's fire-time check passed and
 * `iceStateChanged{connected}` — which promotes ANY non-`ending`,
 * non-`connected` state — promoted the ringing leg.
 *
 * Three measured consequences, each reproduced below against a byte-identical
 * control:
 *
 *  1. `CALL connected cid=…` prints for a call nobody answered.
 *  2. AN INDEFINITE RING WEDGE, and it breaks a guarantee written verbatim in
 *     `packages/shared/src/call-session.ts` (`openLegRinging`'s docblock:
 *     "that list has no way to stop ringing … and a peer must not be able to
 *     make us ring forever"). `iceStateChanged{connected}` emits
 *     `cancelTimer ring`; `ringTimeout` is NOTHING outside the two ringing
 *     states; and there is no session-level ring bound. The 60 s timer is the
 *     ONLY thing that stops the ring, and the rogue frame cancels it.
 *  3. A SILENT NON-ANSWER: `localAccept` is a no-op in `connected`, so a human
 *     answering afterwards sends no `call.answer` at all — while the session
 *     still promotes itself to `live`. That is exactly the leg
 *     `ICE_CONNECTED_RIG_MS`'s own docblock promises cannot happen ("Armed
 *     from an OBSERVED answer … so a leg whose answer never crossed the wire
 *     still fails").
 *
 * BOUNDS, so the shape under test is the real one: the rogue `call.answer` is
 * admitted by `ownsCid`'s starterOffer arm, which requires
 * `s.starterId === peerId` — the authenticated starter, pre-answer only.
 *
 * Timers are driven with vitest's fake clock rather than slept through: the
 * wedge is a 60-second fact and a 60-second test is not a test.
 *
 * Written RED against the kind-keyed predicates.
 */

const ULIDS = {
  self: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  bob: '01ARZ3NDEKTSV4RRFFQ69G5FAW',
  sid: '01BX5ZZKBKACTAV9WEVGEMMVT0',
  bobCid: '01BX5ZZKBKACTAV9WEVGEMMVT1',
} as const;

/** Two members, so every outbound frame below is addressed to the starter and
 * the sequence comparisons have nothing else in them. */
const ROSTER = [ULIDS.bob, ULIDS.self] as const;

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
    exp: Date.now() + 600_000,
  };
  return encodeGroupCallEnvelope(invite);
}

/** The rogue frame: an ordinary, well-formed `call.answer` for the cid the
 * starter's own ginvite opened. Nothing about it is malformed — the whole
 * point is that a conforming encoder produces it. */
function answerBody(cid: string): string {
  const envelope: CallEnvelope = {
    tcm: 'call.answer',
    cid,
    sdp: fixtureSdp('answer', cid),
    vid: false,
  };
  return encodeCallEnvelope(envelope);
}

let out: string[];
let logSpy: ReturnType<typeof vi.spyOn>;
let home: string;
let runners: { dispose(): void }[];
/** Fired for every console line, synchronously, before it is recorded. One
 * test needs to act at a precise point inside an effect list; everything else
 * leaves it unset. */
let onLine: ((line: string) => void) | null;

beforeEach(() => {
  vi.useFakeTimers();
  out = [];
  runners = [];
  onLine = null;
  logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    const line = args.map(a => String(a)).join(' ');
    onLine?.(line);
    out.push(line);
  });
  home = mkdtempSync(join(tmpdir(), 'tacendum-gc3-rogue-arm-'));
});

afterEach(() => {
  for (const runner of runners) runner.dispose();
  logSpy.mockRestore();
  vi.useRealTimers();
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
  const fallback = new CallRunner({ send: io.send, writeLog: io.writeLog, now: io.now }, 'tester');
  statePathSeq += 1;
  const group = new GroupCallRunner(io, ULIDS.self, 'tester', {
    statePath: join(home, `gcall-state-${statePathSeq}.json`),
    fallback,
  });
  runners.push(group);
  runners.push(fallback);
  return { group, sent };
}

/** Let the microtask queue drain — the rig's timer callback dispatches onto
 * the session's serialized chain, which is several awaits deep. */
async function flush(): Promise<void> {
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
}

async function tick(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await flush();
}

/** Bob (the authenticated starter) rings us. Our leg opens in
 * `incoming_ringing` via `openLegRinging`; nobody answers. */
async function ring(group: GroupCallRunner): Promise<void> {
  await group.onBody(ULIDS.bob, ginviteBody(ULIDS.sid, ULIDS.bobCid, ROSTER), Date.now());
  await flush();
  expect(group.snapshot().phase, 'the premise is missing — we are not ringing').toBe('ringing');
}

function frameSeq(sent: Sent[]): string[] {
  return sent.map(s => {
    const parsed = JSON.parse(s.body) as { tcm: string };
    return `${s.peerId === ULIDS.bob ? 'bob' : 'other'}:${parsed.tcm}`;
  });
}

function framesTo(sent: Sent[], peerId: string, tcm: string): CallEnvelope[] {
  return sent
    .filter(s => s.peerId === peerId)
    .map(s => parseCallEnvelope(s.body))
    .filter((e): e is CallEnvelope => e !== null && e.tcm === tcm);
}

// ---------------------------------------------------------------------------
describe('a discarded answer must not arm the ICE rig', () => {
  it('OUTCOME 1: no CALL connected for a call nobody answered', async () => {
    const { group } = makeGroupRunner();
    await ring(group);
    out.length = 0;

    // The starter answers his OWN invite. The reducer discards it
    // (`answerReceived` is NOTHING in `incoming_ringing`) …
    await group.onBody(ULIDS.bob, answerBody(ULIDS.bobCid), Date.now());
    await flush();
    // … and 250 ms is ICE_CONNECTED_RIG_MS, the whole window the rig lives in.
    await tick(300);

    expect(
      out.filter(l => l.startsWith('CALL connected')),
      'a frame the reducer discarded connected the leg anyway',
    ).toEqual([]);
    expect(out.filter(l => l.startsWith('GCALL connected'))).toEqual([]);
    expect(group.snapshot().phase).toBe('ringing');
    expect(group.snapshot().connected).toBe(false);
  });

  it('CONTROL: the identical ring without the rogue frame is equally silent', async () => {
    const { group } = makeGroupRunner();
    await ring(group);
    out.length = 0;

    await tick(300);

    expect(out.filter(l => l.startsWith('CALL connected'))).toEqual([]);
    expect(group.snapshot().phase).toBe('ringing');
  });

  it('NON-VACUITY: an answer this device actually accepted still connects', async () => {
    const { group } = makeGroupRunner();
    await ring(group);
    // The human answers, our `call.answer` goes out, and the rig — armed from
    // the OBSERVED `incoming_answering` transition — connects the leg.
    await group.answer();
    await flush();
    await tick(300);

    expect(out.some(l => l.startsWith(`CALL connected cid=${ULIDS.bobCid}`))).toBe(true);
    expect(group.snapshot().phase).toBe('live');
  });

  it('OUTCOME 2: the 60 s ring bound survives the rogue frame', async () => {
    const { group } = makeGroupRunner();
    await ring(group);
    await group.onBody(ULIDS.bob, answerBody(ULIDS.bobCid), Date.now());
    await flush();
    await tick(300);
    out.length = 0;

    // Past the ring timeout. `iceStateChanged{connected}` cancels the ring
    // timer, `ringTimeout` is inert outside the ringing states, and there is
    // no session-level ring bound — so pre-fix nothing here ever fires and the
    // client rings forever. The guarantee is `openLegRinging`'s, verbatim:
    // "a peer must not be able to make us ring forever".
    await tick(CALL_RING_TIMEOUT_MS + 1_000);

    expect(
      out.some(l => l.startsWith(`CALL ended cid=${ULIDS.bobCid} reason=timeout`)),
      `the ring never timed out — lines since the rig fired: ${JSON.stringify(out)}; ` +
        `dump: ${JSON.stringify(group.snapshot())}`,
    ).toBe(true);
    expect(out.some(l => l.startsWith(`CALL logged cid=${ULIDS.bobCid} reason=timeout missed=true`)))
      .toBe(true);
    expect(out.some(l => l.startsWith(`GCALL released sid=${ULIDS.sid} reason=timeout`))).toBe(true);
    expect(out.some(l => l.startsWith(`GCALL row_closed sid=${ULIDS.sid}`))).toBe(true);
    const dump = group.snapshot();
    expect(dump.live).toBe(false);
    expect(dump.phase).toBeNull();
    expect(dump.endedReason).toBe('timeout');
  });

  it('CONTROL: the same ring with no rogue frame ends on the same bound', async () => {
    const { group } = makeGroupRunner();
    await ring(group);
    await tick(300);
    out.length = 0;

    await tick(CALL_RING_TIMEOUT_MS + 1_000);

    expect(out.some(l => l.startsWith(`CALL ended cid=${ULIDS.bobCid} reason=timeout`))).toBe(true);
    expect(out.some(l => l.startsWith(`CALL logged cid=${ULIDS.bobCid} reason=timeout missed=true`)))
      .toBe(true);
    expect(out.some(l => l.startsWith(`GCALL released sid=${ULIDS.sid} reason=timeout`))).toBe(true);
    expect(out.some(l => l.startsWith(`GCALL row_closed sid=${ULIDS.sid}`))).toBe(true);
    const dump = group.snapshot();
    expect(dump.live).toBe(false);
    expect(dump.phase).toBeNull();
    expect(dump.endedReason).toBe('timeout');
  });

  it('OUTCOME 3: answering after the rogue frame still puts call.answer on the wire', async () => {
    const subject = makeGroupRunner();
    await ring(subject.group);
    await subject.group.onBody(ULIDS.bob, answerBody(ULIDS.bobCid), Date.now());
    await flush();
    await tick(300);
    // Now the human answers. Pre-fix the leg is already `connected`, so
    // `localAccept` is a no-op and NO `call.answer` ever leaves — while
    // `onState` still drives the session to `live`.
    await subject.group.answer();
    await flush();

    const control = makeGroupRunner();
    await ring(control.group);
    await tick(300);
    await control.group.answer();
    await flush();

    expect(
      framesTo(subject.sent, ULIDS.bob, 'call.answer'),
      `the session went live with our answer never on the wire:\n${frameSeq(subject.sent).join(', ')}`,
    ).toHaveLength(1);
    // Whole-sequence equality, so the rogue frame costs no drift of any kind.
    expect(frameSeq(subject.sent)).toEqual(frameSeq(control.sent));
    // Non-vacuity: the control really did answer and announce.
    expect(frameSeq(control.sent)).toEqual(['bob:call.ringing', 'bob:call.answer', 'bob:call.gjoin']);
  });

  it('THE TWIN: drainPending must not arm on a frame kind either', async () => {
    // `drainPending` carries the IDENTICAL predicate and is the twin site of
    // the one above. It is NOT independently reachable in the shipped client —
    // inbound frames are serialized on `CallSession.queue`, so nothing can
    // land between the reducer adopting `starterOffer` and `openLegRinging`
    // calling `ensureLeg` — so this test CONSTRUCTS that window rather than
    // pretending to find it: `ringFresh` emits `writeSessionRow` before
    // `openLegRinging`, and the executor awaits each effect, so the frame is
    // handed in from inside the `GCALL row_written` line. Everything after
    // that is the production path: `ownsCid` admits it on the starterOffer
    // arm, no leg exists yet, `bufferForLeg` holds it, and the drain replays
    // it into a leg that has just opened `incoming_ringing`.
    const { group } = makeGroupRunner();
    let handed: Promise<boolean> | null = null;
    onLine = line => {
      if (handed !== null || !line.startsWith('GCALL row_written')) return;
      handed = group.onBody(ULIDS.bob, answerBody(ULIDS.bobCid), Date.now());
    };

    await group.onBody(ULIDS.bob, ginviteBody(ULIDS.sid, ULIDS.bobCid, ROSTER), Date.now());
    await flush();
    onLine = null;
    expect(handed, 'the interleave never happened — the buffer was never filled').not.toBeNull();
    expect(await handed!).toBe(true);
    // The premise: it really did go through the buffer and really was drained.
    expect(
      out.some(l =>
        l.startsWith(`GCALL pending_drained from=${ULIDS.bob} cid=${ULIDS.bobCid} n=1 dropped=0`),
      ),
      `the frame never reached drainPending:\n${out.join('\n')}`,
    ).toBe(true);
    out.length = 0;

    await tick(300);

    expect(
      out.filter(l => l.startsWith('CALL connected')),
      'the drain armed the rig on the frame kind',
    ).toEqual([]);
    expect(group.snapshot().phase).toBe('ringing');

    // …and the ring bound still holds through the drained frame.
    await tick(CALL_RING_TIMEOUT_MS + 1_000);
    expect(out.some(l => l.startsWith(`CALL ended cid=${ULIDS.bobCid} reason=timeout`))).toBe(true);
    expect(group.snapshot().live).toBe(false);
  });
});
