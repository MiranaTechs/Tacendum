/**
 * Boot with a profile on disk and no auth token — the state that used to be
 * diagnosed as damage and WIPED.
 *
 * Under phone accounts that wipe was defensible: profile and token were
 * written together, so one without the other was an inconsistent half-state,
 * and re-registering the same number handed back the same userId anyway.
 *
 * Under keypair accounts it destroys the account outright, and the mechanism
 * is worth naming because nothing about it is obvious from the call site:
 * `clearLocalState()` empties the SQLite tables but CANNOT touch the identity
 * keypair, which lives in the native protocol store and the Keychain. So the
 * wipe leaves keys with no profile — and that is precisely the shape
 * `createOrRestoreAccount` treats as a never-finished install, so the next tap
 * mints a FRESH keypair. The server's `idkey#` claim row makes that a
 * different account: old userId unreachable, every peer's safety number
 * broken, nothing to recover with (cost table row 3).
 *
 * The fix is not a better wipe, it is the observation that this state is not
 * damage at all: the identity is intact, so re-authenticating it returns the
 * SAME userId ("known key → look up"). This file pins that.
 */

jest.mock('../src/ws', () => {
  const calls = {
    start: jest.fn(),
    stop: jest.fn(),
    send: jest.fn((_frame: unknown) => true),
  };
  class WsClient {
    onFrame(_cb: (f: unknown) => void) {}
    onState(_cb: (s: string) => void) {}
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
      return false;
    }
  }
  return { WsClient, __ws: { calls } };
});

jest.mock('../src/api', () => ({
  onApiAuthRenewed: jest.fn(() => () => undefined),
  apiAuthChallenge: jest.fn(),
  apiAuth: jest.fn(),
  apiUploadKeys: jest.fn().mockRejectedValue(new Error('network in test')),
  apiGetPrekeyBundle: jest.fn().mockRejectedValue(new Error('network in test')),
  apiDeleteAccount: jest.fn().mockRejectedValue(new Error('network in test')),
  apiCreateAttachment: jest.fn().mockRejectedValue(new Error('network in test')),
  apiGetAttachmentUrl: jest.fn().mockRejectedValue(new Error('network in test')),
  apiTurnCredentials: jest.fn().mockRejectedValue(new Error('network in test')),
  apiRegisterPushToken: jest.fn().mockRejectedValue(new Error('network in test')),
  uploadBlob: jest.fn().mockRejectedValue(new Error('network in test')),
  downloadBlob: jest.fn().mockRejectedValue(new Error('network in test')),
}));

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import App from '../App';
import * as db from '../src/db';
import { AUTH_TOKEN_KEY, messaging } from '../src/messaging';
import { session } from '../src/session';
import { API_BASE } from '../src/config';

interface FakeDb {
  name: string;
  execute: jest.Mock;
  close: jest.Mock;
}
const sqlite = (
  jest.requireMock('@op-engineering/op-sqlite') as {
    __sqlite: {
      opened: string[];
      instances: Map<string, FakeDb>;
      reset: () => void;
    };
  }
).__sqlite;
const crypto = jest.requireMock('tacendum-crypto') as {
  __keychain: Map<string, string>;
  hasIdentity: jest.Mock;
  identityPublicKey: jest.Mock;
  existingKeysForUpload: jest.Mock;
  generateAndStoreKeys: jest.Mock;
  resetProtocolState: jest.Mock;
  signAuthChallenge: jest.Mock;
};
const api = jest.requireMock('../src/api') as {
  apiAuthChallenge: jest.Mock;
  apiAuth: jest.Mock;
  apiUploadKeys: jest.Mock;
};

const USER_ID = '01KYDBSSDJSPC9J0E5N2AWMJ5Y';
const IDENTITY_KEY = 'BQ0IDENTITYKEYBASE64';

/** A real workspace holding a finished account: profile rows, and nothing to
 * say about anything else. */
function seedRealWorkspaceWithProfile(): FakeDb {
  const instance: FakeDb = {
    name: 'tacendum.sqlite',
    execute: jest.fn(async (sql: string) => {
      const s = String(sql);
      if (s.includes('FROM profile')) {
        return {
          rows: [
            { key: 'userId', value: USER_ID },
            { key: 'registrationId', value: '7' },
            { key: 'displayName', value: 'Me' },
            { key: 'about', value: '' },
            { key: 'avatarB64', value: '' },
            { key: 'profileVersion', value: '3' },
          ],
        };
      }
      if (s.includes('PRAGMA table_info(attachments')) {
        return { rows: [{ name: 'direction' }] };
      }
      if (s.includes('PRAGMA table_info(reactions')) {
        // BOTH columns the rebuild loop checks. An answer missing one reads as
        // 'old shape on disk', so initSchema drops the table and re-enters
        // itself forever — a 4 GB heap death, not a red test, which is why a
        // stale mock here is so expensive to diagnose.
        return { rows: [{ name: 'targetDirection' }, { name: 'reactorId' }] };
      }
      if (s.includes('PRAGMA table_info(pending_revisions')) {
        return { rows: [{ name: 'writerId' }] };
      }
      return { rows: [] };
    }),
    close: jest.fn(),
  };
  sqlite.instances.set('tacendum.sqlite', instance);
  return instance;
}

