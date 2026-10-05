import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import {
  AddPersonGlyph,
  EndCallGlyph,
  FlipCameraGlyph,
  MicGlyph,
  MicMutedGlyph,
  SpeakerGlyph,
} from '../ui/CallControlGlyphs';
import { PhoneGlyph, VideoGlyph } from '../ui/CallGlyph';
import { useTheme, type Theme } from '../theme';
import {
  measuredCallQuality,
  type CallQualityStatus,
} from '../call/quality';

/**
 * The in-call control bar's parts, shared by the 1:1 screen and the
 * small-group one ("extracted from `CallScreen.tsx` into
 * `app/src/components/CallControls.tsx` and reused, not copied").
 *
 * MOVED, NOT REWRITTEN. Both components arrived here byte-for-byte from
 * `CallScreen.tsx`, down to the `theme` prop that could have become a
 * `useTheme()` call inside them: the extraction's whole warrant is that the
 * 1:1 screen's rendered tree does not change, and a component that reads the
 * theme itself is a different component even when it looks the same. The two
 * screens must also mean the SAME thing by a muted button — a group call's
 * mute glyph that drifts from the 1:1 one teaches two things about one
 * microphone.
 *
 * Both take `onMedia` since the white palette (2026-10-04): a call that
 * carries video draws them on media, a voice call on the app's own ground,
 * and `callSurface` below is where each colour comes from. It defaults to
 * media, so a call site that never passes it draws exactly what it drew.
 */

/**
 * The colours of one call surface, by role, so no call screen picks inks by
 * hand.
 *
 * A surface that carries or awaits video sits on MEDIA: black, white ink and
 * neutral gray, identical in both appearances, because video is dark. Every
 * VOICE call (every group call, a 1:1 audio call, the incoming-call screen)
 * is an app screen on the app's own ground: white in light and charcoal in
 * dark, with charcoal type and gray control rings, as the minimized audio
 * pill already was. The answer and end discs are the same forest and red on
 * both, under a white glyph, so a call action looks the same wherever it
 * appears.
 */
export interface CallSurface {
  /** The screen's ground. */
  ground: string;
  /** Behind the header and the control band. */
  band: string;
  /** Names, titles, a control failure, the switch-to-voice label. */
  ink: string;
  /** Status, duration, notices, the cap line, the quality label. */
  inkMuted: string;
  /** Failure text. */
  failure: string;
  /** Pill outlines, a call tile's edge, the unlit quality bars. */
  line: string;
  /** A participant tile. */
  tile: string;
  /** A control at rest: its disc, its ring and its glyph. */
  idleDisc: string;
  idleRing: string;
  idleGlyph: string;
  /** A control that is ON (muted, speaker on): a filled disc. */
  activeDisc: string;
  activeGlyph: string;
  /** A control that cannot act: an empty disc inside its ring. */
  disabledRing: string;
  disabledGlyph: string;
  /** End and decline. */
  endDisc: string;
  /** Answer. */
  answerDisc: string;
  /** The glyph or label on an end, decline or answer disc. */
  actionGlyph: string;
  minimizeGlyph: string;
  minimizePressed: string;
  /** The status bar's glyphs, and its fill where the platform paints one. */
  barStyle: 'light-content' | 'dark-content';
  barBackground: string;
}

export function callSurface(theme: Theme, onMedia: boolean): CallSurface {
  const c = theme.color;
  const shared = {
    endDisc: c.mediaDanger,
    answerDisc: c.mediaAccent,
    actionGlyph: c.mediaInk,
  };
  if (onMedia) {
    return {
      ...shared,
      ground: c.mediaBlack,
      band: c.mediaHud,
      ink: c.mediaInk,
      inkMuted: c.mediaInkMuted,
      failure: c.dangerOnMedia,
      line: c.mediaLine,
      tile: c.mediaBlack,
      idleDisc: c.mediaLine,
      // No ring at rest on media: the translucent disc is its own edge.
      idleRing: 'transparent',
      idleGlyph: c.mediaInk,
      activeDisc: c.mediaInk,
      activeGlyph: c.mediaBlack,
      disabledRing: c.mediaLine,
      disabledGlyph: c.mediaInkMuted,
      minimizeGlyph: c.mediaInk,
      minimizePressed: c.mediaLine,
      barStyle: 'light-content',
      barBackground: c.mediaBlack,
    };
  }
  return {
    ...shared,
    ground: c.paperGround,
    band: 'transparent',
    ink: c.inkStrong,
    inkMuted: c.inkMuted,
    failure: c.danger,
    line: c.lineSoft,
    tile: c.paperSheet,
    idleDisc: c.paperSheet,
    idleRing: c.lineStrong,
    idleGlyph: c.inkStrong,
    activeDisc: c.inkStrong,
    activeGlyph: c.paperSheet,
    disabledRing: c.lineSoft,
    disabledGlyph: c.inkMuted,
    minimizeGlyph: c.inkStrong,
    minimizePressed: c.paperInset,
    // The app ground's own rule: dark glyphs on white, light on charcoal.
    barStyle: theme.scheme === 'dark' ? 'light-content' : 'dark-content',
    barBackground: c.paperGround,
  };
}

