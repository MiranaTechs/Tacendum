import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AttendConfig, OutSess, TypingChannel } from '../src/attend.js';
import type { HostDriver, TurnRequest } from '../src/attend-drivers.js';

/**
 * SAME-PROCESS SEALED EMISSIONS NEVER CONTEND ON THE RATCHET FILE LOCK — the
 * e2e stream gate's release blocker (scripts/e2e-stream.sh a8), pinned at unit
 * scale against the REAL lock.
 *
 * THE DEFECT THIS FILE EXISTS TO MAKE IMPOSSIBLE: the pass's one cadence loop
 * fires DETACHED sealed emits — a typing refresh and a stream edit can leave
 * on the SAME tick — and the pass's own durable sends (anchor, approval card,
 * turn-end reply, final edit) seal under the same `ratchetLockPath`. The file
 * lock's contended wait is SYNCHRONOUS (`Atomics.wait`, 25 ms polls, 10 s
 * budget — lock.ts owns the argument for why), so a second same-process
 * customer FREEZES the event loop the current holder needs to finish its own
 * awaited seal: same-process contention always burns the whole 10-second
 * budget, then throws, and the emit's catch kills the chatter channel for the
 * turn. Observed on the wire as: every streamed turn longer than the typing
 * refresh loses its edits after ~2, and attend freezes 10 s mid-turn.
 *
 * WHY EVERY SIBLING SUITE MISSED IT — the frozen-clock lesson applied to
 * locks: attend.typing.test.ts and attend.stream.test.ts fake the reply seam
 * and the typing channel with instantly-resolving functions that never touch
 * the lock, so two "concurrent" emissions could never collide. This file's
 * seams SEAL: every emission takes the account's real ratchet file lock via
 * the real `withFileLockAsync` and holds it across an awaited timer — the
 * exact shape of the real seal, which awaits `encryptText` under the lock —
 * so a second same-process customer reaching `acquire` while the first holds
 * reproduces the freeze, and the wall-time bounds below turn any single
 * 10-second burn red.
 *
 * WHAT GREEN PROVES (the fix's contract): every same-process sealed emission
 * for one account — typing refreshes, stream edits, the epilogue stop, and
 * every durable send the pass performs — rides ONE in-process FIFO queue, so
 * no two of them ever reach the file lock concurrently. The lock itself is
 * untouched (its cross-process job stands); ordering falls out of the FIFO:
 * anchor before the first edit, edits in seq order, the durable final after
 * the last intermediate.
 */

const home = mkdtempSync(join(tmpdir(), 'tacendum-attend-seal-'));
process.env.TACENDUM_HOME = home;
process.env.TACENDUM_API = 'http://attend-seal.test';
process.env.TACENDUM_WS = 'ws://attend-seal.test';

const seams = vi.hoisted(() => ({
  driver: null as HostDriver | null,
}));

vi.mock('../src/attend-drivers.js', async importOriginal => {
  const real = await importOriginal<typeof import('../src/attend-drivers.js')>();
  return {
    ...real,
    driverFor: (host: Parameters<typeof real.driverFor>[0]) =>
      seams.driver ?? real.driverFor(host),
  };
});

const { ATTEND_REPLY_CAP, attendOnce, saveAttendConfig } = await import('../src/attend.js');
const { withFileLockAsync } = await import('../src/lock.js');
const { FileStores } = await import('../src/stores.js');
const { MessageLog } = await import('../src/msglog.js');
const { saveProfile } = await import('../src/profile.js');
const { capChatHead, plainForChat } = await import('../src/hooks.js');

const OWNER = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const SELF = '01HQXW0000000000000000SEAL';
const OWN_SESSION = 'ffffffff-9999-4999-8999-999999999999';

let seq = 0;
const mid = (): string => `01HQXS00000000000000${String(++seq).padStart(6, '0')}`.slice(0, 26);

function inRow(text: string) {
  return {
    id: mid(),
    dir: 'in' as const,
    peer: OWNER,
    ts: Date.now(),
    tcm: '',
    text,
    read: false,
  };
}

async function poll(cond: () => boolean, ms = 15_000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error('poll timed out');
    await new Promise(r => setTimeout(r, 5));
  }
}

