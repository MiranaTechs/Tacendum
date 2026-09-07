import * as native from 'tacendum-call';
import {
  adoptPushRegistration,
  resetCallingForTests,
} from '../src/call';
import { session } from '../src/session';

jest.mock('../src/api', () => ({
  apiDeletePushToken: jest.fn(async () => undefined),
  apiRegisterFcmToken: jest.fn(async () => undefined),
  apiRegisterPushToken: jest.fn(async () => undefined),
  apiTurnCredentials: jest.fn(async () => ({ iceServers: [], ttlSeconds: 60 })),
  onApiAuthRenewed: jest.fn(() => () => undefined),
}));

const api = jest.requireMock('../src/api') as { apiRegisterPushToken: jest.Mock };
const keychain = (
  jest.requireMock('tacendum-crypto') as { __keychain: Map<string, string> }
).__keychain;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  jest.useFakeTimers();
  resetCallingForTests();
  keychain.clear();
  keychain.set('authToken', 'old-account-token');
  session.setMode('real');
  api.apiRegisterPushToken.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  resetCallingForTests();
  jest.restoreAllMocks();
  jest.clearAllTimers();
  jest.useRealTimers();
});

test('closing the account gate cancels an upload still reading native tokens', async () => {
  const token = deferred<string>();
  jest.spyOn(native, 'getVoipToken').mockReturnValueOnce(token.promise);
  adoptPushRegistration({ real: true });
  adoptPushRegistration({ real: false });
  token.resolve('a'.repeat(64));
  await jest.advanceTimersByTimeAsync(0);
  expect(api.apiRegisterPushToken).not.toHaveBeenCalled();
});

test('an old token read cannot become a second registration for the new account', async () => {
  const token = deferred<string>();
  jest.spyOn(native, 'getVoipToken').mockReturnValueOnce(token.promise);
  adoptPushRegistration({ real: true });
  adoptPushRegistration({ real: false });
  keychain.set('authToken', 'new-account-token');
  adoptPushRegistration({ real: true });
  await jest.advanceTimersByTimeAsync(0);
  expect(api.apiRegisterPushToken).toHaveBeenCalledTimes(1);
  expect(api.apiRegisterPushToken.mock.calls[0][0]).toBe('new-account-token');
  token.resolve('a'.repeat(64));
  await jest.advanceTimersByTimeAsync(0);
  expect(api.apiRegisterPushToken).toHaveBeenCalledTimes(1);
});

test('an old failed PUT cannot spend the replacement account’s retry budget', async () => {
  const oldPut = deferred<void>();
  api.apiRegisterPushToken.mockReturnValueOnce(oldPut.promise);
  adoptPushRegistration({ real: true });
  await jest.advanceTimersByTimeAsync(0);
  expect(api.apiRegisterPushToken).toHaveBeenCalledTimes(1);
  adoptPushRegistration({ real: false });
  keychain.set('authToken', 'new-account-token');
  adoptPushRegistration({ real: true });
  await jest.advanceTimersByTimeAsync(0);
  expect(api.apiRegisterPushToken).toHaveBeenCalledTimes(2);
  oldPut.reject(new Error('old request completed after account deletion'));
  await jest.advanceTimersByTimeAsync(60_000);
  expect(api.apiRegisterPushToken).toHaveBeenCalledTimes(2);
});
