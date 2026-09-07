jest.mock('../src/api', () => ({
  apiAuthChallenge: jest.fn(),
  apiAuth: jest.fn(),
  apiUploadKeys: jest.fn(),
  apiDeleteAccount: jest.fn(),
}));

jest.mock('../src/db', () => ({
  // Device-set defaults: the reads every send
  // and receive now consults — an EMPTY world here, so suites predating
  // multi-device keep exercising the single-leg wire byte-for-byte. A suite
  // that defines its own version below wins (later keys override).
  listLinkedDevices: jest.fn(async () => []),
  listPeerDevices: jest.fn(async () => []),
  getPeerDevice: jest.fn(async () => null),
  upsertPeerDevice: jest.fn(async () => undefined),
  blockPeer: jest.fn(async () => undefined),
  markChatOpened: jest.fn(async () => undefined),
  setLocalName: jest.fn(async () => undefined),
  replaceSiblingMachinePeers: jest.fn(async () => undefined),
  loadProfile: jest.fn(),
  saveProfile: jest.fn(),
  clearLocalState: jest.fn(),
  clearDecoyState: jest.fn(),
}));

jest.mock('../src/lock', () => ({ clearAll: jest.fn() }));

import * as api from '../src/api';
import * as db from '../src/db';
import {
  AccountMismatchError,
  createOrRestoreAccount,
  IdentityLostError,
} from '../src/registration';
import { session } from '../src/session';
import { accountGone, resetAccountReauth } from '../src/reauth';

/**
 * The half-states of registration, mapped by a state-table analysis.
 *
 * The invariant every test here serves: THE IDENTITY KEY IS THE ACCOUNT and
 * it cannot be regenerated — the server's claim row binds it to one userId
 * forever, so a fresh keypair is a different account with every safety number
 * broken. The old code had one branch that destroyed an identity and one that
 * silently replaced it; both are gone, and these pin the shapes that used to
 * reach them.
 */

type Mocks = Record<string, jest.Mock>;
const apiM = api as unknown as Mocks;
const dbM = db as unknown as Mocks;
const crypto = jest.requireMock('tacendum-crypto') as Mocks & {
  __keychain: Map<string, string>;
};

const IDENTITY_KEY = 'QklHLUlERU5USVRZLUtFWQ==';
const KEYS = {
  identityKey: IDENTITY_KEY,
  registrationId: 4242,
  signedPrekey: { keyId: 1, pub: 'U1BL', sig: 'U0lH' },
  kyberPrekey: { keyId: 1, pub: 'S1lC', sig: 'S1NJRw==' },
  oneTimePrekeys: [{ keyId: 3, pub: 'T1RQ' }],
};
const PROFILE = {
  userId: 'OLD-USER-ULID',
  registrationId: 4242,
  displayName: 'Me',
  about: '',
  avatarB64: '',
  profileVersion: 3,
};

beforeEach(() => {
  resetAccountReauth();
  jest.clearAllMocks();
  session.setMode('real');
  crypto.__keychain.clear();
  crypto.hasIdentity.mockResolvedValue(false);
  crypto.existingKeysForUpload.mockResolvedValue(KEYS);
  crypto.generateAndStoreKeys.mockResolvedValue(KEYS);
  dbM.loadProfile!.mockResolvedValue(null);
  apiM.apiAuthChallenge!.mockResolvedValue({ challenge: 'Q0g=', expiresAt: 0 });
  apiM.apiAuth!.mockResolvedValue({ userId: 'OLD-USER-ULID', authToken: 'tok' });
  apiM.apiUploadKeys!.mockResolvedValue(undefined);
});

afterEach(() => {
  crypto.hasIdentity.mockResolvedValue(false);
});

test('a profile with no identity behind it is TERMINAL, and nothing is touched', async () => {
  // The restore-to-new-phone shape: SQLite rides the backup, the protocol
  // store deliberately does not. The old code minted a fresh keypair here and
  // silently rebound the profile — every chat visible, every peer pinning a
  // dead key, nothing deliverable. Now it says so and stops.
  crypto.hasIdentity.mockResolvedValue(false);
  dbM.loadProfile!.mockResolvedValue(PROFILE);

  await expect(createOrRestoreAccount()).rejects.toThrow(IdentityLostError);

  expect(crypto.generateAndStoreKeys).not.toHaveBeenCalled();
  expect(crypto.resetProtocolState).not.toHaveBeenCalled();
  expect(apiM.apiAuth).not.toHaveBeenCalled();
  expect(dbM.saveProfile).not.toHaveBeenCalled();
  expect(crypto.__keychain.has('authToken')).toBe(false);
});

