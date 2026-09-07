jest.mock('../src/api', () => ({
  apiAuthChallenge: jest.fn(), apiAuth: jest.fn(), apiUploadKeys: jest.fn(),
  apiDeleteAccount: jest.fn(),
}));
export {};
jest.mock('../src/db', () => ({
  loadProfile: jest.fn(), saveProfile: jest.fn(), clearLocalState: jest.fn(),
  clearDecoyState: jest.fn(),
}));
jest.mock('../src/call', () => ({
  endCallOnQuiesce: jest.fn(async () => undefined), disposeGroupCall: jest.fn(), quiesceCallMetrics: jest.fn(),
  clearCallingAccount: jest.fn(async () => undefined),
  bindCallingAccount: jest.fn(async () => undefined),
}));
jest.mock('../src/messaging', () => ({
  ...jest.requireActual('../src/reauth'), messaging: { stop: jest.fn() },
}));
jest.mock('../src/lock', () => ({ clearAll: jest.fn(async () => undefined) }));
jest.mock('../src/aiWritingService', () => ({
  clearWritingConnections: jest.fn(), invalidateWritingSession: jest.fn(),
}));

const MARKER = 'accountDeletion';
const USER_ID = '01KYDBSSDJSPC9J0E5N2AWMJ5Y';
const PROFILE = { userId: USER_ID, registrationId: 7, displayName: 'Me',
  about: '', avatarB64: '', profileVersion: 1 };
type Mocks = Record<string, jest.Mock>;
let reg: typeof import('../src/registration');
let reauth: typeof import('../src/reauth');
let api: Mocks;
let db: Mocks;
let crypto: Mocks & { __keychain: Map<string, string> };
beforeEach(() => {
  jest.resetModules();
  api = jest.requireMock('../src/api');
  db = jest.requireMock('../src/db');
  crypto = jest.requireMock('tacendum-crypto');
  reg = jest.requireActual('../src/registration');
  reauth = jest.requireActual('../src/reauth');
  jest.requireActual('../src/session').session.setMode('real');
  crypto.__keychain.set('authToken', 'old-token');
  crypto.identityPublicKey.mockResolvedValue('identity');
  crypto.hasIdentity.mockResolvedValue(true);
  db.loadProfile.mockResolvedValue(PROFILE);
  db.clearLocalState.mockImplementation(async () => { db.loadProfile.mockResolvedValue(null); });
  db.clearDecoyState.mockResolvedValue(undefined);
  api.apiAuthChallenge.mockResolvedValue({ challenge: 'challenge' });
  api.apiAuth.mockResolvedValue({ userId: USER_ID, authToken: 'renewed' });
  api.apiDeleteAccount.mockResolvedValue(undefined);
});

function failure(status: number, code: string) {
  return Object.assign(new Error(code), { name: 'ApiRequestError', status, code });
}

test('failed deletion preserves data and permits later ordinary renewal', async () => {
  api.apiDeleteAccount.mockRejectedValue(new Error('offline'));
  await expect(reg.deleteAccount()).rejects.toThrow();
  expect(db.clearLocalState).not.toHaveBeenCalled();
  expect(crypto.resetProtocolState).not.toHaveBeenCalled();
  expect(await reauth.reauthenticate('old-token')).toBe('ok');
});

test('missing bearer must prove and delete the existing ID before clearing anything', async () => {
  crypto.__keychain.delete('authToken');
  await reg.deleteAccount();
  expect(api.apiAuth).toHaveBeenCalledWith('identity', 'challenge', expect.any(String), USER_ID);
  expect(api.apiDeleteAccount).toHaveBeenCalledWith('renewed');
  expect(db.clearLocalState).toHaveBeenCalled();
});

test('expired bearer renews the same ID and retries deletion once', async () => {
  api.apiDeleteAccount.mockRejectedValueOnce(failure(401, 'unauthorized'));
  await reg.deleteAccount();
  expect(api.apiDeleteAccount.mock.calls).toEqual([['old-token'], ['renewed']]);
  expect(crypto.__keychain.has('authToken')).toBe(false);
});

