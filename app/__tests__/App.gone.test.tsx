/**
 * The one thing a silent re-auth may not be silent about.
 *
 * Renewal is invisible by design. But 403 `identity_tombstoned` and 409
 * `account_conflict` mean the signature VERIFIED and there is still no account
 * behind it — a revoked integration key, or an account that was deleted. Left
 * unsaid, the app shows "Offline" over a phone that is signed in as nobody and
 * has (correctly) stopped retrying: the same silent death this work exists to
 * end, only quieter.
 *
 * And it must not follow a duress unlock into the decoy, where it would be a
 * statement about a workspace the coercer is not supposed to know exists.
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
  apiAuthChallenge: jest.fn(),
  apiAuth: jest.fn(),
  apiProbeSession: jest.fn(),
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
import { messaging } from '../src/messaging';
import { reauthenticate, accountGone, resetAccountReauth, resumeReauth } from '../src/reauth';
import { session } from '../src/session';

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
  identityPublicKey: jest.Mock;
};
const api = jest.requireMock('../src/api') as {
  apiAuthChallenge: jest.Mock;
  apiAuth: jest.Mock;
  apiDeleteAccount: jest.Mock;
};

const IDENTITY_KEY = 'BQ0IDENTITYKEYBASE64';

const mounted: ReactTestRenderer.ReactTestRenderer[] = [];

async function renderApp(): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<App />);
  });
  mounted.push(tree);
  return tree;
}

async function press(
  tree: ReactTestRenderer.ReactTestRenderer,
  testID: string,
): Promise<void> {
  await ReactTestRenderer.act(async () => {
    tree.root.findByProps({ testID }).props.onPress();
  });
}

/** Drive the terminal answer through the real module, so what is rendered is
 * what the transport would actually have latched. */
async function tombstone(): Promise<void> {
  await db.initDb();
  await ReactTestRenderer.act(async () => {
    await reauthenticate('stale-token');
  });
}

beforeEach(async () => {
  resetAccountReauth();
  resumeReauth();
  messaging.stop();
  await db.close();
  db.setWorkspace('real');
  session.setMode('real');
  crypto.__keychain.clear();
  sqlite.reset();
  crypto.identityPublicKey.mockClear().mockResolvedValue(IDENTITY_KEY);
  api.apiAuthChallenge
    .mockClear()
    .mockResolvedValue({ challenge: 'Q0hBTExFTkdF', expiresAt: 0 });
  const revoked = new Error('this identity key has been revoked') as Error & {
    status: number;
    code: string;
  };
  revoked.name = 'ApiRequestError';
  revoked.status = 403;
  revoked.code = 'identity_tombstoned';
  api.apiAuth.mockClear().mockRejectedValue(revoked);
});

afterEach(async () => {
  await ReactTestRenderer.act(async () => {
    while (mounted.length) mounted.pop()!.unmount();
  });
  crypto.identityPublicKey.mockResolvedValue(null);
});

test('a revoked identity surfaces instead of reading as "Offline" forever', async () => {
  const tree = await renderApp();
  expect(tree.root.findAllByProps({ testID: 'account-gone' })).toHaveLength(0);

  await tombstone();

  expect(accountGone()).toBe(true);
  expect(
    tree.root.findAllByProps({ testID: 'account-gone' }).length,
  ).toBeGreaterThan(0);
});

test('a duress session never inherits the sheet', async () => {
  // The latch is process-wide and terminal, so it OUTLIVES the relock that a
  // coerced unlock follows. Rendering it in the decoy would say out loud that
  // this phone has another account on it.
  await tombstone();
  expect(accountGone()).toBe(true);

  crypto.__keychain.set('lock.enabled', '1');
  crypto.__keychain.set('lock.passcode', '123456');
  const tree = await renderApp();
  for (const key of ['6', '5', '4', '3', '2', '1']) {
    await press(tree, `pin-key-${key}`);
  }
  await press(tree, 'pin-submit');

  expect(session.mode).toBe('duress');
  expect(tree.root.findAllByProps({ testID: 'account-gone' })).toHaveLength(0);
});

test('the gone sheet never covers the lock or exposes a fresh-start control before unlock', async () => {
  await tombstone();
  crypto.__keychain.set('lock.enabled', '1');
  crypto.__keychain.set('lock.passcode', '123456');
  const tree = await renderApp();
  expect(tree.root.findAllByProps({ testID: 'lock-screen' }).length).toBeGreaterThan(0);
  expect(tree.root.findAllByProps({ testID: 'account-gone' })).toHaveLength(0);
  expect(tree.root.findAllByProps({ testID: 'account-start-fresh' })).toHaveLength(0);
});

