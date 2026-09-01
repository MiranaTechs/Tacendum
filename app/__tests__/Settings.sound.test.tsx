import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { setSecret } from 'tacendum-crypto';
import * as calling from '../src/call';
import * as db from '../src/db';
import {
  MESSAGE_SOUND_FILE,
  loadMessageSound,
  messageSoundEnabled,
  resetMessageSoundForTests,
  setMessageSound,
} from '../src/messageSound';
import { messaging } from '../src/messaging';
import { AUTH_TOKEN_KEY } from '../src/reauth';
import { SettingsScreen } from '../src/screens/SettingsScreen';
import { session } from '../src/session';

/**
 * The "Message sounds" toggle: renders in the
 * NOTIFICATIONS sheet below the push row in the chip idiom every sibling
 * uses, defaults ON, persists as a FILE in the App Group container (the
 * previews.ts idiom — the notification extension reads the same file), and
 * survives a relaunch with the owner's choice. A duress session flips the
 * row without touching the file. Harness copied verbatim from
 * Settings.typing.test.tsx — the calling setup is what makes SettingsScreen
 * render safely under test.
 */
const SELF = '01HQ5E1F00000000000000000A';

jest.mock('../src/api', () => ({
  apiDeletePushToken: jest.fn(async () => undefined),
  apiRegisterPushToken: jest.fn(async () => undefined),
  apiTurnCredentials: jest.fn(async () => ({ iceServers: [], ttlSeconds: 3600 })),
}));

const crypto = jest.requireMock('tacendum-crypto') as {
  __keychain: Map<string, string>;
  __sharedState: Map<string, string>;
};

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
  crypto.__keychain.clear();
  crypto.__sharedState.clear();
  known.clear();
  resetMessageSoundForTests();
  session.setMode('real');
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
  session.setMode('real');
  resetMessageSoundForTests();
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

/** Every chip testID in document order — the row's place in the sheet.
 * Composite and host nodes both carry the prop; the Set keeps one each. */
function chipOrder(tree: ReactTestRenderer.ReactTestRenderer): string[] {
  const CHIP = /^settings-(preview-(full|sender|none)|push-(on|off)|sound-(on|off))$/;
  return [
    ...new Set(
      tree.root
        .findAll(n => typeof n.props.testID === 'string' && CHIP.test(n.props.testID))
        .map(n => n.props.testID as string),
    ),
  ];
}

describe('the Message sounds toggle', () => {
  it('renders with On selected by default, in the chip idiom, below the push row', async () => {
    const tree = await render();
    expect(selected(tree, 'settings-sound-on')).toBe(true);
    expect(selected(tree, 'settings-sound-off')).toBe(false);
    const on = tree.root.findByProps({ testID: 'settings-sound-on' });
    expect(on.props.accessibilityRole).toBe('button');
    // Preview chips, then the push pair, then this pair: the outer
    // authority sits above the narrower switch.
    const order = chipOrder(tree);
    expect(order.indexOf('settings-push-off')).toBeLessThan(order.indexOf('settings-sound-on'));
    expect(order.slice(-2)).toEqual(['settings-sound-on', 'settings-sound-off']);
  });

  it('the teaching copy names the three limits and the outer authority', async () => {
    const tree = await render();
    const note = tree.root.findByProps({ testID: 'settings-sound-note' }).props
      .children as string;
    // iOS (jest's default Platform): both halves of the switch are named —
    // the in-app tone and the notification's sound — plus the limits.
    expect(note).toBe(
      'A short tone when a message arrives while Tacendum is open, and the ' +
        'sound on its notifications while it is closed — not for the ' +
        'conversation you are reading, and never during a call. Your ' +
        'iPhone’s notification settings and its silent switch decide first: ' +
        'Off here only takes a sound away. Calls ring on their own.',
    );
  });

  it('persists Off to the App Group file past a relaunch', async () => {
    const tree = await render();
    await press(tree, 'settings-sound-off');
    expect(selected(tree, 'settings-sound-off')).toBe(true);
    expect(crypto.__sharedState.get(MESSAGE_SOUND_FILE)).toBe('0');

    // The process ends; the module's in-memory value goes with it.
    resetMessageSoundForTests();
    expect(messageSoundEnabled()).toBe(true);
    await loadMessageSound();
    expect(messageSoundEnabled()).toBe(false);
  });

  it('turning it back On persists "1"', async () => {
    const tree = await render();
    await press(tree, 'settings-sound-off');
    await press(tree, 'settings-sound-on');
    expect(crypto.__sharedState.get(MESSAGE_SOUND_FILE)).toBe('1');
    expect(messageSoundEnabled()).toBe(true);
  });

  it('a missing or unreadable file reads as ON — the default, never off', async () => {
    crypto.__sharedState.delete(MESSAGE_SOUND_FILE);
    await loadMessageSound();
    expect(messageSoundEnabled()).toBe(true);
    crypto.__sharedState.set(MESSAGE_SOUND_FILE, 'garbage');
    await loadMessageSound();
    expect(messageSoundEnabled()).toBe(true);
    crypto.__sharedState.set(MESSAGE_SOUND_FILE, '0');
    await loadMessageSound();
    expect(messageSoundEnabled()).toBe(false);
  });

  it('a duress session shows the default and its taps never reach the file (rule 16)', async () => {
    // The owner turned it off in the real session.
    await setMessageSound(false);
    expect(crypto.__sharedState.get(MESSAGE_SOUND_FILE)).toBe('0');

    session.setMode('duress');
    const tree = await render();
    // The decoy shows the DEFAULT, not the owner's choice.
    expect(selected(tree, 'settings-sound-on')).toBe(true);
    // A coercer's tap appears to work…
    await press(tree, 'settings-sound-off');
    expect(selected(tree, 'settings-sound-off')).toBe(true);
    expect(messageSoundEnabled()).toBe(false);
    // …and the owner's stored choice is untouched — still their '0', not a
    // decoy write over it (either value would be the same byte here, so
    // flip it the other way to prove the write never happened).
    await press(tree, 'settings-sound-on');
    expect(crypto.__sharedState.get(MESSAGE_SOUND_FILE)).toBe('0');

    // The next real load resets the decoy's shadow.
    session.setMode('real');
    await loadMessageSound();
    expect(messageSoundEnabled()).toBe(false);
    session.setMode('duress');
    expect(messageSoundEnabled()).toBe(true);
  });

  it('a duress load reads no file and leaves the coercer’s Off standing — leaving and returning to Settings shows Off', async () => {
    const read = (jest.requireMock('tacendum-crypto') as { readSharedState: jest.Mock })
      .readSharedState;
    session.setMode('duress');
    await setMessageSound(false);
    read.mockClear();
    await loadMessageSound();
    expect(read).not.toHaveBeenCalled();
    expect(messageSoundEnabled()).toBe(false);
    const tree = await render();
    expect(selected(tree, 'settings-sound-off')).toBe(true);
  });

  it('a write that fails never rejects: the choice stands in memory for this session', async () => {
    const write = (jest.requireMock('tacendum-crypto') as { writeSharedState: jest.Mock })
      .writeSharedState;
    const tree = await render();
    write.mockRejectedValueOnce(new Error('container unavailable'));
    await expect(setMessageSound(false)).resolves.toBeUndefined();
    expect(messageSoundEnabled()).toBe(false);
    await press(tree, 'settings-sound-on');
    expect(crypto.__sharedState.get(MESSAGE_SOUND_FILE)).toBe('1');
  });
});
