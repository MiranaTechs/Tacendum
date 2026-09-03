/**
 * ONE-TIME PREKEY REPLENISHMENT.
 *
 * The pool used to be uploaded exactly once, at register(); every inbound
 * session bootstrap consumes one server-side, and once the pool was empty
 * every new session to this device was signed-prekey-only for the life of
 * the install. `lowPrekeyCount` existed on the bundle DTO with no consumer.
 *
 * Two halves:
 *  - `registration.replenishPrekeys` — the mint-and-upload with its clock
 *    discipline: at most once a day on the schedule, at most once an hour
 *    from a low-pool signal (the server budgets PUT /v1/keys at 5 burst /
 *    10 per hour), never in duress, never without an identity,
 *    and a failed upload leaves no stamp so the next start asks again.
 *  - the trigger in `messaging.start()`, driven through the real messaging
 *    core against a fake native (the crypto mock) and a mocked api.
 *
 * Clock: `now` is injected into replenishPrekeys, so nothing here pins
 * Date.now beside a timer. */

jest.mock('../src/ws', () => {
  const handlers: { frame?: (f: unknown) => void; state?: (s: string) => void } = {};
  const calls = { start: jest.fn(), stop: jest.fn(), send: jest.fn((_frame: unknown) => true) };
  class WsClient {
    onFrame(cb: (f: unknown) => void) {
      handlers.frame = cb;
    }
    onState(cb: (s: string) => void) {
      handlers.state = cb;
    }
    start(token: string) {
      calls.start(token);
    }
    stop() {
      calls.stop();
    }
    send(frame: unknown) {
      return calls.send(frame) as boolean;
    }
    get isOpen() {
      return true;
    }
  }
  return { WsClient, __ws: { handlers, calls } };
});

jest.mock('../src/api', () => ({
  apiAuthChallenge: jest.fn(),
  apiAuth: jest.fn(),
  apiUploadKeys: jest.fn(),
  apiDeleteAccount: jest.fn(),
  apiGetPrekeyBundle: jest.fn().mockResolvedValue({}),
  apiCreateAttachment: jest.fn(),
  apiGetAttachmentUrl: jest.fn(),
  uploadBlob: jest.fn(),
  downloadBlob: jest.fn(),
}));

jest.mock('../src/decoy', () => ({
  syncDecoyProfile: jest.fn(async () => undefined),
}));

jest.mock('../src/db', () => ({
  listLinkedDevices: jest.fn(async () => []),
  listPeerDevices: jest.fn(async () => []),
  getPeerDevice: jest.fn(async () => null),
  upsertPeerDevice: jest.fn(async () => undefined),
  markChatOpened: jest.fn(async () => undefined),
  setLocalName: jest.fn(async () => undefined),
  replaceSiblingMachinePeers: jest.fn(async () => undefined),
  getChat: jest.fn(),
  getGroup: jest.fn(),
  hasSeen: jest.fn(),
  getMessage: jest.fn(),
  listOutbox: jest.fn(),
  listChats: jest.fn(),
  listMessages: jest.fn(),
  listAttachments: jest.fn(),
  listAttachmentMeta: jest.fn(),
  listRecentMessages: jest.fn(),
  listHeldRevisions: jest.fn(),
  takeHeldRevision: jest.fn(),
  listIdentityChanged: jest.fn(),
  listBlockedPeers: jest.fn(),
  getBlockedAt: jest.fn(),
  getBlockedMirrorDirty: jest.fn(),
  loadProfile: jest.fn(),
  saveProfile: jest.fn(),
  clearLocalState: jest.fn(),
  clearDecoyState: jest.fn(),
  chatsMissingMyProfile: jest.fn(),
  peerHasMyProfile: jest.fn(),
  insertMessage: jest.fn(),
  enqueueOutgoing: jest.fn(),
  touchChat: jest.fn(),
  upsertChat: jest.fn(),
  setChatPreview: jest.fn(),
  markSeen: jest.fn(),
  applyReceipt: jest.fn(),
  bumpOutboxAttempt: jest.fn(),
  deleteOutboxEnvelope: jest.fn(),
  markOutgoingError: jest.fn(),
  putAttachment: jest.fn(),
  sumAttachmentBytes: jest.fn(),
  sumAvatarBytes: jest.fn(),
  setReaction: jest.fn(),
  applyEdit: jest.fn(),
  tombstoneMessage: jest.fn(),
  holdRevision: jest.fn(),
  dropHeldRevision: jest.fn(),
  applyPeerProfile: jest.fn(),
  setPeerAvatar: jest.fn(),
  markMyProfileSent: jest.fn(),
  saveMyProfileCard: jest.fn(),
  setIdentityChanged: jest.fn(),
  setSafetyChecked: jest.fn(),
  setSafetyMismatch: jest.fn(),
  blockPeer: jest.fn(),
  unblockPeer: jest.fn(),
}));

