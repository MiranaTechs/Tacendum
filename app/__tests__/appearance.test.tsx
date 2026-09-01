/**
 * The dark option: choosing an appearance re-renders every token consumer
 * through the theme context, and the choice notifies subscribers so App can
 * flip the provider. The default without any choice or provider is light —
 * the palette the app has always had.
 */

import React from 'react';
import { Text } from 'react-native';
import ReactTestRenderer from 'react-test-renderer';
import {
  appearanceChoice,
  setAppearanceChoice,
  subscribeAppearance,
} from '../src/appearance';
import { ThemeProvider, useTheme } from '../src/theme';

function Ground() {
  const t = useTheme();
  return <Text testID="ground">{`${t.scheme}:${t.color.paperGround}`}</Text>;
}

afterEach(() => {
  setAppearanceChoice('light');
});

test('the default is light, with and without a provider', async () => {
  expect(appearanceChoice()).toBe('light');
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(<Ground />);
  });
  expect(tree.root.findByProps({ testID: 'ground' }).props.children).toBe(
    'light:#EFF2EB',
  );
  await ReactTestRenderer.act(() => tree.unmount());
});

test('the provider swaps every token consumer to the night palette', async () => {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <ThemeProvider mode="dark">
        <Ground />
      </ThemeProvider>,
    );
  });
  expect(tree.root.findByProps({ testID: 'ground' }).props.children).toBe(
    'dark:#0C0F0D',
  );
  await ReactTestRenderer.act(() => tree.unmount());
});

test('subscribing replays the current choice, then notifies each change exactly once', () => {
  const seen: string[] = [];
  const unsubscribe = subscribeAppearance(next => seen.push(next));
  setAppearanceChoice('dark');
  setAppearanceChoice('dark'); // no-op: unchanged
  setAppearanceChoice('system');
  unsubscribe();
  setAppearanceChoice('light');
  // 'light' first: snapshot replay on subscribe (the Android hydration race
  // fix — appearance.android.test.ts pins the ordering that needed it), then
  // one notification per actual change. Subscribers setState with it, so the
  // unchanged replay is a no-op re-render at worst.
  expect(seen).toEqual(['light', 'dark', 'system']);
  expect(appearanceChoice()).toBe('light');
});
