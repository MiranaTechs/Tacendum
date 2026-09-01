jest.mock('../src/ws', () => {
  let state: ((value: string) => void) | undefined;
  class WsClient {
    onFrame() {}
    onState(listener: (value: string) => void) { state = listener; }
    start() {}
    stop() {}
    send() { return true; }
    get isOpen() { return false; }
  }
  return { WsClient, __ws: { open: () => state?.('open') } };
});

import { messaging } from '../src/messaging';
import { AUTH_TOKEN_KEY } from '../src/reauth';
import { session } from '../src/session';

describe('MessagingService call metric recovery hook', () => {
  afterEach(() => messaging.stop());

  it('notifies transport-open listeners and its disposer is idempotent', async () => {
    const crypto = jest.requireMock('tacendum-crypto') as { __keychain: Map<string, string> };
    crypto.__keychain.set(AUTH_TOKEN_KEY, 'token');
    session.setMode('real');
    const listener = jest.fn();
    const dispose = messaging.onTransportOpen(listener);
    await messaging.start('01KYDBSSDJSPC9J0E5N2AWMJ5Y').catch(() => undefined);
    const ws = jest.requireMock('../src/ws').__ws;
    ws.open();
    expect(listener).toHaveBeenCalledTimes(1);
    dispose(); dispose();
    ws.open();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
