/**
 * The chat list carries conversations; reaching someone new lives behind the
 * + control on its own surface. The list must not render the compose
 * furniture, and the start screen must own the whole id → name → open flow.
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import * as db from '../src/db';
import { ChatListScreen } from '../src/screens/ChatListScreen';
import { StartChatScreen } from '../src/screens/StartChatScreen';

const sqlite = (
  jest.requireMock('@op-engineering/op-sqlite') as {
    __sqlite: { reset: () => void };
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

const PEER_ID = '01BX5ZZKBKACTAV9WEVGEMMVRZ';

beforeEach(async () => {
  await db.close();
  sqlite.reset();
  db.setWorkspace('real');
  await db.initDb();
});

afterEach(async () => {
  await db.close();
});

async function render(
  element: React.ReactElement,
): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(element);
  });
  await ReactTestRenderer.act(async () => {});
  return tree;
}

function byId(tree: ReactTestRenderer.ReactTestRenderer, id: string) {
  return tree.root.findAll(n => n.props.testID === id);
}

describe('ChatListScreen', () => {
  test('carries no compose furniture — reaching someone lives behind +', async () => {
    const onStartChat = jest.fn();
    const tree = await render(
      <ChatListScreen
        profile={PROFILE}
        onOpenChat={jest.fn()}
        onOpenProfile={jest.fn()}
        onStartChat={onStartChat}
        onStartRoom={jest.fn()}
      />,
    );

    expect(byId(tree, 'new-peer-input').length).toBe(0);
    expect(byId(tree, 'start-chat').length).toBe(0);
    const fab = byId(tree, 'new-chat-fab');
    expect(fab.length).toBeGreaterThan(0);
    await ReactTestRenderer.act(async () => {
      fab[0].props.onPress();
    });
    expect(onStartChat).toHaveBeenCalled();

    await ReactTestRenderer.act(() => {
      tree.unmount();
    });
  });

  test('the empty state offers Copy ID beside Share ID — the id must be pasteable end to end', async () => {
    const RN = require('react-native') as typeof import('react-native');
    const setString = jest
      .spyOn(RN.Clipboard, 'setString')
      .mockImplementation(() => {});
    const share = jest.spyOn(RN.Share, 'share').mockResolvedValue({
      action: 'sharedAction',
    } as never);
    const tree = await render(
      <ChatListScreen
        profile={PROFILE}
        onOpenChat={jest.fn()}
        onOpenProfile={jest.fn()}
        onStartChat={jest.fn()}
        onStartRoom={jest.fn()}
      />,
    );

    const copy = byId(tree, 'empty-copy-id');
    expect(copy.length).toBeGreaterThan(0);
    await ReactTestRenderer.act(async () => {
      copy[0].props.onPress();
    });
    // The bare id, nothing around it — and no expiry: an id is an address,
    // not a secret (contrast pasteboard.ts, which exists for credentials).
    expect(setString).toHaveBeenCalledWith(PROFILE.userId);
    expect(byId(tree, 'empty-id-copied').length).toBeGreaterThan(0);

    await ReactTestRenderer.act(async () => {
      byId(tree, 'empty-share-id')[0].props.onPress();
    });
    const content = share.mock.calls[0]![0] as { message?: string; url?: string };
    expect(content.url).toBeUndefined();
    expect(content.message).toBe(
      `My Tacendum ID:\n${PROFILE.userId}\nAdd me in Tacendum → Start a chat.`,
    );

    setString.mockRestore();
    share.mockRestore();
    await ReactTestRenderer.act(() => {
      tree.unmount();
    });
  });
});

describe('StartChatScreen', () => {
  test('owns the field, the id, and refuses your own id', async () => {
    const tree = await render(
      <StartChatScreen
        profile={PROFILE}
        onBack={jest.fn()}
        onOpenChat={jest.fn()}
        onFindByEmail={jest.fn()}
      />,
    );

    expect(byId(tree, 'new-peer-input').length).toBeGreaterThan(0);
    expect(byId(tree, 'self-user-id').length).toBeGreaterThan(0);
    // The no-directory explanation sits in the open here — a dedicated
    // surface has room for it, so it no longer hides behind an ⓘ toggle.
    // Reworded with the code that changed the fact:
    // typed, consent-gated find-by-email exists now, so the pinned sentence
    // claims "no public directory" — still true, structurally — instead of
    // "no search", which stopped being true on this very screen.
    const texts = tree.root
      .findAllByType(require('react-native').Text)
      .map(n =>
        Array.isArray(n.props.children)
          ? n.props.children.join('')
          : String(n.props.children ?? ''),
      );
    expect(texts.some(s => s.includes('no public directory'))).toBe(true);
    // Build 24: with the username class live the sentence names both doors
    // (the deck's pin-gated literal); a pin-OFF binary keeps the landed wording.
    const { USERNAME_UI_ENABLED } = require('../src/usernameUi') as typeof import('../src/usernameUi');
    expect(
      texts.some(s =>
        s.includes(
          USERNAME_UI_ENABLED
            ? 'the email or username of someone who chose to be found'
            : 'the email of someone who chose to be found',
        ),
      ),
    ).toBe(true);

    await ReactTestRenderer.act(async () => {
      byId(tree, 'new-peer-input')[0].props.onChangeText(PROFILE.userId);
    });
    await ReactTestRenderer.act(async () => {
      byId(tree, 'start-chat')[0].props.onPress();
    });
    expect(byId(tree, 'start-chat-error').length).toBeGreaterThan(0);

    await ReactTestRenderer.act(() => {
      tree.unmount();
    });
  });

  test('a fresh id walks id → name → open', async () => {
    const onOpenChat = jest.fn();
    const tree = await render(
      <StartChatScreen
        profile={PROFILE}
        onBack={jest.fn()}
        onOpenChat={onOpenChat}
        onFindByEmail={jest.fn()}
      />,
    );

    await ReactTestRenderer.act(async () => {
      byId(tree, 'new-peer-input')[0].props.onChangeText(PEER_ID);
    });
    await ReactTestRenderer.act(async () => {
      byId(tree, 'start-chat')[0].props.onPress();
    });
    const save = byId(tree, 'peer-nickname-save');
    expect(save.length).toBeGreaterThan(0);
    await ReactTestRenderer.act(async () => {
      byId(tree, 'peer-nickname-input')[0].props.onChangeText('Mira');
    });
    await ReactTestRenderer.act(async () => {
      save[0].props.onPress();
    });
    expect(onOpenChat).toHaveBeenCalledWith(PEER_ID);

    await ReactTestRenderer.act(() => {
      tree.unmount();
    });
  });
});
