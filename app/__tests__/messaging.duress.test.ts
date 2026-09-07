/**
 * The lock program's verify: duress no-op seams. A duress session
 * composes locally, never touches crypto, the wire, or the real identity —
 * and a frame arriving after stop() writes nothing (the quiesce invariant).
 */

jest.mock('../src/ws', () => {
  const handlers: {
    frame?: (f: unknown) => void;
    state?: (s: string) => void;
  } = {};
  const calls = {
    start: jest.fn(),
    stop: jest.fn(),
    send: jest.fn((_frame: unknown) => true),
  };
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
      return false;
    }
  }
  return { WsClient, __ws: { handlers, calls } };
});

jest.mock('../src/api', () => ({
  // Every one of these rejects: nothing in a duress session may reach the
  // network, so a call that gets through must FAIL the test rather than
  // quietly succeed against a permissive stub.
  apiAuthChallenge: jest.fn().mockRejectedValue(new Error('network in test')),
  apiAuth: jest.fn().mockRejectedValue(new Error('network in test')),
  apiUploadKeys: jest.fn().mockRejectedValue(new Error('network in test')),
  apiGetPrekeyBundle: jest.fn().mockRejectedValue(new Error('network in test')),
  apiDeleteAccount: jest.fn().mockRejectedValue(new Error('network in test')),
  apiCreateAttachment: jest
    .fn()
    .mockRejectedValue(new Error('network in test')),
  apiGetAttachmentUrl: jest
    .fn()
    .mockRejectedValue(new Error('network in test')),
  uploadBlob: jest.fn().mockRejectedValue(new Error('network in test')),
  downloadBlob: jest.fn().mockRejectedValue(new Error('network in test')),
}));

import * as db from '../src/db';
import { callMetricDrain, callMetricLifecycle } from '../src/call/metrics';
import { AUTH_TOKEN_KEY, messaging } from '../src/messaging';
import { createOrRestoreAccount, deleteAccount } from '../src/registration';
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
  encryptText: jest.Mock;
  decryptEnvelope: jest.Mock;
  resetProtocolState: jest.Mock;
  deleteSecret: jest.Mock;
  setSecret: jest.Mock;
  hasIdentity: jest.Mock;
  identityPublicKey: jest.Mock;
  generateAndStoreKeys: jest.Mock;
};
const api = jest.requireMock('../src/api') as {
  apiAuthChallenge: jest.Mock;
  apiAuth: jest.Mock;
  apiDeleteAccount: jest.Mock;
};
const ws = (
  jest.requireMock('../src/ws') as {
    __ws: {
      handlers: { frame?: (f: unknown) => void };
      calls: { start: jest.Mock; send: jest.Mock };
    };
  }
).__ws;

function statementsOf(instance: FakeDb | undefined): string[] {
  return (instance?.execute.mock.calls ?? []).map(c => String(c[0]));
}

function observeMetricAuthorityAtFirstDelete(instance: FakeDb) {
  const execute = instance.execute.getMockImplementation();
  let observed: { timers: number; drainActive: boolean } | undefined;
  instance.execute.mockImplementation((...args: unknown[]) => {
    if (observed === undefined && /^\s*DELETE FROM/.test(String(args[0]))) {
      observed = {
        timers: jest.getTimerCount(),
        drainActive: callMetricDrain.activeReal,
      };
    }
    return execute?.(...args) ?? Promise.resolve({ rows: [] });
  });
  return () => observed;
}