/**
 * How dark a press makes a forest or red call disc: a fifth of black over it,
 * about the step pinePressed takes from pine.
 */
export const PRESS_SHADE = 0.2;

/**
 * A finger on a forest or red disc: black at PRESS_SHADE over the disc and
 * under its glyph, so the press darkens the disc on every ground and in both
 * appearances, the same way the disc itself is the same everywhere. A dip in
 * opacity lets the ground through instead: over media black that darkened,
 * but on the white app ground it turned forest into mint and red into pink
 * under a white label. Render it as the disc's first child.
 */
export function PressShade({
  radius,
  theme,
}: {
  radius: number;
  theme: ReturnType<typeof useTheme>;
}): React.JSX.Element {
  return (
    <View
      testID="call-press-shade"
      pointerEvents="none"
      style={[
        StyleSheet.absoluteFill,
        {
          borderRadius: radius,
          backgroundColor: theme.color.mediaBlack,
          opacity: PRESS_SHADE,
        },
      ]}
    />
  );
}

/**
 * Duration, from the moment media actually flowed.
 *
 * `connectedAt` is null until ICE connects, and "never connected" is a
 * different fact from "a zero-second call" — so a call that rang and
 * failed shows no timer at all rather than 0:00, which would claim it
 * happened. Both screens ask the same question of a different subject: the
 * 1:1 screen of its call, the small-group screen of its session, whose
 * `connectedAt` is the FIRST leg to connect (the one CXCall).
 */