test('an unusable identity has an explicit local fresh-start exit with honest server-deletion copy', async () => {
  const tree = await renderApp();
  await tombstone();
  expect(JSON.stringify(tree.toJSON())).not.toContain('This account no longer exists');
  await press(tree, 'account-start-fresh');
  expect(JSON.stringify(tree.toJSON())).toContain('The old account may still exist.');
  expect(accountGone()).toBe(true);
  await press(tree, 'account-start-fresh-confirm');
  expect(accountGone()).toBe(false);
  expect(tree.root.findAllByProps({ testID: 'account-gone' })).toHaveLength(0);
  expect(crypto.__keychain.has('accountDeletion')).toBe(false);
});

test('a pending deletion with a mismatched live identity offers explicit local-only abandonment', async () => {
  const native = jest.requireMock('tacendum-crypto') as { hasIdentity: jest.Mock };
  native.hasIdentity.mockResolvedValue(true);
  crypto.__keychain.set('accountDeletion', JSON.stringify({ phase: 'requested', userId: 'old-id' }));
  crypto.__keychain.set('authToken', 'expired-token');
  const unauthorized = Object.assign(new Error('unauthorized'), {
    name: 'ApiRequestError', status: 401, code: 'unauthorized',
  });
  const unavailable = Object.assign(new Error('account_gone'), {
    name: 'ApiRequestError', status: 409, code: 'account_gone',
  });
  api.apiDeleteAccount.mockRejectedValueOnce(unauthorized);
  api.apiAuth.mockRejectedValueOnce(unavailable);
  try {
    const tree = await renderApp();
    expect(crypto.__keychain.get('authToken')).toBe('expired-token');
    await press(tree, 'account-deletion-abandon');
    expect(JSON.stringify(tree.toJSON())).toContain('The old account may still exist.');
    expect(JSON.parse(crypto.__keychain.get('accountDeletion')!)).toMatchObject({ phase: 'requested' });
    await press(tree, 'account-start-fresh-confirm');
    expect(crypto.__keychain.has('accountDeletion')).toBe(false);
  } finally {
    native.hasIdentity.mockResolvedValue(false);
  }
});

test('a confirmed deletion at boot finishes cleanup before restoring an old identity', async () => {
  crypto.__keychain.set('accountDeletion', JSON.stringify({ phase: 'confirmed', userId: 'old-id' }));
  crypto.__keychain.set('authToken', 'deleted-token');
  await renderApp();
  expect(crypto.__keychain.has('accountDeletion')).toBe(false);
  expect(crypto.__keychain.has('authToken')).toBe(false);
  expect(api.apiAuth).not.toHaveBeenCalled();
});

test('an offline uncertain deletion stays pending at boot without erasing credentials', async () => {
  crypto.__keychain.set('accountDeletion', JSON.stringify({ phase: 'requested', userId: 'old-id' }));
  crypto.__keychain.set('authToken', 'possibly-live-token');
  const tree = await renderApp();
  expect(tree.root.findAllByProps({ testID: 'account-deletion-pending' }).length).toBeGreaterThan(0);
  expect(crypto.__keychain.get('authToken')).toBe('possibly-live-token');
  expect(crypto.__keychain.has('accountDeletion')).toBe(true);
  expect(api.apiAuth).not.toHaveBeenCalled();
});

test('a lost-key reinstall can leave an unconfirmable deletion only after an honest confirmation', async () => {
  crypto.identityPublicKey.mockResolvedValue(null);
  crypto.__keychain.set('accountDeletion', JSON.stringify({ phase: 'requested', userId: 'old-id' }));
  const tree = await renderApp();
  await press(tree, 'account-deletion-abandon');
  expect(JSON.stringify(tree.toJSON())).toContain('The old account may still exist.');
  expect(crypto.__keychain.has('accountDeletion')).toBe(true);
  await press(tree, 'account-start-fresh-confirm');
  expect(crypto.__keychain.has('accountDeletion')).toBe(false);
  expect(tree.root.findAllByProps({ testID: 'account-deletion-pending' })).toHaveLength(0);
});

test('a pending deletion never resumes behind the lock or after a duress unlock', async () => {
  const raw = JSON.stringify({ phase: 'confirmed', userId: 'old-id' });
  crypto.__keychain.set('accountDeletion', raw);
  crypto.__keychain.set('lock.enabled', '1');
  crypto.__keychain.set('lock.passcode', '123456');
  const tree = await renderApp();
  expect(crypto.__keychain.get('accountDeletion')).toBe(raw);
  for (const key of ['6', '5', '4', '3', '2', '1']) await press(tree, `pin-key-${key}`);
  await press(tree, 'pin-submit');
  expect(session.mode).toBe('duress');
  expect(crypto.__keychain.get('accountDeletion')).toBe(raw);
  expect(tree.root.findAllByProps({ testID: 'account-deletion-pending' })).toHaveLength(0);
});
