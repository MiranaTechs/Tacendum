/**
 * the design plan:
 * the calls listener a supervisor keeps alive overnight.
 *
 * Two properties, proven in-process against the real CallSession with a
 * readyState-faithful ws mock (the gate.call-socket-liveness idiom; real
 * libsignal crypto where an envelope matters):
 *
 *  - R3a — `--seconds 0` is UNBOUNDED: no timer ends the run. The old
 *    default (30 s) passing must settle nothing.
 *  - R3b — the socket closing ENDS the run promptly, surfaced to the caller
 *    as a promise (`waitForSocketClose`), NOT as a `process.exit` inside
 *    CallSession — the bounded/timed path (tests, the e2e call harness) legitimately
 *    outlives a close and must keep doing so. The command layer alone turns
 *    the close code into an exit; the supervisor's 60 s restart throttle is
 *    the reconnect.
 *
 * Plus the mode the reviewer peer actually runs: `--auto-decline` still
 * declines an inbound offer — and handling that call does NOT end the
 * unbounded run.
 *
 * Sabotage handles (each verified red during development): settle the close
 * promise from anywhere but the socket's close event (test 1); drop the
 * onClose registration in connect() (test 2 and 4's tail); call
 * `process.exit` from the session's close handling (test 3, and the whole
 * file dies with it — which is the point); break the autoDecline pass-through
 * or its `incoming_ringing` guard (test 4).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { monotonicFactory } from 'ulid';
import type { PrekeyBundle, ServerFrame } from '@tacendum/shared';

const { sockets } = vi.hoisted(() => ({
  sockets: [] as Array<{
    readyState: number;
    handlers: Record<string, Array<(...a: unknown[]) => void>>;
    sent: string[];
    forceClose(code: number): void;
  }>,
}));

vi.mock('ws', () => {
  // readyState-faithful (OPEN=1/CLOSED=3, static OPEN), because liveness is
  // half of what is under test: sendEncrypted asks isOpen(), and forceClose
  // is the 1006 the overnight peer will actually meet.
  class FakeWebSocket {
    static readonly OPEN = 1;
    readyState = 0;
    handlers: Record<string, Array<(...a: unknown[]) => void>> = {};
    sent: string[] = [];
    constructor(_url: string) {
      sockets.push(this);
      setTimeout(() => {
        this.readyState = 1;
        for (const h of this.handlers.open ?? []) h();
      }, 0);
    }
    on(event: string, cb: (...a: unknown[]) => void) {
      (this.handlers[event] ??= []).push(cb);
      return this;
    }
    off(event: string, cb: (...a: unknown[]) => void) {
      this.handlers[event] = (this.handlers[event] ?? []).filter(h => h !== cb);
      return this;
    }
    removeAllListeners() {
      this.handlers = {};
      return this;
    }
    close() {}
    forceClose(code: number) {
      this.readyState = 3;
      for (const h of this.handlers.close ?? []) h(code);
    }
    send(data: string) {
      if (this.readyState === 1) this.sent.push(data);
    }
  }
  return { default: FakeWebSocket };
});

// Set BEFORE the src imports: config.ts snapshots the env at module evaluation.
const home = mkdtempSync(join(tmpdir(), 'tacendum-unbounded-'));
const previousHome = process.env.TACENDUM_HOME;
const previousApi = process.env.TACENDUM_API;
process.env.TACENDUM_HOME = home;
process.env.TACENDUM_API = 'http://unbounded.test';

const { FileStores } = await import('../src/stores.js');
const { generateAndStoreKeys, establishSession, encryptText, decryptEnvelope } = await import(
  '../src/messaging.js'
);
const { CallSession } = await import('../src/call-session.js');
const { fixtureSdp } = await import('../src/call.js');
const { saveProfile } = await import('../src/profile.js');

const ulid = monotonicFactory();
const realFetch = globalThis.fetch;

const BOT = 'unbounded-bot';
const BOT_ID = `01${'BDGATE0X'.repeat(3)}`;
const PEER_ID = `01${'PRGATE0Y'.repeat(3)}`;

/** The default `--seconds` the timed mode has always had (main.ts). If this
 * drifts there, the "outlasts the old default" claim below weakens silently —
 * duplicated on purpose so the test cannot read the rule off the code. */
const OLD_DEFAULT_MS = 30_000;

let peerStores: InstanceType<typeof FileStores>;
let botUpload: Awaited<ReturnType<typeof generateAndStoreKeys>>;