jest.mock('../src/lock', () => ({ clearAll: jest.fn() }));

import { messaging } from '../src/messaging';
import {
  PREKEY_REPLENISH_INTERVAL_MS,
  PREKEY_REPLENISH_MIN_GAP_MS,
  PREKEY_REPLENISHED_AT_KEY,
  replenishPrekeys,
} from '../src/registration';
import { session } from '../src/session';

type Mocks = Record<string, jest.Mock>;

const db = jest.requireMock('../src/db') as Mocks;
const api = jest.requireMock('../src/api') as Mocks;
const crypto = jest.requireMock('tacendum-crypto') as Mocks & {
  __keychain: Map<string, string>;
};

const ME = '01HQSSSS00000000000000000S';
const NOW = 1_756_000_000_000;
const KEYS = {
  identityKey: 'QklHLUlERU5USVRZLUtFWQ==',
  registrationId: 4242,
  signedPrekey: { keyId: 1, pub: 'U1BL', sig: 'U0lH' },
  kyberPrekey: { keyId: 1, pub: 'S1lC', sig: 'S1NJRw==' },
  oneTimePrekeys: [{ keyId: 101, pub: 'T1RQ' }],
};

async function flush(turns = 120): Promise<void> {
  for (let i = 0; i < turns; i++) await Promise.resolve();
}

function stampedAt(): number | null {
  const raw = crypto.__keychain.get(PREKEY_REPLENISHED_AT_KEY);
  return raw === undefined ? null : Number(raw);
}

beforeEach(() => {
  session.setMode('real');
  crypto.__keychain.clear();
  crypto.hasIdentity.mockReset().mockResolvedValue(true);
  crypto.existingKeysForUpload.mockReset().mockResolvedValue(KEYS);
  api.apiUploadKeys!.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  messaging.stop();
  session.setMode('real');
  crypto.hasIdentity.mockReset().mockResolvedValue(false);
});

describe('replenishPrekeys', () => {
  test('a first run mints a fresh batch, uploads the full pool, and stamps the moment', async () => {
    await expect(replenishPrekeys('tok', { now: NOW })).resolves.toBe('uploaded');
    // The MINT, not a re-advertisement: existingKeysForUpload is the native
    // call that mints fresh ids and keeps the old private halves.
    expect(crypto.existingKeysForUpload).toHaveBeenCalledTimes(1);
    expect(crypto.generateAndStoreKeys).not.toHaveBeenCalled();
    expect(api.apiUploadKeys).toHaveBeenCalledWith('tok', KEYS);
    expect(stampedAt()).toBe(NOW);
  });

  test('the schedule: nothing inside 24 h, a fresh batch at 24 h', async () => {
    await replenishPrekeys('tok', { now: NOW });
    api.apiUploadKeys!.mockClear();
    crypto.existingKeysForUpload.mockClear();

    await expect(
      replenishPrekeys('tok', { now: NOW + PREKEY_REPLENISH_INTERVAL_MS - 1 }),
    ).resolves.toBe('skipped');
    expect(crypto.existingKeysForUpload).not.toHaveBeenCalled();
    expect(api.apiUploadKeys).not.toHaveBeenCalled();
    expect(stampedAt()).toBe(NOW);

    await expect(
      replenishPrekeys('tok', { now: NOW + PREKEY_REPLENISH_INTERVAL_MS }),
    ).resolves.toBe('uploaded');
    expect(api.apiUploadKeys).toHaveBeenCalledTimes(1);
    expect(stampedAt()).toBe(NOW + PREKEY_REPLENISH_INTERVAL_MS);
  });

  test('a low-pool signal waits only the hourly floor — and never less (the server budget)', async () => {
    await replenishPrekeys('tok', { now: NOW });
    api.apiUploadKeys!.mockClear();

    // Inside the hour: the budget is not spent on a second upload.
    await expect(
      replenishPrekeys('tok', { reason: 'low', now: NOW + PREKEY_REPLENISH_MIN_GAP_MS - 1 }),
    ).resolves.toBe('skipped');
    expect(api.apiUploadKeys).not.toHaveBeenCalled();

    // An hour on, well inside the daily schedule: the signal wins.
    await expect(
      replenishPrekeys('tok', { reason: 'low', now: NOW + PREKEY_REPLENISH_MIN_GAP_MS }),
    ).resolves.toBe('uploaded');
    expect(api.apiUploadKeys).toHaveBeenCalledTimes(1);
  });

  test('no identity: nothing to mint from, nothing touched', async () => {
    crypto.hasIdentity.mockResolvedValue(false);
    await expect(replenishPrekeys('tok', { now: NOW })).resolves.toBe('skipped');
    expect(crypto.existingKeysForUpload).not.toHaveBeenCalled();
    expect(api.apiUploadKeys).not.toHaveBeenCalled();
    expect(stampedAt()).toBeNull();
  });

  test('duress is network-silent: no mint, no upload, no stamp', async () => {
    session.setMode('duress');
    await expect(replenishPrekeys('tok', { now: NOW })).resolves.toBe('skipped');
    expect(crypto.hasIdentity).not.toHaveBeenCalled();
    expect(crypto.existingKeysForUpload).not.toHaveBeenCalled();
    expect(api.apiUploadKeys).not.toHaveBeenCalled();
    expect(stampedAt()).toBeNull();
  });

  test('a failed upload leaves no stamp, so the next start asks again', async () => {
    api.apiUploadKeys!.mockRejectedValueOnce(new Error('503'));
    await expect(replenishPrekeys('tok', { now: NOW })).rejects.toThrow('503');
    expect(stampedAt()).toBeNull();
    await expect(replenishPrekeys('tok', { now: NOW + 1 })).resolves.toBe('uploaded');
    expect(stampedAt()).toBe(NOW + 1);
  });

  test('a stamp from the future (the clock went backwards) does not hold the upload back', async () => {
    crypto.__keychain.set(PREKEY_REPLENISHED_AT_KEY, String(NOW + 10 * PREKEY_REPLENISH_INTERVAL_MS));
    await expect(replenishPrekeys('tok', { now: NOW })).resolves.toBe('uploaded');
    expect(stampedAt()).toBe(NOW);
  });
});

