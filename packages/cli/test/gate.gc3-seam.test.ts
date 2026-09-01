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
 * Three group-call defects — 3a, 3b and 4b below — held as unit cover.
 *
 * The e2e group-call harness proves the same three properties over a real
 * server and a real ratchet, which is the gate that matters. These exist
 * because that gate costs minutes and Docker, and because two of the three
 * are ABSENCE claims — silence, and a refusal — which are exactly the kind a
 * later innocent edit turns green by removing the thing that was supposed to
 * be silent.
 *
 * Every test below was written red against the pre-fix runner:
 *
 *  - 3a: `CallRunner.onBody` printed `CALL unsupported` for a `call.g*` frame
 *    a 1:1-only build cannot parse. The whole `call.` namespace is
 *    transport-before-parse (render.ts, app/src/envelope.ts): silent whether
 *    or not this build can read it.
 *  - 3b: the cross-shape interlock was absent. Leg traffic routed on
 *    "does a leg object exist for this peer", so a live session and a live
 *    1:1 call could coexist and a later 1:1 offer could be adopted by a
 *    stale group leg.
 *  - 4b: nothing proved `TACENDUM_TEST_CANARY` reached an SDP, so the gate's
 *    absence scans could pass vacuously.
 */

const ULIDS = {
  self: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  bob: '01ARZ3NDEKTSV4RRFFQ69G5FAW',
  carol: '01ARZ3NDEKTSV4RRFFQ69G5FAX',
  stranger: '01ARZ3NDEKTSV4RRFFQ69G5FAY',
  strayCid: '01BX5ZZKBKACTAV9WEVGEMMVRZ',
  otherCid: '01BX5ZZKBKACTAV9WEVGEMMVS0',
  sid: '01BX5ZZKBKACTAV9WEVGEMMVS1',
  heldCid: '01BX5ZZKBKACTAV9WEVGEMMVS2',
  sid2: '01BX5ZZKBKACTAV9WEVGEMMVS3',
  /** Sorts BELOW `sid`, so an invite carrying it wins session glare. */
  lowSid: '01BX5ZZKBKACTAV9WEVGEMMVRY',
  dave: '01ARZ3NDEKTSV4RRFFQ69G5FB0',
  daveCid: '01BX5ZZKBKACTAV9WEVGEMMVS4',
} as const;

interface Sent {
  peerId: string;
  body: string;
  urgent: boolean;
}

function offerBody(cid: string, canary?: string): string {
  const envelope: CallEnvelope = {
    tcm: 'call.offer',
    cid,
    sdp: fixtureSdp('offer', cid, canary),
    vid: false,
    exp: Date.now() + 60_000,
  };
  return encodeCallEnvelope(envelope);
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

function endBody(cid: string, reason: CallEndReason): string {
  return encodeCallEnvelope({ tcm: 'call.end', cid, r: reason });
}

function gleaveBody(sid: string, member: string, se: number): string {
  return encodeGroupCallEnvelope({ tcm: 'call.gleave', sid, m: member, se });
}

/** Reject if `work` has not settled within `ms` — so a WEDGE fails the test
 * fast and by name instead of hanging vitest until its own timeout. */
async function within<T>(ms: number, what: string, work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`WEDGED: ${what} did not settle in ${ms}ms`)), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** One trickle envelope carrying `n` candidates, distinguishable by `base` so
 * two envelopes are never byte-identical. */
function iceBody(cid: string, n: number, base = 0): string {
  return encodeCallEnvelope({
    tcm: 'call.ice',
    cid,
    c: Array.from({ length: n }, (_, i) => fixtureCandidate(base + i)),
  });
}

let out: string[];
let logSpy: ReturnType<typeof vi.spyOn>;
let home: string;
/**
 * Every runner a test built, so the test that follows it inherits none of its
 * timers. An answered session arms the ICE rig 250 ms out (group-call.ts), and
 * a timer that survives its test writes a state dump into a home directory
 * `afterEach` has already removed — a `GCALL state_write_failed` line landing
 * in the NEXT test's captured output, which is how an absence assertion fails
 * for a reason that has nothing to do with the code it is about.
 */
let runners: { dispose(): void }[];

beforeEach(() => {
  out = [];
  runners = [];
  logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    out.push(args.map(a => String(a)).join(' '));
  });
  home = mkdtempSync(join(tmpdir(), 'tacendum-gc3-'));
});

afterEach(() => {
  for (const runner of runners) runner.dispose();
  logSpy.mockRestore();
  rmSync(home, { recursive: true, force: true });
});

/**
 * A distinct, well-formed transport id per send.
 *
 * The executor and the 1:1 runner both PRINT this value now, through an
 * emitter that replaces anything failing strict ULID grammar with `redacted`
 * (`ID_FIELD_KEYS` in call.ts and group-call.ts). A rig handing back a
 * placeholder would make every assertion about the id an assertion about the
 * redaction, and distinct ids are what let a test say WHICH frame a line is
 * about.
 */
