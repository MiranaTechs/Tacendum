import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CALL_CONNECT_TIMEOUT_MS,
  MAX_ICE_CANDIDATES_PER_ENVELOPE,
  parseCallEnvelope,
  type CallEnvelope,
} from '@tacendum/shared';
import { CallRunner, fixtureCandidate, fixtureSdp, type CallLogRow } from '../src/call.js';

/**
 * Unit cover for the CLI call runner.
 *
 * the e2e call harness proves the same behaviours through a real server and a
 * real ratchet, which is the gate that matters. These exist because that gate
 * takes minutes and needs Docker, and the properties below are the ones most
 * likely to be broken by an innocent edit — batching arithmetic and the
 * refusal to ring for things that are not calls.
 */

interface Sent {
  peerId: string;
  body: string;
  urgent: boolean;
}

function makeRunner(): { runner: CallRunner; sent: Sent[]; logs: CallLogRow[]; now: () => number } {
  const sent: Sent[] = [];
  const logs: CallLogRow[] = [];
  const clock = 1_800_000_000_000;
  const now = (): number => clock;
  const runner = new CallRunner(
    {
      send: async (peerId, body, urgent) => {
        sent.push({ peerId, body, urgent });
        return 'msgid';
      },
      writeLog: row => {
        logs.push(row);
      },
      now,
    },
    'tester',
  );
  return { runner, sent, logs, now };
}

function envelopesOf(sent: Sent[], tcm: string): CallEnvelope[] {
  return sent
    .map(s => parseCallEnvelope(s.body))
    .filter((e): e is CallEnvelope => e !== null && e.tcm === tcm);
}

describe('the offer that goes on the wire', () => {
  it('carries a filled SDP, never the reducer template', () => {
    // The reducer emits `sdp: ''` as a TEMPLATE because it cannot know an SDP.
    // An empty SDP on the wire is a call the peer can never connect, so the
    // executor filling it is load-bearing rather than cosmetic.
    const { runner, sent } = makeRunner();
    return runner.placeCall('peer-1', false).then(() => {
      const offers = envelopesOf(sent, 'call.offer');
      expect(offers).toHaveLength(1);
      const offer = offers[0]!;
      expect(offer.tcm === 'call.offer' && offer.sdp.length).toBeGreaterThan(0);
      expect(offer.tcm === 'call.offer' && offer.sdp).toContain('a=fingerprint:sha-256');
    });
  });

  it('is sent urgent, because it is the frame that wakes a sleeping phone', async () => {
    const { runner, sent } = makeRunner();
    await runner.placeCall('peer-1', false);
    const offer = sent.find(s => s.body.includes('"call.offer"'));
    expect(offer?.urgent).toBe(true);
  });

  it('keeps the four security-relevant lines', () => {
    const sdp = fixtureSdp('offer', 'MARKER123');
    for (const line of ['a=fingerprint:', 'a=setup:', 'a=ice-ufrag:', 'a=ice-pwd:']) {
      expect(sdp).toContain(line);
    }
  });

  it('embeds a canary only when one is asked for', () => {
    expect(fixtureSdp('offer', 'M')).not.toContain('x-tacendum-canary');
    expect(fixtureSdp('offer', 'M', 'SECRET')).toContain('a=x-tacendum-canary:SECRET');
  });
});

