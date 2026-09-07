/**
 * The palette's 4.5:1 promise, measured.
 *
 * theme.ts says "every text pairing holds 4.5:1 on the surfaces it appears on"
 * and app-spec §1 repeats it. Until this file, nothing in the repository
 * computed a contrast ratio — the type system guarantees every token HAS a
 * dark value, and nothing guaranteed any of them was readable. This walks both
 * palettes and does the arithmetic (sRGB relative luminance, WCAG 2.x).
 *
 * WHAT IS ASSERTED, AND WHY THAT AND NOT MORE. A rule that swept up every
 * token pair would be red the day it landed, and the first agent to meet it
 * would weaken it — which is worse than not having it. So the sets are named,
 * the exclusions are named WITH their reason, and a token that is neither is a
 * test failure: adding a colour to this design system means saying which kind
 * of colour it is.
 *
 * Measured margins at the time of writing, so the next palette edit knows
 * where the floor is:
 * light tightest text pine on paperInset 4.81:1
 * dark tightest text danger on paperSheet 4.87:1
 * light tightest mark warningMark on paperInset 3.32:1
 * dark tightest mark warningMark on paperSheet 4.45:1
 *
 * The last describe is not about colour: it pins ScreenHeader's headerCenter
 * flex, which is the layout contract a third trailing control in the thread
 * header depends on. It lives here because this file is where this release
 * puts the design-system rules that are otherwise only claims in a comment.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';
import ReactTestRenderer from 'react-test-renderer';
import { themeTokens, type Theme } from '../src/theme';
import { ScreenHeader } from '../src/ui/primitives';

// ---------------------------------------------------------------- the maths

/** One sRGB channel, linearised. */
function channel(byte: number): number {
  const s = byte / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/**
 * WCAG relative luminance of an opaque #rrggbb.
 *
 * Sliced rather than shifted: the app's lint config warns on bitwise
 * operators, and this file is not worth a new warning.
 */
function luminance(hex: string): number {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) {
    throw new Error(`not an opaque hex colour: ${hex}`);
  }
  return (
    0.2126 * channel(parseInt(hex.slice(1, 3), 16)) +
    0.7152 * channel(parseInt(hex.slice(3, 5), 16)) +
    0.0722 * channel(parseInt(hex.slice(5, 7), 16))
  );
}

/** WCAG contrast ratio, 1:1 to 21:1. Order does not matter. */
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [
    number,
    number,
  ];
  return (hi + 0.05) / (lo + 0.05);
}

/** The predicate the assertions below run on, so the falsifier tests it too. */
function holds(a: string, b: string, floor: number): boolean {
  return contrast(a, b) >= floor;
}

// ------------------------------------------------------------- the token sets

type ColorName = keyof Theme['color'];

/** Text and glyphs. Every one of these must reach 4.5:1 on every surface. */
const INKS: ColorName[] = [
  'inkStrong',
  'inkBody',
  'inkMuted',
  'pine',
  'pinePressed',
  'danger',
  'warningInk',
];

/** The four grounds anything can be drawn on. */
const SURFACES: ColorName[] = [
  'paperGround',
  'paperLayer',
  'paperInset',
  'paperSheet',
];

/** Inks that live on one fill only, asserted against that fill and no other. */
const FIXED: [ColorName, ColorName][] = [
  ['onPine', 'pine'],
  ['onPine', 'danger'],
  ['onBubbleOut', 'bubbleOut'],
  ['mediaInk', 'mediaBlack'],
  ['mediaInkMuted', 'mediaBlack'],
  ['dangerOnMedia', 'mediaBlack'],
];

/**
 * Non-text marks: 3:1, the WCAG floor for a graphical object. warningMark is
 * deliberately NOT in INKS — in light it measures 4.00 / 3.67 / 3.32 / 4.38
 * against the four surfaces and would fail the text rule everywhere. It is a
 * status marker with warningInk as its text partner (theme.ts says so), and a
 * mark is never the only channel carrying information in this product.
 */
const MARKS: ColorName[] = ['warningMark'];

/**
 * Excluded, each with the reason, because an exclusion nobody can audit is a
 * hole. Every name here is either an rgba() token that composites over a
 * ground it does not know about, or a pressed state rather than a state.
 *
 * lineSoft, lineStrong, pineLine, mediaLine, bubbleOutLine,
 * bubbleOutLinePressed — hairlines. lineSoft at 0.14 alpha over paperSheet
 * composites to roughly 1.2:1, and it is a rule, not
 * a word. Nothing in this product is legible only
 * because a hairline was there.
 * pineWash, pineWashFaint, dangerWash — pressed and attention FILLS, drawn
 * under text that is itself asserted above.
 * pinePressed as a SURFACE, bubbleOutPressed — the moment a finger is down.
 * pinePressed is asserted as an INK above.
 * mediaHud — translucent video backing, measured over white below.
 *
 * The paper* tokens are also not compared with each other: adjacent surfaces
 * are separated by a hairline and by content, never by contrast alone.
 */
const EXCLUDED: ColorName[] = [
  'lineSoft',
  'lineStrong',
  'pineLine',
  'pineWash',
  'pineWashFaint',
  'dangerWash',
  'mediaLine',
  'mediaHud',
  'bubbleOutLine',
  'bubbleOutLinePressed',
  'bubbleOutPressed',
];

