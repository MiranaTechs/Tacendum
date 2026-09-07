import React from 'react';
import { Text } from 'react-native';
import ReactTestRenderer from 'react-test-renderer';
import { setSecret } from 'tacendum-crypto';
import * as calling from '../src/call';
import * as db from '../src/db';
import {
  FIELD_MODE_SNAPSHOT_KEY,
  resetFieldModeForTests,
} from '../src/fieldMode';
import {
  FIELD_MODE_COPY,
  FIELD_MODE_SCREENSHOT_LINES,
} from '../src/fieldModeCopy';
import { messaging } from '../src/messaging';
import {
  PREVIEW_LEVEL_FILE,
  loadPreviewLevel,
  resetPreviewLevelForDuress,
} from '../src/previews';
import { AUTH_TOKEN_KEY } from '../src/reauth';
import { screenSecurity } from '../src/screenSecurity';
import { SettingsScreen } from '../src/screens/SettingsScreen';
import { session } from '../src/session';
import { ChoiceRow } from '../src/ui/ChoiceRow';

/**
 * FIELD MODE, the Settings row.
 *
 * One switch, its own section above APP LOCK, and — the property this suite
 * is really for — DERIVED state: the chip is computed from the rows it
 * governs on every render, so it cannot claim to be on over settings that are
 * not. Turning it on moves four persisted controls (five with App Lock on);
 * turning it off puts back exactly what was there; changing any one of them
 * by hand flips the chip back with no extra tap.
 *
 * Harness copied verbatim from Settings.sound.test.tsx — the calling setup is
 * what lets SettingsScreen render at all under test.
 */
const SELF = '01HQ5E1F00000000000000000A';

jest.mock('../src/api', () => ({
  apiDeletePushToken: jest.fn(async () => undefined),
  apiRegisterPushToken: jest.fn(async () => undefined),
  apiTurnCredentials: jest.fn(async () => ({
    iceServers: [],
    ttlSeconds: 3600,
  })),
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
          ? [
              {
                peerId: args[0],
                displayName: 'Ana',
                localName: null,
                lastMessageAt: 1,
              },
            ]
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
  session.setMode('real');
  resetFieldModeForTests();
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
  await calling.loadAlwaysRelay();
  await calling.loadSilenceUnknownCallers();
  await loadPreviewLevel();
  screenSecurity.blankEnabled = true;
});

afterEach(async () => {
  teardown?.();
  teardown = undefined;
  calling.resetCallingForTests();
  jest.restoreAllMocks();
  session.setMode('real');
  resetFieldModeForTests();
  await db.close();
});

/** Open a row's ⓘ: the testID lands on the disclosure composite first, so
 * the press names the node that actually carries onPress. */
async function openInfo(
  tree: ReactTestRenderer.ReactTestRenderer,
  testID: string,
): Promise<void> {
  const node = tree.root
    .findAllByProps({ testID })
    .find(n => n.props.onPress !== undefined)!;
  await ReactTestRenderer.act(async () => {
    node.props.onPress();
  });
}

async function render(): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(
      <SettingsScreen
        onBack={() => {}}
        onOpenLinkedDevices={() => {}}
        onOpenAccountEmail={() => {}}
      />,
    );
    await flush();
  });
  await press(tree, 'settings-category-privacy');
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

async function unmount(
  tree: ReactTestRenderer.ReactTestRenderer,
): Promise<void> {
  await ReactTestRenderer.act(async () => {
    tree.unmount();
  });
}

function has(
  tree: ReactTestRenderer.ReactTestRenderer,
  testID: string,
): boolean {
  return tree.root.findAllByProps({ testID }).length > 0;
}

async function enterSection(
  tree: ReactTestRenderer.ReactTestRenderer,
  section: 'privacy' | 'chats' | 'notifications',
): Promise<void> {
  await press(tree, 'settings-back');
  await press(tree, `settings-category-${section}`);
}

/** Every rendered string, in document order. */
function texts(tree: ReactTestRenderer.ReactTestRenderer): string[] {
  return tree.root
    .findAllByType(Text)
    .map(n =>
      Array.isArray(n.props.children)
        ? n.props.children.join('')
        : String(n.props.children ?? ''),
    );
}