test('an identity with no profile is RECOVERED, never reset', async () => {
  // The branch that used to destroy an identity — justified by "the upload
  // payload cannot be reconstructed", which the CLI had already disproven.
  // A reinstall whose App Group container outlived the app lands here holding
  // a live, fully-registered identity; authenticating it returns the same
  // userId and the profile is rebuilt around it.
  crypto.hasIdentity.mockResolvedValue(true);
  dbM.loadProfile!.mockResolvedValue(null);
  apiM.apiAuth!.mockResolvedValue({ userId: 'SAME-USER-ULID', authToken: 'tok' });

  const profile = await createOrRestoreAccount();

  expect(crypto.resetProtocolState).not.toHaveBeenCalled();
  expect(crypto.generateAndStoreKeys).not.toHaveBeenCalled();
  expect(apiM.apiAuthChallenge).toHaveBeenCalledWith(IDENTITY_KEY);
  // The rebuilt profile carries the store's REAL registrationId, not 0 — the
  // id rides inside every session this device builds.
  expect(profile.userId).toBe('SAME-USER-ULID');
  expect(profile.registrationId).toBe(4242);
});

test('the existing bundle is re-uploaded — the repair for the lost-upload crash window', async () => {
  crypto.hasIdentity.mockResolvedValue(true);
  dbM.loadProfile!.mockResolvedValue(null);

  await createOrRestoreAccount();

  expect(apiM.apiUploadKeys).toHaveBeenCalledWith(
    'tok',
    expect.objectContaining({ identityKey: IDENTITY_KEY }),
  );
});

test('the token is persisted only AFTER the upload lands', async () => {
  // Fail the upload and nothing local may change: the boot heal keys off a
  // MISSING token, so a token written first would mean a device that
  // authenticates perfectly and never repairs its bundle.
  crypto.hasIdentity.mockResolvedValue(true);
  dbM.loadProfile!.mockResolvedValue(null);
  apiM.apiUploadKeys!.mockRejectedValue(new Error('network died'));

  await expect(createOrRestoreAccount()).rejects.toThrow('network died');

  expect(crypto.__keychain.has('authToken')).toBe(false);
  expect(dbM.saveProfile).not.toHaveBeenCalled();
});

test('an identity that answers for a DIFFERENT account than the profile is terminal', async () => {
  // Two mismatched halves must not be silently welded into one wrong whole.
  // Thrown before the token, the upload and the profile write.
  crypto.hasIdentity.mockResolvedValue(true);
  dbM.loadProfile!.mockResolvedValue(PROFILE);
  apiM.apiAuth!.mockResolvedValue({ userId: 'DIFFERENT-ULID', authToken: 'tok' });

  await expect(createOrRestoreAccount()).rejects.toThrow(AccountMismatchError);

  expect(crypto.__keychain.has('authToken')).toBe(false);
  expect(apiM.apiUploadKeys).not.toHaveBeenCalled();
  expect(dbM.saveProfile).not.toHaveBeenCalled();
});

test('a genuinely fresh install still mints', async () => {
  crypto.hasIdentity.mockResolvedValue(false);
  dbM.loadProfile!.mockResolvedValue(null);
  apiM.apiAuth!.mockResolvedValue({ userId: 'NEW-USER-ULID', authToken: 'tok' });

  const profile = await createOrRestoreAccount();

  expect(crypto.generateAndStoreKeys).toHaveBeenCalled();
  expect(crypto.existingKeysForUpload).not.toHaveBeenCalled();
  expect(profile.userId).toBe('NEW-USER-ULID');
  expect(profile.registrationId).toBe(4242);
});

test('duress still refuses before anything at all', async () => {
  // The load-bearing first line. The protocol store is not workspace-switched,
  // so a duress session sees the REAL identity — and with the reset branch
  // gone this guard is what keeps a coerced "Get started" from even
  // AUTHENTICATING the real identity from inside the decoy.
  session.setMode('duress');
  crypto.hasIdentity.mockResolvedValue(true);

  await expect(createOrRestoreAccount()).rejects.toThrow(/offline/i);

  expect(apiM.apiAuthChallenge).not.toHaveBeenCalled();
  expect(crypto.existingKeysForUpload).not.toHaveBeenCalled();
  session.setMode('real');
});

test('duress beginning during registration stops before the next packet or profile write', async () => {
  crypto.hasIdentity.mockResolvedValue(true);
  apiM.apiAuthChallenge!.mockImplementationOnce(async () => {
    session.setMode('duress');
    return { challenge: 'Q0g=', expiresAt: 0 };
  });
  await expect(createOrRestoreAccount()).rejects.toThrow(/offline/i);
  expect(apiM.apiAuth).not.toHaveBeenCalled();
  expect(dbM.saveProfile).not.toHaveBeenCalled();
  expect(crypto.__keychain.has('authToken')).toBe(false);
});

test('a deleted account during boot restoration surfaces the fresh-start exit', async () => {
  crypto.hasIdentity.mockResolvedValue(true);
  dbM.loadProfile!.mockResolvedValue(PROFILE);
  apiM.apiAuth!.mockRejectedValueOnce(Object.assign(new Error('account_gone'), {
    name: 'ApiRequestError', status: 409, code: 'account_gone',
  }));
  await expect(createOrRestoreAccount()).rejects.toThrow('account_gone');
  expect(accountGone()).toBe(true);
  expect(crypto.__keychain.has('authToken')).toBe(false);
  expect(dbM.saveProfile).not.toHaveBeenCalled();
});
