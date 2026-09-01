import React, { createContext, useContext } from 'react';
import { Platform, StyleSheet, type TextStyle } from 'react-native';

/**
 * Tacendum design tokens (the security-paper direction).
 *
 * The app is one cool porcelain ground with a faint green cast — the field of
 * a banknote or a passport page — printed in one deep pine ink. Depth is
 * expressed with surface color, outlines, and shared seams — there are no
 * shadows, gradients, blurs, or translucent scrims anywhere in the product,
 * and the only dark surface is the full-screen photo viewer.
 */

/** Monospace utility face: brand marks, ids, times, state, safety numbers. */
export const mono = Platform.select({
  ios: 'Menlo',
  default: 'monospace',
}) as string;

/** One physical pixel. */
export const hairline = StyleSheet.hairlineWidth;

const color = {
  /** Every screen background. */
  paperGround: '#EFF2EB',
  /** Attached panels, drawers, safety surfaces. */
  paperLayer: '#E4E9E0',
  /** Pressed, disabled, recessed. */
  paperInset: '#D8DFD3',
  /** Raised: inputs, incoming bubbles, composer, rows. */
  paperSheet: '#FAFCF7',

  /** Titles, names, primary values. */
  inkStrong: '#121A15',
  /** Body and message text. */
  inkBody: '#313B34',
  /** Secondary text (dark enough to hold 4.5:1 on inset). */
  inkMuted: '#525D55',

  /** Primary action, links, outgoing bubbles. */
  pine: '#0E6B45',
  pinePressed: '#0A5738',
  pineWash: 'rgba(14,107,69,0.10)',
  pineWashFaint: 'rgba(14,107,69,0.05)',
  pineLine: 'rgba(14,107,69,0.32)',

  lineSoft: 'rgba(18,26,21,0.14)',
  lineStrong: 'rgba(18,26,21,0.28)',

  danger: '#A82E24',
  dangerWash: 'rgba(168,46,36,0.08)',
  /**
   * Pending and attention states (connecting, unchecked safety number) in the
   * slate of a security thread — attention without alarm, and never brown.
   * Mark is a non-text status marker only; ink is its text partner.
   */
  warningMark: '#5A7A94',
  warningInk: '#41586B',

  /** Text and glyphs on a pine fill. */
  onPine: '#FAFCF7',

  /**
   * Message bubbles, as their own axis: in light your voice is a pine slab
   * with pale words; in dark the slab goes quiet and the WORDS carry the
   * green (the site's relay view), so the two modes may not share pine's
   * mapping. Everything inside an outgoing bubble inks with onBubbleOut.
   */
  bubbleOut: '#0E6B45',
  bubbleOutPressed: '#0A5738',
  onBubbleOut: '#FAFCF7',
  bubbleOutLine: '#0E6B45',
  bubbleOutLinePressed: '#0A5738',

  /** Photo viewer only. This is not a dark mode. */
  mediaBlack: '#060807',
  // Photo-viewer surface only. Derived neutrals of the existing family; this
  // is not a dark mode.
  mediaInk: '#FAFCF7',
  mediaInkMuted: '#95A098',
  mediaLine: 'rgba(250,252,247,0.18)',
  dangerOnMedia: '#E2726A',
} as const;

/**
 * Security paper at night — the dark option, drawn from the site's server
 * view: a near-black ground with the same green cast, phosphor green where
 * light mode uses pine, porcelain inks inverted to pale. Depth logic is
 * unchanged (raised is lighter, recessed is darker); every text pairing
 * holds 4.5:1 on the surfaces it appears on.
 */
/** Both palettes carry exactly the same token names. */
type ColorTokens = Record<keyof typeof color, string>;

const darkColor: ColorTokens = {
  paperGround: '#0C0F0D',
  paperLayer: '#151A17',
  paperInset: '#090B0A',
  paperSheet: '#1C221E',

  inkStrong: '#E9EFE9',
  inkBody: '#C6D0C7',
  inkMuted: '#8A968C',

  pine: '#35C57F',
  pinePressed: '#2AA96A',
  pineWash: 'rgba(53,197,127,0.15)',
  pineWashFaint: 'rgba(53,197,127,0.08)',
  pineLine: 'rgba(53,197,127,0.42)',

  lineSoft: 'rgba(233,239,233,0.13)',
  lineStrong: 'rgba(233,239,233,0.28)',

  danger: '#E0685E',
  dangerWash: 'rgba(224,104,94,0.14)',
  warningMark: '#6E89A3',
  warningInk: '#93ACC2',

  /** Dark glyphs on a phosphor fill — the fill is the bright thing now. */
  onPine: '#0A130D',

  /** The relay view: a sent message is a dark slab whose WORDS are phosphor —
   * never a highlighted bubble. A faint green-tinted fill and hairline keep
   * direction readable beside the neutral incoming sheet. */
  bubbleOut: '#1D2921',
  bubbleOutPressed: '#28362C',
  onBubbleOut: '#35C57F',
  bubbleOutLine: 'rgba(53,197,127,0.30)',
  bubbleOutLinePressed: 'rgba(53,197,127,0.48)',
  /** The photo viewer is already the app's one dark surface; unchanged. */
  mediaBlack: '#060807',
  mediaInk: '#FAFCF7',
  mediaInkMuted: '#95A098',
  mediaLine: 'rgba(250,252,247,0.18)',
  dangerOnMedia: '#E2726A',
};

