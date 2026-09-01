/**
 * an earlier review, earlier findings: THE RECEIPT PATH, DRIVEN FOR REAL.
 *
 * Two defects share one subject, so they share one harness — a real
 * `CallSession` over a readyState-faithful `ws` mock, with the real libsignal
 * ratchet underneath, exactly as `gate.call-socket-liveness.test.ts`
 * does. Nothing here injects a fake `sendAcked`; the seam tests already do
 * that, and doing it is precisely what left these two paths unwitnessed.
 *
 * DEFECT — A CLOSED SOCKET LEFT A RECEIPT WAITER PENDING FOREVER.
 * `sendAcked` settles on the receipt wake or on a timer that is deliberately
 * `unref`'d ("a pending receipt must never be the reason a finished CLI keeps
 * running"). Those are the only two settlements, so a socket that dies after
 * the send and before its receipt left the promise pending with NO referenced
 * handle keeping the loop alive — Node is entitled to exit 0 with `main()`
 * still unresolved, which skips the `finally` that persists group state, emits
 * the release tombstone and closes the session. The fix settles every
 * unacked slot when the socket closes, and again in `close()` so a
 * locally-initiated teardown cannot strand a waiter either.
 *
 * The assertions are bounded WELL under `DELTA_RECEIPT_TIMEOUT_MS` (5 s), so
 * the unref'd timer cannot be the thing that passes them.
 *
 * DEFECT — THE PRODUCTION RECEIPT CONVERSION WAS UNTESTED.
 * `slot.kind = frame.state` (call-session.ts, the `onFrame` receipt branch) is
 * the single line that keeps `'sent'` and `'delivered'` distinct, and the
 * point of keeping them apart is sharp: collapsing them lets a
 * fan-out's ACCEPTANCE count be read as a DELIVERY. Every test that existed
 * stubbed `sendAcked` wholesale, so the conversion had no coverage at all:
 * hardcoding either kind at that line left the suite green. These cases drive
 * a real receipt frame in over the mock socket and read what `sendAcked`
 * returns — including the race the slot exists for, where the server's answer
 * arrives before the waiter has attached.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PrekeyBundle } from '@tacendum/shared';

interface FakeSocket {
  readyState: number;
  handlers: Record<string, Array<(...a: unknown[]) => void>>;
  sent: string[];
  sentAfterClose: string[];
  forceClose(code: number): void;
}

const { sockets, hooks } = vi.hoisted(() => ({
  sockets: [] as Array<{
    readyState: number;
    handlers: Record<string, Array<(...a: unknown[]) => void>>;
    sent: string[];
    sentAfterClose: string[];
    forceClose(code: number): void;
  }>,
  /**
   * Fired SYNCHRONOUSLY from inside `send()`, which is what makes the
   * receipt-beats-waiter case reachable at all: the server's answer has to
   * land while `sendEncrypted` is still on the stack, before `sendAcked`
   * resumes and looks the slot up.
   */
  hooks: { onSend: undefined as ((frame: Record<string, unknown>) => void) | undefined },
}));

vi.mock('ws', () => {
  class FakeWebSocket {
    static readonly OPEN = 1;
    readyState = 0;
    handlers: Record<string, Array<(...a: unknown[]) => void>> = {};
    sent: string[] = [];
    sentAfterClose: string[] = [];
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
    close() {
      // A no-op ON PURPOSE, and it is the whole of the `close()` case below.
      // `ws.close()` starts a closing handshake; the 'close' event arrives
      // later, or never, if the process is on its way out. A sweep that only
      // ran from the close HANDLER would therefore not run here at all.
    }
    forceClose(code: number) {
      this.readyState = 3;
      for (const h of this.handlers.close ?? []) h(code);
    }
    send(data: string) {
      if (this.readyState === 1) {
        this.sent.push(data);
        hooks.onSend?.(JSON.parse(data) as Record<string, unknown>);
      } else this.sentAfterClose.push(data);
    }
  }
  return { default: FakeWebSocket };
});

// Set BEFORE the src imports: config.ts snapshots TACENDUM_API at module
// evaluation, and a top-level `await import` evaluates during collection.
const home = mkdtempSync(join(tmpdir(), 'tacendum-receipt-'));
const previousHome = process.env.TACENDUM_HOME;
const previousApi = process.env.TACENDUM_API;
process.env.TACENDUM_HOME = home;
process.env.TACENDUM_API = 'http://receipt.test';