test('intent is durable before DELETE and surviving cleanup failure keeps setup blocked', async () => {
  api.apiDeleteAccount.mockImplementation(async () => {
    expect(JSON.parse(crypto.__keychain.get(MARKER)!)).toMatchObject({ phase: 'requested', userId: USER_ID });
  });
  crypto.resetProtocolState.mockRejectedValueOnce(new Error('store refused wipe'));
  await expect(reg.deleteAccount()).rejects.toThrow('account_cleanup_pending');
  expect(crypto.__keychain.has(MARKER)).toBe(true);
  expect(crypto.__keychain.has('authToken')).toBe(false);
  // A new setup must finish erasing the old identity before it can mint.
  crypto.resetProtocolState.mockRejectedValueOnce(new Error('still unwritable'));
  await expect(reg.createOrRestoreAccount()).rejects.toThrow('account_cleanup_pending');
  expect(crypto.generateAndStoreKeys).not.toHaveBeenCalled();
});

test('confirmed deletion resumes local cleanup without a second network request', async () => {
  crypto.__keychain.set(MARKER, JSON.stringify({ phase: 'confirmed', userId: USER_ID }));
  await reg.deleteAccount();
  expect(api.apiDeleteAccount).not.toHaveBeenCalled();
  expect(crypto.resetProtocolState).toHaveBeenCalled();
  expect(crypto.__keychain.has(MARKER)).toBe(false);
});

test('account deletion clears the native call owner before identity or database erasure', async () => {
  const calls = jest.requireMock('../src/call') as Mocks;
  calls.clearCallingAccount.mockImplementation(async () => {
    expect(db.clearLocalState).not.toHaveBeenCalled();
    expect(crypto.resetProtocolState).not.toHaveBeenCalled();
  });
  await reg.deleteAccount();
  expect(calls.clearCallingAccount).toHaveBeenCalledTimes(1);
});

test('a failed native call reset keeps setup blocked until reset succeeds', async () => {
  const calls = jest.requireMock('../src/call') as Mocks;
  calls.clearCallingAccount.mockRejectedValueOnce(new Error('native reset unavailable'));
  await expect(reg.deleteAccount()).rejects.toThrow('account_cleanup_pending');
  expect(crypto.__keychain.has(MARKER)).toBe(true);
  expect(crypto.resetProtocolState).not.toHaveBeenCalled();
  calls.clearCallingAccount.mockResolvedValue(undefined);
  await reg.deleteAccount();
  expect(crypto.__keychain.has(MARKER)).toBe(false);
});

test('duress beginning while hangup settles preserves the real native owner', async () => {
  const calls = jest.requireMock('../src/call') as Mocks;
  calls.endCallOnQuiesce.mockImplementationOnce(async () => {
    jest.requireActual('../src/session').session.setMode('duress');
  });
  await expect(reg.deleteAccount()).rejects.toThrow();
  expect(calls.clearCallingAccount).not.toHaveBeenCalled();
  expect(db.clearLocalState).not.toHaveBeenCalled();
  expect(crypto.__keychain.has(MARKER)).toBe(true);
});

test.each([[409, 'account_gone'], [403, 'identity_tombstoned'], [409, 'account_conflict']])(
  'ambiguous signed-auth refusal %s %s preserves deletion proof until explicit local erasure', async (status, code) => {
  crypto.__keychain.set(MARKER, JSON.stringify({ phase: 'requested', userId: USER_ID }));
  api.apiDeleteAccount.mockRejectedValue(failure(401, 'unauthorized'));
  api.apiAuth.mockRejectedValue(failure(status as number, code as string));
  await expect(reg.deleteAccount()).rejects.toThrow(code as string);
  expect(api.apiAuth).toHaveBeenCalledWith('identity', 'challenge', expect.any(String), USER_ID);
  expect(crypto.resetProtocolState).not.toHaveBeenCalled();
  expect(crypto.__keychain.get('authToken')).toBe('old-token');
  expect(JSON.parse(crypto.__keychain.get(MARKER)!)).toMatchObject({ phase: 'requested' });
  expect(reauth.accountGone()).toBe(true);

  // The same refusal can describe a mismatched live account. Cleanup is
  // local-only and requires the separate explicit fresh-start operation.
  crypto.resetProtocolState.mockImplementationOnce(async () => {
    expect(JSON.parse(crypto.__keychain.get(MARKER)!)).toMatchObject({ phase: 'local-only' });
  });
  await reg.clearGoneAccount();
  expect(crypto.__keychain.has(MARKER)).toBe(false);
});

