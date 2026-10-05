/**
 * The peer profile's read discipline and its polish.
 *
 *  - the screen subscribed to messaging RAW and re-read the
 *    database — the chat row twice, the safety number, the block record,
 *    the device set plus one native safety-number call per device — on
 *    EVERY notify, while a backlog drained. Now one 80 ms window per burst
 *    (the chat list's own, shared through useCoalescedSubscribe), and one
 *    getChat per refresh.
 *  - the one input-bearing screen without the keyboard inset.
 *  - the report reason is a selected chip, not a "• " prefix
 *    VoiceOver read as "bullet".
 *  - the block button is the kit's OutlineButton (warning tone).
 *  - a device pair's safety number is laid out as a safety
 *    number — the same 3-per-row grid the anchor pair gets — not a
 *    proportional-font run that wraps wherever the width falls.
 *  - Copy on the ID row; nickname Save is off while nothing
 *    changed and says "saved" when it did.
 *
 * Harness follows PeerProfile.blocking.test.tsx: the fake op-sqlite from
 * jest.setup.js answers by SQL fragment, so the screen exercises the real db
 * module rather than a stubbed one. */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { StyleSheet, Text } from 'react-native';
import * as db from '../src/db';
import { DEVICE_NOUN } from '../src/deviceNoun';
import { messaging } from '../src/messaging';
import { REPORT_COPY } from '../src/reporting';
import { safetyGroups, spokenSafetyNumber } from '../src/safety';
import { PeerProfileScreen } from '../src/screens/PeerProfileScreen';
import { themeTokens } from '../src/theme';

// The live module object, so the Clipboard spy lands on the binding the
// screen calls (the keyboard-inset test's own discipline).
const RN: typeof import('react-native') = require('react-native');

/** What the keyboard is covering, as the screen's hook reports it. */
const mockKeyboard = { inset: 0 };
jest.mock('../src/keyboardInset', () => ({
  ...jest.requireActual<typeof import('../src/keyboardInset')>(
    '../src/keyboardInset',
  ),
  useKeyboardInset: () => mockKeyboard.inset,
}));

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

const theme = themeTokens();
const T0 = new Date('2026-09-01T09:00:00').getTime();
const PEER = '01SAMZ3NDEKTSV4RRFFQ69G5FA';
const TABLET = '01SAMZ3NDEKTSV4RRFFQ69G5FB';
/** Twelve five-digit groups, so the safety section has a real state to hold. */
const SAFETY = '4'.repeat(60);

const ME: db.ProfileRow = {
  userId: '01KYDBSSDJSPC9J0E5N2AWMJ5Y',
  registrationId: 7,
  displayName: 'Nat',
  about: '',
  avatarB64: '',
  profileVersion: 1,
};

function chatRow(localName: string | null) {
  return {
    peerId: PEER,
    displayName: 'Sam',
    lastMessageAt: T0,
    lastMessageText: 'see you',
    about: null,
    avatarB64: null,
    profileVersion: null,
    safetyCheckedAt: null,
    localName,
    createdAt: T0,
    lastOpenedAt: null,
    identityChangedAt: null,
    safetyMismatchAt: null,
  };
}

function deviceRow(
  userId: string,
  state: 'linked' | 'pending',
): db.PeerDeviceDbRow {
  return {
    userId,
    anchorId: PEER,
    class: 'tablet',
    state,
    identityKeyPub: 'S0VZ',
    certsJson: '',
    updatedAt: T0,
  };
}

/** What the fake `chats` table answers with on the next read. */
const chat: { row: ReturnType<typeof chatRow> } = { row: chatRow(null) };
/** Every SQL the fake engine was handed, in order. */
const executed: string[] = [];

beforeEach(async () => {
  await db.close();
  sqlite.reset();
  db.setWorkspace('real');
  await db.initDb();
  chat.row = chatRow(null);
  executed.length = 0;
  mockKeyboard.inset = 0;

  const instance = sqlite.instances.get('tacendum.sqlite')!;
  const base = instance.execute.getMockImplementation()!;
  instance.execute.mockImplementation(async (sql: string, params?: unknown) => {
    const s = String(sql);
    executed.push(s);
    if (s.includes('FROM blocked_peers')) return { rows: [] };
    if (s.includes('FROM chats')) return { rows: [chat.row] };
    return base(s, params);
  });

  jest.spyOn(messaging, 'getSafetyNumber').mockResolvedValue(SAFETY);
  jest.spyOn(messaging, 'isPeerBlocked').mockReturnValue(false);
});

afterEach(async () => {
  jest.useRealTimers();
  jest.restoreAllMocks();
  await db.close();
});

async function renderProfile(): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <PeerProfileScreen peerId={PEER} me={ME} onBack={jest.fn()} />,
    );
  });
  await ReactTestRenderer.act(async () => {});
  return tree;
}

