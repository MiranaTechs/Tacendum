import * as native from 'tacendum-call';
import {
  bindCallingAccount,
  callController,
  clearCallingAccount,
  refreshSelfAccountId,
  resetCallingForTests,
} from '../src/call';
import * as db from '../src/db';
import * as api from '../src/api';
import { session } from '../src/session';

const keychain = (
  jest.requireMock('tacendum-crypto') as { __keychain: Map<string, string> }
).__keychain;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

beforeEach(() => {
  resetCallingForTests();
  session.setMode('real');
  jest.mocked(native.setAccountOwner).mockClear();
  keychain.set('authToken', 'old-account-token');
});

afterEach(() => {
  resetCallingForTests();
  jest.restoreAllMocks();
  jest.useRealTimers();
});

test('an in-flight old binding finishes before reset and adoption of the new account', async () => {
  const old = deferred<void>();
  jest.mocked(native.setAccountOwner).mockReturnValueOnce(old.promise);
  const first = bindCallingAccount('old-account');
  await Promise.resolve();
  const reset = clearCallingAccount();
  const next = bindCallingAccount('new-account');
  expect(native.setAccountOwner).toHaveBeenCalledTimes(1);
  old.resolve();
  await Promise.all([first, reset, next]);
  expect(jest.mocked(native.setAccountOwner).mock.calls).toEqual([
    ['old-account'], [''], ['new-account'],
  ]);
});

test('a profile read from the deleted account cannot restore its native owner', async () => {
  const old = deferred<db.ProfileRow | null>();
  jest.spyOn(db, 'loadProfile').mockReturnValueOnce(old.promise);
  const refresh = refreshSelfAccountId();
  await clearCallingAccount();
  await bindCallingAccount('new-account');
  old.resolve({
    userId: 'old-account', registrationId: 1, displayName: '', about: '',
    avatarB64: '', profileVersion: 0,
  });
  await refresh;
  expect(jest.mocked(native.setAccountOwner).mock.calls).toEqual([
    [''], ['new-account'],
  ]);
});

test('opening a decoy never replaces the persisted real call owner', async () => {
  session.setMode('duress');
  await bindCallingAccount('decoy-account');
  expect(native.setAccountOwner).not.toHaveBeenCalled();
});

test('a queued clear cannot erase the real owner after duress begins', async () => {
  const old = deferred<void>();
  jest.mocked(native.setAccountOwner).mockReturnValueOnce(old.promise);
  const binding = bindCallingAccount('real-account');
  await Promise.resolve();
  const clear = clearCallingAccount();
  session.setMode('duress');
  old.resolve();
  await binding;
  await expect(clear).rejects.toThrow();
  expect(jest.mocked(native.setAccountOwner).mock.calls).toEqual([['real-account']]);
});

test('native reset failures propagate so deletion can keep its retry marker', async () => {
  jest.mocked(native.setAccountOwner).mockRejectedValueOnce(new Error('unavailable'));
  await expect(clearCallingAccount()).rejects.toThrow('unavailable');
  await clearCallingAccount();
  expect(native.setAccountOwner).toHaveBeenLastCalledWith('');
});

test('a declined old push cannot decline the same caller for the new account', async () => {
  const calls = callController();
  calls.notePushRing('old-ring', 'caller', 'old-ring');
  await calls.onCallKitEnd('old-ring');
  await clearCallingAccount();
  expect(calls.takePushDecline('caller')).toBe(false);
});

test('an old cancellation timer cannot dismiss a replacement account’s ring', async () => {
  jest.useFakeTimers();
  const calls = callController();
  calls.notePushRing('old-ring', 'caller', 'old-ring');
  calls.noteRingCancelled('caller');
  await clearCallingAccount();
  jest.mocked(native.dismissPendingIncomingCall).mockClear();
  await jest.advanceTimersByTimeAsync(60_000);
  expect(native.dismissPendingIncomingCall).not.toHaveBeenCalled();
});

test('a replacement account fetches its own call credentials', async () => {
  const fetch = jest.spyOn(api, 'apiTurnCredentials').mockResolvedValue({
    iceServers: [], ttlSeconds: 3600,
  });
  const calls = callController();
  await calls.ensureCredentials();
  await clearCallingAccount();
  keychain.set('authToken', 'new-account-token');
  await calls.ensureCredentials();
  expect(fetch.mock.calls).toEqual([['old-account-token'], ['new-account-token']]);
});

test('credentials fetched for the deleted account cannot configure the new account late', async () => {
  const response = deferred<Awaited<ReturnType<typeof api.apiTurnCredentials>>>();
  const started = deferred<void>();
  jest.spyOn(api, 'apiTurnCredentials').mockImplementationOnce(() => {
    started.resolve();
    return response.promise;
  }).mockResolvedValue({ iceServers: [], ttlSeconds: 3600 });
  const calls = callController();
  const old = calls.ensureCredentials();
  await started.promise;
  await clearCallingAccount();
  jest.mocked(native.configure).mockClear();
  response.resolve({ iceServers: [], ttlSeconds: 3600 });
  await old;
  expect(calls.hasRelay).toBe(false);
  expect(native.configure).not.toHaveBeenCalled();
  keychain.set('authToken', 'new-account-token');
  await calls.ensureCredentials();
  expect(calls.hasRelay).toBe(true);
  expect(native.configure).toHaveBeenCalledTimes(1);
});
