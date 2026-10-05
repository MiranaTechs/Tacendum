/**
 * The palette's 4.5:1 promise, measured.
 *
 * theme.ts says "every resting text pairing holds 4.5:1" and app-spec §1
 * repeats it. Until this file, nothing in the repository computed a contrast
 * ratio — the type system guarantees every token HAS a dark value, and
 * nothing guaranteed any of them was readable. This walks both palettes and
 * does the arithmetic (sRGB relative luminance, WCAG 2.x).
 *
 * WHAT IS ASSERTED, AND WHY THAT AND NOT MORE. A rule that swept up every
 * token pair would be red the day it landed, and the first agent to meet it
 * would weaken it — which is worse than not having it. So the sets are named,
 * the exclusions are named WITH their reason, and a token that is neither is a
 * test failure: adding a colour to this design system means saying which kind
 * of colour it is.
 *
 * Measured margins at the time of writing (palette v2, 2026-10-04), so the
 * next palette edit knows where the floor is:
 *   both   onBubbleOutTick on bubbleOut              3.23:1  (a mark, floor 3)
 *   both   onBubbleOutMuted on bubbleOut             4.77:1
 *   light  tickMuted on paperGround                  3.36:1  (a mark; dark 3.46:1)
 *   dark   danger / pine / inkMuted on the highlight over paperSheet
 *                                                    4.75-4.76:1
 *   dark   danger / pine / inkMuted on paperInset    4.82-4.83:1
 *   light  tightest text  inkMuted on paperInset     4.95:1
 *   light  tightest mark  warningMark on paperInset  3.55:1
 *   light  pine on paperInset                        5.15:1
 *   both   lineField boundary                        3.87-4.06:1  (floor 3)
 *   light  QR anchor  inkStrong on paperSheet        17.76:1  (asserted > 17)
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

/**
 * An rgba() token laid over an opaque ground, the way the screen draws it:
 * each channel is alpha x token + (1 - alpha) x ground, rounded to a byte.
 * Only the no-space form theme.ts writes is accepted, so a token in any
 * other shape throws here instead of passing unmeasured.
 */
function composite(rgba: string, ground: string): string {
  const m = /^rgba\((\d+),(\d+),(\d+),([\d.]+)\)$/.exec(rgba);
  if (!m) {
    throw new Error(`not a no-space rgba() colour: ${rgba}`);
  }
  if (!/^#[0-9a-f]{6}$/i.test(ground)) {
    throw new Error(`not an opaque hex ground: ${ground}`);
  }
  const alpha = Number(m[4]);
  const under = [1, 3, 5].map(i => parseInt(ground.slice(i, i + 2), 16));
  const bytes = [m[1], m[2], m[3]].map((byte, i) =>
    Math.round(Number(byte) * alpha + under[i] * (1 - alpha)),
  );
  return `#${bytes
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('')}`.toUpperCase();
}

/**
 * True when a colour has no hue: R = G = B, for an opaque #rrggbb or an
 * rgba() (a gray laid over a gray stays gray). Anything this cannot parse is
 * not neutral, so a colour in a new shape fails loudly rather than slipping
 * through.
 */
function isNeutral(value: string): boolean {
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value);
  const rgba =
    /^rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*[\d.]+\s*\)$/.exec(value);
  let rgb: number[] | null = null;
  if (hex) rgb = hex.slice(1, 4).map(part => parseInt(part, 16));
  else if (rgba) rgb = rgba.slice(1, 4).map(part => parseInt(part, 10));
  return rgb !== null && rgb[0] === rgb[1] && rgb[1] === rgb[2];
}

/**
 * True when a colour is forest drawn at less than full strength: an rgba()
 * of 14,107,69 with alpha under 1, or the 8-digit hex form of the same.
 */
function isForestTint(value: string): boolean {
  const rgba =
    /^rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)$/.exec(value);
  if (rgba) {
    const [r, g, b] = rgba.slice(1, 4).map(part => parseInt(part, 10));
    return r === 14 && g === 107 && b === 69 && Number(rgba[4]) < 1;
  }
  const hex8 = /^#0e6b45([0-9a-f]{2})$/i.exec(value);
  return hex8 !== null && hex8[1].toLowerCase() !== 'ff';
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
  ['onPine', 'pinePressed'],
  ['onBubbleOut', 'bubbleOutPressed'],
  ['onBubbleOutMuted', 'bubbleOut'],
  ['onBubbleOutMuted', 'bubbleOutPressed'],
  ['mediaInk', 'mediaAccent'],
  ['mediaInk', 'mediaDanger'],
];