function byId(tree: ReactTestRenderer.ReactTestRenderer, id: string) {
  return tree.root.findAll(n => n.props.testID === id);
}

function has(tree: ReactTestRenderer.ReactTestRenderer, id: string): boolean {
  return byId(tree, id).length > 0;
}

/** The control itself: a Pressable's host View carries no `onPress`. A kit
 * component carries its testID on itself AND on its Pressable, so the
 * outermost match is the one pressed. */
function control(tree: ReactTestRenderer.ReactTestRenderer, id: string) {
  return tree.root.findAll(
    n => n.props.testID === id && typeof n.props.onPress === 'function',
  )[0]!;
}

/** The Pressable itself — the node carrying the style function and the
 * accessibility state, under a kit component's own composite. */
function pressable(tree: ReactTestRenderer.ReactTestRenderer, id: string) {
  return tree.root.findAll(
    n => n.props.testID === id && typeof n.props.style === 'function',
  )[0]!;
}

/** The text field: the composite carrying onChangeText. */
function field(tree: ReactTestRenderer.ReactTestRenderer, id: string) {
  return tree.root.findAll(
    n => n.props.testID === id && typeof n.props.onChangeText === 'function',
  )[0]!;
}

/** The host node — the View or Text the styles actually land on. */
function host(tree: ReactTestRenderer.ReactTestRenderer, id: string) {
  return tree.root.findAll(
    n => n.props.testID === id && typeof n.type === 'string',
  )[0]!;
}

async function press(
  tree: ReactTestRenderer.ReactTestRenderer,
  id: string,
): Promise<void> {
  await ReactTestRenderer.act(async () => {
    control(tree, id).props.onPress();
  });
}

function texts(tree: ReactTestRenderer.ReactTestRenderer): string {
  return tree.root
    .findAllByType(Text)
    .map(n => {
      const kids = n.props.children;
      return Array.isArray(kids) ? kids.join('') : String(kids ?? '');
    })
    .join('\n');
}

/** What every receipt, frame and socket transition does to subscribers. */
function notify(): void {
  (messaging as unknown as { notify: () => void }).notify();
}

/** How many times the screen has read its chat row. */
function chatReads(): number {
  return executed.filter(s => s.includes('FROM chats WHERE peerId')).length;
}

async function unmount(tree: ReactTestRenderer.ReactTestRenderer) {
  await ReactTestRenderer.act(() => {
    tree.unmount();
  });
}

describe('peer profile — one coalesced re-read per notify burst', () => {
  test('a burst of notifies inside the 80 ms window costs one refresh, not one each', async () => {
    const tree = await renderProfile();
    const safetyReads = messaging.getSafetyNumber as jest.Mock;
    expect(safetyReads).toHaveBeenCalledTimes(1); // the mount's own refresh

    jest.useFakeTimers();
    await ReactTestRenderer.act(async () => {
      for (let i = 0; i < 5; i++) notify();
      jest.advanceTimersByTime(80);
    });
    expect(safetyReads).toHaveBeenCalledTimes(2);

    // The window is a window, not a resetting debounce: a continuous drain
    // still refreshes once per window instead of starving.
    await ReactTestRenderer.act(async () => {
      notify();
      jest.advanceTimersByTime(40);
      notify();
      jest.advanceTimersByTime(40);
    });
    expect(safetyReads).toHaveBeenCalledTimes(3);

    await unmount(tree);
  });

  test('the chat row is read once per refresh — the timer comes from the same row', async () => {
    const tree = await renderProfile();
    expect(chatReads()).toBe(1);
    // And the timer it carries still reaches the chips from that one read.
    expect(has(tree, 'peer-disappear-status')).toBe(true);
    await unmount(tree);
  });
});

describe('peer profile — the keyboard inset', () => {
  test('the root pads its bottom by what the keyboard covers, so the nickname field and Save rise above it', async () => {
    mockKeyboard.inset = 240;
    const tree = await renderProfile();
    const root = host(tree, 'peer-profile-root');
    expect(StyleSheet.flatten(root.props.style).paddingBottom).toBe(240);
    await unmount(tree);
  });
});

describe('peer profile — report reasons are selected chips', () => {
  test('the chosen reason is `selected` for VoiceOver and carries no bullet', async () => {
    const tree = await renderProfile();
    await press(tree, 'peer-report-start');

    for (const option of REPORT_COPY.reasons) {
      const chip = pressable(tree, `peer-report-reason-${option.value}`);
      expect(chip.props.accessibilityState.selected).toBe(false);
      expect(chip.props.accessibilityLabel).toBe(option.label);
    }

    await press(tree, 'peer-report-reason-spam');
    const spam = pressable(tree, 'peer-report-reason-spam');
    expect(spam.props.accessibilityState.selected).toBe(true);
    expect(spam.findByType(Text).props.children).toBe('Spam');
    // Selected is white with a forest outline, never a tinted fill.
    const style = StyleSheet.flatten(spam.props.style({ pressed: false }));
    expect(style.backgroundColor).toBe(theme.color.paperSheet);
    expect(style.borderColor).toBe(theme.color.pineLine);
    expect(
      pressable(tree, 'peer-report-reason-harassment').props.accessibilityState
        .selected,
    ).toBe(false);
    expect(texts(tree)).not.toContain('• ');

    await unmount(tree);
  });
});