const { FileStores } = await import('../src/stores.js');
const { generateAndStoreKeys } = await import('../src/messaging.js');
const { CallSession } = await import('../src/call-session.js');
const { saveProfile } = await import('../src/profile.js');

const CALLER = 'receipt-caller';
const CALLER_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

const callerUpload = await generateAndStoreKeys(new FileStores(CALLER));
const peerUpload = await generateAndStoreKeys(new FileStores('receipt-peer'));

// A FRESH peer id per test (same real key material): the ratchet is real and
// keyed by address, so a shared peer would let one case's session state decide
// whether the next case's send fetches a bundle at all.
let testNo = 0;
let peerId = '';
function peerBundle(): PrekeyBundle {
  return {
    userId: peerId,
    registrationId: peerUpload.registrationId,
    identityKey: peerUpload.identityKey,
    signedPrekey: peerUpload.signedPrekey,
    kyberPrekey: peerUpload.kyberPrekey,
    oneTimePrekey: peerUpload.oneTimePrekeys[0],
  };
}

const realFetch = globalThis.fetch;

beforeEach(() => {
  testNo += 1;
  peerId = `01PEERPEERPEERPEERPEERPE${String(testNo).padStart(2, '0')}`;
  saveProfile({
    name: CALLER,
    identityKey: callerUpload.identityKey,
    userId: CALLER_ID,
    authToken: 'receipt-token',
    registrationId: callerUpload.registrationId,
    deviceId: 1,
  });
  sockets.length = 0;
  hooks.onSend = undefined;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const path = String(input).replace('http://receipt.test', '');
    const json = (body: unknown): Response =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    if (path === '/v1/ws-ticket') return json({ ticket: 'tkt', expiresAt: 1 });
    if (path === `/v1/keys/${peerId}`) return json(peerBundle());
    throw new Error(`unexpected request ${path}`);
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});
afterAll(() => {
  if (previousHome === undefined) delete process.env.TACENDUM_HOME;
  else process.env.TACENDUM_HOME = previousHome;
  if (previousApi === undefined) delete process.env.TACENDUM_API;
  else process.env.TACENDUM_API = previousApi;
  // AND THE HOME ITSELF, which this suite created at collection time and left
  // behind on every run (an earlier review). It is not scratch: the
  // `beforeEach` writes a profile with an auth token into it and
  // `generateAndStoreKeys` lands two real identity keypairs and their prekey
  // batches, so each run deposited a fresh set of private key material under
  // the system temp dir and nothing ever removed it. Same call the neighbouring
  // suites end with (gate.gc3-seam, gate.address, gate.credential-echo).
  rmSync(home, { recursive: true, force: true });
});

/** The private method under test. It has no public caller outside the group
 * fan-out, and routing through that would put a reducer between the assertion
 * and the thing being asserted. */
interface ReceiptSender {
  sendAcked(peerId: string, body: string, urgent: boolean): Promise<'sent' | 'delivered' | null>;
}
const acker = (session: unknown): ReceiptSender => session as ReceiptSender;

/** The msgId of the one `send` frame this test put on the wire. */
function sentMsgId(socket: FakeSocket): string {
  const frames = socket.sent.map(f => JSON.parse(f) as { type: string; msgId?: string });
  const send = frames.find(f => f.type === 'send');
  if (!send?.msgId) throw new Error('no send frame reached the socket');
  return send.msgId;
}

/** A server frame arriving on the socket, through the same 'message' listener
 * `WsClient.dial` wires — never by calling a handler this test invented. */
function deliver(socket: FakeSocket, frame: unknown): void {
  for (const h of socket.handlers.message ?? []) h(Buffer.from(JSON.stringify(frame)));
}

/**
 * Did `promise` settle within `ms`? The whole point of an earlier finding is that a
 * pending promise is indistinguishable from a slow one unless the wait is
 * BOUNDED — and the bound has to be far below DELTA_RECEIPT_TIMEOUT_MS (5 s)
 * or the unref'd timer is what answered.
 */
const SETTLE_BUDGET_MS = 500;
async function settledWithin<T>(
  promise: Promise<T>,
  ms = SETTLE_BUDGET_MS,
): Promise<{ settled: boolean; value?: T }> {
  let timer: NodeJS.Timeout | undefined;
  const result = await Promise.race([
    promise.then(value => ({ settled: true, value })),
    new Promise<{ settled: false }>(resolve => {
      timer = setTimeout(() => resolve({ settled: false }), ms);
    }),
  ]);
  if (timer) clearTimeout(timer);
  return result;
}