const mounted: ReactTestRenderer.ReactTestRenderer[] = [];

async function renderApp(): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<App />);
  });
  mounted.push(tree);
  return tree;
}

beforeEach(async () => {
  messaging.stop();
  await db.close();
  db.setWorkspace('real');
  session.setMode('real');
  crypto.__keychain.clear();
  sqlite.reset();
  crypto.hasIdentity.mockClear().mockResolvedValue(true);
  crypto.identityPublicKey.mockClear().mockResolvedValue(IDENTITY_KEY);
  // The heal now rebuilds the upload payload from the records on disk and
  // re-uploads it (idempotent server-side), rather than uploading only when
  // it minted — which is precisely what lets it NEVER mint over an existing
  // identity.
  crypto.existingKeysForUpload.mockClear().mockResolvedValue({
    identityKey: IDENTITY_KEY,
    registrationId: 7,
    signedPrekey: { keyId: 1, pub: 'U1BL', sig: 'U0lH' },
    kyberPrekey: { keyId: 1, pub: 'S1lC', sig: 'S1NJRw==' },
    oneTimePrekeys: [],
  });
  api.apiUploadKeys.mockClear().mockResolvedValue(undefined);
  crypto.generateAndStoreKeys.mockClear();
  crypto.resetProtocolState.mockClear();
  crypto.signAuthChallenge.mockClear();
  api.apiAuthChallenge
    .mockClear()
    .mockResolvedValue({ challenge: 'Q0hBTExFTkdF', expiresAt: 0 });
  api.apiAuth
    .mockClear()
    .mockResolvedValue({ userId: USER_ID, authToken: 'fresh-token' });
});

afterEach(async () => {
  await ReactTestRenderer.act(async () => {
    while (mounted.length) mounted.pop()!.unmount();
  });
  // Restore the shared mock's defaults for every other suite in the run.
  crypto.hasIdentity.mockResolvedValue(false);
  crypto.identityPublicKey.mockResolvedValue(null);
});

test('a profile with no token re-authenticates the same identity instead of wiping', async () => {
  const real = seedRealWorkspaceWithProfile();
  // No auth token: messaging.start throws, which is how boot reaches the
  // recovery branch at all.
  expect(crypto.__keychain.has(AUTH_TOKEN_KEY)).toBe(false);

  await renderApp();

  // It signed the server's nonce with the identity ALREADY on the device…
  expect(api.apiAuthChallenge).toHaveBeenCalledWith(IDENTITY_KEY);
  expect(crypto.signAuthChallenge).toHaveBeenCalledWith('Q0hBTExFTkdF', API_BASE);
  expect(api.apiAuth).toHaveBeenCalledWith(
    IDENTITY_KEY,
    'Q0hBTExFTkdF',
    'sig(Q0hBTExFTkdF)',
  );
  // …and never minted a second one, which would have been a second account.
  expect(crypto.generateAndStoreKeys).not.toHaveBeenCalled();
  expect(crypto.resetProtocolState).not.toHaveBeenCalled();
  expect(crypto.__keychain.get(AUTH_TOKEN_KEY)).toBe('fresh-token');
  // The existing bundle went back up — the repair for the crash window where
  // auth once succeeded but the key upload never ran.
  expect(api.apiUploadKeys).toHaveBeenCalledWith(
    'fresh-token',
    expect.objectContaining({ identityKey: IDENTITY_KEY }),
  );

  // Nothing was destroyed. The only sanctioned deletion on this path is the
  // one-row phone purge saveProfile does; a wipe
  // would show up here as DELETE FROM messages / chats / everything else.
  // UNBOUNDED deletes only, which is what a wipe is: `clearLocalState` issues
  // `DELETE FROM <table>` with no WHERE, once per table. Bounded ones are
  // ordinary housekeeping — `adoptWorkspaceForCalling` prunes expired call
  // offers and stale call-session rows by TTL on every real unlock — and
  // counting those as destruction would fail this test on a healthy boot.
  const deletes = real.execute.mock.calls
    .map(c => String(c[0]))
    // The durable metric queue's seven-day retention pass runs on a real
    // authenticated adoption too; like the phone purge it carries a WHERE, so
    // the unbounded-only rule already excludes it without naming it.
    .filter(s => s.startsWith('DELETE FROM') && !/\bWHERE\b/i.test(s));
  expect(deletes).toEqual([]);
});

test('a re-auth that fails destroys nothing and leaves the identity intact', async () => {
  const real = seedRealWorkspaceWithProfile();
  api.apiAuthChallenge.mockRejectedValue(new Error('offline'));

  await renderApp();

  // Offline is not damage: the keys, the history and the profile all stay put
  // so the next launch (or "Get started", which runs the same call) can heal.
  expect(crypto.generateAndStoreKeys).not.toHaveBeenCalled();
  expect(crypto.resetProtocolState).not.toHaveBeenCalled();
  // Unbounded deletes only — see the note on the sibling test above.
  const deletes = real.execute.mock.calls
    .map(c => String(c[0]))
    .filter(s => s.startsWith('DELETE FROM') && !/\bWHERE\b/i.test(s));
  expect(deletes).toEqual([]);
});