/** Turn App Lock on the way a relaunch finds it: state in the Keychain. */
async function enableAppLock(autolockSec: number): Promise<void> {
  await setSecret('lock.enabled', '1');
  await setSecret('lock.passcode', '1234');
  await setSecret('lock.autolockSec', String(autolockSec));
}

/**
 * Enter a coerced session the way App.tsx's duress block does it — the five
 * `resetXForDuress` calls beside `session.setMode('duress')`. Without them a
 * test would be judging the decoy's screen against the OWNER's loaded
 * preferences, which is not a state the app can be in.
 */
function enterDuress(): void {
  session.setMode('duress');
  screenSecurity.resetForDuress();
  resetPreviewLevelForDuress();
  calling.resetAlwaysRelayForDuress();
  calling.resetSilenceUnknownCallersForDuress();
}

/** Every string the FIELD MODE section renders, and only those: the row's
 * own subtree plus the status line that hangs under it. The neighbouring
 * sections legitimately carry a device noun, so a whole-tree scan could not
 * be used to police this deck's ban list. */
function fieldModeTexts(tree: ReactTestRenderer.ReactTestRenderer): string[] {
  const row = tree.root
    .findAllByType(ChoiceRow)
    .find(n => n.props.testIDPrefix === 'settings-fieldmode')!;
  const out = row
    .findAllByType(Text)
    .map(n =>
      Array.isArray(n.props.children)
        ? n.props.children.join('')
        : String(n.props.children ?? ''),
    );
  for (const n of tree.root.findAllByProps({
    testID: 'settings-fieldmode-needslock',
  })) {
    out.push(String(n.props.children ?? ''));
  }
  return out;
}