let msgIdSeq = 0;
const nextMsgId = (): string => {
  msgIdSeq += 1;
  // No I, L, O or U: Crockford base32 is what `ULID_SHAPE` accepts.
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

function makeGroupRunner(
  options: {
    canary?: string;
    withFallback?: boolean;
    /** Which recipients the SERVER acknowledges. Everyone, by default. */
    /**
     * What the server's receipt says for this recipient — `null` for no
     * receipt at all inside the budget. The two ACK KINDS are distinct facts
     * (`ReceiptKind`, group-call.ts): `'sent'` is the server holding the
     * frame for someone who is not connected, `'delivered'` is the server
     * having written it to a live socket of theirs. A rig that answered a
     * boolean could not tell the fan-out's two counters apart.
     */
    ackTo?: (peerId: string) => 'sent' | 'delivered' | null;
    /** What the transport reports as the row's id. Overridden only to prove
     * the emitter's grammar check refuses a value that is not a ULID. */
    msgId?: () => string;
  } = {},
): {
  group: GroupCallRunner;
  fallback: CallRunner | undefined;
  sent: Sent[];
  /** Flipped mid-test to fault the transport AFTER a session is set up —
   * setting it up needs a working one. `stall` never settles (the wedged send
   * chain); `throw` is a transport that refuses. */
  send: { mode: 'ok' | 'stall' | 'throw' };
} {
  const sent: Sent[] = [];
  const send: { mode: 'ok' | 'stall' | 'throw' } = { mode: 'ok' };
  const io = {
    send: async (peerId: string, body: string, urgent: boolean) => {
      sent.push({ peerId, body, urgent });
      // The wedge in its exact shape: `io.send` is an unbounded await on the
      // one send chain, so a stalled request never resolves and never rejects.
      if (send.mode === 'stall') await new Promise<never>(() => undefined);
      if (send.mode === 'throw') throw new Error('transport said no');
      // A REAL ULID, because the executor now PRINTS this value and the print
      // is grammar-checked (`ID_FIELD_KEYS`, group-call.ts). A rig returning
      // 'msgid' would make every id line read `redacted` and the assertions
      // below would be about the redaction rather than about the id.
      return (options.msgId ?? nextMsgId)();
    },
    // The frame still goes out either way — an unacked send is one the server
    // never confirmed, NOT one that was never written. Anything else would
    // make the test below pass for the wrong reason.
    sendAcked: async (
      peerId: string,
      body: string,
      urgent: boolean,
      onMsgId?: (msgId: string) => void,
    ) => {
      sent.push({ peerId, body, urgent });
      // The real `sendAcked` (call-session.ts) hands the id over as soon as
      // the send resolves, before it waits on the receipt; a rig that skipped
      // it would leave the `delta_frame` line untested.
      onMsgId?.((options.msgId ?? nextMsgId)());
      return options.ackTo ? options.ackTo(peerId) : 'delivered';
    },
    writeLog: (_row: CallLogRow) => undefined,
    now: () => Date.now(),
  };
  const fallback =
    options.withFallback === false
      ? undefined
      : new CallRunner(
          {
            send: io.send,
            writeLog: io.writeLog,
            now: io.now,
          },
          'tester',
        );
  const group = new GroupCallRunner(io, ULIDS.self, 'tester', {
    statePath: join(home, 'gcall-state.json'),
    ...(options.canary ? { canary: options.canary } : {}),
    ...(fallback ? { fallback } : {}),
  });
  runners.push(group);
  if (fallback) runners.push(fallback);
  return { group, fallback, sent, send };
}

/**
 * the ring-once shape, set up: bob rings us into a session whose roster also
 * names carol, and carol's own leg offer for that same session arrives while we
 * are still ringing — admitted (`join_leg`) but HELD, with no leg runner behind
 * it until a human answers. That hold is the window the buffer exists for.
 */
async function ringWithHeldOffer(group: GroupCallRunner): Promise<void> {
  const roster = [ULIDS.bob, ULIDS.self, ULIDS.carol];
  await group.onBody(ULIDS.bob, ginviteBody(ULIDS.sid, ULIDS.otherCid, roster), Date.now());
  await group.onBody(ULIDS.carol, ginviteBody(ULIDS.sid, ULIDS.heldCid, roster), Date.now());
}

function endsSentTo(sent: Sent[], peerId: string): CallEnvelope[] {
  return sent
    .filter(s => s.peerId === peerId)
    .map(s => parseCallEnvelope(s.body))
    .filter((e): e is CallEnvelope => e !== null && e.tcm === 'call.end');
}

// ---------------------------------------------------------------------------
describe('starter metric authority', () => {
  it('mints a report id independent from session and leg ids, while inbound stays non-authoritative', async () => {
    const { group } = makeGroupRunner();
    const sid = await group.start([ULIDS.self, ULIDS.bob], false);
    const started = (group as unknown as {
      state: { reportId: string | null; legs: Record<string, { cid: string }> } | null;
    }).state;

    expect(started).not.toBeNull();
    expect(started!.reportId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect([sid, ...Object.values(started!.legs).map(leg => leg.cid)]).not.toContain(
      started!.reportId,
    );

    const { group: inbound } = makeGroupRunner();
    await inbound.onBody(
      ULIDS.bob,
      ginviteBody(ULIDS.sid, ULIDS.otherCid, [ULIDS.bob, ULIDS.self]),
      Date.now(),
    );
    const received = (inbound as unknown as {
      state: { reportId: string | null } | null;
    }).state;
    expect(received?.reportId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe('3a: the whole call.* namespace is silent transport, parse or no parse', () => {
  it('says NOTHING for a call.ginvite a 1:1-only build cannot parse', async () => {
    // The pinned requirement's own words: a client running the 1:1-only parser
    // "receives the full session and prints nothing, rings nothing, crashes
    // never". `CALL unsupported` is a print.
    const { runner } = makeCallRunner();
    const handled = await runner.onBody(
      ULIDS.bob,
      ginviteBody(ULIDS.sid, ULIDS.strayCid, [ULIDS.self, ULIDS.bob]),
      Date.now(),
    );
    expect(handled).toBe(true); // still transport: never a chat row
    expect(out).toEqual([]);
  });

  it('says nothing for call.gjoin or call.gleave either', async () => {
    const { runner } = makeCallRunner();
    for (const body of [
      `{"tcm":"call.gjoin","sid":"${ULIDS.sid}","m":"${ULIDS.carol}","se":1}`,
      `{"tcm":"call.gleave","sid":"${ULIDS.sid}","m":"${ULIDS.carol}","se":2}`,
    ]) {
      expect(await runner.onBody(ULIDS.bob, body, Date.now())).toBe(true);
    }
    expect(out).toEqual([]);
  });

  it('says nothing for a future call.* kind — the namespace decides, not the union', async () => {
    const { runner } = makeCallRunner();
    const handled = await runner.onBody(
      ULIDS.bob,
      `{"tcm":"call.future","cid":"${ULIDS.strayCid}","sdp":"x"}`,
      Date.now(),
    );
    expect(handled).toBe(true);
    expect(out).toEqual([]);
  });

  it('hands a NON-call envelope back to the caller instead of claiming it', async () => {
    // The old code answered "the call machine handled this" for every
    // structured body it could not parse — a reply, a photo, a reaction —
    // and printed `CALL unsupported from=<raw peerId>` over it. Neither is
    // this class's business; the namespace is.
    const { runner } = makeCallRunner();
    const handled = await runner.onBody(
      ULIDS.bob,
      '{"tcm":"reply","ref":"01ARZ3NDEKTSV4RRFFQ69G5FAV","text":"see you at 8"}',
      Date.now(),
    );
    expect(handled).toBe(false);
    expect(out).toEqual([]);
  });

  it('still rings for a WELL-FORMED offer — the silence is not blanket deafness', async () => {
    const { runner } = makeCallRunner();
    await runner.onBody(ULIDS.bob, offerBody(ULIDS.strayCid), Date.now());
    expect(out.some(l => l.startsWith('CALL ringing '))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('3b: one call per device, across both shapes', () => {
  it('answers a stranger`s 1:1 offer with call.end{busy} while a session is live', async () => {
    const { group, fallback, sent } = makeGroupRunner();
    await group.start([ULIDS.self, ULIDS.bob], false);
    expect(group.live).toBe(true);
    out.length = 0;
    sent.length = 0;

    const handled = await group.onBody(ULIDS.stranger, offerBody(ULIDS.strayCid), Date.now());

    expect(handled).toBe(true);
    const ends = endsSentTo(sent, ULIDS.stranger);
    expect(ends).toHaveLength(1);
    expect(ends[0]!.tcm === 'call.end' && ends[0]!.r).toBe('busy');
    expect(ends[0]!.cid).toBe(ULIDS.strayCid);
    // …and the 1:1 runner underneath never saw it: no ring, no second call.
    expect(fallback!.stateName).toBe('idle');
    expect(out.some(l => l.startsWith('CALL ringing '))).toBe(false);
  });

  it('refuses a 1:1 offer from a PARTICIPANT under a cid the session does not own', async () => {
    // The stale-leg hazard in its exact shape: bob already has a leg object,
    // so peer-keyed routing handed his fresh 1:1 offer to it and let a
    // private call be adopted into the session's mesh.
    const { group, sent } = makeGroupRunner();
    await group.start([ULIDS.self, ULIDS.bob], false);
    out.length = 0;
    sent.length = 0;

    await group.onBody(ULIDS.bob, offerBody(ULIDS.strayCid), Date.now());

    const ends = endsSentTo(sent, ULIDS.bob);
    expect(ends).toHaveLength(1);
    expect(ends[0]!.cid).toBe(ULIDS.strayCid);
    expect(ends[0]!.tcm === 'call.end' && ends[0]!.r).toBe('busy');
    // The leg's own cid is untouched — the session did not adopt the stray.
    const leg = group.snapshot().legs.find(l => l.peerId === ULIDS.bob);
    expect(leg?.cid).not.toBe(ULIDS.strayCid);
  });

  it('still routes a leg frame that names a cid the session DOES own', async () => {
    // The control: cid-ownership routing must not deafen the mesh.
    const { group, sent } = makeGroupRunner();
    await group.start([ULIDS.self, ULIDS.bob], false);
    const legCid = group.snapshot().legs.find(l => l.peerId === ULIDS.bob)!.cid;
    out.length = 0;
    sent.length = 0;

    await group.onBody(
      ULIDS.bob,
      encodeCallEnvelope({ tcm: 'call.ringing', cid: legCid }),
      Date.now(),
    );

    expect(out.some(l => l.startsWith(`CALL recv tcm=call.ringing cid=${legCid}`))).toBe(true);
    expect(endsSentTo(sent, ULIDS.bob)).toHaveLength(0);
  });

  it('answers a ginvite with call.end{busy} while a 1:1 call is live', async () => {
    const { group, fallback, sent } = makeGroupRunner();
    await fallback!.placeCall(ULIDS.carol, false);
    expect(fallback!.stateName).not.toBe('idle');
    out.length = 0;
    sent.length = 0;

    const handled = await group.onBody(
      ULIDS.bob,
      ginviteBody(ULIDS.sid, ULIDS.otherCid, [ULIDS.bob, ULIDS.self]),
      Date.now(),
    );

    expect(handled).toBe(true);
    const ends = endsSentTo(sent, ULIDS.bob);
    expect(ends).toHaveLength(1);
    expect(ends[0]!.cid).toBe(ULIDS.otherCid);
    expect(ends[0]!.tcm === 'call.end' && ends[0]!.r).toBe('busy');
    // The session never formed, so nothing rang and no state was written.
    expect(group.live).toBe(false);
    expect(out.some(l => l.startsWith('GCALL ringing '))).toBe(false);
  });

  it('rings a ginvite normally when neither shape is live — the refusal is conditional', async () => {
    const { group, sent } = makeGroupRunner();
    const handled = await group.onBody(
      ULIDS.bob,
      ginviteBody(ULIDS.sid, ULIDS.otherCid, [ULIDS.bob, ULIDS.self]),
      Date.now(),
    );
    expect(handled).toBe(true);
    expect(group.live).toBe(true);
    expect(out.some(l => l.startsWith(`GCALL ringing sid=${ULIDS.sid}`))).toBe(true);
    expect(endsSentTo(sent, ULIDS.bob)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
describe('4b: the canary positive control', () => {
  it('reports that the composed ginvite actually carried the canary', async () => {
    // The gate's section 7 scans the server log and every stored payload for
    // the marker's ABSENCE. Rename the env var and the marker is silently
    // omitted, the call proceeds, and every scan goes green having looked for
    // a string that was never sent. This line is what anchors them.
    const { group } = makeGroupRunner({ canary: 'TACENDUM-UNIT-CANARY' });
    await group.start([ULIDS.self, ULIDS.bob], false);
    expect(out.some(l => /^CALL sent tcm=call\.ginvite .* canary=true$/.test(l))).toBe(true);
  });

  it('says nothing about a canary when the rig is off — no product surface', async () => {
    const { group } = makeGroupRunner();
    await group.start([ULIDS.self, ULIDS.bob], false);
    expect(out.some(l => l.startsWith('CALL sent tcm=call.ginvite'))).toBe(true);
    expect(out.some(l => l.includes('canary='))).toBe(false);
  });

  it('reports canary=false when the marker did NOT reach the SDP', async () => {
    // The falsifier for the check above: a runner whose canary is configured
    // but whose SDP does not carry it must say so rather than stay silent.
    const { runner, sent } = makeCallRunner();
    runner.canary = 'NEVER-IN-THE-SDP';
    runner.onEnvelope = envelope => ({
      tcm: envelope.tcm as string,
      // A rewrite that drops the SDP — the plumbing break this guards.
      body: JSON.stringify({ ...envelope, sdp: 'v=0' }),
    });
    await runner.placeCall(ULIDS.bob, false);
    expect(sent).toHaveLength(1);
    expect(out.some(l => /^CALL sent .* canary=false$/.test(l))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
/**
 * A held offer's early frames, held with it.
 *
 * The reducer holds a later joiner's leg offer until a human answers the SESSION, so
 * between that offer and the answer there is a cid this session OWNS with no
 * leg runner behind it. The joiner does not wait: it trickles `call.ice` the
 * moment its offer is out. Those frames were owned, unroutable, and therefore
 * fell through to the 1:1 fallback — which printed a `CALL recv tcm=call.ice`
 * line about a group frame and discarded the candidates. The leg the answer
 * later opened started with none of them: a slower connect, or none at all.
 */
describe('GC3: a held offer`s early frames survive the hold', () => {
  it('replays a held joiner`s early ICE into the leg the answer opens', async () => {
    const { group } = makeGroupRunner();
    await ringWithHeldOffer(group);
    expect(group.snapshot().heldOffers).toEqual([ULIDS.carol]);
    expect(group.snapshot().phase).toBe('ringing');
    out.length = 0;

    // Carol trickles before we answer. Owned (heldOffers), unroutable (no leg).
    const handled = await group.onBody(ULIDS.carol, iceBody(ULIDS.heldCid, 2), Date.now());
    expect(handled).toBe(true);
    // Held means held: nothing routed, nothing narrated, nothing sent.
    expect(out).toEqual([]);

    await group.answer();

    // `ice_applied` is the leg's own line for candidates ATTACHED to its call —
    // the drained frames reached the leg machine, not merely a log line.
    expect(out.some(l => l.startsWith(`CALL ice_applied cid=${ULIDS.heldCid} n=2`))).toBe(true);
    // …and they arrived through the leg, at answer time, not at delivery time.
    expect(
      out.some(l => l.startsWith(`CALL recv tcm=call.ice cid=${ULIDS.heldCid} from=${ULIDS.carol}`)),
    ).toBe(true);
  });

  it('lets NOTHING escape to the 1:1 fallback while the offer is held', async () => {
    // The absence half, which is the half a later innocent edit turns green:
    // the buffered frame must not reach the runner underneath at all — no
    // `CALL recv` line, no counted envelope, no state of its own.
    const { group, fallback } = makeGroupRunner();
    await ringWithHeldOffer(group);
    out.length = 0;

    await group.onBody(ULIDS.carol, iceBody(ULIDS.heldCid, 2), Date.now());

    expect(fallback!.recvIceEnvelopes.count).toBe(0);
    expect(fallback!.recvIceEnvelopes.candidates).toBe(0);
    expect(fallback!.stateName).toBe('idle');
    expect(out.some(l => l.startsWith('CALL recv'))).toBe(false);
  });

  it('bounds the buffer at 32 frames per peer and drops the OLDEST', async () => {
    // A peer that is refused a leg must not be able to grow this process's
    // memory by trickling. The fat frame goes FIRST so the drained candidate
    // total says which end was dropped: oldest-out leaves 32 candidates,
    // newest-out would leave 34.
    const { group } = makeGroupRunner();
    await ringWithHeldOffer(group);
    out.length = 0;

    await group.onBody(ULIDS.carol, iceBody(ULIDS.heldCid, 3), Date.now());
    for (let i = 0; i < 32; i += 1) {
      await group.onBody(ULIDS.carol, iceBody(ULIDS.heldCid, 1, 10 + i), Date.now());
    }
    expect(out).toEqual([]);

    await group.answer();

    const recv = out.filter(l =>
      l.startsWith(`CALL recv tcm=call.ice cid=${ULIDS.heldCid} from=${ULIDS.carol}`),
    );
    expect(recv).toHaveLength(32);
    expect(out.some(l => l.startsWith(`CALL ice_applied cid=${ULIDS.heldCid} n=32`))).toBe(true);
    expect(
      out.some(l =>
        l.startsWith(
          `GCALL pending_drained from=${ULIDS.carol} cid=${ULIDS.heldCid} n=32 dropped=1`,
        ),
      ),
    ).toBe(true);
  });

  it('drops the buffer when the session ends — a later leg for that cid replays nothing', async () => {
    // The session dies while frames are buffered, and carol then rings US into
    // a NEW session reusing that cid. Only a buffer CLEARED at teardown makes
    // this silent: a cid check alone would let the dead session's frames into
    // the new leg.
    const { group } = makeGroupRunner();
    await ringWithHeldOffer(group);
    await group.onBody(ULIDS.carol, iceBody(ULIDS.heldCid, 2), Date.now());

    await group.decline();
    expect(group.live).toBe(false);
    out.length = 0;

    await group.onBody(
      ULIDS.carol,
      ginviteBody(ULIDS.sid2, ULIDS.heldCid, [ULIDS.carol, ULIDS.self]),
      Date.now(),
    );

    // The new session really did ring — the silence below is not vacuous.
    expect(out.some(l => l.startsWith(`GCALL ringing sid=${ULIDS.sid2}`))).toBe(true);
    expect(out.some(l => l.startsWith('CALL recv tcm=call.ice'))).toBe(false);
    expect(out.some(l => l.startsWith('CALL ice_applied'))).toBe(false);
    expect(out.some(l => l.startsWith('GCALL pending_drained'))).toBe(false);
  });

  /**
   * The same claim, in the shape the test above cannot reach: ONE apply().
   *
   * The teardown test swaps sessions across two inputs — decline, then ring —
   * so the sweep that runs at the end of the first apply has already emptied
   * the buffer before the second one opens a leg. Session glare needs no such
   * gap: `supersede` tears the loser down and rings the winner inside a SINGLE
   * reducer step, and the drain lives INSIDE the effect loop while the sweep
   * runs after it. A peer that reuses the dead session's cid therefore had its
   * own buffered terminal replayed into the leg the winner had just opened —
   * peer and cid both matched, and neither says which session they belonged
   * to. Hostile peers are in this gate's threat model, and reusing a cid costs
   * one nothing.
   */
  it('drops the buffer when a SINGLE apply swaps sessions — glare is not a gap', async () => {
    const { group } = makeGroupRunner();
    await ringWithHeldOffer(group);
    // Carol's terminal for her held cid outruns the leg it belongs to, and is
    // buffered against session A exactly as her ICE would be.
    await group.onBody(ULIDS.carol, endBody(ULIDS.heldCid, 'decline'), Date.now());
    out.length = 0;

    // …then carol wins session glare with a lower sid, REUSING that same cid.
    await group.onBody(
      ULIDS.carol,
      ginviteBody(ULIDS.lowSid, ULIDS.heldCid, [ULIDS.carol, ULIDS.self]),
      Date.now(),
    );
    // Let the leg's own reports finish landing on the chain before reading it.
    await new Promise(resolve => setTimeout(resolve, 0));

    // The winner really did ring, so the silence below is not vacuous.
    expect(group.live).toBe(true);
    expect(group.sid).toBe(ULIDS.lowSid);
    expect(out.some(l => l.startsWith(`GCALL ringing sid=${ULIDS.lowSid}`))).toBe(true);
    // Nothing of session A's reached session B's leg…
    expect(out.some(l => l.startsWith('GCALL pending_drained'))).toBe(false);
    expect(out.some(l => l.startsWith(`CALL recv tcm=call.end cid=${ULIDS.heldCid}`))).toBe(false);
    // …so the leg the winner opened is still ringing, not ended — and no call
    // row was logged for it — by a frame addressed to a session that no longer
    // exists. Scoped to the reused cid: the LOSER's own bob leg really does end
    // here, `glare_lost`, which is glare resolution working and not the bug.
    expect(out.some(l => l.startsWith(`CALL ended cid=${ULIDS.heldCid}`))).toBe(false);
    expect(out.some(l => l.startsWith(`CALL logged cid=${ULIDS.heldCid}`))).toBe(false);
    expect(group.snapshot().phase).toBe('ringing');
  });
});

// ---------------------------------------------------------------------------
/**
 * A departing peer's `call.end` and their `call.gleave` are two frames, and
 * NOTHING orders them. Both orders must leave the session usable.
 *
 * Written to test a hang: an e2e run wedged with `GCALL recv tcm=call.gleave`
 * as its last line, and the reading on the table was that the gleave's close
 * had run against an already-terminal leg and awaited something that had
 * already fired. THESE TESTS DISPROVE THAT. In the end-first order the
 * sovereign-leave branch emits NO effect at all — the leg is already terminal,
 * so there is no `closeLeg` to await and no `writeSessionRow` — and the apply
 * completes in milliseconds, as does a local leave dispatched after it.
 *
 * Which also means the two things that reading took for evidence are just the
 * correct behaviour of that branch: a missing `GCALL leg_closed`, and silence.
 * They are kept as ordering cover, and as the record of what was ruled out.
 */
describe('GC3: a peer`s end and their gleave, in either order', () => {
  /**
   * Bob rings us into a session that also names dave; dave's own leg offer is
   * held behind the ring and opens when we answer.
   *
   * Then it WAITS for the ICE rig, because the e2e's legs were `connected`
   * when dave left and a rig that skipped that is not the same session: a
   * connected leg has different timers, a `connectedAt`, and a different
   * answer from `maybeRelease`.
   */
  async function liveWithDave(group: GroupCallRunner): Promise<void> {
    const roster = [ULIDS.bob, ULIDS.self, ULIDS.dave];
    await group.onBody(ULIDS.bob, ginviteBody(ULIDS.sid, ULIDS.otherCid, roster), Date.now());
    await group.onBody(ULIDS.dave, ginviteBody(ULIDS.sid, ULIDS.daveCid, roster), Date.now());
    await group.answer();
    // ICE_CONNECTED_RIG_MS is 250 (group-call.ts); this clears it.
    await new Promise(resolve => setTimeout(resolve, 400));
    expect(group.snapshot().legs.every(l => l.phase === 'connected')).toBe(true);
  }

  it('completes the gleave when the leg ALREADY ended — end first, then gleave', async () => {
    const { group } = makeGroupRunner();
    await liveWithDave(group);
    const se = group.snapshot().se;
    expect(group.snapshot().legs.some(l => l.peerId === ULIDS.dave)).toBe(true);

    // Dave hangs up his leg. The 1:1 machine takes it all the way terminal.
    await within(
      2_000,
      'the call.end',
      group.onBody(ULIDS.dave, endBody(ULIDS.daveCid, 'hangup'), Date.now()),
    );
    expect(out.some(l => l.startsWith(`CALL ended cid=${ULIDS.daveCid}`))).toBe(true);
    out.length = 0;

    // …and only then does his gleave land.
    await within(
      2_000,
      'the gleave apply',
      group.onBody(ULIDS.dave, gleaveBody(ULIDS.sid, ULIDS.dave, se + 1), Date.now()),
    );

    // The apply ran to its end. Read off the SNAPSHOT, not off a log line:
    // the sovereign-leave branch emits no effect at all once the leg is
    // already terminal (no `closeLeg`, no `writeSessionRow`), so there is no
    // line to wait for — and `unannounce` is the one thing it does change.
    // The roster deliberately does NOT shrink on a sovereign leave: it is the
    // starter's assertion, so a returner is a join_leg and never a stranger.
    expect(group.snapshot().announced).not.toContain(ULIDS.dave);
    expect(group.snapshot().roster).toContain(ULIDS.dave);

    // …and the chain is still alive: a LATER input must still execute. This is
    // the half that matters, because the e2e's surviving clients went on to
    // miss their OWN scheduled leave — if an apply could strand the chain,
    // this is where it would show.
    out.length = 0;
    await within(2_000, 'a later local leave', group.leave());
    expect(out.some(l => l.startsWith('GCALL released'))).toBe(true);
  });

  it('still completes in the order the green runs took — gleave first, then end', async () => {
    // The control. This is the interleaving seven passing runs happened to
    // get, and it must stay working: the close acts on a LIVE leg here.
    const { group } = makeGroupRunner();
    await liveWithDave(group);
    const se = group.snapshot().se;
    out.length = 0;

    await within(
      2_000,
      'the gleave apply',
      group.onBody(ULIDS.dave, gleaveBody(ULIDS.sid, ULIDS.dave, se + 1), Date.now()),
    );
    expect(out.some(l => l.startsWith(`GCALL leg_closed to=${ULIDS.dave}`))).toBe(true);

    await within(
      2_000,
      'the late call.end',
      group.onBody(ULIDS.dave, endBody(ULIDS.daveCid, 'hangup'), Date.now()),
    );
    await within(2_000, 'a later local leave', group.leave());
    expect(out.some(l => l.startsWith('GCALL released'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
/**
 * A close prints its VERDICT before it prints its consequences.
 *
 * The executor awaits a send inside `closeLeg`, and `io.send` is an unbounded
 * await on the one send chain. With the line emitted last, a stalled request
 * erased the whole effect from the log — and the two hypotheses a reader then
 * has ("the effect never ran" vs "it ran and the send is wedged") are exactly
 * the ones a hung gate run needed told apart.
 */
describe('GC3: closeLeg reports its decision before it acts on it', () => {
  it('emits leg_closed even when the send never settles', async () => {
    const { group, send } = makeGroupRunner();
    await group.start([ULIDS.self, ULIDS.bob], false);
    // Faulted only now: dialling the session needs a transport that works.
    send.mode = 'stall';
    out.length = 0;

    // `leave` tears every leg down with announce=true, so the first thing the
    // executor does is the send that will never come back. Not awaited: that
    // is the point — this apply never finishes.
    void group.leave();
    // Let the effect loop reach its first await.
    await new Promise(resolve => setTimeout(resolve, 50));

    // The decision is on the record…
    expect(out.some(l => l.startsWith(`GCALL leg_closed to=${ULIDS.bob}`))).toBe(true);
    // …and the silence after it is what says the send is the thing that hung:
    // the close never completed, so nothing downstream of it ran.
    expect(out.some(l => l.startsWith('GCALL released'))).toBe(false);
    expect(out.some(l => l.startsWith('GCALL leg_close_send_failed'))).toBe(false);
  });

  it('gives a REFUSED send its own line, without restating the decision', async () => {
    const { group, send } = makeGroupRunner();
    await group.start([ULIDS.self, ULIDS.bob], false);
    send.mode = 'throw';
    out.length = 0;

    await group.leave();

    // Both lines, in order, each saying one thing.
    const closed = out.findIndex(l => l.startsWith(`GCALL leg_closed to=${ULIDS.bob}`));
    const failed = out.findIndex(l => l.startsWith('GCALL leg_close_send_failed'));
    expect(closed).toBeGreaterThanOrEqual(0);
    expect(failed).toBeGreaterThan(closed);
    // A lost announcement is not a failed teardown: the session still released.
    expect(out.some(l => l.startsWith('GCALL released'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
/**
 * `delta_sent n=… of=…` is a claim about the SERVER, not about this process.
 *
 * The gate reads `n == of` as "the roster delta reached everyone". It used to
 * count resolutions of the plain send, which resolves once the ciphertext has
 * been written to an open socket — and that write is void, callback-free and
 * reports nothing back (`WsClient.send`). So the number proved the fan-out had
 * been ATTEMPTED, and a server that took none of the frames still scored a
 * full house. The protocol does carry the missing fact: the server posts a
 * `receipt` frame per accepted send, keyed by the msgId we minted.
 */
describe('GC3: the roster fan-out counts SERVER-ACKED sends, not attempts', () => {
  it('does not count a send the server never acknowledged', async () => {
    const { group, sent } = makeGroupRunner({
      ackTo: peerId => (peerId === ULIDS.carol ? null : 'delivered'),
    });
    await group.start([ULIDS.self, ULIDS.bob, ULIDS.carol], false);
    out.length = 0;
    sent.length = 0;

    await group.addParticipant(ULIDS.stranger);

    // Two recipients, one acked — and `of` still says two, so the shortfall is
    // visible rather than hidden by a smaller denominator.
    expect(out.some(l => /^GCALL delta_sent .* n=1 d=1 of=2$/.test(l))).toBe(true);
    // The unacked frame WAS written: this counts receipts, it does not skip
    // sends. Anything else and the assertion above would pass for the wrong
    // reason.
    expect(sent.some(s => s.peerId === ULIDS.carol)).toBe(true);
  });

  it('counts every recipient when the server acknowledges every one — not vacuous', async () => {
    const { group } = makeGroupRunner();
    await group.start([ULIDS.self, ULIDS.bob, ULIDS.carol], false);
    out.length = 0;

    await group.addParticipant(ULIDS.stranger);

    expect(out.some(l => /^GCALL delta_sent .* n=2 d=2 of=2$/.test(l))).toBe(true);
  });

  /**
   * …AND `n` IS NOT A DELIVERY, which is the distinction the line publishes
   * `d` for.
   *
   * `ReceiptFrame.state` has carried `'sent' | 'delivered'` since the protocol
   * was written — `'sent'` means the server QUEUED the ciphertext because the
   * recipient is not on a socket, `'delivered'` means it wrote it to one that
   * is (handlers/ws.ts). `sendAcked` collapsed both into `true`, so a full
   * `n == of` said only that the SERVER took the frame, and a gate check read
   * it as "the participant was handed it" (an earlier review). With the
   * kinds kept apart, an offline recipient makes the
   * two counters differ, and each claim can stand on the number that is
   * actually about it.
   */
  it('separates "the server took it" from "it reached a live socket"', async () => {
    const { group } = makeGroupRunner({
      ackTo: peerId => (peerId === ULIDS.carol ? 'sent' : 'delivered'),
    });
    await group.start([ULIDS.self, ULIDS.bob, ULIDS.carol], false);
    out.length = 0;

    await group.addParticipant(ULIDS.stranger);

    // Both were accepted; only one reached a socket. A single boolean could
    // not have said this, and the old line would have read `n=2 of=2`.
    expect(out.some(l => /^GCALL delta_sent .* n=2 d=1 of=2$/.test(l))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
/**
 * REFUTED, and pinned so it stays refuted: the adversarial round claimed a
 * future unknown `call.*` kind reaches a parser before the namespace silences
 * it once a session runner is in front of the 1:1 one. It does not.
 * `parseGroupCallEnvelope` returns null for a kind outside its union,
 * `parseCallEnvelope` likewise, and the terminal is `CallRunner.onBody`, which
 * asks `isCallTransportBody` BEFORE parsing and returns silently. The claim is
 * an absence claim, so the test is the only thing that keeps it true.
 */
describe('GC3: an unknown call.* kind stays silent through the group runner too', () => {
  it('is transport, is silent, and reaches neither runner`s parser', async () => {
    const { group, fallback, sent } = makeGroupRunner();
    const handled = await group.onBody(ULIDS.bob, '{"tcm":"call.gfuture","x":1}', Date.now());
    expect(handled).toBe(true); // transport by namespace: never a chat row
    expect(out).toEqual([]);
    expect(sent).toEqual([]);
    expect(group.live).toBe(false);
    expect(fallback!.stateName).toBe('idle');
    expect(fallback!.recvIceEnvelopes.count).toBe(0);
  });

  it('says nothing with no 1:1 runner underneath either', async () => {
    const { group, sent } = makeGroupRunner({ withFallback: false });
    const handled = await group.onBody(ULIDS.bob, '{"tcm":"call.gfuture","x":1}', Date.now());
    expect(handled).toBe(true);
    expect(out).toEqual([]);
    expect(sent).toEqual([]);
    expect(group.live).toBe(false);
  });
});

// ---------------------------------------------------------------------------
/**
 * an earlier review: EVERY FRAME THE EFFECT EXECUTOR PUTS ON THE
 * WIRE NAMES ITS TRANSPORT ID.
 *
 * THE EFFECT EXECUTOR, not "the session" — narrowed in an earlier review,
 * because the heading over-claimed. `refuseBusy` (group-call.ts) is a THIRD
 * session-owned `io.send`, and it discards the msgId: it prints only
 * `GCALL busy from= cid=`. It is not an effect — it is answered straight out
 * of `onBody`, before any reducer dispatch, precisely because there is no leg
 * to send it from — so nothing below covers it and the heading must not say
 * otherwise.
 *
 * That is a documentation narrowing, NOT a hole in the containment sections,
 * for three independent reasons:
 *
 *   - it fires only on INBOUND traffic (a ginvite arriving while a 1:1 call is
 *     live, or a stray 1:1 offer while a session is live). The leak sections
 *     collect from the STARTER's log, and their recipient is deliberately not
 *     listening, so nothing arrives there to refuse;
 *   - the frame is `call.end{r:'busy'}` on the OFFERED cid — an ordinary 1:1
 *     envelope with no `sid` field at all — so a row of it outside the set
 *     could not carry the value those sections scan for;
 *   - it is addressed to whoever offered, and the collectors are scoped to the
 *     one recipient the section dialled.
 *
 * The code is therefore left alone. If a future section ever drives an inbound
 * refusal into a scanned queue, `refuseBusy` needs the same `msgid=` treatment
 * the two effects below got, and this list is the reason it does not have it
 * yet.
 *
 * the e2e group-call harness proves that no stored payload carries the
 * session's sid. It does that by collecting every row the server queued for
 * the recipient inside the section's window and scanning them — and, since
 * an earlier revision, by requiring that set to CONTAIN every msgId the sender printed.
 * That containment is only worth anything if the sender prints one for every
 * frame it sent.
 *
 * It did not. `CallRunner` prints `CALL sent … msgid=` for the frames it
 * composes (the ginvite among them, through the session seam), but the EFFECT
 * EXECUTOR sends two kinds of frame itself, straight down `io`:
 *
 *   - the per-leg `call.end` a teardown announces (`closeLeg`), and
 *   - the roster delta, `call.gleave` included (`sendRosterDelta`), whose
 *     envelope carries the sid this section proves nobody can see.
 *
 * Both reached the recipient's queue with nothing naming the row, so a scan could
 * capture the ginvite, miss the gleave, and scan a set that silently omitted a
 * stored payload holding the sid.
 *
 * The ids ride the SAME grammar check as every other id field (`ID_FIELD_KEYS`
 * in group-call.ts): a value that is not strict ULID prints as `redacted`, so
 * a future transport handing back something else cannot smuggle text onto a
 * machine line. That is asserted here rather than assumed.
 */
describe('GC3: the EFFECT executor names the transport id of the frames it sends itself', () => {
  it('a teardown announces its call.end AND the row it went out as', async () => {
    const { group, sent } = makeGroupRunner();
    await group.start([ULIDS.self, ULIDS.bob], false);
    out.length = 0;
    sent.length = 0;
    await group.leave();

    const ends = sent.filter(s => s.body.includes('"tcm":"call.end"'));
    expect(ends.length, 'the premise is missing — no call.end went out').toBeGreaterThan(0);
    const closes = out.filter(l => l.startsWith('GCALL leg_close_sent '));
    expect(
      closes.length,
      `a call.end reached the queue with nothing naming its row:\n${out.join('\n')}`,
    ).toBe(ends.length);
    for (const line of closes) {
      expect(line, 'the leg_close_sent line does not carry a well-formed msgid').toMatch(
        /^GCALL leg_close_sent to=[0-9A-HJKMNP-TV-Z]{26} cid=[0-9A-HJKMNP-TV-Z]{26} msgid=[0-9A-HJKMNP-TV-Z]{26}$/,
      );
    }
  });

  it('a roster delta names one row per recipient, beside the aggregate counts', async () => {
    const { group, sent } = makeGroupRunner();
    // Three participants, so the fan-out is genuinely a fan-out and a
    // per-recipient line cannot be confused with a per-delta one.
    await group.start([ULIDS.self, ULIDS.bob, ULIDS.carol], false);
    out.length = 0;
    sent.length = 0;
    await group.leave();

    const deltas = sent.filter(s => s.body.includes('"tcm":"call.gleave"'));
    expect(deltas.length, 'the premise is missing — no gleave went out').toBe(2);
    const frames = out.filter(l => l.startsWith('GCALL delta_frame '));
    expect(
      frames.length,
      `a stored gleave — which carries the sid — was never named:\n${out.join('\n')}`,
    ).toBe(2);
    for (const line of frames) {
      expect(line, 'the delta_frame line does not carry a well-formed msgid').toMatch(
        /^GCALL delta_frame tcm=call\.gleave sid=[0-9A-HJKMNP-TV-Z]{26} to=[0-9A-HJKMNP-TV-Z]{26} msgid=[0-9A-HJKMNP-TV-Z]{26}$/,
      );
    }
    // The recipients are named individually — not one line repeated.
    const recipients = frames.map(l => /to=([0-9A-HJKMNP-TV-Z]{26})/.exec(l)?.[1]);
    expect(new Set(recipients).size, 'the same recipient was named twice').toBe(2);
    // …and the aggregate line is untouched: two facts, two lines.
    expect(out.some(l => /^GCALL delta_sent tcm=call\.gleave .* n=2 d=2 of=2$/.test(l))).toBe(true);
  });

  it('redacts an id that is not strict ULID rather than printing it', async () => {
    // The grammar check, exercised through the two fields that are new. A
    // transport handing back something else — a rig, a future backend, a
    // hostile shim — must not get arbitrary text, or a forged machine line,
    // onto this program's stdout.
    const { group } = makeGroupRunner({ msgId: () => 'not a ulid\nGCALL forged sid=x' });
    await group.start([ULIDS.self, ULIDS.bob], false);
    out.length = 0;
    await group.leave();
    expect(out.some(l => l.includes('not a ulid')), out.join('\n')).toBe(false);
    expect(out.some(l => l.includes('GCALL forged'))).toBe(false);
    expect(
      out.filter(l => l.startsWith('GCALL leg_close_sent ') || l.startsWith('GCALL delta_frame ')),
      'the new lines were not emitted at all, so nothing was redacted',
    ).not.toEqual([]);
    for (const line of out.filter(
      l => l.startsWith('GCALL leg_close_sent ') || l.startsWith('GCALL delta_frame '),
    )) {
      expect(line).toMatch(/ msgid=redacted$/);
    }
  });
});