const MODES = ['light', 'dark'] as const;

describe.each(MODES)('the %s palette', mode => {
  const t = themeTokens(mode);

  test('every ink reaches 4.5:1 on every surface', () => {
    const failures: string[] = [];
    for (const ink of INKS) {
      for (const surface of SURFACES) {
        if (!holds(t.color[ink], t.color[surface], 4.5)) {
          failures.push(
            `${ink} on ${surface} = ${contrast(
              t.color[ink],
              t.color[surface],
            ).toFixed(2)}:1`,
          );
        }
      }
    }
    expect(failures).toEqual([]);
  });

  test('every ink with one home reaches 4.5:1 there', () => {
    const failures: string[] = [];
    for (const [ink, fill] of FIXED) {
      if (!holds(t.color[ink], t.color[fill], 4.5)) {
        failures.push(
          `${ink} on ${fill} = ${contrast(
            t.color[ink],
            t.color[fill],
          ).toFixed(2)}:1`,
        );
      }
    }
    expect(failures).toEqual([]);
  });

  test('call text stays readable over an entirely white video frame', () => {
    const rgba = /^rgba\((\d+),(\d+),(\d+),([\d.]+)\)$/.exec(t.color.mediaHud);
    expect(rgba).not.toBeNull();
    const alpha = Number(rgba![4]);
    const composited = `#${rgba!.slice(1, 4).map(byte =>
      Math.round(Number(byte) * alpha + 255 * (1 - alpha))
        .toString(16).padStart(2, '0'),
    ).join('')}`;
    expect(contrast(t.color.mediaInk, composited)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(t.color.mediaInkMuted, composited)).toBeGreaterThanOrEqual(4.5);
  });

  test('every non-text mark reaches 3:1 on every surface', () => {
    const failures: string[] = [];
    for (const mark of MARKS) {
      for (const surface of SURFACES) {
        if (!holds(t.color[mark], t.color[surface], 3)) {
          failures.push(
            `${mark} on ${surface} = ${contrast(
              t.color[mark],
              t.color[surface],
            ).toFixed(2)}:1`,
          );
        }
      }
    }
    expect(failures).toEqual([]);
  });

  test('every token in the palette is classified by this file', () => {
    // The part that keeps this honest as the palette grows: a new colour is
    // an ink, a surface, a fixed pair, a mark, or an excluded one WITH a
    // reason written above. There is no fifth option, and no silent one.
    const classified = new Set<string>([
      ...INKS,
      ...SURFACES,
      ...MARKS,
      ...EXCLUDED,
      ...FIXED.flat(),
    ]);
    const unclassified = Object.keys(t.color).filter(
      name => !classified.has(name),
    );
    expect(unclassified).toEqual([]);
  });
});

describe('the predicate itself', () => {
  test('rejects a pair that does not hold', () => {
    // The permanent falsifier (CONTRIBUTING: a test that cannot fail is worse
    // than no test). Mid grey on mid grey measures 1.13:1 — if this ever
    // passes, every assertion above is decoration.
    expect(holds('#777777', '#808080', 4.5)).toBe(false);
    expect(holds('#777777', '#808080', 3)).toBe(false);
    expect(contrast('#777777', '#808080')).toBeCloseTo(1.13, 2);
  });

  test('agrees with the known anchors', () => {
    expect(contrast('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
    expect(contrast('#FFFFFF', '#FFFFFF')).toBeCloseTo(1, 5);
    // theme.ts's own claim about the QR ink, now measured rather than quoted.
    const t = themeTokens('light');
    expect(contrast(t.color.inkStrong, t.color.paperSheet)).toBeGreaterThan(17);
  });

  test('refuses a token it cannot measure rather than passing it', () => {
    // The rgba() tokens are excluded by name above; if one ever reached the
    // predicate, this is what happens — a throw, not a green.
    expect(() => contrast('rgba(18,26,21,0.14)', '#FAFCF7')).toThrow();
  });
});

describe('ScreenHeader yields the middle, not the sides', () => {
  test('headerCenter carries flex 1', () => {
    let tree!: ReactTestRenderer.ReactTestRenderer;
    ReactTestRenderer.act(() => {
      tree = ReactTestRenderer.create(
        React.createElement(ScreenHeader, {
          title: 'A conversation with a very long name indeed',
          onBack: () => {},
          // Three trailing targets is the shape the thread header takes on
          // this release; the assertion is about what the CENTRE does.
          right: React.createElement(View, { testID: 'trailing-group' }),
        }),
      );
    });

    // The contract a trailing group depends on: the title's box absorbs the
    // squeeze, so adding a third control to the right of a header compresses
    // the TITLE (which already wraps to two lines at a 1.8x cap) instead of
    // pushing the controls off the screen. Removing this flex is a silent
    // layout regression on every pushed surface at once.
    const centres = tree.root
      .findAll(n => typeof n.type === 'string')
      .map(n => StyleSheet.flatten(n.props.style) as Record<string, unknown>)
      .filter(
        s =>
          s !== undefined &&
          s.flex === 1 &&
          s.alignItems === 'center' &&
          s.justifyContent === 'center',
      );
    expect(centres.length).toBe(1);

    ReactTestRenderer.act(() => {
      tree.unmount();
    });
  });
});
