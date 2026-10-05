import React from 'react';
import { StyleSheet, View } from 'react-native';
import Svg, { Circle, Path, Rect, Text as SvgText } from 'react-native-svg';
import { DEVICE_NOUN } from '../deviceNoun';
import { useTheme, type Theme } from '../theme';

/**
 * The register screen's static drawings (identity-redesign mockup): the three
 * fact glyphs, the confirm sheet's two tile glyphs, and the three "How this
 * works" diagrams. Every coordinate is verbatim from the mockup's SVGs;
 * every color is an app token.
 *
 * Key grammar, echoing the brand mark's outlined/solid bars: solid = private,
 * it stays · outlined = public, it travels · dashed = gone, and a gone key is
 * drawn in gray, at full opacity, never as faded forest. The split-key
 * glyph joins a solid private half to an outlined public bit over a short
 * dotted travel line — and it keeps its key-tooth, and the
 * travel line NEVER animates. Nothing in this file animates at all.
 */

/** Menlo captions inside the diagrams. Display copy only — the real QR
 * payload stays a bare ULID; "K3TQ7…" is a drawing of one, never a value. */
const DIAGRAM_COPY = {
  oneTimeNumber: 'ONE-TIME NUMBER',
  signedWithKey: 'SIGNED WITH YOUR KEY',
  ourServer: 'OUR SERVER',
  // The device caption speaks the
  // platform's language via the token. The key name stays `thisIphone` — it
  // names the diagram slot, not the wording.
  thisIphone: `THIS ${DEVICE_NOUN.toUpperCase()}`,
  qrCode: 'QR CODE',
  or: 'OR',
  idSample: 'K3TQ7…',
  written: '26 WRITTEN CHARACTERS',
  goneWithIt: 'GONE WITH IT',
  freshIdentity: 'A FRESH IDENTITY',
} as const;

/** Caption type inside the SVGs: the utilityLabel voice at diagram scale. */
function caption(t: Theme) {
  return {
    fontFamily: t.mono,
    fontSize: 8,
    letterSpacing: 1,
    fill: t.color.inkMuted,
  } as const;
}

/* ---------------------------------------------------------------- glyphs */

/** Fact 1: a whole key — made here. 22×22. */
export function KeyGlyph() {
  const t = useTheme();
  return (
    <Svg width={22} height={22} viewBox="0 0 22 22">
      <Circle
        cx={6.5}
        cy={11}
        r={4}
        fill="none"
        stroke={t.color.pine}
        strokeWidth={2}
      />
      <Path
        d="M10.5 11 L19 11"
        stroke={t.color.pine}
        strokeWidth={2}
        strokeLinecap="round"
      />
      <Path
        d="M14.5 11 L14.5 14.5"
        stroke={t.color.pine}
        strokeWidth={2}
        strokeLinecap="round"
      />
      <Path
        d="M18 11 L18 14"
        stroke={t.color.pine}
        strokeWidth={2}
        strokeLinecap="round"
      />
    </Svg>
  );
}

/** Fact 2: a keyboard, struck through — nothing to type. 22×22. */
export function NoTypingGlyph() {
  const t = useTheme();
  return (
    <Svg width={22} height={22} viewBox="0 0 22 22">
      <Rect
        x={2}
        y={7}
        width={18}
        height={9}
        rx={2.5}
        fill="none"
        stroke={t.color.pine}
        strokeWidth={2}
      />
      <Circle cx={6.5} cy={11.5} r={1.1} fill={t.color.pine} />
      <Circle cx={11} cy={11.5} r={1.1} fill={t.color.pine} />
      <Circle cx={15.5} cy={11.5} r={1.1} fill={t.color.pine} />
      <Path
        d="M4 19 L18 3.5"
        stroke={t.color.pine}
        strokeWidth={2}
        strokeLinecap="round"
      />
    </Svg>
  );
}

/** Fact 3 and sheet row 2: solid private half · dotted travel line · outlined
 * public bit. 22×22. */
