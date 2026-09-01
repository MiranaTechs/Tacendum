/**
 * A TRANSPORT THIS CLIENT LET GO OF HAS TO ACTUALLY GO — the pin for the
 * second half of the background-redial defect.
 *
 * WHAT WAS BROKEN, measured on the emulator rather than reasoned about. React
 * Native's `WebSocket.close()` is not a close. The polyfill marks the object
 * CLOSING and calls `WebSocketModule.close(id)`, which looks the id up in
 * `webSocketConnections` — a map written in OkHttp's `onOpen` and nowhere else
 * — finds nothing for a socket whose upgrade is still in flight, and returns
 * having done nothing at all. OkHttp then finishes the upgrade. The connection
 * is now live on both ends, the JavaScript object that could have closed it has
 * had its handlers torn off, and the polyfill's own guard (`close()` returns
 * early when readyState is CLOSING) means nothing can ever ask for it again.
 *
 * Measured on Pixel_7_API_35: six sockets closed one line after
 * construction left SIX live connections standing, counted in the device's own
 * /proc/net/tcp6 and in the far end's log, while the app believed it held none.
 *
 * WHY THAT IS A DELIVERY DEFECT AND NOT A LEAK. The far end routes an account's
 * messages to ONE connection — the row `$connect` claims — and it keeps an
 * incumbent that still takes bytes (`ws_connect_incumbent_spared`). A stray
 * connection nobody is listening to is therefore not idle: it holds the routing
 * row, every honest re-dial after it is refused, and every message posted to
 * the account goes into a socket whose frames reach no handler and are never
 * acked. That is precisely "the socket re-dials once from the pocket and never
 * again", which is the row the device matrix could not certify.
 *
 * THE REPAIR, and the reason it is testable here: a socket that has been let go
 * of keeps exactly one handler — an `onopen` whose only job is to close it for
 * real. The polyfill sets readyState back to OPEN before it dispatches that
 * event, so the second `close()` passes the guard, finds the entry the native
 * map now has, and hangs the connection up. `FakeRnSocket` below models those
 * three rules and nothing else.
 */

import { WsClient, type WsTicketMint } from '../src/ws';

type Handler = (event?: unknown) => void;

/**
 * React Native's WebSocket, in the three respects this file is about:
 *
 *  1. `close()` returns immediately when the object is already CLOSING or
 *     CLOSED (Libraries/WebSocket/WebSocket.js);
 *  2. a `close()` issued before the upgrade completes does NOT hang the
 *     transport up (WebSocketModule.close finds no entry in its map);
 *  3. when the upgrade does complete, readyState becomes OPEN and `onopen`
 *     fires — even for an object a `close()` had already marked CLOSING.
 *
 * `hungUp` is the far end's view: true only once something actually reached
 * the transport.
 */
class FakeRnSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeRnSocket[] = [];

  onopen: Handler | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: Handler | null = null;
  onclose: Handler | null = null;

  readyState = FakeRnSocket.CONNECTING;
  /** Has the far end been hung up? The whole question this file asks. */
  hungUp = false;
  /** Has the upgrade completed at least once (the native map's condition)? */
  private upgraded = false;

  constructor(public url: string) {
    FakeRnSocket.instances.push(this);
  }

  close(): void {
    if (this.readyState === FakeRnSocket.CLOSING || this.readyState === FakeRnSocket.CLOSED) {
      return;
    }
    this.readyState = FakeRnSocket.CLOSING;
    if (!this.upgraded) return; // rule 2: nothing reaches the transport
    this.hungUp = true;
    this.readyState = FakeRnSocket.CLOSED;
  }

  send(_data: string): void {}

  /** The upgrade completes. */
  completeUpgrade(): void {
    this.upgraded = true;
    this.readyState = FakeRnSocket.OPEN;
    this.onopen?.();
  }

  /** An ordinary transport close arriving from the far end. */
  dropped(code = 1006): void {
    this.readyState = FakeRnSocket.CLOSED;
    this.onclose?.({ code });
  }
}
(globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeRnSocket;

/** A mint whose answers this test hands out one at a time, so a dial can be
 * caught in the window between "a ticket was asked for" and "a socket exists".
 * That window is where `adoptToken` and the backoff meet, and it is where the
 * client used to open a transport for a dial it had already written off. */
function mintQueue(): { mint: WsTicketMint; answers: ((ticket: string | null) => void)[] } {
  const answers: ((ticket: string | null) => void)[] = [];
  const mint: WsTicketMint = () =>
    new Promise<string | null>(resolve => {
      answers.push(resolve);
    });
  return { mint, answers };
}

/** Let the mint's continuation run. Microtasks, so fake timers do not matter. */
async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

const first = (): FakeRnSocket => {
  const socket = FakeRnSocket.instances[0];
  if (!socket) throw new Error('no socket was dialled');
  return socket;
};

beforeEach(() => {
  jest.useFakeTimers();
  FakeRnSocket.instances.length = 0;
});

afterEach(() => {
  jest.useRealTimers();
});

test('a dial written off by its watchdog hangs up the connection it left behind', () => {
  const client = new WsClient();
  client.start('tok');
  expect(FakeRnSocket.instances).toHaveLength(1);
  const socket = first();

  // The dial neither opens nor closes, so its deadline is what ends it. The
  // client asks the transport to go; React Native cannot pass that on yet, and
  // the assertion says so rather than pretending otherwise.
  jest.advanceTimersByTime(20_000);
  expect(socket.hungUp).toBe(false);

  // OkHttp finishes the upgrade regardless. THIS is the moment the connection
  // used to become permanent — and the moment the repair spends.
  socket.completeUpgrade();
  expect(socket.hungUp).toBe(true);

  client.stop();
});

test('a socket the client threw away never reports itself open to the app', () => {
  const client = new WsClient();
  const states: string[] = [];
  client.onState(state => states.push(state));
  client.start('tok');
  const socket = first();

  jest.advanceTimersByTime(20_000);
  socket.completeUpgrade();

  // `connecting` for the dial and `closed` for the write-off, and nothing
  // else: an `open` here would be the app telling its owner it is connected
  // over a transport it has already let go of.
  expect(states).not.toContain('open');

  client.stop();
});

test('suspend hangs up a socket whose upgrade had not finished', () => {
  const client = new WsClient();
  client.start('tok');
  const socket = first();

  // The Doze policy's route (`pauseForIdle` -> `suspend`): the device is going
  // to sleep and the socket is deliberately down. A connection that completes
  // its upgrade a moment later must not survive that decision.
  client.suspend();
  expect(socket.hungUp).toBe(false);
  socket.completeUpgrade();
  expect(socket.hungUp).toBe(true);
});

test('stop hangs up a socket whose upgrade had not finished', () => {
  const client = new WsClient();
  client.start('tok');
  const socket = first();

  client.stop();
  socket.completeUpgrade();
  expect(socket.hungUp).toBe(true);
});

test('a fresh start does not orphan the dial the last session left in flight', () => {
  const client = new WsClient();
  client.start('tok');
  const stale = first();

  // A relock/unlock, or a workspace switch: `start` releases the outstanding
  // dial before it makes its own. The transport that dial had already asked
  // for is the one nothing else will ever hold a reference to.
  client.start('tok2');
  expect(FakeRnSocket.instances).toHaveLength(2);
  stale.completeUpgrade();
  expect(stale.hungUp).toBe(true);

  client.stop();
});

test('an ordinary socket still closes the ordinary way', () => {
  const client = new WsClient();
  client.start('tok');
  const socket = first();
  socket.completeUpgrade();

  client.stop();
  expect(socket.hungUp).toBe(true);
});

test('a dial superseded while its ticket was in flight opens no transport of its own', async () => {
  const { mint, answers } = mintQueue();
  const client = new WsClient();
  client.start('tok', undefined, mint);

  // The dial has asked for a ticket and has no transport yet. This is the
  // window `adoptToken` walks into: it revokes the queued reconnect and dials
  // at once, and `this.socket` is null, so nothing holds it back.
  expect(FakeRnSocket.instances).toHaveLength(0);
  expect(answers).toHaveLength(1);
  client.adoptToken('tok2');
  expect(answers).toHaveLength(2);

  // The superseded dial's ticket arrives late. It must not become a socket:
  // the dial that replaced it is the one the client is holding, and a second
  // transport here is a connection nobody owns — which on the far end is the
  // incumbent that refuses every honest re-dial after it.
  answers[0]!('ticket-a');
  await settle();
  expect(FakeRnSocket.instances).toHaveLength(0);

  // ...and the dial that DID replace it still dials, because superseding is
  // never a refusal to connect.
  answers[1]!('ticket-b');
  await settle();
  expect(FakeRnSocket.instances).toHaveLength(1);
  expect(first().url).toContain('ticket-b');

  client.stop();
});