export function durationFrom(
  connectedAt: number | null | undefined,
  now: number,
): string | null {
  if (!connectedAt) return null;
  const total = Math.max(0, Math.floor((now - connectedAt) / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  const hours = Math.floor(minutes / 60);
  const mm = hours > 0 ? String(minutes % 60).padStart(2, '0') : String(minutes);
  const ss = String(seconds).padStart(2, '0');
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** VoiceOver announces at MINUTE granularity: a live region that changes every
 * second makes a call unusable with a screen reader. */
export function durationAnnouncementFrom(
  connectedAt: number | null | undefined,
  now: number,
): string {
  if (!connectedAt) return '';
  const minutes = Math.floor((now - connectedAt) / 60000);
  if (minutes < 1) return 'Connected';
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

/** Three bars from LOCAL stats only. The underlying report contains candidate
 * addresses — the other person's IP — and must never leave the device,
 * so only this integer ever reaches the UI. */
export function QualityBars({
  level,
  status = measuredCallQuality(level) === null ? 'checking' : 'measured',
  theme,
  onMedia = true,
}: {
  level: number;
  status?: CallQualityStatus;
  theme: ReturnType<typeof useTheme>;
  /** False on a voice call, which is an app screen (see `callSurface`). */
  onMedia?: boolean;
}): React.JSX.Element {
  const surface = callSurface(theme, onMedia);
  const measured = measuredCallQuality(level);
  if (status !== 'measured' || measured === null) {
    const label =
      status === 'checking'
        ? 'Checking connection…'
        : 'Connection quality unavailable';
    return (
      <Text
        style={{ color: surface.inkMuted, fontSize: 13, marginTop: 6 }}
        accessibilityLiveRegion="polite"
      >
        {label}
      </Text>
    );
  }
  const label =
    measured === 3
      ? 'Connection good'
      : measured === 2
        ? 'Connection fair'
        : 'Connection poor';
  return (
    <View
      style={{ flexDirection: 'row', gap: 3, marginTop: 6 }}
      // `accessible` is what makes the label reachable at all: RN's View
      // defaults it FALSE, so three bars with a label on them were never a
      // stop for VoiceOver and "Connection poor" was very likely never
      // spoken. One element, so the three bars read once.
      accessible
      accessibilityLabel={label}
    >
      {[1, 2, 3].map(bar => (
        <View
          key={bar}
          style={{
            width: 3,
            height: 4 + bar * 3,
            borderRadius: 1,
            backgroundColor: bar <= measured ? surface.ink : surface.line,
          }}
        />
      ))}
    </View>
  );
}

/**
 * The drawn icon each control renders, by name.
 *
 * `glyph` used to be the literal character the button displayed (`M̸`, `♪`,
 * `▣`) and is now the NAME of a drawn icon — the characters were typographic
 * stand-ins that rendered differently in every font, and `M̸` (a combining
 * slash) worst of all. The legacy characters stay in this map as aliases so a
 * call site still carrying one renders the drawn icon it meant rather than
 * the character; an unrecognised string falls back to `Text` exactly as
 * before, so nothing here can turn a button blank.
 *
 * `camera` is `VideoGlyph` and the answer handset is `PhoneGlyph` — the SAME
 * camcorder and handset the rest of the product draws, on purpose: a second
 * camera shape would teach two things about one lens.
 */
const CONTROL_GLYPHS: Record<
  string,
  ((props: { size?: number; color: string }) => React.JSX.Element) | undefined
> = {
  mic: MicGlyph,
  'mic-muted': MicMutedGlyph,
  camera: VideoGlyph,
  'camera-flip': FlipCameraGlyph,
  speaker: SpeakerGlyph,
  'add-person': AddPersonGlyph,
  'end-call': EndCallGlyph,
  phone: PhoneGlyph,
  // Legacy characters, kept as aliases (see above).
  'M': MicGlyph,
  'M̸': MicMutedGlyph,
  '▣': VideoGlyph,
  '⇄': FlipCameraGlyph,
  '♪': SpeakerGlyph,
  '＋': AddPersonGlyph,
  '✕': EndCallGlyph,
  '✓': PhoneGlyph,
};

export function ControlButton({
  label,
  glyph,
  active,
  danger,
  accept,
  disabled,
  busy = false,
  onPress,
  theme,
  onMedia = true,
  testID,
  accessibilityHint,
}: {
  label: string;
  glyph: string;
  active: boolean;
  danger?: boolean;
  /** The answer disc: the one forest disc every call surface answers with.
   * Colour only; `active` still decides what VoiceOver hears. */
  accept?: boolean;
  disabled?: boolean;
  busy?: boolean;
  onPress(): void;
  theme: ReturnType<typeof useTheme>;
  /** False on a voice call, which is an app screen (see `callSurface`). */
  onMedia?: boolean;
  /** Small-group additions. Both are omitted rather than passed as
   * `undefined` below, so the 1:1 screen's props are the props it always
   * had — see the file header on why that matters. */
  testID?: string;
  accessibilityHint?: string;
}): React.JSX.Element {
  const surface = callSurface(theme, onMedia);
  const fill = disabled
    ? 'transparent'
    : danger
      ? surface.endDisc
      : accept
        ? surface.answerDisc
        : active
          ? surface.activeDisc
          : surface.idleDisc;
  // On media a control at rest has no ring (its translucent disc is its
  // edge), so only a disabled one draws one there, exactly as before. On
  // the app ground every disc carries the same 1pt ring: gray at rest, its
  // own fill when filled, so a toggle changes colour and never moves the row
  // by a point.
  const ring = disabled
    ? surface.disabledRing
    : onMedia
      ? null
      : danger || accept || active
        ? fill
        : surface.idleRing;
  // On the app ground a finger on the forest or red disc darkens it (the
  // shade); the opacity dip would let the white page through and tint it.
  // On media the dip already darkens toward the black ground, so it stays.
  const shaded = !onMedia && !disabled && (danger === true || accept === true);
  // The drawn icon, in the exact colour the Text used: the surface's ink on
  // a disc at rest, the disc's opposite on a filled (active) one, white on
  // the end and answer discs. The icons hide themselves from VoiceOver, so
  // the button still reads once, by its label. Muted on a disabled disc, the
  // other half of the recession below.
  const ink = disabled
    ? surface.disabledGlyph
    : danger || accept
      ? surface.actionGlyph
      : active
        ? surface.activeGlyph
        : surface.idleGlyph;
  const Icon = CONTROL_GLYPHS[glyph];
  const icon = Icon ? (
    <Icon size={22} color={ink} />
  ) : (
    <Text
      style={{ color: ink, fontSize: 18 }}
      // The glyph is decoration; the button already has a proper label, and
      // reading "✕" aloud helps nobody.
      accessibilityElementsHidden
      importantForAccessibility="no"
    >
      {glyph}
    </Text>
  );
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      // `selected` is what tells VoiceOver that mute is currently ON — without
      // it the button reads identically in both states.
      accessibilityState={{
        selected: active,
        disabled: disabled === true,
        ...(busy ? { busy: true } : {}),
      }}
      {...(accessibilityHint ? { accessibilityHint } : {})}
      {...(testID ? { testID } : {})}
      // 44×44 regardless of Dynamic Type; the glyph may grow, the target may not.
      //
      // DISABLED IS A RECESSED SURFACE, NEVER OPACITY (see
      // primitives.tsx:173). The disabled arm used to be `opacity: 0.4`,
      // which took the glyph under the contrast floor; it now empties the
      // disc to its ring and mutes the icon. `pressed` keeps its
      // dip — a finger on a control is feedback, not a state — except on a
      // forest or red disc on the app ground, which takes the shade.
      style={({ pressed }) => [
        {
          minWidth: 44,
          minHeight: 44,
          paddingHorizontal: 14,
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: 22,
          opacity: pressed && !shaded ? 0.7 : 1,
          ...(ring !== null ? { borderWidth: 1, borderColor: ring } : null),
          backgroundColor: fill,
        },
      ]}
    >
      {({ pressed }) => (
        <>
          {pressed && shaded ? <PressShade radius={22} theme={theme} /> : null}
          {icon}
        </>
      )}
    </Pressable>
  );
}