export function SplitKeyGlyph() {
  const t = useTheme();
  return (
    <Svg width={22} height={22} viewBox="0 0 22 22">
      <Circle cx={4.4} cy={10.5} r={3.2} fill={t.color.pine} />
      <Path
        d="M7.6 10.5 L10.2 10.5"
        stroke={t.color.pine}
        strokeWidth={2.2}
        strokeLinecap="round"
      />
      <Path
        d="M9.3 10.5 L9.3 13.4"
        stroke={t.color.pine}
        strokeWidth={2.2}
        strokeLinecap="round"
      />
      <Circle cx={12.5} cy={10.5} r={0.7} fill={t.color.pine} />
      <Circle cx={14.1} cy={10.5} r={0.7} fill={t.color.pine} />
      <Path
        d="M15.7 9.4 L21.2 9.4 L21.2 11.6 L19.8 11.6 L19.8 14.5 L17.8 14.5 L17.8 11.6 L15.7 11.6 Z"
        fill="none"
        stroke={t.color.pine}
        strokeWidth={1.2}
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/** Sheet row 1: the phone gone dashed (dashed = gone), its key gone gray
 * with it. 22×22. */
export function DashedPhoneGlyph() {
  const t = useTheme();
  return (
    <Svg width={22} height={22} viewBox="0 0 22 22">
      <Rect
        x={6}
        y={2.5}
        width={10}
        height={17}
        rx={2.5}
        fill="none"
        stroke={t.color.pine}
        strokeWidth={1.8}
        strokeDasharray="3 2.2"
      />
      <Circle
        cx={11}
        cy={8.5}
        r={1.8}
        fill="none"
        stroke={t.color.inkMuted}
        strokeWidth={1.6}
      />
      <Path
        d="M11 10.3 L11 14"
        stroke={t.color.inkMuted}
        strokeWidth={1.6}
        strokeLinecap="round"
      />
      <Path
        d="M11 12.7 L12.8 12.7"
        stroke={t.color.inkMuted}
        strokeWidth={1.6}
        strokeLinecap="round"
      />
    </Svg>
  );
}

/* -------------------------------------------------------------- diagrams */

const DIAGRAM_W = 294;
const DIAGRAM_H = 80;

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <View
      style={styles.frame}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Svg
        style={StyleSheet.absoluteFill}
        viewBox={`0 0 ${DIAGRAM_W} ${DIAGRAM_H}`}
      >
        {children}
      </Svg>
    </View>
  );
}

/** THE KEY: the server sends a one-time number, this device signs it. */
export function KeyFlowDiagram() {
  const t = useTheme();
  const cap = caption(t);
  return (
    <Frame>
      <Rect
        x={10}
        y={16}
        width={40}
        height={10}
        rx={2.5}
        fill={t.color.paperSheet}
        stroke={t.color.lineStrong}
        strokeWidth={1.3}
      />
      <Rect
        x={10}
        y={29}
        width={40}
        height={10}
        rx={2.5}
        fill={t.color.paperSheet}
        stroke={t.color.lineStrong}
        strokeWidth={1.3}
      />
      <Rect
        x={10}
        y={42}
        width={40}
        height={10}
        rx={2.5}
        fill={t.color.paperSheet}
        stroke={t.color.lineStrong}
        strokeWidth={1.3}
      />
      <Circle cx={44} cy={21} r={1.6} fill={t.color.pine} />
      <Circle cx={44} cy={34} r={1.6} fill={t.color.pine} />
      <Circle cx={44} cy={47} r={1.6} fill={t.color.pine} />
      <Rect
        x={246}
        y={10}
        width={32}
        height={54}
        rx={7}
        fill={t.color.paperSheet}
        stroke={t.color.pine}
        strokeWidth={2}
      />
      <Circle
        cx={262}
        cy={28}
        r={4}
        fill="none"
        stroke={t.color.pine}
        strokeWidth={2.2}
      />
      <Path
        d="M262 32 L262 46"
        stroke={t.color.pine}
        strokeWidth={2.2}
        strokeLinecap="round"
      />
      <Path
        d="M262 42 L268 42"
        stroke={t.color.pine}
        strokeWidth={2.2}
        strokeLinecap="round"
      />
      <Path d="M60 26 L238 26" stroke={t.color.inkMuted} strokeWidth={1.5} />
      <Path
        d="M232 21 L240 26 L232 31"
        fill="none"
        stroke={t.color.inkMuted}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Path d="M238 50 L60 50" stroke={t.color.inkMuted} strokeWidth={1.5} />
      <Path
        d="M66 45 L58 50 L66 55"
        fill="none"
        stroke={t.color.inkMuted}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <SvgText x={149} y={16} textAnchor="middle" {...cap}>
        {DIAGRAM_COPY.oneTimeNumber}
      </SvgText>
      <SvgText x={149} y={64} textAnchor="middle" {...cap}>
        {DIAGRAM_COPY.signedWithKey}
      </SvgText>
      <SvgText x={10} y={76} {...cap}>
        {DIAGRAM_COPY.ourServer}
      </SvgText>
      <SvgText x={278} y={76} textAnchor="end" {...cap}>
        {DIAGRAM_COPY.thisIphone}
      </SvgText>
    </Frame>
  );
}

