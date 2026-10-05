/**
 * A ROOM WEARS THE SAME FOREST AS A PERSON (2026-10-05).
 *
 * The room mark adopts the colour the person disc adopts: solid forest,
 * #0E6B45, with white letters, in light AND in dark. It supersedes the
 * earlier neutral mark (gray walls, an empty floor, charcoal letters); every
 * colour assertion below fails against that look.
 *
 * The FORM is the signal: a person is a circle, a room is the Quiet Room's
 * square with a doorway in its top wall. On the solid face the doorway is a
 * real notch with depth (a 1pt gap in a 1pt wall read as a nick on
 * screen, not a door), so the row's own ground shows through the threshold
 * at every size the mark is drawn.
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { StyleSheet, Text } from 'react-native';
import { RoomMark } from '../src/ui/RoomMark';
import { ThemeProvider, themeTokens } from '../src/theme';

const FOREST = '#0E6B45';
const WHITE = '#FFFFFF';
const ROOM = '01HQRRRR00000000000000000K';
const SIZE = 48;
const MODES = ['light', 'dark'] as const;

type Style = Record<string, unknown>;

const mounted: ReactTestRenderer.ReactTestRenderer[] = [];
afterEach(() => {
  ReactTestRenderer.act(() => {
    for (const tree of mounted.splice(0)) tree.unmount();
  });
});

function render(
  mode: 'light' | 'dark',
  props: Partial<React.ComponentProps<typeof RoomMark>> = {},
): ReactTestRenderer.ReactTestRenderer {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <ThemeProvider mode={mode}>
        <RoomMark roomId={ROOM} name="Book Club" size={SIZE} testID="mark" {...props} />
      </ThemeProvider>,
    );
  });
  mounted.push(tree);
  return tree;
}

/** Every absolutely placed piece of the mark: the two walls with their jambs
 * and the floor under the doorway. (The letters are laid out by the centred
 * box, never placed absolutely.) */
function pieces(tree: ReactTestRenderer.ReactTestRenderer): Style[] {
  return tree.root
    .findAll(n => typeof n.type === 'string')
    .map(n => StyleSheet.flatten(n.props.style) as Style | undefined)
    .filter((s): s is Style => s?.position === 'absolute');
}

/** Which whole points of a size × size mark the pieces paint, read off each
 * piece's own placement (a piece anchored right or bottom is mapped back). */
function coverage(all: Style[], size: number): boolean[][] {
  const grid = Array.from({ length: size }, () => Array<boolean>(size).fill(false));
  for (const s of all) {
    const width = Number(s.width);
    const height = Number(s.height);
    const x0 = s.left !== undefined ? Number(s.left) : size - Number(s.right) - width;
    const y0 = s.top !== undefined ? Number(s.top) : size - Number(s.bottom) - height;
    for (let y = y0; y < y0 + height; y++) {
      for (let x = x0; x < x0 + width; x++) {
        if (y >= 0 && y < size && x >= 0 && x < size) grid[y]![x] = true;
      }
    }
  }
  return grid;
}

function letters(tree: ReactTestRenderer.ReactTestRenderer, body: string) {
  const node = tree.root.findAll(
    n => n.type === Text && [n.props.children].flat().join('') === body,
  )[0]!;
  expect(node).toBeDefined();
  return { node, style: StyleSheet.flatten(node.props.style) as Style };
}

describe.each(MODES)('the %s appearance', mode => {
  const t = themeTokens(mode);

  it('is the square in solid forest — walls, jambs and floor one colour — with white letters', () => {
    const tree = render(mode);
    const all = pieces(tree);
    // The two walls with their jambs, and the floor under the doorway.
    expect(all).toHaveLength(3);
    expect(all.map(s => s.backgroundColor)).toEqual(Array(3).fill(FOREST));
    expect(letters(tree, 'BC').style.color).toBe(WHITE);
    // The superseded neutral mark, named so a revert reads as what it is.
    expect(all.map(s => s.backgroundColor)).not.toContain(t.color.lineStrong);
    expect(all.map(s => s.backgroundColor)).not.toContain('transparent');
    expect(letters(tree, 'BC').style.color).not.toBe(t.color.inkBody);
  });

  // Each size the app draws (thread header 36, list row 48, the group hero
  // 104): the door's width keeps the Quiet Room's proportion (a 64pt opening
  // in its 176pt top wall), and its depth is an eighth of the mark or so.
  it.each([
    [36, 12, 4],
    [48, 16, 6],
    [104, 38, 12],
  ])(
    'at %ipt the doorway is a real notch, %ipt wide and %ipt deep, and every other point is forest',
    (size, doorWidth, doorDepth) => {
      const all = pieces(render(mode, { size }));
      const covered = coverage(all, size);
      const doorLeft = (size - doorWidth) / 2;
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const inDoor = y < doorDepth && x >= doorLeft && x < doorLeft + doorWidth;
          if (covered[y]![x] === inDoor) {
            throw new Error(
              `${size}pt mark, point (${x}, ${y}): ${inDoor ? 'the doorway is filled' : 'a hole outside the doorway'}`,
            );
          }
        }
      }
      // The defect this replaces: a 1pt notch that read as a rendering nick.
      expect(doorDepth).toBeGreaterThanOrEqual(4);
    },
  );

  it('letters an unnamed room "?" in the same white (the create preview has no id yet)', () => {
    const tree = render(mode, { roomId: '', name: '' });
    expect(letters(tree, '?').style.color).toBe(WHITE);
    expect(pieces(tree).map(s => s.backgroundColor)).toEqual(Array(3).fill(FOREST));
  });
});

describe('the letters are geometry', () => {
  it('never scale with Dynamic Type, and follow the hero size when one is given', () => {
    const row = letters(render('light'), 'BC');
    expect(row.node.props.allowFontScaling).toBe(false);
    expect(row.style.fontSize).toBe(Math.round(SIZE * 0.34));

    const hero = letters(render('light', { size: 104, monogramSize: 20 }), 'BC');
    expect(hero.node.props.allowFontScaling).toBe(false);
    expect(hero.style.fontSize).toBe(20);
  });
});
