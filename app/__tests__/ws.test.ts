/**
 * WsClient.stop() must be a full teardown. A
 * late close event from the OS must reach no handler (it previously chained
 * notify → ProfileWatcher → loadProfile, re-opening the db while locked),
 * and handlers must not stack across the relock/unlock start-stop cycles.
 */

import { WsClient } from '../src/ws';

type Handler = (event?: unknown) => void;

class FakeSocket {
  static OPEN = 1;
  static instances: FakeSocket[] = [];
  onopen: Handler | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: Handler | null = null;
  onclose: Handler | null = null;
  readyState = FakeSocket.OPEN;
  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }
  close() {
    this.readyState = 3;
  }
  send(_data: string) {}
}
(globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeSocket;

beforeEach(() => {
  FakeSocket.instances.length = 0;
});

test('a late close event after stop() reaches no state handler', () => {
  const client = new WsClient();
  const states: string[] = [];
  client.onState(state => states.push(state));
  client.start('tok');
  const socket = FakeSocket.instances[FakeSocket.instances.length - 1];
  client.stop();

  // RN delivers the close event asynchronously, after stop() returned.
  socket.onclose?.();

  expect(states).toEqual(['connecting']);
});

test('a late open from the stopped socket cannot reach handlers armed by the next session', () => {
  const client = new WsClient();
  const states: string[] = [];
  client.onState(state => states.push(`old:${state}`));
  client.start('old');
  const oldSocket = FakeSocket.instances[FakeSocket.instances.length - 1]!;
  client.stop();

  client.onState(state => states.push(`new:${state}`));
  client.start('new');
  oldSocket.onopen?.();
  expect(states).toEqual(['old:connecting', 'new:connecting']);
});

test('frame handlers do not stack across stop/start cycles', () => {
  const client = new WsClient();
  const seen: string[] = [];
  client.onFrame(() => seen.push('stale'));
  client.start('tok');
  client.stop();

  client.onFrame(() => seen.push('fresh'));
  client.start('tok');
  const socket = FakeSocket.instances[FakeSocket.instances.length - 1];
  socket.onmessage?.({
    data: JSON.stringify({
      type: 'receipt',
      msgId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      state: 'sent',
    }),
  });

  expect(seen).toEqual(['fresh']);
});