describe('ICE batching', () => {
  beforeEach(() => vi.useFakeTimers());
  // Without the restore, fake timers LEAKED into every later test in this
  // file — anything awaiting a real setImmediate/setTimeout after this block
  // hung until the suite timeout.
  afterEach(() => vi.useRealTimers());

  it('packs 12 candidates into 2 envelopes, not 12', async () => {
    // Twelve envelopes would be twelve ratchet operations and
    // twelve pushes for one call's worth of connectivity.
    const { runner, sent } = makeRunner();
    await runner.placeCall('peer-1', false);
    for (let i = 0; i < 12; i++) runner.queueIce(fixtureCandidate(i));
    await vi.advanceTimersByTimeAsync(500);
    await runner.flushIce();

    const ice = envelopesOf(sent, 'call.ice');
    expect(ice.length).toBeLessThanOrEqual(2);
    const total = ice.reduce((n, e) => n + (e.tcm === 'call.ice' ? e.c.length : 0), 0);
    expect(total).toBe(12);
  });

  it('never exceeds the per-envelope cap', async () => {
    const { runner, sent } = makeRunner();
    await runner.placeCall('peer-1', false);
    for (let i = 0; i < 35; i++) runner.queueIce(fixtureCandidate(i));
    await vi.advanceTimersByTimeAsync(500);
    await runner.flushIce();

    for (const e of envelopesOf(sent, 'call.ice')) {
      if (e.tcm === 'call.ice') {
        expect(e.c.length).toBeLessThanOrEqual(MAX_ICE_CANDIDATES_PER_ENVELOPE);
      }
    }
  });

  it('sends nothing when there is no call', async () => {
    // Candidates arriving after teardown must not resurrect a dead cid.
    const { runner, sent } = makeRunner();
    runner.queueIce(fixtureCandidate(0));
    await vi.advanceTimersByTimeAsync(500);
    await runner.flushIce();
    expect(sent).toHaveLength(0);
  });
});

describe('the receive path announces each envelope exactly once', () => {
  it('emits one recv line per envelope, not one per code path', async () => {
    // REGRESSION: two edits each inserted the announcement, so every inbound
    // envelope logged twice. Harmless-looking, except the acceptance gate
    // counts those lines to check ICE batching — a duplicate would have made
    // 12 candidates in 2 envelopes read as 4, and the check would have failed
    // against perfectly correct batching.
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation(l => void lines.push(String(l)));
    try {
      const { runner, now } = makeRunner();
      await runner.onBody(
        'peer-1',
        JSON.stringify({
          tcm: 'call.offer',
          cid: '01J0000000000000000000000B',
          sdp: fixtureSdp('offer', 'once'),
          vid: false,
          exp: now() + 60_000,
        }),
        now(),
      );
      runner.dispose();
    } finally {
      spy.mockRestore();
    }
    const recv = lines.filter(l => l.startsWith('CALL recv '));
    expect(recv).toHaveLength(1);
  });
});

describe('bodies that are not calls', () => {
  it('leaves a plain chat message alone', async () => {
    const { runner } = makeRunner();
    expect(await runner.onBody('peer-1', 'hello there', Date.now())).toBe(false);
  });

  it('claims an unknown tcm without ringing or crashing', async () => {
    // It returns true — it IS a structured envelope, so it must
    // not fall through and render as chat — but nothing rings.
    const { runner, sent, logs } = makeRunner();
    const handled = await runner.onBody(
      'peer-1',
      '{"tcm":"call.future","cid":"01J0000000000000000000000B"}',
      Date.now(),
    );
    expect(handled).toBe(true);
    expect(runner.stateName).toBe('idle');
    expect(sent).toHaveLength(0);
    expect(logs).toHaveLength(0);
  });

  it('does the same for an envelope that is malformed rather than unknown', async () => {
    const { runner, logs } = makeRunner();
    // Right tcm, missing everything else.
    expect(await runner.onBody('peer-1', '{"tcm":"call.offer"}', Date.now())).toBe(true);
    expect(runner.stateName).toBe('idle');
    expect(logs).toHaveLength(0);
  });
});

