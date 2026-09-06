import React from 'react';
import {
  AccessibilityInfo,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useTheme } from '../theme';

/**
 * Shared passcode entry: a dot row and a 3×4 pad. Codes are
 * 4-10 digits, so the pad carries an explicit submit key instead of
 * auto-submitting at a known length — the lock screen must not disclose how
 * long the code is.
 */

const MAX_CODE_LENGTH = 10;
const KEY_ROWS = [
  ['1', '2', '3'],
  ['4', '5', '6'],
  ['7', '8', '9'],
  ['del', '0', 'submit'],
] as const;

interface Props {
  value: string;
  onChange: (next: string) => void;
  onSubmit: () => void;
  disabled?: boolean;
  /** What the ⏎ key does, for VoiceOver — "Unlock" on the lock screen; a
   * pad that guards another verb (the account delete) names that verb
   * instead. */
  submitLabel?: string;
}

export function PinPad({ value, onChange, onSubmit, disabled, submitLabel }: Props) {
  const t = useTheme();
  const dotCount = Math.max(4, value.length);
  const canSubmit = !disabled && value.length >= 4;

  return (
    <View accessibilityLabel="Passcode keypad">
      <View
        style={[
          styles.dots,
          { gap: t.space.s5, marginBottom: t.space.s8, minHeight: t.space.s6 },
        ]}
        accessibilityLabel={`${value.length} digits entered`}
        accessibilityLiveRegion="polite"
      >
        {Array.from({ length: dotCount }, (_, i) => (
          <View
            key={i}
            style={[
              styles.dot,
              {
                borderRadius: t.radius.circle,
                borderWidth: 1,
                borderColor: t.color.lineStrong,
                backgroundColor:
                  i < value.length ? t.color.inkStrong : 'transparent',
              },
            ]}
          />
        ))}
      </View>
      {KEY_ROWS.map(row => (
        <View
          key={row.join()}
          style={[styles.row, { gap: t.space.s5, marginBottom: t.space.s5 }]}
        >
          {row.map(key => {
            const isDelete = key === 'del';
            const isSubmit = key === 'submit';
            const keyDisabled =
              disabled ||
              (isDelete && value.length === 0) ||
              (isSubmit && !canSubmit);
            return (
              <Pressable
                key={key}
                testID={isDelete ? 'pin-del' : isSubmit ? 'pin-submit' : `pin-key-${key}`}
                accessibilityRole="button"
                accessibilityLabel={
                  isDelete ? 'Delete digit' : isSubmit ? (submitLabel ?? 'Unlock') : key
                }
                accessibilityState={{ disabled: keyDisabled }}
                disabled={keyDisabled}
                onPress={() => {
                  if (isDelete) {
                    onChange(value.slice(0, -1));
                    announceCount(value.length - 1);
                  } else if (isSubmit) {
                    onSubmit();
                  } else if (value.length < MAX_CODE_LENGTH) {
                    onChange(value + key);
                    announceCount(value.length + 1);
                  }
                }}
                style={({ pressed }) => [
                  styles.key,
                  {
                    borderRadius: t.radius.button,
                    backgroundColor: pressed
                      ? t.color.paperInset
                      : isDelete || isSubmit
                        ? 'transparent'
                        : t.color.paperSheet,
                    borderWidth: isDelete || isSubmit ? 0 : t.hairline,
                    borderColor: t.color.lineSoft,
                  },
                ]}
              >
                <Text
                  // A data grid, not prose: past about 1.6x the digits stop
                  // fitting three to a row at all, and this is the screen you
                  // cannot skip. The ULID row in primitives.tsx caps the same
                  // way for the same reason. The box below grows too, so the
                  // glyph has somewhere to go.
                  maxFontSizeMultiplier={1.6}
                  style={[
                    t.type.verificationCode,
                    {
                      color: keyDisabled
                        ? t.color.inkMuted
                        : isSubmit
                          ? t.color.pine
                          : t.color.inkStrong,
                    },
                  ]}
                >
                  {isDelete ? '⌫' : isSubmit ? '⏎' : key}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ))}
    </View>
  );
}

/** iOS has no live regions — VoiceOver reads the tapped key, and this adds
 * the running count the dot row shows sighted users. */
function announceCount(count: number): void {
  if (Platform.OS === 'ios') {
    AccessibilityInfo.announceForAccessibility(
      `${Math.max(0, count)} digits entered`,
    );
  }
}

/**
 * Structure only. Every step is spent from the scale at the call site above
 * (the dot row's 28 and 14 were off it; they are now s8 and s6), and the key
 * box is a floor rather than a size — see the key style for why.
 */
const styles = StyleSheet.create({
  dots: {
    flexDirection: 'row',
    justifyContent: 'center',
  },
  dot: { width: 13, height: 13 },
  row: {
    flexDirection: 'row',
    justifyContent: 'center',
  },
  key: {
    // Three fixed numbers were doing three jobs. The height clipped the glyph
    // at accessibility sizes (~68pt of type in a 60pt box at 3.1x); the width
    // overflowed a 320pt window (3 x 84 + 2 x 12 + gutters); so the box takes
    // a floor and the row divides the width. maxWidth keeps the ceiling the
    // fixed size used to be, so a pad on a wide pane is still a keypad.
    flex: 1,
    maxWidth: 84,
    minHeight: 60,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
