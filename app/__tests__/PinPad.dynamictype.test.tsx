/**
 * The keypad at the largest text size.
 *
 * PinPad is the lock screen and the account-delete re-auth — the two screens
 * nobody can skip — and its keys were a fixed 84×60 box around a 22pt mono
 * glyph with no cap on scaling. At a 3.1x accessibility size that is roughly
 * 68pt of glyph in a 60pt box: the digits are clipped on the screen you have
 * to read to get back into the app. Three fixed pixel sizes were doing three
 * different jobs, so each gets the answer it needs:
 *
 * height 60 -> minHeight 60 the box grows with the glyph
 * width 84 -> flex 1 three keys and two gaps no longer overflow a
 * 320pt window (276 + 48 of gutter is 324)
 * no cap -> 1.6x a keypad is a data grid; the ULID row at
 * primitives.tsx uses the same ceiling
 *
 * PinPad had zero referencing test files before this one.
 */

import React from 'react';
import { StyleSheet } from 'react-native';
import ReactTestRenderer from 'react-test-renderer';
import { themeTokens } from '../src/theme';
import { PinPad } from '../src/ui/PinPad';

const t = themeTokens();

function render(value = '12') {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <PinPad value={value} onChange={jest.fn()} onSubmit={jest.fn()} />,
    );
  });
  return tree;
}

const KEY_ID = /^pin-(key-\d|del|submit)$/;

/** Every key's resolved style — host nodes only, in an unpressed state. */
function keyStyles(
  tree: ReactTestRenderer.ReactTestRenderer,
): Record<string, unknown>[] {
  return tree.root
    .findAll(
      n =>
        typeof n.type === 'string' &&
        typeof n.props.testID === 'string' &&
        KEY_ID.test(n.props.testID),
    )
    .map(n => StyleSheet.flatten(n.props.style) as Record<string, unknown>);
}

function unmount(tree: ReactTestRenderer.ReactTestRenderer) {
  ReactTestRenderer.act(() => {
    tree.unmount();
  });
}

describe('PinPad keys grow with the type size', () => {
  test('the key box is a floor, not a fixed height', () => {
    const tree = render();
    const keys = keyStyles(tree);

    expect(keys.length).toBe(12);
    for (const key of keys) {
      expect(key.minHeight).toBe(60);
      // The defect itself: a fixed height clips the glyph it contains.
      expect(key.height).toBeUndefined();
    }

    unmount(tree);
  });

  test('the key width is the row, not a number', () => {
    const tree = render();

    for (const key of keyStyles(tree)) {
      expect(key.flex).toBe(1);
      expect(key.width).toBeUndefined();
      // Still bounded, so a keypad on a wide pane stays a keypad rather than
      // three 190pt slabs: 84 is the ceiling it used to be the fixed size.
      expect(key.maxWidth).toBe(84);
    }

    unmount(tree);
  });

  test('every glyph carries the data-grid cap', () => {
    const tree = render();

    const capped = tree.root.findAll(
      n =>
        typeof n.type === 'string' && n.props.maxFontSizeMultiplier === 1.6,
    );
    expect(capped.length).toBe(12);

    unmount(tree);
  });

  test('the pad still spends the scale, not literals', () => {
    const tree = render();
    // The rows are the only host views holding a gap; the five spacing
    // literals in this stylesheet are now steps on the scale.
    const gaps = tree.root
      .findAll(n => typeof n.type === 'string')
      .map(n => StyleSheet.flatten(n.props.style) as Record<string, unknown>)
      .filter(s => s !== undefined && s.gap !== undefined);

    expect(gaps.length).toBe(5); // one dot row plus four key rows
    for (const s of gaps) expect(s.gap).toBe(t.space.s5);

    unmount(tree);
  });

  test('the keys are still keys', () => {
    // Falsifier for the four style pins above: a stylesheet edit that lost the
    // pad entirely would pass every "toBeUndefined" assertion in this file.
    const tree = render('1234');

    const ids = tree.root
      .findAll(
        n =>
          typeof n.type === 'string' &&
          typeof n.props.testID === 'string' &&
          KEY_ID.test(n.props.testID),
      )
      .map(n => n.props.testID as string);

    expect(ids).toEqual([
      'pin-key-1',
      'pin-key-2',
      'pin-key-3',
      'pin-key-4',
      'pin-key-5',
      'pin-key-6',
      'pin-key-7',
      'pin-key-8',
      'pin-key-9',
      'pin-del',
      'pin-key-0',
      'pin-submit',
    ]);

    unmount(tree);
  });
});