/**
 * Marks that live on one fill only, at the 3:1 graphical-object floor: the
 * sent and delivered tick inside an outgoing bubble, and the delivered tick
 * off the bubble (jumbo emoji, photo rows), where read is forest and the two
 * must differ by luminance, not hue.
 */
const FIXED_MARKS: [ColorName, ColorName][] = [
  ['onBubbleOutTick', 'bubbleOut'],
  ['tickMuted', 'paperGround'],
];

/**
 * Non-text marks: 3:1, the WCAG floor for a graphical object. warningMark is
 * deliberately NOT in INKS — in light it measures 4.52 on the three white
 * surfaces and 3.55 on paperInset, under the text rule there and barely over
 * it elsewhere. It is a status marker with warningInk as its text partner
 * (theme.ts says so), and a mark is never the only channel carrying
 * information in this product.
 */
const MARKS: ColorName[] = ['warningMark'];

/**
 * Excluded, each with the reason, because an exclusion nobody can audit is a
 * hole. Every name here is either an rgba() token that composites over a
 * ground it does not know about, or a pressed state rather than a state.
 *
 *   lineSoft, lineStrong, pineLine, mediaLine, bubbleOutLine,
 *   bubbleOutLinePressed  — hairlines. lineSoft at 0.16 alpha over white
 *                           composites to 1.40:1, and it is a rule, not a
 *                           word. Nothing in this product is legible only
 *                           because a hairline was there.
 *   lineField             — an rgba() boundary, asserted as a boundary in
 *                           FIELD below.
 *   pineWash, pineWashFaint, dangerWash — the one neutral highlight,
 *                           asserted under text in WASHED below.
 *   pinePressed as a SURFACE, bubbleOutPressed as a surface — the moment a
 *                           finger is down. pinePressed is asserted as an
 *                           INK above, and both carry their labels in FIXED.
 *   mediaHud              — translucent video backing, measured over white
 *                           below.
 *   mediaWash             — a translucent fill over the fixed media black;
 *                           its ink, mediaInk, is asserted on mediaBlack.
 *
 * The paper* tokens are compared with each other once, in LADDER below
 * (pressed, off and disabled must exist). Otherwise adjacent surfaces are
 * separated by a hairline and by content, never by contrast alone, and a
 * floor on any other gray step would fail the white.
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
  'lineField',
  'mediaWash',
];

/** The one neutral highlight, under its three historical names. */
const WASHES: ColorName[] = ['pineWash', 'pineWashFaint', 'dangerWash'];

/**
 * What a highlight lies on at rest. paperInset, the pressed fill, is a
 * transient ground under a highlight and is not asserted.
 */
const WASH_GROUNDS: ColorName[] = ['paperGround', 'paperLayer', 'paperSheet'];

/** The inks drawn on a highlight: a pressed row, the selected row, @you. */
const WASHED_INKS: ColorName[] = [
  'inkStrong',
  'inkBody',
  'inkMuted',
  'pine',
  'danger',
  'warningInk',
];