/** The moving clock (the frozen-clock ruling): 2 ms of real delay per fake
 * tick yields the loop so the test body — and the detached seals — can
 * interleave with a running pass, exactly as production's do. */
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

/**
 * THE SEALING HARNESS — the one thing no sibling fixture has: every emission
 * goes through the REAL `withFileLockAsync` on the account's REAL
 * `ratchetLockPath`, and holds the lock across an awaited timer (the real
 * seal awaits `encryptText` under the lock; an emission that never yields
 * inside the lock could not deadlock and would prove nothing).
 *
 * `acquired`/`done` record lock-section entry and emission completion in
 * order; `failures` counts seals the lock refused — on the unfixed code the
 * contended waiter burns 10 s and THROWS, so any failure here is the defect.
 */
const sealHarness = (holdMs: number) => {
  const lockPath = new FileStores('bot').ratchetLockPath();
  const acquired: string[] = [];
  const done: string[] = [];
  const failures: string[] = [];
  const seal = async (label: string): Promise<void> => {
    try {
      await withFileLockAsync(lockPath, async () => {
        acquired.push(label);
        await new Promise(r => setTimeout(r, holdMs));
      });
      done.push(label);
    } catch (err) {
      failures.push(`${label}: ${String((err as Error).message ?? err)}`);
      throw err;
    }
  };
  return { acquired, done, failures, seal };
};

/** The reply seam, sealing like the real one (`realSendReply` seals under the
 * ratchet lock inside `sendEncrypted`), then recording body + notify. */
const sealingSend = (h: ReturnType<typeof sealHarness>) => {
  const sends: { body: string; id: string; notify?: false }[] = [];
  return {
    sends,
    sendReply: async (
      b: string,
      _sess?: OutSess,
      opts?: { notify?: boolean },
    ): Promise<string> => {
      const label = b.startsWith('{"tcm":"edit"') ? 'send:final' : `send:${sends.length}`;
      await h.seal(label);
      const id = mid();
      sends.push({ body: b, id, ...(opts?.notify === false ? { notify: false as const } : {}) });
      return id;
    },
  };
};

/** The typing seam, sealing like the real one (`realTypingChannel`'s emit
 * seals under the same ratchet lock before framing). */
const sealingTyping = (h: ReturnType<typeof sealHarness>) => {
  const events: string[] = [];
  const edits: { seq: number }[] = [];
  return {
    events,
    edits,
    factory: (_to: string): TypingChannel => ({
      send: async (state: 'start' | 'stop'): Promise<void> => {
        await h.seal(`typing:${state}`);
        events.push(state);
      },
      edit: async (body: string): Promise<void> => {
        const e = JSON.parse(body) as { seq: number };
        await h.seal(`edit:${e.seq}`);
        edits.push({ seq: e.seq });
      },
      close: (): void => {},
    }),
  };
};

/** A held driver whose snapshots the TEST pushes through the captured
 * `req.stream` — attend.stream.test.ts's exact fixture shape. */
const heldDriver = (reply: string) => {
  let stream: ((s: string) => void) | undefined;
  let release: (() => void) | undefined;
  const released = new Promise<void>(r => {
    release = r;
  });
  const driver: HostDriver = {
    host: 'codex',
    async runTurn(req: TurnRequest) {
      stream = req.stream;
      // The real driver surfaces the steer call — and the thread key with
      // it — before the first delta; the anchor's sess gate
      // waits for that key, so the fake honours the same wire order.
      req.steering?.({
        sessionKey: 'e2e00000-0000-4000-8000-00000000c0de',
        steer: async () => 'delivered' as const,
      });
      await released;
      return { stdout: reply, stderr: '', code: 0, refusal: null };
    },
  };
  return {
    driver,
    push: (s: string): void => stream?.(s),
    finish: () => release?.(),
  };
};

const cfg = (over: Partial<AttendConfig> = {}): void =>
  saveAttendConfig('bot', {
    host: 'codex',
    bin: '/opt/codex',
    workdir: '/w',
    caps: ['-s', 'read-only'],
    codexDriver: 'app-server',
    ownSession: OWN_SESSION,
    turnsPerHour: 10,
    ...over,
  });