/** Resolve once the tracked send has actually reached the socket — the slot is
 * armed just before that write, so this is the earliest instant at which a
 * close can strand a waiter. */
async function awaitSend(socket: FakeSocket): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (socket.sent.some(f => (JSON.parse(f) as { type: string }).type === 'send')) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('the tracked send never reached the socket');
}

describe('a socket that dies owing a receipt settles its waiters', () => {
  it('close 1006 after the send settles sendAcked promptly, and with null — a close is not a receipt', async () => {
    const session = new CallSession(CALLER);
    let outcome: { settled: boolean; value?: 'sent' | 'delivered' | null };
    try {
      await session.connect();
      const socket = sockets.at(-1);
      if (!socket) throw new Error('no socket dialled');
      const pending = acker(session).sendAcked(peerId, 'roster-delta', false);
      await awaitSend(socket);
      socket.forceClose(1006);
      outcome = await settledWithin(pending);
    } finally {
      session.close();
    }
    expect(
      outcome.settled,
      `sendAcked was still pending ${SETTLE_BUDGET_MS}ms after the socket closed — ` +
        'nothing referenced is keeping the loop alive, so the process may exit 0 ' +
        'with main() unresolved and the finally (state, tombstone, cleanup) skipped',
    ).toBe(true);
    expect(outcome.value, 'a close was reported as an acknowledgement').toBeNull();
  });

  it('a LOCAL close settles it too — ws.close() only starts a handshake', async () => {
    const session = new CallSession(CALLER);
    await session.connect();
    const socket = sockets.at(-1);
    if (!socket) throw new Error('no socket dialled');
    const pending = acker(session).sendAcked(peerId, 'roster-delta', false);
    await awaitSend(socket);
    // The command's own teardown — `cmdGroupCall`'s finally. The mock's
    // close() emits no 'close' event, which is the honest shape of a process
    // that is exiting: the sweep has to be in `close()` itself.
    session.close();
    const outcome = await settledWithin(pending);
    expect(
      outcome.settled,
      `sendAcked was still pending ${SETTLE_BUDGET_MS}ms after CallSession.close()`,
    ).toBe(true);
    expect(outcome.value).toBeNull();
  });

  it('a receipt that ALREADY landed survives the close — the sweep settles waiters, it does not erase facts', async () => {
    const session = new CallSession(CALLER);
    let outcome: { settled: boolean; value?: 'sent' | 'delivered' | null };
    try {
      await session.connect();
      const socket = sockets.at(-1);
      if (!socket) throw new Error('no socket dialled');
      // The receipt arrives while `sendEncrypted` is still on the stack, so
      // the slot is acked before any waiter attaches; the close follows
      // immediately. The honest answer is still 'delivered'.
      hooks.onSend = frame => {
        if (frame.type !== 'send') return;
        deliver(socket, { type: 'receipt', msgId: frame.msgId, state: 'delivered' });
        socket.forceClose(1006);
      };
      const pending = acker(session).sendAcked(peerId, 'roster-delta', false);
      outcome = await settledWithin(pending);
    } finally {
      session.close();
    }
    expect(outcome.settled).toBe(true);
    expect(outcome.value, 'a receipt the server really sent was thrown away by the close sweep').toBe(
      'delivered',
    );
  });
});

describe('the production receipt conversion keeps the kind', () => {
  it("state:'sent' comes back as 'sent' — queued for a recipient who is not on a socket", async () => {
    const session = new CallSession(CALLER);
    try {
      await session.connect();
      const socket = sockets.at(-1);
      if (!socket) throw new Error('no socket dialled');
      const pending = acker(session).sendAcked(peerId, 'roster-delta', false);
      await awaitSend(socket);
      deliver(socket, { type: 'receipt', msgId: sentMsgId(socket), state: 'sent' });
      const outcome = await settledWithin(pending);
      expect(outcome.settled).toBe(true);
      expect(outcome.value).toBe('sent');
    } finally {
      session.close();
    }
  });

  it("state:'delivered' comes back as 'delivered' — written to a live socket of theirs", async () => {
    const session = new CallSession(CALLER);
    try {
      await session.connect();
      const socket = sockets.at(-1);
      if (!socket) throw new Error('no socket dialled');
      const pending = acker(session).sendAcked(peerId, 'roster-delta', false);
      await awaitSend(socket);
      deliver(socket, { type: 'receipt', msgId: sentMsgId(socket), state: 'delivered' });
      const outcome = await settledWithin(pending);
      expect(outcome.settled).toBe(true);
      expect(outcome.value).toBe('delivered');
    } finally {
      session.close();
    }
  });

  it('the receipt that beats the waiter keeps its kind too — the race the slot exists for', async () => {
    const session = new CallSession(CALLER);
    try {
      await session.connect();
      const socket = sockets.at(-1);
      if (!socket) throw new Error('no socket dialled');
      // Delivered from inside `send()`, so the slot is acked before
      // `sendAcked` ever looks it up: this exercises the `slot.acked` early
      // return rather than the wake.
      hooks.onSend = frame => {
        if (frame.type !== 'send') return;
        deliver(socket, { type: 'receipt', msgId: frame.msgId, state: 'sent' });
      };
      const outcome = await settledWithin(acker(session).sendAcked(peerId, 'roster-delta', false));
      expect(outcome.settled).toBe(true);
      expect(outcome.value).toBe('sent');
    } finally {
      session.close();
    }
  });
});

