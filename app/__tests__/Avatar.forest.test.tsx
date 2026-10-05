/**
 * A PERSON WITH NO PHOTO WEARS THE FOREST (2026-10-05).
 *
 * Every monogram disc is solid forest, #0E6B45, with white letters, in
 * light AND in dark (white on #0E6B45 measures 6.55:1). It supersedes the
 * earlier neutral face, which drew the disc white inside a gray ring with
 * charcoal letters; every assertion on the face below fails against that
 * look.
 *
 * Dark is asserted on purpose rather than assumed: the dark palette lifts
 * `pine` to a text colour and turns `onPine` charcoal, so a disc that simply
 * read the live theme's pine would pass in light and draw the wrong pair in
 * dark.
 *
 * What does NOT change, and is pinned here so the recolour cannot spread:
 *  - a photo stays a photo, in its own hairline ring on the sheet;
 *  - a surface that carries or awaits video keeps the media face
 *    (tone="media"), the same in both appearances;
 *  - the letters are geometry and never scale with Dynamic Type.
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { Image, StyleSheet, Text } from 'react-native';
import { Avatar, MONOGRAM_FACE } from '../src/ui/Avatar';
import { ThemeProvider, themeTokens } from '../src/theme';

const FOREST = '#0E6B45';
const WHITE = '#FFFFFF';
const PEER = '01HQAAAA000000000000000QZX';
const PHOTO = '/9j/4AAQSkZJRgABAQ';
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
  props: Partial<React.ComponentProps<typeof Avatar>> = {},
): ReactTestRenderer.ReactTestRenderer {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <ThemeProvider mode={mode}>
        <Avatar peerId={PEER} displayName="Maya Ruiz" size={48} {...props} />
      </ThemeProvider>,
    );
  });
  mounted.push(tree);
  return tree;
}

/** The face: the one host node drawn at the avatar's size. */
function face(tree: ReactTestRenderer.ReactTestRenderer, size = 48): Style {
  const hits = tree.root.findAll(n => {
    if (typeof n.type !== 'string') return false;
    const s = StyleSheet.flatten(n.props.style) as Style | undefined;
    return s?.width === size && s?.height === size;
  });
  expect(hits).toHaveLength(1);
  return StyleSheet.flatten(hits[0]!.props.style) as Style;
}

/** The letters' Text element and its flattened style. */
function letters(tree: ReactTestRenderer.ReactTestRenderer, body: string) {
  const node = tree.root.findAll(
    n => n.type === Text && [n.props.children].flat().join('') === body,
  )[0]!;
  expect(node).toBeDefined();
  return { node, style: StyleSheet.flatten(node.props.style) as Style };
}

/** WCAG contrast of two opaque #rrggbb colours. */
function contrast(a: string, b: string): number {
  const lum = (hex: string) =>
    [1, 3, 5]
      .map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map(s => (s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4))
      .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i]!, 0);
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe.each(MODES)('the %s appearance', mode => {
  const t = themeTokens(mode);

  it('draws a person with no photo as the solid forest disc with white letters, and no gray ring', () => {
    const tree = render(mode);
    const disc = face(tree);
    expect(disc.backgroundColor).toBe(FOREST);
    // No ring of another colour: an edge, where one is drawn, is the fill.
    expect(disc.borderWidth ? disc.borderColor : FOREST).toBe(FOREST);
    expect(letters(tree, 'MR').style.color).toBe(WHITE);
    // The superseded neutral face, named so a revert reads as what it is.
    expect(disc.backgroundColor).not.toBe(t.color.paperSheet);
    expect(disc.borderColor).not.toBe(t.color.lineStrong);
    expect(letters(tree, 'MR').style.color).not.toBe(t.color.inkBody);
  });

  it('letters a nameless person from the id tail, and the call surfaces’ "?" sentinel, in the same white on forest', () => {
    const nameless = render(mode, { displayName: null });
    expect(face(nameless).backgroundColor).toBe(FOREST);
    expect(letters(nameless, 'ZX').style.color).toBe(WHITE);

    const unnamed = render(mode, { monogramOverride: '?' });
    expect(face(unnamed).backgroundColor).toBe(FOREST);
    expect(letters(unnamed, '?').style.color).toBe(WHITE);
  });

  it('keeps a photo a photo: the image in its hairline ring on the sheet, with no forest behind it', () => {
    const tree = render(mode, { photoB64: PHOTO });
    const images = tree.root.findAllByType(Image);
    expect(images).toHaveLength(1);
    expect(images[0]!.props.source).toEqual({
      uri: `data:image/jpeg;base64,${PHOTO}`,
    });
    expect(StyleSheet.flatten(images[0]!.props.style)).toMatchObject({
      width: 48,
      height: 48,
      borderWidth: 1,
      borderColor: t.color.lineStrong,
      backgroundColor: t.color.paperSheet,
    });
    expect(tree.root.findAllByType(Text)).toHaveLength(0);
  });

  it('falls back to the forest face when the photo cannot be drawn', () => {
    const tree = render(mode, { photoB64: PHOTO });
    ReactTestRenderer.act(() => {
      tree.root.findByType(Image).props.onError();
    });
    expect(tree.root.findAllByType(Image)).toHaveLength(0);
    expect(face(tree).backgroundColor).toBe(FOREST);
    expect(letters(tree, 'MR').style.color).toBe(WHITE);
  });

  it('keeps the media face on a surface that carries or awaits video', () => {
    const tree = render(mode, { tone: 'media', size: 128 });
    const light = themeTokens('light').color;
    expect(face(tree, 128)).toMatchObject({
      backgroundColor: light.mediaWash,
      borderWidth: 1,
      borderColor: light.mediaLine,
    });
    expect(letters(tree, 'MR').style.color).toBe(light.mediaInk);
    expect(t.color.mediaWash).toBe(light.mediaWash);
  });
});

describe('the forest face, measured', () => {
  it('is the brand pine and its white ink, taken from the light palette in both appearances', () => {
    const light = themeTokens('light').color;
    expect(MONOGRAM_FACE).toEqual({ fill: light.pine, ink: light.onPine });
    expect(MONOGRAM_FACE).toEqual({ fill: FOREST, ink: WHITE });
    // Why the live theme's pair cannot carry the dark half of the ruling:
    // in dark, pine is lifted for text and onPine is charcoal.
    const dark = themeTokens('dark').color;
    expect(dark.pine).not.toBe(FOREST);
    expect(dark.onPine).not.toBe(WHITE);
  });

  it('carries its letters at 4.5:1 or better (6.55:1)', () => {
    expect(contrast(MONOGRAM_FACE.ink, MONOGRAM_FACE.fill)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(WHITE, FOREST)).toBeCloseTo(6.55, 2);
  });

  it('keeps its letters geometry: frozen at Dynamic Type, sized to the disc', () => {
    const tree = render('light');
    const { node, style } = letters(tree, 'MR');
    expect(node.props.allowFontScaling).toBe(false);
    expect(style.fontSize).toBe(Math.round(48 * 0.34));

    const small = render('light', { size: 32, monogramSize: 11 });
    const smallLetters = letters(small, 'MR');
    expect(smallLetters.node.props.allowFontScaling).toBe(false);
    expect(smallLetters.style.fontSize).toBe(11);
    expect(face(small, 32).backgroundColor).toBe(FOREST);
  });
});