/** Every colour that must have no hue, in both modes. */
const NEUTRALS: ColorName[] = [
  'paperGround',
  'paperLayer',
  'paperInset',
  'paperSheet',
  'inkStrong',
  'inkBody',
  'inkMuted',
  'lineSoft',
  'lineStrong',
  'lineField',
  'pineWash',
  'pineWashFaint',
  'dangerWash',
  'tickMuted',
  'onBubbleOutMuted',
  'onBubbleOutTick',
  'mediaBlack',
  'mediaInk',
  'mediaInkMuted',
  'mediaLine',
  'mediaHud',
  'mediaWash',
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

  describe('every mark with one home reaches 3:1 there', () => {
    test.each(FIXED_MARKS)('%s on %s', (mark, fill) => {
      expect(contrast(t.color[mark], t.color[fill])).toBeGreaterThanOrEqual(3);
    });
  });

  test('call text stays readable over an entirely white video frame', () => {
    // composite() accepts only the no-space rgba() form, so a reshaped
    // mediaHud throws here instead of passing unmeasured.
    const hud = composite(t.color.mediaHud, '#FFFFFF');
    expect(contrast(t.color.mediaInk, hud)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(t.color.mediaInkMuted, hud)).toBeGreaterThanOrEqual(4.5);
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

  describe('WASHED: text on the neutral highlight', () => {
    test('every washed ink reaches 4.5:1 on each wash, over each resting ground', () => {
      const failures: string[] = [];
      for (const wash of WASHES) {
        for (const ground of WASH_GROUNDS) {
          const under = composite(t.color[wash], t.color[ground]);
          for (const ink of WASHED_INKS) {
            if (!holds(t.color[ink], under, 4.5)) {
              failures.push(
                `${ink} on ${wash} over ${ground} (${under}) = ${contrast(
                  t.color[ink],
                  under,
                ).toFixed(2)}:1`,
              );
            }
          }
        }
      }
      expect(failures).toEqual([]);
    });
  });

  describe('FIELD: a white field on a white page has only its border', () => {
    test.each(['paperGround', 'paperSheet'] as ColorName[])(
      'lineField over %s reaches 3:1 against it',
      ground => {
        const edge = composite(t.color.lineField, t.color[ground]);
        expect(contrast(edge, t.color[ground])).toBeGreaterThanOrEqual(3);
      },
    );
  });

  describe('LADDER: pressed, off and disabled must exist', () => {
    test('paperInset stands at least 1.20:1 off paperGround', () => {
      expect(
        contrast(t.color.paperInset, t.color.paperGround),
      ).toBeGreaterThanOrEqual(1.2);
    });
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
      ...FIXED_MARKS.flat(),
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
    expect(() => contrast('rgba(24,24,24,0.16)', '#FFFFFF')).toThrow();
  });

  test('composites by the arithmetic, and refuses a shape it cannot read', () => {
    // Half black over white is the byte halfway down: 127.5 rounds to 0x80.
    expect(composite('rgba(0,0,0,0.5)', '#FFFFFF')).toBe('#808080');
    expect(composite('rgba(24,24,24,0.05)', '#FFFFFF')).toBe('#F3F3F3');
    expect(() => composite('rgba(0, 0, 0, 0.5)', '#FFFFFF')).toThrow();
    expect(() => composite('#000000', '#FFFFFF')).toThrow();
  });
});

describe("the palette rule (2026-10-04): white, charcoal, forest", () => {
  const light = themeTokens('light');

  test('every light surface is exactly white', () => {
    expect([
      light.color.paperGround,
      light.color.paperLayer,
      light.color.paperSheet,
    ]).toEqual(['#FFFFFF', '#FFFFFF', '#FFFFFF']);
  });

  test.each(MODES)(
    '%s: every neutral and every wash is R = G = B (no green cast, no hue on a press)',
    mode => {
      const palette = themeTokens(mode).color;
      const hued = NEUTRALS.filter(name => !isNeutral(palette[name])).map(
        name => `${name} ${palette[name]}`,
      );
      expect(hued).toEqual([]);
    },
  );

  test('light: no token is a translucent tint of forest (full strength only)', () => {
    const tints = (Object.keys(light.color) as ColorName[])
      .filter(name => isForestTint(light.color[name]))
      .map(name => `${name} ${light.color[name]}`);
    expect(tints).toEqual([]);
  });

  test.each(MODES)('%s: the three washes are one highlight', mode => {
    const palette = themeTokens(mode).color;
    expect(palette.pineWashFaint).toBe(palette.pineWash);
    expect(palette.dangerWash).toBe(palette.pineWash);
  });

  test('the neutral predicate can fail', () => {
    expect(isNeutral('#EFF2EB')).toBe(false); // vocab-allow: falsifier
    expect(isNeutral('#E4E4E4')).toBe(true);
    expect(isNeutral('rgba(24,24,24,0.05)')).toBe(true);
    expect(isNeutral('not a colour')).toBe(false);
  });

  test('the forest-tint predicate can fail', () => {
    expect(isForestTint('rgba(14,107,69,0.5)')).toBe(true);
    expect(isForestTint('#0E6B4580')).toBe(true);
    expect(isForestTint('#0E6B45')).toBe(false);
    expect(isForestTint('rgba(14,107,69,1)')).toBe(false);
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