/**
 * an earlier review: THE PRODUCTION SINK HAD NO WITNESS.
 *
 * `GCALL delta_frame … msgid=` is what puts a stored `call.gleave` — the
 * envelope that carries the session's sid — into the set the e2e group-call harness
 * waits for before it declares the leak scan complete. The executor emits it
 * from a callback (`sendRosterDelta`, group-call.ts), and that callback only
 * ever runs because `CallSession` passes it through as `sendAcked`'s FOURTH
 * argument:
 *
 *     sendAcked: (peerId, body, urgent, onMsgId) =>
 *       this.sendAcked(peerId, body, urgent, onMsgId)
 *
 * That parameter is OPTIONAL, and nothing observed it. `gate.gc3-seam` injects
 * its own `sendAcked` and calls the sink itself, so it proves the executor
 * emits the line when a sender cooperates, not that the real sender does. The
 * cases above are the only ones that drive the REAL method — and they declare
 * a three-argument `ReceiptSender`, so they could not have noticed either.
 * Delete the argument and every unit suite stays green while the line
 * disappears from production; the containment set then quietly loses the one
 * frame it exists to include.
 *
 * So this case constructs a GROUP-ENABLED `CallSession` — the real adapter, the
 * real `sendAcked`, the real ratchet, the real socket mock — drives a session
 * to its `call.gleave`, and reads the line off stdout, checking the id against
 * the frame that actually reached the wire rather than against its shape.
 */
describe('the group adapter hands the real sendAcked its msgId sink', () => {
  it('a delta_frame line names the id of the gleave frame that reached the socket', async () => {
    const session = new CallSession(CALLER, { group: true });
    const lines: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });
    try {
      await session.connect();
      const socket = sockets.at(-1);
      if (!socket) throw new Error('no socket dialled');
      // Every tracked send is acked from inside `send()`: the fan-out awaits
      // `sendAcked`, and an unanswered receipt would spend the 5 s timeout
      // here. The sink fires BEFORE that wait either way — which is the
      // property under test — but the test should not depend on the timeout to
      // finish.
      hooks.onSend = frame => {
        if (frame.type !== 'send') return;
        deliver(socket, { type: 'receipt', msgId: frame.msgId, state: 'delivered' });
      };
      const group = session.group;
      expect(group, 'the session was constructed without its group runner').toBeDefined();
      await group!.start([CALLER_ID, peerId], false);
      lines.length = 0;
      await group!.leave();

      // The gleave as it left THIS process: the ws frame the socket recorded.
      const gleave = socket.sent
        .map(f => JSON.parse(f) as { type: string; msgId?: string; to?: string })
        .filter(f => f.type === 'send' && f.to === peerId)
        .at(-1);
      expect(gleave?.msgId, 'no send frame reached the socket for the leave').toBeTruthy();

      const deltas = lines.filter(l => l.startsWith('GCALL delta_frame '));
      expect(
        deltas,
        `the roster delta reached the wire with nothing naming its row:\n${lines.join('\n')}`,
      ).toHaveLength(1);
      // Not merely well-formed — the SAME id. A sink handed a freshly minted
      // ulid would satisfy the grammar and name a row that does not exist.
      expect(deltas[0]).toBe(
        `GCALL delta_frame tcm=call.gleave sid=${
          /sid=([0-9A-HJKMNP-TV-Z]{26})/.exec(deltas[0] ?? '')?.[1] ?? ''
        } to=${peerId} msgid=${gleave?.msgId}`,
      );
    } finally {
      log.mockRestore();
      session.close();
    }
  }, 30_000);
});