/**
 * Type roles. "System" roles leave fontFamily unset so iOS uses SF and
 * Dynamic Type scaling keeps working; Menlo roles carry utility identity.
 */
const type = {
  brandHero: {
    fontFamily: mono,
    fontSize: 30,
    fontWeight: '700',
    lineHeight: 36,
    letterSpacing: 2.4,
  },
  brandCompact: {
    fontFamily: mono,
    fontSize: 15,
    fontWeight: '700',
    lineHeight: 20,
    letterSpacing: 1.8,
  },
  // Sized against WhatsApp iOS at default Dynamic Type: one
  // step down from the original scale everywhere prose lives. Mono utility
  // roles keep their sizes — 11 is already the legibility floor.
  display: {
    fontSize: 28,
    fontWeight: '700',
    lineHeight: 34,
    letterSpacing: -0.5,
  },
  screenTitle: {
    fontSize: 20,
    fontWeight: '700',
    lineHeight: 25,
    letterSpacing: -0.3,
  },
  sectionTitle: {
    fontSize: 17,
    fontWeight: '700',
    lineHeight: 22,
    letterSpacing: -0.2,
  },
  rowTitle: { fontSize: 16, fontWeight: '600', lineHeight: 21 },
  body: { fontSize: 15, fontWeight: '400', lineHeight: 21 },
  bodyStrong: { fontSize: 15, fontWeight: '600', lineHeight: 21 },
  message: { fontSize: 15, fontWeight: '400', lineHeight: 20 },
  compactBody: { fontSize: 13, fontWeight: '400', lineHeight: 18 },
  compactStrong: { fontSize: 13, fontWeight: '600', lineHeight: 18 },
  button: { fontSize: 15, fontWeight: '600', lineHeight: 20 },
  buttonCompact: { fontSize: 13, fontWeight: '600', lineHeight: 17 },
  input: { fontSize: 16, fontWeight: '400', lineHeight: 21 },
  utilityLabel: {
    fontFamily: mono,
    fontSize: 11,
    fontWeight: '700',
    lineHeight: 15,
  },
  utilityData: {
    fontFamily: mono,
    fontSize: 12,
    fontWeight: '400',
    lineHeight: 17,
  },
  timeStatus: {
    fontFamily: mono,
    fontSize: 11,
    fontWeight: '400',
    lineHeight: 15,
  },
  safetyNumber: {
    fontFamily: mono,
    fontSize: 14,
    fontWeight: '400',
    lineHeight: 22,
    fontVariant: ['tabular-nums'],
  },
  verificationCode: {
    fontFamily: mono,
    fontSize: 22,
    fontWeight: '700',
    lineHeight: 30,
    fontVariant: ['tabular-nums'],
  },
  emojiChoice: { fontSize: 22, fontWeight: '400', lineHeight: 28 },
  iconGlyph: {
    fontFamily: mono,
    fontSize: 20,
    fontWeight: '400',
    lineHeight: 22,
  },
  counter: {
    fontFamily: mono,
    fontSize: 11,
    fontWeight: '400',
    lineHeight: 15,
  },
} satisfies Record<string, TextStyle>;

const space = {
  s0: 0,
  s1: 2,
  s2: 4,
  s3: 6,
  s4: 8,
  s5: 12,
  s6: 16,
  s7: 20,
  s8: 24,
  s9: 32,
  s10: 40,
  s11: 48,
  s12: 64,
  s13: 80,
} as const;

const radius = {
  /** Quiet Room outline. */
  room: 2,
  /** Message tails, small status marks. */
  tail: 6,
  /** Reaction annotations. */
  small: 10,
  /** Buttons and fields. */
  button: 12,
  /** Attached composer/profile drawers. */
  drawer: 14,
  bubble: 18,
  composer: 22,
  circle: 999,
} as const;

