/**
 * The field's frame.
 *
 *  - the field does NOT take focus on entry — a keyboard on
 *    entry would cover Scan and My ID. And the keyboard's go key with
 *    nothing typed starts nothing and says nothing: "That's 0 of 26
 *    characters" was the old disabled button's own promise broken.
 *  - the copy notice's timer is cleared on unmount.
 *  - the action never shares the field's row (restated in build 33), so
 *    "never squeeze the field" holds by construction — the button is full
 *    width under the field, and the only control inside the field's border
 *    is its own clear button.
 *
 * Harness follows StartChat.qr.test.tsx: the fake op-sqlite stub records
 * every write, so a chat that was NOT started is provable. */

import React from 'react';
import { Clipboard, StyleSheet, Text } from 'react-native';
import ReactTestRenderer from 'react-test-renderer';
import * as db from '../src/db';
import { StartChatScreen } from '../src/screens/StartChatScreen';
import { themeTokens } from '../src/theme';
import { PaneWidthProvider } from '../src/windowClass';

jest.mock('react-native-image-picker', () => ({
  launchImageLibrary: jest.fn(),
  launchCamera: jest.fn(),
}));

const theme = themeTokens();

const PROFILE_PEER = '01BX5ZZKBKACTAV9WEVGEMMVRZ';

const sqlite = (
  jest.requireMock('@op-engineering/op-sqlite') as {
    __sqlite: {
      reset: () => void;
      instances: Map<string, { execute: jest.Mock }>;
    };
  }
).__sqlite;

const PROFILE: db.ProfileRow = {
  userId: '01KYDBSSDJSPC9J0E5N2AWMJ5Y',
  registrationId: 7,
  displayName: '',
  about: '',
  avatarB64: '',
  profileVersion: 0,
};

/** Every `INSERT INTO chats` the screen has actually issued. */
function chatWrites(): string[] {
  const out: string[] = [];
  for (const inst of sqlite.instances.values()) {
    for (const call of inst.execute.mock.calls) {
      const sql = String(call[0]);
      if (sql.includes('INSERT INTO chats')) out.push(sql);
    }
  }
  return out;
}

beforeEach(async () => {
  await db.close();
  sqlite.reset();
  db.setWorkspace('real');
  await db.initDb();
});

afterEach(async () => {
  jest.useRealTimers();
  jest.restoreAllMocks();
  await db.close();
});

async function render(
  paneWidth?: number,
): Promise<ReactTestRenderer.ReactTestRenderer> {
  const screen = (
    <StartChatScreen
      profile={PROFILE}
      onBack={jest.fn()}
      onOpenChat={jest.fn()}
      onOpenAccountEmail={jest.fn()}
    />
  );
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      paneWidth === undefined ? (
        screen
      ) : (
        <PaneWidthProvider width={paneWidth}>{screen}</PaneWidthProvider>
      ),
    );
  });
  await ReactTestRenderer.act(async () => {});
  return tree;
}

/** The field itself: the outermost node carrying onChangeText. */
function field(tree: ReactTestRenderer.ReactTestRenderer) {
  return tree.root.findAll(
    n =>
      n.props.testID === 'new-peer-input' &&
      typeof n.props.onChangeText === 'function',
  )[0]!;
}

/** The control itself. Harness change for build 33: PrimaryButton,
 * OutlineButton and TextAction put testID and onPress on the composite AND
 * its Pressable, so the first match is taken rather than a `find`. */
function control(tree: ReactTestRenderer.ReactTestRenderer, id: string) {
  return tree.root.findAll(
    n => n.props.testID === id && typeof n.props.onPress === 'function',
  )[0]!;
}

/** Type a whole value in one change (a paste of an ID fills it grouped). */
async function type(tree: ReactTestRenderer.ReactTestRenderer, text: string) {
  await ReactTestRenderer.act(async () => {
    field(tree).props.onChangeText(text);
  });
}

function shownText(tree: ReactTestRenderer.ReactTestRenderer): string {
  return tree.root
    .findAllByType(Text)
    .map(n =>
      Array.isArray(n.props.children)
        ? n.props.children.join('')
        : String(n.props.children ?? ''),
    )
    .join('\n');
}

