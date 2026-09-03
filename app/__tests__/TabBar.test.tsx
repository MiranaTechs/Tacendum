/**
 * The home tab rail.
 *
 *  - the label is a type role with a Dynamic Type cap: a rail is a fixed
 *    frame, and an uncapped 11pt label reached ~34pt at accessibility sizes;
 *  - the glyphs are vector art, not the `▤`/`✆` characters — `✆` was also
 *    the audio-redial mark, so the Calls tab read as "audio call";
 *  - the chosen tab is not colour-only: a 2pt pine rule sits under it. */

import React from 'react';
import { StyleSheet, Text } from 'react-native';
import ReactTestRenderer from 'react-test-renderer';
import { themeTokens } from '../src/theme';
import { HANDSET_PATH } from '../src/ui/CallGlyph';
import { TabBar, type HomeTab } from '../src/ui/TabBar';

const theme = themeTokens();

async function render(
  active: HomeTab,
  onSelect: jest.Mock = jest.fn(),
): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(<TabBar active={active} onSelect={onSelect} />);
  });
  return tree;
}

/** The tab element itself — the composite carrying the tab role. */
function tab(tree: ReactTestRenderer.ReactTestRenderer, label: string) {
  return tree.root.find(
    n => n.props.accessibilityRole === 'tab' && n.props.accessibilityLabel === label,
  );
}

test('the labels take the buttonCompact role and stop growing at 1.5×', async () => {
  const tree = await render('chats');
  const labels = tree.root.findAllByType(Text);
  expect(labels.map(l => l.props.children)).toEqual(['Rooms', 'Calls']);
  for (const label of labels) {
    const style = StyleSheet.flatten(label.props.style);
    expect(style.fontSize).toBe(theme.type.buttonCompact.fontSize);
    expect(style.fontWeight).toBe(theme.type.buttonCompact.fontWeight);
    expect(label.props.maxFontSizeMultiplier).toBe(1.5);
  }
});

test('the glyphs are vector art — no ▤/✆ characters — and Calls is the handset plus an arrow, not the redial mark alone', async () => {
  const tree = await render('chats');
  // No typographic stand-ins anywhere in the rail.
  const glyphText = tree.root
    .findAllByType(Text)
    .map(n => String(n.props.children))
    .filter(s => /[▤✆]/.test(s));
  expect(glyphText).toEqual([]);

  // One piece of 24-box art per tab, hidden from VoiceOver.
  const art = tree.root.findAll(n => n.props.viewBox === '0 0 24 24');
  expect(art).toHaveLength(2);
  for (const svg of art) expect(svg.props.accessibilityElementsHidden).toBe(true);

  // The Calls tab draws the kit's handset AND a second stroke beside it.
  const callPaths = tab(tree, 'Calls').findAll(n => typeof n.props.d === 'string');
  expect(callPaths.map(p => p.props.d)).toContain(HANDSET_PATH);
  expect(callPaths.length).toBeGreaterThanOrEqual(2);
  // The Rooms tab draws its own art — never the handset.
  const roomPaths = tab(tree, 'Rooms').findAll(n => typeof n.props.d === 'string');
  expect(roomPaths.map(p => p.props.d)).not.toContain(HANDSET_PATH);
  expect(roomPaths.length).toBeGreaterThanOrEqual(1);
});

test('selection is not colour-only: a 2pt pine rule sits under the chosen tab and only there', async () => {
  const tree = await render('calls');
  const ruleOf = (key: HomeTab) =>
    StyleSheet.flatten(
      tree.root.find(
        n => n.props.testID === `tab-rule-${key}` && typeof n.type === 'string',
      ).props.style,
    ) as { height?: number; backgroundColor?: string };

  expect(ruleOf('calls').height).toBe(2);
  expect(ruleOf('calls').backgroundColor).toBe(theme.color.pine);
  // The unchosen tab keeps the rule's SPACE (the rail's height must not
  // change with the selection) but paints nothing.
  expect(ruleOf('chats').height).toBe(2);
  expect(ruleOf('chats').backgroundColor).toBe('transparent');

  // And the role-level state agrees.
  expect(tab(tree, 'Calls').props.accessibilityState).toEqual({ selected: true });
  expect(tab(tree, 'Rooms').props.accessibilityState).toEqual({ selected: false });
});

test('a tap still selects', async () => {
  const onSelect = jest.fn();
  const tree = await render('chats', onSelect);
  await ReactTestRenderer.act(async () => {
    tab(tree, 'Calls').props.onPress();
  });
  expect(onSelect).toHaveBeenCalledWith('calls');
});
