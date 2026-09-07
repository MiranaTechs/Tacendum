/**
 * Settings › SCREEN: the blank-while-recorded choice. The chips flip the
 * screenSecurity policy and persist it; the section also carries the honest
 * screenshot sentence (blocking is impossible on iOS — only disclosure).
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { SettingsScreen } from '../src/screens/SettingsScreen';
import { screenSecurity } from '../src/screenSecurity';
import { session } from '../src/session';

const crypto = jest.requireMock('tacendum-crypto') as {
  __keychain: Map<string, string>;
};

beforeEach(() => {
  crypto.__keychain.clear();
  session.setMode('real');
});

afterEach(async () => {
  // The singleton carries state across tests in this file; put it back.
  await screenSecurity.setBlankEnabled(true);
});

async function renderSettings(): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <SettingsScreen
        onBack={jest.fn()}
        onOpenLinkedDevices={jest.fn()}
        onOpenAccountEmail={jest.fn()}
      />,
    );
  });
  await ReactTestRenderer.act(async () => {});
  await ReactTestRenderer.act(async () => {
    tree.root
      .findByProps({ testID: 'settings-category-privacy' })
      .props.onPress();
  });
  return tree;
}

function chip(tree: ReactTestRenderer.ReactTestRenderer, id: string) {
  const found = tree.root.findAll(n => n.props.testID === id);
  expect(found.length).toBeGreaterThan(0);
  return found[0];
}

test('blanking is on by default and the chips flip and persist it', async () => {
  const tree = await renderSettings();

  expect(chip(tree, 'settings-screensec-on').props.accessibilityState).toEqual({
    selected: true,
  });
  // The visual stays small; the touch target must not (theme touchTarget 44).
  expect(chip(tree, 'settings-screensec-on').props.hitSlop).toEqual({
    top: 5,
    bottom: 5,
  });

  await ReactTestRenderer.act(async () => {
    chip(tree, 'settings-screensec-off').props.onPress();
  });
  expect(screenSecurity.blankEnabled).toBe(false);
  expect(crypto.__keychain.get('screensec.blank')).toBe('0');
  expect(chip(tree, 'settings-screensec-off').props.accessibilityState).toEqual(
    { selected: true },
  );

  await ReactTestRenderer.act(async () => {
    chip(tree, 'settings-screensec-on').props.onPress();
  });
  expect(screenSecurity.blankEnabled).toBe(true);
  expect(crypto.__keychain.get('screensec.blank')).toBe('1');

  await ReactTestRenderer.act(() => {
    tree.unmount();
  });
});

test('the section tells the truth about screenshots', async () => {
  const tree = await renderSettings();
  // The screenshot sentence is the SECTION's ⓘ: closed until opened,
  // under the sheet.
  await ReactTestRenderer.act(async () => {
    tree.root
      .findAll(
        n =>
          n.props.testID === 'settings-shot-info' &&
          n.props.onPress !== undefined,
      )[0]
      .props.onPress();
  });
  const texts = tree.root
    .findAllByType(require('react-native').Text)
    .map(n =>
      Array.isArray(n.props.children)
        ? n.props.children.join('')
        : String(n.props.children ?? ''),
    );
  expect(texts.some(s => s.includes('Screenshots can’t be blocked'))).toBe(
    true,
  );
  await ReactTestRenderer.act(() => {
    tree.unmount();
  });
});