const layout = {
  /** Authenticated screens. */
  gutter: 16,
  /** Landing and registration. */
  gutterWide: 24,
  gutterNarrow: 20,
  /** Width below which the narrow gutter applies. */
  narrowWidth: 340,
  headerHeight: 56,
  touchTarget: 44,
  buttonHeight: 52,
  rowHeight: 56,
  chatRowHeight: 72,
  /** Registration and profile reading width. */
  contentMax: 520,

  /**
   * The size-class axis. The Material window-class cuts in
   * dp — RN dp aligns 1:1 — width-driven, never idiom-driven: compact below
   * mediumMin, medium up to expandedMin, expanded from there. Classification
   * itself lives in windowClass.ts (the provider beside this token set),
   * never at a call site. The pane bounds are the wide shell's list-pane
   * range; nothing on the compact path reads them.
   */
  windowClass: {
    mediumMin: 600,
    expandedMin: 840,
    listPaneMin: 320,
    listPaneMax: 360,
  } as const,

  // Proportions that were hard-coded at their call sites. Transcribed
  // unchanged so the thread, chat list, and viewer can share one source.
  /** Bubble ceiling in points, and as a fraction of the viewport. */
  bubbleMaxWidth: 292,
  bubbleMaxRatio: 0.78,
  /** Keeps a one- or two-character message centred instead of lopsided. */
  bubbleMinWidth: 44,
  photoMaxWidth: 248,
  photoRatio: 0.66,
  photoMinHeight: 112,
  photoMaxHeight: 320,
  railWidth: 284,
  railHeight: 52,
  drawerHeight: 64,
  emojiDrawerHeight: 60,
  /**
   * Where a chat-list separator begins: 16 gutter + 48 avatar + 12 rowBody
   * margin. The previous 80 aligned to nothing in the row it separated.
   */
  separatorInset: 76,
  sendDisc: 36,
  /** The four avatar sizes the product actually uses. */
  avatar: { room: 32, header: 36, row: 48, hero: 104 } as const,
} as const;

/**
 * Cubic-bezier easing, implemented here rather than via `Easing.bezier`.
 *
 * React Native's version lazily `require`s a submodule the first time it is
 * called. Called from module scope, that require can land after a Jest
 * environment has been torn down, which crashes the run even when every suite
 * passed. A closed-form curve has no such edge and no import cost.
 *
 * x is solved by bisection: monotonic for the control points we use, and 24
 * iterations put the error below a pixel at any duration we animate.
 */
function cubicBezier(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): (t: number) => number {
  const curve = (a: number, b: number, t: number) => {
    const u = 1 - t;
    return 3 * u * u * t * a + 3 * u * t * t * b + t * t * t;
  };
  return (t: number) => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    let low = 0;
    let high = 1;
    let mid = t;
    for (let i = 0; i < 24; i++) {
      mid = (low + high) / 2;
      if (curve(x1, x2, mid) < t) low = mid;
      else high = mid;
    }
    return curve(y1, y2, mid);
  };
}

const motion = {
  none: 0,
  press: 100,
  micro: 140,
  surface: 180,
  route: 240,
  attention: 320,
  /** Long-press before the reaction rail opens. */
  longPress: 320,
  easing: cubicBezier(0.22, 0.61, 0.2, 1),
  easingPress: cubicBezier(0.2, 0, 0, 1),
} as const;

const tokens = {
  color: color as ColorTokens,
  type,
  space,
  radius,
  layout,
  motion,
  hairline,
  mono,
  /** Which palette this is — for the few places (status bars) that must
   * name a platform appearance rather than a token. */
  scheme: 'light' as 'light' | 'dark',
};

/** The dark tokens differ from light in exactly two axes: color and name. */
const darkTokens = { ...tokens, color: darkColor, scheme: 'dark' as const };

/**
 * Light is the DEFAULT context value, not just a fallback: a component
 * rendered without a provider (a test, a stray portal) gets the palette the
 * app has always had, and no call site needed to change for dark to exist.
 */
const ThemeContext = createContext(tokens);

export function ThemeProvider({
  mode,
  children,
}: {
  mode: 'light' | 'dark';
  children: React.ReactNode;
}) {
  return React.createElement(
    ThemeContext.Provider,
    { value: mode === 'dark' ? darkTokens : tokens },
    children,
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}

/**
 * The resolved token set for a mode, for code that runs outside render —
 * tests and tooling. Components read the live palette with useTheme().
 */
export function themeTokens(mode: 'light' | 'dark' = 'light'): Theme {
  return mode === 'dark' ? darkTokens : tokens;
}

export type Theme = typeof tokens;
export type TypeRole = keyof typeof type;