describe('the trigger in messaging.start()', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
    messaging.stop();
    for (const name of Object.keys(db)) {
      db[name]!.mockReset();
      db[name]!.mockResolvedValue(undefined);
    }
    for (const [name, value] of [
      ['getChat', undefined],
      ['getGroup', null],
      ['hasSeen', false],
      ['getMessage', null],
      ['listOutbox', []],
      ['listChats', []],
      ['listMessages', []],
      ['listAttachments', []],
      ['listAttachmentMeta', []],
      ['listRecentMessages', []],
      ['listHeldRevisions', []],
      ['takeHeldRevision', null],
      ['listIdentityChanged', []],
      ['listBlockedPeers', []],
      ['getBlockedAt', null],
      ['getBlockedMirrorDirty', false],
      ['loadProfile', null],
      ['chatsMissingMyProfile', []],
      ['peerHasMyProfile', false],
      ['listLinkedDevices', []],
      ['listPeerDevices', []],
      ['getPeerDevice', null],
    ] as Array<[string, unknown]>) {
      db[name]!.mockResolvedValue(value);
    }
    crypto.__keychain.set('authToken', 'tok');
  });

  afterEach(() => {
    messaging.stop();
    jest.useRealTimers();
  });

  test('a real session with an identity and no recent stamp uploads a fresh batch under its own token', async () => {
    await messaging.start(ME);
    await flush();
    expect(crypto.existingKeysForUpload).toHaveBeenCalledTimes(1);
    expect(api.apiUploadKeys).toHaveBeenCalledWith('tok', KEYS);
    expect(stampedAt()).toBe(NOW);
  });

  test('a stamp inside the day means no upload on this start', async () => {
    crypto.__keychain.set(PREKEY_REPLENISHED_AT_KEY, String(NOW - PREKEY_REPLENISH_INTERVAL_MS / 2));
    await messaging.start(ME);
    await flush();
    expect(crypto.existingKeysForUpload).not.toHaveBeenCalled();
    expect(api.apiUploadKeys).not.toHaveBeenCalled();
  });

  test('a device with no identity never reaches the mint', async () => {
    crypto.hasIdentity.mockResolvedValue(false);
    await messaging.start(ME);
    await flush();
    expect(crypto.existingKeysForUpload).not.toHaveBeenCalled();
    expect(api.apiUploadKeys).not.toHaveBeenCalled();
  });

  test('an upload that fails does not fail the session, and the stamp stays absent', async () => {
    api.apiUploadKeys!.mockRejectedValueOnce(new Error('503'));
    await expect(messaging.start(ME)).resolves.toBeUndefined();
    await flush();
    expect(api.apiUploadKeys).toHaveBeenCalledTimes(1);
    expect(stampedAt()).toBeNull();
  });
});