test('a failure to persist intent prevents the destructive network request', async () => {
  crypto.setSecret.mockImplementationOnce(async () => { throw new Error('keychain unavailable'); });
  await expect(reg.deleteAccount()).rejects.toThrow();
  expect(api.apiDeleteAccount).not.toHaveBeenCalled();
  expect(db.clearLocalState).not.toHaveBeenCalled();
});

test('an offline retry of an uncertain deletion never wipes the remaining identity', async () => {
  crypto.__keychain.set(MARKER, JSON.stringify({ phase: 'requested', userId: USER_ID }));
  api.apiDeleteAccount.mockRejectedValue(new Error('offline'));
  await expect(reg.deleteAccount()).rejects.toThrow();
  expect(crypto.resetProtocolState).not.toHaveBeenCalled();
  expect(crypto.__keychain.has('authToken')).toBe(true);
});

test('a confirmed-marker write failure retains identity proof for the next retry', async () => {
  const write = crypto.setSecret.getMockImplementation()!;
  crypto.setSecret.mockImplementation(async (key, value) => {
    if (key === MARKER && JSON.parse(value).phase === 'confirmed') throw new Error('write refused');
    return write(key, value);
  });
  await expect(reg.deleteAccount()).rejects.toThrow('account_cleanup_pending');
  expect(JSON.parse(crypto.__keychain.get(MARKER)!)).toMatchObject({ phase: 'requested' });
  expect(crypto.resetProtocolState).not.toHaveBeenCalled();
  expect(crypto.__keychain.get('authToken')).toBe('old-token');
});

test('a database wipe failure cannot prevent identity/token erasure or drop the retry marker', async () => {
  db.clearLocalState.mockRejectedValueOnce(new Error('database unwritable'));
  await expect(reg.deleteAccount()).rejects.toThrow('account_cleanup_pending');
  expect(crypto.resetProtocolState).toHaveBeenCalled();
  expect(crypto.__keychain.has('authToken')).toBe(false);
  expect(crypto.__keychain.has(MARKER)).toBe(true);
  await reg.deleteAccount();
  expect(crypto.__keychain.has(MARKER)).toBe(false);
});

test('duress beginning while DELETE is in flight defers all real cleanup', async () => {
  api.apiDeleteAccount.mockImplementation(async () => {
    jest.requireActual('../src/session').session.setMode('duress');
  });
  await expect(reg.deleteAccount()).rejects.toThrow('account_cleanup_pending');
  expect(db.clearLocalState).not.toHaveBeenCalled();
  expect(crypto.resetProtocolState).not.toHaveBeenCalled();
  expect(crypto.__keychain.get('authToken')).toBe('old-token');
});

test('a lost-key reinstall can explicitly start locally fresh without claiming remote deletion', async () => {
  crypto.hasIdentity.mockResolvedValue(false);
  crypto.__keychain.set(MARKER, '{malformed-old-intent');
  await reg.clearGoneAccount();
  expect(api.apiAuth).not.toHaveBeenCalled();
  expect(api.apiDeleteAccount).not.toHaveBeenCalled();
  expect(crypto.__keychain.has(MARKER)).toBe(false);
});

test('local fresh start refuses a live identity and every duress session', async () => {
  await expect(reg.clearGoneAccount()).rejects.toThrow('account_not_gone');
  crypto.hasIdentity.mockResolvedValue(false);
  jest.requireActual('../src/session').session.setMode('duress');
  await expect(reg.clearGoneAccount()).rejects.toThrow(/offline/);
  expect(crypto.resetProtocolState).not.toHaveBeenCalled();
});

test('reinstall clears bearer-only residue, but preserves the proof for a pending deletion', async () => {
  crypto.hasIdentity.mockResolvedValue(false);
  await reg.clearStaleInstallationCredentials();
  expect(crypto.__keychain.has('authToken')).toBe(false);
  crypto.__keychain.set('authToken', 'deletion-proof');
  crypto.__keychain.set(MARKER, JSON.stringify({ phase: 'requested', userId: USER_ID }));
  await reg.clearStaleInstallationCredentials();
  expect(crypto.__keychain.get('authToken')).toBe('deletion-proof');
});

test('ordinary reinstall with a surviving identity preserves its bearer', async () => {
  await reg.clearStaleInstallationCredentials();
  expect(crypto.__keychain.get('authToken')).toBe('old-token');
});
