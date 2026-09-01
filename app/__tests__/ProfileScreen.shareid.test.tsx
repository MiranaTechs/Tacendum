/**
 * The profile is where the id lives, so it has to offer both ways of handing
 * it over: Copy (the bare 26 characters onto the pasteboard, no expiry — an id
 * is an address, not a secret) and Share (the three-line message whose second
 * line is the id alone, so the recipient can paste it into Start a chat
 * without editing anything). Neither carries a `url`: the id is a bare ULID
 * on every surface (pinned guardrail).
 */

jest.mock('react-native-image-picker', () => ({
  launchImageLibrary: jest.fn(),
  launchCamera: jest.fn(),
}));

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import type { ProfileRow } from '../src/db';
import { shareIdMessage } from '../src/peerId';
import { ProfileScreen } from '../src/screens/ProfileScreen';

const RN: typeof import('react-native') = require('react-native');

const PROFILE: ProfileRow = {
  userId: '01KYDBSSDJSPC9J0E5N2AWMJ5Y',
  registrationId: 7,
  displayName: 'Ana',
  about: '',
  avatarB64: '',
  profileVersion: 1,
};

async function render(): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <ProfileScreen
        profile={PROFILE}
        onBack={jest.fn()}
        onProfileChanged={jest.fn()}
        onOpenSettings={jest.fn()}
        onSignedOut={jest.fn()}
      />,
    );
  });
  await ReactTestRenderer.act(async () => {});
  return tree;
}

/** The control itself: a Pressable's host View carries no `onPress`. */
function control(tree: ReactTestRenderer.ReactTestRenderer, id: string) {
  return tree.root.find(
    n => n.props.testID === id && typeof n.props.onPress === 'function',
  );
}

function press(tree: ReactTestRenderer.ReactTestRenderer, id: string) {
  return ReactTestRenderer.act(async () => {
    control(tree, id).props.onPress();
  });
}

function renderedText(tree: ReactTestRenderer.ReactTestRenderer): string {
  return tree.root
    .findAllByType(RN.Text)
    .map(n =>
      Array.isArray(n.props.children)
        ? n.props.children.join('')
        : String(n.props.children ?? ''),
    )
    .join('\n');
}

let setString: jest.SpyInstance;
let share: jest.SpyInstance;

beforeEach(() => {
  jest.useFakeTimers();
  setString = jest.spyOn(RN.Clipboard, 'setString').mockImplementation(() => {});
  share = jest
    .spyOn(RN.Share, 'share')
    .mockResolvedValue({ action: 'sharedAction' } as never);
});

afterEach(() => {
  setString.mockRestore();
  share.mockRestore();
  jest.useRealTimers();
});

test('Copy puts the bare id on the pasteboard and says so beside the row', async () => {
  const tree = await render();

  await press(tree, 'copy-profile-user-id');

  expect(setString).toHaveBeenCalledTimes(1);
  expect(setString).toHaveBeenCalledWith(PROFILE.userId);
  expect(renderedText(tree)).toContain('Copied.');

  await ReactTestRenderer.act(() => tree.unmount());
});

test('Share sends the three-line message with the id alone on its own line, and no url', async () => {
  const tree = await render();

  await press(tree, 'share-profile-user-id');

  expect(share).toHaveBeenCalledTimes(1);
  const content = share.mock.calls[0]![0] as { message?: string; url?: string };
  expect(content.url).toBeUndefined();
  expect(content.message).toBe(shareIdMessage(PROFILE.userId));
  expect(content.message!.split('\n')[1]).toBe(PROFILE.userId);
  // A copy is not a share (exactly four share sites are pinned).
  expect(setString).not.toHaveBeenCalled();

  await ReactTestRenderer.act(() => tree.unmount());
});