beforeAll(async () => {
  const botStores = new FileStores(BOT);
  botUpload = await generateAndStoreKeys(botStores);
  saveProfile({
    name: BOT,
    identityKey: botUpload.identityKey,
    userId: BOT_ID,
    authToken: 'live-unbounded-bot',
    registrationId: botUpload.registrationId,
    deviceId: 1,
  });
  peerStores = new FileStores('unbounded-peer');
  await generateAndStoreKeys(peerStores);

  globalThis.fetch = (async (input: string | URL | Request) => {
    const path = String(input).replace('http://unbounded.test', '');
    if (path === '/v1/ws-ticket') {
      return new Response(JSON.stringify({ ticket: 'tkt', expiresAt: 1 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    // A prekey-bundle fetch here would mean the decline rode a fresh session
    // instead of the one the offer itself established — fail loudly.
    throw new Error(`unexpected request ${path}`);
  }) as typeof fetch;
}, 30_000);

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

afterAll(() => {
  globalThis.fetch = realFetch;
  if (previousHome === undefined) delete process.env.TACENDUM_HOME;
  else process.env.TACENDUM_HOME = previousHome;
  if (previousApi === undefined) delete process.env.TACENDUM_API;
  else process.env.TACENDUM_API = previousApi;
});

function currentSocket(): (typeof sockets)[number] {
  const socket = sockets.at(-1);
  if (!socket) throw new Error('no socket dialled');
  return socket;
}

function deliver(socket: (typeof sockets)[number], frame: ServerFrame): void {
  for (const h of socket.handlers.message ?? []) h(JSON.stringify(frame));
}

/** Attach a settlement probe BEFORE the events under test, so "still pending"
 * is a fact about the promise, not about when `.then` ran. */
function probeClose(
  session: InstanceType<typeof CallSession>,
): { get: () => number | null } {
  let code: number | null = null;
  void session.waitForSocketClose().then(c => {
    code = c;
  });
  return { get: () => code };
}

describe('the unbounded calls listener', () => {
  it('R3a: no timer ends the run — the old 30s default passes and nothing settles', async () => {
    const session = new CallSession(BOT);
    try {
      await session.connect();
      const closed = probeClose(session);

      // Fake timers AFTER connect (the dial's open/settle need real ones).
      // Eight hours is an overnight shift, not a margin over 30s.
      vi.useFakeTimers();
      await vi.advanceTimersByTimeAsync(OLD_DEFAULT_MS);
      expect(closed.get()).toBeNull();
      await vi.advanceTimersByTimeAsync(8 * 60 * 60 * 1000);
      expect(closed.get()).toBeNull();
      vi.useRealTimers();

      // Teardown doubles as the check that the promise CAN still settle.
      currentSocket().forceClose(1001);
      await expect(session.waitForSocketClose()).resolves.toBe(1001);
    } finally {
      session.close();
    }
  });

  it('R3b: a socket close settles the unbounded wait promptly, with the close code', async () => {
    const session = new CallSession(BOT);
    try {
      await session.connect();
      const wait = session.waitForSocketClose();
      currentSocket().forceClose(1006);

      let guard: NodeJS.Timeout | undefined;
      try {
        const code = await Promise.race([
          wait,
          new Promise<never>((_, reject) => {
            guard = setTimeout(() => reject(new Error('close did not settle within 1s')), 1000);
          }),
        ]);
        expect(code).toBe(1006);
      } finally {
        clearTimeout(guard);
      }
    } finally {
      session.close();
    }
  });

  it('R3b boundary: a close is surfaced, never an exit — the bounded path outlives it', async () => {
    // The naive fix (cmdListen's `process.exit` moved into CallSession) would
    // kill the timed callers the e2e call harness depends on. This spy makes that
    // sabotage a loud red instead of a dead vitest worker.
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${String(code)}) called from session close handling`);
    }) as never);

    const session = new CallSession(BOT);
    try {
      await session.connect();
      currentSocket().forceClose(1006);
      // What runTimed's tail still does after a mid-run close: the scheduled
      // no-op leave resolves, and the command's finally closes the session.
      await session.leaveGroup();
      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      session.close();
    }
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('auto-decline still declines — and handling the call does not end the unbounded run', async () => {
    const session = new CallSession(BOT, { autoDecline: true });
    try {
      await session.connect();
      const socket = currentSocket();
      const closed = probeClose(session);

      // A real ratcheted offer from the peer: first contact, prekey envelope.
      const botBundle: PrekeyBundle = {
        userId: BOT_ID,
        registrationId: botUpload.registrationId,
        identityKey: botUpload.identityKey,
        signedPrekey: botUpload.signedPrekey,
        kyberPrekey: botUpload.kyberPrekey,
        oneTimePrekey: botUpload.oneTimePrekeys[0],
      };
      await establishSession(peerStores, PEER_ID, botBundle);
      const cid = '01J0000000000000000000000B';
      const { msgType, payload } = await encryptText(
        peerStores,
        PEER_ID,
        BOT_ID,
        JSON.stringify({
          tcm: 'call.offer',
          cid,
          sdp: fixtureSdp('offer', 'declineme'),
          vid: false,
          exp: Date.now() + 60_000,
        }),
      );
      deliver(socket, { type: 'msg', from: PEER_ID, msgId: ulid(), msgType, payload, ts: Date.now() });

      // The decline must LEAVE THE MACHINE: an encrypted envelope to the
      // peer, readable by the peer as call.end/decline — the clean declined
      // state the reviewer's phone shows, not a ring that rots. Wait for the
      // wire frame first, decrypt ONCE outside the retry loop: a ratcheted
      // envelope cannot be decrypted twice.
      const sendsTo = (): { type: string; to?: string; msgType?: string; payload?: string }[] =>
        socket.sent
          .map(f => JSON.parse(f) as { type: string; to?: string; msgType?: string; payload?: string })
          .filter(f => f.type === 'send' && f.to === PEER_ID);
      await vi.waitFor(() => expect(sendsTo().length).toBeGreaterThan(0), { timeout: 10_000 });
      const bodies = [];
      for (const f of sendsTo()) {
        bodies.push(
          JSON.parse(
            await decryptEnvelope(
              peerStores,
              PEER_ID,
              BOT_ID,
              f.msgType as 'prekey' | 'ciphertext',
              f.payload as string,
            ),
          ) as { tcm?: string; cid?: string; r?: string },
        );
      }
      const end = bodies.find(b => b.tcm === 'call.end');
      expect(end).toBeDefined();
      expect(end?.cid).toBe(cid);
      expect(end?.r).toBe('decline');
      // 'ending' is teardown linger, not a live call; the property is that
      // nothing is ringing and nothing was answered.
      expect(session.runner.stateName).not.toBe('incoming_ringing');
      expect(session.runner.stateName).not.toBe('connected');

      // Declining a call is a handled event, not the end of the shift.
      expect(closed.get()).toBeNull();
      socket.forceClose(1000);
      await expect(session.waitForSocketClose()).resolves.toBe(1000);
    } finally {
      session.close();
    }
  }, 30_000);
});