describe('a send failure on the call path never becomes an unhandled rejection', () => {
  // Two channels in this file discard a promise with `void` (or hand one to
  // setTimeout): the ICE batcher in `queueIce`, and the timer expiries in
  // `run('startTimer')`. A send against a closed socket now REJECTS
  // instead of dissolving into false success, so either channel rejecting is
  // an unhandled rejection — Node kills the process, and a `listen --calls`
  // daemon dies mid-call. These tests pin the containment: the failure is
  // REPORTED on the CALL log and the runner survives.

  function makeFailableRunner(): {
    runner: CallRunner;
    sent: Sent[];
    io: { fail: boolean };
  } {
    const sent: Sent[] = [];
    const io = { fail: false };
    const runner = new CallRunner(
      {
        send: async (peerId, body, urgent) => {
          if (io.fail) throw new Error('socket closed');
          sent.push({ peerId, body, urgent });
          return 'msgid';
        },
        writeLog: () => {},
        now: () => Date.now(),
      },
      'tester',
    );
    return { runner, sent, io };
  }

  it('a refused ICE batch is reported and dropped — trickle is best-effort', async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation(l => void lines.push(String(l)));
    try {
      const { runner, sent, io } = makeFailableRunner();
      await runner.placeCall('peer-1', false);
      io.fail = true;
      // A full envelope's worth: the MAX-th candidate takes the immediate
      // `void this.flushIce()` path in queueIce — the exact discarded promise.
      for (let i = 0; i < MAX_ICE_CANDIDATES_PER_ENVELOPE; i++) {
        runner.queueIce(fixtureCandidate(i));
      }
      await new Promise(resolve => setImmediate(resolve));
      expect(lines.filter(l => l.startsWith('CALL ice_send_failed ')).length).toBe(1);
      expect(lines.some(l => l.startsWith('CALL ice_sent '))).toBe(false);

      // And an awaited flush against the dead transport resolves rather than
      // rejecting — the same containment, observable from the caller's side.
      runner.queueIce(fixtureCandidate(90));
      await expect(runner.flushIce()).resolves.toBeUndefined();

      // The failure is contained to the lost batches: the call is still live,
      // and once the transport recovers the next candidate goes out.
      io.fail = false;
      runner.queueIce(fixtureCandidate(91));
      await runner.flushIce();
      expect(envelopesOf(sent, 'call.ice')).toHaveLength(1);
      runner.dispose();
    } finally {
      spy.mockRestore();
    }
  });

  it('a timer expiry whose call.end cannot be sent degrades and completes the teardown', async () => {
    // This used to assert `CALL timer_failed`: the expiry's `call.end` send
    // rethrew, the timer catch reported it, and — the part nobody asserted —
    // every teardown effect AFTER the send was skipped. `call.end` is not in
    // FATAL_TO_SEND (the app's set, mirrored in call.ts for a group-call review
    // finding): we are ending regardless, so the send failure degrades to
    // its `send_failed` line, the teardown runs to completion, and the runner
    // collapses back to idle instead of stranding in `ending`.
    // The property this test has always guarded — a timer-driven step must
    // never become an unhandled rejection — now holds without the timer
    // catch even firing, which is the stronger form of it.
    vi.useFakeTimers();
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation(l => void lines.push(String(l)));
    try {
      const { runner, io } = makeFailableRunner();
      // The offer goes out fine; the socket dies while outgoing_connecting.
      await runner.placeCall('peer-1', false);
      io.fail = true;
      // Past CALL_CONNECT_TIMEOUT_MS: connectTimeout fires from the timer
      // callback, where no caller is awaiting the step.
      await vi.advanceTimersByTimeAsync(CALL_CONNECT_TIMEOUT_MS + 1_000);
      // Let the send's promise chain settle.
      for (let i = 0; i < 10; i++) await Promise.resolve();
      expect(
        lines.some(l => l.startsWith('CALL send_failed ') && l.includes('tcm=call.end')),
      ).toBe(true);
      // The teardown was NOT hostage to the failed announce: the terminal
      // report ran and the machine is idle again, not camped in `ending`.
      expect(lines.some(l => l.startsWith('CALL ended '))).toBe(true);
      expect(runner.stateName).toBe('idle');
      // And nothing rethrew into the timer catch: no failure line beyond the
      // send's own.
      expect(lines.some(l => l.startsWith('CALL timer_failed '))).toBe(false);
      runner.dispose();
    } finally {
      spy.mockRestore();
      vi.useRealTimers();
    }
  });
});

describe('a stale invite', () => {
  it('writes a missed row and never rings', async () => {
    // Ringing for a call that ended an hour ago is the one
    // thing the receive path must never do.
    const { runner, logs, now } = makeRunner();
    const handled = await runner.onBody(
      'peer-1',
      JSON.stringify({
        tcm: 'call.offer',
        cid: '01J0000000000000000000000B',
        sdp: fixtureSdp('offer', 'stale'),
        vid: false,
        exp: now() - 600_000,
      }),
      now() - 600_000,
    );
    expect(handled).toBe(true);
    expect(runner.stateName).toBe('idle');
    expect(logs).toHaveLength(1);
    expect(logs[0]!.reason).toBe('expired');
    expect(logs[0]!.missed).toBe(true);
  });
});
