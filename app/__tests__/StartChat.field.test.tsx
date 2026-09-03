/**
 * The ID field's frame.
 *
 *  - the field does NOT take focus on entry — QR is the lead
 *    rail (§4), and a keyboard on entry covered the scanner, the photo door,
 *    Find by email and the person's own ID. And the keyboard's go key with
 *    nothing typed starts nothing and says nothing: the disabled button was
 *    designed to prevent "That's 0 of 26 characters", and the field's own
 *    submit used to produce it.
 *  - the copy notice's timer is cleared on unmount.
 *  - the Start chat button is a floor with padding from the
 *    scale, never a fixed 112pt, and it drops under the field below
 *    layout.narrowWidth.
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
      onFindByEmail={jest.fn()}
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

/** The field itself: the composite carrying onChangeText. */
function field(tree: ReactTestRenderer.ReactTestRenderer) {
  return tree.root.find(
    n =>
      n.props.testID === 'new-peer-input' &&
      typeof n.props.onChangeText === 'function',
  );
}

/** The control itself: a Pressable's host View carries no `onPress`. */
function control(tree: ReactTestRenderer.ReactTestRenderer, id: string) {
  return tree.root.find(
    n => n.props.testID === id && typeof n.props.onPress === 'function',
  );
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
  const host = tree.root.find(
    n => n.props.testID === id && typeof n.type === 'string',
  );
  return StyleSheet.flatten(host.props.style) as Record<string, unknown>;
}

test('the ID field does not take focus on entry — QR stays the lead rail', async () => {
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
  // the one armed for COPY_NOTICE_MS (3000); the notice's own announce
  // effect arms another, which is why the count alone cannot be the pin.
  const armed = jest.spyOn(globalThis, 'setTimeout');
  const cleared = jest.spyOn(globalThis, 'clearTimeout');
  const tree = await render();

  // The own-ID block waits behind "Show my ID".
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

test('the Start chat button is a floor with scale padding, never a fixed 112pt', async () => {
  const tree = await render();
  const button = control(tree, 'start-chat');
  const style = StyleSheet.flatten(button.props.style({ pressed: false })) as {
    width?: number;
    minWidth?: number;
    paddingHorizontal?: number;
  };
  expect(style.width).toBeUndefined();
  expect(style.minWidth).toBeGreaterThan(0);
  expect(style.paddingHorizontal).toBe(theme.space.s6);
});

test('below layout.narrowWidth the button drops under the field; above it they share a row', async () => {
  const narrow = await render(theme.layout.narrowWidth);
  expect(hostStyle(narrow, 'start-chat-panel').flexDirection).toBe('column');
  const narrowButton = StyleSheet.flatten(
    control(narrow, 'start-chat').props.style({ pressed: false }),
  ) as { alignSelf?: string; marginLeft?: number };
  expect(narrowButton.alignSelf).toBe('stretch');
  expect(narrowButton.marginLeft).toBeUndefined();

  const wide = await render(theme.layout.narrowWidth + 200);
  expect(hostStyle(wide, 'start-chat-panel').flexDirection).toBe('row');
});