describe('peer profile — the block button is the kit’s outlined shape', () => {
  test('warning tone: a slate outline at button height, never a filled red button', async () => {
    const tree = await renderProfile();
    const block = pressable(tree, 'peer-block');
    const style = StyleSheet.flatten(block.props.style({ pressed: false }));
    expect(style.minHeight).toBe(theme.layout.buttonHeight);
    expect(style.borderWidth).toBe(1);
    expect(style.borderColor).toBe(theme.color.warningMark);
    expect(style.backgroundColor).toBe('transparent');
    expect(StyleSheet.flatten(block.findByType(Text).props.style).color).toBe(
      theme.color.warningInk,
    );
    await unmount(tree);
  });
});

describe('peer profile — per-device safety numbers are safety numbers', () => {
  test('a device pair’s number is the anchor pair’s grid: twelve cells, three to a row', async () => {
    jest
      .spyOn(db, 'listPeerDevices')
      .mockResolvedValue([deviceRow(PEER, 'linked'), deviceRow(TABLET, 'linked')]);
    const tree = await renderProfile();
    expect(has(tree, `peer-device-${TABLET}`)).toBe(true); // the fixture reached the section

    const grid = host(tree, `peer-device-number-${TABLET}`);
    expect(grid.props.accessibilityLabel).toBe(spokenSafetyNumber(SAFETY));
    const cells = grid.findAllByType(Text);
    expect(cells.map(c => c.props.children)).toEqual(safetyGroups(SAFETY));
    for (const cell of cells) {
      const style = StyleSheet.flatten(cell.props.style);
      expect(style.fontFamily).toBe(theme.type.safetyNumber.fontFamily);
      expect(style.fontSize).toBe(theme.type.safetyNumber.fontSize);
      expect(style.width).toBe('33.333%');
      expect(cell.props.adjustsFontSizeToFit).toBe(true);
    }
    // Never the proportional run that wrapped wherever the width fell.
    expect(texts(tree)).not.toContain(safetyGroups(SAFETY).join('  '));

    await unmount(tree);
  });
});

describe('peer profile — polish', () => {
  test('the ID row carries Copy: the bare id lands on the pasteboard and the row says so for a moment', async () => {
    const setString = jest.spyOn(RN.Clipboard, 'setString').mockImplementation(() => {});
    const tree = await renderProfile();
    expect(has(tree, 'peer-id-copied')).toBe(false);

    jest.useFakeTimers();
    await press(tree, 'peer-copy-id');
    expect(setString).toHaveBeenCalledWith(PEER);
    expect(has(tree, 'peer-id-copied')).toBe(true);

    await ReactTestRenderer.act(async () => {
      jest.advanceTimersByTime(3000);
    });
    expect(has(tree, 'peer-id-copied')).toBe(false);

    await unmount(tree);
  });

  test('nickname Save is off while nothing changed, and says so on this device once it saved', async () => {
    chat.row = chatRow('Mum');
    const tree = await renderProfile();
    const save = () => pressable(tree, 'peer-nickname-save');
    expect(save().props.disabled).toBe(true);
    expect(save().props.accessibilityState.disabled).toBe(true);

    // Whitespace is not a change: the stored bytes are the sanitized bytes.
    await ReactTestRenderer.act(async () => {
      field(tree, 'peer-nickname-input').props.onChangeText('Mum ');
    });
    expect(save().props.disabled).toBe(true);

    await ReactTestRenderer.act(async () => {
      field(tree, 'peer-nickname-input').props.onChangeText('Mummy');
    });
    expect(save().props.disabled).toBe(false);
    expect(has(tree, 'peer-nickname-saved')).toBe(false);

    jest.useFakeTimers();
    await press(tree, 'peer-nickname-save');
    expect(has(tree, 'peer-nickname-saved')).toBe(true);
    expect(texts(tree)).toContain(`Saved on this ${DEVICE_NOUN}`);
    expect(
      executed.some(s => s.includes('UPDATE chats SET localName')),
    ).toBe(true);

    await ReactTestRenderer.act(async () => {
      jest.advanceTimersByTime(3000);
    });
    expect(has(tree, 'peer-nickname-saved')).toBe(false);

    await unmount(tree);
  });
});
