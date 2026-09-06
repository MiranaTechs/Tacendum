/**
 * YOUR CODE, WHERE A PERSON LOOKS FOR IT.
 *
 * Invite-only reachability is this product's first differentiator and it had
 * no home: showing your code was three taps and a scroll inside a screen
 * called "Start a chat" — the screen for reaching THEM — while the scanner
 * was the first control on it. The profile, the screen a person opens looking
 * for their own identity, contained no QR at all.
 *
 * Two properties are pinned here, and neither is decoration.
 *
 * 1. THE LABEL IS THE SAME OBJECT PROPERTY, not a second literal that happens
 * to match today. The same action must never get two different sentences,
 * and a copy deck is only a deck if the other surface reads it.
 * 2. THE PANEL STAYS LAZY. `QrPanel` is documented as mounted only while
 * expanded, so a CoreImage failure cannot degrade the screen — and that is
 * now true on two screens, including the one that also holds Delete
 * account.
 *
 * Two QR sites is the right number; there is no third this release.
 */

jest.mock('react-native-image-picker', () => ({
  launchImageLibrary: jest.fn(),
  launchCamera: jest.fn(),
}));

import React from 'react';
import { StyleSheet } from 'react-native';
import ReactTestRenderer from 'react-test-renderer';
import type { ProfileRow } from '../src/db';
import { themeTokens } from '../src/theme';
import { ProfileScreen } from '../src/screens/ProfileScreen';
import { COPY as START_CHAT_COPY } from '../src/screens/StartChatScreen';

const nativeQr = jest.requireMock('tacendum-qr') as {
  encodePng: jest.Mock;
  __qr: { reset: () => void };
};

const PROFILE: ProfileRow = {
  userId: '01KYDBSSDJSPC9J0E5N2AWMJ5Y',
  registrationId: 7,
  displayName: 'Ana',
  about: '',
  avatarB64: '',
  profileVersion: 1,
};

beforeEach(() => {
  nativeQr.__qr.reset();
  nativeQr.encodePng.mockClear();
});

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

function byId(tree: ReactTestRenderer.ReactTestRenderer, id: string) {
  return tree.root.findAll(
    n => n.props.testID === id && typeof n.type === 'string',
  );
}

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

/** What VoiceOver actually hears: the label on the pressable, not the prop
 * the caller handed the component. */
function spokenLabel(
  tree: ReactTestRenderer.ReactTestRenderer,
  id: string,
): unknown {
  return tree.root.find(
    n =>
      n.props.testID === id && typeof n.props.accessibilityLabel === 'string',
  ).props.accessibilityLabel;
}

test('the code sits under the ID, collapsed, and nothing is drawn until it is asked for', async () => {
  const tree = await render();

  expect(byId(tree, 'profile-show-qr').length).toBe(1);
  expect(byId(tree, 'self-qr-image').length).toBe(0);
  // Lazy by construction: the encode has not run, so a draw failure cannot
  // reach the screen that also holds Delete account.
  expect(nativeQr.encodePng).not.toHaveBeenCalled();

  await ReactTestRenderer.act(() => tree.unmount());
});

test('the label is the Start a chat deck’s own property, not a second literal', async () => {
  const tree = await render();

  // Identity against the deck, so a reword on either screen cannot leave the
  // two surfaces saying different things about one action.
  expect(spokenLabel(tree, 'profile-show-qr')).toBe(START_CHAT_COPY.qrShow);

  await press(tree, 'profile-show-qr');
  expect(spokenLabel(tree, 'profile-show-qr')).toBe(START_CHAT_COPY.qrHide);

  await ReactTestRenderer.act(() => tree.unmount());
});

test('it opens in place and closes again, taking the picture with it', async () => {
  const tree = await render();

  await press(tree, 'profile-show-qr');
  expect(byId(tree, 'self-qr-image').length).toBe(1);
  // The panel brings its own share action and its own ⓘ — the profile adds
  // no second explanation of the same picture.
  expect(byId(tree, 'share-self-qr').length).toBe(1);
  expect(byId(tree, 'self-qr-explain').length).toBe(1);

  await press(tree, 'profile-show-qr');
  expect(byId(tree, 'self-qr-image').length).toBe(0);

  await ReactTestRenderer.act(() => tree.unmount());
});

test('the panel is drawn for the owner’s own id and nothing else', async () => {
  const tree = await render();
  await press(tree, 'profile-show-qr');

  expect(nativeQr.encodePng).toHaveBeenCalledTimes(1);
  expect(nativeQr.encodePng.mock.calls[0]![0]).toBe(PROFILE.userId);

  await ReactTestRenderer.act(() => tree.unmount());
});

/**
 * THE GUTTER THE SHEET DOES NOT HAVE.
 *
 * `styles.identity` is rendered full-bleed — `marginHorizontal:
 * -t.layout.gutter` — so every child re-adds the column's own 16pt itself,
 * and `IdentityRow` does it internally. A `QrPanel` dropped in bare would
 * draw a rounded, hairline-bordered card whose border ran off both edges of
 * the viewport with its corners clipped, on a sheet of the same colour, and
 * its own side maths (`width - 2 * gutter - 2 * s8`) would subtract a gutter
 * that was not there.
 *
 * Two insets, not one: the panel takes the full gutter, and the disclosure
 * takes 8pt less because `TextAction` spends 8pt of its own on the pressed
 * wash ("callers with a gutter to respect wrap it and spend the overhang
 * themselves" — primitives.tsx). Net, the word "Show QR code" starts on the
 * same column as the ID label above it.
 */
describe('the QR block sits on the column, not on the screen edge', () => {
  /** `TextAction`'s own horizontal padding (primitives.tsx `styles.textAction`)
   * — the overhang this screen spends so the LABEL, not the press target,
   * lines up with the gutter. */
  const TEXT_ACTION_PRESS_PADDING = 8;

  function inset(
    tree: ReactTestRenderer.ReactTestRenderer,
    id: string,
  ): { paddingHorizontal?: number; paddingBottom?: number } {
    const node = tree.root.find(
      n => n.props.testID === id && typeof n.type === 'string',
    );
    return StyleSheet.flatten(node.props.style) as {
      paddingHorizontal?: number;
      paddingBottom?: number;
    };
  }

  test('the disclosure label starts on the gutter the rows above it use', async () => {
    const tree = await render();
    const t = themeTokens();

    expect(inset(tree, 'profile-qr-disclosure').paddingHorizontal).toBe(
      t.layout.gutter - TEXT_ACTION_PRESS_PADDING,
    );

    await ReactTestRenderer.act(() => tree.unmount());
  });

  test('the panel is inset by the whole gutter and clears the sheet’s bottom rule', async () => {
    const tree = await render();
    await press(tree, 'profile-show-qr');
    const t = themeTokens();

    const panel = inset(tree, 'profile-qr-inset');
    expect(panel.paddingHorizontal).toBe(t.layout.gutter);
    // A bordered card must not sit on the hairline that closes the sheet.
    expect(panel.paddingBottom).toBeGreaterThan(0);

    await ReactTestRenderer.act(() => tree.unmount());
  });
});