/** REACHING YOU: a QR code, or 26 written characters — nothing else. */
export function ReachingYouDiagram() {
  const t = useTheme();
  const cap = caption(t);
  return (
    <Frame>
      <Rect
        x={12}
        y={10}
        width={44}
        height={44}
        rx={4}
        fill={t.color.paperSheet}
        stroke={t.color.lineStrong}
        strokeWidth={1.3}
      />
      <Rect x={17} y={15} width={9} height={9} fill="none" stroke={t.color.pine} strokeWidth={1.8} />
      <Rect x={20} y={18} width={3} height={3} fill={t.color.pine} />
      <Rect x={42} y={15} width={9} height={9} fill="none" stroke={t.color.pine} strokeWidth={1.8} />
      <Rect x={45} y={18} width={3} height={3} fill={t.color.pine} />
      <Rect x={17} y={40} width={9} height={9} fill="none" stroke={t.color.pine} strokeWidth={1.8} />
      <Rect x={20} y={43} width={3} height={3} fill={t.color.pine} />
      <Circle cx={33} cy={20} r={1.4} fill={t.color.pine} />
      <Circle cx={37} cy={28} r={1.4} fill={t.color.pine} />
      <Circle cx={31} cy={34} r={1.4} fill={t.color.pine} />
      <Circle cx={43} cy={32} r={1.4} fill={t.color.pine} />
      <Circle cx={47} cy={42} r={1.4} fill={t.color.pine} />
      <Circle cx={35} cy={44} r={1.4} fill={t.color.pine} />
      <Circle cx={42} cy={48} r={1.4} fill={t.color.pine} />
      <SvgText x={12} y={72} {...cap}>
        {DIAGRAM_COPY.qrCode}
      </SvgText>
      <SvgText x={86} y={36} {...cap}>
        {DIAGRAM_COPY.or}
      </SvgText>
      <SvgText
        x={112}
        y={38}
        fontFamily={t.mono}
        fontSize={15}
        fontWeight="700"
        letterSpacing={2}
        fill={t.color.inkBody}
      >
        {DIAGRAM_COPY.idSample}
      </SvgText>
      <SvgText x={112} y={54} {...cap}>
        {DIAGRAM_COPY.written}
      </SvgText>
    </Frame>
  );
}

/** IF THIS DEVICE IS LOST: the old key gone dashed, a fresh one solid. */
export function IfLostDiagram() {
  const t = useTheme();
  const cap = caption(t);
  return (
    <Frame>
      <Circle
        cx={46}
        cy={26}
        r={8}
        fill="none"
        stroke={t.color.inkMuted}
        strokeWidth={2.5}
        strokeDasharray="3 3"
      />
      <Path
        d="M46 34 L46 56"
        stroke={t.color.inkMuted}
        strokeWidth={2.5}
        strokeLinecap="round"
        strokeDasharray="3 3"
      />
      <Path
        d="M46 50 L54 50"
        stroke={t.color.inkMuted}
        strokeWidth={2.5}
        strokeLinecap="round"
        strokeDasharray="3 3"
      />
      <Path d="M84 40 L156 40" stroke={t.color.inkMuted} strokeWidth={1.5} />
      <Path
        d="M150 35 L158 40 L150 45"
        fill="none"
        stroke={t.color.inkMuted}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Circle
        cx={196}
        cy={26}
        r={8}
        fill="none"
        stroke={t.color.pine}
        strokeWidth={3}
      />
      <Path
        d="M196 34 L196 56"
        stroke={t.color.pine}
        strokeWidth={3}
        strokeLinecap="round"
      />
      <Path
        d="M196 50 L205 50"
        stroke={t.color.pine}
        strokeWidth={3}
        strokeLinecap="round"
      />
      <SvgText x={46} y={74} textAnchor="middle" {...cap}>
        {DIAGRAM_COPY.goneWithIt}
      </SvgText>
      <SvgText x={196} y={74} textAnchor="middle" {...cap}>
        {DIAGRAM_COPY.freshIdentity}
      </SvgText>
    </Frame>
  );
}

const styles = StyleSheet.create({
  frame: {
    width: '100%',
    aspectRatio: DIAGRAM_W / DIAGRAM_H,
    marginTop: 12,
  },
});