async function openSingletonMetricAuthority(localId: string): Promise<void> {
  callMetricDrain.deactivate();
  callMetricLifecycle.deactivate();
  await callMetricDrain.activate();
  await callMetricLifecycle.open({
    reportId: '01K2ABCDEF0123456789ABCDEQ',
    localId,
    scope: 'group',
    media: 'audio',
    startedAt: Date.now(),
  });
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

beforeEach(async () => {
  messaging.stop();
  await db.close();
  crypto.__keychain.clear();
  sqlite.reset();
  crypto.encryptText.mockClear();
  crypto.decryptEnvelope.mockClear();
  crypto.resetProtocolState.mockClear();
  crypto.deleteSecret.mockClear();
  crypto.setSecret.mockClear();
  crypto.hasIdentity.mockClear();
  crypto.identityPublicKey.mockClear();
  crypto.generateAndStoreKeys.mockClear();
  api.apiAuthChallenge.mockClear();
  api.apiAuth.mockClear();
  api.apiDeleteAccount.mockClear();
  ws.calls.start.mockClear();
  ws.calls.send.mockClear();
  session.setMode('real');
  db.setWorkspace('real');
});

afterEach(async () => {
  messaging.stop();
  await db.close();
  session.setMode('real');
  db.setWorkspace('real');
});

describe('duress session', () => {
  beforeEach(async () => {
    session.setMode('duress');
    db.setWorkspace('decoy');
    await db.initDb();
  });

  test('start() refuses — a duress session is network-silent (rule 15)', async () => {
    await expect(messaging.start('someone')).rejects.toThrow();
    expect(ws.calls.start).not.toHaveBeenCalled();
  });

  test('sendText writes a local decoy row and never touches crypto or the wire', async () => {
    await messaging.sendText('decoy-peer', 'vasho tellin');
    const decoy = sqlite.instances.get('tacendum-decoy.sqlite');
    const statements = statementsOf(decoy);
    expect(
      statements.some(s => s.includes('INSERT OR IGNORE INTO messages')),
    ).toBe(true);
    expect(statements.some(s => s.includes('INTO chats'))).toBe(true);
    expect(crypto.encryptText).not.toHaveBeenCalled();
    expect(ws.calls.send).not.toHaveBeenCalled();
    expect(sqlite.instances.has('tacendum.sqlite')).toBe(false);
  });

  test('the local decoy row is written as already sent', async () => {
    await messaging.sendText('decoy-peer', 'arpo kellun');
    const decoy = sqlite.instances.get('tacendum-decoy.sqlite')!;
    const insert = decoy.execute.mock.calls.find(c =>
      String(c[0]).includes('INSERT OR IGNORE INTO messages'),
    );
    expect(insert?.[1]).toContain('sent');
    expect(insert?.[1]).toContain('arpo kellun');
  });

  test('sendReaction writes the chip locally only', async () => {
    await messaging.sendReaction('decoy-peer', '01TARGET', 'in', '❤️');
    const decoy = sqlite.instances.get('tacendum-decoy.sqlite');
    expect(
      statementsOf(decoy).some(s => s.includes('INSERT INTO reactions')),
    ).toBe(true);
    expect(crypto.encryptText).not.toHaveBeenCalled();
    expect(ws.calls.send).not.toHaveBeenCalled();
  });

  /**
   * PINS THE ORDER OF `refuseInDuress()` INSIDE createOrRestoreAccount, which
   * is load-bearing three times over — and set up in the exact shape that
   * makes it so, not a generic one.
   *
   * The protocol store is NOT workspace-switched (the decoy split is
   * SQLite-only: TacendumFileStores has one fixed root) and the Keychain is
   * not workspace-scoped either. So a duress session sees the REAL identity
   * sitting next to a NULL decoy profile — byte for byte the state
   * createOrRestoreAccount's reset branch is written for. Move the guard below
   * the profile read and three separate disasters land at once:
   *
   *  1. `resetProtocolState()` wipes the REAL identity keys, from a session
   *     the real user did not open. Unrecoverable by design.
   *  2. `generateAndStoreKeys()` surfaces "identity already exists" in the
   *     decoy UI — a failure the real flow never shows, which is a tell, and
   *     indistinguishability is the entire product of the lock design.
   *  3. `setSecret(AUTH_TOKEN_KEY, …)` overwrites the real session token with
   *     a decoy one, so the real user's next unlock is signed out.
   *
   * The assertions below name all three, plus rule 15 itself (no packet).
   */
  test('a coerced sign-up refuses before any of it runs — no keygen, no Keychain write, no packet (rule 15)', async () => {
    crypto.hasIdentity.mockResolvedValueOnce(true);
    crypto.identityPublicKey.mockResolvedValueOnce('REAL-IDENTITY-KEY');
    crypto.__keychain.set(AUTH_TOKEN_KEY, 'real-session-token');

    // Surfaced as being offline: the plausible truth of a session that never
    // opened a socket, and not a word about why.
    await expect(createOrRestoreAccount()).rejects.toThrow(/offline/i);

    expect(api.apiAuthChallenge).not.toHaveBeenCalled();
    expect(api.apiAuth).not.toHaveBeenCalled();
    expect(crypto.resetProtocolState).not.toHaveBeenCalled();
    expect(crypto.generateAndStoreKeys).not.toHaveBeenCalled();
    expect(crypto.setSecret).not.toHaveBeenCalled();
    expect(crypto.__keychain.get(AUTH_TOKEN_KEY)).toBe('real-session-token');
  });

  test('sendImage writes the message and a ready attachment locally only', async () => {
    await messaging.sendImage('decoy-peer', 'aW1hZ2U=', 100, 80);
    const decoy = sqlite.instances.get('tacendum-decoy.sqlite');
    const statements = statementsOf(decoy);
    expect(
      statements.some(s => s.includes('INSERT OR IGNORE INTO messages')),
    ).toBe(true);
    expect(statements.some(s => s.includes('INTO attachments'))).toBe(true);
    expect(crypto.encryptText).not.toHaveBeenCalled();
    expect(ws.calls.send).not.toHaveBeenCalled();
  });

  test('sendVoice is local-only — the decoy keeps its own audio', async () => {
    await messaging.sendVoice('decoy-peer', 'YXVkaW8=', 7);
    const decoy = sqlite.instances.get('tacendum-decoy.sqlite');
    const statements = statementsOf(decoy);
    expect(
      statements.some(s => s.includes('INSERT OR IGNORE INTO messages')),
    ).toBe(true);
    expect(statements.some(s => s.includes('INTO attachments'))).toBe(true);
    expect(crypto.encryptText).not.toHaveBeenCalled();
    expect(ws.calls.send).not.toHaveBeenCalled();
    const apiModule = jest.requireMock('../src/api') as Record<string, jest.Mock>;
    expect(apiModule.apiCreateAttachment).not.toHaveBeenCalled();
  });

  test('sendFile and sendLocation are local-only too', async () => {
    await messaging.sendFile(
      'decoy-peer',
      'ZG9jdW1lbnQ=',
      'notes.pdf',
      8,
      'application/pdf',
    );
    await messaging.sendLocation('decoy-peer', 37.1, -122.2);
    const decoy = sqlite.instances.get('tacendum-decoy.sqlite');
    const statements = statementsOf(decoy);
    expect(
      statements.some(s => s.includes('INSERT OR IGNORE INTO messages')),
    ).toBe(true);
    // The document's bytes land in the decoy workspace's own attachments.
    expect(statements.some(s => s.includes('INTO attachments'))).toBe(true);
    // Nothing encrypted, nothing on the wire, no blob store touched.
    expect(crypto.encryptText).not.toHaveBeenCalled();
    expect(ws.calls.send).not.toHaveBeenCalled();
    const apiModule = jest.requireMock('../src/api') as Record<string, jest.Mock>;
    expect(apiModule.apiCreateAttachment).not.toHaveBeenCalled();
    expect(apiModule.uploadBlob).not.toHaveBeenCalled();
  });
});

describe('quiesce (rule 14)', () => {
  test('a frame arriving after stop() writes nothing and decrypts nothing', async () => {
    crypto.__keychain.set('authToken', 'token-1');
    await db.initDb();
    await messaging.start('me-user');
    // Let start()'s unawaited reconcile pass finish its reads first.
    await flush();
    messaging.stop();
    const real = sqlite.instances.get('tacendum.sqlite')!;
    const before = real.execute.mock.calls.length;

    ws.handlers.frame?.({
      type: 'msg',
      from: 'peer-1',
      msgId: '01LATE',
      msgType: 'ciphertext',
      payload: 'AAAA',
      ts: 5,
    });
    await flush();

    expect(crypto.decryptEnvelope).not.toHaveBeenCalled();
    const after = real.execute.mock.calls
      .slice(before)
      .map(c => String(c[0]))
      .filter(s => /INSERT|UPDATE|DELETE/i.test(s));
    expect(after).toEqual([]);
  });
});

describe('deleteAccount (the most dangerous seam)', () => {
  test('real deletion revokes singleton metric authority before the first local wipe', async () => {
    // Mutations caught: remove the real-branch quiesce call, put it after
    // clearLocalState, or let the shared boundary omit either the heartbeat
    // or drain generation. The assertion runs inside the fake SQLite DELETE,
    // so an after-the-fact cleanup cannot satisfy it.
    jest.useFakeTimers();
    try {
      api.apiDeleteAccount.mockResolvedValueOnce(undefined);
      crypto.__keychain.set('authToken', 'token-1');
      await db.initDb();
      await openSingletonMetricAuthority('real-delete-active-report');
      expect(jest.getTimerCount()).toBe(1);
      expect(callMetricDrain.activeReal).toBe(true);
      const observed = observeMetricAuthorityAtFirstDelete(
        sqlite.instances.get('tacendum.sqlite')!,
      );

      await deleteAccount();

      expect(observed()).toEqual({ timers: 0, drainActive: false });
    } finally {
      callMetricDrain.deactivate();
      callMetricLifecycle.deactivate();
      jest.useRealTimers();
    }
  });

  test('duress deletion revokes authority left by the real workspace before clearing the decoy', async () => {
    // Mutation caught: omit quiesce from the early duress return. This starts
    // the real singleton before switching files, reproducing the leaked
    // process authority that can otherwise follow coercive unlock into decoy.
    jest.useFakeTimers();
    try {
      await db.initDb();
      await openSingletonMetricAuthority('real-report-before-duress-delete');
      await db.close();
      db.setWorkspace('decoy');
      session.setMode('duress');
      await db.initDb();
      const observed = observeMetricAuthorityAtFirstDelete(
        sqlite.instances.get('tacendum-decoy.sqlite')!,
      );

      await deleteAccount();

      expect(observed()).toEqual({ timers: 0, drainActive: false });
    } finally {
      callMetricDrain.deactivate();
      callMetricLifecycle.deactivate();
      jest.useRealTimers();
    }
  });

  test('duress delete clears decoy tables only — no network, real identity intact', async () => {
    crypto.__keychain.set('aiWriting.openai', 'real-writing-fixture');
    crypto.__keychain.set('aiWriting.anthropic', 'real-writing-fixture');
    crypto.__keychain.set('authToken', 'token-1');
    crypto.__keychain.set('lock.passcode', '123456');
    crypto.__keychain.set('lock.enabled', '1');
    session.setMode('duress');
    db.setWorkspace('decoy');
    await db.initDb();

    await deleteAccount();

    const decoy = sqlite.instances.get('tacendum-decoy.sqlite');
    expect(statementsOf(decoy).some(s => s.includes('DELETE FROM'))).toBe(true);
    expect(sqlite.instances.has('tacendum.sqlite')).toBe(false);
    expect(api.apiDeleteAccount).not.toHaveBeenCalled();
    expect(crypto.resetProtocolState).not.toHaveBeenCalled();
    expect(crypto.__keychain.get('authToken')).toBe('token-1');
    expect(crypto.__keychain.get('lock.passcode')).toBe('123456');
    expect(crypto.__keychain.get('lock.enabled')).toBe('1');
    expect(crypto.__keychain.get('aiWriting.openai')).toBe('real-writing-fixture');
    expect(crypto.__keychain.get('aiWriting.anthropic')).toBe('real-writing-fixture');
  });

  test('real delete retires the account server-side, then wipes identity, token, lock state, and the decoy', async () => {
    crypto.__keychain.set('aiWriting.openai', 'real-writing-fixture');
    crypto.__keychain.set('aiWriting.anthropic', 'real-writing-fixture');
    api.apiDeleteAccount.mockResolvedValueOnce(undefined);
    crypto.__keychain.set('authToken', 'token-1');
    crypto.__keychain.set('lock.passcode', '123456');
    crypto.__keychain.set('lock.enabled', '1');
    await db.initDb();

    await deleteAccount();

    expect(api.apiDeleteAccount).toHaveBeenCalledWith('token-1');
    expect(crypto.resetProtocolState).toHaveBeenCalled();
    expect(crypto.__keychain.has('authToken')).toBe(false);
    expect(crypto.__keychain.has('lock.passcode')).toBe(false);
    expect(crypto.__keychain.has('lock.enabled')).toBe(false);
    expect(crypto.__keychain.has('aiWriting.openai')).toBe(false);
    expect(crypto.__keychain.has('aiWriting.anthropic')).toBe(false);
    const decoy = sqlite.instances.get('tacendum-decoy.sqlite');
    expect(statementsOf(decoy).some(s => s.includes('DELETE FROM'))).toBe(true);
  });

  test('an offline delete throws and wipes NOTHING — the promise must never be false', async () => {
    crypto.__keychain.set('aiWriting.openai', 'real-writing-fixture');
    crypto.__keychain.set('aiWriting.anthropic', 'real-writing-fixture');
    // The default api mock rejects: the server was never reached, so the ID
    // still works, so nothing local may be destroyed.
    crypto.__keychain.set('authToken', 'token-1');
    crypto.__keychain.set('lock.passcode', '123456');
    await db.initDb();
    const real = sqlite.instances.get('tacendum.sqlite')!;
    const before = real.execute.mock.calls.length;

    await expect(deleteAccount()).rejects.toThrow();

    expect(crypto.resetProtocolState).not.toHaveBeenCalled();
    expect(crypto.__keychain.get('authToken')).toBe('token-1');
    expect(crypto.__keychain.get('lock.passcode')).toBe('123456');
    expect(crypto.__keychain.get('aiWriting.openai')).toBe('real-writing-fixture');
    expect(crypto.__keychain.get('aiWriting.anthropic')).toBe('real-writing-fixture');
    const wipes = real.execute.mock.calls
      .slice(before)
      .map(c => String(c[0]))
      .filter(s => s.includes('DELETE FROM'));
    expect(wipes).toEqual([]);
  });
});