/** A host node's flattened style (the View under a composite). */
function hostStyle(tree: ReactTestRenderer.ReactTestRenderer, id: string) {
  const host = tree.root.findAll(
    n => n.props.testID === id && typeof n.type === 'string',
  )[0]!;
  return StyleSheet.flatten(host.props.style) as Record<string, unknown>;
}

test('the field does not take focus on entry — the keyboard would cover Scan and My ID', async () => {
  const tree = await render();
  expect(field(tree).props.autoFocus).toBeFalsy();
});

test('the keyboard’s go key with nothing typed starts nothing and says nothing', async () => {
  const tree = await render();
  await ReactTestRenderer.act(async () => {
    field(tree).props.onSubmitEditing();
  });
  expect(chatWrites()).toEqual([]);
  // Not the disabled button's broken promise, and no error of any kind.
  expect(shownText(tree)).not.toMatch(/0 of 26/);
  expect(shownText(tree)).not.toMatch(/Ask them for the whole ID/);
});

test('the copy notice’s timer is cleared on unmount', async () => {
  jest.useFakeTimers();
  jest.spyOn(Clipboard, 'setString').mockImplementation(() => {});
  // The screen resolves `setTimeout`/`clearTimeout` on the global at call
  // time, so spies on the (fake) globals see its calls. The copy timer is
  // the one armed for the notice's 3000 ms; other effects arm their own,
  // which is why the count alone cannot be the pin.
  const armed = jest.spyOn(globalThis, 'setTimeout');
  const cleared = jest.spyOn(globalThis, 'clearTimeout');
  const tree = await render();

  // Your own ID waits behind My ID; the timer is useTransientNotice's now.
  await ReactTestRenderer.act(async () => {
    control(tree, 'show-self-id').props.onPress();
  });
  await ReactTestRenderer.act(async () => {
    control(tree, 'copy-self-id').props.onPress();
  });
  expect(tree.root.findAll(n => n.props.testID === 'self-id-copied').length)
    .toBeGreaterThan(0);
  const copyTimer = armed.mock.calls.findIndex(([, delay]) => delay === 3000);
  expect(copyTimer).toBeGreaterThanOrEqual(0);
  const handle = armed.mock.results[copyTimer]!.value;
  expect(cleared).not.toHaveBeenCalledWith(handle);

  await ReactTestRenderer.act(async () => {
    tree.unmount();
  });
  // Back within the 3 s: the timer went with the screen, so nothing can
  // fire a state write at a surface that no longer exists.
  expect(cleared).toHaveBeenCalledWith(handle);
});

// Rewritten for build 33: the action no longer shares the field's row, so
// the "floor, not a fixed width" rule becomes "full width under the field".
test('Start chat is a full-width button under the field, never a fixed width', async () => {
  const tree = await render();
  await type(tree, PROFILE_PEER);
  const style = hostStyle(tree, 'start-chat') as {
    width?: number | string;
    minHeight?: number;
  };
  expect(style.width).toBe('100%');
  expect(style.minHeight).toBe(theme.layout.buttonHeight);
});

// Rewritten for build 33 as an invariant: the clear button lives inside the
// bordered field on purpose, and no action can ever squeeze the field.
test('at and above layout.narrowWidth no action sits inside the field; its one button is Clear; Start chat comes after it', async () => {
  for (const width of [theme.layout.narrowWidth, theme.layout.narrowWidth + 200]) {
    const tree = await render(width);
    await type(tree, PROFILE_PEER);
    const box = tree.root.findAll(
      n => n.props.testID === 'new-peer-field' && typeof n.type === 'string',
    )[0]!;
    const inside = box.findAll(n => typeof n.type === 'string');
    expect(inside.some(n => n.props.testID === 'start-chat')).toBe(false);
    expect(inside.some(n => n.props.testID === 'discovery-search')).toBe(false);
    expect(
      inside
        .filter(n => n.props.accessibilityRole === 'button')
        .map(n => n.props.testID),
    ).toEqual(['new-peer-clear']);
    const order = tree.root
      .findAll(
        n =>
          typeof n.type === 'string' &&
          (n.props.testID === 'new-peer-field' || n.props.testID === 'start-chat'),
      )
      .map(n => n.props.testID);
    expect(order).toEqual(['new-peer-field', 'start-chat']);
    await ReactTestRenderer.act(async () => {
      tree.unmount();
    });
  }
});