const funnel = (text: string): string => capChatHead(plainForChat(text), ATTEND_REPLY_CAP);

beforeEach(() => {
  rmSync(join(home, 'bot'), { recursive: true, force: true });
  rmSync(join(home, 'state'), { recursive: true, force: true });
  seq = 0;
  seams.driver = null;
  saveProfile({
    name: 'bot', identityKey: 'AAAA', userId: SELF,
    deviceId: 1, authToken: 'tok', registrationId: 1,
    accountClass: 'integration', ownerUserId: OWNER,
  });
});

describe('same-process sealed emissions on the real ratchet lock (the e2e gate a8 regression)', () => {
  it(
    'a streamed turn: typing refreshes, edits, anchor and final all seal without a 10 s burn, in order',
    { timeout: 60_000 },
    async () => {
      cfg({ streamMinAppBuild: 42 });
      new MessageLog('bot').append(inRow('stream please'));
      const h = sealHarness(40);
      const send = sealingSend(h);
      const typing = sealingTyping(h);
      const final = 'R alpha bravo charlie delta echo foxtrot golf hotel india';
      const fake = heldDriver(final);
      seams.driver = fake.driver;

      const t0 = Date.now();
      const pass = attendOnce('bot', {
        ...clockIo(),
        sendReply: send.sendReply,
        typing: typing.factory,
      });

      try {
        // The collision the gate caught, reproduced deliberately: the FIRST
        // cadence tick fires the detached typing start, and the first snapshot
        // makes the same loop await the durable anchor seal while that start
        // still holds the real lock. On the unfixed code the anchor's acquire
        // freezes the event loop for its whole 10 s budget, throws, and the
        // stream stands down for the turn — no anchor, no edits, red below.
        fake.push('R alpha');
        await poll(() => send.sends.length >= 1);
        // Five distinct snapshots across ticks: enough for the typing refresh
        // (7 500 ms fake, every 4th tick) to land beside a detached edit —
        // the gate's exact same-tick pairing — several times over.
        for (let i = 1; i <= 5; i++) {
          fake.push(final.split(' ').slice(0, 2 + i).join(' '));
          await poll(() => typing.edits.length >= i);
        }
      } finally {
        // Unwind even on a red: a held driver must not outlive its test.
        fake.finish();
        await pass.catch(() => {});
      }
      const elapsed = Date.now() - t0;

      // No seal ever burned the lock's contended budget: one 10 s freeze
      // anywhere blows this bound on its own.
      expect(h.failures).toEqual([]);
      expect(elapsed).toBeLessThan(5_000);

      // Exactly two durables — the anchor and the notify:false final on it.
      expect(send.sends.length).toBe(2);
      const [anchor, fin] = send.sends;
      expect(anchor?.body).toBe(funnel('R alpha'));
      expect(fin?.notify).toBe(false);
      expect(JSON.parse(fin?.body ?? '{}')).toEqual({
        tcm: 'edit',
        ref: anchor?.id,
        text: funnel(final),
        // The Art. 50 marker: envelope bodies are marked ungated.
        ai: true,
      });

      // The cadence survived whole: every pushed change produced its edit,
      // seq strictly increasing (a8's shape — chatter never died mid-turn).
      expect(typing.edits.length).toBe(5);
      expect(typing.edits.map(e => e.seq)).toEqual([1, 2, 3, 4, 5]);

      // ORDER, off the lock sections themselves: the anchor sealed before
      // the first edit, edits sealed in seq order, and the durable final
      // sealed after the LAST intermediate — the FIFO's whole contract.
      const anchorAt = h.done.indexOf('send:0');
      const finalAt = h.done.indexOf('send:final');
      const editAts = [1, 2, 3, 4, 5].map(n => h.done.indexOf(`edit:${n}`));
      expect(anchorAt).toBeGreaterThanOrEqual(0);
      expect(finalAt).toBeGreaterThanOrEqual(0);
      for (const at of editAts) expect(at).toBeGreaterThan(anchorAt);
      expect([...editAts].sort((a, b) => a - b)).toEqual(editAts);
      expect(finalAt).toBeGreaterThan(editAts[editAts.length - 1] as number);

      // The typing channel outlived the collisions: the initial start plus
      // at least one 7.5 s refresh — on the unfixed code the first burn's
      // throw would have been the channel's last word.
      expect(typing.events.filter(e => e === 'start').length).toBeGreaterThanOrEqual(2);
    },
  );

  it(
    'the pre-existing shadow: a detached typing emit in flight never stalls an in-flight durable send',
    { timeout: 60_000 },
    async () => {
      // No attestation: no stream lane at all — this is the shadow that
      // predates streaming, a typing refresh's seal racing the turn-end reply's.
      cfg();
      new MessageLog('bot').append(inRow('just answer'));
      const h = sealHarness(300);
      const send = sealingSend(h);
      const typing = sealingTyping(h);
      const fake = heldDriver('the answer');
      seams.driver = fake.driver;

      const pass = attendOnce('bot', {
        ...clockIo(),
        sendReply: send.sendReply,
        typing: typing.factory,
      });

      // Wait until the detached typing start is INSIDE the real lock, then
      // end the turn: the turn-end reply's seal now arrives while the lock
      // is provably held by this same process.
      let tFinish = 0;
      try {
        await poll(() => h.acquired.includes('typing:start'));
      } finally {
        // Unwind even on a red: a held driver must not outlive its test.
        tFinish = Date.now();
        fake.finish();
        await pass;
      }
      const afterFinish = Date.now() - tFinish;

      // The reply queued behind the ~300 ms hold instead of burning the
      // lock's 10 s contended budget — and it still went out.
      expect(h.failures).toEqual([]);
      expect(afterFinish).toBeLessThan(2_500);
      expect(send.sends.map(s => s.body)).toContain(funnel('the answer'));
      // FIFO: the typing emission's lock section completed before the
      // reply's began.
      expect(h.done.indexOf('typing:start')).toBeLessThan(h.done.indexOf('send:0'));
    },
  );

  it(
    'drain-before-return (review F4a): a queued emit never seals after the pass’s last durable send returns',
    { timeout: 60_000 },
    async () => {
      // THE PROPERTY THE ROOM-FANOUT EXCEPTION LEANS ON (the enqueueSealed
      // doc holds the three-legged argument): the pass's turn-end durable
      // send is awaited THROUGH the FIFO, so a detached emit still in its
      // lock section when the turn ends is provably drained before the pass
      // returns — the next pass's direct room fan-out can never meet a live
      // same-process straggler on the ratchet lock.
      cfg({ streamMinAppBuild: 42 });
      new MessageLog('bot').append(inRow('stream please'));
      const h = sealHarness(150);
      const send = sealingSend(h);
      const typing = sealingTyping(h);
      const fake = heldDriver('R alpha bravo — the finished answer');
      seams.driver = fake.driver;

      const pass = attendOnce('bot', {
        ...clockIo(),
        sendReply: send.sendReply,
        typing: typing.factory,
      });

      try {
        fake.push('R alpha');
        await poll(() => send.sends.length >= 1); // the anchor sealed
        fake.push('R alpha bravo');
        // Wait until the DETACHED edit is INSIDE the real lock's section —
        // a straggler by construction — then end the turn immediately.
        await poll(() => h.acquired.includes('edit:1'));
      } finally {
        fake.finish();
        await pass.catch(() => {});
      }

      expect(h.failures).toEqual([]);
      // The straggling edit sealed BEFORE the durable final did — the FIFO
      // put the awaited turn-end send behind it, which is the drain.
      const editAt = h.done.indexOf('edit:1');
      const finalAt = h.done.indexOf('send:final');
      expect(editAt).toBeGreaterThanOrEqual(0);
      expect(finalAt).toBeGreaterThanOrEqual(0);
      expect(editAt).toBeLessThan(finalAt);
      // And the final is the queue's LAST word: when the pass has returned,
      // nothing is still waiting to seal — give real time for any straggler
      // to surface, then hold the ledger of lock sections unchanged.
      expect(h.done[h.done.length - 1]).toBe('send:final');
      const sealedAtReturn = h.done.length;
      await new Promise(r => setTimeout(r, 600));
      expect(h.done.length).toBe(sealedAtReturn);
    },
  );
});
