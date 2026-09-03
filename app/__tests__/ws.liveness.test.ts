/**
 * THE RECEIVE-SILENCE WATCHDOG and THE JITTERED BACKOFF, asserted through
 * the REAL `ws.ts` state machine — only the socket is a fake.
 *
 * There is no ping/pong on this transport, and `readyState === OPEN` is the
 * kernel's opinion. A half-open socket (NAT rebinding, radio hand-off) takes
 * every `send` and answers nothing, and the client used to sit on it reading
 * "Connected" until TCP gave up. Now a `send` frame arms a 60 s deadline,
 * any server frame clears it, and a socket that stays silent past it is
 * written off and re-dialled at once.
 *
 * The reconnect delay is the base times a CSPRNG factor in [0.5, 1.5) —
 * drawn from `randomBytes`, never `Math.random` — so every client that lost
 * its socket in one server event does not come back on the identical
 * 1→2→…→30 s schedule.
 *
 * Modern fake timers: the deadline and `Date.now` advance together, and the
 * claims are on the deadline itself — armed one millisecond before it, dead
 * at it — not on counts. */

import { WsClient } from '../src/ws';

type Handler = (event?: unknown) => void;

class FakeSocket {
  static OPEN = 1;
  static instances: FakeSocket[] = [];
  onopen: Handler | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: Handler | null = null;
  onclose: ((event?: { code?: number }) => void) | null = null;
  readyState = 0;
  sent: string[] = [];
  closed = false;
  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }
  close() {
    this.closed = true;
    this.readyState = 3;
  }
  send(data: string) {
    this.sent.push(data);
  }
  open() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }
  /** A frame from the far end. */
  deliver(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  dropped() {
    this.readyState = 3;
    this.onclose?.({ code: 1006 });
  }
}
(globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeSocket;

const LIVENESS_MS = 60_000;
const PEER = '01KYDBSSDJSPC9J0E5N2AWMJ5Y';

const crypto = jest.requireMock('tacendum-crypto') as { randomBytes: jest.Mock };

function live(): FakeSocket {
  const socket = FakeSocket.instances[FakeSocket.instances.length - 1];
  if (!socket) throw new Error('no socket was dialled');
  return socket;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

const clients: WsClient[] = [];
function openClient(): { client: WsClient; states: string[] } {
  const client = new WsClient();
  clients.push(client);
  const states: string[] = [];
  client.onState(s => states.push(s));
  client.start('tok');
  live().open();
  return { client, states };
}

function sendFrame(client: WsClient): void {
  expect(
    client.send({ type: 'send', to: PEER, msgId: '01KYDBSSDJSPC9J0E5N2AWMJ5Z', msgType: 'ciphertext', payload: 'AAAA' }),
  ).toBe(true);
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(1_756_000_000_000);
  FakeSocket.instances.length = 0;
  crypto.randomBytes.mockClear();
});

afterEach(() => {
  for (const client of clients.splice(0)) client.stop();
  jest.useRealTimers();
});

describe('the receive-silence watchdog', () => {
  test('a socket that takes a send and answers nothing for 60 s is written off and re-dialled at once', async () => {
    const { client, states } = openClient();
    const first = live();
    sendFrame(client);
    expect(first.sent).toHaveLength(1);

    // One millisecond short of the deadline: still the same live socket.
    await jest.advanceTimersByTimeAsync(LIVENESS_MS - 1);
    expect(client.isOpen).toBe(true);
    expect(first.closed).toBe(false);
    expect(FakeSocket.instances).toHaveLength(1);

    // The deadline: written off like a stalled dial — closed, `closed`
    // reported so the screen stops saying "Connected" — and a NEW dial is
    // outstanding immediately, not after a backoff.
    await jest.advanceTimersByTimeAsync(1);
    expect(first.closed).toBe(true);
    expect(states).toEqual(['connecting', 'open', 'closed', 'connecting']);
    expect(FakeSocket.instances).toHaveLength(2);
    expect(live()).not.toBe(first);

    // The dead socket's late events reach nothing — its handlers are gone.
    first.deliver({ type: 'receipt', msgId: '01KYDBSSDJSPC9J0E5N2AWMJ5Z', state: 'sent' });
    first.dropped();
    expect(states).toEqual(['connecting', 'open', 'closed', 'connecting']);
  });

  test('any server frame inside the window is proof of life and disarms it', async () => {
    const { client } = openClient();
    const socket = live();
    sendFrame(client);

    await jest.advanceTimersByTimeAsync(LIVENESS_MS - 10_000);
    // Not even the receipt for THIS send — a typing frame from anyone shows
    // the far end is there. Per-row receipts are the outbox's business.
    socket.deliver({ type: 'typing', from: PEER, msgType: 'ciphertext', payload: 'AAAA', ts: Date.now() });
    expect(client.lastServerFrameAt).toBe(Date.now());

    await jest.advanceTimersByTimeAsync(LIVENESS_MS);
    expect(client.isOpen).toBe(true);
    expect(socket.closed).toBe(false);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  test('a send after proof of life arms a fresh deadline of its own', async () => {
    const { client } = openClient();
    const socket = live();
    sendFrame(client);
    await jest.advanceTimersByTimeAsync(30_000);
    socket.deliver({ type: 'receipt', msgId: '01KYDBSSDJSPC9J0E5N2AWMJ5Z', state: 'delivered' });

    // Quiet until this second send; the clock starts from IT.
    await jest.advanceTimersByTimeAsync(100_000);
    expect(socket.closed).toBe(false);
    sendFrame(client);
    await jest.advanceTimersByTimeAsync(LIVENESS_MS - 1);
    expect(socket.closed).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    expect(socket.closed).toBe(true);
    expect(FakeSocket.instances).toHaveLength(2);
  });

  test('acks and typing are fire-and-forget: they never put an idle socket on the clock', async () => {
    const { client } = openClient();
    const socket = live();
    expect(client.send({ type: 'ack', msgId: '01KYDBSSDJSPC9J0E5N2AWMJ5Z' })).toBe(true);
    expect(client.send({ type: 'typing', to: PEER, msgType: 'ciphertext', payload: 'AAAA' })).toBe(true);

    await jest.advanceTimersByTimeAsync(LIVENESS_MS * 3);
    expect(socket.closed).toBe(false);
    expect(client.isOpen).toBe(true);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  test('a fresh socket has produced nothing: lastServerFrameAt is null until its first frame', async () => {
    const { client } = openClient();
    expect(client.lastServerFrameAt).toBeNull();
    live().deliver({ type: 'receipt', msgId: '01KYDBSSDJSPC9J0E5N2AWMJ5Z', state: 'sent' });
    expect(client.lastServerFrameAt).toBe(Date.now());
    // Dropped and re-dialled: the new transport starts from nothing again.
    live().dropped();
    await jest.advanceTimersByTimeAsync(2_000);
    live().open();
    expect(client.lastServerFrameAt).toBeNull();
  });

  test('stop() disarms the watchdog: a relock is not followed by a dial 60 s later', async () => {
    const { client, states } = openClient();
    sendFrame(client);
    client.stop();
    await jest.advanceTimersByTimeAsync(LIVENESS_MS * 2);
    expect(FakeSocket.instances).toHaveLength(1);
    expect(states).toEqual(['connecting', 'open']);
  });

  test('suspend() disarms it too — the Doze policy owns the socket while the device sleeps', async () => {
    const { client } = openClient();
    sendFrame(client);
    client.suspend();
    await jest.advanceTimersByTimeAsync(LIVENESS_MS * 2);
    expect(FakeSocket.instances).toHaveLength(1);
  });
});

describe('the jittered backoff', () => {
  test('the reconnect delay is base × [0.5, 1.5), drawn from randomBytes and never Math.random', async () => {
    const random = jest.spyOn(Math, 'random');
    const { client } = openClient();
    // The pool is filled asynchronously on start(); let it land.
    await settle();
    expect(crypto.randomBytes).toHaveBeenCalled();

    const dialsAt: number[] = [];
    const drops = 4;
    for (let i = 0; i < drops; i++) {
      dialsAt.push(Date.now());
      live().dropped();
      // Walk the clock forward until the next dial appears, one ms at a time
      // in the last stretch so the measured gap is the delay itself.
      const before = FakeSocket.instances.length;
      await jest.advanceTimersByTimeAsync(1000 * 2 ** i * 0.5 - 1);
      expect(FakeSocket.instances).toHaveLength(before); // not before 0.5×
      while (FakeSocket.instances.length === before) {
        await jest.advanceTimersByTimeAsync(1);
      }
      live().open();
    }
    // Each gap sits inside its base's window: 1 s, 2 s, 4 s, 8 s.
    const observed = dialsAt.map((at, i) => {
      const next = i + 1 < dialsAt.length ? dialsAt[i + 1]! : Date.now();
      return next - at;
    });
    for (let i = 0; i < drops; i++) {
      const base = 1000 * 2 ** i;
      expect(observed[i]!).toBeGreaterThanOrEqual(base * 0.5);
      expect(observed[i]!).toBeLessThan(base * 1.5);
    }
    // The deterministic mock RNG hands out distinct bytes, so the factors
    // are not all one — the jitter is real, not a rounding.
    const factors = observed.map((gap, i) => gap / (1000 * 2 ** i));
    expect(new Set(factors.map(f => f.toFixed(2))).size).toBeGreaterThan(1);
    expect(random).not.toHaveBeenCalled();
    random.mockRestore();
    client.stop();
  });

  test('the base keeps its 30 s cap: a long outage never waits past 45 s between dials', async () => {
    const { client } = openClient();
    await settle();
    // Climb well past the cap.
    for (let i = 0; i < 8; i++) {
      live().dropped();
      await jest.advanceTimersByTimeAsync(45_000);
      live().open();
    }
    const at = Date.now();
    live().dropped();
    await jest.advanceTimersByTimeAsync(15_000 - 1);
    const before = FakeSocket.instances.length;
    while (FakeSocket.instances.length === before) {
      await jest.advanceTimersByTimeAsync(1);
    }
    const gap = Date.now() - at;
    expect(gap).toBeGreaterThanOrEqual(15_000);
    expect(gap).toBeLessThan(45_000);
    client.stop();
  });
});
