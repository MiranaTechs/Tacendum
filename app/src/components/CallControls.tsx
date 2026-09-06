import React from 'react';
import { Pressable, Text, View } from 'react-native';
import {
  AddPersonGlyph,
  EndCallGlyph,
  FlipCameraGlyph,
  MicGlyph,
  MicMutedGlyph,
  SpeakerGlyph,
} from '../ui/CallControlGlyphs';
import { PhoneGlyph, VideoGlyph } from '../ui/CallGlyph';
import { useTheme } from '../theme';

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
 */

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
  theme,
}: {
  level: number;
  theme: ReturnType<typeof useTheme>;
}): React.JSX.Element {
  const label =
    level >= 3 ? 'Connection good' : level === 2 ? 'Connection fair' : 'Connection poor';
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
            backgroundColor: bar <= level ? theme.color.mediaInk : theme.color.mediaLine,
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
  disabled,
  onPress,
  theme,
  testID,
  accessibilityHint,
}: {
  label: string;
  glyph: string;
  active: boolean;
  danger?: boolean;
  disabled?: boolean;
  onPress(): void;
  theme: ReturnType<typeof useTheme>;
  /** Small-group additions. Both are omitted rather than passed as
   * `undefined` below, so the 1:1 screen's props are the props it always
   * had — see the file header on why that matters. */
  testID?: string;
  accessibilityHint?: string;
}): React.JSX.Element {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      // `selected` is what tells VoiceOver that mute is currently ON — without
      // it the button reads identically in both states.
      accessibilityState={{ selected: active, disabled: disabled === true }}
      {...(accessibilityHint ? { accessibilityHint } : {})}
      {...(testID ? { testID } : {})}
      // 44×44 regardless of Dynamic Type; the glyph may grow, the target may not.
      //
      // DISABLED IS A RECESSED SURFACE, NEVER OPACITY (see
      // primitives.tsx:173). The disabled arm used to be `opacity: 0.4`,
      // which took the glyph under the contrast floor; it now empties the
      // disc to its `mediaLine` edge and mutes the icon. `pressed` keeps its
      // dip — a finger on a control is feedback, not a state.
      style={({ pressed }) => [
        {
          minWidth: 44,
          minHeight: 44,
          paddingHorizontal: 14,
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: 22,
          opacity: pressed ? 0.7 : 1,
          ...(disabled
            ? { borderWidth: 1, borderColor: theme.color.mediaLine }
            : null),
          backgroundColor: disabled
            ? 'transparent'
            : danger
              ? theme.color.danger
              : active
                ? theme.color.mediaInk
                : theme.color.mediaLine,
        },
      ]}
    >
      {(() => {
        // The drawn icon, in the exact colour the Text used: `mediaInk` on
        // the wash and the danger disc, `mediaBlack` on an active (filled)
        // one. The icons hide themselves from VoiceOver, so the button still
        // reads once, by its label.
        // Muted on a disabled disc, the other half of the recession above.
        const ink = disabled
          ? theme.color.mediaInkMuted
          : danger || !active
            ? theme.color.mediaInk
            : theme.color.mediaBlack;
        const Icon = CONTROL_GLYPHS[glyph];
        if (Icon) {
          return <Icon size={22} color={ink} />;
        }
        return (
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
      })()}
    </Pressable>
  );
}
