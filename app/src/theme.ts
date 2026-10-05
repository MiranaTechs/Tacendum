import React, { createContext, useContext } from 'react';
import { Platform, StyleSheet, type TextStyle } from 'react-native';

/**
 * Tacendum design tokens (palette v2: forest / white / charcoal).
 *
 * Every surface is pure white; one forest, #0E6B45, is the brand and the
 * action colour and appears only at full strength; charcoal and gray, never
 * green-cast, carry text, lines and secondary icons. Depth on white is the
 * hairline, never a fill: white surfaces are separated by lineSoft /
 * lineStrong seams; paperInset is the one gray fill, for pressed, off and
 * disabled. The token names are historical: paper* means surface, pine*
 * means forest, and pineWash, pineWashFaint and dangerWash are the one
 * neutral highlight.
 */

/** Monospace utility face: brand marks, ids, times, state, safety numbers. */
export const mono = Platform.select({
  ios: 'Menlo',
  default: 'monospace',
}) as string;

/** One physical pixel. */
export const hairline = StyleSheet.hairlineWidth;

const color = {
  /** Every screen; bars sit on it with a seam. */
  paperGround: '#FFFFFF',
  /** Attached panels, trays, sheets, notices (edged by a hairline or rule). */
  paperLayer: '#FFFFFF',
  /** The one gray fill: pressed, disabled, switch-off, tracks. */
  paperInset: '#E4E4E4',
  /** Fields, composer pill, chips, cards, keys, incoming bubbles, QR zone. */
  paperSheet: '#FFFFFF',

  /** Titles, names, message text, QR modules, primary glyphs. */
  inkStrong: '#181818',
  /** Body text and author labels (monograms are MONOGRAM_FACE in ui/Avatar.tsx: white on forest). */
  inkBody: '#404040',
  /** Secondary text, placeholders, secondary glyphs (4.5:1 even on inset). */
  inkMuted: '#606060',

  /** Forest: the brand and every action, at full strength only. */
  pine: '#0E6B45',
  pinePressed: '#0A5738',
  /** The one neutral highlight (historical name): press, selection, @you. */
  pineWash: 'rgba(24,24,24,0.05)',
  /** The same highlight; a historical alias, so add no new uses. */
  pineWashFaint: 'rgba(24,24,24,0.05)',
  /** The forest outline: selection, outlined actions, brand strokes. */
  pineLine: '#0E6B45',

  /** Dividers, seams, card and chip borders, the incoming bubble's edge. */
  lineSoft: 'rgba(24,24,24,0.16)',
  /** Drawer borders, the pressed bubble border, a photo avatar's ring. */
  lineStrong: 'rgba(24,24,24,0.30)',
  /** Text-field and composer-pill rest border (3:1 on white). */
  lineField: 'rgba(24,24,24,0.55)',

  danger: '#A82E24',
  /** The same neutral highlight, on a pressed destructive control. */
  dangerWash: 'rgba(24,24,24,0.05)',
  /**
   * Pending and attention states (connecting, unchecked safety number) in the
   * slate of a security thread — attention without alarm, and never brown.
   * Mark is a non-text status marker only; ink is its text partner.
   */
  warningMark: '#5A7A94',
  warningInk: '#41586B',
  /** Delivered tick off the bubble (jumbo, photo rows); read is pine. */
  tickMuted: '#8C8C8C',

  /** Text and glyphs on a pine or danger fill. */
  onPine: '#FFFFFF',

  /**
   * Message bubbles, as their own axis, with one mapping in both modes: your
   * words are the forest slab with white words. Inside an outgoing bubble
   * onBubbleOut carries the words and the read tick, onBubbleOutMuted the
   * secondary lines and onBubbleOutTick the sent and delivered ticks, both
   * pure gray. Off the bubble (jumbo emoji, photo rows) the delivered tick
   * is tickMuted, apart from the pine read tick by luminance, not hue.
   */
  bubbleOut: '#0E6B45',
  bubbleOutPressed: '#0A5738',
  onBubbleOut: '#FFFFFF',
  /** Secondary lines, edited mark and quote text in an outgoing bubble. */
  onBubbleOutMuted: '#DCDCDC',
  /** Sent and delivered ticks in an outgoing bubble; read is onBubbleOut. */
  onBubbleOutTick: '#B6B6B6',
  bubbleOutLine: '#0E6B45',
  bubbleOutLinePressed: '#0A5738',

  /**
   * Media: neutral and mode-invariant, for the surfaces that carry or await
   * video (the photo viewer, a video call, the minimized video window),
   * because video is dark. A voice call is an app screen and uses this
   * palette. This is not a dark mode.
   */
  mediaBlack: '#000000',
  mediaInk: '#FFFFFF',
  mediaInkMuted: '#A3A3A3',
  mediaLine: 'rgba(255,255,255,0.18)',
  /** Call controls over live video, including an entirely white frame. */
  mediaHud: 'rgba(0,0,0,0.88)',
  dangerOnMedia: '#F5725E',
  /** No-photo backdrop and pre-connect ground inside a video surface. */
  mediaWash: 'rgba(255,255,255,0.10)',
  /** The answer disc on every call surface, under a mediaInk label. */
  mediaAccent: '#0E6B45',
  /** End-call and decline discs on every call surface, mediaInk glyph. */
  mediaDanger: '#A82E24',
} as const;

/** Both palettes carry exactly the same token names. */
type ColorTokens = Record<keyof typeof color, string>;

/**
 * Charcoal: the dark option. A neutral ladder, raised is lighter and the
 * pressed fill is the furthest from the page; forest lifted only as far as
 * text contrast needs, found by a contrast search; every resting text
 * pairing holds 4.5:1.
 */
const darkColor: ColorTokens = {
  paperGround: '#141414',
  paperLayer: '#1C1C1C',
  paperInset: '#2E2E2E',
  paperSheet: '#232323',

  inkStrong: '#EDEDED',
  inkBody: '#C3C3C3',
  inkMuted: '#9A9A9A',

  pine: '#57AA7F',
  pinePressed: '#72B892',
  pineWash: 'rgba(237,237,237,0.06)',
  pineWashFaint: 'rgba(237,237,237,0.06)',
  pineLine: 'rgba(87,170,127,0.65)',

  lineSoft: 'rgba(237,237,237,0.13)',
  lineStrong: 'rgba(237,237,237,0.28)',
  lineField: 'rgba(237,237,237,0.45)',

  danger: '#F5725E',
  dangerWash: 'rgba(237,237,237,0.06)',
  warningMark: '#6E89A3',
  warningInk: '#93ACC2',
  tickMuted: '#6B6B6B',

  /** A charcoal label on the lifted forest fill: here the fill is bright. */
  onPine: '#141414',

  /** Your words: the same forest slab with white words as in light. */
  bubbleOut: '#0E6B45',
  bubbleOutPressed: '#0A5738',
  onBubbleOut: '#FFFFFF',
  onBubbleOutMuted: '#DCDCDC',
  onBubbleOutTick: '#B6B6B6',
  bubbleOutLine: '#0E6B45',
  bubbleOutLinePressed: '#0A5738',
  /** Media is mode-invariant: the same values as light. */
  mediaBlack: '#000000',
  mediaInk: '#FFFFFF',
  mediaInkMuted: '#A3A3A3',
  mediaLine: 'rgba(255,255,255,0.18)',
  mediaHud: 'rgba(0,0,0,0.88)',
  dangerOnMedia: '#F5725E',
  mediaWash: 'rgba(255,255,255,0.10)',
  mediaAccent: '#0E6B45',
  mediaDanger: '#A82E24',
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
