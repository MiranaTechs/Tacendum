/**
 * The dark option: choosing an appearance re-renders every token consumer
 * through the theme context, and the choice notifies subscribers so App can
 * flip the provider. The default without any choice or provider is light —
 * the palette the app has always had.
 */

import React from 'react';
import { StyleSheet, Text } from 'react-native';
import ReactTestRenderer from 'react-test-renderer';
import {
  appearanceChoice,
  setAppearanceChoice,
  subscribeAppearance,
} from '../src/appearance';
import { ThemeProvider, themeTokens, useTheme } from '../src/theme';
import { CHIP_SELECTED_EDGE, ChoiceRow } from '../src/ui/ChoiceRow';

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
    `light:${themeTokens('light').color.paperGround}`,
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
    `dark:${themeTokens('dark').color.paperGround}`,
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

// Added for build 33: the Appearance choice is drawn by ChoiceRow,
// like every Settings choice. With the selected wash gone, a selected chip
// differed from its neighbours only by a one-device-pixel forest edge and
// its label's hue (forest against the muted gray: 1.04:1 in light, 1.00:1
// in dark). The chosen chip now carries a 1.5pt forest edge.
test('the chosen appearance chip carries a 1.5pt forest edge, the others a hairline, and no chip moves', async () => {
  for (const mode of ['light', 'dark'] as const) {
    const t = themeTokens(mode);
    let tree!: ReactTestRenderer.ReactTestRenderer;
    await ReactTestRenderer.act(() => {
      tree = ReactTestRenderer.create(
        <ThemeProvider mode={mode}>
          <ChoiceRow
            label="Theme"
            options={[
              { label: 'Light', value: 'light' },
              { label: 'Dark', value: 'dark' },
              { label: 'Match iPhone', value: 'system' },
            ]}
            value="dark"
            onChange={jest.fn()}
            testIDPrefix="settings-appearance"
          />
        </ThemeProvider>,
      );
    });
    const chip = (key: string) =>
      StyleSheet.flatten(
        tree.root.findAll(
          n => n.props.testID === `settings-appearance-${key}` && typeof n.type === 'string',
        )[0]!.props.style,
      ) as {
        borderWidth: number;
        borderColor: string;
        paddingHorizontal: number;
        paddingVertical: number;
      };
    const on = chip('dark');
    expect(on.borderWidth).toBe(CHIP_SELECTED_EDGE);
    expect(on.borderColor).toBe(t.color.pineLine);
    for (const key of ['light', 'system']) {
      const off = chip(key);
      expect(off.borderWidth).toBe(t.hairline);
      expect(off.borderColor).toBe(t.color.lineSoft);
      // The same outer box: the padding gives back what the edge takes.
      expect(on.paddingHorizontal + on.borderWidth).toBeCloseTo(
        off.paddingHorizontal + off.borderWidth,
      );
      expect(on.paddingVertical + on.borderWidth).toBeCloseTo(
        off.paddingVertical + off.borderWidth,
      );
    }
    await ReactTestRenderer.act(() => tree.unmount());
  }
});