describe('the Field Mode row', () => {
  it('renders in the chip idiom, Off on a fresh install, above App Lock in Privacy', async () => {
    const tree = await render();
    expect(selected(tree, 'settings-fieldmode-off')).toBe(true);
    expect(selected(tree, 'settings-fieldmode-on')).toBe(false);
    expect(
      tree.root.findByProps({ testID: 'settings-fieldmode-on' }).props
        .accessibilityRole,
    ).toBe('button');

    const order = texts(tree);
    expect(order.indexOf(FIELD_MODE_COPY.sectionLabel)).toBeGreaterThanOrEqual(
      0,
    );
    expect(order.indexOf(FIELD_MODE_COPY.sectionLabel)).toBeLessThan(
      order.indexOf('APP LOCK'),
    );
    expect(has(tree, 'settings-category-account')).toBe(false);
  });

  it('On moves every mapped control, and the individual rows follow', async () => {
    const tree = await render();
    await press(tree, 'settings-fieldmode-on');

    expect(crypto.__sharedState.get(PREVIEW_LEVEL_FILE)).toBe('none');
    expect(crypto.__keychain.get('tacendum.alwaysRelay')).toBe('1');
    expect(crypto.__keychain.get('tacendum.silenceUnknownCallers')).toBe('1');
    expect(crypto.__keychain.get('screensec.blank')).toBe('1');

    expect(selected(tree, 'settings-screensec-on')).toBe(true);
    expect(selected(tree, 'settings-fieldmode-on')).toBe(true);
    await enterSection(tree, 'notifications');
    expect(selected(tree, 'settings-preview-none')).toBe(true);
    await enterSection(tree, 'chats');
    expect(selected(tree, 'settings-relay-on')).toBe(true);
    expect(selected(tree, 'settings-silence-on')).toBe(true);
  });

  it('with App Lock on it sets Auto-lock to Right away and shows no "needs App Lock" line', async () => {
    await enableAppLock(300);
    const tree = await render();
    expect(has(tree, 'settings-fieldmode-needslock')).toBe(false);
    expect(selected(tree, 'settings-autolock-300')).toBe(true);

    await press(tree, 'settings-fieldmode-on');
    expect(crypto.__keychain.get('lock.autolockSec')).toBe('0');
    expect(selected(tree, 'settings-autolock-0')).toBe(true);
    expect(selected(tree, 'settings-fieldmode-on')).toBe(true);
  });

  it('keeps the session copy of Auto-lock in step, so the row and the chip hold across a remount', async () => {
    // The screen re-reads `session.lockUi.autolockSec` on every mount, and
    // `chooseAutolock`/`commit` keep it in step for that reason. Field Mode
    // moves the same setting, so it has to as well — otherwise the Auto-lock
    // row comes back reading "1 min" over a Keychain holding 0, and the
    // derived chip, reading that stale 60, reads Off over settings that are
    // all at their field values.
    await enableAppLock(300);
    const tree = await render();
    await press(tree, 'settings-autolock-60');
    await press(tree, 'settings-fieldmode-on');
    expect(selected(tree, 'settings-autolock-0')).toBe(true);
    await unmount(tree);

    const again = await render();
    expect(selected(again, 'settings-autolock-0')).toBe(true);
    expect(selected(again, 'settings-fieldmode-on')).toBe(true);

    // …and Off puts the session copy back too, not just the Keychain.
    await press(again, 'settings-fieldmode-off');
    expect(crypto.__keychain.get('lock.autolockSec')).toBe('60');
    expect(selected(again, 'settings-autolock-60')).toBe(true);
    await unmount(again);

    const third = await render();
    expect(selected(third, 'settings-autolock-60')).toBe(true);
    expect(selected(third, 'settings-fieldmode-off')).toBe(true);
  });

  it('a second On does not overwrite the record of what was there first', async () => {
    const tree = await render();
    await press(tree, 'settings-fieldmode-on');
    const first = crypto.__keychain.get(FIELD_MODE_SNAPSHOT_KEY);
    expect(first).toBeDefined();
    // ChoiceRow fires onChange on a press of the already-selected chip.
    await press(tree, 'settings-fieldmode-on');
    expect(crypto.__keychain.get(FIELD_MODE_SNAPSHOT_KEY)).toBe(first);

    await press(tree, 'settings-fieldmode-off');
    expect(crypto.__sharedState.get(PREVIEW_LEVEL_FILE)).toBe('sender');
    expect(crypto.__keychain.get('tacendum.alwaysRelay')).toBe('0');
    expect(selected(tree, 'settings-fieldmode-off')).toBe(true);
  });

  it('a second tap is refused while the five writes are still in flight', async () => {
    // Five writes behind one chip, and no busy flag in `persist`: an Off pass
    // that started mid-On could read the snapshot and delete the key while
    // the On pass was still setting, leaving the rows at the field values
    // with no record to come back from.
    const write = (
      jest.requireMock('tacendum-crypto') as { writeSharedState: jest.Mock }
    ).writeSharedState;
    const base = write.getMockImplementation()!;
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    write.mockImplementationOnce(async (name: string, value: string) => {
      await gate;
      return base(name, value);
    });

    const tree = await render();
    await ReactTestRenderer.act(async () => {
      tree.root
        .findByProps({ testID: 'settings-fieldmode-on' })
        .props.onPress();
      await flush();
    });
    // The chips grey out for the duration…
    expect(
      tree.root.findByProps({ testID: 'settings-fieldmode-off' }).props
        .accessibilityState.disabled,
    ).toBe(true);
    // …and a tap that lands anyway is refused rather than interleaved.
    await ReactTestRenderer.act(async () => {
      tree.root
        .findByProps({ testID: 'settings-fieldmode-off' })
        .props.onPress();
      await flush();
    });
    await ReactTestRenderer.act(async () => {
      release();
      await flush();
    });

    expect(
      tree.root.findByProps({ testID: 'settings-fieldmode-off' }).props
        .accessibilityState.disabled,
    ).toBe(false);
    expect(selected(tree, 'settings-fieldmode-on')).toBe(true);
    expect(crypto.__sharedState.get(PREVIEW_LEVEL_FILE)).toBe('none');
    expect(crypto.__keychain.get(FIELD_MODE_SNAPSHOT_KEY)).toBeDefined();

    // And the record is still the one that can turn it off again.
    await press(tree, 'settings-fieldmode-off');
    expect(crypto.__sharedState.get(PREVIEW_LEVEL_FILE)).toBe('sender');
    expect(crypto.__keychain.has(FIELD_MODE_SNAPSHOT_KEY)).toBe(false);
  });

  it('with App Lock off it says so, offers no auto-lock control, and still reads On', async () => {
    const tree = await render();
    // The status line is a Text, not a chip and not a link: Field Mode never
    // turns App Lock on.
    expect(has(tree, 'settings-fieldmode-needslock')).toBe(true);
    expect(
      tree.root.findByProps({ testID: 'settings-fieldmode-needslock' }).props
        .children,
    ).toBe(FIELD_MODE_COPY.needsLock);
    expect(has(tree, 'settings-autolock-0')).toBe(false);

    await press(tree, 'settings-fieldmode-on');
    expect(selected(tree, 'settings-fieldmode-on')).toBe(true);
    expect(crypto.__keychain.has('lock.autolockSec')).toBe(false);
    expect(crypto.__keychain.has('lock.enabled')).toBe(false);
  });

  it('Off restores each previous value from the snapshot and deletes the snapshot key', async () => {
    // A person who had chosen the opposite of the field value everywhere.
    crypto.__sharedState.set(PREVIEW_LEVEL_FILE, 'full');
    await setSecret('tacendum.alwaysRelay', '0');
    await setSecret('tacendum.silenceUnknownCallers', '0');
    await setSecret('screensec.blank', '0');
    await loadPreviewLevel();
    await calling.loadAlwaysRelay();
    await calling.loadSilenceUnknownCallers();
    await screenSecurity.reloadSetting();

    const tree = await render();
    await press(tree, 'settings-fieldmode-on');
    expect(crypto.__keychain.get(FIELD_MODE_SNAPSHOT_KEY)).toBeDefined();
    expect(crypto.__sharedState.get(PREVIEW_LEVEL_FILE)).toBe('none');

    await press(tree, 'settings-fieldmode-off');
    expect(crypto.__sharedState.get(PREVIEW_LEVEL_FILE)).toBe('full');
    expect(crypto.__keychain.get('tacendum.alwaysRelay')).toBe('0');
    expect(crypto.__keychain.get('tacendum.silenceUnknownCallers')).toBe('0');
    expect(crypto.__keychain.get('screensec.blank')).toBe('0');
    expect(crypto.__keychain.has(FIELD_MODE_SNAPSHOT_KEY)).toBe(false);

    expect(selected(tree, 'settings-screensec-off')).toBe(true);
    expect(selected(tree, 'settings-fieldmode-off')).toBe(true);
    await enterSection(tree, 'notifications');
    expect(selected(tree, 'settings-preview-full')).toBe(true);
    await enterSection(tree, 'chats');
    expect(selected(tree, 'settings-relay-off')).toBe(true);
    expect(selected(tree, 'settings-silence-off')).toBe(true);
  });

  it('is DERIVED: changing one mapped row by hand flips the chip back with no extra tap', async () => {
    const tree = await render();
    await press(tree, 'settings-fieldmode-on');
    expect(selected(tree, 'settings-fieldmode-on')).toBe(true);

    await enterSection(tree, 'notifications');
    await press(tree, 'settings-preview-sender');
    await enterSection(tree, 'privacy');
    expect(selected(tree, 'settings-fieldmode-off')).toBe(true);
    expect(selected(tree, 'settings-fieldmode-on')).toBe(false);

    // Putting it back by hand makes the chip read On again — no stored flag
    // to go stale in either direction.
    await enterSection(tree, 'notifications');
    await press(tree, 'settings-preview-none');
    await enterSection(tree, 'privacy');
    expect(selected(tree, 'settings-fieldmode-on')).toBe(true);
  });

  it('the consent line stays visible and the teaching copy sits behind the ⓘ', async () => {
    const tree = await render();
    // Visible, from the deck by identity (no App Lock, so no auto-lock
    // clause).
    expect(
      tree.root.findByProps({ testID: 'settings-fieldmode-note' }).props
        .children,
    ).toBe(FIELD_MODE_COPY.consent);
    // Closed until opened.
    expect(texts(tree)).not.toContain(FIELD_MODE_COPY.infoLines[0]);
    await openInfo(tree, 'settings-fieldmode-info');
    const shown = texts(tree);
    for (const line of FIELD_MODE_COPY.infoLines) expect(shown).toContain(line);
  });

  it('names the auto-lock effect in the visible line only when App Lock is on', async () => {
    await enableAppLock(60);
    const tree = await render();
    expect(
      tree.root.findByProps({ testID: 'settings-fieldmode-note' }).props
        .children,
    ).toBe(`${FIELD_MODE_COPY.consent} ${FIELD_MODE_COPY.consentAutolock}`);
  });

  const BANNED = [
    'panic',
    'stealth',
    'secret',
    'hidden',
    'audited',
    'lockdown',
    'emergency',
    'forensic',
    'seizure',
    'iphone',
    'ipad',
    'apple',
    'icloud',
    'tablet',
    // The struck row: disappearing messages are per conversation and agreed
    // with the peer, so Field Mode neither claims nor touches them.
    'disappear',
    'timer',
  ];

  it('the copy overclaims nothing and names no effect this build cannot deliver', async () => {
    // BOTH platform arms, not just the one this process compiled: the
    // ternary in the deck resolves at import time and jest runs as ios, so
    // `FIELD_MODE_COPY` alone can never see the Android sentence.
    const deck = [
      JSON.stringify(FIELD_MODE_COPY),
      FIELD_MODE_SCREENSHOT_LINES.ios,
      FIELD_MODE_SCREENSHOT_LINES.android,
    ]
      .join(' ')
      .toLowerCase();
    for (const word of BANNED) expect(deck).not.toContain(word);
    // The screenshot sentence is informational on either platform — it never
    // says Field Mode turned anything on.
    for (const arm of Object.values(FIELD_MODE_SCREENSHOT_LINES)) {
      expect(arm).toContain('always true, with Field Mode on or off');
    }
    expect(
      FIELD_MODE_COPY.infoLines[FIELD_MODE_COPY.infoLines.length - 1],
    ).toBe(FIELD_MODE_SCREENSHOT_LINES.ios);
  });

  it('says what a notification actually shows, rather than that none appears', async () => {
    // previewLevel 'none' does not suppress the notification: it arrives and
    // reads "New message" (previews.ts levels table, PreviewPolicy.swift).
    // "Notifications show nothing" would read as "no banner appears", and the
    // person this switch is for would learn otherwise from a banner lighting
    // up in front of somebody.
    expect(FIELD_MODE_COPY.consent).toContain('New message');
    expect(FIELD_MODE_COPY.infoLines[1]).toContain('New message');
    const deck = JSON.stringify(FIELD_MODE_COPY);
    expect(deck).not.toContain('notifications show nothing');
  });

  it('names the cost, the way every other consent-grade row on this screen does', async () => {
    expect(FIELD_MODE_COPY.infoLines[1]).toContain('The costs are');
    expect(FIELD_MODE_COPY.infoLines[1]).toContain('take longer to connect');
  });

  it('names the case where Off cannot put anything back', async () => {
    // The chip is DERIVED, so it reads On for somebody who set these four by
    // hand and never tapped it — with no snapshot to restore from. Off then
    // lands on the shipped defaults. The ⓘ has to say so.
    const line = FIELD_MODE_COPY.infoLines.find(l =>
      l.startsWith('If Field Mode was never turned on here'),
    );
    expect(line).toBeDefined();
    expect(line).toContain('original defaults');
  });

  it('no sentence typed straight into the section smuggles a banned word in', async () => {
    // The deck scan above cannot see a literal in the FIELD MODE JSX, which
    // is exactly how a later edit would introduce one.
    const tree = await render();
    await openInfo(tree, 'settings-fieldmode-info');
    const shown = fieldModeTexts(tree).join(' ').toLowerCase();
    expect(shown.length).toBeGreaterThan(0);
    for (const word of BANNED) expect(shown).not.toContain(word);
  });

  it('a duress tap moves the same rows a real one does, keeps them across a remount, and writes nothing (rule 16)', async () => {
    // The owner's real settings, from a real session.
    const tree = await render();
    await press(tree, 'settings-fieldmode-on');
    expect(selected(tree, 'settings-fieldmode-on')).toBe(true);
    await unmount(tree);

    enterDuress();
    const keychainBefore = [...crypto.__keychain.entries()].sort();
    const sharedBefore = [...crypto.__sharedState.entries()].sort();

    const decoy = await render();
    // The decoy shows the DEFAULT — and now for the honest reason: because
    // its own rows say so, the same predicate the owner's screen uses.
    expect(selected(decoy, 'settings-fieldmode-off')).toBe(true);
    await enterSection(decoy, 'notifications');
    expect(selected(decoy, 'settings-preview-sender')).toBe(true);
    await enterSection(decoy, 'chats');
    expect(selected(decoy, 'settings-relay-off')).toBe(true);
    await enterSection(decoy, 'privacy');

    // A coercer's tap moves ALL FOUR mapped chips, exactly as a real tap
    // does. Anything less is a discriminator, and the consent line printed
    // under the chip is the instructions for using it.
    await press(decoy, 'settings-fieldmode-on');
    expect(selected(decoy, 'settings-fieldmode-on')).toBe(true);
    expect(selected(decoy, 'settings-screensec-on')).toBe(true);
    await enterSection(decoy, 'notifications');
    expect(selected(decoy, 'settings-preview-none')).toBe(true);
    await enterSection(decoy, 'chats');
    expect(selected(decoy, 'settings-relay-on')).toBe(true);
    expect(selected(decoy, 'settings-silence-on')).toBe(true);
    await unmount(decoy);

    // …and every one of them is still moved when they come back to the
    // screen, which is what a real session gets from its four stores.
    const again = await render();
    expect(selected(again, 'settings-fieldmode-on')).toBe(true);
    expect(selected(again, 'settings-screensec-on')).toBe(true);
    await enterSection(again, 'notifications');
    expect(selected(again, 'settings-preview-none')).toBe(true);
    await enterSection(again, 'chats');
    expect(selected(again, 'settings-relay-on')).toBe(true);
    expect(selected(again, 'settings-silence-on')).toBe(true);

    // Not one byte moved, in either store, snapshot key included.
    expect([...crypto.__keychain.entries()].sort()).toEqual(keychainBefore);
    expect([...crypto.__sharedState.entries()].sort()).toEqual(sharedBefore);
  });

  it('in duress a row changed by hand is remembered too, and the chip follows it', async () => {
    enterDuress();
    const decoy = await render();
    await press(decoy, 'settings-fieldmode-on');
    // The coercer changes one of the four back by hand: derived, so the chip
    // flips…
    await enterSection(decoy, 'notifications');
    await press(decoy, 'settings-preview-sender');
    await enterSection(decoy, 'privacy');
    expect(selected(decoy, 'settings-fieldmode-off')).toBe(true);
    await unmount(decoy);

    // …and the remount must not resurrect the Field Mode tap's value over it.
    const again = await render();
    await enterSection(again, 'notifications');
    expect(selected(again, 'settings-preview-sender')).toBe(true);
    await enterSection(again, 'chats');
    expect(selected(again, 'settings-relay-on')).toBe(true);
    await enterSection(again, 'privacy');
    expect(selected(again, 'settings-fieldmode-off')).toBe(true);
  });

  it('Off in duress puts back what the coerced On found, with nothing written', async () => {
    enterDuress();
    const keychainBefore = [...crypto.__keychain.entries()].sort();
    const sharedBefore = [...crypto.__sharedState.entries()].sort();

    const decoy = await render();
    await press(decoy, 'settings-fieldmode-on');
    await press(decoy, 'settings-fieldmode-off');
    expect(selected(decoy, 'settings-fieldmode-off')).toBe(true);
    await enterSection(decoy, 'notifications');
    expect(selected(decoy, 'settings-preview-sender')).toBe(true);
    await enterSection(decoy, 'chats');
    expect(selected(decoy, 'settings-relay-off')).toBe(true);

    expect([...crypto.__keychain.entries()].sort()).toEqual(keychainBefore);
    expect([...crypto.__sharedState.entries()].sort()).toEqual(sharedBefore);
  });

  it('a write that refuses puts every row back and says so under the row', async () => {
    const write = (
      jest.requireMock('tacendum-crypto') as { writeSharedState: jest.Mock }
    ).writeSharedState;
    const tree = await render();
    write.mockRejectedValueOnce(new Error('container unavailable'));
    await press(tree, 'settings-fieldmode-on');

    expect(selected(tree, 'settings-fieldmode-off')).toBe(true);
    expect(has(tree, 'settings-fieldmode-error')).toBe(true);
    await enterSection(tree, 'notifications');
    expect(selected(tree, 'settings-preview-sender')).toBe(true);
    await enterSection(tree, 'chats');
    expect(selected(tree, 'settings-relay-off')).toBe(true);
  });
});
