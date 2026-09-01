import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { setSecret } from 'tacendum-crypto';
import * as calling from '../src/call';
import * as db from '../src/db';
import { messaging } from '../src/messaging';
import { AUTH_TOKEN_KEY } from '../src/reauth';
import { SettingsScreen } from '../src/screens/SettingsScreen';

/**
 * The typing-indicators toggle: renders beside the
 * receipts row, persists through the same Keychain, and the module
 * survives a relaunch with the owner's choice. Harness copied verbatim
 * from Settings.silence.test.tsx — the calling setup is what makes
 * SettingsScreen render safely under test.
 */
const SELF = '01HQ5E1F00000000000000000A';

jest.mock('../src/api', () => ({
  apiDeletePushToken: jest.fn(async () => undefined),
  apiRegisterPushToken: jest.fn(async () => undefined),
  apiTurnCredentials: jest.fn(async () => ({ iceServers: [], ttlSeconds: 3600 })),
}));

const keychain = (
  jest.requireMock('tacendum-crypto') as { __keychain: Map<string, string> }
).__keychain;

interface FakeDb {
  name: string;
  execute: jest.Mock;
  close: jest.Mock;
}
const sqlite = (
  jest.requireMock('@op-engineering/op-sqlite') as {
    __sqlite: { instances: Map<string, FakeDb>; reset: () => void };
  }
).__sqlite;

/** Peers with a chat row carrying a message — the only thing that makes a
 * caller "known" to `decideRing`. Empty means every caller is a stranger. */
const known = new Set<string>();

function installTables(): void {
  const instance = sqlite.instances.get('tacendum.sqlite')!;
  const base = instance.execute.getMockImplementation()!;
  instance.execute.mockImplementation(async (sql: unknown, params: unknown) => {
    const text = String(sql);
    const args = (params ?? []) as unknown[];
    if (/FROM chats WHERE peerId/.test(text)) {
      return {
        rows: known.has(String(args[0]))
          ? [{ peerId: args[0], displayName: 'Ana', localName: null, lastMessageAt: 1 }]
          : [],
      };
    }
    return base(sql, params);
  });
}

async function flush(): Promise<void> {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}

let teardown: (() => void) | undefined;

beforeEach(async () => {
  keychain.clear();
  known.clear();
  calling.resetCallingForTests();
  jest.clearAllMocks();
  await db.close();
  sqlite.reset();
  db.setWorkspace('real');
  await db.initDb();
  installTables();
  await setSecret(AUTH_TOKEN_KEY, 'auth-token');
  jest.spyOn(messaging, 'sendCallEnvelope').mockResolvedValue(undefined);
  jest.spyOn(messaging, 'isBlockedLocally').mockReturnValue(false);
  jest.spyOn(messaging, 'isPeerBlocked').mockReturnValue(false);
  jest.spyOn(messaging, 'onEnvelope').mockImplementation(() => () => {});
  teardown = await calling.startCalling();
  calling.setSelfAccountId(SELF);
  await calling.loadSilenceUnknownCallers();
});

afterEach(async () => {
  teardown?.();
  teardown = undefined;
  calling.resetCallingForTests();
  jest.restoreAllMocks();
  await db.close();
});

async function render(): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<SettingsScreen
      onBack={() => {}}
      onOpenLinkedDevices={() => {}}
      onOpenAccountEmail={() => {}}
    />);
    await flush();
  });
  return tree;
}

async function press(
  tree: ReactTestRenderer.ReactTestRenderer,
  testID: string,
): Promise<void> {
  await ReactTestRenderer.act(async () => {
    tree.root.findByProps({ testID }).props.onPress();
    await flush();
  });
}

function selected(
  tree: ReactTestRenderer.ReactTestRenderer,
  testID: string,
): boolean {
  return tree.root.findByProps({ testID }).props.accessibilityState
    .selected as boolean;
}


import {
  loadTypingIndicators,
  resetTypingIndicatorsForDuress,
  typingIndicatorsEnabled,
} from '../src/typingIndicators';

describe('typing indicators toggle', () => {
  it('renders with On selected by default', async () => {
    resetTypingIndicatorsForDuress();
    const tree = await render();
    expect(selected(tree, 'settings-typing-on')).toBe(true);
    expect(selected(tree, 'settings-typing-off')).toBe(false);
  });

  it('persists Off past a relaunch', async () => {
    resetTypingIndicatorsForDuress();
    const tree = await render();
    await press(tree, 'settings-typing-off');

    // The process ends; the module's in-memory value goes with it.
    resetTypingIndicatorsForDuress();
    expect(typingIndicatorsEnabled()).toBe(true);
    await loadTypingIndicators();

    expect(typingIndicatorsEnabled()).toBe(false);
    expect(keychain.get('tacendum.typingIndicators')).toBe('0');
  });

  it('turning it back On persists "1"', async () => {
    resetTypingIndicatorsForDuress();
    const tree = await render();
    await press(tree, 'settings-typing-off');
    await press(tree, 'settings-typing-on');
    expect(keychain.get('tacendum.typingIndicators')).toBe('1');
    expect(typingIndicatorsEnabled()).toBe(true);
  });
});
